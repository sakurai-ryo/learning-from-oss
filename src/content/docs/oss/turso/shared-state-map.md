---
title: "可変状態がどこに住んでいるか、3 段の地図を描く"
description: "接続ローカル、プロセス内共有、プロセス間共有。Turso の可変状態はこの 3 段のどこかに置かれ、段ごとに使う同期プリミティブが違う。`AtomicU64`、`crate::sync::RwLock`、`parking_lot` 直指定、`SpinLock`、`TursoRwLock`、`ArcSwap` — 6 種類が使い分けられている。WAL の `max_frame` という 1 つの値が 3 段全部に現れるので、それを追うと地図が描ける。"
group: "エンジンの骨格"
sidebar:
  order: 6
---

## この層の責務

前のページで、状態機械の状態は「その操作の主体」に置かれると書いた。このページはもう一段引いて、**そもそも状態が住める場所が何段あるか**を確定させる。

サーバ型の RDB なら、この地図は 2 段しかない。「セッションのもの」と「サーバのもの」だ。ファイルは `mysqld` 以外の誰も触らないので、3 段目が要らない。

Turso には 3 段ある。

| 段                 | 誰が触るか                             | 生存期間                           |
| ------------------ | -------------------------------------- | ---------------------------------- |
| **接続ローカル**   | 1 本の `Connection` を回すスレッドだけ | `connect()` から `close()`         |
| **プロセス内共有** | 同じ `Database` を開いた全接続         | `Database` の `Arc` が生きている間 |
| **プロセス間共有** | 同じファイルを開いた全プロセス         | ファイルが存在する間               |

3 段目があることが、サーバがない DB の本質的なコストだ。同じ値がしばしば 3 段全部に現れ、**段をまたぐたびに同期の手段が変わる**。

## 主要な型とその関係

### 段ごとの住人

**接続ローカル。** `Connection` と `Pager` と `Statement` のフィールド。

```rust title="core/connection.rs:374 (性質ごとに抜粋)"
pub struct Connection {
    pub(crate) auto_commit: AtomicBool,
    pub(super) transaction_state: AtomicTransactionState,
    pub(super) last_insert_rowid: AtomicI64,
    pub(crate) changes: AtomicI64,
    pub(crate) n_active_writes: AtomicI32,
    // ...
    pub(crate) schema: RwLock<Arc<Schema>>,
    pub(crate) mv_tx: RwLock<Option<(TxID, TransactionMode)>>,
    pub(super) busy_handler: RwLock<BusyHandler>,
    // ...
}
```

**接続ローカルなのに `Atomic` と `RwLock` が使われている**のが目を引く。1 本のスレッドしか触らないなら `Cell` で足りるはずだ。

理由は 2 つある。第 1 に、`Connection` は `Arc<Connection>` として持ち回され、`&self` からしか触れない。第 2 に、`Connection` は `Send + Sync` を要求されている ([`core/connection.rs`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/connection.rs) 付近の `assert_send_sync!`)。**「別のスレッドに渡してもよい。ただし同時に 2 スレッドから使ってはいけない」**という契約になっていて、その前半分を型で保証するために全部が同期プリミティブになっている。

**プロセス内共有。** `Database` と `WalFileShared` と `BufferPool`。

`WalFileShared` はこの段の代表格で、名前のとおり 2 つに分かれている。

```rust title="core/storage/wal.rs:2866-2869"
/// WalFileShared holds process-wide WAL metadata plus process-local coordination state.
pub struct WalFileShared {
    pub metadata: WalSharedMetadata,
    pub runtime: WalSharedRuntime,
}
```

`metadata` は「WAL の事実」、`runtime` は「そのプロセスがその事実を扱うための道具」だ。

```rust title="core/storage/wal.rs:2790-2801"
pub struct WalSharedMetadata {
    pub enabled: AtomicBool,
    pub wal_header: Arc<SpinLock<WalHeader>>,
    pub min_frame: AtomicU64,
    pub max_frame: AtomicU64,
    pub nbackfills: AtomicU64,
    pub transaction_count: AtomicU64,
    pub last_checksum: (u32, u32),
    pub loaded: AtomicBool,
    pub loaded_from_disk_scan: AtomicBool,
    pub initialized: AtomicBool,
}
```

