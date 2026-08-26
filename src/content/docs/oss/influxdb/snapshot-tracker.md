---
title: "「いつ永続化するか」を壁時計ではなく、貯まったログ区間の並びだけで決める"
description: "InfluxDB 3 の SnapshotTracker は、WAL ファイル 1 個を「ファイル番号 + データ時刻の min/max」の 3 つ組 (WalPeriod) に還元し、その並びだけを見て永続化の範囲を決める。判断に壁時計を使わないので、未来や過去の時刻を持つデータが来ても壊れない。ただし未来時刻のデータで WAL が溜まり続ける穴があり、そこは「期間数が 3 倍になったら全部出す」という安全弁で塞いでいる。メモリ圧による強制スナップショットは、空バッファでも no-op を書いて区間を作る。"
sidebar:
  order: 3
---

## 何を学んだか

### どんな状況の話か

[WAL のページ](../wal-object-store/) で見たように、書き込みは 1 秒ごとに 1 個の WAL ファイルになる。これは durability のための形式で、クエリには向かない。ある時点で「メモリに貯まったデータを Parquet ファイルに書き出し、対応する WAL ファイルを消す」処理 (InfluxDB 3 では **スナップショット** と呼ぶ) が要る。

判断すべきことは 2 つある。**いつやるか** と、**どこまでを対象にするか**。

これが単純でないのは、時系列データベースだからだ。書き込まれるデータの時刻は、必ずしも「今」ではない。エッジデバイスがバッファしていた 3 時間前のデータがまとめて来ることもあれば、時計がずれた機器が 1 年先の時刻を送ってくることもある。永続化の単位 (gen1 チャンク: 既定 10 分) は **データの時刻** で区切られるので、「今から 10 分前までを書き出す」という壁時計ベースの判断は成立しない。

### InfluxDB 3 の答え

1. **WAL ファイル 1 個を 3 つ組に還元する。** `WalPeriod { wal_file_number, min_time, max_time }` だけを覚える。中身 (何行書かれたか、どのテーブルか) は捨てる。
2. **判断はこの並びだけで行う。** `SnapshotTracker` は `Vec<WalPeriod>` と設定値しか持たない。時計も、オブジェクトストアも、カタログも参照しない。結果として **純粋関数に近い判断ロジック** になり、テストは `WalPeriod` を並べるだけで書ける。
3. **区切りはデータ時刻で決める。** 最後の WAL 期間の `max_time` を gen1 の境界に切り下げた `t` を求め、`max_time < t` の期間だけを対象にする。この `t` が `end_time_marker` として永続化側に渡り、「これより前のチャンクを書き出せ」を意味する。
4. **貯め始めるしきい値は `snapshot_size * 1.5`。** 既定 600 なら 900 期間 = 15 分ぶん。gen1 チャンク (10 分) を埋めきる前に永続化して、細切れの Parquet を作らないため。
5. **未来時刻のデータで詰まる穴は安全弁で塞ぐ。** 1 年先の時刻のデータが 1 行来ると、以降のすべての期間の `max_time` がそれを含むので、`max_time < t` を満たす期間が無くなり永久にスナップショットできない。期間数が `3 * snapshot_size` に達したら、条件を無視して全部出す。
6. **メモリ圧は独立した経路で見る。** 10 秒ごとにクエリ可能バッファのバイト数をチェックし、しきい値 (既定: 使用可能メモリの 50%) を超えたら `force_flush_buffer` を呼ぶ。WAL バッファが空でも no-op オペレーションを 1 個書いて期間を作り、スナップショットを成立させる。
7. **同時実行は semaphore 1 本で完全に直列化する。** permit はスナップショット完了だけでなく、対応する WAL ファイルの削除が終わるまで保持する。

## ソースコードのどこか

### 覚えているのは 3 つ組だけ

