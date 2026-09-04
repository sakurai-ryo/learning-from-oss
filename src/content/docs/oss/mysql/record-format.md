---
title: "レコードの構造 — 5 バイトヘッダ、NULL ビットマップ、可変長ヘッダ"
description: "InnoDB の 1 行が実際に何バイトになるかを、origin という基準点から前後に伸びるバイト列として読む。5 バイトのヘッダに詰め込まれた info bits・n_owned・heap_no・status・next、逆順に並ぶ可変長列の長さ、NULL ビットマップ。COMPACT と DYNAMIC の違いが DICT_TF_HAS_ATOMIC_BLOBS 1 ビットの派生でしかないことと、Row size too large (> 8126) がどの計算から出るかを確定させる。"
group: "InnoDB — 物理構造"
sidebar:
  order: 48
---

> **前提**: [ページの構造](./page-layout/)

## 何を学んだか

InnoDB のレコードには **origin** という基準点がある。「レコードへのポインタ」と言うときはこの origin を指し、**ヘッダは origin より前 (低いアドレス側) に、データは origin から後ろに**置かれる。ページ内のレコードは `next` ポインタで繋がっているが、そのポインタも次のレコードの origin を指す。

COMPACT / DYNAMIC のレコードはこうなっている。

```
低アドレス                                                        高アドレス
+--------+-----+--------+-------------+---------+---------+--------------+
| 可変長列の長さ (逆順)  | NULL ビットマップ | 5 バイトヘッダ | データ (列順)  |
+--------+-----+--------+-------------+---------+---------+--------------+
 最後の列 ...  最初の列   ceil(n_nullable/8)      ↑
                                              origin

 5 バイトヘッダの中身 (origin からの相対位置、負方向)

  -5  | info bits (4 bit) | n_owned (4 bit)             |
  -4  | heap_no の上位 8 bit                            |
  -3  | heap_no の下位 5 bit | record status (3 bit)    |
  -2  | next レコードへの相対オフセット (2 バイト)        |
  -1  |                                                 |
 ---- origin ----
   0  | 最初の列のデータ                                 |
```

要点。

1. **可変長列の長さは逆順に並ぶ**。origin に近いほど前の列。列 1 の長さを読むのに列 20 の長さをスキップしなくて済む
2. **NULL ビットマップは nullable な列の分だけ**。`NOT NULL` の列はビットを消費しない。10 列すべて `NOT NULL` なら NULL ビットマップは 0 バイト
3. **ヘッダは 5 バイト固定**。`REC_N_NEW_EXTRA_BYTES = 5`。REDUNDANT だけ 6 バイト
4. **COMPACT と DYNAMIC は同じレコードヘッダを使う**。違うのは「大きい列をどう外に出すか」だけで、判定は `DICT_TF_HAS_ATOMIC_BLOBS` という 1 ビットから派生する述語 1 つだ
5. **1 レコードの列数上限は 1023**、うちユーザ列は 1017

## なぜそうなっているか

### なぜ origin が中間にあるのか

データ部分の開始位置を固定したいからだ。`next` ポインタが origin を指し、比較関数はそこから列を順に読む。ヘッダの長さが行フォーマットによって 5 バイトか 6 バイトか変わっても、**origin から先の読み方は同じ**でいられる。

さらに、可変長ヘッダは列数に応じて伸び縮みする。origin を境界に置いておけば、伸びるのは前方向だけで、データ部分のオフセット計算に影響しない。

### なぜ可変長列の長さが逆順なのか

コメントに理由がそのまま書いてある。

```cpp title="storage/innobase/rem/rem0rec.cc"
The offsets of the data fields are stored in an inverted
order because then the offset of the first fields are near the
origin, giving maybe a better processor cache hit rate in searches.
```

インデックスの比較は先頭の列から始まる。先頭の列の長さが origin のすぐ手前にあれば、レコードヘッダとまとめて同じキャッシュラインに乗る。`maybe` と書いてあるのが正直だ。

### なぜ `n_owned` がレコードヘッダにあるのか

[ページディレクトリ](./page-layout/)のスロットが所有するレコード数を、スロット側ではなく**所有される側の最後のレコード**に書いている。スロットは 2 バイトのオフセットだけで済み、ディレクトリを小さく保てる。4 ビットしかないので所有数は 15 が上限で、`PAGE_DIR_SLOT_MAX_N_OWNED = 8` はその範囲に余裕を持って収まる。

