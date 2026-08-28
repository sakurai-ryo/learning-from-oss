---
title: "`Database::open` が組み立てる部品と、その所有関係"
description: "ファイルパス 1 本から、以降のすべてのページが前提にする部品一式が組み立てられる。IO、DatabaseStorage、WalFileShared、BufferPool、Schema、PageCache、Pager、Connection。このうち何がファイルにつき 1 つで、何が接続ごとに作り直されるのか。Arc がどこからどこへ伸びているかを最初に確定させておくと、後のページで「この状態は誰のものか」を毎回考えずに済む。"
group: "エンジンの骨格"
sidebar:
  order: 3
---

## この層の責務

`Database::open` から `db.connect()` までの間に、エンジンが動くために必要な部品が全部組み立てられる。この区間には SQL もクエリも出てこない。やっているのは配線だけだ。

だがこの配線が、後続のほぼ全ページの前提になる。

- 「ページキャッシュは接続をまたいで共有されるのか」→ [Pager のページ](../pager-responsibilities/)
- 「WAL の read mark を見ているのは誰か」→ [WAL のページ](../wal-and-checkpoint/)
- 「スキーマを書き換えたとき、他の接続にいつ見えるか」→ [スキーマ解決のページ](../schema-resolution/)

これらは全部、**その状態が誰に所有されているか**で答えが決まる。だから最初に所有関係を確定させる。

MySQL なら「全部 `mysqld` のプロセスの中にあり、全接続が共有する」で終わる話だ。Turso にはサーバがないので、共有の単位を自分で決める必要があった。そして実際、**部品ごとに答えが違う**。

## 主要な型とその関係

