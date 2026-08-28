---
title: "Pager はページの貸出係であり、巻き戻しの責任者でもある"
description: "`Pager` は「ページ番号を渡すとページが返る」だけの層ではない。ダーティページの追跡、文レベルのロールバックのためのサブジャーナル退避、セーブポイントの管理、キャッシュ溢れ時のスピル、そして 8 個の状態機械。ページを 1 枚読む `read_page` にすら 3 つの経路があり、そのうち 1 つは「読み込み中のページがキャッシュに載っている」という状態を扱うためだけに存在する。"
group: "ページとディスク"
sidebar:
  order: 17
---

## この層の責務

`Pager` は接続ごとに 1 つ作られる ([起動のページ](../boot-and-wiring/))。責務は 5 つある。

| 責務                     | 主なフィールド                                   |
| ------------------------ | ------------------------------------------------ |
| ページを貸す             | `page_cache`, `pending_reads`, `buffer_pool`     |
| 変更を追跡する           | `dirty_pages`                                    |
| **巻き戻せるようにする** | `subjournal`, `savepoints`                       |
| ページを増減させる       | `allocate_page_state`, `free_page_state`         |
| 書き出す                 | `cacheflush_state`, `spill_state`, `commit_info` |

3 番目が、上の層からは見えにくいわりに重い。`UPDATE` が途中で制約違反になったとき、**その文が書いたページだけを元に戻す**必要がある。トランザクション全体のロールバックとは別の機構が要る。

キャッシュの追い出し方針と pin の仕組みは [ページキャッシュのページ](../page-cache-pin/)、バッファの確保は [バッファプールのページ](../buffer-pool-arena/) が扱う。ここでは Pager 自身の責務を追う。

## 主要な型とその関係

### 状態機械が 8 個並ぶ

```rust title="core/storage/pager.rs:1346-1412 (性質ごとに抜粋)"
pub struct Pager {
    // --- 下の層への参照 (Database から借りたもの) ---
    pub db_file: Arc<dyn DatabaseStorage>,
    pub(crate) wal: Option<Arc<dyn Wal>>,
    pub buffer_pool: Arc<BufferPool>,
    pub io: Arc<dyn crate::io::IO>,

    // --- この接続だけのもの ---
    page_cache: Arc<RwLock<PageCache>>,
    pending_reads: RwLock<HashMap<i64, PendingRead>>,
    dirty_pages: Arc<RwLock<RoaringBitmap>>,
    subjournal: RwLock<Option<Subjournal>>,
    savepoints: Arc<RwLock<Vec<Savepoint>>>,

    // --- 8 個の状態機械 ---
    allocate_page_state: RwLock<AllocatePageState>,
    allocate_page1_state: RwLock<AllocatePage1State>,
    free_page_state: RwLock<FreePageState>,
    spill_state: RwLock<SpillState>,
    cacheflush_state: RwLock<CacheFlushState>,
    checkpoint_state: RwLock<CheckpointState>,
    header_ref_state: RwLock<HeaderRefState>,
    #[cfg(feature = "autovacuum")]
    vacuum_state: RwLock<VacuumState>,
    // ...
    pub(crate) cursor_registry: Mutex<rustc_hash::FxHashMap<i64, Vec<RegisteredCursor>>>,
}
```

[状態機械のページ](../io-result-and-state-machine/) で見たとおり、この 8 個が同時に動くことはない。「接続は一度に 1 文しか走らせない」前提の表明だ。

**`header_ref_state` があることに注目したい。** ページ 1 のヘッダを読むことすら状態機械になっている — ページ 1 がキャッシュになければディスクを読むからだ。

```rust title="core/storage/pager.rs:5762"
pub fn with_header<T>(&self, f: impl Fn(&DatabaseHeader) -> T) -> Result<IOResult<T>> {
```

`with_header` が `IOResult` を返すので、**「データベースのページサイズを知る」だけで I/O 待ちになりうる**。だから `page_size` と `reserved_space` は Pager 側にキャッシュされている。

### `dirty_pages` は RoaringBitmap

```rust title="core/storage/pager.rs:1366-1367"
/// Dirty pages as a bitmap, naturally sorted by page number.
dirty_pages: Arc<RwLock<RoaringBitmap>>,
```

`HashSet<usize>` ではなくビットマップにしている。コメントの「naturally sorted by page number」が理由だ。

書き出すときはページ番号順に並んでいてほしい。連続したページをまとめて 1 回の `writev` にできるからだ ([WAL のページ](../wal-and-checkpoint/) の `WriteBatch` がその先を担う)。**「集合として持つ」と「順序を保つ」を両立させるためにビットマップを選んでいる。**

