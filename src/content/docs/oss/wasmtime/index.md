---
title: "Wasmtime"
description: "WebAssembly のバイナリを受け取り、検証し、機械語に落とし、サンドボックスの内側で走らせる。その全工程を持っているランタイム。この章では Wasm という命令セットの基礎から、Cranelift によるコード生成、VMContext とトラップ処理、Component Model、そして WASI までを、一本の線として読む。"
oss:
  repo: https://github.com/bytecodealliance/wasmtime
  language: Rust
  ref: d8a0da6d661605713798c1c9c76be5c28e3159ff
sidebar:
  label: 概要
  order: 0
---

`wasmtime run hello.wasm` と打つと、数ミリ秒後に「Hello, world!」が出る。この間に起きていることは、実はかなり長い。

バイト列がパースされ、型検査され、関数ごとに並列でコンパイラに渡され、Cranelift の中間表現になり、e-graph で最適化され、ISLE の規則で機械語に落ち、ELF に詰められ、mmap されて実行可能になる。その機械語が触るメモリは `mmap` で 8GiB 予約された領域の先頭 64KiB だけで、その外に一歩でも出れば SIGSEGV が飛び、シグナルハンドラが「これは wasm のトラップだ」と判定して、ucontext のプログラムカウンタを書き換えて呼び出し元へ戻す。ファイルを開こうとすれば、それは WASI のホスト関数呼び出しになり、事前に preopen されたディレクトリの外は原理的に見えない。

```mermaid
flowchart LR
    W["hello.wasm<br/>バイト列"]
    V["wasmparser<br/>パース + 検証"]
    E["wasmtime-environ<br/>モジュールの構造"]
    C["Cranelift<br/>CLIF → 最適化 → 機械語"]
    O["ELF オブジェクト<br/>.text + trap 表 + stack map"]
    M["mmap → RX<br/>CodeMemory"]
    I["Instance<br/>VMContext + 線形メモリ"]
    R["実行"]
    W --> V --> E --> C --> O --> M --> I --> R
```

この章の目的は、**この経路を 1 本の線として最後まで追えるようにすること**だ。

Wasmtime は「Wasm ランタイム」と一言で呼ばれるが、中身は少なくとも 4 つの独立した仕事の集まりになっている。**命令セットの仕様を実装すること**、**最適化コンパイラを持つこと**、**サンドボックスを実際に守り切ること**、そして **OS の機能をケイパビリティとして貸し出すこと**。この章も、その 4 つを順に降りていく構成にした。

## この OSS について

