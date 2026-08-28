---
title: "クエリ 1 本の一生を、型の名前で追いかける"
description: '`conn.query("SELECT ...")` から 1 行が返るまでに、SQL テキストは Cmd → Program → ProgramState → Row と姿を変える。入口の API は 5 つあるが、通る経路は 1 本しかない。この 1 本を先に通しておくと、後続のページがどの区間の話をしているかが分かる。'
group: "エンジンの骨格"
sidebar:
  order: 4
---

## この層の責務

このページは層の説明ではなく、**層をまたぐ 1 本の経路**の説明だ。以降のページはこの経路のどこかを拡大したものになる。

`conn.query("SELECT * FROM t WHERE id = 1")` を呼んでから 1 行が返るまでに、データは 5 回姿を変える。

| 段階             | 型                   | どこで作られるか       |
| ---------------- | -------------------- | ---------------------- |
| SQL テキスト     | `&str`               | 呼び出し元             |
| 構文木           | `ast::Cmd`           | `Dialect::parse`       |
| バイトコード     | `vdbe::Program`      | `translate::translate` |
| 実行中の可変状態 | `vdbe::ProgramState` | `Statement::new`       |
| 1 行             | `Row`                | `Program::step`        |

そして重要なのは、**この経路を進めるスレッドが呼び出し元のスレッドである**ことだ。`step()` を呼ぶと、そのスレッドが B-tree を歩いてページを読む。誰にも仕事を投げない。

## 主要な型とその関係

### `Statement` は「Program + ProgramState + Pager」を束ねたもの

```rust title="core/statement.rs:292 (抜粋)"
pub struct Statement {
    pub(crate) program: vdbe::Program,
    state: vdbe::ProgramState,
    pager: Arc<Pager>,
    query_mode: QueryMode,
    busy: bool,
    busy_handler_state: Option<BusyHandlerState>,
    // ...
}
```

3 つの主フィールドの性質がそれぞれ違う。

- `program` — コンパイル結果。実行中に**書き換わらない**
- `state` — レジスタとカーソルの実体。実行中に**書き換わり続ける**
- `pager` — 下の層への参照。`Arc` で共有

この分割が、`reset()` して同じ `Statement` をもう一度実行できる理由になっている。詳しくは [`Program` と `ProgramState` のページ](../program-and-state/)。

残りのフィールドはほとんどが**呼び出し規約のための帳簿**だ。`busy_handler_state` は「何回リトライしたか」、`counted_as_active_root` は「この文を接続の実行中カウンタに足したか」、`nested_guard_active` は「ネストガードを外す責任があるか」。

### `QueryMode` が `ProgramState` の大きさを変える

`Statement::new_with_origin` の冒頭が面白い。

```rust title="core/statement.rs:382-390"
let (max_registers, cursor_count) = match query_mode {
    QueryMode::Normal => (program.max_registers, program.cursor_ref.len()),
    QueryMode::Explain => (EXPLAIN_COLUMNS.len(), 0),
    QueryMode::ExplainQueryPlan { format: EqpFormat::Text } => (EXPLAIN_QUERY_PLAN_COLUMNS.len(), 0),
    QueryMode::ExplainQueryPlan { format: EqpFormat::Json } => (EXPLAIN_QUERY_PLAN_JSON_COLUMNS.len(), 0),
};
let state = vdbe::ProgramState::new(max_registers, cursor_count);
```

`EXPLAIN` は**プログラムを実行しない**。コンパイル済みの `Program` を、命令列という表として出力するだけだ。だからカーソルは 0 個で、レジスタは出力列の分しか要らない。

`EXPLAIN` の出力を SQLite と突き合わせるという開発手法 ([該当ページ](../vdbe/)) が成り立つのは、コンパイルと実行がここで完全に分かれているからだ。

## 処理の流れ (コードを追う)

### 入口は 5 つあるが、経路は 1 本

`Connection` には SQL を受け取る public API が 5 つある。

| API                          | 返すもの                                     | 複文             | 用途                     |
| ---------------------------- | -------------------------------------------- | ---------------- | ------------------------ |
| `prepare(sql)`               | `Statement`                                  | 最初の 1 文のみ  | プリペアドステートメント |
| `query(sql)`                 | `Option<Statement>`                          | 最初の 1 文のみ  | 1 回きりのクエリ         |
| `execute(sql)`               | `()`                                         | **全部実行**     | 行を捨てる DDL/DML       |
| `prepare_execute_batch(sql)` | `()`                                         | **全部実行**     | 同上                     |
| `query_runner(sql)`          | `Iterator<Item = Result<Option<Statement>>>` | **1 文ずつ返す** | CLI など                 |

