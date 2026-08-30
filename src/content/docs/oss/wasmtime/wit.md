---
title: "WIT を読む — world・interface・resource"
description: "WIT は component の型を書くための言語で、bindgen! の入力になる。world が「この component が何を import し何を export するか」の契約、interface がその単位、resource がハンドルを介した不透明な型。Wasmtime のリポジトリにある実際の .wit を読みながら記法を一通り確認し、ホスト側の wasmtime-internal-wit-bindgen とゲスト側の wit-bindgen という同名の別物を区別する。"
group: "Component Model"
sidebar:
  order: 68
---

## WIT は何のための言語か

WIT (Wasm Interface Type) は、**component の境界に立つ型と関数を書くための言語**だ。core wasm の `(func (param i32 i32))` では表現できない「文字列を受け取ってレコードを返す関数」を言語非依存に書き下し、それを canonical ABI が core wasm に落とす ([Canonical ABI — 16 個までは引数、それ以上はメモリ](../canonical-abi-flatten/))。

WIT のファイルは 2 方向に使われる。ゲスト側では言語ツールチェーンがそれを読んで「この関数を export しろ」という骨組みを生成し、ホスト側では `bindgen!` がそれを読んで Rust の trait と型を生成する。**同じ 1 つのファイルが両側の契約になる**というのが要点で、これは IDL としては普通の姿だが、core wasm にはそもそも IDL を書く場所がなかった。

以下、Wasmtime のリポジトリにある実際の `.wit` を読みながら記法を確認する。`crates/component-macro/tests/codegen/` には `bindgen!` のコード生成テスト用の `.wit` が揃っていて、記法のカタログとして使える。

## package・world・interface

一番小さい例がこれだ。

```wit title="crates/component-macro/tests/codegen/smoke.wit"
package foo:foo;

world the-world {
  import imports: interface {
    y: func();
  }
}
```

[crates/component-macro/tests/codegen/smoke.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/tests/codegen/smoke.wit)

`package foo:foo;` が名前空間で、`名前空間:パッケージ名@バージョン` という形をとる。`world` が **1 つの component の契約全体**を表し、その中に `import` と `export` が並ぶ。ここでは `imports` という名前でインラインの interface を import している。

`interface` は関数と型のまとまりで、名前を付けて別に定義し、`world` から参照するのが普通の書き方だ。`use` で他の interface から型を持ち込める。

```wit title="crates/component-macro/tests/codegen/use-paths.wit"
interface a {
  record foo {}
  a: func() -> foo;
}

interface b {
  use a.{foo};
  a: func() -> foo;
}

world d {
  import a;
  import b;
  import d: interface {
    use c.{foo};
    b: func() -> foo;
  }
}
```

[crates/component-macro/tests/codegen/use-paths.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/tests/codegen/use-paths.wit)

`use a.{foo}` は型のコピーではなく**同一の型への参照**で、`a` の `foo` と `b` の `foo` は同じ型になる。だから `interface c` が `b` から持ち込んだ `foo` も、遡れば `a.foo` と同じものだ。この推移的な `use` の連鎖は `resources-import.wit` にわざと 4 段の連鎖 (`long-use-chain1` から `long-use-chain4`) として書かれていて、コード生成がそれを辿れることを確認している。

`world` は型も直接持てる。

```wit title="crates/component-macro/tests/codegen/worlds-with-types.wit"
interface i {
  type t = u16;
}

world foo {
  use i.{t as u};

  type t = u32;

  record r {
  }

  export f: func() -> tuple<t, u, r>;
}
```

[crates/component-macro/tests/codegen/worlds-with-types.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/tests/codegen/worlds-with-types.wit)

`use i.{t as u}` の `as` によるリネームがあるのは、world 自身が `t` を別に定義しているからだ。

## 型

WIT の型は、プリミティブ (`bool` / `char` / `s8`〜`s64` / `u8`〜`u64` / `f32` / `f64` / `string`) と、それを組み合わせる 7 つの構成子でできている。

**record** は名前付きフィールドの積、**variant** はペイロード付きのタグ union、**enum** はペイロードなしの variant、**flags** はビット集合、そして `option<T>` / `result<T, E>` / `list<T>` / `tuple<A, B>` が組み込みの構成子だ。

