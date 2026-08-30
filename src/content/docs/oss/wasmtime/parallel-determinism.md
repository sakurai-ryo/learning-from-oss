---
title: "並列コンパイルのエラーを、わざと非効率にして決定論にする"
description: "Wasmtime は関数を rayon で並列にコンパイルするが、結果を Result<Vec<_>, E> に直接畳まない。全結果を一度 Vec<Result<_, E>> に materialize してから最初のエラーを返す。1 つ壊れていれば残り全部の仕事が無駄になると分かっていて、そうしている。理由は「並列でも逐次でも同じエラーが返る」ことを保証するためで、それを検証するテストがある。"
group: "コンパイルパイプライン"
sidebar:
  order: 20
---

Wasmtime の並列コンパイルには、**明らかに非効率な書き方が意図的に残されている**。エラーで早期に打ち切らず、全関数のコンパイルが終わるのを待ってから最初のエラーを返す。理由は 1 行で書かれている。エラーを決定論的にするためだ。

## 1 か所しかない並列化の入口

コンパイルの並列化は、`Engine` のヘルパー 1 つに集約されている。

```rust title="crates/wasmtime/src/engine.rs"
pub(crate) fn run_maybe_parallel<A: Send, B: Send, E: Send, F: Fn(A) -> Result<B, E> + Send + Sync>(
    &self,
    input: Vec<A>,
    f: F,
) -> Result<Vec<B>, E> {
    if self.config().parallel_compilation {
        #[cfg(feature = "parallel-compilation")]
        {
            use rayon::prelude::*;
            // If we collect into Result<Vec<B>, E> directly, the returned error is not
            // deterministic, because any error could be returned early. So we first materialize
            // all results in order and then return the first error deterministically, or Ok(_).
            return input
                .into_par_iter()
                .map(|a| f(a))
                .collect::<Vec<Result<B, E>>>()
                .into_iter()
                .collect::<Result<Vec<B>, E>>();
        }
    }

    // In case the parallel-compilation feature is disabled or the parallel_compilation config
    // was turned off dynamically fallback to the non-parallel version.
    input
        .into_iter()
        .map(|a| f(a))
        .collect::<Result<Vec<B>, E>>()
}
```

