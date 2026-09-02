---
title: "ストリーミングを端から端まで追う"
description: "アプリが書いた 1 バイトが、アダプタと lambda_http と lambda_runtime を通って Runtime API に届くまでの 9 段を 1 本で追う。どこにもバッファリングポイントがないことを確認し、逆にバッファが混入する条件を数え上げる。"
group: "レスポンスを返す"
sidebar:
  order: 33
---

## 何を学んだか

ストリーミングが「本当に流れている」かどうかは、経路上のどこか 1 か所でもボディを読み切っている場所があるかどうかで決まる。1 か所あれば、そこで全部止まる。

`AWS_LWA_INVOKE_MODE=response_stream` のときの経路には、**その 1 か所がない**。アプリが書いたバイトは、アダプタでも `lambda_http` でも `lambda_runtime` でも一度も `collect()` されず、チャンクのまま Runtime API への chunked ボディに乗る。

このページはその 9 段を順に確認する。ワイヤ形式そのもの (メタデータプレリュードと NUL 8 バイトの区切り) は [ストリーミングレスポンスのワイヤ形式](../response-streaming-protocol/) に譲り、ここでは**バッファリングポイントの不在**だけを追う。

## ソースコードのどこか

```mermaid
sequenceDiagram
    participant APP as アプリ 8080番
    participant FR as Adapter::fetch_response
    participant SS as lambda_http into_stream_response
    participant BS as BodyStream
    participant EC as EventCompletionRequest into_req
    participant RAPI as Runtime API 9001番
    participant CL as クライアント

    APP->>FR: 1. chunked でレスポンスを書き始める
    FR->>FR: 2. client.request(request).await が Response&lt;Incoming&gt; を返す<br/>ボディはまだ読まれていない
    FR->>FR: 3. error_status_codes が未設定なら collect() されずに素通り
    FR->>FR: 4. transfer-encoding ヘッダを削除
    FR->>SS: 5. Response&lt;Incoming&gt;
    SS->>SS: set-cookie を MetadataPrelude.cookies へ移す
    SS->>BS: 6. StreamResponse&lt;BodyStream&lt;Incoming&gt;&gt;
    BS->>EC: 7. http_body::Body を futures::Stream として poll
    EC->>RAPI: 8. Body::channel() 経由で prelude → NUL x8 → チャンク列
    RAPI->>CL: 9. Function URL / API Gateway のレスポンスへ
```

### 2. ボディを読まずに返す

`fetch_response` がアプリに投げて受け取るところ ([`src/lib.rs#L933`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L933))。

```rust title="src/lib.rs"
let mut app_response = self.client.request(request).await?;
```

この `await` が返るのは**レスポンスのヘッダが揃った時点**であって、ボディが届き終わった時点ではない。`app_response` の型は `Response<Incoming>` で、`Incoming` は「これから読むもの」を表す hyper のボディ型である。アプリが 10 分かけて書き続けるレスポンスでも、`await` はヘッダが来た瞬間に返る。

`Service` の関連型もこれをそのまま外へ出している。

```rust title="src/lib.rs"
impl Service<Request> for Adapter<HttpConnector, Body> {
    type Response = Response<Incoming>;
```

([`src/lib.rs#L1047`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1047))

**アダプタは「読み終わったボディ」ではなく「これから読めるボディ」を返す。** buffered モードとストリーミングモードで同じ `Service` 実装が使い回せているのはこの型のおかげで、読むかどうかは下流に委ねられている。

### 3. 唯一の `collect()`

`fetch_response` の中でボディを読み切る箇所は 1 か所しかない ([`src/lib.rs#L1015`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1015))。

```rust title="src/lib.rs"
if let Some(error_codes) = &self.error_status_codes {
    let status = app_response.status().as_u16();
    if error_codes.contains(&status) {
        let body_bytes = app_response
            .into_body()
            .collect()
            .await
            // ...
```

`AWS_LWA_ERROR_STATUS_CODES` が設定されていて、かつステータスが一致したときだけ通る。エラーメッセージにボディを埋め込むためには読み切るしかないので、これは避けられない ([ステータスコードを Lambda のエラーに変える](../error-status-codes/))。設定していなければ `if let` に入らず、ボディは触られない。

