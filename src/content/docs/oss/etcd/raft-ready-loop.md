---
title: "合意アルゴリズムから I/O を追い出すと、永続化と送信の順序を役割ごとに変えられる"
description: "etcd が使う raft ライブラリは、ディスクにもネットワークにも触らない。代わりに Ready() で「やるべき I/O のリスト」を返し、呼び出し側がそれを実行して Advance() で完了を告げる。この境界の引き方によって、etcd はリーダーとフォロワーで永続化と送信の順序を変えられるし、apply を別 goroutine に逃がしたうえで危険な一点だけをチャネルで同期できる。"
sidebar:
  order: 2
---

## 何を学んだか

### どんな状況の話か

Raft のような合意アルゴリズムは、本質的には「メッセージを受け取って、状態を更新して、メッセージを送り出す」状態機械だ。ところが素直に実装すると、その状態機械の中に I/O が入り込む。

```
// 素朴な実装
func (r *raft) handleAppendEntries(m Message) {
    r.log.append(m.Entries)
    r.persist()          // ← ディスク I/O
    r.send(resp)         // ← ネットワーク I/O
}
```

こうすると、次の問題が全部くっついてくる。

- **テストが書けない。** 状態遷移だけを検証したいのに、ディスクとネットワークのモックが要る。
- **順序を変えられない。** 「永続化してから送る」のか「送りながら永続化する」のかが、アルゴリズムの実装に埋め込まれてしまう。
- **並行度を上げられない。** 適用処理をディスク書き込みと並行させたくても、呼び出し関係が固定されている。

### raft ライブラリの答え

etcd が使う `go.etcd.io/raft` は、**I/O を一切しない**。代わりにこういう形をしている。

1. **入力はメソッド呼び出し。** `Propose(data)`、`Step(msg)`、`Tick()`。これらは状態を更新するだけ。
2. **出力は `Ready()` チャネル。** 「永続化すべきエントリ」「永続化すべき HardState」「送信すべきメッセージ」「適用すべきコミット済みエントリ」「適用すべきスナップショット」がひとまとめで届く。
3. **呼び出し側が I/O をやる。** 順序も並行度も呼び出し側の裁量。
4. **終わったら `Advance()` を呼ぶ。** これで次の `Ready` が出てくる。

`raft` は「何をすべきか」だけを言い、「どうやるか」には関与しない。**この境界の引き方が、etcd 側で効いてくる。**

### etcd 側が、その自由度で何をしているか

1. **リーダーは送信を先に、フォロワーは永続化を先にやる。** 同じ `Ready` でも、自分の役割で順序を変える。
2. **適用 (apply) を別 goroutine に逃がす。** `Ready` を受けた goroutine はディスク書き込みを担当し、適用は別の goroutine が並行して進める。
3. **並行にした結果として危険になる一点だけを、チャネルで同期する。** 「WAL 書き込みが終わる前にスナップショットを取ってはいけない」だけを `notifyc` で守る。
4. **送信するメッセージを、送る直前に間引く。** 古い応答を捨て、削除済みメンバー宛を捨て、重いスナップショットは別経路に逃がす。
5. **順序の要所に障害注入点をコメントとして埋め込む。** `// gofail: var raftBeforeSave struct{}` が 10 個以上並んでいる。

## ソースコードのどこか

### ループの形

