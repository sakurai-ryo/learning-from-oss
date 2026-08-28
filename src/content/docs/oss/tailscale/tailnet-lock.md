---
title: "署名チェーンを持たせて、control server を信用しないで済ませる"
description: "control server が netmap に偽のノードを混ぜたら、tailnet に侵入できてしまう。tailnet lock はこの穴を、ノード側が持つ独立した署名チェーンで塞ぐ。ハッシュチェーンで繋がった更新メッセージ、CBOR の決定的シリアライズ、そして分岐したときの解決規則が 3 行で書かれている。"
group: "制御プレーン"
sidebar:
  order: 9
---

## 何を学んだか

### control server は信用しすぎている

[アーキテクチャのページ](../architecture/) で見たとおり、Tailscale の control server はパケットを復号できない。だが **「誰が tailnet の一員か」を決める絶対的な権限** は持っている。

control server が侵害されたとき、攻撃者は netmap に自分のノードを追加できる。各クライアントはその netmap を信じて WireGuard のピアとして登録するので、**攻撃者のノードが正規のメンバーとして tailnet に入れてしまう**。

tailnet lock (コード上は TKA = Tailnet Key Authority) は、この穴を塞ぐ機能だ。

### 仕組み

有効にすると、**各ノードの node key に「署名鍵による署名」が必要になる**。署名鍵は管理者のマシンにあり、control server は持たない。クライアントは netmap を受け取ったあと、**署名のないピア・署名の検証に失敗したピアを自分で捨てる**。

では「どの鍵が署名鍵として有効か」は誰が決めるのか。ここが本体で、**ノードたちが共有する、ハッシュチェーンで繋がった更新メッセージの列** がそれを決める。

### AUM: 更新メッセージのチェーン

更新メッセージを AUM (Authority Update Message) と呼ぶ。種類は 5 つしかない。

| 種類         | 意味                           |
| ------------ | ------------------------------ |
| `AddKey`     | 署名鍵を追加する               |
| `RemoveKey`  | 署名鍵を削除する               |
| `UpdateKey`  | 鍵のメタデータや投票数を変える |
| `Checkpoint` | その時点の状態まるごと         |
| `NoOp`       | テスト用                       |

各 AUM は **前の AUM のハッシュ** を持ち、**現在有効な鍵による署名** を持つ。ブロックチェーンと同じ構造だが、合意形成は proof of work ではなく **決定的な規則** で行う。

### 分岐したら、3 つの規則で決める

ネットワークが分断されているあいだに、別々のノードが別々の AUM を作ることがある。チェーンが分岐する。

解決の規則は 3 つだけだ。

1. **署名の重みが大きいほう** (鍵ごとに投票数があり、その合計)
2. **同じなら、`RemoveKey` のほう**
3. **それも同じなら、ハッシュが小さいほう**

すべてのノードがこの規則を適用すれば、**同じチェーンに収束する**。

### シリアライズは CBOR

AUM のシリアライズには JSON ではなく CBOR (CTAP2 モード) を使う。理由がコードにはっきり書かれている。

## ソースコードのどこか

### AUM の定義と、拡張のルール

```go title="tka/aum.go"
// AUM describes an Authority Update Message.
//
// The rules for adding new types of AUMs (MessageKind):
//   - CBOR key IDs must never be changed.
//   - New AUM types must not change semantics that are manipulated by other
//     AUM types.
//   - The serialization of existing data cannot change (in other words, if
//     an existing serialization test in aum_test.go fails, you need to try a
//     different approach).
//
// The rules for adding new fields are as follows:
//   - Must all be optional.
//   - An unset value must not result in serialization overhead. This is
//     necessary so the serialization of older AUMs stays the same.
//   - New processing semantics of the new fields must be compatible with the
//     behavior of old clients (which will ignore the field).
//   - No floats!
type AUM struct {
	MessageKind AUMKind     `cbor:"1,keyasint"`
	PrevAUMHash PrevAUMHash `cbor:"2,keyasint"`
	Key *Key `cbor:"3,keyasint,omitempty"`
	KeyID tkatype.KeyID `cbor:"4,keyasint,omitempty"`
	State *State `cbor:"5,keyasint,omitempty"`
	Votes *uint             `cbor:"6,keyasint,omitempty"`
	Meta  map[string]string `cbor:"7,keyasint,omitempty"`

	// Signatures lists the signatures over this AUM.
	// CBOR key 23 is the last key which can be encoded as a single byte.
	Signatures []tkatype.Signature `cbor:"23,keyasint,omitempty"`
}
```

