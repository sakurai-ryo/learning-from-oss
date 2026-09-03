---
title: "トポロジクエリ (Multi-AZ MySQL)"
description: "RDS Multi-AZ DB Cluster の mysql.rds_topology には id・endpoint・port しかなく、誰が writer かは書かれていない。ラッパは SHOW REPLICA STATUS の Source_Server_Id を読んで writer の id を割り出し、それが空なら「自分が writer」と判断する。Aurora と同じ AuroraTopologyUtils を使い回すために、Dialect 側で結果の形を揃えている。"
group: "トポロジを知る"
sidebar:
  order: 27
---

## 何を学んだか

Multi-AZ DB Cluster は Aurora ではなく、通常の MySQL レプリケーションで 3 台を組んだものだ ([RDS Multi-AZ DB Cluster](../rds-multi-az-cluster/))。`information_schema.replica_host_status` はなく、代わりに `mysql.rds_topology` という表がある。しかしこの表は**役割を持たない**。

そこでラッパは、MySQL のレプリケーション標準の道具で writer を割り出す。

- reader で `SHOW REPLICA STATUS` を打つと `Source_Server_Id` に writer の `server_id` が入っている
- writer で打つと 0 行になる。0 行なら `@@server_id` (自分) が writer
- `rds_topology` の各行の `id` を、その writer id と比べて役割を決める

Aurora 版と違って `weight` は常に 0、`lastUpdateTime` は常にクライアントの `Date.now()` で、鮮度の判定はしない。

## ソースコードのどこか

### クエリ定数

[`mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L31`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L31)。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
private static readonly TOPOLOGY_QUERY: string = "SELECT id, endpoint, port FROM mysql.rds_topology";
private static readonly TOPOLOGY_TABLE_EXIST_QUERY: string =
  "SELECT 1 AS tmp FROM information_schema.tables WHERE" + " table_schema = 'mysql' AND table_name = 'rds_topology'";
// For reader hosts, the query should return a writer host id. For a writer host, the query should return no data.
private static readonly FETCH_WRITER_HOST_QUERY: string = "SHOW REPLICA STATUS";
private static readonly FETCH_WRITER_HOST_QUERY_COLUMN_NAME: string = "Source_Server_Id";
private static readonly HOST_ID_QUERY: string = "SELECT @@server_id AS host";
private static readonly HOST_ID_QUERY_COLUMN_NAME: string = "host";
private static readonly IS_READER_QUERY: string = "SELECT @@read_only AS is_reader";
private static readonly IS_READER_QUERY_COLUMN_NAME: string = "is_reader";
protected static readonly INSTANCE_ID_QUERY: string =
  "SELECT id as instance_id, SUBSTRING_INDEX(endpoint, '.', 1) as instance_name FROM mysql.rds_topology WHERE id = @@server_id";
```

Aurora 版と 1 対 1 で対応させると、

| 質問                         | Aurora                                  | Multi-AZ                                                |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------- |
| 全インスタンス               | `replica_host_status`                   | `rds_topology`                                          |
| writer は誰か                | `SESSION_ID = 'MASTER_SESSION_ID'` の行 | `SHOW REPLICA STATUS` の `Source_Server_Id`、空なら自分 |
| 自分の ID                    | `@@aurora_server_id`                    | `@@server_id`                                           |
| 自分は reader か             | `@@innodb_read_only`                    | `@@read_only`                                           |
| `[instanceId, instanceName]` | 両方 `@@aurora_server_id`               | `id` と `endpoint` の先頭ラベル                         |

Aurora 固有のシステム変数が全部 MySQL 標準のものに置き換わっている。`INSTANCE_ID_QUERY` が `WHERE id = @@server_id` で絞っているとおり、`rds_topology.id` は各インスタンスの `@@server_id` と一致する値で、これが `hostId` になる ([HostInfo と HostRole と可用性](../host-info/))。`topology_utils.ts` のコメントは `db-WQFQKBTL2LQUPIEFIFBGENS4ZQ` という例を挙げている。

### writer の割り出し

[`rds_multi_az_mysql_database_dialect.ts#L77`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L77)。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
async queryForTopology(targetClient: ClientWrapper): Promise<TopologyQueryResult[]> {
  try {
    let writerHostId: string = await this.executeTopologyRelatedQuery(
      targetClient,
      RdsMultiAZClusterMySQLDatabaseDialect.FETCH_WRITER_HOST_QUERY,
      RdsMultiAZClusterMySQLDatabaseDialect.FETCH_WRITER_HOST_QUERY_COLUMN_NAME
    );
    if (!writerHostId) {
      writerHostId = await this.identifyConnection(targetClient);
    }

    const res = await targetClient.query(RdsMultiAZClusterMySQLDatabaseDialect.TOPOLOGY_QUERY);
    const rows: any[] = res[0];
    return this.processTopologyQueryResults(writerHostId, rows);
  } catch (error: any) {
    throw new AwsWrapperError(Messages.get("RdsMultiAZMySQLDatabaseDialect.invalidQuery", error.message));
  }
}

