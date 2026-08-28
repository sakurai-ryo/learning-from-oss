---
title: "カーネルを使わずに TCP/IP を喋る"
description: "TUN デバイスを作れない環境のために、gVisor の netstack をユーザー空間の TCP/IP スタックとして組み込む。NIC は 1 枚だけ作り、promiscuous モードで全部受ける。gVisor の RACK は性能が出ないので無効化し、輻輳制御は整数オーバーフローを避けるために reno に固定している。"
group: "データパス"
sidebar:
  order: 23
---

## 何を学んだか

### TUN が使えない環境がある

Tailscale は通常、OS の TUN デバイスを作り、カーネルのネットワークスタックにパケットを渡す。だがそれができない場合がある。

- **権限がない** — 非 root のコンテナ、権限のないユーザー
- **TUN デバイスが存在しない** — 一部のコンテナ環境、iOS の一部構成
- **そもそもプロセス内で完結させたい** — [tsnet](../tsnet/) でライブラリとして使う場合

このために **gVisor の netstack を使い、ユーザー空間で TCP/IP を実装する**。

gVisor は Google のコンテナサンドボックスで、その中の `netstack` は **Go で書かれた完全な TCP/IP スタック** だ。TCP の輻輳制御も、IPv6 の近隣探索も、全部 Go のコードで動く。

### 3 つのモード

`Impl` には 2 つの真偽値があり、組み合わせで動作が決まる。

| `ProcessLocalIPs` | `ProcessSubnets` | 用途                                                                            |
| ----------------- | ---------------- | ------------------------------------------------------------------------------- |
| false             | false            | TUN モード。netstack は [serve](../serve-funnel/) や peerAPI 用のリスナだけ扱う |
| true              | false            | ユーザー空間モード。自分宛の通信を netstack が処理する                          |
| —                 | true             | [subnet router](../subnet-router-exit-node/)。自分宛でないパケットも転送する    |

### gVisor の既定値を 3 つ変えている

初期化のコードは、gVisor の設定を上書きする。

- **SACK を有効化** — gVisor では既定で無効
- **RACK を無効化** — 「gVisor の RACK は性能が悪い」
- **輻輳制御を reno に固定** — 「cubic だと gVisor の整数オーバーフローを踏みやすい」

**上流ライブラリのバグと性能問題への対処が、初期化コードに issue 番号つきで並んでいる。**

### NIC は 1 枚、promiscuous モード

netstack の中に作る仮想 NIC は 1 枚だけ。**すべての IP 宛のパケットを受け取る (promiscuous)** 設定にし、デフォルトルートを 2 本 (v4/v6) 入れる。

理由がコメントに書かれている。**「WireGuard は我々宛のパケットしか送ってこないので、NIC が受け取ってはいけないものを受け取ることはない」。**

## ソースコードのどこか

### モードのスイッチ

```go title="wgengine/netstack/netstack.go"
	// ProcessLocalIPs is whether netstack should handle incoming
	// traffic directed at the Node.Addresses (local IPs).
	// It can only be set before calling Start.
	ProcessLocalIPs bool

	// ProcessSubnets is whether netstack should handle incoming
	// traffic destined to non-local IPs (i.e. whether it should
	// be a subnet router).
	// It can only be set before calling Start.
	ProcessSubnets bool
```

