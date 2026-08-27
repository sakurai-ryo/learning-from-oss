---
title: "冪等プロデューサの状態を、ログ側に持たせる"
description: "「同じレコードを 2 回書かない」を実現するには、ブローカーが「このプロデューサはどこまで書いたか」を覚えている必要がある。Kafka はそれをメモリではなくログの中に置いた。リーダーが交代しても、新しいリーダーがログを読めば状態が再構築される。スナップショットファイルは、その再構築を速くするためだけに存在する。"
group: "ストレージ"
sidebar:
  order: 9
---

## 何を学んだか

### どんな状況の話か

プロデューサが `send` したあと、応答が返ってこなかったとする。ネットワークが切れたのか、ブローカーが書いた直後に落ちたのか、区別できない。

- **再送しなければ**、書けていなかった場合にデータが失われる。
- **再送すれば**、書けていた場合に重複する。

これを解くには、**ブローカー側で「このプロデューサの、この書き込みはすでに受け取った」と判定できる**必要がある。そのための状態を、どこに持つか。

素朴にはブローカーのメモリだ。しかし Kafka では**パーティションのリーダーが交代する**。別のブローカーがリーダーになった瞬間、メモリ上の状態は消える。新リーダーは「このプロデューサがどこまで書いたか」を知らない。

### Kafka の答え

**状態をログの中に置く。** プロデューサ ID・エポック・シーケンス番号は[レコードバッチのヘッダ](../record-batch/) に書かれているので、**ログを読めば状態は再構築できる**。

1. **`ProducerStateManager` はログから作られる派生物。** 権威はログにある。
2. **リーダーが交代したら、新リーダーがログを読んで作り直す。** 特別な引き継ぎ処理がない。
3. **スナップショットファイル (`.snapshot`) は再構築を速くするためだけにある。** 失っても正しさは変わらない。
4. **プロデューサごとに直近 5 バッチのメタデータを保持する。** 重複を検出したら、元の offset を返す。
5. **トランザクションの中断情報は別のインデックス (`.txnindex`) に記録する。**

## ソースコードのどこか

### 何を持っているか

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateManager.java"
/**
 * Maintains a mapping from ProducerIds to metadata about the last appended entries (e.g.
 * epoch, sequence number, last offset, etc.)
 * <p>
 * The sequence number is the last number successfully appended to the partition for the given identifier.
 * The epoch is used for fencing against zombie writers. The offset is the one of the last successful message
 * appended to the partition.
 * <p>
 * As long as a producer id is contained in the map, the corresponding producer can continue to write data.
 * However, producer ids can be expired due to lack of recent use or if the last written entry has been deleted from
 * the log (e.g. if the retention policy is "delete"). For compacted topics, the log cleaner will ensure
 * that the most recent entry from a given producer id is retained in the log provided it hasn't expired due to
 * age.
 */
