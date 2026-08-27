---
title: "プロトコルを JSON で定義し、バージョンで互換性を守る"
description: "Kafka のネットワークプロトコルは Java のコードではなく 265 個の JSON ファイルで定義され、ビルド時に読み書きコードへ変換される。各フィールドには「どのバージョンから存在するか」が書かれていて、後方互換性はレビューではなくスキーマの制約として守られる。バージョンの軸が RPC・クラスタ・機能の 3 段に分かれている点が面白い。"
sidebar:
  order: 2
---

## 何を学んだか

### どんな状況の話か

Kafka のクライアントとブローカーは、**バージョンが揃わないまま動き続ける**ことを前提にしている。

- ブローカーを 4.4 に上げても、アプリのクライアントは 2.8 のままかもしれない。
- ローリングアップグレード中は、同じクラスタの中に古いブローカーと新しいブローカーが混在する。
- ディスクに書かれたレコードや、`__cluster_metadata` に記録されたメタデータは、アップグレード後も読めなければならない。

そして [前提のページ](../architecture/) で見たとおり、ブローカーが受け付ける RPC は 81 種類ある。各 RPC には独立したバージョン番号があり、`Produce` だけでも v3 から v13 まで 11 世代が並存する。

これを手書きのシリアライザで管理すると何が起きるか。「v9 のときはこのフィールドを読み飛ばす」「v13 ではトピック名の代わりに UUID が来る」といった分岐が、リクエストごと・フィールドごとに散らばる。1 箇所間違えると、特定バージョンの組み合わせでだけ壊れる。

### Kafka の答え

**プロトコルをコードで書くのをやめて、JSON のスキーマで宣言し、読み書きコードを生成する。**

1. **RPC 1 つにつき JSON ファイル 1 つ。** `clients/src/main/resources/common/message/` に 204 ファイル、全モジュール合わせて 265 ファイルある。
2. **フィールドごとに「存在するバージョン範囲」を書く。** `"versions": "3+"`、`"versions": "0-12"` のように。
3. **生成される Java オブジェクトはバージョンを持たない。** 1 つの `ProduceRequestData` が全バージョンを表し、`write(buffer, version)` に渡したバージョンで出力が変わる。
4. **後から任意の位置にフィールドを足したいときは tagged field を使う。** 古い相手は知らないタグを黙って読み飛ばす。
5. **バージョンの軸は 3 段ある。** RPC ごとのバージョン、クラスタ全体の `MetadataVersion`、機能ごとの `Feature`。

## ソースコードのどこか

### スキーマの実物

`Produce` リクエストの定義は 73 行しかない。

```json title="clients/src/main/resources/common/message/ProduceRequest.json"
{
  "apiKey": 0,
  "type": "request",
  "listeners": ["broker"],
  "name": "ProduceRequest",
  // Versions 0-2 were removed in Apache Kafka 4.0, version 3 is the new baseline. Due to a bug in librdkafka,
  // these versions have to be included in the api versions response (see KAFKA-18659), but are rejected otherwise.
  ...
  // Starting in version 7, records can be produced using ZStandard compression.  See KIP-110.
  //
  // Starting in Version 8, response has RecordErrors and ErrorMessage. See KIP-467.
  //
  // Version 9 enables flexible versions.
  ...
  // Version 13 replaces topic names with topic IDs (KIP-516). May return UNKNOWN_TOPIC_ID error code.
  "validVersions": "3-13",
  "flexibleVersions": "9+",
  "fields": [
    { "name": "TransactionalId", "type": "string", "versions": "3+", "nullableVersions": "3+", "default": "null", "entityType": "transactionalId",
      "about": "The transactional ID, or null if the producer is not transactional." },
    { "name": "Acks", "type": "int16", "versions": "0+", ... },
    { "name": "TimeoutMs", "type": "int32", "versions": "0+", ... },
    { "name": "TopicData", "type": "[]TopicProduceData", "versions": "0+",
      "about": "Each topic to produce to.", "fields": [
      { "name": "Name", "type": "string", "versions": "0-12", "entityType": "topicName", "mapKey": true, "ignorable": true,
        "about": "The topic name." },
      { "name": "TopicId", "type": "uuid", "versions": "13+", "mapKey": true, "ignorable": true, "about": "The unique topic ID" },
```

