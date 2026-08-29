---
title: "ローカルストレージへの書き込みも「宛先付きメッセージ」にすると、非同期にできる"
description: "AsyncStorageWrites を有効にすると、Ready の Entries / HardState / CommittedEntries が MsgStorageAppend / MsgStorageApply という宛先付きメッセージに変わり、書き込みの完了を待たずに次の Ready を回せるようになる。その代償として現れる ABA 問題と、任期を応答に添えるだけで解いた方法を読む。"
group: "ライブラリとしての骨格"
sidebar:
  order: 12
---

## 何を学んだか

**ローカル I/O をメッセージにすると、その完了を待つ場所を選べるようになる。** `etcd-io/raft` の既定モードは「`Ready` を受け取る → 書く → 送る → 適用する → `Advance()`」という直列のループで、書き込みが終わるまで次の `Ready` は出てこない。`AsyncStorageWrites` を有効にすると、書き込み指示が `MsgStorageAppend` というメッセージになり、**完了を待たずに次の `Ready` を回せる**。

そして、非同期にしたことで初めて現れる **ABA 問題** がある。「書き込み中のエントリが、別の任期のエントリで上書きされ、さらに元のエントリで上書きされる」という順序の罠を、応答メッセージに任期を添えるだけで解いている。

## ソースコードのどこか

設定は 1 つのフラグだ ([`raft.go#L153-L188`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L153-L188))。

```go title="raft.go"
	// AsyncStorageWrites configures the raft node to write to its local storage
	// (raft log and state machine) using a request/response message passing
	// interface instead of the default Ready/Advance function call interface.
	// Local storage messages can be pipelined and processed asynchronously
	// (with respect to Ready iteration), facilitating reduced interference
	// between Raft proposals and increased batching of log appends and state
	// machine application. As a result, use of asynchronous storage writes can
	// reduce end-to-end commit latency and increase maximum throughput.
	AsyncStorageWrites bool
```

有効にすると、`Ready.Entries` / `HardState` / `Snapshot` / `CommittedEntries` を直接見る必要がなくなり、代わりに `Ready.Messages` に 2 種類のメッセージが混ざる。

```go title="raft.go"
	// MsgStorageAppend carries Raft log entries to append, election votes /
	// term changes / updated commit indexes to persist, and snapshots to apply.
	// All writes performed in service of a MsgStorageAppend must be durable
	// before response messages are delivered. However, if the MsgStorageAppend
	// carries no response messages, durability is not required. The message
	// assumes the role of the Entries, HardState, and Snapshot fields in Ready.
	//
	// MsgStorageApply carries committed entries to apply. Writes performed in
	// service of a MsgStorageApply need not be durable before response messages
	// are delivered. The message assumes the role of the CommittedEntries field
	// in Ready.
```

**`MsgStorageAppend` は `fsync` が要るが、`MsgStorageApply` は要らない**。ログの追記は「覚えた」の根拠だから耐久性が要る。状態機械への適用は、失われてもログから再生できるので要らない。この非対称性が型のレベルで分かれている。

さらに条件が付いている。「応答メッセージを持たない `MsgStorageAppend` なら耐久性は不要」。応答を返さないということは、誰にも「覚えました」と約束していないということなので、`fsync` を省ける。

そして最後に、応答の扱いが書かれている。

```go title="raft.go"
	// Local messages each carry one or more response messages which should be
	// delivered after the corresponding storage write has been completed. These
	// responses may target the same node or may target other nodes. The storage
	// threads are not responsible for understanding the response messages, only
	// for delivering them to the correct target after performing the storage
	// write.
```

**ストレージスレッドは応答の中身を理解しなくてよい**。書いて、`Responses` を宛先に配るだけ。この分離のおかげで、書き込みスレッドは Raft のロジックを一切知らずに済む。

## メッセージの組み立て

`MsgStorageAppend` は `Ready` の 3 フィールドを 1 つのメッセージに詰め替えたものだ ([`rawnode.go#L219-L256`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L219-L256))。

```go title="rawnode.go"
func newStorageAppendMsg(r *raft, rd Ready) *pb.Message {
	m := &pb.Message{
		Type:    pb.MsgStorageAppend.Enum(),
		To:      new(LocalAppendThread),
		From:    new(r.id),
		Entries: rd.Entries,
	}
	if !IsEmptyHardState(rd.HardState) {
		// If the Ready includes a HardState update, assign each of its fields
		// to the corresponding fields in the Message. This allows clients to
		// reconstruct the HardState and save it to stable storage.
		//
		// If the Ready does not include a HardState update, make sure to not
		// assign a value to any of the fields so that a HardState reconstructed
		// from them will be empty (return true from raft.IsEmptyHardState).
		m.Term = new(rd.GetTerm())
		m.Vote = new(rd.GetVote())
		m.Commit = new(rd.GetCommit())
	}
```

