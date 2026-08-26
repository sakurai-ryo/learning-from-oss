---
title: "非同期ランタイムが詰まったことを、ランタイムの外の OS スレッドから ping で検出する"
description: "tokio のワーカーが CPU に占領されると、実行可能なタスクが動かない。この状態はランタイムの中からは観測できない。InfluxDB 3 (IOx) が使う tokio_watchdog は、素の OS スレッドを 1 本立てて、tokio 上の応答タスクに Instant を送り、返ってくるまでの時間を測る。しきい値内に返らなければ「詰まっている」を数え、回復したら詰まっていた長さをログに出す。"
sidebar:
  order: 15
---

## 何を学んだか

### どんな状況の話か

[専用エグゼキュータのページ](../dedicated-executor/) で見たとおり、tokio は協調的スケジューラだ。タスクが `await` を返すまで、そのワーカースレッドは他のタスクに移れない。CPU バウンドな処理を隔離しても、隔離した先が詰まる可能性は残る。

この「詰まり」は観測が難しい。

- **CPU 使用率には出ない。** 100% になるとは限らない。ワーカー 8 本のうち 2 本が長い処理を掴んでいるだけかもしれない。
- **リクエストのレイテンシに出るが、原因は分からない。** 遅いのがネットワークなのか、オブジェクトストアなのか、スケジューリングなのかが区別できない。
- **ランタイムの中から測れない。** 計測用のタスクを spawn しても、そのタスク自身が詰まりの影響を受ける。「遅い」ことは分かっても、「いつから」「どれだけ」は分からない。

### IOx の答え

1. **観測者をランタイムの外に置く。** `std::thread` で素の OS スレッドを 1 本立てる。このスレッドは tokio のスケジューラの影響を受けない。
2. **ping/pong で往復時間を測る。** 外のスレッドが `Instant::now()` をチャネルに送り、tokio 上のタスクが `start.elapsed()` を返す。この値が **スケジューリングの遅延そのもの** になる。
3. **しきい値内に返らなかったら「詰まり」として数える。** `try_recv` が空なら、カウンタを 1 増やしてデバッグログを出す。
4. **回復するまで待って、詰まっていた長さを記録する。** その後 `blocking_recv` で待ち続け、返ってきた値をヒストグラムに入れる。
5. **メトリクスは 2 つだけ。** 応答時間のヒストグラムと、詰まりの回数のカウンタ。ランタイムごとにラベルを付ける。
6. **設定は builder で、間隔と警告しきい値を指定する。** [専用エグゼキュータ](../dedicated-executor/) はどちらも 100 ms で仕掛ける。

## ソースコードのどこか

### 全部で 220 行

