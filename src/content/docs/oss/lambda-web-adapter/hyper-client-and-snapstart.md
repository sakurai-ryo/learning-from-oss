---
title: "hyper クライアントの寿命管理と SnapStart"
description: "SnapStart のときだけコネクションプールを完全に切る 4 行と、通常時の 4 秒のアイドルタイムアウト。そして返す直前に transfer-encoding ヘッダを消している 1 行。どれも Lambda 実行環境の癖に対する具体的な対処である。"
group: "レスポンスを返す"
sidebar:
  order: 32
---

## 何を学んだか

アダプタがアプリへ HTTP を投げるための hyper クライアントは、`Adapter::new` の冒頭 10 行で組み立てられる。そこに Lambda 特有の判断が 2 つ埋まっている。

```rust title="src/lib.rs"
let mut builder = Client::builder(hyper_util::rt::TokioExecutor::new());

// When running under SnapStart, CLOCK_MONOTONIC can be inconsistent after
// restore, causing hyper's pool to reuse dead connections (hyper#3810,
// rust-lang/rust#79462). Disable pooling in that case. For localhost
// communication the overhead of new TCP connections is negligible.
if env::var("AWS_LAMBDA_INITIALIZATION_TYPE").as_deref() == Ok("snap-start") {
    builder.pool_max_idle_per_host(0);
} else {
    builder.pool_idle_timeout(Duration::from_secs(4));
}

let client = builder.build(HttpConnector::new());
```

([`src/lib.rs#L587`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L587))

SnapStart なら**プールを完全に無効化**し、そうでなければ**アイドル 4 秒**で捨てる。どちらの数字も、Lambda 実行環境が普通のサーバとは違う挙動をすることへの対処である。

そしてもう 1 つ、レスポンスを返す直前の小細工がある。

```rust title="src/lib.rs"
// remove "transfer-encoding" from the response to support "sam local start-api"
app_response.headers_mut().remove("transfer-encoding");
```

([`src/lib.rs#L1034`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1034))

このページはこの 3 か所を扱う。どれも「レスポンスを返す前後で、Lambda という環境のために手当てしていること」だ。

## ソースコードのどこか

### SnapStart のときプールを切る

`AWS_LAMBDA_INITIALIZATION_TYPE` は Lambda が実行環境に設定する環境変数で、値は次の 3 つを取る。

- `on-demand` — 通常の起動
- `provisioned-concurrency` — プロビジョニング済み同時実行で事前に暖められた環境
- `snap-start` — SnapStart のスナップショットから復元された環境

`snap-start` のときだけ `pool_max_idle_per_host(0)` を設定する。これは「ホストあたりのアイドル接続を 0 個まで保持する」、つまり**使い終わった接続を一切キープしない**という指定である。リクエストごとに TCP を張り直すことになる。

なぜそこまでするのかは、コード内コメントに理由も参照先も書かれている。SnapStart は初期化済みのメモリスナップショットを復元して起動するので、**復元後の `CLOCK_MONOTONIC` がスナップショット取得時からの連続性を持たない**。hyper のコネクションプールは「この接続を最後に使ってから何秒経ったか」を単調増加クロックで判断してアイドルタイムアウトを掛けているので、時計が飛ぶとその判断が壊れる。スナップショット時点で確立されていた TCP 接続は復元後の環境には存在しないのに、プールは「まだ新しい接続だ」と誤認して再利用しようとする。結果は復元直後のリクエストの失敗である。

対処の選択肢は「復元時にプールを明示的に空にする」「時計の扱いを直す」などもありうるが、LWA は**プールごと無効化する**という一番単純な手を選んだ。理由もコメントにある。通信相手が `127.0.0.1` なので、TCP を張り直すコストが無視できるからだ。ループバックの接続確立にネットワーク往復は発生しない。**遠隔のサービスを呼ぶクライアントなら成立しない判断が、localhost 限定だから成立している。**

### なぜアイドルタイムアウトが 4 秒なのか

通常時の `pool_idle_timeout(Duration::from_secs(4))` は、hyper のデフォルト (90 秒) よりかなり短い。

短くしている理由は Lambda のフリーズにある。invocation が終わると実行環境は凍結され、次のイベントが来るまでプロセスは 1 命令も進まない ([フリーズと解凍 — リクエストの間、プロセスは止まっている](../freeze-thaw/))。ここで問題になるのは、**凍っているのはアダプタとアプリの両方だが、TCP 接続の管理はアプリのフレームワーク側が持っている**ことだ。

アプリ側 (Express の `server.keepAliveTimeout`、Nginx の `keepalive_timeout`、多くのフレームワークで既定 5 秒〜数十秒) は、自分の時計でアイドル接続を閉じにいく。解凍された瞬間、アプリ側から見ればアイドル時間が経過しているので、プールに残っていた接続はもう相手側に閉じられているか、これから閉じられるところである。閉じられた接続を掴んだまま送信すると、リクエストは失敗する。

つまり**アダプタが長くプールを保持しても、相手が付き合ってくれない**。4 秒はそのことを織り込んだ数字で、「1 回の invocation の中で複数のリクエストを出すとき (レディネスチェックと本番リクエストなど) には効くが、invocation をまたいで持ち越すことは期待しない」という線引きになっている。

### transfer-encoding を消す 1 行

`fetch_response` がレスポンスを返す直前、ヘッダから `transfer-encoding` を落とす。コメントは `sam local start-api` を動かすためだと言っている。

