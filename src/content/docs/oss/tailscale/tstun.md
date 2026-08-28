---
title: "TUN デバイスのラッパーを、あらゆる処理の挿入点にする"
description: "OS の TUN デバイスを薄く包んだだけの型に、7 つのフィルタフック・パケット注入・NAT・接続カウンタ・パケットキャプチャが集まっている。MagicDNS への ICMP echo はここで偽の応答を作って返す。Start を呼び忘れた開発者のために、1 秒ごとにログを出す仕掛けまである。"
group: "データパス"
sidebar:
  order: 21
---

## 何を学んだか

### TUN デバイスがすべての通り道

OS の TUN デバイスは、**カーネルのネットワークスタックとユーザー空間のプログラムをつなぐパイプ** だ。`100.x.y.z` 宛のパケットは OS のルーティングで TUN に送られ、`tailscaled` が読み取る。逆に `tailscaled` が TUN に書き込んだパケットは、OS が受信したものとして扱われる。

**この 1 点をすべてのパケットが通る。** だから、パケットに対してやりたいことは全部ここに置ける。

`tstun.Wrapper` は `tun.Device` を包み、そこに次のものを足している。

- **7 つのフィルタフック** (前段・本体・後段 × 送受信)
- **パケットの注入** (`InjectInboundCopy`)
- **NAT** (ピアから見た自分のアドレスを書き換える)
- **接続ごとのカウンタ** ([netlog](../netlog/) 用)
- **パケットキャプチャ** (`tailscale debug capture`)
- **アイドル時間の記録**

### 方向の呼び方を固定する

コメントが方向の定義を明示している。

> **方向はデバイスではなくネットワークを基準にする。** inbound なパケットは UDP で到着して TUN に書き込まれる。outbound なパケットは TUN から読まれて UDP で送り出される。

だからフックの名前は `PacketInboundFromWireGuard` と `PacketOutboundToWireGuard` になる。**長い名前だが、方向を取り違えようがない。**

### MagicDNS への ping には偽の応答を返す

`100.100.100.100` に `ping` を打つと応答が返る。だが **そこには誰もいない**。tstun が ICMP echo request を見つけて、その場で応答を組み立てて注入している。

### Start を呼び忘れたときのために

`Wrapper` は「corked (栓をした)」状態で作られ、`Start()` を呼ぶまで読み取りがブロックされる。そして待っているあいだ、**1 秒ごとにログを出す**。

## ソースコードのどこか

### フックの一覧

```go title="net/tstun/wrap.go"
	// PreFilterPacketInboundFromWireGuard is the inbound filter function that runs before the main filter
	// and therefore sees the packets that may be later dropped by it.
	PreFilterPacketInboundFromWireGuard FilterFunc
	// PostFilterPacketInboundFromWireGuardAppConnector runs after the filter, but before PostFilterPacketInboundFromWireGuard.
	// Non-app connector traffic is passed along. Invalid app connector traffic is dropped.
	PostFilterPacketInboundFromWireGuardAppConnector FilterFunc
	// PostFilterPacketInboundFromWireGuard is the inbound filter function that runs after the main filter.
	PostFilterPacketInboundFromWireGuard GROFilterFunc
	// PreFilterPacketOutboundToWireGuardNetstackIntercept is a filter function that runs before the main filter
	// for packets from the local system. This filter is populated by netstack to hook
	// packets that should be handled by netstack. If set, this filter runs before
	// PreFilterFromTunToEngine.
	PreFilterPacketOutboundToWireGuardNetstackIntercept GROFilterFunc
	// PreFilterPacketOutboundToWireGuardEngineIntercept is a filter function that runs before the main filter
	// for packets from the local system. This filter is populated by wgengine to hook
	// packets which it handles internally. If both this and PreFilterFromTunToNetstack
	// filter functions are non-nil, this filter runs second.
	PreFilterPacketOutboundToWireGuardEngineIntercept FilterFunc
	// PreFilterPacketOutboundToWireGuardAppConnectorIntercept runs after PreFilterPacketOutboundToWireGuardEngineIntercept
	// for app connector specific traffic.
	PreFilterPacketOutboundToWireGuardAppConnectorIntercept FilterFunc
	// PostFilterPacketOutboundToWireGuard is the outbound filter function that runs after the main filter.
	PostFilterPacketOutboundToWireGuard FilterFunc
```

[`wrap.go#L173-L200`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L173-L200)。

**名前が長い。** `PreFilterPacketOutboundToWireGuardAppConnectorIntercept` は 52 文字ある。だが読めば、

- `PreFilter` — 本体フィルタの前
- `PacketOutboundToWireGuard` — TUN から読んで WireGuard へ出る方向
- `AppConnectorIntercept` — app connector が横取りする用途

