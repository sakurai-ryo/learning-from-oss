---
title: "Rule トレイト — 必須メソッドがゼロ"
description: "866 本の lint ルールが実装するトレイトには、必須メソッドが 1 つもない。全部にデフォルト実装があり、ルールは自分に必要なものだけを上書きする。ルールのメタ情報 (カテゴリ、fix 能力、導入バージョン、ドキュメント) は declare_oxc_lint! マクロが doc コメントから拾って別トレイトにする。ロジックとメタ情報が完全に分かれている。"
group: "木を検査する — Linter"
sidebar:
  order: 60
---

## 何を学んだか

oxlint のルールが実装するトレイトはこれだけになる。

```rust title="crates/oxc_linter/src/rule.rs"
pub trait Rule: Sized + Default + fmt::Debug {
    /// Initialize from eslint json configuration
    fn from_configuration(_value: serde_json::Value) -> Result<Self, serde_json::error::Error> {
        Ok(Self::default())
    }

    /// Serialize rule configuration to JSON. ...
    fn to_configuration(&self) -> Option<Result<serde_json::Value, serde_json::Error>> {
        None
    }

    /// Visit each AST Node
    #[inline]
    fn run<'a>(&self, node: &AstNode<'a>, ctx: &LintContext<'a>) {}

    /// Run only once. Useful for inspecting scopes and trivias etc.
    #[inline]
    fn run_once(&self, ctx: &LintContext) {}

    /// Run on each Jest node (e.g. `it`, `describe`, `test`, `expect`, etc.).
    #[inline]
    fn run_on_jest_node<'a, 'c>(
        &self,
        jest_node: &PossibleJestNode<'a, 'c>,
        ctx: &'c LintContext<'a>,
    ) {
    }

    /// Check if a rule should be run at all.
    #[inline]
    fn should_run(&self, ctx: &ContextHost) -> bool {
        true
    }
}
```

**必須メソッドが 1 つもない。** 全部にデフォルト実装がある。`impl Rule for MyRule {}` と書くだけでコンパイルが通る (何もしないルールになる)。

境界は `Sized + Default + Debug` の 3 つ。`Default` があるので設定なしのルールは `MyRule::default()` で作れる。

そして**ルールのメタ情報はこのトレイトに入っていない。** カテゴリ、fix 能力、導入バージョン、ドキュメントは `declare_oxc_lint!` マクロが別トレイト (`RuleMeta`) として生成する。

## なぜそうなっているか

### 「必須メソッドゼロ」が成立する理由

ルールの実装パターンは大きく 3 つある。

| パターン            | 実装するメソッド   | 例                            |
| ------------------- | ------------------ | ----------------------------- |
| ノードを見る        | `run`              | `no-debugger`、`eqeqeq`       |
| 全体を 1 回見る     | `run_once`         | `no-unused-vars`、`max-lines` |
| Jest のノードを見る | `run_on_jest_node` | `jest/no-focused-tests`       |

**この 3 つは排他的で、1 つのルールが全部を実装することはまずない。** だから「全部必須」にすると空実装が大量に並ぶ。全部デフォルトにすれば、ルールのソースには実際に使うものだけが残る。

その代わり、「このルールがどれを実装したか」を外から知る必要が出てくる。実装していない `run` を毎ノード呼ぶのは無駄だからだ。それを[コード生成で解決している](./rule-dispatch/)。

```rust title="crates/oxc_linter/src/lib.rs"
                if run_info.is_run_once_implemented() {
                    // ...
                    rule.run_once::<TIMINGS>(ctx, timing_stat);
                }
```

`RuleRunFunctionsImplemented` という enum が、生成器の静的解析の結果として各ルールに付いている。

### `should_run` はプラグインの有効判定ではない

```rust title="crates/oxc_linter/src/rule.rs"
    /// Check if a rule should be run at all.
    ///
    /// You usually do not need to implement this function. If you do, use it to
    /// enable rules on a file-by-file basis. Do not check if plugins are
    /// enabled/disabled; this is handled by the [`linter`].
    fn should_run(&self, ctx: &ContextHost) -> bool {
        true
    }
```

**「プラグインが有効かは linter 側が見るので、ここでやるな」**と明記されている。`should_run` はファイル単位の判定 (テストファイルだけ、`.tsx` だけ) のためにある。

こういう「使ってはいけない用途」を doc に書くのは、トレイトの拡張点を提供する側の責任になる。書かないと、必ず誰かがそこでプラグイン判定を始める。

### `to_configuration` は外部リンタのためにある

