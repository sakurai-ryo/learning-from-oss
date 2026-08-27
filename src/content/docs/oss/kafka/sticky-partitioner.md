---
title: "キーのないレコードは、バッチが埋まるまで同じパーティションへ"
description: "キーがないレコードをラウンドロビンで配ると、パーティション数だけ小さなバッチができる。Kafka は「一定バイト数を書くまで同じパーティションに貼り付く」方式に変えた。さらに、切り替え先を「バッチの溜まっていないパーティション」に寄せる。累積度数表を作って二分探索する、という重み付き抽選が入っている。"
sidebar:
  order: 27
---

## 何を学んだか

### どんな状況の話か

プロデューサがレコードを送るとき、**キーがあればそのハッシュでパーティションが決まる。** 同じキーは同じパーティションに行き、順序が保たれる。

**キーがない場合はどうするか。** 素朴にはラウンドロビンだ。パーティション 0, 1, 2, 0, 1, 2 … と順に配る。

これが[アキュムレータ](../record-accumulator/)と相性が悪い。

```text
パーティションが 30 個、linger.ms=0、毎秒 300 レコード送るとする。
ラウンドロビンなら、各パーティションに毎秒 10 レコード。

Sender が 1 回送信する間 (数ミリ秒) に到着するのは数レコード。
それが 30 パーティションに散らばる。
  → 30 個のバッチが、それぞれ 1 レコードずつで送られる。
```

**バッチングがまったく効かない。** [レコードバッチのヘッダ](../record-batch/) 61 バイトを、1 レコードごとに払うことになる。しかも 30 個のパーティションが別々のブローカーにあれば、リクエストも 30 本になる。

### Kafka の答え

**一定バイト数を書き終えるまで、同じパーティションに貼り付く (sticky)。**

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java"
/**
 * Built-in default partitioner.  Note, that this is just a utility class that is used directly from
 * RecordAccumulator, it does not implement the Partitioner interface.
 *
 * The class keeps track of various bookkeeping information required for adaptive sticky partitioning
 * (described in detail in KIP-794).  There is one partitioner object per topic.
 */
