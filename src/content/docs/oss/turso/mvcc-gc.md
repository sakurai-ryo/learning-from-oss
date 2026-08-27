---
title: "2 つの水位で古いバージョンを回収する"
description: "行バージョンはメモリに溜まる一方なので、回収が要る。判断材料は 2 つの水位だけだ。最も古い読み手がどこを見ているか (LWM) と、どこまで B-tree に書き戻したか (ckpt_max)。この 2 つで 4 つの規則が決まる。面白いのは、規則 3 を Passive チェックポイントで有効にできない理由が、再現するテスト名つきでドキュメントに書き残されていることだ。"
group: "トランザクションと並行性"
sidebar:
  order: 15
---

## 何を学んだか

[前のページ](../mvcc/) の MVCC には、明らかな問題がある。**行バージョンがメモリに溜まり続ける。**

```text title="docs/internals/mvcc/GC.md"
The MVCC store keeps every row version in memory: inserts, updates, deletes,
and rolled-back garbage. Without GC, memory grows monotonically with write
volume. GC reclaims versions that no active reader can see and that are
redundant with the B-tree.
```

[`docs/internals/mvcc/GC.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/internals/mvcc/GC.md)。

回収の条件が 2 つある。**誰にも見えなくなったこと**と、**B-tree に同じデータがあること**。この 2 つに対応して、2 つの水位が定義されている。

```text title="docs/internals/mvcc/GC.md"
- **LWM (low-water mark)**: `min(tx.begin_ts)` across Active/Preparing
  transactions, or `u64::MAX` if none. Tells GC which versions are still
  visible to some reader.
- **ckpt_max** (`durable_txid_max`): the highest committed timestamp
  whose data has been written to the B-tree. Tells GC when B-tree fallthrough
  is safe.
```

MySQL でいえば、**LWM が purge の「最古の read view」、ckpt_max が「ダーティページのフラッシュ位置」** にあたる。InnoDB でも「まだ見ている人がいる undo は消せない」と「まだ書き戻していないページは再利用できない」の 2 つが独立に効く。

構造が同じなのは偶然ではない。**MVCC + 遅延書き戻しという組み合わせを取ると、必ずこの 2 つの水位が要る。**

## ソースコードのどこか

### 水位の計算は 10 行

```rust title="core/mvcc/database/mod.rs"
    /// Compute the low-water mark: the minimum begin_ts of all active or
    /// preparing transactions. Returns u64::MAX if no transactions are active.
    /// Used by GC to determine which row versions are safe to reclaim.
    pub fn compute_lwm(&self) -> u64 {
        self.txs
            .iter()
            .filter_map(|entry| {
                let tx = entry.value();
                match tx.state.load() {
                    TransactionState::Active | TransactionState::Preparing(_) => Some(tx.begin_ts),
                    _ => None,
                }
            })
            .min()
            .unwrap_or(u64::MAX)
    }
```

[`core/mvcc/database/mod.rs#L7159-L7174`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L7159-L7174)。

**誰もいなければ `u64::MAX`。** つまり「全部回収してよい」になる。

この既定値の選び方が効いている。`0` にすると「何も回収できない」で、アイドル時に一番回収したいのに一番回収しなくなる。**「制約する人がいない = 制約なし」を、値域の端で表している。**

### 規則は 4 つで、1 つの関数にまとまっている

```text title="docs/internals/mvcc/GC.md"
All GC logic lives in a single function, `gc_version_chain`, shared by both
checkpoint-time and background GC. The four rules are applied in order:

1. **Aborted garbage** (`begin=None, end=None`) — remove unconditionally.
2. **Superseded versions** (`end=Timestamp(e), e ≤ lwm`) — remove, unless
   doing so would let the dual cursor surface a stale B-tree row (tombstone
   guard).
3. **Sole-survivor current version** (`end=None, b ≤ ckpt_max, b < lwm`,
   chain length = 1) — remove, because the B-tree has the same data.
4. **TxID references** (`begin=TxID` or `end=TxID`) — keep, the owning
   transaction hasn't resolved yet.
```

**「すべての GC ロジックが 1 つの関数にある」** と明記されている。チェックポイント時の GC も、背景 GC も、同じ関数を呼ぶ。

回収の判断は間違えるとデータが壊れる。**それが 2 箇所にあると、片方だけ直すという事故が必ず起きる。**

そして、同じ関数がブロッキングと非ブロッキングの両方で動く。

```text title="docs/internals/mvcc/GC.md"
The same code works under both blocking checkpoint (`lwm = u64::MAX`, all
versions reclaimable) and a future non-blocking checkpoint (`lwm` finite,
pinned by the oldest reader).
```

**ブロッキングチェックポイントは「読み手が 1 人もいない状態」なので、LWM が自動的に `u64::MAX` になる。** 特別扱いが要らない。パラメータの値が変わるだけで、同じコードが両方に対応する。

### 壊れ方が 2 通り書いてある

MVCC ストアと B-tree は、読み手からは 1 つに見える必要がある。そのための「二重カーソル」に不変条件がある。

```text title="docs/internals/mvcc/GC.md"
> If a row exists in the B-tree, either the SkipMap correctly represents the
> row's current state for all active readers, **or** the SkipMap has no entry
> / is ignored as non-write-buffer (B-tree fallthrough, only safe when B-tree
> data is up to date for that reader).

Two hazards follow from this:

- **Removing a tombstone before its deletion is checkpointed** resurrects a
  deleted row — the dual cursor falls through to the stale B-tree row.
- **Removing the current version while leaving superseded versions** causes
  data loss — the superseded version's `end` timestamp still invalidates the
  B-tree row, but there's no MVCC version to serve reads.
```

**「削除の墓標を早く消すと、削除した行が生き返る」「現在版だけ消すと、行が消える」。**

不変条件を書いて、それを破ったときに何が起きるかを 2 つとも書いている。**規則 2 と規則 3 の但し書きが、それぞれこの 2 つの防御になっている。**

抽象的な不変条件は、破ったときの症状とセットで書かれていないと守れない。「行が生き返る」と言われれば、なぜガードが要るのかが一目で分かる。

### 回復時の 0 を、フラグとして使う

```text title="docs/internals/mvcc/GC.md"
Log recovery stamps versions with `LOGICAL_LOG_RECOVERY_COMMIT_TIMESTAMP = 0`.
Since `durable_txid_max` is advanced via `NonZeroU64`, it stays at 0
until the first real transaction is checkpointed. This means `ckpt_max == 0`
acts as a natural "recovery data not yet checkpointed" flag
```

論理ログから復旧した行バージョンには、タイムスタンプ 0 が付く。そして `ckpt_max` は `NonZeroU64` で進むので、**最初の本物のチェックポイントが走るまでは 0 のまま**になる。

**`b == 0 && ckpt_max == 0` が、そのまま「復旧データがまだ B-tree に書かれていない」を意味する。** 専用のフラグが要らない。

```text title="docs/internals/mvcc/GC.md"
The recovery transaction itself is removed from `txs` at the end of
`commit_load_tx` to prevent pinning LWM to 0 (which would disable Rules 2-3).
```

**復旧用の擬似トランザクションを消しておかないと、LWM が 0 に固定されて GC が全く動かなくなる。** 「特別なトランザクション」を作ると、それが水位計算に混ざる。後始末が要る。

### 有効にできない規則の理由が、再現つきで残っている

`GC.md` で最も価値があるのは、この節だ。

```text title="docs/internals/mvcc/GC.md"
### Why Rule 3 cannot simply be turned on for Passive

This was investigated directly: forcing `drop_current_if_in_btree = true` on
Passive Finalize (keeping the empty-slot unlink) reproduces real corruption —
`test_conflict_abort_ckpt_indexed_update_savepoint_integrity_check_passive`
("row missing from index") and `test_passive_concurrent_transfer_preserves_sum_and_count`
("total balance changed") both fail.
```

**「試した。壊れた。落ちるテストの名前はこれ。」**

さらに、原因の切り分けまで書いてある。

```text title="docs/internals/mvcc/GC.md"
The cause is **not** table/index publish skew; it reproduces with one table and
no index at all (`passive_reader_snapshot_survives_later_write_after_row_versions_gc`).
Once Rule 3 empties a chain's SkipMap slot, the slot is unlinked entirely. A later,
unrelated write to that same row inserts a *new* chain with only its own
(future, invisible) version — a reader whose snapshot predates that write now
finds "no visible SkipMap version" and falls through to the physical B-tree,
which the later Passive auto-checkpoint has already overwritten: a
snapshot-isolation violation.
```

**「表と索引の公開のずれではない。表 1 個・索引なしでも再現する」。** 最初に疑われる原因を先に否定している。

そして、なぜ Truncate では大丈夫なのかも。

```text title="docs/internals/mvcc/GC.md"
Passive has no equivalent of Truncate's `blocking_checkpoint_lock`, which
excludes all MVCC transactions for the duration of the write phase, so it
cannot inherit that guarantee. Making Rule 3 safe for Passive needs either
real page-level MVCC (so B-tree fallthrough is isolated per reader) or
serializing Passive's physical writes against readers for rows whose chain is
currently empty — both bigger than a GC-only change.
```

**修正案が 2 つ書かれていて、どちらも「GC の変更で済む範囲を超える」と評価されている。**

この節が持っている情報を数えてみる。

1. 試した設定 (`drop_current_if_in_btree = true` on Passive Finalize)
2. 結果 (2 つのテストが落ちる。テスト名つき)
3. 疑われがちな原因の否定 (表と索引のずれではない)
4. 最小の再現 (表 1 個、索引なし)
5. 本当の原因 (スロットが消える → 後の書き込みで新しい鎖ができる → 古い読み手が B-tree に落ちる)
6. 他の経路が安全な理由 (Truncate はブロッキングロックを持つ)
7. 直すために必要なもの (ページ単位 MVCC、または書き込みの直列化)
8. 見積もり (どちらも GC だけの変更では収まらない)

**「なぜこれをやっていないのか」に、これだけの情報が要る。** これがないと、次に来た人が同じ実験を最初からやり直す。しかも壊れ方が「たまにデータが消える」なので、実験の途中で気付かない可能性がある。

### 回収は少しずつ、上限つきで

```rust title="core/mvcc/database/mod.rs"
    /// Default `mvcc_gc_threshold`: run an incremental GC pass roughly every
    /// this many newly inserted versions. Small enough that steady-state
    /// memory stays bounded under heavy short-txn concurrency, large enough
    /// that small workloads (and most unit tests) never trigger a pass.
    pub const DEFAULT_GC_VERSION_THRESHOLD: i64 = 16 * 1024;

    /// Upper bound on table-row chains scanned by one inline `gc_incremental`
    /// pass on the commit path. Keeps a pass cheap (sub-millisecond) so it
    /// doesn't noticeably slow the committing connection; steady state relies
    /// on frequent passes resuming via `gc_table_cursor`.
    pub const MAX_CHAINS_PER_GC: usize = 4096;
```

[`core/mvcc/database/mod.rs#L7176-L7186`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L7176-L7186)。

**両方の定数に、上下の理由が書いてある。**

- 閾値 16K — 小さすぎるとメモリが増える。大きすぎると小さいワークロードで一度も走らない
- 1 回の上限 4096 鎖 — 1 回のパスを 1 ミリ秒未満に抑え、コミット中の接続を目立って遅くしない

**「大きくする理由」と「小さくする理由」が両方書いてあると、値を動かすときの判断ができる。** 片方しか書いていない定数は、どちらに動かしていいか分からない。

そして GC は **専用スレッドではなく、コミットする接続が少しずつやる**。[サーバがない](../architecture/) 以上、背景スレッドを勝手に作れない。「毎回少しだけ進めて、途中から再開する」という形になる。

再開のために `gc_table_cursor` を持っているのも同じ理由だ。**4096 鎖で打ち切ったら、次のパスはその続きから始める。**

### 参照が消えたら、最終状態も消す

```rust title="core/mvcc/database/mod.rs"
    fn collect_referenced_txids(versions: &[RowVersion], referenced_tx_ids: &mut HashSet<TxID>) {
        for version in versions {
            if let Some(TxTimestampOrID::TxID(tx_id)) = version.begin() {
                referenced_tx_ids.insert(tx_id);
            }
            if let Some(TxTimestampOrID::TxID(tx_id)) = version.end() {
                referenced_tx_ids.insert(tx_id);
            }
        }
    }
```

[`core/mvcc/database/mod.rs#L7687-L7696`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/database/mod.rs#L7687-L7696)。

[前のページ](../mvcc/) で見た `finalized_tx_states` は、終わったトランザクションの最終状態を保持している。**これも放っておけば溜まる。**

GC のついでに参照されている ID を集めて、**どこからも参照されていない最終状態を消す**。行バージョンの GC と同じパスの中でやるので、余分な走査が要らない。

**参照カウントを持たずに、「今生きている参照を全部集めてから、それ以外を消す」。** 世代別ではないマーク&スイープと同じ考え方になる。

## なぜそうなっているか

- **水位が 2 つ要るのは、「見えなくなった」と「B-tree に書いた」が独立だから。** 誰も見ていなくても、B-tree にまだ書いていなければ消せない。書いていても、見ている人がいれば消せない。
- **LWM の既定値を `u64::MAX` にしたのは、アイドル時に最大限回収したいから。** 「制約する人がいない」を「制約なし」として表すには、この向きにするしかない。
- **GC を 1 つの関数に集めたのは、間違えるとデータが壊れるから。** 呼び出し元ごとに規則を書くと、片方だけ直す事故が必ず起きる。
- **ブロッキングと非ブロッキングを同じコードで扱えるのは、違いが LWM の値だけだから。** 「読み手がいない」は「LWM が無限大」の特殊ケースにすぎない。特別扱いを作らずに済む。
- **不変条件を破ったときの症状を書いたのは、抽象的な条件は守られないから。** 「行が生き返る」「行が消える」と書いてあれば、ガードを消そうとした人が手を止める。
- **回復時のタイムスタンプ 0 をフラグとして使ったのは、専用フラグを増やしたくないから。** `NonZeroU64` で進む値が 0 のままであることが、そのまま「まだ何も起きていない」を意味する。
- **回収を打ち切り可能にしたのは、GC 専用のスレッドがないから。** コミットする接続がついでにやる以上、1 回のパスを短くして途中から再開できなければならない。
- **定数に上下両方の理由を書いたのは、どちらに動かすかの判断材料が要るから。** 「16K」だけでは、増やすべきか減らすべきかが分からない。
- **試して駄目だった案を書き残したのは、次の人が同じ実験を繰り返すから。** しかもこの実験は、失敗が「たまにデータが消える」という形で出る。気付かずに入れてしまう危険がある。

## どう活かすか

- **回収の判断に必要な条件が複数あるなら、それぞれを水位として独立に持つ。** 「誰が見ているか」と「どこまで永続化したか」を 1 つの数にまとめようとすると、片方の都合でもう片方が動く。
- **「制約する人がいない」は、値域の端で表す。** 空集合の最小値を「制約なし」にすると、特別扱いの分岐が消える。
- **回収の規則は 1 箇所に集める。** 呼び出し元ごとに条件を書くと、規則が増えたときに全箇所を直すことになる。
- **同じコードで複数のモードを扱えるように、違いをパラメータの値に落とす。** 「ブロッキングなら全部回収」を分岐で書くと、片方の経路が実質テストされなくなる。
- **不変条件は、破ったときの症状とセットで書く。** 「これを守れ」だけでは守られない。「守らないとデータが生き返る」と書く。
- **専用の初期化用トランザクションを作ったら、水位計算から外す後始末を忘れない。** 「特別扱いのオブジェクト」は、一般の集計に混ざると全体を止める。
- **背景処理を持てない環境では、通常の処理が少しずつ肩代わりする。** 1 回の上限と、途中から再開するためのカーソルを持つ。
- **定数には、上げる理由と下げる理由を両方書く。** 片方しかないと、後から動かせない。
- **試して駄目だった案は、再現手順つきでドキュメントに残す。** 「なぜやっていないか」は、コードのどこにも書かれない。試した設定、落ちたテストの名前、疑われがちな原因の否定、最小再現、本当の原因、必要な修正の規模。ここまで書いて初めて、次の人が同じ穴に落ちない。
