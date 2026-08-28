---
title: "コミットは 1 命令ではなく、命令の中に埋まった状態機械"
description: "`Transaction` 命令はプログラムの末尾に置かれ、`Halt` がコミットを起こす。だが `Halt` は 1 回で終わらない — WAL のフラッシュも fsync も自動チェックポイントも I/O を伴うので、`CommitState` という状態を `ProgramState` に置いて何度も再開する。`OR FAIL` はエラーを持ったままコミットを完走させる必要があり、割り込みは `Halt` 中だけ無効化される。"
group: "バイトコードの実行"
sidebar:
  order: 15
---

## この層の責務

サーバ型の RDB なら、コミットは「WAL に書いて fsync する」という 1 つの同期的な手続きだ。呼んだスレッドはそこでブロックする。

Turso では、その手続きの全段が中断しうる。

- ダーティページを WAL に書く → I/O
- WAL を fsync する → I/O
- 自動チェックポイントを走らせる → 大量の I/O

**だから「コミットする」は 1 個の命令では表せない。** `Halt` 命令が何度も呼ばれ、そのたびに前回の続きから進む。

そしてトランザクションの状態は、`ProgramState`・`Connection`・`Pager`・`WAL` の 4 箇所に分散している。このページはその噛み合わせを見る。

## 主要な型とその関係

### 4 箇所にある状態

| 場所           | 型                   | 表すもの                               |
| -------------- | -------------------- | -------------------------------------- |
| `Connection`   | `TransactionState`   | 論理的なトランザクションの状態         |
| `ProgramState` | `CommitState`        | コミット手続きの進行位置               |
| `ProgramState` | `OpTransactionState` | `Transaction` 命令の進行位置           |
| `Pager`        | `CommitInfo.state`   | WAL 書き出しと自動チェックポイントの段 |

```rust title="core/connection.rs:66-78"
pub(crate) enum TransactionState {
    Write {
        schema_did_change: bool,
    },
    Read,
    /// PendingUpgrade remembers what transaction state was before upgrade to write (has_read_txn is true if before transaction were in Read state)
    /// This is important, because if we failed to initialize write transaction immediatley - we need to end implicitly started read txn (e.g. for simiple INSERT INTO operation)
    /// But for late upgrade of transaction we should keep read transaction active (e.g. BEGIN; SELECT ...; INSERT INTO ...)
    PendingUpgrade {
        has_read_txn: bool,
    },
    None,
}
```

`Write` が `schema_did_change` を抱えているのが目を引く。**DDL を実行したかどうかを、トランザクションの状態の一部として持つ。** コミット時にこれを見て、スキーマを共有側へ公開するかを決める。

`PendingUpgrade` は「読みから書きへの昇格の途中」だ。コメントが説明しているとおり、**失敗したときに読みトランザクションを閉じるべきか残すべきかが、昇格の経緯によって違う**。

- `INSERT` 単独 → 読みは暗黙に始めたものなので、失敗したら閉じる
- `BEGIN; SELECT; INSERT` → 読みはユーザが始めたので、失敗しても残す

その区別を `has_read_txn: bool` で覚えている。

```rust title="core/vdbe/mod.rs:202-215"
enum CommitState {
    Ready,
    Committing,
    CommittingAttached,
    CommittingMvcc {
        state_machine: StateMachine<Box<MvccCommitStateMachine>>,
    },
    CommittingAttachedMvcc {
        state_machine: StateMachine<Box<MvccCommitStateMachine>>,
        db_id: usize,
        mv_store: Arc<MvStore>,
    },
}
```

[状態機械のページ](../io-result-and-state-machine/) で見たとおり、流儀 B の enum の中に流儀 A の `StateMachine` が入っている。**`ATTACH` した各データベースを順にコミットするので、「今どのデータベースか」も状態に含まれる。**

```rust title="core/vdbe/execute.rs:3993-3999"
pub enum OpTransactionState {
    Start,
    AttachedBeginWriteTx,
    BeginNamedSavepoints,
    CheckSchemaCookie,
    BeginStatement,
}
```

トランザクションを**開始する**方も 5 段ある。付属データベースのロック取得、名前付きセーブポイントの再開、スキーマ cookie の照合、文レベルのサブトランザクション開始。

## 処理の流れ (コードを追う)

### `Transaction` 命令が最初にすること — 同一接続の 2 人目の書き手を弾く

