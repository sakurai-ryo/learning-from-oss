---
title: "読み側の B-tree は `move_to` / `seek` / `advance` の 3 つに畳まれる"
description: "カーソルは深さ 20 の固定長配列でページの経路を持ち、各段に「今どのセルにいるか」を並べて覚える。セルインデックスの -1 と `cell_count` が番兵になっていて、走査が上に戻るかどうかをこの 2 値が決める。二分探索は内部ノード用と葉用で状態が分かれ、索引探索では「途中で完全一致を見たか」を降りながら持ち回る必要がある。"
group: "ページとディスク"
sidebar:
  order: 18
---

## この層の責務

`BTreeCursor` の読み側は 3 つの操作に畳める。

| 操作            | 意味                         | 使う命令                                                |
| --------------- | ---------------------------- | ------------------------------------------------------- |
| `move_to`       | 根から目的の葉まで降りる     | 内部で使われる                                          |
| `seek`          | キーに対応する位置を見つける | `SeekGE` / `SeekGT` / `SeekLE` / `SeekLT` / `NotExists` |
| `next` / `prev` | 隣のレコードへ進む           | `Next` / `Prev`                                         |

`rewind` (先頭へ) と `seek_to_last` (末尾へ) は `move_to` の特殊形だ。

これらが難しいのは、B-tree のアルゴリズムそのものではなく、**どの一歩でもページ読みが発生しうる**ことにある。降りる途中で I/O 待ちになったら、そこから再開しなければならない。

書き込み側 (`insert` / `delete` / `balance`) は [次のページ](../btree-write/) で扱う。

## 主要な型とその関係

### `PageStack` — 経路を固定長配列で持つ

```rust title="core/storage/btree.rs:8231-8244"
struct PageStack {
    /// Pointer to the current page being consumed
    current_page: i32,
    /// List of pages in the stack. Root page will be in index 0
    pub stack: [Option<PageRef>; BTCURSOR_MAX_DEPTH + 1],
    /// List of cell indices in the stack.
    /// node_states[current_page] is the current cell index being consumed. Similarly
    /// node_states[current_page-1] is the cell index of the parent of the current page
    /// that we save in case of going back up.
    /// There are two points that need special attention:
    ///  If node_states[current_page] = -1, it indicates that the current iteration has reached the start of the current_page
    ///  If node_states[current_page] = `cell_count`, it means that the current iteration has reached the end of the current_page
    node_states: [BTreeNodeState; BTCURSOR_MAX_DEPTH + 1],
}
```

```rust title="core/storage/btree.rs:144"
pub const BTCURSOR_MAX_DEPTH: usize = 20;
```

**`Vec` ではなく固定長配列**。木の深さに上限を設けて、確保をゼロにしている。深さ 20 は、分岐度が数十〜数百あることを考えれば十分な余裕だ。

超えたら破損とみなす。

```rust title="core/storage/btree.rs:8271-8275 (抜粋)"
turso_assert_less_than!(
    current,
    BTCURSOR_MAX_DEPTH,
    "corrupted database, stack is bigger than expected"
);
```

各段の状態は 2 フィールドしかない。

```rust title="core/storage/btree.rs:1062-1065"
struct BTreeNodeState {
    cell_idx: i32,
    cell_count: Option<i32>,
}
```

`cell_idx` が `i32` で符号付きなのは、**`-1` が「このページの手前」を意味する番兵**だからだ。逆に `cell_count` と等しければ「このページの末尾を越えた」になる。

```rust title="core/storage/btree.rs:1067-1075 (抜粋)"
/// Check if the current cell index is at the end of the page.
/// This information is used to determine whether a child page should move up to its parent.
/// If the child page is the rightmost leaf page and it has reached the end, this means all of its ancestors have
/// already reached the end, so it should not go up because there are no more records to traverse.
fn is_at_end(&self) -> bool {
    let cell_count = self.cell_count.expect("cell_count is not set");
    // cell_idx == cell_count means: we will traverse to the rightmost pointer next.
    // cell_idx == cell_count + 1 means: we have already gone down to the rightmost pointer.
```

