---
title: "readiness に「いつの周回か」を添えて、古いイベントによる打ち消しを弾く"
description: "epoll から届いた「読める」を、Tokio は 1 個のアトミック変数にキャッシュする。困るのは「読めると言われて読んだら EWOULDBLOCK だった」ときで、キャッシュを消す必要がある。だが消している間に新しい通知が来ていたら、それまで消してしまう。Tokio は readiness と同じ語に 15 ビットの世代番号を入れ、消す側に「どの世代を見て消すのか」を申告させることでこれを防いでいる。"
sidebar:
  order: 14
---

## 何を学んだか

### どんな状況の話か

`epoll` はエッジトリガで使うと、「読めるようになった」という **変化** を 1 回だけ通知する。通知を受け取った側は、`EWOULDBLOCK` が返るまで読み続けなければならない。途中でやめると、次の通知は「次に変化があったとき」まで来ない。

非同期ランタイムでは、この通知とタスクの間に時間差がある。

1. ドライバのスレッドが `epoll_wait` から「fd 7 が読める」を受け取る。
2. fd 7 を待っているタスクを起こす。
3. そのタスクがワーカーのキューに並ぶ。
4. しばらくして poll され、`read(2)` を呼ぶ。

**ドライバは「読める」を保持しておかなければならない。** 3 と 4 の間にもう一度 `epoll_wait` を回してしまうので、そのときにはもう通知は残っていない。

そこで、fd ごとに「今どの操作が可能か」をキャッシュする。これが `ScheduledIo` の `readiness` だ。

問題はキャッシュを **消す** ときに起きる。

- タスク: 「読めるはずだ」と思って `read(2)` を呼ぶ → `EWOULDBLOCK`。他のタスクが先に読んでしまった、といったことは起こる。
- タスク: readiness キャッシュから「読める」を消す。
- **だがその直前に、ドライバが新しい「読める」を書き込んでいたら?**

消す操作が新しい通知を巻き込むと、**そのタスクは永久に起きない**。エッジトリガなので、次の通知は来ない。

### Tokio の答え

**readiness と同じ語に「世代番号 (tick)」を入れる。**

```text title="tokio/src/runtime/io/scheduled_io.rs"
// The `ScheduledIo::readiness` (`AtomicUsize`) is packed full of goodness.
//
// | shutdown | driver tick | readiness |
// |----------+-------------+-----------|
// |   1 bit  |   15 bits   |  16 bits  |
```

- **ドライバが readiness を書き込むたびに、tick が 1 増える。**
- **消す側は「自分が見た tick」を申告する。** 現在の tick と一致しなければ、**消す操作は何もせずに終わる**。

「読める」を見てから消すまでの間に新しい通知が来ていれば、tick が進んでいるので消せない。**そのタスクは残った readiness を見て、もう一度読みにいける。**

## ソースコードのどこか

### ビットの割り当て

[`runtime/io/scheduled_io.rs#L162-L172`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L162-L172)。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
const READINESS: bit::Pack = bit::Pack::least_significant(16);

const TICK: bit::Pack = READINESS.then(15);

const SHUTDOWN: bit::Pack = TICK.then(1);
```

`bit::Pack` は、ビット幅を宣言していくと自動でオフセットを計算してくれる小さなユーティリティだ。**`then(15)` と書くだけで「READINESS の次に 15 ビット」になる。** シフト量やマスクを手で書かないので、幅を変えても壊れない。

構造体は 3 フィールドしかない ([`#L101-L108`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L101-L108))。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
pub(crate) struct ScheduledIo {
    pub(super) linked_list_pointers: UnsafeCell<linked_list::Pointers<Self>>,

    /// Packs the resource's readiness and I/O driver latest tick.
    readiness: AtomicUsize,

