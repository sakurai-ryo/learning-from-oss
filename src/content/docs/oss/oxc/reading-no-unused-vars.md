---
title: "ルールを読む — no-unused-vars"
description: "単一ルールとしては最大級の 10,064 行。実装しているのは from_configuration / run_once / should_run の 3 つだけで、run はない。AST を歩かず、シンボルテーブルを全走査して「参照が 0 件のシンボル」を探す。ここまでで作ってきた Semantic の API が何のためにあったのかが、このルール 1 本で回収できる。"
group: "木を検査する — Linter"
sidebar:
  order: 62
---

## 何を学んだか

`no-unused-vars` は oxlint の中で単一ルールとして最大級で、テスト込み 10,064 行・19 ファイルある。

```
no_unused_vars/
├── mod.rs           (18KB)  Rule 実装と報告
├── options.rs       (31KB)  ESLint 互換の設定パース
├── usage.rs         (41KB)  「使われている」の判定
├── ignored.rs       (21KB)  無視パターンの判定
├── allowed.rs       (15KB)  許容されるケース
├── symbol.rs        (9KB)   Semantic への薄いラッパ
├── binding_pattern.rs
├── diagnostic.rs
├── fixers/          (5 ファイル)
└── tests/           (4 ファイル・17 万バイト)
```

それだけの規模なのに、[`Rule` トレイト](./rule-trait/)で実装しているのは 3 つだけになる。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs"
impl Rule for NoUnusedVars {
    fn from_configuration(value: serde_json::Value) -> Result<Self, serde_json::error::Error> {
        NoUnusedVarsOptions::try_from(value)
            .map(|options| Self(Box::new(options)))
            .map_err(|error| <serde_json::Error as serde::de::Error>::custom(error.to_string()))
    }

    fn run_once(&self, ctx: &LintContext) {
        let precomputed_exported_names = Symbol::collect_exported_local_names(ctx.module_record());

        for symbol in ctx.scoping().symbol_ids() {
            let symbol = Symbol::new(ctx, ctx.module_record(), symbol);
            if Self::should_skip_symbol(&symbol) {
                continue;
            }

            self.run_on_symbol_internal(&symbol, ctx, &precomputed_exported_names);
        }
    }

    fn should_run(&self, ctx: &ContextHost) -> bool {
        // ignore .d.ts and vue/svelte/astro files.
        !ctx.source_type().is_typescript_definition()
            && !ctx
                .file_extension()
                .is_some_and(|ext| ext == "vue" || ext == "svelte" || ext == "astro")
    }
}
```

**`run` がない。** このルールは AST を歩かず、`ctx.scoping().symbol_ids()` でシンボルテーブルを全走査する。

## なぜそうなっているか

### なぜ AST 走査ではないのか

「使われていない変数」は、**AST のノードではなくシンボルの性質**だ。`const unused = 1;` を見ても、それが使われているかは分からない。ファイル全体を見て、そのシンボルへの参照が 0 件だと分かって初めて言える。

[群 5 の semantic](./semantic-builder/) が、まさにその情報をテーブルとして持っている。だから走査対象はシンボルテーブルになる。

`Rule::run_on_symbol` のようなメソッドは存在しない。シンボルを走査したいルールは `run_once` の中で自前でループを回す。ルールの中で `no-unused-vars` は特殊なほうなので、そのために専用の拡張点を用意していない、という判断になる。

### `Symbol` は Semantic への薄いラッパ

このルールは `Symbol` という自前の型を作って、そこに `Semantic` へのアクセスを集めている。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/symbol.rs"
#[derive(Clone)]
pub(super) struct Symbol<'s, 'a> {
    semantic: &'s Semantic<'a>,
    module_record: &'s ModuleRecord,
    id: SymbolId,
    flags: SymbolFlags,
}
```

`flags` だけがコピーされて持たれている。**判定のたびに引くのが一番多いフィールドだから**で、他は `semantic` を経由して引く。

