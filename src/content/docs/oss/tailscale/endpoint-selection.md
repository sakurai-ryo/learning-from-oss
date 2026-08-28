---
title: "候補パスを全部保持し、最良経路を選び続ける"
description: "wireguard-go は 1 ピアに 1 エンドポイントしか持てない。Tailscale はその下で候補アドレスを全部抱え、3 秒ごとに ping を打ち、6.5 秒だけ「この経路は信用できる」と見なす。どちらが良い経路かはポイント制で決まり、loopback には 50 点、IPv6 には 10 点が加算される。"
group: "NAT 越え"
sidebar:
  order: 13
---

## 何を学んだか

### 1 対 1 と 1 対 N の橋渡し

wireguard-go の世界では、**1 つのピアには 1 つのエンドポイント**しかない。`conn.Endpoint` インターフェースは「このピアに送るときの宛先」を表す。

Tailscale の世界では、**1 つのピアに候補アドレスが何個もある**。相手が申告した LAN のアドレス、STUN で見えた外側のアドレス、ポートマッピングで開けたアドレス、そして DERP。

`magicsock` の `endpoint` 型がこの差を吸収する。wireguard-go からは 1 個のエンドポイントに見えるが、中では候補の集合を管理し、送信のたびに「今の最良」を選ぶ。

### 時間で区切られた信頼

最良経路 (`bestAddr`) には **信頼期限** (`trustBestAddrUntil`) が付く。期限は **6.5 秒**。

- 期限内: その UDP アドレスにだけ送る
- 期限切れ: **UDP アドレスと DERP の両方に送る**

つまり「この経路が通ることを最後に確認してから 6.5 秒以上経ったら、DERP にも保険をかける」。相手が移動していても、パケットは DERP 経由で届く。

### 3 秒ごとのハートビート、45 秒でやめる

経路を維持するため、3 秒ごとに `Ping` を打つ。NAT のマッピングは何も流れないと消えるので、定期的に通す必要がある。

ただし **45 秒間アプリケーションのトラフィックがなければ、ハートビートを止める**。アイドルなピアに永久に ping を打ち続けると、大きな tailnet で無駄が積み上がる。

### より良い経路を探し続ける

一度直結できても、もっと良い経路があるかもしれない (LAN 経由、IPv6 直結)。だから **60 秒ごとに全候補へ ping を打ち直す**。

ただし **現在の経路の遅延が 5 ms 以下なら、探索しない**。LAN 内で既に十分速いなら、それ以上良くなる余地がない。

### どちらが良い経路かはポイントで決める

`betterAddr` が比較関数だ。遅延の比率をベースに、アドレスの性質でボーナスを加える。

| 条件                     | 加点   |
| ------------------------ | ------ |
| 遅い側に対する速さの割合 | 0〜100 |
| loopback アドレス        | +50    |
| リンクローカル           | +30    |
| プライベート IP          | +20    |
| IPv6                     | +10    |

そして **1% 未満の改善では乗り換えない**。

## ソースコードのどこか

### endpoint 型の役割

```go title="wgengine/magicsock/endpoint.go"
// endpoint is a wireguard/conn.Endpoint. In wireguard-go and kernel WireGuard
// there is only one endpoint for a peer, but in Tailscale we distribute a
// number of possible endpoints for a peer which would include the all the
// likely addresses at which a peer may be reachable. This endpoint type holds
// the information required that when wireguard-go wants to send to a
// particular peer (essentially represented by this endpoint type), the send
// function can use the currently best known Tailscale endpoint to send packets
// to the peer.
type endpoint struct {
```

[`endpoint.go#L48-L57`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L48-L57)。

**「wireguard-go とカーネル WireGuard では 1 ピアに 1 エンドポイントだが、Tailscale では複数配る」** — この 1 文が `magicsock` の存在理由そのものだ。

構造体の中身を見ると、状態の多さが分かる。

```go title="wgengine/magicsock/endpoint.go"
	fakeWGAddr   netip.AddrPort // the UDP address we tell wireguard-go we're using
	...
	heartBeatTimer            *time.Timer    // nil when idle
	lastSendExt               mono.Time      // last time there were outgoing packets sent to this peer from an external trigger
	lastSendAny               mono.Time      // last time there were outgoing packets sent this peer from any trigger
	lastFullPing              mono.Time      // last time we pinged all disco or wireguard only endpoints
	lastUDPRelayPathDiscovery mono.Time
	derpAddr                  netip.AddrPort // fallback/bootstrap path

	bestAddr           addrQuality // best non-DERP path; zero if none
	bestAddrAt         mono.Time   // time best address re-confirmed
	trustBestAddrUntil mono.Time   // time when bestAddr expires
	sentPing           map[stun.TxID]sentPing
	endpointState      map[netip.AddrPort]*endpointState
	isCallMeMaybeEP    map[netip.AddrPort]bool
```

