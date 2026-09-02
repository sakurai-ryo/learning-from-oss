---
title: "S3 への WAL バックアップと eviction"
description: "safekeeper は 3 台とも同じ WAL を持っているが、S3 に上げるのは 1 台でいい。誰が上げるかを、選挙ではなく決定的な関数で決めている。そして書き込みのない timeline は、ローカルから WAL を消して S3 だけに置く。"
group: "safekeeper — WAL の合意"
sidebar:
  order: 26
---

## 何を学んだか

safekeeper のディスクにある WAL は、pageserver が消化したら消してよい。しかしそれとは別に、**WAL そのものを S3 に保存する**経路がある。

理由は災害復旧だ。pageserver のレイヤファイルが何らかの理由で壊れたとき、WAL があれば作り直せる。`docs/rfcs/029-pageserver-wal-disaster-recovery.md` という RFC があるくらいで、これは想定されたシナリオになっている。

問題は、**3 台が同じ WAL を持っているのに、S3 に上げるのは 1 台でいい**ことだ。3 台が上げれば 3 倍の転送料がかかるし、同じオブジェクト名に 3 台が書くと競合する。

## 誰が上げるかを、選挙ではなく関数で決める

```rust title="safekeeper/src/wal_backup.rs"
/// Based on peer information determine which safekeeper should offload; if it
/// is me, run (per timeline) task, if not yet. OTOH, if it is not me and task
/// is running, kill it.
pub(crate) async fn update_task(
    mgr: &mut Manager,
    storage: Arc<GenericRemoteStorage>,
    need_backup: bool,
    state: &StateSnapshot,
) {
    let (offloader, election_dbg_str) = hadron_determine_offloader(mgr, state);
    let elected_me = Some(mgr.conf.my_id) == offloader;

    let should_task_run = need_backup && elected_me;
```

