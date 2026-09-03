---
title: "AwsMySQLPoolClient — 外部プールの正体"
description: "mysql2 の createPool を置き換える AwsMySQLPoolClient は 45 行しかない。中身は前のページの InternalPooledConnectionProvider を既定 provider として持ち、getConnection() と query() のたびに AwsMySQLPooledConnection (= PluginManager + PluginService + プラグイン一式) を新しく作る。mysql2 の pool.query() と何が同じで何が違うのか、毎回組み立てるコストと、プロセス全体に残るものを読む。"
group: "接続を差し替えても壊れないようにする"
sidebar:
  order: 57
---

## 何を学んだか

`AwsMySQLPoolClient` は 2.0.0 で入った「mysql2 の `createPool` 互換」の入口である。`pool.getConnection()` と `pool.query()` が使える。

- 本体は **45 行**で、`InternalPooledConnectionProvider` を**コンストラクタ引数の既定 provider** として持つ。前のページの `connectionProvider` プロパティ経由とは渡し方が違い、`acceptsUrl` を通らないので**クラスタエンドポイントもプールされる**
- `getConnection()` も `query()` も、呼ぶたびに **`AwsMySQLPooledConnection` を新しく作って `connect()` する**。`AwsMySQLPooledConnection` は `AwsMySQLClient` と同じ基底クラスなので、`PluginManager` / `PluginService` / プラグイン一式 / ホストリストプロバイダが毎回組み立てられる
- `query()` は `connect → query → end` を 1 関数で行い、**`FailoverSuccessError` のときだけ `end()` しない**
- `end()` は `provider.releaseResources()` で、static なプール集合を**全部**閉じる
- mysql2 の `pool.query()` は read-only エラー (errno 1290 / 1836 / 1792) を見て接続を `destroy` する。mysql2 自身が Aurora のフェイルオーバーを 1 行だけ知っている

## ソースコードのどこか

### 45 行の全体

[`mysql/lib/client.ts#L613`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L613)。

```ts title="mysql/lib/client.ts"
export class AwsMySQLPoolClient implements MySQLPoolClient {
  private readonly connectionProvider: InternalPooledConnectionProvider;
  private readonly config: AwsMySQLClientConfig;
  private readonly poolConfig?: AwsPoolConfig;

  constructor(config: AwsMySQLClientConfig, poolConfig?: AwsPoolConfig) {
    this.connectionProvider = new InternalPooledConnectionProvider(poolConfig);
    this.config = config;
    this.poolConfig = poolConfig;
  }

  async end(): Promise<void> {
    await this.connectionProvider.releaseResources();
  }

  async getConnection(): Promise<AwsMySQLPooledConnection> {
    const client = new AwsMySQLPooledConnection(this.config, this.connectionProvider);
    await client.connect();
    return client;
  }

  releaseConnection(connection: AwsMySQLPooledConnection): Promise<void> {
    return connection.end();
  }

  async query(options: string | QueryOptions, values?: any): Promise<[any, any]> {
    const awsMySQLPooledConnection: AwsMySQLPooledConnection = new AwsMySQLPooledConnection(
      this.config,
      this.connectionProvider,
    );
    try {
      await awsMySQLPooledConnection.connect();
      const res = await awsMySQLPooledConnection.query(options as any, values);
      await awsMySQLPooledConnection.end();
      return res;
    } catch (error: any) {
      if (!(error instanceof FailoverSuccessError)) {
        // Release pooled connection.
        await awsMySQLPooledConnection.end();
      }
      throw error;
    }
  }
}
```

`poolConfig` フィールドは保持されるだけで、コンストラクタで provider に渡した後は誰も読まない。

### `AwsMySQLPooledConnection` — `AwsMySQLClient` との違いは 1 メソッド

[L589](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L589)。

```ts title="mysql/lib/client.ts"
export class AwsMySQLClient extends BaseAwsMySQLClient {
  constructor(config: AwsMySQLClientConfig) {
    super(config, new DriverConnectionProvider());
  }
}

class AwsMySQLPooledConnection extends BaseAwsMySQLClient {
  constructor(config: AwsMySQLClientConfig, provider: ConnectionProvider) {
    super(config, provider);
  }

  async release(): Promise<void> {
    return this.pluginManager.execute(
      this.pluginService.getCurrentHostInfo(),
      this.properties,
      "release",
      async () => {
        if (!this.targetClient) {
          throw new UndefinedClientError();
        }
        this.pluginService.removeErrorListener(this.targetClient);
        return await ClientUtils.queryWithTimeout(this.targetClient.end(), this.properties);
      },
      null,
    );
  }
}
```