[`endpoint.go#L57-L101`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L57-L101)。

**`fakeWGAddr` が橋渡しの要だ。** wireguard-go には偽の UDP アドレスを教えておき、実際の宛先は `magicsock` が決める。wireguard-go 側のログやレート制限はこのアドレスで動く。

**時刻のフィールドが 6 個ある。** 「外部からの送信」「あらゆる送信」「全候補への ping」「relay の探索」…。それぞれ別のタイマーの判断材料になる。

### タイミングの定数

```go title="wgengine/magicsock/magicsock.go"
const (
	// sessionActiveTimeout is how long since the last activity we
	// try to keep an established endpoint peering alive.
	// It's also the idle time at which we stop doing STUN queries to
	// keep NAT mappings alive.
	sessionActiveTimeout = 45 * time.Second

	// upgradeUDPDirectInterval is how often we try to upgrade to a better,
	// direct UDP path even if we have some direct UDP path that works.
	upgradeUDPDirectInterval = 1 * time.Minute
	...
	// heartbeatInterval is how often pings to the best UDP address
	// are sent.
	heartbeatInterval = 3 * time.Second

	// trustUDPAddrDuration is how long we trust a UDP address as the exclusive
	// path (without using DERP) without having heard a Pong reply.
	trustUDPAddrDuration = 6500 * time.Millisecond

	// goodEnoughLatency is the latency at or under which we don't
	// try to upgrade to a better path.
	goodEnoughLatency = 5 * time.Millisecond

	// endpointsFreshEnoughDuration is how long we consider a
	// STUN-derived endpoint valid for. UDP NAT mappings typically
	// expire at 30 seconds, so this is a few seconds shy of that.
	endpointsFreshEnoughDuration = 27 * time.Second
)
```

[`magicsock.go#L4021-L4056`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L4021-L4056)。

**`trustUDPAddrDuration` が 6500 ms なのは、ハートビート 3 秒の 2 回ぶんに 500 ms の余裕を足した値だ。** ping を 2 回連続で落としたら信頼を失う、という設計になっている。

**`endpointsFreshEnoughDuration` が 27 秒なのは「NAT のマッピングはたいてい 30 秒で切れるから、数秒手前」。** 定数の値が、外部の制約 (NAT の実装) から逆算されている。

### 送信先の決定

```go title="wgengine/magicsock/endpoint.go"
func (de *endpoint) addrForSendLocked(now mono.Time) (udpAddr epAddr, derpAddr netip.AddrPort, sendWGPing bool) {
	udpAddr = de.bestAddr.epAddr

	if udpAddr.ap.IsValid() && !now.After(de.trustBestAddrUntil) {
		return udpAddr, netip.AddrPort{}, false
	}
	...
	// We had a bestAddr but it expired so send both to it
	// and DERP.
	return udpAddr, de.derpAddr, false
}
```

[`endpoint.go#L618-L635`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L618-L635)。

**信頼期限が切れたら、UDP と DERP の両方に同じパケットを送る。** 帯域は倍になるが、片方が届けば通信は続く。相手が受け取ると重複するが、WireGuard はリプレイ保護のウィンドウで重複を捨てる。

**「どちらが届くか分からないなら両方に送る」** という単純な冗長化が、経路切り替えの瞬間のパケットロスを防いでいる。

### ハートビート

```go title="wgengine/magicsock/endpoint.go"
// heartbeat is called every heartbeatInterval to keep the best UDP path alive,
// kick off discovery of other paths, or schedule the probing of UDP path
// lifetime on the tail end of an active session.
func (de *endpoint) heartbeat() {
	...
	now := mono.Now()
	if now.Sub(de.lastSendExt) > sessionActiveTimeout {
		// Session's idle. Stop heartbeating.
		de.c.dlogf("[v1] magicsock: disco: ending heartbeats for idle session to %v (%v)", ...)
		...
		return
	}

	udpAddr, _, _ := de.addrForSendLocked(now)
	if udpAddr.ap.IsValid() {
		// We have a preferred path. Ping that every 'heartbeatInterval'.
		de.startDiscoPingLocked(udpAddr, now, pingHeartbeat, 0, nil)
	}

	if de.wantFullPingLocked(now) {
		de.sendDiscoPingsLocked(now, true)
	}

	if de.wantUDPRelayPathDiscoveryLocked(now) {
		de.discoverUDPRelayPathsLocked(now)
	}

	de.heartBeatTimer = time.AfterFunc(heartbeatInterval, de.heartbeat)
}
```

[`endpoint.go#L852-L920`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L852)。

**タイマーは `AfterFunc` で毎回貼り直す。** `Ticker` を使わないのは、アイドルになったらタイマーごと消したいからだ (`de.heartBeatTimer = nil` で終わる)。ピアが数千いる環境で、動いていない Ticker が数千個残るのを避けている。

