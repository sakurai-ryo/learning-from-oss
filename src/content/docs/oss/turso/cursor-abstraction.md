---
title: "カーソルは 1 つの trait ではなく、7 バリアントの enum"
description: "「B-tree もソータも仮想テーブルも同じインタフェース」ではない。`Cursor` は 7 バリアントの enum で、共通メソッドはほとんどなく、取り出しは `as_sorter_mut()` のような panic するアクセサで行う。trait になっているのは B-tree 系だけで、しかもその実装は 2 つ — `BTreeCursor` と、それを内側に包む `MvccLazyCursor` だ。抽象化されているのは振る舞いではなく、カーソル番号という「枠」の方になっている。"
group: "バイトコードの実行"
sidebar:
  order: 14
---

## この層の責務

VDBE の命令はカーソル番号を引数に取る。`Column { cursor_id: 3, column: 1, dest: 5 }` のように。

命令から見ると、カーソル番号 3 が B-tree なのかソータなのか仮想テーブルなのかは**コンパイル時に決まっている**。`OpenRead` を吐いたか `SorterOpen` を吐いたかで、そこに何が入るかはエミッタが知っている。

だから実行時に多態が必要かというと、必要ない。この層の設計はその事実を素直に反映している。

## 主要な型とその関係

### `Cursor` は enum で、`Box<dyn>` は 2 バリアントだけ

```rust title="core/types.rs:3259-3270"
pub enum Cursor {
    BTree(Box<dyn CursorTrait>),
    IndexMethod(Box<dyn IndexMethodCursor>),
    Pseudo(Box<PseudoCursor>),
    Sorter(Box<Sorter>),
    Virtual(VirtualTableCursor),
    MaterializedView(Box<crate::incremental::cursor::MaterializedViewCursor>),
    /// Permanently-null placeholder installed by `NullRow` on a
    /// never-opened cursor slot; all reads yield NULL.
    NullRow,
}
```

`BTree` と `IndexMethod` だけが trait オブジェクトで、残りは具体型だ。**7 つの間に共通の trait はない。**

コンパイル時の対応物は `CursorType` になる。

```rust title="core/vdbe/builder.rs:502-513"
pub enum CursorType {
    BTreeTable(Arc<BTreeTable>),
    BTreeIndex(Arc<Index>),
    IndexMethod(Arc<dyn IndexMethodAttachment>),
    Pseudo(PseudoCursorType),
    Sorter,
    VirtualTable(Arc<VirtualTable>),
    MaterializedView(
        Arc<BTreeTable>,
        Arc<crate::sync::Mutex<crate::incremental::view::IncrementalView>>,
    ),
}
```

`ProgramBuilder.cursor_ref: Vec<(Option<CursorKey>, CursorType)>` が「番号 → 種類」の表で、実行時の `ProgramState.cursors: Vec<Option<Cursor>>` が「番号 → 実体」になる。**2 つの `Vec` が同じ添字で対応する。**

`CursorType` の `BTreeTable` と `BTreeIndex` が、実行時にはどちらも `Cursor::BTree` になる点に注意がいる。テーブルと索引の区別はコンパイル時にしかない。

### 取り出しは panic するアクセサ

```rust title="core/types.rs:3326-3344 (抜粋)"
pub fn as_sorter_mut(&mut self) -> &mut Sorter {
    match self {
        Self::Sorter(cursor) => cursor,
        _ => {
            mark_unlikely();
            panic!("Cursor is not a sorter cursor")
        }
    }
}

pub fn as_virtual_mut(&mut self) -> &mut VirtualTableCursor {
    match self {
        Self::Virtual(cursor) => cursor,
        _ => {
            mark_unlikely();
            panic!("Cursor is not a virtual cursor")
        }
    }
}
```

6 種類ぶんの `as_*_mut()` が並び、全部**種類が違えば panic する**。

`Option` を返して呼び出し側に判断させる形にはしていない。**エミッタが正しい命令を吐いていればここは絶対に一致する**という前提で、一致しなければバグなので落とす。[「壊れたデータを返すくらいなら落ちろ」](../architecture/) の直接的な適用だ。

`mark_unlikely()` を挟んでいるのは、分岐予測のヒントを与えて正常経路を速くするためだ。**panic 経路を「絶対に来ない」と宣言しつつ、来たら落とす**という形になっている。

### 全バリアントを跨ぐ操作は数えるほどしかない

`match` で全バリアントを扱うメソッドの 1 つが `set_null_flag` だ。

