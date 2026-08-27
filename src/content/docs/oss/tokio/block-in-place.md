---
title: "ワーカーから「コア」を引き剥がして別スレッドに渡すと、ブロックしたまま並列度を保てる"
description: "block_in_place は、今のスレッドをブロックさせる代わりに、そのワーカーの実行キューや統計をまとめた「コア」をポインタ 1 個のスワップで手放し、ブロッキングプールの別スレッドに拾わせる。ブロックが終わったら、Drop ガードがコアを取り返す。ワーカースレッドとワーカーの状態を別の型に分けておいたから、この付け替えが成立している。"
group: "公平性とブロッキング"
sidebar:
  order: 12
---

## 何を学んだか

### どんな状況の話か

非同期ランタイムの中で、ブロックする処理を呼んではいけない。

```rust
async fn handler() {
    let data = std::fs::read("big.dat").unwrap();  // ← 数十ミリ秒スレッドが止まる
    process(data).await;
}
```

その間、このワーカースレッドは何もできない。ローカルキューに 200 個のタスクがあっても、全部待たされる。ワーカーが 8 個あって 8 個ともこれをやったら、ランタイム全体が止まる。

正攻法は `spawn_blocking` だ。ブロックする処理を専用のスレッドプールに投げて、結果を `await` する。

```rust
let data = tokio::task::spawn_blocking(|| std::fs::read("big.dat")).await.unwrap();
```

だが、これができない場合がある。

- **クロージャに `'static` が要る。** 借用しているデータを渡せない。
- **戻り値を `Send` にしなければならない。**
- **そもそも「一部分だけ」ブロックする場合、そこだけ切り出すのが面倒。** 大きな同期処理の途中に await が挟まっている、といった形は切り出せない。

### Tokio の答え

**スレッドを動かす代わりに、仕事のほうを動かす。**

```rust
tokio::task::block_in_place(|| {
    // ここは好きなだけブロックしてよい
    std::fs::read("big.dat")
})
```

ワーカースレッドが持っている **「コア」** (ローカル実行キュー、LIFO スロット、統計、乱数の種) を、丸ごと別のスレッドに渡す。渡された側は、そのコアを使って何事もなかったようにタスクを処理し続ける。

元のスレッドは自由にブロックしてよい。**ブロックしている間も、そのワーカーの持ち分のタスクは別のスレッドで走り続ける。** クロージャが終わったら、コアを取り返す。

これが成立するのは、**ワーカースレッドとワーカーの状態が最初から別の型に分けてある** からだ。

## ソースコードのどこか

### 分離された「ワーカー」と「コア」

[`multi_thread/worker.rs#L100-L138`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L100-L138)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
pub(super) struct Worker {
    /// Reference to scheduler's handle
    handle: Arc<Handle>,

    /// Index holding this worker's remote state
    index: usize,

    /// Used to hand-off a worker's core to another thread.
    core: AtomicCell<Core>,
}

/// Core data
struct Core {
    /// Used to schedule bookkeeping tasks every so often.
    tick: u32,

    lifo_slot: Option<Notified>,

    lifo_enabled: bool,

