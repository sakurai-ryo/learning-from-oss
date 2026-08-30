---
title: "Pulley — JIT できない場所のためのバイトコード VM"
description: "機械語を生成して実行できない環境がある。Wasmtime はそこに Pulley という自前のバイトコードとインタプリタを持ち込んだ。enum Instruction を一度も構築しないという原則が可変長エンコーディングを可能にし、命令定義がマクロ 1 箇所にあることでデコーダ・エンコーダ・逆アセンブラのずれが構造的に起きない。"
group: "もう 2 つの実行器"
sidebar:
  order: 61
---

JIT が使えない環境がある。実行可能な匿名メモリを取れないプラットフォーム、W^X が強制されていて動的にコードを置けない環境、Cranelift のバックエンドがまだない CPU、そして `no_std` の世界。

そこで Wasmtime が用意したのが Pulley だ。**Portable, Universal, Low-Level Execution strategY** の略で、名前のとおり移植性が第一目標になっている。

```text title="pulley/README.md"
Pulley's primary goal is portability and its secondary goal is fast
interpretation.

Pulley is not intended to be a simple reference interpreter, support dynamically
switching to just-in-time compiled code, or even to be the very fastest
interpreter in the world.
```

[pulley/README.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/pulley/README.md)

**「参照実装ではない」「世界最速のインタプリタでもない」と目標から外している。** 何をしないかを先に決めているぶん、設計判断が読みやすい。

## `enum Instruction` を一度も作らない

Pulley の設計原則で最も影響が大きいのは、これだ。

```text title="pulley/README.md"
* The interpreter never materializes `enum Instruction { .. }` values. Instead,
  it decodes immediates and operands as needed in each opcode handler. This
  avoids constructing unnecessary temporary storage and branching on opcode
  multiple times.

* Because we never materialize `enum Instruction { .. }` values, we don't have
  to worry about unused padding or one very-large instruction inflating the size
  of all the rest of our small instructions. To put it concisely: we can lean
  into a variable-length encoding where some instructions require only a single
  byte and others require many. This helps keep the bytecode compact and
  cache-efficient.
```

素朴なインタプリタは「バイト列をデコードして `Instruction` を作り、それを `match` する」という 2 段階で書く。すると `Instruction` は Rust の enum なので、**サイズが最大のバリアントに揃う**。1 バイトで済む命令も、128bit 即値を持つ命令と同じ大きさの一時オブジェクトになる。しかも opcode に対する分岐がデコード時と実行時の 2 回起きる。

Pulley はデコードと実行を分けない。opcode を読んだらそのハンドラに飛び、**オペランドはハンドラの中で必要な分だけ読む**。すると一時オブジェクトが要らなくなり、その帰結として「命令ごとに長さが違ってよい」という自由が手に入る。

これは因果が逆向きに見えるところが面白い。「可変長エンコーディングにしたい」から `enum` を捨てたのではなく、**`enum` を捨てた結果として可変長が痛くなくなった**。

## 分岐は最初の opcode で 1 回だけ

もう 1 つの原則が、命令表の形を決めている。

```text title="pulley/README.md"
* We do not, in general, define sub-opcodes. There should be only one branch, on
  the initial opcode, when evaluating any given instruction. For example, we do
  *not* have a generic `load` instruction that is followed by a sub-opcode to
  discriminate between different addressing modes. Instead, we have many
  different kinds of `load` instructions, one for each of our addressing modes.
```

汎用の `load` に「どのアドレッシングモードか」のサブオペコードを付ける、という設計を明示的に避けている。分岐を 1 回に抑えるためだ。インタプリタのループでは分岐予測ミスが直接コストになるので、分岐の回数そのものを減らす。

代償として命令の種類が爆発する。それを扱いやすくするために命名規約が図解されている。

```text title="pulley/src/lib.rs"
///   xload16le_u32_o32
///   │└─┬┘└┤└┤ └┬┘ └┬┘
///   │  │  │ │  │   ▼
///   │  │  │ │  │   addressing mode
///   │  │  │ │  ▼
///   │  │  │ │  width of register modified + sign-extension (optional)
///   │  │  │ ▼
///   │  │  │ endianness of the operation (le/be)
///   │  │  ▼
///   │  │  bit-width of the operation
///   │  ▼
///   │  what's happening (load/store)
///   ▼
///   register being operated on (x/f/z)
```

[pulley/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/pulley/src/lib.rs)

例外は 1 つだけある。`u8` の opcode のうち `255` を escape に予約し、その後に `u16` の拡張オペコードが続く。「よく使う命令を極小に保ちつつ、めったに使わない命令をいくらでも足せる逃げ道を用意する」という説明が付いている。

## 命令定義はマクロ 1 か所

命令の種類が多いことの最大の危険は、**デコーダとエンコーダと逆アセンブラがずれる**ことだ。Pulley はそれを構造で防いでいる。

```text title="pulley/README.md"
* We strive to cut down on boilerplate as much as possible, and try to avoid
  matching on every opcode repeatedly throughout the whole code base. We do this
  via heavy `macro_rules` usage where we define the bytecode inside a
  higher-order macro and then automatically derive a disassembler, decoder,
  encoder, etc... from that definition. This also avoids any kind of drift where
  the encoder and decoder get out of sync with each other, for example.
```

