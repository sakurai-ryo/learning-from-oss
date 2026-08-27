---
title: "ライフサイクル・参照カウント・通知の有無を 1 語のアトミックに詰めると、状態遷移が 1 回の CAS で済む"
description: "Tokio のタスクは、実行中か・完了したか・キューに積まれているか・JoinHandle が生きているか・参照が何個あるかを、すべて 1 個の AtomicUsize に入れている。そのおかげで「まだ走っていないなら走らせる、走っているなら通知フラグだけ立てる」といった判断が 1 回の compare_exchange で終わる。状態を分けて持ったら、この判断はロックなしでは書けない。"
sidebar:
  order: 2
---

## 何を学んだか

### どんな状況の話か

`tokio::spawn(async { ... })` で作られたタスクは、ヒープ上の 1 個のオブジェクトだ。このオブジェクトを触る主体は、同時に何人もいる。

- **ワーカースレッド**: キューから取り出して poll する。
- **`Waker` を持っている誰か**: I/O ドライバ、タイマー、他のタスク。何個あるか分からないし、どのスレッドから叩かれるかも分からない。
- **`JoinHandle`**: 完了を待っている。出力を取り出す権利を持つ。
- **`AbortHandle`**: いつでもキャンセルできる。
- **ランタイム自身**: シャットダウン時に全部のタスクを畳む。

これらが同時に来たときの判断は、意外と細かい。

- タスクが **今まさに poll 中** に `wake()` が呼ばれたら、キューに積んではいけない。二重に走ってしまう。代わりに「通知が来た」という印だけ残して、poll し終えたワーカーに再スケジュールさせる。
- タスクが **完了済み** なら、`wake()` は何もしてはいけない。
- **すでにキューに積まれている** なら、もう一度積んではいけない。
- そして、これらすべての判断のたびに **参照カウントを正しく増減** しなければならない。最後の 1 個を落とした者がメモリを解放する。

素朴に書くなら、`Mutex<TaskState>` を持たせて中で分岐する。だが `wake()` は I/O ドライバのホットパスから毎回呼ばれる。ここでロックを取るのは論外だ。

### Tokio の答え

**全部を 1 個の `AtomicUsize` に詰める。**

```rust title="tokio/src/runtime/task/state.rs"
const RUNNING: usize = 0b0001;
const COMPLETE: usize = 0b0010;
const NOTIFIED: usize = 0b100;
const JOIN_INTEREST: usize = 0b1_000;
const JOIN_WAKER: usize = 0b10_000;
const CANCELLED: usize = 0b100_000;
```

下位 6 ビットが状態、**残り全部が参照カウント**。そして、すべての状態遷移が「現在値を読む → 次の値を計算する → `compare_exchange` する」の 1 パターンで書かれている。

この形にすると、さっきの判断がこう表現できる。

- 「走っていないなら走らせる、走っているなら通知だけ立てる」→ 読んだ値の `RUNNING` ビットを見て、次の値を作り分けて、1 回の CAS で確定する。
- 「通知を立てるついでに参照カウントを 1 増やす」→ 同じ語なので **同じ CAS に乗る**。
- 「参照カウントが 0 になったら解放する」→ CAS の結果を見れば分かる。

状態と参照カウントが別の変数だったら、この「ついでに」ができない。**「通知は立てたが参照カウントはまだ増えていない」瞬間が生まれて、その隙間で解放が走る。**

## ソースコードのどこか

### ビットの割り当てと、初期状態

[`runtime/task/state.rs#L16-L61`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L16-L61)。

```rust title="tokio/src/runtime/task/state.rs"
/// The task is currently being run.
const RUNNING: usize = 0b0001;

/// The task is complete.
///
/// Once this bit is set, it is never unset.
const COMPLETE: usize = 0b0010;

/// Extracts the task's lifecycle value from the state.
const LIFECYCLE_MASK: usize = 0b11;

/// Flag tracking if the task has been pushed into a run queue.
const NOTIFIED: usize = 0b100;
```

`RUNNING` と `COMPLETE` が隣り合っていて `LIFECYCLE_MASK` で一括に取れるのは、**「idle である」の判定を 1 回のマスクで済ませるため** だ。