[`netstack.go#L198-L207`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack.go#L198-L207)。

**同じコードが、TUN モードの補助にも、完全なユーザー空間ネットワークにも、subnet router にもなる。** 違いは真偽値 2 つ。

### フローごとのハンドラ

```go title="wgengine/netstack/netstack.go"
	// GetTCPHandlerForFlow conditionally handles an incoming TCP flow for the
	// provided (src/port, dst/port) 4-tuple.
	//
	// A nil value is equivalent to a func returning (nil, false).
	//
	// If func returns intercept=false, the default forwarding behavior (if
	// ProcessLocalIPs and/or ProcesssSubnetIPs) takes place.
	//
	// When intercept=true, the behavior depends on whether the returned handler
	// is non-nil: if nil, the connection is rejected. If non-nil, handler takes
	// over the TCP conn.
	GetTCPHandlerForFlow func(src, dst netip.AddrPort) (handler func(net.Conn), intercept bool)
```

[`netstack.go#L161-L172`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack.go#L161-L172)。

**戻り値が 2 つあり、4 通りの意味を持つ。**

| `intercept` | `handler` | 意味                         |
| ----------- | --------- | ---------------------------- |
| false       | —         | 既定の転送に任せる           |
| true        | nil       | **接続を拒否する**           |
| true        | 非 nil    | このハンドラが接続を引き取る |

`(nil, false)` と `(nil, true)` の違いが「任せる」と「拒否」になる。**2 値の組み合わせで 3 つの意味を表現している** ので、ドキュメントがないと読めない。だからドキュメントに全部書いてある。

この仕組みで [serve/funnel](../serve-funnel/)、[peerAPI](../peerapi/)、[Tailscale SSH](../tailscale-ssh/) が「特定のポートへの TCP を引き取る」を実現している。

### gVisor の設定を上書きする

```go title="wgengine/netstack/netstack.go"
	sackEnabledOpt := tcpip.TCPSACKEnabled(true) // TCP SACK is disabled by default
	tcpipErr := ipstack.SetTransportProtocolOption(tcp.ProtocolNumber, &sackEnabledOpt)
	...
	// See https://github.com/tailscale/tailscale/issues/9707
	// gVisor's RACK performs poorly. ACKs do not appear to be handled in a
	// timely manner, leading to spurious retransmissions and a reduced
	// congestion window.
	tcpRecoveryOpt := tcpip.TCPRecovery(0)
	tcpipErr = ipstack.SetTransportProtocolOption(tcp.ProtocolNumber, &tcpRecoveryOpt)
	...
	// gVisor defaults to reno at the time of writing. We explicitly set reno
	// congestion control in order to prevent unexpected changes. Netstack
	// has an int overflow in sender congestion window arithmetic that is more
	// prone to trigger with cubic congestion control.
	// See https://github.com/google/gvisor/issues/11632
	renoOpt := tcpip.CongestionControlOption("reno")
	tcpipErr = ipstack.SetTransportProtocolOption(tcp.ProtocolNumber, &renoOpt)
```

[`netstack.go#L356-L379`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack.go#L356)。

**3 つとも理由が書かれている。**

**RACK の無効化** — RACK (Recent ACKnowledgment) は損失検出のアルゴリズムで、本来は性能が上がる。だが gVisor の実装では「ACK が適時に処理されず、不要な再送と輻輳ウィンドウの縮小を招く」。issue 番号つき。

**reno への固定** — 「今のところ gVisor の既定は reno だが、明示的に設定して予期しない変更を防ぐ」。そして本当の理由が続く — **「netstack の送信側輻輳ウィンドウの計算に整数オーバーフローがあり、cubic だと踏みやすい」**。上流の issue 番号つき。

**「既定値と同じ値を明示的に設定する」** という一見無意味なコードに、明確な理由がある。上流が既定を変えたときに、こちらが壊れないようにしている。

### プラットフォームごとにバッファサイズを変える

```go title="wgengine/netstack/netstack_tcpbuf_default.go"
	tcpRXBufDefSize = tcp.DefaultSendBufferSize
	tcpRXBufMaxSize = 8 << 20 // 8MiB
	...
	tcpTXBufMaxSize = 6 << 20 // 6MiB
```

```go title="wgengine/netstack/netstack_tcpbuf_ios.go"
	// tcp{RX,TX}Buf{Min,Def,Max}Size mirror gVisor defaults. We leave these
	// unchanged on iOS for now as to not increase pressure towards the
	// NetworkExtension memory limit.
	// TODO(jwhited): test memory/throughput impact of collapsing to values in _default.go
	tcpRXBufMinSize = tcp.MinBufferSize
	tcpRXBufDefSize = tcp.DefaultSendBufferSize
	tcpRXBufMaxSize = tcp.MaxBufferSize
```

[`netstack_tcpbuf_default.go`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack_tcpbuf_default.go) と [`netstack_tcpbuf_ios.go`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack_tcpbuf_ios.go)。

**iOS の Network Extension には厳しいメモリ制限がある** (数十 MB)。TCP のバッファを 8 MiB に広げると、数本の接続で制限に達してプロセスが殺される。

だから iOS だけは gVisor の既定値のまま。**ビルドタグでファイルを分けて、定数だけを差し替えている。** 条件分岐ではなくファイル分割なので、iOS のバイナリには 8 MiB という値が入らない。

### 同時接続数の上限も環境ごと

```go title="wgengine/netstack/netstack.go"
func maxInFlightConnectionAttempts() int {
	if n := maxInFlightConnectionAttemptsForTest.Load(); n > 0 {
		return int(n)
	}

	if version.IsMobile() {
		return 1024 // previous global value
	}
	switch version.OS() {
	case "linux":
		// On the assumption that most subnet routers deployed in
		// production are running on Linux, we return a higher value.
		//
		// TODO(andrew-d): tune this based on the amount of system
		// memory instead of a fixed limit.
		return 8192
	default:
		return 2048
	}
}

func maxInFlightConnectionAttemptsPerClient() int {
	...
	// For now, allow each individual client at most 2/3rds of the global
	// limit.
	return maxInFlightConnectionAttempts() * 2 / 3
}
```

[`netstack.go#L84-L120`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack.go#L84-L120)。

**「本番の subnet router はたいてい Linux で動いているだろう」という推測に基づいて、Linux だけ 4 倍にしている。**

そして **クライアントごとの上限が全体の 2/3** に設定されている。1 台のクライアントが全体の枠を食い潰さないようにしつつ、**1 台しかいない場合はほぼ全部使える**。「公平性」と「単独利用時の性能」の折衷になっている。

### NIC を 1 枚にして promiscuous に

```go title="wgengine/netstack/netstack.go"
	// By default the netstack NIC will only accept packets for IPs
	// registered to it. Since in some cases we dynamically register IPs
	// based on the packets that arrive, the NIC needs to accept all
	// incoming packets. The NIC won't receive anything it isn't meant to
	// since WireGuard will only send us packets that are meant for us.
	ipstack.SetPromiscuousMode(nicID, true)
	// Add IPv4 and IPv6 default routes, so all incoming packets from the Tailscale side
	// are handled by the one fake NIC we use.
	...
	ipstack.SetRouteTable([]tcpip.Route{
		{
			Destination: ipv4Subnet,
			NIC:         nicID,
		},
		{
			Destination: ipv6Subnet,
			NIC:         nicID,
		},
	})
```

[`netstack.go#L396-L421`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack.go#L396)。

**「WireGuard が我々宛でないものを送ってくることはない」という前提で、NIC のアドレス検査を省いている。**

これは正しい。[パケットフィルタ](../packet-filter/) が「宛先が自分に許された範囲か」を既にチェックしているし、そもそも WireGuard の復号を通ったパケットは正規のピアから来ている。**同じ検査を 2 回やらない。**

デフォルトルート 2 本も同じ発想だ。**netstack の中に本物のルーティングテーブルを持つ意味がない** — NIC が 1 枚しかないので、全部そこへ送ればよい。

### 起動前のパケットを捨てる

```go title="wgengine/netstack/netstack.go"
	// Before Start is called, there can IPv6 Neighbor Discovery from the
	// OS landing on netstack. We need to drop those packets until Start.
	ready atomic.Bool // set to true once Start has been called
```

[`netstack.go#L223-L225`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack.go#L223-L225)。

**TUN デバイスを作った瞬間から、OS は IPv6 の近隣探索を送ってくる。** ハンドラの登録が終わる前にそれを処理すると、中途半端な状態で応答してしまう。

[tstun の corked モード](../tstun/) と同じ問題で、こちらは真偽値 1 個で解決している。

### keepalive を短くする

```go title="wgengine/netstack/netstack.go"
// netstackKeepaliveIdle overrides the netstack default (~2h) TCP keepalive
// idle time for forwarded connections. When a tailnet peer goes away without
// closing its connections (pod deleted, peer removed from netmap, silent
// network partition), the forwardTCP io.Copy goroutines block until keepalive
// fires. Under high-churn forwarding — many short-lived peers, or peers
// holding thousands of proxied connections that drop at once — the 2h default
// lets stuck goroutines accumulate faster than they clear.
```

[`netstack.go#L124-L131`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netstack/netstack.go#L124)。

**問題の連鎖が具体的に書かれている。** ピアが接続を閉じずに消える (Pod が削除された、netmap から外れた、静かに分断された) → `io.Copy` の goroutine が keepalive まで固まる → 既定の 2 時間では、詰まる速度が解消する速度を上回る → goroutine が積み上がる。

**「goroutine リークではないが、実質的にリークと同じ症状になる」** ケースだ。TCP の既定値は「接続がめったに切れない」前提だが、tailnet ではピアの入れ替わりが激しい。

## なぜそうなっているか

### なぜユーザー空間の TCP/IP スタックが必要か

TUN デバイスの作成には特権が要る。Linux なら `CAP_NET_ADMIN`、macOS なら root。**この特権を要求できない場面がある。**

- Kubernetes の Pod で、特権を落として動かしたい
- CI の中で Tailscale を使いたい
- Go のプログラムに Tailscale を組み込みたい ([tsnet](../tsnet/))

TUN が使えないなら、**パケットを OS に渡さず、自分で TCP/IP を処理して、アプリケーションには `net.Conn` として見せる** しかない。gVisor の netstack はまさにそれを提供する。

副次的な利点もある。**カーネルを通らないので、ホストのネットワーク設定を一切変えない。** ルーティングテーブルも DNS も触らないので、権限も要らず、後始末も要らない。

### なぜ gVisor なのか

Go でフル機能の TCP/IP スタックを実装するのは大仕事だ。輻輳制御、再送、ウィンドウ管理、IPv6 の近隣探索、ICMP。

gVisor の netstack は、**Google が本番のコンテナサンドボックスで使っている実装** で、Go で書かれ、API がライブラリとして使える形になっている。

代償として、**上流の性能問題やバグに付き合うことになる**。RACK の性能、cubic のオーバーフロー。それでも自前で書くよりは安い、という判断だ。

そして **その対処がコードに残っている** ことが重要だ。「なぜ RACK を無効にしているのか」が分からないと、後から「有効にすれば速くなるのでは」と戻される。

### なぜ既定値と同じ値を明示的に設定するのか

reno の設定は、書いた時点では gVisor の既定と同じだった。冗長に見える。

だが **上流が既定を cubic に変えたら、こちらは黙って壊れる**。オーバーフローのバグを踏むようになる。

**「依存先の既定値に依存する」のは、暗黙の結合だ。** 明示的に設定すれば、上流が何を既定にしようと影響を受けない。そしてコメントに「今のところ既定と同じだが、予期しない変更を防ぐため」と書いておけば、冗長だと思って消されない。

### なぜプラットフォームごとに定数を変えるのか

iOS の Network Extension は、メモリ制限が数十 MB と厳しい。超えると **OS がプロセスを殺す**。

一方 Linux の subnet router は、数 GB のメモリを持つサーバで動く。**TCP のバッファを大きくすると、帯域遅延積の大きい経路でスループットが上がる。**

同じ定数を両方に使うと、iOS で死ぬか、Linux で遅いかのどちらかになる。**ビルドタグでファイルを分けると、条件分岐が実行時に残らず、iOS のバイナリには大きな値が存在しない。**

「メモリ制限のある環境」と「潤沢な環境」で同じコードを動かすとき、**どこを可変にするかを定数の切り出しで表現する** のは実用的なやり方だ。

### なぜクライアントごとの上限が全体の 2/3 なのか

全体の上限だけだと、1 台の暴走したクライアントが枠を全部使い、他が接続できなくなる。

クライアントごとの上限を厳しくしすぎると (例: 全体の 1/100)、**1 台しかいない正常なケースで性能が出ない**。

2/3 なら、

- 1 台だけなら、ほぼ全部使える (2/3)
- 2 台が競合しても、両方が 1/3 以上は使える
- 1 台が暴走しても、残り 1/3 は他のために残る

**「公平性の保証」と「単独利用時の性能」を両立させる値** として選ばれている。

## どう活かすか

**特権が要る機能には、特権なしのフォールバック実装を用意すると適用範囲が広がる。** Tailscale はこれで、コンテナ・CI・ライブラリ埋め込みという 3 つの利用形態を得た。フォールバックが本番でも使える品質なら、それは制限ではなく別の製品形態になる。

**依存ライブラリの既定値には依存しない。明示的に設定する。** 既定と同じ値でも書く。上流が変えたときに壊れないためで、**「今は既定と同じだが、変更を防ぐため」とコメントに理由を書く**。書かないと冗長なコードとして削除される。

**上流ライブラリのバグや性能問題への対処には、必ず上流の issue 番号を書く。** 「RACK を無効化」だけでは、いつ再有効化してよいか誰にも分からない。番号があれば、修正されたか確認できる。

**環境ごとに変えたい定数は、ビルドタグでファイルを分ける。** 実行時の分岐が消え、その環境に不要な値がバイナリに入らない。メモリ制限の厳しい環境向けのビルドでは、これが効く。

**リソースの上限は、全体とクライアントごとの 2 段で持つ。** クライアントごとの上限を全体の一定割合 (2/3 程度) にすると、単独利用時の性能を落とさずに、暴走への保護が入る。

**「上流の既定値は、我々の利用パターンを想定していない」ことがある。** TCP keepalive の 2 時間は「接続はめったに切れない」前提だ。ピアの入れ替わりが激しい環境では、その前提が崩れる。**既定値を使う前に、その値が想定している状況を確認する。**

**同じ検査を層をまたいで 2 回しない。** 上位でフィルタしているなら、下位の NIC はアドレス検査を省いてよい。ただし **「なぜ省いてよいか」をコメントに書く** — 上位の検査が消えたときに、ここが穴になることを気づけるようにする。
