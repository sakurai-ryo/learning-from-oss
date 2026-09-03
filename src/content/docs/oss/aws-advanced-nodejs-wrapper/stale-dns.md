---
title: "StaleDns — クラスタエンドポイントが古い writer を指すとき"
description: "クラスタエンドポイントで繋いだ直後に @@innodb_read_only を聞き、reader だったら「DNS が古い」と判断してトポロジ上の writer にインスタンスエンドポイントで張り直す。StaleDnsHelper は 160 行のクラスだが、failover と failover2 の両方の connect パイプラインに埋め込まれていて、単体プラグインの staleDns はほぼ使われない。"
group: "フェイルオーバー"
sidebar:
  order: 42
---

## 何を学んだか

フェイルオーバー直後、クラスタエンドポイントの DNS は **15〜20 秒、経路によってはそれ以上**古い writer を指し続ける。その間に張った接続は、writer のつもりで reader に繋がっている。

`StaleDnsHelper.getVerifiedConnection` は、この事故を接続時に検出して直す。

- クラスタエンドポイント (writer 用) で繋いだときだけ動く
- 繋いだ直後に `getHostRole` (MySQL なら `@@innodb_read_only`) を聞く
- reader だったら、トポロジが指す writer に**インスタンスエンドポイントで**張り直し、最初の接続は捨てる

これは `staleDns` という独立プラグインとしても存在するが、**`failover` と `failover2` が `connect` の中で同じ Helper を呼んでいる**ので、失敗検知系のプラグインを 1 つでも入れていれば自動で有効になる。

## ソースコードのどこか

### 2 つの入口

