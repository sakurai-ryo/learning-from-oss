---
title: "リーダーは、直前の 1 エントリだけを見せて、フォロワーのログ全体の一致を保証する"
description: "Raft のログ複製と、その土台にあるログマッチング特性。直前のエントリの (index, term) だけを添えた一致検査が、なぜログ全体の一致を導けるのか。食い違ったときに何が起きるのか。etcd-io/raft の maybeSendAppend / handleAppendEntries / findConflict を追いながら、帰納法で成り立つ不変条件を確認する。"
group: "Raft を理解する"
sidebar:
  order: 3
---

リーダーが決まった。次は、リーダーが受け付けた操作をフォロワーに配る話に入る。

## リーダーがすること

クライアントから操作が来ると、リーダーは次の順に動く。

1. 操作を **エントリ** にして、自分のログの末尾に追加する。エントリには現在の任期と、追加した位置のインデックスが刻まれる。
2. 全フォロワーに **複製メッセージ (AppendEntries、`etcd-io/raft` では `MsgApp`)** を送る。
3. 過半数のフォロワーがそのエントリを自分のログに書いたと答えたら、そのエントリを **コミット** する。
4. 状態機械に適用して、クライアントに応答する。

`etcd-io/raft` でエントリを作っているのが `appendEntry` だ ([`raft.go#L812-L822`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L812-L822))。

```go title="raft.go"
func (r *raft) appendEntry(es ...*pb.Entry) (accepted bool) {
	li := r.raftLog.lastIndex()
	cloned := make([]*pb.Entry, len(es))
	for i := range es {
		cloned[i] = proto.Clone(es[i]).(*pb.Entry)
		cloned[i].Term = new(r.Term)
		cloned[i].Index = new(li + 1 + uint64(i))
	}
```

利用側が渡すのは `Data` だけで、`Term` と `Index` はここで刻まれる。**エントリの任期は「どの任期のリーダーがそれを作ったか」** であって、「今の任期」ではない。リーダーが変わっても、過去のエントリの任期は書き換わらない。この不変性が後で効いてくる。

## ログマッチング特性

Raft のログには、次の 2 つの性質がある。合わせて **ログマッチング特性 (Log Matching Property)** と呼ぶ。

1. 2 つのログが、**同じインデックスに同じ任期のエントリ** を持つなら、そのエントリの中身は同一である。
2. 2 つのログが、同じインデックスに同じ任期のエントリを持つなら、**それ以前の全エントリも同一** である。

