# aws-advanced-nodejs-wrapper 章の執筆計画

2026-09-02 時点の章立て。ページはまだ 1 枚も書いていない。出力先は `src/content/docs/oss/aws-advanced-nodejs-wrapper/`。ページの形式・frontmatter・リンク規約は `AGENTS.md` の Content 節に従う。

## 参照リポジトリ

| 役割     | リポジトリ                        | ref                                                                                                                          | ローカル                                           |
| -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 本体     | `aws/aws-advanced-nodejs-wrapper` | `6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095` (main、2026-08-21 "bump version to 3.0.0"。3.0.0 タグは未作成、タグは 2.1.1 まで) | `~/ghq/github.com/aws/aws-advanced-nodejs-wrapper` |
| ドライバ | `sidorares/node-mysql2`           | `d8932925b237f07b6410263770379998df973502` (v3.22.3 の 50 コミット後、package.json は 3.22.5。ラッパの依存は `^3.22.3`)      | `~/ghq/github.com/sidorares/node-mysql2`           |

ソースリンクは `https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/<path>` と `https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/<path>` の形にする。

frontmatter の `oss` は `repo: https://github.com/aws/aws-advanced-nodejs-wrapper`、`language: TypeScript`、`ref: 6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095`。

## 軸

**MySQL 限定で「何が Advanced なのか」を掘る。**

mysql2 は 1 本の TCP 接続の上で MySQL プロトコルを話すだけで、クラスタも writer/reader の役割も、フェイルオーバー後に DNS が古い writer を指し続けることも知らない。mysql2 自身が持つ唯一の「クラスタ対応」は PoolCluster で、それはアプリが列挙した静的ノード一覧と接続取得失敗回数だけで動く。ラッパが足しているのは次の 5 つの「知識」で、群もそれに沿って切る。

1. トポロジを知る (DNS を待たず、DB 自身に SQL で聞く)
2. 障害を早く知る (TCP タイムアウトを待たない)
3. 接続を差し替えても壊れないようにする (セッション状態・トランザクション・遊休接続)
4. AWS の認証を知る (IAM トークン、Secrets Manager)
5. 運用イベントを知る (Blue/Green、カスタムエンドポイント、Global DB)

これらを、全メソッド呼び出しが通る 1 本の plugin chain に差し込める骨格が群 2。MySQL 限定にすることで、各「知識」を **どの system table / system variable を SQL で読んで得ているか** まで具体的に書く。

PoolCluster との比較は、群 1 でベースライン (ドライバ側の上限) を 1 ページ、群 9 の最後に比較表で総括を 1 ページ置き、群 3・4・6 の該当ページから 1 段落ずつ対比する。

## 対象外

- Limitless (PG 専用)
- Configuration Profiles / Presets (MySQL では例外を投げる。概要の対象外リストとつまずきどころで触れるだけ)
- `rds_tools` (PG 専用)
- PG と共通のコアは MySQL のコードパスだけで説明する。`pg/` は読まない

## 構成 (概要 + 75 ページ / 9 群)

`group` の文字列は index.md の 読む順番 の見出しと一致させる。`sidebar.order` は下の番号をそのまま使う。群 2 はアーキテクチャ解説型 (この層の責務 / 主要な型とその関係 / 処理の流れ / 守られている不変条件 / つまずきどころ)、それ以外は学び型 (何を学んだか / ソースコードのどこか / なぜそうなっているか / どう活かすか)。

### 群 1: 前提 — Aurora MySQL と mysql2 (order 1-9)

