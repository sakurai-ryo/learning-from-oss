---
title: "pgwire の上に載せ、`pg_catalog` をエミュレートする"
description: "Postgres のクライアントを繋ぐには、ワイヤプロトコルだけでは足りない。psql も ORM も、接続直後に pg_catalog に問い合わせる。Turso はそれを 20 個以上の仮想テーブルとして実装し、sqlite_schema の内容から動的に生成している。OID は名前でソートした順に振る。そして「常に空を返す表」を意図的に用意しているのが、この種の互換レイヤの実務そのものになっている。"
group: "Postgres フロントエンド"
sidebar:
  order: 50
---

## 何を学んだか

`tursopg` を起動すると、Postgres のクライアントがそのまま繋がる。

```text
psql -h localhost -p 5432 mydb.db
```

だが **ワイヤプロトコルを喋るだけでは、何も動かない。** `psql` は接続した瞬間に `pg_catalog` を引き、`\dt` はさらに `pg_class` と `pg_namespace` を結合する。ORM は型情報を `pg_type` から取る。

**プロトコルの互換より、カタログの互換の方が量が多い。** `postgres/frontend/catalog.rs` が 4,093 行あるのに対し、サーバ本体は 934 行しかない。

## ソースコードのどこか

### プロトコルは既存のクレートに任せる

```rust title="postgres/server/lib.rs"
use pgwire::api::auth::StartupHandler;
use pgwire::api::portal::{Format, Portal};
use pgwire::api::query::{ExtendedQueryHandler, SimpleQueryHandler};
use pgwire::api::results::{
    DataRowEncoder, DescribePortalResponse, DescribeStatementResponse, FieldFormat, FieldInfo,
    QueryResponse, Response, Tag,
};
```

[`postgres/server/lib.rs#L14-L26`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L14-L26)。

**`pgwire` クレートがバイト列とメッセージの変換を全部やる。** Turso が実装するのは、`SimpleQueryHandler` と `ExtendedQueryHandler` の 2 つの trait だけになる。

これは判断として素直だ。**ワイヤプロトコルは仕様が固定されていて、正しく実装しても差別化にならない。** ライブラリがあるなら使う。

認証も同じ扱いになっている。

```rust title="postgres/server/lib.rs"
    fn startup_handler(&self) -> Arc<impl StartupHandler> {
        Arc::new(NoopHandler)
    }
```

[`postgres/server/lib.rs#L169-L171`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L169-L171)。

**認証しない。** in-process DB にサーバの顔を付けたものなので、認証の主体がいない。**やらないことを `NoopHandler` として明示している。**

### 複数文の分割は方言に聞く

```rust title="postgres/server/lib.rs"
        // Per the PostgreSQL simple query protocol, a query string may contain
        // multiple semicolon-separated statements. Split and execute each one.
        let statements = split_statements(query)
```

[`postgres/server/lib.rs#L182-L184`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L182-L184)。

simple query プロトコルでは、1 メッセージに複数の文が入る。**その分割を、[`Dialect::parse` が返す「消費バイト数」](../dialect-trait/) を使ってやる。** サーバが `;` で切ろうとしない。

### カタログは仮想テーブルとして登録する

```rust title="postgres/frontend/catalog.rs"
    fn register_catalog(&self, schema: &mut Schema, enable_custom_types: bool) -> Result<()> {
        turso_core::dialect::sqlite::register_builtin_catalog(schema, enable_custom_types)?;
        for vtab in pg_catalog_virtual_tables() {
            schema.add_virtual_table(vtab)?;
        }
        Ok(())
    }
```

[`postgres/frontend/catalog.rs#L139-L145`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L139-L145)。

**まず SQLite の組み込みカタログを登録し、その上に `pg_catalog` を積む。** 置き換えではなく追加になっている。

`pg_class` の定義はこうなる。

