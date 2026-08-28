---
title: "`Schema` はメモリに住み、cookie 1 つで作り直される"
description: "スキーマは同時に 3 箇所に存在する。ディスクの `sqlite_schema` テーブル、`Database` が持つプロセス内共有のスナップショット、そして各 `Connection` が握っているスナップショット。この 3 つを合わせる仕掛けが、ページ 1 のヘッダにある 32 bit の schema cookie だ。そして再構築の手段は SQL 自身なので、循環を切るためのハックがコードに残っている。"
group: "SQL からバイトコードへ"
sidebar:
  order: 8
---

## この層の責務

`SELECT * FROM users` をコンパイルするには、`users` というテーブルがあること、その列が何か、どの索引が使えるかを知っている必要がある。この情報が `Schema` だ。

サーバ型の RDB なら、スキーマの正本は 1 つのプロセスのメモリにある。DDL を実行したスレッドがそれを書き換え、他のスレッドは次にそれを読んだときに新しい定義を見る。

Turso では、スキーマが**同時に 3 箇所に存在する**。

| 場所           | 型                                            | 更新するのは                                |
| -------------- | --------------------------------------------- | ------------------------------------------- |
| ディスク       | `sqlite_schema` テーブル + ページ 1 の cookie | DDL を実行した誰か (別プロセスかもしれない) |
| プロセス内共有 | `Database.schema: Arc<Mutex<Arc<Schema>>>`    | DDL をコミットした接続                      |
| 接続ローカル   | `Connection.schema: RwLock<Arc<Schema>>`      | その接続自身                                |

この 3 つを合わせる仕掛けが、このページの主題だ。

## 主要な型とその関係

### `Schema` は不変のスナップショット

```rust title="core/schema.rs:762-810 (抜粋)"
pub struct Schema {
    pub tables: HashMap<String, Arc<Table>>,
    pub materialized_view_names: HashSet<String>,
    pub incremental_views: HashMap<String, Arc<Mutex<IncrementalView>>>,
    pub views: ViewsMap,
    pub triggers: HashMap<String, VecDeque<Arc<Trigger>>>,
    pub indexes: HashMap<String, VecDeque<Arc<Index>>>,
    pub has_indexes: HashSet<String>,
    pub schema_version: u32,
    pub analyze_stats: AnalyzeStats,
    pub table_to_materialized_views: HashMap<String, Vec<String>>,
    pub incompatible_views: HashSet<String>,
    pub broken_views: HashSet<String>,
    pub dropped_root_pages: HashSet<i64>,
    pub type_registry: HashMap<String, Arc<TypeDef>>,
    pub generated_columns_enabled: bool,
    pub sequences: HashMap<String, Arc<Sequence>>,
}
```

名前から中身を引く `HashMap` が並んでいる。`schema_version: u32` がこのスナップショットの版番号だ。

[状態の地図のページ](../shared-state-map/) で見たとおり、`Schema` は `Arc` に包まれて共有され、**書き換えではなく差し替え**で更新される。だから翻訳中に `Arc<Schema>` を clone して持ち歩けば、その間に他が更新しても影響を受けない。

### `schema_version` の実体はページ 1 の cookie

`schema_version` はメモリ上の値だが、その出どころはディスクにある。SQLite のファイル形式では、ページ 1 のヘッダのオフセット 40 に 4 バイトの `schema cookie` がある ([オンディスク形式のページ](../ondisk-format/))。DDL のたびにこれが増える。

読み出しはヘッダを 1 個読むだけだ。

```rust title="core/connection.rs:1211-1214 (抜粋)"
// first, quickly read schema_version from the root page in order to check if schema changed
pager.begin_read_tx()?;
let on_disk_schema_version = pager
    .io
    .block(|| pager.with_header(|header| header.schema_cookie));
```

**「変わったか」を知るのはページ 1 枚、「何に変わったか」を知るには `sqlite_schema` の全走査**。この非対称性が、以降の設計を決めている。

### 3 方向の同期関数

3 箇所の間を動かす関数がそれぞれ用意されている。

| 関数                        | 方向            | いつ呼ばれるか              |
| --------------------------- | --------------- | --------------------------- |
| `maybe_update_schema()`     | 共有 → 接続     | 毎回の `compile_cmd` の冒頭 |
| `reparse_schema()`          | ディスク → 接続 | cookie が食い違ったとき     |
| `publish_schema_if_newer()` | 接続 → 共有     | DDL のコミット後            |