**`cell_count` と `cell_count + 1` を区別している。** 内部ノードは「セルの数 + 1 個の子」を持つ (最後の 1 個は右端ポインタ) ので、末尾の状態が 2 つ要る。

`cell_count: Option<i32>` になっているのは、**push した時点ではまだページを読んでいないかもしれない**からだ。`populate_parent_cell_count()` が後から埋める。

### ページのピンは push で起きる

```rust title="core/storage/btree.rs:8277 (抜粋)"
// Pin the page to prevent it from being evicted while on the stack
```

スタックに載っている間、そのページはキャッシュから追い出せない ([ページキャッシュのページ](../page-cache-pin/))。[オンディスク形式のページ](../ondisk-format/) で見たとおり、セルはページのバッファを `&'static [u8]` として借りているので、追い出されたらダングリングになる。

**カーソル 1 本が最大 21 枚のページを pin しうる。** カーソルが 10 本立てば 210 枚。`PRAGMA cache_size` がソフトリミットである理由の 1 つがこれだ ([Pager のページ](../pager-responsibilities/))。

### カーソルは 9 個の状態機械を持つ

```rust title="core/storage/btree.rs:818-835 (抜粋)"
/// State machine for [BTreeCursor::is_empty_table]
is_empty_table_state: EmptyTableState,
/// State machine for [BTreeCursor::move_to_rightmost] and, optionally, the id of the rightmost page in the btree.
/// If we know the rightmost page id and are already on that page, we can skip a seek.
move_to_right_state: (MoveToRightState, Option<usize>),
/// State machine for [BTreeCursor::seek_to_last]
seek_to_last_state: SeekToLastState,
/// State machine for [BTreeCursor::rewind]
rewind_state: RewindState,
/// State machine for [BTreeCursor::next] and [BTreeCursor::prev]
advance_state: AdvanceState,
/// State machine for [BTreeCursor::count]
count_state: CountState,
/// State machine for [BTreeCursor::seek_end]
seek_end_state: SeekEndState,
/// State machine for [BTreeCursor::move_to]
move_to_state: MoveToState,
```

**操作 1 つにつき状態が 1 つ。** [状態機械のページ](../io-result-and-state-machine/) で見た `state_machines.rs` の 2 値 enum 群が、ここにフィールドとして並ぶ。

これらが別々のフィールドなのは、**入れ子で呼ばれるから**だ。`seek_to_last` は内部で `is_empty_table` を呼び、`move_to_rightmost` を呼ぶ。1 つの `state` フィールドを共有すると、上書きし合ってしまう。

### `CursorValidState` — 位置が有効かの 4 値

```rust title="core/storage/btree.rs:589-598"
pub enum CursorValidState {
    /// Cursor does not point to a valid entry, and Btree will never yield a record.
    Invalid,
    /// Cursor is pointing a to an existing location/cell in the Btree
    Valid,
    /// Cursor may be pointing to a non-existent location/cell. This can happen after balancing operations
    RequireSeek,
    /// Cursor requires an advance after a seek
    RequireAdvance(IterationDirection),
}
```

**`RequireSeek` が Turso 特有の重みを持つ。** 他のカーソルが挿入して木が再構成されると、このカーソルの `PageStack` が指す位置は無意味になる。そのとき位置を捨てて `RequireSeek` を立て、次に使うときにキーから探し直す。

`RequireAdvance(direction)` は、seek の結果が「求めた位置の 1 つ手前」だったときに立つ。索引の内部ノードにキーがある場合に起きる。

## 処理の流れ (コードを追う)

### `seek` は 2 段構えの二分探索

