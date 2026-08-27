---
title: "横断的な関心をデコレータの連鎖で重ね、異常状態は分岐ではなく実装の差し替えで表す"
description: "etcd の適用層は、認可・容量制限・破損時の拒否といった関心をデコレータとして積み重ねる。アラームが立つと、連鎖そのものが組み直されて「常にエラーを返す実装」が最前段に入る。連鎖を 2 回下る (共通処理で 1 回、メソッド固有の処理でもう 1 回) という珍しい形が、この構成を可能にしている。"
group: "クラスタ運用と防御"
sidebar:
  order: 15
---

## 何を学んだか

### どんな状況の話か

Raft でコミットされたリクエストを状態に反映するのが適用層だ ([前提のページ](../architecture/))。ここには、KV の書き込みそのものとは別に、いくつもの横断的な関心が乗ってくる。

- **認可**: このユーザーはこのキーを書いてよいか。
- **容量制限**: db がクォータを超えていないか。
- **容量超過アラーム時の拒否**: すでに NOSPACE アラームが立っているなら、書き込みを全部拒否する。
- **破損アラーム時の拒否**: [整合性検査](../corruption-check/) が不整合を検出したら、読み書きすべてを拒否する。
- **計測とログ**: 遅いリクエストの警告、メトリクス。

素朴に書くと、こうなる。

```go
func (s *server) applyPut(r *PutRequest) (*PutResponse, error) {
    if s.corruptAlarm { return nil, ErrCorrupt }
    if s.noSpaceAlarm { return nil, ErrNoSpace }
    if err := s.checkAuth(r); err != nil { return nil, err }
    if !s.quota.Available(r) { /* ... */ }
    return s.kv.Put(r)
}
```

これを **20 種類以上のリクエスト全部に書く** ことになる。1 箇所忘れると、そこだけ認可が効かない。

### etcd の答え

**デコレータの連鎖にする。**

```
CorruptApplier → CappedApplier → AuthApplier → QuotaApplier → BackendApplier
```

1. **`applierV3` は 30 個以上のメソッドを持つ 1 つのインターフェース。**
2. **各デコレータは、`applierV3` を埋め込んで、関心のあるメソッドだけをオーバーライドする。**
3. **アラームの状態が変わったら、連鎖そのものを組み直す。** `if` は増えない。
4. **連鎖を 2 回下る。** 1 回目は全リクエスト共通の処理、2 回目はメソッドごとの処理。

## ソースコードのどこか

### 巨大なインターフェース

