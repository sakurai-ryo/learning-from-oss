---
title: "送信済み未確認のメッセージを環状バッファで数え、帯域遅延積で上限を決める"
description: "楽観的な複製をどこで止めるか。Inflights は送信済み未確認のメッセージを環状バッファで管理し、件数とバイト数の 2 つで上限をかける。設定コメントがリトルの法則を引いて「この値を絞りすぎるとスループットが RTT に縛られる」と説明していること、上限に達しても空メッセージだけは送り続けてデッドロックを避けていることを読む。"
group: "複製と流量制御"
sidebar:
  order: 21
---

## 何を学んだか

**楽観的なパイプラインには窓が要る。そして窓には、詰まったときに抜ける道が要る。** `StateReplicate` のリーダーは応答を待たずに送り続けるが、無制限だと利用側の送信バッファを溢れさせる。`Inflights` は送信済み未確認のメッセージを環状バッファで数え、件数とバイト数の 2 つで上限をかける。

そして上限に達したときも、**中身が空のメッセージだけは送る**。全部止めると、送ったメッセージが全部失われた場合に永久に回復しなくなるからだ。

## ソースコードのどこか

構造は環状バッファだ ([`tracker/inflights.go#L18-L41`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/inflights.go#L18-L41))。

```go title="tracker/inflights.go"
type inflight struct {
	index uint64 // the index of the last entry inside the message
	bytes uint64 // the total byte size of the entries in the message
}

// Inflights limits the number of MsgApp (represented by the largest index
// contained within) sent to followers but not yet acknowledged by them. Callers
// use Full() to check whether more messages can be sent, call Add() whenever
// they are sending a new append, and release "quota" via FreeLE() whenever an
// ack is received.
type Inflights struct {
	// the starting index in the buffer
	start int

	count int    // number of inflight messages in the buffer
	bytes uint64 // number of inflight bytes

	size     int    // the max number of inflight messages
	maxBytes uint64 // the max total byte size of inflight messages

	// buffer is a ring buffer containing info about all in-flight messages.
	buffer []inflight
}
```

各要素は **メッセージ 1 通** を表し、そのメッセージに含まれる最後のエントリのインデックスとバイト数を持つ。エントリ単位ではなくメッセージ単位で数えているのは、応答も `MsgApp` 単位で返るからだ。

解放は「このインデックス以下を全部」という形になる ([`tracker/inflights.go#L97-L129`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/inflights.go#L97-L129))。

```go title="tracker/inflights.go"
// FreeLE frees the inflights smaller or equal to the given `to` flight.
func (in *Inflights) FreeLE(to uint64) {
	if in.count == 0 || to < in.buffer[in.start].index {
		// out of the left side of the window
		return
	}

	idx := in.start
	var i int
	var bytes uint64
	for i = 0; i < in.count; i++ {
		if to < in.buffer[idx].index { // found the first large inflight
			break
		}
		bytes += in.buffer[idx].bytes

		// increase index and maybe rotate
		size := in.size
		if idx++; idx >= size {
			idx -= size
		}
	}
	// free i inflights and set new start index
	in.count -= i
	in.bytes -= bytes
	in.start = idx
	if in.count == 0 {
		// inflights is empty, reset the start index so that we don't grow the
		// buffer unnecessarily.
		in.start = 0
	}
}
```

**1 通の応答で複数のメッセージが解放されうる**。フォロワーが `MsgAppResp(index=100)` を返せば、100 以下を最後のインデックスとする全メッセージが解放される。応答が途中で失われても、後の応答が追いついて回収する。TCP の累積 ACK と同じ考え方になる。

最後の `in.start = 0` が細かい。空になったら開始位置を戻す。環状バッファなので論理的にはどこでもよいが、開始位置が末尾寄りだと次の `Add` で `grow()` が呼ばれることがある。無駄な拡張を避けている。

## バッファを事前確保しない

`grow` のコメントに、このライブラリの利用形態が現れている ([`tracker/inflights.go#L84-L96`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/inflights.go#L84-L96))。

```go title="tracker/inflights.go"
// grow the inflight buffer by doubling up to inflights.size. We grow on demand
// instead of preallocating to inflights.size to handle systems which have
// thousands of Raft groups per process.
func (in *Inflights) grow() {
	newSize := len(in.buffer) * 2
	if newSize == 0 {
		newSize = 1
	} else if newSize > in.size {
		newSize = in.size
	}
	newBuffer := make([]inflight, newSize)
	copy(newBuffer, in.buffer)
	in.buffer = newBuffer
}
```

`MaxInflightMsgs` の既定的な値は 256 程度だが、最初から 256 要素を確保しない。**1 プロセスに数千の Raft グループがあり、各グループにフォロワーが数台いる** と、確保だけで無視できない量になる。

`Inflights` は `Progress` ごとに 1 つなので、グループ数 × フォロワー数だけ存在する。1000 グループ × 4 フォロワー × 256 要素 × 16 バイト = 16 MB。ほとんどのグループが無活動なら、そのほぼ全部が無駄になる。

倍々で伸ばし、上限で頭打ちにする。使うグループだけがメモリを使う。

## 2 つの上限

上限は件数とバイト数の 2 本立てになっている ([`raft.go#L205-L224`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L205-L224))。

```go title="raft.go"
	// MaxInflightMsgs limits the max number of in-flight append messages during
	// optimistic replication phase. The application transportation layer usually
	// has its own sending buffer over TCP/UDP. Setting MaxInflightMsgs to avoid
	// overflowing that sending buffer. TODO (xiangli): feedback to application to
	// limit the proposal rate?
	MaxInflightMsgs int
	// MaxInflightBytes limits the number of in-flight bytes in append messages.
	// Complements MaxInflightMsgs. Ignored if zero.
	//
	// This effectively bounds the bandwidth-delay product. Note that especially
	// in high-latency deployments setting this too low can lead to a dramatic
	// reduction in throughput. For example, with a peer that has a round-trip
	// latency of 100ms to the leader and this setting is set to 1 MB, there is a
	// throughput limit of 10 MB/s for this group. With RTT of 400ms, this drops
	// to 2.5 MB/s. See Little's law to understand the maths behind.
	MaxInflightBytes uint64
```

**設定項目のコメントが、その値の物理的な意味と、具体的な数値例を示している**。

「帯域遅延積を制限する」「RTT 100ms で 1 MB なら 10 MB/s が上限」「400ms なら 2.5 MB/s」。リトルの法則 (窓サイズ ÷ 往復時間 = スループット) の適用例が、そのまま書いてある。

この記述があると、**遅い環境でスループットが出ないときに、まずここを疑える**。「大きすぎるとバッファを溢れさせる」という上限側の理由と、「小さすぎるとスループットが RTT に縛られる」という下限側の理由が両方示されている。

件数とバイト数を両方持つ理由も明快だ。件数だけだと、1 通が巨大な場合に制御できない。バイト数だけだと、小さいメッセージが大量にあるとき件数が制御できない。どちらか一方に達したら止まる ([`tracker/inflights.go#L130-L134`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/inflights.go#L130-L134))。

```go title="tracker/inflights.go"
// Full returns true if no more messages can be sent at the moment.
func (in *Inflights) Full() bool {
	return in.count == in.size || (in.maxBytes != 0 && in.bytes >= in.maxBytes)
}
```

バイト数の上限は **ソフト** だ ([`tracker/inflights.go#L43-L46`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/inflights.go#L43-L46))。

```go title="tracker/inflights.go"
// NewInflights sets up an Inflights that allows up to size inflight messages,
// with the total byte size up to maxBytes. If maxBytes is 0 then there is no
// byte size limit. The maxBytes limit is soft, i.e. we accept a single message
// that brings it from size < maxBytes to size >= maxBytes.
```

上限を超えるメッセージ 1 通は受け入れる。[Storage インターフェースのページ](../storage-interface/) で見た「最低 1 件は返す」と同じ判断で、**厳格な上限は進捗を止めうる** ことへの配慮になる。

設定の検証も入っている ([`raft.go#L326-L331`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L326-L331))。

```go title="raft.go"
	if c.MaxInflightBytes == 0 {
		c.MaxInflightBytes = noLimit
	} else if c.MaxInflightBytes < c.MaxSizePerMsg {
		return errors.New("max inflight bytes must be >= max message size")
	}
```

窓が 1 通ぶんより小さいと、常に上限超過になって進まない。設定の整合性を起動時に検査する。

## 詰まったときに抜ける道

いちばん興味深いのがここだ ([`raft.go#L631-L641`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L631-L641))。

```go title="raft.go"
	var ents []*pb.Entry
	// In a throttled StateReplicate only send empty MsgApp, to ensure progress.
	// Otherwise, if we had a full Inflights and all inflight messages were in
	// fact dropped, replication to that follower would stall. Instead, an empty
	// MsgApp will eventually reach the follower (heartbeats responses prompt the
	// leader to send an append), allowing it to be acked or rejected, both of
	// which will clear out Inflights.
	if pr.State != tracker.StateReplicate || !pr.Inflights.Full() {
		ents, err = r.raftLog.entries(pr.Next, r.maxMsgSize)
	}
```

**窓が一杯のときも、エントリを載せない `MsgApp` は送る**。

考えている状況はこうだ。窓が一杯になった状態で、送信済みのメッセージが **全部** ネットワークで失われたとする。応答は 1 通も返らない。`FreeLE` が呼ばれないので窓は空かない。窓が空かないので新しいメッセージも送れない。永久に止まる。

エントリなしの `MsgApp` を送れば、フォロワーは受け入れるか拒否するかを返す。どちらでも `Inflights` が解放され、流れが戻る。

**「送ってはいけない」を厳密に守ると回復できなくなる** ケースがあり、そこに抜け道を開けている。

この空メッセージが送られるきっかけもハートビート応答だ ([`raft.go#L1579-L1597`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1579-L1597))。

```go title="raft.go"
	case pb.MsgHeartbeatResp:
		pr.RecentActive = true
		pr.MsgAppFlowPaused = false

		// NB: if the follower is paused (full Inflights), this will still send an
		// empty append, allowing it to recover from situations in which all the
		// messages that filled up Inflights in the first place were dropped. Note
		// also that the outgoing heartbeat already communicated the commit index.
		//
		// If the follower is fully caught up but also in StateProbe (as can happen
		// if ReportUnreachable was called), we also want to send an append (it will
		// be empty) to allow the follower to transition back to StateReplicate once
		// it responds.
		if pr.Match < r.raftLog.lastIndex() || pr.State == tracker.StateProbe {
			r.sendAppend(m.GetFrom())
		}
```

**ハートビートが、詰まりからの回復のトリガーになっている**。[Progress のページ](../progress-state-machine/) で見た probe の再試行と同じで、既にある周期的な処理に回復機構を相乗りさせている。

## 一杯になったら「探っている」扱いにする

もう 1 つ、状態の扱いに小技がある ([`tracker/progress.go#L165-L180`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/progress.go#L165-L180))。

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

窓が一杯になったら `MsgAppFlowPaused` を立てる。これは `StateProbe` で使っているのと同じフラグだ。

結果として、`IsPaused()` の判定が `StateProbe` と `StateReplicate` で同じ式になる。

```go title="tracker/progress.go"
	case StateProbe:
		return pr.MsgAppFlowPaused
	case StateReplicate:
		return pr.MsgAppFlowPaused
```

**「窓が一杯の replicate」を「probe」と同じ扱いにする** ことで、フロー制御の判定が 1 種類で済む。状態は 3 つあるが、送ってよいかどうかの判定はフラグ 1 つに畳まれている。

## 一時停止のテスト

この振る舞いには専用のテストがある ([`testdata/replicate_pause.txt`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/testdata/replicate_pause.txt))。窓を埋めてから提案を続け、送信が止まること、ハートビート応答で空の `MsgApp` が飛ぶこと、応答で解放されて再開することが、メッセージの列としてファイルに書かれている。

`heartbeat_resp_recovers_from_probing.txt` も、ハートビート応答が回復のトリガーになることを直接テストしている。**回復経路がテスト名になっている** ので、なぜその経路があるかを探すときに見つけやすい。

## なぜそうなっているか

`MaxInflightMsgs` のコメントに、この機構の位置づけが書かれている。

> The application transportation layer usually has its own sending buffer over TCP/UDP. Setting MaxInflightMsgs to avoid overflowing that sending buffer.

**Raft の下にもバッファがある**。利用側のトランスポート層が送信キューを持っていて、そこが溢れるとメッセージが落ちる。落ちると再送が要る。再送が増えるとさらに詰まる。

`design.md` の Flow Control の節がこれを補足している。

```text title="design.md"
2. limit the # of in flight messages < N when in `replicate` state. N should be
configurable. Most implementation will have a sending buffer on top of its actual
network transport layer (not blocking raft node). We want to make sure raft does
not overflow that buffer, which can cause message dropping and triggering a bunch
of unnecessary resending repeatedly.
```

**下位層のバッファを溢れさせないために上位層が自制する**、という構造になっている。理想的には下位層からのフィードバックで制御したいところで、実際 `TODO (xiangli): feedback to application to limit the proposal rate?` というコメントが残っている。今は静的な上限で代用している。

## どう活かすか

- **楽観的なパイプラインには窓を置く**。応答を待たずに送る設計にしたら、送信済み未確認の量に上限をかける。上限がないと、下位層のバッファか受信側のメモリが溢れる。
- **件数とバイト数の両方で制限する**。片方だけだと、要素サイズの偏りで制御が効かなくなる。
- **窓のサイズは帯域遅延積で決める**。スループット = 窓サイズ ÷ RTT。この関係を設定のコメントに具体的な数値で書いておくと、運用時のチューニングが判断できる。
- **上限に達しても、進捗を回復する経路を開けておく**。厳密に止めると、送ったものが全部失われたときに永久に詰まる。「中身が空なら送ってよい」のような抜け道を作る。
- **定期的な処理を回復のトリガーにする**。ハートビートは元々リーダーの生存確認だが、フロー制御の解除、probe の再試行、詰まりからの回復も担っている。専用のタイマーを増やさずに済む。
- **上限は事前確保しない**。同種のオブジェクトが大量に存在するなら、必要になってから伸ばす。上限値ぶんを全インスタンスで確保すると、無活動なインスタンスのぶんが丸ごと無駄になる。
