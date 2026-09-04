---
title: "ラッチとミューテックス — 順序が決まっているから固まらない"
description: "InnoDB のラッチには番号が振られていて、番号の大きい順にしか取れない。この 1 本の規則が、バッファプール・B+tree・ロック・redo が同時に動いてもデッドロックしない根拠になっている。番号の一覧、spin してから寝る 2 段構えの待ち方、SX ラッチが増やした 3 つ目のモード、そして 600 秒待ったら InnoDB がサーバごと落とす仕組みまで読む。"
group: "InnoDB — バッファプール"
sidebar:
  order: 70
---

> **前提**: [バッファプール — buf_page_get_gen が全読み書きの入口](./buffer-pool-walkthrough/) / [mini-transaction](./mini-transaction/)

## 何を学んだか

**行ロックとラッチは別物だ。** 行ロックはトランザクションが持ちコミットまで生きる。ラッチ (latch) はスレッドが持ち、数マイクロ秒から数ミリ秒で離す。デッドロック検出の対象になるのは行ロックだけで、ラッチのデッドロックは**起こしてはならないもの**として扱われる ([ロックの種類](./lock-modes-and-types/))。

起こさない方法は単純で、**すべてのラッチに順序番号を振り、番号の大きいものから小さいものへ向かってしか取らない**。

```cpp title="storage/innobase/include/sync0types.h (L198-L202)"
/** Latching order levels. If you modify these, you have to also update
LatchDebug internals in sync0debug.cc */
enum latch_level_t {
  SYNC_UNKNOWN = 0,
```

この enum が InnoDB のラッチ順序そのものだ。抜粋するとこうなっている。

| レベル (上ほど後に取る)              | 対象                                 |
| ------------------------------------ | ------------------------------------ |
| `SYNC_FIL_SHARD`                     | fil システムのシャード               |
| `SYNC_BUF_FLUSH_LIST`                | flush list                           |
| `SYNC_BUF_BLOCK`                     | バッファプールのブロック             |
| `SYNC_BUF_PAGE_HASH`                 | page hash                            |
| `SYNC_BUF_LRU_LIST`                  | LRU リスト                           |
| `SYNC_TRX_SYS`                       | trx_sys                              |
| `SYNC_LOCK_SYS_SHARDED`              | lock_sys のシャード                  |
| `SYNC_LOCK_SYS_GLOBAL`               | lock_sys 全体                        |
| `SYNC_FSP_PAGE` / `SYNC_FSP`         | テーブルスペースの管理ページとヘッダ |
| `SYNC_TREE_NODE` / `SYNC_INDEX_TREE` | B+tree のページと木全体              |
| `SYNC_DICT`                          | データディクショナリ                 |

**「先に取るもの」が下、「後に取るもの」が上**という向きで並んでいる。たとえば B+tree のページラッチ (`SYNC_TREE_NODE`) を持ったまま `SYNC_DICT` を取ることはできない。逆はできる。

順序を守るために、実装は**取る前にレベルを宣言する**。これが `mtr` がページラッチを一括管理している理由でもある ([mini-transaction](./mini-transaction/))。

## なぜそうなっているか

### なぜ順序で解くのか、検出しないのか

行ロックのデッドロックは検出して 1 本殺せば済む ([デッドロック検出](./deadlock-detection/))。ラッチではそれができない。**ラッチを取っている途中のページは中途半端な状態**で、そこで巻き戻すと B+tree が壊れる。「後で諦める」という選択肢が無いので、**そもそも循環が作れない設計にする**しかない。

だから順序違反はバグであり、実行時のエラーではない。チェックはデバッグビルド専用の `LatchDebug` が持つ。

```cpp title="storage/innobase/sync/sync0debug.cc (L111-L115)"
/** Thread specific latches. This is ordered on level in descending order. */
typedef std::vector<Latched, ut::allocator<Latched>> Latches;

/** The deadlock detector. */
struct LatchDebug {
```

スレッドごとに「今持っているラッチ」をレベル降順のベクタで持ち、新しく取るたびに順序を検査する。**この機構は `UNIV_DEBUG` ビルドで、かつ `innodb_sync_debug=ON` のときだけ動く。**

```cpp title="storage/innobase/sync/sync0debug.cc (L1096-L1103)"
void sync_check_enable() {
  if (!srv_sync_debug) {
    return;
  }

  /* We should always call this before we create threads. */
  LatchDebug::create_instance();
}
```

リリースビルドでは検査そのものが消える。**順序の正しさはテストとレビューで担保されていて、本番では 1 命令も払っていない。**

### なぜ spin してから寝るのか

InnoDB のラッチは「ほぼ常にすぐ取れる」前提で設計されている。ページラッチを持っている時間は数十〜数百ナノ秒のことが多い。ここで即座に OS の待ちに入ると、**コンテキストスイッチのほうがラッチの保持時間より長い**。

そこでまず spin する。

