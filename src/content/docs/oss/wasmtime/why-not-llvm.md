---
title: "なぜ Cranelift は LLVM を使わないのか"
description: "LLVM が 4 段の IR を使うところを Cranelift は CLIF 1 種類で済ませる。それを可能にしているのはスコープの狭さで、目的はコンパイル速度と、悪意ある入力を安全に扱えることだ。公式の比較文書が「Cranelift はミッドエンド最適化を行わない」と書いたまま実態から取り残されていることも含めて読む。"
group: "Cranelift — Wasm を機械語にする"
sidebar:
  order: 31
---

Wasmtime はコード生成器を自前で持っている。LLVM を使わない理由は `cranelift/docs/compare-llvm.md` に書かれていて、要点は **IR を 1 種類しか持たないこと**、そしてそれを可能にしている **スコープの狭さ**だ。動機はコンパイル速度と、悪意ある入力を安全に扱えることの 2 つにある。

## LLVM は 4 段、Cranelift は 1 段

まず比較文書が LLVM 側の構成を整理している。LLVM はプログラムを機械語にするまでに複数の中間表現を通る。

- **LLVM IR** — ISA 非依存で安定した入力言語であり、ミッドレベル最適化のための表現。膨大な解析パスと変換パスがここで動く。
- **SelectionDAG** — 基本ブロック 1 つぶんのグラフ表現。型の legalize、演算の legalize、DAG-combine、命令選択がここで走る。
- **MachineInstr** — ISA 固有の命令の線形表現。最初は SSA だが、レジスタ割り当ての最中と後は非 SSA も表せる。スケジューリングとレジスタ割り当てがここ。
- **MC** — 出力の抽象化層。分岐の relaxation、アセンブリ / オブジェクトコードの出力、アセンブラ、逆アセンブラ。

これに対する Cranelift の答えが 1 文で書かれている。

```text title="cranelift/docs/compare-llvm.md"
[Cranelift IR](ir.md) uses a single intermediate representation to cover
these levels of abstraction. This is possible in part because of Cranelift's
smaller scope.

- Cranelift does not provide assemblers and disassemblers, so it is not
  necessary to be able to represent every weird instruction in an ISA. Only
  those instructions that the code generator emits have a representation.
- Cranelift's opcodes are ISA-agnostic, but after legalization / instruction
  selection, each instruction is annotated with an ISA-specific encoding which
  represents a native instruction.
- SSA form is preserved throughout.
```

[cranelift/docs/compare-llvm.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/docs/compare-llvm.md)

**「アセンブラと逆アセンブラを提供しない」が、IR を 1 段にできた最大の理由**だ。LLVM の MC 層は、任意のアセンブリを読んで任意の機械語を吐けなければならない。ISA に存在する奇妙な命令をすべて表現する必要がある。Cranelift はそれをやらないので、「コード生成器が出す命令」だけ表現できればよい。汎用のコンパイラ基盤であることをやめると、IR の段数が 4 から 1 に落ちる。

Cranelift IR は LLVM IR に似ているが、少し低いレベルにある。代わりにコード生成の最後まで同じ表現で通せる。文書はこれをトレードオフとして明示している。

```text title="cranelift/docs/compare-llvm.md"
This design tradeoff does mean that Cranelift IR is less friendly for mid-level
optimizations.

...

This biases the overall system towards fast compilation when mid-level
optimization is not needed, such as when emitting unoptimized code for or when
low-level optimizations are sufficient.
```

**"biases the overall system towards fast compilation"** — 全体を速いコンパイルに寄せる、という設計意図がここに書かれている。

型システムの違いもスコープの狭さの現れだ。整数は `i8` から `i64` の 2 冪だけ (LLVM は任意ビット幅)、ポインタ型がなくアドレスは整数、集約型がない。値の型が「よくある ISA のレジスタに入るもの」に寄せてある。ポインタ型がないことは後で provenance の問題として跳ね返ってくるが、そちらは別の話だ。

## 公式文書が実態から取り残されている

ここで面白いことが起きている。同じ文書がこう続けている。

```text title="cranelift/docs/compare-llvm.md"
Cranelift doesn't currently perform mid-level optimizations,
however if it should grow to where this becomes important, the vision is that
Cranelift would add a separate IR layer, or possibly an separate IR, to support
this.

...

And, it removes some constraints in the mid-level optimize IR design space,
making it more feasible to consider ideas such as using a
[VSDG-based IR](https://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-705.pdf).
```

**これは既に事実ではない。** Cranelift はミッドエンド最適化を行う。`opt_level` が `None` でなければ `EgraphPass` が走り、GVN も、定数畳み込みも、代数簡約も、LICM も、リマテリアライズもそこで起きる ([ægraph — 非循環な e-graph という選択](../egraph/))。

しかも「別の IR 層を足すことになるだろう」という予測も外れた。ægraph は独立した IR ではない。`ValueDef::Union` という定義形を CLIF のデータフローグラフに足しただけで、パスの入口と出口では Union ノードが存在しないので、CLIF は依然として 1 種類のままだ。**予測されたのは「IR を増やす」だったが、実際に選ばれたのは「1 つの IR に一時的な構造を重ねる」だった。**

