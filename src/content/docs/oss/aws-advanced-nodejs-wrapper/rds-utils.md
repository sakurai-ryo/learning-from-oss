---
title: "RdsUtils — エンドポイント文字列を正規表現で分類する"
description: "ラッパは接続先の文字列だけを見て、それがクラスタエンドポイントか、reader エンドポイントか、インスタンスか、プロキシか、IP かを決める。576 行の RdsUtils は名前付きグループ付きの正規表現 12 本と、判定順が意味を持つ identifyRdsType でできている。China・GovCloud・FIPS・Blue/Green の green 接尾辞まで、この 1 クラスが吸収している。"
group: "トポロジを知る"
sidebar:
  order: 23
---

## 何を学んだか

ラッパは接続前に一度も DNS を引かない。**接続先の文字列の形だけから**「これは Aurora のクラスタエンドポイントである」「これは reader エンドポイントである」と判断し、その判断がフェイルオーバーモードの既定値、初期接続の役割の仮定、トポロジ取得時のインスタンス名の組み立て方を決める。

その判断をしているのが `RdsUtils` で、次の 3 点が要点になる。

- **正規表現の名前付きグループ `dns` で種別を、`domain` でクラスタ固有のドメインを、`region` でリージョンを取り出す**
- **`identifyRdsType` の `else if` の順序が判定順になっている。** IP → Global → writer cluster → reader cluster → custom → shard group → proxy → proxy endpoint → instance → その他
- **結果は静的 `Map` にホスト名キーでキャッシュされる。** 一度マッチした文字列は二度と正規表現を通らない

## ソースコードのどこか

### パターン群

[`common/lib/utils/rds_utils.ts#L85`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L85)。ファイル冒頭 60 行のコメントに、各エンドポイントの形が例付きで列挙されている。標準リージョン用の主パターンはこれだ。

```ts title="common/lib/utils/rds_utils.ts"
private static readonly AURORA_DNS_PATTERN =
  /^(?<instance>.+)\.(?<dns>proxy-|cluster-|cluster-ro-|cluster-custom-|shardgrp-)?(?<domain>[a-zA-Z0-9]+\.(?<region>[a-zA-Z0-9-]+)\.(rds|rds-fips)\.amazonaws\.(com|au|eu|uk)\.?)$/i;
```

`my-cluster.cluster-abc123.us-east-1.rds.amazonaws.com` に当てると、

| グループ   | 値                                   |
| ---------- | ------------------------------------ |
| `instance` | `my-cluster`                         |
| `dns`      | `cluster-`                           |
| `domain`   | `abc123.us-east-1.rds.amazonaws.com` |
| `region`   | `us-east-1`                          |

になる。`dns` が空 (`undefined`) ならインスタンスエンドポイントで、`instance` がインスタンス名になる。

同じ形のパターンが用途別に 12 本ある。

| パターン                                        | 対象                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `AURORA_DNS_PATTERN`                            | 標準リージョン。`rds` / `rds-fips`、TLD は `com` / `au` / `eu` / `uk`                    |
| `AURORA_CHINA_DNS_PATTERN`                      | 中国。`<xyz>.rds.<region>.amazonaws.com.cn` と、`rds` と `region` の順が逆               |
| `AURORA_OLD_CHINA_DNS_PATTERN`                  | 中国の旧形式。`<xyz>.<region>.rds.amazonaws.com.cn`                                      |
| `AURORA_GOV_DNS_PATTERN`                        | GovCloud / ISO。`amazonaws.com` / `c2s.ic.gov` / `sc2s.sgov.gov`                         |
| `AURORA_GLOBAL_WRITER_DNS_PATTERN`              | Global Database の writer エンドポイント。`<name>.global-<xyz>.global.rds.amazonaws.com` |
| `AURORA_CLUSTER_PATTERN` 系 4 本                | `cluster-` / `cluster-ro-` だけに絞ったもの。`getRdsClusterHostUrl` で使う               |
| `AURORA_LIMITLESS_CLUSTER_PATTERN`              | `shardgrp-` (Limitless、PG 専用)                                                         |
| `RDS_PROXY_ENDPOINT_DNS_PATTERN` 系 3 本        | `<name>.endpoint.proxy-<xyz>.<region>.rds.amazonaws.com`                                 |
| `ELB_PATTERN`                                   | `<name>.elb.<region>.amazonaws.com`。リージョン抽出にだけ使う                            |
| `IP_V4` / `IP_V6` / `IP_V6_COMPRESSED`          | IP アドレス                                                                              |
| `BG_GREEN_HOST_PATTERN` / `BG_OLD_HOST_PATTERN` | Blue/Green の `-green-abc123` / `-old1` 接尾辞                                           |

