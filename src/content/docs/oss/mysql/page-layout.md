---
title: "ページの構造 — 38 バイトヘッダ、8 バイトトレイラ、ディレクトリ"
description: "16KB のインデックスページを先頭から末尾まで並べる。FIL ヘッダ 38 バイト、インデックスヘッダ 56 バイト、infimum と supremum という番人レコード、下から積むレコード領域、末尾から逆に伸びるページディレクトリ、そして 8 バイトのトレイラ。checksum が 2 か所の穴を飛ばして計算される理由と、Row size too large のあの 8126 という数がどこから来るかもここで確定する。"
group: "InnoDB — 物理構造"
sidebar:
  order: 47
---

## 何を学んだか

InnoDB のインデックスページは、**両端から中央に向かって食い合う**構造になっている。前半にヘッダとレコードが積み上がり、後半からページディレクトリが逆向きに伸びる。両者がぶつかったらページ分割だ。

16KB ページの全体像はこうなる。

```
オフセット
      0 +--------------------------------------------------+
        | FIL ヘッダ (38 バイト)                            |
        |   checksum / ページ番号 / prev / next / LSN /     |
        |   ページ種別 / space id                          |
     38 +--------------------------------------------------+
        | インデックスヘッダ (56 バイト)                     |
        |   PAGE_N_DIR_SLOTS / PAGE_HEAP_TOP /             |
        |   PAGE_N_HEAP / PAGE_FREE / PAGE_GARBAGE /       |
        |   PAGE_LAST_INSERT / PAGE_DIRECTION /            |
        |   PAGE_N_RECS / PAGE_MAX_TRX_ID /                |
        |   PAGE_LEVEL / PAGE_INDEX_ID /                   |
        |   PAGE_BTR_SEG_LEAF (10) / PAGE_BTR_SEG_TOP (10) |
     94 +--------------------------------------------------+  PAGE_DATA
        | infimum レコード (5 + 8 = 13 バイト)              |
    107 +--------------------------------------------------+
        | supremum レコード (5 + 8 = 13 バイト)             |
    120 +--------------------------------------------------+  PAGE_NEW_SUPREMUM_END
        | ユーザレコード (下から上へ積む)                    |
        |                    |                             |
        |                    v                             |
        +--------------------------------------------------+
        |                空き領域                           |
        +--------------------------------------------------+
        |                    ^                             |
        |                    |                             |
        | ページディレクトリ (末尾から下へ、2 バイト/スロット) |
  16376 +--------------------------------------------------+  = 16384 - 8
        | ページトレイラ (8 バイト)                          |
        |   旧 checksum 4 + FIL_PAGE_LSN の下位 4           |
  16384 +--------------------------------------------------+
```

数字は 16KB ページの COMPACT / DYNAMIC (`page_is_comp()` が真) の場合。REDUNDANT はレコードヘッダが 6 バイトなので infimum / supremum の位置が数バイトずれる。

ここから読み取れる要点は 4 つある。

1. **1 ページで自由に使えるのは 16252 バイト**。16384 から supremum の終端 120、トレイラ 8、ディレクトリ最小 2 スロット分 4 を引いた値だ。この半分の 8126 が「1 行に許される最大バイト数」になる
2. **`infimum` と `supremum` は本物のレコードとして常に存在する**。ページが空でも 26 バイト消費している。範囲チェックを分岐なしで書けるようにするための番人だ
3. **ディレクトリは全レコードを指すわけではない**。4〜8 レコードにつき 1 スロットで、粗い二分探索の入口として使う
4. **checksum は 2 か所の穴を飛ばして計算される**。ページ先頭 4 バイト (checksum 自身) と、オフセット 26〜33 の 8 バイトだ

## ソースコードのどこか

### FIL ヘッダ 38 バイト

