---
title: "WASI とは何か — 権限ではなく能力を渡す"
description: "Wasm はシステムコールを持たないので、ファイルも時刻もネットワークも import として渡されなければ触れない。その import の標準が WASI である。WASI がケイパビリティベースであるとはどういうことか、そしてそれが「`--dir=.` を書かないとカレントディレクトリのファイルすら開けない」という非直感的な帰結として現れることを、チュートリアルと `WasiCtx` の既定値から確認する。"
group: "WebAssembly をゼロから"
sidebar:
  order: 10
---

Wasm には `syscall` 命令がない。ファイルを開く命令も、時刻を取る命令も、ソケットを作る命令もない。**外界と関わる唯一の手段が import である**ことは、[なぜ WebAssembly が生まれたのか](../why-wasm/) で見た 5 性質の 4 番目そのものだ。

すると当然「では何を import すればいいのか」が問題になる。ブラウザなら答えは JavaScript の世界全部だが、スタンドアロンの実行系にはそれがない。この空白を埋める標準が WASI で、Wasmtime はその参照実装でもある。

このページは WASI の思想の話に絞る。API の具体は [wasi:cli の world と、WasiCtx の切り方](../wasi-worlds/) と [既定はすべて閉じる — WasiCtxBuilder と cap-std](../capability-defaults/) に譲る。

## 権限と能力の違い

普通の OS では、ファイルを開くのはこういう手順だ。プロセスがパス名を渡して `open("/etc/passwd")` を呼ぶ。カーネルがそのプロセスの実行ユーザを見て、ファイルのパーミッションと突き合わせ、許すか拒むかを決める。

ここでプロセスは **何も持っていない状態からパス名だけを頼りにファイルへ到達している**。この「持っていなくても名前で到達できる力」を**アンビエント権限 (ambient authority)** と呼ぶ。プロセスは自分が何を開けるのかを知らないし、開ける範囲は実行ユーザの権限という「周囲の文脈」で決まる。

ケイパビリティモデルはこれをひっくり返す。**能力 (capability) とは、それ自体が権限を含んだ、譲渡可能なオブジェクトである。** ファイルディスクリプタがまさにそれだ。fd を持っていれば読めるし、持っていなければ読めない。fd 番号を推測しても、渡されていない fd は存在しない。

WASI は「ファイルディスクリプタは能力である」という性質だけを残し、**アンビエント権限を丸ごと取り除いた**。パス名から新しいファイルを開くことはできず、**すでに持っているディレクトリの能力からの相対パスでしか開けない**。

## `--dir=.` を書かないと、カレントディレクトリも見えない

この設計の帰結は、初見だと理不尽に感じる。Wasmtime のチュートリアルがそれを実演している。

```text title="docs/WASI-tutorial.md"
$ echo hello world > test.txt
$ wasmtime demo.wasm test.txt /tmp/somewhere.txt
error opening input test.txt: No such file or directory
```

```text title="docs/WASI-tutorial.md"
Aha, now we're seeing the sandboxing in action. This program is attempting to
access a file by the name of `test.txt`, however it hasn't been given the
capability to do so.
```

[docs/WASI-tutorial.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/docs/WASI-tutorial.md)

`test.txt` は目の前にあり、`wasmtime` を起動したユーザには読む権限がある。それでも開けない。**プログラムがカレントディレクトリの能力を渡されていないから**だ。

```text title="docs/WASI-tutorial.md"
$ wasmtime --dir=. --dir=/tmp demo.wasm test.txt /tmp/somewhere.txt
$ cat /tmp/somewhere.txt
hello world
```

`--dir=` が「ディレクトリを preopen して、その中のファイルを開くための能力としてプログラムに渡す」オプションだ。

さらに面白いのが、絶対パスでは指定できないことだ。

```text title="docs/WASI-tutorial.md"
$ wasmtime --dir=$PWD --dir=/tmp demo.wasm test.txt /tmp/somewhere.txt
error opening input test.txt: No such file or directory
```

```text title="docs/WASI-tutorial.md"
As a brief aside, note that we used the path `.` above to grant the program
access to the current directory. This is needed because the mapping from
paths to associated capabilities is performed by libc, so it's part of the
WebAssembly program, and we don't expose the actual current working
directory to the WebAssembly program.
```

