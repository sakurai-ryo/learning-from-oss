---
title: "投票権がないはずの learner にも投票させないと、クラスタが止まる場合がある"
description: "learner は投票権を持たないメンバーだ。しかし etcd-io/raft は learner にも投票させる。構成の認識がノードごとにずれるため、「昇格済みだがそれを知らない voter」が存在しうるからで、投票要求が来たこと自体がその事実の通知になる。役割の判断を、自分の認識ではなく相手の認識に委ねる例。"
group: "選挙の工夫"
sidebar:
  order: 19
---

## 何を学んだか

**分散システムでは「自分が何者か」の認識が古いことがある。** クラスタ構成はログエントリとして配られるので、昇格したことをまだ知らないノードが存在しうる。そのノードが「私は learner なので投票しません」と判断すると、実際には過半数が生きているのにリーダーが選べなくなる。

`etcd-io/raft` は、**投票要求が届いたこと自体を「相手は私を voter だと思っている」という情報として使う**。自分の認識より相手の認識を優先し、投票する。

## 問題の場面

`Step` の中に、この件だけで 20 行のコメントがある ([`raft.go#L1223-L1239`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1223-L1239))。

```go title="raft.go"
			// Note: it turns out that that learners must be allowed to cast votes.
			// This seems counter- intuitive but is necessary in the situation in which
			// a learner has been promoted (i.e. is now a voter) but has not learned
			// about this yet.
			// For example, consider a group in which id=1 is a learner and id=2 and
			// id=3 are voters. A configuration change promoting 1 can be committed on
			// the quorum `{2,3}` without the config change being appended to the
			// learner's log. If the leader (say 2) fails, there are de facto two
			// voters remaining. Only 3 can win an election (due to its log containing
			// all committed entries), but to do so it will need 1 to vote. But 1
			// considers itself a learner and will continue to do so until 3 has
			// stepped up as leader, replicates the conf change to 1, and 1 applies it.
			// Ultimately, by receiving a request to vote, the learner realizes that
			// the candidate believes it to be a voter, and that it should act
			// accordingly. The candidate's config may be stale, too; but in that case
			// it won't win the election, at least in the absence of the bug discussed
			// in:
			// https://github.com/etcd-io/etcd/issues/7625#issuecomment-488798263.
```

図にするとこうなる。

```
初期状態:  1 = learner,  2 = leader(voter),  3 = voter
           過半数 = {2,3} のうち 2 台

「1 を voter に昇格する」構成変更をリーダー 2 が提案:

  2 のログ: [... 昇格エントリ]   ← 書いた
  3 のログ: [... 昇格エントリ]   ← 複製された
  1 のログ: [...]                ← まだ届いていない

  {2,3} で過半数を満たすので、昇格エントリは コミットされ、適用される。
  この時点で 2 と 3 は「voter は {1,2,3} の 3 台」と認識している。
  1 は依然「自分は learner」と認識している。

ここでリーダー 2 が落ちる:

  残る voter は {1,3} の 2 台。過半数は 2 台。
  3 が立候補する。自分の 1 票に加えて、1 か 2 の票が要る。
  2 は落ちている。1 の票が必須。
  しかし 1 は「自分は learner だから投票しない」と判断する
      → 誰もリーダーになれない
      → クラスタが停止
```

**構成の上では過半数が生きているのに、認識のずれで止まる**。1 が昇格を知るには 3 がリーダーになってエントリを複製する必要があるが、3 がリーダーになるには 1 の票が要る。相互に待ち合う。

## 解決

投票の可否を判断する条件に、learner かどうかの検査を **入れない** ([`raft.go#L1213-L1222`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1213-L1222))。

```go title="raft.go"
		canVote := r.Vote == m.GetFrom() ||
			(r.Vote == None && r.lead == None) ||
			(m.GetType() == pb.MsgPreVote && m.GetTerm() > r.Term)
		lastID := r.raftLog.lastEntryID()
		candLastID := entryID{term: m.GetLogTerm(), index: m.GetIndex()}
		if canVote && r.raftLog.isUpToDate(candLastID) {
```

