---
title: "Waker のコストを参照カウント 1 個に落とし、同じタスクへの再登録は比較だけで弾く"
description: "Tokio の Waker は、タスク本体へのポインタ 1 個と静的な vtable でできている。poll に渡す Waker は参照カウントを増やさず ManuallyDrop で貸すだけ。wake() は「値で起こす」と「参照で起こす」で状態遷移が別々に用意され、参照カウントの受け渡しが片方だけ違う。vtable が 1 個しかないのは、will_wake の比較を成立させるためでもある。"
sidebar:
  order: 5
---

## 何を学んだか

### どんな状況の話か

`Future::poll` は `Context` を受け取り、そこから `Waker` を取れる。future は「まだ準備ができていない」と判断したら、この `Waker` をどこか (I/O ドライバ、タイマー、チャネルの待ち行列) に **登録してから** `Pending` を返す。準備ができた側が `wake()` を呼ぶと、タスクが再びキューに積まれる。

この `Waker` は、`std` の定義では実質的に「データポインタ + 関数テーブル」だ。

```rust
RawWakerVTable::new(clone, wake, wake_by_ref, drop)
```

素朴に実装すると、こうなる。

- タスクを `Arc<TaskInner>` で持つ。
- `Waker` を作るたびに `Arc::clone` する。
- `poll` に渡す `Waker` も、当然 clone する。

問題は **`poll` のたびに参照カウントを増減する** ことだ。`poll` は最もよく呼ばれる操作で、しかもほとんどの future は `Waker` を保存せずに捨てる (`ready!` で下位に渡すだけ、など)。増やして減らすだけの原子操作が 2 回、毎回積み上がる。

もう 1 つ、地味だが効く問題がある。`Waker::will_wake` だ。チャネルや `Notify` は「すでに登録済みの waker と、今渡された waker が同じタスクを指す」なら再登録を省きたい。標準ライブラリはそのための `will_wake` を提供している。ところが **素朴な実装ではこれがほぼ常に false を返す**。

### Tokio の答え

- **`Waker` のデータポインタは、タスク本体 (`Header`) そのもの。** 別の box を作らない。
- **参照カウントは、タスクの状態語の上位ビット** (前ページの `REF_ONE`)。`Waker` の clone は状態語への `fetch_add` 1 回。
- **`poll` に渡す `Waker` は clone しない。** `ManuallyDrop` に包んで貸すだけ。
- **`RawWakerVTable` はプロセス全体で 1 個の `static`。** これによって `will_wake` の比較が成立する。

## ソースコードのどこか

### vtable は 1 個だけ

