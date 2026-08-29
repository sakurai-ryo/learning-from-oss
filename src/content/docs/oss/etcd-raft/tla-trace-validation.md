---
title: "実行時のトレースを TLA+ の仕様に突き合わせ、実装がモデルから外れたことを検出する"
description: "モデル検査はアルゴリズムの正しさを保証するが、実装がそのアルゴリズムどおりかは別の問題になる。etcd-io/raft は状態遷移点にトレースを埋め込み、実行時に NDJSON で吐き、それを TLA+ の仕様に食わせて「モデルが辿れる遷移か」を検査する。ビルドタグで本番影響をゼロにする作り方と、既知の限界の書き方を読む。"
group: "正しさの担保"
sidebar:
  order: 31
---

## 何を学んだか

**「アルゴリズムが正しい」と「実装がそのアルゴリズムどおり」は別の問題で、両方に手当てが要る。** `etcd-io/raft` の `tla/` ディレクトリには 2 種類の TLA+ 仕様がある。

- `etcdraft.tla`: このライブラリのアルゴリズムのモデル。TLC でモデル検査して、アルゴリズム自体の正しさを確かめる。
- `Traceetcdraft.tla`: **実行時のトレースをモデルに突き合わせる** 仕様。実装が吐いた状態遷移の列を、モデルが辿れるかを検査する。

2 つ目が特徴的だ。モデル検査だけでは「書いた仕様は正しい」しか言えない。実装がその仕様から外れていないことを、実際に動かした記録で確かめる。

## ソースコードのどこか

`tla/README.md` が、この二段構えを明言している。

> The correctness of applications that implements a consensus algorithm is ensured by two factors: the correctness of the algorithm itself, and adherence of the implementation to algorithm specification.
>
> The first factor, the correctness of the algorithm, is assured through model checking the specification. The second one, adherence of the implementation to algorithm specification, is fortified through trace validation, which serves to bridge the gap between the model and its implementation.

**「モデルと実装の間のギャップを埋める」** のがトレース検証の役目になる。

そして、検査が失敗したときの読み方まで書かれている。

> If a trace suggests a state or transition that the state machine can't accommodate, it indicates a discrepancy between the model and its implementation. In cases where the model has already been verified by the TLC model checker, it's more likely that any issues arise from the implementation rather than the model. In other cases where the code change reflects expected refactoring, we need to update the model accordingly and model checking it before validating traces with the new model.

**モデルが検査済みなら、疑うべきは実装**。ただしリファクタリングでモデル側を更新すべき場合もあり、そのときは先にモデル検査をやり直してから、新しいモデルでトレースを検証する。**どちらを直すべきかの判断基準** が書かれている。

## トレース点の埋め込み

