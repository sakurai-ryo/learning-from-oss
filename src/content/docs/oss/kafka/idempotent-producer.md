---
title: "PID とシーケンス番号で、再送を重複させない"
description: "冪等プロデューサの本体は「PID + パーティション + 連番」の 3 つ組だけだ。難しいのはクライアント側の後始末で、シーケンス番号に穴が空いたとき・ブローカーが状態を忘れたとき・バッチが恒久的に失敗したときに、それぞれ違う回復手順が要る。エポックを上げて全部リセットする、という最後の手段がその全部を支えている。"
group: "プロデューサ"
sidebar:
  order: 28
---

## 何を学んだか

### どんな状況の話か

[ISR のページ](../isr-highwatermark/) で見たとおり、`acks=all` でもエラーが返って再送が起きる。**しかも「エラーが返った = 書かれていない」とは限らない。**

再送すれば重複する。再送しなければ失われる。**両方を避けるには、ブローカー側で「この書き込みはすでに受け取った」と判定できる必要がある。**

ブローカー側の仕組みは [プロデューサ状態のページ](../producer-state/) で見た。**PID (プロデューサ ID)・エポック・シーケンス番号を[バッチヘッダ](../record-batch/)に載せ、ブローカーが直近 5 バッチ分を覚えて重複を弾く。**

ここで扱うのは **クライアント側**だ。シーケンス番号を振り、エラーに応じて回復する部分になる。

### Kafka の答え

**シーケンス番号を「パーティションごとの連番」として管理し、壊れたらエポックを上げて全部リセットする。**

1. **PID は `InitProducerId` でブローカーからもらう。** クラスタ全体で一意。
2. **シーケンス番号は、[アキュムレータから取り出すとき](../sender-inflight/)に割り当てる。** リトライでは変えない。
3. **エラーの種類ごとに、違う回復手順を持つ。**
4. **最後の手段は「エポックを上げて、シーケンスを 0 に戻す」。** 過去との縁を切る。
5. **「まだ判定できない」状態を明示的に持つ。** `partitionsWithUnresolvedSequences`。

## ソースコードのどこか

### 失敗したときの 3 分岐

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java"
if (exception instanceof OutOfOrderSequenceException && !isTransactional()) {
    log.error("The broker returned {} for topic-partition {} with producerId {}, epoch {}, and sequence number {}", ...);

    // If we fail with an OutOfOrderSequenceException, we have a gap in the log. Bump the epoch for this
    // partition, which will reset the sequence number to 0 and allow us to continue
    requestIdempotentEpochBumpForPartition(batch.topicPartition);
} else if (exception instanceof UnknownProducerIdException) {
    // If we get an UnknownProducerId for a partition, then the broker has no state for that producer. It will
    // therefore accept a write with sequence number 0. We reset the sequence number for the partition here so
    // that the producer can continue after aborting the transaction. All inflight-requests to this partition
    // will also fail with an UnknownProducerId error, so the sequence will remain at 0.
    resetSequenceForPartition(batch.topicPartition);
} else {
    if (adjustSequenceNumbers) {
        if (!isTransactional()) {
            requestIdempotentEpochBumpForPartition(batch.topicPartition);
        } else {
            txnPartitionMap.adjustSequencesDueToFailedBatch(batch);
        }
    }
}
```

[`TransactionManager.java#L827-L849`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java#L827-L849)。

**3 つのエラーに、3 つの回復手順がある。**

| エラー               | 意味                                                                  | 回復                         |
| -------------------- | --------------------------------------------------------------------- | ---------------------------- |
| `OutOfOrderSequence` | **ログに穴がある。** 前のバッチが失われた                             | エポックを上げて 0 から      |
| `UnknownProducerId`  | **ブローカーが状態を忘れた** ([保持期間で消えた](../producer-state/)) | シーケンスを 0 にリセット    |
| その他の致命的エラー | このバッチは絶対に書かれない                                          | **後続のシーケンスを詰める** |

