---
title: "キャプティブポータルの内側にいることを検出する"
description: "ホテルの Wi-Fi は、認証するまで全ての HTTP を横取りする。Tailscale はそれを、DERP サーバへの HTTP リクエストにチャレンジヘッダを付けて送り、期待した応答ヘッダが返るかで判定する。しかもインターフェースを 1 つずつ指定して、すべてで試す。"
group: "OS 統合とルーティング"
sidebar:
  order: 30
---

## 何を学んだか

### 「繋がっているが繋がっていない」状態

ホテル、空港、カフェの Wi-Fi は、認証するまで **すべての通信を横取りする**。

- DHCP でアドレスは取れる
- DNS も引ける (ただし答えは偽物)
- HTTP を投げると、認証ページの HTML が返る
- HTTPS は失敗するか、証明書エラーになる

**ネットワーク層では「繋がっている」が、実際には何もできない。** Tailscale から見れば、DERP に繋がらず、STUN も返らず、原因が分からない状態になる。

キャプティブポータルだと分かれば、**ユーザーに「まず Wi-Fi のログインを済ませてください」と伝えられる**。

### 判定方法は「期待した応答が返るか」

Tailscale は既知のエンドポイントに HTTP リクエストを投げ、**応答が期待どおりかを見る**。

エンドポイントは 3 種類。

| 種類               | 内容                                 |
| ------------------ | ------------------------------------ |
| `DERPMapPreferred` | 現在のホーム DERP リージョンのノード |
| `DERPMapOther`     | 他のリージョンの DERP ノード         |
| `Tailscale`        | coordination server や admin console |

**自分が使うインフラを、検出のエンドポイントとして使い回している。**

### チャレンジヘッダで確実に判定する

DERP サーバは特別な機能を持つ。**`X-Tailscale-Challenge` ヘッダを送ると、`X-Tailscale-Response` ヘッダにその値を反映して返す。**

キャプティブポータルはこのヘッダの意味を知らないので、**返せない**。ステータスコードや本文を真似されても、これは真似できない。

### すべてのインターフェースで試す

ノートパソコンが Wi-Fi と Ethernet の両方に繋がっていることがある。片方はキャプティブポータルの内側、もう片方は正常。

だから **インターフェースごとにソケットをバインドして、それぞれで検出する**。

## ソースコードのどこか

### エンドポイントの定義

```go title="net/captivedetection/endpoints.go"
// Endpoint represents a URL that can be used to detect a captive portal, along with the expected
// result of the HTTP request.
type Endpoint struct {
	// URL is the URL that we make an HTTP request to as part of the captive portal detection process.
	URL *url.URL
	// StatusCode is the expected HTTP status code that we expect to see in the response.
	StatusCode int
	// ExpectedContent is a string that we expect to see contained in the response body. If this is non-empty,
	// we will check that the response body contains this string. If it is empty, we will not check the response body
	// and only check the status code.
	ExpectedContent string
	// SupportsTailscaleChallenge is true if the endpoint will return the sent value of the X-Tailscale-Challenge
	// HTTP header in its HTTP response.
	SupportsTailscaleChallenge bool
	// Provider is the source of the endpoint. This is used to prioritize certain endpoints over others
	// (for example, a DERP node in the preferred region should always be used first).
	Provider EndpointProvider
}
```

