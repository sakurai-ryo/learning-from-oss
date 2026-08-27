---
title: "1 スレッドで全ブローカーに送り、順序を保証する"
description: "プロデューサの送信スレッドは 1 本しかない。全ブローカーへのソケットを 1 つの nio Selector で回し、ノードごとに最大 5 リクエストを飛ばす。順序が壊れうるのは「先に送ったリクエストが失敗してリトライされる」ときで、Kafka はそれを 2 つの別々の仕組みで塞いでいる。"
group: "プロデューサ"
sidebar:
  order: 26
---

## 何を学んだか

### どんな状況の話か

[アキュムレータのページ](../record-accumulator/) で、レコードがパーティションごとのバッチに溜まるところまで見た。次は、それをブローカーに送る部分だ。

要求は次のとおり。

- **複数のブローカーに並行して送る。** パーティションのリーダーは分散している。
- **1 ブローカーに複数のリクエストを同時に飛ばす。** 1 個ずつだとラウンドトリップに律速される。
- **パーティション内の順序を保証する。** これがプロデューサの契約になっている。

3 つ目が難しい。**リクエスト 1 が失敗してリトライしている間に、リクエスト 2 が成功したら、順序が逆転する。**

### Kafka の答え

**送信スレッドを 1 本にし、nio でノンブロッキングに全ブローカーへ送る。**

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/Sender.java"
/**
 * The background thread that handles the sending of produce requests to the Kafka cluster. This thread makes metadata
 * requests to renew its view of the cluster and then sends produce requests to the appropriate nodes.
 */
