---
title: "WAL フレームの push/pull と、論理変更の再適用を使い分ける"
description: "同期には 2 つのストリームがある。ページや WAL フレームをそのまま送る物理同期と、行単位の変更を送る論理同期だ。物理は速いが、両側で編集されると衝突を解けない。だから「ローカルの変更を WAL の水位まで巻き戻し、リモートを適用し、CDC テープからローカルを掛け直す」という手順を取る。外から WAL フレームを差し込む API が、その土台になっている。"
sidebar:
  order: 32
---

## 何を学んだか

MySQL のレプリケーションには行ベースと文ベースがある。Turso の同期にも 2 種類あるが、軸が違う。

```rust title="sync/engine/src/server_proto.rs"
pub enum PullUpdatesStreamKind {
    Pages = 0,
    MvccLogicalLog = 1,
}
```

[`sync/engine/src/server_proto.rs#L61-L64`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/server_proto.rs#L61-L64)。

- **`Pages`** — データベースファイルのページ、または WAL フレームをそのまま送る (物理)
- **`MvccLogicalLog`** — [MVCC の論理ログ](../mvcc/) を送る (論理)

**物理は速い。** バイト列をそのまま置くだけで、SQL の実行も索引の更新も要らない。

**論理は柔軟だ。** 相手のページ構成が違っても適用でき、行単位で衝突を判定できる。

そしてもう 1 つ、**双方向同期という要求**がある。ローカルでもリモートでも書ける。オフラインで書いた変更を、後でリモートに合流させる。

## ソースコードのどこか

### 外から WAL フレームを差し込む API

```rust title="sync/engine/src/wal_session.rs"
pub struct WalSession {
    conn: Arc<turso_core::Connection>,
    in_txn: bool,
}
```

```rust title="sync/engine/src/wal_session.rs"
    pub fn begin(&mut self) -> Result<()> {
        assert!(!self.in_txn);
        self.conn.wal_insert_begin()?;
        self.in_txn = true;
        Ok(())
    }
    pub fn insert_at(&mut self, frame_no: u64, frame: &[u8]) -> Result<WalFrameInfo> {
        assert!(self.in_txn);
        let info = self.conn.wal_insert_frame(frame_no, frame)?;
        Ok(info)
    }
    pub fn read_at(&mut self, frame_no: u64, frame: &mut [u8]) -> Result<WalFrameInfo> {
```

[`sync/engine/src/wal_session.rs#L7-L38`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/wal_session.rs#L7-L38)。

**`wal_insert_frame` — WAL に生のフレームを直接書き込む。** SQL を経由しない。

これが物理同期の土台になる。リモートから受け取ったフレームを、そのまま [WAL](../wal/) に追記する。**B-tree も VDBE も通らない。**

`Drop` の実装が丁寧だ。

```rust title="sync/engine/src/wal_session.rs"
    pub fn end(&mut self, force_commit: bool) -> Result<()> {
        assert!(self.in_txn);
        let result = self.conn.wal_insert_end(force_commit);
        // Do not use `?` before clearing this flag: an error here can still
        // mean the WAL transaction was ended, so Drop must not retry cleanup.
        self.in_txn = false;
        result?;
        Ok(())
    }
```

```rust title="sync/engine/src/wal_session.rs"
impl Drop for WalSession {
    fn drop(&mut self) {
        if self.in_txn {
            let _ = self
                .end(false)
                .inspect_err(|e| tracing::error!("failed to close WAL session: {}", e));
        }
    }
}
```

[`sync/engine/src/wal_session.rs#L40-L63`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/wal_session.rs#L40-L63)。

**「`?` をフラグのクリアより先に書くな」。** `wal_insert_end` が失敗しても、**WAL トランザクションは終わっている可能性がある**。フラグを立てたまま帰ると、`Drop` がもう一度終了処理を呼ぶ。

`?` を 1 つ書く位置が、二重解放になるかどうかを分けている。**RAII で後始末する型では、「失敗したときに後始末済みかどうか」を必ず考える必要がある。**

そしてこの経路には、専用のテストがある。

```rust title="sync/engine/src/wal_session.rs"
    fn failed_commit_error_does_not_make_drop_double_end_wal_session() {
```

[`sync/engine/src/wal_session.rs#L196`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/wal_session.rs)。

テストのために、**WAL への `pwritev` だけを失敗させる I/O 実装**が書かれている。

```rust title="sync/engine/src/wal_session.rs"
            if self.path.ends_with("-wal") && self.fail_wal_pwritev.load(Ordering::SeqCst) {
                return Err(turso_core::CompletionError::IOError(
                    std::io::ErrorKind::StorageFull,
                    "pwritev",
                )
                .into());
            }
```

[`sync/engine/src/wal_session.rs#L165-L172`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/wal_session.rs)。

**[`IO` trait が差し替えられる](../io-backends/) おかげで、「特定のファイルへの特定の操作だけを失敗させる」テストが 100 行足らずで書ける。** 拡張点を作った配当が、こういう場所で出る。

### ローカルの変更を巻き戻して、掛け直す

物理同期には根本的な問題がある。**両側で書かれていたら、ページを上書きするとローカルの変更が消える。**

Turso の解き方は、Git の rebase に似ている。

```rust title="sync/engine/src/types.rs"
    /// pair of frame_no for Draft and Synced DB such that content of the database file up to these frames is identical
    pub revert_since_wal_salt: Option<Vec<u32>>,
    pub revert_since_wal_watermark: u64,
```

[`sync/engine/src/types.rs#L152-L154`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/types.rs#L152-L154)。

**「ここまでは同期済みだった」という WAL のフレーム番号を覚えておく。**

同期の流れはこうなる。

1. **巻き戻す** — その水位より後のローカルの変更を、WAL ごと捨てる
2. **リモートを適用する** — ページ/フレームをそのまま置く
3. **掛け直す** — [CDC テープ](../cdc-tape/) からローカルの変更を読み、SQL として再実行する

**3 番目が論理的な操作**になっている。物理的にページを戻すのではなく、**「何をしたか」を再実行する。**

だから CDC が要る。**変更のバイト列ではなく意味を持っておかないと、掛け直せない。**

`revert_since_wal_salt` も併せて持っているのが要点で、[WAL のソルト](../wal/) は WAL が作り直されるたびに変わる。**フレーム番号だけでは、「同じ WAL の N 番目」を特定できない。**

論理同期の場合は、この巻き戻しが要らない。

```rust title="sync/engine/src/database_sync_engine.rs"
        if matches!(remote_changes.stream_kind, DbChangesStreamKind::Logical) {
            let logical_table_names_by_stable_id = self
                .apply_logical_mvcc_changes_internal(coro, &changes_file)
                .await?;
            self.update_meta(coro, |m| {
                m.revert_since_wal_salt = None;
                m.revert_since_wal_watermark = 0;
```

[`sync/engine/src/database_sync_engine.rs#L1887-L1894`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_engine.rs#L1887-L1894)。

**論理ログを適用するなら、行単位で混ぜられる。** 巻き戻しの水位は要らなくなるので `None` に戻す。

### 送るページを、ビットマップで選ぶ

```rust title="sync/engine/src/server_proto.rs"
    /// server pages to select for sending; empty set will be interpreted as request for all pages
    /// if not empty - then server_pages_selector holds bytes for RoaringBitmap with bits set for pages to return
    #[prost(bytes, tag = "5")]
    pub server_pages_selector: Bytes,
    /// server query which select pages for sending
    #[prost(string, tag = "7")]
    pub server_query_selector: String,
```

[`sync/engine/src/server_proto.rs#L36-L43`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/server_proto.rs#L36-L43)。

**クライアントが「このページだけ送れ」と Roaring Bitmap で指定できる。**

Roaring Bitmap は疎な整数集合を圧縮して持つ形式で、**「10 万ページのうち 300 ページ」を数百バイトで表せる。**

`server_query_selector` の方は **SQL でページを選ぶ**。「この表に属するページだけ」といった指定になる。部分同期 (partial sync) の実装で、**データベース全体を持たないクライアント**が作れる。

「空なら全ページ」という規約も効いている。**追加のフラグを持たず、空集合に意味を与えている。**

### 古いクライアントとの互換

```rust title="sync/engine/src/server_proto.rs"
    /// requested update stream kind
    ///
    /// Kept at tag 8 so older boolean clients remain wire-compatible:
    /// false/absent decodes as Pages(0), true decodes as MvccLogicalLog(1).
    #[prost(enumeration = "PullUpdatesStreamKind", tag = "8")]
    pub stream_kind: i32,
```

[`sync/engine/src/server_proto.rs#L18-L24`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/server_proto.rs#L18-L24)。

**元は `bool` だったフィールドを、同じタグ番号のまま `enum` に変えている。**

protobuf では `bool` も `enum` も varint として符号化される。`false` = 0、`true` = 1。**`Pages` = 0、`MvccLogicalLog` = 1 と並べれば、古いクライアントが送った `bool` がそのまま新しい `enum` として読める。**

**列挙の値の順序が、互換性の要件になっている。** 逆順にしていたら、古いクライアントが論理ログを要求したことになる。

### 静かに降格させず、はっきり失敗する

```rust title="sync/engine/src/database_sync_engine.rs"
/// MVCC logical sync is incompatible with partial sync and encrypted remotes.
/// This used to silently downgrade to page pulls, but the server rejects page
/// incremental pulls for MVCC databases, so a silent downgrade just defers the
/// failure to an opaque protocol error on every pull. Fail fast and loudly
/// instead. Never called for page-mode (legacy) replicas.
fn ensure_logical_mvcc_pull_supported(
    partial_sync_active: bool,
    remote_encryption_key: Option<&str>,
) -> Result<()> {
    if partial_sync_active {
        return Err(Error::DatabaseSyncEngineError(
            "MVCC logical sync does not support partial sync; disable partialSyncExperimental for this database".to_string(),
        ));
    }
```

[`sync/engine/src/database_sync_engine.rs#L579-L592`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_engine.rs#L579-L592)。

**「以前は静かにページ同期に降格していた。だがサーバは MVCC データベースへのページ同期を拒否するので、降格は失敗を『毎回のプルで不可解なプロトコルエラー』に先送りするだけだった。速く、はっきり失敗させる。」**

これは設計の変更が、理由つきで記録されている例になる。**「親切に降格する」が、結果として不親切だった。**

エラーメッセージも具体的で、**「`partialSyncExperimental` を無効にしろ」と設定名を挙げている。**

### バッチの切れ目はトランザクション境界に合わせる

```rust title="sync/engine/src/database_sync_engine.rs"
    /// When set, [`push_changes_to_remote`] sends the local change set to the
    /// remote in multiple HTTP batches, sealing the current batch as soon as it
    /// has accumulated >= `push_operations_threshold` operations *and* the
    /// next batch boundary lines up with a transaction boundary in the local
    /// CDC log. Splits never happen mid-transaction.
```

[`sync/engine/src/database_sync_engine.rs#L67-L72`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_engine.rs#L67-L72)。

**「閾値を超えた **かつ** トランザクション境界に一致したとき」に区切る。** 「トランザクションの途中では絶対に分割しない」と明記されている。

閾値は目安であって、**厳守されるのは境界の方**になる。トランザクションの途中で切ると、リモートに中途半端な状態ができる。

[CDC の V2 で COMMIT レコードを足した](../cdc-tape/) のが、ここで効いている。**境界が記録されていなければ、この判定ができない。**

### 起きうる状況が、テストの名前になっている

```rust title="sync/engine/src/database_sync_engine.rs"
    /// Deferred-bootstrap replica ("converted to cloud sync later"): a local
    /// WAL-mode database with local writes meets an MVCC-protocol remote on
    /// first contact. The engine must detect the protocol, convert the local
    /// database to MVCC journal mode, apply the remote base as replace-base,
    /// replay the local changes on top, and stay MVCC across a reopen.
    #[test]
    fn deferred_first_contact_converts_wal_replica_to_mvcc_and_applies_base() {
```

[`sync/engine/src/database_sync_engine.rs#L4675-L4682`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_engine.rs#L4675-L4682)。

**「ローカルで使っていたデータベースを、後からクラウド同期に繋いだ」というシナリオ。**

期待する動作が 5 段階で書かれている。プロトコルを検出し、ローカルを MVCC に変換し、リモートを土台として置き、ローカルの変更を上に掛け直し、**再起動しても MVCC のままでいる。**

**同期エンジンの複雑さの大半は、こういう「状態の組み合わせ」から来る。** WAL かMVCC か、ローカルに変更があるかないか、初回接続か再開か、部分同期か全体か。

シナリオの名前をテスト名にすることで、**どの組み合わせを扱ったかが一覧になる。**

### ディレクトリの fsync まで面倒を見る

```rust title="sync/engine/src/database_sync_engine.rs"
/// Fsync the directory that contains `path`, making newly created or removed
/// directory entries (the replace-base marker and backups) durable across a
/// crash. Fsyncing a file's contents does not guarantee its *directory entry*
/// survives a crash, so the guard's crash-safety ordering (marker/backups
/// created before the apply mutates real files; marker removed before backups
/// during cleanup) is only meaningful once the containing directory is synced.
///
/// The replace-base guard requires real durable storage (memory paths are
/// rejected in [`ReplaceBaseApplyGuard::create`]), so a direct `std::fs`
/// directory fsync is appropriate here even though normal file IO flows through
/// [`turso_core::IO`], which has no directory concept.
```

[`sync/engine/src/database_sync_engine.rs#L323-L334`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_engine.rs#L323-L334)。

**「ファイルの内容を fsync しても、そのディレクトリエントリがクラッシュを生き延びる保証はない」。**

ベースを丸ごと置き換えるとき、目印のファイルとバックアップを作ってから本体をいじる。クラッシュしたら目印を見て復旧する。**目印が作られたことがディスクに残っていなければ、この手順に意味がない。**

そして **`turso_core::IO` を経由せず `std::fs` を直接使う**理由も書いてある。`IO` trait にディレクトリという概念がないからだ。**抽象化を通さない例外を作るとき、なぜそれが許されるかを書いている。**

## なぜそうなっているか

- **物理と論理の 2 つのストリームがあるのは、得意な場面が違うから。** 初回の取得や大量の変更は物理が速い。両側で編集される場合は論理でなければ混ぜられない。
- **WAL フレームを直接差し込む API があるのは、物理同期に SQL を通したくないから。** 受け取ったバイト列をそのまま追記すれば、B-tree の更新も索引の再構築も要らない。
- **巻き戻して掛け直す形にしたのは、物理適用が上書きだから。** ページを置くとローカルの変更が消える。だから先に退避して、後で論理的に再適用する。
- **掛け直しに CDC を使うのは、物理的な差分では順序を入れ替えられないから。** 「何をしたか」を持っていれば、別の土台の上で再実行できる。
- **WAL のソルトも一緒に覚えるのは、フレーム番号だけでは特定できないから。** WAL が作り直されると番号が振り直される。
- **ページの選択に Roaring Bitmap を使ったのは、疎な集合を小さく表せるから。** 「10 万のうち 300」を数百バイトで送れる。
- **`bool` を同じタグ番号で `enum` にしたのは、符号化が同じだから。** 値の順序を合わせておけば、古いクライアントが無変更で動く。
- **静かな降格をやめたのは、失敗を先送りするだけだったから。** 降格先でも失敗するなら、降格は問題を分かりにくくしているだけになる。
- **バッチの分割をトランザクション境界に限ったのは、中途半端な状態を作らないため。** 閾値は目安、境界は絶対。
- **ディレクトリを fsync するのは、エントリの作成が別物だから。** ファイルの中身が残っても、ファイルが存在しなければ意味がない。

## どう活かすか

- **同期の方式を 1 つに決めない。** 初回の取得と、日常の差分と、衝突する更新では、有利な方式が違う。ストリームの種類として持てば、状況で切り替えられる。
- **物理的な適用を使うなら、ローカルの変更を退避して掛け直す経路を用意する。** 上書きは速いが、上書きされる側を守る仕組みが別に要る。
- **掛け直しのために、変更の「意味」を保持する。** バイト列の差分は、順序を入れ替えると適用できない。
- **位置を指す識別子には、世代を表す値を添える。** 番号だけでは、作り直された後に同じ番号が別のものを指す。
- **疎な集合を送るなら、圧縮ビットマップを使う。** 全部か 1 つずつか、の二択にしなくてよくなる。
- **「空集合は全件を意味する」のような規約で、フラグを増やさない。** ただし規約はコメントに書く。
- **プロトコルのフィールドを拡張するときは、符号化の互換を確かめる。** `bool` → `enum` は、値の順序を合わせれば無変更で通ることがある。
- **対応できない組み合わせは、静かに降格させずに失敗させる。** 降格先でも失敗するなら、エラーが出る場所が遠くなるだけになる。
- **エラーメッセージには、直すべき設定の名前を書く。** 「対応していません」だけでは、次に何をすればいいか分からない。
- **バッチの分割は、意味の境界に合わせる。** サイズの閾値は目安として扱い、境界の方を絶対にする。
- **ファイルを作ったら、ディレクトリも fsync する。** 中身の耐久性とエントリの耐久性は別物になる。
- **抽象化を迂回するときは、理由を書く。** 「この層にはディレクトリの概念がないから」と書いてあれば、後から抽象化を直すときの手がかりになる。
