---
title: "コーディネータをパーティションごとの状態機械にする"
description: "グループ協調・トランザクション・共有グループの 3 つのコーディネータは、同じ実行基盤を共有している。内部トピックのパーティション 1 つが状態機械 1 つに対応し、そのパーティションに関するイベントは決して並行に処理されない。スレッドプールを使いながら「キーごとには直列」を保つ仕組みが、その中核にある。"
sidebar:
  order: 33
---

## 何を学んだか

### どんな状況の話か

Kafka には「コーディネータ」と呼ばれるものが 3 つある。

| コーディネータ                 | 内部トピック          | 何を管理するか                                                      |
| ------------------------------ | --------------------- | ------------------------------------------------------------------- |
| グループコーディネータ         | `__consumer_offsets`  | [コンシューマグループ](../rebalance-protocol/)とコミット済み offset |
| トランザクションコーディネータ | `__transaction_state` | [トランザクションの状態](../transactions-eos/)                      |
| 共有コーディネータ             | `__share_group_state` | [共有グループの取得状態](../share-groups/)                          |

3 つとも、構造がまったく同じだ。

- 内部トピックのパーティションに、対象 (グループ ID や `transactional.id`) をハッシュで割り当てる。
- **そのパーティションのリーダーであるブローカーが、そのコーディネータになる。**
- 状態はメモリに持ち、変更はレコードとしてそのパーティションに書く。
- **書いたレコードがコミットされてから、クライアントに応答する。**

これは [`QuorumController`](../quorum-controller/) とも同じ構造で、違うのは「パーティションが 1 個か、たくさんあるか」だけだ。

### Kafka の答え

**共通の実行基盤 `CoordinatorRuntime` を作り、3 つのコーディネータが載る。**

```java title="coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/CoordinatorRuntime.java"
/**
 * The CoordinatorRuntime provides a framework to implement coordinators such as the group coordinator
 * or the transaction coordinator.
 *
 * The runtime framework maps each underlying partitions (e.g. __consumer_offsets) that the broker is a
 * leader of to a coordinator replicated state machine. A replicated state machine holds the hard and soft
 * state of all the objects (e.g. groups or offsets) assigned to the partition. The hard state is stored in
 * timeline datastructures backed by a SnapshotRegistry. The runtime supports two type of operations
 * on state machines: (1) Writes and (2) Reads.
 *
 * (1) A write operation, aka a request, can read the full and potentially **uncommitted** state from state
 * machine to handle the operation. A write operation typically generates a response and a list of
 * records. The records are applied to the state machine and persisted to the partition. The response
 * is parked until the records are committed and delivered when they are.
 *
 * (2) A read operation, aka a request, can only read the committed state from the state machine to handle
 * the operation. A read operation typically generates a response that is immediately completed.
 *
 * The runtime framework exposes an asynchronous, future based, API to the world. All the operations
 * are executed by an CoordinatorEventProcessor. The processor guarantees that operations for a
 * single partition or state machine are not processed concurrently.
 */
public class CoordinatorRuntime<S extends CoordinatorShard<U>, U> implements AutoCloseable {
```