```rust title="core/storage/btree.rs:636-651"
pub enum CursorSeekState {
    Start,
    MovingBetweenPages {
        eq_seen: bool,
    },
    InteriorPageBinarySearch {
        state: InteriorPageBinarySearchState,
    },
    FoundLeaf {
        eq_seen: bool,
    },
    LeafPageBinarySearch {
        state: LeafPageBinarySearchState,
    },
}
```

内部ノードでの二分探索と葉での二分探索が、別の状態として分かれている。**「どの子へ降りるか」と「どのセルか」は答えの意味が違う**からだ。

そして両方に `eq_seen` が付いて回る。

```rust title="core/storage/btree.rs:609-619 (抜粋)"
pub struct LeafPageBinarySearchState {
    min_cell_idx: isize,
    max_cell_idx: isize,
    nearest_matching_cell: Option<usize>,
    /// Indicates if we have seen an exact match during the downwards traversal of the btree.
    /// This is only needed in index seeks, in cases where we need to determine whether we call
    /// an additional next()/prev() to fetch a matching record from an interior node. We will not
    /// do that if both are true:
    /// 1. We have not seen an EQ during the traversal
    /// 2. We are looking for an exact match ([SeekOp::GE] or [SeekOp::LE] with eq_only: true)
    eq_seen: bool,
```

**索引の内部ノードにはキーの実体が入っている** ([オンディスク形式のページ](../ondisk-format/))。だから探しているキーが内部ノードで見つかることがある。その場合、降りきった葉には目的のレコードがない。

「降りる途中で完全一致を見たかどうか」を覚えておいて、葉で見つからなかったときに `next()` を 1 回追加で呼ぶ。**降下と探索の結果が独立していないので、状態を持ち回るしかない。**

もう 1 つのフィールドも読みどころだ。

```rust title="core/storage/btree.rs:620-631 (抜粋)"
/// In multiple places, we do a seek that checks for an exact match (SeekOp::EQ) in the tree.
/// In those cases, we need to know where to land if we don't find an exact match in the leaf page.
/// For non-eq-only conditions (GT, LT, GE, LE), this is pretty simple:
/// - If we are looking for GT/GE and don't find a match, we should end up beyond the end of the page (idx=cell count).
/// - If we are looking for LT/LE and don't find a match, we should end up before the beginning of the page (idx=-1).
///
/// ...
/// This is because e.g. when we attempt to insert rowid 666, we first check if it exists.
/// If it doesn't, we want to land in the place where rowid 666 WOULD be inserted.
target_cell_when_not_found: i32,
```

**「見つからなかったときにどこに立つか」が、用途によって違う。** 読みなら端に立てばよいが、挿入の前検査なら「入るべき場所」に立ってほしい。

seek が挿入からも呼ばれるので、この違いを引数ではなく状態に持っている。

### `SeekOp` は方向を含意する

```rust title="core/types.rs:3543-3556"
pub enum SeekOp {
    /// If eq_only is true, this means in practice:
    /// We are iterating forwards, but we are really looking for an exact match on the seek key.
    GE {
        eq_only: bool,
    },
    GT,
    /// If eq_only is true, this means in practice:
    /// We are iterating backwards, but we are really looking for an exact match on the seek key.
    LE {
        eq_only: bool,
    },
    LT,
}
```

```rust title="core/types.rs:3559-3574 (抜粋)"
/// A given seek op implies an iteration direction.
///
/// For example, a seek with SeekOp::GT implies:
/// Find the first table/index key that compares greater than the seek key
/// -> used in forwards iteration.
#[inline(always)]
pub fn iteration_direction(&self) -> IterationDirection {
    match self {
        SeekOp::GE { .. } | SeekOp::GT => IterationDirection::Forwards,
        SeekOp::LE { .. } | SeekOp::LT => IterationDirection::Backwards,
    }
}
```

**`EQ` という独立したバリアントがない。** 完全一致は `GE { eq_only: true }` か `LE { eq_only: true }` で表す。

