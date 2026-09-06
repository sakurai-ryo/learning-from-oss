---
title: "診断の設計"
description: "パーサも semantic も linter も、同じ OxcDiagnostic 型でエラーを返す。中身は Box 1 本に押し込まれていて、型そのものは 8 バイト。ラベル・help・note・severity・code・URL という miette 互換の構造を持ち、レンダリングは自前のグラフィカルハンドラがやる。診断を作る関数はどのクレートでも #[cold] で、正常系の邪魔をしない。"
group: "木を検査する — Linter"
sidebar:
  order: 63
---

## 何を学んだか

oxc のエラー型は 1 つしかない。

```rust title="crates/oxc_diagnostics/src/lib.rs"
/// Describes an error or warning that occurred.
///
/// Used by all oxc tools.
#[derive(Debug, Clone, Eq, PartialEq)]
#[must_use]
pub struct OxcDiagnostic {
    inner: Box<OxcDiagnosticInner>,
}
```

パーサの構文エラーも、semantic の [early error](./early-errors/) も、リンタの 866 本のルールが出す警告も、全部この型になる。

**外側は `Box` 1 本なのでサイズは 8 バイト。** 中身は別に置いてある。

```rust title="crates/oxc_diagnostics/src/lib.rs"
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct OxcDiagnosticInner {
    pub message: Cow<'static, str>,
    pub labels: Labels,
    pub help: Option<Cow<'static, str>>,
    pub note: Option<Cow<'static, str>>,
    pub severity: Severity,
    pub code: OxcCode,
    pub url: Option<Cow<'static, str>>,
}
```

## なぜそうなっているか

### なぜ `Box` に押し込むのか

`OxcDiagnosticInner` は `Cow` が 4 本と `Labels` と `OxcCode` を持つので、100 バイト前後になる。これを直接使うと、`Result<T, OxcDiagnostic>` を返す関数のスタックフレームがその分太る。

**エラーはまず返らない。** 正常系のコードパスに 100 バイトの型を通すのは、返らないもののために毎回コストを払うことになる。`Box` にすれば `Result` は「`T` か、ポインタ 1 本」になる。

同じ動機が `#[cold]` にもある。[semantic の診断生成関数 53 本は全部 `#[cold]`](./early-errors/) で、リンタ側も同じ作法になっている。

- `Box` — 正常系の**サイズ**を守る
- `#[cold]` — 正常系の**命令キャッシュ**を守る

`Deref` / `DerefMut` が実装されているので、利用側は `diagnostic.message` と書ける。`Box` が透明になっている。

### `Cow<'static, str>` が使われている

`message` などが `String` ではなく `Cow<'static, str>` になっている。

- 固定文言 (`"Cannot use await in class static initialization block"`) は `Cow::Borrowed` で、確保が起きない
- 変数名を埋め込むもの (`format!("Identifier `{x0}` has already been declared")`) は `Cow::Owned`

診断の大半は固定文言なので、**確保が起きないケースが多数派**になる。`'static` に固定しているのはライフタイムを伝播させないためで、診断はソースコードより長生きすることがある (JSON 出力、LSP のキャッシュ)。

### miette 互換の構造

フィールドは miette (Rust のエラー報告ライブラリ) の `Diagnostic` トレイトに対応している。

| フィールド | 意味                                         |
| ---------- | -------------------------------------------- |
| `message`  | 1 行目に出る主メッセージ                     |
| `labels`   | ソースコードの範囲と、それぞれに付く短い説明 |
| `help`     | 「こうすればよい」                           |
| `note`     | 追加の説明                                   |
| `severity` | error / warning / advice                     |
| `code`     | `eslint(no-unused-vars)` や `TS(2804)`       |
| `url`      | ルールのドキュメントへのリンク               |

`help` と `note` の使い分けが doc に書かれている。

```rust title="crates/oxc_diagnostics/src/lib.rs"
    /// A note for the diagnostic.
    ///
    /// Similar to rustc - intended for additional explanation and information,
    /// e.g. why an error was emitted, how to turn it off.
    fn note(&self) -> Option<Cow<'_, str>> {
```

**`help` は「直し方」、`note` は「なぜ出たか / どう黙らせるか」。** rustc の慣習に合わせている。

`code` は 2 段構造になっている。

```rust title="crates/oxc_diagnostics/src/lib.rs"
#[derive(Debug, Default, Clone, Eq, PartialEq, PartialOrd, Ord)]
pub struct OxcCode {
    pub scope: Option<Cow<'static, str>>,
    pub number: Option<Cow<'static, str>>,
}

impl Display for OxcCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.scope, &self.number) {
            (Some(scope), Some(number)) => write!(f, "{scope}({number})"),
            (Some(scope), None) => scope.fmt(f),
            (None, Some(number)) => number.fmt(f),
            (None, None) => Ok(()),
        }
    }
}
```

`eslint(no-unused-vars)` は scope = `eslint`、number = `no-unused-vars`。`TS(2804)` は scope = `TS`、number = `2804`。**両方 `Option` なので、片方だけ、あるいは両方なしも表せる。** パーサの構文エラーには code が付かない。

### レンダリングは自前

`crates/oxc_diagnostics/src/handlers/graphical/` に 6 ファイル・6 万バイトある。miette の `GraphicalReportHandler` に相当するものを自前で持っている。

| ファイル            | 役割                       |
| ------------------- | -------------------------- |
| `report.rs` (16KB)  | 全体の組み立て             |
| `label.rs` (13KB)   | ラベルの配置と重なりの解消 |
| `line.rs` (11KB)    | 行の描画                   |
| `snippet.rs` (10KB) | ソース断片の切り出し       |
| `gutter.rs` (8KB)   | 行番号と罫線               |
| `theme.rs` (7KB)    | 色                         |

