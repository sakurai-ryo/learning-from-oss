---
title: "クラッシュ後の復旧を、チェックポイントファイルの差分だけで済ませる"
description: "Kafka は既定で fsync しない。落ちたら末尾が壊れている前提で起動する。それでも復旧が現実的な時間で終わるのは、「どこまでフラッシュしたか」を 1 行のチェックポイントで持ち、正常終了したかどうかをマーカーファイルで区別しているからだ。そのマーカーを読んだ直後に消す、という細部に KAFKA-10471 が刻まれている。"
sidebar:
  order: 7
---

## 何を学んだか

### どんな状況の話か

[セグメントのページ](../log-segment/) で見たとおり、Kafka は既定で fsync を呼ばない。**書いたデータがディスクに落ちているかどうか、ブローカーは知らない。**

この前提でマシンが電源ごと落ちると、ログの末尾は次のような状態になりうる。

- レコードバッチが途中で切れている。
- インデックスがログより進んでいる、あるいは遅れている。
- セグメントの[圧縮](../log-compaction/)中で、`.cleaned` や `.swap` ファイルが残っている。
- ディレクトリエントリだけがあって中身が空のファイルがある。

再起動時にこれを全部検査すると、**数百 GB のログを持つブローカーは起動に何時間もかかる**。

### Kafka の答え

**「どこまでは確実に無事か」を記録しておき、それより後だけを検査する。**

1. **`recovery-point-offset-checkpoint`** — ログディレクトリごとに 1 ファイル。パーティションごとに「ここまではフラッシュ済み」の offset が 1 行ずつ書かれている。
2. **クリーンシャットダウンのマーカーファイル** — 正常終了したときだけ作る。あれば検査を丸ごと飛ばす。
3. **`.swap` / `.cleaned` の後始末を、ロード前の 3 パスで行う。** 中断された圧縮を、リネームだけで完了または破棄する。
4. **壊れたバッチを見つけたら、そこから先を全部捨てる。** 修復しない。
5. **ログディレクトリごとに並列復旧し、1 つが壊れても他は生かす。**

## ソースコードのどこか

### 起動時の流れ