**`maybe_update_schema` はディスクを読まない。** これが軽さの理由だ。

```rust title="core/connection.rs:1993-2000 (抜粋)"
pub fn maybe_update_schema(&self) {
    if self.schema_reparse_in_progress() {
        return;
    }
    let current_schema = self.schema.read().clone();
    let schema = self.db.schema.lock();
    // ...
    if self.has_no_open_transaction_state()
        && (current_schema.schema_version != schema.schema_version
            || self.has_mvcc_schema_snapshot_changed_with_same_version(&current_schema, &schema))
    {
```

比較するのは**メモリ上の 2 つの `schema_version`** だけ。同じプロセスの別の接続が DDL をコミットしていれば、共有側の版が上がっているので取り込む。**別プロセスの DDL はここでは見えない。**

そちらは `Statement::step()` の `SchemaUpdated` リトライか、`compile_cmd` の `should_retry_cross_process_schema_lookup` が拾う ([クエリの一生のページ](../query-lifecycle/))。

## 処理の流れ (コードを追う)

### 取り込むときに、まず「開いているトランザクションがないこと」を確認する

```rust title="core/connection.rs:2022-2026"
fn has_no_open_transaction_state(&self) -> bool {
    matches!(self.get_tx_state(), TransactionState::None)
        && self.get_mv_tx().is_none()
        && self.next_attached_mv_tx().is_none()
}
```

**トランザクションの途中でスキーマを差し替えてはいけない。** `BEGIN; SELECT ...; SELECT ...; COMMIT;` の 2 つ目の `SELECT` が 1 つ目と違うスキーマを見たら、トランザクションの一貫性が崩れる。

取り込みが成立したら、プリペアドステートメントを無効化する。

```rust title="core/connection.rs:2017-2018 (抜粋)"
*self.schema.write() = adopted;
self.bump_prepare_context_generation();
```

`prepare_context_generation` を上げると、既存の `Program` が持っている `prepare_context` と一致しなくなる。次にその `Statement` を `step()` したとき、`matches_connection` が false になって `reprepare()` が走る。**世代番号 1 個で、その接続の全プリペアドステートメントを無効化している。**

### 再構築の中身は `SELECT * FROM sqlite_schema`

cookie が食い違ったら、スキーマを 1 から作り直す。その手段が SQL だ。

```rust title="core/connection.rs:1450"
let stmt = self.prepare("SELECT * FROM sqlite_schema")?;
```

**スキーマを読むために、スキーマを必要とするコンパイラを使う。** ここに循環がある。`sqlite_schema` 自身の定義は組み込みなので読めるのだが、問題は別のところにあった。

```rust title="core/connection.rs:1440-1444"
// TODO: this is hack to avoid a cyclical problem with schema reprepare
// The problem here is that we prepare a statement here, but when the statement tries
// to execute it, it first checks the schema cookie to see if it needs to reprepare the statement.
// But in this occasion it will always reprepare, and we get an error. So we trick the statement by swapping our schema
// with a new clean schema that has the same header cookie.
```

これから作る新しいスキーマは cookie が新しい。だが接続が今持っているスキーマは cookie が古い。この状態で `SELECT * FROM sqlite_schema` を実行すると、**その文自身が「スキーマが古い」と判断して再コンパイルを要求し、無限に回る。**

回避策は、**空だが cookie だけ新しいスキーマを先に差し込む**ことだった。

```rust title="core/connection.rs:1415-1420 (抜粋)"
let mut fresh = Schema::with_options(
    self.experimental_custom_types_enabled(),
    self.db.dialect().as_ref(),
)?;
fresh.generated_columns_enabled = self.db.experimental_generated_columns_enabled();
fresh.schema_version = cookie;
```

```rust title="core/connection.rs:1445-1450"
self.with_schema_mut(|schema| {
    *schema = fresh.try_clone()?;
    Ok::<_, crate::alloc::TryReserveError>(())
})??;

let stmt = self.prepare("SELECT * FROM sqlite_schema")?;
```

**「中身は空、版だけ最新」という一時的な嘘のスキーマ**を接続に置いて、その状態で `sqlite_schema` を読む。読み終わったら本物と差し替える。コメントが `TODO` と `hack` を両方使っているとおり、きれいな解ではない。

