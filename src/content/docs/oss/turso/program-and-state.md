---
title: "`Program` は不変、`ProgramState` が可変。この分割が再開を支える"
description: "`Program` はフィールドが 2 つしかない。命令列その他は `Arc<PreparedProgram>` の向こうにあり、実行中に一切書き換わらない。可変なものは全部 `ProgramState` に入る — プログラムカウンタ、レジスタ配列、カーソル配列、そして 21 種類ある「命令 1 個の途中経過」。この分割が、I/O 待ちからの再開と、同じ文の再実行の両方を成立させている。"
group: "バイトコードの実行"
sidebar:
  order: 12
---

## この層の責務

コンパイルが終わると `Program` ができる。これを `ProgramState` と組み合わせて `step()` すると行が出る。

**なぜ 2 つに分かれているのか。** 理由は 2 つある。

1. **I/O 待ちで帰って再開するため。** `step()` は途中で呼び出し元に返る。次に呼ばれたとき、`pc` もレジスタもカーソルも前回のままでなければならない
2. **同じ文を何度も実行するため。** `reset()` して再実行するとき、捨てるのは `ProgramState` だけでよい。コンパイル結果は使い回す

そして `EXPLAIN` が同じ `Program` を印字できるのも、この分割があるからだ ([該当ページ](../vdbe/))。

## 主要な型とその関係

### `Program` はフィールドが 2 つ

```rust title="core/vdbe/mod.rs:1628-1632"
#[derive(Clone)]
pub struct Program {
    pub(crate) prepared: Arc<PreparedProgram>,
    pub connection: Arc<Connection>,
}
```

コンパイル結果は全部 `PreparedProgram` の中にあり、`Arc` の向こうにある。`Program` 自体は「コンパイル結果 + それを実行する接続」というペアでしかない。

```rust title="core/vdbe/mod.rs:1597-1627 (抜粋)"
pub struct PreparedProgram {
    pub max_registers: usize,
    pub insns: Vec<(Insn, usize)>,
    pub cursor_ref: Vec<(Option<CursorKey>, CursorType)>,
    pub explain: ExplainInfo,
    pub parameters: crate::parameters::Parameters,
    pub change_cnt_on: bool,
    /// mirrors: https://sqlite.org/c3ref/stmt_readonly.html.
    pub readonly: bool,
    pub result_columns: Vec<ResultSetColumn>,
    pub table_references: TableReferences,
    pub sql: String,
    pub needs_stmt_subtransactions: Arc<AtomicBool>,
    pub trigger: Option<Arc<Trigger>>,
    pub is_subprogram: bool,
    pub resolve_type: ResolveType,
    pub prepare_context: PrepareContext,
    pub write_databases: BitSet,
    pub read_databases: BitSet,
}
```

**`Arc` で包まれているので、同じコンパイル結果を別の接続に貼り直せる。**

```rust title="core/vdbe/mod.rs:1672-1678"
impl PreparedProgram {
    pub fn bind(self: Arc<Self>, connection: Arc<Connection>) -> Program {
        Program {
            prepared: self,
            connection,
        }
    }
```

`insns: Vec<(Insn, usize)>` の 2 番目の `usize` は、`ProgramBuilder` の中での元の位置だ。定数命令の巻き上げで並べ替えが起きても、`EXPLAIN` は元の順で番号を振れる ([エミッタのページ](../emitter-main-loop/))。

### `PrepareContext` は 2 ワードで無効化を判定する

```rust title="core/vdbe/mod.rs:1656-1664"
pub struct PrepareContext {
    /// Identity check: the prepared statement must belong to the same database.
    database_ptr: usize,
    /// Generation counter snapshot taken at prepare time. Compared against the
    /// connection's current generation to detect setting changes (pragmas,
    /// attach/detach, extension registration, etc.) without rebuilding the full
    /// context on every step.
    generation: u64,
}
```

`step()` のたびにこれを比べる ([クエリの一生のページ](../query-lifecycle/))。**`usize` と `u64` の比較 2 回**で、「このプログラムはまだ有効か」が決まる。

そのぶん、新しい設定を足す側に義務が課される。

```rust title="core/vdbe/mod.rs:1640-1645 (抜粋)"
/// # Adding New Fields
///
/// If you add a new setting to `Connection` that affects statement compilation or execution,
/// When adding a new connection setting that affects query compilation, you MUST call
/// `bump_prepare_context_generation()` in its setter so that prepared statements know
/// they need to be reprepared.
```

