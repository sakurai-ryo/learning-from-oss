---
title: "clusterInstanceHostPattern — `?` テンプレート"
description: "トポロジクエリが返すのはインスタンス名だけで、接続に使えるエンドポイントではない。ラッパは接続文字列から取り出したドメインを `?.abc123.us-east-1.rds.amazonaws.com` という雛形にして、`?` をインスタンス名で置き換える。IP やカスタムドメインで繋ぐと雛形が作れないので clusterInstanceHostPattern が必須になるが、その「必須」はコード上では強制されていない。"
group: "トポロジを知る"
sidebar:
  order: 24
---

## 何を学んだか

Aurora の `information_schema.replica_host_status` が返す `server_id` は `my-instance-1` のようなインスタンス名で、DNS 名ではない。Multi-AZ の `mysql.rds_topology` は `endpoint` 列を持つが、ラッパはそれもインスタンス名部分だけ切り出して使う。つまり**トポロジクエリの結果だけでは接続先が作れない**。

足りないのはドメイン部分で、ラッパはそれを **`?` を 1 つ含む雛形文字列** として持つ。

- 接続文字列が RDS の形なら、`RdsUtils.getRdsInstanceHostPattern` が `?.<domain>` を自動で作る
- IP アドレスやカスタムドメインなら自動では作れず、`clusterInstanceHostPattern` を設定する必要がある
- 雛形は `?` を含むこと、RDS Proxy やカスタムクラスタエンドポイントの形でないことが検証される

ただし「IP のときは必須」という docs の記述は、コードでは例外にならない。`?` だけの雛形が通ってしまい、接続時に初めて壊れる。

## ソースコードのどこか

### 雛形の決定

[`common/lib/host_list_provider/rds_host_list_provider.ts#L85`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L85)。

```ts title="common/lib/host_list_provider/rds_host_list_provider.ts"
protected initSettings(): void {
  let port = WrapperProperties.PORT.get(this.properties);
  if (port == null) {
    port = this.hostListProviderService.getDialect().getDefaultPort();
  }

  this.initialHostList = this.connectionUrlParser.getHostsFromConnectionUrl(this.originalUrl, false, port, () =>
    this.hostListProviderService.getHostInfoBuilder()
  );
  if (!this.initialHostList || this.initialHostList.length === 0) {
    throw new AwsWrapperError(Messages.get("RdsHostListProvider.parsedListEmpty", this.originalUrl));
  }

  this.initialHost = this.initialHostList[0];
  this.hostListProviderService.setInitialConnectionHostInfo(this.initialHost);

  this.clusterId = WrapperProperties.CLUSTER_ID.get(this.properties);
  const hostInfoBuilder = this.hostListProviderService.getHostInfoBuilder();

  this.clusterInstanceTemplate = hostInfoBuilder
    .withHost(WrapperProperties.CLUSTER_INSTANCE_HOST_PATTERN.get(this.properties) ?? this.rdsHelper.getRdsInstanceHostPattern(this.originalUrl))
    .withPort(WrapperProperties.PORT.get(this.properties))
    .build();

  this.validateHostPatternSetting(this.clusterInstanceTemplate.host);
  this.rdsUrlType = this.rdsHelper.identifyRdsType(this.initialHost.host);
}
```

雛形は `HostInfo` として持つ。`host` が `?.abc123.us-east-1.rds.amazonaws.com` という文字列で、`port` はユーザ指定の値そのまま (未指定なら `undefined`)。プロパティ `clusterInstanceHostPattern` が優先で、なければ `getRdsInstanceHostPattern(originalUrl)` の結果になる。

`getRdsInstanceHostPattern` は [RdsUtils](../rds-utils/) で読んだとおり、`domain` グループが取れれば `?.<domain>`、取れなければ `"?"` を返す。

### 検証

[`rds_host_list_provider.ts#L268`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L268)。

