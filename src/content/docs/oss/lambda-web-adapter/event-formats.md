---
title: "4 つのイベント形式 — REST API・HTTP API・ALB・Function URL"
description: "アダプタに届くイベント JSON は 4 種類、実質 3 フォーマットある。lambda_http の変換関数を読んでフィールドの対応表を作り、ALB のクエリだけ percent-encoding されたまま来ることや、ステージ名がパスに前置される仕組みを確認する。"
group: "Lambda 実行環境と Runtime API"
sidebar:
  order: 9
---

## 何を学んだか

`GET /next` のボディに入っているイベント JSON は、HTTP のフロントエンドが何であるかによって形が違う。Web Adapter が相手にするのは主に 4 つ。

| 呼び出し元           | フォーマット         | `lambda_http` の変換関数      |
| -------------------- | -------------------- | ----------------------------- |
| API Gateway REST API | payload v1           | `into_proxy_request`          |
| API Gateway HTTP API | payload v2           | `into_api_gateway_v2_request` |
| ALB                  | ALB 独自 (v1 に近い) | `into_alb_request`            |
| Lambda Function URL  | payload v2           | `into_api_gateway_v2_request` |

**Function URL は HTTP API と同じ v2 フォーマット**なので、実質 3 フォーマットだ。どれも最終的には `http::Request<Body>` に変換され、その先は同じコードを通る。

主要フィールドの対応はこうなる。

| 意味             | REST (v1)                                                   | HTTP API / Function URL (v2)                   | ALB                                                                               |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| パス             | `path`                                                      | `rawPath`                                      | `path`                                                                            |
| メソッド         | `httpMethod`                                                | `requestContext.http.method`                   | `httpMethod`                                                                      |
| クエリ           | `queryStringParameters` + `multiValueQueryStringParameters` | `rawQueryString` (生の文字列)                  | `queryStringParameters` + `multiValueQueryStringParameters` (**percent-encoded**) |
| ヘッダ           | `headers` + `multiValueHeaders`                             | `headers` のみ                                 | `headers` + `multiValueHeaders`                                                   |
| Cookie           | ヘッダに含まれる                                            | `cookies` 配列                                 | ヘッダに含まれる                                                                  |
| ステージ         | `requestContext.stage`                                      | `requestContext.stage` (`$default` になりうる) | なし                                                                              |
| 識別用フィールド | `requestContext.resourceId` など                            | `version: "2.0"`                               | `requestContext.elb`                                                              |
| ボディ           | `body` + `isBase64Encoded`                                  | 同左                                           | 同左                                                                              |

## ソースコードのどこか

### v1: `into_proxy_request`

```rust title="lambda-http/src/request.rs"
fn into_proxy_request(ag: ApiGatewayProxyRequest) -> http::Request<Body> {
    let http_method = ag.http_method;
    let host = ag
        .headers
        .get(http::header::HOST)
        .and_then(|s| s.to_str().ok())
        .or(ag.request_context.domain_name.as_deref());
    let raw_path = ag.path.unwrap_or_default();
    let path = apigw_path_with_stage(&ag.request_context.stage, &raw_path);
    ...
    // merge headers into multi_value_headers and make
    // multi-value_headers our cannoncial source of request headers
    let mut headers = ag.multi_value_headers;
    headers.extend(ag.headers);
```

[`lambda-http/src/request.rs#L173-L224`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L173-L224)

**`multiValueHeaders` を土台にして `headers` を上書きする**という順序になっている。`multiValueHeaders` は `headers` の上位集合なので、これで単一値も複数値も落とさずに 1 つの `HeaderMap` にまとまる。クエリも同じ方針で、`multi_value_query_string_parameters` が空でなければそちらを優先している。

### v2: `into_api_gateway_v2_request`

