---
title: "構成変更を「新旧両方の過半数が要る中間状態」として実装する"
description: "joint consensus の実装は confchange パッケージに切り出され、EnterJoint / LeaveJoint / Simple の 3 操作だけを提供する。どれも「複製してから変更し、前後で不変条件を検査する」形になっている。スナップショットからの構成復元も、専用のデシリアライザではなく同じ 3 操作の並びとして表現されている。"
group: "読み取りと構成変更"
sidebar:
  order: 27
---

## 何を学んだか

**状態の変更を、少数の原始操作とその合成として表す。** `etcd-io/raft` の構成変更は `confchange` パッケージに閉じており、公開されているのは `EnterJoint` / `LeaveJoint` / `Simple` の 3 つだけだ。

そして、**スナップショットからの構成復元も、これら 3 つの並びとして表現される**。ConfState という直列化された表現を読み込む専用のコードを書くのではなく、「その構成に至る操作列」を組み立てて再生する。デシリアライザと変更処理で挙動がずれる余地がなくなる。

## ソースコードのどこか

`Changer` は状態を持たない。現在の構成と、ログの末尾インデックスだけを受け取る ([`confchange/confchange.go#L27-L34`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L27-L34))。

```go title="confchange/confchange.go"
// Changer facilitates configuration changes. It exposes methods to handle
// simple and joint consensus while performing the proper validation that allows
// refusing invalid configuration changes before they affect the active
// configuration.
type Changer struct {
	Tracker   tracker.ProgressTracker
	LastIndex uint64
}
```

「有効な構成に影響を与える **前に** 無効な変更を拒否できるようにする」と書かれている。これが実装の骨格を決めている。

### EnterJoint

joint 状態に入る操作 ([`confchange/confchange.go#L36-L92`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L36-L92))。

```go title="confchange/confchange.go"
// EnterJoint verifies that the outgoing (=right) majority config of the joint
// config is empty and initializes it with a copy of the incoming (=left)
// majority config. That is, it transitions from
//
//	(1 2 3)&&()
//
// to
//
//	(1 2 3)&&(1 2 3).
//
// The supplied changes are then applied to the incoming majority config,
// resulting in a joint configuration that in terms of the Raft thesis[1]
// (Section 4.3) corresponds to `C_{new,old}`.
func (c Changer) EnterJoint(autoLeave bool, ccs ...*pb.ConfChangeSingle) (tracker.Config, tracker.ProgressMap, error) {
	cfg, trk, err := c.checkAndCopy()
	if err != nil {
		return c.err(err)
	}
	if joint(cfg) {
		err := errors.New("config is already joint")
		return c.err(err)
	}
	if len(incoming(cfg.Voters)) == 0 {
		// We allow adding nodes to an empty config for convenience (testing and
		// bootstrap), but you can't enter a joint state.
		err := errors.New("can't make a zero-voter config joint")
		return c.err(err)
	}
	// Clear the outgoing config.
	*outgoingPtr(&cfg.Voters) = quorum.MajorityConfig{}
	// Copy incoming to outgoing.
	for id := range incoming(cfg.Voters) {
		outgoing(cfg.Voters)[id] = struct{}{}
	}

	if err := c.apply(&cfg, trk, ccs...); err != nil {
		return c.err(err)
	}
	cfg.AutoLeave = autoLeave
	return checkAndReturn(cfg, trk)
}
```

`JointConfig` は `[2]MajorityConfig` で、`[0]` が incoming (新)、`[1]` が outgoing (旧) になる。joint に入るとは、**現在の構成を outgoing にコピーしてから、incoming に変更を適用する** ことだ。

図の書き方が丁寧で、`(1 2 3)&&()` から `(1 2 3)&&(1 2 3)` へ、というコメントが操作の意味をそのまま示している。論文の記法 `C_{new,old}` との対応も書かれている。

### LeaveJoint

joint から抜ける操作 ([`confchange/confchange.go#L94-L126`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L94-L126))。

```go title="confchange/confchange.go"
func (c Changer) LeaveJoint() (tracker.Config, tracker.ProgressMap, error) {
	cfg, trk, err := c.checkAndCopy()
	if err != nil {
		return c.err(err)
	}
	if !joint(cfg) {
		err := errors.New("can't leave a non-joint config")
		return c.err(err)
	}
	for id := range cfg.LearnersNext {
		nilAwareAdd(&cfg.Learners, id)
		trk[id].IsLearner = true
	}
	cfg.LearnersNext = nil

	for id := range outgoing(cfg.Voters) {
		_, isVoter := incoming(cfg.Voters)[id]
		_, isLearner := cfg.Learners[id]

		if !isVoter && !isLearner {
			delete(trk, id)
		}
	}
	*outgoingPtr(&cfg.Voters) = nil
	cfg.AutoLeave = false

	return checkAndReturn(cfg, trk)
}
```

