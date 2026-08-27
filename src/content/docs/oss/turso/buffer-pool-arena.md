---
title: "アリーナとビットマップで整列済みバッファを配り、io_uring にそのまま渡す"
description: "Turso の BufferPool は名前に反してキャッシュではない。mmap で取った連続領域をページサイズのスロットに切り、ロックフリーのビットマップで貸し出すアリーナだ。狙いは io_uring の固定バッファ登録で、登録できた 2 本のアリーナだけが ID 0 と 1 を取る。既定サイズが 3MB なのは、非特権プロセスの RLIMIT_MEMLOCK が 8MB だからだ。そして枯渇しても失敗せず、スレッドローカルの一時バッファに落ちる。"
sidebar:
  order: 9
---

## 何を学んだか

[アーキテクチャのページ](../architecture/) の対応表で注意書きを付けたとおり、Turso の `BufferPool` は InnoDB の buffer pool とは別物だ。

- **`PageCache`** — 「どのページをメモリに残すか」を決める。InnoDB の buffer pool に相当 ([前のページ](../page-cache-pin/))
- **`BufferPool`** — 「ページの中身を置くメモリをどこから取るか」を決める。**アロケータ**

この分離は、`io_uring` を使うために要る。

`io_uring` には **固定バッファ (registered buffer)** という仕組みがある。あらかじめカーネルにメモリ領域を登録しておくと、以降の読み書きでページのピン留めとアドレス変換のコストが省ける。ただし **「登録済み領域の中のメモリ」でなければ使えない**。

普通に `Vec<u8>` を確保していては、この最適化に乗れない。**「登録した領域から切り出す」専用のアロケータが要る。**

## ソースコードのどこか

### アリーナは 2 本だけ

```rust title="core/storage/buffer_pool.rs"
struct PoolInner {
    /// An instance of the program's IO, used for registering
    /// Arena's with io_uring.
    io: Option<Arc<dyn IO>>,
    /// An Arena which returns `ArenaBuffer`s of size `db_page_size`.
    page_arena: Option<Arc<Arena>>,
    /// An Arena which returns `ArenaBuffer`s of size `db_page_size`
    /// plus 24 byte `WAL_FRAME_HEADER_SIZE`, preventing the fragmentation
    /// or complex book-keeping needed to use the same arena for both sizes.
    wal_frame_arena: Option<Arc<Arena>>,
```

[`core/storage/buffer_pool.rs#L100-L110`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L100-L110)。

**サイズごとにアリーナを分ける。** ページ用と、WAL フレーム用 (ページサイズ + 24 バイトのヘッダ)。

理由がコメントに書いてある。**「1 本のアリーナで両方のサイズを扱うと、断片化するか、複雑な帳簿が要る」。**

サイズが 1 種類なら、スロットは全部同じ大きさで、空きスロットは全部同等に使える。**断片化という概念自体がなくなる。** 汎用アロケータの難しさの大半は、可変長を扱うことから来ている。それを引き受けない。

### アリーナサイズの根拠が具体的

```rust title="core/storage/buffer_pool.rs"
    /// 3MB Default size for each `Arena`. Any higher and
    /// it will fail to register the second arena with io_uring due
    /// to `RL_MEMLOCK` limit for un-privileged processes being 8MB total.
    pub const DEFAULT_ARENA_SIZE: usize = 3 * 1024 * 1024;
```

[`core/storage/buffer_pool.rs#L127-L130`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L127-L130)。

**3MB × 2 本 = 6MB で、非特権プロセスの `RLIMIT_MEMLOCK` 既定値 8MB に収まる。**

「なんとなく 3MB」ではなく、**OS の制限から逆算した値**だと明記されている。しかもその制限が「非特権プロセスの場合」であることまで書いてある。ライブラリとして配られる以上、root で動いている前提は置けない。

### 登録できたかどうかが、ID で分かる

```rust title="core/storage/buffer_pool.rs"
/// Slots 0 and 1 will be reserved for Arenas which are registered buffers
/// with io_uring.
const UNREGISTERED_START: u32 = 2;

/// ID's for an Arena which is not registered with `io_uring`
/// registered arena will always have id = 0..=1
static NEXT_ID: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(UNREGISTERED_START);
```

[`core/storage/buffer_pool.rs#L360-L369`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L360-L369)。

`io_uring` に登録すると、リングの登録済みバッファ配列における添字が返る。アリーナは 2 本なので、それは必ず 0 か 1 になる。

**登録できなかったアリーナには 2 以上の ID を振る。** すると判定はこれだけで済む。

```rust title="core/storage/buffer_pool.rs"
    #[inline(always)]
    /// Returns the `id` of the underlying arena, only if it was registered with `io_uring`
    pub const fn fixed_id(&self) -> Option<u32> {
        // Arenas which are not registered will have `id`s <= UNREGISTERED_START
        if self.arena_id < UNREGISTERED_START {
            Some(self.arena_id)
        } else {
            None
        }
    }
```

