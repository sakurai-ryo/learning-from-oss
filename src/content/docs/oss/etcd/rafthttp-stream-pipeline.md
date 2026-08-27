---
title: "同じ相手への送信路を「常時接続」と「短命な並列接続」に分け、メッセージの性質で使い分ける"
description: "etcd のピア間通信は gRPC ではなく素の HTTP で、しかも 1 つの相手に対して複数の経路を持つ。大半のメッセージは受信側が張った長時間接続に流し、それが使えないときだけ 4 本の短命な HTTP リクエストに落とす。GB 級のスナップショットは専用経路に隔離し、提案は他のメッセージと別の goroutine で処理する。"
group: "クラスタ運用と防御"
sidebar:
  order: 16
---

## 何を学んだか

### どんな状況の話か

etcd のノード間では、Raft のメッセージが常に流れている。種類によって性質がまったく違う。

| メッセージ             | 頻度             | サイズ            | 遅延の重要さ                |
| ---------------------- | ---------------- | ----------------- | --------------------------- |
| `MsgHeartbeat`         | 100 ms ごと      | 数十バイト        | 高い (遅れると選挙が起きる) |
| `MsgApp` (ログ複製)    | 書き込みのたび   | 数 KB 〜 1 MB     | 高い                        |
| `MsgAppResp`           | 複製のたび       | 数十バイト        | 高い                        |
| `MsgVote`              | 選挙時のみ       | 小さい            | 非常に高い                  |
| `MsgSnap`              | まれ             | **数百 MB 〜 GB** | 低い                        |
| `MsgProp` (提案の転送) | クライアント次第 | 可変              | 高い                        |

**これを 1 本の接続に流すと、GB のスナップショットがハートビートを何十秒も詰まらせる。** ハートビートが届かなければ、フォロワーは「リーダーが死んだ」と判断して選挙を始める。**スナップショットの転送が、リーダー選挙を誘発する。**

しかも、ピア間の接続には固有の難しさがある。

- **HTTP のコネクションプールは、long-poll と相性が悪い。** 短命なリクエストが接続を掴んだまま返らないと、プールが枯渇する。
- **相手が複数の URL を持ちうる。** ピアの advertise URL は複数設定できる。
- **相手が生きているかを知りたい。** TCP のキープアライブは分単位なので、遅すぎる。

### etcd の答え

**1 つの相手に対して、複数の送信路を持つ。**

1. **stream**: **受信側が張る long-poll の HTTP 接続。** 常時開いていて、送信側はそこに書き込む。
2. **stream (msgapp v2)**: `MsgApp` 専用の最適化されたストリーム。**リーダーだけが使う。**
3. **pipeline**: **4 本の短命な HTTP POST。** stream が確立していないときの代替。
4. **snapshot sender**: 巨大なスナップショット専用。**pipeline の 1 本を占有する。**

そして、

5. **メッセージの種類と、経路が使えるかどうかで、送り先を選ぶ。**
6. **送信バッファが満杯なら捨てて、raft に「届かなかった」と報告する。**
7. **リンク層のハートビートを、raft のメッセージ形式に偽装して流す。**
8. **受信側では、提案 (`MsgProp`) だけを別の goroutine で処理する。**

## ソースコードのどこか

### 2 つの機構

