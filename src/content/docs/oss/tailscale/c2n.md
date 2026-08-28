---
title: "control からクライアントへ RPC を返す"
description: "NAT の内側にいるクライアントに、サーバから問い合わせたい。Tailscale の答えは「HTTP リクエストをバイト列としてレスポンスに載せて送り、クライアントは自分の中の http.Handler にそれを食わせ、結果をまた別の POST で返す」だった。net/http のパーサとレコーダをそのまま使い回している。"
group: "制御プレーン"
sidebar:
  order: 8
---

## 何を学んだか

### サーバからクライアントに問い合わせたい

control server が知りたいことがある。「このノードは本当に生きているか」「このノードのヒープの状態は」「ログをすぐ吐き出してほしい」。

だがクライアントは NAT の内側にいる。サーバから接続することはできない。使えるのは、クライアントが張っている [long poll](../map-longpoll/) だけだ。

### HTTP リクエストをバイト列として運ぶ

Tailscale の答えは、こうだ。

1. サーバは `MapResponse.PingRequest` に **HTTP/1.1 形式のリクエストをそのままバイト列で** 入れて送る
2. クライアントは `http.ReadRequest` でそれをパースする
3. パースした `*http.Request` を、自分の中の `http.Handler` に食わせる
4. 結果を `httptest.ResponseRecorder` 相当で捕まえ、**HTTP レスポンスとしてシリアライズする**
5. そのバイト列を、指定された URL に POST で送り返す

つまり **HTTP のリクエストとレスポンスを、別の HTTP のペイロードとして運んでいる**。RPC のフレームワークも、独自のメッセージ型も導入していない。

これを c2n (control-to-node) と呼ぶ。

### ハンドラは普通の HTTP ハンドラ

受け側は `http.Handler` そのものだ。`/echo`、`/debug/pprof/heap`、`POST /logtail/flush` といったパスにハンドラが登録される。**`net/http` のミドルウェアもテストの道具もそのまま使える。**

### 公開するものを絞る

pprof のエンドポイントは、`heap` と `allocs` だけが登録されている。コメントに理由が書いてある — 「セキュリティのため、典型的な pprof エンドポイントの一部だけを公開する」。

## ソースコードのどこか

### リクエストの運び方

```go title="tailcfg/tailcfg.go"
	// Types is the types of ping that are initiated. Can be any PingType, comma
	// separated, e.g. "disco,TSMP"
	//
	// As a special case, if Types is "c2n", then this PingRequest is a
	// client-to-node HTTP request. The HTTP request should be handled by this
	// node's c2n handler and the HTTP response sent in a POST to URL. For c2n,
	// the value of URLIsNoise is ignored and only the Noise transport (back to
	// the control plane) will be used, as if URLIsNoise were true.
	Types string `json:",omitzero"`
	...
	// Payload is the ping payload.
	//
	// It is only used for c2n requests, in which case it's an HTTP/1.0 or
	// HTTP/1.1-formatted HTTP request as parsable with http.ReadRequest.
	Payload []byte `json:",omitempty"`
```

