---
title: "バイト列から `Cmd` へ、そして `translate_inner` の巨大な match へ"
description: "パーサとエンジンの境界は `Dialect` trait だ。エンジンが要求するのは「1 文パースして、消費バイト数を返せ」だけではない。sqlite_schema に書く SQL テキストの書式と読み戻しまで、この trait の責任になっている。AST は 33 バリアントの `Stmt` で、それを受ける `translate_inner` の match は 68 本の腕を持つ。"
group: "SQL からバイトコードへ"
sidebar:
  order: 7
---

## この層の責務

パーサの中身 — 手書き再帰下降、文脈依存キーワード、コンパイル時トライ — は [パースの 3 ページ](../recursive-descent/) が扱っている。このページが扱うのは**パーサとエンジンの間にある境界**だ。

その境界には 2 方向のトラフィックがある。

1. **SQL テキスト → AST。** ユーザが書いた SQL を `ast::Cmd` にする
2. **AST ↔ `sqlite_schema` のテキスト。** `CREATE TABLE` を文字列にして保存し、DB を開くたびに読み戻す

2 番目があることが、この境界を単なる「パーサを呼ぶ」以上のものにしている。**スキーマはテキストで永続化される**ので、書く側と読む側の書式が一致していなければならない。

## 主要な型とその関係

### `Dialect` trait が境界そのもの

```rust title="core/dialect/mod.rs:1-11 (モジュールコメント)"
//! The [`Dialect`] trait is the boundary between the engine and the SQL
//! dialect a frontend speaks. The engine owns the mechanics — pages,
//! B-trees, the `sqlite_schema` table itself, bytecode — and consults the
//! dialect wherever the meaning of SQL text is dialect-specific: parsing
//! statements into the engine AST and interpreting persisted schema text.
```

**「エンジンは仕組みを持ち、方言は意味を持つ」**という切り方だ。メソッドを並べると、その半分以上がスキーマテキストの往復に使われていることが分かる。

| メソッド                          | 向き                    | 何のためか                       |
| --------------------------------- | ----------------------- | -------------------------------- |
| `name()`                          | —                       | レジストリで方言の一致を検査する |
| `parse(sql)`                      | テキスト → AST          | ユーザの SQL                     |
| `parse_table_sql(sql, root_page)` | テキスト → `BTreeTable` | `sqlite_schema` の行を読む       |
| `parse_table_sql_ast(sql)`        | テキスト → AST          | 同上 (AST が欲しい場合)          |
| `table_sql_for_replay(sql)`       | テキスト → テキスト     | VACUUM の再生用に取り出す        |
| `format_table_sql(...)`           | AST → テキスト          | `sqlite_schema` に書く           |
| `format_rewritten_table_sql(...)` | AST → テキスト          | `ALTER TABLE` 後に書き直す       |

`parse` の doc コメントに、この往復の制約が書いてある。

```rust title="core/dialect/mod.rs:35-42 (抜粋)"
/// Parse the first statement in `sql` into the engine AST.
///
/// Returns the parsed command, if any, and the number of input bytes
/// consumed. ... Implementations must accept the
/// canonical SQLite text produced by the engine AST formatter because
/// engine-generated and AST-only statements use that representation.
```

**Postgres 方言の実装であっても、SQLite の正規テキストを受け付けなければならない。** エンジンが内部で生成する文 (シーケンスの裏テーブル、`sqlite_sequence`) は素の SQLite テキストだからだ。

```rust title="core/dialect/mod.rs:44-49 (抜粋)"
/// Rows written by internal engine paths (sequence backing tables,
/// `sqlite_sequence`) are plain SQLite text and carry no frontend
/// marker, so every implementation must fall back to SQLite parsing
/// for text it does not recognize as its own.
```

「自分の書式でなければ SQLite として読む」という**フォールバックが必須**になっている。方言の追加が「完全な置き換え」ではなく「上乗せ」になっているわけで、この設計判断そのものは [`Dialect` trait のページ](../dialect-trait/) が扱う。

### SQLite 方言の `parse` は 4 行

```rust title="core/dialect/sqlite.rs:90-94"
pub fn parse(sql: &str) -> crate::Result<(Option<turso_parser::ast::Cmd>, usize)> {
    let mut parser = turso_parser::parser::Parser::new(sql.as_bytes());
    let cmd = parser.next_cmd()?;
    Ok((cmd, parser.offset()))
}

```

**文ごとに `Parser` を作り直している。** `Parser` は `Iterator<Item = Result<Cmd>>` を実装していて、複文を回せる作りになっている。

