---
title: "疎インデックスと mmap で、オフセットからファイル位置を引く"
description: "Kafka のインデックスは全レコードを載せない。4 KB ごとに 1 エントリ、1 エントリ 8 バイト、offset は base からの差分で 4 バイトに詰める。そして二分探索を「末尾 8 KB の温かい領域」と「それ以外」に分ける。標準の二分探索がページフォルトを起こして書き込みレイテンシを 1 秒に跳ね上げた、という実測がコメントに残っている。"
sidebar:
  order: 4
---

## 何を学んだか

### どんな状況の話か

[セグメントのページ](../log-segment/) で見たとおり、offset からセグメントファイルを特定するのはファイル名の二分探索で済む。残るのは **「そのファイルの何バイト目か」** だ。

1 GB のセグメントに 100 万件のレコードが入っているとして、offset 987654 のファイル位置をどう引くか。素直な方法は 2 つある。

- **全レコードのインデックスを持つ。** 100 万エントリ × 8 バイト = 8 MB。セグメントごとに。パーティション 1000 個 × セグメント 10 個なら 80 GB。無理だ。
- **先頭から走査する。** O(n)。無理だ。

### Kafka の答え

**疎インデックスにする。全レコードではなく、一定バイトごとに 1 エントリだけ置く。**

1. **`index.interval.bytes` (既定 4 KB) ごとに 1 エントリ。** 1 GB のセグメントで約 26 万エントリ、2 MB。
2. **1 エントリは 8 バイト。** offset を base offset からの差分にして 4 バイト、ファイル位置が 4 バイト。
3. **mmap で読む。** ページキャッシュ経由になり、ディスク I/O でブロックしない。
4. **索引で「その手前」まで飛んで、そこから先はレコードを順に走査する。** 最大でも 4 KB 分。
5. **二分探索を「温かい領域」と「冷たい領域」に分ける。** これが一番面白い部分で、ページフォルトを避けるための最適化だ。

## ソースコードのどこか

