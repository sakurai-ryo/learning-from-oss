---
title: "割り当てをクライアントからサーバへ移す"
description: "古いリバランスは「全員が一度グループを抜けて、リーダーが割り当てを計算し、全員が結果を受け取る」という同期的な儀式だった。1 人でも遅いと全員が待つ。新しいプロトコルはサーバ側で割り当てを計算し、各メンバがハートビートで少しずつ現実を目標に近づける。同期点が消えている。"
group: "コンシューマとグループ協調"
sidebar:
  order: 32
---

## 何を学んだか

### どんな状況の話か

コンシューマグループは「1 パーティションはグループ内の 1 人だけが読む」という規則を持つ ([前提のページ](../architecture/))。メンバが増減したら、担当を割り当て直す。これがリバランスだ。

古いプロトコル (`classic`) の手順はこうだった。

```text
1. メンバが JoinGroup を送る。コーディネータは全員が揃うまで待つ (rebalance.timeout.ms)。
2. 全員揃ったら、1 人を「リーダー」に選び、全員の購読情報を渡す。
3. リーダーが割り当てを計算し、SyncGroup で返す。
4. コーディネータが各メンバに結果を配る。
```

**この間、グループ全体が止まる。** 状態は `PREPARING_REBALANCE` → `COMPLETING_REBALANCE` と進み、その間のハートビートやオフセットコミットは `REBALANCE_IN_PROGRESS` で弾かれる。

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/classic/ClassicGroupState.java"
 * Group is awaiting state assignment from the leader.
 *
 * action: respond to heartbeats with REBALANCE_IN_PROGRESS
 *         respond to offset commits with REBALANCE_IN_PROGRESS
 *         park sync group requests from followers until transition to STABLE
 *         allow offset fetch requests
```

[`ClassicGroupState.java#L61-L74`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/classic/ClassicGroupState.java#L61-L74)。

問題は 3 つある。

- **同期点がある。** 1 人が遅いと、全員がその人を待つ (最大 `rebalance.timeout.ms`)。
- **メンバが 1 人増えるたびに、全パーティションの処理が止まる。** 1000 メンバのグループでローリング再起動すると、1000 回止まる。
- **割り当ての計算をクライアントがやる。** クライアントのバージョンによってアルゴリズムが違い、混在すると壊れる。

### Kafka の答え

**割り当てをサーバ側で計算し、各メンバが自分のペースで目標に近づく。**

1. **API は `ConsumerGroupHeartbeat` の 1 本だけ。** `JoinGroup`/`SyncGroup` が消えた。
2. **コーディネータが「目標割り当て (target assignment)」を計算する。** メンバ構成が変わったときに。
3. **各メンバは、ハートビートのたびに「今持っているもの」を報告し、「次に持つべきもの」を受け取る。**
4. **同期点がない。** メンバごとに独立して収束する。
5. **メンバの状態は 3 つ。** `STABLE` / `UNREVOKED_PARTITIONS` / `UNRELEASED_PARTITIONS`。

## ソースコードのどこか

### メンバの 3 状態

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/MemberState.java"
public enum MemberState {
    /**
     * The member is fully reconciled with the desired target assignment.
     */
    STABLE((byte) 0),

    /**
     * The member must revoke some partitions in order to be able to
     * transition to the next epoch.
     */
    UNREVOKED_PARTITIONS((byte) 1),

    /**
     * The member transitioned to the last epoch but waits on some
     * partitions which have not been revoked by their previous
     * owners yet.
     */
    UNRELEASED_PARTITIONS((byte) 2),

