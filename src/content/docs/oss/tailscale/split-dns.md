---
title: "split DNS と exit node DNS の優先順位"
description: "「この suffix はこのリゾルバへ」を OS に任せられるなら任せ、できなければ 100.100.100.100 が全部を代理する。判定に効く条件は 8 つあり、Windows は WSL のために、iOS はバッテリーのために、macOS はユーザーの DoH 設定のために、それぞれ別扱いになる。"
group: "DNS"
sidebar:
  order: 33
---

## 何を学んだか

### split DNS とは

「`*.internal.example.com` は社内の DNS サーバへ、それ以外は普通のリゾルバへ」という設定を **split DNS** と呼ぶ。

Tailscale では、admin console で設定した内容が [netmap](../netmap/) 経由で配られ、各ノードで適用される。

### OS に任せるか、自分で代理するか

split DNS を実現する方法は 2 つある。

**A. OS に任せる。** systemd-resolved、Windows の NRPT、macOS はドメインごとのリゾルバ指定に対応している。OS に「この suffix はこのサーバへ」と伝える。

**B. `100.100.100.100` が代理する。** OS には「全部 quad-100 へ」とだけ伝え、[MagicDNS のリゾルバ](../magicdns-resolver/)が suffix ごとに振り分ける。

**A のほうが軽い** (Tailscale のプロセスを経由しない)。だが使えない場合がある。

### 判定に効く条件が 8 つ

`compileConfig` は次を見て決める。

- OS が split DNS に対応しているか
- MagicDNS のホストがあるか
- デフォルトリゾルバ (`.` の設定) があるか
- split の宛先が全部同じリゾルバか
- Windows か (WSL のため)
- iOS か (バッテリーと ExtraRecords のため)
- サンドボックス化された macOS か (ユーザーの DoH 設定のため)
- control server のノブ

### exit node が DNS も代理する

exit node を使うとき、DNS も exit node 経由にできる。**exit node の [peerAPI](../peerapi/) に `/dns-query` という DoH エンドポイントがある。**

## ソースコードのどこか

### 設定を 2 つに分解する

```go title="net/dns/manager.go"
func (m *Manager) compileConfig(cfg Config) (rcfg resolver.Config, ocfg OSConfig, err error) {
	// The internal resolver always gets MagicDNS hosts and
	// authoritative suffixes, even if we don't propagate MagicDNS to
	// the OS.
	rcfg.Hosts = cfg.Hosts
	rcfg.SubdomainHosts = cfg.SubdomainHosts
	rcfg.AcceptDNS = cfg.AcceptDNS
	routes := map[dnsname.FQDN][]*dnstype.Resolver{}
	var propagateHostsToOS bool
	for suffix, resolvers := range cfg.Routes {
		if len(resolvers) == 0 {
			propagateHostsToOS = true
			rcfg.LocalDomains = append(rcfg.LocalDomains, suffix)
		} else {
			routes[suffix] = resolvers
		}
	}
	// LocalDomains is an unordered suffix set, but it comes out of map
	// iteration; sort it so equal configs compare and log equal.
	slices.Sort(rcfg.LocalDomains)
```

