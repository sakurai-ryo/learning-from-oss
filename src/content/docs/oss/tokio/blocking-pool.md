---
title: "ブロッキング用のスレッドは、空きがないときだけ作り、10 秒暇なら消える"
description: "spawn_blocking のプールは、事前にスレッドを立てない。キューに積むときに待機中のスレッドが 0 なら 1 本だけ増やす。逆に 10 秒仕事がなければ、そのスレッドは自分で退場する。条件変数の空振り起床と本物の通知を数えるカウンタ、シャットダウン時にも必ず実行される「必須タスク」、そして OS がスレッド生成を一時的に拒んだときの扱いが、それぞれ具体的な事故に対応している。"
sidebar:
  order: 13
---

## 何を学んだか

### どんな状況の話か

`spawn_blocking` は、ブロックする処理を専用のスレッドプールに逃がす。

```rust
let contents = tokio::task::spawn_blocking(|| std::fs::read_to_string("f.txt")).await?;
```

このプールに要求されることは、非同期のワーカープールとかなり違う。

- **同時実行数が CPU コア数と無関係。** 100 個のファイル読み込みを並行させたいなら、100 本のスレッドが要る。ブロックしている間 CPU は使わないので、コア数に制限する意味がない。
- **どれくらい必要かが事前に分からない。** 起動時に 512 本立てるのは論外 (スタックだけで数 GB)。かといって「必要になってから 1 本ずつ」だと、毎回スレッド生成のコストが乗る。
- **アイドル時間が長い。** バッチ処理のピークで 200 本使い、その後 1 時間何もしない、という使い方が普通にある。

### Tokio の答え

**遅延生成 + アイドルタイムアウト。**

- **キューに積むときに待機中のスレッドが 0 本なら、1 本だけ作る。** 待機中がいれば、起こすだけ。
- **10 秒間仕事が来なければ、そのスレッドは自分で終了する。** ピークの後、プールは自然に縮む。
- **上限は既定で 512 本** (`max_blocking_threads`)。マルチスレッドランタイムでは、これに **非同期ワーカーの本数が足される**。[前ページ](../block-in-place/) で見たとおり、ワーカースレッド自体がこのプールから供給されるからだ。

シンプルな方針だが、実装には「実際に踏んだ事故」の跡が複数残っている。

## ソースコードのどこか

### 積むときに、必要なら 1 本だけ増やす

