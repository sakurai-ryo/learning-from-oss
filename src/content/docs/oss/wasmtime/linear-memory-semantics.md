---
title: "線形メモリ — ポインタがオフセットになるということ"
description: "Wasm のポインタはホストの仮想アドレスではなく、線形メモリの先頭からのオフセットである。64KiB のページ単位、`memory.grow` による伸長、境界外のトラップという仕様と、そこから導かれる「32bit wasm のアドレスは実質 33bit である」という事実を確認する。これが後のバウンズチェック除去の前提になる。"
group: "WebAssembly をゼロから"
sidebar:
  order: 5
---

Wasm のプログラムが持つ「メモリ」は、0 番地から始まるバイト配列 1 本だけだ。`i32.load` は「線形メモリの先頭から N バイト目を読む」という意味しか持たず、N は `i32` (または `i64`) の値である。ホストの仮想アドレスは wasm から見えないし、書けもしない。

この単純さから、驚くほど多くのことが導かれる。ポインタ演算でサンドボックスを抜けられないこと、`memory.grow` でベースアドレスが動きうること、そして **32bit wasm のアドレスが実質 33bit であること**だ。最後の 1 つが、Wasmtime のコード生成でもっとも重要な事実になる。

このページは仕様の側だけを扱う。実際の mmap レイアウトや guard page の配置は [4GiB 予約と 32MiB ガードの配置](../memory-layout/)、境界チェックが消える条件の数式は [境界チェックを「消す」ための条件を数式で追う](../bounds-check-elision/) に譲る。

## 線形メモリの型は 4 つのフィールドしかない

Wasmtime が線形メモリの型として持っているものが、そのまま仕様上の線形メモリの全体だ。

```rust title="crates/environ/src/types.rs"
/// WebAssembly linear memory.
#[derive(Debug, Clone, Copy, Hash, Eq, PartialEq, Serialize, Deserialize)]
pub struct Memory {
    /// The type of the index used to access the memory.
    pub idx_type: IndexType,
    /// The limits constrain the minimum and optionally the maximum size of a memory.
    /// The limits are given in units of page size.
    pub limits: Limits,
    /// Whether the memory may be shared between multiple threads.
    pub shared: bool,
    /// The log2 of this memory's page size, in bytes.
    ///
    /// By default the page size is 64KiB (0x10000; 2**16; 1<<16; 65536) but the
    /// custom-page-sizes proposal allows opting into a page size of `1`.
    pub page_size_log2: u8,
}
```

