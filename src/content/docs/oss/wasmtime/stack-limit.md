---
title: "スタックオーバーフローは、ガードページではなく明示チェック"
description: "線形メモリの境界は MMU に任せるのに、ネイティブスタックのオーバーフローは関数プロローグの比較命令で検出する。理由は「ホストコードと wasm がスタックを共有しているので、埋め込み側に渡すスタック量を制御する必要がある」ことだ。ガードページは第一の防御ではなく、踏んだら abort する defense-in-depth という位置づけになっている。"
group: "サンドボックスを守るコード生成"
sidebar:
  order: 35
---

線形メモリの境界チェックは、条件が整えば命令が 1 つも出ない ([境界チェックを「消す」ための条件を数式で追う](../bounds-check-elision/))。同じ発想でスタックオーバーフローもガードページに任せられそうに見えるが、Wasmtime はそうしない。**リーフでない関数のプロローグすべてに、スタックポインタと `VMStoreContext.stack_limit` の比較を入れる**。

この非対称の理由は、コンパイラのコード生成の入口にコメントとして書かれている。

## プロローグに何を入れているか

`crates/cranelift/src/compiler.rs` の関数コンパイル本体が、翻訳を始める前にこの設定をする。

```rust title="crates/cranelift/src/compiler.rs"
// The `stack_limit` global value below is the implementation of stack
// overflow checks in Wasmtime.
//
// The Wasm spec defines that stack overflows will raise a trap, and
// there's also an added constraint where as an embedder you frequently
// are running host-provided code called from wasm. WebAssembly and
// native code currently share the same call stack, so Wasmtime needs to
// make sure that host-provided code will have enough call-stack
// available to it.
//
// The way that stack overflow is handled here is by adding a prologue
// check to all functions for how much native stack is remaining. The
// `VMContext` pointer is the first argument to all functions, and the
// first field of this structure is `*const VMStoreContext` and the
// third field of that is the stack limit. Note that the stack limit in
// this case means "if the stack pointer goes below this, trap". Each
// function which consumes stack space or isn't a leaf function starts
// off by loading the stack limit, checking it against the stack
// pointer, and optionally traps.
//
// This manual check allows the embedder to give wasm a relatively
// precise amount of stack allocation. Using this scheme we reserve a
// chunk of stack for wasm code relative from where wasm code was
// called. This ensures that native code called by wasm should have
// native stack space to run, and the numbers of stack spaces here
// should all be configurable for various embeddings.
```

