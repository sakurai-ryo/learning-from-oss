---
title: "ページキャッシュは「今カーソルが踏んでいるページ」を pin して守る"
description: "InnoDB のバッファプールがインスタンスに 1 個なのに対し、Turso のページキャッシュは接続ごとに既定 2000 ページしかない。しかも B-tree の分割は最大 20 段のスタックと複数の兄弟ページを同時に握る。追い出してはいけないページを守る仕組みが要る。置換方式は LRU ではなく SIEVE で、追い出し可能かどうかの判定に Arc の参照カウントまで使っている。そして最小サイズ 200 ページの根拠が、コメントに全部書いてある。"
group: "ストレージ層"
sidebar:
  order: 8
---

## 何を学んだか

MySQL のバッファプールは、インスタンスに 1 個あって数 GB ある。Turso のページキャッシュは **接続ごとに、既定 2000 ページ**しかない。

```rust title="core/storage/page_cache.rs"
#[cfg(not(target_family = "wasm"))]
const DEFAULT_PAGE_CACHE_SIZE_IN_PAGES: usize = 2000;
#[cfg(target_family = "wasm")]
const DEFAULT_PAGE_CACHE_SIZE_IN_PAGES: usize = 100000;
```

[`core/storage/page_cache.rs#L13-L16`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L13-L16)。

4KB ページなら 8MB だ。SQLite の既定と同じ考え方で、**アプリのプロセスに間借りしている以上、勝手に大量のメモリを取れない**。

WASM だけ 50 倍になっているのが面白い。**ブラウザにはそもそもファイルシステムがない** ので、追い出しても行き先がない。

小さいキャッシュには、大きいキャッシュにはない問題がある。**「今まさに使っているページ」を追い出してしまう** ことだ。B-tree の分割は、カーソルスタックの 20 ページと兄弟ページを同時に握る。ここで 1 枚でも追い出されると、木が壊れる。

## ソースコードのどこか

### 最小サイズの根拠が書いてある

```rust title="core/storage/page_cache.rs"
/// Minimum safe cache size in pages.
/// This accounts for:
/// - Btree cursor stack (up to BTCURSOR_MAX_DEPTH = 20 pages)
/// - Balance operations (MAX_SIBLING_PAGES_TO_BALANCE = 5 new pages)
/// - State machine pages (freelist operations, header refs, etc.)
/// - Some buffer for concurrent operations
pub const MINIMUM_PAGE_CACHE_SIZE_IN_PAGES: usize = 200;
```

[`core/storage/page_cache.rs#L18-L24`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L18-L24)。

**「これ以下にすると動かない」の内訳が全部並んでいる。** カーソルスタック、分割で新しく作られるページ、状態機械が保持するページ、そして余裕。

`PRAGMA cache_size` は利用者が自由に設定できる。**設定できる値に下限を設けるとき、その下限がどこから来たかを書いておかないと、後で「200 は多すぎでは」という議論に勝てない。**

数字の内訳を見ると、必要なのは 30 ページ程度に見える。残りは「状態機械が保持するページ」と「余裕」だ。**具体的に数えられない項目があることを隠していない。**

### 置換方式は LRU ではなく SIEVE

```rust title="core/storage/page_cache.rs"
/// PageCache implements a variation of the SIEVE algorithm that maintains an intrusive linked list queue of
/// pages which keep a 'reference_bit' to determine how recently/frequently the page has been accessed.
/// The bit is set to `Clear` on initial insertion and then bumped on each access and decremented
/// during eviction scans.
///
/// The ring is circular. `clock_hand` points at the tail (LRU).
/// Sweep order follows next: tail (LRU) -> head (MRU) -> .. -> tail
/// New pages are inserted after the clock hand in the `next` direction,
/// which places them at head (MRU) (i.e. `tail.next` is the head).
```

[`core/storage/page_cache.rs#L90-L98`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L90-L98)。

SIEVE は CLOCK に近い。**アクセスのたびにリストを繋ぎ替えるのではなく、ビットを立てるだけ。** 追い出すときに時計の針を回し、ビットが立っていれば下げて次へ、0 なら追い出す。

```rust title="core/storage/page_cache.rs"
const CLEAR: u8 = 0;
const REF_MAX: u8 = 3;
```

[`core/storage/page_cache.rs#L33-L34`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L33-L34)。

1 ビットではなく 0〜3 のカウンタになっている。**何度も触られたページは、それだけ多くの猶予を得る。**

InnoDB の LRU は「リストの中間に挿入して、2 回目のアクセスで先頭へ動かす」という凝った作りだが、**どちらも解こうとしている問題は同じ** だ。「1 回しか読まないスキャンで、キャッシュを流してしまう」を防ぎたい。SIEVE は繋ぎ替えなしでそれをやる。

