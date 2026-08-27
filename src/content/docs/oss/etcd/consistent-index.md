---
title: "「どこまで適用したか」をデータと同じトランザクションに書くと、再起動時の再適用が安全になる"
description: "etcd は WAL に書いたログを、再起動のたびに先頭から再適用する。二重適用を防ぐ鍵は consistent index という 1 個の数字で、これがデータと同じ bbolt トランザクションにコミットされる。「進捗を別の場所に持たない」という一点が、クラッシュ耐性のほとんどを担っている。"
sidebar:
  order: 4
---

## 何を学んだか

### どんな状況の話か

[Ready ループのページ](../raft-ready-loop/) で見たとおり、etcd は 2 つのものをディスクに書く。

- **WAL**: 合意されたログエントリ。「これから適用すべきこと」の記録。
- **db (bbolt)**: 適用した結果。

この 2 つは **同時には書かれない**。WAL に書いてから、しばらくして適用され、その結果が db に入る。しかも db への書き込みはバッチにまとめられていて、さらに遅れる ([backend のページ](../backend-batch-tx/))。

したがって、プロセスがクラッシュした時点では必ず **WAL のほうが先に進んでいる**。再起動したら、その差分を再適用しなければならない。

ここで問題になるのが **二重適用** だ。

- 差分を多めに再適用すると、同じ `Put` が 2 回起きる。冪等な操作なら見た目は同じだが、**リビジョンが 2 進む**。他のノードとリビジョンがずれ、クラスタが壊れる。
- 差分を少なく見積もると、書き込みが失われる。

つまり、「db にはどこまで反映されているか」を **正確に** 知る必要がある。

### 素朴な解が失敗する理由

「適用済みインデックスを別ファイルに書く」「メタデータ用のバケットに書いて、データを書いた後に別トランザクションでコミットする」——どちらも、2 つの書き込みの間でクラッシュできる。

- 進捗を先に書くと、データを書く前に落ちたときに「適用済み」と誤認する → **書き込みの喪失**。
- 進捗を後に書くと、データを書いた後に落ちたときに「未適用」と誤認する → **二重適用**。

**2 つの永続化がある限り、その間のクラッシュを消せない。**

### etcd の答え

**進捗をデータと同じトランザクションに入れる。**

1. **`consistent index` はメタデータバケットの 1 キーとして db に持つ。** 別ファイルでも別 DB でもない。
2. **書くタイミングは「コミットの直前」。** backend が bbolt のトランザクションをコミットする直前にフックを呼び、そこで現在の値を書き込む。
3. **結果として、データと進捗は原子的にコミットされる。** どちらか片方だけがディスクに残ることはない。
4. **再起動時は、db から読んだ index より大きいエントリだけを適用する。** 判定は `e.Index > consistentIndex` という 1 行の比較。
5. **「適用中の値」と「永続化してよい値」を別々に持つ。** エントリの適用中に別の理由でコミットが走っても、まだ完了していないエントリの index が書かれないようにする。

## ソースコードのどこか

### 判定は 1 行

