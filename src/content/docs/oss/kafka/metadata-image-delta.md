---
title: "ログを畳んだ不変イメージと、その差分を配る"
description: "メタデータログを読む側は、レコードを 1 件ずつ適用するのではなく「不変なイメージ」と「前回からの差分」の組を受け取る。差分には「このブローカーにとって何が変わったか」を計算するメソッドが付いていて、ブローカーはそれだけを見ればいい。スナップショットを読んだときも、同じ差分の形で渡される。"
sidebar:
  order: 20
---

## 何を学んだか

### どんな状況の話か

[KRaft のページ](../kraft-overview/) で見たとおり、ブローカーは `__cluster_metadata` の読み手 (observer) だ。ログを読んで、自分のメタデータキャッシュを更新する。

素朴に実装すると、レコードを 1 件ずつ適用することになる。

```java
for (record : records) {
    switch (record.type()) {
        case TOPIC_RECORD -> topics.put(...);
        case PARTITION_CHANGE_RECORD -> partitions.put(...);
        ...
    }
}
```

これで動くが、購読者ごとに問題が出る。

- **ブローカーは「自分がリーダーになったパーティション」だけを知りたい。** 全レコードを見て自分に関係するものを拾う処理を、購読者ごとに書くことになる。
- **[スナップショット](../metadata-snapshot/)を読むときは意味が変わる。** スナップショットは「差分」ではなく「全体」なので、適用の前に既存の状態を捨てる必要がある。購読者ごとに 2 経路。
- **メタデータキャッシュを読む側とのロック競合。** 適用中に読まれると中途半端な状態が見える。

### Kafka の答え

**購読者には「不変なイメージ」と「差分」の組を渡す。**

1. **`MetadataImage` は不変。** 更新のたびに新しいイメージが作られ、参照を差し替える。読み手はロックを取らない。
2. **`MetadataDelta` は「前回のイメージからの変更」。** 変更されたトピック、削除されたトピック、変わった設定だけを持つ。
3. **`MetadataLoader` が専用スレッドで、ログを読んでイメージと差分を作り、購読者に配る。**
4. **スナップショットを読んだときも、差分の形にして渡す。** 購読者は区別しなくていい。
5. **差分には「このブローカー ID にとって何が変わったか」を計算するメソッドがある。**

## ソースコードのどこか

### イメージの形

```java title="metadata/src/main/java/org/apache/kafka/image/MetadataImage.java"
/**
 * The broker metadata image.
 * <p>
 * This class is thread-safe.
 */
public record MetadataImage(MetadataProvenance provenance, FeaturesImage features, ClusterImage cluster,
                            TopicsImage topics, ConfigurationsImage configs, ClientQuotasImage clientQuotas,
                            ProducerIdsImage producerIds, AclsImage acls, ScramImage scram,
                            DelegationTokenImage delegationTokens) {
```

