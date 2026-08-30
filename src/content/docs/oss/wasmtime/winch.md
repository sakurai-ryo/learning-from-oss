---
title: "Winch — 単一パスで、見れば分かるコードを吐く"
description: "Wasmtime には最適化しないコンパイラがもう 1 つある。名前は WebAssembly Intentionally Non-optimizing Compiler and Host。中間表現を持たず、Wasm のオペレータを 1 つ読むごとに機械語を出す。設計原則に「見れば分かること」が入っていて、それが実際にコードの形を決めている。"
group: "もう 2 つの実行器"
sidebar:
  order: 59
---

Wasmtime には Cranelift のほかにもう 1 つコンパイラがある。Winch という。正式名称は **WebAssembly Intentionally Non-optimizing Compiler and Host** で、「意図的に最適化しない」と名前に入っている。

なぜそんなものが要るのか。Cranelift は速いコードを出すが、そのために時間をかける。CLIF を構築し、e-graph で書き換え、ISLE で命令選択し、レジスタを割り当てる ([ægraph — 非循環な e-graph という選択](../egraph/) 以降)。**実行時間の合計が「コンパイル時間 + 実行時間」であることを思い出すと、一度しか呼ばれない関数にその投資は割に合わない。**

## 設計原則が 7 つ並んでいる

Winch の README には設計原則がそのまま列挙されている。

```text title="winch/README.md"
* Single pass over Wasm bytecode

* Function as the unit of compilation

* Machine code generation directly from Wasm bytecode – no intermediate
  representation

* Avoid reinventing machine-code emission – use Cranelift's instruction emitter
  code to create an assembler library

* Prioritize compilation performance over runtime performance

* Simple to verify by looking. It should be evident which machine instructions
  are emitted per WebAssembly operator

* Adding and iterating on new (WebAssembly and developer-facing) features should
  be simpler than doing it in an optimizing tier (Cranelift)
```

[winch/README.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/winch/README.md)

このリストで目を引くのは 4 番目と 6 番目だ。

**4 番目は「機械語の出力を作り直さない」。** Winch は Cranelift の `MachBuffer` と `cranelift-assembler-x64` をそのまま使う。つまり命令のエンコーディングも、分岐の解決も、island と veneer の挿入も ([逆順 1 スキャンの lowering と、MachBuffer の island](../lowering-and-machbuffer/))、Cranelift と共有している。**別のコンパイラを作るときに、どこを分けてどこを共有するか**の線引きがここにある。分けたのは「何を出すか」の判断だけで、「どう出すか」は共有した。

**6 番目は「見れば分かること」。** これが設計原則に入っているコンパイラは珍しい。ベースラインコンパイラは最適化コンパイラのバグを切り分けるための基準にもなるので、「このオペレータからこの命令が出る」が読んで確認できることに価値がある。

## 対応表がそのままソースになっている

Winch の本体は `wasmparser::VisitOperator` の実装で、オペレータ 1 つにつきメソッドが 1 つある。ただし全オペレータを実装しているわけではない。未対応のものをどう扱うかが、面白い形になっている。

```rust title="winch/codegen/src/visitor.rs"
/// A macro to define unsupported WebAssembly operators.
///
/// This macro calls itself recursively;
/// 1. It no-ops when matching a supported operator.
/// 2. Defines the visitor function and panics when
///    matching an unsupported operator.
macro_rules! def_unsupported {
    ($( @$proposal:ident $op:ident $({ $($arg:ident: $argty:ty),* })? => $visit:ident $ann:tt)*) => {
        $(
            def_unsupported!(
                emit
                    $op

                fn $visit(&mut self $($(,$arg: $argty)*)?) -> Self::Output {
                    $($(let _ = $arg;)*)?

                    Err(format_err!(CodeGenError::unimplemented_wasm_instruction()))
                }
            );
        )*
    };

    (emit I32Const $($rest:tt)*) => {};
    (emit I64Const $($rest:tt)*) => {};
    (emit F32Const $($rest:tt)*) => {};
    // ... 対応済みオペレータが延々と続く
```

[winch/codegen/src/visitor.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/winch/codegen/src/visitor.rs)

