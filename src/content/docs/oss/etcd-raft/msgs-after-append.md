---
title: "「永続化前に送ってはいけない返答」だけを別のキューに分ける"
description: "Raft の永続化規則は「投票やログ受領の返答は、対応する状態がディスクに乗ってから送る」だが、これを利用側の約束にすると守られない。etcd-io/raft は送信キューを msgs と msgsAfterAppend の 2 本に分け、send() の中で自動的に振り分けることで、この規則をライブラリ側で強制している。"
group: "ライブラリとしての骨格"
sidebar:
  order: 11
---

## 何を学んだか

**守らせたい順序の制約があるとき、それを文書ではなくデータ構造で表す。** `etcd-io/raft` は送信待ちメッセージを 2 本のキューに分けている。片方は「今すぐ送ってよい」、もう片方は「永続化が終わってから送る」。どちらに入るかは `send()` の中でメッセージ型から自動的に決まるので、呼び出し側がうっかり間違えることがない。

分ける基準は明快で、**そのメッセージが「私は覚えました」と約束しているかどうか** だ。約束しているなら、覚えたことがディスクに乗るまで送ってはいけない。

## ソースコードのどこか

`raft` 構造体に 2 本のスライスがある ([`raft.go#L367-L385`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L367-L385))。

```go title="raft.go"
	// msgs contains the list of messages that should be sent out immediately to
	// other nodes.
	//
	// Messages in this list must target other nodes.
	msgs []*pb.Message
	// msgsAfterAppend contains the list of messages that should be sent after
	// the accumulated unstable state (e.g. term, vote, []entry, and snapshot)
	// has been persisted to durable storage. This includes waiting for any
	// unstable state that is already in the process of being persisted (i.e.
	// has already been handed out in a prior Ready struct) to complete.
	//
	// Messages in this list may target other nodes or may target this node.
	//
	// Messages in this list have the type MsgAppResp, MsgVoteResp, or
	// MsgPreVoteResp. See the comment in raft.send for details.
	msgsAfterAppend []*pb.Message
```

2 つの違いが 3 点書かれている。送るタイミング、宛先に自分を含むかどうか、入りうるメッセージ型。

振り分けは `send()` の末尾で行われる ([`raft.go#L545-L599`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L545-L599))。

```go title="raft.go"
	if m.GetType() == pb.MsgAppResp || m.GetType() == pb.MsgVoteResp || m.GetType() == pb.MsgPreVoteResp {
		// If async storage writes are enabled, messages added to the msgs slice
		// are allowed to be sent out before unstable state (e.g. log entry
		// writes and election votes) have been durably synced to the local
		// disk.
		//
		// For most message types, this is not an issue. However, response
		// messages that relate to "voting" on either leader election or log
		// appends require durability before they can be sent. It would be
		// incorrect to publish a vote in an election before that vote has been
		// synced to stable storage locally. Similarly, it would be incorrect to
		// acknowledge a log append to the leader before that entry has been
		// synced to stable storage locally.
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

対象は 3 種類だけだ。

| メッセージ       | 何を約束しているか             | 破ると何が起きるか                                  |
| ---------------- | ------------------------------ | --------------------------------------------------- |
| `MsgVoteResp`    | 「あなたに投票しました」       | 忘れて再起動 → 同じ任期で二重投票 → リーダーが 2 人 |
| `MsgPreVoteResp` | (PreVote での賛成)             | 同上に準ずる                                        |
| `MsgAppResp`     | 「そのエントリを持っています」 | 忘れて再起動 → コミットの根拠が崩れる               |

`MsgApp` (リーダーからの複製) や `MsgHeartbeat` は入らない。これらは「私はこう思う」であって「私はこう覚えた」ではないので、失われても再送すればよい。

`else` の側に `m.GetTo() == r.id` の panic があるのに注目してほしい。**即時送信キューに自分宛のメッセージが入ることはありえない**、という不変条件を主張している。自分宛のメッセージは全部「永続化後」に該当するはずだからだ。

## 拒否の返答をどうするか

コメントの後半が、興味深い判断を残している。

```go title="raft.go"
		// Rejected responses (m.Reject == true) present an interesting case
		// where the durability requirement is less unambiguous. A rejection may
		// be predicated upon unstable state. For instance, a node may reject a
		// vote for one peer because it has already begun syncing its vote for
		// another peer. Or it may reject a vote from one peer because it has
		// unstable log entries that indicate that the peer is behind on its
		// log. In these cases, it is likely safe to send out the rejection
		// response immediately without compromising safety in the presence of a
		// server restart. However, because these rejections are rare and
		// because the safety of such behavior has not been formally verified,
		// we err on the side of safety and omit a `&& !m.Reject` condition
		// above.
