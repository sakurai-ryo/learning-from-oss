---
title: "何をトリガとするか"
description: "shouldErrorTriggerClientSwitch は 4 段の判定である。failover が有効か、EFM の UnavailableHostError か、MySQLErrorHandler が文字列一致で network error と言うか、strict-writer なら read-only エラー (errno 1290 / 1836) か。6 つの文字列が mysql2 のどこで作られているか、そして errno がラッパの例外に引き継がれない経路を読む。mysql2 PoolCluster が接続取得の失敗しか数えないこととの対比も置く。"
group: "フェイルオーバー"
sidebar:
  order: 34
---

## 何を学んだか

フェイルオーバーは「例外が起きたら」始まるのではなく、「**接続を切り替えるべき例外**が起きたら」始まる。その判定は `shouldErrorTriggerClientSwitch` の 20 行にあり、4 段で構成されている。

1. failover が有効でなければ何もしない
2. EFM が投げる `UnavailableHostError` なら切り替える
3. [`MySQLErrorHandler.isNetworkError`](../mysql-error-handler/) が true なら切り替える。判定は **6 つの文字列との `includes`** である
4. `strict-writer` モードのときだけ、read-only エラー (MySQL errno 1290 / 1836) でも切り替える

3 の文字列は mysql2 のソースにベタ書きされた文言であり、4 の errno は mysql2 の生エラーには付いているが、`query()` 経路でラッパが被せる `AwsWrapperError` には引き継がれない。この 2 点が、この判定の壊れやすさである。

## ソースコードのどこか

### shouldErrorTriggerClientSwitch

[`failover2_plugin.ts#L480`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L480)。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
private shouldErrorTriggerClientSwitch(error: any): boolean {
  if (!this.isFailoverEnabled()) {
    logger.debug(Messages.get("Failover.failoverDisabled"));
    return false;
  }

  if (error instanceof UnavailableHostError) {
    return true;
  }

  if (error instanceof Error) {
    if (this.pluginService.isNetworkError(error)) {
      return true;
    }
    // A demoted writer returns read-only errors on writes, which must trigger failover.
    if (this.failoverMode === FailoverMode.STRICT_WRITER) {
      return this.pluginService.isReadOnlyConnectionError(error);
    }
  }

  return false;
}
```

`UnavailableHostError` は [efm (v1)](../efm-v1-vs-v2/) の `host_monitoring_connection_plugin.ts` が、監視で不健全と判定したホストの接続を `abort` した後に投げる ([`#L135`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/efm/v1/host_monitoring_connection_plugin.ts#L135))。EFM のほうが plugin chain で failover2 より後ろ (weight 800 / 810 > 710) にいるので、EFM が投げた例外は failover2 の `catch` に上がってくる。

`isNetworkError` と `isReadOnlyConnectionError` は `PluginService` を経由して現在の [DatabaseDialect](../two-dialects/) の `ErrorHandler` に委譲される ([`plugin_service.ts#L717`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L717))。MySQL 系の Dialect は全部 `MySQLErrorHandler` を返す。

### 6 つの文字列

