---
title: "直前に起こしたタスクを優先して局所性を稼ぎ、それが生む飢餓を 3 回で打ち切る"
description: "ワーカーは実行キューとは別に、タスクを 1 個だけ置く特別なスロットを持つ。タスクが他のタスクを起こしたら、そのタスクは次に走る。メッセージを送ってすぐ返事を待つ形のコードでは、これがキャッシュにも遅延にも効く。ただし 2 つのタスクが互いを起こし続けると他が走れなくなるので、連続 3 回で打ち切る。局所性の最適化に必ず打ち切り条件が付いている、という設計がここに出ている。"
sidebar:
  order: 9
---

## 何を学んだか

### どんな状況の話か

非同期のコードで最も多い形の 1 つが、**タスク間のメッセージ往復** だ。

```rust
// タスク A
tx.send(request).await;
let response = rx.recv().await;
```

A が送ると B が起きる。B が返すと A が起きる。この往復が延々と続く。

素直な work-stealing スケジューラでは、こうなる。

1. A が走り、B を起こす。B はワーカーのローカルキューの **末尾** に積まれる。
2. A が `Pending` を返す。
3. ワーカーはキューの **先頭** から次のタスクを取る。B の前には、キューにいた 200 個のタスクが並んでいる。
4. 200 個を処理し終えて、ようやく B が走る。

**A が送ったメッセージのデータは、その頃にはキャッシュから消えている。** そして A が返事を受け取れるのは、さらにその先だ。往復のたびにキュー 1 周分の遅延が乗る。

### Tokio の答え

**実行キューとは別に、タスクを 1 個だけ置くスロットを用意する。**

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    /// When a task is scheduled from a worker, it is stored in this slot. The
    /// worker will check this slot for a task **before** checking the run
    /// queue. This effectively results in the **last** scheduled task to be run
    /// next (LIFO). This is an optimization for improving locality which
    /// benefits message passing patterns and helps to reduce latency.
    lifo_slot: Option<Notified>,
```

タスクの中から `wake()` されたタスクは、キューの末尾ではなくこのスロットに入る。そして **今のタスクの poll が終わったら、すぐにそれを走らせる**。

キャッシュはまだ温かい。遅延はキュー 1 周ではなく 0 になる。

ただし、この最適化には明確な副作用がある。**A と B が互いを起こし続けると、この 2 つだけが走り続けて、キューの中の他のタスクが一切走らない。** だから Tokio は、この優先を **連続 3 回で打ち切る**。

## ソースコードのどこか

### スロットへの出し入れ

[`multi_thread/worker.rs#L1385-L1416`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L1385-L1416)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    fn schedule_local(&self, core: &mut Core, task: Notified, is_yield: bool) {
        core.stats.inc_local_schedule_count();

        // Spawning from the worker thread. If scheduling a "yield" then the
        // task must always be pushed to the back of the queue, enabling other
        // tasks to be executed. If **not** a yield, then there is more
        // flexibility and the task may go to the front of the queue.
        let should_notify = if is_yield || !core.lifo_enabled {
            core.run_queue
                .push_back_or_overflow(task, self, &mut core.stats);
            true
        } else {
            // Push to the LIFO slot
            let prev = core.lifo_slot.take();
            let ret = prev.is_some();

            if let Some(prev) = prev {
                core.run_queue
                    .push_back_or_overflow(prev, self, &mut core.stats);
            }

            core.lifo_slot = Some(task);

            ret
        };
