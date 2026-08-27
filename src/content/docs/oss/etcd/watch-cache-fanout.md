---
title: "1 本の購読を多数の購読者に配り直し、「進捗通知」でキャッシュから線形化可能な読み取りを作る"
description: "etcd の cache パッケージは、サーバへの watch を 1 本だけ張り、ローカルの多数の watcher にファンアウトする。過去から始まる購読にはリングバッファの履歴を再生し、間に合わなければ購読を打ち切る。そして「キャッシュから読んでも古い値を返さない」ことを、サーバの進捗通知を必要なときだけ要求することで達成している。"
sidebar:
  order: 12
---

## 何を学んだか

### どんな状況の話か

Kubernetes の API サーバは、etcd に対して膨大な watch と読み取りを投げる。同じプレフィックス (`/registry/pods/` など) を、多数のコンポーネントが同時に見ている。

これを素直にやると、**同じデータのために etcd へ何本も watch が張られる**。[watcher の 3 群のページ](../watch-sync-victim/) で見たとおり、サーバ側の watcher は 1 本ごとにメモリとイベント配信のコストを持つ。

そこで、**クライアント側に 1 段キャッシュを挟む** ことになる。Kubernetes の apiserver がまさにこれ (watch cache) をやっていて、etcd 本体にも実験的な実装が入った。`cache/` ディレクトリの約 1800 行がそれだ。

キャッシュを挟むと、新しい問題が出る。

- **キャッシュはどこまで新しいのか。** 「読んだ値が古かった」では、線形化可能読み取りの保証が壊れる。
- **過去から始まる watch にどう答えるか。** キャッシュは全履歴を持っていない。
- **ローカルの遅い購読者をどう扱うか。** サーバ側と同じ問題が、そのまま再現する。

### cache パッケージの答え

1. **起動時に `Get` でプレフィックス全体を取り、そのリビジョンの次から watch を張る。**
2. **その 1 本の watch から来たイベントを、ローカルの watcher 全員に配る。**
3. **watcher は `active` と `lagging` の 2 群に分ける。** 送れなくなったら lagging へ落とす。
4. **直近のイベントをリングバッファに保持し、lagging の再生に使う。** 50 ms ごとに追いつかせようとする。
5. **バッファから溢れた範囲を要求されたら、その watcher に `ErrCompacted` を返して打ち切る。** サーバの compaction と同じ扱いにする。
6. **線形化可能な `Get` では、サーバに現在のリビジョンを聞き、キャッシュがそこに追いつくまで待つ。**
7. **追いつきを速めるために、`RequestProgress` を送る。ただし待っている人がいるときだけ。**

**7 番目が、このパッケージで最も面白いところだ。**

## ソースコードのどこか

### 起動: Get してから watch する

