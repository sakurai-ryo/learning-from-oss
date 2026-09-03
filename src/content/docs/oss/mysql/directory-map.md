---
title: "ディレクトリ地図 — `sql/` と `storage/innobase/`"
description: "mysql-server のツリーは、まず sql/ (1557 ファイル) と storage/innobase/ (552 ファイル) の 2 つに割れる。この 2 つの境界が handler API で、章立てはほぼこの境界のどちら側かで決まる。大きいファイルの行数を先に知っておくと、grep の結果を見たときに読むべきか飛ばすべきかの判断がつく。8.0 時代の名前で探して見つからないものの対応表も置く。"
group: "全体像"
sidebar:
  order: 9
---

## 何を学んだか

このツリーで迷わないための地図を先に置く。**`sql/` が SQL 層、`storage/innobase/` がストレージエンジンで、両者は [`sql/handler.h`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/handler.h) の `class handler` だけで繋がっている。** この境界の意味は[handler のページ](./handler-walkthrough/)で扱う。

もうひとつ知っておくべきなのは、**このツリーには「異常に大きいファイル」がいくつかあり、そこに機能が集中している**ことだ。`ha_innodb.cc` は 24437 行あって、InnoDB が SQL 層に見せる顔がほぼ全部ここに集まっている。grep して 1 ファイルに数十ヒットしたとき、それが 24000 行のファイルなのか 400 行のファイルなのかで読み方が変わる。

## ソースコードのどこか

### トップレベル

| ディレクトリ               | ファイル数 | 中身                                                                                 | この章での扱い                                        |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `sql/`                     | 1557       | SQL 層のすべて。パーサ、オプティマイザ、エグゼキュータ、DD、binlog、レプリケーション | 群 3〜7、13〜15                                       |
| `storage/innobase/`        | 552        | InnoDB                                                                               | 群 8〜12                                              |
| `storage/perfschema/`      | 351        | performance_schema のテーブル実装                                                    | [P_S のページ](./performance-schema-internals/)       |
| `storage/temptable/`       | —          | 内部一時表のエンジン                                                                 | [一時表のページ](./materialization-and-temptable/)    |
| `sql-common/`              | —          | サーバとクライアントで共有するコード (`client.cc` 9645 行、`net_serv.cc`)            | 群 3                                                  |
| `libmysql/`                | —          | C API のうち prepared statement 側                                                   | [PS のページ](./binary-protocol-prepared-statements/) |
| `plugin/x/`                | 530        | X Plugin (X Protocol、33060 番ポート)                                                | [X Protocol のページ](./x-protocol-messages/)         |
| `plugin/semisync/`         | —          | 半同期レプリケーション                                                               | [semi-sync のページ](./semi-sync/)                    |
| `libs/mysql/binlog/event/` | 67         | binlog イベントの wire フォーマット定義                                              | [binlog イベントのページ](./binlog-events/)           |
| `mysql-test/`              | —          | MTR。`t/*.test` + `r/*.result`                                                       | [MTR のページ](./mtr-and-unit-tests/)                 |

`libbinlogevents/` という名前を覚えている読者がいるかもしれないが、**8.4.11 ではこれは `libs/mysql/binlog/event/` への転送スタブになっている**。実体を読みたいときは後者を見る。

### `sql/` の中の下位ディレクトリ

`sql/` は 1557 ファイルの平地ではなく、機能ごとに切り出されたサブディレクトリがある。ここを知らないと「昔あったはずのファイルがない」ことになる。

| パス                   | ファイル数 | 中身                                                                                     |
| ---------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `sql/dd/`              | 362        | データディクショナリ。`mysql.ibd` に入るメタデータの型と、それを読み書きするクライアント |
| `sql/range_optimizer/` | 36         | range 分析。**`sql/opt_range.cc` はもう存在しない**。partition pruning もここ            |
| `sql/join_optimizer/`  | 45         | `AccessPath` の定義と、hypergraph オプティマイザ                                         |
| `sql/iterators/`       | 22         | エグゼキュータ。`RowIterator` とその実装                                                 |
| `sql/conn_handler/`    | —          | acceptor と接続ハンドラ                                                                  |
| `sql/auth/`            | —          | 認証と ACL。この章では握手部分だけ                                                       |
| `sql/histograms/`      | —          | ヒストグラム                                                                             |
| `sql/binlog/`          | —          | group commit の ticket 管理、binlog recovery                                             |
| `sql/partitioning/`    | —          | パーティション対応の handler ラッパ                                                      |

### 大きいファイルの行数

grep する前に頭に入れておくと判断が速い。

```
24437  storage/innobase/handler/ha_innodb.cc      InnoDB が SQL 層に見せる顔のすべて
20072  sql/sql_table.cc                            CREATE / ALTER / DROP TABLE
18364  sql/sql_yacc.yy                             Bison 文法
11915  storage/innobase/fil/fil0fil.cc             テーブルスペースとファイル I/O
11733  sql/binlog.cc                               binlog キャッシュ、group commit
11321  storage/innobase/handler/handler0alter.cc   INPLACE ALTER の InnoDB 側
10068  storage/perfschema/pfs.cc                   P_S の計装エントリポイント
 9645  sql-common/client.cc                        クライアント C API の本体
 8273  sql/join_optimizer/join_optimizer.cc        hypergraph オプティマイザ
 6289  storage/innobase/lock/lock0lock.cc          行ロック
 4916  sql/mdl.cc                                  メタデータロック
 2657  sql/opt_explain.cc                          EXPLAIN
```

