---
title: "マテビューを「入力の差分に対する演算子グラフ」として持つ"
description: "CREATE MATERIALIZED VIEW を、ビューの定義から演算子の DAG にコンパイルする。テーブルへの書き込みは (行, 重み) の組の集合として DAG に流れ、各演算子が自分の状態を更新しながら出力の差分を返す。DBSP という理論をほぼそのまま実装していて、集合の要素にどこまでを含めるかで 80 時間以上溶かしたというコメントが残っている。演算子の状態は B-tree に永続化されるので、当然そこも状態機械になる。"
group: "エンジンの拡張点"
sidebar:
  order: 26
---

## 何を学んだか

MySQL にマテリアライズドビューはない。PostgreSQL にはあるが、更新は `REFRESH MATERIALIZED VIEW` で **全件作り直す**。

Turso は違う道を選んだ。**元のテーブルへの変更を差分として受け取り、ビューの差分だけを計算する。**

理論的な下敷きは DBSP (differential dataflow の系譜) で、考え方はこうなる。

- データの集合を **(行, 重み)** の組で表す。重みが +1 なら存在、−1 なら削除
- クエリの各段 (フィルタ、射影、結合、集約) を、**差分を受け取って差分を返す演算子**にする
- 演算子を繋いだ DAG に、テーブルの変更を流す

`INSERT` は重み +1 の差分、`DELETE` は −1、`UPDATE` は **−1 と +1 の組**になる。

**これが「in-process の SQLite 互換 DB」に載っているのは、かなり異例だ。** そして実装の中に、理論をコードに落とすときの落とし穴が生々しく残っている。

## ソースコードのどこか

### 集合の「キー」に何を含めるか

このモジュールで最も価値のあるコメントが、これになる。

```rust title="core/incremental/dbsp.rs"
// The DBSP paper uses as a key the whole record, with both the row key and the values.  This is a
// bit confuses for us in databases, because when you say "key", it is easy to understand that as
// being the row key.
//
// Empirically speaking, using row keys as the ZSet keys will waste a competent but not brilliant
// engineer around 82 and 88 hours, depending on how you count. Hours that are never coming back.
//
// One of the situations in which using row keys completely breaks are table updates. If the "key"
// is the row key, let's say "5", then an update is a delete + insert. Imagine a table that had k =
// 5, v = 5, and a view that filters v > 2.
//
// Now we will do an update that changes v => 1. If the "key" is 5, then inside the Delta set, we
// will have (5, weight = -1), (5, weight = +1), and the whole thing just disappears. The Delta
// set, therefore, has to contain ((5, 5), weight = -1), ((5, 1), weight = +1).
```

[`core/incremental/dbsp.rs#L122-L135`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/dbsp.rs)。

**「論文は行キーと値の両方を含めた『レコード全体』をキーにしている。DB の人間には紛らわしい。行キーだと解釈すると、そこそこ優秀なエンジニアの 82〜88 時間が消える。」**

具体例が的確だ。`v` を 5 から 1 に更新すると、行キーだけをキーにした場合 `(5, -1)` と `(5, +1)` になり、**足すと 0 になって消える**。だが `v > 2` というフィルタから見れば、この行は消えなければならない。

正しくは `((5,5), -1)` と `((5,1), +1)` で、**値まで含めて初めて「何が消えて何が増えたか」が表せる。**

そして結論はこうなる。

```rust title="core/incremental/dbsp.rs"
// It is theoretically possible to use the rowkey in the ZSet and then use a hash of key ->
// Vec(changes) in the Delta set. But deviating from the paper here is just asking for trouble, as
// I am sure it would break somewhere else.
```

**「論文から外れるのはトラブルを招く。他のどこかで必ず壊れる。」**

理論を実装するときの原則が、実体験つきで書かれている。**「ここは自分たちの都合に合わせて変えられそうだ」と思う箇所は、たいてい理論がそうしている理由がある。**

### 差分は順序つきのリスト

