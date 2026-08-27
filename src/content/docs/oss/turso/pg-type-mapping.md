---
title: "動的型付けのエンジンに、静的型のワイヤプロトコルを載せる"
description: "Postgres のプロトコルは、結果を返す前に列の型 OID を宣言しなければならない。SQLite の値は行ごとに型が違いうる。この溝を埋めるために、Turso は CREATE TYPE という汎用のカスタム型機構を先に作り、boolean や uuid や inet をその上に載せた。Postgres 方言はカスタム型機構を必須として要求する。そして型が決まらない場合の既定は TEXT で、値ごとの食い違いはエンコード側が吸収する。"
group: "Postgres フロントエンド"
sidebar:
  order: 30
---

## 何を学んだか

Postgres のワイヤプロトコルには `RowDescription` というメッセージがある。**行を 1 つも返す前に、各列の型 OID を宣言する。**

`Describe` に至っては、**まだ実行していない文について**列の型を答えなければならない。

SQLite は逆で、**型は列ではなく値に付く**。同じ列に整数とテキストが混在できる。`SELECT x FROM t` の `x` が何型かは、行を見るまで分からない。

**「宣言してから返す」プロトコルと「返してから分かる」エンジンを、どう繋ぐか。** これがこのページの問題になる。

Turso の答えは 2 段構えだった。

1. **エンジン側に汎用のカスタム型機構を作る** — `CREATE TYPE`
2. **Postgres 方言はそれを必須として要求する** — `requires_custom_types()`

## ソースコードのどこか

### まず、エンジン側に型を足せるようにする

```text title="docs/sql-reference/statements/create-type.mdx"
CREATE TYPE [IF NOT EXISTS] type-name [(parameters)]
    BASE base-type
    ENCODE encode-expr
    DECODE decode-expr
    [OPERATOR 'op' [function-name] ...]
    [DEFAULT default-expr];
```

```text title="docs/sql-reference/statements/create-type.mdx"
A custom type wraps one of the four base storage types with user-defined logic. When a value is written to a column of a custom type, the ENCODE expression transforms it before storage. When a value is read, the DECODE expression transforms it back. This lets you store data in an efficient on-disk representation while presenting a different form to queries.
```

[`docs/sql-reference/statements/create-type.mdx`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/sql-reference/statements/create-type.mdx)。

**カスタム型は「4 つの基本ストレージ型のどれかを包む」。** 書くときに `ENCODE` を通し、読むときに `DECODE` を通す。

例が分かりやすい。

```sql
CREATE TYPE IF NOT EXISTS cents BASE integer ENCODE value * 100 DECODE value / 100;
```

**ディスク上は整数、クエリから見ると小数。** 保存の表現と見せ方を分離できる。

そして制約が 1 つある。

```text title="docs/sql-reference/statements/create-type.mdx"
Custom types work only with STRICT tables. Using a custom type name in a non-STRICT table has no effect.
```

**`STRICT` テーブルでしか効かない。** SQLite の `STRICT` は「宣言した型に合わない値を拒否する」モードで、**そこでは既に「列に型がある」ことになっている。**

**動的型付けの中に、静的型付けの島を作る。** その島の上でなら、型の変換や検証が意味を持つ。

### Postgres の型は、その島の上に載る

```text title="postgres/COMPAT.md"
Type mapping: serial/smallserial/bigserial (and serial2/4/8) become
`INTEGER NOT NULL DEFAULT nextval(...)` with an implicit sequence. boolean,
smallint, bigint, uuid, date, time, timestamp[tz], bytea, json, jsonb, inet,
cidr, macaddr, macaddr8 map to Turso custom types. varchar(n)/char(n) and
numeric(p,s) keep their type modifiers. interval, xml, tsvector/tsquery,
bit/varbit, geometric types degrade to TEXT; money to REAL; OID/reg* types to
INTEGER. Unknown type names pass through as custom types.
```

[`postgres/COMPAT.md#L113-L119`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/COMPAT.md)。

**この 1 段落に、4 つの異なる戦略が並んでいる。**

