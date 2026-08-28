---
title: "HTTP の上に Noise のトランスポートを自分で張る"
description: "control server との通信は TLS ではなく Noise IK だ。しかも平文 HTTP の 101 Switching Protocols で張り、TLS はうるさいプロキシ向けのフォールバックとして二重暗号化で使う。ハンドシェイクの最初のメッセージを HTTP リクエストに埋め込んで往復を 1 回削り、サーバは HTTP/2 が始まる前に「早期ペイロード」を押し込む。"
group: "制御プレーン"
sidebar:
  order: 5
---

## 何を学んだか

### TLS を使わない

クライアントと control server の通信は、**TLS ではなく Noise IK** で暗号化されている。使う道具は Curve25519・ChaCha20-Poly1305・BLAKE2s で、認証には [machine key](../keys/) を使う。

TLS を使わない理由は、TLS が解いている問題と、ここで解きたい問題が違うからだ。TLS は「相手のドメイン名が正しいことを、CA という第三者に保証してもらう」仕組みである。一方 Tailscale のクライアントは、**control server の公開鍵を最初から知っている**。CA を経由する必要がない。

### 平文 HTTP の上に張る

さらに変わっているのは、**この Noise 接続を平文の HTTP の上に張る** ことだ。

1. クライアントが `http://controlplane.tailscale.com/ts2021` に平文 HTTP でアクセスする
2. サーバが `101 Switching Protocols` を返す
3. 以降、その TCP 接続の上で Noise が始まる

HTTPS は **フォールバック** だ。平文 HTTP が通らない環境 (プロキシが 101 を通さない、ポート 80 を塞いでいる) のために、HTTPS でも同じことをする。この場合 **Noise と TLS で二重に暗号化される**。パッケージのコメントが「double encryption」と正直に書いている。

### 往復を削るための工夫が 2 つ

**1. ハンドシェイクの分割。** Noise のハンドシェイク初期メッセージは、HTTP のアップグレードリクエストの中に埋め込んで送る。プロトコル切り替えが終わってから Noise を始めると 1 RTT 余計にかかるので、切り替えのリクエストに相乗りさせる。

**2. 早期ペイロード。** サーバは HTTP/2 のハンドシェイクが始まる前に、Noise の上に JSON を 1 個押し込める。これで「接続確立と同時にサーバから情報を受け取る」ができ、やはり 1 往復減る。

### 接続先も並行して試す

control server への接続は、**複数の候補に対して時間差で並行にダイヤルする**。HTTP と HTTPS も、500 ms のずれを置いて両方走らせる。

## ソースコードのどこか

### Noise の instantiation

```go title="control/controlbase/conn.go"
// Package controlbase implements the base transport of the Tailscale
// 2021 control protocol.
//
// The base transport implements Noise IK, instantiated with
// Curve25519, ChaCha20Poly1305 and BLAKE2s.
package controlbase
```