**すべてのフックについて「どの順で走るか」がコメントに書かれている。** 「これは本体の後、ただし `PostFilterPacketInboundFromWireGuard` の前」というように、相対順序が明示される。

そしてフックの設定者も書かれている — netstack が設定する、wgengine が設定する、app connector が設定する。**「誰がこのフックを使うか」が分かる。**

### フックの型

```go title="net/tstun/wrap.go"
// FilterFunc is a packet-filtering function with access to the Wrapper device.
// It must not hold onto the packet struct, as its backing storage will be reused.
type FilterFunc func(*packet.Parsed, *Wrapper) filter.Response

// GROFilterFunc is a FilterFunc extended with a *gro.GRO, enabling increased
// throughput where GRO is supported by a packet.Parsed interceptor, e.g.
// netstack/gVisor, and we are handling a vector of packets. Callers must pass a
// nil g for the first packet in a given vector, and continue passing the
// returned *gro.GRO for all remaining packets in said vector.
type GROFilterFunc func(p *packet.Parsed, w *Wrapper, g *gro.GRO) (filter.Response, *gro.GRO)
```

[`wrap.go#L80-L91`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L80-L91)。

**「パケット構造体を保持してはならない。バッキングストレージが再利用されるので」** という制約が、型のドキュメントに書かれている。

```go title="net/tstun/wrap.go"
// parsedPacketPool holds a pool of Parsed structs for use in filtering.
// This is needed because escape analysis cannot see that parsed packets
// do not escape through {Pre,Post}Filter{In,Out}.
var parsedPacketPool = sync.Pool{New: func() any { return new(packet.Parsed) }}
```

[`wrap.go#L74-L77`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L74-L77)。

**「エスケープ解析が、パケットがフックの外に漏れないことを見抜けない」** ので、明示的にプールを使う。フックが関数値 (`FilterFunc`) なので、コンパイラは呼び出し先の中身を知らず、引数がヒープに漏れると仮定するしかない。

`GROFilterFunc` の設計も特徴的だ。**GRO (Generic Receive Offload) の状態を、呼び出し側が引き回す。** 「ベクタの最初のパケットでは nil を渡し、以降は返ってきたものを渡し、最後に `Flush()` を呼べ」という契約がドキュメントに書かれている。状態を型に持たせず、呼び出しの規約にしている。

### 送信方向の処理順序

```go title="net/tstun/wrap.go"
func (t *Wrapper) filterPacketOutboundToWireGuard(p *packet.Parsed, pc *peerConfigTable, gro *gro.GRO) (filter.Response, *gro.GRO) {
	// Fake ICMP echo responses to MagicDNS (100.100.100.100).
	if p.IsEchoRequest() {
		switch p.Dst {
		case magicDNSIPPort:
			header := p.ICMP4Header()
			header.ToResponse()
			outp := packet.Generate(&header, p.Payload())
			t.InjectInboundCopy(outp)
			return filter.DropSilently, gro // don't pass on to OS; already handled
```

[`wrap.go#L745-L762`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L745)。

**`100.100.100.100` への ping に、その場で応答を作って注入する。**

`ping 100.100.100.100` が通ることには実用的な価値がある。ユーザーが「Tailscale は動いているか」を確かめる最初の手段だからだ。だが [MagicDNS のリゾルバ](../magicdns-resolver/) は UDP/TCP の 53 番しか listen していないので、ICMP に応答する主体がいない。

**「そこにいるように見せる」ためだけのコードが 16 行。** ユーザーの期待に応えるためのコストとして、安い。

### 想定外の入力を落とす

```go title="net/tstun/wrap.go"
	// TSMP traffic should only originate from tailscaled, not from the host
	// itself.
	if p.IPProto == ipproto.TSMP {
		t.limitedLogf("[unexpected] received TSMP out packet over tstun; dropping")
		metricPacketOutDropTSMP.Add(1)
		return filter.DropSilently, gro
	}

	// Issue 1526 workaround: if we sent disco packets over
	// Tailscale from ourselves, then drop them, as that shouldn't
	// happen unless a networking stack is confused, as it seems
	// macOS in Network Extension mode might be.
	if p.IPProto == ipproto.UDP && // disco is over UDP; avoid isSelfDisco call for TCP/etc
		t.isSelfDisco(p) {
		t.limitedLogf("[unexpected] received self disco out packet over tstun; dropping")
		metricPacketOutDropSelfDisco.Add(1)
		return filter.DropSilently, gro
	}
```

[`wrap.go#L764-L781`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L764)。

**2 つ目が具体的だ。** 「macOS の Network Extension モードで、ネットワークスタックが混乱すると、自分の disco パケットが Tailscale のトンネル自身に入ってくることがある」。

