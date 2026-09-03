---
title: "WrapperProperties — mysql2 に渡す前に剥がす"
description: "config オブジェクトは Map に変換され、ラッパ固有のキー約 100 個は WrapperProperty として名前・既定値・許容値を持つ。mysql2 に渡す直前に removeWrapperProperties がそれらと monitoring_ 系接頭辞のキーを剥がし、残りがそのまま mysql2 の ConnectionOptions になる。3 つの接頭辞が監視接続の設定を分離する仕組みも読む。"
group: "骨格 — 呼び出しを横取りする仕掛け"
sidebar:
  order: 20
---

## この層の責務

アプリは `new AwsMySQLClient({ host, user, password, plugins: "failover2", ssl: {...}, wrapperQueryTimeout: 5000 })` のように、**mysql2 のオプションとラッパのオプションを同じオブジェクトに混ぜて**渡す。ラッパはこれを 1 つの `Map<string, any>` にして内部で回し、mysql2 に渡す直前にラッパのキーだけを剥がす。

このページで確定させるのは 3 つである。

- ラッパのキーは何によって「ラッパのもの」と判定されるか
- 剥がした後に何が残り、それがどう mysql2 に届くか
- `monitoring_` などの接頭辞付きキーは誰がいつ剥がすか

## 主要な型とその関係

### `WrapperProperty<T>`

[`common/lib/wrapper_property.ts#L227`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L227)。

```ts title="common/lib/wrapper_property.ts"
export class WrapperProperty<T> {
  name: string;
  description: string;
  defaultValue: any;
  allowedValues?: T[];

  get(props: Map<string, any>): T {
    const val = props.get(this.name);
    if (val === undefined && this.defaultValue !== undefined) {
      return this.defaultValue;
    }
    if (val != null && this.allowedValues?.length > 0) {
      if (!this.allowedValues.includes(val)) {
        throw new AwsWrapperError(
          Messages.get(
            "WrapperProperty.invalidValue",
            String(val),
            this.name,
            this.allowedValues.join(", "),
          ),
        );
      }
    }
    return val;
  }

  set(props: Map<string, any>, val: T) {
    /* 同じ検証をして props.set */
  }
}
```

`get(props)` が読み方の全てで、ラッパのコードは `props.get("wrapperQueryTimeout")` とは書かず `WrapperProperties.WRAPPER_QUERY_TIMEOUT.get(props)` と書く。既定値の適用と `allowedValues` の検証がここに集まる。検証は `get` のたびに走るので、不正な値を書いても**読まれるまで**例外にならない。

### `WrapperProperties`: 約 100 個の静的フィールド

[`#L265`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L265) から 550 行。骨格に関わるものだけ抜くとこうなる。

| フィールド                       | キー                           | 既定値                         | 読む場所                                          |
| -------------------------------- | ------------------------------ | ------------------------------ | ------------------------------------------------- |
| `PLUGINS`                        | `plugins`                      | `DEFAULT_PLUGINS`              | `ConnectionPluginChainBuilder`                    |
| `AUTO_SORT_PLUGIN_ORDER`         | `autoSortWrapperPluginOrder`   | `true`                         | 同上                                              |
| `DIALECT`                        | `dialect`                      | `null`                         | `DatabaseDialectManager`                          |
| `CUSTOM_DATABASE_DIALECT`        | `customDatabaseDialect`        | `null`                         | 同上                                              |
| `CONNECTION_PROVIDER`            | `connectionProvider`           | `null`                         | `ServiceUtils`                                    |
| `WRAPPER_CONNECT_TIMEOUT`        | `wrapperConnectTimeout`        | `10000`                        | `MySQL2DriverDialect.setConnectTimeout`           |
| `WRAPPER_QUERY_TIMEOUT`          | `wrapperQueryTimeout`          | `20000`                        | `ClientUtils.queryWithTimeout`、`setQueryTimeout` |
| `INTERNAL_QUERY_TIMEOUT`         | `mysqlQueryTimeout` (非推奨)   | `20000`                        | `ClientUtils.queryWithTimeout`                    |
| `KEEPALIVE_PROPERTIES`           | `wrapperKeepAliveProperties`   | `null`                         | `MySQL2DriverDialect.setKeepAliveProperties`      |
| `CLUSTER_ID`                     | `clusterId`                    | `"1"`                          | `RdsHostListProvider`                             |
| `PROFILE_NAME`                   | `profileName`                  | `null`                         | `AwsClient` (MySQL では例外)                      |
| `MONITORING_CONNECTION_PRIORITY` | `monitoringConnectionPriority` | `"strict-writer"`、許容値 3 つ | `ClusterTopologyMonitor`                          |

`user` / `password` / `database` / `port` / `host` も `WrapperProperty` として定義されている。mysql2 と共有するキーだが、ラッパも `HostInfo` を組むために読むので、ここに載っている。

### `AwsClientConfig`: 型としての写し

