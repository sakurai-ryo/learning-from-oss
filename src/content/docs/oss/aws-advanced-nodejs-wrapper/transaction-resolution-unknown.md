---
title: "TransactionResolutionUnknownError"
description: "トランザクション中にフェイルオーバーすると、成功例外は FailoverSuccessError ではなく TransactionResolutionUnknownError になる。判定に使うのはプラグイン自身の _isInTransaction と PluginService.isInTransaction() の 2 つで、前者は invalidateCurrentClient で旧接続に rollback を試みたときに立つ。「不明」と言い切る理由と、_isInTransaction を false に戻す箇所がないという実装上の事実を読む。"
group: "フェイルオーバー"
sidebar:
  order: 39
---

## 何を学んだか

トランザクションの途中で接続が切れてフェイルオーバーに成功すると、ラッパは `FailoverSuccessError` ではなく **`TransactionResolutionUnknownError`** を投げる。名前のとおり、「そのトランザクションがコミットされたのか捨てられたのか、ラッパには分からない」という宣言である。

判定材料は 2 つある。

- `PluginService.isInTransaction()`: SQL を読んで追跡している[トランザクション境界](../transaction-boundary/)の現在値
- `Failover2Plugin._isInTransaction`: 旧接続を無効化する `invalidateCurrentClient` の時点で `isInTransaction()` が true だったかを**プラグインが覚えたもの**

2 つある理由は、`setCurrentClient` が差し替えの過程で `setInTransaction(false)` にしてしまうからである。差し替え前の値をプラグイン側に退避しておかないと、`throwFailoverSuccessException` の時点では常に false に見える。

そして `_isInTransaction` を false に戻す行は、このプラグインのどこにもない。

## ソースコードのどこか

### 退避する場所

[`failover2_plugin.ts#L435`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L435)。`execute` の `catch` で、`failover()` より前に呼ばれる。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
async invalidateCurrentClient() {
  const client = this.pluginService.getCurrentClient();
  if (!client || !client.targetClient) {
    return;
  }

  if (this.pluginService.isInTransaction()) {
    this._isInTransaction = this.pluginService.isInTransaction();
    try {
      await client.rollback();
    } catch (error) {
      // Do nothing.
    }
  }

  try {
    const isValid = await client.isValid();
    if (!isValid) {
      await this.pluginService.abortCurrentClient();
    }
  } catch (error) {
    // Do nothing.
  }
}
```

トランザクション中なら `_isInTransaction = true` にしてから、**旧接続に `rollback()` を試みる**。`client` は `AwsMySQLClient` なので、この `rollback()` は plugin chain を通る (`"rollback"` は failover2 の subscribed methods にないので素通り) が、接続が死んでいれば失敗する。失敗は握りつぶす。docs はこれを "Note that the rollback might be unsuccessful as the initial connection may be broken" と書いている。

その後 `isValid()` ([`aws_client.ts#L199`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/aws_client.ts#L199)、MySQL では `SELECT 1`) で接続の生死を見て、死んでいれば `destroy()` する。

### 判定する場所

[`failover2_plugin.ts#L232`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L232)。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
protected throwFailoverSuccessException(): void {
  if (this._isInTransaction || this.pluginService.isInTransaction()) {
    logger.debug(Messages.get("Failover.transactionResolutionUnknownError"));
    throw new TransactionResolutionUnknownError(Messages.get("Failover.transactionResolutionUnknownError"));
  } else {
    throw new FailoverSuccessError();
  }
}
```

`||` の右側 `pluginService.isInTransaction()` は、`connect` 経路のように `invalidateCurrentClient` を経由せずに `failover()` へ来た場合の保険である。

### PluginService 側の追跡

`_isInTransaction` は `PluginService` にもある ([`plugin_service.ts#L209`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L209))。こちらは `updateInTransaction(sql)` ([`#L646`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L646)) で SQL の先頭文を見て更新される。

```ts title="common/lib/plugin_service.ts"
updateInTransaction(sql: string) {
  if (SqlMethodUtils.doesOpenTransaction(sql)) {
    this.setInTransaction(true);
  } else if (SqlMethodUtils.doesCloseTransaction(sql)) {
    this.setInTransaction(false);
  }
}
```

