---
title: ".cwasm は ELF そのものである"
description: "Wasmtime の事前コンパイル成果物は、独自フォーマットではなく ELF ファイルとして作られる。ホスト OS が macOS でも Windows でも ELF で、Pulley 向けには riscv64 のふりまでする。os_abi に 200 を書き、e_flags で種別を伝え、.wasmtime.* というカスタムセクションにトラップ表やスタックマップを置く。そのレイアウトと、なぜ関数名だけ別セクションに切り出されているかを読む。"
group: "AOT とキャッシュ"
sidebar:
  order: 63
---

`wasmtime compile foo.wasm` を実行すると `foo.cwasm` ができる。これを `file` コマンドに食わせると、こう出る。

```console
$ file foo.cwasm
foo.cwasm: ELF 64-bit LSB relocatable, x86-64, version 1 (embedded)
```

**Wasmtime の事前コンパイル成果物は ELF ファイルである。** 独自のコンテナフォーマットを作っていない。しかも「ホストが ELF を使う OS だから」ではなく、**macOS でも Windows でも ELF を作る**。

## なぜ常に ELF なのか

`Compiler::object` がオブジェクトファイルを作る箇所を見ると、ターゲットに関係なく `BinaryFormat::Elf` を渡している。

```rust title="crates/environ/src/compile/mod.rs"
    fn object(&self, kind: ObjectKind) -> Result<Object<'static>> {
        use target_lexicon::Architecture::*;

        let triple = self.triple();
        let mut obj = Object::new(
            BinaryFormat::Elf,
            match triple.architecture {
                X86_32(_) => Architecture::I386,
                X86_64 => Architecture::X86_64,
                Aarch64(_) => Architecture::Aarch64,
                // ...
                // Pulley is 'pretend' riscv64 for the purposes of the `object`
                // crate. Yolo!
                Pulley32 | Pulley64 => Architecture::Riscv64,
                architecture => {
                    bail!("target architecture {:?} is unsupported", architecture,)
                }
            },
            Endianness::Little,
        );
```

[crates/environ/src/compile/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/compile/mod.rs)

ELF に統一する理由は、**このファイルが OS のローダに食わせるものではない**からだ。`.cwasm` を `dlopen` することはないし、リンカに通すこともない。Wasmtime 自身が読んで、`.text` セクションを mmap して実行可能にするだけだ。だとすれば、フォーマットはホスト OS の慣習に合わせる必要がなく、**1 つに決めてしまったほうが実装が減る**。

Pulley 向けの分岐に付いた `// Yolo!` は、Pulley のバイトコードが実在するどの CPU の命令でもないことに由来する。`object` クレートはアーキテクチャの列挙を要求するので、riscv64 だと嘘をついておいて、本当の種別は後述の `e_flags` で伝える。

## ELF ヘッダに Wasmtime の印を書く

普通の ELF と区別するために、ヘッダのフィールドを 2 つ使っている。

```rust title="crates/environ/src/obj.rs"
/// Filler for the `os_abi` field of the ELF header.
///
/// This is just a constant that seems reasonable in the sense it's unlikely to
/// clash with others.
pub const ELFOSABI_WASMTIME: object::elf::OsAbi = object::elf::OsAbi(200);

/// Flag for the `e_flags` field in the ELF header indicating a compiled
/// module.
pub const EF_WASMTIME_MODULE: object::elf::FileFlags = object::elf::FileFlags(1 << 0);

/// Flag for the `e_flags` field in the ELF header indicating a compiled
/// component.
pub const EF_WASMTIME_COMPONENT: object::elf::FileFlags = object::elf::FileFlags(1 << 1);

/// Flag for the `e_flags` field in the ELF header indicating compiled code for
/// pulley32
pub const EF_WASMTIME_PULLEY32: object::elf::FileFlags = object::elf::FileFlags(1 << 2);

/// Flag for the `e_flags` field in the ELF header indicating compiled code for
/// pulley64
pub const EF_WASMTIME_PULLEY64: object::elf::FileFlags = object::elf::FileFlags(1 << 3);
```

[crates/environ/src/obj.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/obj.rs)