[`server/etcdserver/raft.go#L174-L185`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/raft.go#L174-L185)。

```go title="server/etcdserver/raft.go"
func (r *raftNode) start(rh *raftReadyHandler) {
	internalTimeout := time.Second

	go func() {
		defer r.onStop()
		islead := false

		for {
			select {
			case <-r.ticker.C:
				r.tick()
			case rd := <-r.Ready():
```

`select` の枝は 3 つしかない。**時計を進める、Ready を処理する、止まる。** これがサーバの心臓部の全体像で、200 行足らずに収まっている。

`islead` がループの外側のローカル変数になっているところに注意したい。`Ready` に `SoftState` が入っていたときだけ更新される。**「自分がリーダーかどうか」がループの状態として持ち回される** ので、この後の分岐に使える。

### リーダーは送信を先にやる

[`#L237-L243`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/raft.go#L237-L243)。

```go title="server/etcdserver/raft.go"
				// the leader can write to its disk in parallel with replicating to the followers and then
				// writing to their disks.
				// For more details, check raft thesis 10.2.1
				if islead {
					// gofail: var raftBeforeLeaderSend struct{}
					r.transport.Send(r.processMessages(rd.Messages))
				}
```

**この 4 行が、Ready/Advance という API 設計の最大の見返りだ。**

Raft のコミット条件は「過半数が永続化したこと」であって、「リーダーが永続化したこと」ではない。リーダー自身も過半数の 1 人ではあるが、リーダーのディスク書き込みとフォロワーへの複製は **並行に進めてよい**。

論文 (Raft thesis 10.2.1) が指摘しているこの最適化を、etcd は `if islead` の 1 行で実現している。**I/O が raft の中にあったら、この順序変更は不可能だった。**

フォロワー側は逆に、後で見るとおり永続化を先に済ませる。同じ `Ready` に対して、役割で順序が変わる。

### 永続化の順序には強い制約がある

[`#L245-L262`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/raft.go#L245-L262)。

```go title="server/etcdserver/raft.go"
				// Must save the snapshot file and WAL snapshot entry before saving any other entries or hardstate to
				// ensure that recovery after a snapshot restore is possible.
				if !raft.IsEmptySnap(raftSnap) {
					// gofail: var raftBeforeSaveSnap struct{}
					if err := r.storage.SaveSnap(raftSnap); err != nil {
						r.lg.Fatal("failed to save Raft snapshot", zap.Error(err))
					}
					// gofail: var raftAfterSaveSnap struct{}
				}

				// gofail: var raftBeforeSave struct{}
				if err := r.storage.Save(rd.HardState, rd.Entries); err != nil {
					r.lg.Fatal("failed to save Raft hard state and entries", zap.Error(err))
				}
```

「スナップショットを先、その後にエントリと HardState」。**逆順で落ちると復旧できない状態が作れてしまう** ので、コメントが `Must` から始まっている。

エラー処理が全部 `Fatal` (プロセス終了) になっているのも設計の一部だ。**WAL に書けなかったのに動き続ける etcd は、Raft の安全性を破る。** 「書けなかったのでリトライします」ではなく「書けなかったので死にます」が正しい。他のノードが引き継ぐ。

### 事故から生まれたコメント

[`#L264-L285`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/raft.go#L264-L285)。

```go title="server/etcdserver/raft.go"
				if !raft.IsEmptySnap(raftSnap) {
					// Force WAL to fsync its hard state before Release() releases
					// old data from the WAL. Otherwise could get an error like:
					// panic: tocommit(107) is out of range [lastIndex(84)]. Was the raft log corrupted, truncated, or lost?
					// See https://github.com/etcd-io/etcd/issues/10219 for more details.
					if err := r.storage.Sync(); err != nil {
						r.lg.Fatal("failed to sync Raft snapshot", zap.Error(err))
					}

					// etcdserver now claim the snapshot has been persisted onto the disk
					notifyc <- struct{}{}
```

**panic メッセージが、そのままコメントに貼られている。** 「この `Sync()` を消すとこの panic が出る」という因果関係が、次に触る人に伝わるように書かれている。

内容としては、「古い WAL を捨てる (`Release`) 前に、新しい HardState を fsync しておかないと、両方失われた状態が作れる」という話だ。fsync していない HardState は OS のページキャッシュにしかないので、電源が落ちればスナップショットも古い WAL も無い状態になる。

**「消してはいけないコード」に、消したときに何が起きるかを書く。** これがないと、リファクタリングのときに「意味のなさそうな Sync」として消される。

### 適用は別 goroutine、同期は 1 点だけ

`Ready` を受けた goroutine は、適用すべきものを構造体に詰めてチャネルに流すだけで、自分では適用しない ([`#L66-L79`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/raft.go#L66-L79))。

```go title="server/etcdserver/raft.go"
// toApply contains entries, snapshot to be applied. Once
// an toApply is consumed, the entries will be persisted to
// raft storage concurrently; the application must read
// notifyc before assuming the raft messages are stable.
type toApply struct {
	entries  []*raftpb.Entry
	snapshot *raftpb.Snapshot
	// notifyc synchronizes etcd server applies with the raft node
	notifyc chan struct{}
	// raftAdvancedC notifies EtcdServer.apply that
	// 'raftLog.applied' has advanced by r.Advance
	// it should be used only when entries contain raftpb.EntryConfChange
	raftAdvancedC <-chan struct{}
}
```

**データと一緒に同期用のチャネルを渡している。** グローバルなロックではなく、「この 1 回の Ready についての完了通知」をその場で作って持たせる形になっている。`notifyc` は毎回 `make(chan struct{}, 1)` で新しく作られる。

受け取り側 ([`server/etcdserver/server.go#L968-L981`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/server.go#L968-L981))。

```go title="server/etcdserver/server.go"
func (s *EtcdServer) applyAll(ep *etcdProgress, apply *toApply) {
	s.applySnapshot(ep, apply)
	s.applyEntries(ep, apply)
	backend.VerifyBackendConsistency(s.Backend(), s.Logger(), true, schema.AllBuckets...)

	proposalsApplied.Set(float64(ep.appliedi))
	s.applyWait.Trigger(ep.appliedi)

	// wait for the raft routine to finish the disk writes before triggering a
	// snapshot. or applied index might be greater than the last index in raft
	// storage, since the raft routine might be slower than toApply routine.
	<-apply.notifyc

	s.snapshotIfNeededAndCompactRaftLog(ep)
```

**適用そのものは待たずにやり、待つのはスナップショットを取る直前だけ。** 理由もコメントに書いてある。適用が速く進みすぎると「適用済みインデックス > raft ストレージの最終インデックス」という状態になり、その位置でスナップショットを取ると矛盾する。

つまり、**並行にしてよい部分と、してはいけない部分を切り分けて、後者だけを同期している。** 「apply 全体をロックで囲む」ではない。

### 設定変更のときだけ、順序をもう一段強くする

フォロワー側の処理 ([`#L297-L324`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/raft.go#L297-L324))。

```go title="server/etcdserver/raft.go"
				if !islead {
					// finish processing incoming messages before we signal notifyc chan
					msgs := r.processMessages(rd.Messages)

					// now unblocks 'applyAll' that waits on Raft log disk writes before triggering snapshots
					notifyc <- struct{}{}

					// Candidate or follower needs to wait for all pending configuration
					// changes to be applied before sending messages.
					// Otherwise we might incorrectly count votes (e.g. votes from removed members).
					// Also slow machine's follower raft-layer could proceed to become the leader
					// on its own single-node cluster, before toApply-layer applies the config change.
					// We simply wait for ALL pending entries to be applied for now.
					// We might improve this later on if it causes unnecessary long blocking issues.

					if confChanged {
						// blocks until 'applyAll' calls 'applyWait.Trigger'
						// to be in sync with scheduled config-change job
						// (assume notifyc has cap of 1)
						select {
						case notifyc <- struct{}{}:
						case <-r.stopped:
							return
						}
					}

					// gofail: var raftBeforeFollowerSend struct{}
					r.transport.Send(msgs)
```

**`notifyc` に 2 回送ることで「適用が終わるまで待つ」を表現している。** バッファ 1 のチャネルなので、1 回目は即座に通る。2 回目は、受け手が 1 回目を読み出すまでブロックする。受け手が 1 回目を読むのは適用が全部終わった後なので、結果として **設定変更を含む Ready では、適用完了までメッセージ送信が止まる**。

追加の同期プリミティブを持ち込まず、既にあるチャネルの容量を使っている。

理由もコメントが説明している。**削除されたメンバーからの投票を数えてしまう** 危険があるからだ。raft 層は設定変更エントリを「コミット済み」として扱っているが、etcd の適用層がまだメンバーリストを更新していない、という時間差が生まれうる。

「今はとりあえず全部の適用を待つ。問題になったら改善するかもしれない」と書いてあるのも正直で良い。**保守的な選択をしたことと、その代償を認識していることが両方書かれている。**

### 送る直前にメッセージを間引く

[`#L357-L371`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/raft.go#L357-L371)。

```go title="server/etcdserver/raft.go"
func (r *raftNode) processMessages(ms []*raftpb.Message) []*raftpb.Message {
	sentAppResp := false
	var messages []*raftpb.Message
	for i := len(ms) - 1; i >= 0; i-- {
		m := ms[i]
		if r.isIDRemoved(m.GetTo()) {
			continue
		}

		if m.GetType() == raftpb.MsgAppResp {
			if sentAppResp {
				continue
			}
			sentAppResp = true
		}
```

**ループが後ろから前に回っている。** 目的は 3 つ目の分岐で、「`MsgAppResp` は最後の 1 通だけ送る」を実現するためだ。後ろから見て最初に見つかった `MsgAppResp` が最新なので、それだけを残して残りを捨てる。

`MsgAppResp` は「ここまで受け取った」という報告なので、**古い報告は新しい報告に完全に包含される**。1 回の Ready の中に 5 通たまっていたら、4 通は送るだけ無駄になる。

削除済みメンバー宛のメッセージを落とすのも、同じ「送る直前だから分かること」だ。raft 層はメンバーシップの適用状況を知らない。

重いものは別経路に逃がす。

```go title="server/etcdserver/raft.go"
		if m.GetType() == raftpb.MsgSnap {
			// There are two separate data store: the store for v2, and the KV for v3.
			// The msgSnap only contains the most recent snapshot of store without KV.
			// So we need to redirect the msgSnap to etcd server main loop for merging in the
			// current store snapshot and KV snapshot.
			select {
			case r.msgSnapC <- m:
			default:
				// drop msgSnap if the inflight chan if full.
			}
			continue
		}
```

**送れなければ捨てる。** スナップショットは GB 級になりうるので、キューに積み上げると破綻する。捨てても、フォロワーは次のハートビートでまた要求してくるので、正しさは失われない。

`Peer` インターフェースの定義にも同じ方針が明記されている ([`server/etcdserver/api/rafthttp/peer.go#L64-L68`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/rafthttp/peer.go#L64-L68))。

```go title="server/etcdserver/api/rafthttp/peer.go"
	// send sends the message to the remote peer. The function is non-blocking
	// and has no promise that the message will be received by the remote.
	// When it fails to send message out, it will report the status to underlying
	// raft.
	send(m *raftpb.Message)
```

**「ブロックしない」「届く保証はない」がインターフェースの契約として書かれている。** Raft はメッセージの喪失を前提に設計されているので、下位層が信頼性を提供する必要がない。むしろ提供しようとすると、送信バッファが詰まって上位が止まる。

### ハートビートの遅延を「送信側」で検出する

```go title="server/etcdserver/raft.go"
		if m.GetType() == raftpb.MsgHeartbeat {
			ok, exceed := r.td.Observe(m.GetTo())
			if !ok {
				// TODO: limit request rate.
				r.lg.Warn(
					"leader failed to send out heartbeat on time; took too long, leader is overloaded likely from slow disk",
```

ハートビートは一定間隔で送られるはずなので、**送信の間隔が開いていたら、開いた分だけ自分が遅れている**。相手の応答を待たずに、送信側だけで「自分が過負荷だ」と判定できる。

ログメッセージが原因の推測 (`likely from slow disk`) まで含んでいるのも実用的だ。Raft のリーダーが遅れる原因はほぼディスクなので、運用者が最初に見るべき場所を指している。

### 順序の要所に、障害注入点が埋まっている

このループには `// gofail: var raftBeforeSave struct{}` の形のコメントが 10 個以上ある。

```
raftBeforeLeaderSend / raftBeforeSaveSnap / raftAfterSaveSnap /
raftBeforeSave / raftAfterSave / raftBeforeApplySnap / raftAfterApplySnap /
raftAfterWALRelease / raftBeforeFollowerSend / raftBeforeAdvance
```

[gofail](https://github.com/etcd-io/gofail) は、このコメントをビルド時に実際のコードへ展開するツールだ。テストから「`raftAfterSaveSnap` に到達したらプロセスを殺す」と指定できる。

**「順序が重要な箇所」と「障害注入点」が同じ場所にあるのは偶然ではない。** 順序が重要ということは、その途中で落ちたときの挙動を検証する価値があるということだ。この注入点を使ってクラッシュを起こし、復旧後の状態を検証するのが [robustness テスト](../robustness-testing/) になる。

## なぜそうなっているか

- **合意アルゴリズムから I/O を追い出したのは、正しさの検証と性能の最適化を分離するため。** 状態遷移だけを持つ raft は、決定的なテストが書ける。一方、永続化と送信の順序という性能に効く判断は、アプリケーション側の事情 (自分がリーダーか、ディスクは速いか) に依存する。**両者を同じコードに混ぜると、どちらも最適化できない。**
- **`Ready` が「やるべきことのリスト」を一括で返すのは、順序の自由を呼び出し側に渡すため。** 1 個ずつコールバックで通知する設計だと、raft 側が順序を決めてしまう。まとめて渡せば、リーダーは送信を先に、フォロワーは永続化を先に、という判断ができる。
- **エラーが `Fatal` なのは、Raft の安全性がディスクの成功を前提にしているから。** 「WAL に書いた」と raft に報告してから実は書けていなかった、という状態は、コミット済みのエントリの喪失につながる。**続行するより死ぬほうが安全** な数少ない場面だ。
- **同期を `notifyc` の 1 点に絞ったのは、並行にしてよい部分が大半だから。** 適用とディスク書き込みは、ほとんどの場面で干渉しない。干渉するのは「スナップショットを取る位置の決定」だけなので、そこだけ待つ。全体をロックすると、遅いディスクが適用のスループットを直接引き下げる。
- **設定変更で追加の同期を入れるのは、raft 層と適用層でメンバーシップの認識がずれるから。** raft は「エントリがコミットされた」時点でメンバー構成を更新するが、etcd の適用層はもう少し後で更新する。この間に投票を数えると、削除済みメンバーの票を数えてしまう。**層を分けたことの代償を、層をまたぐ同期で払っている。**
- **送信直前の間引きは、そこが最も情報の多い場所だから。** raft はメンバーシップの適用状況を知らないし、「同じ Ready の中に複数の応答がある」ことにも関心がない。一段上のレイヤは両方を知っている。
- **`MsgSnap` を溢れたら捨てるのは、Raft がメッセージ喪失に耐えるから。** 再送は Raft のプロトコルに組み込まれている。ここで頑張ってキューに積むと、メモリを食い潰したうえで、結局遅れた古いスナップショットを送ることになる。

## どう活かすか

- **アルゴリズムから I/O を追い出し、「やるべきこと」をデータとして返す。** 呼び出し側が実行順序を決められるようになる。テストは状態遷移だけを見ればよくなり、性能の最適化は呼び出し側で閉じる。「コールバックで通知する」より「まとめて返す」ほうが自由度が高い。
- **同じ入力に対する処理順序を、役割によって変える余地を残す。** リーダーとフォロワーで最適な順序が違うように、同じコードパスでも文脈によって最適解は変わる。順序が固定されている設計は、その最適化を最初から捨てている。
- **並行にする前に、「並行にしてはいけない一点」を特定する。** 全体をロックで囲むのは簡単だが、そこが最も遅い処理の待ち行列になる。危険な箇所だけを名前の付いたチャネルで同期すれば、意図もコードに残る。
- **「消すと壊れるコード」には、消したときに何が起きるかを書く。** panic メッセージや issue 番号をそのまま貼るのが、最も再現性の高い書き方になる。一見無意味な `Sync()` は、根拠がなければリファクタリングで消される。
- **回復不能な状態を作るくらいなら、プロセスを落とす。** 特に「永続化に失敗したのに上位には成功と報告する」形の続行は、後から検出できない不整合を作る。冗長化されているなら、死ぬのが最も安全な選択になる。
- **下位の送信層には「ブロックしない、届く保証はない」を契約として書く。** 上位のプロトコルが再送を持っているなら、下位が信頼性を提供する必要はない。むしろ提供しようとして詰まると、上位のループ全体が止まる。
- **送信・書き込みの直前に、まとめて間引く余地がないか見る。** 「最後の 1 通だけでよい」「宛先がもう存在しない」は、キューに積む時点では分からず、出す時点では分かることが多い。
- **順序が重要な箇所に、障害注入点を置く。** 「ここで落ちたらどうなるか」を問う価値がある場所と、順序に意味がある場所は一致する。コメントの形で埋め込んでおけば、通常のビルドには影響しない。
