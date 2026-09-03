---
title: "トポロジクエリ (Aurora MySQL)"
description: "Aurora MySQL のトポロジは information_schema.replica_host_status を 1 回 SELECT するだけで手に入る。SESSION_ID = 'MASTER_SESSION_ID' の行が writer、5 分更新のない行は削除済みインスタンスとして落とし、weight は lag × 100 + cpu で計算する。同名の行や writer が 2 行あるときは LAST_UPDATE_TIMESTAMP の新しい方を信じる。"
group: "トポロジを知る"
sidebar:
  order: 26
---

## 何を学んだか

Aurora MySQL は自分のクラスタ構成を `information_schema.replica_host_status` という表で公開している ([Aurora MySQL の自己申告メタデータ](../aurora-metadata/))。ラッパはこれを 1 本の `SELECT` で読み、次の規則で `HostInfo[]` にする。

- **writer は `SESSION_ID = 'MASTER_SESSION_ID'` の行。** それ以外は reader
- **`LAST_UPDATE_TIMESTAMP` が 5 分より古い行は捨てる。** ただし writer 行は例外
- **`weight = round(lag) × 100 + round(cpu)`。** 小さいほど健全
- **同じインスタンス名が複数行あれば、`LAST_UPDATE_TIMESTAMP` が新しい方**
- **writer が 2 行以上あれば、同じく新しい方。0 行なら結果全体を `null` にする**

「writer が 0 行なら null」が肝で、これが [ClusterTopologyMonitor](../cluster-topology-monitor/) をパニックモードに入れる引き金になる。

## ソースコードのどこか

### クエリ定数

