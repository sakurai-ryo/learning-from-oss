---
title: "TS と JSX を 1 つのパーサで"
description: "oxc は JS / TS / JSX / TSX を 1 つのパーサで読む。source_type と is_ts というフラグの組み合わせで分岐し、AST の型は共通のまま TS 専用ノードが混ざる。厄介なのは < の曖昧さで、JSX ファイルでは JSX 要素、非 JSX の TS ファイルでは型アサーション、式の途中では型引数になりうる。修飾子の集合は Vec<Modifier> を避けて、ビットフィールド + 固定長配列で 64 バイトに収めている。"
group: "木を作る — Parser"
sidebar:
  order: 23
---

## 何を学んだか

oxc のパーサは 1 つで、JS / TS / JSX / TSX を全部読む。切り替えは `SourceType` と、そこから導かれる 2 つのフラグになる。

```rust title="crates/oxc_parser/src/lib.rs"
    /// Precomputed typescript detection
    is_ts: bool,
```

`source_type.is_jsx()` と `is_ts` の 2 ビットで、文法の分岐がほぼ全部決まる。

AST の型は共通で、TS 専用のノードが `Expression` などの variant として混ざっている ([enum 継承](./ast-memory-layout/))。

```rust title="crates/oxc_ast/src/ast/js.rs"
    /// See [`TSAsExpression`] for AST node details.
    TSAsExpression(Box<'a, TSAsExpression<'a>>) = 35,
    /// See [`TSSatisfiesExpression`] for AST node details.
    TSSatisfiesExpression(Box<'a, TSSatisfiesExpression<'a>>) = 36,
    /// See [`TSTypeAssertion`] for AST node details.
    TSTypeAssertion(Box<'a, TSTypeAssertion<'a>>) = 37,
    /// See [`TSNonNullExpression`] for AST node details.
    TSNonNullExpression(Box<'a, TSNonNullExpression<'a>>) = 38,
    /// See [`TSInstantiationExpression`] for AST node details.
    TSInstantiationExpression(Box<'a, TSInstantiationExpression<'a>>) = 39,
```

**JS のファイルをパースしても、これらの variant は AST 型の中に存在し続ける。** 使われないだけだ。

そして `<` の扱いが最大の難所になる。

## なぜそうなっているか

### `<` が 4 通りに読まれうる

```ts
<div />                  // JSX 要素 (jsx ファイル)
<Foo>x</Foo>             // JSX 要素
<T>x                     // 型アサーション (非 jsx の ts ファイル)
foo<T>()                 // 型引数
a < b                    // 比較演算子
```

判定は `source_type.is_jsx()` と `is_ts` で先に大きく切る。

```rust title="crates/oxc_parser/src/js/expression.rs"
        if self.source_type.is_jsx() && self.at(Kind::LAngle) {
            return self.parse_jsx_expression();
        }
```

```rust title="crates/oxc_parser/src/js/expression.rs"
            // TS type assertion, a modified `UnaryExpression`: `< Type > UnaryExpression`, e.g. `<T>x`.
            // In a non-JSX, non-TS file a leading `<` is instead a JSX-in-non-JSX error, e.g. `<div/>`.
            // (`<` in a JSX file is not matched here; it falls through to the `UpdateExpression` arm,
            // which parses the JSX element.)
            Kind::LAngle if !self.source_type.is_jsx() => {
```

**`.tsx` では `<T>x` という型アサーションが書けない**という TypeScript の制約が、この分岐そのものになっている。JSX ファイルでは `<` は常に JSX の始まりとして扱われる。

コメントが「どの分岐に落ちるか」を明示しているのが親切で、`match` の腕を読むときに他の腕との関係が分かる。

### 式の途中の `<` は型引数かもしれない

```ts
foo<T>(); // 型引数 + 呼び出し
foo<T>; // TSInstantiationExpression (型引数だけ)
a < b > c; // 比較を 2 回
```

これは試して巻き戻すしかない。