public class Sender implements Runnable {
```

[`Sender.java#L75-L79`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/Sender.java#L75-L79)。

1. **ノードごとに in-flight リクエストのデックを持つ。** 上限は `max.in.flight.requests.per.connection` (既定 5)。
2. **サーバが 1 コネクションにつき 1 リクエストずつ順に処理する** ([SocketServer のページ](../socket-server/))。だから応答は送った順に返る。
3. **順序保証の仕組みが 2 つある。** 冪等性を無効にした場合は「パーティションを mute する」、有効にした場合は[シーケンス番号](../idempotent-producer/)。
4. **ノードごとに drain の開始位置をずらす。** 特定のパーティションが常に優先されないように。

## ソースコードのどこか

### in-flight の管理

```java title="clients/src/main/java/org/apache/kafka/clients/InFlightRequests.java"
/**
 * The set of requests which have been sent or are being sent but haven't yet received a response
 */
final class InFlightRequests {
    ...
    private final Map<String, Deque<NetworkClient.InFlightRequest>> requests = new HashMap<>();
```

[`InFlightRequests.java#L27-L34`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/InFlightRequests.java#L27-L34)。

**ノード ID → 送信済みで応答待ちのリクエストのデック。** デックなので順序を保つ。応答が来たら先頭から取り出す。

```java title="clients/src/main/java/org/apache/kafka/clients/InFlightRequests.java"
/**
 * Can we send more requests to this node?
 */
public boolean canSendMore(String node) {
    Deque<NetworkClient.InFlightRequest> queue = requests.get(node);
    return queue == null || queue.isEmpty() ||
           (queue.peekFirst().send.completed() && queue.size() < this.maxInFlightRequestsPerConnection);
}
```

[`InFlightRequests.java#L90-L100`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/InFlightRequests.java#L90-L100)。

条件が 2 つある。**「デックの先頭のリクエストが送信し終わっている」**ことと、**「上限に達していない」**こと。

前者が要るのは、**nio のソケットへの書き込みが部分的に完了しうる**からだ。1 つのリクエストを書き終わる前に次を書き始めると、バイト列が混ざる。**先頭が書き終わるまで、次のリクエストの書き込みは始められない。**

`peekFirst()` を見ているのは、デックの先頭が **一番古い = 最初に書かれているもの**だからだ。

### 応答は送った順に返る

これが順序保証の土台になっている。

[SocketServer のページ](../socket-server/) で見たとおり、ブローカーは **リクエストを受け取ったらそのチャネルを mute し、応答を送り終えるまで次を読まない。**

```text
クライアント          ブローカー
  req1 ──────────────►  read req1, mute
  req2 ──────────────►  (TCP バッファに留まる)
  req3 ──────────────►  (TCP バッファに留まる)
       ◄────────────── resp1, unmute
                       read req2, mute
       ◄────────────── resp2, unmute
                       ...
```

**5 個まで飛ばせるが、処理されるのは 1 個ずつで、応答も順に返る。** クライアント側の `Deque` の順序と、応答の順序が一致する。

**パイプライン化の利点 (ネットワーク待ちを重ねる) と、順序の単純さ (1 個ずつ処理) を両立している。**

### 順序が壊れる唯一の経路

送った順に処理され、送った順に応答が返るなら、なぜ順序が壊れうるのか。

**リトライがあるからだ。**

```text
req1 (batch A) → 失敗 (一時的なエラー)
req2 (batch B) → 成功  ← B が先にログに載る
req1 (batch A) → リトライして成功  ← A が後から載る

結果: ログ上の順序は B, A
```

これを塞ぐ方法が 2 つある。

**方法 1: 冪等性が無効なら、パーティションを mute する。**

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/Sender.java"
if (guaranteeMessageOrder) {
    // Mute all the partitions drained
    ...
            this.accumulator.mutePartition(batch.topicPartition);
```

[`Sender.java#L420-L424`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/Sender.java#L420-L424)。

`guaranteeMessageOrder` は `max.in.flight.requests.per.connection == 1` のときに true になる。**送信したパーティションを mute し、応答が返るまでそのパーティションのバッチを送らない。**

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/Sender.java"
if (guaranteeMessageOrder)
    this.accumulator.unmutePartition(batch.topicPartition);
```

[`Sender.java#L737-L738`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/Sender.java#L737-L738)。

**同じ「mute」という語が、サーバ側とクライアント側で別の対象に使われている。** サーバはコネクションを mute し、クライアントはパーティションを mute する。**どちらも「応答が返るまで次に進まない」という同じ意図だ。**

`ready()` の javadoc に、この条件が明記されている。

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java"
 * A destination node is ready to send data if:
 * <ol>
 * <li>There is at least one partition that is not backing off its send
 * <li><b>and</b> those partitions are not muted (to prevent reordering if
 *   {@value org.apache.kafka.clients.producer.ProducerConfig#MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION}
 *   is set to one)</li>
```

[`RecordAccumulator.java#L871-L890`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java#L871-L890)。

**方法 2: 冪等性が有効なら、シーケンス番号で順序を守る。**

```java title="clients/src/main/java/org/apache/kafka/clients/producer/ProducerConfig.java"
private static final String MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION_DOC = "The maximum number of unacknowledged requests the client will send on a single connection before blocking."
                                                                        + " Note that if this configuration is set to be greater than 1 and <code>enable.idempotence</code> is set to false, there is a risk of"
                                                                        + " message reordering after a failed send due to retries (i.e., if retries are enabled); "
                                                                        + " if retries are disabled or if <code>enable.idempotence</code> is set to true, ordering will be preserved."
                                                                        + " Additionally, enabling idempotence requires the value of this configuration to be less than or equal to " + MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION_FOR_IDEMPOTENCE + ","
                                                                        + " because broker only retains at most 5 batches for each producer.";
```

[`ProducerConfig.java#L299-L305`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/ProducerConfig.java#L299-L305)。

**設定のドキュメントに、3 つの組み合わせの帰結が全部書いてある。**

| `max.in.flight` | `enable.idempotence` | 順序                                                           |
| --------------- | -------------------- | -------------------------------------------------------------- |
| 1               | どちらでも           | **保たれる** (mute で保証)                                     |
| 2〜5            | true                 | **保たれる** ([シーケンス番号](../idempotent-producer/)で保証) |
| 2〜5            | false                | **壊れうる**                                                   |
| 6 以上          | true                 | **設定エラー** (ブローカーが 5 バッチしか覚えない)             |

**「5」の根拠が「ブローカーが 5 バッチしか保持しないから」と明記されている**のがよい。[プロデューサ状態のページ](../producer-state/) で見た `NUM_BATCHES_TO_RETAIN = 5` と、ここが対になっている。

### シーケンス番号の割り当て

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java"
// If the batch already has an assigned sequence, then we should not change the producer id and
// sequence number, since this may introduce duplicates. In particular, the previous attempt
// may actually have been accepted, and if we change the producer id and sequence here, this
// attempt will also be accepted, causing a duplicate.
//
// Additionally, we update the next sequence number bound for the partition, and also have
// the transaction manager track the batch so as to ensure that sequence ordering is maintained
// even if we receive out of order responses.
batch.setProducerState(producerIdAndEpoch, transactionManager.sequenceNumber(batch.topicPartition), isTransactional);
transactionManager.incrementSequenceNumber(batch.topicPartition, batch.recordCount);
```

[`RecordAccumulator.java#L1034-L1044`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java#L1034-L1044)。

**シーケンス番号は「アキュムレータから取り出すとき」に割り当てられ、リトライしても変わらない。** 変えると、前の試行が実は成功していた場合に重複する。

**「リトライは、まったく同じバイト列を送り直すこと」** という規律がここで守られている。

### ドレインの公平性

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java"
} while (start != drainIndex);
```

[`RecordAccumulator.java#L1059`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java#L1059)。

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java"
private int getDrainIndex(String idString) {
    return nodesDrainIndex.computeIfAbsent(idString, s -> 0);
```

[`RecordAccumulator.java#L1063-L1064`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/RecordAccumulator.java#L1063-L1064)。

1 回のリクエストに詰められるサイズには上限 (`max.request.size`) がある。**あるノードに 100 パーティション分のバッチが溜まっていても、全部は入らない。**

毎回パーティションの先頭から詰めると、**後ろのパーティションが永遠に送られない。** だからノードごとに「前回どこまで詰めたか」を覚えて、次はそこから始める。**ラウンドロビン。**

`do { ... } while (start != drainIndex)` で一周したら終わり、という書き方になっている。

### 送信ループ

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/Sender.java"
void runOnce() {
    if (transactionManager != null) {
        try {
            transactionManager.maybeResolveSequences();

            RuntimeException lastError = transactionManager.lastError();

            // do not continue sending if the transaction manager is in a failed state
            if (transactionManager.hasFatalError()) {
```

[`Sender.java#L310-L318`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/Sender.java#L310-L318)。

1 回のループでやることは、

1. **トランザクションの状態を進める** ([トランザクションのページ](../transactions-eos/))。
2. **`accumulator.ready()` で送信可能なノードを集める。**
3. **`accumulator.drain()` でバッチを取り出し、`ProduceRequest` を組み立てる。**
4. **`client.poll()` で nio の Selector を回す。** 送信と受信の両方がここで進む。

**`poll()` が全ての I/O を担う。** ソケットへの書き込み、読み込み、接続の確立、メタデータの更新 — 全部 1 スレッドで、ノンブロッキングに。

## なぜそうなっているか

### なぜ送信スレッドが 1 本なのか

複数スレッドにすると、次の問題が出る。

- **パーティションごとの順序を守るために、スレッド間の調整が要る。** 同じパーティションのバッチが別スレッドから送られたら、順序が保証できない。
- **`InFlightRequests` の管理が共有状態になる。** ロックが要る。
- **メタデータの更新が複数スレッドから走る。**

**1 スレッドなら、これらが全部消える。** そして、送信はネットワーク I/O 待ちが支配的なので、**ノンブロッキング I/O で 1 スレッドでも十分な帯域が出る。**

CPU が足りなくなるのは圧縮のときで、**圧縮はアキュムレータへの追記時に、アプリのスレッドで行われる。** 送信スレッドは圧縮済みのバイト列を送るだけだ。**重い処理を呼び出し元のスレッドに寄せることで、送信スレッドを軽く保っている。**

### なぜ 2 つの順序保証方式があるのか

歴史的な経緯がある。**冪等プロデューサが入る前は、`max.in.flight=1` にするしかなかった。** これは順序を守るが、スループットが RTT に律速される。

冪等プロデューサ (シーケンス番号) が入って、**5 個まで飛ばしても順序が守れる**ようになった。ブローカーが「シーケンス番号が 1 つずつ増えているか」を検査して、飛んでいたら拒否するからだ ([プロデューサ状態のページ](../producer-state/))。

古い方式を残しているのは、**冪等性を無効にしたい場合があるから**だ。ブローカーのバージョンが古い、あるいは `acks=1` で運用したい、といった事情がありうる。

**「新しい方式が入っても、古い方式を消さない」** のは、Kafka の互換性方針の一貫した現れになっている。

### なぜドレインをラウンドロビンにするのか

リクエストのサイズ上限があると、必ず「今回入らなかったバッチ」が出る。**開始位置を固定すると、パーティションの並び順が優先順位になってしまう。**

パーティション ID の若いものが常に先に送られ、後ろのパーティションはトラフィックが多いときに詰まる。**アプリから見ると「特定のパーティションだけレイテンシが高い」という不可解な現象になる。**

**「取り出す順序の偏りが、観測できる不公平として現れる」** — キューやスケジューラを書くときに繰り返し出てくる問題だ。開始位置を回すだけで解ける。

### 重い処理をどこでやるか

Kafka のプロデューサは、処理をこう分担している。

| 処理                 | どのスレッド                                |
| -------------------- | ------------------------------------------- |
| シリアライズ         | **アプリのスレッド** (`send()` の中)        |
| パーティションの決定 | **アプリのスレッド**                        |
| 圧縮                 | **アプリのスレッド** (バッチへの追記時)     |
| メモリの確保         | **アプリのスレッド** (足りなければブロック) |
| 送信、受信、リトライ | **Sender スレッド**                         |

**CPU を食う処理は全部アプリのスレッドに寄せてある。** アプリが複数スレッドで `send()` を呼べば、シリアライズと圧縮は並列化される。

**Sender は「I/O だけをする 1 本のスレッド」に純化されている。** これが 1 本で足りる理由であり、逆に「Sender の中で重い処理をしてはいけない」という制約でもある。

## どう活かすか

**「1 本の I/O スレッド + ノンブロッキング多重化」は、クライアントライブラリの定番構成だ。** 順序保証と共有状態の問題が消え、実装が単純になる。**成立条件は「重い処理を I/O スレッドから追い出せること」で、Kafka はシリアライズと圧縮を呼び出し元のスレッドに寄せている。** この分担を最初に決めないと、後から 1 スレッドでは足りなくなる。

**「パイプライン化しつつ順序を守る」には、サーバ側の協力が要る。** クライアントが 5 個飛ばしても順序が守れるのは、サーバが 1 コネクションにつき 1 個ずつ処理するからだ。**片側だけでは実現できない性質を、プロトコルの両端で分担している。** 自分でプロトコルを設計するなら、「サーバは同時に何個処理するか」を明示的に決める。

**「リトライは、まったく同じバイト列を送り直す」という規律も重要だ。** シーケンス番号を振り直すと、前の試行が実は成功していた場合に重複する。**リトライ時に何かを再計算する実装は、ほぼ確実にこの落とし穴を踏む。** 「送信内容は最初に確定し、リトライでは変えない」を規律にする。

**「取り出しの開始位置を回す」だけで公平性が得られる場面は多い。** 容量に上限があるバッチ処理では、必ず「今回入らなかったもの」が出る。**開始位置を固定すると、その偏りが恒久的な不公平になる。** 状態は整数 1 つで済むので、入れておいて損はない。

**設定ドキュメントに「組み合わせの帰結」を書くのも真似したい。** `max.in.flight.requests.per.connection` の説明は、`enable.idempotence` との組み合わせ 3 通りと、上限が 5 である理由まで書いている。**設定同士に依存関係があるなら、片方のドキュメントに全部書く。** 利用者は両方を突き合わせて読んではくれない。
