---
title: "アロケータを使い回す"
description: "アリーナは速いが、最初の 1 個を作るコストはゼロではない。数千ファイルを lint するなら、ファイルごとにアリーナを作って捨てるより、スレッド数だけ作って使い回すほうが安い。oxc の AllocatorPool は Mutex<Stack<Allocator>> という素朴な作りだが、その上に「4GiB 境界に揃った 2GiB のブロック」という奇妙な変種が乗っている。理由は JS 側にポインタの下位 32bit だけを読ませるためだ。"
group: "木の設計 — Allocator・AST・コード生成"
sidebar:
  order: 31
---

## 何を学んだか

[bump アリーナ](./bump-allocator/)の割り当てはポインタの加算だが、アリーナそのものの生成にはシステムアロケータの呼び出しが要る。数千ファイルを lint するとき、ファイルごとに作って捨てていたらそこが積み上がる。

oxc の答えは `AllocatorPool` で、**スレッド数と同じ数のアロケータをあらかじめ作り、使い終わったら reset して返す。** 実装は `Mutex<Stack<Allocator>>` という、拍子抜けするほど素朴なものだ。

面白いのはその上に乗っている変種のほうで、**`FixedSizeAllocatorPool` は「サイズ 2GiB - 16、アライメント 4GiB」という固定サイズのブロック**を配る。この奇妙な数字は、JS 側が 64bit ポインタの下位 32bit だけをオフセットとして読めるようにするためのものだ。

## なぜそうなっているか

### プールが `Stack` で `Vec` でない理由

```rust title="crates/oxc_allocator/src/pool/standard.rs"
pub struct StandardAllocatorPool {
    /// Allocators currently in the pool.
    /// We use a `Stack` because it's faster than `Vec` for `push` and `pop`,
    /// and those are the operations we do while `Mutex` lock is held.
    /// The shorter the time lock is held, the less contention there is.
    allocators: Mutex<Stack<Allocator>>,
}
```

理由がコメントに書いてある。**ロックを握っている時間の中でやる操作が `push`/`pop` だけなので、その 2 つが速い型を選んだ。** `oxc_data_structures::stack::Stack` は `Vec` と違って「末尾ポインタを持つ」形なので、`push`/`pop` が数命令短い。

ロック競合の削減を、ロックの粒度ではなくクリティカルセクションの中身で解いている。lock-free 構造に手を出す前にこれを試す、という順序は真似できる。

### 返却は `Drop` に任せる

取り出しは `AllocatorGuard` を返し、返却はその `Drop` でやる。

```rust title="crates/oxc_allocator/src/pool/mod.rs"
/// A guard object representing exclusive access to an [`Allocator`] from the pool.
///
/// On drop, the `Allocator` is reset and returned to the pool.
pub struct AllocatorGuard<'alloc_pool> {
    allocator: ManuallyDrop<Allocator>,
    pool: &'alloc_pool AllocatorPool,
}

impl Drop for AllocatorGuard<'_> {
    /// Return [`Allocator`] back to the pool.
    fn drop(&mut self) {
        // SAFETY: After taking ownership of the `Allocator`, we do not touch the `ManuallyDrop` again
        let allocator = unsafe { ManuallyDrop::take(&mut self.allocator) };
        self.pool.add(allocator);
    }
}
```

`reset()` は `add` の側で呼ばれる。**返す前ではなく受け取った側でリセットする**ので、「返し忘れ」も「リセットし忘れ」も呼び出し側の責任にならない。

`Deref<Target = Allocator>` があるので、利用側は `&*guard` を `&Allocator` として渡すだけでいい。プールの存在を意識するのは `pool.get()` の 1 行だけになる。

### 固定サイズアロケータが必要になる理由

ここからが本題になる。

JS 側 (napi) に AST を渡す方法は 2 つある。1 つは ESTree の JSON にシリアライズして渡すやり方。もう 1 つが **raw transfer** で、**Rust が AST を書いたメモリそのものを `Uint8Array` として JS に見せ、JS 側が構造体のレイアウトを知っていてポインタを辿る**というものだ ([ESTree シリアライズと raw transfer](./estree-serialization/))。

問題は、AST の中のポインタが 64bit だということ。JS の数値で 64bit 整数を扱うのは高くつく。

そこで、`napi/parser/src/raw_transfer.rs` のコメントにある解法が出てくる。

```rust title="napi/parser/src/raw_transfer.rs"
// For raw transfer, use a buffer 2 GiB in size, with 4 GiB alignment.
// This ensures that all 64-bit pointers have the same value in upper 32 bits,
// so JS only needs to read the lower 32 bits to get an offset into the buffer.
//
// Buffer size only 2 GiB so 32-bit offsets don't have the highest bit set.
// This is advantageous for 2 reasons:
//
// 1. V8 stores small integers ("SMI"s) inline, rather than on heap, which is more performant.
//    But 31 bits is the max positive integer considered an SMI.
//
// 2. JS bitwise operators work only on signed 32-bit integers, with 32nd bit as sign bit.
//    So avoiding the 32nd bit being set enables using `>>` bitshift operator,
//    which is cheaper than `>>>`, and does not risk offsets being interpreted as negative.
```

