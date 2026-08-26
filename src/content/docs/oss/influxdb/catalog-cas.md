---
title: "コーディネータを置かずに、連番付きの create-only PUT だけでメタデータの一貫性を保つ"
description: "InfluxDB 3 のカタログ更新は「開始時の連番を覚える → 変更をためる → 次の連番のファイルを create-only で書く」。AlreadyExists は他ノードが先に書いた証拠なので、そこまで追いつき直して呼び出し側に Retry を返す。結果は Result ではなく Prompt<Success, Retry> という専用の型で返るので、呼び出し側はやり直しの可能性を無視できない。やり直すのは commit だけでなく、ドメインロジックごと。"
sidebar:
  order: 8
---

## 何を学んだか

### どんな状況の話か

`cpu,host=a usage=0.5` という 1 行が書かれたとき、`cpu` テーブルも `host` タグも `usage` フィールドも存在しなければ、カタログに 3 つの定義が増える。これはユーザーが明示的に発行する DDL ではなく、**書き込みの副作用として起きるスキーマ変更** だ。しかも同じ瞬間に、別のノードが `cpu,host=b temp=41` を受けているかもしれない。

[前のページ](../catalog-log-checkpoint/) で見たように、カタログの実体はオブジェクトストア上のログファイル列だ。分散ロックも、トランザクションマネージャも、単一の書き込みリーダーも無い。それでも「テーブル ID の重複」や「片方の変更が消える」は起こしてはいけない。

### InfluxDB 3 の答え

1. **楽観的並行制御に一本化する。** 開始時のカタログ連番を覚え、変更をメモリ上のレコード列にためて、コミット時に **次の連番のログファイル** を書く。
2. **オブジェクトストアの create-only PUT を CAS として使う。** 「連番 N+1 のファイルが存在しないなら書く」が成功したら、自分が N+1 の唯一の書き手になれた、という意味になる。`AlreadyExists` は他ノードが先を越したという証拠。
3. **負けたら追いつく。** `catch_up_from(N+1)` で存在するログを順に読んで適用し、自分のメモリ上のカタログを最新にする。
4. **やり直しは呼び出し側に返す。** 戻り値は `Result<Prompt<CatalogSequenceNumber>>`。`Prompt::Retry` を受けた呼び出し側は、**ドメインロジックごと最初からやり直す**。コミットだけを再送してはいけない。
5. **プロセス内の直列化は `Mutex<CatalogSequenceNumber>` 1 個で行う。** ロックの中身が「次に書くべき連番」そのものになっていて、ロックの取得と期待値の検査が同じ場所にある。
6. **チェックは 2 段。** ロックを取った時点で「開始時の連番 == 現在の連番」を見て、違えばオブジェクトストアに行く前に Retry を返す。同一プロセス内の競合は、ネットワークを使わずに解決する。

## ソースコードのどこか

### 「やり直すかもしれない」を型で表す

