---
title: "WAL と LSN — バイト位置が時計になる"
description: "Postgres の WAL は「バイト列に追記していくファイル」でしかなく、LSN はその中のバイト位置を指す 64 ビット整数でしかない。この身も蓋もない定義が、Neon で 5 つのコンポーネントを繋ぐ論理時計として使われる理由になる。"
group: "前提 — Postgres の内部"
sidebar:
  order: 1
---

## 何を学んだか

Neon のコードを読んでいると、`Lsn` という型がほとんどすべての関数のシグネチャに出てくる。`get_page_at_lsn(key, lsn)`、`commit_lsn`、`disk_consistent_lsn`、`ancestor_lsn`、`last_written_lsn`。分散システムの調停に使う値としては異様に馴染みがよく、しかも比較・減算ができる。

その正体は Postgres の `XLogRecPtr` で、定義はこれだけだ。

```c title="src/include/access/xlogdefs.h"
/*
 * Pointer to a location in the XLOG.  These pointers are 64 bits wide,
 * because we don't want them ever to overflow.
 */
typedef uint64 XLogRecPtr;
```

([src/include/access/xlogdefs.h L21](https://github.com/postgres/postgres/blob/REL_17_5/src/include/access/xlogdefs.h#L21))

**LSN は WAL ストリームの先頭からのバイトオフセットである。** タイムスタンプでもカウンタでもなく、「バイト位置」だ。だから `lsn_b - lsn_a` は「その間に何バイトの WAL が書かれたか」という意味を持つし、大小比較は「どちらが先に起きたか」を無条件に決める。単一の書き手が単一のストリームに追記していく限り、この順序は全順序になる。

Neon はここに乗っている。Lamport クロックもベクタークロックも導入せず、既に Postgres が持っていた「単調に増えるバイト位置」をそのまま分散システムの論理時計に使った。物理時刻を一切使わずに済んでいるのは、この 1 点による ([LSN がシステム全体の論理時計になる](../lsn-as-clock/))。

慣習的な表示形式も定義されている。上位 32 ビットと下位 32 ビットをスラッシュで区切って 16 進表示する。

```c title="src/include/access/xlogdefs.h"
#define LSN_FORMAT_ARGS(lsn) (AssertVariableIsOfTypeMacro((lsn), XLogRecPtr), (uint32) ((lsn) >> 32)), ((uint32) (lsn))
```

`0/16B3778` のような表示はこれで、Neon のログにも API のレスポンスにも同じ形式で出てくる。

## WAL レコードの形

WAL に追記されるのは `XLogRecord` から始まる可変長のレコードだ。

```c title="src/include/access/xlogrecord.h"
typedef struct XLogRecord
{
	uint32		xl_tot_len;		/* total len of entire record */
	TransactionId xl_xid;		/* xact id */
	XLogRecPtr	xl_prev;		/* ptr to previous record in log */
	uint8		xl_info;		/* flag bits, see below */
	RmgrId		xl_rmid;		/* resource manager for this record */
	/* 2 bytes of padding here, initialize to zero */
	pg_crc32c	xl_crc;			/* CRC for this record */

	/* XLogRecordBlockHeaders and XLogRecordDataHeader follow, no padding */

} XLogRecord;
```

([src/include/access/xlogrecord.h L41](https://github.com/postgres/postgres/blob/REL_17_5/src/include/access/xlogrecord.h#L41))

読むべきフィールドは 2 つある。

**`xl_rmid` (リソースマネージャ ID)。** このレコードを解釈できるのは誰か、を指す。Heap、Btree、Gin、XLOG、Transaction、といった具合に、アクセスメソッドごとに 1 つの rmgr がいる。レコードの意味は rmgr が決めるので、WAL は「rmgr ごとに別の言語で書かれた文の列」だと思うのが近い。Neon が独自の WAL レコードを足せているのは、この ID を 1 つ取ったからだ ([neon_rmgr — WAL の語彙を増やす](../neon-rmgr/))。

**`xl_prev` (前のレコードの LSN)。** WAL は前方向にリンクされたリストでもある。これがあるおかげで、途中から読み始めたときに「本当にここがレコードの境界か」を検証できる。

ヘッダのあとに、レコードが触ったブロックの参照が 0 個以上続く。

```c title="src/include/access/xlogrecord.h"
typedef struct XLogRecordBlockHeader
{
	uint8		id;				/* block reference ID */
	uint8		fork_flags;		/* fork within the relation, and flags */
	uint16		data_length;	/* number of payload bytes (not including page
								 * image) */

	/* If BKPBLOCK_HAS_IMAGE, an XLogRecordBlockImageHeader struct follows */
	/* If BKPBLOCK_SAME_REL is not set, a RelFileLocator follows */
	/* BlockNumber follows */
} XLogRecordBlockHeader;
```

([src/include/access/xlogrecord.h L103](https://github.com/postgres/postgres/blob/REL_17_5/src/include/access/xlogrecord.h#L103))

つまり 1 つの WAL レコードは、**「どのリレーションの、どのフォークの、どのブロックを触ったか」を自分で申告している**。ページの中身をどう変えたかは rmgr にしか分からないが、**どのページを変えたかは rmgr を知らなくても読める**。

この非対称性が Neon の設計の土台になっている。pageserver は WAL を受け取ると、まずこのブロック参照だけを見て「このレコードはキー X に属する」と振り分ける。中身の解釈は後回しにでき、実際に必要になるまでやらない ([walingest — WAL をキー値の更新に翻訳する](../walingest/))。

## LSN はページヘッダも数える

「WAL ストリームの先頭からのバイトオフセット」と言ったが、そのバイト列は完全に平坦ではない。WAL は 8KB のページに区切られていて、各ページの先頭にヘッダが載る。

```c title="src/include/access/xlog_internal.h"
typedef struct XLogPageHeaderData
{
	uint16		xlp_magic;		/* magic value for correctness checks */
	uint16		xlp_info;		/* flag bits, see below */
	TimeLineID	xlp_tli;		/* TimeLineID of first record on page */
	XLogRecPtr	xlp_pageaddr;	/* XLOG address of this page */
	uint32		xlp_rem_len;	/* total len of remaining data for record */
} XLogPageHeaderData;
```

([src/include/access/xlog_internal.h L36](https://github.com/postgres/postgres/blob/REL_17_5/src/include/access/xlog_internal.h#L36))

さらにセグメントファイル (既定 16MB) の先頭ページだけは長いヘッダになる。レコードはページ境界をまたいでよく、その場合は続きが次のページのヘッダの直後から始まる。`xlp_rem_len` がその残りバイト数だ。

つまり **LSN の算術はページヘッダを飛ばす必要がある**。Neon はこの計算を Rust 側で自前に持っている。

```rust title="libs/postgres_ffi/src/xlog_utils.rs"
/// If LSN points to the beginning of the page, then shift it to first record,
/// otherwise align on 8-bytes boundary (required for WAL records)
pub fn normalize_lsn(lsn: Lsn, seg_sz: usize) -> Lsn {
    if lsn.0 % XLOG_BLCKSZ as u64 == 0 {
        let hdr_size = if lsn.0 % seg_sz as u64 == 0 {
            XLOG_SIZE_OF_XLOG_LONG_PHD
        } else {
            XLOG_SIZE_OF_XLOG_SHORT_PHD
        };
        lsn + hdr_size as u64
    } else {
        lsn.align()
    }
}
```

([libs/postgres_ffi/src/xlog_utils.rs L113](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/postgres_ffi/src/xlog_utils.rs#L113))

`libs/postgres_ffi` は Postgres のヘッダから定数と構造体を写し取った crate で、Neon の Rust コンポーネントが Postgres のファイル形式を直接読み書きするための土台になっている。**Postgres と同じバイト列を、Postgres なしで作れる**ようにしてある。safekeeper が空の WAL セグメントを生成できるのも、pageserver が `pg_control` を組み立てられるのも、この crate があるからだ ([basebackup — 空の PGDATA から起動する](../basebackup-startup/))。

## WAL 規則 — ログが先、データが後

WAL がなぜ「先行」書き込みログなのか。バッファをディスクに書き戻す関数にその規則がそのまま書いてある。

```c title="src/backend/storage/buffer/bufmgr.c"
	/*
	 * Force XLOG flush up to buffer's LSN.  This implements the basic WAL
	 * rule that log updates must hit disk before any of the data-file changes
	 * they describe do.
	 */
```

([src/backend/storage/buffer/bufmgr.c L3861 付近](https://github.com/postgres/postgres/blob/REL_17_5/src/backend/storage/buffer/bufmgr.c))

各ページの先頭 8 バイトには、そのページを最後に変更した WAL レコードの LSN が入っている (`PageGetLSN`)。ページを書き出す前に、その LSN まで WAL を fsync する。これで「データファイルに現れている変更は、必ず WAL にも現れている」が保証される。

**Neon ではこの規則の後半が消える。** compute はデータファイルを持たないので、ページを「書き戻す」先がない。バッファから追い出されたページは、単に捨てられる。次に必要になったら pageserver に要求する。

だから Neon で本当に守らなければならないのは前半だけになる — **WAL は必ず永続化されていること**。そして「どこまで永続化されたか」を判定する主体が、ローカルの fsync から safekeeper の過半数に変わる ([term と epoch — WAL を多数決で永続化する](../safekeeper-consensus/))。

同時に、新しい問題が 1 つ生まれる。バッファから追い出されたページを読み直すとき、**どの LSN のページを要求すればいいのか**。ページの中身は最後に書き込んだ WAL レコードで決まるので、その LSN 以降であれば正しい。しかし現在の WAL 末尾を指定すると、pageserver がそこまで WAL を取り込むのを待たされる。この折衷が Neon 固有の概念になる ([どの LSN のページを要求するか — last-written LSN](../last-written-lsn/))。

## この先に効いてくること

- **LSN は全順序である。** 単一の書き手 (プライマリの compute) が単一のストリームに追記する限り、比較だけで前後関係が決まる。Neon の各コンポーネントが「自分がどこまで進んだか」を LSN 1 つで表現できるのはこれによる。
- **WAL レコードは自分が触ったページを申告している。** rmgr を知らなくてもキーへの振り分けができる。pageserver の取り込みパスの前提。
- **rmgr ID は拡張点である。** Neon は独自 rmgr を足して、Postgres 本体を変えずに WAL の語彙を増やした。
- **ページヘッダのぶんだけ LSN は連続していない。** LSN の足し算をするコードは必ずこれを考慮している。バグの温床でもある。
