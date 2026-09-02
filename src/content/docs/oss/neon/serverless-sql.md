---
title: "HTTP 越しの SQL"
description: "エッジ環境からは TCP が張れない。1 回の POST でクエリを投げて JSON で結果を受け取る API がある。設計判断が README に 4 つ挙がっていて、そのうち 3 つは Postgres の型システムと JSON の型システムの落差の話になっている。"
group: "proxy"
sidebar:
  order: 53
---

## 何を学んだか

```markdown title="proxy/README.md"
Contrary to the usual postgres proto over TCP and WebSockets using plain
one-shot HTTP request achieves smaller amortized latencies in edge setups due to
fewer round trips and an enhanced open connection reuse by the v8 engine. Also
such endpoint could be used directly without any driver.
```

([proxy/README.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/README.md))

**理由が 3 つ挙がっている。**

1. **往復が少ない。** Postgres のプロトコルは接続に TLS ハンドシェイク + startup + 認証で 3〜4 往復かかる。HTTP なら 1 回
2. **V8 が HTTP 接続を再利用してくれる。** Cloudflare Workers や Vercel Edge のランタイムでは、TCP を自分で張るより HTTP のほうが環境に馴染む
3. **ドライバが要らない。** `curl` で叩ける

そして proxy は 3 つの入口を持つ。

```rust title="proxy/src/serverless/mod.rs"
//! Routers for our serverless APIs
//!
//! Handles both SQL over HTTP and SQL over Websockets.
```

TCP、WebSocket、HTTP。**WebSocket は Postgres のプロトコルをそのままトンネルする**ので、既存のドライバがほぼそのまま使える。HTTP は完全に別の API になる。

## SQL インジェクションを構造で防ぐ

```markdown title="proxy/README.md"
1. SQL injection protection: We employed the extended query protocol, modifying
   the rust-postgres driver to send queries in one roundtrip using a text
   protocol rather than binary, bypassing potential issues like those identified
   in sfackler/rust-postgres#1030.
```

**拡張問い合わせプロトコル (Parse/Bind/Execute) を使う。** クエリ文字列とパラメータが別々に送られるので、文字列連結が起きない。

リクエストの形もそれを強制している。

```rust title="proxy/src/serverless/sql_over_http.rs"
struct QueryData {
    query: String,
    #[serde(deserialize_with = "bytes_to_pg_text")]
    #[serde(default)]
    params: Vec<Option<String>>,
    #[serde(default)]
    array_mode: Option<bool>,
}
```

