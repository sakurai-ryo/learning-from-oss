---
title: "専用のキャッシュを SQL から使わせるとき、独自構文ではなくテーブル関数として生やし、述語は式木ではなく LiteralGuarantee で解釈する"
description: "InfluxDB 3 の last cache は、キー列の階層で「直近 N 件」を持つ専用のメモリ構造。これを SQL から使うために、独自の構文ではなく DataFusion のテーブル関数 (last_cache('cpu')) として登録している。WHERE 句の解釈は Expr の木を場合分けせず、物理式に変換してから DataFusion の LiteralGuarantee で IN / NOT IN に蒸留する。押し込んだ述語は EXPLAIN に出る。"
group: "クエリ実行"
sidebar:
  order: 13
---

## 何を学んだか

### どんな状況の話か

「各サーバーの最新の CPU 使用率」のようなクエリは、監視ダッシュボードで最も多く発行される。しかし [Parquet と メモリバッファ](../queryable-buffer/) を素直にスキャンして `ORDER BY time DESC LIMIT 1` を取るのは重い。直近 10 分ぶんのデータを全部読んでから 1 行に絞ることになる。

InfluxDB 3 は専用の構造を持っている。**last cache** は、指定したキー列 (`host` など) の値ごとに、最後の N 行を保持するメモリ上のキャッシュだ。これを使えば「最新の 1 件」は O(1) で取れる。

問題は **SQL からどう使わせるか**。専用の構文を足せばパーサを持つことになるし、テーブルとして見せると通常のスキャンと区別できない。

### InfluxDB 3 の答え

1. **DataFusion のユーザー定義テーブル関数 (UDTF) として登録する。** `SELECT * FROM last_cache('cpu')` と書ける。パーサには一切手を入れない。
2. **関数呼び出しの引数の検証を `TableFunctionImpl::call` でやる。** テーブル名とキャッシュ名を受け取り、存在しなければ **プラン作成時に** エラーにする。
3. **`TableProvider` を返し、`scan` の中でキャッシュを読む。** 結果は `RecordBatch` の列になり、DataFusion のメモリソースとして扱われる。
4. **WHERE 句の解釈は `Expr` の木を場合分けしない。** 物理式に変換してから `LiteralGuarantee::analyze` にかけ、「この列は必ずこの値のどれか (IN)」「この列は絶対にこの値ではない (NOT IN)」という形に蒸留する。
5. **押し込んだ述語は `Inexact` として申告する。** DataFusion は同じフィルタをもう一度適用する。キャッシュ側の絞り込みは近似でよい。
6. **押し込んだ述語を `EXPLAIN` に出すためだけの `ExecutionPlan` を挟む。** 実処理は内側の `DataSourceExec` に丸投げし、この層は表示だけを足す。

## ソースコードのどこか

### 関数として登録する