`for_each_op!` という高階マクロが命令表そのもので、デコーダ・エンコーダ・逆アセンブラ・オペコード列挙が全部そこから導出される。命令を 1 つ足すには、このマクロに 1 行足すだけでよい。逆に言えば、**1 行足したら派生物が全部そろう**。

同じ手法が Wasmtime 側の `for_each_vm_type!` にもある ([レイアウトの単一定義源をマクロで作る](../layout-macro/))。「定義を 1 か所に置いて、消費側を導出する」というパターンがリポジトリ全体で繰り返し使われている。

## ディスパッチループが 2 つある

インタプリタの中心はディスパッチループだが、Pulley はこれを 2 通り実装している。既定は `match` によるループだ。

```rust title="pulley/src/interp/match_loop.rs"
impl Interpreter<'_> {
    pub fn run(self) -> Done {
        let mut decoder = Decoder::new();
        let mut visitor = debug::Debug(self);
        loop {
            // Here `decode_one` will call the appropriate `OpVisitor` method on
            // `self` via the trait implementation in the module above this.
            // ...
            match decoder.decode_one(&mut visitor) {
                Ok(ControlFlow::Continue(())) => {}
                Ok(ControlFlow::Break(done)) => break done,
            }
        }
    }
}
```

もう 1 つは末尾呼び出しで次の opcode に遷移する方式で、こちらのほうが速い。ただし既定では無効になっている。

```rust title="pulley/src/interp/tail_loop.rs"
//! At this time this module is more performant but disabled by default. Rust
//! does not have guaranteed tail call elimination on stable at this time so
//! this is not a suitable means of writing an interpreter loop. That being said
//! this is included nonetheless for us to experiment and analyze with.
//!
//! There are two methods of using this module:
//!
//! * `RUSTFLAGS=--cfg=pulley_assume_llvm_makes_tail_calls` - this compilation
//!   flag indicates that we should assume that LLVM will optimize to making
//!   tail calls for things that look like tail calls. ... It's up to the person
//!   compiling to manually audit/verify/test that TCO is happening.
//!
//! * `RUSTFLAGS=--cfg=pulley_tail_calls` - this compilation flag indicates that
//!   Rust's nightly-only support for guaranteed tail calls should be used. This
//!   uses the `become` keyword, for example.
```

**「より速い実装があるが、stable Rust に保証された末尾呼び出し最適化がないので既定では使わない」。** 言語の保証がないという理由だけで、動く速い実装が眠っている。しかも `pulley_assume_llvm_makes_tail_calls` のほうは「LLVM がやってくれると仮定する。検証は人間の責任」と明記した割り切りになっている。

末尾呼び出し版のハンドラ型にも工夫がある。

```rust title="pulley/src/interp/tail_loop.rs"
/// ABI signature of each opcode handler.
///
/// Note that this "explodes" the internals of `Interpreter` to individual
/// arguments to help get them all into registers.
type Handler = fn(&mut MachineState, UnsafeBytecodeStream, ExecutingPcRef<'_>) -> Done;
```

構造体を 1 つ渡すのではなく、中身を個別の引数にばらす。**インタプリタの状態をレジスタに載せるため**だ。

## 停止理由の表し方

インタプリタが止まる理由は 3 つある。トラップ、ホスト関数の呼び出し、ホストへの復帰。それを表す型の作り方が凝っている。

```rust title="pulley/src/interp.rs"
/// Inner private module to prevent creation of the `Done` structure outside of
/// this module.
mod done {
    /// Zero-sized sentinel indicating that pulley execution has halted.
    ///
    /// The reason for halting is stored in `MachineState`.
    #[derive(Copy, Clone, Debug, PartialEq, Eq)]
    pub struct Done {
        _priv: (),
    }

    /// Reason that the pulley interpreter has ceased execution.
    pub enum DoneReason<T> {
        Trap { pc: NonNull<u8>, kind: Option<TrapKind> },
        CallIndirectHost { id: u8, resume: NonNull<u8> },
        ReturnToHost(T),
    }
```

[pulley/src/interp.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/pulley/src/interp.rs)

`Done` は**ゼロサイズで、コンストラクタが private** な型だ。「止まった」という事実だけを型で運び、**理由は `MachineState` に置く**。ディスパッチループは `ControlFlow<Done>` を回すので、この型が小さいほど毎回の判定が安くなる。

private コンストラクタにしているのは、「`Done` を作れるのは、実際に `MachineState` へ理由を書き込んだ場所だけ」という不変条件を型で守るためだ。

## どう活かすか

Pulley の設計判断は、どれも「インタプリタのループが何度も回る」という一点から導かれている。分岐を減らす、一時オブジェクトを作らない、状態をレジスタに載せる、判定に使う型を小さくする。

そして目標を絞ったことが効いている。「参照実装にはしない」「JIT との動的切り替えはしない」と決めたので、可読性のために遅くする理由も、実行中にコードを差し替えられるようにする複雑さも背負わずに済んでいる。**何をしないかを先に書くと、何をするかの判断が速くなる。**

なお Pulley は、Wasmtime のなかで単なる「フォールバックのインタプリタ」として置かれているわけではない。Cranelift のパイプラインの側から見ると、もっと変わった位置にいる ([Pulley は「インタプリタ」ではなくターゲット ISA である](../pulley-as-isa/))。