3 つ目が興味深い。

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/TxnPartitionMap.java"
// If a batch is failed fatally, the sequence numbers for future batches bound for the partition must be adjusted
// so that they don't fail with the OutOfOrderSequenceException.
//
// This method must only be called when we know that the batch is question has been unequivocally failed by the broker,
// ie. it has received a confirmed fatal status code like 'Message Too Large' or something similar.
void adjustSequencesDueToFailedBatch(ProducerBatch batch) {
    ...
    log.debug("producerId: {}, send to partition {} failed fatally. Reducing future sequence numbers by {}",
            batch.producerId(), batch.topicPartition, batch.recordCount);

    get(batch.topicPartition).adjustSequencesDueToFailedBatch(batch.baseSequence(), batch.recordCount);
}
```

[`TxnPartitionMap.java#L101-L115`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/TxnPartitionMap.java#L101-L115)。

**シーケンス 10〜19 のバッチが「大きすぎる」で恒久的に失敗したら、20 以降のバッチを 10 以降に詰め直す。** そうしないと、ブローカーは「9 の次に 20 が来た」と見て `OutOfOrderSequence` を返す。

**呼び出し条件が厳しく書かれている。** `must only be called when we know that the batch is question has been unequivocally failed` — **「確実に書かれていない」と分かっているときだけ。** 曖昧な失敗 (タイムアウトなど) で詰めると、実は書かれていた場合にシーケンスが重複する。

### 「まだ分からない」を状態として持つ

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java"
synchronized void markSequenceUnresolved(ProducerBatch batch) {
    int nextSequence = batch.lastSequence() + 1;
    partitionsWithUnresolvedSequences.compute(batch.topicPartition,
        (k, v) -> v == null ? nextSequence : Math.max(v, nextSequence));
    log.debug("Marking partition {} unresolved with next sequence number {}", batch.topicPartition,
            partitionsWithUnresolvedSequences.get(batch.topicPartition));
}
```

[`TransactionManager.java#L867-L874`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java#L867-L874)。

**バッチが `delivery.timeout.ms` で期限切れになったとき、そのバッチが書かれたかどうか分からない。** 応答が来ていないだけかもしれない。

