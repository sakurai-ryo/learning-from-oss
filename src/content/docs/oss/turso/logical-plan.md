---
title: "`SelectPlan` という 1 つの構造体に、SELECT の全部が乗る"
description: "Turso の主経路にはプランの演算子ツリーがない。SELECT 1 本は `SelectPlan` という平らな構造体 1 個で表され、テーブルの並びは `Vec`、WHERE 句は AND で割った `Vec<WhereTerm>`、アクセス方式は各テーブルの `op` フィールドになる。最適化はこの構造体をその場で書き換える。演算子 DAG は別にあるが、それはマテリアライズドビュー専用だ。"
group: "SQL からバイトコードへ"
sidebar:
  order: 9
---

## この層の責務

AST は「ユーザが書いた形」を保存している。`FROM a JOIN b ON ...` と `FROM b JOIN a ON ...` は別物として表現される。

プランは「エンジンが実行する形」を表す。ここで初めて、テーブルの読む順番、各テーブルの読み方 (全走査か索引探索か)、各条件を評価する場所が決まる。

Turso のプラン表現には、教科書的な RDB と違う特徴がある。

**演算子ツリーがない。** `Scan` の上に `Filter` があり、その上に `Join` があり…という木構造を作らない。SELECT 1 本は `SelectPlan` という**平らな構造体 1 個**で表される。

## 主要な型とその関係

### `Plan` は 5 バリアント

```rust title="core/translate/plan.rs:384-398"
pub enum Plan {
    Select(Box<SelectPlan>),
    CompoundSelect {
        left: Vec<(SelectPlan, ast::CompoundOperator)>,
        right_most: Box<SelectPlan>,
        limit: Option<Box<Expr>>,
        offset: Option<Box<Expr>>,
        /// ORDER BY for compound selects, or `None` when the query has none.
        order_by: Option<Vec<CompoundOrderByKey>>,
    },
    /// Runs the initial query once, then runs the recursive query for each queued row.
    RecursiveCte(Box<RecursiveCtePlan>),
    Delete(Box<DeletePlan>),
    Update(Box<UpdatePlan>),
}
```

`UNION` は「`SelectPlan` の並び」であって、`Union` 演算子ノードではない。`INSERT` がここにないのは、`INSERT` が独自の翻訳経路 (`translate/insert.rs`) を持つからだ。

### `SelectPlan` は 20 以上のフィールドを持つ平らな構造体

```rust title="core/translate/plan.rs:751-778 (抜粋)"
pub struct SelectPlan {
    pub table_references: TableReferences,
    /// The order in which the tables are joined. Tables have usize Ids (their index in joined_tables)
    pub join_order: Vec<JoinOrderMember>,
    /// the columns inside SELECT ... FROM
    pub result_columns: Vec<ResultSetColumn>,
    /// where clause split into a vec at 'AND' boundaries. all join conditions also get shoved in here,
    /// and we keep track of which join they came from (mainly for OUTER JOIN processing)
    pub where_clause: Vec<WhereTerm>,
    pub group_by: Option<GroupBy>,
    pub order_by: Vec<(Box<ast::Expr>, SortOrder, Option<ast::NullsOrder>)>,
    pub aggregates: Vec<Aggregate>,
    pub limit: Option<Box<Expr>>,
    pub offset: Option<Box<Expr>>,
    pub contains_constant_false_condition: bool,
    /// the destination of the resulting rows from this plan.
    pub query_destination: QueryDestination,
    pub distinctness: Distinctness,
    pub values: Vec<Vec<Expr>>,
    pub window: Option<Window>,
    pub non_from_clause_subqueries: Vec<NonFromClauseSubquery>,
    // ...
}
```

SQL の各句がそのままフィールドになっている。**`SELECT` 文の構文が、ほぼ 1 対 1 で構造体に写されている。**

これは意図的な設計だ。SQLite の VDBE が吐く命令列は「1 つの入れ子ループ」の形をしていて、演算子ごとにイテレータを積み上げる形ではない。**出力の形が入れ子ループなら、入力の表現も入れ子ループを直接記述するほうが素直**になる。

### 3 つの `Vec` が実行の形を決める

**`table_references.joined_tables` — 誰を読むか。** SQL に書かれた順で並ぶ。

**`join_order: Vec<JoinOrderMember>` — どの順に読むか。** `joined_tables` への添字の並べ替えだ。オプティマイザが書き換えるのはこの `Vec` で、`joined_tables` 自体は動かない。

