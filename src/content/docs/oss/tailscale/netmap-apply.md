---
title: "netmap をローカル状態へ落とす場所を 1 つに絞る"
description: "netmap は WireGuard 設定・OS ルート・DNS 設定・パケットフィルタの 4 つに分解される。その変換は authReconfig という 1 つの関数にしかない。そして今の WireGuard 設定にはピアが載っていない。1000 ノードを毎回流し込むのをやめ、必要になったピアだけ遅延生成する形に変わっている。"
group: "制御プレーン"
sidebar:
  order: 7
---

## 何を学んだか

### netmap は 4 つの出力に分解される

control から降ってきた [netmap](../netmap/) は、そのままでは何の効果もない。ノードの挙動を変えるには、次の 4 つに変換する必要がある。

| 出力             | 型              | 効果                                        |
| ---------------- | --------------- | ------------------------------------------- |
| WireGuard 設定   | `wgcfg.Config`  | 誰と暗号化トンネルを張るか                  |
| ルータ設定       | `router.Config` | OS のルーティングテーブルとファイアウォール |
| DNS 設定         | `dns.Config`    | OS のリゾルバ設定と MagicDNS                |
| パケットフィルタ | `filter.Filter` | どのパケットを通すか                        |

**この変換をする場所は `authReconfig` という 1 つの関数だけ** だ。netmap が変わった、ユーザーが設定を変えた、exit node を選び直した — どの経路でも最後はここに来る。

### WireGuard 設定にピアが載っていない

かつて Tailscale は、netmap の全ピアを `wgcfg.Config` に詰めて wireguard-go に渡していた。1,000 ノードの tailnet なら 1,000 ピアぶんの設定を、netmap が変わるたびに流し込むことになる。

現在の実装では、**`wgcfg.Config` に入るのは自分の秘密鍵と自分のアドレスだけ** だ。ピアの情報は `routemanager` というパッケージが保持し、wireguard-go は「このパケットの宛先はどのピアか」を必要になった時点で問い合わせる。**ピアは遅延生成される。**

### 変更がなければ何もしない

`Reconfig` は 7 つの観点で「前回と変わったか」を判定し、**全部変わっていなければ `ErrNoChanges` を返して即座に戻る**。netmap は頻繁に更新されるが、その大半はノードのオンライン状態のような、データプレーンに関係のない変更だ。

### 適用の順序に意味がある

`Reconfig` の中には「この順序でなければならない」箇所が複数ある。秘密鍵は wireguard-go より先に magicsock へ渡す。ルータ設定が失敗しても DNS 設定は続ける。ピアのルートテーブルは WireGuard の再設定より前に更新する。**どれもコメントで理由が書かれている。**

## ソースコードのどこか

### 変換の唯一の入り口

```go title="ipn/ipnlocal/local.go"
func (b *LocalBackend) authReconfigLocked() {
	...
	cn := b.currentNode()

	// Note this netmap does not have its Peers populated. Nothing
	// below needs them; per-peer work rides the incremental route
	// manager and engine paths instead.
	nm := cn.NetMap()
```

[`local.go#L6055-L6068`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L6055)。

**「この netmap には Peers が入っていない」** という注意書きから始まる。ピアごとの処理は差分の経路 (route manager) が担当し、この関数はノード全体の設定だけを見る。

```go title="ipn/ipnlocal/local.go"
	// The config carries no peers; wireguard-go gets those from the
	// live per-peer config source installed via
	// [wgengine.Engine.SetPeerConfigFunc], fed by the route manager.
	cfg := &wgcfg.Config{
		PrivateKey: priv,
		Addresses:  nm.GetAddresses().AsSlice(),
	}
```

[`local.go#L6116-L6122`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L6116-L6122)。

**WireGuard に渡す設定は 2 フィールドしかない。** 秘密鍵と、自分の IP アドレス。

### ピアを供給する側

```go title="net/routemanager/routemanager.go"
// Package routemanager tracks which peers own which IP prefixes and
// incrementally derives the routing data structures used by the rest
// of the system: a table mapping destination IP to the outbound peer,
// and the set of routes to program into the operating system's
// routing table.
//
// Updates are transactional: callers open a [Mutation] with
// [RouteManager.Begin], stage operations, and call [Mutation.Commit]
// to publish new snapshots. The published snapshots are immutable
// bart tables that share memory with their predecessors, so readers
// (notably the wireguard-go data plane) can hold and read them
// without locks. At most one [Mutation] may be active at a time,
// and the caller is responsible for synchronizing them.
package routemanager
```

