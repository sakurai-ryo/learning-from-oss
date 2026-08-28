---
title: "subnet router と exit node は、同じ仕組みの別設定"
description: "「このサブネットへ行けます」と広告するのが subnet router、「0.0.0.0/0 へ行けます」と広告するのが exit node。実装は同じ経路広告で、違いは範囲だけだ。ただし exit node を使う側では、経路が欠けたときに「機能を諦めてでも漏らさない」ためのブラックホール経路が入る。"
group: "OS 統合とルーティング"
sidebar:
  order: 28
---

## 何を学んだか

### 同じ仕組み、違う範囲

Tailscale のノードは「自分はこの IP 範囲へ到達できます」と広告できる。

- **`192.168.1.0/24` を広告** → subnet router。オフィスの LAN に tailnet からアクセスできる
- **`0.0.0.0/0` と `::/0` を広告** → exit node。全インターネットトラフィックをそのノード経由にできる

**実装上の違いはほぼない。** どちらも `AdvertiseRoutes` に入る経路で、[netmap](../netmap/) の `AllowedIPs` として配られる。

使う側の設定も、

- `RouteAll` — subnet route を受け入れるか
- `ExitNodeID` / `ExitNodeIP` — どのノードを exit node にするか

### 経路が欠けたときに漏らさない

exit node を選んだのに、control server が `0.0.0.0/0` の経路を配ってこなかったとする。すると **トラフィックは通常の経路 (= 直接インターネット) に出てしまう**。ユーザーは「exit node を通っている」と思っているのに。

そこで **クライアント側で、足りないデフォルトルートを補う**。コメントが判断を明記している。

> これはいくつかの機能を壊す可能性が高いが、**ユーザーがリモート経由を選好した以上、機能を犠牲にしてでもトラフィックの漏洩を避けたい。**

### LAN へのアクセスは別に穴を開ける

exit node を使うと、`0.0.0.0/0` が Tailscale に向く。**同じ LAN 上のプリンタや NAS にもアクセスできなくなる。**

そこで `ExitNodeAllowLANAccess` という設定がある。有効なら、ローカルネットワークの範囲を `LocalRoutes` (Tailscale を通さない経路) に入れる。

**無効の場合は、逆にローカルネットワークの範囲を `Routes` (Tailscale へ向ける経路) に入れる。** 明示的に Tailscale 側へ吸わせることで、**「たまたま直接届いてしまう」を防ぐ**。

### 転送の設定が正しいかを監視する

subnet router として動くには、OS の IP forwarding が有効でなければならない。Tailscale はこれを **定期的に確認し、壊れていれば control server に報告する**。

## ソースコードのどこか

### アドレス範囲の定義

```go title="net/tsaddr/tsaddr.go"
// ChromeOSVMRange returns the subset of the CGNAT IPv4 range used by
// ChromeOS to interconnect the host OS to containers and VMs. We
// avoid allocating Tailscale IPs from it, to avoid conflicts.
func ChromeOSVMRange() netip.Prefix {
	chromeOSRange.Do(func() { mustPrefix(&chromeOSRange.v, "100.115.92.0/23") })
	return chromeOSRange.v
}

// CGNATRange returns the Carrier Grade NAT address range that
// is the superset range that Tailscale assigns out of.
// Note that Tailscale does not assign out of the ChromeOSVMRange.
func CGNATRange() netip.Prefix {
	cgnatRange.Do(func() { mustPrefix(&cgnatRange.v, "100.64.0.0/10") })
	return cgnatRange.v
}
```

