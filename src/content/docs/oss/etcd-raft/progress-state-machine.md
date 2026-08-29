---
title: "フォロワーごとの状態を「探る」「流す」「送らない」の 3 つに分ける"
description: "リーダーはフォロワーごとに Progress を持ち、それが probe / replicate / snapshot の 3 状態を持つ小さな状態機械になっている。「どこまで届いたか」を確定値 Match と推測値 Next に分け、推測が外れたら状態ごと落とす。design.md に図付きで残されている設計を、実際のコードと突き合わせて読む。"
group: "複製と流量制御"
sidebar:
  order: 20
---

## 何を学んだか

**確定した事実と、楽観的な推測を、別のフィールドに分けて持つ。** リーダーがフォロワーごとに持つ `Progress` は、`Match` (そこまで一致していると確認済み) と `Next` (次に送る位置の推測) を持つ。推測が当たっている間は速く進み、外れたら状態を落として慎重に探り直す。

その「速く進む」「慎重に探る」「何も送らない」の 3 つが、`StateReplicate` / `StateProbe` / `StateSnapshot` という状態として明示されている。フロー制御の判断が、状態ごとに閉じている。

## ソースコードのどこか

このライブラリには `design.md` があり、`Progress` の設計だけが図付きで説明されている ([`design.md`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/design.md))。

```text title="design.md"
                            +--------------------------------------------------------+
                            |                  send snapshot                         |
                            |                                                        |
                  +---------+----------+                                  +----------v---------+
              +--->       probe        |                                  |      snapshot      |
              |   |  max inflight = 1  <----------------------------------+  max inflight = 0  |
              |   +---------+----------+                                  +--------------------+
              |             |            1. snapshot success
              |             |               (next=snapshot.index + 1)
              |             |            2. snapshot failure
              |             |               (no change)
              |             |            3. receives msgAppResp(rej=false&&index>lastsnap.index)
              |             |               (match=m.index,next=match+1)
receives msgAppResp(rej=true)
(next=match+1)|             |
              |             |   receives msgAppResp(rej=false&&index>match)
              |             |   (match=m.index,next=match+1)
              |             |
              |   +---------v----------+
              |   |     replicate      |
              +---+  max inflight = n  |
                  +--------------------+
```

各状態の「同時に送ってよいメッセージ数」が状態名の下に書かれている。probe は 1、replicate は n、snapshot は 0。**状態が流量制御のパラメータそのものになっている**。

## 2 つのフィールド

`Progress` の中心は 2 つの整数だ ([`tracker/progress.go#L30-L42`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L30-L42))。

```go title="tracker/progress.go"
	// Match is the index up to which the follower's log is known to match the
	// leader's.
	Match uint64
	// Next is the log index of the next entry to send to this follower. All
	// entries with indices in (Match, Next) interval are already in flight.
	//
	// Invariant: 0 <= Match < Next.
	// NB: it follows that Next >= 1.
	//
	// In StateSnapshot, Next == PendingSnapshot + 1.
	Next uint64
```

`(Match, Next)` の区間が「送信済みだがまだ確認が返っていない」ぶんになる。

```
     0        Match              Next
     ├─────────┤                  │
     │  一致が  ├──────────────────┤
     │  確定    │  送信済み・未確認 │  未送信
```

`Match` は確定値なので、`maybeCommit` の計算に使われる。`Next` は推測なので、外れたら下げる。

## 3 つの状態

### StateProbe: 1 通ずつ探る

新しくリーダーになったとき、フォロワーのログがどうなっているか分からない。ここから始まるのが `StateProbe` だ。

```go title="design.md"
When the progress of a follower is in `probe` state, leader sends at most one
`replication message` per heartbeat interval. The leader sends `replication message`
slowly and probing the actual progress of the follower. A `msgHeartbeatResp` or
a `msgAppResp` with reject might trigger the sending of the next `replication message`.
```

1 ハートビート間隔に 1 通しか送らない。どこまで一致しているか分からない状態でたくさん送っても、全部拒否されて無駄になるからだ。

「1 通しか送らない」の実装は `MsgAppFlowPaused` フラグになっている ([`tracker/progress.go#L165-L187`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L165-L187))。

```go title="tracker/progress.go"
	case StateProbe:
		// TODO(pavelkalinnikov): this condition captures the previous behaviour,
		// but we should set MsgAppFlowPaused unconditionally for simplicity, because any
		// MsgApp in StateProbe is a probe, not only non-empty ones.
		if entries > 0 {
			pr.MsgAppFlowPaused = true
		}
```

送ったらフラグを立てて止め、ハートビート応答が来たら倒す ([`raft.go#L1579-L1581`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1579-L1581))。

```go title="raft.go"
	case pb.MsgHeartbeatResp:
		pr.RecentActive = true
		pr.MsgAppFlowPaused = false
```

**ハートビートがフロー制御のクロックとして働いている**。ハートビートは定期的に飛ぶので、probe の再試行が自然にその間隔になる。専用のタイマーを持たずに済む。

### StateReplicate: 楽観的に流す

一致する位置が見つかったら `StateReplicate` に移る。