    waiters: Mutex<Waiters>,
}
```

そしてこの構造体にも、[タスクのレイアウト](../task-layout/) と同じキャッシュライン整列が付いている。同じ 30 行の `cfg_attr` と、同じ根拠 URL の束が丸ごとコピーされている。**別々のソケットの readiness が同じキャッシュラインに乗ると、無関係なスレッド同士がキャッシュを取り合う。**

### 世代の更新と検査

[`#L199-L224`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L199-L224)。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
    pub(super) fn set_readiness(&self, tick_op: Tick, f: impl Fn(Ready) -> Ready) {
        let _ = self.readiness.fetch_update(AcqRel, Acquire, |curr| {
            // If the io driver is shut down, then you are only allowed to clear readiness.
            debug_assert!(SHUTDOWN.unpack(curr) == 0 || matches!(tick_op, Tick::Clear(_)));

            const MAX_TICK: usize = TICK.max_value() + 1;
            let tick = TICK.unpack(curr);

            let new_tick = match tick_op {
                // Trying to clear readiness with an old event!
                Tick::Clear(t) if tick as u8 != t => return None,
                Tick::Clear(t) => t as usize,
                Tick::Set => tick.wrapping_add(1) % MAX_TICK,
            };
            let ready = Ready::from_usize(READINESS.unpack(curr));
            Some(TICK.pack(new_tick, f(ready).as_usize()))
        });
    }
```

**`Tick::Clear(t) if tick as u8 != t => return None`** の 1 行が、このページの主題そのものだ。`None` を返すと `fetch_update` は何も書かずに終わる。

書き込みと消去が **同じ関数** になっているのも設計の一部で、どちらも「現在値を読んで、tick を決めて、readiness を計算して、まとめて 1 語に詰める」という同じ形をしている。**tick の更新を忘れる余地がない。**

`as u8` でのキャストに注目したい。tick は 15 ビットあるのに、比較は下位 8 ビットだけで行う。イベント側 (`ReadyEvent`) が tick を `u8` で持っているからだ。**256 周する前に消しに来る、という前提で幅を切り詰めている。**

ドライバ側の呼び出し ([`runtime/io/driver.rs#L216-L219`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/driver.rs#L216-L219))。

```rust title="tokio/src/runtime/io/driver.rs"
                let io: &ScheduledIo = unsafe { &*ptr };

                io.set_readiness(Tick::Set, |curr| curr | ready);
                io.wake(ready);
```

**readiness を足してから起こす。** 順序が逆だと、起きたタスクが古い readiness を見てしまう。

### 消してよくないものは消さない

[`#L357-L362`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L357-L362)。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
    pub(crate) fn clear_readiness(&self, event: ReadyEvent) {
        // This consumes the current readiness state **except** for closed
        // states. Closed states are excluded because they are final states.
        let mask_no_closed = event.ready - Ready::READ_CLOSED - Ready::WRITE_CLOSED;
        self.set_readiness(Tick::Clear(event.tick), |curr| curr - mask_no_closed);
    }