このとき「シーケンス番号が未解決」とマークする。**まだエポックを上げない。**

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java"
// Attempts to resolve unresolved sequences. If all in-flight requests are complete and some partitions are still
// unresolved, either bump the epoch if possible, or transition to a fatal error
synchronized void maybeResolveSequences() {
    for (Iterator<TopicPartition> iter = partitionsWithUnresolvedSequences.keySet().iterator(); iter.hasNext(); ) {
        TopicPartition topicPartition = iter.next();
        if (!hasInflightBatches(topicPartition)) {
            // The partition has been fully drained. At this point, the last ack'd sequence should be one less than
            // next sequence destined for the partition. If so, the partition is fully resolved. If not, we should
            // reset the sequence number if necessary.
            if (isNextSequence(topicPartition, sequenceNumber(topicPartition))) {
                // This would happen when a batch was expired, but subsequent batches succeeded.
                iter.remove();
            } else {
```

[`TransactionManager.java#L876-L890`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java#L876-L890)。

**in-flight のバッチが全部片付いてから判定する。**

- **後続のバッチが成功していた** → 期限切れのバッチも実は書かれていた。**何もしなくてよい。**
- **後続も全部失敗していた** → 本当に穴が空いた。**エポックを上げる。**

`Sender` のループの先頭で毎回 `maybeResolveSequences()` が呼ばれるのは、この判定を進めるためだ ([送信ループのページ](../sender-inflight/))。

**「判断を保留し、情報が揃ってから決める」** という形になっている。すぐエポックを上げると、上げなくてよかったケースでも上げてしまい、**その間に飛んでいた全バッチが無効になる。**

### `UnknownProducerId` の 4 つのケース

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java"
if (error == Errors.UNKNOWN_PRODUCER_ID) {
    if (response.logStartOffset == -1) {
        // We don't know the log start offset with this response. We should just retry the request until we get it.
        // ... it is possible for a broker to not know the logStartOffset at when it is returning the response
        // because the partition may have moved away from the broker from the time the error was initially raised
        // to the time the response was being constructed.
        return true;
    }

    if (batch.sequenceHasBeenReset()) {
        // When the first inflight batch fails due to the truncation case, then the sequences of all the other
        // in flight batches would have been restarted from the beginning. However, when those responses
        // come back from the broker, they would also come with an UNKNOWN_PRODUCER_ID error. In this case, we should not
        // reset the sequence numbers to the beginning.
        return true;
    } else if (lastAckedOffset(batch.topicPartition).orElse(...) < response.logStartOffset) {
        // The head of the log has been removed, probably due to the retention time elapsing. In this case,
        // we expect to lose the producer state.
```

[`TransactionManager.java#L1052-L1082`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java#L1052-L1082)。

**同じエラーコードでも、状況によって 4 通りに分かれる。**

1. **`logStartOffset` が不明** → パーティションが移動した直後。リトライすれば分かる。
2. **すでにシーケンスをリセット済み** → 最初のバッチのリセットに巻き込まれた後続。**二重にリセットしない。**
3. **log start offset が自分の最終 ACK より進んでいる** → **保持期間でログの先頭が消え、プロデューサ状態も消えた。** 想定内。
4. **それ以外** → エポックを上げる。

**「エラーコードだけでは判断できない」** ので、応答に含まれる `logStartOffset` と、クライアント側の状態を突き合わせている。

**2 番目の分岐が特に細かい。** 5 個のバッチが飛んでいて、1 個目が失敗してシーケンスをリセットすると、残り 4 個も同じエラーで返ってくる。**そのたびにリセットすると、リセットが 5 回起きる。** `sequenceHasBeenReset()` フラグで 1 回に抑えている。

### エポックを上げるという最終手段

```java title="clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java"
synchronized void bumpIdempotentEpochAndResetIdIfNeeded() {
```

[`TransactionManager.java#L691`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/internals/TransactionManager.java#L691)。

エポックを上げると、**そのプロデューサの過去の書き込みとの関係が切れる。**

- ブローカー側の[重複検出](../producer-state/)は `producerEpoch` が一致しないと働かない。
- **全パーティションのシーケンス番号が 0 に戻る。**
- **飛んでいたバッチは全部無効になり、新しいエポックで送り直される。**

**「状態が壊れたら、全部捨てて最初からやり直す」** という乱暴だが確実な回復手段だ。代償は、**その瞬間に重複が入りうること** — 古いエポックで書かれたバッチと、新しいエポックで送り直したバッチが両方ログに載る可能性がある。

だから **本当に必要なときだけ上げる。** 上の `maybeResolveSequences()` が判断を保留するのは、この代償を避けるためだ。

## なぜそうなっているか

### なぜシーケンスは「パーティションごと」なのか

プロデューサ全体で 1 本の連番にすると、**パーティションをまたいだ順序を保証することになる。** ブローカーは自分の持つパーティションしか見えないので、「1, 3, 5」が来たときに「2, 4 は他のパーティションに行った」のか「失われた」のか区別できない。

パーティションごとなら、**そのブローカーだけで完結して判定できる。** [ブローカーが状態をログに持てる](../producer-state/) のも、パーティション単位だからだ。

**「検証できる主体のところで、番号を閉じる」** という原則になっている。

### なぜリトライでシーケンスを変えないのか

[送信のページ](../sender-inflight/) でも触れたが、これは重複防止の根幹だ。

```text
シーケンス 10 のバッチを送る → タイムアウト (実は書かれていた)
リトライでシーケンス 11 に振り直す → ブローカーは「11 は新しい」と受け入れる
→ 同じレコードが 10 と 11 の 2 回書かれる
```

**リトライは「同じ書き込みをもう一度試す」であって「新しい書き込み」ではない。** 番号が同じでなければ、それが表現できない。

だから、**シーケンス番号は最初に確定し、リトライでは絶対に変えない。** 変えてよいのは「確実に書かれていない」と分かったときだけ (`adjustSequencesDueToFailedBatch`) で、その条件がコメントで強調されている。

### なぜ「未解決」という状態が要るのか

素朴には、バッチが失敗したら即座に回復手順に入りたくなる。だが **「失敗した」には 2 種類ある。**

|                  | 例                             | 対処                           |
| ---------------- | ------------------------------ | ------------------------------ |
| **確定的な失敗** | `MessageTooLarge`、認可エラー  | 書かれていないと断定できる     |
| **不確定な失敗** | タイムアウト、コネクション切断 | **書かれたかどうか分からない** |

不確定な失敗のときに「書かれていない」と仮定して回復すると、**実は書かれていた場合にシーケンスがずれる。** 逆に「書かれた」と仮定すると、書かれていなかった場合に穴が残る。

**判断を保留して、後続のバッチの結果から逆算する。** 後続が成功したなら、その前のバッチも書かれていたはずだ (シーケンスの連続性から)。

**「今は分からないが、後で分かる」ものを、そのまま『分からない』として持つ。** 早すぎる断定を避ける設計になっている。

### なぜ「エポックを上げる」で全部解決するのか

エポックは **「このプロデューサの、この世代」** を表す。上げると、ブローカー側の状態と縁が切れる。

これは [leader epoch](../leader-epoch/) や [broker epoch](../broker-lifecycle/) と同じ構造で、**「世代を上げて、過去を無効にする」** という手法だ。

- **状態が食い違ったら、状態を直すのではなく、新しい世代で作り直す。**
- 古い世代からのリクエストは、ブローカー側で自動的に拒否される。

**「壊れた状態を修復するコード」を書かずに済む**のが最大の利点だ。修復のコードは、パターンの数だけ複雑になり、しかもテストが難しい。**世代を上げるのは 1 通りしかない。**

代償として、**エポックを上げた瞬間だけ重複が入りうる。** at-least-once に落ちる。これを避けたいなら、[トランザクション](../transactions-eos/) が必要になる。

### エラーの分岐がなぜこんなに細かいのか

`canRetry` の `UNKNOWN_PRODUCER_ID` だけで 4 分岐、コメントが 30 行ある。

**細かさの原因は、「同じエラーコードが複数の原因から返る」ことにある。**

- ログの先頭が保持期間で消えた (想定内)
- パーティションが移動した (一時的)
- 自分のリセットに巻き込まれた (自業自得)
- 本当に状態が消えた (エポックを上げるべき)

**エラーコードを増やせば分岐は減るが、[プロトコルのバージョン管理](../protocol-codegen/)のコストがかかる。** 新しいエラーコードは、古いクライアントには理解できない。

**代わりに、応答に含まれる情報 (`logStartOffset`) とクライアント側の状態を突き合わせて判別している。** プロトコルを変えずに、判別の精度を上げる方法になっている。

## どう活かすか

**「送信側が連番を振り、受信側が直近 N 件を覚えて重複を弾く」は、at-least-once を exactly-once に近づける最小の構成だ。** 必要なのは、送信者の一意な ID、受信側で閉じた連番、そして受信側の有限のメモリ。**「番号を、検証する主体のところで閉じる」のが設計の鍵になる。** グローバルな連番にすると、検証する側が全体を見られず判定できない。

**「リトライでは、送るものを一切変えない」は規律として徹底する。** 番号、タイムスタンプ、リクエスト ID — **リトライのたびに再計算する実装は、必ず重複を作る。** 送信内容は最初に確定させ、リトライは同じバイト列の再送に限る。

**「不確定な失敗を、確定的な失敗と区別する」も重要だ。** タイムアウトは「失敗した」ではなく「結果が分からない」であり、この 2 つを同じ扱いにすると、必ずどちらかのケースで壊れる。**「分からない」という状態を型やフィールドとして持ち、判断を後回しにする。** Kafka は `partitionsWithUnresolvedSequences` という 1 つのマップでこれを表現している。

**「壊れた状態を修復せず、世代を上げてやり直す」は、修復コードの複雑さを避ける強力な手だ。** 修復はパターンの数だけ実装が要り、それぞれにテストが要る。世代を上げるのは 1 通り。**成立条件は「古い世代のリクエストを、受信側が確実に拒否できる」こと。** これがないと、古い世代が生き残ってゾンビになる。

**そして、エラーコードを増やす代わりに「応答の付随情報 + 呼び出し側の状態」で判別するのは、プロトコルを変えにくい環境で使える手だ。** 分岐は複雑になるが、互換性のコストは払わない。**その分、なぜその分岐があるかを必ず書き残す** — Kafka の 30 行のコメントは、この選択の必要経費になっている。