```go title="design.md"
When the progress of a follower is in `replicate` state, leader sends `replication message`,
then optimistically increases `next` to the latest entry sent. This is an optimized
state for fast replicating log entries to the follower.
```

**確認を待たずに `Next` を進める**。送った端から `Next` を先へ動かすので、応答を待たずに次のバッチを送れる。パイプライン化される。

```go title="tracker/progress.go"
	case StateReplicate:
		if entries > 0 {
			pr.Next += uint64(entries)
			pr.Inflights.Add(pr.Next-1, bytes)
		}
		// If this message overflows the in-flights tracker, or it was already full,
		// consider this message being a probe, so that the flow is paused.
		pr.MsgAppFlowPaused = pr.Inflights.Full()
```

無制限に流すわけではなく、`Inflights` という窓で制限する。これは [Inflights のページ](../inflights/) で扱う。

### StateSnapshot: 送らない

ログが圧縮されていて追いつかせられない場合、スナップショットを送って `StateSnapshot` に移る。

```go title="design.md"
When the progress of a follower is in `snapshot` state, leader stops sending
any `replication message`.
```

送っても意味がないので止める。`IsPaused()` が常に `true` を返す ([`tracker/progress.go#L262-L273`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L262-L273))。

```go title="tracker/progress.go"
func (pr *Progress) IsPaused() bool {
	switch pr.State {
	case StateProbe:
		return pr.MsgAppFlowPaused
	case StateReplicate:
		return pr.MsgAppFlowPaused
	case StateSnapshot:
		return true
	default:
		panic("unexpected state")
	}
}
```

`maybeSendAppend` の冒頭でこれが見られる ([`raft.go#L618-L621`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L618-L621))。

```go title="raft.go"
func (r *raft) maybeSendAppend(to uint64, sendIfEmpty bool) bool {
	pr := r.trk.Progress[to]
	if pr.IsPaused() {
		return false
	}
```

**3 つの状態の違いが、送信の入口では `IsPaused()` の 1 行に畳まれている**。状態ごとの分岐が呼び出し側に漏れない。

## 状態遷移

遷移関数は 3 つで、どれも `ResetState` を呼ぶ ([`tracker/progress.go#L121-L163`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L121-L163))。

```go title="tracker/progress.go"
// ResetState moves the Progress into the specified State, resetting MsgAppFlowPaused,
// PendingSnapshot, and Inflights.
func (pr *Progress) ResetState(state StateType) {
	pr.MsgAppFlowPaused = false
	pr.PendingSnapshot = 0
	pr.State = state
	pr.Inflights.reset()
}

func (pr *Progress) BecomeProbe() {
	// If the original state is StateSnapshot, progress knows that
	// the pending snapshot has been sent to this peer successfully, then
	// probes from pendingSnapshot + 1.
	if pr.State == StateSnapshot {
		pendingSnapshot := pr.PendingSnapshot
		pr.ResetState(StateProbe)
		pr.Next = max(pr.Match+1, pendingSnapshot+1)
	} else {
		pr.ResetState(StateProbe)
		pr.Next = pr.Match + 1
	}
	pr.sentCommit = min(pr.sentCommit, pr.Next-1)
}

func (pr *Progress) BecomeReplicate() {
	pr.ResetState(StateReplicate)
	pr.Next = pr.Match + 1
}
```

**状態を変えるときは付随する状態も全部リセットする**。`Inflights` の中身、一時停止フラグ、スナップショット待ちの位置。個別に消し忘れる余地がない。

`BecomeProbe` が `Next = Match + 1` に落とすのが重要だ。`StateReplicate` で楽観的に進めた `Next` は当てにならなくなったので、確定値 `Match` の次まで戻す。

`design.md` にこの選択の説明がある。

```text title="design.md"
We aggressively reset `next` to `match`+1 since if we receive any `msgAppResp` soon,
both `match` and `next` will increase directly to the `index` in `msgAppResp`.
(We might end up with sending some duplicate entries when aggressively reset
`next` too low. see open question)
```

下げすぎて重複送信になる可能性はあるが、次の応答で一気に戻るので構わない、という判断だ。**下げすぎのコストと、下げ足りないコストを比べて、下げすぎる方を選んでいる**。

## 応答による遷移

拒否された場合 ([`raft.go#L1524-L1530`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1524-L1530))。

```go title="raft.go"
			if pr.MaybeDecrTo(m.GetIndex(), nextProbeIdx) {
				r.logger.Debugf("%x decreased progress of %x to [%s]", r.id, m.GetFrom(), pr)
				if pr.State == tracker.StateReplicate {
					pr.BecomeProbe()
				}
				r.sendAppend(m.GetFrom())
			}
```

`StateReplicate` で拒否されたということは、楽観的な推測が外れたということなので、`StateProbe` に落とす。

`MaybeDecrTo` は古い応答を弾く ([`tracker/progress.go#L226-L260`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L226-L260))。名前の `Maybe` が「条件を満たさなければ何もしない」を表している。同じ命名が `MaybeUpdate` にもある。

