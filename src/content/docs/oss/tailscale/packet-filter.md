---
title: "ACL をパケットフィルタに落とす"
description: "管理画面で書いた ACL は、netmap を通ってクライアントに届き、パケットごとに評価される match のリストになる。入りは厳しく、出は素通し。UDP の戻りは 512 エントリの LRU で覚える。IP の集合を引く関数は、要素数に応じて 6 種類の実装から選ばれる。"
group: "データパス"
sidebar:
  order: 22
---

## 何を学んだか

### ACL はクライアントで評価される

Tailscale の ACL は管理画面で 1 か所に書く。だがその評価は **各ノードのクライアント上で、パケットごとに行われる**。

control server は ACL を「このノードに関係する部分」だけに展開し、`FilterRule` の列として netmap に載せる。クライアントはそれを `filter.Match` のリストにコンパイルして、[tstun](../tstun/) のフックから呼ぶ。

### 入りは厳しく、出は素通し

```go
func (f *Filter) runOut(q *packet.Parsed) (r Response, why string) {
	f.UpdateOutboundFlowState(q)
	return Accept, "ok out"
}
```

**送信は常に許可する。** 2 行しかない。

対して受信は、

1. 宛先が自分のアドレスか (**そうでなければ拒否**)
2. プロトコルごとの判定
3. match のリストとの照合
4. どれにも当たらなければ **拒否**

**ACL は「誰が誰に接続してよいか」を規定するもので、その判定は接続を受ける側で行えば足りる。**

### プロトコルごとに違う扱い

| プロトコル | 受信時の扱い                                                            |
| ---------- | ----------------------------------------------------------------------- |
| TCP        | **SYN でなければ無条件で許可**                                          |
| UDP / SCTP | LRU にフローがあれば許可、なければ match を評価                         |
| ICMP       | echo 応答とエラーは許可。それ以外は「どこかのポートが開いていれば」許可 |

**TCP は SYN だけを見る。** 新しい接続は SYN から始まるので、SYN を止めれば接続は成立しない。継続パケットを毎回評価する必要がない。

### IP の集合を引く関数を、6 通りから選ぶ

「この IP は集合に含まれるか」を判定する関数を作るとき、**要素数と形に応じて実装を切り替える**。

| 条件                    | 実装                  |
| ----------------------- | --------------------- |
| 0 個                    | 常に false を返す関数 |
| プレフィックス 1 個     | `Prefix.Contains`     |
| プレフィックス 6 個以下 | 線形走査              |
| プレフィックス 7 個以上 | bart (経路トライ)     |
| 単一 IP 1 個            | `==` 比較             |
| 単一 IP 2 個            | 2 回の `==`           |
| 単一 IP 3 個以上        | マップ                |

## ソースコードのどこか

### match の形

```go title="wgengine/filter/filtertype/filtertype.go"
// Match matches packets from any IP address in Srcs to any ip:port in
// Dsts.
type Match struct {
	// IPProto is the set of IP protocol numbers for which this match applies.
	// It is required. There is no default value at this layer.
	// If empty, it doesn't match.
	IPProto views.Slice[ipproto.Proto]

	// Srcs is the set of source IP prefixes for which this match applies.
	Srcs []netip.Prefix
	// SrcsContains is an optimized function that reports whether Addr is in
	// Srcs, using the best search method for the size and shape of Srcs.
	SrcsContains func(netip.Addr) bool `json:"-"`

	// SrcCaps is an alternative way to match packets. If the peer's source IP
	// has one of these capabilities, it's also permitted.
	SrcCaps []nodecap.Cap

	Dsts []NetPortRange // optional, if source matches
	Caps []CapMatch     // optional, if source match
}
```

