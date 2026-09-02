---
title: "shell.Lex — bash 風展開のサブセットと文字列反転トリック"
description: "Dockerfile の変数展開は bash ではなく、bash に似せた 700 行の独自レキサでやっている。RE2 が「最短の右端一致」を書けないので、${var%pattern} はパターンと値を両方反転して左端一致に変換している。"
group: "Dockerfile を読む"
sidebar:
  order: 20
---

## 何を学んだか

`ENV`、`ARG`、`COPY` の引数、`RUN --mount` の値。Dockerfile の中で `$VAR` が展開されるところは全部 `frontend/dockerfile/shell` の `Lex` を通る。sh を呼ぶわけでも、シェルパーサのライブラリを使うわけでもなく、`text/scanner` の上に書かれた 700 行の手書きレキサだ。冒頭のコメントが範囲を宣言している。

```go title="frontend/dockerfile/shell/lex.go"
// Lex performs shell word splitting and variable expansion.
//
// Lex takes a string and an array of env variables and
// process all quotes (" and ') as well as $xxx and ${xxx} env variable
// tokens.  Tries to mimic bash shell process.
// It doesn't support all flavors of ${xx:...} formats but new ones can
// be added by adding code to the "special ${} format processing" section
//
// It is not safe to call methods on a Lex instance concurrently.
type Lex struct {
	escapeToken       rune
	RawQuotes         bool
	RawEscapes        bool
	SkipProcessQuotes bool
	SkipUnsetEnv      bool
	shellWord         shellWord
}
```

([frontend/dockerfile/shell/lex.go L20-L36](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L20-L36))

「bash のプロセスを真似ようとしている」「`${xx:...}` の全種類には対応していない」。真似であってエミュレーションではない、というのが最初の 1 行に書いてある。

そして `${var%pattern}` — 値の末尾からパターンを削る展開 — の実装が面白い。Go の `regexp` (RE2) には「右端から最短で一致する部分」を書く手段がないので、**パターンと値の両方を反転させて左端一致の問題に変換している**。

## 対応している展開

`processDollar` の分岐を数え上げると、対応しているものはこれで全部だ。

| 書き方                         | 挙動                                                  | 実装位置                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `$name`                        | 素の参照。名前は英数字と `_`                          | [L342-L352](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L342)          |
| `$1` `$@` `$#` など            | 数字の並び、および `@ * # ? - $ ! 0` の特殊パラメータ | `processName` [L487](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L487) |
| `${name}`                      | 素の参照                                              | [L368-L374](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L368)          |
| `${name-w}` / `${name:-w}`     | 未設定なら `w`。`:` 付きは空文字も未設定扱い          | [L401-L405](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L401)          |
| `${name+w}` / `${name:+w}`     | 設定済みなら `w`、でなければ空                        | [L406-L410](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L406)          |
| `${name?w}` / `${name:?w}`     | 未設定ならエラー。`w` がメッセージ                    | [L411-L426](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L411)          |
| `${name#p}` / `${name##p}`     | 先頭からパターンを削る。`##` は最長                   | [L427-L439](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L427)          |
| `${name%p}` / `${name%%p}`     | 末尾からパターンを削る。`%%` は最長                   | 同上                                                                                                                                       |
| `${name/p/r}` / `${name//p/r}` | 置換。`//` は全置換                                   | [L443-L481](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L443)          |

無いものは `${name=w}` (代入)、`${name:offset:length}` (部分文字列)、`${#name}` (長さ)、配列、コマンド置換、算術展開。どれも `default:` で `unsupported modifier (%s) in substitution` になる。

`:` と `#` / `%` の組み合わせは、`default` に落ちる前に個別に拒否される。

```go title="frontend/dockerfile/shell/lex.go"
	case '+', '-', '?', '#', '%':
		rawEscapes := ch == '#' || ch == '%'
		if nullIsUnset && rawEscapes {
			return "", errors.Errorf("unsupported modifier (%s) in substitution", chs)
		}
```

([frontend/dockerfile/shell/lex.go L380-L384](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L380-L384))

`nullIsUnset` は `:` を読んだときに立つフラグで、`case ':'` から `fallthrough` してここに来る。`${x:#p}` は bash にも無いので、明示的に落としている。`rawEscapes` という変数名がヒントで、`#` と `%` のときだけパターン部分をエスケープ解決せずに読む。`${FOO#\*}` の `\*` を「ワイルドカードではなくリテラルの `*`」としてパターンコンパイラに渡すためだ。

`##` / `%%` の最長一致は、読み込んだ後の 1 文字目を見て判定する。

