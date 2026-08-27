---
title: "トランザクションと read_committed が作る「まだ読めない領域」"
description: "Kafka のトランザクションは、複数パーティションへの書き込みを 1 つの単位にする。コミットの印は各パーティションのログに書かれる「マーカー」というレコードで、コーディネータが 2 相コミットの調整役になる。読み手側には「LSO」という 4 本目の offset が現れ、high watermark より手前で止まる。"
sidebar:
  order: 29
---

## 何を学んだか

### どんな状況の話か

[冪等プロデューサ](../idempotent-producer/) は「1 パーティションへの再送を重複させない」を解いた。だが、次の要求はそれでは足りない。

- **複数パーティションへの書き込みを、全部成功か全部失敗にしたい。**
- **「読んで、処理して、書いて、コミット」を 1 つの原子的な操作にしたい。** これが Kafka Streams の exactly-once の基礎になる。
- **アプリが再起動しても、中途半端な状態を残したくない。**

さらに難しい制約がある。**追記専用のログでは、書いたものを消せない。** 「トランザクションが失敗したので、さっき書いたレコードを取り消す」ができない。

### Kafka の答え

**書いたものは消さない。「これはコミットされた/中断された」を後から別のレコードで書き足す。**

1. **プロデューサは `transactional.id` を持つ。** これはアプリの再起動をまたいで同じ ID になる。
2. **`__transaction_state` トピックにコーディネータが状態を書く** ([内部トピックのページ](../architecture/))。
3. **コミット時、各パーティションのログに「マーカー」という制御レコードを書く。**
4. **読み手は `read_committed` を指定すると、LSO (last stable offset) より先を読まない。**
5. **中断されたレコードは、`.txnindex` を見てコンシューマ側で捨てる** ([プロデューサ状態のページ](../producer-state/))。

## ソースコードのどこか

### 状態機械

```java title="transaction-coordinator/src/main/java/org/apache/kafka/coordinator/transaction/TransactionState.java"
/**
 * Represents the states of a transaction in the transaction coordinator.
 */
public enum TransactionState {
    /**
     * Transaction has not existed yet
     * <p>
     * transition: received AddPartitionsToTxnRequest => Ongoing
     *             received AddOffsetsToTxnRequest => Ongoing
     *             received EndTxnRequest with abort and TransactionV2 enabled => PrepareAbort
     */
    EMPTY((byte) 0, ...),
    ONGOING((byte) 1, ...),
    PREPARE_COMMIT((byte) 2, ...),
    PREPARE_ABORT((byte) 3, ...),
    COMPLETE_COMMIT((byte) 4, ...),
    COMPLETE_ABORT((byte) 5, ...),
    DEAD((byte) 6, "Dead", false),
    /**
     * We are in the middle of bumping the epoch and fencing out older producers.
     */
    PREPARE_EPOCH_FENCE((byte) 7, ...);
```

