---
title: "遅い購読者を「追いついている」「遅れている」「詰まっている」の 3 群に分けて、それぞれ別の速度で回す"
description: "etcd の watch は、1 人の遅いクライアントが全体を止めてはいけない。送信はすべてノンブロッキングで試み、失敗した watcher は synced 群から外して victim 群へ移す。victim は溜まったイベントを持ったまま別ループで再送され、unsynced は 100 ms ごとにストレージから読み直す。3 つの群の間の移動だけで、遅い購読者の隔離とバックプレッシャーが表現されている。"
sidebar:
  order: 11
---

## 何を学んだか

### どんな状況の話か

[前提のページ](../architecture/) で見たとおり、etcd の watch は「リビジョン N 以降の変更を全部よこせ」という購読だ。Kubernetes の各コンポーネントが常時数百〜数千本の watch を張っている。

書き込みが起きるたびに、該当する watcher にイベントを配る必要がある。ここに 3 つの難しさがある。

- **1 人の遅いクライアントが、全体を止めてはいけない。** 配信の途中でブロックすると、その書き込みトランザクション全体が止まる。
- **イベントを取りこぼしてはいけない。** watch の API 保証は「N 以降の変更を全部」であって、「頑張って届ける」ではない。
- **過去から始まる watch がある。** `WithRev(100)` で 1 時間前から購読を開始されたら、その間の履歴を全部読んで送る必要がある。その間も新しいイベントは来続ける。

### etcd の答え

**watcher を 3 つの群に分け、群ごとに違うループが面倒を見る。**

| 群           | 意味                                   | 誰が動かすか                                    |
| ------------ | -------------------------------------- | ----------------------------------------------- |
| **synced**   | 現在のリビジョンに追いついている       | 書き込みが起きた瞬間に、その場で配る            |
| **unsynced** | 過去のリビジョンから読み直す必要がある | 100 ms ごとのループが、ストレージから読んで送る |
| **victim**   | 送ろうとしたがチャネルが詰まっていた   | 専用のループが、溜めたイベントごと再送を試みる  |

そして、

1. **送信は必ずノンブロッキング。** `select` + `default` で、送れなければ即座に諦める。
2. **送れなかった watcher は synced から外して victim へ。** **送れなかったイベントも一緒に持っていく。**
3. **victim が送れるようになったら、進捗を見て synced か unsynced へ戻す。**
4. **unsynced のループは、1 回のバッチで最大 512 個、1 回のイベント抽出で最大 1000 リビジョンまで。**
5. **同期に時間がかかったら、その時間ぶん休む。** 「他のストア操作に対して公平であるために」。

**「遅い」ことを状態として持ち、状態ごとに違う速度で回す。** これがこの設計の骨格になる。

## ソースコードのどこか

### 送信は絶対にブロックしない

