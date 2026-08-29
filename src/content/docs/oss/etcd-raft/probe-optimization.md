---
title: "ログの食い違いを 1 件ずつ探らず、任期の単調性を使って一気に飛ばす"
description: "リーダーとフォロワーのログが大きく食い違うと、素朴な 1 件ずつの探索は「食い違いの長さ × RTT」かかる。実際に何時間もかかって障害になった。任期がログの中で単調非減少であることを使うと、探索は「リーダーのログに現れる任期の数」に落ちる。同じ最適化がフォロワー側にもあり、2 つが噛み合って初めて効く。"
group: "複製と流量制御"
sidebar:
  order: 22
---

## 何を学んだか

**データ構造の単調性は、探索範囲を絞る根拠になる。** Raft のログでは、任期はインデックスに対して単調非減少になる。この 1 つの性質から「ここを探っても必ず失敗する」という区間が導けて、1 件ずつの線形探索が「任期の種類の数」に落ちる。

そして、この最適化は **リーダー側とフォロワー側の両方に必要** だった。片方だけでは効かないケースがあり、両方が噛み合って初めて実用的な速度になる。

## 素朴な方法の問題

[ログ複製のページ](../log-replication/) で見たとおり、リーダーは拒否されるたびに `Next` を 1 つ下げて再試行する。食い違いが 3 件なら 3 往復で済む。

問題は食い違いが長い場合だ。`stepLeader` のコメントがそれを述べている ([`raft.go#L1387-L1402`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1387-L1402))。

```go title="raft.go"
			// Under normal circumstances, the leader's log is longer than the
			// follower's and the follower's log is a prefix of the leader's
			// (i.e. there is no divergent uncommitted suffix of the log on the
			// follower). In that case, the first probe reveals where the
			// follower's log ends (RejectHint=follower's last index) and the
			// subsequent probe succeeds.
			//
			// However, when networks are partitioned or systems overloaded,
			// large divergent log tails can occur. The naive attempt, probing
			// entry by entry in decreasing order, will be the product of the
			// length of the diverging tails and the network round-trip latency,
			// which can easily result in hours of time spent probing and can
			// even cause outright outages. The probes are thus optimized as
			// described below.
```

**「何時間もの探索時間になり、完全な障害を引き起こしうる」**。RTT 50ms で食い違いが 10 万件なら、5000 秒 = 約 1.4 時間。実際に起きた問題として書かれている。

## リーダー側の最適化

拒否の返答には、フォロワーが持っている `(index, term)` が載っている。これを使う ([`raft.go#L1403-L1431`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1403-L1431))。

```go title="raft.go"
				// For example, if the leader has:
				//
				//   idx        1 2 3 4 5 6 7 8 9
				//              -----------------
				//   term (L)   1 3 3 3 5 5 5 5 5
				//   term (F)   1 1 1 1 2 2
				//
				// Then, after sending an append anchored at (idx=9,term=5) we
				// would receive a RejectHint of 6 and LogTerm of 2. Without the
				// code below, we would try an append at index 6, which would
				// fail again.
				//
				// However, looking only at what the leader knows about its own
				// log and the rejection hint, it is clear that a probe at index
				// 6, 5, 4, 3, and 2 must fail as well:
				//
				// For all of these indexes, the leader's log term is larger than
				// the rejection's log term. If a probe at one of these indexes
				// succeeded, its log term at that index would match the leader's,
				// i.e. 3 or 5 in this example. But the follower already told the
				// leader that it is still at term 2 at index 6, and since the
				// log term only ever goes up (within a log), this is a contradiction.
				//
				// At index 1, however, the leader can draw no such conclusion,
				// as its term 1 is not larger than the term 2 from the
				// follower's rejection. We thus probe at 1, which will succeed
				// in this example. In general, with this approach we probe at
				// most once per term found in the leader's log.
```

議論を追う。フォロワーは「index 6 の任期は 2 だ」と言っている。任期はログの中で単調非減少なので、**フォロワーの index 6 以下の任期はすべて 2 以下** になる。

一方リーダーの index 2〜6 の任期は 3 または 5 で、どれも 2 より大きい。もしその位置で一致するなら、フォロワーの任期もそこで 3 か 5 でなければならない。矛盾する。だから **index 2〜6 は探るまでもなく失敗する**。

