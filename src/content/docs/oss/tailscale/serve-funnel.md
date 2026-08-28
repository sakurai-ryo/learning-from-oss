---
title: "serve と funnel を、1 つの設定木で表す"
description: "TCP ポート・SNI 名・マウントポイントの 3 段のマップで、L4 転送も TLS 終端も静的ファイル配信もリバースプロキシも表現する。funnel はそこに「どの SNI:port を外部に開くか」の集合を足すだけ。CLI をフォアグラウンドで動かしたときの設定は、セッション ID をキーにした別の木に入る。"
group: "その上に載るもの"
sidebar:
  order: 38
---

## 何を学んだか

### serve と funnel

- **serve** — tailnet の中に、このノードのサービスを公開する。`https://myhost.tailnet.ts.net/` で他のノードからアクセスできる
- **funnel** — それを **インターネット全体** に公開する

**両者の違いは「誰がアクセスできるか」だけ** で、設定の構造は共通だ。

### 1 つの構造体で 3 レイヤ

```go
type ServeConfig struct {
	TCP map[uint16]*TCPPortHandler
	Web map[HostPort]*WebServerConfig
	Services map[tailcfg.ServiceName]*ServiceConfig
	AllowFunnel map[HostPort]bool
	Foreground map[string]*ServeConfig
	ETag string
}
```

- **`TCP`** — ポート番号ごとの扱い。「TLS 終端して HTTP として扱う」「そのまま転送する」
- **`Web`** — `"SNI 名:ポート"` ごとの、マウントポイント (`/`、`/api`) からハンドラへのマップ
- **`AllowFunnel`** — どの `SNI:port` を外部に開くか

**L4 (TCP 転送)、L5 (TLS 終端)、L7 (HTTP のパスごとの処理) が、この 3 つのマップの組み合わせで表現される。**

### フォアグラウンドの設定は別の木に

`tailscale serve` を `--bg` なしで実行すると、**その CLI が生きているあいだだけ有効な設定** になる。Ctrl-C で消える。

これを `Foreground` という **セッション ID をキーにしたマップ** で表現する。CLI が死ねば、そのエントリごと消える。

### ETag で競合を検出する

設定の取得時に **ETag を返し、更新時に `If-Match` で送らせる**。2 つの CLI が同時に設定を変更しようとしたら、後者が失敗する。

## ソースコードのどこか

### 設定の全体

```go title="ipn/serve.go"
type ServeConfig struct {
	// TCP are the list of TCP port numbers that tailscaled should handle for
	// the Tailscale IP addresses. (not subnet routers, etc)
	TCP map[uint16]*TCPPortHandler `json:",omitempty"`

	// Web maps from "$SNI_NAME:$PORT" to a set of HTTP handlers
	// keyed by mount point ("/", "/foo", etc)
	Web map[HostPort]*WebServerConfig `json:",omitempty"`

	// Services maps from service name (in the form "svc:dns-label") to a ServiceConfig.
	// Which describes the L3, L4, and L7 forwarding information for the service.
	Services map[tailcfg.ServiceName]*ServiceConfig `json:",omitempty"`

	// AllowFunnel is the set of SNI:port values for which funnel
	// traffic is allowed, from trusted ingress peers.
	AllowFunnel map[HostPort]bool `json:",omitempty"`

	// Foreground is a map of an IPN Bus session ID to an alternate foreground serve config that's valid for the
	// life of that WatchIPNBus session ID. This allows the config to specify ephemeral configs that are used
	// in the CLI's foreground mode to ensure ungraceful shutdowns of either the client or the LocalBackend does not
	// expose ports that users are not aware of.
	Foreground map[string]*ServeConfig `json:",omitempty"`

	// ETag is the checksum of the serve config that's populated
	// by the LocalClient through the HTTP ETag header during a
	// GetServeConfig request and is translated to an If-Match header
	// during a SetServeConfig request.
	ETag string `json:"-"`
}
```

