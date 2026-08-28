---
title: "WAL の read mark とチェックポイントを、redo ログと purge の言葉で読む"
description: "SQLite の WAL は InnoDB の redo ログと目的は同じだが、書くものが違う。差分ではなくページ全体を書き、読み手は本体ファイルではなく WAL を先に引く。スナップショットは「何番目のフレームまで見てよいか」を 5 つのスロットに掲示することで表現され、そのスロットは読み手の数と最大フレーム番号を 1 個の 64 ビットアトミックに詰め込んだロックになっている。チェックポイントは 4 モードあり、どこまで読み手を待つかだけが違う。"
group: "トランザクションと並行性"
sidebar:
  order: 33
---

## 何を学んだか

MySQL の redo ログと SQLite の WAL は、どちらも「本体を書き換える前にログへ書く」という同じ考え方に立つ。だが中身がかなり違う。

|                  | InnoDB redo ログ                       | SQLite / Turso の WAL             |
| ---------------- | -------------------------------------- | --------------------------------- |
| 書くもの         | 変更の記述 (物理論理ログ)              | **ページ全体のコピー**            |
| ログのサイズ     | 変更量に比例                           | **触ったページ数 × ページサイズ** |
| 読み手が見る場所 | バッファプール (常に最新)              | **WAL を先に引き、なければ本体**  |
| スナップショット | read view (トランザクション ID の集合) | **フレーム番号 1 個**             |
| クラッシュ後     | redo を適用して前進                    | **WAL の有効な範囲までを読む**    |
| 書き手の数       | 複数                                   | **1 人**                          |

一番効くのは 2 行目と 3 行目だ。**WAL はページ丸ごとを追記するので、読み手は「このページの最新版は WAL の何番目のフレームか」を引けなければならない。** そのための索引が要る。

そして 4 行目。**スナップショットが「フレーム番号 1 個」で表せる**のは、WAL が単一の追記列だからだ。「N 番目までを見る」と決めれば、それが一貫したスナップショットになる。InnoDB のようにアクティブなトランザクションの集合を持つ必要がない。

## ソースコードのどこか

### フレームの形

```rust title="core/storage/sqlite3_ondisk.rs"
pub struct WalFrameHeader {
    /// Page number
    pub(crate) page_number: u32,

    /// For commit records, the size of the database file in pages after the commit.
    /// For all other records, zero.
    pub(crate) db_size: u32,

    /// Salt-1 copied from the WAL header
    pub(crate) salt_1: u32,
    /// Salt-2 copied from the WAL header
    pub(crate) salt_2: u32,

    /// Checksum-1: Cumulative checksum up through and including this page
    pub(crate) checksum_1: u32,
    /// Checksum-2: Second half of the cumulative checksum
    pub(crate) checksum_2: u32,
}

impl WalFrameHeader {
    pub fn is_commit_frame(&self) -> bool {
        self.db_size > 0
    }
}
```

