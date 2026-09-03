---
title: "HostInfo と HostRole と可用性"
description: "トポロジの 1 行は HostInfo という値オブジェクトになる。役割 (writer / reader) は書き換え可能で、可用性は HostInfo の外側にある 5 分キャッシュに置かれ、トポロジを取り直すたびに作り直される HostInfo へ上書きされる。equals が hostId と lastUpdateTime を見ない理由と、可用性が「戦略」を経由して読まれる理由を読む。"
group: "トポロジを知る"
sidebar:
  order: 22
---

## 何を学んだか

ラッパの中で「1 台のインスタンス」を表すのは `HostInfo` という小さなクラスで、群 3 以降のほぼ全ページに出てくる。読むときに押さえるべき点は 3 つある。

- **`role` だけが書き換え可能で、それ以外は `readonly`。** 接続してから「本当は reader だった」と分かったとき、オブジェクトを作り直さずに役割だけ直す
- **可用性 (`availability`) は 2 段階で読まれる。** 生の値と、`HostAvailabilityStrategy` を通した値があり、外から読むのは後者
- **可用性の「正」は HostInfo の外にある。** トポロジを取り直すたびに HostInfo は新しく作られるので、`PluginService` が 5 分キャッシュから可用性を上書きし直す

`HostInfo` は値のように見えて、実際には「トポロジの 1 行のスナップショット + 役割の訂正 + 可用性の投影」という 3 つの性質を持っている。

## ソースコードのどこか

### `HostInfo` のフィールド