```wit title="crates/component-macro/tests/codegen/variants.wit"
enum e1 {
    a,
}

record empty {}

variant v1 {
    a,
    c(e1),
    d(string),
    e(empty),
    f,
    g(u32),
}

result-arg: func(
  a: result,
  b: result<_, e1>,
  c: result<e1>,
  d: result<tuple<>, tuple<>>,
  e: result<u32, v1>,
  f: result<string, list<u8>>,
);
```

[crates/component-macro/tests/codegen/variants.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/tests/codegen/variants.wit)

`variant` の各ケースはペイロードを持ってもよいし持たなくてもよい (`a` と `f` は持たない)。`result` は `result<T, E>` の T と E をそれぞれ省略でき、`result` だけなら `result<(), ()>` に相当する。

`flags` はビット数ごとに Rust 側の表現が変わるので、テストが `flag1` / `flag2` / `flag4` / `flag8` / `flag16` / `flag32` / `flag64` と刻んで並べてある。

```wit title="crates/component-macro/tests/codegen/flags.wit"
flags flag1 {
  b0,
}

flags flag8 {
  b0, b1, b2, b3, b4, b5, b6, b7,
}

flags flag32 {
  b0, b1, b2, b3, b4, b5, b6, b7,
  b8, b9, b10, b11, b12, b13, b14, b15,
  b16, b17, b18, b19, b20, b21, b22, b23,
  b24, b25, b26, b27, b28, b29, b30, b31,
}
```

[crates/component-macro/tests/codegen/flags.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/tests/codegen/flags.wit)

## Rust の型との対応

`ComponentType` トレイトの doc に、対応表がそのまま書かれている。

```rust title="crates/wasmtime/src/runtime/component/func/typed.rs"
/// | Component Model Type              | Rust Type                            |
/// |-----------------------------------|--------------------------------------|
/// | `{s,u}{8,16,32,64}`               | `{i,u}{8,16,32,64}`                  |
/// | `f{32,64}`                        | `f{32,64}`                           |
/// | `bool`                            | `bool`                               |
/// | `char`                            | `char`                               |
/// | `tuple<A, B>`                     | `(A, B)`                             |
/// | `option<T>`                       | `Option<T>`                          |
/// | `result<T, E>`                    | `Result<T, E>`                       |
/// | `string`                          | `String`, `&str`, or [`WasmStr`]     |
/// | `list<T>`                         | `Vec<T>`, `&[T]`, or [`WasmList`]    |
/// | `map<K, V>`                       | `HashMap<K, V>`                      |
/// | `own<T>`, `borrow<T>`             | [`Resource<T>`] or [`ResourceAny`]   |
/// | `record`                          | [`#[derive(ComponentType)]`][d-cm]   |
/// | `variant`                         | [`#[derive(ComponentType)]`][d-cm]   |
/// | `enum`                            | [`#[derive(ComponentType)]`][d-cm]   |
/// | `flags`                           | [`flags!`][f-m]                      |
```

[crates/wasmtime/src/runtime/component/func/typed.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/component/func/typed.rs#L400-L419)

素直な対応になっているのは、WIT の型が「多くの言語に共通する型だけ」に絞られているからだ。`record` / `variant` / `enum` / `flags` は名前が component ごとに違うので、`#[derive(ComponentType)]` か `flags!` マクロでその場で作る。`bindgen!` が生成するのはまさにこの derive 付きの型定義になる。

`string` と `list<T>` に `WasmStr` / `WasmList` という選択肢があるのが目を引く。これは「ゲストのメモリ上の値を指すだけでコピーしない」lift 専用型で、詳細は [lifting と lowering、realloc と post-return](../lifting-lowering/) で扱う。

## resource — ハンドル越しの不透明な型

`resource` は、**中身をバイト列として渡さずハンドルの番号だけを渡す型**だ。ファイルディスクリプタやソケットのように「所有権があり、明示的に閉じる必要があり、中身を相手に見せたくない」ものを表す。

```wit title="crates/component-macro/tests/codegen/resources-import.wit"
interface resources {
  resource bar {
    constructor();
    static-a: static func() -> u32;
    method-a: func() -> u32;
  }

  bar-own-arg: func(x: own<bar>);
  bar-borrow-arg: func(x: borrow<bar>);
  bar-result: func() -> own<bar>;

  record nested-own {
    nested-bar: own<bar>
  }

  type some-handle = borrow<bar>;
  func-with-handle-typedef: func(x: some-handle);

  resource fallible {
    constructor() -> result<fallible, string>;
  }
}
```

