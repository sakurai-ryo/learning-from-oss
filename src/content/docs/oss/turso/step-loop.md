---
title: "`step()` が返す 6 つの値と、pc を保ったまま帰る作法"
description: "210 個の命令は `match` ではなく、コンパイル時に組み立てた関数ポインタの配列で振り分けられる。ループは二重で、外側が I/O 完了の検査、内側が命令のディスパッチ。命令が I/O を返したら `pc` を進めずに帰り、次の `step()` が同じ命令から再開する。`vm_steps` と `insn_executed` の差が、そのまま「何回中断したか」になる。"
group: "バイトコードの実行"
sidebar:
  order: 13
---

## この層の責務

`Statement::step()` が 5 つの関門を通り抜けた後 ([クエリの一生のページ](../query-lifecycle/))、`Program::step()` に入る。ここからが実際の命令実行だ。

このループが答えるべき問いは 3 つある。

- 210 個ある命令を、どうやって振り分けるか
- I/O 待ちになった命令を、どうやって同じ場所から再開させるか
- 途中で起きた異常 (エラー、割り込み、Busy) を、どう呼び出し元に伝えるか

## 主要な型とその関係

### 2 つの `StepResult` がある

外向きの `StepResult` は 6 値だ。

```rust title="core/vdbe/mod.rs:175-192"
pub enum StepResult {
    Done,
    IO,
    Row,
    Interrupt,
    Busy,
    /// The statement explicitly yielded control back to the caller without any pending I/O.
    /// Stepping again immediately (even in a tight loop) is fine; blocking callers should
    /// still drive the event loop (`io.step()`) between steps so progress that depends on
    /// other threads' I/O is not starved.
    Yield,
    /// The statement asks the caller to wait for `duration` before stepping again,
    /// e.g. because a busy handler decided to retry after a delay. Callers that don't
    /// track time may treat this exactly like `IO`: drive the event loop and step again.
    Sleep {
        duration: std::time::Duration,
    },
}
```

`IO` と `Yield` と `Sleep` の 3 つが「まだ終わっていない」を表す。違いは**呼び出し元が何をすべきか**だ。

| 値                   | 呼び出し元がすること     | エンジン側の状況            |
| -------------------- | ------------------------ | --------------------------- |
| `IO`                 | 完了を待つ (`io.step()`) | 実際に I/O が飛んでいる     |
| `Yield`              | すぐ呼び直してよい       | 他のスレッドに譲りたいだけ  |
| `Sleep { duration }` | その時間待つ             | busy handler がバックオフ中 |

内向きの `InsnFunctionStepResult` は 4 値で、命令 1 個が返す。

```rust title="core/vdbe/execute.rs:393-398"
pub enum InsnFunctionStepResult {
    Done,
    IO(IOCompletions),
    Row,
    Step,
}
```

`Step` は「この命令は終わった、次へ」、`Done` は「プログラム全体が終わった」。**`Done` を返せるのは `Halt` だけ**で、`Step` との区別がそこにある。

### ディスパッチは `match` ではない

```rust title="core/vdbe/execute.rs:210-211"
pub type InsnFunction =
    fn(&Program, &mut ProgramState, &Insn, &Arc<Pager>) -> Result<InsnFunctionStepResult>;
```

全命令が同じシグネチャの関数ポインタになる。そして振り分けは配列引きだ。

```rust title="core/vdbe/insn.rs:2128"
const INSN_VTABLE: [InsnFunction; InsnVariants::COUNT] = get_insn_virtual_table();
```

```rust title="core/vdbe/insn.rs:2354-2366"
    // then the discriminant may be reliably accessed via unsafe pointer casting
    #[inline(always)]
    pub(crate) const fn discriminant(&self) -> u8 {
        unsafe { *(self as *const Self as *const u8) }
    }

    #[inline(always)]
    pub const fn to_function(&self) -> InsnFunction {
        // dont use this because its still using match
        // InsnVariants::from(self).to_function_fast()
        INSN_VTABLE[self.discriminant() as usize]
    }
```

**`Insn` の先頭バイト (判別子) を直接読んで、配列の添字にする。** コメントが「これを使うな、まだ `match` を使っているから」と、使わない方の実装を名指ししている。

テーブル自体は `const fn` で組み立てられる。

```rust title="core/vdbe/insn.rs:2140-2144 (抜粋)"
// This function is used for generating `INSN_VTABLE`.
// We need to keep this function to make sure we implement all opcodes
pub(crate) const fn to_function(self) -> InsnFunction {
    match self {
        InsnVariants::Init => execute::op_init,
```

