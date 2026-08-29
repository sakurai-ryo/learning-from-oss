---
title: "コミット位置だけを伝える空メッセージを、送っても無駄なときは送らない"
description: "リーダーのコミット位置は MsgApp と MsgHeartbeat の両方に載って伝わる。エントリのない MsgApp を積極的に送ればフォロワーの適用が速くなるが、無駄も増える。etcd-io/raft は「送信済みのコミット位置」を Progress に持ち、それを超えないなら送らないという判定を 1 つの式にまとめている。"
group: "複製と流量制御"
sidebar:
  order: 25
---

## 何を学んだか

**「送っても相手の状態が変わらないメッセージ」を、送る前に判定して落とす。** リーダーのコミット位置はフォロワーに伝えなければならないが、伝える経路は複数ある。ハートビートにも載るし、次の `MsgApp` にも載る。エントリのない `MsgApp` を余分に送ることもできる。

積極的に送ればフォロワーの適用が速くなり、抑えればメッセージが減る。`etcd-io/raft` は `Progress` に「送信済みのコミット位置」を持たせ、**それを超える情報を運べるときだけ送る** ようにしている。

## 解いている問題

コミット位置の伝播には遅延がある。`testdata/lagging_commit.txt` の冒頭がその場面を説明している。

```text title="testdata/lagging_commit.txt"
# This test demonstrates the effect of delayed commit on a follower node after a
# network hiccup between the leader and this follower.
```

フォロワーとの間で一時的な通信の乱れがあると、そのフォロワーのコミット位置が遅れる。遅れている間、そのフォロワーは **エントリは持っているのに適用できない**。読み取りをフォロワーで処理する構成では、そのぶん応答が古くなる。

書き込みが続いていれば、次の `MsgApp` が新しいコミット位置を運ぶので自然に追いつく。問題は **書き込みが止まったとき** だ。次のハートビートまで、フォロワーは古いコミット位置のままになる。

ハートビート間隔が 1 秒なら、最大 1 秒遅れる。エントリを含まない `MsgApp` を即座に送れば、この遅延を RTT 程度まで縮められる。

## ソースコードのどこか

`Progress` に専用のフィールドがある ([`tracker/progress.go#L44-L51`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L44-L51))。

```go title="tracker/progress.go"
	// sentCommit is the highest commit index in flight to the follower.
	//
	// Generally, it is monotonic, but con regress in some cases, e.g. when
	// converting to `StateProbe` or when receiving a rejection from a follower.
	//
	// In StateSnapshot, sentCommit == PendingSnapshot == Next-1.
	sentCommit uint64
```

非公開フィールドなので、`Progress` の内部でのみ更新される。「単調だが、後退することがある」と但し書きが付いている。

判定は 1 つのメソッドになっている ([`tracker/progress.go#L189-L203`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L189-L203))。

```go title="tracker/progress.go"
// CanBumpCommit returns true if sending the given commit index can potentially
// advance the follower's commit index.
func (pr *Progress) CanBumpCommit(index uint64) bool {
	// Sending the given commit index may bump the follower's commit index up to
	// Next-1 in normal operation, or higher in some rare cases. Allow sending a
	// commit index eagerly only if we haven't already sent one that bumps the
	// follower's commit all the way to Next-1.
	return index > pr.sentCommit && pr.sentCommit < pr.Next-1
}

// SentCommit updates the sentCommit.
func (pr *Progress) SentCommit(commit uint64) {
	pr.sentCommit = commit
}
```

条件が 2 つある。

**`index > pr.sentCommit`**: 既に送ったコミット位置より新しくなければ、送っても情報が増えない。

**`pr.sentCommit < pr.Next-1`**: 既に「フォロワーが持っている全エントリ」ぶんのコミット位置を送ってあるなら、それ以上送っても **フォロワー側で効かない**。

2 つ目の根拠は [ログ複製のページ](../log-replication/) で見た `min` にある。フォロワーは自分が持っている末尾を超えてコミットできない。

```go title="log.go"
	l.commitTo(min(committed, lastnewi))
```

リーダーが `Next-1` まで送っているなら、フォロワーの末尾はそこまでのはずだ。それより大きいコミット位置を送っても `min` で切られる。だから送らない。