```ts title="common/lib/host_list_provider/rds_host_list_provider.ts"
protected validateHostPatternSetting(hostPattern: string) {
  if (!this.rdsHelper.isDnsPatternValid(hostPattern)) {
    const message: string = Messages.get("RdsHostListProvider.invalidPattern.suggestedClusterId");
    logger.error(message);
    throw new AwsWrapperError(message);
  }

  const rdsUrlType: RdsUrlType = this.rdsHelper.identifyRdsType(hostPattern);
  if (rdsUrlType == RdsUrlType.RDS_PROXY || rdsUrlType == RdsUrlType.RDS_PROXY_ENDPOINT) {
    const message: string = Messages.get("RdsHostListProvider.clusterInstanceHostPatternNotSupportedForRDSProxy");
    logger.error(message);
    throw new AwsWrapperError(message);
  }

  if (rdsUrlType == RdsUrlType.RDS_CUSTOM_CLUSTER) {
    const message: string = Messages.get("RdsHostListProvider.clusterInstanceHostPatternNotSupportedForRdsCustom");
    logger.error(message);
    throw new AwsWrapperError(message);
  }
}
```

`isDnsPatternValid` は `pattern.includes("?")` の 1 行である ([`rds_utils.ts#L423`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L423))。3 つの検証は、

1. `?` を含むか
2. RDS Proxy の形ではないか (`?.proxy-xyz...` を渡すと、置換後が Proxy のエンドポイントになり、インスタンスに直接繋げない)
3. カスタムクラスタエンドポイントの形ではないか (同じ理由)

で、**「`?` だけ」は 1 を通り、`identifyRdsType("?")` は `OTHER` なので 2 と 3 も通る。**

### 雛形の適用