```rust title="core/types.rs:3369-3396 (抜粋)"
pub fn set_null_flag(&mut self, flag: bool) {
    match self {
        Self::BTree(cursor) => cursor.set_null_flag(flag),
        Self::Virtual(cursor) => cursor.set_null_flag(flag),
        // A pseudo cursor always decodes columns from its content
        // register. SQLite's OP_NullRow likewise leaves pseudo-cursor
        // column reads untouched: nullRow is the steady state for pseudo
        // cursors there, and OP_Column keeps routing to the register.
        Self::Pseudo(_) => {}
        // Permanently null; the flag is a no-op.
        Self::NullRow => {}
        // The FTS side of an outer join: columns are decoded from the
        // base-table cursor (which receives its own NullRow), never from
        // the index-method cursor, so there is no column state to null
        // out here.
        Self::IndexMethod(_) => {}
        _ => {
            mark_unlikely();
            panic!("set_null_flag on unexpected cursor type");
        }
    }
}
```

`NullRow` 命令 (外部結合で右側が見つからなかったときに NULL を返させる) は、どのカーソルにも来うる。だから全バリアントを書く必要がある。

**そして 5 バリアントのうち 3 つが何もしない。** それぞれ「なぜ何もしなくてよいか」がコメントで書かれている。共通インタフェースを作らなかった代償として、こういう「全部を列挙して個別に理由を書く」場所が生まれる。

### `CursorTrait` は 30 メソッドあり、実装は 2 つ

```rust title="core/storage/btree.rs:666-676 (抜粋)"
pub trait CursorTrait: Any + Send + Sync {
    /// Move cursor to last entry.
    fn last(&mut self) -> Result<IOResult<()>>;
    /// Move cursor to next entry.
    fn next(&mut self) -> Result<IOResult<()>>;
    /// Move cursor to previous entry.
    fn prev(&mut self) -> Result<IOResult<()>>;
    /// Get the rowid of the entry the cursor is poiting to if any
    fn rowid(&mut self) -> Result<IOResult<Option<i64>>>;
```

**戻り値が全部 `Result<IOResult<T>>`。** カーソルを 1 つ進めるだけでページを読むかもしれないので、全メソッドが中断しうる ([`IOResult` のページ](../io-result/))。

実装は 2 つある。

| 実装                       | 場所                         | 何をするか                                           |
| -------------------------- | ---------------------------- | ---------------------------------------------------- |
| `BTreeCursor`              | `core/storage/btree.rs:6335` | ページを直接歩く                                     |
| `MvccLazyCursor<Clock, A>` | `core/mvcc/cursor.rs:1206`   | バージョン列を歩き、必要に応じて内側の B-tree を引く |

**`MvccLazyCursor` は `BTreeCursor` を内側に持っている。**

```rust title="core/mvcc/cursor.rs:2233-2235"
fn get_pager(&self) -> Arc<Pager> {
    self.btree_cursor.get_pager()
}
```

MVCC を有効にすると、`Cursor::BTree` の中身が `BTreeCursor` から `MvccLazyCursor` に差し替わる。VDBE の命令はどちらかを知らない。**この 1 点のためだけに `CursorTrait` が存在している**、と言ってよい。

trait の末尾に、その事情が正直に書かれている。

```rust title="core/storage/btree.rs:746-767 (抜粋)"
    /// Returns true if this cursor operates in MVCC mode.
    fn is_mvcc(&self) -> bool {
        false
    }

    // --- start: BTreeCursor specific functions ----
    fn invalidate_record(&mut self);
    fn has_rowid(&self) -> bool;
    fn get_pager(&self) -> Arc<Pager>;
    fn get_skip_advance(&self) -> bool;
    // ...
    /// Opt into the pager's cursor_registry. Default no-op so non-BTreeCursor
    /// impls (MvccLazyCursor) stay out. Opt-in impls must unregister in Drop.
    fn register_with_pager(&self) {}
    // --- end: BTreeCursor specific functions ----
```

**「ここから下は `BTreeCursor` 固有」と区切ってある。** 抽象を作りきれず、片方の実装の都合が trait に漏れている。`is_mvcc()` があること自体が、抽象が漏れている証拠でもある — 本当に抽象化できていれば、呼び出し側が「これは MVCC か」を尋ねる必要はない。

`MvccLazyCursor` の `get_skip_advance()` が `todo!()` になっているのも同じ話だ。

## 処理の流れ (コードを追う)

