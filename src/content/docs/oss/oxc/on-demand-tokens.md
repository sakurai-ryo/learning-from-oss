---
title: "オンデマンドにトークンを 1 つずつ"
description: "oxc のパーサはトークン列を作らない。cursor.rs の 1 行、self.token = self.lexer.next_token() が唯一の駆動点で、パーサが必要としたときだけ次のトークンが生まれる。Token 自体も構造体ではなく u128 1 本にビットパックされている。そして JS の文法には「読み直し」が要る場面があり、re_lex_* という 4 つの再字句化関数がそれを担う。"
group: "文字列を読む — Lexer"
sidebar:
  order: 11
---

## 何を学んだか

教科書的なコンパイラは「字句解析 → トークン列 → 構文解析」の 2 パスになる。oxc はそうしない。

```rust title="crates/oxc_parser/src/cursor.rs"
    /// Move to the next token
    /// Checks if the current token is escaped if it is a keyword
    #[inline]
    pub(crate) fn advance(&mut self, kind: Kind) {
        // Manually inlined escaped keyword check - escaped identifiers are extremely rare
        if self.token.escaped() && kind.is_any_keyword() {
            self.report_escaped_keyword(self.token.span());
        }
        self.prev_token_end = self.token.end();
        self.token = self.lexer.next_token();
    }
```

**`self.token = self.lexer.next_token()` が唯一の駆動点になる。** パーサは 1 個の「現在のトークン」しか持たず、次に進むときだけレキサを呼ぶ。トークン列という中間データが存在しない。

`Token` の表現も特徴的で、**構造体ではなく `u128` 1 本**にビットパックされている。

```rust title="crates/oxc_parser/src/lexer/token.rs"
// Bit layout for `u128`:
// - Bits 0-31 (32 bits): `start` (`u32`)
// - Bits 32-63 (32 bits): `end` (`u32`)
// - Bits 64-71 (8 bits): `kind` (`Kind`)
// - Bits 72-79 (8 bits): `is_on_new_line` (`bool`)
// - Bits 80-87 (8 bits): `escaped` (`bool`)
// - Bits 88-95 (8 bits): `lone_surrogates` (`bool`)
// - Bits 96-103 (8 bits): `has_separator` (`bool`)
// - Bits 104-127 (24 bits): unused
```

```rust title="crates/oxc_parser/src/lexer/token.rs"
#[derive(Clone, Copy)]
#[repr(transparent)]
pub struct Token(u128);
```

そして JS の文法上、**1 度読んだトークンを読み直す**必要がある場面がある。`re_lex_*` という 4 つの関数がそれを担う。

## なぜそうなっているか

### トークン列を作らない理由

トークン列を作ると、次のコストが乗る。

- **メモリ**: 2.92MB のソースなら数十万トークン。1 トークン 16 バイトでも数 MB
- **キャッシュ**: 書いてから読むので、書いた分がキャッシュから追い出されている
- **確保**: `Vec` の伸長

一方、作ることで得られるのは「先読みが安い」ことだ。トークン列があれば `tokens[i + 2]` で 2 個先が見られる。

JS の再帰下降パーサは、**ほとんどの場面で 1 トークン先読みだけで済む。** 先読みが要る場面 (アロー関数の判定など) は、[チェックポイントと巻き戻し](./recursive-descent/)で対応する。

だから「常に列を作る」より「必要なときだけ巻き戻す」ほうが安い、という判断になる。

ただし**トークン列が欲しい利用者もいる** (ESTree の `tokens` 出力、シンタックスハイライト)。それは `Lexer<'_, C: Config>` の型パラメータで切り替える ([byte handler](./byte-handlers/))。

```rust title="crates/oxc_parser/src/lexer/mod.rs"
    fn finish_next_inner(&mut self, kind: Kind, mode: FinishTokenMode) -> Token {
        self.token.set_kind(kind);
        self.token.set_end(self.offset());
        let token = self.token;
        if self.config.tokens() {
            match mode {
                FinishTokenMode::Push => {
                    // We allocated sufficient capacity in the `Vec` for all tokens at the start.
                    // `push_fast` is optimized for the "doesn't need to grow" case.
                    self.tokens.push_fast(token);
                }
                // ...
            }
        }
        self.trivia_builder.handle_token(token);
```

