---
title: "JS ツールチェインの地図"
description: "Babel / ESLint / Prettier / tsc / SWC / esbuild がそれぞれ何をしているか、そして oxc のどの crate がそれに対応するか。oxc の構造は「2 つのアプリ (oxlint / oxfmt) と、その下の 40 crate」という二層になっている。バージョンが crate 側 0.148.0 とアプリ側 1.81.0 で分かれているのもここから来ている。ARCHITECTURE.md は現状とずれているので注意がいる。"
group: "前提 — JS ツールと構文解析の語彙"
sidebar:
  order: 1
---

## 何を学んだか

JS のツールは種類が多いが、やっていることは 6 つに分類できる。

| やること                     | 代表的なツール                            | oxc の対応                                           |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| 構文を木にする               | Babel parser、acorn、espree、SWC、esbuild | `oxc_parser`                                         |
| 名前を解決する               | Babel の scope、ESLint の scope-manager   | `oxc_semantic`                                       |
| 規約違反を検査する           | ESLint、Biome                             | `oxc_linter` → **oxlint**                            |
| 新しい構文を古い構文に落とす | Babel、SWC、tsc                           | `oxc_transformer`                                    |
| 見た目を整える               | Prettier、Biome                           | `oxc_formatter` → **oxfmt**                          |
| 小さくする                   | Terser、esbuild、SWC                      | `oxc_minifier` + `oxc_mangler`                       |
| 文字列に戻す                 | 上記全部が内部に持つ                      | `oxc_codegen`                                        |
| 型を検査する                 | tsc                                       | **oxc にはまだない** (`oxc_type_checker` は足場のみ) |

oxc の構造は二層になる。

- **アプリケーション** — `apps/oxlint`、`apps/oxfmt`、`apps/shared`
- **crate** — `crates/` に 42 個

**バージョンが 2 系統ある。** crate は `0.148.0`、アプリは `1.81.0`。この章が固定しているタグ `apps_v1.81.0` はアプリ側の採番になる。

## なぜそうなっているか

### 既存ツールが分業していた理由

Babel も ESLint も Prettier も、それぞれ独自にパースする。同じファイルが 3 回パースされ、3 種類の AST ができる。

**歴史的な経緯としては自然だった。** それぞれ別の時期に別の人が作り、共通の AST 規格 (ESTree) はあるが、必要とする情報が違う。Prettier はコメントと元の改行が要るが ESLint は要らない、といった具合になる。

oxc の前提はこれと逆になる。**1 つの AST 定義を全ツールが共有する。** すると、

- 同じファイルを 1 回パースすれば全部のツールが使える
- AST の設計判断が全ツールに波及する ([木の設計](./ast-memory-layout/)が独立した群になっているのはこのため)
- 逆に「1 つのツールのためだけの情報」を AST に足しにくい ([CST を持たない](./formatter-and-lsp/)のはその帰結)

### crate の層構造

`ARCHITECTURE.md` に図がある。

```text title="ARCHITECTURE.md"
┌─────────────────────────────────────────────────────────────────┐
│                          Applications                           │
├─────────────────────────────────────────────────────────────────┤
│  oxlint  │  Language Server  │  NAPI Bindings  │  Future Tools  │
├─────────────────────────────────────────────────────────────────┤
│                        Core Libraries                           │
├─────────────────────────────────────────────────────────────────┤
│ Parser │ Semantic │ Linter │ Transformer │ Minifier │ Codegen   │
├─────────────────────────────────────────────────────────────────┤
│                    Foundation Libraries                         │
├─────────────────────────────────────────────────────────────────┤
│    AST    │  Allocator  │  Diagnostics  │   Span   │  Syntax    │
└─────────────────────────────────────────────────────────────────┘
```

基礎層の 5 つは、依存関係がほぼない。

```text title="ARCHITECTURE.md"
#### oxc_allocator
- **Dependencies**: None (foundational)

#### oxc_span
- **Dependencies**: None (foundational)

#### oxc_syntax
- **Dependencies**: oxc_span

#### oxc_diagnostics
- **Dependencies**: oxc_span

#### oxc_ast
- **Dependencies**: oxc_allocator, oxc_span, oxc_syntax
```

**基礎層が薄いことが、上の層の組み合わせやすさを生む。** [Codegen が `&Program` だけで動く](./codegen/)のも、`oxc_ast` の依存が 3 つしかないからだ。

### 主要な crate の役割

この章で扱うものを、依存の下から並べるとこうなる。

