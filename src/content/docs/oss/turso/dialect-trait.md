---
title: "エンジンと SQL 方言の境界を trait で切る"
description: "同じエンジンに Postgres の顔を付けるために、「SQL テキストの意味を決める部分」だけを trait に切り出した。パース、sqlite_schema に保存する DDL の書式、カタログ表の登録、関数名の解決。境界の引き方が巧みで、方言は元の DDL をマーカー付きで保存し、マーカーのない行は SQLite として読む。エンジンが内部で書いた行と、利用者が書いた行が同じテーブルに混ざるからだ。"
group: "エンジンの拡張点"
sidebar:
  order: 28
---

## 何を学んだか

Turso には Postgres のワイヤプロトコルで話すフロントエンドがある ([次のページ](../postgres-wire/))。だが、それを載せるには **エンジンの側に「SQL 方言」という概念**が必要になる。

`CREATE TABLE t (id serial PRIMARY KEY)` は Postgres では有効だが SQLite では違う。一方で、ページも B-tree も VDBE も、方言とは無関係だ。**どこで線を引くか**がこのページの主題になる。

```rust title="core/dialect/mod.rs"
//! SQL dialects.
//!
//! The [`Dialect`] trait is the boundary between the engine and the SQL
//! dialect a frontend speaks. The engine owns the mechanics — pages,
//! B-trees, the `sqlite_schema` table itself, bytecode — and consults the
//! dialect wherever the meaning of SQL text is dialect-specific: parsing
//! statements into the engine AST and interpreting persisted schema text.
```

