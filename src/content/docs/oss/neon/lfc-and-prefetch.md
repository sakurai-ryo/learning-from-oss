---
title: "LFC と prefetch — 往復を隠す 2 つの層"
description: "ネットワーク越しのページ読み取りは、ローカルディスクより 1 桁遅い。compute 側の対処は 2 つある。ローカルファイルに貯める LFC と、要求を先に投げておく prefetch。どちらも Postgres が既に持っていた仕組みの欠落を埋めている。"
group: "compute 側の改造"
sidebar:
  order: 18
---

## 何を学んだか

素の Postgres には、実は 2 段のキャッシュがある。`shared_buffers` と、**OS のページキャッシュ**だ。後者は無料で手に入るので誰も意識しないが、`shared_buffers` を小さめに設定するのが定石なのは、OS のキャッシュが効くからだった。

Neon にはこれがない。ページはファイルシステムから来ないので、OS がキャッシュする対象がない。**分解によって、無料でもらっていた 1 層が消えた。**

その穴を埋めるのが LFC (Local File Cache) だ。

```c title="pgxn/neon/file_cache.c"
 * Local file cache is used to temporary store relations pages in local file system.
 * All blocks of all relations are stored inside one file and addressed using shared hash map.
 * Currently LRU eviction policy based on L2 list is used as replacement algorithm.
 * As far as manipulation of L2-list requires global critical section, we are not using partitioned hash.
 * Also we are using exclusive lock even for read operation because LRU requires relinking element in L2 list.
 * If this lock become a bottleneck, we can consider other eviction strategies, for example clock algorithm.
 *
 * Cache is always reconstructed at node startup, so we do not need to save mapping somewhere and worry about
 * its consistency.
```

