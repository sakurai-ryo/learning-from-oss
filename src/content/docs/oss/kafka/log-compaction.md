---
title: "キー単位の最新値だけを残す圧縮を、固定メモリのハッシュマップで回す"
description: "compaction はキーごとに最新のレコードだけを残す。そのために「キー → 最新オフセット」のマップが要るが、Kafka はキーを保存しない。MD5 ハッシュ 16 バイトとオフセット 8 バイトだけを固定サイズのバッファに詰める。削除もリサイズもできない、極端に切り詰めたハッシュテーブルだ。"
sidebar:
  order: 8
---

## 何を学んだか

### どんな状況の話か

Kafka の既定の保持ポリシーは「古いものから消す」だ ([セグメントのページ](../log-segment/))。だが、ログを「現在の状態のスナップショット」として使いたい場面がある。

- ユーザー ID → プロフィール
- 商品 ID → 在庫数
- そして Kafka 自身の `__consumer_offsets`: グループ + パーティション → コミット済み offset

こういう用途では、**古いレコードでも「そのキーの最新値」なら消してはいけない**。逆に、同じキーの新しいレコードが後にあるなら、古いほうは要らない。

これが `cleanup.policy=compact` — **log compaction** だ。

### Kafka の答え

**「キー → そのキーの最新オフセット」のマップを作り、それに載っていないレコードを落としながらセグメントを書き直す。**

問題は、このマップをどう持つかだ。数千万キーあるパーティションで `HashMap<byte[], Long>` を作れば、キーの中身とオブジェクトヘッダで GB 単位になる。

Kafka の答えは徹底している。

1. **キーを保存しない。** キーの MD5 ハッシュ 16 バイトだけを持つ。
2. **メモリは固定。** 起動時に確保した `ByteBuffer` を使い回し、リサイズしない。
3. **削除できない。** 1 回の圧縮が終わったらバッファごとクリアする。
4. **入り切らなかったら、そこまでで打ち切る。** 全部を一度に圧縮しようとしない。
5. **書き直しは `.cleaned` → `.swap` → リネームの 3 段。** どこで落ちても[復旧](../log-recovery/)できる。

## ソースコードのどこか

### 何をするクラスなのか

`LogCleaner` の javadoc が、圧縮の全体像を説明している。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java"
 * The cleaner is responsible for removing obsolete records from logs which have the "compact" retention strategy.
 * A message with key K and offset O is obsolete if there exists a message with key K and offset O' such that O < O'.
 * <p>
 * Each log can be thought of being split into two sections of segments: a "clean" section which has previously been cleaned followed by a
 * "dirty" section that has not yet been cleaned. The dirty section is further divided into the "cleanable" section followed by an "uncleanable" section.
 * The uncleanable section is excluded from cleaning. The active log segment is always uncleanable.
```

[`LogCleaner.java#L47-L96`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java#L47-L96)。

```text
┌────────── clean ──────────┬────── cleanable ──────┬─ uncleanable ─┐
│ 前回の圧縮で処理済み       │ 今回の対象            │ アクティブ    │
│ キーごとに 1 件になっている │ 重複が残っている       │ セグメント等  │
└───────────────────────────┴───────────────────────┴───────────────┘
                            ↑ cleaner checkpoint
```

**チェックポイントより前は「圧縮済み」なので、マップを作る対象から外せる。** これが後で効く。

汚れ具合の測り方も書いてある。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java"
 * The cleaning is carried out by a pool of background threads. Each thread chooses the dirtiest log that has the "compact" retention policy
 * and cleans that. The dirtiness of the log is guessed by taking the ratio of bytes in the dirty section of the log to the total bytes in the log.
```

**「dirty 部分のバイト数 ÷ 全体のバイト数」が最大のログを選ぶ。** キー数でも重複率でもなく、バイト数の比。安く測れる指標を選んでいる。

### キーを持たないハッシュテーブル

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java"
/**
 * A hash table used for de-duplicating the log. This hash table uses a cryptographically secure hash of the key as a proxy for the key
 * for comparisons and to save space on object overhead. Collisions are resolved by probing. This hash table does not support deletes.
 */
public class SkimpyOffsetMap implements OffsetMap {
```

