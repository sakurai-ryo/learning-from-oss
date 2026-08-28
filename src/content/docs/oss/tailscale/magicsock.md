---
title: "WireGuard の下に潜り込む Conn 実装"
description: "wireguard-go の conn.Bind インターフェースを実装するだけで、UDP の送受信を全部乗っ取れる。1 つのソケットに WireGuard・disco・STUN・Geneve が流れてくるので、先頭バイトで振り分ける。知らない送信元からのハンドシェイクには「遅延エンドポイント」を返し、ピアを後から作らせる。"
group: "データパス"
sidebar:
  order: 20
---

## 何を学んだか

### 差し込み口は 1 つのインターフェース

パッケージのドキュメントは 1 文だ。

> **通信経路を使用中に変更できるソケット。最良の通信方法を能動的に探し続ける。**

wireguard-go は UDP の送受信を `conn.Bind` というインターフェースに委ねている。

```go
type Bind interface {
	Open(port uint16) ([]ReceiveFunc, uint16, error)
	Send(bufs [][]byte, ep Endpoint, offset int) error
	BatchSize() int
	...
}
```

**このインターフェースを実装するだけで、WireGuard のパケットがどこを通るかを完全に制御できる。** magicsock はそれをやっている。ファイルサイズ 162 KB は、この 1 つのインターフェースの裏側だ。

### 1 つのソケットに 4 種類のパケットが来る

magicsock が開く UDP ソケットには、次のものが混ざって届く。

| 種類                                            | 見分け方                                 |
| ----------------------------------------------- | ---------------------------------------- |
| WireGuard                                       | 上記のいずれでもない                     |
| [disco](../disco-protocol/)                     | 先頭 6 バイトが `TS💬`                   |
| STUN の応答                                     | STUN のマジッククッキー + method binding |
| [Geneve](../peer-relay/) でカプセル化されたもの | 予約ビットが 0 で、Protocol Type が既知  |

`packetLooksLike` が先頭バイトを見て振り分ける。

### 知らない送信元には「遅延エンドポイント」を返す

[ピアは遅延生成される](../netmap-apply/)ので、パケットが来た時点では wireguard-go にそのピアが存在しないことがある。

そこで magicsock は **`lazyEndpoint` という「まだ誰か分からないエンドポイント」** を返す。wireguard-go はハンドシェイクを復号して公開鍵を知り、そこからピアを作る。

### IPv4 と IPv6 で別のソケット

`pconn4` と `pconn6` が別々にある。片方だけ成功することもあるので、**それぞれ独立に扱う**。

## ソースコードのどこか

### wireguard-go への差し込み

```go title="wgengine/magicsock/magicsock.go"
// Package magicsock implements a socket that can change its communication path while
// in use, actively searching for the best way to communicate.
package magicsock
```

```go title="wgengine/magicsock/magicsock.go"
type connBind struct {
	*Conn
	mu     sync.Mutex
	closed bool
}

// This is a compile-time assertion that connBind implements the wireguard-go
// conn.Bind interface.
var _ conn.Bind = (*connBind)(nil)
```

[`magicsock.go#L4-L6`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L4-L6) と [`magicsock.go#L3468-L3476`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L3468-L3476)。

**`connBind` は `*Conn` を埋め込んだ薄い型だ。** `conn.Bind` として必要なメソッドだけを追加し、実体は `Conn` が持つ。`Open`/`Close` のライフサイクルが wireguard-go 側と `Conn` 側で別々なので、その差だけを吸収している。

```go title="wgengine/magicsock/magicsock.go"
// Open is called by WireGuard to create a UDP binding.
// The ignoredPort comes from wireguard-go, via the wgcfg config.
// We ignore that port value here, since we have the local port available easily.
func (c *connBind) Open(ignoredPort uint16) ([]conn.ReceiveFunc, uint16, error) {
```

[`magicsock.go#L3492-L3497`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L3492-L3497)。