```

「拒否は永続化を待たなくても安全そうだが、拒否は稀だし、形式的に検証していないので安全側に倒す」。

`&& !m.Reject` という具体的な条件まで書いたうえで、**それを入れなかったことと理由を残している**。後から読む人が同じ検討を最初からやり直さずに済む。「稀だから最適化しても効かない」という費用対効果の判断が入っているのも、判断の根拠として具体的だ。

## 2 本のキューがどう消費されるか

`Ready` の組み立て時に、動作モードによって扱いが分かれる ([`rawnode.go#L170-L187`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L170-L187))。

```go title="rawnode.go"
	if rn.asyncStorageWrites {
		// If async storage writes are enabled, enqueue messages to
		// local storage threads, where applicable.
		if needStorageAppendMsg(r, rd) {
			m := newStorageAppendMsg(r, rd)
			rd.Messages = append(rd.Messages, m)
		}
		if needStorageApplyMsg(rd) {
			m := newStorageApplyMsg(r, rd)
			rd.Messages = append(rd.Messages, m)
		}
	} else {
		// If async storage writes are disabled, immediately enqueue
		// msgsAfterAppend to be sent out. The Ready struct contract
		// mandates that Messages cannot be sent until after Entries
		// are written to stable storage.
		for _, m := range r.msgsAfterAppend {
			if m.GetTo() != r.id {
				rd.Messages = append(rd.Messages, m)
			}
		}
	}
```

**同期モード** (既定) では、`msgsAfterAppend` は `rd.Messages` の後ろに連結される。「`Entries` を書いてから `Messages` を送る」という `Ready` の契約を利用側が守るので、結果として順序が保たれる。自分宛のものはここで除かれる。

**非同期モード** では、`msgsAfterAppend` は `MsgStorageAppend` の `Responses` フィールドに入る ([`rawnode.go#L248-L255`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L248-L255))。

```go title="rawnode.go"
	// Attach all messages in msgsAfterAppend as responses to be delivered after
	// the message is processed, along with a self-directed MsgStorageAppendResp
	// to acknowledge the entry stability.
	//
	// NB: it is important for performance that MsgStorageAppendResp message be
	// handled after self-directed MsgAppResp messages on the leader (which will
	// be contained in msgsAfterAppend). This ordering allows the MsgAppResp
	// handling to use a fast-path in r.raftLog.term() before the newly appended
	// entries are removed from the unstable log.
	m.Responses = r.msgsAfterAppend
```

書き込みが終わったら `Responses` を配送する、という契約になる。順序の保証がライブラリの外に出るのではなく、**メッセージの中に入る**。

コメントの `NB:` が細かい。`MsgStorageAppendResp` (unstable ログの切り詰め) を、自分宛の `MsgAppResp` より **後** に置いている。逆にすると、`MsgAppResp` を処理する時点で該当エントリが unstable から消えており、`raftLog.term()` が `Storage` を読みに行くことになる。並びを 1 つ変えるだけでディスク読み出しが増える、という指摘だ。

## 自分宛の分は Advance まで持ち越す

同期モードで除かれた自分宛のメッセージはどこへ行くのか。`acceptReady` が別の場所に退避する ([`rawnode.go#L408-L424`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L408-L424))。