([pgxn/neon/file_cache.c L61](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/file_cache.c#L61))

**1 つのファイルに全部詰め、ハッシュ表で位置を引く。** 起動時に必ず空から作り直すので、永続化の心配がない。「キャッシュだから捨ててよい」という性質を最大限に使っている。

ロックの割り切りも明示的だ。LRU の付け替えがあるので読み取りでも排他ロックを取る。ボトルネックになったら clock アルゴリズムに変える、と将来の逃げ道まで書いてある。**現時点で必要ない最適化はやらない**という判断が、コメントとして残されている。

## チャンク単位にした理由

LFC の管理単位は 1 ページではない。

```c title="pgxn/neon/file_cache.c"
/* Local file storage allocation chunk.
 * Should be power of two. Using larger than page chunks can
 * 1. Reduce hash-map memory footprint: 8TB database contains billion pages
 *    and size of hash entry is 40 bytes, so we need 40Gb just for hash map.
 *    1Mb chunks can reduce hash map size to 320Mb.
 * 2. Improve access locality, subsequent pages will be allocated together improving seqscan speed
 */
#define MAX_BLOCKS_PER_CHUNK_LOG  7 /* 1Mb chunk */
```

([pgxn/neon/file_cache.c L90](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/file_cache.c#L90))

**8TB のデータベースなら 10 億ページあり、1 ページ 1 エントリだと索引だけで 40GB になる。** 128 ページ (1MB) を 1 チャンクにすることで 320MB に落ちる。

副次的に局所性も上がる。連続するブロックが同じチャンクに入るので、シーケンシャルスキャンが速くなる。

ただしチャンク内の各ブロックは独立に有効・無効を持つ必要がある。そのために 2 ビットの状態を詰め込んだビット配列を持つ。

```c title="pgxn/neon/file_cache.c"
typedef enum FileCacheBlockState
{
	UNAVAILABLE, /* block is not present in cache */
	AVAILABLE,   /* block can be used */
	PENDING,     /* block is loaded */
	REQUESTED    /* some other backend is waiting for block to be loaded */
} FileCacheBlockState;
```

([pgxn/neon/file_cache.c L114](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/file_cache.c#L114))

`PENDING` と `REQUESTED` の 2 つは、**ロックを持たずに I/O をするため**にある。

```c title="pgxn/neon/file_cache.c"
 * Blocks are read or written to LFC file outside LFC critical section.
 * To synchronize access to such block, writer set state of such block to PENDING.
 * If some other backend (read or writer) see PENDING status, it change it to REQUESTED and start
 * waiting until status is changed on conditional variable.
 * When writer completes is operation, it checks if status is REQUESTED and if so, broadcast conditional variable,
 * waking up all backend waiting for access to this block.
```

`REQUESTED` が別にあることで、**待っている人がいるときだけ条件変数を broadcast すればよくなる**。待ち手がいない普通のケースでは、システムコールが 1 回減る。「グローバルロックを取る」と「読み取りでも排他ロック」という粗い設計の中で、ここだけは細かく最適化されている。

## 縮めるときは穴を開ける

LFC は実行中にサイズを変えられる。縮めるときの実装が変わっている。

```c title="pgxn/neon/file_cache.c"
 * If the soft limit is later reduced, we shrink
 * the LFC by punching holes in the underlying file with a
 * fallocate(FALLOC_FL_PUNCH_HOLE) call. The nominal size of the file doesn't
 * shrink, but the disk space it uses does.
 *
 * Each hole is tracked by a dummy FileCacheEntry, which are kept in the
 * 'holes' linked list. They are entered into the chunk hash table, with a
 * special key where the blockNumber is used to store the 'offset' of the
 * hole, and all other fields are zero. Holes are never looked up in the hash
 * table, we only enter them there to have a FileCacheEntry that we can keep
 * in the linked list.
```

([pgxn/neon/file_cache.c L74](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/file_cache.c#L74))

ファイルの中間を切り詰めることはできないので、**穴を開けてスパースファイルにする**。名目上のサイズは変わらないが、ディスクの消費は減る。

そして穴の管理が独特だ。**穴も `FileCacheEntry` として、決して引かれないキーでハッシュ表に登録する。** 理由はコメントにあるとおりで、リンクリストに繋ぐために `FileCacheEntry` が要るから。

「表に入れるが引かない」という設計は、単体で見れば奇妙だ。既存のデータ構造 (エントリのアロケータとリンクリスト) を再利用するために、意味的には不要な登録をしている。**新しい型を作らずに済ませる代わりに、不変条件が 1 つ増えた**というトレードオフになっている。

## prefetch — ring buffer と、外れたら無駄になる設計

`docs/core_changes.md` はこう書いている。

> There are changes in many places to perform prefetching, for example for sequential scans. Neon doesn't benefit from OS readahead, and the latency to pageservers is quite high compared to local disk, so prefetching is critical for performance, also for sequential scans.

**OS の readahead も消えた。** ファイルを読んでいないので、カーネルが「次のブロックも読むだろう」と先読みしてくれない。

prefetch の実装は backend ローカルのリングバッファになっている。

```c title="pgxn/neon/communicator.c"
 * Prefetch is performed locally by each backend.
 *
 * There can be up to readahead_buffer_size active IO requests registered at
 * any time. Requests using smgr_prefetch are sent to the pageserver, but we
 * don't wait on the response. Requests using smgr_read are either read from
 * the buffer, or (if that's not possible) we wait on the response to arrive -
 * this also will allow us to receive other prefetched pages.
```

([pgxn/neon/communicator.c L126](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/communicator.c#L126))

状態機械は 4 状態。

```c title="pgxn/neon/communicator.c"
typedef enum PrefetchStatus
{
	PRFS_UNUSED = 0,			/* unused slot */
	PRFS_REQUESTED,				/* request was written to the sendbuffer to
								 * PS, but not necessarily flushed. all fields
								 * except response valid */
	PRFS_RECEIVED,				/* all fields valid */
	PRFS_TAG_REMAINS,			/* only buftag and my_ring_index are still
								 * valid */
} PrefetchStatus;
```

`PRFS_TAG_REMAINS` が独特だ。**応答は捨てたが、「この要求を出した」という事実だけ残っている**状態。要求と応答が 1 対 1 で対応するプロトコルなので、要求を出した以上は応答を読み捨てなければならない。そのための記録になっている。

そして重要な制約が明記されている。

```c title="pgxn/neon/communicator.c"
 * NOTE: The current implementation of the prefetch system implements a ring
 * buffer of up to readahead_buffer_size requests. If there are more _read and
 * _prefetch requests between the initial _prefetch and the _read of a buffer,
 * the prefetch request will have been dropped from this prefetch buffer, and
 * your prefetch was wasted.
```

**リングを一周したら prefetch は無駄になる。** エラーにも警告にもならず、静かに捨てられる。

これは prefetch の性質としては正しい。prefetch は「当たれば速い、外れても正しい」ものなので、失敗を扱う必要がない。しかし**チューニングの難しさ**はここから来る。`readahead_buffer_size` が小さすぎると prefetch が全部無駄になり、大きすぎるとメモリと pageserver への負荷が増える。そしてどちらも「遅い」としか観測されない。

[last-written LSN](../last-written-lsn/) で見た「読み取りでキャッシュに書き戻す」処理は、この無駄を減らすための対策だった。要求時と使用時の LSN がずれると、リングに残っていても使えないからだ。

**prefetch のヒット率は、リングのサイズと LwLSN 表のサイズという、無関係に見える 2 つのパラメータに依存している。**

## prewarm — 起動直後の穴を埋める

`docs/core_changes.md` には「まだコミットされていない提案」として prewarming が挙がっているが、LFC のコードには既に実装が入っている。

```c title="pgxn/neon/file_cache.c"
#define MAX_PREWARM_WORKERS 8

typedef struct PrewarmWorkerState
{
	uint32		prewarmed_pages;
	uint32		skipped_pages;
	TimestampTz completed;
} PrewarmWorkerState;
```

([pgxn/neon/file_cache.c L141](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/file_cache.c#L141))

LFC の状態 (どのチャンクが入っていたか) を書き出しておき、次の起動時に最大 8 個のワーカーで並列に取り直す。**「起動が速い」だけでは足りず、「起動直後から速い」を作りにいっている**。

`neon.prewarm_update_ws_estimation` という GUC もある。prewarm で入れたページを working set の推定に含めるかどうか。含めると、実際には誰も触っていないページが「使われている」と数えられてしまう。**キャッシュを暖めることと、キャッシュの利用状況を測ることが干渉する**という、細かいが本質的な問題を扱っている。

働きセットの推定には HyperLogLog (`hll.c`) を使っている。「直近どれだけの異なるページに触ったか」を少ないメモリで数えるためだ。この値は、compute のサイズを自動調整する材料になる。

## この先に効いてくること

- **OS ページキャッシュと OS readahead が消えた。** LFC と prefetch はその代替。
- **キャッシュの管理単位はチャンク。** 索引のメモリ量が単位を決める。
- **prefetch は静かに無駄になる。** 正しさに影響しないので、失敗が観測されない。
- **無関係に見えるパラメータが結合する。** リングサイズと LwLSN 表サイズが同じヒット率を決める。