### カーソルの登録は `new_btree` の中で起きる

```rust title="core/types.rs:3285-3290"
impl Cursor {
    pub fn new_btree(cursor: Box<dyn CursorTrait>) -> Self {
        // Matches sqlite3BtreeCursor adding to BtShared.pCursor (btree.c:4699).
        cursor.register_with_pager();
        Self::BTree(cursor)
    }
```

B-tree カーソルを作ると、そのカーソルは Pager の `cursor_registry` に登録される ([起動のページ](../boot-and-wiring/) で見た `Pager` のフィールド)。

```rust title="core/storage/pager.rs:1409-1412 (抜粋)"
/// Live BTreeCursors on this pager, bucketed by btree root page.
/// Counterpart of SQLite's BtShared.pCursor list; bucketing per root
/// supplies the BTCF_Multiple fast path (btree.c:9348).
pub(crate) cursor_registry: Mutex<rustc_hash::FxHashMap<i64, Vec<RegisteredCursor>>>,
```

**なぜ Pager がカーソルを知る必要があるのか。** 同じ B-tree を 2 本のカーソルが見ているとき、片方が挿入して木の形が変わると、もう片方の位置が無効になるからだ。

```rust title="core/storage/btree.rs:764-775 (抜粋)"
/// Mirror of SQLite's BTCF_Multiple flag; toggled by Pager when a bucket
/// crosses the 1↔2 threshold.
fn set_has_peers_for_external_writes(&self, _has_peers: bool) {}
/// Save position so the cursor can re-seek after a peer write. Returns
/// [`SavePositionResult::MustInvalidate`] when the position can't be
/// represented (MVCC cursors, stale page stack); the caller falls back to
/// invalidate_btree_cache.
fn try_save_position_for_external_balance(&mut self) -> Result<IOResult<SavePositionResult>> {
    Ok(IOResult::Done(SavePositionResult::MustInvalidate))
}
```

**同じ根ページのカーソルが 2 本以上あるときだけ、この保存処理が走る。** 1 本しかなければ他人はいないので、丸ごと飛ばせる。ルート番号でバケット分けしているのはこの判定を安くするためだ。

保存できないときは `MustInvalidate` を返して、位置を諦める。**`MvccLazyCursor` は常に `MustInvalidate`** になる — デフォルト実装がそうなっていて、MVCC 側は上書きしていない。分割とカーソル位置の関係は [B-tree の状態機械のページ](../btree-state-machine/) が詳しい。

### `NullRow` バリアントは「開かれなかったカーソル」を表す

```rust title="core/types.rs:3266-3268"
/// Permanently-null placeholder installed by `NullRow` on a
/// never-opened cursor slot; all reads yield NULL.
NullRow,
```

`LEFT JOIN` の右側が一度も一致しなかった場合、そのカーソルは開かれないまま `NullRow` 命令を受ける。`cursors[id]` が `None` のところに、この番人を置く。

`None` のままにしないのは、**`None` は「まだ開いていない」で、`NullRow` は「永久に NULL」だから**だ。前者に `Column` 命令が来たらバグだが、後者に来たら NULL を返すのが正しい。1 つの `Option` では区別できない状態を、内側の enum のバリアントで表している。

### 索引方式カーソルは別の trait を持つ

```rust title="core/index_method/mod.rs:542-566 (抜粋)"
pub trait IndexMethodCursor: Send {
    /// create necessary components for index method (usually, this is a bunch of btree-s)
    fn create(&mut self, context: &IndexMethodContext) -> Result<IOResult<()>>;
    /// destroy components created in the create(...) call for index method
    fn destroy(&mut self, context: &IndexMethodContext) -> Result<IOResult<()>>;
    // ...
    /// initialize query to the index method
    /// first element of "values" slice is the Integer register which holds index of the chosen
    /// [IndexMethodDefinition::patterns] by query planner
    fn query_start(&mut self, values: &[Register]) -> Result<IOResult<bool>>;
    /// Moves cursor to the next response row
    fn query_next(&mut self) -> Result<IOResult<bool>>;
    /// Return column with given idx (zero-based) from current row
    fn query_column(&mut self, idx: usize) -> Result<IOResult<Value>>;
```

`CursorTrait` とは全く別の形をしている。`seek(key, op)` ではなく `query_start(values)` — **「キーで位置を決める」ではなく「クエリを投げて結果を順に取る」**というモデルだ。