### `Savepoint` は 5 つの座標を覚える

```rust title="core/storage/pager.rs:1259-1279"
struct Savepoint {
    kind: SavepointKind,
    /// Start offset of this savepoint in the subjournal.
    start_offset: AtomicU64,
    /// Current write offset in the subjournal.
    write_offset: AtomicU64,
    /// Bitmap of page numbers that are dirty in the savepoint.
    page_bitmap: RwLock<RoaringBitmap>,
    /// Database size at the start of the savepoint.
    /// If the database grows during the savepoint and a rollback to the savepoint is performed,
    /// the pages exceeding the database size at the start of the savepoint will be ignored.
    db_size: AtomicU32,
    /// WAL position to rewind to on `ROLLBACK TO`. Captured only under the
    /// write lock: eagerly if the savepoint is opened inside a write
    /// transaction, otherwise at write upgrade. `None` while the
    /// transaction has never held the write lock (no frames to rewind), or
    /// when the pager has no WAL.
    wal_pos: RwLock<Option<SavepointWalPos>>,
    /// Deferred FK counter value at the start of this savepoint.
    deferred_fk_violations: AtomicIsize,
}
```

巻き戻すために必要な情報が 5 種類ある。

1. **サブジャーナルのどこから** — `start_offset` / `write_offset`
2. **どのページを戻すか** — `page_bitmap`
3. **ファイルの大きさ** — `db_size`。伸びた分は捨てる
4. **WAL のどこまで戻すか** — `wal_pos`
5. **遅延 FK 違反のカウンタ** — `deferred_fk_violations`

5 番目があるのが面白い。`DEFERRABLE` な外部キー制約の違反数はコミット時に判定されるが、**セーブポイントを巻き戻したらこのカウンタも戻さなければならない**。データだけでなく「検査の途中経過」も巻き戻しの対象になる。

`wal_pos` が `Option` で、しかも「書き込みロックを持ってからでないと取れない」という制約が付いている点も重要だ。読みトランザクション中に開いたセーブポイントは、まだ WAL に何も書いていないので巻き戻す先がない。

### サブジャーナルは 1 本しか使えない

```rust title="core/storage/subjournal.rs:11-33"
#[derive(Clone)]
pub struct Subjournal {
    file: Arc<dyn crate::io::File>,
    in_use: Arc<AtomicBool>,
}

impl Subjournal {
    // ...
    pub fn try_use(&self) -> Result<()> {
        let result = self
            .in_use
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        if result.is_err() {
            return Err(crate::LimboError::Busy);
        }
        Ok(())
    }
```

**使用中なら `Busy` を返す。** サブジャーナルは 1 つのファイルで、複数の書き込みが同時に使うことはできない。

`Subjournal` 自体は 135 行しかない。**やっていることは「オフセットを指定してページを書き、読み戻す」だけ**で、どのオフセットに何があるかは `Savepoint` 側が管理する。

## 処理の流れ (コードを追う)

### `read_page` の 3 経路

```rust title="core/storage/pager.rs:3320-3330 (抜粋)"
pub fn read_page(&self, page_idx: i64) -> Result<IOResult<(PageRef, Option<Completion>)>> {
    // ...
    let pending = self.pending_reads.read().get(&page_idx).cloned();
    let (page, c_disk) = if let Some(pending) = pending {
        // Re-entry: previous call yielded on spill before completing
        // `cache_insert`. Reuse the same PageRef and in-flight disk read
        // rather than issuing duplicate IO.
        (pending.page, pending.disk_read)
    } else {
```

**経路 1: 再入。** 前回の呼び出しがキャッシュ挿入の途中で yield していたら、そのときのページと読み込み完了ハンドルを再利用する。

なぜこれが要るか。ディスク読みを発行した後、キャッシュに挿入しようとしてキャッシュが満杯だと、**スピル (ダーティページの書き出し) が必要になり、そこで I/O 待ちになる**。素朴に書くと、次の呼び出しで同じページをもう一度ディスクから読んでしまう。

```rust title="core/storage/pager.rs:1455-1466"
/// State for a `read_page_nonblock` call that has issued its disk read but has
/// not yet been able to insert the page into the cache (cache full, spill in
/// flight). Stored in `Pager::pending_reads` so the next re-entry can resume
/// without issuing a duplicate disk read.
#[derive(Clone)]
struct PendingRead {
    page: PageRef,
    /// `None` if the page was satisfied from WAL/cache shortcut and no
    /// disk read completion needs to be surfaced to the caller.
    disk_read: Option<Completion>,
}
```

**経路 2: キャッシュヒット。** ただし単純ではない。

