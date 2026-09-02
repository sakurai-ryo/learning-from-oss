---
title: "行の連結とエスケープトークンの差し替え"
description: "Dockerfile の行末バックスラッシュは、正規表現 1 本で処理されている。escape ディレクティブでトークンを差し替えられるのは、そのたびに正規表現を組み直しているからで、Go に否定先読みがないせいで残った既知の穴もソースコードに書かれている。"
group: "Dockerfile を読む"
sidebar:
  order: 16
---

## 何を学んだか

Dockerfile の行連結は、`escapeToken` から組み立てた正規表現 1 本で判定されている。`# escape=`` ` `` でトークンをバッククォートに差し替えられるのは、切り替えのたびに `regexp.MustCompile` で正規表現を作り直しているからだ。そして「Go には否定先読みがないので `foo \\\` は正しく扱えない」という既知の欠落が、コメントで明示されている。

```go title="frontend/dockerfile/parser/parser.go"
func (d *directives) setEscapeToken(s string) error {
	if s != "`" && s != `\` {
		return errors.Errorf("invalid escape token '%s' does not match ` or \\", s)
	}
	d.escapeToken = rune(s[0])
	// The escape token is used both to escape characters in a line and as line
	// continuation token. If it's the last non-whitespace token, it is used as
	// line-continuation token, *unless* preceded by an escape-token.
	//
	// The second branch in the regular expression handles line-continuation
	// tokens on their own line, which don't have any character preceding them.
	//
	// Due to Go lacking negative look-ahead matching, this regular expression
	// does not currently handle a line-continuation token preceded by an *escaped*
	// escape-token ("foo \\\").
	d.lineContinuationRegex = regexp.MustCompile(`([^\` + s + `])\` + s + `[ \t]*$|^\` + s + `[ \t]*$`)
	return nil
}
```