貯める場合も、**先に十分な容量を確保しておく**ので伸長しない。[SemanticBuilder が `Stats` で先に reserve する](./semantic-builder/)のと同じ発想になる。

### なぜ `u128` なのか

フィールドを並べた構造体なら、`start: u32` + `end: u32` + `kind: Kind (u8)` + `bool` 4 本 = 13 バイト、アライメント込みで 16 バイトになる。`u128` も 16 バイトなので、サイズは同じだ。

違いは扱い方にある。

- **`Copy` が 16 バイトのレジスタ 1 本の move になる。** 構造体だとフィールドごとの読み書きになりうる
- **`Default` が `0` で表せる。**

```rust title="crates/oxc_parser/src/lexer/token.rs"
impl Default for Token {
    #[inline]
    fn default() -> Self {
        // `Kind::default()` is `Kind::Eof`. So `0` is equivalent to:
        // start: 0,
        // end: 0,
        // kind: Kind::default(),
        // is_on_new_line: false,
        // escaped: false,
        // lone_surrogates: false,
        // has_separator: false,
        const _: () = assert!(Kind::Eof as u8 == 0);
        Self(0)
    }
}
```

**`Kind::Eof` が判別子 0 であることに依存し、それを `const` assert で固定している。** `Kind` の variant を並べ替えて `Eof` が 0 でなくなったら、ビルドが止まる。

`bool` に 8 ビットずつ割いているのも意図的で、アライメントを揃えるためだ。

```rust title="crates/oxc_parser/src/lexer/token.rs"
    // Check `u32` fields are aligned on 32 and in bounds, so can be read/written via pointers
    assert!(is_valid_shift::<u32>(START_SHIFT));
    assert!(is_valid_shift::<u32>(END_SHIFT));

    // Check `Kind` is 1 byte, and `KIND_SHIFT` is aligned on 8 and in bounds, so can be read/written via pointers
    assert!(size_of::<Kind>() == 1);
    assert!(align_of::<Kind>() == 1);
    assert!(is_valid_shift::<Kind>(KIND_SHIFT));
```

各フィールドが自然なアライメント境界に置かれているので、**シフトとマスクではなくポインタ経由で直接読み書きできる。** `set_end` は「`u128` の 32 ビット目から `u32` として書く」だけになる。

24 ビットの余りは、将来フラグを足すための余地になる。

### 再字句化 — `>` は 1 個か 2 個か

JS/TS には、同じ文字列が文脈によって別のトークンになる場面がある。

**`>>` は右シフトか、ジェネリクスの閉じ 2 個か。**

```ts
const a = x >> 2; // ShiftRight
const b = new Map<string, Array<number>>(); // RAngle が 2 つ
```

レキサは文脈を知らないので、`>>` を見たら `Kind::ShiftRight` を返す。パーサが「ここはジェネリクスの終わりのはず」と判断したとき、**読み直す**。

```rust title="crates/oxc_parser/src/cursor.rs"
    pub(crate) fn re_lex_ts_r_angle(&mut self) -> bool {
        if self.fatal_error.is_some() {
            return false;
        }
        let kind = self.cur_kind();
        if kind == Kind::ShiftRight {
            self.token = self.lexer.re_lex_as_typescript_r_angle(2);
            true
        } else if kind == Kind::ShiftRight3 {
            self.token = self.lexer.re_lex_as_typescript_r_angle(3);
            true
        } else {
            kind == Kind::RAngle
        }
    }
```

`>>` なら 2 文字戻して `>` を 1 個返す。`>>>` なら 3 文字戻す。

逆向きもある。ジェネリクスの中で `>` を読んだ後、実は右シフトだった場合に読み直す。

