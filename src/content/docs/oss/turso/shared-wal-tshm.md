---
title: "`.shm` を捨てて `.tshm` を作り直し、マルチプロセスを取り戻す"
description: "「マルチプロセスは絶対にサポートしないので共有メモリファイルは要らない」というコメントを残してプロセス内の HashMap で作った WAL 索引を、後からプロセス間で共有する必要が出てきた。SQLite の .shm 形式をなぞるのではなく .tshm という別形式を新設し、バイト範囲ロックで所有権を、mmap でメタデータの高速路を作っている。難しいのは生存判定で、POSIX の fcntl ロックがプロセス単位であることが設計をねじ曲げている。"
group: "トランザクションと並行性"
sidebar:
  order: 13
---

## 何を学んだか

[前のページ](../wal/) で見たコメントを、もう一度引く。

```rust title="core/storage/wal.rs"
    // One difference between SQLite and limbo is that we will never support multi process, meaning
    // we don't need WAL's index file. So we can do stuff like this without shared memory.
```

**「マルチプロセスは絶対にサポートしないので、WAL の索引ファイルは要らない」。**

この前提は覆った。今の Turso には `.tshm` (Turso shared memory) がある。

```text title="docs/sql-reference/multiprocess-access.mdx"
| File | Purpose |
|------|---------|
| `mydb.db` | The database file (unchanged). |
| `mydb.db-wal` | The write-ahead log (unchanged). |
| `mydb.db-tshm` | Turso shared memory. Memory-mapped coordinator that tracks WAL state, the active writer, the active checkpointer, reader slots, and a shared page-to-frame index. |
```

[`docs/sql-reference/multiprocess-access.mdx`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/sql-reference/multiprocess-access.mdx)。

**注目したいのは、SQLite の `.shm` をそのまま実装しなかったこと。** 互換性を最優先するプロジェクトが、ここでは互換をやめている。[互換性の保証](../sqlite-compat/) の 4 番目がその許可を出している。

```text title="COMPAT.md"
4. We don't support mixed SQLite and Turso in multi-process scenarios.
```

**「SQLite と Turso が同じファイルを同時に開くことは、そもそもサポートしない」** と先に宣言してあるので、`.shm` の形式に合わせる理由がない。**諦める項目を先に決めておいたことが、後の設計の自由を生んでいる。**

## ソースコードのどこか

### 何を共有メモリに置き、何を置かないか

```rust title="core/storage/shared_wal_coordination.rs"
//! Cross-process shared WAL coordination backed by the `.tshm` file.
//!
//! The mmap stores three kinds of state:
//!
//! 1. An authoritative WAL snapshot header (`max_frame`, checksums, salts,
//!    checkpoint counters).
//! 2. Cross-process ownership state for the single writer, the single
//!    checkpointer, and every active reader slot.
//! 3. A shared page-to-frame index so readers can resolve WAL pages without a
//!    process-local WAL scan.
//!
//! The design intentionally splits responsibilities between shared memory and
//! process-local bookkeeping:
//!
//! - Shared memory is the source of truth across processes.
//! - Process-local registries prevent same-process re-opens from reclaiming or
//!   double-using slots that are still owned by sibling connections.
//! - The shared frame index is append-only within a WAL generation and is only
//!   published after each entry is fully written, so other processes never
//!   observe half-written mappings.
//!
//! Stale-owner reclamation is best-effort and must only trade performance for
//! conservatism, never correctness: if the authority cannot prove a slot is
//! dead, it must leave that slot in place.
```

[`core/storage/shared_wal_coordination.rs#L1-L24`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L1-L24)。

**モジュールの先頭 24 行に、設計の全部が書いてある。** 特に最後の 2 段落が重要だ。

- **共有メモリが唯一の真実。ただしプロセス内の帳簿も別に持つ。**
- **索引は世代の中では追記のみ。書き終わってから公開する。**
- **死んだ所有者の回収は best-effort。証明できなければ触らない。**

3 つ目が、この種の設計で最も間違えやすいところになる。

### 所有権はバイト範囲ロックで

```rust title="core/storage/shared_wal_coordination.rs"
/// Byte 0: lifetime lock used only to detect whether another process is present.
const PROCESS_LIFETIME_LOCK_OFFSET: u64 = 0;
/// Byte 1: single-writer ownership byte.
const WRITER_LOCK_OFFSET: u64 = 1;
/// Byte 2: single-checkpointer ownership byte.
const CHECKPOINT_LOCK_OFFSET: u64 = 2;
/// Byte range starting at 3: one reader-byte lock per shared reader slot.
const READER_LOCK_START_OFFSET: u64 = 3;
```

[`core/storage/shared_wal_coordination.rs#L51-L58`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L51-L58)。

