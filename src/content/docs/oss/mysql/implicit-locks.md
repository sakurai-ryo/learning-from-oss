---
title: "暗黙ロック — lock_t を作らない X ロック"
description: "自分が INSERT / UPDATE した行の DB_TRX_ID は、それだけで排他ロックとして機能する。lock_t を一切作らないので performance_schema.data_locks には現れず、他人がその行に触りに来た瞬間に初めて lock_rec_convert_impl_to_expl_for_trx が明示ロックへ変換する。セカンダリインデックスの葉には版がないため、この判定はクラスタードインデックスまで遡る必要があり、そのコストが row_vers_impl_x_locked_low という undo ログ限定の探索アルゴリズムを生んでいる。"
group: "InnoDB — トランザクション・MVCC・ロック"
sidebar:
  order: 82
---

> **前提**: [ロックの種類 (InnoDB)](./lock-modes-and-types/) / [行ロックとページラッチの継ぎ目](./locks-and-page-latches/)

## 何を学んだか

「暗黙ロックは `lock_t` を作らない」という説明は知っていたが、実際にソースを読むまで解像度が粗かった。分かったことは 3 つある。

**1. 暗黙ロックの正体は、レコードの `DB_TRX_ID` を読むという行為そのものだ。** `lock_clust_rec_some_has_impl` を開くと、中身は本当に `row_get_rec_trx_id(rec, index, offsets)` の 1 行しかない。ロック用の状態を新たに読むのではなく、行フォーマットの一部としてすでにそこにある `DB_TRX_ID` を「もし持ち主がまだアクティブなら X ロックとみなす」という規約に読み替えているだけだ。

**2. クラスタードとセカンダリで判定のコストが 1 桁違う。** クラスタードなら `DB_TRX_ID` を読んで `trx_rw_is_active` に渡すだけで済む。セカンダリインデックスの葉には `DB_TRX_ID` がないので ([セカンダリインデックスと MVCC](./secondary-index-visibility/))、`row_vers_impl_x_locked` がクラスタードインデックスまで戻って版チェーンを undo ログ経由で遡る。**しかもこの重い経路に入る前に、ページの `PAGE_MAX_TRX_ID` を使ったもう 1 段のフィルタ (`can_older_trx_be_still_active`) がある**——同じ数値がここでも「安全側に倒す近似」として再利用されている。

**3. 変換を要求する側と要求しない側がある。** 読み取り 2 関数 (`lock_clust_rec_read_check_and_lock` / `lock_sec_rec_read_check_and_lock`) とクラスタードの書き込み 1 関数 (`lock_clust_rec_modify_check_and_lock`) は変換を呼ぶ。だが**セカンダリインデックスの書き込み (`lock_sec_rec_modify_check_and_lock`) は呼ばない**。コメントに理由が書いてある——「ここに来た時点ですでにクラスタードインデックスレコードを変更済みなので、他のトランザクションがこのセカンダリレコードに暗黙ロックを持っているはずがない」。変換の要否は「その行に対して自分がまだ何も確認していないか」で決まっていて、機械的に全書き込み経路に付いているわけではない。

## なぜそうなっているか

**`lock_t` を作らない設計にしたのは、INSERT のたびにロック構造体を作るコストを避けたいからだ** ([ロックの種類](./lock-modes-and-types/) で見た通り)。1 万行の一括 INSERT で `lock_t` を 1 万個作れば、そのメモリと `lock_sys` への登録コストが常に発生する。実際にその行を他人が触りに来ることは稀なので、「触りに来た側が変換のコストを払う」という遅延評価にしてある。

**変換がシャード latch の外にあるのは、`row_vers_impl_x_locked` が別ページの latch を要求するからだ。** ここは [行ロックとページラッチの継ぎ目](./locks-and-page-latches/) の主題そのものなので詳細はそちらに譲るが、要点だけ言うと「対象ページのシャード latch を持った状態では、クラスタードインデックスのページラッチを新たに取れない (latch order 違反)」ため、変換は`Shard_latch_guard` に入る前に済ませておく必要がある。