**wireguard-go が指定してくるポート番号を無視する。** ソケットは magicsock が既に開いているからだ。**インターフェースの引数を意図的に無視する場合、その理由を書いておかないと後で誰かが「バグでは」と思う。**

### 送信

```go title="wgengine/magicsock/magicsock.go"
// Send implements conn.Bind.
func (c *Conn) Send(buffs [][]byte, ep conn.Endpoint, offset int) (err error) {
	n := int64(len(buffs))
	defer func() {
		if err != nil {
			c.metrics.outboundPacketsDroppedErrors.Add(n)
		}
	}()
	metricSendData.Add(n)
	if c.networkDown() {
		metricSendDataNetworkDown.Add(n)
		return errNetworkDown
	}
	switch ep := ep.(type) {
	case *endpoint:
		return ep.send(buffs, offset)
	case *lazyEndpoint:
		// A [*lazyEndpoint] may end up on this TX codepath when wireguard-go is
		// deemed "under handshake load" and ends up transmitting a cookie reply
		// using the received [conn.Endpoint] in [device.SendHandshakeCookie].
		if ep.src.ap.Addr().Is6() {
			return c.pconn6.WriteWireGuardBatchTo(buffs, ep.src, offset)
		}
		return c.pconn4.WriteWireGuardBatchTo(buffs, ep.src, offset)
	}
	return nil
}
```

[`magicsock.go#L1495-L1522`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L1495)。

**送信の本体は `ep.send()` の 1 行で、あとはメトリクスと分岐だ。** [経路の選択は endpoint が持つ](../endpoint-selection/)ので、ここでは型を見分けるだけでよい。

`lazyEndpoint` のケースにコメントがある。**wireguard-go が「ハンドシェイク負荷が高い」と判断したとき、cookie reply を返す** ためにこの経路を通る。DoS 対策の機構が、こちらの型に影響している。

### 受信の振り分け

```go title="wgengine/magicsock/magicsock.go"
func packetLooksLike(msg []byte) (t packetLooksLikeType, isGeneveEncap bool) {
	if stun.Is(msg) &&
		msg[1] == 0x01 { // method binding
		return packetLooksLikeSTUNBinding, false
	}

	looksLikeDisco := func(msg []byte) bool {
		if len(msg) >= discoHeaderLen && string(msg[:len(disco.Magic)]) == disco.Magic {
			return true
		}
		return false
	}

	// Do we have a Geneve header?
	if len(msg) >= packet.GeneveFixedHeaderLength &&
		msg[0]&0xC0 == 0 && // version bits that we always transmit as 0s
		msg[1]&0x3F == 0 && // reserved bits that we always transmit as 0s
		msg[7] == 0 { // reserved byte that we always transmit as 0
		switch binary.BigEndian.Uint16(msg[2:4]) {
		case packet.GeneveProtocolDisco:
			if looksLikeDisco(msg[packet.GeneveFixedHeaderLength:]) {
				return packetLooksLikeDisco, true
			} else {
				// The Geneve header is well-formed, and it indicated this
				// was disco, but it's not. The evaluated bytes at this point
				// are always distinct from naked WireGuard (msg[2:4] are always
				// 0x0000) and naked Disco (msg[2:4] are always 0xf09f), but
				// maintain pre-Geneve behavior and fall back to assuming it's
				// naked WireGuard.
				return packetLooksLikeWireGuard, false
			}
```

[`magicsock.go#L2125-L2166`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L2125)。

**判定の順序と、誤判定の可能性が全部コメントされている。**

Geneve ヘッダの判定は「自分が常に 0 で送るビットが 0 か」で行う。これは **完全な判定ではない** — 偶然一致する WireGuard パケットがありうる。

だから内側でもう 1 回検査する。「Geneve として整合しているが、中身が disco に見えない」場合は、**Geneve ではなく素の WireGuard だったと解釈し直す**。

そのときのコメントが精密だ。**「ここまで評価したバイトは、素の WireGuard (msg[2:4] は常に 0x0000) とも素の disco (msg[2:4] は常に 0xf09f) とも必ず異なる」** — つまり誤判定しても実害がないことを、バイト値のレベルで論証している。

