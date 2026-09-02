---
title: "compute_hook — 接続先を切り替える"
description: "shard の配置が変わったら、compute に新しい接続先を教えなければならない。相手は自分たちが所有していない control plane で、応答は 8 通りに分類され、そして「永続化したがまだ適用していない」という半端な成功がある。"
group: "storage_controller"
sidebar:
  order: 48
---

## 何を学んだか

shard を別の pageserver に移したら、compute の接続先を変える必要がある ([reconciler](../reconciler/))。

しかし **storage_controller は compute を直接知らない。** compute を起動しているのは control plane で、それは OSS ではない別のシステムだ。

だから通知は HTTP の呼び出しになる。

```rust title="storage_controller/src/compute_hook.rs"
/// The trait which define the handler-specific types and methods.
/// We have two implementations of this trait so far:
/// - [`ComputeHookTenant`] for tenant attach notifications ("/notify-attach")
/// - [`ComputeHookTimeline`] for safekeeper change notifications ("/notify-safekeepers")
trait ApiMethod {
```

([storage_controller/src/compute_hook.rs L77](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/compute_hook.rs#L77))

**通知は 2 種類ある。** pageserver の配置変更と、safekeeper の構成変更 ([メンバーを入れ替える](../pull-timeline/))。両方が同じ枠組みに乗っている。

## 応答を 8 通りに分類する

```rust title="storage_controller/src/compute_hook.rs"
pub(crate) enum NotifyError {
    // Request was not send successfully, e.g. transport error
    Request(#[from] reqwest::Error),
    // Request could not be serviced right now due to ongoing Operation in control plane, but should be possible soon.
    Busy,
    // Explicit 429 response asking us to retry less frequently
    SlowDown,
    // A 503 response indicates the control plane can't handle the request right now
    Unavailable(StatusCode),
    // API returned unexpected non-success status.  We will retry, but log a warning.
    Unexpected(StatusCode),
    // We shutdown while sending
    ShuttingDown,
    // A response indicates we will never succeed, such as 400 or 403
    Fatal(StatusCode),

    NeonLocal(anyhow::Error),
}
```

([storage_controller/src/compute_hook.rs L362](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/compute_hook.rs#L362))

**「リトライしていいか」「どのくらい待つべきか」が、バリアントごとに違う。**

| バリアント          | 意味                           | 対処                         |
| ------------------- | ------------------------------ | ---------------------------- |
| `Request`           | 送れなかった                   | 再送                         |
| `Busy`              | 今は処理できないが、すぐできる | すぐ再送                     |
| `SlowDown` (429)    | 頻度を落とせ                   | `SLOWDOWN_DELAY` (5 秒) 待つ |
| `Unavailable` (503) | 今は無理                       | バックオフして再送           |
| `Unexpected`        | 想定外のステータス             | 再送するが警告を出す         |
| `Fatal` (400/403)   | 永遠に成功しない               | **諦める**                   |

**`Unexpected` と `Fatal` の区別が要点だ。** 知らないステータスコードが返ってきたとき、それが一時的なのか永続的なのかは分からない。デフォルトを「再送するが警告」にしている。**知らないものは、安全側 (再送) に倒しつつ、人間に見せる。**

`Fatal` は明示的に列挙されたステータスだけ。**「諦める」は保守的に扱う。**

## 423 — 永続化したが適用していない

```rust title="storage_controller/src/compute_hook.rs"
/// Represents our knowledge of the compute's state: we can update this when we get a
/// response from a notify API call, which tells us what has been applied.
///
/// Should be wrapped in an Option<>, as we cannot always know the remote state.
struct ComputeRemoteState<R> {
    // The request body which was acked by the compute
    request: R,

    // Whether the cplane indicated that the state was applied to running computes, or just
    // persisted.  In the Neon control plane, this is the difference between a 423 response (meaning
    // persisted but not applied), and a 2xx response (both persisted and applied)
    applied: bool,
}
```

([storage_controller/src/compute_hook.rs L60](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/compute_hook.rs#L60))

**HTTP 423 (Locked) を「永続化はしたが、動いている compute には適用していない」の意味で使っている。**

control plane 側で他の操作 (compute の再起動など) が進行中だと、設定は保存できても反映できない。

これは**成功でも失敗でもない第 3 の応答**だ。

- 失敗として扱うと、再送を繰り返すことになる。しかし設定は既に保存されている
- 成功として扱うと、compute がまだ古い接続先を使っていることを見落とす

だから `applied: bool` として記録する。**「相手がどこまでやったか」を型で持つ。**

そして `Option` で包まれている理由も明記されている — 「相手の状態を常に知れるわけではない」。[期待状態はどこにあるか](../controller-model/) の観測状態と同じ 3 値の構造がここにもある。

## 送信の合体

```rust title="storage_controller/src/compute_hook.rs"
    // Must hold this lock to send a notification.  The contents represent
    // the last successfully sent notification, and are used to coalesce multiple
    // updates by only sending when there is a chance since our last successful send.
    send_lock: Arc<tokio::sync::Mutex<Option<ComputeRemoteTenantState>>>,
```

([storage_controller/src/compute_hook.rs L53](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/compute_hook.rs#L53))

**ロックの中に「最後に送った内容」が入っている。** ロックを取るということは「送信権を得る」ということで、その中身が「前回何を送ったか」になる。

これで 2 つのことが同時に実現される。

1. **同じ tenant への通知が並行しない** (順序が保たれる)
2. **前回と同じ内容なら送らない** (無駄な通知を消す)

shard を 8 個持つ tenant で、8 個全部が移動したとする。素朴に実装すると 8 回通知が飛ぶ。しかし通知の内容は「全 shard の配置一覧」なので、**最後の 1 回だけ送れば十分**だ。

ロック順序にも注意書きがある。

```rust title="storage_controller/src/compute_hook.rs"
                // Lock order: this _must_ be only a try_lock, because we are called inside of the [`ComputeHook::timelines`] lock.
                let Ok(locked) = self.send_lock.clone().try_lock_owned() else {
                    return MaybeSendResult::AwaitLock((ttid, self.send_lock.clone()));
                };
```

([storage_controller/src/compute_hook.rs L270](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/compute_hook.rs#L270))

**外側のロックを持っている間は、内側のロックを `try_lock` でしか取らない。** 取れなければ「このロックを待ってから呼び直せ」という値を返す。

```rust title="storage_controller/src/compute_hook.rs"
enum MaybeSendResult<R, K> {
    // Please send this request while holding the lock, and if you succeed then write
    // the request into the lock.
    Transmit(
```

**「ロックを持ったまま送って、成功したらロックの中に書け」という指示を、戻り値として返す。**

呼び出し側と実装側で責務を分けて、**ロックを持ったまま await しない**構造を作っている。デッドロックを型と戻り値の設計で回避する手口になっている。

## unsharded と sharded を型で分ける

```rust title="storage_controller/src/compute_hook.rs"
enum ComputeHookTenant {
    Unsharded(UnshardedComputeHookTenant),
    Sharded(ShardedComputeHookTenant),
}
```

([storage_controller/src/compute_hook.rs L104](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/compute_hook.rs#L104))

`UnshardedComputeHookTenant` は `node_id` を 1 つ持ち、`ShardedComputeHookTenant` は `shards: Vec<(ShardNumber, NodeId)>` と `stripe_size` を持つ。

**sharded の通知は「全 shard が揃うまで送れない」。** 一部の shard の配置しか分からない状態で通知すると、compute は不完全な shard map を持つことになる。

unsharded にはその制約がない。型で分けることで、**「揃うまで待つ」ロジックが sharded 側にしか存在しない**ようにしている。

## 並行度と速度制限

```rust title="storage_controller/src/compute_hook.rs"
const SLOWDOWN_DELAY: Duration = Duration::from_secs(5);

const NOTIFY_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) const API_CONCURRENCY: usize = 32;
```

([storage_controller/src/compute_hook.rs L29](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/compute_hook.rs#L29))

**同時に 32 本まで。** pageserver が 1 台落ちると、そこに載っていた数千の tenant が一斉に移行する。全部の通知を同時に投げたら control plane が落ちる。

**自分が引き起こした障害対応で、隣のシステムを倒さない。** 障害時にこそ流量制限が要る、という原則がここにある。

## ローカル実装が並んでいる

```rust title="storage_controller/src/compute_hook.rs"
    async fn notify_local(
        env: &LocalEnv,
        cplane: &ComputeControlPlane,
        req: &Self::Request,
    ) -> Result<(), NotifyError>;
```

本番の control plane に加えて、`neon_local` (テスト用のローカル制御プレーン) 向けの実装がトレイトのメソッドとして並んでいる。

```rust title="storage_controller/src/compute_hook.rs"
        for (endpoint_name, endpoint) in &cplane.endpoints {
            if endpoint.tenant_id == *tenant_id
                && endpoint.timeline_id == *timeline_id
                && endpoint.status() == EndpointStatus::Running
            {
                tracing::info!("Reconfiguring safekeepers for endpoint {endpoint_name}");
```

([storage_controller/src/compute_hook.rs L308](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/compute_hook.rs#L308))

**OSS でない依存先を持つコンポーネントは、テストのために代替実装を持つ。** そしてそれが `#[cfg(test)]` ではなく通常のコードとして存在する。統合テスト (`test_runner`) から使うためだ ([test_runner — 何をどこでテストするか](../test-runner/))。

## この先に効いてくること

- **応答の分類が、リトライ戦略そのものになる。** 知らないものは安全側に倒しつつ警告する。
- **「永続化したが適用していない」という第 3 の応答を型で持つ。**
- **ロックの中に「最後に送った内容」を入れると、送信権と重複排除が同時に得られる。**
- **ロックを持ったまま await しない構造を、戻り値の設計で作る。**
- **障害時にこそ流量制限が要る。** 自分の障害対応で隣を倒さない。
