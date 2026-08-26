---
title: "メタデータを「追記専用の不変ログ + 上書きされる 1 個のスナップショット」で持つと、削除を正しさの前提から外せる"
description: "InfluxDB 3 のカタログは、固定パスのスナップショット 1 個と、連番の付いた不変のログファイル群でできている。読み込みはスナップショットを読み、その連番より後のログを list_with_offset で見つけて順に適用する。チェックポイントはスナップショットを上書きするだけで、古いログは消さない。読み込み側が「スナップショット以前のログを無視する」ので、削除に失敗しても正しさは壊れない。"
sidebar:
  order: 7
---

## 何を学んだか

### どんな状況の話か

カタログ (データベース、テーブル、列、トークン、トリガの定義) は、InfluxDB 3 で唯一「複数のプロセスが同時に書き換えうる共有状態」だ。書き込みが新しい列を作れば、それはカタログの変更になる。しかし置き場所はオブジェクトストアしかない。トランザクションも、行ロックも、`UPDATE ... WHERE version = ?` も無い。

さらに、カタログは **クエリのたびに読む** ものなので、オブジェクトストアに毎回問い合わせるわけにはいかない。全体がメモリに載っていて、変更があったときだけ追いつく形が要る。

### InfluxDB 3 の答え

1. **カタログを 2 種類のオブジェクトで表す。** 固定パスの **スナップショット** 1 個 (`catalog/v3/snapshot`) と、20 桁ゼロ埋めの連番が付いた **ログファイル** (`catalog/v3/logs/{seq:020}.catalog`)。
2. **ログは不変で、書き込みは create-only。** `PutMode::Create` で書き、`AlreadyExists` は「誰かに先を越された」という意味を持つ ([次のページ](../catalog-cas/) で扱う)。
3. **読み込みは「スナップショット + それ以降のログ」。** スナップショットを読んで連番 S を得て、`list_with_offset` でログディレクトリを S のパスから走査する。ゼロ埋め連番なので、辞書順が連番順に一致する。
4. **ログの取得は並行、適用は逐次。** 最大 64 並行で取得し、適用は連番順に 1 つずつ。
5. **チェックポイントはスナップショットの上書きだけ。古いログは消さない。** 読み込み側がスナップショットの連番以下のログを見に行かないので、残っていても無害。回収は別のガベージコレクタの仕事になる。
6. **カタログには UUID があり、適用するログすべてで一致を検査する。** スナップショットとログが別のカタログに由来していたら、混ざった状態を読み込む前に落ちる。
7. **チェックポイントは「ログが 100 個貯まる」か「1 時間経つ」かのどちらかで、バックグラウンドに投げる。** 同時に 1 本だけ走るよう permit で制御し、シリアライズはロックの外で行う。

## ソースコードのどこか

### 2 種類のパス