[`server/etcdserver/api/rafthttp/peer.go#L89-L100`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/peer.go#L89-L100)。

```go title="server/etcdserver/api/rafthttp/peer.go"
// peer is the representative of a remote raft node. Local raft node sends
// messages to the remote through peer.
// Each peer has two underlying mechanisms to send out a message: stream and
// pipeline.
// A stream is a receiver initialized long-polling connection, which
// is always open to transfer messages. Besides general stream, peer also has
// a optimized stream for sending msgApp since msgApp accounts for large part
// of all messages. Only raft leader uses the optimized stream to send msgApp
// to the remote follower node.
// A pipeline is a series of http clients that send http requests to the remote.
// It is only used when the stream has not been established.
type peer struct {
```

**「stream は受信側が初期化する long-polling 接続」** が要点だ。

送信側が接続するのではなく、**受信側が「メッセージをください」という HTTP リクエストを送り、それに対するレスポンスとしてメッセージが流れ続ける**。HTTP/1.1 のチャンク転送を使った、典型的な long-poll になる。

なぜ受信側が張るのか。**ファイアウォールや NAT の都合ではなく、「接続の生存管理を受信側に持たせる」** ためだと読める。受信側は自分が読めているかどうかを常に知っているので、切れたら張り直せばよい。

### 経路の選択は 4 行

[`#L337-L349`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/peer.go#L337-L349)。

```go title="server/etcdserver/api/rafthttp/peer.go"
func (p *peer) pick(m *raftpb.Message) (writec chan<- *raftpb.Message, picked string) {
	var ok bool
	// Considering MsgSnap may have a big size, e.g., 1G, and will block
	// stream for a long time, only use one of the N pipelines to send MsgSnap.
	if isMsgSnap(m) {
		return p.pipeline.msgc, pipelineMsg
	} else if writec, ok = p.msgAppV2Writer.writec(); ok && isMsgApp(m) {
		return writec, streamAppV2
	} else if writec, ok = p.writer.writec(); ok {
		return writec, streamMsg
	}
	return p.pipeline.msgc, pipelineMsg
}
```

**優先順位が上から順に書いてある。**

1. **`MsgSnap` は無条件に pipeline へ。** コメントが理由を書いている。「1 GB になりうるので、stream を長時間ブロックする」。
2. **`MsgApp` で、最適化ストリームが使えるなら、そちらへ。**
3. **一般のストリームが使えるなら、そちらへ。**
4. **どれも駄目なら pipeline。**

**`writec()` が `(chan, bool)` を返す** ので、「接続が確立しているか」の判定と「書き込み先の取得」が同時にできる。判定してから取得する形だと、その間に切れる可能性がある。

**巨大なメッセージを専用経路に隔離する、というのがこの設計で最も効いている判断だ。** stream は他の全メッセージが通る道なので、そこを塞ぐものは通してはいけない。

### 送れないなら捨てて、報告する

[`#L236-L266`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/peer.go#L236-L266)。

```go title="server/etcdserver/api/rafthttp/peer.go"
	writec, name := p.pick(m)
	select {
	case writec <- m:
	default:
		p.r.ReportUnreachable(m.GetTo())
		if isMsgSnap(m) {
			p.r.ReportSnapshot(m.GetTo(), raft.SnapshotFailure)
		}
		if p.lg != nil {
			p.lg.Warn(
				"dropped internal Raft message since sending buffer is full",
```

**捨てるだけでなく、raft に「この相手には届かなかった」と報告する。**

これが重要で、raft はこの報告を受けて **そのフォロワーへの送信ペースを落とす** (probe 状態に落とす)。報告しないと、raft は「送った」と思って次のメッセージを積み続け、バッファが溢れ続ける。

**「捨てる」と「捨てたことを上位に伝える」はセットでなければならない。** [Ready ループのページ](../raft-ready-loop/) で見た `Peer` インターフェースの契約 (「ブロックせず、届く保証はない」) が、ここで具体的な振る舞いとして現れている。

### stream の書き込み: 適応的なバッチ

[`server/etcdserver/api/rafthttp/stream.go#L208-L222`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/stream.go#L208-L222)。

```go title="server/etcdserver/api/rafthttp/stream.go"
		case m := <-msgc:
			err := enc.encode(m)
			if err == nil {
				unflushed += proto.Size(m)

				if len(msgc) == 0 || batched > streamBufSize/2 {
					flusher.Flush()
					sentBytes.WithLabelValues(cw.peerID.String()).Add(float64(unflushed))
					unflushed = 0
					batched = 0
				} else {
					batched++
				}

				continue
			}
```

**`len(msgc) == 0` でフラッシュを決めている。** これがこのファイルで一番うまい 1 行だ。

- **キューが空になった = 今すぐ送るべきものが全部書けた** → フラッシュして、TCP に押し出す。
- **キューにまだある = すぐ後続が来る** → フラッシュせずに詰め込む。

**負荷が低いときは即座に送られ (レイテンシ最小)、負荷が高いときは自動的にバッチになる (スループット最大)。** タイマーもしきい値も要らない。**キューの長さがそのまま「今忙しいか」の指標になっている。**

`batched > streamBufSize/2` は保険で、キューが常に埋まっている状況で無限に溜め込まないための上限になる。

これは Nagle アルゴリズムと同じ発想だが、**Nagle が「ACK を待つ」のに対して、こちらは「自分のキューを見る」** ので、遅延が発生しない。相手の応答に依存しないぶん優れている。

### リンク層のハートビートを、raft のメッセージに偽装する

[`#L100-L110`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/stream.go#L100-L110)。

```go title="server/etcdserver/api/rafthttp/stream.go"
// linkHeartbeatMessage is a special message used as heartbeat message in
// link layer. It never conflicts with messages from raft because raft
// doesn't send out messages without From and To fields.
var (
	linkHeartbeatMessage = raftpb.Message{Type: raftpb.MsgHeartbeat.Enum()}
	linkHeartbeatSize    = proto.Size(&linkHeartbeatMessage)
)

func isLinkHeartbeatMessage(m *raftpb.Message) bool {
	return m.GetType() == raftpb.MsgHeartbeat && m.GetFrom() == 0 && m.GetTo() == 0
}
```

**`From` と `To` が両方 0 の `MsgHeartbeat` を、リンク層のハートビートとして使う。**

コメントが安全性の根拠を書いている。「raft は `From` と `To` を持たないメッセージを送り出さないので、raft からのメッセージと衝突しない」。

**既存のメッセージ形式の「ありえない値」を、新しい意味に割り当てている。** 別のプロトコルやフレーム型を足す必要がない。デコーダもそのまま使える。

なぜリンク層のハートビートが要るかというと、**raft のハートビートはリーダーからしか流れないから** だ。フォロワーからリーダーへの stream も開いていて、そこには何も流れない時間が長い。何も流れないと、接続が切れたことに気づけない。

タイマーは `ConnReadTimeout / 3` (約 1.7 秒) で、**読み取りタイムアウトの 1/3 の間隔** で送る。1 回や 2 回落としてもタイムアウトしない、という余裕の取り方になっている。

そして、接続が失われたら `select` の枝を無効化する。

```go title="server/etcdserver/api/rafthttp/stream.go"
			heartbeatc, msgc = nil, nil
```

**`nil` チャネルにして、次の接続が来るまでその枝を選ばれなくする。** [watcher の 3 群のページ](../watch-sync-victim/) と同じイディオムで、状態フラグを持たずに状態遷移を表している。

### pipeline は 4 本の並列

[`server/etcdserver/api/rafthttp/pipeline.go#L36-L79`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/pipeline.go#L36-L79)。

```go title="server/etcdserver/api/rafthttp/pipeline.go"
const (
	connPerPipeline = 4
	// pipelineBufSize is the size of pipeline buffer, which helps hold the
	// temporary network latency.
	// The size ensures that pipeline does not drop messages when the network
	// is out of work for less than 1 second in good path.
	pipelineBufSize = 64
)

func (p *pipeline) start() {
	p.stopc = make(chan struct{})
	p.msgc = make(chan *raftpb.Message, pipelineBufSize)
	p.wg.Add(connPerPipeline)
	for i := 0; i < connPerPipeline; i++ {
		go p.handle()
	}
```

**4 本の goroutine が同じチャネルから読んで、それぞれ HTTP POST を投げる。** ワーカープールとして最も素朴な形だ。

バッファサイズ 64 の根拠が書いてある。「ネットワークが 1 秒未満止まっても、メッセージを落とさないサイズ」。**「なぜ 64 か」を、時間の単位で説明している。**

送信の後始末 ([`#L94-L130`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/pipeline.go#L94-L130))。

```go title="server/etcdserver/api/rafthttp/pipeline.go"
			if err != nil {
				p.status.deactivate(failureType{source: pipelineMsg, action: "write"}, err.Error())

				if isMsgApp(m) && p.followerStats != nil {
					p.followerStats.Fail()
				}
				p.raft.ReportUnreachable(m.GetTo())
				if isMsgSnap(m) {
					p.raft.ReportSnapshot(m.GetTo(), raft.SnapshotFailure)
				}
				sentFailures.WithLabelValues(types.ID(m.GetTo()).String()).Inc()
				continue
			}

			p.status.activate()
```

**成功も失敗も、必ず raft と peerStatus に報告する。** スナップショットについては `SnapshotFinish` / `SnapshotFailure` を明示的に返している。

raft はスナップショットの送信結果を知らないと、そのフォロワーへの複製を再開できない。**「送りっぱなし」にできないメッセージだけ、完了報告の経路がある。**

### 接続タイムアウトの根拠

[`server/etcdserver/api/rafthttp/peer.go#L32-L41`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/peer.go#L32-L41)。

```go title="server/etcdserver/api/rafthttp/peer.go"
	// ConnReadTimeout and ConnWriteTimeout are the i/o timeout set on each connection rafthttp pkg creates.
	// A 5 seconds timeout is good enough for recycling bad connections. Or we have to wait for
	// tcp keepalive failing to detect a bad connection, which is at minutes level.
	// For long term streaming connections, rafthttp pkg sends application level linkHeartbeatMessage
	// to keep the connection alive.
	// For short term pipeline connections, the connection MUST be killed to avoid it being
	// put back to http pkg connection pool.
	DefaultConnReadTimeout  = 5 * time.Second
	DefaultConnWriteTimeout = 5 * time.Second
```

**この 6 行のコメントに、設計判断が 3 つ入っている。**

- **5 秒。** TCP キープアライブに任せると分単位かかるので、アプリケーション層でタイムアウトを設ける。
- **長時間の stream には、アプリケーション層のハートビートを流す。** 5 秒のタイムアウトがあるので、何も流れないと切れてしまう。だから 1.7 秒ごとにハートビートを送る。
- **短命な pipeline の接続は「必ず殺さなければならない」。** Go の `net/http` は接続をプールに戻すが、**壊れた接続がプールに戻ると、次のリクエストがそれを掴んで失敗する。**

3 番目が特に実務的だ。**「HTTP クライアントライブラリの接続プールが、障害時に不利に働く」** という、実際に踏まないと分からない類の問題への対処になっている。

### 複数の URL は、失敗するたびに切り替える

[`server/etcdserver/api/rafthttp/urlpick.go#L43-L57`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/urlpick.go#L43-L57)。

```go title="server/etcdserver/api/rafthttp/urlpick.go"
func (p *urlPicker) pick() url.URL {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.urls[p.picked]
}

// unreachable notices the picker that the given url is unreachable,
// and it should use other possible urls.
func (p *urlPicker) unreachable(u url.URL) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if u == p.urls[p.picked] {
		p.picked = (p.picked + 1) % len(p.urls)
	}
}
```

**15 行のロードバランサ。** 常に同じ URL を返し、失敗の報告があったら次に進む。

`if u == p.urls[p.picked]` の判定が効いている。**複数の goroutine が同時に失敗を報告しても、切り替わるのは 1 回だけ。** 「自分が使っていた URL が今も選ばれているか」を確認してから進める。

これがないと、4 本の pipeline が同時に失敗したときに 4 回進んで、URL を 3 つ飛ばしてしまう。**「報告が重複しうる」ことを前提にした冪等な更新になっている。**

### 受信側: 提案だけ別の goroutine

[`server/etcdserver/api/rafthttp/peer.go#L174-L205`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/peer.go#L174-L205)。

```go title="server/etcdserver/api/rafthttp/peer.go"
	go func() {
		for {
			select {
			case mm := <-p.recvc:
				if err := r.Process(ctx, mm); err != nil {
					// ...
			}
		}
	}()

	// r.Process might block for processing proposal when there is no leader.
	// Thus propc must be put into a separate routine with recvc to avoid blocking
	// processing other raft messages.
	go func() {
		for {
			select {
			case mm := <-p.propc:
```

**同じコードが 2 回書かれていて、違いは読むチャネルだけ。** コメントが理由を説明している。

**リーダーがいないとき、提案の処理はブロックする。** 提案は「リーダーに転送する」ものなので、リーダーがいなければ待つしかない。それが `recvc` と同じ goroutine にあると、**投票メッセージの処理まで止まる**。投票が処理されないとリーダーが決まらない。**デッドロックになる。**

**「ブロックしうる処理」と「ブロックしてはいけない処理」を、goroutine のレベルで分離している。**

バッファサイズにも根拠がある。

```go title="server/etcdserver/api/rafthttp/peer.go"
	recvBufSize = 4096
	// maxPendingProposals holds the proposals during one leader election process.
	// Generally one leader election takes at most 1 sec. It should have
	// 0-2 election conflicts, and each one takes 0.5 sec.
	// We assume the number of concurrent proposers is smaller than 4096.
	// One client blocks on its proposal for at least 1 sec, so 4096 is enough
	// to hold all proposals.
	maxPendingProposals = 4096
```

**「リーダー選挙 1 回ぶんの提案を保持できるサイズ」として 4096 を選んでいる。** 選挙の所要時間、衝突の回数、クライアントのブロック時間から逆算されている。

### 接続状態の遷移だけをログに出す

[`server/etcdserver/api/rafthttp/peer_status.go#L49-L78`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/peer_status.go#L49-L78)。

```go title="server/etcdserver/api/rafthttp/peer_status.go"
func (s *peerStatus) activate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active {
		s.lg.Info("peer became active", zap.String("peer-id", s.id.String()))
		s.active = true
		s.since = time.Now()

		activePeers.WithLabelValues(s.local.String(), s.id.String()).Inc()
	}
}

func (s *peerStatus) deactivate(failure failureType, reason string) {
	// ...
	if s.active {
		s.lg.Warn("peer became inactive (message send to peer failed)", /* ... */)
		// ...
		return
	}

	if s.lg != nil {
		s.lg.Debug("peer deactivated again", /* ... */)
	}
}
```

**状態が変わったときだけ `Info` / `Warn`、変わらなければ `Debug`。**

`activate` は成功のたびに呼ばれ、`deactivate` は失敗のたびに呼ばれる。**素直に書くと、1 秒に何十行もログが出る。**

「状態遷移だけを記録する」ことで、ログが **「12:34:56 に切れて、12:35:10 に復帰した」** という読める形になる。そして、繰り返しの失敗は `Debug` として残るので、必要なら見られる。

## なぜそうなっているか

- **巨大なメッセージを専用経路に隔離するのは、共有資源を長時間占有するから。** 1 GB のスナップショットが stream を 30 秒塞ぐと、その間ハートビートが届かず、選挙が起きる。**「サイズが桁違いのものは、経路を分ける」** のは、キューやスレッドプールの設計でも同じ。
- **stream を受信側が張るのは、接続の生存管理を受信側に持たせるため。** 受信側は自分が読めているかを常に知っている。切れたら張り直せばよく、送信側は「書き込み先があるか」だけを見ればよくなる。
- **`len(queue) == 0` でフラッシュを決めるのは、キューの長さが負荷の指標になるから。** 空なら暇なので即送る。溜まっているなら忙しいのでまとめる。**タイマーもしきい値もなしに、レイテンシとスループットが自動的に切り替わる。**
- **リンク層のハートビートを既存のメッセージ形式に埋め込んだのは、プロトコルを増やさないため。** 「raft が絶対に生成しない値の組み合わせ」があるなら、そこに新しい意味を持たせられる。**デコーダも変えずに済む。**
- **短命な接続を必ず殺すのは、HTTP クライアントのプールが障害時に不利に働くから。** 壊れた接続がプールに戻ると、次のリクエストがそれを掴む。**ライブラリの善意の機能が、障害時には障害を広げる方向に働くことがある。**
- **URL の切り替えを「今使っているものと同じなら」で守るのは、失敗の報告が重複するから。** 4 本の並列接続が同時に失敗すれば、報告も 4 回来る。**冪等でない状態更新は、並列度のぶんだけ壊れる。**
- **提案の処理を別 goroutine にしたのは、それがブロックしうるから。** リーダー不在時に提案の処理を待つと、投票の処理まで止まり、リーダーが決まらなくなる。**デッドロックの原因が「ブロックしうる処理と、それを解消する処理が同じキューにいる」ことにある。**
- **バッファサイズを時間から逆算しているのは、「何を耐えたいか」が先にあるから。** 「1 秒のネットワーク断」「リーダー選挙 1 回」という要件から数字が出ている。**キリのいい数字を選んで後から正当化するのとは、逆の順序になっている。**
- **状態遷移だけをログに出すのは、繰り返しがログを埋めるから。** 毎秒失敗する状況で毎回ログを出すと、他の情報が流れる。**「変化」を記録すれば、区間として読める。**

## どう活かすか

- **サイズや性質が桁違いのものは、経路を分ける。** 大きなペイロード、バッチ処理、バックグラウンドの同期。共有の経路に流すと、そこを通る全部のレイテンシを引きずる。**「同じ相手への通信だから同じ接続で」は、しばしば間違い。**
- **「キューが空になったらフラッシュ」を、バッチの判定に使う。** 送信バッファ、ログ、メトリクス、DB の書き込み。**キューの長さが負荷の指標になるので、タイマーもしきい値も要らない。** 暇なときは即座に、忙しいときは自動的にまとめる。
- **既存の形式に「ありえない値」があるなら、そこに新しい意味を持たせられる。** 新しいメッセージ型やバージョン交渉を足すより安い。ただし **「なぜ衝突しないか」を必ずコメントに書く。** 根拠がないと、後から本物の値が入ってくる。
- **捨てるときは、捨てたことを上位に伝える。** 送信バッファが溢れたら、上位がペースを落とせるように報告する。黙って捨てると、上位は積み続けて溢れ続ける。
- **HTTP クライアントの接続プールは、障害時の挙動を確認する。** 壊れた接続が再利用されると、障害が伝播する。long-poll と短命なリクエストを同じクライアントで扱うなら、特に注意が要る。
- **重複しうる報告に基づく状態更新は、冪等にする。** 「今の状態が自分の想定と同じなら進める」という 1 行の確認で済む。並列度が上がったときに壊れるコードは、たいていここを省いている。
- **ブロックしうる処理と、それを解消する処理を、同じキューに入れない。** 「リーダー待ちの処理」と「リーダーを決める処理」が同じ goroutine にいると、デッドロックになる。**処理の依存関係を見て、循環がある部分を分離する。**
- **バッファサイズは、「何秒ぶんを耐えたいか」から逆算する。** 「1 秒のネットワーク断」「選挙 1 回」といった要件から出した数字なら、環境が変わったときに再計算できる。数字とその根拠を並べてコメントに書く。
- **接続や依存先の状態は、遷移だけをログに出す。** 毎回の成否を出すとログが埋まる。状態が変わった瞬間だけ記録すれば、「いつからいつまで落ちていたか」が読める。繰り返しは `Debug` に落として残す。
