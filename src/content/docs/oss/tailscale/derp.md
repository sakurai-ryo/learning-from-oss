---
title: "常時つないでおくリレーが、到達性の最後の砦になる"
description: "DERP は WireGuard 公開鍵をアドレスにして中継するサーバだ。ホームリージョンへの TCP は張りっぱなしにする。1 リージョンに 3 台以上置く理由は quorum ではなく「2 台だと 1 台落ちたときに残りが落ちるから」。輻輳したクライアントへの送信は、キューの先頭から捨てて新しいパケットを優先する。"
group: "NAT 越え"
sidebar:
  order: 14
---

## 何を学んだか

### 公開鍵をアドレスにしたパケット中継

DERP (Designated Encrypted Relay for Packets) は、**IP アドレスではなく Curve25519 の公開鍵で宛先を指定する中継サーバ** だ。

クライアントは自分の [node key](../keys/) で DERP に接続する。パケットを送るときは「この公開鍵宛」と指定すれば、その鍵で接続している別のクライアントに転送される。

中継されるものは 2 種類。

- **[disco メッセージ](../disco-protocol/)** — NAT 越えの最中に使うサイドチャネル
- **暗号化された WireGuard パケット** — UDP が塞がれている、NAT 越えに失敗した場合の最後の手段

### ホームリージョンには常時つなぐ

各クライアントは [netcheck](../netcheck/) の結果から「ホーム DERP リージョン」を選び、**そこには TCP を張りっぱなしにする**。他のノードは、直結できない相手にはその相手のホーム DERP へ送る。

必要に応じて他のリージョンにも接続するが、**永続的に維持するのはホームだけ** だ。

### リージョンの中はメッシュ、リージョン間は繋がない

1 リージョンに複数のサーバノードを置き、**リージョン内は全ノードが互いに接続してパケットを転送する**。転送は 1 ホップまで。リージョン間のルーティングは存在しない。

理由が README に書かれている。**クラウドのロードバランサや anycast は高い**。リージョン内の VPC 内通信は速くて安いので、そこだけメッシュにする。

### 3 台以上置く理由は quorum ではない

> 一般に 1 リージョンあたり最低 3 ノードを動かす。quorum のためではない (投票はない)。2 台では、カスケード障害を考えると不安すぎるからだ。2 台を CPU 51% で動かしていて 1 台落ちたら、残りも落ちる。3 台以上なら、各ノードをもう少し高い負荷で回せる。

### 遅いクライアントには、新しいパケットを優先して送る

DERP サーバはクライアントごとに送信キューを持つ。キューが溢れたとき、**新しいパケットを捨てるのではなく、キューの先頭 (最も古いパケット) を捨てて空きを作る**。

そして **disco 用のキューと、通常パケット用のキューが分かれている**。

## ソースコードのどこか

### プロトコル

```go title="derp/derp.go"
// Package derp implements the Designated Encrypted Relay for Packets (DERP)
// protocol.
//
// DERP routes packets to clients using curve25519 keys as addresses.
//
// DERP is used by Tailscale nodes to proxy encrypted WireGuard
// packets through the Tailscale cloud servers when a direct path
// cannot be found or opened. DERP is a last resort. Both sides
// between very aggressive NATs, firewalls, no IPv6, etc? Well, DERP.
package derp
```