### 受信の処理

```go title="wgengine/magicsock/magicsock.go"
	switch pt {
	case packetLooksLikeDisco:
		if isGeneveEncap {
			b = b[packet.GeneveFixedHeaderLength:]
		}
		shouldByRelayHandshakeMsg := geneve.Control == true
		c.handleDiscoMessage(b, src, shouldByRelayHandshakeMsg, key.NodePublic{}, discoRXPathUDP)
		return nil, 0, false, false
	case packetLooksLikeSTUNBinding:
		c.netChecker.ReceiveSTUNPacket(b, ipp)
		return nil, 0, false, false
	default:
		// Fall through for all other packet types as they are assumed to
		// be potentially WireGuard.
	}
```

[`magicsock.go#L1849-L1866`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L1849)。

**disco と STUN は「wireguard-go に報告しない」(`ok = false`)。** magicsock の中で消費される。WireGuard から見ると、これらのパケットは存在しない。

`default` に「その他はすべて WireGuard の**可能性がある**とみなす」とある。**確信は要らない。** 本当に WireGuard でなければ、wireguard-go が復号に失敗して捨てる。判定を安く済ませて、最終判断は下流に委ねている。

### Geneve ヘッダを剥がす

```go title="wgengine/magicsock/magicsock.go"
	if src.vni.IsSet() {
		// Strip away the Geneve header before returning the packet to
		// wireguard-go.
		//
		// TODO(jwhited): update [github.com/tailscale/wireguard-go/conn.ReceiveFunc]
		//  to support returning start offset in order to get rid of this memmove perf
		//  penalty.
		size = copy(b, b[packet.GeneveFixedHeaderLength:])
		b = b[:size]
	}
```

[`magicsock.go#L1878-L1888`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L1878)。

**8 バイトのヘッダを剥がすために、パケット全体を前へずらしている。** `conn.ReceiveFunc` が「開始オフセット」を返せないからだ。

TODO には解決策も書かれている — **wireguard-go 側のインターフェースを変える**。Tailscale は wireguard-go をフォークしているので、これは実際に可能な選択肢だ。**「上流を変えれば消せる非効率」であることが記録されている。**

### 直前のピアをキャッシュ

```go title="wgengine/magicsock/magicsock.go"
	if cache.epAddr == src && cache.de != nil && cache.gen == cache.de.numStopAndReset() {
		ep = cache.de
	} else {
		c.mu.Lock()
		de, ok := c.peerMap.endpointForEpAddr(src)
		c.mu.Unlock()
		if !ok {
			return &lazyEndpoint{c: c, src: src}, size, isGeneveEncap, true
		}
```

[`magicsock.go#L1890-L1900`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L1890)。

**1 エントリのキャッシュ。** 同じ送信元からのパケットが連続することが多いので、これだけでロックの取得がほとんど消える。

キャッシュの妥当性は `numStopAndReset()` という世代番号で検査する。**エンドポイントがリセットされたら世代が上がり、キャッシュが無効になる。** ポインタが同じでも中身が変わっているケースを捕まえられる。

### 遅延エンドポイント

```go title="wgengine/magicsock/magicsock.go"
type lazyEndpoint struct {
	c       *Conn
	maybeEP *endpoint // or nil if unknown
	src     epAddr
}

var _ conn.InitiationAwareEndpoint = (*lazyEndpoint)(nil)
var _ conn.PeerAwareEndpoint = (*lazyEndpoint)(nil)
var _ conn.Endpoint = (*lazyEndpoint)(nil)

// InitiationMessagePublicKey implements [conn.InitiationAwareEndpoint].
// wireguard-go calls us here if we passed it a [*lazyEndpoint] for an
// initiation message, for which it might not have the relevant peer configured.
// Wireguard-go's PeerLookupFunc handles on-demand peer creation.
func (le *lazyEndpoint) InitiationMessagePublicKey(peerPublicKey [32]byte) {
```

