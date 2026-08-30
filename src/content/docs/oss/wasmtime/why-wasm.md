---
title: "なぜ WebAssembly が生まれたのか"
description: "WebAssembly は「ブラウザで動く速い言語」ではなく、他人が書いたコードを自分のマシンで安全に走らせるための命令セットとして設計されている。速さ・安全性・移植性・コンパクトさという 4 つの要求が、線形メモリ・構造化制御構文・事前型検査という具体的な形になっていることを、Wasmtime のセキュリティ文書から確認する。"
group: "WebAssembly をゼロから"
sidebar:
  order: 1
---

## 解こうとしている問題

「他人が書いたコードを、自分のマシンで走らせたい。ただし、そのコードが何をしてくるか分からない」。

この問題自体は新しくない。むしろコンピュータの歴史そのものと言っていい。解法もいくつも積み上がってきた。

**プロセス分離**は、OS のページテーブルと権限モデルに頼る。強力だが、粒度が粗く、起動コストがあり、何より「そのプロセスが持つ権限」がホストのユーザ権限から始まってしまう。**仮想マシン**はもっと強い境界を引けるが、ゲスト OS ごと持ち込む必要がある。**インタプリタ言語**は実行系がすべてを仲介するので安全にしやすいが、遅い。**JavaScript** は事実上その道を極端に押し進めたもので、実際に速くもなったが、言語の意味論が最適化の前提を壊しやすく、そして何より「C や Rust で書かれた既存のコードを持ってこられない」。

WebAssembly は、ここに別の切り口を持ち込んだ。**サンドボックスを言語の意味論の側に埋め込む**、というものだ。

## 4 つの要求

Wasm の設計を規定しているのは、次の 4 つが同時に必要だという条件だ。

1. **速いこと。** ネイティブコードに近い速度で走ること。つまり最終的には機械語になること。
2. **安全であること。** バイナリがどれだけ悪意を持っていても、渡されていない資源に触れないこと。
3. **移植可能であること。** CPU アーキテクチャにも OS にも依存しない形式であること。
4. **コンパクトであること。** ネットワーク越しに配る前提なので、小さく、そして速くパースできること。

1 と 2 は普通に考えると両立しにくい。速くするには最終的にネイティブの機械語を CPU に直接実行させたいが、そうすると「実行中に何をするか」をランタイムが逐一監視できなくなる。インタプリタなら 1 命令ごとに介入できるが、それは遅い。

Wasm の答えは、**実行前にすべて検査を済ませ、実行中の検査を最小限にする**というものだった。そのために言語の形そのものを、静的に検査しやすい形に絞り込んでいる。

## サンドボックスは何によって成立しているのか

Wasmtime のセキュリティ文書が、コア WebAssembly が持つ性質を 5 つに整理している。

```text title="docs/security.md"
* Applications cannot access the call stack. This means they cannot manipulate
  the return addresses of function calls, ...

* Pointers, in the compiled code, are compiled to offsets into linear memory,
  ...

* All control transfers -- direct and indirect branches and function calls --
  are to known and type-checked destinations, ...

* Applications' interactions with the outside world are done through imports
  and exports, ...

* There is no undefined behavior, ...
```

[docs/security.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/docs/security.md)

この 5 つは、それぞれ具体的な言語設計に対応している。

**コールスタックにアクセスできない。** Wasm には「スタックのアドレス」という概念がない。ローカル変数は番号で参照し、戻り番地はプログラムから見えない場所にある。だからバッファオーバーフローで戻り番地を書き換える、という古典的な攻撃が原理的に成立しない。線形メモリを溢れさせることはできるが、溢れた先にあるのは同じ線形メモリの別の場所であって、実行系のデータ構造ではない。