[`manager.go#L307-L326`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager.go#L307-L326)。

**入力 1 つから、出力 2 つ (内部リゾルバの設定と OS の設定) を作る。** 同じ情報が 2 つの形に分かれる。

**マップの反復順は不定なので、明示的にソートする。** 理由は「等しい設定が等しく比較され、等しくログに出るように」。

これが効くのは、`Set` が **同じ設定で何度も呼ばれる** からだ ([router と同じ](../router-firewall/))。ソートしていないと、内容が同じでも順序が違って「変更あり」と判定され、**OS の DNS 設定を無駄に書き換える**。

**「順序に意味がないデータを比較するなら、正規化する」。**

### 単純な場合から片付ける

```go title="net/dns/manager.go"
	// Deal with trivial configs first.
	switch {
	case !cfg.needsOSResolver() || runtime.GOOS == "plan9":
		// Set search domains, but nothing else.
		return rcfg, ocfg, nil
	case cfg.hasDefaultIPResolversOnly() && !cfg.hasHostsWithoutSplitDNSRoutes():
		// Trivial CorpDNS configuration, just override the OS resolver.
		//
		// If there are hosts (ExtraRecords) that are not covered by an existing
		// SplitDNS route, then we don't go into this path so that we fall into
		// the next case and send the extra record hosts queries through
		// 100.100.100.100 instead where we can answer them.
		ocfg.Nameservers = toIPsOnly(cfg.DefaultResolvers)
		return rcfg, ocfg, nil
	case cfg.hasDefaultResolvers():
		// Default resolvers plus other stuff always ends up proxying
		// through quad-100.
		rcfg.Routes = routes
		rcfg.Routes["."] = cfg.DefaultResolvers
		ocfg.Nameservers = cfg.serviceIPs(m.knobs)
		return rcfg, ocfg, nil
	}

	// From this point on, we're figuring out split DNS
	// configurations. The possible cases don't return directly any
	// more, because as a final step we have to handle the case where
	// the OS can't do split DNS.
```

[`manager.go#L334-L366`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager.go#L334-L366)。

**「単純な場合を先に片付ける」という構造が、コメントで宣言されている。**

そして「ここから先は split DNS の設定を考える。**もう直接 return しない** — 最後に『OS が split DNS できない場合』を処理しなければならないので」と、**残りのコードの形まで予告している。**

関数が 150 行あるので、この道標がないと迷う。

### Windows は二重に設定する

```go title="net/dns/manager.go"
	// Workaround for
	// https://github.com/tailscale/corp/issues/1662. Even though
	// Windows natively supports split DNS, it only configures linux
	// containers using whatever the primary is, and doesn't apply
	// NRPT rules to DNS traffic coming from WSL.
	//
	// In order to make WSL work okay when the host Windows is using
	// Tailscale, we need to set up quad-100 as a "full proxy"
	// resolver, regardless of whether Windows itself can do split
	// DNS. We still make Windows do split DNS itself when it can, but
	// quad-100 will still have the full split configuration as well,
	// and so can service WSL requests correctly.
	isWindows := m.goos == "windows"
```

[`manager.go#L368-L383`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager.go#L368-L383)。

**WSL (Windows Subsystem for Linux) の中の Linux は、Windows の NRPT ルールを見ない。** Windows が「`*.internal` は社内 DNS へ」と設定していても、WSL 内のプログラムには適用されない。

対処は **「Windows にも split DNS をさせつつ、quad-100 にも完全な設定を入れる」**。WSL は Windows のプライマリリゾルバ (= quad-100) を使うので、そこで正しく振り分けられる。

**両方に設定を入れる**という冗長な対処だが、WSL の挙動を変えられない以上、これしかない。

### Apple プラットフォームの事情

```go title="net/dns/manager.go"
	isIOS := m.goos == "ios"
	isSandboxedMac := m.goos == "darwin" && isSandboxedMacOS()
	supportsSplitDNS := m.os.SupportsSplitDNS()
	isSandboxedApple := isIOS || isSandboxedMac
	// Apple platforms keep split-domain traffic pointed at quad-100 rather than
	// handing the upstream resolvers to the OS directly, because those resolvers
	// may only be reachable through the tunnel.
	if supportsSplitDNS && !isWindows && !isSandboxedApple {
		if srs := toIPsOnly(cfg.singleResolverSet()); len(srs) > 0 {
			// Split DNS configuration requested, where all split domains
			// go to the same resolvers. We can let the OS do it.
			ocfg.Nameservers = srs
			ocfg.MatchDomains = cfg.matchDomains()
			return rcfg, ocfg, nil
		}
	}
```

[`manager.go#L384-L399`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager.go#L384-L399)。

**「上流のリゾルバがトンネル経由でしか到達できないかもしれない」** ため、Apple プラットフォームでは OS に直接渡さない。

社内 DNS サーバが `10.0.0.53` にあり、それが [subnet router](../subnet-router-exit-node/) 経由でしか届かないとする。OS に「`internal.example.com` は `10.0.0.53` へ」と伝えると、**OS はそのアドレスに直接送ろうとして失敗する** — サンドボックスの都合で、Tailscale のトンネルを経由しない。

quad-100 経由なら、Tailscale が [tsdial](../netns-loop/) を使って正しい経路で問い合わせる。

**「OS に任せる」が成立する前提は、OS がその宛先に到達できること。** その前提が崩れる環境がある。

### iOS の 2 つの制約

```go title="net/dns/manager.go"
	// usePrimaryResolver forces quad-100 to be installed as the OS's primary
	// (catch-all) resolver rather than scoped to the match domains. iOS always
	// does this (it has no way to selectively answer ExtraRecords). Sandboxed
	// macOS did too until control opts it into scoping via
	// NodeAttrScopeQuad100OnMacOS, so that a user's DoH system profile isn't
	// shadowed by quad-100. See tailscale/corp#45534.
	usePrimaryResolver := isIOS || (isSandboxedMac && !m.scopeQuad100OnMacOS())
```

[`manager.go#L407-L413`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager.go#L407-L413)。

**macOS では、quad-100 をプライマリにすると「ユーザーが設定した DoH プロファイルを覆い隠す」。**

ユーザーが Cloudflare や NextDNS の DoH プロファイルを入れていると、Tailscale がそれを無効化してしまう。そこで **[control server のノブ](../netmap-apply/) で「スコープを絞る」挙動に切り替えられる** ようにした。

**ユーザーの他の設定と競合する場合の扱いを、遠隔で切り替えられるようにしている。**

そして iOS の別の事情。

```go title="net/dns/manager.go"
	// Even though iOS devices can do split DNS, they don't provide a way to
	// selectively answer ExtraRecords, and ignore other DNS traffic. As a
	// workaround, we read the existing default resolver configuration and use
	// that as the forwarder for all DNS traffic that quad-100 doesn't handle.
	//
	// If the OS can't do native split-DNS, read out the underlying resolver
	// config and blend it into our config. On iOS, [OSConfigurator.GetBaseConfig]
	// has a tendency to temporarily fail if called immediately following an
	// interface change.
	base, err := m.os.GetBaseConfig()
```

[`manager.go#L420-L432`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager.go#L420)。

**OS が split DNS できない場合、逆方向のことをする。** 「OS の現在の DNS 設定を読み取って、それを自分の上流として使う」。

つまり **quad-100 が完全なプロキシになる**。tailnet のものは自分で答え、それ以外は元々の DNS サーバへ転送する。

### iOS のバッテリー最適化

```go title="net/dns/manager.go"
	// On iOS only (for now), check if all route names point to resources inside the tailnet.
	// If so, we can set those names as MatchDomains to enable a split DNS configuration
	// which will help preserve battery life.
	// Because on iOS MatchDomains must equal SearchDomains, we cannot do this when
	// we have any Routes outside the tailnet. Otherwise when app connectors are enabled,
	// a query for 'work-laptop' might lead to search domain expansion, resolving
	// as 'work-laptop.aws.com' for example.
	if isIOS && rcfg.RoutesRequireNoCustomResolvers() {
```

[`manager.go#L449-L456`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager.go#L449)。

**quad-100 をプライマリにすると、すべての DNS クエリが Tailscale のプロセスを起こす。** iOS の Network Extension は、起きるたびにバッテリーを消費する。

split DNS にできれば、**tailnet のドメインのクエリだけが Tailscale を起こす**。それ以外は OS が直接処理する。

だが iOS には制約がある。**`MatchDomains` と `SearchDomains` が等しくなければならない。** すると `work-laptop` という短い名前のクエリが `work-laptop.aws.com` に展開されてしまう ([app connector](../app-connector/) を使っている場合)。

**だから「全部の route が tailnet 内を指す場合だけ」最適化する。** 条件が具体的で、外れた場合の症状まで説明されている。

### 失敗の分類

```go title="net/dns/manager.go"
	base, err := m.os.GetBaseConfig()
	if err != nil {
		if (isIOS || isNoopManager(m.os) || (supportsSplitDNS && !isSandboxedMac)) && err == ErrGetBaseConfigNotSupported {
			// No base config to blend in: noopManager (userspace networking),
			// some iOS builds, or a split-DNS manager that has none by
			// construction (e.g. systemd-resolved). Fall back to a scoped
			// config instead of erroring and leaving the old OS config.
			// Sandboxed macOS is excluded: it does have a base config
			// (/etc/resolv.conf), so this error is a real read failure there.
			m.health.SetHealthy(osConfigurationReadWarnable)
			ocfg.MatchDomains = cfg.matchDomains()
			return rcfg, ocfg, nil
		}
		m.health.SetUnhealthy(osConfigurationReadWarnable, health.Args{health.ArgError: err.Error()})
		return resolver.Config{}, OSConfig{}, err
	}
```

[`manager.go#L432-L447`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager.go#L432)。

**同じエラー (`ErrGetBaseConfigNotSupported`) が、環境によって「正常」と「異常」に分かれる。**

- **systemd-resolved**: 基底の設定という概念がない。**正常**
- **[netstack](../netstack/) モード**: OS の DNS を触らない。**正常**
- **サンドボックス化された macOS**: `/etc/resolv.conf` があるはずなので、読めないのは **本当の失敗**

だから macOS だけを除外条件に入れる。そして **正常な場合は `SetHealthy`、異常な場合は `SetUnhealthy`** と [health tracker](../health/) に報告する。

**「エラーの種類」ではなく「エラーの文脈」で正常・異常を判断している。**

### DNS サービス探索を捨てる

```go title="net/dns/resolver/forwarder.go"
	// Drop DNS service discovery spam, primarily for battery life
	// on mobile.  Things like Spotify on iOS generate this traffic,
	// when browsing for LAN devices.  But even when filtering this
	// out, playing on Sonos still works.
	if hasRDNSBonjourPrefix(domain) {
		metricDNSFwdDropBonjour.Add(1)
		res, err := nxDomainResponse(query)
		...
	}
```

[`forwarder.go#L1216-L1232`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/forwarder.go#L1216)。

**Bonjour / mDNS のサービス探索クエリを、転送せずに NXDOMAIN で返す。**

「主にモバイルのバッテリー寿命のため。iOS の Spotify のようなアプリが、LAN のデバイスを探すときにこのトラフィックを生成する」。

そして **「フィルタしても Sonos での再生は動く」** と、副作用を実際に確認した記録がある。

**「トラフィックを捨てる」判断には、捨てて壊れないことの確認が要る。** その確認結果を、具体的な製品名とともに残している。

### exit node の DoH

```go title="ipn/ipnlocal/local.go"
func exitNodeCanProxyDNS(nm *netmap.NetworkMap, peers map[tailcfg.NodeID]tailcfg.NodeView, exitNodeID tailcfg.StableNodeID) (dohURL string, ok bool) {
	...
	for _, p := range peers {
		if p.StableID() == exitNodeID && peerCanProxyDNS(p) {
			return peerAPIBase(nm, p) + "/dns-query", true
		}
	}
	return "", false
}
```

[`local.go#L7886-L7898`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L7886-L7898)。

**exit node の [peerAPI](../peerapi/) の `/dns-query` が、DoH のエンドポイントになる。**

exit node を使うとき、DNS も exit node 経由にする理由は、

- **DNS のクエリがローカルの ISP に漏れない**。exit node を使う目的の一部
- **exit node から見た名前解決になる**。地域による CDN の振り分けが、exit node の場所に合う

DoH を使うのは、**すでに tailnet の中にいるのに、さらに暗号化するため**ではない。**HTTP という既存の経路 (peerAPI) に相乗りできる** からだ。新しいプロトコルもポートも要らない。

## なぜそうなっているか

### なぜ「OS に任せる」を優先するのか

quad-100 が全部を代理すると、

- **すべての DNS クエリが Tailscale のプロセスを通る**。プロセスが止まれば名前解決が止まる
- **モバイルではプロセスが起こされ、バッテリーを消費する**
- **1 ホップ増える**。レイテンシがわずかに増える

OS がやってくれるなら、そのほうが軽い。**「自分でやらなくてよいことは、OS にやらせる」** という判断。

ただし OS の split DNS には制約が多い (WSL、iOS の SearchDomains、到達性)。だから **「任せられるか」の判定が 8 条件になる。**

### なぜ条件がこれほど多いのか

DNS の設定は、**OS ごとに機能も制約も違い、しかもユーザーの他の設定と競合する**。

- Windows: NRPT はあるが WSL に効かない
- iOS: split DNS はあるが、ExtraRecords を選択的に答えられず、MatchDomains = SearchDomains の制約がある
- macOS (サンドボックス): DoH プロファイルと競合する
- systemd-resolved: 基底の設定という概念がない

**それぞれの制約が独立しているので、条件は掛け算になる。** 抽象化して減らすことができない。

できるのは **「各条件がなぜ必要か」をコメントに書く** ことだけだ。実際、この関数のコメント行数はコード行数を上回る。

### なぜマップの反復順をソートするのか

Go のマップは反復順が不定だ。同じマップを 2 回反復すると、違う順序になる。

`compileConfig` の出力が [OSConfigurator に渡され](../os-dns-config/)、そこで「前回と同じか」を比較する。順序が違えば「変わった」と判定される。

**すると DNS の設定が毎回書き換わる。** systemd-resolved への D-Bus 呼び出し、レジストリの書き込み、`/etc/resolv.conf` の書き直しが、netmap 更新のたびに起きる。

**「不定な順序を含む値を比較に使うなら、正規化する」** は、Go のマップを扱う上での基本的な注意になる。

### なぜ「単純な場合を先に」なのか

`compileConfig` は 8 つの条件の組み合わせを扱う。全部を 1 つの判定式に書くと、読めない。

**「単純な場合から片付けて、残りを絞り込む」** 構造にすると、後半の条件が「ここまで来たということは、これらは満たされていない」という前提の上に立てる。

そして **「ここから先は直接 return しない」** という宣言が、読み手に構造を伝える。前半と後半で書き方が変わることを、あらかじめ知らせている。

### なぜ同じエラーを文脈で分けるのか

`ErrGetBaseConfigNotSupported` は「基底の DNS 設定を取得できない」。これが正常か異常かは、**どの環境で起きたか** による。

- systemd-resolved には基底の設定という概念がない → **設計上そうなる**
- サンドボックス化された macOS には `/etc/resolv.conf` がある → **読めないのは異常**

エラーの型を分ける (`ErrNotApplicable` と `ErrReadFailed`) こともできた。だが **「同じ理由で失敗しているが、期待が違う」** ので、呼び出し側の文脈でしか判断できない。

**エラーの意味が呼び出し元の文脈に依存する場合、判定は呼び出し元に置くしかない。** そしてその判定を、健全性の報告に反映させる。

## どう活かすか

**「自分でやる」と「プラットフォームに任せる」の両方を実装し、任せられるときは任せる。** 任せたほうが軽く、障害点が減る。ただし任せられる条件を正確に判定する必要があり、そこが実装の大半になる。

**マップを反復して作る値を比較に使うなら、必ずソートして正規化する。** Go のマップの反復順は不定なので、正規化しないと「内容は同じだが違う値」が生まれ、無駄な再設定を引き起こす。

**条件の多い関数は「単純な場合を先に片付ける」構造にし、それを宣言する。** 「ここから先は直接 return しない」のような道標があると、150 行の関数でも読める。

**プラットフォーム固有の制約は、抽象化せずに条件として並べる。** WSL、iOS の SearchDomains、macOS の DoH プロファイル。それぞれ独立した制約なので、まとめようとすると意味が失われる。**代わりに、各条件の理由を必ず書く。**

**同じエラーが文脈によって正常にも異常にもなるなら、判定を呼び出し元に置く。** そしてその判定結果を、健全性の報告に反映させる。「このエラーは想定内」と「このエラーは問題」を、ユーザーへの見せ方で分ける。

**トラフィックを捨てる判断には、捨てても壊れないことの確認を添える。** 「Bonjour のクエリを捨てても Sonos は動く」— 具体的な製品での確認結果が、後から「これを捨てて大丈夫か」と疑う人への答えになる。

**既存の経路に相乗りできるなら、新しいプロトコルを作らない。** exit node の DNS は peerAPI 上の DoH で、新しいポートも認証もいらない。[c2n が HTTP を HTTP で包む](../c2n/) のと同じ発想だ。
