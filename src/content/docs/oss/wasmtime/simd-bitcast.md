---
title: "SIMD で bitcast を撒く羽目になった話"
description: "Wasm の SIMD 型は `v128` の 1 つだけ、CLIF は I8X16/I16X8/I32X4/I64X2 を別の型として持つ。この粒度の食い違いのせいで、翻訳器は no-op の bitcast を 130 箇所以上に撒いている。設計者が「醜くて非効率」と認め、4 つの実害と理想解まで書き残しているコメントを読む。"
group: "Cranelift — Wasm を機械語にする"
sidebar:
  order: 24
---

Wasm の SIMD 値の型は `v128` ひとつしかない。レーンの幅は命令の側が決める。`i16x8.add` は 8 レーンの 16bit 加算、`i32x4.sub` は 4 レーンの 32bit 減算で、どちらもオペランドの型は `v128` である。だから `i16x8.add` の結果をそのまま `i32x4.sub` に食わせても、Wasm の検証は通る。

CLIF はそうなっていない。`I8X16`、`I16X8`、`I32X4`、`I64X2` は互いに別の型で、値ごとにレーン構成が固定される。だから上の Wasm コードをそのまま写すと、CLIF の verifier が型不一致で落ちる。

この食い違いをどう埋めているか。**no-op の `bitcast` を大量に挿入している。** そしてそのことについて、モジュールコメントに長い自己批判が書かれている。

## 設計者が書いた 4 つの実害

```rust title="crates/cranelift/src/translate/code_translator.rs"
//! There is extra complexity associated with translation of 128-bit SIMD instructions.
//! Wasm only considers there to be a single 128-bit vector type.  But CLIF's type system
//! distinguishes different lane configurations, so considers 8X16, 16X8, 32X4 and 64X2 to be
//! different types.  The result is that, in wasm, it's perfectly OK to take the output of (eg)
//! an `add.16x8` and use that as an operand of a `sub.32x4`, without using any cast.  But when
//! translated into CLIF, that will cause a verifier error due to the apparent type mismatch.
//!
//! This file works around that problem by liberally inserting `bitcast` instructions in many
//! places -- mostly, before the use of vector values, either as arguments to CLIF instructions
//! or as block actual parameters.  These are no-op casts which nevertheless have different
//! input and output types, and are used (mostly) to "convert" 16X8, 32X4 and 64X2-typed vectors
//! to the "canonical" type, 8X16.
```

```rust title="crates/cranelift/src/translate/code_translator.rs"
//! The use of bitcasts is ugly and inefficient, but currently unavoidable:
//!
//! * they make the logic in this file fragile: miss out a bitcast for any reason, and there is
//!   the risk of the system failing in the verifier.  At least for debug builds.
//!
//! * in the new backends, they potentially interfere with pattern matching on CLIF -- the
//!   patterns need to take into account the presence of bitcast nodes.
//!
//! * in the new backends, they get translated into machine-level vector-register-copy
//!   instructions, none of which are actually necessary.  We then depend on the register
//!   allocator to coalesce them all out.
//!
//! * they increase the total number of CLIF nodes that have to be processed, hence slowing down
//!   the compilation pipeline.  Also, the extra coalescing work generates a slowdown.
//!
//! A better solution which would avoid all four problems would be to remove the 8X16, 16X8,
//! 32X4 and 64X2 types from CLIF and instead have a single V128 type.
```

