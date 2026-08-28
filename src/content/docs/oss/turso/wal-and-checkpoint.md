---
title: "WAL のフレーム、インデックス、read mark、そして checkpoint"
description: "WAL の入口は 2 つの trait でできている。`Wal` が「接続から見た WAL」、`WalCoordination` が「誰と調停するか」で、後者を差し替えるとプロセス内調停とプロセス間調停が入れ替わる。読みトランザクションの開始は SQLite と同じ二次バックオフでリトライし、チェックポイントは読みと書きを別々に in-flight 制限しながら流すパイプラインになっている。"
group: "ページとディスク"
sidebar:
  order: 20
---

## この層の責務

WAL の役割は 3 つある。

1. **追記** — 変更されたページをフレームとして `.wal` の末尾に書く
2. **スナップショット** — 読み手に「ある時点までのフレーム」だけを見せる
3. **転記 (チェックポイント)** — WAL の内容を本体ファイルへ書き戻し、WAL を短くする

フレームの形式、累積チェックサム、read mark の 5 スロット、チェックポイントの 4 モード — **設計そのもの**は [WAL のページ](../wal/) が扱っている。

このページは**制御フロー**を追う。誰がどの順に何を呼ぶか、リトライはどう入るか、チェックポイントの I/O はどう束ねられるか。

## 主要な型とその関係

### trait が 2 段になっている

```rust title="core/storage/wal.rs:621-641 (抜粋)"
pub trait Wal: Debug + Send + Sync {
    /// Begin a read transaction.
    /// Returns whether the database state has changed since the last read transaction.
    fn begin_read_tx(&self) -> Result<bool>;
    /// MVCC helper: check if WAL state changed without starting a read tx.
    fn mvcc_refresh_if_db_changed(&self) -> bool;

    /// Begin a write transaction.
    ///
    /// `allowed_auto_actions` controls which automatic WAL maintenance
    /// actions are permitted within this call ...
    fn begin_write_tx(&self, allowed_auto_actions: WalAutoActions) -> Result<()>;
```

`Pager` が持つのは `Option<Arc<dyn Wal>>` だ ([Pager のページ](../pager-responsibilities/))。`None` になるのは、インメモリ DB と一時テーブル・一時索引のときだ。

そして `WalFile` の中にもう 1 段の trait がある。

```rust title="core/storage/wal.rs:484-520 (抜粋)"
trait WalCoordination: Debug + Send + Sync {
    /// Load the current authoritative WAL snapshot.
    fn load_snapshot(&self) -> WalSnapshot;

    /// Ensure any process-local fallback cache is complete for `snapshot`.
    fn ensure_local_frame_cache_covers(&self, _io: &Arc<dyn IO>, _snapshot: WalSnapshot) -> Result<()> { Ok(()) }

    /// Publish a newly committed WAL state snapshot.
    fn publish_commit(&self, commit: WalCommitState);

    /// Publish the highest frame durably backfilled during checkpoint.
    fn publish_backfill(&self, max_frame: u64);

    /// Find the newest frame for `page_id` within the caller's visible range.
    fn find_frame(&self, page_id: u64, min_frame: u64, max_frame: u64, frame_watermark: Option<u64>) -> Option<u64>;
```

**`Wal` が「何をするか」、`WalCoordination` が「誰と調停するか」。**

この 2 段構えが、マルチプロセス対応を後から差し込めた理由になっている。`WalFile::new` はプロセス内調停の実装を使い、`WalFile::new_with_shared_coordination` は `.tshm` を使う実装を渡す ([起動のページ](../boot-and-wiring/) の `build_wal`)。

**`Wal` trait 側のコードは、どちらの調停でも同じものが走る。** 設計の経緯は [`.tshm` のページ](../shared-wal-tshm/) を参照。

### 接続ごとの `WalFile` と、共有の `WalFileShared`

[状態の地図のページ](../shared-state-map/) で見たとおり、`max_frame` は両方にある。`WalFile` の側はスナップショットで、`WalFileShared` の側が権威だ。

```rust title="core/storage/wal.rs:2689-2694"
/// This is the index to the read_lock in WalFileShared that we are holding. This lock contains
/// the max frame for this connection.
max_frame_read_lock_index: AtomicUsize,
/// Max frame allowed to lookup range=(minframe..max_frame)
max_frame: AtomicU64,
```

