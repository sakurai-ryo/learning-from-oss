---
title: "pluggable storage engine — Server と InnoDB の分割線"
description: "MySQL は SQL を解釈する層と行を格納する層が別々に作られ、`handler` という契約でつながっている。この境界は 1990 年代末に MyISAM しか持っていなかった製品へ InnoDB を外から差し込むために引かれたもので、行を「固定長のバイト列」として渡すという当時の選択が今も残っている。境界があるおかげで何ができ、代償として何が後付けになったのかを、`legacy_db_type` に並ぶ消えたエンジンの名前から読む。"
group: "前提 — データベースの基礎"
sidebar:
  order: 7
---

## 何を学んだか

MySQL は 1 つのプログラムに見えるが、**2 つの層が契約でつながった構造**をしている。

- **Server 層** — 接続、パケット、パーサ、オプティマイザ、エグゼキュータ、binlog、メタデータロック
- **ストレージエンジン層** — 行をディスクに置き、取り出し、トランザクションとロックを面倒みる

契約は 2 本の型でできている。

|                     | 単位                          | 中身                                                       |
| ------------------- | ----------------------------- | ---------------------------------------------------------- |
| `class handler`     | **テーブル 1 個 × 接続 1 本** | 開く、走査する、1 行読む、1 行書く                         |
| `struct handlerton` | **エンジン全体**              | コミット、ロールバック、XA、リカバリ、テーブルスペース操作 |

境界の引き方でいちばん効いているのは、**行を「固定長のバイト列」で渡す**と決めたことだ。SQL 層は行を `TABLE::record[0]` という `reclength` バイトのバッファで受け取る。エンジンはそこにバイトを詰める。型付きのオブジェクトも、列ごとのアクセサも渡さない。

この 1 つの決断から、この章の他のページで出てくる話がまとめて出てくる。

1. **行のバイト列を毎回詰め替えることになった。** MySQL の行は固定長・リトルエンディアン、InnoDB のレコードは可変長・ビッグエンディアン。1 行読むたび・書くたびに変換が走る ([行フォーマット変換](./row-format-conversion/))
2. **述語をエンジンに降ろす API が後付けで並んだ。** 最初の契約は「1 行ずつ返せ」だけだった。フィルタをエンジン側で評価させたい、複数のキーをまとめて渡したい、といった最適化は全部あとから穴を開けている。`cond_push` / `idx_cond_push` / `multi_range_read_init` / `push_to_engines` はどれもそういう穴だ
3. **エンジンの能力を申告するビットマスクが要る。** オプティマイザは「このエンジンは降順スキャンできるか」「ICP を受け取れるか」を実行前に知る必要がある。`table_flags()` と `index_flags()` が返す `HA_*` フラグがそれで、**オプティマイザの分岐がエンジンの申告に依存している**
4. **トランザクションが 2 層になった。** binlog は Server 層、redo は InnoDB。両者を揃えるには 2 相コミットが要る ([2PC とグループコミット](./two-phase-commit-and-group-commit/))

そして 8.4 の現実として、**実質 InnoDB 一択**になっている。データディクショナリ自体が InnoDB のテーブル (`mysql.ibd`) に格納されていて、InnoDB なしでは起動すらしない ([データディクショナリ](./data-dictionary/))。それでも境界は消えていない。

## ソースコードのどこか

### 消えたエンジンの墓場

