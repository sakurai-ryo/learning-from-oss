---
title: "ドメインごとに経路を割り当てる"
description: "「このドメインへの通信はこのノード経由で」を実現するのに、旧実装は DNS 応答を見て経路を動的に追加していた。経路が数万本に膨れる問題を、新実装は「クライアント側の magic IP」と「コネクタ側の transit IP」という 2 段の NAT で解いている。"
group: "その上に載るもの"
sidebar:
  order: 40
---

## 何を学んだか

### ドメイン単位のルーティングという要求

「`*.github.com` への通信は、AWS 上のこのノードを経由させたい」という要求がある。理由は、

- **接続元 IP を固定したい**。SaaS の IP 許可リストに登録するため
- **特定のリソースだけを経由させたい**。[exit node](../subnet-router-exit-node/) だと全部が経由してしまう

だが **ルーティングは IP アドレスで行われ、ドメイン名では行われない**。

### 旧実装: DNS を見て経路を足す

`appc` パッケージのドキュメントが、旧実装の仕組みを説明している。

> App Connector は、ピアにとっての DNS サーバとなり、設定されたドメインの集合に対して権威を持つ。**対象ドメインの DNS 解決が、経路の動的な公開を引き起こす。**

つまり、

1. クライアントが `api.github.com` を引く
2. App Connector が解決し、`140.82.121.6` を返す
3. **同時に「`140.82.121.6/32` は自分経由で」と経路を広告する**
4. クライアントがその IP に接続すると、App Connector を経由する

**動く。だが CDN のドメインを設定すると、経路が数万本になる。**

### 新実装: 2 段の NAT

`feature/conn25` のドキュメントは、目的をこう書く。

> **app connector の「経路が多すぎる」という落とし穴を避ける。**

仕組みは、**実際の宛先 IP を経路に載せず、内部で割り当てた IP に置き換える**。

| 名前           | どこで使うか   | 意味                                |
| -------------- | -------------- | ----------------------------------- |
| **magic IP**   | クライアント内 | アプリケーションに見せる偽の IP     |
| **transit IP** | tailnet 内     | クライアントとコネクタの間で使う IP |
| **real IP**    | コネクタの外   | 本当の宛先                          |

クライアントは magic IP を返し、パケットが出るときに transit IP に書き換える。コネクタは transit IP を受け取り、real IP に書き換えて転送する。

**経路として広告するのは transit IP の範囲だけ** なので、CDN が何万の IP を持っていても経路は 1 本で済む。

## ソースコードのどこか

### 旧実装の設計

```go title="appc/appconnector.go"
// Package appc implements App Connectors.
// An AppConnector provides DNS domain oriented routing of traffic. An App
// Connector becomes a DNS server for a peer, authoritative for the set of
// configured domains. DNS resolution of the target domain triggers dynamic
// publication of routes to ensure that traffic to the domain is routed through
// the App Connector.
package appc
```