[`influxdb3_query_executor/src/lib.rs#L639-L654`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_query_executor/src/lib.rs#L639-L654)。セッションを作るたびに登録する。

```rust title="influxdb3_query_executor/src/lib.rs"
        let ctx = cfg.build();
        ctx.inner().register_udtf(
            LAST_CACHE_UDTF_NAME,
            Arc::new(LastCacheFunction::new(
                self.db_schema.id,
                self.write_buffer.last_cache_provider(),
            )),
        );
        ctx.inner().register_udtf(
            DISTINCT_CACHE_UDTF_NAME,
            Arc::new(DistinctCacheFunction::new(
                self.db_schema.id,
                self.write_buffer.distinct_cache_provider(),
            )),
        );
```

**関数の実体がデータベース ID を捕まえている。** セッションごとに作るので、`last_cache('cpu')` の解決先はそのセッションのデータベースに閉じる。テーブル関数の引数にデータベース名を含める必要がない。

### 引数の検証はプラン時に

[`influxdb3_cache/src/last_cache/table_function.rs#L303-L349`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/last_cache/table_function.rs#L303-L349)。

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
impl TableFunctionImpl for LastCacheFunction {
    fn call(&self, args: &[Expr]) -> Result<Arc<dyn TableProvider>, DataFusionError> {
        let Some(Expr::Literal(ScalarValue::Utf8(Some(table_name)), _)) = args.first() else {
            return plan_err!("first argument must be the table name as a string");
        };

        let cache_name = match args.get(1) {
            Some(Expr::Literal(ScalarValue::Utf8(Some(name)), _)) => Some(name),
            Some(_) => {
                return plan_err!("second argument, if passed, must be the cache name as a string");
            }
            None => None,
        };
```

第 2 引数が省略されたときの挙動が親切だ。

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
        let Some(cache) = (match cache_name {
            Some(name) => table_def.last_caches.get_by_name(name),
            None => {
                if table_def.last_caches.len() == 1 {
                    table_def.last_caches.resource_iter().next().cloned()
                } else {
                    None
                }
            }
        }) else {
            return plan_err!("could not find cache for the given arguments");
        };
```

キャッシュが 1 つしかなければそれを使う。複数あれば名前を要求する。**曖昧でないときだけ省略を許す**、という設計。

エラーが `plan_err!` なのが重要で、これは **クエリのプラン作成段階で失敗する**。実行が始まってから「キャッシュがありません」と言われるより、構文エラーに近い形で返る。

### 述語を「解釈」しない

[`#L116-L180`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/last_cache/table_function.rs#L116-L180)。長いコメントが問題を説明している。

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
    // The set of `filters` that are passed in from DataFusion varies: 1) based on how they are
    // defined in the query, and 2) based on some decisions that DataFusion makes when parsing the
    // query into the `Expr` syntax tree. For example, the predicate:
    //
    // WHERE foo IN ('bar', 'baz')
    //
    // instead of being expressed as an `InList`, would be simplified to the following `Expr` tree:
    //
    // [
    //     BinaryExpr {
    //         left: BinaryExpr { left: "foo", op: Eq, right: "bar" },
    //         op: Or,
    //         right: BinaryExpr { left: "foo", op: Eq, right: "baz" }
    //     }
    // ]
    //
    // while the predicate:
    //
    // WHERE foo = 'bar' OR foo = 'baz' OR foo = 'bop' OR foo = 'bla'
    //
    // instead of being expressed as a tree of `BinaryExpr`s, is expressed as an `InList` with four
    // entries:
```

**同じ意味の SQL が、書き方によって違う形の式木になる。** しかも変換の向きが直感と逆で、`IN` は `OR` の連鎖に、`OR` の連鎖は `IN` になったりする。これを場合分けで受け止めようとすると、DataFusion の最適化が変わるたびに壊れる。

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
    // Instead of handling all the combinations of `Expr`s that may be passed by the caller of
    // `TableProider::scan`, we can use the cache's schema to convert each `Expr` to a `PhysicalExpr`
    // and analyze it using DataFusion's `LiteralGuarantee`.
    //
    // This will distill the provided set of `Expr`s down to either an IN list, or a NOT IN list
    // which we can convert to the `Predicate` type for the lastcache.
```

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
    for expr in filters {
        let physical_expr = create_physical_expr(expr, &schema, &props)?;
        let literal_guarantees = LiteralGuarantee::analyze(&physical_expr);
        for LiteralGuarantee {
            column,
            guarantee,
            literals,
        } in literal_guarantees
        {
```

`LiteralGuarantee` は DataFusion が Parquet のプルーニングのために持っている解析で、**「式が true になるためには、この列はこの値のどれかでなければならない」** を導出する。構文の形に依存しない。「解析結果を再利用する」ことで、式木の形の多様性を丸ごと回避している。

同じ列に複数の保証が付いたときの合成も書いてある。

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
                            // if we encounter a IN predicate on a column for which we already have
                            // a IN guarantee, we take their intersection, i.e.,
                            //
                            // a IN (1, 2) AND a IN (2, 3)
                            //
                            // becomes
                            //
                            // a IN (2)
```

`IN` どうしは積、`NOT IN` どうしは和。**型が混ざったら (IN と NOT IN) 諦めて DataFusion に任せる。**

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
                            // for non matching predicate types, we just remove by taking the
                            // Option. We will let DataFusion handle the predicate at a higher
```

諦められるのは、押し込みが `Inexact` だからだ ([`#L64-L70`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/last_cache/table_function.rs#L64-L70))。

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
    fn supports_filters_pushdown(
        &self,
        filters: &[&Expr],
    ) -> Result<Vec<TableProviderFilterPushDown>, DataFusionError> {
        Ok(vec![TableProviderFilterPushDown::Inexact; filters.len()])
    }
```

`Inexact` は「ある程度は絞るが、完全ではない」という申告で、DataFusion は同じフィルタを結果にもう一度適用する。**押し込みの実装が不完全でも、結果は正しい。** 押し込みを性能の最適化に留め、正しさの責任を持たせない設計になっている。

キャッシュのキー列でない列への述語も、そのまま無視する。

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
            // do not handle predicates on non-key columns, let datafusion do that:
            if !cache_key_column_ids.contains(&column_def.id) {
                continue;
            }
```

### キャッシュが消えていたら空を返す

[`#L69-L112`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/last_cache/table_function.rs#L69-L112) の `scan`。

```rust title="influxdb3_cache/src/last_cache/table_function.rs"
        } else {
            // If there is no cache, it means that it was removed, in which case, we just return
            // an empty set of record batches.
            (None, vec![])
        };
        drop(read);
```

プラン作成時にはあったキャッシュが、実行時には消えているかもしれない (`DELETE` されたか、[カタログのイベント](../catalog-cas/) で消えたか)。エラーにせず空を返す。また、`drop(read)` を明示して **読みロックをプランの構築より前に手放している**。

### EXPLAIN のためだけの層

[`#L351-L376`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/last_cache/table_function.rs#L351-L376)。

````rust title="influxdb3_cache/src/last_cache/table_function.rs"
/// Custom implementor of the [`ExecutionPlan`] trait for use by the last cache
///
/// Wraps a [`DataSourceExec`] from DataFusion which it relies on for the actual implementation of the
/// [`ExecutionPlan`] trait. The additional functionality provided by this type is that it tracks
/// the predicates that are pushed down to the underlying cache during query planning/execution.
///
/// # Example
///
/// ```text
/// LastCacheExec: predicates=[[region@0 IN ('us-east','us-west')]] inner=[...]
/// ```
````

`execute`、`properties`、`children` はすべて内側への委譲で、独自の処理は `DisplayAs` の実装だけ。**「押し込みが効いたかどうか」をユーザーが確認できる** ためだけに、プランのノードを 1 段増やしている。

述語の押し込みは、効いているかどうかが結果から分からない (結果は同じで速さだけが変わる) 。だから `EXPLAIN` に出す。ドキュメントに出力例が 2 つ (押し込みあり / なし) 載っているのも、この層の目的が表示であることを示している。

### キャッシュ自体の構造

[`influxdb3_cache/src/last_cache/cache.rs#L539-L548`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/last_cache/cache.rs#L539-L548)。

```rust title="influxdb3_cache/src/last_cache/cache.rs"
/// Represents the hierarchical last cache structure
pub(crate) enum LastCacheState {
    /// An initialized state that is used for easy construction of the cache
    Init,
    /// Represents a branch node in the hierarchy of key columns for the cache
    Key(LastCacheKey),
    /// Represents a terminal node in the hierarchy, i.e., the cache of field values
    Store(LastCacheStore),
}
```

キー列ごとに 1 段の木で、葉が実データ。`host` と `region` をキーにすれば 2 段になる。葉の `LastCacheStore` は列ごとのリングバッファ (`VecDeque`) と、挿入時刻のリングバッファを持ち、TTL で期限切れを落とす。

このキャッシュは [WAL の通知](../queryable-buffer/) で更新される。`write_wal_contents_to_cache` が呼ばれるのは、データがバッファに入るのと同じ瞬間だ。

## なぜそうなっているか

- **テーブル関数を選んだのは、パーサに手を入れないため。** 独自構文 (`SELECT LAST(...)` のような) を足すと、SQL パーサをフォークするか、前処理を挟むことになる。テーブル関数なら DataFusion の既存の仕組みに乗る。しかも **他の SQL と組み合わせられる** — `last_cache('cpu')` を `JOIN` の片側にも、サブクエリにも書ける。
- **`LiteralGuarantee` を使うのは、式木の形が保証されないから。** コメントが挙げる例のとおり、`IN` と `OR` の相互変換は DataFusion の最適化に依存する。自前で場合分けすると、DataFusion のアップグレードで静かに壊れる (エラーにならず、押し込みが効かなくなるだけ)。**上流が既に持っている解析結果を借りる** ほうが堅い。
- **`Inexact` を選んだことが、実装の自由度を生んでいる。** 「IN と NOT IN が混ざったら諦める」「キー列以外は無視する」といった手抜きが許されるのは、DataFusion が最後にもう一度フィルタするから。`Exact` を申告していたら、すべての述語を正確に実装する義務が生じる。
- **EXPLAIN のための層は、性能機能の宿命への対処。** 押し込み、キャッシュ、プルーニングは、効いても効かなくても結果が同じなので、**動作していることを確認する手段が要る**。メトリクスでも分かるが、`EXPLAIN` ならクエリ単位で分かる。
- **キャッシュが消えていたら空を返すのは、プランと実行の間に時間があるから。** カタログは並行に変わりうる。ここでエラーにすると、まれに失敗するクエリができる。「消えた = 何も無い」と解釈するほうが、この用途では自然だ。

## どう活かすか

- 専用のデータ構造を SQL から使わせたいなら、**独自構文より先にテーブル関数 (UDTF) を検討する**。パーサに手を入れずに済み、既存の SQL と組み合わせられる。
- 関数の引数の検証は **プラン作成時に行い、プランエラーとして返す**。実行時エラーより早く、原因も分かりやすい。曖昧でないときだけ引数の省略を許す、という緩和も入れやすい。
- クエリエンジンから渡される式木を **自前で場合分けしない**。同じ意味の式が違う形で来る。エンジンが既に持っている解析 (DataFusion の `LiteralGuarantee`、他の DB の同等物) に通してから、自分のドメインの述語型に変換する。
- 述語の押し込みは **`Inexact` (近似) として申告する**。エンジンが最終的なフィルタを保証してくれるので、押し込みは「できるところだけ」でよくなる。実装の複雑さが劇的に下がる。
- 「効いても効かなくても結果が同じ」機能には、**効いたことが見える経路** を作る。プランの表示、ログ、メトリクス。表示のためだけに層を 1 枚足すのは、十分に元が取れる。
- プラン時に存在したものが実行時には無いことがある。**その場合に何を返すか (エラーか、空か)** を先に決める。並行に変わる状態を参照する仕組みでは、必ず起きる。
- ロックを取って読んだデータは、**プランを組む前に `drop` する**。プランの構築中もロックを握ったままだと、書き込み側が待たされる。
