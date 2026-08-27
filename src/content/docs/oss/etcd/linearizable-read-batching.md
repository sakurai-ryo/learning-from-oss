---
title: "同じ確認を待っている全員を、通知オブジェクトの差し替えだけで 1 回にまとめる"
description: "etcd の既定の読み取りは、読む前にリーダーへ「自分は最新か」を確認する。1 リクエストごとに確認すると重いので、etcd は待っている読み取りを 1 回の確認に相乗りさせる。その実装は、キューでもカウンタでもなく、「今の待ち行列を表すオブジェクトを新しいものに差し替えてから確認に行く」という 4 行だけでできている。"
sidebar:
  order: 3
---

## 何を学んだか

### どんな状況の話か

etcd の読み取りは、既定で **線形化可能 (linearizable)** だ。「書き込みが成功した後に読んだら、必ずその値が見える」ことを保証する。

分散システムでこれを守るのは、実は簡単ではない。読み取りを受けたノードが、

- リーダーではないかもしれない (古い値を持っている)
- リーダーのつもりだが、実はもう別のノードがリーダーになっているかもしれない (ネットワーク分断)

Raft の答えが **ReadIndex** だ。手順としては、

1. 読み取りを受けたノードが、リーダーに「今のコミット位置を教えてくれ」と聞く。
2. リーダーは、**過半数にハートビートを送って自分がまだリーダーであることを確認してから**、コミット位置を返す。
3. 聞いたノードは、自分の適用済みインデックスがその位置に追いつくまで待つ。
4. 追いついたら、ローカルのストアを読む。

問題は **コスト** だ。手順 2 には過半数へのネットワーク往復が入る。読み取り 1 回ごとにこれをやると、読み取りの多いワークロード (Kubernetes はまさにそれ) で破綻する。

### etcd の答え

**読み取りは大量に来るが、必要な確認は「今この瞬間のコミット位置」1 つだけ**、という点を使う。

1. **読み取りを実行する goroutine は、ReadIndex を投げない。** 「確認が要る」という合図を投げて、通知を待つだけ。
2. **確認を投げるのは、専用のループ 1 本だけ。**
3. **そのループは、確認に行く直前に「待ち行列を表すオブジェクト」を新品に差し替える。** 古いオブジェクトを持っている読み取りが、この 1 回の確認の受益者になる。
4. **確認が終わったら、古いオブジェクトのチャネルを閉じる。** 待っていた全員が同時に起きる。
5. **差し替え後に来た読み取りは、新しいオブジェクトを見ているので、次の回にまとまる。**

キューも参照カウントも要らない。**「誰が待っているか」を数えないことで、バッチ処理が 4 行で書ける。**

## ソースコードのどこか

### 待つ側

