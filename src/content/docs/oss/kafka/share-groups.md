---
title: "ログの上にキューを載せ、レコード単位の取得状態をブローカーが持つ"
description: "共有グループは、Kafka にキューの意味論を足す機能だ。パーティションより多いコンシューマを動かせて、レコードごとに ack/nack できる。実現のために、ブローカーはレコード 1 件ずつの状態を持ち、取得にはタイムアウト付きのロックが掛かる。「オフセット 1 つで進捗を表す」という Kafka の前提を、ここだけ捨てている。"
group: "コンシューマとグループ協調"
sidebar:
  order: 35
---

## 何を学んだか

### どんな状況の話か

Kafka のコンシューマグループには、2 つの制約がある。

- **並列度がパーティション数で頭打ちになる。** 1 パーティションは 1 メンバしか読めない。パーティション 10 個なら、コンシューマは 11 台目から遊ぶ。
- **進捗が offset 1 つで表される。** 「offset 100 までは処理済み」しか言えない。**101 だけ失敗して 102 は成功、が表現できない。**

これは Kafka がログだからこそ成立していた性質だ。進捗が単調増加する整数 1 つなので、[コミットが安く](../coordinator-runtime/)、順序が保証される。

だが、**キューとして使いたい**場面ではこれが邪魔になる。

- タスクキューでは、処理時間がタスクごとにバラバラだ。遅い 1 件が後ろを詰まらせる。
- 失敗した 1 件だけをリトライしたい。
- コンシューマを増やせば速くなってほしい。

### Kafka の答え

**「共有グループ」を追加し、ブローカーがレコード単位の状態を持つ。**

1. **1 パーティションを複数メンバが同時に読める。**
2. **レコードごとに状態を持つ。** `AVAILABLE` / `ACQUIRED` / `ACKNOWLEDGED` / `ARCHIVED`。
3. **取得したレコードには「取得ロック」が掛かる。** タイムアウトすると `AVAILABLE` に戻る。
4. **ack のしかたが 3 種類。** `ACCEPT` (成功)、`RELEASE` (他の人に譲る)、`REJECT` (捨てる)。
5. **配信回数を数え、上限を超えたら捨てる。** dead letter queue にも送れる (KIP-1191)。
6. **状態は `__share_group_state` トピックに永続化される。**

## ソースコードのどこか

### レコードの状態

```java title="server/src/main/java/org/apache/kafka/server/share/fetch/RecordState.java"
/**
 * The RecordState is used to track the state of a record that has been fetched from the leader.
 * The state of the records determines if the records should be re-delivered, move the next fetch
 * offset, or be state persisted to disk.
 */
public enum RecordState {
    AVAILABLE((byte) 0),
    ACQUIRED((byte) 1),
    ACKNOWLEDGED((byte) 2),
    ARCHIVING((byte) 3),    // Per KIP-1191
    ARCHIVED((byte) 4);
```

