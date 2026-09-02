---
title: "neon_rmgr — WAL の語彙を増やす"
description: "Postgres の WAL には拡張が独自レコード型を登録する仕組みがある。Neon はそこに rmgr を 1 つ足して、heap の INSERT/UPDATE/DELETE をまるごと自分のレコード型に置き換えた。理由はフィールド 1 つ、t_cid のためだ。"
group: "compute 側の改造"
sidebar:
  order: 15
---

## 何を学んだか

Postgres 15 から、拡張が独自の WAL リソースマネージャを登録できるようになった。Neon はこれを使っている。

```c title="pgxn/neon_rmgr/neon_rmgr.c"
const static RmgrData NeonRmgr = {
	.rm_name = "neon",
	.rm_redo = neon_rm_redo,
	.rm_desc = neon_rm_desc,
	.rm_identify = neon_rm_identify,
	.rm_startup = neon_rm_startup,
	.rm_cleanup = neon_rm_cleanup,
	.rm_mask = neon_rm_mask,
	.rm_decode = neon_rm_decode,
};

void
_PG_init(void)
{
	if (!process_shared_preload_libraries_in_progress)
		return;

	RegisterCustomRmgr(RM_NEON_ID, &NeonRmgr);
}
```

([pgxn/neon_rmgr/neon_rmgr.c L34](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon_rmgr/neon_rmgr.c#L34))

ID は勝手に決めていない。

```c title="src/include/access/neon_xlog.h"
/*
 * The RMGR id of the Neon RMGR
 *
 * Reserved at https://wiki.postgresql.org/wiki/CustomWALResourceManagers
 */
#define RM_NEON_ID 134
```

([src/include/access/neon_xlog.h L11](https://github.com/neondatabase/postgres/blob/1e01fcea2a6b38180021aa83e0051d95286d9096/src/include/access/neon_xlog.h#L11))

**PostgreSQL の wiki に ID の登録簿がある。** 中央のレジストリが wiki のページ 1 枚、というのは牧歌的だが、rmgr ID は 1 バイトしかないので運用としては十分に機能している。

## 何を定義したか

レコード型は、heap の既存レコードと 1 対 1 に対応している。

```c title="src/include/access/neon_xlog.h"
/* from XLOG_HEAP_* */
#define XLOG_NEON_HEAP_INSERT		0x00
#define XLOG_NEON_HEAP_DELETE		0x10
#define XLOG_NEON_HEAP_UPDATE		0x20
#define XLOG_NEON_HEAP_HOT_UPDATE	0x30
#define XLOG_NEON_HEAP_LOCK			0x40
/* from XLOG_HEAP2_* */
#define XLOG_NEON_HEAP_MULTI_INSERT	0x50
```

([src/include/access/neon_xlog.h L16](https://github.com/neondatabase/postgres/blob/1e01fcea2a6b38180021aa83e0051d95286d9096/src/include/access/neon_xlog.h#L16))

**新しい操作を足したのではない。既存の操作を、別のレコード型で表現し直した。** 違いは 1 フィールドだけだ。

```c title="src/include/access/neon_xlog.h"
typedef struct xl_neon_heap_header {
	uint16		t_infomask2;
	uint16		t_infomask;
	uint32		t_cid;
	uint8		t_hoff;
} xl_neon_heap_header;
```

本家の `xl_heap_header` は `t_infomask2` / `t_infomask` / `t_hoff` の 3 つで、`t_cid` がない。**このフィールド 1 つのために、rmgr を 1 つ作った。**

## なぜ t_cid が要るのか

[MVCC・xid・SLRU](../mvcc-and-xid/) で触れた話の実装側になる。

Postgres は WAL にコマンド ID を書かない。リカバリで必要にならないからだ。リカバリが走る時点で、そのトランザクションはもう終わっている。

Neon では終わっていない。ページの再構成が通常運転で起きるので、**実行中のトランザクションが自分で挿入した行を、WAL から再構成したページの上で読む**ことになる。cid が失われていると、その行が自分に見えなくなる。

`docs/core_changes.md` の表現がそのままだ。

> But with Neon, we rely on WAL replay to reconstruct the page, even while the original transaction is still running.

## なぜ heap のレコード形式を直接変えなかったのか

`t_cid` を `xl_heap_header` に足すだけでも動く。実際 `docs/core_changes.md` はその方法で書かれている ("We have added a new t_cid field to heap WAL records")。

しかし実装は rmgr を分ける形になった。得られるものが 3 つある。

**1. レコードが「違うもの」だと名乗れる。** `pg_waldump` は rmgr ID を見て `neon` と表示する。素の Postgres が読んだら「知らない rmgr」としてエラーになる。**壊れた Heap レコードとして誤読される**より、はるかに良い。

**2. 本家の heap redo をそのまま残せる。** `RM_HEAP_ID` の redo 関数は無傷なので、Neon の rmgr がない環境でも過去の WAL は読める。混在した WAL ストリームが成立する。

**3. 拡張の中に置ける。** `neon_rmgr.c` は `pgxn/` の下にあり、Postgres 本体のファイルではない。redo の実装は拡張が持つ。

ただし、**レコードを発行する側は本体を変えるしかなかった**。

```c title="src/backend/access/heap/heapam.c"
		xlhdr.t_infomask2 = heaptup->t_data->t_infomask2;
		xlhdr.t_infomask = heaptup->t_data->t_infomask;
		xlhdr.t_hoff = heaptup->t_data->t_hoff;
		xlhdr.t_cid = HeapTupleHeaderGetRawCommandId(heaptup->t_data);
		/* ... */
		recptr = XLogInsert(RM_NEON_ID, info);
```

([src/backend/access/heap/heapam.c L2155](https://github.com/neondatabase/postgres/blob/1e01fcea2a6b38180021aa83e0051d95286d9096/src/backend/access/heap/heapam.c#L2155))

`heapam.c` の `heap_insert()` が、`RM_HEAP_ID` ではなく `RM_NEON_ID` を書くようになっている。**WAL を出す場所にはフックがない。** rmgr の登録はできても、「どの rmgr のレコードを出すか」は各アクセスメソッドが直接決めている。

読む側 (redo) は拡張できるが、書く側は拡張できない。**拡張点は往々にして片方向にしか開いていない**という話になる。

## rm_decode — 論理レプリケーションも面倒を見る

`RmgrData` に `rm_decode` があるのが目を引く。`neon_rmgr_decode.c` は 22KB あり、redo 本体 (25KB) と同じくらいの規模だ。

論理デコードは WAL を読んで「どの行が挿入・更新・削除されたか」を復元する。heap のレコードを解釈するコードが `heapam.c` の隣にあるので、レコード型を変えたらそれも書き直す必要がある。

**フォーマットを変えると、そのフォーマットを読むすべての消費者を書き直すことになる。** redo だけでは済まない。論理デコード、`rm_desc` (pg_waldump の表示)、`rm_mask` (`wal_consistency_checking` のためのマスク処理)、全部だ。`RmgrData` のフィールドがそのまま「書き直しの一覧」になっている。

## 副作用 — WAL の互換性が切れる

この変更で、**Neon が生成した WAL は素の Postgres では読めない**。他にもう 1 つ、非互換な変更がある。

> Starting with v16, when PostgreSQL extends a relation, it first extends it with zeros, and it can extend the relation more than one block at a time. The all-zeros page is WAL-ogged, but it's very wasteful to include 8 kB of zeros in the WAL for that. This hack was made so that we WAL logged a compact record with a whole-page "hole". However, PostgreSQL has assertions that prevent that such WAL records from being replayed, so this breaks compatibility such that unmodified PostreSQL cannot process Neon-generated WAL.

全ゼロのページを「ページ全体が hole」として表現する。FPI のヘッダには「このページのここからここまでは空なので省略した」という hole の表現があり、それを 8KB 全体に適用した。本家には「hole がページ全体」を弾く assert がある。

**フォーマットの隙間を使った圧縮**で、8KB が数十バイトになる。ただし本家では replay できない。

Neon はこの非互換を許容している。compute も pageserver も walredo も、全部 Neon 版の Postgres だからだ。**「自分たちしか読まないなら、フォーマットは自分たちの都合で決めてよい」**という判断が明示的にある。

代償は移行のしにくさで、`docs/core_changes.md` は代替案を挙げている。

> Find another compact representation for a full-page image of an all-zeros page. A compressed image perhaps.

## この先に効いてくること

- **rmgr ID は拡張点で、wiki に登録簿がある。** WAL の語彙は増やせる。
- **読む側は拡張できるが、書く側は本体を触るしかない。** 拡張点は片方向。
- **フォーマットを変えると消費者を全部書き直す。** `RmgrData` のフィールドがその一覧になっている。
- **閉じた系ならフォーマットの互換性は捨てられる。** ただし戻れなくなる。