[`serve.go#L53-L83`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/serve.go#L53-L83)。

**`Foreground` の目的が明確に書かれている。** 「クライアントか LocalBackend の異常終了が、ユーザーの知らないポートを開いたままにしないようにする」。

`tailscale serve` をフォアグラウンドで動かして Ctrl-C で止めたとき、**設定が残ってポートが開きっぱなしになる** のを防ぐ。セッション ID に紐づけておけば、セッションが切れた時点で消える。

**`ETag` は `json:"-"` でシリアライズされない。** HTTP のヘッダとして運ばれるもので、設定の一部ではない。**「構造体のフィールドだが、その構造体の内容ではない」** ものの扱い方だ。

### 型としての HostPort

```go title="ipn/serve.go"
// HostPort is an SNI name and port number, joined by a colon.
// There is no implicit port 443. It must contain a colon.
type HostPort string

// Port extracts just the port number from hp.
func (hp HostPort) Port() (uint16, error) {
```

[`serve.go#L85-L92`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/serve.go#L85-L92)。

**「443 の暗黙の補完はない。コロンを必ず含む。」**

`"myhost.ts.net"` と `"myhost.ts.net:443"` を別物として扱わないために、**常にポートを明示させる**。省略を許すと、「省略されたらどう解釈するか」がコードのあちこちに散る。

`string` の型エイリアスにメソッドを生やしているので、**マップのキーとして使いつつ、パースの処理を型に持たせられる**。

### TCP ハンドラの排他性

```go title="ipn/serve.go"
type TCPPortHandler struct {
	// HTTPS, if true, means that tailscaled should handle this connection as an
	// HTTPS request as configured by ServeConfig.Web.
	//
	// It is mutually exclusive with TCPForward.
	HTTPS bool `json:",omitempty"`

	// HTTP, if true, means that tailscaled should handle this connection as an
	// HTTP request as configured by ServeConfig.Web.
	//
	// It is mutually exclusive with TCPForward.
	HTTP bool `json:",omitempty"`

	// TCPForward is the address to forward TCP connections to.
	// It is either a host:port (e.g. "127.0.0.1:3128", "localhost:5432")
	// or a Unix socket path prefixed with "unix:"
	//
	// It is mutually exclusive with HTTPS.
	TCPForward string `json:",omitempty"`

	// TerminateTLS, if non-empty, means that tailscaled should terminate the
	// TLS connections before forwarding them to TCPForward, permitting only the
	// SNI name with this value. It is only used if TCPForward is non-empty.
	TerminateTLS string `json:",omitempty"`

	// ProxyProtocol indicates whether to send a PROXY protocol header
	// before forwarding the connection to TCPForward.
	ProxyProtocol int `json:",omitzero"`
}
```

[`serve.go#L131-L165`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/serve.go#L131-L165)。

**「相互排他」がコメントで宣言されているが、型では表現されていない。**

`HTTPS` と `TCPForward` を両方設定した構造体は作れる。Go には union 型 (sum type) がないので、**「どれか 1 つ」を型で表現できない**。

代わりに、

- **各フィールドのコメントに「〜と相互排他」と書く**
- **検証関数で確認する**
- **`omitempty` でゼロ値をシリアライズしない**

`TerminateTLS` の設計が巧妙だ。**値が SNI 名になっている。** 単なる `bool` にすると「TLS を終端する」しか言えないが、**文字列にすることで「この SNI 名のみ許可する」まで表現できる**。

`ProxyProtocol` が `int` なのは、**PROXY プロトコルにバージョン 1 と 2 がある** からだ。`bool` だと後からバージョンを選べない。[Taildrop がハッシュアルゴリズム名をフィールドにしている](../taildrop/) のと同じ配慮になっている。

### HTTP ハンドラ

```go title="ipn/serve.go"
// HTTPHandler is either a path or a proxy to serve.
type HTTPHandler struct {
	// Exactly one of the following may be set.

	Path  string `json:",omitempty"` // absolute path to directory or file to serve
	Proxy string `json:",omitempty"` // http://localhost:3000/, localhost:3030, 3030

	Text string `json:",omitempty"` // plaintext to serve (primarily for testing)

	AcceptAppCaps []peercap.Cap `json:",omitempty"` // peer capabilities to forward in grant header

	// Redirect, if not empty, is the target URL to redirect requests to.
	// By default, we redirect with HTTP 302 (Found) status.
	// If Redirect starts with '<httpcode>:', then we use that status instead.
	//
	// The target URL supports the following expansion variables:
	//   - ${HOST}: replaced with the request's Host header value
	//   - ${REQUEST_URI}: replaced with the request's full URI (path and query string)
	Redirect string `json:",omitempty"`
}
```

[`serve.go#L167-L189`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/serve.go#L167-L189)。

**`Proxy` のコメントが受け付ける形式を 3 つ示している。** `http://localhost:3000/`、`localhost:3030`、`3030`。**省略記法を許し、それをコメントで例示する。** CLI から `tailscale serve 3000` と書けるのは、この寛容さのおかげだ。

**`Redirect` の `<httpcode>:` プレフィックス** は、1 つの文字列フィールドに 2 つの情報 (ステータスコードと URL) を詰め込む記法だ。フィールドを増やさずに拡張している。

**`AcceptAppCaps`** は、[ACL の capability](../packet-filter/) をバックエンドに HTTP ヘッダとして渡す。「このユーザーは管理者権限を持つ」を、リバースプロキシの先のアプリが知れる。**認可の情報を、既存のヘッダの仕組みで下流に流す。**

### funnel の入り口

```go title="ipn/ipnlocal/serve.go"
// HandleIngressTCPConn handles a TCP connection initiated by the ingressPeer
// proxied to the local node over the PeerAPI.
// Target represents the destination HostPort of the conn.
// srcAddr represents the source AddrPort and not that of the ingressPeer.
// getConnOrReset is a callback to get the connection, or reset if the connection
// is no longer available.
// sendRST is a callback to send a TCP RST to the ingressPeer indicating that
// the connection was not accepted.
func (b *LocalBackend) HandleIngressTCPConn(ingressPeer tailcfg.NodeView, target ipn.HostPort, srcAddr netip.AddrPort, getConnOrReset func() (net.Conn, bool), sendRST func()) {
	...
	if !sc.Valid() {
		logf("got ingress conn w/o serveConfig; rejecting")
		sendRST()
		return
	}

	if !sc.HasFunnelForTarget(target) {
		logf("got ingress conn for unconfigured %q; rejecting", target)
		sendRST()
		return
	}
```

[`serve.go#L436-L462`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/serve.go#L436)。

**funnel の接続は、Tailscale が運用する「ingress ピア」から [peerAPI](../peerapi/) 経由で来る。**

インターネットからの接続は、まず Tailscale のサーバが受ける。そのサーバは **SNI を見て、どのノード宛かを判断し、tailnet 経由でそのノードに転送する**。

つまり **ノード自身がインターネットに直接ポートを開くわけではない**。NAT の内側にいても funnel が使える。

**引数の設計が特徴的だ。**

- `getConnOrReset func() (net.Conn, bool)` — **接続を取得するのを遅延させる**。拒否する場合は取得しない
- `sendRST func()` — 拒否のときに RST を送る

なぜ遅延させるか。**接続を受け取ってしまうと、リソース (バッファ、goroutine) を確保することになる**。設定を確認して拒否できるなら、確保する前に拒否したい。

そして **拒否は「無視」ではなく「RST を送る」**。クライアントは即座に失敗を知る。タイムアウトを待たされない。

### 送信元の伝え方

```go title="ipn/serve.go"
// A FunnelConn wraps a net.Conn that is coming over a
// Funnel connection. It can be used to determine further
// information about the connection, like the source address
// and the target SNI name.
type FunnelConn struct {
	// Conn is the underlying connection.
	net.Conn

	// Target is what was presented in the "Tailscale-Ingress-Target"
	// HTTP header.
	Target HostPort

	// Src is the source address of the connection.
	// This is the address of the client that initiated the
	// connection, not the address of the Tailscale Funnel
	// node which is relaying the connection. That address
	// can be found in Conn.RemoteAddr.
	Src netip.AddrPort
}
```

[`serve.go#L104-L122`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/serve.go#L104-L122)。

**`Src` と `Conn.RemoteAddr()` が違うことが明記されている。**

- `Src` — **本当のクライアント** の IP (インターネット上の誰か)
- `Conn.RemoteAddr()` — **中継している Tailscale のノード** の IP

`net.Conn` を埋め込みつつ、フィールドで元の情報を持つ。**「見た目は普通の `net.Conn` だが、追加情報がある」** という形で、既存のコードにそのまま渡せる。

**プロキシの背後で本当の送信元を知る仕組み** (`X-Forwarded-For`、PROXY プロトコル) の、型としての表現になっている。

## なぜそうなっているか

### なぜ 3 段のマップなのか

HTTP のリバースプロキシの設定は、普通「ルールのリスト」になる (nginx の `server` ブロック、Caddy の設定)。

Tailscale が **マップの入れ子** にしたのは、

- **キーが自然に一意だから**。ポート番号、SNI:port、マウントポイント。同じキーに 2 つのルールはありえない
- **CLI から部分的に更新しやすい**。`tailscale serve --set-path=/api ...` が、マップの 1 エントリを差し替える操作になる
- **JSON として素直**。リストだと「何番目のルール」を指定する必要が出る

**「順序に意味がない」設定はマップで表現する。** nginx のようにルールの順序で優先度が決まる設計だと、リストになる。

### なぜフォアグラウンドの設定を分けるのか

`tailscale serve --bg` は永続的な設定を作る。だが **お試しで使いたい** ことも多い。

```sh
tailscale serve 3000   # Ctrl-C で終わる
```

この設定を通常の `TCP` / `Web` マップに入れると、**CLI が異常終了したとき (kill -9、端末が閉じた) に残る**。ユーザーは「ポートを開いた覚えがない」のに開いたままになる。

`Foreground` に **セッション ID をキーとして入れる** と、`LocalBackend` がセッションの切断を検知した時点で消せる。

**「一時的な設定」を、永続的な設定と同じ木の別の枝に置く。** 型が同じ (`*ServeConfig`) なので、処理を共有できる。そして **「Foreground の中に Foreground は入らない」** とコメントで制約を書いている。

### なぜ ETag なのか

serve の設定は、

- CLI (`tailscale serve`) から
- [web クライアント](../serve-funnel/) から
- Kubernetes operator から

同時に変更されうる。**読んで、変更して、書き戻す** という操作は、その間に他が変更すると失われる (lost update)。

ETag と `If-Match` は、**HTTP が既に持っている楽観的並行制御** だ。

- 読むとき: ETag を返す
- 書くとき: `If-Match: <etag>` を送る
- サーバ側で ETag が変わっていたら **412 Precondition Failed**

**新しい仕組みを作らず、HTTP の標準を使う。** [c2n が HTTP を運ぶ](../c2n/) のと同じ考え方だ。

### なぜ接続の取得を遅延させるのか

funnel の接続は、**インターネットの誰からでも来る**。設定されていないポートへの接続も来る (スキャナ、誤設定)。

接続を受け取ると、

- TLS のハンドシェイクのためのバッファが要る
- goroutine が 1 つ起きる
- タイムアウトのタイマーが要る

**設定を確認するだけなら、これらは不要だ。** `getConnOrReset` をコールバックにすることで、**「使うと決めてから取得する」** ができる。

そして拒否は **RST を送る** — クライアントが即座に失敗を知る。無視すると、クライアントは接続タイムアウトまで待つ。**「拒否することを明示的に伝える」ほうが、双方にとって速い。**

### なぜ funnel が Tailscale のサーバを経由するのか

funnel で公開されるノードは、たいてい NAT の内側にいる。**インターネットから直接接続できない。**

Tailscale が運用する「ingress ノード」が、

1. インターネットからの TCP 接続を受ける
2. **TLS の SNI を見て、どの tailnet のどのノード宛かを判断する** (TLS は終端しない)
3. tailnet 経由でそのノードに転送する

**SNI だけを見て転送するので、Tailscale は通信の中身を復号しない。** TLS の終端は、最終的なノードで行われる。

これは [DERP](../derp/) と同じ構造で、**中継はするが中身は読まない**。

### なぜ相互排他を型で表現しないのか

Go には sum type (union、代数的データ型) がない。「`HTTPS` か `TCPForward` のどちらか一方」を型で表現するには、

- **インターフェースと実装型を用意する** — JSON のシリアライズが複雑になる
- **タグ付き union を手で書く** — 冗長

そして **JSON として素直な形を保ちたい**。設定ファイルとして人が読み書きするし、API のレスポンスにもなる。

だから **「相互排他」をコメントと検証関数で表現する**。型の安全性を犠牲にして、シリアライズの単純さを取っている。

**言語に表現力がないとき、どこで妥協するかの判断** として見るとよい。ここでは「JSON の形」を優先している。

## どう活かすか

**キーが自然に一意な設定は、リストではなくマップにする。** 部分更新が「1 エントリの差し替え」になり、順序を気にしなくてよくなる。**順序に意味がある (先に一致したものが勝つ) 場合だけリストにする。**

**一時的な設定は、永続的な設定と同じ型で別の枝に置く。** セッション ID をキーにすれば、セッション終了時にまとめて消せる。**「異常終了しても残らない」ことが型の構造から保証される。**

**設定の並行更新には、HTTP の ETag / If-Match をそのまま使う。** 独自のバージョン番号やロックを作る前に、既存の仕組みが使えないか考える。**API が HTTP なら、楽観的並行制御は無料で手に入る。**

**bool にしたくなるフィールドを、文字列や整数にできないか考える。** `TerminateTLS` が SNI 名なら「終端する + この名前のみ」を表現できる。`ProxyProtocol` が int ならバージョンを選べる。**後から「どの〜」を追加したくなることは多い。**

**1 つの文字列フィールドに接頭辞で情報を足す記法は、フィールドを増やさずに拡張できる。** `Redirect: "301:https://..."`。ただし **パースの規則をコメントで明示する** 必要がある。

**受け付ける入力形式を寛容にし、その例をコメントに列挙する。** `Proxy` が `3030`、`localhost:3030`、`http://localhost:3000/` を全部受け付けるから、CLI が短く書ける。**寛容さは、例示があって初めて使える。**

**コストのかかるリソースの取得は、コールバックにして遅延させる。** 「使うと決めてから取得する」ことで、拒否する場合のコストがゼロになる。そして **拒否は明示的に伝える** (RST を送る、エラーを返す) — 無視するとクライアントが待たされる。

**プロキシ経由の接続では、「本当の送信元」と「直前のホップ」を型で区別する。** `net.Conn` を埋め込んだ型にフィールドで足せば、既存のコードにそのまま渡しつつ、追加情報も取れる。
