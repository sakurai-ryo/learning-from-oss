---
title: "Pulley は「インタプリタ」ではなくターゲット ISA である"
description: "Pulley のバイトコードは、専用の変換器ではなく Cranelift の通常の命令選択から出てくる。isa/pulley_shared/ には 85KB の lower.isle があり、x64 や aarch64 と同じ扱いを受ける。この位置づけによって、ISLE のパターンマッチでスーパー命令を選べるようになり、一方でネイティブ向けの最適化が逆効果になる箇所も生まれた。"
group: "もう 2 つの実行器"
sidebar:
  order: 62
---

Pulley のバイトコードは、誰が生成するのか。

「Wasm からバイトコードへの変換器」があるのだろう、と考えるのが自然だ。実際はそうなっていない。Cranelift のバックエンドの一覧を見ると、こうなっている。

```console
$ ls cranelift/codegen/src/isa/
aarch64/  pulley_shared/  riscv64/  s390x/  x64/
```

**Pulley は Cranelift のターゲット ISA として実装されている。** `pulley_shared/lower.isle` は 1934 行、85KB ある。x64 や aarch64 の `lower.isle` と同じ形式の、同じ命令選択規則だ ([ISLE — 命令選択を DSL で書く](../isle/))。

つまり Wasm から Pulley バイトコードへの経路は、Wasm から x86-64 の機械語への経路と**完全に同じパイプラインを通る**。CLIF に翻訳され、e-graph で最適化され、ISLE で命令選択され、regalloc2 でレジスタが割り当てられ、`MachBuffer` でバイト列になる。ただ最後に出てくるバイト列が、CPU の命令ではなく Pulley の命令だというだけだ。

## この位置づけが生むもの

最適化がそのまま効く。定数畳み込みも、共通部分式除去も、ループ不変式の巻き上げも、Pulley 向けのコンパイルで同じように走る。**インタプリタ向けだからといって最適化を作り直さなくてよい。**

そしてもう 1 つ、README が明示的に挙げている利点がある。

```text title="pulley/README.md"
* We lean into defining super-instructions (sometimes called "macro ops") that
  perform the work of multiple operations in a single instruction. The more work
  we do in each turn of the interpreter loop the less we are impacted by its
  overhead. Additionally, Cranelift, as the primary Pulley bytecode producer,
  can leverage ISLE lowering patterns to easily identify opportunities for
  emitting super-instructions.
```

[pulley/README.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/pulley/README.md)

インタプリタの速度は、ループを 1 周するごとのオーバーヘッド（デコード、分岐、ディスパッチ）が支配する。だから 1 命令でやる仕事を増やせば速くなる。複数の演算をまとめた「スーパー命令」を定義したいわけだが、**どこにその機会があるかを見つける仕事は、命令選択そのもの**だ。

ISLE は「この CLIF のパターンにマッチしたらこの命令を出す」という規則を書く言語だから、スーパー命令の選択もそのまま書ける。x64 のバックエンドでロードを算術命令のオペランドに畳み込むのと、同じ仕組みで同じように書ける。**「インタプリタのための最適化」を、既存のコンパイラ基盤の語彙で表現できている。**

## ELF まで同じ道を通る

出力の扱いも他のターゲットと揃っている。Pulley のバイトコードは `.text` セクションに入り、ELF に詰められ、`.cwasm` として保存される ([.cwasm は ELF そのものである](../cwasm/))。

違いは 2 か所だけだ。1 つは、`object` クレートに渡すアーキテクチャを riscv64 だと偽ること。もう 1 つが、`.text` セクションにフラグを立てることだ。

```rust title="crates/cranelift/src/obj.rs"
        // If this target is Pulley then flag the text section as not needing the
        // executable bit in virtual memory which means that the runtime won't
        // try to call `Mmap::make_executable`, which makes Pulley more
        // portable.
        if compiler.triple().is_pulley() {
            let SectionFlags::Elf { sh_flags, .. } = obj.section_flags_mut(text_section) else {
                unreachable!();
            };
            *sh_flags = obj::SH_WASMTIME_NOT_EXECUTED;
        }
```

[crates/cranelift/src/obj.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/obj.rs)

`SH_WASMTIME_NOT_EXECUTED` が立っていれば、ランタイムは `mprotect` を呼ばない。**実行可能メモリを一切要求しないことが、Pulley の移植性の中身**なので、ここが本質的な差になる。テキストのアラインメント要求も 1 で済む。