- Apache 2.0 (LLVM 例外付き)。Rust で約 78 万行。Bytecode Alliance のプロジェクトで、Wasm の仕様策定と実装が同じ場所で回っている数少ないランタイム。
- **コンパイラを自前で持っている。** Cranelift は Wasmtime のためだけに存在するわけではないが、同じリポジトリの中にあり、同じ CI で回り、同じ fuzzing に晒される。LLVM を使わない理由が `cranelift/docs/compare-llvm.md` に書かれていて、要点は「IR を 1 段しか持たないことでコンパイルを速くする」「アセンブラを提供しないのでコード生成器が出す命令だけ表現できればよい」。生成コードは V8 (TurboFan) より約 2% 遅く、LLVM ベースの WAVM より約 14% 遅い代わりに、コンパイルは約 1 桁速い。
- **命令選択が DSL で書かれている。** ISLE という項書き換え言語があり、`lower.isle` に書かれた規則が Rust の決定木にコンパイルされる。同じ ISLE がミッドエンドの最適化規則にも使われ、さらに一部のバックエンドには形式検証用の仕様注釈まで付いている。
- **ミッドエンドが e-graph になっている。** ただし教科書的な e-graph ではなく「有向 (acyclic) な ægraph」で、規則の書き方に「右辺は左辺以上に良くなければならない」「交換則を書くな」という掟がある。爆発を止めるための上限が全部小さなハードコード定数 (`MATCHES_LIMIT = 5`、`EXTRACTOR_FUEL = 500`) なのも特徴的だ。
- **コンパイラが 3 つある。** 最適化コンパイラの Cranelift、単一パスのベースラインコンパイラ Winch、そして Cranelift が対応していないアーキテクチャ向けのポータブルインタプリタ Pulley。しかも Pulley は「インタプリタ」ではなく **Cranelift のターゲット ISA** として実装されていて、x64 と同じ ISLE の命令選択を通る。
- **JIT コードが触る構造体のレイアウトが、マクロ 1 箇所で定義されている。** `for_each_vm_type!` と `for_each_vmctx_type!` から、ランタイム側の Rust の型と、コンパイラ側のオフセット計算と、Cranelift のエイリアス領域が全部生成される。フィールドの並び順にも理由があり、メモリ関連を先頭に置くのは「x64 や Pulley でロード/ストアのオフセット即値を 8bit に収めるため」。
- **トラップの巻き戻しに setjmp/longjmp を使わない。** シグナルハンドラの中で ucontext のプログラムカウンタとスタックポインタを直接書き換え、wasm へのエントリトランポリンに置いた例外ハンドラへ飛ばす。そして「トラップしうる場所として登録されていない PC でフォルトしたら、それは Cranelift のバグなので握り潰さずプロセスを落とす」という判断が明記されている。
- **セキュリティ脆弱性の定義が明文化されている。** サンドボックス脱出は常に脆弱性、ホスト側のメモリ安全性違反も常に脆弱性。一方で「wasm のセマンティクスから逸脱して誤った値を計算する」のは、サンドボックスの内側に留まる限り脆弱性ではない。その帰結として「埋め込み側はゲストの計算結果を絶対に信用するな」と警告が付く。
- **strict provenance を守れないことを文書化して諦めている。** Cranelift IR にポインタ型がなく、wasm のロードが「ホスト基底 + wasm アドレス」の加算でオペランドを可換に入れ替えられるため。exposed provenance を選び、CHERI とは非互換だと明言している。
- **Component Model の融合アダプタを、Cranelift ではなく wasm で生成する。** 理由の第一が性能ではなく安全性で、「unsafe の大半が Cranelift にあるので、そこに頼らずに済ませればバグ種を丸ごと減らせる」。生成されたアダプタ自身もサンドボックスの中で動くので、最悪でも論理バグで済む。
- **WASI の既定はすべて閉じている。** stdin は closed、stdout/stderr は捨てる、環境変数なし、引数なし、preopen なし、TCP/UDP は「許可されているが全アドレス拒否」、名前解決は拒否。`--dir=.` を書かなければカレントディレクトリも見えない。

## 読む順番

WebAssembly という命令セットそのものに馴染みがない場合は、**「WebAssembly をゼロから」の 10 ページを 1 から順に読んでほしい**。後の群はここの語彙 (線形メモリ、funcref、rec group、preopen) を前提にする。Wasm の仕様を知っている場合は、9 ページ目の proposal の地図と 10 ページ目の WASI だけ眺めて次へ進んでよい。

「wasmtime のかたち」は全体像の導入なので、ここも前から読むのがよい。それ以降の群は概ね独立しているが、いくつか依存がある。「サンドボックスを守るコード生成」は「Cranelift」を、「トラップと巻き戻し」は「実行時の表現」を、「WASI」は「Component Model」を先に読むと速い。

コンパイラの中身に興味がなく、ランタイムの仕組みと WASI だけ知りたい場合は、群 4「Cranelift」を飛ばして群 5 へ進んでも読める。その場合は群 4 の最初の 1 ページ (Wasm → CLIF) だけ読んでおくとよい。

WebAssembly をゼロから:

