---
title: "Blue/Green の MySQL 側メタデータ"
description: "bg プラグインが読むのは mysql.rds_topology の version / endpoint / port / role / status の 5 列だけである。Multi-AZ のトポロジと同じ表を、別の列で読んでいる。BlueGreenDialect を実装するのは RDS MySQL と Aurora MySQL の 2 つの Dialect で、community MySQL は対象外。表がなければ NOT_CREATED、行がなければ null という 2 段の「ない」がある。"
group: "運用イベントを知る"
sidebar:
  order: 66
---

## 何を学んだか

Blue/Green の進行状況は、RDS が **`mysql.rds_topology` 表**に書き出す。[Multi-AZ のトポロジ](../topology-query-multi-az/)が読むのと同じ表だが、使う列が違う。

| 列         | Multi-AZ トポロジ          | Blue/Green                                                                                                                 |
| ---------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`       | インスタンス ID            | 使わない                                                                                                                   |
| `endpoint` | インスタンスエンドポイント | blue / green のエンドポイント                                                                                              |
| `port`     | ポート                     | ポート                                                                                                                     |
| `role`     | 使わない                   | `BLUE_GREEN_DEPLOYMENT_SOURCE` / `BLUE_GREEN_DEPLOYMENT_TARGET`                                                            |
| `status`   | 使わない                   | `AVAILABLE` / `SWITCHOVER_INITIATED` / `SWITCHOVER_IN_PROGRESS` / `SWITCHOVER_IN_POST_PROCESSING` / `SWITCHOVER_COMPLETED` |
| `version`  | 使わない                   | 表の形式のバージョン。今のところ `"1.0"` だけ                                                                              |

ラッパ側の読み方は `BlueGreenDialect` インタフェースの 2 メソッドで、**表があるか**と**行を全部取る**しかない。フェーズへの正規化と役割の絞り込みは [BlueGreenStatusMonitor](../blue-green-status-monitor/) が行う。

## ソースコードのどこか

### インタフェースと結果型

[`common/lib/database_dialect/blue_green_dialect.ts#L19`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/database_dialect/blue_green_dialect.ts#L19)。

```ts title="common/lib/database_dialect/blue_green_dialect.ts"
export class BlueGreenResult {
  constructor(version: string, endpoint: string, port: number, role: string, status: string) {
    /* ... */
  }
  get version(): string {
    return this._version;
  }
  get endpoint(): string {
    return this._endpoint;
  }
  get port(): number {
    return this._port;
  }
  get role(): string {
    return this._role;
  }
  get status(): string {
    return this._status;
  }
}

export interface BlueGreenDialect {
  isBlueGreenStatusAvailable(clientWrapper: ClientWrapper): Promise<boolean>;
  getBlueGreenStatus(clientWrapper: ClientWrapper): Promise<BlueGreenResult[] | null>;
}
```

`role` と `status` は文字列のままで、Dialect は解釈しない。

### RDS MySQL の実装