    /// The worker-local run queue.
    run_queue: queue::Local<Arc<Handle>>,
```

**`Worker` は「16 個あるワーカーのうちの何番目か」という identity で、`Core` は「その仕事に必要な状態一式」。** そして `Core` は `AtomicCell` に入っている。

モジュールの冒頭に、この分離の目的がそのまま書かれている。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
//! A scheduler is initialized with a fixed number of workers. Each worker is
//! driven by a thread. Each worker has a "core" which contains data such as the
//! run queue and other state. When `block_in_place` is called, the worker's
//! "core" is handed off to a new thread allowing the scheduler to continue to
//! make progress while the originating thread blocks.
```

`AtomicCell` の実装は 50 行しかない ([`util/atomic_cell.rs`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/util/atomic_cell.rs))。

```rust title="tokio/src/util/atomic_cell.rs"
pub(crate) struct AtomicCell<T> {
    data: AtomicPtr<T>,
}

impl<T> AtomicCell<T> {
    pub(crate) fn swap(&self, val: Option<Box<T>>) -> Option<Box<T>> {
        let old = self.data.swap(to_raw(val), AcqRel);
        from_raw(old)
    }

    pub(crate) fn set(&self, val: Box<T>) {
        let _ = self.swap(Some(val));
    }

    pub(crate) fn take(&self) -> Option<Box<T>> {
        self.swap(None)
    }
}
```

**`Box<T>` を `AtomicPtr` に生ポインタとして預けているだけ。** `take()` が `swap(null)` で、成功した者だけが `Box` を受け取る。所有権の受け渡しが、1 回の `swap` で決まる。

「コアの受け渡し」という重い概念が、**ポインタ 1 個の交換** に落ちている。`Mutex<Option<Core>>` にする手もあるが、`swap` なら待つことがない。

### 4 通りの状況を場合分けする

[`#L423-L467`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L423-L467)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    with_current(|maybe_cx| {
        match (
            crate::runtime::context::current_enter_context(),
            maybe_cx.is_some(),
        ) {
            (context::EnterRuntime::Entered { .. }, true) => {
                // We are on a thread pool runtime thread, so we just need to
                // set up blocking.
                had_entered = true;
            }
            (
                context::EnterRuntime::Entered {
                    allow_block_in_place,
                },
                false,
            ) => {
                // We are on an executor, but _not_ on the thread pool.  That is
                // _only_ okay if we are in a thread pool runtime's block_on
                // method:
                if allow_block_in_place {
                    had_entered = true;
                    return Ok(());
                } else {
                    // This probably means we are on the current_thread runtime or in a
                    // LocalSet, where it is _not_ okay to block.
                    return Err(
                        "can call blocking only when running on the multi-threaded runtime",
                    );
                }
            }
            (context::EnterRuntime::NotEntered, true) => {
                // This is a nested call to block_in_place (we already exited).
                // All the necessary setup has already been done.
                return Ok(());
            }
            (context::EnterRuntime::NotEntered, false) => {
                // We are outside of the tokio runtime, so blocking is fine.
                // We can also skip all of the thread pool blocking setup steps.
                return Ok(());
            }
        }
```

**2 つの真偽値の組み合わせ 4 通りが、全部書き出されている。** 「ランタイムに入っているか」と「スケジューラのコンテキストがあるか」。

- **両方あり**: 普通のワーカースレッド。コアを渡す準備をする。
- **ランタイムには入っているがコンテキストがない**: `block_on` の中。マルチスレッドランタイムの `block_on` なら許す (`allow_block_in_place`)。current-thread ランタイムなら **パニック**。
- **入っていないがコンテキストがある**: `block_in_place` の入れ子。すでに準備済みなので何もしない。
- **両方なし**: ランタイムの外。普通に呼べばいい。

**「この関数がどんな文脈から呼ばれうるか」を、条件の直積として列挙している。** マッチが網羅的なので、新しい文脈が増えたらコンパイルエラーになる。

current-thread ランタイムでパニックするのは、そこにコアの受け渡し先がないからだ。**ワーカーが 1 個しかないので、渡しても意味がない。** メッセージが「マルチスレッドランタイムでのみ呼べる」と明示している。

### コアを渡して、拾い手を起動する

[`#L475-L509`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L475-L509)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
        // Get the worker core. If none is set, then blocking is fine!
        let mut core = match cx.core.borrow_mut().take() {
            Some(core) => core,
            None => return Ok(()),
        };

        // If we heavily call `spawn_blocking`, there might be no available thread to
        // run this core. Except for the task in the lifo_slot, all tasks can be
        // stolen, so we move the task out of the lifo_slot to the run_queue.
        if let Some(task) = core.lifo_slot.take() {
            core.run_queue
                .push_back_or_overflow(task, &*cx.worker.handle, &mut core.stats);
        }

        // We are taking the core from the context and sending it to another
        // thread.
        take_core = true;

        // The parker should be set here
        assert!(core.park.is_some());

        // In order to block, the core must be sent to another thread for
        // execution.
        //
        // First, move the core back into the worker's shared core slot.
        cx.worker.core.set(core);

        // Next, clone the worker handle and send it to a new thread for
        // processing.
        //
        // Once the blocking task is done executing, we will attempt to
        // steal the core back.
        let worker = cx.worker.clone();
        runtime::spawn_blocking(move || run(worker));
        Ok(())
```

手順は 3 つ。**LIFO スロットを空にする → コアを共有スロットに戻す → ブロッキングプールに `run(worker)` を投げる。**

LIFO スロットの処理は [そのページ](../lifo-slot/) で触れたとおりで、**拾い手が現れない場合の保険** だ。`spawn_blocking` を大量に使っているとブロッキングプールのスレッドが枯れていて、`run(worker)` が実行されるまで時間がかかる。その間、キューのタスクは他のワーカーが盗めるが、LIFO スロットのタスクだけは誰にも届かない。

**新しいワーカースレッドを起こすのではなく、`spawn_blocking` に投げているのも面白い。** ワーカーの実体は「コアを持って `run` するスレッド」でしかないので、どのスレッドがやっても同じだ。ブロッキングプールはもともとスレッドを使い回す仕組みを持っているので、それに相乗りする。

拾い手側 ([`#L522-L545`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L522-L545))。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
fn run(worker: Arc<Worker>) {
    ...
    // Acquire a core. If this fails, then another thread is running this
    // worker and there is nothing further to do.
    let core = match worker.core.take() {
        Some(core) => core,
        None => return,
    };
```

**`take()` が `None` を返したら黙って帰る。** 誰かが先にコアを取った、つまり自分の出番はない。競合の解決が「先に `swap` した者が勝ち、負けた者は帰る」の 1 行で済んでいる。

そして、この関数はランタイム起動時にも使われている。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
impl Launch {
    pub(crate) fn launch(mut self) {
        for worker in self.0.drain(..) {
            runtime::spawn_blocking(move || run(worker));
        }
    }
}
```

**ランタイムの起動と、`block_in_place` からの引き継ぎが、まったく同じ関数を通る。** ワーカースレッドの起動が「コアを拾って回す」以上のことをしていないので、この 2 つを区別する必要がない。

### 取り返すのは Drop ガード

[`#L366-L420`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L366-L420)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
pub(crate) fn block_in_place<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    // Try to steal the worker core back
    struct Reset {
        take_core: bool,
        budget: coop::Budget,
    }

    impl Drop for Reset {
        fn drop(&mut self) {
            with_current(|maybe_cx| {
                if let Some(cx) = maybe_cx {
                    if self.take_core {
                        let core = cx.worker.core.take();
                        ...
                        let mut cx_core = cx.core.borrow_mut();
                        assert!(cx_core.is_none());
                        *cx_core = core;
                    }

                    // Reset the task budget as we are re-entering the
                    // runtime.
                    coop::set(self.budget);
                }
            });
        }
    }
```

**取り返す処理が `Drop` にあるので、クロージャがパニックしても実行される。** ブロッキング処理は任意のユーザーコードなので、パニックは普通に起こる。ここで復帰しないと、ワーカーの状態が壊れたままになる。

`take()` の結果を無条件に代入しているのも正しい。**取り返せないこともある** (別のスレッドが先に拾って走らせている)。その場合 `None` が入り、このスレッドは「コアを持たないワーカースレッド」として `run_task` のループから抜ける。

そして予算の扱い ([`#L409-L420`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L409-L420))。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    if had_entered {
        // Unset the current task's budget. Blocking sections are not
        // constrained by task budgets.
        let _reset = Reset {
            take_core,
            budget: coop::stop(),
        };

        crate::runtime::context::exit_runtime(f)
    } else {
        f()
    }
```

**ブロッキング区間では [協調予算](../coop-budget/) を無効にする。** 予算は「ワーカーを占有しないため」の仕組みだが、今まさにコアを手放してワーカーを占有していない状態なので、制限する理由がない。`coop::stop()` が現在値を返し、`Reset` が持って戻す。

`exit_runtime(f)` も重要だ。クロージャの中では「ランタイムの中にいない」ことになる。だから **クロージャの中で `Handle::block_on` を呼んでも「ランタイムの中でブロックした」と怒られない**。文脈の付け替えが、こういう入れ子を成立させている。

### ワーカースレッドのパニックは、debug ビルドでプロセスを落とす

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
fn run(worker: Arc<Worker>) {
    #[allow(dead_code)]
    struct AbortOnPanic;

    impl Drop for AbortOnPanic {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!("worker thread panicking; aborting process");
                std::process::abort();
            }
        }
    }

    // Catching panics on worker threads in tests is quite tricky. Instead, when
    // debug assertions are enabled, we just abort the process.
    #[cfg(debug_assertions)]
    let _abort_on_panic = AbortOnPanic;
```

**「ワーカースレッドのパニックをテストで捕まえるのは難しいので、開発中は即座に落とす」。** リリースビルドでは動作を変えず、開発中だけ厳しくする。

見逃されたパニックがワーカースレッドを 1 つ減らし、ランタイムが「なんとなく遅い」状態になるのが最悪なので、開発中は騒がしいほうを選んでいる。

## なぜそうなっているか

- **ワーカーとコアを分離したのは、この付け替えを可能にするため。** 1 個の構造体にまとめてスレッドローカルに置くと、他のスレッドから触れない。「identity (何番目のワーカーか)」と「状態 (キューや統計)」を分けたから、状態だけを移動できる。
- **受け渡しに `AtomicPtr` の `swap` を使ったのは、待たせないため。** ミューテックスでもできるが、渡す側が待つ可能性が出る。`swap` なら、勝った側が所有権を得て、負けた側は即座に帰れる。
- **`spawn_blocking` に投げているのは、そこにスレッドを使い回す仕組みがすでにあるから。** ワーカースレッドは「コアを拾って回すだけ」なので、専用のスレッド生成ロジックを別に持つ必要がない。実際、ランタイム起動も同じ関数を通る。
- **呼び出し文脈を 4 通り列挙したのは、誤用が静かに壊れるから。** current-thread ランタイムで呼ばれたら、渡す先がないのでブロックがそのままランタイムを止める。パニックで即座に知らせるほうが親切だ。
- **復帰処理を `Drop` に置いたのは、クロージャがパニックしうるから。** ブロッキング処理はユーザーコードで、失敗するのが普通だ。復帰が走らなければ、ワーカーは以降コアなしで動くことになる。
- **ブロッキング区間で協調予算を切るのは、予算の目的が「ワーカーの占有を防ぐ」だから。** コアを手放している間は占有していないので、制限する理由がない。
- **`exit_runtime` で文脈を抜けるのは、クロージャの中を「ランタイムの外」にするため。** ここで `block_on` を呼びたくなるのは自然な要求で、それを「ランタイム内でブロックした」と誤検出させない。

## どう活かすか

- **「実行主体」と「実行に必要な状態」を別の型に分ける。** 分けておくと、状態だけを他の主体に移せる。スレッドローカルに全部を置く設計は、この選択肢を最初から捨てている。
- **所有権の受け渡しは、`AtomicPtr` の `swap` 1 回で表現できることがある。** 「先に取った者が所有者、取れなかった者は帰る」という規則は、ロックを使わずに書ける。50 行のラッパで済む。
- **専用のスレッド生成を持たず、既存のプールに相乗りする。** 「その仕事をするスレッド」に特別な初期化が要らないなら、汎用のブロッキングプールに投げてよい。起動経路が 1 本になる副産物もある。
- **呼び出し文脈で挙動が変わる関数は、条件の直積を全部書き出す。** `if` を並べるより、タプルの `match` で網羅させる。文脈が増えたときにコンパイラが漏れを指摘してくれる。
- **サポートしない文脈では、明示的なメッセージでパニックさせる。** 「動くが何も起きない」「動くがランタイムが止まる」は、後から原因を追うのが極めて難しい。
- **状態を一時的に手放す処理の復帰は、必ず `Drop` に置く。** 途中の処理はパニックしうる。復帰しないと、その主体は壊れた状態で動き続ける。しかも「動くが遅い」形で現れるので、テストで見つからない。
- **開発ビルドだけ、見逃しやすい失敗を騒がしくする。** ワーカースレッドが 1 本静かに死ぬ、といった不具合は、リリースでは縮退運転に見えてしまう。`#[cfg(debug_assertions)]` で厳しくしておけば、テスト中に必ず気づける。