- [なぜ WebAssembly が生まれたのか](./why-wasm/)
- [Wasm バイナリは 12 のセクションでできている](./binary-format/)
- [型システム — 4 つの独立した型階層](./type-system/)
- [スタックマシンと構造化制御構文](./stack-machine/)
- [線形メモリ — ポインタがオフセットになるということ](./linear-memory-semantics/)
- [テーブルと間接呼び出し](./tables-and-call-indirect/)
- [検証が保証してくれる 6 つのこと](./validation/)
- [モジュール・インスタンス・ストア](./module-instance-store/)
- [proposal の地図 — Wasm は今も動いている](./proposals/)
- [WASI とは何か — 権限ではなく能力を渡す](./what-wasi-is/)

wasmtime のかたち:

- [アーキテクチャを一枚で読む](./architecture/)
- [Engine・Store・Module・Instance の役割分担](./engine-store-module-instance/)
- [Store が 5 つの型に割れている理由](./store-five-types/)
- [Func は 2 ワードしかない](./func-two-words/)
- [型を静的に固定して、呼び出しを速くする](./typed-func/)
- [Linker と、インスタンス化の「後戻りできない点」](./linker-and-instantiation/)

コンパイルパイプライン:

- [Wasm バイナリから実行可能コードまでの 5 段階](./compile-pipeline/)
- [パースと検証をインターリーブし、関数本体だけ遅延する](./interleaved-validation/)
- [コンパイル対象は「関数」だけではない](./compile-inputs/)
- [並列コンパイルのエラーを、わざと非効率にして決定論にする](./parallel-determinism/)
- [モジュールを跨いでインライン化し、呼び出しグラフを層に切る](./inlining-strata/)

Cranelift — Wasm を機械語にする:

- [スタックマシンから SSA へ — 値スタックと制御スタック](./wasm-to-clif/)
- [Wasm のブロック引数を、CLIF のブロック引数にしない](./block-params-not-phi/)
- [SIMD で bitcast を撒く羽目になった話](./simd-bitcast/)
- [CLIF の設計 — データフローと並び順を分ける](./clif-design/)
- [SSA をその場で構築する](./ssa-construction/)
- [ægraph — 非循環な e-graph という選択](./egraph/)
- [書き換え規則の掟 4 か条と、爆発を止める 4 つの上限](./egraph-rules/)
- [ISLE — 命令選択を DSL で書く](./isle/)
- [逆順 1 スキャンの lowering と、MachBuffer の island](./lowering-and-machbuffer/)
- [なぜ Cranelift は LLVM を使わないのか](./why-not-llvm/)

サンドボックスを守るコード生成:

- [境界チェックを「消す」ための条件を数式で追う](./bounds-check-elision/)
- [Spectre 緩和は、トラップではなくアドレスの潰し込み](./spectre/)
- [call_indirect の型チェックが整数比較 1 回になるまで](./call-indirect-typecheck/)
- [スタックオーバーフローは、ガードページではなく明示チェック](./stack-limit/)
- [libcall はトランポリンと sentinel 返り値で呼ぶ](./libcall-trampoline/)

実行時の表現:

- [VMContext — JIT コードが固定オフセットで触る構造体](./vmcontext/)
- [レイアウトの単一定義源をマクロで作る](./layout-macro/)
- [VMFuncRef と、wasm_call が Option である理由](./vmfuncref/)
- [array-call ABI — 全関数が同じ Rust シグネチャになる](./array-call-abi/)
- [インスタンスアロケータ — 毎回 mmap するか、スロットを貸すか](./instance-allocator/)
- [メモリ保護キーでガード領域を削る](./mpk/)

線形メモリの実装:

- [4GiB 予約と 32MiB ガードの配置](./memory-layout/)
- [1 回の mmap で確保し、mprotect で伸ばす](./memory-grow/)
- [copy-on-write でインスタンス化を速くする](./cow-instantiation/)
- [スロットの状態機械と、madvise が元の CoW を復元すること](./memory-image-slot/)

トラップと巻き戻し:

- [wasm のトラップはシグナルで実現される](./traps-via-signals/)
- [「これは wasm 由来のフォルトか」を 3 段階で判定する](./is-this-wasm/)
- [longjmp を使わず、ucontext を書き換えて戻る](./unwind-via-ucontext/)
- [CallThreadState — スタック上に置くアクティベーションの連結リスト](./call-thread-state/)
- [バックトレースの作り方と、macOS・Windows の事情](./backtrace-and-platforms/)

