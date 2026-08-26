---
title: "停止の順序を「トークンを配って、全員の完了を待ってから次を止める」で表し、完了通知を Drop で保証する"
description: "InfluxDB 3 のシャットダウンは、フロントエンド (HTTP/gRPC) とバックエンド (WAL、カタログ、保持期間) の 2 つのキャンセルトークンでできている。バックエンドの各コンポーネントは名前付きのトークンを受け取り、後始末が終わったら完了を返す。全員が返ってから初めてフロントエンドが止まる。完了通知は ShutdownToken の Drop でも送られるので、コンポーネントが途中で落ちてもプロセスがハングしない。"
sidebar:
  order: 14
---

## 何を学んだか

### どんな状況の話か

`SIGTERM` を受けたとき、InfluxDB 3 がやるべきことには順序がある。

[WAL](../wal-object-store/) のメモリバッファには、まだオブジェクトストアに書かれていない書き込みが最大 1 秒ぶん溜まっている。それを書き出す前に HTTP サーバーを止めてしまうと、`write_ops` を待っているクライアントの接続が切れ、成功も失敗も返らない。逆に HTTP を止めずに WAL だけ止めると、新しい書き込みが受け付けられて行き場を失う。

正しい順序は「バックエンドを止め、その後始末が終わってからフロントエンドを止める」。しかもバックエンドのコンポーネントは複数あり (WAL、カタログ、保持期間の処理、削除の処理)、それぞれ後始末の内容も時間も違う。

さらに、シャットダウンの起点は `SIGTERM` だけではない。[同じ node-id の別プロセスに WAL を上書きされた](../wal-object-store/) ときのように、**バックエンドの側から停止を要求する** 経路もある。

### InfluxDB 3 の答え

1. **キャンセルトークンを 2 つ持つ。** `backend_shutdown` と `frontend_shutdown`。順序はこの 2 つの関係として表現される。
2. **コンポーネントは名前付きで登録し、`ShutdownToken` を受け取る。** 名前は `&'static str` で、`"catalog"`、`"write_buffer"` のように起動時に決まる。
3. **`join()` はバックエンド全員の完了を待ってから、フロントエンドのトークンをキャンセルする。** 待ちには tokio の `TaskTracker` を使う。
4. **待っている間、5 秒ごとに「まだ終わっていないコンポーネント」の名前を出す。** 停止が遅いときに、どれが遅いかがログで分かる。
5. **完了通知は `Drop` でも送られる。** コンポーネントが panic しても、トークンが drop されれば完了が通知され、プロセスはハングしない。
6. **どのコンポーネントも停止を起動できる。** `ShutdownToken::trigger_shutdown()` は自分の後始末ではなく **プロセス全体の停止** を起こす。
7. **メインループは `select!` で 3 つの終わり方を待つ。** シグナル、バックエンドの終了、フロントエンドの終了。「バックエンドがフロントエンドより先に終わった」場合はエラーとして記録する。

## ソースコードのどこか

### 何のためのクレートか

