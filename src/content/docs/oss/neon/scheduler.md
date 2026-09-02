---
title: "シャードをどのノードに置くか — scheduler"
description: "配置の決定を、複数の制約を並べた「スコア」の辞書順比較に還元している。制約の優先順位が構造体のフィールド宣言順で表現されていて、attached と secondary で AZ の好みが正反対になる。"
group: "storage_controller"
sidebar:
  order: 45
---

## 何を学んだか

`Scheduler` の仕事は「この shard をどのノードに置くか」を決めることだけだ。

```rust title="storage_controller/src/scheduler.rs"
/// This type is responsible for selecting which node is used when a tenant shard needs to choose a pageserver
/// on which to run.
///
/// The type has no persistent state of its own: this is all populated at startup.  The Serialize
/// impl is only for debug dumps.
pub(crate) struct Scheduler {
    nodes: HashMap<NodeId, SchedulerNode>,
}
```

([storage_controller/src/scheduler.rs L303](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/scheduler.rs#L303))

**永続状態を持たない。** ノードごとの集計だけを持ち、それは起動時に全 shard から再構築される ([期待状態はどこにあるか](../controller-model/))。

集計の中身がこうなっている。

```rust title="storage_controller/src/scheduler.rs"
pub(crate) struct SchedulerNode {
    /// How many shards are currently scheduled on this node, via their [`crate::tenant_shard::IntentState`].
    shard_count: usize,
    /// How many shards are currently attached on this node, via their [`crate::tenant_shard::IntentState`].
    attached_shard_count: usize,
    /// How many shards have a location on this node (via [`crate::tenant_shard::IntentState`]) _and_ this node
    /// is in their preferred AZ (i.e. this is their 'home' location)
    home_shard_count: usize,
    /// Availability zone id in which the node resides
    az: AvailabilityZone,

    /// Whether this node is currently elegible to have new shards scheduled (this is derived
    /// from a node's availability state and scheduling policy).
    may_schedule: MaySchedule,
}
```

([storage_controller/src/scheduler.rs L36](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/scheduler.rs#L36))

**「全 shard」「attached な shard」「home な shard」の 3 つのカウンタ。** それぞれ別の判断に使う。

## 配置の判断をスコアの辞書順に還元する

```rust title="storage_controller/src/scheduler.rs"
/// Scheduling score of a given node for shard attachments.
/// Lower scores indicate more suitable nodes.
/// Ordering is given by member declaration order (top to bottom).
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Clone, Copy)]
pub(crate) struct NodeAttachmentSchedulingScore {
    /// Flag indicating whether this node matches the preferred AZ
    /// of the shard. For equal affinity scores, nodes in the matching AZ
    /// are considered first.
    az_match: AttachmentAzMatch,
    /// The number of shards belonging to the tenant currently being
    /// scheduled that are attached to this node.
    affinity_score: AffinityScore,
    /// Utilisation score that combines shard count and disk utilisation
    utilization_score: u64,
    /// Total number of shards attached to this node. When nodes have identical utilisation, this
    /// acts as an anti-affinity between attached shards.
    total_attached_shard_count: usize,
    /// Convenience to make selection deterministic in tests and empty systems
    node_id: NodeId,
}
```

([storage_controller/src/scheduler.rs L150](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/scheduler.rs#L150))

**`#[derive(Ord)]` がフィールド宣言順の辞書順比較を生成する。** そして doc コメントがそれを明示している — "Ordering is given by member declaration order (top to bottom)"。

制約の優先順位が、こう表現される。

1. **AZ が合っているか** — 最優先
2. **同じ tenant の他の shard がいないか** — 次
3. **ノードの利用率** — その次
4. **attached shard の総数** — 同点の場合
5. **ノード ID** — 決定性のため

**「まず AZ、同じなら affinity、それも同じなら利用率」**という優先順位が、構造体のフィールドを並べるだけで書けている。比較関数を手で書く必要がない。

最後の `node_id` が効いている。

```rust
    /// Convenience to make selection deterministic in tests and empty systems
    node_id: NodeId,
```

**全部同点でも、必ず同じ答えになる。** テストが安定し、空のシステムでも予測可能になる。スコアベースの選択では、tie-break を明示しないと非決定的になる。

## AZ の好みが attached と secondary で逆になる

同じ `AzMatch` に対して、2 つの `Ord` 実装がある。

```rust title="storage_controller/src/scheduler.rs"
impl Ord for AttachmentAzMatch {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Lower scores indicate a more suitable node.
        // Note that we prefer a node for which we don't have
        // info to a node which we are certain doesn't match the
        // preferred AZ of the shard.
        let az_match_score = |az_match: &AzMatch| match az_match {
            AzMatch::Yes => 0,
            AzMatch::Unknown => 1,
            AzMatch::No => 2,
        };
```

```rust title="storage_controller/src/scheduler.rs"
impl Ord for SecondaryAzMatch {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Lower scores indicate a more suitable node.
        // For secondary locations we wish to avoid the preferred AZ
        // of the shard.
        let az_match_score = |az_match: &AzMatch| match az_match {
            AzMatch::No => 0,
            AzMatch::Unknown => 1,
            AzMatch::Yes => 2,
        };
```

([storage_controller/src/scheduler.rs L103](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/scheduler.rs#L103))

**attached は「compute と同じ AZ」を好み、secondary は「違う AZ」を好む。**

理由が明確だ。attached は compute からの `getpage@lsn` に答えるので、同じ AZ にいないとネットワークのレイテンシと転送料がかかる。secondary は AZ ごと落ちたときのためにあるので、同じ AZ にいたら意味がない。

**同じ「AZ が一致するか」という情報を、逆向きの選好で使う。** newtype (`AttachmentAzMatch` / `SecondaryAzMatch`) で包んで別の `Ord` を付ける、という Rust らしい書き方になっている。

そして 3 値の真ん中の扱いにも意図がある。

```rust
        // Note that we prefer a node for which we don't have
        // info to a node which we are certain doesn't match the
        // preferred AZ of the shard.
```

**「情報がないノード」を「確実に一致しないノード」より優先する。** 分からないなら、当たりかもしれない。これも [期待状態はどこにあるか](../controller-model/) の 3 値論理と同じで、**「不明」を「悪い」に丸めない。**

## 型パラメータで attached と secondary を分ける

```rust title="storage_controller/src/scheduler.rs"
pub(crate) trait ShardTag {
    type Score: NodeSchedulingScore;
}

pub(crate) struct AttachedShardTag {}
impl ShardTag for AttachedShardTag {
    type Score = NodeAttachmentSchedulingScore;
}

pub(crate) struct SecondaryShardTag {}
impl ShardTag for SecondaryShardTag {
    type Score = NodeSecondarySchedulingScore;
}
```

([storage_controller/src/scheduler.rs L69](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/scheduler.rs#L69))

**ゼロサイズの型タグで、スコアの種類を選ぶ。** `schedule_shard::<AttachedShardTag>()` と書けば attached 用のスコアが使われる。

引数で `is_attached: bool` を渡す実装と比べると、**間違ったスコアを渡すことが型として不可能**になる。実行時のコストもゼロ。

## affinity — 同じ tenant の shard を散らす

```rust title="storage_controller/src/scheduler.rs"
/// Score for soft constraint scheduling: lower scores are preferred to higher scores.
///
/// For example, we may set an affinity score based on the number of shards from the same
/// tenant already on a node, to implicitly prefer to balance out shards.
pub(crate) struct AffinityScore(pub(crate) usize);

impl AffinityScore {
    /// If we have no anti-affinity at all toward a node, this is its score.  It means
    /// the scheduler has a free choice amongst nodes with this score, and may pick a node
    /// based on other information such as total utilization.
    pub(crate) const FREE: Self = Self(0);
```

([storage_controller/src/scheduler.rs L313](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/scheduler.rs#L313))

**同じ tenant の shard が既に何個いるか、をそのままスコアにする。**

shard に分けた意味は「複数ノードで分担する」ことなので、全部が同じノードに載ったら無意味になる。ただし**ハード制約にはしない**。ノードが足りなければ同居してよい。

`FREE = 0` が「制約なし」を意味し、そのときは次のフィールド (利用率) で決まる。**ソフト制約を「同点なら次の基準へ」という形で表現している。**

## 最適化のときはスコアの一部を無視する

```rust title="storage_controller/src/scheduler.rs"
    /// Return a score that drops any components based on node utilization: this is useful
    /// for finding scores for scheduling optimisation, when we want to avoid rescheduling
    /// shards due to e.g. disk usage, to avoid flapping.
    fn for_optimization(&self) -> Self;
```

([storage_controller/src/scheduler.rs L60](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/scheduler.rs#L60))

**「今より良い配置を探す」ときは、利用率を無視する。**

理由は flapping (ばたつき) だ。ディスク使用量は刻々と変わる。それを理由に shard を動かすと、動かした先の使用量が増えて、また動かしたくなる。**振動する制約を、最適化の判断材料から外す。**

一方、AZ の一致と shard の同居は「動かさない限り解消しない」ので、最適化の対象として正しい。

**「新規配置の基準」と「移動の基準」は違う。** 移動にはコスト (レイヤの再ダウンロード) があるので、移動してでも直すべき問題だけを見る。

## スケジュールできない場合

```rust title="storage_controller/src/scheduler.rs"
/// Scenarios in which we cannot find a suitable location for a tenant shard
pub enum ScheduleError {
    #[error("No pageservers found")]
    NoPageservers,
    #[error("No pageserver found matching constraint")]
    ImpossibleConstraint,
}
```

([storage_controller/src/scheduler.rs L15](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_controller/src/scheduler.rs#L15))

**「ノードが 1 台もない」と「制約を満たすノードがない」を区別する。** 前者は運用の問題、後者は制約の問題。エラーメッセージだけで対処が分かれる。

`MaySchedule::No` になるノードは、スコアの生成段階で `None` を返して候補から外れる。

```rust
        let utilization = match &mut node.may_schedule {
            MaySchedule::Yes(u) => u,
            MaySchedule::No => {
                return None;
            }
        };
```

**ハード制約はスコアではなく `Option` で表現する。** 「無限大のスコア」にすると、他に候補がないときに選ばれてしまう。

## この先に効いてくること

- **制約の優先順位を、構造体のフィールド順で表現する。** `derive(Ord)` の辞書順。
- **同じ情報を逆向きの選好で使うなら、newtype で `Ord` を分ける。**
- **「不明」を「悪い」に丸めない。** 分からないなら当たりかもしれない。
- **ソフト制約はスコア、ハード制約は候補から除外。** 混ぜると破綻する。
- **新規配置の基準と移動の基準は違う。** 振動する制約を移動の理由にしない。
