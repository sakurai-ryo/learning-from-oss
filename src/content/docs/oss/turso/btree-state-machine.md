---
title: "B-tree の分割を状態機械に開くと、1 行の挿入が何十回もの再開になる"
description: "SQLite の btree.c は再帰とブロッキング I/O で書かれている。同じアルゴリズムを「途中で帰って再開する」形に開き直すと、1 回の insert が Start → Insert → Balancing の 7 サブ状態 → Finish という長い経路になる。しかも分割は他のカーソルが立っている場所を動かすので、同じ B-tree を見ているカーソル全部に位置の保存と再シークをさせる必要が出てくる。14000 行のファイルの複雑さの大半は、この 2 つから来ている。"
sidebar:
  order: 7
---

## 何を学んだか

`core/storage/btree.rs` は 14,457 行ある。エンジンで 3 番目に大きいファイルだ。

やっていることは SQLite の `btree.c` と同じアルゴリズムで、ファイル形式も同じだ。**それでも大きくなるのは、2 つのものを持ち込んだから**になる。

1. **再帰をやめて状態機械にした** — [`IOResult` の実行モデル](../io-result/) の必然
2. **他のカーソルへの影響を明示的に扱う** — 分割はページの中身を動かす

このページはその 2 つを見る。

## ソースコードのどこか

### 1 行の挿入が通る状態

まず書き込み全体の状態。

```rust title="core/storage/btree.rs"
/// State machine of a write operation.
/// May involve balancing due to overflow.
#[derive(Debug)]
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

[`core/storage/btree.rs#L345-L370`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L345-L370)。

**状態が状態を含んでいる。** `Overwrite` は `OverwriteCellState` を持ち、`Insert` は `FillCellPayloadState` を持つ。オーバーフローページの確保でも I/O が起きうるので、そこにも状態機械が要る。

`Overwrite` のコメントが正直だ。`Option` にしているのは借用検査を通すためで、**`IO` で帰るときに戻す** ([再入のページ](../reentrancy/) の型 3)。

そして `Balancing` に入ると、さらにこれがある。

```rust title="core/storage/btree.rs"
#[derive(Debug, Default)]
/// State machine of a btree rebalancing operation.
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

[`core/storage/btree.rs#L279-L308`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L279-L308)。

**9 個の状態のほぼ全部で I/O が起きうる。** 兄弟ページを読む、新しいページを確保する (freelist を読むかもしれない)、不要になったページを解放する (freelist trunk を読み書きする)。

そして分割は木を遡る。葉が溢れて親に分割キーを挿すと、今度は親が溢れる。**根まで届くこともある。**

```rust title="core/storage/btree.rs"
pub const BTCURSOR_MAX_DEPTH: usize = 20;
```

[`core/storage/btree.rs#L144`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L144)。

**1 行の `INSERT` が、最悪で数十回「途中まで進んで帰る」を繰り返す。** SQLite なら 1 回の関数呼び出しで済むところが、そうなっている。

### アルゴリズムは SQLite の行番号で参照する

分割するかどうかの判定には、こういうコメントが付いている。

```rust title="core/storage/btree.rs"
                        // check if we don't need to balance
                        // don't continue if:
                        // - current page is not overfull root
                        // OR
                        // - current page is not overfull and the amount of free space on the page
                        // is less than 2/3rds of the total usable space on the page
                        //
                        // https://github.com/sqlite/sqlite/blob/0aa95099f5003dc99f599ab77ac0004950b281ef/src/btree.c#L9064-L9071
                        let page = current_page.get_contents();
                        let free_space = compute_free_space(page, usable_space)?;
                        let this_level_is_already_balanced = page.overflow_cells.is_empty()
                            && (!self.stack.has_parent() || free_space * 3 <= usable_space * 2);
```

[`core/storage/btree.rs#L3061-L3072`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L3061-L3072)。

**コミットハッシュ付きで SQLite の該当行を指している。** 「2/3」という定数の根拠は SQLite にあり、Turso 側で説明できるものではない。

このスタイルはファイル中に何度も出てくる。書き直しプロジェクトで、**「なぜこの値か」の答えが元実装にしかないとき、指し示すのが一番正確**になる。

### 分割は、他のカーソルが立っている場所を動かす

B-tree の分割はセルを別のページへ移す。**同じ B-tree に別のカーソルが立っていると、そのカーソルが指しているページとセル番号は無意味になる。**