[`magicsock.go#L4406-L4422`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L4406)。

**3 つのインターフェースを実装している。** うち 2 つ (`InitiationAwareEndpoint`、`PeerAwareEndpoint`) は Tailscale が wireguard-go のフォークに足したものだ。

流れはこうなる。

1. 知らない送信元からパケットが来る → `lazyEndpoint` を返す
2. wireguard-go がハンドシェイクを復号し、送信者の公開鍵を知る
3. wireguard-go が `InitiationMessagePublicKey(pubkey)` でこちらに教える
4. magicsock はその鍵から本物の `endpoint` を見つけ、状態を更新する

**「誰か分からないまま処理を進め、分かった時点で教えてもらう」。** 復号しないと送信者が分からないので、この順序でしかできない。

### IPv4 と IPv6 は別のソケット

```go title="wgengine/magicsock/magicsock.go"
	// pconn4 and pconn6 are the underlying UDP sockets used to
	// send/receive packets for wireguard and other magicsock
	// protocols.
	pconn4 RebindingUDPConn
	pconn6 RebindingUDPConn
```

[`magicsock.go#L190-L194`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L190-L194)。

デュアルスタックのソケット 1 個で両方扱う方法もあるが、**別々にしている**。IPv6 が使えない環境で v6 のソケットだけ失敗したとき、v4 は動き続ける。[PMTUD の設定](../peer-mtu/) も片方ずつ行う。

### 構造体にセクションの区切りがある

```go title="wgengine/magicsock/magicsock.go"
type Conn struct {
	// This block mirrors the contents and field order of the Options
	// struct. Initialized once at construction, then constant.
	...
	// ================================================================
	// No locking required to access these fields, either because
	// they're static after construction, or are wholly owned by a
	// single goroutine.
```

[`magicsock.go#L159-L181`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L159-L181)。

**フィールドが「同期の要件」でグループ分けされている。** 構築時に決まって不変なもの、1 つの goroutine が所有するもの、ミューテックスで守るもの。

162 KB のファイルで、どのフィールドにどうアクセスしてよいかを追うのは難しい。**区切り線とコメントが、実質的な型注釈として働いている。**

## なぜそうなっているか

### なぜ conn.Bind で足りるのか

WireGuard の仕事は「パケットを暗号化して、指定された宛先に送る」ことだ。**「宛先をどう決めるか」は WireGuard の関心事ではない**。

だから `conn.Bind` に「エンドポイント」という抽象があり、その実体は実装側が自由に定義できる。magicsock はここに「候補アドレスの集合と、選択のロジック」を詰め込んだ。

**WireGuard 側のコードを 1 行も変えずに、経路の動的な変更が実現できる。** インターフェースの切り方が良いと、こういう拡張ができる。

(実際には Tailscale は wireguard-go をフォークして `InitiationAwareEndpoint` などを足しているが、**中心的な差し込みは `conn.Bind` だけで足りている**。)

### なぜ 1 つのソケットに全部流すのか

[disco のページ](../disco-protocol/) で見たとおり、**経路の測定に使うソケットと、データが流れるソケットは同一でなければ意味がない**。NAT のマッピングはソケット (5-tuple) 単位で作られるからだ。

STUN も同じ理由で同じソケットを使う。別のソケットで STUN を打つと、**そのソケットのマッピングしか分からない**。

代償として、受信のたびに種別判定が要る。だが判定は先頭数バイトの比較なので安い。

### なぜ「たぶん WireGuard」で下流に渡すのか

判定を厳密にしようとすると、WireGuard のヘッダ形式を magicsock が知る必要が出る。**プロトコルの知識が 2 箇所に散る**。

「disco でも STUN でもないなら WireGuard として渡す」なら、magicsock は WireGuard の中身を知らなくて済む。間違っていても wireguard-go が捨てるだけだ。