```rust title="crates/oxc_parser/src/js/expression.rs"
                Kind::LAngle | Kind::ShiftLeft if self.is_ts => {
                    if let Some(arguments) = self.parse_type_arguments_in_expression() {
                        lhs = Expression::new_ts_instantiation_expression(
                            self.end_span(lhs_start),
                            lhs,
                            arguments,
                            self,
                        );
                    } else {
                        // `re_lex_as_typescript_l_angle` may have popped the original token
                        // (e.g. `<<`) from the collected token stream. Rewind restored the
                        // parser's current token, so write it back to the stream.
                        // This is a no-op when tokens are statically disabled (`NoTokensLexerConfig`).
                        self.lexer.rewrite_last_collected_token(self.token);
                        return lhs;
                    }
```

`Kind::ShiftLeft` (`<<`) も対象になっているのは、`Foo<<T>() => void>` のようなケースがあるから。[再字句化](./on-demand-tokens/)で `<<` を `<` 1 個に読み直す。

`else` 節のコメントが、[トークン列を貯める設定](./on-demand-tokens/)との相互作用を説明している。**再字句化でトークン列の末尾を差し替えたが、巻き戻したので元に戻す必要がある。** `rewrite_last_collected_token` はそのためだけにあり、トークンを貯めない設定ではコンパイル時に消える。

型引数の読み取り自体は `>` の再字句化から始まる。

```rust title="crates/oxc_parser/src/ts/types.rs"
    pub(crate) fn try_parse_type_arguments(
        &mut self,
    ) -> Option<ArenaBox<'a, TSTypeParameterInstantiation<'a>>> {
        if self.re_lex_ts_l_angle() {
            let start = self.cur_start();
            let opening_span = self.cur_token().span();
            self.expect(Kind::LAngle);
            let (params, _) = self.parse_delimited_list(
                Kind::RAngle,
                Kind::Comma,
                opening_span,
                Self::parse_ts_type,
            );
            self.expect(Kind::RAngle);
            let span = self.end_span(start);
            if params.is_empty() {
                self.error(diagnostics::ts_empty_type_argument_list(span));
            }
            if !self.is_ts {
                self.error(diagnostics::type_arguments_in_ts(span));
            }
            return Some(TSTypeParameterInstantiation::boxed(span, params, self));
        }
        None
    }
```

**`!self.is_ts` のときもパースは通し、エラーだけ足す。** JS のファイルに TS の構文が書かれていたら、「TS 構文は JS では使えない」という診断を出しつつ AST は作る。[エラー回復](./error-recovery/)の方針と一貫している。

型参照の側には追加条件がある。

```rust title="crates/oxc_parser/src/ts/types.rs"
    pub(crate) fn parse_type_arguments_of_type_reference(
        &mut self,
    ) -> Option<ArenaBox<'a, TSTypeParameterInstantiation<'a>>> {
        if !self.cur_token().is_on_new_line() && self.re_lex_ts_l_angle() {
```

**改行があったら型引数として読まない。** [`is_on_new_line` フラグ](./on-demand-tokens/)がここでも効く。

### 修飾子を `Vec<Modifier>` にしない

TypeScript のメンバには修飾子が付く。

```ts
class Foo {
  public static readonly x: number;
}
```

素直に `Vec<Modifier>` で持つと、修飾子が 1 個でもヒープ確保が起きる。しかも修飾子は 15 種類しかない。

```rust title="crates/oxc_parser/src/modifiers.rs"
fieldless_enum! {
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    #[repr(u8)]
    pub enum ModifierKind {
        Declare = 0,
        Private = 1,
        Protected = 2,
        Public = 3,
        Static = 4,
        Readonly = 5,
        Abstract = 6,
        Override = 7,
        Async = 8,
        Const = 9,
        In = 10,
        Out = 11,
        Default = 12,
        Accessor = 13,
        Export = 14,
    }
}
```

**同じ種類の修飾子は 2 回書けない**ので、「種類 → 出現位置」のマップで足りる。しかも種類が 15 個なら固定長配列が使える。