([frontend/dockerfile/parser/parser.go L150-L170](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/parser.go#L150-L170))

## 正規表現の 2 つの枝

デフォルト (`\`) では、組み上がる正規表現はこうなる。

```
([^\\])\\[ \t]*$   |   ^\\[ \t]*$
```

左の枝が「行末が `X\` で、`X` はエスケープトークンではない」、右の枝が「行全体がエスケープトークン 1 文字だけ (+ 空白)」。右の枝が要るのは、継続行が `\` だけの行になるケースがあるからだ。

判定と除去は同じ正規表現でやる。

```go title="frontend/dockerfile/parser/parser.go"
func trimContinuationCharacter(line []byte, d *directives) ([]byte, bool) {
	if d.lineContinuationRegex.Match(line) {
		line = d.lineContinuationRegex.ReplaceAll(line, []byte("$1"))
		return line, false
	}
	return line, true
}
```

([frontend/dockerfile/parser/parser.go L532-L538](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/parser.go#L532-L538))

`ReplaceAll` の置換文字列が `$1` なのがポイントで、左の枝でキャプチャした「エスケープトークンの直前の 1 文字」だけを残し、トークンと末尾の空白を消す。右の枝ではキャプチャグループが空なので、行全体が消える。返り値の bool は `isEndOfLine`、つまり「この行で命令が終わったか」だ。

### 左の枝の `[^\\]` が意味を持つ実例

`testfiles/trailing-backslash/Dockerfile` は、この 1 文字クラスのためだけに存在するテストだ ([Windows 向けの issue](https://github.com/docker/for-win/issues/5254) が冒頭に貼られている)。

```dockerfile
ENV C trailing\\backslash\\
ENV D This should not be appended to C
```

`ENV C` の行末は `\` `\` の 2 文字。左の枝は最後の `\` の直前を `[^\\]` で要求するので一致しない。右の枝も行全体が `\` ではないので一致しない。結果 `isEndOfLine = true` になり、`ENV D` は別の命令として扱われる。ユーザから見れば「`\\` は末尾のバックスラッシュ 1 文字であって行継続ではない」という bash と同じ直感で、その直感が `[^\\]` という 5 文字に収まっている。

コメントが認めている穴はこの先だ。`foo \\\` (バックスラッシュ 3 つ) は、bash なら「エスケープされた `\` + 継続」だが、この正規表現は最後の `\` の直前が `\` なので一致せず、継続として扱われない。否定先読みがあれば「偶数個の `\` に続く `\`」を書けるが、Go の `regexp` (RE2) には無い。直すには正規表現を捨てて手書きの走査に変える必要があり、既存の Dockerfile の挙動を変えるリスクを取ってまでやっていない。

## 連結ループ — 外側と内側の 2 重

`Parse` は、命令 1 つを外側のループの 1 周に対応させ、継続がある間は内側のループで行を食い足す。

```go title="frontend/dockerfile/parser/parser.go"
		startLine := currentLine
		bytesRead, isEndOfLine := trimContinuationCharacter(bytesRead, d)
		if isEndOfLine && len(bytesRead) == 0 {
			continue
		}
		buf.Reset()
		buf.Write(bytesRead)

		var hasEmptyContinuationLine bool
		for !isEndOfLine && scanner.Scan() {
			bytesRead, _, err := processLine(d, scanner.Bytes(), false)
			// ...
			if isComment(scanner.Bytes()) {
				// original line was a comment (processLine strips comments)
				continue
			}
			if isEmptyContinuationLine(bytesRead) {
				hasEmptyContinuationLine = true
				continue
			}

			bytesRead, isEndOfLine = trimContinuationCharacter(bytesRead, d)
			buf.Write(bytesRead)
		}
```

([frontend/dockerfile/parser/parser.go L320-L347](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/parser.go#L320-L347))

内側のループで拾う 3 種類の行の扱いが、この関数の実質だ。

**コメント行は無条件に読み飛ばす。** 連結の途中にコメントを書ける。判定に `bytesRead` ではなく `scanner.Bytes()` (加工前の生バイト) を使っているのは、`processLine` がコメント行を `nil` にしてしまうからだ。もし加工後で判定すると、コメント行と空行が区別できなくなる。

**空の継続行は連結を止めず、警告を積む。**

```go title="frontend/dockerfile/parser/parser.go"
			warnings = append(warnings, Warning{
				Short:    "Empty continuation line found in: " + line,
				Detail:   [][]byte{[]byte("Empty continuation lines will become errors in a future release")},
				URL:      "https://docs.docker.com/go/dockerfile/rule/no-empty-continuation/",
				// ...
			})
```

([frontend/dockerfile/parser/parser.go L351-L358](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/parser.go#L351-L358))

`testfiles/continueIndent/Dockerfile` の

```dockerfile
RUN echo hi \
 \
 world \
\
 good\
\
night
```

がこの経路を通る。空行を挟んでも連結が続くのは歴史的な挙動で、将来エラーにすると宣言しつつ、今は警告に留めている。警告は `Result.Warnings` に載って `PrintWarnings` でクライアントに出る。

**継続行の左空白は削らない。** 外側では `processLine(d, bytesRead, true)`、内側では `processLine(d, scanner.Bytes(), false)` と、第 3 引数 `stripLeftWhitespace` が違う。連結された行の途中の空白がそのまま残るので、`RUN echo hello\` + `  world` は `RUN echo hello  world` になる。この挙動には TODO が付いている。

```go title="frontend/dockerfile/parser/parser.go"
// TODO: remove stripLeftWhitespace after deprecation period. It seems silly
// to preserve whitespace on continuation lines. Why is that done?
```

([frontend/dockerfile/parser/parser.go L540-L541](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/parser.go#L540-L541))

「なぜそうなっているのか分からないが、変えると壊れるかもしれないので残している」と正直に書いてある。

## 改行と CRLF

`bufio.Scanner` の分割関数を自前に差し替えていて、改行文字を捨てない。

```go title="frontend/dockerfile/parser/parser.go"
// Variation of bufio.ScanLines that preserves the line endings
func scanLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		return i + 1, data[0 : i+1], nil
	}
	// ...
}
```

([frontend/dockerfile/parser/parser.go L551-L563](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/parser.go#L551-L563))

改行を残すのは heredoc のためだ。heredoc の本体は `content.Write(bytesRead)` でそのまま連結されるので、`\n` が付いていないと行が全部くっついてしまう ([../heredoc/](../heredoc/))。

一方、命令行の側では `processLine` の最初で `trimNewline` が `\r` と `\n` を右から削る。

```go title="frontend/dockerfile/parser/parser.go"
func trimNewline(src []byte) []byte {
	return bytes.TrimRight(src, "\r\n")
}
```

([frontend/dockerfile/parser/parser.go L519-L521](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/parser.go#L519-L521))

CRLF 対応がここに集約されている。行末が `\ \r \n` でも、`trimNewline` の後で `\` が行末になるので `[ \t]*$` に到達する。逆に言えば、この 1 行を通らない経路 (heredoc の本体) は CRLF がそのまま残る。

## エスケープトークンは連結以外にも効く

`d.escapeToken` は `directives` 構造体に置かれ、パーサ全体で共有される。使われるのは 3 か所だ。

| 使う場所                                                                                                                                                                   | 何に効くか                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `trimContinuationCharacter`                                                                                                                                                | 行連結                                                                             |
| `parseWords` ([line_parsers.go](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/line_parsers.go#L103))           | `ENV` / `LABEL` / `ARG` の引数分割                                                 |
| `extractBuilderFlags` ([split_command.go](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/split_command.go#L90)) | `--flag=...` の値の中のエスケープ ([../instruction-flags/](../instruction-flags/)) |

`parseWords` には、引用符の中と外でエスケープの扱いが違うという規則がある。

```go title="frontend/dockerfile/parser/line_parsers.go"
		if phase == inQuote {
			if ch == quote {
				phase = inWord
			}
			// The escape token is special except for ' quotes - can't escape anything for '
			if ch == d.escapeToken && quote != '\'' {
```

([frontend/dockerfile/parser/line_parsers.go L117-L122](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/parser/line_parsers.go#L117-L122))

シングルクォートの中ではエスケープトークンがただの文字になる。これは sh の規則をなぞっていて、[shell.Lex](../shell-lex/) 側の `processSingleQuote` にも同じ規則がある。ただし `parseWords` はエスケープトークンを**消さずに残す** ("The quotes are preserved as part of this function and they are stripped later as part of processWords()")。パーサは分割だけして、引用符とエスケープの解釈は変数展開のタイミングまで持ち越される。

`# escape=`` ` `` を使うと、この 3 か所が全部バッククォート基準になる。`testfiles/escape/Dockerfile` はこうなっている。

```dockerfile
#escape = `

FROM image
LABEL maintainer foo@bar.com
ENV GOPATH `
\go
```

`ENV GOPATH` の行末がバッククォートなので継続し、次行の `\go` はエスケープされずにそのまま値になる。Windows のパスを `C:\Users\...` と素直に書きたい、という要求のためだけの機能で、そのために正規表現を実行時に組み立てるという設計になっている。

## なぜそうなっているか

エスケープトークンが実行時に変わりうるので、正規表現を定数にできない。選択肢は「トークンごとにあらかじめ 2 本コンパイルしておく」か「切り替え時に組み立てる」で、後者を選んでいる。`setEscapeToken` が呼ばれるのは Dockerfile 1 本につき高々 1 回 ([../parser-directives/](../parser-directives/) で重複が禁止されている) なので、コストは問題にならない。

より本質的なのは、**行連結という機能を正規表現 1 本に押し込めた**ことだ。逐次スキャンで書けば `foo \\\` の穴は塞げるが、代わりに「トークンの直前が何か」を数える状態が増え、`escape` ディレクティブとの組み合わせでテストすべき経路が増える。既知の穴をコメントで宣言したうえで、2 分岐の正規表現に留めている。挙動互換が最優先の層では、これは妥当なトレードオフに見える。

## どう活かすか

**動的に変わるパラメータを持つ正規表現は、変更点で組み直す。** 「トークンをパラメータ化するために正規表現をやめて手書きにする」は、たいていやりすぎになる。設定変更が高々数回なら、変更のたびに `MustCompile` するのが一番短い。ただし組み立てる文字列に外部入力を通さないこと。BuildKit は `s != "`" && s != `\`` で先に値域を 2 つに絞ってから連結している。

**既知の欠落は、直さないならコメントで書く。** `foo \\\` の件は、後から読む人が同じ調査をやり直すのを防いでいるだけでなく、「これは意図せぬバグではなく、承知のうえで残した穴だ」という情報を運ぶ。同じことが `stripLeftWhitespace` の TODO にも言える。「なぜこうなっているか分からない」と書くのは、分からないまま黙って残すより価値がある。

**加工前と加工後のどちらで判定するかを意識する。** コメント行の判定に `scanner.Bytes()` を使う一手が入っていないと、コメントと空行の区別がつかなくなり、空継続行の警告が誤爆する。パイプラインを組むときは、後段の判定が前段の破壊的な変換より前の情報を必要としないか毎回確認する。必要なら、変換前の値も一緒に持ち回すほうが安い。