wireguard-go のキープアライブに関する長いコメントも入っている。

> wireguard-go は認証済みデータパケットを受け取った 10 秒後にキープアライブをスケジュールする。WireGuard の状態機械の都合で、片側だけが送るのが普通だ。だから **こちらが受信側なら、`lastSendExt` は動かない**。

**下位ライブラリの挙動が、上位のアイドル判定を狂わせる** という話で、だから `lastSendAny` と `lastRecvUDPAny` を別に見る。

### 探索を続けるか

```go title="wgengine/magicsock/endpoint.go"
func (de *endpoint) wantFullPingLocked(now mono.Time) bool {
	if runtime.GOOS == "js" {
		return false
	}
	if !de.bestAddr.isDirect() || de.lastFullPing.IsZero() {
		return true
	}
	if now.After(de.trustBestAddrUntil) {
		return true
	}
	if de.bestAddr.latency <= goodEnoughLatency {
		return false
	}
	if now.Sub(de.lastFullPing) >= upgradeUDPDirectInterval {
		return true
	}
	return false
}
```

[`endpoint.go#L981-L998`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L981-L998)。

**5 つの条件が、優先順位の順に並んでいる。**

1. まだ直結できていない、または一度も全体 ping をしていない → 探す
2. 現在の経路の信頼が切れた → 探す
3. 十分速い (5 ms 以下) → **探さない**
4. 前回の全体 ping から 60 秒経った → 探す
5. それ以外 → 探さない

**「十分速いなら探さない」が 3 番目にあるのが要点だ。** 信頼が切れているときは、速かろうが探す。順序が意味を持っている。

### どちらの経路が良いか

```go title="wgengine/magicsock/endpoint.go"
	// Each address starts with a set of points (from 0 to 100) that
	// represents how much faster they are than the highest-latency
	// endpoint. For example, if a has latency 200ms and b has latency
	// 190ms, then a starts with 0 points and b starts with 5 points since
	// it's 5% faster.
	var aPoints, bPoints int
	if a.latency > b.latency && a.latency > 0 {
		bPoints = int(100 - ((b.latency * 100) / a.latency))
	} else if b.latency > 0 {
		aPoints = int(100 - ((a.latency * 100) / b.latency))
	}

	// Prefer private IPs over public IPs as long as the latencies are
	// roughly equivalent, since it's less likely that a user will have to
	// pay for the bandwidth in a cloud environment.
	//
	// Additionally, prefer any loopback address strongly over non-loopback
	// addresses, and prefer link-local unicast addresses over other types
	// of private IP addresses since it's definitionally more likely that
	// they'll be on the same network segment than a general private IP.
	if a.ap.Addr().IsLoopback() {
		aPoints += 50
	} else if a.ap.Addr().IsLinkLocalUnicast() {
		aPoints += 30
	} else if a.ap.Addr().IsPrivate() {
		aPoints += 20
	}
	...
	// Prefer IPv6 for being a bit more robust, as long as
	// the latencies are roughly equivalent.
	if a.ap.Addr().Is6() {
		aPoints += 10
	}
	...
	// Don't change anything if the latency improvement is less than 1%; we
	// want a bit of "stickiness" (a.k.a. hysteresis) to avoid flapping if
	// there's two roughly-equivalent endpoints.
	if aPoints <= 1 && bPoints == 0 {
		return false
	}

	return aPoints > bPoints
}
```

[`endpoint.go#L1969-L2025`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L1969)。

**遅延という連続量と、アドレス種別という離散量を、1 つのスカラーに合成している。**

各ボーナスに理由が書いてある。

- **プライベート IP を +20**: クラウド環境で、パブリック IP 経由の帯域には課金される可能性がある。**金銭的コストが経路選択の理由として書かれている。**
- **loopback を +50**: 同じマシン内なので圧倒的に良い
- **リンクローカルを +30**: 「定義上、同じネットワークセグメントにいる可能性が高い」
- **IPv6 を +10**: 「少し堅牢だから」(NAT を経由しないことが多い)

そして最後にヒステリシス。**1% 未満の改善では変えない。** [netcheck の DERP 選択](../netcheck/) と同じ思想が、経路選択にも入っている。

前段では別の優先順位も効いている。

```go title="wgengine/magicsock/endpoint.go"
	// Geneve-encapsulated paths (UDP relay servers) are lower preference in
	// relation to non.
	if !a.vni.IsSet() && b.vni.IsSet() {
		return true
	}
```

[`endpoint.go#L1960-L1967`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L1960)。

**[peer relay](../peer-relay/) 経由の経路は、どれだけ速くても直結に劣後する。** ポイント制ではなく、その手前の絶対的な条件として書かれている。

## なぜそうなっているか

### なぜ信頼に期限を付けるのか

