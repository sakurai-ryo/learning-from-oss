---
title: "リーダーを降ろすのではなく渡す。渡す先に「今すぐ立候補しろ」と言う"
description: "計画的なリーダー交代を、選挙タイムアウトを待たずに行う仕組み。旧リーダーが提案の受付を止め、対象のログを追いつかせ、MsgTimeoutNow で立候補を促す。失敗したときに必ず元に戻るためのタイムアウトと、リースを突破するための特別扱い、そして関連する ForgetLeader / StepDownOnRemoval を読む。"
group: "選挙の工夫"
sidebar:
  order: 18
---

## 何を学んだか

**計画的な引き継ぎは、故障による交代とは別の経路で扱う。** ノードを保守で落とすとき、リーダーが死ぬのを待って選挙タイムアウトから復旧するのでは、数秒間書き込みが止まる。リーダー移譲は、旧リーダーが能動的に「あなたが次です」と指示することで、この停止時間をほぼゼロにする。

実装で効いているのは、**失敗したら必ず元に戻る** ように作られていることだ。移譲は成功しないことがある (対象が落ちている、追いつけない)。そのとき旧リーダーがリーダーのまま復帰できないと、計画的な操作が障害になってしまう。

## ソースコードのどこか

移譲の要求は `MsgTransferLeader` で、フォロワーが受けたらリーダーに転送される ([`raft.go#L1723-L1729`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1723-L1729))。

```go title="raft.go"
	case pb.MsgTransferLeader:
		if r.lead == None {
			r.logger.Infof("%x no leader at term %d; dropping leader transfer msg", r.id, r.Term)
			return nil
		}
		m.To = new(r.lead)
		r.send(m)
```

リーダー側の処理が本体になる ([`raft.go#L1636-L1665`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1636-L1665))。

```go title="raft.go"
	case pb.MsgTransferLeader:
		if pr.IsLearner {
			r.logger.Debugf("%x is learner. Ignored transferring leadership", r.id)
			return nil
		}
		leadTransferee := m.GetFrom()
		lastLeadTransferee := r.leadTransferee
		if lastLeadTransferee != None {
			if lastLeadTransferee == leadTransferee {
				r.logger.Infof("%x [term %d] transfer leadership to %x is in progress, ignores request to same node %x",
					r.id, r.Term, leadTransferee, leadTransferee)
				return nil
			}
			r.abortLeaderTransfer()
			r.logger.Infof("%x [term %d] abort previous transferring leadership to %x", r.id, r.Term, lastLeadTransferee)
		}
		if leadTransferee == r.id {
			r.logger.Debugf("%x is already leader. Ignored transferring leadership to self", r.id)
			return nil
		}
		// Transfer leadership to third party.
		r.logger.Infof("%x [term %d] starts to transfer leadership to %x", r.id, r.Term, leadTransferee)
		// Transfer leadership should be finished in one electionTimeout, so reset r.electionElapsed.
		r.electionElapsed = 0
		r.leadTransferee = leadTransferee
		if pr.Match == r.raftLog.lastIndex() {
			r.sendTimeoutNow(leadTransferee)
			r.logger.Infof("%x sends MsgTimeoutNow to %x immediately as %x already has up-to-date log", r.id, leadTransferee, leadTransferee)
		} else {
			r.sendAppend(leadTransferee)
		}
```

前半は入力の検証で、learner への移譲、同じ相手への重複要求、自分自身への移譲をそれぞれ弾く。異なる相手への要求が来たら、前の移譲を中止して新しい方を採る。

本体は最後の分岐だ。

- **対象のログが既に追いついている** (`pr.Match == lastIndex`) なら、即座に `MsgTimeoutNow` を送る。
- **追いついていない** なら、まず複製を送る。

追いつかせてから渡す理由は、[選挙制限](../safety/) にある。ログが古いノードは投票を集められないので、立候補させても負ける。