[`derp.go#L4-L13`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/derp/derp.go#L4-L13)。

```go title="derp/derp.go"
/*
Protocol flow:

Login:
* client connects
* server sends FrameServerKey
* client sends FrameClientInfo
* server sends FrameServerInfo

Steady state:
* server occasionally sends FrameKeepAlive (or FramePing)
* client responds to any FramePing with a FramePong
* client sends FrameSendPacket
* server then sends FrameRecvPacket to recipient
*/
const (
	FrameServerKey     = FrameType(0x01) // 8B magic + 32B public key + (0+ bytes future use)
	FrameClientInfo    = FrameType(0x02) // 32B pub key + 24B nonce + naclbox(json)
	FrameServerInfo    = FrameType(0x03) // 24B nonce + naclbox(json)
	FrameSendPacket    = FrameType(0x04) // 32B dest pub key + packet bytes
	FrameForwardPacket = FrameType(0x0a) // 32B src pub key + 32B dst pub key + packet bytes
	FrameRecvPacket    = FrameType(0x05) // v0/1: packet bytes, v2: 32B src pub key + packet bytes
	FrameKeepAlive     = FrameType(0x06) // no payload, no-op (to be replaced with ping/pong)
	FrameNotePreferred = FrameType(0x07) // 1 byte payload: 0x01 or 0x00 for whether this is client's home node
```

[`derp.go#L54-L80`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/derp/derp.go#L54-L80)。

**プロトコルの全体像が、定数定義の直前にコメントとして書かれている。** 「フレームの型は 1 バイト、その後 4 バイトのビッグエンディアン長」。それだけで全部だ。

`FrameSendPacket` と `FrameForwardPacket` の違いに注目したい。前者はクライアントからサーバへ、後者は **メッシュ内のサーバ間** で使う。後者には送信元の鍵も入る (クライアントから来たものではないので、接続から送信元を推測できない)。

### 存在を伝えるフレーム

```go title="derp/derp.go"
	// FramePeerGone is sent from server to client to signal that
	// a previous sender is no longer connected. That is, if A
	// sent to B, and then if A disconnects, the server sends
	// FramePeerGone to B so B can forget that a reverse path
	// exists on that connection to get back to A. It is also sent
	// if A tries to send a CallMeMaybe to B and the server has no
	// record of B
	FramePeerGone = FrameType(0x08) // 32B pub key of peer that's gone + 1 byte reason
```

[`derp.go#L82-L89`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/derp/derp.go#L82-L89)。

**「送ろうとした相手がいない」ことを即座に返す。** これがないと、送信側は「返事が来ない」を延々と待つことになる。パケットを捨てたことを伝えるだけで、上位の経路探索が次の手段に移れる。

`FramePeerPresent` はその逆で、メッシュされたリージョン内で「このピアが接続してきた」を伝える。**フレームの長さで機能を拡張している** のも特徴だ。

> メッセージは最低 32 バイト。その後に 18 バイト以上残っていれば、16 バイトの IP + 2 バイトのポート。もう 1 バイト残っていればフラグ。さらに残っていればアプリ名の長さと本体。**現在のサーバは最低 42 バイト送るが、古いサーバはもっと少なく、新しいサーバはもっと多く送るかもしれない。**

[disco と同じ「末尾は無視してよい」規約](../disco-protocol/) が、ここでも使われている。

### 運用のためのフレーム

```go title="derp/derp.go"
	// FrameClosePeer is a privileged frame type (requires the
	// mesh key for now) that closes the provided peer's
	// connection. (To be used for cluster load balancing
	// purposes, when clients end up on a non-ideal node)
	FrameClosePeer = FrameType(0x11) // 32B pub key of peer to close.
	...
	// FrameRestarting is sent from server to client for the
	// server to declare that it's restarting. Payload is two big
	// endian uint32 durations in milliseconds: when to reconnect,
	// and how long to try total.
	FrameRestarting = FrameType(0x15)
```

[`derp.go#L110-L134`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/derp/derp.go#L110-L134)。

**「再起動する。いつ再接続してきて、どれくらい粘れ」をプロトコルで伝える。** クライアントは切断を検知してからバックオフで再接続するのではなく、**サーバが指定したタイミングで戻ってくる**。数万接続を抱えるサーバを再起動するとき、再接続の集中 (thundering herd) を制御できる。

`FrameClosePeer` は逆方向の運用機能だ。ロードバランスのために、特定クライアントの接続を切って再接続させる。

### 負荷分散の設計

README がリージョン設計の理由を説明している。

> クライアントは遅延に基づいて DERP ホームを選ぶ。これはコストを低く抑えるためで、クラウドのロードバランサ (高い) や anycast (これはリージョン間のサーバ側ルーティングを必然的に要求する) を避けている。

> **コーディネーションサーバは、リージョン内のノード一覧を tailnet の関数として割り当てる。** だから同じ tailnet のノードは一般に同じノードに乗り、転送を必要としない。障害の後だけ、特定 tailnet のクライアントがリージョン内の複数ノードに分かれて、ノード間転送が必要になる。だが時間が経てばまた均衡する。

[`derp/README.md`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/derp/README.md)。

**ロードバランサを使わず、「どのノードに繋ぐか」を control server が tailnet ごとに決める。** 同じ tailnet のメンバーが同じノードに集まれば、リージョン内の転送すら要らなくなる。

そして 3 台以上を置く理由。

> quorum のためではない (投票はない)。単に、カスケード障害を考えると 2 台では不安すぎるからだ。2 台を 51% の負荷 (CPU、メモリなど) で動かしていて 1 台が落ちたら、2 台目も落ちる。3 台以上なら、各ノードをもう少し熱く回せる。

**「N 台構成の N をどう決めるか」に、可用性の理屈ではなく容量の理屈で答えている。**

### 遅いクライアントへの送信

```go title="derp/derpserver/derpserver.go"
func (c *sclient) sendPkt(dst *sclient, p pkt) error {
	s := c.s
	dstKey := dst.key

	// Attempt to queue for sending up to 3 times. On each attempt, if
	// the queue is full, try to drop from queue head to prioritize
	// fresher packets.
	sendQueue := dst.sendQueue
	if disco.LooksLikeDiscoWrapper(p.bs) {
		sendQueue = dst.discoSendQueue
	}
	for attempt := range 3 {
		select {
		case <-dst.ctx.Done():
			s.recordDrop(p.bs, c.key, dstKey, dropReasonGoneDisconnected)
			return nil
		default:
		}
		select {
		case sendQueue <- p:
			return nil
		default:
		}

		select {
		case pkt := <-sendQueue:
			s.recordDrop(pkt.bs, c.key, dstKey, dropReasonQueueHead)
			c.recordQueueTime(pkt.enqueuedAt)
		default:
		}
	}
	// Failed to make room for packet. This can happen in a heavily
	// contended queue with racing writers. Give up and tail-drop in
	// this case to keep reader unblocked.
	s.recordDrop(p.bs, c.key, dstKey, dropReasonQueueTail)
	return nil
}
```

[`derpserver.go#L1503-L1542`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/derp/derpserver/derpserver.go#L1503)。

**キューが満杯なら、先頭 (最も古い) を捨てて空きを作り、再試行する。それを 3 回まで。**

これは意図的な選択だ。ネットワークのキューは普通「満杯なら新しいパケットを捨てる」(tail drop) が、ここでは **head drop** を優先している。中継しているのは主にリアルタイムの通信なので、**古いパケットには価値がない**。

3 回試して駄目なら諦めて tail drop する。「他の書き手と競合して先頭を取れなかった場合」で、**リーダー側を止めないことを優先** している。

**disco 用のキューが分離されている** のも重要だ。データパケットで溢れているときでも、経路探索のメッセージは別のキューに入るので通る。**輻輳しているときこそ、経路を探し直したい。**

そして捨てたことは必ず記録される。

```go title="derp/derpserver/derpserver.go"
const (
	dropReasonQueueHead        dropReason = "queue_head"          // destination queue is full, dropped packet at queue head
	dropReasonQueueTail        dropReason = "queue_tail"          // destination queue is full, dropped packet at queue tail
```

[`derpserver.go#L1466-L1474`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/derp/derpserver/derpserver.go#L1466)。

**捨てた理由ごとにメトリクスが分かれている。** 「宛先が切断済み」「先頭を捨てた」「末尾を捨てた」。運用時に、輻輳の種類を区別できる。

### キープアライブ

```go title="derp/derp.go"
// KeepAlive is the minimum frequency at which the DERP server sends
// keep alive frames. The server adds some jitter, so this timing is not
// exact, but 2x this value can be considered a missed keep alive.
const KeepAlive = 60 * time.Second
```

[`derp.go#L40-L44`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/derp/derp.go#L40-L44)。

**サーバ側がジッタを加える。** 数万のクライアントに同時にキープアライブを送ると、送信バーストが 60 秒ごとに発生する。ずらせば平準化される。

そして **「2 倍の時間で欠落とみなす」** という判定基準を、定数のコメントとして書いている。プロトコルの両端が同じ理解を持つための記述だ。

## なぜそうなっているか

### なぜ常時接続なのか

DERP は「最後の手段」だが、**必要になってから繋いでいては遅い**。

- 直結が切れた瞬間、次のパケットの行き先が要る。TCP + TLS のハンドシェイクを待っていたら数百 ms 消える
- [CallMeMaybe](../disco-protocol/) は DERP 経由でしか送れない。**NAT 越えを始めるには、まず DERP が要る**
- 「このノードはオンラインか」を control server が知る手段にもなる

つまり DERP は「フォールバック」であると同時に **「NAT 越えを開始するための制御チャネル」** でもある。制御チャネルは常時必要だ。

### なぜ公開鍵をアドレスにするのか

中継サーバに IP アドレスで宛先を指定させると、**サーバが「どの IP がどのクライアントか」の対応表を持つ**ことになる。クライアントは移動するので、その表は常に古くなる。

公開鍵なら、**接続してきたクライアントの鍵をそのままキーにできる**。クライアントが移動して再接続しても、鍵は変わらないので何も更新しなくてよい。ルーティングテーブルが「今つながっている接続の一覧」そのものになる。

副作用として、**DERP サーバは「誰と誰が通信しているか」を知る**。中身は WireGuard で暗号化されているので読めないが、通信の相手関係は見える。中継である以上避けられない。

### なぜリージョン間を繋がないのか

繋ぐと「どの経路で送るか」というルーティングの問題が発生する。リージョンが 30 個あれば経路計算が要り、障害時の再収束も要る。**中継サーバがインターネットのルータになってしまう。**

繋がなければ、ルーティングは存在しない。「相手のホームリージョンへ、自分が直接繋いで送る」だけだ。クライアントが複数のリージョンに繋ぐコストは、サーバ間ルーティングを実装・運用するコストより安い。

**問題をサーバ側からクライアント側に移すことで、複雑さの総量を減らしている。**

### なぜ head drop なのか

リアルタイム通信では、**古いパケットは届いても価値がない**。

- WireGuard のハンドシェイクは再送される。古いハンドシェイクは無意味
- 音声・映像は、遅れて届いても再生されない
- TCP over WireGuard なら、古いセグメントは再送済み

一方 tail drop (新しいのを捨てる) だと、**キューに古いパケットが詰まったまま、新しいパケットが永久に入れない**。これが bufferbloat の構造だ。head drop なら、キューは常に新しいパケットで置き換わる。

### なぜ disco のキューを分けるのか

輻輳しているとき、一番したいのは **「この経路が悪い」と判断して別の経路を探すこと** だ。その判断に使う disco メッセージが、輻輳したデータのキューで詰まると、経路の切り替えが起きない。

**制御メッセージとデータを別のキューに入れる** のは、ネットワーク機器では標準的な設計 (control plane policing) だ。同じ考えが、アプリケーションレベルのリレーにも適用されている。

### なぜサーバが再起動を予告するのか

数万の TCP 接続を持つサーバを再起動すると、全クライアントが同時に切断を検知し、同時に再接続してくる。**バックオフを入れても、全員が同じタイミングで開始すれば同じタイミングで再試行する。**

`FrameRestarting` で「N ミリ秒後に再接続、M ミリ秒まで粘れ」と伝えれば、クライアントはその範囲でランダムに散らせる。**再接続の集中を、サーバ側から制御できる。**

## どう活かすか

**フォールバック経路は、必要になってから作るのでは遅い。** 常時維持するコストと、切り替え時の遅延を比べる。DERP のように「フォールバックが制御チャネルも兼ねる」なら、常時接続のコストは実質ゼロになる。

**中継サーバの宛先には、移動しない識別子を使う。** IP アドレスやセッション ID ではなく公開鍵にすると、対応表の更新が不要になり、「接続の集合」がそのままルーティングテーブルになる。

**「N 台構成の N」は、可用性の式ではなく容量の観点で決めることがある。** 「1 台落ちても残りが耐えられる負荷率」から逆算する。2 台構成は、各台 50% 未満でしか回せない。

**リアルタイム性が要るキューは head drop にする。** 古いデータに価値がないなら、捨てるのは古いほうだ。tail drop は「詰まったキューが詰まったまま」を招く。

**制御用のキューをデータと分ける。** 輻輳しているときこそ制御メッセージが通る必要がある。逆になっていると、輻輳から回復できない。

**捨てた理由ごとにメトリクスを分ける。** 「ドロップ数」だけでは、宛先が消えたのか、遅いのか、競合したのかが分からない。理由ごとの内訳があると、対処が変わる。

**大量のクライアントを持つサーバは、再接続のタイミングをプロトコルで指示できるようにする。** クライアント任せのバックオフでは、開始時刻が揃っているので分散しない。
