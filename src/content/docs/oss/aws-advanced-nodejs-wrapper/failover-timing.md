---
title: "時間設計 — タイムアウト群と normal/aggressive プロファイル"
description: "failoverTimeoutMs 300 秒の外枠の中に、reader バッチの 30 秒、Task A/B の 2 秒間隔、接続の 10 秒、クエリの 20 秒、EFM の 30+5×3 秒が入れ子になっている。どの値がどの層で効き、v1 と v2 でどれが無視されるのかを 1 枚の表にする。攻めすぎると「全ホストが一瞬落ちる」に引っかかって失敗になる理由も docs にある。"
group: "フェイルオーバー"
sidebar:
  order: 45
---

## 何を学んだか

フェイルオーバーに関わる時間パラメータは 10 個以上あり、**すべてが同じ層で効くわけではない**。

- `failoverTimeoutMs` (300 秒) だけが全体の外枠で、v1 と v2 の両方で効く
- `failoverReaderConnectTimeoutMs` / `failoverWriterReconnectIntervalMs` / `failoverClusterTopologyRefreshRateMs` は **v1 専用**
- `clusterTopologyRefreshRateMs` / `clusterTopologyHighRefreshRateMs` は **モニタ用**で、v2 のフェイルオーバー速度を実質決める
- `wrapperConnectTimeout` / `wrapperQueryTimeout` は 1 回の接続・クエリの上限で、フェイルオーバー中の各試行にもそのまま掛かる
- EFM の `failureDetectionTime` + `Interval` × `Count` は「実行中のクエリの裏で、ホストの死に気づくまで」の時間で、フェイルオーバー自体の時間ではない。既定値では `wrapperQueryTimeout` の 20 秒が先に来る

`FailoverConfigurationGuide.md` の normal / aggressive プロファイルは v1 の 4 パラメータを並べたもので、aggressive にすると「障害ではなくタイムアウトで失敗する」確率が上がる。

## ソースコードのどこか

### パラメータ一覧

定義は全部 [`common/lib/wrapper_property.ts`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts) にある。

| パラメータ                             |    既定 | 効く場所                                                                                                                                                                            |           v1           |      v2      |
| -------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------: | :----------: |
| `failoverTimeoutMs`                    | 300,000 | フェイルオーバー全体の期限 ([L411](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L411))           |           ✓            |      ✓       |
| `failoverReaderConnectTimeoutMs`       |  30,000 | reader 接続バッチ 1 回の期限 ([L417](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L417))         |           ✓            |              |
| `failoverWriterReconnectIntervalMs`    |   2,000 | Task A の再接続間隔 ([L412](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L412))                  |           ✓            |              |
| `failoverClusterTopologyRefreshRateMs` |   2,000 | Task B のトポロジ再読込間隔 ([L403](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L403))          |           ✓            |              |
| `clusterTopologyRefreshRateMs`         |  30,000 | モニタの通常間隔 ([L467](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L467))                     | (キャッシュ期限として) |      ✓       |
| `clusterTopologyHighRefreshRateMs`     |     100 | モニタのパニック / 高速間隔 ([L475](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L475))          |                        |      ✓       |
| `wrapperConnectTimeout`                |  10,000 | mysql2 の `connectTimeout` に変換 ([L306](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L306))    |           ✓            |      ✓       |
| `wrapperQueryTimeout`                  |  20,000 | `queryWithTimeout` の `Promise.race` ([L312](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L312)) |           ✓            |      ✓       |
| `openConnectionRetryTimeoutMs`         |  30,000 | `initialConnection` のリトライ期限 ([L522](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L522))   |      初回接続のみ      | 初回接続のみ |
| `openConnectionRetryIntervalMs`        |   1,000 | 同上の間隔 ([L527](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L527))                           |      初回接続のみ      | 初回接続のみ |
| `failureDetectionTime`                 |  30,000 | EFM: 最初のプローブまで ([L533](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L533))              |         検知側         |    検知側    |
| `failureDetectionInterval`             |   5,000 | EFM: プローブ間隔 ([L545](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L545))                    |         検知側         |    検知側    |
| `failureDetectionCount`                |       3 | EFM: 不健全と判定する失敗回数 ([L551](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L551))        |         検知側         |    検知側    |

コードに直書きされていて設定できない値もある。

