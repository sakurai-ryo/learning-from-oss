---
title: "HostListProvider 2 種 — 接続文字列 vs RDS トポロジ"
description: "ホスト一覧の出所は 2 つしかない。接続文字列を分解するだけの ConnectionStringHostListProvider と、DB に SQL で聞く RdsHostListProvider である。どちらを使うかは DatabaseDialect が決め、PluginService はその違いを forceMonitoringRefresh の有無で見分ける。前者は mysql2 の PoolCluster と同じ静的リストで、ラッパの「Advanced」は後者から始まる。"
group: "トポロジを知る"
sidebar:
  order: 25
---

## 何を学んだか

`HostListProvider` はラッパの中で「今クラスタに何台いて、どれが writer か」を答える唯一のインタフェースで、実装は 2 系統ある。

|                | `ConnectionStringHostListProvider`            | `RdsHostListProvider`                                           |
| -------------- | --------------------------------------------- | --------------------------------------------------------------- |
| 出所           | 接続文字列 (カンマ区切り)                     | `information_schema.replica_host_status` / `mysql.rds_topology` |
| 役割の根拠     | URL の形、または並び順                        | SQL の結果                                                      |
| 更新           | しない (`refresh` は初期化した配列を返すだけ) | 30 秒キャッシュ + 監視タスク                                    |
| `getHostRole`  | 例外                                          | Dialect に聞く                                                  |
| `getClusterId` | 例外                                          | プロパティの `clusterId`                                        |
| 作る Dialect   | `MySQLDatabaseDialect` (Community MySQL)      | Aurora / Multi-AZ の Dialect                                    |

前者は mysql2 の `PoolCluster` と同じ「アプリが列挙したリスト」の域を出ない。後者を `PluginService` が `DynamicHostListProvider` として扱うことで、フェイルオーバーやモニタが成立する。

## ソースコードのどこか

### インタフェース

