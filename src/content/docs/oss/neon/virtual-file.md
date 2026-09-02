---
title: "virtual_file — ファイルディスクリプタを仮想化する"
description: "数千のレイヤファイルを開きたいが、FD の上限がある。Postgres と同じ「仮想 FD」の仕組みを持ち、その上に io_uring と direct I/O を載せた。カーネルのページキャッシュを捨てた理由が、マルチテナントの密度から説明される。"
group: "pageserver — 実行時"
sidebar:
  order: 42
---

## 何を学んだか

```rust title="pageserver/src/virtual_file.rs"
//! VirtualFile is like a normal File, but it's not bound directly to
//! a file descriptor.
//!
//! Instead, the file is opened when it's read from,
//! and if too many files are open globally in the system, least-recently
//! used ones are closed.
//!
//! To track which files have been recently used, we use the clock algorithm
//! with a 'recently_used' flag on each slot.
//!
//! This is similar to PostgreSQL's virtual file descriptor facility in
//! src/backend/storage/file/fd.c
```

([pageserver/src/virtual_file.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/virtual_file.rs#L1))

**Postgres の `fd.c` と同じ発想。** 実際 Postgres も、テーブルのセグメントファイルを大量に開くので同じ問題を持っている。

pageserver では規模が違う。テナント数 × timeline 数 × レイヤ数で、数万から数十万のファイルがある。`ulimit -n` を上げても足りないし、上げること自体がリソースの浪費になる。

**「開いているように見えるが、実際には閉じているかもしれない」オブジェクト**を作り、読み書きの直前に必要なら開き直す。clock アルゴリズムで最近使われていないものを閉じる。

**page cache と同じアルゴリズムが、違う資源 (FD) に適用されている** ([page_cache](../page-cache/))。pageserver には clock sweep が 2 つある。

## I/O エンジンの切り替え

```rust title="pageserver/src/virtual_file/io_engine.rs"
//! [`super::VirtualFile`] supports different IO engines.
//!
//! The [`IoEngineKind`] enum identifies them.
//!
//! The choice of IO engine is global.
```

```rust title="pageserver/src/virtual_file/io_engine.rs"
pub(crate) enum IoEngine {
    NotSet,
    StdFs,
    #[cfg(target_os = "linux")]
    TokioEpollUring,
}
```

([pageserver/src/virtual_file/io_engine.rs L20](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/virtual_file/io_engine.rs#L20))

**`io_uring` と、普通の同期 I/O を切り替えられる。** `io_uring` は Linux 限定なので `#[cfg]` が付く。macOS で開発している人がいる、という事情がここに現れている。

選択はグローバルで、`AtomicU8` 1 つに入っている。

```rust title="pageserver/src/virtual_file/io_engine.rs"
static IO_ENGINE: AtomicU8 = AtomicU8::new(IoEngine::NotSet as u8);
```

**enum を `u8` として原子変数に詰め、`TryFrom<u8>` で戻す。** グローバルな設定を、ロックなしで読めるようにするための定石になっている。

## direct I/O — カーネルのページキャッシュを捨てる

`docs/rfcs/2025-04-30-direct-io-for-pageserver.md` は「後追いの RFC」と自称していて、既に実装したことの記録になっている。

得られるものが 3 つ挙がっている。

```markdown title="docs/rfcs/2025-04-30-direct-io-for-pageserver.md"
**Predictable VirtualFile latencies**

- With buffered IO, reads are sometimes fast, sometimes slow, depending on kernel page cache hit/miss.
- By switching to direct IO, above operations will have the (predictable) device latency -- always.
```

**「速いことがある」より「常に予測可能」を選んでいる。** レイテンシの分布の裾を切るほうが、平均を下げるより価値がある、という判断だ。

```markdown title="docs/rfcs/2025-04-30-direct-io-for-pageserver.md"
**Explicitness & Tangibility of resource usage**

- In a multi-tenant system, it is generally desirable and valuable to be _explicit_ about the main resources we use for each tenant.
- We will be able to build per-tenant observability of resource usage ("what tenant is causing the actual IOs that are sent to the disk?").
- We will be able to build accounting & QoS by implementing an IO scheduler that is tenant aware. The kernel is not tenant-aware and can't do that.
```

**「カーネルはテナントを知らない」。** マルチテナントのシステムでは、資源の使用がカーネルの中で混ざってしまうと、誰が使ったかが分からなくなる。

これは [walredo](../walredo/) の「マルチテナント化は信頼境界を引き直す」と対になる話で、**マルチテナント化は資源の帰属も引き直す。**

## なぜカーネルのページキャッシュが効かないのか

RFC の付録が、この判断の根拠を数字で説明している。

```markdown title="docs/rfcs/2025-04-30-direct-io-for-pageserver.md"
The reason is that the Pageserver workload sent from Computes is whatever is a Compute cache(s) miss.
That's either sequential scans or random reads.
A random read workload simply causes cache thrashing because a packed Pageserver NVMe drive (`im4gn.2xlarge`) has ~100x more capacity than DRAM available.
It is complete waste to have the kernel page cache cache data blocks in this case.
```

**pageserver に来る要求は、compute のキャッシュを全部すり抜けたものだけ。** 共有バッファにも LFC にもなかったページだ ([LFC と prefetch](../lfc-and-prefetch/))。

**局所性のあるアクセスは、上流で吸収済み。** 残りはランダムアクセスに近い。そして NVMe の容量は DRAM の 100 倍あるので、キャッシュしても当たらない。

**多層キャッシュの下層は、上層が吸収した後の分布を見る。** 上層と同じアルゴリズムを使っても効かない、という一般則の実例になっている。

シーケンシャルスキャンだけは例外だと認めたうえで、その解決策も検討している。

```markdown title="docs/rfcs/2025-04-30-direct-io-for-pageserver.md"
This dependence on kernel page cache for sequential scan performance is significant, but the solution is at a higher level than generic data block caching.
We can either add a small per-connection LRU cache for such delta layer blocks.
Or we can merge those sequential requests into a larger vectored get request, which is designed to never read a block twice.
```

**「汎用のブロックキャッシュではなく、もっと上の層で解く」。** 実際に選ばれたのは後者で、[page_service](../page-service/) のバッチ化がそれになる。

**カーネルのページキャッシュに頼っていた性能を、アプリケーション側の設計で置き換えた。**

## トレードオフを引き受ける理由

```markdown title="docs/rfcs/2025-04-30-direct-io-for-pageserver.md"
We are **happy to make this trade-off**:

- Because we empirically have enough DRAM on Pageservers to serve metadata (=index blocks) from PS PageCache.
  (At just 2GiB PS PageCache size, we average a 99.95% hit rate).
  So, the latency of going to disk is only for data block reads, not the index traversal.
```

**「2GiB のキャッシュで 99.95% のヒット率」。** 索引ブロックだけをキャッシュすると決めた判断 ([page_cache](../page-cache/)) が、この数字で裏付けられている。

そして目標がレイテンシの式として書かれている。

```markdown title="docs/rfcs/2025-04-30-direct-io-for-pageserver.md"
The total "wait-for-disk time" contribution to random getpage request latency is `O(1 read IOP latency)`.
We accomplish that by having a near 100% PS PageCache hit rate so that layer index traversal effectively never needs not wait for IO.
Thereby, it can issue all the data blocks as it traverses the index, and only wait at the end of it (concurrent IO).

The amortized "wait-for-disk time" contribution of this direct IO proposal to a series of sequential getpage requests is `1/32 * read IOP latency` for each getpage request.
```

**「ランダム読みは 1 IOP、シーケンシャル読みは 1/32 IOP」。** 目標が定量的で、達成手段 (索引のキャッシュ、並行 I/O、32 件のバッチ) と対応している。

そして正直な但し書きが付く。

```markdown
(This is an ideal world where our batches are full - that's not the case in prod today because of lack of queue depth).
```

**「本番ではバッチが埋まっていない」。** 目標と現実の差を明記している。

## アラインメントが上に伝播する

direct I/O には制約がある。バッファのアドレス、オフセット、長さの全部が、デバイスのブロックサイズに揃っていなければならない。

RFC には "Ensuring Adherence to Alignment Requirements" という節がある。そして `owned_buffers_io` というモジュール群が、この制約を型で扱うために作られている。

```rust title="pageserver/src/virtual_file.rs"
use owned_buffers_io::aligned_buffer::buffer::AlignedBuffer;
use owned_buffers_io::aligned_buffer::{AlignedBufferMut, AlignedSlice, ConstAlign};
use owned_buffers_io::io_buf_aligned::{IoBufAligned, IoBufAlignedMut};
```

**`ConstAlign` はアラインメントを型パラメータに持つ。** アラインされたバッファとされていないバッファが、型として別物になる。direct I/O の API はアラインされた型しか受け取らない。

これが [ページ再構成のための vectored read](../vectored-read/) の結合粒度に効いていた。

```rust
    const CHUNK_SIZE: usize = virtual_file::get_io_buffer_alignment();
```

**最下層のデバイス制約が、読み取り計画のアルゴリズムにまで上がってきている。** 抽象で隠すのではなく、上まで通して最適化に使っている。

## 所有権を持つバッファ

`io_uring` には Rust の借用と噛み合わない性質がある。**カーネルにバッファのポインタを渡した後、操作が完了するまでそのバッファは生きていなければならない。** future を drop しても、カーネルは書き込みを続ける。

だから API が「バッファを借りる」ではなく「バッファを所有権ごと渡して、完了時に返してもらう」形になる。

```rust title="pageserver/src/virtual_file.rs"
pub(crate) mod owned_buffers_io {
    //! Abstractions for IO with owned buffers.
    //!
    //! Not actually tied to [`crate::virtual_file`] specifically, but, it's the primary
    //! reason we need this abstraction.
    //!
    //! Over time, this could move into the `tokio-epoll-uring` crate, maybe `uring-common`,
    //! but for the time being we're proving out the primitives in the neon.git repo
    //! for faster iteration.
```

**「いずれ別 crate に移すかもしれないが、今は速く回すためにここに置く」。** 抽象を切り出すタイミングを、意図的に遅らせている。

`tokio-epoll-uring` は Neon が作った crate で、この抽象の実験場が本体リポジトリの中にある、という関係になっている。

## この先に効いてくること

- **FD もキャッシュ対象。** 開いているように見せて、実際は閉じる。Postgres と同じ手。
- **「速いことがある」より「常に予測可能」。** レイテンシの裾を切る。
- **多層キャッシュの下層は、上層が吸収した後の分布を見る。** 同じアルゴリズムは効かない。
- **カーネルはテナントを知らない。** 資源を明示的に扱いたいなら、カーネルに任せられない。
- **最下層の制約を、隠さずに上まで通す。** アラインメントが読み取り計画の粒度になる。
