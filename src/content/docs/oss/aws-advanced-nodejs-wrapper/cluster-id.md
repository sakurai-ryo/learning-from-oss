---
title: "clusterId — キャッシュとモニタの共有単位"
description: 'トポロジキャッシュ・ClusterTopologyMonitor・Dialect 確認済みフラグは、すべて clusterId をキーにプロセス全体で共有される。3.0.0 で URL からの自動導出を捨て、既定値は誰でも "1" になった。複数クラスタに繋ぐアプリが設定を忘れると、別クラスタのトポロジが上書きされ、間違ったクラスタへフェイルオーバーする。'
group: "トポロジを知る"
sidebar:
  order: 31
---

## 何を学んだか

`PluginService` は接続ごとに 1 つだが、`StorageService` と `MonitorService` はプロセスに 1 つしかない ([CoreServicesContainer](../core-services-container/))。だから「どの接続同士がトポロジを共有するか」を決める名前空間が要る。それが `clusterId` で、次の 3 つのキーになっている。

- `StorageService` の `Topology` キャッシュ
- `MonitorService` の `ClusterTopologyMonitorImpl`
- `StatusCacheItem` の「Dialect 確認済み」フラグ (`${clusterId}::DialectConfirmed`)

値は接続プロパティ `clusterId` からしか来ない。既定は `"1"`。**同じクラスタには同じ値、別のクラスタには別の値**を渡すのはアプリの責任で、ラッパは URL から推測しない。

## ソースコードのどこか

### プロパティ

[`common/lib/wrapper_property.ts#L481`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L481)。

```ts title="common/lib/wrapper_property.ts"
static readonly CLUSTER_ID = new WrapperProperty<string>(
  "clusterId",
  "A unique identifier for the cluster. Connections with the same cluster id share a cluster topology cache. If unspecified, cluster id will be '1'.",
  "1"
);
```

### 読む場所

`RdsHostListProvider` が `initSettings` で読む ([`rds_host_list_provider.ts#L101`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L101))。

```ts title="common/lib/host_list_provider/rds_host_list_provider.ts"
public clusterId: string = Date.now().toString();
// ...
protected initSettings(): void {
  // ...
  this.clusterId = WrapperProperties.CLUSTER_ID.get(this.properties);
  // ...
}
```

フィールドの初期値 `Date.now().toString()` は `initSettings` で必ず上書きされる。`init()` を通らずに `clusterId` を読む経路はなく、この初期値は残骸である。

### 使う場所 1 — トポロジキャッシュ

[`rds_host_list_provider.ts#L252`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L252)。

```ts title="common/lib/host_list_provider/rds_host_list_provider.ts"
getStoredTopology(): HostInfo[] | null {
  if (!this.clusterId) {
    return null;
  }

  const topology: Topology = this.storageService.get(Topology, this.clusterId);

  return topology == null ? null : topology.hosts;
}
```

