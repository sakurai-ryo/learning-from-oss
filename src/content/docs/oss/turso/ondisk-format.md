---
title: "ページ 0 のヘッダから cell まで、バイトを直接読む"
description: "`.db` ファイルの形式は SQLite とバイト単位で同じで、ここだけは 1 ビットも動かせない。100 バイトのヘッダ、4 種類のページ型、4 種類のセル、可変長整数、そして「値の型と長さを 1 つの整数に詰めた」シリアル型。ペイロードがページに収まるかどうかを決めるのは、255 分の 64 という奇妙な定数を含む式だ。"
group: "ページとディスク"
sidebar:
  order: 16
---

## この層の責務

ここから下は**動かせない層**だ。[互換性のページ](../sqlite-compat/) で見たとおり、`.db` ファイルはバイト単位で SQLite と同じでなければならない。sqlite3 で作ったファイルを Turso で開き、Turso が書いたファイルを sqlite3 で開けることが要求されている。

だから `core/storage/sqlite3_ondisk.rs` の 2,521 行は、**設計の余地がほとんどない**コードになっている。逆に言えば、ここを読むことは SQLite のファイル形式そのものを読むことになる。

上の層 ([Pager](../pager-responsibilities/) 以降) の制約はほぼ全部ここから来る。ページサイズ、セルの並び方、オーバーフローの閾値 — これらが決まっているから、B-tree の分割アルゴリズムもキャッシュの単位もそうなっている。

## 主要な型とその関係

### ヘッダは 100 バイトちょうど

```rust title="core/storage/sqlite3_ondisk.rs:320-366 (抜粋)"
pub struct DatabaseHeader {
    /// b"SQLite format 3\0"
    pub magic: [u8; 16],
    /// Page size in bytes. Must be a power of two between 512 and 32768 inclusive, or the value 1 representing a page size of 65536.
    pub page_size: PageSize,
    /// File format write version. 1 for legacy; 2 for WAL.
    pub write_version: RawVersion,
    pub read_version: RawVersion,
    /// Bytes of unused "reserved" space at the end of each page. Usually 0.
    pub reserved_space: u8,
    /// Maximum embedded payload fraction. Must be 64.
    pub max_embed_frac: u8,
    /// Minimum embedded payload fraction. Must be 32.
    pub min_embed_frac: u8,
    /// Leaf payload fraction. Must be 32.
    pub leaf_frac: u8,
    /// File change counter.
    pub change_counter: U32BE,
    /// Size of the database file in pages. The "in-header database size".
    pub database_size: U32BE,
    /// Page number of the first freelist trunk page.
    pub freelist_trunk_page: U32BE,
    pub freelist_pages: U32BE,
    /// The schema cookie.
    pub schema_cookie: U32BE,
    // ...
}
```

**構造体のサイズが 100 であることを、コンパイル時にアサートしている。**

```rust title="core/storage/sqlite3_ondisk.rs:369-375"
impl DatabaseHeader {
    pub const PAGE_ID: usize = 1;
    pub const SIZE: usize = size_of::<Self>();

    const _CHECK: () = {
        assert!(Self::SIZE == 100);
    };
```

`U32BE` / `I32BE` / `U16BE` はビッグエンディアンのニュータイプで、`#[repr(C)]` された構造体を**そのままバイト列として読み書きできる**ようにしてある。パースコードを書かず、レイアウトを型で表す方針だ。

`max_embed_frac: 64`、`min_embed_frac: 32`、`leaf_frac: 32` は「必ずこの値」とコメントされている。SQLite が可変にする道を残しつつ使っていない値で、Turso も固定値として持っているだけだ。

### ページ型は 4 つ

```rust title="core/storage/sqlite3_ondisk.rs:512-518"
#[repr(u8)]
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum PageType {
    IndexInterior = 2,
    TableInterior = 5,
    IndexLeaf = 10,
    TableLeaf = 13,
}
```

**判別子の値がそのままファイル上のバイト値だ。** 2、5、10、13 という飛び飛びの値も SQLite から引き継いでいる。