```rust title="core/storage/wal.rs:2804-2846 (抜粋)"
pub struct WalSharedRuntime {
    pub frame_cache: Arc<SpinLock<FxHashMap<u64, Vec<u64>>>>,
    pub frame_cache_high_water: AtomicU64,
    pub file: Option<Arc<dyn File>>,
    pub read_locks: [TursoRwLock; 5],
    pub vacuum_lock: TursoRwLock,
    pub write_lock: TursoRwLock,
    pub checkpoint_lock: TursoRwLock,
    pub epoch: AtomicU32,
    pub overflow_fallback_coverage: Arc<SpinLock<OverflowFallbackCoverage>>,
}
```

**プロセス間共有。** `.db` ファイル、`.wal` ファイル、そして `.tshm` の mmap。

`.tshm` は「複数プロセスで共有できる形にした `WalSharedRuntime`」だと思うと構造が分かる。ロックはビットではなくファイル内のオフセットで表される。

```rust title="core/storage/shared_wal_coordination.rs:51-70 (抜粋)"
const PROCESS_LIFETIME_LOCK_OFFSET: u64 = 0;
const WRITER_LOCK_OFFSET: u64 = 1;
const CHECKPOINT_LOCK_OFFSET: u64 = 2;
const READER_LOCK_START_OFFSET: u64 = 3;

const FRAME_INDEX_BLOCK_CAPACITY: u32 = 4096;
const FRAME_INDEX_BLOCK_HASH_SLOTS: u32 = FRAME_INDEX_BLOCK_CAPACITY * 2;
const MAX_FRAME_INDEX_BLOCKS: u32 = 64;
```

`write_lock` / `checkpoint_lock` / `read_locks[5]` が、そのままオフセット 1・2・3 以降に対応している。**プロセス内なら `TursoRwLock` (アトミック 1 個)、プロセス間なら `.tshm` のバイト位置**、というのがこの 2 段の関係だ。設計の経緯は [`.tshm` のページ](../shared-wal-tshm/) を参照。

### 同期プリミティブが 6 種類ある

| 使うもの                              | どういうときか                           |
| ------------------------------------- | ---------------------------------------- |
| `AtomicBool` / `AtomicU64` など       | 単一のスカラ値。ロックが要らない         |
| `crate::sync::{Mutex, RwLock}`        | ふつうの排他。**shuttle に差し替え可能** |
| `parking_lot::{Mutex, RwLock}` 直指定 | shuttle に差し替えては**いけない**もの   |
| `SpinLock` (`core/fast_lock.rs`)      | 保持時間が極端に短いもの                 |
| `TursoRwLock`                         | ロックと値を 1 個の `u64` に詰めたもの   |
| `ArcSwap` / `ArcSwapOption`           | 読みが圧倒的に多く、書きが稀なもの       |

`crate::sync` の正体が面白い。中身は丸ごと差し替えのアダプタだ。

```rust title="core/sync.rs"
#[cfg(shuttle)]
pub(crate) use shuttle_adapter::*;

#[cfg(not(shuttle))]
pub(crate) use std_adapter::*;
```

```rust title="core/sync.rs (std_adapter)"
mod std_adapter {
    pub use parking_lot::{Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};
    pub use std::sync::{atomic, Arc, LazyLock, OnceLock, Weak};

    pub type ArcMutexGuard<T> = parking_lot::ArcMutexGuard<parking_lot::RawMutex, T>;
}
```

通常ビルドでは `parking_lot` にそのまま流す。`--cfg shuttle` を付けると、`Mutex` も `RwLock` も `Arc` も `atomic` も **shuttle のものに置き換わる**。shuttle はスレッドスケジュールを制御して並行バグを探すツールなので、こうしておくと `core` の並行コードを丸ごとモデル検査にかけられる。

だから **`crate::sync::Arc` と `std::sync::Arc` は別物**だ。`use std::sync::Arc` と書いてしまうと、shuttle ビルドでその箇所だけ検査対象から外れる。

### `parking_lot` を直接指定している場所

差し替えから意図的に外してある箇所がある。理由もそれぞれ書かれている。

```rust title="core/database.rs:484-489 (抜粋)"
/// Uses parking_lot::Mutex instead of crate::sync::Mutex because this static
/// must persist across shuttle test iterations. Shuttle resets its execution
/// state between iterations, but static variables persist - using shuttle's
/// Mutex here would cause panics when the second iteration tries to lock a
/// mutex that belongs to a stale execution context.
```

`DATABASE_MANAGER` は `static` なので shuttle の実行をまたいで生き残る。shuttle の `Mutex` は実行コンテキストに紐づいているので、2 回目の実行で古いコンテキストのロックを取ろうとして panic する。

同じ理由で `Database::incarnation` を作るカウンタも `std` のアトミックを明示している。

