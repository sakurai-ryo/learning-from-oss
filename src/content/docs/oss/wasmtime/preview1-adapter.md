---
title: "libc もアロケータもパニックもない wasm を書く"
description: "preview1 の core module を preview2 の component に変換するアダプタは、それ自体が wasm モジュールとして書かれている。スタックサイズ 0、メモリは import、パニック機構なし、静的初期化子なしのため文字列リテラルすら持てない。State を main module の cabi_realloc から 1 ページ借り、その参照を wasm global に置くために build.rs がオブジェクトファイルと ar を手書きする。制約が極端になるとコードの書き方がどこまで変わるかを読む。"
group: "WASI"
sidebar:
  order: 81
---

[Preview 1 を Preview 2 の上に再実装する](../preview1/) で見たのは、ホスト側で p1 を p2 の上に実装する話だった。もうひとつ別の道がある。**preview1 を import している core module を、ビルド時に preview2 の component へ変換してしまう**というものだ。

```shell-session title="crates/wasi-preview1-component-adapter/README.md"
$ rustc foo.rs --target wasm32-wasip1
$ wasm-tools print foo.wasm | grep '(import'
  (import "wasi_snapshot_preview1" "fd_write" (func ...
  (import "wasi_snapshot_preview1" "environ_get" (func ...
$ wasm-tools component new foo.wasm --adapt wasi_snapshot_preview1.wasm -o component.wasm
```

