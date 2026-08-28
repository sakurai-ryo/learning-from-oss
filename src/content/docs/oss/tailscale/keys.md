---
title: "鍵が 3 種類あるのは、信用する相手が 3 通りあるから"
description: "machine key・node key・disco key は、どれも Curve25519 の 32 バイトでありながら、寿命も保存先も暗号操作も違う。machine key はデバイスに永続、node key はローテーション可能、disco key はメモリ上だけでプロセスが死ねば消える。鍵型には == を書けないようにする仕掛けまで入っている。"
group: "前提"
sidebar:
  order: 3
---

## 何を学んだか

### 4 種類の鍵

Tailscale のノードが持つ秘密鍵は、通常 4 種類ある。

| 鍵               | 型         | 用途                                     | 寿命                         | 保存先                 |
| ---------------- | ---------- | ---------------------------------------- | ---------------------------- | ---------------------- |
| machine key      | Curve25519 | control server との Noise ハンドシェイク | デバイスを消すまで           | state store (ディスク) |
| node key         | Curve25519 | WireGuard と DERP                        | 期限切れ・ローテーションあり | `Persist` (ディスク)   |
| disco key        | Curve25519 | 経路探索メッセージの暗号化               | プロセスが生きているあいだ   | メモリのみ             |
| tailnet lock key | Ed25519    | node key への署名                        | デバイスを消すまで           | `Persist` (ディスク)   |

これに加えて、TPM が使える環境では hardware attestation key が増える。

「全部 Curve25519 の 32 バイトなら 1 つでいいのでは」と思うところだが、**それぞれ信用する相手と失効のさせ方が違う**。

### 鍵ごとの役割

**machine key はデバイスの身元** だ。control server に「この物理マシンです」と名乗るために使う。ユーザーがログアウトして別のユーザーで入り直しても、machine key は変わらない。管理者が admin console で見る「デバイス」の同一性は、この鍵が担保している。

**node key は tailnet の中でのアイデンティティ** だ。WireGuard の公開鍵そのもので、`100.x.y.z` のアドレスと紐づく。有効期限があり (既定 180 日)、切れると再認証が要る。ローテーションもできる。

**disco key は経路探索専用** だ。「今この UDP アドレスに ping を送ってみる」というメッセージを暗号化する。**ディスクに保存されず、`tailscaled` を再起動すると新しくなる。**

**tailnet lock key は署名用** で、他の 3 つと違い Ed25519 だ。box (暗号化) ではなく signature (署名) が要るので曲線の使い方が違う。[tailnet lock のページ](../tailnet-lock/) で扱う。

### 鍵型に `==` を書けなくしてある

`key` パッケージのすべての秘密鍵型に `structs.Incomparable` が埋め込まれている。これは Go のコンパイラに「この型は比較できない」と教えるためのゼロ幅フィールドで、`k1 == k2` がコンパイルエラーになる。**比較したければ定数時間比較の `Equal` を使わせる** ための仕掛けだ。

## ソースコードのどこか

### machine key

```go title="types/key/machine.go"
const (
	// machinePrivateHexPrefix is the prefix used to identify a
	// hex-encoded machine private key.
	//
	// This prefix name is a little unfortunate, in that it comes from
	// WireGuard's own key types. Unfortunately we're stuck with it for
	// machine keys, because we serialize them to disk with this prefix.
	machinePrivateHexPrefix = "privkey:"

	// machinePublicHexPrefix is the prefix used to identify a
	// hex-encoded machine public key.
	//
	// This prefix is used in the control protocol, so cannot be
	// changed.
	machinePublicHexPrefix = "mkey:"
)

// MachinePrivate is a machine key, used for communication with the
// Tailscale coordination server.
type MachinePrivate struct {
	_ structs.Incomparable // == isn't constant-time
	k [32]byte
}
```

