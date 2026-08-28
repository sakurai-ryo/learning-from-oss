---
title: "insert が overflow と balance を呼び、木の形が変わる"
description: "ページに入らないセルは、いったんメモリ上の「オーバーフローセル」として脇に置かれる。均衡化は最大 3 枚の兄弟ページから全セルを 1 本の平らな配列に集め、累積和の配列だけを動かして「どのページに何個」を決める。3 枚が最大 5 枚になる。ページの実体を書き換えるのは、その配分が決まった後だ。"
group: "ページとディスク"
sidebar:
  order: 19
---

## この層の責務

`INSERT` が 1 行を書くとき、B-tree に起きることは 3 段階ある。

1. **セルを作る** — レコードをバイト列にし、大きければオーバーフローページへ分ける
2. **ページに入れる** — 入らなければ「オーバーフローセル」としてメモリに置く
3. **均衡化する** — オーバーフローセルがあれば、兄弟ページとの間で配り直す

この 3 段目が B-tree 実装の本体で、`core/storage/btree.rs` の 14,457 行のかなりの部分を占める。

**この操作を状態機械に開くとどうなるか**という観点は [B-tree の状態機械のページ](../btree-state-machine/) が扱っている。このページは**アルゴリズムそのもの**を追う。

## 主要な型とその関係

### 書き込みは 4 状態、均衡化は 9 状態

```rust title="core/storage/btree.rs:347-370"
enum WriteState {
    Start,
    /// Overwrite an existing cell.
    /// In addition to deleting the old cell and writing a new one,
    /// we may also need to clear the old cell's overflow pages
    /// and add them to the freelist.
    Overwrite {
        page: PageRef,
        cell_idx: usize,
        // This is an Option although it's not optional; we `take` it as owned for [BTreeCursor::overwrite_cell]
        // to work around the borrow checker, and then insert it back if overwriting returns IO.
        state: Option<OverwriteCellState>,
    },
    /// Insert a new cell. This path is taken when inserting a new row.
    Insert {
        page: PageRef,
        cell_idx: usize,
        new_payload: crate::alloc::Vec<u8>,
        fill_cell_payload_state: FillCellPayloadState,
    },
    Balancing,
    Finish,
}
```

**上書きと新規挿入で経路が違う。** 上書きは古いセルのオーバーフローページを freelist へ返す必要がある。

```rust title="core/storage/btree.rs:281-308"
enum BalanceSubState {
    #[default]
    Start,
    BalanceRoot,
    Decide,
    Quick,
    /// Choose which sibling pages to balance (max 3).
    /// Generally, the siblings involved will be the page that triggered the balancing and its left and right siblings.
    /// The exceptions are:
    /// 1. If the leftmost page triggered balancing, up to 3 leftmost pages will be balanced.
    /// 2. If the rightmost page triggered balancing, up to 3 rightmost pages will be balanced.
    NonRootPickSiblings,
    /// Perform the actual balancing. This will result in 1-5 pages depending on the number of total cells to be distributed
    /// from the source pages.
    NonRootDoBalancing,
    NonRootDoBalancingAllocate {
        i: usize,
        context: Option<BalanceContext>,
    },
    NonRootDoBalancingFinish {
        context: BalanceContext,
    },
    /// Free pages that are not used anymore after balancing.
    FreePages {
        curr_page: usize,
        sibling_count_new: usize,
    },
}
```

**均衡化には 3 つの経路がある。** 根を分ける (`BalanceRoot`)、追記の近道 (`Quick`)、一般の兄弟間再配分 (`NonRoot*`)。

### 3 枚を配り直すと最大 5 枚になる

```rust title="core/storage/btree.rs:146-150"
/// Maximum number of sibling pages that balancing is performed on.
pub const MAX_SIBLING_PAGES_TO_BALANCE: usize = 3;

/// We only need maximum 5 pages to balance 3 pages, because we can guarantee that cells from 3 pages will fit in 5 pages.
pub const MAX_NEW_SIBLING_PAGES_AFTER_BALANCE: usize = 5;
```

3 枚から 5 枚。この数が配列の大きさを決め、それが `Vec` を使わずに済む根拠になっている。

