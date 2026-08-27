---
title: "メタデータログのスナップショットは、状態そのものになる"
description: "変更の履歴だけを持つと、ログは無限に伸びる。KRaft のスナップショットは「その時点の状態を、同じレコード形式で書き直したもの」で、ログの先頭を置き換える。追いつけないフォロワーはログではなくスナップショットを受け取る。ファイル名に offset と epoch を刻むことで、どのスナップショットがどこまでを含むかが名前だけで分かる。"
sidebar:
  order: 17
---

## 何を学んだか

### どんな状況の話か

[KRaft のページ](../kraft-overview/) で見たとおり、クラスタの構成は `__cluster_metadata` に **変更の履歴**として書かれる。「トピックを作った」「ISR が変わった」の列だ。

この方式には、放っておくと成立しない点がある。

- **ログが無限に伸びる。** ISR が 1 日に何万回変われば、その全部が残る。
- **状態を知るには先頭から全部読む必要がある。** 起動のたびに 10 GB のログを再生することになる。
- **古いログを消せない。** 消したら状態が再構成できなくなる。**通常のトピックのように「保持期間で消す」ができない。**

### Kafka の答え

**「その時点の状態」を、同じレコード形式で書き直したファイルを作る。それをスナップショットと呼び、ログの先頭を置き換える。**

1. **スナップショットの中身は、状態を表すレコードの列。** 「トピック A が存在する」「パーティション 0 のリーダーは 3」といった、現在を表す `TopicRecord` / `PartitionRecord` が並ぶ。
2. **ファイル名が `<offset>-<epoch>.checkpoint`。** 「この offset までの内容を含む」が名前から分かる。
3. **スナップショットより前のログは削除できる。**
4. **遅れすぎたフォロワーには、ログではなくスナップショットを送る。** `FetchSnapshot` という専用の RPC がある。
5. **生成の契機は「バイト数」と「経過時間」の 2 つ。**

## ソースコードのどこか

### ファイル名が索引になる

```java title="raft/src/main/java/org/apache/kafka/snapshot/Snapshots.java"
public static final String SUFFIX = ".checkpoint";
private static final String PARTIAL_SUFFIX = String.format("%s.part", SUFFIX);
public static final String DELETE_SUFFIX = String.format("%s.deleted", SUFFIX);

private static final NumberFormat OFFSET_FORMATTER = NumberFormat.getInstance();
private static final NumberFormat EPOCH_FORMATTER = NumberFormat.getInstance();

private static final int OFFSET_WIDTH = 20;
private static final int EPOCH_WIDTH = 10;
```

```java title="raft/src/main/java/org/apache/kafka/snapshot/Snapshots.java"
public static String filenameFromSnapshotId(OffsetAndEpoch snapshotId) {
    return String.format("%s-%s", OFFSET_FORMATTER.format(snapshotId.offset()), EPOCH_FORMATTER.format(snapshotId.epoch()));
}
```

