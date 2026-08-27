---
title: "完了通知型の I/O では、キャンセルしてもバッファを手放せない"
description: "epoll は「読める」と教えるだけで、read(2) を呼ぶのは自分だから、待つのをやめてもバッファは自由になる。io_uring はカーネルが自分のバッファに直接書くので、待つのをやめてもバッファを解放できない。Tokio は future の Drop でバッファと fd をドライバ側の枠に移し替え、完了通知が来るまで生かしておく。同じ「キャンセル」が、通知型と完了型でまったく違う実装になる。"
group: "ドライバ"
sidebar:
  order: 17
---

## 何を学んだか

### どんな状況の話か

[前の](../scheduled-io/) [2 ページ](../io-cancel-safety/) で見た I/O は、すべて **通知型 (readiness-based)** だった。

1. カーネルに「fd 7 が読めるようになったら教えて」と登録する。
2. 「読めるようになった」と教えられる。
3. **自分で `read(2)` を呼ぶ。** バッファを渡すのはこのとき。

だから、待つのをやめるのは簡単だ。`readable()` の future を捨てても、**カーネルは自分のバッファのことを何も知らない**。待ち行列から自分を外すだけで終わる。

**完了型 (completion-based)** の io_uring は、これが逆になる。

1. カーネルに「fd 7 からこのバッファに 4096 バイト読んで」と依頼する。**バッファのポインタを渡す。**
2. カーネルがいつか読んで、バッファに書き込む。
3. 「終わった」という完了通知 (CQE) が届く。

依頼した後、**カーネルはいつでもそのバッファに書き込む権利を持っている**。ここで future を捨ててバッファを解放したら、カーネルは解放済みメモリに書き込む。ヒープの別の用途に再利用されていたら、そこが壊れる。

**「キャンセルできない」のではない。「キャンセルしても、完了が届くまでバッファを手放せない」。**

Rust の `Drop` は、待つことができない。`drop()` の中で「カーネルの完了を待つ」ためにブロックするのは、非同期ランタイムでは論外だ。

### Tokio の答え

**future が捨てられたら、バッファと fd の所有権をドライバ側に移す。**

```rust title="tokio/src/runtime/driver/op.rs"
pub(crate) enum Lifecycle {
    /// The operation has been submitted to uring and is currently in-flight
    Submitted,

    /// The submitter is waiting for the completion of the operation
    Waiting(Waker),

    /// The submitter no longer has interest in the operation result. The state
    /// must be passed to the driver and held until the operation completes.
    Cancelled(
        #[allow(dead_code)] CancelData,
    ),

    /// The operation has completed with a single cqe result
    Completed(cqueue::Entry),
}
```

**`Cancelled` が値を持っている。** そして `#[allow(dead_code)]` が付いている。**一度も読まれないフィールド** だからだ。

読まれないのに保持する理由は 1 つで、**そこにバッファと fd が入っているから**。完了通知が来た時点でこの枠ごと捨てられ、そのときにバッファが解放される。

「使わない値を、生かしておくためだけに持つ」。所有権が寿命そのものを表している Rust ならではの形だ。

なお、この io_uring 対応は `tokio_unstable` + `io-uring` フィーチャで、対象は Linux のファイル操作に限られる。

## ソースコードのどこか

### 操作の状態は 2 か所にある

