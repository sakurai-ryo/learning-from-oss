---
title: "PoolCluster と何が違うのか — 比較表で答える"
description: "mysql2 の PoolCluster は 375 行で、アプリが列挙したノードと接続取得の失敗回数だけで動く。ラッパの 28,000 行が足しているのは、DB に聞いたトポロジ、検証された役割、実行時エラーとプローブによる不健全判定、接続の差し替えと通知、セッション状態の転送、AWS の認証である。章の総括として、各行の根拠を該当ページに戻しながら比較表で答える。"
group: "横断"
sidebar:
  order: 75
---

## 何を学んだか

mysql2 は `lib/pool_cluster.js` という 375 行の「クラスタ対応」を持っている。ラッパはそれを使わない。使えないのではなく、解いている問題が違う。

PoolCluster が解くのは「複数のプールから、パターンとセレクタで 1 つ選ぶ」で、ノードが何者か、今も同じ役割か、DNS が正しいかは知らない。ラッパが解くのは「Aurora の writer が変わっても、アプリの接続が壊れないようにする」で、そのために DB に SQL でトポロジを聞き、役割を検証し、接続を差し替える。

この章で読んできたことを、PoolCluster と 1 行ずつ突き合わせると、ラッパが何を足しているのかがはっきりする。

## 比較表

| 観点                   | PoolCluster                                                            | ラッパ                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| トポロジの出所         | アプリが `add(id, config)` で列挙                                      | DB に SQL で聞く (`replica_host_status` / `rds_topology`)。[トポロジクエリ (Aurora)](../topology-query-aurora/)、[トポロジクエリ (Multi-AZ)](../topology-query-multi-az/)              |
| 役割 (writer / reader) | `MASTER` / `SLAVE1` は名前で、誰も検証しない                           | `@@innodb_read_only` で検証し、変化に追従する。[「自分は writer か」を全ホストに聞く](../am-i-a-writer/)                                                                               |
| 不健全の判定           | 接続取得の失敗回数のみ。実行時エラーは数えない                         | EFM のプローブ + 実行時エラーの文字列分類。[何をトリガとするか](../failover-triggers/)、[HostMonitor](../host-monitor/)                                                                |
| 落ちたノードの扱い     | 5 回で削除 (既定は恒久)、`restoreNodeTimeout` 指定時だけ一時オフライン | `NOT_AVAILABLE` をキャッシュに書き、5 分期限で復帰。exponentialBackoff 戦略の計数はトポロジモニタ経由でしか動かない。[ホスト可用性戦略と選択戦略](../host-availability-and-selection/) |
| 昇格後の書き込み先     | 旧 `MASTER` に送り続ける                                               | 新 writer へ接続を差し替え、`FailoverSuccessError` で通知する。[failover2 の writer フェイルオーバー](../failover2-writer/)、[FailoverSuccessError](../failover-success-error/)        |
| DNS の古さ             | 無関係 (書かれたホスト名をそのまま引く)                                | StaleDns / initialConnection で検証する。[StaleDns](../stale-dns/)、[initialConnection](../initial-connection-strategy/)                                                               |
| セッション状態         | なし (`connection._clusterId` を付けるだけ)                            | pristine 値の追跡と転送。[SessionState](../session-state/)、[差し替え時の転送と close 時のリセット](../transfer-and-reset/)                                                            |
| 選択戦略               | RR / RANDOM / ORDER                                                    | random / roundRobin (重み付き) / leastConnections / fastestResponse。[ホスト可用性戦略と選択戦略](../host-availability-and-selection/)                                                 |
| プールの単位           | アプリが登録したノードごと                                             | 発見したインスタンスごとに自動生成 (static な表)。[内部コネクションプール](../internal-connection-pool/)                                                                               |
| 認証                   | 固定パスワード                                                         | IAM トークン / Secrets Manager。[IAM 認証プラグイン](../iam-plugin/)、[Secrets Manager プラグイン](../secrets-manager-plugin/)                                                         |
| 失敗時の再試行         | `canRetry` で同じパターンの別ノードから接続を取り直す (接続取得だけ)   | 接続の差し替えまでで、クエリの再実行はアプリの責任                                                                                                                                     |
| 背景タスク             | なし                                                                   | トポロジモニタ、EFM モニタ、掃除ループ。[バックグラウンドタスクと Node.js プロセス](../background-tasks-and-process/)                                                                  |

## 各行の根拠

### トポロジの出所と役割