中国用が新旧 2 本あるのは、中国リージョンで `rds` と `region` の並び順が過去に変わったからである。コード上のコメント (L50-64) にリンク付きで残っている。

### `identifyRdsType` — 判定順が仕様

[`rds_utils.ts#L427`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L427)。

```ts title="common/lib/utils/rds_utils.ts"
public identifyRdsType(host: string): RdsUrlType {
  if (!host) {
    return RdsUrlType.OTHER;
  }

  const preparedHost = RdsUtils.getPreparedHost(host);
  if (this.isIPv4(preparedHost) || this.isIPv6(preparedHost)) {
    return RdsUrlType.IP_ADDRESS;
  } else if (this.isGlobalDbWriterClusterDns(preparedHost)) {
    return RdsUrlType.RDS_GLOBAL_WRITER_CLUSTER;
  } else if (this.isWriterClusterDns(preparedHost)) {
    return RdsUrlType.RDS_WRITER_CLUSTER;
  } else if (this.isReaderClusterDns(preparedHost)) {
    return RdsUrlType.RDS_READER_CLUSTER;
  } else if (this.isRdsCustomClusterDns(preparedHost)) {
    return RdsUrlType.RDS_CUSTOM_CLUSTER;
  } else if (this.isLimitlessDbShardGroupDns(preparedHost)) {
    return RdsUrlType.RDS_AURORA_LIMITLESS_DB_SHARD_GROUP;
  } else if (this.isRdsProxyDns(preparedHost)) {
    return RdsUrlType.RDS_PROXY;
  } else if (this.isRdsProxyEndpointDns(preparedHost)) {
    return RdsUrlType.RDS_PROXY_ENDPOINT;
  } else if (this.isRdsDns(preparedHost)) {
    return RdsUrlType.RDS_INSTANCE;
  } else {
    // ELB URLs will also be classified as other
    return RdsUrlType.OTHER;
  }
}
```

`isWriterClusterDns` 以下はほぼ全部 `getDnsGroup` の結果を文字列比較しているだけで、`getDnsGroup` ([`#L511`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L511)) が 5 本のパターンを順に試して `dns` グループを返す。`isRdsDns` は `dns` グループの有無を問わず「RDS の DNS 形式にマッチするか」で、`isRdsInstance` は「マッチして、かつ `dns` グループが空」である ([`#L163`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L163))。

