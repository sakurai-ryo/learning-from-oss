---
title: "auroraConnectionTracker — 遊休接続を writer 交代時に切る"
description: "failover が直すのは、そのとき使っていた接続 1 本だけ。プールに眠っていた他の接続は、旧 writer (今は reader) を指したまま残る。auroraConnectionTracker はプロセス全体の接続を static な Map に WeakRef で登録しておき、writer 交代を検知したら旧 writer への接続を全部 abort する。3 分間の「トポロジ再読込ウィンドウ」も static で共有される。"
group: "フェイルオーバー"
sidebar:
  order: 44
---

## 何を学んだか

[failover](../failover-overview/) はエラーを踏んだ接続を差し替えるが、**エラーを踏んでいない接続には何もしない**。アプリが 10 本の `AwsMySQLClient` を持っていて 1 本で `INSERT` が失敗したとき、残り 9 本は旧 writer に繋がったままで、次に使われたときに `errno 1290` (read-only) を返す。

`auroraConnectionTracker` はこれを埋める既定プラグインである。

- **プロセス全体の接続を 1 つの static Map に登録する。** キーはインスタンスエンドポイント、値は `WeakRef<ClientWrapper>` のリスト
- **writer の交代を検知したら、旧 writer への接続を全部 `abort` する。** 交代の検知は、自分が `FailoverError` を踏んだとき、トポロジ通知で `PROMOTED_TO_READER` / `PROMOTED_TO_WRITER` が来たとき、そして**他の接続が failover した後 3 分間**の毎メソッド呼び出し時
- 閉じられた遊休接続は、次に使われたときに mysql2 の `Can't add new command when connection is in closed state` を返す。これは [ネットワークエラーとして分類される](../failover-triggers/) ので、その接続の failover が正しく動く

## ソースコードのどこか

### 購読するメソッド

[`common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L31`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L31)。

```ts title="common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts"
private static readonly subscribedMethods = new Set<string>([
  ...SubscribedMethodHelper.NETWORK_BOUND_METHODS,
  "end",
  "abort",
  "notifyHostListChanged"
]);
private static readonly CLOSING_METHODS = new Set<string>(["end", "abort"]);
private static readonly TOPOLOGY_CHANGES_EXPECTED_TIME_NS = BigInt(3 * 60 * 1_000_000_000);
private static hostListRefreshEndTimeNs: bigint = 0n;
```

