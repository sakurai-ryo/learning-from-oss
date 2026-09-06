---
title: "Semantic が担う early error 検査"
description: "「with 文は strict mode で使えない」「モジュールで await を識別子にできない」といった規則は、文法では表せない。ECMAScript はこれを Early Errors として仕様の別節に置いていて、oxc はそれを semantic のフェーズで検査する。checker/ の doc コメントは仕様の文言そのままで、診断を作る関数は 53 本すべてが #[cold] になっている。"
group: "意味をつける — Semantic"
sidebar:
  order: 45
---

## 何を学んだか

パースは通るのに規格違反、という構文が JS には大量にある。

- `with (o) {}` は strict mode では構文エラー
- モジュールの中で `await` を識別子として使うのは構文エラー
- strict mode で `0123` (leading zero の 8 進数) は構文エラー
- クラスの中に同じ private 名が 2 回出るのは構文エラー
- オブジェクトリテラルに `__proto__` が 2 回出るのは構文エラー

どれも**文法 (BNF) では表現できない**。文脈 (strict mode か、モジュールか、クラスの中か) や、木全体を見ないと分からない情報 (同じ名前が 2 回出たか) が要るからだ。ECMAScript はこれを **Early Errors** として仕様の別の節に置いている。

oxc はこれを `oxc_semantic` の `checker/` で検査する。**パーサではなく semantic に置いた**のが判断のポイントで、パーサは「文法で表せるもの」だけを見る。

そして検査は**任意**になっている。`SemanticBuilder::new()` では無効、`new_linter()` / `new_compiler()` では有効。

## なぜそうなっているか

### なぜパーサではなく semantic なのか

必要な情報の所在で決まる。

- **strict mode かどうか** — スコープの `ScopeFlags::StrictMode` を見る。関数単位で変わる
- **クラスの中かどうか** — 祖先を辿る
- **同じ名前が 2 回出たか** — シンボルテーブルか class table を見る
- **export した名前が宣言されているか** — スコープの binding を全部見る

パーサはトークンを 1 つずつ見ながら降りていくので、これらを持っていない。`ctx.strict_mode()` も `ctx.scoping` も、semantic を組み立てながらでないと引けない。

もう 1 つ、**パーサを軽くしたい**という動機がある。oxlint は「まずパースだけして、必要なら semantic」という段階を踏む。パーサに early error を入れると、パースだけしたい利用者 (トランスパイル用途など) も検査コストを払う。

### 呼び出し口は 1 つの `match`

```rust title="crates/oxc_semantic/src/checker/mod.rs"
/// Perform syntax error checking for the given AST node.
///
/// Must be inlined along with `SemanticBuilder::leave_node` so the compiler can see the
/// concrete `AstKind` variant at each call site and eliminate non-matching arms.
#[expect(clippy::inline_always, reason = "enables compile-time match elimination, see doc comment")]
#[inline(always)]
pub fn check<'a>(kind: AstKind<'a>, ctx: &SemanticBuilder<'a>) {
    match kind {
        AstKind::Program(program) => {
            js::check_duplicate_class_elements(ctx);
            js::check_unresolved_exports(program, ctx);
            js::check_import_value_redeclarations(ctx);
            ts::check_ts_export_assignment_in_program(program, ctx);
        }
        AstKind::BindingIdentifier(ident) => {
            js::check_identifier(&ident.name, ident.span, ctx);
            js::check_binding_identifier(ident, ctx);
        }
        // ...
        AstKind::WithStatement(stmt) => {
            js::check_function_declaration(&stmt.body, false, ctx);
            js::check_with_statement(stmt, ctx);
        }
        // ...
        _ => {}
    }
}
```

`#[inline(always)]` の理由が doc に書いてある。**`leave_node` は生成された `walk_*` から呼ばれるので、呼び出し箇所ごとに `kind` の variant がコンパイル時に確定している。** インライン展開すれば、その場所に関係ない `match` の腕を全部消せる。

つまり「`walk_with_statement` の中では `check` が 2 行の関数になる」ということで、**191 種類の分岐が実行時には 1 回も走らない。** [Binder](./binder/) がトレイトで分割したのと同じ問題を、こちらは `#[inline(always)]` で解いている。

### doc コメントが仕様の文言そのまま

```rust title="crates/oxc_semantic/src/checker/javascript.rs"
/// It is a Syntax Error if any element of the ExportedBindings of ModuleItemList
/// does not also occur in either the VarDeclaredNames of ModuleItemList, or the LexicallyDeclaredNames of ModuleItemList.
pub fn check_unresolved_exports(program: &Program<'_>, ctx: &SemanticBuilder<'_>) {
```

