---
title: "書き換え規則の掟 4 か条と、爆発を止める 4 つの上限"
description: "Cranelift のミッドエンド書き換え規則には README で明文化された 4 つの掟がある。「右辺は左辺以上に良くなければならない」「使用を減らす規則は subsume を使え」「交換則を書くな」「同じ Value に複数回マッチするな」。そしてこれらとは別に、e-graph の爆発を 5・5・5・500 という 4 つの小さなハードコード定数で止めている。"
group: "Cranelift — Wasm を機械語にする"
sidebar:
  order: 28
---

Cranelift のミッドエンド書き換え規則には、`cranelift/codegen/src/opts/README.md` に明文化された 4 つの掟がある。その冒頭がこう始まる。

```text title="cranelift/codegen/src/opts/README.md"
For both correctness and compile speed, we must be careful with our rules. A lot
of it boils down to the fact that, unlike traditional e-graphs, our rules are
*directional*.
```

[cranelift/codegen/src/opts/README.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/opts/README.md)

**規則が有向であること**が、掟のすべての根っこにある。教科書的な e-graph は「これとこれは等しい」という無向の関係を扱い、書き換えの向きを気にしない。Cranelift の ægraph は「左辺より右辺のほうが良い」という向きを規約として持ち込んでいる ([ægraph — 非循環な e-graph という選択](../egraph/))。向きがあるから extraction が単純になり、爆発も抑えられる。その代わり、向きを守るのは人間の責任になる。

## 掟 1 — 右辺は左辺以上に良くなければならない

```text title="cranelift/codegen/src/opts/README.md"
1. Rules should not rewrite to worse code: the right-hand side should be at
   least as good as the left-hand side or better.

   For example, the rule

       x => (add x 0)

   is disallowed, but swapping its left- and right-hand sides produces a rule
   that is allowed.

   Any kind of canonicalizing rule that intends to help subsequent rules match
   and unlock further optimizations (e.g. floating constants to the right side
   for our constant-propagation rules to match) must produce canonicalized
   output that is no worse than its noncanonical input.

   We assume this invariant as a heuristic to break ties between two
   otherwise-equal-cost expressions in various places, making up for some
   limitations of our explicit cost function.
```

最後の 2 行が、この掟を「単なるお願い」から「実装が依存している不変条件」に格上げしている。`Elaborator` の `BestEntry` はコストが同点のときに **値番号が大きいほう**を選ぶ。値番号は生成順なので、大きいほうが後から作られた書き換え結果だ。つまり **コスト関数が区別できないとき、実装はこの掟のほうを信じる**。掟 1 を破った規則は「コストは同じだが実は悪化する書き換え」を作りうる。

正規化規則にも同じ縛りがかかるのが重要な点だ。「後続の規則をマッチさせるための下ごしらえ」であっても、それ単体で悪化してはならない。`cprop.isle` の即値を右に寄せる規則がその例で、`(iadd ty k x)` を `(iadd ty x k)` に書き換えるだけなので、コストは変わらず悪化しない。

## 掟 2 — 使用を減らす規則は必ず `subsume`

```text title="cranelift/codegen/src/opts/README.md"
2. Any rule that removes value-uses in its right-hand side that previously
   existed in its left-hand side MUST use `subsume`.

   For example, the rule

       (select 1 x y) => x

   MUST use `subsume`.

   This is required for correctness because, once a value-use is removed, some
   e-nodes in the e-class are more equal than others. There might be uses of `x`
   in a scope where `y` is not available, and so emitting `(select 1 x y)` in
   place of `x` in such cases would introduce uses of `y` where it is not
   defined.
```

これが 4 つの掟のなかで唯一、**破ると正しくないコードが出る**ものだ。

`subsume` を使わないと、`(select 1 x y)` と `x` が同じ eclass の中に並んで残る。eclass の中身はどれを選んでもよいことになっているので、extraction が `(select 1 x y)` のほうを選ぶかもしれない。ところが elaboration が `x` を要求している場所で `y` が定義されていない (支配木の別の枝でしか定義されていない) 可能性がある。**「等価だが依存が多いほう」を選ぶと、その依存が届かない場所で壊れる。** e-graph は「等価」を「どこでも交換可能」と読むが、SSA の値には定義位置がある。この 2 つのズレがそのまま現れる。

