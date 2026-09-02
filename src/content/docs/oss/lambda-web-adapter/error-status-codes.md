---
title: "ステータスコードを Lambda のエラーに変える"
description: "アプリが 500 を返しても Lambda にとっては成功である、という前提と、それを覆す AWS_LWA_ERROR_STATUS_CODES の実装。エラーメッセージを JSON 文字列にする理由と、ストリーミングが効かなくなる副作用を読む。"
group: "リクエストを流す"
sidebar:
  order: 28
---

## 何を学んだか

**アプリが 500 を返しても、Lambda にとってその invocation は成功だ。** レスポンスは正常に生成され、Runtime API の `/invocation/{id}/response` に POST され、Errors メトリクスは 0 のまま。非同期呼び出しのリトライも DLQ も動かない。呼び出し元から見れば「500 という値を返す関数呼び出しが成功した」だけになる。

これは Lambda のプロトコル上まったく正しい。しかし SQS のメッセージ処理を Web アプリとして書いていると困る。LWA はこのギャップを 18 行で埋めている。

```rust title="src/lib.rs"
// Check if status code should trigger an error
if let Some(error_codes) = &self.error_status_codes {
    let status = app_response.status().as_u16();
    if error_codes.contains(&status) {
        let body_bytes = app_response
            .into_body()
            .collect()
            .await
            .map(|c| c.to_bytes())
            .unwrap_or_default();
        let body_str = String::from_utf8_lossy(&body_bytes);
        return Err(Error::from(format!(
            "{{\"statusCode\":{},\"body\":{}}}",
            status,
            serde_json::to_string(&*body_str).unwrap_or_else(|_| format!("\"{}\"", body_str))
        )));
    }
}
```

