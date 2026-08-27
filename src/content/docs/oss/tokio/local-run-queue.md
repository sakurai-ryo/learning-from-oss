---
title: "固定長リングバッファを 2 つの整数で表し、持ち主と盗む側で同期の強さを変える"
description: "各ワーカーは 256 個の固定長キューを持つ。持ち主だけが末尾に書き、他のワーカーは先頭から半分を盗む。head は「本当の先頭」と「盗み取り中の先頭」の 2 個を 1 語にパックしていて、この差が盗む側同士の排他になる。持ち主は tail をアトミックに読まない。1 人しか書かないと分かっている値に、原子性の代金を払わないためだ。"
sidebar:
  order: 7
---

## 何を学んだか

### どんな状況の話か

work-stealing スケジューラでは、各ワーカーが自分のキューを持つ。

- **持ち主 (1 スレッド)**: 末尾に積み、先頭から取る。最も高頻度。
- **他のワーカー (N-1 スレッド)**: 自分のキューが空になったとき、他人のキューから盗む。頻度は低い。

この非対称性が設計の出発点になる。持ち主の操作は「毎回」起きるので、可能な限り安くしたい。盗む操作は「たまに」なので、多少高くてもよい。

さらに厄介なのが **盗む側同士** だ。2 つのワーカーが同じキューから同時に盗もうとすると、同じタスクを 2 回取り出しかねない。

### Tokio の答え