```rust title="crates/oxc_parser/src/modifiers.rs"
    /// Stored as a fixed-size array of start offsets indexed by [`ModifierKind`] discriminant.
    /// The `kinds` bitfield tracks which entries are populated.
    /// Full `Span`s are reconstructed on demand, since each modifier keyword has a fixed length.
    ///
    /// `#[repr(C)]` to make `kinds` field first. This is preferable as it is the most commonly accessed field.
    #[repr(C)]
    pub struct Modifiers {
        /// Bitfield of which modifier kinds are present.
        kinds: ModifierKinds,
        /// Start offset for each modifier, indexed by `ModifierKind` discriminant.
        /// Entries whose corresponding bit is set in `kinds` are initialized, other entries may not be.
        /// Therefore it is only safe to assume that `offsets[kind as usize]` is initialized if `kinds.contains(kind)`.
        offsets: [MaybeUninit<u32>; ModifierKind::VARIANTS.len()],
    }
```

3 つの工夫が重なっている。

**1. `Span` ではなく `start` だけを持つ。** 修飾子はキーワードなので長さが固定で、種類から復元できる。

```rust title="crates/oxc_parser/src/modifiers.rs"
/// Length of each modifier keyword in bytes, indexed by [`ModifierKind`] discriminant.
static MODIFIER_LENGTHS: [u8; ModifierKind::VARIANTS.len()] = {
    let mut lengths = [0; ModifierKind::VARIANTS.len()];

    let mut i = 0;
    while i < ModifierKind::VARIANTS.len() {
        let kind = ModifierKind::VARIANTS[i];
        let len = kind.as_str().len() as u8;
        lengths[kind as usize] = len;
        i += 1;
    }

    lengths
};
```

**長さの表がコンパイル時に構築される。** `as_str()` から自動で導出しているので、キーワードを足しても手で長さを書く必要がない。

**2. `MaybeUninit<u32>` で初期化を省く。** 使わないエントリを 0 で埋める必要すらない。どれが有効かは `kinds` ビットフィールドが持つ。

**3. `#[repr(C)]` で `kinds` を先頭に置く。** 理由がコメントにある — 「最もよくアクセスされるフィールドだから」。`contains()` の呼び出しが構造体の先頭を読むだけになる。[`Arena` のフィールド順](./bump-allocator/)と同じ発想だが、こちらは目的が違う (キャッシュではなくオフセット 0 のアクセス)。

安全性はモジュールで囲って守っている。

```rust title="crates/oxc_parser/src/modifiers.rs"
// Wrapped in a module to avoid exposing `offsets` and `kinds` fields of `Modifiers`.
// The two must be kept in sync to satisfy safety invariants.
#[expect(clippy::module_inception)]
mod modifiers {
```

**`kinds` と `offsets` が同期していないと UB になる**ので、フィールドを外に見せない。`add` を通してしか書けないようにすれば、不変条件は `add` の中だけで守れる。

```rust title="crates/oxc_parser/src/modifiers.rs"
        /// Add a modifier.
        /// If a modifier with this [`ModifierKind`] has already been added, it is overwritten.
        #[inline]
        pub(super) const fn add(&mut self, kind: ModifierKind, start: u32) {
            self.kinds = self.kinds.with(kind);
            self.offsets[kind as usize] = MaybeUninit::new(start);
        }
```

サイズは `ModifierKinds` (u16 相当) + `u32 × 15` = 64 バイト。**`Vec<Modifier>` (24 バイト + ヒープ) と比べて、スタックには載るがヒープを触らない。** 修飾子は多くのノードで空なので、空のときのコストがゼロになるのが効く。

### 通し例で見る

```ts title="example.ts"
export type Entry = { name: string; size: number };

export async function collect(path: string): Promise<Entry[]> {
```