**曖昧な判定でよい場面と、厳密でなければならない場面を区別する。** ここは前者で、[disco の送信者検証](../disco-protocol/) は後者になる。

### なぜ 1 エントリのキャッシュで足りるのか

UDP のパケットは、同じピアから連続して届くことが多い。ファイル転送中なら、ほぼすべてのパケットが同じ送信元だ。

**LRU やハッシュマップのキャッシュを作るより、直前の 1 件を覚えるほうが速い。** 比較 1 回で当たり、外れてもコストは通常のマップ参照だけ。

キャッシュの世代検査 (`numStopAndReset`) を入れているのが実装のポイントだ。**ポインタの同一性だけでは、指す先の状態が変わったことを検知できない。**

### なぜ遅延エンドポイントが必要か

WireGuard のハンドシェイク開始メッセージは、**復号しないと送信者が分からない**。送信元の IP アドレスは詐称できるので、それだけでピアを特定してはいけない。

一方 `conn.Bind` の `ReceiveFunc` は、**パケットを渡すときにエンドポイントも渡す** 契約になっている。まだ誰か分からないのに、エンドポイントを返さなければならない。

`lazyEndpoint` は「まだ分からない」を表す値だ。そして wireguard-go が復号した後にコールバックで教えてもらう。**インターフェースの契約と、暗号の制約の間を埋めるための型** になっている。

これは [ピアの遅延生成](../netmap-apply/) と組み合わさって効く。ピアが存在しない状態でパケットが来ても、復号してから作れる。

### なぜフィールドを同期要件でグループ分けするのか

Go には「このフィールドはこのミューテックスで守られる」を表現する型がない。大きな構造体では、**どのフィールドにロックなしでアクセスしてよいかが分からなくなる**。

区切り線とコメントは、コンパイラには見えないが、**レビューと読解には効く**。「この線より下はミューテックスが要る」と書いてあれば、新しいフィールドを足す人がどこに置くべきか分かる。

`Conn` 構造体は 200 行以上ある。**構造体が大きくなること自体は避けられないので、読める形に整理する** という選択になっている。

## どう活かすか

**ライブラリを拡張したいなら、まず「どのインターフェースを実装すれば足りるか」を探す。** wireguard-go の `conn.Bind` は、UDP の入出力という 1 点だけを抽象化している。この 1 点を握れば、経路制御という大きな機能を外から足せる。ライブラリを選ぶとき、**「差し込み口の位置と粒度」は機能一覧より重要なことがある。**

**同じソケット・同じ接続に複数のプロトコルを多重化するなら、判定は先頭バイトで安く行い、曖昧さは下流に委ねる。** 厳密な判定はプロトコルの知識を持ち込む。「どちらでもなければ既定のものとして扱う」で足りることが多い。

**判定が曖昧になりうる箇所には、誤判定しても安全な理由を書く。** Geneve の判定コメントは、バイト値のレベルで「誤判定しても素の WireGuard と区別がつく」ことを論証している。この論証がないと、後から誰かが判定を「改善」して壊す。

**連続性のあるアクセスには、1 エントリのキャッシュが効く。** LRU を作る前に、直前の 1 件で当たるかを考える。当たれば比較 1 回、外れても通常経路のコストだけ。**キャッシュの妥当性は、ポインタではなく世代番号で検査する。**

**「まだ分からない」を表す型を用意すると、契約と現実の齟齬を埋められる。** インターフェースが「今すぐ識別子を返せ」と言っていて、実際には復号しないと分からない。そこに「未確定」の値を返し、後からコールバックで確定させる。

**大きな構造体は、フィールドを同期要件でグループ分けし、区切りをコメントで書く。** 型で表現できないなら、せめて読める形にする。構造体が大きいこと自体を悪とせず、大きいまま整理する道もある。

**上流ライブラリの制約による非効率は、TODO に「上流をどう変えれば消せるか」まで書く。** Geneve ヘッダの memmove は、`ReceiveFunc` がオフセットを返せれば消える。フォークを持っているなら、いつか実行できる計画になる。
