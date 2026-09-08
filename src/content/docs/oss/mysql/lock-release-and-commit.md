---
title: "ロックの解放 — 取るときより離すときのほうが latch 戦略が要る"
description: "ロックを取るときは対象ページのシャード latch を 1 枚取れば済むが、離すときはトランザクションが持つ全ロックが散らばった複数シャードにまたがる。lock_trx_release_read_locks は共有 latch で 5 回まで試し、失敗し続けたら global exclusive latch に切り替えて片付け切る。全ロック解放にも同じ形のリトライがあり、AUTO-INC ロックの解放は「持っているかもしれない」という heuristic で exclusive latch を避けている。"
group: "InnoDB — トランザクション・MVCC・ロック"
sidebar:
  order: 91
---

> **前提**: [ロックの種類 (InnoDB)](./lock-modes-and-types/) / [行ロックとページラッチの継ぎ目](./locks-and-page-latches/)

## 何を学んだか

ロックを「取る」側のコードは、この章の他のページで何度も見てきた。対象ページの lock_sys シャード latch を 1 枚取り、`lock_rec_lock` を呼び、latch を放す ([行ロックとページラッチの継ぎ目](./locks-and-page-latches/))。1 個のロックは 1 個のシャードに閉じているので、latch も 1 枚で済む。

「離す」側は形が違う。**トランザクションが持つロックは複数のページ、つまり複数の lock_sys シャードにまたがっている。** 1 枚の latch では足りず、かといって毎回 1 個ずつシャードを特定して取り直すのはそれはそれで高くつく。読んでみると、InnoDB はこの問題に**「まず安い方法を何回か試し、駄目なら高い方法で確実に片付ける」**という同じ形のリトライを、少なくとも 2 か所 (読みロックの早期解放、トランザクション終了時の全解放) で採用していた。

- **`lock_trx_release_read_locks`** (RC 以下の XA PREPARE で使う早期解放) は、共有 latch (`Global_shared_latch_guard`) で最大 5 回試し、5 回とも失敗したら global exclusive latch に切り替えて**成功するまで**回す。exclusive latch を持つ時間には `MAX_CS_DURATION` (1 秒) という明示的な上限があり、超えたら呼び出し元にリトライさせる
- **`lock_trx_release_locks`** (コミット/ロールバック時の全解放) も同じ形で、`try_release_all_locks` を `while (!...)` で回す。ただし早期解放と違い、失敗したときの「次の一手」は用意されていない——**成功するまでただ回り続ける**だけだ
- **AUTO-INC ロックの解放**は方向が逆で、**「本当に持っているか分からないので、まず安い heuristic チェックをして、持っていそうなときだけ exclusive latch を取りに行く」**という形になっている

そして、解放の実装を見て初めて分かったことがある。**「S モードで複数回試す」設計は、シャード latch を個別に取り直すのではなく、`Global_shared_latch_guard` という global latch の共有モードを使っている。** つまり早期解放の「安い方」も、実は lock_sys 全体に対する latch を (共有モードとはいえ) 取っている。安いのはシャード数ではなく、他の共有 latch 保持者と衝突しないことだ。

## なぜそうなっているか

**シャードをまたぐ解放を「シャードを 1 個ずつ特定して latch し直す」方式にしなかったのは、latch order が `trx->mutex` より lock_sys latch を先に取れと要求するからだ。** `trx->lock.trx_locks` を安全に走査するには `trx->mutex` が要るが、その状態で個々のロックが属するシャードの latch を新たに取ろうとすると、latch order 違反になる (シャード latch は `trx->mutex` より**先に**取るべきものだから)。かといって `trx->mutex` を先に手放してから走査し直すと、走査中にリストが書き換わる可能性がある。**global latch (共有モードなら他の読み手とは衝突しない) を先に取ってから `trx->mutex` を取り直す**ことで、この順序制約を守りながらリストを安全に触れるようにしている。