ここに並んでいるメソッドが、そのまま[群 5 で作ってきたもの](./data-oriented-scoping/)の一覧になる。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/symbol.rs"
    #[inline]
    pub fn name(&self) -> &str {
        self.scoping().symbol_name(self.id)
    }

    #[inline]
    pub fn scope_id(&self) -> ScopeId {
        self.scoping().symbol_scope_id(self.id)
    }

    #[inline]
    pub fn declaration(&self) -> &AstNode<'a> {
        self.nodes().get_node(self.declaration_id())
    }

    /// Returns `true` if this symbol has any references of any kind. Does not
    /// check if a references is "used" under the criteria of this rule.
    #[inline]
    pub fn has_references(&self) -> bool {
        !self.scoping().symbol_is_unused(self.id)
    }

    #[inline]
    pub fn references(&self) -> impl DoubleEndedIterator<Item = &Reference> + '_ + use<'_> {
        self.scoping().get_resolved_references(self.id)
    }

    #[inline]
    fn declaration_id(&self) -> NodeId {
        self.scoping().symbol_declaration(self.id)
    }

    #[inline]
    pub fn iter_parents(&self) -> impl Iterator<Item = &AstNode<'a>> + '_ {
        self.nodes().ancestors(self.declaration_id())
    }
```

| 使っている Semantic の API    | 群 5 のどこで作られたか                        |
| ----------------------------- | ---------------------------------------------- |
| `symbol_ids()`                | [SymbolTable の SoA](./data-oriented-scoping/) |
| `symbol_flags(id)`            | [Binder が `includes` として設定](./binder/)   |
| `symbol_name(id)`             | `ScopingCell` の `symbol_names`                |
| `symbol_scope_id(id)`         | Binder が登録先スコープとして設定              |
| `symbol_declaration(id)`      | Binder が宣言ノードの `NodeId` を記録          |
| `symbol_is_unused(id)`        | [参照解決](./reference-resolution/)の結果      |
| `get_resolved_references(id)` | 同上                                           |
| `nodes().ancestors(node_id)`  | `AstNodes` の親リンク                          |
| `module_record()`             | [module_record](./module-record/)              |

**群 5 の各ページが何のためにあったかが、この表で回収できる。** semantic は「lint ルールがこう引く」ことを前提に作られている。

### 「使われている」の定義が 41KB ある

`has_references()` は「参照が 1 件でもあるか」を返すだけだが、このルールが欲しいのは**「使用」としてカウントされる参照があるか**だ。差が出るケースが大量にある。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/usage.rs"
//! This module contains logic for checking if any [`Reference`]s to a
//! [`Symbol`] are considered a usage.
```

- 自己参照 (`function f() { f(); }` で `f` が他から呼ばれない) は使用ではない
- 再代入だけ (`let x = 1; x = 2;`) は使用ではない
- 型としてだけ使われている値
- 分割代入の rest sibling (`const { a, ...rest } = o;` の `a`)

判定は `SymbolFlags` の組み合わせで前段の枝刈りをする。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/usage.rs"
    /// 1. Imported functions will never have calls to themselves within their
    ///    own declaration since they are declared outside the current module
    /// 2. Catch variables are always parameter-like and will therefore never have
    ///    a function declaration.
    #[inline]
    fn is_maybe_callable(&self) -> bool {
        const IMPORT: SymbolFlags = SymbolFlags::Import.union(SymbolFlags::TypeImport);
        // note: intentionally do not use `SymbolFlags::is_type` here, since that
        // can return `true` for values
        const TYPE: SymbolFlags =
            SymbolFlags::TypeAlias.union(SymbolFlags::TypeParameter).union(SymbolFlags::Interface);
        const ENUM: SymbolFlags = SymbolFlags::Enum.union(SymbolFlags::EnumMember);
        const NAMESPACE_LIKE: SymbolFlags =
            SymbolFlags::NamespaceModule.union(SymbolFlags::ValueModule);

        !self.flags().intersects(
            IMPORT.union(TYPE).union(ENUM).union(NAMESPACE_LIKE).union(SymbolFlags::CatchVariable),
        )
    }
