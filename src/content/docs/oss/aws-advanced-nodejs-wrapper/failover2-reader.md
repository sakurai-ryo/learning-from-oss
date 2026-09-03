---
title: "failover2 の reader フェイルオーバー"
description: "failoverReader は writer 側と違ってモニタを待たない。forceMonitoringRefresh(false, 0) は今あるトポロジを即返し、候補 reader を failoverReaderHostSelectorStrategy (既定 random) で選んで繋ぎ、SELECT @@innodb_read_only で役割を確かめる。reader が全滅したら降格済みの旧 writer を試す。strict-reader のときの受け入れ条件と、候補配列が参照共有で 1 周しか回らない実装を読む。"
group: "フェイルオーバー"
sidebar:
  order: 37
---

## 何を学んだか

reader フェイルオーバーは、writer 側と対照的に**モニタを待たない**。今キャッシュにあるトポロジから reader 候補を選び、繋いでみて、役割を確かめる。それだけである。

- `forceMonitoringRefresh(false, 0)` は `timeoutMs = 0` なので、現在のトポロジを即座に返す。モニタには「そのうち更新して」というフラグだけ立てる
- 候補の選択は `failoverReaderHostSelectorStrategy` (既定 `random`) に委ねる
- 繋いだ後に `SELECT @@innodb_read_only` で役割を見る。`strict-reader` なら reader でなければ捨てる。`reader-or-writer` なら writer に当たっても受け入れる
- reader が全部ダメなら、**降格しているはずの旧 writer** に繋いでみる

writer 側が「新 writer は 1 台しかなく、それが誰かはモニタにしか分からない」のに対し、reader 側は「どれでもいいから生きている reader」でよい。だから待たない。

## ソースコードのどこか

### failoverReader — 待たずに取りに行く

[`failover2_plugin.ts#L245`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L245)。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
if (!(await this.pluginService.forceMonitoringRefresh(false, 0))) {
  // Unable to establish SQL connection to an instance.
  this.failoverReaderFailedCounter.inc();
  logger.error(Messages.get("Failover2.unableToFetchTopology"));
  throw new FailoverFailedError(Messages.get("Failover2.unableToFetchTopology"));
}
try {
  const result: ReaderFailoverResult = await this.getReaderFailoverConnection(failoverEndTimeMs);
  logger.info(Messages.get("Failover.establishedConnection", result.newHost.host));
  this.failoverReaderSuccessCounter.inc();
  await this.pluginService.abortCurrentClient();
  await this.pluginService.setCurrentClient(result.client, result.newHost);
  await this.pluginService.forceRefreshHostList();
} catch (error) {
  this.failoverReaderFailedCounter.inc();
  logger.error(Messages.get("Failover.unableToConnectToReader"));
  throw new FailoverFailedError(Messages.get("Failover.unableToConnectToReader"));
}
```

`forceMonitoringRefresh(false, 0)` の `false` は「監視接続を閉じない」、`0` は「待たない」である。`waitTillTopologyGetsUpdated(0)` ([`cluster_topology_monitor.ts#L239`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/cluster_topology_monitor.ts#L239)) は `requestToUpdateTopology = true` を立てて `currentHosts` をそのまま返す。ストレージにトポロジがまだなければ `null` が返り、`PluginService` 側で `false` になって `unableToFetchTopology` で終わる。

成功したら `abortCurrentClient()` で旧接続の socket を `destroy()` し、[`setCurrentClient`](../transfer-and-reset/) で差し替え、最後に `forceRefreshHostList()` で (今度は 5 秒タイムアウト付きで) トポロジを取り直す。差し替えの後に取り直すのは、今回使ったトポロジが古い可能性を認めているからである。

### getReaderFailoverConnection — 2 重ループ

