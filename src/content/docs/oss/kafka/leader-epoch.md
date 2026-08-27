---
title: "leader epoch を入れるまで、ログは静かに食い違っていた"
description: "high watermark だけを頼りに切り詰めると、リーダー交代の順番によってレプリカ間でデータが食い違う。しかもエラーは出ない。Kafka は「リーダーが何代目か」と「その代が何 offset から始まったか」を各レプリカに記録させ、切り詰め位置をその履歴から決めるようにした。世代番号を持つことが正しさの前提になる、という一般則の実例になっている。"
group: "レプリケーション"
sidebar:
  order: 13
---

## 何を学んだか

### どんな状況の話か

[pull 型レプリケーション](../pull-replication/) のページで、フォロワーはリーダーになる前に自分のログを切り詰めると書いた。**どこまで切り詰めるか** が問題だ。

素朴な答えは「high watermark まで」だ。HW より先は「全 ISR が持っている」と保証されていない領域なので、捨てても契約違反にならない。

これで一見足りているように見える。だが、次のシナリオで壊れる。

```text
初期状態: A がリーダー、B がフォロワー。両方 offset 0〜9 を持つ。HW = 10。

1. A が offset 10 を書く。A: [0..10], B: [0..9]。HW はまだ 10。
2. B が落ちる。
3. A も落ちる。
4. B が先に復帰する。ISR に A しかいなかったので、unclean 選出で B がリーダーになる。
   B: [0..9]。B が offset 10 に別のレコードを書く。B: [0..10']。
5. A が復帰する。A は HW = 10 まで切り詰める → 何も切り詰めない。A: [0..10]。
6. A がフォロワーとして offset 11 からフェッチを始める。

結果: A の offset 10 は「10」、B の offset 10 は「10'」。
      両者は食い違ったまま、エラーも出ずに複製が進む。
```

**同じ offset に違うレコードが入り、誰も気づかない。** これが KIP-101 が解いた問題だ。

問題の本質は、**「offset 10」という座標だけでは、どの世代のリーダーが書いたものか区別できない**ことにある。

### Kafka の答え

**「リーダーが何代目か (leader epoch)」と「その代が何 offset から始まったか」を、各レプリカがファイルに記録する。**

1. **コントローラがリーダーを決めるたびに epoch を 1 つ増やす。** 単調増加する世代番号。
2. **レプリカは `(epoch, その epoch の開始 offset)` の列を `leader-epoch-checkpoint` に持つ。**
3. **各レコードバッチのヘッダにも、書かれたときの epoch が入っている** ([レコードバッチのページ](../record-batch/))。
4. **フォロワーは「自分の最後の epoch はどこで終わりましたか」をリーダーに聞き、その位置まで切る。**
5. **今はフェッチ応答自体に「食い違いが起きた epoch と offset」が入ってくる。** 別の RPC を投げなくてよくなった。

上のシナリオでは、A の offset 10 は epoch 1 で書かれ、B の offset 10' は epoch 2 で書かれる。A が B に「epoch 1 はどこで終わりましたか」と聞くと、B は「offset 10 で終わりました」と答える (B にとって epoch 1 は 0〜9 なので)。A は offset 10 まで切り詰めて、10' を取り直す。

## ソースコードのどこか

### 記録されるもの

```java title="storage/src/main/java/org/apache/kafka/storage/internals/epoch/LeaderEpochFileCache.java"
/**
 * Represents a cache of (LeaderEpoch => Offset) mappings for a particular replica.
 * <p>
 * Leader Epoch = epoch assigned to each leader by the controller.
 * Offset = offset of the first message in each epoch.
 */
public final class LeaderEpochFileCache {
    ...
    private final TreeMap<Integer, EpochEntry> epochs = new TreeMap<>();
```

