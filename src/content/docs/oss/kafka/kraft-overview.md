---
title: "ZooKeeper を捨て、クラスタの状態を 1 本のトピックにする"
description: "4.0 で ZooKeeper が完全に消えた。代わりにクラスタ構成は __cluster_metadata という 1 パーティションのトピックに書かれ、コントローラはそのログのリーダーになる。「外部のストアに現在の状態を置く」から「自分のログに変更の履歴を書く」への転換で、状態の配り方も障害時の挙動も全部変わっている。"
group: "コントロールプレーン"
sidebar:
  order: 15
---

## 何を学んだか

### どんな状況の話か

Kafka は 2011 年から 2024 年まで、クラスタの構成情報を ZooKeeper に置いていた。

- どのトピックが存在するか
- 各パーティションのレプリカ配置、リーダー、ISR
- ブローカーの登録情報
- 設定、ACL、クォータ

コントローラ (ブローカーの 1 台が兼任) が ZooKeeper を watch し、変更があると全ブローカーに `LeaderAndIsr` / `UpdateMetadata` という RPC で通知していた。

この構成には、規模が大きくなると効いてくる問題がいくつもあった。

- **コントローラのフェイルオーバーが遅い。** 新しいコントローラは ZooKeeper から全メタデータを読み直す。パーティションが 10 万個あると数分かかる。
- **状態の配布が「現在の状態の全体」を送る形。** 差分ではないので、1 パーティションの変更でも大きな RPC が飛ぶ。
- **ZooKeeper とブローカーで二重に状態を持つ。** 食い違いうる。
- **運用するミドルウェアが 2 つになる。** 設定も監視もバックアップも 2 系統。

### Kafka の答え

**クラスタの構成を、Kafka 自身のログに書く。**

1. **`__cluster_metadata` という 1 パーティションのトピックを作る。** レコードは「トピックが作られた」「ISR が変わった」といった **変更の記録**だ。
2. **このトピックのレプリケーションだけは Raft を使う。** 通常のパーティションの [ISR 方式](../isr-highwatermark/) ではない。
3. **コントローラは、このログのリーダーになったノード**である。選出は Raft のリーダー選出そのもの。
4. **ブローカーはこのログの読み手になる。** リーダーから fetch して、自分のメタデータキャッシュを更新する。
5. **プロセスの役割は設定で決まる。** `process.roles=broker`、`controller`、または両方。

## ソースコードのどこか

### プロセスの構造

```scala title="core/src/main/scala/kafka/server/KafkaRaftServer.scala"
/**
 * This class implements the KRaft (Kafka Raft) mode server which relies
 * on a KRaft quorum for maintaining cluster metadata. It is responsible for
 * constructing the controller and/or broker based on the `process.roles`
 * configuration and for managing their basic lifecycle (startup and shutdown).
 */
class KafkaRaftServer(
```

```scala title="core/src/main/scala/kafka/server/KafkaRaftServer.scala"
private val broker: Option[BrokerServer] = if (config.processRoles.contains(ProcessRole.BrokerRole)) {
  Some(new BrokerServer(sharedServer))
} else {
  None
}

private val controller: Option[ControllerServer] = if (config.processRoles.contains(ProcessRole.ControllerRole)) {
  Some(new ControllerServer(
    sharedServer,
    KafkaRaftServer.configSchema,
    bootstrapMetadata,
  ))
} else {
  None
}
```