```rust title="crates/oxc_linter/src/rule.rs"
    /// Serialize rule configuration to JSON. Only used for sending rule configurations
    /// to another linter. This allows oxlint to handle the parsing and error handling.
    /// Type-aware rules implemented in tsgolint will need to override this method.
    ///
    /// - Returns `None` if no configuration should be serialized (default)
    /// - Returns `Some(Err(_))` if serialization fails
    /// - Returns `Some(Ok(_))` if serialization succeeds
    fn to_configuration(&self) -> Option<Result<serde_json::Value, serde_json::Error>> {
        None
    }
```

型情報を要するルールは [Go 製の `tsgolint` に外出しされている](./outside-rust/)。設定の**パースとエラー処理は oxlint 側でやり**、パース済みの設定を JSON にし直して外部プロセスに渡す。

`Option<Result<_, _>>` という戻り値は 3 状態を表す。「設定を送らない」「送ろうとして失敗」「送る」。ネストした型で状態を表すのは読みにくいこともあるが、doc に 3 行で書いてあるので迷わない。

### `declare_oxc_lint!` はロジックに触らない

ルールの宣言はこうなる (`no-unused-vars` の例)。

```rust
declare_oxc_lint!(
    /// ### What it does
    ///
    /// Disallow unused variables.
    ///
    /// ### Why is this bad?
    /// ...
    NoUnusedVars,
    eslint,
    correctness,
    dangerous_suggestion,
);
```

マクロがパースするのは、doc コメント + 構造体名 + プラグイン名 + カテゴリ + オプション群になる。

```rust title="crates/oxc_macros/src/declare_oxc_lint.rs"
pub struct LintRuleMeta {
    name: Ident,
    // Whether this rule should be exposed to tsgolint integration
    is_tsgolint_rule: bool,
    plugin: Ident,
    category: Ident,
    /// Describes what auto-fixing capabilities the rule has
    fix: Option<Ident>,
    #[cfg(feature = "ruledocs")]
    documentation: DocumentationSource,
    pub used_in_test: bool,
    /// Rule configuration
    config: Option<Path>,
    /// The version of oxlint in which this rule was first available.
    version: LitStr,
    /// A short, one-line summary of what the rule does.
    #[cfg(feature = "ruledocs")]
    short_description: Option<ShortDescriptionSource>,
}
```

**生成されるのは `impl RuleMeta` だけで、`impl Rule` は手書きのまま残る。** マクロがロジックに触らないので、ルールを読むときにマクロ展開を想像する必要がない。

`ruledocs` feature の `#[cfg]` が多いのは、ドキュメント生成のときだけ doc コメントを文字列として保持したいからだ。通常のビルドでは doc コメントは捨てられ、バイナリに載らない。

マクロには小さな検証も入っている。

````rust title="crates/oxc_macros/src/declare_oxc_lint.rs"
                        // Count occurrences of "```" to ensure the markdown code blocks are closed properly.
                        backtick_fences_count += line.matches("```").count();
````

doc コメント中のコードフェンスが閉じているかを数えている。**ルールのドキュメントはそのまま Web サイトに出るので、Markdown が壊れているとサイトが崩れる。** コンパイル時に弾くのが一番安い。

`(tsgolint)` という marker も構文として認められている。

```rust title="crates/oxc_macros/src/declare_oxc_lint.rs"
        // Optional marker `(tsgolint)` directly after the rule struct name
        let mut is_tsgolint_rule = false;
        if input.peek(syn::token::Paren) {
            let content;
            syn::parenthesized!(content in input);
            let marker: Ident = content.parse()?;
            if marker == "tsgolint" {
```

`declare_oxc_lint!(MyRule(tsgolint), typescript, correctness)` と書くと、そのルールは Rust 側では実行されず tsgolint に委譲される。

### 設定パースの共通部分は非ジェネリックに切り出されている

ルールは 866 本あるので、ジェネリックな関数はそれだけモノモルフィズされる。

```rust title="crates/oxc_linter/src/rule.rs"
/// Pretty-print a JSON value and collapse all whitespace runs to single spaces,
/// for embedding a "received config" snippet in a rule-config deserialization error.
///
/// Kept non-generic (and out of the generic `Deserialize` impls below) so the heavy
/// `serde_json::to_string_pretty` machinery is compiled once instead of being
/// monomorphized into every rule-config `deserialize` instantiation. Returns `None`
/// when serialization fails, so callers fall back to the bare error.
fn compact_json_for_error(value: &serde_json::Value) -> Option<String> {
```