順を追うとこうなる。

1. **バッファ全体を 4GiB 境界に揃える** → バッファ内のどのアドレスも、上位 32bit が同じ値になる
2. **サイズを 2GiB に抑える** → 下位 32bit の最上位ビットが立たない
3. 結果、JS 側は **「下位 32bit を読んで、それをバッファ先頭からのオフセットとして使う」** だけでポインタを解決できる。しかもその値は V8 の SMI に収まり、`>>` で扱える

生成された定数がこれになる。

```rust title="crates/oxc_allocator/src/generated/fixed_size_constants.rs"
/// Total size of the allocator block (including metadata and allocator `ChunkFooter`).
pub const BLOCK_SIZE: usize = 2147483632;

/// Required alignment of the allocator block (4 GiB).
pub const BLOCK_ALIGN: usize = 4294967296;
```

`2147483632` は `2GiB - 16`。この 16 バイトの引き算は `ChunkFooter` と `RawTransferMetadata` のためのもので、**この定数自体が ast_tools の生成物**であることに注意がいる ([ast_tools](./ast-tools/))。AST の型レイアウトが変われば、メタデータのサイズが変わり、この定数も変わる。

### 4GiB アライメントは OS が素直にくれない

`arena/fixed_size/mod.rs` のモジュールコメントが、プラットフォームごとの回避策を並べている。

```rust title="crates/oxc_allocator/src/arena/fixed_size/mod.rs"
//! * Mac OS: System allocator refuses allocations with 4 GiB alignment.
//!   See <https://github.com/rust-lang/rust/issues/30170>.
//!   We over-allocate `BLOCK_SIZE + TWO_GIB` (4 GiB - 16) bytes with 2 GiB alignment,
//!   then use whichever half of the allocation is aligned on `BLOCK_ALIGN`.
//!
//! * Linux: Linux MUSL accepts allocation requests with 4 GiB alignment, but then segfaults when
//!   the allocation is freed. So we use the same trick as on Mac OS.
//!
//! * Windows: System allocator also doesn't support high alignment allocations, but Rust's `std`
//!   contains a workaround for servicing high-alignment requests.
//!   We side-step that by over-allocating `BLOCK_SIZE + BLOCK_ALIGN` (6 GiB - 16) bytes with
//!   alignment 16, then aligning the returned pointer to `BLOCK_ALIGN` (4 GiB) ourselves.
//!   This avoids `std`'s workaround committing a whole extra page just to store the real
//!   allocation pointer.
```

**「2 倍取って、揃っているほうの半分を使う」**という古典的な手を使っている。Linux MUSL の「要求は通るが free で segfault する」は、ドキュメントされていなければ絶対に踏み抜く類の話で、こうしてコメントに残っていること自体が資産になっている。

さらに、この確保は**グローバルアロケータを迂回して `System` を直接呼ぶ**。

```rust title="crates/oxc_allocator/src/fixed_size.rs"
    /// Allocation is made via [`System`] allocator, bypassing any registered alternative global
    /// allocator (e.g. Mimalloc in linter). Mimalloc complains that it cannot serve allocations
    /// with high alignment, and presumably it's pointless to try to obtain such large allocations
    /// from a thread-local heap, so better to go direct to the system allocator anyway.
```

linter は mimalloc をグローバルアロケータに差している。mimalloc はスレッドローカルヒープを前提にしているので、4GiB アライメントの 2GiB 塊を求められても困る。「そもそも thread-local heap から取る意味がない」という判断込みで迂回している。

### Windows だけプールの作り方が違う

固定サイズプールは、Linux/Mac と Windows で `new` の実装そのものが分かれている。

```rust title="crates/oxc_allocator/src/pool/fixed_size.rs"
    /// Windows implementation.
    ///
    /// Windows doesn't overcommit virtual memory, so it's easy to hit OOM.
    /// We want to use as many allocators as we can up to `thread_count`, but without exhausting
    /// memory, and without leaving the system starved of memory for *other* allocations.
    ///
    /// So we create as many allocators as we can, up to `thread_count + 1`, and then discard
    /// the last one. This should guarantee that there's at least 4 GiB of memory left for
    /// other allocations.
```

Linux/Mac は仮想メモリをオーバーコミットするので、4GiB のブロックを 16 個作っても物理メモリは消費されない。Windows はオーバーコミットしないので、同じことをすると本当に OOM する。

