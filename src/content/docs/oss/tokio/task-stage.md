---
title: "Future と出力を同じ場所に置き換えると、完了時のコピーも追加の確保も要らなくなる"
description: "タスクの中で future が置かれている領域は、完了した瞬間に出力の置き場に変わる。Running / Finished / Consumed の 3 状態を持つ enum 1 個で表され、排他は状態語の RUNNING ビットが兼ねる。誰も出力を欲しがっていなければ、その場で捨てる。型が消えた vtable 越しに出力を返すために、返り値をスタックに置いてからポインタで渡す、という反転した呼び出し規約まで使われている。"
group: "タスク"
sidebar:
  order: 4
---

## 何を学んだか

### どんな状況の話か

タスクは future を実行して、出力を作る。この 2 つは寿命が重ならない。

- future が生きている間、出力はまだ存在しない。
- 出力ができた瞬間、future は用済みになる (`poll` が `Ready` を返したら二度と poll してはいけない)。

素朴に書くと、タスク構造体に両方のフィールドを持つ。

```rust
struct Task<T: Future> {
    future: Option<T>,
    output: Option<T::Output>,
}
```

これは **常に両方分のメモリを消費する**。しかも `T` が大きな `async` ブロック (数 KB になることは珍しくない) なら、その分がずっと居座る。

さらに面倒なのが所有権だ。出力を受け取るのは `JoinHandle` だが、`JoinHandle` は **すでに捨てられているかもしれない**。捨てられていたら誰も出力を取りに来ないので、タスク側で捨てなければならない。そして「捨てられたか」は、`JoinHandle` を捨てるスレッドとタスクを完了させるスレッドが同時に判断しうる。

### Tokio の答え

**同じ領域を 3 つの状態で使い回す。**

```rust title="tokio/src/runtime/task/core.rs"
/// Either the future or the output.
#[repr(C)] // https://github.com/rust-lang/miri/issues/3780
pub(super) enum Stage<T: Future> {
    Running(T),
    Finished(super::Result<T::Output>),
    Consumed,
}
```

サイズは `max(size_of::<T>(), size_of::<Result<T::Output>>())` + タグ。future と出力の両方を同時に持たない。

そして「誰が今この領域に触ってよいか」は、**前ページの状態語がそのまま決めている**。追加のロックはない。

```text title="tokio/src/runtime/task/mod.rs"
//!  * If COMPLETE is one, then the `JoinHandle` has exclusive access to the
//!    stage field. If COMPLETE is zero, then the RUNNING bitfield functions as
//!    a lock for the stage field, and it can be accessed only by the thread
//!    that set RUNNING to one.
```

**`COMPLETE` ビットが 0 か 1 かで、この領域の所有者が「ワーカー」から「`JoinHandle`」に切り替わる。** 状態語 1 語の 1 ビットが、メモリの所有権移転を表している。

## ソースコードのどこか

### poll したら、その場で future を捨てる