[`LeaderEpochFileCache.java#L36-L52`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/epoch/LeaderEpochFileCache.java#L36-L52)。

**エントリは `(epoch, その epoch の最初のレコードの offset)` の 2 つ組だけ。** `TreeMap` なので epoch 順に並び、`floorEntry` / `higherEntry` で前後を引ける。

永続化先は `leader-epoch-checkpoint` というテキストファイルで、パーティションのディレクトリに置かれる。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/checkpoint/LeaderEpochCheckpointFile.java"
private static final String LEADER_EPOCH_CHECKPOINT_FILENAME = "leader-epoch-checkpoint";
```

[`LeaderEpochCheckpointFile.java#L45`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/checkpoint/LeaderEpochCheckpointFile.java#L45)。

**リーダーが交代するたびに 1 行増えるだけ**なので、通常は数行から数十行にしかならない。

### 「その epoch はどこで終わったか」に答える

```java title="storage/src/main/java/org/apache/kafka/storage/internals/epoch/LeaderEpochFileCache.java"
/**
 * Returns the Leader Epoch and the End Offset for a requested Leader Epoch.
 * <p>
 * The Leader Epoch returned is the largest epoch less than or equal to the requested Leader
 * Epoch. The End Offset is the end offset of this epoch, which is defined as the start offset
 * of the first Leader Epoch larger than the Leader Epoch requested, or else the Log End
 * Offset if the latest epoch was requested.
 */
public Map.Entry<Integer, Long> endOffsetFor(int requestedEpoch, long logEndOffset) {
```

[`LeaderEpochFileCache.java#L268-L284`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/epoch/LeaderEpochFileCache.java#L268-L284)。

**「epoch N の終わり」= 「epoch N より大きい最初の epoch の開始 offset」。** 開始 offset しか記録していないのに終わりが引けるのは、epoch が連続した区間に分割されているからだ。

分岐が 5 つある。それぞれが実際に起きる状況に対応している。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/epoch/LeaderEpochFileCache.java"
if (requestedEpoch == UNDEFINED_EPOCH) {
    // This may happen if a bootstrapping follower sends a request with undefined epoch or
    // a follower is on the older message format where leader epochs are not recorded
    epochAndOffset = new AbstractMap.SimpleImmutableEntry<>(UNDEFINED_EPOCH, UNDEFINED_EPOCH_OFFSET);
} else if (latestEpoch().isPresent() && latestEpoch().get() == requestedEpoch) {
    // For the leader, the latest epoch is always the current leader epoch that is still being written to.
    // Followers should not have any reason to query for the end offset of the current epoch, but a consumer
    // might if it is verifying its committed offset following a group rebalance. In this case, we return
    // the current log end offset which makes the truncation check work as expected.
    epochAndOffset = new AbstractMap.SimpleImmutableEntry<>(requestedEpoch, logEndOffset);
} else {
```

[`LeaderEpochFileCache.java#L285-L296`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/epoch/LeaderEpochFileCache.java#L285-L296)。

**この API を使うのはフォロワーだけではない。** コメントにあるとおり、**コンシューマもリバランスの後にコミット済み offset を検証するために使う**。「自分が覚えている offset は、まだ有効か」を確かめる。

「まだ書かれている最新の epoch」を聞かれたら LEO を返す — つまり「まだ終わっていない」を「今のところここまで」と答える。

もう 1 つ、履歴が失われている場合の扱い。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/epoch/LeaderEpochFileCache.java"
Map.Entry<Integer, EpochEntry> floorEntry = epochs.floorEntry(requestedEpoch);
if (floorEntry == null) {
    // The requested epoch is smaller than any known epoch, so we return the start offset of the first
    // known epoch which is larger than it. This may be inaccurate as there could have been
    // epochs in between, but the point is that the data has already been removed from the log
    // and we want to ensure that the follower can replicate correctly beginning from the leader's
    // start offset.
    epochAndOffset = new AbstractMap.SimpleImmutableEntry<>(requestedEpoch, higherEntry.getValue().startOffset());
```

[`LeaderEpochFileCache.java#L305-L313`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/epoch/LeaderEpochFileCache.java#L305-L313)。

**保持期間で古いセグメントが消えると、対応する epoch エントリも消える。** そのとき「知らない epoch」を聞かれたら、知っている最古の epoch の開始位置を返す。`This may be inaccurate` と明記されているが、**どうせそのデータはもう存在しないので、そこから複製し直せば正しくなる**。

### フォロワー側の切り詰め

```scala title="core/src/main/scala/kafka/server/AbstractFetcherThread.scala"
fetchedEpochs.foreachEntry { (tp, leaderEpochOffset) =>
  if (partitionStates.contains(tp)) {
    Errors.forCode(leaderEpochOffset.errorCode) match {
      case Errors.NONE =>
        val offsetTruncationState = getOffsetTruncationState(tp, leaderEpochOffset)
        info(s"Truncating partition $tp with $offsetTruncationState due to leader epoch and offset $leaderEpochOffset")
        if (doTruncate(tp, offsetTruncationState))
          fetchOffsets.put(tp, offsetTruncationState)

      case Errors.FENCED_LEADER_EPOCH =>
```

[`AbstractFetcherThread.scala#L266-L275`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherThread.scala#L266-L275)。

**`FENCED_LEADER_EPOCH` の扱い**が興味深い。

```scala title="core/src/main/scala/kafka/server/AbstractFetcherThread.scala"
private def onPartitionFenced(tp: TopicPartition, requestEpoch: Optional[Integer]): Boolean =
  LockUtils.inLock(partitionMapLock, () => {
  Option(partitionStates.stateValue(tp)).exists { currentFetchState =>
    val currentLeaderEpoch = currentFetchState.currentLeaderEpoch
    if (requestEpoch.isPresent && requestEpoch.get == currentLeaderEpoch) {
      info(s"Partition $tp has an older epoch ($currentLeaderEpoch) than the current leader. Will await " +
        s"the new LeaderAndIsr state before resuming fetching.")
      markPartitionFailed(tp)
      false
    } else {
      info(s"Partition $tp has a newer epoch ($currentLeaderEpoch) than the current leader. Retry the partition later.")
      true
    }
  }
})
```

[`AbstractFetcherThread.scala#L300-L314`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherThread.scala#L300-L314)。

**「自分の epoch が古い」と言われたとき、2 通りある。**

- リクエストを投げたときの epoch が今も自分の epoch と同じ → **自分が本当に古い。** コントローラから新しい情報が来るまで待つ。
- 投げた後に自分の epoch が更新されている → **リクエストが古かっただけ。** すぐリトライする。

**「エラーの原因が自分の古さなのか、リクエストの古さなのか」を区別している。** 非同期に状態が更新される環境で、応答が返ってきたときには前提が変わっているという状況を、明示的に扱っている。

### 今は Fetch 応答に食い違いが載ってくる

```scala title="core/src/main/scala/kafka/server/AbstractFetcherThread.scala"
if (leader.isTruncationOnFetchSupported && FetchResponse.isDivergingEpoch(partitionData)) {
  // If a diverging epoch is present, we truncate the log of the replica
  // but we don't process the partition data in order to not update the
  // low/high watermarks until the truncation is actually done. Those will
  // be updated by the next fetch.
  divergingEndOffsets += topicPartition -> new EpochEndOffset()
    .setPartition(topicPartition.partition)
    .setErrorCode(Errors.NONE.code)
    .setLeaderEpoch(partitionData.divergingEpoch.epoch)
    .setEndOffset(partitionData.divergingEpoch.endOffset)
} else {
```

[`AbstractFetcherThread.scala#L356-L366`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherThread.scala#L356-L366)。

当初の KIP-101 では、フォロワーになるたびに `OffsetsForLeaderEpoch` という専用 RPC を投げていた。**今はフェッチリクエストに「自分が最後に取得した epoch」を載せ、リーダーが食い違いを検出したら応答に `divergingEpoch` を入れて返す。**

RPC が 1 往復減るだけでなく、**「フォロワーになった直後」以外でも食い違いを検出できる**ようになった。フェッチのたびに検査しているからだ。

コメントの `we don't process the partition data in order to not update the low/high watermarks until the truncation is actually done` が丁寧で、**食い違いを見つけたら、そのレスポンスに入っていたデータは使わない**。切り詰めが終わってから、次のフェッチで取り直す。

### 追記時にも epoch を見ている

```scala title="core/src/main/scala/kafka/server/AbstractFetcherThread.scala"
/* Once we hand off the partition data to the subclass, we can't mess with it any more in this thread
 *
 * When appending batches to the log only append record batches up to the leader epoch when the FETCH
 * request was handled. This is done to make sure that logs are not inconsistent because of log
 * truncation and append after the FETCH request was handled. See KAFKA-18723 for more details.
 */
val logAppendInfoOpt = processPartitionData(
  topicPartition,
  currentFetchState.fetchOffset,
  currentFetchState.currentLeaderEpoch,
  partitionData
)
```

[`AbstractFetcherThread.scala#L367-L378`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/AbstractFetcherThread.scala#L367-L378)。

`KAFKA-18723` の参照が付いている。**フェッチのリクエストを投げてから応答が返るまでの間に、リーダーが切り詰めて別のデータを書いた**場合、応答には新旧のバッチが混ざりうる。**「フェッチを処理した時点の epoch まで」しか追記しない**ことで、これを防いでいる。

leader epoch が入って 8 年経った後でも、この種のバグが見つかっている。

## なぜそうなっているか

### offset だけでは足りない理由

問題を一般化すると、**「offset 10」というアドレスが、時間をまたいで一意でない**ということだ。リーダーが交代すると、同じアドレスに別の内容が入りうる。

これは分散システムで繰り返し出てくる形で、解き方も定型化している。**アドレスに世代番号を付ける。**

| システム                | 世代番号                      |
| ----------------------- | ----------------------------- |
| Kafka                   | leader epoch                  |
| Raft                    | term                          |
| ZooKeeper               | zxid の上位 32 ビット (epoch) |
| GFS / HDFS              | generation stamp              |
| Kubernetes の楽観ロック | resourceVersion               |

**共通するのは、「単調増加する番号を、権威を持つ 1 箇所が発行する」こと。** Kafka では[コントローラ](../quorum-controller/)が発行する。発行元が 1 つでないと、番号が単調増加しない。

### なぜ HW だけでは検出できなかったのか

HW は「全 ISR が持っている位置」を表す。**「持っている」は長さの情報であって、内容の情報ではない。**

冒頭のシナリオで、A も B も offset 10 を「持っている」。長さは一致している。**食い違っているのは内容だ。** 長さしか見ていない仕組みでは、原理的に検出できない。

leader epoch を入れると、**「offset 10 は epoch 1 のもの」「offset 10 は epoch 2 のもの」と、内容の由来が区別できる**ようになる。バイト列を比較しなくても、由来が違えば違うと分かる。

**「内容そのものではなく、内容の由来を比較する」** のがこの手法の要点で、比較コストが O(1) になる。

### なぜ開始 offset だけを記録するのか

`(epoch, 開始 offset, 終了 offset)` を記録すれば「終わり」が直接引ける。だが Kafka は開始しか持たない。

理由は **「現在の epoch には終わりがない」** からだ。書き込みが続いている限り終了 offset は決まらない。記録しようとすると、書き込みのたびに更新することになる。

開始だけなら **epoch が変わるときに 1 回書くだけ**で済む。終わりは「次の epoch の開始」として計算できる。**「区間の列」を「境界の列」として持つ**のは、時系列データで一般的な圧縮でもある。

### なぜ専用 RPC からフェッチ応答に移したのか

当初の設計は「フォロワーになったときに 1 回検査する」だった。これで冒頭のシナリオは防げる。

だが、**リーダーが交代してからフォロワーがそれを知るまでには遅延がある**。その間、古いリーダーを相手にフェッチし続けているかもしれない。

フェッチのたびに epoch を送って検査すれば、**遅延の影響を受けずに、その場で食い違いが分かる**。しかも往復が減る。

**「稀な検査を専用の経路でやる」から「常時の経路に検査を埋め込む」への移行**は、検査が十分に安いときには常に良い方向に働く。フェッチリクエストに 4 バイト足すだけなら、コストはほぼゼロだ。

## どう活かすか

**「アドレスや位置に世代番号を添える」は、リーダーが交代しうるシステムでは必須に近い。** ファイルのオフセット、シャードの ID、レコードのバージョン — **書き手が交代しうるなら、書き手の世代を一緒に記録する。** これがないと、食い違いが「静かに」起きる。エラーも例外も出ないので、発見はたいてい何ヶ月も後になる。

**「長さの一致は内容の一致を意味しない」は、複製やキャッシュの検証で繰り返し踏む落とし穴だ。** サイズ、件数、最終更新時刻 — どれも一致していて内容が違う状況がありうる。**内容の同一性を安く判定したいなら、内容のハッシュか、内容の由来 (世代番号) を持つ。** Kafka は後者を選んだ。前者より安く、切り詰め位置まで分かるからだ。

**「区間の列を境界の列として持つ」は、追記されていく区間データに使える。** 終端を記録しないので、更新が「区間が変わるとき 1 回」になる。**引くときに `floorEntry`/`higherEntry` の 2 回になるが、書き込み頻度が読み取り頻度より高い場合はこちらが得。**

**「応答が古い前提に基づいていないか」を区別する習慣も持ち帰りたい。** `onPartitionFenced` が「リクエスト時の epoch と現在の epoch が同じか」を見ているのは、**非同期な世界で「エラーが返ってきた理由」を正確に判定するため**だ。単に「エラーだからリトライ」にすると、本当に古い場合に無駄なリトライを繰り返す。**リクエストに前提となる状態のバージョンを載せておくと、応答を受け取ったときにこの区別ができる。**