| order | slug                             | タイトル                                                            | 中身 / 主な参照                                                                                                                                                                              |
| ----- | -------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `aurora-mysql-cluster`           | Aurora MySQL クラスタの構造 — writer/reader と 4 種のエンドポイント | cluster / cluster-ro / instance / custom endpoint と DNS TTL。`docs/using-the-nodejs-wrapper/compatibility/CompatibilityEndpoints.md` のエンドポイント一覧                                   |
| 2     | `what-happens-on-failover`       | フェイルオーバーで何が起きるか                                      | 昇格手順、DNS 伝播の遅れ、全ホストが一瞬落ちる話 (`FailoverConfigurationGuide.md` の Host Availability 節)、2 台クラスタでは意味がない話                                                     |
| 3     | `rds-multi-az-cluster`           | RDS Multi-AZ DB Cluster — Aurora と何が違うか                       | 3 台構成、1 秒切替、`SupportForRDSMultiAzDBCluster.md`、Known Issues (stale topology)                                                                                                        |
| 4     | `aurora-metadata`                | Aurora MySQL の自己申告メタデータ                                   | `information_schema.replica_host_status` / `@@aurora_server_id` / `@@innodb_read_only` / `aurora_version`。`mysql/lib/dialect/aurora_mysql_database_dialect.ts` のクエリ定数を先取りして紹介 |
| 5     | `rds-topology-table`             | `mysql.rds_topology` — Multi-AZ と Blue/Green が共有する表          | `rds_multi_az_mysql_database_dialect.ts` と `rds_mysql_database_dialect.ts` の `BG_STATUS_QUERY`                                                                                             |
| 6     | `mysql2-connection-and-query`    | mysql2 の接続とクエリ                                               | Connection / Pool / PromiseConnection、query と execute、`error` イベント、`connectTimeout` と `timeout`。mysql2 `lib/connection.js`、`lib/pool.js`、`promise.js`                            |
| 7     | `mysql2-pool-cluster`            | mysql2 の PoolCluster — ドライバ側「クラスタ対応」の上限            | mysql2 `lib/pool_cluster.js` (375 行)。下の「PoolCluster の事実」節を全部書く                                                                                                                |
| 8     | `mysql2-auth-plugin-negotiation` | mysql2 の認証プラグイン交渉                                         | `mysql_clear_password` と `enableCleartextPlugin`。mysql2 `lib/auth_plugins/`                                                                                                                |
| 9     | `iam-db-auth`                    | IAM DB 認証の仕組み                                                 | 署名付きトークンをパスワードとして送る、15 分有効、`AWSAuthenticationPlugin` ユーザ                                                                                                          |

### 群 2: 骨格 — 呼び出しを横取りする仕掛け (order 10-21、アーキテクチャ解説型)

| order | slug                                     | タイトル                                                        | 中身 / 主な参照                                                                                                                                                                                                                                    |
| ----- | ---------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | `architecture`                           | アーキテクチャを一枚で読む                                      | AwsMySQLClient → PluginManager → plugin chain → DefaultPlugin → ConnectionProvider → mysql2。`docs/development-guide/Architecture.md`、`common/lib/aws_client.ts`                                                                                  |
| 11    | `aws-mysql-client`                       | AwsMySQLClient — 全メソッドが `pluginManager.execute` を通る    | `mysql/lib/client.ts` (657 行)。`connect()` の役割確認、`query()` の `updateState` + `queryWithTimeout`、`isConnected` の自動接続、`common/lib/mysql_client_wrapper.ts`                                                                            |
| 12    | `plugin-chain`                           | PluginChain — subscribed methods とクロージャの入れ子           | `common/lib/plugin_manager.ts` の `PluginChain.addToHead` と `makeExecutePipeline`、`connection_plugin.ts`、`abstract_connection_plugin.ts`                                                                                                        |
| 13    | `plugin-order`                           | プラグインの並び順 — weight による自動ソートと既定 4 プラグイン | `connection_plugin_chain_builder.ts` の `PLUGIN_FACTORIES` と weight、`WrapperProperties.DEFAULT_PLUGINS = "initialConnection,auroraConnectionTracker,failover2,efm2"`、`autoSortWrapperPluginOrder`                                               |
| 14    | `pipelines`                              | 9 本のパイプライン                                              | `docs/development-guide/Pipelines.md`。connect / forceConnect / execute / initHostProvider / notifyConnectionChanged / notifyHostListChanged / acceptsStrategy / getHostInfoByStrategy / releaseResources                                          |
| 15    | `plugin-service`                         | PluginService — プラグインが共有する唯一の状態置き場            | `common/lib/plugin_service.ts` (822 行)、`partial_plugin_service.ts`。`LoadablePlugins.md` の「ローカルコピー禁止」の理由                                                                                                                          |
| 16    | `default-plugin-and-connection-provider` | DefaultPlugin と ConnectionProvider                             | `plugins/default_plugin.ts`、`driver_connection_provider.ts`、`connection_provider_manager.ts`、forceConnect パイプラインの意味                                                                                                                    |
| 17    | `two-dialects`                           | 2 種類の Dialect — DriverDialect と DatabaseDialect             | `mysql/lib/dialect/mysql2_driver_dialect.ts` (mysql2 の癖: keepAlive 非対応、`timeout` はクエリ単位)、MySQL 系 DatabaseDialect 5 種の継承関係                                                                                                      |
| 18    | `dialect-resolution`                     | Dialect の自動判定                                              | `database_dialect/database_dialect_manager.ts`。URL からの推測 → `getDialectUpdateCandidates` → `isDialect` クエリ (`version_comment` / `aurora_version` / `rds_topology` + `report_host` / `aurora_global_db_status` 地域数 > 1) → 確認済みフラグ |
| 19    | `mysql-error-handler`                    | MySQLErrorHandler — 文字列一致で分類する                        | `mysql/lib/mysql_error_handler.ts`、`common/lib/error_handler.ts`。`execute` 前後で noOp / tracking リスナを付け替える理由 (`plugin_manager.ts` の `execute`)                                                                                      |
| 20    | `wrapper-properties`                     | WrapperProperties — mysql2 に渡す前に剥がす                     | `common/lib/wrapper_property.ts` (850 行)。`removeWrapperProperties`、`monitoring_` / `topology_monitoring_` / `frt_` / `blue_green_monitoring_` 接頭辞                                                                                            |
| 21    | `core-services-container`                | CoreServicesContainer — プロセス全体で共有される 3 サービス     | `utils/core_services_container.ts`、`full_services_container.ts`、`service_utils.ts`。StorageService / MonitorService / EventPublisher がシングルトンである意味                                                                                    |