```go title="frontend/dockerfile/shell/lex.go"
		case '%', '#':
			// %/# matches the shortest pattern expansion, %%/## the longest
			greedy := false

			if len(word) > 0 && word[0] == byte(ch) {
				greedy = true
				word = word[1:]
			}
```

([frontend/dockerfile/shell/lex.go L427-L434](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L427-L434))

`${FOO##*x}` を読むと `ch = '#'`、`word = "#*x"` になるので、先頭を剥がして `greedy` を立てる。2 文字目を先読みする代わりに、パターンの先頭を後から見ている。

## 文字列反転トリック

`${FOO%.txt}` は「値の末尾から `.txt` に一致する最短の部分を削る」。正規表現でやるなら `\.txt$` に一致する部分を探せばよさそうだが、`*` を含むパターンだと壊れる。`${FOO%%\**}` (FOO=`xx**`) のように「末尾からの最長一致」を書こうとすると、RE2 には右端優先の量指定子がない。

そこで両方を反転して、左端一致に変換する。

```go title="frontend/dockerfile/shell/lex.go"
func trimSuffix(pattern, word string, greedy bool) (string, error) {
	// regular expressions can't handle finding the shortest rightmost
	// string so we reverse both search space and pattern to convert it
	// to a leftmost search in both cases
	pattern = reversePattern(pattern)
	word = reverseString(word)
	str, err := trimPrefix(pattern, word, greedy)
	if err != nil {
		return "", err
	}
	return reverseString(str), nil
}
```

([frontend/dockerfile/shell/lex.go L688-L699](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L688-L699))

`${FOO%.txt}` を FOO=`a.b.txt` に適用したときの流れ。

```
入力      pattern = ".txt"          value = "a.b.txt"
                                            ^^^^ 消したい (右端)

反転      pattern = "txt."          value = "txt.b.a"
                                    ^^^^^ 消したい (左端になった)

正規表現  ^txt\.        (anchored = true, greedy は ".*" / ".*?" の別)
一致      [0, 4)
残り      "b.a"

再反転    "a.b"
```

`trimPrefix` は左端専用で、`^` を付けてコンパイルする。

```go title="frontend/dockerfile/shell/lex.go"
func trimPrefix(word, value string, greedy bool) (string, error) {
	re, err := convertShellPatternToRegex(word, greedy, true)
	if err != nil {
		return "", errors.Errorf("invalid pattern (%s) in substitution: %s", word, err)
	}

	if idx := re.FindStringIndex(value); idx != nil {
		value = value[idx[1]:]
	}
	return value, nil
}
```

([frontend/dockerfile/shell/lex.go L648-L658](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L648-L658))

`${var#p}` はこれをそのまま呼び、`${var%p}` は反転を 3 回挟んで同じ関数を呼ぶ。一致ロジックは 1 本しかない。

### 反転はエスケープ対を壊さない

素朴に文字列を反転すると `a\*c` が `c*\a` になり、「エスケープされた `*`」が「ワイルドカードの `*` とエスケープされた `a`」に化ける。だからパターン専用の反転が要る。

```go title="frontend/dockerfile/shell/lex.go"
// reverse without avoid reversing escapes, i.e. a\*c -> c\*a
func reversePattern(pattern string) string {
	patternRunes := []rune(pattern)
	out := make([]rune, len(patternRunes))
	lastIdx := len(patternRunes) - 1
	for i := 0; i <= lastIdx; {
		tok := patternRunes[i]
		outIdx := lastIdx - i
		if tok == '\\' && i != lastIdx {
			out[outIdx-1] = tok
			// the pattern is taken from a ${var#pattern}, so the last
			// character can't be an escape character
			out[outIdx] = patternRunes[i+1]
			i += 2
		} else {
			out[outIdx] = tok
			i++
		}
	}
	return string(out)
}
```

([frontend/dockerfile/shell/lex.go L660-L680](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L660-L680))

`\` を見たら 2 文字を 1 単位として、出力側でも `\` を前に、被エスケープ文字を後ろに置く。書き込み先が `out[outIdx-1]` と `out[outIdx]` の順になっているのがそれだ。テストが境界を並べている。

```go title="frontend/dockerfile/shell/lex_test.go"
	cases := map[string]string{
		"a\\*c":    "c\\*a",
		"\\\\\\ab": "b\\a\\\\",
		"ab\\":     "\\ba",
		"👽\\🚀🖖":    "🖖\\🚀👽",
		"\\\\b":    "b\\\\",
	}