[`influxdb3_catalog/src/object_store/versions/v3.rs#L569-L586`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/object_store/versions/v3.rs#L569-L586)。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
impl CatalogFilePath {
    pub fn log(catalog_prefix: &str, sequence_number: CatalogSequenceNumber) -> Self {
        let num = sequence_number.get();
        Self(ObjPath::from(format!(
            "{catalog_prefix}/{CATALOG_VERSION_PATH}/logs/{num:020}.{CATALOG_LOG_FILE_EXTENSION}",
        )))
    }

    pub fn snapshot(catalog_prefix: &str) -> Self {
        Self(ObjPath::from(format!(
            "{catalog_prefix}/{CATALOG_VERSION_PATH}/snapshot",
        )))
    }
```

スナップショットのパスに連番が入っていないことに注目したい。**常に同じ 1 個のオブジェクトを上書きする。** 一方ログは連番付きで、一度書いたら二度と変わらない。「変わるもの」と「変わらないもの」がパスの形で分かれている。

パスの先頭にある `catalog/v3` は [フォーマットのバージョン](../catalog-format-versions/) で、v1 と v2 は別のディレクトリに書かれる。

### 読み込み

[`#L142-L256`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/object_store/versions/v3.rs#L142-L256) の `load_catalog`。doc コメントが手順と根拠を全部書いている。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
    /// Reconstruct an [`InnerCatalog`] from the object store: load the
    /// snapshot, then discover and apply every subsequent log file.
    ///
    /// Log discovery uses `list_with_offset` on the logs directory so the
    /// cost scales with the number of log files, not with the range of
    /// sequence numbers. File bodies are fetched in parallel (capped at
    /// [`LOG_FETCH_CONCURRENCY`]) with retries via
    /// [`RetryableObjectStore::get_with_default_retries`]; apply is
    /// sequential because each step mutates `InnerCatalog`.
```

「コストが連番の範囲ではなくファイル数に比例する」が `list_with_offset` を使う理由。連番 1 から順に GET していく実装だと、連番が飛んでいたときに無駄な問い合わせが増える。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
        // Discover logs at sequences > the snapshot's sequence. `list_with_offset`
        // returns entries strictly after the offset path; zero-padded-20-digit
        // filenames make lexicographic order match sequence order.
        let offset = CatalogFilePath::log(&self.prefix, inner.sequence_number()).into();
        let logs_dir = CatalogFilePath::logs_dir(&self.prefix);
```

オフセットに使うのは「実在するパス」ではなく、**その連番のログがあるとしたらこうなる、というパス**。オブジェクトストアの `list_with_offset` はキーの比較で動くので、実在しなくてよい。[パス設計のページ](../persist-paths/) で見たゼロ埋めが、ここで効いている。

取得と適用の分離。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
            .buffered(LOG_FETCH_CONCURRENCY)
            .try_collect()
            .await?;

        for file in fetched {
```

`buffered` は順序を保ったまま並行実行する。並行度の上限にも理由が書かれている ([`#L44-L51`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/object_store/versions/v3.rs#L44-L51))。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
/// Maximum number of in-flight log file fetches during catalog load.
///
/// `load_catalog` may need to replay every log file persisted since the last
/// snapshot. Spawning unbounded concurrency would let a long replay flood
/// the object store; this cap keeps fan-out predictable.
const LOG_FETCH_CONCURRENCY: usize = 64;
```

[WAL のリプレイ](../wal-object-store/) と同じ形 (I/O は並行、適用は逐次、並行度に上限) が、別のチームの別の時期のコードにも現れている。

### アイデンティティの検査

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
            // Every log replayed on top of the snapshot must carry the same
            // catalog identity. A mismatch means snapshot and logs disagree on
            // identity (e.g. a restore that split the uuid); fail loudly here
            // rather than silently loading a mixed catalog.
            let file_uuid = Uuid::from_u128(file.header.catalog_uuid);
            if file_uuid != catalog_uuid {
                return Err(ObjectStoreCatalogError::unexpected(format!(
                    "catalog uuid mismatch at log sequence {} (prefix {}): snapshot is \
                     {catalog_uuid}, log is {file_uuid}",
```

連番だけでは同一性が保証できない。バックアップからのリストアや、同じプレフィックスに別のカタログが作られた場合、連番 42 のログが 2 種類存在しうる。だから **すべてのファイルのヘッダにカタログの UUID を入れ、適用のたびに照合する**。

### チェックポイントは上書きだけ

[`#L368-L400`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/object_store/versions/v3.rs#L368-L400)。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
    /// Overwrite the snapshot file to shorten the log replay chain.
    ///
    /// Old log files are left in place; `load_catalog` ignores logs at
    /// sequences ≤ the snapshot's, so obsolete logs have no effect on
    /// correctness. Storage is reclaimed by a separate garbage collector.
    pub(crate) async fn write_checkpoint(
```

このコメントがページの主題そのものだ。**「消す」が正しさの前提に入っていない。** チェックポイントの仕事は「次回の読み込みで再生するログの本数を減らす」ことだけで、古いログの削除は容量回収という別の関心事になる。ガベージコレクタが動かなくても、遅れても、失敗しても、カタログの内容は変わらない。

チェックポイントの書き込みは `put_with_default_retries` (通常の PUT、上書き可) を使う。ログの `put_if_not_exists` とは対照的で、**上書きしてよいオブジェクトと、してはいけないオブジェクトが API レベルで分かれている**。

### いつチェックポイントするか

[`influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L339-L358`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L339-L358)。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
/// Tuning for background snapshot checkpointing.
///
/// A checkpoint is triggered after each successful log persist whenever
/// EITHER threshold has elapsed since the last successful checkpoint:
/// `log_interval` catalog sequences, or `time_interval` of wall-clock time.
pub(crate) struct CheckpointPolicy {
    pub(crate) log_interval: u64,
    pub(crate) time_interval: Duration,
}

impl Default for CheckpointPolicy {
    fn default() -> Self {
        Self {
            log_interval: 100,
            time_interval: Duration::from_secs(3600),
        }
    }
}
```

ログ 100 本、または 1 時間。「変更が多いときは本数で、少ないときは時間で」という二重の条件で、どちらのワークロードでも再生が長くなりすぎない。

実行のしかたにも配慮がある ([`#L3037-L3090`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L3037-L3090))。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
    fn maybe_background_checkpoint(
        &self,
        persisted_seq: CatalogSequenceNumber,
    ) -> Option<JoinHandle<Result<()>>> {
        let Ok(permit) = Arc::clone(&self.checkpoint_slot).try_acquire_owned() else {
            return None;
        };
```

`try_acquire_owned` で **待たずに諦める**。チェックポイントは常に「やらなくてもよい仕事」なので、既に走っているなら今回は見送る。書き込みパスの中から呼ばれるので、ここでブロックしたら書き込みが詰まる。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
        // Clone the records under the read lock so the (potentially expensive)
        // serialization happens off-lock in the spawned task. `Record` clone
        // is a `Bytes` refcount bump plus a 16-byte header copy.
        let (catalog_uuid, records) = {
            let inner = self.inner.read();
```

ロックの中ではクローンだけして、シリアライズは外でやる。クローンが安い理由 (`Bytes` の参照カウント + 16 バイト) まで書いてあるので、この判断が妥当かを読み手が検証できる。

### 起動時の競合

[`#L262-L300`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/object_store/versions/v3.rs#L262-L300)。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
    /// Load an existing catalog, or initialize a fresh one by writing an
    /// initial snapshot at sequence 0. Two processes racing to initialize
    /// the same prefix at the same time both call [`Self::initialize_snapshot`]
    /// under `PutMode::Create`; the loser reloads whatever the winner wrote.
```

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
        match self.initialize_snapshot(initial_snapshot).await? {
            PersistCatalogResult::Success => Ok(CatalogLoad {
                inner,
                snapshot_needs_rewrite: false,
            }),
            PersistCatalogResult::AlreadyExists => self.load_catalog().await?.ok_or_else(|| {
```

初期化の競合を、ロックでも調停役でもなく **create-only の PUT 1 回** で解いている。負けたほうは自分の作りかけを捨てて、勝ったほうの結果を読み直す。この形が使えるのは、初期スナップショットの内容が (UUID を除いて) 誰が作っても等価だからだ。

## なぜそうなっているか

- **「ログ + スナップショット」は、オブジェクトストアの特性に対する自然な形。** オブジェクトストアが得意なのは「新しいキーに 1 回書く」と「キーを指定して読む」。苦手なのは「既存のオブジェクトの一部を変える」。カタログの全体を毎回書き直せば単純だが、変更のたびに全体を PUT するのは重い。差分をログに書き、たまに全体を書き直す形なら、書き込みは常に小さく、読み込みは「1 + N 本」で済む。
- **削除を正しさから外したのは、削除が最も失敗しやすい操作だから。** 分散環境では「消したつもりが消えていない」「消したのに参照が残っている」が起きる。読み込み側に「スナップショット以前は無視する」という規則を入れておけば、**削除が遅れても、失敗しても、二重に走っても** 結果が変わらない。同じ考え方が [Parquet ファイルの削除](../queryable-buffer/) にもある。
- **UUID の照合は、リストア機能が入って必要になった。** コメントが挙げる "a restore that split the uuid" が具体例で、バックアップから復元すると同じプレフィックスに異なる系譜のファイルが混ざりうる。連番は「順序」しか表さないので、「同じ系譜か」は別の識別子で持つしかない。
- **チェックポイントを書き込みパスから `try_acquire` で起動するのは、専用のバックグラウンドループを持たないため。** タイマータスクを 1 本増やせば「いつ止めるか」「シャットダウンとどう協調するか」が増える。書き込みのついでに条件を見て、空いていたら投げる形なら、書き込みが止まればチェックポイントも自然に止まる。
- **正直な TODO が残っている。** `commit_transaction` の中に、ログの永続化に成功したあとメモリへの適用に失敗した場合の指摘がある。"a failure here leaves the catalog wedged — the log file is durable at `next_seq`, in-memory state is not, and every subsequent write hits AlreadyExists then re-fails the same apply during catch-up. Should poison/halt the catalog rather than surface as a per-call Internal error." **「永続化とメモリ反映の間」は、この設計で最も危ない隙間** で、そこに issue 番号付きで印が付いている。

## どう活かすか

- 共有ストレージの上で状態を共有するなら、まず **「不変な差分の列 + たまに畳んだ全体像」** の形を検討する。追記だけで済み、読み込みは 1 + N 回、書き込みは常に小さい。
- 「変わらないもの」と「変わるもの」を **パスの形で分ける**。連番付きのキーは不変、固定キーは可変。API も分ける (create-only の PUT と通常の PUT) と、間違った上書きが型と関数名の段階で防げる。
- 畳み込み (チェックポイント、コンパクション) を作るときは、**読み込み側に「畳み込み済みの部分を無視する」規則** を入れる。これで古いデータの削除が「やらなくてもよい仕事」になり、GC の失敗が正しさの問題でなくなる。
- 連番だけを識別子にしない。**系譜を表す UUID をすべてのファイルに入れて、読み込みのたびに照合する**。リストア、コピー、プレフィックスの再利用が起きた瞬間に、連番だけでは足りなくなる。
- 「やらなくてもよい仕事」は `try_acquire` で起動して、取れなければ諦める。処理の本流から呼ぶ背景処理をブロックさせない。
- ロックの中では **参照カウントの増加だけ** をして、重い処理は外に出す。その判断が妥当な理由 (クローンが安いこと) をコメントに書いておくと、後から見直せる。
- 初期化の競合は、専用の調停役を持ち込む前に **「create-only の書き込み 1 回 + 負けたら読み直す」** で解けないか考える。結果が誰が作っても等価なら、これで足りる。
