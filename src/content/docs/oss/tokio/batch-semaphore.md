---
title: "「必要な数がそろうまで permit を溜める」待ち行列を 1 個作り、Mutex も RwLock もチャネルもその上に載せる"
description: "Tokio の同期プリミティブは、ほぼ全部が 1 個のセマフォの上に建っている。Mutex は permit 1 個のセマフォ、RwLock の書き込みロックは permit を全部まとめて取る操作、有界チャネルは容量分の permit。まとめて取る要求が小さい要求に追い越されないよう、待ち行列は FIFO で、待っている人には permit が部分的に前渡しされる。"
group: "同期プリミティブ"
sidebar:
  order: 18
---

## 何を学んだか

### どんな状況の話か

非同期の同期プリミティブは、種類が多い。

- `Mutex` — 1 人だけ入れる
- `RwLock` — 読み手は何人でも、書き手は 1 人だけ
- `Semaphore` — N 人まで入れる
- 有界 `mpsc` — 容量 N まで送れる

これらを別々に実装すると、それぞれで「待ち行列」「waker の登録」「キャンセル時の後始末」「公平性」を書くことになる。しかも **待ち行列まわりは間違えやすい**。[I/O のページ](../io-cancel-safety/) で見たとおり、侵入型リストと `Drop` の組み合わせは慎重さを要求する。

そして「公平性」には具体的な失敗の形がある。**`RwLock` で書き手が飢える** のがそれだ。読み手が次々に来ると、書き手は「全員が出ていく瞬間」を待つことになるが、その瞬間が永久に来ない。

### Tokio の答え

**「一度に複数の permit を要求できるセマフォ」を 1 個だけ実装して、全部それで表す。**

- `Mutex` = **permit 1 個** のセマフォ。ロックは permit 1 個の取得。
- `RwLock` = **permit `MAX_READS` 個** のセマフォ。読みロックは 1 個の取得、**書きロックは `MAX_READS` 個をまとめて取得**。
- 有界 `mpsc` = **permit が容量分** のセマフォ。送信は 1 個の取得、受信で 1 個の返却。

`RwLock` の表現が鮮やかだ。**「全部の permit を取る」= 「他の誰もいない」** なので、書き込みの排他が読み取りと同じ仕組みで表せる。

そして「まとめて取る要求が飢えない」ことを、実装が保証する。

```rust title="tokio/src/sync/batch_semaphore.rs"
//! Because waiters are enqueued at the back of the linked list and dequeued
//! from the front, the semaphore is fair. Tasks trying to acquire large numbers
//! of permits at a time will always be woken eventually, even if many other
//! tasks are acquiring smaller numbers of permits. This means that in a
//! use-case like tokio's read-write lock, writers will not be starved by
//! readers.
```

**「読み手が書き手を飢えさせない」が、セマフォの公平性の帰結として得られている。**

## ソースコードのどこか

### permit を待ちながら溜める