判定結果の `RdsUrlType` は 3 つの真偽値の組でしかない ([`rds_url_type.ts#L17`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_url_type.ts#L17))。

```ts title="common/lib/utils/rds_url_type.ts"
export class RdsUrlType {
  public static readonly IP_ADDRESS = new RdsUrlType(false, false, false);
  public static readonly RDS_WRITER_CLUSTER = new RdsUrlType(true, true, true);
  public static readonly RDS_READER_CLUSTER = new RdsUrlType(true, true, true);
  public static readonly RDS_CUSTOM_CLUSTER = new RdsUrlType(true, false, true);
  public static readonly RDS_PROXY = new RdsUrlType(true, false, true);
  public static readonly RDS_PROXY_ENDPOINT = new RdsUrlType(true, false, true);
  public static readonly RDS_INSTANCE = new RdsUrlType(true, false, true);
  public static readonly RDS_AURORA_LIMITLESS_DB_SHARD_GROUP = new RdsUrlType(true, false, true);
  public static readonly RDS_GLOBAL_WRITER_CLUSTER = new RdsUrlType(true, true, false);
  public static readonly OTHER = new RdsUrlType(false, false, false);

  private constructor(
    public readonly isRds: boolean,
    public readonly isRdsCluster: boolean,
    public readonly hasRegion: boolean,
  ) {}
}
```

`isRdsCluster` が true なのは writer / reader クラスタエンドポイントと Global writer だけで、カスタムエンドポイント (`cluster-custom-`) は含まれない。カスタムエンドポイントは「どのインスタンスを含むか」を DNS からは知りようがないので、クラスタとしては扱わない ([customEndpoint プラグイン](../custom-endpoint/) が RDS API で中身を取りに行く)。

### `getRdsInstanceHostPattern` — `?` テンプレートの元

[`rds_utils.ts#L230`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L230)。

```ts title="common/lib/utils/rds_utils.ts"
public getRdsInstanceHostPattern(host: string): string {
  if (!host) {
    return "?";
  }

  const preparedHost = RdsUtils.getPreparedHost(host);
  const matcher = this.cacheMatcher(preparedHost, RdsUtils.AURORA_DNS_PATTERN, /* China, old China, Gov */);
  const group = this.getRegexGroup(matcher, RdsUtils.DOMAIN_GROUP);
  return group ? `?.${group}` : "?";
}
```

`domain` グループ (`abc123.us-east-1.rds.amazonaws.com`) の前に `?.` を付けて返す。この文字列がトポロジクエリで得たインスタンス名 (`instance-1`) と合体して `instance-1.abc123.us-east-1.rds.amazonaws.com` になる。マッチしなければ `"?"` だけが返る。この「`?` だけ」がどう扱われるかは [clusterInstanceHostPattern](../cluster-instance-host-pattern/) で読む。

### キャッシュ

[`rds_utils.ts#L540`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L540)。

```ts title="common/lib/utils/rds_utils.ts"
private static readonly cachedPatterns = new Map();
private static readonly cachedDnsPatterns = new Map();

private cacheMatcher(host: string, ...patterns: RegExp[]) {
  let matcher = null;
  for (const pattern of patterns) {
    matcher = RdsUtils.cachedPatterns.get(host);
    if (matcher) {
      return matcher;
    }
    matcher = host.match(pattern);
    if (matcher && matcher.length > 0) {
      RdsUtils.cachedPatterns.set(host, matcher);
      return matcher;
    }
  }
  return null;
}
```

キャッシュは `static` で、プロセス内の全 `RdsUtils` インスタンス (各プラグインが `new RdsUtils()` している) が共有する。キーはホスト文字列だけで、**どのパターン群で照合したかは記録されない**。呼び出し元が別のパターン群を渡しても、そのホストが一度マッチしていれば最初の `MatchArray` が返る。パターン群はどれも同じ名前付きグループを持つので実害は出ていないが、パターンを足すときに踏みやすい前提になっている。

期限もサイズ上限もない。接続先ホスト名の種類は多くても数十なので問題にならないが、`RdsUtils.clearCache()` はテスト用にだけ用意されている。

### `prepareHostFunc` — テスト用のフック

[`rds_utils.ts#L569`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L569)。全メソッドが入口で `getPreparedHost(host)` を通す。既定では素通しで、`setPrepareHostFunc` で差し替えられる。`common/lib` の中に呼び出し元はなく、統合テストが toxiproxy 経由のホスト名を本物の RDS エンドポイントに読み替えるために使っている ([`tests/integration/container/tests/utils/test_environment.ts#L244`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/tests/integration/container/tests/utils/test_environment.ts#L244))。本番コードに紛れているテスト用フックである。

### 判定結果を使う側

`RdsUtils` の判定は次の場所で分岐を作る。

| 使う側                                                                                                                                                                                                                                              | 何を決めるか                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ConnectionUrlParser.parseHostPortPair` ([`#L61`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/connection_url_parser.ts#L61))                                                  | `RDS_READER_CLUSTER` なら初期 HostInfo の役割を `READER`、それ以外は `WRITER`        |
| `RdsHostListProvider.validateHostPatternSetting` ([`#L268`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L268))                         | パターンが proxy / custom cluster なら例外                                           |
| `HostIdCacheServiceImpl.identifyConnection` ([`#L69`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/host_id_cache_service.ts#L69))                                              | `RDS_INSTANCE` なら DB に聞かず即答、IP / OTHER ならキャッシュ                       |
| `ClusterTopologyMonitorImpl.openAnyClientAndUpdateTopology` ([`#L301`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/cluster_topology_monitor.ts#L301)) | 初期ホストがインスタンスエンドポイントなら、それをそのまま writer の HostInfo にする |
| [failoverMode](../failover-mode/) の既定値                                                                                                                                                                                                          | `cluster-ro-` なら `reader-or-writer`                                                |
| [StaleDns](../stale-dns/) / [initialConnection](../initial-connection-strategy/)                                                                                                                                                                    | クラスタエンドポイントのときだけ検証する                                             |

## なぜそうなっているか

### DNS を引かずに判断する

DNS を引いてしまうと、その結果はクラスタエンドポイントが「今」指しているインスタンスでしかない。ラッパが知りたいのは「この文字列はクラスタを指しているのか、1 台を指しているのか」という**種類**で、それは文字列の形にしか現れない。

そして種類が分かれば、後の振る舞いが全部決まる。クラスタエンドポイントなら DNS が古い可能性を疑う、インスタンスエンドポイントなら疑わない、IP ならトポロジのインスタンス名を組み立てられないので設定を要求する。判断を接続前に、しかもネットワークなしで済ませられるのは、AWS がエンドポイントの命名規則を公開しているからで、`RdsUtils` はその規則の写しである。

### 判定順に意味がある

`identifyRdsType` で `isRdsProxyDns` が `isRdsProxyEndpointDns` より先にある。RDS Proxy のカスタムエンドポイント `name.endpoint.proxy-xyz.us-east-1.rds.amazonaws.com` は `AURORA_DNS_PATTERN` にもマッチし、そのとき `instance` = `name.endpoint`、`dns` = `proxy-` になる。先に `isRdsProxyDns` が `proxy-` を見て `RDS_PROXY` を返すので、`RDS_PROXY_ENDPOINT` に到達することは実質ない。両者の `RdsUrlType` は同じ 3 値なので、今のところ違いは出ない。

`isRdsDns` が最後なのは、それが「`dns` グループの有無を問わない」最も緩い判定だからである。先に置くと全部 `RDS_INSTANCE` になる。

### China とパターンを 2 本持つ

中国リージョンのエンドポイントは `xyz.rds.cn-north-1.amazonaws.com.cn` という形で、標準リージョンの `xyz.us-east-1.rds.amazonaws.com` と `rds` の位置が違う。1 本の正規表現で両方を受けようとすると `region` グループの位置が定まらなくなる。分けて順に試すほうが、各パターンを読める形に保てる。

`parseInstanceTemplateEntry` のコメント (L247-263) が、この転置を Global Database のリージョン指定でどう扱うかを説明している。リージョン名の一覧を持たずに、「コロンの後ろが数字だけならポート、それ以外ならリージョン」で判別するという判断で、パーティションが増えても壊れない。

## どう活かすか

- **外部システムの命名規則は、名前付きグループ付き正規表現 1 本 + 用途別の薄い判定関数にする。** `isWriterClusterDns` のような 3 行の関数が 10 個あるのは冗長に見えるが、呼び出し側が「`dns` グループが `cluster-` かどうか」を知らずに済む
- **`else if` の順序が仕様になるなら、その順序をテストに固定する。** `tests/unit/rds_utils.test.ts` がそれをやっている。緩い判定は必ず最後に置く
- **静的キャッシュにキーを 1 種類しか持たないなら、キャッシュされる値が「どの入力に対しても同じ」ことを確かめてから使う。** ここでは全パターンが同じグループ名を持つので成立している

### 実務で踏む失敗パターン

- **カスタムドメイン (`db.example.com`) は `OTHER` になる。** `isRds` が false なので、クラスタエンドポイント前提の検証 (StaleDns など) は走らない。トポロジは取れるが、インスタンス名からエンドポイントを組み立てるには [clusterInstanceHostPattern](../cluster-instance-host-pattern/) が要る
- **末尾のドット (`...amazonaws.com.`) は許容される。** パターンの末尾が `\.?` になっている
- **大文字小文字は区別しない (`/i`)。** `equalsIgnoreCase` で比較しているので `CLUSTER-` でも通る
- **ELB は `OTHER` だがリージョンだけは取れる。** `getRdsRegion` は `ELB_PATTERN` にも当てる。IAM 認証でリージョンを推測する経路 ([IAM 認証プラグイン](../iam-plugin/)) がこれに依存している