**受け手側の処理を知っているからこそ書ける最適化** になっている。

## 呼び出し箇所

`MsgAppResp` の処理の中にある ([`raft.go#L1548-L1561`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1548-L1561))。

```go title="raft.go"
				if r.maybeCommit() {
					// committed index has progressed for the term, so it is safe
					// to respond to pending read index requests
					releasePendingReadIndexMessages(r)
					r.bcastAppend()
				} else if r.id != m.GetFrom() && pr.CanBumpCommit(r.raftLog.committed) {
					// This node may be missing the latest commit index, so send it.
					// NB: this is not strictly necessary because the periodic heartbeat
					// messages deliver commit indices too. However, a message sent now
					// may arrive earlier than the next heartbeat fires.
					r.sendAppend(m.GetFrom())
				}
```

構造が明快だ。

- **コミット位置が進んだ場合** (`maybeCommit()` が `true`): 全員に送る。新しい情報があるので全員に届ける価値がある。
- **進まなかった場合**: この応答をくれたノードだけが遅れている可能性があるので、そのノードにだけ送る。ただし `CanBumpCommit` が `true` のときだけ。

コメントの `NB:` が、この最適化の位置づけを明示している。**「厳密には不要。定期的なハートビートもコミット位置を運ぶから。ただし今送ったメッセージの方が、次のハートビートより早く着くかもしれない」**。

「なくても正しいが、あると速い」という性質のコードであることが、読む人に伝わる。消しても壊れないが、消すと遅くなる。

## 送信時の更新

コミット位置を送るところでは、必ず `SentCommit` を呼ぶ。

`MsgApp` の送信 ([`raft.go#L650-L660`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L650-L660)):

```go title="raft.go"
	r.send(&pb.Message{
		To:      new(to),
		Type:    pb.MsgApp.Enum(),
		Index:   new(prevIndex),
		LogTerm: new(prevTerm),
		Entries: ents,
		Commit:  new(r.raftLog.committed),
	})
	pr.SentEntries(len(ents), uint64(payloadsSize(ents)))
	pr.SentCommit(r.raftLog.committed)
```

ハートビートの送信 ([`raft.go#L694-L711`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L694-L711)):

```go title="raft.go"
	commit := min(pr.Match, r.raftLog.committed)
	r.send(&pb.Message{
		To:      new(to),
		Type:    pb.MsgHeartbeat.Enum(),
		Commit:  new(commit),
		Context: ctx,
	})
	pr.SentCommit(commit)
```

ハートビートでは `min(pr.Match, r.raftLog.committed)` を送る。フォロワーが持っていると **確認できている** 位置までしか進めない。エントリを載せないので、フォロワー側の `min` による安全弁が効かないからだ。

そして `SentCommit` にはその値を渡す。実際に送った値と `sentCommit` が一致する。

## 後退させる場面

`sentCommit` は原則として単調に増えるが、2 か所で後退する。

`BecomeProbe` ([`tracker/progress.go#L130-L144`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L130-L144)):

```go title="tracker/progress.go"
	pr.sentCommit = min(pr.sentCommit, pr.Next-1)
```

`StateProbe` に落ちると `Next` が下がる。`sentCommit` が `Next-1` より大きいままだと、`CanBumpCommit` の 2 つ目の条件が常に `false` になり、コミット位置を送る機会が失われる。`Next` に合わせて下げる。

`BecomeSnapshot` ([`tracker/progress.go#L153-L159`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L153-L159)):

```go title="tracker/progress.go"
	pr.Next = snapshoti + 1
	pr.sentCommit = snapshoti
```

スナップショットはコミット済みの状態を運ぶので、送った時点でフォロワーのコミット位置はスナップショットの位置になる。`sentCommit` をそこに合わせる。コメントにある不変条件 `sentCommit == PendingSnapshot == Next-1` がここで成立する。

**推測値である `Next` と連動して動く** ので、`Next` が変わるすべての場所で `sentCommit` も見直されている。

## 別の抑制: 空メッセージを送らない

`maybeSendAppend` にはもう 1 つ引数がある ([`raft.go#L608-L618`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L608-L618))。

