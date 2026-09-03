---
title: "`mysql.rds_topology` — Multi-AZ と Blue/Green が共有する表"
description: "mysql.rds_topology は RDS 側が用意した 1 枚の表で、Multi-AZ DB Cluster では「クラスタの 3 台」を、Blue/Green デプロイでは「blue と green のペア」を表す。同じ表を 3 つの MySQL Dialect が別の列の組で読み、RdsMultiAZ は id / endpoint / port を、Blue/Green 対応の 2 つは version / endpoint / port / role / status を取る。role 列が writer/reader ではなく SOURCE/TARGET を意味することが、この表を読むときの最大の注意点になる。"
group: "前提 — Aurora MySQL と mysql2"
sidebar:
  order: 5
---

## 何を学んだか

`mysql.rds_topology` は、RDS が MySQL 系エンジンに追加する表で、**その DB が属する「デプロイ」の他のエンドポイント一覧**を持つ。ラッパはこれを 2 つの意味で読む。

| 用途                | 読む列                                          | 行の意味                              | 読む Dialect                                            |
| ------------------- | ----------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Multi-AZ のトポロジ | `id`, `endpoint`, `port`                        | クラスタ内の 1 インスタンス           | `RdsMultiAZClusterMySQLDatabaseDialect`                 |
| Blue/Green の状態   | `version`, `endpoint`, `port`, `role`, `status` | blue または green の 1 エンドポイント | `RdsMySQLDatabaseDialect`, `AuroraMySQLDatabaseDialect` |

同じ表なのに、Multi-AZ 用の Dialect は `role` を読まず、Blue/Green 用は `id` を読まない。**`role` 列は writer/reader ではない**。Blue/Green の文脈で `BLUE_GREEN_DEPLOYMENT_SOURCE` / `BLUE_GREEN_DEPLOYMENT_TARGET` を取る列で、Multi-AZ のトポロジとしては役に立たない。だから Multi-AZ 版は writer を `SHOW REPLICA STATUS` から逆算する ([RDS Multi-AZ DB Cluster](../rds-multi-az-cluster/))。

そして、この表が「あるかどうか」だけでは何も断定できない。Multi-AZ にも、Blue/Green デプロイ中の素の RDS MySQL にも、Aurora MySQL 3.07 以上の Blue/Green にも現れる。

## ソースコードのどこか

### 3 つの Dialect が持つ、同じ 2 本のクエリ

存在確認と全件取得は、3 つの Dialect で文字通り同じ SQL である。