[`aum.go#L115-L155`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tka/aum.go#L115-L155)。

拡張ルールが 7 つ並んでいる。とくに 2 つが目を引く。

**「既存データのシリアライズは変えられない。既存のシリアライズテストが落ちたら、別のやり方を考えろ」。** 署名はシリアライズされたバイト列に対して行われるので、**シリアライズが変わると過去の署名が全部無効になる**。テストが落ちたときに「テストを直す」ではなく「実装を変えろ」と書いてあるのが重要だ。

**「float は使うな!」。** 浮動小数点数は表現が処理系依存になりうるし、CBOR には複数の符号化 (半精度・単精度・倍精度) がある。同じ値が違うバイト列になれば、決定性が壊れる。

**CBOR キー 23 の理由も書かれている。** CBOR では 0〜23 が 1 バイトで符号化できる。署名は全 AUM に必ず入るので、1 バイトで済む最後の番号を割り当てている。

### なぜ CBOR なのか

```go title="tka/aum.go"
func (a *AUM) Serialize() tkatype.MarshaledAUM {
	// Why CBOR and not something like JSON?
	//
	// The main function of an AUM is to carry signed data. Signatures are
	// over digests, so the serialized representation must be deterministic.
	// Further, experience with other attempts (JWS/JWT,SAML,X509 etc) has
	// taught us that even subtle behaviors such as how you handle invalid
	// or unrecognized fields + any invariants in subsequent re-serialization
	// can easily lead to security-relevant logic bugs. It's certainly possible
	// to invent a workable scheme by massaging a JSON parsing library, though
	// profoundly unwise.
	//
	// CBOR is one of the few encoding schemes that are appropriate for use
	// with signatures and has security-conscious parsing + serialization
	// rules baked into the spec. We use the CTAP2 mode, which is well
	// understood + widely-implemented, and already proven for use in signing
	// assertions through its use by FIDO2 devices.
```

[`aum.go#L232-L250`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tka/aum.go#L232-L250)。

**JWS/JWT・SAML・X509 の失敗から学んだ、と名指しで書いてある。** これらはいずれも「署名対象のシリアライズが一意に定まらない」ことに起因する脆弱性を繰り返してきた。JSON の正規化 (キーの順序、空白、数値表現、Unicode エスケープ) を頑張るのは **"profoundly unwise" (きわめて愚か)** だと。

CTAP2 は FIDO2 のセキュリティキーが使っているモードで、**決定的な符号化が仕様として定義されている**。「すでに広く実装され、署名の用途で実績がある」ことを選定理由に挙げている。

デコーダ側も厳しく縛られている。

```go title="tka/tka.go"
// Strict settings for the CBOR decoder.
var cborDecOpts = cbor.DecOptions{
	DupMapKey:   cbor.DupMapKeyEnforcedAPF,
	IndefLength: cbor.IndefLengthForbidden,
	TagsMd:      cbor.TagsForbidden,

	// Arbitrarily-chosen maximums.
	MaxNestedLevels:  16, // Most likely to be hit for SigRotation sigs.
	MaxArrayElements: 4096,
	MaxMapPairs:      1024,
}
```

[`tka.go#L22-L31`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tka/tka.go#L22-L31)。

キーの重複を禁止 (同じキーが 2 回出てくる CBOR は、パーサによって前を取るか後を取るかが分かれる)、不定長を禁止、タグを禁止、そしてネスト・要素数・マップ要素数に上限。**攻撃者が送り込める入力に対する上限を、パーサの設定として全部明示している。**

### 署名のハッシュは署名を除く

```go title="tka/aum.go"
// Hash returns a cryptographic digest of all AUM contents.
func (a *AUM) Hash() AUMHash {
	return blake2s.Sum256(a.Serialize())
}

// SigHash returns the cryptographic digest which a signature
// is over.
//
// This is identical to Hash() except the Signatures are not
// serialized. Without this, the hash used for signatures
// would be circularly dependent on the signatures.
func (a AUM) SigHash() tkatype.AUMSigHash {
	dupe := a
	dupe.Signatures = nil
	return blake2s.Sum256(dupe.Serialize())
}
```

[`aum.go#L273-L289`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tka/aum.go#L273-L289)。

**ハッシュが 2 種類ある。** チェーンを繋ぐための `Hash()` は署名を含み、署名を検証するための `SigHash()` は署名を除く。含めてしまうと「署名を作るのに署名が要る」という循環になる。

同時に、これは **複数の署名を後から足せる** ことを意味する。署名を足しても `SigHash()` は変わらないので、既存の署名が無効にならない。フォーク解決で「署名の重み」を数えられるのはこのためだ。

### フォーク解決の規則

```go title="tka/tka.go"
	// Oooof, we have some forks in the chain. We need to pick which
	// one to use by applying the Fork Resolution Algorithm ✨
	//
	// The rules are this:
	// 1. The child with the highest signature weight is chosen.
	// 2. If equal, the child which is a RemoveKey AUM is chosen.
	// 3. If equal, the child with the lowest AUM hash is chosen.
	sort.Slice(candidates, func(j, i int) bool {
		// Rule 1.
		iSigWeight, jSigWeight := candidates[i].Weight(state), candidates[j].Weight(state)
		if iSigWeight != jSigWeight {
			return iSigWeight < jSigWeight
		}

		// Rule 2.
		if iKind, jKind := candidates[i].MessageKind, candidates[j].MessageKind; iKind != jKind &&
			(iKind == AUMRemoveKey || jKind == AUMRemoveKey) {
			return jKind == AUMRemoveKey
		}

		// Rule 3.
		iHash, jHash := candidates[i].Hash(), candidates[j].Hash()
		return bytes.Compare(iHash[:], jHash[:]) > 0
	})
```

[`tka.go#L141-L166`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tka/tka.go#L141)。

**分散合意アルゴリズムの全体が、比較関数 1 個に収まっている。**

`sort.Slice` の引数が `func(j, i int)` と **意図的に逆順** になっているのに注意。降順ソートを、比較関数の中身を書き換えずに実現している。

### 署名の重み

```go title="tka/aum.go"
// Weight computes the 'signature weight' of the AUM
// based on keys in the state machine. The caller must
// ensure that all signatures are valid.
//
// More formally: W = Sum(key.votes)
//
// AUMs with a higher weight than their siblings
// are preferred when resolving forks in the AUM chain.
func (a *AUM) Weight(state State) uint {
	var weight uint

	// Track the keys that have already been used, so two
	// signatures with the same key do not result in 2x
	// the weight.
	...
		key, err := state.GetKey(sig.KeyID)
		if err != nil {
			if err == ErrNoSuchKey {
				// Signatures with an unknown key do not contribute
				// to the weight.
				continue
			}
```

[`aum.go#L316-L358`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tka/aum.go#L316)。

**同じ鍵で 2 回署名しても重みは 2 倍にならない。** 当たり前に見えるが、書かなければ「1 つの鍵で N 個の署名を付けて重みを稼ぐ」攻撃が成立する。

**知らない鍵の署名は重みに寄与しない** (エラーにもしない)。将来追加された鍵で署名された AUM を、古いクライアントも「重み 0 の署名が付いている」として扱える。

### netmap のフィルタ

```go title="ipn/ipnlocal/tailnet-lock.go"
	for i, p := range nm.Peers {
		if p.UnsignedPeerAPIOnly() {
			// Not subject to tailnet lock.
			continue
		}
		if p.KeySignature().Len() == 0 {
			b.logf("Tailnet lock is dropping peer %v(%v) due to missing signature", p.ID(), p.StableID())
			mak.Set(&toDelete, i, true)
		} else {
			details, err := b.tka.authority.NodeKeyAuthorizedWithDetails(p.Key(), p.KeySignature().AsSlice())
			if err != nil {
				b.logf("Tailnet lock is dropping peer %v(%v) due to failed signature check: %v", p.ID(), p.StableID(), err)
				mak.Set(&toDelete, i, true)
```

[`tailnet-lock.go#L192-L206`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/tailnet-lock.go#L192)。

**除外したピアは捨てるだけでなく、`b.tka.filtered` に記録される。** `tailscale status` に「tailnet lock で除外された」と出せるようにするためだ。黙って消えると、管理者が「なぜこのノードが見えないのか」を追えなくなる。

### 鍵のローテーションを署名で表現する

```go title="tka/sig.go"
	// SigRotation describes a signature over a specific node key, signed
	// by the rotation key authorized by a nested NodeKeySignature structure.
	//
	// While it is possible to nest rotations multiple times up to the CBOR
	// nesting limit, it is intended that nodes simply regenerate their outer
	// SigRotation signature and sign it again with their rotation key. That
	// way, SigRotation nesting should only be 2 deep in the common case.
	SigRotation
	// SigCredential describes a signature over a specific public key, signed
	// by a key in the tailnet key authority referenced by the specified keyID.
	// In effect, SigCredential delegates the ability to make a signature to
	// a different public/private key pair.
	SigCredential
```

[`sig.go#L34-L54`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tka/sig.go#L34)。

署名が入れ子になれる。**ノードが [node key をローテーションする](../keys/)とき、管理者に署名を頼まずに済む** ようにするためだ。最初に「この鍵は自分でローテーションしてよい」という署名 (`SigRotation`) をもらっておけば、以降は自分の rotation key で新しい node key を署名できる。

入れ子の深さは CBOR デコーダの `MaxNestedLevels: 16` で制限され、そのコメントに「SigRotation の署名で一番当たりやすい」と書いてある。**制限値の根拠が、それを使う機能の名前で説明されている。**

## なぜそうなっているか

### なぜ proof of work ではなく決定的規則なのか

tailnet lock が解く問題は、ブロックチェーンが解く問題とは違う。

- **参加者は限られている。** tailnet の管理者だけが署名鍵を持つ。誰でも参加できる公開ネットワークではない。
- **51% 攻撃の相手がいない。** 攻撃者は control server であって、署名鍵を持たない。
- **分岐は稀で、悪意によるものではない。** ネットワーク分断や、2 人の管理者が同時に操作した場合に起きる。

この条件なら、**「全ノードが同じ規則で同じ答えを出す」だけで十分** だ。計算コストのかかる合意は要らない。

規則 2 (`RemoveKey` を優先) に設計思想が出ている。**鍵を消す操作と足す操作が競合したら、消すほうを勝たせる。** 侵害された鍵を無効化したいときに、同時に何かが起きても確実に消えてほしい。**安全側に倒す規則が、優先順位として明示されている。**

### なぜ署名の重みに投票数を持たせるのか

「1 鍵 1 票」だと、管理者が 3 人いる tailnet で 2 人が別々の変更をしたときに決着しない (両方 1 票)。ハッシュの大小で決めることになり、意図しない結果になる。

投票数を鍵ごとに設定できると、**「主管理者の鍵は 3 票、副管理者は 1 票」といった重み付け**ができる。組織の権限構造をそのまま反映できる。

そして重みの計算は「有効な署名の合計」なので、**1 つの AUM に複数人が署名すれば重みが増す**。「重要な変更には 2 人の承認が要る」という運用も、規則を変えずに表現できる。

### なぜ署名のないピアを「エラー」ではなく「除外」にするのか

tailnet lock を有効にした後も、まだ署名されていないノードは存在しうる。有効化前から居るノード、署名待ちの新規ノード。

ここで「netmap 全体を拒否する」と、**1 台の未署名ノードのせいで tailnet 全体が使えなくなる**。可用性が壊れる。

「そのピアだけ落とす」なら、**影響はそのピアとの通信だけ** に閉じる。他のピアとは通信し続けられる。しかも `b.tka.filtered` に記録されるので、管理者は `tailscale status` で「署名待ちのノードがある」と気づける。

**部分的な失敗を、全体の失敗にしない。** そして **黙って落とさず、落とした事実を見えるところに残す。**

### なぜ「既存のシリアライズテストが落ちたら実装を変えろ」なのか

普通のプロジェクトなら、シリアライズが変わったらテストの期待値を更新する。ここではそれが禁止されている。

理由は、**署名がバイト列に対して行われるから** だ。シリアライズが 1 バイトでも変われば、過去に作られた AUM の署名は検証に失敗する。チェーン全体が壊れる。

つまり `aum_test.go` のゴールデンテストは、**「テストが正しいか」ではなく「後方互換が壊れていないか」を見ている**。だから期待値の更新は「テストを直す」ではなく「互換性を壊す」ことになる。コメントはその区別を、実装者への指示として書いている。

## どう活かすか

**「中央サーバを信用しないで済ませる」レイヤは、後から足せる。** Tailscale は最初 control server を全面的に信用する設計で作り、後から署名チェーンを重ねた。既存のデータフロー (netmap) はそのままで、**受け取った側が検証して落とす** という形にすれば、プロトコルを作り直さずに済む。

**署名対象のシリアライズには、決定的な符号化を仕様として持つ形式を選ぶ。** JSON を正規化して署名するのは、歴史的に脆弱性を量産してきた。CBOR (CTAP2)、Protocol Buffers の決定的シリアライズ、あるいは自前の固定長フォーマット。**「同じ値は必ず同じバイト列になる」が仕様で保証されているか** を確認する。

**パーサの制限を、設定として明示的に書く。** 重複キー、不定長、ネストの深さ、要素数。攻撃者が制御できる入力を扱うパーサでは、これらが全部攻撃面になる。ライブラリの既定値に任せず、**各項目に「なぜこの値か」のコメントを添える**。

**分散合意が必要でも、参加者が限られていれば決定的規則で足りることがある。** 「全員が同じ入力から同じ答えを出す」比較関数を 1 つ書けば、それが合意アルゴリズムになる。規則の順序には設計思想が出るので、**安全側に倒す規則を上位に置く**。

**検証に失敗した要素は、全体を拒否するのではなく個別に落とし、落とした記録を残す。** 全体を拒否すると 1 件の不備で可用性が落ちる。黙って落とすと原因を追えなくなる。この 2 つを避ける形が「落として記録する」になる。

**互換性を守るゴールデンテストには、「これが落ちたら実装を変えろ」と書いておく。** 期待値を更新すればテストは通る。だから、更新してはいけないことをテストの外に書く必要がある。
