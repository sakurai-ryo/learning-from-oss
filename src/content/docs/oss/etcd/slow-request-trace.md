---
title: "全リクエストの内訳を計測しておき、遅かったものだけログに出す"
description: "etcd はリクエスト処理の各段階に「ステップ」を記録し、閾値を超えたときだけそれをログに落とす。ステップの閾値を「全体の閾値 ÷ ステップ数」で自動的に決めるので、遅い段階だけが残る。そして、ログに出す値はキーだけで、値はサイズに置き換えられる。"
group: "品質保証"
sidebar:
  order: 18
---

## 何を学んだか

### どんな状況の話か

「etcd が遅い」という報告を受けたとき、知りたいのは **どこで遅いか** だ。

1 回の書き込みは、[前提のページ](../architecture/) で見たとおり多くの段階を通る。認可、Raft の提案、合意、WAL への書き込み、適用、mvcc への書き込み、bbolt へのバッチ書き込み。**どこが遅いかで、対処が全部違う。**

- Raft の合意が遅い → ネットワークか、ピアのディスク。
- WAL の書き込みが遅い → 自分のディスク。
- treeIndex の検索が遅い → キー数が多すぎる。
- bbolt からの読み出しが遅い → 値が大きい、あるいは範囲が広い。

分散トレーシング (OpenTelemetry など) を常時有効にすれば分かるが、**1 秒に数万リクエストが来る系で全部トレースするのは現実的でない**。

かといって、サンプリングすると **遅いリクエストが標本から漏れる**。知りたいのはまさにその外れ値なのに。

### etcd の答え

1. **全リクエストで、各段階の時刻を記録する。** これは軽い (`time.Now()` と append だけ)。
2. **リクエストが終わった時点で、全体の所要時間を見る。**
3. **閾値 (100 ms) を超えていたときだけ、記録したステップをログに出す。**
4. **ステップの表示閾値を「全体の閾値 ÷ ステップ数」で自動的に決める。** 短いステップは表示しない。
5. **ログにはキーだけを出し、値はサイズに置き換える。**

**「全部測って、遅いものだけ出す」。** サンプリングの逆で、外れ値を確実に捕まえる。

## ソースコードのどこか

### トレースの生成