1 つ目は簡単だ。1 つの任期にリーダーは 1 人しかおらず、リーダーは同じインデックスに 2 回書かないので、`(index, term)` の組がエントリを一意に決める。`etcd-io/raft` はこれを型のコメントとして明記している ([`types.go#L24-L31`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/types.go#L24-L31))。

```go title="types.go"
// entryID uniquely identifies a raft log entry.
//
// Every entry is associated with a leadership term which issued this entry and
// initially appended it to the log. There can only be one leader at any term,
// and a leader never issues two entries with the same index.
type entryID struct {
	term  uint64
	index uint64
}
```

2 つ目が本題だ。これは無条件に成り立つ性質ではなく、**複製時の一致検査によって維持される** 不変条件になっている。

## 一致検査

リーダーは複製メッセージに、送るエントリだけでなく **その直前のエントリの `(index, term)`** を添える。フォロワーは、自分のログのその位置に同じ任期のエントリを持っていなければ、複製を **拒否** する。

```
リーダーのログ:  [1:t1][2:t1][3:t2][4:t2][5:t3]
                                    ↑ここから送りたい

MsgApp: prev=(index=4, term=2), entries=[5:t3]

フォロワー A: [1:t1][2:t1][3:t2][4:t2]      → index4 が t2 で一致 → 受け入れ
フォロワー B: [1:t1][2:t1][3:t2]            → index4 が無い     → 拒否
フォロワー C: [1:t1][2:t1][3:t2][4:t9]      → index4 が t9 で不一致 → 拒否
```

送信側は `maybeSendAppend` にある ([`raft.go#L618-L662`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L618-L662))。

```go title="raft.go"
	prevIndex := pr.Next - 1
	prevTerm, err := r.raftLog.term(prevIndex)
	if err != nil {
		// The log probably got truncated at >= pr.Next, so we can't catch up the
		// follower log anymore. Send a snapshot instead.
		return r.maybeSendSnapshot(to, pr)
	}
	// ...
	r.send(&pb.Message{
		To:      new(to),
		Type:    pb.MsgApp.Enum(),
		Index:   new(prevIndex),
		LogTerm: new(prevTerm),
		Entries: ents,
		Commit:  new(r.raftLog.committed),
	})
```

`Index` と `LogTerm` が「直前のエントリ」を指す。`Commit` はリーダーのコミット位置で、これも一緒に運ばれる。

受信側は `handleAppendEntries` → `maybeAppend` と進む ([`log.go#L109-L131`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L109-L131))。

```go title="log.go"
func (l *raftLog) maybeAppend(a logSlice, committed uint64) (lastnewi uint64, ok bool) {
	if !l.matchTerm(a.prev) {
		return 0, false
	}
	lastnewi = a.prev.index + uint64(len(a.entries))
	ci := l.findConflict(a.entries)
	switch {
	case ci == 0:
	case ci <= l.committed:
		l.logger.Panicf("entry %d conflict with committed entry [committed(%d)]", ci, l.committed)
	default:
		offset := a.prev.index + 1
		if ci-offset > uint64(len(a.entries)) {
			l.logger.Panicf("index, %d, is out of range [%d]", ci-offset, len(a.entries))
		}
		l.append(a.entries[ci-offset:]...)
	}
	l.commitTo(min(committed, lastnewi))
	return lastnewi, true
}
```

`matchTerm(a.prev)` が一致検査だ。ここを通らなければ即 `false` を返す。

## なぜ 1 点の検査で全体が保証されるのか

「直前の 1 エントリだけ」を見て、なぜログ **全体** の一致が言えるのか。帰納法になっている。

- ログが空の状態では、両者は自明に一致している。
- 複製が成功したということは、`prev` の位置で任期が一致していた。ログマッチング特性の 2 つ目により、`prev` 以前は全部一致している。
- その後ろに、リーダーが送ったのと同じエントリを書いたのだから、新しい末尾まで一致している。

つまり **「今まで一致していた」という不変条件を、一致検査が各ステップで維持する**。そのため各エントリを個別に検証する必要がない。ログが 100 万件あっても、送るのは直前 1 件の `(index, term)` だけで済む。

`etcd-io/raft` はこの不変条件を `logSlice` 型のコメントに書き下している ([`types.go#L38-L48`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/types.go#L38-L48))。

```go title="types.go"
// Two slices with a matching logSlice.term are guaranteed to be consistent,
// i.e. they never contain two different entries at the same index. The reverse
// is not true: two slices with different logSlice.term may contain both
// matching and mismatching entries. Specifically, logs at two different leader
// terms share a common prefix, after which they *permanently* diverge.
```

「共通の接頭辞を持ち、そこから先は **永久に** 分岐する」というのが、ログ同士の関係の全体像になる。

## 食い違いはリーダーが上書きする

拒否された場合、リーダーはそのフォロワーに送る位置を 1 つ戻して、再度試す。一致するところまで戻れば、そこから先はリーダーの内容で上書きされる。

```
リーダー:      [1:t1][2:t1][3:t2][4:t2][5:t3]
フォロワー C:  [1:t1][2:t1][3:t9][4:t9]

prev=(4,t2) → 拒否
prev=(3,t2) → 拒否
prev=(2,t1) → 一致！ ここから [3:t2][4:t2][5:t3] で上書き
```

ここで重要なのが **リーダーは自分のログを絶対に書き換えない** という規則だ。合わせるのは常にフォロワー側になる。「リーダーのログが正しい」を無条件の前提にしてよいのは、[安全性のページ](../safety/) で扱う選挙制限があるからだ。

食い違いの検出は `findConflict` にある ([`log.go#L154-L167`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L154-L167))。

```go title="log.go"
func (l *raftLog) findConflict(ents []*pb.Entry) uint64 {
	for i := range ents {
		if id := pbEntryID(ents[i]); !l.matchTerm(id) {
			if id.index <= l.lastIndex() {
				l.logger.Infof("found conflict at index %d [existing term: %d, conflicting term: %d]",
					id.index, l.zeroTermOnOutOfBounds(l.term(id.index)), id.term)
			}
			return id.index
		}
	}
	return 0
}
```

送られてきたエントリを先頭から見て、最初に一致しない位置を返す。全部一致していれば 0 を返し、そのときは何も書かない — 再送されたメッセージを二重に書かないための処理でもある。

上書きの実体は `unstable.truncateAndAppend` だ ([`log_unstable.go#L191-L211`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log_unstable.go#L191-L211))。

```go title="log_unstable.go"
	default:
		// Truncate to fromIndex (exclusive), and append the new entries.
		u.logger.Infof("truncate the unstable entries before index %d", fromIndex)
		keep := u.slice(u.offset, fromIndex) // NB: appending to this slice is safe,
		u.entries = append(keep, ents...)    // and will reallocate/copy it
```

`maybeAppend` の中に `ci <= l.committed` で panic する分岐があるのに注目してほしい。**コミット済みのエントリと食い違うエントリが送られてきたら、それはバグかディスク破損** であって、正常系ではありえない。黙って上書きするのではなく落とす。この「ありえないことが起きたら止まる」という書き方はこのライブラリ全体に散らばっている。

## リーダー側の進捗管理

リーダーは、フォロワーごとに **どこまで届いたか** を覚えている。`tracker.Progress` の 2 つのフィールドがそれだ ([`tracker/progress.go#L30-L42`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L30-L42))。

```go title="tracker/progress.go"
	// Match is the index up to which the follower's log is known to match the
	// leader's.
	Match uint64
	// Next is the log index of the next entry to send to this follower. All
	// entries with indices in (Match, Next) interval are already in flight.
	//
	// Invariant: 0 <= Match < Next.
	Next uint64
```

- `Match`: そこまで確実に一致していると **分かっている** 位置。確認済みの事実。
- `Next`: 次に送る位置。**推測** であり、外れたら戻す。

新しくリーダーになった時点では、フォロワーのログがどうなっているか分からない。`reset` は `Match = 0`、`Next = 自分の末尾 + 1` から始める ([`raft.go#L794-L804`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L794-L804))。

```go title="raft.go"
	r.trk.Visit(func(id uint64, pr *tracker.Progress) {
		*pr = tracker.Progress{
			Match:     0,
			Next:      r.raftLog.lastIndex() + 1,
			Inflights: tracker.NewInflights(r.trk.MaxInflight, r.trk.MaxInflightBytes),
			IsLearner: pr.IsLearner,
		}
		if id == r.id {
			pr.Match = r.raftLog.lastIndex()
		}
	})
```

「フォロワーは自分と同じところまで持っているはずだ」という楽観的な推測から始めて、拒否されるたびに `Next` を下げていく。この探り方を素朴にやると遅くなる場合があり、そこに大きな最適化が入っている。[探索の最適化のページ](../probe-optimization/) で扱う。

## 返答と拒否ヒント

フォロワーの返答は `MsgAppResp` で、受け入れたか拒否したかを `Reject` で示す ([`raft.go#L1791-L1832`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1791-L1832))。

```go title="raft.go"
	if mlastIndex, ok := r.raftLog.maybeAppend(a, m.GetCommit()); ok {
		r.send(&pb.Message{To: m.From, Type: pb.MsgAppResp.Enum(), Index: new(mlastIndex)})
		return
	}
	// ...
	hintIndex := min(m.GetIndex(), r.raftLog.lastIndex())
	hintIndex, hintTerm := r.raftLog.findConflictByTerm(hintIndex, m.GetLogTerm())
	r.send(&pb.Message{
		To:         m.From,
		Type:       pb.MsgAppResp.Enum(),
		Index:      new(m.GetIndex()),
		Reject:     new(true),
		RejectHint: new(hintIndex),
		LogTerm:    new(hintTerm),
	})
```

受け入れたときは、書き込んだ末尾のインデックスを返す。リーダーはそれで `Match` を更新する。拒否したときは `RejectHint` として「ここから試すといい」という位置を返す。ただ 1 つ戻すのではなく、フォロワー自身の知識を使って一気に飛ばした位置を返している。

`handleAppendEntries` の冒頭には、もう 1 つ早期リターンがある ([`raft.go#L1795-L1798`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1795-L1798))。

```go title="raft.go"
	if a.prev.index < r.raftLog.committed {
		r.send(&pb.Message{To: m.From, Type: pb.MsgAppResp.Enum(), Index: new(r.raftLog.committed)})
		return
	}
```

`prev` が自分のコミット位置より手前を指しているなら、そのメッセージは古い。一致検査すらせずに「私はもう `committed` まで持っている」と返す。リーダーはこれを受けて一気に `Match` を上げられる。

## コミット位置の伝播

リーダーがコミットしたことを、フォロワーはどうやって知るか。答えは **次のメッセージに載せる** だ。上で見たとおり、`MsgApp` は常に `Commit: r.raftLog.committed` を運んでいる。

フォロワー側は受け取ったコミット位置まで自分のコミット位置を進める。ただし **自分が持っている末尾を超えて進めてはいけない** ([`log.go#L109-L131`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L109-L131) の末尾)。

```go title="log.go"
	l.commitTo(min(committed, lastnewi))
```

`min` を取っているのがそれだ。「リーダーは index 10 までコミット済み」と言われても、自分が index 7 までしか持っていなければ、7 までしかコミットできない。

ハートビートにもコミット位置は載る。こちらはもう少し慎重で、`min(pr.Match, r.raftLog.committed)` を送る ([`raft.go#L694-L710`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L694-L710))。

```go title="raft.go"
	// Attach the commit as min(to.matched, r.committed).
	// When the leader sends out heartbeat message,
	// the receiver(follower) might not be matched with the leader
	// or it might not have all the committed entries.
	// The leader MUST NOT forward the follower's commit to
	// an unmatched index.
	commit := min(pr.Match, r.raftLog.committed)
```

ハートビートにはエントリが載らないので、フォロワー側で `min(committed, lastnewi)` による安全弁がかからない。そのぶんリーダー側で絞っている。「フォロワーが実際に持っていると分かっている位置」を超えてコミットを進めさせない、という同じ判断がリーダー側に移動しているだけだ。

## この時点での全体像

ここまでで、正常時のログ複製は一通り揃った。

```
クライアント
    │ propose
    ▼
┌─────────┐  MsgApp(prev, entries, commit)   ┌──────────┐
│ Leader  │ ───────────────────────────────► │ Follower │
│         │                                   │ 一致検査 │
│ Progress│ ◄─────────────────────────────── │ 追記     │
│ Match   │  MsgAppResp(index / reject+hint)  └──────────┘
│ Next    │
└─────────┘
    │ 過半数の Match が届いたら commit
    ▼
状態機械に apply → クライアントに応答
```

ただし「過半数の `Match` が届いたらコミット」には、まだ書いていない重要な例外がある。次のページはそれを扱う。
