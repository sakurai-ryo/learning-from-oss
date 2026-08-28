---
title: "オプティマイザは Plan を書き換えるパスの列でできている"
description: "`optimize_plan` は 18,909 行のモジュールの入口で、その中は「プランをその場で書き換えるパス」が順番に並んでいる。ただし本体である結合順序の探索だけは、探索と適用が分かれている。`TableAccessPlan` を返すだけで書き換えないから、同じクエリの 2 つの形を両方探索して安い方を採る、という芸当ができる。"
group: "SQL からバイトコードへ"
sidebar:
  order: 10
---

## この層の責務

前のページで見たとおり、プランナが作る `SelectPlan` は「全部のテーブルを全走査し、`join_order` は SQL に書かれた順、条件は全部 `where_clause` に入っている」という素朴な形をしている。

オプティマイザの仕事は、この構造体を書き換えることだ。

- `JoinedTable.op` を `Scan` から `Search` や `HashJoin` に変える
- `join_order` を並べ替える
- 索引のシークキーになった `WhereTerm` に `consumed` を立てる
- `order_by` が索引で満たせるなら空にする
- 相関サブクエリを join に書き換える

**新しいプランを作らず、同じ構造体を叩く。** これが基本方針で、例外が 1 つある。

## 主要な型とその関係

### モジュールの構成

```console
$ wc -l core/translate/optimizer/*.rs | sort -rn
   18909 total
    4559 core/translate/optimizer/mod.rs
    4147 core/translate/optimizer/join.rs
    2234 core/translate/optimizer/constraints.rs
    1979 core/translate/optimizer/access_method.rs
    1928 core/translate/optimizer/multi_index.rs
    1498 core/translate/optimizer/unnest.rs
    1081 core/translate/optimizer/order.rs
     614 core/translate/optimizer/lift_common_subexpressions.rs
     456 core/translate/optimizer/cost.rs
     413 core/translate/optimizer/cost_params.rs
```

| ファイル                        | 役割                                           | 深掘り                            |
| ------------------------------- | ---------------------------------------------- | --------------------------------- |
| `mod.rs`                        | パスの並びと、その繋ぎ                         | このページ                        |
| `join.rs`                       | 結合順序の動的計画法                           | [該当ページ](../join-order-dp/)   |
| `constraints.rs`                | `WhereTerm` → 索引に使える制約                 | このページ                        |
| `access_method.rs`              | 1 テーブルの読み方の候補生成とコスト           | このページ                        |
| `multi_index.rs`                | `OR` を索引の和集合に                          | —                                 |
| `unnest.rs`                     | 相関サブクエリ → join                          | [該当ページ](../subquery-unnest/) |
| `order.rs`                      | `ORDER BY` / `GROUP BY` をソート省略に         | —                                 |
| `lift_common_subexpressions.rs` | `(a=1 AND x) OR (a=1 AND y)` → `a=1 AND (...)` | —                                 |
| `cost.rs` / `cost_params.rs`    | コストモデルと、その定数                       | [該当ページ](../cost-params/)     |

`mod.rs` が 4,559 行あるのは、パスの繋ぎ以外に `find_table_access_plan` (実質的な本体) が入っているからだ。

### `TableAccessPlan` — 探索の結果を、書き込まずに返す

```rust title="core/translate/optimizer/mod.rs:863-871"
/// The table reads chosen by the join search.
struct TableAccessPlan {
    access_methods: Vec<AccessMethod>,
    constraints: Vec<TableConstraints>,
    join: JoinN,
    subquery_calls: SmallVec<[(TableInternalId, f64); 2]>,
    order_target: Option<OrderTarget>,
    sort_eliminated: bool,
}
```

これがこのページで一番重要な型だ。**結合順序の探索は、プランを書き換えずにこの構造体を返す。**

書き戻しは別の関数がやる。

```rust title="core/translate/optimizer/mod.rs:1128-1145"
/// Write the winning table plan into one version of a query.
fn apply_select_table_plan(
    plan: &mut SelectPlan,
    table_plan: Option<TableAccessPlan>,
    resolver: &Resolver,
) -> Result<()> {
    let Some(table_plan) = table_plan else {
        return Ok(());
    };
    plan.join_order = apply_table_access_plan(
        resolver,
        &mut plan.table_references,
        &mut plan.where_clause,
        &mut plan.order_by,
        &mut plan.group_by,
        table_plan,
    )?;
    Ok(())
}
```

**find と apply が分かれていることが、次の節の「2 つの形を比べる」を可能にしている。**

## 処理の流れ (コードを追う)

### 入口 — プランの種類で振り分け、資源を回収する

