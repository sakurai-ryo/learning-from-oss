---
title: "キーワード照合をコンパイル時のトライに展開し、字句解析はバイト列を借りるだけにする"
description: "字句解析器は入力のバイト列を借りるだけで、トークンは範囲を指すスライスになる。文字列や識別子の終端探索は memchr に任せ、見つからない経路には cold 属性を付ける。そして 150 個近いキーワードの照合は、手続きマクロがコンパイル時にトライへ展開する。大文字と小文字が同じ分岐にまとまるので、大文字化のためのメモリ確保も要らない。逆向きの経路 — AST から SQL テキストへの書き戻し — も同じキーワード表を使っている。"
sidebar:
  order: 19
---

## 何を学んだか

パーサの前段には字句解析器がいる。役割は「バイト列をトークンの列にする」ことで、SQL では **これが一番回数の多い処理**になる。

Turso の字句解析器は 1,594 行と小さい。設計の要点は 3 つある。

- **何も所有しない。** トークンは入力への参照
- **探索は `memchr` に任せる。** 文字列の終端やコメントの終端
- **キーワードの照合は、コンパイル時のトライになる**

3 つ目が特に効いていて、150 個近いキーワードを **1 バイトずつ分岐する `match` の入れ子**に展開している。

## ソースコードのどこか

### 何も所有しない

```rust title="sqlite/parser/src/lexer.rs"
pub struct Token<'a> {
    pub value: &'a [u8],
    pub token_type: TokenType, // None means Token is whitespaces or comments
}
```

```rust title="sqlite/parser/src/lexer.rs"
pub struct Lexer<'a> {
    pub(crate) offset: usize,
    pub(crate) input: &'a [u8],
}
```