[crates/wasi-preview1-component-adapter/README.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/README.md#L39-L59)

`--adapt` に渡している `wasi_snapshot_preview1.wasm` がアダプタで、README はこれを **「`wasi_snapshot_preview1` の ABI を component model の preview2 ABI へ橋渡しする WebAssembly モジュール」** と説明する。

**アダプタそれ自体が wasm モジュールとして書かれている。** ホストの Rust ではない。`wasm-tools component new` が元モジュールとアダプタを 1 つの component にリンクし、元モジュールの `wasi_snapshot_preview1` 系 import はアダプタの export に繋がる。アダプタは `wasi:cli/*` を import するので、外から見た結果は preview2 の component になる。

この「wasm として書かれている」という一点から、**この章で最も極端な制約下のコード**が生まれている。

## 3 つの変種

ビルドは 3 通りある。`reactor` が既定で、`command` と `proxy` がある。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
#[unsafe(export_name = "wasi:cli/run@0.2.12#run")]
#[cfg(feature = "command")]
pub extern "C" fn run() -> u32 {
    #[link(wasm_import_module = "__main_module__")]
    unsafe extern "C" {
        safe fn _start();
    }
    _start();
    0
}
```

[crates/wasi-preview1-component-adapter/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/lib.rs#L124-L134)

**`command` だけが `wasi:cli/run#run` を export し、その中身は `__main_module__` の `_start` を呼ぶだけ**だ。`__main_module__` は「変換される側のモジュール」を指す予約名で、リンク時に解決される。preview1 のコマンドは `_start` を export する形なので、それを preview2 の `run` に読み替えている。**世界の変換が関数 1 個の呼び出しに落ちている。**

`reactor` は `run` を持たず、変換だけを行う (import する world も `wasi:cli/imports` になる)。`proxy` は `wasi:http/proxy` 用に絞った版で、時計・乱数・標準入出力しか import しない。3 つは排他で、`compile_error!` で同時指定を禁じている。

## 制約の一覧

`Cargo.toml` と `build.rs` を見ると、この crate がどれだけ狭い場所に立っているかが分かる。

```toml title="crates/wasi-preview1-component-adapter/Cargo.toml"
[dependencies]
wasip1 = { workspace = true }
wit-bindgen-rust-macro = { workspace = true }
byte-array-literals = { workspace = true }
bitflags = { workspace = true }

[lib]
test = false
crate-type = ["cdylib"]
name = "wasi_snapshot_preview1"
doc = false
```

```rust title="crates/wasi-preview1-component-adapter/build.rs"
// Some specific flags to `wasm-ld` to inform the shape of this adapter.
// Notably we're importing memory from the main module and additionally our
// own module has no stack at all since it's specifically allocated at
// startup.
println!("cargo:rustc-link-arg=--import-memory");
println!("cargo:rustc-link-arg=-zstack-size=0");
```

[crates/wasi-preview1-component-adapter/build.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/build.rs#L17-L22)

依存は 4 つ。`std` は使わない。そして **`--import-memory` でメモリを持たず、`-zstack-size=0` でスタックすら持たない**。アダプタは変換対象モジュールの線形メモリを共有し、そこに間借りする。自分のメモリを持てば、変換対象がアダプタに渡してきたポインタを読めなくなるので、共有以外の選択肢がない。

成果物の形は CI で検証される。

```rust title="crates/wasi-preview1-component-adapter/verify/src/main.rs"
Payload::ImportSection(s) => {
    for i in s.into_imports() {
        let i = i?;
        match i.ty {
            TypeRef::Func(_) => {
                if i.module.starts_with("wasi:") { continue; }
                if i.module == "__main_module__" { continue; }
                bail!("import from unknown module `{}`", i.module);
            }
            TypeRef::Table(_) => bail!("should not import table"),
            TypeRef::Global(_) => bail!("should not import globals"),
            TypeRef::Memory(_) => {}
            // ...
        }
    }
}
Payload::MemorySection(_) => {
    bail!("preview1.wasm should import memory");
}
// ...
_ => {
    bail!("unsupported section {payload:?} found in preview1.wasm")
}
```

[crates/wasi-preview1-component-adapter/verify/src/main.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/verify/src/main.rs#L23-L62)

**import 元は `wasi:*` と `__main_module__` だけ、メモリは import 必須、許されるセクション種別はホワイトリスト。** 最後の `_ => bail!` が効いていて、data セクションや element セクションが混ざったらビルドが落ちる。**「してはいけないこと」を目視で守るのではなく、成果物のバイト列を検査して守っている。**

## パニックを持ち込めない

Rust の `unwrap` は失敗時にパニックし、パニックはフォーマットとアンワインドの機構を引き込み、その機構は関数ポインタのテーブル (element セクション) を作る。element セクションは上の検証で弾かれる。だから `unwrap` が使えない。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
// The unwrap/expect methods in std pull panic when they fail, which pulls
// in unwinding machinery that we can't use in the adapter. Instead, use this
// extension trait to get postfixed upwrap on Option and Result.
trait TrappingUnwrap<T> {
    fn trapping_unwrap(self) -> T;
}

impl<T> TrappingUnwrap<T> for Option<T> {
    fn trapping_unwrap(self) -> T {
        match self {
            Some(t) => t,
            None => unreachable!(),
        }
    }
}
```

[crates/wasi-preview1-component-adapter/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/lib.rs#L147-L170)

そしてその `unreachable!` も標準のものではない。`macros.rs` が同名のマクロを自前で定義していて、最終的に `core::arch::wasm32::unreachable()` (wasm の `unreachable` 命令) を出す。`assert!` と `assert_eq!` も同様に自作されている。

```rust title="crates/wasi-preview1-component-adapter/src/macros.rs"
/// A minimal `assert`.
macro_rules! assert {
    ($cond:expr $(,)?) => {
        if !$cond {
            crate::macros::assert_fail(line!());
        }
    };
}
```

[crates/wasi-preview1-component-adapter/src/macros.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/macros.rs#L103-L117)

失敗時に出るのは行番号だけだ。式もメッセージも保持しない。数値を出す `eprint_u32` すら、10 で割りながら再帰して 1 桁ずつ書き出す手書きの実装になっている。**フォーマット機構が使えないので、10 進表示を自分で書いている。**

## 文字列リテラルが持てない

さらに極端なのが、`macros.rs` の冒頭にある一文だ。

```rust title="crates/wasi-preview1-component-adapter/src/macros.rs"
//! Minimal versions of standard-library panicking and printing macros.
//!
//! We're avoiding static initializers, so we can't have things like string
//! literals. Replace the standard assert macros with simpler implementations.
```

**「静的初期化子を避けているので、文字列リテラルのようなものが持てない」。** Rust の `"foo"` は data セクションに置かれる静的データで、`&'static str` はそこへのポインタになる。data セクションは上の検証で許されていないし、そもそもアダプタは自分のメモリを持たないので、静的データを置く場所がない。

対処が proc-macro だ。

```rust title="crates/wasi-preview1-component-adapter/src/macros.rs"
macro_rules! eprint {
    ($arg:tt) => {{
        // We have to expand string literals into byte arrays to prevent them
        // from getting statically initialized.
        let message = byte_array_literals::str!($arg);
        $crate::macros::print(&message);
    }};
}
```

[crates/wasi-preview1-component-adapter/src/macros.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/macros.rs#L14-L34)

`byte_array_literals::str!("hello")` は `[104u8, 101u8, 108u8, 108u8, 111u8]` に展開される。専用の proc-macro crate がそれだけのために存在する。

```rust title="crates/wasi-preview1-component-adapter/byte-array-literals/src/lib.rs"
/// Expand a `str` literal into a byte array.
#[proc_macro]
pub fn str(input: TokenStream) -> TokenStream {
    let rv = convert_str(input);

    vec![TokenTree::Group(Group::new(
        Delimiter::Bracket,
        rv.into_iter().collect(),
    ))]
    .into_iter()
    .collect()
}
```

[crates/wasi-preview1-component-adapter/byte-array-literals/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/byte-array-literals/src/lib.rs#L5-L31)

配列リテラルはスタック (あるいはレジスタ) 上に構築されるので、静的初期化子にならない。文字列リテラルのエスケープ (`\n`、`\x41`、`\u{...}`) の解釈まで自前で書いてある。**「文字列を書く」という最も基本的な操作が、コンパイル時のトークン変換に置き換わっている。**

## 生成コードも一部は使えない

WIT のバインディングは `wit-bindgen` が生成するが、そのままでは使えない関数がある。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
// Automatically generated bindings for these functions will allocate
// Vecs, which in turn pulls in the panic machinery from std, which
// creates vtables that end up in the wasm elem section, which we
// can't support in these special core-wasm adapters.
// Instead, we manually define the bindings for these functions in
// terms of raw pointers.
skip: [
    "run",
    "get-environment",
    "poll",
    "[method]outgoing-datagram-stream.send",
],
```

[crates/wasi-preview1-component-adapter/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/lib.rs#L58-L69)

**「`Vec` を割り当てる → std のパニック機構が付いてくる → vtable ができる → element セクションに載る → 我々には無理」**という因果が 1 コメントに書かれている。`list<T>` を返す関数がこれに該当するので、`get-environment` や `poll` は生ポインタで手書きする。生成器に「全部生成して」と言えず、除外リストを維持する必要がある。

## `State` は 1 ページちょうどでなければならない

アダプタが持つ可変状態は `State` という構造体ひとつだ。置き場所がない (自分のメモリがない) ので、変換対象のモジュールから借りる。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
#[cold]
fn new() -> *mut State {
    #[link(wasm_import_module = "__main_module__")]
    unsafe extern "C" {
        fn cabi_realloc(
            old_ptr: *mut u8, old_len: usize, align: usize, new_len: usize,
        ) -> *mut u8;
    }

    assert!(matches!(
        unsafe { get_allocation_state() },
        AllocationState::StackAllocated
    ));

    unsafe { set_allocation_state(AllocationState::StateAllocating) };

    let ret = unsafe {
        cabi_realloc(
            ptr::null_mut(), 0,
            mem::align_of::<UnsafeCell<State>>(),
            mem::size_of::<UnsafeCell<State>>(),
        ) as *mut State
    };

    unsafe { set_allocation_state(AllocationState::StateAllocated) };
    unsafe { Self::init(ret); }
    ret
}
```

[crates/wasi-preview1-component-adapter/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/lib.rs#L2877-L2912)

**`__main_module__` の `cabi_realloc` を呼んで、変換対象のアロケータからメモリを貰う。** `AllocationState` の遷移を挟んでいるのは、この確保中にアダプタの関数が再入されうるからだ。`State` の先頭と末尾には `MAGIC` (`b"ugh!"`) のカナリアが埋まっていて、`State::with` は毎回両方を検査する。**共有メモリの上に間借りしているので、隣から踏まれたことを検出する仕掛けが要る。**

そしてサイズが 1 ページちょうどであることが、コンパイル時にアサートされる。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
const fn temporary_data_size() -> usize {
    // The total size of the struct should be a page, so start there
    let mut start = PAGE_SIZE;

    // Remove big chunks of the struct for its various fields.
    start -= size_of::<Descriptors>();
    #[cfg(not(feature = "proxy"))]
    {
        start -= size_of::<DirentCache>();
    }

    // Remove miscellaneous metadata also stored in state.
    let misc = if cfg!(feature = "proxy") { 12 } else { 14 };
    start -= misc * size_of::<usize>();

    // Everything else is the `command_data` allocation.
    start
}

// Statically assert that the `State` structure is the size of a wasm page.
#[cfg(target_arch = "wasm32")]
const _: () = {
    let _size_assert: [(); PAGE_SIZE] = [(); size_of::<State>()];
};
```

[crates/wasi-preview1-component-adapter/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/lib.rs#L2809-L2834)

**サイズの計算が逆向きだ。** 「フィールドを足したら何バイトか」ではなく「1 ページから他のフィールドを引いた残りが `temporary_data` の大きさ」。そして残りを引く際の `misc` が **`12` か `14` という手動カウントのマジックナンバー**になっている。小さな `Cell` や `RefCell` のフィールドが何ワードあるかを、人間が数えて書いている。フィールドを 1 つ足したら、この数字も直さないと `const` アサートが落ちる。

アサートの書き方も独特で、`[(); PAGE_SIZE] = [(); size_of::<State>()]` という配列型の一致で書かれている。型が合わなければコンパイルエラーになり、エラーメッセージに両方の数値が出る。

## 状態へのポインタは wasm global に置く

`State` へのポインタ自体も、線形メモリには置けない。置ける場所は wasm の **global** しかない。だが Rust には「wasm global を定義する」構文がない。

対処が `build.rs` にある。

````rust title="crates/wasi-preview1-component-adapter/build.rs"
/// This function will produce a wasm module which is itself an object file
/// that is the basic equivalent of:
///
/// ```rust
/// std::arch::global_asm!(
///     "
///         .globaltype internal_state_ptr, i32
///         internal_state_ptr:
///     "
/// );
///
/// #[unsafe(no_mangle)]
/// extern "C" fn get_state_ptr() -> *mut u8 { /* global.get internal_state_ptr */ }
/// ```
///
/// The main trickiness here is getting the `reloc.CODE` and `linking` sections
/// right.
fn build_raw_intrinsics() -> Vec<u8> {
````

[crates/wasi-preview1-component-adapter/build.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/build.rs#L25-L240)

**`wasm-encoder` で wasm のオブジェクトファイルを 1 本、Rust コードとして組み立てている。** 型セクション、関数セクション、グローバルセクションを作り、`code` セクションはバイト列を手で並べる (`global.get` が `0x23`、`global.set` が `0x24` とハードコードされている)。理由はコメントにある通りで、**`reloc.CODE` セクションに書く「コードセクション内のオフセット」が必要で、`wasm-encoder` の高レベル API ではそれが取れない**からだ。リンカ用の `linking` カスタムセクションも手書きする。

さらにそのオブジェクトファイルを `.a` に固める処理まで自前だ。

```rust title="crates/wasi-preview1-component-adapter/build.rs"
// The symbol table is in the "GNU" format which means it has a structure
// that looks like:
//
// * a big-endian 32-bit integer for the number of symbols
// * N big-endian 32-bit integers for the offset to the object file, within
//   the entire archive, for which object has the symbol
// * N nul-delimited strings for each symbol
```

[crates/wasi-preview1-component-adapter/build.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/build.rs#L235-L316)

**GNU 形式の ar シンボルテーブルを、ビッグエンディアンの整数を並べるところから組み立てている。** メンバは偶数オフセットで始まる、という ar の規約まで守っている。`llvm-ar crus libfoo.a foo.o` の出力を Rust で再現する、という注釈が付く。

「wasm global を 1 個持ちたい」という要求が、**オブジェクトファイル生成 + リロケーションセクション + アーカイブ形式の手書き**にまで膨らんでいる。抽象の下を突き抜けたときのコストがそのまま見える。

## アラインメントで文字列か list かを判別する

canonical ABI では、ホストからゲストへ `list<T>` や `string` を渡すとき、ゲストの `cabi_import_realloc` が呼ばれてメモリが確保される ([lifting と lowering](../lifting-lowering/))。アダプタには 1 ページしかないので、ここに大きな引数列が来ると入らない。

対処が「アラインメントで用途を見分ける」というハックだ。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
/// The types requiring allocation in the WASIp2 APIs that the WASIp1 APIs call
/// are relatively simple. They all look like `list<T>` where `T` only has
/// indirections in the form of `String`. This means that we can apply a
/// "clever" hack where the alignment of an allocation is used to disambiguate
/// whether we're allocating a string or allocating the `list<T>` allocation.
```

[crates/wasi-preview1-component-adapter/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/lib.rs#L245-L258)

`list<T>` の本体はアラインメント 4、文字列はアラインメント 1。**この違いだけを見て、確保先を切り替える。** 文字列は最終的な行き先 (`args_get` が渡してきたバッファ) に直接書き、`list` の骨格だけを 1 ページの中に置く。

そして「メモリが縮む方向の realloc」については、作者自身が 60 行かけて破綻条件を列挙している。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
// This is ... a hack. This is a hack in subtle ways that is quite
// brittle and may break over time. ...
//
// In the case that `old_ptr` may not be null we come to the first
// brittle assumption: it's assumed that this is shrinking memory. ...
// This assumption may be violated in the future if the
// canonical ABI is updated to handle growing strings in addition to
// shrinking strings. ...
//
// * For `OneAlloc` this isn't the end of the world. ...
// * For `CountAndDiscardStrings` we're relying on the fact that ...
// * For `SeparateStringsAndPointers` it's similar to the previous case ...
// * Finally for `GetPreopenPath` this works out only insofar that ...
//
// Basically it's a case-by-case basis here that enables ignoring
// shrinking return calls here. Not robust.
```

[crates/wasi-preview1-component-adapter/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/lib.rs#L344-L408)

4 つの列挙子について「なぜ縮小要求を無視しても壊れないか」を 1 つずつ論証したうえで、**"Not robust." で締める**。ハックであることを隠さず、どの前提が破れたときに壊れるかを書き残す。これは弱さの告白ではなく、**将来この前提が破れたときに壊れた理由を再構成できるようにする**という書き方だ。

## 仕様の緩さを利用する

`args_sizes_get` の実装は、上のハックを能動的に使っている。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
// ... the return value
// of `environ_sizes_get` and `args_sizes_get` will be the overlong
// approximation for all strings. That means that the final exact size
// won't be what's returned. This ends up being ok because technically
// nothing about WASI says that those blocks have to be exact-sized.
// In our case we're (ab)using that to force the caller to make an
// overlarge return area which we'll allocate into.
```

**WASI 仕様は「このブロックが正確なサイズである」とは言っていない。それを (悪用して) 呼び出し側に過大な return area を確保させ、そこへ割り当てる。** アダプタは 1 ページしか持てないので、大きな引数列を置く場所がない。ならば「引数を置く場所は呼び出し側に用意させればよい」。`args_sizes_get` が大きめの数を返せば、`wasi-libc` はその分のバッファを確保し、続く `args_get` でそのバッファを渡してくる。アダプタはそこへ直接文字列を書く。

**仕様が保証していないことを、保証していないと確認したうえで利用している。** `(ab)using` という自嘲的な書き方が、正当性の境界を正しく認識していることも示している。

## 返り値バッファを作業領域に二重利用する

`poll_oneoff` はさらに直接的だ。

```rust title="crates/wasi-preview1-component-adapter/src/lib.rs"
// We're going to split the `nevents` buffer into two non-overlapping
// buffers: one to store the pollable handles, and the other to store
// the bool results.
//
// First, we assert that this is possible:
assert!(align_of::<Event>() >= align_of::<Pollable>());
assert!(align_of::<Pollable>() >= align_of::<u32>());
assert!(
    nsubscriptions.checked_mul(size_of::<Event>()).trapping_unwrap()
        >= nsubscriptions.checked_mul(size_of::<Pollable>()).trapping_unwrap()
            .checked_add(
                nsubscriptions.checked_mul(size_of::<u32>()).trapping_unwrap()
            ).trapping_unwrap()
);
// Store the pollable handles at the beginning, and the bool results at the
// end, so that we don't clobber the bool results when writing the events.
let pollables = out as *mut c_void as *mut Pollable;
let results = unsafe { out.add(nsubscriptions).cast::<u32>().sub(nsubscriptions) };
```

[crates/wasi-preview1-component-adapter/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-preview1-component-adapter/src/lib.rs#L2135-L2159)

**ゲストが「結果を書き込め」と渡してきた `out` バッファを、まず作業領域として使う。** 前半に pollable ハンドルを、後半に結果の bool 列を置き、最後に `Event` を書き戻す。作業領域を確保する場所がないので、既にある領域を借りるしかない。

そして借りる前に、それが可能であることを 3 つの `assert!` で確認している。アラインメントの関係と、サイズが足りることの証明だ。**危険な二重利用を、成立条件を明示的に検査したうえで行う。** 条件が破れたら実行時に `unreachable` でトラップする。証明を書き下せないなら、せめて検査を置く。

## 何が学べるか

このアダプタは、**制約が極端になるとコードの書き方がどこまで変わるか**の実例になっている。

普段何気なく使っているものが、ひとつずつ剥がれていく。`std` がない。アロケータがない。スタックがない。メモリがない。パニックがない。フォーマットがない。文字列リテラルがない。ライブラリの生成コードすら全部は使えない。残ったのは、配列リテラルと生ポインタと `unreachable` 命令だけだ。

そこで採られた手段はどれも「本来やってはいけないこと」だが、**やってはいけない理由を明示し、成立条件を検査し、破綻条件を書き残す**という共通の作法がある。`Not robust.` と書くこと、`(ab)using` と書くこと、`assert!` を 3 つ並べてから二重利用に入ること。これらは全部同じ姿勢の現れだ。

もうひとつは、**制約を人間の注意力ではなくツールで守っている**こと。`verify/` が成果物のセクションと import を検査し、`const` アサートが `State` のサイズを検査し、`compile_error!` がフィーチャの排他を検査する。「element セクションを作らないよう気をつける」では 1 年も保たない。**守れない制約は、検査に落とす。**

そして最後に、この crate 全体が **preview1 という過去を preview2 という現在に接続するためだけに存在している**ことも見ておきたい。これだけの労力が、既存のバイナリを作り直さずに新しい世界へ持ち込むために払われている。互換性の維持は、しばしば新機能より高くつく。

次は、preview2 の component を実際にサーバとして動かす側を見る ([wasmtime serve — epoch で止めず、yield で逃がす](../wasmtime-serve/))。