### 追い出せる条件が 5 つある

```rust title="core/storage/page_cache.rs"
    #[inline]
    fn evictable(page: &PageRef) -> bool {
        (!page.is_dirty() || page.is_spilled())
            && !page.is_locked()
            && !page.is_pinned()
            && page.get().id.ne(&DatabaseHeader::PAGE_ID)
            && Arc::strong_count(page) == 1
    }
```

[`core/storage/page_cache.rs#L630-L637`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L630-L637)。

1 つずつ意味がある。

1. **ダーティなら追い出せない** — ただし `spilled` (WAL に先出し済み) なら追い出せる
2. **ロック中なら追い出せない** — I/O が進行中
3. **pin されていたら追い出せない** — 誰かが明示的に守っている
4. **ページ 1 は絶対に追い出さない** — ヘッダとスキーマの根がある
5. **`Arc::strong_count(page) == 1` でなければ追い出せない**

5 番目が面白い。**「キャッシュ以外の誰かが参照を持っている」= まだ使われている**、と判定している。明示的な pin と二重の網になっている。

pin は忘れうるが、参照カウントは忘れられない。**「守り忘れ」に対する最後の保険**として機能する。

### pin は RAII

```rust title="core/storage/btree.rs"
pub struct PinGuard(PageRef);
impl PinGuard {
    pub fn new(p: PageRef) -> Self {
        p.pin();
        Self(p)
    }
}

// Since every Drop will unpin, every clone
// needs to add to the pin count
impl Clone for PinGuard {
    fn clone(&self) -> Self {
        self.0.pin();
        Self(self.0.clone())
    }
}
```

```rust title="core/storage/btree.rs"
impl Drop for PinGuard {
    fn drop(&mut self) {
        self.0.try_unpin();
    }
}
```

[`core/storage/btree.rs#L397-L425`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L397-L425)。

`Clone` を手で実装している理由が、コメントにそのまま書いてある。**「Drop は必ず unpin するので、Clone も必ず pin しなければならない」。**

`#[derive(Clone)]` にしていたら、クローンした側が drop された瞬間に pin が外れる。**pin カウントと `PinGuard` の個数を一致させるのが、この型の唯一の役目**だ。

分割中に握るページも、この型で持っている。

```rust title="core/storage/btree.rs"
    pages_to_balance: [Option<PinGuard>; MAX_SIBLING_PAGES_TO_BALANCE],
```

[`core/storage/btree.rs#L482`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L482)。

**状態機械のフィールドとして持つので、[I/O yield をまたいでも pin が生き残る](../reentrancy/)。** ローカル変数に置いていたら、yield した瞬間に pin が外れて、再開する前に追い出されうる。

### 掃除は有限回で打ち切る

```rust title="core/storage/page_cache.rs"
        let mut examined = 0usize;
        let max_examinations = self.len().saturating_mul(REF_MAX as usize + 1);

        while examined < max_examinations {
```

```rust title="core/storage/page_cache.rs"
            } else if evictable {
                // Decrement ref bit and continue
                entry.decrement_ref();
                self.advance_clock_hand();
                examined += 1;
            } else {
                // Skip unevictable page
                self.advance_clock_hand();
                examined += 1;
            }
        }

        Err(CacheError::Full)
```

[`core/storage/page_cache.rs#L648-L703`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L648-L703)。

**全ページが追い出せない状態はありうる。** 全部ダーティ、全部 pin 済み。その場合に無限に針を回さないよう、上限を `ページ数 × (REF_MAX + 1)` にしている。

この回数なら、**どのページのカウンタも必ず 0 まで下がる**。それでも追い出せないなら、本当に追い出せない。

### 追い出せないなら、追い出せるようにする

キャッシュが埋まってきたとき、ただ諦めるのではなく **ダーティページを WAL に先出しして追い出し可能にする** 経路がある。

```rust title="core/storage/page_cache.rs"
/// The spill threshold as a fraction of capacity.
const DEFAULT_SPILL_THRESHOLD_PERCENT: usize = 90;
```

```rust title="core/storage/page_cache.rs"
    #[inline]
    fn spillable(page: &PageRef) -> bool {
        page.is_dirty()
            && !page.is_spilled()
            && !page.is_locked()
            && !page.is_pinned()
            && Arc::strong_count(page) == 1
            && page.get().id.ne(&DatabaseHeader::PAGE_ID)
            && page.get().overflow_cells.is_empty()
    }
```

[`core/storage/page_cache.rs#L26-L27`, `#L505-L513`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L505-L513)。

