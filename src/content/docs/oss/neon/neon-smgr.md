---
title: "smgr を置き換える — ページ読み取りがネットワーク越しになる"
description: "neon_smgr の 15 個の関数が、ファイル操作をネットワーク要求に翻訳している。しかし全部を翻訳しているわけではない。一時テーブルはローカル、unlogged インデックスビルドもローカル、そして「サイズ」という概念は作り直された。"
group: "compute 側の改造"
sidebar:
  order: 13
---

## 何を学んだか

Neon の compute で `SELECT` がページを読むとき、最終的に呼ばれるのは `neon_readv()` だ。関数テーブルはこう埋まっている。

```c title="pgxn/neon/pagestore_smgr.c"
static const struct f_smgr neon_smgr =
{
	.smgr_init = neon_init,
	.smgr_shutdown = NULL,
	.smgr_open = neon_open,
	.smgr_close = neon_close,
	.smgr_create = neon_create,
	.smgr_exists = neon_exists,
	.smgr_unlink = neon_unlink,
	.smgr_extend = neon_extend,
	.smgr_zeroextend = neon_zeroextend,
	.smgr_prefetch = neon_prefetch,
	.smgr_readv = neon_readv,
	.smgr_writev = neon_writev,
	.smgr_writeback = neon_writeback,
	.smgr_nblocks = neon_nblocks,
	.smgr_truncate = neon_truncate,
	.smgr_immedsync = neon_immedsync,
	.smgr_registersync = neon_registersync,
	.smgr_start_unlogged_build = neon_start_unlogged_build,
	.smgr_finish_unlogged_build_phase_1 = neon_finish_unlogged_build_phase_1,
	.smgr_end_unlogged_build = neon_end_unlogged_build,

	.smgr_read_slru_segment = neon_read_slru_segment,
};
```

