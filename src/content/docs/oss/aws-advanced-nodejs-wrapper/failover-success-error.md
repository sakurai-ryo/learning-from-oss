---
title: "FailoverSuccessError — 成功なのに例外を投げる契約"
description: "フェイルオーバーが成功すると、ラッパは FailoverSuccessError を投げる。接続は差し替わっていて再利用できる、セッション状態は失われている、最後のクエリは再実行が必要。この 3 点をアプリに伝える手段が例外しかない。docs の Warning 1 (Client を捨てると差し替え済みの接続も捨てる) と、公式サンプルの queryWithFailoverHandling、AwsMySQLPoolClient.query がこの例外のときだけ end() しない理由を読む。"
group: "フェイルオーバー"
sidebar:
  order: 38
---

## 何を学んだか

フェイルオーバーが**成功した**ことを、ラッパは `FailoverSuccessError` という例外で知らせる。これは 3 つの事実を同時に伝える契約である。

| 事実                                            | アプリがすべきこと                     |
| ----------------------------------------------- | -------------------------------------- |
| 接続は新しいホストに差し替わっていて、使える    | **同じ client を使い続ける。捨てない** |
| セッション状態 (`SET ...`) は失われている       | 初期設定をやり直す                     |
| 失敗したクエリは実行されていない (かもしれない) | 再実行するかを判断して、再実行する     |

この契約を知らずに `catch` で client を捨てると、ラッパが張り直した接続を捨てることになる。docs の Warning 1 はまさにこれを警告している。

## ソースコードのどこか

### 例外の定義