| 構文                             | パースされ方                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `export`                         | `ModifierKind::Export` として `Modifiers` に入り、`ExportNamedDeclaration` になる |
| `type Entry = ...`               | `TSTypeAliasDeclaration` (`is_ts` が false ならエラー)                            |
| `{ name: string; size: number }` | `TSTypeLiteral`                                                                   |
| `async`                          | `ModifierKind::Async`。[`Context::Await` を立てる](./context-flags/)              |
| `path: string`                   | `FormalParameter` + `TSTypeAnnotation`                                            |
| `Promise<Entry[]>`               | `TSTypeReference` + `parse_type_arguments_of_type_reference`                      |
| `Entry[]`                        | `TSArrayType`                                                                     |

`Promise<Entry[]>` の `>` は 1 個なので再字句化は起きない。`Promise<Array<Entry>>` なら `>>` として読まれ、[`re_lex_ts_r_angle`](./on-demand-tokens/) が 2 回働く。

## ソースコードのどこか

- [`crates/oxc_parser/src/ts/`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/ts/) — TypeScript の文法
- [`crates/oxc_parser/src/jsx/`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/jsx/) — JSX の文法
- [`crates/oxc_parser/src/modifiers.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/modifiers.rs) — `Modifiers` と `ModifierKind`
- [`crates/oxc_parser/src/ts/types.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/ts/types.rs) — 型引数の判定
- [`crates/oxc_parser/src/lexer/jsx.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/jsx.rs) — JSX 用の字句解析

JSX はレキサ側にも専用の入口がある。

```rust title="crates/oxc_parser/src/cursor.rs"
    /// Move to the next `JSXChild`
    pub(crate) fn advance_for_jsx_child(&mut self) {
        self.prev_token_end = self.token.end();
        self.token = self.lexer.next_jsx_child();
    }
```

```rust title="crates/oxc_parser/src/cursor.rs"
    /// Tell lexer to continue reading jsx identifier if the lexer character position is at `-` for `<component-name>`.
    pub(crate) fn continue_lex_jsx_identifier(&mut self) -> bool {
```

**JSX のテキスト内容は通常のトークン化と規則が違う** (`<` と `{` 以外は全部テキスト) ので、パーサが「今は JSX の子要素を読んでいる」とレキサに伝える。`<component-name>` のハイフンも、通常の識別子では区切りになるが JSX ではそうでない。

[トークン列を持たない設計](./on-demand-tokens/)がここでも効いている。**トークン化の規則をパーサ側が指定できる**のは、レキサがオンデマンドだからだ。

## どう活かすか

**方言を 1 つのパーサで扱うなら、分岐の軸を最小限のフラグに絞る。** oxc は `is_jsx` と `is_ts` の 2 ビットで、JS / TS / JSX / TSX の 4 通りを表現している。**方言ごとにパーサをコピーすると、共通部分の修正が 4 箇所になる。**

**方言専用のノードは共通の AST 型に混ぜてよい。** `Expression` に `TSAsExpression` があっても、JS のパースでは作られないだけ。型を分けると、下流 (linter、codegen) が両方を扱う必要が出る。

**曖昧な構文は、まず「文脈で確定するもの」と「試すしかないもの」に分ける。** `.tsx` の `<` は JSX で確定する (フラグ 1 つ)。式の途中の `<` は試すしかない ([チェックポイント](./recursive-descent/))。**先に確定できるものを確定させてから、残りを試す**順序にすると、試行の回数が減る。

**「種類の集合」は `Vec` ではなくビットフィールド + 固定長配列にできる。** 種類が有限で、同じ種類が 2 回現れないなら、`Vec<T>` は過剰になる。`MaybeUninit` を使えば初期化コストもゼロにできるが、**「どのエントリが有効か」を別に持つ必要があり、その同期が不変条件になる。**

**不変条件を持つ構造体は、モジュールで囲ってフィールドを隠す。** `Modifiers` の `kinds` と `offsets` は同期していないと UB になる。private モジュールに入れて `add` だけを公開すれば、不変条件を守る場所が 1 か所になる。

**固定長の情報は導出できるなら保持しない。** 修飾子は `start` だけ持ち、`Span` は種類から長さを引いて復元する。**`u32` 1 本が `Span` 2 本 (8 バイト) の代わりになる。** 復元用のテーブルはコンパイル時に `as_str().len()` から自動生成できる。