```rust title="core/storage/btree.rs:480-492"
struct BalanceInfo {
    /// Old pages being balanced. We can have maximum 3 pages being balanced at the same time.
    pages_to_balance: [Option<PinGuard>; MAX_SIBLING_PAGES_TO_BALANCE],
    /// Bookkeeping of the rightmost pointer so the offset::BTREE_RIGHTMOST_PTR can be updated.
    rightmost_pointer: *mut u8,
    /// Number of siblings being used to balance
    sibling_count: usize,
    /// First divider cell to remove that marks the first sibling
    first_divider_cell: usize,
    /// Reusable buffer for constructing new divider cells during balance.
    /// Avoids allocating a new Vec for each sibling during balance_non_root.
    reusable_divider_cell: crate::alloc::Vec<u8>,
}
```

`pages_to_balance: [Option<PinGuard>; 3]` が `PinGuard` になっている点に注目したい。**均衡化の対象ページは、その間ずっと pin される。** 途中で I/O 待ちになってもキャッシュから追い出されない。

`rightmost_pointer: *mut u8` は生ポインタだ。親ページの中の 4 バイトを直接指している。だから `Send`/`Sync` を手で実装している。

```rust title="core/storage/btree.rs:494-497"
// SAFETY: Need to guarantee during balancing that we do not modify the rightmost pointer on the pointee `PageContent`
// safe as long as the Balance Algorithm does not modify the pointer
unsafe impl Send for BalanceInfo {}
unsafe impl Sync for BalanceInfo {}
```

**「アルゴリズムがこのポインタ自体を動かさない限り安全」**という条件付きの `unsafe impl` になっている。

### `CellArray` — 全セルを 1 本の平らな配列に集める

```rust title="core/storage/btree.rs:8453-8462"
struct CellArray {
    /// The actual cell data.
    /// For all other page types except table leaves, this will also contain the associated divider cell from the parent page.
    cell_payloads: crate::alloc::Vec<&'static mut [u8]>,

    /// Prefix sum of cells in each page.
    /// For example, if three pages have 1, 2, and 3 cells, respectively,
    /// then cell_count_per_page_cumulative will be [1, 3, 6].
    cell_count_per_page_cumulative: [u16; MAX_NEW_SIBLING_PAGES_AFTER_BALANCE],
}
```

**これがアルゴリズムの中心にある発想だ。**

3 枚のページのセルを、境界を無視して 1 本に並べる。どこで区切るかは `cell_count_per_page_cumulative` という累積和の配列 (長さ 5) だけで表す。

配分を変えるのは、**この 5 個の数字を動かすことだけ**になる。ページの中身は最後にまとめて書き直す。

`&'static mut [u8]` が再び登場する ([オンディスク形式のページ](../ondisk-format/))。セルはページのバッファを指したままで、コピーは作らない。

## 処理の流れ (コードを追う)

### オーバーフローセルは「ページに入らなかったセル」の待避所

ページに新しいセルが入らないとき、すぐ均衡化するのではなく、いったんメモリに置く。

```rust title="core/storage/sqlite3_ondisk.rs:547-551"
pub struct OverflowCell {
    pub index: usize,
    pub payload: Pin<crate::alloc::Vec<u8>>,
}
```

`index` は「このページの何番目のセルとして入るはずだったか」。`Pin` なのは、後で `&'static mut [u8]` として `CellArray` に載せるからだ。動かされると参照が壊れる。

**ページは一時的に「定員オーバー」の状態になる。** その状態でも `cell_count()` と `overflow_cells.len()` を足せば正しいセル数が分かるので、均衡化はその前提で書かれている。

### `Quick` — 追記なら 1 枚足すだけ

```rust title="core/storage/btree.rs:3159-3167 (抜粋)"
/// Fast balancing routine for the common special case where the rightmost leaf page of a given subtree overflows (= an append).
/// In this case we just add a new leaf page as the right sibling of that page, and insert a new divider cell into the parent.
/// The high level steps are:
/// 1. Allocate a new leaf page and insert the overflow cell payload in it.
/// 2. Create a new divider cell in the parent - it contains the page number of the old rightmost leaf, plus the largest rowid on that page.
/// 3. Update the rightmost pointer of the parent to point to the new leaf page.
/// 4. Continue balance from the parent page (inserting the new divider cell may have overflowed the parent)
fn balance_quick(&mut self) -> Result<IOResult<()>> {
```

**自動採番の rowid で挿入し続けると、常に一番右のページが溢れる。** 一般の再配分を走らせると、左の兄弟からセルを引っ張ってきて均そうとするので、無駄が大きい。

