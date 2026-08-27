---
title: "ISR と high watermark が決める「読んでいい範囲」"
description: "Kafka の一貫性は、レプリカ全員の合意ではなく「ISR という集合を、リーダーが動的に出し入れする」ことで作られている。ISR の変更はコントローラが承認するので、リーダーの手元には「申請済みだがまだ承認されていない ISR」が生まれる。high watermark はその大きいほうの集合で計算される。"
group: "レプリケーション"
sidebar:
  order: 11
---

## 何を学んだか

### どんな状況の話か

パーティションのレプリカが 3 つあるとする。プロデューサが `acks=all` で書いたとき、いつ応答を返すべきか。

- **3 台全員が受け取るまで待つ** → 1 台が遅いだけで全体が止まる。1 台が落ちたら書けなくなる。
- **過半数 (2 台) で応答する** → Raft や Paxos の方式。3 台のうち 1 台の故障に耐えるには 3 台必要で、2 台の故障に耐えるには 5 台必要。**故障耐性のためにレプリカ数が倍以上要る。**

Kafka はどちらも採らなかった。

### Kafka の答え

**「追いついているレプリカの集合」を動的に管理し、その全員が受け取ったら応答する。**

この集合を **ISR (in-sync replicas)** と呼ぶ。

- 遅れたレプリカは ISR から外れる (**shrink**)。外れれば待たなくてよくなる。
- 追いついたら戻る (**expand**)。
- **書き込みが必要とするのは「ISR 全員」で、ISR の人数は変わる。**

そのうえで、実装には次の判断が入っている。

1. **ISR の変更はリーダーが決めるが、コントローラが承認する。** リーダーが勝手に決めると split brain で壊れる。
2. **承認待ちの期間があるので、リーダーは 2 つの ISR を持つ。** `isr` (承認済み) と `maximalIsr` (承認待ちを含む、大きいほう)。
3. **high watermark は `maximalIsr` で計算する。** 大きいほうを使うのが安全側だから。
4. **`min.insync.replicas` を下回ったら、書き込み自体を拒否する。**
5. **それでも「ログには書かれたがエラーを返す」経路が残っている。**

## ソースコードのどこか

### 2 つの ISR

```java title="server/src/main/java/org/apache/kafka/server/partition/PartitionState.java"
/**
 * Represents the state of a partition, including its In-Sync Replicas (ISR) and leader recovery state.
 */
public interface PartitionState {
    /**
     * Includes only the in-sync replicas which have been committed to Controller.
     */
    Set<Integer> isr();

    /**
     * This set may include uncommitted ISR members following an expansion. This "effective" ISR is used for advancing
     * the high watermark as well as determining which replicas are required for acks=all produce requests.*
     */
    Set<Integer> maximalIsr();
    ...
    /**
     * Indicates if we have an AlterPartition request inflight.
     */
    boolean isInflight();
}
```

