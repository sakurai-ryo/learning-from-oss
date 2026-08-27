---
title: "1 回のアロケーションに hot と cold を並べ、型情報は vtable のオフセットとして持つ"
description: "Tokio のタスクは header・core・trailer の 3 区画を 1 個の Box に押し込む。ランタイムが持ち回るのは先頭の header へのポインタだけで、型が消えている。それでも後ろの区画に届くのは、各フィールドのバイトオフセットを const fn で計算して vtable に埋め込んでいるからだ。関数ポインタのテーブルに整数を混ぜる、という珍しい形をしている。"
sidebar:
  order: 3
---

## 何を学んだか

### どんな状況の話か

`tokio::spawn(fut)` の `fut` の型は、呼び出しごとに全部違う。`async {}` ブロックはそれぞれ固有の匿名型になるからだ。

一方、ランタイム側 (実行キュー、ワーカー、I/O ドライバ、`Waker`) は、その型を知りたくない。知ってしまうと、キューが `VecDeque<Task<T>>` になって、型ごとに別のキューが要ることになる。

普通の解決策は `Box<dyn Future>` だ。しかしタスクに必要なものは future だけではない。

- 状態語 (前ページの `AtomicUsize`)
- 実行キューの連結ポインタ
- スケジューラへの参照
- タスク ID
- 登録簿の連結リストのポインタ
- `JoinHandle` 用の waker
- そして future 本体、または **その出力**

`Box<dyn Future>` にすると、これらを持つ構造体と future 本体で **アロケーションが 2 回** になる。タスクは 1 秒に何十万個も作られうるので、これは効く。

### Tokio の答え

**1 個の `Box<Cell<T, S>>` に全部入れて、先頭のフィールドへのポインタだけを持ち回る。**

```rust title="tokio/src/runtime/task/core.rs"
#[repr(C)]
pub(super) struct Cell<T: Future, S> {
    /// Hot task state data
    pub(super) header: Header,

    /// Either the future or output, depending on the execution stage.
    pub(super) core: Core<T, S>,

    /// Cold data
    pub(super) trailer: Trailer,
}
```

区画の分け方が **アクセス頻度** になっているところが目を引く。`header` は毎回触るもの、`trailer` は生成時と破棄時にしか触らないもの、`core` はその間。

`#[repr(C)]` と「header が先頭」という制約によって、`*mut Cell<T, S>` と `*mut Header` は同じアドレスになる。**だから型を消したポインタ (`NonNull<Header>`) をランタイム側に配って、型を知っている側でキャストし直せる。**

問題は「`header` から後ろの区画に届くか」だ。`Core<T, S>` のサイズは型ごとに違うので、`trailer` の位置は型ごとに違う。型を消したポインタからは計算できない。

Tokio はこれを、**vtable に整数を混ぜる** ことで解いている。

## ソースコードのどこか

### hot / cold の分け方

