---
title: "InnoDB のメモリ — バッファプール以外に何が食うか"
description: "innodb_buffer_pool_size を物理メモリの 70% にしたのに OOM killer に殺される。その差分がどこから来るかを、InnoDB の確保経路 (ut:: の関数群と mem_heap の 2 倍成長) と、PFS の memory/innodb/* イベントから読む。ブロック記述子 1 個が抱える mutex・rw_lock・2 個の os_event の重さ、AHI/lock_sys/辞書キャッシュの初期サイズがどれもプールサイズから逆算される仕組み、そして SQL 層の MEM_ROOT が同じアリーナの発想を 1.5 倍成長で使い回す様子まで数える。"
group: "InnoDB — バッファプール"
sidebar:
  order: 71
---

> **前提**: [バッファプール — buf_page_get_gen が全読み書きの入口](./buffer-pool-walkthrough/) / [ページとバッファプール](./page-and-buffer/)

## 何を学んだか

**`innodb_buffer_pool_size` は InnoDB のメモリ使用量ではない。** バッファプールの「フレーム部分」の大きさであって、その外側に少なくとも次のものが積まれる。

| 消費者                    | 大きさの決まり方                                                                    | 動的か               |
| ------------------------- | ----------------------------------------------------------------------------------- | -------------------- |
| バッファプールのフレーム  | `innodb_buffer_pool_size`                                                           | chunk 単位で可変     |
| ブロック記述子・ハッシュ  | ページ数に比例。`buf_block_t` 1 個ごとに mutex + rw_lock (os_event 2 個) も付随する | プールに追随         |
| redo ログバッファ         | `innodb_log_buffer_size` (**8.4 の既定は 64MB**)                                    | 動的に変更可         |
| adaptive hash index       | AHI に載ったページ数に比例。**8.4 の既定は OFF**                                    | 際限なく伸びうる     |
| lock_sys                  | 保持している行ロックの数に比例                                                      | トランザクション次第 |
| dict_sys (辞書キャッシュ) | 開いたテーブルとインデックスの数                                                    | LRU で削られる       |
| DDL のソートバッファ      | `innodb_ddl_buffer_size` × `innodb_ddl_threads` × 同時 DDL 数                       | **セッション変数**   |
| undo/trx まわりの構造体   | 同時トランザクション数                                                              | プールで再利用       |

このうち**上限が設定で決まらないもの** (AHI、lock_sys、dict_sys) が、OOM の原因になりやすい。

## なぜそうなっているか

### 確保経路が 2 系統ある

InnoDB は自前のアロケータを 2 つ持っている。

1. **`ut::` 名前空間の関数群** (`ut0new.h` / `ut0new.cc`) — C++ の `new` / STL コンテナ用。**確保のたびに PFS のメモリキーで計上する**
2. **`mem_heap`** (`mem0mem.h`) — 「この処理の間だけ使い、まとめて捨てる」領域。行の整形、レコードのオフセット配列、クエリグラフなど

**`ut::` は 1 つのクラスではなく用途別の関数群になっている。** `ut::malloc` / `ut::new_` のような素朴な置き換えのほかに、アライメント付きの `ut::aligned_alloc`、huge page 用の `ut::malloc_large_page` などが並び、それぞれに PFS キーを渡す `_withkey` 版がある。STL コンテナ用の `ut::allocator<T>` というクラスも残っている。**「1 回の確保につき 1 個のヘッダを前置し、`allocate`/`allocate_large`/アライン済みを 1 つのテンプレートクラスで抱える」という古い設計は 8.4 のソースにはもう無い**。古い記事が言う `ut_allocator<T>` というクラス名で検索しても現行のソースには出てこない。

`mem_heap` は arena 型で、**個別の free をしない**。`mem_heap_free` で丸ごと返す。行 1 件を処理するたびに何十回も小さな確保が起きる場所で、malloc を叩かないための設計だ。ブロックのサイズは**前回の 2 倍**で伸びていく。