[`SkimpyOffsetMap.java#L27-L32`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java#L27-L32)。

クラス名の "skimpy" は「けちけちした」の意味だ。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java"
public SkimpyOffsetMap(int memory, String hashAlgorithm) throws NoSuchAlgorithmException {
    this.bytes = ByteBuffer.allocate(memory);

    this.digest = MessageDigest.getInstance(hashAlgorithm);

    this.hashSize = digest.getDigestLength();
    this.bytesPerEntry = hashSize + 8;
    this.slots = memory / bytesPerEntry;
```

[`SkimpyOffsetMap.java#L77-L88`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java#L77-L88)。

**1 エントリ 24 バイト** (MD5 の 16 バイト + offset の 8 バイト)。既定の重複排除バッファは 128 MB なので、**約 560 万スロット**。負荷率 0.9 を掛けて、1 回の圧縮で扱えるのは約 500 万キーになる。

`ByteBuffer` に直接詰めているので、**オブジェクトが 1 個も作られない**。`HashMap<ByteBuffer, Long>` なら 1 エントリあたり Entry オブジェクト + Long のボックス + キーのバイト配列で 100 バイト近く行く。

探索は線形探査だが、探査位置の決め方が独特だ。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java"
/**
 * Calculate the ith probe position. We first try reading successive integers from the hash itself
 * ...
 */
private int positionOf(byte[] hash, int attempt) {
    int probe = ByteUtils.readIntBE(hash, Math.min(attempt, hashSize - 4)) + Math.max(0, attempt - hashSize + 4);
    int slot = Utils.abs(probe) % slots;
    return slot * bytesPerEntry;
}
```

[`SkimpyOffsetMap.java#L199-L209`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java#L199-L209)。

**MD5 の 16 バイトから、ずらしながら 4 バイトずつ int を読み出して探査位置にする。** 1 回目は 0〜3 バイト目、2 回目は 1〜4 バイト目 … と 13 回分。それも尽きたら線形探査に切り替わる。

再ハッシュのコストを払わずに、13 個の独立に近いハッシュ値を得ている。**すでに計算した 16 バイトを使い回しているだけ**で、追加のコストはゼロだ。

`get` のループは、探査回数に上限を置いている。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java"
//we need to guard against attempt integer overflow if the map is full
//limit attempt to number of slots once positionOf(..) enters linear search mode
int maxAttempts = slots + hashSize - 4;
```

[`SkimpyOffsetMap.java#L104-L107`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java#L104-L107)。

**満杯のマップで無限ループしないための上限**で、「線形探査に入ったらスロット数を超えない」という素直な理屈になっている。

`put` は満杯を例外にする。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java"
if (entries >= slots)
    throw new IllegalArgumentException("Attempted to add a new entry to a full offset map, "
        + "entries: " + entries + ", slots: " + slots);
```

[`SkimpyOffsetMap.java#L125-L128`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/SkimpyOffsetMap.java#L125-L128)。

**リサイズしない。** 呼び出し側 (`buildOffsetMap`) が、満杯になる前にセグメントの読み込みを止める。

### 残すか捨てるかの判定

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/Cleaner.java"
boolean pastLatestOffset = record.offset() > map.latestOffset();
if (pastLatestOffset) {
    return true;
}

if (record.hasKey()) {
    ByteBuffer key = record.key();
    long foundOffset = map.get(key);
    /* First,the message must have the latest offset for the key
     * then there are two cases in which we can retain a message:
     *   1) The message has value
     *   2) The message doesn't have value but it can't be deleted now.
     */
    boolean latestOffsetForKey = record.offset() >= foundOffset;
    boolean legacyRecord = batch.magic() < RecordBatch.MAGIC_VALUE_V2;

    boolean shouldRetainDeletes;
    if (!legacyRecord) {
        shouldRetainDeletes = batch.deleteHorizonMs().isEmpty() || currentTime < batch.deleteHorizonMs().getAsLong();
    } else {
        shouldRetainDeletes = retainDeletesForLegacyRecords;
    }

    boolean isRetainedValue = record.hasValue() || shouldRetainDeletes;
    return latestOffsetForKey && isRetainedValue;
```

[`Cleaner.java#L567-L597`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/Cleaner.java#L567-L597)。

判定は 3 つの条件の積になっている。

1. **マップの範囲より後のレコードは無条件で残す。** マップは dirty 区間の途中までしか作られていないかもしれないので、その先は判断できない。**判断できないものは残す**、が安全側だ。
2. **そのキーの最新 offset でなければ捨てる。**
3. **値が null (tombstone) なら、削除期限 (delete horizon) を過ぎていたら捨てる。**

### tombstone をすぐ消せない理由

`null` の値を持つレコードは「このキーを削除した」を意味する。ではなぜすぐ消さないのか。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java"
 * Messages with null payload are treated as deletes for the purpose of log compaction. This means that they receive special treatment by the cleaner.
 * The cleaner will only retain delete records for a period of time to avoid accumulating space indefinitely. This period of time is configurable on a per-topic
 * basis and is measured from the time the segment enters the clean portion of the log (at which point any prior message with that key has been removed).
```

[`LogCleaner.java#L70-L77`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java#L70-L77)。

**tombstone を消すと、「削除された」という事実まで消える。** ログの先頭から読み直しているコンシューマは、まだそのキーの古い値を読んでいないかもしれない。tombstone がないと、古い値を読んだまま「まだ生きている」と誤解する。

だから `delete.retention.ms` の間は残す。この時間の起点は **「そのセグメントが clean 区間に入った時刻」** で、レコードが書かれた時刻ではない。[レコードバッチ形式](../record-batch/) の delete horizon フラグと `BaseTimestamp` の再利用が、この時刻を記録するために使われている。

### トランザクションとの絡み

javadoc の最後に、圧縮とトランザクションの相互作用が 4 点にまとめられている。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java"
 * <li>In order to maintain sequence number continuity for active producers, we always retain the last batch
 *    from each producerId, even if all the records from the batch have been removed. ...</li>
 * <li>We do not clean beyond the last stable offset. This ensures that all records observed by the cleaner have
 *    been decided (i.e. committed or aborted). ...</li>
 * <li>Records from aborted transactions are removed by the cleaner immediately without regard to record keys.</li>
 * <li>Transaction markers are retained until all record batches from the same transaction have been removed and
 *    a sufficient amount of time has passed ...</li>
```

[`LogCleaner.java#L79-L94`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java#L79-L94)。

**「LSO より先は圧縮しない」** が特に効いている。まだコミットも中断もされていない領域を圧縮すると、後でそのトランザクションが中断されたときに整合しない。**未確定の領域には触らない**という単純な規則で、圧縮とトランザクションの相互作用を切り離している ([トランザクションのページ](../transactions-eos/))。

**中断されたトランザクションのレコードは、キーに関係なく即座に消す。** どうせ誰にも読まれないからだ。

### 書き直しの安全性

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java"
 * To avoid segments shrinking to very small sizes with repeated cleanings we implement a rule by which if we will merge successive segments when
 * doing a cleaning if their log and index size are less than the maximum log and index size prior to the clean beginning.
 * <p>
 * Cleaned segments are swapped into the log as they become available.
 * <p>
 * One nuance that the cleaner must handle is log truncation. If a log is truncated while it is being cleaned the cleaning of that log is aborted.
```

[`LogCleaner.java#L64-L69`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java#L64-L69)。

**圧縮を繰り返すとセグメントが痩せる。** 1 GB のセグメントが 100 MB になり、次は 10 MB になる。小さいファイルが大量に増えると、ファイルディスクリプタと[インデックスの mmap](../sparse-index/) を食う。だから隣接するセグメントをまとめて 1 個に書き直す。

書き込み先は `.cleaned` ファイルで、書き終わったら `.swap` にリネームし、古いセグメントを消してから接尾辞を外す。[復旧のページ](../log-recovery/) で見た 3 パスは、この手順のどこで落ちても続きを決められるようにするためのものだ。

## なぜそうなっているか

### なぜキーを保存しないのか

キーを保存すると、次の 3 つが要る。

- キーのバイト列そのもの (可変長)。
- 可変長データを固定サイズバッファに詰める仕組み。
- 比較のためのバイト列比較。

これを全部やめて、**「衝突しないハッシュがあれば、キーの同一性判定はハッシュの同一性判定で代用できる」** に賭けている。

賭けが外れる — つまり MD5 が衝突する — と、**異なるキーが同じキーと見なされ、片方のレコードが消える**。データが静かに失われる。

それでもこの設計を選べるのは、MD5 の 128 ビットで 500 万エントリの衝突確率が無視できるほど小さいからだ (誕生日問題で概算すると 10⁻²⁴ のオーダー)。javadoc がわざわざ "cryptographically secure hash" と書いているのは、**ここでハッシュの質が正しさに直結する**からで、`hashCode()` のような弱いハッシュでは成立しない。

暗号学的な安全性が要るのは秘密のためではなく、**衝突耐性のため**である点も注意したい。MD5 は署名用途としては破られているが、偶発的な衝突に対する耐性はまだ十分にある。

### なぜリサイズしないのか

メモリを固定にすると、**圧縮の最中に OOM が起きない**。

これは重要で、`LogCleaner` はバックグラウンドスレッドとして動いていて、失敗するとそのパーティションは圧縮されないまま膨らみ続ける。「メモリが足りなくて失敗する」を避けるには、**そもそも足りなくならない設計にする**しかない。

代わりに、入り切らないときは **1 回の圧縮で処理する範囲を狭める**。dirty 区間の全部ではなく、マップに入るところまで。残りは次回に回る。**完全性を諦めて、確実に前進することを選んでいる。**

これは分割統治の一形態で、「1 回で終わらせる」ではなく「毎回少しずつ進み、いずれ収束する」という設計になっている。

### なぜ「汚れ具合」がバイト比なのか

理想的には「重複しているレコードの割合」で選びたい。だが、それを知るにはマップを作るしかない。**測るために圧縮するのでは本末転倒だ。**

バイト比なら、セグメントのファイルサイズを足すだけで求まる。**実際の重複率とは相関するが一致しない**近似だが、選択のためなら十分だ。

「正確な指標が高コストなら、安く測れる近似を使って選択だけする」というのは、スケジューラ全般で見る形になっている。

### なぜアクティブセグメントを圧縮しないのか

アクティブセグメントは書き込み中なので、読んでいる間に中身が増える。**「読み取り対象が確定していないと、書き直せない」** という単純な理由だ。

同じ理由で、`min.compaction.lag.ms` が設定されていれば、その時間内のセグメントも対象外になる。**「まだ変わるかもしれないもの」に触らない**という方針が、[アクティブセグメントだけが可変](../log-segment/) というログの構造と揃っている。

## どう活かすか

**「キーを持たずにハッシュだけを持つ集合/マップ」は、メモリが支配的な重複排除で強い武器になる。** 24 バイト/エントリは `HashMap` の 4 分の 1 以下で、GC 圧もゼロだ。**採用の条件は 2 つ** — 偽陽性 (衝突) が起きたときの被害を評価できること、そしてハッシュの品質が正しさに直結すると理解して選ぶこと。Bloom filter や HyperLogLog と同じ「確率的データ構造」の一員として扱うべきで、`hashCode()` を流用してはいけない。

**「固定メモリで、入り切らなければ範囲を狭める」という設計は、バックグラウンドのメンテナンス処理に向いている。** 「1 回で全部やる」を諦めると、メモリ上限を静的に決められて、OOM で失敗しなくなる。**メンテナンス処理は失敗するとゆっくり悪化する**ので、確実に少しずつ進むほうが、たまに大きく進んで時々失敗するより良い。

**「安く測れる近似で選ぶ」も持ち帰れる。** 正確な優先度が高コストなら、相関する安い指標で代用する。選択を間違えても、次のラウンドで直る種類の処理なら、それで足りる。

**tombstone の扱いは、削除機能を作るときに必ず考えることになる。** 「削除した」という事実自体が情報であり、それを消してよいのは **「全ての読み手が削除を観測し終わった」と言えるとき**だけだ。Kafka はそれを時間 (`delete.retention.ms`) で近似している。厳密に追跡するには読み手の進捗を全部知る必要があり、それは高すぎる。**時間による近似と、その起点をどこに置くか (Kafka の場合は「clean 区間に入った時刻」) が設計のポイントになる。**
