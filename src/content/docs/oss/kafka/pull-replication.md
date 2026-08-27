---
title: "フォロワーが取りに行く pull 型レプリケーション"
description: "Kafka のレプリケーションは、リーダーが押し込むのではなくフォロワーが取りに行く。しかもフォロワーが使うのは、コンシューマとまったく同じ Fetch API だ。フォロワースレッドは「切り詰め中」と「取得中」の 2 状態を持つ状態機械で、ログの食い違いをレプリケーションの一部として日常的に扱う。"
sidebar:
  order: 12
---

## 何を学んだか

### どんな状況の話か

リーダーが受け取ったレコードを、フォロワーにどうやって届けるか。素直な設計は **push** だ。リーダーが書き込みを受けたら、そのままフォロワーに送りつける。

push には次の問題がある。

- **フォロワーが遅いとき、リーダーがバッファを持つことになる。** 誰がどこまで受け取ったかをリーダーが管理し、未達分を再送用に保持する。フォロワーが 100 個あればバッファも 100 個。
- **フォロワーが復帰したとき、どこから送り直すかをリーダーが判断する。** フォロワーの状態をリーダーが知っている必要がある。
- **フォロワーが落ちているのか遅いだけなのか、送る側からは分かりにくい。**

### Kafka の答え

**フォロワーがリーダーに `Fetch` を送って取りに行く。しかも、コンシューマが使うのと同じ `Fetch` API を使う。**

1. **リーダーは状態を持たない。** 「offset X から N バイトください」に答えるだけ。フォロワーの進捗はリクエストに書いてある。
2. **バッファも再送も要らない。** データはすでにログにあり、フォロワーが好きなときに読みに来る。
3. **フェッチスレッドは「リーダーごと」に立てる。** パーティションごとではない。
4. **フォロワーは 2 つの状態を持つ状態機械になる。** `Truncating` (ログを切り詰め中) と `Fetching` (取得中)。
5. **フォロワーのフェッチが、リーダーの ISR 判定と high watermark を更新する。** 「取りに来た」こと自体が生存信号になる。

## ソースコードのどこか

### メインループ

```scala title="core/src/main/scala/kafka/server/AbstractFetcherThread.scala"
override def doWork(): Unit = {
  maybeTruncate()
  maybeFetch()
}
```