[`tsaddr.go#L20-L37`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tsaddr/tsaddr.go#L20-L37)。

**`100.64.0.0/10` は CGNAT (Carrier-Grade NAT) 用に予約された範囲** で、ISP が内部で使うものだ。プライベート IP (`10.0.0.0/8` など) と違い、**エンドユーザーの LAN で使われることがほとんどない**。だから衝突しにくい。

そして **ChromeOS がその中の `100.115.92.0/23` を使っている** ことを知っていて、そこは避ける。

```go title="net/tsaddr/tsaddr.go"
	return CGNATRange().Contains(ip) && !ChromeOSVMRange().Contains(ip)
```

[`tsaddr.go#L84`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tsaddr/tsaddr.go#L84)。

**「Tailscale の IP か」の判定に、除外範囲が入っている。** ChromeOS 上で Tailscale を動かしたとき、コンテナ用の IP を Tailscale のものと誤認しないためだ。

IPv6 側は `fd7a:115c:a1e0::/48` の ULA (Unique Local Address)。

### 経路の欠落を埋める

```go title="ipn/ipnlocal/local.go"
	// Sanity check: we expect the control server to program both a v4
	// and a v6 default route, if default routing is on. Fill in
	// blackhole routes appropriately if we're missing some. This is
	// likely to break some functionality, but if the user expressed a
	// preference for routing remotely, we want to avoid leaking
	// traffic at the expense of functionality.
	if buildfeatures.HasUseExitNode && (prefs.ExitNodeID() != "" || prefs.ExitNodeIP().IsValid()) {
		var default4, default6 bool
		for _, route := range rs.Routes {
			switch route {
			case tsaddr.AllIPv4():
				default4 = true
			case tsaddr.AllIPv6():
				default6 = true
			}
			...
		}
		if !default4 {
			rs.Routes = append(rs.Routes, tsaddr.AllIPv4())
		}
		if !default6 {
			rs.Routes = append(rs.Routes, tsaddr.AllIPv6())
		}
```

[`local.go#L6552-L6576`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L6552)。

**「機能を犠牲にしてでも漏洩を避ける」** という判断が、コメントで明示されている。

たとえば IPv6 の exit node がない場合。デフォルトルートを補わないと、**IPv6 のトラフィックだけが直接インターネットに出る**。ユーザーは気づかない。VPN を使う目的 (IP を隠す、経路を制御する) が半分達成されていない状態になる。

補えば IPv6 の通信は失敗する。ユーザーは気づく。**「静かに漏れる」より「うるさく壊れる」を選んでいる。**

これは [フィルタ未設定なら drop](../packet-filter/) と同じフェイルクローズドの原則だ。

### LAN の扱い

```go title="ipn/ipnlocal/local.go"
		switch runtime.GOOS {
		case "linux", "windows", "darwin", "ios", "android", "openbsd":
			rs.LocalRoutes = internalIPs // unconditionally allow access to guest VM networks
			if prefs.ExitNodeAllowLANAccess() {
				rs.LocalRoutes = append(rs.LocalRoutes, externalIPs...)
			} else {
				// Explicitly add routes to the local network so that we do not
				// leak any traffic.
				rs.Routes = append(rs.Routes, externalIPs...)
			}
			b.logf("allowing exit node access to local IPs: %v", rs.LocalRoutes)
		default:
			if prefs.ExitNodeAllowLANAccess() {
				b.logf("warning: ExitNodeAllowLANAccess has no effect on " + runtime.GOOS)
			}
		}
```

[`local.go#L6581-L6595`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L6581)。

**`internalIPs` と `externalIPs` の扱いが違う。**

- `internalIPs` (ゲスト VM のネットワーク、ホスト内の仮想ブリッジ) — **無条件で Tailscale を通さない**。ここを Tailscale に向けると、同じマシン上の VM と通信できなくなる
- `externalIPs` (実際の LAN) — 設定次第

そして **設定が無効なときに「明示的に Tailscale へ向ける経路を足す」** のが要点だ。`0.0.0.0/0` が Tailscale を向いていても、**LAN のセグメントは「直接接続されている」ため、より具体的な経路が OS のルーティングテーブルに既にある**。それに勝つには、同じかより具体的な経路を Tailscale 側に入れる必要がある。

**「デフォルトルートを向けただけでは、LAN 宛のトラフィックは漏れる」** — ルーティングの最長一致原則からくる、見落としやすい穴だ。

サポートしていない OS では **警告をログに出す**。設定が黙って無視されるのを防ぐ。

### 転送の健全性を監視する

```go title="ipn/ipnlocal/local.go"
		if len(hi.RoutableIPs) > 0 && b.NetMon() != nil && !b.sys.IsNetstackRouter() {
			routes := hi.RoutableIPs
			netMon := b.NetMon()
			b.health.SetIPForwardingCheck(func() bool {
				warn, err := netutil.CheckIPForwarding(routes, netMon.InterfaceState())
				if err != nil {
					metricIPForwardingCheckError.Add(1)
					return false // don't want false positives
				}
				return warn != nil // true if broken
			})
		} else {
			b.health.SetIPForwardingCheck(nil)
		}
```

[`local.go#L6670-L6683`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L6670)。

**経路を広告しているときだけ、チェックを登録する。** 広告していなければ IP forwarding は不要なので、チェック自体を無効にする (`nil` を設定)。

**チェックがエラーになったら「壊れていない」と報告する。** コメントは「偽陽性が欲しくない」。**チェック自体が失敗したことを「問題あり」と扱うと、ユーザーに無意味な警告が出る。**

そして結果は [health tracker](../health/) 経由で警告になり、[long poll のデバッグフラグ](../map-longpoll/) `warn-ip-forwarding-off` として control server に届く。

```go title="ipn/ipnlocal/local.go"
	_, broken := state.Warnings["ip-forwarding-off"]
	b.mu.Lock()
	if b.cc != nil {
		b.cc.SetIPForwardingBroken(broken)
	}
```

[`local.go#L1249-L1253`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L1249)。

**「subnet router を名乗っているが、実際には転送できない」ノードを、サーバ側が知れる。** admin console で警告を出せる。

### プラットフォーム固有の除外

```go title="ipn/ipnlocal/local.go"
	if buildfeatures.HasSynology && distro.Get() == distro.Synology {
		// Issue 1995: we don't use iptables on Synology.
		rs.NetfilterMode = preftype.NetfilterOff
	}
```

[`local.go#L6547-L6550`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L6547-L6550)。

**Synology の NAS では iptables を使わない。** issue 番号つき。

NAS のような機器では、メーカーのファームウェアが独自のファイアウォール設定を持っており、そこに割り込むと壊れる。**「この製品では機能を無効にする」という判断が、1 行で書かれている。**

### 二重否定を正す

```go title="ipn/ipnlocal/local.go"
	var doStatefulFiltering bool
	if v, ok := prefs.NoStatefulFiltering().Get(); ok && !v {
		// The preferences explicitly "do stateful filtering" is turned
		// off, or to expand the double negative, to do stateful
		// filtering. Do so.
		doStatefulFiltering = true
	}
```

[`local.go#L6528-L6534`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L6528-L6534)。

**設定名が `NoStatefulFiltering` という否定形なので、否定の否定になる。**

そこで **ローカル変数を肯定形 (`doStatefulFiltering`) にして、その場で変換する**。そして「二重否定を展開すると」とコメントで説明する。

設定名は互換性のために変えられない ([machine key の prefix](../keys/) と同じ事情)。だが **コードの中では肯定形に直せる。**

## なぜそうなっているか

### なぜ subnet router と exit node を分けないのか

「サブネットへの経路を広告する」という 1 つの機能で、両方が表現できる。

- `192.168.1.0/24` → そのサブネットへ
- `0.0.0.0/0` → すべてへ

**別の機能として実装すると、コードが 2 系統になり、組み合わせ (subnet router かつ exit node) の扱いが複雑になる。**

UI では別の概念として見せる (「サブネットルーター」「出口ノード」) が、**内部では同じ経路広告の仕組み** だ。ユーザーに見せる概念と、実装の概念を一致させなくてよい例になっている。

違いが出るのは **使う側** だ。exit node を選ぶと、DNS の扱い ([exit DNS](../split-dns/))、LAN アクセスの扱い、デフォルトルートの補完が追加で必要になる。

### なぜ経路の欠落を埋めるのか

VPN で最も避けたい失敗は **「保護されていると思っているのに、保護されていない」** ことだ。

exit node を選ぶ理由は、たいてい

- 公衆 Wi-Fi で通信を保護したい
- 特定の国からのアクセスに見せたい
- 会社のネットワークを経由したい

**どれも「漏れたら目的が達成されない」** 種類のものだ。IPv6 だけ直接出ていたら、目的は達成されていない。

だから「通信できない」ほうを選ぶ。ユーザーは気づいて、原因を調べるか、exit node をやめるかを選べる。

**「気づける失敗」と「気づけない失敗」があるなら、前者を選ぶ。**

### なぜ LAN を明示的に Tailscale へ向けるのか

ルーティングは **最長一致 (longest prefix match)** で決まる。

- `0.0.0.0/0` → Tailscale (exit node)
- `192.168.1.0/24` → eth0 (LAN に直接繋がっているので、OS が自動的に入れる)

`192.168.1.5` 宛のパケットは、**より具体的な `/24` に一致するので eth0 に出る**。exit node を経由しない。

これは「LAN アクセスを許可」する場合には正しい挙動だ。だが **許可していない場合は漏洩** になる。同じ Wi-Fi にいる誰かに、こちらのトラフィックが見える。

だから **同じ `/24` を Tailscale 側にも入れる**。同じ長さなら、インターフェースのメトリックや設定順で Tailscale が勝つようにする。

**「デフォルトルートを向ければ全部通る」は誤り** で、既存の経路より具体的か、同じくらい具体的でなければならない。

### なぜチェックの失敗を「問題なし」とするのか

`CheckIPForwarding` は `/proc/sys/net/ipv4/ip_forward` を読んだり、インターフェースごとの設定を調べたりする。**環境によっては読めない** (コンテナ、権限、非 Linux)。

読めなかったときに「転送が壊れている」と報告すると、**実際には正常なノードに警告が出る**。

ユーザーから見れば「警告が出ているが問題はない」状態で、これが続くと **警告全体が無視されるようになる**。

**「分からない」を「問題あり」に倒すと、警告の信頼性が下がる。** 監視やアラートの設計で繰り返し現れる原則だ。

### なぜ「壊れている」をサーバに報告するのか

subnet router が転送できていないとき、**症状は「そのサブネットに繋がらない」** として、別のノードのユーザーに現れる。subnet router の管理者は気づかない。

サーバが知っていれば、**admin console で「このノードは経路を広告しているが、IP forwarding が無効です」と表示できる**。設定した本人に届く。

**「問題が起きている場所」と「原因がある場所」が違うとき、原因側から報告させる。** 分散システムの診断では基本の形になる。

## どう活かすか

**ユーザーに見せる概念と、実装の概念は一致させなくてよい。** 「サブネットルーター」と「出口ノード」は UI 上は別機能だが、実装は同じ経路広告だ。**共通部分が本質的に同じなら、実装を分けないほうが組み合わせのバグが減る。**

**「保護されているはず」の機能では、経路が欠けたときに通信を止める。** 静かに保護されないより、うるさく壊れるほうがよい。そしてその判断をコメントに書く — 「機能を犠牲にしてでも漏洩を避ける」。書かないと、後から「壊れるのは良くない」と直される。

**最長一致のルーティングでは、デフォルトルートを向けても既存の具体的な経路に負ける。** 「全部を経由させたい」なら、既存の経路と同じかより具体的な経路を入れる必要がある。これは VPN、コンテナネットワーク、ポリシールーティングに共通する落とし穴だ。

**「分からない」を「異常」に倒さない。** チェック自体が失敗したときは、警告を出さない。偽陽性が続くと、警告全体が無視されるようになる。**警告の価値は、それが出たときに本当に問題があるという信頼にある。**

**問題の症状が別の場所に出る場合、原因側から報告させる。** subnet router の設定ミスは、他のノードの接続失敗として現れる。原因側 (設定を持つノード) から中央に報告すれば、設定した本人に届く。

**否定形の名前を持つ設定は、使う場所で肯定形の変数に変換する。** 名前は互換性で変えられなくても、コードの中では読みやすい形にできる。そして「二重否定を展開すると」とコメントに書く。

**特定の製品やディストリビューションでの無効化は、条件 1 行と issue 番号で表現する。** 抽象化しようとすると複雑になる。「Synology では iptables を使わない」は、それ以上分解できない事実だ。