| crate                          | 役割                                                      | この章のどこ                                                  |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| `oxc_allocator`                | bump アリーナ、`Box` / `Vec`                              | [群 4](./bump-allocator/)                                     |
| `oxc_span`                     | `Span`、`SourceType`                                      | [群 4](./ast-memory-layout/)                                  |
| `oxc_syntax`                   | `SymbolFlags`、`ScopeFlags`、`Precedence`、`ModuleRecord` | [群 5](./scope-and-symbol/)、[群 3](./expression-precedence/) |
| `oxc_diagnostics`              | `OxcDiagnostic`                                           | [群 7](./diagnostics/)                                        |
| `oxc_ast`                      | AST 定義、`AstKind`、`AstBuilder`                         | [群 4](./ast-memory-layout/)                                  |
| `oxc_ast_macros`               | `#[ast]` マクロ                                           | [群 4](./ast-memory-layout/)                                  |
| `oxc_ast_visit`                | `Visit` / `VisitMut`                                      | [群 4](./astkind-and-visit/)                                  |
| `oxc_parser`                   | パーサ + **レキサ**                                       | [群 2](./byte-handlers/)、[群 3](./recursive-descent/)        |
| `oxc_lexer`                    | **別のレキサ (未使用)**                                   | [群 2](./the-other-lexer/)                                    |
| `oxc_semantic`                 | スコープ・シンボル・参照・early error                     | [群 5](./semantic-builder/)                                   |
| `oxc_traverse`                 | 書き換え用の走査                                          | [群 6](./traverse-vs-visitmut/)                               |
| `oxc_linter`                   | 866 本のルール                                            | [群 7](./rule-dispatch/)                                      |
| `oxc_transformer`              | TS/JSX 消去、ダウンレベル                                 | [群 8](./transformer/)                                        |
| `oxc_codegen`                  | AST → 文字列                                              | [群 8](./codegen/)                                            |
| `oxc_minifier` / `oxc_mangler` | 圧縮と名前短縮                                            | [群 8](./minifier-and-mangler/)                               |
| `oxc_formatter`                | 整形                                                      | [群 8](./formatter-and-lsp/)                                  |
| `oxc_language_server`          | LSP シェル (oxc 非依存)                                   | [群 8](./formatter-and-lsp/)                                  |
| `oxc_estree`                   | ESTree シリアライズ                                       | [群 4](./estree-serialization/)                               |

**レキサが `oxc_parser` の中にある**のが最初の注意点になる。`crates/oxc_lexer` という独立した crate もあるが、[こちらはパーサから使われていない](./the-other-lexer/)。

### `ARCHITECTURE.md` は現状とずれている

このファイルを読むときは、いくつか注意がいる。

```text title="ARCHITECTURE.md"
## Future Considerations

### Planned Extensions

- **Formatter**: Complete code formatting tool
- **Bundler**: Integration with bundling workflows
- **Type Checker**: Full TypeScript type checking
- **Plugin System**: User-defined transformations
```

**「今後の予定」に挙がっている 4 つのうち 3 つは既に実装されている。**

- Formatter → `oxc_formatter` + `apps/oxfmt` として存在する
- Type Checker → `oxc_type_checker` はあるが「まだ何も型検査しない足場」
- Plugin System → [JS プラグイン](./outside-rust/)として実装済み

MSRV の記述も食い違う。

```text title="ARCHITECTURE.md"
- **Rust**: MSRV 1.86.0+ with clippy and rustfmt integration
```

```toml title="Cargo.toml"
rust-version = "1.96.0"
```

**`Cargo.toml` のほうが真実**で、ARCHITECTURE.md は追随していない。

これは oxc に限った話ではない。**アーキテクチャ文書は実装より必ず遅れる。** 読むときは「設計の意図」の部分だけを取り、「現状」は `Cargo.toml` とディレクトリ構造から読む、という使い分けが要る。

一方、設計原理の部分は今も有効になる。

```text title="ARCHITECTURE.md"
### 1. Zero-Copy Architecture

The system is built around an arena allocator (`oxc_allocator`) that enables zero-copy operations
throughout the compilation pipeline. All AST nodes are allocated in a single arena, eliminating
the need for reference counting or garbage collection.
```

**「AST は 1 つのアリーナに載り、参照カウントも GC も要らない」**は、[群 4](./bump-allocator/) で見るとおり今もそうだ。

### AST が ESTree と違う理由

