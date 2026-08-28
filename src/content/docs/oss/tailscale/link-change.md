---
title: "ネットワークが変わったことに、どうやって気づくか"
description: "Wi-Fi から LTE、ドックの抜き差し、スリープからの復帰。OS ごとに違う通知を 1 つのインターフェースにまとめ、1 秒のデバウンスで束ね、7 個の条件から「ソケットを張り直すべきか」を導く。10 分以上のスリープは、状態が変わっていなくても張り直す — NAT のマッピングが死んでいるからだ。"
group: "NAT 越え"
sidebar:
  order: 17
---

## 何を学んだか

### 移動する端末という前提

`netmon` パッケージのドキュメントは、存在理由を 1 文で書いている。

> **主に、携帯可能なデバイスが異なるネットワーク間を移動するときにそれを知るために存在する。**

ノート PC がドックから外れる。スマートフォンが Wi-Fi から LTE に切り替わる。ラップトップがスリープから復帰する。**そのたびに、それまで使っていた UDP ソケット・NAT のマッピング・STUN で得たアドレスは全部無効になりうる。**

### OS ごとに違う通知を 1 つの形に

Linux は netlink、macOS/BSD は route socket、Windows は IP Helper API。それぞれ別の実装が `osMon` インターフェースを満たす。

```go
type osMon interface {
	Close() error
	Receive() (message, error)
}
```

**「ブロックして、変化があったら返す」だけのインターフェース。** OS 固有の詳細は、この下に完全に隠れる。

### 変化は 1 秒デバウンスする

ドックを抜くと、インターフェースの up/down が短時間に何度も飛んでくる。そのたびに再設定を走らせると無駄が多い。**変化を検知したら 1 秒待ってから状態を読み直す。**

### ソケットを張り直すべきかは 7 条件の OR

`RebindLikelyRequired` という真偽値が、変化の種類から計算される。

| 条件                         | 意味                                           |
| ---------------------------- | ---------------------------------------------- |
| `old == nil`                 | 初回                                           |
| 大きな時刻ジャンプ           | 10 分以上スリープした                          |
| `DefaultInterfaceChanged`    | 既定の経路のインターフェースが変わった         |
| `InterfaceIPsChanged`        | インターフェースの IP が意味のある形で変わった |
| `IsLessExpensive`            | 従量課金の回線から定額の回線に変わった         |
| `HasPACOrProxyConfigChanged` | プロキシ設定が変わった                         |
| `AvailableProtocolsChanged`  | IPv4/IPv6 の利用可否が変わった                 |

これらの OR を取り、さらに **「既定のインターフェースが使えそうか」との AND** を取る。

### スリープの長さで判断を変える

**10 分以上のスリープなら、ネットワーク状態が変わっていなくても張り直す。** NAT のマッピングは死んでいるし、DHCP のリースも更新されている可能性が高い。

**55 秒程度のスリープでは張り直さない。** macOS の DarkWake (メンテナンスのための短時間の起床) で毎回張り直すのは無駄だ。

### 張り直しは「差し替え」

UNIX にはソケットを再バインドする概念がない。だから **新しいソケットを作って差し替える**。読み書きは atomic ポインタ経由で、差し替え中でもロックを取らない。

### エンドポイントは少し長めに覚えておく

一度申告したエンドポイントは、**最後に見てから 5 分 10 秒のあいだ広告し続ける**。これは netcheck の周期 (5 分) より少しだけ長い。

## ソースコードのどこか

### OS 差の吸収

```go title="net/netmon/netmon.go"
// Package netmon provides facilities for monitoring network interface and
// route changes. It primarily exists to know when portable devices move
// between different networks.
package netmon
```

```go title="net/netmon/netmon.go"
// osMon is the interface that each operating system-specific
// implementation of the link monitor must implement.
type osMon interface {
	Close() error

	// Receive returns a new network interface change message. It
	// should block until there's either something to return, or
	// until the osMon is closed. After a Close, the returned
	// error is ignored.
	Receive() (message, error)
}
```