### なぜ delete-mark なのか

`DELETE` で物理的に消してしまうと、その行を読んでいる古いスナップショットが版を辿れなくなる。delete-mark されたレコードは `DB_ROLL_PTR` を持ったまま残り、[read view](./read-view-and-visibility/) から見て「まだ生きている」トランザクションには見え続ける。誰からも見えなくなった時点で purge が回収する。

`DELETE` した直後にテーブルが小さくならないのも、`DELETE` 直後の同じ範囲のスキャンが遅いのも、この delete-mark されたレコードを踏んでいるからだ。

## ソースコードのどこか

### レイアウトはコメントとして書かれている

正規のレイアウト仕様は [`storage/innobase/rem/rem0rec.cc#L94`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/rem/rem0rec.cc#L94) の「PHYSICAL RECORD (NEW STYLE)」というコメントにある。

```cpp title="storage/innobase/rem/rem0rec.cc"
| length of the last non-null variable-length field of data:
  if the maximum length is 255, one byte; otherwise,
  0xxxxxxx (one byte, length=0..127), or 1exxxxxxxxxxxxxx (two bytes,
  length=128..16383, extern storage flag) |
...
| length of first variable-length field of data |
| SQL-null flags (1 bit per nullable field), padded to full bytes |
| 1 or 2 bytes to indicate number of fields in the record if the table
  where the record resides has undergone an instant ADD COLUMN
  before this record gets inserted; If no instant ADD COLUMN ever
  happened, here should be no byte; So parsing this optional number
  requires the index or table information |
| 4 bits used to delete mark a record, and mark a predefined
  minimum record in alphabetical order |
| 4 bits giving the number of records owned by this record
  (this term is explained in page0page.h) |
| 13 bits giving the order number of this record in the
  heap of the index page |
| 3 bits record type: 000=conventional, 001=node pointer (inside B-tree),
  010=infimum, 011=supremum, 1xx=reserved |
| two bytes giving a relative pointer to the next record in the page |
ORIGIN of the record
```

**可変長列の長さの符号化が 2 パターンある**のがポイントだ。列の最大長が 255 バイト以下なら常に 1 バイト。そうでなければ、実際の長さが 127 以下なら 1 バイト (最上位ビット 0)、128 以上なら 2 バイトで、上位から 2 ビット目が「外部格納フラグ」になる。

つまり**最大長 255 バイト以下の列には外部格納フラグを置く場所がない**。これが後で「その列は外に出せない」という制約になる。

### 定数は private ヘッダにある

`include/` を探しても出てこない。レコードヘッダの定数は [`storage/innobase/rem/rec.h`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/rem/rec.h#L84) という、`rem/` 配下からしか include されないヘッダにある。

```cpp title="storage/innobase/rem/rec.h"
/* The offset of heap_no in a compact record */
constexpr uint32_t REC_NEW_HEAP_NO = 4;
/* The shift of heap_no in a compact record.
The status is stored in the low-order bits. */
constexpr uint32_t REC_HEAP_NO_SHIFT = 3;
...
constexpr uint32_t REC_NEXT = 2;
...
constexpr uint32_t REC_NEW_STATUS = 3; /* This is single byte bit-field */
...
constexpr uint32_t REC_NEW_N_OWNED = 5; /* This is single byte bit-field */
...
constexpr uint32_t REC_NEW_INFO_BITS = 5; /* This is single byte bit-field */
```

数字は「origin から何バイト戻った位置か」だ。`REC_NEXT = 2` は origin の 2 バイト手前から 2 バイト、`REC_NEW_N_OWNED = 5` と `REC_NEW_INFO_BITS = 5` は同じ 1 バイトを上下のニブルで分け合う。

正しさは static_assert で保証されている。

```cpp title="storage/innobase/rem/rec.h"
static_assert((REC_NEW_STATUS_MASK << (8 * (REC_NEW_STATUS - 3)) ^
               REC_HEAP_NO_MASK << (8 * (REC_NEW_HEAP_NO - 4)) ^
               REC_N_OWNED_MASK << (8 * (REC_NEW_N_OWNED - 3)) ^
               REC_INFO_BITS_MASK << (8 * (REC_NEW_INFO_BITS - 3)) ^
               0xFFFFFFUL) == 0,
              "sum of new-style masks != 0xFFFFFFUL");
```

4 つのビットフィールドの XOR が `0xFFFFFF` — つまり **3 バイトを重複なく隙間なく使い切っている**。残り 2 バイトが `next` ポインタで、合わせて 5 バイト。

### info bits の 4 ビット

```cpp title="storage/innobase/rem/rec.h"
constexpr uint32_t REC_INFO_MIN_REC_FLAG = 0x10UL;
/** The deleted flag in info bits; when bit is set to 1, it means the record has
 been delete marked */
constexpr uint32_t REC_INFO_DELETED_FLAG = 0x20UL;
/* Use this bit to indicate record has version */
constexpr uint32_t REC_INFO_VERSION_FLAG = 0x40UL;
/** The instant ADD COLUMN flag. When it is set to 1, it means this record
was inserted/updated after an instant ADD COLUMN. */
constexpr uint32_t REC_INFO_INSTANT_FLAG = 0x80UL;
```

[L144-152](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/rem/rec.h#L144)。4 ビット全部埋まっている。

- `REC_INFO_DELETED_FLAG` (0x20) が **delete-mark**。`DELETE` はレコードを消さず、このビットを立てるだけだ。実際に消すのは purge ([purge のページ](./purge/))
- `REC_INFO_MIN_REC_FLAG` (0x10) は「非葉ページの最左ページの先頭レコード」につく。比較のとき無条件に最小として扱われる
- `REC_INFO_INSTANT_FLAG` (0x80) は 8.0.13 の instant ADD COLUMN、`REC_INFO_VERSION_FLAG` (0x40) は 8.0.29 の row version 用 ([INSTANT の実体](./instant-ddl-row-versions/))

### record status の 3 ビット

```cpp title="storage/innobase/rem/rec.h"
/* Record status values */
constexpr uint32_t REC_STATUS_ORDINARY = 0;
constexpr uint32_t REC_STATUS_NODE_PTR = 1;
constexpr uint32_t REC_STATUS_INFIMUM = 2;
constexpr uint32_t REC_STATUS_SUPREMUM = 3;
```

[L179](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/rem/rec.h#L179)。**同じヘッダ形式で、葉のレコードも node pointer も infimum / supremum も表現される**。だから[ページの構造](./page-layout/)で見た `infimum_supremum_compact` のバイト列に `0x02` / `0x0b` (= heap_no 1 << 3 | 3) が現れる。

### COMPACT と DYNAMIC の分岐点

行フォーマットは 4 つ (REDUNDANT / COMPACT / DYNAMIC / COMPRESSED) あるが、コード上の分岐軸は 2 本しかない。

```cpp title="storage/innobase/include/dict0mem.h"
/** Return the value of the ATOMIC_BLOBS field */
inline uint32_t DICT_TF_HAS_ATOMIC_BLOBS(uint32_t flags) {
  return (flags & DICT_TF_MASK_ATOMIC_BLOBS) >> DICT_TF_POS_ATOMIC_BLOBS;
}
```

[`dict0mem.h#L238`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/dict0mem.h#L238)。これを 1 行でラップしたのが述語だ。

```cpp title="storage/innobase/include/dict0dict.ic"
static inline bool dict_table_has_atomic_blobs(const dict_table_t *table) {
  return (DICT_TF_HAS_ATOMIC_BLOBS(table->flags));
}
```

[`dict0dict.ic#L465`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/dict0dict.ic#L465)。もう 1 本が `dict_table_is_comp` (= `DICT_TF_COMPACT`) で、REDUNDANT かそれ以外かを分ける。

| 行フォーマット | `is_comp` | `has_atomic_blobs` |
| -------------- | --------- | ------------------ |
| REDUNDANT      | false     | false              |
| COMPACT        | true      | false              |
| DYNAMIC        | true      | true               |
| COMPRESSED     | true      | true               |

**COMPACT と DYNAMIC でレコードヘッダは 1 バイトも変わらない**。変わるのは `has_atomic_blobs` から派生する 2 点だけだ。

1 点目、インデックスに使える列の最大長。

```cpp title="storage/innobase/include/dict0mem.h"
#define DICT_MAX_FIELD_LEN_BY_FORMAT(table)                              \
  (dict_table_has_atomic_blobs(table) ? REC_VERSION_56_MAX_INDEX_COL_LEN \
                                      : REC_ANTELOPE_MAX_INDEX_COL_LEN - 1)
```

[`dict0mem.h#L880`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/dict0mem.h#L880)。`REC_VERSION_56_MAX_INDEX_COL_LEN = 3072`、`REC_ANTELOPE_MAX_INDEX_COL_LEN = 768` ([`rem0types.h#L67`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/rem0types.h#L67))。**DYNAMIC なら 3072 バイト、COMPACT なら 767 バイト**。`ERROR 1071 (42000): Specified key was too long` の閾値がこれだ。

2 点目、大きい列を外に出すときにローカルに残す量。

```cpp title="storage/innobase/data/data0data.cc"
  if (!dict_table_has_atomic_blobs(index->table)) {
    /* up to MySQL 5.1: store a 768-byte prefix locally */
    local_len = BTR_EXTERN_FIELD_REF_SIZE + DICT_ANTELOPE_MAX_INDEX_COL_LEN;
  } else {
    /* new-format table: do not store any BLOB prefix locally */
    local_len = BTR_EXTERN_FIELD_REF_SIZE;
  }
```

[`dtuple_convert_big_rec` (`data0data.cc#L423`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/data/data0data.cc#L423)。COMPACT は 768 + 20 = 788 バイトをレコード内に残す。DYNAMIC は 20 バイトの参照だけ。これが「TEXT を 10 本持つテーブルが COMPACT では作れないが DYNAMIC なら作れる」の理由だ ([LOB のページ](./lob-storage/))。

### 外に出す判定 — 唯一の関数

行フォーマットに関わらず、「このレコードは大きすぎるか」を判定する関数は 1 つしかない。

```cpp title="storage/innobase/include/page0zip.ic"
static inline bool page_zip_rec_needs_ext(ulint rec_size, ulint comp,
                                          ulint n_fields,
                                          const page_size_t &page_size) {
  ut_ad(rec_size > (comp ? REC_N_NEW_EXTRA_BYTES : REC_N_OLD_EXTRA_BYTES));
  ut_ad(comp || !page_size.is_compressed());

  if (rec_size >= REC_MAX_DATA_SIZE) {
    return true;
  }

  if (page_size.is_compressed()) {
    ...
  }

  return (rec_size >= page_get_free_space_of_empty(comp) / 2);
}
```

[`page0zip.ic#L136`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/page0zip.ic#L136)。名前に `page_zip` とついているが**圧縮していないページにも使う**。`rec_needs_ext` という関数はツリー内に存在しない。

最後の行が本題だ。`page_get_free_space_of_empty(true) / 2` = `16252 / 2` = **8126**。1 レコードは空ページの空き容量の半分を超えてはいけない。超えたら列を外に出す。

`REC_MAX_DATA_SIZE = 16384` という上限も別にある。

```cpp title="storage/innobase/include/rem0rec.h"
/* The data size of record must be smaller than this because we reserve
two upmost bits in a two byte offset for special purposes */
constexpr ulint REC_MAX_DATA_SIZE = 16384;
```

[`rem0rec.h#L666`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/rem0rec.h#L666)。2 バイトのオフセットの上位 2 ビットをフラグに使っているので、表現できるオフセットが 14 ビット (16383) までしかない。

### REDUNDANT のオフセット配列

REDUNDANT は可変長列だけでなく**全列の終端オフセット**を持つ。1 バイトか 2 バイトかは、レコード全体のデータ長で決まる。

```cpp title="storage/innobase/include/rem0rec.h"
/* Maximum lengths for the data in a physical record if the offsets
are given in one byte (resp. two byte) format. */
constexpr ulint REC_1BYTE_OFFS_LIMIT = 0x7FUL;
constexpr ulint REC_2BYTE_OFFS_LIMIT = 0x7FFFUL;
```

[`rem0rec.h#L661`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/rem0rec.h#L661)。データ長が 127 バイト以下なら 1 バイトオフセット、そうでなければ 2 バイト。最上位ビットが SQL NULL フラグに使われるので、127 (= `0x7F`) と 32767 (= `0x7FFF`) が上限になる。2 バイト形式では上から 2 ビット目が「外部格納」を意味する (`REC_2BYTE_EXTERN_MASK = 0x4000`)。

**REDUNDANT には NULL ビットマップがない**。NULL はオフセットの最上位ビットで表す。列数が多いテーブルで REDUNDANT が不利なのはこのためだ (全列に 1〜2 バイト固定でかかる)。

### 列数の上限

```cpp title="storage/innobase/include/rem0types.h"
constexpr uint32_t REC_MAX_N_FIELDS = 1024 - 1;
...
constexpr uint32_t REC_MAX_N_USER_FIELDS =
    REC_MAX_N_FIELDS - DATA_N_SYS_COLS * 2;
```

[`rem0types.h#L44`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/rem0types.h#L44)。`heap_no` が 13 ビットなのとは別に、レコード内の列数が 10 ビット (REDUNDANT の `REC_OLD_N_FIELDS_MASK = 0x7FE`) で表されるので 1023 が上限。`DATA_N_SYS_COLS = 3` を 2 倍引くのは、redo からダミーのテーブルを再構成するときにシステム列を二重に数える経路があるからだとコメントに書いてある。

結果 `REC_MAX_N_USER_FIELDS = 1017`。`CREATE TABLE` はここで弾かれる。

```cpp title="storage/innobase/handler/ha_innodb.cc"
  if (m_form->s->fields > REC_MAX_N_USER_FIELDS) {
    return HA_ERR_TOO_MANY_FIELDS;
  }
```

[`ha_innodb.cc#L13806`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L13806)。MySQL のドキュメントにある「1 テーブル 1017 列」という数字は、ここから出ている。

## どう活かすか

### `Row size too large (> 8126)` が出たとき

エラーメッセージのとおり `Changing some columns to TEXT or BLOB may help` だが、なぜ効くのかは上の判定式で説明できる。

- 判定は **`page_zip_rec_needs_ext` 1 つ**。レコード全体が 8126 バイトを超えると、[`dtuple_convert_big_rec`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/data/data0data.cc#L423) が「一番節約になる列」から順に外に出していく
- 外に出せるのは**可変長で、NULL でなく、最大長が 255 バイトを超える列**だけ。`VARCHAR(100)` は utf8mb4 でも最大 400 バイトなので出せるが、`VARCHAR(50)` (最大 200 バイト) は出せない
- したがって `VARCHAR(50)` を 100 本並べたテーブルは、**どの列も外に出せず**、DYNAMIC でも通らない。列を減らすかテーブルを分けるしかない
- COMPACT のテーブルなら、まず `ROW_FORMAT=DYNAMIC` にするだけで解決することが多い。外に出す列 1 本あたり 788 バイト → 20 バイトになるからだ

エラーメッセージが `In current row format, BLOB prefix of %d bytes is stored inline` で 768 と表示していたら COMPACT または REDUNDANT、0 と表示していたら DYNAMIC / COMPRESSED だと分かる。

### `Specified key was too long; max key length is 767 bytes` が出たとき

`ROW_FORMAT` が COMPACT / REDUNDANT のままだ。DYNAMIC にすれば 3072 バイトになる。8.0 以降の既定は `innodb_default_row_format=dynamic` なので、このエラーが出るときはたいてい `CREATE TABLE ... ROW_FORMAT=COMPACT` が明示されているか、古いバージョンから引き継いだテーブルだ。

`SELECT NAME, ROW_FORMAT FROM INFORMATION_SCHEMA.INNODB_TABLES` で確認できる。

### 列を `NOT NULL` にすると本当に小さくなる

NULL ビットマップは `ceil(nullable な列数 / 8)` バイト。80 列すべて nullable なら 10 バイト、すべて `NOT NULL` なら 0 バイト。1 行あたり 10 バイトは、1000 万行で 100MB だ。

加えて `NOT NULL` の固定長列はクラスタードインデックスの `trx_id_offset` の計算に乗る ([クラスタードインデックス](./clustered-index/))。PK が固定長かつ `NOT NULL` なら `DB_TRX_ID` の位置が定数になり、読み出しが 1 段速くなる。

### 「列を 1000 本」は物理的に無理

1017 が上限だが、実際に効くのは先に 8126 の方だ。1000 列のテーブルは、平均 8 バイトを超えた時点でレコードが入らない。列数が数百に達しているスキーマは、行サイズの上限にぶつかる前提で設計を見直したほうがいい。

### `DELETE` 直後のスキャンが遅い

delete-mark されたレコードはページに残り続け、purge が回るまで走査対象になる。`PAGE_GARBAGE` にバイト数が積算されるが、ページの再編成が起きるまで回収されない。大量 `DELETE` の直後に同じ範囲を `SELECT` すると、生きた行が 0 件でも数千レコードを読む。

`SHOW ENGINE INNODB STATUS` の `History list length` が伸びているなら purge が追いついていない ([purge のページ](./purge/))。