`WalFile` は「読みロックのスロット番号」も覚えている。トランザクションを終えるときにこの番号でスロットを解放する。

## 処理の流れ (コードを追う)

### `begin_read_tx` は SQLite のバックオフをそのまま写す

```rust title="core/storage/wal.rs:3310-3344"
fn begin_read_tx(&self) -> Result<bool> {
    // Implement progressive backoff because transient lock contention
    // should resolve quickly, but under heavy contention busy-spinning wastes
    // CPU. SQLite uses quadratic backoff after 5 retries, with total delay
    // up to ~10 seconds before giving up, so we just mirror SQLite's implementation
    // here.
    let mut cnt = 0u32;
    loop {
        match self.try_begin_read_tx() {
            TryBeginReadResult::Ok(changed) => return Ok(changed),
            TryBeginReadResult::Err(err) => return Err(err),
            TryBeginReadResult::Busy => return Err(LimboError::Busy),
            TryBeginReadResult::Retry => {
                cnt += 1;
                if cnt > 100 {
                    return Err(LimboError::Busy);
                }
                // Progressive backoff: first 5 retries are immediate, then we
                // start yielding/sleeping with increasing delays.
                if cnt > 5 {
                    if cnt < 10 {
                        // Retries 6-9: yield to scheduler (minimal delay)
                        self.io.yield_now();
                    } else {
                        // Retries 10+: quadratic backoff in microseconds
                        // Formula matches SQLite: (cnt-9)^2 * 39 microseconds
                        let delay_us = ((cnt - 9) * (cnt - 9) * 39) as u64;
                        self.io.sleep(std::time::Duration::from_micros(delay_us));
                    }
                }
                continue;
            }
        }
    }
}
```

**`Busy` と `Retry` を区別している。** `Busy` は「他人が書き込みロックを持っている」で、リトライしても状況は変わらない。`Retry` は「アトミックな更新に失敗した」で、すぐ再試行すれば通る。

段階は 3 つ。**1〜5 回目は即座、6〜9 回目は `yield_now()`、10 回目以降は `(cnt-9)^2 * 39` マイクロ秒**。定数までコメントで SQLite 由来と断っている。

ここで `self.io.sleep()` を呼んでいる点に注意がいる。[`step` のページ](../step-loop/) で見た「エンジンは自分で眠らない」原則の例外に見えるが、`IO` trait のメソッドなので、実装がテスト用の仮想時計なら実際には眠らない ([決定的シミュレータのページ](../deterministic-simulator/))。

### `begin_write_tx` は読みトランザクションを前提にする

```rust title="core/storage/wal.rs:3375-3390 (抜粋)"
fn begin_write_tx(&self, allowed_auto_actions: WalAutoActions) -> Result<()> {
    let begin_write_result: Result<()> = {
        // sqlite/src/wal.c 3702
        // Cannot start a write transaction without first holding a read
        // transaction.
        turso_assert!(
            self.max_frame_read_lock_index.load(Ordering::Acquire) != NO_LOCK_HELD,
            "must have a read transaction to begin a write transaction"
        );
        turso_assert!(
            !self.holds_write_lock(),
            "write lock already held by this connection"
        );
        if !self.coordination.try_begin_write_tx() {
            return Err(LimboError::Busy);
        }
```

**書き込みは必ず読みの上に乗る。** これも SQLite と同じで、行番号付きで参照されている。

そして、書き込みロックを取った直後に「自分のスナップショットが古くなっていないか」を確認する。

```rust title="core/storage/wal.rs:3394-3401 (抜粋)"
let db_changed =
    self.db_changed_against(self.load_coordination_snapshot(), self.connection_state());
if db_changed {
    // Snapshot is stale, give up and let caller retry from scratch.
    // Return BusySnapshot instead of Busy so the caller knows it must
    // restart the read transaction to get a fresh snapshot.
    // Retrying with busy_timeout will NEVER HELP.
```

**`Busy` と `BusySnapshot` を分ける理由がここにある。**

読みを始めてから書きに昇格するまでの間に、誰かがコミットしていたら、自分のスナップショットは古い。この状態で書くと lost update になる。リトライしても**同じスナップショットのままなので永遠に通らない** — 読みトランザクションからやり直す必要がある。