```rust title="lambda-http/src/request.rs"
fn into_api_gateway_v2_request(ag: ApiGatewayV2httpRequest) -> http::Request<Body> {
    let http_method = ag.request_context.http.method.clone();
    ...
    let raw_path = ag.raw_path.unwrap_or_default();
    let path = apigw_path_with_stage(&ag.request_context.stage, &raw_path);

    // don't use the query_string_parameters from API GW v2 to
    // populate the QueryStringParameters extension because
    // the value is not compatible with the whatgw specification.
    // See: https://github.com/aws/aws-lambda-rust-runtime/issues/470
    // See: https://url.spec.whatwg.org/#urlencoded-parsing
    let query_string_parameters = if let Some(query) = &ag.raw_query_string {
        query.parse().unwrap() // this is Infallible
    } else {
        ag.query_string_parameters
    };
```

[`lambda-http/src/request.rs#L111-L170`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L111-L170)

v2 では**メソッドが `requestContext.http.method` の中にある**。トップレベルの `httpMethod` は存在しない。

クエリは `queryStringParameters` を捨てて `rawQueryString` を自前でパースし直している。理由がコメントとリンクで明示されていて、API Gateway v2 が組み立てる `queryStringParameters` が WHATWG の urlencoded パース規則と互換でないからだ。

Cookie も v2 固有の扱いになる。

```rust title="lambda-http/src/request.rs"
let mut headers = ag.headers;
if let Some(cookies) = ag.cookies {
    if let Ok(header_value) = HeaderValue::from_str(&cookies.join(";")) {
        headers.insert(http::header::COOKIE, header_value);
    }
}
```

[`lambda-http/src/request.rs#L148-L153`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L148-L153)

v2 には `multiValueHeaders` が無く `headers` の単一マップしかない。複数値を持つヘッダはその 1 つの値の中に押し込まれる。Cookie だけは配列として別枠が用意されているので、ここで `;` 区切りに再結合して `Cookie` ヘッダに戻している。

### ALB: percent-encoding のデコード

```rust title="lambda-http/src/request.rs"
fn into_alb_request(alb: AlbTargetGroupRequest) -> http::Request<Body> {
    let http_method = alb.http_method;
    let host = alb.headers.get(http::header::HOST).and_then(|s| s.to_str().ok());
    let raw_path = alb.path.unwrap_or_default();

    let query_string_parameters = decode_query_map(alb.query_string_parameters);
    let multi_value_query_string_parameters = decode_query_map(alb.multi_value_query_string_parameters);
```

[`lambda-http/src/request.rs#L227-L233`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L227-L233)

```rust title="lambda-http/src/request.rs"
fn decode_query_map(query_map: QueryMap) -> QueryMap {
    use std::str::FromStr;

    let query_string = query_map.to_query_string();
    let decoded = percent_encoding::percent_decode(query_string.as_bytes()).decode_utf8_lossy();
    QueryMap::from_str(&decoded).unwrap_or_default()
}
```

[`lambda-http/src/request.rs#L277-L284`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L277-L284)

**ALB だけ、クエリ文字列が percent-encoding されたまま届く。** リポジトリのフィクスチャがそれを示している。

```json title="lambda-http/tests/data/alb_request_encoded_query_parameters.json"
{ "queryStringParameters": { "myKey": "%3FshowAll%3Dtrue" } }
```

API Gateway はデコード済みの値を渡してくるのに、ALB は生のままにする。`decode_query_map` はこの差を吸収するために、いったんクエリ文字列に戻してデコードし、もう一度パースし直している。

もう 1 つ、ALB は `requestContext.elb` を持つことで他と区別される。`host` の取得も ALB だけ `Host` ヘッダ一本で、`requestContext.domainName` へのフォールバックが無い (ALB のイベントにそのフィールドが無いため)。

### 判別の順序