```

**「自己参照かどうかを調べる必要があるか」を先にフラグで判定する。** import なら自分自身を呼ぶ参照はありえないので、高い判定を丸ごと飛ばせる。

コメントに実装者の正直な注記がある。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/usage.rs"
    // NOTE(@don): all of these should be `#[inline]` and `const`. by inlining
    // it, rustc should be able to detect redundant flag checks and optimize
    // them away. Note that I haven't actually checked the assembly output to
    // confirm this; if you are reading this and decide to do so, please let me
    // know the results.
```

**「こう最適化されるはずだが、アセンブリは確認していない」**と書いてある。検証していないことを書き残すのは、後から検証する人への引き継ぎになる。

`SymbolFlags::is_type` を使わない理由も書いてある — 「値に対しても `true` を返しうるから」。既存のヘルパを避けた理由が残っているので、後から「これ `is_type()` でいいのでは」と直されることがない。

### 例外の 8 割は型システムとフレームワーク由来

`should_skip_symbol` を読むと、このルールが何と戦っているかが見える。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs"
    fn should_skip_symbol(symbol: &Symbol<'_, '_>) -> bool {
        const AMBIENT_NAMESPACE_FLAGS: SymbolFlags =
            SymbolFlags::NamespaceModule.union(SymbolFlags::Ambient);
        let flags = symbol.flags();

        // 1. ignore enum members. Only enums get checked
        if flags.intersects(SymbolFlags::EnumMember)
            // ambient namespaces
            || flags == AMBIENT_NAMESPACE_FLAGS
            || (symbol.is_in_ts() && symbol.is_in_declare_global())
        {
            return true;
        }

        let node_id = symbol.declaration().id();
        if flags.intersects(SymbolFlags::FunctionScopedVariable)
            && let AstKind::FormalParameters(formal_parameters) =
                symbol.nodes().parent_node(node_id).kind()
            && formal_parameters.kind.is_signature()
        {
            return true;
        }

        // In some cases (e.g. "jsx": "react" in tsconfig.json), React imports
        // get used in generated code. We don't have a way to detect
        // "jsxPragmas" or whether TSX files are using "jsx": "react-jsx", so we
        // just allow all cases.
        if symbol.flags().contains(SymbolFlags::Import)
            && symbol.is_in_jsx()
            && symbol.is_possibly_jsx_factory()
        {
```

`should_run` の側も同じ性質を持つ。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs"
        // ignore .d.ts and vue/svelte/astro files.
        // 1. declarations have side effects (they get merged together)
        // 2. vue/svelte/astro scripts declare variables that get used in the template, which
        //    we can't detect
```

**「テンプレート側で使われているが、我々には見えない」**という理由でファイルごと除外している。`no-unused-vars` の難しさは、判定アルゴリズムではなく**「見えない使用」の列挙**にある。10,064 行のうち、コアの判定は数百行で、残りはこの列挙とテストになる。

### 通し例で追う

```ts title="example.ts"
import { readFile } from "node:fs/promises";

export type Entry = { name: string; size: number };

export async function collect(path: string): Promise<Entry[]> {
  const raw = await readFile(path, "utf8");
  const unused = 1;
  return raw.split("\n").map((name) => ({ name, size: name.length }));
}
```

`run_once` はまず `module_record` から export されたローカル名を集める。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs"
        let precomputed_exported_names = Symbol::collect_exported_local_names(ctx.module_record());
```

**1 回だけ計算してループの外に置く。** シンボルごとに `module_record` を舐めると O(symbols × exports) になる。

その後シンボルテーブルを回る。

| シンボル            | flags                                  | 参照数     | 判定                                |
| ------------------- | -------------------------------------- | ---------- | ----------------------------------- |
| `readFile`          | `Import`                               | 1          | 使用あり                            |
| `Entry`             | `TypeAlias`                            | 1 (型参照) | 使用あり。export もされている       |
| `collect`           | `Function`                             | 0          | **export されているので報告しない** |
| `path`              | `FunctionScopedVariable`               | 1          | 使用あり                            |
| `raw`               | `BlockScopedVariable \| ConstVariable` | 1          | 使用あり                            |
| `unused`            | 同上                                   | 0          | **報告**                            |
| `name` (アロー引数) | `FunctionScopedVariable`               | 2          | 使用あり                            |

