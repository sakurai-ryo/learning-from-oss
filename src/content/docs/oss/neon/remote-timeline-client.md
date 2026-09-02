---
title: "remote_timeline_client — S3 との整合をキューで守る"
description: "S3 にはトランザクションがない。index ファイル 1 つを「真実」に定め、その更新順序をキューで守ることで、任意のタイミングでクラッシュしても一貫した状態が残るようにしている。何を諦めたかも明記されている。"
group: "pageserver — ストレージ"
sidebar:
  order: 36
---

## 何を学んだか

pageserver は S3 を「唯一の永続ストア」として扱う ([書き込みパス](../write-path/))。しかし S3 には複数オブジェクトのアトミック更新がない。

解決は、**参照の起点を 1 つに絞ること**だった。

```rust title="pageserver/src/tenant/remote_timeline_client.rs"
//! The "directory structure" in the remote storage mirrors the local directory structure, with paths
//! like `tenants/<tenant_id>/timelines/<timeline_id>/<layer filename>`.
//! Yet instead of keeping the `metadata` file remotely, we wrap it with more
//! data in an "index file" aka [`IndexPart`], containing the list of **all** remote
//! files for a given timeline.
//! If a file is not referenced from [`IndexPart`], it's not part of the remote storage state.
//!
//! Having the `IndexPart` also avoids expensive and slow `S3 list` commands.
```