**`where_clause: Vec<WhereTerm>` — 何で絞るか。** AND で分割されている。

```rust title="core/translate/plan.rs:757-759"
/// where clause split into a vec at 'AND' boundaries. all join conditions also get shoved in here,
/// and we keep track of which join they came from (mainly for OUTER JOIN processing)
pub where_clause: Vec<WhereTerm>,
```

`ON` 句の条件も `WHERE` 句と同じ `Vec` に放り込まれる。区別は `WhereTerm` の中のフラグで持つ。

### `WhereTerm` は「どこで評価するか」を後から計算する

```rust title="core/translate/plan.rs:198-224 (抜粋)"
pub struct WhereTerm {
    /// The original condition expression.
    pub expr: ast::Expr,
    /// ...
    /// We track this requirement using [WhereTerm::from_outer_join], which contains the [TableInternalId] of the
    /// right-side table of the OUTER JOIN (in this case, s).
    pub from_outer_join: Option<TableInternalId>,
    /// Whether the condition has been consumed by the optimizer in some way, and it should not be evaluated
    /// in the normal place where WHERE terms are evaluated.
    pub consumed: bool,
}
```

3 フィールドしかない。だが `should_eval_at_loop(loop_idx, ...)` という問い合わせに答えられる。

```rust title="core/translate/plan.rs:283-292 (抜粋)"
/// The loop index where to evaluate the condition.
/// For example, in `SELECT * FROM u JOIN p WHERE u.id = 5`, the condition can already be evaluated at the first loop (idx 0),
/// because that is the rightmost table that it references.
pub enum EvalAt {
    Loop(usize),
    BeforeLoop,
}
```

**評価位置は保存されず、必要になるたびに計算される。** 式が参照するテーブルのうち、`join_order` で最も後ろに来るものを探す。それが「この条件を評価できる最も早いループ」になる。

`join_order` を変えれば評価位置も自動的に追従する。**オプティマイザは条件の配置を明示的に更新する必要がない。** 結合順序と条件配置の整合を保つ手間が、この設計で消えている。

`from_outer_join` はその規則の例外を表す。`LEFT JOIN s ON t.a = 2` の条件は `t` しか参照しないが、`t` のループで評価して行を捨ててはいけない。捨てると `s` の列を NULL で埋めた行が出なくなる。だから**強制的に `s` のループまで遅らせる**。

`consumed` は「オプティマイザがこの条件を別の形に変換したので、通常の場所では評価しない」という印だ。索引探索のシークキーに変換された条件がこれになる。

### `Operation` がテーブルごとのアクセス方式

```rust title="core/translate/plan.rs:2314-2332"
pub enum Operation {
    // Scan operation
    Scan(Scan),
    // Search operation
    // This operation is used to search for a row in a table using an index
    Search(Search),
    // Access through custom index method query
    IndexMethodQuery(IndexMethodQuery),
    // Hash join operation
    // This operation is used on the probe side of a hash join.
    HashJoin(HashJoinOp),
    // Multi-index scan operation for OR-by-union optimization.
    MultiIndexScan(MultiIndexScanOp),
}
```

**アクセス方式が「テーブルのフィールド」になっている。** 演算子ツリーなら `IndexScan` ノードと `SeqScan` ノードが別々にあるところを、`JoinedTable.op` の値の違いで表す。

初期値は必ず全走査だ。

```rust title="core/translate/plan.rs:2336-2341 (抜粋)"
pub fn default_scan_for(table: &Table) -> Self {
    match table {
        Table::BTree(_) => Operation::Scan(Scan::BTreeTable {
            iter_dir: IterationDirection::Forwards,
            index: None,
        }),
```

プランナは全部 `Scan` で組み立て、オプティマイザが `Search` や `HashJoin` に**書き換える**。プランを作り直すのではなく、その場で差し替える。

### `QueryDestination` — 結果をどこに書くか