そのまま流すと、**disco パケットが Tailscale の中を通って自分に戻ってくる**というループになる。issue 番号つきで、条件と対処が書かれている。

`limitedLogf` は **強く流量制限されたログ**だ。この種の異常は起きるときには大量に起きるので、普通のログだと埋まる。

### フックの呼び出し順

```go title="net/tstun/wrap.go"
	if t.PreFilterPacketOutboundToWireGuardNetstackIntercept != nil {
		var res filter.Response
		res, gro = t.PreFilterPacketOutboundToWireGuardNetstackIntercept(p, t, gro)
		if res.IsDrop() {
			// Handled by netstack.Impl.handleLocalPackets (quad-100 DNS primarily)
			return res, gro
		}
	}
	if t.PreFilterPacketOutboundToWireGuardEngineIntercept != nil {
		if res := t.PreFilterPacketOutboundToWireGuardEngineIntercept(p, t); res.IsDrop() {
			// Handled by userspaceEngine.handleLocalPackets (primarily handles
			// quad-100 if netstack is not installed).
			return res, gro
		}
	}
```

[`wrap.go#L783-L803`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L783)。

**`IsDrop()` が「このフックが処理を引き取った」を意味する。** パケットは先に進まないが、捨てられたわけではない。netstack や wgengine の中で処理されている。

コメントが「netstack がインストールされていなければ、こちらが quad-100 を扱う」と説明していて、**2 つのフックが同じ役割を、環境によって分担している** ことが分かる。

### フィルタの選択

```go title="net/tstun/wrap.go"
	// If the outbound packet is to a jailed peer, use our jailed peer
	// packet filter.
	var filt *filter.Filter
	if pc.outboundPacketIsJailed(p) {
		filt = t.jailedFilter.Load()
	} else {
		filt = t.filter.Load()
	}
	if filt == nil {
		return filter.Drop, gro
	}

	if resp, reason := filt.RunOut(p, t.filterFlags); resp != filter.Accept {
		metricPacketOutDropFilter.Add(1)
		if reason != "" {
			t.metrics.outboundDroppedPacketsTotal.Add(usermetric.DropLabels{
				Reason: reason,
			}, 1)
		}
		return filter.Drop, gro
	}
```

[`wrap.go#L805-L825`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L805)。

**フィルタが 2 種類ある。** 通常のピア用と、「jailed」なピア (制限つきで共有されたノード) 用。宛先によって使うフィルタを切り替える。

**`filt == nil` なら drop。** フィルタが未設定の状態で通信を通さない。起動直後や設定リロード中に、意図せずパケットが漏れることを防ぐ。**フェイルクローズド (失敗したら閉じる) の実装。**

ドロップの理由はラベル付きのメトリクスに記録される。`usermetric` はユーザーに見せるメトリクスで、`tailscale metrics` や Prometheus 経由で取れる。

### 双方向のキューの非対称性

```go title="net/tstun/wrap.go"
	// vectorOutbound is the queue by which packets leave the TUN device.
	//
	// The directions are relative to the network, not the device:
	// inbound packets arrive via UDP and are written into the TUN device;
	// outbound packets are read from the TUN device and sent out via UDP.
	// This queue is needed because although inbound writes are synchronous,
	// the other direction must wait on a WireGuard goroutine to poll it.
	//
	// Empty reads are skipped by WireGuard, so it is always legal
	// to discard an empty packet instead of sending it through vectorOutbound.
	vectorOutbound chan tunVectorReadResult
```

[`wrap.go#L146-L158`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L146-L158)。

**片方向にだけキューがある理由が書かれている。** 内向き (UDP → TUN) は同期的に書き込める。外向き (TUN → UDP) は wireguard-go の goroutine が `Read()` を呼ぶのを待つ必要があるので、その間パケットを置く場所が要る。

「空の読み取りは WireGuard がスキップするので、空のパケットはキューに送らず捨ててよい」も実用的な情報だ。

### 呼び忘れを検出する

```go title="net/tstun/wrap.go"
func (t *Wrapper) awaitStart() {
	for {
		select {
		case <-t.startCh:
			return
		case <-time.After(1 * time.Second):
			// Multiple times while remixing tailscaled I (Brad) have forgotten
			// to call Start and then wasted far too much time debugging.
			// I do not wish that debugging on anyone else. Hopefully this'll help:
			t.logf("tstun: awaiting Wrapper.Start call")
		}
	}
}
```

