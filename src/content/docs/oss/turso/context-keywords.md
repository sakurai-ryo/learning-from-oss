---
title: "同じ単語が、文脈によってキーワードにも識別子にもなる"
description: "SQL では ROW も KEY も FIRST も、テーブル名や列名として使える。SQLite は lemon の %fallback でこれを扱うが、それでは足りないケースが 10 個ある。SELECT sum(x) OVER ... の OVER が、ウィンドウ関数の キーワードなのか結果列の別名なのかは、前後のトークンを見ないと決まらない。Turso はその判定を、投機的に字句解析して巻き戻す形で手書きしている。パーサジェネレータをやめた理由が、ここに集約されている。"
group: "SQL のパース"
sidebar:
  order: 39
---

## 何を学んだか

SQL の予約語は、思ったより予約されていない。

```sql
CREATE TABLE key (row TEXT, first INTEGER, "match" TEXT);
SELECT row FROM key ORDER BY first;
```

**`KEY` も `ROW` も `FIRST` も `MATCH` も、識別子として使える。** 引用符すら要らない。

これは SQLite の親切さではなく、**互換性の要請**だ。新しいキーワードを足すたびに既存のデータベースが壊れては困る。

SQLite は lemon の `%fallback` という機能でこれを扱う。「このトークンは、文法上ここで使えなければ識別子として扱え」と宣言する。

Turso も同じ一覧を持っている。

```rust title="sqlite/parser/src/token.rs"
    /// if your parsing process expects next token to be TK_ID, remember to call this function !!!
    #[inline(always)]
    pub fn fallback_id_if_ok(self) -> Self {
        use TokenType::*;
        match self {
            TK_ABORT | TK_ACTION | TK_AFTER | TK_ANALYZE | TK_ASC | TK_ATTACH | TK_BEFORE
            | TK_BEGIN | TK_BY | TK_CASCADE | TK_CAST | TK_CONFLICT | TK_DATABASE | TK_DEFERRED
            ...
            | TK_MATERIALIZED | TK_REINDEX | TK_RENAME | TK_CTIME_KW | TK_IF | TK_OPTIMIZE
            | TK_TYPE => TK_ID,
            // | TK_COLUMNKW | TK_UNION | TK_EXCEPT | TK_INTERSECT | TK_GENERATED | TK_WITHOUT
            // see comments in `next_token` of parser
            _ => self,
        }
    }
```