`evictable` とほぼ同じ条件に、**「オーバーフローセルを抱えていない」** が加わる。分割の途中で一時的に定員オーバーになっているページは、その状態でディスクに書けない。

集めた後の 1 行が効いている。

```rust title="core/storage/page_cache.rs"
        spillable.sort_by_key(|pg| pg.get().id);
```

[`core/storage/page_cache.rs#L584`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L584)。

**ページ番号順に並べてから書く。** WAL は追記なので位置は連続するが、ページ番号順に並べておくと後のチェックポイントで本体ファイルへ順に書ける。

結果は `PinGuard` の `Vec` で返る。**書き出しの間、そのページが追い出されないことを型で保証している。**

```rust title="core/storage/page_cache.rs"
pub enum SpillResult {
    /// No spilling was needed (cache is below threshold)
    NotNeeded,
    /// Spilling is needed but disabled
    Disabled,
    /// Successfully collected dirty pages to spill
    PagesToSpill(Vec<PinGuard>),
    /// Cache is at capacity with only unevictable pages
    CacheFull,
}
```

[`core/storage/page_cache.rs#L76-L87`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L76-L87)。

**「要らなかった」「無効にされている」「これを書き出せ」「もう無理」の 4 つが別々のバリアントになっている。** `Option<Vec<...>>` にすると、最初の 3 つが全部 `None` に潰れる。呼び出し側は違う対応をしたいので、潰してはいけない。

## なぜそうなっているか

- **キャッシュが接続ごとに小さいのは、アプリのプロセスに間借りしているから。** サーバなら「マシンのメモリの 70%」と言えるが、ライブラリはそう言えない。
- **小さいキャッシュでは pin が必須になるのは、「使用中のページ」が容量に対して無視できないから。** 100 万ページのキャッシュなら 20 ページのスタックは誤差だが、2000 ページなら 1% だ。しかも分割中はもっと握る。
- **SIEVE を選んだのは、アクセスのたびにリストを触りたくないから。** LRU はヒットのたびにポインタを繋ぎ替える。読み取りが支配的なワークロードでは、その繋ぎ替えがそのままコストになる。
- **`Arc::strong_count(page) == 1` を条件に入れたのは、pin の付け忘れに対する保険。** 明示的な pin は人間が書くので漏れる。参照を持っていること自体は漏れない。
- **`PinGuard` の `Clone` を手書きしたのは、`Drop` と対にするため。** RAII は「取得と解放の個数が一致する」ことが全てで、`Clone` を自動導出するとその対称性が壊れる。
- **pin を状態機械のフィールドに置くのは、yield をまたいで守る必要があるから。** ローカル変数の pin は、呼び出し元に帰った瞬間に消える。
- **掃除の回数に上限を置いたのは、追い出せる保証がないから。** 全ページがダーティで pin されている状況は起きうる。無限ループにするよりエラーを返す方がよい。
- **溢れそうなら先に書き出すのは、「追い出せない」を「追い出せる」に変えられるから。** ダーティであることが理由なら、書けば解消する。諦める前に打てる手がある。
- **結果を 4 通りの列挙にしたのは、呼び出し側の対応が 4 通りだから。** 「何もしない」「機能が無効」「書き出す」「エラー」を 1 つの `Option` に潰すと、区別が呼び出し側から見えなくなる。

## どう活かすか

- **キャッシュに下限を設けるなら、内訳をコメントに書く。** 「同時に握る必要がある要素の数」を列挙しておけば、後から下げようとした人が何を壊すか分かる。数えきれない項目は「余裕」と正直に書く。
- **「今使っているもの」を守る仕組みを、置換方式とは別に持つ。** LRU も SIEVE も「よく使われるか」を測る仕組みで、「今この瞬間に握られているか」は測れない。
- **その仕組みは RAII にして、`Clone` と `Drop` を対にする。** 取得と解放の個数が合っていることが全てなので、片方だけ自動導出しない。
- **明示的な保護に加えて、参照カウントのような「忘れられない指標」も条件に入れる。** 二重の網にしておくと、片方の付け忘れで壊れない。
- **待ち境界をまたぐ保護は、状態に持たせる。** ローカル変数に置いた保護は、中断した時点で消える。
- **掃除のループには必ず上限を置く。** 「必ず 1 個は追い出せる」は成り立たない。上限の値は「全要素のカウンタが 0 まで下がる回数」から導ける。
- **「もう空きがない」の前に、「空きを作れないか」を試す経路を用意する。** 追い出せない理由が可逆なら (ダーティなら書けばいい)、諦める前に解消できる。
- **結果の列挙は、呼び出し側の対応の数だけ用意する。** 「成功か失敗か」に潰すと、呼び出し側で区別できなくなり、後から分けるのが難しくなる。
