---
title: "なぜ wasi:io だけが別クレートなのか"
description: "wasi:io は WASI 全体の土台であり、filesystem も sockets も cli も http も「準備完了を待つ標準手段」としてこれに乗る。wasmtime がこれを独立した no_std クレートに切り出している理由は 2 つあり、どちらも「土台であること」から出てくる。pollable / input-stream / output-stream という 3 つの抽象が、POSIX の fd を型のある形で再構成したものであることを読む。"
group: "WASI"
sidebar:
  order: 77
---

`crates/wasi-io` は WASI 実装のなかで唯一、他の全部から依存される crate だ。理由はその lib.rs の doc に書いてある。

```rust title="crates/wasi-io/src/lib.rs"
//! This crate provides a Wasmtime host implementation of the WASI 0.2 (aka
//! WASIp2 aka Preview 2) wasi-io package. The host implementation is
//! abstract: it is exposed as a set of traits which other crates provide
//! impls of.
//!
//! The wasi-io package is the foundation which defines how WASI programs
//! interact with the scheduler. It provides the `pollable`, `input-stream`,
//! and `output-stream` Component Model resources, which other packages
//! (including wasi-filesystem, wasi-sockets, wasi-cli, and wasi-http)
//! expose as the standard way to wait for readiness, and asynchronously read
//! and write to streams.
//!
//! This crate is designed to have no unnecessary dependencies and, in
//! particular, to be #![no_std].
```