[`sqlite/parser/src/token.rs#L573-L594`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/token.rs#L573-L594)。

**60 個以上のキーワードが、識別子に降格しうる。**

そして注目すべきは **コメントアウトされた行**だ。`COLUMN`、`UNION`、`EXCEPT`、`INTERSECT`、`GENERATED`、`WITHOUT`。**これらは単純な降格では扱えない**ので、パーサ側に追い出されている。

**このページの主題は、その追い出された分になる。** そしてそれが、[パーサジェネレータをやめた理由](../recursive-descent/) そのものでもある。

## ソースコードのどこか

### 単純な降格では扱えない理由

SQLite の原文がそのまま引用されている。

```rust title="sqlite/parser/src/parser.rs"
            /*
             ** The following three functions are called immediately after the tokenizer
             ** reads the keywords WINDOW, OVER and FILTER, respectively, to determine
             ** whether the token should be treated as a keyword or an SQL identifier.
             ** This cannot be handled by the usual lemon %fallback method, due to
             ** the ambiguity in some constructions. e.g.
             **
             **   SELECT sum(x) OVER ...
             **
             ** In the above, "OVER" might be a keyword, or it might be an alias for the
             ** sum(x) expression. If a "%fallback ID OVER" directive were added to
             ** grammar, then SQLite would always treat "OVER" as an alias, making it
             ** impossible to call a window-function without a FILTER clause.
             */
```

[`sqlite/parser/src/parser.rs#L398-L411`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L398-L411)。

**`SELECT sum(x) OVER ...` の `OVER` は、ウィンドウ関数のキーワードかもしれないし、`sum(x)` の別名かもしれない。**

```sql
SELECT sum(x) OVER (PARTITION BY y) FROM t;  -- キーワード
SELECT sum(x) OVER FROM t;                   -- 別名 (列名が "OVER")
```

`%fallback` を宣言すると、**LALR パーサは常に別名として解釈する。** そうするとウィンドウ関数が書けなくなる。

**文法だけでは決まらない。** 先を見なければならない。

### 判定規則が 10 個、条件つきで並ぶ

SQLite の原文が、全部の規則を列挙している。

```rust title="sqlite/parser/src/parser.rs"
             ** WINDOW is treated as a keyword if:
             **
             **   * the following token is an identifier, or a keyword that can fallback
             **     to being an identifier, and
             **   * the token after than one is TK_AS.
             **
             ** OVER is a keyword if:
             **
             **   * the previous token was TK_RP, and
             **   * the next token is either TK_LP or an identifier.
             **
             ** FILTER is a keyword if:
             **
             **   * the previous token was TK_RP, and
             **   * the next token is TK_LP.
             **
             ** UNION is a keyword if:
             **
             **   * the next token is TK_ALL|TK_SELECT|TK_VALUES.
             ...
             ** COLUMNKW is a keyword if:
             **
             **   * the previous token is TK_ADD|TK_RENAME|TK_DROP.
             **
             ** GENERATED is a keyword if:
             **
             **   * the next token is TK_ALWAYS.
             **   * the token after than one is TK_AS.
             **
             ** WITHOUT is a keyword if:
             **
             **   * the previous token is TK_RP|TK_COMMA.
             **   * the next token is TK_ID.
             */
```

[`sqlite/parser/src/parser.rs#L412-L452`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L412-L452)。

必要な情報の量が、規則ごとに違う。

| 単語                             | 前を見る   | 後ろを見る     |
| -------------------------------- | ---------- | -------------- |
| `COLUMN`                         | 1 トークン | —              |
| `UNION` / `EXCEPT` / `INTERSECT` | —          | 1 トークン     |
| `OVER` / `FILTER`                | 1 トークン | 1 トークン     |
| `WITHOUT`                        | 1 トークン | 1 トークン     |
| `WINDOW`                         | —          | **2 トークン** |
| `GENERATED`                      | —          | **2 トークン** |

**前を 1 つ、後ろを 2 つ。** LALR(1) の枠には収まらない。

そして Turso は、SQLite にない規則を 1 つ足している。

```rust title="sqlite/parser/src/parser.rs"
                TK_WITHIN => {
                    // WITHIN is a keyword only in `<aggregate>(...) WITHIN GROUP (...)`:
                    // the previous token must be `)` and the next token must be GROUP.
```

[`sqlite/parser/src/parser.rs#L522-L525`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L522-L525)。

**`WITHIN GROUP` (順序付き集合集約) を足すときに、同じ問題に当たった。** 先行実装のコメントを引き継いだうえで、同じ形式で自分の規則を追加している。

**規則の書き方を揃えておくと、後から足すときにどう書けばいいか迷わない。**

### 前を見るのは、既に持っている

```rust title="sqlite/parser/src/parser.rs"
                TK_COLUMNKW => {
                    let prev_tt = self.current_token.token_type.unwrap_or(TK_EOF);
                    let can_be_columnkw =
                        matches!(prev_tt, TK_ADD | TK_RENAME | TK_DROP | TK_ALTER);

                    if !can_be_columnkw {
                        tok.token_type = TK_ID;
                    }
                }
```

[`sqlite/parser/src/parser.rs#L574-L581`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L574-L581)。

**「前のトークン」は `self.current_token` にある。** `next_token` が呼ばれる時点では、まだ現在のトークンが入れ替わっていない。

これが最も安い規則で、**先読みが要らない。** `ALTER TABLE t ADD COLUMN x` の `COLUMN` は、直前が `ADD` なのでキーワード。それ以外の場所に現れた `column` は列名になる。

SQLite の原文は `ADD|RENAME|DROP` の 3 つだが、実装は `TK_ALTER` を足して 4 つになっている。**`ALTER TABLE t ALTER COLUMN ...` の形に対応するため**で、引用した仕様との差がそのまま残っている。

### 後ろを見るのは、投機的に読んで巻き戻す

```rust title="sqlite/parser/src/parser.rs"
    #[inline]
    fn try_parse<F, R>(&mut self, exc: F) -> R
    where
        F: FnOnce(&mut Self) -> R,
    {
        debug_assert!(!self.peekable);
        let start_offset = self.lexer.offset;
        let result = exc(self);
        self.peekable = false;
        self.lexer.offset = start_offset;
        result
    }
```

[`sqlite/parser/src/parser.rs#L657-L668`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L657-L668)。

