---
title: "リーダーが自分で過半数の生存を確認し、フォロワーは最近聞いた声を理由に投票を拒む"
description: "CheckQuorum は 2 つの規則の組み合わせで、片方はリーダー側、片方はフォロワー側にある。リーダーは電子的に孤立したら自分から降り、フォロワーはリーダーから最近聞いていれば投票要求を無視する。この 2 つが揃うとリーダーリースになり、読み取りの高速化にも使える。ただし時計のずれに依存する。"
group: "選挙の工夫"
sidebar:
  order: 16
---

## 何を学んだか

**「まだ生きているリーダーを降ろさない」を、リーダー側とフォロワー側の 2 つの規則で挟み撃ちにする。**

- **リーダー側 (CheckQuorum)**: 選挙タイムアウトの間、過半数から何も聞こえなければ、リーダーは自分から降りる。
- **フォロワー側 (リース)**: リーダーから最近何かを聞いていれば、投票要求を **任期の処理ごと無視する**。

2 つ目が Raft の基本規則 (「大きい任期を見たら降りる」) への例外なので、慎重な扱いが要る。そして 1 つ目がないと 2 つ目は危険になる — リーダーが実は死んでいる場合、誰も投票せずクラスタが止まるからだ。**片方だけでは成立しない対** になっている。

## ソースコードのどこか

設定は 1 つのフラグだが、効果が 2 か所に現れる ([`raft.go#L225-L228`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L225-L228))。

```go title="raft.go"
	// CheckQuorum specifies if the leader should check quorum activity. Leader
	// steps down when quorum is not active for an electionTimeout.
	CheckQuorum bool
```

### リーダー側: 自分から降りる

リーダーのタイマー処理から `MsgCheckQuorum` が発火する ([`raft.go#L862-L879`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L862-L879))。

```go title="raft.go"
func (r *raft) tickHeartbeat() {
	r.heartbeatElapsed++
	r.electionElapsed++

	if r.electionElapsed >= r.electionTimeout {
		r.electionElapsed = 0
		if r.checkQuorum {
			if err := r.Step(&pb.Message{From: new(r.id), Type: pb.MsgCheckQuorum.Enum()}); err != nil {
				r.logger.Debugf("error occurred during checking sending heartbeat: %v", err)
			}
		}
		// If current leader cannot transfer leadership in electionTimeout, it becomes leader again.
		if r.state == StateLeader && r.leadTransferee != None {
			r.abortLeaderTransfer()
		}
	}
```

**リーダーも `electionElapsed` を数えている** のが要点だ。フォロワーにとってこのカウンタは「リーダーから聞いていない時間」だが、リーダーにとっては「定足数を確認していない時間」になる。同じカウンタを役割ごとに違う意味で使い回している。

処理は `stepLeader` にある ([`raft.go#L1279-L1292`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1279-L1292))。

```go title="raft.go"
	case pb.MsgCheckQuorum:
		if !r.trk.QuorumActive() {
			r.logger.Warningf("%x stepped down to follower since quorum is not active", r.id)
			r.becomeFollower(r.Term, None)
		}
		// Mark everyone (but ourselves) as inactive in preparation for the next
		// CheckQuorum.
		r.trk.Visit(func(id uint64, pr *tracker.Progress) {
			if id != r.id {
				pr.RecentActive = false
			}
		})
		return nil
```

`RecentActive` を毎回リセットしているのが実装の肝だ。「直近の選挙タイムアウト 1 周期の間に何か聞こえたか」を、フラグ 1 つと定期的なリセットで表している。タイムスタンプを持って引き算する代わりに、**周期の境界でフラグを倒す** 方式になっている。メモリも計算も軽い。

`RecentActive` は、そのノードから何か届くたびに立つ ([`raft.go#L1385-L1387`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1385-L1387) など)。

```go title="raft.go"
	case pb.MsgAppResp:
		pr.RecentActive = true
```