## ネイティブ向けの最適化が逆効果になる場所

同じパイプラインを共有することの代償もある。ネイティブ CPU 向けに効く最適化が、インタプリタでは逆に働くことがある。

境界チェックのコード生成に、その実例がある。線形メモリへのアクセスを機械語に落とすとき、Wasmtime は特殊ケースを積み重ねてチェックを削っていく ([境界チェックを「消す」ための条件を数式で追う](../bounds-check-elision/))。そのうちの 1 つ、`offset + size == 1` のときの特殊化には、Pulley を除外する条件が付いている。理由は「Pulley 側で 1 命令にパターンマッチさせやすくするため」だ。

ネイティブなら、アドレス計算を細かく分解しても命令選択が拾ってくれる。Pulley では、分解された形が 1 つのバイトコード命令にまとまらず、ディスパッチ回数が増えてしまう。**命令 1 つのコストが桁違いに違うので、同じ変形が別の評価になる。**

スタックオーバーフローの検査も同じで、Pulley では発行されない ([スタックオーバーフローは、ガードページではなく明示チェック](../stack-limit/))。インタプリタはネイティブスタックを消費しないので、検査する対象がない。

## ホストへ抜けるときの借用

ランタイム側との接続には、Rust の借用に由来する問題がある。インタプリタの状態 `Vm` を `&mut` で持ったまま wasm を実行していると、そこからホスト関数が呼ばれたときに困る。

```rust title="crates/wasmtime/src/runtime/vm/interpreter.rs"
    /// For (b) that's the most tricky part of this, but the basic problem looks
    /// like:
    ///
    /// * The host initially executes some WebAssembly.
    /// * This acquires a `&mut Vm` and does some execution.
    /// * The WebAssembly then invokes the host.
    /// * This bottoms out in `CallIndirectHost` which means that we'll do a
    ///   dynamic dispatch to a function pointer in pulley registers.
    /// * The function we call gets unfettered access to `StoreContextMut<T>`
    /// * When the function returns our original `&mut Vm` pointer is
    ///   invalidated, so it has to be re-acquired.
    ///
    /// The usage of `StoreBox` here solves this conundrum by storing the
    /// `InterpreterRef` at-rest as a `NonNull<Vm>` as opposed to a `&mut Vm`.
```

[crates/wasmtime/src/runtime/vm/interpreter.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/interpreter.rs)

ホスト関数は `StoreContextMut<T>` を自由に触れる。そこから**別の wasm 実行を始めることもできる**。つまり `Vm` の状態が再帰的に書き換わりうる。だから元の `&mut Vm` は無効になったとみなし、ホスト呼び出しから戻るたびに Store から取り直す。

`StoreBox<VmState>` に `NonNull<Vm>` として置いておくのは、この「借用を持ち続けない」構造を型で表現するためだ。ゼロコストの逃げ道ではなく、**再入がありうるという事実をそのまま写した表現**になっている。

もう 1 つ、インタプリタとネイティブが同居する状況への対処もある。Pulley を有効にしていても、呼び出し先がホスト関数なら、インタプリタを経由せずネイティブに呼ぶ。`VMFuncRef` の `array_call` を呼ぶ際に vmctx の magic を見て、ホスト関数用のコンテキストだと分かれば直接呼び出しに切り替える ([VMFuncRef と、wasm_call が Option である理由](../vmfuncref/))。

## どう活かすか

「インタプリタを作る」と言われたとき、普通に思いつくのは AST や独自の中間表現を舐める実装だ。Pulley はそうではなく、**既存のコンパイラの最後の 1 段を差し替える**という形を取った。

これが効いたのは、Cranelift のパイプラインが「ターゲット ISA」という抽象で切られていたからだ。ISLE の規則ファイルと ABI 定義とレジスタ定義を書けば、新しいターゲットが増える。その抽象の内側に、実在しない CPU を 1 つ足しただけとも言える。

裏を返せば、**既存の抽象に乗せられるなら、新しい実行方式は驚くほど安く追加できる**。そして乗せた瞬間に、その抽象より上のすべて（最適化、テスト、fuzzing、ELF 出力）がそのまま効く。境界チェックの特殊化のように「ネイティブ前提の判断」が紛れ込んでいる箇所だけを、個別に手当てすればよい。