([pgxn/neon/pagestore_smgr.c L2218](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/pagestore_smgr.c#L2218))

ファイル操作の語彙が、そのままネットワーク要求の語彙に対応している。

| smgr のメソッド           | Neon がやること                                        |
| ------------------------- | ------------------------------------------------------ |
| `readv`                   | `getpage@lsn` 要求                                     |
| `writev`                  | **何も送らない。** 最後に書いた LSN を記録するだけ     |
| `nblocks`                 | `nblocks` 要求 (relsize キャッシュを先に見る)          |
| `exists`                  | `exists` 要求                                          |
| `extend`                  | ページを WAL に出す (必要なら)。サイズキャッシュを更新 |
| `truncate`                | サイズキャッシュを更新するだけ                         |
| `immedsync` / `writeback` | **no-op**                                              |

**書き込み系がほぼ全部消えている**のが特徴だ。WAL が唯一の書き込み経路なので、smgr は書き込みに関与しない ([共有バッファ](../buffer-manager/))。

## 3 段の分岐 — 何を pageserver に送るか

すべての操作が pageserver に行くわけではない。`neon_writev()` の頭にある分岐が、その判断を全部持っている。

```c title="pgxn/neon/pagestore_smgr.c"
	switch (reln->smgr_relpersistence)
	{
		case 0:
			/* This is a bit tricky. Check if the relation exists locally */
			if (mdexists(reln, debug_compare_local ? INIT_FORKNUM : forknum))
			{
				/* It exists locally. Guess it's unlogged then. */
				mdwritev(reln, forknum, blkno, buffers, nblocks, skipFsync);
				return;
			}
			break;

		case RELPERSISTENCE_PERMANENT:
			if (RelFileInfoEquals(unlogged_build_rel_info, InfoFromSMgrRel(reln)))
			{
				mdwritev(reln, forknum, blkno, buffers, nblocks, skipFsync);
				return;
			}
			break;

		case RELPERSISTENCE_TEMP:
		case RELPERSISTENCE_UNLOGGED:
			mdwritev(reln, forknum, blkno, buffers, nblocks, skipFsync);
			return;
		default:
			neon_log(ERROR, "unknown relpersistence '%c'", reln->smgr_relpersistence);
	}

	neon_wallog_pagev(reln, forknum, blkno, nblocks, (const char **) buffers, false);
```

([pgxn/neon/pagestore_smgr.c L1682](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/pagestore_smgr.c#L1682))

**`case 0` が面白い。** `relpersistence` が 0 は「分からない」を意味する。`smgropen()` に渡されなかった経路 (バッファマネージャの一部など) がここに来る。

分からないときの判定が「ローカルにファイルがあるか見る」だ。

```c
			/* It exists locally. Guess it's unlogged then. */
```

**存在推論。** これはきれいな設計ではないが、`relpersistence` を全経路に通す改造をするコストと釣り合わなかったのだろう。「情報が境界を越えていない」問題 ([smgr](../smgr/)) が、完全には解決していないことの痕跡になっている。

**`RELPERSISTENCE_PERMANENT` の分岐**は、GIN/GiST/SP-GiST の unlogged インデックスビルドのためのもの。ビルド中はローカルに書き、終わってから WAL に出す。

## サイズは「聞く」か「覚えている」か

`smgrnblocks()` は Postgres で最も頻繁に呼ばれる smgr メソッドの 1 つだ。プランナも、`INSERT` の空きページ探しも、シーケンシャルスキャンも呼ぶ。

ローカルディスクなら `lseek()` 1 回で済む。ネットワーク越しだと 1 往復になる。頻度を考えるとこれは致命的なので、compute 側にキャッシュがある (`relsize_cache.c`)。

キャッシュの更新は smgr の各メソッドが分担する。`neon_extend` が伸ばし、`neon_truncate` が縮め、`neon_nblocks` がミス時に問い合わせて埋める。

**「ファイルサイズ」という、ファイルシステムが無料で提供していた情報が、明示的に維持しなければならない状態になった。** [リレーションはファイルである](../relation-files/) で見たとおり、pageserver 側でもサイズは予約キーとして保存されている。同じ情報が 3 か所 (キャッシュ、pageserver のキー、WAL レコードの含意) にある。

## 要求 LSN の決定 — この関数がいちばん難しい

`neon_readv()` が実際にやることの半分は、「どの LSN を要求するか」の決定だ。

```c title="pgxn/neon/pagestore_smgr.c"
neon_get_request_lsns(NRelFileInfo rinfo, ForkNumber forknum, BlockNumber blkno,
					  neon_request_lsns *output, BlockNumber nblocks)
{
	XLogRecPtr	last_written_lsns[PG_IOV_MAX];

	Assert(nblocks <= PG_IOV_MAX);

	neon_get_lwlsn_v(rinfo, forknum, blkno, (int) nblocks, last_written_lsns);
```

([pgxn/neon/pagestore_smgr.c L507](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/pagestore_smgr.c#L507))

プライマリの結論はこうなる。

```c title="pgxn/neon/pagestore_smgr.c"
			result->request_lsn = UINT64_MAX;
			result->not_modified_since = last_written_lsn;
			result->effective_request_lsn = last_written_lsn;
```

([pgxn/neon/pagestore_smgr.c L702](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/pagestore_smgr.c#L702))

**要求 LSN は `UINT64_MAX` — つまり「最新をくれ」。** 現在の WAL 挿入位置ではない。理由がコメントにある。

> However, there's a corner case with pageserver's garbage collection. If the GC horizon is set to a very small value, it's possible that by the time that the pageserver processes our request, the GC horizon has already moved past the LSN we calculate here.

**具体的な LSN を指定すると、要求が pageserver に届く頃にはその LSN が GC で消えているかもしれない。** 「最新」は消えようがない。GC の地平線より必ず新しいので。

`not_modified_since` に last-written LSN を入れることで、pageserver は待たされずに済む ([読み取りパス](../read-path/))。この 2 つの組み合わせで、**「最新が欲しいが、待つ必要はない」**という一見矛盾した要求が表現できている。

## 「LSN が flush より進んでいる」ケース

同じ関数に、WAL 規則の例外への対処がある。

```c title="pgxn/neon/pagestore_smgr.c"
			/*
			 * Is it possible that the last-written LSN is ahead of last flush
			 * LSN? Generally not, we shouldn't evict a page from the buffer cache
			 * before all its modifications have been safely flushed. That's the
			 * "WAL before data" rule. However, such case does exist at index
			 * building, _bt_blwritepage logs the full page without flushing WAL
			 * before smgrextend (files are fsynced before build ends).
			 */
			if (last_written_lsn > flushlsn)
			{
				XLogFlush(last_written_lsn);
			}
```

([pgxn/neon/pagestore_smgr.c L647](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/pagestore_smgr.c#L647))

btree のビルドは、ページを WAL に書いてから flush せずに `smgrextend` する。ローカルディスクなら、ビルド終了時にまとめて fsync すればいいので問題ない。Neon では、そのページを pageserver に要求した瞬間に問題になる — **pageserver はまだそのレコードを見ていない**からだ。

対処は「その場で flush する」。**同期の境界が変わったせいで、遅延させてよかった処理が遅延させられなくなった**という、分解の副作用がそのまま現れている。

## レプリカのときの判断

`RecoveryInProgress()` の分岐には、この章でいちばん長いコメントブロックが付いている。60 行以上ある。要点は 1 つで、**「WAL を replay している最中に、その replay 対象のページを読むとき、どの LSN を指定すべきか」**という問いだ。

> 1. Startup process reads a page, last_written_lsn is old.
>
> Read the old version of the page. We will apply the WAL record on it to bring it up-to-date.
>
> We could read the new version, with the changes from this WAL record already applied, to offload the work of replaying the record to the pageserver. The pageserver might not have received the WAL record yet, though, so a read of the old page version and applying the record ourselves is likely faster.

**同じ WAL レコードを 2 か所で適用できてしまう**という、分解によって生まれた新しい選択肢がある。replica が自分で適用してもいいし、pageserver に適用させた結果を取ってきてもいい。

判断基準は「pageserver がまだ受け取っていないかもしれない」。待つより自分でやったほうが速い。加えて「redo 関数が驚くかもしれない」— 変更済みのページに redo を当てるのは、クラッシュリカバリでは正常だがホットスタンバイでは想定外だ、という指摘も入っている。

そして続くケース 2 の議論は、ほぼ「これは起こらないはずだが、起きても正しく動くようにしてある」という内容になっている。

> Even if the one of the above cases were possible in theory, they would also require the pages being modified by the redo function to be immediately evicted from the page cache.
>
> So this probably does not happen in practice. But if it does, we request the new version, including the changes from the record being replayed. That seems like the correct behavior in any case.

**起こらないと信じているケースにも、正しい振る舞いを定義してある。** 起こり得ないと assert して落とすのではなく。分解によって「絶対に起きない」の根拠が弱くなったことを自覚した書き方になっている。

## この先に効いてくること

- **smgr の書き込み系はほぼ全部消える。** WAL が唯一の書き込み経路。
- **何をローカルに残すかの判断が `relpersistence` の分岐に集約されている。** 一時テーブル、unlogged、インデックスビルド中。
- **要求 LSN は「最新 + 変更なし保証」の組。** GC で消えない側を指定しつつ、待たない。
- **遅延させてよかった fsync が、遅延させられなくなる。** 同期の境界が変わることの副作用。