[crates/wasi-io/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-io/src/lib.rs#L1-L18)

**「WASI プログラムがスケジューラとどうやり取りするかを定義する土台」**であり、**「filesystem・sockets・cli・http はすべてこれを『準備完了を待つ標準手段』として公開する」**。この 2 文が、なぜ別 crate なのかの答えをそのまま含んでいる。

## 別クレートである理由 2 つ

ひとつめは **「抽象だけを置く層」だから**だ。doc の言い方では「ホスト実装は抽象であり、trait の集まりとして公開され、他の crate がその impl を提供する」。`wasmtime-wasi-io` が持っているのは `Pollable` / `InputStream` / `OutputStream` の 3 つの trait と、それを `wasi:io` の resource に結びつける生成コードだけで、**具体的なストリームの実装はひとつも入っていない**。ファイルのストリームは `wasmtime-wasi` に、HTTP のボディのストリームは `wasmtime-wasi-http` にある。

もしこれが `wasmtime-wasi` の中にあったら、`wasmtime-wasi-http` は HTTP を実装するためだけに `wasmtime-wasi` 全部 (ファイルシステム、ソケット、時計、乱数、cap-std、tokio) に依存することになる。**土台だけを取り出しておくと、上に載る crate が土台以外を引きずらない。**

ふたつめは **`#![no_std]` を維持するため**だ。依存は 5 つしかない。

```toml title="crates/wasi-io/Cargo.toml"
[dependencies]
wasmtime = { workspace = true, features = ["component-model", "async", "runtime"] }
bytes = { workspace = true }
async-trait = { workspace = true }
futures = { workspace = true }
tracing = { workspace = true }

[features]
default = [ "std" ]
std = [
    "bytes/std",
    "wasmtime/std",
    "tracing/std",
]
```

[crates/wasi-io/Cargo.toml](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-io/Cargo.toml#L16-L29)

`std` はフィーチャであって既定ではあるが必須ではない。lib.rs も `#![no_std]` を宣言して `extern crate alloc` だけを使う。doc は `examples/min-platform` を「no_std 埋め込みの例」として指している。**OS がない環境にも wasmtime を持ち込める、という wasmtime 全体の方針が、WASI の側にも降りてきている。**

これは `wasmtime-wasi` 本体では成立しない。あちらは `cap-std` も `tokio` も使うので、ファイルシステムと OS のスレッドが前提になる。だが「ゲストが待ち合わせをするための語彙」は OS に依存しない。`Pollable::ready()` が何を待つかは実装が決めることで、trait の定義自体は `async fn` ひとつで済む。**依存が要らない層を、依存が要る層から物理的に切り離す**という単純な操作が、crate 境界として現れている。

## 3 つの抽象

WIT 側の `wasi:io` は interface が 3 つ、resource も 3 つしかない。

```wit title="crates/wasi-io/wit/deps/io.wit"
interface poll {
  /// `pollable` represents a single I/O event which may be ready, or not.
  resource pollable {
    /// Return the readiness of a pollable. This function never blocks.
    ready: func() -> bool;
    /// `block` returns immediately if the pollable is ready, and otherwise
    /// blocks until ready.
    block: func();
  }

  poll: func(in: list<borrow<pollable>>) -> list<u32>;
}
```

[crates/wasi-io/wit/deps/io.wit](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-io/wit/deps/io.wit#L38-L78)

`error` は「デバッグ文字列に落とせる何か」を表す不透明なリソースで、`poll` は待ち合わせ、`streams` が読み書きだ。この 3 つが、POSIX の fd がひとつの整数に押し込んでいた役割を分解したものになっている。

POSIX の fd は「読める対象」でも「書ける対象」でも「`select` に入れられる対象」でもあり、しかもそれが同じ `int` 型だった。ソケットに `lseek` を呼べてしまうし、`close` 済みの番号を再利用したら別のファイルに書き込む。`wasi:io` はこれを **`input-stream` (読める)**、**`output-stream` (書ける)**、**`pollable` (待てる)** という 3 つの別々の resource に分けた。resource は Component Model のハンドルなので、番号を推測しても他人のストリームには届かない ([resource — ハンドルで所有権を渡す](../resources/))。

そして「読める / 書ける / 待てる」という共通の形が取れることが、この抽象が成り立つ根拠でもある。ファイルもソケットも標準入力も HTTP のボディも、**中身は違うが「今どれだけ進められるか」という問いには同じ形で答えられる**。だから filesystem も sockets も cli も http も、自分専用の待ち合わせ API を定義せず、`subscribe()` で `pollable` を返す。

WIT 側にはこの設計が暫定であることも書いてある。

```wit title="crates/wasi-io/wit/deps/io.wit"
/// WASI I/O is an I/O abstraction API which is currently focused on providing
/// stream types.
///
/// In the future, the component model is expected to add built-in stream types;
/// when it does, they are expected to subsume this API.
interface streams {
```

**「将来 component model が組み込みのストリーム型を追加したら、この API はそれに吸収される見込みである」**。この予告が実際にどうなったかは、章の最後 ([WASI 0.3 で wasi:io が消える](../wasi-03/)) で見る。

## Rust 側の trait

WIT の 3 resource に対応する Rust の trait は素直な形をしている。

```rust title="crates/wasi-io/src/streams.rs"
#[async_trait::async_trait]
pub trait InputStream: Pollable {
    /// Reads up to `size` bytes, returning a buffer holding these bytes on
    /// success.
    ///
    /// This function does not block the current thread and is the equivalent of
    /// a non-blocking read. On success all bytes read are returned through
    /// `Bytes`, which is no larger than the `size` provided. If the returned
    /// list of `Bytes` is empty then no data is ready to be read at this time.
    fn read(&mut self, size: usize) -> StreamResult<Bytes>;

    /// Similar to `read`, except that it blocks until at least one byte can be
    /// read.
    async fn blocking_read(&mut self, size: usize) -> StreamResult<Bytes> { /* ... */ }

    fn skip(&mut self, nelem: usize) -> StreamResult<usize> { /* ... */ }
    async fn blocking_skip(&mut self, nelem: usize) -> StreamResult<usize> { /* ... */ }

    /// Cancel any asynchronous work and wait for it to wrap up.
    async fn cancel(&mut self) {}
}
```

[crates/wasi-io/src/streams.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-io/src/streams.rs#L15-L74)

注目すべき点が 3 つある。

**`InputStream: Pollable` という継承関係。** ストリームであることは、待てることを含む。`read` が「今読めるだけ」しか返さない以上、待ち合わせなしにストリームは使えない。型で強制されている。

**必須メソッドは `read` ひとつだけ。** `blocking_read` も `skip` も `blocking_skip` もデフォルト実装がある。実装者が書くのは「今すぐ読める分を読む」だけで、待つ側の関数は `ready().await` と組み合わせて自動的に生える。この導出の中身は [permit モデル — check-write してから write する](../permit-model/) で見る。

**`cancel` がある。** ストリームを畳むときに、走らせてしまった非同期作業を回収する口だ。`Drop` では `await` できないので、明示的な非同期の後始末が要る。

`OutputStream` も同じ形で、必須は `write` / `flush` / `check_write` の 3 つ。`write` の doc には「このメソッドは絶対にブロックしてはならない」と書かれており、書ける量は事前に `check_write` で問い合わせる。この 2 段構えが WASI 0.2 の I/O の中心にある約束で、次の 2 ページの主題になる。

エラーは 3 値の enum で、これも設計が出ている。

```rust title="crates/wasi-io/src/streams.rs"
pub enum StreamError {
    Closed,
    LastOperationFailed(wasmtime::Error),
    Trap(wasmtime::Error),
}
```

[crates/wasi-io/src/streams.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-io/src/streams.rs#L85-L96)

`Closed` と `LastOperationFailed` は WIT の `stream-error` variant にそのまま対応し、ゲストに `result` として返る。`Trap` は WIT に存在しない第 3 の値で、**ゲストが約束を破ったときにインスタンスごと落とすための経路**だ。「許可された量より多く書いた」のような契約違反は、ゲストにエラーを返して続行させるのではなく、トラップさせる ([TrappableError](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/error.rs#L20-L48) が同じ考え方を一般化している)。

## `IoView` — 必要なのはリソース表だけ

`wasmtime-wasi-io` が埋め込み側に要求するものも極小だ。

```rust title="crates/wasi-io/src/lib.rs"
pub trait IoView {
    /// Yields mutable access to the internal resource management that this
    /// context contains.
    ///
    /// Embedders can add custom resources to this table as well to give
    /// resources to wasm as well.
    fn table(&mut self) -> &mut ResourceTable;
}
```

[crates/wasi-io/src/lib.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi-io/src/lib.rs#L72-L79)

**`WasiCtx` は要らない。** ストリームや pollable は `ResourceTable` の中に置かれた `Box<dyn InputStream>` などであって、設定を持たないからだ。「何を貸すか」の判断は `wasmtime-wasi` 側の話で、「貸したものをどう読み書きするか」はこの層で完結する。

`wasmtime-wasi` 側にはこの分離のコストを認めるコメントが残っている。

```rust title="crates/wasi/src/p2/mod.rs"
// FIXME: it's a bit unfortunate that this can't use
// `wasmtime_wasi_io::add_to_linker` and that's because `T: WasiView`, here,
// not `T: IoView`. Ideally we'd have `impl<T: WasiView> IoView for T` but
// that's not possible with these two traits in separate crates.
```

[crates/wasi/src/p2/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/p2/mod.rs#L487-L491)

crate を分けたせいで孤児規則に引っかかり、`WasiView` から `IoView` へのブランケット実装が書けない。だから `wasmtime-wasi` 側で 3 行の重複を抱えている。**crate 境界は依存関係を切るが、trait 実装の自由度も同時に切る。** コメントは「今は小さな重複だが、増えるようなら整理する」と書いていて、コストを自覚した上でこの分割を選んでいることが分かる。

## この先

`wasi:io` が持つ 3 つの抽象のうち、`pollable` と `output-stream` には、素直な見た目に反する仕掛けが入っている。

- `pollable` は Rust の `Future` に見えて `Future` ではない。「Future を作る関数ポインタ」を持つ ([pollable は Future ではない](../pollable/))。
- `output-stream` は「書ける量を先に貰う」という permit モデルで、`blocking_*` はそこから導出される ([permit モデル — check-write してから write する](../permit-model/))。

どちらも「core wasm には非同期の呼び出し規約がない」という 1 点から出てくる制約への対処になっている。
