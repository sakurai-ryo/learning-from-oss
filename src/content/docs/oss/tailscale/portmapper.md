---
title: "ルータに穴を開ける 3 つのプロトコル"
description: "NAT-PMP・PCP・UPnP を全部試す。前 2 つは同じ UDP ポートに投げ、応答のバージョン番号で振り分ける。UPnP は SSDP のユニキャストとマルチキャストを順番に送る — その順番には「ホストのファイアウォールに応答を期待させる」という理由がある。ルータの実装がおかしいことを前提にしたコードが並ぶ。"
group: "NAT 越え"
sidebar:
  order: 11
---

## 何を学んだか

### ルータに頼んで穴を開けてもらう

[netcheck](../netcheck/) が「自分は外からどう見えるか」を測るのに対し、`portmapper` は **ルータに直接お願いして、外側のポートを内側に転送してもらう**。成功すれば、NAT の内側にいながら固定の外部アドレスを持てる。

そのためのプロトコルが 3 つある。

| プロトコル | ポート                 | 由来                     |
| ---------- | ---------------------- | ------------------------ |
| NAT-PMP    | UDP 5351               | Apple 発、RFC 6886       |
| PCP        | UDP 5351               | NAT-PMP の後継、RFC 6887 |
| UPnP IGD   | UDP 1900 (発見) → HTTP | UPnP フォーラム          |

**NAT-PMP と PCP は同じポートを使う。** だから 1 つの UDP ソケットから両方のリクエストを投げて、返ってきたパケットの先頭バイト (バージョン番号) で振り分ける。

### 全部を並行に試す

どのプロトコルが使えるかは事前に分からない。`Probe` は **3 つ全部のリクエストを同時に投げて、250 ms 待つ**。返ってきたものが使える。

そして一度見つけたサービスは **10 分間覚えておく**。同じゲートウェイに繋がっているあいだは、プローブを再送しない。

### UPnP の探索順序に理由がある

UPnP のデバイス発見 (SSDP) は、本来マルチキャストアドレス `239.255.255.250:1900` に投げるものだ。だが Tailscale は **ゲートウェイのユニキャストアドレスに先に投げ、それからマルチキャストに投げる**。

理由が 30 行のコメントで説明されている。要点は 2 つ。

- **マルチキャストが壊れている LAN や OS がある** ので、ユニキャストでも届くようにする。ただし仕様上ユニキャストに応答する義務はないので、マルチキャストも必要
- **SSDP は「マルチキャスト宛に送って、ユニキャストで返る」という非対称な形** なので、ステートフルなホストファイアウォールが応答を落とすことがある。先にユニキャストで送っておくと、**ファイアウォールに「このルータからの応答を期待している」と教育できる**

### マッピングの有効期限を半分で更新する

ポートマッピングにはリース期間がある (NAT-PMP の推奨は 2 時間)。`portmapper` は **期限の半分の時点で更新する**。

また、NAT-PMP と PCP には **epoch** という値があり、ルータが再起動するとリセットされる。これを見れば「ルータが再起動してマッピングが消えた」ことを検知できる。

## ソースコードのどこか

### 3 つを同時に投げる

```go title="net/portmapper/portmapper.go"
	uc, err := c.listenPacket(context.Background(), "udp4", ":0")
	...
	ctx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	defer closeCloserOnContextDone(ctx, uc)()

	pxpAddr := netip.AddrPortFrom(gw, c.pxpPort())
	upnpAddr := netip.AddrPortFrom(gw, c.upnpPort())
	upnpMulticastAddr := netip.AddrPortFrom(netaddr.IPv4(239, 255, 255, 250), c.upnpPort())

	// Don't send probes to services that we recently learned (for
	// the same gw/myIP) are available. See
	// https://github.com/tailscale/tailscale/issues/1001
	if c.sawPMPRecently() {
		res.PMP = true
	} else if !c.debug.DisablePMP() {
		metricPMPSent.Add(1)
		uc.WriteToUDPAddrPort(pmpReqExternalAddrPacket, pxpAddr)
	}
	if c.sawPCPRecently() {
		res.PCP = true
	} else if !c.debug.DisablePCP() {
		metricPCPSent.Add(1)
		uc.WriteToUDPAddrPort(pcpAnnounceRequest(myIP), pxpAddr)
	}
```