だから別のエラーにして、上の層に「やり直せ」と伝える。[`step` のページ](../step-loop/) で見た `BusySnapshot` の分岐がこれを受ける。

### 読みは `find_frame` → `read_frame`

```rust title="core/storage/wal.rs:652-664 (抜粋)"
/// Find the latest frame containing a page.
///
/// optional frame_watermark parameter can be passed to force WAL to find frame not larger than watermark value
/// caller must guarantee, that frame_watermark must be greater than last checkpointed frame, otherwise method will panic
fn find_frame(&self, page_id: u64, frame_watermark: Option<u64>) -> Result<Option<u64>>;

/// Read a frame from the WAL.
fn read_frame(&self, frame_id: u64, page: PageRef, buffer_pool: Arc<BufferPool>) -> Result<Completion>;
```

`find_frame` が `None` を返したら、そのページは WAL にないので本体ファイルから読む。

`frame_watermark` は「この番号より新しいフレームは見るな」という指定だ。同期エンジンが「あるフレーム時点のスナップショット」を再現するために使う ([物理/論理同期のページ](../physical-logical-sync/))。

バッチ読みも用意されている。

```rust title="core/storage/wal.rs:666-681 (抜粋)"
/// Read a contiguous run of WAL frames with a single `pread`.
/// For each `i`, `pages[i]` receives the decoded page body of frame
/// `start_frame + i`. This method is a batched version of `read_frame`.
///
/// If `scratch_buf` is `Some`, it is used as the pread destination (must
/// have length exactly `(page_size + WAL_FRAME_HEADER_SIZE) * pages.len()`).
/// Otherwise a fresh temporary buffer is allocated. VACUUM passes a
/// pre-allocated buffer to amortize the ~batch-size allocation across
/// batches.
fn read_frames_batch(&self, start_frame: u64, pages: &[PageRef], buffer_pool: Arc<BufferPool>, scratch_buf: Option<Arc<Buffer>>) -> Result<Completion>;
```

**連続したフレームを 1 回の `pread` で読む。** VACUUM が使う。呼び出し側がバッファを渡せるのは、バッチごとの確保を避けるためだ。

### チェックポイントは 5 状態のパイプライン

```rust title="core/storage/wal.rs:2407-2424"
pub enum CheckpointState {
    Start,
    /// Fsync the WAL before backfilling any frame into the database file.
    /// Under `synchronous=NORMAL` commits do not fsync the WAL, so without
    /// this durability barrier a crash mid-backfill could persist some
    /// backfilled DB pages while recovery drops the unsynced WAL tail,
    /// leaving a torn database that matches no committed prefix.
    SyncWal,
    Processing,
    /// Determine the checkpoint result: update nBackfills, restart log if needed.
    DetermineResult,
    /// Final cleanup: release locks, clear internal state, return result.
    /// WAL truncation (if needed) is handled by pager.rs via truncate_wal() AFTER the DB is synced.
    Finalize {
        checkpoint_result: Option<CheckpointResult>,
    },
}
```

**`SyncWal` が最初にあることに、耐久性の議論が凝縮されている。**

`synchronous=NORMAL` ではコミットで WAL を fsync しない。この状態で転記を始めると、次の順で壊れる。

1. WAL の末尾がまだディスクに届いていない
2. 転記で本体ファイルの一部が更新される
3. クラッシュ
4. 復旧が「同期されていない WAL の末尾」を捨てる
5. **本体ファイルには捨てられたはずの変更が入っている**

コメントの「a torn database that matches no committed prefix」がこれだ。どのコミット時点とも一致しないファイルになる。だから転記の前に必ず WAL を fsync する。

### `Processing` は読みと書きを別々に制限する

```rust title="core/storage/wal.rs:2425-2433"
/// IOV_MAX is 1024 on most systems, lets use 512 to be safe
pub const CKPT_BATCH_PAGES: usize = 512;

/// TODO: *ALL* of these need to be tuned for perf. It is tricky
/// trying to figure out the ideal numbers here to work together concurrently
const MIN_AVG_RUN_FOR_FLUSH: f32 = 32.0;
const MIN_BATCH_LEN_FOR_FLUSH: usize = 512;
const MAX_INFLIGHT_WRITES: usize = 64;
pub const MAX_INFLIGHT_READS: usize = 512;
pub const IOV_MAX: usize = 1024;
```