**`match` は残っているが、コンパイル時にしか走らない。** 全バリアントを網羅しているかをコンパイラに検査させるために、この `match` を残してある。実行時は配列引き、コンパイル時は網羅性検査、という役割分担になっている。

`Insn` は 210 バリアントある。`match` のジャンプテーブルに任せてもよさそうだが、バリアントがフィールドを持つ enum では最適化が読みにくい。**判別子だけを取り出して確実に配列引きにする**という選択をしている。

## 処理の流れ (コードを追う)

### ループは二重になっている

```rust title="core/vdbe/mod.rs:1949-1957 (抜粋)"
let enable_tracing = tracing::enabled!(tracing::Level::TRACE);
// Invalidate the previous result row once per step call: rows are only
// handed out between step calls, and ResultRow returns immediately
// after setting a fresh one.
let _ = state.result_row.take();
// The outer loop runs once per step call and is re-entered only when an
// instruction completed its IO inline; the inner loop dispatches
// instructions without re-inspecting the completion slot every time.
'io_check: loop {
```

**外側 (`'io_check`) は完了スロットの検査、内側は命令のディスパッチ。** 外側に戻るのは、命令が返した I/O が既に完了していたときだけだ。

分けている理由は性能だ。命令を 1 個実行するたびに `io_completions` を見るのは無駄なので、内側のループは完了検査を飛ばして回り続ける。

### 外側 — 完了の検査とエラーの取り出し

```rust title="core/vdbe/mod.rs:1958-1964 (抜粋)"
if let Some(io) = &state.io_completions {
    if !io.finished() {
        io.set_waker(waker);
        return Ok(StepResult::IO);
    }
    if let Some(err) = io.get_error() {
```

**まだ終わっていなければ、また `IO` を返して帰る。** 呼び出し元が `io.step()` を呼んでも、その 1 回で完了するとは限らない。

I/O エラーの扱いに 1 箇所だけ特別なところがある。

```rust title="core/vdbe/mod.rs:1963-1971 (抜粋)"
if let Some(err) = io.get_error() {
    if pager.is_checkpointing() {
        // Wrap IO errors that occurred during checkpointing in CheckpointFailed error,
        // so that abort() knows not to try to rollback the transaction, because the transaction
        // is already durable in the WAL and hence committed.
        // This also lets the simulator know that it should shadow the results of the query because
        // the write itself succeeded.
        let checkpoint_err = LimboError::CheckpointFailed(err.to_string());
```

**チェックポイント中の I/O エラーでは、トランザクションをロールバックしてはいけない。** WAL に書けた時点でコミット済みだからだ。失敗したのは「WAL から本体ファイルへの転記」であって、コミットそのものではない。

エラーの種類を変えることで、`abort()` の振る舞いを変えている。コメントの後半にあるとおり、決定的シミュレータもこの区別を使う ([該当ページ](../deterministic-simulator/))。

### 内側 — ディスパッチと 6 通りの結果

```rust title="core/vdbe/mod.rs:2054-2055"
let (insn, _) = &self.insns[state.pc as usize];
let insn_function = insn.to_function();
```

```rust title="core/vdbe/mod.rs:2095-2135 (抜粋)"
// Always increment VM steps for every loop iteration
state.metrics.vm_steps = state.metrics.vm_steps.saturating_add(1);

match insn_function(self, state, insn, pager) {
    Ok(InsnFunctionStepResult::Step) => {
        // Instruction completed, moving to next
        state.metrics.insn_executed = state.metrics.insn_executed.saturating_add(1);
    }
    Ok(InsnFunctionStepResult::Done) => {
        state.metrics.insn_executed = state.metrics.insn_executed.saturating_add(1);
        state.auto_txn_cleanup = TxnCleanup::None;
        return Ok(StepResult::Done);
    }
    Ok(InsnFunctionStepResult::IO(io)) => {
        io.set_waker(waker);
        let is_yield = io.is_explicit_yield();
        if is_yield {
            // Yield: return control to the cooperative scheduler so
            // other connections can make progress (e.g. release a
            // contended lock). Don't store in io_completions —
            // yields aren't pending I/O, so the instruction will
            // simply re-execute on the next step.
            return Ok(StepResult::Yield);
        }
        let finished = io.finished();
        state.io_completions = Some(io);
        if !finished {
            return Ok(StepResult::IO);
        }
        // IO already finished: loop back to the completion check so
        // errors are observed, then continue execution immediately.
        continue 'io_check;
    }
    Ok(InsnFunctionStepResult::Row) => {
        state.metrics.insn_executed = state.metrics.insn_executed.saturating_add(1);
        return Ok(StepResult::Row);
    }
```