```cpp title="storage/innobase/mem/memory.cc (mem_heap_add_block、L370-374)"
  /* We have to allocate a new block. The size is always at least
  doubled until the standard size is reached. After that the size
  stays the same, except in cases where the caller needs more space. */

  new_size = 2 * mem_block_get_len(block);
```

上限は `MEM_HEAP_DYNAMIC` なら `MEM_BLOCK_STANDARD_SIZE` (16KB ページの環境では 8000 バイト)、それ以外 (下記の `MEM_HEAP_BUFFER`) ならバッファプールの 1 ページ分 (`MEM_MAX_ALLOC_IN_BUF`) で頭打ちになる。「小さい確保を繰り返すたびに malloc/ページ確保が飛ぶのを防ぐ」という狙いは、後述の SQL 層の `MEM_ROOT` と同じだ。

`type` には 3 種類あり、確保元がサイズと文脈で決まる。

```cpp title="storage/innobase/include/mem0mem.h (L62-L67)"
constexpr uint32_t MEM_HEAP_DYNAMIC = 0;
constexpr uint32_t MEM_HEAP_BUFFER = 1;
constexpr uint32_t MEM_HEAP_BTR_SEARCH = 2;
```

- **`MEM_HEAP_DYNAMIC`** — 常に `ut::malloc` から取る
- **`MEM_HEAP_BUFFER`** — 要求が半ページ (`UNIV_PAGE_SIZE / 2`) 未満なら `MEM_HEAP_DYNAMIC` と同じく `ut::malloc` から取るが、**半ページ以上を要求したときだけ** `buf_block_alloc` で**バッファプールから 1 ページ丸ごと**確保する
- **`MEM_HEAP_BTR_SEARCH`** (`MEM_HEAP_BUFFER` と OR で使う) — AHI 用。半ページ以上の確保では `buf_block_alloc` を呼ばず、**ヒープが最初から予約しておいた予備の 1 ページ (`free_block_ptr`) を使い回す**

3 つ目が変わっている。理由はコードのコメントに書いてある。

```cpp title="storage/innobase/mem/memory.cc (mem_heap_create_block)"
      /* We cannot allocate the block from the buffer pool, but must get the
      free block from free block field of the heap base block. This is
      because we hold the X latch on AHI, and getting a block by eviction
      from LRU might require it too. */
```

**AHI の X latch を持ったまま `buf_block_alloc` を呼ぶと、LRU から evict するときに同じ latch を要求してデッドロックしうる。** それを避けるため、AHI 用の heap が (最初のブロックを除いて) ブロックを追加するときは、あらかじめ確保しておいた予備ページだけを使う。予備が尽きていれば `mem_heap_add_block` は `nullptr` を返し、呼び出し側に諦めさせる — これが「`MEM_HEAP_BTR_SEARCH` の heap だけは確保に失敗しうる」という API コメントの正体だ。

`ut::` 側は用途ごとにキーが振ってある。

```cpp title="storage/innobase/ut/ut0new.cc (L47-L65)"
PSI_memory_key mem_key_ahi;
PSI_memory_key mem_key_archive;
PSI_memory_key mem_key_buf_buf_pool;
PSI_memory_key mem_key_buf_stat_per_index_t;
...
PSI_memory_key mem_key_lock_sys;
PSI_memory_key mem_key_other;
PSI_memory_key mem_key_partitioning;
PSI_memory_key mem_key_row_log_buf;
PSI_memory_key mem_key_ddl;
PSI_memory_key mem_key_std;
PSI_memory_key mem_key_trx_sys_t_rw_trx_ids;
PSI_memory_key mem_key_undo_spaces;
```

**このリストがそのまま `performance_schema.memory_summary_global_by_event_name` の `memory/innodb/*` になる。** どのキーにも当てはまらない確保は `mem_key_other` に落ちる。