[crates/wasmtime/src/engine.rs#L185-L216](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/engine.rs#L185-L216)

`collect::<Vec<Result<B, E>>>()` と `collect::<Result<Vec<B>, E>>()` を 2 段に分けているのが要点だ。rayon の `ParallelIterator` は `Result<Vec<_>, _>` へ直接 collect でき、その場合は **どれか 1 つがエラーになった時点で残りの仕事を打ち切る**。速いが、複数の関数が同時にエラーになるモジュールでは、どのエラーが返るかがスレッドのスケジューリング次第になる。

だから一度 `Vec<Result<B, E>>` に全部詰めてから、逐次イテレータとして `Result<Vec<B>, E>` に畳み直す。この 2 段目は**入力の順序どおりに走る**ので、返るのは必ず「関数インデックスが最小のエラー」になる。**早期リターンという最適化を意図的に捨てている。**

同じコードが、インライン化パスが使う `run_maybe_parallel_mut` にもコメントごと複製されている ([engine.rs#L220-L251](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/engine.rs#L220-L251))。共通化されていないのは、片方が `Vec<A> -> Result<Vec<B>, E>`、もう片方が `&mut [T] -> Result<(), E>` でシグネチャが噛み合わないためだ。

## 何を保証したいのか

コメントは「非決定的になる」としか言っていないが、この変更を入れたコミットに付いているテストが要求を明示している。

```rust title="tests/all/module.rs"
#[test]
#[cfg_attr(miri, ignore)]
fn validate_deterministic() {
    let mut faulty_wat = "(module ".to_string();
    for i in 0..100 {
        faulty_wat.push_str(&format!(
            "(func (export \"foo_{i}\") (result i64) (i64.add (i32.const 0) (i64.const 1)))"
        ));
    }
    faulty_wat.push_str(")");
    let binary = wat::parse_str(faulty_wat).unwrap();

    let engine_parallel = Engine::new(&Config::new().parallel_compilation(true)).unwrap();
    let result_parallel = Module::validate(&engine_parallel, &binary).unwrap_err().to_string();

    let engine_sequential = Engine::new(&Config::new().parallel_compilation(false)).unwrap();
    let result_sequential = Module::validate(&engine_sequential, &binary).unwrap_err().to_string();
    assert_eq!(result_parallel, result_sequential);
}
```

[tests/all/module.rs#L563-L585](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/tests/all/module.rs#L563-L585)

100 個の型エラーを含む関数を並べたモジュールを、並列と逐次の両方で検証し、**エラーメッセージの文字列が一致することを assert している**。つまり要求は「安定していること」ではなく、**「並列パスと逐次パスが同じ答えを返すこと」**だ。設定を切り替えても観測結果が変わらないなら、`parallel_compilation` は純粋に性能のつまみになる。逆に一致しないなら、それは意味論に影響する設定ということになり、埋め込む側は簡単に切り替えられなくなる。

コミット `1c97044077` (Make module validation deterministic in case of multiple errors, #9947) はこの 5 行の追加とこのテストだけからなる。この形の要求が切実になるのは、同じバイナリを複数のノードで拒否しなければならない環境 — 複製状態機械のように、全ノードが同じ入力に同じ結論 (同じエラー) を出す必要がある場面だ。

決定論はデバッグ側にも効く。ファジングが見つけた入力を手元で再現するとき、コアの数もスレッド数も報告者と同じにはならない。エラーが非決定的なら、同じ入力を渡しても違うメッセージが出て「再現しない」と判断されうる。Wasmtime のバグ報告ガイドが期待する動作 (`docs/contributing-fuzzing.md`) は「同じ入力に同じ挙動」であり、コンパイルエラーはその一部だ。

## 関数を独立に並列化できる理由

そもそもなぜ関数単位で並列化できるのかは、アーキテクチャ文書に一言で書かれている。

```text title="docs/contributing-architecture.md"
2. Next all functions within a module are validated and compiled in parallel.
   No inter-procedural analysis is done and each function is compiled as its
   own little island of code at this time. This is the point where the meat of
   Cranelift is invoked on a per-function basis.
```

[docs/contributing-architecture.md#L156-L159](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/docs/contributing-architecture.md#L156-L159)

**手続き間解析をしない。関数はそれぞれ「小さな島」としてコンパイルされる。** 関数 A のコンパイル結果が関数 B のコンパイル結果に影響しないので、共有状態はなく、実行順序も結果に効かない。呼び出し先のアドレスは未解決のリロケーションとして残され、後段の `link_and_append_code` が解決する ([コンパイル対象は「関数」だけではない](../compile-inputs/))。

この文書の記述は、インライン化パスが入ったことで厳密には現状と食い違う。インライン化を有効にすると関数間に依存が生まれ、並列化は「呼び出しグラフの層ごと」に切り直される ([モジュールを跨いでインライン化し、呼び出しグラフを層に切る](../inlining-strata/))。ただしその場合も層の中は独立なので、`run_maybe_parallel` の決定論の議論はそのまま生きる。

## rayon と feature

並列化は `rayon` の `into_par_iter()` で、それ以外の仕掛けはない。スレッドプールは rayon のグローバルプールをそのまま使い、Wasmtime 側でプールを持たない。

有効・無効は 2 段階で決まる。**コンパイル時**に `parallel-compilation` feature が付いているか (これが `dep:rayon` を引き込む)、そして**実行時**に `Config::parallel_compilation` が `true` か。どちらかが欠ければ、`if` を素通りして下の逐次版が走る。既定値は `!cfg!(miri)` で、[Miri 下では自動的に逐次になる](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/config.rs#L306)。

feature を落とした場合、`Config::parallel_compilation` メソッド自体が消える (メソッドに `#[cfg(feature = "parallel-compilation")]` が付いている) が、`Config` 構造体のフィールドは残り続ける。だから `run_maybe_parallel` の `if self.config().parallel_compilation` は常にコンパイルでき、feature の有無を条件分岐 1 つで吸収できている。

## どう活かすか

「並列化したら早期リターンできる」は普通は利点として数えられる。Wasmtime はそれを **観測可能な非決定性**として扱い、性能より優先して潰した。ここから取れる基準は単純だ。

**並列化のオン・オフが観測結果を変えるなら、それは性能のつまみではない。** 失敗を返す並列処理を書くときは、「どのエラーが返るか」が入力だけで決まるかを一度確認する。決まらないなら、全結果を materialize してから順序どおりに畳むコストは、たいてい払う価値がある。エラーは例外的な経路なので、そのときだけ余計に走る仕事は、成功時の性能に一切影響しない。