対照的に、**中身が薄いファイルもある**。`sql/opt_statistics.cc` は 120 行で関数 1 つしかない。「MySQL の統計情報」を探してここを開くと肩透かしを食うが、それ自体が情報で、**カーディナリティ推定の実体は InnoDB 側の `records_in_range` と `rec_per_key` にある** ([統計とコストモデルのページ](./statistics-and-cost-model/))。`sql/sql_alter.cc` も 449 行しかなく、ALGORITHM / LOCK の決定はほぼ `handler0alter.cc` (11321 行) 側にある。

### `storage/innobase/` の命名規則

InnoDB のファイル名は `<モジュール><番号><名前>.cc` という古い規則に従っている。慣れると grep が速くなる。

| プレフィクス    | 意味                               | 主なファイル                                                                                                        |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `btr0`          | B+tree                             | `btr0cur.cc` (カーソル)、`btr0btr.cc` (分割・併合)、`btr0pcur.cc` (persistent cursor)、`btr0sea.cc` (adaptive hash) |
| `buf0`          | バッファプール                     | `buf0buf.cc`、`buf0lru.cc`、`buf0flu.cc`、`buf0rea.cc`、`buf0dblwr.cc`                                              |
| `dict0`         | データディクショナリ (InnoDB 内部) | `dict0dict.cc`、`dict0mem.cc`、`dict0stats.cc`                                                                      |
| `fil0` / `fsp0` | ファイル / テーブルスペース        | `fil0fil.cc`、`fsp0fsp.cc`                                                                                          |
| `lock0`         | ロック                             | `lock0lock.cc`、`lock0wait.cc`、`lock0latches.cc`                                                                   |
| `log0`          | redo ログ                          | `log0write.cc`、`log0chkp.cc`、`log0recv.cc`、`log0files_governor.cc`、`log0ddl.cc`                                 |
| `mtr0`          | mini-transaction                   | `mtr0mtr.cc`、`mtr0log.cc`                                                                                          |
| `page0`         | ページ                             | `page0page.cc`、`page0cur.cc`                                                                                       |
| `rem0`          | レコード (record manager)          | `rem0rec.cc`、`rem0cmp.cc`                                                                                          |
| `row0`          | 行操作                             | `row0sel.cc`、`row0ins.cc`、`row0upd.cc`、`row0mysql.cc`、`row0vers.cc`、`row0log.cc`                               |
| `srv0`          | サーバ (背景スレッドと変数)        | `srv0srv.cc`、`srv0start.cc`、`srv0mon.cc`                                                                          |
| `trx0`          | トランザクション                   | `trx0trx.cc`、`trx0undo.cc`、`trx0rec.cc`、`trx0purge.cc`、`trx0sys.cc`                                             |

**ヘッダの置き場所に例外がある。** InnoDB のヘッダは基本的に `storage/innobase/include/` にあるが、**レコードヘッダの定数だけは `storage/innobase/rem/rec.h`** というモジュール内 private ヘッダにある。`REC_INFO_DELETED_FLAG` を `include/` で grep しても出ない ([レコード構造のページ](./record-format/))。

## なぜそうなっているか

**`sql/` が平地に近いのは、モジュール境界が後から引かれたからだ。** `sql/range_optimizer/`、`sql/join_optimizer/`、`sql/iterators/` はどれも 8.0 系で既存の巨大ファイルから切り出されたもので、`sql/opt_range.cc` が消えたのはその副作用だ。逆に `sql_table.cc` (20072 行) や `ha_innodb.cc` (24437 行) は切り出しが進んでいない部分で、**「切り出されているか」がそのモジュールに近年手が入ったかの指標になる**。

**InnoDB の `<モジュール><番号>` 命名は、C 時代の名前空間の代用だ。** `btr_cur_search_to_nth_level` のように関数名にもモジュール名が前置されていて、これは C++ の名前空間が使えなかった時代の慣習がそのまま残っている。8.4 でも [`btr_cur_search_to_nth_level`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/btr/btr0cur.cc#L620) は free function のままで、メソッド化されたのは `btr_pcur_t` のような一部の型だけだ。

## どう活かすか

**「昔あったファイル」を探して見つからないときは、切り出し先を疑う。** この章で実際にぶつかるものを挙げておく。

| 学習データにありがちな名前 | 8.4.11 での実体                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- |
| `sql/opt_range.cc`         | `sql/range_optimizer/` 以下に分割                                               |
| `mysql_parse`              | `dispatch_sql_command` (`sql/sql_parse.cc#L5275`)                               |
| `JOIN::exec`               | 存在しない。`Query_expression::ExecuteIteratorQuery` (`sql/sql_union.cc#L1688`) |
| `libbinlogevents/`         | `libs/mysql/binlog/event/` (前者は転送スタブ)                                   |
| `TABLE_LIST`               | `Table_ref` (`sql/table.h#L2865`)                                               |
| `Sid_map`                  | `Tsid_map` (tagged GTID 対応で改名)                                             |
| `I_S.INNODB_LOCKS`         | 存在しない。`performance_schema.data_locks`                                     |

**grep の起点を層で選ぶ。** 症状が「SQL の書き方で変わる」なら `sql/`、「同じ SQL でもデータ量や並行度で変わる」なら `storage/innobase/` を先に見る。この判断の実例は[症状索引](./symptom-index/)に集めた。

**行数を見てから読む。** `ha_innodb.cc` に 30 ヒットしたときに全部読む必要はまずない。この章の各ページは、24437 行のうちどの関数が入口なのかを先に示す形で書いてある。
