---
title: "1 プロセスの中の並行は、2 種類のロックと busy handler で捌く"
description: "待てないときに何をするか、というのがこの層の主題だ。`Busy` は WAL の奥から VDBE を通って `Statement` まで上がってきて、そこで busy handler が「もう一度やるか、諦めるか」を決める。エンジンは自分で眠らないので、待ち時間は `StepResult::Sleep { duration }` として呼び出し元に返される。遅延スケジュールは 12 段の配列で、SQLite の実装をそのまま写している。"
group: "並行性の層"
sidebar:
  order: 21
---

## この層の責務

同じプロセスで同じファイルを開いた接続が複数あるとき、調停する必要がある。

サーバ型の RDB なら、待たせるのは簡単だ。その接続のスレッドをブロックすればいい。**Turso にはブロックしていいスレッドがない** — `step()` を呼んでいるのはアプリケーションのスレッドだ。

だからこの層の設計は、「ロックの取り方」よりも**「取れなかったときにどう帰るか」**が中心になる。

ロックの実体 (`TursoRwLock` のビット詰め、read mark の 5 スロット) は [WAL のページ](../wal/) が、状態の置き場所は [状態の地図のページ](../shared-state-map/) が扱っている。ここでは**待ちの伝わり方**を追う。

## 主要な型とその関係

### ロックは 4 種類ある

[状態の地図のページ](../shared-state-map/) で見た `WalSharedRuntime` に、全部並んでいる。

```rust title="core/storage/wal.rs:2823-2846 (抜粋)"
/// Read locks advertise the maximum WAL frame a reader may access.
/// Slot 0 is special, when it is held (shared) the reader bypasses the WAL and uses the main DB file.
/// When checkpointing, we must acquire the exclusive read lock 0 to ensure that no readers read
/// from a partially checkpointed db file.
/// Slots 1‑4 carry a frame‑number in value and may be shared by many readers. Slot 1 is the
/// default read lock and is to contain the max_frame in WAL.
pub read_locks: [TursoRwLock; 5],
/// Lock used by in-place VACUUM to keep new read/write transactions out
/// while VACUUM is in progress.
/// Normal WAL transactions hold this shared for the lifetime of their
/// transaction. VACUUM holds it exclusively until its final truncate
/// checkpoint has completed.
pub vacuum_lock: TursoRwLock,
/// There is only one write allowed in WAL mode. This lock takes care of ensuring there is only
/// one used.
pub write_lock: TursoRwLock,
/// Serialises checkpointer threads, only one checkpoint can be in flight at any time. Blocking and exclusive only
pub checkpoint_lock: TursoRwLock,
```

| ロック             | 共有 / 排他               | 誰が取るか                   |
| ------------------ | ------------------------- | ---------------------------- |
| `read_locks[0..5]` | 共有 (スロット単位)       | 読み手が 1 つ選んで取る      |
| `write_lock`       | 排他のみ                  | 書き手 (WAL では常に 1 人)   |
| `checkpoint_lock`  | 排他のみ                  | チェックポイントを走らせる者 |
| `vacuum_lock`      | 通常は共有、VACUUM が排他 | 全トランザクション           |

**`vacuum_lock` の使い方が変わっている。** 普通のトランザクションが「共有」で持ち、VACUUM だけが「排他」で取る。読み書きの区別ではなく、**「VACUUM とそれ以外」という 1 軸のためだけに用意されたロック**だ。

これらは全部 `TursoRwLock`、つまり `AtomicU64` 1 個だ。取得は必ず try で、待たない。**待つ判断は上の層がする。**

### busy handler は 3 種類

```rust title="core/busy.rs:19-30"
#[derive(Default)]
/// Represents the busy handler configuration for a connection.
pub enum BusyHandler {
    #[default]
    /// No busy handler: return SQLITE_BUSY immediately on lock contention.
    None,
    /// Default timeout-based handler (implements sqliteDefaultBusyCallback)
    /// The duration is the maximum total time to wait before giving up
    Timeout(Duration),
    /// Custom user-defined callback handler
    Custom { callback: BusyHandlerCallback },
}
```

**既定は `None` — 競合したら即座に `SQLITE_BUSY`。** `PRAGMA busy_timeout` を設定すると `Timeout` になる。

