---
title: "CDC テーブルを「テープ」にして、変更を適用も巻き戻しもできるようにする"
description: "PRAGMA を 1 つ立てると、すべての書き込みが turso_cdc という普通のテーブルに記録される。変更前と変更後の両方を持たせておくと、そのテーブルは「前にも後ろにも再生できるテープ」になる。適用は change_id の昇順、巻き戻しは降順で、各変更の insert と delete を入れ替える。同期エンジンはこの上に載っていて、ローカルの変更を巻き戻してリモートを適用し、また巻き戻した分を掛け直す。"
group: "同期とレプリケーション"
sidebar:
  order: 52
---

## 何を学んだか

MySQL のバイナリログは、レプリケーションのために **サーバが専用のファイルに書く**。ツールで読むには専用のプロトコルか `mysqlbinlog` が要る。

Turso の CDC は違う。**変更が普通のテーブルに入る。**

```sql
PRAGMA capture_data_changes_conn = 'full';
```

これを立てると、以降の `INSERT` / `UPDATE` / `DELETE` が `turso_cdc` テーブルに記録される。**普通の `SELECT` で読める。トランザクションも効く。**

そしてこのテーブルが、同期エンジンの土台になっている。

```rust title="sync/engine/src/database_tape.rs"
/// Simple wrapper over [turso::Database] which extends its intereface with few methods
/// to collect changes made to the database and apply/revert arbitrary changes to the database
pub struct DatabaseTape {
```