```rust title="tokio/src/runtime/task/state.rs"
    pub(super) fn is_idle(self) -> bool {
        self.0 & (RUNNING | COMPLETE) == 0
    }
```

参照カウントは残りのビット全部を使う。

```rust title="tokio/src/runtime/task/state.rs"
/// Bits used by the ref count portion of the state.
const REF_COUNT_MASK: usize = !STATE_MASK;

/// Number of positions to shift the ref count.
const REF_COUNT_SHIFT: usize = REF_COUNT_MASK.count_zeros() as usize;

/// One ref count.
const REF_ONE: usize = 1 << REF_COUNT_SHIFT;
```

`REF_COUNT_SHIFT` を `count_zeros()` で求めているのが小さな工夫だ。マスクの 0 の個数 = 下位に何ビット使ったか、なので、**ビットを 1 個増やしても定数を書き換える必要がない**。

初期状態のコメントが、そのままタスクの所有者の一覧になっている。

```rust title="tokio/src/runtime/task/state.rs"
/// State a task is initialized with.
///
/// A task is initialized with three references:
///
///  * A reference that will be stored in an `OwnedTasks` or `LocalOwnedTasks`.
///  * A reference that will be sent to the scheduler as an ordinary notification.
///  * A reference for the `JoinHandle`.
///
/// As the task starts with a `JoinHandle`, `JOIN_INTEREST` is set.
/// As the task starts with a `Notified`, `NOTIFIED` is set.
const INITIAL_STATE: usize = (REF_ONE * 3) | JOIN_INTEREST | NOTIFIED;
```

**タスクは生まれた瞬間に参照が 3 個ある。** 登録簿、実行キュー、`JoinHandle`。そして `NOTIFIED` が最初から立っているのは、「これからキューに積まれる」という事実を状態として持っているからだ。

### すべての遷移が同じ形をしている

[`#L513-L533`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L513-L533)。

```rust title="tokio/src/runtime/task/state.rs"
    fn fetch_update_action<F, T>(&self, mut f: F) -> T
    where
        F: FnMut(Snapshot) -> (T, Option<Snapshot>),
    {
        let mut curr = self.load();

        loop {
            let (output, next) = f(curr);
            let next = match next {
                Some(next) => next,
                None => return output,
            };

            let res = self.val.compare_exchange(curr.0, next.0, AcqRel, Acquire);

            match res {
                Ok(_) => return output,
                Err(actual) => curr = Snapshot(actual),
            }
        }
    }
```

クロージャが返すのは **タプル** だ。第 1 要素が「呼び出し側が次に何をすべきか」、第 2 要素が「状態をどう書き換えるか」。`None` を返せば書き換えずに抜ける。

この形が効いているのは、**「状態をどう変えるか」と「その結果として誰が何をするか」を同じ場所に書ける** ところだ。CAS が成功した瞬間に「あなたがキューに積む担当です」「あなたが解放する担当です」が確定して、それが返り値になる。

返り値の型は列挙型で、しかも `#[must_use]` が付いている ([`#L63-L96`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L63-L96))。

```rust title="tokio/src/runtime/task/state.rs"
#[must_use]
pub(super) enum TransitionToRunning {
    Success,
    Cancelled,
    Failed,
    Dealloc,
}
```

**「状態を変えた結果、責務が発生した」ことを型で表して、無視できないようにしている。** `Dealloc` を捨てたらリークするので、`#[must_use]` はここでは実質的な安全装置だ。

構造体の上のコメントも短いが重要なことを言っている。

```rust title="tokio/src/runtime/task/state.rs"
/// All transitions are performed via RMW operations. This establishes an
/// unambiguous modification order.
```

**読んで書くのではなく、必ず read-modify-write でやる。** そうすることで、この 1 語に対する全変更が 1 本の全順序に並ぶ。「誰が先に COMPLETE を立てたか」に曖昧さがなくなる。

### poll を始めるとき: ロックと通知フラグのリセットを同時にやる

[`#L115-L145`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L115-L145)。