DDL を実行するために自分自身の SQL 実行を使う構造は、走査中に見えるスキーマを慎重に扱う必要を生む。ブートストラップの循環をどこかで切らなければならず、ここでは「版だけ合わせた空のスキーマ」で切っている。

### 再構築は 4 フェーズの状態機械

読み込みは 1 回の走査では終わらない。

```rust title="core/connection.rs:203-240 (抜粋)"
enum ReparsePhase {
    /// Scanning `SELECT * FROM sqlite_schema` into `fresh`.
    ParseSchema { parse: Box<crate::util::ParseSchemaRowsState> },
    /// Recovering sequence descriptors from each `__turso_internal_seq_*`
    /// backing table via SQL (or grafting the VACUUM-preserved map).
    PopulateSequences { /* 7 フィールド */ },
    /// Loading custom type definitions from the internal types table.
    LoadTypes { stmt: Box<Statement>, type_rows: Vec<String> },
    /// Best-effort ANALYZE-stats refresh before finalizing.
    RefreshStats { stats: crate::stats::RefreshAnalyzeStatsState },
}
```

**4 フェーズのうち 3 つが、それぞれ別の SQL を実行する。** `sqlite_schema` の走査、シーケンスの裏テーブルの読み取り、カスタム型の定義の読み取り。どれもディスクに触るので I/O 待ちが発生し、状態機械になる。

`PopulateSequences` のフィールドが 7 個あるのは、**1 つのシーケンスにつき 2 本の `SELECT` を投げる**からだ。

```rust title="core/connection.rs:212-232 (抜粋)"
PopulateSequences {
    /// `(backing_table_name, seq_name)` worklist; `None` until lazily computed.
    pending: Option<crate::alloc::Vec<(String, String)>>,
    /// Index of the backing table currently being read.
    idx: usize,
    /// In-flight descriptor `SELECT`, created lazily per backing table.
    stmt: Option<Box<Statement>>,
    /// Descriptor row `(start, inc, min, max, cycle)` captured from `stmt`.
    meta: Option<(i64, i64, i64, i64, bool)>,
    /// Sequence reconstructed from `meta`, retained while the watermark query yields IO.
    seq: Option<crate::schema::Sequence>,
    /// In-flight watermark `SELECT`, created after `seq` is known.
    watermark_stmt: Option<Box<Statement>>,
    /// Watermark row `(value, is_called)` captured from `watermark_stmt`.
    watermark_row: Option<(i64, bool)>,
}
```

「ワークリスト、今どこ、実行中の文、その結果、組み立て中の値、2 本目の文、その結果」。**`async fn` のローカル変数をそのまま構造体にした形**で、[状態機械のページ](../io-result-and-state-machine/) で見た流儀 B の典型例になっている。

### 組み込みのテーブルは再構築を生き延びない

`sqlite_schema` を読み直すと、そこに書かれていないものは消える。

```rust title="core/connection.rs:1422-1425 (抜粋)"
// Capture built-in table-valued functions (e.g. generate_series, json_each)
// before dropping the old schema. These are registered programmatically and
// don't survive re-parsing from sqlite_schema alone.
let tvfs: Vec<Arc<crate::vtab::VirtualTable>> = self.schema.read().tables.values()
```

`generate_series` や `json_each` はコードで登録されるので、`sqlite_schema` には行がない。**古いスキーマから救出して、新しいスキーマに移し替える。**

同じ理由で、`Schema::with_options` が組み込みカタログを毎回登録し直している。`pragma_*` や `sqlite_dbpage` は [SQLite 方言のモジュール](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/dialect/sqlite.rs) が持っていて、`Schema::with_options` から呼ばれる。

## 守られている不変条件

**トランザクション中はスキーマを差し替えない。** `has_no_open_transaction_state()` が全ての取り込み経路の前提条件になっている。

**スキーマを差し替えたら、必ず `prepare_context_generation` を上げる。** 上げ忘れると、古いスキーマ前提の `Program` が新しいルートページに対して走る。

**`Schema` の中身は差し替え後に書き換えない。** 共有された `Arc<Schema>` を持っている接続がいるかもしれない。変更は新しい `Schema` を作って `Arc` を差し替える。

**再パース中は再パースしない。** `SchemaReparseGuard` が張られ、`schema_reparse_in_progress()` が `maybe_update_schema` の入口で早期リターンする。再帰すると、上の「嘘のスキーマ」が二重に入れ替わって壊れる。

