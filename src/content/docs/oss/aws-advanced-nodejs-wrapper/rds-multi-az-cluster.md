---
title: "RDS Multi-AZ DB Cluster — Aurora と何が違うか"
description: "RDS Multi-AZ DB Cluster は writer 1 台と読み取り可能なスタンバイ 2 台を半同期レプリケーションで結ぶ構成で、共有ストレージの Aurora とは別物である。トポロジ表 mysql.rds_topology には役割の列がなく、writer は SHOW REPLICA STATUS の Source_Server_Id から逆算する。識別子も @@server_id / @@read_only と素の MySQL のものを使う。ラッパはこの違いを Dialect 1 枚と FailoverRestriction 2 つに閉じ込めている。"
group: "前提 — Aurora MySQL と mysql2"
sidebar:
  order: 3
---

## 何を学んだか

RDS Multi-AZ DB Cluster は、名前も エンドポイントの形 (`cluster-` / `cluster-ro-`) も Aurora とそっくりだが、中身は**素の MySQL 3 台を半同期レプリケーションで繋いだもの**である。writer 1 台と、読み取りに使えるスタンバイ 2 台。共有ストレージはなく、各インスタンスが自分のデータを持つ。

ラッパから見た違いは 3 点に集約される。

| 観点              | Aurora MySQL                                                   | RDS Multi-AZ DB Cluster                            |
| ----------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| トポロジ表        | `information_schema.replica_host_status` (役割・CPU・遅延つき) | `mysql.rds_topology` (id / endpoint / port のみ)   |
| writer の判定     | `SESSION_ID = 'MASTER_SESSION_ID'` の行                        | `SHOW REPLICA STATUS` の `Source_Server_Id` で逆算 |
| 自分の識別 / 役割 | `@@aurora_server_id` / `@@innodb_read_only`                    | `@@server_id` / `@@read_only`                      |

そして、切り替えの性質も違う。マイナーバージョンアップグレード時の切り替えが **1 秒前後**で、旧 writer がすぐ reader に戻る。このため failover v1 の「旧 writer への再接続を待つ Task A」は無効化される。docs が動作確認済みと明言しているのは `failover` (v1)・`efm`・`auroraConnectionTracker` の 3 つで、`failover2` は含まれていない。

## ソースコードのどこか

### Dialect 1 枚に全部ある

[`mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts) は 181 行で、Multi-AZ 固有の知識はここに閉じている。クエリ定数を先に全部並べる ([`#L31`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L31))。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
export class RdsMultiAZClusterMySQLDatabaseDialect extends MySQLDatabaseDialect implements TopologyAwareDatabaseDialect {
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

Aurora 版 ([Aurora MySQL の自己申告メタデータ](../aurora-metadata/)) と見比べると、`aurora_` の付く変数が 1 つもない。全部、コミュニティ MySQL にある変数と `SHOW` 文である。`mysql.rds_topology` だけが RDS 固有で、それは Blue/Green とも共有される表だ ([`mysql.rds_topology`](../rds-topology-table/))。

### writer は「誰のレプリカか」から逆算する

`queryForTopology` ([`#L77`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L77)) は 2 段で動く。

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
```

まず `SHOW REPLICA STATUS` を打つ。reader で打てば、レプリケーション元 (= writer) の `Source_Server_Id` が返る。writer で打てば結果は空で、そのときは `@@server_id` (自分自身) が writer になる。この writerHostId を持って `rds_topology` の全行を読み、`id === writerHostId` の行だけ `isWriter: true` にする ([`#L105`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L105))。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
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
  id: id,
});
```

`weight: 0` に注目してほしい。Aurora 版は `lag × 100 + cpu` で reader の重み付けをするが、Multi-AZ には CPU も遅延も表に無いので全員 0、reader 選択はただのランダムになる。`host` はエンドポイントの先頭ラベル (`instance-1.abc.us-east-1.rds.amazonaws.com` → `instance-1`) で、`id` は `db-WQFQ...` のような RDS リソース ID である。Aurora ではこの 2 つが同じ文字列だったが、Multi-AZ では別物として扱う (`TopologyUtils.getInstanceId` のコメント参照)。

### Dialect の判定条件が 3 段

`isDialect` ([`#L44`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L44)) は、この接続先が Multi-AZ かどうかを次の順で確かめる。

1. `information_schema.tables` に `mysql.rds_topology` があるか
2. その表を実際に `SELECT` できるか
3. `SHOW VARIABLES LIKE 'report_host'` の値が空でないか

3 番目が要るのは、**Blue/Green デプロイ中の素の RDS MySQL や Aurora MySQL にも `rds_topology` が現れる**からで、表の存在だけでは Multi-AZ と断定できない。`report_host` はレプリケーション構成でレプリカが自分のホスト名をソースに申告するための変数で、Multi-AZ ではこれが設定されている。

### FailoverRestriction が 2 つ

