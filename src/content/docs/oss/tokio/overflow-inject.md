---
title: "ローカルキューが溢れたら半分をグローバルへ移し、取り戻すときは前半に置く"
description: "固定長のローカルキューが満杯になったら、後半の 128 個をグローバルキューへ流す。前半ではなく後半を出すのは、グローバルから取り戻したタスクが前半に入るからで、こうすると「取り出した直後に押し戻す」が起こらない。グローバルキューはロック付きの連結リストだが、長さだけは別のアトミック変数に出して、空のときにロックを取らずに済ませている。"
group: "work-stealing スケジューラ"
sidebar:
  order: 8
---

## 何を学んだか

### どんな状況の話か

ローカルの実行キューは固定長 256 だ ([前のページ](../local-run-queue/))。固定長なので、必ず溢れる。

溢れる状況は珍しくない。1 個のタスクが `for _ in 0..10000 { tokio::spawn(...) }` をやれば、そのワーカーのキューはすぐ満杯になる。

素朴な解は 2 つあって、どちらも良くない。

- **キューを可変長にする。** 溢れなくなるが、ロックフリーな可変長リングバッファは格段に難しい (古いバッファをいつ解放するか、という問題が出る) し、`push` のたびに容量チェックと再確保の分岐が入る。
- **溢れたらブロックする。** spawn 元が止まる。デッドロックの温床になる。

そして、溢れた分の置き場としての **グローバルキュー (inject queue)** には、別の役割もある。ランタイムの外 (`Handle::spawn`、I/O ドライバのスレッド) からタスクを投入する経路だ。どのワーカーのキューにも属さないタスクは、ここに入る。

### Tokio の答え

**溢れたら、キューの後半 128 個 + 今の 1 個をまとめてグローバルキューに移す。**

なぜ「半分」かは分かりやすい。1 個ずつ移すと、満杯の状態が続いてグローバルキューへの `push` が毎回起きる。半分空ければ、次に溢れるまで 128 回は移動が起きない。**償却コストを下げるための一括処理** だ。

面白いのは **なぜ「後半」か** で、これはグローバルキューから取り戻すときの置き場と対になっている。

## ソースコードのどこか

### 溢れたときの 3 分岐

