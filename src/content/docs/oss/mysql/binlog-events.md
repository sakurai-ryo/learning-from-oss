---
title: "binlog イベント — 19 バイトヘッダ、Table_map と Rows、FDE"
description: "binlog ファイルは 4 バイトのマジックのあと、19 バイト固定ヘッダを持つイベントが並ぶだけの構造をしている。前方互換の実体はファイル先頭の Format_description_event が持つ post_header_len[] という 1 バイト × イベント種別数の配列で、これがあるから知らないイベントを読み飛ばせる。行イベントは Table_map で列の型を受け取ってから Rows で値を読む 2 段構えになっていて、binlog_row_image と binlog_row_metadata の設定が Debezium のような CDC ツールから見える情報を直接変える。"
group: "binlog とレプリケーション"
sidebar:
  order: 95
---

> **前提**: [binlog](./binlog-walkthrough/)

## 何を学んだか

binlog ファイルの構造は驚くほど単純だ。**4 バイトのマジックの後ろに、19 バイト固定ヘッダを持つイベントが隙間なく並んでいるだけ**で、インデックスもフッタも目次もない。ファイル内の位置を指す `log_pos` は各イベントのヘッダに入っていて、読む側は先頭から順に舐めるしかない。

この単純な構造で 20 年以上の前方互換を保っている仕組みが、ファイルの 2 番目に必ず置かれる **`Format_description_event` (FDE)** だ。FDE は `post_header_len[]` という「イベント種別 → post-header の長さ」の配列を持っていて、読む側は知らない種別のイベントに出会っても `event_len` とこの配列から中身を飛ばせる。

もう 1 つ、行ベースのイベントが **`Table_map_log_event` と `Rows_log_event` の 2 段**になっているのが要点だ。テーブルの定義 (列の型とメタデータ) は `Table_map` にしか入っておらず、`Rows` には `table_id` と生のバイト列しかない。**CDC ツールが「どの列がどの型か」を知る唯一の経路が `Table_map`** で、そこに何が入るかは `binlog_row_metadata` が決める。既定の `MINIMAL` では**列名が入らない**。

## なぜそうなっているか

**ファイル構造に目次を持たせなかったのは、binlog が「書きながら送るログ」だからだ。** 目次を持つと、追記のたびに目次を更新する必要が出て、グループコミットのリーダーが `LOCK_log` を持つ時間が延びる。dump thread は `atomic_binlog_end_pos` という単一の整数だけを見て「どこまで読んでいいか」を判断すればよく、それ以外の同期がいらない ([binlog walkthrough](./binlog-walkthrough/))。代償として、途中位置から読むには前から舐めるしかない。

**前方互換を `post_header_len[]` に集約したのは、「知らないイベントを安全に飛ばす」だけが必要な互換性だったからだ。** レプリケーションで問題になるのは「新しい source が古いレプリカに未知のイベントを送る」ケースで、このとき古いレプリカが必要とするのは「このイベントの長さ」だけだ。バージョン番号を上げてパーサを分岐させる代わりに、**長さの表をファイル自身に埋め込んだ**。だから `binlog_version` は 4 のまま動かなくてよい。

**`Table_map` と `Rows` を分けたのは、複数行の更新でテーブル定義を繰り返さないためだ。** 1 つの `UPDATE` が 1 万行を書き換えても `Table_map` は 1 個で済む。ただしこの分割の副作用として、**`Rows` イベント単独では何も解釈できない**という制約が生まれた。binlog を途中から読み始めたツールは、次の `Table_map` が来るまで行イベントを捨てるしかない。

**`binlog_row_metadata` の既定が `MINIMAL` なのは、レプリケーションだけを考えれば列名がまったく不要だからだ。** レプリカは自分の `TABLE_SHARE` を持っていて、列は位置で対応する。列名を入れるとイベントサイズが増え、それはネットワーク帯域とディスクにそのまま効く。**CDC という用途は後から来た**ので、既定はレプリケーション側に最適化されたままになっている。