[crates/cranelift/src/translate/code_translator.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/code_translator.rs#L26-L72)

4 つの実害が並んでいる。**脆さ**(bitcast をひとつ書き忘れると verifier で落ちる。しかもリリースビルドでは verifier が走らないので、デバッグビルドでしか捕まらない)、**パターンマッチの阻害**(バックエンドの命令選択規則が、間に挟まった bitcast ノードを考慮しないといけない)、**無駄なベクタレジスタ間コピー**(bitcast は機械語レベルでは vector move になり、レジスタアロケータの coalescing に消してもらうことを期待するしかない)、**ノード数の増加**(CLIF が太り、コンパイルが遅くなる)。

そして理想解が明記されている。**CLIF から `I8X16` / `I16X8` / `I32X4` / `I64X2` を消して、単一の `V128` 型にすること**。「4 つの問題をすべて避けられる、より良い解」と書いた上で、そうしていない。

コメントの末尾には、この議論が続いている issue と PR が 3 本挙がっている。[wasmtime#1147 "Too many raw_bitcasts in SIMD code"](https://github.com/bytecodealliance/wasmtime/issues/1147)、`cranelift#1251`(X128 型の追加)、`cranelift#1236`(I8X16 をデフォルトのベクタ型として verifier を緩める)。同じ問題に対して「型を足す」「検証を緩める」の両方向から手が入れられ、どちらも本採用されないまま bitcast が残っている。

## どこに撒かれているか

`code_translator.rs` の中で bitcast を挿入するヘルパを呼んでいる箇所は **137 か所**ある。実体は `optionally_bitcast_vector` ひとつで、型が既に一致していれば何もしない。

```rust title="crates/cranelift/src/translate/code_translator.rs"
/// Some SIMD operations only operate on I8X16 in CLIF; this will convert them to that type by
/// adding a bitcast if necessary.
fn optionally_bitcast_vector(
    value: Value,
    needed_type: Type,
    builder: &mut FunctionBuilder,
) -> Value {
    if builder.func.dfg.value_type(value) != needed_type {
        let mut flags = MemFlagsData::new();
        flags.set_endianness(ir::Endianness::Little);
        builder.ins().bitcast(needed_type, flags, value)
    } else {
        value
    }
}
```

[crates/cranelift/src/translate/code_translator.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/code_translator.rs#L4376-L4390)

`MemFlags` に little endian を明示しているのは、CLIF の `bitcast` の定義が「同じアドレスに片方の型で store して、もう片方の型で load する」だからだ。**レーン数やレーン幅が変わる bitcast はバイト順の指定がないと意味が定まらない**ので、命令定義側で必須になっている。

呼び出し側は、そのオペレータが CLIF 上で要求する型を `type_of(op)` で引いて渡す。

```rust title="crates/cranelift/src/translate/code_translator.rs"
Operator::I8x16Add | Operator::I16x8Add | Operator::I32x4Add | Operator::I64x2Add => {
    let (a, b) = pop2_with_bitcast(environ, type_of(op), builder);
    environ.stacks.push1(builder.ins().iadd(a, b))
}
```

`type_of` は 200 行近い巨大な `match` で、Wasm の SIMD オペレータから CLIF のベクタ型への写像そのものである。`V128Const` や `V128And` のように「レーン解釈がどうでもいい」オペレータには `I8X16` が割り当てられていて、コメントで `// default type representing V128` と書かれている。

値を作る側にも痕跡が残る。

```rust title="crates/cranelift/src/translate/code_translator.rs"
Operator::V128Const { value } => {
    let data = value.bytes().to_vec().into();
    let handle = builder.func.dfg.constants.insert(data);
    let value = builder.ins().vconst(I8X16, handle);
    // the v128.const is typed in CLIF as a I8x16 but bitcast to a different type
    // before use
    environ.stacks.push1(value)
}
```

```rust title="crates/cranelift/src/translate/code_translator.rs"
Operator::I8x16Shuffle { lanes, .. } => {
    let (a, b) = pop2_with_bitcast(environ, I8X16, builder);
    let result = environ.i8x16_shuffle(builder, a, b, lanes);
    environ.stacks.push1(result);
    // At this point the original types of a and b are lost; users of this value (i.e. this
    // WASM-to-CLIF translator) may need to bitcast for type-correctness. This is due
    // to WASM using the less specific v128 type for certain operations and more specific
    // types (e.g. i8x16) for others.
}
```

[crates/cranelift/src/translate/code_translator.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/code_translator.rs#L1755-L1890)

## 分岐が一番危ない

厄介なのは、ベクタ命令とは無関係に見える**ジャンプ**である。値スタックに載ったベクタ値が `br` でブロック引数として渡るとき、渡す側の CLIF 型が受け取る側と食い違えば、やはり verifier に叩かれる。モジュールコメントが警告しているのはまさにここだ。

```rust title="crates/cranelift/src/translate/code_translator.rs"
//! Be careful when adding support for new vector instructions.  And when adding new jumps, even
//! if they are apparently don't have any connection to vectors.  Never generate any kind of
//! (inter-block) jump directly.  Instead use `canonicalise_then_jump` and
//! `canonicalise_then_br{z,nz}`.
```

そのため、翻訳器はブロック間ジャンプを**直接出してはいけない**という掟を自らに課している。すべての分岐は `canonicalise_then_jump` / `canonicalise_brif` を通り、その中で `canonicalise_v128_values` がすべてのベクタ値を `I8X16` に揃える。

```rust title="crates/cranelift/src/translate/code_translator.rs"
fn canonicalise_v128_values<'a>(
    tmp_canonicalised: &'a mut SmallVec<[ir::Value; 16]>,
    builder: &mut FunctionBuilder,
    values: &'a [ir::Value],
) -> &'a [ir::Value] {
    // If no value needs canonicalising, we can avoid any work and return the
    // original slice unchanged.
    if values
        .iter()
        .all(|v| !is_non_canonical_v128(builder.func.dfg.value_type(*v)))
    {
        return values;
    }
    // Otherwise cast as necessary, ...
}
```

[crates/cranelift/src/translate/code_translator.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/code_translator.rs#L4399-L4428)

`bitcast*` は任意の型に変換するが、`canonicalise*` は必ず `I8X16` に揃える、という使い分けもコメントに明記されている。制御合流点では「どのレーン型で来るか」が事前に分からないので、**合流点だけは正規形をひとつ決め打ちする**しかない。

関数呼び出しと `return` にも同じ問題があり、`bitcast_wasm_params` と `bitcast_wasm_returns` がシグネチャの型に合わせて引数を差し替える。「Wasm が `V128` を関数引数 (および暗黙にブロック引数) に使いながら、関数本体では `I32X4` のような具体的な型を使えるようにするための変換」だと doc コメントが説明している。

## どちらの設計も、単体では正しい

ここで押さえておきたいのは、**CLIF が悪いわけでも Wasm が悪いわけでもない**という点だ。

CLIF がレーン型を区別するのは、命令選択にレーン幅が要るからである。x86-64 で `iadd` を機械語にするとき、レーン幅が 8 なら `paddb`、16 なら `paddw`、32 なら `paddd`、64 なら `paddq` になる。もし `V128` 型ひとつしかなければ、`iadd` という命令が「どのレーン幅で足すのか」を型以外の場所に持たなければならない。CLIF は型変数で命令を多相にする設計 (`iadd` は整数型とそのベクタ型に対して多相) なので、レーン構成を型に持たせるのは一貫している。

Wasm が `v128` ひとつなのは、レーン解釈を命令側に持たせているからだ。`i32x4.add` という命令名にレーン幅が書いてある。こうすると値の型は 1 つで済み、型検査が単純になり、バイナリも小さくなる。検証器がレーン型を追跡する必要がなくなるのは、**「実行前にすべて検査する」という Wasm の設計方針からすると得**である。

問題は「レーン解釈をどこに置くか」という一点で 2 つの設計が違っていることで、片方は型に、もう片方は命令に置いた。**どちらも単体では筋が通っているのに、繋ぐと歪みが出る。** そして歪みを吸収する場所は、必ず境界にいる翻訳器になる。137 か所の bitcast はその請求書だ。

## どう活かすか

型システムの粒度が合わないインターフェースを繋ぐときの選択肢は、結局 3 つしかない。**細かい側に合わせる**(翻訳器が持っている情報からレーン型を復元して、正しい型の値を作る。今の Wasmtime がやっていること)。**粗い側に合わせる**(CLIF に `V128` を入れる。理想解と明記されているが、命令選択にレーン幅を別経路で渡す必要が出る)。**検証を緩める**(`I8X16` をデフォルトのベクタ型として型不一致を許す。`cranelift#1236` の方向)。

Wasmtime は 1 番目を選び、その代償を**コメントに全部書き出した**。「醜くて非効率」「4 つの問題」「より良い解はこれ」と明示してあるから、後から来た人はこのコードを読んで「なぜこんなに bitcast があるのか」で悩まずに済むし、理想解に向かう作業を始められる。

回避策を入れるとき、回避策そのものより「何を諦めたか」「本当はどうあるべきか」を書き残すほうが、後の価値が高い。この 47 行のコメントは、その手本になっている。
