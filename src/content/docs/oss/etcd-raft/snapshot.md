---
title: "ログを無限に持てないので、状態そのもののコピーで先頭を捨てる"
description: "ログ圧縮とスナップショット。スナップショットが「状態機械の中身 + 最後に含めた (index, term) + 構成」の 3 点セットである理由、遅れたフォロワーにログではなくスナップショットを送ることになる条件、そして etcd-io/raft がスナップショットの作成も圧縮の判断も利用側に委ねている境界の引き方。"
group: "Raft を理解する"
sidebar:
  order: 7
---

ログは追記され続ける。何もしなければディスクを食い尽くすし、再起動時に先頭から全部を適用し直すことになる。このページは、その先頭を捨てる仕組みを扱う。

## スナップショットとは何か

コミット済みで、全ノードが適用済みのエントリは、もう保持している意味がない — と言いたいところだが、そう単純ではない。ログを捨てると、遅れているフォロワーに配るものがなくなる。再起動したノードも状態を復元できない。

そこで、**ログを捨てる前に、状態機械の中身そのものをコピーしておく**。これがスナップショットだ。

```
圧縮前:
  ログ [1][2][3][4][5][6][7][8][9][10]
                            ↑ applied

圧縮後:
  スナップショット (index=7 までを適用した状態のコピー)
  ログ                        [8][9][10]
```

