---
title: "書き込みパイプラインの段階を型パラメータで表し、「検証を経ていないデータはバッファに入れられない」をコンパイラに守らせる"
description: "InfluxDB 3 の書き込みは「カタログのトランザクションを開く → line protocol を解析してスキーマ変更を溜める → カタログにコミットする → バッファ用のデータに変換する」の 4 段。この順序を WriteValidator<State> の型パラメータで表し、各遷移は self を消費する。結果として最後の変換関数は infallible になり、「スキーマは検証済み」という前提がコードではなく型で保証される。"
group: "プロセス運用"
sidebar:
  order: 16
---

## 何を学んだか

### どんな状況の話か

InfluxDB への 1 回の書き込みリクエストは、こういう処理を通る。

```
POST /api/v3/write_lp?db=mydb
cpu,host=a usage=0.5 1700000000
cpu,host=b usage=0.7,temp=42 1700000001
```

1. データベース `mydb` が無ければ作る
2. line protocol を 1 行ずつ解析する
3. テーブル `cpu` が無ければ作り、列 `host`・`usage`・`temp` が無ければ作る
4. 既存の列と型が食い違っていたら、その行を弾く
5. [カタログ](../catalog-cas/) にスキーマ変更をコミットする
6. 行を [WAL](../wal-object-store/) 用の `WriteBatch` に変換する

この順序には理由がある。5 が終わる前に 6 をやると、**カタログに存在しない列 ID を含むデータが WAL に書かれる**。WAL は durable なので、その後カタログのコミットが失敗しても取り消せない。リプレイ時に「知らない列 ID」に出くわす。

一方、カタログのコミットは [楽観的並行制御](../catalog-cas/) なので **やり直しがある**。やり直すときは 2 からやり直す必要がある。

### InfluxDB 3 の答え

1. **段階を型パラメータで表す。** `WriteValidator<Initialized>`、`WriteValidator<LinesParsed>`、`WriteValidator<CatalogChangesCommitted>`。
2. **各段階のメソッドは、その型に対してのみ実装する。** `commit_catalog_changes` は `WriteValidator<LinesParsed>` にしかない。順序を飛ばすコードはコンパイルできない。
3. **遷移は `self` を消費する。** 前の状態は使えなくなるので、「解析済みだがコミットしていない」データを取り違えて使うことがない。
4. **状態ごとに持つデータが違う。** `Initialized` はカタログとトランザクション、`LinesParsed` はそれに解析済みの行とエラー、`CatalogChangesCommitted` はトランザクションを手放してカタログの連番を持つ。
5. **最後の変換は infallible になる。** 「スキーマは完全に検証済みなので、この関数は失敗しないはずだ」と doc コメントに書ける。
6. **逃げ道は長い名前で用意する。** `ignore_catalog_changes_and_convert_lines_to_buffer` は 1 段飛ばすが、名前が何をしているかを叫んでいる。

## ソースコードのどこか

### 状態の定義

