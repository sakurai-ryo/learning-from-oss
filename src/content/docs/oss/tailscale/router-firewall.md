---
title: "ルーティングとファイアウォールを OS ごとに書き分ける"
description: "Router は Up/Set/Close の 3 メソッドしかない。その裏で Linux は iptables と nftables の両方を持ち、どちらを使うかは「既にルールがいくつ入っているか」を数えて決める。判定結果は文字列としてサーバに報告され、選択の分布が観測できるようになっている。"
group: "OS 統合とルーティング"
sidebar:
  order: 26
---

## 何を学んだか

### インターフェースは 3 メソッド

```go
type Router interface {
	Up() error
	Set(*Config) error
	Close() error
}
```

**OS のネットワークスタックを操作する部分が、この 3 つに集約されている。** 実装は Linux、macOS、Windows、FreeBSD、OpenBSD、Plan 9 用にそれぞれある。

`Set` に渡す `Config` には、ルーティングとファイアウォールの設定が入る。**「同じ Config で複数回呼ばれてもよい」** ことが契約に含まれる。

### Linux だけフィールドが多い

`Config` の後半は Linux 専用だ。

```go
	// Linux-only things below, ignored on other platforms.
	SNATSubnetRoutes    bool
	StatefulFiltering   bool
	NetfilterMode       preftype.NetfilterMode
	NetfilterKind       string
	RemoveCGNATDropRule bool
```

**移植性のために抽象化するのではなく、「これは Linux だけ」と明示して同じ構造体に入れている。**

### iptables と nftables の両方を実装している

Linux のパケットフィルタには 2 世代ある。古い `iptables` と、新しい `nftables`。

Tailscale は **両方の完全な実装を持つ**。`iptables_runner.go` が 28 KB、`nftables_runner.go` が **77 KB**。テストを含めると、この 2 ファイルだけで 18 万行のうち相当な割合を占める。

### どちらを使うかは「既にあるルールの数」で決める

自動判定モードでは、**iptables と nftables のそれぞれについて、現在システムに入っているルールの数を数える**。

- nftables にルールがあり、iptables にない → **nftables を使う**
- iptables にルールがあり、nftables にない → **iptables を使う**

「システムが既にどちらを使っているか」を、ルールの存在から推定している。

### 判定の結果を短い文字列で報告する

`hostinfo.SetFirewallMode("nft-inuse")` のように、**判定の結果と理由を 1 つの文字列にして control server に報告する**。

`ipt-default`、`nft-forced`、`nft-noipt`、`nft-gokrazy`、`ipt-inuse` — **どの経路でその判定に至ったかが、文字列から分かる。**

## ソースコードのどこか

### 最小のインターフェース

```go title="wgengine/router/router.go"
// Package router presents an interface to manipulate the host network
// stack's state.
package router

// Router is responsible for managing the system network stack.
//
// There is typically only one instance of this interface per process.
type Router interface {
	// Up brings the router up.
	Up() error

	// Set updates the OS network stack with a new Config. It may be
	// called multiple times with identical Configs, which the
	// implementation should handle gracefully.
	Set(*Config) error

	// Close closes the router.
	Close() error
}
```