[crates/component-macro/tests/codegen/resources-import.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/tests/codegen/resources-import.wit#L1-L49)

resource が持てる関数は 3 種類ある。**`constructor()` が生成、`static func` が resource に紐づくが インスタンスを取らない関数、`func` (修飾なし) が第 1 引数に `borrow<self>` を取るメソッド**だ。`constructor() -> result<fallible, string>` のように、生成が失敗しうる形も書ける。

そして `own<T>` と `borrow<T>` の区別が resource の中心にある。**`own<bar>` は所有権の移動で、受け取った側がいずれ破棄する責任を負う。`borrow<bar>` は貸出で、その関数呼び出しの間だけ有効で、呼び出しから戻る時点で貸主に返る。** `type some-handle = borrow<bar>;` のように型エイリアスにもできるし、`record` のフィールドや `list` の要素にもできる。

この own / borrow が実行時にどう表現されるか — `lend_count` と `scope` という 2 つのカウンタになる — が [own は貸出中に消せない、borrow は scope に縛られる](../resources/) の主題だ。

`world` の直下にも resource を書ける。上の `resources-import.wit` の後半に `world the-world { resource world-resource { ... } }` があり、world レベルの resource を import 関数の返り値にも export 関数の返り値にも使っている。

## バージョンと安定性注釈

WIT のパッケージ名にはセマンティックバージョンが付く。これが component の import 名にそのまま出てくるので、同じ interface の複数バージョンを 1 つの world が同時に import できる。

```wit title="crates/component-macro/tests/codegen/multiversion/root.wit"
package foo:bar;

world foo {
  import my:dep/a@0.1.0;
  import my:dep/a@0.2.0;
  export my:dep/a@0.1.0;
  export my:dep/a@0.2.0;
}
```

[crates/component-macro/tests/codegen/multiversion/root.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/tests/codegen/multiversion/root.wit)

`deps/v1/root.wit` が `package my:dep@0.1.0;`、`deps/v2/root.wit` が `package my:dep@0.2.0;` を宣言していて、**同名の `interface a` が 2 つの別の型として共存する**。ホスト側の `Linker` はこれを名前で解決するので、名前解決に semver の知識を持っている ([component のコンパイルは 4 段階](../component-pipeline/))。

個々の項目には `@since` と `@unstable` を付けられる。`@since(version = X)` は「バージョン X から安定して存在する」、`@unstable(feature = F)` は「フィーチャ F が有効なときだけ見える」を意味する。

```wit title="crates/component-macro/tests/codegen/unstable-features.wit"
@unstable(feature = experimental-interface)
interface the-interface {
  @unstable(feature = experimental-interface-function)
  foo: func();

  @unstable(feature = experimental-interface-resource)
  resource bar {
    @unstable(feature = experimental-interface-resource-method)
    foo: func();
  }
}
```

[crates/component-macro/tests/codegen/unstable-features.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/tests/codegen/unstable-features.wit)

注釈は interface・関数・resource・resource のメソッドと、あらゆる粒度に付けられる。実際の WASI がこれを全面的に使っている。

```wit title="crates/wasi/src/p2/wit/deps/io.wit"
package wasi:io@0.2.12;

@since(version = 0.2.0)
interface poll {
  /// `pollable` represents a single I/O event which may be ready, or not.
  @since(version = 0.2.0)
  resource pollable {
    /// Return the readiness of a pollable. This function never blocks.
    @since(version = 0.2.0)
    ready: func() -> bool;

    @since(version = 0.2.0)
    block: func();
  }
}
```

[crates/wasi/src/p2/wit/deps/io.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/p2/wit/deps/io.wit#L36-L55)

パッケージは `wasi:io@0.2.12` だが各項目は `@since(version = 0.2.0)` なので、「0.2.0 から入っている」ことが読み取れる。この `pollable` が WASI の非同期モデルの中核になる ([pollable は Future ではない](../pollable/))。

## `world` は `include` で合成できる

world は他の world を取り込める。Wasmtime 自身がテストプログラム用にこれをやっている。

```rust title="crates/test-programs/src/lib.rs"
wit_bindgen::generate!({
    inline: "
        package wasmtime:test;

        world test {
            include wasi:cli/imports@0.2.12;
            include wasi:http/imports@0.2.12;
            include wasi:config/imports@0.2.0-rc.1;
            include wasi:keyvalue/imports@0.2.0-draft;
            include wasi:tls/imports@0.2.0-draft;
        }
    ",
```

[crates/test-programs/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/test-programs/src/lib.rs#L9-L20)

`include` は「その world の import と export を全部こちらに取り込む」で、`import` (interface を 1 つ足す) とは別物だ。WASI が `wasi:cli/imports` という「import だけを集めた world」を用意しているのはこのためで、詳細は [wasi:cli の world と、WasiCtx の切り方](../wasi-worlds/) で扱う。

## `wit-bindgen` が 2 つあることに注意する

ここで混乱の元になるものを 1 つ潰しておく。**Wasmtime のリポジトリにある `crates/wit-bindgen/` は、ゲスト側のコード生成器ではない。**

```toml title="crates/wit-bindgen/Cargo.toml"
[package]
name = "wasmtime-internal-wit-bindgen"
description = "INTERNAL: `*.wit` support for the `wasmtime` crate's macros"
```

[crates/wit-bindgen/Cargo.toml](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wit-bindgen/Cargo.toml)

パッケージ名は `wasmtime-internal-wit-bindgen` で、ワークスペースからは `wasmtime-wit-bindgen` という別名で参照される。これは **`bindgen!` マクロが呼ぶホスト側のコード生成エンジン本体**で、`crates/component-macro/src/bindgen.rs` がそれを使っている。

```rust title="crates/component-macro/src/bindgen.rs"
use wasmtime_wit_bindgen::{
    FunctionConfig, FunctionFilter, FunctionFlags, Opts, Ownership, TrappableError,
};
use wit_parser::{PackageId, Resolve, WorldId};

pub fn expand(input: &mut Config) -> Result<TokenStream> {
    let mut src = match input.opts.generate(&mut input.resolve, input.world) {
        Ok(s) => s,
        Err(e) => return Err(Error::new(Span::call_site(), e.to_string())),
    };
```

[crates/component-macro/src/bindgen.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/component-macro/src/bindgen.rs#L10-L27)

一方、ゲスト側の `wit_bindgen::generate!` は**別リポジトリの外部クレート**だ。ワークスペースの依存宣言で明示的にバージョンが固定されている。

```toml title="Cargo.toml"
# wit-bindgen:
wit-bindgen = { version = "0.61.1", default-features = false }
wit-bindgen-rust-macro = { version = "0.61.1", default-features = false }
```

[Cargo.toml](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/Cargo.toml#L374-L376)

使う場所も違う。ホスト側は `bindgen!("convert" in "./examples/component/convert.wit")` として `main.rs` に書き、ゲスト側は `wit_bindgen::generate!` として wasm にコンパイルされる `guest.rs` に書く。

```rust title="examples/component/wasm/guest.rs"
// Use wit_bindgen to generate the bindings from the component model to Rust.
wit_bindgen::generate!({
    path: "..",
    world: "convert",
});

struct GuestComponent;

export!(GuestComponent);

impl Guest for GuestComponent {
    fn convert_celsius_to_fahrenheit(x: f32) -> f32 {
        host::multiply(x, 1.8) + 32.0
    }
}
```

[examples/component/wasm/guest.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/examples/component/wasm/guest.rs)

**名前が同じで役割が対称なので混ざりやすいが、片方は Wasmtime の内部クレート、もう片方は独立した外部プロジェクトである。** Wasmtime 側の doc も「これは内部専用クレートで一般利用は想定していない」と警告を掲げている。

## WIT から component へ

WIT を書いてゲストをコンパイルすると core module が出てくる。それを component に変換するのは、通常は言語ツールチェーンの仕事だ ([core module だけでは足りない理由](../why-component/))。埋め込み側が `wit_component::ComponentEncoder` を直接叩くのは例外的で、Wasmtime のサンプルもそう断り書きを付けている。

次のページからは、この WIT の型が core wasm のシグネチャにどう落ちるかを見ていく。