```rust title="core/vdbe/execute.rs:4258-4279 (抜粋)"
let active_writers = conn.n_active_writes.load(Ordering::SeqCst);
turso_assert!(
    active_writers <= 1,
    "n_active_writes must be 0 or 1, got {active_writers}"
);
// One connection may have many active readers, but only one
// top-level writer. A second writer on the same connection is
// rejected before it opens transaction or savepoint state.
//
// This is stricter than SQLite. SQLite can run overlapping
// write statements on one connection because sqlite3_step()
// does not return to the caller in the middle of built-in
// write opcodes. Turso can suspend there for async I/O, so a
// second writer would make reset/drop cleanup hard to get right.
if statement_writes_db
    && !conn.is_nested_stmt()
    && !state.is_active_write
    && active_writers > 0
{
    return Err(LimboError::StatementsInProgress(
        "cannot start a write statement",
    ));
}
```

**SQLite より厳しい制限を、明示的に理由付きで課している。**

SQLite では `sqlite3_step()` が書き込み命令の途中で返らないので、1 接続で 2 つの書き込み文を交互に進めることができる。Turso は I/O で返るので、2 人目の書き手がいると「どちらの後始末を先にするか」が決まらない。

**非同期化が API の意味論を変えた例**で、互換性を落としてでも正しさを取っている。[互換性のページ](../sqlite-compat/) が言う「何が自由か」の境界がここに出る。

### `Halt` がコミットを起こす

```rust title="core/vdbe/execute.rs:3429-3442 (抜粋)"
pub fn halt(
    program: &Program,
    state: &mut ProgramState,
    pager: &Arc<Pager>,
    err_code: usize,
    description: &str,
    on_error: Option<ResolveType>,
) -> Result<InsnFunctionStepResult> {
    state.halt_in_progress = true;
    let mv_store = program.connection.mv_store();
    let auto_commit = program.connection.auto_commit.load(Ordering::SeqCst);
    // halt() runs while the statement is still stepping, so it is always
    // counted in n_active_root_statements here.
    let can_autocommit_now = state.can_autocommit_now(&program.connection, true);
```

**1 行目で `halt_in_progress` を立てる。** これ以降、割り込み要求は無視される ([`ProgramState` のページ](../program-and-state/))。結果が確定した後で中断に化けるのを防ぐためだ。

そして次に来るのが再開の入口になる。

```rust title="core/vdbe/execute.rs:3444-3458"
// Check if we're resuming from a FAIL commit I/O wait.
// If pending_fail_error is set, we were in the middle of committing partial changes
// for FAIL mode and need to continue the commit, then return the stored error.
if let Some(pending_error) = state.pending_fail_error.take() {
    match program.commit_txn(pager.clone(), state, mv_store.as_ref(), false)? {
        IOResult::Done(_) => {
            index_method_on_transaction_committed_all(state, &program.connection);
            return Err(pending_error);
        }
        IOResult::IO(io) => {
            state.pending_fail_error = Some(pending_error); // put it back and wait
            return Ok(InsnFunctionStepResult::IO(io));
        }
    }
}
```

**`OR FAIL` は「エラーを返すが、そこまでの変更はコミットする」。** だから `halt` はエラーを握ったままコミットを完走させ、終わってから返す。

`take()` して、I/O なら `Some(...)` に戻す。[状態機械のページ](../io-result-and-state-machine/) で見た「取り出して書き戻す」の典型で、書き戻しを忘れるとエラーが消えて成功したことになる。

### `commit_txn` が 4 段の門を通る

```rust title="core/vdbe/mod.rs:2288-2300 (抜粋)"
// Apply view deltas with I/O handling
match self.apply_view_deltas(program_state, rollback, &pager)? {
    IOResult::IO(io) => return Ok(IOResult::IO(io)),
    IOResult::Done(_) => {}
}

program_state.view_delta_state = ViewDeltaCommitState::NotStarted;
// Drop virtual table cursors before the `is_nested_stmt()` check
// below: a pragma virtual table cursor owns a nested helper statement
// whose guard would otherwise make this top-level statement classify
// itself as nested and skip transaction finalization entirely.
program_state.close_virtual_table_cursors();
```

**1. マテビューの差分を適用する。** これ自体が I/O を伴うので、`commit_txn` の最初の中断点になる。

