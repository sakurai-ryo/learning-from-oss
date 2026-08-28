---
title: "MVCC は Pager の下ではなく、横に積まれている"
description: "MVCC を有効にしても B-tree は消えない。行のバージョンはスキップリストに置かれ、カーソルはスキップリストと B-tree の両方を同時に見て併合する。テーブル ID とルートページの対応は遅延して決まり、チェックポイントで実体化したときに初めて確定する。その publish がスキーマ cookie を動かさないので、無効化の仕掛けが別に要る。"
group: "並行性の層"
sidebar:
  order: 23
---

## この層の責務

`BEGIN CONCURRENT` の意味論と、undo ではなく論理ログを書くという設計判断は [MVCC のページ](../mvcc/) が、古いバージョンの回収は [GC のページ](../mvcc-gc/) が扱っている。

このページが扱うのは**配線**だ。MVCC を有効にしたとき、これまでの 20 ページで見てきた構造のどこがどう変わるのか。

答えは「ほとんど変わらない」になる。**MVCC は既存の経路を置き換えず、その横に積まれる。**

| 層                                 | MVCC 無効        | MVCC 有効                                    |
| ---------------------------------- | ---------------- | -------------------------------------------- |
| `Cursor::BTree` の中身             | `BTreeCursor`    | `MvccLazyCursor` (中に `BTreeCursor` を持つ) |
| コミット                           | `commit_txn_wal` | `commit_txn_mvcc`                            |
| 行の置き場所                       | B-tree のページ  | **スキップリスト + B-tree**                  |
| 耐久性                             | WAL のフレーム   | 論理ログ                                     |
| `Pager` / `WAL` / ページキャッシュ | そのまま         | **そのまま**                                 |

## 主要な型とその関係

### `MvStore` はスキップリストの集まり

```rust title="core/mvcc/database/mod.rs:3980-4000 (抜粋)"
pub struct MvStore<Clock: LogicalClock, A: ConcurrentAllocator = TursoAllocator> {
    pub rows: SkipMap<RowID, RowVersions<A>, BasicComparator, A>,
    /// Table ID is an opaque identifier that is only meaningful to the MV store.
    /// Each checkpointed MVCC table corresponds to a single B-tree on the pager,
    /// which naturally has a root page.
    /// We cannot use root page as the MVCC table ID directly because:
    /// - We assign table IDs during MVCC commit, but
    /// - we commit pages to the pager only during checkpoint
    ///
    /// which means the root page is not easily knowable ahead of time.
    /// Hence, we store the mapping here.
    /// The value is Option because tables created in an MVCC commit that have not
    /// been checkpointed yet have no real root page assigned yet.
    pub table_id_to_rootpage: SkipMap<MVTableId, RootEntry, BasicComparator, A>,
    /// Unlike table rows which are stored in a single map, we have a separate map for every index
    /// ...
    pub index_rows: SkipMap<MVTableId, IndexRowsMap<A>, BasicComparator, A>,
```

**行は B-tree ではなくスキップリストに入る。** `rows` が `RowID → バージョン列` の写像だ。

`table_id_to_rootpage` のコメントが、この層の時間差を説明している。

- **テーブル ID はコミット時に決まる**
- **ルートページはチェックポイント時に決まる**

コミットの時点では、まだページを 1 枚も確保していない。だから「このテーブルは何番のページか」が分からない。**不定の期間があるので、間接層が要る。**

`Database` 側では `ArcSwapOption` で持たれている ([起動のページ](../boot-and-wiring/))。

```rust title="core/database.rs:520"
pub(crate) mv_store: ArcSwapOption<mvcc::MvStore<mvcc::MvccClock, A>>,
```

`Option` なので、MVCC は動的に有効化されうる。`ArcSwap` なのは、読みが圧倒的に多いからだ。

### カーソルは 2 本を同時に見る