[`common/lib/host_list_provider/topology_utils.ts#L103`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/topology_utils.ts#L103)。

```ts title="common/lib/host_list_provider/topology_utils.ts"
public createHost(
  instanceId: string | undefined,
  instanceName: string | undefined,
  isWriter: boolean,
  weight: number,
  lastUpdateTime: number,
  initialHost: HostInfo,
  instanceTemplate: HostInfo,
  endpoint?: string,
  port?: number
): HostInfo {
  const hostname = !instanceName ? "?" : instanceName;
  const finalInstanceId = instanceId ?? hostname;

  if (!finalInstanceId) {
    throw new AwsWrapperError(Messages.get("TopologyUtils.instanceIdRequired"));
  }

  const finalEndpoint = endpoint ?? this.getHostEndpoint(hostname, instanceTemplate) ?? "";
  const finalPort = port ?? (instanceTemplate?.isPortSpecified() ? instanceTemplate?.port : initialHost?.port);

  const host: HostInfo = this.hostInfoBuilder
    .withHost(finalEndpoint)
    .withPort(finalPort ?? HostInfo.NO_PORT)
    .withRole(isWriter ? HostRole.WRITER : HostRole.READER)
    .withAvailability(HostAvailability.AVAILABLE)
    .withWeight(weight)
    .withLastUpdateTime(lastUpdateTime)
    .withHostId(finalInstanceId)
    .build();
  return host;
}

protected getHostEndpoint(hostName: string, clusterInstanceTemplate: HostInfo): string | null {
  if (!clusterInstanceTemplate || !clusterInstanceTemplate.host) {
    return null;
  }
  const host = clusterInstanceTemplate.host;
  return host.replace("?", hostName);
}
```

`host.replace("?", hostName)` は最初の `?` を 1 つだけ置き換える。`any-subdomain.?.my-domain.com` のように `?` が途中にあってもよいが、2 つ以上あると 2 つ目は残る。

`endpoint` 引数が渡されればそちらが優先で雛形は使われない。MySQL 系の Dialect でこの引数を渡しているものはなく、Aurora も Multi-AZ も `host` (インスタンス名) しか埋めない。Multi-AZ は `rds_topology` に完全なエンドポイントがあるのに、`endpoint.substring(0, endpoint.indexOf("."))` で先頭ラベルだけ切り出している ([`rds_multi_az_mysql_database_dialect.ts#L115`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L115))。雛形の経路を 1 本にするためである。

### ポートの扱い

雛形の `port` はユーザ指定の値をそのまま `withPort` に渡す。未指定なら `undefined` で、`isPortSpecified()` は `undefined != -1` で **true** になる。すると `createHost` の `finalPort` は `instanceTemplate.port` = `undefined` になり、最後の `finalPort ?? HostInfo.NO_PORT` で `-1` に落ちる。結果として HostInfo の `port` は `-1` で、`hostAndPort` はホスト名だけ、mysql2 が既定の 3306 に繋ぐ。動作は正しいが、`isPortSpecified` の意図は通っていない。

Multi-AZ は `rds_topology` の `port` 列を `TopologyQueryResult.port` に入れるので、雛形のポートは使われない。

### Global Database の雛形

Global Database はリージョンごとにドメインが違うので、雛形も `Map<region, HostInfo>` になる。`globalClusterInstanceHostPatterns` を `RdsUtils.parseInstanceTemplates` ([`rds_utils.ts#L291`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L291)) で分解し、各エントリに `validateHostPatternSetting` を当てる。`TopologyUtils.queryForTopology` の `instanceTemplate` 引数が `HostInfo | Map<string, HostInfo>` のユニオンなのはこのためだ。詳しくは [Aurora Global Database](../global-database/)。

## なぜそうなっているか

### なぜ DB がエンドポイントを返してくれないのか

`replica_host_status` は Aurora のストレージ層が各インスタンスの状態を共有するための表で、DNS 名を持つ理由がない。インスタンス名 (`server_id`) は Aurora の中で一意な識別子であり、それと DNS 名の対応は RDS の管理面 (エンドポイントの命名規則) にある。

ラッパはその命名規則を知っている (`<instance>.<xyz>.<region>.rds.amazonaws.com`) ので、`<xyz>.<region>...` の部分さえ分かれば復元できる。そして接続文字列がクラスタエンドポイントなら、その部分は接続文字列の中にある。「雛形を接続文字列から切り出す」のは、追加の API 呼び出しなしで済ませるための設計である。

### なぜ Proxy とカスタムクラスタは弾くのか

RDS Proxy 経由の接続先は Proxy であって、Proxy の後ろにどのインスタンスがいるかはクライアントから見えない。トポロジで得たインスタンス名を `?.proxy-xyz...` に当てても、そんな DNS 名は存在しない。カスタムクラスタエンドポイントも同じで、`instance-1.cluster-custom-xyz...` は解決できない。

弾かれる 2 種類は、どちらも「エンドポイントが 1 台を指していない」ものである。雛形が意味を持つのは、置換結果が必ず 1 台のインスタンスを指す場合だけだ。

### なぜ IP のときに例外を投げないのか

docs の `UsingTheNodejsWrapper.md` は「IP アドレスまたはカスタムドメインで接続する場合は必須」と書いている。しかしコードは `"?"` を受け入れる。理由はコードには書かれていない。`RdsHostListProvider` は MySQL Community 向けの `MySQLDatabaseDialect` では使われず、Aurora / Multi-AZ の Dialect でしか作られない。Dialect の自動判定 ([Dialect の自動判定](../dialect-resolution/)) は接続後に DB へ聞いて決まるので、`initSettings` の時点で「これは IP だが Aurora である」と分かっているとは限らず、init 時に例外にすると Aurora 以外の IP 接続まで巻き込む。そういう事情はありうるが、結果として設定漏れは接続エラーとしてしか現れない。

## どう活かすか

- **外部システムの識別子と接続先の対応は、規則が公開されているなら雛形で持つ。** マッピング表を持つより、`?` を 1 つ置き換える方が構成の変化に強い
- **雛形の検証は「置換結果が意味を持つか」で考える。** `?` の有無だけでなく、Proxy やカスタムエンドポイントのように「置換しても 1 台を指さない」形を弾いている
- **「必須」と書いた設定は、可能な限り早い段階で失敗させる。** ここでは検証が甘く、失敗が接続時まで遅れる。設定ミスの発見は init 時のほうが安い

### 実務で踏む失敗パターン

- **IP で繋いで `clusterInstanceHostPattern` を忘れる。** init は通り、トポロジ取得後にラッパは `instance-1` という素のインスタンス名に接続しようとして失敗する。エラーメッセージには `clusterInstanceHostPattern` という語は出ない。IP やカスタムドメインを使うなら `?.abc123.us-east-1.rds.amazonaws.com` の形で明示する
- **`?.my-domain.com` の DNS が本当に各インスタンスを指しているか。** カスタムドメインで CNAME を張るなら、`instance-1.my-domain.com` から `instance-N.my-domain.com` まで全部要る。1 台分しか張っていないと、そのインスタンス以外へのフェイルオーバーが名前解決で失敗する
- **クラスタエンドポイントの接続文字列でも、雛形は `?.<domain>` になる。** `getRdsInstanceHostPattern` はクラスタエンドポイントの `cluster-` 部分を落として `domain` だけを使う。インスタンスエンドポイントの命名規則と一致するので、明示設定は要らない
- **ポートを雛形で変えることはできない。** 雛形の `port` はユーザ指定の `port` と同じ値になる。インスタンスごとにポートが違う構成は Aurora には存在しないので、それでよい