```cpp title="sql/handler.h"
enum legacy_db_type {
  DB_TYPE_UNKNOWN = 0,
  DB_TYPE_DIAB_ISAM = 1,
  DB_TYPE_HASH,
  DB_TYPE_MISAM,
  DB_TYPE_PISAM,
  DB_TYPE_RMS_ISAM,
  DB_TYPE_HEAP,
  DB_TYPE_ISAM,
  DB_TYPE_MRG_ISAM,
  DB_TYPE_MYISAM,
  DB_TYPE_MRG_MYISAM,
  DB_TYPE_BERKELEY_DB,
  DB_TYPE_INNODB,
  DB_TYPE_GEMINI,
  DB_TYPE_NDBCLUSTER,
  ...
  DB_TYPE_SOLID,
  DB_TYPE_PBXT,
  DB_TYPE_TABLE_FUNCTION,
  DB_TYPE_MEMCACHE [[deprecated]],
  DB_TYPE_FALCON,
  DB_TYPE_MARIA,
  /** Performance schema engine. */
  DB_TYPE_PERFORMANCE_SCHEMA,
  DB_TYPE_TEMPTABLE,
  DB_TYPE_FIRST_DYNAMIC = 42,
  DB_TYPE_DEFAULT = 127  // Must be last
};
```

