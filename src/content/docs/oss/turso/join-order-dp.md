---
title: "System R 流の動的計画法で結合順序を決める"
description: "1970 年代の System R とほぼ同じ、部分集合ごとに最良の順序を記憶する動的計画法を実装している。まず SQL に書かれた順序どおりの計画を作ってコストの上限とし、それを超えた枝は捨てる。テーブルの部分集合はビットマスクで表し、k ビットの組み合わせは Gosper's hack で列挙する。12 テーブルを超えると O(2^n) が現実的でなくなるので、O(n²) の貪欲法に切り替える。"
group: "クエリコンパイル"
sidebar:
  order: 42
---

## 何を学んだか

結合順序の最適化は、RDBMS のオプティマイザで最も古典的な問題だ。`A JOIN B JOIN C` の結果は順序によらず同じだが、**実行コストは桁違いに変わる**。

Turso の答えは、あっさりしている。

```text title="core/translate/optimizer/OPTIMIZER.md"
Limbo's optimizer is an implementation of an extremely traditional [IBM System R](https://www.cs.cmu.edu/~15721-f24/slides/02-Selinger-SystemR-opt.pdf) style optimizer,
i.e. straight from the 70s! The DP algorithm is explained below.
```

[`core/translate/optimizer/OPTIMIZER.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/OPTIMIZER.md)。

**「70 年代から直輸入」と自分で書いている。** 新規性を主張していない。

MySQL のオプティマイザも System R の系譜だが、探索の仕方が違う。MySQL は貪欲法を基本とし、`optimizer_search_depth` で網羅探索する深さを制御する。**Turso はテーブル数が閾値以下なら網羅的な DP をやり、超えたら貪欲法に落ちる。**

## ソースコードのどこか

### DP の骨格

```text title="core/translate/optimizer/OPTIMIZER.md"
5. **Compute the best join order using a dynamic programming algorithm:**
  - `n` = number of tables considered
  - `n=1`: find the lowest _cost_ way to access each single table, given the constraints of the query. Memoize the result.
  - `n=2`: for each table found in the `n=1` step, find the best way to join that table with each other table. Memoize the result.
  - `n=3`: for each 2-table subset found, find the best way to join that result to each other table. Memoize the result.
```

**部分集合のサイズを 1 から増やしながら、各部分集合の最良解を記憶する。** これが System R の DP そのままになる。

正当性の根拠も書かれている。

```text title="core/translate/optimizer/OPTIMIZER.md"
      - If we find that `JOIN(b,a,c)` is better than any other permutation of the same tables, e.g. `JOIN(a,b,c)`, then we can discard _ALL_ of the other permutations for that subset. ...
      - This is possible due to the associativity and commutativity of INNER JOINs.
```

**「INNER JOIN が結合的かつ可換だから」。** {a,b,c} を結合した結果は、順序によらず同じ行の集合になる。だから **その先の計画にとって、どの順序で作ったかは関係ない**。最良のものだけ覚えればいい。

これが成り立たない演算 (LEFT JOIN、集約) が混ざると、この枝刈りは使えなくなる。**DP が使える条件は代数的な性質から来ている。**

### 上限は「SQL に書かれた順序」から取る

```text title="core/translate/optimizer/OPTIMIZER.md"
  - **Use pruning to reduce search space:**
    - Compute the literal query order first, and store its _cost_ as an upper threshold.
    ...
    - If at any point a considered join order exceeds the upper threshold, discard that search path since it cannot be better than the current best.
      - For example, we have `SELECT * FROM a JOIN b JOIN c JOIN d`. Compute `JOIN(a,b,c,d)` first. If `JOIN (b,a)` is already worse than `JOIN(a,b,c,d)`, we don't have to even try `JOIN(b,a,c)`.
```

```rust title="core/translate/optimizer/join.rs"
    // Compute naive left-to-right plan to use as pruning threshold
    let naive_plan = compute_naive_left_deep_plan(
```

[`core/translate/optimizer/join.rs#L1136-L1137`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/join.rs#L1136-L1137)。

**まず「何も考えずに書かれたとおりに実行する計画」を作り、そのコストを上限にする。**

分枝限定法の要点は「良い初期解を早く得ること」で、**書かれた順序は多くの場合そこそこ良い**。人間は結合を書くとき、だいたい絞り込みたい表から書く。

上限が取れない場合の扱いも書かれている。

```text title="core/translate/optimizer/OPTIMIZER.md"
      In some cases it is not possible to compute this upper threshold from the literal order—for example, when
      table-valued functions are involved and their arguments reference tables that appear to the right in the join order.
      In such situations, the literal order cannot be executed directly, so no meaningful _cost_ can be assigned.
      In these cases, the threshold is set to infinity, ensuring that valid plans are still considered.
```

**「上限を無限大にして、枝刈りを効かなくする」。** 表値関数の引数が右側のテーブルを参照していると、そもそも書かれた順序では実行できない。

**最適化のための仕掛けが使えない場合に、最適化を諦めて正しさを取る。** ここで無理に上限を作ると、有効な計画まで刈られる。

### 部分集合はビットマスク、列挙は Gosper's hack

```rust title="core/translate/optimizer/join.rs"
/// Iterator that generates all possible size k bitmasks for a given number of tables.
/// For example, given: 3 tables and k=2, the bitmasks are:
/// - 0b011 (tables 0, 1)
/// - 0b101 (tables 0, 2)
/// - 0b110 (tables 1, 2)
struct JoinBitmaskIter {
    current: u128,
    max_exclusive: u128,
}
```

```rust title="core/translate/optimizer/join.rs"
        // Gosper's hack: compute next k-bit combination in lexicographic order
        let c = self.current & (!self.current + 1); // rightmost set bit
        let r = self.current + c; // add it to get a carry
        let ones = self.current ^ r; // changed bits
        let ones = (ones >> 2) / c; // right-adjust shifted bits
        self.current = r | ones; // form the next combination
```

[`core/translate/optimizer/join.rs#L2172-L2214`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/join.rs#L2172-L2214)。

**「N 個から k 個を選ぶ組み合わせ」を、ビット演算 5 行で次々に生成する。** 一時的な `Vec` も再帰も要らない。

このコードは一見して何をしているか分からない。**だから 1 行ずつコメントが付いている**し、名前も付いている (Gosper's hack)。名前があれば検索できる。

記憶表はこうなる。

```rust title="core/translate/optimizer/join.rs"
    let mut best_plan_memo: HashMap<TableMask, HashMap<usize, JoinN>> =
```

[`core/translate/optimizer/join.rs#L1215`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/join.rs#L1215)。

**部分集合 → (最後に結合したテーブル → 最良計画)** の二段になっている。「部分集合ごとに 1 個」ではないのは、**最後に来るテーブルによって次の結合のコストが変わる**からだ。

### 打ち切りの閾値

```rust title="core/translate/optimizer/join.rs"
    // For large queries, use greedy join ordering instead of exhaustive DP.
    // The DP algorithm has O(2^n) complexity which becomes prohibitively slow
    // beyond ~12 tables. The greedy algorithm is O(n²) and produces good
    // (though not always optimal) plans.
    if num_tables > GREEDY_JOIN_THRESHOLD {
        return compute_greedy_join_order(
```

```rust title="core/translate/optimizer/join.rs"
/// Above this threshold, use greedy O(n²) ordering instead of exhaustive O(2^n) DP.
pub const GREEDY_JOIN_THRESHOLD: usize = 12;
```

[`core/translate/optimizer/join.rs#L1113-L1118`, `#L1568-L1569`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/join.rs#L1568-L1569)。

**12 テーブルを超えたら、別のアルゴリズムに切り替える。**

これは実装の妥協ではなく、**最適化に使ってよい時間の上限がある**という認識の表れだ。13 テーブルの最適解を 10 秒かけて見つけるより、そこそこの解を 1 ミリ秒で出す方がいい。

「良いが、常に最適とは限らない (good though not always optimal)」と正直に書いてある。

### ソートを消せる計画は、別枠で追う

```rust title="core/translate/optimizer/join.rs"
    // Keep track of both 1. the best plan overall (not considering sorting), and 2. the best ordered plan (which might not be the same).
    // We assign Some Cost (tm) to any required sort operation, so the best ordered plan may end up being
    // the one we choose, if the cost reduction from avoiding sorting brings it below the cost of the overall best one.
    let mut best_ordered_plan: Option<JoinN> = None;
```

[`core/translate/optimizer/join.rs#L1157-L1160`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/join.rs#L1157-L1160)。

**「全体で最良の計画」と「望む順序で出力する計画のうち最良のもの」を、別々に追いかける。**

`ORDER BY` や `GROUP BY` があるとき、索引の順序で出せればソートを丸ごと省ける。だが **その計画は、ソートを無視すれば最良ではないかもしれない**。

```text title="core/translate/optimizer/OPTIMIZER.md"
  - At the end, apply a cost penalty to the best overall plan
    - If it is now worse than the best sorted plan, then choose the sorted plan as the best plan for the query.
      - This allows us to eliminate a sorting operation.
```

**最後にソートのコストを乗せて比べ直す。** これが System R でいう "interesting order" の扱いになる。

`Some Cost (tm)` という書き方が正直で、**ソートのコスト見積もりが適当であることを隠していない**。

### コストモデルは、統計があれば使い、なければ定数

`OPTIMIZER.md` はこう書いている。

```text title="core/translate/optimizer/OPTIMIZER.md"
Since we don't support `ANALYZE`, nor can we assume that users will call `ANALYZE` anyway, we use simple magic constants to estimate the selectivity of join predicates, row count of tables, and so on.
```

**この記述は今は古い。** `ANALYZE` は実装されていて、コスト計算にも使われている。

```rust title="core/translate/optimizer/cost.rs"
/// Uses sqlite_stat1 histogram data for row estimates when available,
```

```rust title="core/translate/optimizer/cost.rs"
    if let Some(ctx) = analyze_ctx {
        ...
                estimate_rows_from_analyze_stats(ctx, usable_constraint_refs)
```

[`core/translate/optimizer/cost.rs#L277-L299`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost.rs#L277-L299)。

**`sqlite_stat1` があればそこから行数を見積もり、なければ定数に落ちる。** ドキュメントが書かれた時点の「定数だけ」から、「統計を優先し、定数はフォールバック」に変わっている。

定数の側は、こういう仮定になっている。

```text title="core/translate/optimizer/OPTIMIZER.md"
1. Each table has `1,000,000` rows.
2. Each equality (`=`) filter will filter out some percentage of the result set.
3. Each nonequality (e.g. `>`) will filter out some smaller percentage of the result set.
4. Each `4096` byte database page holds `50` rows, i.e. roughly `80` bytes per row
5. Sort operations have some CPU cost dependent on the number of input rows to the sort operation.
```

**「全部のテーブルが 100 万行」という仮定が効くのは、絶対値ではなく比較だからだ。** 全テーブルが同じ行数と仮定しても、**述語による絞り込みの差**は残る。ドキュメントの計算例がそれを示している。

```text title="core/translate/optimizer/OPTIMIZER.md"
Even though `t2` is a larger table, because we were able to reduce the input set to the join operation, it's dramatically cheaper.
```

`t2` の方が大きくても、`WHERE t2.foo > 10` で 1/4 に絞れるなら先に置いた方が 4 倍安い。**統計がなくても、この判断はできる。**

### コストの式は 1 行

```text title="core/translate/optimizer/OPTIMIZER.md"
JOIN_COST = PAGE_IO(t1.rows) + t1.rows * PAGE_IO(t2.rows)
```

**外側のテーブルを 1 回読むコスト + 外側の行数 × 内側を 1 回引くコスト。** 素朴なネステッドループの式そのままだ。

そして出力の行数が、次の結合の入力になる。

```text title="core/translate/optimizer/OPTIMIZER.md"
Estimating them is important because in multi-way joins the output cardinality of the previous join becomes the input cardinality of the next one.
```

**多段結合では、見積もりの誤差が掛け算で伝播する。** 3 段目の見積もりが 1000 倍ずれることは普通に起きる。だから統計が効く。

## なぜそうなっているか

- **System R そのままなのは、それで十分だから。** 新しい探索手法を発明する必要はない。50 年前のアルゴリズムが今でも標準なのは、それがよくできているからだ。
- **書かれた順序を上限に使うのは、良い初期解が早く手に入るから。** 分枝限定法の効率は初期解の質でほぼ決まる。人間が書いた順序は、ランダムよりずっと良い。
- **上限が取れない場合に無限大を使うのは、正しさを優先するから。** 無理に上限を作ると、実行可能な計画まで刈られる。
- **部分集合をビットマスクにしたのは、記憶表の鍵にするため。** 集合を `HashMap` の鍵にするには、順序に依存しない表現が要る。整数 1 個なら比較もハッシュも速い。
- **最後のテーブルまで鍵に含めるのは、次の結合のコストがそれで変わるから。** 「{a,b,c} の最良計画」だけでは、次に d を結合するときのコストが決まらない。
- **12 で貪欲法に切り替えるのは、最適化に使える時間が有限だから。** 最適解を求めるコストが、最適解によって節約できるコストを超えたら意味がない。
- **ソート可能な計画を別枠で追うのは、ソートの削減が後から効くから。** 結合だけを見て選ぶと、最後にソートが乗って逆転することがある。両方持っておいて最後に比べるしかない。
- **統計がなくても定数で動くのは、`ANALYZE` を打たない利用者がいるから。** 「統計がなければ最適化しない」では、大多数のケースで何もしないことになる。
- **絶対値でなく比較で使うので、定数が雑でも動く。** 全テーブル 100 万行という仮定でも、述語の絞り込みの差は正しく反映される。

## どう活かすか

- **探索問題では、まず「そこそこの解」を作って上限にする。** 分枝限定法の効きは初期解の質で決まる。素朴な解を最初に評価するコストは、ほぼ必ず回収できる。
- **その上限が計算できない入力を、事前に洗い出す。** 上限を無理に作ると、正しい解を刈ってしまう。「上限なし」で通す経路を用意する。
- **部分問題の記憶表の鍵には、次の段階に影響する情報を全部入れる。** 「集合」だけでは足りず「集合 + 最後の要素」が要る、という形はよくある。足りないと、間違った枝刈りをする。
- **網羅探索には、必ず打ち切りの閾値を置く。** 「最適解を求めるコスト」が「最適解で節約できるコスト」を超える点が必ずある。そこで別のアルゴリズムに切り替える。
- **切り替え先が最適でないことを、コメントに明記する。** 「good though not always optimal」と書いてあれば、後から結果を疑う人が理由に辿り着ける。
- **最後に効く要素は、別枠で追いかける。** 主要なコスト (結合) だけで選ぶと、副次的なコスト (ソート) で逆転する。両方の候補を持って最後に比べる。
- **統計がない場合のフォールバックを持つ。** 統計を前提にすると、統計がない環境で何も判断できなくなる。定数でも「比較」には使える。
- **難解なビット演算には、名前と行ごとのコメントを付ける。** 名前があれば検索でき、コメントがあれば追える。どちらもなければ、誰も触れなくなる。
