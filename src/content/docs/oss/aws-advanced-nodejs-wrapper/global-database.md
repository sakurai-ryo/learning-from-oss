---
title: "Aurora Global Database — 地域をまたぐトポロジ"
description: "Global Database は複数リージョンにクラスタを持ち、writer は 1 つのリージョンにしかない。global エンドポイントの DNS にはリージョンがなく、トポロジ表 aurora_global_db_instance_status にはリージョン列がある。ラッパは region ごとのインスタンステンプレートを必須にし、トポロジモニタと監視接続の選び方をリージョン対応に差し替える。3.0.0 で入った 4 つの部品を読む。"
group: "運用イベントを知る"
sidebar:
  order: 68
---

## 何を学んだか

Aurora Global Database は、**1 つの primary リージョン**と複数の secondary リージョンにそれぞれクラスタを持ち、ストレージ層で複製する。writer は primary にしかなく、切り替え (planned failover / switchover) で primary が別リージョンに移る。

単一リージョンの Aurora と比べて、ラッパが追加で知らなければならないことは 4 つである。

1. **トポロジにリージョンがある。** `information_schema.aurora_global_db_instance_status` の `aws_region` 列
2. **インスタンスエンドポイントの形がリージョンごとに違う。** `?.XYZ1.us-east-1.rds.amazonaws.com` と `?.XYZ2.us-west-2.rds.amazonaws.com` のように、クラスタ ID 部分 (`XYZ`) もリージョンごとに別
3. **global エンドポイント (`*.global.rds.amazonaws.com`) にはリージョンがない。** IAM トークンの署名に使うリージョンを DNS から取れない
4. **監視接続をどのリージョンに置くか**が選べる必要がある。primary の writer に置くのが既定

3.0.0 でこれらに対応する部品 (`global-aurora-mysql` Dialect、`GlobalAuroraHostListProvider`、`GlobalAuroraTopologyMonitor`、`GlobalDbMonitoringConnectionHandler`) が入り、`gdbFailover` プラグインが上に乗る ([gdbFailover](../gdb-failover/))。README の Known Limitations は「Global Database の failover 未対応」のままだが、CHANGELOG 3.0.0 で対応済みである。

## ソースコードのどこか

### Dialect — 3 クエリで判定し、region 付きでトポロジを返す