```rust title="core/translate/optimizer/mod.rs:551-569 (抜粋)"
pub fn optimize_plan(
    program: &mut ProgramBuilder,
    plan: &mut Plan,
    resolver: &Resolver,
) -> Result<()> {
    let resources_before = subquery_resources(plan);
    match plan {
        Plan::Select(plan) => optimize_select_plan(plan, resolver)?,
        Plan::Delete(plan) => optimize_delete_plan(plan, resolver)?,
        Plan::Update(plan) => optimize_update_plan(program, plan, resolver)?,
        Plan::CompoundSelect { left, right_most, .. } => { /* 各枝を個別に */ }
        Plan::RecursiveCte(recursive_cte) => { /* 初期クエリと再帰クエリを個別に */ }
    }
    let resources_after = subquery_resources(plan);
```

そして最適化の前後で、サブクエリが持っていたカーソル ID とレジスタ範囲を比較する。

```rust title="core/translate/optimizer/mod.rs:575-587"
    for cursor_id in resources_before
        .cursor_ids
        .difference(&resources_after.cursor_ids)
    {
        program.release_cursor_id(*cursor_id);
    }
    for (start, count) in resources_before
        .register_ranges
        .difference(&resources_after.register_ranges)
    {
        program.release_registers(*start, *count);
    }
```

**最適化でサブクエリが消えたら、そのサブクエリが予約していたカーソルとレジスタを `ProgramBuilder` に返す。**

これは [前のページ](../logical-plan/) で見た「プランがコード生成の資源を持っている」ことの直接の帰結だ。`QueryDestination::In { cursor_id }` のようにプランがカーソル ID を握っているので、プランを消すときに手で解放しなければならない。演算子ツリーで「ノードを外す」だけで済む設計にはなっていない。

`optimize_plan` が `&mut ProgramBuilder` を受け取っているのは、この解放のためだ。

### 2 つの形を作って、両方のコストを出して、安い方を採る

これが唯一の「プランを作り直す」経路になる。

```rust title="core/translate/optimizer/mod.rs:893-911 (抜粋)"
fn optimize_select_plan_with_cache(
    plan: &mut SelectPlan,
    resolver: &Resolver,
    cache: &mut SubqueryPlanCache,
) -> Result<()> {
    if !plan.non_from_clause_subqueries.iter().any(|subquery| subquery.correlated) {
        return optimize_select_plan_form(plan, resolver, cache);
    }

    // TODO: Let join search run a correlated subquery as soon as all columns
    // that it needs are ready. It can then compare that step with the added
    // join tables in one search. Until then, both forms need their own search.
    let mut rewritten = plan.clone();
    if !unnest::rewrite_correlated_subqueries(&mut rewritten, resolver)? {
        return optimize_select_plan_form(plan, resolver, cache);
    }
```

**相関サブクエリがあるときだけ、プランを丸ごと clone する。** 片方は元のまま、片方は unnest した形。

```rust title="core/translate/optimizer/mod.rs:935-950"
    let original_table_plan = find_select_plan_form(plan, resolver, cache, true, None)?;
    let cost_limit = plan.estimated_cost.map(Cost);
    let rewritten_table_plan =
        find_select_plan_form(&mut rewritten, resolver, cache, false, cost_limit)?;
    let use_rewritten = matches!(
        (plan.estimated_cost, rewritten.estimated_cost),
        (Some(original_cost), Some(rewritten_cost)) if rewritten_cost <= original_cost
    );
    if use_rewritten {
        // Equal work is better without one subquery call per outer row.
        *plan = rewritten;
        apply_select_table_plan(plan, rewritten_table_plan, resolver)?;
    } else {
        apply_select_table_plan(plan, original_table_plan, resolver)?;
    }
```

3 つ注目したい。

**`find` を 2 回、`apply` を 1 回。** 探索が書き換えないからこうできる。もし探索がプランを直接書き換えていたら、比較のたびに元に戻す必要があった。

**2 回目には 1 回目のコストが上限として渡る。** `cost_limit` で枝刈りする。1 回目より高くなると分かった時点で探索を打ち切れる。

**同点なら書き換えた方を採る。** コメントが理由を書いている — コストが同じでも、外側の行ごとにサブクエリを起動する手間がない方がよい。

`SubqueryPlanCache` はこの clone のために存在する。

```rust title="core/translate/optimizer/mod.rs:873-879"
#[derive(Default)]
struct SubqueryPlanCache {
    // The original and changed forms copy the same child subqueries. Keep a
    // finished child plan so the next copy does not plan that child again.
    from_clause: HashMap<TableInternalId, Plan>,
    correlated: HashMap<(TableInternalId, u64), Plan>,
}
```