```rust title="tokio/src/runtime/task/state.rs"
    /// Attempts to transition the lifecycle to `Running`. This sets the
    /// notified bit to false so notifications during the poll can be detected.
    pub(super) fn transition_to_running(&self) -> TransitionToRunning {
        self.fetch_update_action(|mut next| {
            let action;
            assert!(next.is_notified());

            if !next.is_idle() {
                // This happens if the task is either currently running or if it
                // has already completed, e.g. if it was cancelled during
                // shutdown. Consume the ref-count and return.
                next.ref_dec();
                if next.ref_count() == 0 {
                    action = TransitionToRunning::Dealloc;
                } else {
                    action = TransitionToRunning::Failed;
                }
            } else {
                // We are able to lock the RUNNING bit.
                next.set_running();
                next.unset_notified();
```

3 つのことが 1 回の CAS で起きている。

1. **`RUNNING` ビットを立てる。** これが実質的なロックで、以降 future への排他アクセスが取れる。
2. **`NOTIFIED` を落とす。** これがこの関数のいちばん大事な仕事で、doc コメントがそう言っている。「poll 中に来た通知を検出できるようにするため」。
3. **失敗経路で参照カウントを 1 減らす。** キューから取り出した時点で 1 個の参照を受け取っているので、走らせないなら返す必要がある。

**ロックの獲得と、フラグのクリアと、参照カウントの返却が、同じ 1 語の同じ書き換えで起きる。** これが「1 個のアトミックに全部入れる」の見返りだ。

### poll 中に通知が来たら、キューに積まない

[`#L215-L250`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L215-L250)。`wake()` が呼ばれたときの遷移だ。

```rust title="tokio/src/runtime/task/state.rs"
            if snapshot.is_running() {
                // If the task is running, we mark it as notified, but we should
                // not submit anything as the thread currently running the
                // future is responsible for that.
                snapshot.set_notified();
                snapshot.ref_dec();

                // The thread that set the running bit also holds a ref-count.
                assert!(snapshot.ref_count() > 0);

                action = TransitionToNotifiedByVal::DoNothing;
            } else if snapshot.is_complete() || snapshot.is_notified() {
```

「走っている最中の通知は、**走らせているスレッドの責任にする**」。ここで積んでしまうと、同じタスクが 2 つのワーカーで同時に poll される。

対応する受け側が [`transition_to_idle`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L147-L181) だ。

```rust title="tokio/src/runtime/task/state.rs"
            if !next.is_notified() {
                // Polling the future consumes the ref-count of the Notified.
                next.ref_dec();
                if next.ref_count() == 0 {
                    action = TransitionToIdle::OkDealloc;
                } else {
                    action = TransitionToIdle::Ok;
                }
            } else {
                // The caller will schedule a new notification, so we create a
                // new ref-count for the notification. Our own ref-count is kept
                // for now, and the caller will drop it shortly.
                next.ref_inc();
                action = TransitionToIdle::OkNotified;
            }
```

poll が終わって idle に戻るとき、**`NOTIFIED` が立っていたら「poll 中に誰かが起こした」ということ**なので、`OkNotified` を返して呼び出し側に再スケジュールさせる。同時に参照カウントを 1 増やす。新しくキューに積む分の参照だ。

つまり「起こす側」と「走らせる側」の間で、**キューに積む責任がフラグ 1 個で受け渡されている**。ロックも、追加のキューも、条件変数も要らない。

### 完了は XOR で表す

[`#L183-L192`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L183-L192)。

```rust title="tokio/src/runtime/task/state.rs"
    /// Transitions the task from `Running` -> `Complete`.
    pub(super) fn transition_to_complete(&self) -> Snapshot {
        const DELTA: usize = RUNNING | COMPLETE;

        let prev = Snapshot(self.val.fetch_xor(DELTA, AcqRel));
        assert!(prev.is_running());
        assert!(!prev.is_complete());

        Snapshot(prev.0 ^ DELTA)
    }
```

`RUNNING` を落として `COMPLETE` を立てる。これは **必ず「1→0」と「0→1」の組** なので、`fetch_xor` 1 回で済む。CAS ループが要らない。

自分が `RUNNING` を持っている = 他の誰もこの 2 ビットを触らない、と分かっているからこそ、無条件の RMW にできる。**排他が取れている範囲では、CAS ループより弱い操作で足りる。**

同じ考え方が `transition_to_terminal` の `fetch_sub` や、`unset_waker_after_complete` の `fetch_and` にも出てくる。

### `JoinHandle` を即座に捨てる場合の近道

[`#L358-L379`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L358-L379)。

