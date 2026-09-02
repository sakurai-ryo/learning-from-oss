---
title: "redo — WAL レコードはページに対する関数である"
description: "リカバリは WAL を頭から読んで rmgr の redo 関数に渡すループでしかない。この「ページ + WAL レコード → 新しいページ」という純関数的な形が、Neon がページ再構成を Postgres プロセスに丸ごと委譲できた理由になる。"
group: "前提 — Postgres の内部"
sidebar:
  order: 6
---

## 何を学んだか

クラッシュリカバリの本体は、驚くほど短く言える。

1. `pg_control` から直近のチェックポイントを読む
2. その `redo` LSN から WAL を順に読む
3. 各レコードについて `RmgrTable[record->xl_rmid].rm_redo(record)` を呼ぶ
4. WAL の末尾まで繰り返す

rmgr のテーブルは 1 枚のリストで定義されている。

```c title="src/include/access/rmgrlist.h"
/* symbol name, textual name, redo, desc, identify, startup, cleanup, mask, decode */
PG_RMGR(RM_XLOG_ID, "XLOG", xlog_redo, xlog_desc, xlog_identify, NULL, NULL, NULL, xlog_decode)
PG_RMGR(RM_XACT_ID, "Transaction", xact_redo, xact_desc, xact_identify, NULL, NULL, NULL, xact_decode)
PG_RMGR(RM_SMGR_ID, "Storage", smgr_redo, smgr_desc, smgr_identify, NULL, NULL, NULL, NULL)
/* ... */
PG_RMGR(RM_HEAP_ID, "Heap", heap_redo, heap_desc, heap_identify, NULL, NULL, heap_mask, heap_decode)
PG_RMGR(RM_BTREE_ID, "Btree", btree_redo, btree_desc, btree_identify, btree_xlog_startup, btree_xlog_cleanup, btree_mask, NULL)
```