コールバックの契約は SQLite の仕様をそのまま引き継いでいる。

```rust title="core/busy.rs:4-17"
/// Type alias for busy handler callback function.
///
/// The callback receives:
/// - `count`: The number of times the busy handler has been invoked for the same locking event
///
/// Returns:
/// - `0` to stop retrying and return SQLITE_BUSY to the application.
/// - Non-zero to retry the database access.
///
/// # Safety Notes (per SQLite spec)
/// - The callback MUST NOT modify the database connection that invoked it.
/// - The callback MUST NOT close the connection or any prepared statement.
/// - The callback is NOT reentrant.
pub type BusyHandlerCallback = Box<dyn Fn(i32) -> i32 + Send + Sync>;
```

**「呼び出し元の接続を触るな」** — 再入すると `ProgramState` が壊れる。SQLite でも同じ制約だが、Turso では [状態の地図のページ](../shared-state-map/) で見た「接続は同時に 1 文」という前提に直結する。

### `BusyHandlerState` が「待ちの作法」を持つ

```rust title="core/busy.rs:41-58"
/// Tracks the state of busy handler invocations for a statement.
///
/// This implements a yield-based busy handling mechanism that integrates with
/// the async event loop. Instead of blocking with `thread::sleep`, the statement
/// yields back to the caller with `StepResult::Sleep { duration }`. When `step()`
/// is called again after the timeout has passed, it retries the operation.
///
/// Uses increasing delays. After 12 iterations, continues with 100ms delays until max duration is reached.
#[derive(Debug)]
pub struct BusyHandlerState {
    /// Number of times the busy handler has been invoked for this locking event
    invocation_count: i32,
    /// For timeout-based handlers: the next timeout instant to wait until
    timeout: MonotonicInstant,
    /// For timeout-based handlers: the current iteration index into DELAYS
    iteration: usize,
}
```

**`thread::sleep` の代わりに `StepResult::Sleep { duration }` を返す**、とコメントが明示している。これがこのページの核心だ。

## 処理の流れ (コードを追う)

### `Busy` は 4 層を上がってくる

```text
WalFile::begin_write_tx
  └ coordination.try_begin_write_tx() が false
     → Err(LimboError::Busy)
op_transaction
  → そのまま伝播
Program::step
  → Ok(StepResult::Busy)          ([step のページ](../step-loop/))
Statement::_step
  → busy handler を呼ぶ
     ├ 「もう一度」 → Ok(StepResult::Sleep { duration })
     └ 「諦める」   → Ok(StepResult::Busy)
呼び出し元
  → duration だけ待って step() をもう一度、または Busy をアプリへ
```

**`Busy` を作るのは最下層、`Sleep` に変えるのは上から 2 番目、実際に待つのは一番上。** 責務が 3 つに割れている。

`Statement::_step` の該当箇所はこうなっている ([クエリの一生のページ](../query-lifecycle/) で見たものの続き)。

```rust title="core/statement.rs:600-612"
if let Some(busy_state) = self.busy_handler_state.as_ref() {
    let now = self.pager.io.current_time_monotonic();
    if now < busy_state.timeout() {
        // The timeout has not been reached yet: ask the caller to wait
        // out the remaining delay before stepping again.
        if let Some(waker) = waker {
            waker.wake_by_ref();
        }
        return Ok(StepResult::Sleep {
            duration: busy_state.get_delay(now),
        });
    }
}
```

**`step()` の入口で「まだ待ち時間が残っているか」を見る。** 残っていれば実行に入らず、残り時間を返す。

呼び出し元が `duration` を無視してすぐ呼び直しても壊れない — もう一度同じ判定に来て、また `Sleep` が返るだけだ。`StepResult` の doc コメントが「時間を追跡しない呼び出し元は `IO` と同じように扱ってよい」と書いているのはこのためだ。

### 遅延スケジュールは 12 段の配列