**2 つの形は同じ子サブクエリを共有している**ので、子の最適化は 1 回でよい。

### パスの並び

`find_select_plan_form` が実際の順序を表している ([`core/translate/optimizer/mod.rs:965`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/mod.rs#L965))。

| #   | 何をするか                                     | 呼び出し                                          |
| --- | ---------------------------------------------- | ------------------------------------------------- |
| 1   | `MATCH` を FTS の検索に書き換える              | `transform_match_to_fts_match`                    |
| 2   | `EXISTS` サブクエリに `LIMIT 1` を足す         | インライン                                        |
| 3   | 非相関サブクエリを先に最適化する               | `optimize_subqueries`                             |
| 4   | 使える索引を集める                             | `AvailableIndexes::for_table_references`          |
| 5   | `OR` の共通項を括り出す                        | `lift_common_subexpressions_from_binary_or_terms` |
| 6   | 定数条件を畳む                                 | `eliminate_constant_conditions`                   |
| 7   | `COUNT(*)` / `MIN` / `MAX` の近道を検出        | `detect_simple_aggregate`                         |
| 8   | **テーブルの読み方と結合順序を決める**         | `find_table_access_plan`                          |
| 9   | 出力行数を見積もり、`LIMIT` で頭打ちにする     | `estimate_select_output_rows`                     |
| 10  | 相関サブクエリを、呼ばれる回数込みで最適化する | `plan_correlated_subqueries`                      |
| 11  | テーブルのコストとサブクエリのコストを足す     | インライン                                        |

順序に理由があるものをいくつか見る。

**1 が最初にあるのは、書き換えが `WHERE` を動かすから。**

```rust title="core/translate/optimizer/mod.rs:980-983"
// A rewrite can move MATCH terms out of a subquery, so do this after the
// query form has been chosen.
transform_match_to_fts_match(&mut plan.where_clause, resolver, &plan.table_references)?;
```

「query form が決まった後」— つまり unnest するかどうかを決めた後でなければならない。unnest でサブクエリの中の `MATCH` が外に出てくるので、先に変換すると取りこぼす。

**2 の `EXISTS` → `LIMIT 1` は、ユーザの `LIMIT` を尊重する。**

```rust title="core/translate/optimizer/mod.rs:985-986"
// EXISTS only needs one row. Add LIMIT 1 to subqueries left after the
// rewrite. The rewrite must see the limit written by the user, if any.
```

`limit.is_none()` のときだけ足す。そして「書き換え (unnest) の後に残ったサブクエリ」にだけ足す。

**6 で「常に偽」が分かったら、そこで打ち切る。**

```rust title="core/translate/optimizer/mod.rs:1008-1016"
if let ConstantConditionEliminationResult::ImpossibleCondition =
    eliminate_constant_conditions(&mut plan.where_clause)?
{
    plan.contains_constant_false_condition = true;
    plan.estimated_output_rows = Some(0.0);
    plan.estimated_cost = Some(0.0);
    plan_correlated_subqueries(plan, resolver, &[], cache, save_subquery_plans)?;
    return Ok(None);
}
```

`TableAccessPlan` を `None` で返す。**結合順序の探索を飛ばす。** それでも `plan_correlated_subqueries` は呼ぶ — 行が 1 つも出なくても、サブクエリのプランは (資源の解放のために) 完成させておく必要がある。

**9 の `LIMIT` によるクランプが、サブクエリの呼び出し回数にも波及する。**

```rust title="core/translate/optimizer/mod.rs:1071-1082 (抜粋)"
if let Some(limit_rows) = limit_rows {
    rows = rows.min(limit_rows);
    if rows_before_limit > 0.0 {
        // These call counts cover the full result. LIMIT only
        // needs the same share of those calls.
        let call_scale = (rows / rows_before_limit).min(1.0);
        for (_, calls) in &mut subquery_calls {
            *calls *= call_scale;
        }
    }
}
```

`LIMIT 10` なら相関サブクエリも 10 回しか呼ばれない。**その回数が 10 の相関サブクエリを、10 回呼ばれる前提で最適化する。** 呼び出し回数が最適化の入力になっている。

### `find_table_access_plan` の中の 2 本道

```rust title="core/translate/optimizer/mod.rs:2339-2361 (抜粋)"
// For single-table queries, try to optimize with custom index methods directly.
// This is the fast path that preserves the original behavior.
// Skip when INDEXED BY / NOT INDEXED is specified — those force a specific btree index or table scan.
let is_single_table = table_references.joined_tables().len() == 1;
// ...
if is_single_table && !has_indexed_by_hint {
    let optimized = optimize_table_access_with_custom_modules(/* ... */)?;
    if optimized {
        return Ok(None);
    }
}
```

**1 テーブルなら DP を通らない近道がある。** 索引方式 (FTS、ベクトル) の判定を直接やって、当たれば `None` を返して終わる。

複数テーブルなら索引方式は「候補」として DP に渡される。

```rust title="core/translate/optimizer/mod.rs:2365-2367 (抜粋)"
// For multi-table queries, collect index method candidates to pass to the DP algorithm.
// This allows the optimizer to consider index methods at any position in the join order.
```

**同じ機能に対して、単一テーブル用の速い判定と、多テーブル用の候補生成の 2 実装がある。** コメントが「fast path that preserves the original behavior」と書いているとおり、後から DP に統合したときに元の経路を残した形になっている。

## 守られている不変条件

**探索はプランを書き換えない。書き戻しは `apply_*` だけがやる。** 2 つの形を比較できるのはこの分離のおかげ。

**プランを捨てるときは、その資源を `ProgramBuilder` に返す。** カーソル ID とレジスタ範囲。返し忘れると、使われないカーソルが `Program` に残る。

**同じ子サブクエリを 2 回最適化しない。** `SubqueryPlanCache` が抑える。

**`MATCH` の変換は unnest の後。** サブクエリの中身が外に出た後でないと取りこぼす。

**結合できるテーブル数は 63 まで。** `find_table_access_plan` の冒頭で弾く。

## つまずきどころ / 設計の含み

### 「パスが多いのは分かりやすさのため」と明記されている

```rust title="core/translate/optimizer/mod.rs:881-886"
/**
 * Make a few passes over the plan to optimize it.
 * TODO: these could probably be done in less passes,
 * but having them separate makes them easier to understand
 */
```

パスを 1 本にまとめれば速いが、そうしていない。**性能より読みやすさを優先した判断が、コメントで明示されている。**

読む側としては、これが「各パスが独立しているとは限らない」ことの裏返しでもある点に注意がいる。上で見たとおり、`MATCH` の変換は unnest の後でなければならず、`EXISTS` の `LIMIT` は unnest の後に残ったものにだけ効く。**順序に依存があるが、その依存は型では表されず、コメントにだけ書かれている。**

### コストモデルの定数はビルド時に切り替わる

```rust title="core/translate/optimizer/mod.rs:972-976"
#[cfg(feature = "optimizer_params")]
let params: &cost_params::CostModelParams = &cost_params::LOADED_PARAMS;
#[cfg(not(feature = "optimizer_params"))]
let params: &cost_params::CostModelParams = &cost_params::DEFAULT_PARAMS;
```

同じ 4 行が `find_table_access_plan` にもある。`optimizer_params` を有効にすると JSON から読み込んだ値になり、無効なら静的な定数になる ([該当ページ](../cost-params/))。

**フィーチャフラグで「静的定数」と「起動時ロード」を切り替える**という形は、コストモデルのチューニングを外に出しつつ、本番ビルドではゼロコストにするための定型だ。同じ `#[cfg]` が 2 箇所に複製されているのが、抽象化しきれていないことを示している。

### コストが `Option<f64>` である影響

`plan.estimated_cost` は `Option<f64>` で、2 つの形の比較はこうなっている。

```rust title="core/translate/optimizer/mod.rs:939-942"
let use_rewritten = matches!(
    (plan.estimated_cost, rewritten.estimated_cost),
    (Some(original_cost), Some(rewritten_cost)) if rewritten_cost <= original_cost
);
```

**どちらかが `None` なら、書き換えない方が採用される。** コストが出せないケース (サブクエリのコストが計算できないなど) では、常に元の形が勝つ。

これは安全側の選択だが、「コストが出せない = 元の形が良い」という根拠はない。コストモデルの穴が、そのまま最適化の穴になる。`estimated_cost` が `None` になる条件はコードを追わないと分からないので、**「なぜこのクエリは unnest されないのか」を調べるときの落とし穴**になる。

### `#[turso_macros::trace_stack]` が付いている

`optimize_select_plan` と `optimize_select_plan_with_cache` に付いている。サブクエリの入れ子でオプティマイザが再帰するので、**スタック消費を計測する対象になっている**。

[パースのページ](../parse-to-ast/) で見た `MAX_EXPR_DEPTH = 100` の理由 —「Rust の翻訳器・最適化器は 1 段あたりのスタックフレームが大きい」— が測られている場所がここだ。プランの clone (`plan.clone()`) が入るのも、深い入れ子では効いてくる。
