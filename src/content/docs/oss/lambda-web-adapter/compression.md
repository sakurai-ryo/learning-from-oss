---
title: "レスポンス圧縮と、ストリーミングと併用できない理由"
description: "AWS_LWA_ENABLE_COMPRESSION は tower-http の CompressionLayer を 1 行挟むだけの機能である。それがストリーミングと併用できない理由を、警告ログ・run() の match・lambda_http の ConvertBody という 3 つの層から確認する。"
group: "レスポンスを返す"
sidebar:
  order: 31
---

## 何を学んだか

`AWS_LWA_ENABLE_COMPRESSION=true` でできることは、`Adapter` を `CompressionLayer` で包むこと、それだけである。

```rust title="src/lib.rs"
(true, LambdaInvokeMode::Buffered) => {
    let svc = ServiceBuilder::new().layer(CompressionLayer::new()).service(self);
    lambda_http::run_concurrent(svc).await
}
```

([`src/lib.rs#L862`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L862))

圧縮のコードは LWA には 1 行もない。`tower_http::compression::CompressionLayer` が全部やる。`Adapter` が `tower::Service` である以上、ミドルウェアを外側に巻くだけで機能が増える、という [3 層の tower::Service スタック](../tower-service-stack/) の恩恵がそのまま出ている。

そして**この機能はストリーミングと併用できない**。その理由が 1 つではなく 3 つの層に積み重なっているのが、このページの読みどころである。

## ソースコードのどこか

### 何で圧縮されるのか

依存関係の指定でアルゴリズムが決まっている。

```toml title="Cargo.toml"
tower-http = { version = "0.6.8", features = ["compression-gzip", "compression-br"] }
```

([`Cargo.toml`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/Cargo.toml))

有効なのは **gzip と brotli の 2 つだけ**である。`compression-deflate` も `compression-zstd` も入っていない。`CompressionLayer` はリクエストの `Accept-Encoding` を見て、有効化されているアルゴリズムの中から 1 つ選び、レスポンスのボディを圧縮して `Content-Encoding` ヘッダを付ける。`Accept-Encoding` に gzip も br もなければ、何もせず素通しする。

デフォルト値は `false` で、環境変数のパースに失敗したときも `false` になる ([`src/lib.rs#L426`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L426))。

```rust title="src/lib.rs"
compression: env::var(ENV_ENABLE_COMPRESSION)
    .unwrap_or_else(|_| "false".to_string())
    .parse()
    .unwrap_or(false),
```

### 併用できない理由、3 層

**第 1 層: 設定を作る時点で潰す。** `Adapter::new` が組み合わせを検出して、圧縮側を落とす。

```rust title="src/lib.rs"
let compression = if options.compression && options.invoke_mode == LambdaInvokeMode::ResponseStream {
    tracing::warn!("Compression is not supported with response streaming. Disabling compression.");
    false
} else {
    options.compression
};
```

([`src/lib.rs#L635`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L635))

**エラーにはしない。** 警告を出して圧縮だけを黙って諦める。両方を設定した関数がデプロイ後に起動しなくなるより、ログ 1 行で済ませて動かすほうを選んでいる。テストがこの挙動を固定している ([`src/lib.rs#L1324`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1324))。

```rust title="src/lib.rs"
let adapter = Adapter::new(&options).expect("Failed to create adapter");
assert!(
    !adapter.compression,
    "Compression should be disabled when invoke mode is ResponseStream"
);
```

対になる `test_compression_enabled_with_buffered` ([`src/lib.rs#L1339`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1339)) が、buffered なら落とされないことを保証している。片方だけだと「常に false を返す」実装でもテストが通ってしまうので、2 本セットで意味がある。

**第 2 層: 挟む場所がない。** `run()` の match は `(true, Buffered)` の腕でしか `ServiceBuilder` を組み立てない ([buffered と response_stream — run() の 3 分岐](../buffered-vs-streaming/))。第 1 層をすり抜けて `compression = true` と `ResponseStream` が同時に成立したとしても、`(_, LambdaInvokeMode::ResponseStream)` の腕に落ちてレイヤは巻かれない。第 1 層は「警告を出すため」にあり、正しさは第 2 層が担保している。

**第 3 層: 下流の変換が存在しない。** buffered モードでは、`lambda_http` がレスポンスボディを base64 にするかテキストのまま入れるかを `ConvertBody::convert` で判定する。その 1 行目がこれである。

```rust title="lambda-http/src/response.rs"
fn convert(self, headers: HeaderMap) -> BodyFuture {
    if headers.get(CONTENT_ENCODING).is_some() {
        return convert_to_binary(self);
    }
    // ... Content-Type を見て text か binary か決める
```

