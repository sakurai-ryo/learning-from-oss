---
title: "128 回分の予算をスレッドローカルに置き、ライブラリの側から自発的に譲らせる"
description: "常に準備完了なチャネルを回し続けるループは、そのワーカーを永久に占有する。Rust には強制的なプリエンプションがないので、Tokio は「タスクごとの操作回数の予算」をスレッドローカルに持ち、チャネルやソケットの受信のたびに 1 減らす。0 になったら、それらの操作が Pending を返す。前に進めなかった場合には予算を戻すので、消費するのは「実際に何かできたとき」だけになっている。"
sidebar:
  order: 11
---

## 何を学んだか

### どんな状況の話か

このコードは、見た目に問題がない。

```rust
async fn drop_all<I: Stream + Unpin>(mut input: I) {
    while let Some(_) = input.next().await {}
}
```

だが `input` が **常に準備完了** だったら、`.await` は一度も止まらない。このタスクは `Poll::Pending` を返さず、ワーカースレッドを永久に占有する。同じワーカーのキューにいる他のタスクは、一切走らない。

OS のスレッドならタイマー割り込みで強制的に取り上げられる。**Rust の async にはそれがない。** タスクを止められるのは、タスク自身が `Pending` を返したときだけだ。`poll` の途中で外から中断する手段はない (中断したら future の状態が壊れる)。

モジュールの doc がこの制約を明言している。

```rust title="tokio/src/task/coop/mod.rs"
//! Since Rust does not have a runtime, it is difficult to forcibly preempt a
//! long-running task. Instead, this module provides an opt-in mechanism for
//! futures to collaborate with the executor to avoid starvation.
```

**強制できないので、協調してもらう。**

### Tokio の答え

**タスク 1 回の poll に「128 回分の操作」という予算を与える。**

```rust title="tokio/src/task/coop/mod.rs"
    /// Budget assigned to a task on each poll.
    ///
    /// The value itself is chosen somewhat arbitrarily. It needs to be high
    /// enough to amortize wakeup and scheduling costs, but low enough that we
    /// do not starve other tasks for too long. The value also needs to be high
    /// enough that particularly deep tasks are able to do at least some useful
    /// work at all.
    ///
    /// Note that as more yield points are added in the ecosystem, this value
    /// will probably also have to be raised.
    const fn initial() -> Budget {
        Budget(Some(128))
    }
```

予算はスレッドローカルに置かれ、Tokio のリソース操作 (チャネルの `recv`、ソケットの `read`、`Mutex::lock`、`JoinHandle` の poll、…) が **1 回ごとに 1 減らす**。0 になったら、それらの操作が **データが準備できていても `Pending` を返す**。

すると future は `Pending` を返し、タスクはスケジューラに戻る。キューの末尾に並び直して、他のタスクに順番が回る。

**「譲る場所」がユーザーのコードではなく、ライブラリの中にある** のがこの設計の要点だ。ユーザーは `while let Some(_) = input.next().await {}` と書くだけでよく、`input` が Tokio のチャネルなら勝手に協調する。

## ソースコードのどこか

### 予算の設定と復元