対策が独特で、**「作れるだけ作って、最後の 1 個を捨てる」**。捨てた 1 個分 (4GiB) がシステムに残るので、他の割り当てが OOM しにくくなる。コメントには「16.01GiB 使えるシステムで 4 個作ったら 10MB しか残らず、その後の `String` の確保で落ちる」という具体例まで書いてある。

その代わり Windows ではプールが空になりうるので、`Condvar` で待つ。Linux/Mac 側にはそのフィールド自体が `#[cfg]` で存在しない。

```rust title="crates/oxc_allocator/src/pool/fixed_size.rs"
    /// Only used on Windows. On *nix systems, we don't need this synchronization.
    #[cfg(target_os = "windows")]
    available: Condvar,
```

### なぜ「プールは成長しない」で足りるのか

固定サイズプールの doc コメントは、使われる 3 つのシナリオを列挙したうえで「どれでも同時に存在する固定サイズアロケータは `thread_count` 個を超えない」と結論している。

```rust title="crates/oxc_allocator/src/pool/fixed_size.rs"
/// ## 3. Both JS plugins and `import` plugin in use
///
/// Multi-file analysis is enabled. Many ASTs may be parsed and held in memory - many more than
/// `thread_count`. Linter parses ASTs into standard allocators.
/// When it is time to lint AST with JS plugins, AST is copied into a fixed-size allocator.
/// After linting, the fixed-size allocator is returned to the pool.
/// The last step happens on maximum `thread_count` threads simultaneously.
```

複数ファイルを同時に保持する必要があるケース (`import` 系ルール) では、**保持は普通のアロケータでやり、JS プラグインに渡す直前だけ固定サイズアロケータにコピーする**。コピーのコストを払う代わりに、高価な固定サイズアロケータの同時存在数を `thread_count` に抑え込んでいる。

「プールが成長しなくていい」という結論は自明ではなく、こうやって利用シナリオを数え上げて初めて言える。doc コメントがその数え上げそのものになっている。

## ソースコードのどこか

- [`crates/oxc_allocator/src/pool/mod.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/pool/mod.rs) — `AllocatorPool` と `AllocatorGuard`
- [`crates/oxc_allocator/src/pool/standard.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/pool/standard.rs) — 通常プール
- [`crates/oxc_allocator/src/pool/fixed_size.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/pool/fixed_size.rs) — 固定サイズプールと 3 シナリオの数え上げ
- [`crates/oxc_allocator/src/arena/fixed_size/mod.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/arena/fixed_size/mod.rs) — プラットフォーム別の 4GiB アライメント確保
- [`crates/oxc_allocator/src/generated/fixed_size_constants.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/generated/fixed_size_constants.rs) — `BLOCK_SIZE` / `BLOCK_ALIGN`

`AllocatorPool` は enum で 2 種類を包んでいるだけの薄い層になっている。

```rust title="crates/oxc_allocator/src/pool/mod.rs"
#[repr(transparent)]
pub struct AllocatorPool(AllocatorPoolInner);

enum AllocatorPoolInner {
    Standard(StandardAllocatorPool),
    #[cfg(all(feature = "fixed_size", target_pointer_width = "64", target_endian = "little"))]
    FixedSize(FixedSizeAllocatorPool),
}
```

固定サイズ側は **64bit リトルエンディアンでしか存在しない**。`#[cfg]` が型定義・フィールド・メソッドの全部に付いていて、32bit でビルドすると存在しないものとして消える。「実行時に分岐して panic」ではなく「型の世界から消す」という扱い方をしている。

## どう活かすか

**プールは `Mutex<Stack<T>>` で始めてよい。** 最初から lock-free に行く必要はない。先にやることは「ロックを握っている区間を短くする」で、oxc はそのために `Vec` ではなく `Stack` を選んでいる。実際、[並列 lint](./parallel-lint/) の側でも共有状態の大半はロックフリーのハッシュマップだが、アロケータプールは `Mutex` のままだ。

**リソースの返却は `Drop` ガードに寄せる。** 「使い終わったら reset して返す」を呼び出し側の作法にすると、必ずどこかで漏れる。`AllocatorGuard` のように `Deref` を実装しておけば、呼び出し側のコードはプールの存在をほぼ意識しない。

**言語境界を跨ぐデータには、アドレス表現から設計する。** 「4GiB 境界に揃った 2GiB」というのは、シリアライズ形式ではなく**メモリ配置そのものをプロトコルにした**という判断だ。同じ発想は WASM の線形メモリや、共有メモリ IPC でも使える。ただし代償は大きい — プラットフォームごとの確保方法の違い、mimalloc の迂回、Windows の OOM 対策と、`fixed_size` 関連だけで数百行になる。`Cargo.toml` の feature 説明に「Usage of this feature is not advisable, and it will be removed as soon as we're able to」と書かれているのは正直なところで、**これは JSON シリアライズが遅すぎたから払っているコスト**であって、最初から選ぶ設計ではない。