| 戦略                     | 対象                                      | 何をするか                                                 |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------------- |
| **構文糖として展開**     | `serial`                                  | `INTEGER NOT NULL DEFAULT nextval(...)` + 暗黙のシーケンス |
| **カスタム型として実装** | `boolean`, `uuid`, `date`, `inet`, `json` | `ENCODE` / `DECODE` / 検証を書く                           |
| **修飾子を保持**         | `varchar(n)`, `numeric(p,s)`              | 長さや桁数を保存して検証する                               |
| **降格させる**           | `interval`, `xml`, `tsvector`, 幾何型     | TEXT として扱う。検証しない                                |

**最後の「降格」が正直だ。** `xml` 型の列は作れるが、中身は検証されない。**「エラーにする」でも「完全に実装する」でもない第三の道**を選んでいる。

`money` を `REAL` にしているのは危うい選択だが、それも書いてある。**書いてあれば、利用者が避けられる。**

そして最後の一文。**「知らない型名は、カスタム型として素通しする」。** 未知の型を拒否せず、名前だけ保持して TEXT 相当で扱う。**カスタム型の機構が汎用だから、これができる。**

### 方言が機構を必須にする

```rust title="postgres/frontend/catalog.rs"
    fn requires_custom_types(&self) -> bool {
        true
    }
```

