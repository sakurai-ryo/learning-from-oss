---
title: "ユーザースレッド全部乗せから、背景スレッドとイベントキューへ"
description: "古いコンシューマは、poll() を呼んだユーザーのスレッドがハートビートもリバランスもオフセットコミットも全部やっていた。poll() を呼ばないとグループから追い出される、という有名な落とし穴の原因はここにある。新しい実装は背景スレッドを立て、2 本のキューで会話する形に変えた。"
sidebar:
  order: 30
---

## 何を学んだか

### どんな状況の話か

Kafka コンシューマの古い実装 (`ClassicKafkaConsumer`) は、**スレッドを 1 本も持たない**設計だった。ユーザーが `poll()` を呼んだときに、そのスレッドの中で全部やる。

- ブローカーへのフェッチリクエストの送受信
- コーディネータへのハートビート (別スレッドが 1 本あるが、リバランスの処理はユーザースレッド)
- リバランスの調整
- オフセットのコミット
- メタデータの更新

これが有名な落とし穴を生んだ。

```java
while (true) {
    var records = consumer.poll(Duration.ofSeconds(1));
    for (var record : records) {
        heavyProcessing(record);  // 10 分かかる
    }
}
```

**処理が `max.poll.interval.ms` (既定 5 分) を超えると、グループから追い出される。** ハートビートを送るスレッドはあっても、「まだ生きているが処理中」を表現できない。**`poll()` を呼ぶこと自体が生存信号になっている**からだ。

### Kafka の答え

**背景スレッドを立て、ユーザースレッドとイベントキューで会話する。**

```java title="clients/src/main/java/org/apache/kafka/clients/consumer/internals/AsyncKafkaConsumer.java"
/**
 * This {@link Consumer} implementation uses an {@link ApplicationEventHandler event handler} to process
 * {@link ApplicationEvent application events} so that the network I/O can be processed in a dedicated
 * {@link ConsumerNetworkThread network thread}.
 * ...
 * <em>Note:</em> this {@link Consumer} implementation is part of the revised consumer group protocol from KIP-848.
 * This class should not be invoked directly; users should instead create a {@link KafkaConsumer} as before.
 */
public class AsyncKafkaConsumer<K, V> implements ConsumerDelegate<K, V> {
```