追いついた瞬間に `MsgTimeoutNow` が送られる ([`raft.go#L1572-L1576`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1572-L1576))。

```go title="raft.go"
				// Transfer leadership is in progress.
				if m.GetFrom() == r.leadTransferee && pr.Match == r.raftLog.lastIndex() {
					r.logger.Infof("%x sent MsgTimeoutNow to %x after received MsgAppResp", r.id, m.GetFrom())
					r.sendTimeoutNow(m.GetFrom())
				}
```

`MsgAppResp` の処理の中に埋まっている。複製が進むたびに「もう追いついたか」を見て、追いついたら次に進む。

## 提案を止める

移譲中は、新しい提案を受け付けない ([`raft.go#L1302-L1305`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1302-L1305))。

```go title="raft.go"
		if r.leadTransferee != None {
			r.logger.Debugf("%x [term %d] transfer leadership to %x is in progress; dropping proposal", r.id, r.Term, r.leadTransferee)
			return ErrProposalDropped
		}
```

止めないと、`pr.Match == r.raftLog.lastIndex()` が永久に成立しない可能性がある。新しいエントリが増え続けると、対象は追いつけない。**目標が動かないように固定する** ための措置になる。

`ErrProposalDropped` が返るので、利用側は「後で再試行してください」と応答できる。黙って捨てるのではなく、明示的なエラーになっている。

## 受け取った側は即座に立候補する

`MsgTimeoutNow` の処理 ([`raft.go#L1746-L1752`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1746-L1752))。

```go title="raft.go"
	case pb.MsgTimeoutNow:
		r.logger.Infof("%x [term %d] received MsgTimeoutNow from %x and starts an election to get leadership.", r.id, r.Term, m.GetFrom())
		// Leadership transfers never use pre-vote even if r.preVote is true; we
		// know we are not recovering from a partition so there is no need for the
		// extra round trip.
		r.hup(campaignTransfer)
```

選挙タイムアウトを待たずに立候補する。名前のとおり「タイムアウトが今起きたことにする」メッセージだ。

そして [PreVote](../prevote/) を使わない。分断からの復帰でないことが分かっているので、確認の往復を省く。

候補者と リーダーは `MsgTimeoutNow` を無視する ([`raft.go#L1715-L1716`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1715-L1716))。既にリーダーになっているか、選挙中なら、催促は不要だからだ。

## リースを突破する

[CheckQuorum のページ](../check-quorum-and-lease/) で見たリースが、ここで邪魔になる。旧リーダーがまだ生きているので、フォロワーは「最近リーダーから聞いた」状態にある。そのまま投票要求を送っても無視される。

そこで `campaignTransfer` という文脈が投票要求に載る ([`raft.go#L1065-L1069`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1065-L1069))。

```go title="raft.go"
		var ctx []byte
		if t == campaignTransfer {
			ctx = []byte(t)
		}
```

受け取った側はこれを見てリースを無視する ([`raft.go#L1103-L1105`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1103-L1105))。

```go title="raft.go"
			force := bytes.Equal(m.GetContext(), []byte(campaignTransfer))
			inLease := r.checkQuorum && r.lead != None && r.electionElapsed < r.electionTimeout
			if !force && inLease {
```

この抜け穴が安全なのは、**旧リーダー自身が移譲を指示したから** だ。旧リーダーは提案を止め、`leadTransferee` を設定した状態にある。実質的にリーダーとしての活動を停止している。

ただし、この文脈はメッセージのバイト列でしかない。悪意あるノードが同じ文脈を付けて投票を強制することは、技術的には可能だ。`etcd-io/raft` は Byzantine 障害を想定していないので、これは前提の範囲内になる。

## 失敗したら元に戻る

移譲が成功しないケースは多い。対象が落ちている、ネットワークが切れた、追いつけない。そのときのために、タイムアウトがある ([`raft.go#L873-L878`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L873-L878))。