```rust title="core/storage/sqlite3_ondisk.rs:530-545 (抜粋)"
fn try_from(value: u8) -> Result<Self> {
    match value {
        2 => Ok(Self::IndexInterior),
        5 => Ok(Self::TableInterior),
        10 => Ok(Self::IndexLeaf),
        13 => Ok(Self::TableLeaf),
        _ => {
            mark_unlikely();
            Err(LimboError::Corrupt(format!("Invalid page type: {value}")))
        }
    }
}
```

**それ以外の値は `Corrupt`。** ファイル形式の検査が、型変換の関数として現れる。

「テーブルか索引か」「内部ノードか葉か」の 2 軸の掛け算になっている。ページヘッダのサイズもこの軸で変わる。

```rust title="core/storage/sqlite3_ondisk.rs:83-96"
pub const CELL_PTR_SIZE_BYTES: usize = 2;
pub const INTERIOR_PAGE_HEADER_SIZE_BYTES: usize = 12;
pub const LEAF_PAGE_HEADER_SIZE_BYTES: usize = 8;
pub const LEFT_CHILD_PTR_SIZE_BYTES: usize = 4;

pub const FREELIST_TRUNK_OFFSET_NEXT_TRUNK_PTR: usize = 0;
pub const FREELIST_TRUNK_OFFSET_LEAF_COUNT: usize = 4;
pub const FREELIST_TRUNK_OFFSET_FIRST_LEAF_PTR: usize = 8;
pub const FREELIST_TRUNK_HEADER_SIZE: usize = 8;
pub const FREELIST_LEAF_PTR_SIZE: usize = 4;
```

内部ノードのヘッダが 12 バイト、葉が 8 バイト。差の 4 バイトが「一番右の子ページ番号」だ。

### セルも 4 種類

```rust title="core/storage/sqlite3_ondisk.rs:782-822"
pub enum BTreeCell {
    TableInteriorCell(TableInteriorCell),
    TableLeafCell(TableLeafCell),
    IndexInteriorCell(IndexInteriorCell),
    IndexLeafCell(IndexLeafCell),
}

pub struct TableInteriorCell {
    pub left_child_page: u32,
    pub rowid: i64,
}

pub struct TableLeafCell {
    pub rowid: i64,
    /// Payload of cell, if it overflows it won't include overflowed payload.
    pub payload: &'static [u8],
    /// This is the complete payload size including overflow pages.
    pub payload_size: u64,
    pub first_overflow_page: Option<u32>,
}
```

**テーブルの内部ノードのセルには、キーとポインタしか入っていない。** 値は葉にしかない — B+ ツリーの形だ。

一方、索引の内部ノードのセルにはペイロードが入る。索引は B ツリー (B+ ではない) で、内部ノードにもキーの実体が置かれる。

`payload: &'static [u8]` が目を引く。この `'static` は嘘だ。

```rust title="core/storage/sqlite3_ondisk.rs:823-828 (抜粋)"
/// read_btree_cell contructs a BTreeCell which is basically a wrapper around pointer to the payload of a cell.
/// buffer input "page" is static because we want the cell to point to the data in the page in case it has any payload.
pub fn read_btree_cell(
    page: &'static [u8],
    page_content: &PageContent,
    pos: usize,
    usable_size: usize,
) -> Result<BTreeCell> {
```

**セルはページのバッファへのポインタでしかない。** コピーを作らないので、ページがキャッシュから追い出されるとダングリングになる。`'static` を名乗ることで借用検査を黙らせ、寿命の管理を人間に委ねている。

これが [ページキャッシュの pin](../page-cache-pin/) が必要な理由の 1 つだ。カーソルが立っているページは、追い出してはいけない。

### シリアル型 — 値の型と長さを 1 つの整数に詰める

```rust title="core/types.rs:2972-2991 (抜粋)"
/// Sqlite Serial Types
/// https://www.sqlite.org/fileformat.html#record_format
#[repr(transparent)]
pub struct SerialType(u64);

pub enum SerialTypeKind {
    Null, I8, I16, I24, I32, I48, I64, F64,
    ConstInt0, ConstInt1, Text, Blob,
}
```

