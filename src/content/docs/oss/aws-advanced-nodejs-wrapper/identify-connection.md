---
title: "identifyConnection — この接続はどのインスタンスか"
description: "クラスタエンドポイントで繋いだ接続が実際にはどのインスタンスに着地したかは、DNS ではなく DB に聞くしかない。Aurora なら @@aurora_server_id、Multi-AZ なら rds_topology を @@server_id で引く。HostIdCacheService は接続先の文字列の種類で「聞かずに即答」「聞いてキャッシュ」「毎回聞く」を切り替え、環境変数でキャッシュを止められる。"
group: "トポロジを知る"
sidebar:
  order: 28
---

## 何を学んだか

`my-cluster.cluster-abc.us-east-1.rds.amazonaws.com` に繋いだとき、その TCP 接続の向こう側は `instance-1` かもしれないし `instance-2` かもしれない。ラッパは接続後にそれを特定して `HostInfo` に対応づける。これが `identifyConnection` で、3 段階になっている。

1. **接続先の文字列がインスタンスエンドポイントなら、聞かずに即答する。** DNS 名がそのままインスタンス名だから
2. **IP アドレスかカスタムドメインなら、一度聞いた結果をプロセス全体で永続キャッシュする。** 静的な宛先は変わらないと仮定する
3. **クラスタエンドポイントなど動的な宛先なら、毎回聞く**

「聞く」の実体は Dialect の `getInstanceId` で、Aurora は `SELECT @@aurora_server_id`、Multi-AZ は `rds_topology` を `@@server_id` で引く。

## ソースコードのどこか

### 入口 — `PluginService.identifyConnection`

[`common/lib/plugin_service.ts#L519`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L519)。

```ts title="common/lib/plugin_service.ts"
identifyConnection(targetClient: ClientWrapper): Promise<HostInfo | null>;
identifyConnection(targetClient: ClientWrapper, connectionHostInfo: HostInfo | null): Promise<HostInfo | null>;
identifyConnection(targetClient: ClientWrapper, connectionHostInfo?: HostInfo | null): Promise<HostInfo | null> {
  const hostIdCacheService = this.servicesContainer.hostIdCacheService;
  if (hostIdCacheService && connectionHostInfo) {
    return hostIdCacheService.identifyConnection(targetClient, connectionHostInfo, this);
  }

  const provider: HostListProvider | null = this.getHostListProvider();
  if (!provider) {
    return Promise.reject();
  }
  return provider.identifyConnection(targetClient);
}
```

オーバーロードが 2 つある。**接続に使った `HostInfo` を渡すとキャッシュ経由、渡さないと provider 直行**になる。呼び出し側を見ると、