**コンパイルに影響する設定のセッタは、必ず世代を上げなければならない。** 型では守れず、ドキュメントコメントで要求している。実際 `bump_prepare_context_generation()` は `core/connection.rs` の中だけで 10 箇所以上から呼ばれている。

### `ProgramState` は 40 以上のフィールドを持つ

```rust title="core/vdbe/mod.rs:779-800 (抜粋)"
pub struct ProgramState {
    pub io_completions: Option<IOCompletions>,
    pub pc: InsnReference,
    pub(crate) cursors: Vec<Option<Cursor>>,
    // ...
    registers: Box<[Register]>,
    pub(crate) result_row: Option<Row>,
    last_compare: Option<std::cmp::Ordering>,
    deferred_seeks: Vec<Option<DeferredSeekState>>,
    ended_coroutine: Vec<u32>,
    once: SmallVec<[u32; 4]>,
    pub execution_state: ProgramExecutionState,
    // ...
    commit_state: CommitState,
    active_op_state: ActiveOpStateSlot,
    seek_state: OpSeekState,
    // ...
}
```

性質で分けると 4 群になる。

| 群                      | 例                                                                                                       | 何のためか               |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------ |
| VM の基本状態           | `pc`, `registers`, `cursors`                                                                             | SQLite の VDBE と同じ    |
| 命令間で持ち越す値      | `last_compare`, `once`, `ended_coroutine`, `deferred_seeks`                                              | 複数命令にまたがる意味論 |
| **命令 1 個の途中経過** | `active_op_state`, `seek_state`, `commit_state`, `view_delta_state`                                      | 中断・再開のため         |
| 文の後始末のための帳簿  | `pending_fail_error`, `halt_in_progress`, `auto_txn_cleanup`, `fk_deferred_violations_when_stmt_started` | エラー・ロールバック     |

3 番目の群が、Turso 固有のものだ。SQLite の `Vdbe` 構造体にはこれに当たるものがない — `sqlite3VdbeExec` は I/O でブロックするので、命令の途中で返ることがないからだ。

### `Register` は 3 バリアント

```rust title="core/vdbe/mod.rs:269-273"
pub enum Register {
    Value(Value),
    Aggregate(AggContext),
    Record(ImmutableRecord),
}
```

SQLite の `Mem` に相当する。`Record` が独立したバリアントなのは、**行のバイト列をそのまま持ち回るため**だ。`SELECT * FROM t` で行を返すとき、列に分解して値の配列を作り直す必要はない。`Record` のままカーソルから受け取り、`Record` のまま返せる。

`registers: Box<[Register]>` が `Vec` でなく `Box<[T]>` なのは、**確保後に伸びないから**だ。長さは `PreparedProgram::max_registers` で決まっている。

### `ActiveOpState` — 21 種類の「命令の途中」

