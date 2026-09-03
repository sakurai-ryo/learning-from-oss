---
title: "Telemetry — OpenTelemetry / X-Ray"
description: "テレメトリはプラグインではなく、全パイプラインに横串で入る。TelemetryFactory の後ろに Null / OTLP / X-Ray の 3 実装を置き、4 段階の TelemetryTraceLevel で「アプリのトレースの中に入るか、独立したトレースにするか」を決める。3.0.0 で SDK が optional peerDependencies になり、バックエンドは動的 import で読む。X-Ray バックエンドは `new` が抜けていて、現 ref では起動できない。"
group: "横断"
sidebar:
  order: 71
---

## 何を学んだか

ラッパのテレメトリは `plugins` に列挙するものではない。`AwsClient` のコンストラクタが `DefaultTelemetryFactory` を 1 つ作り、`PluginManager` と `PluginService` がそれを持ち回る。プラグインの側は `telemetryFactory.openTelemetryContext(name, level).start(fn)` と書くだけで、バックエンドが OTLP なのか X-Ray なのか、そもそも無効なのかを知らない。

設計の要点は 3 つある。

- **バックエンドは動的 import で読む。** `@opentelemetry/api` も `aws-xray-sdk` も optional peerDependencies で、`enableTelemetry: true` にしない限り `import()` されない
- **トレースの階層は 4 段階の `TelemetryTraceLevel` で決める。** `TOP_LEVEL` / `NESTED` / `FORCE_TOP_LEVEL` / `NO_TRACE`。同じ `NESTED` でも、アプリ側にトレースが開いているかどうかで意味が変わる
- **フェイルオーバーだけ「写し」を最上位に置ける。** `telemetryFailoverAdditionalTopTrace` を立てると、クエリの span の奥に埋まったフェイルオーバーの span を、`copy: ` 接頭辞付きで根に複製する

そして、X-Ray バックエンドは現 ref では動かない。ファクトリの生成で `new` が抜けており、TypeScript の target が ES2022 なので `TypeError` になる。それが `catch` で `AwsWrapperError("A tracing backend could not be found.")` に化ける。

## ソースコードのどこか

### インタフェースと 4 段階のレベル