[`tailcfg.go#L1899-L1916`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tailcfg/tailcfg.go#L1899)。

**`PingRequest` という既存の型に相乗りしている。** もともとは「このノードから別のノードに ping を打って結果を報告せよ」という指示のための型で、`Types` に `"c2n"` が入ったときだけ意味が変わる。

`Payload` の説明が身も蓋もない — **「`http.ReadRequest` でパースできる HTTP/1.0 か HTTP/1.1 形式の HTTP リクエスト」**。

### 応答の作り方

```go title="feature/c2n/c2n.go"
func answerC2NPing(logf logger.Logf, c2nHandler http.Handler, c *http.Client, pr *tailcfg.PingRequest) {
	if c2nHandler == nil {
		logf("answerC2NPing: c2nHandler not defined")
		return
	}
	hreq, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(pr.Payload)))
	if err != nil {
		logf("answerC2NPing: ReadRequest: %v", err)
		return
	}
	...
	handlerTimeout := time.Minute
	if v := hreq.Header.Get("C2n-Handler-Timeout"); v != "" {
		handlerTimeout, _ = time.ParseDuration(v)
	}
	handlerCtx, cancel := context.WithTimeout(context.Background(), handlerTimeout)
	defer cancel()
	hreq = hreq.WithContext(handlerCtx)
	rec := httprec.NewRecorder()
	c2nHandler.ServeHTTP(rec, hreq)
	cancel()

	c2nResBuf := new(bytes.Buffer)
	rec.Result().Write(c2nResBuf)
	...
	req, err := http.NewRequestWithContext(replyCtx, "POST", pr.URL, c2nResBuf)
```

[`c2n.go#L24-L70`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/c2n/c2n.go#L24)。

**わずか 40 行で RPC 機構が完成している。**

- `http.ReadRequest` — 標準ライブラリのリクエストパーサ
- `httprec.NewRecorder()` — `httptest.ResponseRecorder` のフォーク版
- `rec.Result().Write(buf)` — `http.Response` のシリアライザ

すべて標準ライブラリ (かその小さなフォーク) にすでにあるものだ。書いたのは、それらを繋ぐ配線だけになっている。

タイムアウトが **リクエストヘッダ `C2n-Handler-Timeout` で指定できる** のも面白い。`/debug/pprof/heap` は速いが、ヒープのダンプを取る処理は遅い。サーバ側が処理ごとに待つ時間を指定できる。

### ハンドラの登録

```go title="ipn/ipnlocal/c2n.go"
func init() {
	c2nHandlers = map[methodAndPath]c2nHandler{}
	if buildfeatures.HasC2N {
		// Echo is the basic "ping" handler as used by the control plane to probe
		// whether a node is reachable. In particular, it's important for
		// high-availability subnet routers for the control plane to probe which of
		// several candidate nodes is reachable and actually alive.
		RegisterC2N("/echo", handleC2NEcho)
	}
	if buildfeatures.HasLogTail {
		RegisterC2N("POST /logtail/flush", handleC2NLogtailFlush)
	}
	if buildfeatures.HasDebug {
		RegisterC2N("POST /sockstats", handleC2NSockStats)

		// pprof:
		// we only expose a subset of typical pprof endpoints for security.
		RegisterC2N("/debug/pprof/heap", handleC2NPprof)
		RegisterC2N("/debug/pprof/allocs", handleC2NPprof)
		...
	}
	if runtime.GOOS == "linux" && buildfeatures.HasOSRouter {
		RegisterC2N("POST /netfilter-kind", handleC2NSetNetfilterKind)
	}
}
```

[`c2n.go#L38-L68`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/c2n.go#L38)。

**`/echo` の用途が具体的に書かれている。** 「高可用な subnet router で、複数の候補ノードのうちどれが実際に生きているかを control plane が確かめるために重要」。単なるテスト用ではなく、**フェイルオーバーの判断材料** になっている。

登録がすべて `buildfeatures.Has*` で囲まれているのは、[ビルドタグで機能を落とす](../build-tags/)仕組みのためだ。デバッグ機能を含まないバイナリでは、これらのハンドラごとリンクされない。

### ルーティング

```go title="ipn/ipnlocal/c2n.go"
func (b *LocalBackend) handleC2N(w http.ResponseWriter, r *http.Request) {
	// First try to match by both method and path,
	if h, ok := c2nHandlers[methodAndPath{r.Method, r.URL.Path}]; ok {
		h(b, w, r)
		return
	}
	// Then try to match by just path.
	if h, ok := c2nHandlers[methodAndPath{path: r.URL.Path}]; ok {
		h(b, w, r)
		return
	}
	// Then try prefix matches.
	for _, ph := range c2nPrefixHandlers {
		if strings.HasPrefix(r.URL.Path, ph.prefix) {
			ph.h(b, w, r)
			return
		}
	}
	if c2nHandlerPaths.Contains(r.URL.Path) {
		http.Error(w, "bad method", http.StatusMethodNotAllowed)
	} else {
		http.Error(w, "unknown c2n path", http.StatusBadRequest)
	}
}
```

[`c2n.go#L133-L156`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/c2n.go#L133)。

**`http.ServeMux` を使わずに、自前で 30 行のルータを書いている。** メソッド + パスの完全一致、パスだけの一致、プレフィックス一致の 3 段階。

そして最後の分岐がよい。**パスは登録されているがメソッドが違う場合は 405、パスごと知らない場合は 400** を返す。デバッグする人が「ハンドラがないのか、メソッドを間違えたのか」を区別できる。

### 登録の重複を panic で防ぐ

```go title="ipn/ipnlocal/c2n.go"
// RegisterC2N registers a new c2n handler for the given pattern.
//
// A pattern is like "GET /foo" (specific to an HTTP method) or "/foo" (all
// methods). It panics if the pattern is already registered.
func RegisterC2N(pattern string, h func(*LocalBackend, http.ResponseWriter, *http.Request)) {
	if !buildfeatures.HasC2N {
		return
	}
	k := req(pattern)
	if _, ok := c2nHandlers[k]; ok {
		panic(fmt.Sprintf("c2n: duplicate handler for %q", pattern))
	}
```

[`c2n.go#L70-L83`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/c2n.go#L70)。

`init()` の中で登録されるので、**重複があればプロセス起動時に必ず落ちる**。機能パッケージが自分でハンドラを登録する構造なので、パスの衝突は起こりうる。それをテストではなく起動時に検出する。

## なぜそうなっているか

### なぜ HTTP を HTTP で包むのか

「サーバからクライアントに RPC したい」を素直に解くなら、双方向 RPC (gRPC の双方向ストリーム、WebSocket + JSON-RPC) を導入することになる。

Tailscale がそうしなかった理由は、**すでに long poll という一方向の経路があり、逆方向には普通の HTTP リクエストが使える** からだ。この 2 つを組み合わせれば、新しいプロトコルなしで往復が作れる。

そして「メッセージの形式」を自分で決めなくてよいのが大きい。HTTP リクエスト/レスポンスという形式は、

- **パーサとシリアライザが標準ライブラリにある** (`http.ReadRequest`、`Response.Write`)
- **ハンドラを書く道具が揃っている** (`http.Handler`、ミドルウェア、`httptest`)
- **メソッド、パス、ヘッダ、ステータスコードという語彙をそのまま使える**

独自の RPC 型を定義すると、これらを全部作り直すことになる。「タイムアウトをどう指定するか」は `C2n-Handler-Timeout` ヘッダ 1 行で済み、「エラーをどう返すか」は 405 と 400 で済む。

### なぜ既存の PingRequest に相乗りするのか

`MapResponse` に `C2NRequest` という新しいフィールドを足すこともできた。だが **capability version を上げ、古いサーバと古いクライアントの組み合わせを考える必要が出る**。

`PingRequest` はすでに「サーバがクライアントに何かをさせる」ための汎用の指示だった。`Types` フィールドは文字列で、値の追加はプロトコルの変更にならない。**拡張ポイントが最初から文字列として空いていた** ので、そこに乗せた。

これは設計の巧みさというより、「既存の型にどう収めるか」を優先した実務的な判断に見える。副作用として、`PingRequest` のドキュメントは「Types が c2n のときは他のフィールドの意味が変わる」という但し書きだらけになっている。

### なぜ pprof を絞るのか

`net/http/pprof` を丸ごと公開すると、`/debug/pprof/profile` (CPU プロファイル) や `/debug/pprof/trace` が使えるようになる。これらは **指定した秒数だけプロセスを計測し続ける** ので、長時間の CPU 負荷をかけられる。`/debug/pprof/cmdline` はコマンドライン引数を漏らす。

ヒープとアロケーションのプロファイルなら、取得は一瞬で、内容も (シンボル名とサイズなので) 比較的無害だ。

**「デバッグ機能はサーバから遠隔で叩ける」という設計を選ぶなら、叩けるものを列挙して絞るしかない。** ここでは許可リスト方式になっていて、`RegisterC2N` を呼んだものだけが公開される。

### なぜ自前のルータなのか

`http.ServeMux` は Go 1.22 からメソッドとパスパターンを扱えるようになったが、**マッチしなかったときの挙動を制御できない**。「パスはあるがメソッドが違う」を 405 で返したければ、自分で書く必要がある。

30 行で済む処理のために外部の依存を増やさず、かつ標準ライブラリの意味論に縛られないことを選んでいる。**ルーティングは c2n の登録数 (十数個) を前提にした線形探索で十分** で、性能を考える必要もない。

## どう活かすか

**「サーバからクライアントを呼びたい」ときに、双方向プロトコルを導入せずに済む形がある。** 既存の一方向プッシュ経路 (long poll、SSE、メッセージキュー) で「リクエスト」を配り、クライアントが普通のリクエストで結果を返す。往復を 2 本の一方向で作れば、新しいプロトコルが要らない。

**RPC のメッセージ形式に HTTP をそのまま使うと、道具が全部ついてくる。** パーサ、シリアライザ、ハンドラの抽象、テストの仕組み、ヘッダによる拡張、ステータスコードによるエラー分類。独自の型を定義してもこれらは手に入らない。運ぶ経路が HTTP でなくても (キュー、ファイル、シリアルポート)、**中身のフォーマットとして HTTP を選ぶ**のは有効な選択肢になる。

**拡張ポイントとして文字列フィールドを 1 つ空けておくと、後から新しい意味を足せる。** 型付きの enum は安全だが、値を足すたびにバージョン管理が要る。文字列なら古い実装は「知らない値」として無視できる。ただし Tailscale の `PingRequest` のように、**1 つの型が複数の意味を持ってドキュメントが複雑になる** 代償は付く。

**遠隔で叩けるデバッグ機能は、許可リストで絞る。** 「pprof を全部生やす」は開発環境では便利でも、本番のクライアントに配るバイナリでは攻撃面になる。何を公開するかを 1 箇所に列挙し、そこにコメントで理由を書いておく。

**ハンドラの登録は `init()` + panic で重複を検出する。** 分散して登録される仕組みでは、名前の衝突が実行時まで見つからない。起動時に必ず落ちるようにしておけば、テストを書かなくても CI で見つかる。
