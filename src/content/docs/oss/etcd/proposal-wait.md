---
title: "非同期な処理系との対応付けを ID 1 個で表し、その登録簿を「結果が要るか」の判定にも使う"
description: "etcd では、リクエストを受けた goroutine と、それを適用する goroutine が別物になる。両者を繋ぐのは 64 ビットの ID 1 個で、生成器はメンバー ID・時刻・カウンタを詰め込んで再起動をまたいだ一意性を作る。さらに etcd は、この待ち行列の登録簿を「誰も待っていないなら結果を計算しない」という最適化にも使っている。"
sidebar:
  order: 5
---

## 何を学んだか

### どんな状況の話か

etcd の書き込みは、こういう経路を通る ([前提のページ](../architecture/) を参照)。

```
gRPC ハンドラ (goroutine A)          適用ループ (goroutine B)
      │                                    │
      ├─ Raft に提案 ─────────────────────▶ │ (合意・永続化を経て)
      │                                    ├─ 適用して結果を得る
      ├─ ??? ◀─────────────────────────────┤
      │
      └─ クライアントに応答
```

**A と B の間には、呼び出し関係も参照関係もない。** B は「今どの goroutine がこのリクエストを待っているか」を知らないし、知る必要もない。合意を経たエントリは、他のノードから来たものかもしれない (その場合は誰も待っていない)。

必要なのは、「このエントリの適用結果を、対応する待ち手に届ける」という仕組みだけだ。

### 素朴な実装が抱える問題

コールバックを登録する形にすると、適用ループが呼び出し側のライフサイクルに縛られる。クライアントがタイムアウトで消えた後にコールバックを呼ぶと、解放済みのリソースに触ることになる。

チャネルを直接渡す形にすると、そのチャネルを適用ループまで運ぶ経路が要る。しかし間には **protobuf にシリアライズされて Raft のログに載り、ネットワークを渡ってディスクに書かれる** という区間がある。Go の値は通れない。

**通れるのはバイト列だけ。** だから、ID を振ってバイト列に載せ、ローカルの登録簿で引き直すしかない。

### etcd の答え

1. **リクエストごとに 64 ビットの ID を振り、protobuf のヘッダに入れる。** これが Raft のログに載って一周してくる。
2. **提案する前に、その ID でチャネルを登録する。** 登録簿は `pkg/wait` の 30 行ほどの構造体。
3. **適用側は、ID を鍵に登録簿を引いて結果を流し込む。** 見つからなければ何もしない。
4. **ID 生成器は、メンバー ID・時刻・カウンタを 1 つの `uint64` に詰める。** 再起動をまたいでも衝突しない。
5. **登録簿は「誰か待っているか」の問い合わせにも使う。** 誰も待っていない読み取りは、結果を計算せずに捨てる。
6. **失敗した経路でも必ず登録を消す。** `Trigger(id, nil)` に `// GC wait` というコメントが付いている。

## ソースコードのどこか

### 登録簿

