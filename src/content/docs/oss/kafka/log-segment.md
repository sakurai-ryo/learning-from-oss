---
title: "パーティションはセグメントファイルの列でしかない"
description: "Kafka のパーティションは 1 個の巨大ファイルではなく、先頭 offset をファイル名にしたセグメントの列だ。分けることで、削除が unlink に、検索がファイル名の二分探索に、そしてクラッシュ復旧が末尾数ファイルの検査に落ちる。ロールの条件が 5 つあり、そのうち 1 つはインデックスの 4 バイト制約から来ている。"
sidebar:
  order: 3
---

## 何を学んだか

### どんな状況の話か

「追記専用のログをファイルで持つ」を素直にやると、パーティションごとに 1 個の巨大ファイルになる。これは次の 4 点で行き詰まる。

1. **古いデータを消せない。** ファイルの先頭を削る操作が (少なくとも移植性のある形では) 存在しない。
2. **offset からファイル位置を引けない。** 全体を舐めるしかない。
3. **クラッシュ後に全体を検査することになる。** 数百 GB のファイルの CRC を全部確認するのは現実的でない。
4. **ファイルサイズやインデックスの上限に当たる。**

### Kafka の答え

**ログを「セグメント」というファイルの列にし、ファイル名をそのセグメントの先頭 offset にする。**

```text
orders-0/
├── 00000000000000000000.log   ← offset 0 〜 14326
├── 00000000000000014327.log   ← offset 14327 〜 29112
└── 00000000000000029113.log   ← offset 29113 〜 (アクティブセグメント)
```

これで 4 つの問題が全部落ちる。

1. 古いデータの削除 = **先頭のファイルを消す**。
2. offset の検索 = **ファイル名を二分探索**して当たりを付け、その中の索引を引く。
3. クラッシュ復旧 = **最後にフラッシュした地点より後のセグメントだけ**検査する。
4. 1 セグメントの上限 (既定 1 GB) を超えたら次のファイルに移る。

そのうえで、実装には次の判断が入っている。

- **書き込めるのは末尾のセグメント (アクティブセグメント) だけ。** それ以外は不変になる。
- **セグメントの管理は `ConcurrentSkipListMap`。** 読みはロックを取らない。
- **ロールの条件は 5 つあり、サイズと時間だけではない。**
- **削除は「リネームしてから、後で消す」。**
- **書き込みのたびに fsync はしない。既定では明示的な fsync を一切しない。**

## ソースコードのどこか

### セグメント 1 つの中身

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java"
/**
 * A segment of the log. Each segment has two components: a log and an index. The log is a FileRecords containing
 * the actual messages. The index is an OffsetIndex that maps from logical offsets to physical file positions. Each
 * segment has a base offset which is an offset <= the least offset of any message in this segment and > any offset in
 * any previous segment.
 *
 * A segment with a base offset of [base_offset] would be stored in two files, a [base_offset].index and a [base_offset].log file.
 *
 * This class is not thread-safe.
 */