[`core/storage/buffer_pool.rs#L47-L57`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L47-L57)。

**フラグを別に持たず、ID の値域そのものに意味を持たせている。** 「登録済みか」と「登録番号は何番か」を 1 つの `u32` が両方答える。

登録の試行自体も、失敗を前提にしている。

```rust title="core/storage/buffer_pool.rs"
        let id = io
            .register_fixed_buffer(base, rounded_bytes)
            .unwrap_or_else(|_| {
                // Register with io_uring if possible, otherwise use next available ID
                let next_id = NEXT_ID.fetch_add(1, Ordering::AcqRel);
                tracing::trace!("Allocating arena with id {}", next_id);
                next_id
            });
```

[`core/storage/buffer_pool.rs#L389-L396`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L389-L396)。

**`io_uring` を使わないバックエンドでも、同じアリーナが動く。** 最適化に乗れないだけで、アリーナから切り出す仕組み自体は共通になる。

### 空きスロットはロックフリーのビットマップ

```rust title="core/storage/slot_bitmap.rs"
/// Lock-free atomic bitmap for tracking allocated slots in an arena.
///
/// Bit meaning:
/// - 1 = free
/// - 0 = allocated
///
/// `alloc_one` is lock-free (CAS retry bounded by contention, not blocking).
/// `free_one` is wait-free (single `fetch_or`).
pub(super) struct AtomicSlotBitmap {
    words: Box<[AtomicU64]>,
    n_slots: u32,
    /// Performance hint for where to start scanning. Not correctness-critical.
    next_word_hint: AtomicUsize,
}
```