```rust title="core/translate/plan.rs:578-640 (抜粋)"
pub enum QueryDestination {
    /// The results of the query are returned to the caller.
    ResultRows,
    /// The results of the query are yielded to a parent query via coroutine.
    CoroutineYield { yield_reg: usize, coroutine_implementation_start: BranchOffset },
    /// The results of the query are stored in an ephemeral index,
    EphemeralIndex { cursor_id: CursorID, index: Arc<Index>, /* ... */ },
    /// The results of the query are stored in an ephemeral table,
    EphemeralTable { cursor_id: CursorID, table: Arc<BTreeTable>, /* ... */ },
    /// Insert rows produced by a recursive CTE into its work queue.
    RecursiveCteQueue { /* ... */ },
    /// The result of an EXISTS subquery are stored in a single register.
    ExistsSubqueryResult { result_reg: usize },
    /// The results of a subquery that is neither 'EXISTS' nor 'IN' are stored in a range of registers.
    RowValueSubqueryResult { result_reg_start: usize, num_regs: usize },
    /// The results of the query are stored in a RowSet (for DELETE operations with triggers).
    RowSet { rowset_reg: usize },
    /// Decision made at some point after query plan construction.
    Unset,
}
```

**サブクエリは「行き先が違う `SelectPlan`」として表現される。** 演算子ツリーなら親ノードが子の出力を受け取るところを、子が「どこに書け」を持つ形にしている。

そしてこの enum には**レジスタ番号やカーソル ID が入っている**。`yield_reg: usize`、`cursor_id: CursorID`、`result_reg_start: usize`。これらは本来コード生成の産物のはずだが、プランの構造体に載っている。

**プランと生成コードの境界が完全には分かれていない。** 平らな構造体で表現する代償がここに出ている。`Unset` というバリアントがあるのも同じ理由で、「後で決める」という状態をプランが持たざるを得ない。

## 処理の流れ (コードを追う)

### 結合できるテーブルは 63 個まで

```rust title="core/translate/plan.rs:1323-1327"
/// The maximum number of tables that can be joined together in a query.
/// This limit is arbitrary, although we currently use a u128 to represent the [crate::translate::planner::TableMask],
/// which can represent up to 128 tables.
/// Even at 63 tables we currently cannot handle the optimization performantly, hence the arbitrary cap.
pub const MAX_JOINED_TABLES: usize = 63;
```

テーブルの集合を `u128` のビットマスクで表している。「この条件はどのテーブルを参照しているか」「この結合順序でどこまで読んだか」が、全部ビット演算になる。

上限が 128 ではなく 63 なのは、**結合順序の探索が指数的だから**だ。動的計画法でも 63 テーブルは現実的でない ([結合順序のページ](../join-order-dp/))。

### 外側スコープへの参照は別の `Vec` に分けられる

```rust title="core/translate/plan.rs:1306-1314"
pub struct TableReferences {
    /// Tables that are joined together in this query scope.
    joined_tables: Vec<JoinedTable>,
    /// Tables from outer scopes that are referenced in this query scope.
    outer_query_refs: Vec<OuterQueryReference>,
    /// Set when a RIGHT JOIN is rewritten as LEFT JOIN by swapping the two tables,
    /// so `select_star` emits columns in the original user-visible order.
    right_join_swapped: bool,
}
```

相関サブクエリが外側のテーブルを参照していたら、その参照は `outer_query_refs` に入る。`joined_tables` には入らないので、**このサブクエリの結合順序探索の対象にならない**。

`is_correlated()` はこの `Vec` を見て判定する。

```rust title="core/translate/plan.rs:815-823 (抜粋)"
pub fn is_correlated(&self) -> bool {
    self.table_references
        .outer_query_refs()
        .iter()
        .any(|t| t.is_used())
        || self.non_from_clause_subqueries.iter().any(|s| s.correlated)
        // ...
}
```

相関の有無はサブクエリの unnest 可否を決めるので ([該当ページ](../subquery-unnest/))、この分離が最適化の入口になっている。

### `RIGHT JOIN` はプランに残らない

`right_join_swapped: bool` の存在が示すとおり、`RIGHT JOIN` は**左右を入れ替えて `LEFT JOIN` に書き換えられる**。実行系には `LEFT JOIN` しかない。

ただし `SELECT *` の列順はユーザが書いた順でなければならないので、入れ替えたという事実だけをフラグで覚えておく。**書き換えは意味論を保つが、出力の見た目を壊す**ので、その分だけ痕跡を残している。

### コスト見積もりがプランに書き戻される

```rust title="core/translate/plan.rs:785-794 (抜粋)"
/// Estimated number of times this SELECT will be invoked by its parent scope.
pub input_cardinality_hint: Option<f64>,
/// Estimated output rows from the optimizer's join order computation.
pub estimated_output_rows: Option<f64>,
/// Estimated work for this query after its table reads are chosen.
/// Parent queries use this when they compare a subquery with a join.
pub(crate) estimated_cost: Option<f64>,
```