```rust title="core/database.rs:696-699 (抜粋)"
// Deliberately std, not crate::sync: this static outlives a
// shuttle test execution, and a shuttle-tracked atomic that
// survives into the next execution corrupts shuttle's vector
// clocks (task ids restart, the stale clock is longer than
// the new task table, and clock bookkeeping underflows).
```

もう 1 つは理由が違う。

```rust title="core/database.rs:542-544"
// Use parking lot RwLock here and not `crate::sync::RwLock` because it relies on `data_ptr` and that is experimental
// in std.
pub(crate) builtin_syms: parking_lot::RwLock<SymbolTable>,
```

**「テスト基盤の都合」で 2 箇所、「API の都合」で 1 箇所。** 差し替え可能な同期プリミティブを導入すると、必ずこういう例外が出る。

## 処理の流れ (コードを追う)

### `max_frame` という 1 つの値が、3 段全部に現れる

WAL の `max_frame` は「今 WAL に何フレーム書かれているか」を表す。読み手はこの値を見て、どこまでのフレームを自分のスナップショットに含めるかを決める。

この値が 3 段のどこにどう置かれているかを並べると、地図がそのまま出てくる。

**プロセス内共有 — 権威の値。**

```rust title="core/storage/wal.rs:2794"
pub max_frame: AtomicU64,
```

`WalSharedMetadata` にある。同じプロセスの全接続が同じものを見る。

**接続ローカル — スナップショット。**

```rust title="core/storage/wal.rs:2689-2694"
/// This is the index to the read_lock in WalFileShared that we are holding. This lock contains
/// the max frame for this connection.
max_frame_read_lock_index: AtomicUsize,
/// Max frame allowed to lookup range=(minframe..max_frame)
max_frame: AtomicU64,
```

`WalFile` は接続ごとに 1 個作られる ([起動のページ](../boot-and-wiring/))。読みトランザクションを始めた瞬間の共有 `max_frame` をここにコピーする。**以後この接続は、共有側がいくら増えても自分のコピーしか見ない。** これがスナップショット分離の実装そのものだ。

**プロセス内共有 — 掲示板。**

```rust title="core/storage/wal.rs:2823-2828 (抜粋)"
/// Read locks advertise the maximum WAL frame a reader may access.
/// Slot 0 is special, when it is held (shared) the reader bypasses the WAL and uses the main DB file.
/// ...
pub read_locks: [TursoRwLock; 5],
```

自分のスナップショットを持っているだけでは足りない。**チェックポイントが「まだ誰かが見ているフレーム」を消してしまう**からだ。そこで自分の `max_frame` を 5 つのスロットのどれかに掲示する。`TursoRwLock` がロックと値を 1 つの `u64` に詰めているのは、**「このスロットを使っている読み手がいる」と「その読み手が見ている frame 番号」を同時にアトミックに読みたい**からだ。この詰め方の詳細は [WAL のページ](../wal/) にある。

**プロセス間共有 — `.tshm` のスロット。**

マルチプロセスでは、掲示板がプロセスの外に出る必要がある。`shared_wal_coordination.rs` の `SharedReaderSlot` がその役で、`READER_LOCK_START_OFFSET = 3` から並ぶ。

こうして 1 つの値が、**「権威」「スナップショット」「掲示」「プロセス外への掲示」**という 4 つの姿を持つ。同期の手段はそれぞれ、共有アトミック・ローカルアトミック・`TursoRwLock`・ファイルロック + mmap と変わっていく。

### スキーマは `Arc<Mutex<Arc<T>>>` という二重構造で共有される

```rust title="core/database.rs:522"
pub(crate) schema: Arc<Mutex<Arc<Schema>>>,
```

```rust title="core/connection.rs:377"
pub(crate) schema: RwLock<Arc<Schema>>,
```

内側の `Arc<Schema>` は**不変**だ。スキーマを変えるときは新しい `Schema` を作って `Arc` を差し替える。だから接続側は `Arc` を clone して持ち帰るだけでよく、翻訳中にロックを握り続ける必要がない。

```rust title="core/connection.rs:962"
let schema = self.schema.read().clone();
```

`Mutex` を握るのは `Arc` を 1 個複製する間だけ。**「重い読み取りをロック外でやる」ための定型**で、同じ形が `pager: ArcSwap<Pager>` にも出てくる。

## 守られている不変条件

**接続を同時に 2 スレッドから使わない。** 型では止められていない。`Connection` は `Sync` なので、コンパイラは通す。破ると、`Pager` の状態機械が混ざる。