[`sql/handler.h#L648`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/handler.h#L648)。**この enum が pluggable storage engine の歴史そのものだ。** ISAM 系が 5 つ、Berkeley DB、Gemini、Solid、PBXT、Falcon、Maria。どれも「MySQL にトランザクションと行ロックを持ち込む」ために作られ、そして残らなかった。

番号を配るのは既にやめていて、`DB_TYPE_FIRST_DYNAMIC = 42` 以降は動的割り当てになる。後述の `handlerton::db_type` フィールドのコメントも「This is going away and new engines will just use "name" for this」と言っている。それでも古い番号は消せない。`.frm` の時代にこの番号がファイルに書かれていたからだ。

`DB_TYPE_TEMPTABLE` と `DB_TYPE_PERFORMANCE_SCHEMA` が並んでいるのも見どころで、**内部一時表と `performance_schema` も同じ契約に乗っている** ([内部一時表](./materialization-and-temptable/)、[performance_schema](./performance-schema-internals/))。

### `handlerton` は関数ポインタの束

```cpp title="sql/handler.h"
struct handlerton {
  ...
  enum legacy_db_type db_type;
  ...
  uint slot;
  ...
  /* handlerton methods */

  close_connection_t close_connection;
  kill_connection_t kill_connection;
  ...
  commit_t commit;
  rollback_t rollback;
  prepare_t prepare;
  recover_t recover;
  ...
  create_t create;
```

[`sql/handler.h#L2734`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/handler.h#L2734)。仮想関数のクラスではなく**関数ポインタの構造体**なのは、エンジンが C の共有ライブラリとして動的にロードされる前提だったからだ。

`slot` フィールドがその名残をよく表している。「エンジンごとに `THD` の中の専用領域を 1 つ持てる。番号は MySQL が起動時に割り当てる」。エンジンは自分の状態を `thd->ha_data[ht->slot]` に置く。C の世界の作法がそのまま残っている。

InnoDB 側でこれを埋めるのが `innodb_init` だ。

```cpp title="storage/innobase/handler/ha_innodb.cc"
static int innodb_init(void *p) {
  ...
  innobase_hton->state = SHOW_OPTION_YES;
  innobase_hton->db_type = DB_TYPE_INNODB;
  innobase_hton->savepoint_offset = sizeof(trx_named_savept_t);
  innobase_hton->close_connection = innobase_close_connection;
  ...
  innobase_hton->commit = innobase_commit;
  innobase_hton->rollback = innobase_rollback;
  innobase_hton->prepare = innobase_xa_prepare;
```

[`ha_innodb.cc#L5418`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L5418)。`innobase_hton->` への代入が 60 本以上続く。**エンジンの「実装した」は、この構造体のどのフィールドを埋めたかで表現される。**

### InnoDB は今でもプラグインとして宣言されている

```cpp title="storage/innobase/handler/ha_innodb.cc"
mysql_declare_plugin(innobase){
    MYSQL_STORAGE_ENGINE_PLUGIN,
    &innobase_storage_engine,
    innobase_hton_name,
    PLUGIN_AUTHOR_ORACLE,
    "Supports transactions, row-level locking, and foreign keys",
    PLUGIN_LICENSE_GPL,
    innodb_init,   /* Plugin Init */
    nullptr,       /* Plugin Check uninstall */
    innodb_deinit, /* Plugin Deinit */
```

[`ha_innodb.cc#L23664`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L23664)。**同じサーバに静的リンクされていても、InnoDB は形式上プラグインのままだ。** 続けて `i_s_innodb_trx` 以下 26 個の `INFORMATION_SCHEMA` プラグインが同じ宣言に並んでいて、`INNODB_TRX` や `INNODB_METRICS` がエンジンの付属品として提供されていることが分かる。

### 能力の申告

InnoDB が「自分にできること」として立てるビットは、コンストラクタの初期化子リストに書かれている。

```cpp title="storage/innobase/handler/ha_innodb.cc"
      m_int_table_flags(
          HA_NULL_IN_KEY | HA_CAN_INDEX_BLOBS | HA_CAN_SQL_HANDLER |
          HA_PRIMARY_KEY_REQUIRED_FOR_POSITION | HA_PRIMARY_KEY_IN_READ_INDEX |
          HA_BINLOG_ROW_CAPABLE | HA_CAN_GEOMETRY | HA_PARTIAL_COLUMN_READ |
          HA_TABLE_SCAN_ON_INDEX | HA_CAN_FULLTEXT | HA_CAN_FULLTEXT_EXT |
          ...
          HA_DESCENDING_INDEX | HA_MULTI_VALUED_KEY_SUPPORT |
          HA_BLOB_PARTIAL_UPDATE | HA_SUPPORTS_GEOGRAPHIC_GEOMETRY_COLUMN |
          HA_SUPPORTS_DEFAULT_EXPRESSION),
```

[`ha_innodb.cc#L2949`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L2949)。この 1 つ 1 つがオプティマイザのどこかの分岐に対応している。たとえば `HA_PRIMARY_KEY_IN_READ_INDEX` は「セカンダリインデックスを引くと PK がおまけで付いてくる」という申告で、これが立っているから[インデックス拡張](./secondary-index/)が成立する。`HA_TABLE_SCAN_ON_INDEX` は「全表スキャンは実はインデックス走査だ」という申告だ。

インデックス単位の申告は別にある。

```cpp title="storage/innobase/handler/ha_innodb.cc"
ulong ha_innobase::index_flags(uint key, uint, bool) const {
  if (table_share->key_info[key].algorithm == HA_KEY_ALG_FULLTEXT) {
    return (0);
  }

  ulong flags = HA_READ_NEXT | HA_READ_PREV | HA_READ_ORDER | HA_READ_RANGE |
                HA_KEYREAD_ONLY | HA_DO_INDEX_COND_PUSHDOWN;
```

[`ha_innodb.cc#L6614`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L6614)。`HA_READ_ORDER` が「このインデックスは順序を持つ」、`HA_KEYREAD_ONLY` が「カバリングインデックスとして使える」、`HA_DO_INDEX_COND_PUSHDOWN` が「ICP を受け取れる」だ。

**全文検索インデックスはここで `0` を返す。** 順序も範囲もカバリングも ICP もできないと申告するので、オプティマイザはそのインデックスをこれらの用途で選ばなくなる。空間インデックスに対しては `HA_READ_PREV` と `HA_DO_INDEX_COND_PUSHDOWN` を落とす。**「その最適化がこのインデックスで効くか」は、最終的にこの関数が何を返すかで決まる。**

### エンジンにない機能は既定実装が拒否する

```cpp title="sql/handler.h"
#define HA_NO_TRANSACTIONS (1 << 0)     /* Doesn't support transactions */
#define HA_PARTIAL_COLUMN_READ (1 << 1) /* read may not return all columns */
```

[`sql/handler.h#L218`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/handler.h#L218)。1 番目のフラグが「トランザクションがない」であることが、この契約が何のために引かれたかを示している。**トランザクションはエンジンの任意機能**として設計された。

同じ思想が `class handler` の既定実装にも現れていて、`write_row` / `update_row` / `delete_row` もインデックス走査も pure virtual ではなく、既定実装が `HA_ERR_WRONG_COMMAND` を返す。読み取り専用の最小エンジンが成立するようになっている ([handler の walkthrough](./handler-walkthrough/))。

## なぜそうなっているか

### なぜ 2 層に分かれたのか

MySQL AB が最初に持っていたストレージエンジンは ISAM とその後継の MyISAM で、**トランザクションも行ロックもクラッシュリカバリもなかった**。1990 年代末、それを必要とする用途が増えたとき、選べる道は 2 つあった。MyISAM を作り直すか、既にそれを持っている実装を外から持ってくるか。

MySQL AB が選んだのは後者で、Berkeley DB (Sleepycat) と InnoDB (Innobase Oy) を差し込めるようにした。**別会社が別のリポジトリで開発しているコードを繋ぐ**ための境界だったから、契約は最小限かつ C で表現できる形になった。`handlerton` が仮想関数ではなく関数ポインタの構造体なのも、`slot` という「エンジン専用の 1 ワード」があるのも、そのためだ。

境界を「テーブルを開いて、走査して、1 行ずつ読み書きする」に置いたのは、当時の MyISAM の API がそうだったからでもある。**既存の実装に合う切れ目**を選ぶのが、いちばん改造量が少ない。

### なぜ「バイト列」で行を渡すのか

型付きの行オブジェクトを毎行作れば、アロケーションと解放が行数ぶん走る。固定長バッファに `memcpy` する形なら、バッファは 1 個を使い回せる。**1990 年代のハードウェアで 1 行あたりのオーバーヘッドを最小にする**という要求に対しては、これが正解だった。

SQL 層の側もこの形に依存している。`Item_field::val_int()` は `field->ptr` を読むだけで、`ptr` は `record[0] + 固定オフセット` だ。オプティマイザもエグゼキュータも `Field` 越しに値を触るので、**固定長・固定オフセットであることが SQL 層全体の前提**になっている。

代金は 2 つある。1 つは変換コスト ([行フォーマット変換](./row-format-conversion/))。もう 1 つは、`VARCHAR(1000)` を宣言すると中身が短くても `record[0]` が 1000 バイト太ることだ。これが内部一時表の見積もりに効いて、`tmp_table_size` に早く当たる ([内部一時表](./materialization-and-temptable/))。

### なぜ述語を降ろす API が後付けなのか

最初の契約には「フィルタ」という概念がなかった。エンジンは行を返し、条件の評価は SQL 層がやる。単純で、エンジン側の実装が軽い。

だがこれは「エンジンが 1000 行返して SQL 層が 999 行捨てる」という無駄を生む。捨てる行の分だけ**行フォーマット変換とページの往復**が発生する。そこで、条件をエンジンに渡して手前で捨てさせる仕組みが順に足された。

- `cond_push` — WHERE 条件そのものをエンジンに渡す
- `idx_cond_push` (ICP) — インデックスのレコードだけで評価できる条件を渡し、クラスタードインデックスを引く前に捨てさせる
- `multi_range_read_init` (MRR) — 複数の範囲をまとめて渡し、エンジン側で並べ替えてから読ませる
- `push_to_engines` — 実行計画の一部ごとエンジンに渡す (NDB 向け)

**どれも「最初の契約が粗すぎたので穴を開けた」という形をしていて、しかも互いに直交していない。** ICP はクラスタードインデックスには押し込まないし、MRR は既定ではほとんど選ばれない。境界が後から曲げられた結果の複雑さがここに出ている ([アクセスパスの選択](./access-path-selection/))。

### なぜ今も残っているのか

InnoDB 一択になったのだから境界を消してもよさそうに見えるが、実際には消せない。

- **NDB Cluster と外部エンジンが同じ契約に乗っている。** MyRocks のようなサードパーティのエンジンは、この境界の上に成立している
- **パーティショニングが `handler` の入れ子で実装されている。** `ha_innopart` は `handler` を継承しつつ、内部でパーティションごとの処理に振り分ける ([パーティショニング](./partitioning/))
- **内部一時表が別エンジンだ。** TempTable はメモリ上の一時表エンジンで、溢れたら InnoDB の一時テーブルスペースに切り替わる。この切り替えは「エンジンを差し替える」操作として書かれている
- **binlog が `handlerton` の 1 つとして参加している。** 2 相コミットの調停で、binlog はもう 1 つのトランザクション参加者として扱われる ([トランザクションの調停](./transaction-coordination/))

境界は「複数のストレージエンジンを差し替えるため」に引かれたが、**今それを支えているのは差し替えではなく、この 4 つの副次的な用途**のほうだ。

## どう活かすか

### 「MySQL のこの挙動」がどちらの層の話かを先に決める

この章の索引としていちばん使える切り分けがこれだ。

| 現象                                | どちらの層か                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| インデックスが使われない            | Server 層 (オプティマイザ) — ただし統計は `handler::info()` 経由でエンジンから来る |
| `ALTER` が固まる                    | Server 層 (MDL)                                                                    |
| デッドロック / ロック待ち           | エンジン層 (InnoDB の行ロック)                                                     |
| `Using filesort` / 一時表が作られる | Server 層 (エグゼキュータ)                                                         |
| `Row size too large`                | エンジン層 (InnoDB のページ構造)                                                   |
| binlog にイベントが載る / 載らない  | Server 層 (`handler` の wrapper)                                                   |
| レプリカが遅れる                    | Server 層                                                                          |

**取り違えると探す場所が変わる。** ロック待ちだと思って `EXPLAIN` を眺めても何も出ないし、その逆も同じだ。

### `Storage engine ... doesn't have this option` の意味

クライアントに見える `ER_ILLEGAL_HA` は、エンジンがそのメソッドを実装しておらず既定実装の `HA_ERR_WRONG_COMMAND` がそのまま返った、という意味でしかない。**「機能がない」と「実装漏れ」の区別はメッセージから付かない。**

### ICP や MRR が効くかどうかは `index_flags` の申告次第

`Extra: Using index condition` が出ないとき、原因はオプティマイザの判断だけとは限らない。全文検索インデックスや空間インデックスでは `index_flags` が `HA_DO_INDEX_COND_PUSHDOWN` を返さないので、そもそも候補にならない。**クラスタードインデックスには ICP を押し込まない**という InnoDB 側の判断もあり、PK 検索で `Using index condition` が出ないのはそのためだ ([アクセスパスの選択](./access-path-selection/))。

### この続き

- 契約の具体的なメソッド群と、1 回のスキャンで呼ばれる順序は[handler — SQL 層が InnoDB を呼ぶ唯一の口](./handler-walkthrough/)
- バイト列の詰め替えの中身は[行フォーマット変換 — MySQL の行と InnoDB の行は別物](./row-format-conversion/)
- `handlerton` のコミット系関数がどう呼ばれるかは[トランザクションの調停 — trans_begin から ha_commit_trans](./transaction-coordination/)
- Server 層と InnoDB のトランザクションを揃える仕組みは[2PC とグループコミット](./two-phase-commit-and-group-commit/)
- 後付けの API がオプティマイザからどう使われるかは[アクセスパスの選択 — ref / range / scan、ICP と MRR](./access-path-selection/)
- `handler` を入れ子にした実装例は[パーティショニング — pruning と InnoDB 側の分割](./partitioning/)
- テーブル定義がどこに格納されているかは[データディクショナリ — mysql.ibd とトランザクショナル DD](./data-dictionary/)
