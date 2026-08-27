---
title: "readiness 型と完了型の I/O を、1 つの `Completion` に揃える"
description: "同期 pread、io_uring、Windows IOCP、メモリ、そしてテスト用の細工つき実装。全部が同じ `IO` trait の裏にいて、エンジン側のコードは 1 通りしかない。鍵は「Completion は返した時点で既に完了しているかもしれない」を許したことで、これで同期バックエンドも非同期バックエンドも同じ経路を通る。完了型の I/O 特有の「カーネルが読み終わるまでバッファを手放せない」という制約も、Completion が抱える形で吸収している。"
sidebar:
  order: 5
---

## 何を学んだか

### 揃えるのが難しい 2 つの世界

ファイル I/O のインタフェースには、大きく 2 つの流儀がある。

|                               | いつ返るか                  | 誰がバッファを持つか               |
| ----------------------------- | --------------------------- | ---------------------------------- |
| **同期 (`pread`)**            | データが埋まってから        | 呼び出し側。返った時点で自由       |
| **readiness 型 (`epoll`)**    | 「読めるようになった」時点  | 呼び出し側。自分で `read` する     |
| **完了型 (`io_uring`, IOCP)** | 投げた直後 (完了は後で通知) | **カーネル。完了するまで触れない** |

Turso はこの 3 つ全部を、同じ `IO` trait の裏に置いている。

```rust title="core/io/mod.rs"
    #[cfg(all(target_os = "linux", feature = "io_uring", not(miri)))] {
        mod io_uring;
        #[cfg(feature = "fs")]
        pub use io_uring::UringIO;
    }

    #[cfg(all(target_family = "unix", not(miri)))] {
        mod unix;
        #[cfg(feature = "fs")]
        pub use unix::UnixIO;
        pub use unix::UnixIO as PlatformIO;
```