```rust title="postgres/frontend/catalog.rs"
    fn sql(&self) -> String {
        // PostgreSQL pg_class columns (simplified subset)
        "CREATE TABLE pg_class (
            oid INTEGER,
            relname TEXT,
            relnamespace INTEGER,
            reltype INTEGER,
            ...
            relhasindex INTEGER,
            relisshared INTEGER,
            relpersistence TEXT,
            relkind TEXT,
```

[`postgres/frontend/catalog.rs#L328-L360`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L328-L360)。

**30 列以上ある。** `relfrozenxid` や `relminmxid` のような、Turso にまったく対応物がない列も含まれている。

なぜ全部並べるのか。**クライアントが `SELECT * FROM pg_class` や `SELECT relfrozenxid FROM ...` を投げてくるから**だ。列がなければエラーになる。値は嘘でも、**列が存在することの方が重要**になる。

「簡略化した部分集合 (simplified subset)」とコメントにあるとおり、本物より少ない。だが `psql` や一般的な ORM が触る範囲は網羅している。

### OID は名前順で振る

```rust title="postgres/frontend/catalog.rs"
/// Starting OID for user tables (matches PostgreSQL convention)
const USER_TABLE_OID_START: i64 = 16384;
```

```rust title="postgres/frontend/catalog.rs"
/// Returns an iterator of (table_name, table_ref) for user tables in deterministic order.
/// Both pg_class and pg_attribute must use this function to ensure consistent OID assignment.
fn user_tables_sorted(schema: &Schema) -> Vec<(&String, &Arc<Table>)> {
    let mut tables: Vec<_> = schema
        .tables
        .iter()
        .filter(|(name, table)| {
            // Skip system tables
            if name.starts_with("sqlite_")
                || name.starts_with("pg_")
                || name.starts_with("pragma_")
                || name.starts_with("json_")
            {
                return false;
            }
            // Skip virtual tables and subqueries
            matches!(table.as_ref(), Table::BTree(_))
        })
        .collect();
    tables.sort_by_key(|(name, _)| *name);
    tables
}
```

[`postgres/frontend/catalog.rs#L13-L224`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L203-L224)。

**Turso のスキーマには OID という概念がない。** だから「名前でソートして、16384 から順に振る」で作り出している。

コメントが要点を突いている。**「`pg_class` と `pg_attribute` の両方がこの関数を使わなければならない。OID の割り当てを一致させるため。」**

`pg_class.oid` と `pg_attribute.attrelid` が結合される。**別々に採番したら、結合が成立しない。**

開始値が 16384 なのは Postgres の慣習に合わせている。**それ未満はシステムオブジェクトの OID なので、そこに被せないようにしている。**

この方式には明白な弱点がある。**テーブルを 1 つ作ると、名前順で後ろにあるテーブルの OID が全部ずれる。** Postgres の OID は不変なので、これは互換ではない。だが、**同じ接続の中で `pg_class` と `pg_attribute` が一致していれば、クライアントの用途はだいたい満たせる。**

### 型の対応表

```rust title="postgres/frontend/catalog.rs"
/// Map a SQLite type string to a PostgreSQL type OID.
/// Strips parenthesized parameters (e.g. `varchar(100)` -> `VARCHAR`) before matching.
fn sqlite_type_to_pg_oid(ty_str: &str) -> i64 {
    let base = match ty_str.find('(') {
        Some(pos) => &ty_str[..pos],
        None => ty_str,
    };
    match base.to_uppercase().as_str() {
        "INTEGER" | "INT" | "INT4" => 23,
        "SMALLINT" | "INT2" => 21,
```

[`postgres/frontend/catalog.rs#L226-L236`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L226-L236)。

**Postgres の型 OID (23 = int4、21 = int2) を直接書いている。** 型の対応は [次のページ](../pg-type-mapping/) の主題になる。

### 「常に空を返す表」を用意する

`postgres/COMPAT.md` の記述が、この種の互換レイヤの実務を端的に表している。

