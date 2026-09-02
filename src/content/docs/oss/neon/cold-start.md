---
title: "コールドスタート — 接続を待たせて compute を起こす"
description: "サーバーレスなので compute は普段止まっている。接続が来たら起こすが、起きるまで数秒かかる。proxy はその間クライアントを待たせ、キャッシュが古かった場合に備えてリトライの階段を持っている。"
group: "proxy"
sidebar:
  order: 52
---

## 何を学んだか

Neon の compute は、アイドルになると停止する。次の接続が来たときに起動する。

**クライアントから見ると、これは「接続が遅い」としか見えない。** タイムアウトしてはいけないし、エラーを返してもいけない。proxy は接続を保持したまま、compute が起きるのを待つ。

そのための呼び出しが `wake_compute` だ。

```rust title="proxy/src/proxy/wake_compute.rs"
pub(crate) trait WakeComputeBackend {
    async fn wake_compute(&self, ctx: &RequestContext) -> Result<CachedNodeInfo, WakeComputeError>;
}
```

([proxy/src/proxy/wake_compute.rs L25](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/proxy/wake_compute.rs#L25))

**戻り値が `CachedNodeInfo`。** 「起こした結果」ではなく「接続先の情報」で、しかもキャッシュされているかもしれない。

## キャッシュされた情報は古いかもしれない

`connect_to_compute` の構造が、この問題への対処になっている。

```rust title="proxy/src/proxy/connect_compute.rs"
    let node_info =
        wake_compute(&mut num_retries, ctx, user_info, wake_compute_retry_config).await?;

    // try once
    let err = match mechanism.connect_once(ctx, &node_info, compute).await {
        Ok(res) => {
            ctx.success();
            /* メトリクス */
            return Ok(res);
        }
        Err(e) => e,
    };
```

([proxy/src/proxy/connect_compute.rs L113](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/proxy/connect_compute.rs#L113))

**まず 1 回だけ試す。** そして失敗したら、なぜ失敗したかを考える。

```rust title="proxy/src/proxy/connect_compute.rs"
    let node_info = if !node_info.cached() || !err.should_retry_wake_compute() {
        // If we just received this from cplane and not from the cache, we shouldn't retry.
        // Do not need to retrieve a new node_info, just return the old one.
        if !should_retry(&err, num_retries, compute.retry) {
            /* メトリクス */
            return Err(err);
        }
        node_info
    } else {
        // if we failed to connect, it's likely that the compute node was suspended, wake a new compute node
        debug!("compute node's state has likely changed; requesting a wake-up");
        invalidate_cache(node_info);
        // TODO: increment num_retries?
        wake_compute(&mut num_retries, ctx, user_info, wake_compute_retry_config).await?
    };
```

([proxy/src/proxy/connect_compute.rs L135](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/proxy/connect_compute.rs#L135))

**2 つの条件の組み合わせで分岐する。**

| 情報の出所             | エラーの種類               | 対処                                                 |
| ---------------------- | -------------------------- | ---------------------------------------------------- |
| キャッシュ             | 接続先が変わった可能性あり | **キャッシュを無効化して、control plane に聞き直す** |
| キャッシュ             | それ以外                   | 同じ情報でリトライ                                   |
| control plane (直取得) | 何でも                     | 同じ情報でリトライ                                   |

**「たった今 control plane から取ったなら、聞き直しても同じ答えが返る」。** だから聞き直さない。無駄な API 呼び出しを避けている。

`invalidate_cache` にはログが仕込まれている。

```rust title="proxy/src/proxy/connect_compute.rs"
/// If we couldn't connect, a cached connection info might be to blame
/// (e.g. the compute node's address might've changed at the wrong time).
/// Invalidate the cache entry (if any) to prevent subsequent errors.
pub(crate) fn invalidate_cache(node_info: CachedNodeInfo) -> NodeInfo {
    let is_cached = node_info.cached();
    if is_cached {
        warn!("invalidating stalled compute node info cache entry");
    }
    let label = if is_cached {
        ConnectionFailureKind::ComputeCached
    } else {
        ConnectionFailureKind::ComputeUncached
    };
    Metrics::get().proxy.connection_failures_total.inc(label);
```

([proxy/src/proxy/connect_compute.rs L17](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/proxy/connect_compute.rs#L17))

**接続失敗を「キャッシュ由来」と「非キャッシュ由来」に分けて数える。** 前者が多ければキャッシュの TTL が長すぎる。後者が多ければ compute 側の問題。**同じ症状の原因を切り分けられるようにラベルを付けている。**

## リトライの判定を型に持たせる

```rust title="proxy/src/proxy/retry.rs"
use crate::proxy::retry::{ShouldRetryWakeCompute, retry_after, should_retry};
```

判定が 2 つある。

- `should_retry(&err, num_retries, config)` — そもそもリトライすべきか
- `err.should_retry_wake_compute()` — **compute を起こし直すべきか**

**「リトライする」と「情報を取り直す」は別の判断。** 接続拒否ならリトライで直るかもしれないが、DNS が引けないなら情報が古い。

エラー型にこのメソッドが生えていることで、**新しいエラーを追加したときに分類を強制される。**

## ログレベルをエラーの種類で変える

```rust title="proxy/src/proxy/wake_compute.rs"
// Use macro to retain original callsite.
macro_rules! log_wake_compute_error {
    (error = ?$error:expr, $num_retries:expr, retriable = $retriable:literal) => {
        match $error {
            WakeComputeError::ControlPlane(ControlPlaneError::Message(_)) => {
                info!(error = ?$error, num_retries = $num_retries, retriable = $retriable, "couldn't wake compute node")
            }
            _ => error!(error = ?$error, num_retries = $num_retries, retriable = $retriable, "couldn't wake compute node"),
        }
    };
}
```

([proxy/src/proxy/wake_compute.rs L14](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/proxy/wake_compute.rs#L14))

**control plane が「メッセージ付きのエラー」を返した場合は `info!`、それ以外は `error!`。**

前者は「クォータ超過」「プロジェクトが削除された」のような、**ユーザー起因で正常な失敗**だ。後者は「control plane が落ちている」のような、**システムの問題**になる。

同じ「compute を起こせなかった」でも、片方はアラートに値し、片方はしない。**ログレベルの選択が、エラーの分類そのものになっている。**

そしてマクロにしている理由が書かれている — **「呼び出し元の位置情報を保つため」。** 関数にすると、`tracing` が記録するファイル名と行番号がその関数の中になる。

## リトライ回数もメトリクスになる

```rust title="proxy/src/proxy/wake_compute.rs"
                Metrics::get().proxy.retries_metric.observe(
                    RetriesMetricGroup {
                        outcome: ConnectOutcome::Success,
                        retry_type: RetryType::WakeCompute,
                    },
                    (*num_retries).into(),
                );
```

**成功したときも失敗したときも、リトライ回数をヒストグラムに入れる。**

「成功したが 5 回リトライした」は、成功として数えるだけでは見えない。**成功の質を測る**ためのメトリクスになっている。

`retry_type` で `WakeCompute` と `ConnectToCompute` を分けているので、**どちらの段階が不安定かが分かる。**

## 正直なコメント

```rust title="proxy/src/proxy/wake_compute.rs"
                // TODO: is this necessary? We have a metric.
                // TODO: this log line is misleading as "wake_compute" might return cached (and stale) info.
                info!(?num_retries, "compute node woken up after");
```

**「このログは要るか? メトリクスがあるのに」「そしてこのログは誤解を招く。実際には起こしていないかもしれない」。**

`wake_compute` という名前が、実際の動作 (キャッシュを返すかもしれない) と合っていない。名前が嘘をついているとログも嘘をつく、という連鎖が指摘されている。

`invalidate_cache` の呼び出し後にも TODO がある。

```rust
        // TODO: increment num_retries?
```

**リトライ回数の数え方が曖昧なことを認めている。** メトリクスの意味が微妙にずれる可能性がある、という自覚。

## 接続の同時実行を絞る

```rust title="proxy/src/proxy/connect_compute.rs"
struct TcpMechanism<'a> {
    /// connect_to_compute concurrency lock
    locks: &'a ApiLocks<Host>,
    tls: TlsNegotiation,
}
```

([proxy/src/proxy/connect_compute.rs L45](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/proxy/connect_compute.rs#L45))

**ホストごとの同時接続数に上限がある。** 起動直後の compute に大量の接続が殺到すると、起動そのものが遅くなる。

`ApiLocks<Host>` は「キーごとのセマフォ」で、同じ仕組みが control plane API の呼び出しにも使われている。**外部への呼び出しは、すべて宛先ごとに流量を絞る**という方針が読める ([compute_hook](../compute-hook/) の `API_CONCURRENCY` と同じ発想だ)。

## TLS の 2 通り

```rust title="proxy/src/proxy/connect_compute.rs"
pub enum TlsNegotiation {
    /// TLS is assumed
    Direct,
    /// We must ask for TLS using the postgres SSLRequest message
    Postgres,
}
```

([proxy/src/proxy/connect_compute.rs L51](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/proxy/connect_compute.rs#L51))

[pqproto](../pqproto/) で見た direct TLS が、compute への接続側にも現れる。**proxy はクライアント側でも compute 側でも、2 通りの TLS 開始方法を扱う。**

## この先に効いてくること

- **まず 1 回試して、失敗の理由で次の手を決める。** キャッシュ由来かどうかで分岐。
- **「リトライする」と「情報を取り直す」は別の判断。** エラー型にメソッドとして持たせる。
- **ログレベルの選択がエラーの分類になる。** ユーザー起因は info、システム起因は error。
- **成功したときのリトライ回数も測る。** 成功の質が見える。
- **外部への呼び出しは宛先ごとに流量を絞る。**