**ファイルの各バイトに 1 つずつロックを対応させる。** これは SQLite が `-shm` でやっているのと同じ手法で、`fcntl` のバイト範囲ロックを「名前付きのロック」として使う。

なぜ mmap 上のアトミック変数ではなく、ファイルロックなのか。**プロセスが死んだとき、OS がロックを自動的に解放してくれるから**だ。mmap 上のフラグは、死んだプロセスが立てたまま残る。

だからロールは 2 系統で管理される。

- **ロックバイト** — 生きているかどうかの権威。OS が保証する
- **mmap 上の所有者フィールド** — 誰が持っているかの情報。古くなりうる

```rust title="core/storage/shared_wal_coordination.rs"
    /// Attempt to reclaim a reader slot whose lock byte is no longer held.
    ///
    /// This is the safe stale-reader path because the reader byte lock is what
    /// actually blocks checkpoints; shared owner metadata can be stale.
    fn try_reclaim_stale_reader_slot(&self, slot_index: u32) -> bool {
```

[`core/storage/shared_wal_coordination.rs#L1906-L1910`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L1906-L1910)。

**回収の判定にはロックバイトを使い、mmap 上の所有者情報は使わない。** 後者は古くなりうると明記されている。

### `fcntl` ロックがプロセス単位であることが、設計をねじ曲げる

POSIX の `fcntl` ロックには有名な落とし穴がある。**同じプロセス内では、別の fd から取っても衝突しない。** しかもファイルを閉じると、そのファイルに対する全ロックが解放される。

Linux には OFD ロック (open file description lock) があってこれを回避できるが、macOS にはない。

```rust title="core/storage/shared_wal_coordination.rs"
/// Per-connection ownership bookkeeping within a single process.
///
/// Multiple connections share the same `MappedSharedWalCoordination` and the
/// same `SharedOwnerRecord`, so the shared-memory owner field alone cannot
/// distinguish which connection holds a slot. This struct fills that gap.
///
/// On non-OFD platforms (macOS) it is also the only way to distinguish
/// "same-process sibling connection" from "another process" during stale
/// reclamation, because POSIX fcntl locks are per-process, not per-fd.
#[derive(Debug)]
struct ProcessLocalOwnershipState {
```

[`core/storage/shared_wal_coordination.rs#L118-L128`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L118-L128)。

**プロセス内の帳簿を別に持つ理由が、ここに全部書いてある。**

同じプロセスの兄弟接続がスロットを持っている場合、ロックバイトを試しに取ると **成功してしまう**。「誰も持っていない」と誤判定して、生きているスロットを回収する。

だから回収の前に、プロセス内の帳簿を見る。

```rust title="core/storage/shared_wal_coordination.rs"
        if self.uses_linux_ofd_locking() {
            let should_probe = self.with_local_lock_state(|entry| {
                ...
                entry.reader_locks[slot_index as usize] == 0
            });
            if !should_probe {
                return false;
            }
```

[`core/storage/shared_wal_coordination.rs#L1911-L1921`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L1911-L1921)。

**自分のプロセスが持っているスロットは、そもそも試しに取らない。**

`reader_locks` が `bool` ではなく `Vec<usize>` (件数) なのも同じ事情による。

```rust title="core/storage/shared_wal_coordination.rs"
/// Process-private mirror of which locks THIS process currently holds.
///
/// Multiple `Connection`s to the same `Database` share a single
/// `MappedSharedWalCoordination` (and therefore a single `LocalLockState`).
/// The per-slot counts (not booleans) track how many connections within this
/// process hold each slot, so `register_reader` can skip slots already
/// occupied by a sibling connection, and `min_active_reader_frame` can
/// recognize "our own slot" without probing the cross-process lock.
```

[`core/storage/shared_wal_coordination.rs#L101-L109`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L101-L109)。

**「プロセス間の同期を、プロセス内の同期で補完する」** 二層構造になっている。

### 「証明できないなら触らない」

```rust title="core/storage/shared_wal_coordination.rs"
    /// For reader slots, we must NOT blindly clear slots owned by
    /// live processes: doing so would cause those processes to panic with
    /// "reader slot released by non-owner" when they try to end their read
    /// transactions, corrupting the shared WAL state.
    ///
    /// Probe the slot byte lock directly on every platform. That lock is the
    /// authoritative liveness signal for this database file; relying on PID
    /// probes here is weaker and can misclassify recycled PIDs as live.
    pub(crate) fn repair_transient_state_for_exclusive_open(&self) {
```

[`core/storage/shared_wal_coordination.rs#L1278-L1290`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L1278-L1290)。

**PID で生存を判定しない、と明記されている。** PID は再利用される。死んだプロセスの PID を別のプロセスが持っていれば、「生きている」と誤判定する。