**ポインタは線形メモリへのオフセットである。** Wasm のプログラムが扱う「アドレス」は 0 から始まる `i32` (または `i64`) の整数で、ホストの仮想アドレスではない。`i32.load` は「線形メモリの先頭から N バイト目を読む」という意味しか持たない。そして N が線形メモリのサイズを超えていればトラップする。この「境界の外に出たらトラップする」という部分をどう実装するかが、Wasmtime のコード生成の中でもっとも神経を使う箇所になる ([境界チェックを「消す」ための条件を数式で追う](../bounds-check-elision/))。

**すべての制御移動が既知かつ型検査済みの宛先へ向かう。** Wasm には「任意のアドレスへジャンプする」命令がない。分岐は構造化された制御ブロックの入れ子を n 段遡る形でしか書けず、間接呼び出しはテーブルの要素を型検査した上でしか呼べない。つまり **CFI (制御フロー整合性) が言語の定義に含まれている**。

**外界との相互作用は import と export だけ。** システムコールに相当する命令が存在しない。ファイルを開きたければ、ホストが `import` として渡した関数を呼ぶしかない。渡されなければ、開く手段がない。これが後の WASI のケイパビリティモデルの土台になる ([WASI とは何か](../what-wasi-is/))。

**未定義動作がない。** 仕様が複数の挙動を許す箇所 (浮動小数点の NaN のビットパターンなど) はあるが、「何が起きてもよい」という箇所はない。これは C や C++ を Wasm にコンパイルしたときの意味が変わることを意味する。C のレベルでの未定義動作は、Wasm のレベルでは何らかの定義された挙動になる。

## サンドボックスの内側は守らない

ここで重要な線引きがある。Wasm が守るのは **ホストと他のインスタンス**であって、**そのプログラム自身**ではない。

Wasmtime の脆弱性判断基準にこう書かれている。

```text title="docs/security-what-is-considered-a-security-vulnerability.md"
Bugs in Wasmtime's implementation of WebAssembly semantics -- for example,
computing an incorrect value -- are not considered security vulnerabilities
as long as they don't allow escaping the sandbox.
```

[docs/security-what-is-considered-a-security-vulnerability.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/docs/security-what-is-considered-a-security-vulnerability.md)

サンドボックスの中で `2 + 2` が `5` になるバグは、脆弱性ではない。これは奇妙に聞こえるが、境界の定義としては筋が通っている。境界の内側で何が起きても、外に漏れなければサンドボックスは仕事をしている。

そしてこの定義は、埋め込む側に責任を返す。**ゲストが返してきた値は、たとえサンドボックスが完全に機能していても、信用してはならない**。悪意あるゲストは仕様どおりに動きながら嘘の値を返せるのだから、これは当然のことでもある。

## ブラウザの外へ

Wasm の初期の動機はブラウザにあったが、上の 5 性質はブラウザと何の関係もない。「知らないコードを安全に走らせる」という要求は、CDN のエッジでも、データベースのユーザ定義関数でも、プラグイン機構でも、サーバレス基盤でも同じように生じる。

そこで問題になるのが「では import として何を渡すのか」だ。ブラウザなら JavaScript の世界が全部そこにあるが、スタンドアロンの実行系にはそれがない。ファイルを読む標準的な手段も、時刻を得る手段も、Wasm 自体は定義していない。

その空白を埋めるのが WASI で、Wasmtime はその参照実装でもある。

## この章の立ち位置

以上が、Wasmtime が実装している「何」の側だ。ここから先は「どう」の側に降りていく。

- 命令セットとしての Wasm の具体的な形 — バイナリのセクション構成、型システム、スタックマシン、線形メモリ、テーブル ([Wasm バイナリは 12 のセクションでできている](../binary-format/) 以降)
- その形を機械語に落とす仕事 ([Wasm バイナリから実行可能コードまでの 5 段階](../compile-pipeline/) 以降)
- サンドボックスを実際に守り切る仕事 ([VMContext — JIT コードが固定オフセットで触る構造体](../vmcontext/) 以降)
- import として OS の機能を貸し出す仕事 ([wasi:cli の world と、WasiCtx の切り方](../wasi-worlds/) 以降)