どれも中身は同じ 2 手だ。

```rust title="core/connection.rs:1754-1759 query (抜粋)"
let (cmd, byte_offset_end) = self.parse_sql(sql)?;
let input = str::from_utf8(&sql.as_bytes()[..byte_offset_end]).unwrap().trim();
match cmd {
    Some(cmd) => self.run_cmd(cmd, input),
    None => Ok(None),
}
```

`parse_sql` が `(Option<Cmd>, usize)` を返すのがこの API 群の設計の核だ。**1 文だけパースして、その文がどのバイトで終わったかを返す。** 複文を扱う `execute` は、この `byte_offset_end` でスライスを切り詰めながら回る。

```rust title="core/connection.rs:1793-1806 execute (抜粋)"
let mut remaining = sql;
while let (Some(cmd), byte_offset_end) = self.parse_sql(remaining)? {
    let input = str::from_utf8(&remaining.as_bytes()[..byte_offset_end]).unwrap().trim();
    let (program, pager, mode) = self.compile_cmd(cmd, input, StatementOrigin::Root, &prepare_options)?;
    Statement::new(program, pager.clone(), mode, 0).run_ignore_rows()?;
    remaining = &remaining[byte_offset_end..];
}
```

**パースと実行が交互に来る**点に注意したい。3 文目をパースするのは 2 文目を実行し終えた後だ。だから `CREATE TABLE t(...); INSERT INTO t ...;` が動く。1 文目が作ったテーブルを、2 文目のコンパイル時には見られる。全部先にパースしていたら、この順序依存を扱えない。

`QueryRunner` も同じ構造を `Iterator` に畳んだだけだ。

```rust title="core/lib.rs:275-293 (抜粋)"
fn next(&mut self) -> Option<Self::Item> {
    // ...
    let remaining = &self.statements[self.last_offset..];
    match self.conn.parse_sql(remaining) {
        Ok((Some(cmd), byte_offset_end)) => {
            let input = remaining[..byte_offset_end].trim();
            self.last_offset += byte_offset_end;
            Some(self.conn.run_cmd(cmd, input))
        }
        Ok((None, _)) => None,
        // ...
    }
}
```

### `parse_sql` は方言に委譲する

```rust title="core/connection.rs:1829"
pub(crate) fn parse_sql(&self, sql: &str) -> Result<(Option<Cmd>, usize)> {
    self.db.dialect().parse(sql)
```

エンジン本体はパーサを直接呼ばない。`Dialect` trait 越しに呼ぶ。だから Postgres フロントエンドは別のパーサを差せる ([該当ページ](../dialect-trait/))。手書き再帰下降パーサの中身は [パースのページ](../parse-to-ast/) で扱う。

### `compile_cmd` — スキーマを確定させてから翻訳する

```rust title="core/connection.rs:949-971 (抜粋)"
fn compile_cmd(...) -> Result<(Program, Arc<Pager>, QueryMode)> {
    self.maybe_update_schema();

    let syms = self.syms.read();
    let pager = self.pager.load().clone();
    let mode = QueryMode::new(&cmd);
    let (Cmd::Stmt(stmt) | Cmd::Explain(stmt) | Cmd::ExplainQueryPlan { stmt, .. }) = cmd;
    let schema = self.schema.read().clone();
    match translate::translate(&schema, stmt, pager.clone(), self.clone(), &syms, mode, input, origin, prepare_options) {
        Ok(program) => Ok((program, pager, mode)),
        Err(err) if self.should_retry_cross_process_schema_lookup(&err)? => { /* 再パースして再挑戦 */ }
        Err(err) => Err(err),
    }
}
```

3 つのことが起きている。

**`maybe_update_schema()` が最初。** 他の接続やプロセスがスキーマを変えていたら、ここで取り込む。詳細は [スキーマ解決のページ](../schema-resolution/)。

**`Cmd` の 3 バリアントを 1 つの `stmt` に潰している。** `Cmd::Stmt` も `Cmd::Explain` も `Cmd::ExplainQueryPlan` も、**コンパイルは同じ**だ。違いは `QueryMode` として横に持ち回され、`Statement` の側で「実行するか、命令列を印字するか」を切り替える。

**スキーマ不一致のリトライがある。** 別プロセスが `CREATE TABLE` した直後だと、翻訳が「そんなテーブルはない」で落ちる。そのときは AST を捨てて**テキストから再パースする**。コメントに理由がある。

```rust title="core/connection.rs:976-978"
// Cold path: re-parse the SQL from scratch after schema refresh rather
// than cloning the original AST, which can overflow the stack
// on deeply nested expression trees.
```