## つまずきどころ / 設計の含み

### MVCC は cookie を変えずにスキーマを変える

`maybe_update_schema` の条件が `schema_version` の比較だけでは足りない理由がある。

```rust title="core/connection.rs:2028-2037"
fn has_mvcc_schema_snapshot_changed_with_same_version(
    &self,
    current_schema: &Arc<Schema>,
    schema: &Arc<Schema>,
) -> bool {
    self.mvcc_enabled()
        && current_schema.schema_version == schema.schema_version
        && !Arc::ptr_eq(current_schema, schema)
}
```

**`Arc::ptr_eq` で「同じ版だが別のオブジェクト」を検出している。** MVCC のチェックポイントは、テーブルの実体を B-tree に書き出したときに**ルートページ番号を確定させる**。それまでは負の値のプレースホルダが入っている。

```rust title="core/connection.rs:1999-2002 (抜粋)"
// MVCC checkpoint can publish physical btree roots into the shared
// schema without changing SQLite's schema cookie. If this connection
// still has the older schema snapshot, prepared statements must be
// invalidated and recompiled with the published roots.
```

ルートページが変わるのは論理的なスキーマ変更ではないので、SQLite の cookie は上がらない。だがコンパイル結果には影響する — `OpenRead` 命令に埋め込むページ番号が変わるからだ。

結果として、**「SQLite 互換の版番号」と「Turso が実際に必要とする版番号」がずれる**。ずれた分をポインタ比較で埋めている。互換性の制約が新機能に課すコストの、分かりやすい実例になっている。

MVCC 側にはさらに `schema_generation` という別のカウンタもある。

```rust title="core/connection.rs:2047-2052 (抜粋)"
/// Begin-tx schema gate for MVCC. Returns the `MvStore::schema_generation` this connection's
/// prepared schema is valid as of, or `SchemaUpdated` if it is already stale (a passive
/// checkpoint republished physical roots without a cookie change). The returned generation is
/// re-checked inside `begin_tx`'s clock callback: a publish bumps `schema_generation` under the
/// same clock, so if one lands between here and the begin clock the generations differ and the
/// statement is forced to reprepare against the published roots.
```

**チェックすると決めた瞬間と、実際にトランザクションが始まる瞬間の間**にも publish が挟まりうるので、そこも塞いでいる。1 つの cookie で足りていたものが、cookie + ポインタ比較 + 世代番号の 3 段になっている。

### マルチプロセスではページキャッシュを捨ててから cookie を読む

```rust title="core/connection.rs:1195-1201"
if self.db.shared_wal_coordination()?.is_some() {
    // Cross-process schema changes can leave page 1 and sqlite_schema
    // pages cached from an earlier WAL snapshot. Drop the cache before
    // probing the cookie so reparsing observes the current committed view.
    pager.clear_page_cache(false);
    pager.set_schema_cookie(None);
}
```

**cookie を読む前にキャッシュを全部捨てる。** キャッシュされたページ 1 を読んでしまうと、古い cookie が返ってきて「変わっていない」と判断してしまう。

これはマルチプロセス有効時にだけ走る。**スキーマ変更のたびにページキャッシュが空になる**ので、コストは小さくない。単一プロセスならプロセス内共有のスキーマが正しいので、この経路は要らない。3 段目 ([状態の地図のページ](../shared-state-map/)) を持つコストがここにも出ている。

### 「読むための SQL」を実行すること自体が I/O を伴う

再パースの 4 フェーズが全部状態機械になっているのは、**スキーマの読み込みが普通のクエリ実行だから**だ。`sqlite_schema` は普通の B-tree テーブルで、走査すればページを読み、I/O 待ちが起きる。

つまり `maybe_update_schema` → `reparse_schema` の経路は、**「クエリをコンパイルしようとしたら、別のクエリを実行することになり、それが I/O で中断する」**という構造を持つ。`compile_cmd` から呼ばれる `maybe_update_schema` がブロッキング版 (`io.block`) を使っているのはそのためで、非ブロッキングが必要な経路には `reparse_schema_nonblock` が別に用意されている。

`_init` / `_init_nonblock`、`run_ignore_rows` / `run_ignore_rows_nonblock` と同じ対が、ここにも現れる。**エンジンのどの層にも「ブロックしてよい入口」と「してはいけない入口」が対で存在する**というのが、このコードベースの一貫した形になっている。