[`server/etcdserver/apply/interface.go#L44-L80`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/interface.go#L44-L80)。

```go title="server/etcdserver/apply/interface.go"
// applierV3 is the interface for processing V3 raft messages
type applierV3 interface {
	// Apply executes the generic portion of application logic for the current applier, but
	// delegates the actual execution to the applyFunc method.
	Apply(r *InternalRaftRequestWrapper, shouldApplyV3 membership.ShouldApplyV3, applyFunc applyFunc) *Result

	Put(p *pb.PutRequest) (*pb.PutResponse, *traceutil.Trace, error)
	Range(r *pb.RangeRequest) (*pb.RangeResponse, *traceutil.Trace, error)
	DeleteRange(dr *pb.DeleteRangeRequest) (*pb.DeleteRangeResponse, *traceutil.Trace, error)
	Txn(rt *pb.TxnRequest, skipRangeExecution bool) (*pb.TxnResponse, *traceutil.Trace, error)
	Compaction(compaction *pb.CompactionRequest) (*pb.CompactionResponse, <-chan struct{}, *traceutil.Trace, error)
	// ...
	UserAdd(ua *pb.AuthUserAddRequest) (*pb.AuthUserAddResponse, error)
	// ...
```

**「小さなインターフェースが良い」という Go の一般則の逆を行っている。**

理由は用途にある。このインターフェースは **抽象化のためではなく、デコレータのためにある**。デコレータは「関心のあるメソッドだけ差し替えて、残りは透過的に委譲する」必要があるので、**全メソッドが 1 つのインターフェースに揃っていないと成立しない**。

Go の構造体埋め込みが、これを可能にしている。

```go
type applierV3Capped struct {
	applierV3          // ← 埋め込み
	q serverstorage.BackendQuota
}
```

**埋め込まれた `applierV3` が、オーバーライドしていないメソッドを全部提供する。** 30 個のメソッドのうち 3 個だけ書けばよい。

### デコレータは 3 行から 20 行

容量超過時 ([`server/etcdserver/apply/capped.go#L24-L46`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/capped.go#L24-L46))。

```go title="server/etcdserver/apply/capped.go"
type applierV3Capped struct {
	applierV3
	q serverstorage.BackendQuota
}

// newApplierV3Capped creates an applyV3 that will reject Puts and transactions
// with Puts so that the number of keys in the store is capped.
func newApplierV3Capped(base applierV3) applierV3 { return &applierV3Capped{applierV3: base} }

func (a *applierV3Capped) Put(_ *pb.PutRequest) (*pb.PutResponse, *traceutil.Trace, error) {
	return nil, nil, errors.ErrNoSpace
}

func (a *applierV3Capped) Txn(r *pb.TxnRequest, skipRangeExecution bool) (*pb.TxnResponse, *traceutil.Trace, error) {
	if a.q.Cost(r) > 0 {
		return nil, nil, errors.ErrNoSpace
	}
	return a.applierV3.Txn(r, skipRangeExecution)
}

func (a *applierV3Capped) LeaseGrant(_ *pb.LeaseGrantRequest) (*pb.LeaseGrantResponse, error) {
	return nil, errors.ErrNoSpace
}
```

**「容量が尽きたときの振る舞い」が、この 20 行に全部書いてある。**

- `Put` と `LeaseGrant` は無条件に拒否。
- **`Txn` は、コストが 0 より大きいときだけ拒否。** 読み取りだけの `Txn` は通る。
- **`Range` や `DeleteRange` はオーバーライドしていない。** 容量が尽きているときに、読み取りと削除は許すべきだからだ。むしろ **削除が通らないと、容量を回復する手段がなくなる**。

**「何をオーバーライドしないか」が、そのまま設計の意思表示になっている。**

破損時 ([`server/etcdserver/apply/corrupt.go#L23-L47`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/corrupt.go#L23-L47))。

```go title="server/etcdserver/apply/corrupt.go"
type applierV3Corrupt struct {
	applierV3
}

func (a *applierV3Corrupt) Put(_ *pb.PutRequest) (*pb.PutResponse, *traceutil.Trace, error) {
	return nil, nil, errors.ErrCorrupt
}

func (a *applierV3Corrupt) Range(_ *pb.RangeRequest) (*pb.RangeResponse, *traceutil.Trace, error) {
	return nil, nil, errors.ErrCorrupt
}
```

**こちらは `Range` もオーバーライドしている。** 破損しているなら、読み取りの結果も信用できない。

**2 つのデコレータを並べると、「容量超過」と「破損」の違いが一目で分かる。** どちらも「異常状態」だが、許すべきことが違う。条件分岐で書くと、この対比は見えない。

容量の判定 ([`server/etcdserver/apply/quota.go#L27-L45`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/quota.go#L27-L45))。

```go title="server/etcdserver/apply/quota.go"
func (a *quotaApplierV3) Put(p *pb.PutRequest) (*pb.PutResponse, *traceutil.Trace, error) {
	ok := a.q.Available(p)
	resp, trace, err := a.applierV3.Put(p)
	if err == nil && !ok {
		err = errors.ErrNoSpace
	}
	return resp, trace, err
}
```

**判定を先にして、書き込みを実行してから、エラーを付ける。**

「容量が足りないなら書かない」ではなく **「書いた上でエラーを返す」**。奇妙に見えるが、これは適用層の性質から来ている。

**適用は全ノードで同じ結果にならなければならない。** ここで「書かない」を選ぶと、判定がノードごとにわずかに違った場合 (db のサイズは完全には一致しない) に、**あるノードでは書かれ、あるノードでは書かれない** という致命的な不整合が起きる。

だから **状態変更は必ず実行し、エラーはクライアントへの応答としてだけ返す**。応答は提案したノードでしか返らないので、ノード間の一貫性に影響しない。これが最初の 1 回で、その後は [提案 ID のページ](../proposal-wait/) で見たとおりアラームが立ち、`applierV3Capped` が本当に拒否するようになる。

### 認可のデコレータだけは状態を持つ

[`server/etcdserver/apply/auth.go#L43-L63`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/auth.go#L43-L63)。

```go title="server/etcdserver/apply/auth.go"
	// mu serializes Apply so that user isn't corrupted and so that
	// serialized requests don't leak data from TOCTOU errors
	mu sync.Mutex

	authInfo auth.AuthInfo
}

func (aa *authApplierV3) Apply(r *InternalRaftRequestWrapper, shouldApplyV3 membership.ShouldApplyV3, applyFunc applyFunc) *Result {
	aa.mu.Lock()
	defer aa.mu.Unlock()
	if r.Header != nil {
		// backward-compatible with pre-3.0 releases when internalRaftRequest
		// does not have header field
		aa.authInfo.Username = r.Header.Username
		aa.authInfo.Revision = r.Header.AuthRevision
	}
	if needAdminPermission(r.InternalRaftRequest) {
		if err := aa.as.IsAdminPermitted(&aa.authInfo); err != nil {
			aa.authInfo.Username = ""
			aa.authInfo.Revision = 0
			return &Result{Err: err}
		}
	}
	ret := aa.applierV3.Apply(r, shouldApplyV3, applyFunc)
	aa.authInfo.Username = ""
	aa.authInfo.Revision = 0
	return ret
}
```

**`authInfo` をデコレータのフィールドに置いて、ミューテックスで守っている。**

デコレータのメソッド (`Put`、`Range`、...) は引数に認可情報を受け取らないので、**リクエストのヘッダから読んだ認可情報を、どこかに置いて次のメソッドから見えるようにする必要がある。**

その「どこか」が構造体のフィールドで、`Apply` の間だけ有効になる。**入り口でセットして、出口でクリアする。** エラーの経路でもクリアしている。

コメントが 2 つの理由を挙げている。「ユーザー情報が壊れないように」と「直列化されたリクエストが TOCTOU エラーでデータを漏らさないように」。**認可情報の設定と使用の間に別のリクエストが割り込むと、別のユーザーの権限で実行されてしまう。**

適用層はもともと 1 本の goroutine で直列に動くので、実際には競合しないはずだ。それでも **ロックを置いているのは、この不変条件が破れたときの被害が大きすぎるから** だろう。

各メソッドは、権限チェックしてから委譲する ([`#L65-L94`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/auth.go#L65-L94))。

```go title="server/etcdserver/apply/auth.go"
func checkPutAuth(as auth.AuthStore, ai *auth.AuthInfo, lessor lease.Lessor, r *pb.PutRequest) error {
	if err := as.IsPutPermitted(ai, r.Key); err != nil {
		return err
	}

	if err := checkLeasePuts(as, ai, lessor, lease.LeaseID(r.Lease)); err != nil {
		// The specified lease is already attached with a key that cannot
		// be written by this user. It means the user cannot revoke the
		// lease so attaching the lease to the newly written key should
		// be forbidden.
		return err
	}

	if r.PrevKv {
		err := as.IsRangePermitted(ai, r.Key, nil)
		if err != nil {
			return err
		}
	}

	return nil
}
```

**3 種類のチェックが入っている。** 特に後ろの 2 つが面白い。

- **lease のチェック**: 書こうとしているキーに lease を付ける場合、**その lease に既に「このユーザーが書けないキー」が付いていたら拒否する**。理由がコメントに書いてある。lease を revoke するとそのキーも消えるので、**「書けないキーを、lease 経由で消せてしまう」** 権限昇格になる。
- **`PrevKv` のチェック**: `Put` に `PrevKv` を付けると、変更前の値が返る。**つまり読み取りになる。** だから読み取り権限も要る。

**「この操作は何を読み、何を書くか」を、オプションまで含めて洗い出している。** 認可の抜け穴は、たいていこういう「副次的な効果」から生まれる。

### 連鎖を 2 回下る

[`server/etcdserver/apply/uber_applier.go#L82-L91`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/uber_applier.go#L82-L91)。

```go title="server/etcdserver/apply/uber_applier.go"
func (a *uberApplier) Apply(r *InternalRaftRequestWrapper, shouldApplyV3 membership.ShouldApplyV3) *Result {
	// We first execute chain of Apply() calls down the hierarchy:
	// (i.e. CorruptApplier -> CappedApplier -> Auth -> Quota -> Backend),
	// then dispatch() unpacks the request to a specific method (like Put),
	// that gets executed down the hierarchy again:
	// i.e. CorruptApplier.Put(CappedApplier.Put(...(BackendApplier.Put(...)))).
	return a.applyV3.Apply(r, shouldApplyV3, a.dispatch)
}
```

**このコメントがこのページの主題そのものだ。**

- **1 回目の下り (`Apply`)**: リクエストの種類に依らない処理。認可情報のセット、管理者権限のチェック。
- **一番下で `applyFunc` (= `dispatch`) が呼ばれる** ([`server/etcdserver/apply/backend.go#L46-L48`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/backend.go#L46-L48))。

```go title="server/etcdserver/apply/backend.go"
func (a *applierV3backend) Apply(r *InternalRaftRequestWrapper, shouldApplyV3 membership.ShouldApplyV3, applyFunc applyFunc) *Result {
	return applyFunc(r, shouldApplyV3)
}
```

- **`dispatch` が、リクエストの中身を見て具体的なメソッドを呼ぶ。** 巨大な `switch` になっている ([`#L93-L200`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/uber_applier.go#L93-L200))。
- **2 回目の下り**: `a.applyV3.Put(...)` が、また連鎖の一番上から呼ばれる。

**なぜ 2 回下るのか。**

1 回で済ませようとすると、**各デコレータが `switch` を持つ** ことになる。`applierV3Capped` の中で「リクエストが Put なら拒否、Txn ならコストを見る」を判定する。デコレータが増えるたびに `switch` が増え、**リクエストの種類を増やすたびに全デコレータの `switch` を直す** ことになる。

2 回に分けると、

- **共通の前処理は `Apply` に書ける。** リクエストの種類を知らなくてよい。
- **種類ごとの処理は、型付きのメソッドとして書ける。** `switch` は `dispatch` の 1 箇所だけ。
- **オーバーライドしていないメソッドは、埋め込みで自動的に通過する。**

**「共通処理」と「種類ごとの処理」を、連鎖の 2 回の走査に分けた** というのが、この設計の核心になる。

### アラームで連鎖を組み直す

[`#L61-L88`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/uber_applier.go#L61-L88)。

```go title="server/etcdserver/apply/uber_applier.go"
func newApplierV3(opts ApplierOptions) applierV3 {
	applierBackend := newApplierV3Backend(opts)
	return newAuthApplierV3(
		opts.AuthStore,
		newQuotaApplierV3(opts.Logger, opts.QuotaBackendBytesCfg, opts.Backend, applierBackend),
		opts.Lessor,
	)
}

func (a *uberApplier) restoreAlarms() {
	noSpaceAlarms := len(a.alarmStore.Get(pb.AlarmType_NOSPACE)) > 0
	corruptAlarms := len(a.alarmStore.Get(pb.AlarmType_CORRUPT)) > 0
	a.applyV3 = a.applyV3base
	if noSpaceAlarms {
		a.applyV3 = newApplierV3Capped(a.applyV3)
	}
	if corruptAlarms {
		a.applyV3 = newApplierV3Corrupt(a.applyV3)
	}
}
```

**基本の連鎖 (`applyV3base`) は不変で、アラームに応じて上に被せる。**

- アラームなし → `Auth → Quota → Backend`
- NOSPACE のみ → `Capped → Auth → Quota → Backend`
- 両方 → `Corrupt → Capped → Auth → Quota → Backend`

**`if a.corruptAlarm` のような分岐が、適用パスのどこにもない。** 状態が構造として表現されている。

そして、アラームが変わる瞬間に組み直す ([`#L214-L222`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/uber_applier.go#L214-L222))。

```go title="server/etcdserver/apply/uber_applier.go"
func (a *uberApplier) Alarm(ar *pb.AlarmRequest) (*pb.AlarmResponse, error) {
	resp, err := a.applyV3.Alarm(ar)

	if ar.Action == pb.AlarmRequest_ACTIVATE ||
		ar.Action == pb.AlarmRequest_DEACTIVATE {
		a.restoreAlarms()
	}
	return resp, err
}
```

**アラームの設定・解除も、Raft の合意ログを通るリクエストだ** ([整合性検査のページ](../corruption-check/))。だから、それを適用した瞬間に連鎖を組み直せばよい。

**全ノードが、同じログの同じ位置で、同じ連鎖に切り替わる。** 「アラームが立ったことを各ノードにどう伝えるか」という問題が、合意ログに乗せることで消えている。

`Alarm` だけが `a.applyV3.Alarm` ではなく `a.Alarm` として `dispatch` から呼ばれているのも、そのためだ。

```go title="server/etcdserver/apply/uber_applier.go"
	case r.Alarm != nil:
		op = "Alarm"
		ar.Resp, ar.Err = a.Alarm(r.Alarm)
```

**アラームの適用だけは、連鎖の外側 (uberApplier) が処理を挟む必要がある。** 連鎖を組み直すのは連鎖の外側の仕事だからだ。

### 計測は dispatch にまとめる

```go title="server/etcdserver/apply/uber_applier.go"
	defer func(start time.Time) {
		success := ar.Err == nil || errors.Is(ar.Err, mvcc.ErrCompacted)
		txn.ApplySecObserve("v3", op, success, time.Since(start))
		txn.WarnOfExpensiveRequest(a.lg, a.warningApplyDuration, start, &pb.InternalRaftStringer{Request: r.InternalRaftRequest}, ar.Resp, ar.Err)
		if !success {
			txn.WarnOfFailedRequest(a.lg, start, &pb.InternalRaftStringer{Request: r.InternalRaftRequest}, ar.Resp, ar.Err)
		}
	}(time.Now())
```

**メトリクスと遅延警告は、デコレータではなく `dispatch` の `defer` に置かれている。**

デコレータにしなかったのは、**`op` (操作の名前) が必要だから** だろう。`dispatch` の中でしか「これは Put だ」と分からない。連鎖の上のほうでは、リクエストの種類が確定していない。

`success` の定義も実務的で、**`ErrCompacted` は成功として数えている。** 圧縮済みリビジョンへの読み取りは正常な動作なので、失敗率のメトリクスを汚さない。

## なぜそうなっているか

- **デコレータの連鎖にしたのは、横断的な関心を 1 箇所に書くため。** 20 種類のリクエストすべてに `if` を書くと、追加のたびに漏れる。**デコレータなら、関心のあるメソッドだけを書けばよく、書き忘れたメソッドは素通しになる。**
- **インターフェースを巨大にしたのは、デコレータが全メソッドを委譲する必要があるから。** 「小さなインターフェース」の原則は、抽象化のための話だ。**デコレータのためのインターフェースは、包む対象の全メソッドを持たなければならない。** 用途が違えば原則も違う。
- **連鎖を 2 回下るのは、共通処理と種類別処理を分けるため。** 1 回だと各デコレータが `switch` を持つことになる。2 回に分ければ、`switch` は 1 箇所で済み、種類別の処理は型付きのメソッドとして書ける。
- **アラームで連鎖を組み直すのは、状態を構造で表すため。** `if corrupted` を全メソッドに書くと、新しいメソッドを追加したときに漏れる。**連鎖の組み直しなら、「常にエラーを返す実装」を 1 個書くだけで、そのメソッドが確実に塞がる。**
- **アラームの変更が合意ログを通るのは、全ノードが同じ状態になる必要があるから。** ローカルのフラグだと、伝播の順序やタイミングがノードごとに違う。**ログに乗せれば、全ノードが同じ位置で切り替わる。**
- **クォータ超過で「書いてからエラーを返す」のは、適用の決定性を守るため。** 判定結果がノードごとに違うと、状態が分岐する。**状態変更は無条件に実行し、エラーは応答としてだけ返す。** これは適用層すべてに共通する規律だ。
- **`Capped` が `DeleteRange` をオーバーライドしないのは、回復手段を残すため。** 容量が尽きたときに削除まで拒否すると、そこから抜け出せない。**「異常時に何を許すか」の設計が、オーバーライドしないメソッドの一覧として現れている。**
- **認可情報を構造体のフィールドに置いたのは、メソッドの引数にできないから。** インターフェースのシグネチャは全デコレータで共通なので、認可情報を引数に足すと全メソッドが変わる。**「Apply の間だけ有効なフィールド」という妥協が、入口でのセットと出口でのクリアで守られている。**
- **lease や `PrevKv` の権限も見るのは、副次的な効果が権限昇格になるから。** 「Put の権限しかないユーザーが、lease 経由で他のキーを消せる」「Put の権限で他のキーの値を読める」。**操作の主目的だけを見た認可は、必ず抜け穴を作る。**

## どう活かすか

- **横断的な関心は、デコレータの連鎖で表す。** 認可、レート制限、計測、キャッシュ、リトライ。**「関心のあるメソッドだけ書けば、残りは素通し」という性質が、書き忘れによる穴を防ぐ。**
- **デコレータのためのインターフェースは、大きくてよい。** 「小さなインターフェース」は抽象化の原則であって、デコレータには当てはまらない。委譲対象の全メソッドが揃っていないと、包めない。
- **共通処理と種類別処理を、連鎖の 2 回の走査に分ける。** 1 回で済ませようとすると、各層が種類の判定を持つ。分ければ、判定は 1 箇所、種類別の処理は型付きのメソッドになる。
- **異常状態は、条件分岐ではなく実装の差し替えで表す。** 「常にエラーを返す実装」を 1 個用意して、連鎖の最前段に差し込む。新しいメソッドを追加しても、そこに書き忘れることがない。
- **「何をオーバーライドしないか」を意識的に決める。** 異常時に許すべき操作 (回復手段、読み取り、状態の確認) を明確にすると、そのまま実装の形になる。**容量が尽きたときに削除まで止めると、回復できなくなる。**
- **状態の切り替えを、状態変更のイベント自体で駆動する。** アラームの適用と連鎖の組み直しが同じ場所にあれば、ずれようがない。状態変更が複製されるなら、切り替えも自動的に複製される。
- **複製された処理では、判定結果が分岐しうる操作で状態を変えない。** 「容量が足りないから書かない」はノードごとに違う結果になりうる。**状態変更は無条件に、エラーは呼び出し元への応答としてだけ返す。**
- **認可は、操作の副次的な効果まで洗い出す。** 「変更前の値を返すオプション」は読み取りだし、「オブジェクトへの紐付け」は間接的な削除権限になりうる。**主目的だけを見た認可は、必ず抜け穴を残す。** そして、なぜそのチェックが要るかをコメントに書く。
- **計測は、種類が確定する場所に置く。** メトリクスのラベルに操作名が要るなら、操作名が分かる層に置くしかない。`defer` にまとめれば、すべての戻り経路で確実に記録される。