**2. 仮想テーブルのカーソルを閉じる。** コメントの理由が面白い — `PRAGMA` の仮想テーブルカーソルが内部でヘルパ文を持っており、それが生きていると**この文自身が「ネストした文」と誤判定される**。誤判定されるとコミットを親に任せて何もしないので、トランザクションが閉じない。

**3. 本当に閉じるべきものがあるかを確認する。**

```rust title="core/vdbe/mod.rs:2301-2316 (抜粋)"
let tx_state = self.connection.get_tx_state();
if tx_state == TransactionState::None
    && matches!(program_state.commit_state, CommitState::Ready)
{
    // No main transaction and no in-progress commit — check whether
    // any attached/temp database still has an active transaction before
    // bailing out. Defer these checks to here so the common case
    // (active main transaction) doesn't pay for the lock reads.
    let has_attached_mv_tx = self.connection.next_attached_mv_tx().is_some();
    let has_attached_wal_tx = /* ... */;
    if !has_attached_mv_tx && !has_attached_wal_tx {
        return Ok(IOResult::Done(()));
    }
}
```

**主データベースにトランザクションがなくても、付属データベースに残っているかもしれない。** ただしその確認はロック読みを伴うので、主データベースにトランザクションがある通常経路では実行しない。

**4. ネストした文なら何もしない。** 親が commit する。

そして MVCC か WAL かで分岐する。

```rust title="core/vdbe/mod.rs:2323-2327"
let res = if let Some(mv_store) = mv_store {
    self.commit_txn_mvcc(pager, program_state, mv_store, rollback)
} else {
    self.commit_txn_wal(pager, program_state, rollback)
}?;
```

### `Pager::commit_tx` が自動チェックポイントを別段にする

```rust title="core/storage/pager.rs:3100-3109 (抜粋)"
loop {
    let commit_state = self.commit_info.read().state;
    tracing::debug!("commit_state: {:?}", commit_state);
    // we separate auto-checkpoint from the commit in order for checkpoint to be able to backfill WAL till the end
    // (including new frames from current transaction)
    // otherwise, we will be unable to do WAL restart
    match commit_state {
        CommitState::AutoCheckpoint => {
```

**自分が書いたフレームも含めてチェックポイントしたいので、コミットを先に完了させてからチェックポイントに入る。** 同じ手続きの中でやると、自分のフレームがまだ「コミット済み」でないので転記できず、WAL のリスタートができない。

コミット側の本体はこうなっている。

```rust title="core/storage/pager.rs:3128-3149 (抜粋)"
return_if_io!(self.commit_wal(
    connection.wal_auto_actions(),
    connection.get_sync_mode(),
    connection.get_data_sync_retry(),
));

let schema_did_change = match connection.get_tx_state() {
    TransactionState::Write { schema_did_change } => schema_did_change,
    _ => false,
};

wal.end_write_tx();
wal.end_read_tx();

tracing::debug!("commit_tx: schema_did_change={schema_did_change}");
if schema_did_change {
    let schema = connection.schema.read().clone();
    connection.db.update_schema_if_newer(schema);
}
```

**スキーマの公開はここで起きる。** 接続ローカルのスキーマを、プロセス内共有へ押し上げる ([スキーマ解決のページ](../schema-resolution/))。**WAL のロックを解放した後**なのが重要で、DDL がコミットされた時点で初めて他の接続に見えるようになる。

順序も決まっている。`commit_wal` (耐久性) → `end_write_tx` / `end_read_tx` (ロック解放) → スキーマ公開。

### 自動チェックポイントに入るときの後始末

```rust title="core/storage/pager.rs:3154-3162 (抜粋)"
// The commit is durable and the WAL locks are released; only
// the auto-checkpoint remains. Clear the transaction state now
// so an abort during the checkpoint does not try to roll back
// the committed transaction. Savepoints stay until the
// checkpoint finishes: a re-entered RELEASE must still find
// them (see release_named_savepoint).
if update_transaction_state {
    connection.set_tx_state(TransactionState::None);
}
```

**トランザクション状態は今すぐ消し、セーブポイントは残す。** チェックポイント中にエラーが起きても、既にコミット済みのトランザクションをロールバックしてはいけない。[`step` のページ](../step-loop/) で見た「チェックポイント中の I/O エラーを `CheckpointFailed` に包む」処理と、同じ危険を別の角度から塞いでいる。

## 守られている不変条件

**1 接続に書き込み文は同時に 1 つ。** `n_active_writes` が 0 か 1 であることを `turso_assert!` で確認している。