private async executeTopologyRelatedQuery(targetClient: ClientWrapper, query: string, resultColumnName?: string): Promise<string> {
  const res = await targetClient.query(query);
  const rows: any[] = res[0];
  if (rows.length > 0) {
    return rows[0][resultColumnName ?? 0];
  }
  return "";
}
```

トポロジ 1 回につき SQL が 2〜3 本走る。`SHOW REPLICA STATUS`、(0 行なら) `SELECT @@server_id`、そして `SELECT ... FROM mysql.rds_topology`。Aurora 版は 1 本で済んでいた。

`executeTopologyRelatedQuery` は 0 行なら `""` を返す。Aurora 版の `getWriterId` が `TypeError` のメッセージで 0 行を検出していたのと違い、こちらは行数を見ている。同じ問題を同じリポジトリの隣のファイルで別の書き方で解いている。

### 行を `TopologyQueryResult` にする

[`#L105`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L105)。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
private async processTopologyQueryResults(writerHostId: string, rows: any[]): Promise<TopologyQueryResult[]> {
  const hosts: TopologyQueryResult[] = [];
  rows.forEach((row) => {
    // According to the topology query the result set
    // should contain 3 columns: endpoint, id, and port
    const endpoint: string = row["endpoint"];
    const id: string = row["id"];
    const port: number = row["port"];
    const isWriter: boolean = id === writerHostId;
    const host: TopologyQueryResult = new TopologyQueryResult({
      host: endpoint.substring(0, endpoint.indexOf(".")),
      isWriter: isWriter,
      weight: 0,
      lastUpdateTime: Date.now(),
      port: port,
      id: id
    });
    hosts.push(host);
  });
  return hosts;
}
```

`host` にはエンドポイントの先頭ラベル (インスタンス名) だけを入れる。`rds_topology` は完全なエンドポイントを持っているのに、それを `endpoint` フィールドに渡さない。こうすると `TopologyUtils.createHost` は Aurora と同じく [雛形](../cluster-instance-host-pattern/) から `host` を組み立てることになり、Aurora と Multi-AZ で経路が一本化される。`port` だけは行の値を使う。

`id === writerHostId` は文字列の厳密比較である。`SHOW REPLICA STATUS` の `Source_Server_Id` と `rds_topology.id` は、mysql2 の型変換で片方が数値になると一致しない。実際には両方が同じ型で届いているから動いているが、この比較は型に敏感だ。

### 役割の質問

`getHostRole` は `@@read_only` が `"0"` なら writer ([`#L127`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L127))。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
async getHostRole(client: ClientWrapper): Promise<HostRole> {
  return (await this.executeTopologyRelatedQuery(client, IS_READER_QUERY, IS_READER_QUERY_COLUMN_NAME)) == "0"
    ? HostRole.WRITER
    : HostRole.READER;
}
```

`== "0"` の緩い比較で、数値 `0` でも通る。Aurora 版の `=== 1` と対照的で、こちらは型を気にしていない。

`getWriterId` ([`#L137`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L137)) は `queryForTopology` の前半と同じで、`SHOW REPLICA STATUS` が空なら `identifyConnection` (自分の `@@server_id`) を返す。**この関数は常に非 null を返す。** Aurora 版は「自分が writer でなければ null」だったが、Multi-AZ 版は reader で呼ぶと「writer の id」を返す。`TopologyUtils.isWriterInstance` は `getWriterId(client) != null` で writer 判定するので ([`topology_utils.ts#L208`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/topology_utils.ts#L208))、Multi-AZ では reader 接続でも `isWriterInstance` が true になる。

[HostMonitor](../am-i-a-writer/) はその直後に `getHostRole` (`@@read_only`) で二重確認しているので、最終的な判定は正しくなる。だがコメント「First connection after failover may be stale」が想定していたのとは別の理由で、この二重確認が Multi-AZ では必須になっている。

### Dialect の判定

