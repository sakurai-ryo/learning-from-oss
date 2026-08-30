---
title: "1 回の mmap で確保し、mprotect で伸ばす"
description: "線形メモリの型は Memory / SharedMemory / LocalMemory / RuntimeLinearMemory / MmapMemory という階層になっている。memory.grow は多くの場合、予約済みの領域に mprotect で読み書き権限を与えるだけで済む。予約を超えたときだけコピーが起き、そのときベースポインタが動く——この可能性が埋め込み API の安全性の議論にまで及ぶ。"
group: "線形メモリの実装"
sidebar:
  order: 44
---

線形メモリの実装は 5 段の型で構成されている。モジュールの冒頭に、その関係が図で書かれている。

```text title="crates/wasmtime/src/runtime/vm/memory.rs"
//! ┌─────────────────────┐
//! │        Memory       ├─────────────┐
//! └──────────┬──────────┘             │
//!            ▼                        ▼
//! ┌─────────────────────┐     ┌──────────────┐
//! │     LocalMemory     │◄────┤ SharedMemory │
//! └──────────┬──────────┘     └──────────────┘
//!            ▼
//! ┌─────────────────────┐
//! │ RuntimeLinearMemory ├─────────────┬───────────────┐
//! └──────────┬──────────┘             │               │
//!            ▼                        ▼               ▼
//! ┌─────────────────────┐     ┌──────────────┐     ┌─────┐
//! │      MmapMemory     │     │ StaticMemory │     │ ... │
//! └─────────────────────┘     └──────────────┘     └─────┘
```

[crates/wasmtime/src/runtime/vm/memory.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/memory.rs)

役割分担も同じコメントに書いてある。`Memory` が wasm インスタンスに実際に格納されるもので、埋め込み API を提供する。`SharedMemory` は `RwLock<LocalMemory>` を持ち、threads proposal のための共有メモリを表す。`LocalMemory` が伸長ロジックを持つ本体で、`RuntimeLinearMemory` はそこから委譲されるトレイトだ。

このトレイトが**意図的に単純に保たれている**ことに理由がある。`Config` を通じて埋め込み側に公開されるので、任意の実装を差し込めるようにするためだ。既定の実装は 2 つあり、`MmapMemory` が普通の mmap ベース、`StaticMemory` は pooling allocator 用でベースポインタが既に確保済みのものを使う。

なおこのコメントには FIXME が 2 つ付いている。`RuntimeLinearMemory` と `wasmtime::LinearMemory`、`RuntimeMemoryCreator` と `wasmtime::MemoryCreator` が二重に存在しており、統合すべきだと書かれている。内部トレイトと公開トレイトが並走している状態が、そのまま記録されている。

## 確保は 1 回

`MmapMemory::new` は、必要な領域を**すべて 1 回の mmap で予約する**。

```rust title="crates/wasmtime/src/runtime/vm/memory/mmap.rs"
        let request_bytes = pre_guard_bytes
            .checked_add(alloc_bytes)
            .and_then(|i| i.checked_add(offset_guard_bytes))
            .with_context(|| format!("cannot allocate {minimum} with guard regions"))?;

        let mmap = Mmap::accessible_reserved(HostAlignedByteCount::ZERO, request_bytes)?;

        if minimum > 0 {
            let accessible = HostAlignedByteCount::new_rounded_up(minimum)?;
            // SAFETY: mmap is not in use right now so it's safe to make it accessible.
            unsafe {
                mmap.make_accessible(pre_guard_bytes, accessible)?;
            }
        }
```

[crates/wasmtime/src/runtime/vm/memory/mmap.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/memory/mmap.rs)

前方ガード + 本体 + 後方ガードをまとめて予約し、そのうち wasm が最初に必要とする分だけ `make_accessible`（実体は `mprotect` で読み書きを許す）する。残りは `PROT_NONE` のまま置かれる。

確保するサイズの決め方には分岐がある。最小サイズが `memory_reservation` に収まるなら、予約はその値になる。最大サイズも収まるなら、伸長用の余剰は要らない（`extra_to_reserve_on_growth = 0`）。最小サイズが予約に収まらない場合は、最小サイズ + 伸長用の余剰を確保する。

## 伸長は 2 通り

`memory.grow` が呼ばれたときの処理が、この設計の要になる。