```rust title="sqlite/parser/src/parser.rs:191-201"
impl<'a> Iterator for Parser<'a> {
    type Item = Result<Cmd>;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        match self.mark(|p| p.next_cmd()) {
            Ok(None) => None, // EOF
            Ok(Some(cmd)) => Some(Ok(cmd)),
            Err(err) => Some(Err(err)),
        }
    }
```

だがエンジンはこの `Iterator` を使わない。1 文ごとに `Parser` を作って `offset()` を受け取り、呼び出し側がスライスを進める。理由は [クエリの一生のページ](../query-lifecycle/) で見たとおりで、**2 文目をパースする前に 1 文目を実行し終える必要がある**からだ。`Iterator` として回してしまうと、1 文目の `CREATE TABLE` がまだ実行されていないうちに 2 文目の `INSERT` を解析することになる。

`Iterator` の実装が残っているのは、`sqlite/parser` が単体のクレートとして独立していて、パーサだけを使いたい利用者がいるからだ。

### `Cmd` は 3 つ、`Stmt` は 33 個

```rust title="sqlite/parser/src/ast.rs:28-38"
/// Statement or Explain statement
// https://sqlite.org/syntax/sql-stmt.html
pub enum Cmd {
    /// `EXPLAIN` statement
    Explain(Stmt),
    /// `EXPLAIN QUERY PLAN` statement
    ExplainQueryPlan { stmt: Stmt, format: EqpFormat },
    /// statement
    Stmt(Stmt),
}
```

`EXPLAIN` が `Stmt` の一種ではなく**外側のラッパ**になっている。だから `EXPLAIN` は任意の文に付けられ、コンパイル経路は分岐しない ([クエリの一生のページ](../query-lifecycle/) で見た `Cmd` の 3 バリアント潰し)。

`Stmt` は 33 バリアント。`Select`、`Insert`、`Update`、`Delete` に加えて、`CreateTable`、`AlterTable`、`Pragma`、`Begin`、`Savepoint`、`Vacuum`、`Attach` などが並ぶ。

### `Parser` が持つ状態は 4 種類

```rust title="sqlite/parser/src/parser.rs:165-183"
pub struct Parser<'a> {
    lexer: Lexer<'a>,
    current_token: Token<'a>,
    peekable: bool,
    /// Last assigned id of positional variable
    last_variable_id: u32,
    named_variables: HashMap<&'a [u8], NonZeroU32>,
    /// Tracks STRUCT/UNION nesting depth to prevent stack overflow from deeply nested types
    type_nesting_depth: u32,
    /// Current expression recursion depth of the parser, bounded by [`MAX_EXPR_DEPTH`]
    expr_nesting_depth: u32,
    /// Height of the most recently parsed expression (`1 + max(child heights)`,
    /// like SQLite's `Expr.nHeight`), bounded by [`MAX_EXPR_DEPTH`]
    last_expr_height: usize,
}
```

字句解析の位置 (`lexer`, `current_token`, `peekable`)、パラメータ番号の採番 (`last_variable_id`, `named_variables`)、そして深さの計測が 3 種類 (`type_nesting_depth`, `expr_nesting_depth`, `last_expr_height`)。

`next_cmd` の冒頭が、この分類を反映している。

```rust title="sqlite/parser/src/parser.rs:278-281"
pub fn next_cmd(&mut self) -> Result<Option<Cmd>> {
    self.last_variable_id = 0;
    self.named_variables.clear();
```

**パラメータの採番は文ごとにリセットされる。** `SELECT ?; SELECT ?;` の 2 つの `?` は、どちらも 1 番になる。文ごとに `Parser` を作り直す運用でも、`Iterator` で回す運用でも、同じ結果になるようにここで揃えている。

深さの計測が 2 種類あること (`expr_nesting_depth` と `last_expr_height`) は [再帰下降のページ](../recursive-descent/) の主題なので、そちらに譲る。

## 処理の流れ (コードを追う)

### `translate()` が組み立てる 3 つのもの

```rust title="core/translate/mod.rs:102-110 (抜粋)"
// Boxed so the ~800 B builder sits on the heap instead of the prepare frame.
let mut program = Box::new(ProgramBuilder::new(
    query_mode,
    capture_data_changes_info,
    ProgramBuilderOpts::new(1, 32, 2),
));
program.set_mvcc_enabled(connection.mvcc_enabled());

program.prologue();
```

**`ProgramBuilder` が 800 バイトあるので `Box` に載せている。** `translate` は再帰的に呼ばれる (サブクエリ、トリガ、CTE) ので、スタックフレームを小さく保つ必要がある。パーサ側で `MAX_EXPR_DEPTH` を 100 に抑えている理由と同じ問題の別の面だ。

