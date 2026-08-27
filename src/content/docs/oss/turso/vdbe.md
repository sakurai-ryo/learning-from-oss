---
title: "バイトコード VM を捨てず、`EXPLAIN` の命令列を SQLite と突き合わせる"
description: "MySQL の実行器はイテレータのツリーだが、SQLite はバイトコードを 1 命令ずつ回す VM だ。Turso はこれを踏襲した。速いからではなく、EXPLAIN の出力を SQLite と 1 行ずつ比べられるからだ。ただし I/O で途中から帰るという実行モデルのせいで、SQLite では原子的だった 1 命令が「途中で中断して同じ命令から再開する」ものになり、16 種類の命令が専用の中断状態を持つことになった。"
sidebar:
  order: 20
---

## 何を学んだか

MySQL の実行器は、イテレータのツリーだ。`SELECT ... JOIN ... WHERE` は、テーブルスキャンのイテレータの上に結合のイテレータが乗り、その上にフィルタが乗る。行を 1 個要求すると、ツリーを下向きに再帰する。

SQLite は違う。**SQL をバイトコードにコンパイルして、1 命令ずつ実行する仮想機械 (VDBE) を持つ。**

```sql
sqlite> EXPLAIN SELECT x FROM t WHERE x > 5;
addr  opcode         p1    p2    p3    p4             p5
----  -------------  ----  ----  ----  -------------  --
0     Init           0     7     0                    0
1     OpenRead       0     2     0     1              0
2     Rewind         0     6     0                    0
3       Column       0     0     1                    0
...
```

Turso はこの方式をそのまま引き継いだ。

**速度が理由ではない。** イテレータツリーの方が有利な点も多い (分岐予測が効きやすい、ベクトル化しやすい)。理由は [互換性のページ](../sqlite-compat/) で見た開発手法にある。

```text title="docs/agent-guides/debugging.md"
3. Compare bytecode
   ├─ Different → bug in code generation
   └─ Same but results differ → bug in VM or storage layer
```

**バイトコードという中間表現を SQLite と共有していると、バグの所在を機械的に二分できる。** イテレータツリーに変えた瞬間、この参照実装との突き合わせが使えなくなる。

## ソースコードのどこか

### 命令セット

```rust title="core/vdbe/insn.rs"
pub enum Insn {
    /// Initialize the program state and jump to the given PC.
    Init {
        target_pc: BranchOffset,
    },
    /// Write a NULL into register dest. If dest_end is Some, then also write NULL into register dest_end and every register in between dest and dest_end. If dest_end is not set, then only register dest is set to NULL.
    Null {
        dest: usize,
        dest_end: Option<usize>,
    },
    /// Mark the beginning of a subroutine tha can be entered in-line. This opcode is identical to Null
    /// it has a different name only to make the byte code easier to read and verify
    BeginSubrtn {
        dest: usize,
        dest_end: Option<usize>,
    },
```