[`pkg/wait/wait.go#L31-L41`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/wait/wait.go#L31-L41)。

```go title="pkg/wait/wait.go"
// Wait is an interface that provides the ability to wait and trigger events that
// are associated with IDs.
type Wait interface {
	// Register waits returns a chan that waits on the given ID.
	// The chan will be triggered when Trigger is called with
	// the same ID.
	Register(id uint64) <-chan any
	// Trigger triggers the waiting chans with the given ID.
	Trigger(id uint64, x any)
	IsRegistered(id uint64) bool
}
```

**メソッドは 3 つだけ。** `Register` でチャネルを得て、`Trigger` で値を届けて、`IsRegistered` で存在を問う。

実装は、ミューテックス付きマップの配列になっている ([`#L24-L29`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/wait/wait.go#L24-L29))。

```go title="pkg/wait/wait.go"
const (
	// To avoid lock contention we use an array of list struct (rw mutex & map)
	// for the id argument, we apply mod operation and uses its remainder to
	// index into the array and find the corresponding element.
	defaultListElementLength = 64
)
```

**ID の剰余で 64 個のバケットに分ける。** 1 個のマップと 1 個のミューテックスでも動くが、書き込みの並行度がそこで頭打ちになる。ID がほぼランダムに分布するので、剰余は良いハッシュとして機能する。

`sync.Map` を使わずに素朴なシャーディングを選んでいるのは、**アクセスパターンが「1 回登録して 1 回消す」だから** だろう。`sync.Map` は読み取りが圧倒的に多い場合に効くが、ここは書き込みしかない。

登録と発火 ([`#L63-L86`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/wait/wait.go#L63-L86))。

```go title="pkg/wait/wait.go"
func (w *list) Register(id uint64) <-chan any {
	idx := id % defaultListElementLength
	newCh := make(chan any, 1)
	w.e[idx].l.Lock()
	defer w.e[idx].l.Unlock()
	if _, ok := w.e[idx].m[id]; !ok {
		w.e[idx].m[id] = newCh
	} else {
		log.Panicf("dup id %x", id)
	}
	return newCh
}

func (w *list) Trigger(id uint64, x any) {
	idx := id % defaultListElementLength
	w.e[idx].l.Lock()
	ch := w.e[idx].m[id]
	delete(w.e[idx].m, id)
	w.e[idx].l.Unlock()
	if ch != nil {
		ch <- x
		close(ch)
	}
}
```

3 点、意図的な選択がある。

- **ID の重複は `Panic`。** 「たぶん起きない」ではなく「起きたら気づく」。ID の一意性はこの仕組み全体の前提なので、破れたら続行する意味がない。
- **チャネルはバッファ 1。** `ch <- x` がロックの外側にあるが、バッファがあるので受け手がいなくてもブロックしない。**適用ループが、消えた待ち手のせいで止まることがない。**
- **送ってから閉じる。** 受け手は値を取れるし、`for range` でも終端が来る。二重に `Trigger` されても、マップから消えているので `ch` は `nil` になり、閉じたチャネルへの送信 (panic) は起きない。

### ID 生成器

[`pkg/idutil/id.go#L31-L49`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/idutil/id.go#L31-L49)。

```go title="pkg/idutil/id.go"
// Generator generates unique identifiers based on counters, timestamps, and
// a node member ID.
//
// The initial id is in this format:
// High order 2 bytes are from memberID, next 5 bytes are from timestamp,
// and low order one byte is a counter.
// | prefix   | suffix              |
// | 2 bytes  | 5 bytes   | 1 byte  |
// | memberID | timestamp | cnt     |
//
// The timestamp 5 bytes is different when the machine is restart
// after 1 ms and before 35 years.
//
// It increases suffix to generate the next id.
// The count field may overflow to timestamp field, which is intentional.
// It helps to extend the event window to 2^48. This doesn't break that
// id generated after restart is unique because etcd throughput is <<
// 256req/ms(250k reqs/second).
type Generator struct {
```

**衝突を避けるべき 3 つの軸が、そのままバイト位置になっている。**

- **メンバー ID (2 バイト)**: 別のノードが振った ID とは絶対に衝突しない。
- **時刻 (5 バイト、ミリ秒)**: 同じノードでも、再起動をまたげば違う値になる。「1 ms 後から 35 年後まで区別できる」と書いてある。
- **カウンタ (1 バイト)**: 同じミリ秒の中での連番。

一番面白いのが **「カウンタが時刻フィールドに桁上がりするのは意図的」** という一文だ。

```go title="pkg/idutil/id.go"
func (g *Generator) Next() uint64 {
	suffix := atomic.AddUint64(&g.suffix, 1)
	id := g.prefix | lowbit(suffix, suffixLen)
	return id
}
```

実装は `suffix` 全体 (6 バイト) を単純にインクリメントするだけで、カウンタと時刻の境界を意識していない。**1 ミリ秒に 256 個を超える ID を振ると、時刻部分に食い込む。**

普通なら「バグ」と呼ぶ挙動だが、コメントは「意図的だ」と言い切る。理由も書いてある。

- 食い込むことで、実質的な ID 空間が 2^48 に広がる。
- **再起動後の一意性は破れない。** なぜなら、etcd のスループットが 256 req/ms (25 万 req/s) には遠く及ばないので、「食い込んだ値が、再起動後の時刻に追いつく」ことがないから。

**性能特性を根拠にした設計判断が、その根拠ごと書き残されている。** もし etcd が 100 倍速くなったら、この前提は崩れる。そのときに何を見直せばよいかが、このコメントから分かる。

### 提案する側

[`server/etcdserver/v3_server.go#L1058-L1131`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/v3_server.go#L1058-L1131)。骨だけ抜くとこうなる。

```go title="server/etcdserver/v3_server.go"
	r.Header = &pb.RequestHeader{
		ID: s.reqIDGen.Next(),
	}
	// ...
	id := r.ID
	if id == 0 {
		id = r.Header.ID
	}
	ch := s.w.Register(id)

	cctx, cancel := context.WithTimeout(ctx, s.Cfg.ReqTimeout())
	defer cancel()

	err = s.r.Propose(cctx, data)
	if err != nil {
		proposalsFailed.Inc()
		s.w.Trigger(id, nil) // GC wait
		return nil, err
	}

	select {
	case x := <-ch:
		return x.(*apply2.Result), nil
	case <-cctx.Done():
		proposalsFailed.Inc()
		s.w.Trigger(id, nil) // GC wait
```

**`// GC wait` というコメント付きの `Trigger(id, nil)` が 2 箇所ある。**

登録簿はマップなので、登録したまま誰も `Trigger` しなければエントリが残り続ける。提案が失敗した場合と、タイムアウトした場合がそれにあたる。**`Trigger` を「結果を届ける」ではなく「登録を消す」として使っている。**

`nil` を流し込むので、万一その後に本物の結果が来ても、そのときはマップに無いので何も起きない。二重解放にならない。

**登録簿を持つなら、登録を消す経路をすべて塞ぐ必要がある。** そして、消すための専用メソッドを増やさずに `Trigger` を流用しているのが、この設計の簡潔さでもある。

### 適用が追いつかないなら、受け付けない

提案の入口には、こういうチェックがある ([`server/etcdserver/util.go#L57-L74`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/util.go#L57-L74))。

```go title="server/etcdserver/util.go"
// exceedsRequestLimit checks if the committed index is too far ahead of the applied index.
// LeaseRevoke requests are prioritized to ensure timely lease expiration,
// which helps mitigate pressure on the cluster.
func exceedsRequestLimit(appliedIndex, committedIndex uint64, r *pb.InternalRaftRequest, enablePriority bool) bool {
	if committedIndex <= appliedIndex+maxNormalGap {
		return false
	}
	if enablePriority && isPriorityRequest(r) {
		if committedIndex <= appliedIndex+maxPriorityGap {
			return false
		}
	}
	return true
}
```

しきい値は 5000 エントリ、優先リクエストは倍の 10000 ([`server/etcdserver/v3_server.go#L45-L53`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/v3_server.go#L45-L53))。

```go title="server/etcdserver/v3_server.go"
	// In the health case, there might be a small gap (10s of entries) between
	// the applied index and committed index.
	// However, if the committed entries are very heavy to toApply, the gap might grow.
	// We should stop accepting new proposals if the gap growing to a certain point.
	maxGapBetweenApplyAndCommitIndex = 5000
```

**コミット済みと適用済みの差が、そのままバックプレッシャーの指標になっている。**

差が開くということは「合意はできているが適用が追いつかない」状態で、そこで新しい提案を受けると、Raft のログとメモリだけが伸びる。**受け付けを止めるほうが、クライアントにとっても速く失敗を返せる。**

優先されるのが `LeaseRevoke` だけ、というのも読みどころだ。lease の失効はキーの削除を伴うので、**それを止めると詰まりが悪化する**。「詰まりを解消する方向に働くリクエストだけを通す」という判断になっている。

### 誰も待っていないなら、結果を作らない

適用側は、登録簿を **問い合わせにも** 使う ([`server/etcdserver/apply/apply.go#L27-L49`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/apply.go#L27-L49))。

```go title="server/etcdserver/apply/apply.go"
	needResult := w.IsRegistered(id)
	wrapper := &InternalRaftRequestWrapper{
		InternalRaftRequest: &raftReq,
		SkipRangeExecution:  !needResult && raftReq.Txn != nil,
	}
	if needResult || !noSideEffect(&raftReq) {
		return uberApply.Apply(wrapper, shouldApplyV3), id
	}
	return nil, id
}

func noSideEffect(r *pb.InternalRaftRequest) bool {
	return r.Range != nil || r.AuthUserGet != nil || r.AuthRoleGet != nil || r.AuthStatus != nil
}
```

**`IsRegistered` は「このノードが、このリクエストの応答を返す担当か」を意味している。**

自分が提案したリクエストなら登録がある。他のノードが提案したものなら無い。だから、

- **副作用のないリクエスト (Range など) で、誰も待っていないなら、実行しない。** 結果を捨てるだけの読み取りに CPU を使わない。
- **`Txn` の中の Range 部分も、結果が要らないならスキップする** (`SkipRangeExecution`)。`Txn` は副作用があるので実行は必要だが、その中の読み取り部分の結果は誰も見ない。

`Txn` の比較 (`If`) は当然実行される。スキップされるのは、`Then` / `Else` に含まれる `Range` の実際の読み出しだけだ。**すべてのノードで同じ状態変化が起きることは保たれたまま、無駄な読み出しだけが消える。**

登録簿という 1 つの構造が、「結果を届ける先」と「結果が必要かどうか」の両方を表している。

### 応答を意図的に遅らせる場面

容量超過のときだけ、応答の流し込みが変則的になる ([`server/etcdserver/server.go#L1962-L1988`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/server.go#L1962-L1988))。

```go title="server/etcdserver/server.go"
	if !errorspkg.Is(ar.Err, errors.ErrNoSpace) || len(s.alarmStore.Get(pb.AlarmType_NOSPACE)) > 0 {
		s.w.Trigger(id, ar)
		return
	}

	lg := s.Logger()
	lg.Warn(
		"message exceeded backend quota; raising alarm",
		// ...
	)

	s.GoAttach(func() {
		a := &pb.AlarmRequest{
			MemberID: uint64(s.MemberID()),
			Action:   pb.AlarmRequest_ACTIVATE,
			Alarm:    pb.AlarmType_NOSPACE,
		}
		s.raftRequest(s.ctx, &pb.InternalRaftRequest{Alarm: a})
		s.w.Trigger(id, ar)
	})
```

**「容量超過」というエラーを返す前に、アラームをクラスタ全体に合意させ、それが終わってから応答する。**

普通に考えれば、エラーはすぐ返すべきだ。しかしここでは、クライアントが `ErrNoSpace` を見た時点で、**クラスタはすでに書き込み禁止状態に入っていること** を保証している。そうしないと、エラーを受けたクライアントがリトライして、また同じエラーを踏む競合が起きうる。

`Trigger` が別 goroutine から、しかも数十ミリ秒後に呼ばれても問題ない。**登録簿が ID で引ける形になっているおかげで、応答のタイミングを自由に選べる。**

## なぜそうなっているか

- **ID で対応付けるしかないのは、間に「Go の値が通れない区間」があるから。** リクエストは protobuf になって Raft のログに載り、ディスクとネットワークを渡って戻ってくる。**シリアライズ可能なものだけが通れる境界を挟むなら、対応付けは ID になる。** RPC の correlation ID も、メッセージキューの相関 ID も同じ理屈だ。
- **ID にメンバー ID と時刻を埋め込むのは、調整なしで一意性を作るため。** 中央のシーケンス発行器を置けば厳密に一意にできるが、そのために合意が要る。「空間 (メンバー) で分け、時間で分け、その中で連番」なら、通信ゼロで衝突しない。
- **カウンタの桁上がりを許すのは、実際の速度が桁違いに遅いから。** 抽象的には不正だが、具体的な数字を当てはめると起きない。**「起きない」ではなく「なぜ起きないか」が書かれている** ので、前提が変わったときに気づける。
- **ID の重複を panic にするのは、それが破れたら全体が壊れるから。** 別のリクエストの結果が別のクライアントに返る、という最悪の形の不具合になる。**「たぶん大丈夫」で済ませてよい種類の前提ではない。**
- **登録簿のチャネルにバッファを 1 持たせるのは、受け手の消失で送り手を止めないため。** 適用ループはクラスタ全体の進行を担っているので、1 個のクライアントのタイムアウトで止まってはいけない。
- **失敗経路で `Trigger(id, nil)` を呼ぶのは、登録簿がマップだから。** 登録したものは必ず消える必要がある。専用の `Unregister` を作らず、既存の `Trigger` を流用しているのは、**「消える経路を 1 本にする」** ためでもある。
- **コミットと適用の差でバックプレッシャーをかけるのは、それが最も直接的な指標だから。** CPU 使用率でもキューの長さでもなく、「合意済みだがまだ適用していないエントリ数」がそのまま遅れの量になる。しかも、その数値は既に別の目的で管理されている。
- **`IsRegistered` を最適化の判定に使えるのは、登録の有無が「自分が提案したか」と一致するから。** 意味の重なりを見つけて、既にある構造をもう 1 つの目的に使い回している。新しいフラグを追加していない。
- **エラー応答を意図的に遅らせるのは、クライアントが観測する状態の順序を守るため。** 「エラーを見た時点で、その原因となる状態はクラスタに反映済み」という関係が成り立つと、クライアント側のリトライ戦略が単純になる。

## どう活かすか

- **シリアライズの境界をまたぐ処理は、ID + ローカル登録簿で対応付ける。** ジョブキュー、非同期 RPC、イベント駆動の処理系すべてに同じ形が使える。コールバックやチャネルを直接渡す設計は、境界を越えられない。
- **調整なしで一意な ID がほしいなら、「空間 + 時間 + 連番」をビットで分ける。** ノード ID で空間を分け、起動時刻で再起動をまたぎ、カウンタで同一時刻内を分ける。中央の採番サービスが要らなくなる。
- **性能を根拠にした設計判断は、その数字ごとコメントに書く。** 「256 req/ms を超えなければ安全」という条件が書いてあれば、性能が上がったときに何を見直せばよいかが分かる。根拠のない「大丈夫」は、5 年後に誰も検証できない。
- **前提が破れたら全体が壊れる種類の条件は、panic で守る。** ID の重複のように、破れても静かに動き続けて別の場所で症状が出るものは、発生時点で落とすほうが安い。
- **登録簿を作ったら、消す経路をすべて列挙する。** 正常終了・エラー・タイムアウト・キャンセル。1 本でも塞ぎ忘れると、その分だけメモリが伸び続ける。消す操作を専用に増やさず、既存の通知経路を流用すると経路が集約される。
- **通知チャネルにはバッファを 1 つ持たせる。** 受け手が消えていても送り手が止まらない。共有の処理ループから個別の待ち手へ結果を返す場面では、ほぼ必ずこれが要る。
- **バックプレッシャーの指標は、既に管理している数値から選ぶ。** 「投入済み - 処理済み」の差は、たいていどこかで既に持っている。新しい計測を足すより、その差を見るほうが正確で安い。
- **「誰も結果を待っていない」を判定できるなら、その計算自体を省く。** 待ち行列の登録簿は、その判定の情報を既に持っていることが多い。副作用のある処理は実行しつつ、結果の生成だけを飛ばす、という切り分けができる場面は意外に多い。
- **エラーを返す前に、その原因となる状態を確定させる。** 「エラーを見た = 状態が反映済み」という順序が保証されると、呼び出し側のリトライやフェイルオーバーの設計が単純になる。ID ベースの応答なら、返すタイミングを自由に選べる。