([src/include/access/rmgrlist.h L28](https://github.com/postgres/postgres/blob/REL_17_5/src/include/access/rmgrlist.h#L28))

同じマクロを違う定義で 3 回インクルードして、enum・関数テーブル・名前テーブルを生成する典型的な X-macro だ。**WAL のフォーマットは中央集権的に定義されておらず、各アクセスメソッドが自分の分だけ知っている。**

`rm_redo` の中身は、どれも同じ形をしている。

```c
action = XLogReadBufferForRedo(record, 0, &buffer);
if (action == BLK_NEEDS_REDO)
{
    Page page = BufferGetPage(buffer);
    /* ページを書き換える */
    PageSetLSN(page, lsn);
    MarkBufferDirty(buffer);
}
```

`XLogReadBufferForRedo` の戻り値が、redo 関数の分岐をすべて決めている。

```c title="src/include/access/xlogutils.h"
/* Result codes for XLogReadBufferForRedo[Extended] */
typedef enum
{
	BLK_NEEDS_REDO,				/* changes from WAL record need to be applied */
	BLK_DONE,					/* block is already up-to-date */
	BLK_RESTORED,				/* block was restored from a full-page image */
	BLK_NOTFOUND,				/* block was not found (and hence does not
								 * need to be replayed) */
} XLogRedoAction;
```

([src/include/access/xlogutils.h L69](https://github.com/postgres/postgres/blob/REL_17_5/src/include/access/xlogutils.h#L69))

- `BLK_NEEDS_REDO` — 差分を当てる
- `BLK_RESTORED` — FPI を貼ったので、redo 関数は何もしなくてよい
- `BLK_DONE` — ページの LSN のほうが新しい。すでに適用済み
- `BLK_NOTFOUND` — ページが存在しない (後で truncate される等)

`BLK_DONE` があることが、**redo が冪等である**ことを保証している。ページの LSN とレコードの LSN を比べて、既に当たっていれば飛ばす。だから同じ WAL を 2 回 replay しても壊れない。クラッシュリカバリの途中でまたクラッシュしても大丈夫なのはこれによる。

## この形が Neon にとって意味すること

redo 関数の型を抽象化するとこうなる。

```
redo : (Page, WalRecord) -> Page
```

**入力はページ 1 枚と WAL レコード 1 つ、出力はページ 1 枚。** グローバルな状態にほとんど依存しない、ほぼ純粋な関数だ。

Neon の pageserver がやりたいことは、まさにこれだった。「LSN 100 のページ画像に、LSN 100〜250 の WAL レコードを順に当てて、LSN 250 のページを作る」。リカバリと同じ操作を、リカバリではない文脈で、任意のタイミングで、任意のページに対してやりたい。

この関数を Rust で書き直す道もあった。`docs/core_changes.md` はその選択肢を検討して、はっきり否定している。

> As an alternative to having a separate WAL redo process, we could rewrite all redo handlers in Rust This is infeasible. However, it would take a lot of effort to rewrite them, ensure that you've done the rewrite correctly, and once you've done that, it would be a lot of ongoing maintenance effort to keep the rewritten code in sync over time, across new PostgreSQL versions.

**問題は初期コストではなく、追随コストだ。** Postgres は毎年メジャーバージョンが出て、redo 関数も変わる。4 つのメジャーバージョンを同時にサポートしている Neon で、全 rmgr の redo を独自実装して同期を取り続けるのは、破綻が見えている。

だから Neon は、**Postgres のバイナリをそのまま子プロセスとして起動し、ページと WAL レコードを渡して、返ってきたページを受け取る**という方式を選んだ ([walredo — ページ再構成を Postgres そのものに委譲する](../walredo/))。

## 「1 ページだけ redo する」ための本体改造

ただし、そのままでは無駄が出る。1 つの WAL レコードが 3 ページに触ることがあり、pageserver が欲しいのはそのうち 1 ページだけだ。残り 2 ページの redo は完全な無駄になる。

Neon は `XLogReadBufferForRedoExtended` にフックを入れた。

```c title="src/backend/access/transam/xlogutils.c"
bool	(*redo_read_buffer_filter) (XLogReaderState *record, uint8 block_id);
```

```c title="src/backend/access/transam/xlogutils.c"
	if (redo_read_buffer_filter && redo_read_buffer_filter(record, block_id))
	{
		if (mode == RBM_ZERO_AND_LOCK || mode == RBM_ZERO_AND_CLEANUP_LOCK)
		{
			*buf = ReadBufferWithoutRelcache(rlocator, forknum,
											 blkno, mode, NULL, true);
			return BLK_DONE;
		}
		else
		{
			*buf = InvalidBuffer;
			return BLK_DONE;
		}
	}
```

([src/backend/access/transam/xlogutils.c L375](https://github.com/neondatabase/postgres/blob/1e01fcea2a6b38180021aa83e0051d95286d9096/src/backend/access/transam/xlogutils.c#L375))

**対象外のページには `BLK_DONE` を返す。** redo 関数から見れば「もう適用済みだから何もしなくていい」に見え、既存の分岐がそのまま使える。新しい戻り値を足さずに、既存の意味を借りたのがうまい。

しかしこれが一部の rmgr を壊した。`docs/core_changes.md` に例がある。

```c
-       if (XLogReadBufferForRedo(record, 0, &lbuffer) != BLK_RESTORED)
+       action = XLogReadBufferForRedo(record, 0, &lbuffer);
+       if (action != BLK_RESTORED && action != BLK_DONE)
                elog(ERROR, "GIN split record did not contain a full-page image of left page");
```

GIN の split レコードは「左ページには必ず FPI が付いている」ことを知っているので、`BLK_RESTORED` 以外が返ったらバグとしてエラーにしていた。ところが Neon のフィルタは `BLK_DONE` を返す。

**「起こり得ない」と書かれた assert は、環境を変えると起こる。** そして直し方は、その assert を緩めることになる。GIN・GiST・SP-GiST に同じパッチが当たっている。

## リカバリと Neon の replica

Neon には read replica もあり、これは普通の Postgres のホットスタンバイに近い形で動く。safekeeper から WAL を受け取って redo する。ただしページはローカルになく pageserver から来るので、「redo しようとしたページが手元のバッファにない」ことが常態になる。

このとき replica は 2 つの選択肢を持つ。

- ページをバッファに読み込んで redo する
- **何もしない**

後者でよい。そのページの更新は pageserver 側でも取り込まれるので、replica が次にそのページを読むときには、更新済みのバージョンが返ってくる。**同じ WAL を 2 か所で適用する必要はなく、ページの持ち主が 1 回適用すればいい。**

これは分解によって得られた性質だ。モノリスの Postgres ではスタンバイが自分のデータファイルを持つので、自分で適用するしかなかった。

## この先に効いてくること

- **redo は (ページ, レコード) → ページ の関数。** この形だから外部プロセスに切り出せた。
- **redo は冪等。** `BLK_DONE` の存在がそれを支えている。pageserver が同じ WAL を再取り込みしても壊れない根拠でもある。
- **rmgr は分散した定義。** 中央のパーサがないので、Neon 側も rmgr ごとに解釈を書く必要がある ([walingest](../walingest/))。
- **「起こり得ない」の assert が移植で壊れる。** 環境の前提が変わると、防御的なコードのほうが先に折れる。
