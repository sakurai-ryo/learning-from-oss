---
title: "用語集 — THD・latch・mtr が指すもの"
description: "この章のページはどこから読み始めても、MySQL 固有の語彙にいきなりぶつかる。THD、latch、mtr、LSN、AccessPath、heap_no。どれもコードを読むときの土台になる語だが、意味を 1 箇所にまとめた場所がないと途中で止まる。ここは辞書として引くページで、各語を 1〜2 行で定義し、詳しく書いたページに送る。特に紛らわしい語 — lock と latch、2 つある mtr、SQL 層の行と InnoDB の行 — を先頭に置いた。"
group: "前提 — 用語と DB の基礎"
sidebar:
  order: 0.5
---

## 何を学んだか

MySQL のコードを読んでいて手が止まるのは、たいてい難しい概念ではなく**知らない略語**だ。`THD` はこの章の 40 ページに、`latch` は 28 ページに、`mtr` は 29 ページに出てくる。層を上から順に読めば初出で説明されるが、サイドバーや[症状索引](./symptom-index/)から途中に着地するとそうはいかない。

このページは通読するものではない。**知らない語に当たったときに戻ってくる場所**として置いてある。

## 紛らわしい語 — 先にここだけ

同じ綴りで別物、あるいは日本語にすると同じ言葉になってしまう組が MySQL にはいくつかある。ここを取り違えると、後のページが丸ごと読めなくなる。

| 語                           | 区別                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **lock と latch**            | **lock** はトランザクションが持つ論理的な権利。トランザクションが終わるまで保持され、待つことができ、デッドロック検出の対象になる。**latch** はデータ構造 (ページ、リスト、ハッシュ) を守る短命な排他で、数命令〜数マイクロ秒で放す。latch のデッドロックは検出されず、**取得順序 (latching order) を守ることでしか防げない**。→ [ロックの種類](./lock-kinds/) / [lock_sys](./lock-sys-sharding/) |
| **mtr が 2 つある**          | InnoDB の **mini-transaction** (`mtr_t`、ページ変更と redo の原子単位) と、テストドライバ **`mysql-test-run.pl`** の略称。無関係。→ [mini-transaction](./mini-transaction/) / [MTR とユニットテスト](./mtr-and-unit-tests/)                                                                                                                                                                       |
| **SQL 層の行と InnoDB の行** | SQL 層の 1 行は `TABLE::record[0]` というバイト列、InnoDB の 1 行は `rec_t` という別フォーマット。`handler` の境界で**毎回詰め替えている**。「行」と言ったときどちらの話かで、NULL の表現も可変長の持ち方も違う。→ [行フォーマット変換](./row-format-conversion/)                                                                                                                                 |
| **ページとブロック**         | **ページ**はディスク上・ファイル上の 16KB。**ブロック** (`buf_block_t`) はバッファプール上のその置き場で、フレームへのポインタと latch とリストのリンクが付いている。→ [バッファプール](./buffer-pool-walkthrough/)                                                                                                                                                                               |
| **index と key**             | SQL 層は `KEY`、InnoDB は `dict_index_t` と呼ぶ。同じものの両側からの名前。EXPLAIN の `key` 列は SQL 層の語彙。                                                                                                                                                                                                                                                                                   |
| **MTS と MTA**               | 並列適用の呼び名が変わっただけで同じ機構。古い記事の Multi-Threaded Slave が今の Multi-Threaded Applier。→ [applier と並列適用](./applier-and-mta/)                                                                                                                                                                                                                                               |
| **`Seconds_Behind_Source`**  | 「遅延」ではなく、**applier が今処理しているイベントの発生時刻と現在時刻の差**。receiver が止まっていれば 0 のまま増えない。→ [レプリカ遅延の正体](./replication-lag/)                                                                                                                                                                                                                            |
| **`Using filesort`**         | ファイルを使うとは限らない。`sort_buffer_size` に収まればメモリだけで終わる。→ [filesort](./filesort/)                                                                                                                                                                                                                                                                                            |

## Server 層

