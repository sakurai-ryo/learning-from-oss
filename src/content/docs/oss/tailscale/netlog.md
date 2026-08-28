---
title: "フロー単位でトラフィックを数える"
description: "TUN とソケットの 2 層で数えると、「誰が誰と通信したか」と「その通信がどの経路を通ったか」の両方が取れる。トラフィックは 4 種類に分類され、exit node 経由の分は既定で記録されない。JSON のサイズ上限は、リテラル文字列の長さを足し合わせて求めている。"
group: "データパス"
sidebar:
  order: 25
---

## 何を学んだか

### 監査ログを、中央ではなく各ノードで取る

[control server はパケットを見ない](../architecture/)ので、通信の記録を中央で取ることができない。**「誰が誰と通信したか」を知りたいなら、各ノードに記録させるしかない。**

`wgengine/netlog` がそれを担う。5 秒ごとにカウンタを収集し、[logtail](../reachability-observability/) 経由でログストリームに流す。

### 2 つの層で数える

数える場所が 2 か所ある。

| 層                         | 見えるもの                                       |
| -------------------------- | ------------------------------------------------ |
| [TUN](../tstun/)           | tailnet の IP アドレス間のフロー (誰と誰が)      |
| [magicsock](../magicsock/) | 実際の UDP エンドポイント間のフロー (どの経路で) |

前者を **virtual**、後者を **physical** と呼ぶ。

**両方を突き合わせると、「A と B が通信し、その経路は DERP 経由だった」が分かる。** 片方だけでは、どちらかが欠ける。

### トラフィックは 4 分類

| 分類              | 意味                                                |
| ----------------- | --------------------------------------------------- |
| `VirtualTraffic`  | tailnet のノード間                                  |
| `SubnetTraffic`   | [subnet router](../subnet-router-exit-node/) を経由 |
| `ExitTraffic`     | [exit node](../subnet-router-exit-node/) を経由     |
| `PhysicalTraffic` | 実際の UDP/DERP エンドポイント間                    |

分類は **アドレスがどこに属するか** で決まる。送信元が tailnet の IP で宛先が広告された経路の中なら subnet、そうでなければ exit。

### exit node のトラフィックは既定で記録しない

exit node を通る通信は、**インターネット全体への通信** だ。どのサイトを見たかが記録されることになる。

だから **既定では記録されず**、tailnet の管理者が明示的にオプトインしたときだけ有効になる。

## ソースコードのどこか

### 2 つのデバイスから数える

```go title="wgengine/netlog/netlog.go"
// Device is an abstraction over a tunnel device or a magic socket.
// Both *tstun.Wrapper and *magicsock.Conn implement this interface.
type Device interface {
	SetConnectionCounter(netlogfunc.ConnectionCounter)
}
```