```rust title="core/vdbe/mod.rs:529-551"
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

**`Column` と `RowId` が入っているのが目を引く。** 「カーソルから列を 1 つ取る」という最も基本的な命令ですら、途中で I/O 待ちになりうる — オーバーフローページに跨る値なら、追加のページを読む必要があるからだ ([オンディスク形式のページ](../ondisk-format/))。

`ActiveOpState` は 1 個しか持てない。同時に 2 つの命令が途中にいることはない、という前提が入っている。

```rust title="core/vdbe/mod.rs:587-604 (抜粋)"
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
```

**`None` なら初期化し、期待と違うバリアントなら `unreachable!`。** 命令が自分の状態を取り出すたびにこの検査が走る。前の命令が状態を片付け忘れていたら、その場で落ちる。[「壊れたデータを返すくらいなら落ちろ」](../architecture/) の適用例だ。

### `ProgramExecutionState` は文全体の段階

```rust title="core/vdbe/mod.rs:468-482"
pub enum ProgramExecutionState {
    /// No steps of the program was executed
    Init,
    /// Program started execution but didn't reach any terminal state
    Running,
    /// Interrupt requested for the program
    Interrupting,
    /// Terminal state: program interrupted
    Interrupted,
    /// Terminal state: program finished successfully
    Done,
    /// Terminal state: program failed with error
    Failed,
}
```

`Init` だけが特別扱いされる。[クエリの一生のページ](../query-lifecycle/) で見たとおり、再コンパイルは `Init` のときにしか起きない。

`Interrupting` と `Interrupted` が分かれているのは、**中断要求から実際に止まるまでに一区間ある**からだ。

## 処理の流れ (コードを追う)

### `build()` が 3 つのことをする

```rust title="core/vdbe/builder.rs:2248-2266 (抜粋)"
pub fn build_prepared_program(
    mut self,
    prepare_context: PrepareContext,
    change_cnt_on: bool,
    sql: &str,
) -> crate::Result<PreparedProgram> {
    self.resolve_labels()?;

    self.parameters.list.dedup();

    // Mirrors SQLite's: usesStmtJournal = isMultiWrite && mayAbort
    // Statement journals are only needed when a statement writes multiple rows AND could
    // abort midway (e.g. constraint violation). Single-row writes are atomic and don't
    // need statement-level rollback. Both flags default to true; specific translate paths
    // (e.g., single-row INSERT) set is_multi_write=false to opt out.
    let needs_stmt_subtransactions = matches!(self.txn_mode, TransactionMode::Write)
        && self.flags.is_multi_write()
        && self.may_abort();
```

**1. ラベルを解決する。** ここで初めて `BranchOffset` が具体的な命令番号になる。未解決のラベルがあればエラー ([エミッタのページ](../emitter-main-loop/))。

**2. パラメータの重複を除く。** `?1` が式の中で 2 回出てきても、バインドのスロットは 1 つ。

**3. 文レベルのサブトランザクションが要るかを決める。** 3 条件の AND だ。

- 書き込みトランザクションである
- **複数行を書く** (`is_multi_write`)
- **途中で中断しうる** (`may_abort`)

1 行だけの `INSERT` は、失敗しても部分的な変更が残らないので巻き戻しが要らない。両フラグとも既定は `true` で、単一行 `INSERT` のような特定の経路だけが `false` に落とす。

`may_abort()` の実装が興味深い。

```rust title="core/vdbe/builder.rs:294-295 (抜粋)"
/// True once any `Insn::Function` has been emitted. See [`Self::may_abort`].
emitted_function_call: bool,
```

**ユーザ定義関数を 1 つでも呼んでいたら中断しうる**とみなす。関数がエラーを返す可能性があるからだ。

### `ProgramState::new` は 2 つの数だけで確保する

```rust title="core/statement.rs:382-390 (再掲)"
let (max_registers, cursor_count) = match query_mode {
    QueryMode::Normal => (program.max_registers, program.cursor_ref.len()),
    // ...
};
let state = vdbe::ProgramState::new(max_registers, cursor_count);
```

レジスタ数とカーソル数は、コンパイル時に確定している。**実行中に増えない。** `registers` が `Box<[Register]>` で、`cursors` が `Vec<Option<Cursor>>` (長さ固定、中身が `None` から埋まる) なのはそのためだ。

`cursors` が `Option` なのは、**カーソルの番号は確保済みだが、まだ開いていない**状態を表すためだ。`OpenRead` 命令が実行されて初めて `Some` になる。

### トリガのサブプログラムは `ProgramState` をキャッシュする

```rust title="core/vdbe/mod.rs:888-890"
/// Cached subprogram Statements keyed by the PC of the Program instruction.
/// Avoids re-allocating ProgramState on each trigger/FK-action fire.
pub(crate) subprogram_stmt_cache: HashMap<usize, Box<Statement>>,
```

1000 行に `UPDATE` をかけると、行ごとにトリガが発火する。毎回 `ProgramState` を確保し直すと、レジスタ配列の割り当てが 1000 回走る。**`Insn::Program` の pc をキーにしてキャッシュする。**

親の `ProgramState` が子の `Statement` を丸ごと持つ形になっていて、[クエリの一生のページ](../query-lifecycle/) で見た `step_subprogram()` がこれを回す。

## 守られている不変条件

**`PreparedProgram` は実行中に変わらない。** `Arc` で共有され、`&` でしか触られない。例外は `needs_stmt_subtransactions: Arc<AtomicBool>` の 1 つだけ。

**レジスタ数とカーソル数はコンパイル時に確定する。** 実行中に増えない。

**`ActiveOpState` は同時に 1 つ。** 違うバリアントを取り出そうとしたら `unreachable!`。

**コンパイルに影響する接続設定を変えたら、世代を上げる。** 上げ忘れると古いプログラムが走り続ける。

**`Init` 状態でのみ再コンパイルする。** 走り始めた文の `ProgramState` に新しい `Program` を当てない。

## つまずきどころ / 設計の含み

### 唯一の可変フィールドがある

```rust title="core/vdbe/mod.rs:1612-1615 (抜粋)"
/// Whether the statement needs to be wrapped in a statement subtransaction
/// when run as part of an interactive (non-autocommit) transaction.
pub needs_stmt_subtransactions: Arc<AtomicBool>,
```

`PreparedProgram` の中で、これだけが `Arc<AtomicBool>` になっている。他は全部不変だ。

`Arc` の中に `Arc<AtomicBool>` があるということは、**`PreparedProgram` を共有する複数の `Program` が、この 1 ビットを共有する**ということだ。コンパイル時に決めた値を実行時に変えられる、というエスケープハッチが 1 つだけ開いている。

読むときは、「`PreparedProgram` は不変」という理解にこの 1 つの例外があることを覚えておくとよい。

### `ProgramState` の肥大が示していること

40 以上のフィールドのうち、10 個以上が「特定の 1 機能のため」のものだ。

```rust title="core/vdbe/mod.rs:825-847 (抜粋)"
pub sequence_inner_commit: Option<StateMachine<Box<MvccCommitStateMachine>>>,
pub sequence_inner_tx_pending: Option<SequenceInnerTxState>,
pub sequence_inner_retry_count: u32,
```

`CREATE SEQUENCE` のための 3 フィールドがある。コメントに、なぜレジスタではなくここに置くかが書いてある。

```rust title="core/vdbe/mod.rs:829-836 (抜粋)"
/// Tracked here (rather than in registers) so that statement
/// reset can roll back an orphaned inner tx and restore the
/// connection's mv_tx — registers are wiped on reset, but the
/// orphaned inner would otherwise linger in `mv_store.txs` and
/// pollute the connection's mv_tx slot, breaking subsequent
/// commits with phantom dependencies.
```

**「`reset()` で消えては困るもの」はレジスタに置けない。** レジスタは reset で全部消えるが、`ProgramState` のフィールドは reset の処理から個別に見える。

つまり `ProgramState` のフィールドは、**「reset のときに後始末が必要なもの」の一覧**でもある。`auto_txn_cleanup`、`attached_savepoint_pagers`、`ephemeral_temp_files`、`closed_index_method_cursors` — どれも「文が途中で捨てられたときに何かしなければならない」ものだ。

VM の状態というより、**文の生存期間に紐づく資源の管理台帳**になっている。機能を足すたびにここが太るのは避けにくい。

### `halt_in_progress` が示す割り込みの難しさ

```rust title="core/vdbe/mod.rs:874-880 (抜粋)"
/// True once the Halt opcode has started finishing the statement. The
/// statement's outcome is decided at that point, so an interrupt request
/// arriving during Halt's resumable work (staging index-method writes,
/// committing the rows FAIL keeps) must not preempt it — it would replace
/// the promised outcome and drop staged work.
pub(crate) halt_in_progress: bool,
```

**`Halt` 自体が I/O 待ちで中断しうる。** そのあいだに `sqlite3_interrupt()` 相当の要求が来ると、確定したはずの結果が中断に置き換わってしまう。

同期的に走る VM ならこの問題は起きない。「終了処理も再開可能である」という Turso の前提が、**「終了処理中は割り込みを受け付けない」という追加のフラグ**を要求している。

同じ趣旨のフラグが `pending_fail_error` と `pending_fail_prepare_error` にもある。

```rust title="core/vdbe/mod.rs:870-872 (抜粋)"
/// FAIL can escape a trigger before the parent reaches its Halt opcode.
/// Keep the error here while index-method writes from earlier rows finish
/// through the normal resumable I/O path.
```

**エラーが起きても、すぐには返せない。** 前の行の書き込みがまだ I/O 待ちで残っているかもしれないからだ。エラーを保持しておいて、全部片付いてから返す。

`async` を使わずに全部を状態機械にした結果、**「エラーの伝播」すら状態を持つ**ことになっている。
