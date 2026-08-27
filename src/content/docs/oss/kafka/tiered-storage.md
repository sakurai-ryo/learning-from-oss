---
title: "古いセグメントをオブジェクトストレージへ逃がし、メタデータは内部トピックに書く"
description: "階層型ストレージは、ローカルディスクを直近のデータだけのキャッシュに変える。実装の要点は 2 つ — 「どのセグメントがどこにあるか」を強整合なメタデータストア (既定では内部トピック) に置き、実データ側は結果整合でよいと割り切ったこと。そしてセグメントのコピーが 2 段のステートマシンになっていることだ。"
group: "ストレージ"
sidebar:
  order: 10
---

## 何を学んだか

### どんな状況の話か

Kafka のパーティションは、ブローカーのローカルディスクに置かれる。すると、保持期間を延ばしたいときに困ったことになる。

- **90 日分を保持したい**が、日々のトラフィックが大きいと数十 TB になる。
- ディスクを増やすと、**ブローカーの台数も増やさざるを得ない**。ディスクは CPU やメモリと一緒にしか買えないからだ。
- **ブローカーを増減させると、パーティションの再配置に何時間もかかる。** データを丸ごとコピーする必要がある。

そして、この容量のほとんどは **ほぼ読まれない**。読まれるのは直近の数時間で、古いデータは障害時の再処理や監査のときだけ読む。

### Kafka の答え

**古いセグメントをオブジェクトストレージ (S3 など) に移し、ローカルには直近だけを置く。**

1. **ローカルの保持期間を `local.retention.ms` で別に持つ。** `retention.ms` が全体、`local.retention.ms` がローカル分。
2. **ストレージの実装はプラグイン。** `RemoteStorageManager` インタフェースを実装すれば S3 でも GCS でも HDFS でもよい。Kafka 本体に S3 のコードは入っていない。
3. **メタデータの管理も別のプラグイン。** `RemoteLogMetadataManager`。既定の実装は `__remote_log_metadata` トピックを使う。
4. **メタデータは強整合、実データは結果整合でよい。** この非対称が設計の核心にある。
5. **コピーは 2 段のステートマシン。** メタデータを先に書き、コピーし、メタデータを更新する。
6. **リモートのインデックスはローカルにキャッシュする。** `RemoteIndexCache`。

## ソースコードのどこか

### 責務

```java title="storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java"
/**
 * This class is responsible for
 * - initializing `RemoteStorageManager` and `RemoteLogMetadataManager` instances
 * - receives any leader and follower replica events and partition stop events and act on them
 * - also provides APIs to fetch indexes, metadata about remote log segments
 * - copying log segments to the remote storage
 * - cleaning up segments that are expired based on retention size or retention time
 */
public class RemoteLogManager implements Closeable, AsyncOffsetReader {
```