outgoing を消し、そこにしかいなかったノードの `Progress` を削除する。`LearnersNext` の処理については [LearnersNext のページ](../learners-next/) で扱う。

### Simple

1 台だけ変える操作 ([`confchange/confchange.go#L128-L148`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L128-L148))。

```go title="confchange/confchange.go"
// Simple carries out a series of configuration changes that (in aggregate)
// mutates the incoming majority config Voters[0] by at most one. This method
// will return an error if that is not the case, if the resulting quorum is
// zero, or if the configuration is in a joint state (i.e. if there is an
// outgoing configuration).
func (c Changer) Simple(ccs ...*pb.ConfChangeSingle) (tracker.Config, tracker.ProgressMap, error) {
	cfg, trk, err := c.checkAndCopy()
	if err != nil {
		return c.err(err)
	}
	if joint(cfg) {
		err := errors.New("can't apply simple config change in joint config")
		return c.err(err)
	}
	if err := c.apply(&cfg, trk, ccs...); err != nil {
		return c.err(err)
	}
	if n := symdiff(incoming(c.Tracker.Voters), incoming(cfg.Voters)); n > 1 {
		return tracker.Config{}, nil, errors.New("more than one voter changed without entering joint config")
	}

	return checkAndReturn(cfg, trk)
}
```

**複数の変更を渡してよいが、結果として voter 集合が 1 台しか変わらないこと** を要求する。判定は対称差の大きさで行う。

```go title="confchange/confchange.go"
// symdiff returns the count of the symmetric difference between the sets of
// uint64s, i.e. len( (l - r) \union (r - l)).
func symdiff(l, r map[uint64]struct{}) int {
```

「1 台だけ変わった」を「変更前後の対称差が 1 以下」として表現している。追加も削除も同じ判定で済む。**個々の操作を追うのではなく、始点と終点だけを比べる**。learner から voter への昇格のように、複数の操作が打ち消し合う場合も正しく扱える。

## 複製してから変更する

3 つの操作すべてが `checkAndCopy()` で始まり、`checkAndReturn()` で終わる ([`confchange/confchange.go#L335-L357`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L335-L357))。

```go title="confchange/confchange.go"
func (c Changer) checkAndCopy() (tracker.Config, tracker.ProgressMap, error) {
	cfg := c.Tracker.Config.Clone()
	trk := tracker.ProgressMap{}

	for id, pr := range c.Tracker.Progress {
		// A shallow copy is enough because we only mutate the Learner field.
		ppr := *pr
		trk[id] = &ppr
	}
	return checkAndReturn(cfg, trk)
}

func checkAndReturn(cfg tracker.Config, trk tracker.ProgressMap) (tracker.Config, tracker.ProgressMap, error) {
	if err := checkInvariants(cfg, trk); err != nil {
		return tracker.Config{}, tracker.ProgressMap{}, err
	}
	return cfg, trk, nil
}
```

**入力の不変条件を検査し、複製し、変更し、出力の不変条件を検査する**。

複製するので、途中で失敗しても元の構成は無傷だ。巻き戻しのコードが要らない。`Changer` のメソッドが値レシーバ (`c Changer`) なのも同じ理由で、呼び出し元の状態を触らない。

そして **入口と出口の両方で検査している**。入口の検査は「そもそも壊れた状態から始まっていないか」の確認で、出口は「自分が壊さなかったか」の確認になる。片方だけだと、どこで壊れたかが分からない。

浅いコピーで足りる理由もコメントにある。「`Learner` フィールドしか変更しないから」。`Inflights` のような重いオブジェクトは共有される。

## 不変条件が明文化されている

`checkInvariants` が、構成が満たすべき条件を列挙している ([`confchange/confchange.go#L273-L333`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L273-L333))。

```go title="confchange/confchange.go"
func checkInvariants(cfg tracker.Config, trk tracker.ProgressMap) error {
	// NB: intentionally allow the empty config. In production we'll never see a
	// non-empty config (we prevent it from being created) but we will need to
	// be able to *create* an initial config, for example during bootstrap (or
	// during tests). Instead of having to hand-code this, we allow
	// transitioning from an empty config into any other legal and non-empty
	// config.
	for _, ids := range []map[uint64]struct{}{
		cfg.Voters.IDs(),
		cfg.Learners,
		cfg.LearnersNext,
	} {
		for id := range ids {
			if _, ok := trk[id]; !ok {
				return fmt.Errorf("no progress for %d", id)
			}
		}
	}
```