[`mysql/lib/dialect/aurora_mysql_database_dialect.ts#L30`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/aurora_mysql_database_dialect.ts#L30)。

```ts title="mysql/lib/dialect/aurora_mysql_database_dialect.ts"
private static readonly TOPOLOGY_QUERY: string =
  "SELECT server_id, CASE WHEN SESSION_ID = 'MASTER_SESSION_ID' THEN TRUE ELSE FALSE END as is_writer, " +
  "cpu, REPLICA_LAG_IN_MILLISECONDS as 'lag', LAST_UPDATE_TIMESTAMP as last_update_timestamp " +
  "FROM information_schema.replica_host_status " +
  // filter out nodes that haven't been updated in the last 5 minutes
  "WHERE time_to_sec(timediff(now(), LAST_UPDATE_TIMESTAMP)) <= 300 OR SESSION_ID = 'MASTER_SESSION_ID' ";
private static readonly HOST_ID_QUERY: string = "SELECT @@aurora_server_id as host";
private static readonly IS_READER_QUERY: string = "SELECT @@innodb_read_only as is_reader";
private static readonly IS_WRITER_QUERY: string =
  "SELECT server_id " +
  "FROM information_schema.replica_host_status " +
  "WHERE SESSION_ID = 'MASTER_SESSION_ID' AND SERVER_ID = @@aurora_server_id";
protected static readonly INSTANCE_ID_QUERY: string = "SELECT @@aurora_server_id as instance_id, @@aurora_server_id as instance_name";
```

この Dialect が DB に聞く「トポロジ関連」の質問は 5 つで、全部ここに並んでいる。

| 定数                | 質問                                 | 使う場所                                                        |
| ------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `TOPOLOGY_QUERY`    | 全インスタンスと役割・負荷           | `queryForTopology`                                              |
| `HOST_ID_QUERY`     | この接続のインスタンス名             | `identifyConnection`                                            |
| `IS_READER_QUERY`   | この接続は read-only か              | `getHostRole`                                                   |
| `IS_WRITER_QUERY`   | この接続のインスタンスは writer 行か | `getWriterId` ([「自分は writer か」](../am-i-a-writer/))       |
| `INSTANCE_ID_QUERY` | `[instanceId, instanceName]` の組    | `getInstanceId` ([identifyConnection](../identify-connection/)) |

`INSTANCE_ID_QUERY` が同じ `@@aurora_server_id` を 2 回返しているのは、Multi-AZ で `id` と名前が別物になるのに合わせた共通インタフェースだからである ([トポロジクエリ (Multi-AZ MySQL)](../topology-query-multi-az/))。

### 行を `TopologyQueryResult` にする

[`aurora_mysql_database_dialect.ts#L54`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/aurora_mysql_database_dialect.ts#L54)。

```ts title="mysql/lib/dialect/aurora_mysql_database_dialect.ts"
async queryForTopology(targetClient: ClientWrapper): Promise<TopologyQueryResult[]> {
  const res = await targetClient.query(AuroraMySQLDatabaseDialect.TOPOLOGY_QUERY);
  const results: TopologyQueryResult[] = [];
  const rows: any[] = res[0];
  rows.forEach((row) => {
    // According to the topology query the result set
    // should contain 4 columns: node ID, 1/0 (writer/reader), CPU utilization, node lag in time.
    const hostName: string = row["server_id"];
    const isWriter: boolean = row["is_writer"];
    const cpuUtilization: number = row["cpu"];
    const hostLag: number = row["lag"];
    const lastUpdateTime: number = row["last_update_timestamp"] ? Date.parse(row["last_update_timestamp"]) : Date.now();
    const result: TopologyQueryResult = new TopologyQueryResult({
      host: hostName,
      isWriter: isWriter,
      weight: Math.round(hostLag) * 100 + Math.round(cpuUtilization),
      lastUpdateTime: lastUpdateTime
    });
    results.push(result);
  });
  return results;
}
```

`res[0]` が行配列なのは mysql2 の `query()` が `[rows, fields]` を返すからだ ([mysql2 の接続とクエリ](../mysql2-connection-and-query/))。`host` に入るのはインスタンス名 (`server_id`) だけで、エンドポイントはまだない。`endpoint` と `port` は埋めないので、後で [雛形](../cluster-instance-host-pattern/) から組み立てられる。

`is_writer` は SQL 側で `CASE ... THEN TRUE ELSE FALSE` にしてある。MySQL の `TRUE` は `1` なので、mysql2 からは数値の `1` / `0` で届く。`isWriter: boolean` と書いてあるが実体は数値で、後段は `if (isWriter)` の真偽判定しかしないので問題にならない。

### `HostInfo[]` にして writer を検証する

[`common/lib/host_list_provider/aurora_topology_utils.ts#L28`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/aurora_topology_utils.ts#L28)。

```ts title="common/lib/host_list_provider/aurora_topology_utils.ts"
async queryForTopology(targetClient, dialect, initialHost, clusterInstanceTemplate): Promise<HostInfo[]> {
  if (!isDialectTopologyAware(dialect)) {
    throw new TypeError(Messages.get("RdsHostListProvider.incorrectDialect"));
  }

  return await dialect
    .queryForTopology(targetClient)
    .then((res: TopologyQueryResult[]) => this.verifyWriter(this.createHosts(res, initialHost, clusterInstanceTemplate)));
}

public createHosts(topologyQueryResults: TopologyQueryResult[], initialHost: HostInfo, clusterInstanceTemplate: HostInfo): HostInfo[] {
  const hostsMap = new Map<string, HostInfo>();
  topologyQueryResults.forEach((row) => {
    const lastUpdateTime = row.lastUpdateTime ?? Date.now();

    const host = this.createHost(row.id, row.host, row.isWriter, row.weight, lastUpdateTime, initialHost, clusterInstanceTemplate, row.endpoint, row.port);

    const existing = hostsMap.get(host.host);
    if (!existing || existing.lastUpdateTime < host.lastUpdateTime) {
      hostsMap.set(host.host, host);
    }
  });

  return Array.from(hostsMap.values());
}
```

`createHosts` は `host` (エンドポイント) をキーにした `Map` で重複を潰し、新しい `lastUpdateTime` を残す。その後 `verifyWriter` ([`topology_utils.ts#L151`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/topology_utils.ts#L151)) が writer の数を数える。

```ts title="common/lib/host_list_provider/topology_utils.ts"
protected async verifyWriter(allHosts: HostInfo[]): Promise<HostInfo[]> {
  if (allHosts === null || allHosts.length === 0) {
    return null;
  }

  const hosts: HostInfo[] = [];
  const writers: HostInfo[] = [];

  for (const host of allHosts) {
    if (host.role === HostRole.WRITER) {
      writers.push(host);
    } else {
      hosts.push(host);
    }
  }

  const writerCount = writers.length;
  if (writerCount === 0) {
    return null;
  } else if (writerCount === 1) {
    hosts.push(writers[0]);
  } else {
    // Assume the latest updated writer instance is the current writer. Other potential writers will be ignored.
    const sortedWriters: HostInfo[] = writers.sort((a, b) => {
      return b.lastUpdateTime - a.lastUpdateTime; // reverse order
    });
    hosts.push(sortedWriters[0]);
  }

  return hosts;
}
```

戻り値の並びは「reader 全部、最後に writer 1 台」になる。writer が 0 なら `null` で、`ClusterTopologyMonitorImpl.fetchTopologyAndUpdateCache` は `null` をキャッシュに書かず、呼び出し元の `monitor()` は「取得失敗」としてパニックモードに入る ([`cluster_topology_monitor.ts#L563`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/cluster_topology_monitor.ts#L563))。

複数 writer のときに捨てられた方は結果から消える。reader としても残らない。

### 役割の質問

`getHostRole` は `@@innodb_read_only` を見る ([`aurora_mysql_database_dialect.ts#L82`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/aurora_mysql_database_dialect.ts#L82))。

```ts title="mysql/lib/dialect/aurora_mysql_database_dialect.ts"
async getHostRole(targetClient: ClientWrapper): Promise<HostRole> {
  const res = await targetClient.query(AuroraMySQLDatabaseDialect.IS_READER_QUERY);
  return Promise.resolve(res[0][0]["is_reader"] === 1 ? HostRole.READER : HostRole.WRITER);
}
```

`getWriterId` は `replica_host_status` を自分の `@@aurora_server_id` で絞る ([`#L87`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/aurora_mysql_database_dialect.ts#L87))。

```ts title="mysql/lib/dialect/aurora_mysql_database_dialect.ts"
async getWriterId(targetClient: ClientWrapper): Promise<string | null> {
  const res = await targetClient.query(AuroraMySQLDatabaseDialect.IS_WRITER_QUERY);
  try {
    const writerId: string = res[0][0]["server_id"];
    return writerId ? writerId : null;
  } catch (e: any) {
    if (e.message.includes("Cannot read properties of undefined")) {
      // Query returned no result, targetClient is not connected to a writer.
      return null;
    }
    throw e;
  }
}
```

0 行のとき `res[0][0]` が `undefined` になり、そのプロパティ参照で `TypeError` が飛ぶ。それを**メッセージの文字列で捕まえて** `null` に変換している。V8 のエラーメッセージ (`Cannot read properties of undefined`) に依存した分岐で、Node.js のバージョンで文言が変われば壊れる。行数を見れば済むところを例外で処理している珍しい箇所である。

2 つの質問は答えの出所が違う。`@@innodb_read_only` はそのインスタンスの InnoDB の状態で、`replica_host_status` はストレージ層経由で共有された「クラスタの見え方」である。この差が [「自分は writer か」を全ホストに聞く](../am-i-a-writer/) で両方を使う理由になる。

## なぜそうなっているか

### 5 分でなぜ切るか

`replica_host_status` の行は、インスタンスを削除してもすぐには消えない。各インスタンスが自分の行を定期的に更新する仕組みなので、更新が止まった行が残る。`LAST_UPDATE_TIMESTAMP` が 5 分以上前なら「もういない」と見なす、というのがコメントにある意図で、300 秒は Aurora 側の更新間隔に対して十分な余裕として選ばれている。

writer 行だけ例外にしているのは、writer が更新を止めているならそれはフェイルオーバー中で、その行を落としてしまうと「writer 0 行 → null」になり、さらに情報が減るからだ。落とすより「古い writer」を返して、後段の役割検証に任せる方がよい。

### なぜ 2 行あったら新しい方か

フェイルオーバー直後、新旧 2 台が短時間 `MASTER_SESSION_ID` を名乗ることがある。旧 writer が自分の行を更新しなくなるまでの間だ。`LAST_UPDATE_TIMESTAMP` が新しい方が「今も更新し続けている」ので、そちらを信じる。同名 2 行の重複潰しも同じ規則で、ここに時刻以外の根拠を持ち込まないのは、行の内容 (cpu や lag) では新旧を判別できないからである。

### `weight` の式

`lag × 100 + cpu` は「レプリカ遅延 1 ミリ秒 = CPU 使用率 100%」という換算になる。lag が数十ミリ秒あれば cpu の差は無視できる大きさになり、実質「lag で並べて、同点なら cpu」という辞書式順序に近い。この `weight` を読んでいるのは `HighestWeightHostSelector` (Limitless 専用、PG) と `RoundRobinHostSelector.setRoundRobinHostWeightPairsProperty` だけで、MySQL の既定経路 (`random` 戦略) では使われない。計算しているのに使われていない値である。

## どう活かすか

- **自己申告メタデータには「いなくなった行」が残る前提で読む。** 更新時刻でフィルタする、というのは監視や在庫のような表全般に使える
- **「正が 1 つのはず」の値が 2 つあったときの規則を先に決めておく。** ここでは更新時刻で、例外を投げない。フェイルオーバー中は「2 つある」のが正常状態だからである
- **正が 0 のときは空リストではなく `null` を返す。** 空リストは「クラスタに 0 台」で、`null` は「今は信じられる答えがない」。この区別で監視タスクがモードを切り替えている

### 実務で踏む失敗パターン

- **`replica_host_status` を読むには権限が要らないが、行の数はクラスタ全体。** 15 台のクラスタでも 1 クエリで済む
- **削除直後のインスタンスは 5 分間トポロジに残る。** そこへ接続を試みて失敗し、`NOT_AVAILABLE` になってから外れる。5 分以内に同名で作り直すと、古い行と新しい行が同名で並び、新しい方が勝つ
- **`lastUpdateTime` は DB の時計。** `Date.parse` した値をクライアントの `Date.now()` と比べる箇所はないので時計のずれは効かないが、`last_update_timestamp` が空の行はクライアント時刻で埋まる