```rust title="lambda-http/src/request.rs"
/// This is not intended to be a type consumed by crate users directly. The order
/// of the variants are notable. Serde will try to deserialize in this order.
#[non_exhaustive]
#[doc(hidden)]
#[derive(Debug)]
pub enum LambdaRequest {
    #[cfg(feature = "apigw_rest")]
    ApiGatewayV1(ApiGatewayProxyRequest),
    #[cfg(feature = "apigw_http")]
    ApiGatewayV2(ApiGatewayV2httpRequest),
    #[cfg(feature = "alb")]
    Alb(AlbTargetGroupRequest),
    #[cfg(feature = "apigw_websockets")]
    WebSocket(ApiGatewayWebsocketProxyRequest),
    #[cfg(feature = "pass_through")]
    PassThrough(String),
}
```

[`lambda-http/src/request.rs#L40-L56`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L40-L56)

**バリアントの順序が意味を持つ。** serde がこの順に deserialize を試み、最初に成功した型が採用される。そして最後の `PassThrough(String)` が「どれにも当てはまらなかったイベント」を丸ごと文字列として拾う。SQS でも S3 でも Bedrock Agent でもここに落ちる。この判別の詳細は [イベント JSON をどのイベント型か判別する](../lambda-http-request/) で扱う。

### 共通: base64 とステージ名と URI

ボディの扱いは 3 つの変換関数すべてで同じだ。

```rust
ag.body
    .as_deref()
    .map_or_else(Body::default, |b| Body::from_maybe_encoded(base64, b))
```

`isBase64Encoded` フラグを `Body::from_maybe_encoded` に渡し、真ならデコードして `Body::Binary`、偽ならそのまま `Body::Text` にする。バイナリを扱うフロントエンドの設定に応じてフラグが立つので、アプリ側はこの違いを意識しないで済む。

ステージ名の扱いは v1 / v2 / WebSocket に共通の関数にまとまっている (ALB は呼んでいない)。

```rust title="lambda-http/src/request.rs"
fn apigw_path_with_stage(stage: &Option<String>, path: &str) -> String {
    if env::var("AWS_LAMBDA_HTTP_IGNORE_STAGE_IN_PATH").is_ok() {
        return path.into();
    }

    let stage = match stage {
        None => return path.into(),
        Some(stage) if stage == "$default" => return path.into(),
        Some(stage) => stage,
    };

    let prefix = format!("/{stage}/");
    if path.starts_with(&prefix) {
        path.into()
    } else {
        format!("/{stage}{path}")
    }
}
```

[`lambda-http/src/request.rs#L359-L376`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L359-L376)

**ステージ名がパスに前置される。** `stage: "prod"` で `path: "/hello"` なら `/prod/hello` になる。無効化の条件は 3 つ: 環境変数 `AWS_LAMBDA_HTTP_IGNORE_STAGE_IN_PATH` が設定されている、`stage` が無い、`stage` が `$default`。HTTP API の既定ステージと Function URL は `$default` なので前置されない。すでに `/{stage}/` で始まっているパスは二重に付けない。

この挙動は Web Adapter の `AWS_LWA_REMOVE_BASE_PATH` と正面から干渉する。詳細は [ベースパス除去とステージ名の相互作用](../base-path-and-stage/) で扱う。

最後に URI の組み立て。

```rust title="lambda-http/src/request.rs"
fn build_request_uri(
    path: &str,
    headers: &HeaderMap,
    host: Option<&str>,
    queries: Option<(&QueryMap, &QueryMap)>,
) -> String {
    let mut url = match host {
        None => {
            let rel_url = Url::parse(&format!("http://localhost{path}")).unwrap();
            rel_url.path().to_string()
        }
        Some(host) => {
            let scheme = headers
                .get(x_forwarded_proto())
                .and_then(|s| s.to_str().ok())
                .unwrap_or("https");
            let url = format!("{scheme}://{host}{path}");
            Url::parse(&url).unwrap().to_string()
        }
    };
    ...
}
```