```rust title="core/mvcc/cursor.rs:496-524 (抜粋)"
pub struct MvccLazyCursor<Clock: LogicalClock + 'static, A: ConcurrentAllocator = TursoAllocator> {
    pub db: Arc<MvStore<Clock, A>>,
    // ...
    current_pos: CursorPosition<A>,
    /// Stateful MVCC table iterator if this is a table cursor.
    table_iterator: Option<MvccIterator<'static, RowID, A>>,
    /// Stateful MVCC index iterator if this is an index cursor.
    index_iterator: Option<MvccIterator<'static, Arc<SortableIndexKey>, A>>,
    mv_cursor_type: MvccCursorType,
    table_id: MVTableId,
    tx_id: u64,
    // ...
    btree_cursor: Box<dyn CursorTrait>,
    // ...
    /// Dual-cursor peek state for proper iteration
    dual_peek: DualCursorPeek<A>,
```

**`table_iterator` (スキップリスト) と `btree_cursor` (B-tree) の両方を持つ。**

これがこの層の中心にある構造だ。ある行は、

- **スキップリストにだけある** — まだチェックポイントされていない新しい行
- **B-tree にだけある** — チェックポイント済みで、その後変更されていない行
- **両方にある** — チェックポイント済みの行が更新された

`dual_peek` が「次に返すべきはどちらか」を判定する。2 つのソートされた列を併合する、マージソートの内側と同じ形になる。

そして `MvccLazyCursor` は `CursorTrait` を実装しているので ([カーソルのページ](../cursor-abstraction/))、**VDBE の命令はこの併合を知らない**。`Next` を呼べば次の行が返る。

### 単一書き手を明示的に再現する

```rust title="core/mvcc/database/mod.rs:4028-4036"
/// The transaction ID of a transaction that has acquired an exclusive write lock, if any.
///
/// An exclusive MVCC transaction is one that has a write lock on the pager, which means
/// every other MVCC transaction must wait for it to commit before they can commit. We have
/// exclusive transactions to support single-writer semantics for compatibility with SQLite.
///
/// If there is no exclusive transaction, the field is set to `NO_EXCLUSIVE_TX`.
exclusive_tx: AtomicU64,
```

**MVCC なのに単一書き手のモードがある。** `BEGIN` (通常) は排他、`BEGIN CONCURRENT` は並行、という切り替えだ。

MVCC は本来「書き手が複数いてよい」ための機構なのに、**SQLite 互換のために意図的に 1 人に絞れるようにしている**。互換性の契約が新機能の内側にまで及んでいる例になっている。

## 処理の流れ (コードを追う)

### コミットは論理ログへ、チェックポイントで B-tree へ

```text
[通常の経路]
op_insert → BTreeCursor::insert → Pager::add_dirty → cacheflush → WAL のフレーム

[MVCC の経路]
op_insert → MvccLazyCursor::insert → MvStore.rows にバージョンを追加
commit    → CommitStateMachine → 論理ログに追記
(後で) checkpoint → CheckpointStateMachine → B-tree に実体化 → WAL のフレーム
```

**書き込みが 2 段階に分かれる。** コミットでは論理ログにしか書かず、B-tree に反映するのは後のチェックポイントだ。

だから MVCC のチェックポイントは、WAL のチェックポイント ([WAL のページ](../wal-and-checkpoint/)) とは全く別物になる。名前は同じだが、

|            | WAL のチェックポイント        | MVCC のチェックポイント                            |
| ---------- | ----------------------------- | -------------------------------------------------- |
| 何を移すか | WAL のフレーム → 本体ファイル | 論理ログ / スキップリスト → B-tree                 |
| 変換       | なし (ページのコピー)         | **あり (行 → B-tree のセル)**                      |
| 状態機械   | `wal.rs` の `CheckpointState` | `checkpoint_state_machine.rs` の `CheckpointState` |

**同じ名前の enum が 2 つある** ([Pager のページ](../pager-responsibilities/) でも触れた) ので、コードを追うときは注意がいる。

MVCC 側のチェックポイントは、[状態機械のページ](../io-result-and-state-machine/) で見たとおり `StateTransition` trait を使う唯一の場所だ。子の状態機械を入れ子で持つ。

```rust title="core/mvcc/database/checkpoint_state_machine.rs:195-248 (再掲・抜粋)"
write_row_state_machine: Option<StateMachine<WriteRowStateMachine>>,
delete_row_state_machine: Option<StateMachine<DeleteRowStateMachine>>,
build_local_schema_sm: Option<StateMachine<BuildLocalSchemaViewStateMachine<Clock, A>>>,
```