SQLite にも同じ問題があり、`BtShared.pCursor` の連結リストで全カーソルを追っている。Turso も同じ形を取った。

```rust title="core/storage/pager.rs"
    /// Live BTreeCursors on this pager, bucketed by btree root page.
    /// Counterpart of SQLite's BtShared.pCursor list; bucketing per root
    /// supplies the BTCF_Multiple fast path (btree.c:9348).
    pub(crate) cursor_registry: Mutex<rustc_hash::FxHashMap<i64, Vec<RegisteredCursor>>>,
```

[`core/storage/pager.rs#L1409-L1412`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/pager.rs#L1409-L1412)。

**根ページごとにバケツを分けている**のが SQLite との違いだ。SQLite は 1 本のリストを毎回走査するが、こちらは「同じ B-tree のカーソル」だけを一発で引ける。しかも **バケツの要素が 1 個なら、他に誰もいないと即座に分かる**。

```rust title="core/storage/pager.rs"
    /// Snapshot all peers of `except` on the same btree root. Snapshotting
    /// under the lock lets the caller iterate (and yield IO) without
    /// blocking concurrent cursor open/close on the registry.
    pub(crate) fn snapshot_peers_for_root(
        &self,
        except: &dyn crate::storage::btree::CursorTrait,
    ) -> smallvec::SmallVec<[RegisteredCursor; 4]> {
```

```rust title="core/storage/pager.rs"
        if bucket.len() <= 1 {
            return smallvec::SmallVec::new();
        }
```

[`core/storage/pager.rs#L1740-L1761`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/pager.rs#L1740-L1761)。

**「ロックの下でスナップショットを取り、ロックを外してから回す」。** 理由がコメントに書いてある。回している途中で **I/O yield する可能性がある** からだ。

ロックを持ったまま yield すると、そのカーソルが再開されるまでレジストリが固まる。カーソルの open/close が全部止まる。**協調的な yield では、「ロックを持ったまま帰らない」が普通のマルチスレッド以上に重要になる。**

### 位置を保存するか、諦めるか

他のカーソルにさせる後始末は、状況によって 2 通りある。

```rust title="core/storage/btree.rs"
    /// Save position so the cursor can re-seek after a peer write. Returns
    /// [`SavePositionResult::MustInvalidate`] when the position can't be
    /// represented (MVCC cursors, stale page stack); the caller falls back to
    /// invalidate_btree_cache.
    fn try_save_position_for_external_balance(&mut self) -> Result<IOResult<SavePositionResult>> {
        Ok(IOResult::Done(SavePositionResult::MustInvalidate))
    }
```

[`core/storage/btree.rs#L767-L773`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L767-L773)。

**キーを覚えておいて、後で再シークする** のが理想だ。カーソルは論理的な位置を保てる。

だがそれができない場合がある。そのときは丸ごと無効化して、次のアクセスで初めからやり直させる。**この trait のデフォルト実装が `MustInvalidate` を返している** のが安全側の設計で、対応していないカーソル型は自動的に安全な方を選ぶ。

全部を捨てる場面もある。

```rust title="core/storage/pager.rs"
    /// Invalidate the page stacks of every peer on `except`'s btree. Used
    /// by clear_btree / btree_destroy where every page is freed; saving
    /// positions would just stash keys that no longer exist.
    pub(crate) fn invalidate_peer_cursors(&self, except: &dyn crate::storage::btree::CursorTrait) {
```

[`core/storage/pager.rs#L1777-L1780`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/pager.rs#L1777-L1780)。

**「B-tree ごと消すなら、キーを保存しても存在しないキーを保存するだけ」。** ロールバックも同様で、ピン留めされたページがロールバック前のバイトを持っているかもしれないので、全カーソルを無効化する。

### 分割の途中でカーソルが行方不明にならないように

削除側の状態には、`post_balancing_seek_key` が全状態を通して引き回されている。

```rust title="core/storage/btree.rs"
enum DeleteState {
    Start,
    DeterminePostBalancingSeekKey,
    LoadPage {
        post_balancing_seek_key: Option<CursorContext>,
    },
    FindCell {
        post_balancing_seek_key: Option<CursorContext>,
    },
    ...
    RestoreContextAfterBalancing,
}
```

[`core/storage/btree.rs#L189-L233`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L189-L233)。

**削除する前に「削除後にどこへ戻るべきか」を決めている** (`DeterminePostBalancingSeekKey` が最初の実処理)。削除して分割が起きた後では、もう決められない。

さらに、こういう状態がある。

```rust title="core/storage/btree.rs"
    /// If an interior node was replaced, we need to move back up from the subtree to the interior cell
    /// that now has the replaced content, so that the next invocation of BTreeCursor::next() does not
    /// stop at that cell.
    /// The reason it is important to land here is that the replaced cell was smaller (LT) than the deleted cell,
    /// so we must ensure we skip over it. I.e., when BTreeCursor::next() is called, it will move past the cell
    /// that holds the replaced content.
    /// See: https://github.com/tursodatabase/turso/issues/3045
    PostInteriorNodeReplacement,
```

[`core/storage/btree.rs#L221-L228`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L221-L228)。

**issue 番号が付いている。** 内部ノードのセルを置き換えると、置き換わった内容が元より小さいので、次の `next()` がそのセルで止まってしまう。同じ行を 2 回返す。

こういう「なぜこの状態が必要か」がコメントとして残っていなければ、次の人は必ず消す。

## なぜそうなっているか

- **状態機械が深く入れ子になるのは、I/O が起きうる場所が入れ子だから。** 挿入の中にペイロード確保があり、その中にオーバーフローページの確保がある。どの層でもディスクを触るので、どの層にも状態が要る。
- **状態の数が処理の段階より多いのは、[再入対策](../reentrancy/) の中間状態が混ざるから。** `NonRootDoBalancingAllocate { i }` の `i` は、「何ページ目まで確保したか」を再開時に失わないために状態の中にある。
- **SQLite の行番号を指すのは、定数の根拠が向こうにしかないから。** 「2/3」を自分の言葉で説明しようとすると、必ず不正確になる。指し示す方が誠実で、しかも追える。
- **カーソルを根ページごとにバケツ分けしたのは、「他に誰もいない」が最頻ケースだから。** 単一カーソルの操作でリスト全体を走査するのは無駄で、`len() <= 1` の判定で済ませられる。
- **ロックの下でスナップショットを取るのは、回している途中で yield するから。** 協調的な実行モデルでは、ロックを持ったまま呼び出し元に帰ると、再開されるまで誰も進めない。普通のマルチスレッドより影響が長い。
- **位置の保存に失敗したら無効化に落とすのは、正しさを優先するため。** 「保存できたつもりで壊れた位置を復元する」より、「分からないから最初から探す」方が安い。デフォルト実装が安全側なのも同じ理由だ。
- **B-tree ごと消す場合に保存しないのは、保存に意味がないから。** 存在しなくなるキーを覚えても、再シークが失敗するだけになる。
- **削除の前に戻り先を決めるのは、後では決められないから。** 削除と分割が終わった後の木には、もう手がかりがない。

## どう活かすか

- **再帰で書かれたアルゴリズムを中断可能にすると、状態は「再帰の深さ × 各段の段階数」に膨らむ。** これは実装が下手だからではなく、そういう変換だと理解しておく。見積もりが変わる。
- **ループの添字は、ローカルではなく状態の中に置く。** 「何番目まで終わったか」は、中断をまたいで持ち越すべき最たるものだ。
- **元実装がある場合、定数や判定の根拠はコミットハッシュ付きで指す。** 自分の言葉で言い換えると必ずずれるし、ずれたことに気付けない。
- **共有構造を書き換える操作は、それを見ている他者の一覧を持つ。** 「今この構造を見ている人」を登録する仕組みがないと、書き換えたときに誰に知らせるべきか分からない。
- **その一覧は、影響範囲でバケツ分けする。** 全件走査は「影響がない」ことを確かめるために毎回コストを払う形になる。
- **一覧を持って回るときは、スナップショットを取ってロックを外す。** 特に、回している途中で待ちが発生する可能性があるなら必須になる。
- **後始末には「正確に直す」と「諦めて無効化する」の 2 段を用意し、デフォルトを後者にする。** 正確に直せない場合は必ずあり、そのときに落ちるより、やり直す方が安い。
- **不可解な中間状態には issue 番号を残す。** 「これは何のためにあるのか」が分からない状態は、必ず誰かに消される。