```rust title="crates/oxc_parser/src/lexer/punctuation.rs"
    pub(crate) fn re_lex_right_angle(&mut self) -> Token {
        self.token.set_start(self.offset() - 1);
        let kind = self.read_right_angle();
        self.finish_next_retokenized(kind)
    }

    fn read_right_angle(&mut self) -> Kind {
        if self.next_ascii_byte_eq(b'>') {
            if self.next_ascii_byte_eq(b'>') {
                if self.next_ascii_byte_eq(b'=') { Kind::ShiftRight3Eq } else { Kind::ShiftRight3 }
            } else if self.next_ascii_byte_eq(b'=') {
                Kind::ShiftRightEq
            } else {
                Kind::ShiftRight
            }
        } else if self.next_ascii_byte_eq(b'=') {
            Kind::GtEq
        } else {
            Kind::RAngle
        }
    }
```

再字句化の関数は 4 つある。

| 関数                                | 用途                                               |
| ----------------------------------- | -------------------------------------------------- |
| `re_lex_right_angle`                | `>` を `>>` `>>>` `>=` として読み直す (式のパース) |
| `re_lex_ts_l_angle`                 | `<<` `<=` `<<=` を `<` 1 個として読み直す (型引数) |
| `re_lex_ts_r_angle`                 | `>>` `>>>` を `>` 1 個として読み直す (型引数)      |
| `re_lex_template_substitution_tail` | `}` をテンプレートリテラルの続きとして読み直す     |

**トークン列を持たない設計だから、これが自然にできる。** 列を作っていたら、列の途中を書き換えるか、パーサ側で「このトークンとその次を合成する」という別の仕組みが要る。**「現在位置から読み直す」がレキサの状態変更だけで済む。**

トークン列を貯める設定のときだけ、後始末が要る。

```rust title="crates/oxc_parser/src/lexer/mod.rs"
                FinishTokenMode::Replace => {
                    debug_assert!(
                        self.tokens.last().is_some_and(|last| last.start() == token.start())
                    );
                    let last = self.tokens.last_mut().unwrap();
                    *last = token;
                }
```

貯めた列の末尾を差し替える。`debug_assert!` で「差し替える相手が同じ開始位置のトークンである」ことを確かめている。

### `is_on_new_line` が ASI を支える

`Token` のフラグの 1 つ `is_on_new_line` は、**自動セミコロン挿入 (ASI)** のためにある。

```rust title="crates/oxc_parser/src/cursor.rs"
    #[inline]
    pub(crate) fn can_insert_semicolon(&self) -> bool {
        let token = self.cur_token();
        matches!(token.kind(), Kind::Semicolon | Kind::RCurly | Kind::Eof) || token.is_on_new_line()
    }
```

JS の ASI 規則は「`;` がなくても、改行があれば文の終わりとみなす」というものだ。改行そのものはトークンにならないので、**次のトークンに「前に改行があった」というフラグを立てる**ことで表現している。

これも「トークン列を持たない」設計と噛み合っている。列があれば「1 つ前のトークンの end と現在の start の間に改行があるか」を後から調べられるが、列がないならフラグで持つしかない。

### エスケープされたキーワードの検査

`advance` の先頭にある 3 行が細かい。

```rust title="crates/oxc_parser/src/cursor.rs"
        // Manually inlined escaped keyword check - escaped identifiers are extremely rare
        if self.token.escaped() && kind.is_any_keyword() {
            self.report_escaped_keyword(self.token.span());
        }
```

`if` と書くと `if` になるが、JS ではキーワードをエスケープで書くことは許されていない。この検査は**全トークンの前進で走る**ので、ホットパスになる。

`escaped` フラグを `Token` に持たせておくことで、判定が 2 回のビット演算で済む。エラー生成は別関数に切り出され `#[cold]` が付いている。

```rust title="crates/oxc_parser/src/cursor.rs"
    #[cold]
    fn report_escaped_keyword(&mut self, span: Span) {
        self.error(diagnostics::escaped_keyword(span));
    }
```

