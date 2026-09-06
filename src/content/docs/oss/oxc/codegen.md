---
title: "Codegen — AST を文字列に戻す"
description: "Codegen は AST を読むだけで、書き換えない。Semantic への依存も with_scoping(Option<Scoping>) の 1 本だけで、しかも None で動く。中身は CodeBuffer に print していく Gen トレイトの実装群で、式には Precedence を渡して括弧の要否を決める。二項演算子だけは再帰でスタックを溢れさせないために、明示的なスタックで反復に展開されている。"
group: "同じ AST を誰がどう使うか"
sidebar:
  order: 71
---

## 何を学んだか

Codegen の入力は `&Program<'a>` — **不変参照**になる。

```rust title="crates/oxc_codegen/src/lib.rs"
    /// Print a [`Program`] into a string of source code.
    ///
    /// A source map will be generated if [`CodegenOptions::source_map_path`] is set.
    #[must_use]
    pub fn build(mut self, program: &Program<'a>) -> CodegenReturn<'a> {
```

**AST を書き換えない。** これが [Transformer](./transformer/) との決定的な違いで、Codegen は `Traverse` も `VisitMut` も使わない。

Semantic への依存も薄い。

```rust title="crates/oxc_codegen/src/lib.rs"
    /// Set the symbol table used for identifier renaming.
    ///
    /// Can be used for easy renaming of variables (based on semantic analysis).
    #[must_use]
    pub fn with_scoping(mut self, scoping: Option<Scoping>) -> Self {
        self.scoping = scoping;
        self
    }
```

**`Option` なので、`Scoping` なしでも動く。** これがあるのは [Mangler](./minifier-and-mangler/) が短縮した名前を引くためだけで、通常の出力には要らない。

doc の例が API の簡潔さを表している。

```rust title="crates/oxc_codegen/src/lib.rs"
/// let allocator = Allocator::default();
/// let source = "const a = 1 + 2;";
/// let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
/// assert!(parsed.diagnostics.is_empty());
///
/// let js = Codegen::new().build(&parsed.program);
/// assert_eq!(js.code, "const a = 1 + 2;\n");
```

**パースして codegen するだけなら 2 行。** semantic も transformer も要らない。

## なぜそうなっているか

### 「読むだけ」だから依存が減る

段ごとに必要なものを並べると、線引きが見える。

| 段                                  | AST            | Semantic | Traverse |
| ----------------------------------- | -------------- | -------- | -------- |
| [Parser](./recursive-descent/)      | 作る           | —        | —        |
| [Semantic](./semantic-builder/)     | 読む (`Visit`) | 作る     | —        |
| [Linter](./rule-dispatch/)          | 読む           | **必須** | —        |
| [Transformer](./transformer/)       | 書き換える     | **必須** | 使う     |
| [Minifier](./minifier-and-mangler/) | 書き換える     | **必須** | 使う     |
| **Codegen**                         | **読むだけ**   | 任意     | 使わない |

**Codegen が一番依存が少ない。** だから「パースして出力し直す」だけの用途 (フォーマットの正規化、AST の往復テスト) が 2 行で書ける。

### `Gen` トレイト — ノード自身が自分を出力する

```rust title="crates/oxc_codegen/src/gen.rs"
/// Generate source code for an AST node.
pub trait Gen: GetSpan {
    /// Generate code for an AST node.
    fn r#gen(&self, p: &mut Codegen, ctx: Context);

    /// Generate code for an AST node. Alias for `gen`.
    #[inline]
    fn print(&self, p: &mut Codegen, ctx: Context) {
        self.r#gen(p, ctx);
    }
}
```

[`Binder`](./binder/) と同じ形になる。**ノードの型ごとにトレイトを実装し、`Codegen` を `&mut` で受け取る。** 分岐が大きな `match` にならない。

`gen` が `r#gen` になっているのは、`gen` が Rust 2024 の予約語だからだ。エイリアスの `print` があるので、呼び出し側は `node.print(p, ctx)` と書ける。

式には別のトレイトがある。

```rust title="crates/oxc_codegen/src/gen.rs"
/// Generate source code for an expression.
pub trait GenExpr: GetSpan {
    /// Generate code for an expression, respecting operator precedence.
    fn gen_expr(&self, p: &mut Codegen, precedence: Precedence, ctx: Context);
```