**読みは 512 本まで、書きは 64 本まで同時に飛ばす。** 読みは WAL からのランダム読みで並列度が効き、書きは本体ファイルへの書きなのでキューを深くしても意味が薄い。

`Processing` の 1 周は 4 段になっている。

```rust title="core/storage/wal.rs:4907-4922 (抜粋)"
CheckpointState::Processing => {
    // Gather I/O completions using a completion group
    let mut nr_completions = 0;
    let mut group = CompletionGroup::new(|_| {});
    let mut ongoing_chkpt = self.ongoing_checkpoint.write();

    // Check and clean any completed writes from pending flush
    if ongoing_chkpt.process_inflight_writes() {
        tracing::trace!("Completed a write batch");
    }
    // Process completed reads into current batch
    if ongoing_chkpt.process_pending_reads()? {
        tracing::trace!("Drained reads into batch");
    }
```

1. **完了した書きを片付ける**
2. **完了した読みをバッチへ移す**
3. **上限まで新しい読みを発行する**
4. **バッチが揃っていれば `writev` で書く**

3 番目にキャッシュの近道がある。

```rust title="core/storage/wal.rs:4939-4952 (抜粋)"
if let Some(cached_page) =
    pager.cache_get_for_checkpoint(page_id as usize, target_frame, epoch)?
{
    let buffer = cached_page.get_contents().buffer.as_ref().expect("buffer missing").clone();
    {
        ongoing_chkpt.pending_writes.insert(page_id as usize, buffer);
        // signify that a cached page was used, so it can be unpinned
        let current = ongoing_chkpt.current_page as usize;
        ongoing_chkpt.pages_to_checkpoint[current] = (page_id, target_frame);
        ongoing_chkpt.current_page += 1;
    }
    continue 'inner;
}
```

**そのページがキャッシュに載っていて、しかも目的のフレーム以降の内容なら、WAL から読み直さない。** `epoch` を渡しているのは、前回のチェックポイントより古いキャッシュを誤用しないためだ ([状態の地図のページ](../shared-state-map/) の `epoch: AtomicU32`)。

### 書き出しは連続性で判断する

```rust title="core/storage/wal.rs:2596-2604"
fn should_flush_batch(&self) -> bool {
    self.pending_writes.is_full()
        || (self.pending_writes.len() >= MIN_BATCH_LEN_FOR_FLUSH
            && self.pending_writes.avg_run_len() >= MIN_AVG_RUN_FOR_FLUSH)
        || ((self.current_page as usize) >= self.pages_to_checkpoint.len()
            && self.inflight_reads.is_empty()
            && !self.pending_writes.is_empty())
}
```

3 条件のどれかで書き出す。

1. バッチが満杯
2. **512 個以上溜まっていて、かつ「連続した並び」の平均長が 32 以上**
3. 読むべきページがもうない

2 番目が要点だ。バッチは `BTreeMap` なのでページ番号順に並ぶ。

```rust title="core/storage/wal.rs:2444-2452 (抜粋)"
/// WriteBatch is a collection of pages that are being checkpointed together. It is used to
/// aggregate contiguous pages into a single write operation to the database file.
#[derive(Default)]
struct WriteBatch {
    /// BTreeMap for sorting during insertion, helps create more efficient `writev` operations.
    items: BTreeMap<PageId, Arc<Buffer>>,
    /// total number of `runs`, each representing a contiguous group of `PageId`s
    run_count: usize,
}
```

**連続したページ番号の塊 (run) を数えていて、平均の長さが 32 以上になるまで待つ。** 1 つの run が `writev` の 1 回に対応するので、run が長いほど I/O 回数が減る。

「まだ待てばもっと連続がまとまるかもしれない」と「待ちすぎると遅れる」のトレードオフを、平均 run 長という 1 つの指標で判断している。**チェックポイントは順序を選べる** (どのページから転記してもよい) ので、この最適化が成立する。

## 守られている不変条件

**書き込みトランザクションは読みトランザクションの上にしか始められない。** `turso_assert!`。

**転記の前に WAL を fsync する。** `synchronous=NORMAL` でも。

**`BusySnapshot` はリトライで解決しない。** 読みからやり直す必要がある。