トレースは、状態遷移が起きる箇所に埋め込まれている ([`state_trace.go#L28-L50`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/state_trace.go#L28-L50))。

```go title="state_trace.go"
const (
	rsmInitState stateMachineEventType = iota
	rsmBecomeCandidate
	rsmBecomeFollower
	rsmBecomeLeader
	rsmCommit
	rsmReplicate
	rsmChangeConf
	rsmApplyConfChange
	rsmReady
	rsmSendAppendEntriesRequest
	rsmReceiveAppendEntriesRequest
	rsmSendAppendEntriesResponse
	rsmReceiveAppendEntriesResponse
	rsmSendRequestVoteRequest
	rsmReceiveRequestVoteRequest
	rsmSendRequestVoteResponse
	rsmReceiveRequestVoteResponse
	rsmSendSnapshot
	rsmReceiveSnapshot
)
```

**イベント名が TLA+ 仕様のアクション名と対応している**。`BecomeLeader`、`SendAppendEntriesRequest`、`Commit`。モデル側の遷移と 1 対 1 になるように選ばれている。

呼び出し箇所は本体コードに散っている。

```go title="raft.go"
func (r *raft) Step(m *pb.Message) error {
	// ...
	traceReceiveMessage(r, m)
```

```go title="raft.go"
func (r *raft) becomeLeader() {
	// ...
	traceBecomeLeader(r)
```

```go title="raft.go"
func (r *raft) maybeCommit() bool {
	defer traceCommit(r)
```

[「全部を Message にする」ページ](../everything-is-a-message/) で見たとおり、入力の受け口が `Step` 1 つなので、`traceReceiveMessage` も 1 か所で済んでいる。**入口を絞ったことの見返り** がここにも出ている。

送信は `send()` の 2 分岐にそれぞれ入っている。どちらのキューに入れたかによらず、送信として記録される。

## 本番影響をゼロにする

トレースは既定では **完全に消える**。ビルドタグで 2 つのファイルが切り替わる。

```go title="state_trace.go"
//go:build with_tla
```

```go title="state_trace_nop.go"
//go:build !with_tla
```

`state_trace_nop.go` は、同名の関数を全部 **空の関数として定義している** ([`state_trace_nop.go`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/state_trace_nop.go))。

```go title="state_trace_nop.go"
const StateTraceDeployed = false

type TraceLogger any

type TracingEvent struct{}

func traceInitState(*raft) {}

func traceReady(*raft) {}

func traceCommit(*raft) {}

func traceReplicate(*raft, ...*raftpb.Entry) {}

func traceBecomeFollower(*raft) {}
// ... 以下同様
```

引数名すら書かれていない。Go のコンパイラは空の関数呼び出しをインライン展開して消すので、**実行時コストがゼロになる**。

`TraceLogger` が `any` になっているのも巧妙だ。`Config.TraceLogger` フィールドは常に存在するので、利用側のコードはビルドタグに関係なくコンパイルできる。有効なビルドでだけ、インターフェースとして意味を持つ。

```go title="state_trace.go"
type TraceLogger interface {
	TraceEvent(*TracingEvent)
}
```

`StateTraceDeployed` という定数で、有効かどうかを利用側から判別できるようにもなっている。

**「本番に影響を与えずに、必要なときだけ観測できる」** という要件を、ビルドタグと空実装の組み合わせで満たしている。

## トレースの中身

イベント 1 つに、その時点の状態がまるごと入る ([`state_trace.go#L83-L96`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/state_trace.go#L83-L96))。

```go title="state_trace.go"
type TracingEvent struct {
	Name       string             `json:"name"`
	NodeID     string             `json:"nid"`
	State      TracingState       `json:"state"`
	Role       string             `json:"role"`
	LogSize    uint64             `json:"log"`
	Conf       [2][]string        `json:"conf"`
	Message    *TracingMessage    `json:"msg,omitempty"`
	ConfChange *TracingConfChange `json:"cc,omitempty"`
	Properties map[string]any     `json:"prop,omitempty"`
}

type TracingState struct {
	Term   uint64 `json:"term"`
	Vote   string `json:"vote"`
	Commit uint64 `json:"commit"`
}
```

**遷移の種類 (`Name`) と、遷移後の状態が一緒に記録される**。モデル検査側は、この 2 つを突き合わせて「そのアクションでその状態に到達できるか」を検査できる。

`State` は `HardState` そのもの (任期・投票・コミット位置) で、`Conf` は joint の両側だ。ログそのものは記録せず、長さ (`LogSize`) だけ。**モデルが持っている状態変数に対応するものだけを記録している**。

JSON のキーが短い (`nid`、`msg`、`cc`、`prop`)。トレースは大量に出るので、ファイルサイズを抑える意図だろう。実際、リポジトリに入っているサンプル `tla/example.ndjson` は 1.7 MB ある。

`makeTracingMessage` に 1 か所だけ変換がある ([`state_trace.go#L136-L160`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/state_trace.go#L136-L160))。

```go title="state_trace.go"
	if m.GetType() == raftpb.MsgSnap {
		index = 0
		logTerm = 0
		entries = int(m.GetSnapshot().GetMetadata().GetIndex())
	}
```

スナップショットのメッセージでは、フィールドの意味を詰め替えている。モデル側での表現に合わせるための変換になる。**実装の表現とモデルの表現がずれる部分を、トレース生成の側で吸収している**。

## 利用側の実装

トレースの出力先は利用側が決める。`tla/README.md` に例がある。

```go
type MyTraceLogger struct{
  lg *zap.Logger
}

func (t *MyTraceLogger) TraceEvent(ev *TracingEvent) {
  t.lg.Debug("trace", zap.String("tag", "trace"), zap.Any("event", ev))
}
```

注意書きが 2 つ付いている。

> Note that sampling shall be disabled to ensure all traces are logged.

zap のサンプリングを切れ、と。**1 件でも落ちるとトレースが不完全になり、検証が失敗する**。

> **Note:** To preserve the causality of events across nodes, run all application instances on the same machine and store traces in the same file. This approach maintains the order of traces in all instances.

全ノードを同じマシンで動かし、同じファイルに書け。**ノード間の因果順序を保つため**。分散システムのトレースを 1 本の列に並べるには、共通の順序が要る。それを「同じファイルへの追記」という物理的な手段で確保している。ベクタークロックのような仕組みを持ち込まず、検証環境の制約として解いている。

## 検証の実行

2 種類のスクリプトがある。

```console
# モデル自体の検査
./validate-model.sh -s ./MCetcdraft.tla -c ./MCetcdraft.cfg

# トレースの検証
./validate.sh -s ./Traceetcdraft.tla -c ./Traceetcdraft.cfg /path/to/traces/*.ndjson
```

モデル検査については「十分な時間 (自信の度合いによるが、少なくとも数時間) 失敗せずに走ることを確認する」と書かれている。**状態空間が有限でないので、完全な検証ではなく時間による確からしさ** になっている。

トレース検証は並列化される。「既定では全 CPU コアを使う。`-p` で同時実行数を指定できる」。

## 既知の限界が書いてある

README の末尾に `Known Issues` の節がある。

> 1. **Partially persisted log**. etcdraft assumes atomic persisiting of states in Read action. This, however, may not apply in real-world application. For example, etcd may persist a prefix log when it crashes in the middle of saving data to disks. We will introduce non-deterministic validation method in future to address this issue.

**モデルが「状態の永続化は原子的」と仮定しているが、実際にはそうでない**。ディスク書き込みの途中でクラッシュすれば、ログの一部だけが残る。この乖離が未解決であることを明示している。

> 2. **Long validation time**. As aforementioned, trace validation may take long time when there are thousands of traces in a file. It typically takes a few minutes to validate 3000 traces. And the time increases non-linearly after that.

**3000 件で数分、それ以降は非線形に増える**。回避策として、バッチに分けて検証する、QPS を下げてトレース量を減らす、ハートビート間隔を長くする、という具体策が挙げられている。

**手法の適用範囲を数字で示している**。「トレース検証をやっています」だけでは、どこまで信用してよいか分からない。3000 件という規模感があると、「1 時間の実運用トレースを丸ごと検証する」ような使い方が現実的でないことが分かる。

## モデル側にも固有の内容がある

`etcdraft.tla` は 35 KB あり、Raft の標準的なモデルではない。README がそれを明示している。

> A new TLA+ specification models the core algorithm of the library, including the distinctive behaviors like membership reconfiguration, that differentiate it from the classic Raft algorithm.

**このライブラリ固有の振る舞い** — 特に [メンバー変更が適用時に有効になる](../membership-basics/) こと — がモデル化されている。論文の Raft をそのままモデル化しても、この実装の検証にはならない。

実装が論文から意図的に外れている箇所があるなら、モデルもそれに合わせる必要がある。**「仕様」が論文ではなくこの実装のアルゴリズムである**、という位置づけになっている。

## なぜそうなっているか

分散合意の実装のバグは、再現が難しい。特定のタイミングでメッセージが落ちて、特定の順序でクラッシュしたときだけ起きる、という形になる。通常のテストでは踏めない。

[datadriven テスト](../datadriven-tests/) は、想定したシナリオを正確に再現できるが、**想定していないシナリオは踏めない**。モデル検査は網羅的だが、モデルが実装と一致している保証がない。

トレース検証は、その隙間を埋める。実際に動かした記録なので、想定外のシナリオも含まれる。それをモデルに突き合わせるので、実装がモデルから外れたら検出できる。

3 つの手法が、それぞれ別の隙間を埋めている。

| 手法                               | 何を保証するか                       | 何を保証しないか               |
| ---------------------------------- | ------------------------------------ | ------------------------------ |
| datadriven テスト                  | 想定したシナリオでの正確な振る舞い   | 想定外のシナリオ               |
| モデル検査 (`MCetcdraft.tla`)      | アルゴリズム自体の正しさ             | 実装がそのアルゴリズムどおりか |
| トレース検証 (`Traceetcdraft.tla`) | 実装の遷移がモデルの範囲内であること | トレースされていない状態変数   |

## どう活かすか

- **「設計が正しい」と「実装が設計どおり」を分けて手当てする**。片方だけでは足りない。形式手法を使うなら、実装との対応をどう確保するかまで考える。
- **状態遷移点にトレースを埋め、遷移名と遷移後の状態を記録する**。形式検証まで行かなくても、この記録があれば不変条件の事後検査ができる。
- **観測用のコードはビルドタグで切り離し、無効時は空実装にする**。同名の関数を空で定義したファイルを用意すれば、呼び出し側のコードは 1 行も変わらない。コンパイラが消してくれる。
- **記録する状態を、検証したいモデルの状態変数に合わせる**。全部を記録するのではなく、モデルが持っている変数に対応するものだけを記録する。トレースが小さくなり、突き合わせも単純になる。
- **手法の限界を数字で書く**。「3000 件で数分、それ以降は非線形」のような記述があると、その手法をどこまで信用してよいかが判断できる。
- **検証が失敗したときにどちらを直すかの基準を書く**。モデルと実装のどちらが正しいかは自明でない。「モデルが検査済みなら実装を疑え、ただしリファクタリングならモデルを更新して検査し直せ」という手順を残す。