冒頭のコメントが「空の構成をあえて許す」理由を説明している。ブートストラップ時や `Restore` 時に、**空から目的の構成へ操作で到達できるようにする** ためだ。「特別な初期化コードを手書きせずに済む」と書かれている。この判断が後で `Restore` の設計につながる。

以降、5 種類の条件が検査される。

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
	// Conversely Learners and Voters doesn't intersect at all.
	for id := range cfg.Learners {
		// ...
	}

	if !joint(cfg) {
		// We enforce that empty maps are nil instead of zero.
		if outgoing(cfg.Voters) != nil {
			return fmt.Errorf("cfg.Voters[1] must be nil when not joint")
		}
		if cfg.LearnersNext != nil {
			return fmt.Errorf("cfg.LearnersNext must be nil when not joint")
		}
		if cfg.AutoLeave {
			return fmt.Errorf("AutoLeave must be false when not joint")
		}
	}
```

最後の 3 つが面白い。**「空のマップは `nil` でなければならない」を不変条件として強制している**。長さ 0 のマップと `nil` は Go では区別されるが、意味は同じことが多い。ここでは `joint(cfg)` の判定が `len(cfg.Voters[1]) > 0` ではなく `cfg.Voters[1] != nil` に依存しているので、区別が意味を持つ。

そのために `nilAwareAdd` / `nilAwareDelete` というヘルパーがある ([`confchange/confchange.go#L364-L382`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L364-L382))。追加時に `nil` なら作り、削除して空になったら `nil` に戻す。**表現の正規化を、操作の側で保証している**。

## 新しいノードの Progress