```rust title="crates/oxc_semantic/src/checker/javascript.rs"
/// It is a Syntax Error if any element of the BoundNames of ImportDeclaration
/// also occurs in the VarDeclaredNames or LexicallyDeclaredNames of ModuleItemList.
/// <https://tc39.es/ecma262/#sec-imports-static-semantics-early-errors>
pub fn check_import_value_redeclarations(ctx: &SemanticBuilder<'_>) {
```

関数の中にも仕様の文言が散っている。

```rust title="crates/oxc_semantic/src/checker/javascript.rs"
pub fn check_number_literal(lit: &NumericLiteral, ctx: &SemanticBuilder<'_>) {
    // NumericLiteral :: legacy_octalIntegerLiteral
    // DecimalIntegerLiteral :: NonOctalDecimalIntegerLiteral
    // * It is a Syntax Error if the source text matched by this production is strict mode code.
    fn leading_zero(s: Option<Str>) -> bool {
        // ...
    }

    match lit.base {
        NumberBase::Octal if leading_zero(lit.raw) && ctx.strict_mode() => {
            ctx.error(diagnostics::legacy_octal(lit.span));
        }
        NumberBase::Decimal | NumberBase::Float if leading_zero(lit.raw) && ctx.strict_mode() => {
            ctx.error(diagnostics::leading_zero_decimal(lit.span));
        }
        _ => {}
    }
}
```

**仕様の 1 文と実装の 1 分岐が並んでいる。** 準拠実装ではこれが最も安いドキュメントになる。仕様が変わったときに、どのコメントに対応するかが一意に決まる。

いちばん短い検査はこれになる。

```rust title="crates/oxc_semantic/src/checker/javascript.rs"
pub fn check_with_statement(stmt: &WithStatement, ctx: &SemanticBuilder<'_>) {
    if ctx.strict_mode() || ctx.source_type.is_typescript() {
        ctx.error(diagnostics::with_statement(Span::sized(stmt.span.start, 4)));
    }
}
```

`Span::sized(stmt.span.start, 4)` は `with` の 4 文字だけを指す。**文全体ではなくキーワードだけに下線を引く**ための細工で、この種の配慮が診断の読みやすさを決める。

### `check_identifier` が文脈で分岐する

予約語の検査は、名前によって見る文脈が違う。

```rust title="crates/oxc_semantic/src/checker/javascript.rs"
pub fn check_identifier(name: &str, span: Span, ctx: &SemanticBuilder<'_>) {
    match name {
        "await" => {
            if ctx.in_ambient_context() {
                return;
            }

            // It is a Syntax Error if the goal symbol of the syntactic grammar is Module
            // and the StringValue of IdentifierName is "await".
            if ctx.source_type.is_module() {
                ctx.error(diagnostics::reserved_keyword(
                    name, span, diagnostics::ReservedKeywordContext::ModuleAwait,
                ));
            }
            // It is a Syntax Error if ClassStaticBlockStatementList Contains await is true.
            else if ctx.scoping.scope_flags(ctx.current_scope_id).is_class_static_block() {
                ctx.error(diagnostics::class_static_block_await(span));
            }
        }
        "implements" | "interface" | "let" | "package" | "private" | "protected" | "public"
        | "static" | "yield" => {
            if !ctx.strict_mode() || ctx.in_ambient_context() {
                return;
            }
            // ...
        }
        // ...
    }
}
```

`await` はモジュールとクラス静的ブロックで、`let` などは strict mode で予約される。**同じ「予約語」でも予約される条件が違う**ので、名前で分岐して条件を書き分けている。

`in_ambient_context()` (`declare` の中) は全部素通しになる。型定義ファイルの中では実行されないコードなので、規則を緩める。

### 診断を作る関数が 53 本すべて `#[cold]`

```rust title="crates/oxc_semantic/src/diagnostics.rs"
#[cold]
fn ts_error<M: Into<Cow<'static, str>>>(code: &'static str, message: M) -> OxcDiagnostic {
    OxcDiagnostic::error(message).with_error_code("TS", code)
}

#[cold]
pub fn redeclaration(x0: &str, span1: Span, span2: Span) -> OxcDiagnostic {
    OxcDiagnostic::error(format!("Identifier `{x0}` has already been declared")).with_labels([
        span1.label(format!("`{x0}` has already been declared here")),
        span2.label("It can not be redeclared here"),
    ])
}
```

`crates/oxc_semantic/src/diagnostics.rs` の関数は 53 本あり、**全部に `#[cold]` が付いている。**

理由は、これらが `format!` を含むからだ。エラーメッセージの組み立てはヒープ確保と文字列フォーマットを伴い、コードサイズも大きい。`#[cold]` を付けると、コンパイラはその関数を「まず呼ばれない」とみなす。

