---
title: "コミット位置の計算を「ソートして真ん中を取る」に還元し、7 台までは確保なしで済ませる"
description: "「過半数に届いているインデックス」は、各ノードの Match をソートして所定の位置を取るだけで求まる。etcd-io/raft はそれを、7 台までスタック上の配列で行い、未報告のノードをゼロで埋めて左に寄せることで分岐を消している。計算を AckedIndexer というインターフェースに切り出したことで、読み取り要求の確認にも同じ関数が使えるようになっている。"
group: "複製と流量制御"
sidebar:
  order: 23
---

## 何を学んだか

**「過半数が達成している値」の計算は、ソートして所定の位置を取るだけで済む。** そして `etcd-io/raft` はその計算を、次の 3 つの工夫でまとめている。

- **7 台以下ならスタック上の固定長配列** を使い、ヒープ確保をしない。
- **未報告のノードをゼロとして左に寄せる** ことで、「報告があったか」の分岐を消す。
- **入力をインターフェースに抽象化** することで、同じ関数を「ログのコミット位置」と「読み取り要求の確認」の両方に使う。

## ソースコードのどこか

計算の本体は 30 行ほどだ ([`quorum/majority.go#L118-L163`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/majority.go#L118-L163))。

```go title="quorum/majority.go"
// CommittedIndex computes the committed index from those supplied via the
// provided AckedIndexer (for the active config).
func (c MajorityConfig) CommittedIndex(l AckedIndexer) Index {
	n := len(c)
	if n == 0 {
		// This plays well with joint quorums which, when one half is the zero
		// MajorityConfig, should behave like the other half.
		return math.MaxUint64
	}

	// Use an on-stack slice to collect the committed indexes when n <= 7
	// (otherwise we alloc). The alternative is to stash a slice on
	// MajorityConfig, but this impairs usability (as is, MajorityConfig is just
	// a map, and that's nice). The assumption is that running with a
	// replication factor of >7 is rare, and in cases in which it happens
	// performance is a lesser concern (additionally the performance
	// implications of an allocation here are far from drastic).
	var stk [7]uint64
	var srt []uint64
	if len(stk) >= n {
		srt = stk[:n]
	} else {
		srt = make([]uint64, n)
	}

	{
		// Fill the slice with the indexes observed. Any unused slots will be
		// left as zero; these correspond to voters that may report in, but
		// haven't yet. We fill from the right (since the zeroes will end up on
		// the left after sorting below anyway).
		i := n - 1
		for id := range c {
			if idx, ok := l.AckedIndex(id); ok {
				srt[i] = uint64(idx)
				i--
			}
		}
	}
	slices.Sort(srt)

	// The smallest index into the array for which the value is acked by a
	// quorum. In other words, from the end of the slice, move n/2+1 to the
	// left (accounting for zero-indexing).
	pos := n - (n/2 + 1)
	return Index(srt[pos])
}
```

## 計算の原理

まず、なぜソートして所定位置を取るだけでよいのか。

`Match` は「そこまで一致していると確認済み」の位置なので、`Match = 7` のノードは index 1〜7 を全部持っている。つまり **「index i を持つノードの数」は、`Match >= i` のノードの数** に等しい。

過半数が持っている最大の i を求めたい。`Match` を降順に並べて、上から `n/2+1` 番目の値がそれになる。

```
5 台の Match: [9, 7, 7, 4, 2]
              ├──────┤
              上位 3 台 (= 5/2+1) が 7 以上を持っている
              → committed = 7
```

`pos = n - (n/2 + 1)` は、昇順ソートした配列での同じ位置を指す。5 台なら `pos = 5 - 3 = 2` で、`srt[2]` が 3 番目に大きい値になる。

## スタック上の配列

`var stk [7]uint64` は 56 バイト。Go のエスケープ解析でスタックに乗る。7 台を超えるときだけ `make` する。

コメントが判断の根拠を 3 つ挙げている。

1. **代替案の検討**: 「`MajorityConfig` にスライスを持たせる手もあるが、そうすると使い勝手が悪くなる (今は単なるマップで、それがいい)」。
2. **前提の明示**: 「レプリカ数が 7 を超えるのは稀」。
3. **影響の見積もり**: 「超えた場合も、ここでの確保の性能影響は決して致命的ではない」。

**設計の代替案、その前提、外れたときの影響** が 3 行で書かれている。「7」という魔法の数字がなぜ 7 なのかを、後から読む人が判断できる。

`CommittedIndex` は `MsgAppResp` を受け取るたびに呼ばれる。1 プロセスに数千の Raft グループがあり、それぞれが毎秒何千もの応答を処理するなら、ここでの確保が GC 圧力になる。**呼ばれる頻度が高い関数だけを、実装の綺麗さを少し犠牲にして最適化している**。

## ゼロ埋めと右詰め

面白いのが埋め方だ。

```go title="quorum/majority.go"
		// Fill the slice with the indexes observed. Any unused slots will be
		// left as zero; these correspond to voters that may report in, but
		// haven't yet. We fill from the right (since the zeroes will end up on
		// the left after sorting below anyway).
		i := n - 1
		for id := range c {
			if idx, ok := l.AckedIndex(id); ok {
				srt[i] = uint64(idx)
				i--
			}
		}
```

まだ報告のないノードは、配列にゼロが残る。ゼロは「index 0 まで持っている = 何も持っていない」と解釈できるので、**「未報告」と「何も持っていない」を区別せずに済む**。

そのため、報告のあったノードを右端から詰めていく。ソート後にゼロが左に集まるので、右詰めしておくと書き込み位置とソート後の位置がおおむね一致する。ソートの手間が少し減る。

`if ok` の分岐が値の書き込みだけに閉じていて、その後の計算には一切現れない。**特殊ケースをデータの表現に吸収する** 形になっている。

## joint への拡張が 1 行

joint consensus では、新旧両方の構成で過半数を満たす必要がある ([`quorum/joint.go#L45-L57`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/joint.go#L45-L57))。

```go title="quorum/joint.go"
// CommittedIndex returns the largest committed index for the given joint
// quorum. An index is jointly committed if it is committed in both constituent
// majorities.
func (c JointConfig) CommittedIndex(l AckedIndexer) Index {
	idx0 := c[0].CommittedIndex(l)
	idx1 := c[1].CommittedIndex(l)
	if idx0 < idx1 {
		return idx0
	}
	return idx1
}
```

両方を計算して小さい方を取る。それだけだ。

`JointConfig` は `[2]MajorityConfig` で、joint でないときは 2 つ目が空になる。空の `MajorityConfig` が `math.MaxUint64` を返すので、`min` を取ると 1 つ目の結果がそのまま出る。**joint かどうかの分岐が要らない**。この規約については [空の構成のページ](../empty-config-convention/) で扱う。

## 入力をインターフェースにした効果

`CommittedIndex` の引数は具体的なマップではなく、インターフェースだ ([`quorum/quorum.go#L32-L36`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/quorum.go#L32-L36))。

```go title="quorum/quorum.go"
// AckedIndexer allows looking up a commit index for a given ID of a voter
// from a corresponding MajorityConfig.
type AckedIndexer interface {
	AckedIndex(voterID uint64) (idx Index, found bool)
}
```

ログのコミット位置を計算するときは、`Progress.Match` を引く実装が渡される ([`tracker/tracker.go#L164-L182`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/tracker.go#L164-L182))。

```go title="tracker/tracker.go"
type matchAckIndexer map[uint64]*Progress

var _ quorum.AckedIndexer = matchAckIndexer(nil)

// AckedIndex implements IndexLookuper.
func (l matchAckIndexer) AckedIndex(id uint64) (quorum.Index, bool) {
	pr, ok := l[id]
	if !ok {
		return 0, false
	}
	return quorum.Index(pr.Match), true
}

// Committed returns the largest log index known to be committed based on what
// the voting members of the group have acknowledged.
func (p *ProgressTracker) Committed() uint64 {
	return uint64(p.Voters.CommittedIndex(matchAckIndexer(p.Progress)))
}
```

そして、**読み取り要求の確認にも同じ関数が使われる** ([`read_only.go#L71-L91`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/read_only.go#L71-L91))。

```go title="read_only.go"
// AckedIndex allows for using `CommittedIndex` in `maybeAdvance`.
func (ro *readOnly) AckedIndex(voterID uint64) (quorum.Index, bool) {
	idx, found := ro.acks[voterID]
	return quorum.Index(idx), found
}

// maybeAdvance uses the existing acknowledgements and current raft
// configuration to confirm and return as many unconfirmed reads as possible.
func (ro *readOnly) maybeAdvance(c quorum.JointConfig) []*readIndexRequest {
	// Use `CommittedIndex` to figure out how many reads are now confirmed.
	newConfirmedReads := uint64(c.CommittedIndex(ro))
```

こちらの「インデックス」はログの位置ではなく、**読み取り要求の通し番号** だ。「何番目までの読み取り要求が過半数に確認されたか」を、まったく同じ「ソートして真ん中を取る」計算で求めている。詳しくは [ReadIndex のページ](../read-index/) で扱う。

**問題を「過半数が達成している単調な値を求める」という形に抽象化した** ことで、まったく別の用途に同じコードが乗った。joint consensus への対応も自動的に付いてくる。

同じことが投票の集計にも言える。`VoteResult` は真偽値の集計だが、`QuorumActive` (生存確認) がそれを再利用している。**定足数に関する計算が 1 つのパッケージに閉じている** ので、構成変更への追随が全部そこで済む。

## デバッグ表示

`quorum` パッケージには、進捗を図で見せる関数もある ([`quorum/majority.go#L46-L107`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/majority.go#L46-L107))。

```go title="quorum/majority.go"
	// Below, populate .bar so that the i-th largest commit index has bar i (we
	// plot this as sort of a progress bar). The actual code is a bit more
	// complicated and also makes sure that equal index => equal bar.
```

出力はこうなる。

```
    idx
x>   100    (id=1)
xx>  105    (id=2)
?      0    (id=3)
```

`x` の数が順位を表し、`?` は未報告。**定足数の計算がなぜその結果になったかを、目で見て確認できる**。テストの期待出力に含めれば、計算のずれが視覚的な差分として現れる。

`Index.String()` にも仕掛けがある ([`quorum/quorum.go#L25-L31`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/quorum.go#L25-L31))。

```go title="quorum/quorum.go"
func (i Index) String() string {
	if i == math.MaxUint64 {
		return "∞"
	}
	return strconv.FormatUint(uint64(i), 10)
}
```

空の構成が返す `MaxUint64` を `∞` と表示する。数値としては巨大な値だが、意味は「無限大 = 制約なし」なので、そう見せる。**規約の意味が表示にも一貫している**。

## なぜそうなっているか

コミット位置の計算は、Raft の中で最も頻繁に呼ばれる計算の 1 つだ。`MsgAppResp` を受けるたび、構成が変わるたびに走る。

一方、計算そのものは単純で、実装の選択肢は多くない。だから最適化の余地は「確保を避ける」しかない。7 要素のスタック配列という選択は、その 1 点に絞った最適化になる。

より重要なのは、**この計算を独立したパッケージに切り出したこと** だろう。`quorum` パッケージは `raft` パッケージに依存しない。ログもメッセージも知らない。知っているのは「ID の集合」と「ID から値を引く方法」だけだ。

その結果、

- 読み取り要求の確認に転用できた。
- joint consensus への対応が `min` 1 つで済んだ。
- 生存確認 (`QuorumActive`) が投票集計を再利用できた。
- パッケージ単体でテストできる ([`quorum/quorum_test.go`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/quorum/) には datadriven テストがある)。

**定足数という概念が、Raft から切り離せる形で抽象化されている**。

## どう活かすか

- **「過半数が達成している値」はソートして所定位置を取る**。閾値を満たす最大値を求める問題は、この形に還元できることが多い。全組み合わせを調べる必要はない。
- **特殊ケースをデータの表現に吸収する**。未報告をゼロとして扱えば、判定の分岐が消える。「欠損値」に自然な単位元があるなら、それを使う。
- **小さな固定長配列でヒープ確保を避ける。ただし前提を書く**。「7 を超えるのは稀」「超えても致命的ではない」という判断を残しておかないと、後から読む人が数字を変えられない。
- **入力をインターフェースにして、計算だけを切り出す**。`AckedIndexer` のように「ID から値を引く」だけを要求すると、まったく別の用途に転用できる。
- **計算過程を目で見える形に出す関数を用意する**。`Describe` のような可視化は、テストの期待出力に埋め込めば回帰検出にもなる。
- **規約的な値には、それが分かる表示を与える**。`MaxUint64` を `∞` と出すだけで、ログを読む人の理解が変わる。