index 1 は任期 1 で、2 以下なので矛盾しない。ここから探る。

結論が最後の 1 文にある。**「リーダーのログに現れる任期 1 つにつき、高々 1 回しか探らない」**。10 万件の食い違いがあっても、その区間の任期が 3 種類なら 3 往復で済む。

実装は `findConflictByTerm` だ ([`log.go#L169-L193`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L169-L193))。

```go title="log.go"
// findConflictByTerm returns a best guess on where this log ends matching
// another log, given that the only information known about the other log is the
// (index, term) of its single entry.
//
// Specifically, the first returned value is the max guessIndex <= index, such
// that term(guessIndex) <= term or term(guessIndex) is not known (because this
// index is compacted or not yet stored).
func (l *raftLog) findConflictByTerm(index uint64, term uint64) (uint64, uint64) {
	for ; index > 0; index-- {
		// If there is an error (likely ErrCompacted or ErrUnavailable), we don't
		// know whether it's a match or not, so assume a possible match and return
		// the index, with 0 term indicating an unknown term.
		if ourTerm, err := l.term(index); err != nil {
			return index, 0
		} else if ourTerm <= term {
			return index, ourTerm
		}
	}
	return 0, 0
}
```

自分のログを後ろから見て、任期が `term` 以下になる最初の位置を返す。ループ自体は線形だが、**ローカルなメモリ走査であってネットワーク往復ではない**。往復の回数が減ることが本質になる。

読めない位置に当たったら、そこを「一致するかもしれない」として返す。圧縮された位置なら、次の試行でスナップショット送信に切り替わる。**分からないことを、探索の終端として扱う**。

呼び出し側 ([`raft.go#L1516-L1530`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1516-L1530)):

```go title="raft.go"
			nextProbeIdx := m.GetRejectHint()
			if m.GetLogTerm() > 0 {
				nextProbeIdx, _ = r.raftLog.findConflictByTerm(m.GetRejectHint(), m.GetLogTerm())
			}
			if pr.MaybeDecrTo(m.GetIndex(), nextProbeIdx) {
```

`m.GetLogTerm() > 0` の検査があるのは、古いバージョンとの互換性のためだ。コメントに「古いバージョンのライブラリは拒否時に `LogTerm` を入れなかったし、ログが空のフォロワーでは 0 になる」とある。

## フォロワー側の最適化

リーダー側だけでは効かないケースがある ([`raft.go#L1432-L1454`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1432-L1454))。

```go title="raft.go"
				// There is a similar mechanism on the follower (implemented in
				// handleAppendEntries via a call to findConflictByTerm) that is
				// useful if the follower has a large divergent uncommitted log
				// tail[1], as in this example:
				//
				//   idx        1 2 3 4 5 6 7 8 9
				//              -----------------
				//   term (L)   1 3 3 3 3 3 3 3 7
				//   term (F)   1 3 3 4 4 5 5 5 6
				//
				// Naively, the leader would probe at idx=9, receive a rejection
				// revealing the log term of 6 at the follower. Since the leader's
				// term at the previous index is already smaller than 6, the leader-
				// side optimization discussed above is ineffective. The leader thus
				// probes at index 8 and, naively, receives a rejection for the same
				// index and log term 5. Again, the leader optimization does not improve
				// over linear probing as term 5 is above the leader's term 3 for that
				// and many preceding indexes; the leader would have to probe linearly
				// until it would finally hit index 3, where the probe would succeed.
```

今度は **フォロワー側の任期の方が大きい**。リーダーの `findConflictByTerm(8, 6)` は「任期 6 以下の最大位置」を探すが、リーダーの index 8 の任期は 3 で既に 6 以下なので、すぐ index 8 を返してしまう。1 つも飛ばせない。

そこでフォロワー側でも同じ推論をする。

```go title="raft.go"
				// Instead, we apply a similar optimization on the follower. When the
				// follower receives the probe at index 8 (log term 3), it concludes
				// that all of the leader's log preceding that index has log terms of
				// 3 or below. The largest index in the follower's log with a log term
				// of 3 or below is index 3. The follower will thus return a rejection
				// for index=3, log term=3 instead. The leader's next probe will then
				// succeed at that index.
```

