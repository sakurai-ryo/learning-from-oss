---
title: "100.100.100.100 に住むリゾルバ"
description: "MagicDNS はスタブリゾルバで、ノード名を netmap から引き、それ以外は上流に転送する。TTL は 5 秒 — 情報源がメモリ上にあるので再問い合わせがほぼ無料な一方、下流のキャッシュがノード名の変更を遅らせるからだ。名前があってレコードがないときは NXDOMAIN ではなく空の成功を返す。"
group: "DNS"
sidebar:
  order: 31
---

## 何を学んだか

### 名前解決を横取りする

`node-name.tailnet-name.ts.net` という名前が引けるのは、**Tailscale が自前の DNS リゾルバを持ち、OS の DNS 設定をそこに向けている** からだ。

リゾルバは `100.100.100.100` (IPv6 では `fd7a:115c:a1e0::53`) で待ち受ける。**このアドレスは実在するホストではなく、[netstack](../netstack/) または [TUN のフック](../tstun/) が受け取る。**

### 3 段階の解決

```go
// Given a Config, queries are resolved in the following order:
// If the query is an exact match for an entry in LocalHosts, return that.
// Else if the query suffix matches an entry in LocalDomains, return NXDOMAIN.
// Else forward the query to the most specific matching entry in Routes.
// Else return SERVFAIL.
```

1. **ローカルのホスト表に完全一致** → その IP を返す
2. **権威を持つドメインの配下** → NXDOMAIN (存在しない)
3. **それ以外** → 最も具体的にマッチする上流のリゾルバへ転送

### TTL が異様に短い

肯定的な応答の TTL が **5 秒**、否定的な応答が **10 秒**。通常の DNS は数分から数時間だ。

理由がコメントに書かれている。

> 情報源 (netmap が供給するホストマップ) はローカルかつメモリ上にあるので、**再問い合わせはほぼ無料**だ。一方、下流でキャッシュされたもの (macOS の mDNSResponder など) は、**ノード名の変更にクライアントが気づくのを TTL のぶん遅らせる**。

### 名前はあるがレコードがない場合

`AAAA` を問い合わせたが、そのノードには IPv6 アドレスがない。このとき返すのは **NXDOMAIN ではなく、「成功、ただしデータなし」** だ。

これは DNS の意味論として正しい。NXDOMAIN は「その名前自体が存在しない」で、名前は存在するがそのタイプのレコードがない場合とは別物になる。

## ソースコードのどこか

### スタブリゾルバ

```go title="net/dns/resolver/tsdns.go"
// Package resolver implements a stub DNS resolver that can also serve
// records out of an internal local zone.
package resolver

const dnsSymbolicFQDN = "magicdns.localhost-tailscale-daemon."

// maxResponseBytes is the maximum size of a response from a Resolver. The
// actual buffer size will be one larger than this so that we can detect
// truncation in a platform-agnostic way.
const maxResponseBytes = 4095
```

[`tsdns.go#L4-L17`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L4-L17)。

**バッファを上限より 1 バイト大きく確保する。** 応答が上限ちょうどのとき、「収まった」のか「切り詰められた」のかを区別できない。1 バイト余分に取れば、**書き込み後のサイズを見るだけで判定できる**。

「プラットフォーム非依存な方法で切り詰めを検出する」とあるのは、OS ごとの API が「バッファに収まらなかった」をエラーで返したり返さなかったりするからだ。

### TTL の判断

```go title="net/dns/resolver/tsdns.go"
// defaultTTL is the TTL of positive responses from Resolver.
//
// It's short because the source of truth (the netmap-fed host maps)
// is local and in-memory, so re-queries are nearly free, while
// anything cached downstream (e.g. mDNSResponder on macOS) delays
// clients noticing node renames for the full TTL (tailscale/corp#45631).
const defaultTTL = 5 * time.Second

// negativeTTL is how long resolvers may cache the nonexistence of a
// name (or of records of the queried type) for domains we're
// authoritative for. It's advertised via the SOA record attached to
// the authority section of NXDOMAIN and no-data responses, per RFC
// 2308. Without it, some resolvers (notably mDNSResponder) seem to
// cache negative entries for a really long time, so a name queried
// shortly before a node rename doesn't start resolving for a while
// (tailscale/corp#45631).
const negativeTTL = 10 * time.Second
```

[`tsdns.go#L20-L68`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L20-L68)。

**否定応答の TTL は、SOA レコードで伝える。** RFC 2308 の仕組みで、「この名前は存在しない」の有効期間を明示する。