`NETWORK_BOUND_METHODS` は `connect` / `forceConnect` / `query` / `execute` / `rollback` / `beginTransaction` / `commit` / `changeUser` / `pause` / `resume` / `prepare` / `unprepare` ([`subscribed_method_helper.ts#L18`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/subscribed_method_helper.ts#L18))。DB との通信を伴うメソッド全部と、接続を閉じる 2 つを見る。

`hostListRefreshEndTimeNs` が **static** であることが、このプラグインの肝である。

### 登録 — connect のあと

[L60-82](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L60)。

```ts title="common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts"
const targetClient = await connectFunc();
let connectionHostInfo: HostInfo = this.pluginService.getRoutedHostInfo() ?? hostInfo;

if (targetClient && !this.pluginService.isPooledClient()) {
  const type: RdsUrlType = this.rdsUtils.identifyRdsType(connectionHostInfo.host);
  if (type.isRdsCluster || type === RdsUrlType.OTHER || type === RdsUrlType.IP_ADDRESS) {
    const identifiedHostInfo: HostInfo | null = await this.pluginService.identifyConnection(
      targetClient,
      connectionHostInfo,
    );
    if (identifiedHostInfo) {
      connectionHostInfo = identifiedHostInfo;
      await this.pluginService.setRoutedHostInfo(connectionHostInfo);
    }
  }
  const host = this.tracker.populateOpenedConnectionQueue(connectionHostInfo, targetClient);
  this.pluginService.setTrackedConnectionHost(host);
}
return targetClient;
```

`connectFunc()` を先に呼ぶ。つまり登録は接続が確立した後で、チェーンの後ろにいる `failover2` (StaleDns) や `efm2`、認証プラグインを通り抜けた接続が対象になる。

接続先がクラスタエンドポイント・カスタムドメイン・IP のときは、`identifyConnection` で「実際にはどのインスタンスか」を確かめてから登録する ([identifyConnection](../identify-connection/))。追跡のキーはインスタンス単位でないと意味がないからである。`initialConnection` が先に `setRoutedHostInfo` していれば ([initialConnection プラグイン](../initial-connection-strategy/)) それを使う。

内部プールの接続 (`isPooledClient()`) は登録しない。プールが自分で寿命を管理するからである ([内部コネクションプール](../internal-connection-pool/))。

### `OpenedConnectionTracker` — static Map と WeakRef

[`opened_connection_tracker.ts#L26`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/opened_connection_tracker.ts#L26)。

```ts title="common/lib/plugins/connection_tracker/opened_connection_tracker.ts"
export class OpenedConnectionTracker {
  static readonly openedConnections: Map<string, TrackedConnectionList> = new Map<string, TrackedConnectionList>();
  // ...
  populateOpenedConnectionQueue(hostInfo: HostInfo, client: ClientWrapper): TrackedConnection | null {
    if (!hostInfo || !client) {
      return null;
    }

    // Check if the connection was established using an instance endpoint.
    if (OpenedConnectionTracker.rdsUtils.isRdsInstance(hostInfo.host)) {
      const host = this.trackConnection(hostInfo.hostAndPort, client);
      this.logOpenedConnections();
      return host;
    }

    // It might be a custom domain name. Let's track by hostId and custom domain name.
    let lastHost: TrackedConnection | null = null;
    if (hostInfo.hostId) {
      lastHost = this.trackConnection(hostInfo.hostId, client);
    }
    if (hostInfo.hostAndPort) {
      lastHost = this.trackConnection(hostInfo.hostAndPort, client);
    }
    this.logOpenedConnections();
    return lastHost;
  }
```

`openedConnections` は `static readonly` で、**プロセスに 1 つ**。`AwsMySQLClient` ごとに `AuroraConnectionTrackerPlugin` も `OpenedConnectionTracker` も別インスタンスだが、Map だけは共有される。

値の `TrackedConnectionList` ([`tracked_connection_list.ts#L46`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/tracked_connection_list.ts#L46)) は `WeakRef<ClientWrapper>[]` で、`add` が `TrackedConnection` というハンドルを返す。ハンドルは自分の `WeakRef` を覚えていて、`remove()` でリストから自分だけを外せる。`end` / `abort` のときにこのハンドルを使うので、リスト全体を走査せずに済む。

```ts title="common/lib/plugins/connection_tracker/tracked_connection_list.ts"
add(client: ClientWrapper): TrackedConnection {
  const ref = new WeakRef(client);
  this.connections.push(ref);
  return new TrackedConnection(this, ref);
}

drainAll(): ClientWrapper[] {
  const connections = this.getConnections();
  this.connections.length = 0;
  return connections;
}
```

### 無効化 — 3 つのきっかけ

`execute` ([L84-127](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L84)) を読むと 3 つのきっかけが見える。

```ts title="common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts"
try {
  if (!isClosing) {
    let needRefreshHostList = false;
    const localRefreshEndTimeNs = AuroraConnectionTrackerPlugin.hostListRefreshEndTimeNs;
    if (localRefreshEndTimeNs > 0n) {
      if (localRefreshEndTimeNs > process.hrtime.bigint()) {
        needRefreshHostList = true;
      } else {
        AuroraConnectionTrackerPlugin.hostListRefreshEndTimeNs = 0n;
      }
    }
    if (this.needUpdateCurrentWriter || needRefreshHostList) {
      await this.checkWriterChanged(needRefreshHostList);
    }
  }

  const result = await methodFunc();

  if (isClosing) {
    // ... 追跡から外す
  }
  return result;
} catch (error) {
  if (error instanceof FailoverError) {
    AuroraConnectionTrackerPlugin.hostListRefreshEndTimeNs =
      process.hrtime.bigint() + AuroraConnectionTrackerPlugin.TOPOLOGY_CHANGES_EXPECTED_TIME_NS;
    // This call may effectively close/abort the current connection.
    await this.checkWriterChanged(true);
  }
  throw error;
}
```

1. **自分が `FailoverError` を踏んだ。** `FailoverSuccessError` / `FailoverFailedError` / `TransactionResolutionUnknownError` はすべて `FailoverError` の派生 ([`errors.ts#L39`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/errors.ts#L39))。このプラグインは failover2 (weight 710) より前 (400) にいるので、failover2 が投げた例外が `catch` に届く。static な `hostListRefreshEndTimeNs` を「今 + 3 分」に設定し、`checkWriterChanged(true)` を呼ぶ
2. **他の誰かが failover してから 3 分以内。** static なので、別の `AwsMySQLClient` が設定した期限が自分の `execute` でも読める。期限内なら毎回 `checkWriterChanged(true)` で `refreshHostList()` を呼び、writer が変わっていないか見る
3. **トポロジ通知。** `notifyHostListChanged` ([L167](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L167)) で `PROMOTED_TO_READER` が来たホストの接続を即座に無効化し、`PROMOTED_TO_WRITER` が来たら `needUpdateCurrentWriter` を立てて次の `execute` で確認する

`checkWriterChanged` ([L129](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L129)) が実際の比較をする。

```ts title="common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts"
const hostInfoAfterFailover = this.getWriter(this.pluginService.getAllHosts());
if (hostInfoAfterFailover === null) {
  return;
}

if (this.currentWriter === null) {
  this.currentWriter = hostInfoAfterFailover;
  this.needUpdateCurrentWriter = false;
} else if (this.currentWriter.hostAndPort !== hostInfoAfterFailover.hostAndPort) {
  // The writer changed.
  await this.tracker.invalidateAllConnections(this.currentWriter);
  this.tracker.logOpenedConnections();
  this.currentWriter = hostInfoAfterFailover;
  this.needUpdateCurrentWriter = false;
  AuroraConnectionTrackerPlugin.hostListRefreshEndTimeNs = 0n;
}
```

`currentWriter` はプラグインごと (= 接続ごと) に覚えている「前回見た writer」で、トポロジの writer と `hostAndPort` が違えば交代とみなす。`invalidateAllConnections(旧 writer)` は Map から旧 writer のキー (`hostAndPort` / `host` / `hostId` の 3 通り) でリストを引き、`drainAll` して 1 本ずつ `abortTargetClient` する ([`opened_connection_tracker.ts#L59`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/opened_connection_tracker.ts#L59))。MySQL では `abort` は mysql2 の `destroy()` に落ちる ([HostMonitor](../host-monitor/) と同じ経路)。

交代を確認したら static の期限を 0 に戻す。3 分待たずにウィンドウを閉じる。

### 後始末

`end` / `abort` の後で `TrackedConnection.remove()` を呼び、自分をリストから外す。`releaseResources()` ([L183](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L183)) は `pruneNullConnections` で、`deref()` が `undefined` になった (GC 済みの) 参照を全キーから掃除し、空になったキーを消す。

## なぜそうなっているか

### なぜ static なのか

failover が直せるのは「今エラーを踏んだ接続」だけで、それはプラグインインスタンスが属する `AwsMySQLClient` 1 つ分である。遊休接続は別の `AwsMySQLClient` の中にあり、そのプラグインインスタンスは何も起きていないので自分からは動かない。

こちらから触るには、プロセス内の全接続に届く場所が要る。`Architecture.md` の注記どおり `PluginManager` / `PluginService` / プラグインは**クライアントごと**なので、共有できるのは static フィールドか [CoreServicesContainer](../core-services-container/) しかない。`openedConnections` と `hostListRefreshEndTimeNs` を static にしたのはそのためである。

`hostListRefreshEndTimeNs` が static であることの効果は大きい。1 本が failover したら、**その後 3 分間は他の全接続が使われるたびにトポロジを確認する**。遊休接続が次に使われるとき、`methodFunc()` の前に `checkWriterChanged(true)` が走り、writer が変わっていればその接続を含む旧 writer 宛の全接続が閉じられ、`methodFunc()` は閉じた接続で実行されて `Can't add new command when connection is in closed state` になる。そのエラーはネットワークエラーなので、その接続の failover2 が新 writer に差し替えて `FailoverSuccessError` を投げる。

### なぜ 3 分なのか

定数名 `TOPOLOGY_CHANGES_EXPECTED_TIME_NS` が答えで、「フェイルオーバーに伴うトポロジの変化が落ち着くと期待する時間」である。Aurora のフェイルオーバーは通常 30 秒以内に終わるが、全ホストが一度落ちて順に戻る ([フェイルオーバーで何が起きるか](../what-happens-on-failover/)) ので、トポロジが最終形になるまでには幅がある。3 分は安全側の見積もりで、`checkWriterChanged` が交代を確認した時点で 0 に戻すので、実際にはもっと早く閉じる。

### なぜ WeakRef なのか

追跡リストが `ClientWrapper` を強参照すると、アプリが `end()` を呼ばずに接続を捨てた場合、GC されずに残る。static Map なのでプロセスが生きている限りリークする。`WeakRef` にしておけば、アプリが参照を捨てた接続は GC の対象になり、`deref()` が `undefined` を返すようになる。`getConnections()` はそれを読み飛ばし、`pruneNullConnections()` が定期的に掃除する。

ただし `WeakRef` は「参照が消えたら自動で外れる」わけではない。空の `WeakRef` はリストに残り続けるので、`isEmpty()` は GC 済みの参照も数える (クラスコメントに明記されている)。`releaseResources()` を呼ばないと Map のキーは増える一方になる。`UsingTheAuroraConnectionTrackerPlugin.md` の Warning がそれである。

### なぜ `read-only` エラーではなく `closed state` エラーにするのか

閉じずに放っておいても、旧 writer に繋いだ接続で `INSERT` すれば `errno 1290` が返り、それも [strict-writer なら failover のトリガになる](../failover-triggers/)。ただし `errno 1290` は「実行時エラー」で、mysql2 の接続自体は生きている。`SELECT` は通ってしまうので、reader で読んでいることに気づけない。

閉じてしまえば、`SELECT` でも `Can't add new command when connection is in closed state` になり、すべての操作が failover の入口を通る。`UsingTheAuroraConnectionTrackerPlugin.md` はまさにこの差を "instead of" で説明している。

### 内部プールを除外する理由

`InternalPooledConnectionProvider` の接続は mysql2 の `Pool` が持っていて、`AwsMySQLClient` からは借りては返す。借りている間だけ `targetClient` になる接続を追跡しても、返した後に閉じると Pool が壊れた接続を配ることになる。プール側には `leastConnections` やプールごとの破棄の仕組みがあるので、そちらに任せる ([接続の寿命管理](../connection-lifetime/))。

## どう活かすか

- **「今エラーを踏んだもの」以外への波及は、別の仕組みとして切り出す。** 自動復旧は当該接続を直すことに集中させ、同じ宛先を持つ他の資源の無効化は横断的なレジストリに任せる。責務が分かれるので、failover 側は「他の接続」を一切知らずに済む
- **プロセス全体で共有したい状態は、共有していることを名前と型で明示する。** `static readonly openedConnections` は static であることが一目で分かる。DI コンテナに隠すより、この規模ならこちらのほうが読める
- **弱参照レジストリには掃除の入口を必ず付ける。** `WeakRef` は「消えたら外れる」ではない。`pruneNullConnections` のような明示的な掃除がないと、空の参照が溜まる。`FinalizationRegistry` を使う手もあるが、ここでは呼び出しタイミングを制御できる手動掃除を選んでいる
- **「壊れた状態で使わせる」より「使えない状態にして早く気づかせる」。** 閉じた接続は最初の操作で失敗するので、reader で読み続けるより早く問題が表面化する
- **取り込むべきでない条件。** 接続を追跡する構造は、接続が「誰のものか」を DB 側の情報 (`identifyConnection`) で決められる場合にだけ成立する。宛先が特定できない (RDS Proxy 越しなど) 構成では、キーが定まらず何も無効化できない

### つまずきどころ

- **`PluginManager.releaseResources()` を呼ばないと static Map が育つ。** 短命な `AwsMySQLClient` を大量に作る構成 (リクエストごとに new して `end()` する Lambda など) では、`end()` で `remove()` されるので通常は増えないが、`end()` を呼ばずに捨てるとリストに空 `WeakRef` が残る
- **3 分ウィンドウ中は毎メソッドで `refreshHostList()` が走る。** `refreshHostList` はキャッシュが有効なら DB に行かないが、`clusterTopologyRefreshRateMs` (30 秒) を過ぎていればクエリになる。他の接続が failover した直後の 3 分間、遊休だった接続の最初のクエリは少し遅くなる
- **`FailoverError` は `catch` で再 throw される。** このプラグインが例外を握りつぶすことはない。`FailoverSuccessError` を受け取るアプリ側の契約 ([FailoverSuccessError](../failover-success-error/)) は変わらない
- **`identifyRdsType` が `RDS_INSTANCE` を返す接続は `identifyConnection` を飛ばす。** インスタンスエンドポイントで繋いだ接続は、その名前がそのままキーになる。Blue/Green の切り替えでインスタンス名が変わる状況 ([Blue/Green](../blue-green-switchover/)) では、キーの不一致で無効化から漏れ得る