[`CoordinatorRuntime.java#L76-L100`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/CoordinatorRuntime.java#L76-L100)。

**この javadoc に設計が全部書いてある。**

1. **パーティション 1 つ = 状態機械 1 つ。**
2. **hard state は [timeline データ構造](../timeline-datastructures/)に持つ。** 巻き戻せる。
3. **書き込みは未コミットの状態を読んでよい。応答はコミットまで保留する。**
4. **読み取りはコミット済みの状態しか読まない。応答は即座に返す。**
5. **同じパーティションのイベントは並行に処理されない。**

## ソースコードのどこか

### 「キーごとに直列」を保つスレッドプール

```java title="coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/MultiThreadedEventProcessor.java"
/**
 * A multithreaded {@link CoordinatorEvent} processor which uses a {@link EventAccumulator}
 * which guarantees that events sharing a partition key are not processed concurrently.
 */
public final class MultiThreadedEventProcessor implements CoordinatorEventProcessor {
```

[`MultiThreadedEventProcessor.java#L32-L36`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/MultiThreadedEventProcessor.java#L32-L36)。

**`QuorumController` は単一スレッドだったが、こちらはスレッドプールだ。** パーティションが 50 個あるなら並行に処理したい。

だが **同じパーティションのイベントは直列でなければならない。** それを保証するのが `EventAccumulator` になる。

```java title="coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/EventAccumulator.java"
/**
 * A concurrent event accumulator which groups events per key and ensures that only one
 * event with a given key can be processed concurrently.
 */
public class EventAccumulator<K, T extends EventAccumulator.Event<K>> implements AutoCloseable {
```

[`EventAccumulator.java#L30-L41`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/EventAccumulator.java#L30-L41)。

実装が素直だ。

```java title="coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/EventAccumulator.java"
public T poll(long timeout, TimeUnit unit) {
    lock.lock();
    try {
        var key = randomKey();
        var nanos = unit.toNanos(timeout);
        while (key == null && !closed && nanos > 0) {
            try {
                nanos = condition.awaitNanos(nanos);
            } catch (InterruptedException e) {
                // Ignore.
            }
            key = randomKey();
        }

        if (key == null) return null;

        var queue = queues.get(key);
        var event = queue.poll();

        if (queue.isEmpty()) queues.remove(key);
        inflightKeys.add(key);
        size--;

        return event;
```

[`EventAccumulator.java#L150-L176`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/EventAccumulator.java#L150-L176)。

**仕組みは 3 つの部品だけ。**

1. **キーごとのキュー** (`queues`) — パーティションごとにイベントが並ぶ。
2. **処理中のキーの集合** (`inflightKeys`) — 誰かが処理中のキー。
3. **`randomKey()`** — `inflightKeys` に入っていないキーから 1 つ選ぶ。

**処理中のキーは選ばれないので、同じパーティションのイベントが 2 つのスレッドに渡ることがない。** 処理が終わったら `inflightKeys` から外し、他のスレッドが取れるようになる。

**`randomKey()` — ランダムに選ぶ。** 順番に選ぶと、キューの先頭にあるパーティションが常に優先される。ランダムなら公平になる。

**「スレッドプールの並行性」と「キーごとの直列性」を、40 行程度で両立している。**

### コーディネータの状態

```java title="coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/CoordinatorRuntime.java"
/**
 * The various state that a coordinator for a partition can be in.
 */
public enum CoordinatorState {
    /**
     * Initial state when a coordinator is created.
     */
    INITIAL {
        @Override
        boolean canTransitionFrom(CoordinatorState state) {
            return false;
        }
    },

    /**
     * The coordinator is being loaded.
     */
    LOADING {
        @Override
        boolean canTransitionFrom(CoordinatorState state) {
            return state == INITIAL || state == FAILED;
        }
    },
    ...
    abstract boolean canTransitionFrom(CoordinatorState state);
}
```

[`CoordinatorRuntime.java#L262-L316`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/CoordinatorRuntime.java#L262-L316)。

**遷移の可否を、enum のメソッドとして各状態が持っている。** [トランザクション状態の `VALID_PREVIOUS_STATES`](../transactions-eos/) が Map だったのに対し、こちらは抽象メソッドの実装になっている。

**`LOADING` が独立した状態なのが重要だ。** ブローカーがそのパーティションのリーダーになったとき、**まず内部トピックを先頭から読んで状態を再構築する。** 数百万のグループがあれば時間がかかる。

その間はリクエストを受け付けられないので、`COORDINATOR_LOAD_IN_PROGRESS` を返す。クライアントはリトライする。

### バッチとロールバック

```java title="coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/CoordinatorRuntime.java"
/**
 * A simple container class to hold all the attributes
 * related to a pending batch.
 */
private static class CoordinatorBatch {
    /**
     * The base (or first) offset of the batch. If the batch fails
     * for any reason, the state machines is rolled back to it.
     */
    final long baseOffset;
```

[`CoordinatorRuntime.java#L318-L328`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/CoordinatorRuntime.java#L318-L328)。

**バッチが失敗したら、そのバッチの先頭 offset まで状態機械を巻き戻す。** [timeline データ構造](../timeline-datastructures/)の `revertToSnapshot` がここで使われる。

`appendLingerMs` という設定もある。

```java title="coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/CoordinatorRuntime.java"
private OptionalInt appendLingerMs;
```

[`CoordinatorRuntime.java#L122`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/coordinator-common/src/main/java/org/apache/kafka/coordinator/common/runtime/CoordinatorRuntime.java#L122)。

**[プロデューサの `linger.ms`](../record-accumulator/) と同じ発想が、ここにもある。** 複数のリクエストが生成したレコードを 1 つのバッチにまとめて書く。オフセットコミットが毎秒数千件来るなら、1 件ずつ書くのは無駄だ。

**待つと、レイテンシと引き換えにスループットが上がる。** 同じトレードオフが、クライアント側とサーバ側の両方に現れている。

### 読み書きの非対称

javadoc に戻ると、書き込みと読み取りの扱いが違う。

|              | 読める状態               | 応答のタイミング                 |
| ------------ | ------------------------ | -------------------------------- |
| **書き込み** | **未コミットを含む最新** | **レコードがコミットされてから** |
| **読み取り** | **コミット済みのみ**     | **即座**                         |

**書き込みが未コミットの状態を読めるのは、パイプライン化のためだ。** 前のリクエストのコミットを待たずに、次のリクエストを処理できる。

**読み取りがコミット済みしか読めないのは、嘘をつかないためだ。** 未コミットの状態を返して、それがロールバックされたら、クライアントは存在しないものを見たことになる。

**[`QuorumController` は、読み取りでも未コミットの書き込みがあれば待っていた](../quorum-controller/)。** こちらは「コミット済みの状態を読む」ことで、待たずに済ませている。**[timeline データ構造が「過去の状態を読む」API を持っている](../timeline-datastructures/)から可能になっている。**

## なぜそうなっているか

### なぜ 3 つのコーディネータで基盤を共有するのか

グループコーディネータとトランザクションコーディネータは、もともと別々に実装されていた (今も `TransactionCoordinator` は Scala で書かれた古い実装が残っている)。

共通化して得られたものは、

- **同じ最適化が全部に効く。** `appendLingerMs`、バッチ書き込み、timeline データ構造。
- **新しいコーディネータを安く作れる。** 共有コーディネータは KIP-932 で追加されたが、`CoordinatorShard` を実装するだけで済んだ。
- **運用の指標が揃う。** `CoordinatorRuntimeMetrics` が共通で、同じメトリクス名で観測できる。

**「同じ構造のものが 3 つできたら、基盤を抜き出す」** という判断で、3 つ目を作るときに元が取れている。

### なぜ単一スレッドではなくスレッドプールなのか

[`QuorumController`](../quorum-controller/) は単一スレッドを選んだ。コーディネータはスレッドプールを選んだ。**違いは「独立した状態機械が何個あるか」だ。**

- **コントローラ**: メタデータは 1 つ。分割できない ([1 パーティションの理由](../kraft-overview/))。
- **コーディネータ**: パーティションが 50 個あれば、状態機械も 50 個。**互いに独立している。**

独立しているなら並行に処理できる。**ただし、同じパーティションのイベントは直列でなければならない** — でないと timeline データ構造が壊れる (`All of these classes require external synchronization`)。

**「並行にできる単位」が明確なら、スレッドプール + キーごとの直列化が使える。** 単位が 1 つしかないなら、単一スレッドが単純でよい。

### `EventAccumulator` の設計が効いている理由

「キーごとに直列」を実現する素朴な方法は、**キーごとにスレッドを 1 本立てる**ことだ。パーティション 50 個なら 50 スレッド。

これは動くが、**パーティション数が増えるとスレッドが増える。** そして、ほとんどのスレッドは暇にしている。

`EventAccumulator` は、**スレッド数とキー数を独立させる。** スレッド 8 本でキー 50 個を捌ける。

実装の要は **`inflightKeys` という 1 つの集合**だけだ。「処理中のキーは選ばない」というルールが、それだけで直列性を保証する。**ロックは 1 本、状態は 3 つ。**

**単純な仕組みで強い性質を得ている**例で、「キーごとの順序保証」が必要な場面 (メッセージ処理、イベントソーシング、アクターモデル) で広く使える。

### なぜ `LOADING` を明示的な状態にするのか

リーダーになったら、まず状態を再構築する。この間をどう扱うか。

- **リクエストを受け付けて待たせる** → いつ終わるか分からない。タイムアウトが読めない。
- **エラーを返す** → クライアントがリトライする。

Kafka は後者で、`COORDINATOR_LOAD_IN_PROGRESS` という専用のエラーコードを返す。**「今は無理だが、後で試せば成功する」を明示的に伝えている。**

**汎用の「一時的エラー」ではなく、専用のコードにする**ことで、クライアントは適切なバックオフを選べるし、運用者はメトリクスで「ロード中のパーティションがある」と分かる。

### 読み取りを「コミット済みのみ」にできる理由

`QuorumController` は、読み取りでも未コミットの書き込みを待っていた。コーディネータは待たない。**違いは、状態を読む API があるかどうかだ。**

[timeline データ構造](../timeline-datastructures/)は、`get(key, epoch)` のように **「どの時点の状態か」を指定して読める。** コミット済みの offset を epoch として渡せば、コミット済みの状態だけが返る。

**「待つ」代わりに「過去を読む」。** 待たないので、読み取りリクエストがレイテンシに影響しない。

**同じデータ構造を使いながら、使い方が違う。** コントローラは「今の状態」を読んで待ち、コーディネータは「コミット済みの状態」を読んで待たない。

## どう活かすか

**「キーごとに直列、キー間は並行」は、イベント処理で最も頻出する要求だ。** キーごとにスレッドを立てる実装は、キー数が増えると破綻する。**`EventAccumulator` の形 (キーごとのキュー + 処理中キーの集合 + ランダム選択) は 100 行以下で書けて、スレッド数とキー数を独立させられる。** アクターモデルのフレームワークを入れる前に、これで足りないかを考える価値がある。

**「処理中のキーからは選ばない」だけで直列性が保証される、という単純さを守りたい。** 優先度やフェアネスを足したくなるが、まずランダム選択で十分なことが多い。**Kafka も `randomKey()` の 1 行で公平性を得ている。**

**「同じ構造のものが 3 つできたら基盤を抜き出す」— 2 つでは早い、というのも実務的な判断だ。** Kafka は 2 つ目 (トランザクション) の時点では共通化せず、3 つ目 (共有グループ) を作るときに基盤ができていた。**共通化の元が取れるのは、3 つ目からのことが多い。**

**「準備中」を専用の状態とエラーコードにする。** 汎用の「一時的エラー」で返すと、クライアントは適切なリトライ間隔を選べず、運用者は何が起きているか分からない。**状態を持つコンポーネントには、必ず「まだ使えない」期間がある。** それを最初から設計に入れる。

**そして、「待つ」と「過去を読む」は交換可能なことがある。** 未確定の状態を読みたくないとき、確定するまで待つのが素朴な解だが、**過去の確定した状態を読めるデータ構造があれば、待たずに済む。** レイテンシが重要なら、この交換を検討する価値がある。
