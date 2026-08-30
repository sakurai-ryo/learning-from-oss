---
title: "バックトレースの作り方と、macOS・Windows の事情"
description: "wasm のバックトレースは、VMStoreContext に記録した entry SP / exit FP で「連続した wasm フレームの区間」を切り出し、その中を FP チェーンでたどって作る。そして macOS は mach ports、Windows は continue ハンドラという追加の仕掛けを持っている。どちらも「他のソフトウェアと共存する」ためだけに増えたコードで、Windows のそれは Go ランタイム 1 つのために存在する。"
group: "トラップと巻き戻し"
sidebar:
  order: 51
---

トラップが起きたとき、埋め込み側が受け取る `Trap` には wasm のバックトレースが付いている。しかしスタックの上には wasm のフレームとホストのフレームが混ざって積まれていて、しかも wasm のフレームは連続しているとは限らない。

Wasmtime のバックトレースは 2 段構えでこれを解く。そして**そもそも「シグナル」という仕組み自体が OS ごとに違う**ので、macOS と Windows には専用の実装がある。どちらも「他のソフトウェアと共存する」ためだけに増えたコードだ。

## 2 段構え

モジュールの冒頭に、方針がそのまま書かれている。

```rust title="crates/wasmtime/src/runtime/vm/traphandlers/backtrace.rs"
//! Walking the Wasm stack is comprised of
//!
//! 1. identifying sequences of contiguous Wasm frames on the stack
//!    (i.e. skipping over native host frames), and
//!
//! 2. walking the Wasm frames within such a sequence.
//!
//! To perform (1) we maintain the entry stack pointer (SP) and exit frame
//! pointer (FP) and program counter (PC) each time we call into Wasm and Wasm
//! calls into the host via trampolines (see
//! `crates/wasmtime/src/runtime/vm/trampolines`). The most recent entry is
//! stored in `VMStoreContext` and older entries are saved in
//! `CallThreadState`. This lets us identify ranges of contiguous Wasm frames on
//! the stack.
//!
//! To solve (2) and walk the Wasm frames within a region of contiguous Wasm
//! frames on the stack, we configure Cranelift's `preserve_frame_pointers =
//! true` setting. Then we can do simple frame pointer traversal starting at the
//! exit FP and stopping once we reach the entry SP (meaning that the next older
//! frame is a host frame).
```

[crates/wasmtime/src/runtime/vm/traphandlers/backtrace.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/traphandlers/backtrace.rs#L1-L22)

**(1) が区間の切り出し、(2) がその中の走査**だ。(2) だけなら普通のフレームポインタ走査でよく、Cranelift に `preserve_frame_pointers = true` を指定してあるので RBP のチェーンをたどるだけで済む。難しいのは (1) のほうにある。

## なぜ「区間」が必要なのか

wasm はホスト関数をインポートできる。ホスト関数は `Store` を持っているので、その中からまた別の wasm 関数を呼べる。すると 1 本のネイティブスタックの上に、wasm の区間とホストの区間が交互に積まれることになる。

```text
  高いアドレス (古い)

  ┌───────────────────────────────────
  │ ホスト: Func::call
  │   CallThreadState #1
  ├───────────────────────────────────  ◄── #1 が保存した entry SP / entry FP
  │ エントリトランポリン
  │ wasm フレーム A
  │ wasm フレーム B                        wasm 区間 1
  │ exit トランポリン
  ├───────────────────────────────────  ◄── #1 が保存した exit PC / exit FP
  │ ホスト: wasm から呼ばれたインポート関数
  │   CallThreadState #2   ◄── TLS ポインタはここを指す
  ├───────────────────────────────────  ◄── VMStoreContext.last_wasm_entry_sp / _fp
  │ エントリトランポリン
  │ wasm フレーム C                        wasm 区間 2 (最新)
  │ wasm フレーム D   ← ここでフォルト
  └───────────────────────────────────  ◄── トラップ時の pc / fp

  低いアドレス (新しい)