[`multi_thread/queue.rs#L182-L223`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/queue.rs#L182-L223)。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
        let tail = loop {
            let head = self.inner.head.load(Acquire);
            let (steal, real) = unpack(head);

            // safety: this is the **only** thread that updates this cell.
            let tail = unsafe { self.inner.tail.unsync_load() };

            if tail.wrapping_sub(steal) < LOCAL_QUEUE_CAPACITY as UnsignedShort {
                // There is capacity for the task
                break tail;
            } else if steal != real {
                // Concurrently stealing, this will free up capacity, so only
                // push the task onto the inject queue
                overflow.push(task);
                return;
            } else {
                // Push the current task and half of the queue into the
                // inject queue.
                match self.push_overflow(task, real, tail, overflow, stats) {
```

真ん中の分岐が目を引く。**「今まさに誰かが盗んでいる最中なら、半分を移すのはやめて、この 1 個だけをグローバルへ送る」。**

盗みが完了すれば容量が空く。それを待たずに 128 個も移すのは働きすぎだ。**「もうすぐ空くと分かっているなら、大掛かりな処理を始めない」** という判断で、判定材料は前ページの `steal != real` (盗み取り作業中) がそのまま使われている。

### 後半を出す理由

[`#L246-L316`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/queue.rs#L246-L316)。まず全部を自分のものとして確保する。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
        // Claim all tasks.
        //
        // We are claiming the tasks **before** reading them out of the buffer.
        // This is safe because only the **current** thread is able to push new
        // tasks.
        if self
            .inner
            .head
            .compare_exchange_weak(pack(head, head), pack(tail, tail), Release, Relaxed)
            .is_err()
        {
            // We failed to claim the tasks, losing the race. Return out of
            // this function and try the full `push` routine again. The queue
            // may not be full anymore.
            return Err(task);
        }
```

`head` を一気に `tail` まで進める。この瞬間、キューは空になったように見え、**盗む者も入ってこられなくなる**。

そして、前半を返す。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
        // Add back the first half of tasks.
        //
        // We are doing it this way instead of just taking half of the tasks because we want the
        // *second* half of the tasks, and if you just incremented `head` by `NUM_TASKS_TAKEN`,
        // then you would be taking the first half instead of the second half.
        //
        // Pushing the second half of the local queue to the injection queue is better because when
        // we take tasks *out* of the injection queue, we always place them in the first half. This
        // means that if a task is in the second half, then we know for sure that this task is not
        // a task we just got from the injection queue. This ensures that when we take a task out
        // of the injection queue, then it will not be moved back into the injection queue (at
        // least not until after we have polled it at least once).
        self.inner
            .tail
            .store(tail.wrapping_add(NUM_TASKS_TAKEN), Release);
```

**この長いコメントが、このページの核心だ。**

グローバルキューから取り戻したタスクは、必ずローカルキューの **前半** に置かれる (後述)。だから溢れで出すのを **後半** に限れば、「グローバルから取ってきたばかりのタスクを、そのままグローバルに送り返す」が起こらない。

送り返しが起きると何が悪いか。そのタスクは **一度も poll されずに** グローバルキューを往復する。往復のたびにロックを取るので、負荷が高いときほど無駄が増える。最悪の場合、タスクがキューの間を行き来し続けて前に進まない。

実装が「後半を取る」ではなく「全部確保して前半を返す」になっているのも、この動機から来ている。`head` を半分だけ進めると **前半** が取れてしまうので、逆にはできない。

そして、この操作の副作用も明記されている。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
        // Note that if a concurrent worker tries to steal from us between these two operations and
        // sees that the worker queue is empty, then that worker may go to sleep, and we do not
        // notify it about these tasks becoming available for stealing again. Ordinarily this would
        // be a problem, but it isn't in this case because the worker will be notified about the
        // tasks we are adding to the injection queue instead, which ensures that the stealer wakes
        // up again to take the tasks from the injection queue.
```

2 回のストアの間、キューは空に見える。その瞬間に盗みに来たワーカーは「何もない」と判断して寝てしまうかもしれない。**普通ならこれは取りこぼしだが、この場合はグローバルキューへの push が別途通知を出すので回収される。**

「一時的に不整合な状態が見えるが、別経路の通知で救われる」という論証が、コードのそばに残っている。

### グローバルキューは、長さだけ外に出す

[`scheduler/inject.rs#L21-L36`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/inject.rs#L21-L36)。

```rust title="tokio/src/runtime/scheduler/inject.rs"
/// Growable, MPMC queue used to inject new tasks into the scheduler and as an
/// overflow queue when the local, fixed-size, array queue overflows.
pub(crate) struct Inject<T: 'static> {
    shared: Shared<T>,
    synced: Mutex<Synced>,
}
```

**構造体が「ロックの外にあるもの」と「中にあるもの」に分かれている。**

```rust title="tokio/src/runtime/scheduler/inject/shared.rs"
pub(crate) struct Shared<T: 'static> {
    /// Number of pending tasks in the queue. This helps prevent unnecessary
    /// locking in the hot path.
    pub(super) len: AtomicUsize,
```

```rust title="tokio/src/runtime/scheduler/inject/synced.rs"
pub(crate) struct Synced {
    /// True if the queue is closed.
    pub(super) is_closed: bool,

    /// Linked-list head.
    pub(super) head: Option<task::RawTask>,

    /// Linked-list tail.
    pub(super) tail: Option<task::RawTask>,
}
```

ロックフリーな MPMC キューを書く代わりに、**普通の連結リストをミューテックスで守り、長さだけをアトミック変数として外に出す**。

効くのは `pop` の入口だ ([`inject.rs#L61-L69`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/inject.rs#L61-L69))。

```rust title="tokio/src/runtime/scheduler/inject.rs"
    pub(crate) fn pop(&self) -> Option<task::Notified<T>> {
        if self.shared.is_empty() {
            return None;
        }

        let mut synced = self.synced.lock();
        // safety: passing correct `Synced`
        unsafe { self.shared.pop(&mut synced) }
    }
```

**グローバルキューが空のときは、ロックを取らずに帰れる。** ワーカーは仕事を探すたびにここを見にくるので、この分岐がなければ全ワーカーが 1 個のミューテックスに殺到する。そして通常運転では、グローバルキューはほとんどの時間空だ。

ロックを取った後の `len` の更新も、ひと工夫ある。

```rust title="tokio/src/runtime/scheduler/inject/shared.rs"
        // safety: only mutated with the lock held
        let len = unsafe { self.len.unsync_load() };
```

**書き込みが必ずロックの中で起きるので、読むときもロックの中なら非アトミックでよい。** 前ページの `tail` と同じ発想で、「排他が別の手段で保証されているなら、アトミック操作の代金を払わない」。

リストが侵入型なのも同じ方針の延長だ。連結ポインタはタスクの `Header` の `queue_next` を使う。**グローバルキューが伸びても、ノードの確保は 0 回。**

### 一括投入は、リンクしてからロックを取る

[`inject/rt_multi_thread.rs#L29-L63`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/inject/rt_multi_thread.rs#L29-L63)。

```rust title="tokio/src/runtime/scheduler/inject/rt_multi_thread.rs"
        // Link up all the tasks.
        let mut prev = first;
        let mut counter = 1;

        // We are going to be called with an `std::iter::Chain`, and that
        // iterator overrides `for_each` to something that is easier for the
        // compiler to optimize than a loop.
        iter.for_each(|next| {
            let next = next.into_raw();

            // safety: Holding the Notified for a task guarantees exclusive
            // access to the `queue_next` field.
            unsafe { prev.set_queue_next(Some(next)) };
            prev = next;
            counter += 1;
        });

        // Now that the tasks are linked together, insert them into the
        // linked list.
        unsafe {
            self.push_batch_inner(shared, first, prev, counter);
        }
```

**129 個のタスクを先に 1 本の鎖に繋いでから、ロックを取って鎖ごと連結する。** ロックを保持する時間が、要素数によらず一定になる。

ロックを取ってから 1 個ずつ繋ぐと、その間ずっと他のワーカーが `pop` できない。**「ロックの外でできる準備は、全部外でやる」** の教科書的な例だ。

`for_each` を使う理由まで書いてある。`Chain` は `for_each` を特殊化していて、`while let Some(x) = iter.next()` より最適化されやすい。呼び出し側が `batch_iter.chain(std::iter::once(task))` を渡すことを見越したコメントだ。

閉じているときの処理も見ておきたい。

```rust title="tokio/src/runtime/scheduler/inject/rt_multi_thread.rs"
        if synced.as_mut().is_closed {
            drop(synced);

            let mut curr = Some(batch_head);

            while let Some(task) = curr {
                curr = unsafe { task.get_queue_next() };

                let _ = unsafe { task::Notified::<T>::from_raw(task) };
            }

            return;
        }
```

**ロックを先に落としてから、鎖を辿って 1 個ずつ捨てる。** タスクの `Drop` は参照カウントを落とし、場合によっては future の破棄まで走る。それをロックの中でやると、他のワーカーを長時間止めることになる。

### 取り戻すときは、前半に置き、全部は取らない

[`multi_thread/worker.rs#L1087-L1156`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L1087-L1156)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
            let cap = usize::min(
                // Other threads can only **remove** tasks from the current
                // worker's `run_queue`. So, we can be confident that by the
                // time we call `run_queue.push_back` below, there will be *at
                // least* `cap` available slots in the queue.
                self.run_queue.remaining_slots(),
                // We want to make sure that all of the tasks we take end up in
                // the first half of the local queue. This ensures that the
                // tasks do not get pushed to the inject queue again if overflow
                // occurs, as overflow only affects tasks in the second half of
                // the local queue.
                self.run_queue.max_capacity() / 2,
            );
```

**ここが「後半を出す」の対になっている。** 一度に取り戻す量を容量の半分までに制限することで、取ってきたタスクは必ず前半に入る。

そして取る個数の決め方。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
            // The worker is currently idle, pull a batch of work from the
            // injection queue. We don't want to pull *all* the work so other
            // workers can also get some.
            let n = usize::min(
                worker.inject().len() / worker.handle.shared.remotes.len() + 1,
                cap,
            );
```

**グローバルキューの長さをワーカー数で割る。** 自分の取り分だけ取って、残りは他のワーカーに残す。全部取ると、そのワーカーだけが忙しくなり、他は寝たまま起きる理由を失う。

`+1` は、割り算が 0 になる場合の下駄だ。さらに `usize::max(1, n)` で最低 1 個は保証される。**先頭の 1 個はキューに積まずに直接返す** ので、0 個だと呼び出しが無意味になる。

### グローバルキューを見にいく間隔は、自動で調整される

`next_task` の冒頭 ([`#L1088-L1097`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L1088-L1097))。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    fn next_task(&mut self, worker: &Worker) -> Option<Notified> {
        if self.tick % self.global_queue_interval == 0 {
            // Update the global queue interval, if needed
            self.tune_global_queue_interval(worker);

            worker
                .handle
                .next_remote_task()
                .or_else(|| self.next_local_task())
        } else {
```

**N 回に 1 回、ローカルより先にグローバルキューを見る。** これがないと、ローカルキューにタスクが供給され続ける限りグローバルキューが枯れない (飢餓)。

この `N` が固定値ではなく、**タスク 1 回の poll にかかる時間から逆算される** ([`multi_thread/stats.rs#L30-L68`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/stats.rs#L30-L68))。

```rust title="tokio/src/runtime/scheduler/multi_thread/stats.rs"
/// How to weigh each individual poll time, value is plucked from thin air.
const TASK_POLL_TIME_EWMA_ALPHA: f64 = 0.1;

/// Ideally, we wouldn't go above this, value is plucked from thin air.
const TARGET_GLOBAL_QUEUE_INTERVAL: f64 = Duration::from_micros(200).as_nanos() as f64;

/// Max value for the global queue interval. This is 2x the previous default
const MAX_TASKS_POLLED_PER_GLOBAL_QUEUE_INTERVAL: u32 = 127;

/// This is the previous default
const TARGET_TASKS_POLLED_PER_GLOBAL_QUEUE_INTERVAL: u32 = 61;
```

```rust title="tokio/src/runtime/scheduler/multi_thread/stats.rs"
    pub(crate) fn tuned_global_queue_interval(&self, config: &Config) -> u32 {
        // If an interval is explicitly set, don't tune.
        if let Some(configured) = config.global_queue_interval {
            return configured;
        }

        // As of Rust 1.45, casts from f64 -> u32 are saturating, which is fine here.
        let tasks_per_interval = (TARGET_GLOBAL_QUEUE_INTERVAL / self.task_poll_time_ewma) as u32;

        // If we are using self-tuning, we don't want to return less than 2 as that would result in the
        // global queue always getting checked first.
        tasks_per_interval.clamp(2, MAX_TASKS_POLLED_PER_GLOBAL_QUEUE_INTERVAL)
    }
```

**「N 回ごと」ではなく「200 マイクロ秒ごと」を目標にしている。** タスクの poll が速ければ N は大きくなり、遅ければ小さくなる。制御されているのは回数ではなく **時間** だ。

poll 時間の推定は指数移動平均で、更新式が丁寧に書かれている ([`#L93-L115`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/stats.rs#L93-L115))。

```rust title="tokio/src/runtime/scheduler/multi_thread/stats.rs"
            // Calculate the mean poll duration for a single task in the batch
            let mean_poll_duration = elapsed / num_polls;

            // Compute the alpha weighted by the number of tasks polled this batch.
            let weighted_alpha = 1.0 - (1.0 - TASK_POLL_TIME_EWMA_ALPHA).powf(num_polls);

            // Now compute the new weighted average task poll time.
            self.task_poll_time_ewma = weighted_alpha * mean_poll_duration
                + (1.0 - weighted_alpha) * self.task_poll_time_ewma;
```

**時刻の取得はバッチの前後 2 回だけで、タスクごとには測らない。** `Instant::now()` はタダではないので、100 個 poll するごとに 2 回で済ませて、平均を取る。

そのぶん α をバッチのサイズで補正する。1 回ずつ 100 回更新したのと同じ重みになるように `1 - (1-α)^n` を使う。**サンプリングを間引いた分を、重みの計算で埋め合わせている。**

定数のコメントが揃って「値は何もないところから引っ張ってきた (plucked from thin air)」なのも正直で良い。**根拠がないことを明記してあるので、測定して変える余地があると分かる。**

## なぜそうなっているか

- **溢れたぶんを一括で移すのは、償却コストを下げるため。** 1 個ずつだと満杯状態が続き、以降の push が毎回グローバルキューのロックを取ることになる。半分空ければ、次の 128 回は移動が起きない。
- **後半を出すのは、グローバルから取り戻したタスクが前半に入るから。** この対応が崩れると、取り出したばかりのタスクが一度も poll されずに押し戻される。往復のたびにロックを取るので、混んでいるときほど損をする。
- **盗まれている最中は一括移動をしないのは、もうすぐ容量が空くから。** 大掛かりな処理を始める前に、「待てば解決するか」を既存の状態から判定している。
- **グローバルキューをロックフリーにしなかったのは、ホットパスではないから。** ワーカーは基本的にローカルキューで回る。グローバルキューを触るのは、溢れたとき・外から投入されたとき・N 回に 1 回の巡回。ロックフリー MPMC の複雑さに見合わない。
- **長さだけアトミック変数に出したのは、「空かどうか」がホットパスだから。** ワーカーは仕事を探すたびに見にくる。ロックを取る前に空と分かれば、全ワーカーが 1 個のミューテックスに集まるのを避けられる。
- **一括投入でリンクを先に作るのは、ロック保持時間を要素数から切り離すため。** ロックの中の仕事を O(1) にできるなら、そうする。閉じているときにロックを落としてから破棄するのも同じ理由で、`Drop` はユーザーコードを呼びうる。
- **グローバルキューの巡回間隔を時間で決めているのは、タスクの重さが場合によって桁違いだから。** 「61 回ごと」だと、1 回 1 マイクロ秒のタスクと 1 ミリ秒のタスクで、グローバルキューの待ち時間が 1000 倍変わる。時間を基準にすれば、そこが揃う。

## どう活かすか

- **固定長のバッファが溢れたときは、1 個ずつではなく一括で退避する。** 溢れる状況は続くことが多いので、1 個ずつ逃がすと退避処理が毎回走る。半分空ければ、次の退避まで十分な余裕ができる。
- **2 つの入れ物の間で要素が往復しないよう、出す場所と入れる場所をずらす。** 「出すのは後半、入れるのは前半」のような不変条件を作れば、往復が構造的に起こらなくなる。この種の対応関係は、両方のコードにコメントを書かないと片方の変更で壊れる。
- **ロックの前に、ロックなしで答えが出る場合を弾く。** 「空なら何もしない」が高頻度なら、その判定だけを外に出す価値がある。中身の整合はロックが守り、外の変数は「取りに行く価値があるか」の目安として使う。
- **ロックの中の仕事量を、要素数に依存させない。** 一括投入なら、連結はロックの外で済ませて、ロックの中は繋ぎ替えだけにする。破棄のようにユーザーコードが走りうる処理は、必ずロックを落としてからやる。
- **「N 回ごと」より「T 時間ごと」を考える。** 回数を基準にすると、1 回あたりの重さが変わったときに挙動が変わる。時間を目標にして回数を逆算すれば、重さの違いを吸収できる。
- **測定のコストが高いときは、間引いて重みで補正する。** バッチの前後だけ時刻を取り、平均を EWMA に入れるときに `1 - (1-α)^n` で補正する。全件測定と同じ重みが、2 回の計測で得られる。
- **根拠のない定数には「根拠がない」と書く。** 「thin air」と書いてあれば、測定して変えてよいと分かる。もっともらしい説明を捏造するより、後から直しやすい。