```rust title="core/storage/pager.rs:3336-3357 (抜粋)"
if let Some(page) = page_cache.get(&page_key)? {
    // ...
    if !page.is_loaded() {
        // The page is cache-resident but its read is still in
        // flight: `read_page` publishes a page into the shared
        // cache (via `cache_insert` below) *before* its disk
        // read completes, and `PageCache::get` deliberately
        // hands out locked-but-unloaded in-flight pages. We have
        // no completion to surface on this path (the disk-read
        // completion was consumed by the original caller and the
        // `pending_reads` entry has already been removed), so
        // returning `Done((page, None))` would hand the caller a
        // locked, unloaded page with nothing to wait on: a torn
        // / uninitialized read, or a concurrent writer filling
        // the buffer underneath the reader.
        io_yield_one!(crate::Completion::new_yield());
    }
    return Ok(IOResult::Done((page, None)));
}
```

**キャッシュにあるのに、まだ中身が入っていないことがある。**

ページはディスク読みが完了する**前に**キャッシュへ公開される。そうしないと、同じページを 2 人が要求したときに 2 回読んでしまう。だが公開した以上、「まだ読み終わっていないページ」を誰かが引く可能性が生まれる。

そのときに待つべき完了ハンドルは、最初の要求者が持っていってしまっている。**待つ対象がないので、`Completion::new_yield()` を返して「後でもう一度来い」と言う。**

これは [`step` のページ](../step-loop/) で見た `StepResult::Yield` の発生源の 1 つだ。「待つべき I/O はないが、今は進めない」という状況を表す唯一の手段になっている。

**経路 3: ディスク読み。** キャッシュにもなければ実際に読む。読んだページを `pending_reads` に登録してから `cache_insert` を試みる。

### キャッシュ容量はソフトリミット

```rust title="core/storage/pager.rs:3406-3411 (抜粋)"
/// Insert a page into the cache, with spilling support.
/// This handles cache full conditions by spilling dirty pages and retrying.
/// The cache capacity is a soft limit: if nothing can be spilled or
/// evicted, the page is admitted over capacity rather than failing the
/// read (mirroring SQLite, where `cache_size` may be exceeded while all
/// pages are in use); later inserts drain the excess.
```

**追い出せるものが何もなければ、容量を超えて入れる。** 読みを失敗させない。

`PRAGMA cache_size` は上限ではなく目安になる。カーソルが 20 本立っていて全部がページを pin していれば、キャッシュはその 20 枚を必ず保持する。

### `add_dirty` が巻き戻しの記録を作る

```rust title="core/storage/pager.rs:3492-3513"
pub fn add_dirty(&self, page: &Page) -> Result<()> {
    turso_assert!(
        page.is_loaded(),
        "page must be loaded in add_dirty() so its contents can be subjournaled",
        { "page_id": page.get().id }
    );
    self.subjournal_page_if_required(page)?;
    let mut dirty_pages = self.dirty_pages.write();
    dirty_pages.insert(page.get().id as u32);
    // Notify cache before marking dirty (page was evictable, now it won't be)
    // Only notify if page wasn't already dirty, or if it was spilled
    // State before set_dirty():
    // - clean page: evictable -> set_dirty() makes it dirty and unevictable
    // - dirty + spilled page: evictable -> set_dirty() clears spilled and makes it unevictable
    // - dirty + not spilled page: already unevictable -> no cache accounting change
    if !page.is_dirty() || page.is_spilled() {
        let key = PageCacheKey::new(page.get().id);
        self.page_cache.write().notify_page_dirty(key);
    }
    page.set_dirty();
    Ok(())
}
```

**ページを汚す前に、必ず元の内容をサブジャーナルへ退避する。** `subjournal_page_if_required` が 1 行目にあるのはそのためだ。

そして「ロード済みでなければならない」を `turso_assert!` で要求している。中身が入っていないページを退避しても意味がないので、ここで落とす。

キャッシュへの通知が条件付きなのも読みどころだ。3 つの状態を場合分けしたコメントが付いている。**「ダーティかつスピル済み」という状態がある** — 一度書き出したがまだキャッシュにいる、という状態で、これは追い出してよい。もう一度書かれるとまた追い出せなくなる。

### `cacheflush` の 5 段

[状態機械のページ](../io-result-and-state-machine/) で全文を見たとおり、キャッシュフラッシュは 5 状態の状態機械だ。

```rust title="core/storage/pager.rs:3528-3529"
/// Flush all dirty pages to disk (async/re-entrant).
/// Unlike commit_wal, this function does not commit, checkpoint nor sync the WAL/Database.
```