`r.isLearner` を見ていない。投票要求が届けば、learner でも通常どおり判定して投票する。

**投票要求が届いたことが、「候補者は私を voter として数えている」という情報になる**。候補者は自分の構成に基づいて投票要求の宛先を決めるので ([`raft.go#L1041-L1049`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1041-L1049))、learner には送らない。届いたということは、候補者の認識では自分は voter だということになる。

```go title="raft.go"
	var ids []uint64
	{
		idMap := r.trk.Voters.IDs()
		ids = make([]uint64, 0, len(idMap))
		for id := range idMap {
			ids = append(ids, id)
		}
		slices.Sort(ids)
	}
```

`r.trk.Voters.IDs()` なので、learner は含まれない。

## 候補者の認識が古い場合

コメントは逆のケースにも触れている。「候補者の構成も古いかもしれないが、その場合は選挙に勝てない」。

候補者が古い構成を持っていて、既に削除されたノードに投票要求を送ったとする。そのノードが投票しても、**現在の構成での過半数** には届かない。現在の voter たちは候補者のログが古いと判断するか、そもそも投票要求を受けても現在の構成で数えるので、票が足りない。

つまり **「余分に投票してもらう」ことは安全で、「投票を拒む」ことが危険** という非対称がある。だから寛容な側に倒す。

コメントが参照している etcd の issue は、この非対称が成り立たなくなるバグの議論だ。安全性が「候補者が古い構成で勝てないこと」に依存しているので、そこが崩れると前提も崩れる、と注意している。

## 立候補はできない

投票はできるが、立候補はできない ([`raft.go#L1944-L1949`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1944-L1949))。

```go title="raft.go"
// promotable indicates whether state machine can be promoted to leader,
// which is true when its own id is in progress list.
func (r *raft) promotable() bool {
	pr := r.trk.Progress[r.id]
	return pr != nil && !pr.IsLearner && !r.raftLog.hasNextOrInProgressSnapshot()
}
```

`!pr.IsLearner` が入っている。この非対称にも理由がある。

- **投票**: 相手からの要求がある。相手の認識という外部情報が使える。誤って投票しても、候補者が正しく勝てるだけ。
- **立候補**: 自発的な行動。自分の認識しか根拠がない。誤って立候補すると、正しいリーダーを降ろす害がある。

**外部から促されたときは寛容に、自発的に動くときは保守的に** という切り分けになっている。

`tickElection` も `promotable()` を見るので、learner は選挙タイムアウトしても立候補しない ([`raft.go#L850-L860`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L850-L860))。

同じ理由で、learner へのリーダー移譲も拒否される ([`raft.go#L1637-L1640`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1637-L1640))。

```go title="raft.go"
		if pr.IsLearner {
			r.logger.Debugf("%x is learner. Ignored transferring leadership", r.id)
			return nil
		}
```

こちらはリーダー側の判断で、リーダーの構成は最新のはずなので、learner だと分かっているなら移譲しない。

## 回帰テストとして残っている

この挙動には専用の datadriven テストがある ([`testdata/campaign_learner_must_vote.txt`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/testdata/campaign_learner_must_vote.txt))。

```text title="testdata/campaign_learner_must_vote.txt"
# Regression test that verifies that learners can vote. This holds only in the
# sense that if a learner is asked to vote, a candidate believes that they are a
# voter based on its current config, which may be more recent than that of the
# learner. If learners which are actually voters but don't know it yet don't
# vote in that situation, the raft group may end up unavailable despite a quorum
# of voters (as of the latest config) being available.
#
# See:
# https://github.com/etcd-io/etcd/pull/10998

# Bootstrap three nodes.
add-nodes 3 voters=(1,2) learners=(3) index=2
```

**テストファイルの冒頭コメントが、この挙動が必要な理由の説明そのものになっている**。テキスト形式のテストなので、シナリオの説明を自然言語で長く書ける。実装のコメントと同じ内容が、テスト側にも独立して残されている。

