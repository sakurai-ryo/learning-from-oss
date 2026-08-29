---
title: "任期・投票・ログ。この 3 つをディスクに書くタイミングが、Raft の安全性の土台になる"
description: "Raft が再起動をまたいで覚えていなければならない状態は何か、そしてそれを「いつ」書かなければならないか。etcd-io/raft は HardState という 3 フィールドの型でそれを表し、「返答を送る前に永続化されていなければならない」規則を send 関数の中で強制している。MustSync が false になる条件も、この規則の裏返しとして読める。"
group: "Raft を理解する"
sidebar:
  order: 6
---

ここまで、ノードが落ちて復帰する話を何度もしてきた。復帰したノードは何を覚えていなければならないのか。このページはそれを扱う。

## 覚えていなければならない 3 つ

Raft 論文 (thesis) の 3.8 節が、必要な永続状態を挙げている。`etcd-io/raft` はそれを `send` 関数のコメントに引用している ([`raft.go#L563-L571`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L563-L571))。

```go title="raft.go"
		// Per the Raft thesis, section 3.8 Persisted state and server restarts:
		//
		// > Raft servers must persist enough information to stable storage to
		// > survive server restarts safely. In particular, each server persists
		// > its current term and vote; this is necessary to prevent the server
		// > from voting twice in the same term or replacing log entries from a
		// > newer leader with those from a deposed leader. Each server also
		// > persists new log entries before they are counted towards the entries’
		// > commitment; this prevents committed entries from being lost or
		// > “uncommitted” when servers restart
```

3 つある。

**現在の任期 (`currentTerm`)**。これを忘れると、復帰したノードが古い任期に戻る。古い任期のリーダーからのメッセージを受け入れてしまい、新しいリーダーが書いたエントリを上書きしうる。

**投票先 (`votedFor`)**。これを忘れると、同じ任期で 2 回投票できてしまう。「1 任期 1 票」が破れると、同じ任期に 2 人のリーダーが立つ。Election Safety の直接の違反になる。

**ログエントリ**。これを忘れると、コミット済みのエントリが失われる。過半数のうち 1 台が「書いた」と答えた後に忘れると、コミットの根拠が崩れる。

