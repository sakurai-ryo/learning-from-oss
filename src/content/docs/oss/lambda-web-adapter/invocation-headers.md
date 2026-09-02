---
title: "/next のレスポンスヘッダが Context になる"
description: "GET /next のレスポンスは「ボディ = イベント JSON、ヘッダ = メタデータ」という形をしている。そのヘッダ 7 種がそのまま Lambda の Context になり、環境変数由来の設定と合流する。deadline が絶対時刻であることと、必須扱いのヘッダが 2 つあることを読む。"
group: "Lambda 実行環境と Runtime API"
sidebar:
  order: 4
---

## 何を学んだか

`GET /2018-06-01/runtime/invocation/next` のレスポンスは、HTTP の 2 つの領域を使い分けている。

- **ボディ**: イベント JSON。API Gateway のプロキシイベントや SQS のメッセージなど、トリガーごとに構造が違う
- **ヘッダ**: invocation のメタデータ。トリガーが何であっても同じ形

そして**このヘッダ群がそのまま Lambda の Context オブジェクトになる**。Node.js の `context.awsRequestId` も、Python の `context.get_remaining_time_in_millis()` も、元をたどれば `/next` のレスポンスヘッダだ。

Rust ランタイムが読むヘッダは 7 つ。

| ヘッダ                                | `Context` のフィールド | 必須か                             |
| ------------------------------------- | ---------------------- | ---------------------------------- |
| `lambda-runtime-aws-request-id`       | `request_id`           | **必須** (`expect`)                |
| `lambda-runtime-deadline-ms`          | `deadline`             | **必須** (`expect`)                |
| `lambda-runtime-invoked-function-arn` | `invoked_function_arn` | 任意。欠けたらプレースホルダ文字列 |
| `lambda-runtime-trace-id`             | `xray_trace_id`        | 任意 (`Option`)                    |
| `lambda-runtime-client-context`       | `client_context`       | 任意。JSON としてパース            |
| `lambda-runtime-cognito-identity`     | `identity`             | 任意。JSON としてパース            |
| `lambda-runtime-aws-tenant-id`        | `tenant_id`            | 任意 (`Option`)                    |

一方で、`Context` にはヘッダ**由来ではない**フィールドもある。`env_config` がそれで、こちらは実行環境の環境変数から Init のタイミングで一度だけ読まれる。

## ソースコードのどこか

### ヘッダ → Context

```rust title="lambda-runtime/src/types.rs"
let ctx = Context {
    request_id: request_id.to_owned(),
    deadline: headers
        .get("lambda-runtime-deadline-ms")
        .expect("missing lambda-runtime-deadline-ms header")
        .to_str()?
        .parse::<u64>()?,
    invoked_function_arn: headers
        .get("lambda-runtime-invoked-function-arn")
        .unwrap_or(&HeaderValue::from_static(
            "No header lambda-runtime-invoked-function-arn found.",
        ))
        .to_str()?
        .to_owned(),
    xray_trace_id: headers
        .get("lambda-runtime-trace-id")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).to_string()),
    client_context,
    identity,
    tenant_id: headers
        .get("lambda-runtime-aws-tenant-id")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).to_string()),
    env_config,
};
```