`LogLoader.load()` はコメントで段取りが番号付けされている。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
public LoadedLogOffsets load() throws IOException {
    // First pass: through the files in the log directory and remove any temporary files
    // and find any interrupted swap operations
    Set<File> swapFiles = removeTempFilesAndCollectSwapFiles();
```

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
    // Second pass: delete segments that are between minSwapFileOffset and maxSwapFileOffset. As
    // discussed above, these segments were compacted or split but haven't been renamed to .delete
    // before shutting down the broker.
```

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
    // Third pass: rename all swap files.
```

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
    // Fourth pass: load all the log and index files.
    // We might encounter legacy log segments with offset overflow (KAFKA-6264). We need to split such segments. When
    // this happens, restart loading segment files from scratch.
```

[`LogLoader.java#L128-L205`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java#L128-L205)。

**最初の 3 パスは、ログを 1 バイトも読まずにファイル名だけで完結する。**

圧縮 (compaction) は「新しいセグメントを `.cleaned` として書き、`.swap` にリネームし、古いものを消し、`.swap` を外す」という手順で進む。どの段階で落ちたかは、**残っているファイルの拡張子だけで判定できる**。`.swap` があれば「新しいセグメントは書き終わっている」ので、古いほうを消してリネームすれば完了する。`.cleaned` だけなら「まだ書き終わっていない」ので捨てる。

**アトミックな操作がリネームしかない世界で、中間状態をファイル名にエンコードしている。**

### クリーンシャットダウンなら検査しない

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
RecoveryOffsets recoverLog() throws IOException {
    // If we have the clean shutdown marker, skip recovery.
    if (!hadCleanShutdown) {
        Collection<LogSegment> unflushed = segments.values(recoveryPointCheckpoint, Long.MAX_VALUE);
        ...
        while (unflushedIter.hasNext() && !truncated) {
            LogSegment segment = unflushedIter.next();
            logger.info("Recovering unflushed segment {}. {} recovered for {}.", segment.baseOffset(), numFlushed / numUnflushed, topicPartition);
```

[`LogLoader.java#L456-L470`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java#L456-L470)。

検査するのは `segments.values(recoveryPointCheckpoint, Long.MAX_VALUE)` — **チェックポイント以降のセグメントだけ**。既定で fsync しない Kafka では、チェックポイントが進むのはセグメントのロール時とシャットダウン時なので、実際には「末尾の 1〜2 セグメント」で済むことが多い。

### 壊れていたら、そこから先は全部捨てる

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
if (truncatedBytes > 0) {
    // we had an invalid message, delete all remaining log
    logger.warn("Corruption found in segment {}, truncating to offset {}", segment.baseOffset(), segment.readNextOffset());
    Collection<LogSegment> unflushedRemaining = new ArrayList<>();
    unflushedIter.forEachRemaining(unflushedRemaining::add);
    removeAndDeleteSegmentsAsync(unflushedRemaining);
    truncated = true;
```

[`LogLoader.java#L477-L484`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java#L477-L484)。

**壊れたバッチを飛ばして先を読む、ということをしない。** 壊れた地点で切り、それ以降のセグメントは丸ごと削除する。

ログには穴が空いてはいけない。offset は連続していなければならず、「offset 100 は壊れているので 101 から」という状態を許すと、[インデックス](../sparse-index/)も high watermark も[レプリケーション](../isr-highwatermark/)も全部成立しなくなる。**捨てたデータは、レプリカから取り直せばいい** — というのが Kafka の立場だ。

### マーカーは、読んだ直後に消す

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogManager.java"
CleanShutdownFileHandler cleanShutdownFileHandler = new CleanShutdownFileHandler(dir.getPath());
if (cleanShutdownFileHandler.exists()) {
    // Cache the clean shutdown status and use that for rest of log loading workflow. Delete the CleanShutdownFile
    // so that if broker crashes while loading the log, it is considered hard shutdown during the next boot up. KAFKA-10471
    cleanShutdownFileHandler.delete();
    hadCleanShutdown.set(true);
}
```

[`LogManager.java#L629-L636`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogManager.java#L629-L636)。

**マーカーの存在を確認したら、その場で消す。**

理由がコメントに書いてある。ロードの途中でブローカーが落ちたとしよう。マーカーを残したままだと、次の起動でも「正常終了だった」と判断して検査を飛ばしてしまう。**しかし実際には、前回のロード中に何が起きたか分からない。**

`KAFKA-10471` という番号が付いているとおり、これは後から見つかったバグだ。「マーカーを読む」と「マーカーを消す」の順序という、1 行の話でしかない。

同じ考え方は他にもある。`recoverLog` の末尾のコメント。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
// Update the recovery point if there was a clean shutdown and did not perform any changes to
// the segment. Otherwise, we just ensure that the recovery point is not ahead of the log end
// offset. To ensure correctness and to make it easier to reason about, it's best to only advance
// the recovery point when the log is flushed. If we advanced the recovery point here, we could
// skip recovery for unflushed segments if the broker crashed after we checkpoint the recovery
// point and before we flush the segment.
```

[`LogLoader.java#L500-L512`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java#L500-L512)。

**「復旧が終わったから、チェックポイントを最新にしてよい」わけではない。** 復旧して読んだだけで、フラッシュはしていないからだ。チェックポイントを進めた直後にまた落ちたら、フラッシュされていない領域を「無事」と見なしてしまう。

**チェックポイントを進めてよいのはフラッシュした瞬間だけ、という不変条件を 1 箇所で守る。** これがこのコメントの主張だ。

### インデックスは疑わない、壊れていたら作り直す

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
try {
    segment.sanityCheck(timeIndexFileNewlyCreated);
} catch (NoSuchFileException nsfe) {
    if (hadCleanShutdown || segment.baseOffset() < recoveryPointCheckpoint) {
        logger.error("Could not find offset index file corresponding to log file {}, recovering segment and rebuilding index files...", ...);
    }
    recoverSegment(segment);
} catch (CorruptIndexException cie) {
    logger.warn("Found a corrupted index file corresponding to log file {} due to {}, recovering segment and rebuilding index files...", ...);
    recoverSegment(segment);
}
```

[`LogLoader.java#L376-L387`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java#L376-L387)。

インデックスが無い、あるいは壊れていたら、**そのセグメントを読み直してインデックスを作り直す**。[インデックスに CRC が無い](../sparse-index/)のはこのためで、守る必要がないものは守らない。

さらに、`.index` があるのに `.log` が無い場合は孤児として削除する。**「ログが権威、インデックスは派生」という関係が、復旧のコードで一貫している。**

### プロデューサ状態も作り直す

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java"
private int recoverSegment(LogSegment segment) throws IOException {
    ProducerStateManager producerStateManager = new ProducerStateManager(...);
    UnifiedLog.rebuildProducerState(
            producerStateManager, segments, logStartOffsetCheckpoint, segment.baseOffset(),
            time, false, logPrefix);
    int bytesTruncated = segment.recover(producerStateManager, leaderEpochCache);
    // once we have recovered the segment's data, take a snapshot to ensure that we won't
    // need to reload the same segment again while recovering another segment.
    producerStateManager.takeSnapshot();
    return bytesTruncated;
}
```

[`LogLoader.java#L400-L420`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogLoader.java#L400-L420)。

セグメントを 1 個復旧するたびにスナップショットを取っている。**そうしないと、次のセグメントを復旧するときに同じセグメントをもう一度読むことになる** — O(n²) を避けるための 1 行だ ([プロデューサ状態のページ](../producer-state/))。

### ディスク 1 本の故障で、ブローカー全体を落とさない

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogDirFailureChannel.java"
/*
 * LogDirFailureChannel allows an external thread to block waiting for new offline log dirs.
 *
 * There should be a single instance of LogDirFailureChannel accessible by any class that does disk-IO operation.
 * If IOException is encountered while accessing a log directory, the corresponding class can add the log directory name
 * to the LogDirFailureChannel using maybeAddOfflineLogDir(). Each log directory will be added only once. After a log
 * directory is added for the first time, a thread which is blocked waiting for new offline log directories
 * can take the name of the new offline log directory out of the LogDirFailureChannel and handle the log failure properly.
 * An offline log directory will stay offline until the broker is restarted.
 */
public class LogDirFailureChannel {
```

[`LogDirFailureChannel.java#L28-L38`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogDirFailureChannel.java#L28-L38)。

`log.dirs` に複数のディスクを並べる構成では、**1 本が壊れてもそのディスクだけをオフラインにする**。ストレージ層のあちこちで `IOException` を捕まえ、この 1 個のチャネルに投げ込むと、専用のスレッドがそれを受けてパーティションを切り離し、コントローラに通知する。

**「エラーを発生地点で処理しない」** のがこの設計の要点だ。`LogSegment.append` の中でディスク障害の処理をしようとすると、書き込みロックを持ったままレプリカ管理を触ることになる。キューに 1 行入れて先に進む。

そして **「再起動するまでオフラインのまま」** という単純な方針を採っている。自動で復帰させない。

### 復旧は並列に走る

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogManager.java"
ExecutorService pool = Executors.newFixedThreadPool(numRecoveryThreadsPerDataDir,
        new LogRecoveryThreadFactory(logDirAbsolutePath));
```

[`LogManager.java#L625-L627`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogManager.java#L625-L627)。

**ログディレクトリごとに独立したスレッドプール**を作る。ディスクが 8 本あれば 8 個のプールが並列に走る。1 本のディスクの中で並列度を上げてもシークが増えるだけなので、`num.recovery.threads.per.data.dir` は既定 1 のままにしておく構成が多い。

## なぜそうなっているか

### fsync しない選択が、復旧の設計を全部決めている

この章のほぼ全部が、[「既定で fsync しない」](../log-segment/) という 1 つの決定から派生している。

| fsync しないと               | だから                                        |
| ---------------------------- | --------------------------------------------- |
| 末尾が壊れている可能性がある | 起動時に検査が要る                            |
| どこまで無事か分からない     | チェックポイントで境界を記録する              |
| 検査は重い                   | 正常終了ならスキップしたい → マーカーファイル |
| 壊れた部分は復元できない     | 切り捨てて、レプリカから取り直す              |

**「性能のために耐久性の保証を弱め、その分を復旧のロジックとレプリケーションで埋める」** という構図で、片方だけ真似すると壊れる。

### なぜ「壊れたら切る」で済むのか

単体のデータベースなら、壊れたページを切り捨てる判断は簡単には下せない。そのデータが唯一のコピーだからだ。

Kafka がそれをできるのは、**レプリカが他にいる**からだ。切り捨てたブローカーは[フォロワーとしてリーダーから取り直す](../pull-replication/)。しかも Kafka のフォロワーは、そもそもリーダーとログが食い違ったときに切り詰める仕組みを持っている ([leader epoch のページ](../leader-epoch/))。**復旧で切り捨てた状態は、レプリケーションが日常的に扱っている状態と同じ**なので、特別な経路が要らない。

「壊れたら捨てて、他から持ってくる」は、レプリカがあるシステムだけの特権だ。

### なぜファイル名で状態を持つのか

`.cleaned`、`.swap`、`.deleted`、`-delete`、`-future`、`-stray`。[セグメントのページ](../log-segment/)で見たとおり、Kafka は 7 種類の接尾辞を使い分けている。

これは **「別のメタデータファイルを持たない」** という判断だ。中間状態を別ファイルに書くと、そのファイル自体の整合性を守る必要が出る (書いた直後に落ちたら?)。

ファイル名なら、**`rename(2)` が原子的**という POSIX の保証がそのまま使える。状態遷移が「リネーム」1 つで表せる限り、中間状態は生まれない。復旧は `listFiles()` して名前を見るだけになる。

### マーカーを先に消すことの一般性

「読んだ直後に消す」は、**マーカーの意味を「前回は正常終了した」から「前回は正常終了し、まだ読まれていない」に変える**操作だ。

一般化すると、**「一度しか信じてはいけない情報」は、消費した時点で無効化する**ということになる。同じ形は他にもある。

- ワンタイムトークン
- 冪等性キー
- 「初回起動フラグ」

いずれも「読んだけれど消す前に落ちた」の窓を、**消してから使う**ことで塞ぐ。Kafka の場合、消す前に落ちれば次回は hard shutdown 扱いになる。**安全側に倒れる。**

## どう活かすか

**「どこまで確実か」を記録して、それ以降だけを検査する構造は、起動時の検査が重いシステムなら常に検討できる。** チェックポイントは 1 行のファイルでよく、進めるタイミングを「フラッシュした瞬間だけ」に限定すれば正しさが保てる。**気をつけるべきは、Kafka のコメントが警告しているとおり「復旧できたからチェックポイントを進める」をやらないことだ。** 検査が終わったことと、データが安全になったことは違う。

**中間状態をファイル名にエンコードする手法は、外部のデータベースを持ち込みたくない場面で強い。** アトミックな操作がリネームしかないなら、状態遷移をリネームで表せる形に設計する。`tmp → 完成 → 旧を消す` という 3 段のうちどこで落ちても、残ったファイルの名前から続きが決まる。**逆に、状態が 2 つのファイルにまたがると成立しない**ので、「1 ファイル 1 状態」に落とせるかが分かれ目になる。

**「エラーを発生地点で処理せず、チャネルに投げて専用スレッドに任せる」も汎用的だ。** ロックを持ったまま重い後始末をすると、デッドロックか長時間の停止を招く。`LogDirFailureChannel` は `ConcurrentHashMap` + `BlockingQueue` の 40 行程度で、**「同じディスクを 2 回登録しない」だけを保証している**。小ささが正しさを支えている。

**一方、「壊れたら切り捨てる」はレプリカがある前提でしか採れない。** 単一ノードのシステムで同じことをすると、単にデータが消える。**まず「このデータの唯一のコピーか」を確認してから、復旧方針を決める**という順序は動かせない。もう 1 つの前提として、Kafka は「切り捨てた状態」がレプリケーションの日常的な状態と一致しているため、復旧専用の経路を持たずに済んでいる。**復旧後の状態を、平常時にも起きる状態に一致させられるか**は、設計時に見ておく価値がある。