**`Halt` の途中では割り込まない。** `halt_in_progress` が立つ。

**コミットの各段は再開可能で、中断時は状態を必ず書き戻す。** `pending_fail_error` の `take()` / 戻し。

**耐久性が確定したらトランザクション状態を消す。** その後のチェックポイント失敗でロールバックしないため。

**スキーマの公開は WAL ロック解放の後。**

**自動チェックポイントはコミット完了後の別段。** 自分のフレームを転記対象に含めるため。

**トリガのサブプログラムは `Transaction` 命令を持てない。** 持っていたらパースエラーにする。

## つまずきどころ / 設計の含み

### `Transaction` 命令が末尾にある意味

[エミッタのページ](../emitter-main-loop/) で見たとおり、`Transaction` はプログラムの末尾に置かれ、`Init` からのジャンプで最初に実行される。

つまり**命令列を上から読むと、トランザクションを開く命令が最後にある**。SQLite の `EXPLAIN` 出力でも同じ形なので互換性は保たれているが、初めて読むと戸惑う。

この配置には実利がある。`Transaction` 命令のオペランドには schema cookie が埋まっていて、実行時に照合される。**プログラムの本体を実行する直前に、必ずこの照合を通る**構造になっている。

### `is_nested_stmt()` の判定がカーソルの寿命に依存する

```rust title="core/vdbe/mod.rs:2296-2300 (抜粋)"
// Drop virtual table cursors before the `is_nested_stmt()` check
// below: a pragma virtual table cursor owns a nested helper statement
// whose guard would otherwise make this top-level statement classify
// itself as nested and skip transaction finalization entirely.
program_state.close_virtual_table_cursors();
```

`nestedness` は接続のカウンタで、ネストした文が入るときに増える ([起動のページ](../boot-and-wiring/) で見た `Connection` のフィールド)。`PRAGMA` の仮想テーブルカーソルは内部で `Statement` を持ち、そのガードがカウンタを保持している。

**カーソルを閉じる順番を間違えると、トップレベルの文が「自分はネストしている」と判断してコミットを飛ばす。** そしてトランザクションが開いたまま残る。

この種のバグは、`Statement` の生存期間が資源の解放と結びついている ([`ProgramState` のページ](../program-and-state/)) 構造から必然的に出てくる。RAII が「いつ落ちるか」に意味を持たせるので、落とす順序が意味論の一部になる。

### `auto_commit` は接続の `AtomicBool`

`BEGIN` は `auto_commit` を `false` にするだけの命令で、`COMMIT` が `true` に戻す。**明示的トランザクションと暗黙のトランザクションは、この 1 ビットの差でしかない。**

`halt` はこのビットを見てコミットするかを決める。

```rust title="core/vdbe/execute.rs:3439-3442 (抜粋)"
let auto_commit = program.connection.auto_commit.load(Ordering::SeqCst);
// halt() runs while the statement is still stepping, so it is always
// counted in n_active_root_statements here.
let can_autocommit_now = state.can_autocommit_now(&program.connection, true);
```

`can_autocommit_now` が別にあるのは、**`auto_commit` が true でも今コミットしてよいとは限らない**からだ。同じ接続で他の root 文が走っていれば、そちらの結果セットがまだ読まれている可能性がある。SQLite の `nVdbeActive` に対応する判定で、in-process だからこそ「他の文がまだ生きている」状態が普通に起きる。

### エラーコードの翻訳が `halt` の中にある

```rust title="core/vdbe/execute.rs:3497-3506 (抜粋)"
let constraint_error = match err_code {
    0 => None,
    SQLITE_CONSTRAINT_PRIMARYKEY => Some(LimboError::Constraint(format!(
        "UNIQUE constraint failed: {description}"
    ))),
    SQLITE_CONSTRAINT_CHECK => Some(LimboError::Constraint(format!(
        "CHECK constraint failed: {description}"
    ))),
    // ...
```

**`Halt` 命令のオペランドは SQLite のエラーコード番号**で、それを Rust の `LimboError` に翻訳するのが `halt` の仕事になっている。

命令列の互換性を保つ以上、エラーコードも SQLite のものを命令に埋め込むしかない。**互換性の契約が、内部のエラー型の設計にまで影響している**例で、`SQLITE_ERROR` だけ「制約違反ではない」と注記されているのは、番号の意味が 1 対 1 に写らないからだ。
