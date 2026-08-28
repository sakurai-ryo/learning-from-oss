---
title: "自分が繋がる前に、control server の名前を引く"
description: "システムの DNS が壊れていたら、controlplane.tailscale.com を引けず、何も始まらない。Tailscale はバイナリに DERP サーバの IP を焼き込み、そこに HTTPS で「この名前の IP を教えて」と聞く。焼き込みのデータは、リポジトリのスクリプトが本番から取得して更新する。"
group: "DNS"
sidebar:
  order: 34
---

## 何を学んだか

### 起動時の鶏と卵

Tailscale が起動するには、`controlplane.tailscale.com` に繋がる必要がある。そのためには名前解決が要る。

だが名前解決ができない状況がある。

- **システムの DNS サーバが壊れている / 到達できない**
- **前回の Tailscale が設定を書き換えた状態で異常終了し、`100.100.100.100` を指したまま残っている**
- **ネットワークに繋がったばかりで、DHCP の DNS 設定がまだ来ていない**
- **キャプティブポータルの内側で、偽の応答が返る**

**Tailscale が動いていないと DNS が直らないが、DNS がないと Tailscale が動かない。**

### 焼き込んだ IP から HTTPS で聞く

解決策は 3 段だ。

1. **DERP サーバの IP アドレスを、JSON としてバイナリに埋め込む** (`dns-fallback-servers.json`、5.7 KB)
2. その IP に **HTTPS で直接接続** する (名前解決を使わない)
3. `https://derpN.tailscale.com/bootstrap-dns?q=controlplane.tailscale.com` に GET して、**JSON で IP を教えてもらう**

**DERP サーバが、DNS サーバも兼ねている。**

### 焼き込みデータの更新もコードで

`update-dns-fallbacks.go` という小さなプログラムが、**本番の DERP マップを取得して JSON を書き出す**。

```sh
(cd net/dnsfallback; go run update-dns-fallbacks.go)
```

そして **リージョン名を `r1`、`r2` のような無意味な値に置き換えてから** 保存する。

### 候補は v4/v6 を交互に、シャッフルして 6 個

DERP サーバは数十ある。全部試すのは遅い。**IPv4 と IPv6 の候補をそれぞれシャッフルし、交互に取って最大 6 個** を試す。

## ソースコードのどこか

### パッケージの目的と更新方法

```go title="net/dnsfallback/dnsfallback.go"
// Package dnsfallback contains a DNS fallback mechanism
// for starting up Tailscale when the system DNS is broken or otherwise unavailable.
//
// The data is backed by a JSON file `dns-fallback-servers.json` that is updated
// by `update-dns-fallbacks.go`:
//
//	(cd net/dnsfallback; go run update-dns-fallbacks.go)
package dnsfallback
```