判定は投票の集計を再利用している ([`tracker/tracker.go#L206-L219`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/tracker.go#L206-L219))。

```go title="tracker/tracker.go"
func (p *ProgressTracker) QuorumActive() bool {
	votes := map[uint64]bool{}
	p.Visit(func(id uint64, pr *Progress) {
		if pr.IsLearner {
			return
		}
		votes[id] = pr.RecentActive
	})

	return p.Voters.VoteResult(votes) == quorum.VoteWon
}
```

「生きているか」を票と見立てて `VoteResult` に渡している。**定足数の計算が 1 か所にまとまっている** ので、joint consensus の最中でも正しく動く。両方の構成で過半数が生きていることを要求する、という振る舞いが自動的に得られる。learner は除外される。

### フォロワー側: リースがある間は投票しない

もう 1 つの規則が `Step` の任期処理に入っている ([`raft.go#L1101-L1112`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1101-L1112))。

```go title="raft.go"
	case m.GetTerm() > r.Term:
		if m.GetType() == pb.MsgVote || m.GetType() == pb.MsgPreVote {
			force := bytes.Equal(m.GetContext(), []byte(campaignTransfer))
			inLease := r.checkQuorum && r.lead != None && r.electionElapsed < r.electionTimeout
			if !force && inLease {
				// If a server receives a RequestVote request within the minimum election timeout
				// of hearing from a current leader, it does not update its term or grant its vote
				last := r.raftLog.lastEntryID()
				r.logger.Infof("%x [logterm: %d, index: %d, vote: %x] ignored %s from %x [logterm: %d, index: %d] at term %d: lease is not expired (remaining ticks: %d)",
					r.id, last.term, last.index, r.Vote, m.GetType(), m.GetFrom(), m.GetLogTerm(), m.GetIndex(), r.Term, r.electionTimeout-r.electionElapsed)
				return nil
			}
		}
```

**任期を上げずに、投票要求そのものを捨てる**。これは Raft の基本規則への例外なので、条件が 3 つ重なっている。

- `r.checkQuorum`: CheckQuorum が有効。リーダー側の規則とセットでなければ危険。
- `r.lead != None`: リーダーを認識している。
- `r.electionElapsed < r.electionTimeout`: そのリーダーから最近聞いている。

ログメッセージに「残り何 tick でリースが切れるか」まで出している。この分岐に入ったことが運用上の異常に見えるので、判断材料を出しておく、という意図だろう。

これが [PreVote のページ](../prevote/) で見た問題を、別の角度から塞ぐ。復帰したノードが `MsgVote` を送っても、リーダーが生きている限り誰も任期を上げない。PreVote が「候補者側で気づく」なら、CheckQuorum は「投票者側で無視する」ことになる。

### 例外の例外: 移譲は強制する

`force` フラグがある。`campaignTransfer` という文脈が付いていれば、リースを無視して投票する。

```go title="raft.go"
			force := bytes.Equal(m.GetContext(), []byte(campaignTransfer))
```

これは、リーダー自身が「あなたに譲る」と指示した場合だ。この場合、旧リーダーは自分から降りているので、リースで守る理由がない。むしろ守ると移譲が失敗する。

送信側は `campaign` でこの文脈を載せる ([`raft.go#L1065-L1069`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1065-L1069))。

```go title="raft.go"
		var ctx []byte
		if t == campaignTransfer {
			ctx = []byte(t)
		}
```

`Context` は本来アプリケーション用の任意バイト列だが、ここでは内部の制御フラグとして使われている。

## 古い任期のメッセージへの返事

CheckQuorum を有効にすると、もう 1 か所、挙動が変わる ([`raft.go#L1133-L1157`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1133-L1157))。

```go title="raft.go"
	case m.GetTerm() < r.Term:
		if (r.checkQuorum || r.preVote) && (m.GetType() == pb.MsgHeartbeat || m.GetType() == pb.MsgApp) {
			// We have received messages from a leader at a lower term. It is possible
			// that these messages were simply delayed in the network, but this could
			// also mean that this node has advanced its term number during a network
			// partition, and it is now unable to either win an election or to rejoin
			// the majority on the old term. If checkQuorum is false, this will be
			// handled by incrementing term numbers in response to MsgVote with a
			// higher term, but if checkQuorum is true we may not advance the term on
			// MsgVote and must generate other messages to advance the term. The net
			// result of these two features is to minimize the disruption caused by
			// nodes that have been removed from the cluster's configuration: a
			// removed node will send MsgVotes (or MsgPreVotes) which will be ignored,
			// but it will not receive MsgApp or MsgHeartbeat, so it will not create
			// disruptive term increases, by notifying leader of this node's activeness
			// The above comments also true for Pre-Vote
			//
			// When follower gets isolated, it soon starts an election ending
			// up with a higher term than leader, although it won't receive enough
			// votes to win the election. When it regains connectivity, this response
			// with "pb.MsgAppResp" of higher term would force leader to step down.
			// However, this disruption is inevitable to free this stuck node with
			// fresh election. This can be prevented with Pre-Vote phase.
			r.send(&pb.Message{To: m.From, Type: pb.MsgAppResp.Enum()})
		}
```

古い任期のリーダーから `MsgApp` や `MsgHeartbeat` が来たら、**空の `MsgAppResp` を返す**。これは自分の (大きい) 任期を載せて返るので、リーダーはそれを見て降りる。

なぜこれが要るのか。CheckQuorum があると、`MsgVote` で任期を上げる経路が塞がれる。塞がれたままだと、任期が食い違ったノードがいつまでも合流できない。だから **別の経路で任期を伝える** 必要がある。

そしてコメントは、この設計が生む状況を 2 つに分けて説明している。

- **クラスタから削除されたノード**: `MsgVote` を送っても無視され、`MsgApp` も来ない (構成から外れているので)。だから任期を吊り上げる経路が両方塞がっている。混乱を起こさない。これが狙い。
- **孤立していたフォロワー**: 復帰すると `MsgApp` を受けるので、この応答でリーダーを降ろす。可用性は一時的に落ちるが、これは「詰まったノードを解放するために避けられない」。それが嫌なら PreVote を使え、と続く。

**塞ぎたい経路と、塞いではいけない経路を区別している**。削除されたノードは合流する必要がないので塞ぐ。孤立していたフォロワーは合流する必要があるので開ける。区別の基準が `MsgApp` を受け取るかどうか、つまり **リーダーの構成に入っているかどうか** になっている。

## リースベースの読み取り

CheckQuorum が揃うと、リーダーは「自分は一定期間リーダーであり続ける」と主張できる。これを読み取りに使うのが `ReadOnlyLeaseBased` だ ([`raft.go#L58-L71`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L58-L71))。

```go title="raft.go"
const (
	// ReadOnlySafe guarantees the linearizability of the read only request by
	// communicating with the quorum. It is the default and suggested option.
	ReadOnlySafe ReadOnlyOption = iota
	// ReadOnlyLeaseBased ensures linearizability of the read only request by
	// relying on the leader lease. It can be affected by clock drift.
	// If the clock drift is unbounded, leader might keep the lease longer than it
	// should (clock can move backward/pause without any bound). ReadIndex is not safe
	// in that case.
	ReadOnlyLeaseBased
)
```

`ReadOnlySafe` は読み取りのたびにハートビートを 1 往復させる。`ReadOnlyLeaseBased` はそれを省き、リーダーがローカルで即答する。速いが、**時計のずれに依存する**。

依存関係が設定検証で強制されている ([`raft.go#L336-L338`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L336-L338))。

```go title="raft.go"
	if c.ReadOnlyOption == ReadOnlyLeaseBased && !c.CheckQuorum {
		return errors.New("CheckQuorum must be enabled when ReadOnlyOption is ReadOnlyLeaseBased")
	}
```

CheckQuorum なしでリースベースの読み取りを使うと、既に降ろされたリーダーが古い値を返す。**設定の組み合わせに依存関係があるなら、起動時に落とす**。

リース方式の危険は、コメントが具体的に書いている。時計が止まったり巻き戻ったりすると、リーダーはリースを実際より長く保持していると誤認する。物理時計の単調性に依存しない `ReadOnlySafe` が既定になっているのはそのためだ。詳しくは [ReadIndex のページ](../read-index/) で扱う。

`ForgetLeader` もリースベースでは無効化される ([`raft.go#L1737-L1741`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1737-L1741))。

```go title="raft.go"
	case pb.MsgForgetLeader:
		if r.readOnly.option == ReadOnlyLeaseBased {
			r.logger.Error("ignoring MsgForgetLeader due to ReadOnlyLeaseBased")
			return nil
		}
```

リーダーを忘れるとリースが即座に切れる。旧リーダーがそれを知らないまま読み取りに答え続けると、線形化可能性が壊れる。この相互作用も設定の組み合わせとして扱われている。

## なぜそうなっているか

### 2 つの規則が対になっている理由

フォロワー側のリースだけを入れると、リーダーが本当に死んだときに誰も投票しなくなる。`r.lead != None` は保持されたままなので、リースが切れるまで待つことになる。実際には `electionElapsed` がタイムアウトすれば自分が立候補するので止まりはしないが、リーダーの死を検知する経路が 1 本になる。

リーダー側の CheckQuorum だけを入れると、孤立したリーダーが自分から降りるので、二重リーダーの期間が短くなる。ただし復帰ノードによる任期の吊り上げは防げない。

**両方あって初めて「生きているリーダーは降ろされない、死んだリーダーは速やかに降りる」が揃う**。だから 1 つのフラグで両方が有効になる設計になっている。

### PreVote との使い分け

PreVote と CheckQuorum は、同じ問題に別の角度から効く。

|             | 効き方                                             | 効かない場合                                      |
| ----------- | -------------------------------------------------- | ------------------------------------------------- |
| PreVote     | 候補者が自分で「勝てない」と気づいて立候補をやめる | ログが最新な復帰ノードには効かない (勝ててしまう) |
| CheckQuorum | 投票者がリーダーを認識している間は投票しない       | リーダーからの通信が届かないノードには効かない    |

両方を有効にするのが実運用での既定になる。両方有効時の相互作用を確認するテストも用意されている ([`testdata/prevote_checkquorum.txt`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/testdata/prevote_checkquorum.txt))。

## どう活かすか

- **「最近あったか」をタイムスタンプではなくフラグと周期リセットで表す**。`RecentActive` の方式は、時刻の取得も引き算も要らない。分解能は周期に等しくなるが、この用途ではそれで足りる。
- **生存判定を、既にある定足数の計算に載せる**。`QuorumActive` が `VoteResult` を再利用しているように、「過半数が満たすか」という形の判定は同じ関数に集約できる。構成変更への追随も自動的に得られる。
- **基本規則に例外を作るときは、条件を並べて明示する**。`inLease` の 3 条件と `force` は、例外の適用範囲を式として書き下したものになっている。
- **設定の組み合わせに依存関係があるなら起動時に落とす**。「A を有効にするなら B も必要」は、ドキュメントではなく `validate()` に書く。
- **塞ぐ経路と開ける経路を区別する**。あらゆる復帰を防ぐと、正当な復帰まで防いでしまう。`etcd-io/raft` は「リーダーの構成に入っているか」を基準にしている。
