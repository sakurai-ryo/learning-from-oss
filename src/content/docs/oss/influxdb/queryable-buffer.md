---
title: "同じデータが 2 か所に見える瞬間は許し、どこにも見えない瞬間は作らない"
description: "InfluxDB 3 のメモリバッファは、WAL の永続化通知を受けてデータをクエリ可能にし、スナップショット時には Parquet を書き出してから自分を空にする。順序が決定的で、「永続化ファイル一覧に足す」と「バッファを消す」を 1 つのロックの中で、必ずこの順に行う。重複は DataFusion のチャンク順序で解決させ、Parquet 化そのものもクエリエンジンの COMPACT プランに任せる。"
sidebar:
  order: 6
---

## 何を学んだか

### どんな状況の話か

InfluxDB 3 でクエリが読む場所は 3 つある。メモリ上のバッファ、オブジェクトストア上の Parquet ファイル、そして [last cache などの専用キャッシュ](../last-cache-table-function/)。データは書き込みの直後にはメモリだけに、数分後には Parquet だけに存在する。

問題は移り変わる瞬間だ。「バッファから消す」と「Parquet を一覧に加える」の間に隙間があれば、その瞬間のクエリからデータが消える。逆にしても、両方に載っている瞬間ができる。書き込みが止まらない状態でこれを毎分繰り返す。

さらにもう 1 つ。バッファには **重複と未ソートの行** がある。同じ時刻・同じタグの行が上書きのために 2 回書かれることがあるし、行は到着順に積まれているので時刻順ではない。Parquet に落とすときには、ソートして重複を除いておかないと、クエリのたびに毎回それをやることになる。

### InfluxDB 3 の答え

1. **順序を決める。両方に見える (重複) は許し、どこにも見えない (欠落) は許さない。** Parquet の書き出しが成功したら、まず永続化ファイル一覧に **足してから**、バッファを空にする。この 2 つは同じ書きロックの中で行う。
2. **重複はクエリ層に解決させる。** バッファ由来のチャンクには `ChunkOrder::new(i64::MAX)`、つまり「最も新しい」順序を与える。DataFusion の重複排除は新しいチャンクを勝たせるので、同じ行が Parquet とバッファの両方にあってもクエリ結果は 1 行になる。
3. **Parquet 化にクエリエンジンを使う。** ソートと重複排除は自前で書かず、`ReorgPlanner::compact_plan` で論理プランを組み、実行結果をそのまま Parquet に書く。
4. **オブジェクトストアへの書き込みは永遠にリトライする。** 「書けないなら書き込み受付も止まるのだから、諦める意味がない」という理屈がコメントに書かれている。
5. **並行度は semaphore で絞る。** チャンクごとの永続化ジョブを `JoinSet` に積み、同時実行数を設定値で制限する。
6. **削除は best effort、参照の除去は確実に。** 保持期間切れのファイルは、一覧からの除去とスナップショットへの記録を先に行い、実体の削除は指数バックオフ付きのバックグラウンドタスクに投げる。

## ソースコードのどこか

### 接点は 2 つのメソッドだけ

[`influxdb3_write/src/write_buffer/queryable_buffer.rs#L487-L503`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L487-L503)。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
#[async_trait]
impl WalFileNotifier for QueryableBuffer {
    async fn notify(&self, write: Arc<WalContents>) {
        self.buffer_wal_contents(write)
    }