```go title="raft.go"
		// If current leader cannot transfer leadership in electionTimeout, it becomes leader again.
		if r.state == StateLeader && r.leadTransferee != None {
			r.abortLeaderTransfer()
		}
```

`electionTimeout` 以内に完了しなければ、移譲を中止する。`leadTransferee` が `None` に戻り、提案の受付が再開する。

```go title="raft.go"
func (r *raft) abortLeaderTransfer() {
	r.leadTransferee = None
}
```

`electionElapsed = 0` を移譲開始時にリセットしていたのは、この期限を計るためだった。

中止の経路はもう 1 つある ([`raft.go#L2029-L2032`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L2029-L2032))。

```go title="raft.go"
	// If the leadTransferee was removed or demoted, abort the leadership transfer.
	if _, tOK := r.trk.Config.Voters.IDs()[r.leadTransferee]; !tOK && r.leadTransferee != 0 {
		r.abortLeaderTransfer()
	}
```

構成変更で対象が voter でなくなったら中止する。存在しない相手を待ち続けない。

`reset()` にも `abortLeaderTransfer()` があるので、任期が変わったときも自動的に消える。**中止の経路が 3 本あり、どれか 1 本でも通れば元に戻る**。

移譲中に auto-leave の構成変更が阻まれるケースについては、コメントに考察がある ([`raft.go#L748-L753`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L748-L753))。

```go title="raft.go"
		// NB: this proposal can't be dropped due to size, but can be
		// dropped if a leadership transfer is in progress. We'll keep
		// checking this condition on each applied entry, so either the
		// leadership transfer will succeed and the new leader will leave
		// the joint configuration, or the leadership transfer will fail,
		// and we will propose the config change on the next advance.
```

「移譲が成功すれば新リーダーが joint を抜ける、失敗すれば次の機会に自分が提案する」。どちらに転んでも進むことを確認している。**失敗しても止まらない** ことが、この機能全体の設計基準になっている。

## ForgetLeader: 反対側からの働きかけ