[`core/dialect/mod.rs#L1-L12`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/dialect/mod.rs#L1-L12)。

**「エンジンは仕組みを所有し、SQL テキストの意味が方言依存になる箇所でだけ方言に問い合わせる」。**

境界の定義が 1 文で書かれている。そして重要なのは、**`sqlite_schema` テーブル自体はエンジンが所有する**と明記されていることだ。**入れ物はエンジン、中身の解釈は方言。**

## ソースコードのどこか

### 方言が答える 9 つのこと

trait のメソッドを並べると、境界の形が見える。

| メソッド                                    | 何を決めるか                                      |
| ------------------------------------------- | ------------------------------------------------- |
| `name`                                      | 方言の識別子                                      |
| `parse`                                     | SQL テキスト → エンジンの AST                     |
| `parse_table_sql`                           | `sqlite_schema` の行 → テーブル定義               |
| `parse_table_sql_ast`                       | `sqlite_schema` の行 → `CREATE TABLE` の AST      |
| `table_sql_for_replay`                      | 保存済み SQL → 再実行できる SQL                   |
| `format_table_sql`                          | `CREATE TABLE` → `sqlite_schema` に保存する文字列 |
| `format_rewritten_table_sql`                | 書き換え後の AST → 保存する文字列                 |
| `register_catalog`                          | カタログ表 (`pg_catalog` など) の登録             |
| `resolve_function` / `exec_scalar_function` | 関数名の解決と実行                                |

**9 つのうち 5 つが、スキーマの保存と読み出しに関するもの**になっている。ここが一番難しいことが、メソッドの配分に出ている。

### 保存する DDL は「原文 + マーカー」

```rust title="core/dialect/mod.rs"
    /// Produce the SQL text to store in `sqlite_schema` for a
    /// `CREATE TABLE`.
    ///
    /// `input` is the original statement text as the user wrote it, in the
    /// frontend's dialect; `tbl_name` and `body` are the translated AST.
    /// The SQLite dialect formats canonical SQLite text from the AST; a
    /// frontend dialect typically stores `input` with a marker it can
    /// recognize in [`Dialect::parse_table_sql`].
```

[`core/dialect/mod.rs#L76-L84`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/dialect/mod.rs#L76-L84)。

**Postgres 方言は、利用者が書いた原文をそのまま保存する。** 実装がこれだ。

```rust title="postgres/frontend/catalog.rs"
const STORED_PG_SCHEMA_PREFIX: &str = "/* turso_frontend:postgres */ ";
```

[`postgres/frontend/catalog.rs#L16`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L16)。

**SQL のコメントをマーカーにしている。** `/* turso_frontend:postgres */` を頭に付けて保存する。

なぜ AST から SQLite の標準形に直して保存しないのか。**戻せなくなるから**だ。`serial` を `INTEGER` に直して保存すると、`pg_get_tabledef` のようなカタログ関数が元の型名を答えられない。

コメントをマーカーに選んだのも意図的で、**`sqlite_schema` の中身は SQL テキストとして有効でなければならない**。コメントなら、他のツールが読んでも構文エラーにならない。

### マーカーのない行は SQLite として読む

```rust title="core/dialect/mod.rs"
    /// Rows written by internal engine paths (sequence backing tables,
    /// `sqlite_sequence`) are plain SQLite text and carry no frontend
    /// marker, so every implementation must fall back to SQLite parsing
    /// for text it does not recognize as its own.
```

[`core/dialect/mod.rs#L43-L47`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/dialect/mod.rs#L43-L47)。

**エンジン自身が `sqlite_schema` に行を書く。** `sqlite_sequence`、シーケンスの裏テーブル。これらは方言を知らないので、SQLite の標準形で書かれる。

つまり **1 つの `sqlite_schema` に、2 種類の書式が混在する。** 方言の実装は、必ず SQLite へのフォールバックを持たなければならない。

実装がそのとおりになっている。

```rust title="postgres/frontend/catalog.rs"
    fn parse_table_sql(&self, sql: &str, root_page: i64) -> Result<BTreeTable> {
        // Schema rows written by internal SQLite paths (e.g. sqlite_sequence)
        // carry no frontend marker and are plain SQLite SQL.
        let Some(raw_sql) = decode_stored_pg_schema_sql(sql) else {
            return BTreeTable::from_sql(sql, root_page);
        };
```

[`postgres/frontend/catalog.rs#L52-L57`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L52-L57)。

**マーカーがなければ SQLite として読む。** この分岐が 3 つのメソッドすべてに出てくる。

**「拡張した表現と、拡張前の表現が同じ場所に混ざる」は、後から機能を足すときにほぼ必ず起きる。** マーカーで区別し、ないものは元の解釈にする、という形が定石になる。

### パースにもフォールバックがある

```rust title="postgres/frontend/catalog.rs"
    fn parse(&self, sql: &str) -> Result<(Option<turso_parser::ast::Cmd>, usize)> {
        // Engine-generated helper statements and pragmas are canonical SQLite
        // text that pg_query rejects, so anything the PostgreSQL parser cannot
        // handle falls back to SQLite parsing.
        let Ok(parse_result) = turso_pg_parser::parse(sql) else {
            return turso_core::dialect::sqlite::parse(sql);
        };
```

[`postgres/frontend/catalog.rs#L26-L32`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L26-L32)。

**エンジンが内部で組み立てる SQL は、SQLite の構文で書かれている。** `PRAGMA` も Postgres のパーサは受け付けない。

だから **Postgres のパーサが失敗したら、SQLite のパーサで試す。**

翻訳の失敗も同じ扱いになっている。

```rust title="postgres/frontend/catalog.rs"
        match translator.translate(&parse_result) {
            Ok(stmt) => Ok((Some(turso_parser::ast::Cmd::Stmt(stmt)), consumed)),
            Err(_) => turso_core::dialect::sqlite::parse(sql),
        }
```

[`postgres/frontend/catalog.rs#L45-L49`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L45-L49)。

**パースは通ったが、エンジンの AST に翻訳できなかった場合も SQLite で試す。** Postgres の構文で書けるが Turso が翻訳できない文と、そもそも SQLite の文である場合を、この 1 本のフォールバックがまとめて扱っている。

trait 側にも同じ要求が書いてある。

```rust title="core/dialect/mod.rs"
    /// Implementations must accept the
    /// canonical SQLite text produced by the engine AST formatter because
    /// engine-generated and AST-only statements use that representation.
```

[`core/dialect/mod.rs#L38-L40`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/dialect/mod.rs#L38-L40)。

**「実装は、エンジンが生成する SQLite の標準形を必ず受け付けなければならない」** が契約になっている。

### 複数文の切り出しも方言が決める

```rust title="postgres/frontend/catalog.rs"
        // The translator consumes the first statement only; report how many
        // input bytes it covers so multi-statement iteration can resume after
        // it. pg_query records where the next statement starts, which also
        // accounts for the semicolon and any trailing whitespace in between.
        let consumed = match stmts.get(1) {
            Some(next) => next.stmt_location as usize,
            None => sql.len(),
        };
```

[`postgres/frontend/catalog.rs#L36-L44`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L36-L44)。

`parse` の戻り値が **`(AST, 消費したバイト数)`** になっているのは、これのためだ。

**「`;` で切れば複数文に分けられる」は成り立たない。** 文字列リテラルの中の `;`、コメントの中の `;`、Postgres のドル引用符 (`$$ ... $$`)。方言ごとに規則が違う。

**エンジンは「次はどこから読めばいいか」を方言に聞く。** 自分で切ろうとしない。

### 開くときに方言が一致することを確かめる

```rust title="core/dialect/mod.rs"
    /// Stable identifier for this dialect (e.g. "sqlite", "postgres").
    ///
    /// A database file must always be opened with the same dialect it was
    /// created with; the process-wide database registry uses this name to
    /// reject an open whose dialect differs from the already-open instance.
    fn name(&self) -> &'static str;
```

[`core/dialect/mod.rs#L26-L31`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/dialect/mod.rs#L26-L31)。

**Postgres として作ったファイルを SQLite の方言で開くと、マーカー付きのスキーマ行が読めない** (正確には、コメントとして無視されて別の解釈になる)。だから同じプロセス内で違う方言で開くことを拒否する。

`Database` にも「開いた時点で固定」と書かれている。

```rust title="core/database.rs"
    /// SQL dialect this database runs under, interpreting `sqlite_schema`
    /// SQL rows. Passed explicitly by every open path, fixed at open time,
    /// and shared by all connections because the parsed [`Schema`] is
    /// shared per database.
    dialect: Arc<dyn Dialect>,
```

[`core/database.rs#L545-L550`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/database.rs#L545-L550)。

**理由が「パースされた `Schema` がデータベース単位で共有されるから」。** 接続ごとに方言を変えられるようにすると、スキーマも接続ごとに持つことになる。

### 既定実装で、必須の責務を減らす

```rust title="core/dialect/mod.rs"
    fn exec_scalar_function(
        &self,
        _conn: &crate::Connection,
        name: &str,
        _args: &[crate::Value],
    ) -> crate::Result<crate::Value> {
        Err(crate::LimboError::ParseError(format!(
            "no such function: {name}"
        )))
    }
```

```rust title="core/dialect/mod.rs"
    /// Whether this dialect needs the custom-type machinery (DECODE/ENCODE,
    /// affinity metadata) regardless of the experimental database flag.
    /// A dialect whose type system leans on custom types (e.g. PostgreSQL)
    /// returns true so its databases never open with the machinery off.
    fn requires_custom_types(&self) -> bool {
        false
    }
```

[`core/dialect/mod.rs#L142-L159`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/dialect/mod.rs#L142-L159)。

**`exec_scalar_function` は、方言固有の関数を持たない実装なら実装しなくていい。** `resolve_function` が `Func::Dialect` を返さなければ、ここには到達しない。

`requires_custom_types` は逆向きで、**方言が実験的機能を必須として要求できる**。Postgres の型システムはカスタム型の仕組みに依存しているので、[実験的機能のフラグ](../sqlite-compat/) が立っていなくても有効になる。

**「利用者が選ぶ機能」と「方言が必要とする機能」を区別している。**

### テスト用の方言が最小の実装例になっている

```rust title="core/dialect/mod.rs"
    /// A dialect that counts schema-row parses and strips a `/* test */ `
    /// marker before delegating to SQLite parsing, mirroring how a frontend
    /// dialect recognizes its own stored text and falls back to SQLite for
    /// unmarked rows.
    #[derive(Default)]
    struct TestDialect {
```

[`core/dialect/mod.rs#L164-L181`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/dialect/mod.rs#L164-L181)。

**`core` のテストの中に、Postgres 方言を模した最小の方言が入っている。** マーカーを付けて剥がすだけで、あとは SQLite に委譲する。

これで **`postgres` クレートに依存せずに、`Dialect` の契約をテストできる。** しかも「マーカーで自分の行を認識し、ないものは SQLite にフォールバックする」という実装パターンが、そのまま例として残る。

`parse_calls` を数えているのも面白くて、**「スキーマの再読み込みのたびに何回パースされるか」を検証している。** 拡張点のインタフェースは、呼ばれる回数も契約の一部になる。

## なぜそうなっているか

- **方言の境界を「SQL テキストの意味」に置いたのは、それ以外が共通だから。** ページも B-tree もバイトコードも方言に依存しない。依存するのはテキストの解釈だけになる。
- **`sqlite_schema` の入れ物をエンジンが持ち、中身の解釈を方言に渡したのは、物理形式を変えたくないから。** [ファイル形式は動かせない](../sqlite-compat/)。テキストの中身なら自由がある。
- **原文をマーカー付きで保存したのは、標準形に直すと戻せないから。** `serial` を `INTEGER` にすると、元の型名を答えられなくなる。
- **マーカーに SQL のコメントを使ったのは、テキストとして有効でなければならないから。** 他のツールが読んでも構文エラーにならない。
- **SQLite へのフォールバックを必須にしたのは、エンジン自身が行を書くから。** 内部で作るテーブルは方言を知らない。1 つのテーブルに 2 種類の書式が混ざる。
- **パースにも同じフォールバックがあるのは、エンジンが SQL を組み立てるから。** `PRAGMA` も内部のヘルパ文も、SQLite の構文で書かれている。
- **消費したバイト数を返させるのは、文の切り方が方言ごとに違うから。** `;` で切るのは、リテラルやコメントや特殊な引用の中では成り立たない。
- **方言をデータベース単位で固定したのは、スキーマが共有されるから。** 接続ごとに変えると、パース済みのスキーマも接続ごとに持つことになる。
- **既定実装を用意したのは、方言固有の関数を持たない実装があるから。** 必須の責務を最小にすると、新しい方言を足すコストが下がる。
- **方言が機能を必須にできるのは、型システムが依存するから。** 「利用者が選ぶ機能」と「方言の前提」は別物として扱う。
- **テスト用の最小方言を `core` に置いたのは、依存の向きを保つため。** `core` が `postgres` に依存すると、循環する。

## どう活かすか

- **拡張点の境界は、「何が変わるか」ではなく「何が変わらないか」から決める。** 変わらない部分 (物理形式、実行機構) を本体に残し、変わる部分だけを問い合わせる形にする。
- **利用者の入力を保存するときは、正規化した形ではなく原文を残すことを検討する。** 正規化すると情報が落ちて、後から復元できない。
- **拡張した表現には、既存の形式の中で無害なマーカーを付ける。** SQL ならコメント、JSON なら予約キー、HTTP ならヘッダ。既存のパーサが壊れない場所を選ぶ。
- **マーカーのないデータを、必ず元の解釈にフォールバックさせる。** 本体自身がデータを書く場所では、拡張前の形式が混ざることが避けられない。
- **入力をどこまで消費したかを、拡張側に答えさせる。** 区切りの規則が拡張ごとに違うなら、本体が切ろうとしてはいけない。
- **拡張の同一性を識別子で持ち、開くときに突き合わせる。** 違う拡張で開いたときの壊れ方は、たいてい静かで見つけにくい。
- **既定実装で、必須の責務を最小にする。** 「この経路に到達しない実装なら書かなくていい」という関係を作れれば、拡張の敷居が下がる。
- **拡張が本体の機能を必須として要求できるようにする。** 利用者の選択と、拡張の前提は別の話になる。
- **本体のテスト内に、最小の拡張実装を置く。** 依存の向きを保ったまま契約を検証でき、実装例としても機能する。呼ばれる回数まで検証すると、契約がより明確になる。