([src/lib.rs#L1014-L1031](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1014-L1031))

## ソースコードのどこか

### 設定のパース

`AWS_LWA_ERROR_STATUS_CODES` は `parse_status_codes` で `Vec<u16>` に展開される ([src/lib.rs#L450-L477](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L450-L477))。

```rust title="src/lib.rs"
fn parse_status_codes(input: &str) -> Vec<u16> {
    input
        .split(',')
        .flat_map(|part| {
            let part = part.trim();
            if part.contains('-') {
                let range: Vec<&str> = part.split('-').collect();
                if range.len() == 2 {
                    if let (Ok(start), Ok(end)) = (range[0].parse::<u16>(), range[1].parse::<u16>()) {
                        return (start..=end).collect::<Vec<_>>();
                    }
                }
                tracing::warn!("Failed to parse status code range: {}", part);
                vec![]
            } else {
                part.parse::<u16>().map_or_else(
                    |_| {
                        if !part.is_empty() {
                            tracing::warn!("Failed to parse status code: {}", part);
                        }
                        vec![]
                    },
                    |code| vec![code],
                )
            }
        })
        .collect()
}
```

`"500,502-504"` は `[500, 502, 503, 504]` になる。範囲は**両端を含む** (`start..=end`)。

設計として目を引くのは 2 点。ひとつは**範囲をその場で全展開している**こと。判定は `Vec::contains` の線形探索なので、`"400-599"` と書くと 200 要素のベクタを毎リクエスト走査することになるが、ステータスコードの空間はたかが知れているので範囲判定のロジックを持つより単純だ、という割り切りになっている。

もうひとつは**パース失敗が警告ログだけで済む**こと。`"abc"` や `"1-2-3"` を書いても起動は成功し、その項目だけが無視される。設定ミスで関数が上がらなくなるより、動いてログに出るほうがマシという判断だ。ただし裏を返すと、**タイポしてもエラーにならず、期待した invocation の失敗が起きないまま気づかない**ことがある。有効化したら 1 度は実際にエラーを起こして確認したほうがいい。

### Err が Lambda のエラーになるまで

`fetch_response` が `Err` を返すと、それは `tower::Service` の呼び出しエラーとしてスタックを遡る。最終的に `RuntimeApiResponseService` がそれを受け取り、`/invocation/{id}/response` ではなく **`/invocation/{id}/error` への POST** に変える ([3 層の tower::Service スタック](../tower-service-stack/))。

このとき送られる JSON の `errorMessage` フィールドに、`Error::from(...)` に渡した文字列がそのまま入る。だからここでメッセージ自体を JSON 文字列にしている。

```
errorMessage: "{\"statusCode\":500,\"body\":\"{\\\"message\\\":\\\"db timeout\\\"}\"}"
```

`errorMessage` は本来ただの人間向け文字列だが、そこに構造を押し込めば、CloudWatch Logs のメトリクスフィルタや Step Functions の `Catch` から機械的に拾える。ステータスコードとレスポンスボディという「原因の特定に必要な最小限」がここに入る。

内側の `serde_json::to_string(&*body_str)` は、ボディを JSON 文字列リテラルとしてエスケープするために呼んでいる。ボディに `"` や改行が含まれていても全体の JSON が壊れない。失敗時のフォールバック (`format!("\"{}\"", body_str)`) は素朴な囲みだが、`to_string` が `&str` で失敗することは実質ないので保険だ。

`String::from_utf8_lossy` を使っているので、ボディがバイナリでも invocation はここで落ちない。不正なバイトは U+FFFD に置き換わる。

### ストリーミングとの関係

この分岐で `app_response.into_body().collect().await` している。**この時点でレスポンスボディを最後まで読み切る。**

`fetch_response` の設計上の売りは「ボディを読まずに `Response<Incoming>` を返す」ことだった ([fetch_response — イベントが HTTP リクエストになるまで](../fetch-response/))。エラー判定はその原則の唯一の例外になる。

理屈は明快で、**ボディを読まないとエラーメッセージに入れられない**からだ。そしてエラーとして返す以上、そのレスポンスがストリーミングでクライアントに届くことはない。読み切っても失うものがない。

ただし注意は要る。`AWS_LWA_ERROR_STATUS_CODES` を有効にすると、**該当するステータスのレスポンスだけはメモリに全部載る**。エラー応答が巨大なスタックトレースを含むアプリでは、そのサイズがそのままメモリ使用と `errorMessage` の長さになる。

## なぜそうなっているか

Lambda の「成功」の定義が HTTP の「成功」と食い違っている、という構造的な問題がある。

|                        | Lambda の視点                    | HTTP の視点 |
| ---------------------- | -------------------------------- | ----------- |
| アプリが 200 を返した  | 成功                             | 成功        |
| アプリが 500 を返した  | **成功** (値として 500 を返した) | 失敗        |
| アプリがクラッシュした | 失敗                             | 接続断      |

同期呼び出し (API Gateway) ならこの食い違いは表に出ない。API Gateway が受け取った 500 をそのままクライアントに返すからだ。問題は**呼び出し元が Lambda のエラー結果に反応する仕組みを持っている**場合に起きる。SQS のイベントソースマッピングは invocation の失敗でメッセージを可視に戻すし、EventBridge は再試行し、Step Functions は `Catch` に飛ばす。これらは全部「Lambda がエラーを返したか」を見ている。

だから LWA は「どのステータスを Lambda のエラーとして扱うか」を**設定に委ねた**。自動で 5xx をエラー扱いにすると、API Gateway 経由でエラーページを返すだけのアプリが壊れる。既定値は `None` で、明示的に指定したときだけ有効になる。

## どう活かすか

**有効にする場面。**

- **SQS / EventBridge からの非同期呼び出し。** アプリが 500 を返したらメッセージをリトライさせ、最終的に DLQ へ送りたい。`AWS_LWA_ERROR_STATUS_CODES=500-504` のように設定する
- **Step Functions の Task。** `Catch` / `Retry` でエラーハンドリングしたい。`Catch` で捕まえたときの `$.Cause` の中に `errorMessage` として現れるので、ステータスコードとボディを次のステートに渡せる
- **CloudWatch アラーム。** アプリの 5xx 率を Errors メトリクスで監視したい場合。ログのメトリクスフィルタを組むより単純になる

**有効にしてはいけない場面。**

- **API Gateway / ALB / Function URL からの同期呼び出し。** Lambda がエラーを返すので、API Gateway はクライアントに **502 Bad Gateway** を返す。アプリが返した 500 のステータスもボディも失われ、デバッグしづらくなるうえ、エラーページやバリデーションエラーの JSON がクライアントに届かない
- **4xx をエラー扱いにする設定。** `404` や `401` は正常な業務レスポンスなので、これをエラーにすると Errors メトリクスが常時高止まりし、アラームが意味を失う

同期と非同期の両方から呼ばれる関数では、この設定は使えない。関数を分けるか、アプリ側でリトライ制御を実装するほうが素直だ。
