---
title: "LOB — TEXT / BLOB / JSON はどこに置かれるか"
description: "大きい列がレコードの外に出る条件は page_zip_rec_needs_ext 1 つで、行フォーマットに関係なく同じ関数が使われる。外に出た列の跡地に残る 20 バイトの ref_t の中身を 1 バイト単位で読み、BTR_EXTERN_LEN の上位 3 ビットがフラグであることを確かめる。JSON の部分更新が in-place になる条件と、一度でも列を丸ごと置き換えると二度と部分更新されなくなる仕掛けも追う。"
group: "InnoDB — 物理構造"
sidebar:
  order: 63
---

> **前提**: [レコードの構造](./record-format/) / [ページの構造](./page-layout/)

## 何を学んだか

レコードが 1 ページの半分に収まらないとき、InnoDB は**一番節約になる可変長列**を選んで別ページに追い出す。追い出された列の跡地には **20 バイトの参照 (`lob::ref_t`)** が残る。

```
lob::ref_t の 20 バイト (FIELD_REF_SIZE = 20)

  オフセット
   0  +----------------------------------+  BTR_EXTERN_SPACE_ID
      | space id                    (4)  |
   4  +----------------------------------+  BTR_EXTERN_PAGE_NO
      | 先頭 LOB ページのページ番号   (4)  |
   8  +----------------------------------+  BTR_EXTERN_OFFSET
      | 旧形式: ページ内オフセット   (4)   |  = BTR_EXTERN_VERSION
      | 新形式: LOB バージョン番号        |
  12  +----------------------------------+  BTR_EXTERN_LEN
      | F | 長さ (8 バイトのうち下位 4)   |
      |                              (8) |
  20  +----------------------------------+

  BTR_EXTERN_LEN の先頭バイトの上位 3 ビットがフラグ
    bit 7 (0x80) BTR_EXTERN_OWNER_FLAG           このレコードは所有者でない
    bit 6 (0x40) BTR_EXTERN_INHERITED_FLAG       旧版から継承した
    bit 5 (0x20) BTR_EXTERN_BEING_MODIFIED_FLAG  更新中
```

`ref_t::length()` が `mach_read_from_4(m_ref + BTR_EXTERN_LEN + 4)` を読んでいることから分かるとおり、**8 バイトの長さフィールドのうち実際に使うのは下位 4 バイト**だ。上位 4 バイトは 3 つのフラグビット以外ほぼ未使用で、`lob::MAX_SIZE = UINT32_MAX` が LOB の上限になる。

覚えておくべき点。

- **外に出す判定は `page_zip_rec_needs_ext` ただ 1 つ**。行フォーマットが REDUNDANT でも DYNAMIC でも、圧縮していなくても同じ関数を通る。`rec_needs_ext` という関数はツリーに存在しない
- **DYNAMIC / COMPRESSED は 20 バイトの参照だけ残す。COMPACT / REDUNDANT は 768 バイトの接頭辞 + 20 バイト = 788 バイトを残す**
- **最大長が 255 バイト以下の列は外に出せない**。外部格納フラグを置くビットがないからだ
- **セカンダリインデックスに LOB 参照は入らない**。LOB はクラスタードインデックスにしか存在しない
- **JSON の部分更新が in-place になるには条件が 4 つ揃う必要がある**。1 つでも外れると LOB 全体の書き直しになる

## なぜそうなっているか

### なぜ「半分」なのか

1 ページに最低 2 レコードが入ることを保証したいからだ。1 レコードしか入らないと、[B+tree のページ分割](./btree-operations/)が成立しなくなる (分割点が取れない)。`btr_create` の末尾にも `ut_ad(page_get_max_insert_size(page, 2) > 2 * BTR_PAGE_MAX_REC_SIZE);` という assert がある。

### なぜ COMPACT は 768 バイト残すのか

5.1 以前 (Antelope ファイルフォーマット) は、**インデックスの接頭辞に使う分だけはレコード内に持っている必要があった**。`REC_ANTELOPE_MAX_INDEX_COL_LEN = 768` はその値で、`rem0types.h` のコメントは「この定数を変えると InnoDB のデータファイルの互換性が壊れる」と警告している。