### トークンからソース文字列を取る

```rust title="crates/oxc_parser/src/cursor.rs"
    #[inline]
    pub(crate) fn token_source(&self, token: &Token) -> &'a str {
        let span = token.span();
        if cfg!(debug_assertions) {
            &self.source_text[span.start as usize..span.end as usize]
        } else {
            // SAFETY:
            // Span comes from the lexer, which ensures:
            // * `start` and `end` are in bounds of source text.
            // * `end >= start`.
            // * `start` and `end` are both on UTF-8 char boundaries.
            // * `self.source_text` is same text that `Token`s are generated from.
            //
            // TODO: I (@overlookmotel) don't think we should really be doing this.
            // We don't have static guarantees of these properties.
            unsafe { self.source_text.get_unchecked(span.start as usize..span.end as usize) }
        }
    }
```

**debug build は境界チェックあり、release build は `get_unchecked`。** しかも SAFETY コメントの最後に「本当はこれをやるべきではないと思う。静的な保証がない」という書き手の疑義が残っている。

**この種の正直な注記があるかどうかで、コードの読み方が変わる。** 「意図的に安全性を犠牲にしている」と分かれば、そこを触るときの注意の払い方が決まる。

## ソースコードのどこか

- [`crates/oxc_parser/src/cursor.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/cursor.rs) — `advance` / `re_lex_*` / `can_insert_semicolon`
- [`crates/oxc_parser/src/lexer/token.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/token.rs) — `Token` のビットレイアウト (24KB)
- [`crates/oxc_parser/src/lexer/mod.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/mod.rs) — `next_token` / `read_next_token` / `finish_next_inner`
- [`crates/oxc_parser/src/lexer/punctuation.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/punctuation.rs) — `re_lex_right_angle`
- [`crates/oxc_parser/src/lexer/typescript.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lexer/typescript.rs) — TS 用の再字句化

ベンチマーク用の複製が置かれているのが面白い。

```rust title="crates/oxc_parser/src/lexer/mod.rs"
    // This is a workaround for a problem where `next_token` is not inlined in lexer benchmark.
    // Must be kept in sync with `next_token` above, and contain exactly the same code.
    #[cfg(feature = "benchmarking")]
    #[expect(clippy::inline_always)]
    #[inline(always)]
    pub fn next_token_for_benchmarks(&mut self) -> Token {
        let kind = self.read_next_token();
        self.finish_next(kind)
    }
```

**ベンチマークから呼ぶとインライン展開されないので、`#[inline(always)]` を付けた複製を用意した。** 「本体と同期させること」というコメント付きの意図的な重複になる。

## どう活かすか

**中間データ構造を作るかどうかは、後段の使い方で決める。** 「パーサは 1 トークン先読みで足りる」と分かっていれば、トークン列は要らない。逆に「何度もランダムアクセスする」なら作るべきだ。**「作るのが普通」という慣習ではなく、実際のアクセスパターンで決める。**

**小さな値型はビットパックできる。** `Token` は `u128` 1 本で、`Copy` がレジスタ move になる。ただしアクセサを間違えると全部壊れるので、**シフト量とマスクを `const` assert で検証する**のが条件になる。oxc は「各フィールドが自然なアライメントに乗っている」ことまで assert していて、そのおかげでポインタ経由の読み書きができる。

**「後から読み直す」は、状態を持たない設計だと安くなる。** トークン列を作らないので、再字句化は「レキサの位置を戻して読み直す」だけで済む。列を持っていたら列の書き換えが要る。**「まだ確定していない情報を先に固めない」**という一般則の一例になる。

**改行のような「トークンにならないが意味を持つもの」は、次のトークンのフラグにする。** ASI、インデント、コメントの位置。トークン間の空白を全部保持するより、必要な性質だけをフラグで持つほうが安い。

**debug build と release build で安全性のレベルを変えるなら、SAFETY コメントに疑義も書く。** oxc の `token_source` には「本当はやるべきでないと思う」と残っている。それが読み手への最大の警告になる。