### エントリ形式

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/OffsetIndex.java"
/**
 * An index that maps offsets to physical file locations for a particular log segment. This index may be sparse:
 * that is it may not hold an entry for all messages in the log.
 *
 * <p>The index is stored in a file that is pre-allocated to hold a fixed maximum number of 8-byte entries.
 * ...
 * <p>No attempt is made to checksum the contents of this file, in the event of a crash it is rebuilt.
 *
 * <p>The file format is a series of entries. The physical format is a 4 byte "relative" offset and a 4 byte file location for the
 * message with that offset. The offset stored is relative to the base offset of the index file. So, for example,
 * if the base offset was 50, then the offset 55 would be stored as 5. Using relative offsets in this way let's us use
 * only 4 bytes for the offset.
```

[`OffsetIndex.java#L29-L54`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/OffsetIndex.java#L29-L54)。

**offset は 64 ビットだが、base offset からの差分なら 32 ビットに収まる。** これで 1 エントリが 12 バイトから 8 バイトになる。33% の削減で、しかも 8 バイト境界に揃うので `getInt` 2 回で読める。

代償が [セグメントのロール条件](../log-segment/) に出てくる `canConvertToRelativeOffset` だ。差分が 2³¹ を超えたらセグメントを回すしかない。

もう 1 つ、**チェックサムを一切持たない**と明記されている。壊れていたら作り直す。インデックスはログから完全に再生成できるので、守る必要がない。

時刻インデックスは 12 バイトだ。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/TimeIndex.java"
 * The file format is a series of time index entries. The physical format is a 8 bytes timestamp and a 4 bytes "relative"
 * offset used in the [[OffsetIndex]]. A time index entry (TIMESTAMP, OFFSET) means that the biggest timestamp seen
 * before OFFSET is TIMESTAMP. i.e. Any message whose timestamp is greater than TIMESTAMP must come after OFFSET.
```

[`TimeIndex.java#L30-L54`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/TimeIndex.java#L30-L54)。

タイムスタンプは差分にできない (基準がない) ので 8 バイトのまま。**エントリの意味が「この offset より前に見た最大のタイムスタンプ」になっている**のがポイントで、これなら単調増加が保証でき、二分探索が使える。レコードのタイムスタンプ自体は順序が乱れうる (プロデューサが付けた時刻を使う設定があるため) が、「今までの最大値」は必ず単調増加する。

### 引き方は 2 段

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java"
LogOffsetPosition translateOffset(long offset, int startingFilePosition) throws IOException {
    OffsetPosition mapping = offsetIndex().lookup(offset);
    return log.searchForOffsetFromPosition(offset, Math.max(mapping.position(), startingFilePosition));
}
```

[`LogSegment.java#L399-L402`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java#L399-L402)。

1. **インデックスで「目的の offset 以下で最大のエントリ」を引く。** 二分探索。
2. **そこから先を順に走査する。** レコードバッチのヘッダだけを読み飛ばしていく。

2 の走査距離は最大でも `index.interval.bytes` = 4 KB。**「索引を疎にした分のコストを、短い線形走査で払う」** という素直なトレードオフになっている。

### 二分探索を 2 つに割る

`AbstractIndex` に、この章で一番長いコメントがある。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java"
 * Kafka mmaps index files into memory, and all the read / write operations of the index is through OS page cache. This
 * avoids blocked disk I/O in most cases.
 *
 * To the extent of our knowledge, all the modern operating systems use LRU policy or its variants to manage page
 * cache. Kafka always appends to the end of the index file, and almost all the index lookups (typically from in-sync
 * followers or consumers) are very close to the end of the index. So, the LRU cache replacement policy should work very
 * well with Kafka's index access pattern.
 *
 * However, when looking up index, the standard binary search algorithm is not cache friendly, and can cause unnecessary
 * page faults (the thread is blocked to wait for reading some index entries from hard disk, as those entries are not
 * cached in the page cache).
```

[`AbstractIndex.java#L330-L386`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java#L330-L386)。

問題の説明が具体的だ。

```text title="storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java"
 * For example, in an index with 13 pages, to lookup an entry in the last page (page #12), the standard binary search
 * algorithm will read index entries in page #0, 6, 9, 11, and 12.
 * page number: |0|1|2|3|4|5|6|7|8|9|10|11|12 |
 * steps:       |1| | | | | |3| | |4|  |5 |2/6|
 ...
 * When the index grows to page #13, the pages needed in a in-sync lookup change to #0, 7, 10, 12, and 13:
 * page number: |0|1|2|3|4|5|6|7|8|9|10|11|12|13 |
 * steps:       |1| | | | | | |3| | | 4|5 | 6|2/7|
 * Page #7 and page #10 have not been used for a very long time. They are much less likely to be in the page cache, than
 * the other pages. The 1st lookup, after the 1st index entry in page #13 is appended, is likely to have to read page #7
 * and page #10 from disk (page fault), which can take up to more than a second. In our test, this can cause the
 * at-least-once produce latency to jump to about 1 second from a few ms.
```

**何が起きているか。**

インデックスの読みは、ほとんどが末尾付近を狙う。追いついているフォロワーも、リアルタイムに読んでいるコンシューマも、探すのは最新のレコードだからだ。

ところが、二分探索が実際に触るページは末尾付近ではない。最初に真ん中、次に 3/4 の位置、というふうに **インデックス全体に散らばる**。しかも、インデックスが 1 ページ伸びるたびに **触るページの集合が丸ごと入れ替わる**。上の例では、13 ページのときは #0, 6, 9, 11, 12 を触っていたのが、14 ページになると #0, 7, 10, 12, 13 になる。#7 と #10 は長い間触られていないので、ページキャッシュから追い出されている可能性が高い。

**結果、セグメントの成長中に定期的にページフォルトが起き、数ミリ秒だったプロデュースのレイテンシが 1 秒に跳ね上がる。** テストで観測された、と書いてある。

対策はこうだ。

```text title="storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java"
 * Here, we use a more cache-friendly lookup algorithm:
 * if (target > indexEntry[end - N]) // if the target is in the last N entries of the index
 *    binarySearch(end - N, end)
 * else
 *    binarySearch(begin, end - N)
```

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java"
int firstHotEntry = Math.max(0, entries - 1 - warmEntries());
// check if the target offset is in the warm section of the index
if (compareIndexEntry(parseEntry(idx, firstHotEntry), target, searchEntity) < 0) {
    return binarySearch(idx, target, searchEntity,
        searchResultType, firstHotEntry, entries - 1);
}
...
return binarySearch(idx, target, searchEntity, searchResultType, 0, firstHotEntry);
```

[`AbstractIndex.java#L495-L517`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java#L495-L517)。

**末尾 8 KB を「warm セクション」と決め打ちし、目的の値がそこに入るなら、その範囲だけを二分探索する。**

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java"
protected final int warmEntries() {
    return 8192 / entrySize();
}
```

[`AbstractIndex.java#L387-L389`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java#L387-L389)。

8 バイトの offset インデックスなら 1024 エントリ、12 バイトの時刻インデックスなら約 683 エントリになる。

8192 という数字の根拠も書いてある。

```text title="storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java"
 * We set N (_warmEntries) to 8192, because
 * 1. This number is small enough to guarantee all the pages of the "warm" section is touched in every warm-section
 *    lookup. So that, the entire warm section is really "warm".
 *    When doing warm-section lookup, following 3 entries are always touched: indexEntry(end), indexEntry(end-N),
 *    and indexEntry((end*2 -N)/2). If page size >= 4096, all the warm-section pages (3 or fewer) are touched, when we
 *    touch those 3 entries.
 * 2. This number is large enough to guarantee most of the in-sync lookups are in the warm-section. With default Kafka
 *    settings, 8KB index corresponds to about 4MB (offset index) or 2.7MB (time index) log messages.
```

**「warm セクションが本当に warm であること」を、ページ数から逆算している。** 8 KB は 4 KB ページで最大 3 ページ。warm セクション内の二分探索は必ず 3 つのエントリ (末尾、先頭、中間) を触るので、**3 ページ以下なら毎回全ページを触ることになり、LRU から落ちない**。8192 より大きくすると、この保証が崩れる。

### インデックスは遅延ロードする

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LazyIndex.java"
/**
 * A wrapper over an `AbstractIndex` instance that provides a mechanism to defer loading
 * (i.e. memory mapping) the underlying index until it is accessed for the first time via the
 * `get` method.
 * ...
 * This is an important optimization with regards to broker start-up and shutdown time if it has a
 * large number of segments.
 */
