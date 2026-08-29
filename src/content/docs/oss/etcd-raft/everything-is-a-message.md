---
title: "タイマー発火も提案もローカル I/O の完了も、全部 1 つの Message 型で表す"
description: "etcd-io/raft には Step というただ 1 つの入口しかない。ネットワークから来たメッセージも、タイマーの発火も、クライアントの提案も、ローカルディスクへの書き込み完了も、すべて同じ pb.Message として Step に入る。ノード ID の予約値でローカルスレッドを宛先にする手口と、それが決定性・トレース・テストにもたらすもの。"
group: "ライブラリとしての骨格"
sidebar:
  order: 10
---

## 何を学んだか

**状態機械への入力を 1 つの型に統一すると、入口が 1 つになり、ログ・トレース・テスト・順序制御が全部そこに集まる。** `etcd-io/raft` は、ネットワーク越しのメッセージだけでなく、タイマーの発火、クライアントの提案、自分自身への投票、さらには **ローカルディスクへの書き込み完了通知** まで、すべて `pb.Message` として表現し、`Step()` という 1 つの関数に流す。

そのために、`uint64` のノード ID 空間に 2 つの予約値を置いて、**ローカルのスレッドを「宛先ノード」として扱えるようにしている**。

## ソースコードのどこか

メッセージ型は 24 種類ある ([`raftpb/raft.proto#L33-L56`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raftpb/raft.proto#L33-L56))。

```protobuf title="raftpb/raft.proto"
	MsgHup               = 0;
	MsgBeat              = 1;
	MsgProp              = 2;
	MsgApp               = 3;
	MsgAppResp           = 4;
	MsgVote              = 5;
	MsgVoteResp          = 6;
	MsgSnap              = 7;
	MsgHeartbeat         = 8;
	MsgHeartbeatResp     = 9;
	MsgUnreachable       = 10;
	MsgSnapStatus        = 11;
	MsgCheckQuorum       = 12;
	MsgTransferLeader    = 13;
	MsgTimeoutNow        = 14;
	MsgReadIndex         = 15;
	MsgReadIndexResp     = 16;
	MsgPreVote           = 17;
	MsgPreVoteResp       = 18;
	MsgStorageAppend     = 19;
	MsgStorageAppendResp = 20;
	MsgStorageApply      = 21;
	MsgStorageApplyResp  = 22;
	MsgForgetLeader      = 23;
```

このうち **ネットワークを流れるのは半分程度** だ。残りはローカル起源のイベントで、`isLocalMsg` という配列で区別されている ([`util.go#L31-L65`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/util.go#L31-L65))。

```go title="util.go"
var isLocalMsg = [...]bool{
	pb.MsgHup:               true,
	pb.MsgBeat:              true,
	pb.MsgUnreachable:       true,
	pb.MsgSnapStatus:        true,
	pb.MsgCheckQuorum:       true,
	pb.MsgStorageAppend:     true,
	pb.MsgStorageAppendResp: true,
	pb.MsgStorageApply:      true,
	pb.MsgStorageApplyResp:  true,
}
```

それぞれの出どころを見ていく。

**`MsgHup`**: 選挙タイムアウト。`tickElection` が自分自身に送る ([`raft.go#L850-L860`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L850-L860))。

```go title="raft.go"
	if r.promotable() && r.pastElectionTimeout() {
		r.electionElapsed = 0
		if err := r.Step(&pb.Message{From: new(r.id), Type: pb.MsgHup.Enum()}); err != nil {
			r.logger.Debugf("error occurred during election: %v", err)
		}
	}
```

**`MsgBeat` / `MsgCheckQuorum`**: ハートビートタイマーと定足数確認タイマー。どちらも `tickHeartbeat` が自分に送る ([`raft.go#L862-L889`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L862-L889))。

**`MsgProp`**: クライアントの提案。`Node.Propose()` がメッセージに包む ([`node.go#L471-L473`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/node.go#L471-L473))。

```go title="node.go"
func (n *node) Propose(ctx context.Context, data []byte) error {
	return n.stepWait(ctx, &pb.Message{Type: pb.MsgProp.Enum(), Entries: []*pb.Entry{{Data: data}}})
}
```

**`MsgUnreachable` / `MsgSnapStatus`**: 「送れなかった」「スナップショットの転送が終わった/失敗した」という、トランスポート層からの報告。

**`MsgStorage*`**: ローカルストレージへの書き込み指示と、その完了通知。これは [非同期ストレージ書き込みのページ](../async-storage-writes/) で扱う。

ローカルメッセージは `Term` を持たない。だから `Step` の冒頭の任期処理は、まずそれを弾く ([`raft.go#L1097-L1099`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1097-L1099))。

```go title="raft.go"
	switch {
	case m.GetTerm() == 0:
		// local message
```

## ノード ID 空間の予約値

いちばん目を引くのが、**ローカルのスレッドをノード ID で表している** ことだ ([`raft.go#L36-L47`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L36-L47))。

```go title="raft.go"
const (
	// None is a placeholder node ID used when there is no leader.
	None uint64 = 0
	// LocalAppendThread is a reference to a local thread that saves unstable
	// log entries and snapshots to stable storage. The identifier is used as a
	// target for MsgStorageAppend messages when AsyncStorageWrites is enabled.
	LocalAppendThread uint64 = math.MaxUint64
	// LocalApplyThread is a reference to a local thread that applies committed
	// log entries to the local state machine. The identifier is used as a
	// target for MsgStorageApply messages when AsyncStorageWrites is enabled.
	LocalApplyThread uint64 = math.MaxUint64 - 1
)
```

`uint64` の両端が予約されている。0 は「リーダー不在」、最大値とその 1 つ手前が「ログ追記スレッド」「適用スレッド」。

これにより、**「ディスクに書け」という指示が、他のノードへのメッセージとまったく同じ形になる**。

```go title="rawnode.go"
func newStorageAppendMsg(r *raft, rd Ready) *pb.Message {
	m := &pb.Message{
		Type:    pb.MsgStorageAppend.Enum(),
		To:      new(LocalAppendThread),
		From:    new(r.id),
		Entries: rd.Entries,
	}
```

`To` がローカルスレッド、`From` が自分。この `Message` を受け取った利用側は、宛先を見て「これはディスク書き込みだ」と判断し、書き終わったら `Responses` に入っているメッセージを配送する。

判定は専用の関数になっている ([`util.go#L67-L70`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/util.go#L67-L70))。

```go title="util.go"
// IsLocalMsgTarget returns true if the message target is a local raft node.
func IsLocalMsgTarget(id uint64) bool {
	return id == LocalAppendThread || id == LocalApplyThread
}
```

`Config.validate()` は、この予約値を自分の ID に使うことを禁じている ([`raft.go#L294-L299`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L294-L299))。

```go title="raft.go"
	if c.ID == None {
		return errors.New("cannot use none as id")
	}
	if IsLocalMsgTarget(c.ID) {
		return errors.New("cannot use local target as id")
	}
```

ID 空間を借りる代わりに、借りた分を使えなくする。誤用は起動時に落ちる。

## 自分自身にもメッセージを送る

[永続化のページ](../persistent-state/) で見たとおり、候補者の自票もリーダーの自己確認も、メッセージとして自分に送られる。

```go title="raft.go"
	r.send(&pb.Message{To: new(r.id), Type: pb.MsgAppResp.Enum(), Index: new(li)})
```

直接フィールドを更新すれば 1 行で済むところを、わざわざメッセージにしている。理由は永続化の順序を守るためだが、副産物として **自分自身が「特別なノード」でなくなる**。

`stepLeader` の `MsgAppResp` 処理には、この副産物への配慮が入っている ([`raft.go#L1553-L1571`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1553-L1571))。

```go title="raft.go"
				} else if r.id != m.GetFrom() && pr.CanBumpCommit(r.raftLog.committed) {
					// This node may be missing the latest commit index, so send it.
					r.sendAppend(m.GetFrom())
				}
				// ...
				if r.id != m.GetFrom() {
					for r.maybeSendAppend(m.GetFrom(), false /* sendIfEmpty */) {
					}
				}
```

自分からの `MsgAppResp` でも同じ経路を通るので、「自分に `MsgApp` を送り返す」ことがないように `r.id != m.GetFrom()` で除いている。共通経路にした代償はこの 2 行だけで済んでいる。

## Message は共用体として使われている

`pb.Message` は 1 つの型だが、フィールドの意味はメッセージ型ごとに変わる。protobuf のコメントがその対応を書いている ([`raftpb/raft.proto#L66-L76`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raftpb/raft.proto#L66-L76))。

```protobuf title="raftpb/raft.proto"
	// logTerm is generally used for appending Raft logs to followers. For example,
	// (type=MsgApp,index=100,logTerm=5) means the leader appends entries starting
	// at index=101, and the term of the entry at index 100 is 5.
	// (type=MsgAppResp,reject=true,index=100,logTerm=5) means follower rejects some
	// entries from its leader as it already has an entry with term 5 at index 100.
	// (type=MsgStorageAppendResp,index=100,logTerm=5) means the local node wrote
	// entries up to index=100 in stable storage, and the term of the entry at index
	// 100 was 5.
	optional uint64      logTerm     = 5;
```

同じ `logTerm` が、送信時は「直前エントリの任期」、拒否時は「フォロワーが持っている任期」、ストレージ応答時は「書き終わった位置の任期」を意味する。型で分けず、コメントで分けている。

型安全性を捨てる代わりに得ているのは、**すべてのメッセージが同じ経路を通れる** ことだ。シリアライズ、キューイング、ログ出力、トレース、テストのすべてが 1 種類の型を扱えばよくなる。

その代償として、デバッグ表示に専用の関数が要る ([`util.go#L156-L191`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/util.go#L156-L191))。

```go title="util.go"
func describeMessageWithIndent(indent string, m *pb.Message, f EntryFormatter) string {
```

そして宛先の表示も、予約値を知っている必要がある ([`util.go#L193-L206`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/util.go#L193-L206))。

```go title="util.go"
func describeTarget(id uint64) string {
	switch id {
	case None:
		return "None"
	case LocalAppendThread:
		return "AppendThread"
	case LocalApplyThread:
		return "ApplyThread"
	default:
		return fmt.Sprintf("%x", id)
	}
}
```

テストの期待出力に `AppendThread` という名前で出てくるのは、この関数のおかげだ。

## なぜそうなっているか

### 入口が 1 つだと、そこに全部集められる

`Step` が唯一の入口なので、トレースもそこに置ける ([`raft.go#L1089-L1095`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1089-L1095))。

```go title="raft.go"
func (r *raft) Step(m *pb.Message) error {
	// m should never be nil
	if m == nil {
		return errors.New("nil message")
	}
	traceReceiveMessage(r, m)
```

`traceReceiveMessage` が 1 か所にあるだけで、**あらゆる状態遷移の入力が記録される**。これが [TLA+ トレース検証](../tla-trace-validation/) の土台になっている。タイマー発火が関数呼び出しで、提案がチャネル経由で、ディスク完了がコールバックで、とバラバラだったら、こうはいかない。

### 順序を利用側に守らせられる

ローカルストレージへの指示をメッセージにすると、「宛先が同じものは順序を保って処理せよ」という要求を、ネットワークメッセージと同じ語彙で言える ([`raft.go#L163-L167`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L163-L167))。

```go title="raft.go"
	// When true, the Ready.Message slice will include MsgStorageAppend and
	// MsgStorageApply messages. The messages will target a LocalAppendThread
	// and a LocalApplyThread, respectively. Messages to the same target must be
	// reliably processed in order. In other words, they can't be dropped (like
	// messages over the network) and those targeted at the same thread can't be
	// reordered. Messages to different targets can be processed in any order.
```

「同じ宛先なら順序保証、違う宛先なら任意順」という 1 つの規則で、ディスク書き込みと状態機械適用の並列化が表現できている。専用の API を設計する必要がない。

### テストが読みやすくなる

すべてがメッセージなので、テストのコマンドも自然に対応する ([`rafttest/interaction_env_handler.go`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rafttest/interaction_env_handler.go) の抜粋)。

```go title="rafttest/interaction_env_handler.go"
	case "deliver-msgs":
	case "process-ready":
	case "process-append-thread":
	case "process-apply-thread":
	case "tick-election":
	case "tick-heartbeat":
```

`process-append-thread` が「ディスク書き込みスレッドを 1 歩進める」に対応する。ローカル I/O がメッセージでなければ、テストからこれを刻む手段がない。**非同期な書き込みの途中で別のことが起きる**、というシナリオを手で書けるのは、この統一のおかげだ。

## どう活かすか

- **状態機械の入力を 1 つの型に閉じる**。イベントソーシングやアクターモデルでは自然な形だが、「タイマー」「ユーザー入力」「I/O 完了」を別々のコールバックで受けている設計は多い。1 つに統一すると、ログ・リプレイ・テストが一気に楽になる。
- **ID 空間の予約値で「内部の相手」を表す**。外部との通信と内部の処理が同じ形になり、順序や信頼性の要求を同じ語彙で書ける。予約したら、その値を通常用途に使えないことを起動時に検査する。
- **自分自身を特別扱いしない**。「自分の場合は直接更新」という近道は、順序の保証をすり抜ける穴になりやすい。共通経路に通したうえで、必要な場所だけ `if self` で除く方が安全になる。

注意点は 2 つある。1 つは、フィールドの意味がメッセージ型ごとに変わる共用体的な使い方は、**コメントとテストが充実していて初めて成立する** こと。`etcd-io/raft` は `logTerm` 1 つに 10 行のコメントを割いている。もう 1 つは、この統一が効くのは **入力の種類が有限で安定している** 場合だということ。種類が増え続けるなら、型で分けた方が変更に強い。