```rust title="core/types.rs:3050-3056"
    pub const fn blob(size: u64) -> Self {
        Self(12 + size * 2)
    }

    pub const fn text(size: u64) -> Self {
        Self(13 + size * 2)
    }
```

0 から 9 までが固定長の型、**12 以上の偶数が BLOB、13 以上の奇数が TEXT** で、`(n - 12) / 2` がバイト長になる。1 つの整数に型と長さを詰め込む符号化だ。

10 と 11 は欠番になっている。

```rust title="core/types.rs:2994-2996"
#[inline(always)]
pub fn u64_is_valid_serial_type(n: u64) -> bool {
    n != 10 && n != 11
}
```

SQLite が内部用に予約している値で、ファイルに現れたら破損とみなす。

`ConstInt0` / `ConstInt1` (8 と 9) は**値を格納しない整数**だ。0 と 1 はそれ自体をシリアル型番号で表せるので、データ部が 0 バイトになる。真偽値をたくさん持つテーブルで効く。

### varint は 1〜9 バイト

```rust title="core/storage/sqlite3_ondisk.rs:1316-1332 (抜粋)"
pub fn read_varint(buf: &[u8]) -> Result<(u64, usize)> {
    let mut v: u64 = 0;
    for i in 0..8 {
        match buf.get(i) {
            Some(c) => {
                v = (v << 7) + (c & 0x7f) as u64;
                if (c & 0x80) == 0 {
                    return Ok((v, i + 1));
                }
            }
            // ...
        }
    }
    match buf.get(8) {
        Some(&c) => {
            // Values requiring 9 bytes must have non-zero in the top 8 bits (value >= 1<<56).
            // ...
```

**8 バイトまでは 7 ビットずつ、9 バイト目だけ 8 ビット全部。** 7 × 8 + 8 = 64 ビットちょうどになる。ビッグエンディアン順に積む点が、一般的な LEB128 と逆だ。

そして 9 バイト形式には正準性の検査がある。

```rust title="core/storage/sqlite3_ondisk.rs:1333-1340 (抜粋)"
// Values requiring 9 bytes must have non-zero in the top 8 bits (value >= 1<<56).
// Since the final value is `(v<<8) + c`, the top 8 bits (v >> 48) must not be 0.
// If those are zero, this should be treated as corrupt.
// Perf? the comparison + branching happens only in parsing 9-byte varint which is rare.
if unlikely((v >> 48) == 0) {
    bail_corrupt_error!("Invalid varint");
}
```

**8 バイトで表せる値を 9 バイトで書いたら破損扱い。** 同じ値に 2 通りの符号化があると、`.db` ファイルのハッシュ比較 (`tools/dbhash`) や差分テストが成立しなくなる。

## 処理の流れ (コードを追う)

### ペイロードがページに収まるかを決める式

セルのペイロードが大きいと、一部だけページに置いて残りをオーバーフローページに逃がす。その境界を決める式がこれだ。

```rust title="core/storage/btree.rs:9965-9974"
pub fn payload_overflow_threshold_max(page_type: PageType, usable_space: usize) -> usize {
    match page_type {
        PageType::IndexInterior | PageType::IndexLeaf => {
            ((usable_space - 12) * 64 / 255) - 23 // Index page formula
        }
        PageType::TableInterior | PageType::TableLeaf => {
            usable_space - 35 // Table leaf page formula
        }
    }
}
```

**テーブルと索引で式が違う。**

テーブルの葉は `usable_space - 35`。4 KiB ページなら 4061 バイトまで直接置ける。**1 ページに 1 セルしか入らなくてもよい**という設計で、行を丸ごとページに入れることを優先している。

索引は `(usable_space - 12) * 64 / 255 - 23`。4 KiB なら約 1002 バイト。**1 ページに最低 4 セル入る**ように制限している。索引は探索のために分岐度が要るので、1 ページ 1 キーでは木が深くなりすぎる。

`64 / 255` の 64 が、ヘッダの `max_embed_frac` と同じ値だ。「255 分の 64 ≒ 25%」を意味している。