[`common/lib/utils/telemetry/telemetry_factory.ts#L22`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/telemetry_factory.ts#L22)。

```ts title="common/lib/utils/telemetry/telemetry_factory.ts"
export interface TelemetryFactory {
  init(): Promise<void>;
  openTelemetryContext(name: string, traceLevel: TelemetryTraceLevel): TelemetryContext;
  postCopy(
    telemetryContext: TelemetryContext,
    telemetryTraceLevel: TelemetryTraceLevel,
  ): Promise<void>;
  createCounter(name: string): TelemetryCounter;
  createGauge(name: string, callable: () => void): TelemetryGauge;
}
```

`TelemetryContext` のほうは `start(func)` を持ち、`func` を span の中で実行して結果をそのまま返す。呼び出し側は `return await context.start(async () => {...})` と書くので、テレメトリの有無でコードの形が変わらない。

レベルは [`telemetry_trace_level.ts#L17`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/telemetry_trace_level.ts#L17)。

```ts title="common/lib/utils/telemetry/telemetry_trace_level.ts"
export enum TelemetryTraceLevel {
  FORCE_TOP_LEVEL, // always top level despite settings
  TOP_LEVEL, // if allowed by settings
  NESTED,
  NO_TRACE, // post no trace
}
```

### DefaultTelemetryFactory — 設定を読み、バックエンドを動的 import する

[`default_telemetry_factory.ts#L37`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/default_telemetry_factory.ts#L37)。コンストラクタは 4 つのプロパティを読むだけで、何も import しない。

```ts title="common/lib/utils/telemetry/default_telemetry_factory.ts"
constructor(properties: Map<string, any>) {
  this.enableTelemetry = WrapperProperties.ENABLE_TELEMETRY.get(properties);
  const telemetryTracesBackend = WrapperProperties.TELEMETRY_TRACES_BACKEND.get(properties)
    ? WrapperProperties.TELEMETRY_TRACES_BACKEND.get(properties).toLowerCase()
    : "";
  // ...
  this.telemetryTracesBackend = telemetryTracesBackend && this.enableTelemetry ? telemetryTracesBackend : "none";
  this.telemetryMetricsBackend = telemetryMetricsBackend && this.enableTelemetry ? telemetryMetricsBackend : "none";
  this.telemetrySubmitTopLevel = WrapperProperties.TELEMETRY_SUBMIT_TOPLEVEL.get(properties);
}
```

`enableTelemetry` が false なら、バックエンド名が何であれ `"none"` に潰される。実際の読み込みは [`init()#L50`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/default_telemetry_factory.ts#L50) で、`AwsClient.setup()` から `connect()` のたびに呼ばれる。2 回目以降は `??` で素通りする。

```ts title="common/lib/utils/telemetry/default_telemetry_factory.ts"
private static async getTelemetryFactory(backend: string, type: string) {
  try {
    switch (backend) {
      case "otlp":
        if (!DefaultTelemetryFactory.openTelemetryFactory) {
          DefaultTelemetryFactory.openTelemetryFactory = await import("./open_telemetry_factory");
        }
        return new DefaultTelemetryFactory.openTelemetryFactory.OpenTelemetryFactory();
      case "xray":
        if (!DefaultTelemetryFactory.xrayTelemetryFactory) {
          DefaultTelemetryFactory.xrayTelemetryFactory = await import("./xray_telemetry_factory");
        }
        return DefaultTelemetryFactory.xrayTelemetryFactory.XRayTelemetryFactory();
      case "none":
        return new NullTelemetryFactory();
      default:
        throw new AwsWrapperError(Messages.get("DefaultTelemetryFactory.invalidBackend", backend, type));
    }
  } catch (error: any) {
    if (error instanceof AwsWrapperError) {
      throw error;
    }
    throw new AwsWrapperError(Messages.get("DefaultTelemetryFactory.importFailure"));
  }
}
```

`case "xray"` の行 ([L71](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/default_telemetry_factory.ts#L71)) に `new` がない。`XRayTelemetryFactory` は `class` で、`tsconfig.json` の target は `ES2022` なので、そのまま class 構文で出力される。class を `new` なしで呼ぶと `TypeError: Class constructor XRayTelemetryFactory cannot be invoked without 'new'` になり、`catch` が `AwsWrapperError` 以外を全部 `"A tracing backend could not be found."` に変換する。**`telemetryTracesBackend: "XRAY"` を指定すると、`aws-xray-sdk` を正しく入れていても、このメッセージで `connect()` が落ちる。** `tests/unit` に X-Ray バックエンドを通すテストはなく、統合テストも OTLP だけを使っている ([統合テストの作り方](../integration-tests/))。

import した module を static に保持しているので、プロセス内で最初の 1 回しか `import()` は走らない。ファクトリの実体 (`OpenTelemetryFactory`) はクライアントごとに `new` される。

### どこでコンテキストが開かれるか

`openTelemetryContext` を呼んでいる場所を、レベル別に並べる。

| 場所                                                                                                                                                                                                                               | span 名                                                   | レベル                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| [`mysql/lib/client.ts#L73`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L73) `connect()`                                                                  | `awsClient.connect`                                       | `TOP_LEVEL`                                  |
| [`client.ts#L523`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L523) `query()` / `execute()`                                                              | `awsClient.query` / `awsClient.execute`                   | `TOP_LEVEL`                                  |
| [`plugin_manager.ts#L123`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_manager.ts#L123) `execute()` / `connect()` / `forceConnect()` / `initHostProvider()` | メソッド名 (`query` など)                                 | `NESTED`                                     |
| [`plugin_manager.ts#L116`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_manager.ts#L116) `runMethodFuncWithTelemetry` (プラグイン 1 つごと)                  | `plugin.name` (`Failover2Plugin` など)                    | `NESTED`                                     |
| `default_plugin.ts`                                                                                                                                                                                                                | `mysql2 - query` のように `DriverDialect 名 - メソッド名` | `NESTED`                                     |
| `failover2_plugin.ts` / `failover_plugin.ts`                                                                                                                                                                                       | `writerFailover` / `readerFailover`                       | `NESTED` (+ `postCopy` で `FORCE_TOP_LEVEL`) |
| [`efm/base/host_monitor.ts#L190`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/efm/base/host_monitor.ts#L190) `checkConnectionStatus`                       | `Connection status check`                                 | `FORCE_TOP_LEVEL`                            |
| `host_response_time_monitor.ts` / `limitless_router_monitor.ts`                                                                                                                                                                    | `host response time task` など                            | `TOP_LEVEL`                                  |
| `iam_auth_utils.ts` / `aws_secrets_manager_plugin.ts` / `federated_auth/`                                                                                                                                                          | トークン取得・シークレット取得                            | `NESTED`                                     |

`query()` 1 回で、`awsClient.query` → `query` → 各プラグイン → `mysql2 - query` という 4 段の span が積まれる。既定 4 プラグインなら span は 7 つになる。監視タスクが `FORCE_TOP_LEVEL` / `TOP_LEVEL` なのは、アプリのリクエストと無関係な文脈で走るので、どのリクエストにも属さない独立したトレースにするためである。

### OpenTelemetryContext.start — 親があるかでレベルの意味が変わる

[`open_telemetry_context.ts#L38`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/open_telemetry_context.ts#L38)。

```ts title="common/lib/utils/telemetry/open_telemetry_context.ts"
async start(func: () => any): Promise<any> {
  const activeContext = context.active();
  const isRoot = activeContext === api.ROOT_CONTEXT;

  let effectiveTraceLevel: TelemetryTraceLevel = this.traceLevel;
  if (isRoot && this.traceLevel === TelemetryTraceLevel.NESTED) {
    effectiveTraceLevel = TelemetryTraceLevel.TOP_LEVEL;
  }
  const key = createContextKey(`${this.name}-key`);
  this.span = trace.getActiveSpan();

  switch (effectiveTraceLevel) {
    case TelemetryTraceLevel.FORCE_TOP_LEVEL:
    case TelemetryTraceLevel.TOP_LEVEL:
      return await context.with(activeContext.setValue(key, "context"), async () => {
        return await this.tracer.startActiveSpan(this.name, async (span: APISpan) => {
          if (!isRoot && this.span) {
            const parentId = this.span.spanContext().spanId;
            this.span = span;
            this.setAttribute(TelemetryConst.PARENT_TRACE_ANNOTATION, parentId);
          } else {
            this.span = span;
          }
          this.setAttribute(TelemetryConst.TRACE_NAME_ANNOTATION, this.name);
          logger.info(`[OTLP] Telemetry '${this.name}' trace ID: ${this.span.spanContext().traceId}`);
          return await this.executeMethod(func);
        });
      });
    case TelemetryTraceLevel.NESTED:
      return await this.tracer.startActiveSpan(this.name, async (span: APISpan) => {
        const parentId = this.span!.spanContext().spanId;
        this.span = span;
        this.setAttribute(TelemetryConst.PARENT_TRACE_ANNOTATION, parentId);
        this.setAttribute(TelemetryConst.TRACE_NAME_ANNOTATION, this.name);
        return await this.executeMethod(func);
      });
    case TelemetryTraceLevel.NO_TRACE:
      return await func();
    default:
      return await func();
  }
}
```

レベルの解決は 2 段階になっている。

1. **`DefaultTelemetryFactory.openTelemetryContext` ([L99](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/default_telemetry_factory.ts#L99))** が、`telemetrySubmitTopLevel` が false (既定) なら `TOP_LEVEL` を `NESTED` に落とす。`awsClient.query` は既定では `NESTED` として扱われる
2. **`start()`** が、`context.active()` が `ROOT_CONTEXT` なら `NESTED` を `TOP_LEVEL` に上げる。アプリがトレースを開いていなければ、ラッパの span が新しいトレースの根になる

つまり既定では「アプリの span があればその子、なければ新しい根」になる。docs の `Telemetry.md` は「アプリ側にトレースが開いていなければラッパのトレースは収集も送信もされない」と書いているが、コードは逆で、**根に昇格させて送る**。

`TOP_LEVEL` 分岐にも注意がいる。`context.with(activeContext.setValue(key, "context"), ...)` に渡しているのは `ROOT_CONTEXT` ではなく `activeContext` なので、アプリの span が生きていれば `startActiveSpan` はその子として span を作る。OTel の意味で本当に「トップレベル」になるのは、`activeContext` が根のときだけである。`FORCE_TOP_LEVEL` で開かれる EFM の `Connection status check` も同じ分岐を通るが、監視タスクは `setTimeout` から起きるので `context.active()` は根で、結果として独立したトレースになる。`parentTraceId` 属性を付けるのは、この「実は親がいる」ケースを後から辿れるようにするためだと読める。

`executeMethod` ([L85](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/open_telemetry_context.ts#L85)) は `func()` の成否で `SpanStatusCode.OK` / `ERROR` を立て、例外は `recordException` してから投げ直す。`finally` で `span.end()` するので、`FailoverSuccessError` のような「成功なのに例外」もエラー扱いの span になる。

### X-Ray 版は Segment と Subsegment

[`xray_telemetry_context.ts#L34`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/xray_telemetry_context.ts#L34)。構造は OTLP 版と同じで、`getSegment()` が投げれば「親なし」と見なして `NESTED` を `TOP_LEVEL` に上げる。`TOP_LEVEL` は `new Segment(this.name)` ([L52](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/xray_telemetry_context.ts#L52)) で本当に新しい根を作り、`NESTED` は `addNewSubsegment` ([L69](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/xray_telemetry_context.ts#L69)) で親にぶら下げる。こちらは OTLP 版と違って、`TOP_LEVEL` が名前どおり独立した Segment になる。

X-Ray はメトリクスを持たない。[`xray_telemetry_factory.ts#L28`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/xray_telemetry_factory.ts#L28) の `createCounter` は `throw new AwsWrapperError("XRay does not support metrics.")` だが、隣の `createGauge` は `return new AwsWrapperError(...)` で、投げずに返している。`telemetryMetricsBackend` に `XRAY` は指定できないので、実害が出るのは metrics を OTLP、traces を X-Ray にした構成でもなく、到達しない分岐である。

### postCopy — フェイルオーバーの写しを根に置く

[`failover2_plugin.ts#L423`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L423)。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
} finally {
  if (this.telemetryFailoverAdditionalTopTraceSetting) {
    await telemetryFactory.postCopy(telemetryContext, TelemetryTraceLevel.FORCE_TOP_LEVEL);
  }
}
```

`OpenTelemetryContext.postCopy` ([L152](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/open_telemetry_context.ts#L152)) は `copy: writerFailover` という名前の新しいコンテキストを作り、`createSpanCopy` ([L98](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/open_telemetry_context.ts#L98)) が **`api.ROOT_CONTEXT`** の下で span を開いて、元の属性と `sourceTraceId` (元 span の spanId) を写して即 `end()` する。こちらは `start()` と違って明示的に根を使うので、必ず独立したトレースになる。

### メトリクス

`createCounter` を呼んでいる場所と名前。

| 名前                                                                                                                  | 場所                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writerFailover.triggered.count` / `writerFailover.completed.success.count` / `writerFailover.completed.failed.count` | `failover_plugin.ts`、`failover2_plugin.ts`                                                                                                                                        |
| `readerFailover.triggered.count` / `.completed.success.count` / `.completed.failed.count`                             | 同上                                                                                                                                                                               |
| `efm.connections.aborted`                                                                                             | `efm/base/host_monitor_service.ts`                                                                                                                                                 |
| `efm.nodeUnhealthy.count.<hostId>`                                                                                    | [`efm/base/host_monitor.ts#L72`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/efm/base/host_monitor.ts#L72) |
| `staleDNS.stale.detected`                                                                                             | `stale_dns/stale_dns_helper.ts`                                                                                                                                                    |
| `iam.fetchTokenCount`                                                                                                 | `authentication/iam_authentication_plugin.ts`                                                                                                                                      |
| `secretsManager.fetchCredentials.count`                                                                               | `authentication/aws_secrets_manager_plugin.ts`                                                                                                                                     |
| `federatedAuth.fetchToken.count` / `oktaAuth.fetchToken.count`                                                        | `federated_auth/saml_auth_plugin.ts`                                                                                                                                               |
| `customEndpoint.*`                                                                                                    | `custom_endpoint/`                                                                                                                                                                 |
| `frt.response.time.<hostId>` (gauge)                                                                                  | `strategy/fastest_response/host_response_time_monitor.ts`                                                                                                                          |

docs の List of Metrics は `efm.hostUnhealthy.count.[INSTANCE]` と `iam.fetchToken.count` と書いているが、コードは `efm.nodeUnhealthy.count.` と `iam.fetchTokenCount` である。ダッシュボードを docs の名前で組むと空になる。

カウンタは OTel の `Meter.createCounter` に直結していて、ラッパ側で集計はしない。同じ名前のカウンタが `failover` と `failover2` の両方から作られるが、排他なので衝突はしない。

### 依存の扱い

`package.json` の peerDependencies に `@opentelemetry/api` / `@opentelemetry/sdk-node` / `@opentelemetry/sdk-metrics` / `aws-xray-sdk` などが並び、`peerDependenciesMeta` で全部 optional になっている。CHANGELOG 3.0.0 の Breaking Changes に「optional runtime dependencies are no longer installed for you」とあるのがこれで、2.x までは `dependencies` に入っていた。

1 点、`open_telemetry_context.ts` は [`import { api } from "@opentelemetry/sdk-node"`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/telemetry/open_telemetry_context.ts#L21) を `api.ROOT_CONTEXT` のためだけに使っている。`ROOT_CONTEXT` は `@opentelemetry/api` にもあるので、OTLP バックエンドを使うために `sdk-node` まで入れる必要があるのは、この 1 行のせいである。

## なぜそうなっているか

### なぜプラグインではなく横串なのか

テレメトリで見たいのは「どのプラグインがどれだけ時間を使ったか」で、それは plugin chain の**外側**からしか測れない。`runMethodFuncWithTelemetry` が各プラグインの `execute` を span で包んでいるのは `PluginManager` であって、プラグイン自身ではない。プラグインとして実装すると、自分より内側しか測れなくなる。

代わりに、プラグインが自分の関心事 (フェイルオーバーの成否、トークン取得回数) を記録したいときは `pluginService.getTelemetryFactory()` で同じファクトリを取る。横串の器と、各プラグインの計器が、1 つのファクトリを共有している。

### なぜ 4 段階なのか

ラッパは自分がトレースの根になるべきかを知らない。Express のハンドラの中で呼ばれているなら、そのリクエストの span の子になるべきだし、バッチスクリプトから呼ばれているなら根になるべきである。`NESTED` を既定にして「根なら昇格」で吸収したのは、この判断を呼び出し側に押し付けないためだ。

`telemetrySubmitTopLevel` はその逆で、「アプリのトレースの中に入れたくない」人向けの明示的な切り替えになっている。`FORCE_TOP_LEVEL` は設定に関係なく独立させたい監視タスクと `postCopy` のためにある。`NO_TRACE` は現 ref では使われていない。

### なぜフェイルオーバーだけ写しを作るのか

フェイルオーバーは `awsClient.query` → `query` → `Failover2Plugin` → `writerFailover` と、4 段目の奥で起きる。トレース一覧で見つけるには `query` の span を全部開く必要がある。`copy: writerFailover` を根に置けば、一覧で「フェイルオーバーが起きた回」だけを拾える。`sourceTraceId` で元の span に戻れるので、情報が失われるわけでもない。既定で off なのは、正常時には 1 つも増えないとはいえ、根の span は目立つからだろう。

### なぜ動的 import なのか

`import()` を `init()` の中で行い、失敗を `AwsWrapperError` に包んでいる。静的 import にすると、テレメトリを使わないアプリでも `@opentelemetry/sdk-node` の解決が走り、入っていなければ起動時に落ちる。optional peerDependency と動的 import はセットで、片方だけでは成立しない。

X-Ray の `new` 抜けが見つかっていないのは、この `catch` が `TypeError` を「バックエンドが見つからない」に書き換えてしまうからでもある。エラーメッセージが原因を隠している。

## どう活かすか

- **横断的な計測は chain の外側で包む。** ミドルウェア型の設計では、各段の実行時間は段の中ではなく段を呼ぶ側で測る。ラッパの `runMethodFuncWithTelemetry` がその形で、プラグインは自分を測らない
- **「根になるか」を呼び出し側に決めさせない既定を置く。** `context.active()` が根かどうかで昇格させる方式は、ライブラリがアプリのトレース構成を知らなくても壊れない。ただし docs と挙動を揃えること。ラッパの docs は「開いていなければ送らない」と書いており、実装と食い違っている
- **`catch (e) { throw new MyError("not found") }` は原因を消す。** `TypeError` まで「見つからない」に丸めた結果、`new` 抜けが通り抜けている。包み直すときは `cause` に元の例外を残す
- **メトリクス名は docs ではなくコードから取る。** ダッシュボードを docs の表で組むと、`efm.hostUnhealthy` と `iam.fetchToken.count` は空のままになる

### 実務で踏む失敗パターン

- **`telemetryTracesBackend: "XRAY"` で `A tracing backend could not be found.`** `aws-xray-sdk` の有無ではなく、ファクトリ生成の `new` 抜けが原因。現 ref では OTLP を使い、X-Ray に送りたければ ADOT Collector 側で変換する
- **`@opentelemetry/api` だけ入れて OTLP を指定し、同じメッセージで落ちる。** `open_telemetry_context.ts` が `@opentelemetry/sdk-node` を import するので、`sdk-node` も必要
- **span が 1 クエリで 7 つ出て、トレースの量が想定の数倍になる。** `NESTED` は全プラグインに付く。サンプリングは OTel SDK 側で掛ける。ラッパにサンプリング設定はない
- **アプリのトレースの中にラッパの span が入ってこない。** `context.setGlobalContextManager(new AsyncHooksContextManager())` を `sdk.start()` の前に呼んでいるか確認する。`examples/` と統合テストの `test_environment.ts` はどちらもこれを明示している。コンテキストマネージャがなければ `context.active()` は常に根で、全部が独立したトレースになる
