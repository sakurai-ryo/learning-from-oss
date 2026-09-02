---
title: "共有バッファ — ページの出入りが必ず通る 1 箇所"
description: "Postgres のすべてのページアクセスは shared_buffers を通る。読むときは ReadBuffer、追い出すときは FlushBuffer。この 2 つの出入口が smgr を呼ぶ唯一の場所であり、Neon が「書き戻し」を「WAL に記録する」へ置き換えた場所でもある。"
group: "前提 — Postgres の内部"
sidebar:
  order: 4
---

## 何を学んだか

Postgres がディスク上のページに触るとき、必ず共有バッファ (shared_buffers) を経由する。バッファは 8KB の配列で、それぞれに記述子が付く。

```c title="src/include/storage/buf_internals.h"
typedef struct BufferDesc
{
	BufferTag	tag;			/* ID of page contained in buffer */
	int			buf_id;			/* buffer's index number (from 0) */

	/* state of the tag, containing flags, refcount and usagecount */
	pg_atomic_uint32 state;

	int			wait_backend_pgprocno;	/* backend of pin-count waiter */
	int			freeNext;		/* link in freelist chain */
	LWLock		content_lock;	/* to lock access to buffer contents */
} BufferDesc;
```

([src/include/storage/buf_internals.h L245](https://github.com/postgres/postgres/blob/REL_17_5/src/include/storage/buf_internals.h#L245))

タグが、そのバッファに載っているページの identity だ。

```c title="src/include/storage/buf_internals.h"
typedef struct buftag
{
	Oid			spcOid;			/* tablespace oid */
	Oid			dbOid;			/* database oid */
	RelFileNumber relNumber;	/* relation file number */
	ForkNumber	forkNum;		/* fork number */
	BlockNumber blockNum;		/* blknum relative to begin of reln */
} BufferTag;
```

([src/include/storage/buf_internals.h L93](https://github.com/postgres/postgres/blob/REL_17_5/src/include/storage/buf_internals.h#L93))

[リレーションはファイルである](../relation-files/) で見た 5 つ組そのままだ。Postgres の中で「ページを指す」といえば必ずこの形になる。Neon の `Key` もこれを写している。

`state` は 32 ビットのアトミック変数に 3 つの情報を詰め込んでいる。

```c title="src/include/storage/buf_internals.h"
#define BM_DIRTY				(1U << 23)	/* data needs writing */
#define BM_VALID				(1U << 24)	/* data is valid */
#define BM_TAG_VALID			(1U << 25)	/* tag is assigned */
#define BM_IO_IN_PROGRESS		(1U << 26)	/* read or write in progress */
```

下位 18 ビットが refcount (pin 数)、その上 4 ビットが usagecount、上位がフラグ。1 回の CAS でフラグとカウンタを同時に更新できるようにするための詰め込みだ。バッファ記述子を 64 バイト (キャッシュライン) に収めるという制約がコメントに明記されている。

## 2 つの出入口

バッファマネージャが smgr を呼ぶ場所は、実質 2 つしかない。

**読み込み。** 欲しいページがバッファにない → 空きバッファを確保 → `smgrreadv()` で読む → `BM_VALID` を立てる。

**追い出し。** 空きバッファがない → clock sweep で犠牲を選ぶ → もし `BM_DIRTY` なら `FlushBuffer()` して `smgrwritev()` → タグを付け替えて再利用。

clock sweep は近似 LRU で、`usagecount` (最大 5) を巡回しながら 1 ずつ減らし、0 になったバッファを犠牲にする。pin されている (refcount > 0) バッファは選べない。

この 2 つの出入口が smgr を呼ぶ唯一の場所だという事実が、**smgr を差し替えるだけでストレージ全体を置き換えられる**ことの根拠になっている ([smgr — Postgres が最初から持っていた差し替え口](../smgr/))。

## 追い出しの前に WAL を flush する

`FlushBuffer()` の本体には、WAL 規則がそのまま書かれている。

```c title="src/backend/storage/buffer/bufmgr.c"
	/*
	 * Run PageGetLSN while holding header lock, since we don't have the
	 * buffer locked exclusively in all cases.
	 */
	recptr = BufferGetLSN(buf);

	/* To check if block content changes while flushing. - vadim 01/17/97 */
	buf_state &= ~BM_JUST_DIRTIED;
	UnlockBufHdr(buf, buf_state);

	/*
	 * Force XLOG flush up to buffer's LSN.  This implements the basic WAL
	 * rule that log updates must hit disk before any of the data-file changes
	 * they describe do.
	 */
```

([src/backend/storage/buffer/bufmgr.c L3815](https://github.com/postgres/postgres/blob/REL_17_5/src/backend/storage/buffer/bufmgr.c#L3815))

ページの先頭 8 バイトに入っている LSN を読み、そこまで WAL を fsync してからページを書く。この順序が守られている限り、クラッシュしてもデータファイルの状態は必ず WAL から再現できる。

**Postgres にとって、ページの書き戻しは「永続化」ではない。永続化は WAL がやっている。** 書き戻しは、クラッシュリカバリで読み直す WAL の量を減らすための最適化にすぎない。

この理解が、Neon が「書き戻しをやめる」という判断に踏み切れた理由になる。

## Neon では追い出しが「記録」になる

Neon の smgr は書き込みを受け取っても、どこにも書かない。やることは 1 つだけだ。

```c title="pgxn/neon/pagestore_smgr.c"
	/*
	 * Remember the LSN on this page. When we read the page again, we must
	 * read the same or newer version of it.
	 */
	neon_set_lwlsn_block(lsn, InfoFromSMgrRel(reln), forknum, blocknum);
```

([pgxn/neon/pagestore_smgr.c L443](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/pagestore_smgr.c#L443))

**ページを捨てて、そのページの LSN だけ覚える。** 次に同じページが必要になったら、この LSN 以上のバージョンを pageserver に要求すればいい ([どの LSN のページを要求するか](../last-written-lsn/))。

ここで面白いのは、Postgres の「ページ書き戻しは最適化にすぎない」という性質を、Neon が**逆向きに使っている**ことだ。書き戻しが必須でないなら、やらなくてよい。やらなくてよいなら、compute はディスクを持たなくてよい。

## ただし、前提が 1 つ崩れる

Postgres には「WAL に出していなくてもページはファイルに残る」ことに依存したコードがある。それが Neon では静かにデータを失う。

Neon はここを実行時検査にした。

```c title="pgxn/neon/pagestore_smgr.c"
			/*
			 * Its a bad sign if there is a page with zero LSN in the buffer
			 * cache in a standby, too. However, PANICing seems like a cure
			 * worse than the disease, as the damage has likely already been
			 * done in the primary. So in a standby, make this an assertion,
			 * and in a release build just LOG the error and soldier on.
			 */
			ereport(RecoveryInProgress() ? LOG : PANIC,
					(errmsg(NEON_TAG "Page %u of relation %u/%u/%u.%u is evicted with zero LSN",
```

([pgxn/neon/pagestore_smgr.c L410 付近](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/pagestore_smgr.c#L410))

**LSN がゼロのダーティページが追い出されたら PANIC する。** それは「WAL に一度も出ていないページが捨てられようとしている」という意味で、そのまま進めば静かに壊れる。プライマリでは落とし、スタンバイでは既に手遅れなので記録だけして続行する、という判断も明示的だ。

例外も列挙されている。全ゼロページ (リレーション拡張の途中)、空の heap ページ (INSERT がページ初期化後にエラーで抜けた場合)、FSM と VM (もともと WAL に出ないことがある)。

**「移植先で成立しなくなる暗黙の前提」を、事故として検出する仕掛けに変えている。** データを失ってから気付くのではなく、失う瞬間に落ちる。

FSM と VM については、さらに救済がある。

```c title="pgxn/neon/pagestore_smgr.c"
	/*
	 * Whenever a VM or FSM page is evicted, WAL-log it. FSM and (some) VM
	 * changes are not WAL-logged when the changes are made, so this is our
	 * last chance to log them, otherwise they're lost. That's OK for
	 * correctness, the non-logged updates are not critical. But we want to
	 * have a reasonably up-to-date VM and FSM in the page server.
	 */
```

追い出される瞬間に `log_newpage_copy()` でページ全体を WAL に書く。**正しさには影響しないが、失うと性能が落ちる**種類のデータを、追い出しのタイミングで救い上げている。

## この先に効いてくること

- **ページアクセスは全部バッファマネージャを通り、バッファマネージャは smgr しか呼ばない。** 差し替えの境界がここに引ける。
- **書き戻しは永続化ではない。** 永続化は WAL がやる。だから書き戻しをやめられる。
- **前提が崩れる箇所は検査に変える。** ゼロ LSN の追い出しで PANIC する、という 1 つのチェックが、移植の穴を塞いでいる。
- **バッファから落ちたページの LSN を覚えるという新しい状態が要る。** Neon 固有の概念で、共有メモリ上のキャッシュとして実装されている。
