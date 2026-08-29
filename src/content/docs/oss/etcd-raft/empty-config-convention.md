---
title: "空の構成を「勝ち」「無限大」と定義すると、joint の計算が分岐なしで書ける"
description: "joint consensus は「2 つの構成の両方で過半数」を要求するが、通常時は片方が空になる。空の構成に単位元としての意味 — 投票は必ず勝ち、コミット位置は無限大 — を与えておくと、joint かどうかで分岐せずに同じコードが通る。規約が正しく効いていることを、コメント・表示・テストの 3 か所で確認している。"
group: "読み取りと構成変更"
sidebar:
  order: 28
---

## 何を学んだか

**演算に単位元を定義しておくと、特殊ケースの分岐が消える。** `etcd-io/raft` の構成は常に `JointConfig`、つまり `MajorityConfig` の 2 要素配列として表される。joint 状態でないときは 2 つ目が空になる。

空の `MajorityConfig` に、次の 2 つの規約を与える。

- 投票の集計は **必ず勝ち** (`VoteWon`)
- コミット位置は **無限大** (`math.MaxUint64`)

すると、joint の計算 (「両方で勝つ」「両方の小さい方」) がそのまま片方だけの結果になる。**「joint かどうか」の判定が計算のどこにも現れない**。

## ソースコードのどこか