[`sqlite/parser/src/lexer.rs#L185-L215`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/lexer.rs#L185-L215)。

**字句解析器の状態は、入力への参照と整数 1 つだけ。** トークンは入力の部分列を指す。

だから **トークンを 1 個作るのにメモリ確保が起きない。** `SELECT * FROM t WHERE x = 1` を解析しても、ヒープは 1 バイトも動かない。

これが [`mark` による巻き戻し](../recursive-descent/) を安くしている。**状態が整数 1 つなら、保存も復元も代入 1 回で済む。**

字句解析器も `Iterator` になっている。

```rust title="sqlite/parser/src/lexer.rs"
impl<'a> Iterator for Lexer<'a> {
    type Item = Result<Token<'a>>;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        match self.peek() {
            None => None, // End of file
            Some(b) if b.is_ascii_whitespace() => Some(Ok(self.eat_white_space())),
            // matching logic
            Some(b) => match b {
                b'-' => Some(Ok(self.eat_minus_or_comment_or_ptr())),
                b'(' => Some(Ok(self.eat_one_token(TokenType::TK_LP))),
                b')' => Some(Ok(self.eat_one_token(TokenType::TK_RP))),
```

[`sqlite/parser/src/lexer.rs#L217-L236`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/lexer.rs#L217-L236)。

**最初のバイトで分岐する。** 関数名が `eat_minus_or_comment_or_ptr` のように **「この 1 バイトから始まりうるトークン全部」**になっているのが読みやすい。`-` は減算かもしれないし `--` のコメントかもしれないし `->` の JSON 演算子かもしれない。

### 空白とコメントも、トークンとして返る

```rust title="sqlite/parser/src/lexer.rs"
        Token::new(&self.input[start..self.offset], TokenType::TK_NONE)
```

[`sqlite/parser/src/lexer.rs#L490`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/lexer.rs#L490)。

**空白もコメントも `TK_NONE` というトークンとして返る。** 捨てられない。

読み飛ばすのはパーサ側の仕事で、`consume_lexer_without_whitespaces_or_comments` という長い名前の関数がそれをやる。

なぜ捨てないのか。**コメントを保存する必要があるから**だ。

```rust title="sqlite/parser/src/parser.rs"
    fn check_constraint_comments_survive_formatting() {
        for (sql, comment) in [
            (
                "CREATE TABLE t (x CHECK(x /* column comment */ > 0))",
                "/* column comment */",
            ),
            ...
            let command = Parser::new(sql.as_bytes()).next().unwrap().unwrap();
            let formatted = command.to_string();

            assert!(formatted.contains(comment), "formatted SQL: {formatted}");
            Parser::new(formatted.as_bytes()).next().unwrap().unwrap();
```

[`sqlite/parser/src/parser.rs#L5448-L5466`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L5448-L5466)。

**`CHECK` 制約の中のコメントが、`sqlite_schema` に保存される DDL に残らなければならない。** SQLite がそうしているからで、[互換性の要請](../sqlite-compat/) になる。

このテストが **パース → 整形 → コメントが残る → 再パースできる**まで確かめているのがいい。「残る」だけでなく「残した結果がまた読める」ことまで見ている。

**字句解析器が情報を捨てると、後段では復元できない。** 捨てる判断は、捨てても困らないと分かっている層でやる。

### 終端の探索は `memchr` に任せる

```rust title="sqlite/parser/src/lexer.rs"
    #[inline]
    // Eats up to but not including the specified byte, returns true if found
    fn eat_until(&mut self, byte: u8) -> bool {
        match memchr::memchr(byte, self.remaining()) {
            Some(pos) => {
                self.offset += pos;
                true
            }
            None => {
                cold();
                self.offset = self.input.len();
                false
            }
        }
    }
```

[`sqlite/parser/src/lexer.rs#L346-L360`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/lexer.rs#L346-L360)。

**文字列リテラルの閉じ引用符、行コメントの改行、ブロックコメントの `*`。** どれも「次にこのバイトが出るまで飛ばす」で、`memchr` は SIMD でこれをやる。

1 バイトずつ回すループを書いても動くが、**長い文字列リテラルでは差が出る。**

`cold()` の使い方が細かい。

```rust title="sqlite/parser/src/lexer.rs"
#[cold]
const fn cold() {}
```

[`sqlite/parser/src/lexer.rs#L289-L290`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/lexer.rs#L289-L290)。

**中身が空の関数に `#[cold]` を付けて、稀な分岐から呼ぶ。**

「閉じ引用符が見つからない」は構文エラーの経路で、まず通らない。呼ぶだけで、コンパイラに **「この分岐は稀だ」**と伝わる。分岐予測とコードの配置がそれに合わせて最適化される。

Rust には「この分岐は起きにくい」を直接書く安定した方法がないので、**空の `#[cold]` 関数を呼ぶのが定石**になっている。

### キーワードの照合は、コンパイル時のトライ

字句解析で識別子を読み終えたら、それがキーワードかどうかを判定する。SQL のキーワードは 150 個近くあり、しかも **大文字小文字を区別しない。**

素朴にやると、入力を大文字化して `HashMap` を引く。**大文字化のためにメモリ確保が起きる。**

Turso はマクロで解いている。

```rust title="sqlite/parser/src/lexer.rs"
fn keyword_or_id_token(input: &[u8]) -> TokenType {
    match_ignore_ascii_case!(match input {
        b"ABORT" => TokenType::TK_ABORT,
        b"ACTION" => TokenType::TK_ACTION,
        b"ADD" => TokenType::TK_ADD,
        b"AFTER" => TokenType::TK_AFTER,
        b"ALL" => TokenType::TK_ALL,
        ...
```

[`sqlite/parser/src/lexer.rs#L12-L20`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/lexer.rs#L12-L20)。

**見た目は普通の `match`。** だが `match_ignore_ascii_case!` は手続きマクロで、こう展開される。

```rust title="macros/src/lib.rs"
/// match_ignore_ascii_case will generate trie-like tree matching from normal match expression.
```

[`macros/src/lib.rs#L608`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/lib.rs#L608)。

マクロの中身はこうなっている。

```rust title="macros/src/ext/match_ignore_ascii_case.rs"
    struct PathEntry {
        result: Option<Arm>,
        sub_entries: BTreeMap<u8, Box<PathEntry>>,
    }
```

```rust title="macros/src/ext/match_ignore_ascii_case.rs"
    for (keyword_b, arm) in arms.drain(..) {
        let mut current = &mut paths;

        for b in keyword_b {
            current = current.sub_entries.entry(b).or_insert_with(|| {
```

[`macros/src/ext/match_ignore_ascii_case.rs#L75-L98`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/ext/match_ignore_ascii_case.rs)。

**まず全キーワードからトライ (接頭辞木) を作る。** そして各節点を `match` に変換する。

```rust title="macros/src/ext/match_ignore_ascii_case.rs"
        let mut arms = Vec::with_capacity(entry.sub_entries.len());
        for (&b, sub_entry) in &entry.sub_entries {
            let sub_match = write_entry(idx + 1, var_name.clone(), fallback_arm.clone(), sub_entry);
            if b.is_ascii_alphabetic() {
                let b_lower = b.to_ascii_lowercase();
                arms.push(quote! { Some(#b) | Some(#b_lower) => #sub_match });
            } else {
                arms.push(quote! { Some(#b) => #sub_match });
            }
        }

        quote! { match #var_name.get(#idx) {
            #eof_handle
            #(#arms)*
            #fallback_handle
        } }
```

[`macros/src/ext/match_ignore_ascii_case.rs#L127-L141`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/ext/match_ignore_ascii_case.rs)。

生成されるのは、こういう形の入れ子になる。

```rust
match input.get(0) {
    Some(b'A') | Some(b'a') => match input.get(1) {
        Some(b'B') | Some(b'b') => match input.get(2) {
            Some(b'O') | Some(b'o') => ... ,   // ABORT
            _ => TokenType::TK_ID,
        },
        Some(b'C') | Some(b'c') => ... ,       // ACTION
        ...
    },
    ...
}
```

得られるものが 3 つある。

1. **大文字小文字が `Some(b'A') | Some(b'a')` という 1 つの分岐にまとまる。** 正規化のためのメモリ確保が消える
2. **1 バイト目で候補がほぼ絞られる。** `ABORT` と `ZEROBLOB` は 1 回の比較で分かれる
3. **`None` の扱いが自然に入る。** `entry.result` がある節点で入力が終われば、そこが答えになる

そして **全部が `match` なので、コンパイラが分岐表 (jump table) に落とせる。**

コンパイル時に木を作っているので、**キーワードを 1 行足すだけで、トライが作り直される。** 手で書いた分岐の入れ子だったら、追加のたびに正しい位置を探すことになる。

### 逆向きの経路も、同じ表を使う

キーワードの表には、もう 1 つの用途がある。

```rust title="sqlite/parser/src/lexer.rs"
/// Returns true if the given identifier (case-insensitive) is a SQL keyword.
/// This is used to determine whether an identifier needs to be quoted when
/// rendered back to SQL text.
pub fn is_quotable_keyword(input: &[u8]) -> bool {
    let token = keyword_or_id_token(input);
    token != TokenType::TK_ID && token != TokenType::TK_TYPE
}
```

[`sqlite/parser/src/lexer.rs#L4-L10`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/lexer.rs#L4-L10)。

**AST を SQL テキストに書き戻すとき、キーワードと同じ綴りの識別子は引用符で囲まなければならない。**

```rust title="sqlite/parser/src/ast.rs"
        let value = self.value.as_bytes();
        let safe_char = |&c: &u8| c.is_ascii_alphanumeric() || c == b'_';
        if !value.is_empty() && value.iter().all(safe_char) && !is_quotable_keyword(value) {
            self.value.clone()
        } else {
            format!("\"{}\"", self.value.replace("\"", "\"\""))
        }
```

[`sqlite/parser/src/ast.rs#L1297-L1305`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/ast.rs#L1297-L1305)。

`CREATE TABLE t (key TEXT)` をパースして書き戻すとき、**`key` を裸で出すともう一度読めるかどうかが文脈依存になる。** だから `"key"` と囲む。

**読む側と書く側が、同じキーワード表を共有している。** 別々に持つと、キーワードを足したときに片方だけ更新される。そして **その不整合は「書き戻した SQL が読めない」という形で、ずっと後になって現れる。**

エンジン側も同じ関数を使っている。

```rust title="core/util.rs"
/// Quote a SQL identifier with double quotes when necessary.
/// Always safe to call — returns the bare name when no quoting is needed.
pub fn quote_identifier(name: &str) -> String {
    let needs_quoting = name.is_empty()
        || name.as_bytes()[0].is_ascii_digit()
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        || turso_parser::lexer::is_quotable_keyword(name.as_bytes());
```

[`core/util.rs#L189-L195`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/util.rs#L189-L195)。

**「必要なときだけ引用する。常に呼んで安全」** と説明されている。「引用が要るか」を呼び出し側に判断させない。

`TK_TYPE` を除外しているのが細かい。`type` は [カスタム型](../pg-type-mapping/) のために追加されたトークンだが、**引用しなくても識別子として使える**ようにしてある。**自分で足したキーワードは、既存のスキーマを壊さないように扱う。**

### UTF-8 検証を通らない

```rust title="sqlite/parser/src/parser.rs"
#[inline(always)]
fn from_bytes_as_str(bytes: &[u8]) -> &str {
    unsafe { str::from_utf8_unchecked(bytes) }
}
```

[`sqlite/parser/src/parser.rs#L93-L96`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L93-L96)。

**バイト列を `&str` に変換するとき、UTF-8 の検証をしない。**

Rust の `str::from_utf8` は入力全体を走査する。識別子や文字列リテラルのたびにこれを通すと、**入力を 2 回読むことになる。**

前提としているのは [`COMPAT.md` の制約](../sqlite-compat/) だ。Turso のテキストは UTF-8 でなければならない。SQL の入力も同じで、**呼び出し側が既に `&str` として持っている**。

一方で、エラーの経路では検証つきの変換を使っている。

```rust title="sqlite/parser/src/lexer.rs"
    pub fn to_utf8(&self) -> String {
        String::from_utf8_lossy(self.as_bytes()).to_string()
    }
```

[`sqlite/parser/src/lexer.rs#L195-L198`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/lexer.rs#L195-L198)。

**エラーメッセージに載せるトークンは `from_utf8_lossy`。** 不正なバイトが来ていても、置換文字にして落ちない。

**「速い経路では前提を信じ、エラーの経路では前提を疑う」。** エラーが起きている時点で、入力が想定どおりである保証はない。

### 性能を測る仕組みがある

```rust title="sqlite/parser/benches/parser_benchmark.rs"
#[turso_macros::codspeed_criterion_benchmark]
fn bench_parser(criterion: &mut Criterion) {
    let queries = [
        "SELECT 1",
        "SELECT * FROM users LIMIT 1",
        "SELECT first_name, count(1) FROM users GROUP BY first_name HAVING count(1) > 1 ORDER BY count(1)  LIMIT 1",
    ];
```

[`sqlite/parser/benches/parser_benchmark.rs`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/benches/parser_benchmark.rs)。

**パーサと字句解析器に、それぞれ独立したベンチマークがある。**

`Cargo.toml` を見ると、Linux と macOS では `pprof` でフレームグラフも出る。

```toml title="sqlite/parser/Cargo.toml"
[target.'cfg(not(target_family = "windows"))'.dev-dependencies]
pprof = { version = "0.14.0", features = ["criterion", "flamegraph"] }
```

[`sqlite/parser/Cargo.toml`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/Cargo.toml)。

**「ゼロコピーにした」「`memchr` を使った」「トライに展開した」という判断が、測れる形で残っている。** そして CodSpeed の連携で、**CI が性能の後退を検出する。**

最適化を入れるなら、それが効いていることを継続的に確かめる仕組みが要る。

## なぜそうなっているか

- **トークンが入力を借りるだけなのは、確保が最も頻度の高い操作になるから。** 1 クエリで数百トークンが作られる。
- **字句解析器の状態が整数 1 つなのは、巻き戻しを安くするため。** [文脈依存キーワードの判定](../context-keywords/) は、1 トークンごとに投機的な読みと巻き戻しを行う。
- **空白とコメントをトークンとして返すのは、コメントを保存する必要があるから。** `CHECK` 制約の中のコメントは、SQLite が DDL に残すので Turso も残す。
- **終端の探索を `memchr` に任せたのは、SIMD が使えるから。** 長い文字列リテラルやコメントで差が出る。
- **空の `#[cold]` 関数を呼ぶのは、Rust に分岐の確率を書く安定した方法がないから。** 呼ぶだけで意図が伝わる。
- **キーワード照合をトライに展開したのは、正規化の確保をなくすため。** 大文字小文字を 1 つの分岐にまとめれば、入力をそのまま比較できる。
- **トライをマクロで生成するのは、手で書くと保守できないから。** キーワードを 1 個足すたびに、木の正しい位置を探すことになる。
- **読む側と書く側で同じキーワード表を使うのは、不整合の発覚が遅いから。** 「書き戻した SQL が読めない」は、書き戻した時点では気付かない。
- **UTF-8 検証を省くのは、呼び出し側が既に検証済みだから。** ただしエラー経路では、その前提を疑う。
- **ベンチマークを持つのは、最適化の判断が測れる形で残っていてほしいから。** ゼロコピーもトライも、効いていることを確かめ続けなければ意味がない。

## どう活かすか

- **字句解析器は、入力を所有せず借りる。** トークンごとの確保は、そのまま解析速度に効く。そして状態が小さいほど、巻き戻しが安くなる。
- **前段の層で情報を捨てない。** 空白やコメントは、捨てても困らないと分かっている層で捨てる。捨てた情報は後段では復元できない。
- **区切りまで飛ばす処理は、既製の高速な探索に任せる。** 1 バイトずつのループは書きやすいが、長い入力で効いてくる。
- **稀な分岐には、空の `#[cold]` 関数を呼ぶ。** 意図を伝える最も軽い方法になる。
- **大量の文字列を照合するなら、コンパイル時にトライへ展開する。** 大文字小文字の正規化を分岐に畳み込めば、入力を加工せずに比較できる。
- **その展開はマクロにやらせる。** 手で書いた木は、要素を足すたびに壊れる。宣言は素直な `match` のまま保つ。
- **読む側と書く側が同じ表を共有する。** 「解析できる形」と「出力する形」がずれると、往復できなくなる。
- **往復のテストを書く。** 「パースして、書き戻して、もう一度パースできる」まで確かめる。片道だけのテストでは、書き戻し側の穴が見えない。
- **速い経路では前提を信じ、エラー経路では疑う。** エラーが起きている時点で、入力が想定どおりである保証はない。
- **性能のための判断には、ベンチマークを付ける。** 最適化は、効いていることを確かめ続けなければ、いつか誰かに消される。