[`cache/cache.go#L331-L346`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/cache.go#L331-L346)。

```go title="cache/cache.go"
func (c *Cache) getWatch() error {
	getResp, err := c.get(c.internalCtx)
	if err != nil {
		return err
	}
	return c.watch(getResp.Header.Revision + 1)
}

func (c *Cache) get(ctx context.Context) (*clientv3.GetResponse, error) {
	resp, err := c.kv.Get(ctx, c.prefix, clientv3.WithPrefix())
	if err != nil {
		return nil, err
	}
	c.store.Restore(resp.Kvs, resp.Header.Revision)
	return resp, nil
}
```

**`Get` のレスポンスヘッダに入っているリビジョンの、次から watch する。**

これが取りこぼしのない初期化の定石になる。`Get` は「そのリビジョン時点のスナップショット」を返すので、その次のリビジョンから watch すれば、隙間も重複もない。**etcd のリビジョンが「1 本の時計」であること** ([前提のページ](../architecture/)) が、これを可能にしている。

watch が切れたら、**また `Get` からやり直す** ([`#L312-L329`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/cache.go#L312-L329))。

```go title="cache/cache.go"
func (c *Cache) getWatchLoop() {
	cfg := defaultConfig()
	ctx := c.internalCtx
	backoff := cfg.InitialBackoff
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		if err := c.getWatch(); err != nil {
			fmt.Printf("getWatch failed, will retry after %v: %v\n", backoff, err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
	}
}
```

**「最後に見たリビジョンから watch を再開する」ではなく、丸ごと取り直す。** 前者のほうが効率的に見えるが、切れている間に compaction が起きていれば再開できない。**全部取り直すほうが、場合分けが消える。**

(このループの `backoff` が更新されていないので、指数バックオフになっていない。`MaxBackoff` の設定もあるので、実装が追いついていない箇所だと思われる。`fmt.Printf` でログを出しているのも実験的パッケージらしい。)

### 準備完了の扱い

```go title="cache/cache.go"
		case resp, ok := <-watchCh:
			if !ok {
				return nil
			}
			readyOnce.Do(func() {
				c.demux.Init(rev)
				c.ready.Set()
			})
			if err := resp.Err(); err != nil {
				c.ready.Reset()
				return err
			}
```

**watch から最初の応答が届いた瞬間に「準備完了」とする。** `WithCreatedNotify()` を付けているので、この最初の応答は「watch が確立した」という通知になる。

エラーが起きたら `Reset` して未準備に戻す。**`Ready` が「今この瞬間、キャッシュを信じてよいか」を表している** ので、そこから読もうとするクライアントは `WaitReady` でブロックされる。

### ローカルの watcher も 2 群に分ける

[`cache/demux.go#L28-L41`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/demux.go#L28-L41)。

```go title="cache/demux.go"
type demux struct {
	mu sync.RWMutex
	// activeWatchers & laggingWatchers hold the first revision the watcher still needs (nextRev).
	activeWatchers  map[*watcher]int64
	laggingWatchers map[*watcher]int64
	resyncInterval  time.Duration
	// Range of revisions maintained for demux operations, inclusive. Broader than history as event revision is not contious.
	// maxRev tracks highest seen revision; minRev sets watcher compaction threshold (updated to evictedRev+1 on history overflow)
	minRev, maxRev int64
	// History stores events within [minRev, maxRev].
	history ringBuffer[[]*clientv3.Event]
	// resynced is used to notify that resync loop was completed.
	resynced *notifier
}
```

**サーバ側の `synced` / `unsynced` / `victim` に対応する構造が、クライアント側にも現れている。** ただし 2 群だけで、「保持したイベントの再送」と「履歴からの再生」が統合されている。リングバッファが両方の役をこなす。

配信 ([`#L255-L287`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/demux.go#L255-L287))。

```go title="cache/demux.go"
		if !w.enqueueResponse(clientv3.WatchResponse{
			Events: events[sendStart:],
		}) { // overflow → lagging
			d.laggingWatchers[w] = nextRev
			delete(d.activeWatchers, w)
		} else {
			d.activeWatchers[w] = lastRev + 1
		}
```

`enqueueResponse` も、サーバ側と同じくノンブロッキングだ ([`cache/watcher.go#L42-L64`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/watcher.go#L42-L64))。

```go title="cache/watcher.go"
// true  -> events delivered (or filtered/duplicate)
// false -> buffer full (caller should mark watcher “lagging”)
func (w *watcher) enqueueResponse(resp clientv3.WatchResponse) bool {
	// ...
	select {
	case w.respCh <- resp:
		return true
	default:
		return false
	}
}
```

**戻り値の意味がコメントで宣言されている。** `true` は「配った、あるいは配る必要がなかった」、`false` は「バッファが満杯なので lagging にせよ」。呼び出し側がやるべきことまで書いてある。

### 履歴はリングバッファ

[`cache/ringbuffer.go#L17-L52`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/ringbuffer.go#L17-L52)。

```go title="cache/ringbuffer.go"
type ringBuffer[T any] struct {
	buffer []entry[T]
	// head is the index immediately after the last non-empty entry in the buffer (i.e., the next write position).
	head, tail, size int
	revisionOf       RevisionOf[T]
}

func (r *ringBuffer[T]) Append(item T) {
	entry := entry[T]{revision: r.revisionOf(item), item: item}
	if r.full() {
		r.tail = (r.tail + 1) % len(r.buffer)
	} else {
		r.size++
	}
	r.buffer[r.head] = entry
	r.head = (r.head + 1) % len(r.buffer)
}
```

**満杯なら最古を押し出す。** メモリ使用量に上限がある代わりに、遡れる範囲に上限ができる。デフォルトは 2048 バッチ ([`cache/config.go#L45-L58`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/config.go#L45-L58))。

```go title="cache/config.go"
// TODO: tune via performance/load tests.
func defaultConfig() Config {
	return Config{
		PerWatcherBufferSize:    10,
		HistoryWindowSize:       2048,
		ResyncInterval:          50 * time.Millisecond,
		InitialBackoff:          50 * time.Millisecond,
		MaxBackoff:              2 * time.Second,
		GetTimeout:              5 * time.Second,
		WaitTimeout:             3 * time.Second,
		BTreeDegree:             32,
		ProgressRequestInterval: 100 * time.Millisecond,
		ProgressNotifyInterval:  10 * time.Minute,
	}
}
```

**`// TODO: tune via performance/load tests.` が正直で良い。** 実測に基づかない値であることが明示されている。

リングバッファに入るのは **イベントのバッチ** で、要素の型が `[]*clientv3.Event` になっている。[watcher の 3 群のページ](../watch-sync-victim/) と同じ理由で、**同じリビジョンのイベントを分割しないため** だ。バッチへの切り分けが `updateStoreLocked` で行われている ([`cache/demux.go#L199-L227`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/demux.go#L199-L227))。

```go title="cache/demux.go"
	events := resp.Events
	batchStart := 0
	for end := 1; end < len(events); end++ {
		if events[end].Kv.ModRevision != events[batchStart].Kv.ModRevision {
			// ...
			d.history.Append(events[batchStart:end])
			batchStart = end
		}
	}
```

**`ModRevision` が変わったところで切る。** 同じリビジョンのイベントは必ず 1 バッチに入る。

### 追いつけなければ、compaction として扱う

[`cache/demux.go#L318-L358`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/demux.go#L318-L358)。

```go title="cache/demux.go"
	for w, nextRev := range d.laggingWatchers {
		if nextRev < d.minRev {
			w.Compact(nextRev)
			delete(d.laggingWatchers, w)
			continue
		}
```

**要求されているリビジョンが履歴の下限より古ければ、その watcher を打ち切る。**

打ち切り方が上手い ([`cache/watcher.go#L66-L77`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/watcher.go#L66-L77))。

```go title="cache/watcher.go"
func (w *watcher) Compact(compactRev int64) {
	resp := &clientv3.WatchResponse{
		Header:          &pb.ResponseHeader{},
		Canceled:        true,
		CompactRevision: compactRev,
		CancelReason:    rpctypes.ErrCompacted.Error(),
	}
	w.stopOnce.Do(func() {
		w.cancelResp = resp
		close(w.respCh)
	})
}
```

**サーバが compaction のときに返すのと、まったく同じ形のレスポンスを返す。**

クライアントから見ると、「キャッシュのバッファが足りなかった」と「サーバで compaction が起きた」が区別できない。**どちらも「その範囲はもう提供できないので、取り直してくれ」という同じ意味** なので、区別する必要がない。

**キャッシュ層が、キャッシュしている対象と同じエラーの語彙を使う。** これによって、クライアント側のリトライロジックがそのまま流用できる。キャッシュを挟んだことによる新しいエラー処理が要らない。

再生が成功した場合 ([`#L346-L357`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/demux.go#L346-L357))。

```go title="cache/demux.go"
		if resyncSuccess {
			resp := clientv3.WatchResponse{
				Header: &etcdserverpb.ResponseHeader{Revision: d.maxRev},
			}
			if d.maxRev > nextRev && w.enqueueResponse(resp) {
				nextRev = d.maxRev + 1
			}
			delete(d.laggingWatchers, w)
			d.activeWatchers[w] = nextRev
		} else {
			d.laggingWatchers[w] = nextRev
		}
```

**追いついた後、進捗通知を 1 個送ってから active に戻す。** 履歴にイベントが無かったリビジョンぶんを、「ここまでは何も起きていない」と伝えるためだ。これがないと、購読者は「まだ古いリビジョンにいる」と思い続ける。

### 線形化可能な読み取り

ここがこのパッケージの主題だ ([`cache/cache.go#L192-L231`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/cache.go#L192-L231))。

```go title="cache/cache.go"
	if !op.IsSerializable() {
		serverRev, err := c.serverRevision(ctx)
		if err != nil {
			return nil, err
		}
		if requestedRev > serverRev {
			return nil, rpctypes.ErrFutureRev
		}
		if err = c.waitTillRevision(ctx, serverRev); err != nil {
			return nil, err
		}
	}

	kvs, latestRev, err := c.store.Get(startKey, endKey, requestedRev)
```

**手順は 2 段階。**

1. **サーバに「今のリビジョンは?」と聞く。** 実装は「カウントだけの `Get`」で、レスポンスヘッダのリビジョンだけを使う。
2. **キャッシュがそのリビジョンに追いつくまで待ってから、ローカルで読む。**

これで「読み取りを発行した時点でサーバが持っていた最新」が、必ずキャッシュにも入っている状態で読める。**線形化可能性が保たれる。**

```go title="cache/cache.go"
func (c *Cache) serverRevision(ctx context.Context) (int64, error) {
	key := c.prefix
	if key == "" {
		key = "/"
	}
	resp, err := c.kv.Get(ctx, key, clientv3.WithLimit(1), clientv3.WithCountOnly())
	if err != nil {
		return 0, err
	}
	return resp.Header.Revision, nil
}
```

**`WithCountOnly()` + `WithLimit(1)` で、データを一切転送しない。** それでも `Header.Revision` は返るので、[ReadIndex](../linearizable-read-batching/) を通した「今の最新リビジョン」が手に入る。

**「レスポンスヘッダにグローバルなリビジョンが入っている」という API 設計が、この使い方を可能にしている。**

### 追いつきを速める: 進捗通知を要求する

問題は、手順 2 の「追いつくまで待つ」がいつ終わるかだ。

**書き込みが起きなければ、キャッシュのリビジョンは進まない。** サーバのリビジョンが 1000 で、キャッシュが 990 のとき、その 10 個ぶんのイベントは既に配信済みかもしれない。だが watch は「イベントが無い」ことを伝えないので、キャッシュは 990 のままだ。

これを解決するのが **`RequestProgress`** で、「イベントは無いが、ここまで進んだ」という通知をサーバに要求できる。

しかし、常時要求するとサーバに無駄な負荷がかかる。だから **待っている人がいるときだけ送る** ([`cache/progress_requestor.go#L29-L36`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/progress_requestor.go#L29-L36))。

```go title="cache/progress_requestor.go"
// Copied from https://github.com/kubernetes/kubernetes/blob/4116c15/staging/src/k8s.io/apiserver/pkg/storage/cacher/progress/watch_progress.go
type progressRequestor interface {
	// run starts the background loop that sends RequestProgress RPCs.
	run(ctx context.Context)
	// add increments the count of active waiters so the run loop knows to send RequestProgress RPCs.
	add()
	// remove decrements the count of active waiters.
	remove()
}
```

**Kubernetes からコピーしてきたことが、コミットハッシュ付きで明記されている。** 出典を書くのは、後で本家の変更を追える点で実務的だ。

実装 ([`#L58-L100`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/progress_requestor.go#L58-L100))。

```go title="cache/progress_requestor.go"
	for {
		stopped := func() bool {
			p.mux.Lock()
			defer p.mux.Unlock()
			for p.waiting == 0 && !p.stopped {
				p.cond.Wait()
			}
			return p.stopped
		}()
		if stopped {
			return
		}

		select {
		case <-timer.Chan():
			shouldContinue := func() bool {
				p.mux.Lock()
				defer p.mux.Unlock()
				return p.waiting > 0 && !p.stopped
			}()
```

**`sync.Cond` で「待っている人が 0 人の間は完全に眠る」。** タイマーすら回らない。

そして、待っている人が現れたら 100 ms ごとに `RequestProgress` を送る。使う側は `defer` で対にする。

```go title="cache/cache.go"
	c.progressRequestor.add()
	defer c.progressRequestor.remove()
```

**「この最適化が必要な人がいるか」をカウンタで表し、0 なら何もしない。**

`sync.Cond` を使っているのは、**「条件が成立するまで待つ」がチャネルより素直に書けるから** だろう。チャネルで「カウンタが 0 から 1 になった瞬間」を表そうとすると、通知の重複や取りこぼしの扱いが要る。

### 対応していないものは、はっきり断る

[`cache/cache.go#L425-L446`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/cache/cache.go#L425-L446)。

```go title="cache/cache.go"
func (c *Cache) validateWatch(key string, op clientv3.Op) (pred KeyPredicate, err error) {
	switch {
	case op.IsPrevKV():
		return nil, fmt.Errorf("%w: PrevKV not supported", ErrUnsupportedRequest)
	case op.IsFragment():
		return nil, fmt.Errorf("%w: Fragment not supported", ErrUnsupportedRequest)
	case op.IsCreatedNotify():
		return nil, fmt.Errorf("%w: CreatedNotify not supported", ErrUnsupportedRequest)
	case op.IsFilterPut():
		return nil, fmt.Errorf("%w: FilterPut not supported", ErrUnsupportedRequest)
	case op.IsFilterDelete():
		return nil, fmt.Errorf("%w: FilterDelete not supported", ErrUnsupportedRequest)
	}
```

**キャッシュは、元の API のすべてには対応していない。** そして、対応していないオプションが指定されたら **明示的にエラーを返す**。

これが重要なのは、**黙って無視すると、クライアントが「オプションが効いた」と思い込むから** だ。`PrevKV` を無視すると、変更前の値が入っていないイベントが返り、クライアント側で `nil` 参照になる。

`README.md` にも同じ形の注意書きがある。

```markdown title="cache/README.md"
**Note:** gRPC proxy is not supported. The cache relies on `RequestProgress` RPCs, which the gRPC proxy does not forward.
```

**「なぜ非対応か」まで書いてある。** gRPC プロキシが `RequestProgress` を転送しないので、上で見た追いつきの仕組みが動かない。

## なぜそうなっているか

- **1 本の watch に集約できるのは、購読の内容が「範囲」で表せるから。** 個々の購読者がそれぞれ違うキーを見ていても、その和集合を 1 つのプレフィックスで覆えるなら、購読は 1 本でよい。**上流のコストが購読者数に比例しなくなる。**
- **`Get` のリビジョンの次から watch するのが正しいのは、リビジョンが 1 本の時計だから。** 「スナップショットの時点」と「購読の開始点」が同じ座標系で表せるので、隙間も重複も作らずに接続できる。**この接続点の設計が、キャッシュの正しさの土台になる。**
- **watch が切れたら丸ごと取り直すのは、場合分けを消すため。** 「どこまで進んでいたか」を持ち越すと、compaction されていた場合の処理が要る。**取り直しは高くつくが、正しさが単純になる。** キャッシュは失っても再構築できるので、この判断ができる。
- **ローカルの watcher も active / lagging に分けるのは、同じ問題が同じ形で現れるから。** ファンアウトする配信では、遅い受け手の隔離が必ず要る。**層が変わっても、問題の構造が同じなら解も同じになる。**
- **バッファ溢れを `ErrCompacted` として返すのは、クライアントから見て同じ意味だから。** どちらも「その範囲はもう提供できない」。**キャッシュ層が独自のエラーを作ると、クライアントは 2 種類の処理を書くことになる。** 上流と同じ語彙を使えば、既存の処理がそのまま通る。
- **線形化可能な読み取りが「サーバに聞いてから待つ」で作れるのは、レスポンスヘッダにリビジョンが入っているから。** データを 1 バイトも転送せずに「今の時刻」だけ取得できる。**API のすべてのレスポンスにグローバルな位置情報を載せておくと、こういう使い方ができる。**
- **進捗通知を「待っている人がいるときだけ」要求するのは、それが純粋な最適化だから。** 送らなくても、次の書き込みが来れば追いつく。**送るのは待ち時間を短くするためだけ** なので、待っている人がいなければ完全に不要になる。
- **`sync.Cond` を使ったのは、「条件が成立するまで待つ」を素直に書けるから。** カウンタが 0 から 1 になった瞬間を通知するのに、チャネルでは重複や取りこぼしの処理が要る。**Go でも `sync.Cond` が最も素直な場面はある。**
- **非対応のオプションでエラーを返すのは、黙って無視すると誤動作するから。** キャッシュは「透過的な代替」を名乗るので、対応の差はクライアントには見えない。**見えない差は、明示的なエラーにするしかない。**

## どう活かすか

- **同じデータへの多数の購読は、1 本に集約して配り直す。** 上流のコストが購読者数から独立する。集約できる条件は「購読内容が包含関係で覆えること」なので、まずそこを確かめる。
- **スナップショットと購読の接続点は、同じ座標系の値で表す。** 「取得時点のバージョン」がレスポンスに入っていれば、その次から購読するだけで隙間が消える。**この値が返らない API は、キャッシュを正しく作れない。**
- **再接続時は、差分の再開より丸ごと取り直しを検討する。** 差分の再開は効率的だが、「その差分がもう取得できない」場合の処理が要る。再構築可能なキャッシュなら、取り直しのほうが安全で単純だ。
- **キャッシュ層のエラーは、キャッシュ対象と同じ語彙で返す。** 独自のエラー型を作ると、利用側が 2 系統の処理を書くことになる。「意味が同じなら同じエラー」にすれば、キャッシュを挟んだことが利用側から見えなくなる。
- **有限の履歴バッファを持ち、溢れたら明示的に打ち切る。** 無制限に持つとメモリが破綻し、黙って捨てるとデータが欠ける。「ここから先は提供できない」を返して、利用側に取り直させるのが正しい。
- **レスポンスにグローバルな位置情報 (バージョン、LSN、リビジョン) を載せておく。** 「データは要らないが今の位置が知りたい」という使い方ができるようになる。データ転送ゼロの問い合わせが、同期の要になる。
- **純粋な最適化のための定期処理は、「必要としている人の数」で on/off する。** 誰も待っていないなら送らない。カウンタと `add`/`remove` の対で表せば、`defer` で確実に減らせる。
- **他プロジェクトからコードを持ってきたら、出典を URL とコミットハッシュで書く。** 本家の修正を追えるし、なぜこの形なのかの根拠にもなる。
- **「対応していない」は、黙って無視せずエラーにする。** 互換のある代替実装を作るとき、機能の差は利用側から見えない。見えない差を黙認すると、遠くで誤動作が起きる。README にも「何に対応していないか」と「なぜか」を書く。
