---
title: "探索中のワーカーが 1 人でもいるなら誰も起こさない、という賭けを SeqCst で成立させる"
description: "仕事が増えるたびに寝ているワーカーを起こすと、起きても仕事が見つからない空振りが大量に出る。Tokio は「探索中のワーカーが 1 人でもいれば、その人が見つけて次を起こす」と仮定して通知を省く。この仮定が成り立つには、通知側の読みと探索終了側の書きが必ず前後関係を持つ必要があり、そのために Acquire/Release ではなく SeqCst が使われている。読み取りが fetch_add(0) で書かれているのも同じ理由だ。"
group: "work-stealing スケジューラ"
sidebar:
  order: 10
---

## 何を学んだか

### どんな状況の話か

仕事がないワーカーは寝る (`park`)。仕事が増えたら誰かが起こす (`unpark`)。この当たり前の仕組みには、2 つの失敗の形がある。

- **起こしすぎ (thundering herd)**: タスクを 1 個 spawn するたびに全ワーカーを起こす。起きた 15 人のうち 14 人は仕事を見つけられず、また寝る。この往復は無駄な CPU そのもので、しかも寝る/起きるはシステムコールを伴う。
- **起こさなすぎ (lost wakeup)**: 「誰か起きているはずだ」と判断して通知を省いたら、その誰かが直後に寝てしまった。仕事がキューに残ったまま、全員が寝る。**これはデッドロックで、タイムアウトもない。**

work-stealing スケジューラでは、この判断が特に難しい。タスクは 16 個のキューのどこかにいて、寝ているワーカーはそれを見にいかないと分からない。

### Tokio の答え

**「探索中 (searching) のワーカー」という状態を作り、その人数を数える。**

- **仕事が増えたとき**: 探索中の人が 1 人でもいれば、**誰も起こさない**。その人が見つけて、必要なら次を起こしてくれる。
- **探索してよいのは、ワーカー数の半分まで**。全員で盗みに走ると、キューの `head` を全員で CAS し合うことになる。
- **探索を終える最後の 1 人** には、特別な義務が課される。「自分が最後だったなら、代わりに誰かを起こす」。

この連鎖で「常に最低 1 人が仕事を探している」を保つ。**通知の総量が劇的に減り、しかも取りこぼしがない。**

ただし、この論法は **「探索中の人がいる」という観測が、その人が探索をやめるより前でなければならない**。ここに強いメモリ順序が要る。

## ソースコードのどこか

### 状態は 1 語、待機者リストはロックの中