[`filtertype.go#L68-L92`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/filter/filtertype/filtertype.go#L68-L92)。

**`Srcs` (データ) と `SrcsContains` (それを引く関数) が両方フィールドとして入っている。** 関数は `json:"-"` でシリアライズ対象外。

「データを持ち、必要なときに走査する」のではなく、**コンパイル時に最適な検索関数を作って持っておく**。パケットごとに評価されるので、この前計算が効く。

`IPProto` に「デフォルト値はない。空なら何にもマッチしない」と書かれているのが重要だ。**フィルタのルールで「未指定」が「全部」を意味すると、設定ミスが穴になる。** 空は「何も許可しない」に倒している。

### 受信の判定

```go title="wgengine/filter/filter.go"
func (f *Filter) runIn4(q *packet.Parsed) (r Response, why string) {
	// A compromised peer could try to send us packets for
	// destinations we didn't explicitly advertise. This check is to
	// prevent that.
	if !f.local4(q.Dst.Addr()) {
		return noVerdict, "destination not allowed"
	}

	switch q.IPProto {
	case ipproto.ICMPv4:
		if q.IsEchoResponse() || q.IsError() {
			// ICMP responses are allowed.
			return Accept, "icmp response ok"
		} else if f.matches4.matchIPsOnly(q, f.srcIPHasCap) {
			// If any port is open to an IP, allow ICMP to it.
			return Accept, "icmp ok"
		}
	case ipproto.TCP:
		// For TCP, we want to allow *outgoing* connections,
		// which means we want to allow return packets on those
		// connections. To make this restriction work, we need to
		// allow non-SYN packets (continuation of an existing session)
		// to arrive. This should be okay since a new incoming session
		// can't be initiated without first sending a SYN.
		// It happens to also be much faster.
		if !q.IsTCPSyn() {
			return Accept, "tcp non-syn"
		}
		if f.matches4.match(q, f.srcIPHasCap) {
			return Accept, "tcp ok"
		}
	case ipproto.UDP, ipproto.SCTP:
		t := flowtrack.MakeTuple(q.IPProto, q.Src, q.Dst)

		f.state.mu.Lock()
		_, ok := f.state.lru.Get(t)
		f.state.mu.Unlock()

		if ok {
			return Accept, "cached"
		}
```

[`filter.go#L502-L547`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/filter/filter.go#L502)。

**最初のチェックが「侵害されたピア」を想定している。** 「侵害されたピアが、我々が明示的に広告していない宛先へのパケットを送ってくるかもしれない」。

[subnet router](../subnet-router-exit-node/) を動かしていると、自分宛でないパケットも転送する。だが **自分が広告していない範囲のパケットは、転送してはいけない**。ピアが嘘の宛先を書いて送ってきても、ここで止まる。

**TCP の判定の理由が 6 行のコメントで説明されている。** 「発信の接続を許可したい → その戻りパケットを許可する必要がある → SYN でないパケットを通せばよい → 新しい受信セッションは SYN なしには始められないので安全 → ついでにずっと速い」。

**セキュリティ上の論証と、性能上の利点が同じ判断から出ている。**

### UDP には接続追跡が要る

```go title="wgengine/filter/filter.go"
type filterState struct {
	mu  sync.Mutex
	lru *flowtrack.Cache[struct{}] // from flowtrack.Tuple -> struct{}
}

// lruMax is the size of the LRU cache in filterState.
const lruMax = 512
```

[`filter.go#L103-L109`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/filter/filter.go#L103-L109)。

UDP には SYN がないので、「これは自分が始めた通信の戻りか」を判断できない。**発信したフローを覚えておくしかない。**

LRU のサイズは 512。**古いエントリは押し出される。** つまり、多数の UDP フローを同時に持つと、古いフローの戻りパケットが落ちうる。それを許容している。

```go title="wgengine/filter/filter.go"
func (f *Filter) runOut(q *packet.Parsed) (r Response, why string) {
	f.UpdateOutboundFlowState(q)
	return Accept, "ok out"
}
```

[`filter.go#L625-L628`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/filter/filter.go#L625-L628)。

**送信の処理は「フローを記録して許可」だけ。**

### 迂回路のための公開 API

```go title="wgengine/filter/filter.go"
// UpdateOutboundFlowState records reverse-flow connection-tracking state for
// the given outbound packet so that subsequent inbound replies on the same
// flow are admitted by [Filter.RunIn] without an explicit allow rule.
//
// Only UDP and SCTP packets are tracked; for other protocols this is a no-op.
//
// It is intended for callers that synthesize outbound packets and bypass
// [Filter.RunOut] (for example netstack's [InjectOutbound] path used by
// userspace networking, tsnet and the SOCKS5/HTTP proxies), so that reply
// packets matching an outbound UDP flow are not silently dropped as "no
// matching rule" by [Filter.RunIn]. See tailscale/tailscale#14229 and
// tailscale/tailscale#20064.
func (f *Filter) UpdateOutboundFlowState(q *packet.Parsed) {
	switch q.IPProto {
	case ipproto.UDP, ipproto.SCTP:
		tuple := flowtrack.MakeTuple(q.IPProto, q.Dst, q.Src) // src/dst reversed
```

[`filter.go#L630-L645`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/filter/filter.go#L630)。

**フィルタを迂回する経路があると、接続追跡の記録が抜ける。** [netstack](../netstack/) や tsnet、SOCKS5 プロキシは、パケットを合成して直接注入するので `RunOut` を通らない。

そのまま放置すると、**UDP の応答が「該当するルールがない」として黙って落とされる**。しかも DNS のような UDP ベースのプロトコルで、原因が分かりにくい形で。

対処は「フローの記録だけを行う関数を公開する」こと。issue が 2 つ参照されているので、**同じ問題が別の経路で 2 回起きた** と分かる。

**ファストパスを作るときの [tailnet lock と同じ構図](../netmap-apply/)** だ。迂回路は、迂回した処理の副作用まで持ち出さないと壊れる。

### 判定の 4 値

```go title="wgengine/filter/filter.go"
// Response is a verdict from the packet filter.
type Response int

const (
	Drop         Response = iota // do not continue processing packet.
	DropSilently                 // do not continue processing packet, but also don't log
	Accept                       // continue processing packet.
	noVerdict                    // no verdict yet, continue running filter
)
```

[`filter.go#L111-L119`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/filter/filter.go#L111-L119)。

**`noVerdict` が非公開なのが要点だ。** フィルタの内部では「まだ決まらない」状態を持つが、外には見せない。外から見れば必ず accept か drop に決まる。

`DropSilently` は「落とすがログに出さない」。[MagicDNS の ICMP](../tstun/) のように、**正常な処理として落とす**ケースがある。

### IP 集合の引き方を選ぶ

```go title="net/ipset/ipset.go"
func NewContainsIPFunc(addrs views.Slice[netip.Prefix]) func(ip netip.Addr) bool {
	// Specialize the three common cases: no address, just IPv4
	// (or just IPv6), and both IPv4 and IPv6.
	if addrs.Len() == 0 {
		pathForTest("empty")
		return emptySet
	}
	// If any addr is a prefix with more than a single IP, then do either a
	// linear scan or a bart table, depending on the number of addrs.
	if addrs.ContainsFunc(func(p netip.Prefix) bool { return !p.IsSingleIP() }) {
		if addrs.Len() == 1 {
			pathForTest("one-prefix")
			return addrs.At(0).Contains
		}
		if addrs.Len() <= 6 {
			// Small enough to do a linear search.
			pathForTest("linear-contains")
			return prefixContainsLoop(addrs.AsSlice())
		}
		pathForTest("bart")
		// Built a bart table.
		t := &bart.Lite{}
		...
	}
	// Fast paths for 1 and 2 IPs:
	if addrs.Len() == 1 {
		pathForTest("one-ip")
		return oneIP(addrs.At(0).Addr())
	}
	if addrs.Len() == 2 {
		pathForTest("two-ip")
		return twoIP(addrs.At(0).Addr(), addrs.At(1).Addr())
	}
	// General case:
	pathForTest("ip-map")
	...
}
```

[`ipset.go#L56-L99`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/ipset/ipset.go#L56-L99)。

**戻り値はどのケースでも `func(netip.Addr) bool` で同じ。** 呼び出し側は実装の違いを知らない。

`pathForTest` は **テスト用のフックで、どの経路を通ったかを記録する**。「7 個のプレフィックスを渡したら bart が選ばれること」をテストできる。**最適化の分岐は、外から見た挙動が同じなので、テストしないと壊れても気づけない。**

1 個と 2 個をクロージャで特殊化しているのが徹底している。マップの参照はハッシュ計算とメモリアクセスが要るが、`ip == ip1 || ip == ip2` は数命令で終わる。**ノードのアドレスは IPv4 と IPv6 が 1 個ずつ = 2 個** なので、この 2 個のケースが実際に最も多い。

## なぜそうなっているか

### なぜ送信を素通しにするのか

ACL は「A から B への接続を許可する」という形で書かれる。この規則は **接続を受ける B 側で評価すれば十分** だ。

送信側でも評価すると、

- 同じ判定が 2 回走る (往復のたびに)
- 送信側と受信側で ACL の版が違うと、判定がずれる
- 送信側の実装を信用することになる (**侵害されたノードは自分の送信フィルタを外せる**)

**セキュリティ上の判定は、守りたい側で行う。** 送信側のフィルタは、あっても攻撃者に外されるので意味がない。

### なぜ TCP は SYN だけを見るのか

TCP の接続は必ず SYN から始まる。SYN を止めれば、その接続は成立しない。

- SYN を通さなければ、その後のパケットは相手の TCP スタックに拒否される
- 逆に、こちらから発信した接続の戻りパケットは SYN ではないので、そのまま通る
- **接続追跡のテーブルが要らない**

`IsTCPSyn()` はフラグ 1 ビットの検査で、match のリスト走査より 2 桁速い。**通信の大部分は確立済み接続の継続パケットなので、そこが速くなる。**

### なぜ UDP には LRU が要るのか

UDP には「接続の開始」を表すものがない。**「これは自分が始めた通信の戻りか」を判断するには、覚えておくしかない。**

サイズが 512 なのは、メモリと正しさのトレードオフだ。無制限にすると、大量の UDP フローでメモリを食い、DoS の的になる。512 なら数十 KB で収まる。

**押し出されたフローの戻りパケットは落ちる。** これは正しくないが、実用上は問題にならない — 通信が続いているフローは LRU の先頭に留まるので、押し出されるのは既に止まったフローだ。

### なぜ集合の実装を切り替えるのか

この関数は **パケットごとに、match ごとに呼ばれる**。1 秒に数十万回のオーダーになりうる。

一方、集合のサイズは環境によって桁違いだ。

- 自分のアドレス: 2 個 (IPv4 + IPv6)
- 小さな tailnet の全ノード: 数十個
- subnet route を含む大きな tailnet: 数千プレフィックス

**単一の実装で全部をカバーすると、どこかで無駄になる。** 2 個のために bart トライを構築するのは、メモリも構築時間も無駄だ。数千個を線形走査するのは論外だ。

構築は設定変更時にしか起きないので、**構築時に分岐して、実行時は分岐なし** にできる。クロージャを返す設計がそれを可能にしている。

### なぜ空の `IPProto` を「何にもマッチしない」にするのか

フィルタのルールで「未指定 = 全部」にすると、**設定の一部が欠けたときに、意図せず全許可になる**。

「未指定 = 何も許可しない」なら、設定が欠けたときに通信できなくなる。これはユーザーに見えるので、すぐ気づいて直せる。

**フェイルクローズドの原則が、型のデフォルト値の設計に現れている。** そして「このレイヤにデフォルト値はない」と明記することで、上位が明示的に埋める責任を負うことになる。

## どう活かすか

**アクセス制御の判定は、守る側で行う。** 送信側の判定は、攻撃者が制御するコードなので信用できない。両方でやると版のずれで謎の失敗が起きる。「片側でだけ判定する」と決めて、どちら側かを明示する。

**接続の開始だけを検査すれば、状態を持たずに済むことがある。** TCP の SYN、HTTP の最初のリクエスト、セッションの確立。継続する通信のすべてを検査するより、開始点だけを厳しくするほうが速くて単純になる。**その代わり「開始点を必ず通る」ことを確認する。**

**状態を持たざるを得ないなら、上限を決めて溢れさせる。** 無制限のテーブルは DoS の的になる。LRU なら、活きているフローが残り、死んだフローが押し出される。**「押し出されたときに何が起きるか」を許容できるかを判断する。**

**ホットパスで使う述語は、データではなく関数として前計算する。** 集合の大きさや形に応じて実装を選び、同じシグネチャの関数を返す。呼び出し側は分岐を持たない。設定変更時にしか構築しないなら、構築のコストは無視できる。

**最適化の分岐は、外から見た挙動が同じなのでテストが要る。** どの実装が選ばれたかを記録するテストフックを入れる。入れないと、「6 個以下は線形」という条件を壊しても誰も気づかない。

**フィルタを迂回する経路を作ったら、迂回した処理の副作用を明示的に呼べるようにする。** 接続追跡の記録、メトリクスの更新、監査ログ。迂回路は「速いが不完全」になりがちで、不完全さは別の場所で症状として出る。

**設定の「未指定」は、安全側 (拒否) に倒す。** そして「このレイヤにデフォルトはない」と型のドキュメントに書き、上位が埋める責任を明示する。