追記だと分かっているなら、新しいページを右端に足すだけでよい。結果として**ページの充填率は下がる**が、書き込み量が圧倒的に減る。SQLite も同じ最適化を持っている。

4 番目のステップが再帰を示している。親に divider セルを挿入した結果、親が溢れるかもしれない。**均衡化は根に向かって伝播する。**

### `NonRootPickSiblings` — 3 枚を選び、読み込む

トリガとなったページとその左右を取る。左端なら右へ 3 枚、右端なら左へ 3 枚。

このとき兄弟ページを読み込むので I/O が発生する。そして**中断すると完了ハンドルが失われる**という罠がある。

```rust title="core/storage/btree.rs:321-329"
/// Disk-read completions accumulated during the sibling-load loop in
/// `NonRootPickSiblings`. We persist them in `BalanceState` (rather than
/// in a local `CompletionGroup`) so that when the loop yields for spill
/// IO and is re-entered, completions from earlier iterations are not
/// lost — they would otherwise leak: the IO is still in flight, but we
/// would no longer have a handle to wait on them before reading page
/// contents in `NonRootDoBalancing`. Cleared when the loop completes
/// and transitions to `NonRootDoBalancing`.
pending_sibling_load_completions: crate::alloc::Vec<Completion>,
```

**1 枚目の読みを発行し、2 枚目でスピル待ちになって帰ると、1 枚目の完了ハンドルがローカル変数と一緒に消える。** I/O 自体は飛んでいるので、待つ手段を失ったまま次の状態へ進んでしまう。

だから完了ハンドルを状態に持たせる。[再入のページ](../reentrancy/) の「型 2: 完了ハンドルを状態に持たせる」の実例だ。

3 枚が揃ったら、全部の完了をまとめて待つ。

```rust title="core/storage/btree.rs:3509-3520 (抜粋)"
// Build the wait-group from the accumulated completions
// collected across (possibly multiple) calls. Drain so
// a subsequent balance operation starts fresh.
let mut group = CompletionGroup::new(|_| {});
let completions = take_vec(pending_sibling_load_completions);
for c in &completions {
    group.add(c);
}
let completion = group.build();
if !completion.finished() {
    io_yield_one!(completion);
}
```

### セルを集める — divider セルの扱いが型で変わる

```rust title="core/storage/btree.rs:3726-3755 (抜粋)"
let is_last_sibling = i == balance_info.sibling_count - 1;
if !is_last_sibling && !is_table_leaf {
    // If we are a index page or a interior table page we need to take the divider cell too.
    // But we don't need the last divider as it will remain the same.
    if is_leaf {
        // The divider holds the leaf cell's real size after its child pointer;
        // back on a leaf the cell takes the minimum size again.
        ensure_min_cell_size(&mut reusable_divider_buffers[i], LEFT_CHILD_PTR_SIZE_BYTES);
    }
    let mut divider_cell = reusable_divider_buffers[i].as_mut_slice();
    cells_inserted += 1;
    if !is_leaf {
        // This divider cell needs to be updated with new left pointer,
        let right_pointer = old_page_contents.rightmost_pointer()?.unwrap();
        divider_cell[..LEFT_CHILD_PTR_SIZE_BYTES].copy_from_slice(&right_pointer.to_be_bytes());
    } else {
        // index leaf
        // let's strip the page pointer
        divider_cell = &mut divider_cell[LEFT_CHILD_PTR_SIZE_BYTES..];
    }
    cell_array.cell_payloads.push(to_static_buf(divider_cell));
}
```

**テーブルの葉ページだけ、divider セルを配列に入れない。**

テーブルの内部ノードの divider セルは「子ページ番号 + rowid」でしかない ([オンディスク形式のページ](../ondisk-format/))。実データを含まないので、配り直しの対象ではなく、親に残る帳簿として扱われる。

索引ではそうはいかない。divider セルにキーの実体が入っているので、**配り直しの対象に含めなければ 1 件消える**。しかも索引の内部ノードと葉ではセルの形が違う (子ページ番号の有無) ので、その場で 4 バイトを足したり剥がしたりしている。

集め終わったところで検算する。