[`dnsfallback.go#L4-L11`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dnsfallback/dnsfallback.go#L4-L11)。

**データの更新方法が、パッケージのドキュメントにコマンドとして書かれている。**

埋め込みデータは古くなる。DERP サーバの IP が変われば、フォールバックが効かなくなる。**「どうやって更新するか」がドキュメントの最初にあれば、リリース作業の手順に組み込める。**

### 更新プログラム

```go title="net/dnsfallback/update-dns-fallbacks.go"
//go:build ignore

package main

func main() {
	res, err := http.Get("https://login.tailscale.com/derpmap/default")
	...
	for rid, r := range dm.Regions {
		// Names misleading to check into git, as this is a
		// static snapshot and doesn't reflect the live DERP
		// map.
		r.RegionCode = fmt.Sprintf("r%d", rid)
		r.RegionName = r.RegionCode
	}
	out, err := json.MarshalIndent(dm, "", "\t")
	...
	if err := os.WriteFile("dns-fallback-servers.json", out, 0644); err != nil {
```

[`update-dns-fallbacks.go`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dnsfallback/update-dns-fallbacks.go)。

**`//go:build ignore` で、通常のビルドから除外されている。** `go run` で明示的に実行するときだけ動く。ツール用のディレクトリを作らず、使う場所の隣に置ける。

**リージョン名を潰す理由が書かれている。** 「名前を git にコミットするのは誤解を招く。これは静的なスナップショットであり、生きた DERP マップを反映していないから」。

`"Tokyo"` や `"Frankfurt"` という名前が入っていると、**それが現在のリージョン構成だと思われる**。`r1`、`r2` なら、**「これは単なる ID で、意味はない」** と分かる。

**古くなるデータには、古くなることが分かる形を与える。**

### 候補の選び方

```go title="net/dnsfallback/dnsfallback.go"
	var cands4, cands6 []nameIP
	for _, dr := range dm.Regions {
		for _, n := range dr.Nodes {
			if ip, err := netip.ParseAddr(n.IPv4); err == nil {
				cands4 = append(cands4, nameIP{n.HostName, ip})
			}
			if ip, err := netip.ParseAddr(n.IPv6); err == nil {
				cands6 = append(cands6, nameIP{n.HostName, ip})
			}
		}
	}
	slicesx.Shuffle(cands4)
	slicesx.Shuffle(cands6)

	const maxCands = 6
	var cands []nameIP // up to maxCands alternating v4/v6 as long as we have both
	for (len(cands4) > 0 || len(cands6) > 0) && len(cands) < maxCands {
		if len(cands4) > 0 {
			cands = append(cands, cands4[0])
			cands4 = cands4[1:]
		}
		if len(cands6) > 0 {
			cands = append(cands, cands6[0])
			cands6 = cands6[1:]
		}
	}
```

[`dnsfallback.go#L78-L102`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dnsfallback/dnsfallback.go#L78-L102)。

**3 つの工夫がある。**

**1. シャッフルする。** 全クライアントが同じ順序で試すと、**リストの先頭のサーバに負荷が集中する**。シャッフルすれば分散する。

**2. v4 と v6 を交互に取る。** IPv6 が使えない環境、IPv4 が使えない環境の両方がある。交互なら、**どちらの環境でも 6 個のうち 3 個は試せる**。片方に寄せると、6 個全部が無駄になる可能性がある。

**3. 6 個で打ち切る。** 各候補に 3 秒のタイムアウトがあるので、最悪 18 秒。全部試すと数分かかる。

### 名前解決を使わずに HTTPS

```go title="net/dnsfallback/dnsfallback.go"
func bootstrapDNSMap(ctx context.Context, serverName string, serverIP netip.Addr, queryName string, ...) (dnsMap, error) {
	dialer := netns.NewDialer(logf, netMon)
	tr := netutil.NewDefaultTransport()
	tr.DisableKeepAlives = true // This transport is meant to be used once.
	tr.Proxy = feature.HookProxyFromEnvironment.GetOrNil()
	tr.DialContext = func(ctx context.Context, netw, addr string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp", net.JoinHostPort(serverIP.String(), "443"))
	}
	tr.TLSClientConfig = tlsdial.Config(ht, tr.TLSClientConfig)
	c := &http.Client{Transport: tr}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://"+serverName+"/bootstrap-dns?q="+url.QueryEscape(queryName), nil)
```

[`dnsfallback.go#L133-L146`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dnsfallback/dnsfallback.go#L133)。

**`DialContext` を差し替えて、渡されたアドレスを無視し、常に `serverIP:443` に繋ぐ。**

URL は `https://derpN.tailscale.com/...` のままにしておく。すると、

- **TLS の SNI とホスト名の検証が、正しいホスト名で行われる**。証明書は本物か確認できる
- **HTTP の Host ヘッダも正しくなる**

**「接続先の IP は自分で決めるが、名前としての検証は正規に行う」** という形だ。証明書の検証を無効にする必要がない。

`DisableKeepAlives` が付いているのは「このトランスポートは 1 回しか使わない」から。フォールバックは起動時の 1 回きりだ。

### 静的データと動的データを混ぜる

```go title="net/dnsfallback/dnsfallback.go"
// GetDERPMap returns a fallback DERP map that is always available, useful for basic
// bootstrapping purposes. The dynamically updated DERP map in LocalBackend should
// always be preferred over this. Use this DERP map only when the control plane is
// unreachable or hasn't been reached yet. The DERP servers in the returned map also
// run a fallback DNS server.
func GetDERPMap() *tailcfg.DERPMap {
	dm := getStaticDERPMap()

	// Merge in any DERP servers from the cached map that aren't in the
	// static map; this ensures that we're getting new region(s) while not
	// overriding the built-in fallbacks if things go horribly wrong and we
	// get a bad DERP map.
	cached := cachedDERPMap.Load()
	if cached == nil {
		return dm
	}
```

[`dnsfallback.go#L168-L188`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dnsfallback/dnsfallback.go#L168)。

**焼き込んだデータと、前回の実行でキャッシュしたデータを混ぜる。**

- **キャッシュにあって静的データにないリージョン** → 追加する (新しいリージョンが使える)
- **静的データにあるもの** → **上書きしない**

コメントが理由を書いている。**「事態がひどく悪化して、悪い DERP マップを受け取った場合に、組み込みのフォールバックを上書きしないようにする」。**

キャッシュだけを使うと、**control server から壊れた DERP マップを受け取った時点で、次回から起動できなくなる**。静的データを常に残しておけば、必ず復帰の手段がある。

**「更新可能なデータ」と「絶対に変わらないデータ」を両方持ち、後者を上書きさせない。**

### DNS キャッシュの割り切り

```go title="net/dnscache/dnscache.go"
// Package dnscache contains a minimal DNS cache that makes a bunch of
// assumptions that are only valid for us. Not recommended for general use.
package dnscache
```

```go title="net/dnscache/dnscache.go"
// Resolver is a minimal DNS caching resolver.
//
// The TTL is always fixed for now. It's not intended for general use.
```

[`dnscache.go#L4-L6`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dnscache/dnscache.go#L4-L6)。

**「我々にとってのみ妥当な仮定をたくさん置いている。一般的な用途には推奨しない。」**

- TTL は固定 (DNS の応答に入っている TTL を無視する)
- 対象は Tailscale が接続する少数のホストだけ
- 失敗時は古い値を返すことがある

**「汎用でないこと」を明示すると、パッケージの利用者 (社内の他の開発者) が誤って使うのを防げる。** そして実装を単純に保てる。

### Go リゾルバか cgo リゾルバか

```go title="net/dnscache/dnscache.go"
func preferGoResolver() bool {
	// There does not appear to be a local resolver running
	// on iOS, and NetworkExtension is good at isolating DNS.
	// So do not use the Go resolver on macOS/iOS.
	if runtime.GOOS == "darwin" || runtime.GOOS == "ios" {
		return false
	}

	// The local resolver is not available on Android.
	if runtime.GOOS == "android" {
		return false
	}

	// Otherwise, the Go resolver is fine and slightly preferred
	// since it's lighter, not using cgo calls & threads.
	return true
}
```

[`dnscache.go#L18-L34`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dnscache/dnscache.go#L18-L34)。

Go の `net.Resolver` には 2 つの実装がある。

- **Go の実装**: `/etc/resolv.conf` を自分で読み、DNS のパケットを組み立てる。軽い
- **cgo の実装**: libc の `getaddrinfo` を呼ぶ。OS の設定を完全に尊重する

**macOS/iOS では Go の実装が使えない。** システムの DNS 設定は `/etc/resolv.conf` にはなく、`SystemConfiguration` フレームワークにある。Go の実装はそれを読まない。

**Android も同様**で、`/etc/resolv.conf` が存在しない。

**「軽い実装を優先するが、それが OS の設定を見られない環境では重い実装を使う」。** そしてその判定を、プラットフォームごとの短い条件で書く。

## なぜそうなっているか

### なぜ DERP サーバが DNS を兼ねるのか

新しいサーバ群を用意することもできた。だが、

- **DERP サーバは既に世界中に配置されている**。地理的に近いところが見つかる
- **IP アドレスが既にバイナリに焼き込まれている** (DERP マップとして)
- **HTTPS のエンドポイントが既にある**。証明書も設定済み

**追加のインフラを立てずに、既存のサーバにエンドポイントを 1 つ足すだけで済む。**

そして DERP サーバは **クライアントが必ず接続する相手** なので、到達性が高いことが期待できる。塞がれていれば、どのみち Tailscale は使えない。

### なぜ IP を焼き込むのか

「IP を焼き込む」は、普通は避けるべき設計だ。IP は変わる。焼き込んだバイナリは更新できない。

だが **ブートストラップの問題には、どこかで「動的でない何か」が必要** だ。

- 名前を解決するには DNS が要る
- DNS の設定を得るには DHCP か静的設定が要る
- **どこかで「これは固定」という前提を置かないと、始まらない**

Tailscale は「DERP サーバの IP」をその固定点にした。そして **リスクを減らす工夫** を入れている。

- **複数の IP を焼き込む** (数十)。1 つが変わっても他が使える
- **キャッシュとマージする**。新しいリージョンも使える
- **リリースごとに更新する**。スクリプトがある

### なぜ IP を直接使いながら、名前で TLS 検証するのか

`https://1.2.3.4/` に繋いで証明書の検証をパスさせるには、**IP アドレス用の証明書** が要る (稀) か、**検証を無効化する** しかない。

検証を無効化すると、**中間者が偽の DNS 応答を返せる**。フォールバック経路が攻撃経路になる。

`DialContext` で接続先だけを差し替えれば、

- 接続は `1.2.3.4:443` へ
- TLS の SNI とホスト名の検証は `derpN.tailscale.com` で

**「どこに繋ぐか」と「誰であることを確認するか」を分離できる。** これは DNS を信用しない設計の基本形で、DoH や ECH でも同じ構造が使われる。

### なぜ静的データを上書きさせないのか

キャッシュされた DERP マップは、control server から来たものだ。**control server が侵害されたり、バグで壊れたデータを配ったりする可能性がある。**

キャッシュだけを使う設計だと、

1. 壊れた DERP マップを受け取る
2. キャッシュに保存する
3. 次の起動でそのキャッシュを使い、フォールバックに失敗する
4. **control に繋がらないので、修正されたマップを受け取れない**

**復帰不能なループに入る。** 静的データを常に含めておけば、必ず脱出できる。

**「更新可能な設定」を持つシステムでは、「絶対に更新されない最後の砦」を用意する。** ファームウェアのリカバリモード、ブートローダのフォールバック、DNS のルートヒント。すべて同じ構造だ。

### なぜ候補をシャッフルするのか

全クライアントが同じ順序で試すと、**リストの先頭のサーバに全ブートストラップのトラフィックが集まる**。

数百万のクライアントが起動時に同じサーバを叩くと、そのサーバが落ちる。落ちると 2 番目に集まり、順に落ちていく (カスケード障害)。

シャッフルすれば、**負荷が数十のサーバに均等に分散する**。

これは [DERP のキープアライブにジッタを入れる](../derp/) のと同じ、**「全クライアントの同期を避ける」** 設計だ。分散システムでは繰り返し現れる。

### なぜ「一般用途には推奨しない」と書くのか

`dnscache` は TTL を無視し、失敗時に古い値を返す。**汎用の DNS キャッシュとしては明確に間違っている。**

だが Tailscale の用途 (少数の固定ホストへの接続) では、これで十分どころか望ましい。DNS が一時的に壊れても、古い IP で繋がる可能性がある。

**この割り切りをパッケージのドキュメントに書かないと、**「便利な DNS キャッシュがある」と思った人が別の用途に使い、TTL を守らないことによるバグを踏む。

**「このコードが妥当な前提」を明示するのは、内部ライブラリでも重要だ。**

## どう活かすか

**ブートストラップの問題には、どこかに「固定された前提」が要る。** 名前解決、設定の取得、鍵の入手。すべてを動的にすると、循環して始まらない。**何を固定点にするかを意識的に選び、そのリスクを減らす工夫 (複数持つ、更新手段を用意する) を入れる。**

**「どこに繋ぐか」と「誰であることを検証するか」を分離する。** IP を直接指定しつつ、TLS の検証はホスト名で行う。`DialContext` の差し替えでできる。証明書の検証を無効にする必要はない。

**更新可能なデータを持つシステムでは、更新されない最後の砦を残す。** 壊れたデータを受け取っても復帰できる経路がなければ、1 回の事故で永久に起動不能になる。**静的データを「マージするが上書きさせない」形にする。**

**古くなるデータには、古いと分かる形を与える。** リージョン名を `r1` にするのは、情報を捨てているのではなく、**誤解を防いでいる**。「これはスナップショットであり、現状ではない」と型や値で示せると強い。

**埋め込みデータの更新方法を、パッケージのドキュメントに書く。** `go:build ignore` のスクリプトを隣に置き、実行コマンドをドキュメントの最初に書けば、リリース手順に組み込める。

**多数のクライアントが同じリストを使うなら、シャッフルする。** 先頭への集中はカスケード障害を招く。同じ理由で、定期処理にはジッタを入れる。

**「一般用途には推奨しない」と明示すると、単純な実装を保てる。** 汎用にしようとすると TTL の尊重、否定応答のキャッシュ、DNSSEC が必要になる。**用途を限定し、その限定をドキュメントに書けば、100 行で済む。**

**軽い実装を優先しつつ、それが使えない環境を条件で列挙する。** Go のリゾルバは軽いが、macOS/iOS/Android では OS の設定を読めない。**「なぜこの OS では使えないか」を 1 行ずつ書く** と、後から条件を追加・削除する判断ができる。