判定に使えるのは「このファイルに対するロックが今も保持されているか」だけになる。**OS が保証している事実だけを根拠にする。**

失敗したときの症状も書いてある。生きているスロットを回収すると、**その持ち主が読み取りを終えるときに「所有者でないのに解放しようとした」で panic する**。[「壊すより落ちる」](../architecture/) の原則どおり、そこは assert で止まる。

だから **回収側が保守的でなければならない**。回収し損ねればスロットが 1 個無駄になるだけだが、間違って回収すると別プロセスが落ちる。

### 索引は書き終わってから公開する

```rust title="core/storage/shared_wal_coordination.rs"
//! - The shared frame index is append-only within a WAL generation and is only
//!   published after each entry is fully written, so other processes never
//!   observe half-written mappings.
```

mmap には「途中まで書けている」を防ぐ仕組みがない。他のプロセスは、いつでも任意のバイトを読める。

対策は **「完全に書いてから、最後に 1 個のアトミック変数で見えるようにする」** になる。エントリの本体を書き、それが全部見えるようになってから、末尾の位置を進める。

スナップショットの入れ替えでも同じ順序を守っている。

```rust title="core/storage/shared_wal_coordination.rs"
    /// Replace the authoritative shared snapshot visible to all processes.
    ///
    /// Any frame-index entries beyond the new tail are discarded first so the
    /// published header and published page-to-frame index stay in sync.
    pub(crate) fn install_snapshot(&self, snapshot: SharedWalCoordinationHeader) {
        self.clear_backfill_proof();
        // Snapshots define the authoritative visible WAL range. If the shared
        // frame index still carries entries from an older generation past that
        // range, trim them before publishing the new header so later frame
        // appends cannot observe a stale tail.
        self.rollback_frames(snapshot.max_frame);
        self.with_snapshot_write(|header| {
```

[`core/storage/shared_wal_coordination.rs#L1231-L1246`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L1231-L1246)。

**先に索引を切り詰めてから、ヘッダを公開する。** 逆順にすると、新しいヘッダを見たプロセスが古い世代の索引エントリを引いてしまう。

索引の構造は、SQLite の `-shm` を参考にしている。

```rust title="core/storage/shared_wal_coordination.rs"
/// Entries per frame-index block in the append-only shared page->frame index.
const FRAME_INDEX_BLOCK_CAPACITY: u32 = 4096;
/// Open-addressing hash slots per frame-index block.
///
/// Mirroring SQLite's oversubscription keeps probe chains short without making
/// each block materially larger.
const FRAME_INDEX_BLOCK_HASH_SLOTS: u32 = FRAME_INDEX_BLOCK_CAPACITY * 2;
```