**フラッシュはコミットではない。** ダーティページを WAL に書くだけで、コミットフレームも fsync も付けない。

キャッシュが溢れたときのスピルがこれを呼ぶ。**まだコミットしていないトランザクションの変更が WAL に書かれる**ことになるが、コミットフレームがないので読み手には見えない。SQLite と同じ仕組みだ。

## 守られている不変条件

**ページを汚す前に、元の内容をサブジャーナルへ退避する。** `add_dirty` の 1 行目。

**`add_dirty` に渡すページはロード済み。** `turso_assert!` で確認。

**ダーティなページは追い出せない。** ただしスピル済みなら追い出せる。

**同じページのディスク読みを 2 回発行しない。** `pending_reads` で再入時に再利用する。

**キャッシュ未ロードのページを掴ませない。** 待つ対象がなければ `Yield` を返す。

**サブジャーナルは同時に 1 人しか使えない。** `try_use` が `Busy` を返す。

**キャッシュ容量はソフトリミット。** 超えても読みを失敗させない。

## つまずきどころ / 設計の含み

### 「ページを読む」が 5 通りに分岐する

素朴に考えれば `read_page` は「キャッシュにあれば返す、なければ読む」の 2 分岐だ。実際には、

1. 再入中の pending read
2. キャッシュヒットかつロード済み
3. キャッシュヒットだが未ロード → `Yield`
4. キャッシュミス → ディスク読み → 挿入成功
5. キャッシュミス → ディスク読み → 挿入がスピル待ち → `IO`

**3 と 5 が「非同期化によって増えた分岐」だ。** どちらもブロッキング I/O なら存在しない。

そしてこの 2 経路はどちらも稀にしか通らない。稀にしか通らない経路の正しさをどう保証するかが問題になり、その答えが**必ず yield する I/O バックエンド** ([該当ページ](../memory-yield-io/)) と**テスト用のスピル注入フック**になる。

```rust title="core/storage/pager.rs:1468-1474 (抜粋)"
/// Test-only deterministic spill-yield injector for `Pager::read_page`. When
/// armed, the next matching call (after `skip` ignored matches) returns
/// `IO(yield)` once, then disarms itself.
#[cfg(test)]
struct SpillYieldHook {
    /// `-1` = disarmed; otherwise the `page_idx` to fire on.
    target: std::sync::atomic::AtomicI64,
```

**「このページ番号の読み込みで 1 回だけ yield しろ」と指定できるフック**が本番構造体のフィールドとして (cfg で) 埋まっている。再入経路をピンポイントで踏ませるための仕掛けだ。

### `savepoints: Arc<RwLock<Vec<Savepoint>>>` はスタック

`Vec` で持たれているとおり、セーブポイントは入れ子にできる。`ROLLBACK TO sp2` は、`sp2` より後に開いたセーブポイントを全部畳んでから巻き戻す。

そして文レベルのサブトランザクション ([`Program` のページ](../program-and-state/) の `needs_stmt_subtransactions`) も、この同じスタックに積まれる。**ユーザが `SAVEPOINT` と書いたものと、エンジンが文ごとに自動で作るものが、同じ機構を共有している。** `SavepointKind` がその区別を持つ。

### `Pager` に `checkpoint_state` があるのはなぜか

チェックポイントは WAL の仕事に見えるが、状態は Pager にある。

```rust title="core/storage/pager.rs:1371"
checkpoint_state: RwLock<CheckpointState>,
```

**WAL から本体ファイルへページを転記する作業なので、両方に触る必要がある。** `WalFile` 側にも `CheckpointState` があり ([`core/storage/wal.rs:2407`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/wal.rs#L2407))、名前が同じで役割が違う 2 つの enum が並存している。

コードを追うときに紛らわしい箇所で、`pager.rs` の方は「Pager から見たチェックポイントの段」、`wal.rs` の方は「WAL 内部の転記の段」になる。詳しくは [WAL のページ](../wal-and-checkpoint/) で扱う。

### ページ 1 の扱いが全部特別

`allocate_page1_state` が `allocate_page_state` と別にある。`init_page_1` を `Database` と共有している ([起動のページ](../boot-and-wiring/))。`with_header` は `header_ref_state` という専用の状態機械を持つ。

**ページ 1 は「ヘッダ 100 バイト + B-tree の根」という二重の役割**を持つので、他のページと同じ扱いにできない。ファイル形式が固定されている以上この構造は動かせず、その結果として Pager の中に「ページ 1 専用」のコードが散らばる。

形式の制約が実装の形に直接現れる例で、[オンディスク形式のページ](../ondisk-format/) の帰結として読むと分かりやすい。