全文検索やベクトル索引は B-tree のように「順序のある空間を歩く」ものではないので、インタフェースが違う。`Cursor` を 1 つの trait にまとめられなかった理由の 1 つがこれで、拡張点としての設計は [索引方式のページ](../index-method/) が扱う。

## 守られている不変条件

**カーソル番号の種類はコンパイル時に決まる。** `cursor_ref[i].1` と `cursors[i]` の種類は必ず一致する。しなければ panic。

**`cursors` の長さは実行中に変わらない。** `ProgramState::new(_, cursor_count)` で確保される。

**B-tree カーソルは作成時に Pager へ登録し、`Drop` で解除する。** `register_with_pager` の doc がそう要求している。

**`None` と `Cursor::NullRow` は違う。** 前者は「未オープン」、後者は「永久に NULL」。

**すべてのカーソル操作は `Result<IOResult<T>>` を返す。** 1 歩進むだけでも中断しうる。

## つまずきどころ / 設計の含み

### 「共通インタフェース」を期待して読むと迷う

`Cursor` という型名と、`OpenRead` / `Rewind` / `Next` / `Column` という命令の並びを見ると、多態的なイテレータを想像しやすい。実際は違う。

`op_next` の実装は、カーソルの種類ごとに分かれた分岐になっている。ソータには `SorterNext`、仮想テーブルには `VNext` という**別の命令**があり、`Next` は B-tree 専用だ。

**多態は命令の側で解決されていて、データの側にはない。** 命令セットが 210 個に膨らむ理由の一部でもある ([`step` のページ](../step-loop/))。

利点は明確だ。分岐が消え、`Box<dyn>` の間接参照も消え、それぞれのカーソルが自分に必要なメソッドだけを持てる。ソータに `seek(key, op)` は要らない。

代償は、**新しいカーソル種別を足すと触る場所が散らばる**ことだ。`Cursor` に 1 バリアント、`CursorType` に 1 バリアント、`as_*_mut()` を 1 個、`set_null_flag` の `match` に 1 腕、対応する命令を数個、`get_explain_description` に 1 腕。

### `Any` を継承している理由

```rust title="core/storage/btree.rs:666"
pub trait CursorTrait: Any + Send + Sync {
```

`Any` があるということは、どこかでダウンキャストしている。`Box<dyn CursorTrait>` から具体の `BTreeCursor` を取り出したい箇所がある、ということだ。

trait オブジェクトにしておきながら具体型に戻す必要が出るのは、抽象が足りていない兆候になる。`// --- start: BTreeCursor specific functions ---` の区切りと同じ話で、**`CursorTrait` は「2 実装を差し替えるための最小の trait」であって、汎用の抽象ではない**。

### `is_empty()` と `has_record()` だけが同期メソッド

30 近いメソッドのほとんどが `Result<IOResult<T>>` を返すなか、いくつかは同期だ。

```rust title="core/storage/btree.rs:735-741 (抜粋)"
fn is_empty(&self) -> bool;
fn root_page(&self) -> i64;
/// Move cursor at the start.
fn rewind(&mut self) -> Result<IOResult<()>>;
/// Check if cursor is poiting at a valid entry with a record.
fn has_record(&self) -> bool;
fn set_has_record(&mut self, has_record: bool);
```

**「今のカーソルの状態を尋ねる」ものは同期、「動かす」ものは非同期。** この区別は一貫していて、読むときの目印になる。`&self` を取るか `&mut self` を取るかとも、おおむね対応している。

例外が `rowid()` で、`&mut self` かつ `IOResult` を返す。位置しか見ないように思えるが、**索引カーソルの場合は rowid がレコードの末尾にあり、オーバーフローページを読む可能性がある**からだ。

### `MaterializedViewCursor` が enum に入っている意味

マテリアライズドビューが、他のカーソルと同じ枠に収まっている。

```rust title="core/vdbe/builder.rs:509-512"
MaterializedView(
    Arc<BTreeTable>,
    Arc<crate::sync::Mutex<crate::incremental::view::IncrementalView>>,
),
```

`CursorType::MaterializedView` が B-tree とビューの両方を抱えている。**差分維持されたビューは、裏に実体の B-tree を持ちつつ、未コミットの差分をビュー側から重ねて見せる**必要があるからだ ([該当ページ](../incremental-views/))。

「カーソル」という枠が、B-tree の走査からビューの差分適用まで受け止められる程度にゆるい枠であることが、この設計の実利になっている。共通 trait を先に決めていたら、この形は入らなかった可能性が高い。
