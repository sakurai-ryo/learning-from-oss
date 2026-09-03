---
title: "互換性表を読む"
description: "docs の 3 つの互換性表 (プラグイン同士、DB 種別、エンドポイント種別) は、コードのどこが前提を置いているかの索引になっている。failover 系 3 つと認証系 4 つはそれぞれ排他、bg は Multi-AZ DB Cluster と Global で不可、customEndpoint はカスタムエンドポイント以外の URL で不可。MySQL 限定で ✗ だけを抜き出し、理由を該当ページに繋ぐ。"
group: "運用イベントを知る"
sidebar:
  order: 70
---

## 何を学んだか

`docs/using-the-nodejs-wrapper/compatibility/` の 3 表 ([`CompatibilityCrossPlugins.md`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/docs/using-the-nodejs-wrapper/compatibility/CompatibilityCrossPlugins.md)、[`CompatibilityDatabaseTypes.md`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/docs/using-the-nodejs-wrapper/compatibility/CompatibilityDatabaseTypes.md)、[`CompatibilityEndpoints.md`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/docs/using-the-nodejs-wrapper/compatibility/CompatibilityEndpoints.md)) は、プラグインが**何を前提にしているか**の一覧である。✗ の理由は、ほぼ全部この章のどこかのページにコードとして出てくる。

- **同じ役目のプラグインは排他。** failover 系 3 つ、認証系 4 つ、読み書き分離 2 つ、EFM 2 つ
- **クラスタでないと動かないものが多い。** 2 台の Multi-AZ instance、Single-AZ、community MySQL では failover / staleDns / readWriteSplitting / auroraConnectionTracker / initialConnection / fastestResponseStrategy が ✗
- **DNS 名の形に依存するものは IP と CNAME で ✗。** efm / efm2 / staleDns / initialConnection / customEndpoint / bg
- **RDS Proxy は監視系と相性が悪い。** efm / efm2 / staleDns / readWriteSplitting / initialConnection が ✗

ラッパは組み合わせを検証しない。✗ の組み合わせを書いても起動時に例外にはならず、実行時に噛み合わない動きをする。

## ソースコードのどこか

表そのものは docs で、コードはない。以下は 3 表から ✗ を抜き出し、MySQL に関係ない列 (Limitless、`rds_tools`) を落として整理し直したものである。✓ の細かい注記 (黄色の ✓) は docs を参照。

### プラグイン同士

| 組み合わせ                                          | 理由                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `efm` × `efm2`                                      | 同じ監視を二重に立てる ([efm と efm2 の違い](../efm-v1-vs-v2/))                                                                                                                                                                                 |
| `failover` × `failover2` × `gdbFailover`            | 3 つとも `query` を購読してフェイルオーバーを走らせる。同時に入れると二重に動く ([全体像](../failover-overview/)、[gdbFailover](../gdb-failover/))                                                                                              |
| `iam` × `secretsManager` × `federatedAuth` × `okta` | 4 つとも `connect` で `password` を書き換える。後勝ちになり、意図した認証にならない ([IAM 認証プラグイン](../iam-plugin/)、[Secrets Manager](../secrets-manager-plugin/)、[federatedAuth / okta](../federated-and-okta/))                       |
| `readWriteSplitting` × `gdbReadWriteSplitting`      | 同じ `setReadOnly` の横取りを二重にする ([readWriteSplitting](../read-write-splitting/))                                                                                                                                                        |
| `staleDns` × `initialConnection`                    | どちらも初回接続で writer を検証して張り直す。`initialConnection` が既定で入っているので、`staleDns` を足すと衝突する ([StaleDns](../stale-dns/)、[initialConnection](../initial-connection-strategy/))                                         |
| `staleDns` × `gdbReadWriteSplitting`                | docs に理由の記載はない。`gdbReadWriteSplitting` も接続の張り直しを行うので、上と同じ衝突と考えられる                                                                                                                                           |
| `connectTime` × `initialConnection`                 | docs に理由の記載はない。`connectTime` は前のプラグインの相対 weight (`-1`) で並ぶので ([プラグインの並び順](../plugin-order/))、`initialConnection` (390) の直後に置くと張り直し込みの時間を計測することになる、というのが考えられる理由である |

