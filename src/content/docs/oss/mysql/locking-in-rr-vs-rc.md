---
title: "RR と RC の違い — ギャップロックが消える場所"
description: "REPEATABLE READ と READ COMMITTED の差は、trx_t の 4 つの述語 (skip_gap_locks / allow_semi_consistent / releases_non_matching_rows / releases_gap_locks_at_prepare) にほぼ集約されている。使われているのは主に row0sel.cc・row0ins.cc・ha_innodb.cc・trx0trx.cc で、lock0lock.cc には 2 箇所しか出てこない。RC でもギャップロックが消えない場所と、RC が ROW binlog を要求する理由まで含めて差分だけを並べる。"
group: "InnoDB — トランザクション・MVCC・ロック"
sidebar:
  order: 72
---

> **前提**: [ロックの種類 (InnoDB)](./lock-modes-and-types/) / [分離レベルとアノマリ](./isolation-levels-and-anomalies/)

## 何を学んだか

この章の他のページはすべて REPEATABLE READ (InnoDB の既定) を基準に書いている。このページはその差分だけを扱う。

読んで一番意外だったのは、**「RC ではギャップロックを取らない」という判断が `lock0lock.cc` にほとんど書かれていない**ことだった。6289 行あるこのファイルで分離レベルを見ているのは 2 箇所 (ロックの継承と、PREPARE で消える待ち辺の判定) だけで、**ロックの種類そのものは呼び出し側が `type_mode` に載せて渡してくる**。RR と RC の差は呼び出し側が `LOCK_ORDINARY` を渡すか `LOCK_REC_NOT_GAP` を渡すかであり、その判断は `trx_t` の 4 つの述語に集約されている。

```cpp title="storage/innobase/include/trx0trx.h"
  bool releases_gap_locks_at_prepare() const {
    return isolation_level <= READ_COMMITTED;
  }

  bool skip_gap_locks() const {
    switch (isolation_level) {
      case READ_UNCOMMITTED:
      case READ_COMMITTED:
        return (true);
      case REPEATABLE_READ:
      case SERIALIZABLE:
        return (false);
    }
    ...
  }

  bool allow_semi_consistent() const { return (skip_gap_locks()); }
  ...
  bool releases_non_matching_rows() const { return skip_gap_locks(); }
```

