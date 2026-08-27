---
title: "前提: RDB の言葉で読む InfluxDB 3 のデータモデルとアーキテクチャ"
description: "measurement はテーブル、tag + time は主キー、カタログは pg_catalog、DataFusion はオプティマイザ。では WAL は何で、バッファプールと B-tree はどこに行ったのか。RDB の内部構造を知っている読者に向けて、この章の他のページが前提にしている語彙と全体像を先に置く。"
group: "前提"
sidebar:
  order: 1
---

この章の他のページは、どれも「WAL」「カタログ」「gen1 チャンク」「スナップショット」といった言葉を説明なしで使っている。このページはその語彙と全体像をまとめたものだ。

読者は RDB (PostgreSQL や MySQL) の内部構造 — WAL、バッファプール、B-tree、システムカタログ、オプティマイザ、MVCC — に馴染みがあるものとする。**同じ名前で違うものを指している概念** と、**RDB には対応物が無い概念** を先に潰しておくのが目的で、対応表だけ眺めて他のページに進んでも構わない。

## InfluxDB 3 が前提にしているワークロード

設計の理由の大半は、想定しているワークロードの形から来ている。

- **書き込みは追記がほぼ全部。** 過去の行を更新することは稀で、あっても「同じ主キーの行をもう一度送る」形になる。
- **行単位の削除が無い。** データが消えるのは保持期間 (retention period) の経過か、テーブル・データベースごとの削除のときだけ。`DELETE FROM ... WHERE` に相当する API は存在しない。
- **クエリは必ず時間で絞る。** そして直近が圧倒的に熱い。1 年前のデータへのクエリはたまにしか来ない。
- **書き込み QPS がクエリ QPS より桁で大きい。** 秒間数百万行の取り込みに対し、クエリはダッシュボードからの数十 QPS。
- **カーディナリティが大きい。** `host` × `region` × `container_id` の組み合わせ (これを series と呼ぶ) が数百万になる。

OLTP の RDB が最適化している対象 — 点更新、二次索引の探索、行ロック、MVCC によるスナップショット分離 — は、ここではほぼ全部が不要か、割に合わない。逆に「時間範囲で数億行をスキャンして集約する」は RDB が苦手とするところで、そこに列指向と Parquet が効く。

## データモデル

書き込みは line protocol という行形式で来る。

```
cpu,host=a,region=us-west usage=0.5,temp=42 1700000000000000000
^^^ ^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^
 |          |                   |                   |
 |          |                   |                   +-- time (ナノ秒)
 |          |                   +-- field: 値の列
 |          +-- tag: 文字列限定の列
 +-- measurement: テーブル
```

RDB の言葉に置き換えるとこうなる。

- **measurement = テーブル。** 上の例は `cpu` テーブルへの 1 行の挿入。
- **tag = 文字列型の列で、主キーの一部。** 値は必ず文字列。メモリ上でも Parquet でも辞書エンコードされる ([メモリバッファのページ](../table-buffer-arrow/))。低カーディナリティ前提の設計。
- **field = 値の列。** `i64` / `u64` / `f64` / `string` / `bool` のいずれか。
- **time = 必須の列。** 型は i64 のナノ秒エポック固定。名前も `time` 固定。