受け入れられた場合 ([`raft.go#L1533-L1552`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1533-L1552))。

```go title="raft.go"
			if pr.MaybeUpdate(m.GetIndex()) || (pr.Match == m.GetIndex() && pr.State == tracker.StateProbe) {
				switch {
				case pr.State == tracker.StateProbe:
					pr.BecomeReplicate()
				case pr.State == tracker.StateSnapshot && pr.Match+1 >= r.raftLog.firstIndex():
					// Note that we don't take into account PendingSnapshot to
					// enter this branch. No matter at which index a snapshot
					// was actually applied, as long as this allows catching up
					// the follower from the log, we will accept it.
					r.logger.Debugf("%x recovered from needing snapshot, resumed sending replication messages to %x [%s]", r.id, m.GetFrom(), pr)
					// Transition back to replicating state via probing state
					// (which takes the snapshot into account). If we didn't
					// move to replicating state, that would only happen with
					// the next round of appends (but there may not be a next
					// round for a while, exposing an inconsistent RaftStatus).
					pr.BecomeProbe()
					pr.BecomeReplicate()
				case pr.State == tracker.StateReplicate:
					pr.Inflights.FreeLE(m.GetIndex())
				}
```

条件式の後半 `(pr.Match == m.GetIndex() && pr.State == tracker.StateProbe)` が細かい。`MaybeUpdate` は `Match` が進まなければ `false` を返すが、**`StateProbe` で `Match` と同じ位置の確認が返ってきたら、それは「一致が確認できた」という新しい情報** なので `StateReplicate` に上げてよい。進捗がゼロでも状態は進む。

`StateSnapshot` からの復帰では `BecomeProbe()` の直後に `BecomeReplicate()` を呼んでいる。probe を経由するのは `Next` の計算にスナップショットの位置を反映させるためで、すぐ replicate に上げるのは「状態表示が実態とずれないように」という理由だ。コメントに「次の追記まで待つと、その間 `RaftStatus` が矛盾した値を返す」と書かれている。**運用時に見える値の一貫性まで理由になっている**。

## 到達不能の報告

トランスポート層からの報告でも状態が落ちる ([`raft.go#L1629-L1635`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1629-L1635))。

```go title="raft.go"
	case pb.MsgUnreachable:
		// During optimistic replication, if the remote becomes unreachable,
		// there is huge probability that a MsgApp is lost.
		if pr.State == tracker.StateReplicate {
			pr.BecomeProbe()
		}
```

`StateReplicate` は「送ったものは届く」という楽観に立っている。届かないと分かったら、その楽観を維持できない。

**外部からの情報で内部の楽観を取り下げる** 経路がある、ということでもある。利用側が `ReportUnreachable` を呼ばなくても正しさは保たれるが、呼べば復旧が速くなる。

## なぜそうなっているか

3 状態にしないとどうなるか考えると分かりやすい。

**probe がないと**: リーダー交代直後、フォロワーのログ位置が不明なまま大量に送ることになる。ほぼ全部が拒否され、帯域が無駄になる。分断から復帰したフォロワーが数千エントリ遅れている場合、その全部を送って全部拒否される。

**replicate がないと**: 常に 1 通ずつ確認しながら送ることになる。RTT 100ms なら、1 秒に 10 エントリしか複製できない。実用にならない。

**snapshot がないと**: 追いつかせられないフォロワーに送り続けることになる。拒否が返り続け、リーダーの CPU と帯域を食う。

3 つは「不確実性の度合い」に対応している。

| 状態      | フォロワーの位置の把握           | 送り方               |
| --------- | -------------------------------- | -------------------- |
| probe     | 分からない                       | 1 通ずつ、返事を待つ |
| replicate | 分かっている                     | 窓の許す限り流す     |
| snapshot  | 分かっているが追いつかせられない | 送らない             |

**不確実なときは慎重に、確実なときは楽観的に**。そして推測が外れたら不確実な状態に戻る。これは TCP の輻輳制御 (slow start と congestion avoidance) と同じ構造をしている。

## どう活かすか

- **確定値と推測値を別のフィールドに持つ**。`Match` と `Next` のように分けておくと、推測が外れたときに確定値まで戻すのが自明になる。1 つのフィールドで両方を兼ねると、どこまで戻せるかが分からなくなる。
- **不確実性の度合いを状態として明示する**。「今どのくらい信用できるか」を列挙型にすると、送信量・再試行間隔・タイムアウトといったパラメータを状態ごとに決められる。条件式の組み合わせで表現するより読みやすい。
- **状態を変えるときは付随する状態も全部リセットする**。`ResetState` のように 1 か所にまとめる。個別にリセットする書き方は、新しいフィールドを足したときに漏れる。
- **既存の周期的な処理をフロー制御のクロックに使う**。probe の再試行をハートビートに乗せることで、専用のタイマーが要らなくなっている。
- **下げすぎのコストと下げ足りないコストを比べる**。`Next = Match + 1` は保守的すぎるが、1 往復で戻るので実害が小さい。「保守的に倒しても回復が速い」なら、保守的に倒す方が単純になる。