### 群 3: トポロジを知る (order 22-32)

| order | slug                              | タイトル                                                 | 中身 / 主な参照                                                                                                                                                                                                                                                                    |
| ----- | --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22    | `host-info`                       | HostInfo と HostRole と可用性                            | `common/lib/host_info.ts`、`host_info_builder.ts`、`host_role.ts`、`host_availability/`                                                                                                                                                                                            |
| 23    | `rds-utils`                       | RdsUtils — エンドポイント文字列を正規表現で分類する      | `utils/rds_utils.ts` (576 行)。`identifyRdsType` の判定順、China / Gov / FIPS パターン、`RdsUrlType`                                                                                                                                                                               |
| 24    | `cluster-instance-host-pattern`   | clusterInstanceHostPattern — `?` テンプレート            | `RdsUtils.getRdsInstanceHostPattern`、`RdsHostListProvider.validateHostPatternSetting`、IP / カスタムドメイン時に必須な理由                                                                                                                                                        |
| 25    | `host-list-providers`             | HostListProvider 2 種 — 接続文字列 vs RDS トポロジ       | `host_list_provider/connection_string_host_list_provider.ts`、`rds_host_list_provider.ts`。**PoolCluster 対比:** 接続文字列版は PoolCluster と同じ静的リスト、違いは RDS 版から                                                                                                    |
| 26    | `topology-query-aurora`           | トポロジクエリ (Aurora MySQL)                            | `aurora_mysql_database_dialect.ts` の `TOPOLOGY_QUERY`。weight = lag×100 + cpu、5 分更新なしの行は除外、`aurora_topology_utils.ts`                                                                                                                                                 |
| 27    | `topology-query-multi-az`         | トポロジクエリ (Multi-AZ MySQL)                          | `rds_multi_az_mysql_database_dialect.ts`。`rds_topology` に writer 情報がないので `SHOW REPLICA STATUS` の `Source_Server_Id` で割り出す                                                                                                                                           |
| 28    | `identify-connection`             | identifyConnection — この接続はどのインスタンスか        | `utils/host_id_cache_service.ts`、`@@aurora_server_id`、環境変数 `AWS_NODEJS_HOST_CACHE_ENABLED`                                                                                                                                                                                   |
| 29    | `cluster-topology-monitor`        | ClusterTopologyMonitor — 低速・パニック・高速の 3 モード | `host_list_provider/monitoring/cluster_topology_monitor.ts` (1,038 行) の `monitor()`、`clusterTopologyRefreshRateMs` (30s) / `clusterTopologyHighRefreshRateMs` (100ms)、`STABLE_TOPOLOGIES_DURATION` 15s、`monitoring_connection_handler.ts`                                     |
| 30    | `am-i-a-writer`                   | 「自分は writer か」を全ホストに聞く                     | 同ファイルの `HostMonitor.run`、`IS_WRITER_QUERY`、harvested connections、reader のトポロジは古いことがある (`UsingTheFailover2Plugin.md` Picture 3)                                                                                                                               |
| 31    | `cluster-id`                      | clusterId — キャッシュとモニタの共有単位                 | `ClusterId.md`、CHANGELOG 3.0.0 で自動導出を捨てた理由、既定 `"1"` の衝突                                                                                                                                                                                                          |
| 32    | `host-availability-and-selection` | ホスト可用性戦略と選択戦略                               | `exponential_backoff_host_availability_strategy.ts`、`random_host_selector.ts` / `round_robin_host_selector.ts` / `least_connections_host_selector.ts` / `plugins/strategy/fastest_response/`。**PoolCluster 対比:** RR は単純巡回、roundRobin は重み付き + クラスタ単位キャッシュ |

