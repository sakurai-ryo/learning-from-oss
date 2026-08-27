---
title: "全文検索とベクトル索引を、索引方式として後から差す"
description: "CREATE INDEX ... USING で索引の実装を差し替えられる。B-tree の代わりに全文検索や近似最近傍を置くのだが、インタフェースが独特だ。索引方式は「自分が処理できる SELECT の形」を SQL の構文木として宣言し、プランナがクエリをそれに照合する。実装が答えるのは行 ID とカラムだけで、残りの列は本体の表から引き直される。そしてトランザクションの終わり方ごとにフックが分かれていて、実装しないと何が壊れるかがドキュメントに書いてある。"
sidebar:
  order: 27
---

## 何を学んだか

全文検索やベクトル検索の索引は、B-tree では表せない。転置索引や近似最近傍のグラフといった、まったく別のデータ構造が要る。

各 RDBMS の解き方はこうなっている。

- **MySQL** — `FULLTEXT INDEX` をエンジンに組み込む。外から足すことはできない
- **PostgreSQL** — Index Access Method という C の拡張点があり、GiST/GIN/pgvector が載る
- **SQLite** — FTS5 を **仮想テーブル**として実装する。索引ではなくテーブルの形をしている

Turso は 4 つ目の道を取った。

```sql
CREATE INDEX t_idx ON t USING fts (body);
```

**索引方式 (index method) という差し替え点を作り、そこに FTS とベクトルを載せている。**

面白いのはインタフェースの形で、**「この索引はどんな `SELECT` を処理できるか」を SQL の構文木として宣言する。**

## ソースコードのどこか

### 3 段の trait

```rust title="core/index_method/mod.rs"
/// index method "entry point" which can create attachment of the method to the table with given configuration
/// (this trait acts like a "factory")
pub trait IndexMethod: std::fmt::Debug + Send + Sync {
    /// create attachment of the index method to the specific table with specific method configuration
    fn attach(
        &self,
        configuration: &IndexMethodConfiguration,
    ) -> Result<Arc<dyn IndexMethodAttachment>>;
}
```

```rust title="core/index_method/mod.rs"
/// index method attached to the table with specific configuration
/// the attachment is capable of generating SELECT patterns where index can be used and also can create cursor for query execution
pub trait IndexMethodAttachment: std::fmt::Debug + Send + Sync {
    fn definition<'a>(&'a self) -> IndexMethodDefinition<'a>;
    fn init(&self) -> Result<Box<dyn IndexMethodCursor>>;
}
```

[`core/index_method/mod.rs#L29-L56`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L29-L56)。

**方式 → 特定の索引への結び付き → 1 回の実行のためのカーソル**、と 3 段になっている。

- `IndexMethod` — 「FTS という方式」。プロセスに 1 個
- `IndexMethodAttachment` — 「`t` の `body` 列に付いた FTS 索引」。索引ごとに 1 個
- `IndexMethodCursor` — 「今このクエリのための走査」。実行ごとに 1 個

**寿命が違うものを、別の型に分けている。** 設定 (`IndexMethodConfiguration`) は 1 段目から 2 段目に渡され、2 段目に固定される。3 段目は状態を持つので毎回作り直す。

### 「処理できるクエリの形」を SQL で宣言する

```rust title="core/index_method/mod.rs"
    /// SELECT patterns where index method can be used
    /// the patterns can contain positional placeholder which will make planner to capture parameters from the original query and provide them to the index method
    /// (for example, pattern 'SELECT * FROM {table} LIMIT ?' will capture LIMIT parameter and provide its value from the query to the index method query_start(...) call)
    pub patterns: &'a [ast::Select],
```

[`core/index_method/mod.rs#L86-L90`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L86-L90)。

**索引方式が返すのは、`ast::Select` の配列。** パース済みの `SELECT` 文そのものだ。

プランナは利用者のクエリをこのパターンに照合し、一致したら **パターンの番号と、`?` に嵌まった値**をカーソルに渡す。

```rust title="core/index_method/mod.rs"
    /// initialize query to the index method
    /// first element of "values" slice is the Integer register which holds index of the chosen [IndexMethodDefinition::patterns] by query planner
    /// next arguments of the "values" slice are values from the original query expression captured by pattern
    ///
    /// For example, for 2 patterns ["SELECT * FROM {table} LIMIT ?", "SELECT * FROM {table} WHERE x = ?"], query_start(...) call can have following arguments:
    /// - [Integer(0), Integer(10)] - pattern "SELECT * FROM {table} LIMIT ?" was chosen with LIMIT parameter equals to 10
    /// - [Integer(1), Text("turso")] - pattern "SELECT * FROM {table} WHERE x = ?" was chosen with equality comparison equals to "turso"
    fn query_start(&mut self, values: &[Register]) -> Result<IOResult<bool>>;
```