**[`mark`](../recursive-descent/) と違い、成功しても必ず巻き戻す。**

`mark` は「失敗したら戻す」だった。`try_parse` は **「見るだけ見て、必ず戻す」**。返るのは判定の結果だけになる。

使う側はこうなる。

```rust title="sqlite/parser/src/parser.rs"
                TK_GENERATED => {
                    let can_be_generated = self.try_parse(|p| {
                        match p.consume_lexer_without_whitespaces_or_comments() {
                            None => return Ok(false),
                            Some(tok) => match tok?.token_type {
                                TK_ALWAYS => {}
                                _ => return Ok(false),
                            },
                        }

                        match p.consume_lexer_without_whitespaces_or_comments() {
                            None => Ok(false),
                            Some(tok) => match tok?.token_type {
                                TK_AS => Ok(true),
                                _ => Ok(false),
                            },
                        }
                    })?;

                    if !can_be_generated {
                        tok.token_type = TK_ID;
                    }
                }
```

[`sqlite/parser/src/parser.rs#L583-L605`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L583-L605)。

**`GENERATED ALWAYS AS (...)` の 3 語目までを覗く。** `ALWAYS` が来なければ即座に打ち切り、`AS` まで来て初めてキーワードと判定する。

`generated` という名前の列を作れるのは、この 2 トークンの先読みのおかげになる。

**「先読みの深さ」ではなく「打ち切る条件」で書かれている**のが読みやすい。1 つ目が違えば 2 つ目は読まない。

### 判定は、字句解析器を直接叩く

`try_parse` の中で呼ばれているのは `consume_lexer_without_whitespaces_or_comments` で、**パーサの `peek` ではない。**

理由は明快で、**`peek` を使うとこの同じ文脈依存判定が再帰的に走る。** `WINDOW` を判定するために先を覗いたら、その先のトークンがまた `OVER` で、その判定のためにさらに先を覗く。

```rust title="sqlite/parser/src/parser.rs"
        fn get_token(tt: TokenType) -> TokenType {
            match tt {
                TK_ID | TK_STRING | TK_JOIN_KW | TK_UNION | TK_EXCEPT | TK_INTERSECT
                | TK_GENERATED | TK_WITHOUT | TK_COLUMNKW | TK_WINDOW | TK_FILTER | TK_OVER
                | TK_WITHIN => TK_ID,
                _ => tt.fallback_id_if_ok(),
            }
        }
```

[`sqlite/parser/src/parser.rs#L388-L395`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L388-L395)。

**先読みの中では、文脈依存のキーワードを全部「識別子かもしれないもの」として扱う。**

`WINDOW` の判定は「次が識別子で、その次が `AS`」だった。その「次が識別子か」を判定するときに、**`over` という名前の列がありうる**。だから `TK_OVER` も識別子として数える。

**再帰を切るために、先読みの中だけ判定を単純化している。** 生の字句解析器を直接叩くのは、そのための手段になる。

`WINDOW` の実装で、`get_token` が使われているのはまさにその位置だ。

```rust title="sqlite/parser/src/parser.rs"
                TK_WINDOW => {
                    let can_be_window = self.try_parse(|p| {
                        match p.consume_lexer_without_whitespaces_or_comments() {
                            None => return Ok(false),
                            Some(tok) => match get_token(tok?.token_type) {
                                TK_ID => {}
                                _ => return Ok(false),
                            },
                        }

                        match p.consume_lexer_without_whitespaces_or_comments() {
                            None => Ok(false),
                            Some(tok) => match tok?.token_type {
                                TK_AS => Ok(true),
                                _ => Ok(false),
                            },
                        }
                    })?;
```

[`sqlite/parser/src/parser.rs#L477-L494`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L477-L494)。

**1 トークン目には `get_token` を通し、2 トークン目には通さない。** 1 つ目は「識別子であってほしい」ので降格を許し、2 つ目は「`AS` そのもの」なので降格させない。

### 降格の向きは、常に「キーワード → 識別子」

10 個の規則すべてが、同じ形をしている。

```rust
                    if !can_be_XXX {
                        tok.token_type = TK_ID;
                    }
```

**字句解析器は常にキーワードとして返し、パーサが条件を満たさなければ識別子に落とす。**

逆向き (識別子として返して、条件が揃えばキーワードに昇格) にもできそうに見える。だがそれをやると、**`fallback_id_if_ok` の 60 個も含めて、全キーワードの判定をパーサ側に持つ**ことになる。