[crates/environ/src/types.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/types.rs#L2264-L2280)

`idx_type` はアドレスが `i32` か `i64` かで、memory64 proposal が後者を足した。`limits` は `min: u64` と `max: Option<u64>` の組で、**単位はバイトではなくページ**である。`shared` は threads proposal のもの。`page_size_log2` は既定で 16 (= 64KiB) だが、custom-page-sizes proposal が `0` (= 1 バイト) を選べるようにした。

ページサイズが 64KiB なのは歴史的な選択で、「どの主要な CPU アーキテクチャのページサイズよりも大きい」ことが狙いだ。ホストのページ境界と wasm のページ境界の粒度が合わないと、仮想メモリの保護機構をそのまま流用できない。実際 Wasmtime はこの条件を明示的に検査している。

```rust title="crates/environ/src/types.rs"
/// When this function returns `true` then it means that signals such as
/// SIGSEGV on the host are compatible with wasm and can be used to
/// represent out-of-bounds memory accesses.
///
/// When this function returns `false` then it means that this memory must,
/// for example, have explicit bounds checks.
pub fn can_use_virtual_memory(&self, tunables: &Tunables, host_page_size_log2: u8) -> bool {
    tunables.signals_based_traps && self.page_size_log2 >= host_page_size_log2
}
```

**wasm のページがホストのページ以上に大きくなければ、SIGSEGV を wasm のトラップとして流用できない。** ページサイズ 1 の線形メモリを選んだ瞬間、Wasmtime は明示的な境界チェックを吐くしかなくなる。custom-page-sizes が「便利だが高くつく」機能である理由がここにある。

## 64bit メモリの最大サイズは u64 に収まらない

`max` が省略された場合、Wasmtime はインデックス型から上限を決める。ここに面白いコメントがある。

```rust title="crates/environ/src/types.rs"
pub fn max_size_based_on_index_type(&self) -> u64 {
    match self.idx_type {
        IndexType::I64 =>
        // Note that the true maximum size of a 64-bit linear memory, in
        // bytes, cannot be represented in a `u64`. That would require a u65
        // to store `1<<64`. Despite that no system can actually allocate a
        // full 64-bit linear memory so this is instead emulated as "what if
        // the kernel fit in a single Wasm page of linear memory". Shouldn't
        // ever actually be possible but it provides a number to serve as an
        // effective maximum.
        {
            0_u64.wrapping_sub(self.page_size())
        }
        IndexType::I32 => WASM32_MAX_SIZE,
    }
}
```

64bit の線形メモリはアドレス空間全体 (`1<<64` バイト) をアドレスできるので、真の最大サイズを表すには **u65 が要る**。だが実際に 64bit のアドレス空間を丸ごと確保できるシステムは存在しない。だから Wasmtime は `0 - page_size`、つまり `2^64 - 65536` を「実効的な最大値」として使う。コメントの「カーネルが 1 wasm ページに収まったら」という言い方がその割り切りをよく表している。

32bit のほうは `WASM32_MAX_SIZE = 1 << 32` で、こちらは素直に `u64` に収まる。

## memory.grow はベースポインタを動かす

線形メモリは `memory.grow` で伸ばせる。引数はページ数、返り値は**伸ばす前のページ数**で、失敗すると `-1` を返す。トラップではなく値でエラーを返す数少ない命令の 1 つだ。

仕様上、伸長後も既存のバイト列の内容は保存され、新しく増えた領域はゼロで埋まる。「アドレス空間の内容が保存される」とは言っているが、「ホスト上の物理アドレスが変わらない」とは一言も言っていない。ここが埋め込み側にとっての落とし穴になる。Wasmtime の `Memory` の doc は、この点を含めて 3 つの原則を挙げている。

```rust title="crates/wasmtime/src/runtime/memory.rs"
/// * Any recursive calls into WebAssembly can possibly modify any byte of the
///   entire memory. This means that whenever wasm is called Rust can't have any
///   long-lived borrows live across the wasm function call. Slices like `&mut
///   [u8]` will be violated because they're not actually exclusive at that
///   point, and slices like `&[u8]` are also violated because their contents
///   may be mutated.
///
/// * WebAssembly memories can grow, and growth may change the base pointer.
///   This means that even holding a raw pointer to memory over a wasm function
///   call is also incorrect. Anywhere in the function call the base address of
///   memory may change. Note that growth can also be requested from the
///   embedding API as well.
```

[crates/wasmtime/src/runtime/memory.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/memory.rs#L44-L140)

3 つ目は借用の粒度の話で、安全な `Memory::read` / `write` / `data` / `data_mut` はどれも **Store 全体を借用する**。

```rust title="crates/wasmtime/src/runtime/memory.rs"
/// Note that all of these consider the entire store context as borrowed for the
/// duration of the call or the duration of the returned slice. This largely
/// means that while the function is running you'll be unable to borrow anything
/// else from the store. This includes getting access to the `T` on
/// [`Store<T>`](crate::Store), but it also means that you can't recursively
/// call into WebAssembly for instance.
```

一見すると過剰に粗い。だが `&mut [u8]` を握ったまま wasm を再入できてしまえば、そのスライスは即座に嘘になる。**「wasm へ再入できない」という制約を Rust の借用チェッカに翻訳した結果が「Store 全体を借りる」**なのだ。粒度を細かくしようとすると、借用の生存期間中に何が起こりうるかを型で表現する必要が出てきて、途端に難しくなる。

そして doc は「不正な例」も長々と列挙している。`data_ptr` で生ポインタを取ってから `grow` する、`Store` を他の関数に渡してからポインタを使う、同じアドレスに `&u8` と `&mut u8` を同時に作る。どれも実際に起きる間違いで、「危険な API を用意するなら、危険な使い方を先に書いておく」という姿勢が徹底している。

## 32bit のアドレスは実効 33bit である

ここがこのページでもっとも重要な事実だ。Wasm のロード/ストア命令は、動的なアドレスに加えて**静的なオフセット**を持つ。`i32.load offset=100` は「スタックから pop した `i32` の値 + 100」バイト目を読む。そして静的オフセットも 32bit である。

```rust title="crates/wasmtime/src/config.rs"
/// * When [`Config::memory_guard_size`] is too small a bounds check may be
///   required. For 32-bit wasm addresses are actually 33-bit effective
///   addresses because loads/stores have a 32-bit static offset to add to
///   the dynamic 32-bit address. If the static offset is larger than the
///   size of the guard region then an explicit bounds check is required.
```

[crates/wasmtime/src/config.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/config.rs#L1846-L1865)

`u32::MAX + u32::MAX` は 33 ビット必要になる。つまり **32bit wasm のプログラムが 1 命令で指定しうるオフセットの上界は 4GiB ではなく約 8GiB** だ。

```text
  wasm が 1 命令で作れるアドレスの範囲

  0                      4GiB                     8GiB
  |------------------------|------------------------|
  |    線形メモリの予約領域   |      ガード領域         |
  |     (最大 4GiB)         |   (静的オフセット分)      |
  |------------------------|------------------------|
  ^                        ^
  base                     動的アドレス (i32) の上限
                           ここに静的オフセット (i32) が
                           さらに加算されうる
```

だから Wasmtime は、線形メモリの後ろに**ガード領域**を置く。動的アドレスが 4GiB 未満であることは `i32` であること自体から保証されるので、予約領域 4GiB + ガード領域が静的オフセットの最大値をカバーしていれば、**どんな入力に対しても計算されるアドレスは予約済みの領域に収まる**。そこがすべて未マップなら、境界外アクセスは必ず SIGSEGV になる。つまり境界チェックの命令を 1 つも吐かずに済む。

その条件が 3 つの `&&` として書かれている。

```rust title="crates/environ/src/types.rs"
/// Currently the only case that supports bounds check elision is when all
/// of these apply:
///
/// * When [`Memory::can_use_virtual_memory`] returns `true`.
/// * This is a 32-bit linear memory (e.g. not 64-bit)
/// * The reservation + guard size is in excess of 4GiB
///
/// In this situation all computable addresses fall within the reserved
/// space (modulo static offsets factoring in guard pages) so bounds checks
/// may be elidable.
pub fn can_elide_bounds_check(
    &self,
    memory_tunables: &MemoryTunables<'_>,
    host_page_size_log2: u8,
) -> bool {
    self.can_use_virtual_memory(memory_tunables.tunables(), host_page_size_log2)
        && self.idx_type == IndexType::I32
        && memory_tunables.reservation() + memory_tunables.guard_size() >= (1 << 32)
}
```

2 つ目の条件が、**memory64 が「64bit を扱える代わりに遅い」と言われる理由**だ。64bit のアドレスは仮想アドレス空間全体を指しうるので、「計算されうるアドレスをすべて予約する」という戦略が原理的に取れない。64bit 線形メモリには必ず明示的な境界チェックが付く。

## 何が守られていて、何が守られていないのか

線形メモリの中で何が起きても、それはサンドボックスの内側の出来事だ。バッファオーバーフローは起きるし、他人のデータを踏むこともある。だが踏む先は**必ず同じ線形メモリの中**であって、ホストのスタックでもヒープでも、他のインスタンスの線形メモリでもない。

C や Rust を wasm にコンパイルすると、スタック変数の一部 (アドレスを取られるもの) は「shadow stack」として線形メモリの中に置かれる。だから C プログラムの古典的なスタックスマッシングは、wasm では線形メモリの中の別の shadow stack フレームを壊すという形で**依然として起きる**。壊れないのは戻り番地だけで、それは wasm の実行系が別に持っていて wasm から見えないからだ ([なぜ WebAssembly が生まれたのか](../why-wasm/))。

**「ポインタがオフセットである」という 1 つの設計が、これを全部決めている。** アドレスの型が線形メモリの内側に閉じている以上、その外を指す値を作る手段がない。

## どう活かすか

「アドレスを、絶対的な位置ではなく特定の領域内のオフセットとして表現する」というのは、サンドボックスに限らず使える手だ。ファイル内の位置、アリーナ内のインデックス、リージョン内のハンドル。オフセットは領域の外を指せないので、境界検査を 1 箇所に集約できるし、領域ごと移動しても値が壊れない。

代わりに払うコストが「ベースアドレスが動く」ことで、Wasmtime の `Memory` の doc が延々と警告しているのはこの一点である。オフセットを使う設計を選ぶなら、**ベースアドレスを解決した結果 (生ポインタやスライス) を長生きさせない**、というルールを API の形で強制しておく必要がある。

次は、もう 1 つの間接参照の仕組み — テーブルを見る ([テーブルと間接呼び出し](../tables-and-call-indirect/))。
