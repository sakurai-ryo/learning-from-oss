---
title: "Wasm のブロック引数を、CLIF のブロック引数にしない"
description: "Wasm のブロックが取る引数は、CLIF のブロックパラメータにすれば素直に写せる。Wasmtime はあえてそうせず、`Variable` に `def_var` してから引数なしで分岐する。ブロックパラメータが本当に要るかどうかの判断を SSA 構築側に委ねるためで、実際に CLIF ブロック引数を持つのはエントリブロックと try_table の catch ブロックだけになっている。"
group: "Cranelift — Wasm を機械語にする"
sidebar:
  order: 23
---

Wasm のブロックは引数と結果を取れる。`(block (param i32) (result i64) ...)` に `br` するときは、値スタックの上位 1 個が引数として渡る。CLIF のブロックもパラメータを取れて、分岐命令が引数を渡せる。形が完全に一致しているので、そのまま写せばよさそうに見える。

**Wasmtime はそう写さない。** Wasm のブロック引数は `cranelift_frontend::Variable` になり、分岐は引数なしで出る。理由は `FuncTranslationStacks` のフィールドコメントに書かれている。

## 設計者が書いている理由

```rust title="crates/cranelift/src/translate/stack.rs"
/// Maps a CLIF block representing a Wasm control-flow target to the
/// `Variable`s that hold its Wasm stack parameters.
///
/// Rather than giving these blocks CLIF block parameters and passing the
/// Wasm operand stack values as block arguments when branching to them, we
/// represent each Wasm stack parameter as a `Variable`. When branching to
/// such a block we `def_var` the variables and emit an argument-less
/// branch; when we begin translating the block we `use_var` each variable
/// and push the results onto the operand stack. This lets
/// `cranelift-frontend`'s SSA construction decide whether a real block
/// parameter is actually needed (i.e. only when multiple predecessors pass
/// differing values) instead of pessimistically creating one for every
/// Wasm block.
///
/// The only blocks with real CLIF block parameters are the entry block
/// (function parameters) and `try_table` catch blocks (the exception
/// payload, filled in by the exception ABI).
pub(crate) block_param_vars: SecondaryMap<Block, SmallVec<[Variable; 6]>>,
```