[`#L24`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L24)。3.0.0 で `AwsMySQLClient` のコンストラクタ引数が `any` から `AwsMySQLClientConfig = ConnectionOptions & AwsClientConfig` になった。`AwsClientConfig` は `WrapperProperties` の各キーを optional なフィールドとして手書きしたもので、同期は単体テスト ([`tests/unit/aws_client_config.test.ts`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/tests/unit/aws_client_config.test.ts)) が TypeScript のコンパイラ API でソースを読んで「全 `WrapperProperty` が `AwsClientConfig` にあるか」「逆に余分なキーがないか」を確かめている。

`ConnectionOptions` は mysql2 の型なので、`ssl` や `timezone` のような mysql2 のキーもコンパイル時に検証される。

## 処理の流れ

### 入口: `config` → `Map`

```ts title="common/lib/aws_client.ts#L72"
this.properties = new Map<string, any>(Object.entries(config));
```

`Object.entries` なので、`undefined` を値に持つキーも `Map` に入る。`WrapperProperty.get` は `val === undefined` なら既定値を返すので、`{ wrapperQueryTimeout: undefined }` は未設定と同じになる。ただし `removeWrapperProperties` 後の mysql2 側には `undefined` のまま渡る。

この `Map` は `AwsClient.properties` として `readonly` に保持され、`PluginService.props`、`PluginManager.props`、各プラグインの `properties` に**同じ参照**で渡る。誰かが `set` すれば全員に見える。iam プラグインが `password` にトークンを書き込むのはこの共有性に乗っている。

### 出口: `removeWrapperProperties`

[`#L820`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L820)。

```ts title="common/lib/wrapper_property.ts"
static removeWrapperProperties(props: Map<string, any>): Map<string, any> {
  const persistingProperties = [
    WrapperProperties.USER.name,
    WrapperProperties.PASSWORD.name,
    WrapperProperties.DATABASE.name,
    WrapperProperties.PORT.name,
    WrapperProperties.HOST.name
  ];

  const copy = new Map(props);

  for (const key of props.keys()) {
    if (!WrapperProperties.startsWithPrefix(key)) {
      continue;
    }
    copy.delete(key);
  }

  Object.values(WrapperProperties).forEach((prop) => {
    if (prop instanceof WrapperProperty) {
      const propertyName = (prop as WrapperProperty<any>).name;
      if (!persistingProperties.includes(propertyName) && copy.has(propertyName)) {
        copy.delete(propertyName);
      }
    }
  });

  return copy;
}
```

2 段で剥がす。

1. **接頭辞** `monitoring_` / `topology_monitoring_` / `blue_green_monitoring_` で始まるキー
2. **`WrapperProperties` の静的フィールドのうち `WrapperProperty` であるものの `name`**、ただし `user` / `password` / `database` / `port` / `host` は残す

「ラッパのキーかどうか」の判定は**`WrapperProperties` クラスに静的フィールドとして定義されているか**である。ホワイトリストもブラックリストも別に持たず、定義そのものがリストになっている。`Object.values(クラス)` が静的フィールドを列挙できるのは、TypeScript の `static readonly` がクラス関数の own enumerable property になるからで、`DEFAULT_PLUGINS` のような文字列定数は `instanceof WrapperProperty` で弾かれる。

残った `Map` が `Object.fromEntries` で mysql2 の `createConnection` に渡る ([2 種類の Dialect](../two-dialects/))。mysql2 は未知のキーを警告するので、ラッパのキーが 1 つでも漏れると `Ignoring invalid configuration option passed to Connection` が出る。逆に、**ラッパが知らないキーは全部 mysql2 に届く**。`ssl` / `timezone` / `charset` / `enableKeepAlive` / `namedPlaceholders` などはラッパを素通りする。

呼ぶのは `MySQL2DriverDialect.connect` と `preparePoolClientProperties` の 2 か所で、どちらも「mysql2 にオブジェクトを渡す直前」である。

### 接頭辞: 監視接続だけ設定を変える

```ts title="common/lib/wrapper_property.ts#L266"
static readonly MONITORING_PROPERTY_PREFIX: string = "monitoring_";
static readonly TOPOLOGY_MONITORING_PROPERTY_PREFIX: string = "topology_monitoring_";
static readonly BG_MONITORING_PROPERTY_PREFIX: string = "blue_green_monitoring_";
```

`monitoring_wrapperQueryTimeout: 3000` のように書くと、EFM の監視接続にだけ `wrapperQueryTimeout = 3000` が効く。接頭辞を剥がして自分の `props` に写すのは各モニタの責務である。

