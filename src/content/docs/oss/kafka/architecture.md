---
title: "Kafka のアーキテクチャを一枚で読む"
description: "Kafka の中心にあるのは、ディスク上の追記専用ファイルの列だ。topic・partition・offset・replica・consumer group・controller という語彙は、すべてこのファイルの上に定義されている。この章の他のページが前提にする語彙と、ブローカープロセスの中身を、ここで先に導入する。"
sidebar:
  order: 1
---

## Kafka は何なのか

Kafka を「メッセージキュー」と紹介されると、たいてい最初につまずく。キューだとすると、次のような疑問が出てくるからだ。

- 読んだメッセージはなぜ消えないのか
- なぜ「何番目まで読んだか」を自分で覚えないといけないのか
- なぜ同じデータを 2 つのアプリが別々に読めるのか

答えは単純で、**Kafka はキューではなくファイルだから**だ。より正確には、**追記しかできないファイルを、ネットワーク越しに配るサーバ**である。

```text
producer                      broker のディスク                    consumer
   │                    ┌────────────────────────────┐                │
   └── append ────────► │ rec rec rec rec rec rec ... │ ◄── read ─────┘
                        └────────────────────────────┘
                          0   1   2   3   4   5   ← offset
```

- **書き込みは末尾への追記だけ。** 途中の更新も削除もない。
- **読み込みは「何番目から」の指定。** 読んでもデータは動かない。
- **「何番目まで読んだか」は読み手の持ち物。** サーバは覚えていない (覚えさせることもできるが、それも後述するように単なる別のファイルへの追記だ)。

この 3 点だけで、Kafka の挙動のかなりの部分が説明できる。複数のアプリが同じデータを独立に読めるのは、それぞれが自分の位置を持っているからだ。障害から復旧したアプリが読み直せるのも、データがまだそこにあるからだ。

**そして、この「追記専用ファイル」という道具を、Kafka は自分自身にも使う。** コンシューマの進捗も、クラスタの構成情報も、トランザクションの状態も、全部どこかのファイルへの追記として表現されている。これがこの章を通じた中心命題になる。

## ディスクの上の実物を見る