```cpp title="storage/innobase/handler/ha_innodb.cc (L23034-L23049)"
static MYSQL_SYSVAR_ULONG(
    sync_spin_loops, srv_n_spin_wait_rounds, PLUGIN_VAR_RQCMDARG,
    "Count of spin-loop rounds in InnoDB mutexes (30 by default)", nullptr,
    nullptr, 30L, 0L, UINT32_MAX, 0);

static MYSQL_SYSVAR_ULONG(
    spin_wait_delay, srv_spin_wait_delay, PLUGIN_VAR_OPCMDARG,
    "Maximum delay between polling for a spin lock (6 by default)", nullptr,
    nullptr, 6L, 0L, 1000, 0);

static MYSQL_SYSVAR_ULONG(spin_wait_pause_multiplier,
                          ut::spin_wait_pause_multiplier, PLUGIN_VAR_RQCMDARG,
                          "Controls how many times in a row to use a PAUSE "
                          "instruction to achieve one unit of delay in a spin "
                          "lock (see @@innodb_spin_wait_delay), defaults to 50",
```

- `innodb_sync_spin_loops` (既定 30) — 何周 spin するか
- `innodb_spin_wait_delay` (既定 6) — 1 周ごとの待ちの最大単位数。実際の待ちは 0 からこの値までの乱数になる
- `innodb_spin_wait_pause_multiplier` (既定 50) — 1 単位あたり `PAUSE` 命令を何回出すか

**乱数を挟むのは、同時に spin している複数スレッドが同じ周期でぶつかり続けるのを避けるため**だ。

spin で取れなければ sync array に自分のセルを登録して `os_event` で寝る。起こすのは解放したスレッドになる。この 2 段構えが「軽い競合は spin で吸収し、重い競合では CPU を明け渡す」という形になっている。

### SX ラッチが要る理由

InnoDB の rw_lock には S / X に加えて **SX** がある。

```cpp title="storage/innobase/include/sync0rw.h (L97-L102)"
enum rw_lock_type_t {
  RW_S_LATCH = 1,
  RW_X_LATCH = 2,
  RW_SX_LATCH = 4,
  RW_NO_LATCH = 8
};
```

SX は「**読みは通すが、他の書き手は入れない**」という中間のモードだ。S とは両立し、X とも他の SX とも両立しない。

用途は B+tree の悲観的操作だ。ページ分割は木の構造を変えるので、`index->lock` を X で取ると**分割中はその木への読みが全部止まる**。SX で取れば、構造を変える権利を独占しつつ、読みだけは通し続けられる。

実装は 1 つの `lock_word` を減算で操作する。

```cpp title="storage/innobase/include/sync0rw.h (L104-L109)"
/* We decrement lock_word by X_LOCK_DECR for each x_lock. It is also the
start value for the lock_word, meaning that it limits the maximum number
of concurrent read locks before the rw_lock breaks. */
/* We decrement lock_word by X_LOCK_HALF_DECR for sx_lock. */
constexpr int32_t X_LOCK_DECR = 0x20000000;
constexpr int32_t X_LOCK_HALF_DECR = 0x10000000;
```

S は 1 引き、SX は `0x10000000` 引き、X は `0x20000000` 引く。**1 つの atomic な整数の値を見るだけで、今どのモードで何人入っているかが分かる。** 同時 S ラッチの上限が `0x20000000` (約 5.4 億) なのもここから来ている。

## ソースコードのどこか

### 待ちの可視化 — sync array

spin で取れなかったスレッドは sync array に登録される。`SHOW ENGINE INNODB STATUS` の `SEMAPHORES` に出るあの行は、この配列を舐めて印字したものだ。

```cpp title="storage/innobase/sync/sync0arr.cc (L382-L387)"
  fprintf(file,
          "--Thread %s has waited at %s line " ULINTPF " for %" PRId64
          " seconds the semaphore:\n",
          to_string(cell->thread_id).c_str(), innobase_basename(cell->file),
          cell->line,
```

**ファイル名と行番号が出る**ので、どのラッチで待っているかがソースまで辿れる。`SEMAPHORES` の spin カウンタは 8.4 では 0 固定になっているが、この「待っているスレッド」の行は生きている ([INNODB STATUS のセクション](./innodb-status-sections/))。

### 600 秒待ったらサーバを落とす

error monitor スレッドが 1 秒ごとに長い待ちを探す。

```cpp title="storage/innobase/srv/srv0srv.cc (L1878-L1887)"
  if (sync_array_print_long_waits(&waiter, &sema) && sema == old_sema &&
      waiter == old_waiter) {
    fatal_cnt++;
    if (fatal_cnt > 10) {
      ib::fatal(UT_LOCATION_HERE, ER_IB_MSG_1047,
                ulonglong{srv_fatal_semaphore_wait_threshold});
    }
  } else {
    fatal_cnt = 0;
```

