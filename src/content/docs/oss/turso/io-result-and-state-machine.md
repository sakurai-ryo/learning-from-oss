---
title: "再開の状態を、誰が、どんな形で持っているか"
description: "I/O 待ちで呼び出し元に帰るなら、途中経過をどこかに置いて帰らなければならない。core には `enum *State` が 114 個ある。だが正式な `StateTransition` trait を実装しているのは 5 つだけで、全部 MVCC のものだ。残りは各モジュールがローカルに同じ形を書き直している。置き場所は「その操作の主体」で決まり、その規則が並行性の制約にそのまま化ける。"
group: "エンジンの骨格"
sidebar:
  order: 5
---

## この層の責務

`IOResult<T>` を返して呼び出し元に帰るということは、**途中経過をどこかに置いて帰る**ということだ。`async fn` なら、コンパイラが生成した Future の中に自動的に置かれる。Turso にはそれがないので、置き場所を人間が決める。

型そのものの説明 — `IOResult`、`return_if_io!`、複数完了の束ね方 — は [`IOResult` のページ](../io-result/) が扱っている。このページが扱うのはその先だ。

- 状態は**どこに**置かれるのか
- 置き方の**流儀は何種類**あるのか
- 1 回の `step()` で状態機械は**何段積まれる**のか

ここを押さえておくと、「この状態を同時に 2 人が触ることはあるか」という問いに、毎回コードを追わずに答えられるようになる。

## 主要な型とその関係

### 流儀は 2 つある。使われている数が桁違いに違う

**流儀 A: `StateTransition` trait を実装する。** [`core/state_machine.rs`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/state_machine.rs) にある正式な器だ。

```rust title="core/state_machine.rs"
pub enum TransitionResult<Result> {
    Io(IOCompletions),
    Continue,
    Done(Result),
}

pub trait StateTransition {
    type Context;
    type SMResult;

    fn step(&mut self, context: &Self::Context) -> Result<TransitionResult<Self::SMResult>>;
    fn finalize(&mut self, context: &Self::Context) -> Result<()>;
    fn is_finalized(&self) -> bool;
}
```

`StateMachine<State>` がこれを包み、`Continue` の間はループし、`Io` で `IOResult::IO` を返して帰る。

**流儀 B: `enum` を定義して、駆動ループを手で書く。**

数を数えると差が歴然としている。

```console
$ grep -rEn "^(pub |pub\(crate\) )?enum [A-Za-z]+State" core/ --include='*.rs' | grep -v tests | wc -l
114
```

そのうち `StateTransition` を実装している型は 5 つしかない。

| 実装型                                       | 場所                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| `CommitStateMachine<Clock, A>`               | `core/mvcc/database/mod.rs:2755`                      |
| `WriteRowStateMachine`                       | `core/mvcc/database/mod.rs:3421`                      |
| `DeleteRowStateMachine`                      | `core/mvcc/database/mod.rs:3542`                      |
| `CheckpointStateMachine<Clock, A>`           | `core/mvcc/database/checkpoint_state_machine.rs:3020` |
| `BuildLocalSchemaViewStateMachine<Clock, A>` | `core/mvcc/database/checkpoint_state_machine.rs:3154` |

**5 つとも `core/mvcc/` の中にある。** B-tree も Pager も WAL も VDBE も、この trait を使っていない。正式な抽象があるのに、それを使っているのは一番新しいサブシステムだけ、という状態になっている。

### 流儀 B の実物

Pager のキャッシュフラッシュを見ると、trait を使わずに同じことをしているのが分かる。

```rust title="core/storage/pager.rs:3538-3554"
loop {
    let phase = std::mem::take(&mut *self.cacheflush_state.write());

    match self.cacheflush_step(wal, page_sz, phase)? {
        CacheFlushStep::Yield(next_phase, io) => {
            *self.cacheflush_state.write() = next_phase;
            return Ok(IOResult::IO(io));
        }
        CacheFlushStep::Continue(next_phase) => {
            *self.cacheflush_state.write() = next_phase;
        }
        CacheFlushStep::Done(completions) => {
            *self.cacheflush_state.write() = CacheFlushState::Init;
            return Ok(IOResult::Done(completions));
        }
    }
}
```