[`router.go#L4-L40`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/router/router.go#L4-L40)。

**「同一の Config で複数回呼ばれることがあり、実装はそれを優雅に扱うこと」** が契約に書かれている。

[wgengine の Reconfig](../netmap-apply/) は差分を検出してから呼ぶが、それでも同じ設定で呼ばれうる。**呼び出し側の最適化に依存せず、実装側も冪等にする。**

### Config は宣言的

```go title="wgengine/router/router.go"
type Config struct {
	// LocalAddrs are the address(es) for this node. This is
	// typically one IPv4/32 (the 100.x.y.z CGNAT) and one
	// IPv6/128 (Tailscale ULA).
	LocalAddrs []netip.Prefix

	// Routes are the routes that point into the Tailscale
	// interface.  These are the /32 and /128 routes to peers, as
	// well as any other subnets that peers are advertising and
	// this node has chosen to use.
	Routes []netip.Prefix

	// LocalRoutes are the routes that should not be routed through Tailscale.
	// There are no priorities set in how these routes are added, normal
	// routing rules apply.
	LocalRoutes []netip.Prefix
	...
	// SubnetRoutes is the list of subnets that this node is
	// advertising to other Tailscale nodes.
	// As of 2023-10-11, this field is only used for network
	// flow logging and is otherwise ignored.
	SubnetRoutes []netip.Prefix
```

[`router.go#L106-L140`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/router/router.go#L106-L140)。

**「あるべき状態」を渡し、そこへ持っていくのは実装の責任。** 差分の計算は各 OS の実装が行う。

`SubnetRoutes` のコメントが正直だ。**「2023-10-11 時点で、このフィールドは [ネットワークフローログ](../netlog/) にのみ使われ、それ以外では無視される」**。日付つきで、用途が 1 つしかないことを明記している。ルーティングとは無関係なのに `router.Config` にいる理由が分かる。

### 経路をまとめる装飾

```go title="wgengine/router/consolidating_router.go"
// ConsolidatingRoutes wraps a Router with logic that consolidates Routes
// whenever Set is called. It attempts to consolidate cfg.Routes into the
// smallest possible set.
func ConsolidatingRoutes(logf logger.Logf, router Router) Router {
	return &consolidatingRouter{Router: router, logf: logger.WithPrefix(logf, "router: ")}
}
```

```go title="wgengine/router/consolidating_router.go"
	var builder netipx.IPSetBuilder
	for _, route := range cfg.Routes {
		builder.AddPrefix(route)
	}
	set, err := builder.IPSet()
	if err != nil {
		cr.logf("consolidateRoutes failed, keeping existing routes: %s", err)
		return cfg
	}
	newRoutes := set.Prefixes()
	oldLength := len(cfg.Routes)
	newLength := len(newRoutes)
	if oldLength == newLength {
		// Nothing consolidated, return as-is.
		return cfg
	}
	cr.logf("consolidated %d routes down to %d", oldLength, newLength)
```

[`consolidating_router.go#L10-L57`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/router/consolidating_router.go#L10-L57)。

**`Router` を包む `Router` として実装されている。** デコレータパターンで、経路の統合という関心事が独立している。

隣接する `/32` が 2 つあれば `/31` 1 本にまとめられる。**OS のルーティングテーブルに入れる経路の数が減れば、更新が速くなる。** 数千ノードの tailnet では効く。

**失敗したら元の設定をそのまま使う。** 最適化が失敗しても機能は失われない。

`oldLength == newLength` なら **元のスライスをそのまま返す** ので、無駄なコピーもしない。

### ファイアウォールの種類を判定する

```go title="util/linuxfw/detector.go"
func detectFirewallMode(logf logger.Logf, prefHint string) FirewallMode {
	if distro.Get() == distro.Gokrazy {
		// Reduce startup logging on gokrazy. There's no way to do iptables on
		// gokrazy anyway.
		logf("GoKrazy should use nftables.")
		hostinfo.SetFirewallMode("nft-gokrazy")
		return FirewallModeNfTables
	}
	if distro.Get() == distro.JetKVM {
		// JetKVM doesn't have iptables.
		hostinfo.SetFirewallMode("nft-jetkvm")
		return FirewallModeNfTables
	}

	mode := envknob.String("TS_DEBUG_FIREWALL_MODE")
	// If the envknob isn't set, fall back to the pref suggested by c2n or
	// nodeattrs.
	if mode == "" {
		mode = prefHint
		logf("using firewall mode pref %s", prefHint)
	} else if prefHint != "" {
		logf("TS_DEBUG_FIREWALL_MODE set, overriding firewall mode from %s to %s", prefHint, mode)
	}
```

[`detector.go#L20-L41`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/linuxfw/detector.go#L20-L41)。

**判定の優先順位が 4 段ある。**

1. 特定のディストリビューション (Gokrazy、JetKVM) — 決め打ち
2. 環境変数 `TS_DEBUG_FIREWALL_MODE`
3. control server からの指示 ([c2n](../c2n/) または nodeattr 経由)
4. 自動判定

**3 番目が [遠隔ノブ](../netmap-apply/)** だ。「このユーザーの環境では nftables にしてほしい」をサーバから指示できる。しかも [c2n の `POST /netfilter-kind`](../c2n/) で即座に切り替えられる。

そして「環境変数がセットされていて、かつサーバの指示もある」場合は、**どちらで上書きしたかをログに出す**。

### ルールの数を数えて推定する

```go title="util/linuxfw/detector.go"
	iptAva, nftAva := true, true
	iptRuleCount, err := det.iptDetect()
	if err != nil {
		logf("detect iptables rule: %v", err)
		iptAva = false
	}
	nftRuleCount, err := det.nftDetect()
	if err != nil {
		logf("detect nftables rule: %v", err)
		nftAva = false
	}
	logf("nftables rule count: %d, iptables rule count: %d", nftRuleCount, iptRuleCount)
	switch {
	case nftRuleCount > 0 && iptRuleCount == 0:
		logf("nftables is currently in use")
		hostinfo.SetFirewallMode("nft-inuse")
		return FirewallModeNfTables
	case iptRuleCount > 0 && nftRuleCount == 0:
		logf("iptables is currently in use")
		hostinfo.SetFirewallMode("ipt-inuse")
```

[`detector.go#L119-L138`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/linuxfw/detector.go#L119)。

**「システムが今どちらを使っているか」を、ルールの数から推定する。**

コマンドの存在確認だけでは足りない。現代の Linux では **`iptables` コマンドが `nftables` のバックエンドを叩く互換レイヤ (`iptables-nft`)** であることも多く、「コマンドがある = iptables が使われている」ではない。

**「ルールが入っているほう」が実際に使われている。** そしてどちらにもルールがある場合、どちらにもない場合は、それぞれ別の分岐になる。

### 判定を検証可能にする

```go title="util/linuxfw/detector.go"
// tableDetector abstracts helpers to detect the firewall mode.
// It is implemented for testing purposes.
type tableDetector interface {
	iptDetect() (int, error)
	nftDetect() (int, error)
}
```

[`detector.go#L78-L83`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/linuxfw/detector.go#L78-L83)。

**「ルールを数える」という副作用のある操作をインターフェースにして、テストで差し替えられる。** 「iptables に 5 個、nftables に 0 個ならこう判定する」を、実際のシステムなしでテストできる。

### 判定結果を報告する

`hostinfo.SetFirewallMode` に渡される文字列の一覧。

| 値                            | 意味                                        |
| ----------------------------- | ------------------------------------------- |
| `nft-gokrazy`                 | Gokrazy なので nftables                     |
| `nft-jetkvm`                  | JetKVM なので nftables                      |
| `nft-forced` / `ipt-forced`   | 明示的に指定された                          |
| `nft-inuse` / `ipt-inuse`     | ルール数から推定                            |
| `nft-default` / `ipt-default` | どちらとも決まらず既定                      |
| `nft-noipt`                   | iptables のサポートがビルドに含まれていない |

**この文字列は [Hostinfo](../map-longpoll/) として control server に送られる。**

集計すれば、**「全ユーザーのうち何 % が nftables を使っているか」「自動判定が働かず既定に落ちたのは何 % か」** が分かる。iptables のサポートをいつ削れるか、という判断の材料になる。

**判定ロジックにコメントを書くだけでなく、判定結果を集計可能にしている。**

## なぜそうなっているか

### なぜインターフェースを 3 メソッドに絞るのか

OS のネットワークスタックを操作する方法は、OS ごとにまったく違う。

- Linux: netlink ソケット、iptables/nftables のコマンドまたはライブラリ
- macOS: `route` コマンド、`scutil`、Network Extension の API
- Windows: WinAPI (`IPHelper`)、WFP (Windows Filtering Platform)
- BSD: route ソケット、`pf` または `ipfw`

**共通点を探して抽象化しようとすると、最小公倍数の巨大なインターフェースになる。**

「あるべき状態を渡す」1 メソッドにすれば、**差分の計算も、順序も、失敗時の扱いも、全部実装側に閉じる**。呼び出し側は宣言するだけでよい。

代償は、各実装が大きくなること。`nftables_runner.go` は 77 KB ある。**だがそれは、OS ごとの違いが本質的にその量だからだ。**

### なぜ両方のファイアウォールを実装するのか

移行期の Linux には両方が存在する。

- 古いディストリビューション (CentOS 7 など) は iptables のみ
- 新しいディストリビューションは nftables が標準
- Docker は今も iptables を使うことが多い
- `iptables-nft` という互換レイヤもある

**「どちらか一方に決める」ができない。** ユーザーの環境を選べないソフトウェアの宿命だ。

そして **両方に混在すると壊れる**。iptables のルールと nftables のルールが同じパケットを違う判断で処理すると、経路が予測できなくなる。だから「システムが今どちらを使っているか」に合わせる。

### なぜコマンドの有無ではなくルール数を数えるのか

`iptables` コマンドの存在は、何も保証しない。

- **`iptables-nft`**: コマンドは `iptables` だが、実体は nftables のルールを作る
- **コマンドがあるが使われていない**: パッケージが入っているだけ
- **コマンドがないが nftables は使われている**: 最小構成のコンテナ

**「実際にルールが入っているか」が、システムが何を使っているかの最も直接的な証拠だ。**

これは一般的な教訓を含む。**環境を推測するとき、「その道具が存在するか」ではなく「その道具が使われた痕跡があるか」を見る。**

### なぜ判定結果を文字列でサーバに送るのか

判定ロジックには分岐が 10 個近くある。どの分岐に落ちたかは、**その環境でしか分からない**。

開発者が知りたいのは、

- **自動判定が意図どおり働いているか** (`inuse` が多いか、`default` に落ちているか)
- **どちらのバックエンドが主流か** (iptables のコードをいつ削れるか)
- **特定のディストリビューションで問題が起きていないか**

**ログを出すだけでは、開発者は見られない。** ユーザーが問題を報告してくれた場合だけだ。Hostinfo として送れば、**問題が報告されていない環境の分布も分かる。**

文字列の設計も実用的だ。`nft-` / `ipt-` の接頭辞で結果が分かり、後半で理由が分かる。**1 つのフィールドで 2 次元の情報を持つ。**

### なぜ経路の統合が別の Router になっているのか

経路をまとめる処理は、**すべての OS 実装に共通して有効** だ。各実装に書くと 6 回書くことになる。

`Router` を包む `Router` にすれば、1 か所で済み、**どの実装と組み合わせても効く**。しかも「統合をやめたい」ときは包むのをやめるだけでよい。

これは Go の埋め込みが効く例だ。`consolidatingRouter` は `Router` を埋め込んでいるので、`Set` 以外のメソッドは自動的に委譲される。**上書きしたい 1 メソッドだけを書けばよい。**

## どう活かすか

**OS 依存の操作は「あるべき状態を渡す」1 メソッドに絞る。** 差分の計算、実行順序、部分失敗の扱いを実装側に閉じ込められる。共通点を探して細かいメソッドに割ると、どの OS にも合わない抽象になる。

**「同じ設定で複数回呼ばれてもよい」を契約に書く。** 呼び出し側の重複排除に依存すると、経路が増えたときに壊れる。冪等性を実装側の責任にすれば、呼び出し側は気にしなくてよい。

**プラットフォーム固有のフィールドは、無理に抽象化せず「これは Linux 専用」と書いて同居させる。** 抽象化のための型階層を作るより、コメント 1 行のほうが読みやすいことがある。

**環境の推定は「道具の存在」ではなく「使われた痕跡」で行う。** コマンドがあることは、それが使われていることを意味しない。互換レイヤがあると、存在確認は特に当てにならない。

**自動判定のロジックは、判定結果を集計可能な形で報告する。** ログは問題が報告されたときしか見られない。テレメトリとして送れば、**問題が起きていない環境の分布も分かり、「いつ古い実装を削れるか」の判断ができる。**

**判定結果の文字列は、「結果」と「理由」の両方を含める。** `nft-inuse` と `nft-default` は同じ結果だが、意味がまったく違う。1 つのフィールドで 2 次元を表現できる。

**副作用のある検出処理はインターフェースにして、テストで差し替える。** 「ルールが 5 個あったらどう判定するか」は、実際のシステムなしでテストできるべきだ。

**すべての実装に共通する処理は、インターフェースを包む実装として書く。** Go の埋め込みなら、上書きするメソッドだけを書けば残りは委譲される。