**5 回で見切りを付けて exclusive latch に切り替えるのは、共有 latch 側の設計が「進捗があれば譲る」ことを前提にしているからだ。** 共有 latch 版は 1 個ロックを外すたびに `trx->mutex` を手放してシャード latch を取り直す ([`try_relatch_trx_and_shard_and_do`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L3970))。その間にリストが変わればやり直しになるし、**自分の共有 latch が誰かの exclusive latch 取得を妨げているなら、進捗が 1 つでもあった時点で自主的に降りる** (`shared_latch_guard.is_x_blocked_by_us()`)。並行度の高い環境では、これが 5 回のうちに収束しないことがある——そこで「収束を待つ」から「確実に終わる」に切り替えるのが exclusive モードの役割だ。

**exclusive latch 側にだけ `MAX_CS_DURATION` の上限があるのは、それが lock_sys 全体を止める最も重い操作だからだ。** 共有 latch 側は他の共有 latch 保持者を止めない。exclusive latch は `lock_wait_timeout_thread` を含む全員を止める ([デッドロック検出のページ](./deadlock-detection/)の `Global_exclusive_latch_guard` と同じ仕組み)。1 秒という時間で区切って呼び出し元にリトライさせるのは、**「確実に終わらせる」ことと「lock_sys を長時間独占しない」ことの両立**が必要だからだ。

**全ロック解放 (`lock_trx_release_locks`) に「見切り」がないのは、そこがトランザクション終了という後戻りできない地点だからだ。** 早期解放 (RC の PREPARE 中) は「今回は諦めて後で再試行する」余地があるが、コミット/ロールバックの完了はトランザクションの寿命そのものを終わらせる操作で、先延ばしにできない。だから `while (!try_release_all_locks(trx)) std::this_thread::yield();` は失敗の上限を設けず、成功するまで単純に回る。

**AUTO-INC ロックの解放だけ heuristic 先行になっているのは、どのシャードを exclusive latch すればよいか事前に分からないからだ。** テーブルは複数のシャードに散らばりうるので、「持っているシャードだけ latch する」という最適化ができない。だから `lock_release_autoinc_locks` は無条件に **global exclusive latch を要求する**。その代わり、そもそも AUTO-INC ロックを 1 本も持っていないトランザクション (大半がこれに当たる) では、`trx->mutex` だけで完結する軽いチェック (`lock_trx_holds_autoinc_locks`) で早期リターンし、exclusive latch そのものを回避する。**重い latch を取る前に、安い mutex で「取る価値があるか」を判定する**という、早期解放とは逆方向のコスト削減になっている。

## ソースコードのどこか

### 早期解放 — S モードで 5 回、駄目なら X モード

```cpp title="storage/innobase/lock/lock0lock.cc"
void lock_trx_release_read_locks(trx_t *trx, bool only_gap) {
  ut_ad(trx_can_be_handled_by_current_thread(trx));

  const size_t MAX_FAILURES = 5;

  for (size_t failures = 0; failures < MAX_FAILURES; ++failures) {
    if (locksys::try_release_read_locks_in_s_mode(trx, only_gap)) {
      return;
    }
    std::this_thread::yield();
  }

  while (!locksys::try_release_read_locks_in_x_mode(trx, only_gap)) {
    std::this_thread::yield();
  }
}
```

[`lock0lock.cc#L4103`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L4103)。呼び出し元は XA PREPARE ([RR と RC のページ](./locking-in-rr-vs-rc/)の「5. XA PREPARE でギャップロックを手放す」で経路は解説済み) で、ここでは中身だけを見る。

S モード側 (`try_release_read_locks_in_s_mode`, [L4020](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L4020)) の骨格。

```cpp title="storage/innobase/lock/lock0lock.cc"
[[nodiscard]] static bool try_release_read_locks_in_s_mode(trx_t *trx,
                                                            bool only_gap) {
  locksys::Global_shared_latch_guard shared_latch_guard{UT_LOCATION_HERE};
  trx_mutex_enter(trx);
  ut_ad(trx->lock.wait_lock == nullptr);

  bool made_progress{false};
  for (auto lock : trx->lock.trx_locks.removable()) {
    ut_ad(trx_mutex_own(trx));
    const auto release_read_lock = [lock, only_gap, &made_progress]() {
      made_progress |= lock_release_read_lock(lock, only_gap);
    };
    if (lock_get_type_low(lock) == LOCK_REC) {
      if (!try_relatch_trx_and_shard_and_do(lock, release_read_lock) ||
          (made_progress && shared_latch_guard.is_x_blocked_by_us())) {
        trx_mutex_exit(trx);
        return false;
      }
    }
  }
  trx_mutex_exit(trx);
  return true;
}
```