```rust title="core/busy.rs:61-88"
/// Delay schedule for timeout-based busy handler (sqliteDefaultBusyCallback)
const DELAYS: [Duration; 12] = [
    Duration::from_millis(1),
    Duration::from_millis(2),
    Duration::from_millis(5),
    Duration::from_millis(10),
    Duration::from_millis(15),
    Duration::from_millis(20),
    Duration::from_millis(25),
    Duration::from_millis(25),
    Duration::from_millis(25),
    Duration::from_millis(50),
    Duration::from_millis(50),
    Duration::from_millis(100),
];

/// Cumulative totals for each iteration (for calculating remaining time)
const TOTALS: [Duration; 12] = [
    Duration::from_millis(0),
    Duration::from_millis(1),
    Duration::from_millis(3),
    Duration::from_millis(8),
    // ...
];
```

**累積和の配列を別に持っている。** 毎回足し直さずに「これまで何ミリ秒待ったか」を引ける。

```rust title="core/busy.rs:145-166"
fn invoke_timeout_handler(&mut self, max_duration: Duration, now: MonotonicInstant) -> bool {
    let idx = self.iteration.min(11);
    let mut delay = Self::DELAYS[idx];
    let mut prior = Self::TOTALS[idx];

    // After 12 iterations, each additional iteration adds 100ms
    if self.iteration >= 12 {
        prior += delay * (self.iteration as u32 - 11);
    }

    // Check if we've exceeded or would exceed the max duration
    if prior + delay > max_duration {
        delay = max_duration.saturating_sub(prior);
        if delay.is_zero() {
            return false;
        }
    }

    self.iteration = self.iteration.saturating_add(1);
    self.invocation_count += 1;
    self.timeout = now + delay;
    true
}
```

**13 回目以降は 100 ms 固定。** そして `busy_timeout` の残り時間が次の遅延より短ければ、残り時間だけ待つ。ちょうど使い切ったら `false` を返して諦める。

`sqliteDefaultBusyCallback` の移植で、**1 ms から始めて 228 ms までが 12 段、以降は 100 ms 刻み**という形になる。

### `WAL` 層は独自にリトライする

busy handler とは別に、WAL の内部にもリトライがある ([WAL のページ](../wal-and-checkpoint/))。

```rust title="core/storage/wal.rs:3325-3340 (抜粋)"
TryBeginReadResult::Retry => {
    cnt += 1;
    if cnt > 100 {
        return Err(LimboError::Busy);
    }
    // Progressive backoff: first 5 retries are immediate, then we
    // start yielding/sleeping with increasing delays.
    if cnt > 5 {
        if cnt < 10 {
            self.io.yield_now();
        } else {
            let delay_us = ((cnt - 9) * (cnt - 9) * 39) as u64;
            self.io.sleep(std::time::Duration::from_micros(delay_us));
        }
    }
    continue;
}
```

**2 段のリトライがある。** 内側 (WAL) はマイクロ秒単位で 100 回まで、外側 (busy handler) はミリ秒単位で `busy_timeout` まで。

区別の根拠は競合の性質だ。`Retry` はアトミック更新の失敗なので、数ナノ秒で解消する。`Busy` は他のトランザクションが終わるまで解消しない。**「すぐ直る競合」と「相手の仕事が終わるまで直らない競合」で待ち方を変えている。**

### 同一接続の 2 人目は `Busy` にしない