```rust title="core/incremental/dbsp.rs"
type DeltaEntry = (HashableRow, isize);
/// A delta represents ordered changes to data
#[derive(Debug, Clone, Default)]
pub struct Delta {
    /// Ordered list of changes: (row, weight) where weight is +1 for insert, -1 for delete
    /// It is crucial that this is ordered. Imagine the case of an update, which becomes a delete +
    /// insert. If this is not ordered, it would be applied in arbitrary order and break the view.
    pub changes: Vec<DeltaEntry>,
}
```

[`core/incremental/dbsp.rs#L198-L207`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/dbsp.rs)。

**「順序が保たれることが決定的に重要」。** 更新は削除 + 挿入なので、順序が入れ替わると挿入してから削除することになる。

理論上は Z-set (集合) なので順序は関係ないはずだが、**実装では中間状態を持つ演算子があるので、適用順が意味を持つ。**

その代わり、まとめる操作は別にある。

```rust title="core/incremental/dbsp.rs"
        // Use a HashMap to accumulate weights
        ...
        for (row, weight) in self.changes.drain(..) {
            *consolidated.entry(row).or_insert(0) += weight;
        }

        // Convert back to vec, filtering out zero weights
        ...
            .filter(|(_, weight)| *weight != 0)
```

[`core/incremental/dbsp.rs#L248-L258`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/dbsp.rs)。

**同じ行の重みを足して、0 になったものを落とす。** 「入れてすぐ消した」は何も起きなかったことになる。

Z-set の側も同じ規則を持っている。

```rust title="core/incremental/dbsp.rs"
    pub fn insert(&mut self, item: T, weight: isize) {
        let new_weight = current + weight;
        if new_weight == 0 {
            ...
            self.data.insert(item, new_weight);
```

[`core/incremental/dbsp.rs#L312-L318`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/dbsp.rs)。

**重み 0 の要素は保持しない。** これを守らないと、削除された行の痕跡が残り続けてメモリが増える。

### 行のハッシュを事前計算する

```rust title="core/incremental/dbsp.rs"
pub struct HashableRow {
    pub rowid: i64,
    pub values: Vec<Value>,
    // Pre-computed hash: DBSP rows are immutable and frequently hashed during joins,
    // making caching worthwhile despite the memory overhead
    cached_hash: Hash128,
}
```

[`core/incremental/dbsp.rs#L140-L147`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/dbsp.rs)。

**行は不変で、結合のたびにハッシュされる。だからキャッシュする。**

「メモリのオーバーヘッドはあるが、それに見合う」と明記されている。**トレードオフを認識したうえで選んでいる**ことが読み取れる。

`Ord` の実装にも注意書きがある。

```rust title="core/incremental/dbsp.rs"
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // First compare by rowid, then by values if rowids are equal
        // This ensures Ord is consistent with Eq (which compares all fields)
        match self.rowid.cmp(&other.rowid) {
```

[`core/incremental/dbsp.rs#L188-L192`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/dbsp.rs)。

**`Ord` と `Eq` の整合性。** `rowid` だけで比較すると、`Eq` が false なのに `Ord` が `Equal` を返す。`BTreeMap` に入れた瞬間に壊れる。

一方 `Hash` は `cached_hash` だけを見る。**`Hash` は「等しいものが同じ値になる」だけが要求で、値が全部一致すればハッシュも一致するので整合する。**

### 演算子のインタフェース

```rust title="core/incremental/operator.rs"
pub trait IncrementalOperator: Debug + Send {
    /// Evaluate the operator with a state, without modifying internal state
    /// This is used during query execution to compute results
    /// May need to read from storage to get current state (e.g., for aggregates)
    fn eval(
        &mut self,
        state: &mut EvalState,
        cursors: &mut DbspStateCursors,
    ) -> Result<IOResult<Delta>>;

    /// Commit deltas to the operator's internal state and return the output
    /// This is called when a transaction commits, making changes permanent
    /// Returns the output delta (what downstream operators should see)
    fn commit(
        &mut self,
        deltas: DeltaPair,
        cursors: &mut DbspStateCursors,
    ) -> Result<IOResult<Delta>>;
```

