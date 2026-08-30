---
title: "Module::deserialize はなぜ unsafe なのか"
description: "事前コンパイル済みの .cwasm を読み込む関数は unsafe である。ドキュメントは「任意の入力を渡せば自明に任意コード実行に使える」と率直に書いている。それでいて同時に「どのバージョンの Wasmtime が出力したものでも、決定論的かつ安全に Err を返す」と保証する。この 2 つが同時に成り立つ理由と、その保証がキャッシュ設計に効いていることを読む。"
group: "AOT とキャッシュ"
sidebar:
  order: 66
---

`Module::deserialize` は `unsafe fn` である。呼び出すには `unsafe` ブロックが要る。

その理由がドキュメントに書かれているのだが、Rust の `unsafe` の説明としては珍しく率直な部類に入る。

```rust title="crates/wasmtime/src/runtime/module.rs"
    /// # Unsafety
    ///
    /// This function is marked as `unsafe` because if fed invalid input or used
    /// improperly this could lead to memory safety vulnerabilities. This method
    /// should not, for example, be exposed to arbitrary user input.
    ///
    /// The structure of the binary blob read here is only lightly validated
    /// internally in `wasmtime`. This is intended to be an efficient
    /// "rehydration" for a [`Module`] which has very few runtime checks beyond
    /// deserialization. Arbitrary input could, for example, replace valid
    /// compiled code with any other valid compiled code, meaning that this can
    /// trivially be used to execute arbitrary code otherwise.
```

[crates/wasmtime/src/runtime/module.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/module.rs)

**「有効なコンパイル済みコードを、別の有効なコンパイル済みコードで置き換えられる。つまりこれは自明に任意コード実行に使える」。**

考えてみれば当たり前だ。この関数がやっているのは、ELF の `.text` セクションを mmap して実行可能にすることである。そのバイト列が Wasmtime の生成した機械語か、攻撃者の書いたシェルコードかを、Wasmtime は区別できない。`.cwasm` は wasm バイナリではなく**すでに機械語**なので、検証すべき Wasm のセマンティクスがそこにはもう残っていない。

ここに、[なぜ WebAssembly が生まれたのか](../why-wasm/) で見たサンドボックスの境界がはっきり現れる。Wasm バイナリは信用しなくてよい。検証してコンパイルすれば、その出力は安全になる。しかし**コンパイル済みの出力そのものは、もはや信用の対象**であって、検証の対象ではない。

## それでも保証されていること

同じドキュメントが、続けて別のことを保証している。

```rust title="crates/wasmtime/src/runtime/module.rs"
    /// Note that this function is designed to be safe receiving output from
    /// *any* compiled version of `wasmtime` itself. This means that it is safe
    /// to feed output from older versions of Wasmtime into this function, in
    /// addition to newer versions of wasmtime (from the future!). These inputs
    /// will deterministically and safely produce an `Err`. This function only
    /// successfully accepts inputs from the same version of `wasmtime`, but the
    /// safety guarantee only applies to externally-defined blobs of bytes, not
    /// those defined by any version of wasmtime. (this means that if you cache
    /// blobs across versions of wasmtime you can be safely guaranteed that
    /// future versions of wasmtime will reject old cache entries).
```

「任意の入力を渡せば任意コード実行になる」と書いた直後に、「**どのバージョンの Wasmtime の出力を渡しても、安全に `Err` を返す**」と書いている。矛盾しているように読めるが、そうではない。保証の対象が違う。

保証が及ぶのは「**Wasmtime のいずれかのバージョンが生成したバイト列**」に対してだけだ。未来のバージョンが吐いた `.cwasm` を渡しても、古いバージョンのものを渡しても、決定論的に `Err` になる。攻撃者が任意に組み立てたバイト列は、この保証の外側にある。

## なぜその区別に意味があるのか

この分け方は、実用上の要求から来ている。**キャッシュをバージョンをまたいで保持しても安全だ**、と言えるようにするためだ。

コンパイルキャッシュ ([コンパイルキャッシュのキーに何を入れるか](../compile-cache/)) は、ディスク上にファイルを溜め続ける。Wasmtime をアップグレードしたとき、古いエントリはどうなるか。全部消すのが安全だが、そのためには「古いエントリを識別して消す」処理が要る。そして消し忘れは起きる。