[`influxdb3_write/src/write_buffer/validator.rs#L25-L76`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/validator.rs#L25-L76)。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
/// Type state for the [`WriteValidator`] after it has been initialized
/// with the catalog.
pub struct Initialized {
    catalog: Arc<Catalog>,
    txn: DatabaseCatalogTransaction,
}

/// Type state for the [`WriteValidator`] after it has parsed v1 or v3
/// line protocol.
pub struct LinesParsed {
    catalog: Arc<Catalog>,
    txn: DatabaseCatalogTransaction,
    lines: Vec<QualifiedLine>,
    bytes: u64,
    errors: Vec<WriteLineError>,
}

/// Type state for [`WriteValidator`] after any catalog changes have been committed successfully
/// to the object store.
pub struct CatalogChangesCommitted {
    catalog_sequence: CatalogSequenceNumber,
    db_id: DbId,
    db_name: Arc<str>,
    lines: Vec<QualifiedLine>,
    bytes: u64,
    errors: Vec<WriteLineError>,
}
```

3 つ目で `txn` が消えて `catalog_sequence` に置き換わっているのが重要だ。**コミット後にトランザクションを触れる余地が無い。** 型が「もうこのトランザクションは使い終わった」を表現している。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
/// A state machine for validating v1 or v3 line protocol and updating
/// the [`Catalog`] with new tables or schema changes.
pub struct WriteValidator<State> {
    state: State,
}
```

型パラメータに trait 境界が無い。**状態は「型が違う」ことだけが意味を持ち、共通の振る舞いは要求されない。** `impl WriteValidator<Initialized>` のように、状態ごとに `impl` ブロックを分けて実装する。

### 遷移

[`#L98-L112`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/validator.rs#L98-L112)。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
impl WriteValidator<Initialized> {
    /// Initialize the [`WriteValidator`] by starting a catalog transaction on the given database
    /// with name `db_name`. This initializes the database if it does not already exist.
    pub fn initialize(db_name: DatabaseName, catalog: Arc<Catalog>) -> Result<Self> {
        let txn = catalog.begin(db_name.as_str())?;
        // Check if the database is soft-deleted and reject writes if so.
        if txn.db_schema().deleted {
            return Err(Error::DatabaseDeleted(db_name.to_string()));
        }
```

[`#L114-L180`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/validator.rs#L114-L180)。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
    /// # Implementation Note
    ///
    /// This does not apply the changes to the catalog, it only modifies the database copy that
    /// is held on the catalog transaction.
    pub fn v1_parse_lines_and_catalog_updates(
        mut self,
        lp: &str,
        accept_partial: bool,
        ingest_time: Time,
        precision: Precision,
    ) -> Result<WriteValidator<LinesParsed>> {
```

`mut self` を取って `WriteValidator<LinesParsed>` を返す。**元の値は消費されるので、解析前の状態に戻れない。** doc コメントの Implementation Note が「まだカタログには反映していない」を明示している。

そして次の段階 ([`#L338-L358`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/validator.rs#L338-L358))。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
impl WriteValidator<LinesParsed> {
    pub async fn commit_catalog_changes(
        self,
    ) -> Result<Prompt<WriteValidator<CatalogChangesCommitted>>> {
        /* ... */
        match self.state.catalog.commit(self.state.txn).await? {
            Prompt::Success(catalog_sequence) => Ok(Prompt::Success(WriteValidator {
                state: CatalogChangesCommitted {
                    catalog_sequence,
                    /* ... */
                },
            })),
            Prompt::Retry(_) => Ok(Prompt::Retry(())),
        }
    }
```

戻り値が `Result<Prompt<WriteValidator<...>>>` という 3 重の入れ子になっている。**「失敗した」「やり直しが要る」「成功して次の状態になった」の 3 つが型で区別される。** [カタログのページ](../catalog-cas/) で見た `Prompt` が、ここで型状態と組み合わさっている。

`Prompt::Retry` のときに何も持って返らないのは、やり直しがパースからになるから。呼び出し側 ([`influxdb3_write/src/write_buffer/mod.rs#L518-L535`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/mod.rs#L518-L535)) は `loop` の先頭に戻り、`WriteValidator::initialize` からやり直す。

### 最後の段階が失敗しない

[`#L403-L412`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/validator.rs#L403-L412)。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
impl WriteValidator<CatalogChangesCommitted> {
    /// Convert a set of valid parsed `v3` lines to a [`ValidatedLines`] which will
    /// be buffered and written to the WAL, if configured.
    ///
    /// This involves splitting out the writes into different batches for each chunk, which will
    /// map to the `Gen1Duration`. This function should be infallible, because
    /// the schema for incoming writes has been fully validated.
    pub fn convert_lines_to_buffer(self, gen1_duration: Gen1Duration) -> ValidatedLines {
```

**"This function should be infallible, because the schema for incoming writes has been fully validated."** 戻り値が `Result` ではないことの根拠が、型状態そのものになっている。`CatalogChangesCommitted` を持っているということは、検証とコミットを通ったということだ。

この保証は [メモリバッファ](../table-buffer-arrow/) にも伝わる。バッファの `add_rows` は型の食い違いで `panic!` するが、そこに到達するデータは既にこの検証を通っている。**「ここには到達しないはず」の panic を正当化しているのが、上流の型状態。**

呼び出し側 ([`influxdb3_write/src/write_buffer/mod.rs`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/mod.rs#L524-L535)) では、全体が 1 本の式として繋がる。

```rust title="influxdb3_write/src/write_buffer/mod.rs"
            // validated lines will update the in-memory catalog, ensuring that all write operations
            // past this point will be infallible
            let result = match WriteValidator::initialize(db_name.clone(), self.catalog())?
                .v1_parse_lines_and_catalog_updates(lp, accept_partial, ingest_time, precision)?
                .commit_catalog_changes()
                .await?
            {
                Prompt::Success(r) => r.convert_lines_to_buffer(self.wal_config.gen1_duration),
                Prompt::Retry(_) => { /* ... */ continue; }
            };
```

メソッドチェーンが、そのままパイプラインの図になっている。

### 逃げ道の名前

[`#L360-L377`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/validator.rs#L360-L377)。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
    pub fn ignore_catalog_changes_and_convert_lines_to_buffer(
        self,
        gen1_duration: Gen1Duration,
    ) -> ValidatedLines {
        let db_schema = self.state.txn.db_schema();
        let ignored = WriteValidator {
            state: CatalogChangesCommitted {
                catalog_sequence: self.state.txn.sequence_number(),
                /* ... */
            },
        };
        ignored.convert_lines_to_buffer(gen1_duration)
    }
```

カタログのコミットを飛ばして次の状態を作る。テストや、[Processing Engine のプラグインのドライラン](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/README_processing_engine.md) のように「解析だけしたい」場面で使う。

**型状態を破る道を用意するときは、名前で叫ばせる。** `ignore_catalog_changes_and_` という接頭辞があれば、コードレビューで見逃さない。型で禁止したものを `pub` で開けるなら、その代償を名前で払う、という判断。

### 行ごとのエラー

[`#L124-L172`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/validator.rs#L124-L172)。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
                Ok(qualified_line) => qualified_line,
                Err(e) => {
                    if !accept_partial {
                        return Err(Error::ParseError(e));
                    } else {
                        errors.push(e);
                    }
                    continue;
                }
```

`accept_partial` の扱いが、状態に載る形になっている。エラーは `LinesParsed.errors` に溜まり、最後まで運ばれてレスポンスに含まれる。**「一部失敗」という結果を、成功の型の中に持たせている。**

### 重複タグを弾く理由

[`#L226-L240`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/validator.rs#L226-L240)。

```rust title="influxdb3_write/src/write_buffer/validator.rs"
            // Reject a point that repeats a tag key. Without this a duplicate tag
            // produces two columns with the same id, which desyncs the table buffer
            // and later panics when building the record batch (all columns must have
            // the same length). Mirrors the duplicate-field check below.
            if !column_ids.insert(col_id) {
```

**遠くの層の不変条件を、入口で守っている。** [メモリバッファ](../table-buffer-arrow/) の「全列の長さが等しい」は、同じ列に 2 回値を追加すると壊れる。壊れると `RecordBatch::try_new` の段階、つまり **クエリか永続化のときに** panic する。書き込みからは遠く離れた場所だ。

コメントが「なぜここでチェックするか」を、壊れる場所と症状まで含めて説明している。この検査を消したときに何が起きるかが分かるので、リファクタリングで消されにくい。

## なぜそうなっているか

- **型状態を選んだのは、順序を破ると durable な副作用が残るから。** 「WAL に書いてしまう」は取り消せない。実行時チェック (フラグを見て assert) でも防げるが、テストで踏まない経路が残る。**コンパイルできないなら、その経路は存在しない。**
- **各段階でデータを持ち替えるのが、この設計の実質的な価値。** 型パラメータを分けるだけなら `PhantomData` で足りるが、ここでは状態ごとに **持っているフィールドが違う**。コミット後にトランザクションを持たないのは、「もう使えない」をコンパイラに教える最も直接的な方法だ。
- **infallible にできることが、下流の設計を単純にしている。** `convert_lines_to_buffer` が `Result` を返さないので、呼び出し側にエラー処理が不要になる。そして [WAL への書き込み](../wal-object-store/) 以降は「失敗しうるのは I/O だけ」になる。**検証を 1 か所に集めて、その後を無謬にする** という形。
- **`Prompt` と型状態の組み合わせが、やり直しの範囲を明示している。** `Prompt::Retry` が何も持たないのは、「持ち帰れるものが無い」という設計判断そのもの。解析結果は古いカタログを前提にしているので、捨てるしかない。型がそれを表している。
- **逃げ道を用意したのは、テストとドライランのため。** 型状態は「正しい順序しか書けない」と同時に「テストで途中の状態を作りにくい」という副作用がある。`into_inner()` / `inner()` も "This is mainly used for testing" と明記されている。**型で締めたぶん、テストのための穴を意図的に開けて、名前とコメントで用途を限定する。**

## どう活かすか

- 段階を踏む処理で、**順序を破ると取り消せない副作用が出る** なら、型状態を検討する。ジェネリックな `Foo<State>` と、状態ごとの `impl` ブロックだけで書ける。trait も `PhantomData` も必ずしも要らない。
- 遷移は **`self` を消費する** 形にする。前の状態が使えなくなることが、この手法の効き目のほとんどを占める。
- 状態ごとに **持つデータを変える**。使い終わったリソース (トランザクション、コネクション、ロック) を次の状態に持ち越さないことで、「もう使えない」が型で表現される。
- 検証を通った先の関数は **`Result` を返さない形に設計する**。「ここから先は失敗しない」を型で宣言できると、下流のエラー処理が丸ごと消える。その根拠を doc コメントに 1 行書いておく。
- 型状態を破る逃げ道は、**名前で何をしているかを叫ばせる**。`ignore_..._and_...` のような長い名前は、レビューで目に付く。テスト専用のものは doc コメントにそう書く。
- **遠くの層の不変条件は、入口で守る**。壊れたデータが遠くで panic する構造では、原因の特定に時間がかかる。入口のチェックには「これが無いと、どこで、どう壊れるか」をコメントに書く。
- 「一部成功」を返す API では、**エラーを成功の型の中に運ぶ**。`Result` の `Err` に載せると、成功したぶんのデータが失われる。
