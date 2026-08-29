---
title: "投票する前に「勝てるか」を聞いて回ると、復帰したノードが任期を吊り上げなくなる"
description: "分断されていたノードは、復帰時に大きな任期で立候補してリーダーを降ろす。勝てないと分かっているのに、である。PreVote は「任期を上げずに、上げたとしたら勝てるかを聞く」という 1 往復を挟むことでこれを防ぐ。任期を上げないまま未来の任期の投票を集めるために、応答の任期をどう選ぶかが要点になる。"
group: "選挙の工夫"
sidebar:
  order: 15
---

## 何を学んだか

**「実際に状態を変える前に、変えたとしたらどうなるかを問い合わせる」** という 1 往復を足すと、無駄な状態変更を消せる。`etcd-io/raft` の PreVote は、任期を上げずに「もし任期 T+1 で立候補したら投票してくれるか」を聞いて回り、過半数が賛成したときだけ本当に任期を上げる。

実装上の要点は、**任期を上げないまま、未来の任期についての投票をやり取りする** ことだ。「大きい任期を見たら降りる」という Raft の基本規則に例外を作らなければならず、その例外がメッセージの任期の付け方に現れる。

## 解いている問題

[安全性のページ](../safety/) の最後で触れた状況を再掲する。

```
分断中:
  S1 S2 S3 (多数派、任期 5 でリーダーは S1、index 100 まで進行)
  S4       (少数派、選挙タイムアウトを繰り返して任期 20 まで空回り、index 10 のまま)

S4 が復帰:
  任期 21 で MsgVote を送る
  → S1, S2, S3 は「大きい任期を見たら降りる」規則で任期を 21 に上げ、フォロワーになる
  → S4 の投票要求自体は isUpToDate で拒否される (ログが古いので)
  → S4 は勝てない。だが S1 はもうリーダーではない
  → 新たに選挙が起き、その間クラスタは書き込みを受け付けられない
```

安全性は壊れていない。しかし **何も悪いことをしていないクラスタが、勝ち目のないノードの復帰だけで一時停止する**。分断が繰り返し起きる環境では、これが継続的な可用性の低下になる。

原因は、任期の吊り上げが **勝敗の判定より先に起きる** ことにある。S4 は「自分は勝てない」ことを、任期を上げてしまった後にしか知れない。

## ソースコードのどこか

設定は 1 つのフラグだ ([`raft.go#L229-L232`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L229-L232))。

```go title="raft.go"
	// PreVote enables the Pre-Vote algorithm described in raft thesis section
	// 9.6. This prevents disruption when a node that has been partitioned away
	// rejoins the cluster.
	PreVote bool
```

有効にすると、選挙が 2 段階になる ([`raft.go#L1189-L1194`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1189-L1194))。

```go title="raft.go"
	case pb.MsgHup:
		if r.preVote {
			r.hup(campaignPreElection)
		} else {
			r.hup(campaignElection)
		}
```

第 1 段階が `campaignPreElection`、第 2 段階が `campaignElection` になる ([`raft.go#L72-L82`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L72-L82))。

```go title="raft.go"
const (
	// campaignPreElection represents the first phase of a normal election when
	// Config.PreVote is true.
	campaignPreElection CampaignType = "CampaignPreElection"
	// campaignElection represents a normal (time-based) election (the second phase
	// of the election when Config.PreVote is true).
	campaignElection CampaignType = "CampaignElection"
	// campaignTransfer represents the type of leader transfer
	campaignTransfer CampaignType = "CampaignTransfer"
)
```

### 状態を変えない役割

`becomePreCandidate` が、`becomeCandidate` と決定的に違う ([`raft.go#L917-L931`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L917-L931))。

```go title="raft.go"
func (r *raft) becomePreCandidate() {
	if r.state == StateLeader {
		panic("invalid transition [leader -> pre-candidate]")
	}
	// Becoming a pre-candidate changes our step functions and state,
	// but doesn't change anything else. In particular it does not increase
	// r.Term or change r.Vote.
	r.step = stepCandidate
	r.trk.ResetVotes()
	r.tick = r.tickElection
	r.lead = None
	r.state = StatePreCandidate
	r.logger.Infof("%x became pre-candidate at term %d", r.id, r.Term)
}
```

`r.reset()` を呼んでいない。任期も投票先も変わらない。**永続化すべき状態が何も変わらないので、ディスク書き込みが発生しない**。これが PreVote の安さの理由でもある。

送信側は、任期フィールドに `r.Term + 1` を入れる ([`raft.go#L1030-L1039`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1030-L1039))。

```go title="raft.go"
	if t == campaignPreElection {
		r.becomePreCandidate()
		voteMsg = pb.MsgPreVote
		// PreVote RPCs are sent for the next term before we've incremented r.Term.
		term = r.Term + 1
	} else {
		r.becomeCandidate()
		voteMsg = pb.MsgVote
		term = r.Term
	}
```