[crates/cranelift/src/translate/stack.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/stack.rs#L271-L289)

鍵は **pessimistically** の一語だ。翻訳器は 1 パスで、ブロックを作る時点ではそのブロックに何本の分岐が入ってくるかを知らない。だから素直にブロックパラメータを作ると、**入ってくる分岐が 1 本しかないブロックにも、全部の分岐が同じ値を渡すブロックにも、等しくパラメータが付く**。翻訳器の位置からは「本当に必要か」を判断する材料がない。

一方 SSA 構築側は、`seal_block` まで待てば先行ブロックが確定するので判断できる。だから**判断材料を持っている側に判断させる**。この変更を入れたコミットのメッセージも同じことを言っている。

> This allows SSA construction to determine whether they need to actually become block params or not, and cuts down on the number of unnecessary block parameters we pessimistically introduce during Wasm-to-CLIF translation.
>
> — [51d0a306b4 "Translate Wasm block params into `Variable`s instead of CLIF block params" (#13711)](https://github.com/bytecodealliance/wasmtime/commit/51d0a306b4)

## 実際のコード

ブロックを作るのは `block_with_params` で、名前に反して CLIF のブロックパラメータは 1 つも作らない。`Variable` を型ごとに宣言して、`block_param_vars` に登録するだけである。

```rust title="crates/cranelift/src/translate/translation_utils.rs"
/// Create a `Block` representing a Wasm control-flow target with the given Wasm
/// stack parameters.
///
/// Rather than giving the block CLIF block parameters, we create a
/// `cranelift_frontend::Variable` for each Wasm stack parameter and record the
/// block-to-variables mapping in `environ.stacks.block_param_vars`.
pub fn block_with_params(
    builder: &mut FunctionBuilder,
    params: impl IntoIterator<Item = wasmparser::ValType>,
    environ: &mut FuncEnvironment<'_>,
) -> WasmResult<ir::Block> {
    let block = builder.create_block();
    let mut vars = SmallVec::<[_; 6]>::new();
    for ty in params {
        let (clif_ty, needs_stack_map) = /* ... Wasm 型 → CLIF 型 ... */;
        let var = builder.declare_var(clif_ty);
        if needs_stack_map {
            builder.declare_var_needs_stack_map(var);
        }
        vars.push(var);
    }
    let old = environ.stacks.block_param_vars.insert(block, vars);
    debug_assert!(old.is_none());
    Ok(block)
}
```

[crates/cranelift/src/translate/translation_utils.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/translation_utils.rs#L60-L94)

値の受け渡しは 2 つの小さな関数に集約されている。分岐する側が `set_block_params`、分岐先の翻訳を始める側が `push_block_params` を呼ぶ。

```rust title="crates/cranelift/src/translate/translation_utils.rs"
/// Set the parameter `Variable`s of `destination` to `values` ahead of an
/// argument-less branch to that block.
pub fn set_block_params(
    environ: &FuncEnvironment<'_>,
    builder: &mut FunctionBuilder,
    destination: ir::Block,
    values: &[ir::Value],
) {
    let vars = &environ.stacks.block_param_vars[destination];
    debug_assert_eq!(vars.len(), values.len());
    for (var, val) in vars.iter().zip(values) {
        builder.def_var(*var, *val);
    }
}
```

[crates/cranelift/src/translate/translation_utils.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/translation_utils.rs#L45-L58)

そして分岐そのものは、`canonicalise_then_jump` が示すとおり `def_var` の直後に**引数リストが空の `jump`** を出す。

```rust title="crates/cranelift/src/translate/code_translator.rs"
fn canonicalise_then_jump(
    environ: &FuncEnvironment<'_>,
    builder: &mut FunctionBuilder,
    destination: ir::Block,
    params: &[ir::Value],
) -> ir::Inst {
    let mut canonicalised = SmallVec::<[_; 16]>::new();
    let canonicalised = canonicalise_v128_values(&mut canonicalised, builder, params);
    set_block_params(environ, builder, destination, canonicalised);
    builder.ins().jump(destination, &[])
}
```

[crates/cranelift/src/translate/code_translator.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/code_translator.rs#L4455-L4466)

`Operator::Block` の翻訳が `block_with_params(builder, results, environ)` を呼び、`End` が `push_block_params` を呼んで戻り値を値スタックに戻す。この往復だけで、Wasm のブロック引数が CLIF に写る。

同じ扱いは**関数の戻り値にも適用されている**。`translate_body` は exit ブロックの戻り値ぶんの `Variable` を作り、`block_param_vars` に登録する。「関数全体も 1 つのブロックである」という Wasm の性質が、ここでも一貫して効いている。

## 例外は 2 つだけ

コメントが言うとおり、実際に CLIF のブロックパラメータを持つブロックは 2 種類しかない。

エントリブロックは `append_block_params_for_function_params` で作られる。ここは関数の ABI が決めるので、SSA 構築の判断が入る余地がない。

もうひとつが `try_table` の catch ブロックで、こちらにはコード中に注記がある。

```rust title="crates/cranelift/src/translate/code_translator.rs"
// Unlike Wasm control-flow targets, a catch block's single parameter is a
// real CLIF block parameter: it is filled in by the exception ABI (the
// `try_call`'s exception table), not by an ordinary branch. So create it
// directly rather than going through `block_with_params`.
let block = builder.create_block();
let exn_ref = builder.append_block_param(block, exn_payload_ty);
```

[crates/cranelift/src/translate/code_translator.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/translate/code_translator.rs#L4628-L4635)

**値を渡すのが普通の分岐命令ではないから、`def_var` する場所が存在しない。** 例外ペイロードは `try_call` の例外テーブル経由で ABI が書き込む。だからここだけは実パラメータでなければならない。「どこで値が定義されるか」が SSA 構築から見えるかどうかが、境目になっている。

## 無駄なブロックパラメータの何が悪いのか

ブロックパラメータは、機械語のレベルでは「先行ブロックの末尾に置かれる move」になる。regalloc2 はブロックパラメータと分岐引数を同じレジスタに割り当てようとするが、割り当てが衝突すればコピーが残る。**入ってくる分岐が 1 本しかないブロックにパラメータを付けると、その 1 本ぶんのコピーが、何も分岐していないのに生まれる**。合流していない場所に合流のコストを払うことになる。

もうひとつは最適化の側だ。ミッドエンドの書き換え規則は CLIF の命令列にパターンマッチするが、値がブロックパラメータを経由すると「その値がどの命令の結果か」が 1 段見えなくなる。定数がブロックパラメータになれば、定数畳み込みの機会がその場で消える。`Context::optimize` に `remove_constant_phis` という専用のパスが存在するのは、この種のパラメータが実際に生じるからである ([SSA をその場で構築する](../ssa-construction/))。翻訳の時点で作らずに済むなら、そのほうが安い。

そして単純に、CLIF のノード数が減る。Cranelift の売りはコンパイル速度なので、処理するノードが減ることはそれ自体が価値になる ([なぜ Cranelift は LLVM を使わないのか](../why-not-llvm/))。

## どう活かすか

構造が一対一に対応しているからといって、そのまま写すのが最善とは限らない。**下流に「本当に必要か」を判断できるパスがあるなら、上流は判断せず情報だけ渡すほうがよい**。ここで翻訳器が渡しているのは「この値がこの制御合流点に流れる」という事実だけで、「だからパラメータが要る」という結論は渡していない。

逆に言えば、この設計が成立するのは `cranelift-frontend` が `Variable` という抽象を持っていて、`seal_block` のタイミングで判断できるからだ。委ねる先がなければ、悲観的に作るしかない。次のページで、その委ねられた側が何をしているかを見る。