抽象的な話を続ける前に、ブローカーのデータディレクトリに実際に何があるかを見ておく。ファイル名の規則は [`LogFileUtils.java#L27-L67`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogFileUtils.java#L27-L67) に定数として並んでいる。

```text
/var/lib/kafka/data/           ← log.dirs
├── orders-0/                  ← トピック "orders" のパーティション 0
│   ├── 00000000000000000000.log        ← セグメント本体 (レコードが並ぶ)
│   ├── 00000000000000000000.index      ← オフセット → ファイル位置の疎インデックス
│   ├── 00000000000000000000.timeindex  ← 時刻 → オフセットの疎インデックス
│   ├── 00000000000000014327.log        ← 次のセグメント (先頭 offset がファイル名)
│   ├── 00000000000000014327.index
│   ├── 00000000000000014327.timeindex
│   ├── 00000000000000014327.snapshot   ← プロデューサ状態のスナップショット
│   └── leader-epoch-checkpoint         ← リーダー交代の履歴
├── orders-1/
├── __consumer_offsets-0/
└── __cluster_metadata-0/
```

見どころは 3 つある。

1. **ディレクトリが `トピック名-パーティション番号` になっている。** Kafka の物理的な単位はトピックではなくパーティションだ。
2. **ファイル名が「そのファイルの先頭レコードの offset」になっている。** offset からファイルを引くのに、ディレクトリを舐める以外の索引が要らない。
3. **`__consumer_offsets` と `__cluster_metadata` が、普通のトピックと同じ形で並んでいる。** Kafka の内部状態が、Kafka のデータ構造で保存されている。

## 語彙

### topic と partition

**トピック**は名前空間でしかない。実体は **パーティション**で、1 パーティション = 1 本のログ (上の `orders-0/`) だ。

トピックを複数パーティションに割るのは、**1 本のログの書き込みが 1 台のブローカーのディスクに縛られる**からだ。並列度を上げたければパーティションを増やす。代償として、**順序保証はパーティション内でしか成立しない**。トピック全体で順序を守りたければ、パーティションを 1 個にするしかない。

### offset

パーティション内でレコードに振られる 0 から始まる連番。**グローバルな ID ではなく、パーティションの中でだけ意味を持つ**。

「offset 100 を読む」は「このパーティションの 101 番目のレコード以降を読む」であり、常に O(1) 近くで解決される。ファイル名で当たりを付け、`.index` で近傍を引き、そこから走査するだけだ ([疎インデックスのページ](../sparse-index/))。

### segment

ログは 1 個の巨大ファイルではなく、**セグメント**というファイルの列だ。末尾のセグメントだけが書き込み可能で、これを **アクティブセグメント**と呼ぶ。

分けるのは削除のためだ。「古いレコードを消す」を「先頭のファイルを `unlink` する」に落とせる。ファイルの途中を削るコストがかからない ([セグメントのページ](../log-segment/))。

### 4 つの offset

1 つのパーティションには、意味の違う offset が同時に何本も立っている。この章では繰り返し出てくるので、ここで並べておく。

| 名前                         | 意味                                                                                  | 誰が動かすか                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| **log start offset**         | まだ残っている最古のレコード                                                          | 保持期間による削除、階層型ストレージへの移動 |
| **high watermark (HW)**      | **全レプリカが持っていることが確認済み**の位置。コンシューマはここまでしか読めない    | リーダーがフォロワーの進捗を見て進める       |
| **log end offset (LEO)**     | このレプリカが持っている末尾。次に書かれるレコードの offset                           | 追記のたびに進む                             |
| **last stable offset (LSO)** | 未確定のトランザクションが始まる手前の位置。`read_committed` のコンシューマはここまで | トランザクションのコミット/中断              |

`log start offset ≤ HW ≤ LEO` が常に成り立ち、`LSO ≤ HW` になる。**「書かれた」と「読める」の間に距離がある**というのが、Kafka の一貫性モデルの核心だ ([ISR と high watermark のページ](../isr-highwatermark/))。

### replica、leader、follower、ISR

各パーティションは `replication.factor` 個のコピー (**レプリカ**) を別々のブローカーに持つ。

- そのうち 1 つが **リーダー**で、読み書きは全部ここを通る。
- 残りは **フォロワー**で、リーダーから **自分で取りに行って** コピーを作る ([pull 型レプリケーションのページ](../pull-replication/))。
- 十分に追いついているレプリカの集合を **ISR** (in-sync replicas) と呼ぶ。

`acks=all` の書き込みは「ISR 全員がコピーし終わるまで応答しない」を意味する。ISR に何人いれば書き込みを受け付けるかは `min.insync.replicas` で決まる。

### producer、consumer、consumer group

- **プロデューサ**はレコードを送る。どのパーティションに入れるかは **クライアント側が決める** ([パーティショナのページ](../sticky-partitioner/))。
- **コンシューマ**はレコードを読む。
- **コンシューマグループ**は、同じ `group.id` を持つコンシューマの集まり。**1 パーティションはグループ内の 1 人だけが読む**という規則があり、これで負荷分散と重複排除が同時に成立する。

グループのメンバが増減すると、パーティションの担当を割り当て直す。これが **リバランス**だ ([リバランスプロトコルのページ](../rebalance-protocol/))。

グループの進捗 (どこまで処理したか) は `__consumer_offsets` トピックに追記される。**「進捗の保存」もまたログへの追記である**。

### broker と controller

**ブローカー**はデータを持つプロセス。**コントローラ**はクラスタの構成 (どのトピックがあり、どのパーティションのリーダーが誰か) を決めるプロセスだ。

4.0 以降、コントローラは **KRaft** — Kafka 自身の Raft 実装 — で選ばれた少数のノードの集まりになった。ZooKeeper は完全に消えている ([KRaft のページ](../kraft-overview/))。

## 内部トピック — 中心命題の実物

`Topic.java` に、Kafka が自分のために使うトピックが並んでいる。

```java title="clients/src/main/java/org/apache/kafka/common/internals/Topic.java"
public static final String GROUP_METADATA_TOPIC_NAME = "__consumer_offsets";
public static final String TRANSACTION_STATE_TOPIC_NAME = "__transaction_state";
public static final String SHARE_GROUP_STATE_TOPIC_NAME = "__share_group_state";
public static final String CLUSTER_METADATA_TOPIC_NAME = "__cluster_metadata";
```

[`Topic.java#L25-L37`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/internals/Topic.java#L25-L37)。

| トピック              | 何を保存しているか                                                          | 参照ページ                                        |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| `__consumer_offsets`  | コンシューマグループのメンバ構成と、コミットされた offset                   | [コーディネータのページ](../coordinator-runtime/) |
| `__transaction_state` | トランザクションの状態 (進行中・準備完了・コミット済み)                     | [トランザクションのページ](../transactions-eos/)  |
| `__share_group_state` | 共有グループのレコード単位の取得状態                                        | [共有グループのページ](../share-groups/)          |
| `__cluster_metadata`  | クラスタ構成そのもの。トピック一覧、レプリカ配置、ブローカー登録、設定、ACL | [KRaft のページ](../kraft-overview/)              |

**この 4 行が、この章のあらすじだと言ってもいい。** 状態を持つ必要が出るたびに、Kafka は新しいストアを導入するのではなく、トピックを 1 本増やしている。

こうすると、状態の保存に必要なもの — 永続化、レプリケーション、リーダー選出、障害復旧 — が全部タダで手に入る。すでにログのために作ったものだからだ。代わりに、**状態を読むには最初からログを再生しなければならない**という制約が生まれ、その制約への対処 ([スナップショット](../metadata-snapshot/)、[イメージと差分](../metadata-image-delta/)、[コーディネータのロード](../coordinator-runtime/)) がコードのあちこちに現れる。

## ブローカープロセスの中身

`BrokerServer` が持っているフィールドを眺めると、ブローカーが何でできているかがそのまま分かる。

```scala title="core/src/main/scala/kafka/server/BrokerServer.scala"
@volatile var dataPlaneRequestProcessor: KafkaApis = _
@volatile var socketServer: SocketServer = _
var dataPlaneRequestHandlerPool: KafkaRequestHandlerPool = _
var logDirFailureChannel: LogDirFailureChannel = _
var logManager: JLogManager = _
var remoteLogManagerOpt: Option[RemoteLogManager] = None
...
@volatile private[this] var _replicaManager: ReplicaManager = _
...
@volatile var groupCoordinator: GroupCoordinator = _
var transactionCoordinator: TransactionCoordinator = _
var shareCoordinator: ShareCoordinator = _
...
@volatile var metadataCache: KRaftMetadataCache = _
var quotaManagers: QuotaFactory.QuotaManagers = _
```

[`BrokerServer.scala#L112-L181`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/BrokerServer.scala#L112-L181)。

層に並べ直すとこうなる。

```text
       ┌─────────────────────────────────────────────────────────┐
       │ SocketServer      受付・読み書き (Acceptor / Processor)  │
       ├─────────────────────────────────────────────────────────┤
       │ KafkaRequestHandlerPool → KafkaApis   81 種の RPC を分岐 │
       ├──────────────┬──────────────┬───────────────────────────┤
       │ ReplicaManager│ Coordinators │ MetadataCache             │
       │ (読み書きと   │ (group /     │ (コントローラが配る       │
       │  レプリカ管理)│  txn / share)│  構成のローカルコピー)     │
       ├──────────────┴──────────────┴───────────────────────────┤
       │ LogManager → UnifiedLog → LocalLog → LogSegment          │
       │                        └→ RemoteLogManager (階層型)      │
       └─────────────────────────────────────────────────────────┘
```

`SocketServer` のスレッドモデルは、クラスのコメントにそのまま書いてある。

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
 *      1 Acceptor thread per listener, that handles new connections.
 *      It is possible to configure multiple data-planes by specifying multiple "," separated endpoints for "listeners" in KafkaConfig.
 *      Acceptor has N Processor threads that each have their own selector and read requests from sockets
 *      M Handler threads that handle requests and produce responses back to the processor threads for writing.
```

[`SocketServer.scala#L60-L70`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L60-L70)。**1 : N : M の 3 段構え**で、受付と I/O と処理をそれぞれ別のスレッドに分けている ([SocketServer のページ](../socket-server/))。

`UnifiedLog` の javadoc は、階層型ストレージが入った後のログの姿を説明している。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java"
/**
 * A log which presents a unified view of local and tiered log segments.
 *
 * <p>The log consists of tiered and local segments with the tiered portion of the log being optional. There could be an
 * overlap between the tiered and local segments. The active segment is always guaranteed to be local. If tiered segments
 * are present, they always appear at the beginning of the log, followed by an optional region of overlap, followed by the local
 * segments including the active segment.
```

[`UnifiedLog.java#L94-L105`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java#L94-L105)。**「ローカルのログ」と「リモートのログ」を 1 本に見せる**のが `UnifiedLog` の仕事で、ローカルだけを見るのが `LocalLog` だ ([階層型ストレージのページ](../tiered-storage/))。

## リクエストが 1 本通る道筋

`produce` (書き込み) が `acks=all` で来たときに、何が起きるか。

```text
1. Acceptor          新しい TCP 接続を受け、Processor に割り振る
2. Processor         nio Selector でバイト列を読み、リクエストに組み立てる
                     → RequestChannel のキューに置き、そのチャネルを mute する
3. KafkaRequestHandler  キューから取り出し、KafkaApis.handle を呼ぶ
4. KafkaApis         ApiKeys.PRODUCE で分岐 → handleProduceRequest
5. ReplicaManager    appendRecords → 各パーティションのリーダーに追記
6. Partition         appendRecordsToLeader → UnifiedLog.appendAsLeader
7. UnifiedLog        アクティブセグメントのファイルに追記 (fsync はしない)
8. ── ここで応答を返さない ──
                     acks=all なので DelayedProduce を purgatory に預ける
9. (別のスレッド)    フォロワーが Fetch してきて、HW が要求 offset を超える
                     → purgatory が DelayedProduce を完成させる
10. RequestChannel   応答を Processor のキューに積み、チャネルの mute を解く
11. Processor        ソケットに書き出す
```

`KafkaApis.handle` は 81 個の `case` を持つ巨大な `match` で、これが Kafka のブローカーが受け付ける RPC の全リストになっている。

```scala title="core/src/main/scala/kafka/server/KafkaApis.scala"
case ApiKeys.PRODUCE => handleProduceRequest(request, requestLocal)
case ApiKeys.FETCH => handleFetchRequest(request)
case ApiKeys.LIST_OFFSETS => handleListOffsetRequest(request)
case ApiKeys.METADATA => handleTopicMetadataRequest(request)
...
case ApiKeys.CREATE_TOPICS => forwardToController(request)
case ApiKeys.DELETE_TOPICS => forwardToController(request)
```

[`KafkaApis.scala#L175-L204`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/KafkaApis.scala#L175-L204)。

この抜粋の後半に注目したい。**トピックの作成・削除といった「構成を変える」リクエストは、ブローカーが処理せずにコントローラへ転送される** (`forwardToController`)。データプレーンとコントロールプレーンの境界が、この `match` の中に線として引かれている。

そして 8 番の「ここで応答を返さない」が、Kafka のリクエスト処理の特徴だ。**ハンドラスレッドは待たない。** 待つべきリクエストは purgatory に預けられ、ハンドラスレッドは次のリクエストへ行く ([purgatory のページ](../purgatory/))。同じ仕掛けが、`fetch.min.bytes` で待つコンシューマの Fetch にも使われている。

## モジュールの地図

Gradle のモジュールと責務の対応。この章のページがどこを読んでいるかの索引になる。

| モジュール            | 行数 (本体)  | 何が入っているか                                                                                            |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `clients/`            | 約 20.5 万行 | プロデューサ、コンシューマ、Admin、プロトコル、レコード形式、nio ネットワーク層。**サーバもこれに依存する** |
| `core/`               | 約 3.5 万行  | ブローカー本体。`KafkaApis`、`ReplicaManager`、`Partition`、`SocketServer`。**残った Scala はほぼここ**     |
| `storage/`            | 約 3.1 万行  | ログ、セグメント、インデックス、圧縮、階層型ストレージ                                                      |
| `raft/`               | 約 2.5 万行  | KRaft の Raft 実装 (`KafkaRaftClient` だけで 170KB)                                                         |
| `metadata/`           | 約 3.2 万行  | コントローラ (`QuorumController`)、メタデータのイメージと差分                                               |
| `group-coordinator/`  | 約 4.4 万行  | コンシューマグループ、共有グループ、Streams グループの協調                                                  |
| `coordinator-common/` | 約 0.8 万行  | コーディネータ共通の実行基盤 (`CoordinatorRuntime`)                                                         |
| `server-common/`      | 約 2.0 万行  | purgatory、タイマー、イベントキュー、timeline データ構造                                                    |
| `server/`             | 約 2.4 万行  | クォータ、認可、ブローカー寄りの共通部品                                                                    |
| `generator/`          | 約 0.8 万行  | JSON スキーマから Java を生成するコンパイラ                                                                 |

`clients/` が最大なのは意外に見えるが、**プロトコルの定義とレコード形式がここにあり、ブローカーもそれを使う**ためだ。「クライアントライブラリ」というより「Kafka のプロトコル実装」に近い。

## この章の読み方

ここまでの語彙が入っていれば、以降のページはどこからでも読める。ただし、**「ストレージ」の群は他のほぼ全ページの前提**になる。レプリケーションもコントロールプレーンもコーディネータも、結局は「ログに書いて、それを配る」の変奏だからだ。

次の [プロトコル生成のページ](../protocol-codegen/) では、ここで出てきた `ApiKeys.PRODUCE` のような RPC が、コードではなく JSON スキーマから生成されていることを見る。