| 接頭辞                   | 剥がす場所                                                                                                                                                                                                                                                                                                                                                                                                                      | 対象の接続                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `monitoring_`            | [`efm/base/host_monitor.ts#L203`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/efm/base/host_monitor.ts#L203)、[`fastest_response/host_response_time_monitor.ts#L153`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/strategy/fastest_response/host_response_time_monitor.ts#L153) | EFM の生死判定、応答時間計測 |
| `topology_monitoring_`   | [`cluster_topology_monitor.ts#L147`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/host_list_provider/monitoring/cluster_topology_monitor.ts#L147)                                                                                                                                                                                                                | トポロジクエリ               |
| `blue_green_monitoring_` | [`blue_green_status_provider.ts#L136`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/bluegreen/blue_green_status_provider.ts#L136)                                                                                                                                                                                                                        | Blue/Green 状態監視          |

`host_monitor.ts` の例。

```ts title="common/lib/plugins/efm/base/host_monitor.ts"
const monitoringConnProperties = new Map(this.properties);
for (const key of monitoringConnProperties.keys()) {
  if (!key.startsWith(WrapperProperties.MONITORING_PROPERTY_PREFIX)) {
    continue;
  }
  monitoringConnProperties.set(
    key.substring(WrapperProperties.MONITORING_PROPERTY_PREFIX.length),
    this.properties.get(key),
  );
  monitoringConnProperties.delete(key);
}
this.monitoringClient = await this.pluginService.forceConnect(
  this.hostInfo,
  monitoringConnProperties,
);
```

コピーを作り、接頭辞付きキーを**接頭辞なしのキーに上書き**して、接頭辞付きのほうを消す。アプリの接続用 `Map` は変わらない。この `Map` で `forceConnect` するので、監視接続は「アプリと同じ設定 + `monitoring_` で上書きした分」になる。

アプリの接続側では、接頭辞付きキーは `removeWrapperProperties` の 1 段目で剥がされる。だから `monitoring_ssl` のような **mysql2 のキーに接頭辞を付けたもの**も動く。監視接続では `ssl` に写され、アプリの接続では消える。

### タイムアウト 3 種の行き先

| キー                            | 行き先                                               | 意味                                  |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| `wrapperConnectTimeout` (10000) | mysql2 `connectTimeout`                              | TCP 接続 + ハンドシェイクの上限       |
| `wrapperQueryTimeout` (20000)   | `ClientUtils.queryWithTimeout` の `Promise.race`     | アプリのクエリの壁時計                |
| 同上                            | 内部クエリの `{ sql, timeout }`                      | ラッパ内部クエリの inactivity timeout |
| `mysqlQueryTimeout` (非推奨)    | `queryWithTimeout` で `wrapperQueryTimeout` より優先 | 1.1.0 以前の名前                      |

`wrapperConnectTimeout` は `MySQL2DriverDialect.setConnectTimeout` で mysql2 の `connectTimeout` に写される。mysql2 の既定は 10000 なので、書かなくても値は同じである。

## 守られている不変条件

- **mysql2 に渡る `Map` には `WrapperProperty` の `name` が (5 つを除き) 含まれない。** 新しい `WrapperProperty` を `WrapperProperties` に足せば自動で剥がされる。剥がし忘れが起きるのは、接頭辞なしで `WrapperProperties` の外に定義したキーだけ
- **`properties` の参照は 1 つ。** `AwsClient` / `PluginService` / `PluginManager` / 各プラグイン / `HostListProvider` が同じ `Map` を見る。`removeWrapperProperties` と接頭辞の剥がしは必ず**コピー**に対して行い、元は変えない
- **`allowedValues` の検証は `get` / `set` の両方で走る。** `monitoringConnectionPriority: "writer"` のような値は、読まれた時点で `invalidValue` になる

## つまずきどころ

- **ラッパのキーを間違えると mysql2 に渡る。** `wraperQueryTimeout` (typo) は `WrapperProperties` にないので剥がされず、mysql2 が `Ignoring invalid configuration option` を警告する。3.0.0 の型付きコンストラクタなら TypeScript が弾くが、`as any` で渡すと素通りする
- **`removeWrapperProperties` は `Object.values(WrapperProperties)` を毎回走査する。** 約 100 個の `instanceof` を接続のたびに行うが、接続は頻繁ではないので問題にならない。ただし `AwsMySQLPoolClient.query()` はクエリごとに接続手順を踏むので、そこでは毎クエリ走る
- **`monitoring_` を付けないと監視接続もアプリと同じ `wrapperQueryTimeout` (20 秒) を待つ。** EFM の `failureDetectionInterval` (5 秒) より長いので、`SELECT 1` が固まると次の判定まで 20 秒かかる。`monitoring_wrapperQueryTimeout` を短くするのが定石
- **`properties` を後から `client.properties.set(...)` で書き換えても、すでに張った接続には効かない。** mysql2 のオプションは `createConnection` 時に固定される。効くのはフェイルオーバー後の再接続からである
- **`profileName` の処理 (`aws_client.ts#L76`) は MySQL では例外になるが、そのコードは `properties` にプロファイル値を「ユーザ設定が優先」でマージする作りになっている。** PG 向けのロジックが `AwsClient` に残っている、と読んでおけばよい