[`trx0trx.h#L1109-L1131`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/trx0trx.h#L1109)。後ろ 3 つは同じ条件の別名だ。**RC で変わるのは次の 7 つに整理できる。**

1. スナップショットが文ごとに作り直される
2. ロック読み・UPDATE / DELETE の走査でギャップロックを取らない
3. 条件に合わなかった行のロックを外す
4. semi-consistent read が有効になる (UPDATE がロック待ちを回避する)
5. XA PREPARE でギャップロックを先に手放す
6. `INSERT ... SELECT` などの読み側がロックなしの一貫読み取りになる
7. STATEMENT ベースの binlog が使えなくなる

そして**変わらない**ものもある。UNIQUE 制約の重複検査は RC でも next-key lock を取るし、insert intention は分離レベルに関係なく取る。

## なぜそうなっているか

**RR がギャップロックを取るのは、ファントムを防ぐためだ。** `SELECT ... WHERE x BETWEEN 10 AND 20 FOR UPDATE` を 2 回実行して同じ結果を得るには、10〜20 の範囲に他人が挿入できてはいけない。「その範囲に何も挿入させない」を表現するのがギャップロックで、[ロックのページ](./lock-modes-and-types/)の互換表が示すとおり、**ギャップロックの唯一の効果は insert intention をブロックすること**だ。

**RC がギャップを捨てられるのは、ファントムを防がないと決めたからだ。** SQL 標準の READ COMMITTED はファントムを許す。だから範囲を守る必要がなく、レコードだけを押さえれば足りる。並行性は上がり、デッドロックの機会は減る。

**それでも重複検査で next-key を取るのは、UNIQUE 制約が分離レベルより強い保証だからだ。** 「重複がない」はどの分離レベルでも守られなければならない。重複値のレコードとその周辺のギャップを押さえないと、2 つのトランザクションが同時に同じ値を挿入できてしまう。**UNIQUE 制約はファントムを許さない**ので、RC でもギャップが必要になる。

**semi-consistent read が RC 限定なのは、read view を無視するからだ。** 「最後にコミットされた版」を読むのは、RC の「文ごとにスナップショットを取り直す」という性質と整合する。RR でこれをやると、同じトランザクションの中で見えるデータが飛ぶ。だから `allow_semi_consistent()` が `skip_gap_locks()` と同義になっている。

**PREPARE でギャップロックだけ先に解放するのは、2 相コミットの待ち時間を短くするためだ。** PREPARE と COMMIT の間には binlog の書き込みと `fsync` が挟まる ([2PC のページ](./two-phase-commit-and-group-commit/))。その間ギャップロックを持ち続けると、他のセッションの INSERT が止まる。レコードロックは可視性のために最後まで要るが、ギャップロックは「挿入を止める」だけなので、RC なら早く手放してよい。

## ソースコードのどこか

### 1. スナップショットが文ごと

[read view のページ](./read-view-and-visibility/)で扱ったとおり、実装は `ha_innodb.cc` の 2 箇所で `view_close` を呼ぶだけだ。

- [`ha_innobase::store_lock` (L19732)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L19732) — 文の開始側
- [`ha_innobase::external_lock` (L19139)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L19139) — 文の終了側

どちらも `trx->isolation_level <= TRX_ISO_READ_COMMITTED` でガードされている。

### 2. ギャップロックを取らない

`row_search_mvcc` の頭に、この文でギャップロックを使うかどうかを決めるフラグがある。

```cpp title="storage/innobase/row/row0sel.cc"
  if (prebuilt->table->skip_gap_locks() ||
      (trx->skip_gap_locks() && prebuilt->select_lock_type != LOCK_NONE &&
       trx->mysql_thd != nullptr && thd_is_query_block(trx->mysql_thd))) {
    /* It is a plain locking SELECT and the isolation
    level is low: do not lock gaps */
    ...
    set_also_gap_locks = false;
  }
```

[`row0sel.cc#L4776`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L4776)。`dict_table_t::skip_gap_locks()` は別物で、[`dict0dict.ic#L1365`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/dict0dict.ic#L1365) にあるとおり **DD テーブルと SDI テーブル専用**の判定だ (これらは MDL で直列化されるのでギャップロックが要らない)。混同しやすい。

`set_also_gap_locks` が false になると、走査中の 3 種類のギャップロック取得がすべてスキップされる。

- 降順スキャンで次のレコードにギャップロックを置く箇所 ([L4906](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L4906))
- 範囲外に出たときに `LOCK_GAP` を置く箇所 ([L5145](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L5145)、[L5179](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L5179))
- supremum を含む次のレコードに `LOCK_ORDINARY` を置く箇所 ([L5021](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L5021))

さらに、実際にレコードをロックするときの `lock_type` も変わる。ロックの種類を決めるのは [`row_compare_row_to_range` (L4272)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L4272) で、その最初のガード節 ([L4308](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L4308)) がこれだ。

```cpp title="storage/innobase/row/row0sel.cc"
  if (!set_also_gap_locks || trx->skip_gap_locks() ||
      (unique_search && !rec_get_deleted_flag(rec, comp)) ||
      dict_index_is_spatial(index) ||
      (index == clust_index && mode == PAGE_CUR_GE && direction == 0 &&
       ...)) {
    row_to_range_relation.gap_can_intersect_range = false;
    return (row_to_range_relation);
  }
```

`gap_can_intersect_range = false` になると、呼び出し側 ([L5215-L5234](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L5215)) が `LOCK_ORDINARY` ではなく `LOCK_REC_NOT_GAP` を選ぶ。

**この条件式には `trx->skip_gap_locks()` 以外の項目も並んでいる**ことに注目したい。RR であっても

- ユニーク検索で削除マークのないレコードに当たった → ギャップ不要
- クラスタード索引で `>=` 検索し、PK が完全一致した → 手前のギャップに挿入されても検索範囲には入らない

というケースではギャップを外す。**「RR なら常に next-key lock」ではない。** `WHERE id = 1 FOR UPDATE` (PK 一意ヒット) は RR でもレコードだけをロックする。

もう 1 つ、SQL 層を通らない内部の一貫読み取り経路にも同じ判定がある。

```cpp title="storage/innobase/row/row0sel.cc"
    lock_type = trx->skip_gap_locks() ? LOCK_REC_NOT_GAP : LOCK_ORDINARY;
```

[L864](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L864)。

### 3. 条件に合わない行のロックを外す

RC では、走査中に取ったロックのうち **WHERE 条件に合わなかった行の分を解放する**。これがロックの粒度を実質的に「マッチした行だけ」に近づけている。

仕組みは 2 段だ。まず `row_search_mvcc` が「今回新しく作ったロック」を覚える。

```cpp title="storage/innobase/row/row0sel.cc"
      case DB_SUCCESS_LOCKED_REC:
        if (trx->releases_non_matching_rows()) {
          /* Note that a record of
          prebuilt->index was locked. */
          ut_ad(!prebuilt->new_rec_lock[row_prebuilt_t::LOCK_PCUR]);
          prebuilt->new_rec_lock[row_prebuilt_t::LOCK_PCUR] = true;
        }
```

[L5247](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L5247)。`DB_SUCCESS_LOCKED_REC` は**新しいロック構造体を作った**ときにだけ返る。既存のロックを再利用しただけなら `DB_SUCCESS` で、フラグは立たない。

次に、SQL 層が条件不一致と判断すると `handler::unlock_row()` を呼び、[`ha_innobase::unlock_row` (`ha_innodb.cc#L10234`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10234) → [`row_prebuilt_t::try_unlock` (`row0mysql.cc#L2489`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0mysql.cc#L2489) が `lock_rec_unlock` する。

```cpp title="storage/innobase/handler/ha_innodb.cc"
  /* The purpose of unlock_row() is to release locks held on non-matching row
  found during most recent row_search_mvcc() call.
  In higher isolation levels row_try_unlock() is a no-op, as we only set the
  m_prebuilt->new_rec_lock[i] when trx->releases_non_matching_rows().
```

**RR では `new_rec_lock` が立たないので `unlock_row` は何もしない。** 「RR は WHERE に合わない行もロックしたままになる」というよく言われる挙動は、この一行で説明できる。

ソースには「すでに更新した行は解放してはいけない」ことを保証する仕掛けの説明も付いている。新しいロック構造体を作れたということは、それ以前に X ロックを持っていなかったということで、つまりその行をまだ更新していない、という論法だ。

### 4. semi-consistent read

RC (と READ UNCOMMITTED) では、`UPDATE` / `DELETE` の走査が「他人にロックされた行」に当たったとき、待たずに**最後にコミットされた版**を読んで条件を評価できる。条件に合わなければそのまま次の行へ進む。

```cpp title="storage/innobase/handler/ha_innodb.cc"
void ha_innobase::try_semi_consistent_read(bool yes) {
  ut_a(m_prebuilt->trx == thd_to_trx(ha_thd()));

  if (yes && m_prebuilt->trx->allow_semi_consistent()) {
    m_prebuilt->row_read_type = ROW_READ_TRY_SEMI_CONSISTENT;

  } else {
    m_prebuilt->row_read_type = ROW_READ_WITH_LOCKS;
  }
}
```

[`ha_innodb.cc#L10288`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10288)。走査側では、ロック要求を `SELECT_SKIP_LOCKED` に差し替えて「待たされるくらいなら諦める」形にしている。

```cpp title="storage/innobase/row/row0sel.cc"
    /* in case of semi-consistent read, we use SELECT_SKIP_LOCKED, so we don't
    waste time on creating a WAITING lock, as we won't wait on it anyway */
    const bool use_semi_consistent =
        prebuilt->row_read_type == ROW_READ_TRY_SEMI_CONSISTENT &&
        !unique_search && index == clust_index && !trx_is_high_priority(trx);
```

[L5235](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0sel.cc#L5235)。条件に注目したい。**クラスタードインデックスを走っていて、ユニーク検索でないときだけ**有効になる。`DB_SKIP_LOCKED` が返ったら [`row_vers_build_for_semi_consistent_read` (`row0vers.cc#L1359`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0vers.cc#L1359) が版鎖を遡って、`trx_rw_is_active` が false になる最初の版 (= コミット済みの最新版) を返す。

これは read view による一貫読み取りとは別物だ。**read view を無視して「最後にコミットされた版」を読む**ので、`semi-consistent` と呼ばれている。

### 5. XA PREPARE でギャップロックを手放す

```cpp title="storage/innobase/trx/trx0trx.cc"
  /* Release read locks after PREPARE for READ COMMITTED
  and lower isolation. */
  if (trx->releases_gap_locks_at_prepare()) {
    /* Stop inheriting GAP locks. */
    trx->skip_lock_inheritance = true;

    /* Release only GAP locks for now. */
    lock_trx_release_read_locks(trx, true);
  }
```

[`trx_prepare` (`trx0trx.cc#L3024`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/trx/trx0trx.cc#L3024)。[`lock_trx_release_read_locks` (`lock0lock.cc#L4103`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L4103) は共有 latch で 5 回試し、駄目なら global exclusive latch を取って一気に外す。

デッドロック検出側もこれを知っていて、[`lock_edge_may_survive_prepare` (L1394)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L1394) が「相手が RC 以下で、こちらが insert intention なら、その待ち辺は PREPARE で消える」と判定してサーバ層に伝える。

### 6. `INSERT ... SELECT` の読み側がロックを取らない

```cpp title="storage/innobase/handler/ha_innodb.cc"
  } else if ((trx->isolation_level != TRX_ISO_SERIALIZABLE &&
              lock_type == TL_READ && thd_sql_command(thd) == SQLCOM_SELECT) ||
             (trx->skip_gap_locks() &&
              (lock_type == TL_READ || lock_type == TL_READ_NO_INSERT) &&
              (thd_sql_command(thd) == SQLCOM_INSERT_SELECT ||
               thd_sql_command(thd) == SQLCOM_REPLACE_SELECT ||
               thd_sql_command(thd) == SQLCOM_UPDATE ||
               thd_sql_command(thd) == SQLCOM_CREATE_TABLE))) {
    ...
    m_prebuilt->select_lock_type = LOCK_NONE;
```

[`ha_innobase::start_stmt` (`ha_innodb.cc#L18735`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L18735) の中、[L18795](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L18795)。RR では `INSERT INTO ... SELECT` の SELECT 側が共有ロックを取る (STATEMENT ベースの binlog で同じ結果を再現するため) が、**RC では素の一貫読み取りになる**。同じ判定が `store_lock` 側 ([L19812](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L19812)) にもある。

### 7. STATEMENT ベースの binlog が使えない

上の 6 と同じ理由の裏返しで、InnoDB は RC 以下では**エンジンの能力フラグから `HA_BINLOG_STMT_CAPABLE` を落とす**。

```cpp title="storage/innobase/handler/ha_innodb.cc"
  ulong const tx_isolation = thd_tx_isolation(thd);

  if (tx_isolation <= ISO_READ_COMMITTED) {
    return (flags);
  }

  return (flags | HA_BINLOG_STMT_CAPABLE);
```

[`ha_innobase::table_flags` (L6575)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L6575) の末尾 ([L6597](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L6597))。実際に書き込もうとすると `start_stmt` が弾く。

```cpp title="storage/innobase/handler/ha_innodb.cc"
      my_error(ER_BINLOG_STMT_MODE_AND_ROW_ENGINE, MYF(0),
               " InnoDB is limited to row-logging when"
               " transaction isolation level is"
               " READ COMMITTED or READ UNCOMMITTED.");
```

[L18919](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L18919)。**RC を選ぶと `binlog_format=ROW` が事実上の必須になる**のはここで強制されている。

### RC はギャップロックを継承しない

レコードが purge で消えるとき、そのレコードに付いていたロックは隣のレコードにギャップロックとして引き継がれる。ここにも RC の分岐がある。

```cpp title="storage/innobase/lock/lock0lock.cc"
  lock_sys->rec_hash.find_on_record(RecID{block, heap_no}, [&](lock_t *lock) {
    if (!lock->trx->skip_lock_inheritance &&
        !lock_rec_get_insert_intention(lock) &&
        !lock->index->table->skip_gap_locks() &&
        (!lock->trx->skip_gap_locks() || lock->trx->lock.inherit_all.load())) {
      lock_rec_add_to_queue(LOCK_REC | LOCK_GAP | lock_get_mode(lock),
                            heir_block, heir_heap_no, lock->index, lock->trx);
    }
```

[`lock_rec_inherit_to_gap` (L2458)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L2458) の中、[L2499](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L2499)。RC のトランザクションのロックは原則として継承されない。**ただし例外がある**——`trx->lock.inherit_all` が立っているときだ。上のコメントが説明している。

> Constraint checks place LOCK_S or (in case of INSERT ... ON DUPLICATE UPDATE... or REPLACE INTO..) LOCK_X on records. ... In READ COMMITTED and less restricitve isolation levels we generally avoid gap locks, but we make an exception for precisely this situation: we want to inherit locks created for constraint checks.

制約検査で取ったロックだけは、RC でもギャップとして継承される。INSERT は「制約を確かめる」「実際に挿入する」の 2 段階で、1 段目のロックが 2 段目まで生き残ることを当てにしているからだ。`inherit_all` は `lock_duration_t::AT_LEAST_STATEMENT` でロックを要求したときに立ち、文の終わりでクリアされる。

### RC でも消えないギャップロック

**ユニークなセカンダリインデックスの重複検査は、RC でも next-key lock を取る。**

```cpp title="storage/innobase/row/row0ins.cc"
  const bool skip_gap_locks = index->table->skip_gap_locks();
```

[`row_ins_scan_sec_index_for_duplicate` (`row0ins.cc#L1921`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0ins.cc#L1921) の中、[L1967](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0ins.cc#L1967)。ここで見ているのは `dict_table_t::skip_gap_locks()`、つまり **DD / SDI テーブルかどうかだけ**であって、`trx->skip_gap_locks()` ではない。ローカル変数名が同じなので読み間違えやすい。詳細は [INSERT のロックのページ](./insert-and-duplicate-check/)。

**insert intention も分離レベルに関係なく取る。** [`lock_rec_insert_check_and_lock` (`lock0lock.cc#L5139`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0lock.cc#L5139) に `isolation_level` の分岐はない。

一方、**外部キー検査は RC ではギャップを外す。**

```cpp title="storage/innobase/row/row0ins.cc"
  skip_gap_lock = (trx->isolation_level <= TRX_ISO_READ_COMMITTED) ||
                  table->skip_gap_locks();
```

[`row_ins_check_foreign_constraint` (L1415)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0ins.cc#L1415) の中、[L1449](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/row/row0ins.cc#L1449)。ここだけは `trx->skip_gap_locks()` を使わず `isolation_level` を直接見ている。

## どう活かすか

**RC にすると `Deadlock found when trying to get lock` は減るが、消えはしない。** 減るのは「範囲スキャンで取ったギャップロック同士が絡む」タイプで、UNIQUE 重複検査由来のデッドロック ([INSERT のロックのページ](./insert-and-duplicate-check/)) は残る。「RC にしたのにデッドロックが出る」場合、まず疑うのは UNIQUE インデックスと `INSERT ... ON DUPLICATE KEY UPDATE` だ。

**RC + `binlog_format=ROW` はセットで考える。** ギャップロックを取らないということは、STATEMENT ベースのバイナリログでレプリカに同じ結果を再現できないということだ。InnoDB は RC 以下で `HA_BINLOG_STMT_CAPABLE` を落とし、`binlog_format=STATEMENT` での書き込みを `ER_BINLOG_STMT_MODE_AND_ROW_ENGINE` で拒否する。RC を選ぶなら ROW (または MIXED) になる ([binlog イベントのページ](./binlog-events/))。

**RC では「WHERE に合わなかった行のロックが残らない」ので、フルスキャンを伴う UPDATE の被害が小さい。** `UPDATE t SET x = 1 WHERE non_indexed_col = 5` は全行を走査してロックするが、RC なら合わなかった行のロックは `unlock_row` で外れる。RR では全行がロックされたままになる。**インデックスがない UPDATE が全テーブルを止める**という事故は RR 特有だ (もちろんインデックスを張るのが本筋だが)。

**RR のまま「一意ヒットならギャップは付かない」ことを利用する。** `WHERE pk = ?` の `FOR UPDATE` は RR でも `LOCK_REC_NOT_GAP` になる。PK / ユニークキーで確実に 1 行を指すクエリは、RR でも並行性を落とさない。**逆に、範囲条件やインデックスのない条件で `FOR UPDATE` を打つと RR ではギャップが広範に付く。**

**RC への変更はスナップショットの意味も変える。** ロックだけを見て RC に切り替えると、「同じトランザクション内の 2 回の読みで結果が変わる」という別の変更が同時に入る ([read view のページ](./read-view-and-visibility/))。集計してから明細を引くようなコードは、この変更で壊れうる。ロックの緩和だけがほしいなら、まず `FOR UPDATE` の条件をユニークキーに絞れないかを検討するほうが影響が小さい。

**セッション単位で切り替えられる。** `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED` は `ha_innobase::store_lock` が文の頭で `trx->isolation_level` を読み直すので ([L19729](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L19729))、問題のあるバッチ処理だけ RC で回すという運用が取れる。全体を RC にする前に、範囲が限定できないかを見る。
