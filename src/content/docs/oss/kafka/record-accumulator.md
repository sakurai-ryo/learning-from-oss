---
title: "固定サイズのバッファプールと、パーティションごとのバッチ列"
description: "プロデューサの send() は、レコードをネットワークに送らない。パーティションごとのデックの末尾にあるバッチに追記するだけだ。メモリは固定サイズのプールから取り、足りなければ呼び出し元をブロックする。プールは「一番長く待っているスレッドに全部渡す」という公平性を持っていて、それが大きなレコードの餓死を防いでいる。"
group: "プロデューサ"
sidebar:
  order: 25
---

## 何を学んだか

### どんな状況の話か

`producer.send(record)` を呼ぶと何が起きるか。素朴には「レコードをブローカーに送る」だが、それだと 1 レコードごとに RPC が飛ぶ。

- **[レコードバッチ形式](../record-batch/) の恩恵がゼロになる。** 61 バイトのヘッダを 1 レコードごとに払う。
- **圧縮が効かない。**
- **1 レコードごとにラウンドトリップを待つ。**

だからバッファに溜めて、まとめて送る。すると次の問題が出る。

- **どれだけ溜めるか。** 溜めるほど効率がいいが、レイテンシが伸びる。
- **メモリをどれだけ使うか。** 溜めた分はヒープに載る。無制限だと OOM。
- **メモリが足りなくなったらどうするか。** `send()` は非同期 API なので、素直にはブロックできない。

### Kafka の答え

**パーティションごとのデックに `ProducerBatch` を積み、固定サイズのプールからメモリを取る。**

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java"
/**
 * This class acts as a queue that accumulates records into {@link MemoryRecords}
 * instances to be sent to the server.
 * <p>
 * The accumulator uses a bounded amount of memory and append calls will block when that memory is exhausted, unless
 * this behavior is explicitly disabled.
 */