[`mysql/lib/dialect/global_aurora_mysql_database_dialect.ts#L28`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/global_aurora_mysql_database_dialect.ts#L28)。

```ts title="mysql/lib/dialect/global_aurora_mysql_database_dialect.ts"
export class GlobalAuroraMySQLDatabaseDialect extends AuroraMySQLDatabaseDialect implements GlobalAuroraTopologyDialect {
  private static readonly GLOBAL_STATUS_TABLE_EXISTS_QUERY =
    "SELECT 1 AS tmp FROM information_schema.tables WHERE" +
    " upper(table_schema) = 'INFORMATION_SCHEMA' AND upper(table_name) = 'AURORA_GLOBAL_DB_STATUS'";
  private static readonly GLOBAL_INSTANCE_STATUS_EXISTS_QUERY = /* 同様に AURORA_GLOBAL_DB_INSTANCE_STATUS */;

  private static readonly GLOBAL_TOPOLOGY_QUERY =
    "SELECT server_id, CASE WHEN SESSION_ID = 'MASTER_SESSION_ID' THEN TRUE ELSE FALSE END AS is_writer, " +
    "visibility_lag_in_msec, aws_region " +
    "FROM information_schema.aurora_global_db_instance_status";

  private static readonly REGION_COUNT_QUERY = "SELECT count(1) FROM information_schema.aurora_global_db_status";

  private static readonly REGION_BY_INSTANCE_ID_QUERY =
    "SELECT AWS_REGION FROM information_schema.aurora_global_db_instance_status WHERE SERVER_ID = ?";

  async isDialect(targetClient: ClientWrapper): Promise<boolean> {
    // 2 つの表が両方あり、かつ
    const awsRegionCount = regionCountRows[0]["count(1)"];
    return awsRegionCount > 1;   // リージョンが 2 つ以上
  }
```

[Dialect の自動判定](../dialect-resolution/)の候補は `aurora-mysql` → `global-aurora-mysql` の順で、**表が 2 つあってもリージョンが 1 つなら Global と見なさない**。Global Database をまだ 1 リージョンでしか構成していない段階では普通の Aurora として扱われる。docs は自動判定に頼らず `dialect: "global-aurora-mysql"` を明示することを勧めている。

トポロジクエリは Aurora の `replica_host_status` ではなく `aurora_global_db_instance_status` を読む。weight は `Math.round(visibility_lag_in_msec) * 100` で、[Aurora 版](../topology-query-aurora/)にあった CPU 項がない。`aws_region` 列が `TopologyQueryResult.awsRegion` に入る。

### インスタンステンプレートはリージョンごとに必須

[`common/lib/host_list_provider/global_aurora_host_list_provider.ts#L29`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/global_aurora_host_list_provider.ts#L29)。

```ts title="common/lib/host_list_provider/global_aurora_host_list_provider.ts"
protected override initSettings(): void {
  super.initSettings();
  const instanceTemplates = WrapperProperties.GLOBAL_CLUSTER_INSTANCE_HOST_PATTERNS.get(this.properties);
  this.instanceTemplatesByRegion = this.rdsHelper.parseInstanceTemplates(
    instanceTemplates,
    (hostPattern: string) => this.validateHostPatternSetting(hostPattern),
    () => this.hostListProviderService.getHostInfoBuilder()
  );
}
```

`globalClusterInstanceHostPatterns` が空なら `Utils.globalClusterInstanceHostPatternsRequired` で例外になる。単一リージョンの [clusterInstanceHostPattern](../cluster-instance-host-pattern/) が「IP やカスタムドメインのときだけ必須」なのに対し、Global では常に必須である。パースは [`rds_utils.ts#L264`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L264) で、3 通りの書き方を受け付ける。

| 書き方            | 例                                             | リージョンの出所           |
| ----------------- | ---------------------------------------------- | -------------------------- |
| `region:pattern`  | `us-east-1:?.XYZ1.us-east-1.rds.amazonaws.com` | 前半                       |
| `[region]pattern` | `[us-east-1]?.custom.example.com`              | 角括弧。カスタムドメイン用 |
| `pattern`         | `?.XYZ1.us-east-1.rds.amazonaws.com`           | DNS から `getRdsRegion`    |

トポロジの行をホストにするとき、`aws_region` でテンプレートを引く ([`global_topology_utils.ts#L55`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/global_topology_utils.ts#L55))。

```ts title="common/lib/host_list_provider/global_topology_utils.ts"
topologyQueryResults.forEach((row) => {
  if (!row.awsRegion) {
    throw new AwsWrapperError(Messages.get("GlobalTopologyUtils.missingRegion", row.host));
  }
  const clusterInstanceTemplate = instanceTemplateByRegion.get(row.awsRegion);
  if (!clusterInstanceTemplate) {
    throw new AwsWrapperError(
      Messages.get("GlobalTopologyUtils.missingTemplateForRegion", row.awsRegion, row.host),
    );
  }
  const host = this.createHost(
    row.id,
    row.host,
    row.isWriter,
    row.weight,
    lastUpdateTime,
    initialHost,
    clusterInstanceTemplate,
    row.endpoint,
    row.port,
  );
  const existing = hostsMap.get(host.host);
  if (!existing || existing.lastUpdateTime < host.lastUpdateTime) {
    hostsMap.set(host.host, host);
  }
});
```

テンプレートがないリージョンの行があると例外で、トポロジ全体が取れない。「一部のリージョンだけ書く」は許されず、**全リージョン分を書く**必要がある。`hostsMap` のキーは組み立てたホスト名なので、docs にある「リージョンをまたいで同名のインスタンスは非対応」はここで衝突する。

### トポロジモニタの差し替え点

[`common/lib/host_list_provider/monitoring/global_aurora_topology_monitor.ts#L36`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/global_aurora_topology_monitor.ts#L36)。[ClusterTopologyMonitor](../cluster-topology-monitor/) を継承し、4 つの hook を上書きする。

| hook                             | 単一リージョン ([`cluster_topology_monitor.ts`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/cluster_topology_monitor.ts#L169)) | Global                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `createConnectionHandler`        | `AuroraMonitoringConnectionHandler` (strict-writer / strict-reader / writer-or-reader)                                                                                                                                       | `GlobalDbMonitoringConnectionHandler` (リージョン対応の 7 種)      |
| `filterHostsForHostMonitoring`   | 全ホスト                                                                                                                                                                                                                     | `gdbAccessibleRegions` で絞る                                      |
| `openAnyClientAndUpdateTopology` | そのまま                                                                                                                                                                                                                     | 初期ホストのリージョンが `gdbAccessibleRegions` 外なら即例外       |
| `getInstanceTemplate`            | 1 つのテンプレート                                                                                                                                                                                                           | `REGION_BY_INSTANCE_ID_QUERY` でリージョンを引き、そのテンプレート |

`createConnectionHandler` の home region は `failoverHomeRegion`、なければ初期ホストの DNS から取る。

### 監視接続をどこに置くか

[`global_db_monitoring_connection_handler.ts#L28`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/global_db_monitoring_connection_handler.ts#L28)。

```ts title="common/lib/host_list_provider/monitoring/global_db_monitoring_connection_handler.ts"
export enum GlobalDbMonitoringConnectionPriority {
  STRICT_WRITER_PRIMARY = "strict-writer-primary",
  STRICT_WRITER_SECONDARY = "strict-writer-secondary",
  STRICT_READER_PRIMARY = "strict-reader-primary",
  STRICT_READER_SECONDARY = "strict-reader-secondary",
  WRITER_OR_READER_PRIMARY = "writer-or-reader-primary",
  WRITER_OR_READER_SECONDARY = "writer-or-reader-secondary",
  REGION = "region",
}

// AWS region identifiers look like "us-east-1", "eu-west-2", "ap-southeast-1".
const REGION_SHAPE = /^[a-z]{2}-[a-z]+-\d+$/;
```

`gdbMonitoringConnectionPriority` にはカンマ区切りで優先順位を並べられる。6 つの名前付き値以外は**リージョン名のリテラル**として扱い、`REGION_SHAPE` に合わなければ typo の可能性を警告する。「primary かどうか」は writer が見つかったリージョンを `primaryRegion` として覚えて判定する ([`#L225`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/global_db_monitoring_connection_handler.ts#L225))。

`findHostsForPriority` ([`#L174`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/global_db_monitoring_connection_handler.ts#L174)) は候補を `gdbAccessibleRegions` で絞ってから、優先度ごとの述語で選ぶ。`REGION` なら「そのリージョンの writer、なければそのリージョンの誰か」である。

### global エンドポイントにはリージョンがない

[`utils/rds_utils.ts#L85`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L85) と [`rds_url_type.ts#L26`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_url_type.ts#L26)。

```ts title="common/lib/utils/rds_utils.ts"
// Global Database Endpoint: <globalDb-name>.global-<xyz>.global.rds.amazonaws.com
private static readonly AURORA_GLOBAL_WRITER_DNS_PATTERN =
  /^(?<instance>.+)\.(?<dns>global-)?(?<domain>[a-zA-Z0-9]+\.global\.rds\.amazonaws\.com\.?)$/i;
```

```ts title="common/lib/utils/rds_url_type.ts"
public static readonly RDS_WRITER_CLUSTER = new RdsUrlType(true, true, true);
public static readonly RDS_GLOBAL_WRITER_CLUSTER = new RdsUrlType(true, true, false);  // hasRegion = false
```

`identifyRdsType` は IP の判定の次に global パターンを見る ([RdsUtils](../rds-utils/))。`hasRegion: false` が効くのは 2 か所で、`gdbFailover` の `failoverHomeRegion` が省略できない判定と、IAM 認証のリージョン解決である。後者は [`iam_authentication_plugin.ts#L88`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/authentication/iam_authentication_plugin.ts#L88) で `GlobalDbRegionUtils` に切り替わる。

```ts title="common/lib/utils/global_db_region_utils.ts"
async getRegion(regionKey: string, hostInfo?: HostInfo, props?: Map<string, any>): Promise<string | null> {
  if (props.get(regionKey)) {
    return this.getRegionFromRegionString(props.get(regionKey));   // iamRegion があればそれ
  }
  const clusterId = GlobalDbRegionUtils.rdsUtils.getRdsClusterId(hostInfo.host);
  const writerClusterArn = await this.findWriterClusterArn(hostInfo, props, clusterId);  // DescribeGlobalClusters
  return writerClusterArn ? this.getRegionFromClusterArn(writerClusterArn) : null;
}
```

`iamRegion` がなければ RDS API の `DescribeGlobalClusters` で writer メンバーの ARN を取り、ARN の region 部分を使う。**IAM 認証で global エンドポイントに繋ぐには、`iamRegion` を書くか `rds:DescribeGlobalClusters` の権限が要る** ([IAM 認証プラグイン](../iam-plugin/))。

### gdbAccessibleRegions

[`utils/accessible_regions.ts#L24`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/accessible_regions.ts#L24)。カンマ区切りを小文字化した配列にし、`filterHosts` はホストの DNS から `getRdsRegion` で取ったリージョンが含まれるものだけ残す。トポロジモニタの HostMonitor 対象、フェイルオーバー候補、initialConnection、gdbReadWriteSplitting の 4 か所で使われる。

## なぜそうなっているか

### なぜテンプレートを全リージョン分書かせるのか

Aurora のトポロジ表が返す `server_id` はインスタンス名だけで、DNS のドメイン部分 (`XYZ1.us-east-1.rds.amazonaws.com`) は含まない。単一リージョンでは接続文字列のドメイン部分を流用できるが ([clusterInstanceHostPattern](../cluster-instance-host-pattern/))、Global ではクラスタ ID 部分 `XYZ` がリージョンごとに違うので、流用できるのは初期ホストのリージョン分だけである。他リージョンのインスタンスに繋ぐには、そのリージョンのドメインを誰かが教えるしかない。

### なぜ監視接続の場所を選ばせるのか

トポロジモニタの監視接続は既定で writer に張る ([ClusterTopologyMonitor](../cluster-topology-monitor/))。Global では writer が別リージョンにあるかもしれず、リージョン間の往復で監視クエリが遅くなる。アプリと同じリージョンの reader で監視したい、というのが `strict-reader-primary` や `<region>` の用途である。ただしトポロジ表はどのインスタンスからでも同じ内容が読めるので、監視をどこに置いても得られる情報は変わらない。

### なぜリージョンで絞れるのか

ネットワーク経路 (VPC ピアリングがない)、コンプライアンス (データ所在)、遅延の 3 つが docs に挙がっている。到達できないリージョンのホストを候補に残すと、フェイルオーバーがそこへの接続タイムアウトで時間を溶かす。「到達できないなら候補から外し、writer がそこにあるなら即失敗する」ほうが、`failoverTimeoutMs` (5 分) を待つより診断しやすい。

## どう活かすか

- **リージョンを持つ資源は、識別子にリージョンを含めるか、別表で持つ。** ラッパは後者 (テンプレートの Map) を選んだ。トポロジ表の `aws_region` 列と設定の Map をキーで結ぶだけで、コードのどこにもリージョン名のハードコードがない
- **「到達できるか」は設定で宣言させる。** 自動検出 (接続を試す) は時間がかかる。宣言なら即座に候補から外せる
- **`dialect` は明示する。** 自動判定は 3 クエリと「リージョン数 > 1」に依存する。構成途中や権限不足で単一リージョン Aurora として動き、`globalClusterInstanceHostPatterns` が無視されたまま気づかない

### つまずきどころ

- **`globalClusterInstanceHostPatterns` がないと初期化で例外。** 単一リージョンの感覚で省略すると `The 'globalClusterInstanceHostPatterns' property is required for Global Aurora Databases.` になる
- **1 リージョンでも欠けるとトポロジ全体が失敗。** `missingTemplateForRegion` は行ごとに投げるので、リージョンを追加したら設定も更新する
- **インスタンス名はリージョンをまたいで一意に。** 同名だと `hostsMap` で片方が消える
- **global エンドポイント + IAM は権限が増える。** `iamRegion` を書けば API 呼び出しは不要
- **`getDialectUpdateCandidates` が空。** 一度 Global と判定されると、それ以上の更新候補はない。逆に Aurora から Global への昇格は接続のたびに 3 クエリで試される