```rust title="crates/oxc_linter/src/rule.rs"
/// Extract the first item from an ESLint-style rule configuration.
///
/// `None` represents a missing configuration (`null` or an empty array). Keeping this helper
/// non-generic avoids duplicating the array and error handling for every rule configuration type.
#[inline(never)]
fn normalize_default_rule_config(
```

**「ジェネリックな関数の中の、型に依存しない部分を非ジェネリックな関数に切り出す」**という定番のテクニックで、`#[inline(never)]` まで付けて確実に 1 個にしている。866 本 × `serde_json::to_string_pretty` の展開は、バイナリサイズにも コンパイル時間にも効く。

`#[cold]` と `#[inline(never)]` を両方付けた関数もある。

```rust title="crates/oxc_linter/src/rule.rs"
/// Add the received configuration to a deserialization error.
#[cold]
#[inline(never)]
```

### ルールのサイズが 16 バイトに固定されている

```rust title="crates/oxc_linter/src/lib.rs"
#[cfg(target_pointer_width = "64")]
#[test]
fn size_asserts() {
    // `RuleEnum` runs in a really tight loop, make sure it is small for CPU cache.
    // A reduction from 168 bytes to 16 results 15% performance improvement.
    // See codspeed in https://github.com/oxc-project/oxc/pull/1783
    assert_eq!(size_of::<RuleEnum>(), 16);
}
```

866 個の variant を持つ enum のサイズが 16 バイトに固定され、テストで検証されている。**168 バイトから 16 バイトにして 15% 速くなった**という数字と PR へのリンクが残っている。

大きくなる原因は、設定を持つルールが `Vec` や `String` をインラインで持つこと。16 バイトに収めるには、大きい設定は `Box` に入れることになる。この assertion がないと、ルールを 1 本足したときに静かに太る。

## ソースコードのどこか

- [`crates/oxc_linter/src/rule.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_linter/src/rule.rs) — `Rule` トレイトと設定パースのヘルパ
- [`crates/oxc_macros/src/declare_oxc_lint.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_macros/src/declare_oxc_lint.rs) — `declare_oxc_lint!`
- [`crates/oxc_linter/src/rules/`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_linter/src/rules/) — 866 本のルール実装
- [`crates/oxc_linter/src/lib.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_linter/src/lib.rs) — `execute_rules` と `size_asserts`

ルールが受け取る `LintContext` が、[群 5 で作った Semantic](./semantic-builder/) への入口になる。`ctx.scoping()`、`ctx.nodes()`、`ctx.module_record()`、`ctx.semantic()` が生えていて、ルールはここから宣言・参照・スコープを引く。

**存在しないメソッドにも注意がいる。** `Rule::run_on_symbol` のようなものはない。シンボルを走査したいルールは `run_once` の中で `ctx.scoping().symbol_ids()` を自前で回す ([no-unused-vars](./reading-no-unused-vars/))。

## どう活かすか

**拡張点のトレイトは「全部デフォルト実装」にできないか考える。** 実装パターンが排他的なら、必須メソッドを置くと空実装が並ぶ。全部デフォルトにすれば、実装ファイルには意味のあるコードだけが残る。代償は「何が実装されたか外から分からない」ことで、oxc はそれを[コード生成](./rule-dispatch/)で補っている。動的に知りたいなら、登録時にフラグを渡させる形もありうる。

**メタ情報とロジックを別トレイトに分ける。** `declare_oxc_lint!` は `RuleMeta` だけを生成し、`Rule` の実装には触らない。マクロが生成する範囲が狭いほど、読むときに展開を想像しなくて済む。**「マクロはメタ情報だけ、ロジックは手書き」**は、DSL を持ち込みすぎない良い線引きになる。

**doc コメントに「この拡張点を使ってはいけない用途」を書く。** `should_run` の doc がそれで、書かないと必ず誤用される。拡張点を提供するときは、想定用途より**非想定用途**のほうが書く価値が高いことがある。

**同じ形の実装が数百個並ぶなら、ジェネリックの中身を非ジェネリックに逃がす。** 866 本のルール設定に `serde_json::to_string_pretty` が展開されるのを避けるために、oxc はヘルパを非ジェネリック関数に切り出して `#[inline(never)]` を付けている。バイナリサイズとコンパイル時間の両方に効く。

**ホットループに載る型のサイズはテストで固定する。** 「168 → 16 バイトで 15% 速くなった」という履歴があるなら、それを守る assertion を置く。数字と PR リンクを添えておけば、後から「なぜ 16 なのか」に答えられる。
