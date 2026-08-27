---
title: "待ち行列の要素を future 自身のスタックに置き、途中で捨てられても取りこぼさない"
description: "select! の中で readable() を待つコードは、別の枝が先に完了するたびにその future を捨てる。捨てられた future は待ち行列から自分を外すが、通知はもう届いているかもしれない。Tokio は「イベントの実体は共有のアトミック変数にあり、waker はその存在を知らせるだけ」という分担にすることで、この取りこぼしを構造的に起きなくしている。"
group: "ドライバ"
sidebar:
  order: 15
---

## 何を学んだか

### どんな状況の話か

`select!` は、複数の future を同時に待って、最初に完了したものを採用する。

```rust
tokio::select! {
    _ = socket.readable() => { /* ... */ }
    _ = interval.tick()   => { /* ... */ }
}
```

このとき、**採用されなかったほうの future は捨てられる**。`interval.tick()` が先に完了したら、`socket.readable()` は poll の途中の状態のまま drop される。

ここに、非同期プログラミングで最も事故が多い論点がある。**キャンセル安全性 (cancellation safety)** だ。

危ないのは、こういう実装をしていた場合だ。

1. `readable()` の future が、自分の waker を fd の待ち行列に登録する。
2. `Pending` を返す。
3. **ドライバが「読める」を検出し、待ち行列から waker を取り出して `wake()` する。**
4. だがタスクが走る前に、別の枝が完了して `readable()` の future が捨てられる。
5. 次のループでまた `readable()` を呼ぶ。

**3 で取り出された「読める」という情報は、どこへ行ったのか。**

waker の呼び出しだけで通知を表現していると、この情報は消える。5 で作り直した future は、次のイベントが来るまで待ち続ける。エッジトリガなので、次のイベントは来ないかもしれない。**接続がハングする。**

### Tokio の答え

**イベントの実体を、共有のアトミック変数に置く。**

[前ページ](../scheduled-io/) で見た `readiness` がそれだ。ドライバは「読める」を **状態として** 書き込む。waker は「状態が変わったので見に来てください」を伝えるだけで、**情報を運んでいない**。

だから future が捨てられても、失われるものが何もない。次に作った future は、最初に readiness を読んで、立っていればその場で完了する。

この分担のうえで、待ち行列の管理を **future 自身のメモリ** でやる。

- 待ち行列のノード (`Waiter`) は、`Readiness` future の中に埋め込まれている。
- 登録は「そのノードへのポインタをリストに繋ぐ」。ヒープ確保なし。
- **`Drop` でリストから自分を外す。** これで、捨てられた future のノードが残らない。

## ソースコードのどこか

### 待ち行列のノードは future の中にある

[`runtime/io/scheduled_io.rs#L146-L160`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L146-L160)。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
/// Future returned by `readiness()`.
struct Readiness<'a> {
    scheduled_io: &'a ScheduledIo,

    state: State,

    /// Entry in the waiter `LinkedList`.
    waiter: UnsafeCell<Waiter>,
}

enum State {
    Init,
    Waiting,
    Done,
}
```

**`Waiter` が future のフィールドとして埋まっている。** future 自体は呼び出し元のスタック (あるいは、それを含むタスクのメモリ) に置かれるので、待ち行列に繋ぐためのメモリ確保が発生しない。

これが成立するには、future が動かないことが要る。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
struct Waiter {
    pointers: linked_list::Pointers<Waiter>,

    /// The waker for this task.
    waker: Option<Waker>,

    /// The interest this waiter is waiting on.
    interest: Interest,

    is_ready: bool,

    /// Should never be `Unpin`.
    _p: PhantomPinned,
}
```

**`PhantomPinned` で `!Unpin` にする。** これで `Pin<&mut Self>` から中身を動かせなくなり、リストに入れたポインタが有効であり続ける。

`unsafe` の使い方についてのコメントも率直だ。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
            // Safety: `Self` is `!Unpin`
            //
            // While we could use `pin_project!` to remove
            // this unsafe block, there are already unsafe blocks here,
            // so it wouldn't significantly ease the mental burden
            // and would actually complicate the code.
            // That's why we didn't use it.
            let me = unsafe { self.get_unchecked_mut() };
