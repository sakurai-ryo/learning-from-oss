---
title: "自分がどんなネットワークにいるのかを測る"
description: "STUN で外から見た自分のアドレスを知り、NAT の種類を推定し、DERP サーバまでの往復時間を測る。全部で 5 秒の予算を、STUN に 3 秒・ICMP に 1 秒と切り分ける。そして「一番速い DERP」に素直に乗り換えると経路が揺れるので、10 ms 差か 3 分の 2 の比率かで居座る条件を決めている。"
group: "NAT 越え"
sidebar:
  order: 10
---

## 何を学んだか

### 経路探索の前に、自分の位置を知る

ピアと直結するには、まず **自分が外からどう見えているか** を知る必要がある。`netcheck` はそれを 5 秒以内に測るパッケージだ。

測る項目は多い。

| 項目                    | 意味                                               |
| ----------------------- | -------------------------------------------------- |
| `UDP`                   | そもそも UDP が外に出られるか                      |
| `IPv4` / `IPv6`         | どちらで STUN が通ったか                           |
| `OSHasIPv6`             | OS が IPv6 を持っているか (`::1` に bind できるか) |
| `GlobalV4` / `GlobalV6` | 外から見た自分のアドレス                           |
| `MappingVariesByDestIP` | 宛先ごとに NAT のマッピングが変わるか              |
| `UPnP` / `PMP` / `PCP`  | ルータがポートマッピングを喋るか                   |
| `RegionLatency`         | 各 DERP リージョンまでの往復時間                   |
| `PreferredDERP`         | どの DERP を自分のホームにするか                   |
| `CaptivePortal`         | キャプティブポータルに捕まっているか               |
| `ICMPv4`                | ICMP が通るか                                      |

### 時間の予算を配る

全体で 5 秒。その内訳が定数として書かれている。

- STUN に 3 秒。返ってこなければ「UDP が塞がれている」と判断して HTTP のプローブに切り替える
- ICMP に 1 秒
- HTTPS には「STUN の後に残った時間」全部

**測定そのものにタイムアウトを持たせるのではなく、測定の種類ごとに予算を割り当てている。**

### 前回の結果を使ってプローブ計画を立てる

DERP サーバは世界中に数十リージョンある。全部に毎回プローブを打つのは無駄なので、**前回のレポートで速かった順に並べ、遅延を付けて送る**。最初のプローブは即座に、次は 100 ms 後に、というように。速い応答が返ってきた時点で残りは打ち切る。

### ホーム DERP は簡単には動かさない

一番速い DERP をそのままホームにすると、**測定のゆらぎでホームが行ったり来たりする**。ホームが変わると、そのノード経由の通信すべてに影響する。

そこで「乗り換える条件」に 2 つのしきい値がある。

- 差が **10 ms 未満** なら乗り換えない
- 新しい候補が古いホームの **3 分の 2 より速くない** なら乗り換えない

さらに「増分の netcheck では現在のホームを必ずプローブ対象に含める」という修正が、issue 番号付きで入っている。

## ソースコードのどこか

### 時間の予算

```go title="net/netcheck/netcheck.go"
// The various default timeouts for things.
const (
	// ReportTimeout is the maximum amount of time netcheck will
	// spend gathering a single report.
	ReportTimeout = 5 * time.Second
	// stunTimeout is the maximum amount of time netcheck will spend
	// probing with STUN packets without getting a reply before
	// switching to HTTP probing, on the assumption that outbound UDP
	// is blocked.
	stunProbeTimeout = 3 * time.Second
	// icmpProbeTimeout is the maximum amount of time netcheck will spend
	// probing with ICMP packets.
	icmpProbeTimeout = 1 * time.Second
	// httpsProbeTimeout is the maximum amount of time netcheck will spend
	// probing over HTTPS. This is set equal to ReportTimeout to allow HTTPS
	// whatever time is left following STUN, which precedes it in a netcheck
	// report.
	httpsProbeTimeout = ReportTimeout
	// defaultActiveRetransmitTime is the retransmit interval we use
	// for STUN probes when we're in steady state (not in start-up),
	// but don't have previous latency information for a DERP
	// node. This is a somewhat conservative guess because if we have
	// no data, likely the DERP node is very far away and we have no
	// data because we timed out the last time we probed it.
	defaultActiveRetransmitTime = 200 * time.Millisecond
	// defaultInitialRetransmitTime is the retransmit interval used
	// when netcheck first runs. We have no past context to work with,
	// and we want answers relatively quickly, so it's biased slightly
	// more aggressive than defaultActiveRetransmitTime. A few extra
	// packets at startup is fine.
	defaultInitialRetransmitTime = 100 * time.Millisecond
)
```