`doesOpenTransaction` は `start transaction` / `begin` で始まる文、`doesCloseTransaction` は `commit` / `rollback` / `end` / `abort` で始まる文を見る ([`sql_method_utils.ts#L22`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/sql_method_utils.ts#L22))。`AwsMySQLClient.query()` は毎回 `updateState(sql)` 経由でこれを呼び、`beginTransaction()` / `commit()` / `rollback()` はそれぞれ `"START TRANSACTION"` / `"COMMIT"` / `"rollback"` を渡す ([`mysql/lib/client.ts#L230`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L230))。

`autocommit = 0` のセッションで `UPDATE` を打った場合は、`START TRANSACTION` がないので**トランザクション中と認識されない**。この場合フェイルオーバーは `FailoverSuccessError` になり、未コミットの更新は失われたのに「トランザクション不明」とは言われない。

### setCurrentClient が false にする

[`plugin_service.ts#L546`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L546)。

```ts title="common/lib/plugin_service.ts"
const isInTransaction = this.isInTransaction();
this.sessionStateService.begin();

try {
  this.getCurrentClient().targetClient = newClient;
  this._currentHostInfo = hostInfo;
  await this.sessionStateService.applyCurrentSessionState(this.getCurrentClient());
  this.setInTransaction(false);

  if (oldClient && (isInTransaction || WrapperProperties.ROLLBACK_ON_SWITCH.get(this.props))) {
    try {
      await oldClient.rollback();
    } catch (error: any) {
      // Ignore.
    }
  }
```

新しい接続にトランザクションは引き継がれないので `setInTransaction(false)`。旧接続には (`rollbackOnSwitch` 既定 true なので常に) もう一度 `rollback()` を試みる。`invalidateCurrentClient` の分と合わせて、旧接続への rollback は 2 回試みられる。

ここで `PluginService` 側の値が消えるので、`throwFailoverSuccessException` が正しく判定するには、プラグイン側の `_isInTransaction` が必要になる。

### false に戻す箇所がない

`_isInTransaction` の出現は 3 箇所である。

| 行                                                                                                                                                                | 内容                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [`#L63`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L63)   | `= false` で宣言                         |
| [`#L442`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L442) | `invalidateCurrentClient` で true にする |
| [`#L233`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L233) | `throwFailoverSuccessException` で読む   |

一度 true になると、そのプラグインインスタンス (= その `AwsMySQLClient`) が生きている限り true のままである。同じ client で 2 回目のフェイルオーバーが起きると、トランザクション中でなくても `TransactionResolutionUnknownError` になる。v1 の `FailoverPlugin` も同じ構造で ([`failover_plugin.ts#L73`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/failover_plugin.ts#L73)、`#L344`、`#L427`)、リセットはない。

`AwsMySQLPoolClient` 経由なら `query()` ごとに新しい `AwsMySQLPooledConnection` (= 新しいプラグイン一式) が作られるので、この持ち越しは起きない。長寿命の `AwsMySQLClient` を使い回す構成でだけ効く。

## なぜそうなっているか

### なぜ「不明」なのか

接続が切れた瞬間の状態は、クライアントからは 3 つに区別できない。

1. `COMMIT` を送る前に切れた。サーバは接続断でロールバックした
2. `COMMIT` を送ったが応答が届く前に切れた。サーバはコミットした
3. `COMMIT` を送ったがサーバが受信する前に切れた。サーバはロールバックした

ラッパは自分が送った SQL の履歴を持たないし、持っていても 2 と 3 の区別はつかない。だから「成功したが、あなたのトランザクションがどうなったかは知らない」と正直に言う。docs の指示は「セッションを再設定し、**トランザクションを最初からやり直し**、失敗したクエリも再実行する」で、1〜3 のどれでも安全なのは「確認してからやり直す」だけである。

### なぜ旧接続に rollback を試みるのか

接続が実は生きている場合 (EFM が不健全と判定したが TCP は通る、`wrapperQueryTimeout` に負けただけで接続自体は無事、など) に、旧接続で開いたままのトランザクションがロックを持ち続けるのを防ぐためである。失敗しても構わないので握りつぶす。これは `invalidateCurrentClient` と `setCurrentClient` の両方で試みられる。

### なぜ 2 つのフラグが要るのか

順序の問題である。`invalidateCurrentClient` → `failover()` → `setCurrentClient` (ここで `PluginService` 側が false になる) → `throwFailoverSuccessException` の順に走る。判定は最後なので、最初の時点の値をどこかに退避しないと失われる。プラグインのフィールドに退避したが、次のフェイルオーバーのために消す設計になっていない。`invalidateCurrentClient` の冒頭で `this._isInTransaction = this.pluginService.isInTransaction()` と**無条件に代入**していれば (現在は `if` の中でしか代入しない)、毎回の値になっていた。

## どう活かすか

- **分からないことは「分からない」という型で返す。** `TransactionResolutionUnknownError` は成功でも失敗でもない第 3 の結果を表している。二値に潰すと、片方に倒したときの損失をライブラリが引き受けることになる
- **差し替え処理の途中で消える状態は、処理の最初に退避し、最後に消す。** 退避だけして消さない変数は、2 回目から嘘をつく。`try / finally` で消すか、判定を退避の直後に寄せる
- **状態追跡が SQL の字面に依存しているなら、その限界を利用者に見せる。** `autocommit = 0` のセッションは追跡外である。ドキュメントに書くか、`SET autocommit` を見たときにトランザクション開始とみなす (現状は `doesSetAutoCommit` で `SessionState` は更新するが `_isInTransaction` は触らない)

### 実務で踏む失敗パターン

- **同じ `AwsMySQLClient` で 2 回目のフェイルオーバーが全部 `TransactionResolutionUnknownError` になる。** 上記の持ち越しである。1 回目がトランザクション中だった client は、以後ずっとそう判定される。`FailoverError` として一括で扱い、どちらの例外でも「再設定 + 再実行」するコードにしておけば実害はない
- **`autocommit = 0` で `START TRANSACTION` を省いている。** ラッパはトランザクション中と認識しないので `FailoverSuccessError` が返る。未コミットの更新は消えているのに、サンプルコードの分岐ではそのまま次のクエリを打つ。`beginTransaction()` を明示する
- **`TransactionResolutionUnknownError` を `catch` して同じトランザクションを続ける。** 新しい接続にトランザクションはない。`beginTransaction()` からやり直す
- **ORM がトランザクションを `SET autocommit=0` で表現している。** 同上。ORM の設定で `START TRANSACTION` を使わせるか、ラッパの追跡に頼らない