UDP には接続という概念がない。「この経路がまだ生きているか」を知る方法は、**送って返事が来るかを試すことしかない**。

「返事が来なくなったら切り替える」だと、切り替わるまでのあいだパケットが消える。「常に DERP にも送る」だと帯域が倍かかる。

**期限を切って、期限内は直結だけ、切れたら両方** にすると、平常時のコストがゼロで、異常時の切り替えが自動になる。しかも「期限」は ping の応答があるたびに延びるので、**通信が続いている限り期限切れにならない**。

6.5 秒という値は「ping 2 回ぶん + 余裕」で、**ping が 2 回連続で落ちる確率** を許容ラインにしている。

### なぜアイドルでハートビートを止めるのか

ハートビートの目的は NAT のマッピングを維持することだ。だが **使っていない経路のマッピングを維持する意味はない**。

100 ノードの tailnet で全ピアに 3 秒ごとに ping を打つと、毎秒 33 パケット。1,000 ノードなら 333 パケット。モバイル端末ではバッテリーに響き、バックグラウンドで動くことすら OS に止められる。

**「通信していないなら経路も維持しない。必要になったら作り直す」** という判断だ。作り直しには数百 ms かかるが、45 秒以上使っていない相手なら許容できる。

### なぜ「十分速い」で探索をやめるのか

経路探索は全候補にパケットを撒く。候補が 10 個あれば 10 パケット。60 秒ごとに全ピアに対してこれをやると、無視できない量になる。

**5 ms 以下なら、それは同じ LAN か同じデータセンターだ。** それ以上速くなる経路は物理的に存在しない (loopback を除く)。探しても見つからないと分かっているものを探すのは無駄になる。

**「最適化の余地がないことを判定して打ち切る」** のは、継続的に最適化を回すシステムでは必須の要素だ。

### なぜポイント制なのか

「遅延が最小のものを選ぶ」だけでは足りない理由がいくつかある。

- **遅延の測定には誤差がある。** 1 回の ping で 2 ms と 2.1 ms を区別しても意味がない
- **遅延以外に優先したい性質がある。** クラウドの課金、NAT を経由しない堅牢さ
- **それらを「絶対に優先」にすると、極端な結果になる。** 「プライベート IP を必ず優先」だと、遅延 500 ms の VPN 経由の経路が、遅延 5 ms のパブリック経路に勝ってしまう

**ポイント制なら「遅延が同程度なら性質で決める、遅延が大きく違うなら遅延で決める」が 1 つの式で表せる。** loopback の +50 は「50% 遅くても loopback を選ぶ」という意味になり、直感とも合う。

ただし数値の根拠は経験則だ。「なぜ 20 で 30 で 50 なのか」はコメントに書かれていない。**書けるのは「なぜその順序か」までで、具体的な値は運用で調整するしかない。**

### なぜ relay 経路を絶対に劣後させるのか

peer relay は他人のノードに中継してもらう経路だ。**中継してくれているノードのリソースを使う**。

直結できるのに中継を選ぶと、他人に負担をかける。たとえ中継のほうが 1 ms 速くても、直結を選ぶべきだ。**「自分にとっての最適」ではなく「システム全体にとっての妥当」を優先する判断** で、これはポイントに変換できない。だから比較の前段に絶対的な条件として置かれている。

## どう活かすか

**下位ライブラリの「1 つしか持てない」制約は、上位で候補集合を持って吸収できる。** 差し替えのタイミングを自分で制御でき、下位には常に 1 個だけ見せる。DNS の複数 A レコード、接続プールのエンドポイント選択、フェイルオーバーするデータベース接続。同じ形が使える。

**「この情報を信頼する期限」を明示的に持つと、劣化が自動になる。** 期限内は速い経路だけ、期限切れは冗長化。期限は成功のたびに延びる。これは「異常を検知してから対処する」より単純で、検知漏れがない。期限の長さは「何回連続で失敗したら疑うか」から逆算する。

**定期的な最適化には、必ず「これ以上良くならない」の判定を入れる。** 判定がないと、最適な状態でも探索コストを払い続ける。判定の基準は「理論的な下限」に近い値にする。

**連続量と離散的な選好を混ぜて順位を決めるなら、ポイント制が扱いやすい。** 「A のほうが 50% 速いが、B はプライベート IP」を 1 つの式で比較できる。ボーナスの値は「何 % の劣化まで許容するか」として解釈でき、レビューしやすい。

**ポイントに変換してはいけない条件は、比較の前段に置く。** 「他人のリソースを使う経路は最後」のような制約は、どんな性能差でも覆ってはいけない。数値化すると必ず覆る。

**タイマーは `Ticker` ではなく毎回貼り直す `AfterFunc` にすると、止めたいときに止められる。** 対象が数千個ある場合、動いていない Ticker が残り続けるのを避けられる。