### 5〜6. ヘッダとボディを分ける

`into_stream_response` がやることは 2 つだけである ([`lambda-http/src/streaming.rs#L140`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/streaming.rs#L140))。

```rust title="lambda-http/src/streaming.rs"
let mut headers = parts.headers;
let cookies = headers
    .get_all(SET_COOKIE)
    .iter()
    .map(|c| String::from_utf8_lossy(c.as_bytes()).to_string())
    .collect::<Vec<_>>();
headers.remove(SET_COOKIE);

StreamResponse {
    metadata_prelude: MetadataPrelude { headers, status_code: parts.status, cookies },
    stream: BodyStream { body },
}
```

`set-cookie` を専用フィールドに移し替えるのは、メタデータプレリュードの `headers` が JSON オブジェクト、つまりキーが一意なマップだからである。`Set-Cookie` は複数行になりうる唯一級のヘッダなので、配列を持つ `cookies` に分離しないと 1 個しか運べない。

ボディは `BodyStream { body }` に包まれるだけで、**1 バイトも読まれない**。

### 7. Body を Stream に変える

`BodyStream` は `http_body::Body` を `futures::Stream` に変換するアダプタである ([`lambda-http/src/streaming.rs#L235`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/streaming.rs#L235))。

```rust title="lambda-http/src/streaming.rs"
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
    match futures_util::ready!(self.as_mut().project().body.poll_frame(cx)?) {
        Some(frame) => match frame.into_data() {
            Ok(data) => Poll::Ready(Some(Ok(data))),
            Err(_frame) => Poll::Ready(None),
        },
        None => Poll::Ready(None),
    }
}
```

1 フレーム来たら 1 アイテム出す。溜めない。`http_body::Body` にはデータフレームとトレーラフレームの 2 種類があり、`frame.into_data()` が `Err` を返すのはトレーラが来たときで、そこでストリームを終端している。

### 8. Runtime API へ流し込む

`EventCompletionRequest::into_req` の `StreamingResponse` の腕が、送信側の実体である ([`lambda-runtime/src/requests.rs#L81`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-runtime/src/requests.rs#L81))。

```rust title="lambda-runtime/src/requests.rs"
let (mut tx, rx) = Body::channel();

tokio::spawn(async move {
    if tx.send_data(metadata_prelude.into()).await.is_err() { /* ... */ return; }
    if tx.send_data("\u{0}".repeat(8).into()).await.is_err() { /* ... */ return; }

    while let Some(chunk) = response.stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk.into(),
            Err(err) => err.into().to_tailer().into(),
        };
        if tx.send_data(chunk).await.is_err() { /* ... */ return; }
    }
});

let req = builder.body(rx)?;
```

ポイントは `Body::channel()` と `tokio::spawn` の組み合わせにある。`into_req` は**リクエストを組み立てて即座に返す**。ボディの中身を書くのは別タスクで、HTTP リクエストが送信されている最中に、並行してチャンクを流し込む。`into_req` がボディを全部用意してから返す設計だったら、ここが最後のバッファリングポイントになっていた。

送信されるリクエストのヘッダはこうなる。

```text
POST /2018-06-01/runtime/invocation/<request-id>/response HTTP/1.1
Transfer-Encoding: chunked
Content-Type: application/vnd.awslambda.http-integration-response
Lambda-Runtime-Function-Response-Mode: streaming
Trailer: Lambda-Runtime-Function-Error-Type
Trailer: Lambda-Runtime-Function-Error-Body
```

`Trailer` が 2 つ宣言されているのは、**ストリームの途中で起きたエラーを報告する経路**を確保するためである。ヘッダは既に送ってしまっているのでステータスコードはもう変えられない。途中でアプリが落ちたら、トレーラでエラー種別を伝えるしかない。`Err(err) => err.into().to_tailer().into()` がその変換である。

## なぜバッファリングポイントがないと言えるか

経路上でボディに触るコードを数えると、次の 4 か所しかない。

1. `fetch_response` の `error_status_codes` 分岐 — 条件付きで `collect()`
2. `into_stream_response` — 触らない (`BodyStream` に包むだけ)
3. `BodyStream::poll_next` — 1 フレームを 1 アイテムに変換して即返す
4. `into_req` の spawn したタスク — 1 チャンクを受け取って即 `send_data`

1 番以外はどれも「受け取ったものをその場で次へ渡す」だけで、`Vec` に溜める処理も、サイズを数える処理も、`Content-Length` を計算する処理もない。**サイズを知る必要がある処理が一切ないこと**が、バッファがない証拠になっている。buffered モードにあった `ConvertBody`、`LambdaResponse` への詰め替え、base64 エンコードは、いずれもボディ全体を必要とする処理だが、ストリーミング経路にはそのどれも存在しない ([レスポンスが base64 になるかを決めているところ](../lambda-http-response/))。

逆に、**バッファが混入する条件は次の 3 つ**である。

- **`AWS_LWA_ERROR_STATUS_CODES` が設定されていて、該当ステータスが返った場合。** これはストリーミングモードでも効く。500 番台をエラー扱いにしていると、500 を返すレスポンスだけはボディが読み切られる (そしてストリームではなく `/error` への POST になる)。エラーレスポンスなら通常は問題ないが、「ストリーミングしながら途中で 500 を返す」ような設計とは相性が悪い。
- **アプリ側のフレームワークが自分でバッファする場合。** Express の `compression` ミドルウェアは既定でレスポンスをバッファするし、`res.write()` を呼んでも flush されないテンプレートエンジンもある。Nginx をアプリの前段に置いているなら `proxy_buffering` が効く。アダプタから先が完璧でも、アダプタに届く前で止まっていたら意味がない。**ストリーミングが効かないときは、まずアプリ単体を `curl -N` で叩いて確認する**のが早い。
- **`AWS_LWA_ENABLE_COMPRESSION` を有効にした場合。** ただしこれは `Adapter::new` で検出されて圧縮側が無効化されるので、実際にはバッファは混入しない。警告ログが出るだけである ([レスポンス圧縮と、ストリーミングと併用できない理由](../compression/))。

## どう活かすか

**ストリーミングはトリガーを選ぶ。** Lambda のレスポンスストリーミングが使えるのは Function URL、`InvokeWithResponseStream` API、そして API Gateway のレスポンスストリーミング用プロキシ統合である ([Response streaming for Lambda functions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html))。**ALB は対応していない。** ALB の背後で LWA を使うなら buffered のままにするしかない。API Gateway 側は通常のプロキシ統合とは統合 URI が異なり、`.../2021-11-15/functions/<arn>/response-streaming-invocations` を指す必要がある ([Set up a Lambda proxy integration with payload response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html))。コンソールから設定すれば自動で切り替わるが、IaC で書くなら明示が要る。

**設定は 2 か所ある。** アダプタの `AWS_LWA_INVOKE_MODE=RESPONSE_STREAM` と、Function URL の `InvokeMode: RESPONSE_STREAM`。片方だけでは動かない ([buffered と response_stream — run() の 3 分岐](../buffered-vs-streaming/))。

**上限とバンド幅の性質が buffered と違う。** ストリーミングのレスポンスは最大 200 MB (buffered は 6 MB)。ただし最初の 6 MB を超えた部分にはバンド幅の上限がかかる。また、**クライアントが接続を切ってもストリーミングは止まらず、関数の実行時間は最後まで課金される**とドキュメントに明記されている。長いタイムアウトを設定した関数でストリーミングを使うときは、この点を見ておく価値がある。

**SSE を返すなら `Content-Type` を明示する。** `into_req` は、プレリュードの `Content-Type` が未設定なら `application/octet-stream` を入れる。

```rust title="lambda-runtime/src/requests.rs"
preloud_headers
    .entry(CONTENT_TYPE)
    .or_insert("application/octet-stream".parse()?);
```

`entry().or_insert()` なので、アプリが `text/event-stream` を付けていればそれが尊重される。逆にアプリ側で `Content-Type` を付け忘れると、ブラウザの `EventSource` が受け付けない `application/octet-stream` で届く。SSE の実装で「サーバ側では書けているのにブラウザがイベントを拾わない」ときは、ここを疑う。