```rust title="core/storage/btree.rs:3765-3782 (抜粋)"
// Verify that all cells were collected correctly.
// Note: For table leaf pages, dividers are counted in total_cells_to_redistribute
// but are NOT included in cell_array (they stay in parent as bookkeeping).
// For index/interior pages, dividers ARE included in cell_array.
let dividers_in_parent_only = if is_table_leaf {
    balance_info.sibling_count.saturating_sub(1)
} else {
    0
};
let expected_cells_in_array = total_cells_to_redistribute - dividers_in_parent_only;
turso_assert!(
    cell_array.cell_payloads.len() == expected_cells_in_array,
    "cell count mismatch after collection",
    { /* 5 個の値を添えて */ }
);
```

**アサーション 2 本で、集めたセル数を 2 通りの数え方で照合している。** `turso_assert!` はテストのプロパティ定義も兼ねる ([該当ページ](../antithesis-assert/))。

### 配分は「左詰め → 右へ均す」の 2 段

```rust title="core/storage/btree.rs:3842-3850"
/* 4. Now let's try to move cells to the left trying to stack them without exceeding the maximum size of a page.
     There are two cases:
       * If current page has too many cells, it will move them to the next page.
       * If it still has space, and it can take a cell from the right it will take them.
         Here there is a caveat. Taking a cell from the right might take cells from page i+1, i+2, i+3, so not necessarily
         adjacent. But we decrease the size of the adjacent page if we move from the right. This might cause a intermitent state
         where page can have size <0.
    This will also calculate how many pages are required to balance the cells and store in sibling_count_new.
*/
```

**第 1 段: できるだけ左に詰める。** 各ページを順に見て、溢れていれば右へ押し出し、空きがあれば右から引き取る。

```rust title="core/storage/btree.rs:3852-3868 (抜粋)"
let mut sibling_count_new = balance_info.sibling_count;
let mut i = 0;
while i < sibling_count_new {
    // First try to move cells to the right if they do not fit
    while new_page_sizes[i] > usable_space_without_header as i64 {
        let needs_new_page = i + 1 >= sibling_count_new;
        if needs_new_page {
            sibling_count_new = i + 2;
            turso_assert!(
                sibling_count_new <= 5,
                "it is corrupt to require more than 5 pages to balance 3 siblings"
            );
            new_page_sizes[sibling_count_new - 1] = 0;
            cell_array.cell_count_per_page_cumulative[sibling_count_new - 1] =
                cell_array.cell_payloads.len() as u16;
        }
```

**押し出す先がなければ、その場でページを 1 枚増やす。** ここで `sibling_count_new` が 3 から 4、5 へ育つ。5 を超えたら破損とみなす。

`new_page_sizes` が `i64` なのは、コメントにあるとおり**途中で負になりうる**からだ。右から引き取るとき、引き取り元は隣接ページとは限らない。隣のページのサイズを先に減らしてから実際の移動先を探すので、一時的に辻褄が合わない状態を通る。

```rust title="core/storage/btree.rs:3927-3934 (抜粋)"
// Check if this page contains up to the last cell. If this happens it means we really just need up to this page.
// Let's update the number of new pages to be up to this page (i+1)
let page_completes_all_cells = cell_array.cell_count_per_page_cumulative[i]
    >= cell_array.cell_payloads.len() as u16;
if page_completes_all_cells {
    sibling_count_new = i + 1;
    break;
}
```

**逆にページが減ることもある。** 削除の後に均衡化すると、3 枚分のセルが 2 枚に収まる。

**第 2 段: 右へ戻して均す。**

```rust title="core/storage/btree.rs:3948-3950 (抜粋)"
/* 5. Balance pages starting from a left stacked cell state and move them to right trying to maintain a balanced state
where we only move from left to right if it will not unbalance both pages, meaning moving left to right won't make
right page bigger than left page.
```

第 1 段は左に寄せるだけなので、最後のページがすかすかになる。第 2 段で右へ戻して均す。ただし**「戻した結果、右が左より大きくなる」なら戻さない**。

この 2 段構えも SQLite の `balance_nonroot()` と同じ構造だ。

### ページの実体を書くのは最後

配分が決まってから `NonRootDoBalancingAllocate` で新しいページを確保し、`NonRootDoBalancingFinish` で中身を書く。不要になったページは `FreePages` で freelist へ返す。

**「決める」と「書く」が完全に分かれている**ので、決める段階で I/O 待ちになっても、ページはまだ壊れていない。

## 守られている不変条件

**均衡化の対象は最大 3 枚、結果は最大 5 枚。** 超えたら破損。

