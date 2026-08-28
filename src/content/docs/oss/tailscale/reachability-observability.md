---
title: "なぜ繋がらないのかを、後から説明できるようにする"
description: "NAT 越えは失敗の理由が見えにくい。Tailscale は 350 個以上のカウンタを仕込み、4 時間ごとに名前を再送する差分エンコードでログに流す。経路の変更は固定長のリングバッファに積み、magicsock の内部状態は HTML で吐く。netcheck の結果は 1 行に圧縮され、grep できる形になっている。"
group: "NAT 越え"
sidebar:
  order: 19
---

## 何を学んだか

### NAT 越えは失敗の理由が見えない

「繋がらない」と報告されたとき、原因の候補が多い。

- UDP が塞がれている
- NAT が hard NAT で、STUN のアドレスが使えない
- ルータが UPnP を喋らない
- 相手がスリープしている
- DERP に繋がらない
- MTU が小さすぎて大きなパケットだけ落ちている

しかも **ユーザーの手元でしか再現しない**。開発者は現場のネットワークに入れない。

Tailscale の答えは、**観測できるものを全部数えて、圧縮してログに載せる** ことだ。

### 4 つの仕組み

| 仕組み           | 対象                        | 取り出し方             |
| ---------------- | --------------------------- | ---------------------- |
| `clientmetric`   | 数えられる事象 (350 個以上) | ログ、`/debug/metrics` |
| `ringlog`        | 経路変更の履歴              | `tailscale debug`      |
| `ServeHTTPDebug` | magicsock の内部状態        | HTTP (HTML)            |
| 簡潔ログ         | netcheck の結果             | ログ 1 行              |

### メトリクスは差分でログに流す

350 個のカウンタを定期的に全部ログに書くと、それだけでログが埋まる。Tailscale は **前回から変化したものだけを、独自の短い形式でエンコード** する。

```text
'N' + hex(varint(名前の長さ)) + 名前     … 名前を宣言する
'S' + hex(varint(ID)) + hex(varint(値))  … 値をセットする
'I' + hex(varint(ID)) + hex(varint(値))  … 値を増やす
```

名前を毎回送らず、**ID で参照する**。そして **4 時間に 1 回、名前を再送する**。

### magicsock は自分の状態を HTML で吐く

`/debug/magicsock` にアクセスすると、DERP の接続状況、ピアごとのエンドポイント、最後に通信した時刻が HTML で返る。

しかも **peerapi 経由で、同じユーザーが持つ他のノードからも見られる**。スマートフォンの内部状態を、手元の PC から覗ける。

## ソースコードのどこか

### 数える文化

```go title="util/clientmetric/clientmetric.go"
// Package clientmetric provides client-side metrics whose values
// get occasionally logged.
package clientmetric
```