`StaleDnsPlugin` ([`common/lib/plugins/stale_dns/stale_dns_plugin.ts#L27`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/stale_dns/stale_dns_plugin.ts#L27)) は `initHostProvider` / `connect` / `notifyHostListChanged` を購読し、`connect` で Helper に委譲するだけの 50 行である。

```ts title="common/lib/plugins/stale_dns/stale_dns_plugin.ts"
override async connect(
  hostInfo: HostInfo,
  properties: Map<string, any>,
  isInitialConnection: boolean,
  connectFunc: () => Promise<ClientWrapper>
): Promise<ClientWrapper> {
  if (!this.hostListProviderService) {
    throw new AwsWrapperError(Messages.get("HostListProviderService.notFound"));
  }
  return await this.staleDnsHelper.getVerifiedConnection(hostInfo.host, isInitialConnection, this.hostListProviderService, properties, connectFunc);
}
```

同じ呼び出しが `FailoverPlugin.connect` ([`failover_plugin.ts#L242`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/failover_plugin.ts#L242)) と `Failover2Plugin.connect` ([`failover2_plugin.ts#L119`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L119)) にある。

```ts title="common/lib/plugins/failover/failover_plugin.ts"
override async connect(
  hostInfo: HostInfo,
  props: Map<string, any>,
  isInitialConnection: boolean,
  connectFunc: () => Promise<ClientWrapper>
): Promise<ClientWrapper> {
  this.initFailoverMode();
  return await this._staleDnsHelper.getVerifiedConnection(hostInfo.host, isInitialConnection, this.hostListProviderService!, props, connectFunc);
}
```

### `getVerifiedConnection` — 動く条件

[`stale_dns_helper.ts#L47`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/stale_dns/stale_dns_helper.ts#L47)。前半は「やらない条件」の列挙である。

```ts title="common/lib/plugins/stale_dns/stale_dns_helper.ts"
const type: RdsUrlType = this.rdsUtils.identifyRdsType(host);

if (type !== RdsUrlType.RDS_WRITER_CLUSTER && type !== RdsUrlType.RDS_GLOBAL_WRITER_CLUSTER) {
  return connectFunc();
}

if (type === RdsUrlType.RDS_WRITER_CLUSTER) {
  const writer = getWriter(this.pluginService.getAllHosts());
  if (writer != null && this.rdsUtils.isRdsInstance(writer.host)) {
    if (
      isInitialConnection &&
      WrapperProperties.SKIP_INACTIVE_WRITER_CLUSTER_CHECK.get(props) &&
      !this.rdsUtils.isSameRegion(writer.host, host)
    ) {
      // The cluster writer endpoint belongs to a different region than the current writer region.
      // ...
      return connectFunc();
    }
  } else {
    // No writer is available. It could be the case with the first connection when topology isn't yet available.
    // Continue with a normal workflow.
    return connectFunc();
  }
}
```

- `RdsUtils.identifyRdsType` ([RdsUtils](../rds-utils/)) が **writer 用クラスタエンドポイント** (`xxx.cluster-yyy.<region>.rds.amazonaws.com`、または Global DB の `global-`) と判定したときだけ進む。reader エンドポイント、インスタンスエンドポイント、IP、カスタムドメインはそのまま `connectFunc()`
- トポロジに writer がいない、または writer のホストがインスタンスエンドポイントでない (接続文字列由来など) なら、比較対象がないのでそのまま繋ぐ
- Global DB の「非アクティブな writer エンドポイント」は別リージョンを指すので、`skipInactiveWriterClusterEndpointCheck` が立っていれば検証を飛ばす

### 繋いでから役割を聞く

```ts title="common/lib/plugins/stale_dns/stale_dns_helper.ts"
const currentTargetClient = await connectFunc();

const isConnectedToReader: boolean =
  (await this.pluginService.getHostRole(currentTargetClient)) === HostRole.READER;
if (isConnectedToReader) {
  // This is if-statement is only reached if the connection url is a writer cluster endpoint.
  // If the new connection resolves to a reader instance, this means the topology is outdated.
  // Force refresh to update the topology.
  await this.pluginService.forceRefreshHostList();
} else {
  await this.pluginService.refreshHostList();
}
```

まず**普通に繋ぐ**。DNS が何を返すかは繋いでみないと分からないからである。繋いだ接続で `getHostRole` を聞き、MySQL の Dialect なら `SELECT @@innodb_read_only as is_reader` が飛ぶ ([Aurora MySQL の自己申告メタデータ](../aurora-metadata/))。reader だったら「トポロジも古いはず」として `forceRefreshHostList()` で強制更新する。

### writer を覚えて、張り直す

```ts title="common/lib/plugins/stale_dns/stale_dns_helper.ts"
if (!this.writerHostInfo) {
  const writerCandidate = getWriter(this.pluginService.getHosts());
  if (writerCandidate && this.rdsUtils.isRdsClusterDns(writerCandidate.host)) {
    return currentTargetClient;
  }
  this.writerHostInfo = writerCandidate;
}

// ...

if (isConnectedToReader) {
  // Reconnect to writer host if current connection is reader.

  logger.debug(Messages.get("StaleDnsHelper.staleDnsDetected", this.writerHostInfo.host));
  this.staleDNSDetectedCounter.inc();

  const allowedHosts: HostInfo[] = this.pluginService.getHosts();

  if (!containsHostAndPort(allowedHosts, this.writerHostInfo.hostAndPort)) {
    throw new AwsWrapperError(
      Messages.get(
        "StaleDnsHelper.currentWriterNotAllowed",
        this.writerHostInfo.host,
        logTopology(allowedHosts, ""),
      ),
    );
  }

  let targetClient = null;
  try {
    const newProps = new Map<string, any>(props);
    newProps.set(WrapperProperties.HOST.name, this.writerHostInfo.host);
    targetClient = await this.pluginService.connect(this.writerHostInfo, newProps);
    await this.pluginService.abortTargetClient(currentTargetClient);

    if (isInitialConnection) {
      hostListProviderService.setInitialConnectionHostInfo(this.writerHostInfo);
    }
    return targetClient;
  } catch (error: any) {
    await this.pluginService.abortTargetClient(targetClient);
  }
}
return currentTargetClient;
```

- `writerHostInfo` はインスタンス変数にキャッシュされる。トポロジの writer がクラスタ DNS のままなら (接続文字列プロバイダで cluster エンドポイントをそのまま登録した場合) 張り直し先がないので諦める
- 張り直しは `pluginService.connect(writerHostInfo, newProps)` で、**ホストだけをインスタンスエンドポイントに差し替えた**プロパティで plugin chain をもう一度通す。認証プラグインも通るので、IAM トークンの `iamHost` などはそのまま効く
- 張り直しに成功したら元の接続を `abort` し、初回接続なら `setInitialConnectionHostInfo` で「最初に繋いだホスト」を writer に書き換える。これで [failoverMode](../failover-mode/) の既定値判定などが writer 基準になる
- 張り直しに**失敗したら reader 接続をそのまま返す**。例外は握りつぶされる

### writer 交代でキャッシュを捨てる

[`notifyHostListChanged`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/stale_dns/stale_dns_helper.ts#L140)。

```ts title="common/lib/plugins/stale_dns/stale_dns_helper.ts"
if (this.writerHostInfo) {
  if (key === this.writerHostInfo.url && values.has(HostChangeOptions.PROMOTED_TO_READER)) {
    logger.debug(Messages.get("StaleDnsHelper.reset"));
    this.writerHostInfo = null;
  }
}
```

覚えていた writer が `PROMOTED_TO_READER` になったら `null` に戻す。次の `connect` で改めてトポロジから取り直す。

## なぜそうなっているか

### DNS を信じないが、DNS で繋ぐ

`FailoverConfigurationGuide.md` の "Writer Cluster Endpoints After Failover" 節に、AWS の DNS 側の更新は通常 15〜20 秒、ただしアプリと AWS の間にある DNS サーバはそれに追いつかないことがある、とある。`UsingTheAuroraInitialConnectionStrategyPlugin.md` は 40〜60 秒と書いている。この間、クラスタエンドポイントは**嘘をつく**。

一方でラッパは DNS を回避して繋ぐ手段を最初から持っているわけではない。トポロジはインスタンスエンドポイントの一覧を持つが、それは一度どこかに繋いで SQL で聞いた結果である ([HostListProvider 2 種](../host-list-providers/))。最初の接続はクラスタエンドポイントで張るしかない。

だから手順は「まず DNS で繋ぐ → 繋いだ相手に役割を聞く → 違ったら知っている writer に張り直す」になる。**DNS は繋ぐためだけに使い、判断には使わない。**

### なぜ `@@innodb_read_only` で判定するのか

「クラスタエンドポイントで繋いだのに reader だった」は、DNS が古いこと以外にほぼ説明がつかない。トポロジを読んで比較する方法もあるが、トポロジも古いかもしれない (reader から読んだトポロジは古いことがある)。`@@innodb_read_only` は**繋いだそのインスタンス自身の状態**で、他のホストの申告に依存しないので、判定として最も確実である。

役割が reader だと分かった時点で `forceRefreshHostList()` を呼ぶのは、その接続から読めるトポロジも疑わしいからで、モニタに「本当の writer を確認して」と頼み直している ([ClusterTopologyMonitor](../cluster-topology-monitor/))。

### なぜ張り直し失敗を握りつぶすのか

張り直しに失敗したら、手元には「reader に繋がった接続」がある。これを捨てて例外にすると、アプリは接続ゼロになる。reader でも `SELECT` は通るので、接続を返しておけば読み取り系の処理は動き、書き込みで `errno 1290` が出た時点で [failover の read-only トリガ](../failover-triggers/) (strict-writer のとき) が拾って本来のフェイルオーバーに入る。「最善ではないが動く接続」を返すほうが、ゼロよりましという判断である。

### なぜ独立プラグインとしても存在するのか

`UsingTheNodejsWrapper.md` のプラグイン表は `staleDns` について "This logic is already included in `failover` plugin so you can omit using both plugins at the same time" と注記している。単体で使う場面は「フェイルオーバー処理は要らないが、古い DNS で writer を外すのだけは避けたい」というときで、`enableClusterAwareFailover: false` で failover2 を無効にした場合も `Failover2Plugin.connect` は Helper を呼ぶ ([`failover2_plugin.ts#L127`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L127)) ので、実際にはほぼ出番がない。

### `initialConnection` との分担

既定プラグインの `initialConnection` (weight 390) も、クラスタエンドポイントで繋ぐときに writer を検証する ([initialConnection プラグイン](../initial-connection-strategy/))。違いは順序で、`initialConnection` は**トポロジに writer が載っていればまずそこへ直接**繋ぎ、載っていないときだけ DNS で繋いで確認する。StaleDns は常に DNS で繋いでから確認する。

connect パイプラインでは `initialConnection` が先に走り、その `connectFunc()` の先に `failover2` (weight 710) の StaleDns がある。`initialConnection` がインスタンスエンドポイントで `pluginService.connect(writerCandidate, props, this)` を呼ぶと、そこから始まる新しいパイプラインでも StaleDns は通るが、ホストが `RDS_INSTANCE` なので何もしない。二重に検証はしない。

## どう活かすか

- **名前解決の結果は「繋ぐため」に使い、「相手が誰か」はプロトコルの中で確認する。** DNS に限らず、サービスディスカバリやロードバランサ越しの接続で「意図した相手か」を保証したいなら、接続後に相手自身に聞く 1 クエリを足す。ラッパでは `@@innodb_read_only` がそれにあたる
- **修正できないときの戻り値を決めておく。** 張り直し失敗時に「reader 接続を返す」のは、例外にするより後段の仕組み (failover) が拾いやすいからである。フォールバックは「何もしない」ではなく「後段が検知できる状態で返す」と設計する
- **共有ロジックはプラグインではなく Helper にする。** `StaleDnsHelper` は状態 (`writerHostInfo`) を持つがプラグインではないので、failover / failover2 / staleDns の 3 箇所から同じインスタンス生成で使える。プラグイン間で処理を共有したいときに、プラグインの継承より小さい
- **取り込むべきでない条件。** この検証は接続のたびに `@@innodb_read_only` を 1 回打つ。内部プールで接続を高頻度に作る構成では、そのコストが見えてくる。[内部コネクションプール](../internal-connection-pool/) ではインスタンスエンドポイントで繋ぐので、この検証は素通りになる

### つまずきどころ

- **`StaleDnsPlugin.execute` は呼ばれない。** [`stale_dns_plugin.ts#L65`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/stale_dns/stale_dns_plugin.ts#L65) に「毎回 `refreshHostList` してから実行する」`execute` があるが、`subscribedMethods` に `query` 等が含まれていないので、`PluginManager` はこのプラグインを execute パイプラインに載せない ([PluginChain](../plugin-chain/))。読んで「毎クエリでトポロジ更新するのか」と驚かないこと
- **カスタムドメインでは動かない。** `identifyRdsType` が `OTHER` を返すので検証しない。カスタムドメインを cluster エンドポイントの CNAME にしている構成では、`clusterInstanceHostPattern` を設定した上で `initialConnection` に頼ることになる ([clusterInstanceHostPattern](../cluster-instance-host-pattern/))
- **reader エンドポイントは対象外。** `cluster-ro-` で繋いだときに writer に当たっても直さない。reader エンドポイントの DNS が古くて旧 reader (= 新 writer) に繋がるケースは `initialConnection` の `getVerifiedReaderClient` が扱う
- **`writerHostInfo` のキャッシュは接続ごと。** `StaleDnsHelper` は `FailoverPlugin` のインスタンス変数なので、`AwsMySQLClient` ごとに別々に writer を覚える。プロセス全体で共有されるのはトポロジキャッシュのほうである ([clusterId](../cluster-id/))