[`server/etcdserver/read/read.go#L74-L94`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/read/read.go#L74-L94)。

```go title="server/etcdserver/read/read.go"
func (r *Read) LinearizableReadNotify(ctx context.Context) error {
	r.mux.RLock()
	nc := r.notifier
	r.mux.RUnlock()

	// signal linearizable loop for current notify if it hasn't been already
	select {
	case r.waitC <- struct{}{}:
	default:
	}

	// wait for read state notification
	select {
	case <-nc.c:
		return nc.err
	case <-ctx.Done():
		return ctx.Err()
	case <-r.server.Done():
		return errors.ErrStopped
	}
}
```

やっていることは 3 つ。

1. **今の `notifier` を掴む。** ここで掴んだオブジェクトが、この読み取りにとっての「自分の回」になる。
2. **`waitC` に非ブロッキングで合図を送る。** バッファ 1 のチャネルに `default` 付きで送っているので、**すでに合図が入っていれば何もしない**。1000 個の読み取りが同時に来ても、ループを起こすのは 1 回。
3. **掴んだ `notifier` のチャネルが閉じるのを待つ。**

`notifier` の中身は 3 フィールドしかない ([`server/etcdserver/read/util.go#L17-L31`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/read/util.go#L17-L31))。

```go title="server/etcdserver/read/util.go"
type notifier struct {
	c   chan struct{}
	err error
}

func newNotifier() *notifier {
	return &notifier{
		c: make(chan struct{}),
	}
}

func (nc *notifier) notify(err error) {
	nc.err = err
	close(nc.c)
}
```

**チャネルを閉じることで、待っている全員に一斉に通知する。** 値を送る形だと待っている人数だけ送る必要があるが、`close` なら人数を知らなくてよい。

`err` に代入してから `close` している順序も重要だ。`close` が起きる前の書き込みは、`close` を観測した goroutine から必ず見える。**チャネルの close が、エラーフィールドの可視性の境界になっている。** ミューテックスを追加せずに、結果とエラーの両方を配れる。

### 差し替える側

[`#L96-L146`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/read/read.go#L96-L146)。核心は 5 行だ。

```go title="server/etcdserver/read/read.go"
		nextnr := newNotifier()
		r.mux.Lock()
		nr := r.notifier
		r.notifier = nextnr
		r.mux.Unlock()

		confirmedIndex, err := r.requestCurrentIndex(leaderChangedNotifier)
```

**確認に行く「前」に差し替える。** この順序が全部を決めている。

- 差し替えより前に `LinearizableReadNotify` に入った読み取りは、`nr` を掴んでいる。これから始まる確認の結果で解放される。
- 差し替えより後に入った読み取りは、`nextnr` を掴む。**この確認の結果では解放されない。**

後者を解放してはいけない理由は、順序にある。`requestCurrentIndex` が返すのは「差し替え時点でのリーダーのコミット位置」だ。差し替え後に到着した読み取りは、それより後に書かれた値を見る権利がある。**古い確認結果で解放すると、線形化可能性が壊れる。**

逆に言えば、**「いつ差し替えるか」だけが正しさを決めていて、待っている読み取りの数も ID も一切追跡していない。**

解放の側。

```go title="server/etcdserver/read/read.go"
		appliedIndex := r.server.AppliedIndex()

		if appliedIndex < confirmedIndex {
			select {
			case <-r.server.ApplyWait(confirmedIndex):
			case <-r.server.Stopping():
				return
			}
		}
		// unblock all l-reads requested at indices before confirmedIndex
		nr.notify(nil)
```

リーダーのコミット位置に自分の適用が追いつくのを待ってから、`nr` を閉じる。エラーの場合も同じ `notifier` にエラーを載せて閉じるので、**待っている全員が同じ結果 (成功でも失敗でも) を共有する**。

### 「追いつくのを待つ」も、人数を数えない

`ApplyWait` は `pkg/wait` の `WaitTime` で実装されている ([`pkg/wait/wait_time.go#L19-L26`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/wait/wait_time.go#L19-L26))。

```go title="pkg/wait/wait_time.go"
type WaitTime interface {
	// Wait returns a chan that waits on the given logical deadline.
	// The chan will be triggered when Trigger is called with a
	// deadline that is later than or equal to the one it is waiting for.
	Wait(deadline uint64) <-chan struct{}
	// Trigger triggers all the waiting chans with an equal or earlier logical deadline.
	Trigger(deadline uint64)
}
```

「論理的な締切」で待つ。適用ループが `Trigger(appliedIndex)` を呼ぶと、**その値以下で待っていた全員が一斉に起きる**。

実装で目を引くのが、すでに過ぎている場合の扱いだ ([`#L28-L54`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/wait/wait_time.go#L28-L54))。

```go title="pkg/wait/wait_time.go"
var closec chan struct{}

func init() { closec = make(chan struct{}); close(closec) }

func (tl *timeList) Wait(deadline uint64) <-chan struct{} {
	tl.l.Lock()
	defer tl.l.Unlock()
	if tl.lastTriggerDeadline >= deadline {
		return closec
	}
```

**「最初から閉じているチャネル」をパッケージ変数として 1 個だけ持っておき、待つ必要がないときはそれを返す。** 呼び出し側は結果を常に `<-ch` として扱えるので、「待つ場合」と「待たない場合」で分岐する必要がない。

チャネルの割り当ても起きない。「もう過ぎている」は頻繁に起きるケースなので、そこにゼロコストの道を用意している。

### 確認そのものは、あきらめない作りになっている

`requestCurrentIndex` は 80 行あって、その大半がリトライと打ち切りの条件だ ([`#L148-L230`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/read/read.go#L148-L230))。`select` の枝を並べると設計が見える。

```go title="server/etcdserver/read/read.go"
	for {
		select {
		case rs := <-r.raft.ReadState():
			// Check again if leader changed as when multiple channels are ready, select picks randomly.
			select {
			case <-leaderChangedNotifier:
				readIndexFailed.Inc()
				return 0, errors.ErrLeaderChanged
			default:
			}
```

**`select` が複数の枝で準備できているとき、Go はランダムに選ぶ。** だから「リーダーが変わった」と「読み取り結果が届いた」が同時に準備できていると、結果のほうが選ばれることがある。そこで、結果を受け取った直後にもう一度リーダー交代をチェックしている。

**Go の `select` の意味論そのものが、正しさのバグになりうる箇所を作っている。** コメントがその理由を明示している。

応答の照合。

```go title="server/etcdserver/read/read.go"
			responseID := uint64(0)
			if len(rs.RequestCtx) == 8 {
				responseID = binary.BigEndian.Uint64(rs.RequestCtx)
			}
			if _, ok := requestIDs[responseID]; !ok {
				// a previous request might time out. now we should ignore the response of it and
				// continue waiting for the response of the current requests.
				lg.Warn(
					"ignored out-of-date read index response; local node read indexes queueing up and waiting to be in sync with leader",
					zap.Uint64("received-request-id", responseID),
				)
				slowReadIndex.Inc()
				continue
			}
			return rs.Index, nil
```

ReadIndex には任意のバイト列 (`RequestCtx`) を添えられて、応答にそのまま返ってくる。etcd はそこに 8 バイトのリクエスト ID を入れている。

**`requestIDs` が集合になっているのがポイント。** リトライのたびに新しい ID を送るが、古い ID の応答が後から届く可能性がある。集合に入れておけば、**リトライ前の応答が届いてもそれを採用できる**。「最新の ID だけ受け付ける」にすると、遅れて届いた有効な応答を捨ててしまう。

リトライの契機は 3 つある。

```go title="server/etcdserver/read/read.go"
		case <-firstCommitInTermNotifier:
			firstCommitInTermNotifier = r.server.FirstCommitInTermNotify()
			lg.Info("first commit in current term: resending ReadIndex request")
			requestID = r.server.NextRequestID()
			requestIDs[requestID] = struct{}{}
			err := r.sendReadIndex(requestID)
```

`firstCommitInTermNotifier` は「新しい任期で最初のコミットが起きた」通知だ。**Raft のリーダーは、自分の任期で 1 個もコミットしていない間は ReadIndex に答えられない** (自分の任期のエントリがコミットされるまで、コミット位置を確定できないため)。だから、選挙直後に投げた ReadIndex は宙に浮く。その状態が解消した瞬間に再送する。

残りの 2 つは時間ベースで、**500 ms でリトライ、リクエストタイムアウトで打ち切り**。リトライには専用のメトリクス (`etcd_server_slow_read_indexes_total`) が付いていて、「読み取りが遅い」の原因がここかどうかを切り分けられる。

### ループの入口にもリーダー交代のチェックがある

```go title="server/etcdserver/read/read.go"
	for {
		leaderChangedNotifier := r.server.LeaderChanged()
		select {
		case <-leaderChangedNotifier:
			continue
		case <-r.waitC:
		case <-r.server.Stopping():
			return
		}
```

**`LeaderChanged()` を毎周取り直している。** これは「次にリーダーが変わったら閉じるチャネル」を返すもので、1 回使うと使い捨てになる。ループの先頭で取り直すことで、この周回で使う `leaderChangedNotifier` が「今の任期」に対応することが保証される。

先頭の `case <-leaderChangedNotifier: continue` は、**すでに閉じたチャネルを掴んでしまった場合に、取り直しに戻る** ためのものだ。

## なぜそうなっているか

- **バッチにまとめられるのは、確認の結果が「誰が要求したか」に依存しないから。** ReadIndex が返すのは「今のコミット位置」という 1 つのグローバルな値で、リクエストごとに違う答えにはならない。**同じ答えを待っている人が複数いるなら、聞くのは 1 回でよい。** キャッシュやコアレッシングが成立する条件はいつもこれだ。
- **人数を数えないのは、数えるとロックの範囲が広がるから。** 「今何人待っているか」を管理すると、待ち始めと待ち終わりの両方でカウンタを触ることになる。**オブジェクトを差し替える方式なら、触るのは差し替えの瞬間だけ** で、そこは 1 本のループしか通らない。
- **差し替えを「確認の前」に置くのは、線形化可能性のため。** 確認結果が有効なのは「確認を始めた時点までに到着した読み取り」に対してだけだ。後から来たものを混ぜると、確認より後に書かれた値を見逃す。**バッチの境界が、そのまま正しさの境界になっている。**
- **`close` で通知するのは、受け手の数を知らなくてよいから。** 値を送る形にすると、`for i := 0; i < n; i++ { ch <- x }` のように人数が要る。close は 1 回で全員に届く。副産物として、**close 前の書き込みが close 後に必ず見える** というメモリモデルの保証も使える。
- **待つ必要がないときに閉じたチャネルを返すのは、呼び出し側の分岐を消すため。** `if 過ぎている { 何もしない } else { <-ch }` を呼び出し側に書かせると、その分岐を忘れる場所が出る。**常に `<-ch` でよい** という一様性のほうが安全だ。
- **リトライで新しい ID を振りつつ、古い ID も受け付けるのは、遅い応答と失われた応答が区別できないから。** タイムアウトしたリクエストの応答が、直後に届くことは普通にある。捨てると、その分だけ余計に待つことになる。**「もう要らない」ではなく「まだ有効」として扱えるものは、集合に入れておく。**
- **選挙直後の専用の再送契機があるのは、ReadIndex がその期間だけ構造的に答えられないから。** 単なるタイムアウトのリトライでも最終的には回復するが、最悪 500 ms 待つ。**「答えられない理由」が分かっているなら、その理由が解消した瞬間を通知にする** ほうが速い。
- **`select` の直後にもう一度チェックするのは、Go の `select` がランダムに選ぶから。** 「複数の条件が同時に真のとき、どれが優先か」を `select` は表現できない。優先順位が必要なら、選んだ後に自分で確かめるしかない。

## どう活かすか

- **「全員が同じ答えを待っている」形の待ちは、1 回にまとめられる。** キャッシュのサンダリングハード対策、設定の再読み込み、トークンの更新、ヘルスチェック。要求ごとに答えが変わらないなら、要求の数だけ実行する必要はない。
- **バッチをまとめるのに、待っている人を数えなくてよい。** 「今の回」を表すオブジェクトを共有し、実行の直前に新品へ差し替える。差し替えの瞬間がバッチの境界になり、それ以外の場所にロックが要らなくなる。
- **一斉通知はチャネルの close (あるいは同等のブロードキャスト) で表す。** 受け手の数に依存しない通知手段を選ぶと、登録・解除の管理そのものが不要になる。
- **結果とエラーは、通知オブジェクトのフィールドに載せてから閉じる。** 通知の順序保証がそのまま可視性の保証になるので、追加の同期が要らない。
- **「待つ必要がない」を、閉じた共有チャネルで表す。** 呼び出し側の分岐を消せるうえ、割り当ても起きない。ゼロ値やダミーオブジェクトを 1 個だけ用意しておく手は、他の場面でも効く。
- **リトライで ID を振り直すときは、古い ID も有効なまま残す。** タイムアウトは「失われた」ではなく「遅い」かもしれない。集合で持っておけば、遅れて届いた応答をそのまま使える。
- **「構造的に応答できない期間」があるなら、それが終わったことを通知にする。** 時間ベースのリトライだけだと、条件が整った直後の再試行を待ち時間ぶん遅らせることになる。
- **優先順位のある多重待ちを `select` で書いたら、選択後に再確認する。** Go の `select` は公平性のためにランダムを選ぶので、「エラー条件を優先したい」は表現できない。