```go title="raft.go"
// maybeSendAppend sends an append RPC with new entries to the given peer,
// if necessary. Returns true if a message was sent. The sendIfEmpty
// argument controls whether messages with no entries will be sent
// ("empty" messages are useful to convey updated Commit indexes, but
// are undesirable when we're sending multiple messages in a batch).
func (r *raft) maybeSendAppend(to uint64, sendIfEmpty bool) bool {
```

**空メッセージはコミット位置を伝えるのに有用だが、バッチ送信の途中では望ましくない**。

バッチ送信の場面 ([`raft.go#L1562-L1571`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1562-L1571)):

```go title="raft.go"
				// We've updated flow control information above, which may
				// allow us to send multiple (size-limited) in-flight messages
				// at once (such as when transitioning from probe to
				// replicate, or when freeTo() covers multiple messages). If
				// we have more entries to send, send as many messages as we
				// can (without sending empty messages for the commit index)
				if r.id != m.GetFrom() {
					for r.maybeSendAppend(m.GetFrom(), false /* sendIfEmpty */) {
					}
				}
```

窓が解放されたとき、送れるだけ送るループを回している。`sendIfEmpty = false` なので、送るエントリがなくなったら `false` が返ってループが終わる。**終了条件を引数で表現している**。

構成変更の直後にも使われる ([`raft.go#L2019-L2027`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L2019-L2027))。

```go title="raft.go"
	} else {
		// Otherwise, still probe the newly added replicas; there's no reason to
		// let them wait out a heartbeat interval (or the next incoming
		// proposal).
		r.trk.Visit(func(id uint64, _ *tracker.Progress) {
			if id == r.id {
				return
			}
			r.maybeSendAppend(id, false /* sendIfEmpty */)
		})
	}
```

新しく追加されたレプリカに、ハートビート間隔を待たせずに探りを入れる。ここでも空メッセージは送らない。

## なぜそうなっているか

コミット位置の伝播には、3 つの経路がある。

| 経路                    | 頻度                 | 運ぶもの                                   |
| ----------------------- | -------------------- | ------------------------------------------ |
| `MsgApp` (エントリあり) | 提案があるたび       | エントリ + コミット位置                    |
| `MsgHeartbeat`          | ハートビート間隔ごと | コミット位置のみ (`min(Match, committed)`) |
| `MsgApp` (エントリなし) | 必要と判断したとき   | コミット位置のみ                           |

1 つ目が主経路で、書き込みが続いていればこれで足りる。2 つ目が保険で、必ず届くが遅い。3 つ目が最適化で、速いが無駄になりうる。

3 つ目を無条件に送ると、`MsgAppResp` を受けるたびに `MsgApp` を返すことになる。フォロワーがそれに応答すればまた `MsgApp` を送る。**応答の往復が止まらなくなる**。

`CanBumpCommit` の 2 条件は、この往復を止める。送っても相手の状態が変わらないなら送らない。相手の状態がどう変わるかを計算できるから、この判定が書ける。

**冗長な経路を複数持ちつつ、無駄を判定で落とす** という構成になっている。どれか 1 つが失われても正しさは保たれ、全部が揃っていると速い。

## どう活かすか

- **送信済みの状態を記録して、冗長な送信を落とす**。「相手に何を伝えたか」を持っておくと、次に送るべきかを判定できる。相手の状態を推測するより、自分が送ったものを覚える方が確実になる。
- **受け手の処理を踏まえて判定する**。`sentCommit < Next-1` は、受け手が `min` を取ることを知っているから書ける。プロトコルの両側を持っているなら、この種の最適化が可能になる。
- **「なくても正しい」ことをコメントに書く**。`NB: this is not strictly necessary` のような注記があると、後から性能調整でこのコードを触るときの判断材料になる。
- **推測値と連動する値は、推測値が変わる全箇所で見直す**。`Next` が動く場所すべてで `sentCommit` も調整されている。片方だけ更新すると、判定が永久に成立しなくなる。
- **終了条件を引数で表現する**。`sendIfEmpty=false` は「送るものがなくなったら止まれ」を意味し、`for` ループの条件がそのまま書ける。
- **冗長な経路を残したうえで最適化する**。ハートビートという遅いが確実な経路があるから、速い経路を「送らない」と判断しても止まらない。最適化が保険を壊さない構成にする。