[`Snapshots.java#L38-L64`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/snapshot/Snapshots.java#L38-L64)。

**ゼロ埋め 20 桁の offset とゼロ埋め 10 桁の epoch。** [セグメントのファイル名](../log-segment/) と同じ発想で、文字列順が数値順と一致する。

```text
__cluster_metadata-0/
├── 00000000000000012345-0000000042.checkpoint       ← 完成したスナップショット
├── 00000000000000012345-0000000042.checkpoint.part  ← 書きかけ
└── 00000000000000009999-0000000041.checkpoint.deleted ← 削除待ち
```

**epoch も名前に含まれる**のが重要だ。同じ offset で違う内容のスナップショットが生まれることは、リーダーが交代すればありうる。offset だけでは一意にならない。

そして 3 つの接尾辞が状態を表す。**書きかけは `.part`、削除待ちは `.deleted`。** これも[セグメントの管理](../log-segment/)と同じで、**中間状態をファイル名にエンコードしている。**

### 書き込みはテンポラリファイルから

```java title="raft/src/main/java/org/apache/kafka/snapshot/Snapshots.java"
public static Path createTempFile(Path logDir, OffsetAndEpoch snapshotId) {
    Path dir = snapshotDir(logDir);

    try {
        // Create the snapshot directory if it doesn't exist
        Files.createDirectories(dir);
        String prefix = String.format("%s-", filenameFromSnapshotId(snapshotId));
        return Files.createTempFile(dir, prefix, PARTIAL_SUFFIX);
```

[`Snapshots.java#L78-L91`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/snapshot/Snapshots.java#L78-L91)。

書きかけは `.checkpoint.part` として作られ、完成したらリネームする。**起動時に `.part` が残っていたら、それは書き終わらなかったものなので削除する。**

```java title="raft/src/main/java/org/apache/kafka/snapshot/Snapshots.java"
boolean partial = false;
boolean deleted = false;
if (name.endsWith(PARTIAL_SUFFIX)) {
    partial = true;
} else if (name.endsWith(DELETE_SUFFIX)) {
    deleted = true;
} else if (!name.endsWith(SUFFIX)) {
    return Optional.empty();
}
```

[`Snapshots.java#L100-L110`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/snapshot/Snapshots.java#L100-L110)。

**ファイル名をパースするだけで、そのファイルが何なのかが決まる。** ディレクトリを読んで名前を見れば、起動時の後始末が全部決まる。

### スナップショットの中身

```java title="metadata/src/main/java/org/apache/kafka/image/publisher/SnapshotEmitter.java"
public void maybeEmit(MetadataImage image) {
    MetadataProvenance provenance = image.provenance();
    Optional<SnapshotWriter<ApiMessageAndVersion>> snapshotWriter = raftClient.createSnapshot(
        provenance.snapshotId(),
        provenance.lastContainedLogTimeMs()
    );
    if (snapshotWriter.isEmpty()) {
        log.error("Not generating {} because it already exists.", provenance.snapshotName());
        return;
    }
    RaftSnapshotWriter writer = new RaftSnapshotWriter(snapshotWriter.get(), batchSize);
    try {
        image.write(writer, new ImageWriterOptions.Builder(image.features().metadataVersionOrThrow()).
                setEligibleLeaderReplicasEnabled(image.features().isElrEnabled()).
                build());
        writer.close(true);
```

[`SnapshotEmitter.java#L137-L162`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/publisher/SnapshotEmitter.java#L137-L162)。

**`image.write(writer, ...)` の 1 行が本体だ。** `MetadataImage` は「ログを畳んだ結果の状態」([次のページ](../metadata-image-delta/)) で、それを **レコードの列として書き出す**。

つまり、**スナップショットは「状態をレコード形式にシリアライズしたもの」であり、形式的にはログの一部と区別が付かない**。読み手は「ログを読む」のと同じコードでスナップショットを読める。

`ImageWriterOptions` に `MetadataVersion` を渡しているのが重要で、**古い `MetadataVersion` のクラスタ向けには、新しいフィールドを含まないレコードを書く**。[プロトコル生成のページ](../protocol-codegen/) で見たバージョン管理が、ここでも効いている。

`SnapshotHeaderRecord` と `SnapshotFooterRecord` という制御レコードが前後に付く。

```java title="raft/src/main/java/org/apache/kafka/snapshot/RecordsSnapshotWriter.java"
/**
 * Adds a {@link SnapshotFooterRecord} to the snapshot
 */
```

[`RecordsSnapshotWriter.java#L68-L78`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/snapshot/RecordsSnapshotWriter.java#L68-L78)。

**フッタがあることで「最後まで書けている」が確認できる。** `.part` からのリネームと二重の保護になっている。

### 生成の契機

```java title="metadata/src/main/java/org/apache/kafka/image/publisher/SnapshotGenerator.java"
/**
 * A metadata publisher that generates snapshots when appropriate.
 */
public class SnapshotGenerator implements MetadataPublisher {
    ...
    private long maxBytesSinceLastSnapshot = 100 * 1024 * 1024L;
    private long maxTimeSinceLastSnapshotNs = TimeUnit.DAYS.toNanos(1);
```

[`SnapshotGenerator.java#L36-L46`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/image/publisher/SnapshotGenerator.java#L36-L46)。

実際に使われる既定値は設定側にある。

```java title="raft/src/main/java/org/apache/kafka/raft/MetadataLogConfig.java"
public static final String METADATA_SNAPSHOT_MAX_INTERVAL_MS_CONFIG = "metadata.log.max.snapshot.interval.ms";
public static final long METADATA_SNAPSHOT_MAX_INTERVAL_MS_DEFAULT = TimeUnit.HOURS.toMillis(1);
public static final String METADATA_SNAPSHOT_MAX_NEW_RECORD_BYTES_CONFIG = "metadata.log.max.record.bytes.between.snapshots";
public static final int METADATA_SNAPSHOT_MAX_NEW_RECORD_BYTES = 20 * 1024 * 1024;
```

[`MetadataLogConfig.java#L38-L41`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/MetadataLogConfig.java#L38-L41)。

**「前回のスナップショットから 20 MB 書かれたら」または「1 時間経ったら」。** 2 つの契機を持つのは、変更が多いクラスタと少ないクラスタの両方に対応するためだ。

- 変更が多い → バイト数で先に発火し、ログが伸びすぎない。
- 変更が少ない → 時間で発火し、古いログをいつまでも持たない。

**`SnapshotGenerator` が `MetadataPublisher` を実装している**のも見どころだ。スナップショットの生成が、[メタデータの購読者](../metadata-image-delta/)の 1 つとして実装されている。**「新しいイメージが公開されたら、必要ならスナップショットを書く」** という形になっていて、専用のスケジューラを持たない。

### 遅れすぎたフォロワーへの対応

[Raft 実装のページ](../raft-implementation/) で見た 5 番目の RPC が、ここで使われる。

```java title="raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java"
 * 5) {@link FetchSnapshotRequestData}: Sent by the follower to the epoch leader in order to fetch a snapshot.
 *    This happens when a FetchResponse includes a snapshot ID due to the follower's log end offset being less
 *    than the leader's log start offset. This API is similar to the Fetch API since the snapshot is stored
 *    as FileRecords, but we use {@link UnalignedRecords} in FetchSnapshotResponse because the records
 *    are not necessarily offset-aligned.
```

[`KafkaRaftClient.java#L162-L167`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java#L162-L167)。

**フォロワーが要求した offset が、リーダーの log start offset より前だったら**、リーダーは「そこはもう無い。代わりにこのスナップショットを取ってくれ」と応答する。

**スナップショットも `FileRecords` として保存されている**ので、[ゼロコピー](../zero-copy/)で転送できる。ただし `UnalignedRecords` を使う — スナップショットのバイト範囲は offset の境界に揃っていないからだ。**転送の仕組みは再利用しつつ、offset の意味だけを外している。**

## なぜそうなっているか

### スナップショットが「レコードの列」である意味

素直な設計なら、スナップショットは状態のダンプ (JSON や独自形式) になる。Kafka はそうせず、**ログと同じレコード形式**にした。

得られるものが 3 つある。

- **読み手のコードが 1 つで済む。** スナップショットを読むのも、ログを読むのも「レコードを順に適用する」。
- **[プロトコルのバージョン管理](../protocol-codegen/)がそのまま効く。** レコードにバージョンがあるので、古いソフトウェアが読める形式で書ける。
- **転送に既存の仕組みが使える。** `FileRecords` なのでゼロコピーで送れる。

**「スナップショット = 状態を作るのに必要な最小のレコード列」** と定義すると、ログとスナップショットの境界がほぼ消える。実際、フォロワーの処理は「スナップショットを読んでから、その続きのログを読む」という単純な形になる。

### なぜ epoch もファイル名に含めるのか

offset だけでは一意にならない。次のシナリオがある。

1. リーダー A (epoch 5) が offset 1000 まで書いた。
2. A がスナップショットを作ろうとしたが、その前に落ちた。
3. B (epoch 6) がリーダーになり、offset 1000 のあたりを[切り詰めて](../leader-epoch/)書き直した。
4. A が復帰して、offset 1000 のスナップショットを見つける。

**「offset 1000 の状態」が 2 つある。** epoch を付けると `00000000000000001000-0000000005.checkpoint` と `...-0000000006.checkpoint` になり、区別できる。

**[leader epoch](../leader-epoch/) と同じ理屈** — 位置だけでは一意にならないので、世代を添える。

### なぜ「バイト数」と「時間」の 2 つで発火するのか

どちらか一方だと、片方の極端なケースで破綻する。

|                      | バイト数だけ                           | 時間だけ                                     |
| -------------------- | -------------------------------------- | -------------------------------------------- |
| 変更が多いクラスタ   | 適切に発火                             | **スナップショット間隔中にログが膨大になる** |
| 変更が少ないクラスタ | **いつまでも発火せず、古いログが残る** | 適切に発火                                   |

**「どちらかが閾値に達したら」という OR は、負荷の幅が広いシステムで定番の形だ。** [セグメントのロール条件](../log-segment/) も同じで、`segment.bytes` と `segment.ms` の OR になっている。

### なぜ MetadataPublisher として実装したのか

スナップショットの生成を、専用のバックグラウンドスレッドでやることもできた。そうしなかった理由は、**「どの時点の状態か」を正確に決める必要がある**からだ。

別スレッドでやると、書いている最中に状態が変わる。ロックを取るか、状態のコピーを取るかが必要になる。

**`MetadataPublisher` として実装すると、「公開されたイメージ」を受け取る。** イメージは不変なので、書いている間に変わらない。ロックが要らない。

**不変なスナップショットを持つ構造 ([次のページ](../metadata-image-delta/)) が、この単純さを支えている。**

### 通常のトピックとの違い

`__cluster_metadata` は、通常のトピックの保持ポリシーとは違う扱いになる。

|                      | 通常のトピック                             | `__cluster_metadata`                      |
| -------------------- | ------------------------------------------ | ----------------------------------------- |
| 古いデータを消す条件 | 時間 / サイズ                              | **スナップショットに含まれたら**          |
| 圧縮                 | [キーごとに最新を残す](../log-compaction/) | **スナップショットで置き換える**          |
| 消えると             | データが失われる (承知の上)                | **状態が再構成できなくなる (許されない)** |

**log compaction とスナップショットは、どちらも「履歴を畳んで現在だけを残す」処理だ。** 違いは畳み方で、compaction が「キーごとに最新のレコードを残す」のに対し、スナップショットは「状態から新しいレコード列を生成する」。

後者のほうが強い。**compaction では表現できない畳み方ができる**からだ。たとえば「作成して削除されたトピック」は、compaction だと `TopicRecord` と `RemoveTopicRecord` の両方が残りうる (キーが違う) が、スナップショットなら 1 件も出力しないだけで済む。

## どう活かすか

**「変更の履歴を保存する設計には、必ず畳み込みの仕組みが要る」** — イベントソーシングやログ構造のシステムを作るなら、最初から考えておく必要がある。**後付けは難しい。** 「どの時点の状態か」を正確に特定する仕組み (Kafka の場合は不変なイメージと offset) が、畳み込みの前提になるからだ。

**スナップショットの形式を、ログと同じレコード形式にする判断は真似する価値が高い。** 別形式にすると、読み手・バージョン管理・転送がそれぞれ二重になる。**同じ形式なら「スナップショットは、状態を作るのに必要な最小のログ」という一言で説明でき、実装もそれに従う。** 制約は「状態がレコード列として表現できること」で、これは元々ログで表現していたのだから必ず成立する。

**「ファイル名に、内容を特定する識別子を全部入れる」も強い。** `<offset>-<epoch>.checkpoint` は、位置と世代の両方を持つ。**別のメタデータファイルを引かずに、ディレクトリを読むだけで全部分かる。** 起動時の後始末が `listFiles()` + 名前のパースで完結するのは、この設計の直接の結果だ。

**「複数の契機の OR で発火させる」は、負荷の幅が広いバックグラウンド処理の定石として持っておきたい。** 単一の閾値は、必ずどちらかの極端で破綻する。**「量」と「時間」は独立な軸なので、両方持つと両端が塞がる。**

**そして、「不変なスナップショットを受け取る形にすると、並行制御が消える」という点も見ておきたい。** `SnapshotGenerator` がロックを持たずに書けるのは、渡されるイメージが不変だからだ。**不変オブジェクトのコストは、こういう場所で回収される。**