[`common/lib/host_info.ts#L24`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_info.ts#L24)。

```ts title="common/lib/host_info.ts"
export class HostInfo {
  public static readonly NO_PORT: number = -1;
  public static readonly DEFAULT_WEIGHT: number = 100;

  readonly host: string; // full domain name
  readonly port: number;
  role: HostRole;
  readonly weight: number; // Greater or equal 0. Lesser the weight, the healthier host.
  readonly lastUpdateTime: number;
  availability: HostAvailability;
  hostId: string; // id; could be a host name, host domain name, or a unique string
  hostAvailabilityStrategy: HostAvailabilityStrategy;
```

`host` と `hostId` は別物である。Aurora なら `hostId` は `@@aurora_server_id` (= インスタンス名)、`host` はそれに [クラスタインスタンスパターン](../cluster-instance-host-pattern/) を当てて組み立てた完全なエンドポイントになる。Multi-AZ なら `hostId` は `db-WQFQKBTL2LQUPIEFIFBGENS4ZQ` のような ID で、`host` はインスタンス名から組み立てたエンドポイントだ。この違いは [`topology_utils.ts#L184`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/topology_utils.ts#L184) のコメントに書かれている。

`HostRole` は 3 値の文字列 enum である ([`host_role.ts#L17`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_role.ts#L17))。

```ts title="common/lib/host_role.ts"
export enum HostRole {
  UNKNOWN = "unknown",
  WRITER = "writer",
  READER = "reader",
}
```

`HostAvailability` は 2 値で、`AVAILABLE = 0`、`NOT_AVAILABLE = 1` ([`host_availability.ts#L17`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_availability/host_availability.ts#L17))。

### `equals` が見ないもの

[`host_info.ts#L78`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_info.ts#L78)。

```ts title="common/lib/host_info.ts"
equals(other: HostInfo): boolean {
  return (
    this.host === other.host &&
    this.port === other.port &&
    this.availability === other.availability &&
    this.role === other.role &&
    this.weight === other.weight
  );
}
```

`hostId` と `lastUpdateTime` と `hostAvailabilityStrategy` は比較に入らない。一方で `weight` は入る。`weight` はトポロジクエリのたびに `lag × 100 + cpu` で計算し直される ([トポロジクエリ (Aurora MySQL)](../topology-query-aurora/)) ので、この `equals` は「2 回のトポロジ取得結果が同じか」の判定には使えない。実際、[`ClusterTopologyMonitor`](../cluster-topology-monitor/) は `equals` を使わず、自前の `hostInfoExtractor` で `host:port:availability:role` の文字列を作って比較している ([`cluster_topology_monitor.ts#L88`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/cluster_topology_monitor.ts#L88))。コメントに理由が書いてある。

### 可用性の 2 段階読み出し

[`host_info.ts#L88`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_info.ts#L88)。

```ts title="common/lib/host_info.ts"
getAvailability(): HostAvailability {
  if (this.hostAvailabilityStrategy) {
    return this.hostAvailabilityStrategy.getHostAvailability(this.availability);
  }
  return this.availability;
}

getRawAvailability(): HostAvailability {
  return this.availability;
}

setAvailability(availability: HostAvailability) {
  this.availability = availability;
  if (this.hostAvailabilityStrategy !== null) {
    this.hostAvailabilityStrategy.setHostAvailability(availability);
  }
}
```

生の `availability` と、それを `HostAvailabilityStrategy` に通した値がある。既定の `SimpleHostAvailabilityStrategy` は素通しで、`exponentialBackoff` を選ぶと「`NOT_AVAILABLE` でも一定時間経ったら `AVAILABLE` を返す」ようになる。戦略の中身は [ホスト可用性戦略と選択戦略](../host-availability-and-selection/) で読む。

### `HostInfoBuilder` — 既定の役割は writer

[`host_info_builder.ts#L34`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_info_builder.ts#L34)。

```ts title="common/lib/host_info_builder.ts"
constructor(builder: { /* ... */ hostAvailabilityStrategy: HostAvailabilityStrategy; /* ... */ }) {
  this.host = builder.host ?? "";
  this.hostId = builder.hostId ?? "";
  this.port = builder.port ?? HostInfo.NO_PORT;
  this.availability = builder.availability ?? HostAvailability.AVAILABLE;
  this.role = builder.role ?? HostRole.WRITER;
  this.weight = builder.weight ?? HostInfo.DEFAULT_WEIGHT;
  this.lastUpdateTime = builder.lastUpdateTime ?? Date.now();
  this.hostAvailabilityStrategy = builder.hostAvailabilityStrategy;
}
```

`hostAvailabilityStrategy` だけが必須で、`role` の既定は `WRITER` である。`HostInfo` のコンストラクタ既定は `UNKNOWN` なのに、builder 経由だと `WRITER` になる。ラッパの中で `HostInfo` を作る経路はほぼ全部 builder 経由で、builder は [`PluginService.getHostInfoBuilder`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L325) が作る。

```ts title="common/lib/plugin_service.ts"
getHostInfoBuilder(): HostInfoBuilder {
  return new HostInfoBuilder({ hostAvailabilityStrategy: new HostAvailabilityStrategyFactory().create(this.props) });
}
```

ここで接続プロパティから可用性戦略が決まり、builder から生まれる全 HostInfo に注入される。

### 役割の訂正 — `role` が書き換え可能な理由

`AwsMySQLClient.connect()` は接続した直後に、その接続で `getHostRole` を実行して役割を確かめる ([`mysql/lib/client.ts#L80`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L80))。

```ts title="mysql/lib/client.ts"
if (isDialectTopologyAware(this.pluginService.getDialect())) {
  try {
    const role = await this.pluginService.getHostRole(result);
    // The current host role may be incorrect, use the created client to confirm the host role.
    if (role !== undefined && role !== result.hostInfo.role) {
      result.hostInfo.role = role;
      this.pluginService.setCurrentHostInfo(result.hostInfo);
      this.pluginService.setInitialConnectionHostInfo(result.hostInfo);
    }
  } catch (error) {
    // Ignore
  }
}
```

接続文字列から作った HostInfo は、URL が `cluster-ro-` でなければ `WRITER` と仮定されている ([HostListProvider 2 種](../host-list-providers/))。クラスタエンドポイントの DNS が古い writer を指していれば、この仮定は外れる。だから `role` だけは `readonly` ではない。

### 可用性の正はどこにあるか

`PluginService.setAvailability` ([`plugin_service.ts#L474`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L474)) は、`hostId` か `host` が一致する HostInfo を全部拾い、**HostInfo ではなく `StorageService` に書く**。

```ts title="common/lib/plugin_service.ts"
setAvailability(hostInfo: HostInfo, availability: HostAvailability) {
  const hostsToChange = [
    ...new Set(
      this.getAllHosts().filter(
        (host: HostInfo) => (hostInfo.hostId != null && hostInfo.hostId === host.hostId) || (hostInfo.host != null && hostInfo.host === host.host)
      )
    )
  ];
  if (hostsToChange.length === 0) {
    return;
  }

  const changes = new Map<string, Set<HostChangeOptions>>();
  for (const host of hostsToChange) {
    const currentAvailability = host.getAvailability();
    this.storageService.set(host.url, new HostAvailabilityCacheItem(availability));
    if (currentAvailability !== availability) {
      let hostChanges = new Set<HostChangeOptions>();
      if (availability === HostAvailability.AVAILABLE) {
        hostChanges = new Set([HostChangeOptions.WENT_UP, HostChangeOptions.HOST_CHANGED]);
      } else {
        hostChanges = new Set([HostChangeOptions.WENT_DOWN, HostChangeOptions.HOST_CHANGED]);
      }
      changes.set(host.url, hostChanges);
    }
  }

  if (changes.size > 0) {
    this.servicesContainer.pluginManager?.notifyHostListChanged(changes);
  }
}
```

`host.setAvailability(...)` は呼ばれていない。書き込み先は `HostAvailabilityCacheItem` で、キーは `host.url` (= `host:port/`)、有効期限は 5 分 ([`storage_service.ts#L125`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/storage/storage_service.ts#L125))。HostInfo 側に反映されるのは、次にトポロジを取り直したときである ([`plugin_service.ts#L367`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L367))。

```ts title="common/lib/plugin_service.ts"
async refreshHostList(): Promise<void> {
  const updatedHostList = await this.getHostListProvider()?.refresh();
  if (updatedHostList && updatedHostList !== this.hosts) {
    this.updateHostAvailability(updatedHostList);
    await this.setHostList(this.hosts, updatedHostList);
  }
}

private updateHostAvailability(hosts: HostInfo[]) {
  hosts.forEach((host) => {
    const cacheItem = this.storageService.get(HostAvailabilityCacheItem, host.url);
    if (cacheItem != null) {
      host.availability = cacheItem.availability;
    }
  });
}
```

トポロジクエリが返す HostInfo は毎回新品で、`availability` は `AVAILABLE` で作られる ([`topology_utils.ts#L128`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/topology_utils.ts#L128))。`updateHostAvailability` がキャッシュの値をフィールドに直接代入して「落ちている」状態を引き継ぐ。ここでも `setAvailability` ではなくフィールド代入なので、戦略の `setHostAvailability` は呼ばれない。

### 差分を `HostChangeOptions` にする

`setHostList` ([`plugin_service.ts#L420`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L420)) は新旧のリストを `url` で突き合わせ、`compare` ([`#L386`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L386)) で 1 台ごとの差分を作る。

| 検出した違い                               | `HostChangeOptions`  |
| ------------------------------------------ | -------------------- |
| `host` か `port` が違う                    | `HOSTNAME`           |
| `role` が `WRITER` になった                | `PROMOTED_TO_WRITER` |
| `role` が `READER` になった                | `PROMOTED_TO_READER` |
| `availability` が `AVAILABLE` になった     | `WENT_UP`            |
| `availability` が `NOT_AVAILABLE` になった | `WENT_DOWN`          |
| 新リストにない                             | `HOST_DELETED`       |
| 旧リストにない                             | `HOST_ADDED`         |

何か 1 つでも変化があれば `HOST_CHANGED` が付き、`pluginManager.notifyHostListChanged(changes)` で全プラグインに配られる。[auroraConnectionTracker](../connection-tracker/) はこの通知の `PROMOTED_TO_READER` を見て旧 writer の遊休接続を切る。

## なぜそうなっているか

### HostInfo は毎回作り直されるから、状態を外に置く

トポロジクエリの結果から HostInfo を組み立てる `createHost` は、キャッシュを引かずに毎回 `build()` する。同じインスタンスを表す HostInfo が、30 秒ごとに別のオブジェクトとして生まれる。

そのオブジェクトに「落ちている」フラグを立てても、次の取得で消える。だから可用性は `StorageService` の `HostAvailabilityCacheItem` に `url` キーで置き、取得のたびに上書きし直す設計になっている。5 分で期限が切れるのは、「落ちた」という情報を永遠に持ち続けると復旧したホストが戻ってこないからで、[exponentialBackoff 戦略](../host-availability-and-selection/) がなくても 5 分経てば `AVAILABLE` に戻る。

### `role` は「仮定」から始まるから訂正できる必要がある

接続文字列しか手元にない時点では、そのホストが writer か reader かは分からない。ラッパは URL の形から仮定する (`cluster-ro-` なら reader、それ以外は writer)。この仮定は Aurora の DNS が正しいときだけ当たる。

フェイルオーバー直後のクラスタエンドポイントは、DNS TTL の間は旧 writer (今は reader) を指す。`connect()` で役割を確認して `role` を直すのは、この仮定を「接続してから訂正する」ためで、`readonly` にしてしまうと HostInfo を作り直して `PluginService` の参照も差し替えることになる。

### `hostId` と `host` を分ける理由

Aurora では `@@aurora_server_id` がインスタンス名そのもので、`host` はそこにドメインを付けたものだから、両方を持つ意味は薄い。Multi-AZ で違いが出る。`mysql.rds_topology` の `id` は `db-` で始まる不透明な ID で、エンドポイントとは無関係な文字列になる ([トポロジクエリ (Multi-AZ MySQL)](../topology-query-multi-az/))。

`identifyConnection` は「この接続はどのインスタンスか」を `[instanceId, instanceName]` の組で受け取り、`hostId === instanceId || host === instanceName` で探す ([`rds_host_list_provider.ts#L198`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L198))。両方持っておくことで、DB の種類ごとに一致条件を変えずに済んでいる。

## どう活かすか

- **値オブジェクトを作り直す設計なら、状態はオブジェクトに持たせない。** 「毎回新品を作る」「状態は外部のキャッシュに置いて再投影する」の組み合わせは、ミュータブルなオブジェクトを共有するより追いやすい。ただし、投影のタイミング (ここでは次回の refresh) を把握していないと「設定したのに反映されない」に見える
- **仮定で始まる値には訂正の経路を用意する。** `role` だけ `readonly` を外すのは、どのフィールドが「仮定」なのかを型で示している
- **`equals` の比較対象は用途で変わる。** 「同じホストか」と「同じ状態か」は別の比較で、HostInfo の `equals` は後者寄りに `weight` を含めている。前者が欲しい `ClusterTopologyMonitor` は自前の抽出関数を書いた

### 実務で踏む失敗パターン

- **`setAvailability` した直後に `getHosts()` を見ても変わっていない。** 反映は次の `refreshHostList` である。`HostAvailabilityCacheItem` の方には即座に書かれている
- **可用性キャッシュは 5 分で消える。** 落ちたホストが 5 分後に `AVAILABLE` に戻り、接続試行の対象に入る。これは仕様で、[exponentialBackoff](../host-availability-and-selection/) を使わない場合の唯一の復帰経路になっている
- **`url` は `host:port/`。** ポートを指定しないと `port` が `-1` で `url` は `host/` になる。同じホストにポートありとなしで接続すると、可用性キャッシュのキーが別になる
