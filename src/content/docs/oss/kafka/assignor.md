---
title: "数万パーティションの割り当てを、速く・動かさずに決める"
description: "パーティションをメンバに配る計算は、均等さと「動かさないこと」の 2 つを同時に満たしたい。しかも数万規模で、リバランスのたびに走る。Kafka は購読が全員同じ場合と違う場合でアルゴリズムを分け、前者は割り算 1 回で解いている。後者は完全な最適解を諦めて、反復回数に上限を置いた。"
sidebar:
  order: 34
---

## 何を学んだか

### どんな状況の話か

[新しいリバランスプロトコル](../rebalance-protocol/) では、コーディネータが「目標割り当て」を計算する。入力と出力はこうだ。

```text
入力: メンバのリスト、各メンバの購読トピック、各トピックのパーティション数、現在の割り当て
出力: メンバごとの担当パーティション
```

満たしたい性質が 2 つある。

- **均等 (balance)**: どのメンバも同じくらいのパーティションを持つ。差は 1 以下。
- **粘着 (stickiness)**: **今持っているものをできるだけ持ち続ける。**

2 つ目が重要だ。割り当てが変わったパーティションは、**前の持ち主が処理を止めてコミットし、新しい持ち主がそこから読み直す**必要がある。動かすほど停止が増える。

そして、**この計算はコーディネータのイベントループの中で走る** ([コーディネータのページ](../coordinator-runtime/))。数万パーティションでも数ミリ秒で終わらないと、他のリクエストが詰まる。

### Kafka の答え

**購読パターンで 2 つのアルゴリズムを使い分ける。**

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformAssignor.java"
/**
 * The Uniform Assignor distributes topic partitions among group members for a
 * balanced and potentially rack aware assignment.
 * The assignor employs two different strategies based on the nature of topic
 * subscriptions across the group members:
 * <ul>
 *     <li>
 *         <b> Uniform Homogeneous Assignment Builder: </b> This strategy is used when all members have subscribed
 *         to the same set of topics.
 *     </li>
 *     <li>
 *         <b> Uniform Heterogeneous Assignment Builder: </b> This strategy is used when members have varied topic
 *         subscriptions.
 *     </li>
 * </ul>
 *
 * The appropriate strategy is automatically chosen based on the current members' topic subscriptions.
 */
