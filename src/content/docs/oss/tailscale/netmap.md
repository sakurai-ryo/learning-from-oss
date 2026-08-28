---
title: "netmap: ネットワーク全体を 1 つの構造体で表す"
description: "control から降ってくるのは「ネットワークの現在の状態」1 個だ。全部送ると重いので差分にするが、その差分は 3 段階ある。しかもクライアント側が、サーバから来た「変更後のノード」を自分でパッチに変換し直す。reflect でフィールドを全列挙して、新フィールドを追加したら panic させる仕掛けまで入っている。"
group: "前提"
sidebar:
  order: 4
---

## 何を学んだか

### 状態を配るか、イベントを配るか

分散システムでノードに設定を配るとき、大きく 2 通りある。

- **イベントを配る**: 「ノード B が追加された」「ノード C の IP が変わった」を順番に送る。
- **状態を配る**: 「今のネットワークはこうなっている」を丸ごと送る。

Tailscale は **状態を配る** 側を選んでいる。`netmap.NetworkMap` という 1 つの構造体が「世界の現在の状態」で、ノードの挙動はすべてこれを見て決まる。

状態配布の利点は **収束が単純** なことだ。イベントの取りこぼしや順序の入れ替わりを気にしなくてよい。最新の状態を受け取れば、それまでの経緯に関係なく正しい状態になる。

欠点は **サイズ** だ。1,000 ノードの tailnet なら、1 ノードの IP が変わっただけで 1,000 ノード分のデータを送ることになる。

### 差分は 3 段階ある

そこで Tailscale は、状態配布を保ちながら差分を導入した。`MapResponse` には次のフィールドが並ぶ。

| フィールド          | 意味                                          | サイズ         |
| ------------------- | --------------------------------------------- | -------------- |
| `Peers`             | ピア全部。これがあると他の差分は無視される    | 全部           |
| `PeersChanged`      | このノードたちは中身がこうなった (ノード全体) | ノード単位     |
| `PeersRemoved`      | このノード ID は消えた                        | ID だけ        |
| `PeersChangedPatch` | このノードのこのフィールドだけ変わった        | フィールド単位 |

`PeersChangedPatch` の要素が `PeerChange` で、**変わりやすいフィールドだけを列挙した専用の型** になっている。HomeDERP、Endpoints、Online、LastSeen、DiscoKey — つまり「ノードが移動したり、オンラインになったりしたときに変わるもの」だ。

### クライアントが自分でパッチに変換し直す

面白いのはここだ。サーバが `PeersChanged` (ノード全体) を送ってきても、クライアントは **それを受け取ってから自分で `PeersChangedPatch` に変換する**。

サーバから見て「このノードの HomeDERP だけ変わった」と分かっていれば最初からパッチで送ればよいのだが、サーバが常にそれを判定できるとは限らない。そこでクライアント側で、手元の古いノードと新しいノードを比べて「差分がパッチで表現できるか」を確かめる。

なぜそんなことをするかというと、**netmap の下流に「何が変わったか」を細かく伝えたい** からだ。ノード全体が置き換わったと伝えると、下流は WireGuard の再設定やフィルタの再構築を全部やり直す。「DERP ホームだけ変わった」と分かれば、その 1 点だけを直せる。

### 互換性はバージョン番号 1 個で管理する

`CapabilityVersion` という整数が 1 つあり、現在 **145**。クライアントが何かできるようになるたびに +1 する。そして **その履歴が全部コードのコメントに残っている**。

## ソースコードのどこか

### 世界の状態

```go title="types/netmap/netmap.go"
// NetworkMap is the current state of the world.
//
// The fields should all be considered read-only. They might
// alias parts of previous NetworkMap values.
type NetworkMap struct {
```