[`mysql/lib/dialect/rds_mysql_database_dialect.ts#L22`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_mysql_database_dialect.ts#L22)。

```ts title="mysql/lib/dialect/rds_mysql_database_dialect.ts"
export class RdsMySQLDatabaseDialect extends MySQLDatabaseDialect implements BlueGreenDialect {
  private static readonly BG_STATUS_QUERY: string = "SELECT * FROM mysql.rds_topology";

  private static readonly TOPOLOGY_TABLE_EXIST_QUERY: string =
    "SELECT 1 AS tmp FROM information_schema.tables WHERE" +
    " table_schema = 'mysql' AND table_name = 'rds_topology'";

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
}
```

`SELECT *` で取って `row.version` のように列名でアクセスする。mysql2 の `query()` は行をオブジェクトで返すので、列の順序には依存しない ([mysql2 の接続とクエリ](../mysql2-connection-and-query/))。

Aurora MySQL も同じ 2 クエリを持つ ([`aurora_mysql_database_dialect.ts#L45`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/aurora_mysql_database_dialect.ts#L45)、[`#L135`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/aurora_mysql_database_dialect.ts#L135))。実装は 1 文字も違わない。

MySQL 系 5 Dialect ([2 種類の Dialect](../two-dialects/)) のうち、`BlueGreenDialect` を名乗るのは次の 2 つと、Aurora を継承する Global の計 3 つである。

| Dialect               | `BlueGreenDialect` | 備考                                      |
| --------------------- | ------------------ | ----------------------------------------- |
| `mysql` (community)   | 実装しない         | `rds_topology` がない                     |
| `rds-mysql`           | 実装する           | 版の制約なし                              |
| `aurora-mysql`        | 実装する           | Aurora MySQL 3.07 以上                    |
| `global-aurora-mysql` | 継承で持つ         | docs は Global DB を非対応としている      |
| `rds-multi-az-mysql`  | 実装しない         | 同じ表をトポロジとして読むが、BG は非対応 |

### 行の例

コードの解釈に沿って書いた例である (実際の値はデプロイごとに異なる)。

```
version | endpoint                                             | port | role                          | status
--------+------------------------------------------------------+------+-------------------------------+-----------
1.0     | my-db.cluster-abc123.us-east-1.rds.amazonaws.com     | 3306 | BLUE_GREEN_DEPLOYMENT_SOURCE  | AVAILABLE
1.0     | my-db-green-x1y2z3.cluster-def456.us-east-1.rds...   | 3306 | BLUE_GREEN_DEPLOYMENT_TARGET  | AVAILABLE
```

blue から読んでも green から読んでも、切り離される前は**両方の行**が見える。モニタは自分の役割の行だけを残す。切り替え後、旧 blue (old1) からは行が消える。

### 解釈側の 3 つの parse

役割 ([`blue_green_role.ts#L44`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_role.ts#L44))。

```ts title="common/lib/plugins/bluegreen/blue_green_role.ts"
private static readonly blueGreenRoleMapping_1_0: Map<string, BlueGreenRole> = new Map<string, BlueGreenRole>()
  .set("BLUE_GREEN_DEPLOYMENT_SOURCE", BlueGreenRole.SOURCE)
  .set("BLUE_GREEN_DEPLOYMENT_TARGET", BlueGreenRole.TARGET);

public static parseRole(value: string, version: string): BlueGreenRole {
  if (version === "1.0") {
    // ...
    const role = BlueGreenRole.blueGreenRoleMapping_1_0.get(value.toUpperCase());
    if (role == null) {
      throw new AwsWrapperError(Messages.get("Bgd.unknownRole", value));
    }
    return role;
  }
  throw new AwsWrapperError(Messages.get("Bgd.unknownVersion", version));
}
```

`version` で対応表を切り替える作りになっていて、今は `"1.0"` しかない。モニタは未知の `version` を警告つきで `"1.0"` に丸めてから渡す ([`blue_green_status_monitor.ts#L353`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_status_monitor.ts#L353))。

フェーズ ([`blue_green_phase.ts#L46`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_phase.ts#L46)) は `value` が空なら `NOT_CREATED`、対応表にない文字列なら `Bgd.unknownStatus` を投げる。

### 「ない」の 2 段階

モニタの `collectStatus` は「ない」を 2 段階で区別する ([`blue_green_status_monitor.ts#L336`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_status_monitor.ts#L336))。

| 状況                                                     | `isBlueGreenStatusAvailable` | `getBlueGreenStatus` | モニタの解釈                                     |
| -------------------------------------------------------- | ---------------------------- | -------------------- | ------------------------------------------------ |
| 表がない (BGD 非対応の版、community)                     | false                        | 呼ばない             | `NOT_CREATED`、接続が生きていれば panic にしない |
| 表はあるが行がない (BGD 未作成、または切り離された old1) | true                         | `null`               | `currentPhase = null`                            |
| 行がある                                                 | true                         | 配列                 | 役割の行から phase を取る                        |
| クエリで構文エラー                                       | 例外                         |                      | `NOT_CREATED` に落として警告                     |

`null` と `NOT_CREATED` を分けているのは、Provider の `updatePhase` が `null` を「情報なし」として無視し、`NOT_CREATED` を「BGD がない」というフェーズとして扱うためである。old1 に繋いだままの SOURCE モニタが行を失っても、フェーズが `NOT_CREATED` に戻って「ロールバック」と誤検知されないのはこの区別による。

### ホスト名の接尾辞

表の `endpoint` 列には `-green-xxxxxx` や `-old1` の付いた名前が混ざる。`RdsUtils` の 4 メソッド ([`rds_utils.ts#L457`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L457)) がそれを扱う。

```ts title="common/lib/utils/rds_utils.ts"
public isGreenInstance(host: string) { /* BG_GREEN_HOST_PATTERN */ }
public isOldInstance(host: string): boolean { /* BG_OLD_HOST_PATTERN */ }
public isNotOldInstance(host: string): boolean { /* !BG_OLD_HOST_PATTERN、host が空なら true */ }
public removeGreenInstancePrefix(host: string): string {
  // ...
  const matcher = preparedHost.match(RdsUtils.BG_GREEN_HOST_PATTERN);
  const prefixGroup = matcher.groups?.prefix;
  return host.replace(prefixGroup, "");
}
```

`removeGreenInstancePrefix("my-db-green-x1y2z3.cluster-custom-...")` は `my-db.cluster-custom-...` を返す。Provider がカスタムエンドポイントの blue / green 対応を名前で引くときに使う ([BlueGreenStatusProvider](../blue-green-status-provider/))。

## なぜそうなっているか

### なぜ RDS API ではなく表なのか

Blue/Green の状態は RDS API (`DescribeBlueGreenDeployments`) でも取れる。表を選んだのは、**DB 接続の資格情報だけで読める**からである。[customEndpoint プラグイン](../custom-endpoint/)のように RDS API を叩く方式だと AWS 資格情報と IAM 権限が別に要る。Blue/Green は「既存アプリに `bg` を足すだけ」で使わせたい機能なので、DB 側にメタデータを出してもらう設計になっている。この方針は Aurora のトポロジを `replica_host_status` で取るのと同じである ([Aurora MySQL の自己申告メタデータ](../aurora-metadata/))。

### なぜ Multi-AZ と同じ表なのか

RDS 側の都合である。`mysql.rds_topology` は RDS が管理する内部表で、Multi-AZ DB Cluster では 3 インスタンスの一覧を、Blue/Green では 2 環境のステータスを書く。ラッパは列を選んで読み分けるだけで、表を増やしてもらってはいない。ただし docs は Multi-AZ DB Cluster での Blue/Green を非対応としている。同じ表に両方の意味の行が混ざるケースを扱っていないためと考えられる。

### なぜ version 列があるのか

`parseRole(value, version)` が `version` で分岐するのは、将来 RDS が列や値を変えたときに、**古いラッパが未知の形式を誤読しないため**である。今は `"1.0"` 以外を警告つきで `"1.0"` として読むので、実際には互換性を「緩く」取っている。

## どう活かすか

- **メタデータの「表がない」「行がない」「行がある」を区別する。** 2 段の「ない」を 1 つにまとめると、「まだ作られていない」と「切り離されて消えた」が同じ扱いになり、状態機械が誤動作する
- **外部形式には version を付け、読む側は version で分岐する。** 今は 1 つでも、分岐点を最初から置いておくと後から足せる
- **権限は「DB に繋げること」に寄せる。** 運用イベントの検知を DB 内の表に寄せると、AWS 側の権限設計 (IAM ポリシー、資格情報の配布) が不要になる。自前のシステムでも、クライアントに公開したいメタデータは既存の接続経路で読めるところに置く

### つまずきどころ

- **IAM ユーザには `GRANT SELECT ON mysql.*` が要る。** docs の [IAM 認証](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/docs/using-the-nodejs-wrapper/using-plugins/UsingTheIamAuthenticationPlugin.md) の "Connecting with Multi-AZ or Blue/Green Deployments" にある。権限がないと `isBlueGreenStatusAvailable` は information_schema で true を返すが `SELECT *` で失敗し、モニタは例外経路で panic に入って 100ms ごとに再試行を続ける
- **Aurora MySQL 3.07 未満では表がない。** そのときは `NOT_CREATED` のまま何も起きず、docs の言う「従来の挙動にフォールバック」になる。エラーにはならないので、対応版かどうかは自分で確認する
- **`SELECT *` なので列が増えても壊れない。** 逆に、列が減ったり名前が変わると `row.status` が `undefined` になり、`parsePhase(undefined)` は `NOT_CREATED` を返す。切り替えが始まっても気づかない、という壊れ方をする