**行を 1 件書くのも状態機械。** B-tree への挿入なので、当然 I/O で中断する。

### ルートページの公開が、スキーマの無効化を要求する

チェックポイントがテーブルを実体化すると、初めてルートページ番号が決まる。それを `table_id_to_rootpage` に書き、**共有スキーマにも反映する**。

[スキーマ解決のページ](../schema-resolution/) で見たのがこの場面だ。

```rust title="core/connection.rs:1999-2002 (再掲)"
// MVCC checkpoint can publish physical btree roots into the shared
// schema without changing SQLite's schema cookie. If this connection
// still has the older schema snapshot, prepared statements must be
// invalidated and recompiled with the published roots.
```

**論理的なスキーマは変わっていないので、SQLite の cookie は上がらない。** だがコンパイル済みのバイトコードには古いルートページ番号が埋まっている ([エミッタのページ](../emitter-main-loop/) の `OpenRead`)。

だから cookie とは別の手段で無効化する必要があり、`Arc::ptr_eq` による比較と `schema_generation` カウンタが追加されている。**「SQLite 互換の版番号」が表現しきれないものを、2 つの仕掛けで補っている。**

### `begin_tx` の時計コールバックで二重に塞ぐ

```rust title="core/connection.rs:2047-2052 (再掲)"
/// Begin-tx schema gate for MVCC. Returns the `MvStore::schema_generation` this connection's
/// prepared schema is valid as of, or `SchemaUpdated` if it is already stale (a passive
/// checkpoint republished physical roots without a cookie change). The returned generation is
/// re-checked inside `begin_tx`'s clock callback: a publish bumps `schema_generation` under the
/// same clock, so if one lands between here and the begin clock the generations differ and the
/// statement is forced to reprepare against the published roots.
```

**「確認した瞬間」と「トランザクションが始まる瞬間」の間にも publish が挟まりうる。**

論理時計を進めるコールバックの中で世代番号を再検査することで、この隙間を閉じている。publish 側も同じ時計の下で世代を上げるので、順序が定まる。

### 索引には書き手のリースがある

```rust title="core/mvcc/database/mod.rs:4038-4050"
/// Custom-index writer leases keyed by the backing object's stable MVCC
/// table ID. Leases reject contention instead of waiting, so acquiring
/// several leases cannot deadlock. Entries outlive their holder: each one
/// remembers when the index was last published, so a transaction whose
/// read snapshot predates that publication is refused — its rebuild of
/// the index state starts from a superseded base and committing it would
/// overwrite the newer publication.
///
/// One writer per index is the intended concurrency model, not a stopgap:
/// two transactions cannot merge the index state each rebuilt from its
/// own snapshot, so the later one would silently overwrite the earlier
/// one's work. The lease makes the second writer fail fast instead.
/// Writers on different indexes, and all readers, still run concurrently.
index_method_write_leases: Mutex<HashMap<MVTableId, IndexMethodWriteLease>>,
```

**待たずに失敗するリース。** 複数取っても順序を気にせず済むので、デッドロックしない。

そして「1 索引 1 書き手は暫定策ではなく意図した並行性モデル」と明記されている。全文検索やベクトル索引 ([索引方式のページ](../index-method/)) は、状態を丸ごと組み替える形で更新されることがある。**2 つのスナップショットから独立に組み替えた結果を併合する方法がない**ので、後から来た方を弾く。

MVCC が「行単位では併合できる」ことを前提にした機構なので、**併合できない対象を扱うときは MVCC の外で調停するしかない**。

### 索引のスキャンにはエポックによる無効化がある

```rust title="core/mvcc/cursor.rs:525-534 (抜粋)"
/// [`MvStore::index_rows_epoch`] snapshot taken the last time
/// `index_finger` was consulted. New index keys can be created at or
/// behind an already-positioned finger while the scan's cursor is open
/// (e.g. a DELETE on the same connection inserts a tombstone key
/// mid-scan, #7578); versions appended to *existing* keys are fine
/// (chains are read live through their `Arc`), but a new key would be
/// silently skipped. On an epoch mismatch the finger is reset so it
/// reseeds at the current B-tree key instead of trusting its stale
/// position.
index_finger_epoch: u64,
```

**走査中に、自分より後ろの位置に新しいキーが挿入されうる。**

