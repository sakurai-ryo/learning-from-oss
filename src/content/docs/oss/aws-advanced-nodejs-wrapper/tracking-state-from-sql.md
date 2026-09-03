---
title: "SQL を読んで状態を追う"
description: "アプリが query() で直接 SET autocommit=0 や USE db を投げても、ラッパは追跡したい。mysql2 にフックはないので、送る前の SQL 文字列を自分で読む。client.format でプレースホルダを展開し、; で割り、コメントを剥がし、includes と正規表現で 5 項目を拾う。その素朴さが何を取りこぼすかまで読む。"
group: "接続を差し替えても壊れないようにする"
sidebar:
  order: 52
---

## 何を学んだか

前のページの setter (`setAutoCommit()` など) を使わず、アプリが `client.query({ sql: "SET autocommit=0" })` と書くことは普通にある。ラッパはそれも追跡したい。mysql2 にセッション変数の変更を通知する仕組みはないので、**送信直前の SQL 文字列を自分で解析する**しかない。

- `AwsMySQLClient.query()` / `execute()` は、mysql2 に渡す前に `client.format()` で**プレースホルダを展開した SQL** を作り、`PluginService.updateState(sql)` に渡す
- `updateState` は SQL を `;` で割り、各文を小文字化してブロックコメントを剥がし、`includes` と正規表現で **readOnly / autoCommit / catalog / transactionIsolation** を拾う。同じ項目が複数回出たら**最後の文が勝つ**
- 解析は Dialect に委ねられていて、MySQL 用は `MySQLDatabaseDialect.doesStatementSet*` の 5 メソッドである
- 素朴な文字列一致なので、`SET SESSION autocommit=0` や `SET autocommit=ON` は**拾えない**。`USE MyDb` は小文字化されて `mydb` として記録される

## ソースコードのどこか

### 入口 — `format` してから読む

[`mysql/lib/client.ts#L513`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L513)。

```ts title="mysql/lib/client.ts"
async query(options: string | QueryOptions, values?: any): Promise<[any, any]> {
  if (!this.isConnected) {
    await this.connect(); // client.connect is not required for MySQL clients
    this.isConnected = true;
  }
  const host = this.pluginService.getCurrentHostInfo();
  const context = this.telemetryFactory.openTelemetryContext("awsClient.query", TelemetryTraceLevel.TOP_LEVEL);
  return await context.start(async () => {
    return await this.pluginManager.execute(
      host,
      this.properties,
      "query",
      async () => {
        if (!this.targetClient) {
          throw new UndefinedClientError();
        }
        // Handle parameterized queries
        await this.updateState(this.targetClient.client, options, values);
        return await ClientUtils.queryWithTimeout(this.targetClient.client?.query(options, values), this.properties);
      },
      [options, values]
    );
  });
}

private async updateState(client: any, options: string | QueryOptions, values?: any): Promise<any> {
  let sql: string;
  if (typeof options === "string") {
    sql = client.format(options, values);
  } else {
    sql = client.format(options.sql, options.values);
  }
  await this.pluginService.updateState(sql);
}
```

`updateState` は plugin chain の**最内側** (`methodFunc` の中) で呼ばれる。つまり全プラグインを通り抜けた後、mysql2 の `query()` を呼ぶ直前である。`client.format` は mysql2 の `Connection.format` で、`?` を値で置換した完成形の SQL 文字列を返す。`SET autocommit=?` に `[0]` を渡した場合でも、解析対象は `SET autocommit=0` になる。

`execute()` (prepared statement) も同じ `updateState` を通る ([L543](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L543))。一方、setter 系が使う `queryWithoutUpdate` ([L102](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L102)) は名前どおりこれを呼ばない。setter は自分で `setState` するので二重記録を避けている。

### `PluginService.updateState` — 5 項目 + トランザクション