[`routemanager.go#L4-L17`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/routemanager/routemanager.go#L4-L17)。

**トランザクショナルで、公開されるスナップショットは不変で、前のスナップショットとメモリを共有する。** だから読み手 (パケットを転送するデータプレーン) はロックを取らずに読める。

これは [netmap の「読み取り専用ビュー」](../netmap/) と同じ発想を、ルーティングテーブルに適用したものだ。データ構造は永続的 (persistent) なトライで、更新は変更されたノードだけを作り直す。

```go title="net/routemanager/routemanager.go"
// peerView is the subset of a peer's netmap state that affects
// routing. It is intentionally much narrower than tailcfg.NodeView so
// the RouteManager can be driven and tested without full netmap
// nodes; UpsertPeer converts from tailcfg.NodeView.
type peerView struct {
	ID tailcfg.NodeID
	// Key is the peer's WireGuard public key. It is what gets
	// published into the data-path tables, so per-packet readers
	// need no NodeID-to-key translation.
	Key key.NodePublic
	Jailed bool
	MasqAddr4, MasqAddr6 netip.Addr
	SelfAddrs []netip.Prefix
	Routes []netip.Prefix
}
```

[`routemanager.go#L35-L70`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/routemanager/routemanager.go#L35)。

**ルーティングに関係するフィールドだけを抜き出した、意図的に狭い型。** コメントが 2 つの効果を挙げている — テストで netmap 全体を用意しなくてよくなること、そして **パケットごとの処理で NodeID から鍵への変換が要らない** こと。

### 変更判定

```go title="wgengine/userspace.go"
	engineChanged := !e.lastCfg.Equal(cfg)
	routerChanged := checkchange.Update(&e.lastRouter, routerCfg)
	dnsChanged := buildfeatures.HasDNS && !e.lastDNSConfig.Equal(dnsCfg.View())
	if dnsChanged {
		e.lastDNSConfig = dnsCfg.View()
	}

	listenPortChanged := listenPort != e.magicConn.LocalPort()
	peerMTUChanged := peerMTUEnable != e.magicConn.PeerMTUEnabled()
	...
	if !engineChanged && !routerChanged && !dnsChanged && !listenPortChanged && !birdChanged && !peerMTUChanged && !netlogChanged {
		return ErrNoChanges
	}
```

[`userspace.go#L843-L863`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/userspace.go#L843)。

**7 個の真偽値を全部 OR する。** どれか 1 つでも変わっていれば適用に進む。

面白いのは、この判定より **前** に実行されているものがあることだ。

```go title="wgengine/userspace.go"
	// Let the network flow logger react before the early return below,
	// so that logging identity changes take effect even when nothing
	// else changed, and before the router is configured, so that a
	// starting logger captures initial packets.
	netlogChanged := false
	if e.netlogger != nil {
		netlogChanged = e.netlogger.Reconfig(routerCfg, routerChanged)
	}
```

[`userspace.go#L853-L860`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/userspace.go#L853)。

**「早期リターンの前に呼ぶ」ことに意味がある副作用**は、判定より前に置く。しかもその戻り値が判定の入力になる。BIRD 連携も同じ扱いだ。

### 順序が意味を持つ場所

```go title="wgengine/userspace.go"
	if !e.lastCfg.PrivateKey.Equal(cfg.PrivateKey) {
		// Tell magicsock about the new (or initial) private key
		// (which is needed by DERP) before wgdev gets it, as wgdev
		// will start trying to handshake, which we want to be able to
		// go over DERP.
		if err := e.magicConn.SetPrivateKey(cfg.PrivateKey); err != nil {
```

[`userspace.go#L874-L881`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/userspace.go#L874)。

**wireguard-go に秘密鍵を渡すと、その瞬間からハンドシェイクを始めようとする。** そのときに magicsock が [DERP](../derp/) に接続できていないと、ハンドシェイクのパケットを送る先がない。だから magicsock を先に設定する。

```go title="wgengine/userspace.go"
	// A router.Set error is recorded but must not abort the reconfig: DNS
	// configuration below must be attempted independently. See #20447.
	var routerErr error
	if routerChanged {
		e.logf("wgengine: Reconfig: configuring router")
		routerErr = e.router.Set(routerCfg)
		e.health.SetRouterHealth(routerErr)
		if routerErr != nil {
			e.logf("wgengine: Reconfig: router config failed (%v); continuing to DNS config so name resolution still works", routerErr)
		}
	}
```

[`userspace.go#L894-L906`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/userspace.go#L894)。

**ルーティング設定に失敗しても DNS 設定は続ける。** 名前解決だけでも動いたほうがマシだからだ。エラーは握り潰さず、`health.SetRouterHealth` に記録して、[長い poll のデバッグフラグ](../map-longpoll/)としてサーバにも伝わる。

### 差分の適用

```go title="ipn/ipnlocal/local.go"
	peersUpsertedOrRemoved := false
	ms := b.MagicConn()
	for _, m := range muts {
		switch m := m.(type) {
		case netmap.NodeMutationUpsert:
			ms.UpsertPeer(m.Node)
			...
		case netmap.NodeMutationRemove:
			ms.RemovePeer(m.NodeIDBeingMutated())
			...
		default:
			metricNetmapDeltaPeerPatched.Add(1)
			updateIDs.Add(m.NodeIDBeingMutated())
		}
	}
	ms.UpdateNetmapDelta(muts)

	// Sync the WireGuard device for exactly the peers whose allowed
	// source prefixes changed, as computed by the route manager when
	// the delta was applied above.
	for k := range deltaRes.ChangedAllowedIPs {
		b.e.SyncDevicePeer(k)
	}
```

[`local.go#L2465-L2495`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L2465)。

**変わったピアだけを WireGuard デバイスに同期する。** `authReconfig` を呼ばずに済むので、1 ノードのオンライン状態が変わっただけで OS のルーティングテーブルを触ることがない。

差分の経路にも tailnet lock のフィルタが挟まっている。

```go title="ipn/ipnlocal/local.go"
	// Filter the mutations through tailnet lock before applying them.
	// Unsigned (or invalidly-signed) peers arriving via PeersChanged
	// ride the delta path as NodeMutationUpsert and would otherwise
	// land in nodeBackend.peers without ever passing through
	// tkaFilterNetmapLocked.
	muts = b.tkaFilterDeltaMutsLocked(muts)
```

[`local.go#L2434-L2443`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L2434)。

**最適化のために作った差分の経路が、セキュリティチェックを迂回する穴になっていた** という話だ。コメントは「署名されていないピアが差分経路で入ってくると、tailnet lock のフィルタを通らずに `peers` に着地してしまう」と説明している。

### ルートを 1 本にまとめるか、ノードごとに引くか

```go title="ipn/ipnlocal/local.go"
// shouldUseOneCGNATRoute reports whether we should prefer to make one big
// CGNAT /10 route rather than a /32 per peer.
func shouldUseOneCGNATRoute(logf logger.Logf, mon *netmon.Monitor, controlKnobs *controlknobs.Knobs, versionOS string) bool {
	if controlKnobs != nil {
		// Explicit enabling or disabling always take precedence.
		if v, ok := controlKnobs.OneCGNAT.Load().Get(); ok {
```

[`local.go#L6201-L6210`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L6201)。

**ピアごとに `/32` の経路を OS に入れるか、`100.64.0.0/10` を 1 本入れるか。** ノード数が多いと `/32` が数千本になり、OS のルーティングテーブル更新が重くなる。一方 `/10` を 1 本にすると、tailnet にいないアドレスまでトンネルに吸い込むので、他のソフトウェアと衝突しうる。

判断は OS ごとに違い、しかも **control server から `controlKnobs` で上書きできる**。特定 OS のバグが見つかったときに、クライアントを更新せずに挙動を変えられる。

## なぜそうなっているか

### なぜ変換を 1 箇所に集めるのか

netmap から設定への変換は、単純な関数ではない。exit node の選択、subnet route を受け入れるかの設定、PAC ファイルの有無、OS の種類、機能フラグ — これら全部が結果に影響する。

もし「netmap が変わったら WireGuard を更新する」「prefs が変わったらルータを更新する」と経路を分けると、**「netmap と prefs が同時に変わったとき」の組み合わせを個別に考える必要が出る**。

`authReconfig` に集約すれば、**入力が何であれ、常に現在の全状態から出力を作り直す**。差分ではなく現在値から計算するので、「どの経路で来たか」を気にしなくてよい。[netmap が状態配布である](../netmap/)のと同じ思想が、ノードの内部にも適用されている。

### なぜピアを遅延生成に変えたのか

wireguard-go にピアを設定するコストは、ピア数に比例する。大きな tailnet では netmap 更新のたびに数千ピアの設定が走り、**そのあいだ WireGuard のロックが握られる**。

だが実際に通信するピアは、たいてい数個だ。1,000 台の tailnet でも、あるノードが実際にパケットを送る相手は数台しかない。**残り 995 台ぶんの設定は、作った瞬間から一度も使われずに消える。**

そこで「宛先 IP からピアを引く表」だけを持ち、wireguard-go には必要になった時点でピアを作らせる形に変えた。表の更新は route manager の中で完結し、WireGuard デバイスは触らない。

この変更が可能になったのは、**wireguard-go 側にピアを遅延生成するフックを入れられた**からだ (Tailscale は wireguard-go をフォークしている)。上流のライブラリを自分で持っていることが、こういう最適化を可能にしている。

### なぜ変更判定を 7 個に分けるのか

「設定全体をハッシュして比べる」でも変更検知はできる。だがそれだと **何が変わったか分からない**。

`Reconfig` の後半は「ルータが変わったならルータを設定」「DNS が変わったなら DNS を設定」と分岐する。OS のルーティングテーブルや DNS 設定の書き換えは、**成功しても数十ミリ秒かかり、失敗するとユーザーの通信が壊れる**。変わっていないものを触らないことに実利がある。

そして「早期リターンの前に実行しなければならない副作用」がいくつかあり、それらの戻り値も判定に入る。この構造は読みにくいが、コメントで「なぜ前に置くか」が全部説明されている。

### なぜ差分経路にセキュリティフィルタを足したのか

これは **最適化が安全性の前提を壊した** 例だ。

元の設計では、netmap は必ず `tkaFilterNetmapLocked` を通ってから適用される。tailnet lock が有効なら、署名のないピアはここで除外される。

差分適用の経路を足したとき、この関門を通らずにピアが `peers` マップに入るようになった。攻撃者が control server を掌握していれば、**「差分」としてピアを送り込むだけで tailnet lock を迂回できる**。

修正は差分にも同じフィルタを掛けることだが、**単に除外するだけでは足りない**。コメントが説明しているとおり、不正な upsert は「同じ ID の削除」に書き換える必要がある。そうしないと、以前に署名されていた正当なピアが古い状態のまま残ってしまう。

**「速い経路」を後から足すときは、遅い経路が通っていた検査を全部数え上げる必要がある。** これはキャッシュ、バッチ処理、ファストパスの類すべてに共通する落とし穴だ。

### なぜ control server が挙動を上書きできるのか

`controlKnobs` は、control server がクライアントの挙動を遠隔で切り替える仕組みだ。CGNAT ルートの形、ポートのランダム化、その他いくつか。

理由は [ダイヤル計画](../noise-transport/) と同じで、**クライアントは即座に更新できない**からだ。ある OS バージョンで `/10` の 1 本ルートが問題を起こすと分かったとき、修正版をリリースして全端末が更新されるのを待つと数か月かかる。ノブを倒せば次の netmap 更新で反映される。

代償は、**挙動が「コードを読んでも分からない」ものになる**ことだ。だから `shouldUseOneCGNATRoute` は、ノブの確認を関数の先頭に置き、ログに `explicit=%v` と出す。**上書きされていることが必ずログに残る。**

## どう活かすか

**「状態から設定を作る関数」は 1 つにする。** 入力が複数あるシステムでは、入力ごとに更新経路を作りたくなる。だがそうすると経路の数だけ組み合わせが増える。全状態から毎回作り直す関数を 1 つ持ち、すべての変更をそこに集約すると、テストすべきものが「入力の組み合わせ」から「関数の出力」に減る。差分適用はその後の最適化として足す。

**大量の要素を下位層に流し込む前に、「実際に使われるのは何個か」を測る。** 設定の投入コストが要素数に比例し、実使用が一部だけなら、遅延生成に切り替える余地がある。そのためには下位層に「必要になったら問い合わせる」フックが要るので、ライブラリを選ぶときの観点にもなる。

**永続データ構造 + 不変スナップショットは、読みが支配的な共有状態に効く。** 更新側はトランザクションで新しいスナップショットを作り、読み側はロックなしで古いスナップショットを読み続ける。ルーティングテーブルのように「毎パケット読む、たまに更新する」ものには特に向く。

**ファストパスを足すときは、スローパスが通っていた検査をすべて数え上げる。** 検査が抜けても正常系は動くので、テストでは見つからない。tailnet lock の例は「最適化のための差分経路が、認可チェックを飛ばしていた」という形で、キャッシュや一括処理でも同じ構図が起きる。

**設定の適用順序に理由があるなら、必ずコメントに書く。** 「magicsock に先に鍵を渡す」「ルータが失敗しても DNS は続ける」は、どちらも読んだだけでは分からない。順序を入れ替えるリファクタリングは簡単に起きるので、理由が書かれていないと壊される。

**遠隔で挙動を切り替えられるノブは、更新できないクライアントを持つなら現実的な必要悪だ。** ただし採用するなら「今どちらの挙動なのか」が必ずログや診断コマンドに出るようにする。出ないと、再現しないバグの原因を追えなくなる。