```cpp title="storage/innobase/ut/ut0new.cc (L77-L80)"
   mem_key_std
...
   (in ut_new_boot()) then mem_key_other is used.
```

### なぜ log buffer が 64MB もあるのか

8.4 の既定値は 64MB だ。

```cpp title="storage/innobase/include/log0constants.h (L484-L485)"
/** Default value of innodb_log_buffer_size (in bytes). */
constexpr ulong INNODB_LOG_BUFFER_SIZE_DEFAULT = 64 * 1024 * 1024UL;
```

log buffer は**書き込みトランザクションが redo を書き込む共有バッファ**で、ここが溢れると書き手が待たされる ([log writer / flusher](./log-writer-threads/))。8.0 系で log writer が専用スレッドに分離され、バッファを大きく取っても遅延が増えない構造になったので、既定値が引き上げられた。

**「メモリ計算の中で 64MB を忘れる」**のが実務での落とし穴になる。小さいインスタンス (2GB など) では無視できない比率だ。

### DDL のバッファはセッション変数

これがいちばん見落としやすい。

```cpp title="storage/innobase/handler/ha_innodb.cc (L1112-L1122)"
static MYSQL_THDVAR_ULONG(ddl_buffer_size, PLUGIN_VAR_RQCMDARG,
                          "Maximum size of memory to use (in bytes) for DDL.",
                          nullptr, nullptr, 1048576, /* Default. */
                          65536,                     /* Minimum. */
                          4294967295, 0);            /* Maximum. */

static MYSQL_THDVAR_ULONG(ddl_threads, PLUGIN_VAR_RQCMDARG,
                          "Maximum number of threads to use for  DDL.", nullptr,
                          nullptr, 4, /* Default. */
                          1,          /* Minimum. */
                          64, 0);     /* Maximum. */
```

`MYSQL_THDVAR_*` は**セッション変数**だ。既定は 1MB × 4 スレッドなので 1 セッションあたり 4MB で済むが、`SET innodb_ddl_buffer_size = 1G` としたセッションが同時に 4 本走れば、それだけで 16GB を要求しうる。**インデックス作成を速くしようとして上げた値が、同時実行数と掛け算になる。**

### バッファプール以外はプールから返らない

バッファプールは `SET GLOBAL innodb_buffer_pool_size` で縮められる ([バッファプールの walkthrough](./buffer-pool-walkthrough/))。だが **AHI や dict_sys は「使った分だけ増えて、条件が揃うまで減らない」**。

adaptive hash index はページがバッファプールから追い出されるときに対応するエントリを消すので、プール一杯まで載ると比例して食う ([adaptive hash index](./adaptive-hash-index/))。8.4 で既定 OFF になったのは競合が理由だが、メモリの読みやすさという意味でも効いている。

## ソースコードのどこか

### `SHOW ENGINE INNODB STATUS` の 2 行

```cpp title="storage/innobase/srv/srv0srv.cc (L1468-L1477)"
  fputs(
      "----------------------\n"
      "BUFFER POOL AND MEMORY\n"
      "----------------------\n",
      file);
  fprintf(file,
          "Total large memory allocated " ULINTPF
          "\n"
          "Dictionary memory allocated %zu\n",
          os_total_large_mem_allocated.load(), dict_sys->size);
```

- **`Total large memory allocated`** — 大きな確保 (バッファプールの chunk など) の合計。**小さい確保は入っていない**ので、これを RSS と比べてはいけない
- **`Dictionary memory allocated`** — `dict_sys->size`。開いているテーブル・インデックスの定義が食っている量 ([辞書キャッシュ](./dict-cache/))

### PFS で分解する

```sql
SELECT event_name,
       current_number_of_bytes_used / 1024 / 1024 AS cur_mb,
       high_number_of_bytes_used    / 1024 / 1024 AS high_mb
  FROM performance_schema.memory_summary_global_by_event_name
 WHERE event_name LIKE 'memory/innodb/%'
   AND current_number_of_bytes_used > 0
 ORDER BY current_number_of_bytes_used DESC
 LIMIT 20;
```