`AwsMySQLClient` と `AwsMySQLPooledConnection` の違いは、基底に渡す `ConnectionProvider` が `DriverConnectionProvider` か `InternalPooledConnectionProvider` かだけである。`release()` は `end()` とほぼ同じだが、`isConnected = false` / `targetClient = undefined` を**しない**。`release()` した後にもう一度 `query()` すると、`isConnected` が true のままなので自動 `connect()` は走らず、プールに返した `targetClient` をそのまま使ってしまう。`end()` ([L196](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L196)) は両方を落とすので、`releaseConnection()` が `end()` を呼んでいるのは正しい。

### 既定 provider として渡す — `acceptsUrl` を通らない

`BaseAwsMySQLClient` のコンストラクタは provider を `AwsClient` に渡し、`ServiceUtils` が `ConnectionProviderManager(defaultProvider, effectiveProvider)` を組む ([`service_utils.ts#L67`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/service_utils.ts#L67))。

```ts title="common/lib/utils/service_utils.ts"
new ConnectionProviderManager(connectionProvider ?? new DriverConnectionProvider(), WrapperProperties.CONNECTION_PROVIDER.get(props)),
```

第 1 引数が `defaultProvider`、第 2 引数 (`connectionProvider` プロパティ) が `effectiveProvider` である。`getConnectionProvider` は effective の `acceptsUrl` が true のときだけ effective を返し、それ以外は **default を無条件に**返す ([`connection_provider_manager.ts#L34`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/connection_provider_manager.ts#L34))。

`AwsMySQLPoolClient` は provider を default 側に置くので、`acceptsUrl` (`RDS_INSTANCE` 判定) は**呼ばれない**。`host` にクラスタエンドポイントを書けば、そのクラスタエンドポイントをキーにした mysql2 Pool ができる。前のページで「クラスタエンドポイントはプールしない」と書いたのは effective 側の話で、外部プールは逆である。docs の "creates a pool for the initial connection endpoint" はこれを指す。

クラスタエンドポイントをプールすると、フェイルオーバー後にプール内の既存接続は旧 writer (降格して reader) を指す。それを掴んだ `query()` が書き込みなら read-only エラーになり、failover2 が strict-writer なら差し替えを試みる ([failover-triggers](../failover-triggers/))。プール自体は `initialConnection` プラグインが張り直す新しい接続を、同じキーの同じプールに追加していく。

### `query()` のたびに組み立てられるもの

`new AwsMySQLPooledConnection(config, provider)` → `BaseAwsMySQLClient` → `AwsClient` のコンストラクタ ([`aws_client.ts#L60`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/aws_client.ts#L60)) で、`ServiceUtils.createStandardServiceContainer` が `PluginService` と `PluginManager` を作る。続く `connect()` → `internalConnect()` ([L138](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/aws_client.ts#L138)) で次が走る。

1. `telemetryFactory.init()`
2. `pluginManager.init()` → `ConnectionPluginChainBuilder.getPlugins` で**プラグインを全部 new** し、`PluginManager.PLUGINS` (static Set) に追加
3. `dialect.getHostListProvider()` で `RdsHostListProvider` などを new
4. `refreshHostList()` (キャッシュが新しければトポロジクエリは飛ばない)
5. `initHostProvider` パイプライン
6. `pluginManager.connect()` → 各プラグインの `connect` → `DefaultPlugin` → provider → mysql2 の `pool.getConnection()`
7. `getHostRole()` で役割確認、`setCurrentClient`、`internalPostConnect()` で再度 `refreshHostList()`

mysql2 の `pool.query()` が `getConnection` → `query` → `release` の 3 手であるのに対し、こちらは 1 クエリあたり上の 7 段が毎回走る。物理接続は使い回されるが、**ラッパのオブジェクトグラフは毎回使い捨て**である。

そして 2 の `PluginManager.PLUGINS` は、`init` で追加されるが**個別の client では削除されない** ([`plugin_manager.ts#L111`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_manager.ts#L111))。

```ts title="common/lib/plugin_manager.ts"
private static PLUGINS: Set<ConnectionPlugin> = new Set();

async init(configurationProfile: ConfigurationProfile | null, plugins?: ConnectionPlugin[]) {
  // ...
  for (const plugin of this._plugins) {
    PluginManager.PLUGINS.add(plugin);
  }
}

static async releaseResources() {
  for (const plugin of PluginManager.PLUGINS) {
    if (PluginManager.implementsCanReleaseResources(plugin)) {
      await plugin.releaseResources();
    }
  }
  PluginManager.STRATEGY_PLUGIN_CHAIN_CACHE.clear();
  await CoreServicesContainer.releaseResources();
  PluginManager.PLUGINS = new Set();
}
```

`PLUGINS` から要素が消えるのは `releaseResources()` で Set ごと作り直すときだけである。プラグインは `PluginService` への参照を持ち、`PluginService` は `AwsClient` への参照を持つので、`pool.query()` を 1 回呼ぶごとに **`AwsMySQLPooledConnection` 一式 (既定なら 5 プラグイン分) が static Set 経由で GC されずに残る**。コード上、`pool.query()` を長時間回すプロセスではこの Set が単調に増える。

### `FailoverSuccessError` のときだけ `end()` しない

`query()` の `catch` は、`FailoverSuccessError` 以外なら `end()` してから投げ直す。`FailoverSuccessError` のときは `end()` を飛ばす。この分岐の理由はコードにも docs にも CHANGELOG にも書かれていない。

読み取れる帰結だけを書く。failover2 が成功した時点で、`AwsMySQLPooledConnection.targetClient` は**新しい接続**に差し替わっている。`end()` を呼べば `targetClient.end()` = `PoolClientWrapper.end()` = プールへ `release()` で、新しい接続はプールに戻る。呼ばなければ、その接続はプールから借りたまま誰にも返されず、`getActiveCount()` を 1 つ増やしたままになる。アプリ側は `pool.query()` の戻りとして `FailoverSuccessError` を受け取るだけで、この `AwsMySQLPooledConnection` オブジェクトには触れない。

### mysql2 の `pool.query()` は何をしているか

比較のために mysql2 側を見る ([`lib/base/pool.js#L215`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/base/pool.js#L215))。

```js title="lib/base/pool.js"
// 1792: ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
// 1290: ER_OPTION_PREVENTS_STATEMENT (returned by Aurora during failover)
// 1836: ER_READ_ONLY_MODE
function isReadOnlyError(err) { /* errno が上の 3 つか */ }

query(sql, values, cb) {
  const cmdQuery = BaseConnection.createQuery(sql, values, cb, this.config.connectionConfig);
  this.getConnection((err, conn) => {
    if (err) { /* cmdQuery にエラーを流す */ return; }
    let queryError = null;
    // (onResult / error で queryError を記録)
    conn.query(cmdQuery).once('end', () => {
      if (isReadOnlyError(queryError)) {
        conn.destroy();
      } else {
        conn.release();
      }
    });
  });
  return cmdQuery;
}
```

`getConnection` → `conn.query` → `release` の 3 手で、ラッパのような組み立ては何もない。注目すべきは `isReadOnlyError` で、コメントに **"returned by Aurora during failover"** とある。mysql2 自身が「read-only エラーが返ったら、その接続は降格した旧 writer なので捨てる」という Aurora 固有の対処を 1 つだけ持っている。`release` せず `destroy` するので、次の `getConnection` は新しい接続を張り、DNS が更新されていれば新 writer に届く。

これは「接続を捨てて DNS に賭ける」戦略で、ラッパの「トポロジを SQL で聞いて、新 writer のインスタンスエンドポイントに張り直す」戦略とは前提が違う。mysql2 は DNS の更新を待つしかなく、その間の `getConnection` は旧 writer に繋がり続ける。

### パラメータ対応表

`UsingTheConnectionPool.md` にある mysql2 との対応をそのまま引く。

| mysql2 `createPool`  | `AwsPoolConfig`      | 既定             | 備考                         |
| -------------------- | -------------------- | ---------------- | ---------------------------- |
| `connectionLimit`    | `maxConnections`     | 10               |                              |
| `maxIdle`            | `maxIdleConnections` | `maxConnections` |                              |
| `idleTimeout`        | `idleTimeoutMillis`  | 60000            |                              |
| `waitForConnections` | `waitForConnections` | true             |                              |
| `queueLimit`         | `queueLimit`         | 0                | 0 は無制限                   |
| `timeout`            | 非対応               |                  | `wrapperQueryTimeout` で代替 |
| `reconnect`          | 非対応               |                  | failover プラグインが代替    |

接続側の設定 (`host` / `user` / `password` / `wrapperQueryTimeout` など) は第 1 引数、プール側は第 2 引数の `AwsPoolConfig` に分けて渡す。mysql2 は 1 つのオブジェクトに混ぜて渡す。

## なぜそうなっているか

### なぜ毎回 client を組み立てるのか

ラッパの状態 (現在の接続、セッション状態、トランザクション中か) は `PluginService` に、プラグインの状態 (failover の `_isInTransaction`、readWriteSplitting の reader キャッシュ) は各プラグインインスタンスに紐づいていて、それらは**1 つの論理接続に 1 組**という前提で書かれている。プールの物理接続を複数の論理接続で共有するには、論理接続のたびに一式を作るのがいちばん安全である。既存の `AwsMySQLClient` の構造を変えずに `pool.query()` を足すなら、この形しかない。

代償が組み立てコストと、static `PLUGINS` への蓄積である。前者は物理接続の再利用で相殺されることが多いが、後者は `releaseResources()` を呼ぶまで解消しない。

### なぜ `InternalPooledConnectionProvider` を再利用するのか

インスタンスごとのプールという概念と、プールをキーで引く仕組みは、2.0.0 より前から readWriteSplitting 用に存在した。外部プールは「キーに初回接続の URL を使う」だけでそれに乗れる。`acceptsUrl` を迂回するために default 側に置いたのは、既存の `ConnectionProviderManager` を変えずに済む最短経路である。

### なぜ `release()` と `end()` を分けているのか

mysql2 の `PoolConnection` は `release()` (プールに返す) と `end()` (閉じる) を区別し、`end()` を呼ぶと deprecated 警告を出して `release()` にフォールバックする ([`lib/pool_connection.js#L35`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/pool_connection.js#L35))。ラッパ側で `release()` を用意したのは、mysql2 の API 名に合わせるためである。ただし中身は `targetClient.end()` で、`PoolClientWrapper.end()` は `release()` なので、最終的には同じところに落ちる。

## どう活かすか

- **互換 API は「見た目」と「コスト」を分けて説明する。** `pool.query()` は mysql2 と同じ 1 行で書けるが、裏で走るものは 7 段違う。互換を名乗るなら、コストの差を docs に書く
- **static な集合に追加するなら、削除の経路を同じコミットで書く。** `PLUGINS.add` に対応する `delete` がないのは、長時間プロセスで効いてくる。`WeakRef` か `FinalizationRegistry` か、client の `end()` で外すか、どれかは要る
- **例外の種類で後処理を変えるなら、理由をコメントに残す。** `FailoverSuccessError` だけ `end()` しない分岐は、意図が読めないと直せない。「なぜ」の 1 行が将来の修正コストを決める
- **ドライバが既に持っている対処を知っておく。** mysql2 の `isReadOnlyError` → `destroy` は、ラッパを使わない構成でも Aurora のフェイルオーバーを「接続の捨て直し」で乗り切る最小の仕組みである。ラッパが足しているのは、その先の「どこに張り直すか」である

### 実務で踏む失敗パターン

- **`pool.query()` を高頻度で回すとメモリが増える。** `PluginManager.PLUGINS` に一式が残る。定期的に `PluginManager.releaseResources()` を呼ぶ (ただしそれは全プラグイン・全モニタも止める) か、`getConnection()` で取った接続を使い回す
- **`pool.end()` で他のプールも閉じた。** `InternalPooledConnectionProvider.databasePools` は static で、`releaseResources()` は全部を `clear()` する。複数の `AwsMySQLPoolClient` を作る構成では、1 つの `end()` が他を巻き込む
- **`release()` した接続で `query()` したら、返却済みの接続を使った。** `release()` は `isConnected` を落とさない。返した接続は使わない
- **クラスタエンドポイントをプールしていて、フェイルオーバー後に古い接続を掴む。** これは外部プールの設計上の前提で、failover2 (strict-writer) と `initialConnection` が拾い直す。read-only エラーを即座に例外として受け取りたくないなら、`failoverMode` を確認する ([failoverMode](../failover-mode/))
- **`maxConnections` 個の `getConnection()` を返さずに `pool.query()` を呼ぶと止まる。** mysql2 の `waitForConnections=true` + `queueLimit=0` で無期限待ち。docs の Common Pitfalls どおり