```

**「安全な代替手段があるが、周りがすでに unsafe だらけなので、導入しても負担は減らずコードが複雑になるだけ」。** 判断とその理由が書いてある。

### 3 状態の遷移

[`#L442-L505`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L442-L505)。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
                State::Init => {
                    // Optimistically check existing readiness
                    let curr = scheduled_io.readiness.load(SeqCst);
                    let is_shutdown = SHUTDOWN.unpack(curr) != 0;

                    // Safety: `waiter.interest` never changes
                    let interest = unsafe { (*waiter.get()).interest };
                    let ready = Ready::from_usize(READINESS.unpack(curr)).intersection(interest);

                    if !ready.is_empty() || is_shutdown {
                        // Currently ready!
                        let tick = TICK.unpack(curr) as u8;
                        *state = State::Done;
                        return Poll::Ready(ReadyEvent { tick, ready, is_shutdown });
                    }

                    // Wasn't ready, take the lock (and check again while locked).
                    let mut waiters = scheduled_io.waiters.lock();
```

**まずロックなしで readiness を読む。** 立っていればその場で完了する。これが「捨てられた future の代わりに作り直した future」が通る経路だ。**前の future が受け取った通知は、この共有変数に残っている。**

立っていなければロックを取り、**取ってからもう一度読む**。ここも前ページと同じ二度読みだ。それでも空なら、waker をノードに書いてリストに繋ぐ。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
                State::Waiting => {
                    // Currently in the "Waiting" state, implying the caller has
                    // a waiter stored in the waiter list (guarded by
                    // `notify.waiters`). In order to access the waker fields,
                    // we must hold the lock.

                    let waiters = scheduled_io.waiters.lock();

                    // Safety: With the lock held, we have exclusive access to
                    // the waiter. In other words, `ScheduledIo::wake()`
                    // cannot access the waiter concurrently.
                    let w = unsafe { &mut *waiter.get() };

                    if w.is_ready {
                        // Our waker has been notified.
                        *state = State::Done;
                    } else {
                        // Update the waker, if necessary.
                        w.waker.as_mut().unwrap().clone_from(cx.waker());
                        return Poll::Pending;
                    }
```

再 poll されたとき、**「自分は起こされたのか」を `is_ready` フラグで確かめる**。前ページで見たとおり、ドライバは waker を取り出す前にこのフラグを立てる。

立っていなければ、単なる空振りの poll (別の理由でタスクが起こされた) なので、waker を更新して `Pending` に戻る。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
                    // Explicit drop of the lock to indicate the scope that the
                    // lock is held. Because holding the lock is required to
                    // ensure safe access to fields not held within the lock, it
                    // is helpful to visualize the scope of the critical
                    // section.
                    drop(waiters);
```

**明示的な `drop` にコメントが付いている。** スコープの終わりで自動的に落ちるのに、あえて書く。理由は「ロックが `waiters` の外側のフィールドへの安全なアクセスを保証しているので、その範囲を目に見えるようにするため」。

`Mutex<Waiters>` が守っているのは `Waiters` の中身だけではない。**`UnsafeCell<Waiter>` (future 側にある) へのアクセス権も、このロックが与えている。** 型の上では見えない関係なので、コードの見た目で補っている。

### `Drop` が待ち行列から自分を外す

[`#L566-L577`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/scheduled_io.rs#L566-L577)。

```rust title="tokio/src/runtime/io/scheduled_io.rs"
impl Drop for Readiness<'_> {
    fn drop(&mut self) {
        let mut waiters = self.scheduled_io.waiters.lock();

        // Safety: `waiter` is only ever stored in `waiters`
        unsafe {
            waiters
                .list
                .remove(NonNull::new_unchecked(self.waiter.get()))
        };
    }
}
```

**11 行。これが `select!` でのキャンセル安全性を支えている。**

future が捨てられると、そのメモリは無効になる。リストにポインタが残っていたら、次にドライバが走査したときに解放済みメモリを読む。だから **必ず外す**。

`remove` はリストに入っていない要素に対しても安全に呼べる (`Pointers` が繋がっていなければ何もしない) ので、`State::Init` のまま捨てられた場合も問題ない。

そして、**このとき「通知を受け取ったのに使わなかった」ことは何も問題を起こさない**。通知の実体は `readiness` に残っているからだ。

### 使う側のループ

[`runtime/io/registration.rs#L214-L234`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/registration.rs#L214-L234)。

```rust title="tokio/src/runtime/io/registration.rs"
    pub(crate) async fn async_io<R>(
        &self,
        interest: Interest,
        mut f: impl FnMut() -> io::Result<R>,
    ) -> io::Result<R> {
        loop {
            let event = self.readiness(interest).await?;

            let coop = std::future::poll_fn(crate::task::coop::poll_proceed).await;

            match f() {
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                    self.clear_readiness(event);
                }
                x => {
                    coop.made_progress();
                    return x;
                }
            }
        }
    }
```

**「準備完了を待つ → 実際にやってみる → `WouldBlock` なら readiness を消してやり直す」。**

`clear_readiness(event)` に渡している `event` が、[前ページ](../scheduled-io/) の tick を持っている。`readiness()` が返した時点の世代なので、その間に新しい通知が来ていれば消去は空振りし、ループが即座に次の試行に入る。

[協調予算](../coop-budget/) の消費もここにある。`f()` が成功したときだけ `made_progress()` を呼ぶ。**空振り (`WouldBlock`) では予算を消費しない。**

`poll_ready` 側も同じ形をしている。

```rust title="tokio/src/runtime/io/registration.rs"
    fn poll_ready(
        &self,
        cx: &mut Context<'_>,
        direction: Direction,
    ) -> Poll<io::Result<ReadyEvent>> {
        ready!(crate::trace::trace_leaf());
        // Keep track of task budget
        let coop = ready!(crate::task::coop::poll_proceed(cx));
        let ev = ready!(self.shared.poll_readiness(cx, direction));

        if ev.is_shutdown {
            return Poll::Ready(Err(gone()));
        }

        coop.made_progress();
        Poll::Ready(Ok(ev))
    }
```

**`ready!` が 3 段続く。** トレース、予算、readiness。どれも `Pending` なら即座に返る。予算のページで見たとおり、`poll_proceed` が `Poll` を返す設計にしたことで、こう書ける。

### 制約は型で表せないので、doc に書く

[`registration.rs#L28-L33`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/registration.rs#L28-L33)。

```rust title="tokio/src/runtime/io/registration.rs"
    /// **Note**: while `Registration` is `Sync`, the caller must ensure that
    /// there are at most two tasks that use a registration instance
    /// concurrently. One task for [`poll_read_ready`] and one task for
    /// [`poll_write_ready`]. While violating this requirement is "safe" from a
    /// Rust memory safety point of view, it will result in unexpected behavior
    /// in the form of lost notifications and tasks hanging.
```

**「メモリ安全性の観点では安全だが、通知が失われてタスクがハングする」。**

前ページで見た `reader`/`writer` の専用枠は 1 個ずつしかないので、3 個目のタスクが登録すると前の waker が上書きされる。上書きされたタスクは二度と起きない。

**`unsafe` にはできない (メモリは壊れない) が、正しくない。** その種の制約は doc に書くしかなく、しかも「何が起きるか」まで具体的に書いてある。

`async fn readiness()` のほうは連結リストなので、この制限がない。**同じリソースに対して、制約の強い速い経路と、制約のない経路の両方が用意されている。**

### 参照の循環を切る

[`#L241-L252`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/registration.rs#L241-L252)。

```rust title="tokio/src/runtime/io/registration.rs"
impl Drop for Registration {
    fn drop(&mut self) {
        // It is possible for a cycle to be created between wakers stored in
        // `ScheduledIo` instances and `Arc<driver::Inner>`. To break this
        // cycle, wakers are cleared. This is an imperfect solution as it is
        // possible to store a `Registration` in a waker. In this case, the
        // cycle would remain.
        //
        // See tokio-rs/tokio#3481 for more details.
        self.shared.clear_wakers();
    }
}
```

**参照カウント方式のリークが、ここで具体的に出ている。**

`ScheduledIo` は waker を持つ。waker はタスクを指す。タスクは `Registration` を持ちうる。`Registration` は `ScheduledIo` を持つ。**環ができるとどれも解放されない。**

対策は「`Registration` が落ちるときに waker を消す」。そして **「これは不完全な解決策だ」と自分で書いている**。waker の中に `Registration` を入れられてしまえば環は残る。

issue 番号付きで、限界を明示したうえでの対処。**「直った」ではなく「多くの場合は防げる」と書く**のが誠実な形だ。

## なぜそうなっているか

- **イベントを状態として持つのは、future が捨てられうるから。** 通知を「waker を呼ぶ」という一過性の行為だけで表すと、受け取った future が捨てられた時点で情報が消える。共有変数に書いておけば、次に来た誰かが読める。
- **待ち行列のノードを future の中に置いたのは、確保を避けるため。** 待つたびにヒープ確保していたら、ソケット 1 万本のサーバでは無視できない。`!Unpin` にすることで、ポインタの有効性が型で守られる。
- **`Drop` で必ずリストから外すのは、future のメモリが消えるから。** 侵入型リストは、要素のメモリが有効であることに依存している。外し忘れは即座に解放済みメモリの読み取りになる。
- **`is_ready` フラグがあるのは、poll の理由が分からないから。** タスクは他の理由でも起こされる。「自分の待っていたイベントが来たのか」を、フラグとして明示的に持つ必要がある。
- **ロックのスコープを明示的な `drop` で示すのは、ロックの守備範囲が型に現れないから。** `Mutex<Waiters>` が守っているのは、`Waiters` の外にある `UnsafeCell<Waiter>` でもある。この関係はコンパイラに伝えられないので、コードの見た目とコメントで補う。
- **成功したときだけ予算を消費するのは、空振りを罰しないため。** `WouldBlock` は「準備完了だと思ったが違った」で、進捗ではない。
- **型で表せない制約は doc に書き、破ったときに何が起きるかまで書く。** 「2 タスクまで」は Rust の型で表現できない。ハングするという結果を書いておかないと、制約の重さが伝わらない。
- **参照循環の対処を「不完全」と明記するのは、完全な解決がないから。** 環の一部を切っても、別の経路で環ができうる。「対処した」とだけ書くと、次にリークを踏んだ人がこのコードを疑わなくなる。

## どう活かすか

- **通知は「状態」として持ち、waker は「見に来て」だけを伝える。** これが崩れると、通知を受け取った側が捨てられた瞬間に情報が消える。`select!` やタイムアウトのように future を捨てる構文がある環境では、この分担が事実上の必須条件になる。
- **待ち行列のノードは、待つ側のメモリに埋め込む。** 待機のたびに確保するのは高い。`!Unpin` にしてポインタで繋げば、確保 0 回で任意個数の待機者を扱える。
- **侵入型の待ち行列を使うなら、`Drop` で外すのを最優先で実装する。** これを忘れた設計は、キャンセルされた瞬間に未定義動作になる。逆にここさえ正しければ、キャンセル安全性はほぼ自動的についてくる。
- **「自分が起こされたのか」を、待つ側のノードにフラグとして持たせる。** 起床の理由は複数あるので、waker が呼ばれたこと自体は証拠にならない。
- **ロックが「そのロックの中にないデータ」を守っているなら、スコープを明示的に示す。** 型で表現できない保護関係は、`drop()` の明示とコメントでしか伝えられない。
- **同じリソースに、制約の強い速い経路と、制約のない経路を両方用意してよい。** `&mut self` を要求できる場面では専用枠、共有で待ちたい場面では待ち行列。使う側が選べる。
- **型で表せない使用条件は、破ったときの症状まで doc に書く。** 「安全だが正しくない」の領域は Rust でも普通に存在する。症状 (ハングする、通知が失われる) を書いておくと、デバッグ時にこの doc に辿り着ける。
- **参照循環への対処が不完全なら、不完全だと書く。** 完全でないことを隠すと、次にリークを踏んだ人が原因の候補からここを外してしまう。