[`influxdb3_wal/src/snapshot_tracker.rs#L13-L20`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/snapshot_tracker.rs#L13-L20) と [`#L198-L203`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/snapshot_tracker.rs#L198-L203)。

```rust title="influxdb3_wal/src/snapshot_tracker.rs"
pub(crate) struct SnapshotTracker {
    last_snapshot_sequence_number: SnapshotSequenceNumber,
    last_wal_sequence_number: WalFileSequenceNumber,
    wal_periods: Vec<WalPeriod>,
    snapshot_size: usize,
    gen1_duration: Gen1Duration,
}
```

```rust title="influxdb3_wal/src/snapshot_tracker.rs"
/// A struct that represents a period of time in the WAL. This is used to track the data timestamps
/// and sequence numbers for each period of the WAL (which will be a file in object store, if enabled).
pub(crate) struct WalPeriod {
    pub(crate) wal_file_number: WalFileSequenceNumber,
    pub(crate) min_time: Timestamp,
    pub(crate) max_time: Timestamp,
}
```

モジュールの冒頭コメントは、この型が WAL を使わない構成でも意味を持つと書いている。

```rust title="influxdb3_wal/src/snapshot_tracker.rs"
//! This module contains the code and logic for tracking how and when to snapshot the WAL. This
//! can be used to tell the `SnapshotHandler` what is set to persist. After that WAL files
//! can be deleted from object store. The tracker is useful even for setups without a WAL
//! configured as it can be used to ensure that data in the write buffer is persisted in blocks
//! that are not too large and unlikely to overlap.
```

"blocks that are not too large and unlikely to overlap" が、この判断ロジックが最適化している目的だ。Parquet ファイルは、大きすぎず、時間範囲が互いに重ならないほうが、後のクエリでプルーニングが効く。

### 追加は単調増加を assert する

[`#L43-L51`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/snapshot_tracker.rs#L43-L51)。

```rust title="influxdb3_wal/src/snapshot_tracker.rs"
    pub(crate) fn add_wal_period(&mut self, wal_period: WalPeriod) {
        if let Some(last_period) = self.wal_periods.last() {
            assert!(last_period.wal_file_number < wal_period.wal_file_number);
        }

        self.last_wal_sequence_number = wal_period.wal_file_number;
        self.wal_periods.push(wal_period);
    }
```

「WAL 番号は単調増加」という不変条件を `assert!` で守っている。この前提が崩れたら判断ロジック全体が意味を失うので、静かに間違った結果を出すより落ちるほうがよい、という判断。`WalPeriod::new` にも `assert!(min_time <= max_time)` がある。

### 判断の本体

[`#L60-L92`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/snapshot_tracker.rs#L60-L92)。

```rust title="influxdb3_wal/src/snapshot_tracker.rs"
    /// In the case of data coming in for future times, we will be unable to snapshot older data.
    /// Over time this will back up the WAL. To guard against this, if the number of WAL periods
    /// is >= 3x the snapshot size, snapshot everything up to the last period.
    pub(crate) fn snapshot(&mut self, force_snapshot: bool) -> Option<SnapshotDetails> {
        /* ... */
        if !self.should_run_snapshot(force_snapshot) {
            return None;
        }

        // if the number of wal periods is >= 3x the snapshot size, snapshot everything
        let wal_periods_3_times_snapshot_size = self.wal_periods.len() >= 3 * self.snapshot_size;
        if force_snapshot || wal_periods_3_times_snapshot_size {
            return self.snapshot_all();
        }
        /* ... */
        // uses the last wal period's time to leave behind "some" of the wal periods
        // for default config (gen1 duration is 10m / flush interval 1s), it leaves
        // behind 300 wal periods.
        self.snapshot_in_order_wal_periods()
    }
```

道が 3 本ある。**何もしない**、**全部出す** (`snapshot_all`)、**時刻で切れるところまで出す** (`snapshot_in_order_wal_periods`)。「未来の時刻のデータが来ると WAL が溜まる」という具体的な失敗モードが、対策のすぐ上にコメントで書かれている。

しきい値の意味も明示されている。[`#L168-L173`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/snapshot_tracker.rs#L168-L173)。

```rust title="influxdb3_wal/src/snapshot_tracker.rs"
    /// The number of wal periods we need to see before we attempt a snapshot. This is to ensure that we
    /// don't snapshot before we've buffered up enough data to fill a gen1 chunk.
    fn number_of_periods_to_snapshot_after(&self) -> usize {
        self.snapshot_size + self.snapshot_size / 2
    }
```

### 切り下げと `take_while`

[`#L112-L148`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/snapshot_tracker.rs#L112-L148)。

```rust title="influxdb3_wal/src/snapshot_tracker.rs"
    pub(crate) fn snapshot_in_order_wal_periods(&mut self) -> Option<SnapshotDetails> {
        let t = self.wal_periods.last()?.max_time;
        // round the last timestamp down to the gen1_duration
        let t = t - (t.get() % self.gen1_duration.as_nanos());

        // any wal period that has data before this time can be snapshot
        let periods_to_snapshot = self
            .wal_periods
            .iter()
            .take_while(|period| period.max_time < t)
            .cloned()
            .collect::<Vec<_>>();
```

基準時刻 `t` は「いま」ではなく **最後に受け取ったデータの時刻** を gen1 境界に切り下げたもの。だから時計がずれていても、データが遅れて来ても、判断は「データが実際に持っている時刻」に従う。

`take_while` であって `filter` ではないのが重要だ。条件を満たさない期間が 1 つ現れたら、そこで打ち切る。WAL ファイルの削除は連番の範囲指定 (`first_wal_sequence_number` 〜 `last_wal_sequence_number`) で行われるので、**対象は必ず先頭からの連続した区間** でなければならない。途中を飛ばして選べない。

結果は `SnapshotDetails` になる ([`influxdb3_wal/src/lib.rs#L542-L553`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/lib.rs#L542-L553))。

```rust title="influxdb3_wal/src/lib.rs"
pub struct SnapshotDetails {
    /// The sequence number for this snapshot
    pub snapshot_sequence_number: SnapshotSequenceNumber,
    /// All chunks with data before this time can be snapshot and persisted
    pub end_time_marker: i64,
    /// All wal files with a sequence number >= to this can be deleted once snapshotting is complete
    pub first_wal_sequence_number: WalFileSequenceNumber,
    /// All wal files with a sequence number <= to this can be deleted once snapshotting is complete
    pub last_wal_sequence_number: WalFileSequenceNumber,
    // both forced and 3 times snapshot size should set this flag
    pub forced: bool,
}
```

「データの時刻の境界」と「WAL ファイル番号の範囲」の 2 種類の座標が 1 つの構造体に入っている。前者はメモリバッファの何を書き出すか、後者はどのファイルを消してよいかを指す。この 2 つを 1 回の判断で同時に決めているのがこの設計の要点で、だからこそ「書き出したのに消せない」「消したのに書き出していない」が構造的に起きない。

`snapshot_all` (安全弁側) では境界の作り方が逆になる ([`#L150-L166`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/snapshot_tracker.rs#L150-L166))。

```rust title="influxdb3_wal/src/snapshot_tracker.rs"
        let max_time = wal_periods.iter().map(|period| period.max_time).max()?;
        let t = max_time - (max_time.get() % self.gen1_duration.as_nanos())
            + self.gen1_duration.as_nanos();
```

切り下げてから **gen1 の 1 単位を足す**。つまり「全データを含む境界」にして、バッファを空にする。

### メモリ圧という別経路

[`influxdb3_write/src/write_buffer/mod.rs#L846-L893`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/mod.rs#L846-L893)。

```rust title="influxdb3_write/src/write_buffer/mod.rs"
async fn check_mem_and_force_snapshot(
    write_buffer: &Arc<WriteBufferImpl>,
    memory_threshold_bytes: usize,
) {
    let current_buffer_size_bytes = write_buffer.buffer.get_total_size_bytes();
    /* ... */
    if current_buffer_size_bytes >= memory_threshold_bytes {
        warn!(
            current_buffer_size_bytes,
            memory_threshold_bytes, "forcing snapshot as buffer size > mem threshold"
        );

        let wal = Arc::clone(&write_buffer.wal);

        let cleanup_after_snapshot = wal.force_flush_buffer().await;
```

WAL のフラッシュループとは **別のタスク・別の間隔** (既定 10 秒) で回る。「時間で貯まったら出す」と「メモリが厳しいから出す」は違う関心事なので分けた、という形になっている。

強制側で困るのは、WAL バッファが空のときだ。判断ロジックは WAL 期間が無ければ何も返さないので、スナップショットが起きない。そこで空バッファなら no-op を 1 個入れる ([`influxdb3_wal/src/object_store.rs#L715-L731`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/object_store.rs#L715-L731))。

```rust title="influxdb3_wal/src/object_store.rs"
    /// There are 4 possible scenarios
    /// wal buffer | force_snapshot | outcome
    ///  empty     | true           | noop / snapshot**
    ///  empty     | false          | should not happen (guarded at call site)
    ///  not empty | true           | snapshot**
    ///  not empty | false          | may snapshot (depends on wal periods in tracker)
```

### 2 つのタイマーが噛み合うと空のスナップショットが生まれる

[`influxdb3_write/src/write_buffer/queryable_buffer.rs#L395-L435`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/queryable_buffer.rs#L395-L435) に、この設計で唯一長いコメントがある。

```rust title="influxdb3_write/src/write_buffer/queryable_buffer.rs"
            // How can persist jobs be empty even though a snapshot is triggered?
            //
            // When force snapshot is set, wal_periods (tracked by
            // snapshot_tracker) will never be empty as a no-op is added. This
            // means even though there is a wal period the query buffer might
            // still be empty. The reason is, when snapshots are happening very
            // close to each other (when force snapshot is set), they could get
            // queued to run immediately one after the other as illustrated in
            // example series of flushes and force snapshots below,
            //
            //   1 (only wal flush) // triggered by flush interval 1s
            //   2 (snapshot)       // triggered by flush interval 1s
            //   3 (force_snapshot) // triggered by mem check interval 10s
            //   4 (force_snapshot) // triggered by mem check interval 10s
```

1 秒間隔のフラッシュと 10 秒間隔のメモリチェックは独立に動くので、メモリ逼迫時には強制スナップショットが連続して並ぶ。3 番目が no-op を入れてバッファを全部追い出したあと、4 番目には書き出すものが何も残っていない。結果として「0 個の Parquet ファイルを含むスナップショットファイル」ができる。対策は単純で、永続化ジョブが 0 件かつ削除ファイルも 0 件なら、スナップショットファイルを書かない。

### 同時に走らせない

WAL 側は `Semaphore::new(1)` を持ち、スナップショットが決まったら permit を取る。permit が解放されるのは、Parquet 書き出しが終わり、さらに対応する WAL ファイルの削除が終わったあと ([`influxdb3_wal/src/object_store.rs#L552`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/object_store.rs#L552))。

```rust title="influxdb3_wal/src/object_store.rs"
        // release the permit so the next snapshot can be run when the time comes
        drop(snapshot_permit);
```

permit の寿命が「一連の後始末が終わるまで」に揃えてあるので、スナップショット N の WAL 削除中に N+1 が始まって番号の管理が競合する、という事故が起きない。

## なぜそうなっているか

- **強制スナップショットは OOM 対策として後から入った。** コミット aa9213c4f4 (2025-01) "feat: check mem and force snapshot (#25767)": "This commit allows checking memory in the background and force snapshotting if query buffer size is > mem threshold." 直前のコミット 6e2e39cd4c "feat: snapshot when wal buffer is empty (#25765)" が no-op の仕組みを入れている。順序が示唆的で、**「メモリを見て強制する」を作る前に「空バッファでもスナップショットできる」を作った**。既存の判断ロジック (WAL 期間が要る) を壊さずに新しいトリガを足すための土台になっている。
- **空のスナップショットファイルはバグ報告から直された。** コミット 4eccc38129 (2025-01) "fix: reproducer for the empty snapshot file issue (#25835)"。コミットメッセージが "reproducer" から始まっているとおり、まず再現テストを書いてから "avoid creating empty (0 dbs) snapshot file" を入れている。2 つの独立したタイマーが作る競合は、再現手順を固定しないと直したかどうかも分からない。
- **`3 * snapshot_size` という安全弁は「正しさ」より「詰まらないこと」を優先した判断。** 全部出せば、未来時刻のデータを含む gen1 チャンクが中途半端な状態で Parquet になる (後で同じ時間範囲に別のファイルが来て重なる)。それでも WAL が無限に溜まってディスクとメモリを食い潰すよりましだ、という選択。安全弁が作動したことは `forced: true` として記録され、`info!` ログにも出る。
- **判断ロジックが `Vec<WalPeriod>` しか触らないのは、テスト容易性のためでもある。** `snapshot_tracker/tests.rs` は 138 行で、期間を並べて `snapshot()` の戻り値を検証するだけ。時計もオブジェクトストアもモックせずに、「未来時刻が来たら詰まる」「3 倍で全部出る」といった分岐を直接書ける。

## どう活かすか

- **「いつ実行するか」の判断を、実行の副作用から切り離した純粋な型に閉じ込める。** 入力を「これまでに観測した区間の列」に還元すると、判断ロジックが表形式のテストで書けるようになる。時計・ストレージ・DB を判断側から追い出すのが要点。
- 時刻を扱うバッチ処理では、**壁時計ベースの境界と、データ由来の境界を区別する**。遅れて来るデータや未来の時刻を許すシステムでは、後者しか使えない場面がある。
- データ由来の境界を使うと、**「境界が進まなくなる」失敗モード** が必ず生まれる。1 件の異常なレコードが全体を止める。「N 倍溜まったら条件を無視して全部処理する」のような、乱暴だが止まらない安全弁を最初から入れておく。作動したことをフラグとログに残せば、後から原因を追える。
- 連続した範囲を消す (WAL の連番削除、Kafka のオフセットコミット) 処理では、選別に `filter` ではなく **`take_while` を使う**。飛び飛びの選択を許すと、後段の「範囲で消す」が成立しなくなる。
- 「処理する対象」と「後始末してよい範囲」を **1 つの構造体で同時に決めて渡す**。別々に計算すると、片方だけ進んで不整合が起きる。
- 独立したタイマーを 2 本以上持つと、**その 2 本が最悪の順で噛み合ったときに何が起きるか** を必ず考える。InfluxDB の場合は「空のスナップショット」で済んだが、コメントに残された時系列の書き下しは、この手のバグを説明するときの良いお手本になる。
- ある一連の処理を直列化したいなら、semaphore の permit の寿命を **後始末まで含めた範囲** に合わせる。処理本体だけで解放すると、後始末どうしが競合する。