**「既定はキーワード。条件を満たさないときだけ降格」**にすれば、例外だけを書けばいい。

### 呼び出し側が忘れないように

```rust title="sqlite/parser/src/token.rs"
    /// if your parsing process expects next token to be TK_ID, remember to call this function !!!
    #[inline(always)]
    pub fn fallback_id_if_ok(self) -> Self {
```

[`sqlite/parser/src/token.rs#L573-L575`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/token.rs#L573-L575)。

**「識別子を期待する場所では、この関数を呼ぶのを忘れるな !!!」**

型では強制できない。`TK_ROW` が来たときに識別子として受け入れるかどうかは、**その場所が識別子を期待しているかどうか**でしか決まらない。

だから [`peek_expect!` マクロ](../recursive-descent/) の中にも、同じ処理が埋め込まれている。

```rust title="sqlite/parser/src/parser.rs"
                    // handle fallback TK_ID
                    match (TK_ID, tt.fallback_id_if_ok()) {
                        $(($x, TK_ID) => token,)*
```

[`sqlite/parser/src/parser.rs#L31-L34`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/parser/src/parser.rs#L23-L51)。

**`eat_expect!(self, TK_ID)` と書けば、降格は自動的に効く。** 呼び忘れが起きるのは、マクロを通さず自分で `match` を書いた場所だけになる。

**忘れうる処理は、最も使われる道具の中に埋め込む。**

## なぜそうなっているか

- **キーワードが識別子になれるのは、後方互換のため。** 新しいキーワードを足すたびに既存のスキーマが壊れては、SQL の進化が止まる。
- **単純な降格で足りないのは、同じ位置に両方の解釈がありうるから。** `SELECT sum(x) OVER` は、ウィンドウ関数の始まりでも列の別名でもありうる。文法規則では決まらない。
- **パーサジェネレータをやめたのは、この判定が 10 個あるから。** LALR の枠に収めようとすると、文法の外に判定を持ち出す仕掛けが必要になる。手書きなら、判定をその場に書ける。
- **前後で必要なトークン数が違うのは、単語ごとに曖昧さの形が違うから。** 一律に「2 トークン先読み」にすると、要らない場所でコストを払う。
- **成功しても巻き戻す `try_parse` があるのは、判定と消費を分けたいから。** 「見て決める」だけなので、結果は真偽値 1 つでいい。
- **先読みで字句解析器を直接叩くのは、判定の再帰を切るため。** 文脈依存のキーワードを判定するために、また文脈依存のキーワードを判定することになる。
- **先読みの中で全部を識別子扱いするのは、そこで正確さが要らないから。** 「識別子になりうるか」だけが分かればいい。
- **降格の向きを一方向に固定したのは、例外だけを書くため。** 逆向きにすると、全キーワードの判定をパーサに持つことになる。
- **降格の呼び出しをマクロに埋め込んだのは、忘れるから。** 型でも命名でも強制できない性質は、最も使われる経路の中に入れる。

## どう活かすか

- **予約語を設計するときは、「識別子としても使える」を前提にする。** 完全な予約にすると、語を足すたびに既存の入力が壊れる。
- **文法だけで決まらない判断があるなら、パーサジェネレータの適用範囲を疑う。** 例外が 1〜2 個なら回避できるが、10 個あるなら手書きの方が素直になる。
- **文脈依存の判定は、必要な情報の量を規則ごとに書き出す。** 「前を 1 つ」「後ろを 2 つ」を表にすると、実装の形が決まる。
- **先読みには「必ず巻き戻す」専用の道具を用意する。** 「失敗したら戻す」とは別物として扱わないと、消費したつもりのない入力が消える。
- **先読みの中では、判定を単純化してよい。** 正確な判定を再帰的に呼ぶと止まらなくなる。「〜になりうるか」だけ分かれば十分なことが多い。
- **既定値を決めて、例外だけを書く形にする。** 「常にキーワード。条件を満たさないときだけ識別子」なら、書くのは例外の 10 個だけで済む。
- **参照実装の判定規則は、原文のまま引用してから実装する。** そして自分で足した規則も、同じ形式で書く。後から読む人が、どこまでが借り物でどこからが自前かを区別できる。
- **忘れると壊れる処理は、最も頻繁に使われる道具の中に埋め込む。** ドキュメントに感嘆符を 3 つ付けるより効く。