[`core/index_method/mod.rs#L562-L572`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L562-L572)。

**この設計が何を解いているのかを考えると分かりやすい。**

PostgreSQL の index AM は「演算子クラス」で表現力を与える。`<->` という演算子を定義し、それが索引で処理できると登録する。表現力は演算子の粒度に縛られる。

SQLite の FTS5 は仮想テーブルなので、`MATCH` という特殊な構文を経由する。**索引ではなくテーブルに見えるので、元の表と join することになる。**

Turso の方式は、**「この形の `SELECT` を丸ごと引き受ける」と宣言できる**。ベクトル検索なら、こういうパターンになる。

```rust title="core/index_method/mod.rs"
    /// > SELECT vector_distance_jaccard(embedding, ?) as d FROM table ORDER BY d LIMIT 10
```

**`ORDER BY 距離 LIMIT 10` という形全体が 1 つのパターンになる。** 「距離を計算する演算子」と「並べ替え」と「上位 N 件」を別々に表現する必要がない。近似最近傍の索引は、まさにこの形しか効率的に処理できないので、**表現の粒度が実装の能力と一致している。**

### 返すのは行 ID とカラムだけ

```rust title="core/index_method/mod.rs"
    /// Return rowid of the original table row which corresponds to the current cursor row
    ///
    /// This method is used by tursodb core in order to "enrich" response from query pattern with additional fields from original table
    /// For example, consider pattern like this:
    ///
    /// > SELECT vector_distance_jaccard(embedding, ?) as d FROM table ORDER BY d LIMIT 10
    ///
    /// It can be used in more complex query:
    ///
    /// > SELECT name, comment, rating, vector_distance_jaccard(embedding, ?) as d FROM table ORDER BY d LIMIT 10
    ///
    /// In this case query planner will execute index method query first, and then
    /// enrich its result with name, comment, rating columns from original table accessing original row by its rowid
    /// returned from query_rowid(...) method
    fn query_rowid(&mut self) -> Result<IOResult<Option<i64>>>;
```

[`core/index_method/mod.rs#L580-L594`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L580-L594)。

**索引方式が答えるのは「どの行か」と「パターンで宣言した列」だけ。** 残りの列は、エンジンが行 ID で本体の表を引き直す。

これで、**パターンが「クエリ全体と一致する」必要がなくなる**。パターンは `SELECT 距離 ... LIMIT 10` だが、実際のクエリは `SELECT name, comment, rating, 距離 ...` でよい。差分はエンジンが埋める。

**拡張点の責務を「自分にしかできないこと」に絞ると、対応できるクエリの範囲が広がる。**

### 走査中に書き込まれる問題

```rust title="core/index_method/mod.rs"
    /// Whether `query_start()` materializes all matching rowids up front (e.g. into a Vec/VecDeque).
    /// When `true`, the cursor is safe to use during DML because it does not lazily stream from
    /// a live data structure that writes could invalidate.
    /// When `false`, the emitter will collect rowids into a RowSet/ephemeral table before writing.
    pub results_materialized: bool,
```

[`core/index_method/mod.rs#L92-L97`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L92-L97)。

`DELETE FROM t WHERE ...` を索引方式で駆動すると、**削除しながら索引を走査する**ことになる。[B-tree でも同じ問題があった](../btree-state-machine/)。

ここでは **実装に自己申告させている。** 「結果を先に全部materialize しているか」を `bool` で答えれば、エンジンが対処を選ぶ。

- `true` — そのまま走査してよい
- `false` — エンジンが先に行 ID を一時表に集めてから、書き込みを始める

**「安全かどうか」を実装しか知らないなら、実装に聞くしかない。** そして安全でない場合の対処を、エンジン側が持っている。**申告しなければ (既定値が `false` なら) 安全側の遅い経路になる。**

### MVCC への参加の仕方も宣言する