    async fn notify_and_snapshot(
        &self,
        write: Arc<WalContents>,
        snapshot_details: SnapshotDetails,
    ) -> Receiver<SnapshotDetails> {
        self.buffer_wal_contents_and_persist_snapshotted_data(write, snapshot_details)
            .await
    }
```

[WAL](../wal-object-store/) と [スナップショットの判断](../snapshot-tracker/) はこの 2 つのメソッドしか知らない。「ファイルが 1 個書けた」と「ファイルが 1 個書けた、ついでにここまでを永続化しろ」の 2 通り。永続化の完了は戻り値の `Receiver` で非同期に通知される。

`notify` 側は単純だ ([`#L153-L160`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L153-L160))。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
    /// Called when the wal has persisted a new file. Buffer the contents in memory and update the
    /// last cache so the data is queryable.
    fn buffer_wal_contents(&self, write: Arc<WalContents>) {
        self.write_wal_contents_to_caches(&write);
        let mut buffer = self.buffer.write();
        buffer.buffer_write_ops(&write.ops);
    }
```

キャッシュ更新が先、バッファ投入が後。逆でも動くが、この順なら「キャッシュには載ったがバッファにない」という重複側の不整合しか起きない。

### 「足してから消す」

[`#L363-L378`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L363-L378)。この章の核心は 15 行しかない。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
                    {
                        // we can clear the buffer as we move on
                        let mut buffer = buffer.write();

                        // add file first
                        persisted_files.add_persisted_file(&database_id, &table_id, &parquet_file);
                        // then clear the buffer
                        if let Some(db) = buffer.db_to_table.get_mut(&database_id)
                            && let Some(table) = db.get_mut(&table_id)
                        {
                            table.clear_snapshots();
                        }
                    }
```

`buffer.write()` の書きロックを取ってから、**永続化ファイル一覧に足し、それからバッファを空にする**。`persisted_files` はバッファとは別のロックを持つ構造だが、この順序を守るためにバッファのロックの内側で更新している。クエリ側は「バッファを読む」「永続ファイル一覧を読む」の順で走るので、この瞬間に割り込んでも、最悪でも同じデータを 2 回見るだけで済む。

コメントが `// add file first` と `// then clear the buffer` の 2 行に分かれているのは、**順序そのものが仕様だから** だ。片方だけ読んでも意味が通らない。

### 重複はチャンクの順序で解く

バッファのチャンクを DataFusion に渡すとき、順序に最大値を入れる ([`#L99-L144`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L99-L144))。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
                Arc::new(BufferChunk {
                    batches,
                    schema: influx_schema.clone(),
                    stats: Arc::new(chunk_stats),
                    partition_id: PartitionHashId::new(
                        data_types::TableId::new(0),
                        &PartitionKey::from(gen_time.to_string()),
                    ),
                    sort_key: None,
                    id: ChunkId::new(),
                    chunk_order: ChunkOrder::new(i64::MAX),
                }) as Arc<dyn QueryChunk>
```

`ChunkOrder` は IOx のクエリ層が重複排除の勝者を決めるのに使う値で、大きいほうが新しい。メモリバッファは常に Parquet より新しいので `i64::MAX`。**「二重に見えてもよい」を成立させているのはこの 1 行** で、順序の保証が無ければ「足してから消す」は重複行をユーザーに見せてしまう。

チャンクの統計情報 (`create_chunk_statistics`) に行数とタイムスタンプの min/max を入れているのも効いている。時間範囲でのプルーニングが効くので、バッファに 10 分ぶんのチャンクが数百あっても、クエリが触るのは範囲の重なるものだけになる。

### 永続化はクエリエンジンにやらせる

[`#L578-L660`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L578-L660) の `sort_dedupe_persist`。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
    // Dedupe and sort using the COMPACT query built into
    // iox_query
```

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
    let logical_plan = ReorgPlanner::new()
        .compact_plan(
            data_types::TableId::new(0),
            persist_job.table_name,
            &persist_job.schema,
            chunks,
            persist_job.sort_key,
        )
        .context(
            "failed to produce a logical plan to deduplicate and sort chunked data from the buffer",
        )?;

    // Build physical plan
    let physical_plan = ctx.create_physical_plan(&logical_plan).await.context(/* ... */)?;

    // Execute the plan and return compacted record batches
    let data = ctx.collect(physical_plan).await.context(/* ... */)?;
```

書き込みパスの中で、論理プランを作り、物理プランに変換し、実行している。ソート済み・重複排除済みの `RecordBatch` が返り、それを Parquet に書く。ソートキーはカタログのテーブル定義から来る (`table_def.sort_key`)。

実行は [専用のエグゼキュータ](../dedicated-executor/) 上で走る (`executor.new_context()`)。永続化は CPU を食う仕事なので、HTTP を捌いている tokio ランタイムではなくクエリ用のスレッドプールに載せる。

書き込みは諦めない。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
    // keep attempting to persist forever. If we can't reach the object store, we'll stop accepting
    // writes elsewhere in the system, so we need to keep trying to persist.
    loop {
        /* ... */
            Err(e) => {
                error!(
                    "Error persisting parquet file {:?}, sleeping and retrying...",
                    e
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
```

無限リトライの理由が明快だ。オブジェクトストアが落ちていれば [WAL 側が 100 回で諦めて書き込みを拒否する](../wal-object-store/) ので、システム全体としては止まる。ならば永続化側が諦める必要はない。**別の層が背圧をかけてくれることを根拠に、この層はリトライだけを担当する。**

書き終えた Parquet はすぐキャッシュに載せる。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
                if let Some(parquet_cache_oracle) = parquet_cache {
                    let cache_request = CacheRequest::create_immediate_mode_cache_request(
                        Path::from(persist_job.path.to_string()),
                        to_cache,
                    );
                    parquet_cache_oracle.register(cache_request);
                }
```

いま書いたバイト列は手元のメモリにある。書いた直後のファイルはクエリされる確率が最も高いので、そのまま [Parquet キャッシュ](../parquet-cache/) に渡す。取りに行かずに済む。

### 失敗したらどうするか、を保留している

同じ関数の呼び出し側 ([`#L349-L358`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L349-L358))。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
                    // for now, we are still panicking in this case, see:
                    // https://github.com/influxdata/influxdb/issues/25676
                    // https://github.com/influxdata/influxdb/issues/25677
                    .expect("sort, deduplicate, and persist buffer data as parquet");
```

ソートや重複排除の失敗 (オブジェクトストア以外の理由) は、いまのところ panic させている。未解決の issue 番号を 2 つ添えて、「これは意図的な暫定処置だ」と明示している。**直っていないことを、直っていない場所に書いてある** のは読み手にとって助かる形だ。

### 並行度と削除

永続化ジョブは semaphore で絞る ([`#L312-L320`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L312-L320))。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
            let semaphore = Arc::new(Semaphore::new(parquet_snapshot_concurrency_limit.get()));
            let mut set = JoinSet::new();
            for persist_job in persist_jobs {
                let permit = Arc::clone(&semaphore)
                    .acquire_owned()
                    .await
                    .expect("semaphore not closed");
```

permit を **spawn する前に** 取っているのがポイント。先に全部 spawn してタスクの中で待たせると、数千個のタスクが同時にメモリ上のバッチを抱えることになる。

保持期間で消えるファイルの扱い ([`#L246-L275`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L246-L275))。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
                    // We've removed the file from the PersistedFiles field.
                    // We'll store them as part of the snapshot so that other parts
                    // that depend on knowing if they exist or not can update their
                    // index accordingly. We try to delete them on a best effort
                    // basis, but if they don't get deleted that's fine they aren't
                    // referenced anymore.
                    tokio::spawn(async move {
                        let mut retry_count = 0;
                        /* ... */
                                Err(_) => {
                                    retry_count += 1;
                                    // Sleep and increase the time with each retry.
                                    // This adds up to about 9 minutes over time.
                                    tokio::time::sleep(tokio::time::Duration::from_secs(
                                        retry_count * 10,
                                    ))
```

**参照を切ることと、実体を消すことを分けている。** 一覧から外し、スナップショットに「消えたファイル」として記録するところまでは同期的に確実に行う。実体の DELETE は 10 回・累計約 9 分のバックオフで試し、失敗したら諦める。孤児オブジェクトはストレージ代を食うが、誰からも参照されないので正しさには影響しない。

## なぜそうなっているか

- **「足してから消す」が選べるのは、重複排除がクエリ層にあるから。** 重複を許さない設計だったら、どちらの順序でも不整合が残り、原子的な切り替えの仕組み (マニフェストの差し替えなど) が必要になる。**下の層で許容できる不整合の種類を、上の層の能力から逆算している。** Iceberg や Delta Lake がスナップショット単位の原子的コミットで解く問題を、InfluxDB 3 は「新しいほうが勝つ」というクエリ時の規則で解いている。
- **永続化にクエリエンジンを使うのは、実装を 1 本にするため。** ソートと重複排除は、クエリでも永続化でも必要になる。IOx の `ReorgPlanner` を呼べば、重複排除の意味論 (どの行が勝つか) がクエリと完全に一致する。自前で書けば速いかもしれないが、2 つの実装が食い違う余地が生まれる。
- **無限リトライが許されるのは、背圧が別の層にあるから。** この判断は、システム全体を見ないと下せない。WAL 側に「100 回で諦めて書き込みを拒否する」があるので、永続化側は「いつか復旧する」を前提にできる。層ごとにリトライ戦略を独立に決めると、こういう整合は取れない。
- **panic を残したまま issue 番号を書いたのは、判断の保留を明示するため。** 永続化の失敗をどう扱うかは難しい。バッファに戻せば無限に膨らみ、捨てればデータが消える。「決めていない」と書いてあるほうが、中途半端に握り潰してあるより扱いやすい。
- **削除の best effort は、オブジェクトストアの課金体系に依存した判断。** 消し損ねたオブジェクトはコストになるだけで、参照が無い以上クエリ結果を変えない。「正しさに影響しない失敗は、諦めてよい失敗」と切り分けている。

## どう活かすか

- 2 つの場所を持つデータを移すときは、**「重複して見える」と「消えて見える」のどちらを許すか** を先に決める。多くの場合、重複のほうが安全で、上位層で潰せる。
- 重複を上位層で潰すには、**どちらが勝つかを決める順序値** が要る。バージョン番号、世代番号、書き込み時刻。この値を最初から持たせておくと、「両方に見える」が怖くなくなる。
- 順序が仕様である箇所には、**順序であることをコメントに書く**。`// add file first` / `// then clear the buffer` の 2 行は、リファクタリングでの入れ替えを防ぐ最後の防波堤になる。
- リトライ戦略は層ごとに独立に決めず、**どこが背圧をかけるかを 1 か所決めて、他はそれに合わせる**。全層が独自に諦めると、諦めた瞬間にデータが消える層が出る。
- 「参照を切る」と「実体を消す」を分ける。前者は確実に、後者は best effort に。これで削除の失敗が正しさの問題から運用コストの問題に降格する。
- 並行度を制限するときは、**タスクを起動する前に permit を取る**。タスクの中で待たせると、待っている全タスクぶんのメモリを先に確保することになる。
- 未解決の設計判断は、`expect` や `todo!` の隣に **issue 番号を書いて残す**。「なぜここで落ちるのか」に答えがある状態と無い状態では、障害対応の速さが変わる。
- 変換処理 (ソート、集約、結合) を書き込みパスで必要としたとき、**手元にクエリエンジンがあるなら再利用を先に検討する**。意味論が一致することの価値は、しばしば実行速度に勝る。