[`endpoints.go#L46-L63`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/captivedetection/endpoints.go#L46-L63)。

**「期待する結果」がエンドポイントの一部として定義されている。** ステータスコード、本文に含まれるべき文字列、チャレンジに対応しているか。

エンドポイントごとに検証方法が違うので、**URL と検証方法を 1 つの値にまとめる** のが自然な形になっている。

`Provider` は優先順位のためだ。**ホーム DERP リージョンのノードが最優先** — そこは普段から通信している相手なので、繋がるべき場所として最も確実だ。

### 判定のロジック

```go title="net/captivedetection/endpoints.go"
func (e Endpoint) responseLooksLikeCaptive(r *http.Response, logf logger.Logf) bool {
	defer r.Body.Close()

	// Check the status code first.
	if r.StatusCode != e.StatusCode {
		logf("[v1] unexpected status code in captive portal response: want=%d, got=%d", e.StatusCode, r.StatusCode)
		return true
	}

	// If the endpoint supports the Tailscale challenge header, check that the response contains the expected header.
	if e.SupportsTailscaleChallenge {
		expectedResponse := "response ts_" + e.URL.Host
		hasResponse := r.Header.Get("X-Tailscale-Response") == expectedResponse
		if !hasResponse {
			// The response did not contain the expected X-Tailscale-Response header, which means we are most likely
			// behind a captive portal (somebody is tampering with the response headers).
			logf("captive portal check response did not contain expected X-Tailscale-Response header: want=%q, got=%q", expectedResponse, r.Header.Get("X-Tailscale-Response"))
			return true
		}
	}
	...
	hasExpectedContent := mem.Contains(mem.B(b), mem.S(e.ExpectedContent))
	if !hasExpectedContent {
		// The response body did not contain the expected content, that means we are most likely behind a captive portal.
		return true
	}
	return false
}
```

[`endpoints.go#L137-L177`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/captivedetection/endpoints.go#L137-L177)。

**3 段階の検証を、安いものから順に行う。**

1. ステータスコード (ヘッダを読むだけ)
2. チャレンジの応答ヘッダ (同上)
3. 本文の内容 (読み込みが要る)

そして **本文は 4096 バイトまでしか読まない** (`io.LimitReader`)。キャプティブポータルは巨大な HTML を返すことがあるので、上限を切る。

### チャレンジの仕組み

```go title="net/captivedetection/captivedetection.go"
	// Attach the Tailscale challenge header if the endpoint supports it. Not all captive portal detection endpoints
	// support this, so we only attach it if the endpoint does.
	if e.SupportsTailscaleChallenge {
		// Note: the set of valid characters in a challenge and the total
		// length is limited; see isChallengeChar in cmd/derper for more
		// details.
		chal := "ts_" + e.URL.Host
		req.Header.Set("X-Tailscale-Challenge", chal)
	}
```

[`captivedetection.go#L211-L219`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/captivedetection/captivedetection.go#L211-L219)。

**チャレンジの値が `ts_` + ホスト名** になっている。ランダムではない。

ランダムでなくてよいのは、**目的が「本物のサーバか」の確認であって、リプレイ攻撃の防止ではない** からだ。キャプティブポータルは `X-Tailscale-Response` を返す方法を知らないので、値が固定でも検出できる。

そして DERP サーバ側で **チャレンジに使える文字と長さが制限されている**。任意の値を反射させると、**ヘッダインジェクションの経路になる** からだ。コメントが `cmd/derper` の `isChallengeChar` を参照している。

**「値を反射する」機能を作るときは、必ず入力を検証する。** その注意が、使う側のコメントにも書かれている。

### キャッシュを徹底的に避ける

```go title="net/captivedetection/captivedetection.go"
	u := *e.URL
	v := u.Query()
	v.Add("t", strconv.Itoa(int(d.Now().Unix())))
	u.RawQuery = v.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Cache-Control", "no-cache, no-store, must-revalidate, no-transform, max-age=0")
```

[`captivedetection.go#L200-L209`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/captivedetection/captivedetection.go#L200-L209)。

**2 重の対策。**

- **クエリパラメータにタイムスタンプ** を足して、URL を毎回変える
- **`Cache-Control` ヘッダ** で、あらゆるキャッシュを禁止する

`no-transform` が入っているのが目を引く。**中間のプロキシがコンテンツを書き換える (画像の圧縮、HTML の最小化) のを禁止する** ヘッダだ。書き換えられると `ExpectedContent` の検査が失敗し、誤検出になる。

キャプティブポータルの検出は、**「途中で何かが介入したか」を見る** ので、**正当な介入 (キャッシュ、変換) も誤検出の原因になる**。

### HTTP クライアントの設定

```go title="net/captivedetection/captivedetection.go"
	d.httpClient = &http.Client{
		// No redirects allowed
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			DialContext:       d.dialContext,
			DisableKeepAlives: true,
		},
		Timeout: Timeout,
	}
```

[`captivedetection.go#L42-L54`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/captivedetection/captivedetection.go#L42-L54)。

**リダイレクトを追わない。** キャプティブポータルの典型的な挙動は「302 で認証ページへリダイレクト」だ。追ってしまうと、**認証ページのステータスコード (200) を見ることになり、検出できない**。

**Keep-Alive を無効にする。** インターフェースごとに接続を張り直す必要があるので、接続の再利用は邪魔になる。

タイムアウトは 3 秒。

```go title="net/captivedetection/captivedetection.go"
// Timeout is the timeout for captive portal detection requests. Because the captive portal intercepting our requests
// is usually located on the LAN, this is a relatively short timeout.
const Timeout = 3 * time.Second
```

[`captivedetection.go#L63-L65`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/captivedetection/captivedetection.go#L63-L65)。

**「キャプティブポータルは通常 LAN 上にいるので、短めのタイムアウトでよい」。** 横取りしている装置は目の前のルータなので、応答は速い。遅ければ、それは横取りではなく本物のサーバへの通信だ。

### インターフェースごとにバインドする

```go title="net/captivedetection/captivedetection.go"
func (d *Detector) dialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	ifIndex := d.currIfIndex

	dl := &net.Dialer{
		Timeout: Timeout,
		Control: func(network, address string, c syscall.RawConn) error {
			return setSocketInterfaceIndex(c, ifIndex, d.logf)
		},
	}
```

[`captivedetection.go#L234-L245`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/captivedetection/captivedetection.go#L234-L245)。

**[netns](../netns-loop/) と同じ `Control` フックを使って、送信インターフェースを指定する。**

`currIfIndex` をフィールドに持ち、ミューテックスで守っているのは、**`DialContext` のシグネチャにインターフェースを渡す口がない** からだ。クロージャで包むこともできるが、`http.Client` を毎回作り直すことになる。

**「API に引数を追加できないとき、状態をフィールドに置いて排他制御する」** という、素朴だが確実な方法を取っている。

## なぜそうなっているか

### なぜ自前で検出するのか

OS にはキャプティブポータルの検出機能がある (macOS の `captive.apple.com`、Android の `connectivitycheck.gstatic.com`)。だが、

- **OS の判定結果を取れるとは限らない。** API が公開されていない、権限が要る
- **タイミングが合わない。** OS の検出は接続直後に 1 回だけ
- **Tailscale が使う経路とは違う。** OS はデフォルトインターフェースだけを見る

そして **Tailscale が知りたいのは「Tailscale の通信が横取りされているか」** だ。汎用の検出より、自分のインフラへの通信で確かめるほうが正確になる。

### なぜ DERP サーバをエンドポイントにするのか

外部の検出サービス (`captive.apple.com` など) を使うと、

- **そのサービスへの依存が増える。** 落ちたら検出できない
- **プライバシーの懸念。** Tailscale のユーザーが第三者にアクセスすることになる
- **ブロックされることがある。** 企業ネットワークで、Apple や Google のドメインが塞がれている

DERP サーバは **Tailscale が運用しており、クライアントがどのみち接続する相手** だ。追加の依存もプライバシーの懸念もない。

そして **チャレンジヘッダのような独自の仕組みを足せる**。外部サービスには足せない。

### なぜチャレンジヘッダが効くのか

キャプティブポータルは、HTTP リクエストを横取りして自前の応答を返す。ステータスコードや本文は自由に作れるので、**「200 OK で、期待される文字列を含む本文」を返すことは原理的に可能** だ (実際にそうする実装は少ないが)。

だが `X-Tailscale-Challenge` を見て `X-Tailscale-Response` を組み立てるには、**この仕組みを知っている必要がある**。汎用のキャプティブポータルがこれを実装することはない。

**「相手だけが知っている手順」を要求する** のは、認証の基本形だ。ここでは暗号を使わない軽量版になっている。

### なぜリダイレクトを追わないのか

キャプティブポータルの最も典型的な挙動が **302 リダイレクト** だ。`http.Client` は既定でリダイレクトを追うので、そのままだと **認証ページの内容を見てしまう**。

認証ページは 200 を返し、HTML を返す。**「期待どおりでない」ことは検出できるが、リダイレクトという最も明確な証拠を見逃す。**

`http.ErrUseLastResponse` を返すと、**リダイレクトの応答そのもの (302 と Location ヘッダ) が得られる**。

**「エラー処理の自動化」が、検査には邪魔になる場面** の例だ。同じことがタイムアウトの再試行、TLS 証明書の検証、リダイレクトの追跡で起きる。

### なぜ全インターフェースで試すのか

「どのインターフェースがキャプティブポータルの内側か」は、**インターフェースごとに違う**。

- ホテルの Wi-Fi (キャプティブポータル) + テザリング (正常)
- 有線 LAN (正常) + ゲスト Wi-Fi (キャプティブポータル)

デフォルトルートのインターフェースだけを見ると、**「デフォルトはキャプティブだが、別のインターフェースは使える」を見逃す**。逆に「デフォルトは正常だが、別のがキャプティブ」を誤検出することもない。

そして [netcheck](../netcheck/) は複数のインターフェースを使いうるので、**どのインターフェースが使えるかを知る価値がある**。

### なぜ `no-transform` を付けるのか

中間のプロキシがコンテンツを書き換えるのは、正当な機能だ。モバイル回線での画像圧縮、HTML の最小化、広告の挿入。

だが **キャプティブポータルの検出は「応答が改変されていないか」を見る** ので、正当な改変も「改変された」と判定してしまう。

`no-transform` は「この応答を変換するな」を明示する HTTP の標準ヘッダだ。守るかどうかは中間装置次第だが、**守る装置には効く**。

**「介入を検出する仕組み」は、正当な介入と悪意ある介入を区別できない。** 正当な介入を明示的に禁止することで、区別の必要をなくしている。

## どう活かすか

**「接続はできるが通信できない」状態を、明示的に検出する。** TCP は繋がるが応答が違う、DNS は引けるが答えが偽物。この種の失敗は「タイムアウト」より診断が難しい。**専用の検出を用意すると、ユーザーに具体的な行動 (「Wi-Fi にログインしてください」) を提示できる。**

**検証には「相手だけが知っている手順」を使う。** ステータスコードや本文は偽装できる。「送った値を特定の形で返す」ことを要求すれば、その仕組みを知らない中間者は通れない。暗号を使わなくても、多くのケースで十分だ。

**反射する値には、必ず文字種と長さの制限をかける。** 「送られた値をヘッダに返す」機能は、ヘッダインジェクションの入り口になる。そして **使う側のコメントにも「制限がある」ことを書く** と、制限を知らずに拡張されるのを防げる。

**「途中で何かが介入したか」を見る検査では、正当な介入も禁止する。** キャッシュ、変換、リダイレクト。正当な機能が、検査の妨げになる。ヘッダやクライアント設定で明示的に無効化する。

**自動化された便利な挙動 (リダイレクト追跡、再試行) は、検査の場面では無効にする。** `http.Client` の既定はアプリケーションのためのもので、プロトコルの検査には向かない。何を無効にするかを意識的に選ぶ。

**すでに接続している相手を、検査のエンドポイントとして使い回す。** 外部サービスへの依存が増えず、プライバシーの懸念もなく、独自の検査手順を足せる。

**API に引数を足せないとき、状態をフィールドに置いて排他制御するのは正当な選択。** `DialContext` にインターフェースを渡す口はない。クロージャで包み直すより、フィールド + ミューテックスのほうが単純なことがある。