### 群 4: フェイルオーバー (order 33-45)

| order | slug                             | タイトル                                                   | 中身 / 主な参照                                                                                                                                                                                                     |
| ----- | -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 33    | `failover-overview`              | 全体像 — 例外を捕まえ、接続を差し替え、例外を投げ直す      | `plugins/failover2/failover2_plugin.ts` の `execute`、`hasNetworkError` 先読み、`canDirectExecute` (end だけ素通し)                                                                                                 |
| 34    | `failover-triggers`              | 何をトリガとするか                                         | `shouldErrorTriggerClientSwitch`、`MySQLErrorHandler.isNetworkError` の文字列群、read-only エラー errno 1290/1836 は strict-writer のみ (3.0.0)。**PoolCluster 対比:** 接続取得失敗しか見ない vs 実行時エラーを見る |
| 35    | `failover-mode`                  | failoverMode と URL からの既定値                           | `failover/failover_mode.ts`、`initFailoverMode`、cluster-ro なら reader-or-writer                                                                                                                                   |
| 36    | `failover2-writer`               | failover2 の writer フェイルオーバー — モニタに任せて待つ  | `failoverWriter` → `forceMonitoringRefresh(true, timeout)` → 役割検証 → `setCurrentClient`                                                                                                                          |
| 37    | `failover2-reader`               | failover2 の reader フェイルオーバー                       | `failoverReader`、`failoverReaderHostSelectorStrategy`、strict-reader 時の単一インスタンス例外                                                                                                                      |
| 38    | `failover-success-error`         | FailoverSuccessError — 成功なのに例外を投げる契約          | `throwFailoverSuccessException`、`UsingTheFailoverPlugin.md` の Warning 1 (Client を捨てると新接続も捨てる)、`examples/aws_driver_example/aws_failover_mysql_example.ts`                                            |
| 39    | `transaction-resolution-unknown` | TransactionResolutionUnknownError                          | `_isInTransaction` と `pluginService.isInTransaction()`、rollback 試行                                                                                                                                              |
| 40    | `failover-v1`                    | failover (v1) — Task A / Task B と 2 並列 reader 接続試行  | `failover/failover_plugin.ts`、`writer_failover_handler.ts` (Task A = 旧 writer 再接続、Task B = reader 経由で新 writer 待ち)、`reader_failover_handler.ts` (2 本ずつバッチ、1 秒 sleep)                            |
| 41    | `failover-restriction-multi-az`  | Multi-AZ 向け FailoverRestriction                          | `failover/failover_restriction.ts`、`DISABLE_TASK_A` / `ENABLE_WRITER_IN_TASK_B`、Multi-AZ では v1 だけ動作確認済みという docs の記述                                                                               |
| 42    | `stale-dns`                      | StaleDns — クラスタエンドポイントが古い writer を指すとき  | `plugins/stale_dns/stale_dns_helper.ts` の `getVerifiedConnection`、失敗時にインスタンスエンドポイントへ張り直す                                                                                                    |
| 43    | `initial-connection-strategy`    | initialConnection プラグイン                               | `plugins/aurora_initial_connection_strategy_plugin.ts`、`getVerifiedWriterClient` / `getVerifiedReaderClient`、`openConnectionRetryTimeoutMs`                                                                       |
| 44    | `connection-tracker`             | auroraConnectionTracker — 遊休接続を writer 交代時に切る   | `plugins/connection_tracker/`、`OpenedConnectionTracker.openedConnections` (static Map)、`TOPOLOGY_CHANGES_EXPECTED_TIME_NS` 3 分                                                                                   |
| 45    | `failover-timing`                | 時間設計 — タイムアウト群と normal/aggressive プロファイル | `FailoverConfigurationGuide.md`、`failoverTimeoutMs` 300s 既定、攻めすぎると全ホスト一時停止に引っかかる                                                                                                            |

