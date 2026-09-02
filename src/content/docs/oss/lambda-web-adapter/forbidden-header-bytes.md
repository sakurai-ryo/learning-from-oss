---
title: "ヘッダに入れてはいけないバイトを落とす"
description: "制御バイト入りのパスを投げられると invocation 全体が落ちた、という実際の事故と、その修正である strip_forbidden_header_bytes を読む。エスケープでも拒否でもなく「黙って落とす」を選び、Cow で通常時ノーコピーにした 12 行。"
group: "リクエストを流す"
sidebar:
  order: 25
---

## 何を学んだか

12 行の関数と、それより長いコメントがある。コメントに事故の経緯がそのまま書いてあるので、なぜこのコードが存在するかを推測しなくていい。

```rust title="src/lib.rs"
/// Returns `s` with bytes that `http::HeaderValue` rejects removed.
///
/// RFC 7230 limits header field values to visible ASCII plus SP/HTAB; bytes
/// `< 0x20` (except `\t` = 0x09) and DEL (`0x7F`) are forbidden. The
/// `x-amzn-request-context` and `x-amzn-lambda-context` headers carry
/// JSON serialized from the Lambda event, which can echo arbitrary bytes
/// from the original request path. Without this, a request whose path
/// contains control bytes (e.g. from a security scanner) would fail the
/// whole invocation with `InvalidHeaderValue`.
///
/// Returns `Cow::Borrowed` when no forbidden byte is present (the common
/// case), avoiding any allocation.
fn strip_forbidden_header_bytes(s: &str) -> Cow<'_, [u8]> {
    let bytes = s.as_bytes();
    if bytes.iter().all(|&b| b == b'\t' || (b >= 0x20 && b != 0x7F)) {
        Cow::Borrowed(bytes)
    } else {
        Cow::Owned(
            bytes
                .iter()
                .copied()
                .filter(|&b| b == b'\t' || (b >= 0x20 && b != 0x7F))
                .collect(),
        )
    }
}
```