public class ProducerStateManager {
```

[`ProducerStateManager.java#L54-L70`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateManager.java#L54-L70)。

**「プロデューサ ID がマップにある限り、そのプロデューサは書き続けられる」**。逆に言えば、マップから消えたら書けなくなる (正確には、シーケンス番号 0 から出直すことになる)。

消える条件が 2 つ挙げられている。**時間による期限切れ**と、**そのプロデューサが最後に書いたレコードがログから消えたとき**だ。後者があるので、`delete` ポリシーのトピックでは保持期間を過ぎると自動的に状態も消える。**状態のライフサイクルがログのライフサイクルに従属している。**

### 状態を持つ単位

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateEntry.java"
/**
 * This class represents the state of a specific producer-id.
 * It contains batchMetadata queue which is ordered such that the batch with the lowest sequence is at the head of the
 * queue while the batch with the highest sequence is at the tail of the queue. We will retain at most {@link ProducerStateEntry#NUM_BATCHES_TO_RETAIN}
 * elements in the queue. When the queue is at capacity, we remove the first element to make space for the incoming batch.
 */
public class ProducerStateEntry {
    public static final int NUM_BATCHES_TO_RETAIN = 5;
```

[`ProducerStateEntry.java#L28-L35`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateEntry.java#L28-L35)。

**5 という数字には根拠がある。** プロデューサ側の設定にも同じ 5 がある。

```java title="clients/src/main/java/org/apache/kafka/clients/producer/ProducerConfig.java"
private static final int MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION_FOR_IDEMPOTENCE = 5;
```

[`ProducerConfig.java#L296`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/producer/ProducerConfig.java#L296)。

冪等性を有効にしたプロデューサは、1 接続あたり同時に 5 リクエストまでしか飛ばせない。**つまり「応答を待っている最中のバッチ」は最大 5 個。** ブローカーが 5 個分のメタデータを覚えていれば、再送されうる全てのバッチについて重複を判定できる。

**クライアントの設定上限が、サーバのメモリ使用量を決めている。** どちらか一方を見ても 5 の理由は分からない。

### 重複の判定

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateEntry.java"
Optional<BatchMetadata> findDuplicateBatch(RecordBatch batch) {
    return batch.producerEpoch() != producerEpoch ? Optional.empty() : batchWithSequenceRange(batch.baseSequence(), batch.lastSequence());
}

// Return the batch metadata of the cached batch having the exact sequence range, if any.
private Optional<BatchMetadata> batchWithSequenceRange(int firstSeq, int lastSeq) {
    return batchMetadata.stream()
        .filter(metadata -> firstSeq == metadata.firstSeq() && lastSeq == metadata.lastSeq())
        .findFirst();
}
```

[`ProducerStateEntry.java#L128-L137`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateEntry.java#L128-L137)。

**シーケンス番号の範囲が完全一致したら重複。** そのときブローカーは、書き込まずに **元のバッチの offset をそのまま応答する**。プロデューサから見ると、再送が成功したのと区別がつかない。

`producerEpoch` が違えば重複ではない、と最初に弾いている。エポックが上がったということは、プロデューサが再起動したか、[トランザクションが強制終了された](../transactions-eos/)ということで、以前のシーケンス番号は無効になる。

### 順序の検証

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerAppendInfo.java"
int currentLastSeq;
if (!updatedEntry.isEmpty())
    currentLastSeq = updatedEntry.lastSeq();
else if (producerEpoch == currentEntry.producerEpoch())
    currentLastSeq = currentEntry.lastSeq();
else
    currentLastSeq = RecordBatch.NO_SEQUENCE;

// If there is no current producer epoch (possibly because all producer records have been deleted due to
// retention or the DeleteRecords API) accept writes with any sequence number
if (!(currentEntry.producerEpoch() == RecordBatch.NO_PRODUCER_EPOCH || inSequence(currentLastSeq, appendFirstSeq))) {
    throw new OutOfOrderSequenceException(...);
}
```

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerAppendInfo.java"
private boolean inSequence(int lastSeq, int nextSeq) {
    return nextSeq == lastSeq + 1L || (nextSeq == 0 && lastSeq == Integer.MAX_VALUE);
}
```

[`ProducerAppendInfo.java#L178-L198`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerAppendInfo.java#L178-L198)。

**シーケンス番号は 1 ずつしか進めない。** 飛んだら `OutOfOrderSequenceException` で拒否する。これで「4 番のバッチが失われたまま 5 番が書かれる」を防いでいる。順序保証は、この 1 行の検査から出ている。

`Integer.MAX_VALUE` からの 0 への折り返しが明示的に書かれている。**シーケンス番号は 32 ビットなので、21 億バッチ書いたら一周する。**

「状態が消えていたらどんなシーケンス番号でも受け入れる」という抜け道もある。保持期間でレコードが消えたケースを救うためだが、**この瞬間だけ重複検出が効かない**ことを意味する。安全側ではなく可用性側に倒した判断だ。

### スナップショットは省略可能な最適化

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateManager.java"
public Optional<File> takeSnapshot(boolean sync) throws IOException {
    ...
        writeSnapshot(snapshotFile.file(), producers, sync);
```

[`ProducerStateManager.java#L428-L445`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateManager.java#L428-L445)。

スナップショットは **セグメントをロールするたび**に取られ、`<baseOffset>.snapshot` として保存される。

[復旧のページ](../log-recovery/) で見たとおり、セグメントを 1 個復旧するたびにもスナップショットを取る。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
int bytesTruncated = segment.recover(producerStateManager, leaderEpochCache);
// once we have recovered the segment's data, take a snapshot to ensure that we won't
// need to reload the same segment again while recovering another segment.
producerStateManager.takeSnapshot();
```

[`LogLoader.java#L414-L418`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java#L414-L418)。

**この 1 行がないと復旧が O(n²) になる。** セグメント k を復旧するには「セグメント 0 から k-1 までのプロデューサ状態」が要る。毎回 0 から読み直すと、n 個のセグメントで n²/2 回のセグメント読み込みになる。1 個進むたびにスナップショットを残せば、次は 1 個読むだけで済む。

### 中断されたトランザクションの索引

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/TransactionIndex.java"
/**
 * The transaction index maintains metadata about the aborted transactions for each segment. This includes
 * the start and end offsets for the aborted transactions and the last stable offset (LSO) at the time of
 * the abort. This index is used to find the aborted transactions in the range of a given fetch request at
 * the READ_COMMITTED isolation level.
 *
 * There is at most one transaction index for each log segment. The entries correspond to the transactions
 * whose commit markers were written in the corresponding log segment. Note, however, that individual transactions
 * may span multiple segments. Recovering the index therefore requires scanning the earlier segments in
 * order to find the start of the transactions.
 */
public class TransactionIndex implements Closeable {
```

[`TransactionIndex.java#L38-L49`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/TransactionIndex.java#L38-L49)。

`read_committed` のコンシューマは、中断されたトランザクションのレコードを読み飛ばさなければならない。だが**中断のマーカーはトランザクションの終わりに書かれる**ので、レコードを読んだ時点では中断されたかどうか分からない。

そこで、**フェッチの応答に「この範囲に含まれる中断トランザクションの一覧」を添える**。コンシューマ側でそれを見て、該当する offset 範囲のレコードを捨てる。この一覧を安く引くための索引が `.txnindex` だ。

javadoc の最後の一文が示すとおり、**トランザクションは複数のセグメントにまたがりうる**ので、索引を復旧するには前のセグメントまで遡る必要がある。局所性が崩れる数少ない場所になっている。

### 遅れているトランザクションの検出

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateManager.java"
public static final long LATE_TRANSACTION_BUFFER_MS = 5 * 60 * 1000;
...
return lastTimestamp > 0 && (currentTimeMs - lastTimestamp) > maxTransactionTimeoutMs + ProducerStateManager.LATE_TRANSACTION_BUFFER_MS;
```

[`ProducerStateManager.java#L72-L132`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerStateManager.java#L72-L132)。

トランザクションが開始されたまま終わらないと、**LSO が進まない**。`read_committed` のコンシューマは、そこから先を一切読めなくなる。

タイムアウト + 5 分のバッファを過ぎたら「遅れているトランザクション」と判定する。バッファがあるのは、**コーディネータ側のタイムアウト処理より確実に後にする**ためだ。両方が同時に動くと競合するので、片方を明確に遅らせている。

## なぜそうなっているか

### なぜ状態をログに置いたのか

選択肢は 3 つあった。

| 置き場所                    | 問題                                                 |
| --------------------------- | ---------------------------------------------------- |
| ブローカーのメモリだけ      | リーダー交代で消える                                 |
| 専用のストア (ZooKeeper 等) | 書き込みごとに外部への同期が要る。遅い               |
| **ログの中**                | 追加の書き込みが不要。レプリケーションでコピーされる |

**ログに置くと、レプリケーションが状態のレプリケーションを兼ねる。** フォロワーはバッチをそのままコピーするので、バッチヘッダに入っているプロデューサ情報も一緒に届く。フォロワーがリーダーに昇格したら、自分のログを読んで状態を作れる。

**「状態の複製」のために新しい仕組みを一切足していない。** これが [章全体の主題](../) — ログの上に載せられるものは載せる — の、最も直接的な実例になっている。

### 派生物と権威の分離

`ProducerStateManager` は、Kafka のコードの中で **「権威 (ログ) と派生物 (メモリ上の索引)」の関係が最もはっきりしている**場所だ。

|                  | 権威                   | 派生物                          |
| ---------------- | ---------------------- | ------------------------------- |
| 実体             | レコードバッチのヘッダ | `ProducerStateManager` のマップ |
| 失われたら       | 冪等性が壊れる         | 読み直せば復元できる            |
| スナップショット | —                      | 再構築を速くするだけ            |

同じ構造は[インデックス](../sparse-index/)にもある。`.index` が壊れたら作り直す。`.snapshot` が壊れたら作り直す。**Kafka で守られているのは `.log` だけだ。**

この分離ができていると、**復旧の設計が「権威をどこまで信じるか」だけの問題になる**。派生物の整合性を気にしなくてよい。

### なぜ 5 バッチだけなのか

「全部覚えておけば確実」ではある。だが、**プロデューサ 1 万個 × バッチ全部の履歴**を持つと、メモリが青天井になる。

ここで効いているのが **「クライアントが同時に飛ばせるリクエスト数に上限がある」** という事実だ。上限が 5 なら、再送されうるバッチも最大 5 個。それより古いバッチが再送されてくることはない。

**プロトコルの制約が、サーバのメモリ上限を有限にしている。** クライアントの設定を緩めると (`max.in.flight` を 5 より大きくすると) 冪等性が保証できなくなるので、プロデューサ側で設定検証が入る。**両端で 1 つの不変条件を守っている**形になる。

### なぜ「状態が無ければ何でも受け入れる」のか

これは安全性を落とす判断だ。保持期間でプロデューサの状態が消えた後に古いバッチが再送されると、重複が入る。

それでもこうしているのは、**代替が「書き込みを永久に拒否する」だから**だ。長時間アイドルだったプロデューサが再開したときに、`OutOfOrderSequence` (回復不能なエラー) で止まってしまう。

**「起こりにくい重複」と「起こりやすい停止」を天秤にかけて、前者を選んでいる。** コメントに条件が明記されているのが誠実なところで、隠していない。

### トランザクション索引が別ファイルな理由

中断されたトランザクションの情報を、レコードの中に埋め込むこともできた。だがそうすると、**中断が確定したときに過去のレコードを書き換える**ことになる。

追記専用のログでは書き換えられない。だから **「後から分かる情報」は別のファイルに追記する**。`.txnindex` は、その 1 例だ。同じ構図は[階層型ストレージ](../tiered-storage/)のメタデータにも出てくる。

**追記専用という制約の下では、「後から分かる情報」の置き場所を最初に決めておく必要がある。**

## どう活かすか

**「状態をデータストリームの中に埋め込み、再生で復元する」は、ステートフルな処理をフェイルオーバーさせたいときの定石として使える。** 状態を別ストアに置くと、そのストアの整合性・可用性・レイテンシが全部自分の問題になる。ストリームに埋められるなら、ストリームの複製がそのまま状態の複製になる。**条件は「状態がストリームの関数として表せる」ことで、外部からの入力が混ざると崩れる。**

**「派生物には保護をかけず、再構築を速くするスナップショットだけ置く」も移植しやすい。** 権威データと派生データを区別し、派生側は「消えても正しさは変わらない」を保てば、復旧のコードが単純になる。**そのとき、スナップショットを取るタイミングを「復旧の計算量」から逆算する**視点が要る。Kafka がセグメント 1 個ごとにスナップショットを取るのは、それがないと O(n²) になるからで、性能のためではなく現実的な復旧時間のためだ。

**「クライアント側の制約を、サーバ側のリソース上限の根拠にする」という設計は、意識して使う価値がある。** サーバが無制限に状態を持たないためには、どこかに有限性の根拠が要る。プロトコルで「同時に N 個まで」と決めてしまえば、サーバは N 個分だけ覚えればよい。**ただし、この不変条件は両端で守らないと崩れる。** Kafka がプロデューサの設定検証で `max.in.flight ≤ 5` を強制しているのは、片側だけでは守れないからだ。**「サーバがクライアントの行儀の良さに依存している」箇所は、必ずクライアント側にも検査を置く。**

**一方、「状態が消えたら検査を諦める」の真似は慎重にしたい。** Kafka がこれを許容できるのは、重複が入っても壊れるのは「1 回だけ配送」という追加の保証であって、ログの整合性そのものではないからだ。**諦めたときに何が壊れるかを、先に洗い出しておく必要がある。**