[`#L178`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L178) と [`failover_restriction.ts`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/failover_restriction.ts)。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
getFailoverRestrictions(): FailoverRestriction[] {
  return [FailoverRestriction.DISABLE_TASK_A, FailoverRestriction.ENABLE_WRITER_IN_TASK_B];
}
```

```ts title="common/lib/plugins/failover/failover_restriction.ts"
export enum FailoverRestriction {
  DISABLE_TASK_A,
  ENABLE_WRITER_IN_TASK_B,
}
```

failover v1 の writer フェイルオーバーは Task A (旧 writer に再接続し続ける) と Task B (reader 経由で新 writer が現れるのを待つ) を並走させる ([failover (v1)](../failover-v1/))。Multi-AZ ではこの enum によって Task A を止め、Task B が writer にも繋いでよいことにする。Aurora の `MySQLDatabaseDialect.getFailoverRestrictions()` は空配列を返す。詳細は [Multi-AZ 向け FailoverRestriction](../failover-restriction-multi-az/)。

### docs の「動作確認済み」と Known Issue

[`SupportForRDSMultiAzDBCluster.md`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/docs/using-the-nodejs-wrapper/SupportForRDSMultiAzDBCluster.md) の Limitations 節は、動作確認済みのプラグインを `auroraConnectionTracker`、`failover`、`efm` の 3 つに限定し、それ以外は「動くかもしれないし未定義の挙動になるかもしれない」と書いている。既定プラグインの `failover2` と `efm2` はどちらも入っていない。

Known Issues には、古いトポロジで別の writer を掴んでしまう失敗が書かれている。

> the failover process may fail to complete due to the stale topology returning the incorrect writer instance. This causes the wrapper to throw a FailoverFailedError with the message: "The new writer was identified to be 'instance endpoint', but querying the instance for its role returned a reader."

半同期レプリケーションで `rds_topology` の更新が各インスタンスに伝わる前に、`SHOW REPLICA STATUS` の答えとの整合が取れないタイミングがある、ということだ。

## なぜそうなっているか

### 共有ストレージが無いから、reader は「誰のレプリカか」を知っている

Aurora の reader は writer と直接のレプリケーション関係を持たない (ストレージ層を介して同じデータを読むだけ)。だから Aurora には `SHOW REPLICA STATUS` に相当するものがなく、代わりにストレージ層由来の `replica_host_status` がある。

Multi-AZ は素の MySQL のレプリケーションなので、reader は `Source_Server_Id` を持っている。「トポロジ表には役割が無いが、レプリカに聞けばソースが分かる」という構造を、ラッパはそのまま 2 段クエリにしている。RDS 側が `rds_topology` に role 列を足さなかったのは、この表が Blue/Green の「role」(SOURCE / TARGET) と共有されていて、そちらは writer/reader とは別の意味だからだと読める ([`mysql.rds_topology`](../rds-topology-table/))。

### 1 秒切り替えは、旧 writer が生き続けることを意味する

Multi-AZ の切り替えは、スタンバイの 1 台が昇格し、旧 writer は再起動後にレプリカとして復帰する。この過程が速いので、failover v1 の Task A (「旧 writer が writer として戻ってくるかもしれないから再接続を試す」) は無駄になるどころか、**reader に戻った旧 writer を writer と誤認する**危険がある。`DISABLE_TASK_A` はそれを止めるためのものだ。

一方で `ENABLE_WRITER_IN_TASK_B` は、Task B が reader 経由でトポロジを取ったとき、writer に直接繋いでもよいことにする。Aurora ではフェイルオーバー中の writer 接続が信用できないので Task B は reader 限定だったが、Multi-AZ では切り替え後の writer はすぐ安定するという前提である。

### docs が failover2 を挙げていない理由

failover2 は「全ホストに `am I a writer?` を聞く」設計で、これは Aurora の `IS_WRITER_QUERY` (`SESSION_ID = 'MASTER_SESSION_ID' AND SERVER_ID = @@aurora_server_id`) を前提にしている。Multi-AZ の `getWriterId` は `SHOW REPLICA STATUS` が空なら自分を writer とみなすので、コード上は動くが、レプリケーション停止中のインスタンスも writer に見える可能性がある。docs が慎重に v1 だけを挙げているのは、こうしたケースの検証が済んでいないからだろう。

## どう活かすか

- **同じ形のエンドポイントでも、裏の仕組みが違えばメタデータの取り方も変わる。** Aurora と Multi-AZ を「RDS のクラスタ」と一括りにせず、どの system table / 変数が信頼できるかを個別に確かめる
- **役割が表に無いなら、逆方向の関係から復元する。** 「誰がソースか」をレプリカに聞くのは、レプリケーション構成一般に使える手である
- **切り替えの速さは、失敗モードも変える。** 速いほど「旧 writer が別の役割で生きている」時間が長くなり、再接続先の検証が重要になる
- **docs の「動作確認済み」リストを信じる。** 既定が `failover2,efm2` でも、Multi-AZ なら `plugins: "auroraConnectionTracker,failover,efm"` と明示するのが docs の推奨に沿う

### 実務で踏む失敗パターン

- **IAM 認証ユーザに `mysql.*` の SELECT 権限を付け忘れる。** `rds_topology` は `mysql` スキーマにあるので、`GRANT SELECT ON mysql.* TO user@'%'` が要る。無いとトポロジ取得が `RdsMultiAZMySQLDatabaseDialect.invalidQuery` で落ちる
- **Dialect が `rds-mysql` のまま止まる。** `report_host` が空だと Multi-AZ と判定されず、トポロジ非対応の Dialect で動く。`LOG_LEVEL=debug` で Dialect 名を確認する
- **`failoverClusterTopologyRefreshRateMs` を既定 2000ms のままにする。** docs は 1 秒切り替えを活かすなら 100ms まで下げることを勧めている。ただし切り替え中の DB 負荷は上がる
