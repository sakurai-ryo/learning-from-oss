---
title: "メンバー変更は「過半数の定義が変わる」変更なので、新旧が重なる中間状態を挟む"
description: "クラスタにノードを足したり抜いたりするのがなぜ難しいのか。切り替えが一斉でないために、新旧の構成で互いに素な過半数ができ、リーダーが 2 人立ちうる。1 台ずつ変える方法と joint consensus の 2 つの解、そして etcd-io/raft が「構成は適用時に有効になる」「未適用の構成変更がある間は次を受け付けない」という 2 つの約束でこれを扱っていることを見る。"
group: "Raft を理解する"
sidebar:
  order: 8
---

前提編の最後は、クラスタの構成そのものを変える話だ。3 台のクラスタに 1 台足す、落ちたノードを別のノードに置き換える、といった操作を、サービスを止めずに行いたい。

## なぜ難しいのか

構成を変えるということは、**過半数の定義が変わる** ということだ。3 台なら 2 台、5 台なら 3 台。この定義が Raft の安全性の全部を支えているので、変更中に定義が食い違うと安全性が崩れる。

問題は、全ノードが同時に新しい構成に切り替わることを保証できない点にある。構成の情報もログエントリとして配られるので、届く時刻はノードごとにバラバラだ。

論文の図 10 がこの危険を示している。3 台 `{1,2,3}` から 5 台 `{1,2,3,4,5}` に変えるとき、切り替えのタイミングがずれると次が起きる。

```
時刻 t のノードごとの認識:

  ノード 1: 旧構成 {1,2,3} → 過半数は 2 台
  ノード 2: 旧構成 {1,2,3} → 過半数は 2 台
  ノード 3: 新構成 {1,2,3,4,5} → 過半数は 3 台
  ノード 4: 新構成 {1,2,3,4,5} → 過半数は 3 台
  ノード 5: 新構成 {1,2,3,4,5} → 過半数は 3 台

  ノード 1 は {1,2} の 2 票で「旧構成の過半数」を取り、リーダーになれる
  ノード 5 は {3,4,5} の 3 票で「新構成の過半数」を取り、リーダーになれる

  → 同じ任期にリーダーが 2 人
```

`{1,2}` と `{3,4,5}` は互いに素だ。**過半数の交差性が破れている**。安全性の議論の土台が抜けるので、コミット済みのエントリが失われうる。

## 解 1: 1 台ずつ変える

新旧の構成が **必ず重なる** ようにすればいい。1 回の変更で 1 台だけ足す/抜くなら、新旧の過半数は必ず 1 台以上を共有する。

```
{1,2,3} → {1,2,3,4}

旧の過半数は 2 台、新の過半数は 3 台。
2 + 3 = 5 > 4 なので、どの 2 台とどの 3 台を取っても必ず重なる。
```

一般に、`n` から `n+1` へ、あるいは `n` から `n-1` へなら、旧の過半数と新の過半数の合計が全体の台数を超えるので、必ず交差する。これが論文が最初に採った方法で、実装が単純になる。

制約は「1 台ずつしか変えられない」ことだ。3 台のうち 1 台を別のノードに置き換えたいときは、`{1,2,3}` → `{1,2,3,4}` → `{1,2,4}` の 2 段階になる。途中の 4 台構成は、耐えられる故障が 1 台のまま (4 台の過半数は 3) なので、耐障害性が上がらないまま台数だけ増えた状態を経由する。

## 解 2: joint consensus

論文が最終的に採ったもう 1 つの方法が **joint consensus** だ。新旧の構成の **両方** で過半数を要求する中間状態を挟む。

```
C_old = {1,2,3}
C_new = {1,2,4,5,6}

           ┌─────────────┐
C_old ───► │ C_old,new   │ ───► C_new
           │ 決定には    │
           │ {1,2,3} の  │
           │ 過半数 かつ │
           │ {1,2,4,5,6} │
           │ の過半数    │
           └─────────────┘
```

中間状態 `C_old,new` では、リーダーの選出もエントリのコミットも、**両方の構成で過半数を満たす** ことを要求する。この間、どちらか片方だけの過半数で決定することは起きないので、上の図 10 の状況は生じない。

joint consensus なら、1 回の操作で任意個のノードを入れ替えられる。3 台のクラスタの 1 台を別のノードに置き換える操作が、耐障害性を落とさずに 1 手で書ける。