[`server/storage/mvcc/watchable_store.go#L577-L622`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watchable_store.go#L577-L622)。末尾の 7 行がすべてを決めている。

```go title="server/storage/mvcc/watchable_store.go"
	// if all events are filtered out, we should send nothing.
	if !progressEvent && len(wr.Events) == 0 {
		return true
	}
	select {
	case w.ch <- wr:
		return true
	default:
		return false
	}
}
```

**`default` があるので、チャネルが満杯なら即座に `false` を返す。** 呼び出し側は `bool` を見て、次の行動を決める。

チャネルのバッファは 128 で、issue へのリンク付きで定義されている ([`#L33-L44`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watchable_store.go#L33-L44))。

```go title="server/storage/mvcc/watchable_store.go"
	// chanBufLen is the length of the buffered chan
	// for sending out watched events.
	// See https://github.com/etcd-io/etcd/issues/11906 for more detail.
	chanBufLen = 128

	// maxWatchersPerSync is the number of watchers to sync in a single batch
	maxWatchersPerSync = 512

	// maxResyncPeriod is the period of executing resync.
	watchResyncPeriod = 100 * time.Millisecond
```

**すべて `var` で定義されている** のは、テストから値を変えるためだ。上のコメントにあるとおり、issue #11906 でこの値が調整されている。

`send` の中には、フィルタの適用と、開発ビルド専用の検証も入っている。

```go title="server/storage/mvcc/watchable_store.go"
	verify.Verify("Event.ModRevision is less than the w.startRev for watchID", func() (bool, map[string]any) {
		if w.startRev > 0 {
			for _, ev := range wr.Events {
				if ev.Kv.ModRevision < w.startRev {
					return false, map[string]any{
						"Event.ModRevision": ev.Kv.ModRevision,
						"w.startRev":        w.startRev,
						"watchID":           w.id,
					}
				}
			}
		}
		return true, nil
	})
```

**「要求されたリビジョンより古いイベントを送っていないか」を、送信の直前に確かめる。** watch の API 保証を、最終地点で検証している。[robustness テストの記録](../robustness-testing/) を見ると、「watch が時間を遡る」種類のバグが何度も見つかっているので、この検証はその経験から来ている。

「フィルタで全部消えたら何も送らない」の分岐も効いている。**空のレスポンスは、クライアントには「進捗通知」として解釈される** ので、送ってはいけない。ただし、もともと進捗通知として送られたもの (`progressEvent`) は例外。

### 書き込みの瞬間に配る

[`#L468-L494`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watchable_store.go#L468-L494)。

```go title="server/storage/mvcc/watchable_store.go"
func (s *watchableStore) notify(rev int64, evs []*mvccpb.Event) {
	victim := make(watcherBatch)
	for w, eb := range newWatcherBatch(&s.synced, evs) {
		if eb.revs != 1 {
			s.store.lg.Panic(
				"unexpected multiple revisions in watch notification",
				zap.Int("number-of-revisions", eb.revs),
			)
		}
		if w.send(WatchResponse{WatchID: w.id, Events: eb.evs, Revision: rev}) {
			pendingEventsGauge.Add(float64(len(eb.evs)))
		} else {
			// move slow watcher to victims
			w.victim = true
			victim[w] = eb
			s.synced.delete(w)
			slowWatcherGauge.Inc()
		}
		// always update minRev
		// in case 'send' returns true and watcher stays synced, this is needed for Restore when all watchers become unsynced
		// in case 'send' returns false, this is needed for syncWatchers
		w.minRev = rev + 1
	}
	s.addVictim(victim)
}
```

**送れなかったら、その watcher を `synced` から削除して `victim` に入れる。イベントも一緒に。**

`victim[w] = eb` の 1 行が重要で、**送れなかったイベントを捨てていない**。後で再送するために保持する。だから「送信に失敗したから取りこぼした」が起きない。

`w.minRev = rev + 1` が **成功・失敗どちらの場合も実行される** ところにコメントが 3 行付いている。成功したときは `Restore` (リーダーからスナップショットを受けた場合) のために、失敗したときは `syncWatchers` のために要る。**同じ代入が 2 つの異なる理由で必要** なので、両方書いてある。

先頭の `Panic` も設計の表明だ。`notify` は「1 つのトランザクションの結果」を配る関数なので、**リビジョンが複数含まれていたら呼び出し方が間違っている**。

### victim の再送ループ

[`#L259-L282`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watchable_store.go#L259-L282)。

```go title="server/storage/mvcc/watchable_store.go"
// syncVictimsLoop tries to write precomputed watcher responses to
// watchers that had a blocked watcher channel
func (s *watchableStore) syncVictimsLoop() {
	defer s.wg.Done()

	for {
		for s.moveVictims() != 0 {
			// try to update all victim watchers
		}
		s.mu.RLock()
		isEmpty := len(s.victims) == 0
		s.mu.RUnlock()

		var tickc <-chan time.Time
		if !isEmpty {
			tickc = time.After(10 * time.Millisecond)
		}

		select {
		case <-tickc:
		case <-s.victimc:
		case <-s.stopc:
			return
		}
	}
}
```

**`tickc` が条件付きで `nil` のままになる。**

Go では **`nil` チャネルからの受信は永久にブロックする**。だから、

- victim が空のとき: `tickc` は `nil` なので、`select` は `victimc` (新しい victim ができた通知) を待つだけになる。**ポーリングしない。**
- victim があるとき: 10 ms 後に起きて、再送を試みる。

**`nil` チャネルを使って `select` の枝を動的に無効化する** のは Go のイディオムで、条件分岐で `select` を 2 種類書くより短くて読みやすい。

再送の実体 ([`#L284-L340`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watchable_store.go#L284-L340))。

```go title="server/storage/mvcc/watchable_store.go"
func (s *watchableStore) moveVictims() (moved int) {
	s.mu.Lock()
	victims := s.victims
	s.victims = nil
	s.mu.Unlock()

	var newVictim watcherBatch
	for _, wb := range victims {
		// try to send responses again
		for w, eb := range wb {
			// watcher has observed the store up to, but not including, w.minRev
			rev := w.minRev - 1
			if !w.send(WatchResponse{WatchID: w.id, Events: eb.evs, Revision: rev}) {
				if newVictim == nil {
					newVictim = make(watcherBatch)
				}
				newVictim[w] = eb
				continue
			}
			pendingEventsGauge.Add(float64(len(eb.evs)))
			moved++
		}
```

**リストを丸ごと取り出してから、ロックを手放して処理する。** 送信は時間がかかりうるので、その間ロックを持たない。処理中に新しい victim ができたら、それは別のリストとして追加される。

送れたものは、進捗を見て行き先が決まる。

```go title="server/storage/mvcc/watchable_store.go"
		for w, eb := range wb {
			if newVictim != nil && newVictim[w] != nil {
				// couldn't send watch response; stays victim
				continue
			}
			w.victim = false
			if eb.moreRev != 0 {
				w.minRev = eb.moreRev
			}
			if w.minRev <= curRev {
				s.unsynced.add(w)
			} else {
				slowWatcherGauge.Dec()
				s.synced.add(w)
			}
		}
```

**3 方向の分岐になっている。**

- まだ送れない → victim のまま。
- 送れたが、まだ読むべきリビジョンがある → **unsynced へ。**
- 送れて、追いついた → **synced へ。**

`eb.moreRev` は「このバッチに入りきらなかった最初のリビジョン」だ。詰まっている間に大量の書き込みが起きていれば、victim の保持しているイベントだけでは足りない。**足りないぶんは unsynced のループがストレージから読み直す。**

つまり、**victim は「メモリに持っているイベントを再送する」役、unsynced は「ストレージから読み直す」役** に分かれている。前者は速いが、保持量に限りがある。後者は遅いが、いくらでも遡れる。

### unsynced の同期ループ

[`#L342-L416`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watchable_store.go#L342-L416)。手順がコメントに書いてある。

```go title="server/storage/mvcc/watchable_store.go"
// syncWatchers syncs unsynced watchers by:
//  1. choose a set of watchers from the unsynced watcher group
//  2. iterate over the set to get the minimum revision and remove compacted watchers
//  3. use minimum revision to get all key-value pairs and send those events to watchers
//  4. remove synced watchers in set from unsynced group and move to synced group
func (s *watchableStore) syncWatchers() int {
	// ...
	wg, minRev := s.unsynced.choose(maxWatchersPerSync, curRev, compactionRev)
	evs := rangeEvents(s.store.lg, s.store.b, minRev, curRev+1, wg)
```

**最大 512 個の watcher を選び、その中の最小リビジョンから現在までを 1 回だけ読む。**

ここが効率の要だ。100 個の watcher がそれぞれ違うリビジョンから始まっていても、**ストレージの走査は 1 回で済む**。最小リビジョンから読んで、各 watcher には自分に関係する範囲だけ配る。

読み出しの部分に、危ない注意書きがある ([`#L418-L439`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watchable_store.go#L418-L439))。

```go title="server/storage/mvcc/watchable_store.go"
	tx := b.ReadTx()
	tx.RLock()
	revs, vs := tx.UnsafeRange(schema.Key, minBytes, maxBytes, 0)
	evs := kvsToEvents(lg, c, revs, vs)
	// Must unlock after kvsToEvents, because vs (come from boltdb memory) is not deep copy.
	// We can only unlock after Unmarshal, which will do deep copy.
	// Otherwise we will trigger SIGSEGV during boltdb re-mmap.
	tx.RUnlock()
```

**bbolt が返すバイトスライスは、mmap された領域を直接指している。** トランザクションを閉じた後にそれを触ると、`SIGSEGV` で落ちる (bbolt がファイルを拡張して re-mmap したとき)。

だから、**`Unmarshal` によるディープコピーが終わるまでロックを手放せない**。コメントが「なぜここで Unlock してはいけないか」を明示しているのは、この 1 行を後から動かされないためだ。

削除イベントの扱いにも小さな細工がある。

```go title="server/storage/mvcc/watchable_store.go"
		ty := mvccpb.Event_PUT
		if isTombstone(revs[i]) {
			ty = mvccpb.Event_DELETE
			// patch in mod revision so watchers won't skip
			kv.ModRevision = BytesToRev(revs[i]).Main
		}
```

**トンボストーンに保存されている `KeyValue` は、削除される前の値のもの** なので、`ModRevision` が古い。そのまま送ると、クライアントが「もう見たリビジョン」として飛ばしてしまう。だから、キーから読み取った実際のリビジョンで上書きする。

### 「他に対して公平であるために」休む

[`#L223-L255`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watchable_store.go#L223-L255)。

```go title="server/storage/mvcc/watchable_store.go"
		unsyncedWatchers := 0
		if lastUnsyncedWatchers > 0 {
			unsyncedWatchers = s.syncWatchers()
		}
		syncDuration := time.Since(st)

		delayTicker.Reset(watchResyncPeriod)
		// more work pending?
		if unsyncedWatchers != 0 && lastUnsyncedWatchers > unsyncedWatchers {
			// be fair to other store operations by yielding time taken
			delayTicker.Reset(syncDuration)
		}
```

**「まだ仕事が残っていて、しかも進捗があった」ときだけ、待ち時間を「今かかった時間」にする。**

- 通常は 100 ms ごと。
- 大量の unsynced を捌いている最中は、**1 回の同期にかかった時間と同じだけ休む**。つまり、この処理の CPU 使用率が 50% を超えない。
- 進捗がない (`lastUnsyncedWatchers <= unsyncedWatchers`) なら、100 ms 待つ。無駄な再試行を繰り返さない。

**「かかった時間と同じだけ休む」というのは、適応的なレート制限として単純で強力だ。** 処理が重ければ自動的に間隔が空き、軽ければ詰まる。パラメータを 1 つも増やしていない。

[圧縮のページ](../compaction-batching/) の「10 ms 眠る」と同じ思想だが、こちらは固定値ではなく実測値を使っている。

### watcher の索引は 2 種類

[`#L148-L172`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watcher_group.go#L148-L172)。

```go title="server/storage/mvcc/watcher_group.go"
// watcherGroup is a collection of watchers organized by their ranges
type watcherGroup struct {
	// keyWatchers has the watchers that watch on a single key
	keyWatchers watcherSetByKey
	// ranges has the watchers that watch a range; it is sorted by interval
	ranges adt.IntervalTree
	// watchers is the set of all watchers
	watchers watcherSet
}

// add puts a watcher in the group.
func (wg *watcherGroup) add(wa *watcher) {
	wg.watchers.add(wa)
	if wa.end == nil {
		wg.keyWatchers.add(wa)
		return
	}
	// ...
}
```

**単一キーの watcher はマップ、範囲の watcher は区間木。**

「キー `foo` が変更された。誰に配るべきか」を答えるには、

- マップを `foo` で引く → 単一キーの購読者。O(1)。
- 区間木に `foo` を含む区間を問い合わせる → 範囲の購読者。O(log n + 該当数)。

**すべてを区間木に入れることもできるが、単一キーの購読が圧倒的に多い** ので、そこを O(1) にする価値がある。区間木 (`pkg/adt`) は etcd の自前実装で、[認可](../applier-chain/) のキー範囲チェックにも使われている。

`watcherSet` の操作が両方 `panic` するのも目を引く。

```go title="server/storage/mvcc/watcher_group.go"
func (w watcherSet) add(wa *watcher) {
	if _, ok := w[wa]; ok {
		panic("add watcher twice!")
	}
	w[wa] = struct{}{}
}

func (w watcherSet) delete(wa *watcher) {
	if _, ok := w[wa]; !ok {
		panic("removing missing watcher!")
	}
	delete(w, wa)
}
```

**「二重登録」「存在しないものの削除」を許さない。** 3 つの群の間を watcher が移動する設計なので、**「どの群にいるか」の管理が破れると、イベントが二重に配られたり配られなかったりする**。マップの操作としては黙って成功できるが、この設計では致命的なので落とす。

### イベントのバッチにも上限がある

[`#L26-L63`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/watcher_group.go#L26-L63)。

```go title="server/storage/mvcc/watcher_group.go"
// watchBatchMaxRevs is the maximum distinct revisions that
// may be sent to an unsynced watcher at a time. Declared as
// var instead of const for testing purposes.
var watchBatchMaxRevs = 1000

type eventBatch struct {
	// evs is a batch of revision-ordered events
	evs []*mvccpb.Event
	// revs is the minimum unique revisions observed for this batch
	revs int
	// moreRev is first revision with more events following this batch
	moreRev int64
}

func (eb *eventBatch) add(ev *mvccpb.Event) {
	if eb.revs > watchBatchMaxRevs {
		// maxed out batch size
		return
	}
	// ...
	if evRev > ebRev {
		eb.revs++
		if eb.revs > watchBatchMaxRevs {
			eb.moreRev = evRev
			return
		}
	}
	eb.evs = append(eb.evs, ev)
}
```

**上限は「イベント数」ではなく「異なるリビジョンの数」で数えている。**

理由は原子性だ。**1 つのリビジョンに属するイベントを、途中で分割してはいけない。** `Txn` で 100 個のキーを書いたら、その 100 イベントは同じレスポンスに入らなければならない。イベント数で切ると、トランザクションの途中で切れる。

そして `moreRev` に「次はここから」を記録する。**打ち切りと再開位置が、同じ構造体に入っている。**

## なぜそうなっているか

- **送信をノンブロッキングにするのは、1 人の遅い購読者が全体を止めるのを防ぐため。** 配信は書き込みトランザクションの中で起きるので、ここでブロックするとクラスタ全体の書き込みが止まる。**ファンアウトする配信では、個別の受け手の速度に引きずられない構造が必須になる。**
- **送れなかったイベントを保持するのは、取りこぼしが API 保証の違反だから。** 「頑張って届ける」なら捨ててよいが、「N 以降を全部」と約束しているなら捨てられない。**保証の強さが、失敗時の振る舞いを決めている。**
- **3 つの群に分けるのは、必要な処理が違うから。** 追いついている watcher には「今起きたこと」を渡せばよい。詰まっている watcher には「保持しているものを再送」。遅れている watcher には「ストレージから読み直し」。**同じループで全部やろうとすると、最も重い処理に律速される。**
- **victim と unsynced を分けるのは、コストが 2 桁違うから。** 保持しているイベントの再送はメモリ操作だけ。ストレージからの読み直しは bbolt の走査が入る。**「安く済むなら安く済ませる」経路を分けておく。**
- **`nil` チャネルで `select` の枝を無効化するのは、仕事がないときにポーリングしないため。** タイマーを常時回すと、アイドル時にも CPU を使う。**「仕事があるときだけタイマーを有効にする」を、条件分岐なしで書ける。**
- **1 回の同期で最小リビジョンから 1 回だけ読むのは、走査を共有するため。** watcher ごとに読むと、N 個の watcher で N 回の走査になる。**まとめて読んで配る形にすると、走査が 1 回になる。**
- **「かかった時間と同じだけ休む」のは、適応的なレート制限として単純だから。** しきい値もトークンバケットも要らない。処理が重ければ自動的に間隔が空き、CPU 使用率が半分を超えない。**追加のパラメータを増やさずに公平性を作れる。**
- **バッチの上限を「リビジョン数」で数えるのは、原子性を壊さないため。** イベント数で切ると、1 つのトランザクションの結果が 2 つのレスポンスに分かれる。**分割してはいけない単位が何かを、上限の単位に選ぶ。**
- **群の出入りを panic で守るのは、状態管理が壊れると症状が出にくいから。** 二重登録されると、イベントが 2 回配られる。抜け落ちると配られない。**どちらもクライアント側で「たまに変な挙動」として現れ、原因の特定が非常に難しい。**

## どう活かすか

- **ファンアウトする配信では、送信をノンブロッキングにして、失敗を状態として扱う。** 「送れなかった」を例外ではなく通常の分岐として設計すると、遅い受け手が全体を止める経路が消える。
- **配信の保証が「全部届ける」なら、送れなかったデータを保持する。** 保持できる量には限りがあるので、限界を超えたときの代替経路 (ここでは「ストレージから読み直す」) も用意する。**保持と再読み込みの 2 段構えにすると、メモリの上限を決められる。**
- **受け手を状態で分類し、状態ごとに違うループで処理する。** 「正常」「遅延」「詰まり」で必要な処理もコストも違う。1 つのループで全部扱うと、最も重いケースに全体が律速される。
- **状態間の遷移条件を、進捗の比較として書く。** 「保持していたぶんを送りきったか」「現在位置に追いついたか」で行き先が決まる形にすると、フラグの組み合わせ爆発が起きない。
- **アイドル時のポーリングを、`nil` チャネル (あるいは同等の仕組み) で消す。** 仕事があるときだけタイマーを有効にすれば、待機中のコストがゼロになる。多数のインスタンスが動く場合に効く。
- **バックグラウンド処理は「かかった時間と同じだけ休む」。** CPU 使用率の上限を、パラメータを増やさずに 50% に抑えられる。負荷が高いときに自動的に譲るので、優先度の設定が要らない。
- **バッチの上限は「分割してはいけない単位」で数える。** 件数やバイト数で切ると、原子的なグループの途中で切れる。そして、**打ち切り位置を結果に含めて返す** と、再開が呼び出し側で完結する。
- **同じデータを複数の受け手が読むなら、読み出しを 1 回にまとめる。** 受け手ごとに違う開始位置を持っていても、最小値から 1 回読んで、各自に関係する部分を配ればよい。
- **索引は、アクセスパターンの分布に合わせて分ける。** 単一キーが大半なら、そこを O(1) にする価値がある。汎用的な構造 1 つで統一すると、最頻ケースが不必要に遅くなる。
- **状態管理の破れは panic で止める。** 「二重登録」「存在しないものの削除」は、マップ操作としては黙って成功する。しかし状態機械としては壊れているので、そこで落とすほうが原因に辿り着ける。
