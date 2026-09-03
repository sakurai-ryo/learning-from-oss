---
title: "MySQL で IAM を使うと cleartext になる"
description: "Aurora MySQL はトークン認証ユーザに mysql_clear_password を要求し、mysql2 は enableCleartextPlugin なしでそれを拒む。3.0.0 までラッパの iam は MySQL で実質動かなかった。修正は MySQL2DriverDialect の 17 行で、認証プラグインのコードが plugins にあり、かつ ssl が設定されているときだけ enableCleartextPlugin を立てる。誰が・いつ・何を条件に立てるかの 3 つの判断と、内部プール経路では呼ばれないという穴を読む。"
group: "AWS の認証"
sidebar:
  order: 60
---

## 何を学んだか

前提の 2 ページで、MySQL 側の事情は説明した。IAM トークンは `AWSAuthenticationPlugin` ユーザのパスワードとして送られ ([IAM DB 認証の仕組み](../iam-db-auth/))、サーバはそのユーザに `mysql_clear_password` への切り替えを要求し、mysql2 は `enableCleartextPlugin` が立っていなければ `MYSQL_CLEAR_PASSWORD_NOT_ENABLED` で切る ([mysql2 の認証プラグイン交渉](../mysql2-auth-plugin-negotiation/))。

つまり、`plugins: "iam"` と書いただけでは MySQL には繋がらない。CHANGELOG 3.0.0 の Fixed に「IAM, Federated Authentication and Okta authentication now work against Aurora MySQL」とあるのはこのことで、**それまでラッパの MySQL 向け IAM 認証は、ユーザが `enableCleartextPlugin: true` を自分で書かない限り動いていなかった。**