`ast::Stmt` は `translate` に move で渡されるので、リトライには複製が要る。だが深くネストした式の AST を再帰的に clone するとスタックが溢れる。**再パースの方が安全**という判断だ。パーサ側が深さを 2 つの尺度で止めている ([該当ページ](../recursive-descent/)) のと同じ問題の裏返しになっている。

### `Statement::step()` — 実際の実行の手前にある 5 つの関門

`step()` は `_step()` を呼ぶだけだが、`_step` は `program.step()` に着くまでに 5 つのことをする ([`core/statement.rs:564`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/statement.rs#L564))。

**1. root 文としてカウントする。** 初回の `step()` で `n_active_root_statements` を増やす。チェックポイントが「今この接続で文が走っているか」を知るために要る。

**2. スキーマが変わっていたら再コンパイルする。**

```rust title="core/statement.rs:577-597 (抜粋)"
if matches!(self.state.execution_state, ProgramExecutionState::Init)
    && self.origin != StatementOrigin::InternalHelper
{
    // ...
    if !self.program.prepare_context.matches_connection(&self.program.connection) {
        if let Err(err) = self.reprepare() { /* ... */ }
    }
}
```

条件が `ProgramExecutionState::Init` に限られている点が重要だ。**走り始めた文は途中で作り直さない。** プリペアドステートメントを長く持ち回して、その間に `ALTER TABLE` が走っても、次に `step()` を頭から始めたときに作り直される。

**3. タイムアウトを張る。** `arm_query_timeout_if_needed()`。

**4. busy handler の待ち時間を見る。** まだ待ち時間が残っていれば、実行に入らず `StepResult::Sleep { duration }` を返す。

```rust title="core/statement.rs:600-612 (抜粋)"
if let Some(busy_state) = self.busy_handler_state.as_ref() {
    let now = self.pager.io.current_time_monotonic();
    if now < busy_state.timeout() {
        if let Some(waker) = waker { waker.wake_by_ref(); }
        return Ok(StepResult::Sleep { duration: busy_state.get_delay(now) });
    }
}
```

**スリープを自分でせず、呼び出し元に「これだけ待って」と返す。** サーバがない以上、勝手に眠っていいスレッドがないからだ。

**5. `SchemaUpdated` を最大 50 回までリトライする。**

```rust title="core/statement.rs:614-641 (抜粋)"
const MAX_SCHEMA_RETRY: usize = 50;
let mut res = self.program.step(&mut self.state, &self.pager, self.query_mode, waker);
for attempt in 0..MAX_SCHEMA_RETRY {
    if !matches!(res, Err(LimboError::SchemaUpdated)) { break; }
    if attempt >= 2
        && !self.program.connection.get_auto_commit()
        && matches!(self.program.connection.get_tx_state(),
                    TransactionState::Write { .. } | TransactionState::PendingUpgrade { .. })
    { break; }
    if let Err(err) = self.reprepare() { /* ... */ }
    res = self.program.step(&mut self.state, &self.pager, self.query_mode, waker);
}
```

書き込みトランザクションの中では 3 回目で諦める。コメントによれば、別プロセスのスキーマ変更が原因なら再コンパイルしても解決しないので、50 回無駄に回らないようにしている。

これらを通り抜けて、初めて `Program::step` に入る。

### 呼び出し元がループを回す

`step()` は 1 行返すか、I/O 待ちを告げるかで帰ってくる。ループは呼び出し元の責任だ。最小の例が `run_ignore_rows` にある。

```rust title="core/statement.rs:746-760"
pub fn run_ignore_rows(&mut self) -> Result<()> {
    loop {
        match self.step()? {
            vdbe::StepResult::Done => return Ok(()),
            vdbe::StepResult::IO | vdbe::StepResult::Yield | vdbe::StepResult::Sleep { .. } => {
                self.pager.io.step()?
            }
            vdbe::StepResult::Row => continue,
            vdbe::StepResult::Interrupt | vdbe::StepResult::Busy => return Err(LimboError::Busy),
        }
    }
}
```

**`self.pager.io.step()` が、この設計の要だ。** I/O 待ちになったら、呼び出し元が I/O バックエンドを 1 回進める。io_uring なら完了キューを引き、epoll なら待つ。イベントループを回す主体が、クエリを叩いた本人になっている。

`run_ignore_rows` / `run_collect_rows` / `run_with_row_callback` の 3 つは、`Row` のときに何をするかだけが違う。

## 守られている不変条件

**コンパイルと実行が完全に分離している。** `Program` は `step()` の間に書き換わらない。`EXPLAIN` が同じ `Program` を印字できるのはこのためで、SQLite との命令列突き合わせという開発手法全体がここに依存している。

**走り始めた文は再コンパイルされない。** 再コンパイルは `ProgramExecutionState::Init` のときだけ。中途半端な `ProgramState` に新しい `Program` を当てると、レジスタ番号もカーソル番号も合わなくなる。

**エンジンは自分で眠らない。** 待ちが必要なときは `Sleep { duration }` を返す。実際に眠るかどうかは呼び出し元が決める。

**`byte_offset_end` が複文の唯一の切れ目。** パーサが返したこの値だけを信じてスライスを進める。呼び出し側でセミコロンを探したりはしない。文字列リテラルの中のセミコロンで誤爆しないためだ。

## つまずきどころ / 設計の含み

### `execute()` は I/O を勝手に回す

シグネチャにコメントが付いている。

```rust title="core/connection.rs:1784-1785"
/// Execute will run a query from start to finish taking ownership of I/O because it will run pending I/Os if it didn't finish.
/// TODO: make this api async
```

`execute()` の中では `run_ignore_rows()` が `io.step()` を呼ぶ。**呼び出し元のスレッドが、そのクエリと無関係な I/O 完了まで処理してしまう。** 1 つのスレッドで複数の `Statement` を交互に進めているアプリケーションだと、`execute()` を挟んだ瞬間に他の文の I/O も進む。ふつうは無害だが、決定的にしたいテストでは効いてくる。

同期 I/O ポンプを持たないバックエンド (WASM など) では `io.step()` が使えない。そのために `run_ignore_rows_nonblock` がある。

```rust title="core/statement.rs:807-809 (抜粋)"
/// Used by engine-internal callers that must stay non-blocking (MVCC
/// bootstrap/recovery) so they don't call `io.step()` on backends that have
/// no synchronous IO pump (e.g. WASM).
```

**同じロジックのブロッキング版と非ブロッキング版が両方ある**というのは、このコードベースの至るところで見る形だ。`_init` と `_init_nonblock` もそうだった。

### `Statement` の生存期間が、実は他の機能を止める

`n_active_root_statements` を数えているせいで、**`Statement` を持ったまま放置すると明示的チェックポイントが走らない**。だから incremental blob だけ別枠にしてある。

```rust title="core/connection.rs:510-515 (抜粋)"
/// How many of `n_active_root_statements` are parked incremental blob
/// handles. A blob handle keeps a Root statement open from `blob_open`
/// until close, but between blob operations it just sits on its row, so
/// explicit checkpoints subtract these instead of treating them as
/// statements in progress
```

BLOB ハンドルは `blob_open` から `close` まで文を開きっぱなしにするが、その間は行の上に座っているだけだ。**「開いている」と「進行中」を区別する必要があった**ので、カウンタが 2 本になっている。

### `StatementOrigin` が挙動を 3 通りに分ける

`Root` / `InternalHelper` / (トリガ・FK の) サブプログラム、という区別がある。`_step` の関門のほとんどは `Root` にしか適用されない。トリガの中で走るサブプログラムは `step_subprogram()` を使い、5 つの関門を全部飛ばす。

```rust title="core/statement.rs:737-744"
/// Fast step for trigger/FK subprograms: skips reprepare checks, timeout
/// arming, busy handler, metrics recording, and schema retry.
/// The parent statement handles all of those concerns.
#[inline]
pub fn step_subprogram(&mut self) -> Result<StepResult> {
    self.program
        .step(&mut self.state, &self.pager, self.query_mode, None)
}
```

親文がタイムアウトも busy も面倒を見ているので、子は素通しでよい。**逆に言えば、トリガの中の文には独立したタイムアウトがない。**

### `ANALYZE` だけ特別扱いされている

`step()` が `Done` を返した後に、SQL テキストの先頭 7 バイトを見る箇所がある。

```rust title="core/statement.rs:658-667 (抜粋)"
let sql = self.program.sql.trim_start().as_bytes();
if sql.len() >= 7 && sql[..7].eq_ignore_ascii_case(b"ANALYZE") {
    self.release_active_root_if_counted();
    refresh_analyze_stats(&self.program.connection);
}
```

`Program` の中身ではなく**元の SQL テキストを見て分岐している**。`ANALYZE` が書いた統計を、同じ接続の後続クエリがすぐ使えるようにするための後始末だ。しかも内部で `SELECT` を走らせるので、その前に自分を「実行中の root 文」から外している。

こういう「1 箇所だけ文字列を見る」は、コンパイル済みプログラムから元の意図を復元できないときに出てくる。`Program` は命令列であって、それが `ANALYZE` だったかどうかを覚えていない。