([src/lib.rs#L479-L504](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L479-L504))

判定条件は 1 つだけ、`b == b'\t' || (b >= 0x20 && b != 0x7F)`。これが 2 回、同じ形で出てくる (走査用とフィルタ用)。

## ソースコードのどこか

呼ばれるのは `fetch_response` の 2 か所だけだ ([src/lib.rs#L961-L971](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L961-L971))。コンテキストを JSON にして `HeaderValue::from_bytes` に渡す、その間に挟まっている。

事故の筋道はこうだ。

1. Function URL に `GET /%04%18%7F` のようなリクエストが来る (セキュリティスキャナ、たとえば nuclei が投げてくる)
2. Lambda のイベント JSON の `requestContext.http.path` にそのバイト列がそのまま入る
3. LWA が `serde_json::to_string(&request_context)` する。JSON 文字列としては合法で、ここは通る
4. `HeaderValue::from_bytes` が `InvalidHeaderValue` を返す。ヘッダ値には制御バイトを入れられないから
5. `?` でエラーが `fetch_response` から伝播する
6. `Err` は Runtime API の `/invocation/{id}/error` に POST される ([3 層の tower::Service スタック](../tower-service-stack/))

つまり **1 本の変なリクエストで invocation 全体が失敗する**。クライアントに 502 が返るだけでなく、CloudWatch の Errors メトリクスが立ち、アラームが鳴り、非同期呼び出しならリトライまでかかる。アプリは何も悪くないし、そもそもアプリまで到達していない。

RFC 7230 がヘッダ値に許すのは可視 ASCII (0x21-0x7E) と SP (0x20)、HTAB (0x09) だ。それ以外の C0 制御文字 (0x00-0x1F) と DEL (0x7F) は禁止で、`http` クレートはこれを厳密に弾く。一方 0x80 以上は `http::HeaderValue` が受け付けるので、UTF-8 のマルチバイト文字 (先頭バイト >= 0xC0、継続バイト >= 0x80) はどれもこの条件を通り抜ける。日本語を含むパスは無傷で通る。

### テストが何を保証しているか

`test_strip_forbidden_header_bytes` ([src/lib.rs#L1438-L1453](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1438-L1453)) は、変換結果と**アロケーションの有無の両方**を見ている。

```rust title="src/lib.rs"
let out = strip_forbidden_header_bytes("a\tb\nc\rd\u{00}e\u{04}f\u{18}g\u{7f}h");
assert_eq!(out.as_ref(), b"a\tbcdefgh");
assert!(matches!(out, Cow::Owned(_)), "input had forbidden bytes — must allocate");
```

タブは残り、LF・CR・NUL・0x04・0x18・DEL は消える。そして `héllo` がそのまま通ることも確認している。

`test_strip_forbidden_header_bytes_all_clean` ([src/lib.rs#L1455-L1471](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1455-L1471)) のほうは逆で、**普通の JSON が `Cow::Borrowed` で返ることを assert している**。「速いこと」ではなく「アロケートしないこと」をテストで固定してあるので、後からうっかり `.filter().collect()` を無条件に呼ぶ実装に書き換えると落ちる。

`test_request_context_with_control_bytes_in_path` ([src/lib.rs#L1472 以降](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1472)) は [issue #732](https://github.com/aws/aws-lambda-web-adapter/issues/732) のリグレッションテストで、単体関数ではなく `fetch_response` 全体を通す。`http.path` に 0x04 / 0x18 / 0x7F を仕込んだ API Gateway v2 のイベントを作り、モックサーバ側で次を確認している。

- `x-amzn-request-context` ヘッダが存在する (= invocation が落ちていない)
- その値に禁止バイトが 1 つも残っていない
- **サニタイズ後の JSON が `RequestContext` として型どおりデシリアライズできる** — 単に「壊れていない JSON」ではなく、アプリが依存する構造が生き残っていることまで見る
- `x-amzn-lambda-context` も同様に安全で、`request_id` が取り出せる

バイトを落とすということは JSON の中身を書き換えるということなので、「構造が壊れていないか」がいちばんの懸念になる。JSON 文字列の中で制御文字はエスケープ表現 (バックスラッシュ + u + 4 桁の 16 進) として書き出されるが、その表現は可視 ASCII だけでできているので削られない — というのがこのテストで担保されている性質だ。

## なぜそうなっているか

対処の選択肢は 3 つあった。

| 案                                       | 起きること                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| パーセントエンコードなどでエスケープする | 値は正確に保てるが、アプリ側が復号方法を知る必要がある。既存の利用者が全員壊れる |
| 不正なリクエストとして 400 を返す        | LWA がリクエストの正当性を判断することになる。アプリが受理したいパスまで弾く     |
| **該当バイトだけ落とす**                 | ヘッダの値は不正確になるが、リクエストはアプリに届く                             |

採用されたのは 3 番目だ。この判断の根拠は、**コンテキストヘッダはあくまで補助情報である**という位置づけにある。アプリの本来の仕事はパスとボディを処理することで、`x-amzn-request-context` はおまけだ。おまけの正確さのために本体 (invocation) を落とすのは割に合わない。

もう 1 つ効いているのは `Cow` の使い方だ。この関数は**全リクエストが 2 回ずつ通る**。制御バイトが混ざるのは異常系だけなので、正常系でアロケートしない設計にする価値がある。

```
通常のリクエスト:  走査 1 回 (SIMD 化されうる単純ループ) → Cow::Borrowed、アロケーション 0
異常なリクエスト:  走査 1 回 + フィルタして Vec を確保
```

「先に全部見て、汚れていたときだけコピーする」の 2 パスは、一見すると無駄に見える。しかし異常系が稀であるなら、1 パスで常に `Vec` を作る実装より速い。`Cow` はまさにこの形のために標準ライブラリに入っている型で、`Cow::Borrowed` を返す分岐を持つ関数は「入力を変えないなら借りたまま返す」という契約を型で表明できる。

## どう活かすか

外部由来の文字列を HTTP ヘッダに載せる設計を自分で書くときの一般則として、3 点にまとめられる。

1. **ヘッダ値に許されるバイトは思ったより狭い。** 「ASCII なら大丈夫」ではない。0x20 未満 (タブを除く) と 0x7F は不可。逆に 0x80 以上は多くの実装が通すので、UTF-8 のマルチバイトは通っても改行は通らない。ユーザー入力を由来とする値をヘッダに入れるなら、必ずどこかで検証か除去がいる。
2. **補助情報のために本体を落とすな。** 「ログ用のヘッダを付けるコード」が例外を投げてリクエスト全体を失敗させる、というのは頻出のバグだ。付加情報の生成は、失敗しても本流が進む形にしておく。今回の LWA は「落とす」を選んだが、`unwrap_or_default()` でヘッダごと省く選択もある (実際 `tenant_id` はそちら)。大事なのはどちらかに寄せて、`?` で伝播させないこと。
3. **`Cow` で「普通の入力ではノーコピー」を作る。** サニタイズ、正規化、エスケープのように「たいていは何もしなくていい」変換は、`Cow<'_, T>` を返す関数として書くと呼び出し側が意識せずに速い経路に乗る。そして**アロケーションしないことをテストで固定する** (`matches!(out, Cow::Borrowed(_))`) と、最適化が後退したときに気づける。