最小側も定義されている。

```rust title="core/storage/btree.rs:9976-9990"
/// Returns the minimum payload size (M) that must be stored on the b-tree page before spilling to overflow pages is allowed.
///
/// For all page types: M = ((usable_size - 12) * 32/255) - 23
///
/// When payload size P exceeds max_local():
/// - If K = M + ((P-M) % (usable_size-4)) <= max_local(): store K bytes on page
/// - Otherwise: store M bytes on page
///
/// The remaining bytes are stored on overflow pages in both cases.
#[inline]
pub fn payload_overflow_threshold_min(_page_type: PageType, usable_space: usize) -> usize {
    // Same formula for all page types
    ((usable_space - 12) * 32 / 255) - 23
}
```

実際の判定はこうなる。

```rust title="core/storage/sqlite3_ondisk.rs:2176-2192"
pub fn payload_overflows(
    payload_size: usize,
    payload_overflow_threshold_max: usize,
    payload_overflow_threshold_min: usize,
    usable_size: usize,
) -> (bool, usize) {
    if payload_size <= payload_overflow_threshold_max {
        return (false, 0);
    }

    let mut space_left = payload_overflow_threshold_min
        + (payload_size - payload_overflow_threshold_min) % (usable_size - 4);
    if space_left > payload_overflow_threshold_max {
        space_left = payload_overflow_threshold_min;
    }
    (true, space_left + 4)
}
```

**剰余を取っている理由が面白い。** オーバーフローページ 1 枚には `usable_size - 4` バイト入る (4 バイトは次ページへのポインタ)。ページに残す量を「余りがちょうど収まる」ように選ぶと、**最後のオーバーフローページの無駄が最小になる**。

ただしその量が最大値を超えるなら諦めて最小値にする。この 2 段の判定が SQLite の挙動そのもので、**1 バイトでもずれると同じ行が別のバイト列になる**。

### `usable_space` は `page_size - reserved_space`

```rust title="core/storage/sqlite3_ondisk.rs:377-379"
pub fn usable_space(self) -> usize {
    (self.page_size.get() as usize) - (self.reserved_space as usize)
}
```

上の式が全部 `usable_space` で書かれているのは、**ページの末尾に予約領域を取れる**からだ。SQLite ではほとんど使われないが、Turso はここを 2 つの機能で使う。

- **暗号化** — nonce と認証タグをページ内に押し込む ([該当ページ](../encryption/))
- **チェックサム** — ページごとの検査値

`reserved_space` が増えると `usable_space` が減り、オーバーフローの閾値も下がる。**暗号化を有効にすると、行がオーバーフローしやすくなる。**

### freelist は「トランクページ + 葉ページ番号の配列」

```rust title="core/storage/sqlite3_ondisk.rs:92-96"
pub const FREELIST_TRUNK_OFFSET_NEXT_TRUNK_PTR: usize = 0;
pub const FREELIST_TRUNK_OFFSET_LEAF_COUNT: usize = 4;
pub const FREELIST_TRUNK_OFFSET_FIRST_LEAF_PTR: usize = 8;
pub const FREELIST_TRUNK_HEADER_SIZE: usize = 8;
pub const FREELIST_LEAF_PTR_SIZE: usize = 4;
```

空きページのリストは、**リンクリストではなく「リンクリストの配列」**になっている。トランクページ 1 枚が、次のトランクへのポインタと、空きページ番号の配列を持つ。

4 KiB ページなら 1 枚のトランクが約 1000 個の空きページを記録できる。ページを 1 枚解放するたびにディスクを 1 枚書く、という事態を避けるための構造だ。

ヘッダの `freelist_trunk_page` が先頭を、`freelist_pages` が総数を持つ。

## 守られている不変条件

**`DatabaseHeader` は 100 バイト。** コンパイル時アサート。

**ページ型は 2 / 5 / 10 / 13 のみ。** 他は `Corrupt`。

**varint は正準形でなければならない。** 8 バイトで足りる値の 9 バイト表現は `Corrupt`。

**シリアル型に 10 と 11 は現れない。**