[`appconnector.go#L4-L10`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/appc/appconnector.go#L4-L10)。

**「DNS 解決が経路の動的な公開を引き起こす」** — 副作用のある DNS だ。

そして経路の増加を監視する仕組みがある。

```go title="appc/appconnector.go"
// rateLogger responds to calls to update by adding a count for the current period and
// calling the callback if any previous period has finished since update was last called
type rateLogger struct {
	interval    time.Duration
	start       time.Time
	periodStart time.Time
	periodCount int64
	now         func() time.Time
	callback    func(int64, time.Time, int64)
}
```

[`appconnector.go#L16-L25`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/appc/appconnector.go#L16-L25)。

**「一定期間ごとに、経路の追加数を集計してログに出す」** ための型。経路が増えすぎていることを検知するために、専用の仕組みが作られている。

**問題が構造的だと分かっているので、監視を組み込んでいる。**

### 新実装の目的

```go title="feature/conn25/conn25.go"
// Package conn25 registers the conn25 feature and implements its associated ipnext.Extension.
// conn25 will be an app connector like feature that routes traffic for configured domains via
// connector devices and avoids the "too many routes" pitfall of app connector. It is currently
// (2026-02-04) some peer API routes for clients to tell connectors about their desired routing.
package conn25
```

[`conn25.go#L4-L8`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/conn25/conn25.go#L4-L8)。

**「will be」「currently (2026-02-04)」** — 開発途上であることが、日付つきで明記されている。

**未完成のコードに「今はここまで」と書く** のは、読む人にとって重要な情報だ。「なぜこれだけしかないのか」が分かる。

パッケージ名の `conn25` は「connector 2025」だろう。**新旧を区別するために、年を名前に入れている。**

### アドレスの割り当て

```go title="feature/conn25/conn25.go"
type addrs struct {
	dst             netip.Addr
	magic           netip.Addr
	transit         netip.Addr
	domain          dnsname.FQDN
	app             string
	expiresAt       time.Time
	activeFlowCount int
	zeroFlowTime    time.Time
}
```

[`conn25.go#L1607-L1616`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/conn25/conn25.go#L1607-L1616)。

**1 つの割り当てが 3 つの IP を結びつける。**

- `dst` — 本当の宛先 (DNS が答えた IP)
- `magic` — クライアントのアプリケーションに見せる IP
- `transit` — tailnet 内で使う IP

そして `activeFlowCount` と `zeroFlowTime`。**「今この割り当てを使っている接続が何本あるか」「0 本になったのはいつか」** を追跡する。

割り当ては有限なので、**使われなくなったら回収する必要がある**。だが接続中に回収すると通信が切れる。**フロー数が 0 になってから一定時間待つ。**

### 3 つの索引

```go title="feature/conn25/addrAssignments.go"
// domainDst is a key for looking up an existing address assignment by the
// DNS response domain and destination IP pair.
type domainDst struct {
	domain dnsname.FQDN
	dst    netip.Addr
}

// addrAssignments is the collection of addrs assigned by this client
// supporting lookup by magic IP, transit IP or domain+dst, or to lookup all
// transit IPs associated with a given connector (identified by its node key).
type addrAssignments struct {
	byMagicIP   map[netip.Addr]*addrs
	byTransitIP map[netip.Addr]*addrs
	byDomainDst map[domainDst]*addrs
	byExpiresAt addrsHeap
	clock       tstime.Clock
}
```

[`addrAssignments.go#L11-L26`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/conn25/addrAssignments.go#L11-L26)。

**同じデータに 4 つの索引がある。**

- **magic IP から** — パケットが出るとき、magic IP を transit IP に変える
- **transit IP から** — パケットが戻るとき、逆変換する
- **ドメイン + 宛先から** — DNS の応答を作るとき、既存の割り当てを再利用する
- **期限順のヒープ** — 期限切れを効率的に回収する

**アクセスパターンが 4 通りあるので、索引も 4 つ。** [peer relay の 2 索引](../peer-relay/) と同じ考え方だが、こちらはさらに多い。

期限順のヒープは、[エンドポイントトラッカー](../link-change/) と同じ構造だ。

### TTL のクランプ

```go title="feature/conn25/addrAssignments.go"
const defaultExpiry = 48 * time.Hour

func clampExpiryFromTTL(ttl time.Duration) time.Duration {
	const minTTL = time.Minute * 1
	const maxTTL = time.Hour * 72
	expiry := max(minTTL, ttl)
	return min(maxTTL, expiry)
}
```

[`addrAssignments.go#L28-L35`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/conn25/addrAssignments.go#L28-L35)。

**割り当ての有効期間を、DNS の TTL から決める。ただし 1 分〜72 時間にクランプする。**

- **短すぎる TTL** (CDN は 30 秒などを使う) → 割り当てがすぐ消え、再取得が頻発する
- **長すぎる TTL** (1 週間など) → 使われない割り当てが溜まる

**外部から来る値を信用しつつ、範囲を制限する。** [netcheck のしきい値](../netcheck/)、[DERP のキュー](../derp/) と同じで、外部入力には必ず範囲を設ける。

### IP プールの巡回

```go title="feature/conn25/ippool.go"
// ipSetIterator allows for round robin iteration over all the addresses within a netipx.IPSet.
// netipx.IPSet has a Ranges call that returns the "minimum and sorted set of IP ranges that covers [the set]".
// netipx.IPRange is "an inclusive range of IP addresses from the same address family.". So we can iterate over
// all the addresses in the set by keeping a track of the last address we returned, calling Next on the last address
// to get the new one, and if we run off the edge of the current range, starting on the next one, or back at the beginning.
type ipSetIterator struct {
	// ranges defines the addresses in the pool
	ranges []netipx.IPRange
	// last is internal tracking of which the last address provided was.
	last netip.Addr
	// rangeIdx is internal tracking of which netipx.IPRange from the IPSet we are currently on.
	rangeIdx int
}
```

[`ippool.go#L22-L34`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/conn25/ippool.go#L22-L34)。

**アドレスの集合を「範囲のリスト」として持ち、順に巡回する。**

全アドレスをリストにすると、`/16` で 65,536 個になる。**範囲として持てば、数個のエントリで済む。**

そして **ラウンドロビン (使い終わったら次へ、末尾まで来たら先頭に戻る)** で割り当てる。同じアドレスをすぐ再利用しないので、**古い接続が残っていても衝突しにくい**。

これは TCP のポート割り当てや、DHCP のリース割り当てと同じ考え方だ。

エラーの種類も明示的だ。

```go title="feature/conn25/ippool.go"
// errPoolExhausted is returned when there are no more addresses to iterate over.
var errPoolExhausted = errors.New("ip pool exhausted")

// errNotOurAddress is returned if a provided address is not from our pool
var errNotOurAddress = errors.New("not our address")

// errAddrExists is returned if a returned address is already in the returned pool.
var errAddrExists = errors.New("address already returned")
```

[`ippool.go#L11-L20`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/conn25/ippool.go#L11-L20)。

**`errAddrExists` は「二重に返却された」** ことを示す。これはバグの兆候で、**同じアドレスが 2 つのフローに割り当てられうる** ことを意味する。エラーとして検出できるようにしている。

### データパスの契約

```go title="feature/conn25/datapath.go"
// Conn25Datapath is the interface for the surface of [*Conn25] that the datapath
// handler needs. It provides methods for address mapping to help the datapath handler
// implement DNAT/SNAT, and flow lifecycle handlers so that *Conn25 can keep address
// assignments active for active flows.
//
// [*Conn25] is the only production implementation; the interface exists to let
// datapath tests substitute a lightweight fake.
type Conn25Datapath interface {
	// ClientTransitIPForMagicIP returns a Transit IP for the given magicIP on a client.
	// If the magicIP is within a configured Magic IP range for an app on the client,
	// but not mapped to an active Transit IP, implementations should return [ErrUnmappedMagicIP].
	// If magicIP is not within a configured Magic IP range, i.e. it is not actually a Magic IP,
	// implementations should return a nil error, and a zero-value [netip.Addr] to indicate
	// this potentially valid, non-app-connector traffic.
	ClientTransitIPForMagicIP(magicIP netip.Addr) (netip.Addr, error)
```

[`datapath.go#L16-L29`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/conn25/datapath.go#L16-L29)。

**戻り値の 3 通りが、コメントで完全に定義されている。**

| 状況                                     | 戻り値                         |
| ---------------------------------------- | ------------------------------ |
| magic IP の範囲内で、割り当てがある      | (transit IP, nil)              |
| magic IP の範囲内だが、割り当てがない    | (ゼロ値, `ErrUnmappedMagicIP`) |
| magic IP の範囲外 (無関係なトラフィック) | **(ゼロ値, nil)**              |

**3 番目が重要だ。** app connector と無関係なパケットは大多数で、それをエラーにすると **すべてのパケットでエラーの生成コストがかかる**。

「ゼロ値 + nil エラー」で「該当しない」を表す。**呼び出し側は `if addr.IsValid()` で分岐する。**

そして **「本番の実装は 1 つだけ。インターフェースがあるのはテストで軽量な偽物を使うため」** と、インターフェースの存在理由が明記されている。

### 入力の制限

```go title="feature/conn25/conn25.go"
const maxBodyBytes = 1024 * 1024

// jsonDecode decodes all of a io.ReadCloser (eg an http.Request Body) into one pointer with best practices.
// It limits the size of bytes it will read.
// It either decodes all of the bytes into the pointer, or errors (unlike json.Decoder.Decode).
// It closes the ReadCloser after reading.
func jsonDecode(target any, rc io.ReadCloser) error {
	defer rc.Close()
	respBs, err := io.ReadAll(io.LimitReader(rc, maxBodyBytes+1))
```

[`conn25.go#L18-L28`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/conn25/conn25.go#L18-L28)。

**`json.Decoder.Decode` との違いが明記されている。** `Decode` は「最初の JSON 値だけを読む」ので、`{"a":1}{"b":2}` を渡すと前半だけ読んで成功する。

**全部を読んで `Unmarshal` すれば、余分なデータがあればエラーになる。**

そして `maxBodyBytes+1` を読むのが巧妙だ。**1 MiB ちょうどのリクエストと、1 MiB を超えるリクエストを区別できる。** [MagicDNS のバッファ](../magicdns-resolver/) と同じ、境界検出のための +1 だ。

## なぜそうなっているか

### なぜ経路が増えると問題なのか

App Connector が `*.github.com` を扱うとき、GitHub の CDN が返す IP は数百〜数千ある。地域によっても違う。

その全部が `/32` の経路として、**tailnet の全ノードに配られる**。

- **[netmap](../netmap/) が肥大化する**。数万の経路が全ノードに配布される
- **[OS のルーティングテーブル](../router-firewall/)に数万エントリが入る**。更新が遅くなる
- **経路の追加・削除が頻発する**。DNS の応答が変わるたびに

そして **経路は消えにくい**。「この IP はもう使わない」を判断するのが難しいので、溜まる一方になる。

`rateLogger` で監視していたのは、**この増加を早期に検知するため** だった。

### なぜ 2 段の NAT で解けるのか

問題の根は「**実際の宛先 IP を、tailnet 全体で共有する経路として表現している**」ことだ。

新実装では、

- **クライアントは、自分だけが使う magic IP を割り当てる**。他のノードは知らない
- **tailnet を流れるときは transit IP を使う**。これはコネクタごとに割り当てられた範囲から取る
- **経路として広告するのは transit IP の範囲だけ** — 1 本のプレフィックス

**「実際の宛先が何個あろうと、経路の数は変わらない」。**

代償は、**両端で NAT が必要になる** ことだ。クライアントで magic → transit、コネクタで transit → real。そのための状態 (割り当てのテーブル) を両端が持つ。

**「経路の数」という共有リソースの問題を、「各ノードのローカルな状態」に置き換えている。**

### なぜ magic IP と transit IP を分けるのか

一見すると、クライアントが直接 transit IP を返せばよさそうだ。

だが **transit IP はコネクタが管理する**。コネクタが「この範囲を使う」と決め、クライアントはその中から割り当てを要求する。

一方 **magic IP はクライアントのローカルな都合** だ。

- クライアントが複数のコネクタを使うとき、それぞれの transit IP 範囲が重なるかもしれない
- クライアントのアプリケーションに見せる IP は、クライアントが自由に選べる

**「相手が管理する空間」と「自分が管理する空間」を分けることで、衝突の調整が要らなくなる。**

### なぜフロー数を数えるのか

割り当てられた IP は有限だ。使われなくなったら回収したい。

だが **「使われていない」の判断が難しい**。

- **DNS の TTL が切れた** → だがまだ接続中かもしれない
- **一定時間通信がない** → 長時間アイドルな TCP 接続かもしれない

**アクティブなフローの数を数えれば、確実に「今使われているか」が分かる。** 0 になってから待てば、安全に回収できる。

`zeroFlowTime` があるのは、**「0 になった直後に回収しない」** ため。新しい接続がすぐ来るかもしれない。

**[Taildrop の遅延削除](../taildrop/) と同じ、「すぐ片付けず、猶予を置く」形だ。**

### なぜ「該当しない」をエラーにしないのか

`ClientTransitIPForMagicIP` は **すべての送信パケットで呼ばれる**。そのうち app connector に関係するのは、ごく一部だ。

Go でエラーを返すと、

- `errors.New` は事前に作れるが、**`fmt.Errorf` は毎回アロケーションする**
- 呼び出し側が `if err != nil` で分岐し、**エラーの種類を判別する必要がある**

「該当しない」は **エラーではなく、正常な結果** だ。だから **ゼロ値 + nil** を返す。

**「エラーではないが、値もない」を表現する方法** として、Go では次のいずれかを使う。

- ゼロ値 + `nil` エラー (この実装)
- `(T, bool)` の 2 値
- `*T` で nil

**ホットパスでは、エラーの生成コストを避けられる形を選ぶ。**

### なぜ「will be」と書くのか

`conn25` は開発途上だ。日付 (2026-02-04) つきで「現在は peer API のルートがいくつかあるだけ」と書かれている。

**未完成のコードがリポジトリにあること自体は普通だ。** 問題は、読んだ人が「なぜこれだけしかないのか」「バグなのか」と悩むことだ。

**「これから〜になる」「今はここまで」を日付つきで書けば、その疑問が消える。** そして日付があるので、**「1 年以上前の記述だから、もう進んでいるかもしれない」** という判断もできる。

## どう活かすか

**共有される有限リソース (経路、ポート、ID) を、動的に増やす設計は破綻しやすい。** 「必要になったら足す」を続けると、消す判断ができずに増え続ける。**リソースの数を、変動する外部の値から切り離せないかを考える。**

**問題が構造的だと分かっているなら、その増加を監視する仕組みを組み込む。** `rateLogger` は「経路が増えすぎている」を検知するためだけの型だ。**限界に達する前に気づける。**

**「相手が管理する空間」と「自分が管理する空間」を分けると、衝突の調整が不要になる。** magic IP はクライアントのローカル、transit IP はコネクタの管理。**両者を対応づける表を持つコストのほうが、調整プロトコルより安い。**

**外部から来る TTL や期限は、必ず範囲にクランプする。** DNS の TTL、HTTP の Cache-Control、トークンの有効期限。**最小値と最大値を定数として書く。**

**リソースの回収は、参照数を数えてから行う。** 時間ベースだけでは「まだ使っている」を見逃す。参照数が 0 になった時刻を記録し、猶予を置いてから回収する。

**ホットパスで呼ばれる関数では、「該当しない」をエラーにしない。** ゼロ値 + nil エラー、または `(T, bool)`。**そして戻り値の全パターンをドキュメントに列挙する** — 3 通りあるなら 3 通り全部書く。

**同じデータへのアクセスパターンが N 通りあるなら、索引を N 個持つ。** 更新のコストは増えるが、検索が定数時間になる。**一貫性の維持方法をコメントに書く。**

**JSON のデコードでは、`Decoder.Decode` と「全部読んで Unmarshal」の違いを意識する。** 前者は余分なデータを見逃す。**そしてサイズ制限を必ず入れる** — `io.LimitReader(r, max+1)` にすれば、超過も検出できる。

**未完成のコードには「今はここまで」を日付つきで書く。** 読む人の「なぜこれだけ」という疑問が消え、記述の鮮度も判断できる。