    /**
     * The member is in an unknown state. This can only happen if a future
     * version of the software introduces a new state unknown by this version.
     */
    UNKNOWN((byte) 127);
```

[`MemberState.java#L25-L52`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/MemberState.java#L25-L52)。

**「待っている理由」が 2 種類ある。**

- **`UNREVOKED_PARTITIONS`**: 自分が手放すべきパーティションを、まだ手放していない。**自分が原因。**
- **`UNRELEASED_PARTITIONS`**: 自分が受け取るべきパーティションを、前の持ち主がまだ手放していない。**他人が原因。**

**この 2 つを区別しているのが要点だ。** どちらも「まだ収束していない」だが、次にすべきことが違う。前者は自分がコミットして手放す、後者はただ待つ。

`UNKNOWN` は **「未来のバージョンが追加した状態を、古いコーディネータが読んだ場合」** のためにある。[プロトコルのバージョン管理](../protocol-codegen/)と同じ発想が、状態機械にも入っている。

### 調停エンジン

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/consumer/CurrentAssignmentBuilder.java"
/**
 * The CurrentAssignmentBuilder class encapsulates the reconciliation engine of the
 * consumer group protocol. Given the current state of a member and a desired or target
 * assignment state, the state machine takes the necessary steps to converge them.
 */
public class CurrentAssignmentBuilder {
```

[`CurrentAssignmentBuilder.java#L36-L41`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/consumer/CurrentAssignmentBuilder.java#L36-L41)。

**「現在の状態」と「目標の状態」を受け取り、1 歩進める。** Kubernetes のコントローラや Terraform と同じ、**宣言的な調停ループ**の形になっている。

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/consumer/CurrentAssignmentBuilder.java"
public ConsumerGroupMember build() {
    switch (member.state()) {
        case STABLE:
            // When the member is in the STABLE state, we verify if a newer
            // epoch (or target assignment) is available. If it is, we can
            // reconcile the member towards it.
            if (member.memberEpoch() != targetAssignmentEpoch) {
                return computeNextAssignment(
                    member.memberEpoch(),
                    member.assignedPartitions()
                );
            } else if (hasSubscriptionChanged) {
                ...
            } else {
                return member;
            }

        case UNREVOKED_PARTITIONS:
            // When the member is in the UNREVOKED_PARTITIONS state, we wait
            // until the member has revoked the necessary partitions. They are
            // considered revoked when they are not anymore reported in the
            // owned partitions set in the ConsumerGroupHeartbeat API.
            ...
            if (ownsRevokedPartitions(member.partitionsPendingRevocation())) {
                ...
                    return member;
            }
            ...
        case UNRELEASED_PARTITIONS:
            // When the member is in the UNRELEASED_PARTITIONS, we reconcile the
            // member towards the latest target assignment. This will assign any
            // of the unreleased partitions when they become available.
```

[`CurrentAssignmentBuilder.java#L187-L244`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/consumer/CurrentAssignmentBuilder.java#L187-L244)。

**「手放したかどうか」の判定が巧妙だ。**

```text
They are considered revoked when they are not anymore reported in the
owned partitions set in the ConsumerGroupHeartbeat API.
```

**メンバが「今これを持っています」と報告するリストから消えたら、手放したと見なす。** 「手放しました」という専用の RPC がない。

**ハートビートに「現在の所有」を載せるだけで、明示的な完了通知が不要になっている。** これが同期点を消せた理由の 1 つだ。

`UNKNOWN` 状態の扱いも書かれている。

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/consumer/CurrentAssignmentBuilder.java"
case UNKNOWN:
    // We could only end up in this state if a new state is added in the
    // future and the group coordinator is downgraded. In this case, the
    // best option is to fence the member to force it to rejoin the group
    // without any partitions and to reconcile it again from scratch.
    if (ownedTopicPartitions == null || !ownedTopicPartitions.isEmpty()) {
        throw new FencedMemberEpochException("The consumer group member is in a unknown state. "
            + "The member must abandon all its partitions and rejoin.");
    }
```

[`CurrentAssignmentBuilder.java#L245-L253`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/consumer/CurrentAssignmentBuilder.java#L245-L253)。

**ダウングレードしたときの回復手順が書いてある。** 「全部手放して、最初からやり直せ」。**分からない状態は、既知の状態にリセットする。**

### メンバの情報は全部ログに載る

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/consumer/ConsumerGroupMember.java"
/**
 * ConsumerGroupMember contains all the information related to a member
 * within a consumer group. This class is immutable and is fully backed
 * by records stored in the __consumer_offsets topic.
 */
public class ConsumerGroupMember extends ModernGroupMember {
```

[`ConsumerGroupMember.java#L37-L42`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/modern/consumer/ConsumerGroupMember.java#L37-L42)。

**不変で、`__consumer_offsets` のレコードに完全に裏付けられている。**

つまり、**メンバの状態遷移が全部ログに書かれる。** コーディネータが交代しても、ログを読めば全メンバの状態が復元できる ([コーディネータのページ](../coordinator-runtime/))。

古いプロトコルでは、リバランスの途中経過はコーディネータのメモリにしかなかった。**コーディネータが落ちると、リバランスをやり直していた。**

### エポックによる進行の管理

グループには **グループエポック**、目標割り当てには **目標割り当てエポック**、各メンバには **メンバエポック**がある。

```text
1. メンバ構成が変わる → グループエポックが上がる
2. コーディネータが目標割り当てを計算 → 目標割り当てエポックがグループエポックに追いつく
3. 各メンバが調停を進める → メンバエポックが目標割り当てエポックに追いつく
```

`build()` の `STABLE` の分岐が `member.memberEpoch() != targetAssignmentEpoch` を見ているのは、**「このメンバは最新の目標に追いついているか」** の判定だ。

**エポックの比較だけで「収束したか」が分かる。** 割り当ての中身を比べる必要がない。

## なぜそうなっているか

### なぜ同期点をなくせたのか

古いプロトコルに同期点があったのは、**「全員の購読情報を集めてから割り当てを計算する」** 必要があったからだ。計算するのがメンバの 1 人なので、その人に情報を集める瞬間が要る。

サーバ側で計算するなら、**コーディネータは常に全員の情報を持っている** (ハートビートで届く)。集める瞬間が要らない。

そして、**割り当ての適用も同期する必要がない。** パーティション X をメンバ A から B に移すとき、必要なのは「A が手放してから B が受け取る」という順序だけで、**他のパーティションとは無関係だ。**

**「グループ全体の同期」を「パーティションごとの引き継ぎ」に分解した**のが、この変更の核心になっている。

### なぜ「手放した」を専用 RPC にしないのか

メンバが「手放しました」と明示的に送る設計もありうる。そうしなかったのは、**その RPC が失われたときの扱いが面倒だから**だ。

- 送ったが応答が来なかった → 再送する? コーディネータは受け取ったのか?
- 送る前に落ちた → セッションタイムアウトを待つ?

**「現在の所有リスト」を毎回ハートビートに載せる**なら、状態を送るのであって、イベントを送るのではない。**取りこぼしても、次のハートビートで正しい状態が届く。**

**「イベントではなく状態を送る」** — これが調停ループの前提であり、Kubernetes の宣言的 API と同じ考え方になっている。イベントは取りこぼすと復元できないが、状態は毎回全部送るので取りこぼしても直る。

### なぜ 2 つの「待ち」を区別するのか

`UNREVOKED_PARTITIONS` と `UNRELEASED_PARTITIONS` は、どちらも「まだ収束していない」。区別する理由は 3 つある。

- **次にすべきことが違う。** 前者はメンバに「手放せ」と伝える。後者はただ待つ。
- **原因が違う。** 前者は自分が遅い。後者は他人が遅い。**運用時に「誰が詰まっているか」が分かる。**
- **タイムアウトの扱いが違いうる。** 手放さないメンバは追い出せるが、待っているメンバは追い出しても意味がない。

**「同じ待ち状態でも、待っている理由が違うなら別の状態にする」** — 状態機械の粒度を決める判断として参考になる。

### なぜメンバの状態をログに書くのか

古いプロトコルでは、リバランス中の状態はコーディネータのメモリにあった。**コーディネータが交代すると、リバランスは最初からやり直し。**

新しいプロトコルでは、メンバの状態遷移が `__consumer_offsets` に書かれる。**コーディネータが交代しても、途中から続けられる。**

代償は **書き込み量**だ。メンバの状態が変わるたびにレコードが増える。ただし、

- 状態が変わるのはリバランス中だけ (`STABLE` なら書かない)。
- [ログ圧縮](../log-compaction/)で古い状態は消える。

**「メモリにしかない状態は、そのプロセスが落ちたら失われる」** という当たり前の帰結を、書き込みコストを払って解消している。[章全体の主題](../) — 状態が要るならログに書く — がここでも出ている。

### エポックが 3 種類ある理由

グループエポック、目標割り当てエポック、メンバエポック。**なぜ 1 つではだめか。**

**それぞれ進む速度が違うからだ。**

```text
グループエポック         : メンバが増減した瞬間に上がる (即座)
目標割り当てエポック     : 割り当ての計算が終わったら追いつく (数ミリ秒〜)
メンバエポック           : そのメンバが調停を終えたら追いつく (メンバごとにバラバラ)
```

**1 つのエポックだと、「計算中」と「メンバ A は追いついたが B はまだ」を区別できない。** 段階ごとに別のエポックを持つと、**どの段階まで進んだかが数値の比較だけで分かる。**

これは [ISR の `isr` と `maximalIsr`](../isr-highwatermark/) と似た構図で、**「同じものの、進行度が違うバージョン」を別々に持つ**という形になっている。

### 割り当てをサーバに移す代償

いいことばかりではない。

- **コーディネータの計算負荷が増える。** 数万パーティションの割り当てを計算する ([アサイナのページ](../assignor/))。
- **カスタムの割り当てロジックが使いにくくなる。** クライアント側の `PartitionAssignor` を差し替える運用ができない。サーバ側にプラグインする形になる。
- **移行が難しい。** グループ内に新旧のプロトコルが混在する期間がある。

3 番目のために、**コーディネータは古いプロトコルのメンバと新しいプロトコルのメンバを同じグループで扱える**ようになっている。`ConsumerGroupMigrationPolicy` という設定まである。

**「クライアントの機能をサーバに移す」変更は、移行期間の混在を必ず設計に含める。**

## どう活かすか

**「全体を同期させる儀式」を「個別の調停」に分解できないか、は分散システムで常に問う価値がある。** 同期点があると、最も遅い参加者が全体の速度を決める。**分解の鍵は「本当に全体の合意が要るのはどこか」を見極めること。** Kafka の場合、必要だったのは「パーティション X の引き継ぎ順序」だけで、グループ全体の合意ではなかった。

**「イベントではなく状態を送る」は、調停ループの前提条件だ。** 「手放しました」というイベントは取りこぼすと復元できないが、「今これを持っています」という状態は毎回送るので自己修復する。**冪等で、順序に依存せず、再送が安全。** ポーリング型のプロトコルなら、状態を送るほうがほぼ常に堅い。

**「同じ待ちでも理由が違うなら状態を分ける」も実務的だ。** `UNREVOKED` と `UNRELEASED` を 1 つの `PENDING` にまとめると、次のアクションを決めるのに追加の判定が要り、運用時に「誰が詰まっているか」も分からなくなる。**状態の数を減らすことが常に善ではない。**

**「進行度が違う段階には、それぞれエポックを持たせる」** と、収束の判定が数値比較になる。中身を比較しなくてよいので安く、しかも「どの段階で止まっているか」が観測できる。**メトリクスとして出せば、そのまま運用の指標になる。**

**そして、クライアントからサーバへ機能を移す変更は、混在期間の設計が本体だ。** 新旧のプロトコルが同じグループに同居する期間を、どう扱うか。**それを後回しにすると、「一斉に切り替えてください」という現実的でない移行手順になる。**
