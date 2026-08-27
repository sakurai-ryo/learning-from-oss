---
title: "相関サブクエリを join に書き換え、両方 plan して安い方を採る"
description: "EXISTS を semi-join に、集約サブクエリを GROUP BY 付きの派生表に書き換える。だが書き換えた形が常に速いとは限らないので、元の形と書き換えた形の両方を最適化にかけて、コストを比べる。同点なら書き換えた方を採る。そしてこのモジュールのドキュメントの大半は、「書き換えると結果が変わってしまう条件」の列挙に費やされている。sum のオーバーフローや不正な JSON が、使われないキーで起きる。"
group: "クエリコンパイル"
sidebar:
  order: 23
---

## 何を学んだか

相関サブクエリは、素朴に実行すると **外側の行 1 つにつき 1 回** 内側のクエリが走る。

```sql
SELECT * FROM outer_table o
WHERE o.value < (SELECT avg(i.value) FROM inner_table i WHERE i.key = o.key)
```

外側が 10 万行なら、内側が 10 万回。**これを join に書き換えて 1 回にできれば、桁が変わる。**

MySQL も MariaDB も PostgreSQL も同じ最適化を持っている。Turso の `unnest.rs` は、それらの参照リンクを冒頭に並べたうえで、**「書き換えてはいけない条件」に紙幅の大半を使っている。**

このページの主題は、書き換えの手法そのものではなく **2 つの判断** になる。

1. **速いかどうか分からないので、両方 plan して比べる**
2. **結果が変わりうる条件を、徹底的に列挙する**

## ソースコードのどこか

### 両方の形を最適化にかける

```rust title="core/translate/optimizer/mod.rs"
    // TODO: Let join search run a correlated subquery as soon as all columns
    // that it needs are ready. It can then compare that step with the added
    // join tables in one search. Until then, both forms need their own search.
    let mut rewritten = plan.clone();
    if !unnest::rewrite_correlated_subqueries(&mut rewritten, resolver)? {
        return optimize_select_plan_form(plan, resolver, cache);
    }
```

```rust title="core/translate/optimizer/mod.rs"
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
```

