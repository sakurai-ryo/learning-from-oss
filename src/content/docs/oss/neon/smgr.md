---
title: "smgr — Postgres が最初から持っていた差し替え口"
description: "Postgres には storage manager switch という関数ポインタ表が 30 年前からある。ただし実装は 1 つしかなく、拡張から差し替えることもできなかった。Neon が最初にやったのは、この「使われていない抽象」を本物の拡張点にすることだった。"
group: "前提 — Postgres の内部"
sidebar:
  order: 3
---

## 何を学んだか

Neon の compute は Postgres そのものだ。フォークしてはいるが、パッチは最小限に抑える方針で、Neon 固有のロジックのほとんどは `pgxn/neon` という拡張の中にある。**ページの読み書きをネットワーク越しにする**という、データベースとしてはかなり根本的な変更を、拡張として書けている。

それができたのは、Postgres に `smgr` — storage manager switch — があったからだ。

```c title="src/include/storage/smgr.h"
typedef struct f_smgr
{
	void		(*smgr_init) (void);	/* may be NULL */
	void		(*smgr_shutdown) (void);	/* may be NULL */
	void		(*smgr_open) (SMgrRelation reln);
	void		(*smgr_close) (SMgrRelation reln, ForkNumber forknum);
	void		(*smgr_create) (SMgrRelation reln, ForkNumber forknum,
								bool isRedo);
	bool		(*smgr_exists) (SMgrRelation reln, ForkNumber forknum);
	void		(*smgr_unlink) (RelFileLocatorBackend rlocator, ForkNumber forknum,
								bool isRedo);
	void		(*smgr_extend) (SMgrRelation reln, ForkNumber forknum,
								BlockNumber blocknum, const void *buffer, bool skipFsync);
	/* ... */
	void		(*smgr_readv) (SMgrRelation reln, ForkNumber forknum,
							   BlockNumber blocknum,
							   void **buffers, BlockNumber nblocks);
	void		(*smgr_writev) (SMgrRelation reln, ForkNumber forknum,
								BlockNumber blocknum,
								const void **buffers, BlockNumber nblocks,
								bool skipFsync);
	BlockNumber (*smgr_nblocks) (SMgrRelation reln, ForkNumber forknum);
	void		(*smgr_truncate) (SMgrRelation reln, ForkNumber forknum,
								  BlockNumber old_blocks, BlockNumber nblocks);
	/* ... */
} f_smgr;
```