**チェックポイントのキャッシュ流用は epoch で守る。** 古い世代のページを使わない。

**読み 512 / 書き 64 の in-flight 上限。**

**`frame_watermark` は最後にチェックポイントしたフレームより後でなければならない。** 破ると panic する。

## つまずきどころ / 設計の含み

### 定数に「チューニングしていない」と書いてある

```rust title="core/storage/wal.rs:2428-2429"
/// TODO: *ALL* of these need to be tuned for perf. It is tricky
/// trying to figure out the ideal numbers here to work together concurrently
```

`MIN_AVG_RUN_FOR_FLUSH = 32.0`、`MIN_BATCH_LEN_FOR_FLUSH = 512`、`MAX_INFLIGHT_WRITES = 64` — **どれも根拠なしの暫定値だと明記されている。**

正直さは good だが、読む側への含みは「この数字に意味を求めるな」だ。コストモデルの定数を外から差し替えられるようにした ([該当ページ](../cost-params/)) のとは対照的に、こちらはコンパイル時定数のまま残っている。

### `Wal` trait が 30 以上のメソッドを持つ

抽象化のための trait というより、**「WAL に対してやりたいことの一覧」**になっている。`write_frame_raw`、`read_frame_raw` のような低レベル API が混ざるのは、同期エンジンが WAL フレームを直接やり取りするからだ ([該当ページ](../physical-logical-sync/))。

実装は `WalFile` 1 つだけだ。**trait にしている実利は、`Option<Arc<dyn Wal>>` として「WAL がない」を表せることと、テストでモックを差せること**にほぼ尽きる。

一方、内側の `WalCoordination` の方は実装が 2 つあり、こちらは本来の意味で多態が効いている。**「trait が 2 段ある」構造は、外側が API の整理、内側が実際の差し替え**という役割分担になっている。

### `end_read_tx` が VACUUM のロックまで面倒を見る

```rust title="core/storage/wal.rs:3354-3371 (抜粋)"
fn end_read_tx(&self) {
    let slot = self.max_frame_read_lock_index.load(Ordering::Acquire);
    if slot != NO_LOCK_HELD {
        self.coordination.end_read_tx(ReadGuardKind::from_lock_index(slot));
        self.max_frame_read_lock_index.store(NO_LOCK_HELD, Ordering::Release);
        self.release_vacuum_read_lock_guard();
    } else {
        // if NO_LOCK_HELD, then we must not have vacuum lock either.
        turso_assert!(
            !self.has_vacuum_read_lock_guard(),
            "vacuum read lock guard held without setting lock slot NO_LOCK_HELD"
        );
    }
}
```

**読みロックと VACUUM ロックが常に対で取得・解放される**ことを、`else` 側でアサートしている。片方だけ残ると VACUUM が永久に始められなくなる。

`vacuum_lock` は [状態の地図のページ](../shared-state-map/) で見た `WalSharedRuntime` のフィールドで、「通常のトランザクションは共有で持ち、VACUUM が排他で取る」という使い方をする。読みトランザクションのライフサイクルに相乗りさせることで、解放漏れを構造的に減らしている。

### チェックポイントのキャンセル処理

```rust title="core/storage/wal.rs:4921-4931 (抜粋)"
if let Some(e) = ongoing_chkpt.first_write_error() {
    mark_unlikely();
    // cancel everything still in-flight to avoid leaks
    let to_cancel: Vec<Completion> = ongoing_chkpt
        .inflight_reads
        .iter()
        .map(|r| r.completion.clone())
        .collect();
    pager.io.cancel(&to_cancel)?;
    pager.io.drain_completions(&to_cancel)?;
    return Err(LimboError::CompletionError(e));
}
```

**書きが 1 本でも失敗したら、飛んでいる読みを全部キャンセルして完了を回収してから返る。**

`cancel` してから `drain_completions` するのが要点だ。キャンセルを要求しても、既に発行済みの I/O は完了通知を返してくる。回収せずに抜けると、**完了ハンドルが指しているバッファが解放された後で完了が届く**。

io_uring のような完了通知型の I/O ([該当ページ](../io-backends/)) では、この後始末を省略できない。エラー経路が最も難しくなるのは、非同期 I/O を自前で扱う実装に共通する性質だ。