[`core/incremental/operator.rs#L206-L231`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/operator.rs#L206-L231)。

**`eval` と `commit` に分かれている。**

- `eval` — 内部状態を変えずに、結果だけを計算する。トランザクションの中で「今のビューはどう見えるか」を答える
- `commit` — 内部状態を更新して、下流に流す差分を返す

これが必要なのは、**トランザクションが中断されうるから**だ。未コミットの変更をビューに反映したうえで読めなければならないが、ロールバックされたら消えなければならない。

そして両方が `Result<IOResult<Delta>>` を返している。**演算子の状態はディスクにあるので、[I/O で中断しうる](../io-result/)。** 集約の途中経過を読むのに B-tree のシークが要る。

`cursors: &mut DbspStateCursors` を引数で受け取っているのも同じ事情で、**演算子が自分で pager を持たない**。呼び出し側がカーソルを用意して渡す。

### 演算子の状態は、普通のテーブルに入る

```rust title="core/incremental/persistence.rs"
                        // The blob is in column 3: operator_id, zset_id, element_id, value, weight
                        let blob = r.get_value(3)?.to_owned()?;
```

[`core/incremental/persistence.rs#L40-L41`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/persistence.rs#L40-L41)。

**`(演算子 ID, zset ID, 要素 ID, 値, 重み)` という 5 列のレコード**として、B-tree に保存される。

集約の中間状態 (`SUM` の途中の値、`COUNT` の個数) が、こういう形でディスクに載る。**再起動してもビューが有効なままでいられるのは、これがあるからだ。**

読み出しも当然 [状態機械](../reentrancy/) になる。

```rust title="core/incremental/persistence.rs"
pub enum ReadRecord {
    #[default]
    GetRecord,
    Done {
        state: Box<Option<AggregateState>>,
    },
}
```

[`core/incremental/persistence.rs#L7-L14`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/persistence.rs#L7-L14)。

`DISTINCT` のときに値が NULL で重みだけを持つ、という扱いも書いてある。**「何個あるか」だけが要る場合、値を保存する必要がない。**

### ビューの初期化も状態機械

```rust title="core/incremental/view.rs"
/// State machine for populating a view from its source table
pub enum PopulateState {
    /// Initial state - need to prepare the query
    Start,
    /// All tables that need to be populated
    ProcessingAllTables {
        queries: Vec<String>,
        current_idx: usize,
    },
    /// Actively processing rows from the query
    ProcessingOneTable {
        queries: Vec<String>,
        current_idx: usize,
        stmt: Box<Statement>,
        rows_processed: usize,
        /// If we're in the middle of processing a row (merge_delta returned I/O)
        pending_row: Option<(i64, Vec<Value>)>, // (rowid, values)
    },
    /// Population complete
    Done,
}
```

[`core/incremental/view.rs#L23-L41`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/view.rs#L23-L41)。

**`CREATE MATERIALIZED VIEW` は、既存の行を全部読んでビューを作る。** それが `PopulateState` で、状態の中に「何番目のテーブルか」「実行中の `Statement`」「処理中の行」を全部持っている。

`pending_row` が特に [再入対策](../reentrancy/) そのものだ。1 行を DAG に流す途中で I/O が起きたら、その行を状態に置いて帰る。再開したら、次の行を読むのではなく **その行の処理を続ける**。

面白いのは、初期化に **SQL のクエリを使っている**ことだ。`Statement` を持っている。カーソルで直接走査するのではなく、**エンジンの上に載っている自分自身を使う**。

これができるのは、`Statement` が [中断可能](../vdbe/) だからになる。ビューの初期化という長い処理が、SQL の実行という長い処理を内側に持てる。

### 演算子の種類

```rust title="core/incremental/operator.rs"
    /// Join two inputs
    Join {
        join_type: JoinType,
        on_column: String,
        left_input: usize,
        right_input: usize,
    },

    /// Aggregate
    Aggregate {
        group_by: Vec<String>,
        aggregates: Vec<AggregateFunction>,
        input: usize,
    },
```

[`core/incremental/operator.rs#L186-L199`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/operator.rs#L186-L199)。

ファイル構成がそのまま演算子の一覧になっている。`filter_operator.rs`、`project_operator.rs`、`join_operator.rs`、`aggregate_operator.rs`、`merge_operator.rs`、`input_operator.rs`。

**この 6 つが、対応できる SQL の範囲を決めている。** ウィンドウ関数も再帰 CTE もここにはない。

`compiler.rs` が 6,256 行あるのは、**「普通のクエリプランを、この 6 種類の演算子の DAG に落とす」変換が難しいから**だ。すべての SQL が落とせるわけではない。

## なぜそうなっているか

- **差分の要素に値まで含めるのは、更新が「削除 + 挿入」になるから。** 行キーだけだと、同じ行の削除と挿入が相殺されて消える。理論がそう定義しているのには理由がある。
- **理論から外れないと決めているのは、外れた影響が別のところに出るから。** 1 箇所を都合よく変えると、その前提に依存していた別の性質が壊れる。壊れる場所が離れているので、原因に辿り着けない。
- **差分を順序つきのリストにしたのは、演算子が中間状態を持つから。** 理論上の Z-set は順序を持たないが、状態を持つ実装では適用順が結果を変える。
- **重み 0 の要素を落とすのは、痕跡を残さないため。** 「入れてすぐ消した」が残り続けると、メモリが単調に増える。
- **行のハッシュをキャッシュするのは、行が不変で何度もハッシュされるから。** 結合のたびに再計算する方が高くつく。
- **`Ord` を全フィールドで実装したのは、`Eq` との整合のため。** `rowid` だけで比較すると、順序つきコンテナに入れた瞬間に壊れる。
- **`eval` と `commit` を分けたのは、未コミットの変更を読めるようにするため。** トランザクションの中では自分の変更が見え、ロールバックしたら消えなければならない。
- **演算子が `IOResult` を返すのは、状態がディスクにあるから。** 集約の途中経過は B-tree にあり、読むには I/O が要る。
- **カーソルを引数で受け取るのは、演算子に pager を持たせないため。** どのトランザクションの文脈で動くかを、呼び出し側が決められる。
- **初期化に SQL を使っているのは、それができるから。** カーソルを直接回すより、既にあるクエリ実行を再利用する方が、索引も使えて速い。

## どう活かすか

- **理論をそのまま実装するときは、「ここは自分たちの都合で変えられそう」に注意する。** 変えられるように見える箇所には、たいてい理論がそうしている理由がある。変えるなら、なぜ大丈夫かを説明できるまで考える。
- **踏んだ落とし穴は、症状と具体例つきで書く。** 「82 時間溶かした」と書いてあれば、次の人は読む。抽象的な注意書きは読み飛ばされる。
- **差分の単位に何を含めるかを、最初に決める。** 「変更前の値」を含めないと、更新を表せない。
- **相殺して 0 になった要素は、必ず捨てる。** 差分の蓄積は、これを守らないと単調に増える。
- **`Hash`、`Eq`、`Ord` の整合性を、実装した時点で確かめる。** 一部のフィールドだけで比較すると、順序つきコンテナに入れた瞬間に壊れる。壊れ方が静かで、原因から遠い場所に出る。
- **「状態を変えずに評価する」と「状態を変えて確定する」を分ける。** トランザクションがある系では、未確定の変更を読めることと、取り消せることの両方が要る。
- **プラグイン的な要素には、必要な資源を引数で渡す。** 自分で取りに行かせると、呼び出し側が文脈を制御できなくなる。
- **既にある高水準の仕組みを、内部処理で再利用できないか考える。** 「クエリを実行する仕組み」が中断可能なら、それを内側に持つ長い処理が書ける。
