---
title: "キー空間 — Postgres のファイル世界を 1 本の軸に潰す"
description: "6 フィールドの構造体が、リレーションのページも SLRU も DB 一覧も同じ順序付き空間に置く。18 バイトのキーが実は 128 ビットに収まること、そして密な領域と疎な領域を分けたことが、レイヤ設計を成立させている。"
group: "pageserver — ストレージ"
sidebar:
  order: 28
---

## 何を学んだか

pageserver が扱うのは、たった 1 種類のデータ構造だ。**キーから値への、LSN でバージョン管理された写像。**

```rust title="libs/pageserver_api/src/key.rs"
/// Key used in the Repository kv-store.
///
/// The Repository treats this as an opaque struct, but see the code in pgdatadir_mapping.rs
/// for what we actually store in these fields.
pub struct Key {
    pub field1: u8,
    pub field2: u32,
    pub field3: u32,
    pub field4: u32,
    pub field5: u8,
    pub field6: u32,
}
```

([libs/pageserver_api/src/key.rs L14](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L14))

フィールドに名前が付いていない。**「ストレージ層はこれを不透明な順序付きキーとして扱う」**という宣言で、意味を知っているのは `pgdatadir_mapping.rs` だけになっている。

層の分離としてはきれいだ。レイヤ、compaction、GC、ブランチ、シャーディング — 全部この「順序付きの 18 バイト」だけを知っていればいい。Postgres の概念は 1 つも要らない。

## field1 が名前空間になる

実際の使い分けは定数として集約されている。

```rust title="libs/pageserver_api/src/key.rs"
/// The key prefix start range for the metadata keys. All keys with the first byte >= 0x60 is a metadata key.
pub const METADATA_KEY_BEGIN_PREFIX: u8 = 0x60;
pub const METADATA_KEY_END_PREFIX: u8 = 0x7F;

/// The (reserved) key prefix of relation sizes.
pub const RELATION_SIZE_PREFIX: u8 = 0x61;

/// The key prefix of AUX file keys.
pub const AUX_KEY_PREFIX: u8 = 0x62;

/// The key prefix of ReplOrigin keys.
pub const REPL_ORIGIN_KEY_PREFIX: u8 = 0x63;

/// The key prefix of db directory keys.
pub const DB_DIR_KEY_PREFIX: u8 = 0x64;

/// The key prefix of rel directory keys.
pub const REL_DIR_KEY_PREFIX: u8 = 0x65;
```

([libs/pageserver_api/src/key.rs L40](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L40))

- `0x00` — リレーションのブロック ([リレーションはファイルである](../relation-files/))
- `0x01` — SLRU ([MVCC・xid・SLRU](../mvcc-and-xid/))
- `0x60` 以上 — メタデータキー

**`0x60` を境に、性質の違う 2 つの領域に分かれている。** これが後述する「密と疎」の分割になる。

## 18 バイトのキーが 128 ビットに入る理由

```rust title="libs/pageserver_api/src/key.rs"
/// The storage key size.
pub const KEY_SIZE: usize = 18;
```

`1 + 4 + 4 + 4 + 1 + 4 = 18` バイト = 144 ビット。しかし内部では `i128` で持ちたい。

```rust title="libs/pageserver_api/src/key.rs"
/// When working with large numbers of Keys in-memory, it is more efficient to handle them as i128 than as
/// a struct of fields.
pub struct CompactKey(i128);
```

そこで、フィールドを削って詰める。

```rust title="libs/pageserver_api/src/key.rs"
    /// 'field2' is used to store tablespaceid for relations and small enum numbers for other relish.
    /// As long as Neon does not support tablespace (because of lack of access to local file system),
    /// we can assume that only some predefined namespace OIDs are used which can fit in u16
    pub fn to_i128(&self) -> i128 {
        assert!(self.is_i128_representable(), "invalid key: {self}");
        (((self.field1 & 0x7F) as i128) << 120)
            | (((self.field2 & 0xFFFF) as i128) << 104)
            | ((self.field3 as i128) << 72)
            | ((self.field4 as i128) << 40)
            | ((self.field5 as i128) << 32)
            | self.field6 as i128
    }
```

([libs/pageserver_api/src/key.rs L222](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L222))

削っているのは 2 か所。

- `field1` の最上位ビット (符号ビットのため。`i128` なので)
- **`field2` (tablespace OID) を 32 ビットから 16 ビットに**

後者の根拠が「Neon はテーブルスペースをサポートしないから、既定の OID しか出てこない」だ。

```rust title="libs/pageserver_api/src/key.rs"
    pub fn is_i128_representable(&self) -> bool {
        self.field2 <= 0xFFFF || self.field2 == 0xFFFFFFFF || self.field2 == 0x22222222
    }
```

**`0x22222222` という魔法の値が混ざっている。** どこかの特殊なキーが使っている値を、例外として通している。こういう定数が残るのは、抽象を「意味を持たない 6 フィールド」にしたことの副作用でもある。ストレージ層はキーの意味を知らないので、上位層が置いた値が制約に引っかかることを、こういう形でしか救えない。

そして検査は 2 段階ある。