[`sync/engine/src/database_tape.rs#L20-L22`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_tape.rs#L20-L22)。

**「テープ」という名前が的確で、前にも後ろにも再生できる。**

## ソースコードのどこか

### 記録するものを 4 段階から選ぶ

```rust title="core/cdc.rs"
pub enum CaptureDataChangesMode {
    Id,
    Before,
    After,
    Full,
}
```

[`core/cdc.rs#L14-L19`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/cdc.rs#L14-L19)。

- `Id` — 「この行が変わった」だけ
- `Before` — 変更前の値も
- `After` — 変更後の値も
- `Full` — 両方

**この選択が、後で何ができるかを決める。**

```rust title="sync/engine/src/types.rs"
            DatabaseChangeType::Update => DatabaseTapeRowChangeType::Update {
                before: parse_bin_record(self.before.ok_or_else(|| {
                    Error::DatabaseTapeError("cdc_mode must be set to 'full'".to_string())
                })?)?,
```

[`sync/engine/src/types.rs#L333-L339`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/types.rs)。

**足りないモードで記録されていると、エラーメッセージが「`cdc_mode` を `full` にしろ」と直接言う。** 「値が NULL です」ではなく、**設定をどう直せばいいか**を答えている。

### テーブルの形

```rust title="core/cdc.rs"
pub enum CdcVersion {
    /// 8 columns: change_id, change_time, change_type, table_name, id, before, after, updates
    V1 = 1,
    /// 9 columns (adds change_txn_id + COMMIT records with change_type=2)
    V2 = 2,
}
```

[`core/cdc.rs#L22-L30`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/cdc.rs#L22-L30)。

**`change_id` が単調増加する。** これが「テープの位置」になる。

V2 で足されたのが 2 つ。**トランザクション ID と、COMMIT レコード。** これがないと、**どこまでが 1 つのトランザクションか**が分からない。同期先で「途中まで適用された状態」を作ってしまう。

バージョンの比較が順序で書けるようにしてある。

```rust title="core/cdc.rs"
/// CDC schema version with integer ordering for feature checks.
/// Higher versions are supersets of lower versions.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
```

```rust title="core/cdc.rs"
    /// Whether this version emits COMMIT records (change_type=2)
    pub fn has_commit_record(self) -> bool {
        self >= CdcVersion::V2
    }
```

[`core/cdc.rs#L21-L38`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/cdc.rs#L21-L38)。

**「上のバージョンは下の上位集合」と宣言したうえで、機能の判定を `>=` で書く。** バージョンごとの機能表を持たずに済む。

### 巻き戻しは、変更を裏返す

```rust title="sync/engine/src/types.rs"
    /// Converts [DatabaseChange] into the operation which effect will be the revert of the change
    pub fn into_revert(self) -> Result<DatabaseTapeRowChange> {
        let tape_change = match self.change_type {
            DatabaseChangeType::Delete => DatabaseTapeRowChangeType::Insert {
                after: parse_bin_record(self.before...)?,
            },
            DatabaseChangeType::Update => DatabaseTapeRowChangeType::Update {
                before: parse_bin_record(self.after...)?,
                after: parse_bin_record(self.before...)?,
                updates: None,
            },
            DatabaseChangeType::Insert => DatabaseTapeRowChangeType::Delete {
                before: parse_bin_record(self.after...)?,
                key: None,
            },
```

[`sync/engine/src/types.rs#L367-L395`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/types.rs)。

**削除を挿入に、挿入を削除に、更新は `before` と `after` を入れ替える。**

`Full` モードで記録していれば、**すべての変更が可逆**になる。これが「テープを巻き戻せる」の中身だ。

`updates: None` になっているのが細かい。順方向の更新は「どの列が変わったか」を持てるが、**逆方向では全列を書き戻す**。差分の情報は、裏返すと使えなくなる。

### 適用と巻き戻しは、クエリの向きだけが違う

```rust title="sync/engine/src/database_tape.rs"
pub enum DatabaseChangesIteratorMode {
    Apply,
    Revert,
}

impl DatabaseChangesIteratorMode {
    pub fn query(&self, table_name: &str, limit: usize, bounded_above: bool) -> String {
        let (operation, order) = match self {
            DatabaseChangesIteratorMode::Apply => (">=", "ASC"),
            DatabaseChangesIteratorMode::Revert => ("<=", "DESC"),
        };
        ...
        format!(
            "SELECT * FROM {table_name} WHERE change_id {operation} ?{upper_bound} ORDER BY change_id {order} LIMIT {limit}",
        )
    }
```

[`sync/engine/src/database_tape.rs#L410-L433`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_tape.rs#L410-L433)。

**差は `>=` / `<=` と `ASC` / `DESC` だけ。** 巻き戻し専用のコードがない。

**変更が普通のテーブルにあるからこそ、こう書ける。** 専用のログ形式だったら、逆順に読む機能を自分で実装することになる。

`LIMIT` が入っているのも重要で、**テープを一度に全部読まない**。100 件ずつ処理する。

### 上限を指定できる理由

```rust title="sync/engine/src/database_tape.rs"
        // `change_id < ?` (bound param 2) restricts the scan to change ids the
        // caller has deemed safe to consume — used by the sync push loop to stop
        // at `sequence_watermark_experimental` so it never reads a change id that
        // a concurrent MVCC transaction may still commit below the current max.
```

[`sync/engine/src/database_tape.rs#L421-L424`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_tape.rs#L421-L424)。

**`change_id` の最大値まで読んではいけない。**

[MVCC](../mvcc/) では、トランザクションが並行に走る。`change_id` は採番の時点で決まるので、**「最大値は 100 だが、95 番を持つトランザクションがまだコミットしていない」** が起きる。

そこまで読んで送ってしまうと、**95 番が後からコミットされたときに、それを取りこぼす。**

だから「ここまでは安全」という水位を別に持って、そこで止める。**単調増加する ID があっても、「今の最大値まで読める」とは限らない。** 並行コミットがある系では常に起きる問題になる。

### 同期はコルーチンで書かれている

```rust title="sync/engine/src/database_tape.rs"
pub(crate) async fn run_stmt_once<'a, Ctx>(
    coro: &'_ Coro<Ctx>,
    stmt: &'a mut turso_core::Statement,
) -> Result<Option<&'a turso_core::Row>> {
    loop {
        match stmt.step()? {
            StepResult::IO | StepResult::Yield | StepResult::Sleep { .. } => {
                coro.yield_(SyncEngineIoResult::IO).await?;
            }
            StepResult::Done => {
                return Ok(None);
            }
```

[`sync/engine/src/database_tape.rs#L71-L93`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_tape.rs#L71-L93)。

**同期エンジンは `async` を使っている。** [エンジン本体が `async` を使わない](../io-result/) のと対照的だ。

`Coro` は自前のコルーチン型で、`StepResult::IO` を受けたら `coro.yield_()` する。**エンジンの協調的 yield を、`async` の `.await` に変換している。**

なぜこちらは `async` でいいのか。**同期エンジンは別のクレートで、ネットワーク I/O も扱うから**だ。エンジン本体と違って、実行モデルを選ぶ自由がある。

そして **境界で変換する**。[Rust バインディングが `Future` を実装している](../architecture/) のと同じ形になる。

`run_stmt_once` / `run_stmt_expect_one_row` / `run_stmt_ignore_rows` という 3 つのヘルパがあるのも実務的で、**「1 行だけのはず」「行は要らない」を型で表している。**

```rust title="sync/engine/src/database_tape.rs"
    let None = run_stmt_once(coro, stmt).await? else {
        return Err(Error::DatabaseTapeError("single row expected".to_string()));
    };
```

[`sync/engine/src/database_tape.rs#L146-L148`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_tape.rs#L146-L148)。

**「1 行のはず」は、2 行目がないことまで確かめる。** 1 行取って帰ると、想定外のデータに気付けない。

### CDC の書き込みはバイトコードとして生成される

```rust title="core/cdc.rs"
//! These types describe the `PRAGMA capture_data_changes_conn`
//! setting on a connection: which columns get captured, which table the
//! changes are written to, and which CDC schema version is in use. The
//! bytecode that writes the change records lives in `translate::emitter`.
```

[`core/cdc.rs#L1-L6`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/cdc.rs#L1-L6)。

```rust title="core/translate/emitter/mod.rs"
    let turso_cdc_registers = program.alloc_registers(8);
```

[`core/translate/emitter/mod.rs#L1407`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/emitter/mod.rs#L1407)。

**CDC のレコードを書くのは、実行時のフックではなく、コンパイル時に生成されたバイトコード。**

`INSERT` 文をコンパイルするとき、**CDC が有効ならレコードを書く命令を一緒に生成する。** 無効なら 1 命令も生成されない。

**トリガのような実行時のフックにしていない。** 利点が 3 つある。

1. **無効なときのコストがゼロ。** 命令が存在しない
2. **トランザクションの原子性が自動的に保たれる。** CDC の書き込みも同じトランザクションの中の命令になる
3. **ロールバックも自動。** [savepoint](../vdbe/) の巻き戻しにそのまま乗る

「変更を記録する」を **データの流れの外側 (フック) ではなく内側 (命令列) に置いた**結果になる。

## なぜそうなっているか

- **CDC の出力先を普通のテーブルにしたのは、既存の仕組みが全部使えるから。** `SELECT` で読め、トランザクションが効き、`ORDER BY` で順序が付き、`LIMIT` で区切れる。専用のログ形式なら全部自分で作ることになる。
- **記録の粒度を 4 段階にしたのは、用途によって必要な情報が違うから。** 「変わったことだけ知りたい」なら `Id` で十分で、テーブルが小さくなる。
- **足りない場合のエラーで設定名を挙げるのは、直し方が分かるから。** 「値が NULL」より「`cdc_mode` を `full` にせよ」の方が短い。
- **`change_id` を単調増加にしたのは、テープの位置になるから。** 「どこまで読んだか」を 1 個の整数で表せる。
- **COMMIT レコードを足したのは、トランザクションの境界が要るから。** 境界がないと、同期先に中途半端な状態を作る。
- **バージョンを順序で比較できるようにしたのは、機能表を持たずに済むから。** 「上位集合である」と宣言すれば、判定が `>=` 1 つになる。
- **巻き戻しを「変更を裏返す」で実装したのは、`Full` モードなら情報が揃っているから。** 変更前と変更後の両方があれば、逆操作は機械的に作れる。
- **適用と巻き戻しの差をクエリの向きだけにしたのは、テーブルだから。** `ORDER BY DESC` と書けば逆順に読める。
- **読む上限を別に持つのは、並行コミットがあるから。** 「今の最大 ID」まで読むと、まだコミットされていない小さい ID を取りこぼす。
- **同期エンジンが `async` を使うのは、別のクレートでネットワークも扱うから。** エンジン本体と違って、実行モデルを選べる。
- **CDC の書き込みをバイトコードにしたのは、無効時のコストをゼロにし、トランザクションに自動的に乗せるため。** 実行時のフックにすると、両方を自分で保証することになる。

## どう活かすか

- **変更履歴の保存先を、専用形式ではなく既存のデータストアにできないか考える。** 読み出し、順序付け、区切り、トランザクション。全部が無料で付いてくる。
- **記録の粒度を選べるようにする。** 「全部記録する」しかないと、使わない情報のために容量を払うことになる。
- **粒度が足りないときのエラーは、必要な設定値を挙げる。** 「値がない」ではなく「この設定をこうしろ」と書く。
- **履歴には単調増加する位置を持たせる。** 「どこまで処理したか」が 1 個の値で表せると、再開が単純になる。
- **トランザクションの境界を、履歴の中に明示的に記録する。** 変更の列だけでは、どこまでが不可分だったかが失われる。
- **バージョンが上位集合の関係にあるなら、それを宣言して順序比較で判定する。** 機能ごとの表を持つと、追加のたびに更新が要る。
- **逆操作を可能にしたいなら、変更前の状態も記録する。** 逆操作は、情報が揃っていれば機械的に作れる。
- **順方向と逆方向の処理を、同じコードの引数違いにする。** 逆方向専用のコードを書くと、片方だけ直す事故が起きる。
- **「今の最大値まで読める」を仮定しない。** 並行にコミットする系では、未確定の小さい ID が後から現れる。安全な水位を別に持つ。
- **副作用の記録は、フックではなく生成される処理の中に埋める。** 無効時のコストがゼロになり、トランザクションの原子性とロールバックが自動的に付いてくる。
