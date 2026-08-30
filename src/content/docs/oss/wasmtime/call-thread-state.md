---
title: "CallThreadState — スタック上に置くアクティベーションの連結リスト"
description: "wasm に出入りするたびに積まれる状態は、ヒープではなくネイティブスタック上に置かれ、TLS のポインタ 1 個を頭とする単方向リストになっている。TLS を 1 ポインタに絞っている理由は fiber との統合で、切り替え時に swap すべきものが 1 個で済む。EntryStoreContext が Drop で対称性を守り、panic による巻き戻しでも復元される。"
group: "トラップと巻き戻し"
sidebar:
  order: 50
---

トラップが起きたとき、シグナルハンドラは「今どの Store のどのアクティベーションを実行中なのか」を知らなければならない。どこへ戻ればいいのか、バックトレースはどこからどこまでか、埋め込み側のカスタムハンドラは設定されているか。

その情報が `CallThreadState` に入っている。この構造体は **ヒープに置かれず、`catch_traps` のスタックフレームの上に直接置かれる**。そして TLS にあるポインタ 1 個を頭とする単方向リストを作る。

## 何を持っているか

```rust title="crates/wasmtime/src/runtime/vm/traphandlers.rs"
/// Temporary state stored on the stack which is registered in the `tls`
/// module below for calls into wasm.
///
/// This structure is stored on the stack and allocated during the
/// `catch_traps` function above. The purpose of this structure is to track
/// the state of an "activation" or a sequence of 0-or-more contiguous
/// WebAssembly call frames. A `CallThreadState` always lives on the stack
/// and additionally maintains pointers to previous states to form a linked
/// list of activations.
///
/// One of the primary goals of `CallThreadState` is to store the state of
/// various fields in `VMStoreContext` when it was created. This is done
/// because calling WebAssembly will clobber these fields otherwise.
pub struct CallThreadState {
    pub(super) unwind: Cell<Option<UnwindReason>>,
    #[cfg(all(has_native_signals))]
    pub(super) signal_handler: Option<*const SignalHandler>,
    pub(super) capture_backtrace: bool,
    #[cfg(feature = "coredump")]
    pub(super) capture_coredump: bool,

    pub(crate) vm_store_context: Cell<NonNull<VMStoreContext>>,
    pub(crate) unwinder: &'static dyn Unwind,

    pub(super) prev: Cell<tls::Ptr>,

    old_state: *mut EntryStoreContext,
}
```