[`netcheck.go#L57-L88`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L57-L88)。

**定数 6 個すべてに、なぜその値かのコメントが付いている。**

とくに再送間隔の 2 つが対になっているのがよい。「起動時は過去のデータがないので、少し攻めて 100 ms。定常状態でデータがない相手は、たぶん遠くて前回タイムアウトしたので、控えめに 200 ms」。**「データがない」という同じ状態が、文脈によって違う意味を持つ** ことを読み取って値を変えている。

### 何を測るか

```go title="net/netcheck/netcheck.go"
type Report struct {
	Now         time.Time // the time the report was run
	UDP         bool      // a UDP STUN round trip completed
	IPv6        bool      // an IPv6 STUN round trip completed
	IPv4        bool      // an IPv4 STUN round trip completed
	IPv6CanSend bool      // an IPv6 packet was able to be sent
	IPv4CanSend bool      // an IPv4 packet was able to be sent
	OSHasIPv6   bool      // could bind a socket to ::1
	ICMPv4      bool      // an ICMPv4 round trip completed

	// MappingVariesByDestIP is whether STUN results depend which
	// STUN server you're talking to (on IPv4).
	MappingVariesByDestIP opt.Bool
	...
	PreferredDERP   tailcfg.DERPRegionID // or 0 for unknown
	RegionLatency   RegionLatency        // keyed by DERP Region ID
	...
	GlobalV4Counters map[netip.AddrPort]int // number of times the endpoint was observed
```

[`netcheck.go#L91-L131`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L91-L131)。

**`IPv6` と `IPv6CanSend` が別のフィールド**なのに注目したい。前者は「往復が完了した」、後者は「送信はできた」。送れたが返ってこないなら、経路のどこかで落とされている。**同じ「IPv6 が使えるか」という問いを、送信と往復の 2 段階に分けて記録する。**

`MappingVariesByDestIP` が **NAT の種類の判定** だ。2 つの異なる STUN サーバに問い合わせて、返ってきた「あなたのアドレス」が同じなら Endpoint-Independent Mapping (いわゆる cone NAT)、違うなら Address-Dependent Mapping (hard NAT) になる。後者だと、STUN で分かったアドレスをピアに教えても意味がない。ピアから送ると別のマッピングになるからだ。

`opt.Bool` は 3 値 (true / false / 未測定) を持つ型だ。**「測っていない」と「false」を区別する** ために使われている。

### 変な NAT への対処

```go title="net/netcheck/netcheck.go"
	// Add any other entries for which we have multiple observations.
	// This covers a case of bad NATs that start to provide new mappings for new
	// STUN sessions mid-expiration, even while a live mapping for the best
	// latency endpoint still exists. This has been observed on some Palo Alto
	// Networks firewalls, wherein new traffic to the old endpoint will not
	// succeed, but new traffic to the newly discovered endpoints does succeed.
	for ipp, count := range r.GlobalV4Counters {
```

[`netcheck.go#L145-L151`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L145)。

**特定ベンダのファイアウォールの挙動が、コメントとして残っている。** 「マッピングの有効期限の途中から、新しい STUN セッションには新しいマッピングを返し始める。古いエンドポイントへの新規トラフィックは通らないが、新しく見つかったエンドポイントには通る」。

対策は「複数回観測されたエンドポイントも候補に入れる」だ。1 回だけ見えたものは hard NAT のノイズとして捨て、繰り返し見えたものは本物として扱う。

### プローブ計画

```go title="net/netcheck/netcheck.go"
type probe struct {
	// delay is when the probe is started, relative to the time
	// that GetReport is called. One probe in each probePlan
	// should have a delay of 0. Non-zero values are for retries
	// on UDP loss or timeout.
	delay time.Duration

	// node is the name of the node name. DERP node names are globally
	// unique so there's no region ID.
	node string
	proto probeProto
	wait time.Duration
}

// probePlan is a set of node probes to run.
//
// The values are logically an unordered set of tests to run concurrently.
// In practice there's some order to them based on their delay fields,
// but multiple probes can have the same delay time or be running concurrently
// both within and between sets.
//
// A set of probes is done once either one of the probes completes, or
// the next probe to run wouldn't yield any new information not
// already discovered by any previous probe in any set.
type probePlan map[string][]probe
```