[`rds_mysql_database_dialect.ts#L23`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_mysql_database_dialect.ts#L23):

```ts title="mysql/lib/dialect/rds_mysql_database_dialect.ts"
export class RdsMySQLDatabaseDialect extends MySQLDatabaseDialect implements BlueGreenDialect {
  private static readonly BG_STATUS_QUERY: string = "SELECT * FROM mysql.rds_topology";

  private static readonly TOPOLOGY_TABLE_EXIST_QUERY: string =
    "SELECT 1 AS tmp FROM information_schema.tables WHERE" + " table_schema = 'mysql' AND table_name = 'rds_topology'";
```

[`aurora_mysql_database_dialect.ts#L45`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/aurora_mysql_database_dialect.ts#L45) にも同じ 2 行があり、[`rds_multi_az_mysql_database_dialect.ts#L31`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L31) は `SELECT id, endpoint, port FROM mysql.rds_topology` と列を絞っている。

Blue/Green 側の読み方は `getBlueGreenStatus` ([`rds_mysql_database_dialect.ts#L70`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_mysql_database_dialect.ts#L70))。

```ts title="mysql/lib/dialect/rds_mysql_database_dialect.ts"
async isBlueGreenStatusAvailable(clientWrapper: ClientWrapper): Promise<boolean> {
  try {
    const [rows] = await clientWrapper.query(RdsMySQLDatabaseDialect.TOPOLOGY_TABLE_EXIST_QUERY);
    return !!rows[0];
  } catch {
    return false;
  }
}

async getBlueGreenStatus(clientWrapper: ClientWrapper): Promise<BlueGreenResult[] | null> {
  const results: BlueGreenResult[] = [];
  const [rows] = await clientWrapper.query(RdsMySQLDatabaseDialect.BG_STATUS_QUERY);
  for (const row of rows) {
    results.push(new BlueGreenResult(row.version, row.endpoint, row.port, row.role, row.status));
  }
  return results.length > 0 ? results : null;
}
```

`BlueGreenResult` ([`blue_green_dialect.ts#L19`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/database_dialect/blue_green_dialect.ts#L19)) は 5 列をそのまま保持するだけの値オブジェクトで、解釈は呼び出し側に任せる。

### `role` と `status` の語彙

列の値を意味に変換するのは `BlueGreenRole.parseRole` と `BlueGreenPhase.parsePhase` である。

[`blue_green_role.ts#L20`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_role.ts#L20):

```ts title="common/lib/plugins/bluegreen/blue_green_role.ts"
export class BlueGreenRole {
  static readonly SOURCE = new BlueGreenRole("SOURCE", 0);
  static readonly TARGET = new BlueGreenRole("TARGET", 1);

  private static readonly blueGreenRoleMapping_1_0: Map<string, BlueGreenRole> = new Map<string, BlueGreenRole>()
    .set("BLUE_GREEN_DEPLOYMENT_SOURCE", BlueGreenRole.SOURCE)
    .set("BLUE_GREEN_DEPLOYMENT_TARGET", BlueGreenRole.TARGET);
```

[`blue_green_phase.ts#L38`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_phase.ts#L20):

```ts title="common/lib/plugins/bluegreen/blue_green_phase.ts"
private static readonly blueGreenStatusMapping: { [key: string]: BlueGreenPhase } = {
  AVAILABLE: BlueGreenPhase.CREATED,
  SWITCHOVER_INITIATED: BlueGreenPhase.PREPARATION,
  SWITCHOVER_IN_PROGRESS: BlueGreenPhase.IN_PROGRESS,
  SWITCHOVER_IN_POST_PROCESSING: BlueGreenPhase.POST,
  SWITCHOVER_COMPLETED: BlueGreenPhase.COMPLETED
};
```

つまり表の 1 行はこう読む。

```text
version | endpoint                                   | port | role                         | status
--------+--------------------------------------------+------+------------------------------+----------------------
1.0     | my-db.abc123.us-east-1.rds.amazonaws.com   | 3306 | BLUE_GREEN_DEPLOYMENT_SOURCE | AVAILABLE
1.0     | my-db-green-x7k2p9.abc123.us-east-1.rds... | 3306 | BLUE_GREEN_DEPLOYMENT_TARGET | AVAILABLE
```

`version` は語彙のバージョンで、`parseRole` は `"1.0"` 以外を受け取ると `Bgd.unknownVersion` で例外を投げる ([`#L44`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_role.ts#L44))。RDS 側が語彙を変えたとき、黙って誤読するのではなく落ちるようにしてある。

読む側は `BlueGreenStatusMonitor` の 1 か所 ([`blue_green_status_monitor.ts#L336`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_status_monitor.ts#L336)) で、`isBlueGreenStatusAvailable` が false なら「まだ Blue/Green は作られていない」(`NOT_CREATED`) とみなし、true なら `getBlueGreenStatus` を定期的に読んでフェーズ遷移を追う ([BlueGreenStatusMonitor](../blue-green-status-monitor/))。

### Multi-AZ 側の読み方

Multi-AZ 版は列を 3 つに絞り、`role` を見ない ([`rds_multi_az_mysql_database_dialect.ts#L105`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L105))。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
// According to the topology query the result set
// should contain 3 columns: endpoint, id, and port
const endpoint: string = row["endpoint"];
const id: string = row["id"];
const port: number = row["port"];
const isWriter: boolean = id === writerHostId;
```

`isWriter` は表からではなく、直前に `SHOW REPLICA STATUS` で得た `writerHostId` との比較で決める。`INSTANCE_ID_QUERY` も同じ表を `WHERE id = @@server_id` で引き、`SUBSTRING_INDEX(endpoint, '.', 1)` でエンドポイントの先頭ラベルをインスタンス名として取り出す。

### 「表がある」だけでは Multi-AZ と言えない

`RdsMultiAZClusterMySQLDatabaseDialect.isDialect` ([`#L44`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L44)) が表の存在確認の後に `report_host` を見るのは、まさにこの共有のせいである。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
return await targetClient
  .query("SHOW VARIABLES LIKE 'report_host'")
  .then((res) => {
    // | Variable\_name | Value |
    // | :--- | :--- |
    // | report\_host | 0.0.0.0 |

    if (!res) {
      return false;
    }

    return !!res[0][0]["Value"];
  })
  .catch(() => false);
```

素の RDS MySQL に Blue/Green デプロイを作ると `rds_topology` が現れるが、`report_host` は空のままである。Multi-AZ DB Cluster はレプリケーション構成なので `report_host` が設定されている。この 1 変数で両者を分けている。

Dialect の候補順にもこの共有が影響する。`RdsMySQLDatabaseDialect.getDialectUpdateCandidates` は `[AURORA_MYSQL, RDS_MULTI_AZ_MYSQL]` を返し、`MySQLDatabaseDialect` (最初の推測) は `[RDS_MULTI_AZ_MYSQL, AURORA_MYSQL, RDS_MYSQL]` を返す。Multi-AZ を Aurora より先に試すのは、Aurora の判定 (`aurora_version`) が Multi-AZ で false になるのは自明だが、その逆は `rds_topology` の存在だけで誤判定しうるからで、より条件の厳しい Multi-AZ から落としていく ([Dialect の自動判定](../dialect-resolution/))。

## なぜそうなっているか

### RDS 側の設計: 「デプロイの仲間」を 1 枚の表に

Multi-AZ DB Cluster と Blue/Green デプロイは、どちらも「このインスタンスと組になっている他のエンドポイント群」を持つ。RDS はそれを別々の表にせず、`rds_topology` 1 枚に `role` と `status` を足す形で表現した。Multi-AZ では `role` / `status` に意味のある値が入らず (Multi-AZ 内の役割はレプリケーションの向きで決まる)、Blue/Green では `id` が主キー以上の意味を持たない。

クライアントから見ると、これは「表の形は同じだが語彙が用途で変わる」という状況で、ラッパは**用途ごとに別の Dialect メソッドを持ち、列の解釈をそちらに閉じ込める**ことで対応している。`TopologyAwareDatabaseDialect` (Multi-AZ) と `BlueGreenDialect` (Blue/Green) という別インタフェースになっているのは、その分離の表れである。

### なぜ `mysql` スキーマなのか

`information_schema` に置けば全ユーザが読めたはずだが、RDS は `mysql` スキーマを選んだ。RDS 固有の管理表 (`mysql.rds_configuration` など) と同じ場所に置く、という一貫性の判断だろう。結果として、IAM 認証で作る最小権限ユーザでは `GRANT SELECT ON mysql.*` を追加しないとトポロジが読めない ([`UsingTheIamAuthenticationPlugin.md`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/docs/using-the-nodejs-wrapper/using-plugins/UsingTheIamAuthenticationPlugin.md#connecting-with-multi-az-or-bluegreen-deployments))。

### Aurora MySQL 3.07 以上

README の Known Limitations に「Supported Aurora MySQL Versions: Engine Release 3.07 and above」とある。Aurora MySQL がこの表を Blue/Green 用に持つようになったのが 3.07 で、それ以前のバージョンでは `isBlueGreenStatusAvailable` が false を返し続け、`bg` プラグインは `NOT_CREATED` のまま何もしない。エラーにはならない。

## どう活かすか

- **同じ表でも、読む列の組が違えば別のインタフェースにする。** `TopologyAwareDatabaseDialect` と `BlueGreenDialect` を分けているから、Multi-AZ 用のコードが `role` を誤読する余地がない。外部が用意した多義的なスキーマを扱うときは、用途ごとにビューを切る
- **語彙にバージョンを付けて、未知なら落とす。** `version = "1.0"` 以外で例外を投げるのは、外部システムの出力を解釈するコードの正しい防御である。黙ってデフォルトに倒すと、切り替え中の誤ルーティングになる
- **存在確認は必要条件にすぎない。** 「表がある」で分岐せず、その用途で決定的な追加条件 (`report_host`) を探す
- **管理表の権限を接続ユーザに付けているか、先に確かめる。** アプリ用の最小権限ユーザで `SELECT * FROM mysql.rds_topology` が通るかを、プラグインを有効にする前に手で試す

### 実務で踏む失敗パターン

- **Blue/Green デプロイを作った瞬間に Dialect が変わる。** 素の RDS MySQL で `bg` プラグインなしで運用していても、デプロイ作成後は `rds_topology` が現れる。`rds-mysql` Dialect のままなら影響は無いが、`report_host` が何かの理由で設定されていると Multi-AZ と誤判定されうる
- **`role` を writer/reader と読む。** 自前で `rds_topology` を読むツールを書くとき、`BLUE_GREEN_DEPLOYMENT_SOURCE` を「writer」と解釈すると、切り替え後に逆になる。SOURCE は「切り替え前の本番側」でしかない
- **切り替え中に `status` を見ずに繋ぐ。** `SWITCHOVER_IN_PROGRESS` の間、blue 側は書き込みを止める。ラッパの `bg` プラグインはこの期間に接続を一時停止する ([BlueGreenStatusProvider](../blue-green-status-provider/))