[`AsyncKafkaConsumer.java#L165-L177`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/consumer/internals/AsyncKafkaConsumer.java#L165-L177)。

1. **キューが 2 本。** `ApplicationEventQueue` (ユーザー → 背景) と `BackgroundEventQueue` (背景 → ユーザー)。
2. **背景スレッドが全ての I/O を担当する。** ハートビートもフェッチもコミットも。
3. **機能ごとに `RequestManager` に分割されている。** 14 個ある。
4. **`KafkaConsumer` は薄いラッパになり、新旧の実装を切り替える。**
5. **`poll()` の中で wakeup を許す位置が、コメントで慎重に決められている。**

## ソースコードのどこか

### 背景スレッドのループ

```java title="clients/src/main/java/org/apache/kafka/clients/consumer/internals/ConsumerNetworkThread.java"
/**
 * Background thread runnable that consumes {@link ApplicationEvent} and produces {@link BackgroundEvent}. It
 * uses an event loop to consume and produce events, and poll the network client to handle network IO.
 */
public class ConsumerNetworkThread extends KafkaThread implements Closeable {
```

[`ConsumerNetworkThread.java#L60-L64`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/consumer/internals/ConsumerNetworkThread.java#L60-L64)。

```java title="clients/src/main/java/org/apache/kafka/clients/consumer/internals/ConsumerNetworkThread.java"
void runOnce() {
    // The following code avoids use of the Java Collections Streams API to reduce overhead in this loop.
    processApplicationEvents();
    ...
    long pollWaitTimeMs = MAX_POLL_TIMEOUT_MS;

    for (RequestManager rm : requestManagers.entries()) {
        NetworkClientDelegate.PollResult pollResult = rm.poll(currentTimeMs);
        long timeoutMs = networkClientDelegate.addAll(pollResult);
        pollWaitTimeMs = Math.min(pollWaitTimeMs, timeoutMs);
    }

    networkClientDelegate.poll(pollWaitTimeMs, currentTimeMs);

    long maxTimeToWaitMs = Long.MAX_VALUE;

    for (RequestManager rm : requestManagers.entries()) {
        long waitMs = rm.maximumTimeToWait(currentTimeMs);
        maxTimeToWaitMs = Math.min(maxTimeToWaitMs, waitMs);
    }
```

[`ConsumerNetworkThread.java#L210-L236`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/consumer/internals/ConsumerNetworkThread.java#L210-L236)。

**ループの形が [プロデューサの Sender](../sender-inflight/) とほぼ同じだ。**

1. ユーザーからのイベントを処理する。
2. **各 `RequestManager` に「送りたいリクエストはあるか」と聞く。**
3. `NetworkClient` を poll して、送受信を進める。
4. **各 `RequestManager` に「次はいつ起こしてほしいか」と聞く。**

**`RequestManager` が返す「次に起こしてほしい時刻」の最小値**を取って、次の poll のタイムアウトにする。**「誰も何もすることがなければ寝る」が自然に実現される。**

`The following code avoids use of the Java Collections Streams API to reduce overhead in this loop` — **ホットパスで Stream API を避けている。** ラムダのアロケーションと仮想呼び出しを嫌っている。

### 機能ごとの RequestManager

```java title="clients/src/main/java/org/apache/kafka/clients/consumer/internals/RequestManagers.java"
public final Optional<CoordinatorRequestManager> coordinatorRequestManager;
public final Optional<CommitRequestManager> commitRequestManager;
public final Optional<ConsumerHeartbeatRequestManager> consumerHeartbeatRequestManager;
public final Optional<ShareHeartbeatRequestManager> shareHeartbeatRequestManager;
public final Optional<ConsumerMembershipManager> consumerMembershipManager;
public final Optional<ShareMembershipManager> shareMembershipManager;
public final Optional<StreamsMembershipManager> streamsMembershipManager;
public final OffsetsRequestManager offsetsRequestManager;
public final TopicMetadataRequestManager topicMetadataRequestManager;
public final FetchRequestManager fetchRequestManager;
public final Optional<ShareConsumeRequestManager> shareConsumeRequestManager;
public final Optional<StreamsGroupHeartbeatRequestManager> streamsGroupHeartbeatRequestManager;
public final Optional<StreamsGroupTopologyDescriptionRequestManager> streamsGroupTopologyDescriptionRequestManager;
```

[`RequestManagers.java#L52-L64`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/consumer/internals/RequestManagers.java#L52-L64)。

**13 個の `RequestManager` が並ぶ。** `Optional` が多いのは、**コンシューマの種類によって使うものが違う**からだ。

| 種類                             | 使うマネージャ |
| -------------------------------- | -------------- |
| 通常のコンシューマ               | `Consumer*` 系 |
| [共有グループ](../share-groups/) | `Share*` 系    |
| Kafka Streams                    | `Streams*` 系  |

**同じ `ConsumerNetworkThread` が、3 種類のクライアントを動かす。** 差分は「どの `RequestManager` を組み立てるか」だけになっている。

インタフェースは 2 メソッドしかない。

```java title="clients/src/main/java/org/apache/kafka/clients/consumer/internals/RequestManager.java"
/**
 * {@code PollResult} consist of {@code UnsentRequest} if there are requests to send; otherwise, return the time till
 * the next poll event.
 */
public interface RequestManager {
```

[`RequestManager.java#L26-L30`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/consumer/internals/RequestManager.java#L26-L30)。

**`poll(currentTimeMs)` が「送りたいリクエスト」か「次に起こしてほしい時刻」を返す。** ネットワークのことは知らない。送信は `NetworkClientDelegate` に任せる。

**「何をしたいか」を宣言して、実行は共通の場所で行う** — [コントローラの `ControllerResult`](../quorum-controller/) と同じ形だ。

### wakeup を許す位置

```java title="clients/src/main/java/org/apache/kafka/clients/consumer/internals/AsyncKafkaConsumer.java"
do {
    // We must not allow wake-ups between polling for fetches and returning the records.
    // If the polled fetches are not empty the consumed position has already been updated in the polling
    // of the fetches. A wakeup between returned fetches and returning records would lead to never
    // returning the records in the fetches. Thus, we trigger a possible wake-up before we poll fetches.
    wakeupTrigger.maybeTriggerWakeup();
```

[`AsyncKafkaConsumer.java#L948-L953`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/consumer/internals/AsyncKafkaConsumer.java#L948-L953)。

**`wakeup()` は、`poll()` をブロックから抜けさせるための API だ。** 別スレッドから呼んで、コンシューマを止める。

問題は **「いつ抜けてよいか」**。フェッチしてレコードを取り出した後に抜けると、**そのレコードが失われる。** 消費位置はすでに進んでいるのに、レコードはユーザーに渡っていない。

だから **フェッチの前に wakeup をチェックする。** その後は、レコードを返し終わるまで wakeup しない。

**「途中で抜けてよい地点」を明示的に決めるのは、キャンセル可能な処理の設計で必ず必要になる。** どこでも抜けてよいわけではない。

### 新旧の切り替え

`KafkaConsumer` は、`ConsumerDelegate` を持つラッパになっている。実装は 2 つ。

| 実装                   | プロトコル                          |
| ---------------------- | ----------------------------------- |
| `ClassicKafkaConsumer` | 旧 (クライアント側で割り当てを計算) |
| `AsyncKafkaConsumer`   | 新 (KIP-848、サーバ側で割り当て)    |

`group.protocol` 設定で選ぶ。**既定は今も `classic`** だ。

```java title="clients/src/main/java/org/apache/kafka/clients/consumer/ConsumerConfig.java"
public static final String DEFAULT_GROUP_PROTOCOL = GroupProtocol.CLASSIC.name().toLowerCase(Locale.ROOT);
```

[`ConsumerConfig.java#L121`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/consumer/ConsumerConfig.java#L121)。

**新しい実装がクラスとして存在し、テストもされていて、それでも既定は古いまま。** 「デフォルトを変える」は互換性上の大きな決断なので、別途 KIP が要る。

**ユーザーから見た `KafkaConsumer` の API は変わっていない。** 中身を丸ごと入れ替えても、公開 API は同じままにしている。

## なぜそうなっているか

### なぜ「poll() が生存信号」だと困るのか

古い設計では、コンシューマの生存を 2 つの信号で判定していた。

| 信号                        | 意味                 | 送るスレッド         |
| --------------------------- | -------------------- | -------------------- |
| ハートビート                | プロセスが生きている | ハートビートスレッド |
| **`poll()` の呼び出し間隔** | **処理が進んでいる** | ユーザースレッド     |

後者があるのは、**「プロセスは生きているが、レコードの処理が終わらない」コンシューマを追い出したい**からだ。追い出さないと、そのパーティションが永久に処理されない。

これ自体は妥当な判断だが、**「処理が遅い」と「処理が止まった」の区別ができない。** 5 分かかる正当な処理も、無限ループも、同じに見える。

新しい設計でも `max.poll.interval.ms` は残っている。**設計を変えても、この判定自体は必要だからだ。** 変わったのは、**ハートビートとリバランスがユーザースレッドから完全に切り離された**こと。リバランスの調整中にユーザーの処理が止まる、といった相互干渉がなくなった。

### なぜ 2 本のキューなのか

1 本の双方向キューにはできない。**方向によって、受け手の待ち方が違う**からだ。

- **ユーザー → 背景**: 背景スレッドは常にループを回しているので、キューを drain するだけ。
- **背景 → ユーザー**: ユーザースレッドは `poll()` を呼んだときにしか見に来ない。

そして、**背景 → ユーザーのイベントには「エラー」と「コールバックの実行依頼」がある。** リバランスリスナーは **ユーザースレッドで実行しなければならない** (ユーザーのコードなので)。背景スレッドで実行すると、ユーザーのコードが背景スレッドをブロックしうる。

**「ユーザーのコードは、必ずユーザーのスレッドで実行する」** という原則が、キューを 2 本にしている。

### なぜ RequestManager に分割したのか

古い実装では、`ConsumerCoordinator` と `Fetcher` が絡み合っていた。**「リバランス中はフェッチを止める」といった調整が、直接の呼び出しで書かれていた。**

`RequestManager` にすると、

- **各マネージャが独立してテストできる。** `poll()` に時刻を渡して、返り値を検査するだけ。
- **背景スレッドは、マネージャの中身を知らない。** 追加も削除も、リストを変えるだけ。
- **[共有グループ](../share-groups/) や Streams のような新しい種類のクライアントを、同じ土台で作れる。**

3 番目が実際に効いている。**`Share*` と `Streams*` のマネージャは後から追加されたが、`ConsumerNetworkThread` は変わっていない。**

### なぜ「次に起こしてほしい時刻」を各マネージャが返すのか

背景スレッドは「何もすることがないときは寝たい」。だが、**いつまで寝てよいかは、マネージャごとに違う。**

- ハートビートマネージャ: 次のハートビートまで。
- コミットマネージャ: 自動コミットの間隔まで。
- フェッチマネージャ: `fetch.max.wait.ms` まで。

**各自に聞いて、最小値を取る。** これで「一番早く起きたい人」に合わせられる。

**「各コンポーネントが自分のスケジュールを知っていて、それを集約する」** というのは、イベントループを持つシステムの標準的な形だ (libuv の timer、Netty の `nextWakeupTime` など)。

### 既定を変えないという判断

新しい実装が完成していても、`group.protocol` の既定は `classic` のままだ。

理由は **リバランスプロトコルがクラスタ全体に影響する**からだ。1 つのグループの中に新旧のプロトコルが混在すると、[コーディネータ](../rebalance-protocol/)がその変換を担う。既定を変えると、アップグレードしたクライアントから順に新プロトコルに切り替わり、**運用者が意図しないタイミングで移行が始まる。**

**「新しい実装を入れる」と「既定にする」を別のリリースに分ける。** [プロトコルのバージョン管理](../protocol-codegen/) で見た「戻せない変更は明示的な操作」と同じ判断になっている。

## どう活かすか

**「呼び出し元のスレッドで全部やる」設計は、ライブラリを軽くするが、利用者の処理時間に全機能が引きずられる。** ハートビート、リトライ、キープアライブ — **時間に依存する処理があるなら、利用者のスレッドから切り離す。** 切り離さないと、「N 秒以内に呼び続けてください」という契約を利用者に押し付けることになり、それは必ず破られる。

**背景スレッドを導入するなら、キューは方向ごとに分ける。** 特に **「利用者のコールバックは、利用者のスレッドで実行する」** を守るには、背景から利用者への通知キューが要る。背景スレッドでコールバックを実行すると、利用者のコードがライブラリの心臓部をブロックする。

**「やりたいことを宣言して、実行は共通の場所で行う」構造は、テストと拡張の両方に効く。** `RequestManager.poll()` は時刻を受け取ってリクエストを返す純粋な関数に近い。**ネットワークをモックせずにテストできる。** そして、新しい機能はマネージャを 1 つ足すだけで済む。

**「各コンポーネントに次の起床時刻を聞いて、最小値で寝る」はイベントループの定型だ。** 固定間隔でポーリングすると、間隔が短ければ CPU を食い、長ければ遅延する。**各自が自分の締め切りを知っているなら、それを集約するのが正しい。**

**「キャンセル可能な地点を明示的に決める」も忘れやすい。** `wakeup()` がどこで効いてよいかは、**データを失わない地点**でしか許されない。「どこでも中断できる」は、たいてい「どこかでデータを失う」を意味する。

**そして、実装の入れ替えと既定の変更は分ける。** 新しい実装を出荷し、選べるようにし、十分に使われてから既定にする。**この 3 段階を 1 リリースにまとめると、問題が起きたときに切り分けられない。**