[`runtime/task/core.rs#L167-L213`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/core.rs#L167-L213)。

```rust title="tokio/src/runtime/task/core.rs"
/// Crate public as this is also needed by the pool.
#[repr(C)]
pub(crate) struct Header {
    /// Task state.
    pub(super) state: State,

    /// Pointer to next task, used with the injection queue.
    pub(super) queue_next: UnsafeCell<Option<NonNull<Header>>>,

    /// Table of function pointers for executing actions on the task.
    pub(super) vtable: &'static Vtable,
```

`Header` に入っているのは、**実行キューを回すのに必要な最小限** だ。状態語、次のタスクへのポインタ、vtable。ワーカーがキューからタスクを取り出して poll するとき、触るキャッシュラインはここだけで済む。

対して `Trailer`。

```rust title="tokio/src/runtime/task/core.rs"
/// Cold data is stored after the future. Data is considered cold if it is only
/// used during creation or shutdown of the task.
pub(super) struct Trailer {
    /// Pointers for the linked list in the `OwnedTasks` that owns this task.
    pub(super) owned: linked_list::Pointers<Header>,
    /// Consumer task waiting on completion of this task.
    pub(super) waker: UnsafeCell<Option<Waker>>,
```

**「cold の定義」がコメントに書いてある。** 生成時とシャットダウン時にしか使わないもの。登録簿の連結ポインタは `bind` と `remove` でしか触らないし、`JoinHandle` の waker は `await` されたときと完了時にしか触らない。

この分類は「なんとなく後ろに置いた」ではなく、**実行キューのホットパスがどのバイトを読むかを見て決められている**。

そして `Cell` 全体はキャッシュライン境界に整列される ([`#L44-L126`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/core.rs#L44-L126))。

```rust title="tokio/src/runtime/task/core.rs"
// # This struct should be cache padded to avoid false sharing. The cache padding rules are copied
// from crossbeam-utils/src/cache_padded.rs
//
// Starting from Intel's Sandy Bridge, spatial prefetcher is now pulling pairs of 64-byte cache
// lines at a time, so we have to align to 128 bytes rather than 64.
```

x86_64 と aarch64 と powerpc64 は 128 バイト、s390x は 256 バイト、m68k は 16 バイト。**アーキテクチャごとの根拠 URL が全部貼ってある。** Intel の最適化マニュアル、folly のヘッダ、Go の `internal/cpu`、Linux カーネルの `asm/cache.h`。

「128 バイトにしたのは、Sandy Bridge 以降のプリフェッチャが 64 バイトのラインを 2 本ずつ引いてくるから」という理由は、**この URL 群がないと後から検証できない**。

### vtable に整数を混ぜる

[`runtime/task/raw.rs#L24-L58`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/raw.rs#L24-L58)。

```rust title="tokio/src/runtime/task/raw.rs"
pub(super) struct Vtable {
    /// Polls the future.
    pub(super) poll: unsafe fn(NonNull<Header>),

    /// Schedules the task for execution on the runtime.
    pub(super) schedule: unsafe fn(NonNull<Header>),

    /// Deallocates the memory.
    pub(super) dealloc: unsafe fn(NonNull<Header>),

    /// Reads the task output, if complete.
    pub(super) try_read_output: unsafe fn(NonNull<Header>, *mut (), &Waker),
    ...
    /// The number of bytes that the `trailer` field is offset from the header.
    pub(super) trailer_offset: usize,

    /// The number of bytes that the `scheduler` field is offset from the header.
    pub(super) scheduler_offset: usize,

    /// The number of bytes that the `id` field is offset from the header.
    pub(super) id_offset: usize,
```

**関数ポインタのテーブルの末尾に、バイトオフセットが 3 つ並んでいる。**

前半の関数ポインタは普通の型消去だ。`poll::<T, S>` を `unsafe fn(NonNull<Header>)` として持つ。呼ばれた側で `Header` を `Cell<T, S>` にキャストし直す。

後半のオフセットは、**関数呼び出しをせずに型依存の情報を取り出すため** にある。たとえば「このタスクの `Trailer` はどこか」を知るのに、いちいち間接呼び出しをするのは無駄だ。整数を 1 個読んで足せば済む。

使う側 ([`core.rs#L456-L465`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/core.rs#L456-L465))。

```rust title="tokio/src/runtime/task/core.rs"
    pub(super) unsafe fn get_trailer(me: NonNull<Header>) -> NonNull<Trailer> {
        let offset = me.as_ref().vtable.trailer_offset;
        let trailer = me.as_ptr().cast::<u8>().add(offset).cast::<Trailer>();
        NonNull::new_unchecked(trailer)
    }
```

型を消したポインタから、型を知らないまま、`Trailer` に届く。

### オフセットを const fn で計算する

問題は「そのオフセットをどうやって求めるか」だ。Rust には安定した `offset_of!` が長らくなかった (`std::mem::offset_of!` の安定化は 1.77、Tokio の MSRV より新しい)。そこで **`#[repr(C)]` のレイアウトアルゴリズムを自分で実装している** ([`raw.rs#L120-L145`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/raw.rs#L120-L145))。

```rust title="tokio/src/runtime/task/raw.rs"
/// Compute the offset of the `Trailer` field in `Cell<T, S>` using the
/// `#[repr(C)]` algorithm.
///
/// Pseudo-code for the `#[repr(C)]` algorithm can be found here:
/// <https://doc.rust-lang.org/reference/type-layout.html#reprc-structs>
const fn get_trailer_offset(
    header_size: usize,
    core_size: usize,
    core_align: usize,
    trailer_align: usize,
) -> usize {
    let mut offset = header_size;

    let core_misalign = offset % core_align;
    if core_misalign > 0 {
        offset += core_align - core_misalign;
    }
    offset += core_size;

    let trailer_misalign = offset % trailer_align;
    if trailer_misalign > 0 {
        offset += trailer_align - trailer_misalign;
    }

    offset
}
```

**言語仕様のアルゴリズムを、仕様書の URL 付きで再実装している。** `#[repr(C)]` だからこそ、この計算が仕様として保証される。`repr(Rust)` ならフィールドの並び替えが許されているので、この手は使えない。

そして、これを呼ぶ場所に一段の間接が挟まっている ([`#L78-L100`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/raw.rs#L78-L100))。

```rust title="tokio/src/runtime/task/raw.rs"
/// Calling `get_trailer_offset` directly in vtable doesn't work because it
/// prevents the vtable from being promoted to a static reference.
///
/// See this thread for more info:
/// <https://users.rust-lang.org/t/custom-vtables-with-integers/78508>
struct OffsetHelper<T, S>(T, S);
impl<T: Future, S: Schedule> OffsetHelper<T, S> {
    // Pass `size_of`/`align_of` as arguments rather than calling them directly
    // inside `get_trailer_offset` because trait bounds on generic parameters
    // of const fn are unstable on our MSRV.
    const TRAILER_OFFSET: usize = get_trailer_offset(
        std::mem::size_of::<Header>(),
        std::mem::size_of::<Core<T, S>>(),
        std::mem::align_of::<Core<T, S>>(),
        std::mem::align_of::<Trailer>(),
    );
```

コメント 2 つが、それぞれ別の回避策を説明している。

1. **`vtable()` の中で関数を直に呼ぶと、返り値が `&'static Vtable` に昇格しない。** 関連定数にすると定数評価が確実に起きる。フォーラムのスレッドの URL 付き。
2. **`const fn` のジェネリック引数にトレイト境界を付けられない** (当時の MSRV では)。だから `size_of` / `align_of` を呼び出し側で評価して、ただの `usize` として渡す。

どちらも「言語の制約を回避した形」で、**理由を書いておかないと次に読む人が「無駄な間接だ」と潰しにかかる** タイプのコードだ。

### 計算が合っているかを debug ビルドで検証する

自前でレイアウトを計算しているので、間違えたら未定義動作になる。そこで生成時に確かめている ([`core.rs#L280-L321`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/core.rs#L280-L321))。

```rust title="tokio/src/runtime/task/core.rs"
        #[cfg(debug_assertions)]
        {
            // Using a separate function for this code avoids instantiating it separately for every `T`.
            unsafe fn check<S>(
                header: &Header,
                trailer: &Trailer,
                scheduler: &S,
                task_id: &Id,
            ) {
                let trailer_addr = trailer as *const Trailer as usize;
                let trailer_ptr = unsafe { Header::get_trailer(NonNull::from(header)) };
                assert_eq!(trailer_addr, trailer_ptr.as_ptr() as usize);
```

**「本物のフィールドのアドレス」と「オフセット計算で求めたアドレス」を突き合わせる。** 型を作った側では本物のアドレスが取れるので、そこで検算できる。

`Cell::new` はタスク生成のたびに呼ばれるので、この検査もタスクごとに走る。デバッグビルドでテストを 1 回でも回せば、レイアウトの計算違いは必ず出る。

### コード膨張を抑える工夫が随所にある

型ごとに単相化されるコードは、そのままだとバイナリサイズを押し上げる。だから **「ジェネリックでなくてよい部分」を関数に切り出す** パターンが繰り返し現れる。

```rust title="tokio/src/runtime/task/core.rs"
        // Separated into a non-generic function to reduce LLVM codegen
        fn new_header(
            state: State,
            vtable: &'static Vtable,
        ) -> Header {
```

```rust title="tokio/src/runtime/task/harness.rs"
            TransitionToRunning::Success => {
                // Separated to reduce LLVM codegen
                fn transition_result_to_poll_future(result: TransitionToIdle) -> PollFuture {
```

`Header` の構築も、列挙型の変換も、`T` にも `S` にも依存しない。**内側の関数として切り出せば、単相化の対象から外れて 1 個だけ生成される。**

同じ意図が `impl RawTask` の側にも書かれている ([`harness.rs#L53-L56`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L53-L56))。

```rust title="tokio/src/runtime/task/harness.rs"
/// Task operations that can be implemented without being generic over the
/// scheduler or task. Only one version of these methods should exist in the
/// final binary.
impl RawTask {
```

「最終バイナリに 1 版だけ存在すべきメソッド群」として `impl` ブロックが分かれている。**型消去は、性能だけでなくコンパイル成果物のサイズのためでもある。**

### 型を戻す側

型を知っている側の入口が `Harness` だ ([`harness.rs#L16-L30`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L16-L30))。

```rust title="tokio/src/runtime/task/harness.rs"
/// Typed raw task handle.
pub(super) struct Harness<T: Future, S: 'static> {
    cell: NonNull<Cell<T, S>>,
}

impl<T, S> Harness<T, S> {
    pub(super) unsafe fn from_raw(ptr: NonNull<Header>) -> Harness<T, S> {
        Harness {
            cell: ptr.cast::<Cell<T, S>>(),
        }
    }
```

vtable の各エントリは `Harness::from_raw` でこの型に戻してから仕事をする。**型が消えているのは vtable の外側だけで、内側では普通の型付きコードが書ける。**

`unsafe` の正当性は「vtable のエントリは `vtable::<T, S>()` で作られたものしか入らないので、`T` と `S` が一致している」という一点にかかっている。だから `Vtable` を作る関数は 1 個しかない。

## なぜそうなっているか

- **1 回のアロケーションに詰めたのは、タスクの生成が高頻度だから。** `Box<dyn Future>` + 管理構造体だと 2 回になる。サーバなら 1 リクエスト 1 タスクなので、この差がそのままスループットに出る。
- **`header` を先頭に置いたのは、`*mut Cell<T, S>` と `*mut Header` を同じアドレスにするため。** これで、型を消したポインタからのキャストがオフセット計算なしで済む。「header が最初のフィールドであることは critical だ」とコメントに明記されている。
- **hot / cold で区画を分けたのは、キャッシュのため。** ワーカーがキューを回すときに読むのは `Header` だけ。`Trailer` を先頭に置くと、使わないバイトのためにキャッシュラインを引くことになる。
- **キャッシュライン境界に整列するのは、隣接するタスク同士の false sharing を避けるため。** 別々のスレッドが別々のタスクを poll しているのに、状態語が同じラインに乗っていると、互いのストアが相手のキャッシュを無効化する。
- **vtable に整数を混ぜたのは、間接呼び出しを避けるため。** 「`Trailer` の位置」は型ごとに違うが定数だ。関数を呼んで返させるより、テーブルから整数を読んで足すほうが安い。
- **レイアウト計算を自前でやっているのは、`offset_of!` が MSRV で使えなかったから。** 代わりに `#[repr(C)]` の仕様アルゴリズムを再実装し、仕様書の URL を貼り、debug ビルドで実アドレスと突き合わせている。**「言語仕様を再実装する」という危ない選択を、検算で支えている。**
- **ジェネリックでない部分を内側の関数に切り出しているのは、単相化によるコード膨張を抑えるため。** タスクの型は使用箇所ごとに違うので、切り出さないと同じ機械語が何百個も生成される。

## どう活かすか

- **管理情報と本体を 1 個の確保にまとめられないか考える。** 生成頻度が高いオブジェクトでは、アロケーション回数がそのまま効く。可変長やジェネリックが絡んでも、`#[repr(C)]` と先頭フィールドの規約で押し切れることがある。
- **構造体のフィールドを、アクセス頻度で区画に分ける。** 「ホットパスがどのフィールドを読むか」を基準に並べると、キャッシュラインの引き方が変わる。区画の境界に「ここから先は cold だ」とコメントを書いておくと、後から追加されるフィールドの置き場所も決まる。
- **型消去は、性能のためだけでなくバイナリサイズのためにもやる。** ジェネリックな実装から「型に依存しない部分」を切り出して非ジェネリックな関数にすると、単相化の対象が減る。切り出す動機をコメントに書かないと、次の人がインライン化して戻す。
- **vtable のような「型ごとの定数表」には、関数だけでなく値も入れてよい。** サイズやオフセットのように、呼ばずに読めば済むものを関数にすると、間接呼び出しのぶん無駄になる。
- **言語仕様のアルゴリズムを再実装するなら、仕様の URL と実行時の検算をセットにする。** 検算は debug ビルド限定でよい。生成のたびに走る場所に置けば、テストを 1 回回すだけで間違いが露見する。
- **言語やツールの制約を回避したコードには、回避している対象と参照先を書く。** 「なぜこの間接が必要か」が書かれていないと、リファクタリングで消される。フォーラムのスレッドや issue の URL でも、何もないよりはるかによい。