[`KafkaRaftServer.scala#L42-L90`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/KafkaRaftServer.scala#L42-L90)。

**1 プロセスの中に `BrokerServer` と `ControllerServer` が両方入りうる。** どちらか片方だけの構成 (本番向け) と、両方の構成 (小規模・開発向け) が同じコードで扱える。

共有部分は `SharedServer` に切り出されていて、そこに Raft クライアントが入る。**同じプロセスの中でコントローラとブローカーが動くとき、Raft のログは 1 つしかない。**

起動と停止の順序にコメントが付いている。

```scala title="core/src/main/scala/kafka/server/KafkaRaftServer.scala"
override def startup(): Unit = {
  Mx4jLoader.maybeLoad()
  // Controller component must be started before the broker component so that
  // the controller endpoints are passed to the KRaft manager
  controller.foreach(_.startup())
  broker.foreach(_.startup())
```

```scala title="core/src/main/scala/kafka/server/KafkaRaftServer.scala"
override def shutdown(): Unit = {
  // In combined mode, we want to shut down the broker first, since the controller may be
  // needed for controlled shutdown. Additionally, the controller shutdown process currently
  // stops the raft client early on, which would disrupt broker shutdown.
  broker.foreach(_.shutdown())
  controller.foreach(_.shutdown())
```

[`KafkaRaftServer.scala#L92-L112`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/KafkaRaftServer.scala#L92-L112)。

**起動はコントローラが先、停止はブローカーが先。** ブローカーが[計画的にシャットダウン](../broker-lifecycle/)するにはコントローラと話す必要があるからだ。

### メタデータのレコード型

`metadata/src/main/resources/common/metadata/` に、27 個のレコード定義が並んでいる。

```text
AbortTransactionRecord.json        ConfigRecord.json           PartitionRecord.json
AccessControlEntryRecord.json      DelegationTokenRecord.json  ProducerIdsRecord.json
BeginTransactionRecord.json        EndTransactionRecord.json   RegisterBrokerRecord.json
BrokerRegistrationChangeRecord.json FeatureLevelRecord.json    RegisterControllerRecord.json
ClearElrRecord.json                FenceBrokerRecord.json      RemoveTopicRecord.json
ClientQuotaRecord.json             NoOpRecord.json             TopicRecord.json
                                   PartitionChangeRecord.json  UnfenceBrokerRecord.json
                                                               ...
```

これらは[プロトコルと同じ JSON スキーマ](../protocol-codegen/) から生成される。トピックのレコードはこれだけしかない。

```json title="metadata/src/main/resources/common/metadata/TopicRecord.json"
{
  "apiKey": 2,
  "type": "metadata",
  "name": "TopicRecord",
  "validVersions": "0",
  "flexibleVersions": "0+",
  "fields": [
    {
      "name": "Name",
      "type": "string",
      "versions": "0+",
      "entityType": "topicName",
      "about": "The topic name."
    },
    { "name": "TopicId", "type": "uuid", "versions": "0+", "about": "The unique ID of this topic." }
  ]
}
```

[`TopicRecord.json#L16-L28`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/resources/common/metadata/TopicRecord.json#L16-L28)。

**トピック名と UUID の 2 フィールドだけ。** パーティションの情報は別の `PartitionRecord` に分かれている。トピックを 1 個作ると、`TopicRecord` 1 件 + パーティション数ぶんの `PartitionRecord` が書かれる。

**レコードが細かく分かれているのは、変更を細かく表現するため**だ。ISR が 1 つ変わっただけなら `PartitionChangeRecord` が 1 件書かれる。ZooKeeper 時代のように「パーティションの状態全体」を書き直さない。

`NoOpRecord` が混ざっているのが目を引く。**何もしないレコード**で、コントローラが定期的に書く。これでログが進み、「コントローラが生きている」ことと「コミット位置が進んでいる」ことが確認できる。

### メタデータトピックの正体

```scala title="core/src/main/scala/kafka/server/KafkaRaftServer.scala"
object KafkaRaftServer {
  val MetadataTopic = Topic.CLUSTER_METADATA_TOPIC_NAME
  val MetadataPartition = Topic.CLUSTER_METADATA_TOPIC_PARTITION
  val MetadataTopicId = Uuid.METADATA_TOPIC_ID
```

[`KafkaRaftServer.scala#L116-L120`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/KafkaRaftServer.scala#L116-L120)。

**パーティションは 1 個だけ (`CLUSTER_METADATA_TOPIC_PARTITION` は partition 0 固定)。** 分割しない。メタデータの変更は全体で順序が付いている必要があるからだ。

ディスク上は普通のパーティションと同じ形をしている。

```text
/var/lib/kafka/metadata/__cluster_metadata-0/
├── 00000000000000000000.log
├── 00000000000000000000.index
├── 00000000000000000000.timeindex
├── 00000000000000012345-0000000042.checkpoint   ← スナップショット
└── quorum-state                                  ← 投票の記録
```

**`.log` も `.index` も、[セグメント](../log-segment/)も[疎インデックス](../sparse-index/)も、通常のパーティションと同じコードで動く。** 違うのは、レプリケーションの方式と、`quorum-state` という Raft 固有のファイルがあることだけだ。

### なぜ通常のパーティションとして扱えないのか

`__cluster_metadata` を普通のパーティションにできない理由は、**鶏と卵**だ。

通常のパーティションのリーダーは、コントローラが決める。ではコントローラは誰が決めるのか。**コントローラを決めるための仕組みは、コントローラに依存できない。**

だから `__cluster_metadata` だけは自己完結する必要がある。Raft は「外部の権威なしにリーダーを選べる」プロトコルなので、ここに使われている ([Raft 実装のページ](../raft-implementation/))。

**Kafka のクラスタには、複製方式が 2 つ共存している。**

|                            | 通常のパーティション         | `__cluster_metadata` |
| -------------------------- | ---------------------------- | -------------------- |
| 複製方式                   | [ISR](../isr-highwatermark/) | Raft (過半数)        |
| リーダーを決めるのは       | コントローラ                 | 自分たち (投票)      |
| f 台の故障に耐えるのに必要 | f + 1 台                     | 2f + 1 台            |
| データ量                   | 大きい                       | 小さい               |

**データ量が小さいほうに、レプリカ数の多い方式を使っている。** メタデータのコントローラは通常 3 台か 5 台で、そこに置かれるデータは数百 MB のオーダーだ。

## なぜそうなっているか

### 「現在の状態」から「変更の履歴」へ

ZooKeeper 時代と KRaft の最大の違いは、**保存されているものの性質**だ。

|                | ZooKeeper                       | KRaft                         |
| -------------- | ------------------------------- | ----------------------------- |
| 保存されるもの | **現在の状態** (znode のツリー) | **変更の履歴** (レコードの列) |
| 読み方         | 好きなパスを読む                | 先頭から再生する              |
| 変更の通知     | watch イベント + 再読み込み     | **ログの続きを読む**          |
| 位置の表現     | なし (バージョン番号のみ)       | **offset**                    |

**「ログの続きを読む」に統一されたことで、いくつもの問題が同時に解ける。**

- **どこまで反映したかが offset で表せる。** ブローカーは「私は offset 12345 まで反映済み」と言える。コントローラはそれを見て、遅れているブローカーを特定できる。
- **差分の配布が自然になる。** 「あなたの続きから送ります」がフェッチそのもの。
- **コントローラのフェイルオーバーが速い。** 新コントローラはすでにログを読んでいる (フォロワーだったので)。読み直しが要らない。
- **状態の唯一の源が 1 つになる。** ブローカーのキャッシュはログの関数でしかない。

**そして、この「ログの続きを読む」は Kafka がすでに持っていた仕組みだ。** 新しく作ったのは Raft の合意部分だけで、ログの保存・転送・インデックスは全部再利用している。

### なぜ 1 パーティションなのか

メタデータの変更には **全体の順序**が必要だ。

「トピック A を削除」と「トピック A のパーティション 0 のリーダーを変更」が別のパーティションに書かれると、読み手によって順序が違って見える。削除の後にリーダー変更を適用してしまうと、消えたはずのトピックが復活する。

**1 パーティションにすると、順序は offset で完全に決まる。** すべての読み手が同じ順序で見る。

代償は **スケールしないこと**だ。書き込みは 1 台のコントローラのリーダーに集中する。だが、メタデータの変更は毎秒数千件のオーダーなので、これで足りる。**「順序が要るものは分割しない」というのは、データの性質から来る制約だ。**

### なぜ Raft を Kafka の中に実装したのか

外部の Raft ライブラリを使う選択肢もあった。そうしなかった理由は、**Kafka がすでにログの実装を持っていた**ことにある。

一般的な Raft ライブラリは、自前のログ実装を持っている。それを使うと、Kafka のログとは別のもう 1 つのログ実装がコードベースに入る。セグメント管理も、インデックスも、復旧も二重になる。

Kafka の Raft 実装は **既存のログの上に Raft の合意プロトコルだけを載せた**形になっている ([次のページ](../raft-implementation/))。しかも **フォロワーが取りに行く pull 型**にしたので、Fetch の仕組みも再利用できる。

### 役割を分けられるようにした理由

`process.roles` で broker / controller を分けられる。分ける利点は 3 つある。

- **コントローラのリソースを、データのトラフィックから隔離できる。** ブローカーが GC で止まっても、コントローラは動く。
- **コントローラの台数とブローカーの台数を独立に決められる。** コントローラは 3 台、ブローカーは 100 台。
- **コントローラを小さいマシンで動かせる。** メタデータは数百 MB なので、大きなディスクは要らない。

一方、両方を兼ねる構成 (combined mode) を残したのは、**小規模なクラスタや開発環境で 3 台余分に立てるのが重いから**だ。同じコードで両方を扱えるようにしたので、テストも同じフレームワークで回せる。

## どう活かすか

**「現在の状態を配る」を「変更の履歴を配る」に置き換えると、状態同期の問題がまとめて解ける** — これがこの転換の核心だ。読み手は自分の位置を offset で表現でき、差分の配布は「続きを読む」になり、追いつき状況が数値で観測できる。**外部ストアを watch して差分を推測する構成に比べて、失われる情報がない。**

**そのうえで、「自分がすでに持っている仕組みを、自分自身に使う」判断が効いている。** Kafka はログを配るソフトウェアなので、自分の設定情報もログとして配る。**新しい仕組みを足さずに済むだけでなく、既存の仕組みの最適化 (ゼロコピー、インデックス、セグメント管理) が全部そのまま効く。** 自分のプロダクトの中核機能が、自分の内部問題にも使えないか、という問いは意外と見落とされる。

**「順序が必要なデータは分割しない」というのは、分散システムの設計で毎回向き合う判断だ。** Kafka はメタデータを 1 パーティションに固定して、スケールを諦めた。**そのかわり「全体順序」という強い性質が手に入り、読み手側のロジックが単純になる。** 分割してスケールさせると、順序を再構成する仕組み (ベクタークロック、因果関係の追跡) が必要になり、複雑さが読み手全員に広がる。**書き込み量の見積もりが立つなら、分割しないほうが安いことは多い。**

**「同じシステムの中で、データの性質に応じて別の複製方式を使う」も参考になる。** 大量データには ISR (レプリカ数を節約)、少量で重要なメタデータには Raft (過半数で自律)。**1 つの方式で全部やろうとすると、どちらかで無理が出る。** 分ける判断ができるのは、両者の要件を分けて書き出したときだ。