[crates/wasmtime/src/runtime/vm/traphandlers.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/traphandlers.rs#L487-L525)

「アクティベーション」という語がドキュメントで定義されている。**0 個以上の連続した WebAssembly の呼び出しフレームの列**のことだ。ホストが wasm を呼ぶたびに 1 つ生まれる。

持ち物は 4 種類に分けられる。`unwind` は巻き戻しの理由 ([longjmp を使わず、ucontext を書き換えて戻る](../unwind-via-ucontext/))。`signal_handler` と `capture_backtrace` は `Store` の設定のコピーで、**シグナルハンドラの中から `Store` を借りずに読めるようにするため**にここに置かれている。`vm_store_context` は今の Store の `VMStoreContext` へのポインタ。`prev` と `old_state` がリストと復元用の情報だ。

`Cell` だらけなのにも理由が書かれている。「この構造体は TLS から指されるので、内部可変性を多用している。TLS 経由では `&CallThreadState` しか得られないから」。

## TLS はポインタ 1 個しかない

リストの頭は TLS にある。そして **Wasmtime の TLS はこのポインタ 1 個だけ**だ。

```rust title="crates/wasmtime/src/runtime/vm/traphandlers.rs"
/// Wasmtime at this time has a single pointer of TLS. This single pointer of
/// TLS is the totality of all TLS required by Wasmtime. By keeping this as
/// small as possible it generally makes it easier to integrate with external
/// systems and implement features such as fiber context switches. This single
/// TLS pointer is declared in platform-specific modules to handle platform
/// differences, so this module here uses getters/setters which delegate to
/// platform-specific implementations.
```

[crates/wasmtime/src/runtime/vm/traphandlers.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/traphandlers.rs#L1046-L1052)

理由が明記されている。**外部システムとの統合を容易にするため、そして fiber のコンテキストスイッチを実装するため**。

async 実行では wasm を別のネイティブスタックの上で走らせ、任意の地点で中断してホストへ戻る ([async に fiber が要る理由](../why-fiber/))。中断するときには「そのスタックに乗っている状態」を退避し、元のスタックの状態を復元しなければならない。**TLS に散らばった変数が 10 個あればその 10 個を swap する必要があるが、1 個なら 1 個で済む**。しかも「swap し忘れ」というバグが原理的に起きなくなる。この swap の詳細は [fiber を切り替えるとき、何を save/restore するのか](../fiber-state-swap/) が扱う。

TLS のポインタは「もっとも新しい (youngest) アクティベーション」を指す。より古いものは `prev` を辿る。

## スタック上のリンクリスト

ドキュメントに実際のスタック図がある。

```text title="crates/wasmtime/src/runtime/vm/traphandlers.rs"
┌─────────────────────┐◄───── highest, or oldest, stack address
│ native stack frames │
│         ...         │
│  ┌───────────────┐◄─┼──┐
│  │CallThreadState│  │  │
│  └───────────────┘  │  p
├─────────────────────┤  r
│  wasm stack frames  │  e
│         ...         │  v
├─────────────────────┤  │
│ native stack frames │  │
│         ...         │  │
│  ┌───────────────┐◄─┼──┼── TLS pointer
│  │CallThreadState├──┼──┘
│  └───────────────┘  │
├─────────────────────┤
│  wasm stack frames  │
│         ...         │
├─────────────────────┤
│ native stack frames │
│         ...         │
└─────────────────────┘◄───── smallest, or youngest, stack address
```

[crates/wasmtime/src/runtime/vm/traphandlers.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/traphandlers.rs#L1065-L1091)

この図が示しているのは、ホスト → wasm → ホスト → wasm という入れ子だ。wasm がインポートしたホスト関数を呼び、そのホスト関数がまた別の wasm 関数を呼ぶと、この形になる。`CallThreadState` は wasm の区間の直前 (アドレスの高い側) に置かれ、`prev` はスタックの上へ向かって伸びる。

リストの操作は `push` / `pop` の 2 つだけで、どちらもアサーション付きだ。

```rust title="crates/wasmtime/src/runtime/vm/traphandlers.rs"
pub(crate) unsafe fn push(&self) {
    assert!(self.prev.get().is_null());
    self.prev.set(tls::raw::replace(self));
}

pub(crate) unsafe fn pop(&self) {
    let prev = self.prev.replace(ptr::null());
    let head = tls::raw::replace(prev);
    assert!(core::ptr::eq(head, self));
}
```

[crates/wasmtime/src/runtime/vm/traphandlers.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/traphandlers.rs#L598-L629)

`pop` は「取り出したものが自分自身であること」を確認する。**リストが LIFO の順序で操作されているという不変条件を、デバッグビルドではなく常時チェックしている**。ここが崩れると、シグナルハンドラが解放済みのスタック領域を読むことになる。

## なぜスタック上なのか

`CallThreadState` の寿命は `catch_traps` の呼び出し 1 回ぶんと完全に一致する。wasm の呼び出しはネストするので、その寿命はスタックフレームの寿命そのものになる。

ヒープに置けば、wasm を呼ぶたびに `Box::new` と `drop`、つまりアロケータの往復が入る。Wasmtime は「ホストと wasm の境界を跨ぐコスト」を極小にすることに強くこだわっていて ([Func は 2 ワードしかない](../func-two-words/))、呼び出しごとの確保は許容できない。スタックに置けば、確保はスタックポインタの減算に含まれ、解放は関数から返るだけになる。

代償として、この構造体を指すポインタは「そのスタックフレームが生きている間だけ有効」になる。だから TLS からの参照は `unsafe` になり、`push` / `pop` の対称性が安全性の要になっている。

## VMStoreContext の保存と、Drop による対称性

`CallThreadState` の主目的の 1 つは、`VMStoreContext` のフィールドを「wasm に入る前の値」で保存しておくことだった。実際の保存と復元は `EntryStoreContext` が担当する。これも `invoke_wasm_and_catch_traps` のスタックフレーム上に置かれる。

```rust title="crates/wasmtime/src/runtime/func.rs"
/// This type helps managing the state of the runtime when entering and exiting
/// Wasm. To this end, it contains a subset of the data in `VMStoreContext`.
/// Upon entering Wasm, it updates various runtime fields and their
/// original values saved in this struct. Upon exiting Wasm, the previous values
/// are restored.
pub(crate) struct EntryStoreContext {
    /// If set, contains value of `stack_limit` field to restore in
    /// `VMStoreContext` when exiting Wasm.
    pub stack_limit: Option<usize>,
    pub last_wasm_exit_pc: usize,
    pub last_wasm_exit_trampoline_fp: usize,
    pub last_wasm_entry_fp: usize,
    pub last_wasm_entry_sp: usize,
    pub last_wasm_entry_trap_handler: usize,
    pub stack_chain: VMStackChain,

    /// We need a pointer to the runtime limits, so we can update them from
    /// `drop`/`exit_wasm`.
    vm_store_context: *const VMStoreContext,
}
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L1484-L1503)

保存されるのはバックトレースの区間境界 (`last_wasm_exit_pc` / `last_wasm_exit_trampoline_fp` / `last_wasm_entry_fp` / `last_wasm_entry_sp`)、トラップの復帰先 (`last_wasm_entry_trap_handler`)、スタックリミット、そしてスタックスイッチのチェーンだ。

復元は `Drop` で行われる。理由がコメントに書かれている。

```rust title="crates/wasmtime/src/runtime/func.rs"
/// This function restores the values stored in this struct. We invoke this
/// function through this type's `Drop` implementation. This ensures that we
/// even restore the values if we unwind the stack (e.g., because we are
/// panicking out of a Wasm execution).
#[inline]
fn exit_wasm(&mut self) {
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L1610-L1615)

**panic で巻き戻したときにも復元されるようにするため**に、明示的な `exit_wasm()` 呼び出しではなく `Drop` にしている。ここは前ページで見た「デストラクタが飛ぶ」経路とは対照的な位置にある。トラップの巻き戻しは wasm のフレームを飛ばすが、`EntryStoreContext` を持っているのは wasm を呼んだ**ホスト側**のフレームなので、そこまで戻れば普通に `Drop` が走る。

## 再帰呼び出しでスタックリミットを再計算しない

`enter_wasm` には小さな最適化が入っている。

```rust title="crates/wasmtime/src/runtime/func.rs"
// If this is a recursive call, e.g. our stack limit is already set, then
// we may be able to skip this function.
//
// For synchronous stores there's nothing else to do because all wasm calls
// happen synchronously and on the same stack. This means that the previous
// stack limit will suffice for the next recursive call.
//
// For asynchronous stores then each call happens on a separate native
// stack. This means that the previous stack limit is no longer relevant
// because we're on a separate stack.
if unsafe { *store.0.vm_store_context().stack_limit.get() } != usize::MAX
    && !store.0.can_block()
{
    stack_limit = None;
}
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L1523-L1537)

同期ストアで wasm → ホスト → wasm と再帰した場合、2 回目の呼び出しは 1 回目と同じネイティブスタックの続きにいる。したがって 1 回目に計算したリミットがそのまま使える。`stack_limit = None` にすると `exit_wasm` での書き戻しも省かれる。

**しかし async ストアでは成立しない**。`can_block()` の条件がそれを表している。async では各呼び出しが別の fiber スタックの上で走るので、前のスタックを基準に計算したリミットは意味を持たない。1 行の条件で、この 2 つのモードの違いが表現されている。スタックリミットの仕組み自体は [スタックオーバーフローは、ガードページではなく明示チェック](../stack-limit/) が扱う。

## どう活かすか

**「寿命が呼び出しのネストと一致する状態は、スタックに置いて連結リストにできる」**というパターンは応用が利く。ヒープ確保が消え、解放漏れが構造的に起きなくなり、`Drop` が対称性を保証してくれる。頭のポインタだけをどこか (TLS なりグローバルなり) に置けばよい。

そのうえで Wasmtime がやっている 2 つの補強が効いている。1 つは `push` / `pop` に自分自身の同一性チェックを入れて LIFO を常時検証すること。もう 1 つは、退避と復元を明示的な関数呼び出しではなく `Drop` に置いて、例外経路でも走ることを型で保証することだ。