コメントが冒頭で設計選択を説明している (要約)。「`trx->lock.trx_locks` を安全に読むには `trx->mutex` が要るが、latch order 上 `trx->mutex` は lock_sys latch の**後**にしか取れない。lock_sys 全体を exclusive latch すれば解決するが、それは TPS を最大 10% 落とす。だから、(1) `trx->mutex` 下でロックを 1 個取り出す (2) 属するシャードを特定する (3) `trx->lock.trx_locks_version` を保存する (4) `trx->mutex` を放す (5) シャード latch を取る (6) `trx->mutex` を取り直す (7) version が変わっていないか確かめる (8) 変わっていなければ操作する、という手順を踏む」。

**やり直し条件は 2 つ。** `try_relatch_trx_and_shard_and_do` が false を返す (= version が変わった、つまり誰かがリストを書き換えた) か、`made_progress && shared_latch_guard.is_x_blocked_by_us()` (= 進捗が出た時点で、自分の共有 latch が誰かの exclusive latch 取得を妨げている) のどちらかだ。**後者は「うまくいっているのに自主的にやめる」条件**であることに注意——効率より他スレッドへの譲歩を優先している。

X モード側 (`try_release_read_locks_in_x_mode`, [L4080](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L4080))。

```cpp title="storage/innobase/lock/lock0lock.cc"
constexpr auto MAX_CS_DURATION = std::chrono::seconds{1};

[[nodiscard]] static bool try_release_read_locks_in_x_mode(trx_t *trx,
                                                            bool only_gap) {
  ut_ad(!trx_mutex_own(trx));
  Global_exclusive_latch_guard guard{UT_LOCATION_HERE};
  const auto started_at = std::chrono::steady_clock::now();
  trx_mutex_enter_first_of_two(trx);

  for (auto lock : trx->lock.trx_locks.removable()) {
    if (MAX_CS_DURATION < std::chrono::steady_clock::now() - started_at) {
      trx_mutex_exit(trx);
      return false;
    }
    lock_release_read_lock(lock, only_gap);
  }

  trx_mutex_exit(trx);
  return true;
}
```

`MAX_CS_DURATION` は [`lock0lock.cc#L4010`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L4010) の定数で、直前のコメントが理由を書いている——「global latch を S モードであっても長時間持ちたくない。`lock_wait_timeout_thread` のような X latch 待ちのスレッドを飢えさせないため」。**exclusive latch を取っている間は lock_sys 全体が止まる**ので、この 1 秒という上限は「確実に終わらせる」ことと「他のスレッドを長時間ブロックしない」ことの妥協点になっている。

どちらのモードも `lock_release_read_lock` ([`lock0lock.cc#L3936`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L3936)) を呼ぶ。

```cpp title="storage/innobase/lock/lock0lock.cc"
static bool lock_release_read_lock(lock_t *lock, bool only_gap) {
  if (!lock->is_record_lock() || lock->is_insert_intention() ||
      lock->is_predicate()) {
    return false;
  } else if (lock->is_gap()) {
    lock_rec_dequeue_from_page(lock);
    return true;
  } else if (lock->is_record_not_gap() && only_gap) {
    return false;
  } else if (lock->mode() == LOCK_S && !only_gap) {
    lock_rec_dequeue_from_page(lock);
    return true;
  } else {
    lock_release_gap_lock(lock);
    return true;
  }
}
```

