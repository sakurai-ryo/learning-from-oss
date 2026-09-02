---
title: "どの LSN のページを要求するか — last-written LSN"
description: "バッファから追い出したページを読み直すとき、どの時点のバージョンを要求すればいいのか。答えは「最後に書いた LSN 以降」で、それを覚えるためだけの共有メモリキャッシュがある。溢れたときの振る舞いに、この設計の芯が出ている。"
group: "compute 側の改造"
sidebar:
  order: 14
---

## 何を学んだか

Neon 固有の概念で、いちばん理解が要るのがこれだ。

問題設定はこうなる。あるページがバッファから追い出された。しばらくして同じページが必要になった。pageserver に要求する。**どの LSN を指定するか。**

- **現在の WAL 末尾** — 正しいが、pageserver がそこまで取り込むのを待たされる。
- **そのページを最後に変更した LSN** — 正しく、かつ待たされない。ページはそれ以降変わっていないので。

後者を選ぶには「そのページを最後に変更した LSN」を覚えておく必要がある。それが last-written LSN (LwLSN) だ。

`docs/core_changes.md` の説明が簡潔だ。

> Whenever a page is evicted from the buffer cache, we remember its LSN, so that we can use the same LSN in the GetPage@LSN request when reading the page back from the page server. The value is conservative: it would be correct to always use the last-inserted LSN, but it would be slow because then the page server would need to wait for the recent WAL to be streamed and processed, before responding to any GetPage@LSN request.

**「保守的な値」**という言い方が重要で、これは**正しさのための仕組みではなく、速さのための仕組み**だということを意味する。正しい答えは常に「最新の WAL 末尾」で、LwLSN はそれを安全に下げるための情報になっている。

## 実装 — LRU 付きの共有ハッシュ表

```c title="pgxn/neon/neon_lwlsncache.c"
typedef struct LastWrittenLsnCacheEntry
{
	BufferTag	key;
	XLogRecPtr	lsn;
	/* double linked list for LRU replacement algorithm */
	dlist_node	lru_node;
} LastWrittenLsnCacheEntry;

typedef struct LwLsnCacheCtl {
	int lastWrittenLsnCacheSize;
	/*
	* Maximal last written LSN for pages not present in lastWrittenLsnCache
	*/
	XLogRecPtr  maxLastWrittenLsn;

	dlist_head lastWrittenLsnLRU;
} LwLsnCacheCtl;
```