[`postgres/frontend/catalog.rs#L158-L160`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/frontend/catalog.rs#L158-L160)。

カスタム型は [実験的機能](../sqlite-compat/) で、通常は `--experimental-custom-types` が要る。

**Postgres 方言は、それを無条件に有効にする。** [方言のページ](../dialect-trait/) で見た「利用者が選ぶ機能」と「方言が必要とする機能」の区別が、ここで実際に使われている。

`boolean` も `uuid` もカスタム型で実装されているので、**機構がないと Postgres 方言は成立しない。** 「フラグを立て忘れると boolean 型が壊れる」ではなく、方言が要求する形にしてある。

### 列の型は、実行前に答える

```rust title="postgres/server/lib.rs"
/// Build FieldInfo metadata from a prepared statement's column information.
fn build_field_info(stmt: &turso_core::Statement, format: &Format) -> Vec<FieldInfo> {
    (0..stmt.num_columns())
        .map(|i| {
            let name = stmt.get_column_name(i).into_owned();
            let pg_type = resolve_pg_type_for_column(stmt, i);
            FieldInfo::new(name, None, None, pg_type, format.format_for(i))
        })
        .collect()
}
```

[`postgres/server/lib.rs#L287-L295`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L287-L295)。

**`prepare` しただけの `Statement` から、列の型を引く。** 1 行も実行していない。

```rust title="postgres/server/lib.rs"
/// Decide the PG wire type for a result column.
///
/// `get_column_type_info` is the single source of truth: it handles direct
/// table-column references (declared name, array depth, custom-type kind,
/// resolved primitive), bare literals (`SELECT 42` -> INTEGER), and typed
/// expressions like CAST. When it returns `Ok(None)` (no determined primitive)
/// or `Err` (custom types not enabled — won't happen in PG mode, but the wire
/// layer shouldn't panic if it does), the safe default is TEXT;
/// `encode_value` already handles per-value type mismatches.
fn resolve_pg_type_for_column(stmt: &turso_core::Statement, idx: usize) -> Type {
    use turso_core::ColumnTypeKind;

    let Some(info) = stmt.get_column_type_info(idx).ok().flatten() else {
        return Type::TEXT;
    };
```

[`postgres/server/lib.rs#L297-L311`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L297-L311)。

**「型が決まらないときの安全な既定は TEXT」** と明記されている。

なぜ TEXT が安全なのか。**Postgres のテキストフォーマットでは、どんな値も文字列として送れる。** クライアントは文字列を受け取って、自分で解釈できる。他の型を宣言して違う型の値が来ると、クライアントのパースが失敗する。

そして続きが重要になる。**「値ごとの型の食い違いは `encode_value` が既に扱っている」。**

型の推論が外れることを前提にしている。**宣言した型と、実際に来た値の型が違ってもいい。** その調整をエンコード側でやる。

### エンコード側が食い違いを吸収する

```rust title="postgres/server/lib.rs"
        Value::Numeric(turso_core::Numeric::Integer(i)) => {
            // Boolean columns: encode as true/false instead of 0/1
            if *pg_type == Type::BOOL {
                encoder
                    .encode_field(&(*i != 0))
```

[`postgres/server/lib.rs#L547-L552`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L547-L552)。

**エンジンの中では `boolean` は整数 0/1 で保存されている。** 宣言した型が `BOOL` なら、`true`/`false` として送る。

`encode_value` が **値と宣言型の両方を受け取る**のがポイントで、値だけでは判断できない。

タイムゾーンの調整も同じ形になっている。

```rust title="postgres/server/lib.rs"
            // For TIMESTAMPTZ columns, ensure timezone info is present so clients
            // parse the value correctly (as UTC, not local time).
            // TIMESTAMP (without TZ) should NOT have timezone suffix.
            if *pg_type == Type::TIMESTAMPTZ
                && !text.contains('+')
                && !text.contains('Z')
                && !text.ends_with("-00")
            {
                let with_tz = format!("{text}+00");
```

[`postgres/server/lib.rs#L564-L572`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L564-L572)。

**タイムゾーンが付いていなければ `+00` を足す。** 付けないと、クライアントがローカル時刻として解釈する。**同じ値が、クライアントのタイムゾーン設定によって違う時刻になる。**

`TIMESTAMP` (タイムゾーンなし) には付けてはいけない、と但し書きがある。**似た 2 つの型で扱いが逆になる。**

配列の扱いは、ライブラリの都合との折衝になっている。

```rust title="postgres/server/lib.rs"
            } else if pg_type.name().starts_with('_') {
                // Array types: pgwire's to_sql_text quotes strings containing
                // {, }, or commas when the type is Kind::Array. Since we store
                // array values as pre-formatted PG array literals (e.g.
                // "{1,2,3}"), encode with Type::TEXT to bypass the quoting.
                encoder
                    .encode_field_with_type_and_format(
                        &text,
                        &Type::TEXT,
                        FieldFormat::Text,
                        &FormatOptions::default(),
                    )
```

[`postgres/server/lib.rs#L576-L588`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L576-L588)。

**Turso は配列を既に `{1,2,3}` という Postgres の書式で保持している。** `pgwire` に配列型として渡すと、二重に引用符を付けられる。

だから **TEXT として渡して、ライブラリの整形を回避する。** 宣言した型 (`_int4`) と、エンコードに使う型 (`text`) を分けている。

**「宣言する型」と「エンコードに使う型」が別物でよい**、というのがこの設計の柔軟なところになる。

### 内部表現を隠すか、見せるか

```rust title="postgres/server/lib.rs"
    // STRUCT and UNION columns live as BLOBs on disk, but exposing them as
    // BYTEA would force clients to deal with raw bytes. Map them to JSONB so
    // libpq/psql/JDBC see structured data they can introspect.
    let mut base = match info.kind {
        ColumnTypeKind::Struct | ColumnTypeKind::Union => Type::JSONB,
```

[`postgres/server/lib.rs#L313-L317`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L313-L317)。

**ディスク上は BLOB だが、`BYTEA` として見せない。** クライアントが生バイト列を渡されても何もできない。

`JSONB` として宣言すれば、`psql` も JDBC も **構造を持ったデータとして扱える**。

**「保存形式に忠実に見せる」ことと「クライアントが使える形で見せる」ことは違う。** 互換レイヤは後者を選ぶべきだ、という判断になる。

### 宣言名を優先し、解決後の型に落とす

```rust title="postgres/server/lib.rs"
            // Prefer the declared name (the user-visible type), then fall
            // back to the resolved base for custom/domain types whose
            // declared name isn't in the lookup table.
            let mapped = sqlite_type_to_pg_type(&info.declared_name);
            if mapped == Type::TEXT {
                info.base_type
                    .as_deref()
                    .map(sqlite_type_to_pg_type)
                    .unwrap_or(Type::TEXT)
            } else {
                mapped
            }
```

[`postgres/server/lib.rs#L318-L330`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L318-L330)。

**2 段階の解決。** まず利用者が書いた型名 (`uuid`、`inet`) で引き、対応がなければ基底型 (`TEXT`、`INTEGER`) で引く。

「利用者から見える型」を優先するのは、**カスタム型の名前がそのまま Postgres の型名であることが多いから**だ。`CREATE TABLE t (id uuid)` と書いたなら、`uuid` として宣言したい。

対応表になければ基底型に落ちる。**知らないカスタム型も、その基底型として動く。**

### 配列は、スカラ型から導く

```rust title="postgres/server/lib.rs"
    if info.array_dimensions > 0 {
        base = scalar_pg_type_to_array_type(&base);
    }
    base
}

/// Map a scalar PG type to its array counterpart.
fn scalar_pg_type_to_array_type(scalar: &Type) -> Type {
    if *scalar == Type::INT4 {
        Type::INT4_ARRAY
    } else if *scalar == Type::INT8 {
        Type::INT8_ARRAY
```

[`postgres/server/lib.rs#L333-L350`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/postgres/server/lib.rs#L333-L350)。

**スカラ型を解決してから、配列に持ち上げる。** 「配列型」を対応表に別途持たない。

Postgres の型システムでは、すべてのスカラ型に対応する配列型が定義されている。**その規則性を利用して、対応表を 1 つに保っている。**

## なぜそうなっているか

- **カスタム型機構を先に作ったのは、Postgres の型が 20 個以上あるから。** 1 つずつエンジンに組み込むと、エンジンが Postgres を知ることになる。汎用の仕組みの上に載せれば、エンジンは型を知らないままでいられる。
- **`STRICT` テーブル限定にしたのは、そこにしか「列の型」がないから。** 動的型付けのテーブルでは、`ENCODE` / `DECODE` を適用する対象が定まらない。
- **方言が機構を必須にしたのは、なければ成立しないから。** フラグの立て忘れで `boolean` が壊れる、という状態を作らない。
- **型が決まらないときの既定を TEXT にしたのは、テキスト形式なら何でも送れるから。** 他の型を宣言して違う型の値が来ると、クライアント側でパースが失敗する。
- **エンコードに宣言型を渡すのは、値だけでは判断できないから。** 整数の 1 を `1` として送るか `true` として送るかは、列の型で決まる。
- **タイムゾーンを補うのは、付けないとクライアントが別の時刻として読むから。** 値は同じでも、解釈が環境で変わるものは、明示的に固定する。
- **宣言する型とエンコードに使う型を分けたのは、ライブラリの整形を回避するため。** 既に目的の書式になっているものを、もう一度整形されると壊れる。
- **BLOB を BYTEA として見せないのは、クライアントが扱えないから。** 保存形式への忠実さより、相手が使える形を選ぶ。
- **宣言名を優先するのは、利用者が書いた型名が相手の型名でもあるから。** 落ちるときは基底型に落ちるので、知らない型でも動く。
- **配列をスカラ型から導くのは、対応表を 1 つに保つため。** 規則性がある変換は、表ではなく関数で表す。

## どう活かすか

- **「実行前に型を答える」プロトコルを、動的型付けの上に載せるなら、型の島を先に作る。** すべてを動的なままにすると、宣言のたびに推測することになる。
- **相手側の型を 1 つずつ組み込まず、汎用の型定義の仕組みを 1 つ作る。** 変換、検証、既定値を利用者が書ける形にすれば、本体が相手の型体系を知らずに済む。
- **型が決まらないときの既定は、最も受け入れ幅の広いものにする。** 文字列は、たいていの型の入れ物になる。
- **推論が外れることを前提に、後段で吸収する。** 「宣言した型」と「実際の値」がずれても壊れない経路を用意しておくと、推論を完璧にしなくて済む。
- **値の変換関数には、値だけでなく文脈 (宣言型) も渡す。** 同じ値でも、文脈によって正しい表現が変わる。
- **環境によって解釈が変わる値は、明示的に固定して送る。** タイムゾーン、文字コード、数値の区切り。既定に頼ると、相手の設定で結果が変わる。
- **「宣言する型」と「実際に符号化に使う型」を分けられる形にする。** ライブラリの自動整形を回避したい場面が必ず出てくる。
- **内部の保存形式をそのまま見せない。** 相手が扱える形に変換する方が、互換レイヤとしては正しい。
- **未知の入力を拒否せず、既定の扱いに落とす経路を用意する。** 「知らない型はカスタム型として素通し」があるだけで、対応表の穴が致命的でなくなる。
- **完全実装でもエラーでもない「降格」を選択肢に入れる。** そして降格したことをドキュメントに書く。使えるが検証されない、は正当な中間解になる。