```rust title="core/vdbe/execute.rs:4264-4279 (抜粋)"
// One connection may have many active readers, but only one
// top-level writer. A second writer on the same connection is
// rejected before it opens transaction or savepoint state.
//
// This is stricter than SQLite. ...
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

**`Busy` ではなく `StatementsInProgress` を返す。**

`Busy` にすると busy handler がリトライしてしまう。だが相手は同じ接続の別の文で、**その文を進められるのは自分と同じスレッドだ**。待っても永遠に解消しない。

だから別のエラーにして、リトライの梯子に乗せない。[トランザクション境界のページ](../transaction-boundary/) で見た「SQLite より厳しい制限」の帰結でもある。

同じ構造が `BusySnapshot` にもある ([WAL のページ](../wal-and-checkpoint/))。**「リトライで直るか」でエラーを分けるのが、この層の一貫した方針**になっている。

| エラー                 | リトライで直るか           | 誰が受ける       |
| ---------------------- | -------------------------- | ---------------- |
| `Retry` (WAL 内部)     | すぐ直る                   | WAL のループ     |
| `Busy`                 | 相手次第で直る             | busy handler     |
| `BusySnapshot`         | **読みからやり直せば**直る | VDBE の分岐      |
| `StatementsInProgress` | 直らない                   | アプリケーション |

## 守られている不変条件

**ロックの取得は必ず try。エンジンは自分でブロックしない。**

**待ち時間は `StepResult::Sleep` として呼び出し元に返す。**

**busy handler のコールバックは呼び出し元の接続を触らない。**

**リトライで直らない競合は `Busy` にしない。** 別のエラー型にして梯子に乗せない。

**書き込みロックは WAL に 1 つ。** チェックポイントも VACUUM も専用ロックで直列化される。

## つまずきどころ / 設計の含み

### `Sleep` を無視しても正しく動く

`StepResult::Sleep { duration }` の doc がそう明言している。

```rust title="core/vdbe/mod.rs:186-191"
/// The statement asks the caller to wait for `duration` before stepping again,
/// e.g. because a busy handler decided to retry after a delay. Callers that don't
/// track time may treat this exactly like `IO`: drive the event loop and step again.
Sleep {
    duration: std::time::Duration,
},
```

**待たずに呼び直すとビジーループになるが、壊れはしない。** バインディングを書く側の負担を下げるための設計で、実際 `run_ignore_rows` は `Sleep` を `IO` と同じ扱いにしている ([クエリの一生のページ](../query-lifecycle/))。

```rust title="core/statement.rs:749-751 (抜粋)"
vdbe::StepResult::IO | vdbe::StepResult::Yield | vdbe::StepResult::Sleep { .. } => {
    self.pager.io.step()?
}
```

`io.step()` を呼ぶので完全なビジーループにはならないが、**遅延スケジュールは事実上効かない**。時間を扱える呼び出し元だけが恩恵を受ける。

### 待ち時間の判定が `step()` の入口にある意味

busy handler を呼ぶのは「`Busy` が返ったとき」だが、待ち時間が過ぎたかを見るのは「次の `step()` の入口」だ。この 2 つが離れている。

その結果、**`Statement` を放置して 10 秒後に `step()` すると、待ち時間はとっくに過ぎているので即座に再試行される**。「待った」のではなく「待ち時間が経過していた」だけだ。

同期的な `sleep` なら起きえない挙動で、**時間の管理を呼び出し元に委ねたことの副作用**になっている。実害はほぼないが、`busy_timeout` の総待ち時間が壁時計と一致しない場合がある。

### `checkpoint_lock` だけ「blocking and exclusive only」

```rust title="core/storage/wal.rs:2839-2840"
/// Serialises checkpointer threads, only one checkpoint can be in flight at any time. Blocking and exclusive only
pub checkpoint_lock: TursoRwLock,
```

コメントに「blocking」とある。他のロックが try 一辺倒なのに対し、ここだけブロックする使い方を想定している。

チェックポイントは「今すぐでなくてよい」作業なので、**取れなければ諦めて次の機会に回す**のが自然だ。実際、自動チェックポイントは失敗しても無視される ([トランザクション境界のページ](../transaction-boundary/) の `cleanup_after_auto_checkpoint_failure`)。

明示的な `PRAGMA wal_checkpoint` は待つ必要があるので、その場合だけブロックする。**同じロックを 2 通りの使い方で共有している**ため、コメントに但し書きが必要になっている。

### `read_locks[0]` だけ意味が違う

```rust title="core/storage/wal.rs:2824-2826 (抜粋)"
/// Slot 0 is special, when it is held (shared) the reader bypasses the WAL and uses the main DB file.
/// When checkpointing, we must acquire the exclusive read lock 0 to ensure that no readers read
/// from a partially checkpointed db file.
```

スロット 0 は「WAL を一切見ない読み手」を表す。WAL が全部転記済みなら、読み手は本体ファイルだけを見ればいい。

そしてチェックポイントは**スロット 0 を排他で取る**。転記の途中の本体ファイルを誰にも読ませないためだ。

**同じ配列の 0 番だけが「共有で持つと読み手、排他で持つとチェックポインタ」という別の意味を持つ。** SQLite から引き継いだ設計で、[WAL のページ](../wal/) のスロット選択アルゴリズムを読むときの前提になる。