`dev` と `executeTime` は全てと互換で、表にも載っていない。

### DB 種別

列は Aurora Global Database / Aurora Cluster / RDS Multi-AZ DB Cluster (3 台) / RDS Multi-AZ DB Instance (2 台) / RDS Single-AZ / community の 6 つ。

| プラグイン                                                                                                      | ✗                                                          | 理由                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failover` / `failover2` / `gdbFailover`                                                                        | 2 台 Multi-AZ instance、Single-AZ、community               | トポロジ表がない。`replica_host_status` も `rds_topology` もない構成では役割を検証できない ([HostListProvider 2 種](../host-list-providers/))                                                                                                                                                                                                                                            |
| `staleDns` / `initialConnection` / `readWriteSplitting` / `auroraConnectionTracker` / `fastestResponseStrategy` | 同上                                                       | いずれもトポロジ前提。2 台の Multi-AZ instance はスタンバイに繋げないので「クラスタ」として扱えない ([RDS Multi-AZ DB Cluster](../rds-multi-az-cluster/))                                                                                                                                                                                                                                |
| `iam` / `secretsManager` / `federatedAuth` / `okta`                                                             | community                                                  | IAM DB 認証は RDS の機能 ([IAM DB 認証の仕組み](../iam-db-auth/))                                                                                                                                                                                                                                                                                                                        |
| `customEndpoint`                                                                                                | 2 台 Multi-AZ instance、Single-AZ、community               | カスタムエンドポイントは Aurora の機能 ([customEndpoint](../custom-endpoint/))                                                                                                                                                                                                                                                                                                           |
| `bg`                                                                                                            | Aurora Global Database、RDS Multi-AZ DB Cluster、community | `rds_topology` の BG 行を読むので、表のない community は動かない。Global と Multi-AZ DB Cluster は docs が非対応と明記するだけで理由は書かれていない。コード上は、監視の代表行判定が `cluster-` エンドポイント前提であること、Multi-AZ DB Cluster では同じ表にトポロジ行が混ざることが、それぞれ噛み合わない点になる ([Blue/Green の MySQL 側メタデータ](../blue-green-mysql-metadata/)) |

`efm` / `efm2` はどの DB 種別でも ✓ である。`SELECT 1` しか打たないので、トポロジがなくても動く ([HostMonitor](../host-monitor/))。

### エンドポイント種別

列は Global DB エンドポイント / Aurora cluster writer / cluster reader / custom / instance / Multi-AZ cluster writer / Multi-AZ cluster reader / RDS Proxy / IP / CNAME の 10 (Limitless の shard group を除く)。

| プラグイン           | ✗                                                                           | 理由                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `efm` / `efm2`       | RDS Proxy、IP、CNAME                                                        | 監視対象のインスタンスを特定できない。Proxy の裏は見えず、IP / CNAME はトポロジのホスト名と一致しない ([なぜ EFM が要るか](../why-efm/)) |
| `staleDns`           | cluster reader、custom、instance、Multi-AZ cluster reader、Proxy、IP、CNAME | writer クラスタエンドポイントの DNS が古いかを検証するプラグインなので、それ以外の URL では意味がない ([StaleDns](../stale-dns/))        |
| `initialConnection`  | custom、instance、Proxy、IP、CNAME                                          | クラスタエンドポイント (writer / reader) の検証が仕事 ([initialConnection](../initial-connection-strategy/))                             |
| `customEndpoint`     | custom 以外の全部                                                           | DNS が `cluster-custom-` でなければ素通しになる。docs は「素通し」を ✗ と表記している ([customEndpoint](../custom-endpoint/))            |
| `readWriteSplitting` | RDS Proxy                                                                   | Proxy の裏で reader を選べない                                                                                                           |
| `bg`                 | Global DB エンドポイント、Multi-AZ cluster writer / reader、CNAME           | DB 種別と同じ理由 + CNAME は `-green-` / `-old1` の接尾辞判定ができない ([Blue/Green 切り替えで何が起きるか](../blue-green-switchover/)) |

`failover` / `failover2` / `gdbFailover` / `auroraConnectionTracker` / `fastestResponseStrategy` は Limitless 以外の全エンドポイントで ✓ である。IP や CNAME でも `clusterInstanceHostPattern` を書けば動く ([clusterInstanceHostPattern](../cluster-instance-host-pattern/))。

## なぜそうなっているか

### なぜ検証しないのか

[`ConnectionPluginChainBuilder`](../plugin-order/) は `plugins` の文字列を weight で並べ替えるだけで、組み合わせの妥当性は見ない。✗ の多くは「動かない」ではなく「期待と違う動きをする」であり、機械的に弾ける条件ではない。たとえば `efm2` + IP は起動もするし監視もするが、監視対象がトポロジのホストと結び付かないだけである。

もう 1 つは、[Configuration Profiles](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/docs/using-the-nodejs-wrapper/UsingTheNodejsWrapper.md) が MySQL では使えないことである。PG では preset で整合した組み合わせを選べるが、MySQL では `plugins` を手で書くしかない。

### なぜ「排他」が 3 群あるのか

failover 系、認証系、読み書き分離の 3 群は、それぞれ**同じメソッドを購読して同じ状態を書き換える**。failover 系は `query` の例外を捕まえて `setCurrentClient` を呼び、認証系は `connect` で `password` を差し替え、読み書き分離は `setReadOnly` 相当の SQL を横取りする。plugin chain は 1 本なので、同じ役目のプラグインが 2 つあると、先に動いたほうの結果を後のほうが上書きする ([PluginChain](../plugin-chain/))。

### なぜ EFM だけ DB 種別を選ばないのか

EFM は `SELECT 1` を打って応答があるかを見るだけで、トポロジも役割も使わない。逆にエンドポイントには依存する。監視接続を「今の接続と同じホスト」に張るので、ホスト名がインスタンスを一意に指していない (Proxy、IP、CNAME) と、監視しているものと使っているものがずれる。

## どう活かすか

- **`plugins` を書いたら、この 3 表を上から順に見る。** 既定の `initialConnection,auroraConnectionTracker,failover2,efm2` に足すときに衝突しやすいのは `staleDns` (initialConnection と排他) と `failover` (failover2 と排他)
- **MySQL で使える組み合わせの実例。**

  | 目的                              | `plugins`                                                                                                  |
  | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
  | Aurora、writer 追従               | 既定のまま                                                                                                 |
  | Aurora、IAM                       | `initialConnection,auroraConnectionTracker,failover2,efm2,iam`                                             |
  | Aurora、読み書き分離 + 内部プール | `initialConnection,auroraConnectionTracker,readWriteSplitting,failover2,efm2`                              |
  | Multi-AZ DB Cluster               | `failover,efm2` (docs が動作確認しているのは v1、[FailoverRestriction](../failover-restriction-multi-az/)) |
  | Blue/Green 切り替え前後           | 既定 + `bg`                                                                                                |
  | Global Database                   | `initialConnection,gdbFailover,efm2` + `dialect: "global-aurora-mysql"`                                    |
  | カスタムエンドポイント            | `customEndpoint` + 既定 + `failoverMode` をエンドポイント種別に合わせる                                    |

- **✗ を「起動できない」と読まない。** 起動して、静かに期待と違う動きをする。テストで確かめるなら [統合テスト](../integration-tests/)のように toxiproxy で切断を再現して、フェイルオーバー先がどこになるかを見る

### つまずきどころ

- **表は 3 つあって、全部見ないと足りない。** プラグイン同士は ✓ でも、DB 種別やエンドポイントで ✗ のことがある (`bg` + `failover2` は ✓ だが、`bg` は Multi-AZ DB Cluster で ✗)
- **`staleDns` は既定構成と衝突する。** 3.0.0 以前の設定例に `staleDns` が残っていることがある。今は `initialConnection` が既定で同じ役目をしている
- **`connectTime` / `executeTime` の位置。** どちらも相対 weight なので `plugins` に書いた位置の直後に入る。`initialConnection` の直後に `connectTime` を置くと ✗ になる
- **Configuration Profiles は MySQL で例外。** `profileName` を書くと動かないので、preset で整合を取る道はない