```text title="ARCHITECTURE.md"
##### AST Design Principles

The Oxc AST differs significantly from the [estree](https://github.com/estree/estree) AST specification
by removing ambiguous nodes and introducing distinct types. While many existing JavaScript tools rely
on estree as their AST specification, a notable drawback is its abundance of ambiguous nodes that often
leads to confusion during development.

For example, instead of using a generic estree `Identifier`, the Oxc AST provides specific types such as:
```

**ESTree の `Identifier` を 4 つに分けている。** 詳しくは[次の次のページ](./ast-and-estree/)で見る。

### バージョンが 2 系統ある

```toml title="Cargo.toml"
oxc = { version = "0.148.0", path = "crates/oxc" } # Main entry point
oxc_allocator = { version = "0.148.0", path = "crates/oxc_allocator" } # Memory management
oxc_ast = { version = "0.148.0", path = "crates/oxc_ast" } # AST definitions
```

crate 側は `0.148.0` で、**まだ `1.0` に達していない。** API が変わりうるという表明になる。

アプリ側 (oxlint / oxfmt) は `1.81.0` で安定版として出ている。**ライブラリとしては未成熟だが、ツールとしては安定している**という状態を、バージョンの分離で表している。

crate を使う側 (Rolldown、Vite など) は破壊的変更を受け入れる前提で、oxlint のユーザーはそうではない。

## ソースコードのどこか

- [`ARCHITECTURE.md`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/ARCHITECTURE.md) — 層構造と設計原理 (現状とのずれに注意)
- [`Cargo.toml`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/Cargo.toml) — 全 crate の一覧とバージョン
- [`crates/`](https://github.com/oxc-project/oxc/tree/apps_v1.81.0/crates) — 42 crate
- [`apps/`](https://github.com/oxc-project/oxc/tree/apps_v1.81.0/apps) — `oxlint` / `oxfmt` / `shared`
- [`tasks/`](https://github.com/oxc-project/oxc/tree/apps_v1.81.0/tasks) — コード生成、ベンチ、適合性テスト

`tasks/` にあるものが、この章で何度も出てくる。

| task                       | 役割                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `ast_tools`                | [AST から全部を生成](./ast-tools/)                                                        |
| `linter_codegen`           | [ルールの dispatch 表を生成](./rule-dispatch/)                                            |
| `transform_checker`        | [transform 後の semantic を検証](./transformer/)                                          |
| `track_memory_allocations` | [メモリ挙動をスナップショット](./bump-allocator/)                                         |
| `coverage`                 | test262 / Babel / TypeScript の適合性テスト。[レキサの差分検証](./the-other-lexer/)もここ |

テストの方針も ARCHITECTURE.md に書いてある。

```text title="ARCHITECTURE.md"
Correctness and reliability are taken extremely seriously in Oxc. We spend significant effort on
strengthening the test infrastructure to prevent problems from propagating to downstream tools:

- **Conformance Testing**: Test262, Babel, and TypeScript conformance suites
- **Fuzzing**: Extensive fuzzing to discover edge cases
- **Snapshot Testing**: Linter diagnostic snapshots for regression prevention
- **Ecosystem CI**: Testing against real-world codebases
```

**「下流のツールに問題が伝播しないように」**という動機が書かれている。oxc は Rolldown や Vite の基盤なので、バグの影響範囲が広い。

## どう活かすか

**同じ入力を複数のツールが処理するなら、中間表現の共有を検討する。** ただし代償は「1 つのツールのためだけの情報を足しにくい」ことで、oxc は CST を持たない判断でそれを引き受けている。**共有の利益と、個別最適の制約を天秤にかける。**

**基礎層を薄く保つと、上の層が組み合わせやすくなる。** `oxc_ast` の依存が 3 つしかないので、「パースして出力し直す」が 2 行で書ける。**基礎層に便利機能を足すと、全利用者がその依存を負う。**

**アーキテクチャ文書は実装より遅れる。** 「設計の意図」だけを読み、「現状」はコードから読む。逆に、文書を書く側としては**現状より意図を書くほうが寿命が長い。** oxc の ARCHITECTURE.md も、「Zero-Copy Architecture」の節は今も有効で、「Future Considerations」は古い。

**ライブラリとアプリでバージョンを分ける。** 「API は不安定だがツールは安定」という状態は実際によくある。バージョン番号で表明すれば、利用者が期待値を調整できる。crate を `1.0` にしないことで「破壊的変更がありうる」と言い続けられる。

**`tasks/` のような「ビルドに入らないツール」のディレクトリを持つ。** コード生成、適合性テスト、メモリ計測。本体の `crates/` と分けておくと、依存の混入を防げるし、「これは製品コードではない」が構造で分かる。
