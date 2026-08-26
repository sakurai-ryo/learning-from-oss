---
title: "決定コアを純粋関数にし、I/O は Effect として外に出す"
description: "「何をすべきか」を決める部分を、時計もネットワークも持たない純粋な関数にする。関数は「次にやること」のリストを返すだけで、実際の I/O は外側が行う。競合のテストを再現可能にするための構造。"
sidebar:
  order: 2
---

## 何を学んだか

### どんな状況の話か

celld のノードは、リクエストが来るたびに「このセルの担当は誰か」「担当になるにはバケットに何を書くか」「書けなかったらどうするか」を判断する。この判断は、バケットからの返事やタイマーの発火といった**外部からの出来事**によって次々に変わる。

こういうコードは普通、次のように書く。

```rust
async fn handle(cell) {
    let record = bucket.read_owner(cell).await;   // ネットワーク I/O
    if record.node == me { ... }
    else if Instant::now() > record.expires { ... }  // 時計
    bucket.cas_owner(cell, ...).await;             // ネットワーク I/O
}
```

これはテストしにくい。「`read_owner` の返事が来る直前に、別のノードが担当を奪った」のような、タイミングで決まる状況を再現するには、実際にネットワークを遅くしたり時計をいじったりするしかない。

### celld の答え

celld は、判断のロジックを `crates/logic` という**依存ゼロの純粋なクレート**に閉じ込めた。クレートの入口は関数 1 つだけだ。

```
on_event(&mut State, Event) -> Vec<Effect>
```

意味はこうだ。

- `Event` は「外で起きたこと」。リクエストが来た、バケットの読み取りが返った、タイマーが鳴った、など。時刻もこの中に入れて渡す。
- `State` は「今の状況」。どのセルがどの状態か、リースはいつ切れるか、など。
- `Effect` は「次にやってほしいこと」。「このキーを読め」「このレコードを条件付きで書け」「3 秒後にタイマーを鳴らせ」など。

関数はネットワークにも時計にも触らない。`Event` を受け取って `State` を更新し、`Effect` のリストを返して終わる。実際に I/O をするのは外側 (`crates/celld`) で、結果をまた `Event` として渡す。

この形にすると、テストは「`Event` をどの順で渡すか」を自由に決められる。「読み取りの返事の前に別ノードの CAS が成功した」も、Event の順序を入れ替えるだけで再現できる。同じ順で渡せば同じ結果になるので、失敗を何度でも再現できる。

### 出来事には版番号を付ける

もう 1 つ重要な工夫がある。非同期の操作には `OpId` という番号を振り、返事が来たとき「今もその番号を待っているか」を確認する。待っていなければ捨てる。これで、タイムアウト後に遅れて届いた返事や、キャンセルした操作の返事が、状態を壊すことを防ぐ。

## ソースコードのどこか

### 契約