この再帰マクロは、**対応済みのオペレータにマッチしたら何も展開せず、それ以外にはエラーを返す実装を生成する**。`(emit I32Const $($rest:tt)*) => {};` という行が「`I32Const` は自分で実装してあるので、自動生成しなくてよい」という宣言になっている。

結果として、この `emit` アームの羅列が**そのままサポート状況の一覧表**になる。別途ドキュメントに対応表を書けば、それは必ず実装からずれていく。ここではずれようがない。行を消せばコンパイルエラーになり、実装を消せばやはりコンパイルエラーになる。

同じ発想は Wasmtime の各所にある。JIT が触る構造体のレイアウトをマクロ 1 箇所から生成する仕組み ([レイアウトの単一定義源をマクロで作る](../layout-macro/))、`Tunables` の互換性判定を分割代入で全列挙させる書き方 ([Tunables を全フィールド分割代入して、互換性の判断漏れを防ぐ](../tunables-compat/)) と、「2 か所に書くとずれる」問題への対処が揃っている。

## Cranelift との切り替え

使う側から見ると、切り替えは `Config` の 1 行だ。

```rust
config.strategy(Strategy::Winch);
```

`Strategy::Auto` は現状つねに Cranelift を選ぶ。Winch を使うには明示的に指定する必要がある。

Winch には対応していない proposal がある。gc、function-references、relaxed-simd、tail-call、stack-switching は、Winch を選ぶと自動的に無効化される。これは `Config::features()` の 5 段階目、「バックエンドが panic する feature を除去する」処理で起きる ([proposal の地図](../proposals/))。**コンパイラの選択が、使える言語機能を変える。**

もう 1 つ、Winch は `inlining_compiler()` に `None` を返す。つまりインライン化パスに参加しない ([モジュールを跨いでインライン化し、呼び出しグラフを層に切る](../inlining-strata/))。トランポリンの生成も Cranelift 実装に委譲していて、`NoInlineCompiler` という薄いラッパを通す。**Winch は「関数本体を機械語にする」ところだけを担当し、周辺は Cranelift に任せている。**

## 到達不能コードとスタックポインタ

単一パスのコンパイラでも、到達不能コードの扱いは避けて通れない。Wasm では `unreachable` や `br` の後にも命令が並びうる。

Cranelift 側は「翻訳せずネストだけ数える」という扱いをする ([スタックマシンから SSA へ](../wasm-to-clif/))。Winch も基本は同じだが、追加でやることがある。

```rust title="winch/codegen/src/codegen/mod.rs"
    /// Handles the emission of the ELSE or END instruction when the
    /// current block is unreachable.
    pub fn handle_unreachable_else(&mut self) -> Result<()> {
        // ...
    }

    pub fn handle_unreachable_end(&mut self) -> Result<()> {
        // ...
    }
```

**スタックポインタを期待される状態に戻す**必要がある。Winch は値を実際のスタックスロットに置いているので ([値を最後まで実体化しない](../winch-lazy-values/))、到達不能なコードを飛ばした後、スタックの高さがブロックの期待値と合っていなければならない。無限ループの後に関数末尾へ到達不能状態で着いた場合でも、SP を戻す処理が入る。

これは Cranelift 側には存在しない仕事だ。CLIF の世界にはまだ物理的なスタックがなく、レジスタ割り当てまで先送りされているからだ。**中間表現を持たないことの代償が、こういう細部に現れる。**

## どう活かすか

「同じ問題に 2 つの実装を持つ」という判断は、普通は避けたくなる。維持コストが倍になるからだ。

Winch が正当化されているのは、2 つの実装が**違う軸で最適だから**だ。Cranelift はコンパイル時間を払って実行時間を買い、Winch はその逆をやる。どちらが正しいかは、モジュールが何回呼ばれるかで決まる。呼び出し回数はコンパイル時に分からない。だから両方を持って、使う側に選ばせる。

そのうえで、共有できるところは徹底的に共有している。命令のエンコーディングとバッファ管理という「どちらの実装でも同じであるべき部分」を切り出して、そこだけ Cranelift から借りる。**2 つの実装を持つコストは、共有する境界をどこに引けるかで決まる。**
