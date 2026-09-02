---
title: "disk_btree — 不変な B-tree"
description: "レイヤファイルの索引は自前の B-tree だ。挿入も削除もできない。一括構築しかできない代わりに、平衡化もページ分割の同時実行制御も要らない。「後から変更しない」という制約が、どれだけ実装を削るかの実例。"
group: "pageserver — ストレージ"
sidebar:
  order: 31
---

## 何を学んだか

レイヤファイルの索引部は B-tree で、`disk_btree.rs` に自前実装がある。特徴の列挙が身も蓋もない。

```rust title="pageserver/src/tenant/disk_btree.rs"
//! Simple on-disk B-tree implementation
//!
//! This is used as the index structure within image and delta layers
//!
//! Features:
//! - Fixed-width keys
//! - Fixed-width values (VALUE_SZ)
//! - The tree is created in a bulk operation. Insert/deletion after creation
//!   is not supported
//! - page-oriented
```

([pageserver/src/tenant/disk_btree.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/disk_btree.rs#L1))

**「作成後の挿入と削除はサポートしない」。**

これで消えるものを数えると、B-tree 実装のほとんどになる。

| 通常の B-tree に要るもの | ここでは                                          |
| ------------------------ | ------------------------------------------------- |
| ページ分割               | 不要 (追記で自然に埋まる)                         |
| ページ結合・再分配       | 不要 (削除がない)                                 |
| 平衡化                   | 不要 (下から順に積むので自動的に平衡)             |
| 空き領域管理             | 不要                                              |
| ラッチ (同時実行制御)    | 不要 (作成中は単一スレッド、作成後は読み取り専用) |
| WAL / リカバリ           | 不要 (ファイルごと不変)                           |

**残るのは「積み上げる」と「二分探索する」だけ。** レイヤファイルが不変であるという上位の設計判断が、そのまま索引実装の削減になっている。

## 5 バイトの値に 2 つの意味を詰める

```rust title="pageserver/src/tenant/disk_btree.rs"
// The maximum size of a value stored in the B-tree. 5 bytes is enough currently.
pub const VALUE_SZ: usize = 5;
pub const MAX_VALUE: u64 = 0x007f_ffff_ffff;
```

値は 5 バイト固定。40 ビットのうち最上位 1 ビットが型タグになっている。

```rust title="pageserver/src/tenant/disk_btree.rs"
    fn from_u64(x: u64) -> Value {
        assert!(x <= 0x007f_ffff_ffff);
        /* ... */
    }

    fn from_blknum(x: u32) -> Value {
        Value([
            0x80,
            (x >> 24) as u8,
            /* ... */
        ])
    }

    fn is_offset(self) -> bool {
        self.0[0] & 0x80 != 0
    }
```

([pageserver/src/tenant/disk_btree.rs L46](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/disk_btree.rs#L46))

- **最上位ビットが 0** → 葉の値 (values 部へのバイトオフセット、最大 512GB)
- **最上位ビットが 1** → 内部ノードの downlink (子ページのブロック番号)

**葉と内部ノードで、同じ 5 バイトの領域を違う意味で使う。** ノード自体に `level` フィールドがあるので、どちらとして読むかは文脈で決まる。

5 バイトという幅は「今のところこれで足りる」という理由で選ばれている。オフセットに 39 ビット (512GB) は、レイヤファイル 1 つのサイズとしては十分すぎる。

## ノードの構造 — プレフィックス圧縮

```rust title="pageserver/src/tenant/disk_btree.rs"
/// This is the on-disk representation.
struct OnDiskNode<'a, const L: usize> {
    // Fixed-width fields
    num_children: u16,
    level: u8,
    prefix_len: u8,
    suffix_len: u8,

    // Variable-length fields. These are stored on-disk after the fixed-width
    // fields, in this order. In the in-memory representation, these point to
    // the right parts in the page buffer.
    prefix: &'a [u8],
    keys: &'a [u8],
    values: &'a [u8],
}
```

([pageserver/src/tenant/disk_btree.rs L111](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/disk_btree.rs#L111))

**1 ノードに入る全キーの共通プレフィックスを 1 回だけ持ち、残り (suffix) を固定長で並べる。**

キーは 18 バイト (delta layer なら key 18 + LSN 8 = 26 バイト) だが、隣接するキーは上位バイトがほとんど同じになる。同じリレーションの連続ブロックなら、違うのは最後の 4 バイトだけだ。

圧縮は「入らなくなったとき」に走る。

```rust title="pageserver/src/tenant/disk_btree.rs"
        // It did not fit. Try to compress, and if it succeeds to make
        // some room on the node, try appending to it again.
        if last.compress() {
            if last.push(key, value) {
                return Ok(());
            }
        }

        // Could not append to the current leaf. Flush it and create a new one.
        self.flush_node()?;
```

([pageserver/src/tenant/disk_btree.rs L606](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/disk_btree.rs#L606))

**遅延圧縮。** 毎回圧縮すると、キーを追加するたびに共通プレフィックスが縮んで、キー配列を書き直すことになる。溢れるまで待てば、書き直しは 1 ノードにつき最大 1 回で済む。

圧縮の中身は「最初のキーと最後のキーの共通プレフィックスを取る」だけだ。

```rust title="pageserver/src/tenant/disk_btree.rs"
    fn compress(&mut self) -> bool {
        let first_suffix = self.first_suffix();
        let last_suffix = self.last_suffix();

        // Find the common prefix among all keys
        let mut prefix_len = 0;
        while prefix_len < self.suffix_len {
            if first_suffix[prefix_len] != last_suffix[prefix_len] {
                break;
            }
            prefix_len += 1;
        }
```

([pageserver/src/tenant/disk_btree.rs L750](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/disk_btree.rs#L750))

**キーがソート済みなので、最初と最後だけ見れば全体の共通プレフィックスが分かる。** 中間のキーを走査する必要がない。ソート済みという前提が、O(n) を O(1) にしている。

## 構築 — スタックが木の高さになる

```rust title="pageserver/src/tenant/disk_btree.rs"
pub struct DiskBtreeBuilder<W, const L: usize>
{
    writer: W,

    ///
    /// `stack[0]` is the current root page, `stack.last()` is the leaf.
    ///
    stack: Vec<BuildNode<L>>,

    /// Last key that was appended to the tree. Used to sanity check that append
    /// is called in increasing key order.
    last_key: Option<[u8; L]>,
}
```

([pageserver/src/tenant/disk_btree.rs L543](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/disk_btree.rs#L543))

**スタックの深さが、そのまま木の高さになる。** 各レベルにつき「今埋めている途中のノード」が 1 つだけあればいい。

葉が満杯になったら書き出し、親に downlink を追加する。親も満杯なら同じことを繰り返す。

```rust title="pageserver/src/tenant/disk_btree.rs"
    /// Flush the bottommost node in the stack to disk. Appends a downlink to its parent,
    /// and recursively flushes the parent too, if it becomes full. If the root page becomes full,
    /// creates a new root page, increasing the height of the tree.
    fn flush_node(&mut self) -> Result<()> {
        let last = self.stack.pop().expect("should always have at least one item");
        let buf = last.pack();
        let downlink_key = last.first_key();
        let downlink_ptr = self.writer.write_blk(buf)?;

        // Append the downlink to the parent. If there is no parent, ie. this was the root page,
        // create a new root page, increasing the height of the tree.
        if self.stack.is_empty() {
            self.stack.push(BuildNode::new(last.level + 1));
        }
        self.append_internal(&downlink_key, Value::from_blknum(downlink_ptr))
    }
```

([pageserver/src/tenant/disk_btree.rs L632](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/disk_btree.rs#L632))

**親への downlink 追加が `append_internal` の再帰呼び出しになっている。** つまり「葉にキーを追加する」と「内部ノードに downlink を追加する」が同じコードだ。値の型タグが違うだけで、溢れたときの扱いも同じ。

**根は最後まで書かれない。** 全部のキーを追加し終わってから `finish()` がスタックを下から順に flush し、最後に残った根のブロック番号を返す。

```rust title="pageserver/src/tenant/disk_btree.rs"
    /// Flushes everything to disk, and returns the block number of the root page.
    /// The caller must store the root block number "out-of-band", and pass it
    /// to the DiskBtreeReader::new() when you want to read the tree again.
    /// (In the image and delta layers, it is stored in the beginning of the file,
    /// in the summary header)
```

**根の位置が固定されないので、外に持つ必要がある。** それが summary の `index_root_blk` だ ([delta layer と image layer](../layer-kinds/))。

一般の B-tree では根の位置を固定 (ブロック 0 など) するが、それには「後から書き戻す」が要る。ここでは追記のみなので、根が最後になる。**「追記のみ」を貫くと、根の位置が動く。**

## 不変条件をエラー型で表す

```rust title="pageserver/src/tenant/disk_btree.rs"
pub enum DiskBtreeError {
    #[error("Attempt to append a value that is too large {0} > {}", MAX_VALUE)]
    AppendOverflow(u64),

    #[error("Unsorted input: key {key:?} is <= last_key {last_key:?}")]
    UnsortedInput { key: Box<[u8]>, last_key: Box<[u8]> },

    #[error("Could not push to new leaf node")]
    FailedToPushToNewLeafNode,
    /* ... */
}
```

([pageserver/src/tenant/disk_btree.rs L93](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/disk_btree.rs#L93))

**「呼び出し側が守るべき契約」が、そのままエラー型になっている。** ソート順で渡すこと、値が 5 バイトに収まること。

`FailedToPushToNewLeafNode` は「空のノードにすら入らなかった」という意味で、実質的にはあり得ないケースだ (キー 1 個がページに入らないほど大きい)。それでも panic ではなくエラーにしてある。

`stack` の不変条件は、コメントで守られている。

```rust title="pageserver/src/tenant/disk_btree.rs"
    /// We maintain the length of the stack to be always greater than zero.
    /// Two exceptions are:
    /// 1. `Self::flush_node`. The method will push the new node if it extracted the last one.
    ///    So because other methods cannot see the intermediate state invariant still holds.
    /// 2. `Self::finish`. It consumes self and does not return it back,
    ///    which means that this is where the structure is destroyed.
    ///    Thus stack of zero length cannot be observed by other methods.
```

**「不変条件が破れる区間はあるが、他のメソッドからは観測できない」**という論証を書いている。`expect()` を使っている箇所の根拠になる。

## 直していない改善案

冒頭の TODO が 3 つ挙がっている。

```rust title="pageserver/src/tenant/disk_btree.rs"
//! TODO:
//! - maybe something like an Adaptive Radix Tree would be more efficient?
//! - the values stored by image and delta layers are offsets into the file,
//!   and they are in monotonically increasing order. Prefix compression would
//!   be very useful for them, too.
//! - An Iterator interface would be more convenient for the callers than the
//!   'visit' function
```

2 つ目が具体的で効きそうだ。**値 (ファイル内オフセット) も単調増加するので、キーと同じプレフィックス圧縮が効く。** 実装されていない。

索引のサイズはレイヤファイルのサイズに直結し、それは S3 の転送量と読み取りレイテンシに効く。それでも手が付いていないのは、優先度の問題だろう。**「効くと分かっているが、まだ困っていない」最適化として残されている。**

## この先に効いてくること

- **不変であるという上位の判断が、索引実装のほとんどを削る。** 分割も結合も平衡化もラッチも要らない。
- **1 ビットの型タグで、葉と内部ノードの値を同居させる。**
- **圧縮は溢れたときだけ。** 書き直しの回数を最小化する。
- **追記のみを貫くと、根が最後になる。** 位置を外に持つ必要が出る。
- **契約はエラー型で表す。** ソート済み入力、値の上限。