同じ接続の `DELETE` が墓標キーを入れる場合が典型だ。既存のキーへのバージョン追加なら `Arc` 越しに見えるので問題ないが、**新しいキーは指 (finger) の後ろに入ると飛ばされる**。

だからキーの集合が変わりうる操作でエポックを上げ、指を持つ側は毎回照合する。ずれていたら指を捨てて座り直す。

イシュー番号 (`#7578`) が付いていることからも、これが実際に踏まれたバグの修正だと分かる。[状態機械のページ](../io-result-and-state-machine/) で書いた「コメントが付いている状態には過去のバグが埋まっている」の、フィールド版になっている。

## 守られている不変条件

**MVCC を有効にしても Pager / WAL / ページキャッシュはそのまま動く。**

**テーブル ID とルートページの対応は遅延して決まる。** チェックポイント前は `None`。

**ルートページを公開したら、プリペアドステートメントを無効化する。** cookie は動かないので別の手段で。

**索引の書き手は 1 人。待たずに失敗する。**

**索引スキャンの指はエポックで検証する。**

**`BEGIN` (非 CONCURRENT) は排他トランザクションになる。** SQLite 互換のため。

## つまずきどころ / 設計の含み

### 「MVCC にした」のに B-tree が残る

MVCC を「B-tree の代わりにバージョン管理された別のストレージを使う」と読むと間違える。**B-tree は残り、スキップリストがその上に重なる。**

理由は 2 つある。

第 1 に、**ファイル形式が SQLite 互換でなければならない**。永続化された状態は最終的に SQLite の B-tree でなければ、`sqlite3` で開けない。

第 2 に、**全データをメモリのスキップリストに載せることはできない**。チェックポイントで B-tree に落とし、メモリから捨てる必要がある。

結果として、読み手は常に 2 つのソースを併合することになる。**これが `MvccLazyCursor` の複雑さの根本**で、`dual_peek` も `index_finger` も併合のための機構だ。

### `MVTableId` という間接層のコスト

`table_id_to_rootpage` が必要なのは、ID の確定とページの確定に時間差があるからだった。この間接層は、他の場所にも影響を及ぼす。

- スキーマに**負のルートページ**というプレースホルダが入る ([スキーマ解決のページ](../schema-resolution/) の `resolve_schema_negative_roots`)
- `integrity_check` が「使われていないページ」を誤検出しないよう、`dropped_root_pages` を別に持つ ([`Schema` の定義](../schema-resolution/))
- チェックポイントが publish するたびに、スキーマの無効化が要る

**「後で決まる ID」を導入すると、その ID を参照する全ての場所に『まだ決まっていない』状態が伝播する。** MVCC を後から積んだコストが、最も分かりやすく見える箇所になっている。

### 同名の型が 2 つある問題

このページで見ただけでも、

- `CheckpointState` — `wal.rs` と `checkpoint_state_machine.rs`
- `CommitState` — `vdbe/mod.rs`、`pager.rs`、`incremental/compiler.rs`

**役割が違う同名の型が並存している。** [状態機械のページ](../io-result-and-state-machine/) で見たとおり `enum *State` は core 全体で 114 個あるので、名前の衝突は避けにくい。

読むときは、型名ではなくモジュールパスで区別する必要がある。`use` の行を確認する習慣が要る。

### `docs/agent-guides/mvcc.md` は「WIP」のまま

概要ページにも書いたとおり、リポジトリ内のガイドは実装に追いついていない。GC は「未実装」と書かれているが `docs/internals/mvcc/GC.md` に設計があり、実装もある ([GC のページ](../mvcc-gc/))。

一方で `core/mvcc/database/tests.rs` は 20,570 行あり、`core` の中で最大のファイルだ。**ドキュメントよりテストの方が仕様を正確に記述している**状態になっている。

このコードベースを読むときの実践的な指針は、そこにある。

- **仕様を知りたいならテストを読む** — `hermitage_tests.rs` は分離レベルの標準的な異常のテストスイートだ
- **意図を知りたいならフィールドの doc コメントを読む** — 上で引用したものは、どれも「なぜこのフィールドが要るか」を説明している
- **ガイドは地図として使い、断定は信じない**

そしてこの章の 21 ページも、同じ方法で書かれている。