コメントによれば、**これを付けないと macOS の mDNSResponder が否定応答を非常に長くキャッシュする**。ノードを追加する直前にその名前を引いてしまったユーザーは、しばらく解決できないままになる。

**「明示的に指定しないと、実装依存の挙動になる」箇所を見つけて、明示する。** DNS のような古いプロトコルでは、この種の落とし穴が多い。

### 設定の構造

```go title="net/dns/resolver/tsdns.go"
type Config struct {
	// Routes is a map of DNS name suffix to the resolvers to use for
	// queries within that suffix.
	// Queries only match the most specific suffix.
	// To register a "default route", add an entry for ".".
	Routes map[dnsname.FQDN][]*dnstype.Resolver
	// LocalHosts is a map of FQDNs to corresponding IPs.
	Hosts map[dnsname.FQDN][]netip.Addr
	// LocalDomains is a list of DNS name suffixes that should not be
	// routed to upstream resolvers.
	LocalDomains []dnsname.FQDN
	// SubdomainHosts is a set of FQDNs from Hosts that should also
	// resolve subdomain queries to the same IPs.
	SubdomainHosts set.Set[dnsname.FQDN]
}
```

[`tsdns.go#L89-L111`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L89-L111)。

**`Routes` の「デフォルトルートを登録するには `.` のエントリを追加する」** が、ルーティングテーブルと同じ構造になっている。`0.0.0.0/0` に相当するのが `.` (DNS のルート)。

**最長一致で選ぶ** のも同じだ。`internal.example.com` へのクエリは、`example.com` より `internal.example.com` のエントリを優先する。

`SubdomainHosts` は、**あるノードへの `*.node.tailnet.ts.net` をすべてそのノードに解決させる** ための設定だ。[serve](../serve-funnel/) でサブドメインを使う場合に要る。

### 解決の本体

```go title="net/dns/resolver/tsdns.go"
	addrs, found := hosts[domain]
	if !found && magicHosts != nil {
		addrs, found = magicHosts.LookupHost(domain)
	}
	if !found {
		for parent := domain.Parent(); parent != ""; parent = parent.Parent() {
			if subdomainHosts.Contains(parent) {
				addrs, found = hosts[parent]
				break
			}
			...
		}
	}
	if !found {
		for _, suffix := range localDomains {
			if suffix.Contains(domain) {
				// We are authoritative for the queried domain.
				metricDNSResolveLocalErrorMissing.Add(1)
				return netip.Addr{}, dns.RCodeNameError
			}
		}
		// Not authoritative, signal that forwarding is advisable.
		metricDNSResolveLocalErrorRefused.Add(1)
		return netip.Addr{}, dns.RCodeRefused
	}
```

[`tsdns.go#L755-L782`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L755)。

**`RCodeNameError` (NXDOMAIN) と `RCodeRefused` の使い分けが要点だ。**

- **権威を持つドメインの配下なのに見つからない** → NXDOMAIN。「そんな名前はない」と断言する
- **権威を持たないドメイン** → REFUSED。上位の呼び出し元がこれを見て、**上流に転送する**

`Refused` は本来クライアントに返すコードだが、ここでは **内部的なシグナル** として使われている。呼び出し元の `Query` がこれを受けて転送に回す。

### レコードがない場合の応答

```go title="net/dns/resolver/tsdns.go"
	// Refactoring note: this must happen after we check suffixes,
	// otherwise we will respond with NOTIMP to requests that should be forwarded.
	//
	// DNS semantics subtlety: when a DNS name exists, but no records
	// are available for the requested record type, we must return
	// RCodeSuccess with no data, not NXDOMAIN.
	switch typ {
	case dns.TypeA:
		for _, ip := range addrs {
			if ip.Is4() {
				metricDNSResolveLocalOKA.Add(1)
				return ip, dns.RCodeSuccess
			}
		}
		metricDNSResolveLocalNoA.Add(1)
		return netip.Addr{}, dns.RCodeSuccess
```

[`tsdns.go#L784-L800`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L784)。

**2 つのコメントが違う種類の注意を伝えている。**

**1 つ目は「リファクタリングの注意」。** 「これはサフィックスの検査の後に来なければならない。さもないと、転送すべきリクエストに NOTIMP を返してしまう」。**コードの順序に意味があることを、順序を変えようとする人に伝えている。**

**2 つ目は「DNS の意味論の機微」。** 名前は存在するがそのタイプのレコードがない場合、**NXDOMAIN ではなく「成功 + データなし」** を返す。

この違いは実務で効く。NXDOMAIN を返すと、**リゾルバは「この名前は存在しない」とキャッシュする**。IPv6 を持たないノードに `AAAA` を引いた結果 NXDOMAIN が返ると、**その後の `A` クエリまで失敗する実装がある**。