**インデックスを 2 個持ち、片方を 2 つに割って 1 語にパックする。**

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
pub(crate) struct Inner<T: 'static> {
    /// Concurrently updated by many threads.
    ///
    /// Contains two `UnsignedShort` values. The `LSB` byte is the "real" head of
    /// the queue. The `UnsignedShort` in the `MSB` is set by a stealer in process
    /// of stealing values. It represents the first value being stolen in the
    /// batch. The `UnsignedShort` indices are intentionally wider than strictly
    /// required for buffer indexing in order to provide ABA mitigation and make
    /// it possible to distinguish between full and empty buffers.
    ///
    /// When both `UnsignedShort` values are the same, there is no active
    /// stealer.
    ///
    /// Tracking an in-progress stealer prevents a wrapping scenario.
    head: AtomicUnsignedLong,

    /// Only updated by producer thread but read by many threads.
    tail: AtomicUnsignedShort,

    /// Elements
    buffer: Box<[UnsafeCell<MaybeUninit<task::Notified<T>>>; LOCAL_QUEUE_CAPACITY]>,
}
```

**`head` の中に「本当の先頭」と「盗み取り中の先頭」の 2 個が入っている。** この 2 つが一致していれば、盗んでいる者はいない。ずれていれば、誰かが作業中だ。

「作業中」を状態として持つことで、盗む側同士の排他が **ロックなしで** 表現される。しかもそれは前ページまでのタスク状態と同じ発想で、**1 語に詰めたから 1 回の CAS で「見て・決めて・宣言する」ができる**。

## ソースコードのどこか

### 幅の広い整数を使う理由

[`multi_thread/queue.rs#L12-L26`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/queue.rs#L12-L26)。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
// Use wider integers when possible to increase ABA resilience.
//
// See issue #5041: <https://github.com/tokio-rs/tokio/issues/5041>.
cfg_has_atomic_u64! {
    type UnsignedShort = u32;
    type UnsignedLong = u64;
    type AtomicUnsignedShort = crate::loom::sync::atomic::AtomicU32;
    type AtomicUnsignedLong = crate::loom::sync::atomic::AtomicU64;
}
cfg_not_has_atomic_u64! {
    type UnsignedShort = u16;
    type UnsignedLong = u32;
```

キュー長は 256 なので、インデックスは 8 ビットあれば足りる。それでも `u32` を使う。

理由が 2 つ、構造体のコメントに書かれている。

1. **ABA 緩和。** インデックスが `& MASK` される前の値で比較されるので、幅が広いほど「一周して同じ値に戻る」までの距離が長い。CAS の途中で相手が 4294967296 回進むことは現実的にありえない。
2. **満杯と空を区別できる。** `tail - head` が 0 なら空、256 なら満杯。インデックスが 8 ビットだと両方 0 になって区別できない。

`AtomicU64` がない環境では `u16`/`u32` に落とす。**プラットフォームの制約に合わせて幅を変えるが、「本来より広く取る」という方針は同じ**。

キュー長は 256 だが、loom (並行性検査) の下では 4 になる。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
// Shrink the size of the local queue when using loom. This shouldn't impact
// logic, but allows loom to test more edge cases in a reasonable a mount of
// time.
#[cfg(loom)]
const LOCAL_QUEUE_CAPACITY: usize = 4;
```

**「満杯になる」「一周する」といった境界を、検査可能な時間で踏ませるため** だ。定数を小さくするだけで、同じロジックのまま境界条件のテストになる。

### 持ち主は tail をアトミックに読まない

[`#L103-L119`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/queue.rs#L103-L119)。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
    /// Returns the number of entries in the queue
    pub(crate) fn len(&self) -> usize {
        let (_, head) = unpack(self.inner.head.load(Acquire));
        // safety: this is the **only** thread that updates this cell.
        let tail = unsafe { self.inner.tail.unsync_load() };
        len(head, tail)
    }
```

`head` は `load(Acquire)`、`tail` は **`unsync_load()`**。

`unsync_load` は、アトミック変数の中身を非アトミックに読む操作だ。安全条件は「自分がこの値の唯一の書き手であること」。`tail` を書くのは持ち主だけなので、持ち主が読むぶんには他の書き込みと競合しない。

**型は `AtomicUnsignedShort` のままで、他のスレッドは普通に `load(Acquire)` する。** 同じ変数に対して、読む主体によって同期の強さを変えている。

これがコード全体で徹底されていて、`Local` 側 (持ち主) のメソッドはすべて `unsync_load`、`Steal` 側 (盗む側) は `load(Acquire)` になっている。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
impl<T> Steal<T> {
    pub(crate) fn len(&self) -> usize {
        let (_, head) = unpack(self.0.head.load(Acquire));
        let tail = self.0.tail.load(Acquire);
        len(head, tail)
    }
```

型としても `Local<T>` と `Steal<T>` に分かれていて、`Local` は `Send` だが 1 スレッドからしか使えないよう `&mut self` を要求する。**「誰がどの操作をしてよいか」が型で表現されている。**

### 取り出し: 盗む者がいるかで書き換え方を変える

[`#L360-L399`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/queue.rs#L360-L399)。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
    /// Pops a task from the local queue.
    pub(crate) fn pop(&mut self) -> Option<task::Notified<T>> {
        let mut head = self.inner.head.load(Acquire);

        let idx = loop {
            let (steal, real) = unpack(head);

            // safety: this is the **only** thread that updates this cell.
            let tail = unsafe { self.inner.tail.unsync_load() };

            if real == tail {
                // queue is empty
                return None;
            }

            let next_real = real.wrapping_add(1);

            // If `steal == real` there are no concurrent stealers. Both `steal`
            // and `real` are updated.
            let next = if steal == real {
                pack(next_real, next_real)
            } else {
                assert_ne!(steal, next_real);
                pack(steal, next_real)
            };
```

持ち主が 1 個取り出すときも CAS が要る (盗む側と競合するため)。ただし **書き換え方が場合分けされている**。

- **盗む者がいない (`steal == real`)**: 両方を進める。次に盗みに来た者から見て「作業中でない」状態が保たれる。
- **盗む者がいる (`steal != real`)**: `real` だけ進める。`steal` は盗んでいる者が終わったときに戻す。

`steal` を触らないのは、それが **他人の作業範囲の始点** だからだ。盗む側は `steal..real` の範囲を自分のものとして読み出している最中で、そこを動かされると読む場所が狂う。

### 盗む: 半分を持っていき、2 段階で宣言する

[`#L470-L562`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/queue.rs#L470-L562)。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
    fn steal_into2(&self, dst: &mut Local<T>, dst_tail: UnsignedShort) -> UnsignedShort {
        let mut prev_packed = self.0.head.load(Acquire);
        let mut next_packed;

        let n = loop {
            let (src_head_steal, src_head_real) = unpack(prev_packed);
            let src_tail = self.0.tail.load(Acquire);

            // If these two do not match, another thread is concurrently
            // stealing from the queue.
            if src_head_steal != src_head_real {
                return 0;
            }

            // Number of available tasks to steal
            let n = src_tail.wrapping_sub(src_head_real);
            let n = n - n / 2;
```

**まず「他に盗んでいる者がいるか」を、2 つのインデックスが一致するかで判定する。** いれば即座に諦める。待たない。他人のキューは他にもあるので、待つより次を見にいくほうが速い。

`n - n / 2` は「半分、ただし端数は多いほうに寄せる」。1 個しかなければ 1 個、3 個なら 2 個。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
            // Claim all those tasks. This is done by incrementing the "real"
            // head but not the steal. By doing this, no other thread is able to
            // steal from this queue until the current thread completes.
            let res = self
                .0
                .head
                .compare_exchange_weak(prev_packed, next_packed, AcqRel, Acquire);
```

**`real` だけ進めて `steal` を据え置く。** これで `steal != real` になり、他の盗む者は上の判定で弾かれる。**「作業中」という排他が、2 つのインデックスの差として表現される。**

実際にバッファから読み出すのはこの後だ。CAS で範囲を確保してから、ゆっくりコピーする。読み終わったら 2 回目の CAS で `steal` を `real` に揃え、作業終了を宣言する。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
        // Update `src_head_steal` to match `src_head_real` signalling that the
        // stealing routine is complete.
        loop {
            let head = unpack(prev_packed).1;
            next_packed = pack(head, head);
```

2 回目のループが必要なのは、**その間に持ち主が `real` を進めているかもしれない** からだ。だから `real` を読み直して、それに `steal` を合わせる。

### 盗んだ結果は、すぐには公開しない

呼び出し元 ([`#L416-L468`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/queue.rs#L416-L468)) にも工夫がある。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
        // To the caller, `dst` may **look** empty but still have values
        // contained in the buffer. If another thread is concurrently stealing
        // from `dst` there may not be enough capacity to steal.
        let (steal, _) = unpack(dst.inner.head.load(Acquire));

        if dst_tail.wrapping_sub(steal) > LOCAL_QUEUE_CAPACITY as UnsignedShort / 2 {
            // we *could* try to steal less here, but for simplicity, we're just
            // going to abort.
            return None;
        }

        // Steal the tasks into `dst`'s buffer. This does not yet expose the
        // tasks in `dst`.
        let mut n = self.steal_into2(dst, dst_tail);
```

**自分のキューが空に見えても、実際には空でないことがある。** 自分から盗んでいる最中の誰かがいると、そのスロットはまだ埋まっている。だから容量チェックは `steal` を基準にする。

「もっと少なく盗むこともできるが、単純さのために諦める」という判断も明記されている。

そして盗んだタスクは、コピーした直後には公開されない。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
        // We are returning a task here
        n -= 1;

        let ret_pos = dst_tail.wrapping_add(n);
        let ret_idx = ret_pos as usize & MASK;

        // safety: the value was written as part of `steal_into2` and not
        // exposed to stealers, so no other thread can access it.
        let ret = dst.inner.buffer[ret_idx].with(|ptr| unsafe { ptr::read((*ptr).as_ptr()) });

        if n == 0 {
            // The `dst` queue is empty, but a single task was stolen
            return Some(ret);
        }

        // Make the stolen items available to consumers
        dst.inner.tail.store(dst_tail.wrapping_add(n), Release);
```

**最後の 1 個は、キューに入れずに直接返す。** 盗みに来たということは、これから走らせるタスクが欲しいということだ。キューに積んでから取り出すのは無駄な往復になる。

しかも 1 個しか盗めなかった場合は `tail` を一切動かさない。**キューには何も起きなかったことになり、他人から盗まれる余地も作らない。**

`tail` の `store(Release)` が、盗んだタスクを「公開」する唯一の操作になっている。書き込みは先に済ませ、公開は 1 回のストアで行う。

### 空でないキューを捨てたら落とす

[`#L571-L577`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/queue.rs#L571-L577)。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
impl<T> Drop for Local<T> {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            assert!(self.pop().is_none(), "queue not empty");
        }
    }
}
```

**キューが空でないまま捨てられたら、それはランタイムのバグだ。** タスクが 1 個消えるだけでなく、そのタスクの参照カウントが落ちずにリークする。

`panicking()` の判定が入っているのは、既にパニック中の巻き戻しでこの `Drop` が走ると二重パニックでプロセスが即死し、**本来の原因が見えなくなる** からだ。

`MaybeUninit` の配列なので、Rust の型システムはこの手のリークを検出できない。**型で守れない不変条件を、`Drop` の assert で守っている。**

## なぜそうなっているか

- **持ち主と盗む側で操作を分けたのは、頻度が 2 桁以上違うから。** 持ち主の push/pop は毎タスク起きる。盗みは自分のキューが枯れたときだけ。だから持ち主側を最適化して、盗む側にコストを寄せる。
- **`tail` を持ち主が `unsync_load` で読むのは、書き手が 1 人だと分かっているから。** アトミック読み込みは、コンパイラの最適化を阻害する (レジスタに保持できない、並べ替えられない)。書き手が自分だけなら、その代金は払う必要がない。
- **`head` を 2 つに割ってパックしたのは、「盗み取り中」を状態として持つため。** 別のフラグにすると、「範囲を確保する」と「作業中を宣言する」が別の操作になり、その間に他の盗む者が入る。1 語にすれば 1 回の CAS で両方が確定する。
- **インデックスを必要より広く取ったのは、ABA 対策と満杯/空の区別のため。** 8 ビットで足りるところに 32 ビットを使うのは、メモリではなく **正しさのためのコスト** になっている。
- **盗む側が競合したら即座に諦めるのは、他に選択肢があるから。** 待つ理由がない。他のワーカーのキューも、グローバルキューもある。ロックフリーな構造で「諦められる」のは、代替経路がある場合の大きな利点だ。
- **盗んだ最後の 1 個を直接返すのは、それが本来の目的だから。** キューに積んでから取り出すと、`tail` のストアと `head` の CAS が余計に増える。
- **`Drop` で assert するのは、型で守れない不変条件だから。** `MaybeUninit` の配列は、中身が初期化済みかをコンパイラが追跡しない。開発中にバグを検出する唯一の手段が実行時検査になる。

## どう活かすか

- **同じデータへのアクセスを、主体ごとに別の型に分ける。** `Local` と `Steal` に分ければ、「持ち主しか呼べない操作」がコンパイル時に強制できる。両方が使える 1 個の型にすると、安全条件が全部コメントになる。
- **単一書き手が確定している変数は、その書き手からの読み取りだけ同期を落とす。** 型はアトミックのままでよい。読む主体によって強さを変えられる、という発想は見落としやすい。
- **「作業中」を、2 つのインデックスの差で表す。** 別のフラグやロックを足すより、既にある値の組で表現できないか考える。1 語に収まれば、状態の観測と更新が 1 回の CAS になる。
- **インデックスは、必要な幅より広く取る。** ラップアラウンドの周期が延び、ABA が現実的に起こらなくなる。加えて「満杯」と「空」を区別できるようになるので、境界の場合分けが 1 つ減る。
- **ロックフリーな構造では、競合したら諦める道を用意する。** 代替経路 (他のキュー、グローバルキュー) があるなら、リトライで粘るより次に行くほうが速い。「単純さのために諦める」という判断は、コメントに書いておけば後から見直せる。
- **並行性検査の下では、境界に当たりやすい定数に切り替える。** 容量 256 のまま全インターリーブを試すのは非現実的だが、容量 4 なら同じロジックで境界を踏める。ロジックを変えずに定数だけ差し替えられる形にしておく。
- **型で表現できない不変条件は、`Drop` の assert で守る。** ただしパニック中の巻き戻しでは黙らせる。二重パニックは、元の原因を隠してしまう。