`json.rs` もあるので、`--format=json` で機械可読な出力も出せる。

### 診断の送り方

`DiagnosticService` が mpsc チャネルで診断を受け取り、1 本のスレッドで出力する。

```rust title="crates/oxc_diagnostics/src/lib.rs"
//! ## Reporting
//! If you are writing your own tools that may produce their own errors, you can use
//! [`DiagnosticService`] to format and render them to a string or a stream. It can receive
//! [`Error`]s over a multi-producer, single consumer
```

crate の doc に使い方の例まで書いてある。

```rust title="crates/oxc_diagnostics/src/lib.rs"
//! let (mut service, sender) = DiagnosticService::new(Box::new(GraphicalReportHandler::new()));
//!
//! thread::spawn(move || {
//!     let file_being_processed = Arc::new(NamedSource::new("file.txt", "source text"));
//!
//!     for _ in 0..10 {
//!         if let Err(diagnostic) = my_tool() {
//!             let error = diagnostic.with_source_code(Arc::clone(&file_being_processed));
//!             sender.send(vec![error]);
//!         }
//!         // The service will stop when all senders are dropped
//!     }
//! });
//!
//! service.run();
```

**「全ての sender が drop されるとサービスが止まる」**という終了条件になっている。ワーカーの数を数えたり、終了通知を送ったりする必要がない。[並列 lint](./parallel-lint/) がこの上に載っている。

`with_source_code(Arc<NamedSource>)` で、診断にソーステキストを後付けする。診断を作る側 (ルール) はファイル名もソースも知らなくてよく、**span だけ持って投げる**。ソースの結びつけは境界で 1 回やる。`Arc` なので、同じファイルから 100 件の診断が出てもソースは 1 部しか持たない。

### `#[must_use]`

```rust title="crates/oxc_diagnostics/src/lib.rs"
#[must_use]
pub struct OxcDiagnostic {
```

型に `#[must_use]` が付いているので、作って捨てると警告が出る。診断はビルダー形式 (`.with_label(..).with_help(..)`) で組み立てるので、**`with_*` の戻り値を受け取り忘れる**ミスが起こりやすい。型レベルで塞いでいる。

## ソースコードのどこか

- [`crates/oxc_diagnostics/src/lib.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_diagnostics/src/lib.rs) — `OxcDiagnostic` と `OxcCode`
- [`crates/oxc_diagnostics/src/service.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_diagnostics/src/service.rs) — `DiagnosticService`
- [`crates/oxc_diagnostics/src/handlers/graphical/`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_diagnostics/src/handlers/) — グラフィカル出力
- [`crates/oxc_semantic/src/diagnostics.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_semantic/src/diagnostics.rs) — semantic 側の生成関数 53 本

診断を作る側の典型はこうなる。

```rust title="crates/oxc_semantic/src/diagnostics.rs"
#[cold]
pub fn redeclaration(x0: &str, span1: Span, span2: Span) -> OxcDiagnostic {
    OxcDiagnostic::error(format!("Identifier `{x0}` has already been declared")).with_labels([
        span1.label(format!("`{x0}` has already been declared here")),
        span2.label("It can not be redeclared here"),
    ])
}
```

**ラベルが 2 つある。** 「ここで既に宣言されている」と「ここでは再宣言できない」。1 つの診断が複数の場所を指せるので、原因と結果を同時に示せる。span を 1 つしか持たない診断型だと、この表現ができない。

リンタ側では、`code` と `url` が [`declare_oxc_lint!`](./rule-trait/) のメタ情報から自動で付く。

```rust title="crates/oxc_linter/src/lib.rs"
/// Base URL for the documentation, used to generate rule documentation URLs when a diagnostic is reported.
const WEBSITE_BASE_RULES_URL: &str = "https://oxc.rs/docs/guide/usage/linter/rules";
```

ルールの実装は `ctx.diagnostic(...)` を呼ぶだけで、プラグイン名・ルール名・URL は `LintContext` が付ける。

## どう活かすか

**ツール群でエラー型を 1 つに揃える。** パーサ・semantic・linter が別々のエラー型を持つと、境界ごとに `From` 実装が要り、レンダリングも重複する。1 つにすると、出力形式 (グラフィカル / JSON / SARIF / LSP) の実装も 1 か所で済む。

**エラー型は `Box` に押し込む。** `Result<T, E>` のサイズは `E` に引きずられる。エラーが稀なら、`E` を 8 バイトにして中身をヒープに置くほうが正常系が速い。`Deref` を実装すれば利用側は `Box` を意識しない。

**診断は「span だけ持って投げ、ソースは境界で結びつける」。** 診断を作る側がファイル名やソーステキストを知る必要がなくなる。`Arc<NamedSource>` で共有すれば、同じファイルの診断が何件出てもソースは 1 部。

**1 つの診断が複数の場所を指せるようにする。** 「ここで宣言」「ここで再宣言」のように、原因と結果が別の場所にあるエラーは多い。span が 1 つしかない設計だと、後から拡張できない。

**`help` と `note` を分けて、使い分けを決めておく。** oxc は rustc に合わせて「`help` = 直し方、`note` = なぜ / どう黙らせるか」にしている。決めておかないと、書く人ごとにばらつく。

**mpsc の「sender が全部 drop されたら終わり」を終了条件にする。** ワーカー数を数える必要も、終了メッセージを送る必要もない。Rust の所有権がそのまま終了検知になる。