[`common/lib/host_list_provider/host_list_provider.ts#L24`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/host_list_provider.ts#L24)。

```ts title="common/lib/host_list_provider/host_list_provider.ts"
export type StaticHostListProvider = HostListProvider;

export interface HostListProvider {
  refresh(): Promise<HostInfo[]>;
  forceRefresh(): Promise<HostInfo[]>;
  getHostRole(client: ClientWrapper, dialect: DatabaseDialect): Promise<HostRole>;
  identifyConnection(targetClient: ClientWrapper): Promise<HostInfo | null>;
  getHostProviderType(): string;
  getClusterId(): string;
}

export interface DynamicHostListProvider extends HostListProvider {
  forceMonitoringRefresh(shouldVerifyWriter: boolean, timeoutMs: number): Promise<HostInfo[]>;
}
```

`PluginService.isDynamicHostListProvider` はダックタイピングで判定する ([`plugin_service.ts#L329`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L329))。

```ts title="common/lib/plugin_service.ts"
isDynamicHostListProvider(): boolean {
  const provider = this.getHostListProvider();
  return provider !== null && typeof (provider as any).forceMonitoringRefresh === "function";
}
```

failover2 が呼ぶ `pluginService.forceMonitoringRefresh` は、この判定が false なら `UnsupportedMethodError` を投げる ([`#L342`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L342))。Community MySQL に failover2 を付けると、フェイルオーバーの入口でここに当たる。

### 誰が作るか

`AwsClient.internalConnect` ([`common/lib/aws_client.ts#L138`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/aws_client.ts#L138)) が Dialect に作らせる。

```ts title="common/lib/aws_client.ts"
protected async internalConnect() {
  await this.setup();
  const hostListProvider: HostListProvider = this.pluginService
    .getDialect()
    .getHostListProvider(this.properties, this.properties.get("host"), this.fullServiceContainer);
  this.pluginService.setHostListProvider(hostListProvider);
  await this.pluginService.refreshHostList();
  const initialHostInfo = this.pluginService.getInitialConnectionHostInfo();
  if (initialHostInfo != null) {
    await this.pluginManager.initHostProvider(initialHostInfo, this.properties, this.fullServiceContainer.hostListProviderService);
    await this.pluginService.refreshHostList();
  }
}
```

`refreshHostList` が 2 回あるのは、間の `initHostProvider` パイプラインでプラグインが provider を差し替えられるからである ([9 本のパイプライン](../pipelines/))。Dialect が接続後に更新されたときも [`plugin_service.ts#L665`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L665) で作り直される。

MySQL 系の Dialect がどちらを返すかは 2 行で決まっている。

```ts title="mysql/lib/dialect/mysql_database_dialect.ts (L112)"
getHostListProvider(props: Map<string, any>, originalUrl: string, servicesContainer: FullServicesContainer): HostListProvider {
  return new ConnectionStringHostListProvider(props, originalUrl, this.getDefaultPort(), servicesContainer.hostListProviderService);
}
```

```ts title="mysql/lib/dialect/aurora_mysql_database_dialect.ts (L49)"
getHostListProvider(props: Map<string, any>, originalUrl: string, servicesContainer: FullServicesContainer): HostListProvider {
  const topologyUtils = new AuroraTopologyUtils(this, servicesContainer.hostListProviderService.getHostInfoBuilder());
  return new RdsHostListProvider(props, originalUrl, topologyUtils, servicesContainer);
}
```

Multi-AZ の Dialect も同じ `AuroraTopologyUtils` + `RdsHostListProvider` の組を返す ([`rds_multi_az_mysql_database_dialect.ts#L72`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L72))。違いは Dialect 側のクエリだけである。

### `ConnectionStringHostListProvider`

[`common/lib/host_list_provider/connection_string_host_list_provider.ts#L49`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/connection_string_host_list_provider.ts#L49)。

```ts title="common/lib/host_list_provider/connection_string_host_list_provider.ts"
init() {
  if (this.isInitialized) {
    return;
  }

  this.hostList.push(
    ...this.connectionUrlParser.getHostsFromConnectionUrl(this.initialHost, this.isSingleWriterConnectionString, this.initialPort, () =>
      this.hostListProviderService.getHostInfoBuilder()
    )
  );

  if (this.hostList && this.hostList.length == 0) {
    throw new AwsWrapperError(Messages.get("ConnectionStringHostListProvider.parsedListEmpty", this.initialHost));
  }

  this.hostListProviderService.setInitialConnectionHostInfo(this.hostList[0]);
  this.isInitialized = true;
}

refresh(): Promise<HostInfo[]> {
  this.init();
  return Promise.resolve(this.hostList);
}
```

`refresh` も `forceRefresh` も同じ配列を返す。役割の付け方は `ConnectionUrlParser` にある ([`connection_url_parser.ts#L68`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/connection_url_parser.ts#L68))。

```ts title="common/lib/utils/connection_url_parser.ts"
hosts.forEach((pair, i) => {
  let host: HostInfo;
  if (singleWriterConnectionString) {
    const role: HostRole = i > 0 ? HostRole.READER : HostRole.WRITER;
    host = this.parseHostPortPair(pair, fallbackPort, builderFunc, role);
  } else {
    host = this.parseHostPortPair(pair, fallbackPort, builderFunc);
  }
  // ...
});
```

`singleWriterConnectionString: true` なら先頭が writer で残りが reader。そうでなければ 1 台ずつ `RdsUtils.identifyRdsType` を通し、`RDS_READER_CLUSTER` だけ `READER`、それ以外は全部 `WRITER` になる ([`#L61`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/connection_url_parser.ts#L61))。

mysql2 の接続文字列は `mysql://user@host1,host2:3307/db` のようにカンマ区切りを書けるので ([`mysql_connection_url_parser.ts#L27`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/mysql_connection_url_parser.ts#L27))、複数台を渡すことはできる。ただし mysql2 自身はカンマ区切りを解釈しない。ラッパが先に分解して 1 台ずつ渡している。

`identifyConnection` だけは SQL を投げる。`SELECT CONCAT(@@hostname, ':', @@port)` の結果と `hostId` を突き合わせるが ([`#L82`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/connection_string_host_list_provider.ts#L82))、`hostId` は URL が RDS のインスタンス形式のときしか入らない ([`connection_url_parser.ts#L37`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/connection_url_parser.ts#L37)) ので、Community MySQL ではまず一致しない。

### `RdsHostListProvider`

`refresh` は 3 段構えである ([`rds_host_list_provider.ts#L208`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L208))。

```ts title="common/lib/host_list_provider/rds_host_list_provider.ts"
async getTopology(): Promise<FetchTopologyResult> {
  this.init();

  const storedTopology: HostInfo[] | null = this.getStoredTopology();

  if (!storedTopology) {
    // need to re-fetch the topology.

    if (!this.pluginService.isDialectConfirmed()) {
      // We need to confirm the dialect before creating a topology monitor so that it uses the correct SQL queries.
      // We will return the original hosts parsed from the connections string until the dialect has been confirmed.
      return new FetchTopologyResult(false, this.initialHostList);
    }

    const hosts = await this.forceRefreshMonitor(false, RdsHostListProvider.DEFAULT_TOPOLOGY_QUERY_TIMEOUT_MS);
    if (hosts && hosts.length > 0) {
      return new FetchTopologyResult(false, hosts);
    }
  }

  if (!storedTopology) {
    return new FetchTopologyResult(false, this.initialHostList);
  } else {
    return new FetchTopologyResult(true, storedTopology);
  }
}
```

1. `StorageService` の `Topology` キャッシュ (キー `clusterId`、有効期限 5 分、読むたび延長) にあればそれ
2. なければ、Dialect がまだ確認されていない間は接続文字列のリスト
3. Dialect 確認済みなら `ClusterTopologyMonitor` に 5 秒タイムアウトで取りに行かせる

`RdsHostListProvider` 自身は SQL を投げない。投げるのは監視タスクで、provider は `monitorService.runIfAbsent(ClusterTopologyMonitorImpl, clusterId, ...)` で取り出すか作る ([`#L113`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L113))。同じ `clusterId` の接続は同じモニタを共有する ([clusterId](../cluster-id/))。

`getCurrentTopology` ([`#L235`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L235)) だけは渡された接続で直接クエリを打つ。failover v1 が使う経路である。

### `PluginService` から見た差分

`refreshHostList` は provider の `refresh()` の結果を前回と比べ、変化があれば `notifyHostListChanged` で配る ([`plugin_service.ts#L367`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L367))。`ConnectionStringHostListProvider` は毎回同じ配列オブジェクトを返すので `updatedHostList !== this.hosts` が初回以外 false になり、何も起きない。`RdsHostListProvider` はキャッシュから取った配列を返すが、モニタが `updateTopologyCache` で新しい `Topology` を置くたびに別オブジェクトになるので、差分計算が走る。

### PoolCluster との対比

mysql2 の `PoolCluster` は `add(id, config)` で登録した静的リストを `_serviceableNodeIds` に持ち ([`lib/pool_cluster.js#L188`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/pool_cluster.js#L188))、`MASTER` / `SLAVE1` は単なる `id` で、役割を検証する経路はない。`ConnectionStringHostListProvider` はこれと同じ立ち位置で、`singleWriterConnectionString` の「先頭が writer」は `PoolCluster` で `MASTER` と名付けるのと同じ宣言でしかない。違いは `RdsHostListProvider` から始まる。役割を SQL で確かめ、リストを DB から取り直し、その差分をプラグインに配る。この 3 つが `PoolCluster` にはない。

## なぜそうなっているか

### Dialect が provider を決める

「どの SQL でトポロジを取るか」は DB の種類で決まる。Aurora は `replica_host_status`、Multi-AZ は `rds_topology`、Community MySQL にはそもそも表がない。だから provider の選択は Dialect の責務になっている。

Dialect は接続後に自動判定で更新されうる ([Dialect の自動判定](../dialect-resolution/))。`getTopology` が `isDialectConfirmed()` を見て、確認前は接続文字列のリストで我慢するのはそのためで、確認前にモニタを作ってしまうと間違った SQL を打つモニタが `clusterId` で共有されてしまう。

### provider は SQL を打たず、モニタに委ねる

failover v1 の時代は各接続が自分で `getCurrentTopology` を打っていた。接続が 100 本あれば 100 本が同時に `replica_host_status` を叩く。failover2 と `ClusterTopologyMonitor` の設計は「クラスタにつき 1 本の監視接続がトポロジを取り、全接続はキャッシュを読む」に変えた (`UsingTheFailover2Plugin.md` の Picture 1 と 2)。`RdsHostListProvider` が `StorageService` とモニタの間の薄い層になっているのは、この変更の結果である。

### `DynamicHostListProvider` をダックタイピングで見分ける

TypeScript のインタフェースは実行時に消えるので、`instanceof` では判定できない。`forceMonitoringRefresh` メソッドの有無で見るのは、「動的な provider とは forceMonitoringRefresh を持つもの」という定義そのものを実行時の判定に使っている。

## どう活かすか

- **「一覧の出所」をインタフェースにし、静的版を最初に作る。** 静的版は 100 行で済み、動的版のテストのベースラインにもなる
- **一覧を更新する側と読む側の間にキャッシュを置き、読む側は絶対にブロックしない。** `getTopology` はキャッシュがなければ 5 秒で諦めて接続文字列のリストを返す。読む側 (アプリのクエリ) がトポロジ取得で固まることはない
- **設定が確定する前の呼び出しには「暫定の答え」を用意する。** Dialect 確認前の `initialHostList` がそれで、例外にすると初期接続の途中で使えない

### 実務で踏む失敗パターン

- **Community MySQL に `failover2` を付ける。** provider が静的なので `forceMonitoringRefresh` が `UnsupportedMethodError` になる。Dialect が `mysql` に落ちたときの症状として覚えておく
- **複数ホストの接続文字列で `singleWriterConnectionString` を忘れる。** 全部 `WRITER` として扱われる。reader に書き込みが向き、`errno 1290` で落ちる
- **`refresh()` が同じ配列を返すので `notifyHostListChanged` が来ない。** 静的 provider でホスト変化イベントを待つプラグインは動かない
