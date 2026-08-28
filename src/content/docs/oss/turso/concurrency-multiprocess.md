---
title: "`WalFileShared` を複数プロセスで共有するための配線"
description: "`.tshm` は mmap されたファイルで、WAL のスナップショット、所有権、ページ→フレーム索引の 3 つを持つ。所有者は「PID を 32 ビット上位、接続の連番を下位」に詰めた 64 ビットで表され、生死の判定は PID ではなくロックバイトを直接プローブして行う。PID は再利用されるからだ。そして回収は必ず保守側に倒す — 死んでいると証明できなければ、そのスロットは触らない。"
group: "並行性の層"
sidebar:
  order: 22
---

## この層の責務

[前のページ](../concurrency-in-process/) で見た調停は、全部プロセス内のメモリで済んでいた。`TursoRwLock` は `AtomicU64` 1 個で、同じ `Database` を共有する接続の間でしか意味を持たない。

別のプロセスが同じ `.db` を開いてきたら、その調停はメモリでは足りない。**`.tshm` というファイルを mmap して共有する。**

なぜ SQLite の `.db-shm` をそのまま使わなかったか、という設計判断は [`.tshm` のページ](../shared-wal-tshm/) が扱う。ここでは**その仕組みがどう配線されているか**を追う。

## 主要な型とその関係

### 共有するのは 3 種類の状態

```rust title="core/storage/shared_wal_coordination.rs:1-24 (モジュールコメント)"
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

**この 24 行に、この機構の設計方針が全部書いてある。**

- 共有メモリが正、プロセスローカルは補助
- フレーム索引は世代内で追記のみ、書き終わってから公開
- **回収は保守側に倒す。死んでいると証明できなければ触らない**

3 番目が最も重要だ。生きているプロセスのスロットを誤って回収すると、そのプロセスが見ているフレームがチェックポイントで消される。**データが壊れる。**

### ヘッダは 76 バイト

```rust title="core/storage/shared_wal_coordination.rs:387-400"
pub(crate) struct SharedWalCoordinationHeader {
    pub max_frame: u64,
    pub nbackfills: u64,
    pub transaction_count: u64,
    pub visibility_generation: u64,
    pub checkpoint_seq: u32,
    pub checkpoint_epoch: u32,
    pub page_size: u32,
    pub salt_1: u32,
    pub salt_2: u32,
    pub checksum_1: u32,
    pub checksum_2: u32,
    pub reader_slot_count: u32,
}