[`portmapper.go#L891-L916`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/portmapper/portmapper.go#L891)。

**`pxpAddr` という変数名が、PMP と PCP を兼ねていることを示している** (`pxp` = P?P)。同じアドレスに 2 つの違うプロトコルのパケットを投げる。

タイムアウトは 250 ms。ルータは LAN 内にいるので、応答があるなら即座に返る。返らないなら、そのプロトコルは喋れないと判断してよい。

### 見つけたものは 10 分覚える

```go title="net/portmapper/portmapper.go"
const portMapServiceTimeout = 250 * time.Millisecond

// trustServiceStillAvailableDuration is how often we re-verify a port
// mapping service is available.
const trustServiceStillAvailableDuration = 10 * time.Minute
```

[`portmapper.go#L104-L108`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/portmapper/portmapper.go#L104-L108)。

```go title="net/portmapper/portmapper.go"
	// The following PMP fields are populated during Probe
	pmpPubIP     netip.Addr // non-zero if known
	pmpPubIPTime time.Time  // time pmpPubIP last verified
	pmpLastEpoch uint32

	// The following PCP fields are populated during Probe
	pcpSawTime   time.Time // time we last saw PCP was available
	pcpLastEpoch uint32

	uPnPSawTime    time.Time           // time we last saw UPnP was available
	uPnPMetas      []uPnPDiscoResponse // UPnP UDP discovery responses
```

[`portmapper.go#L138-L149`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/portmapper/portmapper.go#L138-L149)。

**プロトコルごとに「最後に見た時刻」を持つ。** そして [ネットワークが変わった](../link-change/)ら、これらを全部ゼロクリアする。ゲートウェイが変われば、そこにあったサービスの情報は無意味になる。

### SSDP の送信順序

```go title="net/portmapper/portmapper.go"
		// Strictly speaking, you discover UPnP services by sending an
		// SSDP query (which uPnPPacket is) to udp/1900 on the SSDP
		// multicast address, and then get a flood of responses back
		// from everything on your network.
		//
		// Empirically, many home routers also respond to SSDP queries
		// directed at udp/1900 on their LAN unicast IP
		// (e.g. 192.168.1.1). This is handy because it means we can
		// probe the router directly and likely get a reply. However,
		// the specs do not _require_ UPnP devices to respond to
		// unicast SSDP queries, so some conformant UPnP
		// implementations only respond to multicast queries.
		//
		// In theory, we could send just the multicast query and get
		// all compliant devices to respond. However, we instead send
		// to both a unicast and a multicast addresses, for a couple
		// of reasons:
		//
		// First, some LANs and OSes have broken multicast in one way
		// or another, so it's possible for the multicast query to be
		// lost while the unicast query gets through. But we still
		// have to send the multicast query to also get a response
		// from strict-UPnP devices on multicast-working networks.
		//
		// Second, SSDP's packet dynamics are a bit weird: you send
		// the SSDP query from your unicast IP to the SSDP multicast
		// IP, but responses are from the UPnP devices's _unicast_ IP
		// to your unicast IP. This can confuse some less-intelligent
		// stateful host firewalls, who might block the responses. To
		// work around this, we send the unicast query first, to teach
		// the firewall to expect a unicast response from the router,
		// and then send our multicast query. That way, even if the
		// device doesn't respond to the unicast query, we've set the
		// stage for the host firewall to accept the response to the
		// multicast query.
```

[`portmapper.go#L921-L959`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/portmapper/portmapper.go#L921)。

**このコメントは、実質的にネットワークプロトコルの運用ノウハウの文書だ。**

- 仕様がどうなっているか
- 現実の機器がどう振る舞うか (「経験的に」多くの家庭用ルータはユニキャストにも応答する)
- 仕様に厳密な実装も存在すること (issue 番号付き)
- 環境側の問題 (マルチキャストが壊れた LAN)
- ステートフルファイアウォールを「教育する」というテクニック

最後の項目が一番面白い。**ユニキャストで先にパケットを送るのは、応答が欲しいからではない。ファイアウォールの状態テーブルにエントリを作らせるためだ。**

### マッピングは interface

```go title="net/portmapper/portmapper.go"
// mapping represents a created port-mapping over some protocol.  It specifies a lease duration,
// how to release the mapping, and whether the map is still valid.
//
// After a mapping is created, it should be immutable, and thus reads should be safe across
// concurrent goroutines.
type mapping interface {
	// Release will attempt to unmap the established port mapping. It will block until completion,
	// but can be called asynchronously. Release should be idempotent, and thus even if called
	...
```

[`portmapper.go#L164-L172`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/portmapper/portmapper.go#L164)。

**3 つのプロトコルの違いが、この interface の下に隠れる。** 上位からは「外部アドレスが取れて、期限があり、解放できるもの」に見える。

### リースの更新

```go title="net/portmapper/portmapper.go"
					d := time.Duration(pres.MappingValidSeconds) * time.Second
					now := time.Now()
					m.goodUntil = now.Add(d)
					m.renewAfter = now.Add(d / 2) // renew in half the time
					m.epoch = pres.SecondsSinceEpoch
```

[`portmapper.go#L751-L755`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/portmapper/portmapper.go#L751)。

**`goodUntil` と `renewAfter` を別に持つ。** 期限の半分で更新を試み、失敗しても期限までは使い続ける。DHCP のリース更新と同じ形だ。

`epoch` (`SecondsSinceEpoch`) は NAT-PMP の仕様にあるフィールドで、**ルータが起動してからの秒数**だ。この値が巻き戻っていたら、ルータが再起動してマッピングが消えたと分かる。ポーリングせずに、次の応答で気づける。

### 外部ライブラリを使いつつ、グローバル状態を避ける

```go title="net/portmapper/upnp.go"
// upnpHTTPClientKey is a context key for storing an HTTP client to use
// for UPnP requests. This allows us to use a custom HTTP client (with custom
// dialer, timeouts, etc.) while using the upstream goupnp library which only
// supports a global HTTPClientDefault.
var upnpHTTPClientKey = ctxkey.New[*http.Client]("portmapper.upnpHTTPClient", nil)

// delegatingRoundTripper implements http.RoundTripper by delegating to
// the HTTP client stored in the request's context. This allows us to use
// per-request HTTP client configuration with the upstream goupnp library.
type delegatingRoundTripper struct {
	inner *http.Client
}

func (d delegatingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if c := upnpHTTPClientKey.Value(req.Context()); c != nil {
		return c.Transport.RoundTrip(req)
	}
	return d.inner.Do(req)
}
```

[`upnp.go#L37-L56`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/portmapper/upnp.go#L37-L56)。

UPnP の実装には `goupnp` という外部ライブラリを使っている。だがこのライブラリは **HTTP クライアントをグローバル変数で持つ**。Tailscale は [ネットワーク名前空間の都合](../netns-loop/)で、リクエストごとに違うダイヤラを使う必要がある。

そこで **グローバルには「コンテキストから HTTP クライアントを取り出す RoundTripper」を 1 個だけ設定し、実際のクライアントはリクエストのコンテキストで運ぶ**。ライブラリをフォークせずに、グローバル状態を実質的にリクエストスコープへ変換している。

## なぜそうなっているか

### なぜ 3 つ全部を試すのか

家庭用ルータの実装状況はばらばらだ。

- Apple の機器と、それに影響を受けた機器は NAT-PMP
- 比較的新しいルータや ISP 提供機器は PCP
- Windows との相互運用のために UPnP IGD を積むものが多い

しかも **どれが有効かは設定次第** で、「UPnP は有効だが NAT-PMP は無効」といった組み合わせが普通にある。事前に判別する方法はないので、全部投げて返ってきたものを使う。

コストは UDP パケット数個で、250 ms 待つだけだ。**判別のロジックを賢くするより、全部試すほうが安い。**

### なぜ 10 分キャッシュするのか

issue #1001 が参照されている。プローブは 3 つのプロトコルにパケットを投げ、UPnP に至っては LAN 全体にマルチキャストを撒く。これを短い間隔で繰り返すと、**LAN が Tailscale の探索パケットで賑やかになる**。

ルータの構成が 10 分で変わることは稀なので、覚えておけばよい。そして本当に変わったとき (別の Wi-Fi に繋いだ、ルータを交換した) は、[ネットワーク変化の検出](../link-change/)が状態をクリアする。**時間ベースのキャッシュと、イベントベースの無効化を組み合わせる。**

### なぜファイアウォールを「教育」するのか

これは NAT とステートフルファイアウォールの本質的な性質を利用している。

ステートフルファイアウォールは「内から外に出たパケット」を記録し、その応答だけを通す。SSDP のマルチキャストクエリでは、**送信先が `239.255.255.250` なのに応答が `192.168.1.1` から来る**。素朴な実装では「そんなアドレスに送った覚えはない」と落とす。

先に `192.168.1.1` へユニキャストで送っておけば、そのアドレスからの応答を通す状態が作られる。**目的はユニキャストの応答を得ることではなく、状態を作ること。**

これは NAT 越えの世界では一般的な手法だ。[disco の CallMeMaybe](../disco-protocol/) も同じ発想で、「相手からのパケットを通すために、先に自分から送る」。

### なぜ mapping を interface にするのか

3 つのプロトコルは、有効期限の扱いも、解放の方法も、外部アドレスの取得方法も違う。

だが上位 ([magicsock](../magicsock/)) が知りたいのは「外部アドレスは何か」「いつまで有効か」だけだ。**プロトコルの差異を interface の下に閉じ込めれば、上位は 3 通りの分岐を持たなくて済む。**

そして「作った後は不変」という規約を interface のドキュメントに書くことで、**マッピングを複数の goroutine から読んでよい** ことが保証される。更新は「新しい mapping で置き換える」形になる。

## どう活かすか

**判別できない環境では、全部試して返ってきたものを使う。** 事前に環境を推定するロジックは、必ず推定を外す。試行のコストが小さいなら (パケット数個、数百 ms)、並行に投げて最初に成功したものを採用するほうが単純で確実になる。

**発見したケイパビリティは、時間ベースのキャッシュとイベントベースの無効化を両方持つ。** 時間だけだと、環境が変わったのに古い情報を使い続ける。イベントだけだと、検知漏れがあったときに永久に間違ったままになる。両方あれば、どちらかが効く。

**リースは期限の半分で更新し、期限そのものは別に持つ。** 更新に失敗しても期限までは使える。DHCP、OAuth のトークン、分散ロック、証明書 — リースの形をしたものすべてに使える。

**外部ライブラリのグローバル状態は、コンテキスト経由の間接参照で無害化できる。** グローバルには「コンテキストから実体を取る」薄い実装を 1 個置き、実体はリクエストごとに運ぶ。ライブラリをフォークせずに済み、上流の更新も追える。

**プロトコルの仕様と現実の乖離は、コードではなくコメントに書く。** 「仕様ではこう、実際の機器はこう、だからこうする」の 3 点セット。コードだけを見ても「なぜ 2 回送るのか」は絶対に分からない。この手のコメントは長くなるが、**長さに見合う情報量がある。**

**「相手からのパケットを受けるために、先に自分から送る」はステートフルな中間装置がある世界の基本技法だ。** NAT、ファイアウォール、ロードバランサ。応答を待つ前に、応答が通る道を作っておく。