| 定数                                                         |      値 | 場所                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reader バッチ間の `sleep`                                    | 1,000ms | [`reader_failover_handler.ts#L166`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/reader_failover_handler.ts#L166)                           |
| strict-reader で役割不一致だったときの `sleep`               | 1,000ms | [`reader_failover_handler.ts#L134`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/reader_failover_handler.ts#L134)                           |
| Task B が reader に繋げなかったときの待ち                    | 1,000ms | [`writer_failover_handler.ts#L395`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/writer_failover_handler.ts#L395)                           |
| `forceRefreshHostList()` のトポロジクエリ期限                | 5,000ms | [`partial_plugin_service.ts#L53`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/partial_plugin_service.ts#L53)                                                |
| モニタが「安定した」と判断するまでの reader トポロジ一致期間 |   15 秒 | [`cluster_topology_monitor.ts#L63`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/cluster_topology_monitor.ts#L63)              |
| `auroraConnectionTracker` のトポロジ再読込ウィンドウ         |    3 分 | [`aurora_connection_tracker_plugin.ts#L38`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/connection_tracker/aurora_connection_tracker_plugin.ts#L38) |

### v1 の入れ子

[`failover_plugin.ts#L212`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/failover_plugin.ts#L212) の `initSettings` で 4 つを読み、コンストラクタで 2 つの handler に渡す。

```ts title="common/lib/plugins/failover/failover_plugin.ts"
this._readerFailoverHandler = readerFailoverHandler
  ? readerFailoverHandler
  : new ClusterAwareReaderFailoverHandler(
      this.pluginService,
      properties,
      this.failoverTimeoutMsSetting,
      this.failoverReaderConnectTimeoutMsSetting,
      this.failoverMode === FailoverMode.STRICT_READER,
    );
this._writerFailoverHandler = writerFailoverHandler
  ? writerFailoverHandler
  : new ClusterAwareWriterFailoverHandler(
      this.pluginService,
      this.servicesContainer,
      this._readerFailoverHandler,
      properties,
      this.failoverTimeoutMsSetting,
      this.failoverClusterTopologyRefreshRateMsSetting,
      this.failoverWriterReconnectIntervalMsSetting,
    );
```

handler 側にはクラス既定値 (60 秒、5 秒、5 秒) が書いてあるが ([`writer_failover_handler.ts#L58`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/writer_failover_handler.ts#L58))、プラグイン経由では常に `WrapperProperties` の値で上書きされる。テスト用の既定である。

writer フェイルオーバーの時間構造は、外から順にこうなる。

```
failoverTimeoutMs (300s) ─────────────────────────────────────────────┐
  Task A: [forceConnect ≤ wrapperConnectTimeout (10s)]                  │
          [forceRefreshHostList ≤ 5s] sleep failoverWriterReconnectIntervalMs (2s) …  │
  Task B: getReaderConnection ───────────────────────────────┐          │
            バッチ 1: 2 本 forceConnect ≤ failoverReaderConnectTimeoutMs (30s) │
            sleep 1s                                         │          │
            バッチ 2: …                                       │          │
          ─────────────────────────────────────────────────┘          │
          [forceRefreshHostList ≤ 5s] sleep failoverClusterTopologyRefreshRateMs (2s) …  │
          [forceConnect 新 writer ≤ 10s]                                 │
──────────────────────────────────────────────────────────────────────┘
```

`Promise.race` の期限は [`writer_failover_handler.ts#L118`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/writer_failover_handler.ts#L118) の `timeoutTask` で、切れると `"Connection attempt task timed out."` を reject し、`catch` で `isConnected: false` の結果に変換される。本体はそれを `FailoverFailedError("Unable to establish SQL connection to the writer instance.")` にする。

reader フェイルオーバーは [`reader_failover_handler.ts#L88`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/reader_failover_handler.ts#L88) の `failoverTask` が `failoverTimeoutMs` の `race` を掛け、切れると `InternalQueryTimeoutError("Internal failover task has timed out.")` になる。バッチの 30 秒は `getResultFromNextTaskBatch` ([L174](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/reader_failover_handler.ts#L174)) で、こちらは切れても次のバッチに進む。

### v2 の入れ子

[`failover2_plugin.ts#L80`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L80) で読むのは `failoverTimeoutMs` と `failoverReaderHostSelectorStrategy` だけである。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
if (!(await this.pluginService.forceMonitoringRefresh(true, this.failoverTimeoutSettingMs))) {
  // Unable to establish SQL connection to writer node.
  this.logAndThrowError(Messages.get("Failover2.unableToFetchTopology"));
}
```

`failoverTimeoutMs` は「モニタが writer を確認するのを待つ時間」に化ける。その間モニタは `clusterTopologyHighRefreshRateMs` (100ms) 間隔で全ホストに「自分は writer か」を聞き続ける ([ClusterTopologyMonitor](../cluster-topology-monitor/))。各ホストへの接続は `wrapperConnectTimeout` (モニタ用は `topology_monitoring_` 接頭辞で別値にできる) で切れる。

```
failoverTimeoutMs (300s) ───────────────────────────────────────┐
  forceMonitoringRefresh(true) → モニタがパニックモード           │
    各ホスト: [connect ≤ 10s] [IS_WRITER_QUERY ≤ 5s]  100ms 間隔  │
    新 writer 確定 → 待っていた全接続を起こす                     │
  [createConnectionForHost 新 writer ≤ 10s]                     │
  [getHostRole ≤ 20s]                                           │
────────────────────────────────────────────────────────────────┘
```

v1 で 2 秒だった「トポロジを読み直す間隔」が、v2 では 100ms になっている。v2 が速いのは、アルゴリズムの違いより**この間隔の差**による部分が大きい。

### 検知側の時間

フェイルオーバーは「エラーを踏んで」始まる ([何をトリガとするか](../failover-triggers/))。エラーが返るまでの時間は、フェイルオーバーの時間とは別に数える。

| 状況                                                       |                                                       エラーまでの時間 | 決めているもの                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------: | --------------------------------------------------------------------------------------------------------------------- |
| writer プロセスが TCP を RST                               |                                                               ほぼ即時 | OS。遊休中なら mysql2 の `error` イベントを tracking リスナが拾い、次の `execute` 冒頭の `hasNetworkError()` で投げる |
| ホストが無応答 (電源断、ネットワーク分断) で、クエリ実行中 | `wrapperQueryTimeout` 20 秒か、EFM の 30 + 5 × 3 = 45 秒の**早いほう** | `queryWithTimeout` の `Promise.race` / `failureDetectionTime` + `Interval` × `Count`                                  |
| ホストが無応答で、遊休中                                   |                   次のクエリを投げるまで何も起きない。投げた後は上の行 |                                                                                                                       |
| 新規接続がタイムアウト                                     |                                          `wrapperConnectTimeout` 10 秒 | mysql2 `connectTimeout`                                                                                               |

EFM は**メソッド実行中だけ**動く。`HostMonitoring2ConnectionPlugin.execute` は `NETWORK_BOUND_METHODS` のときだけ `startMonitoring` して `methodFunc()` を待ち、終わったら `stopMonitoring` する ([`host_monitoring2_connection_plugin.ts#L33`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/efm/v2/host_monitoring2_connection_plugin.ts#L33))。既定値のままだと `wrapperQueryTimeout` の 20 秒が先に来るので、EFM の 45 秒は出番がない。EFM が効くのは、長いクエリのために `wrapperQueryTimeout` を数分に伸ばした構成で、そのとき「クエリ自体は正常に長い」と「ホストが死んで応答がない」を区別する手段になる ([なぜ EFM が要るか](../why-efm/))。

### normal / aggressive プロファイル

`FailoverConfigurationGuide.md` の 2 表。

| パラメータ                             |    既定 |  normal | aggressive |
| -------------------------------------- | ------: | ------: | ---------: |
| `failoverTimeoutMs`                    | 300,000 | 180,000 |     30,000 |
| `failoverWriterReconnectIntervalMs`    |   2,000 |   2,000 |      2,000 |
| `failoverReaderConnectTimeoutMs`       |  30,000 |  30,000 |     10,000 |
| `failoverClusterTopologyRefreshRateMs` |   2,000 |   2,000 |      2,000 |

4 つとも v1 のパラメータで、v2 で意味があるのは `failoverTimeoutMs` だけである。aggressive の 30 秒は、reader バッチ 1 回分 (10 秒) × 3 回でほぼ使い切る。

## なぜそうなっているか

### なぜ既定が 5 分なのか

`FailoverConfigurationGuide.md` は "Failover should be completed within 5 minutes by default" と書き、その直後に Warning で「攻めた設定は、障害ではなくタイムアウトが原因の失敗を増やす」と釘を刺している。

Aurora のフェイルオーバーが 30 秒で終わるなら 5 分は長すぎるように見える。だが同じ docs の "Host Availability" 節が理由を書いている。**フェイルオーバー中は全ホストが一度落ちる**。コントロールプレーンは全ホストを止め、writer を起動し、残りを writer に接続させる。この間、reader に繋いでトポロジを読もうとしても、reader 自体が再構成中で応答しない時間がある。

v1 の Task B はこの「reader が応答しない」時間を、`failoverReaderConnectTimeoutMs` (30 秒) のバッチをまたいで待ち続ける。3 台構成で全部が一瞬落ちれば、最初のバッチは 30 秒丸ごと空振りする。5 分はそれを何巡か吸収する余裕として置かれている。

### なぜ v2 でパラメータが減ったのか

v1 は「接続ごとに自分でフェイルオーバーする」ので、再接続の間隔・トポロジ読み直しの間隔・reader 接続の期限が、それぞれの接続のフェイルオーバー速度を決める。接続が 100 本あれば 100 本がそれぞれ 2 秒ごとにトポロジを読む。

v2 は検出をモニタ 1 つに集約したので、「どのくらいの頻度で読むか」はモニタの設定 (`clusterTopologyHighRefreshRateMs`) になり、接続側には「いつまで待つか」(`failoverTimeoutMs`) しか残らない。100ms という v1 の 20 倍の頻度が許されるのは、読む主体が 1 つになったからである。

### なぜ 2 秒と 100ms なのか

v1 の 2 秒は「接続ごとに」トポロジクエリを打つ前提の間隔で、`SupportForRDSMultiAzDBCluster.md` は Multi-AZ の 1 秒切り替えに追いつくため `failoverClusterTopologyRefreshRateMs` を 100ms にする案を書き、同時に "this can potentially increase the workload on the database during the switchover" と警告している。v1 で 100ms にするのは、接続数分の負荷を DB に掛けることになる。

v2 の 100ms は同じ値だが、打つのはモニタだけである。パニックモードの終了後も、docs によれば 30 秒間は高速モードが続き、その後 `clusterTopologyRefreshRateMs` (30 秒) に戻る。

### なぜ `wrapperQueryTimeout` がフェイルオーバーの各段に効くのか

`forceRefreshHostList()` のトポロジクエリ、`getHostRole` の `@@innodb_read_only`、`identifyConnection` の `@@aurora_server_id` は、すべて `ClientUtils.queryWithTimeout` を通る ([MySQLErrorHandler](../mysql-error-handler/))。フェイルオーバー中に応答しないホストに当たったとき、この上限がないと `Promise` が永久に解決しない。mysql2 の `timeout` オプションはクエリ単位で、接続レベルの既定がないので、ラッパが自前で `Promise.race` を掛けている ([2 種類の Dialect](../two-dialects/))。

`monitoring_wrapperQueryTimeout` / `topology_monitoring_wrapperQueryTimeout` を設定しないと、監視系の接続はこの既定 20 秒で動く。監視間隔 (100ms) より桁違いに長いので、応答しないホストに当たったモニタタスクは 20 秒固まる。

## どう活かすか

- **タイムアウトは「どの層で効くか」を表にしてから決める。** 外枠 (全体の期限)、中段 (1 回の試行の期限)、内側 (1 回の I/O の期限) が入れ子になっていることを確認し、内側の合計が外枠を超えていないかを見る。aggressive の 30 秒は reader バッチ 10 秒 × 3 で使い切る
- **「相手が直る時間」を先に調べる。** 5 分は Aurora の全ホスト再起動を吸収する時間から来ている。相手の復旧時間を知らずに短くすると、docs の Warning のとおり「タイムアウトが障害に見える」
- **検知の時間と復旧の時間を分けて数える。** 実行中のクエリが 20 秒 (`wrapperQueryTimeout`) か 45 秒 (EFM) で気づくのと、気づいてから 30 秒で復旧する (failover) のは別の予算で、どちらを縮めたいかで触るパラメータが違う
- **v1 のパラメータを v2 に持ち込まない。** `failoverReaderConnectTimeoutMs` を設定しても failover2 は読まない。CHANGELOG の「2.1.1 で既定が failover2 になった」を見落として、古い記事のプロファイル設定を貼ると、効いていないのに効いたつもりになる
- **取り込むべきでない条件。** 2 台クラスタでは、docs のとおりフェイルオーバーが役割交換にしかならず、片方が壊れていれば壊れたまま writer になる。時間を詰めても意味がないので、まず台数を 3 以上にする

### つまずきどころ

- **`failoverTimeoutMs` を短くしすぎると "Host Availability" に引っかかる。** 全ホストが落ちている 10〜30 秒の間に期限が来ると `FailoverFailedError` になり、アプリは接続を作り直す羽目になる。その新規接続も DNS が古いので、[initialConnection](../initial-connection-strategy/) の 30 秒リトライに入る
- **`wrapperConnectTimeout` は監視接続にも効く。** モニタが応答しないホストに繋ぎに行くたびに 10 秒待つ。`topology_monitoring_wrapperConnectTimeout` で短くできる
- **`openConnectionRetryTimeoutMs` (30 秒) はフェイルオーバーではなく初回接続の時間。** フェイルオーバー中に `new AwsMySQLClient().connect()` を呼ぶと、こちらの 30 秒が先に効く
- **EFM は遊休接続を見ていない。** `failureDetectionTime` は「SQL を送ってから最初のプローブまで」で、監視は `methodFunc()` の実行中だけ動く。遊休中にホストが死んでも、次のクエリを投げるまで誰も気づかない。遊休接続の掃除は [auroraConnectionTracker](../connection-tracker/) の仕事で、EFM とは別である ([failureDetectionTime / Interval / Count](../failure-detection-params/))