**引数に [`Precedence`](./expression-precedence/) がある。** 式を出力するときは「親の演算子の優先順位」を渡し、自分の優先順位がそれより低ければ括弧を付ける。

パースの逆になっている。パースでは `parse_binary_expression_or_higher(min_precedence)` が「この優先順位以上を読む」で、出力では `gen_expr(precedence)` が「この優先順位の文脈に置く」。**同じ `Precedence` 型を両方向で使う**ので、括弧の付け方がパースの規則と一致する。

### 二項演算子だけスタックに展開する

```rust title="crates/oxc_codegen/src/lib.rs"
mod binary_expr_visitor;
```

```rust title="crates/oxc_codegen/src/lib.rs"
    binary_expr_stack: Stack<BinaryExpressionVisitor<'a>>,
```

`a + b + c + d + ...` のような式は、AST では左に深い木になる。素直に再帰すると、演算子の数だけスタックが積まれる。**生成コードや minify 済みコードには、演算子が数千個並ぶ式が実際にある。**

だから二項演算子の出力だけを、明示的なスタックによる反復に展開している。**再帰の深さがスタックオーバーフローを起こす箇所を特定して、そこだけ潰す**という対処になる。

同じ問題は[パース側](./expression-precedence/)にもあるが、そちらは Pratt parsing がもともと反復 (`loop`) なので起きない。

### 出力先は `CodeBuffer`

```rust title="crates/oxc_codegen/src/lib.rs"
    /// Output Code
    code: CodeBuffer,
```

[ESTree シリアライザ](./estree-serialization/)と同じ型を使う。UTF-8 の不変条件を持つバイトバッファで、`print_str` などのメソッドがある。

容量は先に確保する。

```rust title="crates/oxc_codegen/src/lib.rs"
        self.code.reserve(program.source_text.len());
```

**出力はだいたい入力と同じ長さ**という見積もり。minify すれば短くなり、フォーマットすれば長くなるが、桁は変わらない。[ESTree の 16 倍・80 倍](./estree-serialization/)のような大きな比率にはならない。

### 状態が多い

```rust title="crates/oxc_codegen/src/lib.rs"
    // states
    prev_op_end: usize,
    prev_reg_exp_end: usize,
    need_space_before_dot: usize,
    print_next_indent_as_space: bool,
    binary_expr_stack: Stack<BinaryExpressionVisitor<'a>>,
    class_stack: Stack<ClassId>,
    next_class_id: ClassId,
```

**「直前に何を出力したか」を覚えている**フィールドが並ぶ。理由は JS の字句規則にある。

- `a+ +b` — `+` を 2 つ続けると `++` になってしまう。`prev_op_end` で判定して空白を入れる
- `1 .toString()` — 数値リテラルの直後の `.` は小数点に見える。`need_space_before_dot`
- `/a/ /b/` — 正規表現の後に `/` が続くと壊れる。`prev_reg_exp_end`

**「出力した文字列を再パースしたら同じ AST になる」を保つために、出力器が字句規則を知っている必要がある。** これは codegen の本質的な複雑さで、esbuild でも同じ問題を扱っている。

```rust title="crates/oxc_codegen/src/lib.rs"
//! Code adapted from
//! * [esbuild](https://github.com/evanw/esbuild/blob/v0.24.0/internal/js_printer/js_printer.go)
```

出典が明記されていて、バージョンまで書いてある。

### コメントの保持

```rust title="crates/oxc_codegen/src/lib.rs"
mod comment;
```

```rust title="crates/oxc_codegen/src/lib.rs"
        self.build_comments(&program.comments);
```

コメントは AST のノードではなく、`Program::comments` という別のリストに入っている ([Program の定義](./ast-memory-layout/))。位置順にソートされているので、**「このノードを出力する前に、この位置までのコメントを出す」**という形で挿入する。

`CommentsMap` はその索引になる。

`legal_comments` という概念もある。

```rust title="crates/oxc_codegen/src/lib.rs"
    /// All the legal comments returned from [LegalComment::Linked] or [LegalComment::External].
    pub legal_comments: Vec<Comment>,
```

`/*! ... */` や `@license` を含むコメントは、minify しても残すか、別ファイルに出すか、リンクを張るかを選べる。**法的な理由で消せないコメント**という、ツール固有の概念が型として存在する。

