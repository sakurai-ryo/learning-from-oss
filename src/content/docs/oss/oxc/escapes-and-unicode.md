---
title: "文字列・数値・Unicode をどう読むか"
description: "文字列リテラルの大半にはエスケープが含まれない。だから oxc は「終端を探して、そのままソースのスライスを返す」を主経路にし、エスケープが見つかったときだけ cold branch に落ちてアリーナ上に組み立て直す。終端探索は 32 バイト単位の byte_search! マクロで、UTF-8 の境界を壊さないことを const で静的検証している。"
group: "文字列を読む — Lexer"
sidebar:
  order: 12
---

## 何を学んだか

文字列リテラルを読むときの素直な実装は「1 文字ずつ見てエスケープを解釈しながらバッファに積む」になる。これだと**エスケープが 1 個もない文字列でも新しいバッファを確保する。**

oxc は逆にした。

1. **終端 (`"` や `'`) を探す。** エスケープも改行も見つからなければ、**ソースのスライスをそのまま返す。** 確保が起きない
2. **`\` が見つかったら cold branch に落ちて**、アリーナ上に `ArenaStringBuilder` で組み立て直す

終端の探索は、専用のマクロと**コンパイル時に構築されるバイトマッチ表**でやる。しかもその表が「UTF-8 の文字境界を壊さない」ことが `const` で静的に検証されている。

数値も同じ構造で、「速い経路」と「一般の経路」に分かれる。

## なぜそうなっているか

### `byte_search!` と `SafeByteMatchTable`

終端探索は「この 4 バイトのどれかが出るまで進む」という形になる。

```rust title="crates/oxc_parser/src/lexer/string.rs"
static DOUBLE_QUOTE_STRING_END_TABLE: SafeByteMatchTable =
    safe_byte_match_table!(|b| matches!(b, b'"' | b'\r' | b'\n' | b'\\'));

static SINGLE_QUOTE_STRING_END_TABLE: SafeByteMatchTable =
    safe_byte_match_table!(|b| matches!(b, b'\'' | b'\r' | b'\n' | b'\\'));