[`core/storage/shared_wal_coordination.rs#L59-L64`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/shared_wal_coordination.rs#L59-L64)。

**形式は互換にしないが、設計の知見は借りる。** ハッシュスロットを容量の 2 倍取ると探索列が短くなる、というのは SQLite が実証済みの数字だ。

プロセス内の `HashMap` ([前のページ](../wal/)) と比べると、こちらは **固定サイズのブロックに区切って追記する**。mmap 上では動的な再確保ができないので、ブロック単位で伸ばすしかない。上限は 64 ブロックと決まっている。

### 動かないファイルシステムは、明示的に拒否する

```rust title="core/database.rs"
    pub(crate) fn filesystem_magic_allows_shared_wal(filesystem_magic: libc::c_long) -> bool {
        const AFS_SUPER_MAGIC: libc::c_long = 0x5346_414f;
        const CIFS_SUPER_MAGIC: libc::c_long = 0xFF53_4D42u32 as libc::c_long;
        const CODA_SUPER_MAGIC: libc::c_long = 0x7375_7245;
        const CEPH_SUPER_MAGIC: libc::c_long = 0x00C3_6400;
        const GFS2_SUPER_MAGIC: libc::c_long = 0x0116_1970;
        const LUSTRE_SUPER_MAGIC: libc::c_long = 0x0BD0_0BD0;
        const NCP_SUPER_MAGIC: libc::c_long = 0x564c;
        const NFS_SUPER_MAGIC: libc::c_long = 0x6969;
        const OCFS2_SUPER_MAGIC: libc::c_long = 0x7461_636f;
        const SMB2_SUPER_MAGIC: libc::c_long = 0xFE53_4D42u32 as libc::c_long;
        const V9FS_SUPER_MAGIC: libc::c_long = 0x0102_1997;

        !matches!(
            filesystem_magic,
            AFS_SUPER_MAGIC
                | CIFS_SUPER_MAGIC
                ...
        )
    }
```

[`core/database.rs#L2522-L2554`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/database.rs#L2522-L2554)。

`statfs(2)` でファイルシステムの種類を調べ、**危ないものを列挙して拒否する。** NFS、SMB、CephFS、Lustre、GFS2、9P、AFS。

理由はドキュメント側にある。

```text title="docs/sql-reference/multiprocess-access.mdx"
| NFS | Advisory lock semantics diverge across clients |
| CIFS / SMB2 | Same as above; mmap coherence is not guaranteed |
| CephFS | Distributed cache semantics |
```

**「ロックの意味論がクライアント間でずれる」「mmap の一貫性が保証されない」。** どちらもこの設計の土台そのものだ。

拒否リスト (deny list) にしているのが判断として面白い。許可リスト (allow list) にすると、知らないファイルシステムが全部使えなくなる。**「危ないと分かっているものを拒否し、それ以外は通す」** を選んでいる。実験的機能であることと釣り合っている。

## なぜそうなっているか

- **`.shm` 互換をやめたのは、互換にする必要がないと先に宣言していたから。** 「SQLite と混在させない」を保証の 4 番目に書いてあるので、形式を合わせる義務がない。**諦める項目を先に決めておくと、後で設計の自由が手に入る。**
- **所有権をバイト範囲ロックで表したのは、プロセスの死を OS に検出させるため。** mmap 上のフラグは、プロセスが死んでも立ったまま残る。ロックは OS が解放する。
- **mmap の所有者フィールドと、ロックバイトを両方持つのは、役割が違うから。** 前者は「誰が」を答え、後者は「生きているか」を答える。前者だけを信じると、死んだプロセスの情報を信じることになる。
- **プロセス内の帳簿を別に持つのは、`fcntl` ロックがプロセス単位だから。** 同じプロセスの別接続が持つロックは、試しに取ると成功してしまう。OS が区別してくれない以上、自分で区別するしかない。
- **スロットの保持を件数で持つのは、同じプロセスの複数接続が同じスロットを共有するから。** 真偽値だと、1 人が解放したときに全員分が消える。
- **PID で生存判定しないのは、PID が再利用されるから。** 「死んだプロセスの PID を、新しいプロセスが持っている」は普通に起きる。
- **回収を保守的にしたのは、失敗の非対称性があるから。** 回収し損ねる = スロット 1 個の無駄。誤って回収する = 別プロセスが panic。片方が桁違いに重い。
- **索引を書き切ってから公開するのは、mmap に部分書き込みの防護がないから。** 読み手はいつでも任意のバイトを読める。「完成してから見えるようにする」以外に手がない。
- **索引を切り詰めてからヘッダを公開するのは、順序を逆にすると新しいヘッダで古い索引を引くから。** 公開の順序は、依存関係の逆順になる。
- **危ないファイルシステムを拒否リストにしたのは、実験的機能だから。** 許可リストは安全だが、知らないファイルシステムを全部弾く。既知の地雷だけを避ける方が、現段階では釣り合う。

## どう活かすか

- **「絶対にやらない」と決めた前提は、コメントに書いておく。** 覆ったときに、どこを直せばいいかが検索で見つかる。Turso のこの前提は実際に覆った。
- **互換性の定義に「諦める項目」を入れておくと、後で自由が手に入る。** 「混在はサポートしない」と先に言ってあれば、そこは自分の都合で設計していい。
- **プロセスをまたぐ所有権は、OS が解放してくれる仕組みで表す。** ファイルロックは、プロセスが死ねば自動的に外れる。共有メモリ上のフラグにはその性質がない。
- **「誰が持っているか」と「生きているか」を、別の仕組みで持つ。** 前者は情報、後者は権威。回収の判断には後者だけを使う。
- **`fcntl` ロックを使うなら、プロセス単位であることを設計に織り込む。** 同一プロセス内では衝突しない。OFD ロックがない環境では、自前の帳簿で補うしかない。
- **生存判定に PID を使わない。** 再利用される。ファイル記述子、ロック、ソケットなど「死ねば必ず消えるもの」を根拠にする。
- **回収処理は、失敗の非対称性で保守側に倒す。** 「回収し損ねる」と「誤って回収する」の被害が同じことはまずない。重い方を絶対に避ける。
- **共有メモリに書くときは、完成してから 1 個のアトミックで公開する。** 読み手は途中の状態を見られる。公開の順序は依存の逆順にする。
- **形式は互換にしなくても、設計の知見は借りる。** 「ハッシュスロットを 2 倍取る」のような実証済みの数字は、そのまま使える。
- **動作を保証できない環境は、起動時に検出して拒否する。** 動いてしまってから壊れるより、開けない方がよい。既知の地雷だけを避けるなら拒否リスト、確実性が要るなら許可リストを選ぶ。