判定の要は `run_on_symbol_internal` の 1 行になる。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs"
        let is_used = symbol.is_exported(exported_names) || symbol.has_usages(self);
```

`collect` は参照が 0 件だが `is_exported` が真なので報告されない。**export の判定に [module_record](./module-record/) が要る**のはここで、パース中に集めておいたものがこの 1 行のために使われる。

報告の後、宣言の種類ごとに fix を作る。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs"
        let declaration = symbol.declaration();
        match declaration.kind() {
            // NOTE: match_module_declaration(AstKind) does not work here
            AstKind::ImportDeclaration(_)
            | AstKind::ImportSpecifier(_)
            | AstKind::ImportExpression(_)
            | AstKind::ImportDefaultSpecifier(_)
            | AstKind::ImportNamespaceSpecifier(_) => {
                let diagnostic = diagnostic::imported(symbol);
                // ...
            }
```

`fixers/` が 5 ファイルに分かれているのは、削除の仕方が宣言の種類ごとに違うからだ。`import { a, b } from "x"` の `a` だけを消すのと、`const x = 1;` を文ごと消すのと、関数の引数を消すのは別の処理になる ([auto fix](./auto-fix/))。

## ソースコードのどこか

- [`crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs) — `Rule` 実装と報告
- [`crates/oxc_linter/src/rules/eslint/no_unused_vars/symbol.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_linter/src/rules/eslint/no_unused_vars/symbol.rs) — Semantic への窓口
- [`crates/oxc_linter/src/rules/eslint/no_unused_vars/usage.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_linter/src/rules/eslint/no_unused_vars/usage.rs) — 「使用」の定義 (41KB)
- [`crates/oxc_linter/src/rules/eslint/no_unused_vars/tests/`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_linter/src/rules/eslint/no_unused_vars/tests/) — 17 万バイトのテスト

テストが `eslint.rs` / `typescript_eslint.rs` / `oxc.rs` / `react.rs` に分かれている。**出典ごとにファイルを分ける**ことで、「これは ESLint 本家のテストケース」「これは oxc 独自」が一目で分かる。互換実装ではこの分け方が効く — 本家のテストが増えたときにマージしやすい。

`NoUnusedVars` 自体は `Box` に包まれている。

```rust title="crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs"
#[derive(Debug, Default, Clone)]
pub struct NoUnusedVars(Box<NoUnusedVarsOptions>);
```

[`RuleEnum` を 16 バイトに保つ](./rule-trait/)ための `Box` で、`NoUnusedVarsOptions` は正規表現などを持つので大きい。

## どう活かすか

**「AST のノードを見て判断できるか」で走査対象を決める。** ノード単体で判断できるなら `run`、ファイル全体の情報が要るなら `run_once` でテーブルを走査する。この 2 択を最初に決めると、そのルールの構造がほぼ決まる。

**ドメインの型に薄いラッパを 1 枚被せる。** `Symbol` 構造体は `Semantic` へのアクセスを 1 か所にまとめていて、`usage.rs` や `ignored.rs` は `Semantic` の API を直接知らない。**下層 API が変わったときに直すのが `symbol.rs` だけで済む。** 41KB のファイルが下層に直接依存していたら、この規模は維持できない。

**ループの外で計算できるものは外に出す。** `collect_exported_local_names` は 1 行だが、これがループの中にあれば O(symbols × exports) になる。読むときは「この計算はループ不変か」を常に見る。

**判定の前に安いフラグで枝刈りする。** `is_maybe_callable()` は 1 回のビット演算で「そもそも自己参照を調べる必要があるか」を返す。高い判定の前に安い判定を置く順序は、`SymbolFlags` のようなビット表現があって初めて成立する。

**「確認していないこと」をコメントに書く。** `NOTE(@don)` の「アセンブリを見ていない、見た人は教えてほしい」は、後から検証する人への正直な引き継ぎになる。**検証済みのように書くほうが害が大きい。**

**互換実装のテストは出典ごとに分ける。** `eslint.rs` / `typescript_eslint.rs` / `oxc.rs` / `react.rs`。本家のテストが増えたときに差分を取れるし、「これは我々が意図的に変えた挙動」も分かる。