`os_abi = 200` は「他とぶつからなさそうな適当な定数」だとコメントに書いてある。`e_flags` のほうは実用的で、**モジュールをコンポーネントとして読み込もうとした（あるいはその逆の）誤りを、中身を読む前に検出できる**。`check_compatible` がまずここを見る。

さらに `.text` セクションのフラグにも 1 つ拡張がある。

```rust title="crates/environ/src/obj.rs"
/// Flag for the `sh_flags` field in the ELF text section that indicates that
/// the text section does not itself need to be executable. This is used for the
/// Pulley target, for example, to indicate that it does not need to be made
/// natively executable as it does not contain actual native code.
pub const SH_WASMTIME_NOT_EXECUTED: object::elf::SectionFlags = object::elf::SectionFlags(1 << 0);
```

Pulley のバイトコードは CPU が実行するものではないので、`mprotect` で実行可能にする必要がない。このフラグが立っていればランタイムは `make_executable` を呼ばない。

## `.wasmtime.*` カスタムセクション

`.text` に機械語が入るのは普通の ELF と同じだが、Wasmtime は実行に必要な副次情報を独自セクションに分けている。

```text
ELF header       os_abi = 200, e_flags = EF_WASMTIME_MODULE
├── .text                     生成された機械語
├── .rodata.wasm              定数データ
├── .name.wasm                関数名の連結（あれば）
├── .wasmtime.addrmap         .text のオフセット → 元の wasm のオフセット
├── .wasmtime.traps           .text のオフセット → トラップの種類
├── .wasmtime.stackmap        .text のオフセット → 生きている GC 参照の位置
├── .wasmtime.exceptions      例外ハンドラの表
├── .wasmtime.info            bincode 符号化した CompiledModuleInfo
├── .wasmtime.engine          互換性メタデータ（後述）
└── .wasmtime.dwarf           変換済み DWARF（あれば）
```

このうち `.wasmtime.traps` と `.wasmtime.addrmap` と `.wasmtime.stackmap` は、実行時に「今フォルトした PC は何なのか」「今のフレームのどこに GC 参照があるか」を引くための索引で、それぞれ [「これは wasm 由来のフォルトか」を 3 段階で判定する](../is-this-wasm/) と [VMGcRef はポインタではない](../vmgcref/) で使われる。

### 関数名だけ別セクションに切り出す理由

面白いのは `.name.wasm` だ。関数名は `.wasmtime.info` に入れてもよさそうだが、わざわざ分けてある。

```rust title="crates/environ/src/obj.rs"
/// Note that the goal of this section is to avoid having to decode names at
/// module-load time if we can. Names are typically only used for debugging or
/// things like backtraces so there's no need to eagerly load all of them. By
/// storing the data in a separate section the hope is that the data, which is
/// sometimes quite large (3MB seen for spidermonkey-compiled-to-wasm), can be
/// paged in lazily from an mmap and is never paged in if we never reference it.
pub const ELF_NAME_DATA: &'static str = ".name.wasm";
```

**SpiderMonkey を wasm にコンパイルしたら名前データだけで 3MB あった**、という具体的な観測が設計理由として書かれている。`.cwasm` はファイルとして mmap されるので、参照されないページは物理メモリに載らない。名前をデバッグとバックトレースにしか使わないなら、載せないのが正しい。**セクションを分けることが、そのまま遅延ロードの単位を作ることになる**。

`.wasmtime.info` のほうにも似た配慮がある。`Module::new` のようにコンパイルからそのまま実行に入る経路では `CompiledModuleInfo` が既にメモリ上にあるので、このセクションは読まれない。デコードが必要なのは `Module::deserialize` の経路だけだ。

## `.wasmtime.engine` — 最初に読まれ、最も硬いセクション

互換性の判定に使うメタデータは専用セクションにある。そのフォーマットが、モジュールの冒頭コメントに書かれている。