[`influxdb3_catalog/src/catalog/versions/v3/transaction.rs#L60-L71`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/transaction.rs#L60-L71)。

```rust title="influxdb3_catalog/src/catalog/versions/v3/transaction.rs"
/// Outcome of a transaction commit under optimistic concurrency.
///
/// Generic over `Success` and `Retry` payloads to mirror v2 — most callers
/// use the default `Prompt<CatalogSequenceNumber, ()>` returned by
/// [`Catalog::commit`][super::catalog::Catalog::commit], but write-buffer
/// validators thread their own state through both variants.
#[derive(Debug, Clone, Copy)]
pub enum Prompt<Success = (), Retry = ()> {
    Success(Success),
    Retry(Retry),
}
```

`Result<T, E>` にしなかったのが要点だ。「やり直し」はエラーではない。`?` で上に投げてしまえる形にすると、呼び出し側は **やり直しをエラーとして扱ってユーザーに返してしまう**。`Prompt` は別の型なので、`match` で両方の枝を書かないとコンパイルが通らない。

`Retry` 側にも型引数があるのは、やり直しのときに引き継ぎたい状態があるから。[書き込みバリデータ](../write-validator-typestate/) は、解析済みの行データを `Retry` に載せて返し、パースからやり直さずに済ませている。

### トランザクションは開始時の連番を持つ

[`influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L2884-L2890`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L2884-L2890)。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
    pub fn begin_transaction(&self) -> CatalogTransaction {
        let sequence_at_begin = self.sequence_number();
        CatalogTransaction {
            sequence_at_begin,
            records: RecordBatch::new(sequence_at_begin.next().get()),
        }
    }
```

```rust title="influxdb3_catalog/src/catalog/versions/v3/transaction.rs"
pub struct CatalogTransaction {
    pub(super) sequence_at_begin: CatalogSequenceNumber,
    pub(super) records: RecordBatch,
}
```

持っているのは「開始時点の連番」と「積んだレコード」だけ。ロックも、オブジェクトストアへの接続も、書き込み中のファイルも持たない。だから **トランザクションを作って捨てるコストがほぼゼロ** で、やり直しが安い。

`begin_database_transaction` はここに「データベースのスキーマのスナップショット」と各種の上限値を足す ([`#L2904-L2945`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L2904-L2945))。ドキュメントが「これは開始時のスナップショットで、未コミットの変更は見えない」と明示している。

```rust title="influxdb3_catalog/src/catalog/versions/v3/transaction.rs"
    /// Snapshot of the database schema captured at begin time. Does not
    /// reflect uncommitted `table_or_create` / `column_or_create` mutations;
    /// observe new state via a fresh transaction after commit.
    pub fn db_schema(&self) -> &Arc<DatabaseSchema> {
```

### コミット

[`#L2960-L3031`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L2960-L3031)。この 70 行に並行制御の全部が入っている。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
        let mut permit = self.write_permit.lock().await;

        if *permit != sequence_at_begin {
            return Ok(Prompt::Retry(()));
        }

        let next_seq = permit.next();
```

`write_permit` の型は `Mutex<CatalogSequenceNumber>` ([`#L398`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L398))。**ロックが守っている値そのものが「最後に書いた連番」** になっている。ロックを取る = 書き込み権を得る、で、その場で「自分が見ていた世界はまだ最新か」を検査できる。別々の変数にしていたら、ロックと検査の間に隙間ができる。

ここで弾かれるのは、**同じプロセス内で別のリクエストが先にコミットした** 場合。オブジェクトストアに行く前に分かるので、往復のコストがかからない。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
        let bytes = serialize_log_file(self.catalog_uuid, next_seq.get(), records.as_slice());

        match self.store.persist_log(next_seq, bytes).await? {
            PersistCatalogResult::Success => {
```

`persist_log` の中身は create-only の PUT ([`influxdb3_catalog/src/object_store/versions/v3.rs#L538-L563`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/object_store/versions/v3.rs#L538-L563))。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
            .put_opts(
                path,
                content.into(),
                PutOptions {
                    mode: object_store::PutMode::Create,
                    ..Default::default()
                },
            )
            .await
        {
            Ok(_) => Ok(PersistCatalogResult::Success),
            Err(object_store::Error::AlreadyExists { .. }) => {
                Ok(PersistCatalogResult::AlreadyExists)
            }
```

`AlreadyExists` をエラーではなく **結果の一種** (`PersistCatalogResult`) に変換しているのが上手い。呼び出し側は `match` で両方を扱う。

負けたときの処理。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
            PersistCatalogResult::AlreadyExists => {
                self.catch_up_from(next_seq).await?;
                *permit = self.sequence_number();
                Ok(Prompt::Retry(()))
            }
```

追いつき (`catch_up_from`) は、次の連番から順にログを読んで、無くなるまで適用する。**「無い」が終端の合図** になる。その後 permit を最新に更新して Retry を返す。次にこのトランザクションをやり直す誰かは、新しい世界を見た状態で始められる。

勝ったときの副作用は 4 つ。メモリへの適用、permit の更新、購読者へのイベント配信、そして [チェックポイントの起動判定](../catalog-log-checkpoint/)。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
                *permit = next_seq;
                self.broadcast(events, "broadcast during transaction commit")
                    .await?;
                self.maybe_background_checkpoint(next_seq);
                Ok(Prompt::Success(next_seq))
```

### 呼び出し側はループを書く

[`#L2077-L2107`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/catalog.rs#L2077-L2107) の `create_table`。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
        loop {
            let mut txn = self.begin_database_transaction(db_name)?;
            let db_id = txn.db_schema().id;
            let table_id = txn.create_table_with_opts(table_name, options)?;
            let tbl_txn = txn.table_tx_or_create(table_name)?;
            for tag in tags.iter().map(AsRef::as_ref) {
                tbl_txn.tag_or_create(tag)?;
            }
            /* ... */
            match self.commit(txn).await? {
                Prompt::Success(_) => { /* ... */ }
                Prompt::Retry(_) => continue,
            }
        }
```

ループの中に `begin` が入っているのが重要だ。`commit` だけを再試行するのでは駄目で、**トランザクションの構築からやり直す**。理由はコミットの doc コメントにある。

```rust title="influxdb3_catalog/src/catalog/versions/v3/catalog.rs"
    /// Returns `Prompt::Retry` when the catalog advanced between
    /// `begin_database_transaction()` and `commit()`, or when another
    /// writer raced us to the next sequence. The caller must re-run
    /// their domain logic against the refreshed catalog.
```

`create_table_with_opts` は「テーブルがまだ無い」ことを前提に新しい ID を採番している。他ノードが先に同名のテーブルを作っていたら、その前提は崩れている。溜めたレコードをそのまま次の連番に書けば、**同じ名前のテーブルが 2 つ、違う ID で存在する** ことになる。transaction.rs のモジュールコメントもここを強調している。

```rust title="influxdb3_catalog/src/catalog/versions/v3/transaction.rs"
//! Callers `begin()` a transaction, push records into it, then `commit()`. On
//! `Prompt::Retry`, the caller rebuilds the transaction against the refreshed
//! catalog state — records accumulated in a transaction may no longer be
//! valid after another writer has advanced the catalog.
```

書き込みパスも同じ形になっている ([`influxdb3_write/src/write_buffer/mod.rs#L518-L535`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/mod.rs#L518-L535))。

```rust title="influxdb3_write/src/write_buffer/mod.rs"
        // NOTE(trevor/catalog-refactor): should there be some retry limit or timeout?
        loop {
            /* ... */
            let result = match WriteValidator::initialize(db_name.clone(), self.catalog())?
                .v1_parse_lines_and_catalog_updates(lp, accept_partial, ingest_time, precision)?
                .commit_catalog_changes()
                .await?
            {
                Prompt::Success(r) => r.convert_lines_to_buffer(self.wal_config.gen1_duration),
                Prompt::Retry(_) => {
                    debug!("retrying write_lp after attempted commit");
                    continue;
                }
            };
```

こちらは line protocol のパースからやり直す。冒頭の `NOTE` が「リトライ回数や timeout は要らないのか」と自問していて、**まだ決めていない** ことが分かる。

## なぜそうなっているか

- **オブジェクトストアの `PutMode::Create` は、条件付き書き込みの中で最も広くサポートされている形。** S3 は 2024 年に条件付き PUT (`If-None-Match: *`) をサポートし、GCS と Azure には以前からある。`If-Match` によるバージョン指定の上書きはサポート状況がばらつく。**「新しいキーに 1 回だけ書ける」だけを前提にすると、可搬性が高くなる。** カタログを連番付きの追記ログにしてあるから、この最小の保証で CAS が成り立つ。
- **`Prompt` という型を作ったのは、`Result` の `?` が危険だから。** やり直しをエラーにすると、`?` で伝播した先でユーザー向けのエラーになる。`Ok(None)` にすると意味が伝わらない。専用の enum なら、名前が意図を説明し、`match` が網羅性を強制する。**「失敗ではないが、成功でもない」を第 3 の型で表す** 判断。
- **2 段階の検査は、プロセス内の競合を安く弾くため。** 同じプロセスで数千の書き込みを同時に受けるとき、それらは全員が同じ連番から始まる。全員がオブジェクトストアに PUT を投げれば、1 個成功して残りが `AlreadyExists` で返ってくる。ロックの中の比較 1 回で弾けば、ネットワークに出るのは 1 リクエストだけになる。
- **`AlreadyExists` を結果型に変換しているのは、それが正常系だから。** エラー型に混ぜると、上位でのエラーハンドリングが「このエラーだけは特別扱い」になる。`PersistCatalogResult::{Success, AlreadyExists}` なら、どちらも起きて当然の結果として扱える。
- **ログを書いた後にメモリへの適用が失敗する隙間は、未解決として残っている。** `commit_transaction` の TODO が正確に書いている。"a failure here leaves the catalog wedged — the log file is durable at `next_seq`, in-memory state is not, and every subsequent write hits AlreadyExists then re-fails the same apply during catch-up." 楽観的並行制御は「永続化 = 確定」を前提にするが、確定した後の反映に失敗する経路が残っている。**カタログを毒状態にして落とすべき** という方針まで書いてあるので、判断は済んでいて実装が残っている状態。

## どう活かすか

- 共有ストレージ上での更新の一貫性は、**「連番付きの新しいキーに create-only で書く」** で作れる。既存キーの条件付き上書きより広くサポートされていて、履歴も残る。
- 楽観的並行制御の結果は `Result` に混ぜず、**専用の型 (`Prompt::{Success, Retry}`)** で返す。呼び出し側が `?` でやり過ごせない形にすることで、リトライの実装忘れがコンパイルエラーになる。
- **リトライは commit だけでなく、ドメインロジックの構築からやり直す。** 溜めた変更は、開始時の世界を前提に作られている。前提が変わったなら、変更そのものが無効になっている可能性がある。この「どこからやり直すか」を doc コメントに明記する。
- ロックが守る値を「そのロックで守りたい不変条件そのもの」にする。`Mutex<SequenceNumber>` は、ロック取得と期待値検査を 1 つの式に閉じ込める。フラグとカウンタを別々に持つより、間違いが起きにくい。
- 分散の競合検出の前に、**同一プロセス内の競合を安く弾く層** を置く。ローカルの比較 1 回で済むものを、毎回ネットワークに出さない。
- 「起きて当然だが成功ではない」結果 (`AlreadyExists`、`NotModified`、`Conflict`) は、エラー型ではなく **結果型のバリアント** にする。エラーハンドリングの分岐が減る。
- トランザクションのオブジェクトは軽くする。ロックも接続も持たせず、「開始時のバージョン」と「溜めた変更」だけにすれば、やり直しが安くなる。やり直しが安いことが、楽観的並行制御の前提そのものになる。