`CacheFlushStep::{Yield, Continue, Done}` は、`TransitionResult::{Io, Continue, Done}` と同じ 3 値だ。`StateMachine::step` のループと構造も同じ。**trait を使わずに、同じ形をローカルに書き直している。**

違いが 1 つある。`std::mem::take` で状態を**取り出してから**遷移関数に渡し、戻ってきた新しい状態を書き戻す。状態が `Vec<usize>` や `PageRef` を所有しているので、参照で渡すと借用検査に引っかかる。

```rust title="core/storage/pager.rs:1610-1628"
pub enum CacheFlushState {
    #[default]
    Init,
    WalPrepareStart { dirty_ids: Vec<usize>, completion: Completion },
    WalPrepareFinish { dirty_ids: Vec<usize>, completion: Completion },
    Collecting(CollectingState),
    WaitingForRead { state: CollectingState, page_id: usize, page: PageRef, completion: Completion },
}
```

**状態が「次にやること」だけでなく「そのために必要なデータ」を全部抱えている。** `dirty_ids` は `Init` で集めたものを最後まで持ち回る。`async fn` のローカル変数が Future の中に取り込まれるのと同じことを、手で書いている。

この「取り出して、書き戻す」が抜けると再入バグになる。その失敗の型は [再入のページ](../reentrancy/) が扱っている。

### 状態が単純な場合は enum が 2 値しかない

全部が `CacheFlushState` のように重いわけではない。B-tree のカーソル操作は 2 値のものが並んでいる。

```rust title="core/storage/state_machines.rs:10-31"
pub enum MoveToRightState { Start, ProcessPage }

pub enum SeekToLastState { Start, IsEmpty }

pub enum RewindState { Start, NextRecord }

pub enum AdvanceState { Start, Advance }
```

`Start` と「I/O から戻ってきた後」の 2 つだけ。**「ページを 1 枚読む」を挟む操作は、必ずこの形になる。** これらが `Copy` なのも、抱えているデータがないからだ。

一方、状態にコメントで再入の注意が書かれているものもある。

```rust title="core/storage/state_machines.rs:34-45"
pub enum CountState {
    Start,
    Loop,
    /// Resume state used after `CountState::Loop` yielded for spill IO
    /// mid-descent. The loop-top `stack.advance()` and `self.count +=
    /// cell_count()` mutations have already been applied for this step,
    /// so on re-entry we retry only the read + (second-)advance + push,
    /// then transition back to `Loop`.
    Descend { target: i64 },
    Finish,
}
```

`Descend` は「`Loop` の途中で yield したときに戻ってくる場所」だ。`Loop` に戻すと `stack.advance()` と `count +=` がもう一度走ってしまうので、**その 2 つを飛ばした版の入口**を別の状態として作ってある。

## 処理の流れ (コードを追う)

### 状態は「その操作の主体」に置かれる

置き場所には規則がある。

| 操作の単位        | 状態の置き場所                 | 例                                                                                                                                              |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 文 (statement)    | `ProgramState` のフィールド    | `pc`, `CommitState`, `ActiveOpState`                                                                                                            |
| カーソル          | `BTreeCursor` のフィールド     | `CursorState`, `CursorSeekState`, `CursorValidState`                                                                                            |
| ページャ (= 接続) | `Pager` の `RwLock<...>`       | `CacheFlushState`, `SpillState`, `AllocatePageState`, `FreePageState`, `CheckpointState`, `HeaderRefState`, `VacuumState`, `AllocatePage1State` |
| WAL               | `WalFile` の内部               | `CheckpointState`                                                                                                                               |
| 接続              | `Connection` の `RwLock<...>`  | `ReparseSchemaState`, `AttachDatabaseState`                                                                                                     |
| データベース      | 引数で渡す一時的な `InitState` | `Database::_init_nonblock`                                                                                                                      |

`Pager` に 8 個も `RwLock<...State>` が並んでいるのは壮観だが、これは**「Pager 単位の操作は同時に 1 つ」という前提**の表明でもある。`RwLock` は借用検査を通すためのもので、競合を捌くためのものではない。

その前提はコードのコメントに書かれている。

```rust title="core/storage/pager.rs:1416-1422"
/// # Safety
/// Dereferencing requires that no other reference to the referent cursor
/// is live at the same time. The registry Mutex serializes registry
/// mutation but not access to the cursors themselves; that exclusion comes
/// from the execution model — a Connection runs one statement at a time,
/// and a statement's cursors are touched only by its executor thread.
```

**「接続は一度に 1 文しか走らせない」**。これが Turso の並行性の基礎になっている前提だ。`Pager` は接続ごとに 1 つなので ([起動のページ](../boot-and-wiring/))、Pager 上の状態機械も同時に 1 つしか動かない。

だから `Connection` は同時に 2 つの `Statement` を `step()` できない。ライブラリの利用者から見ると「同じ接続を 2 スレッドで共有するな」という当たり前の制約だが、その根拠はこの状態の置き方にある。

### 1 回の `step()` で状態機械は何段積まれるか

`INSERT` を 1 行実行するとき、`step()` の中で状態が積み上がる。

```text
Statement::_step
 └ Program::step                    … ProgramState.pc, ActiveOpState
    └ op_insert
       └ BTreeCursor::insert        … CursorState::Write(WriteState)
          ├ fill_cell_payload       … FillCellPayloadState
          ├ balance                 … BalanceSubState
          └ Pager::read_page        … (キャッシュミスなら I/O)
             └ Wal::read_frame
