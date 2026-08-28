---
title: "DERP でも直結でもない、第三の経路"
description: "tailnet の中の別のノードを UDP のリレーにする。パケットは Geneve でカプセル化され、24 ビットの VNI が「どのペアの通信か」を表す。リレーサーバは中身を復号できず、鍵交換もしない。バインドのハンドシェイクは、鍵ではなく MAC と 2 分でローテーションする秘密で守られる。"
group: "NAT 越え"
sidebar:
  order: 16
---

## 何を学んだか

### DERP とは別の中継

直結できないとき、[DERP](../derp/) にフォールバックする。だが DERP は Tailscale 社が運営する共有インフラで、地理的に遠いこともある。

**同じ tailnet の中に、両者から到達できるノードがあるなら、そこを中継にすればいい。** これが peer relay だ。オフィスの中に 1 台よく繋がるサーバがあれば、そこを経由するほうが DERP より速い。

DERP との違い。

|                | DERP             | peer relay           |
| -------------- | ---------------- | -------------------- |
| 運営           | Tailscale (共有) | tailnet 自身のノード |
| トランスポート | TCP (HTTP)       | UDP                  |
| 宛先の指定     | node key         | Geneve の VNI        |
| 事前接続       | 常時             | 使うときだけ         |
| 優先度         | 最後の砦         | 直結の次             |

### Geneve でカプセル化する

peer relay を通るパケットには **Geneve ヘッダ (RFC 8926) が 8 バイト付く**。中の 24 ビットが VNI (Virtual Network Identifier) で、**「どのクライアントペアの通信か」を表す**。

リレーサーバは VNI を見て転送先を決める。中身は読まない。Geneve の Protocol Type フィールドで、中身が disco か WireGuard かを区別する。

### 割り当てとバインドの流れ

1. クライアント A が、候補のリレーノードに `AllocateUDPRelayEndpointRequest` を送る
2. リレーが VNI を 1 つ割り当て、A と B (相手) の disco 公開鍵に紐づける
3. A は `CallMeMaybeVia` で B に「このリレーが使える」と伝える
4. A と B がそれぞれ `BindUDPRelayEndpoint` をリレーに送る
5. リレーが `Challenge` を返し、クライアントが `Answer` で返す
6. 両側のバインドが完了したら、パケットが流れ始める

**リレーは 30 秒でバインドを諦める。** バインドが完了したら 5 分の無通信でエンドポイントを解放する。

### リレーは鍵を持たない

リレーサーバは **クライアント間の共有鍵を持たない**。バインドのハンドシェイクを検証するのは、リレー自身の disco 鍵と、**2 分ごとにローテーションする MAC 用の秘密** だ。

## ソースコードのどこか

### サーバの状態

```go title="net/udprelay/server.go"
// Package udprelay contains a relay server implementation for relaying Disco
// and WireGuard packets between Tailscale clients over UDP. This relay
// functionality is also known as Tailscale Peer Relays.
package udprelay
```

```go title="net/udprelay/server.go"
	mu                  sync.Mutex // guards the following fields
	macSecrets          views.Slice[[blake2s.Size]byte] // [0] is most recent, max 2 elements
	macSecretRotatedAt  mono.Time
	...
	// serverEndpointByVNI is consistent with serverEndpointByDisco while mu is
	// held, i.e. mu must be held around write ops. Read ops in performance
	// sensitive paths, e.g. packet forwarding, do not need to acquire mu.
	serverEndpointByVNI   sync.Map // key is uint32 (Geneve VNI), value is [*serverEndpoint]
	serverEndpointByDisco map[key.SortedPairOfDiscoPublic]*serverEndpoint
}

const macSecretRotationInterval = time.Minute * 2
```