**パス名から能力への対応付けを行っているのは libc であり、それは wasm プログラムの一部である。** ホスト側は「カレントディレクトリの実際のパス」をゲストに教えない。だから `--dir=$PWD` で渡すと、ゲスト内では `/home/user/project` という名前の preopen になり、プログラムが渡した `test.txt` という相対パスはどの preopen にも一致しない。

これは実装の不備ではなく、**ホストのファイルシステムの形そのものが情報漏洩になりうる**という判断だ。パスを見せなければ、そこから何も推測できない。

## `..` もシンボリックリンクも抜けられない

能力ベースであることは、ディレクトリを渡したら「そのディレクトリの下だけ」に閉じることを意味する。

```text title="docs/WASI-tutorial.md"
$ wasmtime --dir=. --dir=/tmp demo.wasm test.txt /tmp/../etc/passwd
error opening output /tmp/../etc/passwd: Operation not permitted
```

```text title="docs/WASI-tutorial.md"
The sandbox says no. And note that this is the capabilities system saying no
here ("Operation not permitted"), rather than Unix access controls
("Permission denied"). Even if the user running `wasmtime` had write access to
`/etc/passwd`, WASI programs don't have the capability to access files outside
of the directories they've been granted. This is true when resolving symbolic
links as well.
```

エラーメッセージの違いにわざわざ言及しているのがいい。**"Operation not permitted" と "Permission denied" は違う**。前者はケイパビリティシステムが「その能力を持っていない」と言っていて、後者は Unix の権限チェックが「許可されていない」と言っている。`wasmtime` を root で走らせても前者は変わらない。

そして「シンボリックリンクの解決についても同様」。これが実装として簡単でないことは容易に想像がつく。パスを 1 要素ずつ辿りながら、各段階でシンボリックリンクを解決し、preopen の外に出ないことを保証しなければならない。TOCTOU (検査と使用の間の競合) も避ける必要がある。Wasmtime はこれを自前で書かず、`cap-std` という別のライブラリに任せている。

```rust title="crates/wasi/src/ctx.rs"
pub fn preopened_dir(
    &mut self,
    host_path: impl AsRef<Path>,
    guest_path: impl AsRef<str>,
    perms: FsPerms,
) -> Result<&mut Self> {
    let dir = cap_primitives::fs::open_ambient_dir(host_path.as_ref(), ambient_authority())?;
    let open_mode = match perms {
        FsPerms::ReadOnly => OpenMode::READ,
        FsPerms::ReadWrite => OpenMode::READ | OpenMode::WRITE,
    };
    self.filesystem.preopens.push((
        Dir::new(
            dir,
            perms,
            open_mode,
            self.filesystem.allow_blocking_current_thread,
        ),
        guest_path.as_ref().to_owned(),
    ));
    Ok(self)
}
```