**均衡化中の全ページは pin されている。** `[Option<PinGuard>; 3]`。

**集めたセル数は 2 通りの数え方で一致する。** `turso_assert!` 2 本。

**テーブルの葉の divider セルは配り直さない。索引では配り直す。**

**セルを 1 件も失わない。** `CellArray` に集めた総数が、書き戻した総数と一致する。

**ページの実体を書くのは、配分が確定した後。**

**均衡化は根に向かって伝播する。** 親に divider を挿すと親が溢れうる。

## つまずきどころ / 設計の含み

### アルゴリズムは SQLite の行番号で参照される

コード中のコメントには `btree.c:9348` のような参照が散らばっている。**独自に導出したアルゴリズムではなく、SQLite の実装を写している。**

理由ははっきりしている。B-tree の均衡化には正しい実装が無数にあるが、**同じ挿入列に対して同じページ配置を作る実装は 1 つしかない**。ファイルをバイト単位で一致させる ([互換性のページ](../sqlite-compat/)) 以上、配分のアルゴリズムまで写す必要がある。

`tools/dbhash` で `.db` ファイルのハッシュを比べるという検証手法が成立するのは、ここまで揃えているからだ。

### `to_static_buf` が至るところに出てくる

```rust
cell_array.cell_payloads.push(to_static_buf(cell_buf));
```

ページのバッファへの `&mut [u8]` を `&'static mut [u8]` に変える関数だ。**均衡化の間、3 枚のページのバッファへの可変参照が同時に生きている**ので、借用検査を通せない。

pin で追い出しを止め、`PinGuard` で寿命を保証し、その上で `'static` を名乗る。**型で表現できない不変条件を、実行時の pin と人間の規律で守っている。**

この構造が、[決定的シミュレータ](../deterministic-simulator/) と [Antithesis](../antithesis-assert/) にコストをかける理由でもある。コンパイラが守ってくれない以上、実行して確かめるしかない。

### 再利用バッファが 3 種類ある

```rust title="core/storage/btree.rs:314-320 (抜粋)"
/// Reusable buffers for divider cell payloads.
/// These persist across balance operations to avoid repeated allocations.
/// We use Vec<u8> with clear/resize instead of allocating new each time.
reusable_divider_buffers: [crate::alloc::Vec<u8>; MAX_SIBLING_PAGES_TO_BALANCE - 1],
/// Reusable Vec for CellArray cell_payloads to avoid per-balance allocation.
/// Cleared before each use; grows as needed and retains capacity across operations.
reusable_cell_payloads: crate::alloc::Vec<&'static mut [u8]>,
```

カーソル側にも `reusable_cell_payload` と `reusable_immutable_record` がある。**均衡化 1 回あたりの確保回数をゼロに近づける**という方針が徹底されている。

`crate::alloc::Vec` は標準の `Vec` ではなく、確保に名前を付けて OOM を注入できるようにした自前の型だ ([該当ページ](../allocation-site/))。再利用バッファを使えば、その確保点自体が消える。

### 容量の事前計算をアサートしている

```rust title="core/storage/btree.rs:3760-3763"
turso_assert!(
    cell_array.cell_payloads.capacity() == cells_capacity_start,
    "calculation of max cells was wrong"
);
```

**セルを集める前に容量を計算しておき、集め終わった後に「再確保が起きなかったこと」を確認する。**

再確保が起きると `Vec` のバッファが移動する。`cell_payloads` の中身はスライスなので移動しても問題ないが、この配列自体が再確保されるとキャパシティ計算が間違っていたことになる。それは「セル数の見積もりを外した」ということで、その先の検算も信用できない。

**性能のためのアサートに見えて、実は正しさのアサート**になっている。

### `Decide` という状態がある

```rust
enum BalanceSubState {
    Start,
    BalanceRoot,
    Decide,
    Quick,
    // ...
```

`Start` と `Decide` が分かれている。`Start` はまだ何も読んでいない状態で、`Decide` は「根か非根か」「追記か一般か」を決める状態だ。

判定にページの内容が要る (親の右端ポインタを見て追記かどうかを判断する) ので、**判定の前にページ読みが挟まりうる**。だから判定自体が独立した状態になっている。

「条件分岐が状態になる」のは、非同期を手書きする世界に特有の形だ。同期コードなら `if` 1 個で済む。