[`machine.go#L17-L39`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/types/key/machine.go#L17-L39)。

コメントが 2 つのことを教えてくれる。**ディスクに書いた形式と、プロトコルに乗せた形式は、どちらも後から変えられない。** `privkey:` という名前が WireGuard 由来で紛らわしいと分かっていても、既存のインストールが読めなくなるので変えられない。**互換性の負債が、定数のコメントとして残っている。**

### machine key の遅延生成

```go title="ipn/ipnlocal/local.go"
// For testing lazy machine key generation.
var panicOnMachineKeyGeneration = envknob.RegisterBool("TS_DEBUG_PANIC_MACHINE_KEY")
```

[`local.go#L4429-L4430`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L4429)。

**「machine key が生成されたら panic する」という環境変数がテスト用に用意されている。** これは、machine key を「必要になるまで作らない」ことを保証したいからだ。

```go title="ipn/ipnlocal/local.go"
func (b *LocalBackend) initMachineKeyLocked() (err error) {
	if !b.machinePrivKey.IsZero() {
		// Already set.
		return nil
	}

	keyText, err := b.store.ReadState(ipn.MachineKeyStateKey)
	if err == nil {
		if err := b.machinePrivKey.UnmarshalText(keyText); err != nil {
```

[`local.go#L4454-L4465`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L4454)。

state store から読み、なければ新規生成して書く。**一度作られた machine key は、ログアウトしても消えない。**

### node key

```go title="types/key/node.go"
// NodePrivate is a node key, used for WireGuard tunnels and
// communication with DERP servers.
type NodePrivate struct {
	_ structs.Incomparable // because == isn't constant-time
	k [32]byte
}

// NewNode creates and returns a new node private key.
func NewNode() NodePrivate {
	var ret NodePrivate
	rand(ret.k[:])
	// WireGuard does its own clamping, so this would be unnecessary -
	// but we also use this key for DERP comms, which does require
	// clamping.
	clamp25519Private(ret.k[:])
	return ret
}
```

[`node.go#L46-L62`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/types/key/node.go#L46)。

**同じ鍵を WireGuard と DERP の両方で使っている**ことが、clamping のコメントから読める。WireGuard は内部で clamp するので不要だが、DERP 側の NaCl box は clamp 済みの鍵を要求するので、生成時に clamp しておく。

DERP サーバは「この node key 宛のパケットを、その node key で接続しているクライアントに転送する」というルーティングをする。**DERP にとってのアドレスが node key そのもの** なので、WireGuard と同じ鍵になっている。

### node key のローテーション

```go title="control/controlclient/direct.go"
if opt.Logout {
	tryingNewKey = persist.PrivateNodeKey
} else {
	...
	persist.OldPrivateNodeKey = persist.PrivateNodeKey
```

[`direct.go#L735-L745`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L735)。

新しい node key で登録するとき、古い鍵を `OldPrivateNodeKey` に退避する。登録リクエストには両方が入る。

```go title="control/controlclient/direct.go"
if !oldNodeKey.IsZero() && opt.OldNodeKeySignature != nil {
	if nodeKeySignature, err = tka.ResignNKS(persist.NetworkLockKey, tryingNewKey.Public(), opt.OldNodeKeySignature); err != nil {
```

[`direct.go#L765-L767`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L765)。

**tailnet lock が有効なら、新しい node key に対する署名を自分で作り直す。** 古い署名を持っていることが、新しい鍵を署名する権利の根拠になる。鍵をローテーションしても、tailnet lock の信頼チェーンが切れない。

### disco key

```go title="types/key/disco.go"
// DiscoPrivate is a disco key, used for peer-to-peer path discovery.
type DiscoPrivate struct {
	_ structs.Incomparable // because == isn't constant-time
	k [32]byte
}

// NewDisco creates and returns a new disco private key.
func NewDisco() DiscoPrivate {
	var ret DiscoPrivate
	rand(ret.k[:])
	// Key used for nacl seal/open, so needs to be clamped.
	clamp25519Private(ret.k[:])
	return ret
}
```

[`disco.go#L30-L43`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/types/key/disco.go#L30)。

そして生成箇所は 1 つしかない。

```go title="wgengine/magicsock/magicsock.go"
func newConn(logf logger.Logf) *Conn {
	discoPrivate := key.NewDisco()
	c := &Conn{
		...
	}
	c.discoAtomic.Set(discoPrivate)
```

[`magicsock.go#L582-L595`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L582)。

**`magicsock.Conn` を作るときに生成し、どこにも保存しない。** ディスクへの書き出しコードが存在しないので、プロセスを再起動すれば必ず新しい鍵になる。公開鍵のほうは `MapRequest.DiscoKey` として control に送られ、ピアに配られる。

ローテーション用の API もあるが、コメントが正直だ。

```go title="wgengine/magicsock/magicsock.go"
// RotateDiscoKey generates a new discovery key pair and updates the connection
// to use it. This invalidates all existing disco sessions and will cause peers
// to re-establish discovery sessions with the new key.
//
// This is primarily for debugging and testing purposes, a future enhancement
// should provide a mechanism for seamless rotation by supporting short term use
// of the old key.
func (c *Conn) RotateDiscoKey() {
```

[`magicsock.go#L1255-L1262`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/magicsock.go#L1255)。

**「切り替えると全部のセッションが無効になる。今はデバッグ用」** と書いてある。新旧の鍵を一定期間併用する仕組みは、まだない。

### ディスクに残るもの

```go title="types/persist/persist.go"
type Persist struct {
	_ structs.Incomparable

	PrivateNodeKey    key.NodePrivate
	OldPrivateNodeKey key.NodePrivate // needed to request key rotation
	UserProfile       tailcfg.UserProfile

	// NetworkLockKey is the node's Tailnet Lock private key.
	NetworkLockKey key.NLPrivate

	NodeID         tailcfg.StableNodeID
	AttestationKey key.HardwareAttestationKey `json:",omitzero"`
```

[`persist.go#L21-L34`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/types/persist/persist.go#L21-L34)。

**`Persist` に disco key は入っていない。** machine key もここではなく別のキーで state store に入る。「何が永続化されるか」がこの構造体で一目で分かる。

## なぜそうなっているか

### なぜ machine key と node key を分けるのか

**失効のさせ方が違うからだ。**

node key には期限がある。切れたらそのノードは tailnet から締め出される。ユーザーが再認証すると新しい node key が発行される。つまり **node key は「このマシンは今 tailnet に参加してよい」という許可の表現** だ。

machine key に期限はない。**control server と喋る権利そのもの** なので、これが切れると「期限切れなので再認証したい」と伝えることすらできなくなる。認証の入り口は常に開いていなければならない。

もう 1 つ、**管理者から見た「デバイスの同一性」** の問題がある。node key = デバイス ID にしてしまうと、期限切れで再認証するたびに別のデバイスとして現れる。machine key を不変にしておくと、control server は「同じマシンが鍵を更新した」と認識できる。

### なぜ disco key は永続化しないのか

3 つの理由が考えられる。

**1. 永続化する必要がない。** disco key の役割は「今この瞬間の経路探索メッセージを、なりすまされないようにする」ことだけだ。長期的なアイデンティティを担う必要がない。公開鍵は netmap 経由でピアに配られるので、再起動して変わっても control 経由で伝わる。

**2. 追跡可能性を下げられる。** disco メッセージは **暗号化されているとはいえ、送信者の公開鍵が平文でヘッダに載る**。これが不変だと、ネットワークを観測している第三者に「同じマシンが場所を移動した」ことが分かってしまう。プロセス起動ごとに変わるだけでも、相関の手がかりは減る。

**3. 保存しなければ漏れない。** ディスクに秘密鍵を置かないで済むなら、置かないほうがよい。

代償として、**`tailscaled` を再起動すると、全ピアとの disco セッションが張り直しになる**。ただし disco セッションの確立は数往復の UDP なので、コストは小さい。

### なぜ `structs.Incomparable` を埋めるのか

秘密鍵を `==` で比較すると、**Go の構造体比較はバイト列を先頭から比較して、違いが見つかった時点で打ち切る**。つまり比較にかかる時間が「先頭何バイトが一致したか」を漏らす。タイミング攻撃の教科書的な例だ。

これを「`Equal` を使いましょう」というコーディング規約にすると、レビューで見落とせば通ってしまう。**型に `Incomparable` を埋めておくと、`==` を書いた瞬間にコンパイルが通らなくなる。** 規約ではなく型で守っている。

`Incomparable` の実体は `[0]func()` のような、比較不可能でサイズ 0 の型だ。実行時のコストはゼロで、コンパイル時の制約だけが増える。

### なぜ node key で DERP も喋るのか

DERP は「node key 宛にパケットを送る」というリレーだ。ここで別の鍵を使うと、**「その DERP の鍵は本当にその node のものか」を別途検証する必要が出る**。node key をそのまま使えば、DERP サーバは「この公開鍵で接続してきたクライアント」に転送するだけでよく、鍵の対応表が要らない。

そのぶん **DERP サーバは、どの node key とどの node key が通信しているかを知る**。中身は読めないが、通信の相手関係は見える。これは中継サーバである以上避けられない。

## どう活かすか

**「同じ暗号アルゴリズムでも、失効のさせ方が違うなら鍵を分ける」は、認証設計の指針として使える。** 「デバイスの身元」「今の参加許可」「セッション」で寿命が違うなら、鍵も分ける。1 つの鍵で兼ねると、片方を失効させたいときにもう片方も巻き添えになり、「期限切れを伝えるために期限切れの鍵が要る」といった循環が生まれる。

**「長期の身元」と「短期の許可」を分ける形は、鍵に限らず使える。** リフレッシュトークンとアクセストークン、デバイス証明書とセッション証明書。Tailscale の machine key / node key は、この一般形の一例と見るとよい。

**永続化しなくてよい鍵は永続化しない、という判断は明示的にやる価値がある。** 「念のため保存しておく」を避けるだけで、鍵管理の対象が 1 つ減る。判断基準は「再起動時に作り直しても、システムが自力で回復できるか」だ。Tailscale の disco key は netmap 経由で新しい公開鍵が配られるので回復できる。

**タイミング攻撃の防止を、規約ではなく型で強制するのは真似しやすい。** Go なら比較不可能なゼロ幅フィールドを埋めるだけでよい。同じ発想は「この構造体をコピーさせたくない」(`sync.Locker` の埋め込みや `go vet` の copylocks) にも通じる。**危険な操作をコンパイルエラーにできるなら、そうしておく。**

**互換性の都合で変えられない定数には、その理由をコメントに書いておく。** `machinePrivateHexPrefix` の「名前が不適切だと分かっているが変えられない」というコメントは、後から読む人が「直しておこう」と思うのを防ぐ。**リファクタリングを止めるためのコメント**は、書く価値がある数少ないコメントの 1 つだ。