```

**`yield_now()` は必ずキューの末尾に行く。** これは重要で、`yield_now()` の意味は「他のタスクに順番を譲る」だからだ。LIFO スロットに入れたら、譲ったつもりで自分がすぐ再開してしまう。

スロットが埋まっていたら、前の住人をキューの末尾に押し出して、自分が入る。**常に「最後に起こされたタスク」が入っている。**

返り値の `should_notify` も面白い。LIFO スロットに入れた場合、**前の住人を追い出したときだけ true** になる。

理由は、LIFO スロットのタスクは他のワーカーから盗めないからだ。スロットに入れただけでは、他のワーカーが手伝える仕事は増えていない。**押し出された 1 個がキューに入って初めて、盗める仕事が増える。** だから通知もそのときだけでよい。

### 走らせ続けるループ

[`#L706-L791`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L706-L791)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
            let mut lifo_polls = 0;

            // As long as there is budget remaining and a task exists in the
            // `lifo_slot`, then keep running.
            loop {
                // Check if we still have the core. If not, the core was stolen
                // by another worker.
                let mut core = match self.core.borrow_mut().take() {
                    Some(core) => core,
                    None => {
                        return Err(());
                    }
                };

                // Check for a task in the LIFO slot
                let task = match core.lifo_slot.take() {
                    Some(task) => task,
                    None => {
                        self.reset_lifo_enabled(&mut core);
                        core.stats.end_poll();
                        return Ok(core);
                    }
                };
```

1 個のタスクを走らせたら、そのタスクが誰かを起こしていないか見る。起こしていれば続けて走らせる。**キューにも戻らず、スケジューラの他の判断も経由しない。**

停止条件が 3 つある。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
                if !coop::has_budget_remaining() {
                    core.stats.end_poll();

                    // Not enough budget left to run the LIFO task, push it to
                    // the back of the queue and return.
                    core.run_queue.push_back_or_overflow(
                        task,
                        &*self.worker.handle,
                        &mut core.stats,
                    );
                    // If we hit this point, the LIFO slot should be enabled.
                    // There is no need to reset it.
                    debug_assert!(core.lifo_enabled);
                    return Ok(core);
                }
```

1 つ目は **協調予算** ([後のページ](../coop-budget/))。この LIFO の連鎖は 1 回の `coop::budget(...)` の中で回っているので、予算は全体で共有される。予算が尽きたら、スロットのタスクをキューに戻して抜ける。

2 つ目は **コアを取られた場合**。`block_in_place` ([該当ページ](../block-in-place/)) が起きると、このワーカーのコアは別のスレッドに渡る。`self.core.borrow_mut().take()` が `None` を返したら、もうこのスレッドはスケジューラの仕事をしていない。

そして 3 つ目が、このページの主題だ。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
                // Disable the LIFO slot if we reach our limit
                //
                // In ping-ping style workloads where task A notifies task B,
                // which notifies task A again, continuously prioritizing the
                // LIFO slot can cause starvation as these two tasks will
                // repeatedly schedule the other. To mitigate this, we limit the
                // number of times the LIFO slot is prioritized.
                if lifo_polls >= MAX_LIFO_POLLS_PER_TICK {
                    core.lifo_enabled = false;
                    super::counters::inc_lifo_capped();
                }
```

**`lifo_enabled` を false にする。** 以降このワーカーで起こされたタスクは、スロットではなくキューの末尾に行く。連鎖が自然に途切れる。

上限値の定義がこれだ ([`#L266-L270`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L266-L270))。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
/// Value picked out of thin-air. Running the LIFO slot a handful of times
/// seems sufficient to benefit from locality. More than 3 times probably is
/// over-weighting. The value can be tuned in the future with data that shows
/// improvements.
const MAX_LIFO_POLLS_PER_TICK: usize = 3;
```

**「何もないところから選んだ値」「データが出たら将来調整できる」。** この正直さは前のページの EWMA 定数にも出てきた。局所性の効果は数回で頭打ちになる、という直感だけが根拠だと明記されている。

### 無効化はタスク 1 個分だけ

`lifo_enabled` を false にしたままだと、LIFO 最適化が二度と効かなくなる。だから戻す場所が要る。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
                let task = match core.lifo_slot.take() {
                    Some(task) => task,
                    None => {
                        self.reset_lifo_enabled(&mut core);
```

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    fn reset_lifo_enabled(&self, core: &mut Core) {
        core.lifo_enabled = !self.worker.handle.shared.config.disable_lifo_slot;
    }
```

**連鎖が自然に切れた時点で戻す。** つまり無効化の有効期間は「今の連鎖の残り」だけだ。次にキューからタスクを取ってくれば、また LIFO が使える。

戻し忘れがないかを、ループの先頭で毎回確かめている。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    fn assert_lifo_enabled_is_correct(&self, core: &Core) {
        debug_assert_eq!(
            core.lifo_enabled,
            !self.worker.handle.shared.config.disable_lifo_slot
        );
    }
```

**「一時的に落とすフラグ」は、戻し忘れが必ず起きる。** 復帰地点が複数あるので、debug ビルドの assert で常時見張っている。実際、`Context::run` の冒頭にも復帰処理がある。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    fn run(&self, mut core: Box<Core>) -> RunResult {
        // Reset `lifo_enabled` here in case the core was previously stolen from
        // a task that had the LIFO slot disabled.
        self.reset_lifo_enabled(&mut core);
```

**コアが「LIFO 無効の状態で」他のスレッドに渡ることがある。** 受け取った側は、その事情を知らない。だからコアを受け取ったら必ず初期化する。

### LIFO スロットのタスクは盗まれない

LIFO スロットは `Core` の中にあり、`queue::Steal` からは見えない。これは意図的で、局所性のために取り置いているタスクを他のワーカーに持っていかれては意味がない。

ただしその結果、**「このワーカーが止まると、そのタスクも止まる」** という危険が生まれる。だから、コアを手放す場面ではスロットを空にする ([`#L481-L487`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L481-L487))。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
        // If we heavily call `spawn_blocking`, there might be no available thread to
        // run this core. Except for the task in the lifo_slot, all tasks can be
        // stolen, so we move the task out of the lifo_slot to the run_queue.
        if let Some(task) = core.lifo_slot.take() {
            core.run_queue
                .push_back_or_overflow(task, &*cx.worker.handle, &mut core.stats);
        }
```

`block_in_place` の直前だ。コアを別スレッドに渡すが、そのスレッドが確保できるとは限らない (`spawn_blocking` を大量に使っているとブロッキングプールが枯れる)。**そうなったとき、キューのタスクは他のワーカーが盗めるが、LIFO スロットのタスクだけは誰にも届かない。**

「盗めない場所に置く」最適化の代償が、ここで 1 回だけ支払われている。

### 丸ごと無効にする設定がある

`lifo_enabled` の初期値は設定から来る。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
            lifo_enabled: !config.disable_lifo_slot,
```

`Builder::disable_lifo_slot()` は公開 API だ。**局所性を捨ててでも、キュー順の公平さを取りたい場合がある。** 1 個のタスクが極端に長い場合や、レイテンシの分布をそろえたい場合だ。

最適化を入れたうえで、**それを丸ごと切るスイッチも公開している**。そして切ったときに `lifo_enabled` の値が変わらないことを、上の `debug_assert_eq!` が保証している。

## なぜそうなっているか

- **LIFO スロットがあるのは、メッセージ往復が非同期コードの基本形だから。** リクエスト/レスポンス、チャネル、`oneshot` での完了通知。どれも「起こした相手がすぐ走ってほしい」形をしている。キューの末尾に積むと、そのたびにキュー 1 周分の遅延とキャッシュミスが乗る。
- **スロットが 1 個だけなのは、それ以上は局所性に寄与しないから。** 2 個目以降は、どのみちキャッシュから溢れる。1 個に限れば、実装は `Option<Notified>` の入れ替えだけで済む。
- **3 回で打ち切るのは、ping-pong による飢餓を防ぐため。** A と B が互いを起こし続けると、この 2 つが CPU を占有する。同じワーカーのキューにいる他のタスクは、そのワーカーが止まるまで走れない。
- **`yield_now()` を LIFO スロットに入れないのは、意味が正反対だから。** 「譲る」と言っているタスクをすぐ再開させたら、API が嘘になる。
- **無効化がタスク 1 個分で戻るのは、無効化の目的が「今の連鎖を切る」ことだから。** 恒久的に切ると、以降のすべてのタスクが局所性の恩恵を失う。
- **コアを手放すときにスロットを空にするのは、そこが盗めない場所だから。** 通常はそれが利点だが、ワーカーが止まる場面では「誰も手が届かないタスク」になる。最適化のために作った例外は、例外を維持できない場面で必ず後始末が要る。
- **`debug_assert` で見張っているのは、フラグの復帰地点が複数あるから。** 連鎖の終了、コアの受け取り、予算切れ。どれか 1 つで戻し忘れると、そのワーカーは以降ずっと LIFO なしで動く。しかも動作としては正しいので、性能劣化としてしか現れない。

## どう活かすか

- **「直前に起こした相手をすぐ走らせる」枠を 1 個だけ作る。** キューとは別に置くのがポイントで、キューの先頭に入れる形にすると、他の要素との順序関係が壊れる。1 個限定なら、実装も `Option` の入れ替えで済む。
- **局所性のための優先には、必ず打ち切り条件を付ける。** 「優先し続ける」は飢餓を生む。回数、時間、予算のどれかで上限を設ける。上限値の根拠がなくても、上限があること自体に意味がある。
- **一時的に落とすフラグは、復帰地点を洗い出して assert で見張る。** 復帰が 1 箇所で済むことは少ない。戻し忘れは「動くが遅い」形で現れるので、テストでは捕まらない。
- **「譲る」という意味の API は、最適化の対象から外す。** ユーザーが明示的に順番を譲ったのに、実装の都合で譲らせないのは契約違反になる。
- **特別扱いした置き場は、通常経路から外れる場面で回収する。** 「ここに置いたものは他から見えない」を利点として使うなら、見えないことが害になる状況 (シャットダウン、ハンドオフ、パニック) を洗い出して、そこで戻す。
- **通知は「他人が手伝える仕事が増えたとき」だけ出す。** 自分専用の場所に置いただけなら、他のワーカーを起こしても仕事は見つからない。空振りの起床は、そのまま無駄な CPU になる。
- **性能のための最適化には、丸ごと切るスイッチを用意する。** ワークロードによっては害になる。切れるようにしておけば、問題の切り分けもできる。