**行イベントが「文」ではなく「行」を運ぶのは、非決定性を排除するためだ。** `UPDATE t SET v = RAND()` や `LIMIT` 付きの `DELETE` を文で送ると、レプリカで違う結果になりうる。8.4 の既定 `binlog_format=ROW` はこの問題を構造的に消しているが、その代償が「1 行の更新でも before/after の全列が流れる」ことで、`binlog_row_image` はその代償を削るための逃げ道になっている。

## ソースコードのどこか

### ファイル先頭とイベントの 19 バイトヘッダ

マジックは [`sql/log_event.h#L213`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log_event.h#L213) にある。

```cpp title="sql/log_event.h"
#define BINLOG_MAGIC "\xfe\x62\x69\x6e"
#define BINLOG_MAGIC_SIZE 4
```

`\xfe` に続けて ASCII の `bin` だ。同じ 4 バイトが [`libs/mysql/binlog/event/binlog_event.h#L95`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/binlog_event.h#L95) の `BIN_LOG_HEADER_SIZE 4U` として長さ側で定義されている。

ヘッダのオフセットは [`binlog_event.h#L431`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/binlog_event.h#L431) に並んでいる。

```cpp title="libs/mysql/binlog/event/binlog_event.h"
#define EVENT_TYPE_OFFSET 4
#define SERVER_ID_OFFSET 5
#define EVENT_LEN_OFFSET 9
#define LOG_POS_OFFSET 13
#define FLAGS_OFFSET 17
...
#define LOG_EVENT_HEADER_LEN 19U /* the fixed header length */
```

このオフセットからバイト配置が確定する。

```
binlog ファイルの先頭
+--------+--------------------------------------------------+
| 0 .. 3 | \xFE 'b' 'i' 'n'   BIN_LOG_HEADER_SIZE = 4        |
+--------+--------------------------------------------------+
| 4 ..   | Format_description_event (常に最初のイベント)     |
| ...    | Previous_gtids_log_event                          |
| ...    | Gtid_log_event / Query / Table_map / Rows / Xid   |
+--------+--------------------------------------------------+

イベント 1 個の共通ヘッダ (LOG_EVENT_HEADER_LEN = 19)
 byte:  0        4    5        9        13       17   19
       +--------+----+--------+--------+--------+----+
       | when   |type| server | event  | log    |flag|
       | (4)    |(1) | _id(4) | _len(4)| _pos(4)|(2) |
       +--------+----+--------+--------+--------+----+
        ^        ^    ^        ^        ^        ^
        |        |    |        |        |        +-- LOG_EVENT_BINLOG_IN_USE_F = 0x1 など
        |        |    |        |        +----------- 「次のイベント」のファイル内位置
        |        |    |        +-------------------- ヘッダ + post-header + body の合計
        |        |    +----------------------------- 生成したサーバの server_id
        |        +---------------------------------- enum Log_event_type
        +------------------------------------------- UNIX 時刻 (秒)

       +--------------------+------------------+--------------+
       | post-header        | body             | checksum (4) |
       | 長さは FDE の      | 種別ごと         | CRC32、       |
       | post_header_len[]  | 可変長           | 有効時のみ    |
       +--------------------+------------------+--------------+
```

**`log_pos` が「このイベントの位置」ではなく「次のイベントの位置」である点**に注意。`SHOW BINLOG EVENTS` の `Pos` 列 (このイベントの開始位置) と `End_log_pos` 列 (= `log_pos`) の両方が出るのはこのためだ。

`flags` に立つビットのうち運用で意味があるのは `LOG_EVENT_BINLOG_IN_USE_F` ([L281](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/binlog_event.h#L281)) で、**FDE にこれが立ったままなら「サーバがこのファイルを閉じずに落ちた」ことを意味する**。起動時の binlog リカバリはこのフラグを見て、立っていなければスキャンを丸ごと省略する ([`binlog.cc#L7982`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/binlog.cc#L7982))。

### `Format_description_event` — 前方互換の実体

[`libs/mysql/binlog/event/control_events.h#L239`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/control_events.h#L239)。ヘッダのコメントに body のレイアウトがそのまま書いてある。

```cpp title="libs/mysql/binlog/event/control_events.h"
    +=====================================+
    | event  | binlog_version   19 : 2    | = 4
    | data   +----------------------------+
    |        | server_version   21 : 50   |
    |        +----------------------------+
    |        | create_timestamp 71 : 4    |
    |        +----------------------------+
    |        | header_length    75 : 1    |
    |        +----------------------------+
    |        | post-header      76 : n    | = array of n bytes, one byte
    |        | lengths for all            |   per event type that the
    |        | event types                |   server knows about
    +=====================================+
```

`binlog_version` は 8.0.2 以降 4 で固定されている ([`binlog_event.h#L106`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/binlog_event.h#L106) の `BINLOG_VERSION 4`)。**バージョン番号は 20 年動いていない。実際に互換性を運んでいるのは `post_header_len[]` のほうだ。**

配列の中身は [`control_events.cpp#L79`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/control_events.cpp#L79) のコンストラクタに直書きされている。

```cpp title="libs/mysql/binlog/event/control_events.cpp"
      static uint8_t server_event_header_length[] = {
          0, QUERY_HEADER_LEN, STOP_HEADER_LEN, ROTATE_HEADER_LEN,
          INTVAR_HEADER_LEN, 0,
          ...
          IGNORABLE_HEADER_LEN, IGNORABLE_HEADER_LEN, ROWS_HEADER_LEN_V2,
          ROWS_HEADER_LEN_V2, ROWS_HEADER_LEN_V2,
          Gtid_event::POST_HEADER_LENGTH, /*GTID_EVENT*/
```

長さ 0 のスロットが 3 つ並んでいるところ (`OBSOLETE_WRITE_ROWS_EVENT_V1` 以下) は、8.4.0 で V1 行イベントのコードが削除された跡だ。**種別番号は絶対に詰めない**という規約が `enum Log_event_type` のコメントに書かれている ([L286](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/binlog_event.h#L286))。

```cpp title="libs/mysql/binlog/event/binlog_event.h"
    - Assign it a number explicitly. Otherwise it will cause trouble
      if a event type before is deprecated and removed directly from
      the enum.
```

配列の末尾にはチェックサムアルゴリズムの記述子が 1 バイト付く。`BINLOG_CHECKSUM_ALG_CRC32 = 1` が既定で、これがイベント末尾の 4 バイト CRC32 の有無を決める ([L469](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/binlog_event.h#L469))。

### イベント種別 — 8.4 で増えたもの

[`binlog_event.h#L286`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/binlog_event.h#L286) の `enum Log_event_type`。1 つのトランザクションで実際に流れる並びはこうなる。

```
GTID_LOG_EVENT (33) or GTID_TAGGED_LOG_EVENT (42) or ANONYMOUS_GTID_LOG_EVENT (34)
  QUERY_EVENT (2)          -- "BEGIN"
  TABLE_MAP_EVENT (19)     -- テーブルごとに 1 個
  WRITE_ROWS_EVENT (30) / UPDATE_ROWS_EVENT (31) / DELETE_ROWS_EVENT (32)
  ...
XID_EVENT (16)             -- InnoDB の XID。ここがトランザクション境界
```

8.4 で加わったのが `GTID_TAGGED_LOG_EVENT = 42` で、tagged GTID (`UUID:TAG:GNO`) を運ぶ ([GTID のページ](./gtid/))。`TRANSACTION_PAYLOAD_EVENT = 40` は圧縮されたトランザクション全体を包む。

### `Table_map_log_event` — 型は入るが列名は入らない

[`sql/log_event.h#L2430`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log_event.h#L2430)。post-header は `TABLE_MAP_HEADER_LEN = 8` で `table_id` (6) + `flags` (2)。body は `rows_event.h` のコメントに列挙されている ([`rows_event.h#L68` のクラスコメント](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/rows_event.h#L68))。

```
database_name / table_name / column_count
column_type[]     -- 1 バイト × 列数。enum_field_types
metadata_length + metadata[]  -- 型ごとの付随情報 (VARCHAR の長さ、DECIMAL の精度など)
null_bits         -- 列数ぶんのビット (NULL 可か)
optional metadata fields (TLV)
```

最後の TLV に何を入れるかを決めているのが [`Table_map_log_event::init_metadata_fields` (`log_event.cc#L11294`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log_event.cc#L11294) だ。

```cpp title="sql/log_event.cc"
  if (init_signedness_field() ||
      init_charset_field(&is_character_field, DEFAULT_CHARSET,
                         COLUMN_CHARSET) ||
      init_geometry_type_field()) {
    m_metadata_buf.length(0);
    return;
  }

  if (binlog_row_metadata == BINLOG_ROW_METADATA_FULL) {
    if (DBUG_EVALUATE_IF("dont_log_column_name", 0, init_column_name_field()) ||
        init_charset_field(&is_enum_or_set_field, ENUM_AND_SET_DEFAULT_CHARSET,
                           ENUM_AND_SET_COLUMN_CHARSET) ||
        init_set_str_value_field() || init_enum_str_value_field() ||
        init_primary_key_field() || init_column_visibility_field()) {
```

**この if 文が `binlog_row_metadata` の全部だ。** 既定の `MINIMAL` ([`sys_vars.cc#L1568`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L1568) で `DEFAULT(BINLOG_ROW_METADATA_MINIMAL)`) では次の 3 つしか書かれない。

| 常に書かれる                         | `FULL` のときだけ追加される                            |
| ------------------------------------ | ------------------------------------------------------ |
| `SIGNEDNESS` (数値列の UNSIGNED)     | `COLUMN_NAME` (列名)                                   |
| `DEFAULT_CHARSET` / `COLUMN_CHARSET` | `ENUM_AND_SET_*_CHARSET`                               |
| `GEOMETRY_TYPE`                      | `SET_STR_VALUE` / `ENUM_STR_VALUE` (SET/ENUM の文字列) |
|                                      | `SIMPLE_PRIMARY_KEY` / `PRIMARY_KEY_WITH_PREFIX`       |
|                                      | `COLUMN_VISIBILITY`                                    |

**MINIMAL で足りるのは、レプリカが自分のテーブル定義を持っているからだ。** 列は位置で対応づける。だから「レプリカ側に定義がない」読み手 — つまり CDC ツール — にとっては情報が決定的に足りない。

### `Rows_log_event` — 2 枚のビットマップ

[`sql/log_event.h#L2765`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log_event.h#L2765)。post-header は `ROWS_HEADER_LEN_V2 = 10` で `table_id` (6) + `flags` (2) + `extra_row_info` の長さ (2)。

body には 2 枚のビットマップが入る。

```cpp title="sql/log_event.h"
  MY_BITMAP m_cols; /* Bitmap denoting columns available */
  ...
  MY_BITMAP m_cols_ai;
```

`m_cols` が before image、`m_cols_ai` が after image に含まれる列を示す。`UPDATE_ROWS_EVENT` だけが 2 枚を使い、`WRITE`/`DELETE` は 1 枚だ。

このビットマップを削るのが `binlog_row_image` で、実装は [`binlog_prepare_row_images` (`binlog.cc#L11329`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/binlog.cc#L11329)。

```cpp title="sql/binlog.cc"
    switch (thd->variables.binlog_row_image) {
      case BINLOG_ROW_IMAGE_MINIMAL:
        /* MINIMAL: Mark only PK */
        table->mark_columns_used_by_index_no_reset(table->s->primary_key,
                                                   &table->tmp_set);
        break;
      case BINLOG_ROW_IMAGE_NOBLOB:
```

既定は `FULL` ([`sys_vars.cc#L1553`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L1553))。`MINIMAL` にすると before image が PK だけ、after image が変更列だけになる。

### `Transaction_payload_log_event` — 中身が見えなくなる包み

[`sql/log_event.h#L3846`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log_event.h#L3846)、基底は [`control_events.h#L735`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/control_events.h#L735)。

```cpp title="libs/mysql/binlog/event/control_events.h"
/// Event that encloses all the events of a transaction.
///
/// It is used for carrying compressed payloads, and contains
/// compression metadata.
class Transaction_payload_event : public Binary_log_event {
```

`binlog_transaction_compression=ON` (既定 OFF、[`sys_vars.cc#L1589`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L1589)) にすると、`Gtid_log_event` を除くトランザクションの全イベントが zstd で圧縮されて 1 個のこのイベントに畳まれる。アルゴリズムの enum は 2 値しかない ([`compression/base.h#L40`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/libs/mysql/binlog/event/compression/base.h#L40))。

```cpp title="libs/mysql/binlog/event/compression/base.h"
enum type {
  /* ZSTD compression. */
  ZSTD = 0,
  ...
  NONE = 255,
};
```

**外から見えるのは「圧縮方式」「圧縮後サイズ」「展開後サイズ」だけで、中の `Table_map` も `Rows` も展開しないと存在すら分からない。**

### `Xid_log_event` — トランザクション境界

[`sql/log_event.h#L1771`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log_event.h#L1771)。post-header の長さは `XID_HEADER_LEN = 0` で、body は 8 バイトの XID だけ。この XID が InnoDB の XA PREPARE レコードに入っている XID と同じで、クラッシュリカバリの突き合わせに使われる ([2PC とグループコミット](./two-phase-commit-and-group-commit/))。

## どう活かすか

**CDC (Debezium など) を入れるなら `binlog_row_metadata=FULL` を先に検討する。** MINIMAL のままだと `Table_map` に列名がないので、CDC 側はスキーマを別経路 (`information_schema` への問い合わせや DDL の追跡) で組み立てて位置で対応づけることになる。**DDL とデータの間にレースが生じる**のはこれが原因だ。列を途中に足した瞬間の binlog を、更新後のスキーマで解釈すると値が 1 つずれる。FULL にすればイベント自身が列名を持つので、この種のずれが構造的に消える。代償はイベントサイズで、列数の多いテーブルへの小さな更新ほど相対コストが大きい。

**`binlog_row_image=MINIMAL` にすると CDC の "before" が壊れる。** before image が PK だけになるので、「変更前の値」を必要とする下流 (監査ログ、差分の再構成、レプリケーションでない用途) が動かなくなる。レプリケーションだけなら MINIMAL で問題ないが、**CDC が同じ binlog を読んでいるなら FULL のままにする**。この 2 つは同じ binlog を共有していて、片方の都合で削ると他方が壊れる。

**PK のないテーブルでは `binlog_row_image=MINIMAL` が効かない。** `binlog_prepare_row_images` の条件が `table->s->primary_key < MAX_KEY` なので、PK がなければ全列が入る。加えてレプリカ側は行を探すのに全表スキャンかハッシュスキャンをすることになり、**PK なしテーブルはレプリカ遅延の代表的な原因**になる ([applier と並列適用](./applier-and-mta/))。

**`binlog_transaction_compression=ON` にすると `mysqlbinlog` の出力の見え方が変わる。** `Transaction_payload_log_event` の中は展開しないと見えないので、grep でイベントを拾う運用スクリプトが空振りする。`mysqlbinlog` 自体は展開して表示するが、`SHOW BINLOG EVENTS` では 1 個の `Transaction_payload` として見える。CDC ツールが対応しているかを先に確認する。

**`SHOW BINLOG EVENTS` の `End_log_pos` は「次のイベントの開始位置」。** `SOURCE_LOG_POS` に指定するのはこの値だ。「このイベントから」と考えて `Pos` を指定すると 1 イベント分やり直すことになる。

**`mysqlbinlog` で「Found invalid event in binary log」が出たら、まず FDE のチェックサム設定を疑う。** イベント末尾の CRC32 の有無は FDE の `post_header_len[]` 末尾 1 バイトで決まるので、**FDE を含まない範囲だけを切り出して読ませると必ず失敗する**。`--start-position` を使うときは同じファイルの先頭から読ませるか、`--read-from-remote-server` を使う。
