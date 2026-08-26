---
title: "CPU バウンドな仕事を別ランタイムに隔離し、その中から出る I/O は thread local 経由で元のランタイムに戻す"
description: "tokio は協調的スケジューラなので、DataFusion のプラン実行のような長い CPU 処理は他のタスクを待たせる。InfluxDB 3 は専用スレッドで別の tokio ランタイムを起こしてクエリをそこで走らせ、そのランタイムの全スレッドに「I/O 用ランタイムのハンドル」を thread local で登録する。クエリ中のオブジェクトストア読み出しは spawn_io で元のランタイムに戻される。登録を忘れると、panic メッセージが直し方を教えてくれる。"
sidebar:
  order: 11
---

## 何を学んだか

### どんな状況の話か

tokio のスケジューラは協調的だ。タスクが `await` するまで、ワーカースレッドは他のタスクに移れない。HTTP を捌くランタイムの上で DataFusion のプランを実行すると、ソートや集約が数百ミリ秒 CPU を占有する間、そのスレッドに割り当てられた他のタスクは **実行可能なのに動かない** 状態になる。

症状は分かりにくい形で出る。重いクエリを 1 本投げたら、無関係な `/health` が数百ミリ秒返らない。書き込みリクエストのレイテンシが跳ねる。CPU 使用率は 100% ではない。

`spawn_blocking` を使えばよさそうに見えるが、DataFusion のプラン実行は async な API (ストリーム) で、途中でオブジェクトストアから Parquet を読む。CPU と I/O が交互に来る仕事は、`spawn_blocking` の「ブロッキングな関数を投げる」という形に合わない。

### InfluxDB 3 (IOx) の答え

1. **専用スレッドを 1 本立てて、その中で 2 つ目の tokio ランタイムを作る。** `DedicatedExecutor` がそれを管理する。クエリのプラン実行はここで走る。
2. **境界を越える手段は `spawn` だけにする。** 呼び出し側は `executor.spawn(fut)` を呼び、返るのは元のランタイム上の future。
3. **逆方向 (CPU 側から I/O 側へ) は thread local で解決する。** 専用ランタイムのすべてのワーカースレッドに、起動時に「I/O 用ランタイムのハンドル」を登録する。
4. **I/O は `spawn_io` で明示的に戻す。** Parquet の読み出しは `spawn_io(async { object_store.get(...).await })` の形で書かれ、実行は I/O ランタイム上で行われる。
5. **登録を忘れたら panic するが、メッセージが直し方を書いている。** 「CPU バウンドな仕事が I/O 用スレッドプールで走っている可能性が高い。`DedicatedExecutor::spawn` を使え」。
6. **クエリ用と書き込みパス用で、エグゼキュータを 2 つ持つ。** メモリプールの上限が違う (クエリは制限あり、永続化は無制限)。
7. **専用ランタイムには [ウォッチドッグ](../tokio-watchdog/) を付ける。** 詰まったら分かるようにする。

## ソースコードのどこか

### なぜ分けるのか

