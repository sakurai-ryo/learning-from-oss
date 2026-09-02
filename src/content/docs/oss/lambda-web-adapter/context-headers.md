---
title: "コンテキストを HTTP ヘッダに詰める"
description: "API Gateway の requestContext と Lambda の Context を、JSON 文字列にして x-amzn-request-context / x-amzn-lambda-context ヘッダに入れる設計。なぜヘッダしか選べなかったのか、その代償は何かを読む。"
group: "リクエストを流す"
sidebar:
  order: 24
---

## 何を学んだか

アプリのコードを 1 文字も変えないのが LWA の売りだ。ならば「誰がこのリクエストを送ってきたか」「あと何ミリ秒で Lambda がタイムアウトするか」といった Lambda 固有の情報を、アプリにどう渡せばいいのか。

LWA の答えは**構造体を JSON 文字列にしてリクエストヘッダに入れる**だった。

```rust title="src/lib.rs"
// include request context in http header "x-amzn-request-context"
req_headers.insert(
    HeaderName::from_static("x-amzn-request-context"),
    HeaderValue::from_bytes(&strip_forbidden_header_bytes(&serde_json::to_string(&request_context)?))?,
);

// include lambda context in http header "x-amzn-lambda-context"
req_headers.insert(
    HeaderName::from_static("x-amzn-lambda-context"),
    HeaderValue::from_bytes(&strip_forbidden_header_bytes(&serde_json::to_string(&lambda_context)?))?,
);
```