自分の任期は上げないまま、メッセージには次の任期を載せる。**メッセージの任期が「自分の任期」ではなくなる** のが、PreVote の全ての複雑さの源になる。

### 受け取った側は任期を上げない

`Step` の任期処理に例外が入る ([`raft.go#L1121-L1131`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1121-L1131))。

```go title="raft.go"
		switch {
		case m.GetType() == pb.MsgPreVote:
			// Never change our term in response to a PreVote
		case m.GetType() == pb.MsgPreVoteResp && !m.GetReject():
			// We send pre-vote requests with a term in our future. If the
			// pre-vote is granted, we will increment our term when we get a
			// quorum. If it is not, the term comes from the node that
			// rejected our vote so we should become a follower at the new
			// term.
		default:
			// ... becomeFollower(m.GetTerm(), ...)
		}
```

2 つの例外がある。

**`MsgPreVote` を受けても任期を上げない**。上げてしまうと、PreVote の目的そのものが達成できない。

**賛成の `MsgPreVoteResp` を受けても任期を上げない**。この応答には未来の任期が入っているが、まだ過半数が揃っていないかもしれない。揃った時点で `campaign(campaignElection)` に進み、そこで `becomeCandidate` が任期を上げる。

一方、**拒否の `MsgPreVoteResp` は任期を上げる**。拒否側は自分の実際の任期を載せてくるので、それが自分より大きければ、素直に降りるべき情報になる。賛成と拒否で扱いが違うのは、載っている任期の意味が違うからだ。

### 応答の任期をどう選ぶか

賛成の応答を返すとき、**受け取ったメッセージの任期をそのまま返す** ([`raft.go#L1240-L1248`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1240-L1248))。

```go title="raft.go"
			// When responding to Msg{Pre,}Vote messages we include the term
			// from the message, not the local term. To see why, consider the
			// case where a single node was previously partitioned away and
			// it's local term is now out of date. If we include the local term
			// (recall that for pre-votes we don't update the local term), the
			// (pre-)campaigning node on the other end will proceed to ignore
			// the message (it ignores all out of date messages).
			// The term in the original message and current local term are the
			// same in the case of regular votes, but different for pre-votes.
			r.send(&pb.Message{To: m.From, Term: m.Term, Type: voteRespMsgType(m.GetType()).Enum()})
```

`Term: m.Term` であって `r.Term` ではない。

理由はこうだ。PreVote に賛成した側は任期を上げていないので、`r.Term` は候補者が期待している `T+1` より小さい。それを返すと、候補者側の `Step` が「小さい任期のメッセージ」として無視してしまう。**自分の賛成票が自分に届かない**。

だから、聞かれた任期をそのまま返す。普通の投票では両者が一致するので、この行は PreVote のためだけにある。

拒否の場合は自分の任期を返す ([`raft.go#L1250-L1253`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1250-L1253))。

```go title="raft.go"
			r.send(&pb.Message{To: m.From, Term: new(r.Term), Type: voteRespMsgType(m.GetType()).Enum(), Reject: new(true)})
```

こちらは「私の任期はこれです」を伝えることに意味がある。候補者はそれを見て降りられる。

### 投票条件の 3 つ目

[任期とリーダー選挙のページ](../term-and-election/) で保留した条件がここで回収される。

```go title="raft.go"
		canVote := r.Vote == m.GetFrom() ||
			(r.Vote == None && r.lead == None) ||
			// ...or this is a PreVote for a future term...
			(m.GetType() == pb.MsgPreVote && m.GetTerm() > r.Term)
```

**未来の任期についての PreVote なら、既に投票済みでも賛成できる**。

任期 5 で S2 に投票済みのノードが、任期 6 についての PreVote を受けたとする。任期 6 ではまだ誰にも投票していないので、賛成して構わない。PreVote は実際の投票ではないので、この賛成が「1 任期 1 票」を破ることもない。

この条件がないと、任期 5 で投票済みのノードが多数を占めた状態で、任期 6 の PreVote が誰にも賛成されず、クラスタが選挙を始められなくなる。

### 古い任期の PreVote には返事をする

`Step` の「小さい任期は無視」の側にも、PreVote 専用の分岐がある ([`raft.go#L1145-L1153`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1145-L1153))。