```

([frontend/dockerfile/shell/lex_test.go L39-L48](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex_test.go#L39-L48))

`[]rune` で扱っているので絵文字も壊れない。値のほうの反転は単純で、`slices.Reverse` を 1 行呼ぶだけ。

`ab\` (末尾がエスケープ文字) が `\ba` になるのは、`i == lastIdx` の分岐で `\` を 1 文字として扱うから。コメントが「`${var#pattern}` から来たパターンなので最後の文字がエスケープ文字になることはない」と書いているとおり、本来到達しない経路だが、`out` の範囲外書き込みを防ぐためのガードになっている。

### グロブから正規表現へ

パターンの解釈自体は POSIX のワイルドカードのサブセットだ。

```go title="frontend/dockerfile/shell/lex.go"
// convertShellPatternToRegex converts a shell-like wildcard pattern
// (? is a single char, * either the shortest or longest (greedy) string)
// to an equivalent regular expression.
//
// Based on
// https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_13
// but without the bracket expressions (`[]`)
func convertShellPatternToRegex(pattern string, greedy bool, anchored bool) (*regexp.Regexp, error) {
```

([frontend/dockerfile/shell/lex.go L595-L602](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L595-L602))

`*` → `.*` または `.*?`、`?` → `.`、`[a-z]` は非対応で `[` は正規表現のメタ文字としてエスケープされる。ここに `${}` の構文の都合が混ざる分岐がある。

```go title="frontend/dockerfile/shell/lex.go"
		case '\\':
			// } and / as part of ${} need to be escaped, but the escape isn't part
			// of the pattern
			if s.Peek() == '}' || s.Peek() == '/' {
				continue
			}
```

([frontend/dockerfile/shell/lex.go L627-L632](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L627-L632))

`${FOO/a\/b/c}` のようにパターンの中に `/` を書くには `\` が要るが、その `\` はグロブとしての意味を持たない。レキサ側 (`${}` の終端を探す) の都合で入ったエスケープを、パターンコンパイラ側で剥がしている。

## フラグ 4 つと、その使われ方

`Lex` の 4 つの公開フラグは、いずれも「情報を壊すかどうか」を切り替える。

| フラグ              | 立てると                       | 誰が使うか                                            |
| ------------------- | ------------------------------ | ----------------------------------------------------- |
| `RawQuotes`         | 引用符を結果に残す             | [heredoc の引用判定](../heredoc/)、`RUN` の表示名生成 |
| `RawEscapes`        | エスケープトークンを結果に残す | `heredocsFromLine`                                    |
| `SkipProcessQuotes` | 引用符を特別扱いしない         | heredoc 本文の展開 (`ExpandRaw`)                      |
| `SkipUnsetEnv`      | 未定義変数を元の表記のまま残す | heredoc 検出、`RUN` の表示名生成                      |

`SkipUnsetEnv` の「元の表記のまま」は文字通りで、書き方を再構成して返す。

```go title="frontend/dockerfile/shell/lex.go"
		value, set := sw.getEnv(name)
		if sw.SkipUnsetEnv && !set {
			return fmt.Sprintf("${%s%s%s}", name, chs, word), nil
		}
```

([frontend/dockerfile/shell/lex.go L395-L398](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L395-L398))

`chs` は読んだ修飾子 (`:-` なら 2 文字) を溜めた文字列で、`${FOO:-bar}` が未定義なら `${FOO:-bar}` がそのまま返る。`$name` 形式なら `$name`、`${name}` 形式なら `${name}` と、波括弧の有無まで区別している。展開しない場面で情報を失わないための配慮で、これがないと [heredoc の終端語](../heredoc/)が `<<$EOF` から `<<` に潰れてしまう。

`rawEscapes` だけは公開フラグとは別に、`processStopOn` の中で一時的に切り替わる ([L187-L193](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L187-L193))。復元する `defer` が元の値を保存せず `sw.rawEscapes = !rawEscapes` と書いているのは、この `if` に入る条件が「元の値と違う」= bool なので元の値が `!rawEscapes` に決まっているから。

## 単語分割は展開の後にやる

`ProcessWord` と `ProcessWords` は同じ `process` を呼び、返すフィールドが違うだけだ。

```go title="frontend/dockerfile/shell/lex.go"
func (s *Lex) process(word string, env EnvGetter, capture bool) (ProcessWordResult, error) {
	sw := s.initWord(word, env, capture)
	word, words, err := sw.process(word)
	return ProcessWordResult{
		Result:    word,
		Words:     words,
		Matched:   sw.matches,
		Unmatched: sw.nonmatches,
	}, err
}
```

([frontend/dockerfile/shell/lex.go L92-L101](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L92-L101))

分割の規則は `processStopOn` の中の 2 行に集約されている。

```go title="frontend/dockerfile/shell/lex.go"
			if ch == rune('$') {
				words.addString(tmp)
			} else {
				words.addRawString(tmp)
			}
```

([frontend/dockerfile/shell/lex.go L210-L214](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L210-L214))

`addString` は 1 文字ずつ `addChar` に流し、空白で単語を切る。`addRawString` は切らずに丸ごと足す。つまり**変数展開の結果は空白で分割されるが、引用符の中身は分割されない**という sh の規則が、この if 一つで表現されている。`ProcessWords` の型コメントにも「分割は環境変数の置換の**後**でやる」と明記されている。

`Matched` / `Unmatched` は展開の副産物で、`getEnv` ([L547-L565](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/shell/lex.go#L547-L565)) が解決できた名前とできなかった名前をそれぞれのマップに記録する。これを `dockerfile2llb` の `reportUnmatchedVariables` が受け取り、「`$FOOO` は未定義。`FOO` の間違いでは」という linter 警告になる。展開の途中でしか分からない情報を、展開の戻り値に載せて外に出している。

`Lex` が `shellWord` を値で埋め込んで使い回している (`initWord` が同じインスタンスを初期化して返す) のは、1 つの Dockerfile で `ProcessWord` が何百回も呼ばれるからだ。その代償が型コメントの「同じ `Lex` インスタンスのメソッドを並行に呼ぶのは安全ではない」という制約で、実際 `dispatchRun` は `shlex := *dopt.shlex` と値コピーしてからフラグを変えている。

## なぜそうなっているか

Dockerfile の変数展開に本物のシェルを使うわけにいかない理由は 2 つある。**ビルドマシン上でシェルを起動できない** — 展開はフロントエンドの中、コンテナを起動する前に起きる。そして **LLB は決定的でなければならない** — 展開結果がホストのシェルの種類やバージョンで変わると、同じ Dockerfile が違う DAG になり、[キャッシュキー](../cachekey-composition/)が壊れる。だから展開は BuildKit のプロセス内で完結する必要があり、実装を持つしかない。

そのうえで「bash 互換」を目指していない。目指すと、コマンド置換 (`$(...)`) や算術展開まで実装することになり、それは Dockerfile がチューリング完全に近づくということだ。ビルド定義を静的に読めることが LLB への変換の前提なので、対応する構文を「文字列を組み立てる展開」だけに絞っている。冒頭のコメントの「新しい `${}` 形式は該当セクションにコードを足せば追加できる」は、拡張の余地を残しつつ、既定では狭く保つという方針の表明に見える。

反転トリックは、その狭さの中で生きている。もし完全なグロブマッチャを自前で書いていれば、右端最短一致は素直に実装できた。RE2 に載せると決めた時点で、右端の一致は書けなくなる。そこで問題のほうを変換した。反転関数 2 つ (合わせて 30 行) で済み、一致ロジックは `trimPrefix` の 1 本のまま。マッチャを 2 本持つより、入力を変換して 1 本に寄せるほうが小さい。

## どう活かすか

**ツールの制約に合わせて、問題のほうを変換する。** 「RE2 に右端最短一致がない」に対して、正規表現エンジンを差し替えるのでも、専用マッチャを書くのでもなく、入力を反転させた。前処理と後処理を足して既存の実装に載せられないか、を先に考える。反転・正規化・座標変換の類は、たいてい対称なので後処理が前処理と同型になり、コード量が読める。

**変換が壊す不変条件を明示的に守る。** 素朴な `reverseString` はエスケープ対を壊す。`reversePattern` はそれを知っていて 2 文字単位で扱い、コメントに `a\*c -> c\*a` と書いてある。変換を挟むときは「何が保存されるべきか」を先に決めて、テストの表にする。`lex_test.go` の `TestReversePattern` は 5 ケースしかないが、エスケープの直後・末尾・連続・マルチバイトを全部押さえている。

**「情報を壊さない」フラグを持たせる。** `RawQuotes` / `RawEscapes` / `SkipUnsetEnv` はどれも「加工しないで返す」という方向のフラグだ。同じレキサを、値を得るためにも、元の文字列を調べるためにも使える。パーサやレキサを書くとき、破壊的な正規化を必ず通す設計にすると、後から「元の書き方を知りたい」という要求に応えられなくなる。

**副産物を戻り値に載せる。** どの変数が解決できて、どれができなかったか、は展開の途中でしか分からない。`ProcessWordResult` に `Matched` / `Unmatched` を持たせておくと、linter が同じ処理をもう一度やらずに済む。処理の中で自然に手に入る情報は、捨てる前に呼び出し側が欲しがらないか確認する価値がある。