```

FP チェーンを素朴にたどると、wasm 区間 2 の先で「ホストのフレーム」に入ってしまう。ホストのフレームは Rust コンパイラが生成したもので、フレームポインタが省略されているかもしれないし、そもそも wasm の関数として解釈してはいけない。

だから**区間の境界をあらかじめ記録しておく**。ホストが wasm に入るときにエントリトランポリンが `last_wasm_entry_sp` / `last_wasm_entry_fp` を書き、wasm がホストに出るときに exit トランポリンが `last_wasm_exit_pc` / `last_wasm_exit_trampoline_fp` を書く。**最新の 1 組だけが `VMStoreContext` にあり、それより古い組は `CallThreadState` が退避している** ([CallThreadState — スタック上に置くアクティベーションの連結リスト](../call-thread-state/))。

走査はこの区間のリストを新しい側から順に消費していく。

```rust title="crates/wasmtime/src/runtime/vm/traphandlers/backtrace.rs"
let (last_wasm_exit_pc, last_wasm_exit_fp) = match trap_pc_and_fp {
    // If we exited Wasm by catching a trap, then the Wasm-to-host
    // trampoline did not get a chance to save the last Wasm PC and FP,
    // and we need to use the plumbed-through values instead.
    Some((pc, fp)) => { /* ... */ (pc, fp) }
    // Either there is no Wasm currently on the stack, or we exited Wasm
    // through the Wasm-to-host trampoline.
    None => unsafe { /* VMStoreContext から読む */ },
};
```

[crates/wasmtime/src/runtime/vm/traphandlers/backtrace.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/traphandlers/backtrace.rs#L208-L234)

**トラップのときだけ最新区間の終端が特別扱いになる**理由が書かれている。通常は exit トランポリンが `last_wasm_exit_pc` を書いてからホストへ抜けるが、フォルトで抜けた場合はトランポリンを通っていないので、そのフィールドは古いままだ。だからシグナルハンドラが `ucontext` から読んだ PC と FP をここに差し込む。

`last_wasm_exit_trampoline_fp` が「最後の wasm フレームの FP」ではなく「トランポリンのフレームの FP」を保持しているのにも理由がある。

```rust title="crates/environ/src/vmtypes.rs"
/// Used to find the start of a contiguous sequence of Wasm frames
/// when walking the stack. Note that we record the FP of the
/// *trampoline*'s frame, not the last Wasm frame, because we need
/// to know the SP (bottom of frame) of the last Wasm frame as
/// well in case we need to resume to an exception handler in that
/// frame. The FP of the last Wasm frame can be recovered by
/// loading the saved FP value at this FP address.
pub last_wasm_exit_trampoline_fp: UnsafeCell<usize>,
```

[crates/environ/src/vmtypes.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/vmtypes.rs#L364-L380)

1 段外側を記録しておくと、そこから内側の FP も SP も両方復元できる。例外ハンドラへ resume するには最後の wasm フレームの SP が要るので、この形になっている。

## ネイティブ PC を wasm のオフセットに戻す

区間を走査して得られるのはネイティブの PC の列だ。これを利用者に見せるには、wasm のどの関数のどのバイト位置かに翻訳しなければならない。そのための表がもう 1 つのカスタムセクションにある。

```rust title="crates/environ/src/obj.rs"
/// A custom Wasmtime-specific section of our compilation image which stores
/// mapping data from offsets in the image to offset in the original wasm
/// binary.
pub const ELF_WASMTIME_ADDRMAP: &str = ".wasmtime.addrmap";
```

[crates/environ/src/obj.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/obj.rs#L34-L42)

`FrameInfo::new` がこれを引く。テキストオフセットから関数インデックスを求め、`lookup_file_pos` で元の wasm バイナリ内の位置を得る。

```rust title="crates/wasmtime/src/runtime/trap.rs"
let instr =
    wasmtime_environ::lookup_file_pos(module.engine_code().address_map_data(), text_offset);