[`task/coop/mod.rs#L129-L168`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/task/coop/mod.rs#L129-L168)。

```rust title="tokio/src/task/coop/mod.rs"
/// Runs the given closure with a cooperative task budget. When the function
/// returns, the budget is reset to the value prior to calling the function.
#[inline(always)]
pub(crate) fn budget<R>(f: impl FnOnce() -> R) -> R {
    with_budget(Budget::initial(), f)
}

#[inline(always)]
fn with_budget<R>(budget: Budget, f: impl FnOnce() -> R) -> R {
    struct ResetGuard {
        prev: Budget,
    }

    impl Drop for ResetGuard {
        fn drop(&mut self) {
            let _ = context::budget(|cell| {
                cell.set(self.prev);
            });
        }
    }
```

**`Drop` で戻すガード。** 入れ子で呼ばれても、パニックで巻き戻されても、必ず元に戻る。

呼び出しているのは、ワーカーがタスクを走らせる場所だ ([前ページ](../lifo-slot/) で見た `run_task` の中)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
        // Run the task
        coop::budget(|| {
            task.run();
            ...
```

**LIFO スロットの連鎖も、この 1 個のクロージャの中で回る。** だから予算は「1 タスクあたり」ではなく「1 回のスケジューラの往復あたり」で共有される。3 個のタスクが連鎖したら、128 回を 3 個で分け合う。

`Budget` の中身が `Option<u8>` なのも小さな設計だ。`None` が「無制限」を表す。`unconstrained()` で作られ、`task::unconstrained(fut)` でユーザーがオプトアウトできる。

### 予算を使う側

[`#L342-L364`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/task/coop/mod.rs#L342-L364)。

```rust title="tokio/src/task/coop/mod.rs"
    pub fn poll_proceed(cx: &mut Context<'_>) -> Poll<RestoreOnPending> {
        context::budget(|cell| {
            let mut budget = cell.get();

            let decrement = budget.decrement();

            if decrement.success {
                let restore = RestoreOnPending::new(cell.get());
                cell.set(budget);

                // avoid double counting
                if decrement.hit_zero {
                    inc_budget_forced_yield_count();
                }

                Poll::Ready(restore)
            } else {
                register_waker(cx);
                Poll::Pending
            }
        }).unwrap_or(Poll::Ready(RestoreOnPending::new(Budget::unconstrained())))
    }
```

使う側はこう書く。

```rust title="tokio/src/task/coop/mod.rs"
    ///     fn poll_next(
    ///         mut self: Pin<&mut Self>,
    ///         cx: &mut Context<'_>
    ///     ) -> Poll<Option<T>> {
    ///         let coop = ready!(coop::poll_proceed(cx));
    ///         match self.receiver.poll_next_unpin(cx) {
    ///             Poll::Ready(v) => {
    ///                 // We received a value, so consume budget.
    ///                 coop.made_progress();
    ///                 Poll::Ready(v)
    ///             }
    ///             Poll::Pending => Poll::Pending,
    ///        }
    ///     }
```

**`ready!` で書けるのがうまい。** 予算切れは `Pending` なので、`ready!` マクロがそのまま早期リターンしてくれる。呼び出し側に「予算」という概念のための特別な分岐が要らない。

### 前に進めなかったら、予算を返す

返り値の型が肝だ ([`#L257-L289`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/task/coop/mod.rs#L257-L289))。

```rust title="tokio/src/task/coop/mod.rs"
    #[derive(Debug)]
    #[must_use]
    pub struct RestoreOnPending(Cell<Budget>, PhantomData<*mut ()>);

    impl RestoreOnPending {
        /// Signals that the task that obtained this `RestoreOnPending` was able to make
        /// progress. This prevents the task budget from being restored to the value
        /// it had prior to obtaining this instance when it is dropped.
        pub fn made_progress(&self) {
            self.0.set(Budget::unconstrained());
        }
    }

    impl Drop for RestoreOnPending {
        fn drop(&mut self) {
            // Don't reset if budget was unconstrained or if we made progress.
            // They are both represented as the remembered budget being unconstrained.
            let budget = self.0.get();
            if !budget.is_unconstrained() {
                let _ = context::budget(|cell| {
                    cell.set(budget);
                });
            }
        }
    }
```

**予算は「先に引いて、進めたら確定、進めなかったら戻す」。**

これがないと、何が起きるか。`select!` で 10 個のチャネルを待つコードを考える。10 個とも空でも、poll するだけで 10 個の予算が消える。何も受信していないのに、13 回ループしただけで予算が尽きる。

**「予算を消費してよいのは、実際に何かを取り出せたときだけ」** という規則が、この型で表現されている。しかも `made_progress()` を呼ばずに落とせば自動的に戻るので、**呼び忘れても安全側に倒れる**。`#[must_use]` が付いているので、返り値を捨てるとまず警告が出る。

「進めた」の内部表現が `Budget::unconstrained()` なのは小さな技巧で、**「無制限だった場合」と「進めた場合」を同じ判定で扱えている**。どちらも「復元しない」で正しい。

### 予算切れのときの起こし方

`Pending` を返すからには、誰かがこのタスクを起こさないと二度と走らない。予算はスレッドローカルなので、待つ相手がいない。

```rust title="tokio/src/task/coop/mod.rs"
        fn register_waker(cx: &mut Context<'_>) {
            context::defer(cx.waker());
        }
```

`Defer` はワーカーが持つ waker の一時置き場だ ([`scheduler/defer.rs`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/defer.rs))。

```rust title="tokio/src/runtime/scheduler/defer.rs"
    pub(crate) fn defer(&self, waker: &Waker) {
        let mut deferred = self.deferred.borrow_mut();

        // If the same task adds itself a bunch of times, then only add it once.
        if let Some(last) = deferred.last() {
            if last.will_wake(waker) {
                return;
            }
        }

        deferred.push(waker.clone());
    }
```

**その場で `wake()` を呼ばない。** 呼ぶと、まだ poll の途中なのに [タスク状態](../task-state/) の `NOTIFIED` が立ち、poll から戻った瞬間に即座に再スケジュールされる。それでも動くが、`Defer` に溜めておけば **ワーカーが park する直前などの適切なタイミングでまとめて起こせる**。

`will_wake` による重複除去も入っている。1 回の poll の中で `select!` が 10 個の枝すべてで予算切れになったら、同じ waker が 10 回積まれる。[waker のページ](../task-waker/) で見た「vtable が 1 個」の設計が、ここでも効いている。

`cfg_not_rt!` 側 (Tokio のランタイム外で使われた場合) では、素直に `wake_by_ref()` する。**ランタイムがないなら遅延させる置き場もないので、動作する最低限に落ちる。**

### 譲る場所を、どこに置くか

モジュールの冒頭に、置き場所の指針が書いてある ([`#L82-L90`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/task/coop/mod.rs#L82-L90))。

```rust title="tokio/src/task/coop/mod.rs"
// # Placing yield points
//
// Voluntary yield points should be placed _after_ at least some work has been
// done. If they are not, a future sufficiently deep in the task hierarchy may
// end up _never_ getting to run because of the number of yield points that
// inevitably appear before it is reached. In general, you will want yield
// points to only appear in "leaf" futures -- those that do not themselves poll
// other futures. By doing this, you avoid double-counting each iteration of
// the outer future against the cooperating budget.
```

**「葉」の future にだけ置く。** 中間の future にも置くと、1 回の操作で予算が 2 回も 3 回も引かれる (二重計上)。

さらに深刻なのは、**深いところにある future が永遠に走れなくなる** ケースだ。予算を引く場所が経路上に 5 個あれば、いちばん奥に到達する前に予算が尽きる。奥の future は一度も動かないまま、タスクが毎回譲ることになる。

### ユーザーが手動で協調する道

Tokio のリソースを使わない純粋な計算ループには、予算を引く場所がない。そのための API がある ([`task/coop/consume_budget.rs`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/task/coop/consume_budget.rs))。

```rust title="tokio/src/task/coop/consume_budget.rs"
/// Consumes a unit of budget and returns the execution back to the Tokio
/// runtime *if* the task's coop budget was exhausted.
///
/// The task will only yield if its entire coop budget has been exhausted.
/// This function can be used in order to insert optional yield points into long
/// computations that do not use Tokio resources like sockets or semaphores,
/// without redundantly yielding to the runtime each time.
pub async fn consume_budget() {
```

**`yield_now()` との違いが doc に書かれている。** `yield_now()` は毎回必ず譲るので、ループの中で呼ぶとスケジューリングのコストが毎周乗る。`consume_budget()` は予算が尽きたときだけ譲るので、128 回に 1 回で済む。

「毎回譲る」と「一度も譲らない」の間に、**「128 回に 1 回譲る」という選択肢を用意している**。

## なぜそうなっているか

- **予算方式になったのは、Rust の async に強制プリエンプションがないから。** poll の途中でタスクを止める手段がない以上、止まってもらうしかない。そして「止まってください」と頼む場所は、ユーザーのコードよりライブラリの中のほうが確実だ。
- **スレッドローカルに置いたのは、`Context` に載せられないから。** 予算を伝えるには `Future::poll` の引数を変えるしかないが、`Context` は標準ライブラリの型で、Tokio が拡張できない。スレッドローカルなら、既存の API を一切変えずに全階層へ伝わる。
- **128 という値は、償却と飢餓のトレードオフ。** 小さすぎると譲る回数が増えてスケジューリングのコストが乗る。大きすぎると他のタスクが待たされる。しかも深い future ほど予算を食うので、「奥まで届く程度には大きく」も要る。「エコシステムに譲る場所が増えたら、この値も上げる必要があるだろう」とまで書いてある。
- **進めなかったら予算を返すのは、`select!` のようなポーリングを罰しないため。** 複数の候補を試して全部空だった、というのは正常な動作で、それに予算を課すと待つだけで枯れる。
- **「進めた」を明示的に宣言させ、デフォルトを「返す」にしたのは、呼び忘れの向きを安全にするため。** 逆にすると、`made_progress` を呼び忘れた実装が予算を食い潰す。
- **予算切れの waker を `Defer` に溜めるのは、poll の途中で起こしたくないから。** その場で `wake()` すると `NOTIFIED` が立ち、poll から戻った瞬間の再スケジュールが確定する。溜めておけば、ワーカーが park する前などの適切な時点でまとめて処理できる。
- **葉の future にだけ譲る場所を置くのは、二重計上と深部の飢餓を避けるため。** 経路上のすべての層で引くと、いちばん奥に届く前に予算が尽きる。

## どう活かすか

- **強制的に止められない実行単位には、「予算」を持たせて自発的に止めてもらう。** 割り込めない環境 (コルーチン、イベントループのコールバック、WASM) では、これが唯一の一般的な手段になる。
- **予算を減らす場所は、ユーザーのコードではなくライブラリの内側に置く。** ユーザーに「たまに譲ってください」と要求する設計は守られない。よく使われる操作 (受信、読み取り、ロック取得) に埋め込めば、普通に書くだけで協調が成立する。
- **予算は「先に引いて、進めたら確定」にする。** 試行しただけで消費すると、複数候補を待つコードが不当に罰せられる。確定を明示的な呼び出しにして、デフォルト (呼ばない = `Drop`) を「返す」にすれば、実装ミスが安全側に倒れる。
- **`ready!` で扱える形にする。** 「予算切れ」を `Pending` として表現すれば、呼び出し側は既存の早期リターンの仕組みに乗せられる。専用のエラー型や分岐を持ち込むと、あらゆる呼び出し箇所が汚れる。
- **`Pending` を返すなら、必ず起こす経路をセットで用意する。** 誰も待っていない理由で `Pending` を返すのは、そのままだとハングだ。ここでは「後でまとめて起こす」置き場を用意して、poll の途中で起こす副作用も避けている。
- **譲る場所は、呼び出し階層の葉に置く。** 中間層にも置くと、1 回の実質的な仕事で何度も予算が引かれ、深い層に制御が届かなくなる。
- **「毎回譲る」と「譲らない」の中間を用意する。** 明示的な `yield` はコストが高く、ループの中では割に合わない。「予算が尽きたときだけ譲る」を用意すると、計算ループにも協調を入れられる。
