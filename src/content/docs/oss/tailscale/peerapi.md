---
title: "ノードどうしが直接叩ける HTTP エンドポイント"
description: "WireGuard で暗号化された経路の上に、平文の HTTP/2 を流す。認証は「そのパケットがどのピアから来たか」で完結し、トークンもセッションもない。ブラウザからのリクエストかどうかを Accept-Encoding ヘッダで推測し、そのときだけセキュリティヘッダを付ける。"
group: "その上に載るもの"
sidebar:
  order: 35
---

## 何を学んだか

### ノード間の RPC 基盤

tailnet のノードどうしが直接やりとりする機能がいくつもある。

- [Taildrop](../taildrop/) のファイル転送
- exit node の [DNS 代理](../split-dns/) (`/dns-query`)
- 他のノードの内部状態を覗く (`/v0/goroutines`、`/v0/magicsock`)
- Tailscale Drive のファイル共有

これらは全部 **peerAPI という 1 つの HTTP サーバ** の上に載っている。

### 認証は経路そのもの

peerAPI に **トークンも Cookie もセッションもない**。

理由は単純で、**そのリクエストがどのピアから来たかは、WireGuard の復号で既に確定している** からだ。パケットが届いた時点で、送信者の node key が分かっている。

ハンドラは `h.peerNode` で相手のノードを見て、[ACL の capability](../packet-filter/) で権限を判断する。

### TLS を使わない

peerAPI は **平文の HTTP** だ。ただし、

```go
httpServer.Protocols.SetHTTP1(true)
httpServer.Protocols.SetUnencryptedHTTP2(true) // over WireGuard; "unencrypted" means no TLS
```

**「WireGuard の上を流れるので、"暗号化なし" とは TLS がないという意味」** とコメントされている。

### ブラウザかどうかを推測する

peerAPI は基本的に `tailscaled` 同士の RPC だが、**curl やブラウザでデバッグすることもある**。

ブラウザからのアクセスには CSP や `X-Frame-Options` を付けたい。だが **すべてのリクエストに付けると、ヘッダのバイト数が無駄になる**。

そこで **`Accept-Encoding`、`User-Agent`、`Accept-Language` を見て、ブラウザらしいときだけ付ける**。

## ソースコードのどこか

### リスナの作り方

```go title="ipn/ipnlocal/peerapi.go"
func (s *peerAPIServer) listen(ip netip.Addr, tunIfIndex int) (ln net.Listener, err error) {
	// Android for whatever reason often has problems creating the peerapi listener.
	// But since we started intercepting it with netstack, it's not even important that
	// we have a real kernel-level listener. So just create a dummy listener on Android
	// and let netstack intercept it.
	if runtime.GOOS == "android" {
		return newFakePeerAPIListener(ip), nil
	}
	...
	if initListenConfig != nil {
		// On iOS/macOS, this sets the lc.Control hook to
		// setsockopt the interface index to bind to, to get
		// out of the network sandbox.

		// A zero tunIfIndex is invalid for peerapi.  A zero value will not get us
		// out of the network sandbox.  Caller should log and retry.
		if tunIfIndex == 0 {
			return nil, fmt.Errorf("peerapi: cannot listen on %s with tunIfIndex 0", ipStr)
		}
```