[`mysql/lib/mysql_error_handler.ts#L49`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/mysql_error_handler.ts#L49)。

```ts title="mysql/lib/mysql_error_handler.ts"
isNetworkError(e: Error): boolean {
  return (
    e.message.includes("Connection lost: The server closed the connection.") ||
    e.message.includes("Query inactivity timeout") ||
    e.message.includes("Can't add new command when connection is in closed state") ||
    e.message.includes(Messages.get("ClientUtils.queryTaskTimeout")) ||
    // Pooled connection network errors
    e.message.includes("connect ETIMEDOUT") ||
    e.message.includes("connect ECONNREFUSED")
  );
}
```

それぞれの出所を mysql2 側で確認しておく。

| 文字列                                                     | 作られる場所                                                                                                                                                                                                                            | いつ起きるか                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Connection lost: The server closed the connection.`       | [`lib/base/connection.js#L120`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/base/connection.js#L120)。ソケットの `close` で、他にエラーがなければこれを作る (`PROTOCOL_CONNECTION_LOST`) | writer が落ちて TCP が閉じた                                                         |
| `Query inactivity timeout`                                 | [`lib/commands/query.js#L350`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/commands/query.js#L350)。クエリ単位の `timeout` オプションが切れた                                            | ホストが応答しなくなった (TCP は生きているように見える)                              |
| `Can't add new command when connection is in closed state` | [`lib/base/connection.js#L202`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/base/connection.js#L202)。致命的エラー後、`addCommand` がこれに差し替わる                                    | 既に死んだ接続で `query()` した                                                      |
| `ClientUtils.queryTaskTimeout` のメッセージ                | ラッパ自身 ([`client_utils.ts`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/client_utils.ts))。`wrapperQueryTimeout` (既定 20 秒) の `Promise.race` に負けた      | mysql2 のタイムアウトを設定していなくても、ラッパが自前で見切る                      |
| `connect ETIMEDOUT` / `connect ECONNREFUSED`               | Node.js の `net` モジュール。mysql2 はそのまま通す                                                                                                                                                                                      | 接続確立そのものが失敗した。コメントにあるとおり内部プール経由で新規接続する経路向け |

`isNetworkError` は `code` も `errno` も見ない。mysql2 は `PROTOCOL_CONNECTION_LOST` のような `code` を付けるものと付けないもの (closed state のエラーには `code` がない) が混在していて、メッセージのほうが揃っている、という判断だと読める。

### read-only エラーと errno

[`mysql_error_handler.ts#L73`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/mysql_error_handler.ts#L73)。

```ts title="mysql/lib/mysql_error_handler.ts"
protected static readonly READ_ONLY_ERROR_CODES = [1290, 1836];

isReadOnlyConnectionError(e: Error): boolean {
  if (Object.prototype.hasOwnProperty.call(e, "errno")) {
    // @ts-ignore
    return MySQLErrorHandler.READ_ONLY_ERROR_CODES.includes(e["errno"]);
  }
  return false;
}
```

1290 は `ER_OPTION_PREVENTS_STATEMENT` (`The MySQL server is running with the --read-only option so it cannot execute this statement`)、1836 は `ER_READ_ONLY_MODE` である。旧 writer が reader に降格した後も TCP 接続は生きているので、network error にはならない。書き込みを投げて初めてこのエラーで返る。それを「writer が変わった」の合図として使う、というのが CHANGELOG 3.0.0 の "Failover is now triggered by read-only connection errors when using `strict-writer` failover mode" である。

ただし、この判定は **own property の `errno`** を見る。`AwsMySQLClient.query()` は mysql2 の `query()` を `ClientUtils.queryWithTimeout` で包み、そこで例外は `new AwsWrapperError(error.message, error)` に作り直される ([`client_utils.ts`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/client_utils.ts))。`AwsWrapperError` が持つのは `message` / `name` / `cause` だけで ([`errors.ts#L19`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/errors.ts#L19))、`errno` はコピーされない。`cause` を読み戻す箇所はコードベースのどこにもない。したがって `query()` 経路で failover2 の `catch` に届く例外に `errno` はなく、`isReadOnlyConnectionError` は false を返す。

単体テストは `errorWith({ errno: 1290 })` を直接 `MySQLErrorHandler` に渡すもの (`tests/unit/error_handler.test.ts`) と、`isReadOnlyConnectionError` をモックで true にしてプラグインの分岐を見るもの (`tests/unit/failover2_plugin.test.ts#L328`) に分かれていて、`query()` から通しで確認するテストはない。**メッセージ文字列で判定する `isNetworkError` はこの経路でも動くが、errno で判定する read-only は動かない**、というのがコードから読める状態である。

### PoolCluster は何を見ているか

mysql2 自身の `PoolCluster` にもノードを外す仕組みはあるが、見ているのは**接続取得の失敗だけ**である ([`lib/pool_cluster.js#L347`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/pool_cluster.js#L347))。

```js title="lib/pool_cluster.js"
_getConnection(node, cb) {
  node.pool.getConnection((err, connection) => {
    if (err) {
      this._increaseErrorCount(node);
      return cb(err);
    }
    this._decreaseErrorCount(node);

    connection._clusterId = node.id;
    return cb(null, connection);
  });
}
```

`getConnection` が成功すれば errorCount を 1 減らし、失敗すれば 1 増やして `removeNodeErrorCount` (既定 5) でノードを削除する。**取得した接続でクエリが失敗しても数えない。** 降格した旧 writer は接続はできるので、永久に `MASTER` として選ばれ続け、書き込みのたびに 1290 で落ちる。ラッパが実行時の例外を分類しているのは、この穴を埋めるためである。全体の比較は [PoolCluster との比較](../vs-pool-cluster/) にまとめる。

## なぜそうなっているか

### なぜ「例外なら全部」ではないのか

構文エラーや制約違反でフェイルオーバーすると、正常な writer を `NOT_AVAILABLE` にして別ホストへ張り直しに行く。300 秒 (`failoverTimeoutMs` 既定) を待った挙げ句に `FailoverFailedError` になり、アプリは「構文エラー」ではなく「フェイルオーバー失敗」を見ることになる。切り替えていいのは「この接続の先にいるホストが、もう相手にならない」ときだけである。

### なぜ read-only は strict-writer のときだけか

`reader-or-writer` や `strict-reader` は、そもそも reader に繋がっている。reader で書き込んで 1290 を受け取るのは、アプリのバグであってフェイルオーバーの合図ではない。writer を追いかける契約のときだけ、「書けない = writer ではなくなった」が成り立つ。単体テストにも "read-only error does not trigger failover outside strict-writer mode" という名前で残っている。

### なぜ文字列一致なのか

mysql2 のエラーオブジェクトには、`code` が付くもの (`PROTOCOL_CONNECTION_LOST`、`PROTOCOL_SEQUENCE_TIMEOUT`) と付かないもの (closed state) がある。Node.js の `net` エラーは `code: "ETIMEDOUT"` のように別体系である。メッセージなら全部の経路で必ず存在するし、ラッパが `AwsWrapperError` に包み直しても `message` は引き継がれる。**包み直しを前提にすると、生き残る情報は `message` だけ**なので、判定はそこに寄せるしかなかった、と読める。errno による read-only 判定だけが、その前提から外れている。

## どう活かすか

- **リトライや切り替えの条件は「相手がもう相手にならない」に絞る。** 例外全部を対象にすると、正常系のエラーを障害に格上げしてしまう。分類関数を 1 つ置いて、そこにだけ条件を書く
- **例外を包み直すなら、判定に使うプロパティを引き継ぐ。** `cause` に入れるだけでは、`cause` を読む側がいなければ情報は消える。`errno` / `code` / `sqlState` のような機械可読の値は、包む側でコピーするか、判定側が `cause` を辿るかのどちらかを決めておく
- **文字列一致には出所のリンクを残す。** 依存ライブラリの文言変更で黙って壊れる。上の表のように「どのファイルの何行で作られるか」を記録しておくと、mysql2 を上げるときに diff で追える

### 実務で踏む失敗パターン

- **mysql2 を上げたらフェイルオーバーしなくなった。** `isNetworkError` の 6 文字列のどれかが mysql2 側で変わった可能性を最初に疑う。ラッパのバージョンと mysql2 の `peerDependencies` (`^3.22.3`) の範囲を合わせる
- **降格した writer に書き続けて 1290 が止まらない。** `strict-writer` でも、上記のとおり `query()` 経路では errno が届かない。頼れるのは [auroraConnectionTracker](../connection-tracker/) が writer 交代を検知して遊休接続を切ること、または [EFM](../why-efm/) が接続を abort して `UnavailableHostError` / network error に変えることである
- **RDS Proxy 越しでフェイルオーバーしない。** `isFailoverEnabled` が Proxy の URL を除外している。Proxy の裏で起きたフェイルオーバーは Proxy が吸収する設計なので、ラッパは意図的に手を出さない