DYNAMIC (Barracuda) では接頭辞をローカルに持たず、代わりにインデックスに使える最大長を 3072 バイトまで広げた。「atomic blobs」という名前は、**BLOB が分断されずに丸ごと外に出る**という意味だ。

### なぜ LOB がインデックス構造になったのか

5.7 までの LOB は単方向リストで、途中の 1 バイトを書き換えるにも先頭から辿るしかなく、しかも MVCC のために全ページを複製していた。1MB の JSON の 1 フィールドを更新すると 1MB 書き込むことになる。

8.0 で LOB インデックスを持たせたことで、**変更されたページだけを差し替えられる**ようになった。旧版は LOB バージョンで区別され、purge が回収する。

### なぜ一度でも丸ごと更新すると部分更新できなくなるのか

部分更新はページ単位の差し替えで版を管理する。ところが LOB 列が丸ごと別の値に置き換わると、その LOB は「所有者のいない旧版」として undo から参照されるだけの存在になる。この状態で部分更新の版管理を続けると、所有権 (`BTR_EXTERN_OWNER_FLAG`) と版の追跡が絡んで正しさを保証しづらい。安全側に倒してフラグを立てている。

## ソースコードのどこか

### 追い出す判定

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

[`page0zip.ic#L136`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/page0zip.ic#L136)。名前に `page_zip` とついているのは歴史的な事情で、**圧縮していないページでも呼ばれる**。呼び出し元は `btr0cur.cc` の挿入 / 更新経路 3 か所と `data0data.cc` のループ、それに bulk load の 2 か所だけだ。

16KB / COMPACT 系なら `page_get_free_space_of_empty(true) / 2` = `16252 / 2` = **8126** ([ページの構造](./page-layout/))。

### どの列を追い出すか

```cpp title="storage/innobase/data/data0data.cc"
  if (!dict_table_has_atomic_blobs(index->table)) {
    /* up to MySQL 5.1: store a 768-byte prefix locally */
    local_len = BTR_EXTERN_FIELD_REF_SIZE + DICT_ANTELOPE_MAX_INDEX_COL_LEN;
  } else {
    /* new-format table: do not store any BLOB prefix locally */
    local_len = BTR_EXTERN_FIELD_REF_SIZE;
  }
```

[`dtuple_convert_big_rec` (`data0data.cc#L423`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/data/data0data.cc#L423)。`BTR_EXTERN_FIELD_REF_SIZE = FIELD_REF_SIZE = 20` ([`page0size.h#L39`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/page0size.h#L39))、`DICT_ANTELOPE_MAX_INDEX_COL_LEN = 768`。**COMPACT なら 788 バイト、DYNAMIC なら 20 バイト**が跡地に残る。

選び方はループで、毎回「一番節約になる列」を 1 本ずつ追い出す。

```cpp title="storage/innobase/data/data0data.cc"
  while (page_zip_rec_needs_ext(
      rec_get_converted_size(index, entry), dict_table_is_comp(index->table),
      dict_index_get_n_fields(index), dict_table_page_size(index->table))) {
    ...
    for (ulint i = dict_index_get_n_unique_in_tree(index);
         i < dtuple_get_n_fields(entry); i++) {
      ...
      /* Skip fixed-length, NULL, externally stored,
      or short columns */

      if (ifield->fixed_len || dfield_is_null(dfield) ||
          dfield_is_ext(dfield) || dfield_get_len(dfield) <= local_len ||
          dfield_get_len(dfield) <= BTR_EXTERN_LOCAL_STORED_MAX_SIZE) {
        goto skip_field;
      }

      savings = dfield_get_len(dfield) - local_len;
      ...
      if (!DATA_BIG_COL(ifield->col)) {
        goto skip_field;
      }
```

読み取れる制約が 4 つある。

- ループの開始が `dict_index_get_n_unique_in_tree(index)` — **PK 列は絶対に追い出さない**。追い出したら木の順序が決められない
- 固定長列、NULL、すでに外部格納の列は対象外
- 現在の長さが `local_len` 以下、または `BTR_EXTERN_LOCAL_STORED_MAX_SIZE` (= 20 × 2 = 40、[`btr0types.h#L70`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/btr0types.h#L70)) 以下なら対象外。追い出しても得しない
- `DATA_BIG_COL` でなければ対象外

最後の条件にはコメントで長い理由がついている。

```cpp title="storage/innobase/data/data0data.cc"
      /* In DYNAMIC and COMPRESSED format, store
      locally any non-BLOB columns whose maximum
      length does not exceed 256 bytes.  This is
      because there is no room for the "external
      storage" flag when the maximum length is 255
      bytes or less. This restriction trivially
      holds in REDUNDANT and COMPACT format, because
      there we always store locally columns whose
      length is up to local_len == 788 bytes.
      @see rec_init_offsets_comp_ordinary */
      if (!DATA_BIG_COL(ifield->col)) {
        goto skip_field;
      }
```

`DATA_BIG_COL` の定義は「**最大長が 255 バイトを超えるか、BLOB 系の型か**」だ。

```cpp title="storage/innobase/include/data0type.h"
/* For checking if data type is big length data type. */
inline bool DATA_BIG_LEN_MTYPE(ulint len, ulint mtype) {
  return len > 255 || DATA_LARGE_MTYPE(mtype);
}

/* For checking if the column is a big length column. */
#define DATA_BIG_COL(col) DATA_BIG_LEN_MTYPE((col)->len, (col)->mtype)
```

[`data0type.h#L281`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/data0type.h#L281)。**最大長 255 バイト以下の列は、可変長でも外に出せない**。[レコードの構造](./record-format/)で見たとおり、そういう列の長さは 1 バイトで符号化され、外部格納フラグを立てるビットがない。

追い出せる列が 1 本も見つからなければ、`dtuple_convert_big_rec` は `nullptr` を返し、`DB_TOO_BIG_RECORD` → `Row size too large (> 8126)` になる。

### LOB ページの構造

外に出されたデータは専用のページ種別に置かれる。

| `FIL_PAGE_TYPE`                | 意味                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `FIL_PAGE_TYPE_BLOB` (10)      | 5.7 以前の形式。単方向リストで繋がる。読み取りのみ               |
| `FIL_PAGE_TYPE_LOB_FIRST` (24) | 8.0 形式の先頭ページ。バージョン・フラグ・LOB インデックスを持つ |
| `FIL_PAGE_TYPE_LOB_DATA` (23)  | データページ                                                     |
| `FIL_PAGE_TYPE_LOB_INDEX` (22) | LOB インデックスのページ                                         |
| `FIL_PAGE_TYPE_ZLOB_*` (25-29) | 圧縮 LOB                                                         |

定数は [`fil0fil.h#L1289-1348`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/fil0fil.h#L1289)。**8.0 で LOB は単方向リストから B+tree 状のインデックス付き構造に置き換わった**。これによって「LOB の途中だけを書き換える」ことができるようになった。

先頭ページのヘッダは [`lob0first.h#L45-76`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/lob0first.h#L45)。

```
FIL_PAGE_DATA (= 38) から
  +0   OFFSET_VERSION        1  ページフォーマットのバージョン
  +1   OFFSET_FLAGS          1  bit 0: 部分更新できなくなった
  +2   OFFSET_LOB_VERSION    4  LOB の版番号
  +6   OFFSET_LAST_TRX_ID    6  最後に触った trx
  +12  OFFSET_LAST_UNDO_NO   4
  +16  OFFSET_DATA_LEN       4  このページ内のデータ長
  +20  OFFSET_TRX_ID         6
  +26  OFFSET_INDEX_LIST        LOB インデックスのリスト
```

`OFFSET_FLAGS` の bit 0 が立っていると、その LOB はもう部分更新できない。

```cpp title="storage/innobase/include/lob0first.h"
  /** When the bit is set, the LOB is not partially updatable anymore.
  @return true, if partially updatable.
  @return false, if partially NOT updatable. */
  bool can_be_partially_updated() {
    uint8_t flags = get_flags();
    return (!(flags & 0x01));
  }
```

### 部分更新の条件

JSON カラムを `JSON_SET` などで更新するとき、サーバ側と InnoDB 側の両方で条件が揃わないと LOB 全体の書き直しになる。

**サーバ側 (1)**: そもそも「部分更新の候補」に選ばれるか。[`prepare_partial_update` (`sql/sql_update.cc#L1351`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_update.cc#L1351) が判定し、外れた理由を optimizer trace に書く。

```cpp title="sql/sql_update.cc"
    if ((field->table->file->ha_table_flags() & HA_BLOB_PARTIAL_UPDATE) == 0) {
      reject_column("Storage engine does not support partial update");
      continue;
    }

    if (!value_item->supports_partial_update(field)) {
      reject_column(
          "Updated using a function that does not support partial "
          "update, or source and target column differ");
      partial_update_fields.erase_unique(field);
      continue;
    }
```

同じファイルのコメントが対象を限定している。

```cpp title="sql/sql_update.cc"
  Only JSON columns can be updated in-place, and only if all the updates of the
  column are on the form

      json_col = JSON_SET(json_col, ...)

      json_col = JSON_REPLACE(json_col, ...)

      json_col = JSON_REMOVE(json_col, ...)
```

**`JSON_SET` / `JSON_REPLACE` / `JSON_REMOVE` で、しかも代入元と代入先が同じ列である場合だけ**。`json_col = JSON_MERGE_PATCH(json_col, ...)` も `other_col = JSON_SET(json_col, ...)` も対象外だ。加えて、これらの関数で値の長さが変わらない (JSON のバイナリ表現が in-place で書き換えられる) 必要がある。

**サーバ側 (2)**: binlog 側の設定。

```cpp title="sql/table.cc"
bool TABLE::setup_partial_update() {
  THD *thd = current_thd;

  const bool logical_diffs =
      (thd->variables.binlog_row_value_options & PARTIAL_JSON_UPDATES) != 0 &&
      mysql_bin_log.is_open() &&
      (thd->variables.option_bits & OPTION_BIN_LOG) != 0 &&
      thd->is_current_stmt_binlog_format_row();
```

[`sql/table.cc#L7741`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/table.cc#L7741)。ここで決まるのは binlog に**論理差分**を書くかどうか (`binlog_row_value_options=PARTIAL_JSON`) で、InnoDB のストレージ上の部分更新 (バイナリ差分) とは別物だ。バイナリ差分は binlog の設定に関係なく効く。

**InnoDB 側 (1)**: 行フォーマット。

```cpp title="storage/innobase/row/row0upd.cc"
  if (!mysql_table->is_binary_diff_enabled(uf->mysql_field)) {
    return false;
  }

  if (dict_table_has_atomic_blobs(table)) {
    return true;
  }
  ...
  /* In compact and redundant row format, partially updating the LOB prefix
  is not yet supported. */

  const Binary_diff_vector *bdiff_vector =
      get_binary_diff_by_field_no(field_no);

  for (Binary_diff_vector::const_iterator iter = bdiff_vector->begin();
       iter != bdiff_vector->end(); ++iter) {
    const Binary_diff *bdiff = iter;

    if (bdiff->offset() < DICT_ANTELOPE_MAX_INDEX_COL_LEN) {
      return false;
    }
  }
```

[`upd_t::is_partially_updated` (`row0upd.cc#L3457`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0upd.cc#L3457)。DYNAMIC / COMPRESSED なら無条件で可。**COMPACT / REDUNDANT では、変更箇所が全部 768 バイト目より後ろにあるときだけ**可。ローカルに残っている 768 バイトの接頭辞の更新には対応していないからだ。

**InnoDB 側 (2)**: LOB が新形式で、まだ「部分更新不可」の印がついていないこと。

```cpp title="storage/innobase/lob/lob0lob.cc"
  switch (page_type) {
    case FIL_PAGE_TYPE_LOB_FIRST: {
      first_page_t first_page(block, &mtr, (dict_index_t *)index);
      is_partially_updatable = first_page.can_be_partially_updated();
      break;
    }
    case FIL_PAGE_TYPE_ZLOB_FIRST: {
      z_first_page_t z_first_page(block, &mtr, (dict_index_t *)index);
      is_partially_updatable = z_first_page.can_be_partially_updated();
      break;
    }
    default:
      is_partially_updatable = false;
  }
```

[`ref_t::get_lob_page_info` (`lob0lob.cc#L1131`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lob/lob0lob.cc#L1131)。**5.7 以前に書かれた `FIL_PAGE_TYPE_BLOB` の LOB は `default` に落ちて部分更新できない**。アップグレードしたインスタンスで JSON 部分更新が効かないのはこれが原因になる。

そして印は一度つくと外れない。

```cpp title="storage/innobase/lob/lob0lob.cc"
    if (update->is_partially_updated(ufield->field_no)) {
      continue;
    }

    const dfield_t *new_field = &ufield->new_val;

    if (ufield->ext_in_old && !dfield_is_ext(new_field)) {
      const dfield_t *old_field = &ufield->old_val;
      byte *field_ref = old_field->blobref();
      ref_t ref(field_ref);

      if (!ref.is_null_relaxed()) {
        ...
        ref.mark_not_partially_updatable(trx, &local_mtr, index,
                                         index->get_page_size());
```

[`lob::mark_not_partially_updatable` (`lob0lob.cc#L1312`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lob/lob0lob.cc#L1312)。[`btr_cur_pessimistic_update` から呼ばれる (`btr0cur.cc#L3924`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/btr/btr0cur.cc#L3924)。**部分更新でない更新で LOB 列を丸ごと置き換えると、旧 LOB の先頭ページにフラグが立つ**。

### 部分更新の実行

条件が揃うと [`lob::update` (`lob0update.cc#L97`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lob/lob0update.cc#L97) が呼ばれる。ここでもう 1 段の分岐がある。

```cpp title="storage/innobase/lob/lob0update.cc"
  const ulint bytes_changed = upd_t::get_total_modified_bytes(*bdiff_vector);

  /* Whether the update to the LOB can be considered as a small change. */
  const bool small_change =
      (bytes_changed <= ref_t::LOB_SMALL_CHANGE_THRESHOLD);
  ...
  if (small_change) {
    lob_version = first_page.get_lob_version();
  } else {
    lob_version = first_page.incr_lob_version();
  }

  int count = 0;
  for (Binary_diff_vector::const_iterator iter = bdiff_vector->begin();
       iter != bdiff_vector->end(); ++iter, ++count) {
    const Binary_diff *bdiff = iter;

    if (small_change) {
      err = replace_inline(ctx, trx, index, blobref, first_page,
                           bdiff->offset(), bdiff->length(),
                           (byte *)bdiff->new_data(uf->mysql_field));

    } else {
      err = replace(ctx, trx, index, blobref, first_page, bdiff->offset(),
                    bdiff->length(), (byte *)bdiff->new_data(uf->mysql_field),
                    count);
    }
```

`LOB_SMALL_CHANGE_THRESHOLD = 100` バイト。**100 バイト以下の変更なら LOB ページを直接書き換えて通常の undo に記録する。それを超えると、変更されたページを新しいページに複製して LOB のバージョンを上げる** (MVCC のために旧ページを残す)。

## どう活かすか

### JSON の部分更新が in-place にならない

チェックリストは 6 項目になる。

1. 更新式が `json_col = JSON_SET/JSON_REPLACE/JSON_REMOVE(json_col, ...)` の形になっているか。`JSON_MERGE_PATCH` は対象外
2. 結果の JSON バイナリが同じ長さか。値の型や長さが変わると差分にならない
3. テーブルの `ROW_FORMAT` が DYNAMIC か COMPRESSED か。COMPACT だと 768 バイト目より前の変更は不可
4. その LOB が 8.0 以降に書かれたものか。5.7 から持ち越した行は `FIL_PAGE_TYPE_BLOB` で不可
5. その LOB 列を過去に丸ごと `UPDATE` していないか。一度やると `OFFSET_FLAGS` の bit 0 が立つ
6. そもそも JSON が外部格納されるほど大きいか。8126 バイトに収まっていればレコード内にあり、この話は関係ない

1 と 2 は `SET optimizer_trace='enabled=on'` で `json_partial_update` オブジェクトの `rejected_columns` を見れば分かる。3 は `INFORMATION_SCHEMA.INNODB_TABLES` の `ROW_FORMAT`。5 はデバッグビルドで `DBUG_EXECUTE_IF("lob_print_partial_update_hit", ...)` を仕込む以外に直接見る手段がないので、**アプリ側で「JSON 列に丸ごと代入する経路」を潰す**のが実務的な対処になる。

binlog 側の `binlog_row_value_options=PARTIAL_JSON` は別軸だ。これはレプリカに送る差分を小さくする設定で、ストレージ上の部分更新とは独立に効く。

### 大きい列が SELECT を遅くする

外部格納された列を `SELECT` すると、**クラスタードインデックスの葉ページに加えて LOB ページを読む**。1MB の BLOB なら 16KB ページで 60 枚以上だ。

対策は 2 つ。

- **`SELECT *` をやめる**。LOB 参照はレコードに 20 バイトあるだけなので、その列を選ばなければ LOB ページは読まれない
- **列を別テーブルに分ける**。同じ行の他の列を頻繁に読むなら、LOB を別テーブルに追い出すとクラスタードインデックスの葉が痩せ、1 ページあたりの行数が増える

DYNAMIC で LOB を追い出したテーブルは、**レコードから見れば LOB 列は 20 バイトの固定費**でしかない。逆に COMPACT のままだと 788 バイト残るので、`SELECT` で LOB 列を選ばなくても葉ページが太る。この差は 100 万行のテーブルで 750MB になる。

### `Row size too large` を DYNAMIC で直せないケース

[レコードの構造](./record-format/)でも触れたが、外に出せる列がなければ行フォーマットを変えても直らない。具体的には、

- 最大長 255 バイト以下の可変長列 (utf8mb4 なら `VARCHAR(63)` 以下) をたくさん並べたテーブル
- 固定長列 (`CHAR`、数値型、`DATE` など) をたくさん並べたテーブル

がこれに当たる。

逆に、**列を「広げる」と直ることがある**。`DATA_BIG_COL` は**宣言された最大長**で決まるので、utf8mb4 の `VARCHAR(63)` (最大 252 バイト) はどんな値が入っていても外に出せないが、`VARCHAR(64)` (最大 256 バイト) は候補になる。ただし追い出されるにはその行の実データが `local_len` (DYNAMIC なら 20 バイト) を超えている必要もあるので、「宣言長が 255 バイト超」かつ「実データが十分長い」の両方が要る。狭い `VARCHAR` に長めの値を詰めていて `Row size too large` になったテーブルは、宣言長を広げるだけで通ることがある。

### LOB を含むテーブルの `UPDATE` は重い

LOB 列を更新すると、部分更新の条件を満たさない限り**新しい LOB を丸ごと書いて、古い LOB を purge 待ちにする**。1MB の JSON を 1 日 100 万回更新すれば 1TB/日 の書き込みだ。

`INFORMATION_SCHEMA.INNODB_METRICS` の `lob_*` 系カウンタと、`SHOW ENGINE INNODB STATUS` の `History list length` を合わせて見ると、LOB の更新が purge を圧迫しているかどうかが分かる ([purge のページ](./purge/))。

### セカンダリインデックスに LOB は入らない

`lob0lob.h` の冒頭コメントが `Secondary indexes cannot have LOB references.` と明言している。だから `TEXT` 列にインデックスを張るときは必ず接頭辞インデックス (`KEY (body(255))`) になり、その接頭辞はレコード内に収まる長さでなければならない。DYNAMIC で最大 3072 バイトまでだ ([レコードの構造](./record-format/))。

接頭辞インデックスは [covering index にならない](./secondary-index/)ので、`WHERE body LIKE 'abc%'` はインデックスで絞った後に必ずクラスタードインデックスと LOB ページを読む。全文検索が必要ならインデックスではなく別の仕組みを検討する。
