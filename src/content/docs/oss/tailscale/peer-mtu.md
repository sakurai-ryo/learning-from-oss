---
title: "ピアごとに MTU を探る"
description: "トンネルの MTU は経路ごとに違う。Tailscale は disco の Ping にパディングを詰めて 6 種類のサイズで撃ち、返ってきた最大サイズをその経路の MTU にする。既定値は 1280 — IPv6 が保証する最小値だ。5 種類の MTU を型と名前で区別し、その定義をパッケージ冒頭に 60 行かけて書いている。"
group: "NAT 越え"
sidebar:
  order: 18
---

## 何を学んだか

### MTU という言葉が指すものが 5 つある

`net/tstun/mtu.go` は、**60 行のコメントで用語を定義することから始まる**。

| 名前               | 意味                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| Wire MTU           | Tailscale の下にある実際のインターフェースの MTU (例: Ethernet の 1500) |
| TUN MTU            | Tailscale の TUN デバイスの MTU。WireGuard のヘッダぶん小さい           |
| Safe MTU           | 経路情報がないときに使う既定値 = **1280**                               |
| Peer MTU           | 特定のピアへの最良経路の MTU                                            |
| Maximum probed MTU | プローブする最大サイズ                                                  |

そして `TUNMTU` と `WireMTU` は **別の型** として定義され、変換関数を通さないと混ざらない。

### WireGuard のヘッダは 80 バイト

```text
IPv6 ヘッダ    40
UDP ヘッダ      8
type            4
key index       4
nonce           8
認証タグ       16
--------------
合計           80
```

だから Wire MTU が 1500 なら、TUN MTU は 1420 になる。

### 6 種類のサイズで ping する

経路探索が始まるたびに、**サイズの違う ping を 6 発撃つ**。

| サイズ | 理由                                          |
| ------ | --------------------------------------------- |
| 1280   | 「Tailscale over Tailscale」                  |
| 1360   | IPv6 が許す最小 MTU (1280) + WireGuard ヘッダ |
| 1400   | よくある MTU からトンネルぶんを引いた値       |
| 1500   | 最もよくある MTU                              |
| 8000   | すべてのジャンボフレームに収まるはず          |
| 9000   | ほとんどのジャンボフレームはこれ以上          |

返ってきた最大のサイズが、その経路の MTU になる。

### 既定は無効

**この機能は既定で無効だ。** コードのコメントが理由を書いている — 「PMTUD が堅牢だと確信できるまでは」。有効化は control server のノブか環境変数から行う。

## ソースコードのどこか

### 用語の定義

```go title="net/tstun/mtu.go"
// The MTU (Maximum Transmission Unit) of a network interface is the largest
// packet that can be sent or received through that interface, including all
// headers above the link layer (e.g. IP headers, UDP headers, Wireguard
// headers, etc.). We have to think about several different values of MTU:
//
// Wire MTU: The MTU of an interface underneath the tailscale TUN, e.g. an
// Ethernet network card will default to a 1500 byte MTU. The user may change
// this MTU at any time.
//
// TUN MTU: The current MTU of the tailscale TUN. This MTU is adjusted downward
// to make room for the wireguard/tailscale headers. For example, if the
// underlying network interface's MTU is 1500 bytes, the maximum size of a
// packet entering the tailscale TUN is 1420 bytes.
...
// Safe MTU: If the tailscale TUN MTU is set to this value, almost all packets
// will get to their destination. Tailscale defaults to this MTU in the absence
// of path MTU probe information or user MTU configuration. We may occasionally
// find a path that needs a smaller MTU but it is very rare.
//
// Peer MTU: This is the path MTU to a peer's current best endpoint. It defaults
// to the Safe MTU unless we have path MTU probe results that tell us otherwise.
```

