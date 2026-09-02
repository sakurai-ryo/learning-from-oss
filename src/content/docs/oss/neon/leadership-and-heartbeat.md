---
title: "リーダー交代とノード障害検知"
description: "コントローラを再起動するたびに全 pageserver を走査していては、デプロイのたびに数十秒止まる。新旧が握手して観測状態を引き継ぐ仕組みと、その握手が失敗したときの安全策。そして障害検知の 3 状態。"
group: "storage_controller"
sidebar:
  order: 47
---

## 何を学んだか

storage_controller はインメモリのシステムなので、起動時に状態を再構築する ([期待状態はどこにあるか](../controller-model/))。

```markdown title="docs/rfcs/037-storage-controller-restarts.md"
At start-up, the storage controller calls into all the pageservers it manages (retrieved from DB) to learn the
latest locations of all tenant shards present on them. This is usually fast, but can push into tens of seconds
under unfavourable circumstances: pageservers are heavily loaded or unavailable.
```

([docs/rfcs/037-storage-controller-restarts.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/docs/rfcs/037-storage-controller-restarts.md))

**デプロイのたびに数十秒、管理 API が使えなくなる。** データパスには影響しないが、それでも許容しがたい。

## 新旧を重ねる

```markdown title="docs/rfcs/037-storage-controller-restarts.md"
At a very high level the proposed idea is to start a new storage controller instance while
the previous one is still running and cut-over to it when it becomes ready. The new instance,
should coordinate with the existing one and transition responsibility gracefully. While the controller
has built in safety against split-brain situations (via generation numbers), we'd like to avoid such
scenarios since they can lead to availability issues for tenants that underwent changes while two controllers
were operating at the same time and require operator intervention to remedy.
```

**「generation で安全性は守られているが、それでも split brain は避けたい」。**

理由が明確だ。**安全ではあるが、可用性が落ちるし、運用者の介入が要る。** 2 台のコントローラが同じ shard の配置を奪い合うと、reconcile が延々と往復する。

**「壊れないこと」と「困らないこと」は別**という認識が、この設計の出発点になっている。

## リーダーのテーブルは 1 行

```markdown title="docs/rfcs/037-storage-controller-restarts.md"
This table will always contain at most one row. The proposed name for the table is `leader` and the schema
contains two elements:

- `hostname`: represents the hostname for the current storage controller leader
- `start_timestamp`: holds the start timestamp for the current storage controller leader
```

そして更新には CAS 意味論が要る。

```markdown title="docs/rfcs/037-storage-controller-restarts.md"
We want compare-and-exchange semantics for the update: avoid the
situation where two concurrent updates succeed and overwrite each other. The default Postgres isolation
level is `READ COMMITTED`, which isn't strict enough here. This update transaction should use at least `REPEATABLE
READ` isolation level in order to prevent lost updates. Currently,
the storage controller uses the stricter `SERIALIZABLE` isolation level for all transactions.
```

```sql
START TRANSACTION ISOLATION LEVEL REPEATABLE READ
UPDATE leader SET hostname=<new_hostname>, start_timestamp=<new_start_ts>
WHERE hostname=<old_hostname>, start_timestampt=<old_start_ts>;
```

**分離レベルの指定と、その根拠がリンク付きで書かれている。** `READ COMMITTED` では lost update が起きるので足りない。

これは [メンバーを入れ替える](../pull-timeline/) で safekeeper のメンバー変更が使ったのと**まったく同じ仕組み**だ。「単一キーへの CAS」を Postgres で実装する。

**合意アルゴリズムを持たないシステムが、外部の強整合ストアに単調性だけを預ける**という手口が、Neon の中で 2 回使われている。

## step down — 引き継ぎの握手

```markdown title="docs/rfcs/037-storage-controller-restarts.md"
A new HTTP endpoint should be added to the storage controller: `POST /control/v1/step_down`. Upon receiving this
request the leader cancels any pending reconciles and goes into a mode where it replies with 503 to all other APIs
and does not issue any location configurations to its pageservers. The successful HTTP response will return a serialized
snapshot of the observed state.
```

**退位の応答に、観測状態のスナップショットが乗ってくる。**

これが起動時間の問題を解く。新コントローラは pageserver に聞き回る代わりに、旧コントローラが既に持っていた状態をそのまま受け取る。

```rust title="storage_controller/src/leadership.rs"
    /// Find the current leader in the database and request it to step down if required.
    /// Should be called early on in within the start-up sequence.
    ///
    /// Returns a tuple of two optionals: the current leader and its observed state
    pub(crate) async fn step_down_current_leader(
        &self,
    ) -> Result<(Option<ControllerPersistence>, Option<GlobalObservedState>)> {
```

