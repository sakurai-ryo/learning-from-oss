---
title: "不変条件を壊さずに voter を learner へ降格するために、意図を別の集合に置く"
description: "「learner と voter は交差しない」という不変条件は、役割の判断を単純にする代わりに、joint 状態での降格を表現できなくする。etcd-io/raft は「今そうする」ではなく「joint を抜けたらそうする」という意図を LearnersNext という別の集合に置くことで、不変条件を保ったまま降格を表現している。"
group: "読み取りと構成変更"
sidebar:
  order: 29
---

## 何を学んだか

**不変条件を守れない操作は、「今の状態」ではなく「予約された未来」として表す。** `etcd-io/raft` は「learner の集合と voter の集合は交差しない」という不変条件を置いている。役割の判断が単純になるからだ。

ところが joint consensus 中に voter を learner に降格しようとすると、この不変条件が破れる。旧構成では voter のままでなければならず、新構成では learner でなければならないからだ。

解決は、**`LearnersNext` という 3 つ目の集合を用意し、「joint を抜けたら learner にする」という意図だけを置く** ことだった。現在の役割は voter のまま、不変条件は保たれる。

## 不変条件とその理由

`tracker.Config` のコメントが不変条件を宣言している ([`tracker/tracker.go#L33-L42`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/tracker.go#L33-L42))。

```go title="tracker/tracker.go"
	// Learners is a set of IDs corresponding to the learners active in the
	// current configuration.
	//
	// Invariant: Learners and Voters does not intersect, i.e. if a peer is in
	// either half of the joint config, it can't be a learner; if it is a
	// learner it can't be in either half of the joint config. This invariant
	// simplifies the implementation since it allows peers to have clarity about
	// its current role without taking into account joint consensus.
	Learners map[uint64]struct{}
```

理由が明記されている。**「ノードが joint consensus を考慮せずに自分の現在の役割を把握できるようになるから」**。

この不変条件があると、`Progress.IsLearner` を見るだけで役割が分かる。joint の左右どちらに属するか、両方に属するか、といった場合分けが要らない。[learner も投票するページ](../learner-must-vote/) で見た `promotable()` も、`!pr.IsLearner` の 1 項で済んでいる。

## 破れる場面

コメントが続けて、この不変条件が問題になる場面を図で示す ([`tracker/tracker.go#L43-L76`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/tracker.go#L43-L76))。

```go title="tracker/tracker.go"
	// When we turn a voter into a learner during a joint consensus transition,
	// we cannot add the learner directly when entering the joint state. This is
	// because this would violate the invariant that the intersection of
	// voters and learners is empty. For example, assume a Voter is removed and
	// immediately re-added as a learner (or in other words, it is demoted):
	//
	// Initially, the configuration will be
	//
	//   voters:   {1 2 3}
	//   learners: {}
	//
	// and we want to demote 3. Entering the joint configuration, we naively get
	//
	//   voters:   {1 2} & {1 2 3}
	//   learners: {3}
	//
	// but this violates the invariant (3 is both voter and learner). Instead,
	// we get
	//
	//   voters:   {1 2} & {1 2 3}
	//   learners: {}
	//   next_learners: {3}
	//
	// Where 3 is now still purely a voter, but we are remembering the intention
	// to make it a learner upon transitioning into the final configuration:
	//
	//   voters:   {1 2}
	//   learners: {3}
	//   next_learners: {}
```

joint 中の 3 は、**旧構成 (右側) では voter でなければならない**。旧構成での過半数の計算に参加する必要があるからだ。同時に、新構成では learner になる予定でもある。

素朴に `learners: {3}` とすると、3 は voter かつ learner になる。不変条件が破れる。

`LearnersNext` に置けば、3 は今のところ純粋に voter で、「joint を抜けたら learner にする」という意図だけが記録される。

3 つの状態の遷移をまとめるとこうなる。

```
              voters              learners   learners_next
 開始         {1 2 3}             {}         {}
 joint 中     {1 2} && {1 2 3}    {}         {3}
 joint 後     {1 2}               {3}        {}
```

## 実装

降格の処理が `makeLearner` にある ([`confchange/confchange.go#L190-L229`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L190-L229))。

```go title="confchange/confchange.go"
// makeLearner makes the given ID a learner or stages it to be a learner once
// an active joint configuration is exited.
//
// The former happens when the peer is not a part of the outgoing config, in
// which case we either add a new learner or demote a voter in the incoming
// config.
//
// The latter case occurs when the configuration is joint and the peer is a
// voter in the outgoing config. In that case, we do not want to add the peer
// as a learner because then we'd have to track a peer as a voter and learner
// simultaneously. Instead, we add the learner to LearnersNext, so that it will
// be added to Learners the moment the outgoing config is removed by
// LeaveJoint().
func (c Changer) makeLearner(cfg *tracker.Config, trk tracker.ProgressMap, id uint64) {
	pr := trk[id]
	if pr == nil {
		c.initProgress(cfg, trk, id, true /* isLearner */)
		return
	}
	if pr.IsLearner {
		return
	}
	// Remove any existing voter in the incoming config...
	c.remove(cfg, trk, id)
	// ... but save the Progress.
	trk[id] = pr
	// Use LearnersNext if we can't add the learner to Learners directly, i.e.
	// if the peer is still tracked as a voter in the outgoing config. It will
	// be turned into a learner in LeaveJoint().
	//
	// Otherwise, add a regular learner right away.
	if _, onRight := outgoing(cfg.Voters)[id]; onRight {
		nilAwareAdd(&cfg.LearnersNext, id)
	} else {
		pr.IsLearner = true
		nilAwareAdd(&cfg.Learners, id)
	}
}
```

分岐は 1 か所、**「旧構成 (右側) に残っているか」** だけだ。残っていれば `LearnersNext`、残っていなければ `Learners`。

その前に `c.remove()` を呼んで、いったん削除してから `Progress` を戻している。`remove` は「旧構成に残っていれば `Progress` を消さない」という判断をするので ([`confchange/confchange.go#L231-L245`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L231-L245))、この呼び分けが要る。

```go title="confchange/confchange.go"
// remove this peer as a voter or learner from the incoming config.
func (c Changer) remove(cfg *tracker.Config, trk tracker.ProgressMap, id uint64) {
	if _, ok := trk[id]; !ok {
		return
	}

	delete(incoming(cfg.Voters), id)
	nilAwareDelete(&cfg.Learners, id)
	nilAwareDelete(&cfg.LearnersNext, id)

	// If the peer is still a voter in the outgoing config, keep the Progress.
	if _, onRight := outgoing(cfg.Voters)[id]; !onRight {
		delete(trk, id)
	}
}
```

**「incoming から消す」と「Progress を消す」を分けている**。旧構成にまだいるなら、複製も続けなければならないので `Progress` は残す。

意図が実現されるのは `LeaveJoint` の冒頭だ ([`confchange/confchange.go#L107-L112`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L107-L112))。

```go title="confchange/confchange.go"
	for id := range cfg.LearnersNext {
		nilAwareAdd(&cfg.Learners, id)
		trk[id].IsLearner = true
	}
	cfg.LearnersNext = nil
```

3 行で、予約が実状態になる。`LearnersNext` を空にするのを忘れないよう、直後に `nil` を代入している。

## 不変条件が検査されている

`checkInvariants` に、`LearnersNext` についての条件が 2 つある ([`confchange/confchange.go#L296-L306`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L296-L306))。

```go title="confchange/confchange.go"
	// Any staged learner was staged because it could not be directly added due
	// to a conflicting voter in the outgoing config.
	for id := range cfg.LearnersNext {
		if _, ok := outgoing(cfg.Voters)[id]; !ok {
			return fmt.Errorf("%d is in LearnersNext, but not Voters[1]", id)
		}
		if trk[id].IsLearner {
			return fmt.Errorf("%d is in LearnersNext, but is already marked as learner", id)
		}
	}
```

**`LearnersNext` に入る条件が、そのまま検査になっている**。「旧構成の voter であること」「まだ learner としてマークされていないこと」。この 2 つが `makeLearner` の分岐条件と対応している。

そして、`Learners` 側の検査で本来の不変条件が守られる ([`confchange/confchange.go#L307-L318`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L307-L318))。

```go title="confchange/confchange.go"
	// Conversely Learners and Voters doesn't intersect at all.
	for id := range cfg.Learners {
		if _, ok := outgoing(cfg.Voters)[id]; ok {
			return fmt.Errorf("%d is in Learners and Voters[1]", id)
		}
		if _, ok := incoming(cfg.Voters)[id]; ok {
			return fmt.Errorf("%d is in Learners and Voters[0]", id)
		}
		if !trk[id].IsLearner {
			return fmt.Errorf("%d is in Learners, but is not marked as learner", id)
		}
	}
```

joint の左右両方について交差がないことを確認し、さらに `Progress.IsLearner` との整合も見る。**集合とフラグの 2 つの表現が食い違わないこと** まで検査している。

`joint` でないときの検査も入っている。

```go title="confchange/confchange.go"
	if !joint(cfg) {
		// We enforce that empty maps are nil instead of zero.
		if outgoing(cfg.Voters) != nil {
			return fmt.Errorf("cfg.Voters[1] must be nil when not joint")
		}
		if cfg.LearnersNext != nil {
			return fmt.Errorf("cfg.LearnersNext must be nil when not joint")
		}
```

**joint でないのに `LearnersNext` があってはいけない**。予約は joint 中にしか存在しない。`LeaveJoint` で消し忘れたらここで落ちる。

## 直列化される表現にも現れる

`LearnersNext` は `ConfState` のフィールドになっている ([`raftpb/raft.proto#L162-L176`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raftpb/raft.proto#L162-L176))。

```protobuf title="raftpb/raft.proto"
message ConfState {
	// The voters in the incoming config. (If the configuration is not joint,
	// then the outgoing config is empty).
	repeated uint64 voters = 1;
	// The learners in the incoming config.
	repeated uint64 learners          = 2;
	// The voters in the outgoing config.
	repeated uint64 voters_outgoing   = 3;
	// The nodes that will become learners when the outgoing config is removed.
	// These nodes are necessarily currently in nodes_joint (or they would have
	// been added to the incoming config right away).
	repeated uint64 learners_next     = 4;
```

joint 状態のままスナップショットを取ることがあるので、この予約も永続化される。

そして [joint consensus のページ](../joint-consensus/) で見た `Restore` が、これを操作列に翻訳する ([`confchange/restore.go#L89-L97`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/restore.go#L89-L97))。

```go title="confchange/restore.go"
	// Same for LearnersNext; these are nodes we want to be learners but which
	// are currently voters in the outgoing config.
	for _, id := range cs.LearnersNext {
		in = append(in, &pb.ConfChangeSingle{
			Type:   pb.ConfChangeAddLearnerNode.Enum(),
			NodeId: new(id),
		})
	}
```

**`AddLearnerNode` として再生するだけ**。`LearnersNext` を復元する専用の処理はない。`makeLearner` の分岐が、旧構成に残っているノードを自動的に `LearnersNext` へ振り分ける。

復元コードが予約の概念を知らずに済んでいる。**同じ操作を再生すれば同じ状態に至る** という性質が、ここでも効いている。

## learner の追加では使わない

コメントの末尾に、`LearnersNext` を **使わない** 場合の説明もある。

```go title="tracker/tracker.go"
	// Note that next_learners is not used while adding a learner that is not
	// also a voter in the joint config. In this case, the learner is added
	// right away when entering the joint configuration, so that it is caught up
	// as soon as possible.
```

新しい learner を追加するだけなら、joint 中でも即座に `Learners` に入る。不変条件が破れないからだ。

そして理由が「できるだけ早く追いつかせるため」。予約にすると、joint を抜けるまで複製が始まらない。**不変条件を守るために必要な場合だけ予約にして、そうでなければ即座に反映する**。

## なぜそうなっているか

代替案は「不変条件を緩める」ことだ。voter かつ learner という状態を許し、判定側で場合分けする。

そうすると、`promotable()` も、`QuorumActive()` も、`Visit()` の呼び出し側も、「このノードは左では voter、右では learner」といった場合分けを持つことになる。**joint 状態を意識するコードが全体に散らばる**。

`LearnersNext` は、その散らばりを 3 か所に閉じ込めている。

1. `makeLearner` の分岐 (どちらに入れるか)
2. `LeaveJoint` の 3 行 (予約を実現する)
3. `checkInvariants` の検査 (整合性の確認)

これ以外の場所は、`Learners` と `Voters` が交差しないことを前提にできる。**「現在の状態」と「予約された未来」を型 (この場合は集合) で分けたことで、現在の状態を扱うコードが単純なままでいられる**。

## どう活かすか

- **不変条件を守れない中間状態は、予約として別の場所に置く**。「今そうである」と「後でそうする」を同じ集合で表そうとすると、不変条件を緩めることになる。緩めた分岐は全体に広がる。
- **不変条件を守ることの利益を明記する**。「この不変条件があるので、joint を意識せずに役割を判断できる」と書いてあると、緩めてよいかの判断ができる。
- **予約が実現される場所を 1 か所にする**。`LeaveJoint` の 3 行だけが予約を実状態に変える。散らばると、実現漏れが起きる。
- **予約の存在条件を不変条件として検査する**。「joint でないときは予約が空」「予約されたノードは旧構成にいる」を検査しておくと、実現漏れや誤った予約が即座に露見する。
- **予約が要らない場合は即座に反映する**。一律に予約にすると、不要な遅延が入る。「不変条件が破れる場合だけ」という条件で分ける。
- **複数の表現を持つなら、その整合も検査する**。集合 (`Learners`) とフラグ (`Progress.IsLearner`) の両方で役割を持つなら、両者が一致することを不変条件に含める。