理由は上のコメントにある。完全一致を探すときも、**その後どちらへ進むかが決まっていないと、内部ノードで一致したときの後始末ができない**。`EQ` にしてしまうと方向の情報が落ちる。

### `advance` — 上りで消費する索引ノード

```rust title="core/storage/btree.rs:790-793"
/// Index internal pages are consumed on the way up, so we store going upwards flag in case
/// we just moved to a parent page and the parent page is an internal index page which requires
/// to be consumed.
going_upwards: bool,
```

テーブルの B+ ツリーなら、葉を左から右へ舐めるだけでよい。葉が尽きたら親へ戻り、次の子へ降りる。親のセルには値がないので、通り過ぎるだけだ。

索引の B ツリーは違う。**親のセルにもレコードがある**ので、子を舐め終わって親に戻ったとき、その親のセルを 1 件として返さなければならない。

`going_upwards` はその状態を覚えるフラグだ。**「今は下りている」と「今は上ってきた」で、同じページの同じセルインデックスの意味が変わる。**

### spill で中断したときの再開

```rust title="core/storage/btree.rs:861-867"
/// If `Some(page_idx)`, a previous call to [`BTreeCursor::get_next_record`]
/// or [`BTreeCursor::get_prev_record`] yielded mid-descent into `page_idx`
/// for spill IO, AFTER the loop-top `stack.advance()` / `stack.retreat()`
/// mutations had already been applied. On re-entry, the traversal loop
/// short-circuits to retry the read+descend rather than re-running those
/// mutations and corrupting the cursor's cell-index state.
iteration_pending_descent: Option<IterationPendingDescent>,
```

これが [再入のページ](../reentrancy/) が扱う問題の、最も分かりやすい実例になっている。

走査ループは「セルインデックスを進める → ページを読む → 降りる」という順で回る。ページ読みが I/O 待ちになって帰ると、次の呼び出しはループの先頭から始まる。**セルインデックスをもう一度進めてしまい、1 件飛ばす。**

対策は「進める処理を済ませた後の入口」を別に用意することだ。[状態機械のページ](../io-result-and-state-machine/) で見た `CountState::Descend` と全く同じ構造で、こちらは `Option` のフィールドで表している。

```rust title="core/storage/btree.rs:889-895"
/// Records the in-flight descent for `iteration_pending_descent`. The direction
/// determines which `descend*` helper to apply once the page is read.
enum IterationPendingDescent {
    Forwards(i64),
    Backwards(i64),
}
```

## 守られている不変条件

**スタックの深さは 20 以下。** 超えたら破損。

**スタックに載っているページは pin されている。** 追い出されるとセルの参照が壊れる。

**同じページを二重に push しない。** `_push` が `turso_assert!` で確認する。

**セルインデックスの `-1` と `cell_count` は番兵。** 実在のセルを指さない。

**内部ノードの末尾は 2 状態ある。** `cell_count` (右端ポインタへこれから) と `cell_count + 1` (右端ポインタへ降りた後)。

**seek は方向情報を必ず持つ。** `EQ` 単独のバリアントはない。

**yield をまたいでインデックスを二度進めない。** `iteration_pending_descent` が再開点を分ける。

## つまずきどころ / 設計の含み

### `usable_space` をキャッシュしてよい根拠

```rust title="core/storage/btree.rs:780-784"
/// Cached value of the usable space of a BTree page, since it is very expensive to call in a hot loop via pager.usable_space().
/// This is OK to cache because both 'PRAGMA page_size' and '.filectrl reserve_bytes' only have an effect on:
/// 1. an uninitialized database,
/// 2. an initialized database when the command is immediately followed by VACUUM.
usable_space_cached: usize,
```

`pager.usable_space()` は `with_header` を経由するので `IOResult` を返す ([Pager のページ](../pager-responsibilities/))。**セルの走査ループの中でこれを呼ぶと、毎回 I/O 待ちの可能性が入り込む。**