```rust title="crates/wasmtime/src/engine/serialization.rs"
//! Wasmtime AOT artifacts are ELF files so the data for the engine here is
//! stored into a section of the output file. The structure of this section is:
//!
//! 1. A version byte, currently `VERSION`.
//! 2. A byte indicating how long the next field is.
//! 3. A version string of the length of the previous byte value.
//! 4. A `postcard`-encoded `Metadata` structure.
//!
//! This is hoped to help distinguish easily Wasmtime-based ELF files from
//! other random ELF files, as well as provide better error messages for
//! using wasmtime artifacts across versions.
```

[crates/wasmtime/src/engine/serialization.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/engine/serialization.rs)

「バージョンバイト → 長さ → バージョン文字列 → postcard」という順序は、**壊れた入力に対してできるだけ早く、できるだけ具体的なエラーを出す**ための並びだ。postcard で構造体をデコードする前に、まずバージョン文字列という人間が読める情報が取れる。

同じコメントの前半が、このセクションの位置づけを説明している。

```rust title="crates/wasmtime/src/engine/serialization.rs"
//! Additionally though this data is the first data read from a precompiled
//! artifact so it's "extra hardened" to provide reasonable-ish error messages
//! for mismatching wasmtime versions. Once something successfully deserializes
//! here it's assumed it's meant for this wasmtime so error messages are in
//! general much worse afterwards.
```

**ここを通ってしまえば「これはこの Wasmtime のためのものだ」と仮定するので、以降のエラーメッセージは概してずっと悪くなる。** 防御の厚みを入口に集中させ、その内側は薄くするという割り切りで、実際に何を照合するかは [Tunables を全フィールド分割代入して、互換性の判断漏れを防ぐ](../tunables-compat/) で見る。

## `Module::serialize` は何もしない

ここまで来ると、シリアライズの実装が拍子抜けするほど短い理由が分かる。

```rust title="crates/wasmtime/src/runtime/module.rs"
    pub fn serialize(&self) -> Result<Vec<u8>> {
        // ...
        Ok(self.compiled_module().code_memory().mmap().to_vec())
    }
```

コンパイル時点で既に ELF イメージができているので、**シリアライズは mmap されたバイト列をコピーして返すだけ**だ。逆に `Module::new` は「ELF を作って、それを自分で読み込む」という経路を通る。つまり AOT のパスは後付けの機能ではなく、**通常のコンパイル経路がそもそも AOT の形を経由している**。

ただし例外がある。コンポーネントから取り出したモジュールはシリアライズできない。その理由と、直すとしたら何をすればよいかまでコメントに書いてある。

```rust title="crates/wasmtime/src/runtime/module.rs"
        // ...
        // theoretically this could be implemented by editing the
        // `.wasmtime.info` section to be the metadata for this module instead
        // of the component. The metadata itself is relatively easy to
        // reconstruct. There's just no easy API to edit sections of an ELF
        // object at this time.
        // ...
        // if you're reading this and you feel the situation should be
        // different, feel free to open an issue.
```

## AOT で何が得られるのか

事前コンパイルの利点は 4 つある。

**起動が速い。** コンパイルがクリティカルパスから外れる。これが最も分かりやすい効果で、サーバレスのように「同じモジュールを何度も起動する」用途では決定的になる。

**メモリ使用量が減る。** `.cwasm` をファイルとして mmap すれば、実行されない関数のページは物理メモリに載らない。前述の `.name.wasm` の分離も同じ発想の延長にある。

**バイナリが小さくなる。** 実行専用のビルドからは `cranelift` / `winch` feature を落とせる。コンパイラを丸ごと外せるので、組み込み向けには大きい。

**攻撃面が減る。** コンパイルをコントロールプレーン、実行をデータプレーンとして別のビルドに分けられる。信用できない wasm バイナリを受け取ってコンパイルするプロセスと、コンパイル済みコードを実行するプロセスを分離できる。

4 つ目は特に、Wasmtime が「コンパイラ自身も攻撃対象になりうる」と考えていることの裏返しでもある ([なぜ Cranelift は LLVM を使わないのか](../why-not-llvm/))。ただしその分離は、`Module::deserialize` を安全に使えることが前提になる。そこには別の厄介さがあり、[Module::deserialize はなぜ unsafe なのか](../deserialize-unsafe/) で扱う。