```rust title="core/index_method/mod.rs"
pub enum IndexMethodMvccSupport {
    /// The method cannot be opened while MVCC is active.
    Unsupported,
    /// The method may query MVCC snapshots but has no transactional write path.
    ReadOnly,
    /// Persistent state is stored exclusively through core-provided,
    /// MVCC-aware backing storage.
    ///
    /// Under MVCC, at most one transaction may write a given index at a time
    /// (a per-index write lease, taken on the first document mutation).
    /// Contention is a retryable `Busy`; a writer whose read snapshot
    /// predates the index's last publication gets `WriteWriteConflict` and
    /// must restart its transaction. `BEGIN CONCURRENT` therefore does not
    /// parallelize writes to one index of this kind — that is the write
    /// throughput ceiling per index.
    TransactionalBackingStore,
    /// Persistent state is external and implements transaction outcome hooks.
    ExternalTransactional,
}
```

[`core/index_method/mod.rs#L57-L76`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L57-L76)。

**4 段階で、それぞれ何ができるかが違う。**

`TransactionalBackingStore` の説明が特に価値がある。**「1 つの索引に対して同時に書けるトランザクションは 1 つだけ。つまり `BEGIN CONCURRENT` はこの種の索引への書き込みを並列化しない。それがこの索引 1 つあたりの書き込みスループットの上限になる。」**

**性能の上限が、能力の宣言と同じ場所に書いてある。** 「並行書き込みができる DB です」と言っておいて、特定の索引を使うとそこがボトルネックになる、というのは事前に知りたい情報になる。

競合したときの挙動も 2 通り書き分けられている。**リトライ可能な `Busy` と、トランザクションのやり直しが要る `WriteWriteConflict`。** [MVCC のページ](../mvcc/) の衝突検出がそのまま出てくる。

### トランザクションの終わり方ごとにフックがある

```rust title="core/index_method/mod.rs"
    /// Stage all pending index changes before the statement savepoint is
    /// released. Any fallible work or I/O belongs in this phase.
    fn stage_statement_commit(&mut self, _context: &IndexMethodContext) -> Result<IOResult<()>> {

    /// Discard statement-owned in-memory work. This hook must not perform I/O.
    fn abort_statement(&mut self, _context: &IndexMethodContext) {}

    /// Publish transaction-private in-memory state after the statement
    /// savepoint has been released successfully. This hook is infallible and
    /// must not make uncommitted state visible to another transaction.
    fn on_statement_committed(&mut self, _context: &IndexMethodContext) {}

    /// Publish in-memory state after the database transaction commits.
    /// This hook is infallible and must not perform I/O.
    fn on_transaction_committed(&mut self, _context: &IndexMethodContext) {}

    /// Invalidate transaction-owned in-memory state after rollback.
    fn on_transaction_rolled_back(&mut self, _context: &IndexMethodContext) {}

    /// Invalidate state newer than a rolled-back savepoint.
    fn on_savepoint_rolled_back(&mut self, _context: &IndexMethodContext) {}
```

[`core/index_method/mod.rs#L596-L621`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L596-L621)。

**「失敗しうる作業と I/O は `stage_statement_commit` でやれ。それ以外のフックは失敗してはならず、I/O もしてはならない。」**

これは 2 相コミットの形になっている。準備の段階で失敗しうることを全部やり、確定の段階では失敗しない。**確定の途中で失敗されると、一部だけ確定した状態になって収拾がつかない。**

そして、既定実装が空であることについての警告が付いている。

```rust title="core/index_method/mod.rs"
/// The empty default bodies below are correct **only for a method that keeps
/// no transaction-private in-memory state** (everything lives in core-owned
/// backing storage, which the engine rolls back on its own). A method that
/// mirrors state in memory must implement every outcome hook: skipping
/// `on_transaction_rolled_back` silently publishes rolled-back work, and
/// skipping `stage_statement_commit` silently loses writes.
```

[`core/index_method/mod.rs#L536-L542`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L536-L542)。

**「空の既定実装が正しいのは、メモリ上に状態を持たない方式だけ」。** そして実装しなかった場合に何が起きるかを、フックごとに書いている。

- `on_transaction_rolled_back` を実装しない → **ロールバックした作業が公開される**
- `stage_statement_commit` を実装しない → **書き込みが黙って失われる**

**既定実装がある trait は、「実装しなくていい」と読まれる。** どちらも黙って壊れる種類の失敗なので、この警告がなければテストでも気付けない。

### ライフサイクル全体が図示されている

```rust title="core/index_method/mod.rs"
///      newer cursor for the same attachment, so this one is closed without
///      either transaction outcome (the newer cursor receives it).
/// 4. `close`.
///
/// A failed statement gets `abort_statement` instead of steps 1–2.
```

[`core/index_method/mod.rs#L528-L534`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L528-L534)。

**フックが呼ばれる順序が、番号つきで書かれている。** さらに例外的な経路 (同じ索引に新しいカーソルができた場合、文が失敗した場合) も書いてある。