### 自分自身への逆引き

```go title="net/dns/resolver/tsdns.go"
	// We return a symbolic domain if someone does a reverse lookup on the
	// DNS endpoint. To round out this special case, we also do the inverse
	// (returning the endpoint IP if someone looks up the symbolic domain).
	if domain == dnsSymbolicFQDN {
		switch typ {
		case dns.TypeA:
			return tsaddr.TailscaleServiceIP(), dns.RCodeSuccess
		case dns.TypeAAAA:
			return tsaddr.TailscaleServiceIPv6(), dns.RCodeSuccess
		}
	}
```

[`tsdns.go#L733-L743`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L733)。

**`100.100.100.100` を逆引きすると `magicdns.localhost-tailscale-daemon.` が返り、その名前を引くと `100.100.100.100` が返る。**

診断ツール (`dig`、`nslookup`、`resolvectl`) がリゾルバのアドレスを逆引きしたとき、**「これは Tailscale の MagicDNS だ」と分かる名前が出る**。名前を見れば、それが何なのかが説明されている。

**「デバッグする人が見る文字列」を、実装の一部として設計している。**

### .onion を拒否する

```go title="net/dns/resolver/tsdns.go"
	// Reject .onion domains per RFC 7686.
	if dnsname.HasSuffix(domain.WithoutTrailingDot(), ".onion") {
		metricDNSResolveLocalErrorOnion.Add(1)
		return netip.Addr{}, dns.RCodeNameError
	}
```

[`tsdns.go#L727-L731`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L727-L731)。

**RFC 7686 は「`.onion` の名前を通常の DNS で解決してはならない」と定めている。** 解決しようとすると、Tor で秘匿されるべきアクセス先が **平文の DNS クエリとして上流に漏れる**。

**標準が「してはならない」と定めていることを、明示的に拒否する。** 転送してしまうと、ユーザーの匿名性が壊れる。

### 転送への切り替え

```go title="net/dns/resolver/tsdns.go"
	out, err := r.respond(bs)
	if err == errNotOurName {
		responses := make(chan packet, 1)
		ctx, cancel := context.WithTimeout(ctx, dnsQueryTimeout)
		defer close(responses)
		defer cancel()
		err = r.forwarder.forwardWithDestChan(ctx, packet{bs, family, from}, responses)
		if err != nil {
			return nil, err
		}
		return (<-responses).bs, nil
	}
```

[`tsdns.go#L420-L431`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L420)。

**`errNotOurName` という番兵エラーで、ローカル解決と転送を分ける。**

転送はチャネル経由で行われる。**複数の上流に並行して投げ、最初に返ってきたものを使う** ためだ ([split DNS のページ](../split-dns/))。

### ログから雑音を除く

```go title="net/dns/resolver/tsdns.go"
// WriteToBufioWriter write a debug version of c for logs to w, omitting
// spammy stuff like *.arpa entries and replacing it with a total count.
func (c *Config) WriteToBufioWriter(w *bufio.Writer) {
	...
	for _, d := range c.LocalDomains {
		if strings.HasSuffix(string(d), ".arpa.") {
			arpa++
			continue
		}
		...
	}
	w.WriteString("]")
	if arpa > 0 {
		fmt.Fprintf(w, "+%darpa", arpa)
	}
```