PoolCluster のノードは [`lib/pool_cluster.js#L189`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/pool_cluster.js#L189) の `add` で登録される。`id` を省けば `CLUSTER::N`、`MASTER` と書けば `MASTER` になるが、それは `_nodes` のキーでしかない。

```js title="lib/pool_cluster.js"
add(id, config) {
  if (typeof id === 'object') {
    config = id;
    id = `CLUSTER::${++this._lastId}`;
  }
  if (typeof this._nodes[id] === 'undefined') {
    this._nodes[id] = {
      id: id,
      errorCount: 0,
      pool: new Pool({ config: new PoolConfig(config) }),
      _offlineUntil: 0,
    };
    this._serviceableNodeIds.push(id);
    this._clearFindCaches();
  }
}
```

ノードの中身は `errorCount` と `Pool` と `_offlineUntil` の 3 つで、役割の概念がない。`of("MASTER")` は文字列パターンの一致で、昇格して read-only になった旧 writer も `MASTER` のままである。

ラッパは [`HostListProvider`](../host-list-providers/) が `information_schema.replica_host_status` を読んで `HostInfo` の一覧を作り、`connect()` 直後に `@@innodb_read_only` で役割を確かめて `HostInfo.role` を上書きする ([AwsMySQLClient](../aws-mysql-client/))。名前は入力で、役割は DB からの出力になっている。

### 不健全の判定

PoolCluster が失敗を数える場所は [`_getConnection#L347`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/pool_cluster.js#L347) だけである。

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

`PoolNamespace.query` ([L95](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/pool_cluster.js#L95)) は `getConnection` の後に `conn.query(query).once('end', () => conn.release())` で、クエリの成否を見ない。接続は取れるがクエリが `read-only` で落ちるノードは、いつまでも健全である。

mysql2 の `Pool` 単体には、これより少しだけ賢い分岐がある。[`lib/base/pool.js#L17`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/base/pool.js#L17) の `isReadOnlyError` が errno 1290 / 1792 / 1836 を見て、`Pool.query()` と `Pool.execute()` はそのエラーで接続を `destroy()` する。コメントに「returned by Aurora during failover」とあり、Aurora のフェイルオーバーを意識した処理である。ただし PoolCluster の `query` はこの `Pool.query` を通らず (`node.pool.getConnection` → `conn.query` と直接呼ぶ)、`destroy` されるのも接続だけで、次の `getConnection` は同じノードのプールから新しい接続を返す。

ラッパは 2 系統で判定する。実行時の例外を `MySQLErrorHandler.isNetworkError` ([`mysql_error_handler.ts#L49`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/mysql_error_handler.ts#L49)) が文字列一致で分類し ([MySQLErrorHandler](../mysql-error-handler/))、EFM が監視用接続で `SELECT 1` を打ち続ける。read-only の errno 1290 / 1836 も `isReadOnlyConnectionError` で見るが、それがトリガになるのは `strict-writer` のときだけで、しかも `query()` 経路では `ClientUtils.queryWithTimeout` が `AwsWrapperError` に包み直す際に `errno` が落ちるため、実際には届かない可能性が高い ([何をトリガとするか](../failover-triggers/))。EFM についても注意がいる。efm2 が監視するのはメソッド実行中だけで、遊休接続は見ない。既定の `wrapperQueryTimeout` 20 秒は EFM の既定 (30 + 5 × 3 = 45 秒) より先に来るので、EFM が効くのは長いクエリのために `wrapperQueryTimeout` を伸ばした構成である ([なぜ EFM が要るか](../why-efm/))。

### 落ちたノードの扱い

[`_increaseErrorCount#L310`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/pool_cluster.js#L310)。

```js title="lib/pool_cluster.js"
_increaseErrorCount(node) {
  const errorCount = ++node.errorCount;

  if (this._removeNodeErrorCount > errorCount) {
    return;
  }

  if (this._restoreNodeTimeout > 0) {
    node._offlineUntil =
      getMonotonicMilliseconds() + this._restoreNodeTimeout;
    this.emit('offline', node.id);
    return;
  }

  this._removeNode(node);
  this.emit('remove', node.id);
}
```

`removeNodeErrorCount` (既定 5) に達すると、`restoreNodeTimeout` (既定 0) が設定されていない限り `_removeNode` で `_nodes` から消して `pool.end()` する。一度消えたノードは `add` し直すまで戻らない。成功すると `_decreaseErrorCount` で 1 減るので、「4 回失敗して 1 回成功」を繰り返す不安定なノードは削除されない。

ラッパの側は、ホストが落ちたら `PluginService.setAvailability` が `NOT_AVAILABLE` を `HostAvailabilityCacheItem` に書き、5 分の期限で自然に復帰する。docs に書かれている exponentialBackoff 戦略は、`setAvailability` が `HostInfo.setAvailability` を呼ばずキャッシュに書くだけなので、戦略の計数が動くのはトポロジモニタが `HostInfo` を更新する経路だけで、それを見るセレクタも `random` に限られる ([ホスト可用性戦略と選択戦略](../host-availability-and-selection/))。「削除しない」という点は PoolCluster より確実に良いが、docs の説明ほど精緻な復帰ではない。

### 昇格後の書き込み先

PoolCluster は、writer が昇格して reader になっても `MASTER` に `INSERT` を送り続ける。`Pool.query` の `destroy` を通る経路でも、捨てるのは接続で、ノードは残る。アプリが `remove("MASTER")` して `add("MASTER", newConfig)` する以外に直す手段がない。

ラッパは `failover2` が `forceMonitoringRefresh` でモニタに新 writer を探させ、役割を確かめてから `setCurrentClient` で差し替える ([failover2 の writer フェイルオーバー](../failover2-writer/))。差し替えたことを `FailoverSuccessError` で知らせ、トランザクション中なら `TransactionResolutionUnknownError` にする ([TransactionResolutionUnknownError](../transaction-resolution-unknown/))。ただし後者には、プラグイン側の `_isInTransaction` が false に戻らないという実装上の穴がある。

### DNS とセッション状態

PoolCluster は `config.host` を mysql2 にそのまま渡す。クラスタエンドポイントを書けば、DNS の TTL が切れるまで古い writer に繋ぐ ([フェイルオーバーで何が起きるか](../what-happens-on-failover/))。ラッパは初回接続で `@@innodb_read_only` を確かめ、期待と違えばインスタンスエンドポイントに張り直す ([StaleDns](../stale-dns/))。

セッション状態について PoolCluster が接続に足すのは `connection._clusterId = node.id` の 1 行だけである。`SET autocommit=0` した接続が返却され、別の呼び出し元に渡ることを防ぐ仕組みはない。ラッパは `updateState` で SQL を読んで pristine 値を追跡し、差し替え時に転送する ([SQL を読んで状態を追う](../tracking-state-from-sql/))。

### 選択戦略とプールの単位

[`makeSelector#L13`](https://github.com/sidorares/node-mysql2/blob/d8932925b237f07b6410263770379998df973502/lib/pool_cluster.js#L13) は 13 行で 3 つの戦略を定義する。

```js title="lib/pool_cluster.js"
const makeSelector = {
  RR() {
    let index = 0;
    return (clusterIds) => clusterIds[index++ % clusterIds.length];
  },
  RANDOM() {
    return (clusterIds) => clusterIds[Math.floor(Math.random() * clusterIds.length)];
  },
  ORDER() {
    return (clusterIds) => clusterIds[0];
  },
};
```

`RR` は単純な巡回で、重みも接続数も見ない。ラッパの `roundRobin` は `HostInfo.weight` (Aurora なら `lag × 100 + cpu`) を使い、`leastConnections` は内部プールの接続数を読む ([ホスト可用性戦略と選択戦略](../host-availability-and-selection/))。

プールの単位も逆になっている。PoolCluster は `add` したノードごとに `Pool` を持つ。ラッパの内部プールは、トポロジで見つけたインスタンスごとに `Pool` を作り、static な `databasePools` に入れる ([内部コネクションプール](../internal-connection-pool/))。アプリはインスタンスの一覧を知らなくてよいが、プールの表がプロセスに 1 つであることを知っておく必要がある。

### 認証と背景タスク

PoolCluster の `config.password` は文字列である。ラッパは `iam` プラグインで 15 分有効のトークンを生成して `password` に差し込み ([IAM 認証プラグイン](../iam-plugin/))、`secretsManager` プラグインで Secrets Manager から取る ([Secrets Manager プラグイン](../secrets-manager-plugin/))。

背景タスクは PoolCluster にはない。`_offlineUntil` の判定も `_findNodeIds` を呼んだときに時刻を比べるだけで、タイマは 1 つもない。ラッパはトポロジモニタと EFM モニタが DB 接続を持って常駐し、`PluginManager.releaseResources()` を呼ばないとプロセスが終わらない ([バックグラウンドタスクと Node.js プロセス](../background-tasks-and-process/))。

## どう選ぶか

**PoolCluster で足りる場合。**

- Aurora / Multi-AZ ではなく、ホストの一覧が静的に決まっている
- writer が変わる事態が、DNS の TTL やアプリの再起動で吸収できる頻度でしか起きない
- クエリの再試行はアプリ側にすでにあり、`ECONNRESET` を受けたら接続を捨てて取り直す作りになっている
- 背景タスクを一切持ちたくない (短命なプロセス、Lambda など)

**ラッパを使う場合。**

- Aurora か Multi-AZ で、フェイルオーバーを秒単位で乗り切ることを期待している
- IAM 認証か Secrets Manager を使う。これだけのために入れても割に合う
- `SET` 系のセッション状態を持つ接続を、差し替え後も同じ設定で使いたい
- reader を発見して振り分けたいが、インスタンスの一覧をアプリに書きたくない

**ラッパを選ぶなら受け入れること。**

- `FailoverSuccessError` を捕まえてクエリを再実行する契約。捕まえずにクライアントを捨てると、成功した接続も捨てることになる
- エラー分類が mysql2 の文言への文字列一致で、mysql2 の更新で壊れうる
- プロセス全体に効く static 状態。`clusterId` の既定 `"1"` ([clusterId](../cluster-id/))、`PluginManager.releaseResources()`、内部プールの表
- 外部プール (`AwsMySQLPoolClient`) はクエリごとに plugin chain 一式を作る ([AwsMySQLPoolClient](../aws-mysql-pool-client/))

**中間の選択肢。** mysql2 の `Pool` を単体で使い、`Pool.query()` の read-only `destroy` に頼りつつ、クラスタエンドポイントの DNS TTL (Aurora は 5 秒) を待つ、という構成もある。writer 交代後の数十秒間はエラーが出るが、アプリが再試行すれば回復する。ラッパが必要かどうかは、この数十秒を許容できるかで決まる。