| 呼ぶ側                                                                                                                                                                                                                                       | `connectionHostInfo` | 理由                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [initialConnection](../initial-connection-strategy/) ([`#L118`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/aurora_initial_connection_strategy_plugin.ts#L118))      | 渡さない             | クラスタエンドポイントで繋いだ直後で、着地先を確かめたい                                                          |
| [auroraConnectionTracker](../connection-tracker/) ([`#L72`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L72)) | 渡す                 | 全接続の `connect` に割り込む。クラスタ / IP / `OTHER` のときだけ呼び、インスタンスエンドポイントは自分で除外する |
| [efm (v1)](../efm-v1-vs-v2/) ([`#L71`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/efm/v1/host_monitoring_connection_plugin.ts#L71))                                 | 渡す                 | 同上。監視対象のホストを特定する                                                                                  |

### `HostIdCacheServiceImpl` — 宛先の種類で分ける

[`common/lib/utils/host_id_cache_service.ts#L55`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/host_id_cache_service.ts#L55)。

```ts title="common/lib/utils/host_id_cache_service.ts"
export class HostIdCacheServiceImpl implements HostIdCacheService {
  static readonly PROP_ENABLED = "AWS_NODEJS_HOST_CACHE_ENABLED";
  static readonly PROP_REGEXP = "AWS_NODEJS_HOST_CACHE_REGEXP";

  private static readonly cache = new Map<string, InstanceIdAndName>();
  private static readonly isEnabled = (process.env[HostIdCacheServiceImpl.PROP_ENABLED] ?? "true").toLowerCase() === "true";
  private static readonly hostRegexp = new RegExp(process.env[HostIdCacheServiceImpl.PROP_REGEXP] ?? ".*");
  private static readonly rdsHelper = new RdsUtils();

  async identifyConnection(targetClient: ClientWrapper, connectionHostInfo: HostInfo, pluginService: PluginService): Promise<HostInfo | null> {
    if (!targetClient || !connectionHostInfo || !pluginService) {
      return null;
    }

    const urlType: RdsUrlType = HostIdCacheServiceImpl.rdsHelper.identifyRdsType(connectionHostInfo.host);
    switch (urlType) {
      case RdsUrlType.RDS_INSTANCE:
        return connectionHostInfo;
      case RdsUrlType.IP_ADDRESS:
      case RdsUrlType.OTHER:
        // It might be a custom domain name. Cache the identification keyed by host name when allowed.
        if (HostIdCacheServiceImpl.isEnabled && HostIdCacheServiceImpl.hostRegexp.test(connectionHostInfo.host)) {
          return this.getCachedHostInfo(targetClient, connectionHostInfo, pluginService);
        }
        return pluginService.identifyConnection(targetClient);
      default:
        // Other hosts are dynamic and may change at any time, so they can't be cached.
        return pluginService.identifyConnection(targetClient);
    }
  }
```

3 つの経路は [RdsUtils.identifyRdsType](../rds-utils/) の結果で分かれる。

- `RDS_INSTANCE` は**渡された `HostInfo` をそのまま返す**。SQL を 1 本も打たない。`instance-1.abc.us-east-1.rds.amazonaws.com` に繋いだのなら着地先は `instance-1` に決まっている、という判断
- `IP_ADDRESS` / `OTHER` は静的キャッシュ。`process.env` から読む 2 つの環境変数で制御でき、`AWS_NODEJS_HOST_CACHE_ENABLED=false` で無効化、`AWS_NODEJS_HOST_CACHE_REGEXP` でキャッシュするホスト名を絞れる。環境変数は**モジュール読み込み時に 1 回だけ**読まれる (`static readonly`)
- それ以外 (クラスタエンドポイント、reader エンドポイント、カスタムエンドポイント、Proxy) は `pluginService.identifyConnection(targetClient)` の 1 引数版に戻り、provider に聞く

`default:` 側の `pluginService.identifyConnection(targetClient)` は `connectionHostInfo` なしで呼ぶので、`PluginService` 側で再びキャッシュサービスに入ることはない。

### キャッシュの中身

[`host_id_cache_service.ts#L86`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/host_id_cache_service.ts#L86)。

```ts title="common/lib/utils/host_id_cache_service.ts"
protected async getCachedHostInfo(targetClient, connectionHostInfo, pluginService): Promise<HostInfo | null> {
  const host = connectionHostInfo.host;

  let instanceIdAndName = HostIdCacheServiceImpl.cache.get(host);
  if (!instanceIdAndName) {
    instanceIdAndName = await this.queryInstanceIdAndName(targetClient, pluginService);
    HostIdCacheServiceImpl.cache.set(host, instanceIdAndName);
  }

  const [instanceId, instanceName] = instanceIdAndName;
  if (!instanceId && !instanceName) {
    // We've already tried to identify the connection, but got nothing.
    return null;
  }

  let topology = pluginService.getAllHosts();
  if (!topology || topology.length === 0) {
    const provider = pluginService.getHostListProvider();
    topology = provider ? await provider.forceRefresh() : null;
    if (!topology || topology.length === 0) {
      return null;
    }
  }

  return topology.find((candidate) => instanceId === candidate.hostId || instanceName === candidate.host) ?? null;
}
```

キャッシュに入るのは `HostInfo` ではなく `[instanceId, instanceName]` の組で、キーは接続先ホスト名。**期限がなく、失敗した結果 (`[null, null]`) もキャッシュされる。** 一度識別に失敗した IP は、プロセスを再起動するまで `null` を返し続ける。

組をトポロジと突き合わせる部分は `RdsHostListProvider.identifyConnection` ([`rds_host_list_provider.ts#L181`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L181)) と同じ条件である。

```ts title="common/lib/host_list_provider/rds_host_list_provider.ts"
async identifyConnection(targetClient: ClientWrapper): Promise<HostInfo | null> {
  const instanceIds: [string, string] = await this.topologyUtils.getInstanceId(targetClient);
  if (instanceIds.some((id) => !id)) {
    return null;
  }

  let topology = await this.refresh();
  if (!topology) {
    topology = await this.forceRefresh();
  }

  if (!topology) {
    return null;
  }

  const instanceId = instanceIds[0];
  const instanceName = instanceIds[1];
  return topology.find((host) => instanceId === host.hostId || instanceName === host.host) ?? null;
}
```

`instanceName === host.host` は、Aurora では `instance-1` と `instance-1.abc...` の比較なので一致しない。効いているのは `instanceId === host.hostId` の方で、`instanceName` の比較は雛形を使わずに `host` にインスタンス名だけが入る構成 (テストなど) のためにある。

### 質問の中身

Aurora は 1 本で済む ([`aurora_mysql_database_dialect.ts#L42`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/aurora_mysql_database_dialect.ts#L42))。

```sql
SELECT @@aurora_server_id as instance_id, @@aurora_server_id as instance_name
```

Multi-AZ は表を引く ([`rds_multi_az_mysql_database_dialect.ts#L41`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L41))。

```sql
SELECT id as instance_id, SUBSTRING_INDEX(endpoint, '.', 1) as instance_name
FROM mysql.rds_topology WHERE id = @@server_id
```

どちらも「今繋がっているセッションのサーバ側変数」を起点にしている。DNS を引き直したり、ソケットの相手 IP を見たりはしない。TCP の向こうで答えているサーバ自身に名乗らせる、というのが唯一確実な方法である。

### 静的 provider の場合

`ConnectionStringHostListProvider.identifyConnection` は `SELECT CONCAT(@@hostname, ':', @@port)` を打って `hostId` と比べる ([`connection_string_host_list_provider.ts#L82`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/connection_string_host_list_provider.ts#L82))。`hostId` は RDS インスタンス形式の URL でしか入らないので、Community MySQL ではほぼ `undefined` になる。identifyConnection を使うプラグイン (connectionTracker、efm v1) は、静的 provider では「識別できない」前提で動く。

## なぜそうなっているか

### DNS では分からない

クラスタエンドポイントは CNAME で、解決結果は TTL の間だけ正しい。しかも接続は解決した「当時の」IP に張られているので、後から DNS を引き直しても、この接続がどこに繋がっているかは分からない。接続の向こう側に名乗らせるしかない。

### インスタンスエンドポイントなら聞かない

`instance-1.abc.us-east-1.rds.amazonaws.com` は 1 台を指す固定の名前で、その先が別のインスタンスになることはない (Blue/Green の切り替えで名前が付け替わる例外はあるが、それは [別のプラグイン](../blue-green-switchover/) が扱う)。聞けば SQL 1 本分の往復が増えるだけなので、聞かない。

`auroraConnectionTracker` は自分の側でも `identifyRdsType` を見てインスタンスエンドポイントを除外しているので、この短絡に到達するのは efm v1 など他の呼び出し元である。どちらにせよ「インスタンスエンドポイントなら聞かない」という判断が 2 か所で重複して置かれている。

### IP とカスタムドメインはキャッシュする

`10.0.1.50` や `db.example.com` は、それ自体が「どのインスタンスか」の情報を持たない。聞くしかないが、聞いた結果は普通は変わらない。変わらないなら覚えておく。

ただし `db.example.com` がクラスタエンドポイントへの CNAME だと、フェイルオーバー後に着地先が変わる。それでもキャッシュは古い答えを返す。`AWS_NODEJS_HOST_CACHE_REGEXP` はこの構成のために用意された逃げ道で、「このホスト名はキャッシュしない」を正規表現で指定する。既定の `.*` は「全部キャッシュする」で、安全側ではなく速度側に倒してある。

### 失敗もキャッシュする

`[null, null]` をキャッシュするのは、識別できない接続先 (トポロジ非対応の DB や、`replica_host_status` を読めないユーザ) で毎回失敗クエリを打たないためだ。コメントの「We've already tried to identify the connection, but got nothing」がそれで、恒久的に諦める設計になっている。

## どう活かすか

- **「入力の種類」で戦略を変えるキャッシュは、種類の判定を 1 か所 (`identifyRdsType`) に寄せる。** 3 経路の分岐が `switch` 1 つに収まっているのは、判定が外にあるからだ
- **キャッシュに失敗結果を入れるなら、無効化の手段を必ず用意する。** ここでは環境変数 2 つ。ただし読み込みが起動時 1 回なので、動的には変えられない
- **「聞かなくて済む入力」を先に短絡する。** インスタンスエンドポイントの即答は、キャッシュより速く、キャッシュの整合性問題も起きない

### 実務で踏む失敗パターン

- **カスタムドメインがクラスタエンドポイントの CNAME。** フェイルオーバー後も `identifyConnection` が旧 writer を返す。`AWS_NODEJS_HOST_CACHE_REGEXP` にマッチしない値 (例: `^$`) を設定してキャッシュを止めるか、`AWS_NODEJS_HOST_CACHE_ENABLED=false` にする
- **環境変数は起動時に固定。** 設定を変えたらプロセス再起動が要る。`HostIdCacheServiceImpl.clearCache()` はテスト用で、アプリから呼ぶ想定ではない
- **キャッシュは `clusterId` で分かれていない。** キーはホスト名だけなので、同じ IP が別クラスタを指す構成 (ありえないが、テスト環境の toxiproxy などで起こる) では混ざる
- **`RDS_INSTANCE` の即答は `HostInfo` を検証しない。** 接続文字列から作った HostInfo の `role` が仮定のままでも、そのまま返る。役割の訂正は `connect()` 側の `getHostRole` に任されている ([HostInfo と HostRole と可用性](../host-info/))