[`clientmetric.go#L6-L8`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/clientmetric/clientmetric.go#L6-L8)。

リポジトリ全体で `clientmetric.New*` の呼び出しは **357 箇所** ある (テストを除く)。NAT 越えの周辺だけでも、

- `metricRecvDiscoPing` / `Pong` / `CallMeMaybe` — disco メッセージの種類ごと
- `metricRecvDiscoBadPeer` / `BadKey` / `BadParse` — [捨てた理由ごと](../disco-protocol/)
- `patchDERPRegion` / `patchEndpoints` / `patchOnline` — [netmap パッチのフィールドごと](../netmap/)
- `dropReasonQueueHead` / `QueueTail` — [DERP が捨てた理由ごと](../derp/)
- `getPeerMTUsProbedMetric(size)` — [MTU プローブのサイズごと](../peer-mtu/)

**「分岐があるところには、だいたいカウンタがある」** と言えるくらいの密度だ。

### メモリ配置まで考える

```go title="util/clientmetric/clientmetric.go"
	// valFreeList is a set of free contiguous int64s whose
	// element addresses get assigned to Metric.v.
	// Any memory address in len(valFreeList) is free for use.
	// They're contiguous to reduce cache churn during diff scans.
	// When out of length, a new backing array is made.
	valFreeList []int64
)

// scanEntry contains the minimal data needed for quickly scanning
// memory for changed values. It's small to reduce memory pressure.
type scanEntry struct {
	v          *int64       // Metric.v
	f          func() int64 // Metric.f
```

[`clientmetric.go#L38-L50`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/clientmetric/clientmetric.go#L38-L50)。

**メトリクスの値を連続したメモリに置く。** 差分スキャンのとき、350 個の `int64` が連続していればキャッシュラインに乗る。バラバラに `new(int64)` すると、スキャンのたびにキャッシュミスが 350 回起きる。

`scanEntry` も「差分スキャンに必要な最小限」だけを持つ。名前や型はここに入れず、別の配列から引く。**スキャンのホットループに載るデータだけを小さく保つ。**

### 差分エンコード

```go title="util/clientmetric/clientmetric.go"
	// this is how far in the logs you need to fetch from a
	// given point in time to recompute the metrics at that point
	// in time.
	metricLogNameFrequency = 4 * time.Hour

	// minMetricEncodeInterval is the minimum interval that the
	// metrics will be scanned for changes before being encoded
	// for logtail.
	minMetricEncodeInterval = 15 * time.Second
)

// EncodeLogTailMetricsDelta return an encoded string representing the metrics
// differences since the previous call.
//
// It implements the requirements of a logtail.Config.MetricsDelta
// func. Notably, its output is safe to embed in a JSON string literal
// without further escaping.
//
// The current encoding is:
//   - name immediately following metric:
//     'N' + hex(varint(len(name))) + name
//   - set value of a metric:
//     'S' + hex(varint(wireid)) + hex(varint(value))
//   - increment a metric: (decrements if negative)
//     'I' + hex(varint(wireid)) + hex(varint(value))
func EncodeLogTailMetricsDelta() string {
```

[`clientmetric.go#L316-L344`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/clientmetric/clientmetric.go#L316-L344)。

**4 時間ごとに名前を再送する理由が、定数のコメントに書かれている。** 「ある時点のメトリクスを再計算するには、ログをどれだけ遡って取ってくる必要があるか」。

これがトレードオフの中心だ。

- 名前を毎回送る → ログが巨大になる
- 名前を最初の 1 回だけ送る → 途中からログを読むと、ID が何を指すか分からない
- **4 時間ごとに送る → 最大 4 時間ぶん遡れば必ず名前が見つかる**

**「ログを途中から読む人」を想定した設計** になっている。

エンコードが hex なのも理由がある。**「JSON の文字列リテラルにそのまま埋め込んでも安全」** — エスケープが不要なので、ログの JSON を組み立てるときにコピーするだけで済む。バイナリのままだと base64 が要り、そのぶん膨らむ。

変化がないメトリクスは出力に現れない。**350 個のうち、動いたものだけが 15 秒ごとに数十バイトになる。**

### 経路変更のリングバッファ

```go title="util/ringlog/ringlog.go"
// Package ringlog contains a limited-size concurrency-safe generic ring log.
package ringlog

// RingLog is a concurrency-safe fixed size log window containing entries of [T].
type RingLog[T any] struct {
	mu  syncs.Mutex
	pos int
	buf []T
	max int
}

// Add appends a new item to the [RingLog], possibly overwriting the oldest
// item in the log if it is already full.
//
// It does nothing if rb is nil.
func (rb *RingLog[T]) Add(t T) {
	if rb == nil {
		return
	}
```

[`ringlog.go#L4-L31`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/ringlog/ringlog.go#L4-L31)。

**`nil` に対する `Add` が no-op になっている。** 呼び出し側は「デバッグ記録が有効か」を毎回チェックしなくてよい。無効なら `nil` を入れておけば、呼び出しは何もしない。

これを [endpoint](../endpoint-selection/) が使う。

```go
	debugUpdates *ringlog.RingLog[EndpointChange]
```

**経路が変わるたびに `EndpointChange{When, What, From, To}` が積まれる。** 固定長なので、どれだけ経路が揺れてもメモリは増えない。

### 内部状態を HTML で

```go title="wgengine/magicsock/debughttp.go"
// ServeHTTPDebug serves an HTML representation of the innards of c for debugging.
//
// It's accessible either from tailscaled's debug port (at
// /debug/magicsock) or via peerapi to a peer that's owned by the same
// user (so they can e.g. inspect their phones).
func (c *Conn) ServeHTTPDebug(w http.ResponseWriter, r *http.Request) {
```

[`debughttp.go#L23-L28`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/debughttp.go#L23-L28)。

**「同じユーザーが持つピアから peerapi 経由で見られる」** のが特に実用的だ。スマートフォンや、ディスプレイのないサーバの内部状態を、手元のマシンから HTTP で取れる。デバッグのために SSH で入る必要がない。

出力は素朴な HTML だ。テンプレートエンジンもフレームワークも使わず、`fmt.Fprintf` で組み立てる。

```go title="wgengine/magicsock/debughttp.go"
	fmt.Fprintf(w, "<h1>magicsock</h1>")
	fmt.Fprintf(w, "<h2 id=derp><a href=#derp>#</a> DERP</h2><ul>")
```

**見出しにアンカーが振ってある。** 「この部分を見て」と URL で指せる。障害報告のやりとりで効く。

### netcheck の結果を 1 行に

```go title="net/netcheck/netcheck.go"
func (c *Client) logConciseReport(r *Report, dm *tailcfg.DERPMap) {
	c.logf("[v1] report: %v", logger.ArgWriter(func(w *bufio.Writer) {
		fmt.Fprintf(w, "udp=%v", r.UDP)
		if !r.IPv4 {
			fmt.Fprintf(w, " v4=%v", r.IPv4)
		}
		if !r.UDP {
			fmt.Fprintf(w, " icmpv4=%v", r.ICMPv4)
		}
		fmt.Fprintf(w, " v6=%v", r.IPv6)
		if !r.IPv6 {
			fmt.Fprintf(w, " v6os=%v", r.OSHasIPv6)
		}
		fmt.Fprintf(w, " mapvarydest=%v", r.MappingVariesByDestIP)
		if r.AnyPortMappingChecked() {
			fmt.Fprintf(w, " portmap=%v%v%v", conciseOptBool(r.UPnP, "U"), conciseOptBool(r.PMP, "M"), conciseOptBool(r.PCP, "C"))
		} else {
			fmt.Fprintf(w, " portmap=?")
		}
```

[`netcheck.go#L1299-L1340`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netcheck/netcheck.go#L1299)。

出力はこんな形になる。

```text
report: udp=true v6=false v6os=true mapvarydest=false portmap=UMC v4a=203.0.113.5:41641 derp=2 derpdist=1v4:32ms,2v4:12ms
```

**設計が 3 点ある。**

**1. 条件付きの詳細。** `IPv4` が真なら出さない。偽のときだけ出す。**正常な値は省略し、異常な値だけを残す** ので、1 行が短く保たれ、目立つ。

**2. 記号への圧縮。** UPnP / PMP / PCP を `UMC` の 3 文字にまとめる。使えないものは小文字か別の記号になる。

**3. `key=value` 形式。** `grep 'mapvarydest=true'` で、hard NAT のユーザーのログだけを抽出できる。

`logger.ArgWriter` は、**ログが実際に出力されるときにだけ文字列を組み立てる** ための仕組みだ。`[v1]` (詳細ログ) が無効なら、この関数は呼ばれない。

### 記録は必ずしもログではない

ここまでの 4 つは、どれも「ログに書く」以外の選択肢を取っている。

| 手段           | 保持            | 取り出し         |
| -------------- | --------------- | ---------------- |
| カウンタ       | メモリ 8 バイト | 差分を 15 秒ごと |
| リングバッファ | 固定長          | 要求時           |
| HTTP デバッグ  | 現在値のみ      | 要求時           |
| 簡潔ログ       | ログ 1 行       | 常時             |

**「起きたことを全部ログに書く」を避けている。** ログは高価 (ディスク、帯域、検索コスト) なので、**頻度の高い事象はカウンタに、履歴が要るものはリングバッファに、現在の状態は要求時に生成** する。

## なぜそうなっているか

### なぜカウンタをこれほど仕込むのか

NAT 越えの失敗は、**開発者の手元では再現しない**。ユーザーのネットワークに固有の問題であることが多く、再現手順を聞き出すのも難しい。

だから **「起きたときに記録されている」ようにしておく** しかない。事後にログを見て「disco の復号失敗が 1 万回起きている」と分かれば、原因の当たりがつく。

カウンタのコストは `int64` 1 個と `atomic.Add` 1 回だ。**分岐を書くたびにカウンタを足しても、実行時のコストはほぼゼロ**。「後で欲しくなるかもしれない」ものを全部数えておける。

そして重要なのは、**「捨てた」「失敗した」「無視した」の分岐に必ずカウンタがあること**。これらは正常系のログには出ないので、カウンタがなければ完全に見えなくなる。

### なぜ名前を 4 時間ごとに再送するのか

ログの世界では、**「最初から読む」ことは保証できない**。ログはローテーションされ、古いものは消える。障害調査では「直近 1 時間ぶんだけ取れた」ということが普通に起きる。

ID だけを送っていると、**その ID が何のメトリクスかを知るには、ログの最初まで遡る必要がある**。1 週間前のログが消えていたら、もう分からない。

4 時間ごとに名前を再送すれば、**「最大 4 時間ぶん余分に取れば必ず解読できる」** と言える。この保証があるからこそ、残りの時間は ID だけで送れる。

**「圧縮の代償として何を失うか」を計算し、その損失を有界にしている。**

### なぜログではなくリングバッファなのか

経路の変更は、モバイル環境では頻繁に起きる。すべてログに書くと、

- ログの帯域を食う (モバイル回線では実費)
- 他の重要なログが流量制限で落ちる
- ディスクを食う

一方、調査に必要なのは **「問題が起きた直前の数十件」** だけだ。1 週間前の経路変更は要らない。

固定長のリングバッファなら、**メモリは一定で、直近の履歴が常に残る**。そして問題が報告されたときに `tailscale bugreport` で吸い出せばよい。

**「常に記録するが、常に送信はしない」** という分離だ。

### なぜ HTML なのか

デバッグ用の出力形式として、JSON も選べた。だが HTML には利点がある。

- **ブラウザで開けば読める。** 整形ツールが要らない
- **リンクとアンカーが使える。** 「ここを見て」と指せる
- **表として並べられる。** ピアごとの状態は表形式が読みやすい

そして機械可読性が必要な場面には、別に JSON の API (`tailscale status --json`) がある。**人間向けと機械向けを分けて、それぞれに最適な形式を選んでいる。**

### なぜ正常値をログから省くのか

netcheck のログは、**問題があるときに読まれる**。そのとき知りたいのは「何が普通と違うか」だ。

`v4=true udp=true v6=false` のように全部出すと、目が滑る。異常なものだけが出ていれば、**行の短さ自体が「正常」のシグナル** になる。

これは「ログは読まれる前提で書く」という考え方だ。誰も読まないログを大量に出すのは、**ディスクを消費する以上に、読む人の時間を消費する**。

## どう活かすか

**分岐、とくに「捨てる」「失敗する」「無視する」の分岐には、必ずカウンタを置く。** 正常系はログや監視に出るが、異常系の一部は完全に見えなくなる。`atomic.Add` 1 回のコストで、後から「何が起きていたか」が分かる。

**メトリクスを転送するなら、名前と値を分離し、名前を定期的に再送する。** 「途中からログを読む人」がいる前提に立つと、この設計が必要になる。再送の間隔が「どれだけ遡れば解読できるか」の保証になる。

**符号化の形式は、埋め込み先の制約から決める。** JSON の文字列に入れるなら、エスケープ不要な文字だけを使う。base64 より hex のほうが 1.3 倍大きいが、エスケープの心配がない。

**頻度の高い履歴は、ログではなく固定長のリングバッファに置く。** メモリが一定で、直近が常に残る。取り出しは要求時。「常に記録するが、常に送信しない」の分離は、モバイルや組み込みで特に効く。

**人間向けのデバッグ出力と、機械向けの API を分ける。** 人間向けは HTML で、見出しにアンカーを振る。機械向けは JSON で安定した構造にする。1 つの形式で両方を満たそうとすると、どちらも中途半端になる。

**ログには「普通と違うもの」だけを書く。** 正常値を省略すると、行が短いこと自体が情報になる。そして `key=value` 形式にしておくと、後から grep で絞れる。

**デバッグ用のフックは `nil` で無効化できるようにする。** `nil` レシーバに対するメソッドを no-op にすれば、呼び出し側に条件分岐が要らない。有効・無効の切り替えが 1 箇所で済む。