追加されたノードの初期状態にも配慮がある ([`confchange/confchange.go#L247-L274`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/confchange.go#L247-L274))。

```go title="confchange/confchange.go"
	trk[id] = &tracker.Progress{
		// Initializing the Progress with the last index means that the follower
		// can be probed (with the last index).
		//
		// TODO(tbg): seems awfully optimistic. Using the first index would be
		// better. The general expectation here is that the follower has no log
		// at all (and will thus likely need a snapshot), though the app may
		// have applied a snapshot out of band before adding the replica (thus
		// making the first index the better choice).
		Match:     0,
		Next:      max(c.LastIndex, 1), // invariant: Match < Next
		Inflights: tracker.NewInflights(c.Tracker.MaxInflight, c.Tracker.MaxInflightBytes),
		IsLearner: isLearner,
		// When a node is first added, we should mark it as recently active.
		// Otherwise, CheckQuorum may cause us to step down if it is invoked
		// before the added node has had a chance to communicate with us.
		RecentActive: true,
	}
```

2 つのコメントがどちらも重要だ。

`Next` にログの末尾を入れるのは楽観的すぎる、という TODO が残っている。新しいノードは普通ログを持っていないので、探索は必ず失敗して先頭まで下がることになる。ただし「利用側が別経路でスナップショットを適用してから追加する」使い方もあるので、一概には決められない。**判断を保留していることが明示されている**。

`RecentActive: true` の理由が実務的だ。追加直後に [CheckQuorum](../check-quorum-and-lease/) が走ると、まだ一度も通信していない新ノードが「非活性」と判定される。それで過半数を割ると、リーダーが自分から降りてしまう。**構成変更が原因でリーダーが降りる** という事故を、初期値 1 つで防いでいる。

## 復元を操作の再生として書く

`Restore` が、このパッケージで最も面白い部分になる ([`confchange/restore.go#L119-L155`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/restore.go#L119-L155))。

```go title="confchange/restore.go"
// Restore takes a Changer (which must represent an empty configuration), and
// runs a sequence of changes enacting the configuration described in the
// ConfState.
func Restore(chg Changer, cs *pb.ConfState) (tracker.Config, tracker.ProgressMap, error) {
	outgoing, incoming := toConfChangeSingle(cs)

	var ops []func(Changer) (tracker.Config, tracker.ProgressMap, error)

	if len(outgoing) == 0 {
		// No outgoing config, so just apply the incoming changes one by one.
		for _, cc := range incoming {
			cc := cc // loop-local copy
			ops = append(ops, func(chg Changer) (tracker.Config, tracker.ProgressMap, error) {
				return chg.Simple(cc)
			})
		}
	} else {
		// The ConfState describes a joint configuration.
		//
		// First, apply all of the changes of the outgoing config one by one, so
		// that it temporarily becomes the incoming active config. For example,
		// if the config is (1 2 3)&(2 3 4), this will establish (2 3 4)&().
		for _, cc := range outgoing {
			// ... chg.Simple(cc)
		}
		// Now enter the joint state, which rotates the above additions into the
		// outgoing config, and adds the incoming config in.
		ops = append(ops, func(chg Changer) (tracker.Config, tracker.ProgressMap, error) {
			return chg.EnterJoint(cs.GetAutoLeave(), incoming...)
		})
	}

	return chain(chg, ops...)
}
```

**ConfState を直接読み込むコードが 1 行もない**。代わりに、空の構成から目的の構成に至る操作列を組み立てて、順に適用する。

joint 構成の復元手順が巧妙だ。

1. 旧構成のメンバーを 1 台ずつ追加する → `(2 3 4)&&()`
2. `EnterJoint` を呼ぶ → 今の構成が outgoing にコピーされる → `(2 3 4)&&(2 3 4)`
3. その中で incoming に「旧メンバーを全部削除して新メンバーを追加」を適用 → `(1 2 3)&&(2 3 4)`

**`EnterJoint` が「現在の構成を outgoing にコピーする」という性質を利用して、outgoing を先に作っている**。

操作列の組み立ては `toConfChangeSingle` にあり、コメントが具体例で追えるようになっている ([`confchange/restore.go#L20-L54`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/restore.go#L20-L54))。

```go title="confchange/restore.go"
	// Example to follow along this code:
	// voters=(1 2 3) learners=(5) outgoing=(1 2 4 6) learners_next=(4)
	//
	// The code below will construct
	// outgoing = add 1; add 2; add 4; add 6
	// incoming = remove 1; remove 2; remove 4; remove 6
	//            add 1;    add 2;    add 3;
	//            add-learner 5;
	//            add-learner 4;
	//
	// So, when starting with an empty config, after applying 'outgoing' we have
	//
	//   quorum=(1 2 4 6)
	//
	// From which we enter a joint state via 'incoming'
	//
	//   quorum=(1 2 3)&&(1 2 4 6) learners=(5) learners_next=(4)
	//
	// as desired.
```

**具体例 1 つで、生成される操作列と最終結果まで追える**。抽象的な説明より、この形の方が検証しやすい。

合成は 10 行の関数だ ([`confchange/restore.go#L99-L117`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/confchange/restore.go#L99-L117))。

```go title="confchange/restore.go"
func chain(chg Changer, ops ...func(Changer) (tracker.Config, tracker.ProgressMap, error)) (tracker.Config, tracker.ProgressMap, error) {
	for _, op := range ops {
		cfg, trk, err := op(chg)
		if err != nil {
			return tracker.Config{}, nil, err
		}
		chg.Tracker.Config = cfg
		chg.Tracker.Progress = trk
	}
	return chg.Tracker.Config, chg.Tracker.Progress, nil
}
```

各操作の結果を次の入力に流す。**各ステップで `checkInvariants` が走る** ので、復元の途中で不正な状態が生じたら即座に検出される。

## 結果の検証

`Restore` の呼び出し側では、復元結果が元の `ConfState` と一致するかを確認している ([`raft.go#L478-L486`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L478-L486))。

```go title="raft.go"
	cfg, trk, err := confchange.Restore(confchange.Changer{
		Tracker:   r.trk,
		LastIndex: lastID.index,
	}, cs)
	if err != nil {
		panic(err)
	}
	assertConfStatesEquivalent(r.logger, cs, r.switchToConfig(cfg, trk))
```

```go title="util.go"
func assertConfStatesEquivalent(l Logger, cs1, cs2 *pb.ConfState) {
	err := cs1.Equivalent(cs2)
	if err == nil {
		return
	}
	l.Panic(err)
}
```

**往復して同じものが得られるかを検査している**。`ConfState` → 操作列 → 構成 → `ConfState` が一致しなければ panic する。操作列の組み立てにバグがあれば、起動時かスナップショット適用時に必ず落ちる。

## どう活かすか

- **状態遷移を少数の原始操作に絞る**。`EnterJoint` / `LeaveJoint` / `Simple` の 3 つしかないので、検査すべき経路が 3 本で済む。操作を増やすほど、不変条件を守る責任が分散する。
- **複製してから変更し、前後で不変条件を検査する**。巻き戻しのコードが不要になり、失敗時に元の状態が壊れない。値レシーバにしておくと、うっかり元を触ることもない。
- **入口と出口の両方で検査する**。出口だけだと「入力が既に壊れていた」のか「自分が壊した」のかが分からない。
- **復元を、専用のデシリアライザではなく操作の再生として書く**。変更処理と復元処理で挙動がずれる余地がなくなり、不変条件の検査も各ステップで自動的に走る。
- **往復の一致を検査する**。直列化と復元がある場合、`decode(encode(x)) == x` を実行時に確認する。この 1 行で、組み立てロジックの誤りが起動時に露見する。
- **表現の正規化を操作側で保証する**。「空のマップは `nil`」のような規約は、ヘルパー関数で守り、不変条件として検査する。判定側で `len() == 0` と `!= nil` が混ざると、意味が分岐する。