[`runtime/driver/op.rs#L77-L108`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/driver/op.rs#L77-L108)。

```rust title="tokio/src/runtime/driver/op.rs"
pub(crate) enum State {
    Initialize(Option<Entry>),
    Polled(usize),
    Complete,
}

pub(crate) struct Op<T: Cancellable> {
    // Handle to the runtime
    handle: Handle,
    // State of this Op
    state: State,
    // Per operation data.
    data: Option<T>,
}
```

**future 側に `State`、ドライバ側に `Lifecycle`。** 2 つの状態機械が、`Polled(usize)` のインデックスで結ばれている。

このインデックスは slab (連番の枠) の位置で、そのまま io_uring の `user_data` として送られる。

```rust title="tokio/src/runtime/io/driver/uring.rs"
        let index = ctx.ops.insert(Lifecycle::Waiting(waker));
        let entry = entry.user_data(index as u64);
```

完了通知には `user_data` がそのまま返ってくるので、**64 ビットの整数 1 個で「どの操作の完了か」が分かる**。ポインタを送る手もあるが、整数なら移動しても無効化しても安全だ。

`data: Option<T>` に、バッファと fd が入っている。

```rust title="tokio/src/io/uring/read.rs"
pub(crate) struct Read<B, F = ArcFd> {
    fd: F,
    buf: B,
}
```

**`fd` も所有している。** 借用ではない。理由は同じで、操作の途中で fd が閉じられると、カーネルが別のファイルを読みかねない。

### 依頼するときの unsafe と、その正当化

[`io/uring/read.rs#L102-L113`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/io/uring/read.rs#L102-L113)。

```rust title="tokio/src/io/uring/read.rs"
    pub(crate) fn read_at(fd: F, mut buf: B, max_len: usize, offset: u64) -> Self {
        let (ptr, len) = buf.uring_read_prepare(max_len);

        let sqe = opcode::Read::new(types::Fd(UringFd::as_raw_fd(&fd)), ptr, len)
            .offset(offset)
            .build();

        // SAFETY: `fd` and `buf`, which owns the heap buffer, are moved into `Read`,
        // which is held by the `Op` for the entire duration of the io-uring operation.
        // The buffer pointer remains valid because Vec heap data doesn't move.
        unsafe { Op::new(sqe, Read { fd, buf }) }
    }
```

**安全性の根拠が「所有権を move したこと」で説明されている。** `buf` は `Read` に move され、`Read` は `Op` が持ち、`Op` は操作が終わるまで生きる。

そして「`Vec` のヒープデータは動かない」という一言が効いている。`Vec` 自体は move されるが、**中のバッファのアドレスは変わらない**。だからポインタを先に取っておいて構わない。

`Op::new` の安全性要件も明示されている。

```rust title="tokio/src/runtime/driver/op.rs"
    /// # Safety
    ///
    /// Callers must ensure that parameters of the entry (such as buffer) are valid and will
    /// be valid for the entire duration of the operation, otherwise it may cause memory problems.
    pub(crate) unsafe fn new(entry: Entry, data: T) -> Self {
```

**「操作の全期間にわたって有効であること」。** 通知型 API にはこの要件がない。ここが完了型の本質的な難しさだ。

### バッファの初期化を型で追う

`Vec<u8>` に読み込むとき、カーネルは未初期化領域に書き込む。

```rust title="tokio/src/io/uring/read.rs"
impl ReadBuffer for Vec<u8> {
    fn uring_read_prepare(&mut self, max_len: usize) -> (*mut u8, u32) {
        assert!(self.spare_capacity_mut().len() >= max_len);
        let ptr = self.spare_capacity_mut().as_mut_ptr().cast();
        (ptr, max_len as u32)
    }

    unsafe fn uring_read_complete(&mut self, n: u32) {
        // SAFETY: the kernel wrote `n` bytes into spare capacity starting
        // at the old self.len(), so self.len() + n bytes are now initialized.
        unsafe { self.set_len(self.len() + n as usize) };
    }
}
```

**`prepare` で予備容量のポインタを渡し、`complete` で `set_len` する。** この 2 つが対になっていて、間にカーネルの書き込みが挟まる。

`uring_read_complete` が `unsafe fn` なのが正しい。「カーネルが本当に n バイト書いたか」は Rust には確かめようがなく、**呼び出し側 (CQE の結果を読んだコード) が保証するしかない**。

```rust title="tokio/src/io/uring/read.rs"
    fn complete(self, cqe: CqeResult) -> Self::Output {
        let mut buf = self.buf;
        if let Ok(len) = cqe.result {
            // SAFETY: kernel wrote exactly `len` bytes into the prepared buffer.
            unsafe { buf.uring_read_complete(len) };
        }
        (cqe.result, self.fd, buf)
    }
```

**返り値が `(結果, fd, バッファ)` のタプル。** 所有権を渡してしまっているので、返してもらわないと呼び出し側が困る。完了型 I/O の API がこの形になるのは避けられない (`tokio-uring` などでも同じ)。

### キャンセルの実装

[`runtime/driver/op.rs#L110-L126`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/driver/op.rs#L110-L126)。

```rust title="tokio/src/runtime/driver/op.rs"
impl<T: Cancellable> Drop for Op<T> {
    fn drop(&mut self) {
        match self.state {
            // We've already dropped this Op.
            State::Complete => (),
            // We will cancel this Op.
            State::Polled(index) => {
                let data = self.take_data();
                let handle = &mut self.handle;
                handle.inner.driver().io().cancel_op(index, data);
            }
            // This Op has not been polled yet.
            // We don't need to do anything here.
            State::Initialize(_) => (),
        }
    }
}
```

**3 通りしかない。** まだ提出していない (`Initialize`) なら何もしない。完了済みなら何もしない。提出済みで未完了なら、**データをドライバに預ける**。

預ける側 ([`runtime/io/driver/uring.rs#L298-L328`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/driver/uring.rs#L298-L328))。

```rust title="tokio/src/runtime/io/driver/uring.rs"
        // This Op will be cancelled. Here, we don't remove the lifecycle from the slab to keep
        // uring data alive until the operation completes.

        let cancel_data = data.expect("Data should be present").cancel();
        match mem::replace(lifecycle, Lifecycle::Cancelled(cancel_data)) {
            Lifecycle::Submitted | Lifecycle::Waiting(_) => (),
            // The driver saw the completion, but it was never polled.
            Lifecycle::Completed(cqe) => {
                if let Lifecycle::Cancelled(CancelData::Open(_)) = lifecycle {
                    if let Ok(fd) = CqeResult::from(cqe).result {
                        // SAFETY: the successful CQE result provides
                        // a non-negative integer, and the event is
                        // related to an open operation.
                        unsafe { OwnedFd::from_raw_fd(fd as i32) };
                    }
                }
                // We can safely remove the entry from the slab, as it has already been completed.
                ops.remove(index);
            }
            prev => panic!("Unexpected state: {prev:?}"),
        };
```

**「slab から枠を消さない。uring のデータを操作完了まで生かしておくため」。** これが要点だ。

そして `Completed` の分岐に、**完了型ならではの後始末** がある。

「`open` の完了通知が来ていたが、まだ poll されていなかった」場合を考える。CQE には **新しく開かれた fd の番号** が入っている。future はもう捨てられているので、誰もその fd を受け取らない。

**そのまま捨てると、fd がリークする。** プロセスの fd 上限に達するまで積み上がり、いずれ `EMFILE` で何も開けなくなる。

だから `OwnedFd::from_raw_fd(fd)` で包み、その場で drop させる。**「番号を `OwnedFd` にして即座に落とす」** は close(2) を呼ぶための定型で、1 行で意図が伝わる。

同じ処理が、完了通知を配る側にもある ([`#L82-L93`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/driver/uring.rs#L82-L93))。

```rust title="tokio/src/runtime/io/driver/uring.rs"
                Some(Lifecycle::Cancelled(cancel_data)) => {
                    if let CancelData::Open(_) = cancel_data {
                        if let Ok(fd) = CqeResult::from(cqe).result {
                            unsafe { OwnedFd::from_raw_fd(fd as i32) };
                        }
                    }
                    // Op future was cancelled, so we discard the result.
                    ops.remove(idx);
                }
```

**「キャンセル済みの枠に完了が届いた」がここ。** 結果を捨て、枠を消す。この `ops.remove(idx)` で `CancelData` が落ち、**バッファがようやく解放される**。

キャンセルから解放までの間、バッファはドライバの slab の中で誰にも使われずに存在し続ける。**この期間があることが、完了型 I/O の避けられないコストだ。**

### 状態機械の噛み合わせ

`Op::poll` の `Polled` 分岐 ([`op.rs#L194-L233`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/driver/op.rs#L194-L233))。

```rust title="tokio/src/runtime/driver/op.rs"
                match mem::replace(lifecycle, Lifecycle::Submitted) {
                    // Only replace the stored waker if it wouldn't wake the new one
                    Lifecycle::Waiting(prev) if !prev.will_wake(cx.waker()) => {
                        let waker = cx.waker().clone();
                        *lifecycle = Lifecycle::Waiting(waker);
                        Poll::Pending
                    }

                    Lifecycle::Waiting(prev) => {
                        *lifecycle = Lifecycle::Waiting(prev);
                        Poll::Pending
                    }
                    ...
                    Lifecycle::Submitted => {
                        unreachable!("Submitted lifecycle should never be seen here");
                    }

                    Lifecycle::Cancelled(_) => {
                        unreachable!("Cancelled lifecycle should never be seen here");
                    }
                }
```

**`will_wake` がここにも出てくる。** [waker のページ](../task-waker/) で見たとおり、同じタスクなら clone を省ける。

到達しない 2 つの状態に `unreachable!` が置かれている。`Submitted` は「`mem::replace` で一時的に置いた値」なので、読み出し側で見えるはずがない。`Cancelled` は future が生きていないと入らない状態なので、その future の poll から見えるはずがない。

**「この状態機械では、ここにこの状態は来ない」という不変条件が、パニックとして書かれている。** 型で表現するには `Lifecycle` を分割する必要があり、それは複雑さに見合わない。

### 提出キューが溢れたら、その場で流す

[`uring.rs#L262-L292`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/io/driver/uring.rs#L262-L292)。

```rust title="tokio/src/runtime/io/driver/uring.rs"
        // SAFETY: entry is valid for the entire duration of the operation
        while unsafe { ctx.ring_mut().submission().push(&entry).is_err() } {
            // If the submission queue is full, flush it to the kernel
            submit_or_remove(ctx)?;
        }

        // Ensure that the completion queue is not full before submitting the entry.
        while ctx.ring_mut().completion().is_full() {
            ctx.dispatch_completions();
        }

        // Note: For now, we submit the entry immediately without utilizing batching.
```

**提出キューが満杯なら `io_uring_enter` を呼んで空け、完了キューが満杯なら完了を捌いて空ける。**

io_uring はリングバッファなので、どちらも溢れうる。溢れた状態で提出すると、完了が失われるか上書きされる。**「押し込む前に、押し込める場所があることを確かめる」** という手順が、両方のキューについて必要になる。

「今は都度提出していて、バッチ処理をしていない」という注記も残っている。io_uring の性能上の利点はバッチ提出にあるので、**まだ最適化前の段階だと明示されている**。

## なぜそうなっているか

- **キャンセルしたバッファを解放できないのは、カーネルが書き込み権を持ったままだから。** 依頼を取り消すには `IORING_OP_ASYNC_CANCEL` を送って、その完了を待つ必要がある。`Drop` は待てないので、待つ役をドライバに引き継ぐしかない。
- **`Cancelled` に値を持たせて `#[allow(dead_code)]` にしているのは、値そのものではなく寿命が目的だから。** Rust では「解放されないこと」を所有で表現する。読まれないフィールドは普通は削除対象だが、ここでは削除するとメモリ破壊になる。
- **fd も所有するのは、途中で閉じられると別のファイルが読まれるから。** fd の番号は再利用される。操作が飛んでいる間に閉じて別のファイルを開くと、番号が一致してしまう。
- **`user_data` にインデックスを使うのは、ポインタより安全だから。** カーネルに渡した値が返ってくるまでの間に、Rust 側のデータは移動しうる。整数のインデックスなら、その間に slab の中身が変わっても辻褄が合う。
- **キャンセル済みの `open` の fd を閉じるのは、閉じないと漏れるから。** 完了型 API では、キャンセルしても「成功した結果」が届く。その結果が資源そのものである場合、受け取り手がいなくても解放だけは必要になる。
- **到達しない状態に `unreachable!` を置くのは、型で分けるほどの価値がないから。** `Lifecycle` を「future 側から見える状態」と「見えない状態」に分割すれば型で表せるが、変換のコードが増える。不変条件をパニックで表明するほうが読みやすい。
- **提出前に両方のキューの空きを確保するのは、リングバッファだから。** 溢れると完了通知が失われる。失われた完了は、待っている future を永久にハングさせる。

## どう活かすか

- **「キャンセル」の意味は、API の形で変わる。** 通知型なら「待つのをやめる」で済むが、完了型では「相手がまだ資源を握っている」。非同期 API を設計するときは、キャンセル時に **誰が何を握っているか** を先に整理する。
- **`Drop` で待てない以上、待つ役を別の主体に引き継ぐ。** 「future が死んでも、操作は生きている」という状況では、生きている側 (ドライバ) に資源を移すのが唯一の解になる。
- **寿命だけのために値を保持することを恐れない。** 「読まれないフィールド」は普通は設計の匂いだが、所有権が寿命を表す言語では正当な用途になる。その意図をコメントで明示する。
- **外部システムに渡すハンドルは、ポインタではなく世代付きインデックスにする。** 相手から返ってくるまでの間に、こちら側のデータは移動しうる。整数なら、間接テーブルで整合を取れる。
- **キャンセルしても「成功の結果」が届くことがある。** その結果が fd やロックのような資源なら、受け取り手がいなくても解放が要る。キャンセル経路のテストでは、資源の数を数えるのが有効だ。
- **バッファの所有権を渡す API は、完了時に返す形にするしかない。** `(結果, バッファ)` のタプルを返す設計は不格好に見えるが、借用では表現できない。ここを無理に隠すと unsafe が漏れる。
- **リングバッファに押し込む前に、押し込める空きを確保する。** 提出側と完了側の両方が溢れうる。溢れて失われた完了通知は、待っている側の永久ハングとして現れる。