**ペイロードの分割位置は式で一意に決まる。** SQLite と 1 バイトも違ってはいけない。

**セルのペイロードはページのバッファを借りている。** ページを追い出すとダングリング。

## つまずきどころ / 設計の含み

### `'static` の嘘が層をまたいで効いてくる

```rust
pub struct TableLeafCell {
    pub rowid: i64,
    pub payload: &'static [u8],
    // ...
}
```

`BTreeCell` を受け取った側は、**それがどのページを指しているかを型から知る手段がない**。ライフタイムを正しく書けば「このページが生きている間だけ有効」と表現できるが、そうすると `BTreeCursor` の内部でページとセルを同時に持てなくなる (自己参照構造になる)。

Rust で B-tree を書くときに最初にぶつかる問題で、Turso は**`'static` を名乗って人間が守る**方を選んでいる。守るための仕組みが上の層に 2 つある。

- **pin** — カーソルが踏んでいるページを追い出させない ([該当ページ](../page-cache-pin/))
- **`invalidate_record()`** — 他のカーソルが書き込んだら、キャッシュしたセルを捨てさせる ([カーソルのページ](../cursor-abstraction/))

**型で守れないものを、実行時の規約 2 つで守っている。** そしてその規約が破れていないことを、決定的シミュレータで確かめる ([該当ページ](../deterministic-simulator/))。

### `schema_format` が 4 固定

```rust title="core/storage/sqlite3_ondisk.rs:398 (Default 抜粋)"
schema_format: U32BE::new(4), // latest format, new sqlite3 databases use this format
```

SQLite のスキーマ形式 1〜4 のうち、新規作成は必ず 4。形式 4 は `DESC` 索引と真偽値リテラルをサポートする。古い形式のファイルを読むことはできるが、書くのは 4 だけだ。

### ヘッダに `version_number` が入っている

```rust title="core/storage/sqlite3_ondisk.rs:406-407 (Default 抜粋)"
version_valid_for: U32BE::new(3047000),
version_number: U32BE::new(3047000),
```

**最後に書き込んだ SQLite のバージョン番号**を、ファイルに残す欄がある。Turso はここに `3047000` (SQLite 3.47.0) を書く。

一方、`SqliteDialect` が報告するバージョンは別の値だ。

```rust title="core/dialect/sqlite.rs:21-24"
pub const SQLITE_VERSION: &str = "3.50.4";

/// Integer form of [`SQLITE_VERSION`] used by `sqlite3_libversion_number()`.
pub const SQLITE_VERSION_NUMBER: i32 = 3_050_004;
```

**API が名乗るバージョンとファイルに書くバージョンが違う。** どちらも「SQLite のふりをする」ための値だが、更新の追随がずれている。互換性を偽装する箇所が複数あると、こういうずれが生じる。

`SQLITE_VERSION` の側にはコメントで同期すべき箇所が列挙されている。

```rust title="core/dialect/sqlite.rs:16-20"
/// SQLite version reported by compatibility APIs.
///
/// This is the source of truth for the SQLite version Turso tracks. Keep
/// [`SQLITE_VERSION_NUMBER`], `scripts/install-sqlite3.sh`, README.md, and
/// COMPAT.md in sync when bumping it.
```

**4 箇所を手で同期する必要がある**と書いてあるが、`sqlite3_ondisk.rs` の `version_number` はその一覧に入っていない。

### `MINIMUM_CELL_SIZE = 4` の意味

```rust title="core/storage/sqlite3_ondisk.rs:81"
pub const MINIMUM_CELL_SIZE: usize = 4;
```

ページ内の空き領域は「フリーブロックの連結リスト」で管理され、リストのノードには次ポインタ (2 バイト) とサイズ (2 バイト) が要る。**4 バイト未満の隙間はリストに載せられない**ので、断片として捨てられる (SQLite の fragmented bytes)。

セルを削除するときにこの下限を意識する必要があり、[B-tree の書き込み](../btree-write/) で再登場する。ファイル形式の細かい制約が、そのままアルゴリズムの分岐になる典型例だ。