[`core/translate/optimizer/mod.rs#L902-L946`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/mod.rs#L902-L946)。

**計画を丸ごと複製して、両方に対して結合順序の探索を回し、コストを比べる。**

これは高くつく。[結合順序の DP](../join-order-dp/) を 2 回やることになる。それでもやっているのは、**書き換えが常に得とは限らないから**だ。

- 外側の行が少なく、内側が巨大なら、サブクエリのままの方が安い
- 書き換えると join のテーブル数が増え、結合順序の選択肢が変わる

**「書き換えた方が速いに決まっている」と仮定できないなら、両方測るしかない。**

3 つの細部が効いている。

```rust title="core/translate/optimizer/mod.rs"
    let cost_limit = plan.estimated_cost.map(Cost);
```

**元の形のコストを、書き換えた形の探索の上限として渡している。** [結合順序の枝刈り](../join-order-dp/) の仕組みをそのまま流用して、**「どうせ負ける」と分かった時点で 2 回目の探索を打ち切る**。2 回やるコストがそこで抑えられる。

```rust title="core/translate/optimizer/mod.rs"
        if rewritten_cost <= original_cost
```

**同点なら書き換えた方を採る。** コメントの理由が明快だ。**「同じ仕事量なら、外側の行ごとにサブクエリを呼ぶ分がない方がいい」。** コストモデルは呼び出しのオーバーヘッドを完全には表現できていないので、その分を同点時の扱いで補っている。

```rust title="core/translate/optimizer/mod.rs"
    if !plan
        .non_from_clause_subqueries
        .iter()
        .any(|subquery| subquery.correlated)
    {
        return optimize_select_plan_form(plan, resolver, cache);
    }
```

**相関サブクエリが 1 つもなければ、この経路に入らない。** 大多数のクエリは複製も 2 回の探索もしない。

そして TODO には、**本来やるべきこと**が書いてある。「結合順序の探索の中で、サブクエリを実行可能になった時点のステップとして扱えば、1 回の探索で両方を比べられる」。今の実装が暫定であることを隠していない。

### 全体で正しい書き換えは、先に確定させる

```rust title="core/translate/optimizer/mod.rs"
    // The correlated form cannot run on every matched and unmatched FULL JOIN
    // row yet. A complete semi-join or anti-join rewrite can, so use it.
    let full_join_rewrite_is_complete = has_full_join
        && !rewritten
            .non_from_clause_subqueries
            .iter()
            .any(|subquery| subquery.correlated);
    if full_join_rewrite_is_complete {
```

[`core/translate/optimizer/mod.rs#L913-L932`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/mod.rs#L913-L932)。

**`FULL JOIN` がある場合、元の形はそもそも正しく実行できない。** だから書き換えが完全に成功したなら、コストを比べずにそちらを使う。

**「速い方を選ぶ」の前に「正しく動く方を選ぶ」がある。** コスト比較の経路に入れてしまうと、コストが高いという理由で動かない計画が選ばれかねない。

### 書き換えの形が 2 通りある

```rust title="core/translate/optimizer/unnest.rs"
//! This is the **group-first** form: it groups the whole inner table first and
//! then joins the groups to the outer rows. In this module, a "key" means one
//! distinct value of the column that links the two queries (`i.key` above).
//! Group-first:
//!
//! - computes the aggregate for each key once, even when many outer rows ask
//!   for the same key;
//! - also computes the aggregate for keys that no outer row asks for; and
//! - is used for `avg`, `count`, `min`, `max`, and `total` when their inputs,
//!   aggregate `FILTER` expressions, and inner `WHERE` expressions cannot fail.
```

[`core/translate/optimizer/unnest.rs#L26-L36`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/unnest.rs)。

**group-first** は、内側のテーブルを先に丸ごと集約して、その結果を外側に join する。同じキーを複数の外側の行が求めても 1 回で済む。

だが 2 番目の性質が危ない。

```rust title="core/translate/optimizer/unnest.rs"
//! The second point is the dangerous one. The original subquery only reads the
//! keys that outer rows ask for. Group-first reads every key, so it can hit an
//! error that the original query never hits. For example:
//!
//! - `sum` can overflow for unused key 99 when its values are
//!   `9223372036854775807` and `1`, although no outer row asks for 99;
//! - `group_concat` or `string_agg` can build an unused string larger than the
//!   largest SQL value that Turso allows; and
//! - `avg(json_extract(value, '$'))` can read invalid JSON for an unused key.
```

**元のクエリはエラーにならないのに、書き換えた形はエラーになる。**

3 つの例が具体的だ。誰も要求していないキー 99 の `sum` がオーバーフローする。誰も見ない `group_concat` が長さの上限を超える。誰も読まない行の JSON が壊れている。

**最適化は「速くする」だけでなく「同じ結果を返す」ことも要求される。** そしてこの場合、返す値は同じでも **エラーになるかどうかが変わる**。

だから 2 つ目の形がある。

````rust title="core/translate/optimizer/unnest.rs"
//! When group-first is unsafe, a direct `WHERE` comparison can instead use the
//! **join-first** form: it joins each outer row to its matching inner rows
//! first and then groups the joined rows back into one group per outer row.
//!
//! ```sql
//! -- After
//! SELECT o.id
//! FROM outer_table o
//! LEFT JOIN inner_table i ON i.key = o.key
//! GROUP BY o.rowid
//! HAVING o.limit > sum(i.value) FILTER (WHERE i.rowid IS NOT NULL)
//! ```
````

**join-first は、先に join してから外側の行ごとに集約し直す。** join が拾うのは「どれかの外側の行が要求したキー」だけなので、使われないキーの集約が起きない。

`FILTER (WHERE i.rowid IS NOT NULL)` の説明も丁寧だ。

```rust title="core/translate/optimizer/unnest.rs"
//! The `i.rowid`
//! filter keeps the NULL-filled row that a left join makes when no inner row
//! matches out of the aggregate. Without it, `sum(1)` would read that row and
//! return 1, while the original subquery returns NULL when nothing matches.
```

**LEFT JOIN が作る NULL 行を集約から除く。** これがないと、一致する行がないときに元のクエリは NULL を返すのに、書き換えた形は 1 を返す。

### 使えない条件が 6 つ列挙されている

```rust title="core/translate/optimizer/unnest.rs"
//! Join-first is not used for every aggregate subquery:
//!
//! - Group-first does less work when several outer rows ask for the same key,
//!   because join-first computes the aggregate again for each of those rows.
//! - Join-first needs one outer B-tree table with a rowid so that
//!   `GROUP BY o.rowid` makes exactly one group for each outer row.
//! - It needs one inner B-tree table with a rowid, because `i.rowid IS NOT
//!   NULL` is how it recognizes the NULL-filled row made by a left join with
//!   no match.
//! - The current code moves only one direct `WHERE` comparison to `HAVING`. ...
//! - The join makes each outer row appear once for each matching inner row,
//!   and the other `WHERE` terms then run once per copy instead of once per
//!   outer row. A term such as `random() % 2 = 0` could accept some copies and
//!   reject others, so the aggregate would see only some of the row's inner
//!   rows. Join-first is skipped when another `WHERE` term calls a
//!   nondeterministic function or reads a correlated subquery.
//! - Join-first must group by `o.rowid` to keep outer rows separate. An existing
//!   `GROUP BY o.key` may instead combine several outer rows. ...
```

5 番目が特に良い。**`random() % 2 = 0` のような非決定的な述語があると、join で複製された行のうち一部だけが通る。** 集約が見る行の集合が変わってしまう。

これは、**「述語が評価される回数が変わる」という副作用**だ。決定的な述語なら結果は同じだが、非決定的だと違う。**書き換えの正しさが、述語の性質に依存している。**

そして最後の 2 つは、**「実装していない」を正直に書いている**。

```rust title="core/translate/optimizer/unnest.rs"
//! Outer aggregates, `DISTINCT`, window
//! functions, `ORDER BY`, `LIMIT`, and `OFFSET` also need separate rules
//! around the new group. Those rules are not implemented.
```

```rust title="core/translate/optimizer/unnest.rs"
//! - Extension aggregates stay as subqueries. With no matching inner row,
//!   `count` returns 0 and `sum` returns NULL. An extension aggregate may return
//!   something else, and this code does not know which value to use.
```

**拡張の集約関数は書き換えない。「一致する行がないときに何を返すか、このコードは知らない」。** 組み込みの集約なら仕様として分かっているが、[利用者が足した集約](../index-method/) については分からない。

**知らないことを、知らないと言って諦めている。**

### `NOT IN` は触らない

```rust title="core/translate/optimizer/unnest.rs"
//! The code only moves direct `=` checks between an inner and outer column. Other
//! forms stay as subqueries. `NOT IN` also stays as a subquery because NULL values
//! can change its result. A one-value subquery stays as it is unless its result for
//! an empty input is known.
```

**`NOT IN` は NULL の三値論理で結果が変わるので、書き換えない。**

`x NOT IN (SELECT y FROM t)` は、`t` に NULL が 1 つでもあると全体が NULL (偽でも真でもない) になる。anti-join に書き換えると、この振る舞いが再現できない。

**SQL の最適化で最も事故が多いのが NULL の扱いで、それを「触らない」で回避している。**

### 参照文献が 9 本

```rust title="core/translate/optimizer/unnest.rs"
//! References:
//! - SQLite subquery results: https://sqlite.org/lang_expr.html#subquery_expressions
//! - PostgreSQL subquery results: https://www.postgresql.org/docs/current/functions-subquery.html
//! - MySQL semi-joins: https://dev.mysql.com/doc/refman/8.4/en/semijoins-antijoins.html
//! - MySQL scalar decorrelation: https://dev.mysql.com/doc/refman/8.4/en/correlated-subqueries.html
//! - MySQL optimizer switches: https://dev.mysql.com/doc/refman/8.0/en/switchable-optimizations.html
//! - MariaDB semi-joins: ...
//! - MariaDB materialization: ...
//! - MariaDB subquery cache: ...
//! - Neumann and Kemper, Unnesting Arbitrary Queries: https://db.cs.tum.edu/teaching/ws2122/foundationsde/unnesting.pdf
//! - Neumann, A Formalization of Top-Down Unnesting: https://arxiv.org/abs/2412.04294
```

**他の RDBMS のマニュアルが 6 本、論文が 2 本。** SQLite と PostgreSQL のリンクは「サブクエリが何を返すべきか」の仕様で、MySQL と MariaDB のリンクは「同じ最適化を先行してやっている実装」だ。

**この最適化は、正しさの仕様と実装の前例の両方を参照しないと書けない。** その両方を並べている。

## なぜそうなっているか

- **両方の形を plan して比べるのは、書き換えが常に速いとは限らないから。** 外側が小さく内側が大きいと、サブクエリのままの方が安い。仮定できないなら測る。
- **元の形のコストを上限に渡すのは、2 回目の探索を打ち切るため。** 既にある枝刈りの仕組みを流用するだけで、追加コストが抑えられる。
- **同点なら書き換えを採るのは、コストモデルが呼び出しのオーバーヘッドを表現していないから。** モデルの不足を、同点時の規則で補っている。
- **相関サブクエリがなければこの経路に入らないのは、複製と 2 回の探索が高いから。** 大多数のクエリには関係ない。
- **`FULL JOIN` の場合にコスト比較をしないのは、元の形が実行できないから。** 「速い方」を選ぶ前に「動く方」がある。
- **group-first と join-first の 2 形態があるのは、片方が新しいエラーを起こしうるから。** 使われないキーの集約は、元のクエリが決して踏まないエラーを踏む。
- **非決定的な述語があると書き換えないのは、述語の評価回数が変わるから。** join で行が複製されると、`random()` の結果が行ごとに変わる。
- **`NOT IN` を触らないのは、NULL の三値論理を再現できないから。** 「難しいのでやらない」で正しさが守れるなら、それが正しい。
- **拡張の集約を書き換えないのは、空入力の結果を知らないから。** 組み込みなら仕様がある。外部のものについては分からない。
- **他の RDBMS のマニュアルを参照しているのは、同じ罠を先に踏んでいるから。** この最適化には既知の落とし穴が多く、独力で全部見つけるより読む方が速い。

## どう活かすか

- **「書き換えた方が速いはず」を仮定できないなら、両方作って測る。** 変換の前後でコストが逆転する条件があるなら、静的に決め打ちしてはいけない。
- **2 回目の探索には、1 回目の結果を上限として渡す。** 「どうせ負ける」と分かった時点で打ち切れる。両方測るコストが実質下がる。
- **同点時の規則で、コストモデルの不足を補う。** モデルが表現していないオーバーヘッドがあるなら、タイブレークで反映する。
- **高い経路には、入る前に安い判定を置く。** 「そもそも該当する構造があるか」を先に見れば、大多数のケースは通らない。
- **「速い方」の判断の前に「正しく動く方」の判断を置く。** 一方しか実行できない状況では、コスト比較に持ち込まない。
- **変換の正しさは、「同じ値を返すか」だけでなく「同じエラーを出すか」でも確かめる。** 読む行が増える変換は、元のクエリが踏まないエラーを踏む。
- **変換が使えない条件は、番号を振って列挙する。** 「これは危ないので気をつける」ではなく、条件を全部書き出す。実装していないものは「未実装」と書く。
- **外部から差された拡張は、変換の対象から外す。** 組み込みの関数なら仕様が分かるが、拡張の振る舞いは分からない。分からないものは触らない。
- **NULL が絡む論理は、変換しない選択を積極的に取る。** 三値論理の再現は難しく、間違えると結果が静かに変わる。
- **先行実装のマニュアルを参照に並べる。** 同じ最適化を先にやった実装は、同じ罠を先に踏んでいる。リンクを残せば、次の人が読める。