核心は `Waiter` の状態だ ([`sync/batch_semaphore.rs#L78-L92`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/batch_semaphore.rs#L78-L92))。

```rust title="tokio/src/sync/batch_semaphore.rs"
/// An entry in the wait queue.
struct Waiter {
    /// The current state of the waiter.
    ///
    /// This is either the number of remaining permits required by
    /// the waiter, or a flag indicating that the waiter is not yet queued.
    state: AtomicUsize,
```

**「あと何個必要か」を持つ。** 「何個要求したか」ではない。

permit が返ってきたら、待ち行列の先頭の人に配る ([`#L548-L572`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/batch_semaphore.rs#L548-L572))。

```rust title="tokio/src/sync/batch_semaphore.rs"
    /// Assign permits to the waiter.
    ///
    /// Returns `true` if the waiter should be removed from the queue
    fn assign_permits(&self, n: &mut usize) -> bool {
        let mut curr = self.state.load(Acquire);
        loop {
            let assign = cmp::min(curr, *n);
            let next = curr - assign;
            match self.state.compare_exchange(curr, next, AcqRel, Acquire) {
                Ok(_) => {
                    *n -= assign;
                    return next == 0;
                }
                Err(actual) => curr = actual,
            }
        }
    }
```

**足りなくても、あるだけ渡す。** 100 個必要な待機者に 3 個返ってきたら、3 個渡して「あと 97 個」にする。渡された permit は **その待機者が握ったまま** で、セマフォには戻らない。

これが飢餓を防ぐ仕組みだ。書き手が 1024 個の permit を待っている間、読み手が来ても **permit はもう書き手に配られている** ので取れない。読み手は待ち行列の後ろに並ぶ。書き手は徐々に permit を集め、最後の 1 個が来た時点で起きる。

**「先着順の待ち行列」と「部分的な前渡し」の 2 つが揃って、初めて大口の要求が成立する。** どちらか片方だと、大口はいつまでも揃わない。

`add_permits_locked` が配る側だ ([`#L306-L370`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/batch_semaphore.rs#L306-L370))。

```rust title="tokio/src/sync/batch_semaphore.rs"
            'inner: while wakers.can_push() {
                // Was the waiter assigned enough permits to wake it?
                match waiters.queue.last() {
                    Some(waiter) => {
                        if !waiter.assign_permits(&mut rem) {
                            break 'inner;
                        }
                    }
                    None => {
                        is_empty = true;
                        // If we assigned permits to all the waiters in the queue, and there are
                        // still permits left over, assign them back to the semaphore.
                        break 'inner;
                    }
                };
                let mut waiter = waiters.queue.pop_back().unwrap();
```

**先頭の待機者が満たされなければ、そこで打ち切る。** 2 番目に渡ることはない。追い越しが起きないので、FIFO が保たれる。

余った permit だけがセマフォのカウンタに戻る。ここでも [I/O ドライバ](../scheduled-io/) と同じ `WakeList` が使われていて、ロックを外してから起こす。

### permit のカウンタに「閉じた」フラグを埋める

[`#L122-L135`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/batch_semaphore.rs#L122-L135)。

```rust title="tokio/src/sync/batch_semaphore.rs"
    /// The maximum number of permits which a semaphore can hold.
    ///
    /// Note that this reserves three bits of flags in the permit counter, but
    /// we only actually use one of them. However, the previous semaphore
    /// implementation used three bits, so we will continue to reserve them to
    /// avoid a breaking change if additional flags need to be added in the
    /// future.
    pub(crate) const MAX_PERMITS: usize = usize::MAX >> 3;
    const CLOSED: usize = 1;
```

**「1 ビットしか使っていないが、3 ビット予約しておく」。** 旧実装が 3 ビット使っていたので、今さら上限を上げると **後で減らせなくなる**。

`MAX_PERMITS` は公開 API に出る値だ。一度 `usize::MAX >> 1` にしてしまうと、将来フラグを足したくなったときに上限を下げることになり、それは破壊的変更になる。**「使わない予約を残す」判断とその理由が書かれている。**

閉じる操作 ([`#L240-L259`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/batch_semaphore.rs#L240-L259))。

```rust title="tokio/src/sync/batch_semaphore.rs"
    pub(crate) fn close(&self) {
        let mut waiters = self.waiters.lock();
        // If the semaphore's permits counter has enough permits for an
        // unqueued waiter to acquire all the permits it needs immediately,
        // it won't touch the wait list. Therefore, we have to set a bit on
        // the permit counter as well. However, we must do this while
        // holding the lock --- otherwise, if we set the bit and then wait
        // to acquire the lock we'll enter an inconsistent state where the
        // permit counter is closed, but the wait list is not.
        self.permits.fetch_or(Self::CLOSED, Release);
        waiters.closed = true;
```

**「閉じた」が 2 か所にある。** カウンタのビットと、待ち行列の中の `closed` フラグ。

理由が書いてある。**permit がすぐ取れる場合、取得側は待ち行列を一切見ない。** だから待ち行列だけに閉鎖フラグを置いても、その経路には効かない。逆にカウンタだけだと、すでに並んでいる人に伝わらない。

そして **両方をロックの中で設定する**。ビットを立ててからロックを取りにいくと、「カウンタは閉じているが待ち行列は開いている」という中間状態が観測される。[登録簿のページ](../owned-tasks/) で見た `closed` と同じ話が、ここでも出てくる。

### ロックを取る順序

`poll_acquire` の中に、順序に関する重要なコメントがある ([`#L434-L443`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/batch_semaphore.rs#L434-L443))。

```rust title="tokio/src/sync/batch_semaphore.rs"
            if remaining > 0 && lock.is_none() {
                // No permits were immediately available, so this permit will
                // (probably) need to wait. We'll need to acquire a lock on the
                // wait queue before continuing. We need to do this _before_ the
                // CAS that sets the new value of the semaphore's `permits`
                // counter. Otherwise, if we subtract the permits and then
                // acquire the lock, we might miss additional permits being
                // added while waiting for the lock.
                lock = Some(self.waiters.lock());
            }
```

**「permit を引く CAS より前に、待ち行列のロックを取る」。**

逆順だとどうなるか。permit を引いて (足りないので全部取って)、それからロックを待つ。その間に誰かが permit を返す。返す側はロックを持っているので、待ち行列を見る。**まだ自分は並んでいない。** だから permit はセマフォのカウンタに戻される。自分はロックを取れた頃には、その permit を見逃している。

**「状態を変える前に、通知を受け取れる場所に自分を置く」。** ロック順序の問題は、こういう「間に何が起こりうるか」を 1 つずつ潰すことでしか解けない。

CAS のループの中でロックを取っているのも変わっている。**ループを回るたびに取り直すのではなく、`lock.is_none()` で 1 回だけ**。CAS が失敗して再試行しても、ロックは持ったままだ。

### 部分的に取った permit を返す

[`#L686-L709`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/batch_semaphore.rs#L686-L709)。

```rust title="tokio/src/sync/batch_semaphore.rs"
impl Drop for Acquire<'_> {
    fn drop(&mut self) {
        // If the future is completed, there is no node in the wait list, so we
        // can skip acquiring the lock.
        if !self.queued {
            return;
        }

        // This is where we ensure safety. The future is being dropped,
        // which means we must ensure that the waiter entry is no longer stored
        // in the linked list.
        let mut waiters = self.semaphore.waiters.lock();

        // remove the entry from the list
        let node = NonNull::from(&mut self.node);
        // Safety: we have locked the wait list.
        unsafe { waiters.queue.remove(node) };

        let acquired_permits = self.num_permits - self.node.state.load(Acquire);
        if acquired_permits > 0 {
            self.semaphore.add_permits_locked(acquired_permits, waiters);
        }
    }
}
```

**「あと何個必要か」を持っていたおかげで、途中で捨てられたときに何個持っていたかが引き算で出る。**

1024 個要求して 700 個集まったところで `select!` の別の枝が完了した、という場合。**700 個をセマフォに返す必要がある。** 返さないと、その 700 個は永久に失われる。

`queued` が false なら早期リターンするのも効いている。**完了済みか未登録なら、リストを触る必要がないのでロックも要らない。** `Drop` はキャンセル時だけでなく正常完了時にも走るので、この分岐が通常経路のコストを消している。

そして [I/O のページ](../io-cancel-safety/) と同じく、**`Drop` でリストから外すことが安全性の要**であることが、コメントで明示されている。

### `!Unpin` と `Sync` の扱い

```rust title="tokio/src/sync/batch_semaphore.rs"
    /// Should not be `Unpin`.
    _p: PhantomPinned,
```

```rust title="tokio/src/sync/batch_semaphore.rs"
// Safety: the `Acquire` future is not `Sync` automatically because it contains
// a `Waiter`, which, in turn, contains an `UnsafeCell`. However, the
// `UnsafeCell` is only accessed when the future is borrowed mutably (either in
// `poll` or in `drop`). Therefore, it is safe (although not particularly
// _useful_) for the future to be borrowed immutably across threads.
unsafe impl Sync for Acquire<'_> {}
```

**「安全だが、特に有用ではない」。** `&Acquire` を他のスレッドに渡せるようにする意味はほとんどないが、`Sync` でないと使えなくなる場面 (他の future に埋め込んだときの自動導出) があるので付けている。

`project` の書き方にも一工夫ある ([`#L666-L683`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/batch_semaphore.rs#L666-L683))。

```rust title="tokio/src/sync/batch_semaphore.rs"
    fn project(self: Pin<&mut Self>) -> (Pin<&mut Waiter>, &Semaphore, usize, &mut bool) {
        fn is_unpin<T: Unpin>() {}
        unsafe {
            // Safety: all fields other than `node` are `Unpin`

            is_unpin::<&Semaphore>();
            is_unpin::<&mut bool>();
            is_unpin::<usize>();
```

**中身が空の関数 `is_unpin::<T>()` を呼ぶだけで、`T: Unpin` をコンパイル時に検査している。**

`unsafe` の安全性根拠が「`node` 以外は `Unpin` である」なので、その前提をコードとして書いておく。将来 `!Unpin` なフィールドが追加されたら、**この行がコンパイルエラーになる**。

コメントに書くだけなら見落とされる。**前提を型検査に変換する** 小技だ。

### 上に載る側

`Mutex` は permit 1 個のセマフォだ。

```rust title="tokio/src/sync/mutex.rs"
            semaphore::Semaphore::new(1)
```

`RwLock` は `MAX_READS` 個。

```rust title="tokio/src/sync/rwlock.rs"
const MAX_READS: u32 = u32::MAX >> 3;
```

```rust title="tokio/src/sync/rwlock.rs"
            debug_assert_ne!(self.mr, 0);
            self.s.acquire(self.mr as usize).await.unwrap_or_else(|_| {
```

**書き込みロックは「読み手の最大数」をまとめて取る。** 読み手が 1 人でもいれば足りないので待つことになり、全員が出ていくと成立する。

`RwLock::with_max_readers(value, n)` で読み手の上限を変えられるのも、この表現の副産物だ。**セマフォの初期 permit 数を変えるだけ** で実現できる。

そして loom の下では `MAX_READS` が 10 になる。[ローカルキュー](../local-run-queue/) の容量 256 が 4 になるのと同じ手で、**検査可能な規模に落としている**。

## なぜそうなっているか

- **1 個のセマフォに集約したのは、待ち行列まわりが最も間違えやすいから。** 侵入型リスト、`Drop` での除去、waker の登録、ロックの順序。これを 4 種類のプリミティブで別々に書けば、4 倍の不具合が入る。
- **`RwLock` を「全 permit の取得」で表せたのは、その表現が排他の意味と一致するから。** 「他に誰もいない」= 「全部の席が空いている」。専用の状態機械を書く代わりに、数の計算で済んでいる。
- **permit を部分的に前渡しするのは、大口の要求を成立させるため。** 「揃うまで取らない」だと、小口が次々に来る限り大口は永久に揃わない。取った分を握らせることで、大口が着実に前進する。
- **待ち行列が FIFO で、先頭が満たされなければ打ち切るのは、追い越しを防ぐため。** 「先頭は無理だから 2 番目に」を許すと、大口が後回しにされ続ける。
- **閉鎖フラグが 2 か所にあるのは、取得の経路が 2 つあるから。** 空いていれば待ち行列を見ずに取れてしまう。その経路にはカウンタのビットでしか伝えられない。そして両方をロックの中で立てないと、中間状態が観測される。
- **permit を引く前にロックを取るのは、その間に返された permit を見逃さないため。** 「状態を変える」より先に「通知を受け取れる場所に並ぶ」。順序を逆にすると、返却と登録がすれ違う。
- **キャンセル時に部分取得分を返すのは、それがセマフォから消えているから。** 待機者が握った permit は、セマフォのカウンタには存在しない。返さなければ、その分だけ容量が永久に減る。
- **`MAX_PERMITS` に使わない予約ビットを残したのは、公開 API だから。** 上限を上げるのは容易だが、下げるのは破壊的変更になる。将来の余地を残すコストが 2 ビットなら安い。

## どう活かすか

- **同期プリミティブは、1 個の汎用な待ち行列に集約する。** ロックも、読み書きロックも、有界チャネルも、「数を取る・返す」で表せる。個別に実装するのは、待ち行列のバグを個数分抱えることを意味する。
- **排他を「全席を取る」として表現できないか考える。** 専用の状態機械を書く前に、既存のカウンタ操作で表せないかを見る。表せれば、公平性や待ち行列の性質もそのまま引き継げる。
- **大口の要求を扱うなら、部分的な前渡しを実装する。** 「揃ってから渡す」は、小口が絶えない環境では永久に揃わない。取った分を握らせて、待ち行列の先頭で打ち切る。この 2 つで飢餓が消える。
- **「閉じた」フラグは、すべての取得経路から見える場所に置く。** 速い経路が待ち行列を迂回するなら、その経路にも伝える手段が要る。そして複数の場所に置くなら、必ず同じロックの中で更新する。
- **状態を変える前に、通知を受け取れる場所に自分を登録する。** 逆順にすると、変更からロック取得までの間の通知が失われる。この種の順序は、コードを読んでも分からないのでコメントに残す。
- **部分的に確保した資源は、キャンセル時に返す。** 「あと何個必要か」を状態として持てば、要求数との差で確保済みの量が分かる。この持ち方は、返却の実装を引き算 1 回にする。
- **`unsafe` の前提を、空関数の型検査に変換する。** `fn is_unpin<T: Unpin>() {}` を呼ぶだけで、「このフィールドは `Unpin` である」という前提が破れたときにコンパイルエラーになる。コメントは読まれないが、型検査は必ず走る。
- **公開する上限値には、将来のためのビットを予約しておく。** 上げるのは簡単だが下げるのは破壊的変更になる。予約の理由を書いておかないと、次の人が「無駄だ」と使い切ってしまう。