```rust title="tokio/src/runtime/task/state.rs"
    /// Optimistically tries to swap the state assuming the join handle is
    /// __immediately__ dropped on spawn.
    pub(super) fn drop_join_handle_fast(&self) -> Result<(), ()> {
        use std::sync::atomic::Ordering::Relaxed;

        // Relaxed is acceptable as if this function is called and succeeds,
        // then nothing has been done w/ the join handle.
        //
        // The moment the join handle is used (polled), the `JOIN_WAKER` flag is
        // set, at which point the CAS will fail.
        //
        // Given this, there is no risk if this operation is reordered.
        self.val
            .compare_exchange_weak(
                INITIAL_STATE,
                (INITIAL_STATE - REF_ONE) & !JOIN_INTEREST,
                Release,
                Relaxed,
            )
```

`tokio::spawn(...)` の戻り値をその場で捨てる、という最も多い使い方のための特別扱いだ。**期待値が `INITIAL_STATE` そのもの** になっている。

これは「タスクが生まれてから何も起きていない」という条件と等価だ。まだ一度も poll されていない、まだ誰も `wake` していない、まだ `JoinHandle` を await していない。その場合だけ、参照を 1 個減らして `JOIN_INTEREST` を落とすだけで終わる。

条件が崩れていれば CAS が失敗して、遅い経路 (`drop_join_handle_slow`) に落ちる。**「よくある形を定数と 1 回の比較で当てにいく」** という最適化で、外れても正しさは変わらない。

メモリ順序に `Relaxed` を混ぜている理由まで書いてあるのが親切だ。「成功したということは JoinHandle に対して何もしていないということなので、並べ替えられても危険がない」。

### 参照カウントの増加だけ `Relaxed`、そして溢れたら死ぬ

