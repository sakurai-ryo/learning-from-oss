---
title: "MVCC・xid・SLRU — 可視性はページの外にある"
description: "行が見えるかどうかは、行が持つ xmin/xmax と、その xid がコミット済みかを記録した SLRU の組み合わせで決まる。ページの中だけを見ても判定できないというこの構造が、Neon で 2 つの厄介を生んだ。"
group: "前提 — Postgres の内部"
sidebar:
  order: 7
---

## 何を学んだか

Postgres の MVCC は、行のバージョンを行そのものに書き込む方式だ。タプルヘッダに 2 つの xid が入っている。

```c title="src/include/access/htup_details.h"
typedef struct HeapTupleFields
{
	TransactionId t_xmin;		/* inserting xact ID */
	TransactionId t_xmax;		/* deleting or locking xact ID */

	union
	{
		CommandId	t_cid;		/* inserting or deleting command ID, or both */
		TransactionId t_xvac;	/* old-style VACUUM FULL xact ID */
	}			t_field3;
} HeapTupleFields;
```

([src/include/access/htup_details.h L122](https://github.com/postgres/postgres/blob/REL_17_5/src/include/access/htup_details.h#L122))

`t_xmin` を作ったトランザクション、`t_xmax` を消したトランザクション。ある行が自分から見えるかどうかは、

- `t_xmin` がコミット済みで、自分のスナップショットから見える
- `t_xmax` が未設定か、アボート済みか、自分のスナップショットからは見えない

で決まる。ここで「コミット済みか」という問いが出てくる。**その答えは行の中に書かれていない。**

## SLRU — xid の状態を保持する配列

commit log (clog) は、xid をインデックスとする 2 ビットの配列だ。`IN_PROGRESS` / `COMMITTED` / `ABORTED` / `SUB_COMMITTED` の 4 状態。これを 8KB ページに詰めたものが SLRU (Simple LRU) として管理される。

```c title="src/include/access/slru.h"
typedef struct SlruCtlData
{
	SlruShared	shared;

	/* Number of banks in this SLRU. */
	uint16		nbanks;
	/* ... */
	char		Dir[64];
} SlruCtlData;
```

([src/include/access/slru.h L127](https://github.com/postgres/postgres/blob/REL_17_5/src/include/access/slru.h#L127))

`Dir` が `pg_xact`、`pg_multixact/offsets`、`pg_multixact/members` といったディレクトリになる。**リレーションではないが永続化が必要なデータ**で、独自の小さなバッファプールを持っている。

これが Neon にとっての問題になる。SLRU はリレーションではないので、`RelFileLocator` を持たず、smgr を通らず、バッファマネージャも通らない。**smgr を差し替えるだけでは捕まえられない。**

## Neon はキー空間に SLRU の名前空間を切った

対処は、キー空間に別の `field1` を割り当てることだった。

```rust title="libs/pageserver_api/src/key.rs"
pub fn slru_block_to_key(kind: SlruKind, segno: u32, blknum: BlockNumber) -> Key {
    Key {
        field1: 0x01,
        field2: match kind {
            SlruKind::Clog => 0x00,
            SlruKind::MultiXactMembers => 0x01,
            SlruKind::MultiXactOffsets => 0x02,
        },
        field3: 1,
        field4: segno,
        field5: 0,
        field6: blknum,
    }
}
```

([libs/pageserver_api/src/key.rs L640](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L640))

`field1 = 0x01` が SLRU 空間。リレーションは `0x00` なので衝突しない。**「ページの集まり」という点では同じなので、同じレイヤ・同じ compaction・同じ GC・同じブランチの仕組みに乗せられる。** キー空間を平坦にしたことの配当がここに出ている。

さらに、Neon は clog の更新を Postgres の WAL レコードのままでは保存していない。専用のレコード型を作っている。

```rust title="libs/wal_decoder/src/models/record.rs"
    ClogSetCommitted {
        xids: Vec<TransactionId>,
        timestamp: TimestampTz,
    },
    /// Mark transaction IDs as aborted on a CLOG page
    ClogSetAborted { xids: Vec<TransactionId> },
    /// Extend multixact offsets SLRU
    MultixactOffsetCreate {
        mid: MultiXactId,
        moff: MultiXactOffset,
    },
```

([libs/wal_decoder/src/models/record.rs L24](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/wal_decoder/src/models/record.rs#L24))

理由は 2 つある。**1 つはサイズ。** 元の commit レコードにはコミットしたリレーションの情報など雑多なものが入っているが、clog ページの再構成に必要なのは xid のリストだけだ。**もう 1 つは適用先。** 1 つの commit レコードは clog ページも更新するし他のキーも更新する。キーごとに保存する Neon の構造では、キーごとに必要な情報だけを切り出したほうが素直になる。

そしてこの型のレコードは、Postgres プロセスに送らず Rust 側で適用する。ビットを立てるだけの操作に外部プロセスの往復は要らない。

## SLRU をオンデマンドで取ってくる

もう 1 つ、SLRU は量が問題になった。当初は全部 basebackup に入れていた。

> Previously, SLRU files were included in the basebackup, but the total size of them can be large, several GB, and downloading them all made the startup time too long.

**コールドスタートの速さが売りなのに、起動時に数 GB を落としていたら台無しになる。** そこで smgr インターフェースに `smgr_read_slru_segment` を足し、SLRU の読み取りも pageserver への要求に変えた ([smgr](../smgr/))。

pageserver 側は両方をサポートしている。

```rust title="pageserver/src/basebackup.rs"
        let lazy_slru_download = self.timeline.get_lazy_slru_download() && !self.full_backup;
```

([pageserver/src/basebackup.rs L363](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/basebackup.rs#L363))

テナント設定で切り替えられる。`full_backup` のときは必ず含める。

## t_cid — WAL フォーマットを変えた 1 か所

Neon が Postgres の WAL フォーマットを非互換に変えた変更が 1 つある。heap の WAL レコードに `t_cid` (コマンド ID) を追加した。

`docs/core_changes.md` の説明が問題の核心を突いている。

> The problem is that the XLOG_HEAP_INSERT record does not include the command id of the inserted row. (中略) That works in PostgreSQL, because the command id is only relevant to the inserting transaction itself. After commit/abort, no one cares about it anymore. But with Neon, we rely on WAL replay to reconstruct the page, even while the original transaction is still running.

コマンド ID は、**同一トランザクション内での「何番目の文か」**を表す。`INSERT` してから同じトランザクションで `SELECT` すると、その行が見えるかどうかは cid で決まる。

Postgres でこれが WAL に入っていないのは、**リカバリで cid が必要になる場面がないから**だ。リカバリはクラッシュ後に走るので、走っている時点で当該トランザクションはもう死んでいる。cid を誰も見ない。

Neon では違う。ページの再構成は、**そのトランザクションが実行中でも**起きる。トランザクションが `INSERT` した行のページがバッファから追い出され、同じトランザクションが読み直したら、そのページは WAL から再構成される。そのとき cid が失われていると、自分で入れた行が自分に見えなくなる。

**「クラッシュ後にしか使わない」という時間的な前提が、redo を通常運転で使うようになった瞬間に崩れた。** WAL を「災害時の記録」から「常用のデータ表現」に格上げしたことの、いちばん分かりやすい副作用だ。

対処には代償がある。WAL レコードが大きくなるし、Postgres 本体と WAL フォーマットの互換性が失われる。Neon が生成した WAL は素の Postgres では読めない。upstream への提案も試みられたが、うまくいっていないと記録されている。

> Update from Heikki (2024-04-17): I tried to write an upstream patch for that, to use the t_cid field for logical decoding, but it was not as straightforward as it first sounded.

## この先に効いてくること

- **可視性判定はページの外の状態を必要とする。** だから SLRU も pageserver が持たなければならず、キー空間に名前空間を切って同居させた。
- **キー空間を平坦にした配当。** SLRU はリレーションと全く違うデータだが、レイヤ・compaction・GC・ブランチの仕組みをそのまま共有できている。
- **WAL レコードを再定義してよい。** Postgres のレコードをそのまま保存する義務はない。キー単位に切り出したほうが小さく速い場合がある。
- **「クラッシュ後にしか使わない」という前提が消えた。** redo を常用にすると、リカバリ専用の手抜きが全部バグになる。
