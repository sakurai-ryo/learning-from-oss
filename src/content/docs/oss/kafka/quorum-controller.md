---
title: "コントローラを単一スレッドのイベントループにする"
description: "KRaft のコントローラは、ロックを 1 つも持たない。全ての操作が 1 本のスレッドで順に処理され、各操作は「書くレコードの列」と「返す応答」を返すだけの純粋な関数になっている。応答が返るのは、そのレコードがログにコミットされてからだ。この 3 つの決めごとで、並行制御が丸ごと消えている。"
sidebar:
  order: 18
---

## 何を学んだか

### どんな状況の話か

コントローラがやることは多い。

- トピックの作成・削除
- パーティションのリーダー選出と [ISR](../isr-highwatermark/) の更新
- [ブローカーの登録とハートビート](../broker-lifecycle/)
- 設定の変更、ACL、クォータ、[パーティションの再配置](../elr/)

これらは互いに絡み合っている。「ブローカー 3 が落ちた」を処理している最中に「トピック X を削除」が来たら、どうなるか。ブローカー 3 のリーダーを他に移す処理と、そのトピックを消す処理が競合する。

ZooKeeper 時代のコントローラは、この競合をロックで捌いていた。**結果として、デッドロックとレースコンディションの温床になった。**

### Kafka の答え

**単一スレッドのイベントループにする。ロックを持たない。**

```java title="metadata/src/main/java/org/apache/kafka/controller/QuorumController.java"
/**
 * QuorumController implements the main logic of the KRaft (Kafka Raft Metadata) mode controller.
 *
 * The node which is the leader of the metadata log becomes the active controller.  All
 * other nodes remain in standby mode.  Standby controllers cannot create new metadata log
 * entries.  They just replay the metadata log entries that the current active controller
 * has created.
 *
 * The QuorumController is single-threaded.  A single event handler thread performs most
 * operations.  This avoids the need for complex locking.
 *
 * The controller exposes an asynchronous, futures-based API to the world.  This reflects
 * the fact that the controller may have several operations in progress at any given
 * point.  The future associated with each operation will not be completed until the
 * results of the operation have been made durable to the metadata log.
 */
public final class QuorumController implements Controller {
```