`prologue()` が最初に吐く命令は 1 つだけだ。

```rust title="core/vdbe/builder.rs:1916-1936 (抜粋)"
pub fn prologue(&mut self) {
    if self.flags.is_subprogram() {
        // Subprograms (triggers, FK actions) don't need Transaction - they run within parent's tx
        self.init_label = self.allocate_label();
        self.emit_insn(Insn::Init { target_pc: self.init_label });
        self.preassign_label_to_next_insn(self.init_label);
        self.start_offset = self.offset();
        return;
    }
    if self.nested_level == 0 {
        self.init_label = self.allocate_label();
        self.emit_insn(Insn::Init { target_pc: self.init_label });
        self.start_offset = self.offset();
    }
}
```

`Insn::Init` は「プログラムの末尾へ飛べ」という命令だ。末尾に `Transaction` 命令が置かれ、そこから本体の先頭に戻ってくる。**SQLite の生成する命令列と同じ構造**で、`EXPLAIN` の突き合わせが成立するための前提になっている。

### `Resolver` が名前解決の文脈を全部抱える

```rust title="core/translate/mod.rs:112-126 (抜粋)"
let mut resolver = Resolver::new(
    schema,
    connection.database_schemas(),
    &connection.temp.database,
    connection.attached_databases(),
    syms,
    connection.experimental_custom_types_enabled(),
    connection.get_dqs_dml().into(),
    if matches!(origin, crate::statement::StatementOrigin::InternalHelper) {
        Arc::new(crate::dialect::SqliteDialect) as Arc<dyn crate::dialect::Dialect>
    } else {
        connection.dialect()
    },
    &prepare_options.unqualified_database_search_path,
);
```

**内部ヘルパの文だけ、方言を強制的に SQLite に切り替えている。** エンジンが自分で生成する文は常に SQLite テキストなので、Postgres 方言のデータベースであってもそこだけは SQLite として解釈する。`Dialect` のフォールバック要件と同じ理由だ。

`Resolver` 自体は 20 近いフィールドを持ち、そのほとんどが `RefCell` のキャッシュになっている。

```rust title="core/translate/emitter/mod.rs:136-145 (抜粋)"
pub struct Resolver<'a> {
    schema: &'a Schema,
    database_schemas: &'a RwLock<HashMap<usize, Arc<Schema>>>,
    temp_database: &'a RwLock<Option<crate::connection::TempDatabase>>,
    attached_databases: &'a RwLock<DatabaseCatalog>,
    non_main_schema_cache: RefCell<HashMap<usize, Arc<Schema>>>,
    pub symbol_table: &'a SymbolTable,
    pub expr_to_reg_cache_enabled: bool,
    pub expr_to_reg_cache: Vec<CachedExprReg<'a>>,
    // ...
}
```

`Resolver` の寿命が「1 回の translate パス」に限られていることが、いくつかの最適化の根拠になっている。

```rust title="core/translate/emitter/mod.rs:189-197 (抜粋)"
/// Cached flag: true when this connection has an active temp database.
///
/// Computed once at Resolver construction to avoid repeated
/// `RwLock` reads on every table-name resolution. Safe because a
/// `Resolver` is short-lived (single translate pass) and a
/// connection is single-threaded at the VDBE layer: the temp
/// database can only be initialized / torn down *between*
/// Resolvers on the same connection, not during.
```

**「接続は一度に 1 文しか走らせない」という前提が、ここでも根拠として使われている** ([状態の地図のページ](../shared-state-map/))。同じ前提が、Pager の状態機械からパーサ後段のキャッシュまでを支えている。

### `translate_inner` は 68 本の腕を持つ match

```rust title="core/translate/mod.rs:155-160 (抜粋)"
pub fn translate_inner(
    stmt: ast::Stmt,
    resolver: &mut Resolver,
    program: &mut ProgramBuilder,
    connection: &Arc<Connection>,
    input: &str,
```

`Stmt` が 33 バリアントなのに match の腕が 68 本あるのは、同じバリアントをガード付きで複数回受けているからだ。`CreateTable` は本体が `AsSelect` かどうかで分かれ、`AlterTable` は操作の種類で分かれる。

そして重要なのは**`stmt` を値で受けている**ことだ。`&ast::Stmt` ではない。AST は translate に move され、そこで消費される。

これが [クエリの一生のページ](../query-lifecycle/) で見た「スキーマ不一致でリトライするときは AST を clone せずテキストから再パースする」の直接の理由になっている。AST は一度きりの資源として扱われている。

### `Pragma` だけ手前で持ち上げられている

