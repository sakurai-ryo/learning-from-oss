---
title: "WireGuard とは別に、経路探索用のプロトコルを喋る"
description: "同じ UDP ソケットに、WireGuard のパケットと混ぜて流れる 9 種類のメッセージ。先頭 6 バイトの TS💬 で見分ける。Pong は「あなたはどのアドレスから来たか」を返すので、ピアどうしが互いの STUN サーバになる。CallMeMaybe は「今から君に送るから、君もこっちに送って」という NAT 越えの合図だ。"
group: "NAT 越え"
sidebar:
  order: 12
---

## 何を学んだか

### WireGuard の外側に必要なもの

WireGuard は「相手の UDP エンドポイントを知っている」ことを前提にする。その前提を満たすための会話が要る。

- 「この候補アドレスに送ったら届くか」を試す
- 「君から見た僕のアドレスは何か」を教え合う
- 「今から君に送るから、君もこっちに送って」と合図する

これらは **WireGuard のトンネルが張れていない状態で** 交わす必要がある。だからトンネルの中には入れられない。かといって平文で流すと、経路上の第三者が偽の ping を送り込める。

そこで **disco** という独立したプロトコルを、WireGuard と同じ UDP ソケットに混ぜて流す。

### パケットの形

```text
[ TS💬 (6 バイト) ][ 送信者の disco 公開鍵 (32 バイト) ][ nonce (24 バイト) ][ NaCl box ]
                                                                              ↓ 復号
                                              [ メッセージ型 (1) ][ バージョン (1) ][ 本体 ]
```

**送信者の公開鍵は平文で載る。** 受信側は「誰から来たか」を鍵の対応表で引き、共有秘密を作って復号する。中身は暗号化されているが、**誰が誰と disco を交わしているかは経路上から見える**。

WireGuard のパケットと区別するのは、先頭 6 バイトのマジックナンバーだけだ。

### メッセージは 9 種類

| 型                                              | 用途                                   |
| ----------------------------------------------- | -------------------------------------- |
| `Ping` / `Pong`                                 | 経路が通るかの確認                     |
| `CallMeMaybe`                                   | 「今から送るから、そっちからも送って」 |
| `CallMeMaybeVia`                                | 上記の [peer relay](../peer-relay/) 版 |
| `AllocateUDPRelayEndpointRequest` / `Response`  | peer relay の割り当て                  |
| `BindUDPRelayEndpoint` / `Challenge` / `Answer` | peer relay へのバインド                |

基本は最初の 3 つで、残り 6 つは peer relay のために後から追加されたものだ。

### Pong は STUN の応答でもある

`Pong` には `Src` フィールドがあり、**「この Ping は、私からはこのアドレスから来たように見えた」** を返す。

つまり **ピアどうしが互いの STUN サーバとして働く**。STUN サーバに聞かなくても、実際に通信したい相手から「君はこう見えている」を教えてもらえる。しかも STUN サーバへのマッピングと、そのピアへのマッピングは NAT の種類によっては別物なので、**相手から見たアドレスのほうが正確**だ。

### Ping にはパディングが入る

`Ping` の `Padding` フィールドは、末尾に 0 を詰める長さだ。用途は **パス MTU の測定** で、大きな ping が返ってくれば、その経路はそのサイズを通せると分かる ([peer MTU のページ](../peer-mtu/))。

## ソースコードのどこか

### パケット形式の定義

```go title="disco/disco.go"
// Package disco contains the discovery message types.
//
// A discovery message is:
//
// Header:
//
//	magic          [6]byte  // “TS💬” (0x54 53 f0 9f 92 ac)
//	senderDiscoPub [32]byte // nacl public key
//	nonce          [24]byte
//
// The recipient then decrypts the bytes following (the nacl box)
// and then the inner payload structure is:
//
//	messageType     byte  (the MessageType constants below)
//	messageVersion  byte  (0 for now; but always ignore bytes at the end)
//	message-payload [...]byte
package disco
```