impl SharedWalCoordinationHeader {
    pub(crate) const BYTE_LEN: usize = 76;
```

[状態の地図のページ](../shared-state-map/) で見た `WalSharedMetadata` (プロセス内共有) と、内容がほぼ対応する。**同じ情報を、プロセス内ではアトミック変数で、プロセス間では mmap のバイト列で持つ。**

エンコード / デコードは手書きで、リトルエンディアン固定だ。

```rust title="core/storage/shared_wal_coordination.rs:406-410 (抜粋)"
pub(crate) fn encode(self) -> [u8; Self::BYTE_LEN] {
    let mut bytes = [0u8; Self::BYTE_LEN];
    bytes[0..8].copy_from_slice(&SHARED_WAL_COORDINATION_MAGIC);
    bytes[8..12].copy_from_slice(&SHARED_WAL_COORDINATION_VERSION.to_le_bytes());
```

`.db` ファイルがビッグエンディアンなのと逆だ ([オンディスク形式のページ](../ondisk-format/))。**`.tshm` は SQLite 互換の対象ではない**ので、形式を自由に決められる。マジックとバージョンが先頭にあり、合わなければ `Corrupt` を返す。

### 所有者は「PID + 接続の連番」

```rust title="core/storage/shared_wal_coordination.rs:301-318 (抜粋)"
/// Pack a `(pid, instance_id)` pair into the durable owner-slot format.
pub(crate) fn new(pid: u32, instance_id: u32) -> Self {
    let raw = ((pid as u64) << 32) | instance_id as u64;
    turso_assert!(raw != UNOWNED_LOCK, "shared owner record must be non-zero");
    Self(raw)
}

pub(crate) const fn pid(self) -> u32 {
    (self.0 >> 32) as u32
}

pub(crate) const fn instance_id(self) -> u32 {
    self.0 as u32
}
```

**PID だけでは足りない。** 同じプロセスの複数の接続が、それぞれ別のスロットを持ちうるからだ。プロセス内で単調増加する連番を下位 32 ビットに入れて区別する。

```rust title="core/storage/shared_wal_coordination.rs:321-325 (抜粋)"
/// Allocate the next process-local connection instance ID.
///
/// IDs only need to be unique within one process lifetime; wraparound back to
/// `1` is acceptable once the full `u32` space is exhausted.
fn next_shared_owner_instance_id() -> u32 {
```

`0` は「未所有」の番兵なので使わない。ラップアラウンドしたら `1` に戻る。

### ロックはファイルのバイト位置

```rust title="core/storage/shared_wal_coordination.rs:647-654 (doc コメント)"
/// ## Lock byte layout on the tshm file
///
/// | Offset    | Purpose
/// |-----------|---------------
/// | 0         | Process-lifetime shared/exclusive lock (determines Exclusive vs MultiProcess open)
/// | 1         | Writer lock
/// | 2         | Checkpoint lock
/// | 3..3+N    | Reader slot locks (one byte per slot)
```

[前のページ](../concurrency-in-process/) の `TursoRwLock` の一覧と、そのまま対応している。

| プロセス内         | プロセス間                       |
| ------------------ | -------------------------------- |
| (なし)             | オフセット 0: プロセス生存ロック |
| `write_lock`       | オフセット 1                     |
| `checkpoint_lock`  | オフセット 2                     |
| `read_locks[0..5]` | オフセット 3 以降                |

**オフセット 0 だけがプロセス内に対応物を持たない。** 「他のプロセスがこのファイルを開いているか」を判定するためだけに存在する。

## 処理の流れ (コードを追う)

### 開くときにオフセット 0 をプローブする

```rust title="core/storage/shared_wal_coordination.rs:600-610"
/// How the tshm file was opened, determined at open time by probing byte 0.
///
/// - `Exclusive`: no other process had the file open. The opener is free to
///   reinitialize or repair any shared state.
/// - `MultiProcess`: at least one other process already has the file open.
///   The opener must not clobber state that the peer may be relying on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SharedWalCoordinationOpenMode {
    Exclusive,
    MultiProcess,
}
```

**排他で取れたら、他に誰もいない。** その場合だけ共有状態を初期化・修復してよい。取れなければ誰かがいるので、既存の状態を壊してはいけない。

この判定は開いた瞬間に 1 回だけ行われ、以後変わらない。後から別プロセスが参加してきても `Exclusive` のままだが、**そのときには既に共有状態が正しく初期化されているので問題にならない**。

### ロックの実装が OS で 2 種類ある

```rust title="core/storage/shared_wal_coordination.rs:612-623"
/// Which locking primitive is used for cross-process slot ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SharedWalOwnershipMode {
    /// `F_OFD_SETLK`: per file-description, survives `dup()`, independent
    /// across separate `open()` calls. Stale detection: probe the lock.
    LinuxOfd,
    /// `F_SETLK`: per-process, shared across all fds to the same file.
    /// Stale detection must probe the lock byte itself because PID liveness is
    /// not a reliable ownership proof after PID reuse.
    ProcessScopedFcntl,
}
```

**Linux の `F_OFD_SETLK` は「ファイル記述ごと」のロックだ。** 同じプロセスが 2 回 `open()` すれば、2 つの独立したロックが取れる。だからプロセス内の複数接続が、それぞれ別の reader スロットを自然に持てる。

古典的な `F_SETLK` は「プロセスごと」で、同じプロセスの 2 つ目の `open()` は 1 つ目のロックを上書きしてしまう。macOS はこちらしかない。

```rust title="core/storage/shared_wal_coordination.rs:641-646 (doc コメント抜粋)"
/// - **macOS / other Unix (process-scoped fcntl)**: Classical `F_SETLK`
///   locks (per-process, not per-fd). Stale-owner detection must still probe
///   the lock byte itself; PID liveness is not a reliable ownership proof once
///   PIDs can be recycled. The shared owner fields remain metadata used for
///   diagnostics and non-owner assertions.
```

**この差を吸収するのが `PROCESS_LOCAL_COORDINATION_OPENS` レジストリ**だ。

```rust title="core/storage/shared_wal_coordination.rs:76-87 (抜粋)"
/// Defensive dedup registry for tshm mappings within a single process.
///
/// In production, `DATABASE_MANAGER` already ensures one `Database` (and
/// therefore one `Arc<MappedSharedWalCoordination>`) per file per process.
/// This registry enforces that invariant for callers that bypass the manager.
static PROCESS_LOCAL_COORDINATION_OPENS: LazyLock<
    Mutex<HashMap<PathBuf, ProcessLocalCoordinationEntry>>,
> = LazyLock::new(|| Mutex::new(HashMap::default()));
```

[起動のページ](../boot-and-wiring/) で見た `DATABASE_MANAGER` と同じ理由で、**「プロセス内では 1 つ」を別のレジストリで保証する**。POSIX のロックがプロセス内では調停にならないという問題が、ここでも同じ形で現れている。

### 死んだ所有者の検出は「ロックを取ってみる」

PID の生死は補助情報でしかない。

```rust title="core/storage/shared_wal_coordination.rs:338-356 (抜粋)"
/// Check whether a process is still running.
///
/// On Unix this uses `kill(pid, 0)`, which is a no-op probe that checks
/// permissions and existence without delivering a signal. ...
///
/// False-negatives are avoided; false-positives are still possible if a PID
/// has been recycled by an unrelated process.
#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
```

**`EPERM` を「生きている」と数えている。** シグナルを送る権限がないだけで、プロセスは存在する。別ユーザのプロセスがそのスロットを持っている場合だ。

そして「偽陰性は避けるが、偽陽性はありうる」と明記されている。**PID が再利用されると、無関係なプロセスを「所有者が生きている」と誤判定する。**

これが問題にならないのは、判定の方向が保守側だからだ。誤って「生きている」と判断しても、スロットが回収されないだけで壊れない。逆に「死んでいる」と誤判定すると壊れるので、そちらを起こさない設計になっている。

だから実際の回収判定は、PID ではなく**ロックバイト自体をプローブする**。取れたら本当に誰も持っていない。

### フレーム索引は追記のみ、ブロック単位

```rust title="core/storage/shared_wal_coordination.rs:58-70"
/// Entries per frame-index block in the append-only shared page->frame index.
const FRAME_INDEX_BLOCK_CAPACITY: u32 = 4096;
/// Open-addressing hash slots per frame-index block.
///
/// Mirroring SQLite's oversubscription keeps probe chains short without making
/// each block materially larger.
const FRAME_INDEX_BLOCK_HASH_SLOTS: u32 = FRAME_INDEX_BLOCK_CAPACITY * 2;
/// Hard cap on reserved frame-index blocks in one `.tshm` generation.
const MAX_FRAME_INDEX_BLOCKS: u32 = 64;
/// Blocks provisioned on first open before the index grows lazily.
const INITIAL_FRAME_INDEX_BLOCKS: u32 = 1;
/// Maximum number of shared frame-index entries representable by the mapping.
const MAX_FRAME_INDEX_CAPACITY: u32 = FRAME_INDEX_BLOCK_CAPACITY * MAX_FRAME_INDEX_BLOCKS;
```

1 ブロック 4096 エントリ、ハッシュスロットはその 2 倍、最大 64 ブロック。**合計 262,144 フレームまで。**

構造は SQLite の `.db-shm` と同じ考え方で、**開放アドレス法のハッシュ表を 2 倍に取ってプローブ列を短く保つ**。

エントリ自体は 16 バイトしかない。

```rust title="core/storage/shared_wal_coordination.rs:595-598"
struct SharedWalFrameIndexEntry {
    page_id: u64,
    frame_id: u64,
}
```

**書き終わってから公開する**という規約がモジュールコメントに書かれていた。`page_id` と `frame_id` を両方書き終えてから、ハッシュスロットにインデックスを入れる。そうしないと、他のプロセスが半分書けたエントリを読む。

初回は 1 ブロックだけ確保し、必要に応じて増やす。`.tshm` のファイルサイズが最初から数 MB になるのを避けるためだ。

## 守られている不変条件

**回収は保守側に倒す。死んでいると証明できないスロットは触らない。**

**フレーム索引は世代内で追記のみ。** 上書きしない。

**エントリは完全に書いてから公開する。** 半端な状態を他プロセスに見せない。

**`MultiProcess` で開いたら共有状態を初期化しない。**

**プロセス内でも `.tshm` のマッピングは 1 つ。** レジストリで保証する。

**所有者レコードは 0 にならない。** `turso_assert!` で確認。

## つまずきどころ / 設計の含み

### 同じ情報が 3 つの形で存在する

WAL の `max_frame` を例に取ると、

1. `WalFile.max_frame: AtomicU64` — この接続のスナップショット
2. `WalSharedMetadata.max_frame: AtomicU64` — プロセス内の権威
3. `SharedWalCoordinationHeader.max_frame: u64` (mmap) — プロセス間の権威

マルチプロセスを有効にすると、**2 は 3 のキャッシュになる**。無効なら 2 が権威で 3 は存在しない。

[状態の地図のページ](../shared-state-map/) で見た「3 段」がここで完成する。そして段が増えたぶん、**下の段の変化を上の段が検出する仕掛け**が必要になる — `checkpoint_epoch`、`visibility_generation`、`frame_cache_high_water`、`overflow_fallback_coverage`。

これらは全部「上の段のキャッシュがまだ有効か」を判定するための変数だ。1 段だけなら 1 つも要らない。

### `visibility_generation` はプロセス間にしかない

```rust
pub visibility_generation: u64,
```

`WalSharedMetadata` (プロセス内) にはこのフィールドがない。プロセス内なら、共有アトミックを更新した瞬間に全接続から見える。

プロセス間では mmap なのでそうはいかない。**「自分が最後に見た状態から変わったか」を安く判定する**ために、単調増加のカウンタが要る。

「メモリ共有ならタダで済むことが、mmap 共有では明示的なカウンタになる」という差が、フィールドの有無として現れている。

### `MAX_FRAME_INDEX_CAPACITY` が実質的な WAL 長の上限になる

262,144 フレーム。4 KiB ページなら約 1 GiB の WAL だ。

**これを超えると何が起きるか**は、この定数からは読み取れない。索引に載らないフレームは、プロセスローカルのフォールバック (`frame_cache` と `overflow_fallback_coverage`) で解決することになる ([状態の地図のページ](../shared-state-map/))。

```rust title="core/storage/wal.rs:2841-2844 (抜粋)"
/// Tracks how far the process-local `frame_cache` is known to be complete
/// for overflow fallback in the current WAL generation.
pub overflow_fallback_coverage: Arc<SpinLock<OverflowFallbackCoverage>>,
```

**共有索引が溢れたときのために、プロセスローカルの索引が「どこまで完全か」を追跡している。** 溢れた分は各プロセスが自分で WAL を走査して補う。

固定サイズの共有領域を選んだ以上、この種のフォールバックは避けられない。`.db-shm` を使う SQLite も同じ制約を持つ。

### `Exclusive` で開いた後に他プロセスが来ても再判定しない

開くときに 1 回プローブして `Exclusive` か `MultiProcess` かを決め、以後変えない。

**後から別プロセスが参加してきても、こちらは `Exclusive` のままだ。** 実害がないのは、`Exclusive` の権限 (初期化・修復) を使うのが開いた直後だけだからだ。

だが「今マルチプロセスか」を知りたい場面では、この値を使ってはいけない。**フィールド名が状態ではなく履歴を表している**ので、読むときに注意がいる。`open_mode` という名前が付いているのはそのためだろう。

### ロック粒度が「1 バイト 1 ロック」

オフセット 0、1、2、3、4… と 1 バイトずつ使う。中身は読み書きしない。

```rust title="core/storage/shared_wal_coordination.rs:50-57 (抜粋)"
/// Byte 0: lifetime lock used only to detect whether another process is present.
const PROCESS_LIFETIME_LOCK_OFFSET: u64 = 0;
/// Byte 1: single-writer ownership byte.
const WRITER_LOCK_OFFSET: u64 = 1;
/// Byte 2: single-checkpointer ownership byte.
const CHECKPOINT_LOCK_OFFSET: u64 = 2;
/// Byte range starting at 3: one reader-byte lock per shared reader slot.
const READER_LOCK_START_OFFSET: u64 = 3;
```

これは SQLite が `.db-shm` でやっているのと同じ手法だ。**`fcntl` のバイト範囲ロックは、その範囲の中身と無関係に働く**ので、「ロックだけのためのバイト」を並べられる。

[WAL のページ](../wal/) が引用している SQLite のコメント — 「The aLock[] field is a set of bytes used for locking. These bytes should never be read or written.」— がそのまま当てはまる。

そしてこのバイト列は、mmap したヘッダ領域と**同じファイルの中に同居している**。読み書きする領域とロックする領域が同じファイルにあるので、`fsync` の対象や mmap の範囲を分けて考える必要が出てくる。共有メモリを別ファイルにする設計もありえたはずで、1 ファイルに寄せた分だけレイアウト定数が細かくなっている。
