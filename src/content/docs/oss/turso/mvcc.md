---
title: "`BEGIN CONCURRENT` の正体は MVCC で、undo ではなく論理ログを書く"
description: "Turso の MVCC は Hekaton の論文をほぼそのまま実装している。行バージョンの begin と end が「確定したタイムスタンプ」か「未確定のトランザクション ID」のどちらかを持ち、後者を読んだ側は投機的に見えることにしてコミット依存を登録する。書き込みの衝突は待たずに即座に中断され、先に書いた方が勝つ。耐久化は WAL ではなく .db-log という論理ログに、行単位で書かれる。"
sidebar:
  order: 14
---

## 何を学んだか

Turso で `BEGIN CONCURRENT` と書くと、バイトコードにこれが出る。

```rust title="core/translate/transaction.rs"
        TransactionType::Concurrent => {
            program.emit_insn(Insn::Transaction {
                db: crate::MAIN_DB_ID,
                tx_mode: TransactionMode::Concurrent,
                schema_cookie: schema.schema_version,
            });
```

[`core/translate/transaction.rs#L59-L64`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/transaction.rs#L59-L64)。

そして VDBE 側では、こう分かれる。

```rust title="core/vdbe/execute.rs"
        TransactionMode::None | TransactionMode::Read | TransactionMode::Concurrent => {
            mv_store.begin_tx_with_schema_generation(pager.clone(), expected_schema_generation)
        }
        TransactionMode::Write => mv_store.begin_exclusive_tx(
```

[`core/vdbe/execute.rs#L4050-L4058`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/execute.rs#L4050-L4058)。

**`BEGIN CONCURRENT` は独立した機能ではなく、MVCC への入口だ。** `PRAGMA journal_mode = 'mvcc'` で有効にした MVCC ストアに、排他ではないトランザクションを開始する。

`BEGIN IMMEDIATE` は MVCC 下でも `begin_exclusive_tx` を呼ぶ。**SQLite の「書き手は 1 人」という意味論を保つためだ。**

```rust title="core/mvcc/database/mod.rs"
    /// An exclusive MVCC transaction is one that has a write lock on the pager, which means
    /// every other MVCC transaction must wait for it to commit before they can commit. We have
    /// exclusive transactions to support single-writer semantics for compatibility with SQLite.
    exclusive_tx: AtomicU64,
```

[`core/mvcc/database/mod.rs#L4030-L4037`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L4030-L4037)。

**同じ MVCC の上に、「従来どおりの 1 writer」と「並行書き込み」の両方を載せている。** SQL の書き方で選べる。

## ソースコードのどこか

### 出典が明示されている

```rust title="core/mvcc/mod.rs"
//! Multiversion concurrency control (MVCC) for Rust.
//!
//! This module implements the main memory MVCC method outlined in the paper
//! "High-Performance Concurrency Control Mechanisms for Main-Memory Databases"
//! by Per-Åke Larson et al (VLDB, 2011).
```

[`core/mvcc/mod.rs#L1-L5`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/mod.rs#L1-L5)。

Microsoft の Hekaton (SQL Server のインメモリ OLTP エンジン) の基礎になった論文だ。**「インメモリ」の MVCC であることが重要で、InnoDB のようにディスク上の undo セグメントを辿る方式ではない。**

続けて、防げる異常が列挙されている。

```rust title="core/mvcc/mod.rs"
//! * A *dirty write* occurs when transaction T_m updates a value that is written by
//!   transaction T_n but not yet committed. The MVCC algorithm prevents dirty
//!   writes by validating that a row version is visible to transaction T_m before
//!   allowing update to it.
//! ...
//! * A *lost update* occurs when transactions T_m and T_n both attempt to update
//!   the same value, resulting in one of the updates being lost. The MVCC algorithm
//!   prevents lost updates by detecting the write-write conflict and letting the
//!   first-writer win by aborting the later transaction.
//!
//! TODO: phantom reads, cursor lost updates, read skew, write skew.
```

[`core/mvcc/mod.rs#L7-L27`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/mod.rs#L7-L27)。

**「防げるもの」と「まだ検討していないもの」が両方書いてある。** ファントムリード、read skew、write skew は TODO のままだ。

つまり **提供しているのはスナップショット分離であって、直列化可能性ではない**。write skew が起きうる。これは MVCC 実装として標準的な選択だが、**それを曖昧にせず TODO として明記している**。

### 行バージョンは begin と end の 2 つの時刻を持つ

```rust title="core/mvcc/database/mod.rs"
/// A row version.
#[derive(Clone, Debug, PartialEq)]
pub struct RowVersion {
    /// Unique identifier for this version within the MvStore.
    pub id: u64,
    /// `begin`/`end` timestamps are bit-packed. ...
    pub(crate) begin: PackedTs,
    pub(crate) end: PackedTs,
    pub row: Row,
    /// Indicates this version was created for a row that existed in B-tree before
    /// MVCC was enabled (e.g., after switching from WAL to MVCC journal mode).
    pub btree_resident: bool,
```

[`core/mvcc/database/mod.rs#L446-L473`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L446-L473)。

**MySQL の undo との違いはここに出る。**

- InnoDB — 現在の行に `DB_TRX_ID` と `DB_ROLL_PTR` を埋め込み、古い版は undo ログを辿って再構成する
- Turso — **古い版も新しい版もメモリ上に並んで存在し、それぞれが有効期間を持つ**

`btree_resident` フラグが実務的で、**WAL モードで作られた既存の行が MVCC に切り替わった後どう見えるか**を扱っている。既存のデータは B-tree にあり、MVCC のバージョン鎖にはない。「MVCC を有効にした瞬間から全部をメモリに読み込む」わけにいかないので、**「B-tree に元からある行」を表す状態が要る**。

### `begin`/`end` は、時刻かトランザクション ID のどちらか

Hekaton の核心がこれになる。

```rust title="core/mvcc/database/mod.rs"
fn is_begin_visible<A: ConcurrentAllocator>(
    ...
) -> bool {
    match rv.begin() {
        Some(TxTimestampOrID::Timestamp(rv_begin_ts)) => {
            turso_assert!(
                tx.begin_ts != rv_begin_ts,
                "begin_ts and committed rv_begin_ts cannot be equal: txn timestamps are strictly monotonic"
            );
            tx.begin_ts > rv_begin_ts
        }
        Some(TxTimestampOrID::TxID(rv_begin)) => {
```

[`core/mvcc/database/mod.rs#L10158-L10172`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L10158-L10172)。

**`Timestamp` ならコミット済み。`TxID` ならまだ確定していない。**

同じフィールドが 2 つの意味を持つ。コミット時に `TxID` を `Timestamp` に書き換えるだけで、そのトランザクションが書いた全バージョンが一斉に見えるようになる。

未確定の場合は、そのトランザクションの状態を見にいく。

```rust title="core/mvcc/database/mod.rs"
                        TransactionState::Preparing(end_ts) => {
                            // Hekaton Table 1 / Section 2.5: speculative read of TB.
                            // If begin_ts > end_ts, the version would be visible once TB
                            // commits. Speculatively return true and register a dependency.
                            // Fixes partial commit visibility (Bug #8).
                            ...
                            if tx.begin_ts > end_ts {
                                register_commit_dependency(txs, tx, rv_begin);
                                true
                            } else {
                                false
                            }
                        }
```

[`core/mvcc/database/mod.rs#L10178-L10197`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L10178-L10197)。

**投機的読み取り (speculative read)。** 相手が「コミット準備中」なら、コミットするものとして扱って先に進む。ただし **依存関係を登録しておき、相手が中断したら自分も中断する**。

普通の MVCC なら、ここで待つ。待たずに進めることで、コミット中のトランザクションが他を止めない。**待ちを、後から取り消せる仮定に置き換えている。**

論文の誤りへの言及まである。

```rust title="core/mvcc/database/mod.rs"
                        // V's sharp mind discovered an issue with the hekaton paper which basically states that a
                        // transaction can see a row version if the end is a TXId only if it isn't the same transaction.
                        // Source: https://avi.im/blag/2023/hekaton-paper-typo/
                        TransactionState::Active => current_tx.tx_id != other_tx.tx_id,
```

[`core/mvcc/database/mod.rs#L10262-L10265`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L10262-L10265)。

**論文の表に誤植があり、それを外部の記事とともに記録している。** 論文どおりに実装すると間違う箇所を、次の読者のために残している。

### 書き込みの衝突は、待たずに中断する

```rust title="core/mvcc/database/mod.rs"
fn is_write_write_conflict<A: ConcurrentAllocator>(
    ...
) -> bool {
    match rv.end() {
        Some(TxTimestampOrID::TxID(rv_end)) => {
            if rv_end == tx.tx_id {
                return false;
            }
            match lookup_tx_state(txs, finalized_tx_states, rv_end) {
                Some(TransactionState::Aborted) | Some(TransactionState::Terminated) => false,
                Some(TransactionState::Active)
                | Some(TransactionState::Preparing(_))
                | Some(TransactionState::Committed(_)) => true,
                None => {
                    tracing::debug!(...);
                    true
                }
            }
        }
        // A non-"infinity" end timestamp (here modeled by Some(ts)) functions as a write lock
        // on the row, so it can never be updated by another transaction.
        // Ref: https://www.cs.cmu.edu/~15721-f24/papers/Hekaton.pdf , page 301,
        // 2.6. Updating a Version.
        Some(TxTimestampOrID::Timestamp(_)) => true,
        None => false,
    }
}
```

[`core/mvcc/database/mod.rs#L9876-L9908`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L9876-L9908)。

**MySQL との一番大きな違いがここにある。**

InnoDB では、更新しようとした行が他のトランザクションにロックされていたら **待つ**。待って、相手がコミットしたら、その最新版の上に自分の更新を重ねる。

Turso では **待たずに衝突を返す**。後から来た方が中断する (first-writer wins)。

だから **アプリケーション側にリトライが要る**。楽観的並行制御に共通する性質で、`BEGIN CONCURRENT` という名前が「これは普通のトランザクションとは違う」を示している。

判定できない場合の扱いにも注目したい。**`None` (相手のトランザクションが見つからない) を「衝突している」と解釈している。** 分からないときは安全側に倒す。

### 状態は全部ロックフリーのスキップリスト

```rust title="core/mvcc/database/mod.rs"
pub struct MvStore<Clock: LogicalClock, A: ConcurrentAllocator = TursoAllocator> {
    pub rows: SkipMap<RowID, RowVersions<A>, BasicComparator, A>,
    ...
    txs: SkipMap<TxID, Transaction<A>, BasicComparator, A>,
    /// Final state for removed transactions. Readers may still race with stale TxID
    /// references in row versions after a transaction is removed from `txs`.
    finalized_tx_states: SkipMap<TxID, TransactionState, BasicComparator, A>,
```

[`core/mvcc/database/mod.rs#L3980-L4010`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L3980-L4010)。

スキップリストは `core/skiplist/` に取り込まれている ([アロケータを差し替えるため](../allocation-site/))。**ロックを取らずに並行して読み書きできるので、可視性判定が他のトランザクションを止めない。**

`finalized_tx_states` の存在理由が的確だ。**終わったトランザクションを `txs` から消しても、行バージョンの中にはその ID が残っている。** 消えた ID を引いたときに「分からない」ではなく「中断した」「コミットした」を答えられるよう、最終状態だけを別に残す。

**参照が残る可能性がある ID は、消した後も答えを用意しておく。**

### 耐久化は論理ログへ

```rust title="core/mvcc/database/mod.rs"
/// A log record contains all durable effects of a committed transaction,
/// pre-serialized into a frame buffer that the logical-log flush path
/// finalizes (backfills the TX header, appends the CRC trailer, optionally
/// chunk-encrypts the payload) and writes to disk.
#[derive(Debug)]
pub struct LogRecord {
    pub(crate) tx_timestamp: TxID,
    /// Frame buffer that grows in place into the on-disk representation.
    /// The first `LOG_HDR_SIZE + TX_HEADER_SIZE` bytes are pre-reserved
    /// (zeros) so that op-entry appends land at the correct on-disk
    /// offset; the flush path backfills the framing prefix and appends
    /// the trailer.
    pub buf: DynVec<u8>,
```

[`core/mvcc/database/mod.rs#L484-L497`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L484-L497)。

これが `.db-log` に書かれる。[WAL](../wal/) がページ全体を書くのに対し、**論理ログは変更された行だけを書く。**

`docs/agent-guides/mvcc.md` の対比表がそれを端的に示している。

```text title="docs/agent-guides/mvcc.md"
| Aspect | WAL | MVCC |
|--------|-----|------|
| Write granularity | Every commit writes full pages | Affected rows only
| Persistence | `.db-wal` | `.db-log` (logical log) |
| Isolation | Snapshot (page-level) | Snapshot (row-level) |
```

[`docs/agent-guides/mvcc.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/agent-guides/mvcc.md)。

**1 行だけ更新したときに書くバイト数が、ページサイズから行サイズに落ちる。** 小さな更新が多いワークロードでは、これが決定的に効く。

バッファの作り方も細かい。**ヘッダの分だけ先にゼロを詰めておき、後から書き戻す。** こうすると、本体を書いている間はヘッダの内容を知らなくていいし、最後に 1 個のバッファをそのまま書ける。連結もコピーも要らない。

そして最終的には、行バージョンは B-tree に書き戻される。それがチェックポイントで、[次のページ](../mvcc-gc/) の主題になる。

## なぜそうなっているか

- **`BEGIN CONCURRENT` を独立機能にせず MVCC の入口にしたのは、意味論が MVCC そのものだから。** 「並行に書ける」は結果であって、実体は行バージョンと衝突検出になる。
- **排他トランザクションを MVCC の中に残したのは、SQLite 互換のため。** `BEGIN IMMEDIATE` の意味は「1 writer」なので、MVCC を有効にしてもそれは変わってはいけない。
- **Hekaton を選んだのは、インメモリ前提だから。** InnoDB の undo 方式はディスク上の版鎖を辿るので、ページ I/O が発生する。全部メモリにある前提なら、版を並べて置く方が単純で速い。
- **`begin`/`end` に時刻と ID の両方を入れられるようにしたのは、コミットを 1 回の書き換えにするため。** 全バージョンを走査して書き換えるのではなく、トランザクションの状態を変えるだけで一斉に見え方が変わる。
- **投機的読み取りを入れたのは、コミット中のトランザクションが他を止めないようにするため。** 待つ代わりに、仮定して進み、外れたら巻き添えで中断する。
- **論文の誤植を記録したのは、次に読む人が同じ罠にはまるから。** 「論文どおりに実装したら間違い」は、コメントがなければ絶対に伝わらない。
- **衝突を待たずに中断するのは、待つとデッドロック検出が要るから。** 楽観的にして即座に失敗させれば、待ちグラフを持つ必要がない。代償はアプリケーション側のリトライになる。
- **判定不能を衝突として扱うのは、安全側だから。** 誤って衝突と判定すればトランザクションが 1 つ失敗するだけだが、逆は更新の消失になる。
- **終了したトランザクションの最終状態を別に残すのは、参照が残るから。** 行バージョンの中の ID は、トランザクションが消えても残る。
- **防げていない異常を TODO に書いたのは、スナップショット分離の限界だから。** write skew が起きることを隠すと、利用者が直列化可能だと誤解する。

## どう活かすか

- **楽観的並行制御を導入するなら、失敗が利用者に見えることを設計に含める。** 待たない代わりに失敗するので、リトライは呼び出し側の責任になる。それを隠すインタフェースを作ると、隠しきれずに漏れる。
- **同じフィールドに「確定値」と「未確定の参照」を入れられるようにすると、確定処理が 1 箇所で済む。** 全要素を走査して書き換える代わりに、参照先の状態を変えるだけで済む。
- **待ちを、取り消せる仮定に置き換えられないか考える。** 「相手がコミットする前提で進み、外れたら巻き添えで失敗する」は、待ち行列を持つより単純になることがある。
- **判定できない場合は、被害の小さい側に倒す。** 「相手が見つからない」を安全側に解釈するだけで、レースの多くが無害になる。
- **消したオブジェクトへの参照が残りうるなら、最終状態だけ別に保存する。** 「見つからない」を答えとして返すと、呼び出し側が判断できない。
- **論文や仕様の誤りを見つけたら、コメントに出典つきで書く。** 「なぜ仕様と違う実装になっているのか」は、コードからは絶対に読み取れない。
- **保証していない異常を、明示的に列挙する。** 「スナップショット分離を提供する」だけでは、何が起きないかが分からない。防げるものと防げないものを両方書く。
- **可変長のレコードを書くときは、ヘッダ分の領域を先に空けておく。** 後から書き戻せば、バッファの連結も再確保も要らない。