```rust title="core/translate/mod.rs:131-143 (抜粋)"
match stmt {
    // There can be no nesting with pragma, so lift it up here
    ast::Stmt::Pragma { name, body } => {
        pragma::translate_pragma(&resolver, &name, body, pager, connection.clone(), &mut program)?;
    }
    stmt => translate_inner(stmt, &mut resolver, &mut program, &connection, input)?,
};
```

`translate_pragma` だけが `pager` を受け取る。他の文はコンパイル時に Pager を必要としない — バイトコードが実行時に触るだけだ。`PRAGMA` は `page_size` や `cache_size` のように**コンパイル時にページャの状態を読む必要がある**ので、ここだけ引数が増えている。

コメントの「pragma とのネストはありえない」がその正当化だ。`PRAGMA` は他の文の中に現れないので、`translate_inner` の再帰の外に出しても問題ない。

## 守られている不変条件

**`parse` は必ず消費バイト数を返す。** 呼び出し元はセミコロンを自分で探さない。文字列リテラル内のセミコロンで誤爆しないため。

**どの方言実装も、SQLite の正規テキストを読めなければならない。** エンジン内部生成の文が素の SQLite テキストだから。

**AST は 1 回しか使えない。** `translate_inner` に move される。やり直すなら再パースする。

**内部ヘルパ文は常に SQLite 方言で解決される。** データベースの方言に依存しない。

**パラメータ番号は文ごとにリセットされる。** `next_cmd` の冒頭で。

## つまずきどころ / 設計の含み

### `Parser::offset()` の意味が場合分けされている

```rust title="sqlite/parser/src/parser.rs:269-274 (抜粋)"
        // so just take lexer offset
        self.lexer.offset
    } else {
        self.lexer.offset - self.current_token.value.len()
    }
```

先読みしたトークンを持っているかどうかで、返す位置が変わる。`next_cmd` は文末のセミコロンを食べようとして、その先のトークンを 1 つ読んでしまうことがある。そのとき `lexer.offset` は次の文の途中を指しているので、**読んでしまったトークンの長さを引き戻す**。

呼び出し側はこの値でスライスを切るので、1 バイトずれると次の文の先頭が欠ける。複文の実行が壊れる形のバグは、たいていここに帰着する。

### `ProgramBuilder` の `Box` 化がスタックの問題を示している

```rust title="core/translate/mod.rs:102"
// Boxed so the ~800 B builder sits on the heap instead of the prepare frame.
```

800 バイトのビルダをスタックに置けない、という判断が明示されている。パーサの `MAX_EXPR_DEPTH = 100` にも同じ趣旨のコメントがある。

```rust title="sqlite/parser/src/parser.rs:185-189"
/// Maximum query expression depth, our equivalent of SQLite's
/// `SQLITE_MAX_EXPR_DEPTH` (default 1000). Kept lower because our recursive
/// translator/optimizer uses larger stack frames per nesting level, so a
/// 1000-deep tree still overflows a default 8 MiB thread stack in debug builds.
```

**SQLite の 1000 に対して 100。** Rust の翻訳器・最適化器が 1 段あたりに使うスタックが大きいので、10 分の 1 に下げてある。

サーバがないことがここにも効いている。`mysqld` ならスレッドのスタックサイズを自分で決められるが、Turso はアプリケーションのスレッドで動くので、**スタックがどれだけあるかを仮定できない**。8 MiB という「デフォルト」を前提にせざるを得ず、その中で安全側に倒すしかない。

### `sqlite_schema` の読み書きが方言の責任になっている副作用

`format_table_sql` が `input`（ユーザが書いた原文）と AST の両方を受け取る。

```rust title="core/dialect/mod.rs (format_table_sql の doc)"
/// `input` is the original statement text as the user wrote it, in the
/// frontend's dialect; `tbl_name` and `body` are the translated AST.
/// The SQLite dialect formats canonical SQLite text from the AST; a
/// frontend dialect typically stores `input` with a marker it can
/// recognize in [`Dialect::parse_table_sql`].
```

**SQLite 方言は AST から正規テキストを組み立て直し、他の方言は原文をマーカ付きで保存する。** 前者は「ユーザが書いた `create table T ( x int )` が `CREATE TABLE T (x int)` になって返ってくる」ことを意味する。SQLite の挙動に合わせるためだが、DDL を原文のまま保存してほしいアプリケーションには驚きになる。

`ALTER TABLE` の後に別の `format_rewritten_table_sql` が要るのも同じ事情で、**スキーマがテキストで保存されている以上、スキーマ変更はテキストの書き換えになる**。AST を保存できれば要らない往復だが、それをすると `sqlite_schema` のファイル形式互換が壊れる。互換性の制約が、ここでは方言 trait のメソッド数として現れている。