[`failover2_plugin.ts#L281`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L281)。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
private async getReaderFailoverConnection(failoverEndTimeMs: number): Promise<ReaderFailoverResult> {
  // The roles in the host list may not be accurate, depending on whether the new topology has become available yet.
  const hosts = this.pluginService.getHosts();
  const readerCandidates = hosts.filter((x) => x.role === HostRole.READER);
  const originalWriter: HostInfo = hosts.find((x) => x.role === HostRole.WRITER);
  let isOriginalWriterStillWriter: boolean = false;

  while (Date.now() < failoverEndTimeMs) {
    // Try all the original readers.
    const remainingReaders = readerCandidates;
    while (remainingReaders.length > 0 && Date.now() < failoverEndTimeMs) {
      let readerCandidate: HostInfo = null;
      try {
        readerCandidate = this.pluginService.getHostInfoByStrategy(HostRole.READER, this.failoverReaderHostSelectorStrategy, remainingReaders);
      } catch (error) {
        logger.info(Messages.get("Failover2.errorSelectingReaderHost", error.message));
      }

      if (readerCandidate === null) {
        logger.info(Messages.get("Failover2.readerCandidateNull"));
      } else {
        try {
          const candidateClient: ClientWrapper = await this.createConnectionForHost(readerCandidate);
          const role: HostRole = await this.pluginService.getHostRole(candidateClient);
          if (role === HostRole.READER || this.failoverMode !== FailoverMode.STRICT_READER) {
            if (role !== readerCandidate.role) {
              // Update readerCandidate to reflect correct role.
              readerCandidate = this.pluginService.getHostInfoBuilder().copyFrom(readerCandidate).withRole(role).build();
            }
            return new ReaderFailoverResult(candidateClient, readerCandidate, true);
          }

          // Unable to fail over to readerCandidate, remove from remaining readers to try.
          remainingReaders.splice(remainingReaders.indexOf(readerCandidate), 1);
          await candidateClient.end();

          if (role === HostRole.WRITER) {
            // The readerCandidate is a writer, remove it from the list of reader candidates.
            readerCandidates.splice(readerCandidates.indexOf(readerCandidate), 1);
          } else {
            logger.info(Messages.get("Failover2.strictReaderUnknownHostRole"));
          }
        } catch {
          // Unable to connect to readerCandidate, remove from remaining readers to try.
          remainingReaders.splice(remainingReaders.indexOf(readerCandidate), 1);
        }
      }
    }

    // Unable to connect to any of the original readers, try to connect to original writer.
    if (originalWriter === null || Date.now() > failoverEndTimeMs) {
      continue;
    }

    if (this.failoverMode === FailoverMode.STRICT_READER && isOriginalWriterStillWriter) {
      // Original writer has been verified, and it is not valid in strict-reader mode.
      continue;
    }

    // Try the original writer, which may have been demoted.
    try {
      const candidateClient: ClientWrapper = await this.createConnectionForHost(originalWriter);
      const role: HostRole = await this.pluginService.getHostRole(candidateClient);
      if (role === HostRole.READER || this.failoverMode != FailoverMode.STRICT_READER) {
        const updatedHostInfo: HostInfo = this.pluginService.getHostInfoBuilder().copyFrom(originalWriter).withRole(role).build();
        return new ReaderFailoverResult(candidateClient, updatedHostInfo, true);
      }

      await candidateClient.end();

      if (role === HostRole.WRITER) {
        // Verify that writer has not been demoted, will not try to connect again.
        isOriginalWriterStillWriter = true;
      } else {
        logger.info(Messages.get("Failover2.strictReaderUnknownHostRole"));
      }
    } catch {
      logger.info(Messages.get("Failover.unableToConnectToReader"));
    }
  }

  logger.error(Messages.get("Failover.timeoutError"));
  throw new InternalQueryTimeoutError(Messages.get("Failover.timeoutError"));
}
```

読むときの要点は 4 つある。

**候補は `getHosts()` から取る。** `getAllHosts()` ではないので、customEndpoint などで絞られた範囲の中から選ぶ。writer 側と同じ扱いである。

**選択は `getHostInfoByStrategy` に委ねる。** `PluginManager.getHostInfoByStrategy` ([`plugin_manager.ts#L340`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_manager.ts#L340)) が `getHostInfoByStrategy` を subscribe しているプラグインに順に聞き、最後は `DefaultPlugin` が `ConnectionProviderManager` 経由で selector を呼ぶ。既定の `RandomHostSelector` ([`random_host_selector.ts#L24`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/random_host_selector.ts#L24)) は **`AVAILABLE` なホストだけ**を対象にし、該当がなければ例外を投げる。選択肢は [ホスト可用性戦略と選択戦略](../host-availability-and-selection/) を参照。

**受け入れ条件は `role === READER || failoverMode !== STRICT_READER`。** `reader-or-writer` は何に繋がっても受け入れる。`strict-reader` は reader だけを受け入れ、writer に当たったら `readerCandidates` からも外す (`role === WRITER` の分岐)。役割が想定と違っていれば `HostInfo` を作り直して正しい役割を持たせる。

**`remainingReaders` は `readerCandidates` のコピーではない。** `const remainingReaders = readerCandidates;` は同じ配列への参照なので、内側のループで `remainingReaders.splice(...)` した結果は `readerCandidates` にも残る。外側の `while` が 2 周目に入っても、1 周目で外れた reader は戻ってこない。コメントの "Try all the original readers" は各周で全 reader を試す意図に読めるが、実装では**各 reader は 1 度しか試されない**。2 周目以降にやることは、旧 writer への接続試行だけになる。

