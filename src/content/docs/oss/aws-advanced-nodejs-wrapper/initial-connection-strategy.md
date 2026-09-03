---
title: "initialConnection プラグイン"
description: "最初の接続で「本当に writer (または reader) に繋がったか」を 30 秒間リトライしながら確かめる既定プラグイン。トポロジに writer が載っていればインスタンスエンドポイントで直接繋ぎ、載っていなければ DNS で繋いでから identifyConnection で確認する。reader エンドポイントでは選択戦略で reader を選び、reader がゼロなら writer を返して Aurora の挙動を真似る。"
group: "フェイルオーバー"
sidebar:
  order: 43
---

## 何を学んだか

`initialConnection` は 2.1.1 から既定プラグインの先頭 (weight 390) に入った。役目は「クラスタエンドポイントで繋ぐとき、DNS の結果を信じずに役割を確かめる」ことで、[StaleDns](../stale-dns/) と目的は同じだが、手順が逆である。

- **トポロジに目的の役割のホストが載っていれば、DNS を使わずインスタンスエンドポイントで直接繋ぐ**
- 載っていなければ DNS で繋ぎ、`forceRefreshHostList` + `identifyConnection` で「どのインスタンスに繋がったか」を突き止める
- 役割が違ったら接続を捨て、`openConnectionRetryIntervalMs` (1 秒) 待って、`openConnectionRetryTimeoutMs` (30 秒) まで繰り返す

reader エンドポイント向けには `readerHostSelectorStrategy` で reader を選ぶ経路があり、reader が 1 台もないクラスタでは writer を返す。これは Aurora の reader エンドポイントが「reader がいなければ writer に流す」のと同じ挙動をラッパ側で再現している。

## ソースコードのどこか

### 入口 — エンドポイントの種類で分岐

