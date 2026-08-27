---
title: "フェッチセッションで、リクエストサイズをパーティション数から切り離す"
description: "コンシューマもフォロワーも、同じパーティション集合を毎秒何十回も要求する。パーティションが 1 万個あれば、リクエストに 1 万個の offset が並ぶ。フェッチセッションは、その集合をブローカー側に覚えさせて、変化分だけを送る仕組みだ。セッションのキャッシュには「誰を追い出すか」の優先順位が 3 段で定義されている。"
sidebar:
  order: 31
---

## 何を学んだか

### どんな状況の話か

`Fetch` リクエストの中身は、パーティションごとの「この offset から、最大 N バイト」の列だ。

```text
FetchRequest:
  orders-0:   offset 12345, maxBytes 1MB
  orders-1:   offset 23456, maxBytes 1MB
  ... (パーティションの数だけ)
```

コンシューマが 1000 パーティションを担当していると、**1 リクエストに 1000 エントリ並ぶ。** これを `fetch.max.wait.ms` (既定 500 ms) ごとに送る。

もっと深刻なのは **フォロワー**だ ([pull 型レプリケーションのページ](../pull-replication/))。1 台のブローカーが 1 万パーティションを持ち、そのリーダーが 10 台に分散していれば、**10 本のフェッチスレッドがそれぞれ 1000 エントリのリクエストを、毎秒何十回も送る。**

**ほとんどのパーティションは変化していない。** データが来ていないパーティションについて、毎回同じ offset を送り直している。

### Kafka の答え

**パーティションの集合をブローカーに覚えさせ、2 回目以降は変化分だけを送る。**

```java title="clients/src/main/java/org/apache/kafka/clients/FetchSessionHandler.java"
/**
 * FetchSessionHandler maintains the fetch session state for connecting to a broker.
 *
 * Using the protocol outlined by KIP-227, clients can create incremental fetch sessions.
 * These sessions allow the client to fetch information about a set of partition over
 * and over, without explicitly enumerating all the partitions in the request and the
 * response.
 *
 * FetchSessionHandler tracks the partitions which are in the session.  It also
 * determines which partitions need to be included in each fetch request, and what
 * the attached fetch session metadata should be for each request.  The corresponding
 * class on the receiving broker side is FetchManager.
 */
public class FetchSessionHandler {
```