### 旧 writer を試す条件

reader が全滅した後の分岐は `failoverMode` で変わる。

| モード             | 旧 writer が reader に降格していた | 旧 writer がまだ writer                                     |
| ------------------ | ---------------------------------- | ----------------------------------------------------------- |
| `reader-or-writer` | 受け入れる                         | 受け入れる (writer でよい)                                  |
| `strict-reader`    | 受け入れる                         | `isOriginalWriterStillWriter = true` にして、以後は試さない |

`strict-reader` で reader が 1 台もなく、writer もまだ writer なら、外側ループは `continue` を繰り返してタイムアウトまで回り、`InternalQueryTimeoutError` → `FailoverFailedError` になる。docs の `failoverMode` の説明には "Reader failover to a writer instance will only be allowed for single-instance clusters" とあるが、v2 のこの関数に「単一インスタンスなら writer を許す」分岐はない。単一インスタンス構成で `strict-reader` を使うと失敗する。

### 外側ループにスリープがない

内側ループを抜けた後、旧 writer への接続試行に失敗すると、そのまま外側 `while` の次の周に入る。`sleep` はない。接続失敗が即座に返る状況 (`ECONNREFUSED`) では、`failoverTimeoutMs` (既定 300 秒) の間、接続試行が連続する。`wrapperConnectTimeout` (既定 10 秒) が効く状況なら 10 秒ごとになる。

## なぜそうなっているか

### なぜモニタを待たないのか

writer フェイルオーバーは「新 writer が確定するまで」待つ必要があり、その確定はモニタにしかできない。reader フェイルオーバーは「生きている reader ならどれでもいい」ので、キャッシュのトポロジで十分である。役割が古くても、繋いでから `@@innodb_read_only` で確かめるので、間違った役割のホストを掴むことはない。待たないぶん、フェイルオーバー中の reader 接続は数秒で復帰する。

### なぜ旧 writer を試すのか

Aurora のフェイルオーバーでは、旧 writer は落ちたのではなく**再起動して reader として戻ってくる**ことが多い。トポロジ上は `WRITER` のままでも、実体は reader になっている。`strict-reader` にとってはこれも立派な候補である。だから reader を試し尽くした後、「降格しているかもしれない」前提で旧 writer に繋ぎ、役割を確かめる。

### なぜ役割を毎回確かめるのか

コメントにあるとおり "The roles in the host list may not be accurate"。`replica_host_status` の情報はフェイルオーバー直後に古いことがあり、reader 経由で取ったトポロジならなおさらである。`SELECT @@innodb_read_only` は繋いだ相手の**現在の**状態を返す唯一の手段で、これを省くと `strict-reader` の契約が守れない。

## どう活かすか

- **「どれでもいい」探索と「特定の 1 つ」探索は、待ち方を分ける。** 前者はキャッシュで走り、後者は権威ある情報源を待つ。両方を同じ待ち時間で扱うと、片方が無駄に遅くなる
- **候補リストを絞りながら回すなら、周ごとにコピーする。** `const remaining = candidates;` は参照共有で、`[...candidates]` にしないと外側のリトライが意味を失う。この手のバグはテストが 1 周で終わると見えない
- **リトライループには必ずスリープか間隔制御を置く。** 接続拒否は即座に返るので、間隔がないと CPU とログを埋める
- **ドキュメントの例外規定は実装で確認する。** "single-instance clusters" の例外は v2 にはない。docs と実装が同じ版で書かれているとは限らない

### 実務で踏む失敗パターン

- **`strict-reader` で 1 台構成、または reader が全滅。** タイムアウトまで待って `FailoverFailedError`。読めればいいなら `reader-or-writer` にする
- **reader が全部 `NOT_AVAILABLE` になっている。** `RandomHostSelector` は `AVAILABLE` しか選ばず、例外は握って `readerCandidateNull` のログを出すだけで、`remainingReaders` は減らない。内側ループがタイムアウトまで空回りする。[exponentialBackoff の可用性戦略](../host-availability-and-selection/) を入れると、時間経過で `AVAILABLE` に戻る
- **カスタムエンドポイントの外に reader がいる。** `getHosts()` の範囲外なので候補にならない
- **`failoverReaderHostSelectorStrategy` を `leastConnections` にしたが内部プールを使っていない。** その戦略は内部プールの接続数を見るので、[内部プール](../internal-connection-pool/)なしでは受理されない