**この関数だけで「何を解放するか」の全判断が閉じている。** insert intention と predicate lock (GIS) は対象外、GAP のみのロックは丸ごと外す、`only_gap=true` (RC の PREPARE 時) では `LOCK_REC_NOT_GAP` を残す、next-key lock (`LOCK_S` + GAP) は `only_gap` の値によってギャップ部分だけ外すか丸ごと外すかが変わる。コメントに「`lock_edge_may_survive_prepare()` と同期を保つこと」とあり、デッドロック検出側の判定 ([RR と RC のページ](./locking-in-rr-vs-rc/)の `lock_edge_may_survive_prepare`) と対になっている。

### 全ロック解放 — 同じ形だが「見切り」がない

トランザクション終了時の解放は [`lock_trx_release_locks`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5904) が入口で、暗黙ロック変換の参照カウント待ちを含む全体の流れは[コミットとロールバックのページ](./commit-and-rollback-internals/)で扱った。ここでは latch の取り回しだけを見る。

```cpp title="storage/innobase/lock/lock0lock.cc"
  while (!locksys::try_release_all_locks(trx)) {
    std::this_thread::yield();
  }

  trx_mutex_enter(trx);
  trx->lock.n_rec_locks.store(0);

  ut_a(UT_LIST_GET_LEN(trx->lock.trx_locks) == 0);
  ut_a(ib_vector_is_empty(trx->lock.autoinc_locks));

  mem_heap_empty(trx->lock.lock_heap);
  trx_mutex_exit(trx);
```

[L5931](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5931) の `while` と、その後 [L5953](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5953) の `mem_heap_empty`。**早期解放と違い、失敗しても次の一手 (X モードへの切り替え) がなく、成功するまで単純に回るだけだ。** トランザクション終了という後戻りできない操作なので、「今回は諦める」という選択肢自体がない。

`try_release_all_locks` ([L4125](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L4125)) の形は S モードの早期解放とほぼ同じ (`Global_shared_latch_guard` → `trx->mutex` → 1 個ずつ `try_relatch_trx_and_shard_and_do`) だが、2 つ違いがある。

1. **近道がある。** `UT_LIST_GET_LEN(trx->lock.trx_locks) == 0` なら latch を 1 枚も取らずに即 `true` を返す。読み取り専用のコミットなど、ロックを 1 本も持たないトランザクションはこの経路で終わる
2. **X モードが無い。** 失敗したら (`is_x_blocked_by_us()`) 呼び出し元に false を返すだけで、S 版に対応する専用の exclusive フォールバック関数は無い——`while` ループが同じ S モードの関数をただ再試行する

解放し終えたあと、**`lock_t` を 1 個ずつ `free` せず `mem_heap_empty` でヒープごと空にする。** `trx->lock.lock_heap` はロック専用のメモリヒープで、ロックはここから確保される ([L1166](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L1166) や [L3289](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L3289) の `lock_alloc_from_heap`)。個々の解放処理はすでにリストとハッシュテーブルからロックを外し終えているので、残るメモリの回収はヒープを丸ごと空にするだけで済む。**N 回の `free` を 1 回の `mem_heap_empty` に潰している。**

### 解放は次の許可をその場でトリガーする

`lock_release_read_lock` が呼ぶ `lock_rec_dequeue_from_page` の中身は 2 行しかない。

```cpp title="storage/innobase/lock/lock0lock.cc"
static void lock_rec_dequeue_from_page(lock_t *in_lock) {
  lock_rec_discard(in_lock);
  lock_rec_grant(in_lock);
}
```

[`lock0lock.cc#L2325`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L2325)。**外す (`lock_rec_discard`) と、次を許可できないか調べる (`lock_rec_grant`) が同じ関数、同じシャード latch の中で連続して起きる。** キューの中身をどう並べ替えて誰を先に許可するかという判断は CATS のアルゴリズムに委ねられていて、ここでは扱わない ([CATS のページ](./lock-scheduling-cats/))。押さえておきたいのは、**「1 個のロックを解放する」という操作が、それ単体では終わらず、同じ latch 保持区間の中でキューの再評価まで連鎖する**という事実だけだ。全ロック解放 (`try_release_all_locks`) が呼ぶ `lock_rec_dequeue_from_page` / `lock_table_dequeue` も同じ経路を通るので、コミット 1 回の裏で複数の WAITING ロックが連鎖的に GRANTED へ変わることがある。