フォロワーは「リーダーの index 8 の任期は 3 だ」と知らされている。単調性より **リーダーの index 8 以下の任期はすべて 3 以下**。自分のログで任期 3 以下の最大位置は index 3。だから「index 3 から試して」と返す。

実装は `handleAppendEntries` にある ([`raft.go#L1804-L1832`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1804-L1832))。

```go title="raft.go"
	// Our log does not match the leader's at index m.Index. Return a hint to the
	// leader - a guess on the maximal (index, term) at which the logs match. Do
	// this by searching through the follower's log for the maximum (index, term)
	// pair with a term <= the MsgApp's LogTerm and an index <= the MsgApp's
	// Index. This can help skip all indexes in the follower's uncommitted tail
	// with terms greater than the MsgApp's LogTerm.
	//
	// See the other caller for findConflictByTerm (in stepLeader) for a much more
	// detailed explanation of this mechanism.

	// NB: m.Index >= raftLog.committed by now (see the early return above), and
	// raftLog.lastIndex() >= raftLog.committed by invariant, so min of the two is
	// also >= raftLog.committed. Hence, the findConflictByTerm argument is within
	// the valid interval, which then will return a valid (index, term) pair with
	// a non-zero term (unless the log is empty).
	hintIndex := min(m.GetIndex(), r.raftLog.lastIndex())
	hintIndex, hintTerm := r.raftLog.findConflictByTerm(hintIndex, m.GetLogTerm())
	r.send(&pb.Message{
		To:         m.From,
		Type:       pb.MsgAppResp.Enum(),
		Index:      new(m.GetIndex()),
		Reject:     new(true),
		RejectHint: new(hintIndex),
		LogTerm:    new(hintTerm),
	})
```

**同じ関数 `findConflictByTerm` が、リーダーとフォロワーの両方から呼ばれる**。引数の意味が対称になっている。

- リーダー: `findConflictByTerm(フォロワーが言った index, フォロワーが言った term)`
- フォロワー: `findConflictByTerm(リーダーが言った index, リーダーが言った term)`

どちらも「相手の (index, term) から、自分のログのどこまで一致しうるか」を計算している。片側の実装がそのまま両側で使える。

コメントの `NB:` は、引数の範囲が正しいことの証明になっている。「`m.Index >= committed` は早期リターンで保証され、`lastIndex() >= committed` は不変条件、だから `min` も `committed` 以上」。**関数の事前条件が満たされることを、呼び出し地点で証明している**。

## 食い違いはなぜ起きるのか

「フォロワーが大きな分岐した末尾を持つことがそもそも起きるのか」という疑問に、コメントは 4 ステップの手順で答えている ([`raft.go#L1455-L1487`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1455-L1487))。

```go title="raft.go"
				// [1]: more precisely, if the log terms in the large uncommitted
				// tail on the follower are larger than the leader's. At first,
				// it may seem unintuitive that a follower could even have such
				// a large tail, but it can happen:
				//
				// 1. Leader appends (but does not commit) entries 2 and 3, crashes.
				//   idx        1 2 3 4 5 6 7 8 9
				//              -----------------
				//   term (L)   1 2 2     [crashes]
				//   term (F)   1
				//   term (F)   1
				//
				// 2. a follower becomes leader and appends entries at term 3.
				//              -----------------
				//   term (x)   1 2 2     [down]
				//   term (F)   1 3 3 3 3
				//   term (F)   1
				//
				// 3. term 3 leader goes down, term 2 leader returns as term 4
				//    leader. It commits the log & entries at term 4.
				//
				//              -----------------
				//   term (L)   1 2 2 2
				//   term (x)   1 3 3 3 3 [down]
				//   term (F)   1
				//              -----------------
				//   term (L)   1 2 2 2 4 4 4
				//   term (F)   1 3 3 3 3 [gets probed]
				//   term (F)   1 2 2 2 4 4 4
				//
				// 4. the leader will now probe the returning follower at index
				//    7, the rejection points it at the end of the follower's log
				//    which is at a higher log term than the actually committed
				//    log.
```