閾値は `innodb_fatal_semaphore_wait_threshold` (既定 600 秒、[`srv0srv.cc#L122`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/srv/srv0srv.cc#L122))。

条件をよく読むと単純な「600 秒でクラッシュ」ではない。**同じスレッドが同じセマフォを待っている状態が 11 回連続 (= 約 11 秒) 観測されて初めて `ib::fatal` する。** 待ち手やラッチが入れ替われば `fatal_cnt` は 0 に戻る。「進んでいるが遅い」状態では落ちず、「完全に固まっている」ときだけ落とす、という判定になっている。

`ib::fatal` はサーバを異常終了させる。**「InnoDB: Semaphore wait has lasted > 600 seconds. We intentionally crash the server」というエラーは、InnoDB が自分で下した判断**であって、外的なクラッシュではない。

### PFS から見る

8.4 で `SEMAPHORES` の数値が空になった代わりに、performance_schema の待ちイベントが正式な観測手段になっている。

```sql
SELECT event_name, count_star, sum_timer_wait/1e12 AS sum_sec
  FROM performance_schema.events_waits_summary_global_by_event_name
 WHERE event_name LIKE 'wait/synch/%/innodb/%'
   AND count_star > 0
 ORDER BY sum_timer_wait DESC
 LIMIT 20;
```

instrument 名はラッチ ID から機械的に作られているので、`wait/synch/mutex/innodb/log_writer_mutex` や `wait/synch/rwlock/innodb/log_sn_lock` のように**ソース上の名前がそのまま出てくる**。上位に何が来るかで詰まりの層が分かる。

| 上位に来る instrument                   | 疑う場所                                              |
| --------------------------------------- | ----------------------------------------------------- |
| `buf_pool` 系 / `buf_page_hash`         | バッファプールの競合。instance 数とサイズ             |
| `log_writer_mutex` / `log_sn_lock` など | redo の書き込み。`innodb_flush_log_at_trx_commit`     |
| `lock_sys` 系                           | 行ロックの取り合い ([lock_sys](./lock-sys-sharding/)) |
| `dict_sys` / `dict` 系                  | DDL やテーブルオープンの集中                          |
| `fil_system` (`SYNC_FIL_SHARD`)         | ファイルハンドルの取り合い。`innodb_open_files`       |

計測を有効にするには `setup_instruments` で `wait/synch/%` が `ENABLED` になっている必要がある。既定では多くが OFF なので、**「何も出ない」ときはまず instrument が有効か確認する** ([performance_schema の内部](./performance-schema-internals/))。

## どう活かすか

### spin パラメータを触る前に確かめること

`innodb_sync_spin_loops` を上げると「短い競合を CPU を回して待つ」時間が伸びる。コアが余っていて、待ちが短いことが分かっている場合だけ効く。**コアが飽和しているサーバで上げると、spin が他のスレッドから CPU を奪って全体が遅くなる。**

判断材料は、PFS の該当 instrument の `sum_timer_wait / count_star` (1 回あたりの平均待ち時間) だ。これがマイクロ秒未満なら spin を伸ばす余地があり、ミリ秒級なら spin は無駄で、**そもそもその層の設計 (バッファプールが小さい、ホットな行に集中している) を直すべき**という結論になる。

### 「Semaphore wait」でクラッシュしたときに見るところ

エラーログには、fatal の直前に `SEMAPHORES` セクションと待っているスレッドの一覧が出力されている。読む順序はこうなる。

1. **どのラッチで待っていたか** — `has waited at <file> line <n>` のファイル名。`buf0buf.cc` ならバッファプール、`log0*` なら redo
2. **待ち手が 1 本か複数か** — 複数のスレッドが同じラッチを待っているなら、それを持っているスレッドが居るはず
3. **持っている側が何をしているか** — I/O で詰まっている (ディスクが応答しない) ケースが圧倒的に多い

**実務上、原因の大半はストレージだ。** ラッチを持ったまま `fsync` や read が返ってこなければ、後続が全員そこで待つ。600 秒返らないディスクは壊れているか、ネットワークストレージが切れている。

### ラッチ順序を知っていると読める挙動

- **DDL 中に全体が固まる** — `SYNC_DICT` は順序の最上位近くにいる。dict のラッチを持ったまま長時間の処理をすると、テーブルを開こうとする全スレッドが止まる ([メタデータロック](./metadata-locking/) とは別レイヤの話である点に注意)
- **ページ分割中も読める** — `index->lock` を SX で取るので、分割中でも探索は通る ([B+tree の操作](./btree-operations/))
- **フラッシュ中にそのページを読める** — flush list のラッチとブロックのラッチは別レベルなので、page cleaner が flush list を走査している間も個別ページの読みは進む ([flush list と page cleaner](./flush-list-and-page-cleaner/))

### `innodb_sync_debug` は本番で使わない

`innodb_sync_debug=ON` はデバッグビルドでのみ意味があり、しかもラッチのたびにスレッドごとのベクタを更新するので遅い。**順序違反を疑うのは InnoDB 自体を改造したときだけ**で、アプリケーション側の問題を追うために触る変数ではない。