[`wrap.go#L856-L868`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tstun/wrap.go#L856-L868)。

**「tailscaled をいじっている最中に何度も Start を呼び忘れて、デバッグに時間を無駄にした。他の人に同じ思いをさせたくない」。**

`Wrapper` は作った時点では読み取りをブロックする。パケットフィルタや設定が入る前にパケットが流れると危険だからだ。だが呼び忘れると **何も起きずに固まる** — もっとも分かりにくい失敗の形になる。

**沈黙して固まる代わりに、1 秒ごとに「Start を待っている」と言う。** 実装は 10 行で、コメントのほうが長い。

## なぜそうなっているか

### なぜ TUN のラッパーに全部集めるのか

パケットに対する処理 (フィルタ、NAT、計測、キャプチャ) は、**全部のパケットが必ず通る場所** に置きたい。

Tailscale のデータパスには複数の経路がある — 直結、DERP 経由、peer relay 経由、netstack 経由。**下位で分岐しているものが、TUN では 1 本に合流する。**

だから TUN のラッパーが唯一の共通点になる。ここに置けば、経路によらず必ず適用される。

代償として、この 1 つの型が肥大化する (48 KB)。**「1 箇所に集めることの利益」と「その 1 箇所が大きくなる不利益」を比べて、前者を取っている。**

### なぜフックが 7 つもあるのか

「フィルタの前」と「フィルタの後」で意味が違うからだ。

- **前**: フィルタが落とすかもしれないパケットも見える。**横取り** (netstack が処理する、app connector が書き換える) に使う
- **後**: フィルタを通過したパケットだけが見える。**追加の処理** (計測、変換) に使う

そして送受信で 2 倍になり、用途 (netstack / engine / app connector) で分かれる。

**フックが多いこと自体より、「順序が全部ドキュメントに書かれている」ことが重要だ。** 順序が不明なフックは、副作用の順番に依存したバグを生む。

### なぜ `IsDrop()` が「処理済み」を意味するのか

フックが「このパケットは自分が処理した」と伝える方法として、専用の戻り値を作ることもできた。だが `filter.Response` には既に `Drop` がある。

**「この先に流さない」という点では、落とすのも横取りするのも同じ**だ。区別が必要なのはメトリクスとログだけで、それはフック側で記録すればよい。

`DropSilently` という値もあり、「落とすが、ログには出さない」を表す。**正常な処理としての drop と、異常としての drop を区別している。**

### なぜフィルタ未設定で drop なのか

フェイルオープン (設定がなければ全部通す) だと、**起動直後や設定リロードの瞬間に、ACL が適用されないパケットが流れる**。

セキュリティ機構は「壊れたら閉じる」が原則だ。通信ができないのはユーザーに見えるので気づけるが、**ACL が効いていないことは気づけない**。

### なぜ ICMP に偽の応答を返すのか

`ping` は、ネットワークが動いているかを確かめる最も一般的な手段だ。ユーザーは `ping 100.100.100.100` を打ってみる。

真面目に実装するなら、[netstack](../netstack/) に ICMP のハンドラを持たせる。だが netstack が動いていない構成もある。**16 行で「応答を作って注入する」ほうが、確実で単純だ。**

「ないものをあるように見せる」のは、一般には避けるべきだ。だが **`100.100.100.100` は最初から仮想的なアドレス** で、そこに何かがいるように見せること自体が仕様になっている。

## どう活かすか

**分岐したデータパスが合流する場所を見つけ、横断的な処理をそこに集める。** フィルタ、計測、監査、変換。複数の経路それぞれに実装すると、必ずどれかで漏れる。合流点が 1 つあれば、そこだけを正しくすればよい。

**フックを複数持つなら、相対順序を全部ドキュメントに書く。** 「A の後、B の前」を各フックに書いておく。順序が不明なフックの集合は、副作用の順番に依存した再現困難なバグを生む。

**フックに渡す値の寿命を、型のドキュメントで宣言する。** 「保持してはならない、バッキングストレージが再利用される」。この宣言がないと、フック側が保持して use-after-free 相当のバグになる。Go でも、プールを使っている場合は同じ問題が起きる。

**関数値のフックがある場所では、エスケープ解析が効かないと想定する。** コンパイラは呼び出し先を知らないので、引数がヒープに逃げると仮定する。ホットパスならプールで明示的に管理する。

**セキュリティ機構はフェイルクローズドにする。** 「設定がなければ通す」は、起動・リロード・エラー時に穴を開ける。「設定がなければ落とす」なら、問題は通信不能として即座に可視化される。

**方向を持つ処理には、基準を決めて名前に埋め込む。** 「inbound / outbound はネットワークを基準にする」と決めて、`PacketInboundFromWireGuard` のような長い名前にする。短い名前で取り違えるより、長い名前で確実なほうがよい。

**「呼び忘れると静かに固まる」API には、待っていることを定期的に知らせる仕掛けを入れる。** 10 行のコードで、他の開発者のデバッグ時間を何時間も節約できる。理由をコメントに書いておけば、消されにくくなる。