`sys.memory_global_by_current_bytes` でも同じものが見えるが、**あちらの `current_alloc` は `format_bytes()` を通した文字列**なので計算に使えない。数値で扱うなら上のように `performance_schema` を直接引くか `sys.x$memory_global_by_current_bytes` を使う。読み方の目安。

| イベント名                          | 増えているときに疑うもの                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `memory/innodb/buf_buf_pool`        | バッファプール本体。設定どおりのはず                                            |
| `memory/innodb/adaptive hash index` | AHI。`innodb_adaptive_hash_index=OFF` で消える                                  |
| `memory/innodb/lock_sys`            | 行ロックの持ちすぎ。巨大な `UPDATE` / 長いトランザクション                      |
| `memory/innodb/ddl`                 | 走行中の DDL。`innodb_ddl_buffer_size` × スレッド数                             |
| `memory/innodb/row_log_buf`         | オンライン DDL の row log ([オンライン索引構築](./online-index-build-row-log/)) |
| `memory/innodb/other`               | 分類外。ここが大きいときは推測しにくい                                          |

**サーバ起動後の累積**なので、`high_number_of_bytes_used` (ピーク) と `current_number_of_bytes_used` (現在) の差を見ると「一時的に膨らんだのか、居座っているのか」が分かる。何も出ないときは `setup_instruments` で `memory/innodb/%` が `ENABLED` になっているかを確認する ([performance_schema の内部](./performance-schema-internals/))。

### バッファプールの実効サイズは切り上げられる

```cpp title="storage/innobase/handler/ha_innodb.cc (L4633)"
  srv_buf_pool_size = buf_pool_size_align(srv_buf_pool_size);
```

`innodb_buffer_pool_size` は `innodb_buffer_pool_chunk_size × innodb_buffer_pool_instances` の倍数に切り上げられる。**設定した値より実際は大きくなる**ことがあるので、ぎりぎりの見積もりをしていると差分で溢れる。切り上げ後の値は `SELECT @@innodb_buffer_pool_size` で確認できる。

### ブロック記述子はサイズ以上に高くつく