構成の型は 2 要素配列だ ([`quorum/joint.go#L17-L19`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/joint.go#L17-L19))。

```go title="quorum/joint.go"
// JointConfig is a configuration of two groups of (possibly overlapping)
// majority configurations. Decisions require the support of both majorities.
type JointConfig [2]MajorityConfig
```

**通常時も joint 時も同じ型**。`tracker.Config` は `Voters quorum.JointConfig` を 1 つ持つだけで、「今は joint か」を表すフラグを持たない ([`tracker/tracker.go#L27-L32`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/tracker.go#L27-L32))。

判定が必要なときは、2 つ目が `nil` かどうかを見る ([`confchange/confchange.go#L400-L402`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L400-L402))。

```go title="confchange/confchange.go"
func joint(cfg tracker.Config) bool {
	return len(outgoing(cfg.Voters)) > 0
}
```

## 2 つの規約

### 投票: 空なら勝ち

([`quorum/majority.go#L165-L196`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/majority.go#L165-L196))

```go title="quorum/majority.go"
func (c MajorityConfig) VoteResult(votes map[uint64]bool) VoteResult {
	if len(c) == 0 {
		// By convention, the elections on an empty config win. This comes in
		// handy with joint quorums because it'll make a half-populated joint
		// quorum behave like a majority quorum.
		return VoteWon
	}
```

「規約により、空の構成での選挙は勝つ」と明示されている。そして「これは joint 定足数のときに便利で、片側だけの joint 定足数が普通の過半数定足数と同じ振る舞いになる」と、**規約の目的まで書かれている**。

### コミット位置: 空なら無限大

([`quorum/majority.go#L120-L126`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/majority.go#L120-L126))

```go title="quorum/majority.go"
func (c MajorityConfig) CommittedIndex(l AckedIndexer) Index {
	n := len(c)
	if n == 0 {
		// This plays well with joint quorums which, when one half is the zero
		// MajorityConfig, should behave like the other half.
		return math.MaxUint64
	}
```

こちらも同じ形の説明が付いている。

## 合成の側に分岐がない

規約があると、joint の計算はこう書ける ([`quorum/joint.go#L44-L75`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/joint.go#L44-L75))。

```go title="quorum/joint.go"
func (c JointConfig) CommittedIndex(l AckedIndexer) Index {
	idx0 := c[0].CommittedIndex(l)
	idx1 := c[1].CommittedIndex(l)
	if idx0 < idx1 {
		return idx0
	}
	return idx1
}

func (c JointConfig) VoteResult(votes map[uint64]bool) VoteResult {
	r1 := c[0].VoteResult(votes)
	r2 := c[1].VoteResult(votes)

	if r1 == r2 {
		// If they agree, return the agreed state.
		return r1
	}
	if r1 == VoteLost || r2 == VoteLost {
		// If either config has lost, loss is the only possible outcome.
		return VoteLost
	}
	// One side won, the other one is pending, so the whole outcome is.
	return VotePending
}
```

**`len(c[1]) == 0` の検査がどこにもない**。

`CommittedIndex` は `min` を取るだけ。2 つ目が `MaxUint64` を返すので、1 つ目がそのまま出る。

`VoteResult` は 3 値なので少し複雑だが、それでも分岐は「結果の組み合わせ」についてであって、「構成が空かどうか」ではない。3 つの分岐が値の組み合わせを尽くしている。

| `c[0]`          | `c[1]` | 結果    | 根拠                       |
| --------------- | ------ | ------- | -------------------------- |
| 同じ値          | 同じ値 | その値  | 一致するなら議論の余地なし |
| いずれかが Lost |        | Lost    | 片方で負けたら全体で負け   |
| Won と Pending  |        | Pending | 片方はまだ決まっていない   |

2 つ目が空なら常に `VoteWon` なので、1 つ目が `Won` なら 1 行目で `Won`、`Lost` なら 2 行目で `Lost`、`Pending` なら 3 行目で `Pending`。**すべての場合で 1 つ目の結果がそのまま出る**。

## 規約が表示にも一貫している

`MaxUint64` は数値としては巨大な値だが、意味は「制約なし」だ。`Index` 型の文字列化がそれを反映している ([`quorum/quorum.go#L22-L31`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/quorum.go#L22-L31))。

```go title="quorum/quorum.go"
// Index is a Raft log position.
type Index uint64

func (i Index) String() string {
	if i == math.MaxUint64 {
		return "∞"
	}
	return strconv.FormatUint(uint64(i), 10)
}
```

ログやテスト出力に `18446744073709551615` ではなく `∞` と出る。**規約の意味が、表示にも現れている**。デバッグ時に「なぜこんな巨大な値が」と考えずに済む。

構成の文字列化も、空の側を隠す ([`quorum/joint.go#L21-L28`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/joint.go#L21-L28))。

```go title="quorum/joint.go"
func (c JointConfig) String() string {
	if len(c[1]) > 0 {
		return c[0].String() + "&&" + c[1].String()
	}
	return c[0].String()
}
```

joint でないときは `(1 2 3)`、joint のときは `(1 2 3)&&(1 2 4)`。**内部表現は常に 2 要素だが、表示は状態を反映する**。テストの期待出力を読むときに、joint かどうかが一目で分かる。

`Describe` (進捗の可視化) は逆に、両方を統合する ([`quorum/joint.go#L40-L47`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/joint.go#L40-L47))。

```go title="quorum/joint.go"
// IDs returns a newly initialized map representing the set of voters present
// in the joint configuration.
func (c JointConfig) IDs() map[uint64]struct{} {
	m := map[uint64]struct{}{}
	for _, cc := range c {
		for id := range cc {
			m[id] = struct{}{}
		}
	}
	return m
}

func (c JointConfig) Describe(l AckedIndexer) string {
	return MajorityConfig(c.IDs()).Describe(l)
}
```

`IDs()` は 2 つの和集合を返す。「joint 構成に関わる全ノード」が必要な場面 — 進捗の可視化、投票要求の宛先、`ConfState` の生成 — で使われる。

**「両方で過半数」という論理と、「関わる全員」という集合が、別々のメソッドとして提供されている**。用途によって使い分けられる。

## 規約に依存している箇所

この規約は `quorum` パッケージの外でも効いている。

**joint 状態の生存確認**。[CheckQuorum のページ](../check-quorum-and-lease/) で見た `QuorumActive` は `p.Voters.VoteResult(votes)` を呼ぶだけだ。joint 状態なら自動的に「両方で過半数が生きている」ことを要求する。

**読み取りの確認**。[ReadIndex のページ](../read-index/) の `maybeAdvance` は `c.CommittedIndex(ro)` を呼ぶ。joint 状態なら自動的に「両方で確認された」件数になる。

**コミット位置**。`ProgressTracker.Committed()` も同様。

どれも「joint 対応」を意識したコードを書いていない。**規約を 1 か所に置いたことで、それを使う全箇所が自動的に joint 対応になっている**。

## 検証されているか

この規約が本当に効いているかは、テストで確認されている。`quorum` パッケージには datadriven テストがあり、構成と票の組み合わせを列挙して結果を記録している。

さらに、joint 構成を扱う `testdata/confchange_v2_*.txt` の一群 (7 本) が、実際の構成変更の流れを通してこの計算を使う。`confchange_v2_replace_leader.txt` のように、リーダーごと入れ替える操作も含まれている。

`Restore` の往復検査 ([joint consensus のページ](../joint-consensus/)) も、間接的にこの規約を検証している。空の構成から操作を積み上げて元の `ConfState` に戻ることが確認されるので、規約が壊れていれば起動時に露見する。

## なぜそうなっているか

代替案は「joint かどうかで分岐する」だ。

```go
// もし規約がなかったら
func (c JointConfig) CommittedIndex(l AckedIndexer) Index {
	if len(c[1]) == 0 {
		return c[0].CommittedIndex(l)
	}
	idx0 := c[0].CommittedIndex(l)
	idx1 := c[1].CommittedIndex(l)
	return min(idx0, idx1)
}
```

3 行増えるだけに見える。しかしこの分岐は、`VoteResult` にも、それを呼ぶ `QuorumActive` にも、`maybeAdvance` にも、それぞれ必要になる。**分岐が伝播する**。

そして、分岐が伝播すると「joint のときだけ通る経路」が増える。joint 状態は構成変更中の短い期間にしか存在しないので、そこだけを通る経路はテストされにくい。バグが残りやすい場所になる。

規約を置くと、**joint 用の経路が存在しなくなる**。常に同じコードが通る。joint 状態のテストは、通常時と同じ経路が違う入力で動くことの確認になる。

「片方が空なら、もう片方と同じに振る舞う」という性質は、代数でいう単位元の条件そのものだ。`min` に対する `MaxUint64`、論理積に対する `true`。**演算に対して単位元を持つ値を用意すると、要素数によらず同じ式が書ける**。

## どう活かすか

- **合成される演算には単位元を定義する**。`min` なら最大値、論理積なら真、和なら 0。空集合や欠損値にそれを割り当てると、要素数の分岐が消える。
- **規約の目的をコメントに書く**。「空なら勝ち」だけでは意図が伝わらない。「これにより片側だけの joint が普通の過半数と同じに振る舞う」まで書くと、規約を変えてよいかが判断できる。
- **規約的な値には専用の表示を与える**。`MaxUint64` を `∞` と出すだけで、ログを読む人の理解が変わる。センチネル値をそのまま出すと、バグに見える。
- **内部表現と表示を分ける**。常に 2 要素の配列で持ちつつ、表示は状態を反映させる。表現を単純に保ちながら、可読性を落とさない。
- **「両方で満たす」と「関わる全員」を別メソッドにする**。合成の論理と、集合としての和は用途が違う。片方だけ提供すると、呼び出し側で組み直すことになる。
- **稀にしか通らない経路を作らない**。「特殊な状態のときだけ通るコード」はテストされにくい。特殊状態を通常状態の一例として扱えるなら、そうする方が壊れにくい。