書く側は `ClusterTopologyMonitorImpl.updateTopologyCache` で、同じキーに `new Topology(hosts)` を置く ([`cluster_topology_monitor.ts#L349`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/cluster_topology_monitor.ts#L349))。`Topology` 用の `ExpirationCache` は既定設定で、有効期限 5 分、読むたびに延長される ([`storage_service.ts#L129`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/storage/storage_service.ts#L129)、[`expiration_cache.ts#L51`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/storage/expiration_cache.ts#L51))。

### 使う場所 2 — モニタ

[`rds_host_list_provider.ts#L113`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/rds_host_list_provider.ts#L113)。

```ts title="common/lib/host_list_provider/rds_host_list_provider.ts"
protected async getOrCreateMonitor(): Promise<ClusterTopologyMonitor> {
  const initializer: MonitorInitializer = {
    createMonitor: (servicesContainer: FullServicesContainer): ClusterTopologyMonitor => {
      return new ClusterTopologyMonitorImpl(
        servicesContainer,
        this.topologyUtils,
        this.clusterId,
        this.initialHost,
        this.properties,
        this.clusterInstanceTemplate,
        this.refreshRateNano,
        this.highRefreshRateNano
      );
    }
  };

  return await this.servicesContainers.monitorService.runIfAbsent(
    ClusterTopologyMonitorImpl,
    this.clusterId,
    this.servicesContainers,
    this.properties,
    initializer
  );
}
```

`runIfAbsent` ([`monitor_service.ts#L250`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/monitoring/monitor_service.ts#L250)) は `(ClusterTopologyMonitorImpl, clusterId)` の組で既存のモニタを探し、あればそれを返し、なければ `initializer.createMonitor` で作って `start()` する。**モニタが持つ `initialHost`・`properties`・`clusterInstanceTemplate` は、最初にそのキーで作った接続のもの**になる。2 番目以降の接続は自分の設定を渡しても無視される。

### 使う場所 3 — Dialect 確認済みフラグ

[`plugin_service.ts#L298`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L298)。

```ts title="common/lib/plugin_service.ts"
private getDialectConfirmedCacheKey(): string {
  let clusterId = WrapperProperties.CLUSTER_ID.defaultValue;
  try {
    clusterId = this._hostListProvider?.getClusterId() ?? WrapperProperties.CLUSTER_ID.defaultValue;
  } catch (e) {
    // May fail if the host list provider does not support getClusterId. In this case use the default value.
  }
  return `${clusterId}::${PluginServiceImpl.DIALECT_CONFIRMED_STATUS_KEY}`;
}
```

`ConnectionStringHostListProvider.getClusterId` は例外を投げるので、Community MySQL では `"1"` が使われる。「このクラスタの Dialect は確認済み」というフラグも `clusterId` 単位で、同じ `clusterId` の 2 本目以降の接続は Dialect の再確認を飛ばせる ([Dialect の自動判定](../dialect-resolution/))。

### 3.0.0 で捨てたもの

`CHANGELOG.md` の 3.0.0 Breaking Changes から引く。

> `clusterId` is no longer derived automatically, and applications that connect to more than one database cluster must now set it explicitly. Previously the wrapper generated a cluster id from the connection URL and, for AWS RDS clusters, converged connections made through instance endpoints, IP addresses or custom domains onto the cluster endpoint's id. That derivation, along with the suggested and primary cluster id caches, has been removed: `clusterId` is now taken only from the configuration parameter and defaults to `1` for every connection.

2.x までは、接続文字列がクラスタエンドポイントならその名前から ID を作り、インスタンスエンドポイントや IP で繋いだ接続もトポロジを見て同じクラスタの ID に「収束」させていた。その収束のための「suggested cluster id」「primary cluster id」の 2 つのキャッシュごと削除された。

`RdsUtils.getRdsClusterId` はまだ残っているが、使っているのは customEndpoint / Blue/Green / Global DB のユーティリティだけで、`clusterId` の導出には使われていない。

## なぜそうなっているか

### なぜ URL から導出できないのか

`docs/using-the-nodejs-wrapper/ClusterId.md` が理由を列挙している。

- IP アドレス `10.0.1.50` にはクラスタ情報がない
- カスタムドメイン `db.mycompany.com` も同じ
- カスタムエンドポイント `x.cluster-custom-abc...` はクラスタ名ではなくエンドポイント名を持つ
- RDS Proxy はプロキシの名前しか持たない

これら全部が同じクラスタを指しうる。2.x はトポロジを取ってから「このインスタンスはあのクラスタにいる」と収束させていたが、それは「トポロジを取るためのモニタ」を作る前に `clusterId` が要る、という循環を抱えていた。収束前の一時 ID と収束後の ID の 2 段階になり、その間のキャッシュとモニタの引き継ぎが複雑だった。

3.0.0 は「アプリが知っているのだから、アプリに言わせる」に倒した。ラッパ側は単純になり、その代わりに設定漏れが破壊的な結果を招く。

### なぜ既定が `"1"` なのか

単一クラスタのアプリ (大半) に設定を要求しないためである。1 クラスタしか繋がないなら、全接続が `"1"` を共有しても正しい。クラスタエンドポイント経由と IP 経由が混ざっていても、同じ `"1"` なら同じトポロジキャッシュとモニタを使い、2.x の収束と同じ結果になる。

`ClusterId.md` はこれを「Single Cluster Applications では省略可」と書き、複数クラスタでは「必須」と書いている。

### 衝突すると何が起きるか

同じ `clusterId` で 2 つのクラスタに繋ぐと、

1. `Topology` キャッシュが 1 つになり、後にモニタが書いた方のトポロジで上書きされる
2. `ClusterTopologyMonitorImpl` は最初に作られた 1 個だけで、2 つ目のクラスタの接続はそのモニタ (1 つ目のクラスタを監視している) の結果を待つ
3. failover2 は `forceMonitoringRefresh` の結果から新 writer を選ぶので、**1 つ目のクラスタの writer に接続を差し替える**

3 が「failover to the wrong cluster」で、`CHANGELOG` と `ClusterId.md` の両方が警告している。逆に同じクラスタに違う `clusterId` を付けると、モニタとキャッシュが 2 組できて無駄になるが、壊れはしない。

## どう活かすか

- **プロセス全体で共有するキャッシュには、必ず名前空間を持たせ、その名前空間を誰が決めるかを明示する。** 自動導出が難しいなら、既定値 + 明示設定に倒す方が、推測が外れたときの被害より小さい
- **「最初に作った者の設定が勝つ」共有リソースは、そのことを docs に書く。** `runIfAbsent` の性質上、2 本目の接続が `topology_monitoring_` 系のプロパティを変えても効かない
- **破壊的変更をするなら、既定値を「単一利用者に無害」にする。** `"1"` は単一クラスタでは何も壊さず、複数クラスタで初めて問題になる。影響範囲を最小にする既定値の選び方である

### 実務で踏む失敗パターン

- **マイクロサービスが 2 クラスタに繋ぐのに `clusterId` を付けていない。** 3.0.0 に上げた瞬間に衝突する。2.x では自動導出で分かれていたので気づかない。フェイルオーバー時に別クラスタへ繋ぎ、`Unknown database` や権限エラーが出る
- **同じクラスタに reader エンドポイントと writer エンドポイントで別 `clusterId` を付ける。** モニタが 2 本立ち、トポロジキャッシュも 2 つになる。動くが無駄で、`ClusterId.md` は「SUBOPTIMAL」としている
- **`topology_monitoring_` 系の設定を 2 本目の接続で変えても効かない。** モニタは `clusterId` で共有され、最初の接続の設定で作られる。変えたいなら全接続で揃えるか、プロセスを再起動する
- **Community MySQL では `clusterId` は Dialect フラグのキーにしか使われない。** `RdsHostListProvider` が作られないので、トポロジキャッシュもモニタも存在しない