**`pc` を進めるのは命令自身の仕事だ。** `Step` を返したときも、このループは `pc` を触っていない。各 `op_*` 関数が自分で `state.pc += 1` するか、分岐なら飛び先を書く。だから **I/O で帰るときは `pc` を書き換えないだけでよい**。次の `step()` が同じ添字を引く。

`Yield` の扱いが特徴的だ。**完了ハンドルを `io_completions` に保存しない。** 保存すると次の `step()` で「完了待ち」に入ってしまう。yield は待つべき I/O がないので、次回は素直に同じ命令をもう一度実行させる。

「同じ命令をもう一度実行しても壊れない」ことが前提になっている。この前提を全命令に強制するために、毎回必ず yield するテスト用 I/O バックエンドがある ([該当ページ](../memory-yield-io/))。

`I/O` が既に完了していた場合に `continue 'io_check` する意味も明確だ。**エラーを取りこぼさないため**にわざわざ外側へ戻る。すぐ続けても動きそうだが、そうすると `io.get_error()` の検査を素通りする。

### メトリクスの 2 本立てが中断回数を表す

```rust title="core/vdbe/mod.rs:2096"
// Always increment VM steps for every loop iteration
state.metrics.vm_steps = state.metrics.vm_steps.saturating_add(1);
```

`vm_steps` は毎周、`insn_executed` は命令が**完了した**ときだけ増える。`IO` を返した周では `insn_executed` が増えない。

**`vm_steps - insn_executed` が、命令が中断して再開した回数になる。** 手書き状態機械が何回巻き戻ったかを、そのまま数えていることになる。

### エラーの 4 分類

```rust title="core/vdbe/mod.rs:2136-2166 (抜粋)"
Err(LimboError::Busy) => {
    // Instruction blocked - will retry at same PC
    return Ok(StepResult::Busy);
}
Err(LimboError::BusySnapshot)
    if self.connection.transaction_state.get() == TransactionState::None =>
{
    // For interactive transactions that are already in a read transaction, retrying BusySnapshot is pointless
    // because the snapshot will continue to be stale no matter how many times we retry.
    // However, for auto-commits or BEGIN IMMEDIATE, failing to promote to write transaction means it was rolled
    // back, so auto-retrying can be useful.
    return Ok(StepResult::Busy);
}
Err(err)
    if (matches!(err, LimboError::Constraint(_))
        && self.resolve_type == ResolveType::Fail)
        || matches!(err, LimboError::Raise(ResolveType::Fail, _)) =>
{
    state.pending_fail_prepare_error = Some(err);
}
Err(err) => {
    if let Err(abort_err) = self.abort(pager, Some(&err), state, true) {
        tracing::error!("Abort failed during error handling: {abort_err}");
    }
    return Err(err);
```

1. **`Busy`** — 同じ `pc` で再試行できる。`StepResult::Busy` にして返す
2. **`BusySnapshot`** — トランザクションの外なら再試行の意味がある。中なら意味がないので、下の分岐に落ちて本物のエラーになる
3. **`Constraint` + `ResolveType::Fail`** — `state` に退避して**ループを続ける**。`return` しない
4. **その他** — `abort()` してから返す

3 番目だけ `return` しないのが重要だ。`OR FAIL` は「そこまでの行は残す」という意味なので、**エラーを持ったまま後始末を進める**必要がある ([`ProgramState` のページ](../program-and-state/))。ループの先頭で `pending_fail_prepare_error` が取り出され、索引方式の書き込みを終えてから返る。

### `EXPLAIN` は別の `step` を通る

```rust title="core/vdbe/mod.rs:1748-1757 (抜粋)"
let result = match query_mode {
    QueryMode::Normal => self.normal_step(state, pager, waker),
    QueryMode::Explain => self.explain_step(state, pager),
    QueryMode::ExplainQueryPlan { format: EqpFormat::Text } => self.explain_query_plan_step(state, pager),
    QueryMode::ExplainQueryPlan { format: EqpFormat::Json } => self.explain_query_plan_json_step(state, pager),
};
```

4 つの `step` が並んでいる。`explain_step` は命令を実行せず、`self.insns` を 1 行ずつ表として返す。

```rust title="core/vdbe/mod.rs:1791-1800 (explain_step 抜粋)"
loop {
    if let Some(ref current) = explain_state.current {
        if (state.pc as usize) < current.insns.len() {
            break;
        }
    } else if (state.pc as usize) < self.insns.len() {
        break;
    }
    // Current program is done, pop next subprogram from queue
```