[`RecordState.java#L21-L31`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/share/fetch/RecordState.java#L21-L31)。

**レコード 1 件ごとに、この 5 状態のどれかを持つ。**

| 状態           | 意味                                   |
| -------------- | -------------------------------------- |
| `AVAILABLE`    | まだ誰も取っていない。取得できる       |
| `ACQUIRED`     | 誰かが取得中。**ロックが掛かっている** |
| `ACKNOWLEDGED` | 処理成功。終端                         |
| `ARCHIVING`    | dead letter queue へ送る途中           |
| `ARCHIVED`     | 捨てられた。終端                       |

遷移の検証がコードとして書かれている。

```java title="server/src/main/java/org/apache/kafka/server/share/fetch/RecordState.java"
public RecordState validateTransition(RecordState newState) throws IllegalStateException {
    Objects.requireNonNull(newState, "newState cannot be null");
    if (this == newState) {
        throw new IllegalStateException("The state transition is invalid as the new state is "
            + "the same as the current state");
    }

    if (this == ACKNOWLEDGED || this == ARCHIVED) {
        throw new IllegalStateException("The state transition is invalid from the current state: " + this);
    }

    if (this == AVAILABLE && newState != ACQUIRED) {
        throw new IllegalStateException("The state can only be transitioned to ACQUIRED from AVAILABLE");
    }

    // Either the transition is from Available -> Acquired or from Acquired -> Available/
    // Acknowledged/Archived.
    return newState;
}
```

[`RecordState.java#L48-L68`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/share/fetch/RecordState.java#L48-L68)。

**終端状態からは動けない。** `AVAILABLE` からは `ACQUIRED` にしか行けない。**取得を経由せずに ack はできない。**

返り値が `newState` なのは、`state = state.validateTransition(ACQUIRED)` と書けるようにするため — javadoc に `Returning newState helps state assignment chaining` と明記されている。

### ack の種類と状態の対応

```java title="core/src/main/java/kafka/server/share/SharePartition.java"
/**
 * To provide static mapping between acknowledgement type bytes to RecordState.
 */
private static final Map<Byte, RecordState> ACK_TYPE_TO_RECORD_STATE = Map.of(
    (byte) 0, RecordState.ARCHIVED,                             // Represents gap
    AcknowledgeType.ACCEPT.id, RecordState.ACKNOWLEDGED,
    AcknowledgeType.RELEASE.id, RecordState.AVAILABLE,
    AcknowledgeType.REJECT.id, RecordState.ARCHIVED
);
```

[`SharePartition.java#L146-L155`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/java/kafka/server/share/SharePartition.java#L146-L155)。

**3 種類の ack が、それぞれ違う状態になる。**

- **`ACCEPT`** → `ACKNOWLEDGED`。処理できた。もう配らない。
- **`RELEASE`** → `AVAILABLE`。**処理できなかったが、他の人なら処理できるかもしれない。** すぐ再配布される。
- **`REJECT`** → `ARCHIVED`。**このレコードは誰が処理しても無理。** 捨てる。

**`(byte) 0` が「ギャップ」を表す**のが目を引く。[トランザクションで中断されたレコード](../transactions-eos/)や、[圧縮で消えたレコード](../log-compaction/)は、offset として存在するが実体がない。それを `ARCHIVED` として扱う。

**「存在しない offset」を状態機械の中で表現している。**

### 取得ロック

```java title="core/src/main/java/kafka/server/share/SharePartition.java"
/**
 * Apply acquisition lock to acquired records.
 *
 * @param memberId The member id of the client that is putting the acquisition lock.
 * @param firstOffset The first offset of the acquired records.
 * @param lastOffset The last offset of the acquired records.
 * @param delayMs The delay in milliseconds after which the acquisition lock will be released.
 */
private AcquisitionLockTimerTask scheduleAcquisitionLockTimeout(
    String memberId,
    long firstOffset,
    long lastOffset,
    long delayMs
) {
    AcquisitionLockTimerTask acquisitionLockTimerTask = acquisitionLockTimerTask(memberId, firstOffset, lastOffset, delayMs);
    timer.add(acquisitionLockTimerTask);
    return acquisitionLockTimerTask;
}
```

[`SharePartition.java#L2933-L2950`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/java/kafka/server/share/SharePartition.java#L2933-L2950)。

**取得したレコードには、タイムアウト付きのロックが掛かる。** 期限内に ack が来なければ、自動的に `AVAILABLE` に戻る。

`timer` は [purgatory と同じ階層タイムホイール](../purgatory/) だ。**レコードのバッチごとにタイマータスクが 1 つ登録される**ので、数が多くなる。O(1) の挿入・削除が効く。

**これがコンシューマの死活監視を兼ねている。** メンバが落ちても、ロックが切れて他の人が取れる。**セッションタイムアウトを待つ必要がない。**

ロック期間は動的設定で変えられる。

```java title="core/src/main/java/kafka/server/share/SharePartition.java"
// The recordLockDuration value would depend on whether the dynamic config SHARE_RECORD_LOCK_DURATION_MS in
// GroupConfig.java is set or not. If dynamic config is set, then that is used, otherwise the value of
// SHARE_GROUP_RECORD_LOCK_DURATION_MS_CONFIG defined in ShareGroupConfig is used
```

[`SharePartition.java#L2926-L2928`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/java/kafka/server/share/SharePartition.java#L2926-L2928)。

**グループ単位の設定がブローカー全体の設定を上書きする。** 処理時間の長いグループだけロックを延ばせる。

### 配信回数の上限

```java title="core/src/main/java/kafka/server/share/SharePartition.java"
InFlightState updateResult = inFlightBatch.tryUpdateBatchState(RecordState.ACQUIRED, DeliveryCountOps.INCREASE, maxDeliveryCount(), memberId, isDLQEnabledForGroup());
```

[`SharePartition.java#L968`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/java/kafka/server/share/SharePartition.java#L968)。

**取得のたびに配信回数が増える。** `share.delivery.count.limit` を超えたら、そのレコードは `ARCHIVED` (または dead letter queue へ) になる。

```java title="group-coordinator/src/main/java/org/apache/kafka/coordinator/group/GroupConfig.java"
public static final String SHARE_DELIVERY_COUNT_LIMIT_CONFIG = "share.delivery.count.limit";
```

[`GroupConfig.java#L69`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/group-coordinator/src/main/java/org/apache/kafka/coordinator/group/GroupConfig.java#L69)。

**「毒メッセージ」で無限にリトライしないための仕組み**で、一般的なメッセージキューが持つ機能と同じものだ。

### 状態の管理単位

```java title="core/src/main/java/kafka/server/share/SharePartition.java"
/**
 * The SharePartition is used to track the state of a partition that is shared between multiple
 * consumers. The class maintains the state of the records that have been fetched from the leader
 * and are in-flight.
 */
@SuppressWarnings({"ClassDataAbstractionCoupling", "ClassFanOutComplexity"})
public class SharePartition {
```

[`SharePartition.java#L97-L103`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/java/kafka/server/share/SharePartition.java#L97-L103)。

**このクラスは 195 KB ある。** Kafka のコードベースで最大級だ。静的解析の警告を 2 つ抑制している。

状態は **バッチ単位とレコード単位のハイブリッド**で持つ。

- **バッチ全体が同じ状態なら、バッチ 1 つで表す。** メモリを節約。
- **バッチの中で状態が分かれたら、offset ごとに分解する。**

`batchState()` と `offsetState()` という 2 つのアクセサがあり、コードのあちこちで「バッチ単位で扱えるか」を判定している。**大半のケース (全部 ack される) ではバッチのまま扱えるので、レコードごとの状態を作らずに済む。**

### 進捗の表現

```java title="core/src/main/java/kafka/server/share/SharePartition.java"
/**
 * The deliveryCompleteCount tracks the number of terminal (ACKNOWLEDGED / ARCHIVED) records within the
 * cachedState. This is used in the calculations for determining the current Share Partition lag.
 */
private final AtomicInteger deliveryCompleteCount;
```

[`SharePartition.java#L300-L305`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/java/kafka/server/share/SharePartition.java#L300-L305)。

**`startOffset` より前は全部処理済み。それ以降は「まだ終端に達していないレコードがある」領域。** ラグを計算するために、終端状態のレコード数を別に数えている。

**通常のコンシューマグループなら、ラグは `LEO - コミット済み offset` の引き算 1 回だ。** 共有グループでは、**穴が空きうる**ので数え上げが要る。

状態は `__share_group_state` トピックに書かれ、[共有コーディネータ](../coordinator-runtime/)が管理する。

```java title="share-coordinator/src/main/java/org/apache/kafka/coordinator/share/ShareCoordinatorShard.java"
public class ShareCoordinatorShard implements CoordinatorShard<CoordinatorRecord> {
```

[`ShareCoordinatorShard.java#L75`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/share-coordinator/src/main/java/org/apache/kafka/coordinator/share/ShareCoordinatorShard.java#L75)。

**`CoordinatorShard` を実装するだけ。** [共通の実行基盤](../coordinator-runtime/)に載っている。

## なぜそうなっているか

### なぜ「offset 1 つ」を捨てたのか

Kafka のコンシューマグループが速いのは、**進捗が整数 1 つだから**だ。コミットは 1 レコードの追記、リバランスは整数の受け渡し、ラグは引き算。

共有グループは、この前提を全部捨てる。

|                    | コンシューマグループ         | 共有グループ                                      |
| ------------------ | ---------------------------- | ------------------------------------------------- |
| 進捗の表現         | **offset 1 つ**              | **レコードごとの状態**                            |
| ブローカー側の状態 | グループごとに offset の Map | **パーティションごとに in-flight レコードの集合** |
| ラグの計算         | 引き算                       | **数え上げ**                                      |
| コミットのコスト   | レコード 1 件                | 状態バッチのレコード                              |

**捨てた見返りが「キューの意味論」だ。** パーティション数を超える並列度、レコード単位の ack、自動リトライ、dead letter queue。

**同じシステムの中に、2 つの消費モデルを共存させている。** どちらかに統一していない。

### なぜロックにタイムアウトを掛けるのか

「取得したレコードは、その人が ack するまで他の人に渡さない」を実現するには、ロックが要る。**ロックの解放を持ち主に任せると、持ち主が落ちたときに永久にロックされる。**

タイムアウトを付けると、**落ちた場合も自動的に回収される。** メンバの死活監視とは独立に動く。

**これは「リースの取得」であって「ロックの取得」ではない。** 分散システムでロックを扱うときの定型で、**期限のないロックは、持ち主が消えたときに回収できない。**

代償として、**処理が遅いだけのメンバからもロックが剥がされる。** そのレコードは他の人にも配られ、**二重処理になる。** 共有グループは at-least-once であって、exactly-once ではない。

### なぜ ack が 3 種類なのか

`ACCEPT` と `REJECT` だけでは足りない。**「自分では処理できないが、他の人なら処理できるかもしれない」**が表現できない。

- 一時的なリソース不足
- 依存する外部サービスがそのメンバからだけ見えない
- シャットダウン中で、処理を引き継ぎたい

`RELEASE` があると、**配信回数は増えるが、すぐ他の人に回る。** タイムアウトを待つ必要がない。

**「失敗」を一律に扱わず、原因が恒久的か一時的かをクライアントに宣言させる。** [プロデューサの `RetriableException` と非 retriable の区別](../tiered-storage/) と同じ発想になっている。

### なぜバッチとレコードのハイブリッドなのか

レコードごとに状態を持つと、**メモリが in-flight レコード数に比例する。** 1 パーティションで数万件が in-flight なら、数万個のオブジェクトになる。

だが実際には、**「バッチ全体が同じ状態」が圧倒的に多い。** 取得したらバッチ全体が `ACQUIRED`、成功したらバッチ全体が `ACKNOWLEDGED`。

**分かれるのは「バッチの一部だけ失敗した」ときだけ。** そのときだけ offset ごとに分解する。

**「例外的なケースだけ細かく持つ」** という表現の選択で、[疎インデックス](../sparse-index/)や[ELR が平常時は空](../elr/)なのと同じ考え方だ。

### なぜ 195 KB になったのか

1 クラスが 195 KB あるのは明らかに大きい。原因は、**扱う状態の組み合わせが多いこと**にある。

- 5 つのレコード状態 × バッチ/オフセットの 2 表現
- 取得、解放、タイムアウト、ack の 3 種類、fence、初期化、永続化
- 状態遷移中 (`hasOngoingStateTransition`) の扱い
- 進行中の永続化リクエストとの競合

**新しい機能を既存のモデルの外側に足すと、こういう肥大化が起きる。** offset 1 つで済んでいたものを、状態機械の集合に置き換えたので、その分の複雑さが 1 箇所に集まった。

**`@SuppressWarnings({"ClassDataAbstractionCoupling", "ClassFanOutComplexity"})` は、その自覚の表明でもある。** 静的解析が「このクラスは他のクラスに依存しすぎ」と言っているのを、承知の上で抑制している。

### 既存の部品の再利用

新機能でありながら、**新しく作られた仕組みはほとんどない。**

| 使っているもの                 | 元は                                                |
| ------------------------------ | --------------------------------------------------- |
| `__share_group_state` トピック | [内部トピックの流儀](../architecture/)              |
| `ShareCoordinatorShard`        | [コーディネータの実行基盤](../coordinator-runtime/) |
| 取得ロックのタイマー           | [purgatory の階層タイムホイール](../purgatory/)     |
| `DelayedShareFetch`            | [purgatory](../purgatory/)                          |
| `ShareHeartbeatRequestManager` | [コンシューマの背景スレッド](../consumer-async/)    |
| `SimpleAssignor`               | [アサイナの枠組み](../assignor/)                    |

**新しいのは `SharePartition` (レコード単位の状態管理) だけ**と言ってもいい。**基盤が揃っていると、新機能の実装が「本質的に新しい部分」だけで済む。**

## どう活かすか

**「ログ型の消費モデル」と「キュー型の消費モデル」は本質的に違う要求で、片方で両方をやろうとすると無理が出る。** offset 1 つで進捗を表す設計は速いが、順序と全件処理を前提にしている。**レコード単位の ack が要るなら、状態を持つコストを受け入れるしかない。** Kafka はどちらかに統一せず、両方を提供する道を選んだ。

**「ロックには必ず期限を付ける」は分散システムの鉄則だ。** 持ち主が消えたときに回収できないロックは、いずれ必ずシステムを止める。**期限付きにすれば、二重処理を受け入れる代わりに、確実に前に進む。** どちらを取るかは、二重処理の害と停止の害を比べて決める。

**「失敗を一律に扱わず、原因の性質をクライアントに宣言させる」も応用が広い。** `RELEASE` (他の人なら成功するかも) と `REJECT` (誰がやっても無理) を分けると、**再配布の判断がサーバ側で正しくできる。** 一律に「失敗」だと、タイムアウトを待つか、無限にリトライするかしかない。

**「例外的なケースだけ細かく持つ」という表現の選択は、メモリが問題になる場面で繰り返し使える。** 大半が均一なら均一のまま持ち、分かれたときだけ分解する。**「常に最も細かい粒度で持つ」は単純だが、支配的なケースで無駄になる。**

**そして、この機能が示しているのは「基盤が揃っていると新機能が安くなる」という当たり前の事実だ。** 共有グループは大きな機能だが、コーディネータの実行基盤・タイマー・purgatory・内部トピックの流儀を全部再利用している。**新しく書いたのは、本当に新しい部分だけ。** 基盤に投資する価値は、こういう場面で回収される。