[`RemoteLogManager.java#L143-L151`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java#L143-L151)。

1 クラスで 135 KB ある。**コピー、期限切れ削除、フェッチ、インデックス取得、リーダー/フォロワーの切り替え**を全部持っている。

### プラグインの契約

```java title="storage/api/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteStorageManager.java"
/**
 * This interface provides the lifecycle of remote log segments that includes copy, fetch, and delete from remote
 * storage.
 * <p>
 * Each upload or copy of a segment is initiated with {@link RemoteLogSegmentMetadata} containing {@link RemoteLogSegmentId}
 * which is universally unique even for the same topic partition and offsets.
 * <p>
 * {@link RemoteLogSegmentMetadata} is stored in {@link RemoteLogMetadataManager} before and after copy/delete operations on
 * {@link RemoteStorageManager} with the respective {@link RemoteLogSegmentState}. {@link RemoteLogMetadataManager} is
 * responsible for storing and fetching metadata about the remote log segments in a strongly consistent manner.
 * This allows {@link RemoteStorageManager} to have eventual consistency on metadata (although the data is stored
 * in strongly consistent semantics).
 */
@InterfaceAudience.Public
public interface RemoteStorageManager extends Configurable, Closeable {
```

[`RemoteStorageManager.java#L31-L58`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/api/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteStorageManager.java#L31-L58)。

**この javadoc の後半 3 行が、この機能の設計判断そのものだ。**

- **メタデータ側 (`RemoteLogMetadataManager`) は強整合でなければならない。**
- **実データ側 (`RemoteStorageManager`) は、メタデータについて結果整合でよい。**

たとえば S3 は、かつては「PUT した直後に LIST しても見えないことがある」という性質を持っていた。**「どのセグメントが存在するか」をオブジェクトストレージの一覧 API に問い合わせる設計にしていたら、この性質に振り回される。**

だから Kafka は、**一覧を自分で持つ**。オブジェクトストレージには「この ID のオブジェクトをください」としか聞かない。ID を指定した取得なら、書いた後に読める保証がある実装が多い。**外部システムに要求する保証を、意図的に最小に絞っている。**

もう 1 つ、**セグメント ID が UUID である**点も重要だ。

```text
Each upload or copy of a segment is initiated with RemoteLogSegmentMetadata containing RemoteLogSegmentId
which is universally unique even for the same topic partition and offsets.
```

同じ `orders-0` の同じ offset 範囲でも、コピーするたびに別の UUID になる。**リーダーが 2 人いる (split brain) 状態で両方がコピーしても、オブジェクトが上書きされない。** 名前の衝突による破壊を、名前空間の設計で防いでいる。

エラーの分類も契約に含まれている。

```text
Plugin implementors of RemoteStorageManager should throw RetriableRemoteStorageException
for transient errors that can be recovered by retrying. For non-recoverable errors,
RemoteStorageException should be thrown.
```

**「リトライしていいか」をプラグイン側が判定して、例外の型で伝える。** Kafka 本体は S3 のエラーコードを知らないので、この判定を委譲するしかない。

### コピーは 2 段のステートマシン

```java title="storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogSegmentState.java"
 * |COPY_SEGMENT_STARTED |----------&gt; |COPY_SEGMENT_FINISHED |
 ...
 *                  |DELETE_SEGMENT_STARTED|
 ...
 *                  |DELETE_SEGMENT_FINISHED|
```

[`RemoteLogSegmentState.java#L38-L75`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/api/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogSegmentState.java#L38-L75)。

実際のコピー処理を見ると、この状態遷移の意味が分かる。

```java title="storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java"
RemoteLogSegmentMetadata copySegmentStartedRlsm = new RemoteLogSegmentMetadata(segmentId, segment.baseOffset(), endOffset, ...);

remoteLogMetadataManagerPlugin.get().addRemoteLogSegmentMetadata(copySegmentStartedRlsm).get();

...
LogSegmentData segmentData = new LogSegmentData(logFile.toPath(), toPathIfExists(segment.offsetIndex().file()),
        toPathIfExists(segment.timeIndex().file()), Optional.ofNullable(toPathIfExists(segment.txnIndex().file())),
        producerStateSnapshotFile.toPath(), leaderEpochsIndex);
...
try {
    customMetadata = remoteStorageManagerPlugin.get().copyLogSegmentData(copySegmentStartedRlsm, segmentData);
} catch (RetriableRemoteStorageException e) {
    logger.info("Copy failed with retriable error for segment {}", copySegmentStartedRlsm.remoteLogSegmentId());
    throw e;
} catch (RemoteStorageException e) {
    logger.info("Copy failed, cleaning segment {}", copySegmentStartedRlsm.remoteLogSegmentId());
    try {
        deleteRemoteLogSegment(copySegmentStartedRlsm, ignored -> !isCancelled());
```

[`RemoteLogManager.java#L1084-L1125`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java#L1084-L1125)。

**手順はこうだ。**

1. `COPY_SEGMENT_STARTED` のメタデータを **先に** 書く。
2. 実データをコピーする。
3. 成功したら `COPY_SEGMENT_FINISHED` に更新する。

**「先にメタデータを書く」のがポイント**で、こうすると **どこで落ちても後始末ができる**。`COPY_SEGMENT_STARTED` のまま放置されているメタデータを見つけたら、そのオブジェクトを消せばいい。

逆に、実データを先に置いてメタデータを後に書くと、**メタデータのないオブジェクトが残る**。それは誰にも参照されず、誰にも消せない。**「参照が先、実体が後」にしておくと、孤児が生まれない。**

コピーする中身にも注目したい。

```java title="storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java"
LogSegmentData segmentData = new LogSegmentData(
    logFile.toPath(),                                        // .log
    toPathIfExists(segment.offsetIndex().file()),            // .index
    toPathIfExists(segment.timeIndex().file()),              // .timeindex
    Optional.ofNullable(toPathIfExists(segment.txnIndex().file())),  // .txnindex
    producerStateSnapshotFile.toPath(),                      // .snapshot
    leaderEpochsIndex);                                      // leader epoch
```

**セグメント本体だけでなく、インデックス・[プロデューサ状態のスナップショット](../producer-state/)・[leader epoch の履歴](../leader-epoch/)も一緒に上げる。** リモートにあるセグメントから読むときも、ローカルと同じ情報が要るからだ。

[復旧のページ](../log-recovery/) で「インデックスは壊れたら作り直す」と書いたが、**リモートではそうはいかない**。作り直すにはセグメント本体をダウンロードしなければならず、それは高い。だから一緒に上げる。

### リモートのインデックスはローカルにキャッシュする

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/RemoteIndexCache.java"
/**
 * This is a LFU (Least Frequently Used) cache of remote index files stored in `$logdir/remote-log-index-cache`.
 * This is helpful to avoid re-fetching the index files like offset, time indexes from the remote storage for every
 * fetch call. The cache is re-initialized from the index files on disk on startup, if the index files are available.
 *
 * The cache contains a garbage collection thread which will delete the files for entries that have been removed from
 * the cache.
 * ...
 * Note that the cache eviction policy is based on the default implementation of Caffeine i.e.
 * Window TinyLfu. TinyLfu relies on a frequency sketch to probabilistically estimate the historic usage of an entry.
 */
public class RemoteIndexCache implements Closeable {
```

[`RemoteIndexCache.java#L62-L78`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/RemoteIndexCache.java#L62-L78)。

**キャッシュの実体はディスク上のファイル**で、`$logdir/remote-log-index-cache/` に置かれる。メモリではない。

理由は 2 つある。インデックスは [mmap して二分探索する](../sparse-index/) ものなので、ファイルとして存在していたほうが既存のコードがそのまま使える。そして **再起動してもキャッシュが残る**。

**LRU ではなく LFU (Window TinyLFU) を選んでいる**のも興味深い。リモートのインデックスへのアクセスは「たまに古いデータを読む人」が起こすので、時間的局所性が弱い。**「最近使われたか」より「よく使われるか」のほうが予測に向く**、という判断だろう。

### 期限切れ削除の分担

ローカルの削除は普通の[保持期間の処理](../log-segment/)が行い、リモートの削除は `RemoteLogManager` の別タスクが行う。設定は 2 段になっている。

| 設定                                           | 意味                                        |
| ---------------------------------------------- | ------------------------------------------- |
| `local.retention.ms` / `local.retention.bytes` | **ローカル**に置いておく量                  |
| `retention.ms` / `retention.bytes`             | **全体** (ローカル + リモート) で保持する量 |

ローカルの削除には条件が付く。**リモートへのコピーが終わっていないセグメントは、ローカルからも消せない。** 消したらデータが失われる。この判定が `UnifiedLog.deleteOldSegments` から `remoteLogEnabledAndRemoteCopyEnabled()` の分岐として出てくる。

## なぜそうなっているか

### なぜメタデータを外に出さなかったのか

「セグメントの一覧」をどこに置くかは、この機能の最大の設計判断だった。候補は 3 つある。

| 案                                | 問題                                         |
| --------------------------------- | -------------------------------------------- |
| オブジェクトストレージの LIST API | 結果整合。ページングが遅い。API コールに課金 |
| 外部のデータベース                | Kafka に新しい依存が増える。運用が増える     |
| **Kafka のトピック**              | 既存の仕組みだけで済む                       |

既定の実装は 3 番目で、`__remote_log_metadata` という内部トピックにメタデータを書く。**[この章の主題](../) がここでも出てくる** — 状態を持つ必要が出たら、トピックを 1 本増やす。

こうすると、**メタデータの永続化・複製・リーダー選出・障害復旧が全部タダ**になる。しかも「メタデータは強整合」という要求が、Kafka 自身の書き込み保証でそのまま満たせる。

**そして、インタフェースは差し替え可能にしてある。** 外部のデータベースを使いたい組織は `RemoteLogMetadataManager` を実装すればいい。既定を「自前で完結する実装」にしつつ、逃げ道を残している。

### なぜ本体に S3 のコードを入れないのか

`RemoteStorageManager` はインタフェースだけで、Apache Kafka のディストリビューションに S3 実装は含まれていない。

理由は運用と政治の両方だろう。**クラウドごとの SDK を本体に入れると、依存関係が膨れ上がる。** そして、どのクラウドを一級市民にするかという判断を Apache プロジェクトがしなくて済む。

技術的な効果もある。**インタフェースが 5 メソッドしかない**ので、契約が明確になる。`copyLogSegmentData`、`fetchLogSegment` (2 種)、`fetchIndex`、`deleteLogSegmentData`。これだけ実装すれば動く。

### 「参照が先、実体が後」の一般性

コピーで `COPY_SEGMENT_STARTED` を先に書くのは、**分散システムでオブジェクトを 2 箇所に書くときの定石**だ。

```text
[良い] メタデータ (STARTED) → 実データ → メタデータ (FINISHED)
       落ちても STARTED が残るので、後で掃除できる

[悪い] 実データ → メタデータ
       落ちるとメタデータのない実データが残り、誰にも見えず消せない
```

**「孤児のリソース」は、時間が経つほど手に負えなくなる。** 「作った覚えのないオブジェクトが S3 に 100 万個ある」という状態を避けるには、**必ず先に台帳に書く**。

削除も同じで、`DELETE_SEGMENT_STARTED` → 実データ削除 → `DELETE_SEGMENT_FINISHED` の順になる。途中で落ちても、`DELETE_SEGMENT_STARTED` のものはもう一度消せばいい (削除は冪等なので安全)。

### 外部システムに要求する保証を最小にする

この設計から読み取れるもう 1 つの原則は、**「外部システムに何を保証してもらうか」を意図的に絞ったこと**だ。

`RemoteStorageManager` に要求されているのは、実質「ID を指定して置いた/取った/消した」だけである。要求していないもの:

- 一覧の整合性 (自分で持つ)
- 上書きの原子性 (UUID なので上書きしない)
- 削除の即時性 (メタデータ側で「もう無い」と決める)
- トランザクション

**要求が少ないほど、実装できるストレージが増える。** そして、要求が少ないほど「そのストレージが本当にその保証を持つか」の検証も楽になる。

## どう活かすか

**「ローカルストレージを、直近データのキャッシュとして再定義する」という発想は、容量とコンピュートの結合を解きたいときに広く使える。** 効果はコスト削減だけではない。**ノードの追加・削除が速くなる**のが大きい。移動すべきデータが直近分だけになるからだ。同じ構図は、ステートフルなサービス全般に応用できる。

**「台帳を自分で持ち、実体ストアには ID 参照だけを要求する」は、オブジェクトストレージを使うときの基本形として持っておきたい。** LIST API に依存した設計は、整合性・性能・コストの 3 つで後から必ず問題になる。**台帳をどこに置くかは別途決める必要があるが、置く場所さえ決まれば実体ストアへの要求は最小化できる。**

**「参照を先に書く」は、2 つのストアにまたがる書き込みで常に検討する価値がある。** 分散トランザクションが使えない状況で、**中間状態を「後から掃除できる形」に倒す**方法だ。逆順にすると孤児が生まれ、孤児は「消していいか判断できない」ので永久に残る。**どちらの順序でも中間状態は生まれる。生まれる中間状態が掃除可能かどうかで選ぶ。**

**「オブジェクト名を UUID にして上書きを起こさない」も同じ系統の判断だ。** 決定的な名前 (トピック名 + offset) にしたくなるが、それだと split brain のときに 2 人が同じ名前に書く。**名前が衝突しなければ、衝突の解決を考えなくていい。** 余分なオブジェクトは台帳を見て掃除すればよく、これは壊れたデータより扱いやすい。

**取り込むべきでない条件は、レイテンシの要求が厳しい読み取りだ。** リモートからの読み出しは、ローカルディスクより 2〜3 桁遅い。Kafka がこれを許容できるのは、**古いデータを読むのが例外的だから**である。アクセスが一様に分布するデータでは、この階層化は単に遅くなるだけになる。