[`netmap.go#L26-L30`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/types/netmap/netmap.go#L26-L30)。

「読み取り専用として扱え。過去の NetworkMap の一部を参照しているかもしれない」。**差分適用のたびに全体をコピーするのではなく、変わっていない部分は前の値と共有する。** だから書き換えると過去の値まで壊れる。

この規約をコメントではなく型で守るために、ピアは `tailcfg.NodeView` という読み取り専用ビューで保持される。ビューはコード生成で作られる ([コード生成のページ](../codegen-views/))。

### ノード 1 つの表現

```go title="tailcfg/tailcfg.go"
type Node struct {
	ID       NodeID
	StableID StableNodeID
	Name string
	User UserID
	Key          key.NodePublic
	KeyExpiry    time.Time
	KeySignature tkatype.MarshaledSignature
	Machine      key.MachinePublic
	DiscoKey     key.DiscoPublic

	// Addresses are the IP addresses of this Node directly.
	Addresses []netip.Prefix

	// AllowedIPs are the IP ranges to route to this node.
	AllowedIPs []netip.Prefix

	Endpoints []netip.AddrPort // IP+port (public via STUN, and local LANs)

	// HomeDERP is the modern version of the DERP string field, with just an
	// integer.
	HomeDERP DERPRegionID
	...
	// PrimaryRoutes are the routes from AllowedIPs that this node
	// is currently the primary subnet router for, as determined
	// by the control plane.
	PrimaryRoutes []netip.Prefix
```

[`tailcfg.go#L357`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tailcfg/tailcfg.go#L357)。

読みどころが 3 つある。

**`Addresses` と `AllowedIPs` が別。** 前者は「このノード自身の IP」、後者は「このノードに向けてルーティングすべき範囲」。subnet router や exit node は `AllowedIPs` のほうが広くなる ([subnet router のページ](../subnet-router-exit-node/))。

**`Endpoints` は複数形。** ノードは自分の候補アドレスを複数申告する。STUN で分かった外側のアドレス、LAN のアドレス、ポートマッピングで開けたアドレス。どれが通るかはノードどうしで試す。

**`PrimaryRoutes` は control が決める。** 同じサブネットを複数のノードが広告している場合、どれを使うかは control 側の判断だ。クライアントは選ばない。

### DERP をエンドポイントとして偽装する

```go title="tailcfg/tailcfg.go"
// DerpMagicIP is a fake WireGuard endpoint IP address that means to
// use DERP. When used (in the Node.DERP field), the port number of
// the WireGuard endpoint is the DERP region ID number to use.
//
// Mnemonic: 3.3.40 are numbers above the keys D, E, R, P.
const DerpMagicIP = "127.3.3.40"
```

[`tailcfg.go#L3049-L3055`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tailcfg/tailcfg.go#L3049-L3055)。

**`127.3.3.40:N` という偽の UDP アドレスが「DERP リージョン N を使え」を意味する。** ニーモニックは QWERTY キーボードで D・E・R・P の上にある数字。

これは「WireGuard は 1 つのピアに 1 つのエンドポイントしか持てない」という制約への対処だ。エンドポイントの型を `netip.AddrPort` のまま、その値空間の一部を特別扱いすることで、DERP 経由という状態を表現している。今は `HomeDERP` という整数フィールドに移行済みだが、古いサーバとの互換のために残っている。

### 差分の適用

```go title="control/controlclient/map.go"
	if len(resp.Peers) > 0 {
		// Not delta encoded.
		stats.allNew = true
		keep := make(map[tailcfg.NodeID]bool, len(resp.Peers))
		for _, n := range resp.Peers {
			keep[n.ID] = true
			...
		}
		for id := range ms.peers {
			if !keep[id] {
				stats.removed++
				delete(ms.peers, id)
			}
		}
		// Peers precludes all other delta operations so just return.
		return
	}

	for _, id := range resp.PeersRemoved {
		...
	}
	for _, n := range resp.PeersChanged {
		...
	}
	for _, pc := range resp.PeersChangedPatch {
		vp, ok := ms.peers[pc.NodeID]
		if !ok {
			continue
		}
		stats.changed++
		mut := vp.AsStruct()
		if pc.DERPRegion != 0 {
			mut.HomeDERP = pc.DERPRegion
			patchDERPRegion.Add(1)
		}
```

[`map.go#L782-L900`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/map.go#L782)。

**`Peers` が来たら他の差分は全部無視して return する。** 「全部送る」と「差分」が混ざったときの優先順位を、コードの構造で表している。

パッチの適用は `AsStruct()` で読み取り専用ビューから可変の構造体を取り出し、書き換えて `View()` で戻す。**共有されている過去の値を壊さないために、コピーしてから変更する。**

各パッチ種別に `patchDERPRegion` のようなカウンタが付いているのも特徴だ。**どのフィールドが実際にどれくらいパッチとして飛んでいるかを、本番で計測している。**

### パッチへの変換

```go title="control/controlclient/map.go"
// patchifyPeersChanged mutates resp to promote PeersChanged entries to PeersChangedPatch
// when possible.
func (ms *mapSession) patchifyPeersChanged(resp *tailcfg.MapResponse) {
```

[`map.go#L927-L929`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/map.go#L927)。

そして変換の本体が、この章で一番の見どころだ。

```go title="control/controlclient/map.go"
var nodeFields = sync.OnceValue(getNodeFields)

// getNodeFields returns the fields of tailcfg.Node.
func getNodeFields() []string {
	rt := reflect.TypeFor[tailcfg.Node]()
	ret := make([]string, 0, rt.NumField())
	for f := range rt.Fields() {
		ret = append(ret, f.Name)
	}
	return ret
}
```

```go title="control/controlclient/map.go"
	for _, field := range nodeFields() {
		switch field {
		default:
			// The whole point of using reflect in this function is to panic
			// here in tests if we forget to handle a new field.
			panic("unhandled field: " + field)
		case "computedHostIfDifferent", "ComputedName", "ComputedNameWithHost":
			// Caller's responsibility to have populated these.
			continue
		...
		case "ID":
			if was.ID() != n.ID {
				onFalse(field)
				return nil, false
			}
		...
		case "Key":
			if was.Key() != n.Key {
				pc().Key = new(n.Key)
			}
```

[`map.go#L957-L1060`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/map.go#L957)。

**`reflect` で `tailcfg.Node` の全フィールド名を取り出し、`switch` で 1 つずつ処理する。** そして `default` は `panic` だ。コメントが明示している — 「この関数で reflect を使っている目的は、新しいフィールドを扱い忘れたときにテストで panic させることだ」。

各フィールドは 3 通りに分かれる。

- **変わったらパッチにできる** (`Key`、`Endpoints`、`HomeDERP` など) → `PeerChange` に詰める
- **変わったらパッチにできない** (`ID`、`Name`、`Addresses` など) → `return nil, false` でパッチ化を諦め、ノード全体として扱う
- **無視してよい** (計算済みフィールド、廃止済みフィールド) → `continue`

**`tailcfg.Node` に新しいフィールドを足した人は、必ずこの 3 択のどれかを選ばされる。** 選ばなければテストが落ちる。

### 互換性はバージョン番号 1 個

```go title="tailcfg/tailcfg.go"
// CapabilityVersion represents the client's capability level. That
// is, it can be thought of as the client's simple version number: a
// single monotonically increasing integer, rather than the relatively
// complex x.y.z-xxxxx semver+hash(es). Whenever the client gains a
// capability or wants to negotiate a change in semantics with the
// server (control plane),  peers (over PeerAPI), or frontend (over
// LocalAPI), bump this number and document what's new.
type CapabilityVersion int
```

```go title="tailcfg/tailcfg.go"
// CurrentCapabilityVersion is the current capability version of the codebase.
//
// History of versions:
//
//   - 3: implicit compression, keep-alives
//   - 4: opt-in keep-alives via KeepAlive field, opt-in compression via Compress
//   - 5: 2020-10-19, implies IncludeIPv6, delta Peers/UserProfiles, supports MagicDNS
//   - 6: 2020-12-07: means MapResponse.PacketFilter nil means unchanged
   ...
const CurrentCapabilityVersion CapabilityVersion = 145
```

[`tailcfg.go#L37-L197`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tailcfg/tailcfg.go#L37)。

**semver ではなく、単調増加する整数 1 個。** そして 3 から 145 までの全履歴が、1 行ずつコメントで残っている。約 140 行のコメントブロックだ。

判定はすべて `if capver >= N` の形になる。**「このクライアントは何ができるか」が 1 個の整数の比較で決まる。**

## なぜそうなっているか

### なぜ状態配布なのか

Tailscale のクライアントは、**ネットワークが不安定な環境で動く前提** がある。ノートパソコンはスリープし、モバイル端末は電波が切れ、long poll は切断される。

イベント配布だと、切断中に発生したイベントをサーバが覚えておき、再接続時に順番に再送する必要がある。これはサーバ側にセッション状態を持つことを意味し、しかも「クライアントがどこまで受け取ったか」を正確に追う必要がある。

状態配布なら、**再接続時に現在の状態を丸ごと送れば済む**。実際 `MapRequest` には `MapSessionHandle` と `MapSessionSeq` があり、「前のセッションの続きから」を試みるが、**サーバはこれを無視して最初から送り直してよい** と明記されている。差分は最適化であって、正しさの前提ではない。

この「差分は最適化にすぎない」という位置づけが重要だ。クライアント側の `Peers` を受け取ったら差分を全部捨てる、という実装がそれを表している。

### なぜクライアント側でパッチ化するのか

サーバが「HomeDERP だけ変わった」と分かっているなら、最初から `PeersChangedPatch` で送ればよい。実際そうしている場合もある。

それでもクライアント側で変換するのは、**サーバの実装が常に最小の差分を計算できるとは限らない**からだ。サーバ側は複数のデータソース (ノードのハートビート、admin の設定変更、ACL の再評価) からノードを再構築するので、「結果として全体を作り直したが、実は 1 フィールドしか変わっていない」ということが起きる。

クライアント側で比べれば、**サーバの実装がどうであれ、下流には最小の変更が伝わる**。しかもこれは純粋にクライアント内部の最適化なので、プロトコルを変えずに導入できる。

`debugPatchifyPeerMiss` という環境変数で「パッチ化に失敗したのはどのフィールドのせいか」をログに出せるようになっているのも、この最適化を継続的に改善する意図が見える。

### なぜ reflect で panic させるのか

`tailcfg.Node` は control server とクライアントのあいだの契約であり、**フィールドが増え続ける**。増えたときに `peerChangeDiff` を更新し忘れると、そのフィールドの変更が **黙って無視される** バグになる。パッチ化されたときに新フィールドがコピーされず、古い値が残り続ける。

こういう「更新し忘れると静かに壊れる」箇所は、**忘れたら壊れるのではなく、忘れたら止まるようにする** のが定石だ。Go には switch の網羅性チェックがないので、reflect でフィールド名を列挙して `default: panic` を置いている。

コストは reflect の実行時オーバーヘッドだが、`sync.OnceValue` で 1 回だけ計算してキャッシュされる。**フィールド名の文字列比較が 30 回ほど走る**が、パッチ化は netmap 更新のたびにしか起きないので問題にならない。

### なぜ semver ではないのか

コメントが理由を書いている — semver は「x.y.z-xxxxx + ハッシュ」で複雑だ、と。

分散システムの互換性判定で本当に必要なのは、**「相手はこの機能を知っているか」の 1 ビット** だ。それを機能ごとに調べるなら機能フラグの集合になるが、Tailscale は「クライアントは単調に進化する」という前提を置いて、**整数 1 個の大小比較**に落としている。

この前提が成り立つのは、**クライアントの実装が 1 つしかない**からだ。Tailscale のクライアントは全部この 1 リポジトリから出ている。複数ベンダの実装が混在するプロトコル (HTTP や TLS) では成り立たない。

そして履歴を全部コメントに残すことで、**`capver >= 87` という条件を見たときに、87 が何だったかをその場で引ける**。これは grep 可能な設計ドキュメントとして機能している。

## どう活かすか

**「状態を配る」と「イベントを配る」の選択は、再接続時のコストで決めるとよい。** 接続が切れる前提があるなら状態配布が楽だ。サーバがセッションを覚えなくてよくなり、「取りこぼし」という状態が存在しなくなる。そのうえで差分を **最適化として** 足す。差分を正しさの前提にすると、状態配布の利点が消える。

**差分を段階的に持つのは、大きな状態を配るときの実用的な形だ。** Tailscale は「全部 / ノード単位 / フィールド単位」の 3 段階を持ち、どれで送るかはサーバが決める。受け取る側は全部理解できればよく、送る側は都合のよいものを選べる。

**受け取った側で差分を計算し直す発想は、覚えておく価値がある。** 上流が最小の差分をくれるとは限らないなら、手元の古い値と比べて自分で計算すればよい。上流の実装品質に依存せず、下流には常に最小の変更が伝わる。React の再レンダリング抑制や、設定リロードでの差分適用と同じ構図だ。

**「フィールドを追加したら必ず対応を書かされる」仕掛けは、契約が育つデータ型を持つコードベースで効く。** Go なら reflect + `default: panic`、Rust や TypeScript なら網羅性チェックのある `match` / `switch` で同じことができる。**静かに壊れる箇所を、うるさく壊れる箇所に変える** のが目的だ。

**単調増加する整数 1 個での互換性管理は、実装が 1 つに閉じているなら有効。** 複数の独立実装がある場合は機能ネゴシエーションが要る。そして採用するなら、**番号の意味を必ずコードのコメントに残す**。番号だけが残って意味が失われると、条件分岐を消せなくなる。