[`netcheck.go#L376-L406`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L376-L406)。

**測定を「計画」というデータにしてから実行する。** 何をいつ打つかが `probePlan` という値として先に決まるので、テストで計画そのものを検証できる (実際 `netcheck_test.go` は 32 KB あり、計画の中身を突き合わせている)。

停止条件が「どれか 1 つ完了したら、または次のプローブが新しい情報を生まないなら」になっているのも特徴だ。**全部の結果を待たない。**

### ホームが揺れないようにする

```go title="net/netcheck/netcheck.go"
	// #13969 ensure that the home region is always probed.
	// If a netcheck has unstable latency, such as a user with large amounts of
	// bufferbloat or a highly congested connection, there are cases where a full
	// netcheck may observe a one-off high latency to the current home DERP. Prior
	// to the forced inclusion of the home DERP, this would result in an
	// incremental netcheck following such an event to cause a home DERP move, with
	// restoration back to the home DERP on the next full netcheck ~5 minutes later
	// - which is highly disruptive when it causes shifts in geo routed subnet
	// routers.
```

[`netcheck.go#L466-L474`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L466)。

**バグの再現条件と影響が全部書いてある。** bufferbloat のあるユーザーで一度だけ高い遅延が観測される → 増分 netcheck でホームが移動する → 5 分後の完全な netcheck で戻る → その往復が geo ルーティングされた subnet router の経路を揺らす。

「測定のゆらぎが、遠く離れたコンポーネントの挙動を揺らす」という因果の連鎖が、コメント 1 個に圧縮されている。

### 乗り換えのしきい値

```go title="net/netcheck/netcheck.go"
	if changingPreferred && oldRegionIsAccessible {
		// bestAny < any other value, so oldRegionCurLatency - bestAny >= 0
		if oldRegionCurLatency-bestAny < preferredDERPAbsoluteDiff {
			// The absolute value of latency difference is below
			// our minimum threshold.
			keepOld = true
		}
		if bestAny > oldRegionCurLatency/3*2 {
			// Old region is about the same on a percentage basis
			keepOld = true
		}
	}
```

[`netcheck.go#L1485-L1495`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L1485)。

`preferredDERPAbsoluteDiff` は 10 ms。

**絶対差と相対比の両方で判定する。** 遅延が 5 ms と 12 ms の比較では、比率だと 2 倍以上違うが、実用上どちらでもよい (絶対差 7 ms)。逆に 300 ms と 250 ms では、絶対差 50 ms は大きいが比率では 83% で誤差の範囲だ。**どちらか一方のしきい値だけでは、レンジの端で不適切な判断になる。**

「古いリージョンがまだ使えるか」の判定も丁寧だ。

```go title="net/netcheck/netcheck.go"
	// The old region is accessible if we've heard from it via a non-STUN
	// mechanism, or have a latency (and thus heard back via STUN).
	oldRegionIsAccessible := oldRegionCurLatency != 0 || heardFromOldRegionRecently
```

[`netcheck.go#L1482-L1484`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L1482)。

**STUN の応答だけでなく、実際の DERP トラフィックも「生きている証拠」として数える。** 測定用のプローブが落ちても、実データが流れていればそのリージョンは使える。

そして最後の砦がある。

```go title="net/netcheck/netcheck.go"
	// If there was no latency data to make judgements on, but there is an
	// active DERP connection that has at least been doing KeepAlive recently,
	// keep it, rather than dropping it.
	if r.PreferredDERP == 0 && prevRegionLastHeard.After(now.Add(-PreferredDERPKeepAliveTimeout)) {
		r.PreferredDERP = prevDERP
	}
```

[`netcheck.go#L1516-L1521`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L1516)。

**測定が全部失敗しても、今つながっている DERP があるならそれを使い続ける。** 「測れないから分からない」を「だからホームなし」にしない。

## なぜそうなっているか

### なぜ測定を「計画」というデータにするのか

ネットワーク測定のコードは、素直に書くと goroutine とタイマーとチャネルの絡み合いになる。テストしようとすると、実際に時間を進めるか、複雑なモックが要る。

