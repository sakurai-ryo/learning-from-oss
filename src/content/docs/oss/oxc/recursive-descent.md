---
title: "再帰下降の骨格と cursor"
description: "oxc のパーサは文法規則 1 つにつきメソッド 1 つ、という素直な再帰下降だ。それを支える道具が cursor.rs に集まっている。cur_kind / at / eat / bump / expect という 5 つの基本操作、自動セミコロン挿入、チェックポイントと巻き戻しによる先読み、そしてリストを読むための 3 種類のヘルパ。ヘルパの中に fatal error のチェックが埋め込まれているのが、エラー回復と噛み合う要になっている。"
group: "木を作る — Parser"
sidebar:
  order: 20
---

## 何を学んだか

`crates/oxc_parser/src/` の構造は、文法の構造をそのまま反映している。

```
js/         — JS の文法 (expression.rs / statement.rs / declaration.rs ...)
ts/         — TypeScript の文法
jsx/        — JSX の文法
cursor.rs   — トークンを進める操作
context.rs  — 文脈フラグ
state.rs    — 一時的な状態
error_handler.rs — エラー回復
```

`cursor.rs` が「文法を書くための語彙」を提供している。中心は 5 つになる。

```rust title="crates/oxc_parser/src/cursor.rs"
    /// Checks if the current index has token `Kind`
    #[inline]
    pub(crate) fn at(&self, kind: Kind) -> bool {
        self.cur_kind() == kind
    }
```

```rust title="crates/oxc_parser/src/cursor.rs"
    /// Advance and return true if we are at `Kind`, return false otherwise
    #[inline]
    #[must_use = "Use `bump` instead of `eat` if you are ignoring the return value"]
    pub(crate) fn eat(&mut self, kind: Kind) -> bool {
        if self.at(kind) {
            self.advance(kind);
            return true;
        }
        false
    }

    /// Advance if we are at `Kind`
    #[inline]
    pub(crate) fn bump(&mut self, kind: Kind) {
        if self.at(kind) {
            self.advance(kind);
        }
    }
```

```rust title="crates/oxc_parser/src/cursor.rs"
    /// Expect a `Kind` or return error
    #[inline]
    pub(crate) fn expect(&mut self, kind: Kind) {
        if !self.at(kind) {
            self.handle_expect_failure(kind);
        }
        self.advance(kind);
    }
```

- **`at`** — 現在のトークンが `kind` か
- **`eat`** — `kind` なら進んで `true`、そうでなければ `false`
- **`bump`** — `kind` なら進む (戻り値なし)
- **`expect`** — `kind` でなければエラーにして進む
- **`advance`** — 無条件に進む

`eat` に `#[must_use]` が付いていて、しかもメッセージが**代わりに使うべき関数を指している**。「戻り値を無視するなら `bump` を使え」。

## なぜそうなっているか

### `eat` と `bump` を分ける理由

どちらも「その kind なら進む」で、違うのは戻り値だけだ。1 つにまとめて `let _ = eat(...)` と書けばいい、とも思える。

しかし `#[must_use]` を付けたい。戻り値を見るべき場面 (`if self.eat(Kind::Comma) { ... }`) で見落とすと、静かにパースが壊れる。かといって `let _ =` を書かせると `#[must_use]` の意味がなくなる。

**「戻り値を使わない」を別の関数名にすることで、意図が呼び出し側に現れる。** `bump(Kind::Semicolon)` と書いてあれば「セミコロンがあってもなくてもよい」と読める。

### ASI が 3 行

JS の自動セミコロン挿入 (ASI) は仕様上は複雑だが、パーサの実装ではこうなる。

```rust title="crates/oxc_parser/src/cursor.rs"
    /// [Automatic Semicolon Insertion](https://tc39.es/ecma262/#sec-automatic-semicolon-insertion)
    pub(crate) fn asi(&mut self) {
        if self.eat(Kind::Semicolon) || self.can_insert_semicolon() {
            /* no op */
        } else {
            // ASI failure is a syntax error (cold). Build the diagnostic out of line so the
            // ~232-byte `OxcDiagnostic` buffer does not inflate `asi`'s stack frame on the
            // common (valid) path.
            cold_branch(|| {
                let span = Span::empty(self.prev_token_end);
                let error = diagnostics::auto_semicolon_insertion(span);
                self.set_fatal_error(error);
            });
        }
    }

    #[inline]
    pub(crate) fn can_insert_semicolon(&self) -> bool {
        let token = self.cur_token();
        matches!(token.kind(), Kind::Semicolon | Kind::RCurly | Kind::Eof) || token.is_on_new_line()
    }
```