[`server.go#L89-L106`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/udprelay/server.go#L89-L106)。

**同じデータに 2 つの索引がある。** VNI からの検索 (パケット転送のたびに使う) は `sync.Map` で、ロックなしで読める。disco 鍵ペアからの検索 (割り当てのときだけ) は普通のマップで、ミューテックスを取る。

**アクセス頻度が 3 桁違うので、データ構造も分けている。** コメントが「パフォーマンスに敏感なパスでは mu を取る必要がない」と明示している。

`key.SortedPairOfDiscoPublic` という型も特徴的だ。**2 つの鍵を順序に依存しない形で 1 つのキーにする。** A→B と B→A が同じエンドポイントを指す。

### エンドポイントの状態

```go title="net/udprelay/server.go"
type serverEndpoint struct {
	// discoPubKeys contains the key.DiscoPublic of the served clients. The
	// indexing of this array aligns with the following fields, e.g.
	// discoSharedSecrets[0] is the shared secret to use when sealing
	// Disco protocol messages for transmission towards discoPubKeys[0].
	discoPubKeys       key.SortedPairOfDiscoPublic
	discoSharedSecrets [2]key.DiscoShared
	lamportID          uint64
	vni                uint32
	allocatedAt        mono.Time

	mu                   sync.Mutex        // guards the following fields
	closed               bool
	inProgressGeneration [2]uint32
	boundAddrPorts       [2]netip.AddrPort // or zero value if a handshake has never completed for that relay leg
	lastSeen             [2]mono.Time
	packetsRx            [2]uint64
	bytesRx              [2]uint64
}
```

[`server.go#L115-L133`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/udprelay/server.go#L115-L133)。

**すべてのフィールドが長さ 2 の配列だ。** リレーは常に 2 者間の中継なので、「0 番目のクライアント」「1 番目のクライアント」で固定できる。マップも slice も要らず、インデックスが `discoPubKeys` の順序と一致することがコメントで保証されている。

`lamportID` はランポートタイムスタンプで、**古い割り当てと新しい割り当てを順序づける**ために使う。クライアントが再割り当てを要求したとき、どちらが新しいかを判断できる。

### 割り当ての生存期間

```go title="net/udprelay/server.go"
const (
	// defaultBindLifetime is somewhat arbitrary. We attempt to account for
	// high latency between client and [Server], and high latency between
	// clients over side channels, e.g. DERP, used to exchange
	// [endpoint.ServerEndpoint] details. So, a total of 3 paths with
	// potentially high latency. Using a conservative 10s "high latency" bounds
	// for each path we end up at a 30s total. It is worse to set an aggressive
	// bind lifetime as this may lead to path discovery failure, vs dealing with
	// a slight increase of [Server] resource utilization (VNIs, RAM, etc) while
	// tracking endpoints that won't bind.
	defaultBindLifetime        = time.Second * 30
	defaultSteadyStateLifetime = time.Minute * 5
)
```

[`server.go#L52-L64`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/udprelay/server.go#L52-L64)。

**30 秒という値の導出が書かれている。** 「クライアント → サーバ」「クライアント → DERP → クライアント」「クライアント → サーバ」の 3 経路それぞれに保守的な 10 秒を見積もって 30 秒。

そして **トレードオフの向きが明示されている**。「短すぎて経路探索に失敗するほうが、バインドされないエンドポイントを追跡してリソースを少し余分に使うより悪い」。**どちらの失敗がより痛いかを決めてから、値を選んでいる。**

### Geneve ヘッダ

```go title="net/packet/geneve.go"
const (
	// GeneveProtocolDisco is the IEEE 802 Ethertype number used to represent
	// the Tailscale Disco protocol in a Geneve header.
	GeneveProtocolDisco uint16 = 0x7A11
	// GeneveProtocolWireGuard is the IEEE 802 Ethertype number used to represent the
	// WireGuard protocol in a Geneve header.
	GeneveProtocolWireGuard uint16 = 0x7A12
)

// VirtualNetworkID is a Geneve header (RFC8926) 3-byte virtual network
// identifier. Its methods are NOT thread-safe.
type VirtualNetworkID struct {
	_vni uint32
}

const (
	vniSetMask uint32 = 0xFF000000
	vniGetMask uint32 = ^vniSetMask
)

// IsSet returns true if Set() had been called previously, otherwise false.
func (v *VirtualNetworkID) IsSet() bool {
	return v._vni&vniSetMask != 0
}
```

[`geneve.go#L18-L51`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/packet/geneve.go#L18-L51)。

**VNI は 3 バイトだが、Go では `uint32` に入れる。余った上位 1 バイトを「設定済みフラグ」に使っている。**

`*VirtualNetworkID` を `netip.AddrPort` と並べて [epAddr](../derp-to-direct/) に埋めることで、「VNI が設定されているか」で経路種別を判定できる。**ポインタや `Optional[T]` を使わずに、値型のまま 3 値 (未設定 / VNI=0 / VNI=N) を表現している。**

Ethertype として `0x7A11`、`0x7A12` を選んでいるのは、標準に登録されていない私用の値だ。Geneve の枠組みに乗りつつ、中身は Tailscale 独自のプロトコルになっている。

### バインドのハンドシェイク

```go title="disco/disco.go"
type BindUDPRelayEndpointCommon struct {
	// VNI is the Geneve header Virtual Network Identifier field value, which
	// must match this disco-sealed value upon reception. If they are
	// non-matching it indicates the cleartext Geneve header was tampered with
	// and/or mangled.
	VNI uint32
	// Generation represents the handshake generation. Clients must set a new,
	// nonzero value at the start of every handshake.
	Generation uint32
	// RemoteKey is the disco key of the remote peer participating over this
	// relay endpoint.
	RemoteKey key.DiscoPublic
	// Challenge is set by the server in a [BindUDPRelayEndpointChallenge]
	// message, and expected to be echoed back by the client in a
	// [BindUDPRelayEndpointAnswer] message. Its value is irrelevant in a
	// [BindUDPRelayEndpoint] message, where it simply serves a padding purpose
	// ensuring all handshake messages are equal in size.
	Challenge [BindUDPRelayChallengeLen]byte
}
```

[`disco.go#L347-L365`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/disco/disco.go#L347-L365)。

読みどころが 3 つある。

**1. VNI が平文のヘッダと暗号化された中身の両方に入る。** 一致しなければ、平文の Geneve ヘッダが改竄されたと分かる。**外側の平文フィールドを、内側の暗号化された値で認証する** という手法だ。

**2. `Generation` でハンドシェイクの世代を区別する。** 再ハンドシェイクのときに古い応答が混ざるのを防ぐ。

**3. `Challenge` フィールドは、最初のメッセージでは意味を持たない。「すべてのハンドシェイクメッセージのサイズを揃えるためのパディング」。** サイズが違うと、パケット長だけで種類が推測できてしまう。増幅攻撃 (小さなリクエストで大きな応答を引き出す) の余地もなくなる。

### MAC で検証する

```go title="net/udprelay/server.go"
func blakeMACFromBindMsg(blakeKey [blake2s.Size]byte, src netip.AddrPort, msg disco.BindUDPRelayEndpointCommon) ([blake2s.Size]byte, error) {
	input := make([]byte, 8, 4+4+32+18) // vni + generation + invited party disco key + addr:port
	binary.BigEndian.PutUint32(input[0:4], msg.VNI)
	binary.BigEndian.PutUint32(input[4:8], msg.Generation)
	input = msg.RemoteKey.AppendTo(input)
	input, err := src.AppendBinary(input)
	...
	h, err := blake2s.New256(blakeKey[:])
```

[`server.go#L135-L155`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/udprelay/server.go#L135-L155)。

**チャレンジは「VNI + 世代 + 相手の disco 鍵 + 送信元アドレス」の MAC** だ。サーバは状態を持たずにチャレンジを生成でき、返ってきた答えを再計算して検証できる。

MAC の鍵は 2 分ごとにローテーションし、**直前の鍵も 1 つ保持する** (`macSecrets` は最大 2 要素)。ローテーションの瞬間に飛んでいたチャレンジも検証できる。

**送信元アドレスを MAC に含めるのが要点だ。** 別のアドレスから同じチャレンジを返しても検証に失敗する。送信元 IP を詐称した攻撃者は、チャレンジを受け取れない (応答は本物のアドレスに返る) ので、答えを作れない。**DTLS の HelloVerifyRequest や QUIC の Retry と同じ形式** だ。

### クライアント側の調整役

```go title="wgengine/magicsock/relaymanager.go"
// relayManager manages allocation, handshaking, and initial probing (disco
// ping/pong) of [tailscale.com/net/udprelay.Server] endpoints. The zero value
// is ready for use.
//
// [relayManager] methods can be called by [Conn] and [endpoint] while their .mu
// mutexes are held. Therefore, in order to avoid deadlocks, [relayManager] must
// never attempt to acquire those mutexes synchronously from its runLoop(),
// including synchronous calls back towards [Conn] or [endpoint] methods that
// acquire them.
type relayManager struct {
	initOnce sync.Once

	// hasPeerRelayServers is whether relayManager is configured with at
	// least one peer relay server ...
	// Exposed as an atomic so [endpoint] hot paths
	// can short-circuit when there are no relay servers without taking any
	// lock or entering the run loop.
	hasPeerRelayServers atomic.Bool

	// ===================================================================
	// The following fields are owned by a single goroutine, runLoop().
	serversByNodeKey                        map[key.NodePublic]candidatePeerRelay
	allocWorkByCandidatePeerRelayByEndpoint map[*endpoint]map[candidatePeerRelay]*relayEndpointAllocWork
	...
```

[`relaymanager.go#L26-L55`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/relaymanager.go#L26-L55)。

**デッドロックを避けるための規約が、型のドキュメントに書かれている。** 「`Conn` と `endpoint` のミューテックスを持ったまま呼ばれうるので、`runLoop()` からそれらを同期的に取ってはいけない」。

構造としては **状態を 1 つの goroutine が所有し、外部とはチャネルでやりとりする**。区切り線 (`===`) を引いて「ここから下は runLoop が所有する」と明示している。ミューテックスの代わりに goroutine の所有権で守る形だ。

そして **peer relay を 1 つも設定していないときのために `atomic.Bool` が 1 個ある**。ホットパスはこれを見て即座に抜けられる。ほとんどのユーザーは peer relay を使わないので、その場合のコストをゼロに近づけている。

## なぜそうなっているか

### なぜ DERP があるのに peer relay を作るのか

DERP は Tailscale 社の共有インフラなので、

- **地理的に遠いことがある。** 東京のノード 2 台が、シンガポールの DERP を経由する
- **帯域が共有される。** 他のユーザーと同じサーバを使う
- **TCP なので head-of-line blocking がある。** 1 パケットのロスが後続を止める

同じ LAN や同じデータセンターに「両方から見えるノード」があるなら、そこを経由するほうが速い。**「直結できないが、共通の第三者を経由できる」という状況は、企業ネットワークで頻繁に起きる。**

### なぜ Geneve なのか

自前のカプセル化ヘッダを定義することもできた。だが Geneve を選ぶと、

- **既存の道具が使える。** Wireshark が解析できる。tcpdump のフィルタが書ける
- **仕様が決まっている。** VNI の位置、Protocol Type の意味、拡張の方法
- **ハードウェアオフロードの可能性がある。** 一部の NIC は Geneve を認識する

必要なのは「24 ビットの識別子と、中身のプロトコル種別」だけで、Geneve はそれをちょうど提供する。**車輪を再発明せずに、既存の枠に自分のプロトコルを載せている。**

### なぜリレーは鍵を持たないのか

peer relay を担うのは **tailnet 内の普通のノード** だ。そのノードの管理者が、経由する通信を読めてはいけない。

だからリレーは WireGuard の鍵交換に関与しない。中継するのは、既に暗号化されたパケットだけだ。リレーが検証するのは「このパケットは、この VNI にバインドされたクライアントから来たか」だけで、中身には触れない。

**中継の権限と、復号の権限を分離する。** これは DERP でも同じで、Tailscale 社のサーバもユーザーの通信を読めない。

### なぜチャレンジを MAC で作るのか

素朴には「ランダムなチャレンジを生成して、テーブルに覚えておく」となる。だが、

- **攻撃者が大量のバインド要求を送れば、テーブルが溢れる。** 状態を持つこと自体が DoS の的になる
- **クライアント数 × ハンドシェイク数のメモリが要る**

MAC なら **サーバは状態を持たない**。返ってきた答えから MAC を再計算して一致を見るだけだ。秘密鍵さえあれば検証できる。

そして送信元アドレスを MAC に含めることで、**アドレス詐称した相手はチャレンジを受け取れない** (応答は詐称されたアドレスに返る)。増幅攻撃と、なりすましの両方を同時に防いでいる。

### なぜ MAC の秘密を 2 分でローテーションするのか

秘密が漏れたときの被害を時間で区切るためだ。2 分経てば、漏れた秘密で作れるチャレンジは検証に通らなくなる。

**古い秘密を 1 つ保持するのは、ローテーションの瞬間に飛んでいるパケットのため。** バインドの往復に数百 ms かかるので、ちょうどその間にローテーションが起きうる。新旧両方で検証すれば取りこぼさない。

「新旧 2 つの鍵を保持する」は、鍵ローテーションの定石だ。

### なぜ 2 者間に固定するのか

`serverEndpoint` のフィールドがすべて長さ 2 の配列なのは、**リレーが 3 者以上を扱わないと決めたから** だ。

一般化して N 者にすると、マップやスライスが要り、「どのクライアントから来たか」の検索が必要になる。パケット転送のたびに検索が走る。

2 者固定なら、**送信元アドレスが `boundAddrPorts[0]` なら転送先は `[1]`、逆も同様** で、比較 1 回で決まる。VPN の中継としては 2 者で十分なので、一般化しないことで速さと単純さを得ている。

## どう活かすか

**同じデータに対して、アクセス頻度が桁違いの経路が 2 つあるなら、索引を分ける。** 高頻度側はロックフリーな構造 (`sync.Map`、atomic ポインタ、不変スナップショット)、低頻度側は普通のマップ + ミューテックス。**両者の一貫性をどう保つかをコメントに書く** のが必須になる。

**タイムアウト値は「どちらの失敗がより痛いか」を決めてから選ぶ。** peer relay のバインドは「短すぎて失敗する」ほうが「長すぎてリソースを食う」より悪いと判断し、保守的に 30 秒にしている。値そのものより、この判断がレビュー可能な形で書かれていることに価値がある。

**外側の平文ヘッダは、内側の暗号化されたコピーで認証できる。** カプセル化するプロトコルでは、外側のヘッダは中継装置に読ませる必要があるので暗号化できない。同じ値を内側にも入れておけば、改竄を検出できる。

**ハンドシェイクのメッセージはサイズを揃える。** 意味のないパディングを入れてでも揃えると、パケット長からの推測を防ぎ、増幅攻撃の余地もなくなる。

**接続前の状態は、MAC で表現すると持たなくて済む。** 「チャレンジを生成して覚えておく」代わりに「チャレンジ = MAC(秘密, 接続情報)」にする。送信元アドレスを含めればアドレス詐称も防げる。SYN cookie、DTLS の HelloVerifyRequest、QUIC の Retry がすべてこの形だ。

**一般化しないことで得られる速さがある。** 「2 者間のみ」と決めれば、配列のインデックス 2 個で全部が表現でき、検索が消える。N 者に拡張する可能性が本当にあるかを先に考える。

**goroutine の所有権で守る状態は、区切り線とコメントで範囲を明示する。** ミューテックスと違って、コンパイラは所有権を検査してくれない。「ここから下は runLoop が所有する」という宣言が、唯一の防御になる。
