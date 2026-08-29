---
title: "デーモンの代わりに、複数プロセスが同時に触る状態を SQLite に「インデックス列 + JSON」で置く"
description: "常駐プロセスが無いので、状態はプロセスの外に置き、すべての操作の入口で「読む → 実体と照合 → 書く」を徹底する。SQLite のテーブルは検索に要るキーだけを列にし、残りは Go 構造体の JSON をそのまま入れる。書き込みは排他トランザクション + 100 秒の busy timeout で直列化し、WAL は使わない。DB 作成時の静的パスを DB 自身に記録して、毎回の起動で設定との不一致を拒否する。"
group: "状態をプロセスの外に置く"
sidebar:
  order: 20
---

## 何を学んだか

### どんな状況の話か

[conmon のページ](../conmon-supervision/) で見たように、Podman ではコンテナの状態が変わるたびに別々のプロセスが動く。`podman run` が作り、conmon が起動した `podman container cleanup` が後始末し、その間に `podman ps` が読む。デーモンがあれば状態はそのメモリの中にあるが、Podman では **状態をプロセスの外に置き、どのプロセスからでも同じものを読み書きできる** 必要がある。デーモンが無料で提供していたものの一覧は [デーモンがあると何ができて、無いと何が難しいか](../daemon-or-not/) にまとめてある。

要件は 3 つ。複数プロセスの同時アクセスで壊れないこと、プロセスが途中で死んでも整合していること、Go の構造体が変わっても追随できること。

### Podman の答え

1. **SQLite を「インデックス列 + JSON blob」で使う。** `ContainerConfig` と `ContainerState` の各テーブルは、ID・名前・Pod ID・状態コードのように検索や制約に要る列だけを持ち、本体は Go 構造体を JSON にしたものを `JSON` 列に入れる。v6.1.0 でもスキーマバージョンは 1 のままで、構造体にフィールドを足すだけなら DB を変えなくてよい。
2. **すべての操作の入口で `syncContainer()` を呼ぶ。** DB から状態を読み、exit file と照合し、変わっていれば書き戻す。「メモリ上の状態が最新」という前提を一切置かない。
3. **書き込みは排他トランザクション + 長い busy timeout で直列化する。** `_txlock=exclusive`、`_sync=FULL`、`_busy_timeout=100000` (100 秒)。WAL は使わない。`database is locked` を繰り返し踏んだ経験から、性能より「ロックエラーを出さない」を優先した設計になっている。
4. **DB 作成時の静的な設定を DB 自身に記録し、毎回の起動で照合する。** `DBConfig` テーブルは 1 行しか持てず、graph root や graph driver が現在の設定と違えば `ErrDBBadConfig` で起動を拒否する。
5. **削除後も参照される値 (終了コード) は独立テーブルに持ち、GC は既存の処理に相乗りさせる。** `podman run --rm` の終了コードを、cleanup がコンテナ行を消したあとでも読めるようにする。5 分より古いものは cleanup のついでに消す。
6. **旧フォーマット (BoltDB) からの移行は「他に誰も触っていない瞬間」に自動で行う。** 再起動直後の alive lock 保持中に移行し、旧 DB はリネームして残す。

## ソースコードのどこか

### State の契約