スナップショットには 3 つのものが入る ([`raftpb/raft.proto#L19-L28`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raftpb/raft.proto#L19-L28))。

```protobuf title="raftpb/raft.proto"
message SnapshotMetadata {
	optional ConfState conf_state = 1;
	optional uint64    index      = 2;
	optional uint64    term       = 3;
}

message Snapshot {
	optional bytes            data     = 1;
	optional SnapshotMetadata metadata = 2;
}
```

- `data`: 状態機械の中身。Raft はこれを解釈しない。バイト列として運ぶだけ。
- `index` / `term`: **そのスナップショットに含まれる最後のエントリの `(index, term)`**。
- `conf_state`: その時点のクラスタ構成。

`index` と `term` が要るのは、[ログマッチング特性](../log-replication/) のためだ。スナップショットを適用したノードのログは index 8 から始まるが、「index 7 の任期は何だったか」が分からないと、リーダーからの `prev=(7, t)` という一致検査に答えられない。

`etcd-io/raft` はこの「圧縮された 1 つ手前の任期」を明示的に残している ([`log.go#L388-L392`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L388-L392))。

```go title="log.go"
	// The valid term range is [firstIndex-1, lastIndex]. Even though the entry at
	// firstIndex-1 is compacted away, its term is available for matching purposes
	// when doing log appends.
	if i+1 < l.firstIndex() {
		return 0, ErrCompacted
	}
```

`firstIndex - 1` の任期だけは、エントリ本体が消えていても引ける。この 1 点があるおかげで、圧縮直後のログにも複製を続けられる。

`conf_state` が要る理由は少し違う。スナップショットから復元したノードは、**自分がどのクラスタに属していて、誰が voter なのか** を知らなければ選挙にも複製にも参加できない。構成変更はログエントリとして記録されるので、ログを捨てるとその情報も消える。だからスナップショットに一緒に入れる。

## 誰がスナップショットを作るのか

`etcd-io/raft` は作らない。**状態機械の中身を知らないので作れない**。

ライブラリがすることは 2 つだけだ。

1. 遅れたフォロワーにログを配れないと分かったとき、`Storage.Snapshot()` を呼んで「あるならくれ」と要求する。
2. 受け取ったスナップショットを、`Ready` に載せて利用側に渡す。

いつ圧縮するか、どのインデックスで切るか、スナップショットをどう保存するかは、全部利用側の判断になる。`Storage` インターフェースにも `Snapshot()` は読み出しとしてしか現れない ([`storage.go#L48-L96`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L48-L96))。

```go title="storage.go"
	// Snapshot returns the most recent snapshot.
	// If snapshot is temporarily unavailable, it should return ErrSnapshotTemporarilyUnavailable,
	// so raft state machine could know that Storage needs some time to prepare
	// snapshot and call Snapshot later.
	Snapshot() (*pb.Snapshot, error)
```

`ErrSnapshotTemporarilyUnavailable` という専用のエラーがあるのが面白い。「今は作っている最中だから後で聞いてくれ」を表現できる。スナップショットの生成は重い処理になりうるので、Raft のループを止めずに非同期に作れるようにしてある。

参照実装の `MemoryStorage` には `CreateSnapshot` と `Compact` があるが、これらは `Storage` インターフェースの外にある ([`storage.go#L243-L292`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L243-L292))。利用側が呼ぶものであって、ライブラリが呼ぶものではない、という区別が型で表れている。

## スナップショットを送ることになる条件

リーダーがフォロワーに複製しようとして、**送るべきエントリが既に圧縮されていた** ときに、スナップショットの送信が起きる ([`raft.go#L622-L630`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L622-L630))。

```go title="raft.go"
	prevIndex := pr.Next - 1
	prevTerm, err := r.raftLog.term(prevIndex)
	if err != nil {
		// The log probably got truncated at >= pr.Next, so we can't catch up the
		// follower log anymore. Send a snapshot instead.
		return r.maybeSendSnapshot(to, pr)
	}
```

`term(prevIndex)` が `ErrCompacted` を返した、つまり「一致検査に使うべきエントリの任期がもう分からない」場合だ。このとき、ログの続きを送っても相手は検査できないので、状態そのものを送るしかない。

`maybeSendSnapshot` は少し慎重に振る舞う ([`raft.go#L666-L692`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L666-L692))。

```go title="raft.go"
func (r *raft) maybeSendSnapshot(to uint64, pr *tracker.Progress) bool {
	if !pr.RecentActive {
		r.logger.Debugf("ignore sending snapshot to %x since it is not recently active", to)
		return false
	}

	snapshot, err := r.raftLog.snapshot()
	if err != nil {
		if err == ErrSnapshotTemporarilyUnavailable {
			r.logger.Debugf("%x failed to send snapshot to %x because snapshot is temporarily unavailable", r.id, to)
			return false
		}
		panic(err) // TODO(bdarnell)
	}
```

`RecentActive` の検査が入っている。**最近生きているのが確認できていない相手にはスナップショットを送らない**。スナップショットはギガバイト級になりうるので、既に落ちている相手に投げるのは純粋な浪費になる。

## 受け取った側

フォロワーは `handleSnapshot` → `restore` と進む ([`raft.go#L1860-L1878`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1860-L1878))。

```go title="raft.go"
func (r *raft) restore(s *pb.Snapshot) bool {
	if s.GetMetadata().GetIndex() <= r.raftLog.committed {
		return false
	}
	if r.state != StateFollower {
		// This is defense-in-depth: if the leader somehow ended up applying a
		// snapshot, it could move into a new term without moving into a
		// follower state. This should never fire, but if it did, we'd have
		// prevented damage by returning early, so log only a loud warning.
		r.logger.Warningf("%x attempted to restore snapshot as leader; should never happen", r.id)
		r.becomeFollower(r.Term+1, None)
		return false
	}
```

自分のコミット位置より古いスナップショットは無視する。リーダーが受け取ることはありえないが、その場合も念のため防御する。この "defense-in-depth" というコメントは `restore` の中に 2 か所あり、もう 1 つは「自分が構成に含まれていないスナップショットは捨てる」だ。

もう 1 つ、興味深い早期リターンがある ([`raft.go#L1911-L1920`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1911-L1920))。

```go title="raft.go"
	id := entryID{term: s.GetMetadata().GetTerm(), index: s.GetMetadata().GetIndex()}
	if r.raftLog.matchTerm(id) {
		last := r.raftLog.lastEntryID()
		r.logger.Infof("%x [commit: %d, lastindex: %d, lastterm: %d] fast-forwarded commit to snapshot [index: %d, term: %d]",
			r.id, r.raftLog.committed, last.index, last.term, id.index, id.term)
		r.raftLog.commitTo(s.GetMetadata().GetIndex())
		return false
	}
```

**スナップショットの `(index, term)` を自分のログが既に持っているなら、スナップショットを展開せず、コミット位置だけ進める**。「スナップショットは持っていないが、ログとしては同じところまで持っている」場合で、この判定があると重い復元処理を丸ごと省ける。

実際に復元する場合は、ログを丸ごと捨てて構成も入れ替える ([`raft.go#L1922-L1935`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1922-L1935))。

```go title="raft.go"
	r.raftLog.restore(s)

	// Reset the configuration and add the (potentially updated) peers in anew.
	r.trk = tracker.MakeProgressTracker(r.trk.MaxInflight, r.trk.MaxInflightBytes)
	cfg, trk, err := confchange.Restore(confchange.Changer{
		Tracker:   r.trk,
		LastIndex: r.raftLog.lastIndex(),
	}, cs)
```

`confchange.Restore` が、スナップショットに入っていた `ConfState` から構成を組み直している。これについては [joint consensus のページ](../joint-consensus/) で扱う。

## 進捗の 3 つ目の状態

リーダー側では、スナップショットを送ったフォロワーの `Progress` が `StateSnapshot` に移る ([`tracker/progress.go#L153-L163`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L153-L163))。

```go title="tracker/progress.go"
func (pr *Progress) BecomeSnapshot(snapshoti uint64) {
	pr.ResetState(StateSnapshot)
	pr.PendingSnapshot = snapshoti
	pr.Next = snapshoti + 1
	pr.sentCommit = snapshoti
}
```

この状態の間、リーダーはそのフォロワーに複製メッセージを送らない。スナップショットの転送と適用が終わるまで、ログを送っても無駄だからだ。

戻ってくる経路は 2 つある。フォロワーがスナップショットを適用して `MsgAppResp` を返してくるか、利用側が `ReportSnapshot` で成否を報告するか。

`PendingSnapshot` のコメントが、この 2 経路を用意した理由を説明している ([`tracker/progress.go#L64-L84`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L64-L84))。

```go title="tracker/progress.go"
	// The follower will transition back to StateReplicate if the leader
	// receives an MsgAppResp from it that reconnects the follower to the
	// leader's log (such an MsgAppResp is emitted when the follower applies a
	// snapshot). It may be surprising that PendingSnapshot is not taken into
	// account here, but consider that complex systems may delegate the sending
	// of snapshots to alternative datasources (i.e. not the leader). In such
	// setups, it is difficult to manufacture a snapshot at a particular index
	// requested by raft and the actual index may be ahead or behind. This
	// should be okay, as long as the snapshot allows replication to resume.
```

**リーダー以外がスナップショットを配ることを想定している**。CockroachDB のような利用側は、リーダーの負荷を避けるため別のノードや別経路から転送することがある。そのとき、届いたスナップショットのインデックスがリーダーの要求と一致するとは限らない。だから `PendingSnapshot` と厳密に照合せず、「複製を再開できる位置に繋がったかどうか」だけを見る。

```go title="tracker/progress.go"
	// The follower will transition to StateProbe if ReportSnapshot is called on
	// the leader; if SnapshotFinish is passed then PendingSnapshot becomes the
	// basis for the next attempt to append. In practice, the first mechanism is
	// the one that is relevant in most cases. However, if this MsgAppResp is
	// lost (fallible network) then the second mechanism ensures that in this
	// case the follower does not erroneously remain in StateSnapshot.
```

もう 1 つの経路は、`MsgAppResp` が失われた場合の保険だ。1 つ目の経路が普段使われ、2 つ目が取りこぼしを拾う。この二重化がないと、フォロワーが `StateSnapshot` のまま永久に取り残される。

## 圧縮とスナップショットは別のもの

紛らわしいが、この 2 つは別だ。

- **スナップショットを作る**: 状態機械の中身をコピーして保存する。
- **ログを圧縮する**: 保存済みのスナップショットより手前のログエントリを捨てる。

先に作って、後で捨てる。順序を逆にすると、どちらからも復元できない期間ができる。

`etcd-io/raft` はどちらも行わない。参照実装の `MemoryStorage.CreateSnapshot` を見ると、この順序への配慮が見える ([`storage.go#L243-L266`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L243-L266))。

```go title="storage.go"
func (ms *MemoryStorage) CreateSnapshot(i uint64, cs *pb.ConfState, data []byte) (*pb.Snapshot, error) {
	// ...
	if i <= ms.snapshot.GetMetadata().GetIndex() {
		return &pb.Snapshot{}, ErrSnapOutOfDate
	}
```

既にあるスナップショットより古い位置では作れない。`ErrSnapOutOfDate` という専用のエラーになっている。

## 適用中の扱い

もう 1 つ細かいが重要な点。スナップショットの適用中は、コミット済みエントリの適用を止める ([`log.go#L248-L262`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L248-L262))。

```go title="log.go"
	if l.hasNextOrInProgressSnapshot() {
		// If we have a snapshot to apply, don't also return any committed
		// entries. Doing so raises questions about what should be applied
		// first.
		return false
	}
```

「どちらを先に適用すべきか、という問いが立ってしまう」からだ。スナップショットは状態機械を丸ごと置き換えるので、その前後でエントリを適用する意味が変わる。混ぜないという判断を、コメント付きで明示している。

同じ理由で、スナップショット適用待ちのノードは立候補できない ([`raft.go#L1946-L1949`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1946-L1949))。

```go title="raft.go"
func (r *raft) promotable() bool {
	pr := r.trk.Progress[r.id]
	return pr != nil && !pr.IsLearner && !r.raftLog.hasNextOrInProgressSnapshot()
}
```

自分の状態が確定していない間にリーダーになると、間違ったログを配ることになる。

## まとめ

- スナップショットは「状態機械の中身 + 最後に含めた `(index, term)` + 構成」の 3 点セット。
- `(index, term)` はログマッチングを続けるため、構成は復元したノードがクラスタに参加するために必要。
- ライブラリはスナップショットを作らず、圧縮の判断もしない。要求と受け渡しだけをする。
- 遅れたフォロワーに送るエントリが圧縮されていたとき、スナップショットの送信に切り替わる。
- リーダー以外がスナップショットを配ることを想定して、インデックスの厳密一致を要求しない設計になっている。

前提編の最後は、クラスタの構成そのものを変える話になる。