**セカンダリの判定が高コストなのは、セカンダリの葉に版がないという設計の裏返しだ。** セカンダリインデックスを小さく保つために `DB_TRX_ID` / `DB_ROLL_PTR` を葉に持たせなかった代償として、「このセカンダリエントリはまだ誰にも暗黙ロックされていないか」を答えるには、PK でクラスタードを引いて版鎖を遡るしかない。**`row_vers_impl_x_locked_low` が現在版のフィールドを一切読まずに済むよう設計されているのは、この重さをさらに一段抑えるためだ**——仮想列の materialize が高価であることと、読み取り経路を「undo ログだけ」に統一したいことがコメントに理由として挙がっている。すでに `trx_id` (現在版の `DB_TRX_ID` だけ) を読んだあとは、`current_version` のフィールドには二度と触らず、`could-be-authored-by` / `was-authored-by` という関係を undo 版だけで判定するループに切り替える。

**変換中に参照カウントで trx を保護するのは、変換が「他人の名義でロックを作る」という珍しい操作だからだ。** 通常ロックを作るのは自分のためだが、`lock_rec_convert_impl_to_expl_for_trx` は暗黙ロックを持っていたトランザクション (呼び出し元とは別のスレッドで動いている) のために `lock_t` を作る。その間に対象トランザクションがコミットして `trx_t` が再利用されたら二重に危険なので、`trx_is_referenced` / `trx_release_reference` で「参照が残っている間はコミット済みでも `trx_t` を消させない」という保証を作っている。

## ソースコードのどこか

### 暗黙ロックの実体 — `DB_TRX_ID` を読むだけ

```cpp title="storage/innobase/include/lock0priv.ic"
static inline trx_id_t lock_clust_rec_some_has_impl(const rec_t *rec,
                                                    const dict_index_t *index,
                                                    const ulint *offsets) {
  ut_ad(index->is_clustered());
  ut_ad(page_rec_is_user_rec(rec));

  return (row_get_rec_trx_id(rec, index, offsets));
}
```