[`libpod/state.go#L7-L19`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/state.go#L7-L19)。

```go title="libpod/state.go"
// State is a storage backend for libpod's current state.
// A State is only initialized once per instance of libpod.
// As such, initialization methods for State implementations may safely assume
// they will be run as a singleton.
// For all container and pod retrieval methods, a State must retrieve the
// Configuration struct of the container or pod and include it in the returned
// struct. The State of the container or pod may optionally be included as well,
// but this is not a requirement.
// As such, all containers and pods must be synced with the database via the
// UpdateContainer and UpdatePod calls before any state-specific information is
// retrieved after they are pulled from the database.
// Generally speaking, the syncContainer() call should be run at the beginning
// of all API operations, which will silently handle this.
```

同じファイルの `RewriteContainerConfig` の注意書き ([`#L138-L151`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/state.go#L138-L151)) が、デーモンレス固有の制約を正直に書いている。

```go title="libpod/state.go"
	// PLEASE READ FULL DESCRIPTION BEFORE USING.
	// Rewrite a container's configuration.
	// This function breaks libpod's normal prohibition on a read-only
	// configuration, and as such should be used sparingly.
	// Other running Libpod instances generally WILL NOT pick up changes
	// until they are restarted - meaning we can have two Libpod instances
	// running concurrently, which have different configs for the same
	// container. This is not a good thing, and unavoidable given the
	// fundamental architecture of Podman - which are all good reasons to
	// not use this unless absolutely necessary.
```

Config は読み取り専用、State は毎回同期する、という二分法が土台にある。

### 接続オプション: WAL は使わない

[`libpod/sqlite_state.go#L23-L53`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state.go#L23-L53)。

```go title="libpod/sqlite_state.go"
const schemaVersion = 1
/* ... */
const (
	// Name of the actual database file
	sqliteDbFilename = "db.sql"
	// Deal with timezone automatically.
	sqliteOptionLocation = "_loc=auto"
	// Force an fsync after each transaction (https://www.sqlite.org/pragma.html#pragma_synchronous).
	sqliteOptionSynchronous = "&_sync=FULL"
	// Allow foreign keys (https://www.sqlite.org/pragma.html#pragma_foreign_keys).
	sqliteOptionForeignKeys = "&_foreign_keys=1"
	// Make sure that transactions happen exclusively.
	sqliteOptionTXLock = "&_txlock=exclusive"
	// Enforce case sensitivity for LIKE
	sqliteOptionCaseSensitiveLike = "&_cslike=TRUE"
```

busy timeout は [`#L56-L80`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state.go#L56-L80) の `NewSqliteState` で足す。

```go title="libpod/sqlite_state.go"
	// Make sure busy timeout is set to high value to keep retrying when the db is locked.
	// Timeout is in ms, so set it to 100s to have enough time to retry the operations.
	// Some users might want to experiment with different timeout values (#23236)
	// DO NOT DOCUMENT or recommend PODMAN_SQLITE_BUSY_TIMEOUT outside of testing.
	busyTimeout := "100000"
	if env, ok := os.LookupEnv("PODMAN_SQLITE_BUSY_TIMEOUT"); ok {
		logrus.Debugf("PODMAN_SQLITE_BUSY_TIMEOUT is set to %s", env)
		busyTimeout = env
	}
	sqliteOptionBusyTimeout := "&_busy_timeout=" + busyTimeout

	conn, err := sql.Open("sqlite3", dbPath+sqliteOptions+sqliteOptionBusyTimeout)
```

`_journal_mode` は指定していない。go-sqlite3 は DSN で指定しない限り PRAGMA を発行しないので、journal mode は SQLite の既定 (rollback journal) のままで、**WAL は使っていない**。`_txlock=exclusive` は `BEGIN EXCLUSIVE` を意味し、書き込みは完全に直列化され、読み手も排他トランザクション中は待たされる。

### テーブル設計

[`libpod/sqlite_state_internal.go#L124-L136`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state_internal.go#L124-L136) と [`#L143-L163`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state_internal.go#L143-L163)。

```sql title="libpod/sqlite_state_internal.go"
        CREATE TABLE IF NOT EXISTS DBConfig(
                ID            INTEGER PRIMARY KEY NOT NULL,
                SchemaVersion INTEGER NOT NULL,
                OS            TEXT    NOT NULL,
                StaticDir     TEXT    NOT NULL,
                TmpDir        TEXT    NOT NULL,
                GraphRoot     TEXT    NOT NULL,
                RunRoot       TEXT    NOT NULL,
                GraphDriver   TEXT    NOT NULL,
                VolumeDir     TEXT    NOT NULL,
                CHECK (ID IN (1))
        );
```

```sql title="libpod/sqlite_state_internal.go"
        CREATE TABLE IF NOT EXISTS ContainerConfig(
                ID              TEXT    PRIMARY KEY NOT NULL,
                Name            TEXT    UNIQUE NOT NULL,
                PodID           TEXT,
                JSON            TEXT    NOT NULL,
                FOREIGN KEY (ID)    REFERENCES IDNamespace(ID)    DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (ID)    REFERENCES ContainerState(ID) DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (PodID) REFERENCES PodConfig(ID)
        );

        CREATE TABLE IF NOT EXISTS ContainerState(
                ID       TEXT    PRIMARY KEY NOT NULL,
                State    INTEGER NOT NULL,
                ExitCode INTEGER,
                JSON     TEXT    NOT NULL,
                FOREIGN KEY (ID) REFERENCES ContainerConfig(ID) DEFERRABLE INITIALLY DEFERRED,
                CHECK (ExitCode BETWEEN -1 AND 255)
        );
```

`DBConfig` は `CHECK (ID IN (1))` で 1 行に制限される。`ContainerConfig` と `ContainerState` は互いに外部キーを持ち、`DEFERRABLE INITIALLY DEFERRED` なので同じトランザクション内で両方を INSERT できる。`State` と `ExitCode` は JSON の中にもあるが、フィルタ用に列にも複製されている。`IDNamespace` は container と pod の ID がグローバルに一意であることを外部キーで保証するためのテーブルだ。

読み書きは JSON をそのまま出し入れする ([`libpod/sqlite_state.go#L690-L719`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state.go#L690-L719))。

```go title="libpod/sqlite_state.go"
	row := s.conn.QueryRow("SELECT JSON FROM ContainerState WHERE ID=?;", ctr.ID())

	var rawJSON string
	if err := row.Scan(&rawJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Container was removed
			ctr.valid = false
			return fmt.Errorf("no container with ID %s found in database: %w", ctr.ID(), define.ErrNoSuchCtr)
		}
	}

	newState := new(ContainerState)
	if err := json.Unmarshal([]byte(rawJSON), newState); err != nil {
		return fmt.Errorf("unmarshalling container %s state JSON: %w", ctr.ID(), err)
	}

	ctr.state = newState
```

スキーマ移行は [`sqlite_state_internal.go#L104-L117`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state_internal.go#L104-L117) に骨組みだけあり、上位バージョンのスキーマは拒否、下位は「ここで 1 版ずつ移行する」というコメントの下に何も無い。v6.1.0 でもバージョン 1 のままだ。

### DB から取り出したあとに実体を結びつける

[`sqlite_state_internal.go#L275-L285`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state_internal.go#L275-L285)。

```go title="libpod/sqlite_state_internal.go"
// Finalize a container that was pulled out of the database.
func finalizeCtrSqlite(ctr *Container) error {
	// Get the lock
	lock, err := ctr.runtime.lockManager.RetrieveLock(ctr.config.LockID)
	if err != nil {
		return fmt.Errorf("retrieving lock for container %s: %w", ctr.ID(), err)
	}
	ctr.lock = lock
```

JSON の中にある `LockID` から、[共有メモリのロック](../shm-lock-manager/) を引き当てる。DB はロックの「番号」だけを持ち、ロックの実体は別の場所にある。

### 設定と DB の不一致を拒否する

[`libpod/sqlite_state.go#L304-L471`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state.go#L304-L471) の `ValidateDBConfig`。

```go title="libpod/sqlite_state.go"
	// Ignoring prevents a race condition where multiple Podman processes
	// might try to initialize the database at the same time.
	const createRow = `
        INSERT OR IGNORE INTO DBconfig VALUES (
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?
        );`
	/* ... */
	// We have to do this in a transaction to ensure mutual exclusion.
	// Otherwise we have a race - multiple processes can be checking the
	// row's existence simultaneously, both try to create it, second one to
	// get the transaction lock gets an error.
```

行が無ければ現在の設定で作り、あれば `checkField` で比べる。パスは symlink を許容し (`/home` が `/var/home` へのリンクである OSTree 系のため)、DB 側が空文字なら既定値と比べる (原因不明で空になる事例があったため)。呼び出し側 [`libpod/runtime.go#L409-L449`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L409-L449) では、`podman system reset` の最中だけ不一致を警告に落とす。そうしないと、パスを変えたあとに reset すらできなくなる。

### 終了コードは独立テーブル

[`libpod/sqlite_state_internal.go#L190-L197`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state_internal.go#L190-L197)。

```sql title="libpod/sqlite_state_internal.go"
        CREATE TABLE IF NOT EXISTS ContainerExitCode(
                ID        TEXT    PRIMARY KEY NOT NULL,
                Timestamp INTEGER NOT NULL,
                ExitCode  INTEGER NOT NULL,
                CHECK (ExitCode BETWEEN -1 AND 255)
        );
```

外部キーが無いのは、コンテナの行が消えたあとも残すためだ。GC は [`libpod/container_internal.go#L2261-L2271`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L2261-L2271) で cleanup に相乗りする。

```go title="libpod/container_internal.go"
	// Prune the exit codes of other container during clean up.
	// Since Podman is no daemon, we have to clean them up somewhere.
	// Cleanup seems like a good place as it's not performance
	// critical.
	if err := c.runtime.state.PruneContainerExitCodes(); err != nil {
```

`PruneContainerExitCodes` ([`libpod/sqlite_state.go#L1047-L1076`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state.go#L1047-L1076)) は、5 分より古く、かつコンテナがもう存在しないものだけを消す。

### 再起動の検出と移行

再起動は tmpfs 上の `alive` ファイルの有無で検出する ([`libpod/runtime.go#L577-L600`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L577-L600))。

```go title="libpod/runtime.go"
	// We now need to see if the system has restarted
	// We check for the presence of a file in our tmp directory to verify this
	// This check must be locked to prevent races
	runtimeAliveFile := filepath.Join(runtime.config.Engine.TmpDir, "alive")
	aliveLock, err := runtime.getRuntimeAliveLock()
	if err != nil {
		return fmt.Errorf("acquiring runtime init lock: %w", err)
	}
	// Acquire the lock and hold it until we return
	// This ensures that no two processes will be in runtime.refresh at once
	aliveLock.Lock()
```

無ければ `refresh` ([`#L892-L901`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L892-L901)) に入り、まず BoltDB があれば SQLite に移行し、次に `state.Refresh()` ([`libpod/sqlite_state.go#L119-L135`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/sqlite_state.go#L119-L135)) で全コンテナの状態をリセットして、終了コードと exec セッションを全削除する。

```go title="libpod/runtime.go"
func (r *Runtime) refresh(ctx context.Context, alivePath string) error {
	logrus.Debugf("Podman detected system restart - performing state refresh")

	// Only error that can be returned is no BoltDB present.
	// In that case, no need to do anything.
	if err := r.checkCanMigrate(); err == nil {
		if err := r.migrateDB(); err != nil {
			logrus.Errorf("Automatic migration from BoltDB to SQLite failed: %v", err)
		}
	}
```

移行本体 ([`libpod/runtime_migrate.go#L133-L229`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_migrate.go#L133-L229)) は volume → pod → container の順で、container は依存グラフの順に入れ、旧 DB は `-old` を付けてリネームする。BoltDB のコードは `State` インターフェースを実装しない読み取り専用の最小実装として残っている。コミット abf885dfcc (2026-04-22) はその判断を "the only sane options are a separate binary that exclusively performs migrations, or re-adding BoltDB code - in a very minimal way ... we should never touch these bits again until they get removed in 7" と説明している。

## なぜそうなっているか

- **排他トランザクションと busy timeout は失敗から学んだ形。** コミット 0fbc325156 (2023-03-21) "sqlite: set connection attributes on open": "The symptoms in #17859 indicate that setting the PRAGMAs in individual EXECs outside of a transaction can lead to concurrency issues and failures when the DB is locked ... Further make transactions exclusive". コミット 5b3d82f9bc (2023-11-29) "sqlite: set busy timeout to 100s": "Only one process can write to the sqlite db at the same time, if another process tries to use it at that time it fails and a database is locked error is returned. If this happens sqlite should keep retrying until it can write ... I think we strongly need to consider some form of parallel stress testing to catch bugs like this." WAL を選ばなかった理由は書かれていないが、`database is locked` を経験したあとの保守的な選択と読める (推測)。
- **終了コードを DB に入れたのは競合のため。** コミット 30e7cbccc1 (2022-06-10) "libpod: fix wait and exit-code logic": "If a container is configured for autoremoval (e.g., via `run --rm`), the 'run' process competes with the 'cleanup' process running in the background. The window of the race condition was sufficiently large that the 'cleanup' process has already removed the container and storage before the 'run' process could read the exit code and hence waited indefinitely." BoltDB 時代のコメント ([`libpod/boltdb_state.go#L58-L68`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/boltdb_state.go#L58-L68)) も同じ issue #14559 を引いている。
- **設定不一致で止めるのは、黙って壊れるよりましだから。** graph root や graph driver が変わると、DB が指すレイヤーと実際のストレージが食い違う。デーモンなら起動時に 1 回検証すればよいが、Podman は毎プロセスで検証するしかない。ただし RELEASE_NOTES には「存在しないパス」「空文字」「symlink」で誤検出した修正が繰り返し載っており、厳格さの代償も見える。
- **BoltDB から SQLite への移行は 5 つのメジャーバージョンをかけた。** 4.5 で実験導入、4.8 で既定化、5.0 で新規作成不可、5.8 で自動移行、6.0 で削除。[`docs/source/markdown/podman-system-migrate.1.md#L28-L36`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-system-migrate.1.md#L28-L36) は "Migrating as part of a reboot is generally preferred as there is less potential for race conditions caused by other Podman processes running at the same time" と、再起動直後を選ぶ理由を書いている。

## どう活かすか

- 常駐プロセスが無い (あるいは信用できない) なら、状態はプロセスの外の ACID ストアに置き、各操作の入口で「読む → 実体と照合 → 書く」を徹底する。メモリ上の状態を最新だと仮定しない。
- スキーマは「インデックス列 + JSON」で始める。検索と制約に要るキーだけを列にし、残りは構造体の JSON にする。構造体の進化が DB マイグレーションを要求しなくなる。頻繁に条件検索するフィールドは列に昇格させる。
- 設定と DB の整合性を DB 自身に記録して起動時に検証する。ただし「存在しないパス」「symlink」「空文字」のような現実の例外を、経験に応じて緩める余地を残す。
- 同時実行は「排他トランザクション + 十分長い busy timeout」から始める。WAL や細かいロック粒度は、それで足りなくなってから。
- 削除後も参照されうるデータは独立テーブルに持ち、GC は既存の非クリティカルな処理に相乗りさせて、時間ベースで期限切れにする。
- 旧フォーマットからの移行は「他に誰も触っていないと保証できる瞬間」に自動で行い、手動経路も残し、旧データはリネームして保全する。
- 取り込むべきでない条件: 高スループットの並列書き込みが要るなら、排他トランザクション + `FULL` sync は遅い。Podman は「1 操作 = 数回の小さな更新」だから成立している。複数ホストやネットワークファイルシステム越しの共有には SQLite の排他は使えない。