[`influxdb3_shutdown/src/lib.rs#L1-L16`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_shutdown/src/lib.rs#L1-L16)。630 行 (うちテスト 238 行) の小さなクレートで、冒頭に目的が書いてある。

```rust title="influxdb3_shutdown/src/lib.rs"
//! # Coordinate shutdown with the [`ShutdownManager`] type
//!
//! The [`ShutdownManager`] is used to coordinate shutdown of the process in an ordered fashion.
//! When a shutdown is signaled externally, e.g., `ctrl+c`, or internally by some error state, then
//! there may be processes running on the backend that need to be gracefully stopped before the
//! HTTP/gRPC frontend. For example, if the WAL has writes buffered, it needs to flush the buffer to
//! object store and respond to the write request before the HTTP/gRPC frontend is taken down.
```

**具体例が 1 つ挙がっている** のがよい。「WAL にバッファがあるなら、フロントエンドを落とす前に書き出して応答を返す必要がある」。抽象的な「順序付きシャットダウン」ではなく、この 1 例のために作られたことが分かる。

### 状態

[`#L56-L66`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_shutdown/src/lib.rs#L56-L66)。

```rust title="influxdb3_shutdown/src/lib.rs"
#[derive(Debug, Clone)]
pub struct ShutdownManager {
    frontend_shutdown: CancellationToken,
    backend_shutdown: CancellationToken,
    tasks: TaskTracker,
    next_id: Arc<AtomicUsize>,
    pending: Arc<Mutex<Vec<(&'static str, usize)>>>,
    shutdown_started_at: Arc<Mutex<Option<Instant>>>,
}
```

`frontend_shutdown` は **外から渡される**。HTTP サーバーは `ShutdownManager` を知らず、単に `CancellationToken` を待つ。**依存が一方向** で、フロントエンド側はこの仕組みの存在を知らなくてよい。

`pending` はコンポーネント名と ID の一覧で、ログ出力専用。ID を持つのは、同じ名前で 2 回登録されたときに片方だけを消せるようにするため。

### 登録

[`#L98-L118`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_shutdown/src/lib.rs#L98-L118)。

```rust title="influxdb3_shutdown/src/lib.rs"
    /// Register a task that needs to perform work before the process may exit
    ///
    /// Provides a [`ShutdownToken`] which the caller is responsible for handling. The caller must
    /// invoke [`complete`][ShutdownToken::complete] in order for process shutdown to succeed.
    pub fn register(&self, name: &'static str) -> ShutdownToken {
        let (tx, rx) = oneshot::channel();
        self.tasks.spawn(rx);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().push((name, id));
```

`self.tasks.spawn(rx)` が巧い。`TaskTracker` に登録するのは **コンポーネントの処理そのものではなく、oneshot の受信側**。トラッカーは「全部のタスクが終わるまで待つ」を提供するので、それがそのまま「全コンポーネントが完了を報告するまで待つ」になる。コンポーネント側は自分のタスクをどう構成してもよい。

登録は起動時に行われる ([`influxdb3/src/commands/serve.rs`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3/src/commands/serve.rs#L1003))。

```rust title="influxdb3/src/commands/serve.rs"
        shutdown_manager.register("catalog"),
        /* ... */
    let retention_handler_token = shutdown_manager.register("retention_handler");
        /* ... */
        shutdown: shutdown_manager.register("write_buffer"),
        /* ... */
        shutdown_manager.register("delete_manager"),
```

### 待つ

[`#L118-L146`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_shutdown/src/lib.rs#L118-L146)。

```rust title="influxdb3_shutdown/src/lib.rs"
    pub async fn join(&self) {
        self.tasks.close();
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = self.tasks.wait() => break,
                _ = ticker.tick() => {
                    let elapsed = self.shutdown_started_at.lock()
                        .as_ref().map(|t| t.elapsed());
                    if let Some(elapsed) = elapsed {
                        let pending = self.pending_components();
                        if !pending.is_empty() {
                            info!(
                                count = pending.len(),
                                ?pending,
                                ?elapsed,
                                "waiting for components to complete shutdown"
                            );
                        }
                    }
                }
            }
        }
        self.frontend_shutdown.cancel();
    }
```

**待つだけでなく、待っていることを報告する。** 5 秒ごとに「まだ終わっていないのはこれ、経過はこれだけ」を出す。停止が終わらないとき、どのコンポーネントが原因かが分かる。`ticker.tick().await` を最初に 1 回捨てているのは、tokio の `interval` が即座に 1 回目を返すから。

最後の `frontend_shutdown.cancel()` が **順序そのもの**。この 1 行の位置が「バックエンドが全部終わってからフロントエンド」を表している。

### 完了は Drop でも送る

[`#L231-L262`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_shutdown/src/lib.rs#L231-L262)。

```rust title="influxdb3_shutdown/src/lib.rs"
    /// # Implementation Note
    ///
    /// It is not required that registered components invoke this method, as the `ShutdownToken`
    /// type invokes this method on `Drop`.
    pub fn complete(&self) {
        if let Some(s) = self.complete_tx.lock().take() {
```

```rust title="influxdb3_shutdown/src/lib.rs"
/// `ShutdownToken` implements `Drop` such that the completion signal is guaranteed to be sent
/// to the `ShutdownManager`. This will prevent application hang on shutdown in the event that a
/// registered component fails before signaling completion.
impl Drop for ShutdownToken {
    fn drop(&mut self) {
        self.complete();
    }
}
```

**この 5 行が、この設計で最も価値がある部分だ。** 「全員の完了を待つ」形の停止処理は、1 つでも報告しないコンポーネントがあると永久に止まらなくなる。panic した、早期 return した、`complete()` を書き忘れた。どれも起こりうる。

`Drop` で送るようにすれば、**トークンが生きている限り待ち、死んだら完了とみなす** という不変条件になる。所有権が「まだ後始末中である」ことの表現になっている。`complete_tx` が `Mutex<Option<_>>` なのは、明示的な `complete()` と `Drop` の両方から呼ばれても 1 回しか送らないようにするため。

`ShutdownToken` が `Clone` でないことも明記されている。

```rust title="influxdb3_shutdown/src/lib.rs"
/// This does not implement `Clone` because there should only be a single instance of a given
/// `ShutdownToken`. If you just need a copy of the `CancellationToken` for invoking shutdown, use
/// [`ShutdownToken::clone_cancellation_token`].
```

クローンできたら「全員が drop したら完了」になり、意味が変わる。**クローンできる部分 (停止を要求する権限) とできない部分 (完了を報告する義務) を、別の型に分けている。**

### どこからでも停止を起こせる

```rust title="influxdb3_shutdown/src/lib.rs"
    /// Trigger application shutdown due to some unrecoverable state
    pub fn trigger_shutdown(&self) {
        self.shutdown_started_at
            .lock()
            .get_or_insert(Instant::now());
        self.token.cancel();
    }
```

`get_or_insert` で開始時刻を **最初の 1 回だけ** 記録する。複数のコンポーネントが同時に停止を要求しても、経過時間の基準はぶれない。

### メインループ

[`influxdb3/src/commands/serve.rs#L1400-L1470`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3/src/commands/serve.rs#L1400-L1470)。

```rust title="influxdb3/src/commands/serve.rs"
    while !frontend.is_terminated() {
        futures::select! {
            // External shutdown signal, e.g., `ctrl+c`
            _ = signal => info!("shutdown requested"),
            // `join` on the `ShutdownManager` has completed
            _ = backend => {
                // If something stops the process on the backend the frontend shutdown should have
                // been signaled in which case we can break the loop here once checking that it
                // has been cancelled.
                /* ... */
                if frontend_shutdown.is_cancelled() {
                    break;
                }
                error!("backend shutdown before frontend");
                res = res.and(Err(Error::LostBackend));
            }
```

**「バックエンドがフロントエンドより先に終わった」を異常として検出する。** 正常な停止では、バックエンドの完了がフロントエンドのキャンセルを引き起こすので、`frontend_shutdown.is_cancelled()` が真になっている。そうでないなら、バックエンドが勝手に死んだということ。終了コードに反映される。

ループを抜けた後の後始末も明示的だ。

```rust title="influxdb3/src/commands/serve.rs"
    // ensure that the frontend has fully terminated so we dont close the connection on any clients
    if !frontend.is_terminated() {
        res = res.and(frontend.await.map_err(Error::Server));
    }
    info!("frontend shutdown completed");

    if !backend.is_terminated() {
        backend.await;
    }
    info!("backend shutdown completed");
```

`select!` はどれか 1 つで返るので、残りを明示的に待つ。コメントの "so we dont close the connection on any clients" が、この待ちの目的を説明している。

### 長い処理を中断する

同じクレートに `AbortableTaskRunner` がある ([`#L275-L340`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_shutdown/src/lib.rs#L275-L340))。

```rust title="influxdb3_shutdown/src/lib.rs"
/// This type aborts a long running future immediately (based on the `check_interval`) by
/// running it in the background and checking if token has received a cancellation signal.
pub struct AbortableTaskRunner<F> {
    task: F,
    time_provider: Arc<dyn TimeProvider>,
    check_interval: Duration,
    cancellation_token: CancellationToken,
}
```

キャンセルに協力しない future (`select!` でトークンを見ていないもの) を、外から止めるための道具。タスクと監視役の 2 つを spawn し、監視役が定期的にトークンを見て `abort()` する。エラーの種類を `Aborted` / `Panicked` / `Other` に分けているのは、**呼び出し側がログの出し分けをできるように** するため。

## なぜそうなっているか

- **`Drop` での完了通知は、仕組みを入れた直後に足されている。** コミット eda2fc9b21 (2025-03) "refactor: ensure shutdown complete via Drop impl (#26202)" が入ったのは、`ShutdownManager` を導入した 9401137825 (#26197) と同じ日 (2025-03-31)。**「全員の完了を待つ」を実装したその日のうちに、「待ち続けてしまう」経路を塞いでいる。** この形の停止処理を書いたら、次に考えるべきは「報告されなかったらどうなるか」だと分かる。
- **フロントエンドに `CancellationToken` だけを渡すのは、依存の向きを保つため。** HTTP サーバーが `ShutdownManager` を知っていると、テストのたびにマネージャを組み立てることになるし、フロントエンドがバックエンドの都合を知ることになる。トークン 1 個なら、待つ側は何も知らなくてよい。
- **「バックエンドが先に終わったらエラー」は、静かな死を防ぐ。** バックエンドのタスクが例外で終わったとき、フロントエンドは動き続ける。書き込みは受け付けるが永続化されない、という最悪の状態になりうる。それを検出して終了コードに出す。
- **待っている間のログは、運用で効く。** Kubernetes の `terminationGracePeriodSeconds` を超えると `SIGKILL` される。そのときログに「`write_buffer` を 25 秒待っている」と出ていれば、原因が特定できる。**停止が遅いことは、停止しないことより気づきにくい。**
- **`&'static str` で名前を持つのは、登録が起動時に完結するから。** 動的に増えるコンポーネントは想定していない。文字列の所有やライフタイムを考えずに済み、ログにもそのまま出せる。

## どう活かすか

- 停止の順序が要るなら、**順序を「トークンの依存関係」として表す**。「A が全部終わったら B をキャンセルする」を 1 か所に書けば、順序がコードの形になる。
- 「全員の完了を待つ」形の処理には、**必ず「報告されなかったとき」の逃げ道** を作る。Rust なら `Drop`、他の言語なら `finally` や `defer`。所有権やスコープを「まだ処理中である」の表現にする。
- **「停止を要求する権限」と「完了を報告する義務」を別の型に分ける**。前者はクローン可能、後者は 1 つだけ。混ぜると、クローンが増えるたびに待ちの意味が変わる。
- 待つ処理には **進捗のログ** を入れる。「誰を待っているか」「どれだけ経ったか」を定期的に出す。停止しないバグは再現が難しいので、ログだけが手がかりになる。
- 停止の「異常な順序」を検出して、**終了コードに反映する**。バックエンドが先に死んでフロントエンドが生き残る状態は、外形監視では正常に見えてしまう。
- `select!` で複数の終了条件を待ったら、**抜けた後に残りを明示的に待つ**。特に接続を持っているコンポーネントは、待たずに落とすとクライアント側に接続断として現れる。
- キャンセルに協力しないコードを扱う必要があるなら、**「タスクと監視役を並べて、監視役が abort する」** という形が使える。中断の理由 (キャンセルか panic か) を区別できるエラー型にしておくと、呼び出し側が扱いやすい。