| 語                                 | 意味                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THD`                              | 接続 1 本ぶんの状態を全部ぶら下げた構造体。エラー、診断領域、トランザクション状態、メモリルート、変数。SQL 層のほぼ全関数が第 1 引数で受け取る。→ [接続層](./connection-layer/)                                                                                                 |
| `Item`                             | 式ツリーのノード。`WHERE a = 1` なら `=` も `a` も `1` もすべて `Item` の派生クラス。→ [名前解決と Item ツリー](./name-resolution-and-items/)                                                                                                                                   |
| `Query_block` / `Query_expression` | `Query_block` が 1 つの `SELECT`、`Query_expression` がそれを束ねる単位 (UNION や派生表)。パーサの出力はこの入れ子。→ [パーサとリゾルバ](./parser-walkthrough/)                                                                                                                 |
| `TABLE` / `TABLE_SHARE`            | `TABLE` は接続ごとのテーブルインスタンス、`TABLE_SHARE` は全接続で共有する定義。`TABLE` の中に `record[0]` がある。                                                                                                                                                             |
| `record[0]`                        | 1 行ぶんのバイト列バッファ。SQL 層と `handler` はここを介して行を受け渡す。「現在行」はここに入っている。→ [行フォーマット変換](./row-format-conversion/)                                                                                                                       |
| `handler` / `handlerton`           | `handler` は**テーブル 1 つぶん**のストレージエンジンのハンドル (InnoDB なら `ha_innobase`)。`handlerton` は**エンジンそのもの**を表すシングルトンで、コミットやリカバリのようなテーブルに紐づかない操作がぶら下がる。→ [pluggable storage engine](./pluggable-storage-engine/) |
| `AccessPath`                       | オプティマイザの出力であり実行器の入力である木。`EXPLAIN FORMAT=TREE` が印字しているのはこれ。→ [AccessPath](./access-path-tree/)                                                                                                                                               |
| `RowIterator`                      | 実行の単位。`Init()` と `Read()` しか持たない。`AccessPath` の木から作られる。→ [iterator executor](./executor-walkthrough/)                                                                                                                                                    |
| `JOIN_TAB` / `QEP_TAB`             | `AccessPath` 以前の表現で、8.4 にも残っている。ICP を押し込むかの判断などがまだこちらにある。`EXPLAIN` の表形式はこの時代の名残。                                                                                                                                               |
| `MDL`                              | メタデータロック。テーブル**定義**を守る機構で、InnoDB の行ロックとは完全に別系統。`ALTER` が固まる原因の大半はこちら。→ [MDL](./metadata-locking/)                                                                                                                             |
| DD (データディクショナリ)          | 8.0 以降、テーブル定義は `mysql.ibd` の中の InnoDB テーブルに入っている。`.frm` はもうない。→ [データディクショナリ](./data-dictionary/)                                                                                                                                        |

## InnoDB — 構造体

| 語                              | 意味                                                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trx_t`                         | トランザクション 1 本。→ [トランザクション](./transaction-walkthrough/)                                                                                                                         |
| `trx_id`                        | 単調増加の番号。**読み書きを始めたトランザクションにだけ**振られる。読み取り専用には振られないので、`SELECT` だけのトランザクションは ID を消費しない。                                         |
| `ReadView`                      | 可視性判定に使う 4 フィールド (`m_up_limit_id` / `m_low_limit_id` / `m_ids` / `m_creator_trx_id`)。データのコピーは 1 バイトも入っていない。→ [read view と可視性](./read-view-and-visibility/) |
| `rec_t`                         | InnoDB のレコード。ポインタが指すのは**ヘッダの後ろ**で、ヘッダは負のオフセットで読む。→ [レコードの構造](./record-format/)                                                                     |
| `heap_no`                       | ページ内でのレコードの通し番号。**ロックの bitmap の添字**がこれ。行ロックが「ページ + heap_no のビット」で表せるのはこのため。→ [ページの構造](./page-layout/)                                 |
| page id                         | `(space_id, page_no)` の組。ページの住所で、バッファプールのハッシュのキーになる。                                                                                                              |
| `buf_page_t` / `buf_block_t`    | `buf_page_t` がページの記述子、`buf_block_t` はそれを先頭に埋め込んで 16KB フレームへのポインタとページ latch を足したもの。→ [バッファプール](./buffer-pool-walkthrough/)                      |
| `dict_table_t` / `dict_index_t` | InnoDB 側のテーブル・インデックスのメタデータ。SQL 層の `TABLE_SHARE` / `KEY` に対応する。                                                                                                      |
| `fil_space_t`                   | テーブルスペース 1 つ。`space_id` で引く。→ [物理構造](./innodb-physical-walkthrough/)                                                                                                          |
| `row_prebuilt_t`                | `ha_innobase` と InnoDB 本体の間に置かれる状態の置き場。1 回のスキャンで使う検索タプルやバッファがここに載る。→ [handler](./handler-walkthrough/)                                               |

## InnoDB — ログとリスト