### 群 5: 障害を早く知る — EFM (order 46-50)

| order | slug                       | タイトル                                                 | 中身 / 主な参照                                                                                                                                                                             |
| ----- | -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 46    | `why-efm`                  | なぜ EFM が要るか                                        | 実行中クエリは TCP タイムアウトまで固まる、RDS Proxy と相性が悪い理由 (`UsingTheHostMonitoringPlugin.md`)                                                                                   |
| 47    | `failure-detection-params` | failureDetectionTime / Interval / Count — 監視の状態機械 | `plugins/efm/base/connection_context.ts`、`updateConnectionStatus`、既定 30s / 5s / 3 回                                                                                                    |
| 48    | `host-monitor`             | HostMonitor — `SELECT 1` と forceConnect で生死判定      | `efm/base/host_monitor.ts` の `checkConnectionStatus` (`isClientValid` → MySQL は `SELECT 1` + `queryWithTimeout`)、`monitoring_` 接頭辞、`abortConnection` → mysql2 `destroy()`、`WeakRef` |
| 49    | `efm-v1-vs-v2`             | efm と efm2 の違い — 2 タスク分離                        | `efm/v1/host_monitoring_connection_plugin.ts`、`efm/v2/host_monitoring2_connection_plugin.ts`、`waitForUnhealthy`                                                                           |
| 50    | `monitor-service`          | MonitorService — 監視タスクの生成・共有・破棄            | `utils/monitoring/monitor_service.ts` (450 行)、`monitor.ts` の `AbstractMonitor`、`runIfAbsent`、cleanup loop、`MonitorErrorResponse`                                                      |

### 群 6: 接続を差し替えても壊れないようにする (order 51-58)

| order | slug                       | タイトル                                                | 中身 / 主な参照                                                                                                                                                                                                                                                                               |
| ----- | -------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 51    | `session-state`            | SessionState — 5 つの設定と pristine 値                 | `common/lib/session_state.ts`、`session_state_service_impl.ts`、`SessionState.md`。MySQL は schema 非対応                                                                                                                                                                                     |
| 52    | `tracking-state-from-sql`  | SQL を読んで状態を追う                                  | `plugin_service.ts` の `updateState`、`utils/sql_method_utils.ts`、`mysql_database_dialect.ts` の `doesStatementSet*`、`client.format` でパラメータ展開してから読む                                                                                                                           |
| 53    | `transaction-boundary`     | トランザクション境界の追跡                              | `SqlMethodUtils.doesOpenTransaction` / `doesCloseTransaction`、`updateInTransaction` (beginTransaction / commit / rollback)                                                                                                                                                                   |
| 54    | `transfer-and-reset`       | 差し替え時の転送と close 時のリセット                   | `applyCurrentSessionState` / `applyPristineSessionState`、`transferSessionStateOnSwitch` / `resetSessionStateOnClose`、`session_state_transfer_handler.ts`                                                                                                                                    |
| 55    | `read-write-splitting`     | readWriteSplitting — setReadOnly の SQL を横取りする    | `plugins/read_write_splitting/abstract_read_write_splitting_plugin.ts` の `execute` (`doesSetReadOnly` で切替)、`switchClientIfRequired`、`closeIdleClients`、`cachedReaderKeepAliveTimeout`                                                                                                  |
| 56    | `internal-connection-pool` | 内部コネクションプール — インスタンスごとの mysql2 Pool | `internal_pooled_connection_provider.ts`、`utils/pool_key.ts`、`mysql/lib/icp/mysql_internal_pool_client.ts` (mysql2 Pool の `_freeConnections` / `_allConnections` を直接読む)、`leastConnections`。**PoolCluster 対比:** アプリ宣言のプール集合 vs 発見したインスタンスごとに作るプール集合 |
| 57    | `aws-mysql-pool-client`    | AwsMySQLPoolClient — 外部プールの正体                   | `mysql/lib/client.ts` の `AwsMySQLPoolClient` / `AwsMySQLPooledConnection`。`getConnection()` も `query()` も毎回 plugin chain 一式を作る、`query()` は FailoverSuccessError のときだけ `end()` しない、`UsingTheConnectionPool.md` の mysql2 パラメータ対応表                                |
| 58    | `connection-lifetime`      | 接続の寿命管理                                          | `utils/sliding_expiration_cache.ts`、`sliding_expiration_cache_with_cleanup_task.ts`、`PluginManager.releaseResources()`、`provider.releaseResources()` の呼び順                                                                                                                              |