中断・非同期・GC:

- [fuel — 決定的だが高価な割り込み](./fuel/)
- [epoch — なぜ関数の入口にもチェックが要るのか](./epoch/)
- [async に fiber が要る理由](./why-fiber/)
- [fiber を切り替えるとき、何を save/restore するのか](./fiber-state-swap/)
- [VMGcRef はポインタではない](./vmgcref/)
- [DRC — 「遅延」参照カウントとは何か](./drc/)
- [型のライフタイムを、再帰グループ単位の参照カウントで管理する](./type-registry/)

もう 2 つの実行器:

- [Winch — 単一パスで、見れば分かるコードを吐く](./winch/)
- [値を最後まで実体化しない](./winch-lazy-values/)
- [Pulley — JIT できない場所のためのバイトコード VM](./pulley/)
- [Pulley は「インタプリタ」ではなくターゲット ISA である](./pulley-as-isa/)

AOT とキャッシュ:

- [.cwasm は ELF そのものである](./cwasm/)
- [Tunables を全フィールド分割代入して、互換性の判断漏れを防ぐ](./tunables-compat/)
- [コンパイルキャッシュのキーに何を入れるか](./compile-cache/)
- [Module::deserialize はなぜ unsafe なのか](./deserialize-unsafe/)

Component Model:

- [core module だけでは足りない理由](./why-component/)
- [WIT を読む — world・interface・resource](./wit/)
- [Canonical ABI — 16 個までは引数、それ以上はメモリ](./canonical-abi-flatten/)
- [lifting と lowering、realloc と post-return](./lifting-lowering/)
- [文字列の 3 エンコーディングと latin1 の膨張処理](./strings/)
- [own は貸出中に消せない、borrow は scope に縛られる](./resources/)
- [component のコンパイルは 4 段階](./component-pipeline/)
- [FACT — 融合アダプタを wasm で生成するという判断](./fact/)

WASI:

- [wasi:cli の world と、WasiCtx の切り方](./wasi-worlds/)
- [既定はすべて閉じる — WasiCtxBuilder と cap-std](./capability-defaults/)
- [なぜ wasi:io だけが別クレートなのか](./wasi-io/)
- [pollable は Future ではない](./pollable/)
- [permit モデル — check-write してから write する](./permit-model/)
- [Preview 1 を Preview 2 の上に再実装する](./preview1/)
- [libc もアロケータもパニックもない wasm を書く](./preview1-adapter/)
- [wasmtime serve — epoch で止めず、yield で逃がす](./wasmtime-serve/)
- [WASI 0.3 で wasi:io が消える](./wasi-03/)

## この章で扱わないこと

- **regalloc2 の内部** — レジスタ割り当ての本体は別リポジトリの `regalloc2` にある。Cranelift 側から見たインターフェース (`VCode` が `regalloc2::Function` を実装し、`Output` が返るだけで VCode は書き換えられない) までを扱う。
- **wasmparser / wasm-tools の内部** — パースと検証の本体は `bytecodealliance/wasm-tools` にある。Wasmtime がそれをどう呼び、何を保証されているかまでを扱う。
- **x86_64 以外の ISA バックエンド固有の実装** — aarch64 / riscv64 / s390x の `lower.isle`。アーキ差が設計を規定した箇所だけ、本文中で対比として触れる。
- **デバッグ機構** — DWARF の変換、gdb/lldb 連携、コアダンプ、`wasmtime explore`。
- **wasi-nn / wasi-config / wasi-keyvalue / wasi-tls** — 標準化の途中にある個別の world 群。`wasi:io` の上にどう乗るかの構造は `wasi:http` で代表させる。
- **他言語バインディング** — C API、Python、Go、.NET。埋め込み API の設計は Rust の側から読む。