```

**「閉じた」は取り消せない状態なので、消す対象から外す。**

`READ_CLOSED` は「相手が接続を閉じた」を意味する。これを消してしまうと、次に `read` した誰かが「まだ読めるかもしれない」と待ち続ける。**一度立ったら二度と降りない状態を、汎用の消去処理から除外している。**

同じ考え方が `SHUTDOWN` ビットにも出ている。ドライバが落ちた後は、readiness の追加が禁止され (`debug_assert`)、消去だけが許される。

### 起こす前にロックを手放す

[`#L226-L286`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L226-L286)。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
    /// Notifies all pending waiters that have registered interest in `ready`.
    ///
    /// There may be many waiters to notify. Waking the pending task **must** be
    /// done from outside of the lock otherwise there is a potential for a
    /// deadlock.
    ///
    /// A stack array of wakers is created and filled with wakers to notify, the
    /// lock is released, and the wakers are notified. Because there may be more
    /// than 32 wakers to notify, if the stack array fills up, the lock is
    /// released, the array is cleared, and the iteration continues.
    pub(super) fn wake(&self, ready: Ready) {
        let mut wakers = WakeList::new();

        let mut waiters = self.waiters.lock();
```

**ロックの中で `wake()` を呼んではいけない。**

理由はデッドロックだ。`waker.wake()` は [タスクの状態遷移](../task-state/) を起こし、スケジューラのキューに積み、場合によっては別のワーカーを起こす。その先で **同じ `ScheduledIo` のロックを取ろうとするコードが動きうる** (起きたタスクが即座に `clear_readiness` を呼ぶ、など)。

対策が「スタック上の配列に 32 個まで溜めて、ロックを外してからまとめて起こす」だ。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
        'outer: loop {
            let mut iter = waiters.list.drain_filter(|w| ready.satisfies(w.interest));

            while wakers.can_push() {
                match iter.next() {
                    Some(waiter) => {
                        let waiter = unsafe { &mut *waiter.as_ptr() };

                        if let Some(waker) = waiter.waker.take() {
                            waiter.is_ready = true;
                            wakers.push(waker);
                        }
                    }
                    None => {
                        break 'outer;
                    }
                }
            }

            drop(waiters);

            wakers.wake_all();

            // Acquire the lock again.
            waiters = self.waiters.lock();
        }
```

**32 個埋まったら、ロックを外して起こし、また取り直す。** ヒープに `Vec` を確保しないので、待機者が何人いても割り当てが 0 回で済む。

`drain_filter` で **興味が一致する待機者だけを取り出しながら削除している** のも効いている。「読める」通知で、書き込み待ちの人を起こす必要はない。

`waiter.is_ready = true` を立ててから waker を取り出しているところも重要で、これが後で「自分は起こされたのか」の判定に使われる。

### 高頻度の 2 経路には、専用の枠がある

`Waiters` は 3 つのフィールドを持つ ([`#L110-L120`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L110-L120))。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
struct Waiters {
    /// List of all current waiters.
    list: LinkedList<Waiter>,

    /// Waker used for `AsyncRead`.
    reader: Option<Waker>,

    /// Waker used for `AsyncWrite`.
    writer: Option<Waker>,
}
```

**汎用の連結リストとは別に、「読み」と「書き」の枠が 1 個ずつある。**

`AsyncRead`/`AsyncWrite` は `poll_read(&mut self, cx)` という形なので、**同時に読める人は 1 人しかいない** (`&mut self` が要る)。だから待機者リストに繋ぐ必要がなく、`Option<Waker>` 1 個で足りる。

この枠を使う経路では、リストへの挿入・削除が起きない。**最も多い使われ方に、いちばん安い置き場を用意している。**

waker の格納も一工夫ある ([`#L321-L326`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L321-L326))。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
            // Avoid cloning the waker if one is already stored that matches the
            // current task.
            match waker {
                Some(waker) => waker.clone_from(cx.waker()),
                None => *waker = Some(cx.waker().clone()),
            }
```

`clone_from` は、`Waker` の実装で「同じタスクなら何もしない」に最適化されている。[waker のページ](../task-waker/) で見た `will_wake` と同じ話で、**vtable が 1 個の `static` だから成立する**。

### ロックを取った後に、もう一度読む

[`#L328-L340`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L328-L340)。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
            // Try again, in case the readiness was changed while we were
            // taking the waiters lock
            let curr = self.readiness.load(Acquire);
            let ready = direction.mask() & Ready::from_usize(READINESS.unpack(curr));
            let is_shutdown = SHUTDOWN.unpack(curr) != 0;
            if is_shutdown {
```

**「readiness が空 → ロックを取る → waker を登録」の途中で readiness が立つと、通知が失われる。**

ドライバ側は「readiness を立てる → ロックを取って waker を起こす」の順で動く。両者がすれ違うと、ドライバがロックを取った時点では waker が登録されておらず、タスクがロックを取った時点では readiness が立っている。

**登録した後にもう一度読めば、この隙間が閉じる。** ロックの外で状態を持つ設計に必ずついてくる二度読みで、[idle のページ](../idle-searching/) の `worker_to_notify` と同じ形をしている。

### 落とすときは全員起こす

```rust title="tokio/src/runtime/io/scheduled_io.rs"
impl Drop for ScheduledIo {
    fn drop(&mut self) {
        self.wake(Ready::ALL);
    }
}
```

```rust title="tokio/src/runtime/io/scheduled_io.rs"
    /// Invoked when the IO driver is shut down; forces this `ScheduledIo` into a
    /// permanently shutdown state.
    pub(super) fn shutdown(&self) {
        let mask = SHUTDOWN.pack(1, 0);
        self.readiness.fetch_or(mask, AcqRel);
        self.wake(Ready::ALL);
    }
```

**待機者を残したまま消えない。** 起こされたタスクは `SHUTDOWN` ビットを見て、エラーを返す。

`Ready::ALL` で起こすので、読み待ちも書き待ちも全員が起きる。「もう二度とイベントは来ない」ことを伝える手段が、通常のイベントと同じ経路になっている。

## なぜそうなっているか

- **readiness をキャッシュするのは、エッジトリガの通知が 1 回しか来ないから。** ドライバとタスクの間には時間差があり、タスクが読みにいく頃には通知はもう残っていない。ドライバ側で状態として保持するしかない。
- **tick があるのは、「消す」が後追いの操作だから。** 見てから消すまでの間に新しい通知が来ると、消去がそれを巻き込む。エッジトリガでは次の通知が来ないので、これはハングになる。世代番号があれば「自分が見た状態はもう古い」と分かる。
- **readiness と tick を同じ語に入れたのは、両者を不可分に更新するため。** 別々だと、「readiness は更新したが tick はまだ」という瞬間ができ、そこで消しに来られると防げない。
- **`CLOSED` を消去対象から外すのは、それが最終状態だから。** 「閉じた」が消えると、待っている側は永遠に来ないイベントを待つ。一度立ったら降りない状態は、汎用の消去から明示的に除外する必要がある。
- **ロックの外で起こすのは、`wake()` が何をするか分からないから。** タスクの状態遷移、キューへの投入、他スレッドの起床。その先で同じロックを取る経路がありうる。
- **スタック配列にバッファするのは、ヒープ確保を避けるため。** ドライバのループは 1 回の `epoll_wait` で数千個のイベントを捌く。ここで `Vec` を確保すると、それ自体がボトルネックになる。
- **読み/書きに専用枠があるのは、`AsyncRead`/`AsyncWrite` が排他的だから。** `&mut self` を要求する API では待機者が 1 人しかありえない。連結リストの挿入・削除を丸ごと省ける。
- **ロック取得後に readiness を読み直すのは、ロックの外に状態があるから。** 「状態を見る」と「待機登録する」が別の同期に守られているなら、その間の変化を拾う二度読みが必ず要る。

## どう活かすか

- **キャッシュした状態を「後から取り消す」設計には、世代番号を持たせる。** 取り消しは必ず「見た時点」と「消す時点」に時間差がある。その間の更新を巻き込まないためには、見た時点の世代を申告させるしかない。
- **世代と値は、同じアトミック変数に入れる。** 別々にすると、片方だけ更新された瞬間が生まれ、そこが競合の入口になる。
- **「一度立ったら降りない」状態は、汎用の消去処理から明示的に除外する。** 終了・切断・エラーのような最終状態は、消えると待ち側が永久に待つ。除外の理由をコメントに書いておかないと、後で「対称じゃない」として整理される。
- **ロックの中でコールバックを呼ばない。** `wake` も `notify` も、その先で何をするか分からない。溜めておいて、ロックを外してから呼ぶ。件数が多いなら、固定長のスタック配列で分割して処理する。
- **最頻の利用形態に、専用の安い置き場を用意する。** 排他性が API から保証されている経路 (`&mut self`) は、汎用の待機者リストを通す必要がない。
- **ロックの外にある状態を見てから待機登録するなら、登録後にもう一度見る。** この二度読みは定型で、省くと「まれに固まる」不具合になる。しかも負荷が高いときにしか出ない。
- **リソースを落とすときは、待機者を全員起こして終了状態を伝える。** 通常のイベントと同じ経路で伝えられるなら、待つ側の処理を分ける必要がなくなる。