```go title="raft.go"
		} else if m.GetType() == pb.MsgPreVote {
			// Before Pre-Vote enable, there may have candidate with higher term,
			// but less log. After update to Pre-Vote, the cluster may deadlock if
			// we drop messages with a lower term.
			last := r.raftLog.lastEntryID()
			r.logger.Infof("%x [logterm: %d, index: %d, vote: %x] rejected %s from %x [logterm: %d, index: %d] at term %d",
				r.id, last.term, last.index, r.Vote, m.GetType(), m.GetFrom(), m.GetLogTerm(), m.GetIndex(), r.Term)
			r.send(&pb.Message{To: m.From, Term: new(r.Term), Type: pb.MsgPreVoteResp.Enum(), Reject: new(true)})
		}
```

普通なら小さい任期のメッセージは黙って捨てる。PreVote だけは **拒否の返事を返す**。

コメントが理由を説明している。PreVote を有効にする前に、任期だけが大きくてログが短いノードが生まれていることがある。そのノードは PreVote を送っても、大きい任期を持つ他のノードから何も返ってこない。自分の任期が古いことに気づけず、永久に空回りする。拒否の返事に自分の任期を載せて返すことで、そのノードが追いつける。

**機能を後から有効にしたときの移行期間** を考慮した分岐になっている。

## 2 段階の流れ

まとめるとこうなる。

```
選挙タイムアウト
     │
     ▼
 becomePreCandidate  (任期はそのまま T、ディスク書き込みなし)
     │
     ├─ MsgPreVote(term=T+1, lastLogID) を全員に送る
     │
     ├── 過半数が賛成 ────► campaign(campaignElection)
     │                          │
     │                          ▼
     │                    becomeCandidate (任期を T+1 に上げる、ここで初めて永続化)
     │                          │
     │                          └─ MsgVote(term=T+1) を全員に送る → 通常の選挙
     │
     └── 過半数が拒否 ────► becomeFollower(r.Term, None)
                              (任期は T のまま。クラスタに影響なし)
```

分断から復帰した S4 は、PreVote の段階で拒否される。ログが古いので `isUpToDate` に落ちるからだ。**任期は上がらず、S1〜S3 は何も気づかない**。

## テストで確認できる形

`testdata/prevote.txt` にこの流れがそのまま書かれている。PreVote と CheckQuorum を組み合わせた `prevote_checkquorum.txt` もあり、両方を有効にしたときの相互作用が確認できる。

datadriven テストなので、「どのノードにメッセージを届けるか」を手で制御して分断を作れる。[datadriven テストのページ](../datadriven-tests/) で扱う。

## なぜそうなっているか

### 状態変更を「聞いてから」にする

PreVote の本質は、**取り消せない状態変更 (任期の増加) の前に、取り消せる問い合わせを挟む** ことだ。

任期の増加は永続化を伴い、クラスタ全体に伝播し、リーダーを降ろす。取り消しがきかない。一方 PreVote は、誰の状態も変えないので、失敗しても何も起きない。

コストは 1 往復ぶんのレイテンシだ。正常な選挙も 2 往復になる。ただし選挙は稀にしか起きないので、この追加コストは実際には問題にならない。

### リーダー移譲では PreVote を使わない

例外が 1 か所ある ([`raft.go#L1746-L1752`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1746-L1752))。

```go title="raft.go"
	case pb.MsgTimeoutNow:
		r.logger.Infof("%x [term %d] received MsgTimeoutNow from %x and starts an election to get leadership.", r.id, r.Term, m.GetFrom())
		// Leadership transfers never use pre-vote even if r.preVote is true; we
		// know we are not recovering from a partition so there is no need for the
		// extra round trip.
		r.hup(campaignTransfer)
```

リーダーから「今すぐ立候補しろ」と言われた場合、分断からの復帰ではないことが分かっている。PreVote を挟む理由がないので、1 往復ぶん節約する。**問い合わせを省ける条件が分かっているなら省く** という判断だ。[リーダー移譲のページ](../leader-transfer/) で扱う。

## どう活かすか

- **取り消せない操作の前に、取り消せる問い合わせを挟む**。分散システムに限らず、2 相コミット、楽観ロックの事前検査、リソース確保の事前見積もりなど、同じ形が繰り返し現れる。
- **問い合わせの段階では状態を変えない**。`becomePreCandidate` が `reset()` を呼ばないことがこれを保証している。「ほとんど変えない」ではなく「全く変えない」にすると、失敗時の巻き戻しが要らない。
- **仮の状態についてのやり取りでは、「誰の視点の値か」を明示する**。応答に自分の任期を入れるか、聞かれた任期を入れるかで挙動が変わる。この手の設計では、フィールドの意味を「送信者の現在値」と「問い合わせ対象の値」で分けて考える必要がある。
- **機能を後から有効にする移行期間を考える**。古い挙動のノードが混ざったときに詰まらないか。`MsgPreVote` に拒否の返事を返す分岐は、そのためだけに存在している。
- **問い合わせを省ける条件があるなら省く**。リーダー移譲のように、既に情報が揃っているなら 1 往復を減らせる。