```

`safe_byte_match_table!` は**クロージャを受け取って、コンパイル時に 256 要素の `bool` 配列を作る。** 実行時のコストはゼロ。

```rust title="crates/oxc_parser/src/lexer/search.rs"
#[repr(C, align(64))]
pub struct SafeByteMatchTable([bool; 256]);
```

`align(64)` はキャッシュライン境界に揃えるため。テーブル全体が 256 バイト = 4 ラインで、探索中に何度も引かれる。

**`Safe` が付いているのは、UTF-8 の安全性を静的に保証しているからだ。**

```rust title="crates/oxc_parser/src/lexer/search.rs"
/// `byte_search!` using this table is guaranteed to leave `lexer.source` positioned on a UTF-8
/// character boundary, provided that its starting position is already on a UTF-8 character
/// boundary.
///
/// To make this guarantee, one of the following must be true:
///
/// 1. Table contains `true` for all byte values 192 - 247
///    i.e. first byte of any multi-byte Unicode character matches.
///    (NB: 248 - 255 cannot occur in UTF-8 strings)
///
/// 2. Table contains `false` for all byte values 128 - 191
///    i.e. the continuation bytes of any multi-byte Unicode chars will be consumed in full.
///
/// This is statically checked by `SafeByteMatchTable::new`, and will fail to compile if match
/// pattern does not satisfy one of the above.
```

バイト単位で探索すると、マルチバイト文字の**途中で止まる**危険がある。それを避ける条件は 2 つのどちらかで、

1. マルチバイト文字の**先頭バイト (192-247) を全部マッチさせる** → 文字の先頭で止まる
2. **継続バイト (128-191) を全部マッチさせない** → 文字を丸ごと通り過ぎる

`safe_byte_match_table!` の `const fn new` がこれを検査し、**どちらも満たさない表はコンパイルが通らない。**

`DOUBLE_QUOTE_STRING_END_TABLE` は ASCII の 4 バイトしかマッチしないので、条件 2 を満たす。

**「バイト単位の探索が UTF-8 を壊す」という古典的なバグのクラスを、型とコンパイル時検査で消している。**

### 主経路にエスケープの処理が出てこない

```rust title="crates/oxc_parser/src/lexer/string.rs"
        // Consume bytes which are part of string
        let next_byte = byte_search! {
            lexer: $lexer,
            table: $table,
            start: after_opening_quote,
            handle_eof: {
                // Unterminated string is invalid JS, so a cold path. Building the diagnostic
                // out-of-line keeps the `OxcDiagnostic` return buffer out of this handler's
                // stack frame (matching the sibling `\\` and line-break arms below).
                return cold_branch(|| {
                    $lexer.error(diagnostics::unterminated_string($lexer.unterminated_range()));
                    Kind::Undetermined
                });
            },
        };

        // Found a matching byte.
        // Either end of string found, or a line break, or `\` escape.
        match next_byte {
            $delimiter => {
                // SAFETY: Macro user guarantees delimiter is ASCII, so consuming it cannot move
                // `lexer.source` off a UTF-8 character boundary.
                $lexer.source.next_byte_unchecked();
                Kind::Str
            }
            b'\\' => cold_branch(|| {
                handle_string_literal_escape!(
                    $lexer,
                    $delimiter,
                    $escaped_table,
                    after_opening_quote
                    // ...
```

**エスケープなしの経路は 3 行で終わる。** 終端バイトを消費して `Kind::Str` を返すだけ。文字列の中身は `Token` の span が指しているので、後から `&source_text[span]` で取れる。

エスケープがあると `cold_branch` に落ちる。

```rust title="crates/oxc_parser/src/lexer/string.rs"
const MIN_ESCAPED_STR_LEN: usize = 16;
```

エスケープを含む文字列を組み立てるときの初期容量。**エスケープを含む文字列だけがアリーナに「cook」される**ので、その分だけメモリを使う。

`cold_branch` を使う理由がコメントに書かれている。

```rust title="crates/oxc_parser/src/lexer/string.rs"
                // Unterminated string is invalid JS, so a cold path. Building the diagnostic
                // out-of-line keeps the `OxcDiagnostic` return buffer out of this handler's
                // stack frame (matching the sibling `\\` and line-break arms below).
```

**[`OxcDiagnostic`](./diagnostics/) の構築をこの関数のスタックフレームから追い出す。** クロージャに包んで別関数にすることで、正常系のスタックが太らない。

### lossy replacement character の扱い

テーブルが 2 種類ずつあるのが目を引く。

```rust title="crates/oxc_parser/src/lexer/string.rs"
/// Lossy replacement character (U+FFFD) as UTF-8 bytes.
const LOSSY_REPLACEMENT_CHAR_BYTES: [u8; 3] = to_bytes('\u{FFFD}');
const LOSSY_REPLACEMENT_CHAR_FIRST_BYTE: u8 = LOSSY_REPLACEMENT_CHAR_BYTES[0];
const _: () = assert!(LOSSY_REPLACEMENT_CHAR_FIRST_BYTE == 0xEF);

// Same as above, but with 1st byte of lossy replacement character added
static DOUBLE_QUOTE_ESCAPED_MATCH_TABLE: SafeByteMatchTable = safe_byte_match_table!(|b| matches!(
    b,
    b'"' | b'\r' | b'\n' | b'\\' | LOSSY_REPLACEMENT_CHAR_FIRST_BYTE
));
```

JS の文字列は UTF-16 なので、**単独のサロゲート (lone surrogate) を含みうる。** `"\uD800"` は有効な JS だが、Rust の `str` (UTF-8) では表現できない。

oxc はこれを U+FFFD (置換文字) にして、`Token` の `lone_surrogates` フラグを立てる ([Token のビットレイアウト](./on-demand-tokens/))。エスケープ処理の経路では、**元から U+FFFD が書かれていた場合と区別する**必要があるので、その先頭バイト `0xEF` もマッチ対象に加える。

`const fn to_bytes` で UTF-8 バイト列を作り、先頭バイトが `0xEF` であることを `const` assert している。ハードコードせず、しかもコンパイル時に確定する。

### エスケープの解釈は仕様の写経

```rust title="crates/oxc_parser/src/lexer/unicode.rs"
    // EscapeSequence ::
    pub(super) fn read_string_escape_sequence(
        &mut self,
        text: &mut ArenaStringBuilder<'a>,
        in_template: bool,
        is_valid_escape_sequence: &mut bool,
    ) {
        match self.next_char() {
            None => {
                self.error(diagnostics::unterminated_string(self.unterminated_range()));
            }
            Some(c) => match c {
                // \ LineTerminatorSequence
                // LineTerminatorSequence ::
                // <LF>
                // <CR> [lookahead ≠ <LF>]
                // <LS>
                // <PS>
                // <CR> <LF>
                LF | LS | PS => {}
                CR => {
                    self.next_ascii_byte_eq(b'\n');
                }
                // SingleEscapeCharacter :: one of
                //   ' " \ b f n r t v
                '\'' | '"' | '\\' => text.push(c),
                'b' => text.push('\u{8}'),
                'f' => text.push(FF),
                'n' => text.push(LF),
                'r' => text.push(CR),
                't' => text.push(TAB),
                'v' => text.push(VT),
```

**ECMAScript の文法規則がそのままコメントになっている。** `\<改行>` が何も出力しない (行継続) こと、`\r\n` を 1 つとして扱うこと。[early error の checker](./early-errors/) と同じ作法で、仕様の断片を貼ってその下に実装を書く。

サロゲートペアの扱いには、失敗時の巻き戻しが入っている。

```rust title="crates/oxc_parser/src/lexer/unicode.rs"
        // Not a valid surrogate pair.
        // Rewind to before the 2nd, and return the first only.
        // The 2nd could be the first part of a valid pair, or a `\u{...}` escape.
        self.source.set_position(before_second);
        Some(UnicodeEscape::LoneSurrogate(high))
```

`\uD800\uD800` のようなケースで、2 つ目を「ペアの後半」として消費してしまわない。**2 つ目自体が次のペアの前半かもしれない。**

### 数値は「速い経路」と「一般の経路」

```rust title="crates/oxc_parser/src/lexer/number.rs"
//! Parsing utilities for converting Javascript numbers to Rust f64.
//! Code copied originally from
//! [jsparagus](https://github.com/mozilla-spidermonkey/jsparagus/blob/24004745a8ed4939fc0dc7332bfd1268ac52285f/crates/parser/src/numeric_value.rs)
//! but iterated on since.
```

出典が明記されている ([`Box` も jsparagus 由来](./bump-allocator/))。

分岐の軸は「区切り文字 `_` を含むか」と「進数」になる。

```rust title="crates/oxc_parser/src/lexer/number.rs"
pub fn parse_int(s: &str, kind: Kind, has_sep: bool) -> Result<f64, &'static str> {
    match kind {
        Kind::Decimal => {
            Ok(if has_sep { parse_decimal_with_underscores(s) } else { parse_decimal(s) })
        }
        Kind::Binary => {
            let s = &s[2..];
            Ok(if has_sep { parse_binary_with_underscores(s) } else { parse_binary(s) })
        }
        // ...
```

`has_sep` は [`Token` のフラグ](./on-demand-tokens/) (`has_separator`) から来る。**レキサが読みながら「`_` があった」を記録しておくので、パース側は文字列を走査し直さずに経路を選べる。**

10 進数のパースには 2 段の最適化が入っている。

```rust title="crates/oxc_parser/src/lexer/number.rs"
/// b'0' is 0x30 and b'9' is 0x39.
///
/// So we can convert from any decimal digit to its value with `b & 15`.
/// This produces more compact assembly than `b - b'0'`.
///
/// <https://godbolt.org/z/WMarz15sq>
#[inline]
const fn decimal_byte_to_value(b: u8) -> u8 {
    debug_assert!(b >= b'0' && b <= b'9');
    b & 15
}
```

`b - b'0'` ではなく `b & 15`。**Godbolt のリンクまで貼ってある**ので、主張が検証可能になっている。

```rust title="crates/oxc_parser/src/lexer/number.rs"
    /// Numeric strings longer than this have the chance to overflow u64.
    /// `u64::MAX + 1` in decimal is 18446744073709551616 (20 chars).
    const MAX_FAST_DECIMAL_LEN: usize = 19;
```

19 桁までは `u64` で計算してから `f64` に変換する。それを超えると一般の浮動小数点パースに落ちる。**JS のソースに出てくる数値のほぼ全部が 19 桁以下**なので、速い経路がほぼ常に通る。

### 通し例で見る

```ts title="example.ts"
const raw = await readFile(path, "utf8");
```

`"utf8"` の字句解析はこうなる。

1. byte handler `QOD` (`"`) が呼ばれる
2. `byte_search!` が `DOUBLE_QUOTE_STRING_END_TABLE` で終端を探す
3. `u`, `t`, `f`, `8` はどれもマッチしないので通過、`"` でマッチ
4. `"` を消費して `Kind::Str` を返す

**アロケーションはゼロ。** `Token` の span が `"utf8"` の範囲を指し、AST の `StringLiteral` はソースのスライスを持つ。

```ts
const s = "a\nb";
```

こちらは `\` でマッチするので `cold_branch` に落ち、`ArenaStringBuilder` に `a`、改行、`b` を積んでアリーナ上に文字列を作る。

## ソースコードのどこか

- [`crates/oxc_parser/src/lexer/string.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/string.rs) — 文字列リテラル (12KB)
- [`crates/oxc_parser/src/lexer/search.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/search.rs) — `byte_search!` と `SafeByteMatchTable` (16KB)
- [`crates/oxc_parser/src/lexer/unicode.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/unicode.rs) — エスケープとサロゲート (17KB)
- [`crates/oxc_parser/src/lexer/number.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/number.rs) — 数値パース (21KB)
- [`crates/oxc_parser/src/lexer/template.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/template.rs) — テンプレートリテラル (24KB)

`byte_search!` の探索はバッチ処理になっている。

```rust title="crates/oxc_parser/src/lexer/search.rs"
/// Batch size for searching
pub const SEARCH_BATCH_SIZE: usize = 32;
```

32 バイトずつ「マッチするバイトがあるか」を調べ、なければ 32 進む。境界チェックが 32 バイトに 1 回になる。SIMD 命令を直接書いているわけではないが、この形なら**コンパイラが自動ベクトル化しやすい。**

なお、[もう一つのレキサ](./the-other-lexer/) (`crates/oxc_lexer`) は同じ問題を AVX2 の intrinsics を直書きして解いている。同じリポジトリに 2 つのアプローチが並んでいる。

## どう活かすか

**「大半のケースでは加工が要らない」なら、加工しない経路を主経路にする。** 文字列のエスケープ、JSON のエスケープ、パスの正規化。`Cow` を返す設計 (借用のまま返せるなら返す) と同じ発想で、oxc は「ソースの span を持つだけ」で借用を表現している。

**バイト単位の探索は UTF-8 を壊しうる。** 「探索対象がマルチバイト文字の先頭を全部含む」か「継続バイトを全く含まない」のどちらかを満たせば安全になる。**その条件を `const fn` で検査すれば、条件を満たさない表はコンパイルできない。** 危険なパターン全体を型で消す好例になる。

**ホットな関数からエラー生成を追い出す。** `cold_branch(|| { ... })` でクロージャに包むだけで、診断構築のスタック領域が正常系から消える。[`#[cold]` 属性](./early-errors/)と同じ動機だが、こちらは式レベルで使える。

**レキサが見たことをフラグで記録して、後段に渡す。** 「`_` が含まれていた」「エスケープがあった」「単独サロゲートだった」。後段が文字列を走査し直さずに経路を選べる。[`Token` に空きビットが 24 個ある](./on-demand-tokens/)のは、この種の情報を足すためだ。

**「速い経路」の境界は数字で決めて、根拠を書く。** `MAX_FAST_DECIMAL_LEN = 19` には「`u64::MAX + 1` が 20 桁だから」という理由が付いている。`b & 15` には Godbolt のリンクがある。**マイクロ最適化ほど根拠のリンクが要る。**