([proxy/src/serverless/sql_over_http.rs L44](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/serverless/sql_over_http.rs#L44))

**`query` と `params` が別のフィールド。** API の形として、パラメータを埋め込む方法がない。

ただし、拡張問い合わせプロトコルは本来 2 往復かかる (Parse してから Bind)。それを 1 往復にするために **rust-postgres を改造している** (`libs/proxy` に fork が入っている)。

**「安全な方法が遅い」なら、安全な方法を速くする。** 安全性を落とす方向の妥協をしていない。

## 型システムの落差

残り 3 つの設計判断は、全部**「Postgres の型を JSON でどう表すか」**の話になる。

```markdown title="proxy/README.md"
2. Postgres type compatibility: As not all postgres types have binary
   representations (e.g., acl's in pg_class), we adjusted rust-postgres to
   respond with text protocol, simplifying serialization and fixing queries with
   text-only types in response.
```

**バイナリ表現を持たない型がある。** `pg_class.relacl` のような内部型は、テキスト形式でしか送れない。

だから**全部テキストで受け取る**ことにした。バイナリのほうが効率的だが、型ごとにデコーダが要るし、対応漏れが「そのクエリだけ動かない」という形で現れる。

**「一部だけ速い」より「全部同じ経路」を選んでいる。**

```markdown title="proxy/README.md"
3. Data type conversion: Considering JSON supports fewer data types than
   Postgres, we perform conversions where possible, passing all other types as
   strings. Key conversions include:
   - postgres int2, int4, float4, float8 -> json number (NaN and Inf remain
     text)
   - postgres bool, null, text -> json bool, null, string
   - postgres array -> json array
   - postgres json and jsonb -> json object
```

**変換できるものだけ変換し、残りは文字列。**

`NaN` と `Inf` の扱いが目を引く。**JSON の number は NaN も Infinity も表現できない。** だから数値型でもこの 2 つだけは文字列で返す。

同じ列の値が、行によって number だったり string だったりする。型として気持ち悪いが、**JSON の仕様上、他に選択肢がない。** `null` にすると情報が消えるし、エラーにすると正当なクエリが失敗する。

`int8` (bigint) が変換リストにないのも同じ理由だ。JavaScript の number は 53 ビットしか正確に表せない。**文字列で返して、クライアントに判断させる。**

## node-postgres に形を合わせる

```markdown title="proxy/README.md"
4. Alignment with node-postgres: To facilitate integration with js libraries,
   we've matched the response structure of node-postgres, returning command tags
   and column oids. Command tag capturing was added to the rust-postgres
   functionality as part of this change.
```

**レスポンスの構造を `node-postgres` に合わせる。**

```json
{
  "command": "SELECT",
  "fields": [
    { "dataTypeID": 1007, "name": "arr" }
  ],
  "rowCount": 1,
  "rows": [ ... ]
}
```

`dataTypeID` は Postgres の型 OID がそのまま入る。**JSON に落としたことで失われた型情報を、メタデータとして横に添える。**

これで、クライアント側のライブラリが「この列は本当は timestamp だった」と知って、自分でパースし直せる。

**既存のエコシステムの形に合わせることで、変換ロジックを再利用できる。** ゼロから API を設計するより、デファクトに寄せたほうが移行が楽になる。

そのために rust-postgres 側に「command tag を取れるようにする」改造まで入れている。**互換性のために、依存ライブラリを直す。**

## 出力の形をヘッダで選べる

```markdown title="proxy/README.md"
1. `Neon-Raw-Text-Output: true`. Return postgres values as text, without parsing them. (略)
2. `Neon-Array-Mode: true`. Return postgres rows as arrays instead of objects. That is more compact representation and also helps in some edge
   cases where it is hard to use rows represented as objects (e.g. when several fields have the same name).
```

**変換をやめる選択肢を用意している。** クライアントが自分でパースしたいなら、そうさせる。

`array_mode` の理由が実務的だ。**同じ名前の列が複数ある場合、オブジェクトでは表現できない。** `SELECT a.id, b.id FROM ...` のようなクエリで、片方が消える。

配列にすれば順序で区別できる。**JSON オブジェクトのキーが一意でなければならない、という制約への対処**になっている。

ヘッダ名が定数として集約されている。

```rust title="proxy/src/serverless/sql_over_http.rs"
use super::http_util::{
    ALLOW_POOL, ARRAY_MODE, CONN_STRING, NEON_REQUEST_ID, RAW_TEXT_OUTPUT, TXN_DEFERRABLE,
    TXN_ISOLATION_LEVEL, TXN_READ_ONLY, get_conn_info, json_response, uuid_to_header_value,
};
```

([proxy/src/serverless/sql_over_http.rs L28](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/serverless/sql_over_http.rs#L28))

**トランザクションの分離レベル、read-only、deferrable もヘッダで指定する。** SQL で `BEGIN ISOLATION LEVEL ...` と書く代わりに、HTTP のセマンティクスに載せている。

## バッチ

```rust title="proxy/src/serverless/sql_over_http.rs"
struct BatchQueryData {
    queries: Vec<QueryData>,
}

#[serde(untagged)]
enum Payload {
    Single(QueryData),
    Batch(BatchQueryData),
}
```

([proxy/src/serverless/sql_over_http.rs L55](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/serverless/sql_over_http.rs#L55))

**`untagged` なので、リクエストの形から自動的に判別される。** `{"query": ...}` なら単発、`{"queries": [...]}` ならバッチ。

バッチは 1 つのトランザクションとして実行される。**HTTP は 1 リクエスト = 1 トランザクションなので、複数文を実行するにはバッチが要る。**

これが HTTP API の根本的な制約でもある。**クライアントがトランザクションを開いたまま待つことができない。** アプリケーション側で「読んで、考えて、書く」ができない。

## 接続の使い回し

HTTP は接続を保持しないので、リクエストのたびに compute への接続を張るわけにはいかない。だからプールが要る ([コネクションプールとキャンセル](../pool-and-cancel/))。

`ALLOW_POOL` ヘッダがあるのは、**プールしてほしくない場合があるから**だ。セッション変数を設定するようなクエリは、次のリクエストに影響を残す。

`local_conn_pool.rs` があるのは、`local_proxy` (compute と同じマシンで動く proxy) 用。**同じコードベースで、配置の違う 2 つの proxy を実装している。**

## この先に効いてくること

- **安全な方法が遅いなら、安全な方法を速くする。** ドライバを改造してでも。
- **一部だけ速い経路より、全部同じ経路。** バイナリを諦めてテキストに統一。
- **表現力の落差は、変換の穴として現れる。** NaN、Inf、bigint。
- **失われた型情報はメタデータとして添える。** クライアントが復元できるように。
- **デファクトの形に合わせると、エコシステムが再利用できる。**