```text title="postgres/COMPAT.md"
The pg_catalog tables emulated (live, reflecting real schema): `pg_class`,
`pg_namespace`, `pg_attribute`, `pg_type` (builtin + array + enum types),
`pg_index`, `pg_constraint`, `pg_attrdef`, `pg_tables`, `pg_sequences`,
`pg_database`, `pg_roles` (single hardcoded `turso` role), `pg_proc`, `pg_am`,
plus `pg_input_error_info`. Present but always empty: `pg_policy`,
`pg_trigger`, `pg_statistic_ext`, `pg_inherits`, `pg_rewrite`,
`pg_foreign_table`, `pg_partitioned_table`, `pg_collation`, `pg_description`,
`pg_publication*`. DML against pg_catalog is rejected.
```

[`postgres/COMPAT.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/COMPAT.md)。

**2 つのグループに分かれている。**

1. **実際のスキーマを反映する表** — 14 個
2. **存在するが常に空の表** — 10 個

2 番目が実務的な発明になっている。**行レベルセキュリティも、トリガも、パーティションも、Turso にはない。** だが `psql` の `\d` は `pg_policy` や `pg_inherits` を LEFT JOIN する。

**表がなければクエリが失敗する。空を返せば「そういう機能を使っていないデータベース」として正しく表示される。**

「存在しない」と「空である」の違いが、ここでは決定的になる。

`pg_roles` に「`turso` という 1 つのロールをハードコード」とあるのも同じで、**認証がないのでロールの概念もない。だが 0 件だとクライアントが困る。**

`pg_get_expr` の注記も正直だ。**「TursoPG が保存している SQL を返す。リレーションの OID や整形の指定は出力を変えない。」** [方言のページ](../dialect-trait/) で見た「原文をマーカー付きで保存する」判断が、ここで配当を出している。**原文があるから、`pg_get_expr` が何かを返せる。**

そして `obj_description()` は **常に NULL を返す。理由は「`COMMENT ON` を永続化していないから」。**

### できないことを明示的に並べる

```text title="postgres/COMPAT.md"
| 64-bit large objects | ❌ Not supported | |
| Advisory locks | ❌ Not supported | |
| Custom background workers | ❌ Not supported | |
...
| SQL-standard information schema | ❌ Not supported | Only an `information_schema` row in pg_namespace; no views |
```

**Postgres の公式機能マトリクスを丸ごと持ってきて、対応状況を埋めている。**

```text title="postgres/COMPAT.md"
This document tracks PostgreSQL feature compatibility for the Turso Postgres
frontend. The feature list is based on the official
[PostgreSQL feature matrix](https://www.postgresql.org/about/featurematrix/),
with additional rows for baseline features the matrix does not enumerate.
```

**リストを自分で作らない。** 相手が公開している機能一覧を骨格にすれば、「書き忘れ」がなくなる。583 行の表が、そうやって作られている。

`information_schema` の注記が細かい。**「`pg_namespace` に `information_schema` という行があるだけで、ビューはない」。** 名前空間だけ存在させたのは、そこを引くクライアントがいるからだろう。「部分的にある」を正確に書いている。

### カタログへの書き込みは拒否する

```text title="postgres/COMPAT.md"
DML against pg_catalog is rejected.
```

**`INSERT INTO pg_class` は失敗する。** これらは仮想テーブルなので、書き込みの実装がない。

Postgres でもスーパーユーザ以外は書けないので、**振る舞いとしては合っている。**

### 「サポートしているが挙動が違う」を分ける

```text title="postgres/COMPAT.md"
| Operators: `\|\|`, `%`, bitwise, ILIKE, SIMILAR TO, `~`/`~*`/`!~`/`!~*`, IS [NOT] DISTINCT FROM, BETWEEN | ✅ Supported | Regex operators lower to REGEXP; case-insensitive variants treated as sensitive |
| SET / SHOW | 🟡 Partial | Passed through as PRAGMAs; no PostgreSQL GUCs (e.g. `SHOW search_path` returns nothing) |
```

**`~*` (大文字小文字を無視する正規表現マッチ) は「サポート」だが、実際には大文字小文字を区別する。**

これを ✅ にするかどうかは判断が要る。構文は通り、多くの場合は期待どおり動く。だが ASCII の大文字小文字が混ざると結果が違う。

**Turso は ✅ にしたうえで、注記に差分を書いた。** ❌ にすると「使えない」と読まれるが、実際には使える。✅ だけだと嘘になる。**3 段階 (✅ / 🟡 / ❌) と注記の組み合わせで、その中間を表現している。**

`SET` / `SHOW` を 🟡 にして「`PRAGMA` として素通しする」と書いているのも同じで、**動く場合と動かない場合の境界が読者に分かる。**

## なぜそうなっているか

- **ワイヤプロトコルを既存のクレートに任せたのは、実装しても差別化にならないから。** 仕様が固定されていて、正しく実装するだけの領域は買ってくる。
- **認証を `NoopHandler` にしたのは、認証の主体がいないから。** in-process DB にサーバの顔を付けただけなので、利用者という概念がない。やらないことを明示する。
- **カタログの方が量が多いのは、クライアントがそこを見るから。** プロトコルが正しくても、`pg_class` がなければ `psql` は 1 つも表を表示できない。
- **列を全部並べたのは、クライアントが名指しで引くから。** 値が嘘でも、列がないとクエリが失敗する。
- **OID を名前順で採番したのは、Turso に OID の概念がないから。** 決定的に作れれば、同じ接続内での整合性は保てる。
- **採番の関数を 1 つにしたのは、複数の表が結合されるから。** `pg_class` と `pg_attribute` が別々に採番したら、結合が成立しない。
- **常に空の表を用意したのは、「存在しない」と「空」が違うから。** LEFT JOIN される表がないとクエリが落ちるが、空なら正しく表示される。
- **`pg_roles` に 1 行入れたのは、0 件だとクライアントが困るから。** 「該当なし」と「未対応」を区別できないクライアントがある。
- **機能一覧を相手の公式マトリクスから作ったのは、書き忘れをなくすため。** 自分でリストを作ると、知らない機能は載らない。
- **「サポートしているが挙動が違う」を注記で表したのは、✅ でも ❌ でも嘘になるから。** 3 段階と注記の組み合わせで中間を表す。

## どう活かすか

- **互換レイヤを作るとき、プロトコルとメタデータの量を見誤らない。** クライアントは接続直後にメタデータを引く。プロトコルが完璧でも、そこで詰まる。
- **仕様が固定された部分は、既存の実装を使う。** ワイヤプロトコル、圧縮、暗号。正しく実装するだけの領域に時間を使わない。
- **やらないことは、明示的な「何もしない実装」として置く。** 空の実装に名前が付いていれば、後から埋める場所が分かる。
- **メタデータの列は、値が嘘でも全部揃える。** クライアントは名指しで引く。列がないと失敗するが、値が嘘でも動くことは多い。
- **相手側にしかない識別子は、決定的な規則で作り出す。** 「名前でソートして連番」で十分なことは多い。ただし複数箇所で同じ値が要るなら、生成を 1 箇所に集める。
- **「存在するが空」を積極的に使う。** 「未実装なので表がない」は、その表を LEFT JOIN するクエリを全部落とす。空を返せば正しく表示される。
- **対応状況の一覧は、相手が公開している機能リストを骨格にする。** 自分で作ると、知らない機能が抜ける。
- **「動くが挙動が違う」を表現できる段階を用意する。** 2 値では表せない。3 段階 + 注記なら、利用者が自分の用途に当てはめて判断できる。
- **正確に保存しておくと、後から使える。** 「原文をそのまま残す」判断が、カタログ関数を実装するときに効いてくる。