[`runtime/task/core.rs#L367-L389`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/core.rs#L367-L389)。

```rust title="tokio/src/runtime/task/core.rs"
    pub(super) fn poll(&self, mut cx: Context<'_>) -> Poll<T::Output> {
        let res = {
            self.stage.stage.with_mut(|ptr| {
                // Safety: The caller ensures mutual exclusion to the field.
                let future = match unsafe { &mut *ptr } {
                    Stage::Running(future) => future,
                    _ => unreachable!("unexpected stage"),
                };

                // Safety: The caller ensures the future is pinned.
                let future = unsafe { Pin::new_unchecked(future) };

                let _guard = TaskIdGuard::enter(self.task_id);
                future.poll(&mut cx)
            })
        };

        if res.is_ready() {
            self.drop_future_or_output();
        }

        res
    }
```

**`Ready` が返ってきたら、その場で future を破棄する。** 出力を書き込むより先に、まず future を捨てる。

なぜ順序がこうなるかというと、この関数が返す `Poll<T::Output>` は **出力を値で持って帰る** からだ。future の中に出力が入っているわけではないので、先に捨てて構わない。呼び出し側が `Ok`/`Err` に包んでから、改めて書き戻す。

`Pin::new_unchecked` の正当性は「タスクがヒープ上にあり、動かないこと」に依存している。これは `Cell` が `Box` で確保されていることから来る。

### 出力を書き戻す、あるいは捨てる

[`#L391-L435`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/core.rs#L391-L435)。

```rust title="tokio/src/runtime/task/core.rs"
    /// Drops the future.
    pub(super) fn drop_future_or_output(&self) {
        // Safety: the caller ensures mutual exclusion to the field.
        unsafe {
            self.set_stage(Stage::Consumed);
        }
    }

    /// Stores the task output.
    pub(super) fn store_output(&self, output: super::Result<T::Output>) {
        // Safety: the caller ensures mutual exclusion to the field.
        unsafe {
            self.set_stage(Stage::Finished(output));
        }
    }

    /// Takes the task output.
    pub(super) fn take_output(&self) -> super::Result<T::Output> {
        use std::mem;

        self.stage.stage.with_mut(|ptr| {
            // Safety:: the caller ensures mutual exclusion to the field.
            match mem::replace(unsafe { &mut *ptr }, Stage::Consumed) {
                Stage::Finished(output) => output,
                _ => panic!("JoinHandle polled after completion"),
            }
        })
    }
```

**関数名が `drop_future_or_output` になっているのが、この設計を端的に表している。** 呼び出し側は「今そこに future が入っているか出力が入っているか」を気にしなくてよい。どちらであっても `Consumed` に置き換えれば正しく落ちる。

`take_output` の `mem::replace` も同じで、取り出しと `Consumed` への遷移が 1 つの式になっている。二重に取り出したら `Stage::Consumed` にマッチして panic する。**「JoinHandle を完了後にもう一度 poll した」という API 誤用が、メッセージ付きで検出される。**

### 誰も欲しがっていない出力は、その場で捨てる

タスク完了時の分岐 ([`harness.rs#L330-L365`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L330-L365))。

```rust title="tokio/src/runtime/task/harness.rs"
    fn complete(self) {
        // The future has completed and its output has been written to the task
        // stage. We transition from running to complete.
        let snapshot = self.state().transition_to_complete();

        // We catch panics here in case dropping the future or waking the
        // JoinHandle panics.
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            if !snapshot.is_join_interested() {
                // The `JoinHandle` is not interested in the output of
                // this task. It is our responsibility to drop the
                // output. The join waker was already dropped by the
                // `JoinHandle` before.
                self.core().drop_future_or_output();
            } else if snapshot.is_join_waker_set() {
                // Notify the waker. Reading the waker field is safe per rule 4
                // in task/mod.rs, since the JOIN_WAKER bit is set and the call
                // to transition_to_complete() above set the COMPLETE bit.
                self.trailer().wake_join();
```

判断の材料は、**`transition_to_complete()` が返したスナップショット** だ。`COMPLETE` を立てた瞬間の値を、その CAS の返り値として持っている。

これが重要で、「`COMPLETE` を立ててから、改めて `JOIN_INTEREST` を読む」ではない。それだと読むまでの間に `JoinHandle` が捨てられて、**両方が「相手が捨てるだろう」と思ってリークする**、あるいは両方が捨ててニ重解放になる。

**同じ RMW の返り値で判断するから、「`COMPLETE` を立てたのは自分で、そのとき `JOIN_INTEREST` は 0 だった」が不可分な事実になる。** 逆に `JoinHandle` 側は、`JOIN_INTEREST` を落とす CAS の返り値で `COMPLETE` を見て、自分が捨てる番かを知る ([`state.rs#L385-L420`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L385-L420))。

```rust title="tokio/src/runtime/task/state.rs"
            if !snapshot.is_complete() {
                // If `COMPLETE` is unset we also unset `JOIN_WAKER` to give the
                // `JoinHandle` exclusive access to the waker following rule 6 in task/mod.rs.
                snapshot.unset_join_waker();
            } else {
                // If `COMPLETE` is set the task is completed so the `JoinHandle` is responsible
                // for dropping the output.
                transition.drop_output = true;
            }
```

**どちらが先に着いたかで、後から着いたほうが掃除する。** そして「どちらが先だったか」は 1 語への RMW の順序で決まるので、曖昧さがない。

`catch_unwind` で囲まれているのは、**出力の `Drop` がパニックしうる** からだ。ここでパニックを漏らすと、参照カウントの後始末をせずにワーカースレッドを巻き込むことになる。

### Send でない出力が、他のスレッドで落ちないこと

`drop_join_handle_slow` の側にも同じ話がある ([`harness.rs#L287-L305`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L287-L305))。

```rust title="tokio/src/runtime/task/harness.rs"
        if transition.drop_output {
            // It is our responsibility to drop the output. This is critical as
            // the task output may not be `Send` and as such must remain with
            // the scheduler or `JoinHandle`. i.e. if the task output remains in the
            // task structure until the task is deallocated, it may be dropped
            // by a Waker on any arbitrary thread.
            //
            // Panics are delivered to the user via the `JoinHandle`. Given that
            // they are dropping the `JoinHandle`, we assume they are not
            // interested in the panic and swallow it.
            let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                self.core().drop_future_or_output();
            }));
        }
```

**「出力を放置してはいけない」理由が書かれている。** タスク本体を解放するのは「最後の参照を落とした者」で、それは任意のスレッドの `Waker` かもしれない。出力が `Stage::Finished` のまま残っていると、その `Waker` を落としたスレッドで出力の `Drop` が走る。`!Send` な出力なら、これは不正だ。

だから **出力の破棄は、必ず「タスクを完了させたスレッド」か「`JoinHandle` を持っているスレッド」でやる**。そのどちらかであることは `task/mod.rs` の "Non-Send output" 節で 3 段の論証として書かれている。

「パニックを握り潰す理由」まで書いてあるのも良い。`JoinHandle` を捨てる = 結果に興味がない、なのでパニックも届けようがない。

### 型が消えた先から値を持って帰る

`JoinHandle::poll` の実装 ([`join.rs#L327-L354`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/join.rs#L327-L354))。

```rust title="tokio/src/runtime/task/join.rs"
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        ready!(crate::trace::trace_leaf());
        let mut ret = Poll::Pending;

        // Keep track of task budget
        let coop = ready!(crate::task::coop::poll_proceed(cx));

        // Try to read the task output. If the task is not yet complete, the
        // waker is stored and is notified once the task does complete.
        //
        // The function must go via the vtable, which requires erasing generic
        // types. To do this, the function "return" is placed on the stack
        // **before** calling the function and is passed into the function using
        // `*mut ()`.
        //
        // Safety:
        //
        // The type of `T` must match the task's output type.
        unsafe {
            self.raw.try_read_output(&mut ret, cx.waker());
        }
```

**返り値の置き場をスタックに用意してから、そのポインタを型消去して渡す。**

`vtable` のエントリは `unsafe fn(NonNull<Header>, *mut (), &Waker)` という署名で、出力の型 `T` がどこにも出てこない。値を返そうとすると署名に型が現れてしまうので、返せない。だから **呼び出し側が置き場を作り、呼ばれた側が書き込む**。C の out パラメータと同じ形だ。

書き込む側 ([`harness.rs#L280-L285`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L280-L285))。

```rust title="tokio/src/runtime/task/harness.rs"
    /// Read the task output into `dst`.
    pub(super) fn try_read_output(self, dst: &mut Poll<super::Result<T::Output>>, waker: &Waker) {
        if can_read_output(self.header(), self.trailer(), waker) {
            *dst = Poll::Ready(self.core().take_output());
        }
    }
```

`Harness<T, S>` の中では `T::Output` が普通に見えているので、`dst` に代入するだけでよい。**型が消えているのは境界の 1 行だけで、両側では型が付いている。**

初期値が `Poll::Pending` なのも効いている。呼ばれた側が「まだ完了していない」場合は **何も書かずに帰るだけ** でよく、その旨を返す経路が要らない。

## なぜそうなっているか

- **future と出力で領域を共有するのは、両方が同時に存在しないから。** `async` ブロックの状態機械は数 KB になることがあり、それを完了後も保持し続けるのは無駄だ。`enum` にすれば、この排他性が型として表現され、コンパイラがタグの管理をやってくれる。
- **排他制御に専用のロックを置かないのは、状態語がすでに同じ情報を持っているから。** `RUNNING` を立てられた者が future を触ってよく、`COMPLETE` が立ったら `JoinHandle` に移る。ロックを別に持つと、状態語との整合を保つ責任が増える。
- **完了時の分岐材料を「その CAS の返り値」にしているのは、判断と遷移を不可分にするため。** 立ててから読み直すと、その隙間に相手が消えうる。掃除の担当が二重になるか、誰もいなくなる。
- **`!Send` な出力を「解放するスレッド」に任せないのは、それが任意のスレッドだから。** タスクの最終参照を落とすのは `Waker` かもしれない。だから出力は、担当が確定した時点で、そのスレッドで捨てる。
- **out パラメータで返しているのは、vtable の署名に出力型を出せないから。** 値返しにすると `unsafe fn(...) -> Poll<Result<T::Output>>` となり、`T` ごとに署名が変わってテーブルに入らない。`*mut ()` に潰して渡すのが唯一の道になる。
- **`Poll::Pending` を初期値にしているのは、「書かない」を「未完了」の表現にするため。** 呼ばれた側の失敗経路が「何もせず帰る」になり、エラー型も分岐も要らなくなる。
- **`Drop` をパニック捕捉で囲むのは、ユーザーのコードがそこで走るから。** 出力の `Drop` は任意のユーザーコードで、パニックしうる。それがランタイムの後始末を飛ばすと、参照カウントが狂ってリークや二重解放になる。

## どう活かすか

- **寿命が重ならない 2 つの値は、`enum` で同じ領域に置く。** `Option<A>` と `Option<B>` を並べると、両方が `None` の期間も両方分のメモリを食う。しかも「両方 `Some`」という到達不能な状態が型の上で表現できてしまう。
- **「今そこに何が入っているか」を呼び出し側に意識させない関数名を付ける。** `drop_future_or_output` は、状態を知らなくても呼べる。個別に `drop_future` と `drop_output` を用意すると、呼ぶ前に状態を調べる分岐が呼び出し側に散る。
- **取り出しと「取り出し済み」への遷移を、1 つの式にする。** `mem::replace`/`take` を使えば、二重取り出しが自然に検出できる。「取ってからフラグを落とす」だと、その間に割り込まれるか、落とし忘れる。
- **後片付けの担当を決める分岐は、状態を変えた RMW の返り値で行う。** 「変えてから読む」は、読むまでの間に相手が状態を変えうる。担当の重複や欠落は、たいていこの隙間から生まれる。
- **型消去した境界を値が跨ぐときは、返り値の置き場を呼び出し側に用意させる。** 型パラメータが署名に出てしまう関数は、テーブルに入らない。out パラメータにすれば署名から型が消え、初期値を「何もなかった場合の答え」にできる。
- **ユーザーコードが走りうる後始末は、パニック捕捉で囲む。** `Drop` はユーザーコードだ。そこで巻き戻しが始まると、その後ろにある参照カウントの整理が飛ぶ。握り潰すなら、なぜ握り潰してよいかを添える。
