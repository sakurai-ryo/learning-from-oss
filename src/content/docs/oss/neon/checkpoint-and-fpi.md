---
title: "チェックポイントと full page image"
description: "チェックポイントは「ここから redo を始めてよい」という宣言で、FPI は torn page から守るための保険。Neon には torn page が存在しないが、FPI は捨てられない。ページ再構成の起点になるからだ。"
group: "前提 — Postgres の内部"
sidebar:
  order: 5
---

## 何を学んだか

クラッシュリカバリで WAL を頭から全部 replay していたら、いつまでも起動できない。チェックポイントは「この LSN より前の変更は、すべてデータファイルに反映済みである」と宣言することで、redo の開始点を前に進める仕組みだ。

チェックポイントレコードの中身は、リカバリを始めるのに必要な全状態のスナップショットになっている。

```c title="src/include/catalog/pg_control.h"
typedef struct CheckPoint
{
	XLogRecPtr	redo;			/* next RecPtr available when we began to
								 * create CheckPoint (i.e. REDO start point) */
	TimeLineID	ThisTimeLineID; /* current TLI */
	TimeLineID	PrevTimeLineID; /* previous TLI, if this record begins a new
								 * timeline (equals ThisTimeLineID otherwise) */
	bool		fullPageWrites; /* current full_page_writes */
	int			wal_level;		/* current wal_level */
	FullTransactionId nextXid;	/* next free transaction ID */
	Oid			nextOid;		/* next free OID */
	MultiXactId nextMulti;		/* next free MultiXactId */
	MultiXactOffset nextMultiOffset;	/* next free MultiXact offset */
	TransactionId oldestXid;	/* cluster-wide minimum datfrozenxid */
	/* ... */
	TransactionId oldestActiveXid;
} CheckPoint;
```