[`disco.go#L4-L20`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/disco/disco.go#L4-L20)。

**「常に末尾のバイトは無視せよ」** が前方互換の規約として書かれている。将来メッセージにフィールドが増えても、古いクライアントは知っている部分だけ読んで残りを捨てる。

マジックナンバーが絵文字なのは実用的な理由もある。`TS` の 2 バイトだけだと偶然一致する確率が無視できないが、6 バイトあれば十分に稀だ。

```go title="disco/disco.go"
const (
	TypePing                             = MessageType(0x01)
	TypePong                             = MessageType(0x02)
	TypeCallMeMaybe                      = MessageType(0x03)
	TypeBindUDPRelayEndpoint             = MessageType(0x04)
	TypeBindUDPRelayEndpointChallenge    = MessageType(0x05)
	TypeBindUDPRelayEndpointAnswer       = MessageType(0x06)
	TypeCallMeMaybeVia                   = MessageType(0x07)
	TypeAllocateUDPRelayEndpointRequest  = MessageType(0x08)
	TypeAllocateUDPRelayEndpointResponse = MessageType(0x09)
)
```

[`disco.go#L44-L54`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/disco/disco.go#L44-L54)。

### Ping

```go title="disco/disco.go"
type Ping struct {
	// TxID is a random client-generated per-ping transaction ID.
	TxID [12]byte

	// NodeKey is allegedly the ping sender's wireguard public key.
	// Old clients (~1.16.0 and earlier) don't send this field.
	// It shouldn't be trusted by itself, but can be combined with
	// netmap data to reduce the discokey:nodekey relation from 1:N to
	// 1:1.
	NodeKey key.NodePublic

	// Padding is the number of 0 bytes at the end of the
	// message. (It's used to probe path MTU.)
	Padding int
}
```

[`disco.go#L134-L148`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/disco/disco.go#L134-L148)。

**`NodeKey` のコメントが「allegedly (自称)」から始まる。** そして「それ単体では信用してはいけない」と続く。

なぜこのフィールドが要るのか。**1 つの disco key に複数の node key が対応しうる** からだ。ノードが node key をローテーションした直後、netmap には新旧 2 つのノードが同じ disco key で載ることがある。ping を受け取っただけでは、どちらのノードから来たか分からない。

送信者が自己申告した node key と、netmap にある「この disco key を持つノードの一覧」を突き合わせれば、1 つに絞れる。**自己申告を、独立した情報源と組み合わせて検証する。**

### パース

```go title="disco/disco.go"
func parsePing(ver uint8, p []byte) (m *Ping, err error) {
	if len(p) < 12 {
		return nil, errShort
	}
	m = new(Ping)
	m.Padding = len(p)
	p = p[copy(m.TxID[:], p):]
	m.Padding -= 12
	// Deliberately lax on longer-than-expected messages, for future
	// compatibility.
	if len(p) >= key.NodePublicRawLen {
		m.NodeKey = key.NodePublicFromRaw32(mem.B(p[:key.NodePublicRawLen]))
		m.Padding -= key.NodePublicRawLen
	}
	return m, nil
}
```

[`disco.go#L169-L183`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/disco/disco.go#L169-L183)。

**「予想より長いメッセージには意図的に寛容」。** 短すぎるものは拒否するが、長いぶんはパディングとして扱う。

パディングの計算が巧妙だ。全体の長さから、読んだフィールドのぶんを引いていく。**「残りは全部パディング」なので、新しいフィールドが追加されても壊れない** (古いクライアントはそれをパディングだと思うだけ)。

### CallMeMaybe

```go title="disco/disco.go"
// CallMeMaybe is a message sent only over DERP to request that the recipient try
// to open up a magicsock path back to the sender.
//
// The sender should've already sent UDP packets to the peer to open
// up the stateful firewall mappings inbound.
//
// The recipient may choose to not open a path back, if it's already
// happy with its path. But usually it will.
type CallMeMaybe struct {
	// MyNumber is what the peer believes its endpoints are.
	//
	// Prior to Tailscale 1.4, the endpoints were exchanged purely
	// between nodes and the control server.
	//
	// Starting with Tailscale 1.4, clients advertise their endpoints.
	// Older clients won't use this, but newer clients should
	// use any endpoints in here that aren't included from control.
	//
	// Control might have sent stale endpoints if the client was idle
	// before contacting us. In that case, the client likely did a STUN
	// request immediately before sending the CallMeMaybe to recreate
	// their NAT port mapping, and that new good endpoint is included
	// in this field, but might not yet be in control's endpoints.
	MyNumber []netip.AddrPort
}
```

[`disco.go#L186-L212`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/disco/disco.go#L186-L212)。

**NAT 越えの中核が、このコメント 3 行に書かれている。**

1. このメッセージは DERP 経由でしか送らない
2. 送信者は **既にピアへ UDP パケットを送っているはず** — ステートフルなファイアウォールの内向きマッピングを開けるために
3. 受信者は既に良い経路を持っていれば無視してよい

これが「同時オープン」の合図だ。A が B に UDP を送る (A の NAT に穴が開くが、B の NAT で落とされる)。A が DERP 経由で「送ったよ」と伝える。B が A に UDP を送る (B の NAT に穴が開き、A の NAT はさっき開いた穴で受け取れる)。**両方が先に送ることで、両方の NAT を通る。**

`MyNumber` の説明も実践的だ。control が配るエンドポイント情報は古いかもしれない。クライアントは CallMeMaybe を送る直前に STUN を打ち直して NAT のマッピングを作り直しているので、**そのとき得た最新のアドレスは control より新しい**。

### 受信側の検証順序

```go title="wgengine/magicsock/magicsock.go"
	var di *discoInfo
	switch {
	case shouldBeRelayHandshakeMsg:
		...
	case c.peerMap.knownPeerDiscoKey(sender):
		di = c.discoInfoForKnownPeerLocked(sender)
	default:
		metricRecvDiscoBadPeer.Add(1)
		if debugDisco() {
			c.logf("magicsock: disco: ignoring disco-looking frame, don't know of key %v", sender.ShortString())
		}
		return
	}
	...
	// We're now reasonably sure we're expecting communication from 'sender',
	// do the heavy crypto lifting to see what they want.

	sealedBox := msg[discoHeaderLen:]
	payload, ok := di.sharedKey.Open(sealedBox)
```

[`magicsock.go#L2212-L2246`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L2212)。

**「送信者を知っているか」を先に確認してから、重い復号をする。** 知らない鍵からのパケットは、マップの参照 1 回で捨てられる。コメントが「これで送信者からの通信を期待していると十分に確信できたので、重い暗号処理をする」と書いている。

**インターネットに開いた UDP ポートには、無関係なパケットが飛んでくる。** そのすべてに公開鍵暗号を走らせると、それだけで CPU を消費する DoS になる。安い検査を前に置く。

### 復号失敗を通常はログしない

```go title="wgengine/magicsock/magicsock.go"
	if !ok {
		// This might have been intended for a previous
		// disco key.  When we restart we get a new disco key
		// and old packets might've still been in flight (or
		// scheduled). This is particularly the case for LANs
		// or non-NATed endpoints. UDP offloading on Linux
		// can also cause this when a disco message is
		// received via raw socket at the head of a coalesced
		// group of messages. Don't log in normal case.
```

[`magicsock.go#L2247-L2256`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L2247)。

**復号失敗は「攻撃」ではなく「日常」だ。** [disco key は再起動で変わる](../keys/)ので、飛行中のパケットが古い鍵宛になる。Linux の UDP オフロードでも起きる。

ログを出すと、正常な運用でログが溢れる。だからカウンタ (`metricRecvDiscoBadKey`) だけ増やして黙る。**「異常だがログに値しない」ものをカウンタで数える**。

パースの失敗も同じ扱いだ。

```go title="wgengine/magicsock/magicsock.go"
	if err != nil {
		// Couldn't parse it, but it was inside a correctly
		// signed box, so just ignore it, assuming it's from a
		// newer version of Tailscale that we don't
		// understand. Not even worth logging about, lest it
		// be too spammy for old clients.
		metricRecvDiscoBadParse.Add(1)
		return
	}
```

[`magicsock.go#L2278-L2286`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L2278)。

**正しく暗号化されていたなら、パースできなくても攻撃ではない。** 新しいバージョンのクライアントが、こちらの知らないメッセージを送ってきただけだ。

### 経路の制約を検証する

```go title="wgengine/magicsock/magicsock.go"
		if !isDERP || derpNodeSrc.IsZero() {
			// CallMeMaybe{Via} messages should only come via DERP.
			c.logf("[unexpected] %s packets should only come via DERP", msgType)
			return
		}
```

[`magicsock.go#L2344-L2348`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L2344)。

**`CallMeMaybe` が UDP で直接来たら拒否する。** 直接届いているなら、そもそも経路があるので CallMeMaybe は不要だ。加えて、DERP 経由に限ることで **送信者の node key が DERP から分かる** (DERP は node key でルーティングするため)。

Tailscale のコードには `[unexpected]` というログのプレフィックスが多数ある。**「起きないはずだが、起きても落とさない」箇所の目印** で、grep で一覧できる。

## なぜそうなっているか

### なぜ WireGuard の中に入れないのか

トンネルが張れていない状態で交わす必要があるからだ。「経路を見つけるための会話」を、経路が見つかった後にしか使えないトンネルの中に入れることはできない。

**そして disco と WireGuard は同じ UDP ソケット・同じポートを使う。** これは必須の性質だ。別のポートを使うと、NAT が別のマッピングを作るので、disco で「このアドレスは通る」と確認しても WireGuard では通らない。**探索に使う経路と、データが流れる経路が同一でなければ、探索に意味がない。**

### なぜ送信者の公開鍵が平文なのか

受信側は、復号する前に「どの共有秘密を使うか」を決める必要がある。NaCl box は送信者と受信者の鍵ペアから共有秘密を作るので、**送信者が分からなければ復号できない**。

これは Noise の IK パターンとは違う判断だ。Noise なら送信者の身元も暗号化できる。だが disco は 1 パケット単位で完結する必要があり (ハンドシェイクの往復を挟めない)、しかもコネクションレスだ。**ハンドシェイクなしで単発の暗号化メッセージを送るには、送信者の識別子を平文で載せるしかない。**

代償として、通信の相手関係が経路上から見える。ただし [disco key はプロセス起動ごとに変わる](../keys/)ので、長期的な追跡はしにくい。

### なぜ Pong に送信元アドレスを入れるのか

STUN サーバに聞いて分かるのは「STUN サーバから見た自分のアドレス」だ。NAT が Address-Dependent Mapping (hard NAT) なら、**宛先ごとに違うマッピングが作られる** ので、この情報はそのピアには使えない。

`Pong` の `Src` は「**そのピアから見た**自分のアドレス」だ。ping が実際にそのピアに届いた事実と、そのときのアドレスが同時に分かる。

**測定を専用のサーバに任せず、通信したい相手そのものから得る。** これは NAT 越えの一般的な設計指針で、ICE の connectivity check も同じことをしている。

### なぜ「知っている鍵か」を先に見るのか

UDP ポートを開けておくと、インターネットからスキャンのパケットが飛んでくる。無関係なプロトコルのパケットが偶然マジックナンバーに一致することもある。

**Curve25519 のスカラー倍算は 1 回あたり数十マイクロ秒かかる。** 秒間数万パケットのフラッドを受けたら、それだけで CPU が飽和する。マップの参照は数十ナノ秒なので、3 桁違う。

安い検査を前に置くのは、暗号を扱うサーバの基本形だ。TLS でも、Cookie ベースの DoS 対策 (DTLS の HelloVerifyRequest、QUIC の Retry) が同じ役割を果たしている。

### なぜ未知のメッセージ型を無視するのか

peer relay 用の 6 種類は後から追加された。古いクライアントは 0x04〜0x09 を知らない。

ここでエラーを返したり接続を切ったりすると、**新機能を導入するたびに古いクライアントが壊れる**。「知らないものは黙って捨てる」なら、新しいメッセージ型は古いクライアントに無視されるだけで済む。

**ただし、これが成立するのは「無視しても安全」なメッセージに限る。** disco のメッセージはすべて「試みる」性質のもので、無視されたら別の手段にフォールバックする。無視されると壊れる種類のメッセージなら、capability version で送信前に判定する必要がある。

## どう活かすか

**制御メッセージとデータで同じ経路 (同じソケット、同じポート、同じ 5-tuple) を使う。** 経路の性質を測る目的なら、測定に使う経路とデータが流れる経路が同一でなければ意味がない。NAT、ロードバランサ、ECMP のあるネットワークでは、別のポートを使った瞬間に別の経路になりうる。

**暗号処理の前に、安いフィルタを置く。** 公開鍵暗号は 3 桁遅い。「知っている送信者か」をマップ参照で判定してから復号する。インターネットに開いた口を持つすべてのサービスで有効な形だ。

**「正常な運用で起きる異常」はログではなくカウンタで数える。** 復号失敗、パース失敗、未知のメッセージ。ログに出すと本物の異常が埋もれる。カウンタなら、増加率が異常なときだけ気づける。**そして「なぜ正常なのか」をコメントに書く** — 書かないと、後から見た人が「これはログすべきでは」と直してしまう。

**自己申告の情報は、独立した情報源と突き合わせて使う。** disco の Ping に入る node key は「allegedly」と明記され、netmap のデータと組み合わせて初めて意味を持つ。単体で信用してよいかを、フィールドのコメントに書いておく。

**メッセージの末尾は常に無視できるようにしておく。** 「短すぎたらエラー、長いぶんは無視」という規約を最初に決めておけば、フィールドの追加がプロトコル変更にならない。長さプレフィックスや TLV より単純で、多くの場合これで足りる。

**「起きないはずだが落とさない」箇所には、grep できる目印を付ける。** Tailscale の `[unexpected]` は、ログを検索すれば「想定外だが処理は続けた」箇所を全部拾える。assert で落とすほどではないが、起きたら知りたいものに使える。