```

[`LazyIndex.java#L29-L45`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LazyIndex.java#L29-L45)。

パーティション 2000 個 × セグメント 50 個 = 10 万セグメント。それぞれに offset インデックスと時刻インデックスがあると、**起動時に 20 万回の mmap** が走る。ほとんどのセグメントは読まれないのに。

`LazyIndex` は「リネームする」「閉じる」「親ディレクトリを変える」といった **mmap を必要としない操作をファイル名だけで済ませる**ようにして、実際に引かれるまで mmap を遅らせる。

## なぜそうなっているか

### 疎インデックスが成立する条件

疎インデックスで済むのは、**ログが offset 順に並んでいると保証されている**からだ。「目的地の手前」まで飛べれば、あとは前に進むだけで必ず着く。

これは追記専用ログだから言えることで、更新や削除がある構造では成立しない。**「データ構造の制約が、索引を安くする」** という関係になっている。

`index.interval.bytes` は、索引のサイズと走査距離のトレードオフを直接握るつまみだ。小さくすれば索引が大きくなり、大きくすれば走査が伸びる。既定の 4 KB が **ページサイズと一致している**のは偶然ではないだろう。1 回の走査が 1 ページに収まる。

### なぜ mmap なのか

インデックスを read/write システムコールで読むと、**1 回の二分探索で 20 回程度のシステムコール**が発生する。mmap ならメモリアクセスとして扱われ、ページキャッシュにあれば syscall なしで済む。