([src/include/catalog/pg_control.h L35](https://github.com/postgres/postgres/blob/REL_17_5/src/include/catalog/pg_control.h#L35))

`redo` が開始点。それ以外は「次に払い出す ID」の類で、リレーションのページには入っていないクラスタ全体の状態だ。

**Neon はこの構造体を、自分のキー空間の中に 1 つのキーとして保存している。** pageserver は WAL を取り込みながらチェックポイントレコードを解釈し、この状態を更新し続ける。compute を起動するときには、そこから `pg_control` を組み立てて basebackup に入れる。「クラスタ全体の状態」もページと同じ扱いで、LSN ごとにバージョンを持つ ([basebackup — 空の PGDATA から起動する](../basebackup-startup/))。

## full page image — torn page への保険

チェックポイント後に**初めて**変更されるページは、差分ではなくページ全体が WAL に書かれる。判定はこの 1 行だ。

```c title="src/backend/access/transam/xloginsert.c"
			XLogRecPtr	page_lsn = PageGetLSN(regbuf->page);

			needs_backup = (page_lsn <= RedoRecPtr);
```

([src/backend/access/transam/xloginsert.c L632](https://github.com/postgres/postgres/blob/REL_17_5/src/backend/access/transam/xloginsert.c#L632))

`RedoRecPtr` は直近のチェックポイントの redo 位置。ページの LSN がそれ以前なら「このチェックポイント以降まだ触っていない」ので、FPI を出す。

理由は GUC の説明が簡潔に書いている。

> A page write in process during an operating system crash might be only partially written to disk. During recovery, the row changes stored in WAL are not enough to recover.

**8KB のページ書き込みは、OS とディスクにとって原子的ではない。** 途中でクラッシュすると、前半 4KB が新しく後半 4KB が古いページができる。そこに「オフセット 3000 の 20 バイトをこう書き換えろ」という差分 WAL を当てても、正しいページにはならない。だから、チェックポイント以降に初めて触るときだけ、**差分の適用先を確定させるために**ページ全体を書く。

`needs_data = !needs_backup` という行も同じ考えから来ている。FPI を入れたなら差分は要らない。redo するときは FPI をそのまま貼るだけになる。

## Neon には torn page が存在しない

Neon の compute はページを書き戻さない。pageserver はページを「レイヤファイルの中の値」として持ち、レイヤファイルは不変で、S3 へのアップロードはオブジェクト単位で原子的だ。**部分的に書かれたページ**という状態が発生する場所がない。

つまり FPI の本来の目的は、Neon では意味を失っている。

にもかかわらず、Neon は FPI を捨てない。**別の用途があるからだ。**

pageserver がページを返すときにやることは、「ある起点から WAL レコードを順に適用する」というものだ。この起点がないと、リレーションが作られた瞬間まで遡って全 WAL を適用することになる。FPI は、**WAL ストリームの中に自然に埋め込まれた起点**になる。

```rust title="libs/wal_decoder/src/models/value.rs"
pub enum Value {
    /// An Image value contains a full copy of the value
    Image(Bytes),
    /// A WalRecord value contains a WAL record that needs to be
    /// replayed get the full value. Replaying the WAL record
    /// might need a previous version of the value (if will_init()
    /// returns false), or it may be replayed stand-alone (true).
    WalRecord(NeonWalRecord),
}
```

([libs/wal_decoder/src/models/value.rs L16](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/wal_decoder/src/models/value.rs#L16))

`will_init` が true な値は、**それより前を読まなくてよい**という意味になる。ページ再構成はキーの履歴を新しい順に辿り、`will_init` が true な値に当たったところで打ち切る。FPI はそこで止まれる印だ。

WAL の取り込みで、FPI レコードは実際に `Value::Image` に変換される。

```rust title="libs/wal_decoder/src/serialized_batch.rs"
    fn block_is_image(
        decoded: &DecodedWALRecord,
        blk: &DecodedBkpBlock,
        pg_version: PgMajorVersion,
    ) -> bool {
        blk.apply_image
            && blk.has_image
            && decoded.xl_rmid == pg_constants::RM_XLOG_ID
            && (decoded.xl_info == pg_constants::XLOG_FPI
            || decoded.xl_info == pg_constants::XLOG_FPI_FOR_HINT)
            // compression of WAL is not yet supported: fall back to storing the original WAL record
            && !postgres_ffi::bkpimage_is_compressed(blk.bimg_info, pg_version)
            // do not materialize null pages because them most likely be soon replaced with real data
            && blk.bimg_len != 0
    }
```

([libs/wal_decoder/src/serialized_batch.rs L306](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/wal_decoder/src/serialized_batch.rs#L306))

条件が絞られていることに注目したい。**FPI を持つレコードすべてではなく、rmgr が XLOG で info が `XLOG_FPI` / `XLOG_FPI_FOR_HINT` のもの、つまり「ページ全体を貼る」以外に何もしないレコードだけ**を画像として取り出す。それ以外は、FPI を持っていてもレコードごと保存する。理由は簡単で、FPI 付きの通常レコード (たとえば heap insert) は、ページを貼ったあとに追加の変更もするからだ。画像だけ取り出すと変更が消える。

`will_init` の側はもっと緩い。

```rust title="libs/wal_decoder/src/serialized_batch.rs"
                    Value::WalRecord(NeonWalRecord::Postgres {
                        will_init: blk.will_init || blk.apply_image,
                        rec: decoded.record.clone(),
                    })
```

FPI を含んでいれば、レコード全体を保存しつつ `will_init: true` を立てる。**「このレコードだけで完結する」ことは保証できるが、「このレコードが最終的なページの中身そのものである」とまでは言えない**、という区別だ。

抽出したページには LSN を書き込み直す。ただし全ゼロページには書かない。

```rust title="libs/wal_decoder/src/serialized_batch.rs"
                    // Match the logic of XLogReadBufferForRedoExtended:
                    // The page may be uninitialized. If so, we can't set the LSN because
                    // that would corrupt the page.
                    //
                    if !page_is_new(&image) {
                        page_set_lsn(&mut image, next_record_lsn)
                    }
```

**Postgres の redo が何をするかを、Rust 側で再現している。** Neon はページ再構成の大部分を Postgres プロセスに委譲しているが ([walredo](../walredo/))、FPI の貼り付けのように単純な操作は Rust 側でやっている。その代償が「本体の挙動と一致させ続ける責任」で、コメントが明示的に `XLogReadBufferForRedoExtended` を参照しているのはそのためだ。

## 「checkpoint」という語の衝突

Neon には Postgres とは別の意味の「チェックポイント」がある。用語集に注意書きがある。

> ### Checkpoint (Layered repository)
>
> NOTE: This is an overloaded term.
>
> Whenever enough WAL has been accumulated in memory, the page server writes out the changes from the in-memory layer into a new delta layer file. This process is called "checkpointing".

pageserver がインメモリレイヤをディスクの L0 レイヤに書き出すことも「チェックポイント」と呼ばれている。**Postgres のチェックポイントとは無関係**で、こちらは単に「メモリからディスクへ」の話だ。Neon のコードとログを読むときの引っかかりどころになる。

## Postgres のチェックポイントは Neon で何をしているのか

compute はデータファイルを持たないので、チェックポイントがやっていた「ダーティバッファを全部書き出す」は空振りに近い。しかしチェックポイントレコード自体は依然として重要だ。

- **クラスタ状態の伝達。** `nextXid`・`nextOid`・`oldestXid` といった値を、WAL 経由で pageserver に伝える唯一の手段になっている。
- **シャットダウンチェックポイント。** clean shutdown だったかどうかを次回起動時に判定するのに使う。だから postmaster は、シャットダウンチェックポイントを書き終えるまで walproposer を殺してはいけない。この順序のために本体にパッチが当たっている。

  > This changes was needed so that postmaster shuts down the walproposer process only after the shutdown checkpoint record is written. Otherwise, the shutdown record will never make it to the safekeepers.

**分解したことで、それまで「同じプロセスの中だから当然届いていた」ものが、届かなくなる。** プロセス終了順序という、モノリスでは考えなくてよかった問題が出てくる。

## この先に効いてくること

- **FPI は Neon では「torn page 対策」ではなく「再構成の起点」。** 目的が変わっても構造は再利用できる、という例。
- **`will_init` が再構成の停止条件。** レイヤを新しい順に辿り、これが立った値で止まる。
- **チェックポイントのクラスタ状態は Neon のキー空間に入る。** ページ以外の状態も同じ仕組みでバージョン管理する。
- **「checkpoint」は 2 つの意味を持つ。** コードとログを読むときの罠。