[`common/lib/plugin_service.ts#L635`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugin_service.ts#L635)。

```ts title="common/lib/plugin_service.ts"
async updateState(sql: string) {
  this.updateInTransaction(sql);

  const statements = SqlMethodUtils.parseMultiStatementQueries(sql);
  await this.updateReadOnly(statements);
  await this.updateAutoCommit(statements);
  await this.updateCatalog(statements);
  await this.updateSchema(statements);
  await this.updateTransactionIsolation(statements);
}

private async updateReadOnly(statements: string[]) {
  const updateReadOnly = SqlMethodUtils.doesSetReadOnly(statements, this.getDialect());
  if (updateReadOnly !== undefined) {
    this.getSessionStateService().setReadOnly(updateReadOnly);
  }
}
```

トランザクション境界 (`updateInTransaction`) は次のページに回す ([トランザクション境界の追跡](../transaction-boundary/))。ここで注意したいのは、`updateReadOnly` が呼ぶのは `setReadOnly` (現在値の記録) **だけ**で、`setupPristineReadOnly` (pristine の確保) は呼ばれないことである。`query()` 経由で変えた項目は pristine が `undefined` のままなので、転送はされるが、close 時のリセット対象にはならない ([SessionState](../session-state/) の `canRestorePristine`)。

### `SqlMethodUtils` — 割って、小文字にして、コメントを剥がす

[`common/lib/utils/sql_method_utils.ts#L43`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/sql_method_utils.ts#L43)。

```ts title="common/lib/utils/sql_method_utils.ts"
static doesSetReadOnly(statements: string[], dialect: DatabaseDialect): boolean | undefined {
  let readOnly;
  for (const statement of statements) {
    const cleanStatement = statement
      .toLowerCase()
      .replaceAll(/\s*\/\*(.*?)\*\/\s*/gi, " ")
      .trim();
    readOnly = dialect.doesStatementSetReadOnly(cleanStatement) ?? readOnly;
  }
  return readOnly;
}

static parseMultiStatementQueries(sql: string): string[] {
  if (!sql) {
    return [];
  }
  const query = sql.replaceAll(/\s+/gi, " ");
  if (!query.trim()) {
    return [];
  }
  return sql.split(";");
}
```

3 つの癖がある。

- **`;` で機械的に割る。** 文字列リテラルの中の `;` も区切りになる。`query` に空白を潰した結果を作っておきながら、`split` するのは元の `sql` である (空白の正規化は空文字チェックにしか使われていない)
- **ブロックコメント `/* */` だけ剥がす。** `-- ` や `#` の行コメントは残る
- **`?? readOnly` で最後の文が勝つ。** `SET autocommit=1; SET autocommit=0` は `false` になる。テストでもそう固定されている ([`tests/unit/sql_method_utils.test.ts#L100`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/tests/unit/sql_method_utils.test.ts#L100))

同じ小文字化とコメント除去が `doesSetAutoCommit` / `doesSetCatalog` / `doesSetSchema` / `doesSetTransactionIsolation` にコピーされていて、1 つの SQL に対して 5 回繰り返される。

### `MySQLDatabaseDialect.doesStatementSet*` — includes と正規表現

[`mysql/lib/dialect/mysql_database_dialect.ts#L150`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/mysql_database_dialect.ts#L150)。

```ts title="mysql/lib/dialect/mysql_database_dialect.ts"
doesStatementSetReadOnly(statement: string): boolean | undefined {
  if (statement.includes("set session transaction read only")) {
    return true;
  }
  if (statement.includes("set session transaction read write")) {
    return false;
  }
  return undefined;
}

doesStatementSetAutoCommit(statement: string): boolean | undefined {
  if (statement.includes("set autocommit")) {
    const statementSections = statement.split("=");
    const value = statementSections[1].trim();
    if (value === "0") {
      return false;
    }
    if (value === "1") {
      return true;
    }
  }
  return undefined;
}

doesStatementSetCatalog(statement: string): string | undefined {
  const catalogRegexp = /^use\s+(\w+)/i;
  if (catalogRegexp.test(statement)) {
    return statement.split(catalogRegexp)[1];
  }
  return undefined;
}

doesStatementSetSchema(statement: string): string | undefined {
  return undefined;
}
```

`doesStatementSetTransactionIsolation` も同じ形で、`set session transaction isolation level read uncommitted` など 4 つの文字列を `includes` で見る ([L178](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/mysql_database_dialect.ts#L178))。

拾える形と拾えない形を並べると、境界がはっきりする。

| SQL                                          | 結果     | 理由                                                                     |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `SET autocommit=0`                           | `false`  | 想定どおり                                                               |
| `SET autocommit = 1`                         | `true`   | `split("=")[1].trim()`                                                   |
| `SET SESSION autocommit=0`                   | 拾えない | `"set autocommit"` を含まない                                            |
| `SET @@autocommit=0`                         | 拾えない | 同上                                                                     |
| `SET autocommit=OFF`                         | 拾えない | `"0"` / `"1"` 以外は `undefined`                                         |
| `SET autocommit=0, sql_mode=''`              | 拾えない | `split("=")[1]` が `0, sql_mode` になり、`"0"` とも `"1"` とも一致しない |
| `SELECT 'set session transaction read only'` | `true`   | 文字列リテラルの中身も `includes` に引っかかる                           |
| `USE MyDb`                                   | `"mydb"` | 小文字化された後に正規表現を当てる                                       |
| `use` `db` (改行区切り)                      | `"db"`   | `\s+` は改行を含む                                                       |
| `START TRANSACTION READ ONLY`                | 拾えない | readOnly の判定は `set session transaction` 固定                         |

`USE MyDb` → `mydb` はテストで明示的に固定されている ([`sql_method_utils.test.ts#L126`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/tests/unit/sql_method_utils.test.ts#L126))。転送時には `USE mydb` が発行されるので、Linux の MySQL で `lower_case_table_names=0` (既定) のまま大文字混じりの DB 名を使っていると、差し替え後の `USE` が `Unknown database` で落ちる。

## なぜそうなっているか

### なぜ「送る前」に読むのか

mysql2 の `Connection` は `query()` を受け取ってパケットにするだけで、セッション変数が変わったことを知らせるイベントを持たない。サーバ側から `SESSION_TRACK` (MySQL 5.7 以降の `session_track_system_variables`) で変更通知を受ける方法はあるが、mysql2 はそれを公開 API に出していない。残る選択肢は**アプリが渡した文字列を読む**ことしかない。

送る前に読むのは、readWriteSplitting が **SQL を見てから接続を差し替える**必要があるためでもある ([readWriteSplitting](../read-write-splitting/))。`SET SESSION TRANSACTION READ ONLY` を見つけたら、その SQL を reader 側の接続で実行しなければ意味がない。

### なぜ `format` してから読むのか

`SET autocommit=?` に `[0]` を渡す書き方を拾うためである。ただし副作用として、**すべてのクエリで `format` が 1 回余計に走る**。mysql2 は `query(options, values)` を受けた後に自分でも `format` するので、値の埋め込みが二重に行われる。バイナリや大きな配列を渡すクエリではこのコストが見える。

### なぜ正規表現パーサではなく `includes` なのか

対応したい SQL は「アプリが `setAutoCommit()` の代わりに手で書く典型形」であり、SQL 文法を網羅する意図はない。`MySQLDatabaseDialect` と `PgDatabaseDialect` で判定を分けているのも、`USE` (MySQL) と `SET search_path` (PG) の違いを吸収する最小の手段として Dialect が既にあったからである。

代わりに、上の表のとおり**偽陽性と偽陰性の両方**がある。偽陰性 (拾えない) は「転送されない」だけで済むが、偽陽性 (文字列リテラルにマッチ) は**存在しない変更を転送する**。`SELECT 'set session transaction read only'` を投げた後にフェイルオーバーすると、新しい接続に `SET SESSION TRANSACTION READ ONLY` が送られる。

### なぜ 5 回同じ前処理を繰り返すのか

`doesSetReadOnly` から `doesSetTransactionIsolation` までが同じ `toLowerCase().replaceAll(...).trim()` を持っているのは、各関数が独立に書かれたからで、設計上の理由はない。1 クエリあたり 5 回の小文字化と正規表現置換が走る。短い SQL では無視できるが、数 MB の `INSERT ... VALUES` では効く。

## どう活かすか

- **フックがないなら、境界で文字列を読む。** ドライバに手を入れずに状態を追うなら、送信直前の 1 点に集約する。`updateState` が plugin chain の最内側に 1 箇所だけあるのは、そのための位置である
- **偽陽性の方が偽陰性より危ない。** 「拾えなかった」は転送漏れで済むが、「誤って拾った」は存在しない状態を作り出す。文字列一致で判定するなら、まず偽陽性の経路 (リテラル、コメント) を潰す
- **正規化した値を保存するなら、往復で意味が変わらないか確認する。** `USE MyDb` → `mydb` → `USE mydb` は、大文字小文字を区別する環境で壊れる。小文字化は比較のためだけに使い、保存は原文から取る
- **サポート範囲を表にして docs に書く。** 上の表のような「拾える / 拾えない」の境界は、実装を読まないと分からない。ライブラリ側に書いておくべき情報である

### 実務で踏む失敗パターン

- **`SET SESSION autocommit=0` が転送されない。** `SET autocommit=0` と書き直すか、`setAutoCommit(false)` を使う。`SET SESSION` を付けると `includes("set autocommit")` に一致しない
- **`SET autocommit=0, sql_mode='...'` のように 1 文で複数変数を設定している。** `split("=")[1]` が `0, sql_mode` になり、拾えない。1 変数 1 文にする
- **DB 名に大文字が混じっている。** `USE MyDb` は `mydb` として転送される。DB 名を小文字に統一するか、`lower_case_table_names=1` の環境だけで使う
- **`execute()` (prepared statement) で `SET` を打っている。** 追跡自体はされる (`updateState` を通る) が、readWriteSplitting の切替は `query` にしか反応しない ([readWriteSplitting](../read-write-splitting/))