キャッシュしてよい根拠が 2 行で示されている。ページサイズと予約領域は、初期化前か VACUUM 直後にしか変えられない。どちらもカーソルが立っている状況ではない。

**性能のためのキャッシュではなく、「非同期の伝染を止める」ためのキャッシュ**でもある。ここを毎回読んでいたら、`IOResult` を返す関数がさらに増える。

### `blob_cache` が 3 段のキャッシュを持っている

```rust title="core/storage/btree.rs:843-850 (抜粋)"
/// Per-cell access cache for incremental blob I/O. Caches the leaf cell's payload
/// layout, the overflow-page-number array (Turso's runtime reconstruction of
/// SQLite's `aOverflow`), and the byte range of the most recently accessed column,
/// so repeated byte accesses to the same row avoid re-parsing the cell and record
/// header and re-walking the overflow chain — turning each access into an O(1)
/// page lookup. Invalidated when the cursor moves to a different (page, cell). The
/// on-disk format is unchanged; this index lives only in RAM.
blob_cache: BlobCellCache,
```

インクリメンタル BLOB I/O (`sqlite3_blob_read`) は、1 つの BLOB の途中を何度も読む。素朴に実装すると毎回セルヘッダを解析してオーバーフローチェーンを辿り直すので、**アクセス 1 回が O(チェーン長)** になる。

オーバーフローページ番号の配列をメモリに作っておけば O(1) になる。コメントが「on-disk format is unchanged; this index lives only in RAM」とわざわざ断っているのは、**ファイル形式を動かさずに済ませた**ことの表明だ。

[互換性のページ](../sqlite-compat/) が言う「動かせるのはメモリの側だけ」の、素直な適用例になっている。

### BLOB ハンドルの失効が 3 フィールドを使う

```rust title="core/storage/btree.rs:851-859 (抜粋)"
/// Rowid the incremental-blob machinery last addressed. Unlike `blob_cache` it
/// survives position saves: it is what `note_external_row_write` compares against
/// to decide whether a peer's write hit *this* handle's row (expire, like SQLite's
/// invalidateIncrblobCursors) or a different row (survivable via re-seek).
blob_pinned_rowid: Option<i64>,
/// Latched when an external write hits the pinned row or the position becomes
/// unrecoverable. Every subsequent blob operation fails with
/// [`LimboError::BlobHandleExpired`]; nothing ever clears it — SQLite's expired
/// blob handles behave the same way until closed.
blob_expired: bool,
```

**「自分の行が書かれたら失効、他の行なら再 seek で生き延びる」**という区別のために、rowid を別に覚えている。`blob_cache` は位置の保存で消えるが、こちらは残る。

`blob_expired` は一度立ったら決して下りない。SQLite の挙動に合わせている。

### `has_peers` を `AtomicBool` で持つ理由

```rust title="core/storage/btree.rs:875-878 (抜粋)"
/// Mirrors SQLite's BTCF_Multiple. Toggled by Pager::register_cursor /
/// unregister_cursor when the bucket crosses the 1↔2 threshold; lets
/// drive_pending_peer_save skip the registry mutex in the common case.
has_peers: crate::sync::atomic::AtomicBool,
```

**同じ B-tree を見ているカーソルが自分だけなら、レジストリのミューテックスを取らずに済む。** 書き込みのたびに「他のカーソルの位置を保存する」処理を全部飛ばせる。

Pager 側がバケットの要素数が 1 ↔ 2 を跨いだときにこのフラグを更新する。**「よくある場合を速くするために、状態を 2 箇所で同期する」**という形で、単一カーソルの走査が圧倒的多数だという前提に賭けている。

`did_register` が別にあるのは、テストや内部ユーティリティが `BTreeCursor::new` を直接呼ぶ経路があるからだ。そのカーソルはレジストリに入っていないので、`Drop` で解除しようとすると壊れる。**公開 API を通らない経路が残っていることが、フィールドとして表面化している。**