[`core/tokio_watchdog/src/lib.rs#L1-L2`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/tokio_watchdog/src/lib.rs#L1-L2)。

```rust title="core/tokio_watchdog/src/lib.rs"
//! Monitors if the tokio runtime still looks healthy.
```

設定は builder ([`#L18-L26`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/tokio_watchdog/src/lib.rs#L18-L26))。

```rust title="core/tokio_watchdog/src/lib.rs"
pub struct WatchdogConfig<'a> {
    handle: &'a Handle,
    metric_registry: &'a Registry,
    runtime_name: String,
    tick_duration: Duration,
    warn_threshold: Duration,
    new_thread_hook: Option<Box<dyn FnOnce() + Send>>,
}
```

`handle` は **監視対象のランタイムのハンドル**。監視する側が対象を指定する形なので、複数のランタイムにそれぞれ仕掛けられる。`runtime_name` はメトリクスのラベルになる。

設定の妥当性は install 時に検査する ([`#L100-L106`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/tokio_watchdog/src/lib.rs#L100-L106))。

```rust title="core/tokio_watchdog/src/lib.rs"
        assert!(
            !(tick_duration + warn_threshold).is_zero(),
            "sum of tick and warn duration must be non-zero"
        );
```

両方 0 だと監視スレッドがビジーループになる。**「設定次第で CPU を焼き切る」を assert で塞ぐ。** テストにもこの panic の確認が入っている。

### 応答側 (ランタイムの中)

[`#L129-L139`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/tokio_watchdog/src/lib.rs#L129-L139)。

```rust title="core/tokio_watchdog/src/lib.rs"
        handle.spawn(async move {
            loop {
                let Some(start) = rx_request.recv().await else {
                    return;
                };

                if tx_response.try_send(start.elapsed()).is_err() {
                    return;
                }
            }
        });
```

**受け取った `Instant` の経過時間を返すだけ。** これがランタイムの中で動く唯一のコードで、CPU はほぼ使わない。だから返ってくるまでの時間は、そのまま **「このタスクが実行されるまでに待たされた時間」** になる。

チャネルが閉じたら `return` する。監視スレッドが消えたら、応答タスクも消える。

### 監視側 (ランタイムの外)

[`#L141-L177`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/tokio_watchdog/src/lib.rs#L141-L177)。

```rust title="core/tokio_watchdog/src/lib.rs"
        std::thread::Builder::new()
            .name(format!("tokio watchdog {runtime_name}"))
            .spawn(move || {
                if let Some(hook) = new_thread_hook {
                    hook();
                }

                loop {
                    std::thread::sleep(tick_duration);

                    if tx_request.try_send(Instant::now()).is_err() {
                        return;
                    }

                    std::thread::sleep(warn_threshold);
```

`std::thread::sleep` であって `tokio::time::sleep` ではない。**この 2 つの sleep が、この設計の全部** だと言ってよい。OS のスケジューラだけに依存するので、tokio がどれだけ詰まっていても、このスレッドは定刻に起きる。

スレッドに名前を付けているのも実用的で、`top -H` や `perf` でこのスレッドが識別できる。

判定と回復の待ち。

```rust title="core/tokio_watchdog/src/lib.rs"
                    let d = match rx_response.try_recv() {
                        Ok(d) => d,
                        Err(TryRecvError::Empty) => {
                            debug!(runtime = runtime_name, "tokio starts hanging",);
                            metric_hang.inc(1);

                            let Some(d) = rx_response.blocking_recv() else {
                                return;
                            };
                            debug!(
                                runtime = runtime_name,
                                hang_secs = d.as_secs_f64(),
                                "tokio stops hanging",
                            );
                            d
                        }
```

**「詰まり始めた」と「詰まりが解消した」を別々にログに出す。** 前者は検出の瞬間、後者は回復の瞬間で、後者には詰まっていた実際の長さが入る。この 2 行が対になっているので、ログを追えば「12:34:56 から 3.2 秒詰まっていた」が読める。

`blocking_recv` で待ち続けるので、**詰まっている間は次の ping を送らない**。詰まりが 10 秒続いても、カウンタは 1 のまま。「詰まった回数」と「詰まった長さ」が別々に測られる。

計測値はヒストグラムに入る ([`#L110-L127`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/tokio_watchdog/src/lib.rs#L110-L127))。

```rust title="core/tokio_watchdog/src/lib.rs"
        let metric_latency = metric_registry
            .register_metric::<DurationHistogram>(
                "tokio_watchdog_response_time",
                "Response time of the tokio watchdog task",
            )
            .recorder([(
                "runtime",
                Cow::<'static, str>::from(runtime_name.to_owned()),
            )]);
        let metric_hang = metric_registry
            .register_metric::<U64Counter>(
                "tokio_watchdog_hangs",
                "Number of hangs detected by the tokio watchdog",
            )
```

正常時の応答時間もヒストグラムに入り続ける。**詰まっていないときの分布が分かる** ので、「p99 が普段は 1 ms なのに今日は 20 ms」という劣化にも気づける。

### 仕掛ける場所

[`core/executor/src/lib.rs#L213-L217`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/executor/src/lib.rs#L213-L217)。

```rust title="core/executor/src/lib.rs"
                WatchdogConfig::new(runtime.handle(), &metric_registry)
                    .with_runtime_name(&name)
                    .with_tick_duration(Duration::from_millis(100))
                    .with_warn_duration(Duration::from_millis(100))
                    .install();
```

[専用エグゼキュータ](../dedicated-executor/) がランタイムを作った直後、`block_on` に入る前。100 ms 間隔でチェックし、100 ms 返らなければ詰まりとみなす。**CPU バウンドな処理を隔離した先にこそ、この監視が要る** という判断が、置き場所に出ている。

### テストのための hook

builder の `with_new_thread_hook` は、テストのためだけにある。

```rust title="core/tokio_watchdog/src/lib.rs"
    /// Sets a hook that is called when the watchdog thread is created.
    ///
    /// The hook is called from the new thread.
    pub fn with_new_thread_hook<F>(self, f: F) -> Self
```

テストでは、ログを捕捉する `TracingCapture` をこのスレッドに登録するために使っている ([`#L204-L226`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/tokio_watchdog/src/lib.rs#L204-L226))。ログの捕捉が thread local な仕組みなので、**新しいスレッドの中で登録し直す必要がある**。テストは `std::thread::sleep` でランタイムを実際に詰まらせ、`"tokio starts hanging"` と `"tokio stops hanging"` の両方がログに出ることを確認する。

### 隣のクレートの、盲点を塞ぐテスト

同じ関心から生まれた仕組みが `tokio_metrics_bridge` にもある。tokio のランタイム統計は `cfg(tokio_unstable)` でしか取れないので、コードが条件コンパイルで分かれる。そこにこんなテストが置いてある ([`core/tokio_metrics_bridge/src/lib.rs#L18-L36`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/core/tokio_metrics_bridge/src/lib.rs#L18-L36))。

```rust title="core/tokio_metrics_bridge/src/lib.rs"
    #[test]
    #[cfg(not(tokio_unstable))]
    fn test_must_be_tested() {
        // If you are reading this after a test failure, you're trying to
        // perform a full test of everything ("integration" - probably in CI)
        // but the test runner is not configured to provide coverage of
        // `cfg(tokio_unstable)` gated code.
        //
        // Make your integration test runner compile in `cfg(tokio_unstable)`
        // code to make this failure go away, and get full test coverage.
        if std::env::var("TEST_INTEGRATION").is_ok() {
            panic!(/* ... */);
        }
    }
```

**「テストされていないこと」を検出するテスト。** 統合テストのつもりで走らせているのに、条件コンパイルで無効化されたコードを一切踏んでいないなら失敗する。コメントが「これを読んでいるということは失敗したということ」から始まっていて、直し方まで書いてある。

## なぜそうなっているか

- **観測者を系の外に置くのは、監視の基本原則。** ランタイムの中に計測タスクを置くと、詰まったときに計測自体が止まる。「メトリクスが来なくなった」で詰まりを推測することはできるが、プロセスの死やネットワークの問題と区別できない。**OS スレッドは tokio のスケジューラに依存しない** ので、詰まっている最中でも記録できる。
- **ping/pong の往復時間を測るのは、CPU 使用率では見えないものを見るため。** スケジューリング遅延は、ワーカー数・タスクの粒度・`await` の入れ方で決まる。CPU が余っていても遅延することはあるし、逆もある。**知りたいのは「タスクが実行されるまでの待ち時間」そのもの** なので、それを直接測る。
- **「詰まりの回数」と「詰まりの長さ」を分けているのは、症状が違うから。** 1 秒の詰まりが 100 回 (タスクの粒度が大きい) と、100 秒の詰まりが 1 回 (デッドロックやブロッキング呼び出し) は、原因も対処も違う。回数はカウンタ、長さはヒストグラムに入る。
- **`blocking_recv` で回復を待つのは、詰まっている間の ping が無意味だから。** 詰まっている最中に ping を送り続けても、返ってくるのは全部同じ「詰まりが終わった瞬間」になる。回数を水増しするだけなので、1 回の詰まりは 1 回として数える。
- **100 ms という値は、人間が体感するレイテンシの境界に近い。** これより短い遅延は、HTTP のレイテンシに埋もれる。これより長い遅延は、ユーザーに見える。専用エグゼキュータの用途 (クエリの実行) を考えると、妥当な線に見える。
- **`assert!` で設定を弾くのは、この仕組み自体が害になりうるから。** 監視のために立てたスレッドがビジーループすると、監視対象を詰まらせる原因になる。**監視が対象に与える影響を、設定の段階で潰している。**

## どう活かすか

- **系の健全性を測る観測者は、その系の外に置く。** 非同期ランタイムの詰まりは同じランタイムからは測れない。GC のあるランタイムでの停止時間、シングルスレッドのイベントループ、スレッドプールの飽和にも、同じ形が使える。
- 測りたいのが「待ち時間」なら、**ほぼ何もしない仕事を投げて往復時間を測る**。CPU 使用率やキュー長は代理指標にすぎない。往復時間は、利用者が実際に被る遅延に最も近い。
- 異常は **「発生回数」と「継続時間」を別々に記録する**。回数だけだと 1 回の長い異常を見逃し、時間だけだと短い異常の頻発を見逃す。
- 異常の検出と回復を、**対になるログとして出す**。回復側に継続時間を入れておけば、後からログを追うだけで区間が分かる。
- 正常時の値も **記録し続ける**。異常時だけ記録すると、「普段はどうだったか」が分からず、劣化の傾向が見えない。
- 監視の仕組みそのものが対象に負荷をかけうるなら、**その設定を assert で弾く**。「設定次第で害になる」は、実行時に気づけない種類の問題になりやすい。
- 条件コンパイルで無効化されるコードには、**「テストされていないこと」を検出するテスト** を置く。CI の設定ミスは、テストが「通っている」形で現れるので気づけない。
- 別スレッドを立てるライブラリには、**そのスレッドで初期化を挟むフック** を用意する。thread local を使うテスト用の仕組み (ログ捕捉、トレース) が、そこでしか登録できない。