```

I/O が必要になると、**この全段が `IOResult::IO` を返して一気に巻き戻る**。呼び出し元は `io.step()` で完了を待ち、もう一度 `Statement::step()` を呼ぶ。すると `pc` は同じ命令を指しており、`CursorState::Write(WriteState::Balancing)` から再開する。

各段が自分の状態を自分の場所に置いているから、この巻き戻しと再開が成立する。**スタックには何も残せない**ので、残したいものは全部どこかの構造体のフィールドになる。

`ActiveOpState` の存在が象徴的だ。`ProgramState` は「今どの命令を実行中で、その命令のどこまで進んだか」を持っている。命令 1 個の実行が、それ自体で中断・再開可能な単位になっている。

### MVCC だけが trait を使う理由

MVCC のコミットは、状態機械が状態機械を持つ形になっている。

```rust title="core/mvcc/database/checkpoint_state_machine.rs:195-248 (抜粋)"
pub struct CheckpointStateMachine<Clock: LogicalClock, A: ConcurrentAllocator = TursoAllocator> {
    // ...
    write_row_state_machine: Option<StateMachine<WriteRowStateMachine>>,
    delete_row_state_machine: Option<StateMachine<DeleteRowStateMachine>>,
    // ...
    build_local_schema_sm: Option<StateMachine<BuildLocalSchemaViewStateMachine<Clock, A>>>,
}
```

**子の状態機械を `Option<StateMachine<..>>` として持ち、自分の `step` の中で子の `step` を呼ぶ。** 子が `IOResult::IO` を返したら自分も返す。子が `Done` になったら `None` に戻して次の状態へ進む。

この合成は `StateMachine<T>` という共通の器があるから書ける。流儀 B の手書きループでは、子ごとに違う `XxxStep` enum を扱うことになり、合成のたびに別の接続コードが要る。

そして `VDBE` は、MVCC のコミット状態機械を自分の状態に埋め込んでいる。

```rust title="core/vdbe/mod.rs:202-214 (抜粋)"
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

**流儀 B の enum の中に、流儀 A の `StateMachine` が入っている。** 2 つの流儀の境界がここに出ている。

## 守られている不変条件

**`StateMachine` は finalize したら二度と step されない。**