定数は [`storage/innobase/include/fil0types.h`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/fil0types.h#L43) にある。

```
  0  FIL_PAGE_SPACE_OR_CHKSUM       4  ページの checksum (4.0 時代は space id)
  4  FIL_PAGE_OFFSET                4  このページのページ番号
  8  FIL_PAGE_PREV                  4  同じレベルの左隣。無ければ FIL_NULL
 12  FIL_PAGE_NEXT                  4  同じレベルの右隣
 16  FIL_PAGE_LSN                   8  このページを最後に変更した mtr の LSN
 24  FIL_PAGE_TYPE                  2  FIL_PAGE_INDEX = 17855 など
 26  FIL_PAGE_FILE_FLUSH_LSN        8  space 0 の page 0 でのみ意味を持つ
 34  FIL_PAGE_ARCH_LOG_NO_OR_SPACE_ID 4  space id
 38  FIL_PAGE_DATA                     データ開始
```

`FIL_PAGE_PREV` / `FIL_PAGE_NEXT` のコメントが重要だ。

```cpp title="storage/innobase/include/fil0types.h"
/** if there is a 'natural' successor of the page, its offset. Otherwise
FIL_NULL. B-tree index pages(FIL_PAGE_TYPE contains FIL_PAGE_INDEX) on the
same PAGE_LEVEL are maintained as a doubly linked list via FIL_PAGE_PREV and
FIL_PAGE_NEXT in the collation order of the smallest user record on each
page. */
constexpr uint32_t FIL_PAGE_NEXT = 12;
```

**同じレベルのページは双方向リストで繋がっている**。これがあるから、葉レベルの範囲スキャンは根に戻らずに右へ進める ([B+tree の操作](./btree-operations/))。ただしコメントが明記しているとおり **BLOB ページではこのフィールドは設定されない** (LOB は単方向リスト、[LOB のページ](./lob-storage/))。

### インデックスヘッダ 56 バイト

[`storage/innobase/include/page0types.h#L53`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/page0types.h#L53) から。`PAGE_HEADER = FSEG_PAGE_DATA = FIL_PAGE_DATA = 38` なので、以下のオフセットはすべて 38 からの相対だ。

```
+ 0  PAGE_N_DIR_SLOTS      2  ディレクトリのスロット数
+ 2  PAGE_HEAP_TOP         2  レコードヒープの上端 (= 未使用領域の先頭)
+ 4  PAGE_N_HEAP           2  ヒープ内のレコード数。bit 15 が compact フラグ
+ 6  PAGE_FREE             2  削除済みレコードのフリーリスト先頭
+ 8  PAGE_GARBAGE          2  削除済みレコードが占めるバイト数
+10  PAGE_LAST_INSERT      2  最後に挿入したレコードへのポインタ
+12  PAGE_DIRECTION        2  直近の挿入方向 (PAGE_LEFT / PAGE_RIGHT / ...)
+14  PAGE_N_DIRECTION      2  同じ方向に連続した挿入の回数
+16  PAGE_N_RECS           2  ユーザレコード数
+18  PAGE_MAX_TRX_ID       8  このページを変更した最大 trx id (セカンダリのみ)
+26  PAGE_LEVEL            2  木の中の高さ。葉が 0
+28  PAGE_INDEX_ID         8  どのインデックスに属するか
+36  PAGE_BTR_SEG_LEAF    10  葉セグメントのヘッダ (root ページのみ)
+46  PAGE_BTR_SEG_TOP     10  非葉セグメントのヘッダ (root ページのみ)
                        ---- PAGE_DATA = 38 + 56 = 94 ----
```

`PAGE_MAX_TRX_ID` のコメントは「セカンダリインデックスと insert buffer ツリーでのみ定義される」と言っている。**クラスタードインデックスの葉には各レコードに `DB_TRX_ID` があるので不要**で、版を持たないセカンダリインデックスだけが「このページに触った最大の trx id」というページ単位の近似を持つ。これが MVCC の高速パスに使われる ([セカンダリインデックスと MVCC](./secondary-index-visibility/))。

`PAGE_LAST_INSERT` と `PAGE_DIRECTION` / `PAGE_N_DIRECTION` は、ページ分割の分割点を決めるヒューリスティックに使う。連番の挿入かどうかをここで判定する ([B+tree の操作](./btree-operations/))。

`PAGE_LEVEL` と `PAGE_INDEX_ID` にはコメントで「ページ作成後に書き換えてはならない」と注記されている。ページはそのインデックスのその高さに固定される。

### infimum と supremum

空ページの中身はバイト列で直書きされている。

```cpp title="storage/innobase/page/page0page.cc"
/** The page infimum and supremum of an empty page in ROW_FORMAT=COMPACT */
static const byte infimum_supremum_compact[] = {
    /* the infimum record */
    0x01 /*n_owned=1*/, 0x00, 0x02 /* heap_no=0, REC_STATUS_INFIMUM */, 0x00,
    0x0d /* pointer to supremum */, 'i', 'n', 'f', 'i', 'm', 'u', 'm', 0,
    /* the supremum record */
    0x01 /*n_owned=1*/, 0x00, 0x0b /* heap_no=1, REC_STATUS_SUPREMUM */, 0x00,
    0x00 /* end of record list */, 's', 'u', 'p', 'r', 'e', 'm', 'u', 'm'};
```

[`page0page.cc#L296`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/page/page0page.cc#L296)。5 バイトのレコードヘッダと 8 バイトの本体 (`"infimum\0"` は 8 バイト、`"supremum"` も 8 バイト) がそのまま並ぶ。infimum の `next` は `0x000d` = 13 で、13 バイト先の supremum を指す。ページが空のとき、レコードリストは `infimum → supremum` の 2 要素だ。

[`page_create_low` (L309)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/page/page0page.cc#L309) がこれを `PAGE_DATA` にコピーし、ディレクトリスロット 2 つ (infimum と supremum) を末尾に置く。

```cpp title="storage/innobase/page/page0page.cc"
    page[PAGE_HEADER + PAGE_N_HEAP] = 0x80; /*page_is_comp()*/
    page[PAGE_HEADER + PAGE_N_HEAP + 1] = PAGE_HEAP_NO_USER_LOW;
    page[PAGE_HEADER + PAGE_HEAP_TOP + 1] = PAGE_NEW_SUPREMUM_END;
```

`PAGE_N_HEAP` の bit 15 (= `0x80` を上位バイトに立てる) が **COMPACT 系かどうかのフラグ**であることに注意する。行フォーマットの判定は、テーブル定義ではなくページ内のこの 1 ビットからも取れる。

ヒープ番号は `infimum = 0`、`supremum = 1`、ユーザレコードは 2 から ([`page0types.h#L131`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/page0types.h#L131))。ロックのビットマップがこのヒープ番号でインデックスされるので、番号は削除しても再利用まで空く ([ロックの種類](./lock-modes-and-types/))。

### ページディレクトリ

[`storage/innobase/include/page0page.h#L61-74`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/page0page.h#L61)。

```cpp title="storage/innobase/include/page0page.h"
constexpr uint32_t PAGE_DIR = FIL_PAGE_DATA_END;
...
constexpr uint32_t PAGE_DIR_SLOT_SIZE = 2;
...
constexpr uint32_t PAGE_DIR_SLOT_MAX_N_OWNED = 8;
constexpr uint32_t PAGE_DIR_SLOT_MIN_N_OWNED = 4;
```

1 スロット 2 バイトで、そのスロットが「所有する」レコード群の最後のレコードのオフセットを指す。所有数は 4〜8 に保たれ、8 を超えたらスロットを分割、4 を割ったら隣とマージする。所有数はレコードヘッダの `n_owned` フィールド (4 ビット) に書かれる ([レコードの構造](./record-format/))。

検索は [`page_cur_search_with_match` (`page0cur.cc#L328`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/page/page0cur.cc#L328) が行う。

```cpp title="storage/innobase/page/page0cur.cc"
  /* Perform binary search. First the search is done through the page
  directory, after that as a linear search in the list of records
  owned by the upper limit directory slot. */

  low = 0;
  up = page_dir_get_n_slots(page) - 1;
```

**ディレクトリで二分探索 → 見つかったスロットが所有する最大 8 件を線形探索**、の 2 段構えだ。全レコードを二分探索の対象にしないのは、レコードが可変長で配列にできないから。スロットを 4〜8 に保つことで、線形探索の長さを定数で抑えている。

### トレイラと checksum

トレイラは 8 バイトで、前半 4 バイトが旧アルゴリズムの checksum、後半 4 バイトが `FIL_PAGE_LSN` の下位 4 バイトのコピーだ ([`fil0types.h#L116`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/fil0types.h#L116))。後半は torn page の検出に使う。ページ先頭の LSN と末尾のコピーが食い違えば、書き込みが途中で切れたと分かる ([doublewrite のページ](./doublewrite/))。

checksum の計算範囲がおもしろい。

```cpp title="storage/innobase/buf/checksum.cc"
uint32_t buf_calc_page_crc32(const byte *page,
                             bool use_legacy_big_endian /* = false */) {
  /* Since the field FIL_PAGE_FILE_FLUSH_LSN, and in versions <= 4.1.x
  FIL_PAGE_ARCH_LOG_NO_OR_SPACE_ID, are written outside the buffer pool
  to the first pages of data files, we have to skip them in the page
  checksum calculation.
  We must also skip the field FIL_PAGE_SPACE_OR_CHKSUM where the
  checksum is stored, and also the last 8 bytes of page because
  there we store the old formula checksum. */
  ...
  const uint32_t c1 = crc32_func(page + FIL_PAGE_OFFSET,
                                 FIL_PAGE_FILE_FLUSH_LSN - FIL_PAGE_OFFSET);

  const uint32_t c2 =
      crc32_func(page + FIL_PAGE_DATA,
                 UNIV_PAGE_SIZE - FIL_PAGE_DATA - FIL_PAGE_END_LSN_OLD_CHKSUM);

  return (c1 ^ c2);
}
```

[`checksum.cc#L71`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/buf/checksum.cc#L71)。**オフセット 4〜25 と 38〜16375 の 2 区間だけ**を CRC32 にかけ、XOR する。飛ばしているのは checksum 自身 (0〜3)、`FIL_PAGE_FILE_FLUSH_LSN` (26〜33) と `space id` (34〜37)、トレイラ (16376〜16383)。26〜37 を飛ばすのは、これらがバッファプールを経由せずファイル上で直接書き換えられることがあったからで、20 年前の互換性がそのまま残っている。

### 空き容量の計算 — 8126 の出どころ

```cpp title="storage/innobase/include/page0page.ic"
static inline ulint page_get_free_space_of_empty(
    bool comp) /*!< in: nonzero=compact page layout */
{
  if (comp) {
    return ((ulint)(UNIV_PAGE_SIZE - PAGE_NEW_SUPREMUM_END - PAGE_DIR -
                    2 * PAGE_DIR_SLOT_SIZE));
  }
  ...
}
```

[`page0page.ic#L816`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/page0page.ic#L816)。16KB / COMPACT なら `16384 - 120 - 8 - 4 = 16252`。

この値の半分が、1 行の上限として使われる。

```cpp title="storage/innobase/handler/ha_innodb.cc"
      my_printf_error(
          ER_TOO_BIG_ROWSIZE,
          "Row size too large (> " ULINTPF
          "). Changing some columns"
          " to TEXT or BLOB %smay help. In current row"
          " format, BLOB prefix of %d bytes is stored inline.",
          MYF(0),
          srv_page_size == UNIV_PAGE_SIZE_MAX
              ? REC_MAX_DATA_SIZE - 1
              : page_get_free_space_of_empty(flags & DICT_TF_COMPACT) / 2,
```

[`ha_innodb.cc#L2193`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L2193)。`16252 / 2 = 8126`。**あの `Row size too large (> 8126)` の 8126 は、16KB ページの空きの半分**だ。詳しくは[レコードの構造](./record-format/)で扱う。

## なぜそうなっているか

### なぜ両端から詰めるのか

レコードは可変長なので、固定長の配列にはできない。かといって挿入のたびにレコード全体をずらすのも高い。そこで**レコードは挿入順にヒープの上端 (`PAGE_HEAP_TOP`) から積み、論理的な順序は各レコードの `next` ポインタが表す**という設計になっている。物理順序と論理順序を切り離したわけだ。

だがそれだけだと検索が単方向リストの線形走査になる。そこで論理順序の「目次」だけを別に持つ。この目次は固定長 2 バイトなので、ページの反対側から配列として詰められる。

結果として、レコード領域とディレクトリが中央でぶつかるまでがそのページの容量になる。

### なぜ infimum と supremum がレコードなのか

範囲の端を特別扱いしないためだ。`page_rec_get_next` は常に何かを返すし、カーソルは「supremum に到達したら次のページ」と一様に書ける。ロックの世界でも効いていて、**「テーブルの末尾から先」というギャップに対するロックは supremum レコードへのロックとして表現される** ([ロックの種類](./lock-modes-and-types/))。番人が実在するおかげで、ギャップロックに特別なデータ構造が要らない。

### なぜディレクトリのスロットが 4〜8 件を所有するのか

全レコードを指すと、ディレクトリだけで `n × 2` バイト消費する。逆に粗すぎると線形探索が長くなる。4〜8 は「1 スロットあたりの線形走査を高々 8 件に抑えつつ、ディレクトリのオーバーヘッドをレコードあたり 0.25〜0.5 バイトに抑える」という妥協点だ。

`page_get_free_space_of_empty` が `2 * PAGE_DIR_SLOT_SIZE` を差し引いているのも、infimum と supremum の分の 2 スロットが常に要るからだ。ページ内の実効容量を見積もるときは、レコードのサイズに加えて `PAGE_DIR_SLOT_SIZE / PAGE_DIR_SLOT_MIN_N_OWNED = 0.5` バイトを足す必要がある。

### なぜ checksum が 2 段階なのか

`FIL_PAGE_SPACE_OR_CHKSUM` (先頭 4 バイト) とトレイラの旧 checksum は、歴史的に別のアルゴリズムだった。8.4 の既定は `innodb_checksum_algorithm=crc32` で、両方に CRC32 を書く。トレイラ後半 4 バイトの LSN コピーは checksum とは別の仕掛けで、**checksum が壊れていなくても torn write は検出できる**。ページ全体を読んで検証するので、部分書き込みならどちらかが必ず食い違う。

## どう活かすか

### 「1 ページに何行入るか」を見積もる

実効容量は 16252 バイトだが、そのまま割ってはいけない。1 レコードあたり「レコード本体 ([ヘッダ 5 バイト + 可変長ヘッダ](./record-format/) + データ)」に加えてディレクトリスロットの持ち分 0.25〜0.5 バイトがかかる。さらにページ単位で、連番挿入のときに `UNIV_PAGE_SIZE / 16 = 1024` バイトを更新用に空けておこうとする判定が入る ([B+tree の操作](./btree-operations/))。

ランダムな順序で挿入されたページは埋まり切らないので、**テーブルサイズの見積もりは「行サイズ × 行数」に対して 1.5 倍前後**を見ておくと実際に近い。

### `SHOW TABLE STATUS` の `Data_free` と断片化

ページ内の削除済み領域は `PAGE_GARBAGE` に積算される。これはページを再編成 (`btr_page_reorganize`) するまで回収されない。大量 `DELETE` の後に `.ibd` が縮まないのは[テーブルスペースのレベルの話](./innodb-physical-walkthrough/)だが、**ページ内が虫食いになって行あたりの実効サイズが増える**のはこのレベルの話だ。

`OPTIMIZE TABLE` はテーブルを作り直すので両方に効く。

### `innodb_page_size` を変えると上限が全部動く

`Row size too large` の閾値はページサイズの半分から出るので、`innodb_page_size=32k` にすれば 1 行の上限は増える。ただし 64KB ページのときだけ `REC_MAX_DATA_SIZE - 1 = 16383` が上限になる (上の `ha_innodb.cc` の三項演算子) ので、線形には伸びない。

逆に `innodb_page_size=4k` にすると 1 行の上限は 2000 バイト弱まで落ちる。SSD 前提で小さいページを試すときに、既存スキーマが通らなくなるのはここだ。

### ページ破損の切り分け

`Database page corruption on disk or a failed file read of page [page id: space=N, page number=M]` が出たとき、確認する順序は決まっている。

1. `FIL_PAGE_TYPE` (オフセット 24) が期待するもの (インデックスなら 17855) か
2. `FIL_PAGE_OFFSET` (オフセット 4) が読んだページ番号と一致するか — ずれていたら別ページを読んでいる
3. `FIL_PAGE_LSN` の下位 4 バイトとトレイラ末尾 4 バイトが一致するか — 食い違えば torn write

`innodb_force_recovery` を上げる前に、この 3 点を `dd if=... bs=16384 skip=M count=1 | xxd | head` で見るだけで原因の系統が分かる。ページ番号がずれているならストレージ層、LSN が食い違うなら書き込みの中断だ。