([pageserver/src/tenant/remote_timeline_client.rs L45](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/remote_timeline_client.rs#L45))

**`IndexPart` から参照されていないファイルは、存在しないものとして扱う。**

これで「オブジェクトが 1 つ増える」「1 つ減る」がアトミックになる。index を書き換えた瞬間に、参照が切り替わる。**S3 の PUT が単一オブジェクトについてはアトミックであることに、全部を還元している。**

副次的に `LIST` が不要になるのも大きい。S3 の `LIST` は遅く、ページングが要り、結果整合性の影響も受けやすい。**索引を自分で持てば、そもそも列挙しなくていい。**

## 順序は呼び出し側が守り、並列化は client がやる

```rust title="pageserver/src/tenant/remote_timeline_client.rs"
//! The contract between client and its user is that the user is responsible of
//! scheduling operations in an order that keeps the remote consistent as
//! described above.
//!
//! From the user's perspective, the operations are executed sequentially.
//! Internally, the client knows which operations can be performed in parallel,
//! and which operations act like a "barrier" that require preceding operations
//! to finish. The calling code just needs to call the schedule-functions in the
//! correct order, and the client will parallelize the operations in a way that
//! is safe. For more details, see `UploadOp::can_bypass`.
```

**「呼び出し側は順番に並べるだけでいい。並列化は中でやる」**という契約になっている。

これは API の設計としてかなり良い形だ。呼び出し側は「レイヤを上げてから index を上げる」という自明な順序だけ守ればよく、並列化の安全性を考えなくていい。

並列化の判定は `can_bypass` に集約されている。

```rust title="pageserver/src/tenant/upload_queue.rs"
    pub fn can_bypass(&self, other: &UploadOp, index: &IndexPart) -> bool {
        match (self, other) {
            // Nothing can bypass a barrier or shutdown, and it can't bypass anything.
            (UploadOp::Barrier(_), _) | (_, UploadOp::Barrier(_)) => false,
            (UploadOp::Shutdown, _) | (_, UploadOp::Shutdown) => false,

            // Uploads and deletes can bypass each other unless they're for the same file.
            (UploadOp::UploadLayer(a, ameta, _), UploadOp::UploadLayer(b, bmeta, _)) => {
                /* 同じパスかどうか */
            }

            // Deletes are idempotent and can always bypass each other.
            (UploadOp::Delete(_), UploadOp::Delete(_)) => true,

            // Uploads and deletes can bypass an index upload as long as neither the uploaded index
            // nor the active index below it references the file. A layer can't be modified or
            // deleted while referenced by an index.
            (UploadOp::UploadLayer(u, umeta, _), UploadOp::UploadMetadata { uploaded: i })
            | (UploadOp::UploadMetadata { uploaded: i }, UploadOp::UploadLayer(u, umeta, _)) => {
                let uname = u.layer_desc().layer_name();
                !i.references(&uname, umeta) && !index.references(&uname, umeta)
            }

            // Indexes can never bypass each other. They can coalesce though, and
            // `UploadQueue::next_ready()` currently does this when possible.
            (UploadOp::UploadMetadata { .. }, UploadOp::UploadMetadata { .. }) => false,
        }
    }
```

([pageserver/src/tenant/upload_queue.rs L513](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/upload_queue.rs#L513))

**「A は B を追い越してよいか」という 2 項関係を、全組み合わせについて定義している。** キューはこの関係を使って、先頭でないオペレーションでも安全なら先に実行する。

いくつか読みどころがある。

**レイヤの upload と delete は、違うファイルなら追い越し可能。** ファイル名で判定する。

**delete 同士は常に追い越し可能。** 冪等だから。

**index の upload と、レイヤ操作の関係が非対称でない。** 「新しい index も、今の index も、そのファイルを参照していないこと」が条件になる。**参照されているファイルは、変更も削除もできない**という不変条件がそのまま条件式になっている。

**index 同士は追い越せない。** ただし合体はできる。連続する index 更新は 1 回にまとめられる。

この `can_bypass` には専用のテストがある (`can_bypass_path`)。**2 項関係の全組み合わせを網羅的にテストする**という形で、この種のロジックの正しさを担保している。

## 「望ましい状態」と「実際の状態」を分けて持つ

```rust title="pageserver/src/tenant/remote_timeline_client.rs"
//! The *actual* remote state lags behind the *desired* remote state while
//! there are in-flight operations.
//! We keep track of the desired remote state in [`UploadQueueInitialized::dirty`].
//! It is initialized based on the [`IndexPart`] that was passed during init
//! and updated with every `schedule_*` function call.
//! All this is necessary necessary to compute the future [`IndexPart`]s
//! when scheduling an operation while other operations that also affect the
//! remote [`IndexPart`] are in flight.
```

**`dirty` (これから到達する状態) と `clean` (もう到達した状態) を両方持つ。**

これがないと、飛行中の操作がある状態で新しい操作をスケジュールしたときに、どんな index を作ればいいか計算できない。**「今の S3 の状態」ではなく「キューを全部流し終わったときの状態」を基準に組み立てる。**

## クラッシュ時に何が起きるか

```rust title="pageserver/src/tenant/remote_timeline_client.rs"
//! # Crash Consistency
//!
//! We do not persist the upload queue state.
//! If we drop the client, or crash, all unfinished operations are lost.
//!
//! To recover, the following steps need to be taken:
//! - Retrieve the current remote [`IndexPart`]. This gives us a
//!   consistent remote state, assuming the user scheduled the operations in
//!   the correct order.
//! - Initiate upload queue with that [`IndexPart`].
//! - Reschedule all lost operations by comparing the local filesystem state
//!   and remote state as per [`IndexPart`].
```

**キューは永続化しない。** クラッシュしたら全部やり直す。

やり直せる理由は、**ローカルのファイルシステムと index を突き合わせれば、必要な操作が再導出できる**からだ。「何をすべきだったか」の記録が要らない。

これは intent log を持たない設計で、safekeeper の partial backup ([S3 への WAL バックアップと eviction](../wal-backup-eviction/)) とは逆の選択になっている。違いは「再導出できるか」だ。レイヤファイルはローカルに残っているので再導出できる。

## 諦めたこと

```rust title="pageserver/src/tenant/remote_timeline_client.rs"
//! Note that if we crash during file deletion between the index update
//! that removes the file from the list of files, and deleting the remote file,
//! the file is leaked in the remote storage. Similarly, if a new file is created
//! and uploaded, but the pageserver dies permanently before updating the
//! remote index file, the new file is leaked in remote storage. We accept and
//! tolerate that for now.
```

**オブジェクトが漏れることを許容している。**

そして、なぜ簡単に直せないかも説明されている。

```rust title="pageserver/src/tenant/remote_timeline_client.rs"
//! Note further that we cannot easily fix this by scheduling deletes for every
//! file that is present only on the remote, because we cannot distinguish the
//! following two cases:
//! - (1) We had the file locally, deleted it locally, scheduled a remote delete,
//!   but crashed before it finished remotely.
//! - (2) We never had the file locally because we haven't on-demand downloaded
//!   it yet.
```

**「リモートにだけあるファイル」が、漏れたゴミなのか、まだダウンロードしていない正常なファイルなのか、区別が付かない。**

pageserver がレイヤを遅延ダウンロードする設計 (ローカルはキャッシュ) を選んだ結果、この 2 つが同じ見た目になった。**1 つの設計判断が、別の問題の解決可能性を奪っている。**

この漏れを回収するのが `storage_scrubber` の仕事になる ([storage_scrubber — S3 の整合性を外から検査する](../storage-scrubber/))。**オンラインで解けない問題を、オフラインのバッチに追い出した。**

## 前提として書かれている 3 つのこと

```rust title="pageserver/src/tenant/remote_timeline_client.rs"
//! All of this relies on the following invariants:
//!
//! - We rely on read-after write consistency in the remote storage.
//! - Layer files are immutable.
//!
//! NB: Pageserver assumes that it has exclusive write access to the tenant in remote
//! storage. Different tenants can be attached to different pageservers, but if the
//! same tenant is attached to two pageservers at the same time, they will overwrite
//! each other's index file updates, and confusion will ensue. There's no interlock or
//! mechanism to detect that in the pageserver, we rely on the control plane to ensure
//! that that doesn't happen.
```

**3 つ目が重い。「pageserver 側には検出機構がない。control plane が保証することに依存している」。**

そして実際に事故が起きた。この文章が書かれた後、generation 番号という検出機構が導入されている ([generation 番号](../generations-and-deletion/))。**「control plane を信じる」で始めて、信じられないことが分かってから仕組みを足した**という順序が、コメントの層として残っている。

読み取り後書き込み整合性 (read-after-write consistency) への依存も明示されている。S3 は 2020 年から強整合になったので今は成り立つが、**依存していることを書いておく**のが重要になる。

## リトライは無限

```rust title="pageserver/src/tenant/remote_timeline_client.rs"
//! # Retries & Error Handling
//!
//! The client retries operations indefinitely, using exponential back-off.
//! There is no way to force a retry, i.e., interrupt the back-off.
//! This could be built easily.
```

**永久にリトライする。** S3 が落ちていても諦めない。諦めたらデータを失うからだ。

「バックオフを中断する手段はない。作ろうと思えば簡単に作れる」という、**作っていない理由が「必要になっていないから」であることを明示する**書き方になっている。

## この先に効いてくること

- **参照の起点を 1 オブジェクトに絞ると、複数オブジェクトの更新がアトミックになる。**
- **順序は呼び出し側、並列化は実装側。** `can_bypass` の 2 項関係に集約。
- **再導出できるなら intent log は要らない。** ローカルと index の差分から復元する。
- **オンラインで区別できない問題は、オフラインのバッチに追い出す。**
- **前提は明記する。** 後からその前提が破れたときに、どこを直せばいいかが分かる。