[`lambda-http/src/request.rs#L483-L515`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/request.rs#L483-L515)

`host` は `Host` ヘッダ、無ければ `requestContext.domainName` (ALB は前者のみ)。スキームは `x-forwarded-proto` ヘッダ、無ければ `https`。両方揃えば `https://api.example.com/prod/hello` という絶対 URI になり、`host` が取れなければパスだけの相対 URI に落ちる。`Url::parse` を通しているので、ここで正規化もかかる。

## なぜそうなっているか

**フォーマットが分かれているのは、それぞれのフロントエンドが別々の時期に別々の要求で作られたからだ。** REST API の v1 は「HTTP のあらゆる要素を漏れなく表現する」方向で、`headers` と `multiValueHeaders` の両方を持つ冗長な形になった。HTTP API の v2 はそれを整理し、単一マップに統一したうえで、どうしても複数値が要る Cookie だけ配列で切り出した。ALB は API Gateway とは別系統のサービスなので、また少し違う。

**ALB のクエリがエンコードされたままなのは、ALB がリクエストの中身を解釈しないロードバランサだからだ。** API Gateway はリクエストを「API の呼び出し」として理解し、パスパラメータやクエリを構造化して渡す。ALB は「HTTP リクエストを転送する」だけの存在で、ターゲットに届ける情報をなるべく生のまま保つ。だからデコードはターゲット側 (この場合ランタイム) の仕事になる。

**`multiValueHeaders` を土台にして `headers` で上書きするのは、ALB のオプション設定に対応するためでもある。** ALB は multi-value headers を有効化するかどうかで送ってくるフィールドが変わる。無効なら `headers` だけ、有効なら `multiValueHeaders` も付く。どちらか一方を前提にすると片方で壊れるので、両方をマージする形にしてある。この非対称性はレスポンス側にも波及していて、`lambda_http` は ALB 向けのレスポンスで `headers` と `multiValueHeaders` の両方を埋めている ([レスポンスが base64 になるかを決めているところ](../lambda-http-response/))。

**ステージ名をパスに前置するのは、API Gateway が実際にそのパスで公開しているからだ。** REST API のデフォルトエンドポイントは `https://{api-id}.execute-api.{region}.amazonaws.com/{stage}/...` という形をしていて、ブラウザから見えるパスにはステージ名が入っている。一方イベントの `path` にはステージが含まれない。ここで前置しないと、アプリが生成する相対リンクや `Location` ヘッダがステージを落としてしまう。逆にカスタムドメイン + ベースパスマッピングを使っている場合は URL 側にステージが現れないので、前置が邪魔になる。`AWS_LAMBDA_HTTP_IGNORE_STAGE_IN_PATH` はそのための逃げ道だ。

## どう活かすか

**どのフロントエンドを使うか決めるときは、この表の差が実際の挙動差になる。** 同じアプリでも、REST API 経由と HTTP API 経由でパスが `/prod/hello` と `/hello` に変わる。ALB 経由ではクエリのデコードが `lambda_http` に依存する。ステージング環境とプロダクションで別のフロントエンドを使っていると、この差でしか再現しないバグが出る。

**`isBase64Encoded` は上りにも下りにもある。** 画像アップロードが壊れる、レスポンスのバイナリが化ける、といった症状はこのフラグの取り違えであることが多い。上りは `Body::from_maybe_encoded` が処理してくれるが、下りは Web Adapter がレスポンスの `Content-Type` を見て判断する。詳細は [レスポンスが base64 になるかを決めているところ](../lambda-http-response/) にある。

**判別に失敗しても落ちない、というのは運用上の安心材料になる。** `PassThrough` があるおかげで、SQS や EventBridge から同じ関数を呼んでも `POST /events` としてアプリに届く。1 つの Web アプリで HTTP リクエストと非同期イベントの両方を処理する、という構成が取れる ([非 HTTP イベントを POST /events に流す](../pass-through/))。

**リポジトリのフィクスチャは仕様書として使える。** `lambda-http/tests/data/` に v1 / v2 / ALB / Function URL / multi-value / エンコード済みクエリ / SAM local といった実物の JSON が揃っている。イベント形式の細部を確認したいとき、ドキュメントを読むよりこちらを見る方が速い。