```

[crates/wasmtime/src/runtime/trap.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/trap.rs#L496-L520)

`.wasmtime.traps` が「どこがトラップしうるか」の表だったのに対し ([「これは wasm 由来のフォルトか」を 3 段階で判定する](../is-this-wasm/))、`.wasmtime.addrmap` は「どこが元の何番目のバイトか」の表だ。両方ともテキストセクション先頭からの相対オフセットをキーにしている。

## macOS は mach ports を使う

ここからプラットフォームの話になる。macOS ではシグナルを使わない。

```rust title="crates/wasmtime/src/runtime/vm/sys/unix/machports.rs"
//! Unlike other Unix platforms macOS here uses mach ports to handle exceptions
//! instead of signals. While macOS platforms could use signals (and
//! historically they did!) this is incompatible when Wasmtime is linked into a
//! project that is otherwise using mach ports for catching exceptions. This
//! came up #2456 notably when a project like Breakpad is integrated to blanket
//! catch exceptions and report them.
//!
//! Mach ports are somewhat obscure and not really heavily used in a ton of
//! places. Needless to say the original author of this file worked with mach
//! ports for the first time when writing this file. As such the exact specifics
//! here may not be super well documented. This file is 100% lifted from
//! SpiderMonkey and then adapted for Wasmtime's purposes. Credit for almost
//! all of this file goes to SpiderMonkey for figuring out all the fiddly bits.
```

[crates/wasmtime/src/runtime/vm/sys/unix/machports.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/unix/machports.rs#L1-L18)

理由は**共存**だ。Breakpad のようなクラッシュレポータが mach ports で例外を総取りしている環境では、Wasmtime がシグナルハンドラを設置しても呼ばれない。mach ports のほうがシグナルより優先度が高い層にあるからだ。

そして「この file の著者はこれを書くとき初めて mach ports を触った」「SpiderMonkey から 100% 移植した」と正直に書いてある。**参照実装として Firefox の該当ファイルへのリンクまで貼られている**。

mach ports はシグナルと動作モデルが根本的に違う。

```rust title="crates/wasmtime/src/runtime/vm/sys/unix/machports.rs"
//! The high-level overview is that when using mach ports a thread is blocked
//! when it generates an exception and then a message can be read from the
//! port. This means that, unlike signals, threads can't fix their own traps.
//! Instead a helper thread is spun up to service exception messages. This is
//! also in conflict with Wasmtime's exception handling currently which is to
//! use a thread-local to store information about how to unwind. Additionally
//! this requires that the check of whether a pc is a wasm trap or not is a
//! global check rather than a per-thread check. This necessitates the existence
//! of `GlobalModuleRegistry` in the `wasmtime` crate.
```

[crates/wasmtime/src/runtime/vm/sys/unix/machports.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/unix/machports.rs#L20-L28)

**被害スレッドは停止し、別のヘルパースレッドがメッセージを読んで処理する。** ヘルパースレッドの TLS は被害スレッドの TLS ではないので、「この PC は wasm か」の判定をスレッドローカルな情報でできない。前ページで見た `lookup_code` のグローバルな BTreeMap は、この 1 点のために存在している。

処理の流れも二段になる。ヘルパースレッドは判定だけして、被害スレッドのレジスタを `thread_set_state` で書き換え、[`unwind` という「ランディングパッド」](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/unix/machports.rs#L454-L461)へ飛ばす。この関数のコメントいわく「スレッド自身に戻ってからネイティブのバックトレースを取ることが主な目的」で、実際のトラップ記録と巻き戻しは被害スレッド自身の TLS を使って行われる。

もう 1 つ、この方式には制約がある。fork した子プロセスでは動かない。Wasmtime は `pthread_atfork` でフラグを立てておき、子プロセスが wasm を実行しようとしたら明示的に落とす。

```rust title="crates/wasmtime/src/runtime/vm/sys/unix/machports.rs"
pub fn lazy_per_thread_init() {
    unsafe {
        assert!(
            !CHILD_OF_FORKED_PROCESS,
            "cannot use Wasmtime in a forked process when mach ports are \
             configured, see `Config::macos_use_mach_ports`"
        );
```

[crates/wasmtime/src/runtime/vm/sys/unix/machports.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/unix/machports.rs#L493-L503)

**「動かない」を黙って壊れるのではなく、原因と回避設定の名前を書いた assert で落とす**。macOS でもシグナル方式を選ぶ `Config::macos_use_mach_ports(false)` が用意されていて、そちらなら fork 後も動く。

## Windows は例外ハンドラと continue ハンドラの 2 つを入れる

Windows は Vectored Exception Handling を使う。シグナルと違い、単一のグローバルハンドラではなくハンドラのリストがあり、前後どちらにも push できる。

そして Wasmtime は**例外ハンドラと continue ハンドラの両方**を、どちらもリストの先頭に入れる。

```rust title="crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs"
let exception_handler = unsafe { AddVectoredExceptionHandler(1, Some(exception_handler)) };
// ...
let continue_handler = unsafe { AddVectoredContinueHandler(1, Some(continue_handler)) };
```

[crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs#L110-L128)

例外ハンドラのほうは自然だ。wasm 由来の例外なら `EXCEPTION_CONTINUE_EXECUTION` を返して実行を継続させる。問題は 2 つ目の continue ハンドラで、モジュールドキュメントに「なぜこれが要るのか」の節がまるごと立っている。

```rust title="crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs"
//! # Why both an exception and continue handler?
//!
//! All of Wasmtime's tests in this repository will pass if the continue handler
//! is removed, so why have it? The primary reason at this time is integration
//! with the Go runtime as discovered in the `wasmtime-go` embedding.
```

[crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs#L48-L52)

**「このハンドラを消してもリポジトリ内のテストは全部通る」と自分で明言している。** それでも入れる理由が Go ランタイムとの統合だ。

```rust title="crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs"
//! * The problem with Go is the second, final, continue handler. This will, by
//!   default, abort the process for all exceptions whether or not they're Go
//!   related. ... This second handler is the
//!   problematic one because in Wasmtime we "catch" the exception in the
//!   exception handler function but then the process still aborts as all
//!   continue handlers are run, including Go's abort-the-process handler.
//!
//! Thus the reason Wasmtime has a continue handler in addition to an exception
//! handler. By installing a high-priority continue handler that pairs with the
//! high-priority exception handler we can ensure that, for example, Go's
//! fallback continue handler is never executed.
//!
//! This is all... a bit... roundabout. Sorry.
```

[crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs#L71-L84)

Windows は `EXCEPTION_CONTINUE_EXECUTION` が返ったあと、今度は continue ハンドラのリストを順に呼ぶ。Go は末尾に「すべての例外でプロセスを abort する」ハンドラを置いている。だから Wasmtime が例外を握り潰しても、その後で Go に殺される。

対策として、先頭に continue ハンドラを 1 つ置き、そこで `EXCEPTION_CONTINUE_EXECUTION` を返して**リストの残りを短絡させる**。実装は TLS の `LAST_EXCEPTION_PC` を例外ハンドラで書き、continue ハンドラで現在の PC と突き合わせるだけだ。

```rust title="crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs"
let last_exception_pc = LAST_EXCEPTION_PC.with(|s| s.replace(0));
// ... アーキごとに context_pc を取り出す ...
if last_exception_pc == context_pc {
    EXCEPTION_CONTINUE_EXECUTION
} else {
    EXCEPTION_CONTINUE_SEARCH
}
```

[crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/windows/vectored_exceptions.rs#L274-L295)

**特定の他言語ランタイム 1 つとの共存のためだけに、ハンドラを 1 つ増やしている。** しかも自分のテストでは検出できないと分かったうえでだ。「This is all... a bit... roundabout. Sorry.」という結びが、この判断の性質をよく表している。プロセス全体の例外機構を触るライブラリになると、こういう費用が付いてくる。

## fiber のスタックオーバーフローだけは専用の扱い

もう 1 つ、プラットフォーム層に置かれた特別扱いがある。async 実行では wasm が fiber の専用スタックの上で走り、そのスタックの末尾にはガードページが置かれる。ここを踏んだフォルトは wasm のトラップではないので `NotWasm` になるが、そのまま委譲すると利用者には理由不明の SIGSEGV としか見えない。

そこで `NotWasm` と判定したあと、フォルトアドレスがガード領域の中かどうかを確認する。

```rust title="crates/wasmtime/src/runtime/vm/sys/unix/signals.rs"
TrapTest::NotWasm => {
    if let Some(faulting_addr) = faulting_addr {
        let range = unsafe { &info.vm_store_context.get().as_ref().async_guard_range };
        if range.start.addr() <= faulting_addr && faulting_addr < range.end.addr() {
            abort_stack_overflow();
        }
    }
    false
}
```

[crates/wasmtime/src/runtime/vm/sys/unix/signals.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/unix/signals.rs#L172-L182)

[`abort_stack_overflow`](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/unix/signals.rs#L228-L234) は `"execution on async fiber has overflowed its stack"` を libc の `write` で直接吐いてから `abort` する。シグナルハンドラの中なので `println!` もアロケーションも使えず、システムコール 1 つで済ませている。

`async_guard_range` は `VMStoreContext` のフィールドで、fiber を使っていないときは null..null になる。そのときは範囲比較が必ず false になるので、分岐 1 つで済んでいる。

## sys/ の構成

これらのプラットフォーム差は 1 つのディレクトリに封じ込められている。モジュールの目標は「Wasmtime を新しいプラットフォームへ移植するとき編集する唯一のモジュール」であることだと書かれていて、選択は 1 つの `cfg_select!` にまとまっている。

```rust title="crates/wasmtime/src/runtime/vm/sys/mod.rs"
cfg_select! {
    miri => { mod miri; pub use miri::*; }
    not(feature = "std") => { mod custom; pub use custom::*; }
    windows => { mod windows; pub use windows::*; }
    unix => { mod unix; pub use unix::*; }
    _ => { mod custom; pub use custom::*; }
}
```

[crates/wasmtime/src/runtime/vm/sys/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/mod.rs#L52-L72)

注目したいのは `custom` だ。これは既知の OS がない環境向けの実装で、[Wasmtime のプラットフォーム依存部分を「最小の C API」の言葉で定義し直したもの](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/custom/mod.rs#L1-L9)になっている。`no_std` 環境や独自 OS へ移植するとき、必要なのは数個の C 関数を実装することだけになる。`miri` の分岐があるのも同じ発想で、Miri の下では実際のシグナルもフォルトも扱えないので、そこだけ差し替える。**「移植のとき編集するのはここ 1 か所」という約束を、`cfg` を散らかさずに保つための構造**だ。

## どう活かすか

このページの 3 つの実装から取り出せるものは共通している。**プロセス全体で共有される資源 (シグナルハンドラ、例外ハンドラのリスト) を触るライブラリは、他人と共存するためのコードが本質的なコードと同じくらいの量になりうる**。

そのうえで Wasmtime のやり方が良いのは、そのコードに**理由をすべて書き残している**ことだ。「#2456 で Breakpad が問題になった」「SpiderMonkey から移植した」「テストは全部これ無しで通るが Go のために要る」。どれも 3 年後に「これ要らないのでは」と削ろうとした人が、削る前に読める場所に置かれている。テストで守れない要件は、コメントで守るしかない。