### 群 7: AWS の認証 (order 59-62)

| order | slug                     | タイトル                                                 | 中身 / 主な参照                                                                                                                                                                |
| ----- | ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 59    | `iam-plugin`             | IAM 認証プラグイン                                       | `authentication/iam_authentication_plugin.ts`、`utils/iam_auth_utils.ts`、`tokenCache`、期限切れトークンでログイン失敗したら再生成、`iamHost` / `iamRegion`、`region_utils.ts` |
| 60    | `iam-cleartext-on-mysql` | MySQL で IAM を使うと cleartext になる                   | `MySQL2DriverDialect.setCleartextPluginForTokenAuth`、`ssl` 設定時だけ `enableCleartextPlugin` を立てる (CHANGELOG 3.0.0 Fixed)                                                |
| 61    | `secrets-manager-plugin` | Secrets Manager プラグイン                               | `authentication/aws_secrets_manager_plugin.ts`、`secretsCache`、ARN から region を取る、ローテーション後のログイン失敗で `updateSecret(true)`                                  |
| 62    | `federated-and-okta`     | federatedAuth / okta — SAML から IAM トークンまで (概要) | `plugins/federated_auth/`、`aws_credentials_manager.ts`、`customAwsCredentialProviderHandler`。1 ページで流れだけ                                                              |

### 群 8: 運用イベントを知る (order 63-70)

| order | slug                         | タイトル                                                  | 中身 / 主な参照                                                                                                                                                                                                   |
| ----- | ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 63    | `blue-green-switchover`      | Blue/Green 切り替えで何が起きるか                         | `UsingTheBlueGreenPlugin.md`、フェーズ (NOT_CREATED → CREATED → PREPARATION → IN_PROGRESS → POST → COMPLETED)、`bluegreen/blue_green_phase.ts`                                                                    |
| 64    | `blue-green-status-monitor`  | BlueGreenStatusMonitor — blue と green を別接続で監視する | `bluegreen/blue_green_status_monitor.ts` (524 行)、IP アドレス収集、`panicMode`、interval 3 段階                                                                                                                  |
| 65    | `blue-green-status-provider` | BlueGreenStatusProvider — フェーズ遷移と routing          | `bluegreen/blue_green_status_provider.ts` (923 行)、`bluegreen/routing/` (suspend / substitute IP / reject / pass-through)、DNS フラグ、切替サマリログ                                                            |
| 66    | `blue-green-mysql-metadata`  | Blue/Green の MySQL 側メタデータ                          | `rds_topology` の version / endpoint / port / role / status、`BlueGreenResult`、Aurora MySQL 3.07 以上                                                                                                            |
| 67    | `custom-endpoint`            | customEndpoint プラグイン                                 | `plugins/custom_endpoint/`、RDS API `DescribeDBClusterEndpoints`、`AllowedAndBlockedHosts` を PluginService に流す、`waitForCustomEndpointInfo`                                                                   |
| 68    | `global-database`            | Aurora Global Database — 地域をまたぐトポロジ             | `mysql/lib/dialect/global_aurora_mysql_database_dialect.ts` (`aurora_global_db_instance_status`)、`global_aurora_host_list_provider.ts`、`global_aurora_topology_monitor.ts`、`globalClusterInstanceHostPatterns` |
| 69    | `gdb-failover`               | gdbFailover — home region と in-home / out-of-home        | `plugins/global_db_failover/`、`GlobalDbFailoverMode` 7 種、`gdbAccessibleRegions`、`gdbMonitoringConnectionPriority`                                                                                             |
| 70    | `compatibility-matrix`       | 互換性表を読む                                            | `docs/using-the-nodejs-wrapper/compatibility/` 3 表。failover 系は排他、認証系は排他、bg は Multi-AZ / Global 不可                                                                                                |

### 群 9: 横断 (order 71-75)