[`common/lib/plugins/aurora_initial_connection_strategy_plugin.ts#L59`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/aurora_initial_connection_strategy_plugin.ts#L59)。購読は `initHostProvider` と `connect` だけで、クエリ実行には関与しない。

```ts title="common/lib/plugins/aurora_initial_connection_strategy_plugin.ts"
async connect(
  hostInfo: HostInfo,
  props: Map<string, any>,
  isInitialConnection: boolean,
  connectFunc: () => Promise<ClientWrapper>
): Promise<ClientWrapper> {
  this.accessibleRegions = AccessibleRegions.parse(props);

  const type = this.rdsUtils.identifyRdsType(hostInfo.host);

  if (!type.isRdsCluster) {
    // It's not a cluster endpoint. Continue with a normal workflow.
    return connectFunc();
  }

  if (type === RdsUrlType.RDS_WRITER_CLUSTER) {
    const writerCandidateClient = await this.getVerifiedWriterClient(props, isInitialConnection, connectFunc);
    if (writerCandidateClient === null) {
      // Can't get writer connection. Continue with a normal workflow.
      logger.debug("Writer cluster endpoint does not resolve to a valid reader instance, skipping the initial connection strategy logic.");
      return connectFunc();
    }
    return writerCandidateClient;
  }

  if (type === RdsUrlType.RDS_READER_CLUSTER) {
    const readerCandidateClient = await this.getVerifiedReaderClient(props, isInitialConnection, connectFunc);
    if (readerCandidateClient === null) {
      // ...
      return connectFunc();
    }
    return readerCandidateClient;
  }
  // Continue with normal workflow
  return connectFunc();
}
```

`RdsUrlType.isRdsCluster` が `true` なのは `RDS_WRITER_CLUSTER` / `RDS_READER_CLUSTER` / `RDS_GLOBAL_WRITER_CLUSTER` の 3 つ ([`rds_url_type.ts#L17`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_url_type.ts#L17))。インスタンスエンドポイント、カスタムエンドポイント、IP、カスタムドメインはすべて素通しである。Global の writer エンドポイントは `isRdsCluster` だが、下の 2 分岐のどちらにも当たらないので、これも素通しになる。

### writer を確かめる

[`getVerifiedWriterClient`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/aurora_initial_connection_strategy_plugin.ts#L97)。

```ts title="common/lib/plugins/aurora_initial_connection_strategy_plugin.ts"
const retryDelayMs = WrapperProperties.OPEN_CONNECTION_RETRY_INTERVAL_MS.get(props);
const endTimeMillis = Date.now() + WrapperProperties.OPEN_CONNECTION_RETRY_TIMEOUT_MS.get(props);

while (Date.now() < endTimeMillis) {
  writerCandidateClient = null;
  writerCandidate = null;

  try {
    writerCandidate = this.getWriter();

    if (writerCandidate === null || this.rdsUtils.isRdsClusterDns(writerCandidate.host)) {
      // Writer is not found. It seems that topology is outdated.
      writerCandidateClient = await connectFunc();
      await this.pluginService.forceRefreshHostList();
      writerCandidate = await this.pluginService.identifyConnection(writerCandidateClient);

      if (writerCandidate) {
        if (writerCandidate.role !== HostRole.WRITER) {
          // Shouldn't be here. But let's try again.
          await this.pluginService.abortTargetClient(writerCandidateClient);
          await sleep(retryDelayMs);
          continue;
        }

        this.pluginService.setRoutedHostInfo(writerCandidate);
      }
      return writerCandidateClient;
    }
    writerCandidateClient = await this.pluginService.connect(writerCandidate, props, this);

    if ((await this.pluginService.getHostRole(writerCandidateClient)) !== HostRole.WRITER) {
      // If the new connection resolves to a reader instance, this means the topology is outdated.
      // Force refresh to update the topology.
      await this.pluginService.forceRefreshHostList();
      await this.pluginService.abortTargetClient(writerCandidateClient);
      await sleep(retryDelayMs);
      continue;
    }

    // Writer connection is valid and verified.
    this.pluginService.setRoutedHostInfo(writerCandidate);
    return writerCandidateClient;
  } catch (error: any) {
    await this.pluginService.abortTargetClient(writerCandidateClient);
    if (this.pluginService.isLoginError(error) || !writerCandidate) {
      throw error;
    } else if (writerCandidate) {
      this.pluginService.setAvailability(writerCandidate, HostAvailability.NOT_AVAILABLE);
    }
  }
}
```

ループの中に 2 つの経路がある。

1. **トポロジに writer がいない、または writer のホスト名がクラスタ DNS のまま**: 初回接続で、まだトポロジを 1 度も読んでいないときがこれにあたる。`connectFunc()` で DNS のまま繋ぎ、`forceRefreshHostList()` でトポロジを取り、`identifyConnection()` で「今繋いでいるのはどのインスタンスか」を `@@aurora_server_id` で確かめる ([identifyConnection](../identify-connection/))。writer なら `setRoutedHostInfo` で「実際に繋いだ先」を記録して返す
2. **トポロジに writer がいる**: `pluginService.connect(writerCandidate, props, this)` で、**このプラグイン自身を飛ばして** connect パイプラインをやり直す。ホストは writer のインスタンスエンドポイントになる。繋いだら `getHostRole` (`@@innodb_read_only`) で writer であることを確かめ、違えばトポロジが古いので強制更新して次のループへ

`setRoutedHostInfo` は `AwsMySQLClient.connect()` の最後で `getRoutedHostInfo() ?? getInitialConnectionHostInfo() ?? result.hostInfo` の優先順で読まれ、`setCurrentClient` に渡る ([AwsMySQLClient](../aws-mysql-client/))。クラスタエンドポイントで繋いでも、`PluginService` が覚える「現在のホスト」はインスタンスエンドポイントになる。

エラー時は、認証エラーなら即座に投げ直し、それ以外で候補が決まっていたなら `NOT_AVAILABLE` にマークして次のループで別の候補を探す。

### reader を確かめる

[`getVerifiedReaderClient`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/aurora_initial_connection_strategy_plugin.ts#L157) は writer 版と同じ骨格で、違いは 2 つある。

```ts title="common/lib/plugins/aurora_initial_connection_strategy_plugin.ts"
private getReader(props: Map<string, any>): HostInfo | undefined {
  const strategy = WrapperProperties.READER_HOST_SELECTOR_STRATEGY.get(props);
  if (this.pluginService.acceptsStrategy(HostRole.READER, strategy)) {
    try {
      // Restrict strategy-based selection to accessible regions so the initial connection never
      // targets a host we can't reach. When no regions are configured, the full host list is used.
      const accessibleReaders = this.accessibleRegions ? this.getAccessibleHosts().filter((x) => x.role === HostRole.READER) : undefined;
      return this.pluginService.getHostInfoByStrategy(HostRole.READER, strategy, accessibleReaders);
    } catch (error: any) {
      // Host isn't found
      logger.error(error.message);
    }
  }
  throw new AwsWrapperError(Messages.get("AuroraInitialConnectionStrategyPlugin.unsupportedStrategy", strategy));
}
```

1 つ目は候補の選び方で、`readerHostSelectorStrategy` (既定 `random`) を `acceptsStrategy` / `getHostInfoByStrategy` パイプラインに流して選ぶ ([ホスト可用性戦略と選択戦略](../host-availability-and-selection/))。`leastConnections` や `fastestResponse` を指定すると、最初の接続からその戦略で reader が選ばれる。

2 つ目は reader がいないときの扱いである。

```ts title="common/lib/plugins/aurora_initial_connection_strategy_plugin.ts"
if ((await this.pluginService.getHostRole(readerCandidateClient)) !== HostRole.READER) {
  // If the new connection resolves to a writer instance, this means the topology is outdated.
  // Force refresh to update the topology.
  await this.pluginService.forceRefreshHostList();

  if (this.hasNoReaders()) {
    // It seems that cluster has no readers. Simulate Aurora reader cluster endpoint logic
    // and return the current (writer) client.
    this.pluginService.setRoutedHostInfo(readerCandidate);
    return readerCandidateClient;
  }
  await this.pluginService.abortTargetClient(readerCandidateClient);
  await sleep(retryDelayMs);
  continue;
}
```

繋いだ先が writer だった場合、トポロジを更新して「reader がゼロか」を見る。ゼロなら writer 接続をそのまま返す。1 台構成のクラスタで reader エンドポイントに繋ぐと Aurora は writer に流すので、それを真似ている。

### 30 秒の意味

`openConnectionRetryTimeoutMs` の既定は 30,000ms、`openConnectionRetryIntervalMs` は 1,000ms ([`wrapper_property.ts#L522`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L522))。`UsingTheAuroraInitialConnectionStrategyPlugin.md` は DNS の更新に 40〜60 秒かかると書いていて、30 秒はその半分から 3/4 で、「DNS が古いあいだ、トポロジ経由でなら writer に届くはずだから待つ」時間である。

## なぜそうなっているか

### なぜ DNS より先にトポロジを見るのか

[StaleDns](../stale-dns/) は「まず DNS で繋いでから役割を聞く」。この順序だと、DNS が古いあいだは毎回「繋ぐ → reader だと分かる → 張り直す」で 2 回接続する。`initialConnection` はトポロジがキャッシュに残っていれば最初から正しいインスタンスに繋ぐので 1 回で済む。

このプラグインが真価を発揮するのは、**2 本目以降の接続**である。プロセス内の別の `AwsMySQLClient` がすでにトポロジを読んでいれば ([clusterId](../cluster-id/) で共有される)、新しい接続は DNS を引くことすらなく writer に届く。フェイルオーバー直後に接続を張り直すアプリ (プールが枯れて再生成する場面) で、DNS の 40〜60 秒を丸ごと飛ばせる。

### なぜ自分を飛ばして connect し直すのか

`pluginService.connect(writerCandidate, props, this)` の第 3 引数は `pluginToSkip` で、`PluginManager.connect` はこのプラグインを除いたチェーンで connect パイプラインを組み直す ([9 本のパイプライン](../pipelines/))。自分を含めると、インスタンスエンドポイントへの接続で再びこの `connect` が呼ばれる。`identifyRdsType` が `RDS_INSTANCE` を返すので素通しにはなるが、`accessibleRegions` の再パースなど無駄が出るし、再帰の可能性を読む側が考えなくて済む。

このやり直しで `auroraConnectionTracker` / `failover2` (StaleDns) / `efm2` / 認証プラグインは通る。だから IAM トークンはインスタンスエンドポイント向けに正しく生成され、接続は tracker に登録される。**プラグインが別のプラグインの仕事を横取りしない**ための設計である。

### なぜ reader ゼロで writer を返すのか

Aurora の reader エンドポイントは、reader がいないクラスタでは writer に解決される。ラッパが「reader エンドポイントなのだから reader でなければ失敗」と厳密にすると、Aurora 単体で動いていたアプリが、ラッパを入れた途端に 1 台構成で繋げなくなる。「既存の挙動を壊さない」を優先している。

`failoverMode` の `reader-or-writer` が同じ判断をしている ([failoverMode](../failover-mode/))。reader エンドポイントの既定がそれになるのも同じ理由である。

### なぜ 2.1.1 で既定に入ったのか

CHANGELOG 2.1.1 で "Added Aurora Initial Connection Strategy Plugin as one of default plugins enabled"。それまでの既定は `auroraConnectionTracker,failover2,efm2` で、最初の接続の検証は failover2 内の StaleDns だけだった。StaleDns は「DNS で繋いでから確認」しかできず、DNS が古い 40〜60 秒のあいだは毎回 2 回接続することになる。既定プラグインの先頭に `initialConnection` を置くことで、トポロジキャッシュが温まっていればその往復がなくなる。

## どう活かすか

- **キャッシュがあるなら名前解決を飛ばす。** サービスディスカバリの結果をキャッシュしているなら、DNS を引く前にそれを使い、繋いだ後で「本当にその相手か」を確かめる。名前解決は「キャッシュが空のときの最後の手段」に降格させる
- **リトライの上限は「相手が直る時間」から決める。** 30 秒は DNS の伝播時間から逆算されている。指数バックオフの回数ではなく「この時間を過ぎたら待っても無駄」という根拠のある値を置く
- **自分を除いたパイプラインを再実行する API を用意する。** `pluginToSkip` は小さな仕掛けだが、ミドルウェアが「別の宛先でやり直したい」ときに、他のミドルウェアの仕事を壊さずに済む。`tower` の Service スタックなどでも同じ設計が使える
- **取り込むべきでない条件。** この検証は接続のたびに最低 1 回、DNS 経路なら 2 回のクエリ (`forceRefreshHostList` + `identifyConnection`) を打つ。短命な接続を大量に作る構成 (Lambda から毎回接続など) では、この 30 秒リトライが起動時間に直結する。そういう構成では `plugins` から外すか、`openConnectionRetryTimeoutMs` を短くする

### つまずきどころ

- **タイムアウトすると `undefined` が返る。** `getVerifiedWriterClient` は `while` を抜けたあとに `return` がなく、戻り値は `undefined` になる。呼び出し側は `=== null` で「取れなかったので `connectFunc()` にフォールバック」を判定しているので、この分岐には入らず、`undefined` がそのまま `connect` パイプラインの結果になる。30 秒間 writer が見つからない状況は、フォールバックではなく接続失敗として現れる
- **インスタンスエンドポイントでは何もしない。** `isRdsCluster` が `false` なので素通し。2.1.0 の CHANGELOG に "incorrectly erroring out during initial connections when using instance endpoints" の修正があり、以前はここで落ちていた
- **`readerHostSelectorStrategy` に未対応の値を入れると例外。** `acceptsStrategy` が `false` を返すと `AuroraInitialConnectionStrategyPlugin.unsupportedStrategy` で落ちる。`fastestResponse` を使うなら `fastestResponseStrategy` プラグインを一緒に有効にする必要がある
- **StaleDns と両方通る。** 既定構成では `initialConnection` の後に `failover2` の StaleDns が走る。`initialConnection` がインスタンスエンドポイントに繋ぎ直した後は StaleDns は素通しだが、DNS 経路 (経路 1) で返した接続は `connectFunc()` の中で StaleDns の検証を受けている。ログに `@@innodb_read_only` が 2 回出るのはこのためである