[`netlog.go#L22-L26`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netlog/netlog.go#L22-L26)。

**メソッド 1 つのインターフェース。** `tstun.Wrapper` と `magicsock.Conn` という、まったく別の層の型が同じインターフェースを満たす。

netlog から見れば「カウンタを設定できるもの」が 2 つあるだけで、それが TUN なのかソケットなのかは知らなくてよい。

### 2 つの層で見えるものの違い

```go title="wgengine/netlog/netlog.go"
// The tun is used to populate the VirtualTraffic, SubnetTraffic,
// and ExitTraffic fields in [netlogtype.Message].
//
// The sock [Device] captures packets at the magicsock layer.
// The source is always a tailscale IP address and the destination
// is a non-tailscale IP address to contact for that particular tailscale node.
// The IP protocol and source port are always zero.
// The sock is used to populated the PhysicalTraffic field in [netlogtype.Message].
```

[`netlog.go#L119-L126`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netlog/netlog.go#L119-L126)。

**physical 側では「IP プロトコルと送信元ポートは常にゼロ」。** magicsock の層では、中身は暗号化された WireGuard のペイロードなので、TCP か UDP かも分からない。分かるのは「どのノード宛のパケットが、どの UDP エンドポイントに何バイト流れたか」だけだ。

**同じ `Connection` という型を使いつつ、層によって埋まらないフィールドがある。** それを型で分けるのではなく、ドキュメントで説明している。

### 分類の判定

```go title="wgengine/netlog/netlog.go"
		if nl.withinRoutesLocked(c.Dst.Addr()) {
			return subnetTraffic // a client using another subnet router
		} else {
			return exitTraffic // a client using exit an exit node
		}
	case dstNode.Valid():
		if nl.withinRoutesLocked(c.Src.Addr()) {
			return subnetTraffic // serving as a subnet router
		} else {
			return exitTraffic // serving as an exit node
		}
```

[`netlog.go#L307-L318`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netlog/netlog.go#L307)。

**同じ判定が、方向によって「使う側」と「提供する側」に分かれる。**

- 送信元が自分の tailnet IP → 自分がクライアント
- 宛先が tailnet のノード → 自分がルータ/exit node

そして「広告された経路の中か」で subnet と exit を分ける。**exit node は `0.0.0.0/0` を広告している** ので、「広告された経路の中」という判定だけでは区別できない。だから **具体的な subnet route の集合** と照合する。

### 記録の形

```go title="wgengine/netlog/record.go"
// record is the in-memory representation of a [netlogtype.Message].
// It uses maps to efficiently look-up addresses and connections.
// In contrast, [netlogtype.Message] is designed to be JSON serializable,
// where complex keys types are not well support in JSON objects.
type record struct {
	selfNode nodeUser

	start time.Time
	end   time.Time

	seenNodes map[netip.Addr]nodeUser

	virtConns map[netlogtype.Connection]countsType
	physConns map[netlogtype.Connection]netlogtype.Counts
}
```

[`record.go#L16-L29`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netlog/record.go#L16-L29)。

**同じデータに 2 つの表現がある。**

- `record` — メモリ上。**マップのキーが構造体** で、フローの検索が速い
- `netlogtype.Message` — JSON 用。**配列の列** で、シリアライズできる

JSON のオブジェクトキーは文字列しか使えないので、`Connection` 構造体をキーにできない。**変換のためだけに 2 つの型を持っている。**

これは [netmap の View 型](../netmap/) とは逆方向の使い分けで、「内部表現とワイヤ表現を分ける」という同じ原則の別の現れ方だ。

### JSON のサイズ上限を文字列で計算する

```go title="types/netlogtype/netlogtype.go"
const (
	messageJSON      = `{"nodeId":` + maxJSONStableID + `,` + minJSONNodes + `,` + maxJSONTimeRange + `,` + minJSONTraffic + `}`
	maxJSONStableID  = `"n0123456789abcdefCNTRL"`
	minJSONNodes     = `"srcNode":{},"dstNodes":[]`
	maxJSONTimeRange = `"start":` + maxJSONRFC3339 + `,"end":` + maxJSONRFC3339
	maxJSONRFC3339   = `"0001-01-01T00:00:00.000000000Z"`
	minJSONTraffic   = `"virtualTraffic":{},"subnetTraffic":{},"exitTraffic":{},"physicalTraffic":{}`

	// MinMessageJSONSize is the overhead size of Message when it is
	// serialized as JSON assuming that each field is minimally populated.
	// Each [Node] occupies at least [MinNodeJSONSize].
	// Each [ConnectionCounts] occupies at most [MaxConnectionCountsJSONSize].
	MinMessageJSONSize = len(messageJSON)
```

[`netlogtype.go#L33-L45`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/types/netlogtype/netlogtype.go#L33-L45)。

**JSON の最大サイズを、実際の JSON をリテラルとして書いて `len()` で測っている。**

「タイムスタンプは RFC3339 で最大 30 文字」「ノード ID は最大 22 文字」を数えて足し算するのではなく、**その形の文字列そのものを書く**。

利点が 2 つある。

- **見れば正しさが分かる。** `"0001-01-01T00:00:00.000000000Z"` は本当に最長の RFC3339 だ
- **フィールドを足したときに、対応する文字列を足し忘れにくい。** JSON の形がそのまま見えている

`const` なのでコンパイル時に計算され、実行時のコストはゼロだ。

### なぜサイズ上限が要るか

```go title="wgengine/netlog/record.go"
// maxLogSize is the maximum number of bytes for a log message.
const maxLogSize = 256 << 10
```

[`record.go#L13-L14`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netlog/record.go#L13-L14)。

**1 メッセージ 256 KiB を超えないように、途中でフラッシュする。**

多数のフローがある環境 (subnet router、exit node) では、5 秒間に数万のフローが記録されうる。**サイズを見ながら、上限に達したら期間の途中でも送る。**

そのために `recordLen` (JSON にしたときの長さの上限) をインクリメンタルに追跡している。**実際に JSON にしてみるのではなく、追加のたびに「最大でこれだけ増える」を足していく。**

### オプトインの伝わり方

```go title="wgengine/netlog/netlog.go"
func (nl *Logger) Startup(logf logger.Logf, source NodeSource, nodeLogID, domainLogID logid.PrivateID, tun, sock Device, netMon *netmon.Monitor, health *health.Tracker, bus *eventbus.Bus, logExitFlowEnabledEnabled bool) error {
```

```go title="wgengine/netlog/netlog.go"
		for rec := range recordsChan {
			msg := rec.toMessage(false, !logExitFlowEnabledEnabled)
```

[`netlog.go#L132`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netlog/netlog.go#L132) と [`netlog.go#L185-L186`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netlog/netlog.go#L185-L186)。

**フラグは [netmap](../netmap/) から来て、`Startup` の引数として渡り、メッセージの生成時に適用される。**

記録自体は行われ、**送信するメッセージから除外される** 形になっている。カウントは常に取り、出すかどうかを最後に決める。

分類 (`exitTraffic`) が既に付いているので、除外は 1 つの真偽値で済む。**「分類してから、分類ごとに出すかを決める」という構造が、プライバシー設定の実装を単純にしている。**

### ノード情報の解決

```go title="wgengine/netlog/netlog.go"
// NodeSource provides node lookups for the network logger.
// Methods may be called concurrently.
type NodeSource interface {
	// SelfNode returns the local node and its owning user profile.
	SelfNode() (node tailcfg.NodeView, user tailcfg.UserProfileView)

	// NodeByAddr returns the node assigned the given address along with
	// its owning user profile.
	// ok is false if no node is known to own addr.
	NodeByAddr(addr netip.Addr) (node tailcfg.NodeView, user tailcfg.UserProfileView, ok bool)
}
```

[`netlog.go#L28-L40`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/netlog/netlog.go#L28-L40)。

**IP アドレスからノードとユーザーを引くインターフェース。** ログには「どのノードのどのユーザーか」が入るので、記録の時点で解決する必要がある。

インターフェースにしているので、**netlog は [netmap](../netmap/) を知らない**。テストでは固定のマップを渡せる。

## なぜそうなっているか

### なぜ 2 層で数えるのか

**1 層では答えられない質問がある。**

- 「A と B の通信量は?」→ TUN 層で分かる
- 「DERP をどれだけ使っている?」→ ソケット層で分かる
- 「A と B の通信は直結か DERP か?」→ **両方を突き合わせて初めて分かる**

3 つ目が重要だ。**課金 (DERP の帯域)、性能分析 (直結率)、障害調査 (このノードだけ DERP 経由)** のすべてがこれを必要とする。

コストは、同じパケットを 2 回数えることだ。だがカウンタの更新は数ナノ秒なので、問題にならない。

### なぜ exit トラフィックを既定で記録しないのか

exit node を通る通信は、**tailnet の外側、つまりインターネット全体** への通信だ。

- どのウェブサイトを見たか
- どのサービスを使っているか
- 何時に何をしていたか

これは tailnet 内の通信記録とは、**プライバシー上の意味がまったく違う**。「社内システムへのアクセス記録」と「個人の閲覧履歴」の差だ。

だから **既定は off で、管理者が明示的に有効にする** 必要がある。しかもその設定は [netmap 経由で control から来る](../netmap/) ので、admin console 上での操作として記録される。

**「技術的に取れるものを、既定では取らない」** という判断が、フラグ 1 つとして実装されている。

### なぜ JSON のサイズをリテラルで計算するのか

サイズ上限の計算は、間違えても **すぐには気づかない**。上限を大きく見積もれば、たまに巨大なログが出て弾かれる。小さく見積もれば、必要以上に細かく分割される。

数値で書くと (`const maxTimeSize = 30`)、なぜ 30 なのかが分からなくなる。RFC3339 の形式を思い出して数え直す必要がある。

**実際の文字列を書けば、見た瞬間に検証できる。** そして新しいフィールドを足すときも、JSON の形をそのまま書き足せばよい。

これは「マジックナンバーに名前を付ける」の一歩先で、**マジックナンバーを、その値の由来そのもので置き換えている**。

### なぜ内部表現と JSON 表現を分けるのか

フローの記録は「同じフローが来たらカウンタを足す」操作が支配的だ。**マップのキーとして `Connection` 構造体を使えば、1 回のルックアップで済む。**

JSON では、オブジェクトのキーは文字列でなければならない。`Connection` をキーにするには文字列化が要り、パースし直すのも面倒だ。

だから JSON では **`[{conn: {...}, counts: {...}}, ...]` という配列** にする。読み手 (ログを処理するサーバ) は、必要ならそこからマップを作ればよい。

**「効率的に更新できる形」と「相互運用しやすい形」は別物で、変換のコストは 5 秒に 1 回なら無視できる。**

## どう活かすか

**同じ事象を複数の層で計測すると、層をまたいだ質問に答えられる。** アプリケーション層のリクエストと、トランスポート層の接続。論理的な操作と、物理的なリソース消費。片方だけでは「なぜ遅いか」に答えられない。カウンタの更新は安いので、両方取る。

**計測は常に行い、出力の時点でフィルタする。** 分類を記録の時点で付けておけば、「出すかどうか」は最後の真偽値 1 つで決まる。逆に「記録するかどうか」を入り口で分岐すると、設定が変わったときに過去のデータがない。

**プライバシーに関わるデータは、技術的に取れても既定では取らない。** そして有効化を、コードのフラグではなく **運用者が明示的に操作する設定** として持つ。「誰がいつ有効にしたか」が残る。

**サイズや長さの上限は、実際の値のリテラルから計算する。** `len("0001-01-01T00:00:00.000000000Z")` は、`30` より遥かに検証しやすい。Go なら `const` でコンパイル時に畳まれるので、実行時のコストはない。

**内部表現とシリアライズ表現は、無理に一致させない。** マップのキーに構造体を使いたい、けれど JSON では配列にしたい。変換の頻度が低いなら、2 つの型を持って変換する。片方に合わせると、必ずどちらかが不自然になる。

**依存を「メソッド 1 つのインターフェース」に切り出すと、まったく別の層の型を同じように扱える。** `SetConnectionCounter` だけを要求すれば、TUN でもソケットでも同じコードで扱える。インターフェースを小さく保つことの実利がここに出ている。