| order | slug                           | タイトル                                    | 中身 / 主な参照                                                                                                                                   |
| ----- | ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 71    | `telemetry`                    | Telemetry — OpenTelemetry / X-Ray           | `utils/telemetry/`、`TelemetryTraceLevel` (TOP_LEVEL / NESTED / FORCE_TOP_LEVEL)、3.0.0 で optional peerDependencies になった                     |
| 72    | `developer-plugin`             | Developer プラグイン — エラー注入           | `plugins/dev/`、`ErrorSimulatorManager.raiseErrorOnNextConnect`、`raiseErrorOnNextCall`                                                           |
| 73    | `background-tasks-and-process` | バックグラウンドタスクと Node.js プロセス   | モニタ・キャッシュ掃除ループが生きている限りプロセスが終わらない、`PluginManager.releaseResources()` → `CoreServicesContainer.releaseResources()` |
| 74    | `integration-tests`            | 統合テストの作り方                          | `tests/integration/container/tests/`、toxiproxy でネットワーク断を再現 (`utils/proxy_helper.ts`)、`failover/`、`test_environment.ts`              |
| 75    | `vs-pool-cluster`              | PoolCluster と何が違うのか — 比較表で答える | 章の総括。下の比較表をそのまま使い、各行から該当ページへリンク                                                                                    |

## PoolCluster の事実 (mysql2 `lib/pool_cluster.js`、375 行)

ページ 7 と 75 で使う。

- ノードはアプリが `add(id, config)` で静的登録。`id` 省略時は `CLUSTER::N`。`MASTER` / `SLAVE1` はただの名前で、役割は誰も検証しない
- `of(pattern, selector)` でパターン (`*` ワイルドカード → RegExp) と selector を組み合わせた namespace を作りキャッシュ
- selector は RR / RANDOM / ORDER の 3 つ (`makeSelector`、合計 10 行)
- ヘルスは `_getConnection` (接続取得) の失敗回数だけ。`removeNodeErrorCount` 既定 5 に達すると `_removeNode` で恒久削除 + `pool.end()`。`restoreNodeTimeout` (既定 0) を設定した時だけ `_offlineUntil` で一時オフライン。成功で errorCount を 1 減らす
- クエリ実行中のエラーは数えない。接続はできるが昇格済みで read-only になった旧 writer は永久に `MASTER` のまま
- `canRetry` 既定 true: 接続取得失敗時に同じパターンの別ノードで再取得
- エラーコード `POOL_NOEXIST` / `POOL_NONEONLINE`
- `connection._clusterId = node.id` を付けるだけで、接続そのものには何も足さない
- DNS・セッション状態・フェイルオーバー後の役割変化・認証は一切扱わない
- Promise 版は `promise.js` の `PromisePoolCluster`

### 比較表 (ページ 75)

| 観点                 | PoolCluster            | ラッパ                                                              |
| -------------------- | ---------------------- | ------------------------------------------------------------------- |
| トポロジの出所       | アプリが列挙           | DB に SQL で聞く (`replica_host_status` / `rds_topology`)           |
| 役割 (writer/reader) | 名前で自称             | `@@innodb_read_only` で検証、変化に追従                             |
| 不健全の判定         | 接続取得失敗 5 回      | EFM のプローブ + 実行時エラー分類 + read-only エラー                |
| 落ちたノードの扱い   | 削除 (既定は恒久)      | `NOT_AVAILABLE` + exponentialBackoff で復帰                         |
| 昇格後の書き込み先   | 旧 MASTER に送り続ける | 新 writer へ接続を差し替え、`FailoverSuccessError` で通知           |
| DNS の古さ           | 無関係                 | StaleDns / initialConnection で検証                                 |
| セッション状態       | なし                   | pristine 値の追跡と転送                                             |
| 選択戦略             | RR / RANDOM / ORDER    | random / roundRobin (重み付き) / leastConnections / fastestResponse |
| プールの単位         | アプリ登録ノードごと   | トポロジで発見したインスタンスごとに自動生成                        |
| 認証                 | 固定パスワード         | IAM トークン / Secrets Manager                                      |

## 確認済みの要点 (docs に書かれにくいもの)