**「何をいつ打つか」を先に値として計算しておくと、そこがテスト可能な純粋関数になる。** `makeProbePlan(derpMap, ifState, lastReport, preferredDERP)` は入力から出力を決めるだけの関数だ。「前回 IPv6 が使えたなら IPv6 のプローブを含む」「ホームリージョンは必ず含む」といった条件を、ネットワークなしで検証できる。

残る非決定性は「実行と結果の収集」だけになる。

### なぜ乗り換えに 2 種類のしきい値が要るのか

しきい値を 1 つにすると、必ずどこかのレンジで破綻する。

- **絶対差だけ (例: 10 ms)** — 遅延 500 ms と 480 ms の環境では、20 ms 差で乗り換えてしまう。どちらも遅く、実質同じなのに。
- **相対比だけ (例: 2/3)** — 遅延 3 ms と 5 ms では 60% なので乗り換える。実質同じなのに。

**どちらか一方でも「変えない」と言ったら変えない**、という OR 条件にすると、両端で妥当になる。ヒステリシスを入れる場面で覚えておく形だ。

### なぜホームの移動がそこまで嫌なのか

ホーム DERP は「自分に届かないパケットが集まる場所」だ。他のノードは、直結できない相手にはそのノードのホーム DERP へ送る。

ホームが変わると、

- 全ピアに netmap 経由で新しいホームを伝える必要がある
- 伝わるまでのあいだ、古いホームに送られたパケットは (両方に繋がっているので届くが) 遠回りする
- geo ベースでルーティングされている subnet router では、経路が地理的に変わる

**1 ノードの測定ゆらぎが、tailnet 全体の経路に波及する。** だからしきい値を厳しくし、測定に失敗しても現状維持を選ぶ。

### なぜ STUN が 3 秒で HTTP に切り替わるのか

UDP がまったく通らない環境 (企業ネットワーク、一部のモバイルキャリア) は現実に存在する。そこでは STUN の応答は永遠に来ない。

5 秒の予算のうち 3 秒を STUN に使い、返ってこなければ **「UDP は塞がれている」と結論して残りを HTTPS のプローブに回す**。HTTPS では外から見たアドレスは分からないが、**DERP サーバまでの遅延は測れる**。UDP が使えない環境では直結を諦めて DERP を使うしかないので、必要な情報は「どの DERP が近いか」だけになる。

**測定の目的が状況によって変わる** — これが予算を段階的に切り替える設計の理由だ。

### なぜベンダ名がコメントに書かれているのか

「Palo Alto Networks のファイアウォールで観測された」という記述は、普通のコードコメントとしては具体的すぎるように見える。だが **この記述がないと、`GetGlobalAddrs` が複数のアドレスを返す理由が誰にも分からなくなる**。

「1 つでいいのでは」と思ったリファクタリング担当者が、この 10 行を消す。そして特定の環境でだけ直結できなくなる。**再現条件が限定的なバグへの対処は、再現条件をコメントに書かないと必ず消される。**

## どう活かすか

**測定コードは「計画」と「実行」に分ける。** 何をいつ試すかを先に値として計算すれば、そこがテストできる純粋関数になる。ネットワーク、ディスク、外部 API を叩く測定はどれも同じ構造にできる。

**時間の予算を、種類ごとに配る。** 「全体で 5 秒」だけを決めて各処理にタイムアウトを付けないと、遅い 1 つが全部を食う。逆に各処理に固定のタイムアウトを付けると、合計が予算を超える。**上限と内訳の両方を定数として書き、それぞれに理由をコメントする。**

**「測っていない」と「false」は別の値にする。** 3 値の型 (`opt.Bool`、`*bool`、enum) を使う。ゼロ値が「偽」と「未測定」を兼ねると、「測ったが使えなかった」のか「測っていない」のかが後から分からなくなる。

**ヒステリシスは絶対差と相対比の両方で判定する。** どちらか一方だけでは、値のレンジの端で必ず不適切になる。切り替えのコストが高いもの (経路、リーダー、キャッシュの配置) を選び直す場面すべてに使える。

**判断材料が全部なくなったときの既定値を決めておく。** netcheck は「測定が全部失敗したら、今つながっているものを使い続ける」を選んでいる。「情報がないので何もしない」は、しばしば「情報がないので壊す」になる。

**再現条件が限定的な workaround には、再現条件を書く。** 特定ベンダ、特定バージョン、特定の設定。書かないと、後から見た人には無意味なコードにしか見えず、消される。