何が起きるのかを HTTP の側から見ると分かりやすい。アプリが `Transfer-Encoding: chunked` でレスポンスを返してくると、hyper はチャンクをデコードしてボディを組み立てる。**デコードは済んでいるのに、ヘッダだけが残る。** このヘッダが付いたまま buffered モードで JSON になると、レスポンスの `headers` フィールドに `transfer-encoding: chunked` が入って Lambda から出ていく。

```text
POST /2018-06-01/runtime/invocation/{id}/response

{
  "statusCode": 200,
  "headers": {
    "content-type": "text/html",
    "transfer-encoding": "chunked"   <- これが残ると受け取り側が壊れる
  },
  "body": "<html>..."               <- チャンク化はもう解けている
}
```

これを受け取った SAM Local のローカル HTTP サーバは、ヘッダを信じてボディをチャンクとして読もうとする。しかしボディは既にデコード済みの生データなので、チャンクサイズの 16 進数が読めずに壊れる。

`Transfer-Encoding` は**ホップバイホップヘッダ**、つまり「隣り合う 2 つのノードの間だけで意味を持ち、次のホップへ転送してはいけない」ヘッダである。`Connection`、`Keep-Alive`、`Upgrade` なども同じ分類にある。アダプタはアプリとクライアントの間に立つプロキシなので、**アプリから受け取ったホップバイホップヘッダを、そのまま先へ渡してはいけない。** この 1 行は「SAM Local の回避策」として書かれているが、実際には HTTP の一般則を守っているだけである。逆に言えば、LWA が消しているのは `transfer-encoding` だけで、他のホップバイホップヘッダには手をつけていない。

### Arc が 2 つだけである理由

`Adapter` は `#[derive(Clone)]` で、フィールドのうち `Arc` に包まれているのは 2 つだけである ([`src/lib.rs#L537`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L537))。

```rust title="src/lib.rs"
#[derive(Clone)]
pub struct Adapter<C, B> {
    client: Arc<Client<C, B>>,
    healthcheck_url: Url,
    healthcheck_protocol: Protocol,
    healthcheck_healthy_status: Vec<u16>,
    async_init: bool,
    ready_at_init: Arc<AtomicBool>,
    // ... 以下は String / Option<String> / bool など
}
```

なぜ clone されるのかは `Service::call` を見れば分かる ([`src/lib.rs#L1056`](https://github.com/aws/aws-lambda-web-adapter/blob/986113fc66f368f0187a25c683f1ab39a68cc6c6/src/lib.rs#L1056))。

```rust title="src/lib.rs"
fn call(&mut self, event: Request) -> Self::Future {
    let adapter = self.clone();
    Box::pin(async move { adapter.fetch_response(event).await })
}
```

`call` は `&mut self` を受け取るが、返す Future は `'static` でなければならない。借用を持ち越せないので、毎回まるごと clone して所有権を Future に移している。さらに `run_concurrent` は Service を worker タスクの数だけ clone して配る ([並行ポーリング — /next を N 本同時に張る](../concurrent-polling/))。

ここで `client` が `Arc` でなかったら、**invocation ごとに新しい hyper クライアントが作られ、コネクションプールがその場限りになる**。プールを持つ意味が消えるどころか、TLS も持たないローカル接続とはいえ毎回の接続確立が積み上がる。`Arc` にしてあるからこそ、clone された全部の `Adapter` が同じプールを共有する。

`ready_at_init` が `Arc<AtomicBool>` なのも同じ話で、こちらは共有が「値の書き換えを他の clone にも見せる」ために要る。非同期初期化のとき、最初のリクエストがレディネスチェックを済ませたことを、他の clone にも伝えなければならない ([非同期初期化 — 9.8 秒で諦めて init を通す](../async-init/))。

残りのフィールドは `String` や `Url` や `bool` で、invocation ごとにコピーされる。数十バイトの複製であり、共有する必要もない。**共有が必要なものだけを `Arc` にする**という当たり前の設計だが、`Service` が clone される前提のフレームワークでは、この判断を間違えると静かに性能が落ちる。

## どう活かすか

**「時計が飛ぶ環境」を想定した実装が要る場面がある。** SnapStart、VM のスナップショット復元、コンテナのチェックポイント/リストア (CRIU) — どれも「プロセスから見ると時間が不連続に飛ぶ」。単調増加クロックを前提にキャッシュの有効期限やコネクションの生存判定をしているライブラリは、この状況で誤動作しうる。SnapStart を使うなら、コネクションプール、トークンの有効期限キャッシュ、乱数のシード ([SnapStart で初期化時に生成した乱数が全環境で共有される、というよく知られた落とし穴](https://docs.aws.amazon.com/lambda/latest/dg/snapstart-uniqueness.html)) を点検する価値がある。

**プロキシを書くならホップバイホップヘッダの扱いを決める。** 自分で HTTP プロキシやアダプタを書くとき、`Transfer-Encoding` / `Connection` / `Keep-Alive` / `Upgrade` / `Proxy-Authenticate` / `TE` / `Trailer` は転送してはいけない。ボディのエンコーディングを解いたのにヘッダだけ残す、という失敗は自作プロキシで最も多い部類のバグで、症状 (受け取り側でボディが壊れる) から原因にたどり着きにくい。

**`Service` を clone するフレームワークでは、何を共有するかを意識する。** tower に限らず、ハンドラを clone して配る設計は広く使われている。「clone は安い」と思って重いものを値で持つと、リクエストごとにコネクションプールや接続や大きなバッファが作り直される。`Arc` にすべきものとそうでないものの線は、`Clone` の実装を書く/導出する時点で 1 度考えておく。
