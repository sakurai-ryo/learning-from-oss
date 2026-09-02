---
title: "起動シーケンス — pg_control から「一貫している」まで"
description: "Postgres の起動は pg_control を読み、チェックポイントレコードを探し、そこから WAL を replay して一貫状態に到達する手順だ。Neon の compute には replay する WAL がなく、代わりに「もう一貫している」と宣言するファイルを 1 つ置く。"
group: "前提 — Postgres の内部"
sidebar:
  order: 8
---

## 何を学んだか

Postgres が起動するとき、最初に読むのは `global/pg_control` だ。ここには「前回どういう終わり方をしたか」と「どこから redo すべきか」が入っている。

```c title="src/include/catalog/pg_control.h"
typedef enum DBState
{
	DB_STARTUP = 0,
	DB_SHUTDOWNED,
	DB_SHUTDOWNED_IN_RECOVERY,
	DB_SHUTDOWNING,
	DB_IN_CRASH_RECOVERY,
	DB_IN_ARCHIVE_RECOVERY,
	DB_IN_PRODUCTION,
} DBState;
```

([src/include/catalog/pg_control.h L89](https://github.com/postgres/postgres/blob/REL_17_5/src/include/catalog/pg_control.h#L89))

`DB_IN_PRODUCTION` のまま残っていれば、それはクラッシュしたということだ。`StartupXLOG()` はこの状態を見て、ログにメッセージを出す。

```c title="src/backend/access/transam/xlog.c"
		case DB_IN_PRODUCTION:
			ereport(LOG,
					(errmsg("database system was interrupted; last known up at %s",
							str_time(ControlFile->time))));
			break;
```

そのあとの流れは決まっている。

1. `ControlFile->checkPoint` が指す WAL 位置からチェックポイントレコードを読む
2. その `redo` 位置から WAL を順に読み、rmgr の redo 関数に渡す ([redo](../redo-and-recovery/))
3. WAL の末尾まで到達したら「一貫している」
4. 新しいチェックポイントを書いて `DB_IN_PRODUCTION` にする

このシーケンス全体が、**ローカルディスクに前回の状態とその後の WAL がある**という前提の上に立っている。

## Neon の compute には、その両方がない

Neon の compute は、起動のたびに空のディレクトリから始まる。前回の PGDATA はない。過去の WAL セグメントファイルもない (WAL は safekeeper と pageserver が持っている)。

しかし Postgres バイナリは `pg_control` を読もうとするし、チェックポイントレコードを探そうとする。

`docs/core_changes.md` が問題を整理している。

> In Neon, the compute node is stateless. So when we are launching compute node, we need to provide some dummy PG_DATADIR. Relation pages can be requested on demand from page server. But Postgres still need some non-relational data: control and configuration files, SLRUs,... It is currently implemented using basebackup (do not mix with pg_basebackup) which is created by pageserver.
>
> As pageserver does not have the original WAL segments, the basebackup tarball includes an empty WAL segment to bootstrap the WAL writing, but it doesn't contain the checkpoint record.

**pageserver は WAL レコードを保存していない。** WAL を消化してキー値に変換したものを保存している。だからチェックポイントレコードのバイト列そのものは、もう存在しない。

## pg_control を合成する

Neon は `pg_control` を、保存しておいた構造体から組み立て直す。

```rust title="libs/postgres_ffi/src/xlog_utils.rs"
    // We use DBState_DB_SHUTDOWNED even if it was not a clean shutdown.  The
    // neon-specific code at postgres startup ignores the state stored in the control
    // file, similar to archive recovery in standalone PostgreSQL. Similarly, the
    // checkPoint pointer is ignored, so just set it to 0.
    pg_control.checkPoint = 0;
    pg_control.checkPointCopy = checkpoint;
    pg_control.state = DBState_DB_SHUTDOWNED;
```

([libs/postgres_ffi/src/xlog_utils.rs L138](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/postgres_ffi/src/xlog_utils.rs#L138))

- `state` は常に `DB_SHUTDOWNED`。実際にクリーンに落ちたかどうかに関係なく。
- `checkPoint` (レコードの位置) は 0。指す先がないので。
- `checkPointCopy` (レコードの中身) は、pageserver が WAL 取り込み中に維持していたものを入れる。

**「どこから redo するか」ではなく「もう redo は済んでいる」**を伝えるファイルになっている。

この関数のコメントには、redo ポインタの規約が Postgres と違うことまで書いてある。

```rust title="libs/postgres_ffi/src/xlog_utils.rs"
    // NB: In the checkpoint struct that we persist in the pageserver, we have a different
    // convention for the 'redo' field than in PostgreSQL: On a shutdown checkpoint,
    // 'redo' points the *end* of the checkpoint WAL record. On PostgreSQL, it points to
    // the beginning. Furthermore, on an online checkpoint, 'redo' is set to 0.
    //
    // We didn't always have this convention however, and old persisted records will have
    // old REDO values that point to some old LSN.
```

**永続化フォーマットの規約は変えられるが、過去に書いたデータは変えられない。** 「昔のレコードには古い値が入っている」という但し書きが付くのが、長期運用されるシステムの正直なところだ。判定はこの 1 行に落ちている。

```rust
    let was_shutdown = Lsn(checkpoint.redo) == lsn;
```

## neon.signal — 「ここから始めてよい」の宣言

`pg_control` を合成しただけでは足りない。`StartupXLOG()` はチェックポイントレコードを読もうとするし、`XRecOffIsValid(ControlFile->checkPoint)` の検証にも引っかかる。

そこで Neon は、起動時に読むシグナルファイルを 1 つ追加した。

```c title="src/backend/access/transam/xlog.c"
	/*
	 * Read neon.signal before anything else.
	 */
	readNeonSignalFile();

	/*
	 * Check that contents look valid.
	 */
	if (!XRecOffIsValid(ControlFile->checkPoint) && !NeonRecoveryRequested)
		ereport(FATAL,
				(errcode(ERRCODE_DATA_CORRUPTED),
				 errmsg("control file contains invalid checkpoint location")));
```

([src/backend/access/transam/xlog.c L5548](https://github.com/neondatabase/postgres/blob/1e01fcea2a6b38180021aa83e0051d95286d9096/src/backend/access/transam/xlog.c#L5548))

`recovery.signal` や `standby.signal` と同じ仕組みに 1 つ足した形だ。ファイルの中身は 1 行しかない。

```c title="src/backend/access/transam/xlog.c"
		/* Parse it */
		if (sscanf(content, "PREV LSN: %19s", prev_lsn_str) != 1)
```

そして値は 3 通りに分かれる。

```c title="src/backend/access/transam/xlog.c"
		if (strcmp(prev_lsn_str, "invalid") == 0)
		{
			/* No prev LSN. Forbid starting up in read-write mode */
			neonLastRec = InvalidXLogRecPtr;
			neonWriteOk = false;
		}
		else if (strcmp(prev_lsn_str, "none") == 0)
		{
			/*
			 * The page server had no valid prev LSN, but assured that it's ok
			 * to start without it. This happens when you start the compute
			 * node for the first time on a new branch.
			 */
			neonLastRec = InvalidXLogRecPtr;
			neonWriteOk = true;
		}
```

([src/backend/access/transam/xlog.c L5442](https://github.com/neondatabase/postgres/blob/1e01fcea2a6b38180021aa83e0051d95286d9096/src/backend/access/transam/xlog.c#L5442))

なぜ「前のレコードの LSN」が要るのか。[WAL と LSN](../wal-and-lsn/) で見たとおり、`XLogRecord` は `xl_prev` フィールドに前のレコードの位置を持っている。新しいレコードを書き始めるには、この値が必要だ。

そして 3 つの状態はこう対応する。

| 値        | 意味                                         | 書き込み可否            |
| --------- | -------------------------------------------- | ----------------------- |
| `X/Y`     | 前レコードの LSN が分かっている              | 可                      |
| `none`    | 新しいブランチの先頭。前レコードは存在しない | 可                      |
| `invalid` | 前レコードが分からない                       | **不可 (読み取り専用)** |

`invalid` は、過去の LSN から起動するとき — つまり PITR や、ブランチの分岐点より前を読むときに起きる。そこから WAL を書き始めると、既存の WAL と衝突する。だから読み取り専用に落とす。

**「どこから書き始めてよいか」という情報が、compute の起動可否と読み書きモードを決めている。** モノリスの Postgres なら WAL ファイルを見れば分かることが、分解した結果、外から渡されるパラメータになった。

## 「偽のチェックポイントレコードを作る」という選択肢

`docs/core_changes.md` は、この改造を避ける代替案も検討している。

> ### Alternatives
>
> Include a fake checkpoint record in the tarball. Creating fake WAL is a bit risky, though; I'm afraid it might accidentally get streamed to the safekeepers and overwrite or corrupt the real WAL.

本体にパッチを当てずに済ませる方法はあった。チェックポイントレコードを偽造して、空の WAL セグメントに書いておけばいい。

それを選ばなかった理由が「その偽 WAL が safekeeper に流れて本物を壊すかもしれない」というものだ。**分解によって「ローカルのファイルに書いただけ」で済まなくなった。** compute のローカル WAL は、walproposer を通じて safekeeper に伝播する経路を持っている。ローカルに閉じた偽装が、閉じない。

本体を変えるのを避けるコストのほうが高い、という判断がここで下されている。

## この先に効いてくること

- **`pg_control` は合成できる。** Postgres のファイル形式は、Postgres なしでも作れる。`libs/postgres_ffi` がそのための crate。
- **起動時に「もう一貫している」と宣言する。** replay しないことが正常系。
- **前レコードの LSN が読み書きモードを決める。** PITR で開いたブランチが読み取り専用になるのはこれ。
- **偽の WAL は作れない。** ローカルに閉じたごまかしが、分散したことで閉じなくなった。
