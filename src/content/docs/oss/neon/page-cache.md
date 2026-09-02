---
title: "page_cache — もはやページのキャッシュではない"
description: "pageserver のメモリの大半を占めるキャッシュだが、キャッシュしているのは Postgres のページではない。レイヤファイルの索引ブロックだ。「不変なものしか入れない」と決めたことで、コヒーレンシの問題が丸ごと消えている。"
group: "pageserver — 実行時"
sidebar:
  order: 41
---

## 何を学んだか

```rust title="pageserver/src/page_cache.rs"
//! Global page cache
//!
//! The page cache uses up most of the memory in the page server. It is shared
//! by all tenants, and it is used to store different kinds of pages. Sharing
//! the cache allows memory to be dynamically allocated where it's needed the
//! most.
//!
//! The page cache consists of fixed-size buffers, 8 kB each to match the
//! PostgreSQL buffer size, and a Slot struct for each buffer to contain
//! information about what's stored in the buffer.
```

([pageserver/src/page_cache.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/page_cache.rs#L1))

構造は Postgres の共有バッファにそっくりだ ([共有バッファ](../buffer-manager/))。8KB のバッファ配列、スロットごとの記述子、usage count による clock sweep。定数まで同じになっている。

```rust title="pageserver/src/page_cache.rs"
const MAX_USAGE_COUNT: u8 = 5;
```

**Postgres の `BM_MAX_USAGE_COUNT` も 5 だ。** 実装者が Postgres のバッファマネージャを写しているのが分かる。

しかし、**キャッシュしている中身が違う。**

## 入るのは不変なものだけ

```rust title="pageserver/src/page_cache.rs"
//! # Types Of Pages
//!
//! [`PageCache`] only supports immutable pages.
//! Hence there is no need to worry about coherency.
//!
//! Two types of pages are supported:
//!
//! * **Immutable File pages**, filled & used by [`crate::tenant::block_io`] and [`crate::tenant::ephemeral_file`].
//!
//! Note that [`crate::tenant::ephemeral_file::EphemeralFile`] is generally mutable, but, it's append-only.
//! It uses the page cache only for the blocks that are already fully written and immutable.
```

**「不変なページしか入れない。だからコヒーレンシを気にしなくていい」。**

キーも 1 種類しかない。

```rust title="pageserver/src/page_cache.rs"
enum CacheKey {
    ImmutableFilePage { file_id: FileId, blkno: u32 },
}
```

([pageserver/src/page_cache.rs L130](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/page_cache.rs#L130))

`enum` なのにバリアントが 1 つ。**昔は複数あった痕跡**で、`#[allow(clippy::enum_variant_names)]` が付いているのがその名残になっている。

「不変」に絞ったことで消えるものは大きい。

| 通常のバッファプールに要るもの          | ここでは |
| --------------------------------------- | -------- |
| ダーティビット                          | 不要     |
| 書き戻し                                | 不要     |
| WAL 規則 (ログ先行)                     | 不要     |
| コヒーレンシ (誰かが書き換えたら無効化) | 不要     |
| チェックポイント                        | 不要     |

**残るのは「読み込む」「追い出す」だけ。** [disk_btree](../disk-btree/) が「不変だから B-tree の実装が半分になる」のと同じ構図が、ここでも起きている。

ephemeral file (インメモリレイヤの値を保持するファイル) は追記専用なので、**「もう書き終わった部分」だけをキャッシュに入れる。** 可変なものの中から不変な部分を切り出している。

## 何がキャッシュされないか

[ページ再構成のための vectored read](../vectored-read/) に、こう書かれていた。

> Note that the vectored blob api does _not_ go through the page cache.

**レイヤファイルの「値」の部分は、page cache に入らない。** 入るのは B-tree の索引ブロックだ。

なぜか。値を読むのは 1 回きりのことが多い。あるページを再構成したら、結果は compute の共有バッファと LFC に入るので、pageserver 側でまた同じ値を読む可能性は低い。**キャッシュしても当たらないものを入れると、当たるものを追い出す。**

一方、索引ブロックは何度も引かれる。B-tree の内部ノードは、そのレイヤへのどの検索でも通る。**アクセス頻度の偏りが極端なので、上位のノードだけでヒット率が稼げる。**

[page_service](../page-service/) の設定にもこれが現れていた。

> index blocks will be read into the PS PageCache from that task, with waiting. But data IOs are dispatched and waited upon from a sidecar task

**索引は同期で読む (キャッシュに当たれば速い)、データは非同期に逃がす (どうせディスクに行く)。** キャッシュの当たり方の違いが、並行化の設計にまで反映されている。

## 2 段のロックと、その順序

```rust title="pageserver/src/page_cache.rs"
//! There are two levels of locking involved: There's one lock for the "mapping"
//! from page identifier (tenant ID, timeline ID, rel, block, LSN) to the buffer
//! slot, and a separate lock on each slot.
//!
//! Whenever you need to hold both locks simultaneously, the slot lock must be
//! acquired first. This consistent ordering avoids deadlocks. To look up a page
//! in the cache, you would first look up the mapping, while holding the mapping
//! lock, and then lock the slot. You must release the mapping lock in between,
//! to obey the lock ordering and avoid deadlock.
```

**「スロットのロックを先に取る」という順序が決まっている。** そして検索は自然にその逆順になるので、**間にマッピングのロックを一度手放す。**

手放した隙に、そのスロットが別のページに割り当て直されているかもしれない。だから取り直した後で再確認が要る。**ロック順序を守るために、楽観的な再試行が発生する**という典型的な構造になっている。

## 無効な状態の後始末を型に任せる

```rust title="pageserver/src/page_cache.rs"
//! A slot can momentarily have invalid contents, even if it's already been
//! inserted to the mapping, but you must hold the write-lock on the slot until
//! the contents are valid. If you need to release the lock without initializing
//! the contents, you must remove the mapping first. We make that easy for the
//! callers with PageWriteGuard: the caller must explicitly call guard.mark_valid() after it has
//! initialized it. If the guard is dropped without calling mark_valid(), the
//! mapping is automatically removed and the slot is marked free.
```

**`mark_valid()` を呼ばずに guard を落とすと、マッピングが自動で消える。**

これは Rust の drop でしか書けない形の安全策だ。ファイルの読み込みに失敗しても、パニックしても、`?` で早期リターンしても、**「初期化されていないスロットがキャッシュに残る」ことがない。**

明示的な commit を要求し、暗黙の rollback を drop で実装する。**エラー処理を書き忘れても壊れない**構造になっている。

## 使い方の手順が doc に書いてある

```rust title="pageserver/src/page_cache.rs"
//! Users of page cache that wish to page-cache an arbitrary (immutable!) on-disk file do the following:
//! * Have a mechanism to deterministically associate the on-disk file with a [`FileId`].
//! * Get a [`FileId`] using [`next_file_id`].
//! * Use the mechanism to associate the on-disk file with the returned [`FileId`].
//! * Use [`PageCache::read_immutable_buf`] to get a [`ReadBufResult`].
//! * If the page was already cached, it'll be the [`ReadBufResult::Found`] variant (略)
//! * If the page was not cached, it'll be the [`ReadBufResult::NotFound`] variant that contains
//!   a write guard for the page. Fill the page (略)
//!   Then try again to [`PageCache::read_immutable_buf`].
//!   Unless there's high cache pressure, the page should now be cached.
//!   (TODO: allow downgrading the write guard to a read guard to ensure forward progress.)
```

**「埋めてから、もう一度読み直す」。** そして TODO が正直だ。**「キャッシュ圧が高いと、埋めた直後に追い出されて、また NotFound になるかもしれない」。**

理論上は無限ループしうる。書き込みガードを読み取りガードに降格できれば解決するが、実装されていない。**前進保証がないことを認識したうえで、実用上問題ないとして進めている。**

`FileId` の設計も要点がある。

```rust title="pageserver/src/page_cache.rs"
pub struct FileId(u64);

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
```

**ファイルパスではなく、プロセス起動ごとに払い出す連番。** パスは長く、比較もハッシュも遅い。しかも同じパスのファイルが作り直されることがある (レイヤの再ダウンロード)。

連番なら、**再ダウンロードされたファイルは新しい ID を得るので、古いキャッシュエントリと衝突しない。** 明示的な無効化が要らなくなる。「不変なものしかキャッシュしない」を、ファイルの同一性の定義まで貫いている。

## テナント間で共有する

```rust title="pageserver/src/page_cache.rs"
//! It is shared
//! by all tenants, and it is used to store different kinds of pages. Sharing
//! the cache allows memory to be dynamically allocated where it's needed the
//! most.
```

**テナントごとに区切らない。** 忙しいテナントが多く使う。

公平性の観点では危うい設計で、1 つのテナントがキャッシュを占有しうる。しかし pageserver には数百から数千のテナントが載っていて、そのほとんどはアイドルだ。**固定枠を切ると、使われない枠が大量にできる。**

clock sweep は自然に「よく使われるものが残る」性質を持つので、動的な配分がタダで手に入る。**公平性より利用率を取った**判断になっている。

## この先に効いてくること

- **「不変なものしか入れない」でコヒーレンシが消える。** ダーティビットも書き戻しもチェックポイントも要らなくなる。
- **キャッシュするものを選ぶ。** 値ではなく索引。当たらないものを入れると当たるものが追い出される。
- **明示的な commit と、drop による暗黙の rollback。** エラー処理を書き忘れても壊れない。
- **同一性を連番で定義すると、無効化が要らなくなる。**
- **多数のアイドルなテナントがいる環境では、固定枠より共有のほうが効く。**