public class RecordAccumulator {
```

[`RecordAccumulator.java#L67-L74`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java#L67-L74)。

1. **`Map<TopicPartition, Deque<ProducerBatch>>`。** パーティションごとに、送信待ちのバッチが並ぶ。
2. **メモリは `BufferPool` から取る。** 上限は `buffer.memory` (既定 32 MB)。
3. **足りなければ `send()` がブロックする。** `max.block.ms` まで。
4. **プールは `batch.size` の buffer を再利用する。** それより大きいレコードは別扱い。
5. **送信の契機は 6 つある。** バッチが満杯、`linger.ms` 経過、メモリ枯渇、クローズ、`flush()`、トランザクション完了。

## ソースコードのどこか

### 追記の流れ

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java"
// check if we have an in-progress batch
TopicPartition tp = new TopicPartition(topic, effectivePartition);
Deque<ProducerBatch> dq = topicInfo.batches.computeIfAbsent(tp, k -> new ArrayDeque<>());
synchronized (dq) {
    // After taking the lock, validate that the partition hasn't changed and retry.
    if (partitionChanged(topic, topicInfo, partitionInfo, dq, nowMs, cluster))
        continue;

    RecordAppendResult appendResult = tryAppend(timestamp, key, value, headers, callbacks, dq, nowMs);
    if (appendResult.appended())
        return updatePartitionInfoOnAppend(appendResult, topicInfo, partitionInfo, dq, cluster);
}

if (buffer == null) {
    int size = Math.max(this.batchSize, AbstractRecords.estimateSizeInBytesUpperBound(
            RecordBatch.CURRENT_MAGIC_VALUE, compression.type(), key, value, headers));
    log.trace("Allocating a new {} byte message buffer for topic {} partition {} with remaining timeout {}ms", size, topic, effectivePartition, maxTimeToBlock);
    // This call may block if we exhausted buffer space.
    buffer = free.allocate(size, maxTimeToBlock);
```

[`RecordAccumulator.java#L322-L340`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java#L322-L340)。

**ロックはデックごと。** パーティション A への追記と B への追記は競合しない。パーティション数が多いほど並行度が上がる。

**まず既存のバッチへの追記を試し、入らなければ新しいバッファを確保する。** 確保は **ロックの外**で行われる。ロックを持ったままブロックすると、そのパーティションへの追記が全部止まるからだ。

そのため、**確保している間に他のスレッドが新しいバッチを作っているかもしれない**。だから確保後にもう一度ロックを取って `tryAppend` を試す。この二重チェックが `while (true)` のループになっている。

`Math.max(this.batchSize, 推定サイズ)` にも注目したい。**1 レコードが `batch.size` を超えるなら、そのレコード専用の大きいバッファを取る。** 大きいレコードで詰まらないようにしている。

### 公平なバッファプール

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BufferPool.java"
/**
 * A pool of ByteBuffers kept under a given memory limit. This class is fairly specific to the needs of the producer. In
 * particular it has the following properties:
 * <ol>
 * <li>There is a special "poolable size" and buffers of this size are kept in a free list and recycled
 * <li>It is fair. That is all memory is given to the longest waiting thread until it has sufficient memory. This
 * prevents starvation or deadlock when a thread asks for a large chunk of memory and needs to block until multiple
 * buffers are deallocated.
 * </ol>
 */
public class BufferPool {
```

[`BufferPool.java#L38-L48`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BufferPool.java#L38-L48)。

**2 つ目の性質が重要だ。** 「一番長く待っているスレッドに、必要な分が揃うまでメモリを渡し続ける」。

なぜこれが要るのか。**大きなレコード (10 MB) を待っているスレッドと、小さなレコード (16 KB) を待っているスレッドがいるとする。** 公平でない実装だと、

```text
1. 16 KB 解放される → 小さいレコードのスレッドが取る
2. 16 KB 解放される → 別の小さいスレッドが取る
3. ... 10 MB を待っているスレッドは永遠に取れない
```

**大きなレコードが餓死する。** そこで、待ち行列の先頭のスレッドに優先的に渡し、**そのスレッドが必要量を溜め終わるまで他には渡さない。**

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BufferPool.java"
// we are out of memory and will have to block
int accumulated = 0;
Condition moreMemory = this.lock.newCondition();
try {
    long remainingTimeToBlockNs = TimeUnit.MILLISECONDS.toNanos(maxTimeToBlockMs);
    this.waiters.addLast(moreMemory);
    // loop over and over until we have a buffer or have reserved
    // enough memory to allocate one
    while (accumulated < size) {
        remainingTimeToBlockNs -= awaitMemory(moreMemory, remainingTimeToBlockNs, true, ...);
        ...
            // we'll need to allocate memory, but we may only get
            // part of what we need on this iteration
            freeUp(size - accumulated);
            int got = (int) Math.min(size - accumulated, this.nonPooledAvailableMemory);
            this.nonPooledAvailableMemory -= got;
            accumulated += got;
    }
```

[`BufferPool.java#L167-L195`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BufferPool.java#L167-L195)。

**`waiters` は `Deque<Condition>`。** スレッドごとに専用の `Condition` を作り、待ち行列に並べる。`signalNextWaiterIfMemoryAvailable()` が先頭だけを起こす。

`accumulated` が「今までに確保できた分」で、必要量に達するまで少しずつ溜める。**部分的に確保したメモリを保持したまま待つ**ので、他のスレッドに横取りされない。

失敗時の後始末も丁寧だ。

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/BufferPool.java"
} finally {
    // When this loop was not able to successfully terminate don't loose available memory
    this.nonPooledAvailableMemory += accumulated;
    this.waiters.remove(moreMemory);
}
```

[`BufferPool.java#L199-L203`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/BufferPool.java#L199-L203)。

**タイムアウトや例外で抜けたら、溜めていた分をプールに戻す。** 成功時は `accumulated = 0` にしてから finally に入るので、戻されない。

### 送る契機

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java"
long timeToWaitMs = backingOff ? retryBackoff.backoff(backoffAttempts > 0 ? backoffAttempts - 1 : 0) : lingerMs;
boolean expired = waitedTimeMs >= timeToWaitMs;
boolean transactionCompleting = transactionManager != null && transactionManager.isCompleting();
boolean sendable = full
        || expired
        || exhausted
        || closed
        || flushInProgress()
        || transactionCompleting;
```

[`RecordAccumulator.java#L717-L725`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java#L717-L725)。

**6 つの OR。**

| 条件                    | 意味                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `full`                  | バッチが満杯 (`batch.size`)                                         |
| `expired`               | `linger.ms` 経過                                                    |
| `exhausted`             | **メモリが枯渇している** — 誰かが待っているので、早く送って解放する |
| `closed`                | プロデューサが閉じられた                                            |
| `flushInProgress()`     | `flush()` が呼ばれた                                                |
| `transactionCompleting` | [トランザクション](../transactions-eos/)のコミット中                |

**`exhausted` が入っているのが実務的だ。** メモリが足りずに `send()` がブロックしているなら、`linger.ms` を待たずに送り出してメモリを空ける。**「待たせている人がいるなら急ぐ」。**

送らない場合は、次にチェックすべき時刻を返す。

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java"
long timeLeftMs = Math.max(timeToWaitMs - waitedTimeMs, 0);
// Note that this results in a conservative estimate since an un-sendable partition may have
// a leader that will later be found to have sendable data. However, this is good enough
// since we'll just wake up and then sleep again for the remaining time.
nextReadyCheckDelayMs = Math.min(timeLeftMs, nextReadyCheckDelayMs);
```

[`RecordAccumulator.java#L729-L733`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java#L729-L733)。

**保守的な見積もりでよい**と明記されている。早めに起きても、また寝るだけ。**「起こしすぎるのは無駄だが、起こし損ねるのはバグ」** という非対称性が判断の根拠になっている。

### メモリ効率を上げる新しい実装

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/ChunkedRecordAccumulator.java"
/**
 * A {@link RecordAccumulator} variant that backs each batch with fixed-size chunks drawn from a
 * {@link BufferPool}, attaching more chunks on demand as records are appended instead of
 * reserving {@code batch.size} per batch up front. Buffered memory therefore scales with the data
 * actually written rather than with {@code active_partition_count × batch.size}.
 * <p>
 * TODO: support compressed data (with mid-record growth); the constructor rejects compression for now.
 */
public class ChunkedRecordAccumulator extends RecordAccumulator {
```

[`ChunkedRecordAccumulator.java#L33-L43`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/ChunkedRecordAccumulator.java#L33-L43)。

**元の実装の問題は、`アクティブなパーティション数 × batch.size` のメモリを予約すること。** パーティションが 1000 個あって `batch.size` が 16 KB なら、実際には数バイトずつしか書いていなくても 16 MB を占有する。

新しい実装は **小さいチャンクを必要に応じて足していく。** 使った分だけメモリを消費する。

**`TODO` が javadoc に残っている**のも興味深い。圧縮に未対応で、コンストラクタが圧縮設定を拒否する。**未完成であることを隠さずに書いてある。**

## なぜそうなっているか

### なぜ非同期 API なのにブロックするのか

`send()` は `Future` を返す非同期 API だ。それがメモリ不足でブロックするのは、一見矛盾している。

だが、代替は 2 つしかない。

- **例外を投げる。** アプリが自分でリトライすることになり、結局ループで待つ。
- **無制限に溜める。** OOM で死ぬ。

**ブロックするのが、実質的に一番親切だ。** アプリは何も書かなくてもバックプレッシャを受ける。`max.block.ms` で上限を設けられるので、永久に止まることもない。

**「非同期 API のバックプレッシャは、どこかで同期的な待ちになる」** — これは避けられない。どこで待つかを選べるだけで、Kafka は `send()` の中を選んだ。

### なぜ「一番長く待っている人に全部渡す」のか

FIFO の公平性は、**大きな要求の餓死を防ぐ**ために要る。

しかも、**デッドロックの可能性もある。** 10 MB を待つスレッドが 3 本いて、プールが 32 MB だとする。公平でないと、3 本がそれぞれ 5 MB ずつ持ったまま残りを待ち、**誰も必要量に達しない**という状況が起こりうる。

FIFO なら、先頭の 1 本が 10 MB を溜め切り、使って解放し、次が溜める。**必ず前に進む。**

**「部分的に確保して待つ」設計は、公平性がないとデッドロックする。** この 2 つはセットになっている。

### なぜバッファを再利用するのか

`poolableSize` (= `batch.size`) のバッファだけをフリーリストに戻して再利用する。それ以外は GC に任せる。

- **大多数のバッチは `batch.size` ちょうど。** ここを再利用すれば、割り当ての大半が消える。
- **異なるサイズを全部プールすると、断片化とサイズごとのフリーリストが必要になる。**

**「1 つのサイズだけを最適化し、残りは普通に扱う」** という割り切りで、`malloc` の slab allocator と同じ発想になっている。

### なぜ送信の契機が 6 つもあるのか

`linger.ms` と `batch.size` の 2 つだけだと、次の状況で困る。

- **`flush()` が呼ばれた** → `linger.ms` を待っていたら、`flush()` が遅い。
- **プロデューサを閉じる** → 未送信のレコードを送り切りたい。
- **メモリが枯渇している** → 待っているスレッドを早く解放したい。
- **トランザクションをコミットする** → 全レコードを送ってからでないとコミットできない。

**それぞれ「待つ理由がなくなった」ことを表している。** `linger.ms` は「もっと溜まるかもしれないから待つ」という賭けで、賭ける意味がなくなったら即座に送る。

**6 つの OR を 1 箇所に集めているので、「なぜ今送られたのか」を追いやすい。** 各条件が別々の場所で `wakeup()` を呼ぶ実装だと、追跡が難しくなる。

### `linger.ms` の既定値が 0 である意味

既定では `linger.ms=0`、つまり「待たない」。それでもバッチができるのはなぜか。

**送信スレッド (Sender) が 1 本しかないから**だ ([次のページ](../sender-inflight/))。Sender が 1 回の送信を処理している間に、アプリのスレッドが追記したレコードは自然に溜まる。**送信の所要時間が、暗黙の linger になっている。**

**負荷が低いときはバッチが小さく (レイテンシ優先)、負荷が高いときは自然に大きくなる (スループット優先)** という、自己調整的な挙動になる。`linger.ms` を明示的に設定するのは、この自然なバッチングでは足りないときだけでよい。

## どう活かすか

**「固定サイズのメモリプールで、上限に達したら呼び出し元をブロックする」は、プロデューサ型のクライアントで定番の形だ。** キューを無制限にすると OOM で死に、例外を投げるとアプリ側にリトライループを書かせることになる。**ブロックが一番単純で、しかもタイムアウトを設ければ制御可能になる。**

**「部分確保して待つなら、FIFO の公平性を必ずセットにする」** — これは踏みやすい落とし穴だ。公平性がないと、大きな要求が餓死するだけでなく、**全員が部分確保したまま進まないデッドロック**が起こりうる。**待ち行列を明示的に持ち、先頭だけを起こす。**

**「送信の契機を 1 箇所の OR にまとめる」も真似したい。** 「待っている理由がなくなった」状況は、開発が進むほど増える。**条件を 1 箇所に集めておくと、増えたときに追加が 1 行で済み、「なぜ今送られたか」もそこを見れば分かる。** 各所から `wakeup()` を呼ぶ設計にすると、後から追えなくなる。

**「起こしすぎるのは無駄、起こし損ねるのはバグ」という非対称性は、タイマーやポーリングの設計で常に効く。** 保守的な見積もりでよいと分かれば、正確な計算をやめられる。**コードにその判断をコメントで残しておくと、後から「ここの計算は不正確だ」と直されずに済む。**

**そして、`linger.ms=0` でもバッチができる仕組みは示唆的だ。** 明示的な待ち時間ではなく、**「1 つ前の処理が終わるまでの間に溜まる」という自然な待ちを使う。** 負荷に応じてバッチサイズが自動調整され、チューニングのパラメータが 1 つ減る。**バッチ処理を設計するとき、待ち時間を設定値にする前に、既存の処理時間を待ちとして使えないか**を考える価値がある。