[`TransactionState.java#L27-L82`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/transaction-coordinator/src/main/java/org/apache/kafka/coordinator/transaction/TransactionState.java#L27-L82)。

**8 状態。** `PREPARE_*` と `COMPLETE_*` に分かれているのが 2 相コミットの形だ。

- **`PREPARE_COMMIT`**: コーディネータが「コミットする」と決めてログに書いた。**まだマーカーは配っていない。**
- **`COMPLETE_COMMIT`**: 全パーティションにマーカーを書き終えた。

**`PREPARE` を先にログに書くのが 2 相コミットの本質だ。** コーディネータが落ちても、復帰したときに「コミットすると決めていた」と分かる。マーカーを配り直せる。

そして、遷移が **データとして**書かれている。

```java title="transaction-coordinator/src/main/java/org/apache/kafka/coordinator/transaction/TransactionState.java"
public static final Map<TransactionState, Set<TransactionState>> VALID_PREVIOUS_STATES = Map.of(
    EMPTY, Set.of(EMPTY, COMPLETE_COMMIT, COMPLETE_ABORT),
    ONGOING, Set.of(ONGOING, EMPTY, COMPLETE_COMMIT, COMPLETE_ABORT),
    PREPARE_COMMIT, Set.of(ONGOING),
    PREPARE_ABORT, Set.of(ONGOING, PREPARE_EPOCH_FENCE, EMPTY, COMPLETE_COMMIT, COMPLETE_ABORT),
    COMPLETE_COMMIT, Set.of(PREPARE_COMMIT),
    COMPLETE_ABORT, Set.of(PREPARE_ABORT),
    DEAD, Set.of(EMPTY, COMPLETE_ABORT, COMPLETE_COMMIT),
    PREPARE_EPOCH_FENCE, Set.of(ONGOING)
);
```

[`TransactionState.java#L93-L102`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/transaction-coordinator/src/main/java/org/apache/kafka/coordinator/transaction/TransactionState.java#L93-L102)。

**「この状態に来られるのは、どの状態からか」を Map で持つ。** 遷移を試みるたびに、この表で検証する。`if` の連鎖ではなく **データ** になっているので、遷移図がそのまま読める。

`PREPARE_ABORT` の許容元が 5 つと多い。理由がコメントにある。

```java title="transaction-coordinator/src/main/java/org/apache/kafka/coordinator/transaction/TransactionState.java"
 * Note, In transaction v2, we allow Empty, CompleteCommit, CompleteAbort to transition to PrepareAbort. because the
 * client may not know the txn state on the server side, it needs to send endTxn request when uncertain.
```

[`TransactionState.java#L54-L61`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/transaction-coordinator/src/main/java/org/apache/kafka/coordinator/transaction/TransactionState.java#L54-L61)。

**クライアントは自分がトランザクションを開始できていたか分からないことがある。** 分からないなら「中断してくれ」と送る。すでに終わっていた場合でも、それを受け付ける。**「念のため中断」を許容するために、遷移を緩めている。**

`PREPARE_EPOCH_FENCE` は、**タイムアウトしたトランザクションを強制終了する**ための状態だ。古いプロデューサをエポックで締め出してから中断する。

### コミットの印

```java title="clients/src/main/java/org/apache/kafka/common/record/internal/EndTransactionMarker.java"
/**
 * This class represents the control record which is written to the log to indicate the completion
 * of a transaction. The record key specifies the {@link ControlRecordType control type} and the
 * value embeds information useful for write validation (for now, just the coordinator epoch).
 */
public class EndTransactionMarker {
```

[`EndTransactionMarker.java#L29-L34`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/EndTransactionMarker.java#L29-L34)。

**マーカーは、普通のレコードとしてログに書かれる。** ただし[バッチ属性の `Control` ビット](../record-batch/)が立っているので、コンシューマには配られない。

値に `coordinatorEpoch` が入っている。**古いコーディネータが遅れてマーカーを書きに来たとき、ブローカーが拒否できる。** ここでも世代番号が使われている。

### マーカーを配る仕組み

```scala title="core/src/main/scala/kafka/coordinator/transaction/TransactionMarkerChannelManager.scala"
class TransactionMarkerChannelManager(
  config: KafkaConfig,
  metadataCache: MetadataCache,
  networkClient: NetworkClient,
  txnStateManager: TransactionStateManager,
  time: Time
) extends InterBrokerSendThread("TxnMarkerSenderThread-" + config.brokerId, networkClient, config.requestTimeoutMs, time)
  with Logging {
  ...
  private val markersQueuePerBroker: concurrent.Map[Int, TxnMarkerQueue] = new ConcurrentHashMap[Int, TxnMarkerQueue]().asScala

  private val markersQueueForUnknownBroker = new TxnMarkerQueue(Node.noNode)

  private val txnLogAppendRetryQueue = new LinkedBlockingQueue[PendingCompleteTxn]()
```

[`TransactionMarkerChannelManager.scala#L117-L138`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/coordinator/transaction/TransactionMarkerChannelManager.scala#L117-L138)。

**ブローカーごとにマーカーのキューを持ち、専用スレッドが送る。** [プロデューサの Sender](../sender-inflight/) と同じ構造だ。

**`markersQueueForUnknownBroker` が目を引く。** パーティションのリーダーが分からない (メタデータが古い、リーダー選出中) ときに、いったんここに入れる。リーダーが判明したら適切なキューに移す。

**「宛先が決まっていないもの」を捨てずに、専用の待機場所に置く。** リーダー選出中に落とすと、トランザクションが永久に完了しなくなる。

`txnLogAppendRetryQueue` は、**マーカーを配り終えた後に `__transaction_state` へ `COMPLETE_COMMIT` を書く処理**が失敗したときのリトライ用だ。**2 相コミットの各段階に、失敗時の受け皿が用意されている。**

### 読み手側 — 4 本目の offset

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java"
/**
 * The last stable offset (LSO) is defined as the first offset such that all lower offsets have been "decided."
 * Non-transactional messages are considered decided immediately, but transactional messages are only decided when
 * the corresponding COMMIT or ABORT marker is written. This implies that the last stable offset will be equal
 * to the high watermark if there are no transactional messages in the log. Note also that the LSO cannot advance
 * beyond the high watermark.
 */
public long lastStableOffset() {
    // cache the first unstable offset metadata to avoid a concurrent update breaking the isPresent check
    Optional<LogOffsetMetadata> firstUnstableOffsetMetadataCopy = firstUnstableOffsetMetadata;
    if (firstUnstableOffsetMetadataCopy.isPresent() && firstUnstableOffsetMetadataCopy.get().messageOffset < highWatermark()) {
        return firstUnstableOffsetMetadataCopy.get().messageOffset;
    } else {
        return highWatermark();
    }
}
```

[`UnifiedLog.java#L670-L685`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java#L670-L685)。

**「決着済み (decided)」という言葉が定義されている。** コミットされたか、中断されたか、そもそもトランザクションでないか。

```text
log start offset ≤ LSO ≤ high watermark ≤ LEO
```

[前提のページ](../architecture/) で 4 本の offset を並べたが、**LSO はトランザクションのために追加された 4 本目**だった。

`read_committed` のコンシューマは LSO までしか読めない。**進行中のトランザクションがあると、その開始位置で止まる。** だから、**長時間コミットしないトランザクションは、そのパーティションの読み手を全員止める。**

[プロデューサ状態のページ](../producer-state/) で見た「遅れているトランザクションの検出」(タイムアウト + 5 分) が要るのは、このためだ。

`ローカル変数にコピーしてから使う` という書き方が 2 箇所に出てくる。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java"
// cache the current high watermark and the first unstable offset metadata to avoid a concurrent update
// invalidating the range check breaking the isPresent check
```

[`UnifiedLog.java#L651-L654`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java#L651-L654)。

**`volatile` な `Optional` を 2 回読むと、1 回目は `isPresent()` が true で 2 回目は空、ということが起こりうる。** 明示的にローカルへコピーしている。

### 中断されたレコードの扱い

コミットされたトランザクションのレコードは、そのまま読める。**中断されたレコードは、ログに残ったまま**だ。

コンシューマは、フェッチの応答に含まれる **「中断されたトランザクションの一覧」** ([`.txnindex`](../producer-state/) 由来) を見て、該当する offset 範囲のレコードを捨てる。

**フィルタリングはコンシューマ側で行われる。** ブローカーがフィルタすると、[ゼロコピー](../zero-copy/)が崩れるからだ。**「ブローカーは中身を見ない」という原則が、ここでも守られている。**

## なぜそうなっているか

### なぜ「消さずに、後から印を付ける」のか

追記専用のログでは、書いたものを消せない。**この制約が、設計を決めている。**

もし消せるなら、中断時にレコードを削除すればいい。消せないので、**「あれは無効です」という別のレコードを書き足す**しかない。

これは会計の訂正仕訳と同じ発想で、**「過去を書き換えずに、打ち消す記録を追加する」**。監査可能性という副産物もある。

代償は、**読み手が「無効なレコード」を判別する責任を負う**ことだ。だから `.txnindex` が要り、フェッチ応答に中断リストが載る。**書き手側の単純さを、読み手側の複雑さで買っている。**

### なぜ 2 相コミットなのか

複数パーティション (= 複数ブローカー) にまたがるので、**「全部にマーカーを書く」を原子的にはできない。** 途中でコーディネータが落ちうる。

そこで、**「コミットすると決めた」を先に 1 箇所 (`__transaction_state`) に記録する。** これが `PREPARE_COMMIT` だ。

- **`PREPARE_COMMIT` を書く前に落ちた** → トランザクションは中断される。
- **書いた後に落ちた** → 新しいコーディネータがログを読んで「コミットすると決めていた」と知り、**マーカーを配り直す。**

**「決定」と「実行」を分け、決定だけを原子的に記録する。** 実行は何度でもやり直せる (マーカーの書き込みは冪等)。

これは分散トランザクションの標準的な形で、**Kafka が特殊なのは「決定の記録先」が自分のログであること**だ。外部のトランザクションマネージャを持たない。

### なぜコーディネータがパーティションごとにいるのか

トランザクションコーディネータは、`transactional.id` のハッシュで `__transaction_state` のパーティションに割り当てられる。**そのパーティションのリーダーがコーディネータになる。**

これで、

- **コーディネータの障害復旧が、パーティションのリーダー選出そのものになる。** 専用の仕組みが要らない。
- **状態の永続化が、ログへの書き込みになる。**
- **スケールする。** `transactional.id` が増えたら、パーティションを増やす。

**[グループコーディネータ](../coordinator-runtime/) とまったく同じ構造**で、`__consumer_offsets` が `__transaction_state` に変わっただけだ。

### なぜ LSO が要るのか

`read_committed` のコンシューマは、「まだ決着していないレコード」を読んではいけない。読んでしまうと、後で中断された場合に取り消せない (すでにアプリが処理してしまった)。

**high watermark は「複製された位置」であって「決着した位置」ではない。** 進行中のトランザクションのレコードも複製されている。

だから、**「決着した位置」を表す別の offset が要る。** それが LSO だ。

**「複製済み」と「確定済み」を分ける**のは、2 相コミットを持つシステムでは必然になる。ログに書かれていることと、それが有効であることは別の事実だ。

### なぜブローカーがフィルタしないのか

中断されたレコードを、ブローカーが取り除いてから返すこともできた。そうしない理由は 2 つある。

- **[ゼロコピー](../zero-copy/)が使えなくなる。** レコードを解釈してフィルタするには、ユーザー空間に持ってくる必要がある。
- **バッチ単位の転送が崩れる。** [レコードバッチ](../record-batch/)の途中を抜くと、CRC も offset のデルタも作り直しになる。

**「ブローカーはバイト列を右から左に流すだけ」という設計原則を守るために、フィルタをクライアントに押し付けた。** 代わりに「どこを捨てるか」の情報だけを軽量に送る。

**性能上の原則を守るために、責務の配置を変えた**例になっている。

### `VALID_PREVIOUS_STATES` をデータで持つ意味

状態遷移の検証は、`switch` 文でも書ける。`Map` にした利点は、

- **遷移図がコードとして一望できる。** 10 行で全部見える。
- **「この状態に来られる元」という向きで書かれている。** 検証したいのはまさにこの向きだ。
- **[トランザクション v2 で遷移が緩和されたとき](../protocol-codegen/)、変更が 1 行で済んだ。**

**状態機械が複雑になったら、遷移を制御フローではなくデータにする。** 遷移の数が状態数の 2 乗に近づくと、`switch` では追えなくなる。

## どう活かすか

**「消せないストレージで取り消しを表現するには、打ち消す記録を追加する」** — 追記専用ログ、イベントソーシング、監査ログで必ず出てくる形だ。**書き手は単純になるが、読み手が『有効な記録だけを選ぶ』責任を負う。** その判定を安くする索引 (Kafka の `.txnindex`) を、最初から設計に入れておく必要がある。

**「決定を 1 箇所に原子的に記録し、実行は冪等に繰り返す」は、分散トランザクションの基本形として持っておきたい。** 決定さえ残っていれば、実行は何度でもやり直せる。**そのとき、実行が本当に冪等かを確認する** — Kafka はマーカーに `coordinatorEpoch` を入れて、古いコーディネータの実行を弾いている。

**「複製済み」と「確定済み」を別の座標として持つ**のも、2 相コミットを持つシステムでは避けられない。**1 つの位置で両方を表そうとすると、必ずどちらかで嘘をつくことになる。** Kafka は offset を 4 本持つことを選んだ。

**「宛先が決まっていないもの」に専用の待機場所を用意する**という細部も実務的だ。`markersQueueForUnknownBroker` がないと、リーダー選出中に発生したマーカーを捨てるか、エラーにするかになる。**どちらもトランザクションを永久に未完了にする。** 一時的に宛先不明になるシステムでは、「保留キュー」を先に用意しておく。

**状態遷移が複雑になったら、遷移をデータにする。** `Map<状態, Set<許容される前状態>>` の 10 行は、`switch` で書けば 50 行になり、しかも図として読めない。**「この状態に来られるのはどこからか」という向きで持つと、検証コードが 1 行になる。**

**そして、性能上の原則が責務の配置を決めることがある。** 「ブローカーは中身を見ない」を守るために、Kafka はフィルタリングをコンシューマに移した。**原則を先に立てると、機能をどこに置くかが自動的に決まる。** 逆に原則がないと、機能は「実装しやすいところ」に置かれ、後から性能問題になる。
