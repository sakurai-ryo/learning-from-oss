---
title: "選挙タイムアウトを乱数でずらし、時間の単位を実時間ではなく tick にする"
description: "分割投票を確率で解くランダム化選挙タイムアウトと、時間を抽象的な tick として扱う設計。時計を読まないことで負荷時の挙動まで決定的になり、乱数はテストからだけ差し替え可能になる。その差し替え口をテスト専用コードへの依存なしに通すやり方も含めて読む。"
group: "選挙の工夫"
sidebar:
  order: 17
---

## 何を学んだか

**時間を扱わない。回数を数える。** `etcd-io/raft` は時計を一度も読まない。利用側が `Tick()` を呼んだ回数だけを数え、選挙タイムアウトもハートビート間隔も「何 tick か」で表す。

これにより、負荷でスケジューリングが遅れたときの挙動まで決定的になる。時計を読む実装なら「気づいたら 3 秒経っていた」となるところが、「tick が 3 個溜まっている」になり、3 回ぶんの処理が順に実行される。

そのうえで、**唯一の非決定性である選挙タイムアウトの乱数** を、テストから差し替えられるようにしてある。

## ソースコードのどこか

設定は「回数」で表される ([`raft.go#L129-L140`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L129-L140))。

```go title="raft.go"
	// ElectionTick is the number of Node.Tick invocations that must pass between
	// elections. That is, if a follower does not receive any message from the
	// leader of current term before ElectionTick has elapsed, it will become
	// candidate and start an election. ElectionTick must be greater than
	// HeartbeatTick. We suggest ElectionTick = 10 * HeartbeatTick to avoid
	// unnecessary leader switching.
	ElectionTick int
	// HeartbeatTick is the number of Node.Tick invocations that must pass between
	// heartbeats. That is, a leader sends heartbeat messages to maintain its
	// leadership every HeartbeatTick ticks.
	HeartbeatTick int
```

「`Node.Tick` の呼び出し回数」と定義されている。秒でもミリ秒でもない。**1 tick が何ミリ秒かはライブラリの関心事ではない**。

`doc.go` も同じことを言う。

> Finally, you need to call Node.Tick() at regular intervals (probably via a time.Ticker). Raft has two important timeouts: heartbeat and the election timeout. However, internally to the raft package time is represented by an abstract "tick".

大小関係は起動時に検査される ([`raft.go#L300-L306`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L300-L306))。

```go title="raft.go"
	if c.HeartbeatTick <= 0 {
		return errors.New("heartbeat tick must be greater than 0")
	}

	if c.ElectionTick <= c.HeartbeatTick {
		return errors.New("election tick must be greater than heartbeat tick")
	}
```

逆転していると、ハートビートが届く前に選挙が始まってリーダーが安定しない。設定ミスを起動時に落とす。

推奨比率 10:1 の根拠もコメントにある。「不要なリーダー交代を避けるため」。ハートビートが 10 回連続で落ちて初めて選挙になる、という余裕を持たせている。

## ランダム化

実際に使われるタイムアウトは、設定値そのものではない ([`raft.go#L2049-L2055`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L2049-L2055))。

```go title="raft.go"
// pastElectionTimeout returns true if r.electionElapsed is greater
// than or equal to the randomized election timeout in
// [electiontimeout, 2 * electiontimeout - 1].
func (r *raft) pastElectionTimeout() bool {
	return r.electionElapsed >= r.randomizedElectionTimeout
}

func (r *raft) resetRandomizedElectionTimeout() {
	r.randomizedElectionTimeout = r.electionTimeout + globalRand.Intn(r.electionTimeout)
}
```

`[T, 2T)` の一様乱数になる。この再抽選は `reset()` の中で行われるので、**役割が変わるたびに新しい値になる** ([`raft.go#L787`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L787))。

```go title="raft.go"
	r.electionElapsed = 0
	r.heartbeatElapsed = 0
	r.resetRandomizedElectionTimeout()
```

分割投票が起きて選挙をやり直すとき、各ノードは前回と違う値を引く。何度も衝突する確率は指数的に下がるので、確率 1 で決着する。

### 乱数源が crypto/rand

意外なのが乱数の実装だ ([`raft.go#L90-L104`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L90-L104))。