([src/include/storage/smgr.h](https://github.com/neondatabase/postgres/blob/1e01fcea2a6b38180021aa83e0051d95286d9096/src/include/storage/smgr.h))

これが「リレーションを構成するページを永続化する何か」に要求される全インターフェースだ。**バッファマネージャから下は、この 15 個ほどの関数ポインタしか呼ばない。** ディスクだろうがネットワークだろうが、この表を埋めれば Postgres は動く。

## ただし、拡張点ではなかった

`smgr` という名前と「switch」という言い方は、複数の実装が並ぶことを想定している。歴史的には磁気ディスクと磁気テープを切り替える構想があった。しかし現実には、30 年間ずっと実装は 1 つだけだった。改造前のコードにその事実がそのまま書いてある。

```c
-		reln->smgr_which = 0;	/* we only have md.c at present */
```

配列 `smgrsw[]` があり、`NSmgr` があり、`smgr_which` というインデックスがあり、そして**その値は常に 0 だった**。しかも配列は `static const` でファイルスコープなので、拡張から要素を足すことはできない。

抽象はあるが、抽象の向こう側に立てる者がいない。**インターフェースが切ってあることと、拡張点であることは別のことだ**、という実例になっている。

## Neon がやった改造

Neon はここを 3 段階で拡張点に変えた。コミットは 1 つで、タイトルは "NEON: Adapt SMGR for extensibility." だ。

**1. 配列をやめて、ディスパッチを関数にする。**

```c title="src/backend/storage/smgr/smgr.c"
const f_smgr *
smgr(ProcNumber backend, RelFileLocator rlocator)
{
	const f_smgr *result;

	if (smgr_hook)
		result = (*smgr_hook)(backend, rlocator);
	else
		result = smgr_standard(backend, rlocator);

	return result;
}
```

([src/backend/storage/smgr/smgr.c L135](https://github.com/neondatabase/postgres/blob/1e01fcea2a6b38180021aa83e0051d95286d9096/src/backend/storage/smgr/smgr.c#L135))

`smgr_which` (整数インデックス) が `const struct f_smgr *smgr` (ポインタ) に変わり、どの実装を使うかの判断が**リレーションごとに**できるようになった。これは飾りではない。Neon の実装はこの粒度を実際に使っている。

```c title="pgxn/neon/pagestore_smgr.c"
const f_smgr *
smgr_neon(ProcNumber backend, NRelFileInfo rinfo)
{

	/* Don't use page server for temp relations */
	if (backend != INVALID_PROC_NUMBER)
		return smgr_standard(backend, rinfo);
	else
		return &neon_smgr;
}
```

([pgxn/neon/pagestore_smgr.c L2257](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon/pagestore_smgr.c#L2257))

**一時テーブルはローカルディスクのまま**にしている。バックエンドローカルで、クラッシュしたら消えてよく、WAL も出さないものを、わざわざネットワーク越しに置く理由がない。差し替えを全部か無かにしなかったことで、Postgres の既存実装をそのまま再利用できている。

**2. 初期化のフックを足す。**

```c title="src/include/storage/smgr.h"
typedef void (*smgr_init_hook_type) (void);
typedef void (*smgr_shutdown_hook_type) (void);
extern PGDLLIMPORT smgr_init_hook_type smgr_init_hook;
extern PGDLLIMPORT smgr_shutdown_hook_type smgr_shutdown_hook;
extern void smgr_init_standard(void);
```

`smgrinit()` は `(*smgr_init_hook)()` を呼ぶだけになり、既定値は `smgr_init_standard` (= `mdinit`) になった。Neon 側はこれを差し替えて、標準の初期化も呼びつつ自分の初期化を足す。

```c title="pgxn/neon/pagestore_smgr.c"
void
smgr_init_neon(void)
{
	RegisterXactCallback(AtEOXact_neon, NULL);

	smgr_init_standard();
	neon_init();
	communicator_init();
}
```

**3. インターフェースに 4 つメソッドを足す。**

```c title="src/include/storage/smgr.h"
	/* Neon: New capabilities for smgr used to make Neon work */
	void		(*smgr_start_unlogged_build) (SMgrRelation reln);
	void		(*smgr_finish_unlogged_build_phase_1) (SMgrRelation reln);
	void		(*smgr_end_unlogged_build) (SMgrRelation reln);

	int  		(*smgr_read_slru_segment) (SMgrRelation reln, const char *path, int segno, void* buffer);
```

この 4 つは、既存のインターフェースでは表現できなかったものだ。

## 追加された 4 メソッドが語っていること

**`smgr_*_unlogged_build`** は、GIN・GiST・SP-GiST のインデックス構築を救うためにある。これらは「バッファマネージャを使って普通にページを作るが WAL は出さず、全部できてから一括で WAL に書く」という作り方をする。

ローカルディスクならこれで問題ない。ページはファイルに書かれているので、バッファから追い出されても消えない。**Neon では消える。** WAL に出ていないページは pageserver に届かず、バッファから落ちた瞬間に失われる。

そこで「今は unlogged なビルドの最中である」という状態を smgr に明示的に伝えることにした。その間、Neon の smgr はページをローカルの一時ファイルに書き、ビルドが終わったら WAL 経由で送る。

`docs/core_changes.md` はこれを「本来なら Postgres 本体もこうあるべき」と書いている。

> I think it would make sense to be more explicit about that in PostgreSQL too. So extract these changes to a patch and post to pgsql-hackers.

**暗黙の前提 (「WAL に出していなくてもページはファイルに残る」) に依存していたコードが、前提の変わった環境で壊れた**という、移植の典型パターンだ。そして正しい直し方は、前提を明示的な状態として表に出すことだった。

**`smgr_read_slru_segment`** は、SLRU (トランザクション状態の配列。[MVCC・xid・SLRU](../mvcc-and-xid/)) をオンデマンドで取ってくるためのもの。当初は SLRU ファイルを全部 basebackup に含めていたが、数 GB になり得て起動が遅くなったので、必要になったときだけ取る方式に変えた。

## `relpersistence` を `smgropen()` に足した

もう 1 つの本体改造がこれだ。

```c title="src/include/storage/smgr.h"
extern SMgrRelation smgropen(RelFileLocator rlocator, ProcNumber backend, char relpersistence);
```

Neon は unlogged リレーションを他と区別する必要がある (ローカルに置き、compute 再起動で消す)。しかし `smgrread()` / `smgrwrite()` の時点では、それが unlogged なのか permanent なのかを知る手段がなかった。`RelFileLocator` にはその情報がない。

だから `smgropen()` の引数に足して、`SMgrRelationData` に持たせた。

```c title="src/include/storage/smgr.h"
	/* copy of pg_class.relpersistence, or 0 if not known */
	char		smgr_relpersistence;
```

**インターフェースを差し替えられるようにしても、そのインターフェースを通る情報が足りなければ実装できない。** 抽象化の境界を引き直す作業には、必ずこの「情報が境界を越えていない」問題がついてくる。

## upstream 化は進んでいない

この改造は PostgreSQL に提案されている。`docs/core_changes.md` の記述が正直だ。

> We have submitted this to upstream, but it's moving at glacial a speed.
> https://commitfest.postgresql.org/47/4428/

`#define NEON_SMGR 1` が `smgr.h` に置かれているのは、拡張側が「Neon 版のヘッダでビルドされているか」を判定するためだ。upstream に入っていないことを、そのまま前提にしている。

**「本体を変えずに済むように本体を変えた」**というのが Neon の compute 側の全体像で、その最初で最大の 1 手がこの smgr の拡張化になる。以降のページに出てくる compute の改造は、ほぼすべてこの拡張点の上に乗っている ([smgr を置き換える](../neon-smgr/))。

## この先に効いてくること

- **バッファマネージャから下は 15 個の関数ポインタしか呼ばない。** ここを埋めれば Postgres のストレージは差し替えられる。
- **抽象があることと拡張できることは別。** `smgrsw[]` は 30 年間 1 要素だった。
- **差し替えは全部か無かではない。** 一時テーブルは標準実装のまま。リレーション単位で判断できるようにしたのがそのため。
- **境界を越えていない情報がある。** `relpersistence` を引数に足すという地味な変更が、実装可能性を決めた。