[`#L44`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L44)。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
async isDialect(targetClient: ClientWrapper): Promise<boolean> {
  let res = await targetClient.query(RdsMultiAZClusterMySQLDatabaseDialect.TOPOLOGY_TABLE_EXIST_QUERY).catch(() => false);
  if (!res) {
    return false;
  }

  res = await targetClient.query(RdsMultiAZClusterMySQLDatabaseDialect.TOPOLOGY_QUERY).catch(() => false);
  if (!res) {
    return false;
  }

  return await targetClient
    .query("SHOW VARIABLES LIKE 'report_host'")
    .then((res) => !!res[0][0]["Value"])
    .catch(() => false);
}
```

`rds_topology` があるだけでは Multi-AZ と決められない。Aurora MySQL 3.07 以降も Blue/Green 用に同じ表を持つ ([`mysql.rds_topology`](../rds-topology-table/))。3 段目の `report_host` が設定されているかで区別している。Multi-AZ は MySQL レプリケーションでインスタンス同士が繋がるため `report_host` が要るが、Aurora はレプリケーションを使わないので空である。

`getFailoverRestrictions` は `DISABLE_TASK_A` と `ENABLE_WRITER_IN_TASK_B` を返す ([`#L178`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L178))。failover v1 の writer フェイルオーバー手順を Multi-AZ 向けに変える印で、[Multi-AZ 向け FailoverRestriction](../failover-restriction-multi-az/) で読む。

## なぜそうなっているか

### `rds_topology` に役割がない

この表は RDS が Multi-AZ と Blue/Green のために用意したもので、「クラスタにどのエンドポイントがあるか」を答える表であって、役割は MySQL のレプリケーション状態から読めるはずだ、という設計になっている。役割は `SHOW REPLICA STATUS` で分かる。分かるものを二重に持たない、という MySQL 側の判断で、ラッパはその分の SQL を余計に打つ。

### `Source_Server_Id` を使う

`SHOW REPLICA STATUS` は reader (レプリカ) でしか行を返さない。その行の `Source_Server_Id` は「自分がレプリケーションしている相手の `server_id`」で、Multi-AZ ならそれが writer である。writer 自身は誰からもレプリケーションしていないので 0 行になる。

「0 行 = 自分が writer」という推論は、3 台構成で 1 台だけが writer という Multi-AZ の前提に依存している。多段レプリケーションや、切り替え途中で一時的に誰もレプリケーションしていない状態では成り立たない。`SupportForRDSMultiAzDBCluster.md` の Known Issues にある「古いトポロジが誤った writer を返し、`FailoverFailedError` になる」は、この推論が切り替え中に外れる典型である。

### `weight: 0` と `lastUpdateTime: Date.now()`

`rds_topology` には lag も cpu も更新時刻もない。だから重みは全員 0、更新時刻はクライアント時刻で埋める。Aurora 版の「5 分更新なしは捨てる」「新しい writer を信じる」は Multi-AZ では機能しない。Multi-AZ の 3 台は増減しないので、鮮度判定がなくても困らない、という前提がある。

## どう活かすか

- **共通インタフェース (`TopologyQueryResult`) に合わせるとき、足りない情報は「無害な定数」で埋める。** `weight: 0` は「重みで選ばない」、`Date.now()` は「古くならない」を意味し、後段のロジックを壊さない
- **標準の仕組み (`SHOW REPLICA STATUS`) で読めるなら、それを使う。** 独自メタデータを増やすより、既存の可観測性を組み合わせる方が移植性が高い。ただし「0 行 = 自分が主」のような推論は前提を明記する
- **同じインタフェースの実装同士で、戻り値の意味 (`getWriterId` の null) がずれていないか確認する。** ここではずれているが、呼び出し側の二重確認で吸収されている。吸収されていることに気づかず二重確認を外すと壊れる

### 実務で踏む失敗パターン

- **`SHOW REPLICA STATUS` には `REPLICATION CLIENT` 権限が要る。** アプリ用ユーザにこの権限がないと、Multi-AZ のトポロジ取得が例外になり `RdsMultiAZMySQLDatabaseDialect.invalidQuery` で落ちる。Aurora の `replica_host_status` は権限不要なので、Aurora から Multi-AZ に移すと初めて踏む
- **Aurora MySQL 3.07 以降で `rds_topology` があっても Multi-AZ と誤判定はしない。** `report_host` で区別している。ただし Aurora で `report_host` を手動設定しているなら誤判定する
- **切り替え直後は `Source_Server_Id` が旧 writer を指し続ける。** 数秒のずれで済むが、その間のトポロジは古い。failover v1 だけが動作確認済みとされているのは、この揺れを Task B の再試行で吸収する設計になっているからである