[`common/lib/utils/errors.ts#L39`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/errors.ts#L39)。

```ts title="common/lib/utils/errors.ts"
export class FailoverError extends AwsWrapperError {}

export class FailoverSuccessError extends FailoverError {
  constructor(message?: string, cause?: any) {
    super(Messages.get("Failover.connectionChangedError"));
  }
}

export class FailoverFailedError extends FailoverError {}

export class TransactionResolutionUnknownError extends FailoverError {}
```

3 つとも `FailoverError` の子である。`FailoverSuccessError` はコンストラクタ引数を**無視して**固定メッセージを使う。

```
The active SQL connection has changed due to a connection failure. Please re-configure session state if required.
```

引数を受け取るシグネチャがあるのに捨てているのは、他の例外クラスと呼び出し形を揃えるためだと読める。メッセージを変えられないので、アプリは `instanceof` で判定するしかない。それが意図でもある。

### 投げる場所

[`failover2_plugin.ts#L232`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L232)。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
protected throwFailoverSuccessException(): void {
  if (this._isInTransaction || this.pluginService.isInTransaction()) {
    // "Transaction resolution unknown. Please re-configure session state if required and try
    // restarting transaction."
    logger.debug(Messages.get("Failover.transactionResolutionUnknownError"));
    throw new TransactionResolutionUnknownError(Messages.get("Failover.transactionResolutionUnknownError"));
  } else {
    // "The active SQL connection has changed due to a connection failure. Please re-configure
    // session state if required."
    throw new FailoverSuccessError();
  }
}
```

`failover()` の最後で必ず呼ばれる。トランザクション中なら [`TransactionResolutionUnknownError`](../transaction-resolution-unknown/)、そうでなければ `FailoverSuccessError`。この時点で `setCurrentClient` は完了していて、`PluginService` の現在接続は新しいホストを指している。

### docs の Failover Errors 表

`UsingTheFailoverPlugin.md` の表をそのまま引く。

| Errors                            | 接続は有効か | 再利用できるか | セッション状態は変わったか | 再設定が必要か | 最後の文を再実行すべきか | トランザクションを再開すべきか |
| --------------------------------- | ------------ | -------------- | -------------------------- | -------------- | ------------------------ | ------------------------------ |
| FailoverFailedError               | No           | No             | N/A                        | N/A            | Yes                      | Yes                            |
| FailoverSuccessError              | Yes          | Yes            | Yes                        | Yes            | Yes                      | N/A                            |
| TransactionResolutionUnknownError | Yes          | Yes            | Yes                        | Yes            | Yes                      | Yes                            |

`FailoverSuccessError` の行だけ「トランザクション再開」が N/A なのは、トランザクション中なら別の例外になるからである。

### 公式サンプルの形

[`examples/aws_driver_example/aws_failover_mysql_example.ts#L79`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/examples/aws_driver_example/aws_failover_mysql_example.ts#L79)。

```ts title="examples/aws_driver_example/aws_failover_mysql_example.ts"
async function queryWithFailoverHandling(client: AwsMySQLClient, query: string) {
  try {
    const result = await client.query({ sql: query });
    return result;
  } catch (error) {
    if (error instanceof FailoverFailedError) {
      // Connection failed, and Node.js wrapper failed to reconnect to a new instance.
      throw error;
    } else if (error instanceof FailoverSuccessError) {
      // Query execution failed and Node.js wrapper successfully failed over to a new elected writer instance.
      // Reconfigure the connection.
      await setInitialSessionSettings(client);
      // Re-run query
      return await client.query({ sql: query });
    } else if (error instanceof TransactionResolutionUnknownError) {
      // Transaction resolution unknown. Please re-configure session state if required and try
      // restarting transaction.
      throw error;
    }
  }
}
```

`FailoverSuccessError` の分岐だけが `throw` しない。`setInitialSessionSettings` (サンプルでは `SET time_zone = 'UTC'`) をやり直してから、**同じ `client`** で同じクエリをもう一度投げる。2 回目の `query()` は差し替え済みの接続に届く。

注意点が 1 つある。この関数は、上の 3 つ以外の例外 (構文エラーなど) を `catch` して何も `throw` せずに抜けるので、`undefined` を返す。サンプルの簡略化で、そのまま真似ると例外が消える。

### 外部プールでの扱い

`AwsMySQLPoolClient.query()` ([`mysql/lib/client.ts#L642`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L642)) は、この例外を特別扱いする。

```ts title="mysql/lib/client.ts"
async query(options: string | QueryOptions, values?: any): Promise<[any, any]> {
  const awsMySQLPooledConnection: AwsMySQLPooledConnection = new AwsMySQLPooledConnection(this.config, this.connectionProvider);
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
```

`FailoverSuccessError` のときだけ `end()` を呼ばない。`AwsMySQLPooledConnection.end()` は plugin chain の `end` を通って内部プールへ接続を返す操作である。この `query()` は呼ぶたびに `AwsMySQLPooledConnection` を作って捨てる形なので、例外はそのまま上に投げられ、アプリが同じ接続で再実行する機会はない。差し替え済みの接続はプールに返されないまま関数を抜ける。この経路の意図と内部プール側の後始末は [AwsMySQLPoolClient のページ](../aws-mysql-pool-client/) で扱う。

### connect 経路では投げない

[全体像](../failover-overview/) で見たとおり、`connect` パイプラインで起きたフェイルオーバーは `FailoverSuccessError` を `catch` して接続を返す。アプリに届くのは `query()` 経由のときだけである。

## なぜそうなっているか

### なぜ黙って再実行しないのか

ラッパは、失敗したクエリが**サーバに届いたかどうか**を知らない。`INSERT` を送った直後に TCP が切れた場合、旧 writer がそれをコミットしてから落ちたのか、受信前に落ちたのかは区別できない。黙って再実行すれば二重挿入になりうる。冪等かどうかを知っているのはアプリだけなので、判断ごとアプリに返す。

セッション状態も同じ理由である。[SessionState](../session-state/) が追跡している `autocommit` / `readOnly` / `catalog` / `transactionIsolation` は [転送](../transfer-and-reset/)されるが、`SET time_zone` や `SET sql_mode` のような任意の変数は追跡していない。何を設定していたかを知っているのはアプリだけである。

### なぜ戻り値ではなく例外なのか

`query()` の戻り値は `[rows, fields]` で、mysql2 と互換の形を保つことが `AwsMySQLClient` の前提である ([AwsMySQLClient のページ](../aws-mysql-client/))。戻り値に「差し替わった」フラグを混ぜると互換が崩れる。例外なら、既存の `catch` に 1 分岐足すだけで済む。

また、フェイルオーバーが起きた時点で、そのクエリの結果は**存在しない**。結果がないのに正常リターンする経路を作るほうが不自然である。

### なぜ Warning 1 が要るのか

一般的なリトライパターンは「エラーが出たら接続を捨てて作り直す」である。mysql2 単体ならそれで正しい。しかしラッパでは、`catch` に入った時点で `client` の中身はもう新しい接続に差し替わっている。それを `end()` すると、フェイルオーバーで得た接続を捨て、次の `connect()` で DNS 経由の (まだ古い writer を指しているかもしれない) 接続を張り直すことになる。**ラッパの利点を、慣習的な後始末が打ち消す**。docs はこれを "the application will lose the fast-failover functionality" と書いている。

## どう活かすか

- **「成功したが呼び出し元の介入が要る」状態は、例外の型で表す。** 戻り値に混ぜると互換が崩れ、ログに出すだけだと気づかれない。型があれば `instanceof` で分岐でき、無視されればそのまま上に伝播する
- **例外クラスの継承で「分類」を表す。** `FailoverError` を親にしておくと、細かい区別をしたくない呼び出し元は親で catch できる
- **ライブラリのリトライ規約は README ではなく例外の型に書く。** `FailoverSuccessError` という名前と固定メッセージが、規約そのものになっている
- **接続を包むライブラリを使うときは「エラー時に接続を捨てる」慣習を疑う。** 包む側が接続を差し替えているなら、捨てるのは二重の損失になる

### 実務で踏む失敗パターン

- **汎用のリトライライブラリで `client.end()` → 再 `connect()` している。** `FailoverSuccessError` を先に `instanceof` で拾い、`end()` せずに再実行する分岐を足す
- **`error.message` で判定している。** メッセージは固定だが、判定には `instanceof FailoverSuccessError` を使う。`import { FailoverSuccessError } from "aws-advanced-nodejs-wrapper"` で取れる
- **セッション設定を `connect()` 直後にだけやっている。** `FailoverSuccessError` の後にも呼ぶ。サンプルの `setInitialSessionSettings` のように関数に切り出しておく
- **ORM や クエリビルダの下で使っていて `catch` に手が届かない。** その層が例外をラップして型を消すことがある。`cause` を辿るか、ORM の接続フックでフェイルオーバー時の再設定を組む