`Database` は [`core/database.rs:519`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/database.rs#L519) にある。フィールドを共有の単位ごとに並べ替えると、こうなる。

```rust title="core/database.rs (抜粋・並べ替え)"
pub struct Database<A: alloc::ConcurrentAllocator = alloc::DynAllocator> {
    // --- ファイルにつき 1 つ。全接続で共有される ---
    pub db_file: Arc<dyn DatabaseStorage>,
    pub io: Arc<dyn IO>,
    pub(crate) shared_wal: Arc<RwLock<WalFileShared>>,
    pub(crate) buffer_pool: Arc<BufferPool>,
    pub(crate) schema: Arc<Mutex<Arc<Schema>>>,
    pub(crate) mv_store: ArcSwapOption<mvcc::MvStore<mvcc::MvccClock, A>>,

    // --- 実は誰も読んでいない ---
    _shared_page_cache: Arc<RwLock<PageCache>>,

    // --- open 時に固定される設定 ---
    dialect: Arc<dyn Dialect>,
    pub(crate) opts: DatabaseOpts,
    pub(crate) open_flags: OpenFlags,

    // --- 調停用 ---
    init_lock: Arc<Mutex<()>>,
    pub(crate) n_connections: AtomicUsize,
    pub(crate) incarnation: u64,
    // ...
}
```

`Database` そのものも、**ファイルにつき 1 つ**であることが強制されている。プロセス全体で 1 つのレジストリが持っている。

```rust title="core/database.rs:471-505"
pub(crate) enum RegistryEntry {
    /// Another caller is currently opening this database. Callers that see
    /// this should yield and retry later.
    Opening,
    /// The database has been opened and is (or was) live.
    Ready(Weak<Database>),
}

pub(crate) enum DatabaseKey {
    File(io::FileId),
    SharedMemory(String),
}

pub(crate) static DATABASE_MANAGER: LazyLock<
    Arc<parking_lot::Mutex<HashMap<DatabaseKey, RegistryEntry>>>,
> = LazyLock::new(|| Arc::new(parking_lot::Mutex::new(HashMap::default())));
```

注目すべき点が 3 つある。

**キーはパス文字列ではなく `FileId`（dev + ino）だ。** コメントに `matching SQLite's inodeList approach` とある。`./db` と `/abs/path/db` が同じファイルを指していても、同じ `Database` に収束する。シンボリックリンク越しでも同じだ。

**値が `Weak` である。** レジストリはキャッシュであって所有者ではない。最後の `Arc<Database>` が落ちればエントリは死ぬ。

**`Opening` という中間状態がある。** 開いている最中に別スレッドが同じパスを開こうとしたら、`Opening` を見て待つ。ここで待たせないと、2 つの `Database` が同じ WAL を独立に開いてしまう。理由もそのままコメントに書いてある。

```rust title="core/database.rs:479-482"
/// The database manager ensures that there is a single, shared
/// `Database` object per a database file. We need because it is not safe
/// to have multiple independent WAL files open because coordination
/// happens at process-level POSIX file advisory locks.
```

**POSIX の advisory lock はプロセス単位で、同一プロセス内では調停にならない。** これが `Database` を 1 つに絞る理由だ。この制約の詳細は [`.tshm` のページ](../shared-wal-tshm/) で扱う。

### 接続ごとに作られるもの

`db.connect()` を呼ぶと、`Pager` が 1 つと `Connection` が 1 つできる。

```rust title="core/database.rs:2318 _connect (抜粋)"
let pager = if let Some(pager) = pager {
    pager
} else {
    Arc::new(self._init(encryption_key.as_ref(), page_codec.clone())?)
};
```

`Pager` の中身 ([`core/storage/pager.rs:1346`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/pager.rs#L1346)) を、`Database` から借りてきたものと自前のものに分けるとこうなる。

| Pager のフィールド                        | 出どころ                                 | 共有されるか                       |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------- |
| `db_file`                                 | `Database` から clone                    | **共有**                           |
| `io`                                      | `Database` から clone                    | **共有**                           |
| `buffer_pool`                             | `Database` から clone                    | **共有**                           |
| `wal`                                     | `Database.shared_wal` を包んだ `WalFile` | 実体は**共有**、ハンドルは接続ごと |
| `init_lock`                               | `Database` から clone                    | **共有**                           |
| `page_cache`                              | `PageCache::default()`                   | **接続ごとに新品**                 |
| `dirty_pages`, `savepoints`, `subjournal` | 新規                                     | 接続ごと                           |
| `*_state` (8 個の状態機械)                | 新規                                     | 接続ごと                           |

`Connection` ([`core/connection.rs:374`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/connection.rs#L374)) は 80 以上のフィールドを持つが、性質は 3 つしかない。

- `Arc<Database>` と `ArcSwap<Pager>` — 下の層への参照
- `AtomicBool` / `AtomicI64` / `AtomicU8` の山 — pragma と統計。`auto_commit`、`query_only`、`fk_pragma`、`changes`、`last_insert_rowid` など
- `RwLock<...>` の山 — 実行中の状態。`schema`、`mv_tx`、`busy_handler`、`attached_databases` など

**`Connection` にスレッドは 1 本も紐づいていない。** MySQL の `THD` に近い構造体だが、`THD` を回すスレッドに当たるものがない。`step()` を呼んだ誰かのスレッドが、そのまま実行スレッドになる。

## 処理の流れ (コードを追う)

`Database::open` → `connect()` の全体は、次の順で進む。

### 1. ファイルを開き、`FileId` でレジストリを引く

`open_file` → `open`。ここで `DATABASE_MANAGER` を引き、既存の `Weak<Database>` が生きていればそれを返す。なければ `Opening` を置いてから実際に開く。

### 2. `Database::new` で共有部品を組む

[`core/database.rs:629`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/database.rs#L629) の `new` が興味深いのは、**ここでは I/O をしていない**ことだ。`db_file.size()` でファイルサイズを見るだけで、ページは 1 枚も読まない。

```rust title="core/database.rs:643-668 (抜粋)"
let shared_wal = WalFileShared::new_noop();
let mv_store = ArcSwapOption::empty();
let db_size = db_file.size()?;
// ...
let init_page_1 = if db_size == 0 {
    let default_page_1 = pager::default_page1(encryption_cipher_mode.as_ref());
    Some(default_page_1)
} else {
    None
};
```

サイズ 0 なら、**メモリ上にページ 1 を組み立てて持っておく**。空の DB に対して `CREATE TABLE` が来るまでファイルには何も書かない、という遅延がここで仕込まれる。`WalFileShared::new_noop()` も同じで、WAL の実体はまだ開いていない。

`buffer_pool` はここで `begin_init` される。`begin_init` であって `new` でないのは、**ページサイズがまだ分からない**からだ。アリーナのスロットサイズはページサイズで決まる ([バッファプールのページ](../buffer-pool-arena/))。

### 3. `_init` が初めてページ 1 を読む

`connect()` の中で呼ばれる `_init` ([`core/database.rs:1634`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/database.rs#L1634)) が、初めて実際の I/O を伴う。状態機械になっている。

```rust title="core/database.rs:1648 _init_nonblock (骨格)"
loop {
    match st {
        InitState::Start => { *st = InitState::InitPager(DbHeaderReadState::default()); }
        InitState::InitPager(hdr_st) => {
            let pager = return_if_io!(self.init_pager(None, hdr_st, page_codec));
            // ...
            *st = InitState::ReadPage1 { pager: Box::new(pager) };
        }
        InitState::ReadPage1 { pager } => { /* autovacuum モードを決める */ }
        // ...
    }
}
```

`return_if_io!` が出てくる。**接続を開くという操作すら、I/O 待ちで途中から再開できる形で書かれている**。この作法そのものは [`IOResult` と `StateMachine` のページ](../io-result-and-state-machine/) で扱う。

`init_pager` の中で、ヘッダの先頭 512 バイトだけを読んで 2 つの値を回収する。

```rust title="core/database.rs:2915-2946 (抜粋)"
let (header_reserved_bytes, header_page_size) = if self.initialized() {
    let buf = return_if_io!(self.read_db_header_buf(hdr_st));
    // ...
    let reserved = u8::from_be_bytes(buf.as_slice()[20..21].try_into().unwrap());
    let ps_raw = u16::from_be_bytes(buf.as_slice()[16..18].try_into().unwrap());
    let page_size = PageSize::new_from_header_u16(ps_raw)?;
    (Some(reserved), Some(page_size))
} else {
    (None, None)
};
```

オフセット 16 と 20 を直接読んでいる。ページサイズが分からないうちはページとして読めないので、**バイトオフセット直打ちで先にページサイズだけを取る**という順序になっている。ヘッダのレイアウトは [オンディスク形式のページ](../ondisk-format/) を参照。

ページサイズが決まったら、`buffer_pool.finalize_with_page_size(...)` でアリーナが確定する。手順 2 で `begin_init` に留めておいた理由がここで回収される。

### 4. `Pager::new` に何を渡すか

そして `Pager` が作られる。

```rust title="core/database.rs:2991-2999"
let pager = Pager::new(
    self.db_file.clone(),
    pager_wal,
    self.io.clone(),
    PageCache::default(),
    buffer_pool,
    self.init_lock.clone(),
    self.init_page_1.clone(),
)?;
```

4 番目の引数が `PageCache::default()` になっている。**`Database` からもらってきたキャッシュではなく、新品だ。**

### 5. `Connection` を組む

`_connect_with_pager_and_default_cache_size` が `Connection` を丸ごと構築する。ここでのスキーマの受け渡しがポイントになる。

```rust title="core/database.rs:2348-2352 (抜粋)"
let conn = Arc::new(Connection {
    db: self.clone(),
    pager: ArcSwap::new(pager),
    schema: RwLock::new(self.schema.lock().clone()),
    // ...
```

`self.schema.lock().clone()` は `Arc<Schema>` の clone、つまり**参照のコピー**だ。接続はこの瞬間の `Arc<Schema>` を握る。以後 `Database` 側のスキーマが差し替わっても、この接続は古い `Arc` を持ったままになる。差し替えが接続に反映されるタイミングは [スキーマ解決のページ](../schema-resolution/) の主題だ。

## 守られている不変条件

**1 つのファイルに対して `Database` は高々 1 つ。** `DATABASE_MANAGER` と `Opening` 状態で保証される。破れると、独立した 2 つの `WalFileShared` が同じ `.wal` を書くことになり、advisory lock では止められない。

**`Database` に鍵素材を置かない。** コメントで明示されている。

```rust title="core/database.rs:517"
/// Do that `Database` object is cached and can be long lived. DO NOT store anything sensitive like
/// encryption key here.
```

`Database` はレジストリにキャッシュされて長生きするので、`EncryptionKey` は `Connection.encryption_key` と `Pager` 側だけに置く。`connect_with_page_codec` のコメントにも同じ趣旨がある。

**`DATABASE_MANAGER` のロックを I/O yield 越しに握らない。**

```rust title="core/database.rs:494-497"
/// IMPORTANT: The mutex must only be held for brief HashMap operations, never
/// across I/O yields. Holding it across yields deadlocks single-threaded
/// event loops because the blocked thread
/// can never resume the coroutine that owns the lock.
```

`await` がない世界では、ロックを握ったまま `IOResult::IO` を返して帰ると、再開する主体がいなくなる。**同期ロックと手書き状態機械を混ぜたときに固有に出るデッドロック**で、これは [再入のページ](../reentrancy/) の話と表裏になっている。

**`incarnation` は再利用されない。** `Arc` のヒープアドレスは detach → reattach で再利用されうるので、プロセス内で単調増加する ID を別に振っている。

## つまずきどころ / 設計の含み

### ページキャッシュは接続ごとに独立している

上で見たとおり `Pager::new` には `PageCache::default()` が渡る。`Database` の `_shared_page_cache` は、先頭のアンダースコアが示すとおり**どこからも読まれていない**。

```console
$ grep -rn "_shared_page_cache" core/
core/database.rs:530:    _shared_page_cache: Arc<RwLock<PageCache>>,
core/database.rs:606:        let cache_info = match self._shared_page_cache.try_read() {
core/database.rs:682:            _shared_page_cache: shared_page_cache,
```

530 が宣言、682 が初期化、606 が `impl Debug` の中。つまり **`Database` を `{:?}` で出力したときに表示されるだけ**のフィールドだ。しかもその表示は、実際にクエリが使うキャッシュではない。デバッグ出力を信じて「キャッシュに 300 ページ載っている」と読むと間違える。

実務上の含みは大きい。同じプロセスで 8 本接続を張ると、**ページキャッシュも 8 個できる**。`PRAGMA cache_size` は接続ごとに効く。同じテーブルを 8 本が読めば、同じページが 8 枚メモリに載る。

一方で `BufferPool` は共有されている。ページの中身を置く**バッファ**は共有アリーナから配られ、それを**どのページとして覚えておくか**の索引だけが接続ごとに分かれている、という切り分けになっている。

### `Database::new` は I/O をしない

ここを見落とすと、`Database::open` が失敗しない理由が分からなくなる。存在しないパスを開いても、破損したヘッダを持つファイルを開いても、`open` は通ることがある。**壊れていると分かるのは最初の `connect()`**、正確には `_init` がページ 1 を読んだときだ。

エラーハンドリングを書くときは、`open` の `Result` だけ見ていても足りない。

### 空の DB のページ 1 はメモリにいる

`init_page_1: Arc<ArcSwapOption<Page>>` が `Some` の間、その DB は「まだ 1 バイトも書いていない」状態だ。`Database` と `Pager` の両方が同じ `Arc<ArcSwapOption<Page>>` を持っていて、**どちらかが書き込みを確定させたら両方から同時に消える**。`ArcSwapOption` なのはそのためで、`Option<Arc<Page>>` では共有した先に伝わらない。

`impl Debug` はこれを使って状態名を出している。

```rust title="core/database.rs:577-582"
let db_state_value = match &*self.init_page_1.load() {
    // If init_page1 exists, this means the DB is empty
    Some(_) => "uninitialized",
    None => "initialized",
};
```

### `DatabaseOpts` のほぼ全部が opt-in

```rust title="core/database.rs:70"
pub struct DatabaseOpts {
    pub enable_views: bool,
    pub enable_custom_types: bool,
    pub enable_encryption: bool,
    pub enable_index_method: bool,
    pub enable_autovacuum: bool,
    pub enable_vacuum: bool,
    pub enable_attach: bool,
    pub enable_generated_columns: bool,
    pub enable_multiprocess_wal: bool,
    pub enable_without_rowid: bool,
    pub enable_experimental_mvcc_passive_checkpoint: bool,
    pub unsafe_testing: bool,
    pub(crate) enable_load_extension: bool,
}
```

`Default` は全部 `false` だ。マテリアライズドビュー、暗号化、`ATTACH`、autovacuum、マルチプロセス WAL — この章で扱う機能の多くは、**デフォルトで無効**になっている。ソースを読んでいて「この分岐に入らない」と思ったら、まずここを疑うとよい。

そして `open_flags` と `dialect` は open 時に固定され、接続ごとに変えられない。`dialect` のコメントが理由を書いている。

```rust title="core/database.rs:545-548"
/// SQL dialect this database runs under, interpreting `sqlite_schema`
/// SQL rows. Passed explicitly by every open path, fixed at open time,
/// and shared by all connections because the parsed [`Schema`] is
/// shared per database.
```

**`Schema` が `Database` 単位で共有されているから、それを作るときに使った方言も `Database` 単位で固定されている。** 1 つの `.db` に SQLite 方言の接続と Postgres 方言の接続を同時に張ることはできない。方言境界の設計そのものは [`Dialect` trait のページ](../dialect-trait/) を参照。

### `n_connections` を数えている理由

`AtomicUsize` で接続数を数えているのは、統計のためではない。閉じるときに、この接続が最後の 1 本かどうかを知る必要があるからだ。

```rust title="core/connection.rs:2435-2443"
if self.db.n_connections.fetch_sub(1, Ordering::SeqCst).eq(&1)
    && !self.db.is_readonly()
    && !is_memory_db
    && should_checkpoint_on_close
{
    self.pager
        .load()
        .checkpoint_shutdown(self.wal_auto_actions(), self.get_sync_mode())?;
};
```

`fetch_sub` の戻り値が 1、つまり**減らす前が 1 本だった**なら、自分が最後だ。そのときだけシャットダウン時チェックポイントを走らせる。サーバがあれば「サーバが終わるとき」で済む判断を、**「最後の接続が閉じたとき」に置き換えている**。この読み替えは Turso のあちこちに出てくるパターンで、チェックポイントを誰が走らせるかという問題として [WAL のページ](../wal-and-checkpoint/) で再登場する。