`etcd-io/raft` は、このうち最初の 2 つとコミット位置をまとめて `HardState` と呼んでいる ([`raftpb/raft.proto#L133-L137`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raftpb/raft.proto#L133-L137))。

```protobuf title="raftpb/raft.proto"
message HardState {
	optional uint64 term   = 1;
	optional uint64 vote   = 2;
	optional uint64 commit = 3;
}
```

対になるのが `SoftState` で、こちらは永続化しなくてよい ([`node.go#L38-L43`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/node.go#L38-L43))。

```go title="node.go"
// SoftState provides state that is useful for logging and debugging.
// The state is volatile and does not need to be persisted to the WAL.
type SoftState struct {
	Lead      uint64 // must use atomic operations to access; keep 64-bit aligned.
	RaftState StateType
}
```

「誰がリーダーか」「自分は今どの役割か」は失っても構わない。再起動したノードは必ずフォロワーから始まり、リーダーが誰かはハートビートを受ければ分かる。**再構築できるものは書かない** という切り分けになっている。

## commit は 3 つ目に含まれるのか

`HardState` に `commit` が入っているが、上に挙げた 3 つに「コミット位置」は無かった。実際、コミット位置は失っても安全性は壊れない。**ログさえ残っていれば、リーダーから送られてくる `Commit` フィールドでいずれ復元される** からだ。

では何のために書くのか。復帰の速さのためだ。コミット位置を覚えていれば、再起動直後から手元のログを適用できる。忘れていると、リーダーからの最初のメッセージを待つことになる。

この違いが `MustSync` に現れている ([`rawnode.go#L191-L199`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L191-L199))。

```go title="rawnode.go"
// MustSync returns true if the hard state and count of Raft entries indicate
// that a synchronous write to persistent storage is required.
func MustSync(st, prevst *pb.HardState, entsnum int) bool {
	// Persistent state on all servers:
	// (Updated on stable storage before responding to RPCs)
	// currentTerm
	// votedFor
	// log entries[]
	return entsnum != 0 || st.GetVote() != prevst.GetVote() || st.GetTerm() != prevst.GetTerm()
}
```

`Term` か `Vote` が変わったとき、あるいはエントリが増えたときだけ `true` になる。**`Commit` だけが変わったときは `false`** だ。つまり「書いてもいいが `fsync` は要らない」。

これは実際の性能に効く。定常状態のリーダーは、エントリを追記しない tick でもコミット位置を進める。そのたびに `fsync` していたら遅い。安全性に必要なところだけ同期を取る、という区別が型のレベルで表現されている。

## 「返答を送る前に書け」

もっと重要なのは、**いつ** 書くかだ。上の引用にある `(Updated on stable storage before responding to RPCs)` がそれを言っている。

- 投票に賛成する返答を送る **前** に、`votedFor` がディスクにある。
- ログを受け取ったという返答を送る **前** に、そのエントリがディスクにある。

順序が逆だと壊れる。「投票します」と答えた直後に落ちて、投票を忘れて復帰し、同じ任期で別の候補者に投票したら、リーダーが 2 人になる。

`etcd-io/raft` はこの規則を、**メッセージを 2 つのキューに分ける** ことで強制している ([`raft.go#L545-L594`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L545-L594))。

```go title="raft.go"
	if m.GetType() == pb.MsgAppResp || m.GetType() == pb.MsgVoteResp || m.GetType() == pb.MsgPreVoteResp {
		// ...
		// To enforce this durability requirement, these response messages are
		// queued to be sent out as soon as the current collection of unstable
		// state (the state that the response message was predicated upon) has
		// been durably persisted.
		r.msgsAfterAppend = append(r.msgsAfterAppend, m)
		traceSendMessage(r, m)
	} else {
		if m.GetTo() == r.id {
			r.logger.Panicf("message should not be self-addressed when sending %s", m.GetType())
		}
		r.msgs = append(r.msgs, m)
		traceSendMessage(r, m)
	}
```

`MsgAppResp` (ログを受け取った) と `MsgVoteResp` / `MsgPreVoteResp` (投票した) の 3 種類だけが `msgsAfterAppend` に入る。それ以外は `msgs` に入り、すぐ送ってよい。

この分割については [msgsAfterAppend のページ](../msgs-after-append/) で詳しく扱う。ここでは「Raft の永続化規則が、コード上ではキューの選択として現れる」ことだけ押さえておけばいい。

拒否の返答についても、コメントが判断を残している。

```go title="raft.go"
		// Rejected responses (m.Reject == true) present an interesting case
		// where the durability requirement is less unambiguous.
		// ...
		// However, because these rejections are rare and
		// because the safety of such behavior has not been formally verified,
		// we err on the side of safety and omit a `&& !m.Reject` condition
		// above.
```

拒否は永続化を待たなくても安全そうだが、形式的に検証されていないので安全側に倒す、と書いてある。「たぶん大丈夫」を採らない判断が明記されているのは珍しい。

## 自分への投票も、自分へのログ受領も、メッセージにする

この規則は自分自身にも適用される。候補者が自分に投票するとき、リーダーが自分のログにエントリを書くとき、どちらも「ディスクに書いてから有効」でなければならない。

そこで `etcd-io/raft` は、**自分宛のメッセージを自分に送る** ([`raft.go#L1053-L1060`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1053-L1060))。

```go title="raft.go"
		if id == r.id {
			// The candidate votes for itself and should account for this self
			// vote once the vote has been durably persisted (since it doesn't
			// send a MsgVote to itself). This response message will be added to
			// msgsAfterAppend and delivered back to this node after the vote
			// has been written to stable storage.
			r.send(&pb.Message{To: new(id), Term: new(term), Type: voteRespMsgType(voteMsg).Enum()})
			continue
		}
```

リーダー側も同じだ ([`raft.go#L837-L847`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L837-L847))。

```go title="raft.go"
	// The leader needs to self-ack the entries just appended once they have
	// been durably persisted (since it doesn't send an MsgApp to itself). This
	// response message will be added to msgsAfterAppend and delivered back to
	// this node after these entries have been written to stable storage. When
	// handled, this is roughly equivalent to:
	//
	//  r.trk.Progress[r.id].MaybeUpdate(e.Index)
	//  if r.maybeCommit() {
	//  	r.bcastAppend()
	//  }
	r.send(&pb.Message{To: new(r.id), Type: pb.MsgAppResp.Enum(), Index: new(li)})
```

コメントが「これは実質的にこう書くのと同じだ」と等価なコードを示している。直接書かない理由は、**そう書くと永続化を待たないから** だ。リーダー自身も定足数の 1 票として数えられるので、「まだディスクにないエントリ」を数えてしまうとコミットの根拠が崩れる。

自分自身を特別扱いせず、他のノードと同じ経路に通す。これは [「全部を Message にする」のページ](../everything-is-a-message/) で扱う設計の一貫だ。

## 再起動時に何が復元されるか

`etcd-io/raft` は自分ではディスクを触らない。復元は `Storage` インターフェース経由で行う ([`storage.go#L48-L60`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L48-L60))。

```go title="storage.go"
type Storage interface {
	// InitialState returns the saved HardState and ConfState information.
	InitialState() (*pb.HardState, *pb.ConfState, error)
```

`newRaft` はこれを呼び、`HardState` を自分に読み込む ([`raft.go#L487-L492`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L487-L492))。

```go title="raft.go"
	if !IsEmptyHardState(hs) {
		r.loadState(hs)
	}
	if c.Applied > 0 {
		raftlog.appliedTo(c.Applied, 0 /* size */)
	}
	r.becomeFollower(r.Term, None)
```

`loadState` には検査が入っている ([`raft.go#L2037-L2047`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L2037-L2047))。

```go title="raft.go"
func (r *raft) loadState(state *pb.HardState) {
	if state.GetCommit() < r.raftLog.committed || state.GetCommit() > r.raftLog.lastIndex() {
		r.logger.Panicf("%x state.commit %d is out of range [%d, %d]", r.id, state.GetCommit(), r.raftLog.committed, r.raftLog.lastIndex())
	}
	r.raftLog.committed = state.GetCommit()
	r.Term = state.GetTerm()
	r.Vote = state.GetVote()
}
```

「コミット位置として保存されている値が、実際に持っているログの範囲に収まっているか」を検査する。収まっていなければ、ログの一部が失われているということなので panic する。**ストレージ層の不整合を、起動時のいちばん早いタイミングで検出する** 設計になっている。

そして最後の行 `r.becomeFollower(r.Term, None)` — **再起動したノードは必ずフォロワーから始まる**。リーダーだったノードが再起動しても、リーダーとしては戻らない。`SoftState` を永続化しない理由がここにある。

## Applied は利用側が渡す

`Config.Applied` だけは、`Storage` からではなく利用側が明示的に渡す ([`raft.go#L146-L152`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L146-L152))。

```go title="raft.go"
	// Applied is the last applied index. It should only be set when restarting
	// raft. raft will not return entries to the application smaller or equal to
	// Applied. If Applied is unset when restarting, raft might return previous
	// applied entries. This is a very application dependent configuration.
	Applied uint64
```

「どこまで状態機械に適用したか」は Raft の関心事ではなく、状態機械側の話だからだ。指定しなければ、既に適用済みのエントリが再び返ってくる可能性がある。それでも壊れないように、**状態機械の適用は冪等でなければならない** か、あるいは適用位置を状態機械と同じトランザクションで記録しておかなければならない。

etcd 本体はこれを consistentIndex という値で解いている。この章の対象外だが、[etcd の章](../../etcd/consistent-index/) で扱っている。

## エントリの永続化と「上書き」

もう 1 つ、README が強調している注意がある。

> Note that when writing an Entry with Index i, any previously-persisted entries with Index >= i must be discarded.

インデックス `i` のエントリを書くときは、既に保存されている `i` 以上のエントリを捨てなければならない。[ログ複製のページ](../log-replication/) で見た「食い違いはリーダーが上書きする」が、ストレージ層にも要求として降りてくる。

追記専用のログファイルにこれを実装する場合、「後から書いたものが勝つ」という読み出し規則にするか、切り詰めを実装するかのどちらかになる。この上書きが正しく行われないと、[非同期ストレージ書き込みのページ](../async-storage-writes/) で扱う ABA 問題のような、順序に依存した不具合が出る。

## まとめ

- 永続化しなければならないのは、任期・投票先・ログエントリの 3 つ。コミット位置は速さのために書くが、`fsync` は要らない。
- 書く **タイミング** が本質。投票やログ受領の返答は、対応する状態がディスクに乗ってから送る。
- `etcd-io/raft` はこれを「返答だけ別キューに入れる」ことで強制し、自分自身への返答も同じ経路に通す。
- 再起動時は必ずフォロワーから始まる。`SoftState` は永続化しない。

次のページで、ログを無限に持たなくて済むようにする仕組みを扱う。