[`ProduceRequest.json#L16-L73`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/resources/common/message/ProduceRequest.json#L16-L73)。

読みどころが 3 つある。

**1. バージョン履歴がコメントとして残っている。** v7 で zstd、v8 でエラー詳細、v13 でトピック名 → トピック ID。しかも各行に KIP 番号が付いている。**このファイルを上から読むと、Kafka の書き込みプロトコルが 10 年かけてどう変わったかが分かる。**

**2. フィールドの削除が「バージョン範囲を閉じる」で表現される。** `Name` は `"0-12"`、`TopicId` は `"13+"`。トピック名を UUID に置き換える変更が、フィールドを消さずに 2 行で書かれている。トピックを消して同じ名前で作り直したときに古い名前で書き込みが届いてしまう問題を、名前ではなく ID で識別することで防いだ変更 (KIP-516) だ。

**3. JSON にコメントが書ける。** 標準の JSON ではないが、[README](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/resources/common/message/README.md) に「このバージョンの JSON はコメントをサポートする」と明記されている。バージョン履歴を書き残すことを優先している。

### 消えた RPC は、欠番として残る

4.0 で ZooKeeper が消えたとき、コントローラがブローカーに指示を出していた RPC も一緒に消えた。そのスキーマファイルは削除されていない。

```json title="clients/src/main/resources/common/message/LeaderAndIsrRequest.json"
{
  "apiKey": 4,
  "type": "request",
  "name": "LeaderAndIsrRequest",
  // This request was removed in Apache Kafka 4.0.
  "validVersions": "none"
}
```

[`LeaderAndIsrRequest.json#L16-L22`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/resources/common/message/LeaderAndIsrRequest.json#L16-L22)。

**api key 4 は永久欠番になった。** 同じ番号を別の RPC に再利用すると、古いクライアントが送ってきた `LeaderAndIsr` を新しい RPC として解釈してしまう。番号を空けておくほうが安い。

### ルールは README に書かれている

スキーマの書き方の規約は、生成器のコードではなく `README.md` にある。

```text title="clients/src/main/resources/common/message/README.md"
Dropping support for old message versions is no longer allowed without a KIP.
Therefore, please be careful not to increase the lower end of the version
support interval for any message.
```

```text title="clients/src/main/resources/common/message/README.md"
The order that fields appear in a message is important.  Fields which come
first in the message definition will be sent first over the network.  Changing
the order of the fields in a message is an incompatible change.
```

[`README.md#L37-L62`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/resources/common/message/README.md#L37-L62)。

**「古いバージョンのサポートを切るには KIP が要る」** — つまりコミュニティの合意プロセスを通さないと切れない。互換性の方針が、コードの制約ではなくプロセスの制約として書かれている。

### tagged field — 順序の制約を破るための逃げ道

フィールドの順序が固定されているということは、**末尾に足す以外の変更ができない**ということだ。しかも足すたびにバージョンが上がる。これを回避するのが tagged field だ。

```text title="clients/src/main/resources/common/message/README.md"
Unlike mandatory fields, tagged fields can be added to message versions that
already exists.  Older servers will ignore new tagged fields which they do not
understand.
...
You can remove support for a tagged field from a specific version of a message,
but you can't reuse a tag once it has been used for something else.  Once tags
have been used for something, they can't be used for anything else, without
breaking compatibility.
```

[`README.md#L121-L141`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/resources/common/message/README.md#L121-L141)。

Protocol Buffers のフィールド番号と同じ発想だが、Kafka では **「順序固定の必須フィールド列」+「タグ付きの任意フィールド列」の二階建て**になっている。前半は無駄がなく、後半は柔軟。tagged field を使えるのは `flexibleVersions` 以降のバージョンだけで、`Produce` なら v9 以降だ。

### 生成器

`generator/` は約 7,800 行の小さなコンパイラだ。JSON を読んで `MessageSpec` に落とし、Java のソースを文字列として吐く。

```java title="generator/src/main/java/org/apache/kafka/message/VersionConditional.java"
/**
 * Creates an if statement based on whether or not the current version
 * falls within a given range.
 */
public final class VersionConditional {
```

[`VersionConditional.java#L20-L24`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/generator/src/main/java/org/apache/kafka/message/VersionConditional.java#L20-L24)。

**JSON に書いた `"versions": "3+"` が、生成コードの中では `if (_version >= 3) { ... }` になる。** 手書きなら人間が書いていた分岐を、スキーマから機械的に展開しているだけだ。生成されるものは 4 種類ある。

| 生成器                                                           | 何を作るか                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| `MessageDataGenerator`                                           | `ProduceRequestData` などの読み書き可能なオブジェクト |
| `ApiMessageTypeGenerator`                                        | api key ↔ クラスの対応表 (`ApiMessageType`)           |
| `JsonConverterGenerator`                                         | デバッグ用の JSON 変換                                |
| `MetadataRecordTypeGenerator` / `CoordinatorRecordTypeGenerator` | メタデータレコードとコーディネータレコードの型        |

最後の行が重要で、**ネットワークプロトコルと「ディスクに書かれるレコード」が同じ仕組みで定義されている**。`__cluster_metadata` に書かれる `TopicRecord` も、`__consumer_offsets` に書かれる `OffsetCommitValue` も、同じ JSON スキーマから生成される。だから **プロトコルの互換性ルールが、そのまま永続データの互換性ルールになる**。

### スキーマの進化を検証するツール

生成器の中には、2 つのバージョンのスキーマを突き合わせて「互換性のある進化か」を判定するチェッカーが入っている。

```java title="generator/src/main/java/org/apache/kafka/message/checker/EvolutionVerifier.java"
static void verifyTopLevelMessages(MessageSpec topLevelMessage1, MessageSpec topLevelMessage2) {
    if (!topLevelMessage1.apiKey().equals(topLevelMessage2.apiKey())) {
        throw new EvolutionException("Initial apiKey " + topLevelMessage1.apiKey() +
            " does not match final apiKey " + topLevelMessage2.apiKey());
    }
    ...
    if (!topLevelMessage2.flexibleVersions().contains(topLevelMessage1.flexibleVersions())) {
        throw new EvolutionException("Initial flexibleVersions " + topLevelMessage1.flexibleVersions() +
            " must be a subset of final flexibleVersions " + topLevelMessage2.flexibleVersions());
    }
    if (topLevelMessage2.validVersions().highest() < topLevelMessage1.validVersions().highest()) {
        throw new EvolutionException(...);
    }
```

[`EvolutionVerifier.java#L43-L67`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/generator/src/main/java/org/apache/kafka/message/checker/EvolutionVerifier.java#L43-L67)。

`Unifier` は 2 つのスキーマのフィールドを対応付けて、型・順序・null 許容性が矛盾しないかを見る。**「互換性を壊す変更」の定義がコードとして書かれていて、CI で走る。**

### 実行時のネゴシエーション

スキーマだけでは足りない。接続した相手が実際にどのバージョンを話せるかは、`ApiVersions` リクエストで聞く。

```java title="clients/src/main/java/org/apache/kafka/clients/NodeApiVersions.java"
public short latestUsableVersion(ApiKeys apiKey, short oldestAllowedVersion, short latestAllowedVersion) {
    if (!supportedVersions.containsKey(apiKey))
        throw new UnsupportedVersionException("The node does not support " + apiKey);
    ApiVersion supportedVersion = supportedVersions.get(apiKey);
    Optional<ApiVersion> intersectVersion = ApiVersionsResponse.intersect(supportedVersion,
        new ApiVersion()
            .setApiKey(apiKey.id)
            .setMinVersion(oldestAllowedVersion)
            .setMaxVersion(latestAllowedVersion));

    if (intersectVersion.isPresent())
        return intersectVersion.get().maxVersion();
    else
        throw new UnsupportedVersionException(...);
}
```

[`NodeApiVersions.java#L149-L166`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/clients/NodeApiVersions.java#L149-L166)。

**やっていることは区間の共通部分を取って、その上限を使うだけ。** クライアントは接続のたびにこれを解決し、以降そのブローカー宛のリクエストには決まったバージョンを使う。

### クラスタ全体のバージョン — MetadataVersion

RPC ごとのバージョンでは扱えないものがある。「新しい種類のメタデータレコードを書き始めていいか」だ。書いてしまうと、古いブローカーがそのレコードを読めずに止まる。ロールバックもできなくなる。

そこで、**クラスタ全体で 1 つの `MetadataVersion` を持ち、運用者が明示的に上げる**。

```java title="server-common/src/main/java/org/apache/kafka/server/common/MetadataVersion.java"
// Support for tiered storage (KIP-405)
IBP_3_5_IV0(9, "3.5", "IV0", false),

// Adds replica epoch to Fetch request (KIP-903).
IBP_3_5_IV1(10, "3.5", "IV1", false),
...
// IBP_4_4_IV0 enables dead-letter queue support for share groups (KIP-1191).
IBP_4_4_IV0(31, "4.4", "IV0", false),
```

[`MetadataVersion.java#L47-L144`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/common/MetadataVersion.java#L47-L144)。

```java title="server-common/src/main/java/org/apache/kafka/server/common/MetadataVersion.java"
/**
 * The latest production-ready MetadataVersion. This is the latest version that is stable
 * and cannot be changed. MetadataVersions later than this can be tested via junit, but
 * not deployed in production.
 *
 * <strong>Think carefully before you update this value. ONCE A METADATA VERSION IS PRODUCTION,
 * IT CANNOT BE CHANGED.</strong>
 */
public static final MetadataVersion LATEST_PRODUCTION = IBP_4_4_IV2;
```

[`MetadataVersion.java#L155-L163`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/common/MetadataVersion.java#L155-L163)。

**開発中のバージョンと本番で使えるバージョンが、この 1 行で分けられている。** `LATEST_PRODUCTION` より新しい `MetadataVersion` はテストでは使えるが、本番クラスタでは選べない。一度本番に出したら二度と変えられないからだ。

`IBP_` という接頭辞は `inter.broker.protocol.version` の名残で、ZooKeeper 時代の設定名がそのまま定数名に残っている。

### 機能ごとのバージョン — Feature

`MetadataVersion` は 1 本の直線なので、「トランザクションの新機能は使いたいが、共有グループはまだ要らない」ができない。これを分けたのが `Feature` (KIP-1022) だ。

```java title="server-common/src/main/java/org/apache/kafka/server/common/Feature.java"
KRAFT_VERSION(KRaftVersion.FEATURE_NAME, KRaftVersion.values(), KRaftVersion.LATEST_PRODUCTION),
TRANSACTION_VERSION(TransactionVersion.FEATURE_NAME, TransactionVersion.values(), TransactionVersion.LATEST_PRODUCTION),
GROUP_VERSION(GroupVersion.FEATURE_NAME, GroupVersion.values(), GroupVersion.LATEST_PRODUCTION),
ELIGIBLE_LEADER_REPLICAS_VERSION(...),
SHARE_VERSION(ShareVersion.FEATURE_NAME, ShareVersion.values(), ShareVersion.LATEST_PRODUCTION),
STREAMS_VERSION(StreamsVersion.FEATURE_NAME, StreamsVersion.values(), StreamsVersion.LATEST_PRODUCTION),
```

[`Feature.java#L37-L50`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/common/Feature.java#L37-L50)。

**機能ごとに独立したバージョン軸があり、それぞれに `LATEST_PRODUCTION` がある。** 各機能のオーナーが自分の軸だけを進められる。この 6 行が、この章で扱う大きな機能 ([KRaft](../kraft-overview/)、[トランザクション](../transactions-eos/)、[新しいグループプロトコル](../rebalance-protocol/)、[ELR](../elr/)、[共有グループ](../share-groups/)) とほぼ一対一に対応しているのが分かりやすい。

## なぜそうなっているか

### 3 種類の互換性を 1 つの仕組みで扱う

Kafka が守らなければならない互換性は、実は 3 種類ある。

| 種類                          | 誰と誰の間                           | 破れたときに起きること             |
| ----------------------------- | ------------------------------------ | ---------------------------------- |
| **クライアント ↔ ブローカー** | 別々にアップグレードされる           | アプリが接続できない               |
| **ブローカー ↔ ブローカー**   | ローリングアップグレード中に混在する | レプリケーションが止まる           |
| **プロセス ↔ ディスク**       | 過去の自分と今の自分                 | 起動できない、ロールバックできない |

**この 3 つを、同じスキーマ言語と同じバージョン規則で扱っている**のが、この設計の核心だ。ネットワークのメッセージも永続レコードも同じ JSON から生成されるので、「フィールドを足すときのルール」を 3 回考えなくていい。

### なぜオブジェクトにバージョンを持たせないか

README にはこう書いてある。

```text title="clients/src/main/resources/common/message/README.md"
MessageData objects do not contain a version number.  Instead, a single
MessageData object represents every possible version of a Message.  This makes
working with messages more convenient, because the same code path can be used
for every version of a message.
```

**ビジネスロジックからバージョンを追い出す**のが狙いだ。`KafkaApis.handleProduceRequest` は「v9 なら」「v13 なら」を書かない。バージョンの分岐は生成コードの `read`/`write` の中だけに閉じ込められる。

代償もある。**v13 でしか存在しないフィールドに、v3 のリクエストからもアクセスできてしまう。** 読めば型のデフォルト値 (0 や null) が返ってくるだけで、コンパイルエラーにはならない。この落とし穴のために、フィールドに `"ignorable": true` という指定があり、「古いバージョンで欠けていても無視してよいか」を宣言できるようになっている。

### なぜ tagged field を後から足したか

初期のプロトコルには tagged field がなかった。フィールドを 1 つ足すたびに、リクエストとレスポンスの両方でバージョンを上げる必要があった。

バージョンを上げるコストは、番号を増やすことではなく **「そのバージョンを永久にサポートし続ける約束」** をすることだ。`Produce` の v3 は 2017 年の形式だが、いまも生きている。タグ付きの任意フィールドなら、この約束を増やさずにフィールドを足せる。

### なぜバージョンの軸を 3 段に分けたか

3 つの軸は、**変更を承認する主体が違う**。

| 軸                | 誰が決めるか                             | いつ変わるか             |
| ----------------- | ---------------------------------------- | ------------------------ |
| RPC バージョン    | クライアントとブローカーが接続時に自動で | 接続のたび               |
| `MetadataVersion` | **運用者が明示的にコマンドを打つ**       | アップグレードの最終段階 |
| `Feature`         | 運用者が機能ごとに                       | 機能を使い始めるとき     |

RPC バージョンを自動ネゴシエーションにできるのは、**下げても壊れないから**だ。古いバージョンで話せばいいだけで、失われるのは機能だけ。

`MetadataVersion` を自動にできないのは、**上げると戻れないから**だ。新しい形式のレコードをログに書いてしまうと、古いソフトウェアはもうそのログを読めない。だから「全ブローカーのアップグレードが終わり、ロールバックしないと決めた」ときに、運用者が手で上げる。

**「戻せる変更は自動、戻せない変更は手動」** という切り分けが、そのまま仕組みの分かれ目になっている。

## どう活かすか

**スキーマからシリアライザを生成する構成は、バージョンが揃わない相手と長く付き合うシステムなら検討に値する。** Protocol Buffers や Avro のような既製品を使えばよく、Kafka が自前の生成器を持っているのは、tagged field と必須フィールドの二階建てや `records` 型 (ゼロコピーのためにバイト列をそのまま持つ) といった要求が既製品に合わなかったためだ。**まず既製品を検討し、合わない理由が説明できるときだけ自作する**という順序は真似できる。

**真似しやすいのは、スキーマにバージョン履歴と根拠へのリンクを書き残すことだ。** `ProduceRequest.json` の冒頭 30 行は、コードのコメントではなく設計判断の記録になっている。「v13 でトピック名を ID に置き換えた (KIP-516)」が定義ファイルの中にあるので、フィールドを見た人が必ず理由に到達できる。これはスキーマ言語がなくても、型定義のそばにやれる。

**「戻せる変更は自動ネゴシエーション、戻せない変更は明示的な操作」という切り分けも移植しやすい。** データ形式のマイグレーションを持つシステムは、たいてい「新形式で書き始める」タイミングをアプリのバージョンに紐付けてしまう。そうすると、アプリを戻したくても戻せない。書き始めるタイミングを設定で分離しておくと、アップグレードとロールバックの手順が独立する。

**一方、取り込むべきでない条件もはっきりしている。** この仕組みのコストは、**互換性のルールを人間が守り続けること**に乗っている。`README.md` の「フィールドの順序を変えるのは非互換な変更」「タグを再利用してはいけない」は、生成器が全部は検出してくれない。`EvolutionVerifier` が見るのは一部で、残りはレビューと KIP プロセスが支えている。**プロセスを回す人手がないなら、この形は維持できない。** 単一のチームが両端をデプロイできるなら、素直に「両方同時に上げる」ほうが安い。