[`#L476-L497`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/state.rs#L476-L497)。

```rust title="tokio/src/runtime/task/state.rs"
    pub(super) fn ref_inc(&self) {
        use std::process;
        use std::sync::atomic::Ordering::Relaxed;

        // Using a relaxed ordering is alright here, as knowledge of the
        // original reference prevents other threads from erroneously deleting
        // the object.
        //
        // As explained in the [Boost documentation][1], Increasing the
        // reference counter can always be done with memory_order_relaxed: New
        // references to an object can only be formed from an existing
        // reference, and passing an existing reference from one thread to
        // another must already provide any required synchronization.
        //
        // [1]: (www.boost.org/doc/libs/1_55_0/doc/html/atomic/usage_examples.html)
        let prev = self.val.fetch_add(REF_ONE, Relaxed);

        // If the reference count overflowed, abort.
        if prev > isize::MAX as usize {
            process::abort();
        }
    }
```

増やすときは `Relaxed`、減らすときは `AcqRel`。これは `Arc` と同じ定石で、**根拠として Boost のドキュメントの URL が貼ってある**。

溢れたら `process::abort()` するのも `Arc` と同じだ。参照カウントが一周すると use-after-free になるので、**続行するより即死のほうが安全** な場面になる。判定が `isize::MAX` との比較なのは、参照カウントが上位ビットに置かれているため、最上位ビットに到達した時点で異常と分かるからだ。

### 状態が 1 語であることの代償: JOIN_WAKER のプロトコル

いいことばかりではない。`JoinHandle` が持つ waker は、**状態語の外側** (`Trailer` のフィールド) にある。ここへのアクセスだけは 1 個の CAS では守れないので、専用のプロトコルが必要になる。[`runtime/task/mod.rs#L75-L120`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/mod.rs#L75-L120) に、7 項目のルールとして書かれている。

```text title="tokio/src/runtime/task/mod.rs"
//!    1. `JOIN_WAKER` is initialized to zero.
//!
//!    2. If `JOIN_WAKER` is zero, then the `JoinHandle` has exclusive (mutable)
//!       access to the waker field.
//!
//!    3. If `JOIN_WAKER` is one, then the `JoinHandle` has shared (read-only)
//!       access to the waker field.
//!
//!    4. If `JOIN_WAKER` is one and COMPLETE is one, then the runtime has shared
//!       (read-only) access to the waker field.
```

つまり `JOIN_WAKER` ビットは、**状態ではなくアクセス権を表す**。「今この 1 ビットが誰に排他を与えているか」を宣言する変数だ。ルール 5 は書き込み手順を 3 段階で規定していて、途中で失敗しうることまで明記されている。

```text title="tokio/src/runtime/task/mod.rs"
//!    Rule 6 implies that the steps (i) or (iii) of rule 5 may fail due to a
//!    race. If step (i) fails, then the attempt to write a waker is aborted. If
//!    step (iii) fails because COMPLETE is set to one by another thread after
//!    step (i), then the waker field is cleared.
```

**「1 語に詰める」設計が守れるのは 1 語に入るものだけで、外に出たフィールドには別途プロトコルが要る。** そのプロトコルは、この規模になるとコードだけでは表現できず、散文で書くしかない。実際 `state.rs` と `harness.rs` の該当箇所には「rule 5 に従う」「rule 4 により安全」というコメントが繰り返し現れる。

## なぜそうなっているか

- **1 語にまとめたのは、複数の条件判断と参照カウントの増減を不可分にするため。** 「実行中でなければキューに積む、積むなら参照を 1 増やす」を別々の変数でやると、その間に他のスレッドが割り込む隙間ができる。同じ語なら、CAS が成功した時点で両方が確定している。
- **`wake()` がホットパスだから、ロックを使えない。** I/O ドライバは 1 回の `epoll_wait` で数千個の waker を叩きうる。そのたびにミューテックスを取るのは論外で、CAS 1 回に収める必要がある。
- **返り値を `#[must_use]` の列挙型にしたのは、状態遷移が「責務の移転」だから。** CAS が成功した者だけが、キューに積む・メモリを解放する権利と義務を得る。これを bool や暗黙の約束で表すと、必ずどこかで取りこぼす。
- **排他が取れている遷移では CAS ループを使わない。** `RUNNING` を握っている間は他の誰もそのビットを触らないので、`fetch_xor` や `fetch_sub` で足りる。**同期プリミティブの強さを、その時点で分かっている不変条件に合わせて落としている。**
- **`drop_join_handle_fast` があるのは、`spawn` の戻り値を捨てるのが圧倒的多数派だから。** 「初期状態のまま」という最も強い仮定を定数の比較 1 回で確かめて、当たれば最短経路、外れれば通常経路に落ちる。
- **状態語に入らないフィールド (waker) だけ、散文のプロトコルで守っている。** これは設計の限界を認めた結果で、代わりに「どのビットが誰に何のアクセス権を与えるか」を 7 項目で書き切り、実装のコメントからそれを参照している。

## どう活かすか

- **同時に判断したい条件と、同時に更新したいカウンタは、同じ 1 語に入れられないか考える。** 入れば、ロックなしで「条件を見て、それに応じてカウンタを動かす」が書ける。入らなければ、必ずロックか、この章の `JOIN_WAKER` のような追加のプロトコルが要る。
- **状態遷移関数の返り値で「次に誰が何をするか」を返す。** 状態を変えることと、その結果生じる副作用 (キューに積む、解放する、待っている人を起こす) を分ける。副作用をアトミック操作の中でやろうとすると、たいてい行き詰まる。
- **その返り値は `#[must_use]` の列挙型にする。** bool だと意味が読めず、無視しても警告が出ない。列挙型なら、遷移の全パターンが型として列挙され、`match` の網羅性検査が効く。
- **「走っている最中の通知」は、走らせている側の責任にする。** フラグを立てるだけにして、処理を終えた側がフラグを見て再投入する。これで「二重に走らせない」と「通知を取りこぼさない」を同時に満たせる。
- **排他が取れている区間では、より弱い操作に落とす。** CAS ループは、他者と競合しうる場合にだけ必要になる。自分がロックビットを握っていると分かっているなら `fetch_xor` で十分で、これはループしない分だけ確実に速い。
- **参照カウントの溢れは、検出したら即死させる。** そこから回復する道はなく、続行すると use-after-free になる。`Arc` も Tokio も同じ判断をしている。
- **最頻の使われ方に、定数との比較 1 回で当てにいく近道を用意する。** 外れても通常経路に落ちるだけなら、正しさを犠牲にせずに済む。ただし「その定数が初期状態と同じである」という前提が崩れないよう、定数の定義とセットで読める場所に置く。