### source map は feature

```rust title="crates/oxc_codegen/src/lib.rs"
#[cfg(not(feature = "sourcemap"))]
use std::marker::PhantomData;
```

```rust title="crates/oxc_codegen/src/lib.rs"
pub struct CodegenReturn<'a> {
    /// The generated source code.
    pub code: String,

    /// The source map from the input source code to the generated source code.
    ///
    /// You must set [`CodegenOptions::source_map_path`] for this to be [`Some`].
    #[cfg(feature = "sourcemap")]
    pub map: Option<oxc_sourcemap::SourceMap<'a>>,

    #[cfg(not(feature = "sourcemap"))]
    _source_map_lifetime: PhantomData<&'a ()>,
```

source map を使わないビルドでは、`map` フィールド自体が存在しない。しかし `'a` ライフタイムは構造体のシグネチャに残るので、**`PhantomData` で使い道を作る。**

`#[non_exhaustive]` が付いているので、フィールドが `#[cfg]` で増減しても利用側は壊れない (構造体リテラルで作れないため)。

### `cjs_module_lexer`

```rust title="crates/oxc_codegen/src/lib.rs"
mod cjs_module_lexer;
```

CommonJS のモジュールから export される名前を、**出力しながら**検出する仕組みになる。バンドラが「この CJS モジュールは何を export するか」を知るために要る。

**出力の途中で別の解析を同時に行う**という形で、木を再度歩かずに済ませている。[module_record をパース中に集める](./module-record/)のと同じ発想になる。

## ソースコードのどこか

- [`crates/oxc_codegen/src/lib.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_codegen/src/lib.rs) — `Codegen` 本体と状態
- [`crates/oxc_codegen/src/gen.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_codegen/src/gen.rs) — `Gen` / `GenExpr` の全実装
- [`crates/oxc_codegen/src/binary_expr_visitor.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_codegen/src/) — 二項演算子の反復展開
- [`crates/oxc_codegen/src/comment.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_codegen/src/) — コメントの挿入
- [`crates/oxc_codegen/src/sourcemap_builder.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_codegen/src/) — source map の構築

`with_private_member_mappings` という API もある。

```rust title="crates/oxc_codegen/src/lib.rs"
    /// Set private member name mappings for mangling.
    ///
    /// This allows renaming of private class members like `#field` -> `#a`.
    /// The Vec contains per-class mappings, indexed by class declaration order.
```

クラスの private メンバ (`#field`) は通常のシンボルとは別に管理されるので、[Mangler](./minifier-and-mangler/) からの短縮名も別経路で渡す。**`Scoping` に入らない情報が 1 つある**という例外になる。

## どう活かすか

**「読むだけ」の段は、依存を最小にできる。** Codegen が `&Program` しか要求しないので、「パースして出力し直す」が 2 行で書ける。**書き換えない段が書き換える段と同じ依存を持っていたら、設計を疑う。**

**双方向の変換では、同じ型を両方向で使う。** パースの `min_precedence` と出力の `precedence` が同じ `Precedence` 型なので、括弧の付け方がパースの規則と自動的に一致する。**別々に定義すると、必ずずれる。**

**再帰の深さが問題になる箇所を特定して、そこだけ反復に展開する。** 全部を反復にするとコードが読めなくなる。二項演算子だけが実際に数千段になりうる、と分かっているなら、そこだけスタックに展開すればいい。

**出力器が入力の字句規則を知っている必要がある。** `a+ +b` に空白を入れる、`1 .toString()` の `.` の前に空白を入れる。**「出力を再パースしたら同じ AST になる」**という不変条件を守るには、出力側にトークン境界の知識が要る。これは codegen の本質的な複雑さで、避けられない。

**`#[cfg]` でフィールドが消える構造体には `#[non_exhaustive]` を付ける。** 構造体リテラルで作れなくなるので、feature の有無で利用側が壊れない。使われないライフタイムは `PhantomData` で吸収する。

**出力の途中でできる解析は、その場でやる。** `cjs_module_lexer` は出力しながら CJS の export を検出する。木を 2 回歩くより安い。**「通りがかりに集める」**という [module_record](./module-record/) と同じ判断になる。