`etcd-io/raft` は両方を実装している。`ConfChangeV2` に複数の変更を入れると joint consensus になり、1 つだけなら単純な変更として処理される。使い分けは `ConfChangeTransition` で指定する ([`raftpb/raft.proto#L141-L160`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raftpb/raft.proto#L141-L160))。

```protobuf title="raftpb/raft.proto"
enum ConfChangeTransition {
	// Automatically use the simple protocol if possible, otherwise fall back
	// to ConfChangeJointImplicit. Most applications will want to use this.
	ConfChangeTransitionAuto          = 0;
	// Use joint consensus unconditionally, and transition out of them
	// automatically (by proposing a zero configuration change).
	ConfChangeTransitionJointImplicit = 1;
	// Use joint consensus and remain in the joint configuration until the
	// application proposes a no-op configuration change. This is suitable for
	// applications that want to explicitly control the transitions, for example
	// to use a custom payload (via the Context field).
	ConfChangeTransitionJointExplicit = 2;
}
```

joint 状態を抜けるのを自動でやるか、利用側が明示的に指示するかを選べる。実装の詳細は [joint consensus のページ](../joint-consensus/) で扱う。

## 論文との相違点: いつ有効になるか

`etcd-io/raft` は、論文とは 1 点だけ意図的に違う選択をしている。README がそれを明記している。

> The key invariant that membership changes happen one node at a time is preserved, but in our implementation the membership change takes effect when its entry is applied, not when it is added to the log (so the entry is committed under the old membership instead of the new). This is equivalent in terms of safety, since the old and new configurations are guaranteed to overlap.

論文では、構成変更エントリは **ログに追加された瞬間** に有効になる。まだコミットされていなくても、そのノードは新しい構成で動き始める。`etcd-io/raft` では **適用された瞬間** に有効になる。

適用時にすると、構成変更エントリ自身は **旧構成のもとでコミットされる**。安全性が保たれるのは、新旧の構成が必ず重なることが保証されているからだ。

実装上の利点は大きい。追加時に有効化する方式だと、「ログに書いたが後で上書きされた構成変更」を巻き戻す処理が要る。適用時なら、適用は決して巻き戻らないので、そういう処理が要らない。

構成変更の適用は `Ready.CommittedEntries` に混ざって返ってきて、利用側が `ApplyConfChange` を呼ぶことで反映される ([`node.go#L180-L189`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/node.go#L180-L189))。

```go title="node.go"
	// ApplyConfChange applies a config change (previously passed to
	// ProposeConfChange) to the node. This must be called whenever a config
	// change is observed in Ready.CommittedEntries, except when the app decides
	// to reject the configuration change (i.e. treats it as a noop instead), in
	// which case it must not be called.
	//
	// Returns an opaque non-nil ConfState protobuf which must be recorded in
	// snapshots.
	ApplyConfChange(cc pb.ConfChangeI) *pb.ConfState
```

戻り値の `ConfState` を「スナップショットに記録しなければならない」と要求している。[スナップショットのページ](../snapshot/) で見た `conf_state` がこれだ。

## 同時に 2 つの構成変更を進めない

もう 1 つの約束が、**未コミットの構成変更がログにある間は、次の構成変更を受け付けない** ことだ。README がその理由を説明している。

> To ensure there is no attempt to commit two membership changes at once by matching log positions (which would be unsafe since they should have different quorum requirements), any proposed membership change is simply disallowed while any uncommitted change appears in the leader's log.

構成変更 A と B がログに並んでいると、A のコミットに必要な過半数と B のコミットに必要な過半数が違う。ログ位置の照合だけで両方をコミットしようとすると、どちらの定義で数えているのかが曖昧になる。だから禁じる。

実装は `pendingConfIndex` という 1 つの整数で行われている ([`raft.go#L356-L362`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L356-L362))。

```go title="raft.go"
	// Only one conf change may be pending (in the log, but not yet
	// applied) at a time. This is enforced via pendingConfIndex, which
	// is set to a value >= the log index of the latest pending
	// configuration change (if any). Config changes are only allowed to
	// be proposed if the leader's applied index is greater than this
	// value.
	pendingConfIndex uint64
```

提案時に検査される ([`raft.go#L1327-L1341`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1327-L1341))。

```go title="raft.go"
			if cc != nil {
				alreadyPending := r.pendingConfIndex > r.raftLog.applied
				alreadyJoint := len(r.trk.Config.Voters[1]) > 0
				wantsLeaveJoint := len(cc.AsV2().Changes) == 0

				var failedCheck string
				if alreadyPending {
					failedCheck = fmt.Sprintf("possible unapplied conf change at index %d (applied to %d)", r.pendingConfIndex, r.raftLog.applied)
				} else if alreadyJoint && !wantsLeaveJoint {
					failedCheck = "must transition out of joint config first"
				} else if !alreadyJoint && wantsLeaveJoint {
					failedCheck = "not in joint state; refusing empty conf change"
				}

				if failedCheck != "" && !r.disableConfChangeValidation {
					r.logger.Infof("%x ignoring conf change %s at config %s: %s", r.id, DescribeConfChange(cc), r.trk.Config, failedCheck)
					m.GetEntries()[i] = &pb.Entry{Type: pb.EntryNormal.Enum()}
```

検査に落ちた構成変更は、**エラーにせず、空の通常エントリに置き換える**。提案を拒否するとログ位置がずれて利用側の管理が面倒になるので、位置は保ったまま無害化する。

リーダーになったときの初期値は保守的に置かれる ([`raft.go#L950-L955`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L950-L955))。

```go title="raft.go"
	// Conservatively set the pendingConfIndex to the last index in the
	// log. There may or may not be a pending config change, but it's
	// safe to delay any future proposals until we commit all our
	// pending log entries, and scanning the entire tail of the log
	// could be expensive.
	r.pendingConfIndex = r.raftLog.lastIndex()
```

新しいリーダーは、自分のログの末尾に未適用の構成変更が含まれているかを知らない。全部走査すれば分かるが高くつく。そこで「末尾まで適用が追いつくまで構成変更を受け付けない」と倒す。少し保守的だが安全で、しかも判定が整数比較 1 回で済む。

立候補時にも同じ検査が入っている ([`raft.go#L995-L1023`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L995-L1023))。こちらは走査するが、ページングして一気にメモリを食わないようにしている。

```go title="raft.go"
	found := false
	// Scan all unapplied committed entries to find a config change. Paginate the
	// scan, to avoid a potentially unlimited memory spike.
	lo, hi := r.raftLog.applied+1, r.raftLog.committed+1
```

未適用の構成変更を持ったまま立候補すると、自分が把握していない構成のもとで選挙をすることになる。それを避けている。

## 2 台クラスタからの削除という罠

README がもう 1 つ、この設計の弱点を正直に書いている。

> This approach introduces a problem when removing a member from a two-member cluster: If one of the members dies before the other one receives the commit of the confchange entry, then the member cannot be removed any more since the cluster cannot make progress. For this reason it is highly recommended to use three or more nodes in every cluster.

2 台のクラスタから 1 台を抜くとき、構成変更のコミットが片方に届く前にもう片方が死ぬと、残った 1 台は身動きが取れなくなる。2 台構成の過半数は 2 台だからだ。

「だから 3 台以上にしてください」という結論になっている。**設計上の制約を隠さずドキュメントに書く** 姿勢がこのリポジトリらしい。

## learner という第 3 の役割

もう 1 つ、構成変更に関わる仕組みがある。**learner** (論文では non-voting member) だ。

新しいノードを足すとき、そのノードは最初、ログを何も持っていない。すぐに voter にすると、追いつくまでの間そのノードは投票にも複製にも実質的に貢献できない。それどころか、過半数の分母だけ増えるので **一時的に耐障害性が下がる**。

learner は、ログの複製は受けるが **投票権を持たない** メンバーだ。追いついてから voter に昇格させる。

```
{1,2,3} に 4 を足したい

  1) 4 を learner として追加  → 過半数は依然 {1,2,3} の 2 台
  2) 4 がログに追いつく
  3) 4 を voter に昇格         → 過半数は {1,2,3,4} の 3 台
```

`etcd-io/raft` では、learner は `Progress.IsLearner` と `tracker.Config.Learners` で表される。定足数の計算からは除外される ([`tracker/tracker.go#L208-L219`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/tracker.go#L208-L219))。

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

learner は立候補もできない。[スナップショットのページ](../snapshot/) で見た `promotable()` に `!pr.IsLearner` が入っていたのがそれだ。

ところが、**learner が投票しなければならない場合がある**。直感に反するが、これがないとクラスタが止まる状況が存在する。[learner も投票するページ](../learner-must-vote/) で扱う。

また、voter を learner に降格させる操作には、不変条件を壊さないための工夫が要る。[LearnersNext のページ](../learners-next/) で扱う。

## 前提編のまとめ

ここまでで Raft のアルゴリズムは一通り揃った。

| ページ                                       | 押さえたこと                                          |
| -------------------------------------------- | ----------------------------------------------------- |
| [複製状態機械](../replicated-state-machine/) | ログの一致が状態の一致になる。過半数の交差性          |
| [任期と選挙](../term-and-election/)          | 任期は論理時計。1 任期 1 票。大きい任期を見たら降りる |
| [ログ複製](../log-replication/)              | 直前 1 件の一致検査でログ全体の一致を維持する         |
| [コミット規則](../commit-rule/)              | 自分の任期のエントリしか数え上げでコミットしない      |
| [安全性](../safety/)                         | 選挙制限 + 過半数の交差 → Leader Completeness         |
| [永続化](../persistent-state/)               | 任期・投票・ログ。返答の前に書く                      |
| [スナップショット](../snapshot/)             | 状態のコピーで先頭を捨てる。作るのは利用側            |
| メンバー変更                                 | 新旧が重なる中間状態を挟む。適用時に有効化する        |

次の群からは、これを「I/O をしないライブラリ」としてどう組み立てているかに入る。