関連する機能に `ForgetLeader` がある ([`node.go#L191-L215`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/node.go#L191-L215))。

```go title="node.go"
	// ForgetLeader forgets a follower's current leader, changing it to None. It
	// remains a leaderless follower in the current term, without campaigning.
	//
	// This is useful with PreVote+CheckQuorum, where followers will normally not
	// grant pre-votes if they've heard from the leader in the past election
	// timeout interval. Leaderless followers can grant pre-votes immediately, so
	// if a quorum of followers have strong reason to believe the leader is dead
	// (for example via a side-channel or external failure detector) and forget it
	// then they can elect a new leader immediately, without waiting out the
	// election timeout.
```

リーダー移譲が「旧リーダーが指示する」のに対し、`ForgetLeader` は「フォロワーが自分で忘れる」。旧リーダーが既に死んでいて指示を出せない場合に使う。

コメントが具体例を出している。

```go title="node.go"
	// For example, consider a three-node cluster where 1 is the leader and 2+3
	// have just received a heartbeat from it. If 2 and 3 believe the leader has
	// now died (maybe they know that an orchestration system shut down 1's VM),
	// we can instruct 2 to forget the leader and 3 to campaign. 2 will then be
	// able to grant 3's pre-vote and elect 3 as leader immediately (normally 2
	// would reject the vote until an election timeout passes because it has heard
	// from the leader recently). However, 3 can not campaign unilaterally, a
	// quorum have to agree that the leader is dead, which avoids disrupting the
	// leader if individual nodes are wrong about it being dead.
```

**オーケストレーションシステムがリーダーの VM を落としたことを知っている**、という外部の情報を Raft に持ち込む口になっている。Raft 自身はハートビートの欠落でしか死を検知できないが、外側にはもっと速い情報源がある。

そして安全性の議論も付いている。1 台が勝手に忘れても選挙は起きない。過半数が忘れて初めて新リーダーが立つ。「個々のノードの誤判定でリーダーが降りることはない」。**外部の情報を受け入れつつ、それが間違っていても壊れない** ように設計されている。

実装は 5 行だ ([`raft.go#L1737-L1745`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1737-L1745))。

```go title="raft.go"
	case pb.MsgForgetLeader:
		if r.readOnly.option == ReadOnlyLeaseBased {
			r.logger.Error("ignoring MsgForgetLeader due to ReadOnlyLeaseBased")
			return nil
		}
		if r.lead != None {
			r.logger.Infof("%x forgetting leader %x at term %d", r.id, r.lead, r.Term)
			r.lead = None
		}
```

`r.lead = None` にするだけ。立候補はしない。それでも `inLease` の条件 (`r.lead != None`) が崩れるので、投票できるようになる。**1 つの条件式に含まれる項を落とすだけで、リースが切れる**。

## 構成から外れたリーダー

もう 1 つ関連する設定がある ([`raft.go#L282-L286`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L282-L286))。

```go title="raft.go"
	// StepDownOnRemoval makes the leader step down when it is removed from the
	// group or demoted to a learner.
	//
	// This behavior will become unconditional in the future. See:
	// https://github.com/etcd-io/raft/issues/83
	StepDownOnRemoval bool
```

自分をクラスタから外す構成変更を適用したリーダーが、そのままリーダーを続けるかどうか。既定では続ける (互換性のため) が、この設定で降りるようになる。「将来は無条件になる」と issue 番号付きで書かれている。

適用箇所にある TODO が、より良い実装案を残している ([`raft.go#L1997-L2007`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1997-L2007))。

```go title="raft.go"
	if (!ok || r.isLearner) && r.state == StateLeader {
		// This node is leader and was removed or demoted, step down if requested.
		//
		// TODO(tbg): ask follower with largest Match to TimeoutNow (to avoid
		// interruption). This might still drop some proposals but it's better than
		// nothing.
		if r.stepDownOnRemoval {
			r.becomeFollower(r.Term, None)
		}
		return cs
	}
```

「ただ降りる」のではなく「いちばん進んでいるフォロワーに `MsgTimeoutNow` を送ってから降りる」方が良い、と。**リーダー移譲の仕組みを、別の場面で再利用する** 案になっている。

## なぜそうなっているか

リーダーの交代には 2 種類ある。

|                  | 故障による交代            | 計画的な交代   |
| ---------------- | ------------------------- | -------------- |
| きっかけ         | ハートビートの欠落        | 外部からの指示 |
| 停止時間         | 選挙タイムアウト + 選挙   | 複製 + 選挙    |
| 旧リーダーの状態 | 死んでいる (かもしれない) | 生きている     |

計画的な交代では、旧リーダーが生きているという情報を使える。だから「対象を追いつかせる」「提案を止める」「リースを突破させる」という、故障時にはできない準備ができる。

この 3 つの準備で、停止時間が選挙 1 回分まで縮む。ローリングアップグレードやノードの入れ替えのように、**計画的にリーダーを動かす操作が日常的にある** 環境では、この差が効く。

## どう活かすか

- **計画的な操作と障害復旧を別の経路にする**。両方を同じ機構 (タイムアウト検知) で扱うと、計画的な操作まで遅くなる。外部からの指示を受け取る口を作る。
- **引き継ぎの前に、引き継ぎ先を準備する**。ログを追いつかせる、新しい要求を止める。準備が終わってから切り替える。
- **失敗しても必ず元に戻る**。中止の経路を複数用意し、どれか 1 本でも通れば復帰する。`etcd-io/raft` はタイムアウト、構成変更、任期変更の 3 本を持っている。
- **外部の情報源を受け入れる口を作る。ただし過半数の同意を要求する**。`ForgetLeader` は外部の障害検知を取り込むが、1 台の誤判定では何も起きない。外部情報を信じきらない設計にする。
- **より良い実装案を TODO として残す**。`ask follower with largest Match to TimeoutNow` のように、具体的な改善案を書いておくと、後から手を付けやすい。