[`mtu.go#L10-L60`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/mtu.go#L10-L60)。

**「MTU」という 1 つの言葉が、文脈によって 5 つの違うものを指す。** 混同するとバグになるので、まず言葉を定義している。

さらに「初期 MTU」と「現在の MTU」がそれぞれ優先順位つきで定義される。

> **Initial MTU** — 優先順に: 1. `TS_DEBUG_MTU` の値 (65536 でクランプ) 2. `TS_DEBUG_ENABLE_PMTUD` が設定されていれば、プローブする最大 MTU から wg のオーバーヘッドを引いた値 3. そうでなければ Safe MTU

**「どの値がどの順で使われるか」が、コードを読む前に分かる。**

### 型で混同を防ぐ

```go title="net/tstun/mtu.go"
// TUNMTU is the MTU for the tailscale TUN.
type TUNMTU uint32

// WireMTU is the MTU for the underlying network devices.
type WireMTU uint32
```

```go title="net/tstun/mtu.go"
// TUNToWireMTU takes the MTU that the Tailscale TUN presents to the user and
// returns the on-the-wire MTU necessary to transmit the largest packet that
// ...
func TUNToWireMTU(t TUNMTU) WireMTU {
	return WireMTU(t + wgHeaderLen)
}
```

[`mtu.go#L62-L123`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/mtu.go#L62-L123)。

**どちらも `uint32` だが、別の型にしてある。** `TUNMTU` を `WireMTU` が要る場所に渡すとコンパイルエラーになる。変換は `TUNToWireMTU` を通るしかなく、そこで 80 バイトが足される。

[鍵の型](../keys/) で `==` をコンパイルエラーにしたのと同じ発想だ。**間違えると静かに 80 バイトずれるものを、型で守っている。**

### ヘッダ長の内訳

```go title="net/tstun/mtu.go"
// wgHeaderLen is the length of all the headers Wireguard adds to a packet
// in the worst case (IPv6). This constant is for use when we can't or
// shouldn't use information about the IP version of a specific packet
//
// A Wireguard header includes:
//
// - 20-byte IPv4 header or 40-byte IPv6 header
// - 8-byte UDP header
// - 4-byte type
// - 4-byte key index
// - 8-byte nonce
// - 16-byte authentication tag
const wgHeaderLen = 40 + 8 + 4 + 4 + 8 + 16
```

[`mtu.go#L94-L107`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/mtu.go#L94-L107)。

**足し算をそのまま定数式として書いている。** `80` と書いてコメントで説明するのではなく、`40 + 8 + 4 + 4 + 8 + 16` と書く。内訳とコメントの箇条書きが 1 対 1 に対応する。

**「最悪ケース (IPv6)」を採用する理由も書かれている** — パケットごとの IP バージョンを使えない、または使うべきでない場面のため。IPv4 なら 20 バイト少なくて済むが、TUN の MTU は 1 個しか設定できない。

### プローブするサイズ

```go title="net/tstun/mtu.go"
// WireMTUsToProbe is a list of the on-the-wire MTUs we want to probe. Each time
// magicsock discovery begins, it will send a set of pings, one of each size
// listed below.
var WireMTUsToProbe = []WireMTU{
	WireMTU(safeTUNMTU),      // Tailscale over Tailscale :)
	TUNToWireMTU(safeTUNMTU), // Smallest MTU allowed for IPv6, current default
	1400,                     // Most common MTU minus a few bytes for tunnels
	1500,                     // Most common MTU
	8000,                     // Should fit inside all jumbo frame sizes
	9000,                     // Most jumbo frames are this size or larger
}
```

[`mtu.go#L82-L92`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/mtu.go#L82-L92)。

**二分探索ではなく、現実によくある値を列挙する。**

最初の 2 つが面白い。1 つ目は `safeTUNMTU` (1280) をそのまま wire MTU として使う場合で、コメントは **「Tailscale over Tailscale :)」**。Tailscale の中でさらに Tailscale を動かす構成が現実にあるということだ。

2 つ目は 1280 + 80 = 1360 で、「IPv6 が許す最小 MTU」。**IPv6 は 1280 バイトのパケットが通ることを規格で保証している** ので、これが下限になる。

8000 と 9000 はジャンボフレーム用。データセンター内なら 9000 バイトの MTU が使える。

### 安全な既定値

```go title="net/tstun/mtu.go"
	// safeTUNMTU is the default "safe" MTU for the Tailscale TUN that we
	// use in the absence of other information such as path MTU probes.
	safeTUNMTU TUNMTU = 1280
```

[`mtu.go#L77-L79`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/mtu.go#L77-L79)。

**1280 は IPv6 の最小 MTU。** どんな IPv6 経路でも 1280 バイトは通ることが RFC 8200 で保証されている。「経路の情報がないなら、規格が保証する値を使う」。

代償は効率だ。1500 の経路でも 1280 しか使わないので、**14% ほどのオーバーヘッド**になる。だから PMTUD で実際の値を測りたい。

### Don't Fragment ビットを立てる

```go title="wgengine/magicsock/peermtu_linux.go"
func (c *Conn) setDontFragment(network string, enable bool) error {
	optArg := syscall.IP_PMTUDISC_DO
	if enable == false {
		optArg = syscall.IP_PMTUDISC_DONT
	}
	var err error
	rcErr := c.connControl(network, func(fd uintptr) {
		err = syscall.SetsockoptInt(int(fd), getIPProto(network), getDontFragOpt(network), optArg)
	})
```

[`peermtu_linux.go#L19-L32`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/peermtu_linux.go#L19-L32)。

**PMTUD の本質は「フラグメントを禁止して、大きすぎたら送信エラーにする」ことだ。** DF ビットが立っていれば、経路の途中で MTU を超えたパケットはドロップされ、ICMP が返る (または、ローカルなら `EMSGSIZE` が返る)。

DF が立っていないと、経路上のルータが勝手に分割してくれるので、**大きな ping が「通った」ように見えてしまう**。それでは測定にならない。

実装は OS ごとに分かれている (`peermtu_linux.go`、`peermtu_darwin.go`、`peermtu_unix.go`、`peermtu_stubs.go`)。Linux では `IP_MTU_DISCOVER` に `IP_PMTUDISC_DO`。

### 部分的な成功をどう扱うか

```go title="wgengine/magicsock/peermtu.go"
// Enabling or disabling peer path MTU discovery requires setting the don't
// fragment bit on its two underlying pconns. There are three distinct results
// for this operation on each pconn:
//
// 1. Success
// 2. Failure (not supported on this platform, or supported but failed)
// 3. Not a UDP socket (most likely one of IPv4 or IPv6 couldn't be used)
//
// To simplify the fast path for the most common case, we set the PMTUD status
// of the overall Conn according to the results of setting the sockopt on pconn
// as follows:
//
// 1. Both setsockopts succeed: PMTUD status update succeeds
// 2. One succeeds, one returns not a UDP socket: PMTUD status update succeeds
// 4. Neither setsockopt succeeds: PMTUD disabled
// 3. Either setsockopt fails: PMTUD disabled
func (c *Conn) UpdatePMTUD() {
```

[`peermtu.go#L64-L85`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/peermtu.go#L64-L85)。

**IPv4 と IPv6 の 2 つのソケットがあり、それぞれ 3 通りの結果があるので 9 通りの組み合わせがある。** それを 1 個の真偽値に畳む規則が、真理値表として書かれている (番号が 1, 2, 4, 3 の順になっているのはご愛嬌)。

要点は **「どちらかが失敗したら無効」** で、片方だけ DF が立った中途半端な状態を作らない。失敗したら、成功していた側も明示的に戻す。

```go title="wgengine/magicsock/peermtu.go"
	} else {
		c.logf("[unexpected] magicsock: peermtu: updating peer MTU status to %v failed (v4: %v, v6: %v), disabling", enable, err4, err6)
		_ = c.setDontFragment("udp4", false)
		_ = c.setDontFragment("udp6", false)
		newStatus = false
	}
```

そして設定が変わったら、**全ピアの経路状態をリセットして測り直す**。

```go title="wgengine/magicsock/peermtu.go"
	c.peerMTUEnabled.Store(newStatus)
	c.resetEndpointStates()
```

### 正常なエラーをログから外す

```go title="wgengine/magicsock/peermtu.go"
var errEMSGSIZE error = unix.EMSGSIZE

func pmtuShouldLogDiscoTxErr(m disco.Message, err error) bool {
	// Large disco.Ping packets used to probe path MTU may result in
	// an EMSGSIZE error fairly regularly which can pollute logs.
	p, ok := m.(*disco.Ping)
	if !ok || p.Padding == 0 || !errors.Is(err, errEMSGSIZE) || debugPMTUD() {
		return true
	}
	return false
}
```

[`peermtu.go#L118-L128`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/peermtu.go#L118-L128)。

**「パディング付きの Ping が EMSGSIZE で失敗する」のは、測定が機能している証拠だ。** 9000 バイトの ping が 1500 の経路で失敗するのは当然で、それを見て「この経路は 9000 を通せない」と分かる。

だからこの組み合わせのときだけログを出さない。**条件が 4 つの AND (Ping である、パディングがある、EMSGSIZE である、デバッグモードでない) で、1 つでも外れたらログを出す** という書き方になっている。

### 測定の記録

```go title="wgengine/magicsock/endpoint.go"
	pktLen := int(pingSizeToPktLen(sp.size, src))
	if sp.size != 0 {
		m := getPeerMTUsProbedMetric(tstun.WireMTU(pktLen))
		m.Add(1)
		if metricMaxPeerMTUProbed.Value() < int64(pktLen) {
			metricMaxPeerMTUProbed.Set(int64(pktLen))
		}
	}
```

[`endpoint.go#L1825-L1832`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L1825-L1832)。

**サイズごとにメトリクスが分かれている。** 「1400 の ping が何回成功したか」「9000 は何回か」。これを集計すれば、**実際のインターネットでどのサイズが通るのか** が分かる。既定で無効の機能を、有効化の判断材料を集めながら育てている。

## なぜそうなっているか

### なぜ ping にパディングを詰めるのか

経路の MTU を知るには、**そのサイズのパケットを実際に送ってみるしかない**。

普通の PMTUD は「大きなパケットを送り、ICMP Fragmentation Needed が返るのを待つ」。だがインターネットでは **ICMP がフィルタされていることが多い** (いわゆる PMTUD ブラックホール)。返事が来ないので、送信側は「届いたのか、落ちたのか」が分からない。

disco の Ping なら、**通れば Pong が返る**。ICMP に依存しない。返らなければ、そのサイズは通らないと分かる。**すでにある往復の仕組みに、サイズという次元を足しただけ** で測定になっている。

### なぜ二分探索しないのか

理論的には、二分探索なら log(n) 回で正確な値が求まる。だが、

- **正確な値は要らない。** 1500 と 1492 の違いは実用上ほとんど関係ない
- **現実の MTU は数種類しかない。** 1500 (Ethernet)、1492 (PPPoE)、1400 前後 (各種トンネル)、9000 (ジャンボ)
- **二分探索は往復が直列になる。** 6 発を並列に撃つほうが速い

**離散的な候補が少数しかないなら、全部試すほうが速くて単純だ。** [portmapper が 3 つのプロトコルを全部試す](../portmapper/)のと同じ判断になっている。

### なぜ 1280 が安全なのか

RFC 8200 (IPv6) は、**すべてのリンクが 1280 バイトの MTU を持つことを要求する**。これを下回るリンクは、リンク層で分割・再構築しなければならない。

だから 1280 は「IPv6 が動く経路なら必ず通る」値だ。IPv4 の最小要件は 68 バイトだが、実用上 1280 を下回る経路はほとんどない。

**規格が保証する下限を既定値にする** のは、「情報がないときの安全な選択」として理にかなっている。効率は落ちるが、確実に届く。

### なぜ既定で無効なのか

PMTUD は歴史的に壊れやすい機能だ。

- ICMP をフィルタするネットワークで、大きなパケットが黙って消える
- 経路が変わると MTU も変わるが、古い値をキャッシュし続ける
- 一部のミドルボックスが DF ビットを無視する

しかも **失敗の症状が分かりにくい**。「小さなパケットは通るが、大きなパケットだけ消える」は、アプリケーションから見ると「たまに固まる」に見える。

「PMTUD が堅牢だと確信できるまでは」というコメントは、**この機能を有効にした結果として起きる障害を、まだ十分に観測していない** という表明だ。だから既定は無効にして、メトリクスを集めながら判断する。

**control server のノブで有効化できる**ので、一部のユーザーで試して結果を見ることもできる。

### なぜ MTU の型を分けるのか

TUN MTU と Wire MTU は 80 バイト違う。どちらも `uint32` で、代入しても警告は出ない。

**間違えた場合の症状は「大きなパケットだけが消える」** で、これはテストで見つかりにくい。小さなパケットは正常に流れるので、大半のテストは通る。

型を分けておけば、**変換関数を通さない代入がコンパイルエラーになる**。そして変換関数の中で 80 バイトの加減算をするので、計算が 1 箇所に集まる。

## どう活かすか

**同じ単位の値でも、基準点が違うなら別の型にする。** MTU (TUN 基準 / wire 基準)、時刻 (単調時計 / 壁時計)、価格 (税込 / 税抜)、座標 (画面 / ワールド)。混同したときの症状が分かりにくいものほど、型で守る価値がある。

**用語の定義をパッケージの冒頭に書く。** 1 つの言葉が文脈で違うものを指すなら、コードを読む前に定義が要る。60 行のコメントは長いが、**その 60 行がなければ全員が毎回コードから推測することになる**。

**候補が離散的で少数なら、探索アルゴリズムより全部試すほうが良いことがある。** 並列に撃てるなら往復も 1 回で済む。二分探索は「候補が連続で、直列に試すしかない」場合に効く。

**測定は、既存の往復の仕組みに次元を足すと安く実現できる。** disco の ping にサイズを足しただけで PMTUD になった。専用のプロトコルを作らずに済み、経路も同一であることが保証される。

**情報がないときの既定値は、規格が保証する下限にする。** 効率は落ちるが確実に動く。そして「測れたら上げる」を後から足す。逆順 (楽観的な値から始めて失敗したら下げる) は、失敗が観測しにくい領域では危険だ。

**新機能は既定で無効にし、メトリクスを集めながら判断する。** 「確信できるまでは false」とコメントに書き、有効化のノブをサーバ側に持つ。段階的な展開の準備が、コードの構造に組み込まれている。

**「正常な失敗」はログから除外する。ただし条件を厳密に。** PMTUD の EMSGSIZE は測定が働いている証拠だ。ただし除外条件を広く取ると本物のエラーが消えるので、4 条件の AND で絞り、デバッグモードでは全部出す。