- MySQL 系 DatabaseDialect は 5 つ: `mysql` / `rds-mysql` / `aurora-mysql` / `global-aurora-mysql` / `rds-multi-az-mysql`。`RdsMySQLDatabaseDialect.isDialect` は `version_comment` が "Source distribution" のとき true、community は "MySQL Community Server"
- Aurora MySQL の `TOPOLOGY_QUERY` は `time_to_sec(timediff(now(), LAST_UPDATE_TIMESTAMP)) <= 300 OR SESSION_ID = 'MASTER_SESSION_ID'` で古い行を落とす
- `MySQLErrorHandler.isNetworkError` の一致文字列: "Connection lost: The server closed the connection." / "Query inactivity timeout" / "Can't add new command when connection is in closed state" / ラッパ自身の queryTaskTimeout メッセージ / "connect ETIMEDOUT" / "connect ECONNREFUSED"。login は sqlState 28000、syntax は code 42000 / 42S02
- `ClientUtils.queryWithTimeout` は `Promise.race` で自前タイムアウトを掛け、mysql2 のエラーを `AwsWrapperError` に包む。`mysqlQueryTimeout` は 1.1.0 で非推奨、`wrapperQueryTimeout` 既定 20000
- `PluginManager.execute` は実行前に noOp リスナ、finally で tracking リスナに付け替える。`Failover2Plugin.execute` は冒頭で `hasNetworkError()` を見て、遊休中に emit されたエラーを先に投げる
- failover2 の subscribed methods は `initHostProvider` / `connect` / `query` の 3 つだけ。`end` は `canDirectExecute` で素通し
- Reader failover (v1) は 2 ホストずつバッチで接続試行し、バッチ間に 1 秒 sleep
- EFM の `checkConnectionStatus` は監視用接続の `isClientValid` (MySQL は `SELECT 1`) が通れば OK、通らなければ `forceConnect` で張り直し、それも失敗で invalid
- `AwsMySQLPoolClient` は `InternalPooledConnectionProvider` の上に、`getConnection()` / `query()` のたびに新しい `AwsMySQLPooledConnection` (= PluginManager + PluginService 一式) を作る
- `AwsMySQLClient.query()` は未接続なら自動で `connect()` する (mysql2 では connect 不要のため)
- `MySQL2DriverDialect.setKeepAliveProperties` は keepAlive 指定を例外にする (mysql2 非対応)
- README の Known Limitations は「Global Database の failover 未対応」のままだが、CHANGELOG 3.0.0 で対応済み。README が古い
- Configuration Profiles は MySQL で使うと例外 (`UsingTheNodejsWrapper.md` の Warning)

## つまずきどころ候補 (該当ページに散らす)

- エラー判定がメッセージ文字列一致 (mysql2 側の文言変更で壊れる)
- `pool.query()` はクエリごとに plugin chain 一式を作って捨てる
- `clusterId` の既定 `"1"` で複数クラスタが衝突する (3.0.0 破壊的変更)
- 2 台クラスタでは failover が役割交換にしかならない
- RDS Proxy + EFM は監視対象が特定できない
- callback API 非対応、`reconnect` オプション非対応 (failover が代替)
- `query()` の戻りが `[rows, fields]` のタプル
- monitoring 系接続にタイムアウトを入れないと永久待ち (`monitoring_wrapperQueryTimeout` 等)

## 未決事項

1. 群 1 の前提 9 ページの厚さ。Aurora 運用経験者なら 4・5・7・8・9 だけで先へ進める構成にする想定。削るなら 1・2 を 1 ページに畳む
2. 群 4 の failover v1 (40・41) に 2 ページ割くか。Multi-AZ MySQL では v1 の `failover` だけ動作確認済みと docs にあるので残す想定。Aurora だけ想定なら 1 ページに圧縮
3. 群 8 の Global DB (68・69) と群 9 の 74 は削減候補

## 作業手順の目安

1. `src/content/docs/oss/sample/` を複製して `index.md` を書く (対象外・読む順番・「この OSS について」の箇条書き)
2. 群 2 (骨格) を先に書く。他の群のページが `pluginManager.execute` / PluginService / Dialect を前提にするため
3. 群 3 → 4 → 5 → 6 の順。群 1 は群 3・4 を書いた後に「必要だった前提」だけを残す形で書くと薄くならない
4. 群 7 → 8 → 9。75 は最後
5. mermaid は 29 (3 モード遷移: stateDiagram-v2)、33 (execute の流れ: sequenceDiagram)、36 (writer failover: sequenceDiagram)、47 (状態機械)、55 (切替)、63 (フェーズ遷移) に入れる