[`core/vdbe/insn.rs#L388-L403`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/insn.rs#L388-L403)。

**約 200 種類の命令がある。** SQLite の `p1`〜`p5` という汎用の引数枠ではなく、命令ごとに名前付きのフィールドを持つ。

`BeginSubrtn` のコメントが象徴的だ。**「この命令は `Null` と完全に同じ動作をする。名前が違うのは、バイトコードを読みやすく検証しやすくするためだけ」。**

動作が同じ命令をわざわざ分けている。これは SQLite が同じことをしているからで、**命令列を一致させるという目的のためには、意味のない区別も再現する必要がある。**

### レジスタマシン

```rust title="core/vdbe/insn.rs"
    /// Add two registers and store the result in a third register.
    Add {
        lhs: usize,
        rhs: usize,
        dest: usize,
    },
```

[`core/vdbe/insn.rs#L408-L413`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/insn.rs#L408-L413)。

スタックマシンではなくレジスタマシンだ。`ProgramState` がレジスタ配列を持つ。

```rust title="core/vdbe/mod.rs"
pub struct ProgramState {
    pub io_completions: Option<IOCompletions>,
    pub pc: InsnReference,
    pub(crate) cursors: Vec<Option<Cursor>>,
    ...
    registers: Box<[Register]>,
```

[`core/vdbe/mod.rs#L779-L801`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L779-L801)。

**`pc` (プログラムカウンタ)、レジスタ、カーソル。** ここまでは普通のバイトコード VM だ。

問題は 1 行目の `io_completions` になる。

### 命令の「途中」で帰る

SQLite の VDBE では、**1 命令は原子的**だ。`OP_Column` が呼ばれたら、必要ならページを読み (ブロックして)、値をレジスタに置いて、次の命令へ進む。

Turso ではブロックできない ([実行モデルのページ](../io-result/))。だから **命令の途中で呼び出し元に帰り、同じ `pc` から再開する**。

```rust title="core/vdbe/mod.rs"
        // The outer loop runs once per step call and is re-entered only when an
        // instruction completed its IO inline; the inner loop dispatches
        // instructions without re-inspecting the completion slot every time.
        'io_check: loop {
            if let Some(io) = &state.io_completions {
                if !io.finished() {
                    io.set_waker(waker);
                    return Ok(StepResult::IO);
                }
```

[`core/vdbe/mod.rs#L1954-L1962`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L1954-L1962)。

**`step()` の入口で「前回投げた I/O が終わっているか」を見る。** 終わっていなければ、そのまま `StepResult::IO` を返して帰る。`pc` は進んでいないので、次に呼ばれたら同じ命令をもう一度実行する。

二重ループの理由もコメントにある。**内側のループは完了スロットを毎回見ない。** ほとんどの命令は I/O を起こさないので、命令ごとに `Option` を確認するのは無駄になる。

### 命令ごとの中断状態

同じ命令を頭から再実行するので、**その命令が「どこまで進んだか」を覚えておく場所が要る**。[再入のページ](../reentrancy/) と同じ問題が、命令単位でも起きる。

```rust title="core/vdbe/mod.rs"
enum ActiveOpState {
    None,
    ClearBtree(OpClearBtreeState),
    Delete(OpDeleteState),
    Destroy(OpDestroyState),
    IdxDelete(OpIdxDeleteState),
    IntegrityCheck(OpIntegrityCheckState),
    OpenEphemeral(OpOpenEphemeralState),
    Program(OpProgramState),
    NewRowid(OpNewRowidState),
    IdxInsert(OpIdxInsertState),
    Insert(OpInsertState),
    NoConflict(OpNoConflictState),
    Column(OpColumnState),
    RowId(OpRowIdState),
    Transaction(OpTransactionState),
    Attach(OpAttachState),
    JournalMode(OpJournalModeState),
    ParseSchema(OpParseSchemaState),
    HashBuild(Option<OpHashBuildState>),
    HashProbe(Option<OpHashProbeState>),
    InitCdcVersion(OpInitCdcVersionState),
}
```

[`core/vdbe/mod.rs#L529-L551`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L529-L551)。

**200 命令のうち 20 個が、専用の中断状態を持っている。**

顔ぶれを見ると分かりやすい。`Column` (ページを読む)、`Insert` (B-tree を分割しうる)、`Delete`、`Transaction` (ロックを取る)、`HashBuild`/`HashProbe` ([ディスクへ溢れうる](../hash-join-spill/))。**どれもディスクに触る命令だ。**

`Add` や `Null` はここにいない。**メモリ上で完結する命令は、中断しない。**

置き場所が 1 つのスロットなのが要点になる。

```rust title="core/vdbe/mod.rs"
#[derive(Debug, Default)]
struct ActiveOpStateSlot {
    state: ActiveOpState,
}
```

```rust title="core/vdbe/mod.rs"
    /// True when no multi-step opcode is suspended. Hot opcodes use this to
    /// bypass the slot entirely on their non-yielding fast path.
    fn is_idle(&self) -> bool {
        matches!(self.state, ActiveOpState::None)
    }
```

[`core/vdbe/mod.rs#L582-L620`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L582-L620)。

**中断している命令は、常に高々 1 つ。** VM は 1 命令ずつしか実行しないので、複数の命令が同時に中断していることはありえない。

だから「命令ごとに状態を持つ配列」ではなく、**1 個のスロットを使い回す**。列挙のバリアントが排他になり、メモリも 1 個分で済む。

「ありえない状態を表現できない」形になっているのが効いていて、アクセサはこう書かれている。

```rust title="core/vdbe/mod.rs"
macro_rules! active_state_accessor {
    ($name:ident, $variant:ident, $ty:ty, $init:expr) => {
        fn $name(&mut self) -> &mut $ty {
            if matches!(self.state, ActiveOpState::None) {
                self.state = ActiveOpState::$variant($init);
            }
            match &mut self.state {
                ActiveOpState::$variant(state) => state,
                state => unreachable!(
                    "active opcode state mismatch: expected {}, got {:?}",
                    stringify!($variant),
                    state
                ),
            }
        }
    };
}
```

[`core/vdbe/mod.rs#L587-L603`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L587-L603)。

**「空なら自分の状態を作る。自分のものならそれを返す。他人のものなら `unreachable!`」。**

`Insert` 命令の実行中に `Column` の状態が入っていたら、それは実行モデルが壊れている。**沈黙して上書きせず、その場で落ちる。** [「壊すより落ちる」](../architecture/) がここにも出ている。

そして `is_idle()` の速い経路が用意されている。I/O を起こさなかった命令は、このスロットに一切触らない。**中断の仕組みのコストを、中断しない命令が払わない。**

### `EXPLAIN` は別の実行経路

```rust title="core/vdbe/mod.rs"
        let result = match query_mode {
            QueryMode::Normal => self.normal_step(state, pager, waker),
            QueryMode::Explain => self.explain_step(state, pager),
            QueryMode::ExplainQueryPlan {
                format: EqpFormat::Text,
            } => self.explain_query_plan_step(state, pager),
            QueryMode::ExplainQueryPlan {
                format: EqpFormat::Json,
            } => self.explain_query_plan_json_step(state, pager),
        };
```

[`core/vdbe/mod.rs#L1748-L1757`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L1748-L1757)。

**`EXPLAIN` は「命令を実行せずに、命令を行として返す」経路**になっている。命令列そのものが結果セットになるので、通常の実行とは別の `step` が要る。

`EXPLAIN QUERY PLAN` は JSON 形式も持っている。SQLite にはない拡張だが、**命令列そのものではなく計画の要約なので、互換の対象外**という整理になる。

### 中断は I/O 以外でも起きる

```rust title="core/vdbe/mod.rs"
                if self.maybe_request_interrupt(state, pager.io.as_ref()) {
                    self.abort(pager, None, state, true)?;
                    return Ok(StepResult::Interrupt);
                }
```

[`core/vdbe/mod.rs#L1999-L2002`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L1999-L2002)。

**命令の切れ目ごとに、中断要求を見る。** `sqlite3_interrupt()` に相当する機能で、長いクエリを外から止められる。

**バイトコード VM だと、これがほぼ無料で手に入る。** 「命令の切れ目」という自然な中断点が既にあるからだ。イテレータツリーだと、再帰の途中に同じチェックを入れて回ることになる。

エラー処理も同じ場所に寄っている。I/O のエラーは `step` の入口でまとめて拾い、そこから `abort` を呼ぶ。

```rust title="core/vdbe/mod.rs"
                if let Some(err) = io.get_error() {
                    if pager.is_checkpointing() {
                        // Wrap IO errors that occurred during checkpointing in CheckpointFailed error,
                        // so that abort() knows not to try to rollback the transaction, because the transaction
                        // is already durable in the WAL and hence committed.
                        // This also lets the simulator know that it should shadow the results of the query because
                        // the write itself succeeded.
                        let checkpoint_err = LimboError::CheckpointFailed(err.to_string());
```

[`core/vdbe/mod.rs#L1963-L1971`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L1963-L1971)。

**チェックポイント中の I/O エラーだけ、別のエラー型で包む。** 理由が 2 つ書いてある。

1. トランザクションは **既に WAL 上で耐久化されている**ので、ロールバックしてはいけない
2. [シミュレータ](../deterministic-simulator/) に「書き込み自体は成功した」を伝える必要がある

**同じ「I/O が失敗した」でも、いつ失敗したかで正しい後始末が違う。** そして 2 つ目の理由が、テスト基盤の都合であることを隠していない。

## なぜそうなっているか

- **バイトコード VM を維持したのは、参照実装との突き合わせに使えるから。** イテレータツリーに変えると、`EXPLAIN` の出力を SQLite と比べられなくなる。開発中ずっと使う手段を失うのは高い。
- **動作が同じ命令を分けているのは、SQLite が分けているから。** 命令列の一致が目的なので、意味のない区別も再現する。
- **`p1`〜`p5` ではなく名前付きフィールドにしたのは、Rust だからできるから。** ここは互換の対象ではない (バイト列として保存されない) ので、読みやすさを取れる。
- **命令の途中で帰れるようにしたのは、ブロックできないから。** SQLite の VDBE は 1 命令が原子的だが、それはブロッキング I/O を前提にしている。
- **中断状態を持つ命令が 20 個なのは、ディスクに触る命令がそれだけだから。** 算術も比較もジャンプも、メモリ上で完結するので中断しない。
- **状態を 1 つのスロットに集めたのは、同時に中断する命令が 1 個だけだから。** VM は 1 命令ずつ実行する。命令ごとの配列を持つのは無駄になる。
- **他人の状態を見たら `unreachable!` にしているのは、そこで壊れているから。** 上書きして進むと、間違ったカーソルに対して間違った操作をする。
- **`is_idle()` の速い経路があるのは、中断しない命令が大多数だから。** 中断の仕組みのコストを、使わない命令に払わせない。
- **`EXPLAIN` が別経路なのは、命令を実行せずに列挙するから。** 実行経路に「実行しないモード」を混ぜると、条件分岐が全命令に入る。
- **中断要求を命令の切れ目で見るのは、そこが自然な安全点だから。** バイトコード VM の副産物として、キャンセルの実装がほぼ無料になる。

## どう活かすか

- **参照実装があるなら、中間表現を合わせることの価値を計算に入れる。** 実行方式の選択は性能だけで決まらない。「参照実装と 1 行ずつ比べられる」は、開発期間を通して効き続ける資産になる。
- **中断可能にするなら、「どの操作が中断しうるか」を先に数える。** 全部が中断しうると仮定すると、状態の置き場所が爆発する。実際に外部資源に触るものだけに絞る。
- **同時に 1 つしか存在しない状態は、1 つのスロットに集める。** 「命令ごとの状態」を配列で持つと、実際には常に 1 個しか使われない配列ができる。
- **そのスロットは、他人のものを見たら落ちるようにする。** 型が合わないまま進むと、間違った対象に対して正しい操作をしてしまう。
- **中断の仕組みのコストを、中断しない側に払わせない。** 「今中断中か」の判定 1 回で分岐できるようにしておく。
- **エラーの種類を、発生した文脈で分ける。** 同じ「I/O 失敗」でも、コミット前かコミット後かで正しい後始末が真逆になる。
- **テスト基盤の都合でエラー型を分けたなら、それをコメントに書く。** 「シミュレータがこう解釈する必要がある」は、後から見て理由が分からなくなる筆頭だ。