[`MetadataImage.java#L28-L36`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/MetadataImage.java#L28-L36)。

**`record` なので不変。** 9 つの領域に分かれていて、それぞれが自分の `Image` を持つ。1 つの領域だけが変わったら、**変わった `Image` だけを新しくして、残りは同じ参照を使い回す。**

`provenance` は「このイメージがどの offset・epoch のものか」を持つ。**イメージ自身が「自分がログのどこ由来か」を知っている。**

### 中身も不変コレクション

```java title="metadata/src/main/java/org/apache/kafka/image/TopicsImage.java"
/**
 * Represents the topics in the metadata image.
 * <p>
 * This class is thread-safe.
 */
public record TopicsImage(ImmutableMap<Uuid, TopicImage> topicsById, ImmutableMap<String, TopicImage> topicsByName) {
    public static final TopicsImage EMPTY = new TopicsImage(ImmutableMap.empty(), ImmutableMap.empty());

    public TopicsImage including(TopicImage topic) {
        return new TopicsImage(
            this.topicsById.updated(topic.id(), topic),
            this.topicsByName.updated(topic.name(), topic));
    }
```

[`TopicsImage.java#L31-L43`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/TopicsImage.java#L31-L43)。

**`ImmutableMap` は永続データ構造** (`server-common` の `org.apache.kafka.server.immutable`、実装は PCollections)。`updated()` は新しいマップを返すが、**変わっていない部分は共有される。**

トピックが 10 万個あるクラスタで 1 個の設定が変わっても、**コピーされるのは木のパス上のノードだけ**で、残り 99,999 個は同じオブジェクトを指す。

[timeline データ構造](../timeline-datastructures/) との使い分けが興味深い。

|                           | 用途                     | 差分の向き                                            |
| ------------------------- | ------------------------ | ----------------------------------------------------- |
| `TimelineHashMap`         | コントローラの作業用状態 | **過去を差分で残す** (現在の読みが速い)               |
| `ImmutableMap` (イメージ) | 購読者に配る状態         | **新しいほうを差分で作る** (過去も現在も同時に生きる) |

**イメージは複数の世代が同時に参照されうる**ので、後者が合っている。購読者 A が古いイメージを処理している間に、購読者 B が新しいイメージを見ることがある。

### 差分の適用

```java title="metadata/src/main/java/org/apache/kafka/image/TopicsDelta.java"
public TopicsImage apply() {
    ImmutableMap<Uuid, TopicImage> newTopicsById = image.topicsById();
    ImmutableMap<String, TopicImage> newTopicsByName = image.topicsByName();
    // apply all the deletes
    for (Uuid topicId: deletedTopicIds) {
        // it was deleted, so we have to remove it from the maps
        TopicImage originalTopicToBeDeleted = image.topicsById().get(topicId);
        if (originalTopicToBeDeleted == null) {
            throw new IllegalStateException("Missing topic id " + topicId);
        } else {
            newTopicsById = newTopicsById.removed(topicId);
            newTopicsByName = newTopicsByName.removed(originalTopicToBeDeleted.name());
        }
    }
    // apply all the updates/additions
    for (Map.Entry<Uuid, TopicDelta> entry: changedTopics.entrySet()) {
```

[`TopicsDelta.java#L167-L187`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/TopicsDelta.java#L167-L187)。

**差分は「元のイメージ + 変更点」を持ち、`apply()` で新しいイメージを作る。** 元のイメージは変わらない。

### 購読者への配布

```java title="metadata/src/main/java/org/apache/kafka/image/loader/MetadataLoader.java"
/**
 * The MetadataLoader follows changes provided by a RaftClient, and packages them into metadata
 * deltas and images that can be consumed by publishers.
 *
 * The Loader maintains its own thread, which is used to make all callbacks into publishers. If a
 * publisher A is installed before B, A will receive all callbacks before B. This is also true if
 * A and B are installed as part of a list [A, B].
 *
 * Publishers should not modify any data structures passed to them.
 *
 * It is possible to change the list of publishers dynamically over time. Whenever a new publisher is
 * added, it receives a catch-up delta which contains the full state. Any publisher installed when the
 * loader is closed will itself be closed.
 */
public class MetadataLoader implements RaftClient.Listener<ApiMessageAndVersion>, AutoCloseable {
```

[`MetadataLoader.java#L62-L76`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/loader/MetadataLoader.java#L62-L76)。

契約が 4 つ書かれている。

1. **専用スレッドが 1 本。** 全コールバックがそこから呼ばれる。
2. **購読者の順序が保証される。** 先に登録したほうが先に呼ばれる。
3. **購読者は渡されたデータを変更してはいけない。**
4. **後から登録した購読者は、「全状態を含むキャッチアップ差分」を受け取る。**

**4 が効いている。** 起動の途中で購読者を足しても、その購読者は「初回に全部入りの差分」を受け取るので、それまでの経緯を知らなくていい。

購読者のインタフェースは 3 メソッドしかない。

```java title="metadata/src/main/java/org/apache/kafka/image/publisher/MetadataPublisher.java"
/**
 * Publish a new cluster metadata snapshot that we loaded.
 *
 * @param delta    The delta between the previous state and the new one.
 * @param newImage The complete new state.
 * @param manifest A manifest which describes the contents of what was published.
 *                 If we loaded a snapshot, this will be a SnapshotManifest.
 *                 If we loaded a log delta, this will be a LogDeltaManifest.
 */
void onMetadataUpdate(
        MetadataDelta delta,
        MetadataImage newImage,
        LoaderManifest manifest
);
```

[`MetadataPublisher.java#L50-L63`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/publisher/MetadataPublisher.java#L50-L63)。

**差分と、全体の新しいイメージの両方が渡される。** 差分だけを見たい購読者と、全体を見たい購読者の両方に対応できる。

そして javadoc に、この抽象の狙いが書いてある。

```java title="metadata/src/main/java/org/apache/kafka/image/publisher/MetadataPublisher.java"
/**
 * Publishes metadata deltas which we have loaded from the log and snapshots.
 *
 * Publishers receive a stream of callbacks from the metadata loader which keeps them notified
 * of the latest cluster metadata. This interface abstracts away some of the complications of
 * following the cluster metadata. For example, if the loader needs to read a snapshot, it will
 * present the contents of the snapshot in the form of a delta from the previous state.
 */
```

[`MetadataPublisher.java#L24-L32`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/publisher/MetadataPublisher.java#L24-L32)。

**「スナップショットを読んだ場合も、前の状態からの差分として提示する」。** 購読者は「今読んでいるのがログかスナップショットか」を気にしなくていい。

**厄介さを 1 箇所に集めて、購読者を単純にしている。**

### 「自分にとって何が変わったか」

```java title="metadata/src/main/java/org/apache/kafka/image/TopicsDelta.java"
/**
 * ...
 * @param brokerId the broker id
 * @return the LocalReplicaChanges that cover changes in the broker
 */
public LocalReplicaChanges localChanges(int brokerId) {
    Set<TopicPartition> deletes = new HashSet<>();
    Map<TopicPartition, LocalReplicaChanges.PartitionInfo> electedLeaders = new HashMap<>();
    Map<TopicPartition, LocalReplicaChanges.PartitionInfo> leaders = new HashMap<>();
    Map<TopicPartition, LocalReplicaChanges.PartitionInfo> followers = new HashMap<>();
```

[`TopicsDelta.java#L228-L252`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/TopicsDelta.java#L228-L252)。

**ブローカー ID を渡すと、そのブローカーがやるべきことが返ってくる。**

| 返り値           | ブローカーがやること                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| `deletes`        | そのパーティションのログを削除する                                           |
| `leaders`        | リーダーとして受け付ける。[フェッチャスレッドを止める](../pull-replication/) |
| `electedLeaders` | 新たにリーダーになった (leader epoch が上がった)                             |
| `followers`      | フォロワーとしてフェッチャスレッドを立てる                                   |

**これが ZooKeeper 時代の `LeaderAndIsrRequest` を置き換えている。** かつてはコントローラがこの計算をして RPC で送っていた。今は **各ブローカーが自分で差分から計算する。**

コントローラは「変更をログに書く」だけになり、**「誰に何を伝えるか」を管理しなくなった。** ブローカーが 1000 台いても、コントローラの仕事は増えない。

## なぜそうなっているか

### 不変イメージにする理由

`MetadataImage` が不変であることの効果は 3 つある。

- **読み手がロックを取らない。** `volatile` な参照を 1 回読むだけ。メタデータキャッシュは[全リクエストの処理](../socket-server/)から参照されるので、ここがロックだと詰まる。
- **「一貫したスナップショット」が自然に手に入る。** 1 つのリクエストの処理中、ずっと同じイメージを見られる。途中で変わらない。
- **[スナップショットの生成](../metadata-snapshot/)が単純になる。** イメージを渡して書き出すだけ。書いている最中に変わらない。

代償は、更新のたびにオブジェクトを作ることだ。だから **永続データ構造で「変わった部分だけ」を作る**ようにしている。

### 差分を「購読者に計算させる」のではなく「差分として渡す」理由

購読者が新旧のイメージを比較して差分を求めることもできる。だが、それだと **トピック 10 万個を毎回全比較する**ことになる。

`MetadataDelta` は **レコードを適用しながら「何が変わったか」を記録**する。レコードが 3 件なら、差分に入るのも 3 件分。**変更量に比例したコストになる。**

そして `localChanges(brokerId)` のような **「用途に特化した射影」を差分の上に置ける。** 全体を舐めずに、変わった分だけからブローカー固有の変更を導ける。

### スナップショットを差分に見せる理由

スナップショットは全状態なので、素直に扱うと「今までの状態を全部捨てて、これに置き換えろ」という別の通知になる。購読者は 2 つの経路を実装することになる。

**Kafka は、スナップショットを読んだときも「前の状態からの差分」を計算して渡す。**

- 購読者の実装が 1 経路で済む。
- **ブローカーが再起動なしでスナップショットを受け取っても、「変わったパーティションだけ」を処理できる。** 全パーティションを作り直さない。

**「例外的な入力を、通常の形に変換して渡す」** という設計で、変換のコストをローダー側 (1 箇所) が負担している。

### 購読者モデルにした理由

`MetadataPublisher` の実装は複数ある。

| 購読者                          | 何をするか                                      |
| ------------------------------- | ----------------------------------------------- |
| `BrokerMetadataPublisher`       | パーティションの割り当て、設定の反映            |
| `SnapshotGenerator`             | [スナップショットの生成](../metadata-snapshot/) |
| `AclPublisher`                  | 認可の設定を反映                                |
| `DynamicConfigPublisher`        | [動的設定](../dynamic-config/)の反映            |
| `ControllerRegistrationManager` | コントローラの登録                              |

**「メタデータの変更に反応する処理」が全部同じインタフェースになる。** 新しい機能を足すときは、購読者を 1 つ追加するだけで、ログを読む部分には触らない。

そして **順序が保証されている**ので、依存関係を登録順で表現できる。「設定を反映してからパーティションを作る」を、リストの順序で書ける。

### 「購読者はデータを変更してはいけない」の意味

javadoc の `Publishers should not modify any data structures passed to them` は、**不変性が型では強制されていない**ことの裏返しでもある。

`MetadataImage` は record で `ImmutableMap` を持つので、実質的に変更できない。だが `LocalReplicaChanges` のような派生物は普通の `HashMap` を返す。**そこを変更されると、後続の購読者が壊れる。**

**規約でしか守れない部分を、javadoc で明示している。** [timeline データ構造の `All timeline data structures must be registered here`](../timeline-datastructures/) と同じ形だ。

## どう活かすか

**「不変なイメージ + 差分」を購読者に配る構造は、状態を多数の読み手に配るときの有力な形だ。** 読み手はロックを取らず、一貫したスナップショットを見られ、変更量に比例したコストで反応できる。**React の仮想 DOM や Git のツリーと同じ発想で、「不変 + 構造共有 + 差分」は同じ問題に対する同じ答えになっている。**

**「例外的な入力を、通常の形に変換して渡す」は、抽象を設計するときに一番効く判断だ。** スナップショットは本来「全体」だが、それを「差分」に変換して渡すことで、購読者の実装が半分になる。**変換のコストは 1 箇所で払い、単純さは購読者の数だけ得られる。** 抽象化の価値は「厄介さをどこに集めたか」で測れる。

**「誰に何を伝えるかを、送り手ではなく受け手に計算させる」への転換も見どころだ。** ZooKeeper 時代のコントローラは、ブローカーごとに `LeaderAndIsrRequest` を組み立てていた。**今は全員に同じログを配り、各自が `localChanges(自分のID)` を呼ぶ。** 送り手の仕事が受け手の数に比例しなくなる。**ブロードキャストできる媒体があるなら、宛先ごとの組み立てをやめられないか**は検討する価値がある。

**用途に応じて 2 種類の永続データ構造を使い分けている点も参考になる。** コントローラの作業用状態は「過去を差分で残す」`TimelineHashMap`、配布用のイメージは「新しいほうを差分で作る」`ImmutableMap`。**「どの世代が同時に生きている必要があるか」で選ぶ**と、この使い分けが導ける。

**規約でしか守れない部分は、必ず書き残す。** `Publishers should not modify any data structures passed to them` の 1 行がないと、次の実装者が渡されたマップに追記してしまう。**型で守れないものは、契約として文書に書き、レビューで見る。**