**フックが 8 個あるインタフェースは、順序を書かなければ実装できない。**

### コストも申告できる

```rust title="core/index_method/mod.rs"
    /// Estimate the cost of executing a query with the given pattern.
    ///
    /// This method enables the optimizer to make cost-based decisions when choosing
    /// between custom index methods and traditional BTree indexes.
    fn estimate_cost(
        &self,
        context: &IndexMethodCostContext<'_>,
    ) -> Option<IndexMethodCostEstimate> {
        let _ = context;
        None
    }
```

[`core/index_method/mod.rs#L625-L635`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/index_method/mod.rs#L625-L635)。

**索引方式が [コスト](../cost-params/) を申告できる。** 返り値が `Option` で、既定は `None`。

**「答えられるなら答える。答えなければオプティマイザが既定の判断をする」。** 拡張点に必須の責務を増やさずに、能力のある実装だけが精度を上げられる形になっている。

## なぜそうなっているか

- **索引方式を差し替え点にしたのは、FTS を仮想テーブルにしたくないから。** 仮想テーブルにすると、利用者が「テーブルと索引を join する」形で書くことになる。索引なら `CREATE INDEX` と `SELECT` だけで完結する。
- **処理できるクエリを SQL の構文木で宣言するのは、演算子の粒度では表せないから。** 近似最近傍は「距離順で上位 N 件」という形でしか効率化できない。演算子 1 個では表現できない。
- **返すのを行 ID と一部の列に絞ったのは、パターンとクエリの完全一致を要求しないため。** 差分をエンジンが埋めれば、パターンは索引が本当に処理できる部分だけでよくなる。
- **走査中の書き込みの安全性を自己申告させたのは、実装しか知らないから。** データ構造の性質はエンジンから見えない。聞くしかない。
- **申告しない場合が安全側なのは、既定実装が使われるから。** 「申告し忘れたら壊れる」設計にすると、拡張の実装者が必ず踏む。
- **MVCC への参加を 4 段階にしたのは、方式によって実現できる範囲が違うから。** 全部に完全なトランザクション性を要求すると、簡単な索引が書けなくなる。
- **性能の上限を能力の宣言に書いたのは、後から気付くと手遅れだから。** 「並行書き込みができる」と信じて設計したシステムが、特定の索引で直列化されると分かるのは本番になる。
- **フックを準備と確定に分けたのは、確定の途中で失敗させないため。** 一部だけ確定した状態は、どちらにも戻せない。
- **既定実装の危険を明記したのは、既定があると実装されないから。** しかも失敗が「黙って公開する」「黙って失う」なので、テストで見つからない。
- **フックの呼ばれる順序を書いたのは、書かなければ実装できないから。** 8 個のフックの関係は、コードからは読み取れない。
- **コストの申告を任意にしたのは、必須の責務を増やしたくないから。** 答えられる実装だけが精度を上げればよい。

## どう活かすか

- **拡張点は、寿命の違いで型を分ける。** 「方式」「特定の対象への結び付き」「1 回の実行」は、それぞれ持つべき状態と作り直す頻度が違う。1 つの型にまとめると、どれかが不自然になる。
- **拡張が処理できる入力の形を、既にある表現で宣言させる。** 独自の記述形式を作るより、扱っている領域の言語 (ここでは SQL) をそのまま使う方が、表現力も学習コストも有利になる。
- **拡張の責務を「それにしかできないこと」に絞る。** 残りを本体が埋めれば、拡張が対応できる範囲が広がる。
- **本体からは判定できない性質は、拡張に自己申告させる。** そして申告しない場合を安全側の既定にする。
- **拡張の能力を段階として列挙し、段ごとに何ができるかを書く。** 全部に最高水準を要求すると、簡単な拡張が書けなくなる。
- **性能の上限は、能力の宣言と同じ場所に書く。** 「この構成ではここが直列化される」は、選ぶ前に知りたい情報になる。
- **確定の処理は、失敗しうる準備と失敗しない確定に分ける。** そして「このフックでは I/O をするな」「このフックは失敗してはならない」を明記する。
- **既定実装のある trait には、「既定のままでよい条件」を書く。** そして実装しなかった場合に何が起きるかも書く。既定があると、実装されないことを前提にすべきだ。
- **フックが複数あるインタフェースには、呼ばれる順序を番号つきで書く。** 例外的な経路も含める。
- **精度を上げるための申告は、任意にする。** `Option` を返せる形にしておけば、答えられる実装だけが恩恵を受け、他は既定で動く。