[`core/storage/sqlite3_ondisk.rs#L485-L510`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/sqlite3_ondisk.rs#L485-L510)。

**コミットレコードという専用のフレームは存在しない。** 「そのトランザクションで最後に書いたフレーム」の `db_size` に、コミット後のページ数を書く。それが 0 でなければコミット境界になる。

追加のレコードを書かずに境界を表せるので、**コミットのために追加の I/O が要らない**。24 バイトのヘッダの中の 1 フィールドで済む。

### チェックサムは累積する

```rust title="core/storage/sqlite3_ondisk.rs"
/// The checksum algorithm is as follows:
///
/// s0 = s1 = 0
/// for i from 0 to n-1 step 2:
///    s0 += x(i) + s1;
///    s1 += x(i+1) + s0;
/// endfor
```

```rust title="core/storage/sqlite3_ondisk.rs"
pub fn checksum_wal(
    buf: &[u8],
    _wal_header: &WalHeader,
    input: (u32, u32),
    native_endian: bool, // Sqlite interprets big endian as "native"
) -> (u32, u32) {
```

[`core/storage/sqlite3_ondisk.rs#L2201-L2241`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/sqlite3_ondisk.rs#L2201-L2241)。

**前のフレームのチェックサムが、次のフレームの入力になる。** だから 1 フレームだけを差し替えても検証を通らない。

これが効くのは復旧時だ。クラッシュで途中まで書かれた WAL を読むとき、**「どこまでが有効か」がチェックサムの連鎖で決まる**。途中のフレームが壊れていれば、そこから先は全部無効になる。

`native_endian` の扱いも SQLite 由来だ。**「SQLite はビッグエンディアンを native と解釈する」** とコメントにある。互換のためにその癖ごと再現している。

### スナップショットは 5 つのスロットに掲示する

読み手は「自分は N 番目のフレームまでを見る」を宣言する。それを掲示する場所が読み取りロックだ。

```rust title="core/storage/wal.rs"
    /// Read locks advertise the maximum WAL frame a reader may access.
    /// Slot 0 is special, when it is held (shared) the reader bypasses the WAL and uses the main DB file.
    /// When checkpointing, we must acquire the exclusive read lock 0 to ensure that no readers read
    /// from a partially checkpointed db file.
    /// Slots 1‑4 carry a frame‑number in value and may be shared by many readers. Slot 1 is the
    /// default read lock and is to contain the max_frame in WAL.
    pub read_locks: [TursoRwLock; 5],
```

[`core/storage/wal.rs#L2822-L2828`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/wal.rs#L2822-L2828)。

**スロットは 5 つしかない。** つまり、同時に存在できる「異なるスナップショット」は最大 4 種類になる (スロット 0 は特別)。

読み手が増えても構わない。**同じフレーム番号を見る読み手は、同じスロットを共有する。**

スロット 0 が「WAL を見ない読み手」を表すのが巧い。WAL の内容が全部本体に書き戻されていれば、WAL を引く必要がない。そしてチェックポイントは **スロット 0 を排他で取る**ことで、「本体ファイルを直接読んでいる人がいない」を保証する。

### ロックと値を、1 個のアトミックに詰める

````rust title="core/storage/wal.rs"
/// A 64-bit read-write lock with embedded 32-bit value storage.
/// Using a single Atomic allows the reader count and lock state are updated
/// atomically together while sitting in a single cpu cache line.
///
/// # Memory Layout:
/// ```ignore
/// [63:32] Value bits    - 32 bits for stored value
/// [31:1]  Reader count  - 31 bits for reader count
/// [0]     Writer bit    - 1 bit indicating exclusive write lock
/// ```
///
/// # Synchronization Guarantees:
/// - Acquire semantics on lock acquisition ensure visibility of all writes
///   made by the previous lock holder
/// - Release semantics on unlock ensure all writes made while holding the
///   lock are visible to the next acquirer
/// - The embedded value can be atomically read without holding any lock
pub struct TursoRwLock(AtomicU64);
````

[`core/storage/wal.rs#L260-L279`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/wal.rs#L260-L279)。

**「読み手の数」と「そのスロットが表すフレーム番号」を、同じ 64 ビットに入れている。**

最後の一文が設計の要になる。**「埋め込まれた値は、ロックを取らずにアトミックに読める」。**

チェックポイントは「今どのフレームまでなら書き戻していいか」を知るために、全スロットの値を読む必要がある。値がロックの外にあると、読むためにロックを取ることになり、読み手を止めてしまう。**同じワードに入れておけば、1 回のロードで済む。**

読み取りロックの取得も、ブロックしない。

```rust title="core/storage/wal.rs"
    /// Try to acquire a shared read lock.
    pub fn read(&self) -> bool {
        let mut count = 0;
        // Bounded loop to avoid infinite loops
        // Retry on Reader contention (should hopefully be spurious)
        while count < 1_000_000 {
            let cur = self.0.load(Ordering::Acquire);
            // If a writer is present we cannot proceed.
            if Self::has_writer(cur) {
                return false;
            }
```

[`core/storage/wal.rs#L316-L340`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/wal.rs#L316-L340)。

**待たずに `false` を返す。** [協調的な実行モデル](../io-result/) では、スレッドを寝かせるわけにいかない。取れなければ `Busy` を返して呼び出し元に判断させる。

再試行回数に上限があるのも同じ理由だ。CAS が競合し続けたときに、そのスレッドが永久に帰ってこないことがない。

### スロットの選び方

```rust title="core/storage/wal.rs"
        if snapshot.max_frame == snapshot.nbackfills {
            if !read_locks[0].read() {
                return None;
            }
            ...
            return Some(ReadGuardKind::DbFile);
        }

        let mut best_idx: i64 = -1;
        let mut best_mark: u32 = 0;
        for (idx, lock) in read_locks.iter().enumerate().take(5).skip(1) {
            let mark = lock.get_value();
            if mark != READMARK_NOT_USED && mark <= snapshot.max_frame as u32 && mark > best_mark {
                best_mark = mark;
                best_idx = idx as i64;
            }
        }
```

[`core/storage/wal.rs#L2026-L2052`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/wal.rs#L2026-L2052)。

手順はこうなる。

1. **全部書き戻し済みなら、スロット 0** を取って本体ファイルだけを読む
2. そうでなければ、**「自分の見たい範囲を超えない中で、最大のマークを持つスロット」** を探す
3. ぴったりのものがなければ、空いているスロットを排他で取って自分の値を書く
4. 取れなかったら `None` (呼び出し元は `Busy`)

2 番目が肝で、**自分が見たいフレーム番号より小さいマークでも構わない**。少し古いスナップショットを見ることになるが、一貫性はある。**スロットが 4 つしかない制約と引き換えに、少しの鮮度を諦めている。**

そして取った後にもう一度確かめる。

```rust title="core/storage/wal.rs"
        let current_slot_mark = read_locks[best_idx as usize].get_value();
        if current_slot_mark != best_mark || self.load_snapshot() != snapshot {
            read_locks[best_idx as usize].unlock();
            return None;
        }
```

[`core/storage/wal.rs#L2072-L2077`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/wal.rs#L2072-L2077)。

**値を見て選ぶ → ロックを取る → もう一度値を見る。** 選んでからロックを取るまでの間に、そのスロットが別の値に書き換わっている可能性がある。ロックを取った後に確かめ直して、違っていたら手を引く。

`self.load_snapshot() != snapshot` も同じで、**WAL 全体の状態がその間に進んでいたら、やり直す**。値の掲示板を使う設計では、この「取ってから確かめ直す」が必ずセットになる。

### ページ → フレームの索引

```rust title="core/storage/wal.rs"
    // Frame cache maps a Page to all the frames it has stored in WAL in ascending order.
    // This is to easily find the frame it must checkpoint each connection if a checkpoint is
    // necessary.
    // One difference between SQLite and limbo is that we will never support multi process, meaning
    // we don't need WAL's index file. So we can do stuff like this without shared memory.
    // TODO: this will need refactoring because this is incredible memory inefficient.
    pub frame_cache: Arc<SpinLock<FxHashMap<u64, Vec<u64>>>>,
```

[`core/storage/wal.rs#L2810-L2816`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/wal.rs#L2810-L2816)。

SQLite はこれを `-shm` ファイル (共有メモリ) に置く。**プロセスをまたいで共有する必要があるからだ。**

Turso は「マルチプロセスは絶対にサポートしない」と決めて、ただの `HashMap` にした。**その方が速いし、単純だ。**

このコメントは今は正しくない。**マルチプロセス対応は実装された** ([次のページ](../shared-wal-tshm/))。それでも、ここで見るべきは「前提を明示して、それに賭けた」ことの方だ。賭けた前提が変わったとき、どこを直せばいいかが分かる。

「メモリ効率が非常に悪いのでリファクタリングが要る」という TODO も付いている。**ページ 1 つにつき `Vec<u64>` を持つ。** WAL に同じページが 100 回現れれば、要素 100 個の `Vec` になる。

### チェックポイントは 4 モード

```rust title="core/storage/wal.rs"
pub enum CheckpointMode {
    /// Checkpoint as many frames as possible without waiting for any database readers or writers to finish, then sync the database file if all frames in the log were checkpointed.
    /// Passive never blocks readers or writers, only ensures (like all modes do) that there are no other checkpointers.
    Passive { upper_bound_inclusive: Option<u64> },
    /// This mode blocks until there is no database writer and all readers are reading from the most recent database snapshot. ...
    Full,
    /// This mode works the same way as `Full` with the addition that after checkpointing the log file it blocks ... until all readers are reading from the database file only. ...
    Restart,
    /// This mode works the same way as `Restart` with the addition that it also truncates the log file to zero bytes just prior to a successful return.
    Truncate { upper_bound_inclusive: Option<u64> },
}
```

[`core/storage/wal.rs#L159-L174`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/wal.rs#L159-L174)。

**4 つのモードの違いは、「どこまで読み手を待つか」だけ。** 段階が積み上がっている。

- `Passive` — 誰も待たない。書き戻せるところまで書き戻す
- `Full` — 書き手がいなくなり、読み手が全員最新を見るまで待つ
- `Restart` — さらに、読み手が全員 WAL を見なくなるまで待つ
- `Truncate` — さらに、WAL ファイルを 0 バイトに切り詰める

「他のチェックポインタがいないこと」だけは全モード共通で保証する。**チェックポイントは常に 1 人だけ**になる。

そして、どのモードでも共通のルールがある。**「まだ読んでいる人がいるフレームは書き戻さない」。** 書き戻した後に WAL を切り詰めると、そのフレームを見ていた読み手のスナップショットが消える。

これは InnoDB の purge が「まだ古いバージョンを見ているトランザクションがある間は、undo を消せない」のと同じ制約だ。**表現が「トランザクション ID の最小値」か「読み取りマークの最小値」かの違いしかない。**

## なぜそうなっているか

- **ページ全体を書くのは、SQLite のファイル形式に差分ログの概念がないから。** 差分を書くには「ページのどこが変わったか」を表す形式が要る。ページ全体なら、既存のページ形式をそのまま流用できる。
- **スナップショットがフレーム番号 1 個で済むのは、WAL が単一の追記列だから。** 書き手が 1 人だと、変更に全順序が付く。「N 番目まで」が一貫した状態になることが保証される。
- **読み取りマークが 5 つしかないのは、共有メモリの固定領域に置くから。** SQLite の `-shm` フォーマットで決まっている数で、これも互換の制約になっている。
- **少し古いマークで妥協するのは、スロットが足りないから。** 全読み手に専用スロットを与えられない以上、「近いものを共有する」しかない。一貫性は保たれるので、失うのは鮮度だけだ。
- **ロックと値を同じアトミックに入れたのは、値をロックなしで読みたいから。** チェックポイントは全スロットの値を読む。そのたびにロックを取ると、読み手を止めることになる。
- **ロック取得がブロックしないのは、協調的な実行モデルだから。** スレッドを寝かせられない以上、「取れなかった」を戻り値で返すしかない。
- **取ってから確かめ直すのは、掲示板方式の必然。** 「値を見て決める」と「決めた対象を確保する」の間には必ず隙間がある。確保した後に再確認する以外にない。
- **チェックサムを累積にしたのは、「どこまで有効か」を決めるため。** フレームごとに独立したチェックサムだと、途中の欠落を検出できない。
- **チェックポイントのモードが 4 段なのは、待つコストと得られるものが違うから。** 普段は誰も待たせず少しずつ書き戻し、WAL を本当に小さくしたいときだけ待つ。

## どう活かすか

- **スナップショットを 1 個の単調増加する数で表せないか考える。** 変更に全順序が付くなら、「N まで見る」で一貫性が表せる。アクティブな集合を持つより、比較にならないほど安い。
- **共有する状態が少ない数のスロットに収まるなら、掲示板方式にする。** 全参加者に専用の枠を配らず、「近い値の人は同じ枠を共有する」で済ませられることは多い。
- **掲示板から選ぶときは、「取ってから確かめ直す」を必ず入れる。** 見た瞬間の値と、確保した後の値は違いうる。
- **ロックと、そのロックが保護する小さな値は、同じアトミックに入れる。** 値をロックなしで読めるようになると、監視側が対象を止めずに済む。
- **協調的な実行モデルでは、ロックの取得を待たせない。** 取れなかったことを戻り値で返し、判断を呼び出し元に渡す。再試行回数にも上限を置く。
- **ログのチェックサムは累積にする。** 「このレコードが壊れている」ではなく「ここから先が信用できない」を表せる。復旧の停止位置がそのまま決まる。
- **境界を表すのに、専用のレコードを増やさない。** 既存のヘッダのフィールドで表せるなら、追加の書き込みが要らなくなる。
- **前提に賭けるなら、賭けたことをコメントに書く。** 「マルチプロセスは絶対にやらないので共有メモリは要らない」と書いてあれば、前提が変わったときに直す場所が分かる。実際、この前提は後に覆った。
- **待ち方の違いを、モードとして分ける。** 「全部やる」と「できるところまでやる」を 1 つの関数にまとめると、呼び出し側が待ち時間を制御できなくなる。