| 語                                | 意味                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LSN                               | Log Sequence Number。**redo ログの先頭からのバイト数**で、単調増加する。時刻でもカウンタでもなくオフセットなので、2 つの LSN の差はそのままバイト数になる。→ [redo ログ](./redo-log-walkthrough/)               |
| mini-transaction (`mtr_t`)        | ページ変更と redo レコードの原子単位。「このページ群への変更は全部当たるか全部当たらないか」を保証する。→ [mini-transaction](./mini-transaction/)                                                               |
| redo / undo                       | **redo** は物理ログで、クラッシュ後にページへ当て直すために使う。**undo** は論理ログで、ロールバックと**古い版の供給**の両方に使う。MVCC が undo に依存しているのはこの二役目のため。→ [undo ログ](./undo-log/) |
| flush list / LRU list / free list | バッファプールの 3 本のリスト。flush list は dirty page を**最古の変更 LSN 順**に並べ、LRU list は追い出し順、free list は空きフレーム。→ [flush list と page cleaner](./flush-list-and-page-cleaner/)          |
| checkpoint LSN                    | 「これより前の redo はもう要らない」という印。redo ファイルを再利用できる位置を決める。→ [チェックポイント](./checkpoint/)                                                                                      |
| history list                      | purge がまだ回収していない undo の列。`SHOW ENGINE INNODB STATUS` の `History list length` がこの長さ。→ [purge](./purge/)                                                                                      |
| doublewrite                       | ページを本来の位置に書く前に専用領域へ二度書きする仕組み。torn page (書きかけのページ) からの復旧に使う。→ [doublewrite](./doublewrite/)                                                                        |

## ロック

| 語                         | 意味                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| record lock                | レコードそのものに掛けるロック。`LOCK_REC_NOT_GAP`。                                                                                                                                                                           |
| gap lock                   | レコードとレコードの**間**に掛けるロック。行がないところをロックする。`LOCK_GAP`。                                                                                                                                             |
| next-key lock              | レコード + その手前のギャップ。**InnoDB の既定はこれ**で、フラグ上は `LOCK_ORDINARY` (値 0) として表される。「フラグが何も立っていない = next-key」という表現になっている。→ [ロックの種類](./lock-modes-and-types/)           |
| insert intention lock      | ギャップに挿入したいという意思表示。ギャップロックとは衝突するが、insert intention 同士は衝突しない。→ [INSERT のロック](./insert-and-duplicate-check/)                                                                        |
| 暗黙ロック (implicit lock) | レコードの `trx_id` が自分自身なら `lock_t` を作らない最適化。他のトランザクションが来たときに初めて明示ロックに変換される。**`data_locks` に出てこないロックがある**のはこれが理由。→ [ロックの種類](./lock-modes-and-types/) |
| 意図ロック (IS / IX)       | テーブルレベルの「この表の中で行ロックを取るつもりだ」という宣言。行ロックと表ロックの衝突判定を表レベルで済ませるためにある。→ [ロックの種類 (前提)](./lock-kinds/)                                                           |
| `lock_t`                   | ロック 1 個ぶんの構造体だが、対応するのは**行 1 件ではなくページ 1 枚**。その中のどの行かは `heap_no` のビットで持つ。→ [lock_sys](./lock-sys-sharding/)                                                                       |

## レプリケーション

| 語                 | 意味                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| binlog / relay log | **binlog** はソース側が書く変更の記録。**relay log** はレプリカが受け取ってローカルに落としたその写し。フォーマットは同じ。→ [binlog](./binlog-walkthrough/)                                                                 |
| receiver / applier | かつての I/O thread と SQL thread。receiver がソースから受けて relay log に書き、applier が読んで適用する。並列適用時は applier が coordinator + worker に分かれる。→ [dump thread と receiver](./dump-thread-and-receiver/) |
| GTID               | `source_uuid:transaction_id` の形の、トランザクションに付く世界で一意な名前。→ [GTID](./gtid/)                                                                                                                               |
| writeset           | トランザクションが触れた行のハッシュ集合。並列適用で「このトランザクション同士は競合しないから同時に流せる」を判定するのに使う。8.4 の既定。→ [applier と並列適用](./applier-and-mta/)                                       |

## 観測

| 語                         | 意味                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P_S (`performance_schema`) | サーバのコードに埋め込まれた計装点が書き出すメモリ上のテーブル群。→ [performance_schema](./performance-schema-internals/)                                            |
| `sys` スキーマ             | P_S と `information_schema` の上に張られたビューとプロシージャ。生の P_S より読みやすい形にしてある。→ [data_locks と sys スキーマ](./data-locks-and-sys-schema/)    |
| optimizer trace            | 最適化の途中経過を JSON で吐く仕組み。`EXPLAIN` に出ない「なぜそれを選ばなかったか」がここにある。→ [EXPLAIN ANALYZE / optimizer trace](./explain-analyze-and-tree/) |