**`Database` は 1 ファイルに 1 つ。** [起動のページ](../boot-and-wiring/) で見たとおり、プロセス間の調停が advisory lock だけなので、プロセス内では別の手段が要る。

**内側の `Arc<Schema>` は不変。** 書き換えるのではなく差し替える。読み手が古い `Arc` を持ったまま動き続けても壊れない。

**shuttle でモデル検査したい並行コードは `crate::sync` を使う。** `std::sync` を直接使うと、その箇所だけ検査から外れる。逆に `static` は `parking_lot` を明示する。

## つまずきどころ / 設計の含み

### コメントが実装より古い

`WalSharedRuntime` の `frame_cache` に、こう書いてある。

```rust title="core/storage/wal.rs:2808-2811 (抜粋)"
// One difference between SQLite and limbo is that we will never support multi process, meaning
// we don't need WAL's index file. So we can do stuff like this without shared memory.
// TODO: this will need refactoring because this is incredible memory inefficient.
pub frame_cache: Arc<SpinLock<FxHashMap<u64, Vec<u64>>>>,
```

**「マルチプロセスは絶対にサポートしない」と書いてある隣のファイル**が `shared_wal_coordination.rs` で、そこには mmap 共有のフレーム索引が 4096 エントリ × 64 ブロックで実装されている。旧称 (limbo) が残っていることからも、コメントの古さが分かる。

`docs/agent-guides/` にも同種のずれがある (概要ページに書いたとおり)。**このコードベースを読むときは、コメントの断定を鵜呑みにしないほうがいい。** 特に「〜はサポートしない」「〜は未実装」の類は、後から実装されている可能性が高い。

一方で、`WalFile` の中に SQLite の `wal.c` のコメントが 40 行そのまま貼られている箇所もある。

```rust title="core/storage/wal.rs:2735-2786 (抜粋)"
/*
* sqlite3/src/wal.c
*
** nBackfill is the number of frames in the WAL that have been written
** back into the database. ...
```

**古い自前のコメントより、輸入した SQLite のコメントのほうが正確**という状態になっている。仕様の出どころが SQLite である以上、これは自然でもある。

### `frame_cache` はプロセス内共有だが、`.tshm` の索引と二重になる

マルチプロセス有効時、ページ → フレームの索引はプロセス内の `frame_cache` と `.tshm` の `SharedWalFrameIndexEntry` の 2 つ存在することになる。`frame_cache_high_water` と `overflow_fallback_coverage` は、**プロセス内キャッシュがどこまで信用できるか**を追跡するための変数だ。

```rust title="core/storage/wal.rs:2812-2820 (抜粋)"
/// Highest frame number currently recorded in `frame_cache` for the active
/// WAL generation. Used to detect frame-slot reuse / append-position
/// rewinds: within a generation frames are appended with strictly
/// increasing numbers, so caching a frame that is not above this watermark
/// means the slots from that frame upward are being overwritten and any
/// stale `page -> frame` mappings for them must be purged
```

**キャッシュの無効化を「単調増加が破れたこと」で検出している。** フレーム番号が巻き戻ったら、そこから上のマッピングを全部捨てる。エポック番号 (`epoch: AtomicU32`) も同じ目的で、チェックポイントのたびに増える。

段が増えると、こういう「下の段の変化を上の段が検出する」仕掛けが必要になる。3 段目を持つコストの実体はここにある。

### `SpinLock` を選んでいる場所

`fast_lock.rs` の `SpinLock` は、`UnsafeCell` + `AtomicBool` の最小実装だ。

```rust title="core/fast_lock.rs:49-54"
pub fn lock(&self) -> SpinLockGuard<'_, T> {
    while self.locked.swap(true, Ordering::Acquire) {
        spin_loop();
    }
    SpinLockGuard { lock: self }
}
```

待ちがブロックではなくスピンなので、**保持時間が長い場所で使うと CPU を焼く**。実際に使われているのは `wal_header`、`frame_cache`、`overflow_fallback_coverage` — どれも「フィールドを 1 つ読む」「ハッシュマップを 1 回引く」程度の保持時間だ。

そして重要なのは、`SpinLock` を握ったまま `IOResult::IO` を返してはいけないことだ。返した瞬間に呼び出し元へ制御が戻り、スピンしている他のスレッドは永久に回り続ける。前ページで見た `DATABASE_MANAGER` の注意書きと同じ問題で、**同期ロックと手書き状態機械の組み合わせでは「ロックを握る区間が yield をまたがない」が常に暗黙の要件になる**。
