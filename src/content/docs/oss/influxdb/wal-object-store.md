---
title: "追記できないストレージの上では、WAL を「1 秒ぶんを 1 オブジェクト」にまとめ、durability の返答をそのフラッシュに相乗りさせる"
description: "オブジェクトストアには append が無い。InfluxDB 3 は WAL を「メモリに 1 秒ぶん貯めて、1 回の PUT で 1 ファイルとして書く」形に変え、書き込み API の応答をそのフラッシュ完了に紐づける。PUT は PutMode::Create で行い、同じ node-id の別プロセスが先に書いていたら AlreadyExists を分裂脳の証拠とみなしてプロセスを落とす。ファイルはマジック 8 バイト + CRC32 + bitcode で、壊れたファイルは既定では読み飛ばす。"
group: "ストレージ"
sidebar:
  order: 2
---

## 何を学んだか

### どんな状況の話か

WAL (write ahead log) の教科書的な実装は「ローカルディスクのファイルに追記し、fsync してから応答を返す」だ。InfluxDB 3 Core はこれができない。データの置き場所が S3 / Azure Blob / GCS のようなオブジェクトストアであることを前提にしていて (README の言う diskless architecture)、オブジェクトストアには **追記が無い**。あるのは「オブジェクト全体を 1 回の PUT で置く」だけだ。1 書き込みごとに 1 オブジェクトを PUT すればレイテンシもコストも破綻する。

さらに厄介なのは、S3 には「このプロセスだけが書いてよい」を保証する仕組みが無いことだ。オペレータが同じ `--node-id` でプロセスを 2 つ起動してしまえば、両方が同じ場所に WAL を書きにいく。

### InfluxDB 3 の答え

1. **WAL の単位を「1 書き込み」から「1 フラッシュ間隔」に変える。** 書き込みはまずメモリの `WalBuffer` に貯まる。1 秒 (既定) ごとにバックグラウンドタスクがバッファを丸ごと入れ替え、その中身をシリアライズして **1 個のオブジェクト** として PUT する。ファイル名は連番。
2. **durability の応答を、そのフラッシュに相乗りさせる。** `write_ops` はバッファに ops を積むとき `oneshot::Sender` も一緒に積む。フラッシュが PUT に成功したら、そのファイルに含まれる全クライアントの oneshot にまとめて成功を返す。呼び出し側から見れば「返ってきた = オブジェクトストア上で durable」で、実際には数百の書き込みが 1 回の PUT を共有している。
3. **fsync を待たない選択肢を API に出す。** `?no_sync=true` を付けた書き込みは `write_ops_unconfirmed` に流れ、バッファに積んだ時点で返る。耐久性とレイテンシのトレードオフをクライアントに委ねている。
4. **PUT は `PutMode::Create` で行い、`AlreadyExists` を分裂脳の証拠として扱う。** 連番ファイルが既に存在するということは、同じ node-id の別プロセスが先に書いたということ。この場合リトライも上書きもせず、WAL を書き込み拒否状態にしてプロセス全体のシャットダウンを起動する。
5. **それ以外のエラーは 100 回まで無限に近くリトライする。** オブジェクトストアの一時障害でデータを落とさないため。100 回を超えたら待っているクライアント全員にエラーを返す。
6. **ファイル形式は「マジック 8 バイト + CRC32 (big endian) + bitcode」。** リプレイ時に壊れたファイル (短い・マジック不一致・CRC 不一致) を検出でき、既定では警告して読み飛ばす。`--wal-replay-fail-on-error` で厳格側に倒せる。
7. **リプレイは「ロードは並行、適用は逐次」。** N 個ずつ並行にダウンロードし、順序が意味を持つ適用は元の順序どおり 1 個ずつ行う。

## ソースコードのどこか

### WAL の契約