([pgxn/neon/neon_lwlsncache.c L17](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/neon_lwlsncache.c#L17))

キーは `BufferTag` — 共有バッファと同じ 5 つ組だ。既定サイズは 128K エントリ。

**`maxLastWrittenLsn` が設計の芯になっている。** キャッシュから落ちたエントリのために、「表に載っていないページ全体の last-written LSN の上限」を 1 つ持っている。

```c title="pgxn/neon/neon_lwlsncache.c"
	/* Maximal last written LSN among all non-cached pages */
	lsn = LwLsnCache->maxLastWrittenLsn;

	if (NInfoGetRelNumber(rlocator) != InvalidOid)
	{
		BufferTag key;
		/* ... */
		entry = hash_search(lastWrittenLsnCache, &key, HASH_FIND, NULL);
		if (entry != NULL)
			lsn = entry->lsn;
```

([pgxn/neon/neon_lwlsncache.c L153](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/neon_lwlsncache.c#L153))

**表にあれば正確な値、なければ上限値。** これは近似だが、常に安全側 (実際の値以上) に倒れている。近似の代償は「待たされる可能性が上がる」であって、間違ったページが返ることではない。

**キャッシュの精度が性能だけを左右し、正しさは左右しない**という構造になっている。だから 128K で溢れても壊れない。溢れたら遅くなるだけだ。

## ミス時に書き戻すという奇妙な処理

`neon_get_lwlsn` は、読み取り関数なのにキャッシュを更新する。

```c title="pgxn/neon/neon_lwlsncache.c"
		else
		{
			LWLockRelease(LastWrittenLsnLock);
			LWLockAcquire(LastWrittenLsnLock, LW_EXCLUSIVE);
			/*
			 * In case of statements CREATE TABLE AS SELECT... or INSERT FROM SELECT... we are fetching data from source table
			 * and storing it in destination table. It cause problems with prefetch last-written-lsn is known for the pages of
			 * source table (which for example happens after compute restart). In this case we get get global value of
			 * last-written-lsn which is changed frequently as far as we are writing pages of destination table.
			 * As a result request-lsn for the prefetch and request-let when this page is actually needed are different
			 * and we got exported prefetch request. So it actually disarms prefetch.
			 * To prevent that, we re-insert the page with the latest LSN, so that it's
			 * less likely the LSN for this page will get evicted from the LwLsnCache
			 * before the page is read.
			 */
			 lsn = SetLastWrittenLSNForBlockRangeInternal(lsn, rlocator, forknum, blkno, 1);
		}
```

([pgxn/neon/neon_lwlsncache.c L176](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/neon_lwlsncache.c#L176))

シナリオはこうだ。

1. `CREATE TABLE AS SELECT` を実行する。読み元テーブルのページを prefetch する
2. そのページは LwLSN 表になく、`maxLastWrittenLsn` (グローバル値) が使われる
3. 書き込み先テーブルのページが次々に追い出され、`maxLastWrittenLsn` がどんどん進む
4. prefetch した結果が届いた頃には、実際に読むときの LwLSN が別の値になっている
5. **prefetch の結果が使えないと判定され、捨てられる**

prefetch のヒットには「要求時と使用時の LSN が一致する」ことが要る。グローバル値は他人の書き込みで動くので、一致しない。

対処は「読んだときに、その値でエントリを作り直す」。**エントリが表にある限り値は動かないので、prefetch が成立する。**

副作用として、読んだページが LRU の先頭に来る。次に必要になるまで落ちにくくなる。

**近似のための共有変数が、別の機能 (prefetch) の前提を壊した**という、システムの部品が絡み合う典型例になっている。しかも直し方が「読み取りで書き込む」という、単体で見ると気持ち悪いコードになる。

## 粒度は 3 段ある

ヘッダを見ると、設定側の関数が 4 つある。

```c title="pgxn/neon/neon_lwlsncache.h"
XLogRecPtr neon_set_lwlsn_block_range(XLogRecPtr lsn, NRelFileInfo rlocator, ForkNumber forknum, BlockNumber from, BlockNumber n_blocks);
XLogRecPtr neon_set_lwlsn_block_v(const XLogRecPtr *lsns, NRelFileInfo relfilenode, ForkNumber forknum, BlockNumber blockno, int nblocks);
XLogRecPtr neon_set_lwlsn_block(XLogRecPtr lsn, NRelFileInfo rlocator, ForkNumber forknum, BlockNumber blkno);
XLogRecPtr neon_set_lwlsn_relation(XLogRecPtr lsn, NRelFileInfo rlocator, ForkNumber forknum);
XLogRecPtr neon_set_lwlsn_db(XLogRecPtr lsn);
```

([pgxn/neon/neon_lwlsncache.h](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/neon_lwlsncache.h))

- **ブロック単位** — 通常の追い出し
- **リレーション単位** — `TRUNCATE` や、リレーションのメタデータ更新
- **DB 単位** — `CREATE DATABASE` などの一括操作

リレーション単位は、ブロック番号を `InvalidBlockNumber` にした擬似キーで表現している。コメントに書いてある。

```c title="pgxn/neon/neon_lwlsncache.c"
 * Also to provide request LSN for smgrnblocks, smgrexists there is pseudokey=InvalidBlockId which stores LSN of last
 * relation metadata update.
```

**「リレーションのサイズはいつ変わったか」も LwLSN で管理する必要がある。** `smgrnblocks()` の要求にも LSN が要るからだ。ページと同じ仕組みに擬似キーで相乗りしている。[リレーションはファイルである](../relation-files/) で見た `rel_size_to_key` (pageserver 側でブロック番号 `0xffffffff` を予約) と、発想が同じだ。

## 本体にも数か所パッチが要った

ほとんどの LwLSN 更新は `smgrwrite()` の中で自動的に起きるが、それでは捕まえられない経路がある。

> The last-written page LSN is mostly tracked in the smgrwrite() function, without core code changes, but there are a few exceptions where we've had to add explicit calls to the Neon-specific SetLastWrittenPageLSN() function.

`dbcommands.c` (CREATE DATABASE のファイルコピー方式) と `spginsert.c` に明示的な呼び出しが入っている。

**「1 か所を押さえれば全部捕まる」はだいたい嘘で、必ず例外がある。** そしてその例外は網羅的に探すしかない。Neon がゼロ LSN 追い出しで PANIC する検査を入れているのは ([共有バッファ](../buffer-manager/))、この網羅を実行時に確かめるためでもある。

## この先に効いてくること

- **LwLSN は速さのための近似で、正しさには関与しない。** だから溢れてよく、保守的に倒せばよい。
- **溢れたときの代替値が、別の機能の前提を壊した。** prefetch の LSN 一致条件。システムは絡み合う。
- **メタデータ更新にも LSN が要る。** 擬似キーで同じ表に相乗り。
- **「1 か所を押さえる」には例外がある。** 例外を実行時検査で担保している。