public class LogSegment implements Closeable {
```

[`LogSegment.java#L56-L66`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java#L56-L66)。

実際にはファイルは 4 種類ある。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java"
private final FileRecords log;
private final LazyIndex<OffsetIndex> lazyOffsetIndex;
private final LazyIndex<TimeIndex> lazyTimeIndex;
private final TransactionIndex txnIndex;
private final long baseOffset;
```

[`LogSegment.java#L80-L84`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java#L80-L84)。

`.log` が本体、`.index` が offset → ファイル位置、`.timeindex` が時刻 → offset、`.txnindex` が中断されたトランザクションの記録だ。インデックスが `LazyIndex` で包まれているのは、**古いセグメントのインデックスを開いたままにしないため**である。パーティション数 × セグメント数だけ mmap を張ると、ファイルディスクリプタと仮想メモリを食い潰す。

`This class is not thread-safe` と明記されているのも見どころだ。並行制御はこの下の層ではなく、上の `UnifiedLog` が 1 個のロックで面倒を見る。

### セグメントの列

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegments.java"
/**
 * This class encapsulates a thread-safe navigable map of LogSegment instances and provides the
 * required read and write behavior on the map.
 */
public class LogSegments implements Closeable {
    ...
    private final ConcurrentNavigableMap<Long, LogSegment> segments = new ConcurrentSkipListMap<>();
```

[`LogSegments.java#L35-L42`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegments.java#L35-L42)。

**キーが base offset、値がセグメント。** 「offset 20000 を含むセグメントを探す」は `floorEntry(20000)` の一発で、`ConcurrentSkipListMap` なのでロックを取らずに済む。フェッチは同時に何百本も走るので、ここが読みでロックすると詰まる。

### ロールの条件は 5 つ

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java"
public boolean shouldRoll(RollParams rollParams) throws IOException {
    boolean reachedRollMs = timeWaitedForRoll(rollParams.now(), rollParams.maxTimestampInMessages()) > rollParams.maxSegmentMs() - rollJitterMs;
    int size = size();
    return size > rollParams.maxSegmentBytes() - rollParams.messagesSize() ||
        (size > 0 && reachedRollMs) ||
        offsetIndex().isFull() || timeIndex().isFull() || !canConvertToRelativeOffset(rollParams.maxOffsetInMessages());
}
```

[`LogSegment.java#L168-L174`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java#L168-L174)。

| 条件                                    | 意味                                          | 既定値                        |
| --------------------------------------- | --------------------------------------------- | ----------------------------- |
| `size > maxSegmentBytes - messagesSize` | 今回の書き込みを入れると上限を超える          | `segment.bytes` = 1 GB        |
| `size > 0 && reachedRollMs`             | 時間が経った (空なら回さない)                 | `segment.ms` = 7 日           |
| `offsetIndex().isFull()`                | offset インデックスが満杯                     | `segment.index.bytes` = 10 MB |
| `timeIndex().isFull()`                  | 時刻インデックスが満杯                        | 同上                          |
| `!canConvertToRelativeOffset(...)`      | **offset が base offset から 2³¹ 以上離れた** | —                             |

最後の条件が面白い。offset インデックスは 1 エントリ 8 バイトで、**offset を「base offset からの差分」として 4 バイトで持つ** ([疎インデックスのページ](../sparse-index/))。差分が `int` に収まらなくなったら、サイズも時間も余っていてもセグメントを回すしかない。**インデックスのバイト数をケチった判断が、ログのロール条件として顔を出している。**

`rollJitterMs` にも意味がある。同じ時刻に作られたパーティションは、`segment.ms` でも同時にロールしようとする。全パーティションが一斉にファイルを作ってフラッシュすると I/O が固まるので、ランダムなずらしを入れている。

### 追記

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java"
int physicalPosition = log.sizeInBytes();

ensureOffsetInRange(largestOffset);

// append the messages
long appendedBytes = log.append(records);

for (RecordBatch batch : records.batches()) {
    long batchMaxTimestamp = batch.maxTimestamp();
    long batchLastOffset = batch.lastOffset();
    if (batchMaxTimestamp > maxTimestampSoFar()) {
        maxTimestampAndOffsetSoFar = new TimestampOffset(batchMaxTimestamp, batchLastOffset);
    }

    if (bytesSinceLastIndexEntry > indexIntervalBytes) {
        offsetIndex().append(batchLastOffset, physicalPosition);
        timeIndex().maybeAppend(maxTimestampSoFar(), shallowOffsetOfMaxTimestampSoFar());
        bytesSinceLastIndexEntry = 0;
    }
    var sizeInBytes = batch.sizeInBytes();
    physicalPosition += sizeInBytes;
    bytesSinceLastIndexEntry += sizeInBytes;
}
```

[`LogSegment.java#L251-L281`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java#L251-L281)。

**追記の本体は `log.append(records)` の 1 行だけ。** 残りは索引の更新で、`bytesSinceLastIndexEntry` が `index.interval.bytes` (既定 4 KB) を超えたときだけインデックスにエントリを足す。**4 KB ごとに 1 エントリなので、1 GB のセグメントでもインデックスは 2 MB 程度**に収まる。

ここで **fsync は呼ばれていない**。

### 既定では fsync しない

```java title="server-common/src/main/java/org/apache/kafka/server/config/ServerLogConfigs.java"
public static final long LOG_FLUSH_INTERVAL_MESSAGES_DEFAULT = Long.MAX_VALUE;
...
public static final long LOG_FLUSH_SCHEDULER_INTERVAL_MS_DEFAULT = Long.MAX_VALUE;
```

[`ServerLogConfigs.java#L101-L109`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/config/ServerLogConfigs.java#L101-L109)。

**「何件書いたらフラッシュするか」も「何ミリ秒ごとにフラッシュするか」も、既定値が `Long.MAX_VALUE`。** つまり Kafka は、既定では自分から fsync を呼ばない。セグメントをロールするときと、シャットダウンするときにだけフラッシュする。

書いたデータは OS のページキャッシュに乗ったままで、いつディスクに落ちるかは OS 任せだ。ブローカーのプロセスが落ちてもデータは残る (ページキャッシュはカーネルの持ち物なので) が、**マシンごと落ちたら失われうる**。

### 削除は「リネームしてから、後で消す」

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LocalLog.java"
for (LogSegment segment : segmentsToDelete) {
    if (!segment.hasSuffix(DELETED_FILE_SUFFIX)) {
        segment.changeFileSuffixes("", DELETED_FILE_SUFFIX);
    }
}

Runnable deleteSegments = () -> {
    LOG.info("{}Deleting segment files {}", logPrefix, ...);
    ...
            for (LogSegment segment : segmentsToDelete) {
                segment.deleteIfExists();
            }
```

[`LocalLog.java#L846-L871`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LocalLog.java#L846-L871)。

まず `.log` → `.log.deleted` にリネームし、実際の `unlink` は `file.delete.delay.ms` (既定 60 秒) 後にスケジューラで実行する。

### 削除の条件は 3 つ

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java"
public int deleteOldSegments() throws IOException {
    int deletedSegments;
    try {
        if (config().delete) {
            deletedSegments = deleteLogStartOffsetBreachedSegments() +
                    deleteRetentionSizeBreachedSegments() +
                    deleteRetentionMsBreachedSegments();
        } else if (config().compact) {
            deletedSegments = deleteLogStartOffsetBreachedSegments();
        } else {
```

[`UnifiedLog.java#L1967-L1996`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java#L1967-L1996)。

- **log start offset を下回った** — `deleteRecords` API で明示的に切られた、または[階層型ストレージ](../tiered-storage/)へ移された。
- **サイズ超過** — `retention.bytes`。
- **時間超過** — `retention.ms`。

`cleanup.policy=compact` (キー単位の[圧縮](../log-compaction/)) のときは、時間やサイズによる削除をしない。**保持ポリシーの違いが、この 1 個の `if` に集約されている。**

## なぜそうなっているか

### ファイル名を base offset にすると、索引が 1 段減る

「offset 20000 はどのファイルか」を答えるには、普通ならファイルと offset 範囲の対応表が要る。その対応表自体を永続化し、クラッシュ時に整合させる必要も出てくる。

**ファイル名を base offset にすると、この対応表がディレクトリエントリそのものになる。** 起動時に `ls` してファイル名をパースすれば、それが対応表だ。壊れた対応表を復旧する処理が要らないのは、対応表を持っていないからである。

ゼロ埋め 20 桁になっているのは、**文字列としてソートした順序が数値の順序と一致する**ようにするためだ。`ls` の出力がそのまま offset 順になる。

### `ConcurrentSkipListMap` である理由

セグメントの列に対する操作は、読みと書きで頻度が桁違いに違う。

- **読み**: フェッチのたび。1 ブローカーで毎秒数万回。
- **書き**: セグメントのロールと削除。数分から数時間に 1 回。

`ConcurrentSkipListMap` は読みがロックフリーで、`floorEntry` のような範囲検索を持つ。`synchronized` な `TreeMap` だと、ロールのたびに全フェッチが待たされる。読みの頻度が支配的なら、書き側が多少高くつくデータ構造を選ぶ — という判断がそのまま出ている。

### なぜアクティブセグメント以外を不変にするか

「末尾のファイルだけが書き込み可能」という制約が、多くのことを単純にする。

- **古いセグメントは何のロックもなしに読める。** 内容が変わらないので、読んでいる最中に追記が来る心配がない。
- **ファイルからソケットへの直接転送 (`sendfile`) が安全にできる** ([ゼロコピーのページ](../zero-copy/))。転送中に内容が変わらない。
- **クラッシュ復旧の対象が末尾だけになる** ([復旧のページ](../log-recovery/))。

Kafka の「追記専用」という制約は、ユーザーに対する制約であると同時に、**実装を単純にするための制約**でもある。

### なぜリネームしてから消すか

セグメントを消そうとした瞬間に、そのセグメントを読んでいるフェッチが進行中かもしれない。すぐ `unlink` すると次の 2 つが起きる。

- **mmap 済みのインデックスにアクセスすると SIGBUS で JVM ごと落ちる。** POSIX では、削除されたファイルの mmap 領域への読みは未定義になりうる。
- Windows では、開いているファイルを削除できない。

`.deleted` にリネームしておけば、**新しいフェッチはこのセグメントを見つけられなくなり** (ファイル名の一覧から外れるため)、進行中のフェッチは open 済みのファイルディスクリプタで読み続けられる。60 秒待てば、進行中のものは全部終わっている。

**「消す」を「見えなくする」と「回収する」に分ける**のは、GC やコネクションプールでも見る形だ。

### なぜ fsync しないのか

これは Kafka の設計思想が一番はっきり出るところだ。**耐久性を fsync ではなくレプリケーションで担保している。**

`acks=all` の書き込みは「ISR 全員がそのレコードを受け取った」時点で応答される ([ISR のページ](../isr-highwatermark/))。全員のページキャッシュに乗っているなら、1 台のマシンが電源ごと落ちてもデータは残る。**N 台のマシンが同時にクラッシュする確率**と、**1 台で fsync を待つコスト**を天秤にかけて、後者を捨てている。

副作用として、Kafka は **ページキャッシュに強く依存する**。JVM ヒープにデータをキャッシュせず、OS のページキャッシュを唯一のキャッシュとして使う。だからブローカーのヒープは小さくてよく (数 GB)、マシンのメモリはほとんどページキャッシュに回すのが正しい設定になる。

ただし、この判断は無条件ではない。`flush.messages=1` を設定すれば毎回 fsync する。「レプリカが全部同じラックにいる」「電源障害が相関する」環境なら、そちらを選ぶ余地は残されている。

## どう活かすか

**「大きなファイルを、名前に開始位置を書いた小さなファイルの列にする」は、追記中心のデータを扱うときの定石として持っておける。** ログ、イベントストア、時系列データ、監査証跡。削除・検索・復旧の 3 つが同時に楽になり、しかも実装は「ファイル名をパースする」だけで済む。RDB のテーブルスペースのようなブロック管理を自作するより、はるかに安い。

**ロール条件に「インデックスの表現上限」が入っている点は、設計のトレードオフの実例として覚えておきたい。** インデックスを 8 バイト/エントリに詰めた結果、2³¹ という制約が生まれ、それがロール条件に漏れ出した。**下位層で削ったバイト数が、上位層の挙動に条件として現れる**のは珍しくない。逆に言えば、そういう制約は隠さずに `shouldRoll` の 1 行として書いてしまうほうが、後から読む人には親切だ。

**「削除をリネームと回収の 2 段に分ける」は、共有リソースを消すときの汎用パターン**として使える。参照カウントを実装するより安く、「新規の参照を止める」と「既存の参照が消えるのを待つ」を分離できる。待ち時間を設定可能にしておけば、環境ごとに調整もできる。

**fsync を捨ててレプリケーションに寄せる判断は、そのままは真似できない。** 成立条件が 3 つある — レプリカが独立に故障すること、レプリカ数が十分にあること、そして「同時故障で失われる」を受け入れられること。単一ノードのシステムや、レプリカが同じ電源系統にいる構成では成立しない。**判断そのものより、「耐久性をどの層で担保するかを 1 箇所で決め、他の層はそれに従う」という一貫性のほうが移植できる。** Kafka のコードには「念のためここでも fsync しておく」が出てこない。