[`multi_thread/idle.rs#L9-L28`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/idle.rs#L9-L28)。

```rust title="tokio/src/runtime/scheduler/multi_thread/idle.rs"
pub(super) struct Idle {
    /// Tracks both the number of searching workers and the number of unparked
    /// workers.
    ///
    /// Used as a fast-path to avoid acquiring the lock when needed.
    state: AtomicUsize,

    /// Total number of workers.
    num_workers: usize,
}

/// Data synchronized by the scheduler mutex
pub(super) struct Synced {
    /// Sleeping workers
    sleepers: Vec<usize>,
}

const UNPARK_SHIFT: usize = 16;
const UNPARK_MASK: usize = !SEARCH_MASK;
const SEARCH_MASK: usize = (1 << UNPARK_SHIFT) - 1;
```

前のページのグローバルキューと同じ構造だ。**判断に使う数値だけをアトミック変数に出し、実体 (寝ている人の一覧) はロックの中に置く。**

そして、これも既出の手法だが、**2 つのカウンタを 1 語にパックしている**。「起きている人数」と「探索中の人数」を同時に見る必要があるからだ。

### 通知を省く判断

[`#L49-L82`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/idle.rs#L49-L82)。

```rust title="tokio/src/runtime/scheduler/multi_thread/idle.rs"
    /// If there are no workers actively searching, returns the index of a
    /// worker currently sleeping.
    pub(super) fn worker_to_notify(&self, shared: &Shared) -> Option<usize> {
        // If at least one worker is spinning, work being notified will
        // eventually be found. A searching thread will find **some** work and
        // notify another worker, eventually leading to our work being found.
        //
        // For this to happen, this load must happen before the thread
        // transitioning `num_searching` to zero. Acquire / Release does not
        // provide sufficient guarantees, so this load is done with `SeqCst` and
        // will pair with the `fetch_sub(1)` when transitioning out of
        // searching.
        if !self.notify_should_wakeup() {
            return None;
        }

        // Acquire the lock
        let mut lock = shared.synced.lock();

        // Check again, now that the lock is acquired
        if !self.notify_should_wakeup() {
            return None;
        }
```

**このコメントが、このページで最も重要な 12 行だ。**

論法はこうだ。「探索中の人が 1 人でもいるなら、その人は **何らかの** 仕事を見つける。見つけたら、その人は次の人を起こす。その連鎖の先で、私が今追加した仕事も見つかる。」

「私の仕事を見つけてくれる」ではなく「**何らかの** 仕事を見つけて、その結果として連鎖が続く」という論法になっているのが肝で、だから探索中の人が具体的にどこを見ているかは問題にならない。

そして条件が明記されている。**この読み取りが、探索終了 (`num_searching` を 0 にする操作) より前に順序づけられていなければならない。** そうでないと、こういう順序があり得る。

1. 通知側: 「探索中の人がいる」と読む
2. 探索側: 何も見つからず、探索をやめる (`num_searching` を 0 に)
3. 探索側: 寝る
4. 通知側: 誰も起こさずに帰る

**全員が寝て、仕事が残る。**

`Acquire`/`Release` では足りない、と書いてある。この 2 つは「同じ変数への読み書きの間」の関係を作るが、**別々のスレッドで起きた 2 つの操作に全体的な前後関係を与えない**。`SeqCst` は全 `SeqCst` 操作に 1 本の全順序を与えるので、「読みが先か、`fetch_sub` が先か」が必ずどちらかに定まる。

### 読み取りを fetch_add(0) で書く

[`#L153-L156`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/idle.rs#L153-L156)。

```rust title="tokio/src/runtime/scheduler/multi_thread/idle.rs"
    fn notify_should_wakeup(&self) -> bool {
        let state = State(self.state.fetch_add(0, SeqCst));
        state.num_searching() == 0 && state.num_unparked() < self.num_workers
    }
```

**`load(SeqCst)` ではなく `fetch_add(0, SeqCst)`。** 値を 0 だけ足す、つまり何も変えない read-modify-write だ。

これは意図的な選択だ。C++/Rust のメモリモデルでは、`SeqCst` の **ロード** と `SeqCst` の RMW は、全順序への参加の仕方が微妙に違う。RMW は「変更順序の中の特定の位置」を必ず占めるので、他の RMW (ここでは `fetch_sub(1)`) との前後がより強く定まる。

`load(SeqCst)` で十分かどうかは、モデルの細部に依存する議論になる。**そこに賭けず、確実に強い操作を使っている。** この 1 行が守っているのはデッドロックの不在なので、慎重さの度合いとして妥当だ。

そして、ロックを取った後にもう一度同じ判定をする。**判定と行動 (寝ている人を一覧から取り出す) を同じロックの中で確定させるため** で、これは登録簿のページで見た `closed` フラグと同じ構図だ。

### 探索者は半分まで

[`#L104-L115`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/idle.rs#L104-L115)。

```rust title="tokio/src/runtime/scheduler/multi_thread/idle.rs"
    pub(super) fn transition_worker_to_searching(&self) -> bool {
        let state = State::load(&self.state, SeqCst);
        if 2 * state.num_searching() >= self.num_workers {
            return false;
        }

        // It is possible for this routine to allow more than 50% of the workers
        // to search. That is OK. Limiting searchers is only an optimization to
        // prevent too much contention.
        State::inc_num_searching(&self.state, SeqCst);
        true
    }
```

**読んでから増やすまでの間に他の人が増やしうるので、半分を超えることがある。それでよい、と明記されている。**

これは「正しさに関わらない制限」だからだ。探索者が多すぎると、[ローカルキュー](../local-run-queue/) の `head` に対する CAS が競合して、全員が遅くなる。それを緩和するための目安であって、厳密に守る必要はない。

**厳密でなくてよい制限に、CAS ループを使わない。** 読んで、判定して、無条件に足す。ずれた分の害は「一時的に探索者が 1 人多い」だけだ。

対比として、[前々ページのタスク状態](../task-state/) はすべて CAS ループで守られていた。あちらは正しさに関わるからだ。**制限の性質によって、同期の強さを変えている。**

### 最後の探索者には義務がある

探索をやめるときの遷移 ([`#L117-L123`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/idle.rs#L117-L123))。

```rust title="tokio/src/runtime/scheduler/multi_thread/idle.rs"
    /// A lightweight transition from searching -> running.
    ///
    /// Returns `true` if this is the final searching worker. The caller
    /// **must** notify a new worker.
    pub(super) fn transition_worker_from_searching(&self) -> bool {
        State::dec_num_searching(&self.state)
    }
```

**「呼び出し側は新しいワーカーを起こさなければならない」** と `must` で書かれている。

自分が最後の探索者だったなら、自分が探索をやめた瞬間に「探索中は 0 人」になる。上の `worker_to_notify` は、その状態を見て初めて通知を出すようになるが、**その前に増えた仕事は誰にも通知されていない**。だから、代わりに自分が 1 人起こす。

呼び出し側 ([`worker.rs#L644-L649`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L644-L649))。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    fn run_task(&self, task: Notified, mut core: Box<Core>) -> RunResult {
        let task = self.worker.handle.shared.owned.assert_owner(task);

        // Make sure the worker is not in the **searching** state. This enables
        // another idle worker to try to steal work.
        let notified_parked_worker = core.transition_from_searching(&self.worker);
```

**仕事を見つけて走らせる直前に、探索状態を降りる。** 探索をやめないと、他のワーカーが探索枠に入れない (半分制限に引っかかる)。

同じ義務が「寝る」ときにもある ([`worker.rs#L1230-L1252`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L1230-L1252))。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
        // When the final worker transitions **out** of searching to parked, it
        // must check all the queues one last time in case work materialized
        // between the last work scan and transitioning out of searching.
        let is_last_searcher = worker.handle.shared.idle.transition_worker_to_parked(
            &worker.handle.shared,
            worker.index,
            self.is_searching,
        );

        // The worker is no longer searching. Setting this is the local cache
        // only.
        self.is_searching = false;

        if is_last_searcher {
            worker.handle.notify_if_work_pending();
        }
```

**最後の探索者が寝るときは、全キューをもう一度確認する。** 探索が終わってから寝るまでの間に仕事が現れた可能性があり、その仕事の通知は「探索者がいる」という理由で省略されている。

`notify_if_work_pending` は全ワーカーのキューを見て、空でなければ 1 人起こす。**この最終確認が、通知を省く最適化を安全にしている最後の砦だ。**

### 探索は、ランダムな相手から始める

[`worker.rs#L1167-L1195`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L1167-L1195)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    /// Function responsible for stealing tasks from another worker
    ///
    /// Note: Only if less than half the workers are searching for tasks to steal
    /// a new worker will actually try to steal. The idea is to make sure not all
    /// workers will be trying to steal at the same time.
    fn steal_work(&mut self, worker: &Worker) -> Option<Notified> {
        if !self.transition_to_searching(worker) {
            return None;
        }

        let num = worker.handle.shared.remotes.len();
        // Start from a random worker
        let start = self.rand.fastrand_n(num as u32) as usize;

        for i in 0..num {
            let i = (start + i) % num;

            // Don't steal from ourself! We know we don't have work.
            if i == worker.index {
                continue;
            }
```

**開始位置が乱数。** 全員が 0 番から順に見ると、0 番のワーカーのキューに全員の CAS が集中する。ランダムな位置から始めれば、探索の負荷が散る。

これは [登録簿のシャットダウン](../owned-tasks/) で見た「開始位置をずらす」と同じ発想だが、あちらは決定的な値 (ワーカーのインデックス)、こちらは乱数だ。**あちらは呼び出し側が全員違うと分かっている。こちらは同じワーカーが何度も探索するので、決定的だと毎回同じ順になる。**

見つからなければグローバルキューを見て終わる。**探索は 1 周で打ち切り、粘らない。**

### 通知するかどうかの、もう 1 つの判定

[`worker.rs#L1218-L1225`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L1218-L1225)。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
    fn should_notify_others(&self) -> bool {
        // If there are tasks available to steal, but this worker is not
        // looking for tasks to steal, notify another worker.
        if self.is_searching {
            return false;
        }
        self.lifo_slot.is_some() as usize + self.run_queue.len() > 1
    }
```

**自分が探索中なら通知しない。** 自分がこれから他人のキューを漁るのだから、他人を起こす必要はない。

そして **仕事が 2 個以上なければ通知しない**。1 個しかないなら、それは自分が走らせる。起こしても相手は空振りする。

`lifo_slot.is_some() as usize` で LIFO スロットの中身を 1 個として数えているが、[前ページ](../lifo-slot/) のとおりこれは盗めない。それでも数に入れるのは、この判定が「自分にはまだやることがあるか」を見ているからだ。

## なぜそうなっているか

- **通知を省く最適化が必要なのは、通知が高いから。** `unpark` は最終的に futex なりのシステムコールになる。タスクを spawn するたびに 16 スレッドを起こすと、spawn のコストがタスクの実行時間を上回る。
- **「探索中が 1 人でもいれば省く」が成り立つのは、探索者が連鎖を繋ぐから。** 探索者は仕事を見つけたら次の人を起こす。この義務があるから、1 人いれば全体が回る。義務がなければ、この最適化は即座に lost wakeup になる。
- **`SeqCst` を使うのは、2 つのスレッドの操作に前後関係が必要だから。** 「探索中を観測した」と「探索をやめた」の間に順序がないと、両方が「相手がやるはず」と判断して全員が寝る。`Acquire`/`Release` は同じ変数を介した関係しか作らないので足りない、と明記されている。
- **読み取りを `fetch_add(0)` にしたのは、より確実に全順序に参加させるため。** `SeqCst` ロードで十分かはモデルの細部の議論になる。デッドロックの不在がかかっているので、確実な側を選んでいる。
- **探索者を半分に制限するのは、盗む操作が競合するから。** 全員が同じキューの `head` を CAS すると、全員が失敗してリトライを繰り返す。ただしこの制限は正しさに関わらないので、多少超えても構わない。
- **最後の探索者に「もう一度確認する」義務を課すのは、通知を省いた分の穴埋め。** 省略された通知は、探索者が見つけるという前提に立っている。その前提が消える瞬間 (最後の 1 人が探索をやめる) に、確認をやり直す。
- **探索の開始位置が乱数なのは、同じワーカーが繰り返し探索するから。** 決定的な値だと、そのワーカーは毎回同じ順で見て、同じ相手と競合する。

## どう活かすか

- **「起こす」判断には、起こしすぎと起こさなすぎの両方の失敗がある。** 前者は無駄な CPU、後者はデッドロック。片方だけを見て設計すると、もう片方に倒れる。どちらの失敗も、負荷が高いときにしか現れない。
- **通知を省くなら、「誰かが必ず見つける」という不変条件を明示的に作る。** 「たぶん誰かが見てくれる」ではなく、「探索中の者は見つけたら次を起こす」「最後の 1 人は降りる前に再確認する」という義務を、関数の doc に `must` で書く。
- **省略の前提が消える瞬間を特定して、そこで確認をやり直す。** 最適化は必ず前提の上に成り立つ。前提が崩れる遷移は数えられるほど少ないので、そこだけに確認を入れれば全体のコストは上がらない。
- **2 つのスレッドの操作に前後関係が要るときは、`Acquire`/`Release` では足りない。** 「片方の読みが、もう片方の書きより前」を保証したいなら `SeqCst` が要る。そして、なぜ `SeqCst` なのかをコメントに書く。書かないと「無駄に強い」として弱められる。
- **制限が「正しさ」なのか「最適化」なのかを区別して、同期の強さを変える。** 最適化のための上限なら、多少超えても構わない。CAS ループをやめて、読んで足すだけにできる。そして「超えても OK」と書いておく。
- **通知するかの判定に「自分にまだ仕事があるか」を入れる。** 仕事が 1 個しかないなら、それは自分が処理する。起こした相手は空振りして、また寝るだけになる。
- **競合する対象を全員が同じ順に走査しない。** 開始位置をずらす。呼び出し側が固定的に違うなら決定的な値でよく、同じ主体が繰り返すなら乱数にする。