[`conn.go#L4-L9`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlbase/conn.go#L4-L9)。

```go title="control/controlbase/handshake.go"
const (
	// protocolName is the name of the specific instantiation of Noise
	// that the control protocol uses. This string's value is fixed by
	// the Noise spec, and shouldn't be changed unless we're updating
	// the control protocol to use a different Noise instance.
	protocolName = "Noise_IK_25519_ChaChaPoly_BLAKE2s"
	...
	// protocolVersionPrefix is the name portion of the protocol
	// name+version string that gets mixed into the handshake as a
	// prologue.
	//
	// This mixing verifies that both clients agree that they're
	// executing the control protocol at a specific version that
	// matches the advertised version in the cleartext packet header.
	protocolVersionPrefix = "Tailscale Control Protocol v"
```

[`handshake.go#L26-L41`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlbase/handshake.go#L26-L41)。

**IK** は Noise のハンドシェイクパターンの 1 つで、「I = イニシエータの静的鍵を送る」「K = レスポンダの静的鍵は既知」を意味する。まさに Tailscale の状況で、クライアントは control の公開鍵を知っていて、自分の machine key を名乗る。WireGuard が使う `Noise_IK` と同じパターンだ。

**バージョン番号をプロローグとして混ぜる** のがポイントだ。プロトコルバージョンは平文ヘッダにも書かれるが、それだけだと中間者が書き換えられる。ハンドシェイクのハッシュに混ぜておくと、**書き換えられた瞬間にハンドシェイクが失敗する**。ダウングレード攻撃への対処だ。

### 往復を削るための分割

```go title="control/controlbase/handshake.go"
// ClientDeferred initiates a control client handshake, returning the
// initial message to send to the server and a continuation to
// finalize the handshake.
//
// ClientDeferred is split in this way for RTT reduction: we run this
// protocol after negotiating a protocol switch from HTTP/HTTPS. If we
// completely serialized the negotiation followed by the handshake,
// we'd pay an extra RTT to transmit the handshake initiation after
// protocol switching. By splitting the handshake into an initial
// message and a continuation, we can embed the handshake initiation
// into the HTTP protocol switching request and avoid a bit of delay.
func ClientDeferred(machineKey key.MachinePrivate, controlKey key.MachinePublic, protocolVersion uint16) (initialHandshake []byte, continueHandshake HandshakeContinuation, err error) {
```

[`handshake.go#L56-L68`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlbase/handshake.go#L56-L68)。

**ハンドシェイクを「最初のメッセージ」と「続き」に分けて返す。** 呼び出し側は最初のメッセージを HTTP リクエストヘッダに base64 で入れて送り、`101` が返ってきたら継続関数を呼ぶ。

暗号ライブラリの API を「バイト列 + 継続関数」に割る設計は珍しいが、**トランスポートの都合 (HTTP アップグレードに相乗りしたい) を暗号層に持ち込まずに済ませる** ための形になっている。

### フレーミング

```go title="control/controlbase/conn.go"
const (
	// maxMessageSize is the maximum size of a protocol frame on the
	// wire, including header and payload.
	maxMessageSize = 4096
	// maxCiphertextSize is the maximum amount of ciphertext bytes
	// that one protocol frame can carry, after framing.
	maxCiphertextSize = maxMessageSize - 3
	// maxPlaintextSize is the maximum amount of plaintext bytes that
	// one protocol frame can carry, after encryption and framing.
	maxPlaintextSize = maxCiphertextSize - chp.Overhead
)
```

[`conn.go#L25-L34`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlbase/conn.go#L25-L34)。

**1 フレーム 4096 バイト固定。** ヘッダ 3 バイト (タイプ 1 + 長さ 2) と AEAD のタグ 16 バイトを引いた分がペイロードになる。長いデータは複数フレームに割られる。

### 書き込みエラーは全部致命的

```go title="control/controlbase/conn.go"
// A Conn is a secured Noise connection. It implements the net.Conn
// interface, with the unusual trait that any write error (including a
// SetWriteDeadline induced i/o timeout) causes all future writes to
// fail.
type Conn struct {
```

```go title="control/controlbase/conn.go"
	defer func() {
		if err != nil {
			// All write errors are fatal for this conn, so clear the
			// cipher state whenever an error happens.
			c.tx.cipher = nil
		}
```

[`conn.go#L36-L47`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlbase/conn.go#L36-L47) と [`conn.go#L277-L282`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlbase/conn.go#L277-L282)。

**「`net.Conn` としては異常な性質」と自分で書いている。** 普通の `net.Conn` は、書き込みタイムアウトの後も書き込みを続けられる。ここではエラーが起きた時点で暗号状態を破棄し、以降のすべての書き込みが失敗する。

理由は AEAD の nonce にある。Noise はフレームごとに nonce をインクリメントする。**部分書き込みで失敗すると、送信側と受信側の nonce がずれる**。ずれた状態から復帰する方法はないので、接続ごと諦めるのが正しい。「途中まで書けた」を許すと、暗号の前提が壊れる。

### HTTP の上に載せる

```go title="control/controlhttp/client.go"
// Package controlhttp implements the Tailscale 2021 control protocol
// base transport over HTTP.
//
// This tunnels the protocol in control/controlbase over HTTP with a
// variety of compatibility fallbacks for handling picky or deep
// inspecting proxies.
//
// In the happy path, a client makes a single cleartext HTTP request
// to the server, the server responds with 101 Switching Protocols,
// and the control base protocol takes place over plain TCP.
//
// In the compatibility path, the client does the above over HTTPS,
// resulting in double encryption (once for the control transport, and
// once for the outer TLS layer).
package controlhttp
```

[`client.go#L6-L20`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlhttp/client.go#L6-L20)。

**「picky or deep inspecting proxies」** — うるさいプロキシ、中身を覗くプロキシへの対処だと明記されている。パスは `/ts2021` 固定だ。

### HTTP と HTTPS を 500 ms ずらして並行に

```go title="control/controlhttp/client.go"
// httpsFallbackDelay is how long we'll wait for a.HTTPPort to work before
// starting to try a.HTTPSPort.
func (a *Dialer) httpsFallbackDelay() time.Duration {
	if v := a.testFallbackDelay; v != 0 {
		return v
	}
	return 500 * time.Millisecond
}
```

[`client.go#L87-L94`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlhttp/client.go#L87-L94)。

```go title="control/controlhttp/client.go"
		case res := <-ch:
			if res.err == nil {
				return res.conn, nil
			}
			switch res.u {
			case u80:
				// Connecting over plain HTTP failed; assume it's an HTTP proxy
				// being difficult and see if we can get through over HTTPS.
				err80 = res.err
				// Stop the fallback timer and run it immediately. We don't use
				// Timer.Reset(0) here because on AfterFuncs, that can run it
				// again.
				if try443Timer != nil && try443Timer.Stop() {
					go try(u443)
				} // else we lost the race and it started already which is what we want
```

[`client.go#L311-L336`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlhttp/client.go#L311)。

**Happy Eyeballs と同じ形だ。** ポート 80 を先に試し、500 ms 待って結果が出なければ 443 も並行して始める。80 が明示的に失敗したらタイマーを止めて即座に 443 を開始する。

`Timer.Reset(0)` を使わない理由がコメントで説明されているのが実装の細かさを示している。`AfterFunc` に `Reset` を使うと二重実行の危険があるので、`Stop()` の戻り値でレースの勝敗を判定している。

### 接続先候補も並行に

```go title="control/controlhttp/client.go"
	for _, cand := range candidates {
		timer := time.AfterFunc(time.Duration(cand.DialStartDelaySec*float64(time.Second)), func() {
			go func() {
				conn, err := dialCand(cand)
```

[`client.go#L134-L137`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlhttp/client.go#L134)。

**接続先の候補リスト (`ControlDialPlan`) は、control server 自身が前回の応答で配ってくる。** 各候補には「何秒待ってから試すか」と「タイムアウト何秒か」が入っている。つまり **サーバが、クライアントの接続戦略を遠隔で制御できる**。特定のリージョンへの誘導や、障害時の迂回をサーバ側から指示できる。

### 早期ペイロード

```go title="control/ts2021/conn.go"
// Package ts2021 handles the details of the Tailscale 2021 control protocol
// that are after (above) the Noise layer. In particular, the
// "tailcfg.EarlyNoise" message and the subsequent HTTP/2 connection.
package ts2021
```

```go title="tailcfg/tailcfg.go"
// EarlyNoise is the early payload that's sent over Noise but before the HTTP/2
// handshake when connecting to the coordination server.
//
// This exists to let the server push some early info to client for that
// stateful HTTP/2+Noise connection without incurring an extra round trip. (This
// would've used HTTP/2 server push, had Go's client-side APIs been available)
type EarlyNoise struct {
	// NodeKeyChallenge is a random per-connection public key to be used by
	// the client to prove possession of a wireguard private key.
	NodeKeyChallenge key.ChallengePublic `json:"nodeKeyChallenge"`
}
```

[`tailcfg.go#L3059-L3069`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tailcfg/tailcfg.go#L3059)。

**「Go のクライアント側 API があれば HTTP/2 server push を使っていた」** と書いてある。使えないので、Noise の上・HTTP/2 の前という隙間に自前のメッセージを差し込んだ。

中身は `NodeKeyChallenge` で、**接続ごとにランダムな公開鍵**だ。クライアントはこれを使って「自分が node key の秘密鍵を持っている」ことを証明する。接続ごとに違う値なので、証明をリプレイできない。

## なぜそうなっているか

### なぜ TLS ではなく Noise なのか

**1. CA を信用しなくてよい。** クライアントは control server の公開鍵をバイナリに焼き込んでいる。CA を経由すると、世の中の CA のどれか 1 つが侵害されただけで中間者攻撃が成立する。公開鍵を直接持っていれば、その心配がない。

**2. 相互認証が自然にできる。** TLS のクライアント証明書は運用が重い。Noise IK は「クライアントが自分の静的鍵を送り、サーバの静的鍵で暗号化する」ハンドシェイクなので、**認証と鍵交換が同じ 1 往復で終わる**。

**3. 実装が小さい。** Noise IK の実装は `handshake.go` の 400 行程度だ。TLS スタックに比べれば桁違いに小さく、監査もしやすい。

**4. すでに WireGuard で使っている。** Tailscale のデータプレーンは Noise ベースの WireGuard だ。制御プレーンでも同じ道具を使えば、暗号の前提が 1 つで済む。

### なぜ平文 HTTP を優先し、HTTPS がフォールバックなのか

普通は逆に思える。だが **中身が Noise で暗号化されている以上、外側の TLS は暗号としては無意味** だ。二重に暗号化しても安全性は上がらず、CPU と往復回数が増えるだけになる。

それでも HTTPS を用意するのは、**通信の中身ではなくパケットの見た目の問題**だからだ。ポート 80 で `101 Switching Protocols` を返した後にランダムなバイト列が流れるのは、DPI をするプロキシから見て怪しい。ポート 443 の TLS に見せかければ、そういう環境でも通る。

つまり **HTTPS フォールバックはセキュリティ機能ではなく、互換性機能** だ。この位置づけがコメントの「double encryption」という書き方に表れている。

### なぜサーバがダイヤル計画を配るのか

クライアントは control server に繋がらなければ何もできない。だが「繋がらない理由」は環境ごとに違う — DNS が壊れている、特定の IP がブロックされている、経路が遠い。

**接続戦略をクライアントのコードに焼き込むと、変更にクライアントのアップデートが要る。** 数百万台のクライアントを一斉に更新することはできない。ダイヤル計画をサーバから配れば、**次に繋がったときの接続方法をサーバ側で調整できる**。

もちろん「一度も繋がらなくなったら計画も配れない」という鶏と卵の問題が残る。だからブートストラップ用の DNS フォールバックや、バイナリに焼き込んだ IP リスト ([DNS ブートストラップのページ](../dns-bootstrap/)) が別に用意されている。

### なぜ書き込みエラーを致命的にするのか

AEAD の nonce は「同じ鍵で同じ nonce を二度使ってはいけない」という絶対的な制約を持つ。破ると暗号が崩壊する。

`net.Conn` の意味論では、`Write` がタイムアウトした後も書き込みを続けられる。だが Noise の上では **「途中まで書けた」状態から安全に再開する方法がない**。何バイト相手に届いたか分からないからだ。

ここで「頑張って復帰する」を選ぶと、複雑なうえに間違えると暗号が壊れる。**「壊れるくらいなら止まる」** を選び、しかもそれを型のドキュメントに「unusual trait」として明記している。

## どう活かすか

**「相手の公開鍵を事前に知っているなら、TLS より単純な選択肢がある」は覚えておく価値がある。** 自社サービス間の通信、エージェントとサーバ、IoT デバイスとクラウド。CA の PKI が解いているのは「知らない相手のドメイン名を検証する」問題で、公開鍵をピン留めできる状況ではオーバースペックになる。Noise フレームワークは、必要なハンドシェイクパターンを選んで組み立てられる。

**ハンドシェイクを「初期メッセージ + 継続」に分割する API 設計は、往復を削りたいときの一般的な形だ。** 下位のトランスポート (HTTP アップグレード、QUIC の 0-RTT、独自プロトコル) の都合に暗号層を汚染させずに、初期メッセージだけを別経路で運べる。

**フォールバックの優先順位を「安全性」ではなく「環境の癖」で決める場面がある。** Tailscale の HTTPS フォールバックは暗号を強くしないが、通らない環境で通す。フォールバックを設計するときは「何のためのフォールバックか」をコメントに書いておくと、後から「TLS のほうが安全だから優先すべきでは」という誤った最適化を防げる。

**接続戦略をサーバから配る発想は、更新できないクライアントを抱えるシステムで効く。** ただし「繋がらないと計画を受け取れない」ので、必ず独立したブートストラップ経路を用意する必要がある。

**「復帰できない状態は、復帰しようとせずに落とす」。** 暗号の nonce のように、ずれたら安全性が崩れる状態を持つ場合、部分的な失敗からの復帰は複雑さに見合わない。そして **その判断は型のドキュメントに書く**。`net.Conn` のような広く知られたインターフェースを実装しつつ意味論を変えるなら、明記しないと必ず誤用される。
