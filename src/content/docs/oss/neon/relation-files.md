---
title: "リレーションはファイルである — relfilelocator・fork・segment"
description: "Postgres のテーブルは (tablespace, database, relfilenumber) の 3 つ組で識別されるファイル群で、さらに fork とセグメントに分かれる。この 4 階層のファイル世界を Neon は 1 本のキー空間に潰す。潰す前の形を先に見ておく。"
group: "前提 — Postgres の内部"
sidebar:
  order: 2
---

## 何を学んだか

Postgres で `SELECT * FROM orders` と打つとき、最終的に読まれるのはファイルシステム上の `base/16384/24576` のようなパスだ。この数字の並びが何を意味しているかを知らないと、Neon のキー空間 (`Key { field1..field6 }`) が何を写し取ったものなのか分からない。

物理的な位置を決めるのは、この 3 つ組だ。

```c title="src/include/storage/relfilelocator.h"
typedef struct RelFileLocator
{
	Oid			spcOid;			/* tablespace */
	Oid			dbOid;			/* database */
	RelFileNumber relNumber;	/* relation */
} RelFileLocator;
```

([src/include/storage/relfilelocator.h L58](https://github.com/postgres/postgres/blob/REL_17_5/src/include/storage/relfilelocator.h#L58))

そしてパスの組み立てはこうなっている。

```c title="src/common/relpath.c"
	else if (spcOid == DEFAULTTABLESPACE_OID)
	{
		/* The default tablespace is {datadir}/base */
		if (procNumber == INVALID_PROC_NUMBER)
		{
			if (forkNumber != MAIN_FORKNUM)
				path = psprintf("base/%u/%u_%s",
								dbOid, relNumber,
								forkNames[forkNumber]);
			else
				path = psprintf("base/%u/%u",
								dbOid, relNumber);
		}
```

([src/common/relpath.c L141](https://github.com/postgres/postgres/blob/REL_17_5/src/common/relpath.c#L141))

`base/16384/24576` の `16384` が `dbOid`、`24576` が `relNumber` だ。デフォルト以外のテーブルスペースなら `pg_tblspc/<spcOid>/PG_17_202406281/<dbOid>/<relNumber>` になる。

重要なのは **`relNumber` はテーブルの OID とは別物**だということ。`pg_class.oid` は論理的な識別子で不変だが、`relfilenode` は物理ファイルの識別子で、`VACUUM FULL` や `TRUNCATE` や `REINDEX` のたびに新しい番号に振り直される。「中身を全部入れ替える」操作を、既存ファイルを書き換えるのではなく**新しいファイルを作って古いのを捨てる**ことで実装しているからだ。

## fork — 1 つのリレーションに 4 種類のファイル

1 つのリレーションは 1 つのファイルではない。

```c title="src/common/relpath.c"
const char *const forkNames[] = {
	[MAIN_FORKNUM] = "main",
	[FSM_FORKNUM] = "fsm",
	[VISIBILITYMAP_FORKNUM] = "vm",
	[INIT_FORKNUM] = "init",
};
```

([src/common/relpath.c L33](https://github.com/postgres/postgres/blob/REL_17_5/src/common/relpath.c#L33))

- **main** — 実データ。パスにサフィックスが付かない (`24576`)。
- **fsm** — free space map。各ページにどれだけ空きがあるかの近似値を持つ (`24576_fsm`)。
- **vm** — visibility map。ページ内の全タプルが全トランザクションから見えるかのビット (`24576_vm`)。index-only scan と VACUUM の高速化に使う。
- **init** — unlogged リレーションの初期状態。クラッシュ後にこれをコピーして空に戻す (`24576_init`)。

fork は「同じリレーションに属する別々のアドレス空間」だと思えばよい。ブロック番号 0 は main にも fsm にも vm にも別々に存在する。だから**ページを一意に指すには (relfilelocator, forknum, blocknum) の 5 つ組が要る**。

WAL レコードのブロック参照が持っている情報が、まさにこの 5 つ組だ ([WAL と LSN](../wal-and-lsn/))。

## segment — 1GB ごとにファイルが割れる

さらに、1 つの fork は 1GB (`RELSEG_SIZE` × 8KB) を超えると `24576`、`24576.1`、`24576.2` と分割される。分割は `md.c` (magnetic disk storage manager) が管理していて、上位からは連続したブロック番号空間に見える。

セグメント分割は歴史的な理由 (2GB のファイルサイズ制限) で入ったもので、今でも残っている。Neon にとっては**消してよい概念**だった。オブジェクトストレージにはファイルサイズ制限がないし、そもそもファイルという単位で持っていないからだ。

## Neon はこの 4 階層を 1 本のキーに潰す

前提の話をここまでしたのは、Neon のキー定義を読むためだ。

```rust title="libs/pageserver_api/src/key.rs"
pub fn rel_block_to_key(rel: RelTag, blknum: BlockNumber) -> Key {
    Key {
        field1: 0x00,
        field2: rel.spcnode,
        field3: rel.dbnode,
        field4: rel.relnode,
        field5: rel.forknum,
        field6: blknum,
    }
}
```

([libs/pageserver_api/src/key.rs L553](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L553))

`spcnode`・`dbnode`・`relnode`・`forknum`・`blknum` がそのまま並んでいる。**Postgres が「ディレクトリ + ファイル名 + サフィックス + セグメント番号 + オフセット」で表現していたものを、1 つの 128 ビット整数に連結しただけ**だ。セグメント番号は消えている (ブロック番号に吸収された)。

`field1` は名前空間の区別で、`0x00` がリレーション、`0x01` が SLRU、といった具合に別の種類のデータを同じキー空間に同居させるために使う ([キー空間 — Postgres のファイル世界を 1 本の軸に潰す](../key-space/))。

この平坦化には効き目が 2 つある。

**1 つ目: 範囲がそのまま意味を持つ。** キーは辞書順に並ぶので、あるリレーションの全ブロックは連続した範囲になる。ある DB の全リレーションもそうだ。pageserver のレイヤファイルは「キー範囲 × LSN 範囲」の長方形なので、この並びがそのまま局所性になる。

**2 つ目: 「ファイルが存在するか」という問いが消える。** Postgres では `smgrnblocks()` はファイルサイズを `lseek` して求める。Neon にはファイルがないので、リレーションのサイズを**別のキーとして持つ**。

```rust title="libs/pageserver_api/src/key.rs"
pub fn rel_size_to_key(rel: RelTag) -> Key {
    Key {
        field1: 0x00,
        field2: rel.spcnode,
        field3: rel.dbnode,
        field4: rel.relnode,
        field5: rel.forknum,
        field6: 0xffff_ffff,
    }
}
```

([libs/pageserver_api/src/key.rs L565](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/key.rs#L565))

ブロック番号 `0xffffffff` — つまり**そのリレーションのキー範囲の一番後ろ**に、サイズを格納している。実在しないブロック番号を予約値として使うことで、「リレーションのサイズ」というメタデータをページと同じ仕組みで保存・バージョン管理・ブランチできるようにした。

サイズが LSN ごとにバージョンを持つのは重要で、これがないと「過去の LSN の時点でこのテーブルは何ブロックだったか」に答えられない。PITR とブランチには必須になる。

## ファイルシステムが持っていた暗黙の情報

Postgres は、明示的に保存していない情報をファイルシステムに委ねている。

| Postgres での表現                           | Neon での表現                                          |
| ------------------------------------------- | ------------------------------------------------------ |
| ファイルが存在する = リレーションが存在する | `rel_dir_to_key` — DB ごとのリレーション一覧を持つキー |
| ファイルサイズ = リレーションのブロック数   | `rel_size_to_key` — 予約ブロック番号に格納             |
| ディレクトリの列挙 = DB の一覧              | `DBDIR_KEY` — DB 一覧を持つ単一のキー                  |
| `unlink()` = リレーションの削除             | 一覧キーからのエントリ削除 + GC                        |

**ファイルシステムをやめるということは、ファイルシステムが暗黙に持っていたメタデータを全部自分で持つということだ。** Neon の `pgdatadir_mapping.rs` はほぼ全部この置き換えのために存在している。

しかもこの置き換えには嫌な性質がある。「DB ごとのリレーション一覧」のような**単一のキーがホットスポットになる**。リレーションを 1 つ作るたびにその 1 キーが更新されるので、リレーション数が多いと 1 つの値が巨大になり、更新のたびに全体を書き直すことになる。実際 Neon はここを後から疎表現 (`rel_tag_sparse_key`) に作り直している。1 リレーション 1 キーにして、一覧はキー範囲のスキャンで作る、という形だ。

「ファイルシステムの機能を再実装すると、ファイルシステムがすでに解いていた問題を全部解き直すことになる」の実例として読める。

## この先に効いてくること

- **ページの一意な識別子は 5 つ組 (spc, db, rel, fork, block)。** WAL レコードもこれで自己申告するし、Neon のキーもこれを連結しただけ。
- **relfilenode は不変ではない。** `VACUUM FULL` で変わる。Neon のキーは relfilenode を含むので、`VACUUM FULL` はキー空間の中では「古いキー範囲を捨てて新しいキー範囲を作る」ことになる。GC の負荷源。
- **サイズと存在はメタデータとして明示的に持つ必要がある。** ファイルシステムに預けていた情報を自分で管理する側に回った。