public class BuiltInPartitioner {
```

[`BuiltInPartitioner.java#L33-L40`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java#L33-L40)。

1. **`batch.size` バイト書いたら、次のパーティションに切り替える。**
2. **切り替え先は一様ランダムではなく、「キューが短いパーティション」に重み付けする。**
3. **重み付けは累積度数表 + 二分探索。**
4. **バッチが送信可能でないときは、切り替えを見送る。** 中途半端なバッチを作らないため。
5. **`Partitioner` インタフェースを実装していない。** アキュムレータから直接呼ばれるユーティリティになっている。

## ソースコードのどこか

### 貼り付きの判定

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java"
// We're trying to switch partition once we produce stickyBatchSize bytes to a partition
// but doing so may hinder batching because partition switch may happen while batch isn't
// ready to send.  This situation is especially likely with high linger.ms setting.
// Consider the following example:
//   linger.ms=500, producer produces 12KB in 500ms, batch.size=16KB
//     - first batch collects 12KB in 500ms, gets sent
//     - second batch collects 4KB, then we switch partition, so 4KB gets eventually sent
//     - ... and so on - we'd get 12KB and 4KB batches
// To get more optimal batching and avoid 4KB fractional batches, the caller may disallow
// partition switch if batch is not ready to send, so with the example above we'd avoid
// fractional 4KB batches: in that case the scenario would look like this:
//     - first batch collects 12KB in 500ms, gets sent
//     - second batch collects 4KB, but partition switch doesn't happen because batch in not ready
//     - second batch collects 12KB in 500ms, gets sent and now we switch partition.
//     - ... and so on - we'd just send 12KB batches
// We cap the produced bytes to not exceed 2x of the batch size to avoid pathological cases
// (e.g. if we have a mix of keyed and unkeyed messages, key messages may create an
// unready batch after the batch that disabled partition switch becomes ready).
```

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java"
if (producedBytes >= stickyBatchSize && enableSwitch || producedBytes >= stickyBatchSize * 2) {
    // We've produced enough to this partition, switch to next.
```

[`BuiltInPartitioner.java#L229-L255`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java#L229-L255)。

**コメントが 20 行、コードが 1 行。** そして、そのコメントに **具体的な数値例が 2 つ**書かれている。

「`batch.size` に達したら切り替える」という素朴な規則の何が悪いか。**バッチの境界と、切り替えの境界がずれる。**

`linger.ms=500` で 500 ms に 12 KB 流れるとすると、`batch.size=16 KB` には届かない。それでも 500 ms でバッチは送信される。**すると、次のバッチが 4 KB たまったところで「合計 16 KB 書いた」ことになり、切り替わる。** 4 KB の中途半端なバッチができる。

対策は、**「バッチが送信可能でないなら、切り替えを見送る」**。ただし見送り続けると別の問題が出るので、`stickyBatchSize * 2` で強制的に切り替える。

**`&&` と `||` が 1 行に混ざった条件式**だが、意味は「送信可能なら 1 倍で切り替え、そうでなくても 2 倍を超えたら切り替え」。

### 切り替え先の選び方

一様ランダムではなく、**キューの短いパーティションを優先する**。その仕組みが累積度数表だ。

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java"
// We build cumulative frequency table from the queue sizes in place.  At the beginning
// each entry contains queue size, then we invert it (so it represents the frequency)
// and convert to a running sum.  Then a uniformly distributed random variable
// in the range [0..last) would map to a partition with weighted probability.
// Example: suppose we have 3 partitions with the corresponding queue sizes:
//  0 3 1
// Then we can invert them by subtracting the queue size from the max queue size + 1 = 4:
//  4 1 3
// Then we can convert it into a running sum (next value adds previous value):
//  4 5 8
// Now if we get a random number in the range [0..8) and find the first value that
// is strictly greater than the number (e.g. for 4 it would be 5), then the index of
// the value is the index of the partition we're looking for.  In this example
// random numbers 0, 1, 2, 3 would map to partition[0], 4 would map to partition[1]
// and 5, 6, 7 would map to partition[2].
```

[`BuiltInPartitioner.java#L288-L303`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java#L288-L303)。

**キューの長さを「重み」に変換する 3 ステップ。**

```text
キューの長さ:     [0, 3, 1]    ← パーティション 1 が詰まっている
反転 (max+1 - x): [4, 1, 3]    ← 空いているほど大きい
累積和:           [4, 5, 8]    ← 抽選用のテーブル
```

**0〜7 の乱数を引いて、「それより大きい最初の値」の位置が当選パーティション。** パーティション 0 は 4/8、パーティション 1 は 1/8、パーティション 2 は 3/8 の確率になる。

**「キューが短いほど選ばれやすい」が、割り算なしで実現されている。**

引くのは二分探索だ。

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java"
int[] cumulativeFrequencyTable = partitionLoadStatsToUse.cumulativeFrequencyTable;
int weightedRandom = random % cumulativeFrequencyTable[partitionLoadStatsToUse.length - 1];

// By construction, the cumulative frequency table is sorted, so we can use binary
// search to find the desired index.
int searchResult = Arrays.binarySearch(cumulativeFrequencyTable, 0, partitionLoadStatsToUse.length, weightedRandom);

// binarySearch results the index of the found element, or -(insertion_point) - 1
// (where insertion_point is the index of the first element greater than the key).
// We need to get the index of the first value that is strictly greater, which
// would be the insertion point, except if we found the element that's equal to
// the searched value (in this case we need to get next).  For example, if we have
//  4 5 8
// and we're looking for 3, then we'd get the insertion_point = 0, and the function
// would return -0 - 1 = -1, by adding 1 we'd get 0.  If we're looking for 4, we'd
// get 0, and we need the next one, so adding 1 works here as well.
int partitionIndex = Math.abs(searchResult + 1);
```

[`BuiltInPartitioner.java#L113-L131`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java#L113-L131)。

**`Math.abs(searchResult + 1)` の 1 行に、8 行のコメントが付いている。**

`Arrays.binarySearch` は「見つかったらそのインデックス、見つからなければ `-(挿入位置) - 1`」を返す。**両方のケースで `+1` して絶対値を取ると、欲しいインデックスになる** — という気づきにくい性質を、具体例で説明している。

### 無駄をしない分岐

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java"
if (allEqual && length == queueSizes.length) {
    // No need to have complex probability logic when all queue sizes are the same,
    // and we didn't exclude partitions that experience high latencies (greater than
    // partitioner.availability.timeout.ms).
    log.trace("All queue lengths are the same, not using adaptive for topic {}", topic);
    partitionLoadStatsHolder = null;
```

[`BuiltInPartitioner.java#L327-L332`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java#L327-L332)。

**全パーティションのキューが同じ長さなら、統計を捨てて一様ランダムに戻す。** 重み付けする意味がないからだ。

これが実は普通のケースになる。**負荷が均等に捌けているクラスタでは、キューは全部 0 だ。** 累積度数表を作らず、二分探索もしない。

**「最適化が必要ないケースを検出して、最適化を外す」** という判断が入っている。

### 並行制御

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java"
/**
 * Peek currently chosen sticky partition.  This method works in conjunction with {@link #isPartitionChanged}
 * and {@link #updatePartitionInfo}.  The workflow is the following:
 *
 * 1. peekCurrentPartitionInfo is called to know which partition to lock.
 * 2. Lock partition's batch queue.
 * 3. isPartitionChanged under lock to make sure that nobody raced us.
 * 4. Append data to buffer.
 * 5. updatePartitionInfo to update produced bytes and maybe switch partition.
 *
 *  It's important that steps 3-5 are under partition's batch queue lock.
 */
StickyPartitionInfo peekCurrentPartitionInfo(Cluster cluster) {
    StickyPartitionInfo partitionInfo = stickyPartitionInfo.get();
    if (partitionInfo != null)
        return partitionInfo;

    // We're the first to create it.
    partitionInfo = new StickyPartitionInfo(nextPartition(cluster));
    if (stickyPartitionInfo.compareAndSet(null, partitionInfo))
        return partitionInfo;

    // Someone has raced us.
    return stickyPartitionInfo.get();
}
```

[`BuiltInPartitioner.java#L159-L186`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java#L159-L186)。

**「どのパーティションか」を知らないとロックが取れないが、ロックを取る前に読んだ値は変わりうる。** ニワトリと卵になっている。

解決は **「読んで、ロックして、変わっていないか確認して、変わっていたらやり直す」**。[アキュムレータの `while (true)` ループ](../record-accumulator/) はこれのためにある。

手順が javadoc に 5 ステップで書かれ、**「3〜5 はロックの中でやること」**という制約が明示されている。CAS も使われていて、**ロックフリーな初期化と、ロック内での検証を組み合わせている。**

### インタフェースを実装しない

javadoc の 1 行目に、

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java"
 * Built-in default partitioner.  Note, that this is just a utility class that is used directly from
 * RecordAccumulator, it does not implement the Partitioner interface.
```

**`Partitioner` インタフェースを実装していない。**

`Partitioner` は `partition(topic, key, keyBytes, value, valueBytes, cluster)` を返すだけの単純なインタフェースで、**「今どれだけ書いたか」「バッチが送信可能か」を渡す手段がない。**

インタフェースを拡張することもできたが、**既存のカスタムパーティショナが全部壊れる。** だから、組み込みのものだけをインタフェースの外に出した。

**「拡張点の外に、特権的な実装を置く」** という判断で、後方互換性を優先している。

## なぜそうなっているか

### なぜラウンドロビンが悪いのか

問題の本質は、**「バッチが埋まる速度」と「パーティション数」が反比例する**ことにある。

同じスループットなら、パーティションを増やすほど 1 パーティションあたりの流量が減り、バッチが小さくなる。**パーティションを増やしてスループットを上げようとすると、逆にバッチ効率が落ちる。**

sticky なら、**パーティション数に関係なく、常に 1 つのパーティションに集中して書く。** バッチは `batch.size` まで埋まる。

**代償は、短期的にパーティション間の分布が偏ること。** ただし `batch.size` ごとに切り替わるので、**長期的には均等になる。** 「順序を気にしないレコード」という前提があるからこそ、短期の偏りを許容できる。

### なぜキューの長さで重み付けするのか

sticky にすると、**遅いブローカーのパーティションに貼り付いてしまうリスク**がある。そのパーティションのキューが詰まり、[メモリプール](../record-accumulator/)を食い、他のパーティションへの書き込みまで止まる。

キューの長さは **「そのパーティションのブローカーが遅れている」の代理指標**になる。詰まっているところを避ければ、自然に速いブローカーへ流れる。

**「負荷を測って避ける」ではなく「詰まりを測って避ける」** — 測定が安く、しかも結果として同じことになる。

`partitioner.availability.timeout.ms` を設定すると、**一定時間応答がないパーティションは候補から完全に除外される。** 重み付けよりさらに強い措置になる。

### なぜ累積度数表なのか

重み付き抽選の実装は、素朴には次のようになる。

```text
total = 重みの合計
r = random(0, total)
for each partition:
    r -= 重み
    if r < 0: return partition
```

これは O(n)。パーティションが 1000 個あれば 1000 回のループを **レコードごとに** 回す。

累積度数表を先に作っておけば、**抽選は二分探索の O(log n)。** 表の構築は O(n) だが、**それは Sender スレッドが `ready()` を呼ぶときに 1 回だけ**やればいい。

**「頻繁な操作を安くするために、稀な操作で前計算する」** という典型的なトレードオフになっている。しかも、表は `queueSizes` 配列を **その場で書き換えて**作るので、割り当ても発生しない (`NOTE: queueSizes are modified in place to avoid allocations`)。

### なぜコメントがこれほど長いのか

このクラスは、コード 500 行に対してコメントが極端に多い。理由は 3 つある。

- **数値例がないと理解できない。** 「12 KB と 4 KB のバッチができる」は、例を出さないと伝わらない。
- **`Math.abs(searchResult + 1)` は、コメントなしでは意図が読めない。** JDK の API の返り値の仕様に依存している。
- **並行制御の手順が、呼び出し側との約束になっている。** 「3〜5 はロックの中で」は、このクラスだけを見ても分からない。

**「1 行のコードに 20 行のコメント」は、そのコードが 20 行分の判断を圧縮している**ということでもある。

## どう活かすか

**「ラウンドロビンをやめて、一定量ごとに切り替える」は、バッチングを伴う分散書き込みで効く。** ログ集約、シャーディングされた DB への書き込み、複数のワーカーへのタスク配布 — **順序が要らないなら、分散させるより集中させたほうがバッチ効率が上がる。** 「均等に配る」が反射的な選択になりがちだが、**受け側にバッチングがあるなら逆効果になる。**

**「切り替えの境界を、下流のバッチ境界に合わせる」という配慮も持ち帰りたい。** 単純に「N バイトごとに切り替え」だと、下流のフラッシュ周期とずれて中途半端なバッチが残る。**下流の状態 (送信可能かどうか) を見て切り替えを遅らせると、境界が揃う。** ただし遅らせすぎないように上限 (2 倍) を置く。

**「キューの長さを、下流の遅さの代理指標にする」は安くて効果的だ。** レイテンシを測るには応答時間の統計が要るが、キューの長さは数えるだけで分かる。**しかも「詰まっている」という事実そのものを測っているので、原因が何であれ避けられる。**

**重み付き抽選が頻繁に必要なら、累積度数表 + 二分探索を先に思い出す。** 線形走査は要素数が増えると効かない。**重みが変わる頻度と抽選の頻度に差があるほど、前計算が効く。**

**そして、「1 行に 20 行のコメント」を書くことをためらわない。** 数値例、API の仕様への依存、呼び出し側との約束 — **コードから復元できない情報は、量に関係なく書く。** 逆に言えば、コメントが極端に長い箇所は「ここに判断が詰まっている」という目印にもなる。