VSDG (Value State Dependence Graph) への言及も示唆的だ。VSDG は「値の依存だけを持ち、制御フローを持たない」表現で、これは ægraph が純粋ノードを Layout から外して「浮かせる」やり方とかなり近い発想にある。検討されていた方向に、別 IR を作らずに到達したと読める。

この陳腐化自体が読み方の教訓になる。**公式ドキュメントが実装から遅れることは普通に起きる。** 特に「現状こうである」と書かれた記述は、「なぜそう設計したか」の記述より速く腐る。設計の理由 (アセンブラを提供しないから IR が 1 段で済む) はいまも生きているが、現状の記述 (ミッドエンド最適化を行わない) は死んでいる。OSS を読むとき、docs は出発点として使い、主張はソースで裏を取る必要がある。

## コンパイラが攻撃対象になるという視点

もう 1 つの動機はセキュリティで、これは `cranelift/README.md` に書かれている。

```text title="cranelift/README.md"
Cranelift is production-ready, and is used in production in several places, all
within the context of Wasmtime. It is carefully fuzzed as part of Wasmtime with
differential comparison against V8 and the executable Wasm spec, and the
register allocator is separately fuzzed with symbolic verification. There is an
active effort to formally verify Cranelift's instruction-selection backends.
```

[cranelift/README.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/README.md#L45-L52)

そしてこの一文が、設計方針を 1 つ名指ししている。

```text title="cranelift/README.md"
The core codegen crates have minimal dependencies and are carefully written to
handle malicious or arbitrary compiler input: in particular, they do not use
callstack recursion.
```

[cranelift/README.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/README.md#L74-L76)

**"they do not use callstack recursion"** — コールスタック再帰を使わない。

普通のコンパイラにとって、入力はユーザが書いたソースコードだ。深すぎる入れ子でスタックオーバーフローしても、それはユーザの問題であり、クラッシュしても被害は自分のプロセスで止まる。Wasmtime にとっては違う。**コンパイル対象が信用できない入力そのもの**であり、コンパイラがサンドボックスの外側で動くホストのコードだ。深く入れ子になった wasm を送りつけてホストプロセスを落とせるなら、それは可用性の攻撃になる。

だから再帰を避ける。この方針は実装のあちこちに痕跡を残している。ægraph の elaboration が `elab_stack` / `elab_result_stack` / `block_stack` という 3 本の明示的なスタックで再帰を展開しているのは、まさにこれだ ([逆順 1 スキャンの lowering と、MachBuffer の island](../lowering-and-machbuffer/) で触れた lowering の逆順スキャンも、再帰を使わない形になっている)。

依存を最小にするのも同じ理由からだ。信用境界の外側に置かれるコードの攻撃面は、依存クレートの数だけ広がる。

## 数字

README は生成コードの品質と、コンパイル速度の実測値を挙げている。

```text title="cranelift/README.md"
Cranelift's code quality is within range of competitiveness to browser JIT
engines' optimizing tiers. A [recent paper] includes third-party benchmarks of
Cranelift, driven by Wasmtime, against V8 and an LLVM-based Wasm engine, WAVM
(Fig 22).  The speed of Cranelift's generated code is ~2% slower than that of
V8 (TurboFan), and ~14% slower than WAVM (LLVM). Its compilation speed, in the
same paper, is measured as approximately an order of magnitude faster than WAVM
(LLVM).
```

[cranelift/README.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/README.md#L63-L70)

生成コードは V8 (TurboFan) より約 2% 遅く、WAVM (LLVM) より約 14% 遅い。コンパイル速度は WAVM (LLVM) より約 1 桁速い。

**この 14% と 1 桁の交換が、Cranelift の存在理由をそのまま数字にしている。** wasm モジュールを起動のたびにコンパイルする用途 (サーバレス、エッジ、プラグイン) では、コンパイル時間が実行時間に対して支配的になりうる。第三者のベンチマークであり、Cranelift 側が有利に測ったものではない点も、README がわざわざ論文を引いていることから読める。

なお Cranelift 自身が「速いコンパイル」を最上位の目標にしているわけでもない。最適化を切った本当に速いコンパイルが必要なら、単一パスのベースラインコンパイラ Winch が別に用意されている ([Winch — 単一パスで、見れば分かるコードを吐く](../winch/))。Cranelift はあくまで「最適化コンパイラとしては十分速い」という位置にいる。

## 正しさをどう担保するか

自前のコード生成器を持つということは、**LLVM が積み上げた数十年ぶんの正しさを捨てる**ということでもある。Cranelift はそれを 3 つの仕組みで埋めようとしている。

### filetests

`.clif` ファイル 1 枚がそのままテストになる。ファイルの先頭に何をテストするかを書き、そのあとに CLIF テキスト形式の関数を並べる。

```text title="cranelift/docs/testing.md"
    test optimize
    set opt_level=best
    target riscv64
    set is_pic=0
    target riscv32 supports_m=false

    function %foo() {}
```

[cranelift/docs/testing.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/docs/testing.md#L17-L85)

`set` は累積して適用され、`target` を書くたびにそこまでの設定でテストが 1 回走る。この例なら同じ関数が riscv64 と riscv32 で 2 回テストされる。テストコマンドは 12 種類あり (`alias-analysis` / `cat` / `compile` / `domtree` / `inline` / `interpret` / `optimize` / `print-cfg` / `run` / `safepoint` / `unwind` / `verifier`)、`cranelift/filetests/src/lib.rs` の `new_subtest` がその一覧になっている。

出力の照合には filecheck (LLVM の同名ツールの Rust 実装) を使うが、使い方が LLVM とは違う。

```text title="cranelift/docs/testing.md"
Comments in `.clif` files are associated with the entity they follow.
This typically means an instruction or the whole function. Those tests that
use filecheck will extract comments associated with each function (or its
entities) and scan them for filecheck directives.

Note that LLVM's file tests don't separate filecheck directives by their
associated function. It verifies the concatenated output against all filecheck
directives in the test file. LLVM's :command:`FileCheck` command has a
`CHECK-LABEL:` directive to help separate the output from different functions.
Cranelift's tests don't need this.
```

[cranelift/docs/testing.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/docs/testing.md#L97-L107)

**コメントは直前のエンティティに紐づき、関数ごとに出力と照合される。** LLVM は出力を全部連結してから全ディレクティブを照合するので、関数の境界を人間が `CHECK-LABEL:` で教える必要がある。Cranelift はテストファイルのパーサが関数の構造を知っているのだから、それを使えばよい。「入力の構造を知っているなら、それをテストの構造にも使う」という素直な判断だ。

### 差分ファジング

`fuzz/fuzz_targets/` にターゲットが並んでいる。Cranelift に関係するのは 3 つ。

- `cranelift-fuzzgen.rs` — ランダムな CLIF 関数を生成し、Cranelift でコンパイルした結果と CLIF インタプリタでの実行結果を突き合わせる。**自分の 2 つの実装を比較する**形の差分テスト。
- `differential.rs` — 生成した wasm モジュールを Wasmtime と他のエンジンで実行して結果を比較する。比較先は `crates/fuzzing/src/oracles/` にあり、`diff_v8.rs` (V8)、`diff_wasmi.rs` (wasmi)、`diff_spec.rs` (仕様インタプリタ) の 3 つ。
- `cranelift-icache.rs` — インクリメンタルコンパイルのキャッシュが、キャッシュなしと同じ結果を出すかを検査する。

**比較対象が「別実装」であることが効いている。** 「正しい出力」を人間が書く必要がなく、テストケースをいくらでも自動生成できる。仕様インタプリタは遅いが仕様そのものであり、V8 は速いが別チームの実装だ。両方と比較すれば、片方のバグに引きずられる確率が下がる。

### 形式検証

3 つ目が形式検証で、README の言葉では "the register allocator is separately fuzzed with symbolic verification. There is an active effort to formally verify Cranelift's instruction-selection backends."

命令選択の検証は、規則を ISLE という DSL で書いたことの直接の見返りだ。x64 の `lower.isle` には既に `(spec (lower arg) (provide ...))` という仕様注釈が入っていて、「トラップしないなら結果が一致する」「CLIF がトラップするなら実装もトラップする」「ロード / ストアの副作用が一致する」という等価性条件が宣言されている ([ISLE — 命令選択を DSL で書く](../isle/))。

**「LLVM の膨大なテスト実績」の代わりに、「機械的に検査可能な構造」を選んだ**と言える。手書きの Rust で命令選択を書いていたら、検証器に渡す仕様を書く場所がない。DSL にしたのは記述量を減らすためだけではない。

## どう活かすか

このページの中心は「LLVM は重いから自前で作った」ではない。**スコープを狭めることが、アーキテクチャの段数を減らした**という因果だ。アセンブラを提供しないと決めたから IR が 1 段で済み、1 段で済むからコンパイルが速く、速いから起動のたびにコンパイルする用途が成立する。1 つの制約の受け入れが、下流の判断を連鎖的に単純にしている。

そして「信用できない入力を処理するコードなのか」という問いは、設計の早い段階で立てる価値がある。答えが Yes なら、再帰を使わない、依存を最小にする、ファジングに晒すといった判断が全部そこから導かれる。**入力の信用度は、実装技法を選ぶ前に決まっている前提条件だ。**

最後に、公式ドキュメントの扱い方。`compare-llvm.md` の「Cranelift はミッドエンド最適化を行わない」は既に嘘だが、同じ文書の「アセンブラを提供しないから IR が 1 段で済む」はいまも真だ。**設計の理由は長生きし、現状の記述はすぐ腐る。** OSS のドキュメントを読むときは、この 2 つを分けて受け取るとよい。