```rust title="core/state_machine.rs (StateMachine::step 抜粋)"
loop {
    if self.is_finalized {
        unreachable!("StateMachine::transition: state machine is finalized");
    }
    match self.state.step(context)? {
        // ...
        TransitionResult::Done(result) => {
            assert!(self.state.is_finalized());
            self.is_finalized = true;
            return Ok(IOResult::Done(result));
        }
    }
}
```

`Done` を返すときに `self.state.is_finalized()` を `assert!` している。**「終わった」と言う前に後始末が済んでいることを、器の側が確認する。**

**流儀 B では、`Done` に到達した駆動ループが状態を初期値に戻す。** `cacheflush` は `CacheFlushState::Init` を書き戻してから返る。これを忘れると、次回の呼び出しが前回の終了状態から始まってしまう。

**状態の所有者は 1 人。** `Pager` の状態機械は Pager を持つ接続だけが、カーソルの状態機械はその文だけが触る。`RwLock` はあるが、それは競合の調停ではなく `&self` から可変参照を取るための手段でしかない。

## つまずきどころ / 設計の含み

### 正式な抽象があっても、既存コードは移行していない

114 個の `enum *State` に対して `StateTransition` の実装が 5 つ、というのは、リファクタリングが完了していないというより、**新しい部分にだけ新しい規約が適用されている**状態だ。

読む側への含みは 2 つある。

第 1 に、`core/state_machine.rs` を読んで「これがこのコードベースの状態機械の書き方だ」と思うと、B-tree や Pager を読むときに面食らう。そこには `StateTransition` は出てこない。

第 2 に、**流儀 B のコードでは、状態機械の境界がシグネチャに出ない**。`fn cacheflush(&self) -> Result<IOResult<Vec<Completion>>>` を見ても、これが 5 状態の状態機械だとは分からない。`IOResult` を返すことだけが手掛かりになる。だから「`IOResult` を返す関数は再入する」という読み方が、このコードベースでは必須の作法になる。

### `mem::take` の書き戻し漏れは静かに壊れる

```rust
let phase = std::mem::take(&mut *self.cacheflush_state.write());
```

`take` した後、どの分岐でも必ず書き戻さないと、状態は `Default` (= `Init`) のままになる。`?` で早期リターンする経路が 1 本でもあると、そこで状態が消える。上の `cacheflush` は `cacheflush_step` の `?` がまさにそれで、**エラー時には状態が `Init` に落ちる**。エラーからの再開を諦めている、と読むのが正しい。

流儀 A では `StateMachine` が状態を所有しているので、この漏れは起きない。trait を使う実利はここにある。

### 状態の数がそのまま「再開ポイントの数」になる

`enum` のバリアント数は、その操作が I/O で中断されうる箇所の数とほぼ一致する。`CacheFlushState` が 5 つあるということは、キャッシュフラッシュは 5 箇所で中断されうるということだ。

テストの側から見ると、**この 5 箇所全部を通す必要がある**。毎回必ず yield する I/O バックエンドを用意して、全経路を強制的に踏ませるという手法 ([該当ページ](../memory-yield-io/)) は、この数え方が前提になっている。

### 状態にコメントが付いているところが、過去のバグの場所

`CountState::Descend` や `OverflowState::ReadNext` のように、**なぜこの状態が必要かを説明するコメントが付いている状態**がある。

```rust title="core/storage/btree.rs:536-548 (抜粋)"
enum OverflowState {
    Start,
    ProcessPage { next_page: PageRef },
    /// Transitional state used to make `OverflowState::ProcessPage`
    /// re-entry-safe across yields. Once `free_page` has returned `Done` for
    /// the current page, we move to this state before validating or reading
    /// the next page so `free_page` cannot be invoked a second time on a page
    /// that is already in the freelist.
    ReadNext { next: u32 },
    Done,
}
```

「同じページを 2 回 freelist に入れる」を防ぐためだけの中間状態だ。**状態機械のバリアントが 1 つ増えているところには、たいてい再入バグの修正が埋まっている。** コードを読むときの目印になる。