([`lambda-http/src/response.rs#L321`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/response.rs#L321))

**`Content-Encoding` があれば、`Content-Type` を一切見ずにバイナリ扱いにする。** gzip した `text/html` は UTF-8 文字列ではないので、これが正しい。圧縮されたレスポンスが buffered モードで壊れずに届くのは、この 3 行の分岐のおかげである ([レスポンスが base64 になるかを決めているところ](../lambda-http-response/))。

一方ストリーミング側の `into_stream_response` にはこの判定がない。

```rust title="lambda-http/src/streaming.rs"
StreamResponse {
    metadata_prelude: MetadataPrelude {
        headers,
        status_code: parts.status,
        cookies,
    },
    stream: BodyStream { body },
}
```

([`lambda-http/src/streaming.rs#L140`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-http/src/streaming.rs#L140))

ヘッダから `set-cookie` を抜き出すだけで、ボディには一切触らない。base64 化もしない。生バイトがそのままチャンクとして流れていく。

## なぜそうなっているか

**そもそもストリーミングと圧縮は目的が食い違う。** ストリーミングの価値は TTFB (最初の 1 バイトが届くまでの時間) を縮めることにある。ところが圧縮アルゴリズムは、効率を出すためにある程度のバイト数をバッファしてから出力する。チャンクごとに flush すれば圧縮率は落ち、圧縮率を優先すればチャンクが溜まってストリーミングの意味が薄れる。どちらに倒しても嬉しくない。

そのうえで `lambda_http` 側にストリーミング + 圧縮を扱う仕組みがない。ストリーミングのワイヤ形式は「メタデータの JSON → NUL 8 バイト → 生バイト列」で、この生バイト列に何が入っているかを Lambda 側は解釈しない ([ストリーミングレスポンスのワイヤ形式](../response-streaming-protocol/))。理屈のうえでは gzip 済みのバイト列を流して `Content-Encoding: gzip` をプレリュードに入れれば通るはずだが、`lambda_http` にその経路を検証したコードもテストもない。**サポートされていない組み合わせを、実装で表現するのではなく、設定段階で存在しないことにした**というのが LWA の選択である。

3 層に分かれているのは、それぞれ役割が違うからだ。第 1 層は運用者への通知、第 2 層は型と制御フローによる保証、第 3 層はそもそも下流に受け皿がないという事実。第 1 層だけだとコードを読む人に理由が伝わらず、第 2 層だけだと設定ミスに気づけない。

## どう活かすか

**Lambda のレスポンスサイズ上限に対して、圧縮は直接効く。** buffered モードのレスポンスペイロードは 6 MB が上限で、この制限は圧縮後のサイズに対してかかる。JSON や HTML なら gzip で数分の 1 になるので、上限にぶつかっていたレスポンスが通るようになることはある。

ただし**油断はできない**。buffered モードのボディはこのあと base64 エンコードされて JSON の文字列フィールドに入る。base64 は 3 バイトを 4 文字にするので、**サイズが約 4/3 に膨らむ**。「圧縮したから 6 MB に収まる」という見積もりをするときは、圧縮後のバイト数ではなく、その 4/3 を上限と比較すること。そして圧縮を有効にした瞬間、`Content-Encoding` が付くことで `ConvertBody` がバイナリ経路に入るので、**それまで base64 されていなかったテキストレスポンスも base64 されるようになる**。圧縮率が低いコンテンツでは、圧縮を有効にしたほうがペイロードが大きくなることさえありうる。

なお、6 MB の上限そのものを回避したいなら圧縮ではなくストリーミングを選ぶことになる。ストリーミングのレスポンス上限は 200 MB である ([Response streaming for Lambda functions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html))。ここでも「圧縮かストリーミングか」の二者択一が出てくる。

**二重圧縮を避ける判断が要る。** API Gateway には `minimumCompressionSize` という設定があり、これを有効にすると API Gateway 自身がレスポンスを圧縮する。アダプタ側でも圧縮していると、gzip したものをさらに gzip することになりかねない。どちらか一方に寄せるのが素直で、どちらに寄せるかは「圧縮の CPU コストを Lambda の課金対象時間で払うか、API Gateway 側で払うか」の問題になる。

**CPU コストはメモリ設定と直結している。** Lambda の CPU 割り当てはメモリ設定に比例するので、128 MB の関数で brotli をかけると、圧縮にかかる時間がそのまま実行時間として課金される。転送量とレイテンシのどちらを取るかは、レスポンスの大きさと関数のメモリ設定を見て決める話であり、常に有効にしておけばよい設定ではない。