[`tsdns.go#L113-L140`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/resolver/tsdns.go#L113)。

**逆引き用の `.arpa` ドメインは数だけ出して、中身を省く。**

tailnet の全ノードに対して逆引きのエントリができるので、1,000 ノードなら 1,000 件。**設定をログに出すたびにこれが並ぶと、他の情報が読めなくなる。**

`+1000arpa` と書けば、**情報は失わずに 1 行に収まる**。[netcheck の簡潔ログ](../reachability-observability/) と同じ発想だ。

## なぜそうなっているか

### なぜスタブリゾルバなのか

完全な DNS リゾルバ (再帰的にルートから辿る) を実装すると、DNSSEC の検証、キャッシュ、ルートヒントの管理が必要になる。**数万行の仕事だ。**

Tailscale が必要とするのは、

- **tailnet のノード名を解決する** (数百〜数千のエントリ、メモリ上)
- **それ以外は既存のリゾルバに任せる**

**スタブリゾルバ (自分が知っているものだけ答え、残りは転送する) で足りる。** 責務を最小にすることで、実装が数千行に収まっている。

### なぜ TTL を 5 秒にするのか

DNS の TTL は「上流への問い合わせを減らす」ための仕組みだ。**上流が遠く、問い合わせが高価だから長くする。**

MagicDNS の「上流」は、同じプロセスのメモリ上のマップだ。**問い合わせのコストはほぼゼロ。** キャッシュする利点がない。

一方でコストはある。**ノード名が変わったとき、下流のキャッシュ (OS のリゾルバ、アプリケーション) が古い答えを保持し続ける。** TTL が 300 秒なら、5 分間古い IP を使う。

**「キャッシュの利益がゼロで、コストがある」なら、TTL は可能な限り短くする。** 0 にしないのは、極端に短い TTL を無視する実装があるためだろう。

### なぜ NXDOMAIN と REFUSED を使い分けるのか

DNS のレスポンスコードには意味がある。

- **NXDOMAIN**: この名前は存在しない。**権威サーバだけが言える**
- **REFUSED**: 答えることを拒否する。権威がない、ポリシー上答えない

MagicDNS は `*.ts.net` については権威を持つ。だから `nonexistent.tailnet.ts.net` には NXDOMAIN を返せる。

`example.com` については権威がない。ここで NXDOMAIN を返すと、**「example.com は存在しない」という嘘** をつくことになる。

内部的にも、この区別が転送の判断に使われている。**プロトコルの意味論を正しく使うと、内部の制御フローとしても機能する。**

### なぜバッファを 1 バイト多く取るのか

DNS の応答を作るとき、UDP なら 512 バイト (EDNS0 なら 4096) の制限がある。超えたら **TC ビット (truncated) を立てて、クライアントに TCP で再問い合わせさせる**。

「収まったか」を判定するには、**上限を超えたことを検出する必要がある**。ちょうど上限のバッファを渡すと、「ぴったり収まった」と「溢れた」が区別できない — 多くの API は「書けた分だけ書いて成功を返す」からだ。

1 バイト多く渡せば、**「上限 + 1 バイト書けた」= 溢れた** と判定できる。

**「境界を検出するために、境界の外側を 1 つ用意する」** という定石で、番兵 (sentinel) の一種と言える。

### なぜ `.onion` を拒否するのか

Tor の `.onion` アドレスは、**Tor ネットワーク内でのみ解決されるべき** 名前だ。

通常の DNS リゾルバに `.onion` を投げると、

- **上流のリゾルバに、アクセスしようとしているサイトが漏れる**
- **ISP や DNS プロバイダのログに残る**
- 匿名性が目的なのに、目的が破られる

RFC 7686 は、これを防ぐために「DNS ソフトウェアは `.onion` を解決してはならない」と定めた。

**「標準が禁止していること」を実装するのは、たった 4 行だ。** そして書かなければ、ユーザーの匿名性が黙って壊れる。

## どう活かすか

**キャッシュの TTL は「上流への問い合わせコスト」と「変更の伝播遅延」のトレードオフで決める。** 上流がメモリ上なら、TTL は最短でよい。「DNS だから 300 秒」のような慣習的な値ではなく、**自分の情報源の性質から決める**。

**エラーコードの意味論を正しく使うと、内部の制御フローとしても使える。** NXDOMAIN と REFUSED の区別が、そのまま「答える / 転送する」の判断になる。プロトコルの設計者が意図した区別は、たいてい実装にとっても有用だ。

**「名前はあるがデータがない」と「名前がない」を区別する。** DNS だけでなく、HTTP の 404 と 204、データベースの「行なし」と「NULL」も同じ構図だ。**混同すると、下流の実装が誤ったキャッシュをする。**

**境界の検出には、境界の外側を 1 つ用意する。** バッファを 1 バイト多く取る、配列を 1 要素多く確保する、上限を 1 つ超えた値を試す。「ちょうど収まった」と「溢れた」を区別できる。

**標準が「してはならない」と定めていることは、明示的に拒否する。** 4 行で済み、書かなければユーザーに被害が出る。RFC を読むときは、MUST NOT の項目を実装しているか確認する。

**デバッグする人が見る文字列を、実装の一部として設計する。** `magicdns.localhost-tailscale-daemon.` は、それを見た人が「これは何か」を理解できる名前だ。逆引きの結果、エラーメッセージ、ログのプレフィックス — どれも読み手がいる。

**ログに出す設定は、繰り返しの多い部分を件数に畳む。** `.arpa` エントリ 1,000 件を `+1000arpa` にすれば、情報を失わずに読める長さになる。

**コードの順序に意味があるなら、「これはこの後でなければならない」とコメントに書く。** リファクタリングで順序が変わったときに、なぜ壊れたかが分かる。