「`;` があるか、`}` / EOF の直前か、改行があったか」。改行の有無は [`Token` の `is_on_new_line` フラグ](./on-demand-tokens/)で持っている。

エラー生成が `cold_branch` に包まれている理由まで書いてある — **`OxcDiagnostic` の 232 バイトが `asi` のスタックフレームに乗らないようにするため。** `asi` は全ての文の末尾で呼ばれるホットパスになる。

同じ形が `expect` の失敗経路にもある。

```rust title="crates/oxc_parser/src/cursor.rs"
    /// Cold path for expect failures - separated to improve branch prediction
    #[cold]
    #[inline(never)]
    fn handle_expect_failure(&mut self, expected_kind: Kind) {
        let range = self.cur_token().span();
        let error =
            diagnostics::expect_token(expected_kind.to_str(), self.cur_kind().to_str(), range);
        self.set_fatal_error(error);
    }
```

### チェックポイントと巻き戻し

[トークン列を持たない](./on-demand-tokens/)ので、先読みは「今の状態を保存して読み進め、戻す」でやる。

```rust title="crates/oxc_parser/src/cursor.rs"
#[derive(Clone)]
pub struct ParserCheckpoint<'a> {
    lexer: LexerCheckpoint<'a>,
    cur_token: Token,
    prev_span_end: u32,
    errors_pos: usize,
    fatal_error: Option<FatalError<'a>>,
}
```

```rust title="crates/oxc_parser/src/cursor.rs"
    pub(crate) fn checkpoint(&mut self) -> ParserCheckpoint<'a> {
        ParserCheckpoint {
            lexer: self.lexer.checkpoint(),
            cur_token: self.token,
            prev_span_end: self.prev_token_end,
            errors_pos: self.errors.len(),
            fatal_error: self.fatal_error.take(),
        }
    }

    pub(crate) fn rewind(&mut self, checkpoint: ParserCheckpoint<'a>) {
        let ParserCheckpoint { lexer, cur_token, prev_span_end, errors_pos, fatal_error } =
            checkpoint;

        self.lexer.rewind(lexer);
        self.token = cur_token;
        self.prev_token_end = prev_span_end;
        self.errors.truncate(errors_pos);
        self.fatal_error = fatal_error;
    }
```

**保存されるのは 5 つだけ。** レキサの位置、現在トークン、前トークンの終端、エラーリストの長さ、fatal error の有無。

`errors_pos` を保存して `rewind` で `truncate` するのが要点になる。**試しにパースしてみて失敗したら、その間に出たエラーも捨てる。** そうしないと「アロー関数として読もうとして失敗した」というエラーが、括弧式として正しくパースできた後も残ってしまう。

`checkpoint()` が `&mut self` を取り、`fatal_error.take()` するのも同じ理由になる。**試行の前に fatal error をクリアしておき、rewind で戻す。**

`lookahead` はこの 2 つを組み合わせただけになる。

```rust title="crates/oxc_parser/src/cursor.rs"
    pub(crate) fn lookahead<U>(&mut self, predicate: impl Fn(&mut ParserImpl<'a, C>) -> U) -> U {
        let checkpoint = self.checkpoint();
        let answer = predicate(self);
        self.rewind(checkpoint);
        answer
    }
```

**`predicate` の結果だけを取り、状態は必ず戻す。** 「`(` の後ろを読んでみて、`=>` があればアロー関数」のような判定に使う。

### リストを読む 3 つのヘルパ

JS の文法には「区切り文字で区切られた並び」が大量に出てくる。引数リスト、配列リテラル、オブジェクトのプロパティ、文のリスト。