このテストの本体は、「構成変更を learner に届けないまま進める」ためにメッセージの配送を手で制御している。特定のノードにだけメッセージを届ける、という操作がテキストで書けるのは、[datadriven テスト](../datadriven-tests/) の形式のおかげだ。

## 同じ構造の問題

「構成の認識がずれる」ことに由来する問題は、他にもある。

**構成変更の検証が best-effort になる**。提案時の検証は現在の構成に対して行われるが、その構成が最新とは限らない ([`raft.go#L258-L279`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L258-L279))。

```go title="raft.go"
	// DisableConfChangeValidation turns off propose-time verification of
	// configuration changes against the currently active configuration of the
	// raft instance. These checks are generally sensible (cannot leave a joint
	// config unless in a joint config, et cetera) but they have false positives
	// because the active configuration may not be the most recent
	// configuration. This is because configurations are activated during log
	// application, and even the leader can trail log application by an
	// unbounded number of entries.
	// Symmetrically, the mechanism has false negatives - because the check may
	// not run against the "actual" config that will be the predecessor of the
	// newly proposed one, the check may pass but the new config may be invalid
	// when it is being applied. In other words, the checks are best-effort.
```

**偽陽性と偽陰性が両方ある** と明記されている。構成は適用時に有効になるので ([メンバー変更のページ](../membership-basics/))、リーダーですら「今後有効になる構成」を正確には知らない。

**スナップショットの受け入れ判定でも同じ**。受け取ったスナップショットの構成に自分が含まれていない場合、それを捨てる ([`raft.go#L1884-L1910`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1884-L1910))。

```go title="raft.go"
	// More defense-in-depth: throw away snapshot if recipient is not in the
	// config. This shouldn't ever happen (at the time of writing) but lots of
	// code here and there assumes that r.id is in the progress tracker.
```

こちらは逆方向で、「相手が送ってきた構成に自分がいないなら受け取らない」。投票の場合と判断が逆になっているのは、スナップショットの適用が自分の状態を大きく変える操作だからだろう。**受け入れる副作用の大きさによって、寛容さの向きを変えている**。

## なぜそうなっているか

Raft の構成変更は、ログを通じて伝播する。つまり **構成の知識そのものが複製の対象** であり、複製には遅延がある。

この自己参照的な構造が、「自分の役割を自分で判断できない」状況を生む。ノードは自分が voter かどうかを、自分のログからしか知れない。そのログが古ければ、判断も古い。

解決の方向は 2 つある。

1. 構成の伝播を待ってから有効にする。ただし、待っている間に止まる場合がある (今回の場面)。
2. 他者の認識を受け入れる。ただし、他者の認識も古いかもしれない。

`etcd-io/raft` は 2 を選び、「他者の認識が古い場合は結果的に無害」という論証で正当化している。**安全側がどちら向きかを見極めて、寛容にできる方向を選ぶ** という判断になっている。

## どう活かすか

- **自分のメタデータが古いかもしれないことを前提にする**。分散システムで「自分の役割」「自分の権限」を自分のローカル状態だけで判断すると、伝播遅延で詰まる。
- **要求が届いたこと自体を情報として使う**。「相手は私をこう認識している」という事実は、自分のローカル状態より新しいことがある。
- **寛容さの向きを、誤りの害の非対称性で決める**。「余分にやって害がないか」「やらないと止まるか」を比べる。今回は「余分な投票は無害、投票しないと停止」なので寛容側に倒れた。
- **自発的な行動と、促された行動を分ける**。外部からの要求に応じるときは寛容に、自分から動くときは保守的に。learner が投票できて立候補できないのはこの区別による。
- **検証が best-effort であることを認めて、そう書く**。偽陽性も偽陰性もある検証を「正しい検証」として売ると誤解を招く。`DisableConfChangeValidation` のコメントは、限界を先に述べている。