**`pc` を「命令の実行位置」ではなく「表の行番号」として使い回している。** そしてサブプログラム (トリガ) の命令列も、キューから取り出して続けて出力する。SQLite の `EXPLAIN` が親と子の命令列を続けて出すのに合わせている。

## 守られている不変条件

**`pc` を進めるのは命令自身。** ループは触らない。だから I/O で帰るときは何もしなくてよい。

**I/O で中断した命令は、同じ入力でもう一度呼ばれても壊れてはいけない。** これが全命令に課される契約で、破ると再入バグになる ([該当ページ](../reentrancy/))。

**`Yield` の完了ハンドルは保存しない。** 保存すると次回が完了待ちになる。

**I/O 完了スロットのエラーは必ず読む。** 即完了でも `'io_check` へ戻る。

**チェックポイント中の I/O エラーではロールバックしない。** WAL に書けていればコミット済み。

**`Done` を返せるのは `Halt` だけ。**

## つまずきどころ / 設計の含み

### `unsafe` な判別子読み出しの条件

```rust title="core/vdbe/insn.rs:2354-2358 (抜粋)"
// then the discriminant may be reliably accessed via unsafe pointer casting
#[inline(always)]
pub(crate) const fn discriminant(&self) -> u8 {
    unsafe { *(self as *const Self as *const u8) }
}
```

`Insn` に `#[repr(u8)]` が付いていて ([`core/vdbe/insn.rs:383`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/insn.rs#L383))、バリアントが 256 未満であることが前提になっている。**210 バリアントなので余裕は 46 個しかない。**

命令を足し続けて 256 を超えたらどうなるか。判別子が `u16` になり、この `u8` キャストは静かに壊れる。型では守られていないので、そのときに気づけるかは分からない。

### `vdbe_trace` はレジスタの差分を出す

```rust title="core/vdbe/mod.rs:2060-2094 (抜粋)"
if self.connection.get_vdbe_trace() {
    // Diff registers from PREVIOUS opcode
    if let Some(ref old) = state.pre_op_registers {
        for (i, (old_reg, new_reg)) in old.iter().zip(state.registers.iter()).enumerate() {
            if old_reg != new_reg {
                match new_reg {
                    Register::Value(v) => eprintln!("R[{i}] = {v}"),
                    // ...
                }
            }
        }
        state.pre_op_registers = None;
    }
    // ...
    // Snapshot for next iteration
    state.pre_op_registers = Some(state.registers.clone());
}
```

**命令ごとにレジスタ配列を丸ごと clone している。** トレースを有効にすると、レジスタ数 × 命令数のコピーが走る。デバッグ専用の機能だが、有効にしたまま性能を測ると桁が変わる。

`Halt` の直後は差分が出ない、とコメントが断っている — 次の周がないからだ。

### `Sleep` と `Busy` の関係が層をまたぐ

`Program::step()` は `Sleep` を返さない。**`Sleep` を作るのは `Statement::_step()` の側**だ ([クエリの一生のページ](../query-lifecycle/))。

```text
op_transaction が競合         → Err(LimboError::Busy)
  ↓ Program::step
StepResult::Busy
  ↓ Statement::_step が busy handler を呼ぶ
StepResult::Sleep { duration }  または  StepResult::Busy
```

busy handler は接続の設定なので、`Program` の層では見えない。**「同じ `StepResult` 型の値を、上の層が別の値に翻訳する」**という形になっていて、`StepResult` の 6 値のうち `Sleep` だけが VM の外で作られる。

`StepResult` の定義を読んで VM の挙動を理解しようとすると、この 1 つだけ出どころが違う点でつまずく。

### 210 命令という数

`enum Insn` の定義の直前に、比較対象がコメントで置かれている。

```rust title="core/vdbe/insn.rs:382-383"
// There are currently 190 opcodes in sqlite
#[repr(u8)]
```

Turso が 210 なのは、SQLite にない命令を足しているからだ — ハッシュ結合 (`HashBuild` / `HashProbe` / `HashClear`)、索引方式、CDC、シーケンス、マテリアライズドビューの差分。

**互換性の契約は「同じ SQL に対して同じ命令列を吐く」であって、「命令セットが同じ」ではない** ([該当ページ](../sqlite-compat/))。だから `EXPLAIN` の突き合わせは、SQLite が生成しうるクエリの範囲でしか成立しない。ハッシュ結合を選んだクエリの `EXPLAIN` は、SQLite と一致しない。