**「直感に反するように見えるかもしれないが、起きる」** と前置きして、起こる手順を図で示している。3 台のログの遷移を 4 段階で追い、最後にリーダーが探る場面まで持っていく。

このコメントの価値は 2 つある。1 つは、最適化が机上の空論でないことの証拠。もう 1 つは、**テストを書くための手順書** になっていること。実際、`testdata/probe_and_replicate.txt` は論文の図 7 に相当する 7 ノードのログ構成を手で作ってから探索を観察する形になっている。

```text title="testdata/probe_and_replicate.txt"
# This test creates a complete Raft log configuration and demonstrates how a
# leader probes and replicates to each of its followers. The log configuration
# constructed is almost[*] identical to the one present in Figure 7 of the raft
# paper (https://raft.github.io/raft.pdf), which looks like:
#
#      1  2  3  4  5  6  7  8  9  10 11 12
# n1: [1][1][1][4][4][5][5][6][6][6]
# n2: [1][1][1][4][4][5][5][6][6]
# n3: [1][1][1][4]
# n4: [1][1][1][4][4][5][5][6][6][6][6]
# n5: [1][1][1][4][4][5][5][6][7][7][7][7]
# n6: [1][1][1][4][4][4][4]
# n7: [1][1][1][2][2][2][3][3][3][3][3]
```

7 ノードそれぞれ違う食い違い方をさせ、リーダーが全員を追いつかせる過程を 740 行の出力として記録している。**論文の図がテストになっている**。

## 探索が終わるまで待たない

もう 1 つ、探索と並行する処理がある。`MaybeDecrTo` は古い応答を弾く ([`tracker/progress.go#L226-L260`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L226-L260))。

`StateProbe` では 1 通ずつしか送らないので、応答の重複は本来起きにくい。しかし `StateReplicate` から落ちてきた直後には、飛行中のメッセージへの拒否がまとめて返ってくる。それを 1 件ずつ処理すると `Next` が下がりすぎる。`Maybe` の名を持つ関数群が、この手の遅れて届く情報を弾いている。

## なぜそうなっているか

この最適化の根拠は、**ログ内で任期が単調非減少** という 1 つの性質だけだ。[複製状態機械のページ](../replicated-state-machine/) で見た `logSlice` の不変条件がそれを保証している。

```go title="types.go"
//  3. entries[i-1].Term <= entries[i].Term,
```

単調性があると、「ある位置の任期」から「それ以前の全位置の任期の上界」が分かる。上界が分かれば、一致しえない区間が特定できる。**1 点の観測から区間の性質を導く** という、単調なデータ構造でよく使う手になる。

そして、片側だけでは不十分だったことが重要だ。リーダー側の最適化は「リーダーの任期がフォロワーより大きい」ときに効き、フォロワー側は逆のときに効く。どちらが大きいかは状況次第なので、**両方持って初めてどんな場合でも効く**。

対称な問題には対称な解を両側に置く、という判断がここに現れている。同じ関数を両側から呼べるように書いたことで、実装コストはほぼ 2 倍にならずに済んでいる。

## どう活かすか

- **単調性を探索範囲の絞り込みに使う**。ソート済み、単調増加、バージョン単調といった性質があるなら、1 点の観測から区間全体の判定ができる。二分探索まで行かなくても、線形探索の定数倍を大きく落とせる。
- **相手の返答に「次はここから」を載せる**。拒否だけを返すと、送信側は 1 つずつ試すしかない。受信側が持っている情報を返せば、往復を減らせる。
- **対称な問題は両側に同じ解を置く**。片側だけの最適化は、条件が逆のときに効かない。同じ関数を両側から引数を入れ替えて呼べる形にすると、実装が重複しない。
- **なぜその状況が起きるのかを、手順としてコメントに残す**。「こんなことは起きないのでは」という疑問に先回りして、起こる手順を書いておく。それがそのままテストの設計になる。
- **性能問題の規模を具体的に書く**。「遅くなる」ではなく「食い違いの長さ × RTT で、何時間にもなり、障害を引き起こす」。最適化を消してよいか判断するときの材料になる。