[`server/etcdserver/server.go#L1892-L1899`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/server.go#L1892-L1899)。

```go title="server/etcdserver/server.go"
		// We need to toApply all WAL entries on top of v2store
		// and only 'unapplied' (e.GetIndex()>backend.ConsistentIndex) on the backend.
		shouldApplyV3 := membership.ApplyV2storeOnly
		if e.GetIndex() > index {
			shouldApplyV3 = membership.ApplyBoth
			// set the consistent index of current executing entry
			s.consistIndex.SetConsistentApplyingIndex(e.GetIndex(), e.GetTerm())
		}
```

**再起動時の「再適用すべきか」の判断が、この比較だけで済んでいる。**

`shouldApplyV3` は bool 相当の型で、この後の適用処理の全体に引き回される。値が `ApplyV2storeOnly` のときは、KV ストアへの書き込みが全部スキップされる。「エントリは読むが、状態は変えない」空回しになる。

なぜ空回しが必要かというと、v2store (旧世代の、メンバーシップ情報を持つストア) は db とは別のスナップショット規律で動いていて、そちらには全部適用する必要があるからだ。**「適用済み」の境界が層ごとに違う** ので、フラグとして持ち回している。

### 進捗はコミットの直前に書かれる

`backend` はコミット直前にフックを呼ぶ ([`server/storage/backend/batch_tx.go#L361-L366`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/batch_tx.go#L361-L366))。

```go title="server/storage/backend/batch_tx.go"
func (t *batchTxBuffered) unsafeCommit(stop bool) {
	if t.backend.hooks != nil {
		// gofail: var commitBeforePreCommitHook struct{}
		t.backend.hooks.OnPreCommitUnsafe(t)
		// gofail: var commitAfterPreCommitHook struct{}
	}
```

フックの中身 ([`server/storage/hooks.go#L45-L54`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/hooks.go#L45-L54))。

```go title="server/storage/hooks.go"
func (bh *BackendHooks) OnPreCommitUnsafe(tx backend.UnsafeReadWriter) {
	bh.indexer.UnsafeSave(tx)
	bh.confStateLock.Lock()
	defer bh.confStateLock.Unlock()
	if bh.confStateDirty {
		schema.MustUnsafeSaveConfStateToBackend(bh.lg, tx, bh.confState)
		// save bh.confState
		bh.confStateDirty = false
	}
}
```

**「このトランザクションに、まだ書いていないメタデータを混ぜる」場所** になっている。consistent index と、Raft のメンバー構成 (`ConfState`) の 2 つ。

どちらも「データと一緒でなければ意味がない」種類の情報だ。ConfState がデータより古いと、再起動後のメンバー構成が誤る。

`confStateDirty` のフラグで、変わっていないときは書かないようにしている。**毎回書いてもよさそうなものだが、書き込みバイト数はそのままバッチの重さになる。**

`backend` パッケージ自体は `cindex` も `schema` も知らない。フックのインターフェースは 1 メソッドだけだ ([`server/storage/backend/hooks.go#L17-L24`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/hooks.go#L17-L24))。

```go title="server/storage/backend/hooks.go"
type HookFunc func(tx UnsafeReadWriter)

// Hooks allow to add additional logic executed during transaction lifetime.
type Hooks interface {
	// OnPreCommitUnsafe is executed before Commit of transactions.
	// The given transaction is already locked.
	OnPreCommitUnsafe(tx UnsafeReadWriter)
}
```

**下位層 (backend) が上位層 (etcdserver) の関心を知らないまま、上位層のデータを同じトランザクションに載せられる。** 依存が逆転しないための最小限のフックになっている。

### 「適用中」と「永続化してよい」を分ける

`consistentIndex` の構造体には、似た名前のフィールドが 2 組ある ([`server/etcdserver/cindex/cindex.go#L55-L82`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/cindex/cindex.go#L55-L82))。

```go title="server/etcdserver/cindex/cindex.go"
type consistentIndex struct {
	// consistentIndex represents the offset of an entry in a consistent replica log.
	// It caches the "consistent_index" key's value.
	// Accessed through atomics so must be 64-bit aligned.
	consistentIndex uint64
	// term represents the RAFT term of committed entry in a consistent replica log.
	// Accessed through atomics so must be 64-bit aligned.
	// The value is being persisted in the backend since v3.5.
	term uint64

	// applyingIndex and applyingTerm are just temporary cache of the raftpb.Entry.Index
	// and raftpb.Entry.Term, and they are not ready to be persisted yet. They will be
	// saved to consistentIndex and term above in the txPostLockInsideApplyHook.
```

**`applyingIndex` は「今まさに適用しようとしているエントリ」で、まだ永続化してはいけない値。** `consistentIndex` が「永続化してよい値」。

区別が要る理由は、コミットのタイミングを etcd が完全には制御できないからだ。バッチが上限に達したり、定期コミットのタイマーが発火したりすると、**エントリの適用の途中でコミットが走りうる**。そのときに「適用しようとしている index」を書いてしまうと、まだ完了していない操作を「適用済み」と記録することになる。

昇格が起きる場所は、トランザクションのロックを取った直後だ ([`server/storage/backend/batch_tx.go#L91-L102`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/batch_tx.go#L91-L102))。

```go title="server/storage/backend/batch_tx.go"
func (t *batchTx) LockInsideApply() {
	t.lock()
	if t.backend.txPostLockInsideApplyHook != nil {
		// The callers of some methods (i.e., (*RaftCluster).AddMember)
		// can be coming from both InsideApply and OutsideApply, but the
		// callers from OutsideApply will have a nil txPostLockInsideApplyHook.
		// So we should check the txPostLockInsideApplyHook before validating
		// the callstack.
		ValidateCalledInsideApply(t.backend.lg)
		t.backend.txPostLockInsideApplyHook()
	}
}
```

**「適用の中でトランザクションを取った」瞬間が、`applyingIndex` を `consistentIndex` に昇格させてよい瞬間だ。** そこまで来ていれば、このエントリの書き込みは同じトランザクションに入ることが確定している。

### ロックのメソッド名が、呼び出し文脈を表す

上のコードで目を引くのが、ロックを取るメソッドが 3 つに分かれていることだ。

```go title="server/storage/backend/batch_tx.go"
func (t *batchTx) Lock()             // ユニットテスト専用
func (t *batchTx) LockInsideApply()  // 適用処理の中から
func (t *batchTx) LockOutsideApply() // 適用処理の外から
```

同じミューテックスを取るだけなのに、**呼び出し元の文脈ごとに名前を分けている**。そして、その主張が正しいかを実際に検証する ([`server/storage/backend/verify.go#L31-L70`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/verify.go#L31-L70))。

```go title="server/storage/backend/verify.go"
func ValidateCalledInsideApply(lg *zap.Logger) {
	if !verifyLockEnabled() {
		return
	}
	if !insideApply() {
		lg.Panic("Called outside of APPLY!", zap.Stack("stacktrace"))
	}
}

func insideApply() bool {
	stackTraceStr := string(debug.Stack())
	return strings.Contains(stackTraceStr, ".applyEntries")
}
```

**スタックトレースを文字列にして、関数名が含まれるかを見ている。** 手法としては乱暴だが、目的にはよく合っている。

- 型でこれを表現しようとすると、「適用中であること」を示すトークンをすべての呼び出しに引き回すことになる。適用パスは深くて広いので、現実的でない。
- 環境変数で有効化されるので、**本番のコストはゼロ** (`verifyLockEnabled()` が false なら即 return)。
- テストと開発ビルドでだけ有効にして、規約違反を panic で叩き落とす。

`insideUnittest()` も同じ形で、こちらは `_test.go` を含むかつ `tests/` を含まない、という条件になっている。「ユニットテストからは呼んでよいが、統合テストからは駄目」を表している。

### index が後退することを検出する

永続化する側にも検証がある ([`server/storage/schema/cindex.go#L69-L85`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/cindex.go#L69-L85))。

```go title="server/storage/schema/cindex.go"
func unsafeUpdateConsistentIndex(tx backend.UnsafeReadWriter, index uint64, term uint64, allowDecreasing bool) {
	if index == 0 {
		// Never save 0 as it means that we didn't load the real index yet.
		return
	}
	bs1 := make([]byte, 8)
	binary.BigEndian.PutUint64(bs1, index)

	if !allowDecreasing {
		verify.Verify("update of consistent index not advancing", func() (bool, map[string]any) {
			previousIndex, _ := UnsafeReadConsistentIndex(tx)
			return index >= previousIndex, map[string]any{
				"previousIndex": previousIndex,
				"currentIndex":  index,
			}
		})
	}
```

**`0` を絶対に書かないという規則が、コードとコメントの両方で明示されている。** `0` は「まだ読み込んでいない」を意味する番兵値なので、それを永続化すると「何も適用していない」と誤認され、全ログの再適用が起きる。

そして、**index が後退する更新を検証で捕まえる。** 通常は起こりえないが、起きたら二重適用に直結する。`allowDecreasing` が真になるのは、スナップショットからの復元など、後退が正当な場面だけだ。

### フックが呼ばれない場合の保険

`applyEntryNormal` の先頭に、こういう `defer` がある ([`server/etcdserver/server.go#L1930-L1940`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/server.go#L1930-L1940))。

```go title="server/etcdserver/server.go"
func (s *EtcdServer) applyEntryNormal(e *raftpb.Entry, shouldApplyV3 membership.ShouldApplyV3) {
	if shouldApplyV3 {
		defer func() {
			// The txPostLockInsideApplyHook will not get called in some cases,
			// in which we should move the consistent index forward directly.
			newIndex := s.consistIndex.ConsistentIndex()
			if newIndex < e.GetIndex() {
				s.consistIndex.SetConsistentIndex(e.GetIndex(), e.GetTerm())
			}
		}()
	}
```

**db に触らないエントリ (認証系の一部、no-op、エラーで弾かれたリクエスト) は、トランザクションを取らないのでフックが呼ばれない。** そのままだと index が進まず、次の再起動でそのエントリが再適用されることになる。

`defer` で「もし進んでいなかったら進める」を保証している。**「必ず通る道」と「フックが呼ばれる道」の差分を、defer で埋めている** 形だ。

## なぜそうなっているか

- **進捗をデータと同じトランザクションに入れるのが唯一の正解なのは、2 つの永続化の間にクラッシュを挟めるから。** これは etcd 固有の話ではなく、「チェックポイントを別に持つ」設計すべてに当てはまる。**原子性が要るなら、同じ原子性の単位に入れるしかない。**
- **コミット直前のフックという形にしたのは、レイヤの依存を逆転させないため。** `backend` が「consistent index とは何か」を知る必要はない。1 メソッドのインターフェースを切っておけば、上位層が勝手に混ぜられる。この形なら ConfState のような後から増えた関心も、フックの中身を足すだけで済む。
- **「適用中の index」と「永続化してよい index」を分けるのは、コミットのタイミングを制御しきれないから。** バッチコミットは、書き込み量やタイマーで自発的に走る。**適用の途中で走りうる以上、「今どこまで確定したか」を別の変数で持つしかない。**
- **`0` を書かないという規則が明文化されているのは、番兵値と実データが同じ型だから。** `uint64` の `0` が「未初期化」を意味する設計を選んだ以上、`0` の永続化は禁止するしかない。**番兵値を持つ型は、その値が永続化される経路を必ず塞ぐ。**
- **後退の検出を検証に入れているのは、後退が「静かな」バグだから。** index が後退しても、その瞬間には何も起きない。次の再起動で二重適用が起きて、リビジョンがずれて、数日後に「クラスタが壊れている」として発覚する。**発生時点で叩き落とさないと、原因まで辿り着けない。**
- **ロックのメソッド名を文脈で分けているのは、規約をコードに書き残すため。** 「この関数は適用処理の中から呼ばれる前提です」というコメントは読まれないが、`LockInsideApply` という名前は呼ぶときに必ず目に入る。**そして検証で強制できる。**
- **スタックトレースの文字列検索という手法を選んだのは、型で表現するコストが高すぎるから。** 「適用中であること」を型として引き回すには、適用パス全体の関数シグネチャを変える必要がある。**開発時だけ有効な動的検証のほうが、投資対効果が高い** と判断されている。

## どう活かすか

- **「どこまで処理したか」は、処理結果と同じトランザクションに書く。** 別テーブル・別ファイル・別サービスに持つと、その間のクラッシュで必ず不整合が出る。同じ原子性の単位に入れられないなら、そもそも冪等性を別の方法で確保する必要がある。
- **再開位置の判定は、比較 1 回で済む形にする。** 「どこまで処理したか」が単調増加の数値なら、判定は `id > checkpoint` だけになる。集合や時刻範囲で持つと、判定そのものがバグの温床になる。
- **下位層に「コミット直前フック」を 1 個切っておくと、上位層の関心を原子性に相乗りさせられる。** 依存の向きを保ったまま、上位層のメタデータを同じトランザクションに入れられる。フックの引数はトランザクションそのものにする。
- **「途中経過」と「確定値」を別の変数に分ける。** 永続化のタイミングを自分で制御できないなら、「今書かれても安全な値」だけを永続化対象の変数に置く。昇格の瞬間を 1 箇所に絞れば、そこだけ考えればよくなる。
- **番兵値を持つ型は、その値が保存される経路を塞ぐ。** `0` や空文字が「未設定」を意味する設計は普通だが、それが永続化されると「未設定」として復元される。書き込み側で弾くのが最も確実だ。
- **「起きないはずだが、起きたら致命的」な条件は、開発ビルドで panic させる。** 静かに壊れるバグは、発生時点から発覚まで距離があるほど原因究明が難しくなる。環境変数で切り替えられる検証なら、本番のコストはゼロにできる。
- **呼び出し文脈が重要なメソッドは、文脈ごとに名前を分ける。** `Lock()` を `LockInsideApply()` / `LockOutsideApply()` に分けるだけで、規約が呼び出し側のコードに現れる。型で強制できないなら、名前 + 動的検証という組み合わせが現実的な落としどころになる。
- **「必ず通る道」と「特定条件でしか通らない道」の差分は、defer で埋める。** フックやコールバックが呼ばれない経路は必ず出てくる。関数の入口で `defer` を仕掛けておけば、どの経路を通っても事後条件が満たされる。