[`runtime/blocking/pool.rs#L592-L628`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/blocking/pool.rs#L592-L628)。

```rust title="tokio/src/runtime/blocking/pool.rs"
        let mut locked = self.mutex.lock();

        if locked.thread_mgmt_state.shutdown {
            // Shutdown the task: it's fine to shutdown this task
            // (even if mandatory) because it was scheduled after the
            // shutdown of the runtime began.
            task.task.shutdown();
            return Err(SpawnError::ShuttingDown);
        }

        locked.queue.push_back(task);
        metrics.inc_queue_depth();

        if metrics.num_idle_threads() == 0 {
            on_no_idle(&mut locked.thread_mgmt_state)?;
        } else {
            // Notify an idle worker thread. The notification counter
            // is used to count the needed amount of notifications
            // exactly. Thread libraries may generate spurious
            // wakeups, this counter is used to keep us in a
            // consistent state.
            metrics.dec_num_idle_threads();
            locked.num_notify += 1;
            self.condvar.notify_one();
        }
```

**待機中が 0 のときだけスレッドを増やす。** それ以外は起こすだけで、1 本も増えない。仕事が途切れなければ、プールは「同時にブロックしている数」にちょうど収束する。

`num_notify` カウンタは、条件変数の **空振り起床 (spurious wakeup)** への対処だ。pthread の条件変数は、誰も `notify` していないのにスレッドが起きることがある。起きた側は「自分は起こされたのか、勝手に起きたのか」を判定できない。

**だから「起こした回数」を明示的に数える。** 起きた側は、カウンタが 0 でなければ本物、0 なら空振りと判断できる。

さらに、`num_idle_threads` を **起こす側が減らしている** ところが目を引く。起きた側で減らすほうが自然に見えるが、そうすると「起こしたが、まだ起きていない」間に待機中が多く見えて、次の `spawn_task` がスレッドを増やさずに済ませてしまう。**通知を出した時点で、その 1 本はもう待機中ではない。**

起きた側は、その事情を知ったうえで自分の記帳を合わせる。

```rust title="tokio/src/runtime/blocking/pool.rs"
                if locked.num_notify != 0 {
                    // We have received a legitimate wakeup,
                    // acknowledge it by decrementing the counter
                    // and transition to the BUSY state.
                    locked.num_notify -= 1;
                    // since this is a legitimate wakeup,
                    // the `Spawner::spawn_task` has already
                    // decremented `num_idle_threads`.
                    is_counted_idle = false;
                    break;
                }
```

**`is_counted_idle` というローカル変数が、「今の自分は `num_idle_threads` に数えられているか」を追跡している。** 減らす担当が場合によって変わるので、二重に減らさないための記帳だ。

そして退場時に検算する。

```rust title="tokio/src/runtime/blocking/pool.rs"
        if is_counted_idle {
            // `num_idle_threads` should now be tracked exactly,
            // panic with a descriptive message if it is not the
            // case.
            let prev_idle = metrics.dec_num_idle_threads();
            assert_ne!(
                prev_idle, 0,
                "`num_idle_threads` underflowed on thread exit"
            );
        }
```

**「正確に追跡できているはずなので、そうでなければメッセージ付きで落とす」。** カウンタのずれは、そのまま「必要なのにスレッドが増えない」というハングになる。原因の分かるパニックにしておくほうがましだ。

### 10 秒で消える

[`#L642-L700`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/blocking/pool.rs#L642-L700)。

```rust title="tokio/src/runtime/blocking/pool.rs"
        'main: loop {
            // BUSY
            while let Some(task) = locked.queue.pop_front() {
                metrics.dec_queue_depth();
                drop(locked);
                task.run();

                locked = self.mutex.lock();
            }

            // IDLE
            metrics.inc_num_idle_threads();
```

BUSY と IDLE の 2 状態が、コメントで明示されている。BUSY の間はキューが空になるまで回り続け、**タスクを走らせる前に必ずロックを落とす**。ブロッキング処理は数秒かかりうるので、ロックを握ったままでは全体が止まる。

IDLE では条件変数で待つ。

```rust title="tokio/src/runtime/blocking/pool.rs"
                // Even if the condvar "timed out", if the pool is
                // entering the shutdown phase, we want to perform
                // the cleanup logic.
                if !locked.thread_mgmt_state.shutdown && timeout_result.timed_out() {
                    join_on_thread = locked.thread_mgmt_state.worker_timed_out(worker_thread_id);

                    break 'main;
                }

                // Spurious wakeup detected, go back to sleep.
```

`keep_alive` (既定 10 秒) でタイムアウトしたら退場する。ただし **シャットダウン中なら、タイムアウトしていても掃除の処理に進む**。「タイムアウトした」と「シャットダウンが始まった」が同時に起こりうるので、優先順位を決めている。

### 退場したスレッドは、次に退場するスレッドが片付ける

タイムアウト時の記帳が変わっている ([`#L165-L175`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/blocking/pool.rs#L165-L175))。

```rust title="tokio/src/runtime/blocking/pool.rs"
    /// Prior to shutdown, we clean up `JoinHandles` by having each timed-out
    /// thread join on the previous timed-out thread. This is not strictly
    /// necessary but helps avoid Valgrind false positives, see
    /// <https://github.com/tokio-rs/tokio/commit/646fbae76535e397ef79dbcaacb945d4c829f666>
    /// for more information.
    pub(super) last_exiting_thread: Option<thread::JoinHandle<()>>,
```

```rust title="tokio/src/runtime/blocking/pool.rs"
    pub(super) fn worker_timed_out(
        &mut self,
        worker_thread_id: usize,
    ) -> Option<thread::JoinHandle<()>> {
        let my_handle = self.worker_threads.remove(&worker_thread_id);
        std::mem::replace(&mut self.last_exiting_thread, my_handle)
    }
```

**退場するスレッドが、「1 つ前に退場したスレッド」の `JoinHandle` を引き取って `join` する。** 自分の `JoinHandle` は次に退場する誰かのために置いていく。バケツリレーだ。

`join` しないと、スレッドの資源が回収されない (detach された状態になる)。かといって、退場するスレッド自身が自分を `join` することはできない。**「誰が回収するか」を、次に来る同じ立場の者に押し付けることで解決している。**

そして理由が正直だ。**「厳密には必要ないが、Valgrind の偽陽性を避けるのに役立つ」。** 実際の資源リークではなく、検査ツールが「終了していないスレッドがある」と報告するのを防ぐためだ。commit のハッシュまで貼ってある。

**「これは本質的な問題ではない」と書いてあるのが重要で、** そうでないと次の人が「重要な同期だ」と誤解して、周辺の変更をためらう。

### シャットダウン中でも走らせなければならないタスクがある

[`#L178-L228`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/blocking/pool.rs#L178-L228)。

```rust title="tokio/src/runtime/blocking/pool.rs"
pub(crate) struct Task {
    task: task::UnownedTask<BlockingSchedule>,
    mandatory: Mandatory,
}

#[derive(PartialEq, Eq)]
pub(crate) enum Mandatory {
    #[cfg_attr(not(feature = "fs"), allow(dead_code))]
    Mandatory,
    NonMandatory,
}
```

```rust title="tokio/src/runtime/blocking/pool.rs"
    pub(super) fn shutdown_or_run_if_mandatory(self) {
        match self.mandatory {
            Mandatory::NonMandatory => self.task.shutdown(),
            Mandatory::Mandatory => self.task.run(),
        }
    }
```

シャットダウン時、キューに残ったタスクは通常キャンセルされる。**だが `Mandatory` のものは、シャットダウン中でも実行される。**

`Mandatory` が付くのは `spawn_mandatory_blocking` から入ったタスクだけで、これを使っているのは `fs` モジュールだ。ファイルの書き込みやクローズを **途中で捨てると、データが失われるかファイルディスクリプタが漏れる**。「ランタイムを落とすので、この `write(2)` はやめます」は許されない。

対して、ユーザーが `spawn_blocking` で投げた計算は捨ててよい。**「捨ててよい仕事」と「捨ててはいけない仕事」が型で区別されている。**

ただし、**シャットダウンが始まった後に投げられたものは、`Mandatory` でも捨てる**。

```rust title="tokio/src/runtime/blocking/pool.rs"
        if locked.thread_mgmt_state.shutdown {
            // Shutdown the task: it's fine to shutdown this task
            // (even if mandatory) because it was scheduled after the
            // shutdown of the runtime began.
            task.task.shutdown();
            return Err(SpawnError::ShuttingDown);
        }
```

**線引きが「シャットダウン開始より前に受け付けたか」に置かれている。** 受け付けたものは最後までやる、受け付けていないものはやらない。この基準がないと、シャットダウンが終わらない。

### OS がスレッドを作れないとき

[`#L467-L490`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/blocking/pool.rs#L467-L490)。

```rust title="tokio/src/runtime/blocking/pool.rs"
                    match self.spawn_thread(shutdown_tx, rt, id) {
                        Ok(handle) => {
                            self.inner.metrics.inc_num_threads();
                            thread_mgmt_state.worker_thread_index += 1;
                            thread_mgmt_state.worker_threads.insert(id, handle);
                        }
                        Err(ref e)
                            if is_temporary_os_thread_error(e)
                                && self.inner.metrics.num_threads() > 0 =>
                        {
                            // OS temporarily failed to spawn a new thread.
                            // The task will be picked up eventually by a currently
                            // busy thread.
                        }
                        Err(e) => {
                            // The OS refused to spawn the thread and there is no thread
                            // to pick up the task that has just been pushed to the queue.
                            return Err(SpawnError::NoThreads(e));
                        }
                    }
```

**判断が「一時的なエラーか」と「既存のスレッドが 1 本でもあるか」の 2 条件になっている。**

- 一時的なエラー (`WouldBlock`) で、かつ既存のスレッドがいる → **無視してよい。** キューには積んであるので、今忙しいスレッドが手が空いたときに拾う。
- それ以外 → **エラーを返す。** 誰も拾えないタスクをキューに残すことになるので、呼び出し側に伝えるしかない。

`is_temporary_os_thread_error` は `WouldBlock` だけを見る。**「今は無理だが後なら可能」と「構造的に無理」を区別している。**

このエラーは `spawn_blocking` の戻り値には現れず、タスクが即座にキャンセル扱いになる形で `JoinHandle` に伝わる。`fs` 側は `spawn_mandatory_blocking` の `Option` として受け取り、失敗を `io::Error` に変換する。

### 実装を差し替えられる形にしてある

[`#L103-L107`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/blocking/pool.rs#L103-L107)。

```rust title="tokio/src/runtime/blocking/pool.rs"
/// Per-variant queue + notification + lock topology.
enum InnerImpl {
    Locked(LockedImpl),
    Sharded(ShardedImpl),
}
```

キューと通知の実装が enum で切り替わる。単一ミューテックス版と、シャード版だ。

そして、この分割の意図がコメントに残っている。

```rust title="tokio/src/runtime/blocking/pool.rs"
// This is the original, single-lock implementation of the `spawn_blocking`
// queue. Method scope was principally designed around ensuring that when the
// code was refactored to enable adding a sharded queue implementation, this
// was self-evidently behaviorally identical to the original implementation.
impl LockedImpl {
```

**「メソッドの切り方は、リファクタリング後も元の実装と挙動が同一であることが自明になるように決めた」。**

新しい実装を足すためのリファクタリングで、既存の挙動を変えていないことをどう示すか。ここでは **「クリティカルセクション全体を 1 メソッドに閉じ込める」** ことで、ロックの取得から解放までが元のコードと 1 対 1 に対応するようにしている。

`InnerImpl` 側のコメントも同じことを言っている。「各バリアントのメソッドが自分の操作のクリティカルセクション全体を所有するので、`Locked` の挙動がリファクタリング前と同一であることが自明になり、将来の実装にも対称な受け皿を与える」。

**リファクタリングの正しさを、レビューしやすさとして設計している。**

## なぜそうなっているか

- **スレッドを遅延生成するのは、必要数が事前に分からないから。** ブロッキングの同時実行数はワークロード次第で、コア数とは無関係。事前確保は無駄が大きく、上限も推測でしかない。
- **待機中が 0 のときだけ増やすのは、これが「足りない」の必要十分条件だから。** 待機中がいるなら起こせば済む。この判定だけで、プールは自然に必要数へ収束する。
- **アイドルタイムアウトがあるのは、ピークが過ぎた後にスレッドを抱えたままにしないため。** 10 秒は「またすぐ来るかもしれない」を吸収する程度の長さで、設定で変えられる。
- **`num_notify` を数えるのは、条件変数が空振りするから。** 「起きた = 起こされた」は成り立たない。カウンタがないと、空振りで起きたスレッドが「仕事がある」と誤認して記帳を狂わせる。
- **`num_idle_threads` を起こす側が減らすのは、通知から起床までの間があるから。** その間「待機中」と数えていると、次の spawn がスレッドを増やさずに済ませてしまい、誰も拾えないタスクが積み上がる。
- **退場スレッドがバケツリレーで `join` するのは、自分で自分を `join` できないから。** 実害はほぼないが、検査ツールの偽陽性を消すために入っている。「必須ではない」と明記してある。
- **必須タスクの区別があるのは、ファイル操作を途中で捨てられないから。** 書き込みの喪失やディスクリプタの漏れが起きる。ただし線引きは「シャットダウン開始前に受け付けたか」で、そうしないとシャットダウンが終わらない。
- **スレッド生成の失敗を 2 種類に分けるのは、回復可能性が違うから。** 一時的な失敗は、既存のスレッドがいれば時間が解決する。恒久的な失敗や、そもそもスレッドが 0 本の場合は、タスクが永久に実行されないので呼び出し側に伝えるしかない。

## どう活かすか

- **可変長のワーカープールは、「待機中が 0 か」だけで増やす判断ができる。** 負荷率やキュー長のしきい値を持ち込む前に、この単純な条件で足りないか考える。必要数への収束が自然に起きる。
- **アイドルタイムアウトで縮ませる。** 増やす仕組みだけ入れて縮む仕組みを忘れると、プールはピーク時のサイズのまま張り付く。
- **条件変数を使うなら、「通知した回数」を自分で数える。** 空振り起床は必ず起きる。カウンタがあれば「本物か」を判定でき、記帳のずれが防げる。
- **カウンタを減らす担当が場合によって変わるなら、ローカル変数で自分の状態を追う。** 「自分は今カウントされているか」を持ち回り、退場時に検算する。ずれはハングとして現れるので、パニックで早期に知らせるほうがよい。
- **捨ててよい仕事と、捨ててはいけない仕事を型で区別する。** シャットダウン時の扱いを実行時のフラグや呼び出し側の配慮に任せると、必ずどこかで取りこぼす。そして「いつ受け付けたか」で線を引かないと、シャットダウンが終わらなくなる。
- **失敗を「一時的」と「恒久的」に分け、前者は無視できる条件を明示する。** 「後で誰かが拾う」が成り立つなら無視してよい。成り立つ条件 (ここでは「スレッドが 1 本以上ある」) を式に書いておく。
- **実装を差し替えられるようにリファクタリングするときは、「挙動が同一であることが自明」になるようにメソッドを切る。** クリティカルセクション全体を 1 メソッドに収めれば、ロックの範囲が元のコードと 1 対 1 で対応する。その意図をコメントに残せば、レビューの観点も伝わる。