```go title="raft.go"
// lockedRand is a small wrapper around rand.Rand to provide
// synchronization among multiple raft groups. Only the methods needed
// by the code are exposed (e.g. Intn).
type lockedRand struct {
	mu sync.Mutex
}

func (r *lockedRand) Intn(n int) int {
	r.mu.Lock()
	v, _ := rand.Int(rand.Reader, big.NewInt(int64(n)))
	r.mu.Unlock()
	return int(v.Int64())
}

var globalRand = &lockedRand{}
```

`crypto/rand` を使っている。選挙タイムアウトに暗号学的な乱数は要らないはずだが、`math/rand` のグローバル状態を避けたかったのだろう。型名とコメントに `rand.Rand` の名残があるので、途中で差し替えられている。

グローバル変数なのは、**1 プロセスに多数の Raft グループが載る** ことを想定しているからだ。グループごとに乱数生成器を持つとメモリを食う。ミューテックスで共有する代わりに、状態を 1 つにしている。

### テストから差し替える

乱数はこのライブラリで唯一の非決定性なので、テストからは固定したい。そのための口が用意されている ([`raft_test.go#L4197-L4208`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft_test.go#L4197-L4208))。

```go title="raft_test.go"
// setRandomizedElectionTimeout set up the value by caller instead of choosing
// by system, in some test scenario we need to fill in some expected value to
// ensure the certainty
func setRandomizedElectionTimeout(r *raft, v int) {
	r.randomizedElectionTimeout = v
}

// SetRandomizedElectionTimeout is like setRandomizedElectionTimeout, but
// exported for use by tests that are not in the raft package, using RawNode.
func SetRandomizedElectionTimeout(r *RawNode, v int) {
	setRandomizedElectionTimeout(r.raft, v)
}
```

**この関数は `raft_test.go` にある**。本体ではなくテストファイル。だから本番ビルドには含まれない。

しかし `rafttest` パッケージはこれを使いたい。テストファイルの関数は他パッケージから参照できないので、**関数の値として渡す** ([`rafttest/interaction_env.go#L27-L34`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rafttest/interaction_env.go#L27-L34))。

```go title="rafttest/interaction_env.go"
// InteractionOpts groups the options for an InteractionEnv.
type InteractionOpts struct {
	OnConfig func(*raft.Config)

	// SetRandomizedElectionTimeout is used to plumb this function down from the
	// raft test package.
	SetRandomizedElectionTimeout func(node *raft.RawNode, timeout int)
}
```

そして `interaction_test.go` が接続する ([`interaction_test.go#L30-L33`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/interaction_test.go#L30-L33))。

```go title="interaction_test.go"
		env := rafttest.NewInteractionEnv(&rafttest.InteractionOpts{
			SetRandomizedElectionTimeout: raft.SetRandomizedElectionTimeout,
		})
```

**テスト専用の内部アクセスを、本番コードにもテスト補助パッケージにも漏らさずに通す** 経路になっている。`rafttest` は `raft` パッケージのテストコードに依存していないが、テスト実行時にだけその機能を受け取れる。

テストからはコマンドとして呼べる ([`rafttest/interaction_env_handler.go#L100-L107`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rafttest/interaction_env_handler.go#L100-L107))。

```go title="rafttest/interaction_env_handler.go"
	case "set-randomized-election-timeout":
```

`testdata/*.txt` の中で選挙タイムアウトを固定し、その後 `tick-election` で刻めば、選挙の順序を完全に制御できる。

## tick を落とさない

`Node` 実装では、tick がバッファ付きチャネルで受けられる ([`node.go#L320-L323`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/node.go#L320-L323))。

```go title="node.go"
		// make tickc a buffered chan, so raft node can buffer some ticks when the node
		// is busy processing raft messages. Raft node will resume process buffered
		// ticks when it becomes idle.
		tickc:  make(chan struct{}, 128),
```

処理が詰まっているときも tick を溜めておき、暇になったら消化する。tick を落とすと、選挙タイムアウトが実時間より長くなり、リーダーの死の検知が遅れる。

それでも溢れることはある ([`node.go#L458-L466`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/node.go#L458-L466))。

```go title="node.go"
func (n *node) Tick() {
	select {
	case n.tickc <- struct{}{}:
	case <-n.done:
	default:
		n.rn.raft.logger.Warningf("%x A tick missed to fire. Node blocks too long!", n.rn.raft.id)
	}
}
```

溢れたら警告を出す。**「ノードが長時間ブロックしている」という運用上の問題として報告する**。黙って落とすと、選挙が起きない理由が分からなくなる。

## quiesce という抜け道

1 つ、非推奨になっている API がある ([`rawnode.go#L67-L81`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rawnode.go#L67-L81))。

```go title="rawnode.go"
// TickQuiesced advances the internal logical clock by a single tick without
// performing any other state machine processing. It allows the caller to avoid
// periodic heartbeats and elections when all of the peers in a Raft group are
// known to be at the same state. Expected usage is to periodically invoke Tick
// or TickQuiesced depending on whether the group is "active" or "quiesced".
//
// WARNING: Be very careful about using this method as it subverts the Raft
// state machine. You should probably be using Tick instead.
//
// DEPRECATED: This method will be removed in a future release.
func (rn *RawNode) TickQuiesced() {
	rn.raft.electionElapsed++
}
```

数万の Raft グループを持つ利用側では、ほとんどのグループが無活動になる。全部にハートビートを打つと、それだけで CPU とネットワークを食う。そこで「静止 (quiesce) しているグループはカウンタだけ進める」という抜け道が用意されていた。

いま非推奨になっている。警告文が率直で、「このメソッドは Raft の状態機械を破壊する」と書いてある。カウンタだけ進めてハートビートを打たないので、実際にリーダーが死んでも検知されない。利用側が「本当に静止しているか」を正しく判断できないと壊れる。

**危険な最適化を提供してしまった後、非推奨にして消す過程** がコードに残っている形になる。

## なぜそうなっているか

### 時計を読まないと何が変わるか

時計を読む実装では、テストで時間を進めるためにモックの時計が要る。モックを差し込む場所を全部見つけなければならないし、見落とすとテストが不安定になる。

`etcd-io/raft` では、時間の進行が `Tick()` の呼び出しという **明示的な入力** になっている。テストは呼びたいだけ呼ぶ。モックは要らない。

さらに、[「全部を Message にする」ページ](../everything-is-a-message/) で見たとおり、tick の結果は `MsgHup` や `MsgBeat` というメッセージになる。**時間の経過という事象が、他のあらゆる入力と同じ型に落ちる**。トレースにも記録され、TLA+ のトレース検証にも乗る。

### 負荷時の挙動が決定的になる

実時間で判断する実装では、負荷でスレッドが 500ms 止まると「500ms 経った」という 1 つの事実になる。tick で数える実装では「tick が 5 個溜まった」になり、5 回ぶんの処理が順に実行される。

後者は、負荷がかかったときの状態遷移が **負荷のかかり方に依存しない**。5 個ぶんの処理は、負荷がなかった場合と同じ順序で同じ結果になる。テストで再現できる範囲が広がる。

### 非決定性を 1 点に集める

乱数は 1 か所 (`resetRandomizedElectionTimeout`) にしかない。そこさえ固定すれば、ライブラリ全体が決定的になる。

**非決定性の源を数え上げられる状態に保つ** ことが、[datadriven テスト](../datadriven-tests/) と [TLA+ トレース検証](../tla-trace-validation/) の前提になっている。I/O を追い出し、時計を追い出した結果、残ったのが乱数 1 つだった、という順序で読める。

## どう活かすか

- **時間を「経過時間」ではなく「呼ばれた回数」で扱う**。タイマーを持つ状態機械を書くとき、内部で時計を読まず、外から刻んでもらう。テストが劇的に楽になる。単位の意味 (1 tick が何 ms か) は利用側に委ねる。
- **刻みを落とさない。落ちたら報告する**。バッファを持たせ、溢れたら警告を出す。黙って落とすと、タイムアウトが発火しない理由が追えなくなる。
- **非決定性を 1 点に集めて、そこに差し替え口を置く**。乱数・時刻・UUID のような非決定な要素を散らさない。1 か所にまとめれば、テストからの制御が 1 か所で済む。
- **テスト専用の内部アクセスは、関数値で通す**。`_test.go` に置いた関数をオプション構造体のフィールドとして渡す手は、本番コードに口を開けずに内部を触れるようにする。
- **ランダム化で衝突を解く**。分割投票のような対称性の問題は、乱数でずらすのが最も単純な解になることが多い。決定的な優先順位付け (ID の大小など) だと、特定のノードが常に勝つ偏りが出る。