[`core/io/mod.rs#L18-L60`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/mod.rs#L18-L60)。

Linux の io_uring、Unix の同期 syscall、Windows の重複 I/O と IOCP、その他プラットフォーム向けの汎用実装、メモリ実装、そして VFS。**エンジン側のコードは、このどれが下にいても 1 通りしか書かれていない。**

### 揃えるためにした割り切り

**「`Completion` を返した時点で、もう完了しているかもしれない」を許した。**

これだけで、同期バックエンドが特別扱いから外れる。

```rust title="core/io/unix.rs"
    fn pread(&self, pos: u64, c: Completion) -> Result<Completion> {
        let result = unsafe {
            ...
            libc::pread(...)
        };
        if result == -1 {
            let e = std::io::Error::last_os_error();
            Err(io_error(e, "pread"))
        } else {
            trace!("pread n: {}", result);
            // Read succeeded immediately
            c.complete(result as i32);
            Ok(c)
        }
    }
```

[`core/io/unix.rs#L317-L338`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/unix.rs#L317-L338)。

同期バックエンドは、**その場で読んで、その場で完了させて、完了済みの `Completion` を返す**。

エンジン側から見ると何が起きるか。

1. ページを読みたいので `pread` を呼ぶ
2. `Completion` を受け取り、`IOResult::IO` で呼び出し元に帰る
3. 呼び出し元は `io.step()` を呼ぶ。同期バックエンドではこれは **何もしない**
4. `completion.finished()` が既に `true` なので、すぐ再開する

```rust title="core/io/unix.rs"
    fn step(&self) -> Result<()> {
        Ok(())
    }
```

[`core/io/unix.rs#L81-L83`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/unix.rs#L81-L83)。

**yield と再入のコストだけが余計にかかるが、コードの経路は完全に同じ**になる。これを嫌って「同期なら yield しない」という近道を作ると、同期バックエンドでしか通らない経路が生まれ、[再入のバグ](../reentrancy/) が同期環境では一切テストされなくなる。

## ソースコードのどこか

### `Completion` の中身

```rust title="core/io/completions.rs"
#[must_use]
#[derive(Debug, Clone)]
pub struct Completion {
    /// Optional completion state. If None, it means we are Yield in order to not allocate anything
    pub(super) inner: Option<Arc<CompletionInner>>,
}
```

[`core/io/completions.rs#L24-L29`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/completions.rs#L24-L29)。

**`inner: None` が「ただの yield」を表す。** I/O を伴わずに呼び出し元へ制御を返したいだけのとき、`Arc` を確保せずに済む。

```rust title="core/io/completions.rs"
    /// Create a yield completion. These are completed by default allowing to yield control without
    /// allocating memory.
    pub fn new_yield() -> Self {
        Self { inner: None }
    }
```

```rust title="core/io/completions.rs"
    pub fn is_explicit_yield(&self) -> bool {
        self.inner.is_none()
    }
```

[`core/io/completions.rs#L354-L358`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/completions.rs#L354-L358)。

「I/O を待つ」と「ただ譲る」を **同じ型で表しつつ、後者にコストを払わない**。`Option` の `None` が「もう終わっている完了」として振る舞う。

種類は `CompletionType` で分かれている。

```rust title="core/io/completions.rs"
pub enum CompletionType {
    Read(ReadCompletion),
    Write(WriteCompletion),
    Sync(SyncCompletion),
    Truncate(TruncateCompletion),
    Group(GroupCompletion),
    Yield,
}
```

[`core/io/completions.rs#L271-L278`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/completions.rs#L271-L278)。

`Group` が同じ列挙の中にいるのが効いている。**「複数の完了を束ねたもの」も 1 個の完了として扱える** ([前のページ](../io-result/))。入れ子にもできる。

### 完了型 I/O の制約は、`Completion` が抱える

`io_uring` に書き込みを投げると、`pwrite` は即座に返る。**だがカーネルはまだそのバッファを読んでいない。** ここでバッファを解放すると、カーネルが解放済みメモリを読む。

Turso はこれを、完了そのものにバッファを持たせて解決している。

```rust title="core/io/completions.rs"
    /// Keeps the write buffer alive for async I/O backends (io_uring, VFS)
    /// where pwrite returns before the kernel has consumed the buffer.
    write_buffer: OnceLock<Arc<Buffer>>,
```

```rust title="core/io/completions.rs"
    /// Stores a write buffer reference in the completion to keep it alive
    /// until the I/O completes. Required for async backends (io_uring, VFS)
    /// where pwrite returns before the kernel has consumed the buffer.
    pub fn keep_write_buffer_alive(&self, buf: Arc<Buffer>) {
        self.get_inner()
            .write_buffer
            .set(buf)
            .expect("write buffer should only be set once");
```

[`core/io/completions.rs#L112-L114`, `#L305-L312`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/completions.rs#L305-L312)。

**`Completion` が生きている限り、バッファも生きている。** 完了が破棄されるときに、バッファの参照も落ちる。

この配置が正しいのは、**「バッファを手放していい時刻」と「完了が不要になる時刻」が一致するから** だ。所有権を「同じ寿命を持つもの」に寄せておくと、解放漏れも早すぎる解放も起きない。

`OnceLock` で 1 回しか設定できないようにしているのも意図的で、1 つの完了に 2 つのバッファが紐づく状況は設計上ありえない。**ありえないことを型で禁じている。**

### `step()` は「1 人だけがカーネルに入る」

io_uring の `step()` は、リーダー/フォロワーの形になっている。

```rust title="core/io/io_uring.rs"
    fn step(&self) -> Result<()> {
        // Try to become the leader. If `wait_lock` is held, someone else
        // is already inside `submit_and_wait`/`drain_cq` and will fire
        // wakers on every completion drained: including ours. The
        // follower returns Ok immediately and lets the calling Future
        // park on its completion's waker.
        let Some(_wait_guard) = self.wait_lock.try_lock() else {
            return Ok(());
        };

        // Leader path: keep draining until the ring is empty. Looping
        // here matters: while we were in the kernel, more submitters
        // may have queued SQEs, and their futures need *us* to drain
        // their CQEs before the calling task can make progress.
        loop {
```

[`core/io/io_uring.rs#L513-L543`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/io_uring.rs#L513-L543)。

複数のスレッドが同時に `io.step()` を呼びうる。全員が `io_uring_enter` を叩くと、システムコールが無駄に増える。

**`try_lock` に失敗した側は、何もせずに帰る。** リーダーが完了キューを吸い出すとき、**自分の分の waker も一緒に叩かれる** ので、待っていれば進む。

リーダー側のループも重要だ。コメントが理由を書いている。**「カーネルにいる間に、別のスレッドが新しい SQE を積んだかもしれない」。** そのスレッドの future は、リーダーが CQE を吸い出すのを待っている。空になるまで回らないと、そこで止まる。

**「たまたまリーダーになった 1 人が、全員分の面倒を見る」** — 専用の I/O スレッドを持たない設計だと、この形になる。

### 待ち方は 2 通り用意されている

```rust title="core/io/mod.rs"
    /// Drive the IO backend until each completion in `completions` is
    /// `finished()`. Used after `cancel()` (so cancelled ops actually
    /// release their buffers before the caller returns) and after a
    /// single `pwrite`/`pwritev`/`sync` that the caller wants to await
    /// synchronously.
    ///
    /// Unlike a global "drain the ring" barrier, this only waits on the
    /// completions the caller passes in. Other threads can keep
    /// submitting concurrently — their work doesn't extend or interfere
    /// with this call. `Completion::finished()` is monotonic
    /// (`OnceLock`-backed), so the loop will terminate as soon as every
    /// caller-owned completion has had its CQE processed.
    fn drain_completions(&self, completions: &[Completion]) -> Result<()> {
        while completions.iter().any(|c| !c.finished()) {
            self.step()?;
        }
        Ok(())
    }
```

[`core/io/mod.rs#L448-L465`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/mod.rs#L448-L465)。

**「リングを全部空にする」ではなく「自分が渡した完了だけを待つ」。** 前者だと、他のスレッドが投げ続けている限り終わらない。

終了が保証される根拠まで書いてある。**`finished()` が単調 (`OnceLock` なので一度 true になったら戻らない)** だから、有限回で抜ける。

キャンセル後の用途が最初に挙がっているのも見ておきたい。**キャンセルしても、カーネルがバッファを手放すまでは解放できない。** 完了型 I/O では「やめる」が即座に終わらない。

### `Completion` は `Future` でもある

```rust title="core/io/completions.rs"
impl Future for Completion {
    type Output = Result<(), crate::LimboError>;

    fn poll(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Self::Output> {
        self.set_waker(cx.waker());
        if self.finished() {
            self.wake();
            ...
            return Poll::Ready(res);
        }
        Poll::Pending
    }
}
```

[`core/io/completions.rs#L31-L44`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/completions.rs#L31-L44)。

エンジンの内部は `async` を使わないが、**`Completion` 自体は `Future` を実装している**。だから外側が Tokio なら、そのまま `.await` できる。

waker の登録も丁寧で、既に別の waker があるときは「本当に別のタスクを起こすのか」を `will_wake` で確かめてから差し替えている。

## なぜそうなっているか

- **「返した時点で完了しているかもしれない」を許したのは、同期バックエンドを特別扱いしないため。** 特別扱いすると、同期環境でしか通らない経路と非同期環境でしか通らない経路ができる。片方でしか出ないバグが生まれる。
- **yield 用の完了をアロケーションなしにしたのは、それが最も多いから。** 「I/O はないが制御を返したい」は頻繁に起きる。ここで毎回 `Arc` を確保すると、譲るたびにヒープを触ることになる。
- **書き込みバッファを `Completion` に持たせたのは、寿命が一致するから。** 完了型 I/O では「バッファを手放していい時刻」が呼び出し側から見えない。見える側 (完了) に所有権を移す。
- **`OnceLock` で 1 回に制限したのは、2 個目がありえないから。** ありえない操作を実行時チェックではなく型で禁じると、レビューで見落としても壊れない。
- **`step()` をリーダー/フォロワーにしたのは、I/O 専用スレッドを持たないから。** 誰がイベントループを回すかが決まっていない以上、「同時に来たら 1 人が代表する」形になる。
- **リーダーがリングを空にするまで回るのは、フォロワーの完了を落とさないため。** 自分の分だけ取って抜けると、他のスレッドが永遠に待つ。
- **待ちの単位を「渡した完了だけ」にしたのは、他のスレッドと干渉しないため。** グローバルなバリアにすると、忙しいシステムでは終わらない。
- **`Completion` に `Future` を実装したのは、外側が非同期なら橋を架けたいから。** 内部で async を使わない判断と、外部に async を提供しない判断は別物だ。

## どう活かすか

- **同期と非同期を 1 つのインタフェースに揃えるなら、「もう終わっている完了」を許す。** 同期側に分岐を作らない方が、経路が 1 本になってテストが効く。多少の無駄なラウンドトリップは、その対価として安い。
- **「何もしない」を表す値に、コストを払わない作りにする。** `Option::None` で表す、`enum` の 1 バリアントにする。頻度が高い操作ほど、ここが効く。
- **非同期 I/O に渡したバッファの所有権は、完了ハンドルに持たせる。** 呼び出し側で管理すると、「いつ解放していいか」の判断が呼び出し側に散る。完了と寿命が一致するので、そこに置くのが自然になる。
- **キャンセルが即座に終わらない世界を前提にする。** 完了型 I/O では、キャンセルを投げてもカーネルはまだバッファを持っている。「やめた後に待つ」経路が必ず要る。
- **専用スレッドを持たないイベントループは、リーダー選出で回す。** 全員が同時にカーネルに入るのは無駄で、かといって誰も入らないと止まる。`try_lock` で 1 人が代表し、残りは waker で起きる形が素直だ。
- **代表者は、自分の分だけ取って抜けない。** 他人の完了を吸い出す責任まで負わないと、フォロワーが待ち続ける。
- **待ちの単位を、グローバルではなく「自分が投げた分」にする。** グローバルなドレインは、負荷が高いほど終わらなくなる。
- **内部で採用しない仕組みでも、外向きには提供する。** 内部を `async` にしないことと、`Future` を実装しないことは別の判断だ。