[`peerapi.go#L60-L85`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/peerapi.go#L60-L85)。

**Android では「偽のリスナ」を作る。** 実際にポートを開かず、[netstack](../netstack/) が横取りする。

「なぜか分からないが Android ではリスナの作成にしばしば失敗する。だが netstack で横取りするようになってからは、**カーネルレベルの本物のリスナがあることは重要ですらない**」。

**原因を突き止められなかったが、別の仕組みで回避できたので、そちらに倒した。** 「なぜか分からない」と正直に書いてある。

iOS/macOS では逆に、**ネットワークサンドボックスから出るためにインターフェースへのバインドが必須** で、それができない (`tunIfIndex == 0`) 場合は明示的にエラーにする。**「呼び出し側はログを出して再試行せよ」** という指示付き。

### リクエストの検証

```go title="ipn/ipnlocal/peerapi.go"
func (h *peerAPIHandler) validatePeerAPIRequest(r *http.Request) error {
	if r.Referer() != "" {
		return errors.New("unexpected Referer")
	}
	if r.Header.Get("Origin") != "" {
		return errors.New("unexpected Origin")
	}
	return h.validateHost(r)
}
```

[`peerapi.go#L290-L299`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/peerapi.go#L290-L299)。

**`Referer` と `Origin` があったら拒否する。**

これは **DNS リバインディング攻撃と CSRF への対処** だ。攻撃者のウェブページが、ブラウザから `http://100.x.y.z:PORT/v0/...` にリクエストを送ろうとすると、ブラウザは必ず `Origin` を付ける。

**「ブラウザから送られたリクエストは、すべて拒否する」** という単純な規則で、CORS の設定より確実だ。

`validateHost` は、**Host ヘッダが自分のアドレスか `peer` であること** を確認する。これも DNS リバインディング対策で、攻撃者のドメイン名が Host に入っていたら拒否する。

### アドレスの検証

```go title="ipn/ipnlocal/peerapi.go"
// isAddressValid reports whether addr is a valid destination address for this
// node originating from the peer.
func (h *peerAPIHandler) isAddressValid(addr netip.Addr) bool {
	if !addr.IsValid() {
		return false
	}
	v4MasqAddr, hasMasqV4 := h.peerNode.SelfNodeV4MasqAddrForThisPeer().GetOk()
	v6MasqAddr, hasMasqV6 := h.peerNode.SelfNodeV6MasqAddrForThisPeer().GetOk()
	if hasMasqV4 || hasMasqV6 {
		return addr == v4MasqAddr || addr == v6MasqAddr
	}
	pfx := netip.PrefixFrom(addr, addr.BitLen())
	return views.SliceContains(h.selfNode.Addresses(), pfx)
}
```

[`peerapi.go#L262-L275`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/peerapi.go#L262-L275)。

**「そのピアから見た自分のアドレス」が、自分の本当のアドレスと違う場合がある。**

`SelfNodeV4MasqAddrForThisPeer` は、**アドレスの衝突を避けるための NAT** だ。2 つの tailnet を接続するとき、同じ `100.x.y.z` が両方にあると困る。そこでピアごとに違うアドレスを見せる。

**検証は「そのピアが知っている自分のアドレス」に対して行う必要がある。** 本当のアドレスで検証すると、masquerade されているピアからのリクエストが全部弾かれる。

### ブラウザの推測

```go title="ipn/ipnlocal/peerapi.go"
// peerAPIRequestShouldGetSecurityHeaders reports whether the PeerAPI request r
// should get security response headers. It aims to report true for any request
// from a browser and false for requests from tailscaled (Go) clients.
//
// PeerAPI is primarily an RPC mechanism between Tailscale instances. Some of
// the HTTP handlers are useful for debugging with curl or browsers, but in
// general the client is always tailscaled itself. Because PeerAPI only uses
// HTTP/1 without HTTP/2 and its HPACK helping with repetitive headers, we try
// to minimize header bytes sent in the common case when the client isn't a
// browser. Minimizing bytes is important in particular with the ExitDNS service
// provided by exit nodes, processing DNS clients from queries. We don't want to
// waste bytes with security headers to non-browser clients. But if there's any
// hint that the request is from a browser, then we do.
func peerAPIRequestShouldGetSecurityHeaders(r *http.Request) bool {
	// Accept-Encoding is a forbidden header
	// (https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)
	// that Chrome, Firefox, Safari, etc send, but Go does not. So if we see it,
	// it's probably a browser and not a Tailscale PeerAPI (Go) client.
	if httpguts.HeaderValuesContainsToken(r.Header["Accept-Encoding"], "deflate") {
		return true
	}
	// Clients can mess with their User-Agent, but if they say Mozilla or have a bunch
	// of components (spaces) they're likely a browser.
	if ua := r.Header.Get("User-Agent"); strings.HasPrefix(ua, "Mozilla/") || strings.Count(ua, " ") > 2 {
		return true
	}
	// Tailscale/PeerAPI/Go clients don't have an Accept-Language.
	if r.Header.Get("Accept-Language") != "" {
		return true
	}
	return false
}
```

[`peerapi.go#L301-L332`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/peerapi.go#L301-L332)。

**判定材料が 3 つ、それぞれ理由つき。**

1. **`Accept-Encoding: deflate`** — ブラウザは送るが、Go の HTTP クライアントは送らない (Go は `gzip` だけ)。しかも「forbidden header」なので、JavaScript から偽装できない
2. **`User-Agent` が `Mozilla/` で始まる、またはスペースが 3 個以上** — ブラウザの UA は複雑
3. **`Accept-Language` がある** — Go のクライアントは送らない

**節約したいバイト数の理由が具体的だ。** exit node の DNS 代理では、**1 クエリごとに HTTP のやりとりが発生する**。CSP のヘッダは 200 バイト近くあり、DNS の応答本体より大きい。

**「セキュリティヘッダは、必要な相手にだけ送る」** — 一般には「常に送る」が正しいが、**クライアントの大半が自分の実装** である場合には最適化の余地がある。

そして判定を外した場合の影響も考えられている。**ブラウザだと判定し損ねても、`Referer`/`Origin` の検査で既にブロックされている。** 多層防御になっている。

### ハンドラの登録

```go title="ipn/ipnlocal/peerapi.go"
// RegisterPeerAPIHandler registers a PeerAPI handler.
//
// The path should be of the form "/v0/foo".
//
// It panics if the path is already registered.
func RegisterPeerAPIHandler(path string, f func(PeerAPIHandler, http.ResponseWriter, *http.Request)) {
```

```go title="ipn/ipnlocal/peerapi.go"
// PeerAPIHandler is the interface implemented by [peerAPIHandler] and needed by
// module features registered via tailscale.com/feature/*.
type PeerAPIHandler interface {
	Peer() tailcfg.NodeView
	PeerCaps() tailcfg.PeerCapMap
	CanDebug() bool // can remote node can debug this node (internal state, etc)
	Self() tailcfg.NodeView
	LocalBackend() *LocalBackend
	IsSelfUntagged() bool // whether the peer is untagged and the same as this user
	RemoteAddr() netip.AddrPort
	Logf(format string, a ...any)
}
```

[`peerapi.go#L230-L241`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/peerapi.go#L230-L241)。

**機能パッケージ (`feature/taildrop` など) が、自分のハンドラを登録する。** [c2n](../c2n/) と同じ構造で、`init()` での登録と重複時の panic。

`PeerAPIHandler` インターフェースが、**ハンドラに渡す文脈を型として定義している**。

- `Peer()` — 誰から来たか
- `PeerCaps()` — そのピアに何が許可されているか
- `CanDebug()` — デバッグ情報を見せてよいか
- `IsSelfUntagged()` — 同じユーザーの、タグなしノードか

**認可に必要な情報が、インターフェースのメソッドとして揃っている。** 機能パッケージは `LocalBackend` の内部を知らずに、認可の判断ができる。

### タグの扱い

```go title="ipn/ipnlocal/peerapi.go"
func (h *peerAPIHandler) IsSelfUntagged() bool {
	return !h.selfNode.IsTagged() && !h.peerNode.IsTagged() && h.isSelf
}
```

[`peerapi.go#L243-L245`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/peerapi.go#L243-L245)。

**「同じユーザーのノード」と言えるのは、両方がタグなしの場合だけ。**

[ACL タグ](../netmap/) が付いたノードは、特定のユーザーではなく「役割」に属する。`tag:prod` のサーバは、作成したユーザーのものではない。

だから **「自分の他のデバイスだから信用する」という判断は、両方がタグなしのときにのみ有効** になる。3 つの条件の AND という短い式に、この考え方が込められている。

## なぜそうなっているか

### なぜ TLS を使わないのか

WireGuard のトンネルの中は、既に暗号化されている。その上に TLS を重ねると、

- **二重の暗号化で CPU を使う**
- **証明書が要る。** ノードごとに証明書を発行し、更新する仕組みが必要になる
- **ハンドシェイクの往復が増える**

そして **認証としても不要** だ。TLS のクライアント証明書で「誰か」を確認するより、**WireGuard の復号で既に確定している** ほうが強い。

[control プロトコルで Noise を使う](../noise-transport/) のと同じ判断で、**「その層で何が保証されているか」を見て、上の層で重複させない**。

### なぜトークンやセッションがないのか

HTTP の認証は普通、**接続の識別子と認証情報を紐づける** 仕組みが要る。Cookie、Bearer トークン、mTLS。

peerAPI では、**パケットの送信元アドレスが認証情報そのもの** だ。`100.x.y.z` から来たリクエストは、そのアドレスを持つノードから来たことが、WireGuard によって保証されている。

**IP アドレスを認証に使うのは通常アンチパターン** だ (詐称できるので)。だが Tailscale では詐称できない — 詐称するには WireGuard の秘密鍵が要る。

**「下の層が保証していること」を明確にすると、上の層を単純にできる。** ただしその前提が崩れたときに全部崩れるので、前提を文書化する必要がある。

### なぜブラウザからのリクエストを全部拒否するのか

peerAPI のアドレス (`100.x.y.z:PORT`) は、**同じマシンのブラウザから到達できる**。

攻撃者のウェブページが JavaScript で `fetch('http://100.101.102.103:1234/v0/put/...')` を実行すると、**ブラウザはそのリクエストを送る**。CORS は応答の読み取りを制限するが、**リクエストの送信自体は行われる**。

`Origin` ヘッダを見て拒否すれば、**ブラウザ経由のリクエストは全部止まる**。ブラウザは `Origin` を必ず付け、JavaScript から削除できない。

**CORS を正しく設定するより、「ブラウザからは一切受け付けない」ほうが単純で確実だ。** peerAPI は RPC なので、ブラウザから使う必要がない。

そして [Tailscale の web クライアント](../serve-funnel/) のようにブラウザから使いたいものは、**別の経路 (LocalAPI や serve) を通る**。

### なぜセキュリティヘッダを条件付きにするのか

一般論としては「セキュリティヘッダは常に付ける」が正しい。付け忘れが脆弱性になるからだ。

だが peerAPI には特殊事情がある。

- **クライアントのほぼ全部が自分の実装** (tailscaled)
- **exit node の DNS 代理では、1 クエリごとに HTTP のやりとり** が発生する
- **HTTP/1 なので、HPACK によるヘッダ圧縮がない**

CSP のヘッダは 200 バイト弱。DNS の応答は数十〜数百バイト。**ヘッダのほうが本体より大きくなる。**

そして **判定を外しても致命的でない** — `Origin` の検査が先に効くので、ブラウザからのリクエストはそもそも拒否される。セキュリティヘッダは二重の防御にすぎない。

**「常にやる」が正しい対策でも、コストと効果を測ると条件付きにできる場面がある。** ただしその判断には、**多層防御の他の層が効いていることの確認**が要る。

### なぜ masquerade アドレスを考慮するのか

2 つの組織が tailnet を接続するとき、**同じ `100.x.y.z` を持つノードが両側にありうる**。CGNAT の範囲は広いが、無限ではない。

そこで control server が「この tailnet から見た、あのノードのアドレス」を別に割り当てる。相手から見た自分のアドレスが、自分が知っているアドレスと違う。

**Host ヘッダの検証を「自分の本当のアドレス」で行うと、masquerade されたピアからのリクエストが全部弾かれる。** 「そのピアから見た自分のアドレス」で検証する必要がある。

**「相手から見た自分」と「自分から見た自分」が違う環境では、検証の基準を相手側に合わせる。**

## どう活かすか

**下の層が認証を保証しているなら、上の層で重複させない。** mTLS の上に Bearer トークンを重ねる、VPN の中で TLS を張る。**「この層で何が保証されているか」を明文化し、それに依存する判断をコメントに書く。** 前提が崩れたときに気づけるようにする。

**ブラウザから到達できるローカルの HTTP サーバは、`Origin`/`Referer` を見て一律に拒否する。** CORS の設定より単純で確実だ。ブラウザから使う必要がある機能は、別の経路を用意する。**「ブラウザから使わない」と決められるなら、それが最も安全。**

**クライアントの種類を推測して挙動を変えるなら、複数の材料を使い、それぞれの根拠を書く。** `Accept-Encoding: deflate` は「ブラウザは送る、Go は送らない、しかも JavaScript から偽装できない」という 3 つの性質を持つ。判定材料としての質が高い理由を書いておく。

**最適化のために防御を条件付きにするなら、他の層が効いていることを確認する。** セキュリティヘッダを省いてよいのは、`Origin` の検査が先に効くからだ。**単独の防御を条件付きにしてはいけない。**

**ハンドラに渡す文脈を、インターフェースとして定義する。** `Peer()`、`PeerCaps()`、`CanDebug()`。認可に必要な情報が揃っていれば、機能パッケージは本体の内部を知らずに正しく判断できる。

**「相手から見た自分」と「自分から見た自分」が違いうる環境では、検証の基準を相手側に合わせる。** マルチテナント、アドレス変換、プロキシの背後。自分の認識で検証すると、正当なリクエストを弾く。

**原因が分からない問題は、別の仕組みで回避してよい。** 「なぜか Android ではリスナ作成が失敗する。だが netstack で横取りするので本物のリスナは不要」— **原因究明より、その機能が本当に必要かを問い直すほうが速いことがある。**