### AUTO-INC ロックの解放 — heuristic で exclusive latch を避ける

文の終わりに呼ばれる [`lock_unlock_table_autoinc`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5850) ([コミットとロールバックのページ](./commit-and-rollback-internals/)の「文の終わりで解放されるもの」)。

```cpp title="storage/innobase/lock/lock0lock.cc"
  trx_mutex_enter(trx);
  ut_ad(!trx->lock.wait_lock);
  bool might_have_autoinc_locks = lock_trx_holds_autoinc_locks(trx);
  trx_mutex_exit(trx);

  if (might_have_autoinc_locks) {
    /* lock_release_autoinc_locks() requires exclusive global latch as the
    AUTOINC locks might be on tables from different shards. Identifying and
    latching them in correct order would complicate this rarely-taken path. */
    locksys::Global_exclusive_latch_guard guard{UT_LOCATION_HERE};
    trx_mutex_enter(trx);
    lock_release_autoinc_locks(trx);
    trx_mutex_exit(trx);
  }
```

[L5887-5896](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5887)。`lock_trx_holds_autoinc_locks` ([L5628](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5628)) は `trx->mutex` だけで読める `ib_vector_t` の空チェックで、コメントいわく**厳密には heuristic** (`lock_grant` が別スレッドから追加する可能性があるので、`false` の結果だけが確実に保証される)。`true` が返ったときだけ [L5894](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5894) の `Global_exclusive_latch_guard` を取る。**AUTO-INC ロックを持たない大多数の文はこの exclusive latch を一切取らずに終わる。**

`lock_release_autoinc_locks` ([L5639](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5639)) 自身のコメントが exclusive latch が要る理由を明言している——「どのテーブル (どのシャード) にロックを作ったか分からないので、絞り込めない」。ここは早期解放の S モードとは逆の設計で、**「シャードを特定してピンポイントに latch する」ことを最初から諦めている**分、判定コード自体は単純だ。

### RC の早期解放が要る理由 (ドキュメントコメント)

`lock0lock.h` 冒頭の設計コメントに、ロックのライフサイクルを 4 段階で説明した箇所がある。

> The life cycle of a lock is usually as follows:
> ... 3. A WAITING lock either becomes GRANTED ... or ... it gets canceled. 4. Once the transaction is finishing (due to commit or rollback) it releases all of its locks.
>
> @remark For performance reasons, in Read Committed and weaker Isolation Levels there is also a Step in between 3 and 4 in which we release some of the read locks on gaps, which is done to minimize risk of deadlocks during replication.