`HardState` の 3 フィールドを `Message` の `Term` / `Vote` / `Commit` に写している。[「全部を Message にする」ページ](../everything-is-a-message/) で見た共用体的な使い方の一例だ。

コメントが「更新がないときは 3 つとも代入しない」ことを強調している。1 つでも代入すると、再構成した `HardState` が空でなくなり、利用側が不要な書き込みをする。

`MsgStorageApply` はもっと単純だ ([`rawnode.go#L368-L385`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L368-L385))。

```go title="rawnode.go"
func newStorageApplyMsg(r *raft, rd Ready) *pb.Message {
	ents := rd.CommittedEntries
	return &pb.Message{
		Type:      pb.MsgStorageApply.Enum(),
		To:        new(LocalApplyThread),
		From:      new(r.id),
		Term:      new(uint64(0)), // committed entries don't apply under a specific term
		Entries:   ents,
		Responses: []*pb.Message{newStorageApplyRespMsg(r, ents)},
	}
}
```

`Term: 0` に「コミット済みエントリは特定の任期のもとで適用されるわけではない」というコメントが付いている。コミットされた時点でエントリは任期から独立した事実になる、という理解がここに現れている。

## 利用側のループ

`doc.go` に非同期モードのループ例がある ([`doc.go#L200-L260`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/doc.go#L200-L260) 付近)。骨格はこうなる。

```go
for {
	select {
	case <-s.Ticker:
		n.Tick()
	case rd := <-s.Node.Ready():
		for _, m := range rd.Messages {
			switch m.To {
			case raft.LocalAppendThread:
				// 追記スレッドのキューへ
			case raft.LocalApplyThread:
				// 適用スレッドのキューへ
			default:
				// ネットワークへ送る
			}
		}
	}
}
```

`Advance()` は呼ばない。呼んではいけない ([`node.go#L166-L173`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/node.go#L166-L173))。

```go title="node.go"
	// NOTE: Advance must not be called when using AsyncStorageWrites. Response messages from the
	// local append and apply threads take its place.
	Advance()
```

`Advance()` の役目 —「前の `Ready` の処理が終わった」を伝えること — が、`MsgStorageAppendResp` と `MsgStorageApplyResp` に置き換わる。**関数呼び出しがメッセージになると、非同期にできる** という、この節全体の主題そのものだ。

## 現れる ABA 問題

非同期にすると、「書き込み中に状態が変わる」ことが起こりうる。`newStorageAppendRespMsg` に、40 行を超えるコメントでこの問題が説明されている ([`rawnode.go#L258-L364`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L258-L364))。

まず、応答が何のためにあるかから。

```go title="rawnode.go"
	if r.raftLog.hasNextOrInProgressUnstableEnts() {
		// If the raft log has unstable entries, attach the last index and term of the
		// append to the response message. This (index, term) tuple will be handed back
		// and consulted when the stability of those log entries is signaled to the
		// unstable. If the (index, term) match the unstable log by the time the
		// response is received (unstable.stableTo), the unstable log can be truncated.
```

書き込みが終わったら、メモリ上に保持していた未永続エントリ (unstable) を捨てられる。その判断のために `(index, term)` を応答に持たせる。

ここから問題の説明に入る。

```go title="rawnode.go"
		// However, with just this logic, there would be an ABA problem[^1] that could
		// lead to the unstable log and the stable log getting out of sync temporarily
		// and leading to an inconsistent view. Consider the following example with 5
		// nodes, A B C D E:
		//
		//  1. A is the leader.
		//  2. A proposes some log entries but only B receives these entries.
		//  3. B gets the Ready and the entries are appended asynchronously.
		//  4. A crashes and C becomes leader after getting a vote from D and E.
		//  5. C proposes some log entries and B receives these entries, overwriting the
		//     previous unstable log entries that are in the process of being appended.
		//     The entries have a larger term than the previous entries but the same
		//     indexes. It begins appending these new entries asynchronously.
		//  6. C crashes and A restarts and becomes leader again after getting the vote
		//     from D and E.
		//  7. B receives the entries from A which are the same as the ones from step 2,
		//     overwriting the previous unstable log entries that are in the process of
		//     being appended from step 5. The entries have the original terms and
		//     indexes from step 2. Recall that log entries retain their original term
		//     numbers when a leader replicates entries from previous terms. It begins
		//     appending these new entries asynchronously.
```

B のログの同じインデックスが、**任期 X → 任期 Y → 任期 X** と変化している。これが ABA だ。3 つの書き込みがパイプラインに乗っている。

```
B のインデックス 5 に対する書き込み:

  書き込み 1 (step 3): term=2 のエントリ  ─┐
  書き込み 2 (step 5): term=3 のエントリ  ─┼─ 全部進行中
  書き込み 3 (step 7): term=2 のエントリ  ─┘
```

```go title="rawnode.go"
		//  8. The asynchronous log appends from the first Ready complete and stableTo
		//     is called.
		//  9. However, the log entries from the second Ready are still in the
		//     asynchronous append pipeline and will overwrite (in stable storage) the
		//     entries from the first Ready at some future point. We can't truncate the
		//     unstable log yet or a future read from Storage might see the entries from
		//     step 5 before they have been replaced by the entries from step 7.
```

書き込み 1 の完了通知が来る。応答の `(index=5, term=2)` は、今のメモリ上の状態 (step 7 で `term=2` に戻っている) と **一致してしまう**。素朴に照合すると「一致したから捨ててよい」と判断する。

しかし実際には書き込み 2 がまだパイプラインにいる。それが完了すると、ディスク上は `term=3` になる。メモリからは既に捨てているので、`Storage` を読むと `term=3` が見え、メモリ上の `term=2` と食い違う。

### 解: 任期を応答に添える

```go title="rawnode.go"
		// To prevent these kinds of problems, we also attach the current term to the
		// MsgStorageAppendResp (above). If the term has changed by the time the
		// MsgStorageAppendResp if returned, the response is ignored and the unstable
		// log is not truncated. The unstable log is only truncated when the term has
		// remained unchanged from the time that the MsgStorageAppend was sent to the
		// time that the MsgStorageAppendResp is received, indicating that no-one else
		// is in the process of truncating the stable log.
```

応答メッセージ自体に **送出時のノードの任期** を載せる。エントリの任期ではなく、ノードの現在の任期だ。

```go title="rawnode.go"
	m := &pb.Message{
		Type: pb.MsgStorageAppendResp.Enum(),
		To:   new(r.id),
		From: new(LocalAppendThread),
		// Dropped after term change, see below.
		Term: new(r.Term),
	}
```

受け取ったとき、ノードの任期が変わっていれば、この応答は無視される。任期の比較は `Step` の冒頭で既に行われているので、**追加のコードは要らない**。「小さい任期のメッセージは無視する」という既存の規則がそのまま働く ([`raft.go#L1167-L1180`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1167-L1180))。

```go title="raft.go"
		} else if m.GetType() == pb.MsgStorageAppendResp {
			if m.GetIndex() != 0 {
				// Don't consider the appended log entries to be stable because
				// they may have been overwritten in the unstable log during a
				// later term. See the comment in newStorageAppendResp for more
				// about this race.
				r.logger.Infof("%x [term: %d] ignored entry appends from a %s message with lower term [term: %d]",
					r.id, r.Term, m.GetType(), m.GetTerm())
			}
			if m.GetSnapshot() != nil {
				// Even if the snapshot applied under a different term, its
				// application is still valid. Snapshots carry committed
				// (term-independent) state.
				r.appliedSnap(m.GetSnapshot())
			}
		}
```

**ローカルメッセージなのに任期を持たせる** という例外的な扱いをすることで、既存の任期処理を再利用している。しかも、スナップショットの部分だけは任期が変わっていても処理する。「スナップショットはコミット済み = 任期に依存しない状態を運ぶから」という理由付きで。

### 生存性の問題とその修正

安全性の問題を潰したら、今度は生存性の問題が出る。

```go title="rawnode.go"
		// However, this replaces a correctness problem with a liveness problem. If we
		// only attempted to truncate the unstable log when appending new entries but
		// also occasionally dropped these responses, then quiescence of new log entries
		// could lead to the unstable log never being truncated.
		//
		// To combat this, we attempt to truncate the log on all MsgStorageAppendResp
		// messages where the unstable log is not empty, not just those associated with
		// entry appends.
```

応答を落とすことがあるので、そのまま書き込みが止むと、メモリ上の unstable が永久に残る。そこで、**新しいエントリがなくても、unstable が空でなければ応答に `(index, term)` を載せる** ようにする。

```go title="rawnode.go"
		// In other words, we set Index and LogTerm in a block that looks like:
		//
		//  if r.raftLog.hasNextOrInProgressUnstableEnts() { ... }
		//
		// not like:
		//
		//  if len(rd.Entries) > 0 { ... }
```

条件式を 2 つ並べて「こっちであって、こっちではない」と書いている。差分が 1 行なので、ぱっと見では区別がつかない。区別がつかないからこそ、明示的に書いてある。

そして終端性の議論で締める。

```go title="rawnode.go"
		// A MsgStorageAppend with a new term is emitted on each term change. This is
		// the same condition that causes MsgStorageAppendResp messages with earlier
		// terms to be ignored. As a result, we are guaranteed that, assuming a bounded
		// number of term changes, there will eventually be a MsgStorageAppendResp
		// message that is not ignored.
```

「任期の変化が有限なら、いずれ無視されない応答が来る」。安全性 → 生存性 → 終端性、と 3 段階で議論が閉じている。

## テストが手順を再現する

この ABA 問題には専用の datadriven テストがある ([`testdata/async_storage_writes_append_aba_race.txt`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/testdata/async_storage_writes_append_aba_race.txt))。コメントの手順 1〜9 を、`deliver-msgs` と `process-append-thread` を手で刻んで再現している。

ローカル I/O をメッセージにしたからこそ、**書き込みを「進める」タイミングをテストから制御できる**。これがなければ、この競合はタイミング依存の再現しないバグとして残っていたはずだ。テストの形式については [datadriven テストのページ](../datadriven-tests/) で扱う。

## もう 1 つの違い: 未永続エントリを適用してよいか

同期・非同期でもう 1 点、振る舞いが変わる ([`rawnode.go#L443-L446`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L443-L446))。

```go title="rawnode.go"
// applyUnstableEntries returns whether entries are allowed to be applied once
// they are known to be committed but before they have been written locally to
// stable storage.
func (rn *RawNode) applyUnstableEntries() bool {
	return !rn.asyncStorageWrites
}
```

同期モードでは、**まだディスクに書いていないコミット済みエントリを適用してよい**。`Ready` の契約により、利用側は `Entries` を書いてから `CommittedEntries` を適用するので、同じ `Ready` の中で順序が保たれるからだ。

非同期モードではこれができない。書き込みスレッドと適用スレッドが独立に走るので、順序が保証されない。だから「ディスクに乗ったエントリだけ適用してよい」に切り替わる ([`log.go#L264-L273`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L264-L273))。

```go title="log.go"
func (l *raftLog) maxAppliableIndex(allowUnstable bool) uint64 {
	hi := l.committed
	if !allowUnstable {
		hi = min(hi, l.unstable.offset-1)
	}
	return hi
}
```

`bool` 1 つで挙動が切り替わり、それが `min` 1 つに帰着する。

## なぜそうなっているか

同期モードのループには、構造的な直列化がある。

```
Ready → 書く (fsync) → 送る → 適用 → Advance → 次の Ready
        ~~~~~~~~~~~~ この間、新しい提案は溜まるだけ
```

`fsync` は数ミリ秒かかることがある。その間、次の提案を処理できない。スループットの上限が `1 / fsync時間` で決まってしまう。

非同期モードでは、書き込みが別スレッドに出るので、その間も `Ready` を回せる。設定のコメントが挙げる利点 — 「Raft の提案処理と干渉しない」「ログ追記のバッチが大きくなる」「エンドツーエンドのコミット遅延が減る」「最大スループットが上がる」 — はここから来る。

代償が ABA 問題であり、その解決に 100 行のコメントが要った。**非同期化は単なるスレッド分離ではなく、順序に関する不変条件を組み直す作業になる** ということが、このコメントの長さに表れている。

## どう活かすか

- **完了待ちを「関数の戻り」ではなく「メッセージの到着」にする**。`Advance()` という同期的な合図をメッセージに置き換えたことで、待つ場所を選べるようになった。同期 API を非同期にしたいとき、最初にこの置き換えを考える価値がある。
- **世代番号で ABA を切る**。「値を比較して同じなら安全」は、間に別の値を挟まれると崩れる。任期・エポック・バージョンのような単調増加する値を応答に添えて、変わっていたら無視する。既存の比較機構があるなら、それに乗せると追加コードが要らない。
- **安全性を直したら生存性を確認する**。「疑わしきは無視」で安全にすると、無視され続けて進まなくなる経路ができる。`etcd-io/raft` は、そこまで含めて 1 つのコメントに書いている。
- **非同期の途中経過をテストから刻めるようにする**。I/O をメッセージにしておくと、「書き込み 1 が完了する前に書き込み 2 を投入する」といったシナリオがテストで書ける。

非同期モードを採るべきでない条件もある。利用側は 2 つのスレッドを用意し、それぞれで順序を保ち、応答を正しい宛先に配る責任を負う。`Ready` を上から順に処理するだけの同期モードと比べて、実装量も誤りうる箇所も増える。スループットが `fsync` で頭打ちになっていることを実測してから採る類の機能だ。