[`crates/logic/lib.rs#L3-L7`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L3-L7) と [`crates/logic/types.rs#L3-L8`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/types.rs#L3-L8)。

```rust title="crates/logic/lib.rs"
//! Clean-sheet celld decision core.
//!
//! [`on_event`] is the only way behavioral state advances. The production
//! executor and deterministic simulator both feed it events and perform the
//! returned effects. No adapter may mutate [`State`] directly.
```

「`on_event` だけが状態を進める。本番の実行器もシミュレータも、同じようにイベントを渡して effect を実行する。外側が `State` を直接いじってはいけない」と宣言している。

[`crates/logic/Cargo.toml#L8`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/Cargo.toml#L8) は `# Pure decision core: no async, I/O, clocks, randomness, locks, or dependencies.` で、`[dependencies]` セクション自体が存在しない。

### `on_event`

[`lib.rs#L4483-L4625`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L4483-L4625)。

```rust title="crates/logic/lib.rs"
pub fn on_event(state: &mut State, event: Event) -> Vec<Effect> {
    let mut effects = Vec::new();
    if let Some(now_mono_ms) = event_mono_ms(&event) {
        state.now_mono_ms = state.now_mono_ms.max(now_mono_ms);
    }
    if let Some(now_ms) = event_now_ms(&event) {
        state.now_ms = state.now_ms.max(now_ms);
    }
    match event {
        Event::OwnerRead { op, now_ms, result } => { state.owner_read(op, now_ms, result, &mut effects) }
        // ...
    }
    state.pump_activations(&mut effects);
    state.pump_release(&mut effects);
    if cfg!(debug_assertions) { state.validate().expect("state invariant"); }
    state.arm_operation_deadlines(&mut effects);
    effects
}
```

最初の数行で、イベントに含まれる時刻を `State` に取り込んでいる。「今何時か」を関数が自分で調べるのではなく、イベントが運んでくる。最後の `validate()` は、状態が壊れていないかの検査で、デバッグビルドでは毎回走る。

### Effect と Event は enum

[`types.rs#L613-L763`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/types.rs#L613-L763) の `Effect`。「やってほしいこと」の一覧表になっている。

```rust title="crates/logic/types.rs"
/// Work performed outside the core. Every asynchronous effect is versioned;
/// completion events with an obsolete `op` are ignored.
pub enum Effect {
    ScheduleTimer { timer: Timer, at_mono_ms: u64 },
    ReadOwner { op: OpId, cell: CellId },
    CasOwner { op: OpId, cell: CellId, guard: CasGuard, epoch: Epoch, takeover: bool },
    Restore { op: OpId, cell: CellId, spec: RestoreSpec },
    AwaitDurable { op: OpId, cell: CellId, epoch: Epoch, position: u64 },
    VerifyOwnership { op: OpId, cell: CellId, epoch: Epoch },
    Complete { request: RequestId, result: Result<Route, RequestError> },
    Halt { code: i32, reason: HaltReason },
    // ...
}
```

非同期のものには必ず `op: OpId` が付いている。返事のイベントも同じ `op` を持ち、時刻を一緒に運ぶ ([`types.rs#L479-L486`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/types.rs#L479-L486))。

```rust title="crates/logic/types.rs"
OwnerRead {
    op: OpId,
    /// Wall-clock observation made when the ownership read completed. It
    /// bounds reuse of a shared owner-node lease without letting the core
    /// read a clock itself.
    now_ms: u64,
    result: Result<Option<OwnerRecord>, Failure>,
},
```

タイマーも「鳴らしてほしい」という effect と「鳴った」というイベントの往復で、しかも世代番号付きだ ([`types.rs#L262-L290`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/types.rs#L262-L290))。古い世代のタイマーが遅れて鳴っても無視できる。

```rust title="crates/logic/types.rs"
/// Deterministic timers are versioned effects, not implicit clock reads. A
/// stale firing from a replaced lease generation is harmless.
pub enum Timer {
    NodeLeaseRenew { generation: u64 },
    NodeLeaseFence { generation: u64 },
    CellAlarm { cell: CellId, generation: u64 },
    OperationDeadline { op: OpId },
    QueuedActivation { cell: CellId, generation: u64 },
}
```

### 古い返事を捨てる仕組み

[`lib.rs#L984-L996`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L984-L996) の `take_cell_op`。返事の `op` が、そのセルが今待っている `op` と一致するときだけ処理する。

```rust title="crates/logic/lib.rs"
/// Resolve a completion's op to its cell, consuming the index entry —
/// but only when `predicate` confirms the cell still holds the op. On a
/// mismatch the entry stays: the op's real completion has not arrived
/// yet (an expiry can probe the wrong handler), and it must still find
/// its way here later.
fn take_cell_op(&mut self, op: OpId, predicate: impl Fn(&Cell) -> bool) -> Option<CellId> {
```

典型的なハンドラ [`lib.rs#L3280-L3321`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L3280-L3321) (`published`、セルの起動完了を処理する)。全ハンドラが同じ型で書かれている。(1) `take_cell_op` で本当に待っている返事か確認し、(2) セルを map から取り出し、(3) 結果で分岐して次の状態と effect を決め、(4) セルを戻す。

```rust title="crates/logic/lib.rs"
fn published(&mut self, op: OpId, result: Result<(), Failure>, effects: &mut Vec<Effect>) {
    let Some(id) = self.take_cell_op(op,
        |cell| matches!(cell.phase, Phase::Publishing { op: current, .. } if current == op),
    ) else {
        self.compensate_retired_runtime(op, result, effects);
        return;
    };
    let mut cell = self.cells.remove(&id).expect("cell found above");
    let Phase::Publishing { epoch, .. } = cell.phase else { unreachable!() };
    match result {
        Ok(()) => {
            set_phase(&mut self.occupied, &mut cell, Phase::Resident { epoch });
            self.finish_requests(&id, &mut cell, Ok(Route::Local), effects);
        }
        Err(_) => {
            let next = self.cell_op(&id);
            set_phase(&mut self.occupied, &mut cell,
                Phase::Cleaning { op: next, epoch, cause: StopCause::Cleanup });
            effects.push(Effect::StopRuntime { op: next, cell: id.clone(), epoch, cause: StopCause::Cleanup });
        }
    }
    self.cells.insert(id.clone(), cell);
```

成功なら「常駐 (Resident)」状態にして待っていたリクエストを通す。失敗なら「後始末中 (Cleaning)」状態にして、ランタイムを止める effect を返す。関数の中で I/O は一切していない。

### 実行側

[`crates/celld/lib.rs#L6-L10`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/lib.rs#L6-L10): `on_event` を呼ぶのはプロセス内で 1 つの直列アクターだけ。I/O を行う非同期タスクはコアの状態に触らず、完了をイベントとしてアクターのメールボックスに送る。

[`crates/celld/actor.rs#L1719-L1773`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L1719-L1773) の `drive` が、コアと I/O の橋渡しをするループ。

```rust title="crates/celld/actor.rs"
fn drive(&mut self, first: Event, out: &mut StepOutput) {
    let mut events = VecDeque::from([first]);
    while let Some(event) = events.pop_front() {
        let effects = on_event(&mut self.state, event);
        for effect in effects {
            self.execute(effect, &mut events, out);
        }
        if self.validate_invariants {
            self.state.validate().expect("celld core invariant");
        }
    }
}
```

`execute` は effect ごとに処理を分ける。すぐ終わるものは結果をイベントとしてキューの末尾に足し、ネットワークが要るものは非同期タスクとして外に出す。その一例 [`actor.rs#L1935-L1953`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L1935-L1953)。effect の `op` をそのまま返事のイベントに乗せ、時刻はここでサンプルする。

```rust title="crates/celld/actor.rs"
Effect::ReadOwner { op, cell } => {
    let ownership = self.ownership.clone();
    out.effects.push(Box::pin(async move {
        let result = ownership.read_owner(&cell).await;
        CompletedEffect::timed(
            Event::OwnerRead { op, now_ms: now_ms(), result },
            // ...
        )
    }));
}
```

本番では [`crates/celld/actor/production.rs#L3-L43`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor/production.rs#L3-L43) の `tokio::select!` が「メッセージ・I/O 完了・タイマー」のどれが先に来ても処理する。シミュレータはこのループを使わず、`Actor::start` / `Actor::step` を直接呼んで、入力の順序を自分で決める。

## なぜそうなっているか

- **実行側に置いた振る舞いは、テストから見えない。** [`lib.rs#L511-L515`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L511-L515) のコメントに失敗談が残っている。

  ```rust title="crates/logic/lib.rs"
  /// The shedding latch. celld kept this in the executor, which meant the
  /// hysteresis -- the part with actual behaviour -- was the one piece the
  /// simulation could not reach. It is carried here so a sample
  /// sequence is replayable.
  shedding: bool,
  ```

  「メモリが逼迫したらセルを追い出す」判断のヒステリシス (一度発動したら少し余裕ができるまで解除しない仕組み) を実行側に置いていたら、そこだけシミュレーションで検証できなかった。だからコアに移した、という話だ。同じ理由で、同時実行の上限 ([`lib.rs#L433-L442`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L433-L442)) やキャッシュの失効 ([`lib.rs#L462-L466`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L462-L466)) もコアの状態として持つ。

- **状態の検査は本番では高いが、シミュレーションでは安い。** [`actor.rs#L1072-L1082`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L1072-L1082): `validate()` は全セルを走査するので、1 万セルあると 1 イベントあたり約 800 マイクロ秒かかる。本番のリリースビルドでは切り、シミュレーションで毎イベント走らせる。

- **JavaScript の実行はシミュレーションに入れない。** V8 の実行順序は決定論的でないので、[`docs/testing.md`](https://github.com/denoland/celld/blob/v0.3.0/docs/testing.md) によればシミュレーションではセルの JS を「返ってこないハンドラ」「途中で止まる書き込み」のような台本で置き換える。コアが JS のことを知らないから、これができる。

- **コアは単一スレッドで動かす。** [`crates/celld/main.rs#L2706-L2722`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L2706-L2722): コア専用のスレッドを立てて、状態遷移の順序がシミュレータのモデルと一致するようにしている。

## どう活かすか

- 「タイミングで壊れそう」なロジック (リトライ、期限、リーダー選出、キャッシュ失効) は、I/O と時計を引数と戻り値に押し出した純粋関数として書く。`fn step(&mut State, Event) -> Vec<Effect>` という形は Rust に限らない。この構造は sans-IO や "functional core, imperative shell" という名前で知られている。
- 時刻はイベントに載せて渡す。関数の中で `now()` を呼んだ瞬間、テストで時間を操作できなくなる。
- 非同期操作に版番号を付け、返事が来たとき「今もその番号を待っているか」を確認する。キャンセル・タイムアウト・遅延到着という 3 つの問題が、この 1 つの確認で片付く。
- 「実行側に置いた方が楽」な状態 (レート制限、ヒステリシス、同時実行数) こそ、テストで再現したい振る舞いなので、コアに置く。
- 取り込むべきでない条件: 競合が問題にならない単純なアプリケーションでは、Effect の一覧表と実行器の二重構造は重すぎる。「決定論的テストで守りたい性質」を具体的に言えないなら、まだ分ける段階ではない。