([src/lib.rs#L961-L971](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L961-L971))

2 本とも `insert` なので、クライアントが同名のヘッダを送りつけてきても**上書きされる**。偽装したコンテキストがアプリに届くことはない。

## ソースコードのどこか

### x-amzn-request-context

中身は `lambda_http::request::RequestContext` を `serde_json` でシリアライズしたもの ([lambda-http/src/request.rs#L378-L398](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L378-L398))。

```rust title="lambda-http/src/request.rs"
#[non_exhaustive]
#[derive(Deserialize, Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum RequestContext {
    ApiGatewayV1(ApiGatewayProxyRequestContext),
    ApiGatewayV2(ApiGatewayV2httpRequestContext),
    Alb(AlbTargetGroupRequestContext),
    WebSocket(ApiGatewayWebsocketProxyRequestContext),
    PassThrough,
}
```

`#[serde(untagged)]` が効いているので、`{"ApiGatewayV2": {...}}` のようなラッパは付かず、**中身のオブジェクトがそのまま**ヘッダ値になる。つまりアプリが受け取るのは、イベント JSON の `requestContext` フィールドとほぼ同じものだ。

- HTTP API (v2): `http.method` / `http.path` / `http.sourceIp` / `requestId` / `stage` / `authorizer.jwt.claims` / `domainName` など
- REST API (v1): `identity.sourceIp` / `identity.userAgent` / `authorizer` / `requestId` / `stage` / `resourcePath` など
- ALB: `elb.targetGroupArn`
- PassThrough: enum のユニット variant なので `null` になる

イベント形式によって形が違う点に注意がいる。同じ「送信元 IP」でも v1 は `identity.sourceIp`、v2 は `http.sourceIp` にある。

### x-amzn-lambda-context

こちらは `lambda_runtime::Context` ([lambda-runtime/src/types.rs#L66-L88](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-runtime/src/types.rs#L66-L88))。フィールド名はリネームされていないので、JSON も Rust のフィールド名 (snake_case) がそのまま出る。

| フィールド                    | 中身                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| `request_id`                  | invocation ID                                                       |
| `deadline`                    | タイムアウト時刻 (エポックミリ秒)                                   |
| `invoked_function_arn`        | 呼ばれた関数の ARN (エイリアス/バージョン込み)                      |
| `xray_trace_id`               | X-Ray のトレース ID                                                 |
| `client_context` / `identity` | モバイル SDK / Cognito 経由の呼び出しでのみ入る                     |
| `tenant_id`                   | マルチテナンシー用のテナント ID                                     |
| `env_config`                  | `function_name` / `memory` / `version` / `log_stream` / `log_group` |

`Context` の値は `/invocation/next` のレスポンスヘッダから組み立てられたものだ ([/next のレスポンスヘッダが Context になる](../invocation-headers/))。つまり Runtime API のヘッダが、`Context` 構造体を経由して、もう一度別の HTTP ヘッダに化けている。

### tenant_id だけ扱いが違う

```rust title="src/lib.rs"
// Multi-tenancy support: propagate tenant_id from Lambda context
if let Some(ref tenant_id) = lambda_context.tenant_id {
    if let Ok(value) = HeaderValue::from_str(tenant_id) {
        req_headers.insert(HeaderName::from_static("x-amz-tenant-id"), value);
        tracing::debug!(tenant_id = %tenant_id, "propagating tenant_id header");
    } else {
        tracing::warn!(tenant_id = %tenant_id, "tenant_id contains invalid header characters, skipping");
    }
}
```

([src/lib.rs#L973-L981](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L973-L981))

`tenant_id` は `x-amz-tenant-id` として**素の文字列のまま**別ヘッダに出る。`x-amzn-lambda-context` の JSON にも同じ値が入っているので冗長だが、テナント ID はミドルウェアで頻繁に読む値なので、JSON をパースせずに取れる形が用意されている。

扱いが非対称なのはここだ。

- コンテキスト JSON: `strip_forbidden_header_bytes` で**不正バイトを落として必ず載せる**
- `tenant_id`: `HeaderValue::from_str` が失敗したら**警告を出して載せない**

つまり `tenant_id` が変な値だったときの挙動は「サニタイズして通す」ではなく「黙って落とす」。テナント ID を勝手に書き換えて渡すのは危険 (別テナントの ID になりうる) なので、値を歪めるくらいならヘッダごと無いほうが安全という判断に見える。アプリ側から見ると、**`x-amz-tenant-id` の欠如は「マルチテナントでない」とは限らない**ことになる。

## なぜそうなっているか

**なぜヘッダなのか。** アプリのコードを変えないという前提を置くと、渡せる場所は「標準的な HTTP リクエストの構成要素」に限られる。ボディはアプリのビジネスロジックが読むものなので触れない。パスとメソッドはルーティングを壊す。クエリ文字列を勝手に足すのもアプリの入力検証を壊しうる。残るのはヘッダだけだ。しかもヘッダなら、読まないアプリは完全に無視できる。

**なぜ JSON 文字列なのか。** `requestContext` は数十フィールドのネストしたオブジェクトで、しかも**イベント形式ごとにスキーマが違う**。もし `x-amzn-source-ip` `x-amzn-request-id` ... とフィールドごとにヘッダを分けたら、形式が増えるたびにヘッダ名の対応表が増え、ネストした `authorizer.claims` のような構造は表現できない。1 本のヘッダに丸ごと入れてしまえば、LWA 側の知識はゼロで済む。

代償はある。

- **ヘッダが太る。** Lambda オーソライザの `context` や JWT の claims が大きいと数 KB になる。アプリ側のヘッダサイズ上限 (Node.js の `maxHeaderSize` は既定 16KB) に当たる可能性がある。
- **パースがアプリの仕事になる。** 型も無い。
- **任意のバイト列がヘッダ値になりうる。** `requestContext` の中にはリクエストパスがそのまま入っている。これが実際に事故になった → [ヘッダに入れてはいけないバイトを落とす](../forbidden-header-bytes/)

## どう活かすか

Express なら、そのままパースするだけで読める。

```js
app.use((req, res, next) => {
  const ctx = req.headers["x-amzn-request-context"];
  const lambda = req.headers["x-amzn-lambda-context"];
  req.apigw = ctx ? JSON.parse(ctx) : null;
  req.lambda = lambda ? JSON.parse(lambda) : null;
  next();
});

app.get("/whoami", (req, res) => {
  // v2 は http.sourceIp、v1 は identity.sourceIp
  res.json({ ip: req.apigw?.http?.sourceIp ?? req.apigw?.identity?.sourceIp });
});
```

FastAPI なら `Request.headers.get("x-amzn-lambda-context")` を同じように読む。`deadline` はエポックミリ秒なので、残り時間はこう出る。

```python
import json, time
ctx = json.loads(request.headers["x-amzn-lambda-context"])
remaining_ms = ctx["deadline"] - int(time.time() * 1000)
```

長い処理の前に残り時間を見て、足りなければ 202 を返してキューに逃がす、といった制御ができる。これは他のランタイムの `context.getRemainingTimeInMillis()` に相当するものを、素の Web アプリから取る唯一の手段になる。

設計上の一般則としては 2 つ。**(1) 既存インタフェースを壊さずに追加情報を渡すなら、無視できるチャネル (ヘッダ、メタデータ、trailer) を選ぶ。(2) スキーマが呼び出し元ごとに違うなら、フィールドに展開せず 1 本の不透明な値として渡し、解釈を受け手に委ねる。** 中間層が構造を知らなくて済む分、上流の変更で壊れない。