[`FetchSessionHandler.java#L48-L61`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/FetchSessionHandler.java#L48-L61)。

1. **1 回目は「フルフェッチ」。** 全パーティションを送り、ブローカーがセッション ID を発行する。
2. **2 回目以降は「増分フェッチ」。** 変わったパーティションだけを送る。
3. **応答も増分。** データがあるパーティションだけが返る。
4. **セッションはブローカー側のキャッシュに載る。** 有限なので、追い出しの規則がある。
5. **セッションが失われたら、フルフェッチからやり直す。** 状態を持つプロトコルの必須要件。

## ソースコードのどこか

### 差分の計算

```java title="clients/src/main/java/org/apache/kafka/clients/FetchSessionHandler.java"
List<TopicIdPartition> added = new ArrayList<>();
List<TopicIdPartition> removed = new ArrayList<>();
List<TopicIdPartition> altered = new ArrayList<>();
List<TopicIdPartition> replaced = new ArrayList<>();
for (Iterator<Entry<TopicPartition, PartitionData>> iter =
     sessionPartitions.entrySet().iterator(); iter.hasNext(); ) {
    ...
    PartitionData nextData = next.remove(topicPartition);
    if (nextData != null) {
        ...
        } else if (!prevData.equals(nextData)) {
            // Re-add the altered partition to the end of 'next'
            next.put(topicPartition, nextData);
            entry.setValue(nextData);
            altered.add(new TopicIdPartition(nextData.topicId, topicPartition));
        }
    } else {
        // Remove this partition from the session.
        iter.remove();
        // Indicate that we no longer want to listen to this partition.
        removed.add(new TopicIdPartition(prevData.topicId, topicPartition));
```

[`FetchSessionHandler.java#L296-L332`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/FetchSessionHandler.java#L296-L332)。

**変化を 4 種類に分類する。**

| 種類       | 何が起きたか                                                               | リクエストに載せる               |
| ---------- | -------------------------------------------------------------------------- | -------------------------------- |
| `added`    | 新しく購読した                                                             | 載せる                           |
| `altered`  | **offset が進んだ**                                                        | 載せる                           |
| `removed`  | 購読をやめた                                                               | **「忘れてくれ」リストに載せる** |
| `replaced` | トピックが同名で作り直された ([topic ID](../protocol-codegen/) が変わった) | 忘れさせて、新しく載せる         |

**変化していないパーティションは、どのリストにも入らない。** リクエストには現れない。

**データが到着したパーティションは `altered` になる** (offset が進むので)。つまり、**「動きのあったパーティションだけ」がリクエストに載る。** 静かなパーティションが 9900 個あっても、動いた 100 個だけを送る。

### `LinkedHashMap` を使う理由

```java title="clients/src/main/java/org/apache/kafka/clients/FetchSessionHandler.java"
private LinkedHashMap<TopicPartition, PartitionData> sessionPartitions =
```

[`FetchSessionHandler.java#L83`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/FetchSessionHandler.java#L83)。

**順序を持つマップになっている。** 差分計算のループで、こんな最適化が効いている。

```java title="clients/src/main/java/org/apache/kafka/clients/FetchSessionHandler.java"
if (sessionPartitions.containsKey(topicPartition)) {
    // In the previous loop, all the partitions which existed in both sessionPartitions
    // and next were moved to the end of next, or removed from next.  Therefore,
    // once we hit one of them, we know there are no more unseen entries to look
    // at in next.
    break;
}
```

[`FetchSessionHandler.java#L344-L350`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/FetchSessionHandler.java#L344-L350)。

**既存のパーティションは全部 `next` の末尾に移されている**ので、`next` を先頭から走査して既存のものにぶつかったら、そこから先は全部既存だと分かる。**ループを打ち切れる。**

**順序を維持することで、2 つ目のループが「新規のものだけ」を走査して終わる。** マップの順序という、普通は気にしない性質を最適化に使っている。

### ブローカー側のセッション

```java title="server/src/main/java/org/apache/kafka/server/FetchSession.java"
/**
 * The fetch session.
 * <p>
 * Each fetch session is protected by its own lock, which must be taken before mutable
 * fields are read or modified. This includes modification of the session partition map.
 */
public class FetchSession {
```

[`FetchSession.java#L36-L42`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/FetchSession.java#L36-L42)。

**セッションごとにロックを持つ。** キャッシュ全体のロックとは別だ。

```java title="server/src/main/java/org/apache/kafka/server/FetchSessionCacheShard.java"
/**
 * Caches fetch sessions.
 * <p>
 * See {@link #tryEvict} for an explanation of the cache eviction strategy.
 * <p>
 * The FetchSessionCache is thread-safe because all of its methods are synchronized.
 * Note that individual fetch sessions have their own locks which are separate from the
 * FetchSessionCache lock.  In order to avoid deadlock, the FetchSessionCache lock
 * must never be acquired while an individual FetchSession lock is already held.
 */
public class FetchSessionCacheShard {
```

[`FetchSessionCacheShard.java#L38-L48`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/FetchSessionCacheShard.java#L38-L48)。

**ロックの順序が明示されている。** `キャッシュのロック → セッションのロック` の順でしか取ってはいけない。逆順が混ざるとデッドロックする。

[purgatory のページ](../purgatory/) と同じで、**コードで強制できないロック順序を、javadoc で規約にしている。**

クラス名が `Shard` なのは、**キャッシュがシャーディングされている**からだ。`KAFKA-9401` の参照がコメントにある。

### 追い出しの優先順位

```java title="server/src/main/java/org/apache/kafka/server/FetchSessionCacheShard.java"
 * A proposed new element A may evict an existing element B if:
 * 1. A is privileged and B is not, or
 * 2. B is considered "stale" because it has been inactive for a long time, or
 * 3. A contains more partitions than B, and B is not recently created.
 * <p>
 * Prior to KAFKA-9401, the session cache was not sharded, and we looked at all
 * entries while considering those eligible for eviction. Now eviction is done
 * by considering entries on a per-shard basis.
```

[`FetchSessionCacheShard.java#L188-L198`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/FetchSessionCacheShard.java#L188-L198)。

**3 つの基準に優先順位が付いている。**

1. **`privileged` — フォロワーからのフェッチセッションは、コンシューマのものより優先される。** レプリケーションが止まるほうが影響が大きい。
2. **古くなったものを先に捨てる。** LRU 的。
3. **パーティション数が多いほうが価値が高い。** セッションによる節約量が大きいから。

3 番目が興味深い。**「このセッションを維持することで、どれだけ節約できるか」で価値を測っている。** 1 パーティションしか持たないセッションは、増分にしてもほとんど得しない。

実装も素直だ。

```java title="server/src/main/java/org/apache/kafka/server/FetchSessionCacheShard.java"
private synchronized boolean tryEvict(boolean privileged, EvictableKey key, long now) {
    // Try to evict an entry which is stale.
    Map.Entry<LastUsedKey, FetchSession> lastUsedEntry = lastUsed.firstEntry();
    if (lastUsedEntry == null) {
        logger.trace("There are no cache entries to evict.");
        return false;
    } else if (now - lastUsedEntry.getKey().lastUsedMs() > evictionMs) {
        ...
    } else {
        // If there are no stale entries, check the first evictable entry.
        // If it is less valuable than our proposed entry, evict it.
        TreeMap<EvictableKey, FetchSession> map = privileged ? evictableByPrivileged : evictableByAll;
```

[`FetchSessionCacheShard.java#L204-L233`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/FetchSessionCacheShard.java#L204-L233)。

**`TreeMap` を 3 本持っている。** 最終使用時刻順、全員が追い出せるもの、特権セッションだけが追い出せるもの。**それぞれ `firstEntry()` を見るだけで候補が決まる。**

**追い出しの判定を O(log n) に保つために、順序付きの索引を用途別に持つ。**

## なぜそうなっているか

### なぜ「状態を持つプロトコル」にしたのか

HTTP のようにステートレスなプロトコルは、実装が単純で、サーバの障害復旧も楽だ。それでも状態を持たせたのは、**節約量が大きいから**にほかならない。

パーティション 1 万個、1 エントリ 30 バイトとして、1 リクエスト 300 KB。毎秒 20 回で 6 MB/s。**レプリケーションのフェッチスレッドが 10 本あれば 60 MB/s** が、offset を送るためだけに使われる。

**しかも大半は変化していない。** 増分にすると、これがほぼゼロになる。

代償は、**「セッションが失われたときの回復」を設計に組み込む必要があること。** ブローカーが再起動したら、セッションは消える。クライアントはエラーを見てフルフェッチからやり直す。

**ステートフルにするなら、「状態が消えたときにどうするか」を最初に決める。** ここでは「フルフェッチに戻る」という単純な回復手順がある。

### なぜフォロワーを優先するのか

キャッシュが満杯のとき、誰を追い出すか。**「フォロワー > コンシューマ」という優先順位を付けている。**

理由は影響の非対称性にある。

- **コンシューマのセッションが失われる** → そのコンシューマがフルフェッチする。一時的に遅くなる。
- **フォロワーのセッションが失われる** → レプリケーションが遅くなる。**遅れると [ISR](../isr-highwatermark/) から外れ、書き込みの可用性に影響する。**

**「壊れたときの影響」で優先順位を決める**のは、リソースが不足する場面での基本的な考え方だ。

### なぜ「パーティション数が多いほど価値が高い」のか

セッションの価値は、**「そのセッションがあることで節約できる量」** だ。

- 1000 パーティションのセッション → 毎回 1000 エントリを省ける。
- 1 パーティションのセッション → 1 エントリしか省けない。

**キャッシュのエントリ数は同じ 1 なので、節約量が大きいほうを残すべきだ。**

これは一般的な LRU とは違う判断で、**「サイズあたりの効用」を考慮したキャッシュ置換**になっている。ページキャッシュのように全エントリが等価なら LRU でよいが、**エントリごとに価値が違うなら、価値を測る指標を持つ。**

### なぜキャッシュをシャーディングしたのか

`KAFKA-9401` の参照が、シャーディング前の問題を示している。**シャーディング前は、追い出しの判定で全エントリを見ていた。** セッションが数万個になると、これがロックを持ったまま走る。

シャーディングすると、**判定の対象が 1 シャード分になり、ロックの範囲も狭まる。** 代わりに「シャード内でしか比較しない」ので、追い出しの判断が全体最適ではなくなる。

**「グローバルに最適な判断」を諦めて、ロック競合を減らす。** キャッシュの追い出しは近似でよいので、この取引が成立する。

### なぜ `LinkedHashMap` の順序を最適化に使えるのか

順序に依存した最適化は、普通は避けたほうがよい。**マップの順序は実装の詳細で、依存すると壊れやすい**からだ。

ここで許されているのは、

- **`LinkedHashMap` は挿入順を保証する**と仕様で決まっている。
- **順序を維持する操作 (末尾への移動) が、同じメソッドの中で明示的に行われている。**
- **その意図が 5 行のコメントで説明されている。**

**「順序に依存する」ことを隠さず、同じ場所で作って同じ場所で使う。** 離れた場所で作られた順序に依存すると、壊れる。

## どう活かすか

**「同じ集合を繰り返し要求するなら、集合をサーバに覚えさせて差分だけ送る」** — ポーリング型の API で常に検討できる。効果は「リクエストサイズが集合の大きさに比例しなくなる」ことで、集合が大きく変化が小さいほど効く。**HTTP の `If-None-Match` や gRPC のストリーミングも同じ問題を別の形で解いている。**

**ステートフルにするなら、「状態が失われたときの回復」を最初に決める。** Kafka は「セッション ID が無効なら、フルフェッチからやり直す」という 1 通りの回復手順しか持たない。**回復手順が複数あると、それぞれをテストすることになる。** 1 つに絞れるかを先に確認する。

**キャッシュの追い出しで「エントリごとに価値が違う」なら、価値を測る指標を持つ。** LRU は「全エントリが等価」という前提の近似だ。**「このエントリがあることで、どれだけ節約できるか」を測れるなら、それで並べたほうがよい。** Kafka はパーティション数を代理指標にしている。

**「壊れたときの影響」で優先順位を決めるのも、リソース競合の場面で使える。** フォロワー > コンシューマという順位は、性能の話ではなく **可用性への影響**の話だ。**「誰を先に諦めさせるか」は、性能ではなく被害の大きさで決める。**

**そして、ロック順序の規約は javadoc に書く。** `the FetchSessionCache lock must never be acquired while an individual FetchSession lock is already held` — 2 段のロックを持つなら、順序を必ず文書化する。**この 1 行がないと、次の実装者が逆順で取ってデッドロックさせる。**