[`lock0lock.h#L108-L119`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/lock0lock.h#L108)。**「3 と 4 の間」という表現がそのまま `lock_trx_release_read_locks` の呼び出しタイミング (XA PREPARE、コミット確定前)** を指している。目的は「レプリケーション時のデッドロックリスクを下げる」ことだと明記されており、この設計理由と呼び出し経路の詳細は[RR と RC のページ](./locking-in-rr-vs-rc/)の「5. XA PREPARE でギャップロックを手放す」に譲る。

## どう活かすか

**長時間トランザクションが大量の読みロックを持っていると、コミット/PREPARE 時の解放そのものが重くなりうる。** S モードでの解放は 1 個のロックを外すたびに `trx->mutex` を手放してシャード latch を取り直すので、ロック数に比例して往復コストがかかる。5 回失敗すると exclusive latch モードに落ち、そこでは **lock_sys 全体が (最大 1 秒間) 止まる。** 「コミットが遅い」という症状の原因が、書き込み量ではなくロック本数 (多数のテーブルを `SELECT ... FOR SHARE` で触った読み取りロック) にあることがある。

**この重さは PFS の待ちイベントから間接的に見える。** `lock_trx_release_read_locks` / `try_release_all_locks` 自体を指す専用の instrument はないが、exclusive latch 区間はデッドロック検出と同じ `Global_exclusive_latch_guard` を通るので、lock_sys の rw-lock に対応する `wait/synch/rwlock/...lock_sys...` 系の PFS instrument の待ち時間が伸びる ([ラッチとミューテックス](./latches-and-mutexes/)の「PFS から見る」)。**コミット遅延を疑ったら、まずこの instrument の `sum_timer_wait` を見る。**

**RC を選ぶ理由の 1 つに「ロック保持時間を削れる」がある、という設計意図がここまで読むとより具体的になる。** RR ならコミットまで持ち続けるギャップロックを、RC なら PREPARE の時点で `lock_trx_release_read_locks` が前倒しで外す。ただしこれは「タダで速くなる」わけではなく、**解放処理自体が上で見た S/X モードの切り替えコストを払う**——RR なら 1 回で済む解放が、RC では PREPARE 時と最終解放時の 2 回に分かれるとも言える。トレードオフの中身を知っておくと、「RC にしたのにコミットが速くならない」ケースを説明しやすい。

**AUTO-INC ロックの解放コードは、レアケースのために全体を犠牲にしない設計の実例になっている。** 「どのシャードか分からない」という情報不足を、シャードの事前特定ではなく「まず安い判定で対象外を弾く」ことで解決している。同じ形は、自分で「複数のパーティションにまたがるかもしれないリソースを解放する」コードを書くときに使える——**exclusive なロックを取る前に、そもそも取る必要があるかを安い手段で確認する。**

## 最終確認用の一覧

本文で引用した関数名・行番号 (すべて `mysql-8.4.11` タグでの `git show` 済み)。

| ファイル                               | シンボル/内容                                                         | 行                 |
| -------------------------------------- | --------------------------------------------------------------------- | ------------------ |
| `storage/innobase/include/lock0lock.h` | ライフサイクル説明中、RC の早期解放に関する `@remark`                 | L108-L119          |
| `storage/innobase/lock/lock0lock.cc`   | `lock_rec_dequeue_from_page` (discard + grant)                        | L2325              |
| `storage/innobase/lock/lock0lock.cc`   | `static bool lock_release_read_lock`                                  | L3936              |
| `storage/innobase/lock/lock0lock.cc`   | `constexpr auto MAX_CS_DURATION`                                      | L4010              |
| `storage/innobase/lock/lock0lock.cc`   | `static bool try_release_read_locks_in_s_mode`                        | L4020              |
| `storage/innobase/lock/lock0lock.cc`   | `static bool try_release_read_locks_in_x_mode`                        | L4080              |
| `storage/innobase/lock/lock0lock.cc`   | `void lock_trx_release_read_locks` (`MAX_FAILURES = 5`)               | L4103 (定数 L4106) |
| `storage/innobase/lock/lock0lock.cc`   | `static bool try_release_all_locks`                                   | L4125              |
| `storage/innobase/lock/lock0lock.cc`   | `static bool lock_trx_holds_autoinc_locks`                            | L5628              |
| `storage/innobase/lock/lock0lock.cc`   | `static void lock_release_autoinc_locks`                              | L5639              |
| `storage/innobase/lock/lock0lock.cc`   | `void lock_unlock_table_autoinc` (heuristic 判定 L5887、guard L5894)  | L5850              |
| `storage/innobase/lock/lock0lock.cc`   | `void lock_trx_release_locks` (`while` L5931、`mem_heap_empty` L5953) | L5904              |

前提群と重複する内容は本文中のリンク先に委ねている——RC の早期解放の呼び出し経路とデッドロック検出側の対応 ([locking-in-rr-vs-rc.md](./locking-in-rr-vs-rc/))、コミット/ロールバック全体の順序と参照カウント待ち ([commit-and-rollback-internals.md](./commit-and-rollback-internals/))、解放後の CATS による再スケジューリング ([lock-scheduling-cats.md](./lock-scheduling-cats/))、テーブルロックと AUTO-INC ロックの取得側 ([table-and-intention-locks.md](./table-and-intention-locks/))、ギャップロックの継承 ([lock-inheritance-and-page-changes.md](./lock-inheritance-and-page-changes/))、XA PREPARE でのロック保持の性質 ([xa-and-savepoint.md](./xa-and-savepoint/))。