サブクエリを最適化した結果のコストが、そのサブクエリの `SelectPlan` に保存される。親はそれを読んで、「サブクエリのまま実行する」か「join に展開する」かを比べる。

`Option<f64>` なのは、**最適化前は値がない**からだ。プランの構造体が、最適化の途中経過を保持する場所を兼ねている。

## 守られている不変条件

**`joined_tables` は動かない。順序は `join_order` で表す。** `Expr::Column` が `TableInternalId` でテーブルを指しているので、`Vec` の並びを変えると参照が壊れる。

**条件の評価位置は保存しない。毎回計算する。** `join_order` の変更に自動追従させるため。

**`consumed` が立った条件は通常の場所で評価しない。** 索引のシークキーに変換された条件を二重に評価すると、正しいが無駄。逆に消し忘れると結果が変わる場合がある (`NULL` の扱いなど)。

**外側スコープへの参照は `joined_tables` に入れない。** 結合順序の探索対象と、単なる参照を分けるため。

**`RIGHT JOIN` は必ず `LEFT JOIN` に書き換えられる。** ただし `right_join_swapped` で痕跡を残す。

## つまずきどころ / 設計の含み

### 演算子 DAG は存在する。ただしマテビュー専用

`core/translate/logical.rs` に 4,198 行の別のプラン表現がある。

```rust title="core/translate/logical.rs:1-8"
//! Logical plan representation for SQL queries
//!
//! This module provides a platform-independent intermediate representation
//! for SQL queries. The logical plan is a DAG (Directed Acyclic Graph) that
//! supports CTEs and can be used for query optimization before being compiled
//! to an execution plan (e.g., DBSP circuits).
//!
//! The main entry point is `LogicalPlanBuilder` which constructs logical plans
```

こちらは本物の DAG だ。だが利用者を辿ると、**マテリアライズドビューの経路しか使っていない**。

```console
$ grep -rn "logical::" core/ --include='*.rs' | grep -v "^core/translate/logical.rs"
core/incremental/view.rs:9:use crate::translate::logical::LogicalPlanBuilder;
core/incremental/compiler.rs:21:use crate::translate::logical::{
core/incremental/compiler.rs:1544:    fn compile_union(&mut self, union: &crate::translate::logical::Union) -> Result<i64> {
core/incremental/compiler.rs:2297:    use crate::translate::logical::{ColumnInfo, LogicalPlanBuilder, LogicalSchema};
```

**なぜ 2 つあるのか。** 出力先が違うからだ。通常のクエリは VDBE のバイトコード (入れ子ループ) に落ちるが、マテビューは DBSP の演算子回路に落ちる ([該当ページ](../incremental-views/))。回路は演算子のグラフなので、入力も演算子のグラフである方が自然になる。

読む側への含みは明確だ。**`SelectPlan` と `LogicalPlan` を混同しない。** ファイル名 (`plan.rs` と `logical.rs`) からは区別しにくい。`translate/optimizer/` が触るのは `SelectPlan` の方だけだ。

### プランがレジスタ番号を持っている

`QueryDestination::CoroutineYield { yield_reg: usize, ... }` のように、プランの中にコード生成の産物が入る。

これは「プラン → コード生成」が 1 パスで、しかも**サブクエリのコード生成が先に走る**からだ。親のプランを完成させる時点で、子のコルーチンはすでに命令列として存在しており、その入口アドレスとレジスタ番号が分かっている。

代償は、**プランが単体で意味を持たなくなる**ことだ。`SelectPlan` を `Debug` で出力しても、`yield_reg: 42` が何を指すかは `ProgramBuilder` を見ないと分からない。プランをシリアライズしてキャッシュする、といった拡張は難しい。

### `values: Vec<Vec<Expr>>` が `SelectPlan` にいる

`VALUES (1,2),(3,4)` は文法上 `SELECT` の一種なので、`SelectPlan` のフィールドとして表現されている。`table_references` が空で `values` が埋まっていれば VALUES 句、という判別になる。

平らな構造体で全部を表す設計では、**バリアントで分けるべきものがフィールドの有無で表される**ことが避けられない。`window: Option<Window>`、`group_by: Option<GroupBy>`、`simple_aggregate: Option<SimpleAggregate>` も同じ形で、「どのフィールドが `Some` かの組み合わせ」が実質的なプランの種類になっている。

読むときは、**フィールドの組み合わせにどんな制約があるかがコードのどこにも書かれていない**ことに注意がいる。`values` が空でないときに `group_by` があり得るか、といった問いに、型は答えてくれない。