修正は [`MySQL2DriverDialect.setCleartextPluginForTokenAuth`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/mysql2_driver_dialect.ts#L89) の 17 行で、3 つの判断が入っている。

- **誰が立てるか**: 認証プラグインではなく、`DriverDialect` が立てる
- **いつ立てるか**: `createConnection` に渡すオプションを組み立てる直前
- **何を条件に立てるか**: `plugins` に `iam` / `federatedAuth` / `okta` のどれかがあり、かつ `ssl` が設定されている。明示指定があれば触らない

## ソースコードのどこか

### 立てる場所

[`mysql2_driver_dialect.ts#L43`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/mysql2_driver_dialect.ts#L43)。`DefaultPlugin` → `DriverConnectionProvider` → `MySQL2DriverDialect.connect` と降りてきた最後の段である ([DefaultPlugin と ConnectionProvider](../default-plugin-and-connection-provider/))。

```ts title="mysql/lib/dialect/mysql2_driver_dialect.ts"
async connect(hostInfo: HostInfo, props: Map<string, any>): Promise<ClientWrapper> {
  const driverProperties = WrapperProperties.removeWrapperProperties(props);
  // MySQL2 does not support keep alive, explicitly check and throw an error if this value is set to true.
  this.setKeepAliveProperties(driverProperties, props.get(WrapperProperties.KEEPALIVE_PROPERTIES.name));
  this.setConnectTimeout(driverProperties, props.get(WrapperProperties.WRAPPER_CONNECT_TIMEOUT.name));
  this.setCleartextPluginForTokenAuth(driverProperties, props);
  const targetClient = await createConnection(Object.fromEntries(driverProperties.entries()));
  return Promise.resolve(new MySQLClientWrapper(targetClient, hostInfo, props, this));
}
```

`removeWrapperProperties` でラッパ固有のキーを剥がした `driverProperties` と、剥がす前の `props` の両方を受け取る。`plugins` はラッパのキーなので `driverProperties` にはもう無く、`props` から読む必要がある ([WrapperProperties](../wrapper-properties/))。

### 判定の本体

[`#L79`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/mysql2_driver_dialect.ts#L79) から。ドキュメントコメントが判断を全部書いている。

```ts title="mysql/lib/dialect/mysql2_driver_dialect.ts"
private static readonly CLEARTEXT_PLUGIN_PROPERTY_NAME = "enableCleartextPlugin";
private static readonly SSL_PROPERTY_NAME = "ssl";
private static readonly TOKEN_AUTH_PLUGIN_CODES = ["iam", "federatedAuth", "okta"];

/**
 * When a database user authenticates with a generated token, the server asks for the
 * `mysql_clear_password` authentication plugin. The underlying driver refuses that plugin unless
 * `enableCleartextPlugin` is set, so token-based authentication cannot connect without it.
 *
 * The option is enabled on the user's behalf only when a token-based authentication plugin is in
 * use and the connection is encrypted. It is never enabled silently on an unencrypted connection,
 * because the plugin sends the token in plaintext at the protocol level; in that case the user gets
 * a warning explaining what to configure. An explicit user-provided value always wins.
 */
setCleartextPluginForTokenAuth(driverProperties: Map<string, any>, props: Map<string, any>) {
  if (driverProperties.has(MySQL2DriverDialect.CLEARTEXT_PLUGIN_PROPERTY_NAME)) {
    return;
  }

  const pluginCodes = (WrapperProperties.PLUGINS.get(props) ?? "").split(",").map((code: string) => code.trim());
  if (!MySQL2DriverDialect.TOKEN_AUTH_PLUGIN_CODES.some((code) => pluginCodes.includes(code))) {
    return;
  }

  if (!driverProperties.get(MySQL2DriverDialect.SSL_PROPERTY_NAME)) {
    logger.warn(Messages.get("MySQL2DriverDialect.cleartextPluginRequiresEncryption"));
    return;
  }

  driverProperties.set(MySQL2DriverDialect.CLEARTEXT_PLUGIN_PROPERTY_NAME, true);
}
```

4 つの `return` を順に読む。

1. `enableCleartextPlugin` が**すでにある** (`true` でも `false` でも) → 何もしない。ユーザの明示指定が最優先
2. `plugins` にトークン認証のコードが**ない** → 何もしない。固定パスワードや Secrets Manager の接続には無関係
3. `ssl` が **falsy** → 警告を出して、立てない。接続は mysql2 の `MYSQL_CLEAR_PASSWORD_NOT_ENABLED` で落ちる
4. ここまで来たら `true` を入れる

警告文は [`messages.ts#L408`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/messages.ts#L408)。

> Token-based authentication requires the 'mysql_clear_password' authentication plugin, which sends the token in plaintext at the protocol level. It has not been enabled because the connection is not encrypted. Configure the 'ssl' connection property, or set 'enableCleartextPlugin' explicitly if you accept sending the token unencrypted.

「何が起きたか」「なぜ立てなかったか」「どう直すか」「それでも平文で送りたいならどう書くか」が 1 文ずつ入っている。

### `ssl` の判定は truthy かどうかだけ

`driverProperties.get("ssl")` を `!` で見ているだけなので、`ssl: { ca: "..." }` も `ssl: "Amazon RDS"` (mysql2 の組み込みプロファイル名) も `ssl: {}` も通る。`ssl: false` や未指定は通らない。**TLS が実際に張られたかは見ていない**。mysql2 のオプションに `ssl` があれば「暗号化される予定」と見なしている。

これは mysql2 側の判定と対になっている。前提ページで見たとおり、mysql2 の `mysql_clear_password` 拒否は `enableCleartextPlugin` の有無だけを見て、接続が TLS かどうかは見ない。だから**「暗号化されているときだけ平文プラグインを許す」という安全側の条件は、mysql2 にはどこにも無く、ラッパのこの 1 行にしかない**。

### 内部プール経路では呼ばれない

同じファイルの [`preparePoolClientProperties`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/mysql2_driver_dialect.ts#L53) は `createPool` に渡すオプションを組み立てるが、`setCleartextPluginForTokenAuth` を呼んでいない。

```ts title="mysql/lib/dialect/mysql2_driver_dialect.ts"
preparePoolClientProperties(props: Map<string, any>, poolConfig: AwsPoolConfig | undefined): any {
  const finalPoolConfig: PoolOptions = {};
  const finalClientProps = WrapperProperties.removeWrapperProperties(props);
  this.setKeepAliveProperties(finalClientProps, props.get(WrapperProperties.KEEPALIVE_PROPERTIES.name));
  this.setConnectTimeout(finalClientProps, props.get(WrapperProperties.WRAPPER_CONNECT_TIMEOUT.name));

  Object.assign(finalPoolConfig, Object.fromEntries(finalClientProps.entries()));
  finalPoolConfig.connectionLimit = poolConfig?.maxConnections;
  // ...
  return finalPoolConfig;
}
```

`InternalPooledConnectionProvider` (readWriteSplitting の内部プール、`AwsMySQLPoolClient`) を IAM と組み合わせると、3.0.0 の修正が効かず、2.x と同じく `enableCleartextPlugin: true` を自分で書く必要がある ([内部コネクションプール](../internal-connection-pool/))。

### テストの有無

`tests/` を `setCleartextPluginForTokenAuth` と `enableCleartextPlugin` で検索しても 1 件も出ない。単体テストは無く、統合テスト環境の Aurora MySQL で IAM 認証が通ることでしか担保されていない。

## なぜそうなっているか

### なぜ認証プラグインではなく DriverDialect が立てるのか

`iam` / `federatedAuth` / `okta` の 3 プラグインは、どれも最後は「`password` にトークンを入れる」で終わる ([IAM 認証プラグイン](../iam-plugin/)、[federatedAuth / okta](../federated-and-okta/))。3 つが同じ MySQL の事情を抱え、PG では要らない。

この「ドライバ固有で、複数プラグインに共通する癖」を置く場所として、ラッパには `DriverDialect` がある ([2 種類の Dialect](../two-dialects/))。`keepAlive` を例外にするのも、`connectTimeout` の名前を付け替えるのも同じファイルにある。3 プラグインそれぞれに `if (mysql) props.set("enableCleartextPlugin", true)` を書くより、mysql2 に渡す直前の 1 点で吸収するほうが、プラグイン側は PG と MySQL の違いを知らずに済む。

代償は、`DriverDialect` が「どのプラグインが有効か」を `plugins` の文字列で判定するしかないことである。プラグインのインスタンスは chain の中にあり、`DriverDialect` からは見えない。

### なぜ `ssl` を条件にするのか

トークンは 15 分有効な資格情報である。平文で流れれば、その 15 分は誰でも同じ DB に入れる。mysql2 が `enableCleartextPlugin` を既定 `false` にしているのはそのためで、ラッパが黙って `true` にするなら、mysql2 が守ろうとしていたものを別の形で守り直す必要がある。それが `ssl` の条件で、ドキュメントコメントの "It is never enabled silently on an unencrypted connection" がその宣言である。

`ssl` なしのときに**例外ではなく警告**なのは、その先で mysql2 が `MYSQL_CLEAR_PASSWORD_NOT_ENABLED` の fatal エラーを出すからである。ラッパが止めなくても接続は失敗し、ログには警告とエラーの両方が残る。例外にすると、UNIX ソケット経由など TLS 以外の安全な経路で `enableCleartextPlugin` を自分で立てたい人を巻き込む。

### なぜ明示指定を最優先にするのか

`driverProperties.has(...)` で `true` / `false` を区別せず「あれば触らない」なのは、ユーザが `false` と書いたなら「平文プラグインは絶対に使わない」という意思であり、ラッパが `ssl` を見て `true` に変えるのは越権だからである。逆に `true` と書いたなら、`ssl` なしでも通す。docs の "Set `enableCleartextPlugin: true` yourself only if you have accepted that risk" がこの分岐に対応する。

## どう活かすか

- **下位ライブラリの安全装置を上位で外すなら、同等の条件を上位で持ち直す。** mysql2 の既定 `false` を `true` にするラッパは、mysql2 が見ていない「暗号化されているか」を自分で見る
- **既定値の自動調整は「明示指定があれば触らない」を最初の `return` にする。** 値の中身を見ずに `has` で抜けるのが一番単純で、ユーザの意思を上書きしない
- **警告文には「何が起きた・なぜ・どう直す・別の選択肢」を 1 文ずつ入れる。** 接続失敗のログに並んで出るので、そこだけ読めば直せる
- **複数の機能に共通するドライバの癖は、ドライバに渡す直前の 1 点に集める。** 機能側に散らすと 1 つ直したときに他が漏れる。ただし今回のように「渡す直前」が 2 か所 (`connect` と `preparePoolClientProperties`) あると、片方だけ直って片方が漏れる

### 実務で踏む失敗パターン

- **`ssl` を渡さない。** 警告が出て `MYSQL_CLEAR_PASSWORD_NOT_ENABLED` で落ちる。RDS の CA バンドルを `ssl: { ca: readFileSync(...) }` で渡すか、mysql2 の組み込み `ssl: "Amazon RDS"` を使う
- **内部プールで IAM を使う。** `preparePoolClientProperties` は判定を通らないので `enableCleartextPlugin: true` を自分で書く。書いたうえで `ssl` も付ける
- **`enableCleartextPlugin: false` を明示している。** 警告すら出ずに接続失敗する。過去に「平文プラグインを禁止する」目的で書いた設定が、IAM 移行時に原因不明のログイン失敗になる
- **`plugins` を `profileName` で指定する。** `plugins` の文字列に `iam` が出てこないので判定を通らない。ただし Configuration Profile は MySQL では例外になるので、そもそも到達しない
- **PG から MySQL に切り替えたら IAM が動かない。** docs のとおり PG 側にこの制約は無く ("PostgreSQL is unaffected")、`pg` ドライバには平文プラグインを拒む仕組みが無い。PG で動いていた `ssl` なしの設定を MySQL に持ってくると 3 番目の `return` で止まる