そして **series key** と **sort key** がこの章で繰り返し出てくる ([`influxdb3_catalog/src/catalog/versions/v3/schema/table.rs#L51-L62`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/schema/table.rs#L51-L62))。

```rust title="influxdb3_catalog/src/catalog/versions/v3/schema/table.rs"
    /// List of column identifiers that form the series key for the table
    ///
    /// The series key is used as the sort order, i.e., sort key, for the table during persistence.
    pub series_key: Vec<TagId>,
    /* ... */
    /// The sort key for the table when persisted to storage.
    ///
    /// The sort key is the series key along with the `time` column form the primary key for the
    /// table. The series key is determined as the order of tags provided when the table is
    /// first created, either by a write of line protocol, or by an explicit table creation.
    pub sort_key: SortKey,
```

つまり **主キー = (tag 列の並び..., time)**。RDB でいえば `PRIMARY KEY (host, region, time)` のクラスタ化インデックスに近い。並び順は「テーブルが最初に作られたときのタグの順序」で決まり、後から追加されたタグは末尾に足される。

### 主キーの重複は UPSERT

同じ主キーの行を 2 回書いても、エラーにはならない。書き込み時には重複の検査すらしない。**解決はクエリのときに行われる** ([`core/iox_query/src/provider/deduplicate.rs#L31-L42`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/iox_query/src/provider/deduplicate.rs#L31-L42))。

```rust title="core/iox_query/src/provider/deduplicate.rs"
/// This operator takes an input stream of RecordBatches that is
/// already sorted on "sort_key" and applies IOx specific deduplication
/// logic.
/// /* ... */
/// Specifically, the value chosen for each non-sort_key column is the
/// "last" non-null value. This is used to model "upserts" when new
/// rows with the same primary key are inserted a second time to update
/// existing values.
```

ここは RDB と意味論が違う。**「最後の行が勝つ」ではなく「列ごとに、最後の非 NULL 値が勝つ」。**

```
書き込み 1: cpu,host=a usage=0.5
書き込み 2: cpu,host=a temp=42        (同じ time)
クエリ結果: cpu,host=a usage=0.5,temp=42
```

RDB の `UPDATE` は行を丸ごと置き換えるが、こちらは列ごとにマージされる。部分的な更新が自然に表現できる代わりに、「値を NULL に戻す」ことはできない。

## スキーマは書き込みが作る

`CREATE TABLE` を先に発行する必要はない。上の 1 行を投げれば、`cpu` テーブルと 4 つの列 (`host`、`region`、`usage`、`temp`) と `time` がその場で作られる。**DDL が書き込みの副作用として起きる。**

- 型は最初の書き込みで確定する。以後、型の合わない行は **その行だけ** 拒否される ([書き込みバリデータのページ](../write-validator-typestate/))。
- 列は増えるだけ。列の削除も型変更もできない。
- 明示的な `CREATE TABLE` 相当の API もあり、そちらではタグの順序 (= 主キーの順序) を指定できる。

RDB のシステムカタログに当たるのが **カタログ** で、データベース・テーブル・列・トークン・キャッシュ定義・トリガ定義がここに入る。ただし置き場所は `pg_catalog` のようなテーブルではなく、オブジェクトストア上のログとスナップショットだ ([カタログのページ](../catalog-log-checkpoint/))。

**このスキーマ変更が、システム全体で唯一の「複数プロセスが同時に書き換えうる共有状態」** で、そこにだけ楽観的並行制御が入っている ([CAS のページ](../catalog-cas/))。

## ストレージ: B-tree でも LSM でもない

RDB の記憶階層 (ページ、バッファプール、ヒープ、B-tree 索引、WAL) は、ここには 1 つも無い。あるのは 4 つだけだ。

| 実体               | 中身                              | 可変か            |
| ------------------ | --------------------------------- | ----------------- |
| WAL オブジェクト   | 直近 1 秒ぶんの書き込み (bitcode) | 不変              |
| メモリ上のバッファ | Arrow の列ビルダ                  | 可変              |
| Parquet ファイル   | 10 分ぶんの列指向データ           | 不変              |
| カタログ           | スキーマとメタデータ              | ログ追記 + 上書き |

そして **これら全部がオブジェクトストア上のオブジェクト** で、ローカルディスクは前提にしない (`--object-store file` を選べばローカルにも置けるが、それは選択肢の 1 つでしかない)。README が "Diskless architecture with object storage support" と呼んでいるのはこの構造を指す。

LSM ツリーとの比較で言うと、

- **似ている点**: 追記だけで書き、不変ファイルを積み、後でまとめ直す。
- **違う点**: キーの範囲ではなく **時間** でファイルを分ける。ソート順は主キー (tags + time) だが、ファイルの選択は時間だけで決まる。そして **InfluxDB 3 Core にはコンパクションが無い** (後述)。

RDB の各部品がどこへ行ったかを 1 つずつ見ると、

- **バッファプール** → 2 つに分かれた。書き込み側はメモリ上の Arrow バッファ ([メモリバッファ](../table-buffer-arrow/))、読み出し側は [Parquet キャッシュ](../parquet-cache/)。前者は「まだ永続化していないデータ」、後者は「永続化済みデータのキャッシュ」で、役割が完全に別。
- **B-tree 索引** → 存在しない。代わりが 3 つある (後述)。
- **WAL** → 名前は同じだが役割が違う (次節)。
- **システムカタログ** → オブジェクトストア上のログ + スナップショット。
- **オプティマイザ** → Apache DataFusion。

## WAL は RDB の WAL とは違う

同じ名前なので、ここは意識して区別したほうがよい。

|                  | RDB の WAL                                        | InfluxDB 3 の WAL                       |
| ---------------- | ------------------------------------------------- | --------------------------------------- |
| 目的             | クラッシュリカバリ、レプリケーション、MVCC の基盤 | Parquet になるまでの一時的な耐久性      |
| 内容             | ページの物理/論理変更 (redo/undo)                 | 論理的な書き込み行そのもの              |
| 書き方           | ファイルへの追記 + fsync                          | 1 秒ぶんをまとめて 1 オブジェクトを PUT |
| 寿命             | チェックポイントまで                              | スナップショット後に削除                |
| トランザクション | ある (COMMIT レコード)                            | 無い                                    |

`undo` に当たるものが無いのは、ロールバックが無いからだ。書き込みは検証を通った時点で確定し、取り消されない。WAL の役割は **「Parquet に固まるまでの数分間、メモリ上のデータを失わないこと」** だけになる ([WAL のページ](../wal-object-store/))。

## 書き込みの一生

1 回の `POST /api/v3/write_lp` が通る道は、この章の前半 5 ページとちょうど対応している。

1. **パースと検証。** line protocol を 1 行ずつ解析し、新しいテーブル・列があればカタログのトランザクションに積む。型が合わない行はここで弾く → [型状態のページ](../write-validator-typestate/)
2. **カタログのコミット。** スキーマ変更があれば、オブジェクトストアに CAS で書く。他ノードに先を越されたら、1 からやり直す → [CAS のページ](../catalog-cas/)
3. **WAL バッファに積む。** 行を列 ID だけの形に変換して、メモリ上のバッファに入れる → [型付き ID のページ](../typed-ids/)
4. **1 秒後にフラッシュ。** バッファ全体を 1 オブジェクトとして PUT する。成功したら、この 1 秒間に積んだ全リクエストにまとめて 200 を返す → [WAL のページ](../wal-object-store/)
5. **クエリ可能バッファへ。** 同じタイミングで、データが Arrow の列ビルダに入る。ここでクエリから見えるようになる → [メモリバッファ](../table-buffer-arrow/)
6. **スナップショットの判断。** WAL ファイルが貯まったら、どこまでを Parquet にするかを決める → [スナップショットのページ](../snapshot-tracker/)
7. **Parquet 化。** ソートと重複排除をしてから書き出し、永続ファイル一覧に加え、メモリバッファを空にする → [クエリ可能バッファのページ](../queryable-buffer/)
8. **WAL の削除。** 対応する WAL オブジェクトを消す。

**クライアントへの応答は 4 の時点** で返る。つまり「返ってきた = オブジェクトストア上で durable、かつクエリで見える」。RDB の `COMMIT` の返り (WAL の fsync 完了) とほぼ同じ位置づけだが、粒度が 1 秒のバッチになっている。

## クエリの一生

1. **入口は 3 つ。** `/api/v3/query_sql` と `/api/v3/query_influxql` (どちらも GET / POST の両方を受ける)、そして gRPC の Flight SQL。1.x 互換の `/query` もある。
2. **プランを作る。** SQL は `SqlQueryPlanner`、InfluxQL は `InfluxQLQueryPlanner` が受け、**どちらも DataFusion の論理プランに変換される** ([`influxdb3_query_executor/src/query_planner.rs`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_query_executor/src/query_planner.rs))。以降の最適化と実行は 1 本にまとまる。
3. **カタログを DataFusion に見せる。** `Database` が `CatalogProvider` と `SchemaProvider` を実装していて、スキーマは `public` (ユーザーのテーブル) と `system` (システムテーブル) の 2 つ ([`influxdb3_query_executor/src/lib.rs#L668-L714`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_query_executor/src/lib.rs#L668-L714))。
4. **テーブルはチャンクの集合になる。** `QueryTable::scan` が、メモリバッファのチャンクと Parquet ファイルのチャンクを集めて 1 つのプランにする。時間範囲での絞り込み (プルーニング) はこの時点で効く。
5. **重なるチャンクだけ重複排除する。** 時間範囲が重ならないチャンクは、主キーが衝突しえないので `DeduplicateExec` を挟まない ([`core/iox_query/src/provider/overlap.rs`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/iox_query/src/provider/overlap.rs))。
6. **実行は専用のランタイムで。** CPU バウンドな処理は HTTP を捌くランタイムから隔離される → [専用エグゼキュータのページ](../dedicated-executor/)

RDB との対応で言えば、`TableProvider` がテーブルアクセスメソッド、チャンクがセグメント、Parquet の行グループ統計が索引の代わりのゾーンマップ、という配置になる。統計は `ANALYZE` で作るのではなく、**Parquet ファイル自身が持っている**。

## トランザクションと可視性

RDB を前提にすると驚くところなので、明示しておく。

- **ユーザートランザクションは無い。** `BEGIN` / `COMMIT` に相当する API が無い。
- **1 リクエストすら原子的とは限らない。** `accept_partial=true` (既定) なら、不正な行だけを弾いて残りを書く。レスポンスに行番号付きのエラーが並ぶ。
- **MVCC もスナップショット分離も無い。** ただし 1 クエリの中では一貫している。プランを作る時点でチャンクの集合が確定し、実行中に増えた書き込みはそのクエリからは見えない。
- **読み取りロックも書き込みロックも無い。** 同じ主キーへの並行書き込みは、どちらもそのまま保存され、クエリ時に「列ごとに最後の非 NULL 値」で解決される。
- **DDL (カタログ) だけが直列化される。** 連番付きファイルの create-only PUT を CAS として使う ([CAS のページ](../catalog-cas/))。

一方で、**書き込みの耐久性の保証は RDB より明快** だ。`no_sync=true` を付けなければ、200 が返った時点でオブジェクトストア上に存在する。

## 索引の代わりになるもの

二次索引が無いので、絞り込みの手段は 4 つしかない。

1. **パスによる分割。** Parquet のパスが `{node}/dbs/{db_id}/{table_id}/{YYYY-MM-DD}/{HH-MM}/...` になっていて、テーブルと時間帯でファイルを選べる → [パス設計のページ](../persist-paths/)
2. **チャンクと行グループの統計。** 各チャンクが時刻の min/max を持ち、Parquet の行グループも列ごとの統計を持つ。RDB のゾーンマップ (BRIN) に近い。
3. **専用キャッシュ。** 「各 series の最新 N 件」を持つ last cache と、「タグ値の一覧」を持つ distinct cache。マテリアライズドビューに近いが、SQL からはテーブル関数として見える → [テーブル関数のページ](../last-cache-table-function/)
4. **タグ列そのもののスキャン。** `WHERE host = 'a'` は索引探索ではなく、辞書エンコードされた列のスキャンになる。

そして **Core にはコンパクションが無い**。10 分ごとに Parquet ファイルが増え続け、まとめ直されない。この事実は、クエリのファイル数上限という形で表に出る ([`influxdb3_write/src/write_buffer/mod.rs#L607-L622`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/mod.rs#L607-L622))。

```rust title="influxdb3_write/src/write_buffer/mod.rs"
        if parquet_files.len() > self.query_file_limit {
            return Err(DataFusionError::External(
                format!(
                    "Query would scan {} Parquet files, exceeding the file limit. \
                     InfluxDB 3 Core caps file access to prevent performance degradation \
                     and memory issues. Use a narrower time range, or increase the limit \
                     with --query-file-limit (this may cause slower queries or instability).\n\n\
                     To remove this limitation, upgrade to InfluxDB 3 Enterprise, which \
                     automatically compacts files for efficient querying across any time range. \
```

既定値は 432 ([`#L450`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/mod.rs#L450))。gen1 の既定が 10 分なので、1 テーブルあたり 432 × 10 分 = **72 時間ぶん** にちょうど対応する (この対応関係はコードには書かれていないが、数字は一致する)。Core が「直近 3 日ぶんのクエリ」を想定した製品として語られるのは、この上限のことだ。

カタログには `generation_durations` (世代ごとの時間幅) という設定があり、gen1 の上に gen2、gen3 を積む余地は残されている。それを作るのが Enterprise のコンパクションで、Core にはその実装が入っていない。**OSS 版と商用版の境界が、ストレージ階層のどこに引かれているか** が分かる箇所でもある。

## プロセスの構成

```
                   ┌───────────────────────────────────────┐
                   │ influxdb3 serve (単一プロセス)         │
  HTTP :8181 ──────┤                                       │
  gRPC (Flight) ───┤  フロントエンド                        │
                   │   HTTP / Flight SQL ハンドラ           │
                   │      │                                │
                   │  バックエンド                          │
                   │   WriteBuffer ── WAL ── QueryableBuffer│
                   │   Catalog                             │
                   │   QueryExecutor (DataFusion)          │
                   │   Processing Engine (Python)          │
                   │      │                                │
                   │  tokio ランタイム × 2                  │
                   │   (I/O 用 / クエリ用)                  │
                   └──────┼────────────────────────────────┘
                          │
                  ┌───────▼────────┐
                  │ オブジェクトストア │  ← 状態はすべてここ
                  │  {node-id}/wal/ │
                  │  {node-id}/dbs/ │
                  │  {node-id}/...  │
                  └────────────────┘
```

- **単一プロセス・単一ノード。** Core にクラスタリングは無い。分散は Enterprise の領域で、そのための概念 (node、query group) はカタログに入っている。
- **状態はすべてオブジェクトストアにあり、プレフィックスは `--node-id`。** 同じ node-id で 2 つ起動すると壊れるので、[WAL が create-only PUT でそれを検出する](../wal-object-store/)。
- **停止には順序がある。** バックエンドの後始末が終わってからフロントエンドを落とす → [シャットダウンのページ](../ordered-shutdown/)
- **`system` スキーマがある。** `system.queries` (実行中・直近のクエリ)、`system.parquet_files`、`system.tables`、`system.last_caches` など。`pg_stat_activity` や `information_schema` に相当する。
- **Processing Engine。** 組み込みの Python VM で、WAL のフラッシュやスケジュールをきっかけにプラグインを実行できる。トリガとストアドプロシージャの中間のような機能で、この章では扱っていない。

## 用語対応表

| RDB の概念                  | InfluxDB 3 での対応                                      | 注意点                                           |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| テーブル                    | measurement / table                                      | 同じもの。カタログでは table                     |
| 列                          | tag / field / time                                       | tag は文字列限定で主キーの一部                   |
| 主キー                      | series key + time (= sort key)                           | 制約検査は無い。重複はクエリ時に解決             |
| クラスタ化インデックス      | Parquet 内のソート順                                     | 索引構造は無く、並び順だけ                       |
| UPSERT                      | 同じ主キーの再書き込み                                   | 行単位ではなく **列ごとに最後の非 NULL 値**      |
| DDL                         | 書き込みの副作用 (schema-on-write)                       | 明示 API もある。列の削除・型変更は無い          |
| システムカタログ            | カタログ (オブジェクトストア上のログ + スナップショット) | 更新は CAS で直列化                              |
| `information_schema`        | `system` スキーマ                                        | `system.queries`、`system.parquet_files` など    |
| WAL                         | WAL (ただし用途が違う)                                   | redo/undo ではなく「Parquet になるまでの耐久性」 |
| チェックポイント            | スナップショット (データ) / チェックポイント (カタログ)  | 語が 2 つの層で使われる                          |
| バッファプール              | メモリバッファ + Parquet キャッシュ                      | 書き込み側と読み出し側で別物                     |
| ヒープ / セグメント         | Parquet ファイル (gen1 チャンク)                         | 不変。既定 10 分ぶん                             |
| 二次索引                    | 無い                                                     | 時間分割・統計・専用キャッシュで代替             |
| ゾーンマップ / BRIN         | チャンク統計 + Parquet 行グループ統計                    | `ANALYZE` は不要                                 |
| マテリアライズドビュー      | last cache / distinct cache                              | 書き込み時に同期更新。テーブル関数で参照         |
| オプティマイザ              | DataFusion                                               | 論理プラン → 物理プラン。`EXPLAIN` が使える      |
| トランザクション            | 無い                                                     | カタログの DDL にだけ楽観的並行制御がある        |
| MVCC / スナップショット分離 | 無い                                                     | 1 クエリ内はプラン時のチャンク集合で一貫         |
| `DELETE FROM ... WHERE`     | 無い                                                     | 保持期間とテーブル・DB 単位の削除のみ            |
| パーティション              | gen1 チャンク (時間)                                     | パスの階層がそのまま分割の軸                     |
| コンパクション              | Core には無い (Enterprise の機能)                        | ファイル数上限が事実上の時間窓になる             |
| レプリケーション            | 無い (Core)                                              | オブジェクトストアの冗長性に依存                 |