`subsume` の実装自体は 1 行だ。

```rust title="cranelift/codegen/src/opts.rs"
fn subsume(&mut self, value: Value) -> Value {
    trace!("subsume: {}", value);
    self.ctx.subsume_values.insert(value);
    self.ctx.stats.subsume += 1;
    value
}
```

[cranelift/codegen/src/opts.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/opts.rs#L303-L308)

このマークが付いた値が 1 つでもあると、`optimize_pure_enode` は Union 木を作らず、その値だけを返す。**eclass を作るのではなく、eclass を潰す。**

README には例外も書かれている。捨てられるのが定数だけなら `subsume` は要らない。定数はどこでもリマテリアライズできるので、「定義されていない場所」が存在しないからだ。

実際の規則を見ると、掟 2 が守られていることが読める。

```lisp title="cranelift/codegen/src/opts/arithmetic.isle"
;; x+0 == x.
(rule iadd_x_plus_zero (simplify (iadd ty
                      x
                      (iconst_u ty 0)))
      (subsume x))

;; x*0 == 0.
(rule (simplify (imul ty
                      _
                      zero @ (iconst_u ty 0)))
      (subsume zero))

;; x*-1 == ineg(x).
(rule (simplify (imul ty x (iconst_s ty -1)))
      (ineg ty x))
```

[cranelift/codegen/src/opts/arithmetic.isle](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/opts/arithmetic.isle#L7-L66)

`x+0 => x` と `x*0 => 0` は使用を落とすので `subsume` が付く。`x*-1 => ineg(x)` は `x` を使い続けるので付かない。この 3 行だけで掟 2 の判定基準が読み取れる。

## 掟 3 — 交換則と結合則を書くな

```text title="cranelift/codegen/src/opts/README.md"
3. Avoid overly general rewrites like commutativity and associativity. Instead,
   prefer targeted instances of the rewrite ... or even writing the "same"
   optimization rule multiple times.

   ...

   The cost of rule-matching is amortized by the ISLE compiler, where as the
   intermediate result of each rewrite allocates new e-nodes and requires
   storage in the dataflow graph. Therefore, additional rules are cheaper than
   additional e-nodes.

   Commutativity and associativity in particular can cause huge amounts of
   e-graph bloat.
```

これは e-graph の常識に反する。e-graph の売りは「交換則も結合則も全部入れておけば、あとは飽和させるだけで最適な形が見つかる」ことのはずだ。Cranelift はそれを拒否する。

理由は "additional rules are cheaper than additional e-nodes" という 1 文に凝縮されている。**規則を増やすコストは ISLE のコンパイル時に決定木へ畳まれて償却されるが、enode を増やすコストは実行時のメモリと探索時間に直接乗る。** `(foo x y) => (foo y x)` という汎用の交換則は、`foo` が現れるたびに無条件で enode を 1 個増やす。それが後続の規則に役立つかどうかとは無関係にだ。

推奨されるのは 3 段階で、悪いほうから順に「汎用の交換則」「後続規則がマッチすると分かっている場合だけの正規化」「同じ最適化を両方の引数順で 2 回書く」。実際のコードでは 3 番目が採用されている。

```lisp title="cranelift/codegen/src/opts/bitops.isle"
;; `or(and(x, y), not(y)) == or(x, not(y))`
(rule (simplify (bor ty
                     (band ty x y)
                     z @ (bnot ty y)))
      (bor ty x z))
;; Duplicate the rule but swap the `bor` operands because `bor` is
;; commutative. We could, of course, add a `simplify` rule to do the commutative
;; swap for all `bor`s but this will bloat the e-graph with many e-nodes. It is
;; cheaper to have additional rules, rather than additional e-nodes, because we
;; amortize their cost via ISLE's smart codegen.
(rule (simplify (bor ty
                     z @ (bnot ty y)
                     (band ty x y)))
      (bor ty x z))
```

[cranelift/codegen/src/opts/bitops.isle](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/opts/bitops.isle#L52-L65)

同じ規則がコピペで 2 回書かれている。掟 3 はこれを推奨する。

ただし「後続がマッチすると分かっている正規化」も使われている。即値を右に寄せる規則群がそれで、`arithmetic.isle` の冒頭が依存関係を明示している。

```lisp title="cranelift/codegen/src/opts/arithmetic.isle"
;; For commutative instructions, we depend on cprop.isle pushing immediates to
;; the right, and thus only simplify patterns like `x+0`, not `0+x`.
```

`x+0` だけを書き、`0+x` を書かないで済むのは、正規化が確実に効くと分かっているからだ。この場合は正規化 1 本のほうが規則の重複より安い。掟 3 は「絶対に正規化するな」ではなく「その正規化が確実に何かを解錠すると言えないなら書くな」である。

結合則についても、汎用の再結合ではなく `((a op B) op (c op D)) => ((a op c) op (B op D))` という定数を寄せ集める形に限定した規則が `cprop.isle` に 5 つ (iadd/imul/band/bor/bxor) 並んでいる。「定数どうしを隣接させて定数畳み込みを解錠する」という目的が明確な 1 形だけを許している。

## 掟 4 — 同じ `Value` に複数回マッチするな

```text title="cranelift/codegen/src/opts/README.md"
4. Be careful with (ideally avoid) multiple matches on the same `Value`, as
   they can result in surprising multi-matching behavior.

   In our mid-end ISLE environment, a `Value` corresponds to an eclass, with
   multiple possible representations. A rule that matches on a `Value` will
   traverse all enodes in the eclass, looking for a match.

   ...

    Then this can result in the extremely surprising behavior that `(ireduce
    (other_op ...))` matches, if `(other_op ...)` is in the same eclass as an
    `iadd` or `isub`. This happens because the left-hand side binds `x`, which
    describes the entire eclass; and `suitable_for_rewrite` matches if *any*
    representation of `x` matches.

    This resulted in a real bug in #7999.
```

問題は、パターン変数が enode ではなく **eclass 全体**に束縛されることだ。`(simplify (ireduce _ x))` の `x` は「1 つの命令」ではなく「等価な表現の集合」を指す。ヘルパー `suitable_for_rewrite` にその `x` を渡すと、ヘルパーは集合の中に `iadd` か `isub` が 1 つでもあれば成功する。一方、右辺が実際に使う `x` は、extraction が選んだ別の表現かもしれない。**「マッチに使った表現」と「出力に使う表現」が同じ eclass の別メンバーになりうる。**

README の処方箋は抽象化しないことだ。ヘルパーで条件を切り出さず、パターンを直接書く。

```lisp
(rule (simplify (ireduce _ (iadd ...)))
      (iadd ...))
(rule (simplify (ireduce _ (isub ...)))
      (isub ...))
```

こう書けば、マッチした enode と出力する enode が同じであることがパターンの形から保証される。README が付け加えているとおり "This has the additional benefit that the rewrites are more clearly visible to the casual reader" でもある。掟 3 と掟 4 は、どちらも「規則を DRY にしようとするな」という同じ方向を向いている。

## 爆発を止める 4 つの上限

掟は人間側の規律だが、それとは別に実装が持つハードな上限が 4 つある。全部が小さなハードコード定数だ。

```rust title="cranelift/codegen/src/egraph/mod.rs"
/// The maximum number of rewrites we will take from a single call into ISLE.
const MATCHES_LIMIT: usize = 5;

/// The maximum number of enodes in any given eclass.
const ECLASS_ENODE_LIMIT: usize = 5;

/// The amount of "fuel" available for each top-level rewrite
/// invocation's eclass extractors.
///
/// Each yield from a multi-extractor iterator consumes one unit.
pub(crate) const EXTRACTOR_FUEL: u32 = 500;
```

[cranelift/codegen/src/egraph/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/egraph/mod.rs#L126-L139)

4 つ目は `optimize_pure_enode` の中にある。

```rust title="cranelift/codegen/src/egraph/mod.rs"
// Limit rewrite depth. When we apply optimization rules, they
// may create new nodes (values) and those are, recursively,
// optimized eagerly as soon as they are created. ...
// To avoid infinite or problematic recursion, we bound the rewrite
// depth to a small constant here.
const REWRITE_LIMIT: usize = 5;
if ctx.rewrite_depth >= REWRITE_LIMIT {
    ctx.stats.rewrite_depth_limit += 1;
    return orig_value;
}
```

[cranelift/codegen/src/egraph/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/egraph/mod.rs#L364-L380)

それぞれが止めているものが違う。`MATCHES_LIMIT` は 1 回の ISLE 呼び出しが返す書き換え候補の数を切り詰める。`ECLASS_ENODE_LIMIT` は Union 木を積むループの中で「この union で eclass のサイズが 5 を超える」と判断したら `break` する。`REWRITE_LIMIT` は「規則が新しいノードを作る → そのノードも即座に最適化される」という再帰の深さを止める。`EXTRACTOR_FUEL` は eclass の走査量を止める。

**4 つとも、上限に達したら黙って最適化をやめるだけ**なのが要点だ。fuel を消費する場所のコメントがその理由をはっきり書いている。

```rust title="cranelift/codegen/src/opts.rs"
ValueDef::Result(inst, _) if ctx.ctx.func.dfg.inst_results(inst).len() == 1 => {
    // Charge one unit of fuel per yielded match. When
    // fuel is exhausted, terminate iteration early:
    // returning no matches is always semantically valid
    // (we just skip would-be rewrites) and bounds work
    // per top-level ISLE invocation.
    if ctx.ctx.extractor_fuel == 0 {
        ctx.ctx.stats.rewrite_fuel_exhausted += 1;
        trace!(" -> rewrite fuel exhausted");
        return None;
    }
    ctx.ctx.extractor_fuel -= 1;
    // ...
}
```

[cranelift/codegen/src/opts.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/opts.rs#L100-L116)

"returning no matches is always semantically valid" — **何も書き換えないことは常に正しい**。だから打ち切りは常に安全側に倒れる。最適化パスがこの性質を持っていると、リソース上限を入れるのが極端に簡単になる。どこで切っても壊れないので、定数の値はコンパイル時間と生成コード品質のトレードオフだけで決めればよい。5 という値の根拠はソースには書かれていないが、書かれている必要もない。

この抽出イテレータ (`InstDataEtorIter`) 自身も読んでおく価値がある。root の `Value` から始めて、`ValueDef::Union(x, y)` なら両方をスタックに積み、`ValueDef::Result` で結果が 1 個ならそれを yield する。**Union 木の DFS がそのまま「eclass の全 enode を列挙する」になっている。** ISLE の側から見ると `(iadd ty x (iconst _ 0))` というパターンは「引数の eclass のどこかに `iconst 0` があるか」を訊いていて、その探索がこのイテレータの繰り返しだ。fuel はその探索 1 歩ぶんを 1 単位として課金される。

## どう活かすか

3 つ持ち帰れるものがある。

1 つ目は、**不変条件を人間の規律として文書化し、実装がそれに依存していることを明記する**という書き方だ。README の掟 1 は「破ると何が壊れるか」まで書いている (タイブレークのヒューリスティックが根拠を失う)。規約を書くとき、守られなかったときに壊れる箇所を一緒に書くと、規約が守られる確率が上がる。

2 つ目は、掟 3 と掟 4 に共通する「抽象化を避ける」という判断だ。汎用の交換則も、条件のヘルパーも、コードとしては明らかに DRY で美しい。それを両方とも却下しているのは、**この領域では抽象化のコストが実行時に乗るから**だ。抽象化が常に正しいわけではない、という具体例として使える。

3 つ目は「途中でやめても正しい」という設計だ。最適化パスを「やらなくても正しい変換の集まり」として設計しておくと、タイムアウトも、メモリ上限も、fuel も、あとから 5 行で足せる。