```rust title="crates/wasmtime/src/runtime/vm/memory/mmap.rs"
    fn grow_to(&mut self, new_size: usize) -> Result<()> {
        let new_accessible = HostAlignedByteCount::new_rounded_up(new_size)?;
        let current_capacity = self.current_capacity();
        if new_accessible > current_capacity {
            // If the new size of this heap exceeds the current size of the
            // allocation we have, then this must be a dynamic heap. Use
            // `new_size` to calculate a new size of an allocation, allocate it,
            // and then copy over the memory from before.
            // ...
            let mut new_mmap =
                Mmap::accessible_reserved(HostAlignedByteCount::ZERO, request_bytes)?;
            // ...
            self.mmap = try_new::<Arc<_>>(new_mmap)?;
        } else {
            // If the new size of this heap fits within the existing allocation
            // then all we need to do is to make the new pages accessible. This
            // can happen either for "static" heaps which always hit this case,
            // or "dynamic" heaps which have some space reserved after the
            // initial allocation to grow into before the heap is moved in
            // memory.
            // ...
                self.mmap.make_accessible(/* ... */)?;
```

**予約の中に収まるなら `mprotect` だけ。** 新しいページに読み書き権限を与えて終わり。データのコピーもアドレスの変更も起きない。64bit ホストの既定設定では 4GiB が予約されているので、wasm の 32bit メモリは**どれだけ伸びてもこの経路にしか入らない**。

予約を超えるときだけ、新しく mmap し直して内容をコピーする。この場合は**ベースポインタが動く**。

`extra_to_reserve_on_growth` は、この再確保の頻度を減らすためにある。予約を超えるたびに「ちょうど必要な分」だけ確保していると、伸長のたびにコピーが起きる。余剰を持たせておけば、次の数回はコピーなしで済む。`Vec` の容量倍加と同じ発想だが、こちらは倍加ではなく固定量の上乗せになっている。

## ホストのページサイズより小さい wasm ページ

伸長の細部に、custom-page-sizes proposal への対応が入っている。

```rust title="crates/wasmtime/src/runtime/vm/memory/mmap.rs"
            // If the Wasm memory's page size is smaller than the host's page
            // size, then we might not need to actually change permissions,
            // since we are forced to round our accessible range up to the
            // host's page size.
            if let Ok(difference) = new_accessible.checked_sub(self.accessible()) {
```

wasm のページが 1 バイトだと、`memory.grow 1` で増えるのは 1 バイトだ。だがホストのページは 4KiB なので、権限の設定は 4KiB 単位でしか行えない。**アクセス可能な範囲を切り上げた結果、既に権限が付いていることがある。** その場合は `mprotect` を呼ぶ必要がない。

この「切り上げ」が、[4GiB 予約と 32MiB ガードの配置](../memory-layout/) で触れた「ページサイズ 1 の線形メモリでは境界チェックを消せない」理由でもある。wasm の境界とホストのページ境界が一致しないので、保護属性で境界を表現できない。

## ベースポインタが動くことの帰結

「grow でベースポインタが動きうる」という事実は、実装の内側に閉じない。埋め込み API の安全性に直接効いてくる。

`wasmtime::Memory` の doc が、安全に触るための原則を挙げている。ひとつは、再帰的に wasm を呼び出すと全バイトが変わりうること。もうひとつが、**`grow` でベースポインタが動くこと**。そして 3 つ目として、安全な API（`read`/`write`/`data`/`data_mut`）は Store 全体を借用する。

Rust の借用検査が効くのは 3 つ目のおかげだ。`data_mut` でスライスを取っている間は Store を可変借用しているので、その間に wasm を呼ぶことも `grow` することもできない。**「ポインタが動きうる」という実装の性質を、API の借用規則で封じ込めている。**

逆に `unsafe` な生ポインタ経由の API を使うなら、この保証は消える。`VMMemoryDefinition` は JIT コードから見えるベースポインタと長さを持つが、そこを直接読むコードは grow のタイミングに責任を持たなければならない。

## 共有メモリの長さは Relaxed で読む

threads proposal の共有メモリでは、別のスレッドが同時に `memory.grow` を実行しうる。`VMMemoryDefinition::current_length` はこれをアトミックに保持しているが、読み出しは `Relaxed` になっている。

過小評価が許されるからだ。読み取った長さが実際より短くても、境界チェックが過度に厳しくなるだけで、安全性は損なわれない。**「安全側に外れる」ことが分かっているので、同期のコストを払わない。** 逆に過大評価は許されないので、長さの更新は伸長が完了してから行われる。