[`core/executor/src/lib.rs#L50-L96`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/executor/src/lib.rs#L50-L96) の型ドキュメントが、このページの内容をほぼ全部説明している。

```rust title="core/executor/src/lib.rs"
/// For CPU bound work, such as DataFusion plan execution, it is important to
/// run on a separate thread pool to avoid blocking the I/O handling for extended
/// periods of time in order to avoid long poll latencies (which decreases the
/// throughput of small requests under concurrent load).
///
/// # IO Scheduling
///
/// I/O, such as network calls, should not be performed on the runtime managed
/// by [`DedicatedExecutor`]. As tokio is a cooperative scheduler, long-running
/// CPU tasks will not be preempted and can therefore starve servicing of other
/// tasks. This manifests in long poll-latencies, where a task is ready to run
/// but isn't being scheduled to run. For CPU-bound work this isn't a problem as
/// there is no external party waiting on a response, however, for I/O tasks,
/// long poll latencies can prevent timely servicing of IO, which can have a
/// significant detrimental effect.
```

**「CPU バウンドな仕事なら poll が遅れても困らない (待っている外部の相手がいない) が、I/O は困る」** という非対称性が、分離の根拠になっている。単に「重い処理を分ける」ではなく、待っている相手がいるかどうかで分けている。

トラブルシューティングの節が型のドキュメントにあるのも珍しい。

```rust title="core/executor/src/lib.rs"
/// # Trouble Shooting:
///
/// ## "No IO runtime registered. Call `register_io_runtime`/`register_current_runtime_for_io` in current thread!
///
/// This means that IO was attempted on a tokio runtime that was not registered
/// for IO. One solution is to run the task using [DedicatedExecutor::spawn].
```

### スレッドを 1 本立てて、その中でランタイムを作る

[`#L182-L245`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/executor/src/lib.rs#L182-L245)。

```rust title="core/executor/src/lib.rs"
        let io_handle = tokio::runtime::Handle::try_current().ok();
        let thread = std::thread::Builder::new()
            .name(format!("{name} driver"))
            .spawn(move || {
                // also register the IO runtime for the current thread, since it might be used as well (esp. for the
                // current thread RT)
                register_io_runtime(io_handle.clone());

                let mut runtime_builder = runtime_builder;
                let runtime = runtime_builder
                    .on_thread_start(move || register_io_runtime(io_handle.clone()))
                    .build()
                    .expect("Creating tokio runtime");
```

`Handle::try_current()` で **作られた時点の (= I/O 用の) ランタイム** を掴んでおき、`on_thread_start` で新ランタイムの全ワーカースレッドに配る。この 1 行が、後で `spawn_io` を成立させる。

起動時の競合にも手当てがある。

```rust title="core/executor/src/lib.rs"
                    // Enable the "notified" receiver BEFORE sending the runtime handle back to the constructor thread
                    // (i.e .the one that runs `new`) to avoid the potential (but unlikely) race that the shutdown is
                    // started right after the constructor finishes and the new runtime calls
                    // `notify_shutdown_captured.notified().await`.
                    let shutdown = notify_shutdown_captured.notified();
                    let mut shutdown = std::pin::pin!(shutdown);
                    shutdown.as_mut().enable();

                    if tx_handle.send(Handle::current()).is_err() {
                        return;
                    }
```

「ハンドルを返す前に通知の受け口を有効にする」。順序を逆にすると、コンストラクタが返った直後のシャットダウン通知を取りこぼす。**`Notify` の `enable()` は、まさにこのために用意された API** で、それを使う理由がコメントに書いてある。

### thread local で戻す

[`core/executor/src/io.rs#L9-L38`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/executor/src/io.rs#L9-L38)。

```rust title="core/executor/src/io.rs"
thread_local! {
    /// Tokio runtime `Handle` for doing network (I/O) operations, see [`spawn_io`]
    pub static IO_RUNTIME: RefCell<Option<Handle>> = const { RefCell::new(None) };
}
```

```rust title="core/executor/src/io.rs"
pub fn get_io_runtime() -> Handle {
    IO_RUNTIME.with_borrow(|h| h.clone()).expect(
        "No IO runtime registered. If you hit this panic, it likely \
            means a DataFusion plan or other CPU bound work is running on the \
            a tokio threadpool used for IO. Try spawning the work using \
            `DedicatedExcutor::spawn` or for tests `register_current_runtime_for_io`",
    )
}
```

panic メッセージが **原因の推測と、本番での直し方と、テストでの直し方** を書いている。この仕組みは暗黙的 (引数で渡らない) なので、失敗したときに何が起きたか分からなくなりやすい。それをメッセージで補っている。

`spawn_io` 自体は 5 行だが、後始末が付いている ([`#L40-L70`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/executor/src/io.rs#L40-L70))。

```rust title="core/executor/src/io.rs"
pub async fn spawn_io<Fut>(fut: Fut) -> Fut::Output
where
    Fut: Future + Send + 'static,
    Fut::Output: Send,
{
    DropGuard(get_io_runtime().spawn(fut)).await
}

struct DropGuard<T>(JoinHandle<T>);
impl<T> Drop for DropGuard<T> {
    fn drop(&mut self) {
        self.0.abort()
    }
}
```

`spawn` した future は、呼び出し側が drop されても勝手に走り続ける。それを防ぐのが `DropGuard` で、**クエリがキャンセルされたら、そのクエリが投げた I/O も止まる**。`Future` の実装側では、panic を `resume_unwind` で呼び出し側に伝え、キャンセルは「I/O ランタイムが落ちた」という別の panic にしている。

### 使う側

[`core/iox_query/src/physical_optimizer/cached_parquet_data.rs#L130-L165`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/iox_query/src/physical_optimizer/cached_parquet_data.rs#L130-L165)。DataFusion の `ParquetFileReaderFactory` を実装して、読み出しを差し替えている。

```rust title="core/iox_query/src/physical_optimizer/cached_parquet_data.rs"
        let data = spawn_io(async move {
            let options = if hint_size_to_object_store {
                hint_size(size)
            } else {
                Default::default()
            };
            let res = object_store
                .get_opts(&location, options)
                .await
                .map_err(|e| Arc::new(e) as Arc<dyn std::error::Error + Send + Sync>)?;
            res.bytes().await.map_err(|e| Arc::new(e) as _)
        })
        .boxed()
        .shared();
```

物理最適化のルール (`PhysicalOptimizerRule`) としてプランに差し込まれるので、**クエリを書く人も、プランを組む人も、この仕組みを意識しない**。`shared()` が付いているのは、同じファイルを複数のパーティションが読むときに 1 回の GET で済ませるため。

### 境界を越える唯一の入口

[`#L299-L337`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/executor/src/lib.rs#L299-L337)。

```rust title="core/executor/src/lib.rs"
        // use JoinSet implement "cancel on drop"
        let mut join_set = JoinSet::new();
        join_set.spawn_on(task, &handle);
        async move {
            join_set
                .join_next()
                .await
                .expect("just spawned task")
                .map_err(|e| match e.try_into_panic() {
                    Ok(e) => {
                        /* パニックのメッセージを取り出して JobError::Panic にする */
```

ここでも「drop したらキャンセル」が `JoinSet` で実現されている。panic は `JobError::Panic { msg }` に変換され、**専用ランタイム側の panic がプロセスを巻き込まない**。境界が「エラーの境界」にもなっている。

### 2 つ持つ

[`influxdb3/src/commands/serve.rs#L916-L968`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3/src/commands/serve.rs#L916-L968)。

```rust title="influxdb3/src/commands/serve.rs"
    let exec = Arc::new(Executor::new_with_config_and_executor(
        ExecutorConfig {
            target_query_partitions: tokio_datafusion_config.num_threads.unwrap(),
            /* ... */
            mem_pool_size: config.exec_mem_pool_size.as_num_bytes(),
```

```rust title="influxdb3/src/commands/serve.rs"
    // Note: using same metrics registry causes runtime panic.
    let write_path_executor = Arc::new(Executor::new_with_config_and_executor(
        ExecutorConfig {
            // should this be divided? or should this contend for threads with executor that's
            // setup for querying only
            target_query_partitions: tokio_datafusion_config.num_threads.unwrap(),
            /* ... */
            // use as much memory for persistence, can this be UnboundedMemoryPool?
            mem_pool_size: usize::MAX,
```

[永続化時のソートと重複排除](../queryable-buffer/) も DataFusion で行うが、そちらは「メモリ不足で失敗されると困る」ので、メモリプールを無制限にした別のエグゼキュータを使う。ユーザーのクエリは失敗してよいが、永続化は失敗してはいけない、という優先度の差が設定に出ている。

コメントが疑問形のまま残っているのも正直だ。"should this be divided? or should this contend for threads with executor that's setup for querying only"。スレッド数を分け合うべきか競合させるべきか、決めきれていない。

## なぜそうなっているか

- **`spawn_blocking` では足りないのは、仕事が async だから。** DataFusion のプラン実行は `Stream` を返し、途中で I/O を待つ。`spawn_blocking` に渡せるのは同期の関数なので、この形には合わない。別のランタイムを立てれば、async のまま隔離できる。
- **thread local を選んだのは、引数で引き回せないから。** I/O が必要になるのは DataFusion の奥深く (`ParquetFileReaderFactory` の実装の中) で、そこまでランタイムのハンドルを引数で運ぶには、DataFusion の trait をすべて変えることになる。thread local なら、**外部ライブラリの trait 実装の中からでも取り出せる**。代償は暗黙性で、それを panic メッセージで補っている。
- **「drop したらキャンセル」を両方向で徹底しているのは、クエリが中断されるものだから。** HTTP クライアントが切断すれば、future は drop される。そのときに専用ランタイム上のタスクと、そこから投げた I/O が生き残ると、**誰も結果を受け取らない仕事が CPU とネットワークを使い続ける**。`JoinSet` と `DropGuard` が、それぞれの方向を塞いでいる。
- **エグゼキュータを 2 つ持つのは、失敗してよいかどうかが違うから。** メモリプールを共有すると、大きなクエリが永続化のメモリを奪う。クエリは `ResourcesExhausted` で失敗させてよいが、永続化が失敗するとバッファに残り続け、最終的に書き込みが止まる。**同じ機構を、失敗の許容度で分ける** という判断。
- **ウォッチドッグをここで仕掛けるのは、隔離した先が見えなくなるから。** 専用ランタイムは HTTP のレイテンシに直接は現れない。詰まっても外から分かりにくいので、[ランタイム自身に生存確認を仕込む](../tokio-watchdog/)。

## どう活かすか

- 「重いから分ける」ではなく、**「待っている相手がいるか」で分ける**。外部のクライアントが待っている I/O タスクと、誰も待っていない CPU タスクは、同じスケジューラに載せると前者が割を食う。
- async な CPU バウンド処理は、`spawn_blocking` ではなく **2 つ目のランタイム** で隔離する。境界は `spawn` 1 本に絞り、そこでエラーとキャンセルを変換する。
- 深い呼び出しの奥 (外部ライブラリの trait 実装の中など) に文脈を届ける必要があるなら、**thread local + 起動時の登録** が現実的な手になる。ただし暗黙的な仕組みなので、**失敗時のメッセージに「たぶんこういう状況で、こう直す」を書く**。テスト用の登録関数も一緒に用意する。
- ランタイムやスレッドプールをまたぐときは、**両方向で「drop したらキャンセル」** を保証する。`JoinSet` や `Drop` で `abort()` を呼ぶ小さなガードで済む。これが無いと、キャンセルされたリクエストの仕事が生き残る。
- 同じ機構を使う処理でも、**「失敗してよい」と「失敗してはいけない」は資源を分ける**。メモリプール、スレッド、コネクション数。共有すると、失敗してよい側が失敗してはいけない側を巻き込む。
- 隔離した実行環境には、**外から見えるようにする仕掛け** (メトリクス、ウォッチドッグ) を同時に入れる。隔離は問題の局所化であって、消滅ではない。
- 未決の設計判断は、コメントに疑問形のまま残してよい。「分けるべきか競合させるべきか」が書いてあれば、次に触る人がそこから考えられる。