[`lock0priv.ic#L52`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/lock0priv.ic#L52)、宣言は [`lock0priv.h#L940`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/lock0priv.h#L940)。宣言側の doc コメントが「クラスタードインデックスのレコードに、ある (何らかの) トランザクションの暗黙 X ロックがあるかを調べる」と書き、戻り値は「その X ロックを持つトランザクション ID、なければ 0」としている。**判定に使う情報は行データそのものにすでに入っている `DB_TRX_ID` だけ**で、ロック専用の状態は一切参照しない。

呼び出し元の `lock_rec_convert_impl_to_expl` はこれを `trx_rw_is_active` に渡してアクティブかどうかを確かめる。

```cpp title="storage/innobase/lock/lock0lock.cc"
void lock_rec_convert_impl_to_expl(const buf_block_t *block, const rec_t *rec,
                                   dict_index_t *index, const ulint *offsets) {
  trx_t *trx;

  ut_ad(!locksys::owns_exclusive_global_latch());
  ...
  if (index->is_clustered()) {
    trx_id_t trx_id;

    trx_id = lock_clust_rec_some_has_impl(rec, index, offsets);

    trx = trx_rw_is_active(trx_id, true);
  } else {
    ...
    trx = lock_sec_rec_some_has_impl(rec, index, offsets);
    ...
  }

  if (trx != nullptr) {
    ulint heap_no = page_rec_get_heap_no(rec);

    ut_ad(trx_is_referenced(trx));

    lock_rec_convert_impl_to_expl_for_trx(block, rec, index, offsets, trx,
                                          heap_no);
  }
}
```

[`lock0lock.cc#L5301`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5301)。`trx_rw_is_active(trx_id, true)` の第 2 引数 `do_ref_count = true` が、見つかったトランザクションの参照カウントをその場で 1 増やす ([`trx0sys.ic#L218-222`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/trx0sys.ic#L218) の `trx_reference(trx)` 呼び出し)。**`trx` が非 null で返ってきた時点で、すでに参照カウントは確保済み**であることが `ut_ad(trx_is_referenced(trx))` から分かる。

### 明示化の中身 — `LOCK_X | LOCK_REC_NOT_GAP` 固定

```cpp title="storage/innobase/lock/lock0lock.cc"
static void lock_rec_convert_impl_to_expl_for_trx(
    const buf_block_t *block, const rec_t *rec, dict_index_t *index,
    const ulint *offsets, trx_t *trx, ulint heap_no) {
  ut_ad(trx_is_referenced(trx));

  DEBUG_SYNC_C("before_lock_rec_convert_impl_to_expl_for_trx");
  {
    locksys::Shard_latch_guard guard{UT_LOCATION_HERE, block->get_page_id()};
    trx_mutex_enter(trx);

    ut_ad(!index->is_clustered() ||
          trx->id ==
              lock_clust_rec_some_has_impl(
                  rec, index,
                  offsets ? offsets : Rec_offsets().compute(rec, index)));

    ut_ad(!trx_state_eq(trx, TRX_STATE_NOT_STARTED));

    if (!trx_state_eq(trx, TRX_STATE_COMMITTED_IN_MEMORY) &&
        !lock_rec_has_expl(LOCK_X | LOCK_REC_NOT_GAP, block, heap_no, trx)) {
      ulint type_mode;

      type_mode = (LOCK_REC | LOCK_X | LOCK_REC_NOT_GAP);

      lock_rec_add_to_queue(type_mode, block, heap_no, index, trx, true);
    }

    trx_mutex_exit(trx);
  }

  trx_release_reference(trx);

  DEBUG_SYNC_C("after_lock_rec_convert_impl_to_expl_for_trx");
}
```

[`lock0lock.cc#L5245`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5245)。`static` 関数で `lock_rec_convert_impl_to_expl` からしか呼ばれない。要点は 3 つ。

1. **`Shard_latch_guard` + `trx_mutex_enter(trx)` の二重の保護下で作る。** シャード latch は対象ページのロックキュー、`trx` のミューテックスは対象トランザクションの状態遷移を止める。関数コメント自身が「この `trx_mutex_enter` は理屈の上では必須ではない (参照カウントとシャード latch だけでも安全は証明できる) が、この面倒な推論を避けるために取っている」と説明している
2. **すでに `LOCK_X | LOCK_REC_NOT_GAP` の明示ロックを持っていなければ作る。** `lock_rec_has_expl` でこのチェックをしているので、同じ行を何度も変換要求しても `lock_t` が重複して増えることはない
3. **`lock_rec_add_to_queue` の最後の引数 `true` が「暗黙ロック由来」を示す。** この行だけ他の呼び出し (通常のロック要求) と型シグネチャが違う

最後の `trx_release_reference(trx)` ([L5296](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5296)) が、`trx_rw_is_active` で確保した参照を返す。**関数の冒頭コメントに「トランザクションの参照カウントが 0 より大きくなければならず、この関数が完了する前にコミットされて解放されることがないようにする」と明記されている**——これが冒頭で見た「他人の名義でロックを作る」という操作の安全装置だ。

### セカンダリインデックス版 — `PAGE_MAX_TRX_ID` によるフィルタ + クラスタードへの遡行

```cpp title="storage/innobase/lock/lock0lock.cc"
static trx_t *lock_sec_rec_some_has_impl(const rec_t *rec, dict_index_t *index,
                                         const ulint *offsets) {
  trx_t *trx;
  trx_id_t max_trx_id;
  const page_t *page = page_align(rec);
  ...
  max_trx_id = page_get_max_trx_id(page);

  if (!recv_recovery_is_on() && !can_older_trx_be_still_active(max_trx_id)) {
    trx = nullptr;

  } else if (!lock_check_trx_id_sanity(max_trx_id, rec, index, offsets)) {
    trx = nullptr;

    /* In this case it is possible that some transaction has an implicit
    x-lock. We have to look in the clustered index. */

  } else {
    trx = row_vers_impl_x_locked(rec, index, offsets);
  }

  return (trx);
}
```

[`lock0lock.cc#L1001`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L1001)、コメントは [L1028-1029](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L1028)。**重い `row_vers_impl_x_locked` に入る前に、`can_older_trx_be_still_active(max_trx_id)` というもう 1 段のゲートがある。** これは [セカンダリインデックスと MVCC](./secondary-index-visibility/) で見た `PAGE_MAX_TRX_ID` と同じ値を、可視性ではなく「暗黙ロックの持ち主がまだアクティブでありうるか」の判定に転用したものだ ([`lock0lock.cc#L961`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L961))。関数コメントが返り値の意味を明記している。

- `false`: 「もし呼び出し元が以前に `trx_id` によって変更された記録を見ていて、かつ `trx_id < max_old_active_id` なら、そのトランザクションはもうアクティブではないと仮定してよい」
- `true`: 「呼び出し元は、見た `trx_id` がまだアクティブかどうかを同期された方法で再確認すべき」

**このゲートで `false` が返れば、`row_vers_impl_x_locked` は一度も呼ばれない。** 更新頻度の低いセカンダリインデックスでは、この早期リターンで済むケースが多い。逆に言うと、**高頻度に更新される行を持つセカンダリインデックスでは、このゲートがほぼ常に `true` を返すため、実質毎回クラスタードまで降りることになる。**

### `row_vers_impl_x_locked` — 現在版を読まずに判定する

```cpp title="storage/innobase/row/row0vers.cc"
trx_t *row_vers_impl_x_locked(const rec_t *rec, const dict_index_t *index,
                              const ulint *offsets) {
  mtr_t mtr;
  trx_t *trx;
  const rec_t *clust_rec;
  dict_index_t *clust_index;

  ut_ad(!locksys::owns_exclusive_global_latch());
  ut_ad(!trx_sys_mutex_own());

  mtr_start(&mtr);

  clust_rec =
      row_get_clust_rec(BTR_SEARCH_LEAF, rec, index, &clust_index, &mtr);

  if (!clust_rec) {
    trx = nullptr;
  } else {
    trx = row_vers_impl_x_locked_low(clust_rec, clust_index, rec, index,
                                     offsets, &mtr);

    ut_ad(trx == nullptr || trx_is_referenced(trx));
  }

  mtr_commit(&mtr);

  return (trx);
}
```

[`lock0lock.cc` から呼ばれる公開関数は `row0vers.cc#L528`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0vers.cc#L528)。**`row_get_clust_rec` が新しい `mtr` の下で PK 検索を行い、対象セカンダリページとは別のクラスタードページを latch する。** これが [行ロックとページラッチの継ぎ目](./locks-and-page-latches/) で説明した「変換だけがシャード latch の外にある」理由の実体だ——ここで新たなページラッチが要る以上、対象ページのシャード latch を持ったままこの関数を呼ぶことはできない。

中核の `row_vers_impl_x_locked_low` はまず現在版の `trx_id` (= `DB_TRX_ID`) を 1 回だけ読む。

```cpp title="storage/innobase/row/row0vers.cc"
  trx_id = row_get_rec_trx_id(clust_rec, clust_index, clust_offsets);

  trx_t *trx = trx_rw_is_active(trx_id, true);

  if (trx == nullptr) {
    /* The transaction that modified or inserted clust_rec is no
    longer active, or it is corrupt: no implicit lock on rec */
    ...
    return nullptr;
  }
```

[`row0vers.cc#L298`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0vers.cc#L298) の関数本体、上のコードは L496 から。**現在版の `trx_id` がすでに非アクティブなら、それより古い版の `trx_id` もすべて非アクティブと確定できるので、ここで打ち切れる。** これがまさに冒頭の「現在版のフィールドを二度と読まない」設計の起点で、関数先頭のロングコメント ([L307 から続く](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0vers.cc#L307)) が `could-be-authored-by` / `was-authored-by` という関係を定義したうえで、この 1 点読みだけで判定が完結する理由を証明している。要旨は次の 2 点だ。

> The implementation is tricky, as it tries hard to avoid ever looking at the C[current_version], instead looking only at older versions. (One reason for this effort, IMHO, is that virtual columns might be expensive to materialize, and are not stored in clustered index at all. Another reason, I guess, might be to have only one way of reading data - from undo log).

[`row0vers.cc#L436-440`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0vers.cc#L436)。**セカンダリの葉に版がないという制約が、ここでは「クラスタードの現在版すら見ない」という、さらに一段ストイックなアルゴリズムを要求している。**

### 変換を呼ぶ場所・呼ばない場所

`lock_rec_convert_impl_to_expl` の呼び出し元は `lock0lock.cc` 全体でちょうど 3 箇所ある。

```
$ git grep -n "lock_rec_convert_impl_to_expl(" -- storage/innobase/lock/lock0lock.cc
5301: (定義)
5378: lock_clust_rec_modify_check_and_lock の中
5481: lock_sec_rec_read_check_and_lock の中
5530: lock_clust_rec_read_check_and_lock の中
```

読み取り側 2 つは条件が微妙に違う。

```cpp title="storage/innobase/lock/lock0lock.cc"
  heap_no = page_rec_get_heap_no(rec);

  if (!page_rec_is_supremum(rec)) {
    lock_rec_convert_impl_to_expl(block, rec, index, offsets);
  }
```

[`lock_sec_rec_read_check_and_lock` (`lock0lock.cc#L5460`) の L5478-5481](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5478) は `!page_rec_is_supremum(rec)` で判定する。一方クラスタード側は `heap_no != PAGE_HEAP_NO_SUPREMUM` という同値だが違う書き方の条件を使う ([`lock_clust_rec_read_check_and_lock` (L5509) の L5527-5530](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5527))。**どちらも supremum 擬似レコードだけは除外している**——supremum は実データを持たないので `DB_TRX_ID` も存在せず、暗黙ロックの概念自体が適用できない。

書き込み側で呼ぶのはクラスタードだけだ。

```cpp title="storage/innobase/lock/lock0lock.cc"
  /* If a transaction has no explicit x-lock set on the record, set one
  for it */

  lock_rec_convert_impl_to_expl(block, rec, index, offsets);
```

[`lock_clust_rec_modify_check_and_lock` (`lock0lock.cc#L5350`) の L5375-5378](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5375)。対して `lock_sec_rec_modify_check_and_lock` (L5402) は変換を一切呼ばない。

```cpp title="storage/innobase/lock/lock0lock.cc"
  /* Another transaction cannot have an implicit lock on the record,
  because when we come here, we already have modified the clustered
  index record, and this would not have been possible if another active
  transaction had modified this secondary index record. */
  {
    locksys::Shard_latch_guard guard{UT_LOCATION_HERE, block->get_page_id()};
    ...
    err = lock_rec_lock(true, SELECT_ORDINARY, LOCK_X | LOCK_REC_NOT_GAP, block,
                        heap_no, index, thr);
```

[`lock0lock.cc#L5402`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5402) のコメント (L5430-5433)。**セカンダリを書き換える前に必ずクラスタードを書き換えているので、その時点で自分がすでに (暗黙または明示の) X ロックを確保している。他人が割り込んで暗黙ロックを持つ余地がない。** だから変換のコストをここでもう一度払う必要がない。「読み取りと未確認の書き込みは変換が要る、確認済みの書き込みは要らない」という非対称性がここに現れている。

## どう活かすか

**「`data_locks` に見えないのに UPDATE が待たされる」のは正常な挙動として説明できる。** ある行を最後に更新したトランザクションがまだアクティブなら、その行には暗黙 X ロックが (`lock_t` を伴わずに) 存在する。`performance_schema.data_locks` にそのロックは載らないので、「ロックが 0 件なのに UPDATE が刺さっている」ように見えるが、実際には `lock_rec_convert_impl_to_expl` が動いて明示ロックに変換された**あと**の状態を見ていることが多い。変換直前のタイミングを取ればまだ `data_locks` に出ていない可能性もある。**`data_locks` は「今 `lock_t` が存在する行の一覧」であって「今ロックされている行の完全な一覧」ではない**、と読み替える必要がある。

**高頻度に更新される行を持つセカンダリインデックスは、読み取りのたびにクラスタードへの追加アクセスを暗黙に発生させることがある。** `lock_sec_rec_read_check_and_lock` (`SELECT ... FOR UPDATE` / `FOR SHARE` などロックを伴う読み取り) がそのセカンダリ行を通ると、`can_older_trx_be_still_active` のゲートが `true` になりやすいホットな行では、ほぼ毎回 `row_vers_impl_x_locked` → クラスタードの版鎖遡りが走る。**通常の非ロッキング SELECT (`lock_sec_rec_cons_read_sees` 経由) が引く「二度引き」** ([セカンダリインデックスと MVCC](./secondary-index-visibility/)) **とは別に、ロックを伴う読み取りにも同じ形のコストがある**、という点を押さえておくと、ロッキング読み取りのプロファイルで説明のつかない遅さに出会ったときの候補が増える。

**`SHOW ENGINE INNODB STATUS` や `data_locks` の行数から「このテーブルの実効ロック件数」を逆算しない。** 暗黙ロックはこれらのどこにもカウントされない。ロック競合の全体像を掴みたいなら、実際に競合が起きて変換が走った瞬間 (待ちが発生した瞬間) の `data_locks` / `data_lock_waits` を見るしかなく、平常時のスナップショットは実態を過小評価する。

## 最終確認用の一覧

本文で引用した関数名・行番号 (すべて `mysql-8.4.11` タグでの `git show` 済み)。

| ファイル                                | シンボル/内容                                                 | 行                                              |
| --------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| `storage/innobase/include/lock0priv.h`  | `lock_clust_rec_some_has_impl` 宣言                           | L940                                            |
| `storage/innobase/include/lock0priv.ic` | `lock_clust_rec_some_has_impl` 実体                           | L52                                             |
| `storage/innobase/include/trx0trx.h`    | `trx_is_referenced`                                           | L1246                                           |
| `storage/innobase/include/trx0trx.ic`   | `trx_reference`                                               | L219                                            |
| `storage/innobase/include/trx0trx.ic`   | `trx_release_reference`                                       | L230                                            |
| `storage/innobase/include/trx0sys.ic`   | `trx_rw_is_active` 内の `trx_reference` 呼び出し              | L218-222                                        |
| `storage/innobase/lock/lock0lock.cc`    | `can_older_trx_be_still_active`                               | L961                                            |
| `storage/innobase/lock/lock0lock.cc`    | `static trx_t *lock_sec_rec_some_has_impl`                    | L1001 (`row_vers_impl_x_locked` 呼び出し L1032) |
| `storage/innobase/lock/lock0lock.cc`    | `static void lock_rec_convert_impl_to_expl_for_trx`           | L5245 (`trx_release_reference` L5296)           |
| `storage/innobase/lock/lock0lock.cc`    | `void lock_rec_convert_impl_to_expl`                          | L5301                                           |
| `storage/innobase/lock/lock0lock.cc`    | `dberr_t lock_clust_rec_modify_check_and_lock`                | L5350 (変換呼び出し L5378)                      |
| `storage/innobase/lock/lock0lock.cc`    | `dberr_t lock_sec_rec_modify_check_and_lock` (変換を呼ばない) | L5402                                           |
| `storage/innobase/lock/lock0lock.cc`    | `dberr_t lock_sec_rec_read_check_and_lock`                    | L5460 (変換呼び出し L5481)                      |
| `storage/innobase/lock/lock0lock.cc`    | `dberr_t lock_clust_rec_read_check_and_lock`                  | L5509 (変換呼び出し L5530)                      |
| `storage/innobase/row/row0vers.cc`      | `static inline trx_t *row_vers_impl_x_locked_low`             | L298 (現在版 `trx_id` 読み取り L496)            |
| `storage/innobase/row/row0vers.cc`      | 設計コメント (`could-be-authored-by` / `was-authored-by`)     | L307-485                                        |
| `storage/innobase/row/row0vers.cc`      | `trx_t *row_vers_impl_x_locked`                               | L528                                            |