[`influxdb3_wal/src/lib.rs#L65-L119`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/lib.rs#L65-L119)。trait のドキュメントコメントが、この WAL の性質をそのまま説明している。

```rust title="influxdb3_wal/src/lib.rs"
#[async_trait]
pub trait Wal: Debug + Send + Sync + 'static {
    /// Buffer writes ops into the buffer, but returns before the operation is persisted to the WAL.
    async fn write_ops_unconfirmed(&self, op: Vec<WalOp>) -> Result<(), Error>;

    /// Writes the ops into the buffer and waits until the WAL file is persisted. When this returns
    /// the operations are durable in the configured object store and the file notifier has been
    /// called, which puts it into the queryable memory buffer.
    async fn write_ops(&self, ops: Vec<WalOp>) -> Result<(), Error>;
```

「durable になった」と「クエリできるようになった」が同じ瞬間だ、と書いてあるのが目を引く。フラッシュは PUT のあとに `WalFileNotifier` を呼び、その実装 (`QueryableBuffer`) がメモリ上のクエリ可能バッファへデータを載せる。

### 既定値

[`influxdb3_wal/src/lib.rs#L166-L176`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/lib.rs#L166-L176)。

```rust title="influxdb3_wal/src/lib.rs"
impl Default for WalConfig {
    fn default() -> Self {
        Self {
            gen1_duration: Default::default(),
            max_write_buffer_size: 100_000,
            flush_interval: Duration::from_secs(1),
            snapshot_size: 600,
            wal_replay_fail_on_error: false,
        }
    }
}
```

フラッシュ間隔 1 秒、1 ファイルに積める ops は 10 万件まで。`snapshot_size` は「何ファイルぶん貯まったら Parquet 化を考えるか」で、既定 600 は 1 秒間隔なら 10 分に相当する ([スナップショットの判断](../snapshot-tracker/) を参照)。

### フラッシュループ

[`influxdb3_wal/src/lib.rs#L555-L594`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/lib.rs#L555-L594)。

```rust title="influxdb3_wal/src/lib.rs"
pub fn background_wal_flush<W: Wal>(
    wal: Arc<W>,
    flush_interval: Duration,
    shutdown: ShutdownToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(flush_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = shutdown.wait_for_shutdown() => {
                    wal.shutdown().await;
                    break;
                },
                _ = interval.tick() => {
                    let cleanup_after_snapshot = wal.flush_buffer().await;
```

`MissedTickBehavior::Skip` の指定が効いている。フラッシュが 1 秒を超えて長引いたとき、tokio の既定 (`Burst`) では遅れを取り戻そうとティックが連射される。WAL のフラッシュでそれをやると、遅延しているオブジェクトストアに対してさらに PUT を積み増すことになる。`Skip` は遅れたぶんを捨てて次の区切りから再開する。

シャットダウンの受け口が `select!` の片方に入っていて、[順序付きシャットダウン](../ordered-shutdown/) の `ShutdownToken` を握っている。「WAL にバッファが残っているうちは HTTP を落とさない」という順序は、ここが起点になっている。

### バッファは「入れ替える」

[`influxdb3_wal/src/object_store.rs#L765-L783`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/object_store.rs#L765-L783)。

```rust title="influxdb3_wal/src/object_store.rs"
    fn flush_buffer_with_responses(
        &mut self,
        force_snapshot: bool,
    ) -> (WalContents, Vec<oneshot::Sender<WriteResult>>) {
        // swap out the filled buffer with a new one
        let mut new_buffer = WalBuffer {
            time_provider: Arc::clone(&self.time_provider),
            state: self.wal_buffer.state,
            wal_file_sequence_number: self.wal_buffer.wal_file_sequence_number.next(),
            /* ... */
        };
        std::mem::swap(&mut self.wal_buffer, &mut new_buffer);

        new_buffer.into_wal_contents_and_responses(force_snapshot)
    }
```

ロックを握っている時間は `mem::swap` の一瞬だけで、シリアライズと PUT はロックの外で走る。その間に来た書き込みは新しいバッファに積まれ、次のファイルになる。バッファは `HashMap<Arc<str>, WriteBatch>` で、同じデータベース宛の書き込みは積む時点で 1 つの `WriteBatch` にマージされる。

### PUT は Create モード

[`influxdb3_wal/src/object_store.rs#L341-L400`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/object_store.rs#L341-L400)。この章で一番示唆的な分岐。

```rust title="influxdb3_wal/src/object_store.rs"
        // keep trying to write this to object store forever
        loop {
            match self
                .object_store
                .put_opts(
                    &wal_path,
                    PutPayload::from_bytes(data.clone()),
                    PutOptions {
                        mode: PutMode::Create,
                        ..Default::default()
                    },
                )
                .await
            {
                Ok(_) => {
                    break;
                }
                // In the event that the WAL file has already been written, we want to stop the
                // process. This would be due to someone running multiple processes with the same
                // `--node-id` simultaneously. Whether that is intentional or not, we have to stop
                // the process so that either the other running process can take over, or so that
                // the operator can intervene and correct the state of their object store.
                Err(object_store::Error::AlreadyExists { path, source }) => {
```

`AlreadyExists` を受けたときの処理は 3 つ。WAL バッファを `WalBufferState::Error(WalAlreadyWrittenTo)` にして以後の書き込みを拒否し、待っているクライアント全員にエラーを返し、`shutdown_token.cancel()` でプロセス全体のシャットダウンを起動する。

```rust title="influxdb3_wal/src/object_store.rs"
                Err(e) => {
                    error!(%e, "error writing wal file to object store");
                    retry_count += 1;
                    if retry_count > 100 {
                        // we're over max retries, the object store must be down, so drop
                        // all these responses and any in the new buffer
```

一時障害は 100 ms 間隔で 100 回リトライ (約 10 秒)。それを超えたら「オブジェクトストアが落ちている」と判断して、待っているクライアントにも、次のバッファで待つことになるクライアントにもエラーを返す。**「リトライで粘る相手」と「即死すべき相手」をエラーの種類で分けている** のがこの loop の設計だ。

### ファイル名と形式

[`influxdb3_wal/src/object_store.rs#L943-L948`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/object_store.rs#L943-L948)。

```rust title="influxdb3_wal/src/object_store.rs"
pub fn wal_path(node_identifier_prefix: &str, wal_file_number: WalFileSequenceNumber) -> Path {
    Path::from(format!(
        "{node_identifier_prefix}/wal/{:011}.wal",
        wal_file_number.0
    ))
}
```

11 桁ゼロ埋め。オブジェクトストアの list は辞書順で返るので、ゼロ埋めしておけば **list した結果をソートするだけで連番順** になる。この「パスの命名でインデックスを作る」考え方は [パス設計のページ](../persist-paths/) でさらに徹底される。

中身は [`influxdb3_wal/src/serialize.rs`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/serialize.rs) が組み立てる。

```rust title="influxdb3_wal/src/serialize.rs"
/// The first bytes written into a wal file to identify it and its version.
const FILE_TYPE_IDENTIFIER: &[u8] = b"idb3.001";
```

`idb3.001` (8 バイト) + CRC32 (4 バイト, big endian) + bitcode でエンコードした `WalContents`。モジュール冒頭のコメントが形式の理由を書いている。

```rust title="influxdb3_wal/src/serialize.rs"
//! Module for serializing and deserializing the contents of a single WAL file. Since the WAL is
//! buffered in memory before writing it in a single PUT operation to object store, this works
//! a little differently than a traditional WAL that appends.
```

エラー型に付いた `is_durable_wal_corruption` の説明が丁寧で、**どのエラーが「バイト列が壊れている」でどれが「読み手が古い」か** を分類している。

```rust title="influxdb3_wal/src/serialize.rs"
    /// `Bitcode(...)` is deliberately excluded: CRC validation runs before bitcode
    /// decoding in `verify_file_type_and_deserialize`, so a `Bitcode` error means
    /// the bytes are CRC-consistent but the reader can't decode them — almost always
    /// a writer/reader version or schema skew, recoverable by upgrading the reader,
    /// not by skipping the file.
```

CRC が合っているのにデコードできないなら、それは壊れたファイルではなくバージョン不整合なので、読み飛ばしてはいけない (データを黙って失う)。読み飛ばしてよいのは CRC 不一致・マジック不一致・短すぎるファイルだけ。

### リプレイ: ロードは並行、適用は逐次

[`influxdb3_wal/src/object_store.rs#L179-L182`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/object_store.rs#L179-L182)。

```rust title="influxdb3_wal/src/object_store.rs"
        // Load N files concurrently and then replay them immediately before loading the next batch
        // of N files. Since replaying has to happen _in order_ only loading the files part is
        // concurrent, replaying the WAL file itself is done sequentially based on the original
        // order (i.e paths, which is already sorted)
        for batched in paths.chunks(concurrency_limit) {
```

`chunks(concurrency_limit)` で N 個ずつ取り、N 個を `tokio::spawn` で並行にダウンロードしてから、`for result in results` で **元の順に** 適用する。ネットワーク待ちは並列化できるが、WAL の適用順序は変えられない、という切り分け。

壊れたファイルの扱いは同じループの中にある。

```rust title="influxdb3_wal/src/object_store.rs"
                    (
                        path,
                        Err(Error::Serialize(
                            error @ (SerializeError::WalFileTooSmall { .. }
                            | SerializeError::InvalidWalFile
                            | SerializeError::Crc32Mismatch),
                        )),
                    ) if !fail_on_error => {
                        warn!(%error, %path, "Skipping corrupt WAL file");
                        continue;
                    }
```

### 削除は遅らせる

スナップショット (Parquet 化) が終わった WAL ファイルは削除できるが、すぐには消さない。`--snapshotted-wal-files-to-keep` (既定 300) のぶんだけ残し、それを超えたぶんから消す ([`#L483-L553`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_wal/src/object_store.rs#L483-L553))。削除ループのコメントが、失敗時に何が起きるかまで正直に書いている。

```rust title="influxdb3_wal/src/object_store.rs"
                    // if there are errors in between we are changing oldest to
                    // last_to_delete, this could potentially leave dangling wal
                    // files that this running process won't be able to catch.
                    // On restart however that should clamp oldest back to first
                    // dangling wal file and continue. This is the only way to
                    // address these dangling wal files.
```

削除は「一時エラーなら 1 秒待って永遠にリトライ、それ以外 (設定ミス・存在しない) はログを出して先へ進む」。取り残されたファイルは再起動時に `oldest` が再計算されることで回収される。

## なぜそうなっているか

- **`PutMode::Create` を選んだ理由は分裂脳の検出そのもの。** コミット 24887770ef (2025-03-31) "feat: shutdown on WAL overwritten (#26203)" のメッセージが端的だ。"WAL persist uses PutMode::Create in order to invoke shutdown if another process writes to the WAL ahead of it." 追記できないストレージでは、連番ファイルの `Create` 失敗が **唯一ただで手に入るフェンシング** になる。分散ロックを別途持ち込まずに「先に書いたほうが勝ち、負けたほうは死ぬ」を実現している。ただし検出であって防止ではない。負けたプロセスが気づくのは次のフラッシュ時なので、それまでに `no_sync` で受けた書き込みは失われる。
- **リプレイの並行度に上限がついたのは OOM を踏んだから。** コミット a67b50dac5 (2025-05-15) "feat: add concurrency limit for WAL replay (#26483)": "WAL replay currently loads _all_ WAL files concurrently running into OOM." その後 f9c8e0a93f (#26716) で既定値を CPU 数に合わせている。「並行度は無制限にできる」と「してよい」は別、という典型例。
- **壊れた WAL を既定で読み飛ばすのは、起動できないほうが困るから。** コミット 01c907de0e (2025-06-04) "fix: handle corrupt WAL files during replay without panic (#26556)" は、空ファイルや切り詰められたファイルで panic していたのを直したもので、"Make WAL replay configurable: skip corrupt files by default or fail on error" と方針も一緒に入れている。オブジェクトストアへの PUT は原子的なはずだが、それでも現実には壊れたファイルが観測された、ということでもある。
- **`no_sync` は後から足された。** コミット 43e186d761 (2025-01) "feat: add no_sync write_lp param for fast writes (#25902)"。`write_lp_inner` の分岐 ([`influxdb3_write/src/write_buffer/mod.rs#L542-L552`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/mod.rs#L542-L552)) に残るコメントが、既定の経路が何を保証しているかを説明している。"Thus, after this returns, the data is both durable and queryable."
- **1 秒という既定は「オブジェクトストアの PUT レイテンシ」と「失う可能性のあるデータ量」の妥協点。** 短くすれば PUT 回数 (= コスト) が増え、長くすればクラッシュ時に失う窓が広がる。この値がクライアントから見た書き込みレイテンシの下限にもなるので、レイテンシが要るなら `no_sync`、という設計になっている。

## どう活かすか

- 追記できないストレージ (オブジェクトストア、KVS の値、行の JSON カラム) の上にログを作るなら、**単位を「1 レコード」から「1 時間窓」に上げる**。窓の中でマージし、1 回の書き込みで確定させる。窓の長さがそのままレイテンシとコストのつまみになる。
- 「バッファに積む」と「返答を返す」を **oneshot チャネルの配列** で繋ぐと、N 件の要求が 1 回の I/O を共有する形が自然に書ける。要求ごとに I/O を発行してから合流させるより、ずっと単純になる。
- リトライの前に **エラーを「粘るべき」と「即死すべき」に分類する**。一時的なネットワークエラーは粘る価値があるが、`AlreadyExists` のような「前提が壊れている」証拠に対してリトライすると、状態を上書きして被害を広げる。
- 一意な連番 + `Create` (compare-and-swap 相当) は、専用のロックサービス無しで単一ライターを担保する安価な手段になる。ただし **検出は次の書き込みまで遅れる** ので、その間に失われるものを見積もっておく。
- 「順序が意味を持つ処理」は、I/O だけを並行化して適用は逐次にする。並行度は必ず設定可能にして、既定は CPU 数やメモリから決める (InfluxDB の既定は `max(num_cpus, 10)`)。
- ファイル形式にはマジックとチェックサムを入れ、**「バイトが壊れている」と「読み手が古い」を別のエラーにする**。前者は読み飛ばしてよく、後者は絶対に読み飛ばしてはいけない。この区別を型に落としておくと、後で「壊れたファイルはスキップ」という機能を安全に足せる。
- 取り込むべきでない条件: 1 件ごとの durability が要る (金融取引の記録など) なら、この「フラッシュ相乗り」方式は 1 秒ぶんのデータを失う窓を許容することになる。また、フラッシュ間隔より短い間隔でクエリの即時性が要るなら、WAL とは別にメモリバッファ側の可視性を設計する必要がある。