```rust title="crates/oxc_parser/src/cursor.rs"
    pub(crate) fn parse_normal_list<F, T>(
        &mut self,
        open: Kind,
        close: Kind,
        f: F,
    ) -> ArenaVec<'a, T>
    where
        F: FnMut(&mut Self) -> T,
    {
        let opening_span = self.cur_token().span();
        self.expect(open);
        let mut list = ArenaVec::new_in(self);
        self.parse_normal_list_into(&mut list, close, f);
        self.expect_closing(close, opening_span);
        list
    }
```

3 種類ある。

| ヘルパ                        | 用途                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `parse_normal_list`           | 区切り文字なし (文のリスト、クラスのメンバ)             |
| `parse_normal_list_breakable` | 同上だが、要素のパースが `None` を返したら終わる        |
| `parse_delimited_list`        | 区切り文字あり (引数、配列要素)。末尾カンマの位置も返す |

`expect_closing(close, opening_span)` に**開き括弧の span を渡している**のが細かい。閉じ括弧がないときの診断で「ここで開いた括弧が閉じていない」と示せる。

### ループの終了条件に fatal error が入っている

ヘルパの本体を見ると、終了条件が 3 つある。

```rust title="crates/oxc_parser/src/cursor.rs"
    fn parse_normal_list_into<F, T>(
        &mut self,
        list: &mut ArenaVec<'a, T>,
        close: Kind,
        mut parse_element: F,
    ) where
        F: FnMut(&mut Self) -> T,
    {
        loop {
            let kind = self.cur_kind();
            if kind == close
                || matches!(kind, Kind::Eof | Kind::Undetermined)
                || self.fatal_error.is_some()
            {
                break;
            }
            let element = parse_element(self);
            list.push(element);
        }
    }
```

1. 閉じトークンに到達
2. EOF または不定トークン
3. **fatal error が発生している**

3 番目が[エラー回復](./error-recovery/)の要になる。要素のパース中に致命的エラーが起きたら、リストのループが止まる。**`Result` を返して `?` で伝播させる代わりに、状態フラグを見てループを抜ける。**

`parse_normal_list_breakable` のほうは `has_fatal_error()` を使う。

```rust title="crates/oxc_parser/src/cursor.rs"
        loop {
            if self.at(close) || self.has_fatal_error() {
                break;
            }
            if let Some(element) = parse_element(self) {
                list.push(element);
            } else {
                break;
            }
        }
```

```rust title="crates/oxc_parser/src/error_handler.rs"
    pub(crate) fn has_fatal_error(&self) -> bool {
        matches!(self.cur_kind(), Kind::Eof | Kind::Undetermined) || self.fatal_error.is_some()
    }
```

`fatal_error` を立てると[レキサが EOF まで飛ぶ](./error-recovery/)ので、`cur_kind() == Eof` も同じ条件になる。

### `Context` の出し入れがクロージャ

文脈フラグ ([Context フラグ](./context-flags/)) の変更は、必ずクロージャで囲う。

```rust title="crates/oxc_parser/src/cursor.rs"
    #[inline(always)] // inline because this is always on a hot path
    pub(crate) fn context_add<F, T>(&mut self, add_flags: Context, cb: F) -> T
    where
        F: FnOnce(&mut Self) -> T,
    {
        let ctx = self.ctx;
        self.ctx = ctx.union(add_flags);
        let result = cb(self);
        self.ctx = ctx;
        result
    }
```

**保存 → 変更 → 実行 → 復元。** 復元を忘れるバグが構造的に起きない。`#[inline(always)]` なので、クロージャのオーバーヘッドは消える。

### ソースの上限

```rust title="crates/oxc_parser/src/lib.rs"
/// Maximum length of source which can be parsed (in bytes).
/// ~4 GiB on 64-bit systems, ~2 GiB on 32-bit systems.
// Length is constrained by 2 factors:
// 1. `Span`'s `start` and `end` are `u32`s, which limits length to `u32::MAX` bytes.
// 2. Rust's allocator APIs limit allocations to `isize::MAX`.
pub(crate) const MAX_LEN: usize = if size_of::<usize>() >= 8 {
    // 64-bit systems
    u32::MAX as usize
} else {
    // 32-bit or 16-bit systems
    isize::MAX as usize
};
```