[`runtime/task/waker.rs#L118-L124`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/waker.rs#L118-L124)。

```rust title="tokio/src/runtime/task/waker.rs"
static WAKER_VTABLE: RawWakerVTable =
    RawWakerVTable::new(clone_waker, wake_by_val, wake_by_ref, drop_waker);

fn raw_waker(header: NonNull<Header>) -> RawWaker {
    let ptr = header.as_ptr() as *const ();
    RawWaker::new(ptr, &WAKER_VTABLE)
}
```

4 つの関数はどれもジェネリックでない。`NonNull<Header>` を受け取って、タスクの vtable 経由で本来の処理に飛ぶ。**型消去が 2 段になっている** ("`Waker` の vtable" → "タスクの vtable") のは、この 1 個の `static` を成立させるためだ。

### clone は参照カウント 1 回、それだけ

[`#L70-L91`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/waker.rs#L70-L91)。

```rust title="tokio/src/runtime/task/waker.rs"
unsafe fn clone_waker(ptr: *const ()) -> RawWaker {
    // Safety: `ptr` was created from a `Header` pointer in function `waker_ref`.
    let header = unsafe { NonNull::new_unchecked(ptr as *mut Header) };
    unsafe {
        trace!(header, "waker.clone");
    }
    unsafe { header.as_ref() }.state.ref_inc();
    raw_waker(header)
}

unsafe fn drop_waker(ptr: *const ()) {
    let ptr = unsafe { NonNull::new_unchecked(ptr as *mut Header) };
    let raw = unsafe { RawTask::from_raw(ptr) };
    raw.drop_reference();
}
```

**`Waker` の clone = 状態語への `fetch_add(REF_ONE, Relaxed)`。** タスクの参照カウントと `Waker` の参照カウントが同じ 1 個のカウンタなので、`Arc<Task>` を別に持つ必要がない。

`Waker` を 1000 個作っても、増えるのはこのカウンタだけで、ヒープの確保は 0 回だ。

### poll に渡す Waker は「貸す」

[`#L14-L34`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/waker.rs#L14-L34)。

```rust title="tokio/src/runtime/task/waker.rs"
/// Returns a `WakerRef` which avoids having to preemptively increase the
/// refcount if there is no need to do so.
pub(super) fn waker_ref<S>(header: &NonNull<Header>) -> WakerRef<'_, S>
where
    S: Schedule,
{
    // `Waker::will_wake` uses the VTABLE pointer as part of the check. This
    // means that `will_wake` will always return false when using the current
    // task's waker. (discussion at rust-lang/rust#66281).
    //
    // To fix this, we use a single vtable. Since we pass in a reference at this
    // point and not an *owned* waker, we must ensure that `drop` is never
    // called on this waker instance. This is done by wrapping it with
    // `ManuallyDrop` and then never calling drop.
    let waker = unsafe { ManuallyDrop::new(Waker::from_raw(raw_waker(*header))) };

    WakerRef {
        waker,
        _p: PhantomData,
    }
}
```

**このコメントに 2 つの設計判断が凝縮されている。**

1 つ目。`Waker::will_wake` は **vtable のポインタも比較する**。もし vtable がタスクの型ごとに生成されていたら…いや、それでも同じ型なら同じになる、と思うかもしれない。実際に問題になったのは、**単相化のたびに別の `static` が生成されうる** ことだ (`rust-lang/rust#66281` の議論)。結果として、同じタスクの waker 同士でも `will_wake` が false になる。

だから **vtable を 1 個の `static` に固定する**。ジェネリックな関数を vtable に入れるのをやめて、`Header` 経由の間接に統一したのはこのためでもある。

2 つ目。`poll` に渡す `Waker` は **参照カウントを増やさない**。所有権のない `Waker` を作って `ManuallyDrop` で包み、`Deref` だけを提供する。

```rust title="tokio/src/runtime/task/waker.rs"
pub(crate) struct WakerRef<'a, S: 'static> {
    waker: ManuallyDrop<Waker>,
    _p: PhantomData<(&'a Header, S)>,
}

impl<S> ops::Deref for WakerRef<'_, S> {
    type Target = Waker;

    fn deref(&self) -> &Waker {
        &self.waker
    }
}
```

future 側が `Waker` を保存したければ `clone()` を呼ぶ (そこで初めて参照カウントが増える)。保存せずに `wake_by_ref()` だけ呼ぶなら、カウンタは一切動かない。

**「所有権が要るかどうかを、使う側に決めさせる」**。`ManuallyDrop` + ライフタイム付きラッパは、Rust でこれをやるときの定石になっている。

呼び出し側 ([`harness.rs#L207-L210`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L207-L210))。

```rust title="tokio/src/runtime/task/harness.rs"
                let header_ptr = self.header_ptr();
                let waker_ref = waker_ref::<S>(&header_ptr);
                let cx = Context::from_waker(&waker_ref);
                let res = poll_future(self.core(), cx);
```

### 「値で起こす」と「参照で起こす」は別の遷移

`wake()` と `wake_by_ref()` は、参照カウントの扱いが違うので、状態遷移も別々に用意されている ([`harness.rs#L68-L109`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L68-L109))。

```rust title="tokio/src/runtime/task/harness.rs"
    pub(super) fn wake_by_val(&self) {
        use super::state::TransitionToNotifiedByVal;

        match self.state().transition_to_notified_by_val() {
            TransitionToNotifiedByVal::Submit => {
                // The caller has given us a ref-count, and the transition has
                // created a new ref-count, so we now hold two. We turn the new
                // ref-count Notified and pass it to the call to `schedule`.
                //
                // The old ref-count is retained for now to ensure that the task
                // is not dropped during the call to `schedule` if the call
                // drops the task it was given.
                self.schedule();

                // Now that we have completed the call to schedule, we can
                // release our ref-count.
                self.drop_reference();
            }
            TransitionToNotifiedByVal::Dealloc => {
                self.dealloc();
            }
            TransitionToNotifiedByVal::DoNothing => {}
        }
    }
```

**`Dealloc` という分岐があるのが `wake_by_val` 側の特徴だ。** 「完了済みのタスクに対して、最後の `Waker` を消費して `wake()` した」場合、この呼び出しが最後の参照を落とす。つまり `wake()` がメモリ解放を引き起こしうる。

そして **わざと 2 個の参照を持ったまま `schedule()` を呼ぶ**。理由がコメントに書いてある。`schedule()` に渡したタスクが即座に捨てられる (キューが閉じている、シャットダウン中、など) 可能性があり、そこで解放されると `self` が dangling になる。だから自分の分を握ったまま呼んで、戻ってから離す。

`wake_by_ref` 側は素直だ。

```rust title="tokio/src/runtime/task/harness.rs"
    pub(super) fn wake_by_ref(&self) {
        use super::state::TransitionToNotifiedByRef;

        match self.state().transition_to_notified_by_ref() {
            TransitionToNotifiedByRef::Submit => {
                // The transition above incremented the ref-count for a new task
                // and the caller also holds a ref-count. The caller's ref-count
                // ensures that the task is not destroyed even if the new task
                // is dropped before `schedule` returns.
                self.schedule();
            }
            TransitionToNotifiedByRef::DoNothing => {}
        }
    }
```

呼び出し側が参照を持ち続けているので、`Dealloc` は起こりえない。**同じ「起こす」でも、所有権の受け渡しが違えば起こりうる終状態が違う。** それを 2 つの列挙型で表し分けている。

### 何もしない場合でも、ストアはする

`transition_to_notified_by_ref` の中に、一見すると無駄な分岐がある ([`state.rs#L252-L278`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L252-L278))。

```rust title="tokio/src/runtime/task/state.rs"
            } else if snapshot.is_notified() {
                // Even hough we have nothing to do in this branch,
                // wake_by_ref() should synchronize-with the task starting execution,
                // therefore we must use an Release store (with the same value),
                // to pair with the Acquire in transition_to_running.
                (TransitionToNotifiedByRef::DoNothing, Some(snapshot))
```

**すでに `NOTIFIED` が立っているので状態は変わらない。それでも同じ値を書き戻す。**

理由はメモリモデルだ。`wake_by_ref()` を呼ぶ前に書いたデータ (たとえばチャネルに詰めた値) は、タスクが走り出したときに見えていなければならない。`transition_to_running` は `Acquire` で読むので、こちら側に `Release` のストアが要る。**読むだけで済ませると、この synchronizes-with 関係が張れない。**

「何もしないけれど、同じ値を書く」は、コメントがなければ確実に最適化として消される類のコードだ。

### 同じタスクなら再登録しない

`JoinHandle` 側で `will_wake` が実際に使われている ([`harness.rs#L432-L448`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L432-L448))。

```rust title="tokio/src/runtime/task/harness.rs"
        let res = if snapshot.is_join_waker_set() {
            // If JOIN_WAKER is set, then JoinHandle has previously stored a
            // waker in the waker field per step (iii) of rule 5 in task/mod.rs.

            // Optimization: if the stored waker and the provided waker wake the
            // same task, then return without touching the waker field. (Reading
            // the waker field below is safe per rule 3 in task/mod.rs.)
            if unsafe { trailer.will_wake(waker) } {
                return false;
            }
```

`JoinHandle` を `await` するたびに waker を差し替えるのは高い。前ページで見たとおり、waker フィールドの書き換えには `JOIN_WAKER` ビットを落として・書いて・立て直すという 3 段の CAS プロトコルが必要だ。

**`will_wake` が true なら、その全部を飛ばして帰れる。** ループの中で同じ `JoinHandle` を何度も poll する形 (`select!` の中など) では、初回以外はこの比較だけで済む。

そしてこの最適化は、**vtable が 1 個の `static` であることに依存している**。`waker_ref` のコメントが指していたのはこの話で、設計の 2 箇所が同じ理由で繋がっている。

## なぜそうなっているか

- **`Waker` の参照カウントをタスクの状態語に相乗りさせたのは、確保を 0 回にするため。** `Arc<Inner>` を別に持つと、`Waker` を作るたびにその `Arc` のカウンタとタスクのカウンタで 2 系統になる。1 個にまとめれば、clone は `fetch_add` 1 回で、しかも「参照が 0 になった」の判定が状態遷移と同じ CAS に乗る。
- **`poll` に渡す `Waker` を貸し出しにしたのは、大半の future が保存しないから。** 保存する future だけが `clone()` を呼んで代償を払えばよい。全員から前払いさせる形にすると、poll ごとに 2 回の原子操作が乗る。
- **vtable を 1 個の `static` に固定したのは、`will_wake` を機能させるため。** これは性能というより「標準ライブラリの API が期待どおり動く」ための条件で、対応する rust の issue 番号がコメントに書かれている。
- **`wake` と `wake_by_ref` で遷移を分けたのは、参照カウントの授受が違うから。** 値で受け取る側は「自分が最後の 1 個かもしれない」を考慮する必要があり、`Dealloc` という終状態が増える。同じ関数にまとめると、この違いが実行時の分岐に化けて分かりにくくなる。
- **`schedule()` の間だけ余分な参照を握るのは、渡した先で捨てられうるから。** シャットダウン中のキューは、受け取ったタスクを即座に落とす。自分の分を先に手放していると、`schedule()` から戻った時点で `self` が消えている。
- **状態が変わらない場合でも書き戻すのは、メモリ順序のため。** `wake_by_ref` の前の書き込みが、タスクの実行開始時に見える必要がある。`Release` ストアがないと、その保証が成立しない。

## どう活かすか

- **通知ハンドルの参照カウントを、本体のカウンタに相乗りさせられないか考える。** ハンドルが本体より長生きしないなら、別のカウンタを持つ意味は薄い。1 個にまとめると、「最後のハンドルが消えた」と「本体を解放してよい」が同じ判定になる。
- **借用で足りる場面に、所有権を前払いさせない。** `ManuallyDrop` + ライフタイム付きラッパで「所有していない参照」を作り、必要な人にだけ `clone()` させる。ホットパスの原子操作は、これだけで半分になることがある。
- **同一性の比較で高い処理を飛ばせる場所を探す。** 「すでに登録されているものと同じか」を安く判定できれば、登録処理そのものを省ける。ただし、その比較が成立する条件 (ここでは vtable が 1 個であること) は設計上の制約として明記しておく。
- **所有権の受け渡しが違う操作は、別の関数・別の返り値型にする。** 「値で渡す版」と「参照で渡す版」は、起こりうる終状態が違う。1 つにまとめると、呼び出し側が自分に関係ない分岐の面倒を見ることになる。
- **コールバックにハンドルを渡すときは、自分の分の参照を握ったまま呼ぶ。** 渡した先が即座に捨てる可能性があるなら、呼び出しから戻るまで自分が生きている保証を作っておく。
- **「何もしないが、同じ値を書き戻す」コードには、必ず理由を書く。** メモリ順序のためのストアは、見た目が完全に無駄で、コメントがなければ削除される。同期の相手 (どの `Acquire` と対になるか) まで書いておくとよい。