[`AbstractFetcherThread.scala#L112-L115`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherThread.scala#L112-L115)。

**2 行しかない。** これがフォロワーの全てで、無限に繰り返される。

- **`maybeTruncate`**: `Truncating` 状態のパーティションについて、どこまで切り詰めるかをリーダーに聞き、切り詰める。
- **`maybeFetch`**: `Fetching` 状態のパーティションについて、`Fetch` を投げてログに追記する。

### 2 つの状態

```java title="server/src/main/java/org/apache/kafka/server/ReplicaState.java"
/**
 * Represents the state of a replica.
 */
public enum ReplicaState {
    TRUNCATING { ... },
    FETCHING { ... }
}
```

[`ReplicaState.java#L19-L36`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/ReplicaState.java#L19-L36)。

```java title="server/src/main/java/org/apache/kafka/server/PartitionFetchState.java"
/**
 * Class to keep partition offset and its state (truncatingLog, delayed)
 * This represents a partition as being either:
 * (1) Truncating its log, for example, having recently become a follower
 * (2) Delayed, for example, due to an error, where we subsequently back off a bit
 * (3) ReadyForFetch, the active state where the thread is actively fetching data.
 */
public record PartitionFetchState(
        Optional<Uuid> topicId,
        long fetchOffset,
        Optional<Long> lag,
        int currentLeaderEpoch,
        Optional<Long> delay,
        ReplicaState state,
        Optional<Integer> lastFetchedEpoch,
        Optional<Long> dueMs
) {
```

[`PartitionFetchState.java#L27-L52`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/PartitionFetchState.java#L27-L52)。

**「切り詰め中」がレプリケーションの通常状態の 1 つとして定義されている**のが重要だ。異常系の特別処理ではない。

フォロワーになった直後は必ず `Truncating` から始まる。**自分のログがリーダーと食い違っているかもしれない**からで、それを毎回確認する。食い違いは例外ではなく、リーダー交代のたびに起こりうる普通のことだ ([leader epoch のページ](../leader-epoch/))。

### 切り詰めの 2 通り

```scala title="core/src/main/scala/kafka/server/AbstractFetcherThread.scala"
private def maybeTruncate(): Unit = {
  val (partitionsWithEpochs, partitionsWithoutEpochs) = fetchTruncatingPartitions()
  if (partitionsWithEpochs.nonEmpty) {
    truncateToEpochEndOffsets(partitionsWithEpochs)
  }
  if (partitionsWithoutEpochs.nonEmpty) {
    truncateToHighWatermark(partitionsWithoutEpochs)
  }
}
```

[`AbstractFetcherThread.scala#L172-L180`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherThread.scala#L172-L180)。

- **leader epoch を持っているなら**、リーダーに `OffsetsForLeaderEpoch` を投げて「あなたのそのエポックはどこで終わりましたか」と聞き、その位置まで切る。
- **持っていないなら**、high watermark まで切る。安全だが、余分に捨てることになる。

前者が [KIP-101](../leader-epoch/) で入った経路で、後者はそれ以前からある fallback だ。

### エラーは「遅らせる」で処理する

```scala title="core/src/main/scala/kafka/server/AbstractFetcherThread.scala"
// deal with partitions with errors, potentially due to leadership changes
private def handlePartitionsWithErrors(partitions: Iterable[TopicPartition], methodName: String): Unit = {
  if (partitions.nonEmpty) {
    debug(s"Handling errors in $methodName for partitions $partitions")
    delayPartitions(partitions, fetchBackOffMs)
  }
}
```

[`AbstractFetcherThread.scala#L138-L144`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherThread.scala#L138-L144)。

**「エラーが起きたパーティションは、しばらく飛ばす」。** リトライのロジックも、指数バックオフも、エラー種別ごとの分岐もない。次のループでまた試す。

これができるのは、**フェッチが冪等だから**だ。同じ offset をもう一度要求しても、同じデータが返るだけ。**pull 型にしたことで、エラー処理が「後でもう一度やる」に統一されている。**

### スレッドの割り当て

```scala title="core/src/main/scala/kafka/server/AbstractFetcherManager.scala"
private[server] def getFetcherId(topicPartition: TopicPartition): Int = {
  lock synchronized {
    Utils.abs(31 * topicPartition.topic.hashCode() + topicPartition.partition) % numFetchersPerBroker
  }
}
```

[`AbstractFetcherManager.scala#L111-L115`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherManager.scala#L111-L115)。

スレッドは **`(リーダーのブローカー ID, フェッチャ ID)` の組**ごとに 1 本立つ。パーティションはハッシュでフェッチャ ID に割り当てられる。

つまり、**1 本のスレッドが「あるブローカーから取ってくる複数パーティション」をまとめて担当する**。1 回の `Fetch` リクエストに、そのブローカーがリーダーになっている全パーティションが入る。

パーティションが 1 万個あってもスレッドは `ブローカー数 × num.replica.fetchers` 本にしかならない。**リクエスト数もスレッド数も、パーティション数に比例しない。**

同じブローカーへの既存スレッドがあれば使い回す。

```scala title="core/src/main/scala/kafka/server/AbstractFetcherManager.scala"
case Some(currentFetcherThread) if currentFetcherThread.leader.brokerEndPoint() == brokerAndFetcherId.broker =>
  // reuse the fetcher thread
  currentFetcherThread
case Some(f) =>
  f.shutdown()
  addAndStartFetcherThread(brokerAndFetcherId, brokerIdAndFetcherId)
```

[`AbstractFetcherManager.scala#L147-L156`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherManager.scala#L147-L156)。

**ブローカーのエンドポイントが変わっていたら (再起動などで) スレッドを作り直す。** 同じ ID でも別のプロセスかもしれないからだ。

### 受け取ったデータの処理

```scala title="core/src/main/scala/kafka/server/ReplicaFetcherThread.scala"
if (fetchOffset != log.logEndOffset)
  throw new IllegalStateException("Offset mismatch for partition %s: fetched offset = %d, log end offset = %d.".format(
    topicPartition, fetchOffset, log.logEndOffset))
...
// Append the leader's messages to the log
val logAppendInfo = partition.appendRecordsToFollowerOrFutureReplica(records, isFuture = false, partitionLeaderEpoch)
...
log.maybeUpdateHighWatermark(partitionData.highWatermark).ifPresent { newHighWatermark =>
  maybeUpdateHighWatermarkMessage = s"and updated replica high watermark to $newHighWatermark"
  partitionsWithNewHighWatermark += topicPartition
}

log.maybeIncrementLogStartOffset(leaderLogStartOffset, LogStartOffsetIncrementReason.LeaderOffsetIncremented)
```

[`ReplicaFetcherThread.scala#L113-L151`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/ReplicaFetcherThread.scala#L113-L151)。

3 つのことが起きている。

1. **バイト列をそのまま追記する。** `appendAsFollower` は offset を振り直さない。リーダーが決めた offset のまま書く ([レコードバッチのページ](../record-batch/))。
2. **high watermark をリーダーから教わって、自分のものを更新する。** フォロワーは HW を計算しない。**リーダーがフェッチ応答に入れてくる値を、そのまま採用する。**
3. **log start offset も同様。** リーダーが古いセグメントを消したら、その情報が伝わる。

**フォロワーは何も判断しない。** リーダーが決めたバイト列と 2 つの offset を、そのまま自分のログに反映するだけだ。

冒頭の `IllegalStateException` は、**フォロワーのログに穴が空くことを絶対に許さない**という宣言になっている。要求した offset と自分の LEO が一致しなければ、状態が壊れているので例外を投げる。

## なぜそうなっているか

### pull にすると、リーダーが状態を持たなくなる

pull 型の最大の効果は、**リーダー側にフォロワーごとの状態がなくなること**だ。

|                        | push             | pull                                 |
| ---------------------- | ---------------- | ------------------------------------ |
| フォロワーの進捗       | リーダーが管理   | **リクエストに書いてある**           |
| 未達データのバッファ   | 必要             | **不要 (ログにある)**                |
| フォロワー復帰時の再送 | リーダーが判断   | **フォロワーが好きな offset を要求** |
| フォロワーが遅いとき   | リーダーが詰まる | **そのフォロワーだけ遅れる**         |

**「ログという永続バッファがすでにある」から、pull が成立している。** メッセージをメモリにしか持たないシステムなら、フォロワーが取りに来るまで保持する仕組みを別に作ることになる。ログがあるので、それが要らない。

これは [ゼロコピー](../zero-copy/) とも噛み合う。リーダーはフォロワーにも `sendfile` でファイルから直接転送できる。**フォロワーへの複製とコンシューマへの配信が、同じコードパスを通る。**

### コンシューマと同じ API を使う意味

フォロワーが使う `Fetch` は、コンシューマが使うものと同じ RPC だ。違いは `replicaId` フィールドが設定されているかどうかで、これで「フォロワーからのフェッチ」と分かる。

**同じ API なので、フェッチ周りの最適化が両方に効く。**

- [purgatory による待機](../purgatory/) (`fetch.min.bytes` で溜まるまで待つ)
- [フェッチセッション](../fetch-session/) による増分リクエスト
- ゼロコピー転送

**新しい機能を追加したときも、実装が 1 箇所で済む。** レプリケーション専用のプロトコルを持っていたら、両方に実装することになる。

副作用として、**リーダーはフォロワーのフェッチを見て ISR を判定できる**。「取りに来ている = 生きていて追いついている」なので、別途ハートビートを送り合う必要がない ([ISR のページ](../isr-highwatermark/))。**データを取りに来る行為が、そのまま生存確認になっている。**

### 「切り詰め中」を通常状態にする

多くのシステムでは、レプリカの不整合は「修復すべき異常」として扱われる。Kafka では **`Truncating` がフォロワーの初期状態**になっている。

理由は、**リーダー交代のたびに食い違いが起こりうる**からだ。

1. リーダー A が offset 100 まで書いた。high watermark は 95。
2. A が落ちる。フォロワー B (offset 95 まで) がリーダーになる。
3. A が復帰する。A は 96〜100 を持っているが、B は持っていない。

**A は 96〜100 を捨てなければならない。** これは障害でも破損でもなく、`acks=all` の契約 (「HW までは保証する、それより先は保証しない」) の通りの結果だ。

**契約の範囲内で起こることを異常系にすると、コードが「異常系」だらけになる。** 通常状態として扱えば、`doWork` は 2 行で書ける。

### エラー処理が「後でもう一度」で済む理由

`handlePartitionsWithErrors` が `delayPartitions` を呼ぶだけなのは、**フェッチに副作用がなく、冪等だから**だ。

リーダーが変わった、パーティションが移動した、ディスクが壊れた — どれも「次のループで、そのときの状態に従ってやり直す」で正しい結果になる。**状態遷移を明示的に追わなくても、毎回ゼロから判断すれば収束する。**

これは宣言的な調停ループ (Kubernetes のコントローラなど) と同じ形で、**「現在の望ましい状態と実際の状態を比べて、差を埋める」を繰り返す**。イベントを取りこぼしても、次のループで直る。

### スレッドをリーダー単位にする理由

パーティションごとにスレッドを立てると、1 万パーティションで 1 万スレッドになる。逆に 1 本にすると、遅いブローカーが全体を止める。

**「リーダーのブローカーごと」は、その中間として自然な単位**だ。

- 同じブローカーへのリクエストは 1 本にまとめられる (ネットワーク効率)。
- あるブローカーが遅くても、他のブローカーからのフェッチは進む (障害の隔離)。
- スレッド数はクラスタのブローカー数に比例し、パーティション数には比例しない。

`num.replica.fetchers` はこれをさらに分割する設定で、1 本のスレッドが CPU を使い切る場合に増やす。

## どう活かすか

**「push を pull に変えると、送信側の状態がなくなる」は、ファンアウトのある配信で常に検討する価値がある。** 受信側の進捗・バッファ・再送を送信側が持たなくてよくなり、遅い受信者が他に影響しなくなる。**成立条件は「データがすでに永続化されていて、後から任意の位置を読める」こと。** ログ、イベントストア、オブジェクトストレージがあるなら成立する。メモリ上のキューしかないなら、まずそこを作ることになる。

**「内部の複製と外部への配信に同じ API を使う」という判断は、機能追加のコストを半分にする。** Kafka はレプリケーション専用のプロトコルを持たない。**同じ API にできるかは「両者が本質的に同じ操作か」で決まる**が、同じにできるなら最適化もバグ修正も 1 回で済む。副次的に、複製のトラフィックが外部トラフィックと同じ計測・制限の対象になるという利点もある ([クォータのページ](../quota-throttle/))。

**「契約の範囲内で起こることを、通常状態としてモデル化する」は、状態機械を単純に保つコツだ。** Kafka のフォロワーが `Truncating` から始まるのは、切り詰めが例外ではないからである。**「異常系」として書いたコードは、頻度が上がると必ず破綻する。** 起こりうる頻度を見積もって、日常的に起きるなら通常状態に格上げする。

**「エラーは遅らせて、次のループで最初から判断する」は、操作が冪等なら強力に効く。** 個別のリトライ戦略も、状態遷移の追跡も要らない。**逆に、操作に副作用があるなら使えない。** 「もう一度やっても同じ結果か」を先に確認する必要がある。