[`core/storage/slot_bitmap.rs#L22-L34`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/slot_bitmap.rs#L22-L34)。

**1 が空きで 0 が使用中**、という向きが選ばれている。逆にすると解放が `fetch_and(!bit)` になるが、この向きなら `fetch_or(bit)` の 1 命令で済む。空きワードを探すのも `trailing_zeros` で引ける。

`next_word_hint` に **「正しさには関係ない」** と明記されているのがいい。この値が古くても、走査の開始位置がずれるだけだ。だから同期を一切気にしなくていい。**「正しさに関係ない」と書いてある変数は、レビューで飛ばせる。**

スロット数が 64 の倍数に丸められるのも、ワード単位で扱うためだ。

```rust title="core/storage/buffer_pool.rs"
        let min_slots = arena_size.div_ceil(slot_size);
        let rounded_slots = (min_slots.max(64) + 63) & !63;
```

[`core/storage/buffer_pool.rs#L374-L376`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L374-L376)。

### 枯渇しても失敗しない

```rust title="core/storage/buffer_pool.rs"
    /// Allocate a buffer of the given length from the pool, falling back to
    /// temporary thread local buffers if the pool is not initialized or is full.
    pub fn allocate(&self, len: usize) -> Buffer {
        ...
        // For all other sizes, use regular arena
        self.page_arena
            .as_ref()
            .and_then(|arena| Arena::try_alloc(arena, len))
            .unwrap_or_else(|| Buffer::new_temporary(len))
    }
```

[`core/storage/buffer_pool.rs#L241-L262`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L241-L262)。

**戻り値が `Option` ではなく `Buffer`。** アリーナが埋まっていても、初期化前でも、スロットサイズより大きい要求でも、必ず何かを返す。

```rust title="core/storage/buffer_pool.rs"
    pub fn try_alloc(arena: &Arc<Arena>, size: usize) -> Option<Buffer> {
        if size > arena.slot_size {
            // The buffer pool only supports single-slot allocations. Larger requests fall back to
            // temporary heap buffers via the caller.
            return None;
        }
```

[`core/storage/buffer_pool.rs#L407-L413`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L407-L413)。

**複数スロットにまたがる確保を、そもそもサポートしない。** これがあると空きスロットの連続性を管理する必要が生まれ、ビットマップ 1 個では済まなくなる。断片化が復活する。

**「できないことは、できないままにして、別の手段に落とす」。** アリーナの単純さは、この割り切りで保たれている。

返却は `Drop` で自動的に行われる。

```rust title="core/storage/buffer_pool.rs"
impl Drop for ArenaBuffer {
    fn drop(&mut self) {
        self.arena.free(self.slot_idx, self.logical_len());
    }
}
```

[`core/storage/buffer_pool.rs#L69-L73`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L69-L73)。

`ArenaBuffer` が `Arc<Arena>` を持っているので、**バッファが生きている限りアリーナも生きている**。アリーナが先に消えてダングリングポインタになることがない。

### ページサイズが分かるまで、アリーナを作れない

スロットサイズはページサイズで決まる。だがページサイズは **データベースファイルのヘッダを読むまで分からない**。そしてヘッダを読むにはバッファが要る。

```rust title="core/storage/buffer_pool.rs"
    /// Create a static `BufferPool` initialize the pool to the default page size, **without**
    /// populating the Arenas. Arenas will not be created until `[BufferPool::finalize_page_size]`,
    /// and the pool will temporarily return temporary buffers to prevent reallocation of the
    /// arena if the page size is set to something other than the default value.
    pub fn begin_init(io: &Arc<dyn IO>, arena_size: usize) -> Arc<Self> {
```

[`core/storage/buffer_pool.rs#L188-L192`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L188-L192)。

**卵と鶏を、フォールバック経路で断ち切っている。** ヘッダを読む間は一時バッファを使い、ページサイズが確定してからアリーナを作る。「枯渇しても失敗しない」設計が、ここでも効いている。

確定処理には競合対策が入っている。

```rust title="core/storage/buffer_pool.rs"
        // Tries to atomically (guarenteed by the OnceLock) initialize the page size for the inner pool.
        // If it succeeds, we now have to initialize the arenas.
        // If the initialization fails, this means the arenas have already been initialized by a previous thread
        // This avoids a potential TOCTOU race, where 2 threads could try to initalize the arena at the same time
        // after checking the `db_page_size`
        if inner.db_page_size.set(page_size).is_ok() {
            inner.init_arenas()?;
        };
```

[`core/storage/buffer_pool.rs#L219-L227`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/buffer_pool.rs#L219-L227)。

**`OnceLock::set()` の戻り値を「初期化権を取れたか」として使う。** 「まだ未設定か確かめてから設定する」だと 2 スレッドが同時に通る。設定の成否そのものを判定に使えば、勝者が 1 人に決まる。

## なぜそうなっているか

- **ページキャッシュとバッファ確保を分けたのは、`io_uring` の固定バッファに載せるため。** 「どのページを残すか」と「メモリをどこから取るか」は本来別の関心だが、固定バッファを使うなら後者を専用化する必要がある。
- **アリーナをサイズごとに分けたのは、可変長を扱いたくないから。** サイズが 1 種類なら、断片化も結合も最適合探索も要らない。ビットマップ 1 個で完結する。
- **アリーナサイズが 3MB なのは、`RLIMIT_MEMLOCK` から逆算しているから。** ライブラリとして配られる以上、特権があるとは仮定できない。既定値に収まる範囲で最大を取っている。
- **登録の成否を ID の値域で表したのは、状態を 2 つ持ちたくないから。** フラグと番号を別々に持つと、不整合な組み合わせ (登録済みなのに番号がない) が表現できてしまう。
- **ビットマップの 1 を「空き」にしたのは、解放を 1 命令にするため。** 解放は最も頻度が高く、しかも失敗が許されない。`fetch_or` なら CAS ループも要らない。
- **走査ヒントに「正しさに関係ない」と書いたのは、読む人の負荷を下げるため。** 並行コードでは、すべての共有変数が同期の検討対象に見える。関係ないものは、関係ないと書く。
- **確保が失敗しない形にしたのは、呼び出し側にエラー処理を増やしたくないから。** バッファの確保は至る所で起きる。すべてに「プールが枯れていたら」の分岐を書くのは現実的でない。
- **複数スロットの確保を許さないのは、それを許すと断片化が戻るから。** 「アリーナで扱えないものは、普通のヒープで扱う」と割り切ることで、アリーナが単純なままでいられる。
- **`OnceLock::set()` の戻り値で初期化権を決めるのは、TOCTOU を消すため。** 「確認してから実行」を「実行の成否で確認」に置き換えると、間に隙間がなくなる。

## どう活かすか

- **専用アロケータを作るなら、扱うサイズを 1 種類に固定する。** 汎用アロケータの難しさは可変長から来る。サイズごとにプールを分ければ、空きスロットの管理はビットマップだけで済む。
- **その代わり、扱えない要求は素直に汎用の経路へ落とす。** 「大きすぎる要求も何とかする」を目指した瞬間に、断片化と探索が戻ってくる。
- **プールからの確保は、失敗しない形にする。** 呼び出し箇所が多いものにエラーを返すと、そのエラー処理が全部にコピーされる。フォールバックを内側に持つ方が安い。
- **リソースの上限は、OS の制限から逆算して、根拠をコメントに書く。** 「なんとなく 3MB」と「非特権プロセスの `RLIMIT_MEMLOCK` が 8MB だから 3MB × 2」では、後から変えるときの安全性がまるで違う。
- **状態を持たせず、値域に意味を持たせられないか考える。** 「登録済みフラグ + 番号」より「番号の値域で判定」の方が、不整合な状態を表現できない。
- **並行コードの変数には、「正しさに関係ない」ものにその旨を書く。** 性能ヒントと不変条件が同じ見た目をしていると、読む側は全部を検討することになる。
- **初期化の順序に循環があるなら、フォールバック経路で断ち切る。** 「A を作るには B が要り、B を作るには A が要る」は、片方に「不完全でも動く版」があれば解ける。
- **初期化権の獲得は、「確認してから実行」ではなく「実行の成否」で決める。** `OnceLock::set()` や `compare_exchange` の戻り値を使えば、間に隙間ができない。