[`QuorumController.java#L157-L177`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/QuorumController.java#L157-L177)。

3 つの決めごとが書かれている。

1. **単一スレッド。** `This avoids the need for complex locking`。
2. **API は非同期 (future ベース)。** 単一スレッドを塞がないため。
3. **future が完了するのは、結果がログに永続化されてから。**

そして、各操作の形が決まっている。

4. **操作は「書くレコードの列」と「返す応答」を返すだけ。** 自分で状態を書き換えない。
5. **standby コントローラも、同じ `replay` でログを適用する。** アクティブと同じコードパスを通る。

## ソースコードのどこか

### 操作の戻り値

```java title="metadata/src/main/java/org/apache/kafka/controller/ControllerResult.java"
class ControllerResult<T> {
    private final List<ApiMessageAndVersion> records;
    private final T response;
    private final boolean isAtomic;
```

[`ControllerResult.java#L27-L30`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/ControllerResult.java#L27-L30)。

**「トピックを作る」という操作は、トピックを作らない。** 「これらのレコードを書けばトピックができます」というレコードの列と、クライアントに返す応答を返すだけだ。

これが `ReplicationControlManager`、`ClusterControlManager`、`ConfigurationControlManager` といった全てのマネージャに共通する形になっている。**状態を変えるのは、レコードを `replay` する 1 箇所だけ。**

`isAtomic` は「このレコード列は 1 つのバッチとして書かれなければならない」を表す。**中途半端に一部だけ適用されると壊れる操作**を区別している。

### 書き込みイベントの処理

```java title="metadata/src/main/java/org/apache/kafka/controller/QuorumController.java"
@Override
public void run() throws Exception {
    ...
    int controllerEpoch = curClaimEpoch;
    if (!isActiveController(controllerEpoch)) {
        throw ControllerExceptions.newWrongControllerException(latestController());
    }
    ControllerResult<T> result = op.generateRecordsAndResult();
```

[`QuorumController.java#L791-L802`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/QuorumController.java#L791-L802)。

**最初に「自分はまだアクティブか」を確認する。** イベントがキューに入ってから処理されるまでの間に、リーダーを降ろされているかもしれない。

その後の分岐が 2 つある。**レコードが空なら、それは実質的に読み取りだった。**

```java title="metadata/src/main/java/org/apache/kafka/controller/QuorumController.java"
if (result.records().isEmpty()) {
    op.processBatchEndOffset(offsetControl.nextWriteOffset() - 1);
    // If the operation did not return any records, then it was actually just
    // a read after all, and not a read + write.  However, this read was done
    // from the latest in-memory state, which might contain uncommitted data.
    OptionalLong maybeOffset = deferredEventQueue.highestPendingOffset();
    if (maybeOffset.isEmpty()) {
        // If the purgatory is empty, there are no pending operations and no
        // uncommitted state.  We can complete immediately.
        resultAndOffset = ControllerResultAndOffset.of(-1, result);
        ...
    } else {
        // If there are operations in the purgatory, we want to wait for the latest
        // one to complete before returning our result to the user.
        resultAndOffset = ControllerResultAndOffset.of(maybeOffset.getAsLong(), result);
```

[`QuorumController.java#L803-L822`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/QuorumController.java#L803-L822)。

**この分岐が、この設計で一番細かいところだ。**

読み取りだけの操作でも、**「読んだ状態が、まだコミットされていない書き込みを含んでいるかもしれない」**。メモリ上の状態は書き込みを楽観的に適用済みだからだ ([timeline データ構造のページ](../timeline-datastructures/))。

その状態を読んで答えを返した後で、その書き込みがコミットに失敗したら、**クライアントは「存在しないもの」を見たことになる。**

だから、**未コミットの書き込みがあれば、そのコミットを待ってから読み取りの応答を返す。** 待つものがなければ即座に返す。

### 楽観的な適用と、遅延した完了

```java title="metadata/src/main/java/org/apache/kafka/controller/QuorumController.java"
// Pass the records to the Raft layer. This will start the process of committing
// them to the log.
long offset = appendRecords(log, result, maxRecordsPerBatch,
    records -> {
        // Start by trying to apply the record to our in-memory state. This should always
        // succeed; if it does not, that's a fatal error. It is important to do this before
        // scheduling the record for Raft replication.
        int recordIndex = 0;
        long lastOffset = raftClient.prepareAppend(controllerEpoch, records);
        long baseOffset = lastOffset - records.size() + 1;
        for (ApiMessageAndVersion message : records) {
            long recordOffset = baseOffset + recordIndex;
            try {
                replay(message.message(), Optional.empty(), recordOffset);
            } catch (Throwable e) {
                String failureMessage = String.format("Unable to apply %s " +
                    "record at offset %d on active controller, from the " +
                    "batch with baseOffset %d", ...);
                throw fatalFaultHandler.handleFault(failureMessage, e);
            }
            recordIndex++;
        }
        raftClient.schedulePreparedAppend();
        offsetControl.handleScheduleAppend(lastOffset);
        return lastOffset;
    }
);
```

[`QuorumController.java#L824-L851`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/QuorumController.java#L824-L851)。

**順序が重要だと明記されている。**

1. Raft に「これから書く」と予約する (`prepareAppend`)。offset が確定する。
2. **メモリ上の状態に適用する (`replay`)。** コミット前に。
3. Raft の書き込みを実際にスケジュールする (`schedulePreparedAppend`)。

`It is important to do this before scheduling the record for Raft replication` — **適用が失敗しうるなら、Raft に投げる前に気づきたい。** 投げた後で失敗すると、ログには書かれたが適用されていない状態になる。

そして「適用は必ず成功するはず。しなければ致命的エラー」と書かれている。**`fatalFaultHandler` はプロセスを落とす。** 自分が書いたレコードを自分で適用できないなら、状態が壊れているのでそれ以上動かすべきではない。

最後に、future はまだ完了しない。

```java title="metadata/src/main/java/org/apache/kafka/controller/QuorumController.java"
// Remember the latest offset and future if it is not already completed
if (!future.isDone()) {
    deferredEventQueue.add(resultAndOffset.offset(), this);
}
```

[`QuorumController.java#L858-L862`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/QuorumController.java#L858-L862)。

**「offset X に到達したら完了させる」というキュー (`deferredEventQueue`) に入れて、イベントの処理は終わる。** スレッドは次のイベントへ行く。

Raft がそのオフセットをコミットすると、コミット通知が来て、`deferredEventQueue` からそれ以下の future が全部完了する。

**[purgatory](../purgatory/) と同じ形だ。** 待つべきものは待ち行列に預けて、処理スレッドは進む。

### イベントキュー

```java title="server-common/src/main/java/org/apache/kafka/queue/EventQueue.java"
public interface EventQueue extends AutoCloseable {
    interface Event {
        /**
         * Run the event.
         */
        void run() throws Exception;

        /**
         * Handle an exception that was either generated by running the event, or by the
         * event queue's inability to run the event.
         *
         * @param e     The exception.  This will be a TimeoutException if the event hit
         *              its deadline before it could be scheduled.
         *              It will be a RejectedExecutionException if the event could not be
         *              scheduled because the event queue has already been closed.
         *              Otherwise, it will be whatever exception was thrown by run().
         */
        default void handleException(Throwable e) {}
    }
```

[`EventQueue.java#L25-L44`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/queue/EventQueue.java#L25-L44)。

`KafkaEventQueue` は `server-common` にある汎用のキューで、`run()` と `handleException()` の 2 メソッドしかない。

**`handleException` に渡される例外の種類が javadoc で列挙されている**のがよくできている。イベントがタイムアウトしたのか、キューが閉じられたのか、実行中に失敗したのか — **呼び出し側が区別できるように、契約として書いてある。**

デッドラインを持てるので、「10 秒以内に処理されなければタイムアウト」が実装できる。コントローラのリクエストにはタイムアウトがあり、これで実現されている。

### 遅いイベントの監視

```java title="metadata/src/main/java/org/apache/kafka/controller/EventPerformanceMonitor.java"
class EventPerformanceMonitor {
```

[`EventPerformanceMonitor.java#L35`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/EventPerformanceMonitor.java#L35)。

単一スレッドの設計には、**1 つの遅いイベントが全部を止める**という弱点がある。だから専用の監視クラスがある。定期的に「一番遅かったイベント」をログに出す。

**設計上の弱点に対して、観測手段を用意している。** 「詰まったら分かる」ようにしておくのが、単一スレッド設計を実運用に耐えさせる条件になっている。

## なぜそうなっているか

### 単一スレッドが成立する条件

「ロックを使わない」は魅力的だが、成立するには条件がある。

| 条件                          | コントローラの場合                                               |
| ----------------------------- | ---------------------------------------------------------------- |
| **処理が CPU バウンドで短い** | メモリ上のデータ構造の更新だけ。ディスクもネットワークも待たない |
| **スループット要求が低い**    | メタデータの変更は毎秒数千件のオーダー                           |
| **待ちを外に出せる**          | Raft のコミット待ちは `deferredEventQueue` へ                    |

**3 つ目が決定的だ。** もしイベントの中でコミットを待ったら、その間スレッドが止まって全部が詰まる。**「待つ処理を、待たない処理に分解する」ことができたから、単一スレッドが選べた。**

逆に、この分解のために API が非同期になり、future と `deferredEventQueue` という仕掛けが必要になった。**単純さはタダではなく、非同期性という形で代金を払っている。**

### 「レコードを返すだけ」にする意味

操作が `ControllerResult`(レコード列, 応答) を返すだけ、というのは強い制約だ。得られるものは 4 つある。

- **テストが単純になる。** 「この状態でこの操作をしたら、このレコードが出る」を assert するだけ。副作用を検査しなくていい。
- **アクティブと standby が同じコードで動く。** standby は `replay` だけを呼ぶ。アクティブは `generateRecordsAndResult` の後に `replay` を呼ぶ。**適用のコードは 1 つ。**
- **ログとメモリ状態が必ず一致する。** 状態を変える経路が `replay` の 1 本しかないので、「ログに書き忘れた変更」が原理的に起きない。
- **スナップショットからの復元も同じ経路。** [スナップショット](../metadata-snapshot/)もレコード列なので、`replay` するだけ。

**「決定 (何をすべきか)」と「適用 (状態を変える)」を分離する**という形で、Raft の状態機械レプリケーションのモデルにそのまま対応している。

### なぜコミット前に適用するのか

素直には「コミットされてから適用する」ほうが安全に見える。そうしない理由は **スループット**だ。

コミットを待ってから次の操作を処理すると、**Raft のラウンドトリップ (数ミリ秒) ごとに 1 操作**しか処理できない。1 秒に 200 操作程度になる。

コミット前に適用すれば、**次の操作は「前の操作が適用済み」の状態を見て処理できる。** パイプライン化され、Raft には複数の操作がまとめて流れる。

代償は、**「未コミットの状態」がメモリ上に存在すること**だ。これが 2 つの問題を生む。

1. **コミットに失敗したら巻き戻す必要がある。** → [timeline データ構造](../timeline-datastructures/)
2. **未コミットの状態を読んで答えると、嘘になりうる。** → 上で見た「読み取りもコミットを待つ」分岐

**楽観的に進めて、失敗したら巻き戻す**という選択が、この 2 つの仕掛けを必要としている。

### なぜ適用の失敗が致命的エラーなのか

`replay` が例外を投げたら、`fatalFaultHandler` がプロセスを落とす。乱暴に見えるが、根拠がある。

- レコードは **自分が生成したもの**だ。適用できないなら、生成のロジックか適用のロジックにバグがある。
- **他のコントローラは同じレコードを適用する。** 自分が適用できないなら、他も適用できない。クラスタ全体が壊れる。
- **中途半端に適用された状態で動き続けるほうが危険。** メモリ状態とログが食い違ったまま、その状態を元に次の決定をしてしまう。

**「起こるはずのないことが起きたら、進まずに止まる」** — 状態機械レプリケーションでは、全ノードが同じ結果に到達することが前提なので、そこが崩れたら続行できない。

### standby コントローラの意味

standby は「レコードを replay するだけ」の存在だ。**アクティブが落ちたら、すでに最新の状態をメモリに持っている**ので、即座に引き継げる。

ZooKeeper 時代は、新コントローラが ZooKeeper から全状態を読み直していた。パーティション 10 万個で数分かかった。**KRaft では、standby がずっと追いついているので、フェイルオーバーが秒のオーダーになる。**

**「常に全員が状態を持つ」というコストを払って、「切り替えが速い」を買っている。** メタデータのサイズが小さいから成立する。

## どう活かすか

**「単一スレッド + イベントキュー」でロックを消す設計は、状態が 1 台のメモリに載り、処理が短いなら強力に効く。** Redis、Node.js、そして Kafka の[コーディネータ](../coordinator-runtime/)も同じ形だ。**採用の条件は「待ちを全部キューの外に出せるか」で、これができないなら単一スレッドはただの直列化になる。** I/O 待ちが 1 つでも中に残っていると、その待ち時間が全操作に掛かる。

**「操作は、状態を変えずに『変更の記述』を返す」という形は、テスト容易性と正しさの両方に効く。** 状態を変える経路が 1 本になるので、「変更したがログに書き忘れた」が構造的に起きない。**イベントソーシングやコマンドパターンを採るとき、この分離を徹底できるかが分かれ目になる。** 「ついでにここでキャッシュも更新しておく」を許した瞬間に、この保証は崩れる。

**「楽観的に適用して、コミットを待って応答する」は、パイプライン化のための定番だが、2 つの後始末を伴う。** 巻き戻せる状態表現と、「未確定の状態を読んで答えてしまう」問題への対処だ。**後者は見落としやすい。** Kafka は「読み取りでも、未コミットの書き込みがあればそれを待つ」という 20 行の分岐でこれを塞いでいる。**楽観的な適用を採るなら、読み取り側の一貫性を最初に設計する。**

**「起こるはずのないことが起きたら止まる」という判断も、状態を複製するシステムでは正しいことが多い。** 続行すると、壊れた状態が複製されて広がる。**止めるべき境界を `fatalFaultHandler` のような明示的な仕組みにしておくと、「ここは致命的」という判断がコードに残る。**

**最後に、単一スレッド設計を採るなら「詰まりを観測する手段」を同時に作る。** `EventPerformanceMonitor` のように、遅いイベントを特定できる仕掛けがないと、性能問題が起きたときに何も分からない。**設計上の弱点は、消せないなら観測できるようにする。**