[crates/wasi/src/ctx.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/ctx.rs#L297-L318)

**preopen の実体は「`cap_primitives` で開いたディレクトリ + ゲスト側での名前」の組**でしかない。そして関数名が `open_ambient_dir` で、引数に `ambient_authority()` を渡していることに注目したい。`cap-std` は「アンビエント権限を使う操作」を、そういう名前の関数と、そういう名前のトークンを要求することで**明示的にマークする**設計になっている。ホスト側でアンビエント権限を使うのは preopen を作るこの 1 回だけで、それ以降ゲストに渡るのは `Dir` という能力オブジェクトだけになる。

`FsPerms` によって能力そのものが読み取り専用になりうることも重要だ。**能力は「何ができるか」を含んで渡される。**

## 既定はすべて閉じている

`WasiCtxBuilder` の doc が、何も設定しなかったときの状態を列挙している。

```rust title="crates/wasi/src/ctx.rs"
/// The current defaults are:
///
/// * stdin is closed
/// * stdout and stderr eat all input and it doesn't go anywhere
/// * no env vars
/// * no arguments
/// * no preopens
/// * clocks use the host implementation of wall/monotonic clocks
/// * RNGs are all initialized with random state and suitable generator
///   quality to satisfy the requirements of WASI APIs.
/// * TCP/UDP are allowed but all addresses are denied by default.
/// * `wasi:sockets/ip-name-lookup` is denied by default.
```

[crates/wasi/src/ctx.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/ctx.rs#L48-L61)

**標準入力すら閉じている。** 標準出力は「全部食べてどこにも行かない」。環境変数もコマンドライン引数も preopen も空。

ネットワークの行が特に示唆的だ。「TCP/UDP は**許可されているが、すべてのアドレスが拒否される**」。API としてのソケットは存在し、`socket()` に相当する操作は成功する。だが接続しようとすると、どのアドレスも許可リストにないので失敗する。能力の粒度が「ソケットを作る能力」と「特定のアドレスへ接続する能力」に分かれている、ということだ。

時刻と乱数だけが既定で本物のホスト実装になっている。この 2 つは「情報を取り出す」ものではなく、しかも乱数はゲストが自分の安全性のために必要とするからだ。doc も「ゲストのコードは、自分のセキュリティ不変条件を保つために、この乱数生成器が新鮮で予測不可能なデータを出すことに頼るかもしれない」と書いている。

## 不便さは仕様である

ケイパビリティモデルの体験は、正直に言って不便だ。`wasmtime run app.wasm` と打つと何も読めない。`--dir` を毎回書く必要がある。環境変数も引数も明示的に渡さないと届かない。

だがこの不便さは、**「渡していないものは触れない」という保証と同じもの**である。もし既定でカレントディレクトリが見えたら、それは既定でアンビエント権限があるということで、モデル全体が崩れる。

そしてこの設計が効くのは、実行する側がプログラムを信用していない場面だ。CDN のエッジで他人のコードを走らせる、データベースでユーザ定義関数を実行する、プラグインを読み込む。そういう場面では **「デフォルトで何も渡さない」以外の初期値は全部危険**になる。

[docs/security.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/docs/security.md) の WASI に関する記述は短いが、狙いを言い切っている。

```text title="docs/security.md"
Wasmtime implements the WASI APIs for filesystem access, which follow a
capability-based security model, which ensures that applications can only
access files and directories they've been given access to. WASI's security
model keeps users safe today, and also helps us prepare for shared-nothing
linking and nanoprocesses in the future.
```

**「shared-nothing linking と nanoprocess の準備でもある」**という後半が、この設計の射程を示している。能力しか渡らないなら、コンポーネント同士を繋いだときも、繋いだ相手に渡した能力だけが共有される。プロセス分離より細かい粒度で、しかも OS の助けなしに、モジュール間の境界を引ける。これが Component Model の前提になる ([core module だけでは足りない理由](../why-component/))。

## どう活かすか

ケイパビリティモデルの持ち帰りは、「名前で到達できるものを減らせ」に尽きる。

グローバルな設定から `getenv` で秘密鍵を読む代わりに、必要なオブジェクトをコンストラクタで受け取る。ファイルパスを文字列で受け取る代わりに、開いたディレクトリのハンドルを受け取る。**依存性注入と呼ばれている習慣は、実はケイパビリティモデルの弱い形だ。** 違いは強制力の有無で、WASI はそれを言語の意味論のレベルで強制している。

そして「既定値を安全側に倒す」設計は、`WasiCtxBuilder` のように**すべての既定値を 1 箇所に列挙して doc に書く**とレビューしやすくなる。何が閉じていて何が開いているかが一望できないと、既定値は少しずつ緩んでいく。

## この群のまとめ

ここまでの 10 ページで、Wasm という命令セットを一通り見た。バイナリのセクション構成、4 つの型階層、値スタックと構造化制御構文、線形メモリ、テーブルと間接呼び出し、検証、モジュール・インスタンス・ストア、proposal の広がり、そして WASI。

これ以降の 73 ページは、Wasmtime が**この仕様をどう実装しているか**の話になる。線形メモリの mmap レイアウト、境界チェックが消える条件、`VMSharedTypeIndex` の登録と参照カウント、`VMContext` のレイアウト、トラップのシグナル処理。すべてここで見た仕様上の性質に根拠を持っている。

次は Wasmtime 側の全体像から始める ([アーキテクチャを一枚で読む](../architecture/))。