代償は 2 つある。**ページフォルトはブロックする** — 上で見た問題そのものだ。そして **mmap の解放が JVM から制御しにくい**。`AbstractIndex` に `safeForceUnmap` という、リフレクション経由で強制的に unmap するメソッドが用意されているのはそのためだ。

### なぜチェックサムを持たないか

インデックスはログから再生成できる。**「壊れていたら作り直す」で済むものに、検証コストを払わない。** クラッシュ復旧のときも、末尾のセグメントについてはインデックスを丸ごと捨てて作り直す ([復旧のページ](../log-recovery/))。

これは「派生データには保護をかけない」という一般則で、キャッシュやマテリアライズドビューにも同じことが言える。**元データさえ守れていれば、派生物は再計算できる。**

### warm セクションの最適化から読み取れること

この最適化は、アルゴリズムとしては何も改善していない。二分探索は二分探索のままで、計算量も同じだ。改善したのは **アクセスするページの集合を安定させたこと** だけである。

こういう最適化が効くのは、**コストがアルゴリズムのステップ数ではなく、階層記憶のどこに当たるかで決まる**ときだ。ページキャッシュにあれば数十ナノ秒、ディスクなら数ミリ秒。4 桁違う。ステップ数を 20 から 15 に減らすより、20 ステップ全部をキャッシュに当てるほうが桁違いに効く。

コメントの最後に、この最適化の限界も書いてある。

```text title="storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java"
 * In there future, we may use a backend thread to periodically touch the entire warm section. So that, we can
 * 1) support larger warm section
 * 2) make sure the warm section of low QPS topic-partitions are really warm.
```

**アクセス頻度の低いパーティションでは、warm セクションすら warm でない。** 「触られ続けているから keep される」という前提に乗った最適化なので、触られない相手には効かない。この制約を認識したうえで、それでも入れている。

## どう活かすか

**「一定バイトごとに 1 エントリの疎索引 + 短い線形走査」は、順序が保証された追記データなら再利用できる。** ログファイル、時系列、イベントストア。索引を密にする前に、「走査距離を索引エントリ間隔で抑えられないか」を考える価値がある。密索引はサイズがデータ量に比例するが、疎索引は比例定数を自分で決められる。

**「相対値にして幅を詰める」も汎用的だ。** base からの差分にして 8 バイトを 4 バイトにする。時系列データベースのデルタ符号化と同じ発想で、[レコードバッチ形式](../record-batch/) でも同じ手が使われている。**ただし、詰めた分だけ表現範囲の上限が生まれ、それが上位層の制約として漏れる**ことは覚悟する必要がある。Kafka の場合はセグメントのロール条件になった。

**warm セクションの話から持ち帰るべきなのは、手法そのものより「実測してから直した」という順序だ。** コメントには「テストで、プロデュースのレイテンシが数ミリ秒から約 1 秒に跳ねた」と書いてある。標準の二分探索を疑う理由は、コードを読んでも出てこない。P99 のレイテンシが定期的に跳ねるという観測が先にあって、原因を追ったらページフォルトだった、という順序でしか到達できない。**キャッシュ階層を意識した最適化は、プロファイルなしにやると外す。**

**そして、この最適化を入れるコストも見ておきたい。** 追加されたのは 20 行程度のコードと、その 10 倍近い量のコメントだ。**「なぜこの数字なのか」を書き残さないと、次の人が 8192 を 65536 に変えて保証を壊す。** マジックナンバーの根拠が段落として残っているのは、この規模の最適化を長期間維持するための必要経費になっている。