[crates/cranelift/src/compiler.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/compiler.rs#L534-L585)

**理由は 1 行目にある。「WebAssembly とネイティブコードは現在同じコールスタックを共有している」**。wasm から呼ばれるホスト関数 (WASI の実装や、`Func::wrap` で渡した Rust のクロージャ) は、wasm と同じスタックの続きを使う。だから wasm がスタックを使い切ってしまうと、その後で呼ばれるホスト関数が使う分が残らない。

ガードページ方式では、この「残しておく」という制御ができない。ガードページに到達したときには、もうスタックは完全に尽きている。ホスト関数にはシグナルハンドラを走らせる分すら残っていないかもしれない。**明示チェックにすることで、「呼び出し元のスタックポインタから `max_wasm_stack` バイト下」という基準を任意に置けるようになる**。これが線形メモリとの決定的な違いだ。線形メモリは wasm 専用の領域で、ホストと共有していない。

チェック自体はこの形で出る。

```rust title="crates/cranelift/src/func_environ.rs"
// If an explicit stack limit is requested, emit one here at the start
// of the function.
if let Some(limit) = self.stack_limit_at_function_entry.take() {
    let vmctx = self.vmctx_val(&mut builder.cursor());
    let limit = limit.emit(&mut builder.cursor(), vmctx);
    let sp = builder.ins().get_stack_pointer(self.pointer_type());
    let overflow = builder.ins().icmp(IntCC::UnsignedLessThan, sp, limit);
    self.conditionally_trap(builder, overflow, ir::TrapCode::STACK_OVERFLOW);
}
```

正確には経路が 2 つあって、シグナルベースのトラップが有効なら Cranelift の `func.stack_limit` に [VMContext](../vmcontext/) からのロード連鎖を渡し、プロローグ生成の一部としてチェックを埋めてもらう。無効なら上のように翻訳の先頭で明示的に出す。どちらも `VMStoreContext` の `stack_limit` フィールドを読むところは同じだ。

## Pulley では発行しない

このブロックは条件で囲まれている。

```rust title="crates/cranelift/src/compiler.rs"
if !isa.triple().is_pulley() {
```

[Pulley](../pulley/) はバイトコードインタプリタなので、wasm の関数呼び出しがネイティブのコールスタックを消費しない。代わりに Pulley 自身が持つスタック配列の底を見ている。

```rust title="pulley/src/interp.rs"
/// Sets the stack pointer to the `sp` provided.
///
/// Returns a trap if this would result in stack overflow, or if `sp` is
/// beneath the base pointer of `self.state.stack`.
fn set_sp<I: Encode>(&mut self, sp: *mut u8) -> ControlFlow<Done> {
    let sp_raw = sp as usize;
    let base_raw = self.state.stack.base() as usize;
    if sp_raw < base_raw {
        return self.done_trap_kind::<I>(Some(TrapKind::StackOverflow));
    }
```

スタックポインタを動かす命令すべてで境界を見るので、プロローグに追加の検査は要らない。**「同じ保証を、どの層で実装するのが自然か」がターゲットによって変わる**という点で、[bounds-check-elision の `offset + size == 1` の特殊化を Pulley でだけ飛ばす話](../bounds-check-elision/) と同じ構図になっている。

## ガードページは第一の防御ではない

では、ネイティブスタックのガードページはどういう位置づけなのか。`docs/security.md` の「緩和策」の節にはっきり書かれている。

```text title="docs/security.md"
* Wasmtime uses explicit checks to determine if a WebAssembly function should be
  considered to stack overflow, but it still uses guard pages on all native
  thread stacks. These guard pages are never intended to be hit and will abort
  the program if they're hit. Hitting a guard page within WebAssembly indicates
  a bug in host configuration or a bug in Cranelift itself.
```

[docs/security.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/docs/security.md#L61-L66)

この節の見出しが「WebAssembly はサンドボックス化されるよう設計されているが、それでもバグや問題は不可避に生じるので、Wasmtime は正しい実行には必要ないが問題の緩和に役立つ機構をいくつか実装している」というものだ。つまり**ガードページは defense-in-depth であって、第一の防御ではない**。

そして踏んだ場合の扱いが厳しい。トラップにはならず、プロセスを abort する。「ホスト設定のバグか Cranelift 自身のバグを示す」からだ。同じファイルの同じ節に、線形メモリの前に置く 2GB のガード領域も並んでいて、そちらも「WebAssembly はこのメモリにアクセスする手段を持たないが、Cranelift でオフセットが符号付き 32bit として誤解釈されるような符号拡張バグから守れる」と説明されている。**「起きないはずのことが起きたら、握り潰さずに落とす」**という方針は、[トラップの PC が登録済みでなければ abort する判断](../is-this-wasm/) と一貫している。

## 限界値の計算が近似であること

`stack_limit` の値は wasm に入るたびに更新される。`EntryStoreContext::enter_wasm` が現在のスタックポインタから `max_wasm_stack` を引く。

```rust title="crates/wasmtime/src/runtime/func.rs"
// Determine the stack pointer where, after which, any wasm code will
// immediately trap. This is checked on the entry to all wasm functions.
//
// Note that this isn't 100% precise. We are requested to give wasm
// `max_wasm_stack` bytes, but what we're actually doing is giving wasm
// probably a little less than `max_wasm_stack` because we're
// calculating the limit relative to this function's approximate stack
// pointer. Wasm will be executed on a frame beneath this one (or next
// to it). In any case it's expected to be at most a few hundred bytes
// of slop one way or another. When wasm is typically given a MB or so
// (a million bytes) the slop shouldn't matter too much.
//
// Also note that `saturating_sub` is used here since if the user
// said that the function gets nigh-infinite stack well then by
// golly it'll get nigh-infinite stack in which case the limit is 0.
let wasm_stack_limit =
    stack_pointer.saturating_sub(store.engine().config().max_wasm_stack);
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L1558-L1584)

基準にしているのは `enter_wasm` 自身のスタックポインタなので、実際に wasm が走るフレームはこれより数百バイト下になる。**「数百バイトのずれは、1MB のスタックに対して問題にならない」と割り切っている**。厳密さより計算の簡単さを取った、という判断がコメントとして残っている。

`saturating_sub` のほうも読み方が面白い。`max_wasm_stack` に `usize::MAX` 近い値を設定されたら引き算が下方にラップする。そこで飽和させて 0 にする。すると「スタックポインタが 0 を下回ったらトラップ」となり、事実上どこまでも伸ばせる。**設定を無効値として拒否するのではなく、意味のある極限として解釈している**。

`Config::max_wasm_stack` の doc も、この機構が守るものと守らないものを明確にしている。「このつまみが制限するのは wasm コードが消費するスタック領域だけである。より重要なのは、呼び出し元スレッドのスタックにその量が空いていることを保証しないことだ。スレッドスタックを使い切ると通常はプロセスの **abort** になる」。つまり `max_wasm_stack` を 2MiB にしても、実際のスレッドに 512KiB しか残っていなければ、そちらが先に尽きてガードページ = abort に到達する。**リミットは「wasm に許す量」であって「確保する量」ではない**。

## 再帰呼び出しでは再計算を省く、ただし async は別

wasm がホスト関数を呼び、そのホスト関数がまた wasm を呼ぶ、という入れ子は普通に起きる。そのたびにリミットを計算し直す必要はない。

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

同期呼び出しなら全部同じスタックの上なので、外側で決めたリミットがそのまま内側にも効く。むしろ再計算すると内側のほうが深い位置を基準にしてしまい、wasm 全体で `max_wasm_stack` を超えて使えてしまう。

**async では話が変わる**。[fiber](../why-fiber/) を使う構成では wasm の呼び出しごとに別のネイティブスタックが割り当てられるので、前のスタックを基準に計算したリミットは別のアドレス空間の話になり、意味を持たない。だから `can_block()` が真のときは条件を外して必ず再計算する。`stack_limit` が `usize::MAX` かどうかで「まだ設定されていない」を判定しているのは、`VMStoreContext` の初期値がそれだからだ (`stack_limit: UnsafeCell::new(usize::MAX)`)。

## Store ごとの値であること

`stack_limit` は [VMStoreContext](../vmcontext/) のフィールドなので、インスタンスごとではなく **Store ごと**の値になる。

```rust title="crates/environ/src/vmtypes.rs"
/// Current stack limit of the wasm module.
///
/// For more information see `crates/cranelift/src/lib.rs`.
pub stack_limit: UnsafeCell<usize>,
```

同じ Store の中の複数のインスタンスが 1 つのコールスタックを共有するのだから、リミットもそこで共有されるのが自然だ。ただしスタックが切り替わるときは話が別で、`enter_wasm` の戻り値 `EntryStoreContext` が古い値を保持し、wasm から抜けるときに書き戻す。スタック切り替え proposal のほうでも `VMStackLimits` という構造体が各スタックごとに `stack_limit` の保存版を持ち、切り替えのたびに入れ替える ([fiber を切り替えるとき、何を save/restore するのか](../fiber-state-swap/))。

```rust title="crates/wasmtime/src/runtime/vm/stack_switching.rs"
/// Saved version of `stack_limit` field of `VMStoreContext`
pub stack_limit: usize,
```

**「ネイティブスタックが切り替わったらリミットも切り替わる」という不変条件が、複数の機構にまたがって維持されている**。逆に言えば、この不変条件を破る経路があれば、wasm に想定より多くのスタックを与えてしまう。

## 線形メモリとの対比まとめ

同じ「境界を守る」でも、選ばれた実装がここまで違う理由を並べるとこうなる。

線形メモリはゲスト専用の資源で、ホストと共有しない。境界の位置はメモリの割り当てのときに決まり、`memory.grow` のときにしか動かない。だから仮想メモリのマッピングとして表現でき、MMU に委譲できる。委譲すればチェック命令が消えて速い。

ネイティブスタックは**ホストと共有する資源**で、境界の位置は「今どこから wasm に入ったか」に依存する。呼び出しごとに違い、fiber を使えばスタックそのものが変わる。しかも境界に到達したときに残しておきたいものがある (ホスト関数とトラップ処理の分)。ページ保護は「ここから先は触れない」しか表現できず、「ここから先は wasm には触らせないがホストには触らせる」を表現できない。だから明示チェックになる。

**委譲先が持つ表現力が要求に足りているかどうか**が、この 2 つを分けている。