[`PartitionState.java#L23-L48`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/partition/PartitionState.java#L23-L48)。

**`isr` はコントローラにコミット済み、`maximalIsr` は「拡大を申請中のものも含む」。** 実装クラスは 3 つある — `CommittedPartitionState`、`PendingExpandIsr`、`PendingShrinkIsr`。

なぜ 2 つ要るのか。ISR を広げたいとき、リーダーは `AlterPartition` RPC でコントローラに申請する。**申請が承認されるまでの間、リーダーはどちらの集合で判断すべきか。**

- **拡大の申請中**: 承認されるかもしれないので、**新しいメンバも待つ**。承認されなかったら古い ISR に戻るだけで、余分に待っただけになる。
- **縮小の申請中**: 承認されないかもしれないので、**外そうとしているメンバも待つ**。

どちらも **「大きいほうの集合を使う」** で統一できる。だから `maximalIsr` という名前になっている。

### high watermark の計算

```scala title="core/src/main/scala/kafka/cluster/Partition.scala"
  /**
   * With the addition of AlterPartition, we also consider newly added replicas as part of the ISR when advancing
   * the HW. These replicas have not yet been committed to the ISR by the controller, so we could revert to the previously
   * committed ISR. However, adding additional replicas to the ISR makes it more restrictive and therefore safe. We call
   * this set the "maximal" ISR. See KIP-497 for more details
   */
  private def maybeIncrementLeaderHW(leaderLog: UnifiedLog, currentTimeMs: Long = time.milliseconds): Boolean = {
    if (isUnderMinIsr) {
      trace(s"Not increasing HWM because partition is under min ISR(ISR=${partitionState.isr})")
      return false
    }
    // maybeIncrementLeaderHW is in the hot path, the following code is written to
    // avoid unnecessary collection generation
    val leaderLogEndOffset = leaderLog.logEndOffsetMetadata
    var newHighWatermark = leaderLogEndOffset
    remoteReplicasMap.forEach { (_, replica) =>
      val replicaState = replica.stateSnapshot

      def shouldWaitForReplicaToJoinIsr: Boolean = {
        replicaState.isCaughtUp(leaderLogEndOffset.messageOffset, currentTimeMs, replicaLagTimeMaxMs) &&
        isReplicaIsrEligible(replica.brokerId)
      }

      // Note here we are using the "maximal", see explanation above
      if (replicaState.logEndOffsetMetadata.messageOffset < newHighWatermark.messageOffset &&
          (partitionState.maximalIsr.contains(replica.brokerId) || shouldWaitForReplicaToJoinIsr)
      ) {
        newHighWatermark = replicaState.logEndOffsetMetadata
      }
    }
```

[`Partition.scala#L1001-L1035`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/cluster/Partition.scala#L1001-L1035)。

**やっていることは「ISR 全員の LEO の最小値を取る」だけ。** リーダー自身の LEO から始めて、それより小さい ISR メンバがいたらそちらに下げる。

コメントの `adding additional replicas to the ISR makes it more restrictive and therefore safe` が判断の根拠だ。**待つ相手を増やすのは安全側、減らすのは危険側。** 迷ったら増やす。

`isCaughtUp` の条件が入っているのも重要で、**まだ ISR に入っていないが追いついているレプリカも待つ**。次の瞬間に ISR に入るかもしれないからだ。

コメントに `maybeIncrementLeaderHW is in the hot path` とあり、**フェッチのたびに呼ばれる**。だから `forEach` でコレクションを作らずに回している。

### ISR に入る条件

```scala title="core/src/main/scala/kafka/cluster/Partition.scala"
  private def isFollowerInSync(followerReplica: Replica): Boolean = {
    leaderLogIfLocal.exists { leaderLog =>
      val followerEndOffset = followerReplica.stateSnapshot.logEndOffset
      followerEndOffset >= leaderLog.highWatermark && leaderEpochStartOffsetOpt.exists(followerEndOffset >= _)
    }
  }
```

[`Partition.scala#L907-L912`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/cluster/Partition.scala#L907-L912)。

条件は 2 つ。**high watermark に追いついていること**と、**現在の leader epoch の開始 offset に達していること**。

2 つ目が効くのは、[リーダーが交代した直後](../leader-epoch/) だ。前のリーダーの時代のデータしか持っていないフォロワーを ISR に入れてしまうと、新リーダーが書いたデータを持っていないのに「同期済み」と見なすことになる。

ISR に入れる資格も別に見ている。

```scala title="core/src/main/scala/kafka/cluster/Partition.scala"
  private def isReplicaIsrEligible(followerReplicaId: Int): Boolean = {
    // A replica which meets all of the following requirements is allowed to join the ISR.
    // 1. It is not fenced.
    // 2. It is not in controlled shutdown.
    // 3. Its metadata cached broker epoch matches its Fetch request broker epoch. Or the Fetch
    //    request broker epoch is -1 which bypasses the epoch verification.
```

[`Partition.scala#L914-L932`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/cluster/Partition.scala#L914-L932)。

**3 つ目が「ゾンビ対策」だ。** ブローカーが再起動すると新しい broker epoch を得る ([ブローカーのライフサイクルのページ](../broker-lifecycle/))。フェッチリクエストに載っている epoch と、コントローラから配られたメタデータ上の epoch が食い違っていたら、**そのフェッチは古いプロセスから来ている**。ISR に入れない。

「計画的にシャットダウン中のブローカーは入れない」もある。どうせすぐ抜けるので、入れて ISR を膨らませても無駄になる。

### ISR を縮めるのは定期タスク

```scala title="core/src/main/scala/kafka/cluster/Partition.scala"
def maybeShrinkIsr(): Unit = {
  def needsIsrUpdate: Boolean = {
    !partitionState.isInflight && inReadLock(leaderIsrUpdateLock, () => {
      needsShrinkIsr()
    })
  }

  if (needsIsrUpdate) {
    val alterIsrUpdateOpt = inWriteLock(leaderIsrUpdateLock, () => {
      leaderLogIfLocal.flatMap { leaderLog =>
        val outOfSyncReplicaIds = getOutOfSyncReplicas(replicaLagTimeMaxMs)
```

[`Partition.scala#L1089-L1099`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/cluster/Partition.scala#L1089-L1099)。

**判定基準は「バイト数の遅れ」ではなく「時間の遅れ」だ。** `replica.lag.time.max.ms` (既定 30 秒) 以内にリーダーの LEO に追いついた記録がなければ、out of sync と判定する。

古い Kafka には `replica.lag.max.messages` というバイト/件数ベースの設定もあったが、廃止された。**トラフィックが急増すると全レプリカが一時的に「遅れている」と判定されて、ISR が一斉に縮む**からだ。時間ベースなら、「追いつく速度」で判定できる。

読み取りロックで判定してから、必要なときだけ書き込みロックを取り直す 2 段構えになっている。**ISR が変わらないのが普通なので、普通のときに書き込みロックを取らない。**

### `min.insync.replicas` は書き込みを止める

```scala title="core/src/main/scala/kafka/cluster/Partition.scala"
val minIsr = effectiveMinIsr(leaderLog)
val inSyncSize = partitionState.isr.size

// Avoid writing to leader if there are not enough insync replicas to make it safe
if (inSyncSize < minIsr && requiredAcks == -1) {
  throw new NotEnoughReplicasException(s"The size of the current ISR : $inSyncSize " +
    s"is insufficient to satisfy the min.isr requirement of $minIsr for partition $topicPartition, " +
    s"live replica(s) broker.id are : $inSyncReplicaIds")
}

val info = leaderLog.appendAsLeader(records, this.leaderEpoch, origin, requestLocal, verificationGuard, transactionVersion)
```

[`Partition.scala#L1230-L1240`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/cluster/Partition.scala#L1230-L1240)。

**ISR が `min.insync.replicas` を下回ったら、`acks=all` の書き込みを追記する前に拒否する。**

`requiredAcks == -1` の条件が付いているのが重要で、**`acks=1` や `acks=0` の書き込みは通る**。`min.insync.replicas` は「`acks=all` が意味を持つ最低人数」であって、パーティション全体を止める設定ではない。

### 書けたのにエラーを返す経路

```scala title="core/src/main/scala/kafka/cluster/Partition.scala"
val minIsr = effectiveMinIsr(leaderLog)
if (leaderLog.highWatermark >= requiredOffset) {
  /*
   * The topic may be configured not to accept messages if there are not enough replicas in ISR
   * in this scenario the request was already appended locally and then added to the purgatory before the ISR was shrunk
   */
  if (minIsr <= curMaximalIsr.size)
    (true, Errors.NONE)
  else
    (true, Errors.NOT_ENOUGH_REPLICAS_AFTER_APPEND)
```

[`Partition.scala#L968-L977`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/cluster/Partition.scala#L968-L977)。

**`NOT_ENOUGH_REPLICAS_AFTER_APPEND` — 「追記した後で、レプリカが足りなくなった」。**

順序はこうだ。

1. 書き込みが来る。ISR は 3 人。`min.insync.replicas=2` を満たす。
2. ログに追記する。
3. `acks=all` なので[purgatory](../purgatory/) に預けて待つ。
4. **待っている間に ISR が 1 人に縮む。**
5. high watermark は進んだ (1 人しかいないので、その 1 人 = リーダーが持っていれば進む)。
6. しかし ISR が `min.insync.replicas` を下回っている。

**レコードはログに書かれている。しかし約束した耐久性は満たしていない。** だからエラーを返す。

プロデューサはこのエラーを受けて再送する。**結果として、同じレコードが 2 回書かれる。** [冪等プロデューサ](../idempotent-producer/) が必要になる理由の 1 つがこれで、シーケンス番号があれば 2 回目は重複として弾かれる。

**「エラーを返したからといって、書かれていないとは限らない」** — 分散システムでは避けられない性質が、エラーコードの名前として明示されている。

## なぜそうなっているか

### なぜ過半数ではなく ISR なのか

Raft や Paxos は「過半数」で合意する。Kafka はそうしていない。

|                                        | 過半数 (Raft)                       | ISR (Kafka)                     |
| -------------------------------------- | ----------------------------------- | ------------------------------- |
| f 台の故障に耐えるのに必要なレプリカ数 | **2f + 1**                          | **f + 1**                       |
| 書き込みの待ち                         | 速い過半数だけ                      | ISR 全員                        |
| 遅いレプリカの影響                     | 受けない                            | **ISR から外れるまでは受ける**  |
| ISR が空になったら                     | 起こらない (過半数が生きている前提) | **止まる、または unclean 選出** |

**Kafka はディスク容量を優先した。** 3 台のうち 2 台の故障に耐えたい場合、Raft なら 5 台必要だが、Kafka なら 3 台で足りる。**レプリカ 1 つが数 TB のデータを持つシステムでは、この差が直接コストになる。**

代償は 2 つ。**遅いレプリカが `replica.lag.time.max.ms` の間は書き込みを遅らせる**こと。そして **ISR が 1 人になり得ること** — この状態でその 1 人が落ちると、データが失われるか、パーティションが止まる。後者への対処が [ELR](../elr/) だ。

**そして、Kafka 自身のメタデータには Raft を使っている。** [KRaft](../kraft-overview/) のログはデータ量が小さいので、レプリカを増やすコストが低い。**同じシステムの中で、データ量に応じて別の複製方式を選んでいる**のが面白いところだ。

### なぜコントローラの承認が要るのか

ISR をリーダーが勝手に変えられると、次のシナリオが壊れる。

1. リーダー A がネットワークから孤立する。
2. A は他の全員が「遅れている」と判断し、ISR を `{A}` に縮める。
3. A は自分だけで書き込みを受け付け続ける。
4. 一方、コントローラは A が落ちたと判断し、B を新リーダーにする。
5. **A と B が別々に書き込みを受け付けている。**

ISR の変更をコントローラの承認制にすると、3 で A の申請が拒否される (コントローラはすでに B をリーダーにしている)。**「誰が権威か」を 1 箇所に集約する**ことで、split brain を防いでいる。

`AlterPartition` の応答には現在の leader epoch が含まれ、自分の epoch が古ければリーダーを降りる。

### なぜ承認待ちの間、大きいほうを使うのか

承認待ちの間、リーダーは「申請前の ISR」と「申請後の ISR」のどちらで判断すべきか分からない。**分からないなら、両方を満たすほうを選ぶ。**

- 拡大申請中に新メンバを待たない → 承認されたら、そのメンバは ISR なのに待っていなかったことになる。**危険。**
- 拡大申請中に新メンバを待つ → 却下されたら、待たなくてよかった相手を待っただけ。**遅いだけ。**

**「不確実な期間は、両方の解釈で安全な側に倒す」** というのは、2 相コミットや設定変更のプロトコルで繰り返し出てくる形だ。Raft の joint consensus (新旧両方の構成で過半数を要求する) も同じ発想になっている。

### なぜ時間ベースの遅れ判定なのか

バイト数や件数で判定すると、**トラフィックの急増で健全なレプリカまで脱落する**。1 秒間に 100 MB 流れれば、どのレプリカも一瞬で「1000 件遅れ」になる。

時間ベース (「30 秒以内にリーダーの LEO に一度でも追いついたか」) なら、**追いつく速度で判定できる**。処理が追いついている限り、スループットが上がっても脱落しない。

**「絶対量ではなく、追いつけているかで測る」** は、キューの監視やバックプレッシャの設計にそのまま応用できる。キューの長さで警報を出すと負荷スパイクで誤報が出るが、「滞留時間」なら意味のある指標になる。

## どう活かすか

**「動的なメンバーシップ集合で合意を取る」構成は、レプリカのコストが高い場面での選択肢になる。** 過半数方式より必要台数が少なく、全員待ちより遅いメンバの影響を受けない。**成立条件は、メンバーシップの変更を承認する単一の権威があること。** それがないと split brain になる。Kafka は権威をコントローラに置き、そのコントローラ自身は過半数方式で合意している — **階層を分けて、それぞれに適した方式を使っている。**

**「不確実な遷移期間は、新旧両方の解釈で安全な側を選ぶ」は設定変更やメンバー変更で常に使える。** `maximalIsr` は 1 つのフィールドでしかないが、これがないと「申請中に何が起きるか」を場合分けすることになる。**遷移中の状態を型として表す (`PendingExpandIsr` / `PendingShrinkIsr`) と、場合分けが消える。**

**`NOT_ENOUGH_REPLICAS_AFTER_APPEND` から学べるのは、エラーの名前で「何が起きたか」を正確に伝える価値だ。** 単に `NOT_ENOUGH_REPLICAS` を返すと、クライアントは「書かれていない」と誤解する。`AFTER_APPEND` が付いていれば、「書かれた可能性がある」と分かる。**「失敗したが、副作用は起きているかもしれない」を表現できるエラー型を持っておく**と、リトライの設計が変わる。

**「絶対量ではなく追随できているかで判定する」は、しきい値設計の一般則として持ち帰りたい。** キュー長、遅延、バックログ — どれも絶対値でしきい値を切ると、負荷変動で誤報が出る。**「一定時間内に一度でも追いついたか」という形にすると、スケールに依存しない指標になる。**