([storage_controller/src/leadership.rs L38](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/leadership.rs#L38))

**戻り値が `Option` の組**になっている。リーダーがいないかもしれないし、いても観測状態を渡せないかもしれない。どちらの場合も、pageserver を走査するフォールバックに落ちる。

**速い経路と遅い経路の両方を持ち、速い経路が失敗しても正しく動く。**

再起動の判定も入っている。

```rust title="storage_controller/src/leadership.rs"
        if leader.as_ref().map(|l| &l.address)
            == self.config.address_for_peers.as_ref().map(Uri::to_string).as_ref()
        {
            // We already are the current leader. This is a restart.
            return Ok((leader, None));
        }
```

**「DB 上のリーダーが自分自身なら、これは再起動」。** 自分に step down を要求しても意味がないので、素直に走査から始める。

そして冪等性も担保されている。

```markdown title="docs/rfcs/037-storage-controller-restarts.md"
If other step down requests come in after the initial one, the request is handled and the observed state is returned (required
for failure scenario handling)
```

**2 回目以降の step down も成功する。** 障害シナリオで必要になる。

`start_timestamp` がスキーマにあるのも障害対応のためだ。RFC は「新リーダーが準備完了する前に旧リーダーがクラッシュした場合」という節を持っていて、そのためだけにこのカラムがある。**「正常系には要らないが、特定の異常系のためだけにあるフィールド」**が明示されている。

## Kubernetes の設定まで含めて設計する

```markdown title="docs/rfcs/037-storage-controller-restarts.md"
On the Kubernetes configuration side, the proposal is to update the storage controller `Deployment`
to use `spec.strategy.type = RollingUpdate`, `spec.strategy.rollingUpdate.maxSurge=1` and `spec.strategy.maxUnavailable=0`.
Under the hood, Kubernetes creates a new replica set and adds one pod to it (`maxSurge=1`). The old replica set does not
scale down until the new replica set has one replica in the ready state (`maxUnavailable=0`).
```

**「新しい pod が ready になるまで、古い pod を落とさない」。**

アプリケーション側の握手だけでは足りない。**デプロイの設定が「重なる期間」を作らないと、握手する相手がいない。** RFC がインフラの設定まで含めて書かれているのは、そこが設計の一部だからだ。

「ready になる」の定義もアプリ側が決める。新コントローラは、観測状態を引き継ぎ終わってから ready を返す。

## 障害検知は 3 状態

```rust title="storage_controller/src/heartbeater.rs"
pub(crate) enum PageserverState {
    Available {
        last_seen_at: Instant,
        utilization: PageserverUtilization,
    },
    WarmingUp {
        started_at: Instant,
    },
    Offline,
}
```

([storage_controller/src/heartbeater.rs L34](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/heartbeater.rs#L34))

**`WarmingUp` が真ん中にある。** 起動直後の pageserver は応答するが、まだレイヤを読み込んでいない。「使える」と判定して shard を送り込むと遅い。

タイムアウトも 2 つある。

```rust title="storage_controller/src/heartbeater.rs"
    max_offline_interval: Duration,
    max_warming_up_interval: Duration,
```

**「応答がないと判定するまで」と「暖機中と扱い続ける上限」。** 後者を超えたら、暖機が終わっていなくても使い始める。永遠に暖機中のノードを待ち続けないための保険になっている。

`Available` に `utilization` が乗っているのも設計として効いている。**ハートビートの応答に、そのノードの負荷情報を相乗りさせる。** 死活監視と負荷収集を別々のポーリングにすると、通信が 2 倍になる。

そして scheduler がその値を使う ([シャードをどのノードに置くか](../scheduler/))。**「生きているか」と「どれだけ余裕があるか」が同じ経路で届く。**

## safekeeper も同じ型で扱う

```rust title="storage_controller/src/heartbeater.rs"
struct HeartbeaterTask<Server, State> {
```

```rust title="storage_controller/src/heartbeater.rs"
pub(crate) enum SafekeeperState {
    Available {
        last_seen_at: Instant,
        utilization: SafekeeperUtilization,
    },
    Offline,
}
```

**pageserver と safekeeper で、同じハートビート機構をジェネリクスで共有している。** ただし safekeeper には `WarmingUp` がない。WAL を受け取るのに暖機は要らないからだ。

storage_controller が safekeeper も管理するようになったのは 2025 年で、RFC にその経緯が書かれている。

```markdown title="docs/rfcs/2025-02-14-storage-controller.md"
It initially managed only pageservers, but has extended in 2025 to also manage safekeepers. In
some places you may seen unqualified references to 'nodes' -- those are pageservers.
```

**「修飾なしの `node` は pageserver のこと」。** 後から対象が増えたシステムで、命名が追いついていないことを先に断っている。

## split brain は「避ける」であって「防ぐ」ではない

```markdown title="docs/rfcs/2025-02-14-storage-controller.md"
Note that this is not a strong consensus mechanism: the controller must also survive split-brain situations. This is respected by code that
e.g. increments version numbers, which uses database transactions that
check the expected value before modifying it. A split-brain situation can
impact availability (e.g. if two controllers are fighting over where to
attach a shard), but it should never impact durability and data integrity.
```

([docs/rfcs/2025-02-14-storage-controller.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/docs/rfcs/2025-02-14-storage-controller.md))

**「これは強い合意機構ではない」と明言している。**

リーダー選出は「たいてい 1 台になる」だけで、2 台になる可能性を排除していない。排除するにはリースとフェンシングが要り、それは合意アルゴリズムを持つのと変わらない。

代わりに、**2 台になっても壊れないようにしてある。** 全部の状態更新が CAS で、generation の払い出しも DB トランザクションを通る。

**「防ぐ」を目指すと合意が要る。「壊れない」を目指せば CAS で足りる。** これは [なぜ Raft をそのまま使わなかったのか](../why-not-raft/) で見た「Magic STONITH Fairy」の議論と同じ構造をしている。Neon はこの判断を、safekeeper でも storage_controller でも同じ形で下している。

## この先に効いてくること

- **「壊れないこと」と「困らないこと」は別。** 安全でも可用性は落ちる。
- **引き継ぎは、退位の応答に状態を乗せる。** 速い経路と遅い経路の両方を持つ。
- **デプロイの設定が設計の一部。** 重なる期間がないと握手できない。
- **死活監視に負荷情報を相乗りさせる。** ポーリングを 2 系統にしない。
- **「防ぐ」ではなく「壊れない」を目標にすると、CAS で足りる。**