- 呼び出し元にインライン展開されない
- 呼び出し元の分岐予測で「通らない側」に置かれる
- 生成コードがバイナリの遠い場所に配置され、**ホットパスの命令キャッシュを汚さない**

`check_number_literal` のような関数は、正常なコードに対しては「条件を見て何もせず返る」だけになる。**エラー生成のコードが同じキャッシュラインに乗っていないことが、正常系の速度に効く。**

### 検査が任意で、しかも副作用がある

```rust title="crates/oxc_semantic/src/builder.rs"
    /// Enable/disable additional syntax checks.
    ///
    /// Set this to `true` to enable additional syntax checks. Without these,
    /// there is no guarantee that the parsed program follows the ECMAScript
    /// spec.
    ///
    /// By default, this is `false`.
    pub fn with_check_syntax_error(mut self, yes: bool) -> Self {
```

既定は `false`。利用側で分かれる。

| コンストラクタ   | check_syntax_error | 他の設定                                      |
| ---------------- | ------------------ | --------------------------------------------- |
| `new()`          | false              | 最小構成                                      |
| `new_compiler()` | **true**           | `build_nodes(false)` — ノードストアを作らない |
| `new_linter()`   | **true**           | `build_nodes(true)` + cfg + class table       |

そして [SemanticBuilder のページ](./semantic-builder/)でも触れた副作用がある。

```rust title="crates/oxc_semantic/src/builder.rs"
        self.class_table_builder.enabled |= self.check_syntax_error;
```

**構文エラー検査を有効にすると class table も強制的に構築される。** `check_duplicate_class_elements` がそれを必要とするからだ。`with_class_table(false)` を明示していても上書きされる。

この `|=` は「依存を暗黙に満たす」書き方で、便利だが分かりにくい。`with_class_table(false).with_check_syntax_error(true)` と書いたときに何が起きるかは、この 1 行を見つけないと分からない。

## ソースコードのどこか

- [`crates/oxc_semantic/src/checker/mod.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_semantic/src/checker/mod.rs) — `check` の分岐表
- [`crates/oxc_semantic/src/checker/javascript.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_semantic/src/checker/javascript.rs) — JS の early error (1338 行)
- [`crates/oxc_semantic/src/checker/typescript.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_semantic/src/checker/typescript.rs) — TS 固有の検査 (343 行)
- [`crates/oxc_semantic/src/diagnostics.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_semantic/src/diagnostics.rs) — 53 本の診断生成関数、全部 `#[cold]`

`check_unresolved_exports` には、typo の候補を出す仕掛けまで入っている。

```rust title="crates/oxc_semantic/src/checker/javascript.rs"
/// Threshold for edit distance when suggesting similar names
const SUGGESTION_THRESHOLD: usize = 2;
```

```rust title="crates/oxc_semantic/src/checker/javascript.rs"
                    let names = available_names.get_or_insert_with(|| {
                        let root_scope_id = ctx.scoping.root_scope_id();
                        ctx.scoping.get_bindings(root_scope_id).keys().map(Ident::as_str).collect()
                    });
                    let suggestion =
                        best_match(&ident.name, names.iter().copied(), SUGGESTION_THRESHOLD);
```

候補リストの構築は `get_or_insert_with` で遅延されている。**エラーが 1 件も出なければ、トップレベルの binding を collect するコストは払わない。** `#[cold]` と同じ発想が、データの準備側にも効いている。

## どう活かすか

**「文法で表せない規則」は、パーサではなく後段に置く。** パーサに入れると、パースだけしたい利用者もコストを払うし、パーサが持っていない情報 (スコープ、木全体の統計) を無理に持ち込むことになる。**「その規則の判定に必要な情報が、どのフェーズで揃うか」**で置き場所が決まる。

**準拠実装では仕様の文言をそのまま doc に貼る。** 要約するとずれる。原文があれば、仕様が改訂されたときに差分を取れる。oxc の checker は関数の doc も関数内のコメントも仕様の引用になっていて、URL も付いている。

**エラー生成関数には `#[cold]` を付ける。** `format!` を含む関数がホットパスにインライン展開されると、命令キャッシュを無駄に埋める。Rust では属性 1 つ、C++ なら `[[unlikely]]` や `__attribute__((cold))` に相当する。**53 本全部に付いている**のは、個別の判断ではなく規約として運用されている証拠になる。

**診断の span は「意味のある最小範囲」を指す。** `with (o) { ... }` 全体ではなく `with` の 4 文字。エラーメッセージの質は文言より span で決まることが多い。

**依存を `|=` で暗黙に満たすときは、doc に書く。** `check_syntax_error` が class table を強制するのは合理的だが、`with_class_table(false)` が無視される理由は 1 行の `|=` を見つけないと分からない。API の doc に「有効にすると class table も構築される」と書いておくだけで、探す手間が消える。