[`lambda-runtime/src/types.rs#L131-L154`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-runtime/src/types.rs#L131-L154)

3 段階の扱い分けがある。`deadline` は `expect` で必須、`invoked_function_arn` は `unwrap_or` でプレースホルダ、残りは `Option` のまま。

`request_id` だけは `Context::new` の引数として外から渡される。取り出しは別関数になっていて、ここも `expect` だ。

```rust title="lambda-runtime/src/types.rs"
pub(crate) fn invoke_request_id(headers: &HeaderMap) -> Result<&str, ToStrError> {
    headers
        .get("lambda-runtime-aws-request-id")
        .expect("missing lambda-runtime-aws-request-id header")
        .to_str()
}
```

[`lambda-runtime/src/types.rs#L166-L171`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-runtime/src/types.rs#L166-L171)

呼び出し側は 1 行で両方を使う。

```rust title="lambda-runtime/src/runtime.rs"
let context = Context::new(invoke_request_id(&parts.headers)?, config.clone(), &parts.headers)?;
```

[`lambda-runtime/src/runtime.rs#L503`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-runtime/src/runtime.rs#L503)

### deadline は絶対時刻

`deadline` フィールドは `u64` で、中身は**エポックからのミリ秒**だ。「残り何ミリ秒」ではない。

```rust title="lambda-runtime/src/types.rs"
/// The execution deadline for the current invocation.
pub fn deadline(&self) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(self.deadline)
}
```

[`lambda-runtime/src/types.rs#L159-L162`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-runtime/src/types.rs#L159-L162)

AWS のドキュメントも `Lambda-Runtime-Deadline-Ms` を「The date that the function times out in Unix time milliseconds」と説明していて、例として `1542409706888` を挙げている。他言語の SDK が提供する「残り時間」は、この絶対時刻から現在時刻を引いて計算されたものだ。

### env_config は環境変数から

```rust title="lambda-runtime/src/lib.rs"
impl Config {
    /// Attempts to read configuration from environment variables.
    pub fn from_env() -> Self {
        Config {
            function_name: env::var("AWS_LAMBDA_FUNCTION_NAME").expect("Missing AWS_LAMBDA_FUNCTION_NAME env var"),
            memory: env::var("AWS_LAMBDA_FUNCTION_MEMORY_SIZE")
                .expect("Missing AWS_LAMBDA_FUNCTION_MEMORY_SIZE env var")
                .parse::<i32>()
                .expect("AWS_LAMBDA_FUNCTION_MEMORY_SIZE env var is not <i32>"),
            version: env::var("AWS_LAMBDA_FUNCTION_VERSION").expect("Missing AWS_LAMBDA_FUNCTION_VERSION env var"),
            log_stream: env::var("AWS_LAMBDA_LOG_STREAM_NAME").unwrap_or_default(),
            log_group: env::var("AWS_LAMBDA_LOG_GROUP_NAME").unwrap_or_default(),
        }
    }
}
```

[`lambda-runtime/src/lib.rs#L69-L83`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-runtime/src/lib.rs#L69-L83)

`Config::from_env()` は `Runtime` の構築時に 1 回だけ呼ばれ ([`runtime.rs#L108`](https://github.com/aws/aws-lambda-rust-runtime/blob/6f305bb00f3cc613fd82f88d2f2200e8089e4385/lambda-runtime/src/runtime.rs#L108))、`Arc<Config>` として全 invocation で共有される。関数名・メモリ・バージョンは invocation ごとに変わらないので、ヘッダで毎回送る必要がない。逆にログストリーム名とログ グループ名は `unwrap_or_default()` で、無ければ空文字になる。

### 読まれていないヘッダ

AWS のドキュメントは `Lambda-Runtime-Invocation-Id` (invocation attempt の識別子) も `/next` のレスポンスヘッダとして挙げていて、`/response` と `/error` にエコーバックすることを推奨している。しかし aws-lambda-rust-runtime にはこのヘッダを扱うコードが 1 行もない。ドキュメント側も「後方互換のため任意で、送らなくても拒否されない」と明記している。

## なぜそうなっているか

**メタデータをヘッダに置いたのは、イベント本体に触らずに済ませるためだ。** イベント JSON はトリガーが決める形をしていて、Lambda はそれを不透明なペイロードとして扱いたい。リクエスト ID や deadline をボディに混ぜ込むと、ランタイムがイベントをパースしないと Context が作れなくなる。ヘッダに分けておけば、ボディはバイト列のまま関数に渡せる。

**`request_id` と `deadline-ms` が `expect` なのは、それらが無い `/next` レスポンスは Runtime API の契約違反だからだ。** `request_id` が無ければそもそも `/response` の URL が組み立てられない。`deadline` が無ければタイムアウトの概念が壊れる。この 2 つが欠けている状況は回復可能なエラーではなく、パニックして実行環境ごと落とすのが正しい。一方 `invoked_function_arn` は「あると便利」なだけなので、プレースホルダ文字列でごまかしている。この非対称性が設計の意図を語っている。

**`deadline` を絶対時刻のままにしているのは、時刻の変換をランタイムに閉じ込めないためだ。** 「残り時間」で受け取ると、その値が有効なのは受け取った瞬間だけになる。絶対時刻なら、ハンドラの中のどのタイミングで引き算しても正しい残り時間が出る。ただし SnapStart のように単調時計が飛ぶ環境ではこの前提が揺らぐ、という話が [hyper クライアントの寿命管理と SnapStart](../hyper-client-and-snapstart/) につながる。

## どう活かすか

**この `Context` が、後で HTTP ヘッダとしてアプリに届く。** Web Adapter は `fetch_response` の中で `Context` を JSON にシリアライズし、`x-amzn-lambda-context` というリクエストヘッダに詰めてローカルのアプリへ転送する。つまり Express のハンドラで `req.headers['x-amzn-lambda-context']` を `JSON.parse` すれば、request_id も deadline も取れる。その仕組みと、そこで実際に起きた事故は [コンテキストを HTTP ヘッダに詰める](../context-headers/) で読む。

**残り時間を使うなら、絶対時刻であることを忘れない。** `x-amzn-lambda-context` の JSON に入っている `deadline` は epoch ミリ秒なので、アプリ側では `deadline - Date.now()` で残り時間になる。長い処理を打ち切る判断や、外部呼び出しのタイムアウト値をこれに合わせる、といった使い方ができる。

**ローカルでテストする際は `AWS_LAMBDA_FUNCTION_NAME` などの環境変数も要る。** ヘッダ由来のフィールドだけ揃えても `Config::from_env()` が `expect` で落ちる。Runtime API のモックを立てて Web Adapter を動かすなら、環境変数のセットも合わせて用意する必要がある。