[`Span` が `u32` である](./ast-memory-layout/)ことが、パーサの API 契約として表に出ている箇所になる。上限を超えたら専用のエラーになり、他のエラーは全部捨てられる。

```rust title="crates/oxc_parser/src/lib.rs"
        if let Some(overlong_error) = self.overlong_error() {
            panicked = true;
            self.lexer.errors.clear();
            self.errors.clear();
            self.error(overlong_error);
        }
```

**「ファイルが大きすぎる」以外のエラーを見せても意味がない**ので、全部消して 1 件だけにする。

## ソースコードのどこか

- [`crates/oxc_parser/src/cursor.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/cursor.rs) — トークン操作とリストヘルパ
- [`crates/oxc_parser/src/lib.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/lib.rs) — `Parser` / `ParserImpl` / `ParserReturn`
- [`crates/oxc_parser/src/js/`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/js/) — JS の文法規則
- [`crates/oxc_parser/src/state.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_parser/src/state.rs) — `ParserState` (45 行)

`ParserState` が小さいことに注目したい。

```rust title="crates/oxc_parser/src/state.rs"
pub struct ParserState<'a> {
    pub not_parenthesized_arrow: FxHashSet<u32>,

    /// Temporary storage for `CoverInitializedName` `({ foo = bar })`.
    /// Keyed by `ObjectProperty`'s span.start.
    pub cover_initialized_name: FxHashMap<u32, AssignmentExpression<'a>>,

    /// Trailing comma spans for `ArrayExpression` and `ObjectExpression` ending in a spread.
    pub trailing_commas: FxHashMap<u32, Span>,

    /// Statements that may need reparsing when `sourceType` is `unambiguous`.
    pub potential_await_reparse: Vec<(usize, ParserCheckpoint<'a>)>,

    pub encountered_await_identifier: bool,
}
```

**5 フィールドしかない。** [`Context`](./context-flags/) が「文法の文脈」を持ち、`ParserState` は「特定の構文のために一時的に覚えておくもの」だけを持つ。役割が明確に分かれている。

しかも全部が**「カバーグラマー」の後始末**か**「後から判明する情報」のため**になっている。`cover_initialized_name` は `({ foo = bar })` を分割代入として読み直すときに使い ([式のパースと優先順位](./expression-precedence/))、`potential_await_reparse` は `sourceType: unambiguous` で `await` を読み直すために[チェックポイントごと保存している](./error-recovery/)。

## どう活かすか

**基本操作の語彙を 5 つ程度に絞ると、文法規則が読みやすくなる。** `at` / `eat` / `bump` / `expect` / `advance`。パーサに限らず、ステートマシンやプロトコル実装でも同じ形が使える。**語彙が多すぎると、どれを使うべきか迷う。**

**「戻り値を使わない版」を別の名前にする。** `eat` に `#[must_use]` を付けたうえで `bump` を用意すると、呼び出し側のコードが意図を表す。`let _ = eat(...)` が並ぶコードより読みやすい。

**巻き戻しでは、副作用も一緒に巻き戻す。** `ParserCheckpoint` が `errors.len()` を保存して `rewind` で `truncate` するのが好例。試行中に出たエラーを消さないと、成功した後も残る。**「状態を戻す」の範囲に、蓄積されたデータも含める。**

**ループの終了条件にエラー状態を入れる。** `Result` と `?` で伝播させるのが Rust の定型だが、エラー回復をするパーサでは「エラーが出ても続ける」場面がある。**状態フラグを見てループを抜ける**形にすると、伝播とその場での回復を両立できる。

**スコープ付きの状態変更はクロージャで囲う。** `context_add(flags, |p| { ... })` は保存と復元がセットになるので、復元忘れが起きない。`#[inline(always)]` を付ければ実行時コストはない。

**ホットパスからエラー生成を追い出す。** `cold_branch(|| ...)` で包むと、`OxcDiagnostic` の 232 バイトが正常系のスタックフレームから消える。**サイズを測って理由をコメントに書いてある**ので、後から検証できる。