```rust title="libs/pageserver_api/src/key.rs"
    /// This is a weaker version of `is_valid_key_on_write_path_strong` that simply
    /// checks if the key is i128 representable. Note that some keys can be successfully
    /// ingested into the pageserver, but will cause errors on generating basebackup.
    pub fn is_valid_key_on_write_path(&self) -> bool {
        self.is_i128_representable()
    }
```

([libs/pageserver_api/src/key.rs L211](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L211))

**弱い検査は取り込み時、強い検査 (テーブルスペースの検査を含む) は別のところで使う。** コメントが正直で、「弱い検査を通ったキーでも、basebackup 生成時にエラーになりうる」と書いてある。

取り込みで落とすと WAL の流れが止まる。だから取り込みは緩くしておき、問題は後で顕在化させる。**エラーを起こす場所を、影響の小さいほうにずらしている。**

## 密なキー空間と疎なキー空間

`0x60` 以上のメタデータキーは、他とは違う扱いを受ける。

```rust title="libs/pageserver_api/src/key.rs"
    pub fn is_sparse(self) -> bool {
        self.field1 >= METADATA_KEY_BEGIN_PREFIX && self.field1 < METADATA_KEY_END_PREFIX
    }
```

([libs/pageserver_api/src/key.rs L836](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L836))

**密 (dense) な領域**はリレーションのブロックだ。あるリレーションの 0 から N ブロックまでは全部存在する。だから「キー範囲 x..y の全キー」を読むことに意味があるし、image layer が「この範囲の全キーのスナップショット」を持てる。

**疎 (sparse) な領域**はメタデータだ。リレーション一覧、aux ファイル、replication origin。キーは飛び飛びに存在する。存在しないキーのほうが圧倒的に多い。

なぜ分けるかというと、**image layer の意味が変わるから**だ。image layer の定義はこうだった。

```rust title="pageserver/src/tenant/storage_layer/image_layer.rs"
//! It contains an image of all key-value pairs in its key-range. Any key
//! that falls into the image layer's range but does not exist in the layer,
//! does not exist.
```

([pageserver/src/tenant/storage_layer/image_layer.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/storage_layer/image_layer.rs#L1))

**「範囲内にあってレイヤにないキーは、存在しない」。** 疎な空間でこれをやると、存在しないキーの分まで「ない」ことを記録する image layer が要ることになる。範囲が広いと破綻する。

だから疎な領域では、削除を明示的な墓標で表す。

```rust title="libs/pageserver_api/src/key.rs"
/// A tombstone in the sparse keyspace, which is an empty buffer.
```

```rust title="libs/pageserver_api/src/key.rs"
impl RelDirExists {
    /// The value of the rel directory keys that indicates the existence of a relation.
    const REL_EXISTS_MARKER: Bytes = Bytes::from_static(b"r");
```

([libs/pageserver_api/src/key.rs L79](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L79))

**「リレーションが存在する」を、1 バイトの `"r"` という値で表す。** 削除は空バッファ (tombstone)。

`0x65` (rel dir) は、もともと 1 つのキーに全リレーション一覧を詰めていたものを、リレーションごとに 1 キーへ分解した結果だ ([リレーションはファイルである](../relation-files/))。`docs/rfcs/041-rel-sparse-keyspace.md` がその移行の記録になっている。

**1 つの巨大な値を、多数の小さなキーに割った。** 更新のたびに全体を書き直す問題は消えるが、代わりに「存在しないことを表現する」問題が生まれ、tombstone が要るようになった。

## 継承されるキーと、されないキー

ブランチの扱いにも例外がある。

```rust title="libs/pageserver_api/src/key.rs"
    /// Check if the key belongs to the inherited keyspace.
    fn is_inherited_sparse_key(self) -> bool {
        debug_assert!(self.is_sparse());
        self.field1 == RELATION_SIZE_PREFIX
    }

    pub const fn sparse_non_inherited_keyspace() -> Range<Key> {
        // The two keys are adjacent; if we will have non-adjancent keys in the future, we should return a keyspace
        const_assert!(AUX_KEY_PREFIX + 1 == REPL_ORIGIN_KEY_PREFIX);
```

([libs/pageserver_api/src/key.rs L840](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L840))

通常、ブランチは親のキーを継承する。読みに行って自分になければ親を見る ([ブランチがコピーオンライトで実質無料になる理由](../branching-cow/))。

**aux ファイルと replication origin は継承しない。** replication slot の状態などが入っており、ブランチが親の replication 状態を引き継ぐと壊れる。

そして `const_assert!` が効いている。**「この 2 つのプレフィックスが隣接していること」をコンパイル時に検査する。** 隣接しているから 1 つの範囲で表現できる。将来隣接しなくなったら、範囲ではなく keyspace (範囲の集合) を返せ、とコメントが指示している。

**定数の間の暗黙の関係を、コンパイル時アサートで固定する。** 数値を 1 つ変えたときに、離れた場所のロジックが黙って壊れるのを防いでいる。

## この先に効いてくること

- **ストレージ層はキーの意味を知らない。** 順序付きの 18 バイトとしてしか扱わない。
- **表現の制約 (i128 に収める) が、機能の制約 (テーブルスペース非対応) と繋がっている。**
- **取り込みの検査は緩く、影響の小さいところで厳しく。** WAL の流れを止めない。
- **密と疎で image layer の意味が変わる。** 疎なら tombstone が要る。
- **定数の間の関係は `const_assert!` で固定する。**