```go title="rawnode.go"
	if !rn.asyncStorageWrites {
		if len(rn.stepsOnAdvance) != 0 {
			rn.raft.logger.Panicf("two accepted Ready structs without call to Advance")
		}
		for _, m := range rn.raft.msgsAfterAppend {
			if m.GetTo() == rn.raft.id {
				rn.stepsOnAdvance = append(rn.stepsOnAdvance, m)
			}
		}
		if needStorageAppendRespMsg(rn.raft, rd) {
			m := newStorageAppendRespMsg(rn.raft, rd)
			rn.stepsOnAdvance = append(rn.stepsOnAdvance, m)
		}
		if needStorageApplyRespMsg(rd) {
			m := newStorageApplyRespMsg(rn.raft, rd.CommittedEntries)
			rn.stepsOnAdvance = append(rn.stepsOnAdvance, m)
		}
	}
```

`stepsOnAdvance` に積まれ、利用側が `Advance()` を呼んだときに `Step` される。`Advance()` は「書き終わりました」の合図なので、そのタイミングで自分への `MsgAppResp` を処理すれば、永続化後という条件が満たされる。

冒頭の panic は、`Advance()` を呼ばずに 2 回 `Ready()` を取った場合の検出だ。利用側の契約違反を、静かに壊れるのではなく明示的に落として知らせる。

## なぜそうなっているか

### 文書で守らせると守られない

README には「HardState が永続化されるまでメッセージを送ってはいけない」と書いてある。しかしメッセージは 24 種類あり、そのうち 3 種類だけが対象だ。この区別を利用側に判断させるのは無理がある。

キューを分けると、この判断が **`send()` の中に 1 回だけ** 現れる。新しいメッセージ型を足す人は、`send()` の分岐を見て自分がどちら側かを考えることになる。判断の場所が集約される。

さらに、同期モードでは「`msgsAfterAppend` を `Messages` の後ろに連結する」だけで済むので、**利用側から見ると 2 本あることすら見えない**。既存の利用側は README の 4 手順を守るだけで、自動的に正しくなる。

### 非同期化への布石でもある

2 本に分けたことの本当の価値は、非同期ストレージ書き込みで表れる。1 本のキューだと「全部を書き込み後に送る」か「全部を即座に送る」しか選べない。2 本あると、**片方だけ先に送る** ことができる。

リーダーがフォロワーに `MsgApp` を送るのは `msgs` の側なので、自分のディスク書き込みを待たない。フォロワーが `MsgAppResp` を返すのは `msgsAfterAppend` の側なので、自分のディスク書き込みを待つ。結果として、Raft thesis 10.2.1 節にある「リーダーは自分のディスク書き込みとフォロワーへの複製を並列にできる」がそのまま実現される。

**役割によって守るべき順序が違う** ことを、キューの分割という 1 つの仕組みで表現している。

### 自分宛と他人宛を同じキューに入れる

`msgsAfterAppend` には自分宛も他人宛も混在する。分けた方がすっきりしそうだが、混ぜている理由がある。

どちらも「永続化後に配送する」という同じ扱いを受けるからだ。非同期モードでは、両方が同じ `Responses` に入り、利用側は宛先を見て配るだけでよい。自分宛だからといって特別な経路を用意する必要がない。

同期モードでは、宛先で 2 回振り分けている (`rd.Messages` と `stepsOnAdvance`)。この分岐は `rawnode.go` の 2 か所に閉じており、`raft.go` 側は自分宛かどうかを気にしない。

## どう活かすか

- **順序の制約をキューの分割で表す**。「これは今すぐ、これは X の後で」という制約があるなら、宛先や優先度でキューを分けて、投入時に自動で振り分ける。呼び出し側に判断させない。
- **判断を 1 か所に集める**。どちらのキューに入るかを決める分岐が 1 つしかなければ、新しいケースを足す人が必ずそこを見る。分岐が散らばっていると漏れる。
- **採らなかった最適化を、条件式ごと残す**。`&& !m.Reject` のように、具体的なコードと「なぜ入れなかったか」を書いておくと、後の人が同じ検討を最初からやり直さずに済む。
- **契約違反を panic で検出する**。`Advance()` を呼ばずに 2 回 `Ready()` を取る、といった誤用は、静かに壊れると原因究明が難しい。早く落とす。

この設計が効くのは、**制約の対象が少数で、機械的に判別できる** 場合だ。3 種類のメッセージ型を列挙すれば済むから成立している。条件が動的に決まるなら、キューではなく明示的な依存関係の記述 (バリアや世代番号) が要る。