[`netmon.go#L4-L7`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netmon/netmon.go#L4-L7) と [`netmon.go#L50-L60`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netmon/netmon.go#L50-L60)。

**インターフェースはメソッド 2 つ。** OS 側の実装は `netmon_linux.go` (8.9 KB)、`netmon_darwin.go` (6.9 KB)、`netmon_windows.go` (5.3 KB)、そして `netmon_polling.go` (631 バイト、通知機構がない環境向けのポーリング)。

`message` インターフェースには `ignore()` しかない。**OS からのメッセージの中身は上位に渡さず、「変化があった」という事実だけを伝える。** 何が変わったかは、変化後に状態を読み直して差分を取る。

### デバウンス

```go title="net/netmon/netmon.go"
// debounce calls the callback function with a delay between events
func (m *Monitor) debounce() {
	defer m.goroutines.Done()
	for {
		var forceCallbacks bool
		select {
		case <-m.stop:
			return
		case forceCallbacks = <-m.change:
		}

		if newState, err := m.interfaceStateUncached(); err != nil {
			m.logf("interfaces.State: %v", err)
		} else {
			m.handlePotentialChange(newState, forceCallbacks)
		}

		select {
		case <-m.stop:
			return
		// 1s is reasonable debounce time for network changes.  Events such as undocking a laptop
		// or roaming onto wifi will often generate multiple events in quick succession as interfaces
		// flap.  We want to avoid spamming consumers of these events.
		case <-time.After(1000 * time.Millisecond):
		}
	}
}
```

[`netmon.go#L598-L625`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netmon/netmon.go#L598-L625)。

**通知を受けたら「まず処理して、それから 1 秒待つ」** という順序になっている。先に待つのではない。

この順序だと、**最初の変化には即座に反応し、その直後の連続した変化は 1 秒後にまとめて 1 回だけ見る**。「変化を検知 → 1 秒待つ → 処理」だと、単発の変化にも常に 1 秒遅れる。

そして待っているあいだに来たイベントは、チャネルにバッファされて次のループで処理される。**イベントの数ではなく、状態を読み直す回数を減らしている。**

### 変化の分類

```go title="net/netmon/netmon.go"
	DefaultInterfaceChanged     bool // whether default route interface changed
	IsLessExpensive             bool // whether new state's default interface is less expensive than old.
	HasPACOrProxyConfigChanged  bool // whether PAC/HTTP proxy config changed
	InterfaceIPsChanged         bool // whether any interface IPs changed in a meaningful way
	AvailableProtocolsChanged   bool // whether we have seen a change in available IPv4/IPv6
	DefaultInterfaceMaybeViable bool // whether the default interface is potentially viable
	IsInitialState              bool

	// RebindLikelyRequired combines the various fields above to report whether this change likely requires us
	// to rebind sockets.  This is a very conservative estimate and covers a number ofcases where a rebind
	// may not be strictly necessary.  Consumers of the ChangeDelta should consider checking the individual fields
	// above or the state of their sockets.
	RebindLikelyRequired bool
```

[`netmon.go#L121-L133`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netmon/netmon.go#L121-L133)。

**個別の判定と、それを束ねた総合判定の両方を提供する。** コメントが「これは非常に保守的な見積もりで、厳密には再バインドが不要な場合も多く含む。利用者は個別のフィールドや自分のソケットの状態を見ることを検討せよ」と断っている。

**「安全側に倒した既定値」と「細かく判断したい人のための材料」を両方出す。** API 設計としてよい形だ。

`IsLessExpensive` が面白い。**モバイル回線から Wi-Fi に変わったときも再バインドする。** 通信が壊れているわけではないが、より良い経路が使えるようになったので、その経路のソケットを開き直す。

### スリープの長さで分ける

```go title="net/netmon/netmon.go"
// majorTimeJumpThreshold is the minimum sleep duration that warrants
// treating a time jump as a major event requiring socket rebinding,
// even if the interface state appears unchanged. After a long sleep,
// NAT mappings are likely stale and DHCP leases may have expired
// (the renewal happens after wake, so local state may not yet reflect it).
// Short sleeps (e.g., macOS DarkWake maintenance cycles of ~55s) should
// not trigger rebinding if the network state is unchanged.
const majorTimeJumpThreshold = 10 * time.Minute
```

[`netmon.go#L34-L41`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netmon/netmon.go#L34-L41)。

**「ローカルの状態は変わっていないように見えるが、外の世界は変わっている」** という状況の扱いだ。

- NAT のマッピングは 30 秒程度で切れる。10 分寝ていたら確実に死んでいる
- DHCP のリースが更新されるのは起床後なので、**その瞬間のローカル状態にはまだ反映されていない**

「インターフェースの状態が同じだから何もしない」だと、起床後しばらく通信できない。時刻のジャンプという間接的な証拠から、**見えていない変化を推測している**。

そして時刻ジャンプの検出自体にもバックアップがある。

```go title="net/netmon/netmon.go"
// pollWallTimeInterval is how often we check the time to check
// for big jumps in wall (non-monotonic) time as a backup mechanism
// to get notified of a sleeping device waking back up.
// Usually there are also minor network change events on wake that let
// us check the wall time sooner than this.
const pollWallTimeInterval = 15 * time.Second
```

[`netmon.go#L28-L32`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netmon/netmon.go#L28-L32)。

**15 秒ごとに壁時計を見る。** OS のスリープ通知が来ない環境でも、時刻が飛んでいれば気づける。

### 再バインドの理由をログに残す

```go title="net/netmon/netmon.go"
	if cd.RebindLikelyRequired {
		var reasons []string
		if cd.old == nil {
			reasons = append(reasons, "initial-state")
		}
		if cd.TimeJumped() {
			reasons = append(reasons, fmt.Sprintf("time-jumped(%v)", cd.JumpDuration.Round(time.Second)))
		}
		if cd.DefaultInterfaceChanged {
			reasons = append(reasons, "default-if-changed")
		}
```

[`netmon.go#L220-L232`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netmon/netmon.go#L220)。

**7 つの条件の OR を取った後、どれが真だったかを文字列のリストで出す。** 「再バインドした」だけでは、なぜかが分からない。

### ソケットの差し替え

```go title="wgengine/magicsock/rebinding_conn.go"
// RebindingUDPConn is a UDP socket that can be re-bound.
// Unix has no notion of re-binding a socket, so we swap it out for a new one.
type RebindingUDPConn struct {
	// pconnAtomic is a pointer to the value stored in pconn, but doesn't
	// require acquiring mu. It's used for reads/writes and only upon failure
	// do the reads/writes then check pconn (after acquiring mu) to see if
	// there's been a rebind meanwhile.
	pconnAtomic atomic.Pointer[nettype.PacketConn]

	mu    syncs.Mutex // held while changing pconn (and pconnAtomic)
	pconn nettype.PacketConn
	port  uint16
}
```

```go title="wgengine/magicsock/rebinding_conn.go"
func (c *RebindingUDPConn) readFromWithInitPconn(pconn nettype.PacketConn, b []byte) (int, netip.AddrPort, error) {
	for {
		n, addr, err := pconn.ReadFromUDPAddrPort(b)
		if err != nil && pconn != c.currentConn() {
			pconn = *c.pconnAtomic.Load()
			continue
		}
		return n, addr, err
	}
}
```

[`rebinding_conn.go#L23-L68`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/rebinding_conn.go#L23-L68)。

**読み書きの通常経路ではロックを取らない。** atomic ポインタから現在のソケットを取って使う。

**エラーが返ってきたときだけ、「これは再バインドのせいか」を確認する。** 差し替えられていたら新しいソケットで再試行する。差し替えられていなければ本物のエラーとして返す。

これは **「失敗したときだけ高いコストを払う」** 設計だ。再バインドは数時間に 1 回、読み書きは毎秒数千回。頻度の差がそのまま構造に出ている。

### エンドポイントを少し長く覚える

```go title="wgengine/magicsock/endpoint_tracker.go"
const (
	// endpointTrackerLifetime is how long we continue advertising an
	// endpoint after we last see it. This is intentionally chosen to be
	// slightly longer than a full netcheck period.
	endpointTrackerLifetime = 5*time.Minute + 10*time.Second

	// endpointTrackerMaxPerAddr is how many cached addresses we track for
	// a given netip.Addr. This allows e.g. restricting the number of STUN
	// endpoints we cache (which usually have the same netip.Addr but
	// different ports).
	//
	// The value of 6 is chosen because we can advertise up to 3 endpoints
	// based on the STUN IP:
	//    1. The STUN endpoint itself (EndpointSTUN)
	//    2. The STUN IP with the local Tailscale port (EndpointSTUN4LocalPort)
	//    3. The STUN IP with a portmapped port (EndpointPortmapped)
	//
	// Storing 6 endpoints in the cache means we can store up to 2 previous
	// sets of endpoints.
	endpointTrackerMaxPerAddr = 6
)
```

[`endpoint_tracker.go#L18-L37`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint_tracker.go#L18-L37)。

**2 つの定数、どちらも導出が書かれている。**

`5 分 10 秒` は「netcheck の周期より少しだけ長く」。周期ぴったりだと、測定のタイミングのゆらぎでエンドポイントが消えたり出たりする。

`6` は「1 つの IP につき最大 3 種類のエンドポイントを広告するので、2 世代ぶん保持できる」。**「なぜ 6 か」に「3 × 2」と答えられる。**

保持には期限つきのヒープを使う。

```go title="wgengine/magicsock/endpoint_tracker.go"
// endpointHeap is an ordered heap of endpointTrackerEntry structs, ordered in
// ascending order by the 'until' expiry time (i.e. oldest first).
type endpointHeap []*endpointTrackerEntry
```

[`endpoint_tracker.go#L51-L53`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint_tracker.go#L51-L53)。

**期限が近い順に取り出せるので、失効の処理が O(log n) で済む。** マップを全走査して期限切れを探す必要がない。

## なぜそうなっているか

### なぜ「何が変わったか」を OS から受け取らないのか

OS の通知メッセージは、OS ごとに粒度も内容も違う。Linux の netlink は詳細な情報を持つが、Windows のコールバックは「何かが変わった」しか言わない。

**最小公倍数ではなく最大公約数を取る。** 「変化があった」だけを共通のインターフェースにし、詳細は変化後に自分で状態を読み直して差分を取る。

コストは、変化のたびに全インターフェースを列挙すること。だが変化は数時間に数回なので問題にならない。**OS ごとの差分解析コードを 3 つ書いて維持するより、はるかに安い。**

### なぜ「処理してから待つ」なのか

「待ってから処理」だと、単発の変化にも必ず遅延が入る。Wi-Fi に繋がった瞬間に反応してほしいのに、1 秒待つ。

「処理してから待つ」なら、**最初の変化には即座に反応する**。連続する変化は、待っているあいだに溜まり、次のループで 1 回にまとまる。

**デバウンスの目的は「遅らせること」ではなく「回数を減らすこと」だ。** 目的を正しく捉えると、この順序になる。

### なぜ保守的な判定にするのか

再バインドのコストは、UDP ソケットを作り直して STUN を打ち直すこと。数百 ms かかり、その間のパケットが少し落ちる。

再バインドしなかった場合のコストは、**通信が完全に止まる**。しかも自動では回復しない (ソケットが古いインターフェースに紐づいたままになる)。

**非対称なので、迷ったら再バインドする。** コメントが「非常に保守的な見積もり」と明言しているのは、この判断を意図的にしたという表明だ。

### なぜエンドポイントを消さずに覚えておくのか

エンドポイントの広告が消えると、**相手はそのアドレスへの ping をやめる**。次の netcheck でまた見つかったら、また広告して、相手がまた ping し始める。この往復に数十秒かかる。

一時的に STUN の応答が得られなかっただけなら、**エンドポイントはまだ生きている**。少し長めに保持して広告し続けるほうが、経路が切れない。

`5 分 10 秒` という「周期より少しだけ長い」値は、**周期的な処理と失効の相互作用**を意識した設計だ。周期と同じにすると、測定が数秒遅れただけで失効する。

### なぜ atomic ポインタで差し替えるのか

読み書きのたびにミューテックスを取ると、**すべてのパケットがロックを通る**。秒間数万パケットでは無視できない。

再バインドは稀なので、**「読み手はロックなし、書き手だけロック」** が自然な形になる。Go の `atomic.Pointer` はこの用途にちょうど合う。

そして「読み手が古いポインタを持っていたらどうするか」の答えが、**「エラーが出たときだけ確認する」**。正常に読めている限り、古いソケットでも問題ない (まだ開いているので)。閉じられてエラーになったときに初めて、新しいものを取り直す。

## どう活かすか

**OS 依存の通知は「何かが変わった」だけを共通化し、詳細は自分で状態を取り直す。** OS ごとの差分解析を書くと、OS の数だけバグが増える。状態の取得が十分に安ければ、毎回全部読んで差分を取るほうが単純で正しい。

**デバウンスは「処理してから待つ」。** 目的が回数の削減なら、最初のイベントを遅らせる理由はない。「待ってから処理」は、目的が「最終状態だけ知りたい」場合に限る。

**総合判定と個別判定の両方を公開する。** 保守的な既定値で大半の利用者を助けつつ、細かく制御したい利用者には材料を渡す。そして **「この判定は保守的だ」とドキュメントに書く** と、誤解が減る。

**間接的な証拠から、見えていない変化を推測する。** 「10 分以上の時刻ジャンプ = NAT のマッピングは死んでいる」は、直接観測できない外の世界の状態を、観測できる値から導いている。分散システムやモバイル環境では、この種の推論が必要になる。

**判定を OR で束ねたら、どの条件が真だったかをログに出す。** 束ねた結果だけでは調査できない。条件が 7 個あるなら、7 個のうちどれが効いたかを文字列にする。

**周期処理と失効期限を組み合わせるときは、期限を周期より少し長くする。** ぴったり同じだと、実行の揺らぎで境界を跨いで振動する。「少しだけ長い」の理由をコメントに書く。

**読みが支配的で書きが稀なリソースは、atomic ポインタで差し替える。** そして「読み手が古い参照を持っていた場合」の扱いを決める。多くの場合「エラーが出たときだけ確認して再試行」で足りる。