かわりに「古いエントリを読もうとしても必ず `Err` になる」ことを保証しておけば、消し忘れは性能の問題（キャッシュミス）に落ちる。実際、キャッシュ層は `deserialize` に失敗したら黙って再コンパイルに落ちる実装になっている。**この保証があるから、その割り切りが成立する。**

同じことが AOT のデプロイにも効く。`wasmtime compile` した成果物を配布していて、実行側の Wasmtime だけ先にアップグレードされてしまった、という状況で、壊れた実行ではなくエラーになる。

## 保証を成り立たせている仕組み

「未来のバージョンの出力でも安全に拒否できる」ためには、フォーマットの**最初のバイトから前方互換な形**でなければならない。中身の構造が変わっても、バージョンを読む部分だけは未来にわたって同じ位置にある必要がある。

だから `.wasmtime.engine` セクションが、あの形をしている ([.cwasm は ELF そのものである](../cwasm/))。

```text
1. バージョンバイト（現在 0）
2. 次のフィールドの長さを示す 1 バイト
3. その長さのバージョン文字列
4. postcard で符号化した Metadata
```

先頭 1 バイトと、続く長さ付き文字列だけで、「これは Wasmtime のどのバージョンのものか」が分かる。ここが一致しない限り、postcard のデコードには進まない。`Metadata` の構造が将来変わっても、この判定は影響を受けない。

さらにその手前に ELF ヘッダの検査がある。`os_abi` が 200 でなければ、そもそも Wasmtime の成果物ではない。`e_flags` がモジュールを示していなければ、コンポーネントをモジュールとして読もうとしている。

```rust title="crates/wasmtime/src/engine/serialization.rs"
    // Parse the input `mmap` as an ELF file and see if the header matches the
    // Wasmtime-generated header. This includes a Wasmtime-specific `os_abi` and
    // the `e_flags` field should indicate whether `expected` matches or not.
    //
    // Note that errors generated here could mean that a precompiled module was
    // loaded as a component, or vice versa, both of which aren't supposed to
    // work.
```

そして、この入口を通ってしまえば防御は薄くなる。同じファイルの冒頭コメントが認めているとおり、「ここを通れば、これはこの Wasmtime のためのものだと仮定するので、以降のエラーメッセージは概してずっと悪い」。**厚い検査を入口の 1 か所に集中させ、その内側は速度を取る**、という設計になっている。

## ファイルから読むときのもう 1 つの unsafe

`Module::deserialize_file` 系には、バイト列版にはない `unsafe` の理由が追加されている。

```rust title="crates/wasmtime/src/runtime/module.rs"
    /// Additionally though this function is also `unsafe` because the file
    /// referenced must remain unchanged and a valid precompiled module for the
    /// entire lifetime of the [`Module`] returned. Any changes to the file on
    /// disk may change future instantiations of the module to be incorrect.
    /// This is because the file is mapped into memory and lazily loaded pages
    /// reflect the current state of the file, not necessarily the original
    /// state of the file.
```

`.cwasm` はファイルとして mmap され、ページは必要になったときに読み込まれる ([.cwasm は ELF そのものである](../cwasm/) で見た `.name.wasm` の遅延ロードは、この性質を積極的に使ったものだ)。裏返せば、**`Module` が生きている間にファイルを書き換えると、まだ読み込まれていない部分が別の内容になる**。

これは「読み込み時に検証すれば済む」種類の問題ではない。検証した後にファイルが変わりうるからだ。だから API の契約として、呼び出し側に「このファイルを触るな」という責任を負わせている。

## どう活かすか

このドキュメントの書き方から取れるものが 2 つある。

1 つは、**`unsafe` の理由を「メモリ安全でない可能性がある」で済ませていない**こと。何を渡すと何が起きるかを、攻撃者視点の具体例（有効なコードを別の有効なコードに差し替えられる）で書いている。呼び出す側が「自分のケースは安全か」を判断できるのは、この粒度で書かれているときだけだ。

もう 1 つは、**保証の範囲を明示的に区切っていること**。「安全ではない」と「この条件下では安全である」を同じドキュメントに並べて書き、後者が何のために必要か（バージョンをまたぐキャッシュ）まで書いている。安全性の議論は往々にして全か無かになりがちだが、実際に必要なのは「どの入力集合に対してどこまで保証するか」の線引きのほうだ。