「何を学んだか」の表にある「ブロック記述子・ハッシュ」は、`sizeof(buf_block_t)` だけでは済まない。[`buf_block_init`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/buf/buf0buf.cc#L809) は 1 block ごとに mutex と rw_lock を作る。

```cpp title="storage/innobase/buf/buf0buf.cc (buf_block_init)"
  mutex_create(LATCH_ID_BUF_BLOCK_MUTEX, &block->mutex);
...
  rw_lock_create(buf_block_lock_key, &block->lock, LATCH_ID_BUF_BLOCK_LOCK);

  ut_d(rw_lock_create(buf_block_debug_latch_key, &block->debug_latch,
                      LATCH_ID_BUF_BLOCK_DEBUG));
```

**この `rw_lock_create` が、呼ぶたびに `os_event_t` を 2 個作る。**

```cpp title="storage/innobase/sync/sync0rw.cc (rw_lock_create_func)"
  lock->event = os_event_create();
  lock->wait_ex_event = os_event_create();
```

`os_event` の中身は `pthread_cond_t` と専用の内部 mutex だ ([`os0event.cc`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/os/os0event.cc))。**つまり block 1 個につき、ページ latch 用に OS 同期オブジェクトが 2 個 (デバッグビルドなら `debug_latch` の分も加わって 4 個) 付随する**。大きなプールで block 数が数百万になる環境では、この分が `buf_block_t` 自体の `sizeof` には現れない追加コストになる。PFS の `memory/innodb/buf_buf_pool` にはこの分も含めて計上される。

### 起動時のハッシュテーブルサイズはどれもプールサイズに比例する

AHI・lock_sys・辞書キャッシュの初期ハッシュテーブルは、**どれも設定値を持たず `buf_pool_get_curr_size()` から逆算**している。

| 消費者                                                                                                                                                 | サイズの式                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| AHI ([`buf0buf.cc#L1599`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/buf/buf0buf.cc#L1599))                              | `buf_pool_get_curr_size() / sizeof(void*) / 64`                                                     |
| lock_sys ([`ha_innodb.cc#L5046`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L5046))                 | `srv_lock_table_size = 5 * (srv_buf_pool_size / UNIV_PAGE_SIZE)` ([lock_sys](./lock-sys-sharding/)) |
| 辞書キャッシュ `table_hash` ([`dict0dict.cc#L1022`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/dict/dict0dict.cc#L1022)) | `buf_pool_get_curr_size() / (512 * UNIV_WORD_SIZE)` ([辞書キャッシュ](./dict-cache/))               |

**プールを大きくすると、AHI・lock_sys・辞書キャッシュの「箱」も自動的に大きくなる。** これらは `innodb_buffer_pool_size` の外側のメモリだが、サイズの根拠は同じ数値から来ている。プールを縮小しても (AHI が既定 OFF でも) この計算式自体は変わらないので、小さいプールではこれらの初期サイズも小さく、大きく載せたいときに再ハッシュのコストが乗りやすい。

### SQL 層にも同じ発想のアリーナがある — `MEM_ROOT`

`mem_heap` が InnoDB 層の使い捨てアリーナなら、[`MEM_ROOT`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/include/my_alloc.h) は SQL 層 (`THD::mem_root`) の同じ発想の実装だ。文の parse tree がここに積まれることは[構文木の構築](./parse-tree-and-contextualize/)で見たとおりで、ここではその実体を見る。

ブロックは既定 512 バイトから始まり、新しいブロックを取るたびに**前回の 1.5 倍**になる。

```cpp title="mysys/my_alloc.cc (MEM_ROOT::AllocBlock)"
  // Make the default block size 50% larger next time.
  // This ensures O(1) total mallocs (assuming Clear() is not called).
  if (!MEM_ROOT_SINGLE_CHUNKS) {
    m_block_size += m_block_size / 2;
  }
```

現在のブロックに入りきらない大きな確保 (`AllocSlow`) は特別扱いされる。**新しいブロックを単独で確保し、「現在のブロック」の 1 つ前に挿し込む**。

```cpp title="mysys/my_alloc.cc (MEM_ROOT::AllocSlow)"
    } else {
      // Insert the new block in the second-to-last position.
      new_block->prev = m_current_block->prev;
      m_current_block->prev = new_block;
    }
```

**現在のブロックを差し替えないので、次の小さな `Alloc` はそのまま今のブロックの続きに入る。** 巨大な 1 回の確保が、以降の小さな確保のペースを乱さない設計だ。

文が終わったときは `Clear()` で全ブロックを解放するが、同じ `MEM_ROOT` を使い回すループでは [`ClearForReuse`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/mysys/my_alloc.cc) を使う。**最後の (=たいてい最大の) ブロックだけを残し、それ以外を解放する**。ブロックサイズも `m_orig_block_size` に戻さない。**同じ `MEM_ROOT` を繰り返し使う処理では、2 回目以降 OS への `malloc` がほぼ発生しなくなる**ということだ。

[構文木の構築](./parse-tree-and-contextualize/)で見た `parser_max_mem_size` は、この `MEM_ROOT` の `set_max_capacity` をそのまま使っている。**巨大な自動生成 SQL がパース段階でメモリを食うのは、ここまで見てきた「ブロックが 1.5 倍で伸び続ける」仕組みの上限を設定で切っているだけ**だ。

**Valgrind / ASAN ビルドでは挙動が変わる**ことに注意する。`MEM_ROOT_SINGLE_CHUNKS` が立つと 1.5 倍成長も `ClearForReuse` の使い回しも無効になり、**確保のたびに独立した `malloc` を行う**。メモリ検証ツールで確保元を追いたいときの設計だが、本番と同じメモリ使用量にはならない。

## どう活かすか

### メモリ見積もりの順序

物理メモリからの引き算はこの順で組み立てる。

1. **バッファプール** — 切り上げ後の `@@innodb_buffer_pool_size`
2. **バッファプールの管理構造** — 経験的にプールの数 % 程度。ページ数に比例するので、ページサイズを小さくすると比率が上がる。block 1 個ごとに mutex + rw_lock (os_event 2 個) が付随する分もここに含まれる ([ブロック記述子のコスト](#ブロック記述子はサイズ以上に高くつく))
3. **log buffer** — 8.4 既定で 64MB
4. **接続ごとのバッファ** — Server 層の `sort_buffer_size` / `join_buffer_size` / `read_rnd_buffer_size` などが接続数と掛け算になる (InnoDB の外側だが同じメモリを食う)。パース用の `MEM_ROOT` も同じ接続の分だけ積み上がる ([SQL 層の MEM_ROOT](#sql-層にも同じ発想のアリーナがある--mem_root))
5. **DDL** — メンテナンス時にだけ乗る。同時 DDL 数 × `innodb_ddl_buffer_size` × `innodb_ddl_threads`
6. **辞書キャッシュと AHI** — 上限が設定で決まらない。初期サイズはどちらもプールサイズに比例するが、その後は使った分だけ伸びる ([起動時のハッシュテーブルサイズ](#起動時のハッシュテーブルサイズはどれもプールサイズに比例する))

**4 と 5 を忘れて 1 を大きくしすぎる**のが、OOM で落ちるインスタンスのいちばん多い形だ。

### `Total large memory allocated` と RSS の差を追わない

この値には小さい確保が含まれないので、RSS との差は常にある。**プロセスの RSS が伸びているかどうかを見るなら OS 側の指標**を、**どの部品が伸びているかを見るなら PFS の `memory/innodb/*`** を使う。2 つを引き算して原因を求めようとしても合わない。

### メモリが増える 3 つの典型

- **巨大なトランザクションがロックを持ちすぎている** — `memory/innodb/lock_sys` が伸びる。1 文で数百万行に触る `UPDATE` を分割する ([lock_sys](./lock-sys-sharding/))
- **テーブル数が多く辞書キャッシュが膨らむ** — `Dictionary memory allocated` を見る。パーティションはパーティションごとに定義を持つので、1000 パーティションのテーブルは 1000 テーブル分に近い ([パーティショニング](./partitioning/))
- **DDL のセッション変数を上げたまま忘れている** — `SHOW VARIABLES` はグローバル値しか見せない。セッションで上書きされている値はアプリ側の設定を疑う

### 逆に削れるもの

- **`innodb_adaptive_hash_index`** — 8.4 では既定 OFF。ON にしている環境では、切ればページ数に比例したメモリが丸ごと空く
- **`innodb_log_buffer_size`** — 小さいインスタンスなら 64MB は過剰。ただし書き込みが多いなら削ると `Log buffer waits` が出る ([redo ログ](./redo-log-walkthrough/))
- **`innodb_buffer_pool_instances`** — 大きくすると chunk の切り上げ単位が増える。小さいプールでは 1 のほうが無駄がない

## 参考文献

- [MySQL Memory Allocation and Management (Part I)](https://www.alibabacloud.com/blog/mysql-memory-allocation-and-management-part-i_600991) — `ut::` アロケータと `mem_heap` の内部設計
- [MySQL Memory Allocation and Management (Part II)](https://www.alibabacloud.com/blog/600992) — バッファプール・change buffer・AHI・log buffer・テーブルキャッシュなど InnoDB の主要なメモリ消費者を横断