public class UniformAssignor implements ConsumerGroupPartitionAssignor {
```

[`UniformAssignor.java#L30-L51`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformAssignor.java#L30-L51)。

1. **全員が同じトピックを購読 (homogeneous)** → **割り算 1 回で目標値が決まる。**
2. **購読がバラバラ (heterogeneous)** → **反復して均衡に近づける。上限あり。**
3. **どちらも「均等 > 粘着」の優先順位。**
4. **範囲を表す `Set` を、要素を持たずに実装している** (`RangeSet`)。
5. **「変わらなかった割り当ては、コピーもしない」。**

## ソースコードのどこか

### 優先順位が明記されている

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHomogeneousAssignmentBuilder.java"
/**
 * The homogeneous uniform assignment builder is used to generate the target assignment for a consumer group with
 * all its members subscribed to the same set of topics.
 *
 * Assignments are done according to the following principles:
 *
 * <li> Balance:          Ensure partitions are distributed equally among all members.
 *                        The difference in assignments sizes between any two members
 *                        should not exceed one partition. </li>
 * <li> Stickiness:       Minimize partition movements among members by retaining
 *                        as much of the existing assignment as possible. </li>
 *
 * The assignment builder prioritizes the properties in the following order:
 *      Balance > Stickiness.
 */
public class UniformHomogeneousAssignmentBuilder {
```

[`UniformHomogeneousAssignmentBuilder.java#L35-L50`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHomogeneousAssignmentBuilder.java#L35-L50)。

**`Balance > Stickiness` — 2 つの性質が競合したとき、どちらを取るかが書いてある。**

均等さを完全に満たそうとすると、粘着性が犠牲になる。逆もある。**「両方を最大化」は数学的に不可能なので、優先順位を先に決める。**

### 同じ購読なら、割り算で終わる

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHomogeneousAssignmentBuilder.java"
/**
 * The minimum number of partitions that a member must have.
 * Minimum quota = total partitions / total members.
 */
private int minimumMemberQuota;

/**
 * The number of members to receive an extra partition beyond the minimum quota.
 * Example: If there are 11 partitions to be distributed among 3 members,
 *          each member gets 3 (11 / 3) [minQuota] partitions and 2 (11 % 3) members get an extra partition.
 */
private int remainingMembersToGetAnExtraPartition;
```

[`UniformHomogeneousAssignmentBuilder.java#L82-L93`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHomogeneousAssignmentBuilder.java#L82-L93)。

**全員が同じトピックを購読しているなら、誰がどのパーティションを持てるかに制約がない。** だから「1 人あたり何個か」は割り算で決まる。

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHomogeneousAssignmentBuilder.java"
int numberOfMembers = groupSpec.memberIds().size();
minimumMemberQuota = totalPartitionsCount / numberOfMembers;
remainingMembersToGetAnExtraPartition = totalPartitionsCount % numberOfMembers;

// Revoke the partitions that either are not part of the member's subscriptions or
// exceed the maximum quota assigned to each member.
maybeRevokePartitions();

// Assign the unassigned partitions to the members with space.
assignRemainingPartitions();
```

[`UniformHomogeneousAssignmentBuilder.java#L131-L143`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHomogeneousAssignmentBuilder.java#L131-L143)。

**2 段階しかない。**

1. **持ちすぎているメンバから、超過分を取り上げる。** ここで粘着性が効く。**上限までは持ち続けられる。**
2. **余ったパーティションを、足りないメンバに配る。**

**探索も反復もない。O(パーティション数)。**

粘着性は「取り上げる分を最小にする」ことで実現される。**現在の割り当てのうち、上限を超えた分だけを剥がす。** 全部剥がして配り直せば計算は簡単だが、それでは全員が処理を止めることになる。

コメントに最適化も書いてある。

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHomogeneousAssignmentBuilder.java"
 * This method ensures that the original assignment is not copied if it is not
 * altered.
```

[`UniformHomogeneousAssignmentBuilder.java#L148-L154`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHomogeneousAssignmentBuilder.java#L148-L154)。

**変更がないメンバの割り当ては、元のオブジェクトをそのまま使う。** 数万パーティションのグループで、変わったのが 1 メンバだけなら、コピーは 1 メンバ分で済む。

### 購読がバラバラなら、反復する

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHeterogeneousAssignmentBuilder.java"
/**
 * Performs reassignments of partitions to balance the load across members.
 * This method iteratively reassigns partitions until no further moves can improve the balance.
 * <p/>
 * The method loops over the topics repeatedly until an entire loop around the topics has
 * completed without any reassignments, or we hit an iteration limit.
 * <p/>
 * This method produces perfectly balanced assignments when all subscribers of a topic have the
 * same subscriptions. However, when subscribers have overlapping, non-identical subscriptions,
 * the method produces almost-balanced assignments, assuming the iteration limit is not hit.
 * eg. if there are three members and two topics and members 1 and 2 are subscribed to the first
 *     topic and members 2 and 3 are subscribed to the second topic, we can end up with an
 *     assignment like:
 * <ul>
 *   <li>Member 1: 9 partitions</li>
 *   <li>Member 2: 10 partitions</li>
 *   <li>Member 3: 11 partitions</li>
 * </ul>
 *
 * In this assignment, the subscribers of the first topic have a difference in partitions of 1,
 * so the topic is considered balanced. The same applies to the second topic. However, balance
 * can be improved by moving a partition from the second topic from member 3 to member 2 and a
 * partition from the first topic from member 2 to member 1.
 */
private void balanceTopics(Collection<Uuid> topicIds) {
```

[`UniformHeterogeneousAssignmentBuilder.java#L606-L634`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHeterogeneousAssignmentBuilder.java#L606-L634)。

**「完全に均等にはならない」ことを、具体例で明示している。**

購読が重なり合っていると、**トピックごとに見れば均等でも、全体では均等でない**状態に落ち着きうる。上の例では 9/10/11 になる。

**より良い割り当ては存在する** (コメントがその手順まで書いている) が、**それを見つけるには複数トピックをまたいだ連鎖的な移動が必要で、探索空間が広い。**

だから諦めている。**「ほぼ均等」で止める。**

無駄も刈っている。

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHeterogeneousAssignmentBuilder.java"
/**
 * If a topic has two or more potential members it is subject to reassignment.
 */
private boolean canTopicParticipateInReassignment(Uuid topicId) {
    return topicSubscribers.get(topicId).size() >= 2;
}
```

[`UniformHeterogeneousAssignmentBuilder.java#L581-L588`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/UniformHeterogeneousAssignmentBuilder.java#L581-L588)。

**購読者が 1 人しかいないトピックは、動かしようがない。** 反復の対象から外す。

### 要素を持たない Set

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/RangeSet.java"
/**
 * A {@code RangeSet} represents a range of integers from {@code from} (inclusive)
 * to {@code to} (exclusive).
 * This implementation provides a view over a continuous range of integers without actually storing them.
 */
class RangeSet implements Set<Integer> {
    private final int from;
    private final int to;
```

[`RangeSet.java#L26-L34`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/assignor/RangeSet.java#L26-L34)。

**`Set<Integer>` を実装しているが、要素を 1 つも保持しない。** 整数 2 つだけ。

トピックのパーティションは常に `0 .. N-1` の連続した整数だ。**それを `HashSet<Integer>` で表すと、N 個の `Integer` オブジェクトと、ハッシュテーブルの構造が要る。** パーティションが 10 万個なら、それだけで数 MB になる。

`RangeSet` なら **8 バイト**。`contains(x)` は `from <= x && x < to` で O(1)。

**「連続した整数の集合」という特殊なケースに、専用の実装を用意している。** インタフェースは `Set` のままなので、使う側は意識しない。

### 割り当てアルゴリズムは複数ある

`assignor/` には、他にも実装が並ぶ。

| アサイナ          | 用途                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `UniformAssignor` | 既定。均等 + 粘着                                                |
| `RangeAssignor`   | **トピックをまたいで同じパーティション番号を同じメンバに寄せる** |
| `SimpleAssignor`  | [共有グループ](../share-groups/)用                               |

`RangeAssignor` の目的は **共同分割 (co-partitioning)** だ。トピック A とトピック B の同じパーティション番号を同じメンバに割り当てると、**そのメンバの中で join ができる。** Kafka Streams のような処理で意味を持つ。

**「均等さ」以外の性質を求める用途があるので、アルゴリズムを差し替えられるようにしている。**

## なぜそうなっているか

### なぜ購読パターンで分けるのか

一般的なアルゴリズム 1 本で両方扱うこともできた。だが、**同じ購読の場合は劇的に簡単になる。**

|        | 同じ購読                          | バラバラ                               |
| ------ | --------------------------------- | -------------------------------------- |
| 制約   | **なし** (誰がどれを持ってもよい) | メンバごとに持てるパーティションが違う |
| 目標値 | **割り算で決まる**                | 全体を見ないと決まらない               |
| 計算量 | O(パーティション数)               | 反復。上限つき                         |

そして、**実運用では同じ購読のケースが圧倒的に多い。** 1 つのアプリが 1 つのトピックを読む、が典型だ。

**「よくあるケースを特別扱いして高速化する」** — 一般解 1 本で書くより、コードは増えるが、支配的なケースが速くなる。

判定 (`全員の購読が同じか`) 自体は安いので、分岐のコストも小さい。

### なぜ完全な最適解を諦めるのか

購読がバラバラな場合の最適な割り当ては、**二部グラフのマッチング問題**として定式化できる。多項式時間で解けるアルゴリズムはある。

それでも反復ヒューリスティクスを選んだ理由は、

- **これは[コーディネータのイベントループ](../coordinator-runtime/)の中で走る。** 数ミリ秒で終わらないと、他のリクエストが詰まる。
- **「9/10/11」の不均衡は、実用上ほとんど影響がない。**
- **反復に上限を置けば、最悪時間が保証できる。**

**「最適解を求めるコスト」と「最適でないことの損失」を比べて、後者が小さいと判断している。**

**そして、その判断をコメントに書いている。** 「完全には均等にならない」「こういう例で 9/10/11 になる」「より良い割り当ては存在する」。**次の人が「バグでは?」と疑ったときに、意図的な妥協だと分かる。**

### なぜ「均等 > 粘着」なのか

逆の優先順位もありうる。「動かさないことを優先し、多少の不均衡は許す」。

均等を優先する理由は、**不均衡が累積するから**だ。

粘着を優先すると、メンバが追加されても既存の割り当てがほとんど動かない。**新しいメンバは余った分しかもらえず、いつまでも軽いままになる。** リバランスを繰り返すと、初期のメンバに偏り続ける。

**均等を優先すれば、リバランスのたびに均衡に戻る。** 移動のコストは 1 回だけ払う。

**「一時的なコスト」と「恒久的な非効率」の比較で、前者を選んでいる。**

### `RangeSet` のような特殊化を入れる判断

`Set<Integer>` の実装を自作するのは、普通はやりすぎだ。ここで正当化されるのは、

- **「連続した整数」という条件が、この文脈では常に成り立つ。** パーティション番号は 0 から連番と決まっている。
- **サイズが大きくなりうる。** 10 万パーティションは実在する。
- **インタフェースが `Set` のままなので、呼び出し側が変わらない。**

**特殊化のコストが「1 クラス 100 行」に閉じ込められている**のが良いところだ。使う側は `Set<Integer>` として扱うだけで、`RangeSet` の存在を知らなくていい。

**「データの形が特殊だと分かっているなら、それを利用した表現を選ぶ」** — 汎用のコレクションは、汎用性のぶんメモリを使う。

### 「変わらなければコピーしない」

`maybeRevokePartitions` の javadoc にある `This method ensures that the original assignment is not copied if it is not altered` は、地味だが効く。

リバランスは **メンバが 1 人増減しただけ**でも走る。1000 メンバのグループなら、**999 メンバの割り当ては変わらない。**

それを毎回コピーすると、コピーの量がグループ全体のサイズに比例する。**変わった分だけコピーすれば、変更量に比例する。**

**[メタデータのイメージと差分](../metadata-image-delta/) と同じ発想**で、不変オブジェクトを共有して、変わった部分だけを作り直す。

## どう活かすか

**「よくあるケースを特別扱いして、専用の高速パスを作る」は、コード量と引き換えに支配的なケースを速くする定石だ。** 判定が安く、特別扱いしたケースの実装が大幅に簡単になるなら、元が取れる。**Kafka の場合、同じ購読なら「探索が消えて割り算になる」という質的な差がある。** 定数倍の差しかないなら、分ける価値はない。

**最適解を諦めるなら、諦めたことと、その帰結を書き残す。** 「ほぼ均等」「こういう例では 9/10/11 になる」「より良い解は存在する」。**この 3 点セットがないと、後から見た人はバグだと思って直そうとする。** 妥協は隠すより明示するほうが安全だ。

**競合する 2 つの性質があるなら、優先順位を先に決めて文書化する。** `Balance > Stickiness` の 1 行が、実装の全ての分岐の根拠になっている。**優先順位を決めずに実装すると、場所によって判断が変わり、挙動が予測できなくなる。**

**「一時的なコスト」と「恒久的な非効率」を比べる視点も持ち帰りたい。** 粘着を優先すると移動は減るが、偏りが恒久的に残る。**リバランスのように「たまに走る調整」では、そのとき多少高くついても、後の状態を良くするほうが合理的なことが多い。**

**そして、データの形が特殊だと分かっているなら、汎用コレクションを使わない選択肢がある。** `RangeSet` は 100 行で、`Set<Integer>` として振る舞いながらメモリを 8 バイトに抑える。**インタフェースを保ったまま実装を差し替えられるなら、特殊化のコストは局所に閉じる。**