([safekeeper/src/wal_backup.rs L66](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/wal_backup.rs#L66))

**peer の情報 (broker 経由で得たもの) から、決定的な関数で「誰が上げるべきか」を計算する。** 全員が同じ関数を同じ入力に対して実行するので、たいてい同じ答えになる。

「たいてい」でよい理由が重要だ。**2 台が同時に上げてしまっても、壊れない。** 上げるオブジェクトは完成したセグメントで、内容は 3 台とも同じ (コミット済みの WAL なので) だから、同じバイト列を 2 回書くだけになる。無駄だが、正しい。

だから合意を取る必要がない。broker の情報が古くて一時的に食い違っても、収束すればいい。**「間違っても損しか出ない」領域には、合意のコストを払わない。**

そして選ばれなくなったら自分でタスクを止める。`BACKUP_REELECT_LEADER_COUNT` というメトリクスがあるので、切り替わりの頻度は観測できるようになっている。

上げる必要があるかの判定も単純だ。

```rust title="safekeeper/src/wal_backup.rs"
/// Do we have anything to upload to S3, i.e. should safekeepers run backup activity?
pub(crate) fn is_wal_backup_required(
    wal_seg_size: usize,
    num_computes: usize,
    state: &StateSnapshot,
) -> bool {
    num_computes > 0 ||
    // Currently only the whole segment is offloaded, so compare segment numbers.
    (state.commit_lsn.segment_number(wal_seg_size) > state.backup_lsn.segment_number(wal_seg_size))
}
```

([safekeeper/src/wal_backup.rs L55](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/wal_backup.rs#L55))

**完成したセグメントが 1 本でもあれば上げる。** compute が繋がっていれば、すぐ完成するだろうから準備しておく。

## 完成していないセグメントも上げる

セグメント単位だと 16MB 溜まるまで S3 に何も上がらない。書き込みの少ない timeline では、コミット済みなのに S3 にない WAL が長時間残る。

そこで partial backup がある。

```rust title="safekeeper/src/wal_backup_partial.rs"
//! Safekeeper timeline has a background task which is subscribed to `commit_lsn`
//! and `flush_lsn` updates.
//!
//! After the partial segment was updated (`flush_lsn` was changed), the segment
//! will be uploaded to S3 within the configured `partial_backup_timeout`.
//!
//! The filename format for partial segments is
//! `Segment_Term_Flush_Commit_skNN.partial`, where:
//! - `Segment` – the segment name, like `000000010000000000000001`
//! - `Term` – current term
//! - `Flush` – flush_lsn in hex format `{:016X}`, e.g. `00000000346BC568`
//! - `Commit` – commit_lsn in the same hex format
//! - `NN` – safekeeper_id, like `1`
```

([safekeeper/src/wal_backup_partial.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/wal_backup_partial.rs#L1))

**ファイル名に term・flush_lsn・commit_lsn・safekeeper ID を全部埋め込む。**

これで、完成セグメントとまったく違う戦略が取れるようになる。

- **上書きしない。** 内容が変われば名前も変わる。だから S3 の結果整合性を気にしなくていい
- **safekeeper ごとに別のオブジェクト。** 3 台が同時に上げても衝突しない。リーダー選出が要らない
- **どれが最新かは名前から分かる。** term と LSN で比較できる

**未完成のデータは「不変オブジェクトの列」として扱い、完成したデータは「1 つの正典」として扱う。** 可変性のあるものを、名前に状態を埋め込んで不変にする、という古典的な手口だ。

代償はゴミが溜まることで、それを管理するための状態が control file に入る。

```rust title="safekeeper/src/wal_backup_partial.rs"
pub enum UploadStatus {
    /// Upload is in progress. This status should be used only for garbage collection,
    /// don't read data from the remote storage with this status.
    InProgress,
    /// Upload is finished. There is always at most one segment with this status.
    /// It means that the segment is actual and can be used.
    Uploaded,
    /// Deletion is in progress. This status should be used only for garbage collection,
    /// don't read data from the remote storage with this status.
    Deleting,
}
```

([safekeeper/src/wal_backup_partial.rs L45](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/wal_backup_partial.rs#L45))

**3 状態のうち 2 つは「ゴミ掃除のためだけ」にある。** データを読んでよいのは `Uploaded` だけ。

そして順序が明記されている。

```rust title="safekeeper/src/wal_backup_partial.rs"
//! Each safekeeper will keep info about remote partial segments in its control
//! file. Code updates state in the control file before doing any S3 operations.
//! This way control file stores information about all potentially existing
//! remote partial segments and can clean them up after uploading a newer version.
```

**S3 を触る前に、control file に「これから作る」と書く。** 逆順にすると、作った直後にクラッシュしたときに、誰も知らないオブジェクトが S3 に残る。

「作ったかもしれない」を記録しておけば、後から確実に消せる。**intent log の基本形**で、pageserver の deletion queue も同じ構造をしている ([generation 番号](../generations-and-deletion/))。

## eviction — ローカルから WAL を消す

書き込みが止まった timeline は、ずっとディスクを占有する。数万テナントぶんが積み上がると無視できない。

そこで、条件が揃った timeline はローカルの WAL を消して S3 だけに置く。

```rust title="safekeeper/src/timeline_eviction.rs"
    /// Returns true if the timeline is ready for eviction.
    /// Current criteria:
    /// - no active tasks
    /// - control file is flushed (no next event scheduled)
    /// - no WAL residence guards
    /// - no pushes to the broker
    /// - last partial WAL segment is uploaded
    /// - all local segments before the uploaded partial are committed and uploaded
    pub(crate) fn ready_for_eviction(
        &self,
        next_event: &Option<tokio::time::Instant>,
        state: &StateSnapshot,
    ) -> bool {
        self.backup_task.is_none()
            && self.recovery_task.is_none()
            && self.wal_removal_task.is_none()
            && self.partial_backup_task.is_none()
            && next_event.is_none()
            && self.access_service.is_empty()
            && !self.tli_broker_active.get()
```

([safekeeper/src/timeline_eviction.rs L25](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/timeline_eviction.rs#L25))

**条件が 7 つ。全部「今この timeline に対して何も起きていない」ことの確認だ。**

`access_service.is_empty()` と WAL residence guard が要点になる。**「今このファイルを読んでいる人がいないこと」**を、参照カウント的な仕組みで確かめている。読んでいる最中に消したら壊れる。

`WalResidentTimeline` という型が、この保証を型で表している。[recovery](../safekeeper-recovery/) や backup のコードがこの型を要求するのは、「WAL がローカルにあることが保証された timeline」だけを扱うためだ。**guard を型として持ち回ることで、消してよいかどうかの判定が参照の有無に還元される。**

条件の最後にある「アップロード済み partial の前の全セグメントがコミット済みかつアップロード済み」には、長い説明が付いている。

```rust title="safekeeper/src/timeline_eviction.rs"
            // And it is the next one after the last removed. Given that local
            // WAL is removed only after it is uploaded to s3 (and pageserver
            // advancing remote_consistent_lsn) which happens only after WAL is
            // committed, true means all this is done.
            //
            // This also works for the first segment despite last_removed_segno
            // being 0 on init because this 0 triggers run of wal_removal_task
            // on success of which manager updates the horizon.
```

**「1 つの単純な条件が、実は 3 つの条件の連鎖を含意している」**という説明になっている。ローカル WAL の削除は S3 アップロード後にしか起きず、S3 アップロードはコミット後にしか起きない。だから「最後に消したセグメントの次である」を確かめれば、全部が確かめられる。

こういう含意は書いておかないと維持できない。上流の条件を 1 つ変えた瞬間に、この判定が黙って間違いになるからだ。

## 復帰は透過的

`EvictionState` は control file に入っているので ([control file](../safekeeper-state/))、再起動しても状態が残る。読み取り要求が来たら S3 から取り直す。

```rust title="safekeeper/src/timeline_eviction.rs"
//! Code related to evicting WAL files to remote storage.
//!
//! The actual upload is done by the partial WAL backup code. This file has
//! code to delete and re-download WAL files, cross-validate with partial WAL
//! backup if local file is still present.
```

**アップロードは既存の partial backup が済ませているので、eviction は「消す」と「取り戻す」だけを実装する。** 新しいアップロード経路を作らず、既にある不変オブジェクトの列に相乗りしている。

## この先に効いてくること

- **間違っても損しか出ない領域には、合意を使わない。** 誰がバックアップするかは決定的関数で十分。
- **可変なデータは、名前に状態を埋め込んで不変オブジェクトの列にする。** 上書きが消えると調整が要らなくなる。
- **S3 を触る前に「触るつもり」を記録する。** intent log。ゴミを確実に回収するため。
- **「読んでいる人がいない」を型 (guard) で表す。** 消してよいかの判定が参照の有無になる。
- **単純な条件が含意している連鎖は、コメントに書く。** 上流を変えたときに気付くために。