[`pkg/traceutil/trace.go#L101-L113`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/traceutil/trace.go#L101-L113)。

```go title="pkg/traceutil/trace.go"
// EnsureTrace creates a new trace if needed and adds it to the context.
func EnsureTrace(ctx context.Context, lg *zap.Logger, operation string, fields ...Field) (context.Context, *Trace) {
	trace := Get(ctx)
	if trace.IsEmpty() {
		trace = newTrace(operation,
			lg,
			fields...,
		)
		ctx = context.WithValue(ctx, TraceKey{}, trace)
	}
	return ctx, trace
}
```

**context に既にトレースがあれば使い、なければ作る。** 内側の関数が「自分がトレースの起点かどうか」を気にしなくてよい。

トレースが無い場合のために、空のトレースが用意されている ([`#L89-L99`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/traceutil/trace.go#L89-L99))。

```go title="pkg/traceutil/trace.go"
// TODO returns a non-nil, empty Trace
func TODO() *Trace {
	return &Trace{isEmpty: true}
}

func Get(ctx context.Context) *Trace {
	if trace, ok := ctx.Value(TraceKey{}).(*Trace); ok && trace != nil {
		return trace
	}
	return TODO()
}
```

**`nil` を返さず、空のトレースを返す。** 呼び出し側は `if trace != nil` を書かなくてよい。`context.TODO()` の命名を借りているのも分かりやすい。

このパターンは章の他の場所でも出てきた。[線形化可能読み取りのページ](../linearizable-read-batching/) の「閉じたチャネルを返す」も、同じ「呼び出し側の分岐を消す」発想になる。

### ステップの記録

[`#L144-L149`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/traceutil/trace.go#L144-L149)。

```go title="pkg/traceutil/trace.go"
// Step adds step to trace
func (t *Trace) Step(msg string, fields ...Field) {
	if !t.stepDisabled {
		t.steps = append(t.steps, step{time: time.Now(), msg: msg, fields: fields})
	}
}
```

**`time.Now()` と append だけ。** これが全リクエストで実行されても、無視できるコストで済む。

実際の使われ方 (`server/storage/mvcc/kvstore_txn.go` など)。

```go title="server/storage/mvcc/kvstore_txn.go"
	tr.trace.Step("range keys from in-memory index tree")
	// ...
	tr.trace.Step("range keys from bolt db")
```

```go title="server/storage/mvcc/kvstore_txn.go"
		tw.trace.Step("get key's previous created_revision and leaseID")
	// ...
	tw.trace.Step("marshal mvccpb.KeyValue")
	// ...
	tw.trace.Step("store kv pair into bolt db")
```

**メッセージが「何をしたか」の平叙文になっている。** 「treeIndex から範囲を取得」「bbolt から範囲を取得」が分かれているので、[keyIndex のページ](../mvcc-key-index/) で見た 2 段構造のどちらが遅いかが直接読める。

書き込み側も同様で、`marshal` と `store` が分かれている。**「値が大きいので marshal が遅い」と「ディスクが遅い」が区別できる。**

### 閾値を超えたときだけ出す

[`#L176-L189`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/traceutil/trace.go#L176-L189)。

```go title="pkg/traceutil/trace.go"
// LogIfLong dumps logs if the duration is longer than threshold
func (t *Trace) LogIfLong(threshold time.Duration) {
	if time.Since(t.startTime) > threshold {
		stepThreshold := threshold / time.Duration(len(t.steps)+1)
		t.LogWithStepThreshold(stepThreshold)
	}
}

// LogAllStepsIfLong dumps all logs if the duration is longer than threshold
func (t *Trace) LogAllStepsIfLong(threshold time.Duration) {
	if time.Since(t.startTime) > threshold {
		t.LogWithStepThreshold(0)
	}
}
```

**`stepThreshold := threshold / (ステップ数 + 1)` の 1 行が、このパッケージで一番うまい。**

100 ms の閾値で 5 ステップなら、ステップの閾値は約 17 ms。**「平均より遅かったステップだけ」が表示される。**

- ステップが多いリクエストでは、閾値が細かくなる。
- ステップが少ないリクエストでは、閾値が粗くなる。
- **設定項目が増えていない。**

素朴にやるなら「ステップの閾値」を別の設定にするか、全ステップを出すことになる。前者は調整が難しく (何 ms が適切かはリクエストの種類による)、後者はログが膨らむ。

**「全体の予算を、ステップ数で割る」** という考え方で、追加の設定なしに適応的な閾値が得られている。

出力の実装 ([`#L199-L247`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/traceutil/trace.go#L199-L247))。

```go title="pkg/traceutil/trace.go"
	for i := 0; i < len(t.steps); i++ {
		tstep := t.steps[i]
		if tstep.isSubTraceStart || tstep.isSubTraceEnd {
			continue
		}
		stepDuration := tstep.time.Sub(lastStepTime)
		if stepDuration > threshold {
			steps = append(steps, fmt.Sprintf("'%v' %s (duration: %v)",
				tstep.msg, writeFields(tstep.fields), stepDuration))
		}
		lastStepTime = tstep.time
	}
```

**`lastStepTime` の更新が `if` の外にある。** 表示しなかったステップも、次のステップの開始時刻としては使われる。

もし中にあったら、表示されないステップの時間が次のステップに合算されて、**「速いステップの直後のステップが、実際より遅く見える」** ことになる。1 行の位置で結果が変わる箇所だ。

出力のフィールドも実用的だ。

```go title="pkg/traceutil/trace.go"
	fs := []zap.Field{
		zap.Int32("trace_id", traceNum),
		zap.String("operation", t.operation),
		zap.String("detail", writeFields(t.fields)),
		zap.Duration("duration", totalDuration),
		zap.Time("start", t.startTime),
		zap.Time("end", endTime),
		zap.Strings("steps", steps),
		zap.Int("step_count", len(steps)),
	}
```

**`step_count` が別に出ている。** 表示されたステップの数なので、「閾値を超えたステップがいくつあったか」が分かる。1 個だけなら原因が特定できているし、全部なら全体的に遅い。

### サブトレース

[`#L132-L142`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/traceutil/trace.go#L132-L142) と [`#L206-L222`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/traceutil/trace.go#L206-L222)。

```go title="pkg/traceutil/trace.go"
// StartSubTrace adds step to trace as a start sign of sublevel trace
// All steps in the subtrace will log out the input fields of this function
func (t *Trace) StartSubTrace(fields ...Field) {
	t.steps = append(t.steps, step{fields: fields, isSubTraceStart: true})
}
```

**入れ子の構造を、フラットな配列にマーカーを入れることで表している。**

出力時に、マーカーの間にあるステップへ共通のフィールドを配る。

```go title="pkg/traceutil/trace.go"
		if tstep.isSubTraceStart {
			for j := i + 1; j < len(t.steps) && !t.steps[j].isSubTraceEnd; j++ {
				t.steps[j].fields = append(tstep.fields, t.steps[j].fields...)
			}
			continue
		}
```

**木構造を作らずに、フラットな配列と 2 つのフラグで済ませている。** `Txn` の中の各操作にサブトレースを張ると、それぞれの操作の識別情報 (何番目の操作か) が、その中のステップ全部に付く。

記録時ではなく **出力時に配る** のも効いている。ステップを記録する側は、自分がサブトレースの中にいるかを知らなくてよい。

### 関数を丸ごと 1 ステップにする

[`#L151-L157`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/traceutil/trace.go#L151-L157)。

```go title="pkg/traceutil/trace.go"
// StepWithFunction will measure the input function as a single step
func (t *Trace) StepWithFunction(f func(), msg string, fields ...Field) {
	t.disableStep()
	f()
	t.enableStep()
	t.Step(msg, fields...)
}
```

**関数の中のステップ記録を一時的に無効化して、全体を 1 ステップとして記録する。**

呼び出す関数が内部で細かくステップを刻んでいても、呼び出し側から見て「1 つの塊」として扱いたいことがある。**関数側を変えずに、呼び出し側の判断で粒度を変えられる。**

### ログに値を出さない

トレースと対になっているのが「遅いリクエストの警告」だ ([`server/etcdserver/txn/util.go#L29-L38`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/txn/util.go#L29-L38))。

```go title="server/etcdserver/txn/util.go"
func WarnOfExpensiveRequest(lg *zap.Logger, warningApplyDuration time.Duration, now time.Time, reqStringer fmt.Stringer, respMsg proto.Message, err error) {
	if time.Since(now) <= warningApplyDuration {
		return
	}
	var resp string
	if !isNil(respMsg) {
		resp = fmt.Sprintf("size:%d", proto.Size(respMsg))
	}
	warnOfExpensiveGenericRequest(lg, warningApplyDuration, now, reqStringer, "", resp, err)
}
```

**レスポンスは「サイズ」だけをログに出す。** 中身は出さない。

リクエスト側は、専用の型で包む ([`api/etcdserverpb/raft_internal_stringer.go#L158-L179`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/api/etcdserverpb/raft_internal_stringer.go#L158-L179))。

```go title="api/etcdserverpb/raft_internal_stringer.go"
// loggablePutRequest implements proto.Message, a custom proto String to replace value bytes
// field with a value size field.
// To preserve proto encoding of the key bytes, a faked out proto type is used here.
type loggablePutRequest struct {
	Key         []byte `protobuf:"bytes,1,opt,name=key,proto3"`
	ValueSize   int64  `protobuf:"varint,2,opt,name=value_size,proto3"`
	Lease       int64  `protobuf:"varint,3,opt,name=lease,proto3"`
	PrevKv      bool   `protobuf:"varint,4,opt,name=prev_kv,proto3"`
	IgnoreValue bool   `protobuf:"varint,5,opt,name=ignore_value,proto3"`
	IgnoreLease bool   `protobuf:"varint,6,opt,name=ignore_lease,proto3"`
}

func NewLoggablePutRequest(request *PutRequest) proto.Message {
	return &loggablePutRequest{
		request.Key,
		int64(len(request.Value)),
		// ...
	}
}
```

**`Value []byte` が `ValueSize int64` に置き換わった、ログ専用の型。**

Kubernetes の Secret は etcd に平文で入っている (暗号化を有効にしなければ)。**遅いリクエストのログに値をそのまま出すと、Secret がログに流出する。**

一方で **キーは出す**。「どのキーへの操作が遅いか」は診断に必須で、キー自体は秘密ではない (Kubernetes のキーはリソースのパス)。

**「診断に必要な情報」と「出してはいけない情報」を、型のレベルで分けている。** 「ログ出力のときに気をつける」ではなく、**ログ用の型には値のフィールドが存在しない**。

`fmt.Stringer` として渡されるので、**呼び出し側は普通に文字列化するだけ** でよい。安全な形が既定になっている。

コメントの「キーのバイト列の proto エンコードを保つために、偽の proto 型を使っている」も実務的で、既存のログ整形の仕組みをそのまま使うための工夫だと分かる。

### 2 つの仕組みが補い合う

同じ場所で両方が呼ばれている ([`server/etcdserver/v3_server.go#L124-L136`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/v3_server.go#L124-L136))。

```go title="server/etcdserver/v3_server.go"
	defer func(start time.Time) {
		txn.WarnOfExpensiveReadOnlyRangeRequest(s.Logger(), s.Cfg.WarningApplyDuration, start, r, resp, err)
		if resp != nil {
			trace.AddField(
				traceutil.Field{Key: "response_count", Value: len(resp.Kvs)},
				traceutil.Field{Key: "response_revision", Value: resp.Header.Revision},
			)
		}
		trace.LogIfLong(traceThreshold)
		// ...
	}(time.Now())
```

- **`WarnOfExpensiveRequest`**: 「このリクエストが遅かった」を `Warn` で出す。**運用者が最初に見る。**
- **`trace.LogIfLong`**: 「その内訳」を `Info` で出す。**原因を追うときに見る。**

**レベルが違うのが正しい。** 警告は「異常があった」の通知で、トレースは「詳細」だ。ログレベルでフィルタしている環境でも、警告だけは届く。

`defer` の中でレスポンスの情報をトレースに足しているのも重要で、**「何件返したか」は処理が終わらないと分からない**。ステップとしてではなく、トレース全体のフィールドとして付ける。

そして、両方に **メトリクスが対応している** (`etcd_server_slow_apply_total`)。ログは詳細を、メトリクスは頻度を担当する。

## なぜそうなっているか

- **全部測って遅いものだけ出すのは、知りたいのが外れ値だから。** サンプリングは「典型的な振る舞い」を知るには適しているが、「たまに 5 秒かかる」を捕まえられない。**測定が十分に軽ければ、全件測って出力を絞るほうが確実。**
- **測定を軽くできるのは、記録がメモリへの append だけだから。** 出力の整形も、閾値の判定も、リクエストが終わってから行う。**「測る」と「出す」のコストを分けたことが、全件測定を可能にしている。**
- **ステップの閾値を全体の閾値から導出するのは、設定を増やしたくないから。** リクエストの種類ごとに適切なステップ閾値は違う。**「全体の予算をステップ数で割る」なら、種類ごとに自動的に調整される。**
- **表示しないステップも時刻を更新するのは、次のステップの時間を歪めないため。** 累積時間ではなく各ステップの所要時間を出しているので、飛ばしたステップの時間が次に合算されると誤解を生む。
- **サブトレースをフラットな配列とマーカーで表すのは、木構造の管理コストを避けるため。** ステップを記録する側は入れ子を意識しなくてよく、出力時に 1 回だけ解決すればよい。
- **`nil` ではなく空のトレースを返すのは、呼び出し側の分岐を消すため。** トレースが無い経路 (内部処理、テスト) でも同じコードが書ける。**「何もしないオブジェクト」を返す形は、境界の多いコードで効く。**
- **ログ用の型から値のフィールドを消したのは、規律に頼らないため。** 「ログに値を出さないように気をつける」は、いつか誰かが破る。**型に存在しなければ、出せない。**
- **キーは出して値は出さないのは、診断価値と秘匿性が違うから。** キーは「どのリソースか」を示すだけで、値は中身そのものになる。**一律に隠すと診断できず、一律に出すと漏れる。** 分けるしかない。
- **警告とトレースをログレベルで分けたのは、読む人と場面が違うから。** 「遅い」は運用者が常時見るべき情報で、「内訳」は調査時に見る情報だ。同じレベルで出すと、どちらかがノイズになる。

## どう活かすか

- **測定を十分に軽くして、全件測り、出力だけ絞る。** サンプリングは外れ値を取り逃がす。時刻の記録と append だけなら、ホットパスでも許容できる。**「測る」と「整形して出す」を分けることが前提になる。**
- **段階ごとの計測点は、原因の切り分け単位で置く。** 「メモリの索引を引いた」「ディスクから読んだ」「シリアライズした」。**対処が変わる境界に計測点を置くと、ログを見た瞬間に次の行動が決まる。**
- **詳細を出す閾値は、全体の閾値から導出する。** 「全体の予算 ÷ 段階数」なら、設定を増やさずに適応的な閾値になる。段階が多い処理では細かく、少ない処理では粗くなる。
- **表示を絞るときも、時間の起点は全件で更新する。** 表示されなかった項目の時間が隣に合算されると、誤った箇所を疑うことになる。
- **入れ子の構造は、フラットな配列 + マーカーで表せることが多い。** 記録側が階層を意識しなくてよくなり、解決は出力時の 1 パスで済む。
- **「何もしないオブジェクト」を返して、`nil` チェックを消す。** トレース、ロガー、メトリクス。呼び出し側に `if != nil` を書かせる設計は、必ずどこかで忘れられる。
- **ログに出してはいけないデータは、ログ用の型から消す。** 「気をつける」ではなく「出せない」形にする。`String()` や `MarshalJSON()` を差し替えるだけでも、既定が安全になる。
- **秘匿と診断のバランスは、フィールド単位で決める。** 識別子は出す、中身は出さない、サイズは出す。一律のマスクは診断能力を奪い、一律の出力は事故になる。
- **「異常の通知」と「詳細な内訳」は、別のログレベルで出す。** 前者は常時監視の対象、後者は調査のための資料。混ぜると、どちらかが埋もれる。そして、頻度はメトリクスに任せる。
