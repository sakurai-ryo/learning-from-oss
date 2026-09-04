---
title: "InnoDB のメモリ — バッファプール以外に何が食うか"
description: "innodb_buffer_pool_size を物理メモリの 70% にしたのに OOM killer に殺される。その差分がどこから来るかを、InnoDB の確保経路 (ut::allocator と mem_heap) と、PFS の memory/innodb/* イベントから読む。8.4 で 64MB に増えた log buffer、セッション変数である DDL バッファ、ロック 1 個あたりのメモリ、辞書キャッシュまで数える。"
group: "InnoDB — バッファプール"
sidebar:
  order: 71
---

> **前提**: [バッファプール — buf_page_get_gen が全読み書きの入口](./buffer-pool-walkthrough/) / [ページとバッファプール](./page-and-buffer/)

## 何を学んだか

**`innodb_buffer_pool_size` は InnoDB のメモリ使用量ではない。** バッファプールの「フレーム部分」の大きさであって、その外側に少なくとも次のものが積まれる。

| 消費者                    | 大きさの決まり方                                              | 動的か               |
| ------------------------- | ------------------------------------------------------------- | -------------------- |
| バッファプールのフレーム  | `innodb_buffer_pool_size`                                     | chunk 単位で可変     |
| ブロック記述子・ハッシュ  | ページ数に比例 (`buf_block_t`、page hash、LRU の管理)         | プールに追随         |
| redo ログバッファ         | `innodb_log_buffer_size` (**8.4 の既定は 64MB**)              | 動的に変更可         |
| adaptive hash index       | AHI に載ったページ数に比例。**8.4 の既定は OFF**              | 際限なく伸びうる     |
| lock_sys                  | 保持している行ロックの数に比例                                | トランザクション次第 |
| dict_sys (辞書キャッシュ) | 開いたテーブルとインデックスの数                              | LRU で削られる       |
| DDL のソートバッファ      | `innodb_ddl_buffer_size` × `innodb_ddl_threads` × 同時 DDL 数 | **セッション変数**   |
| undo/trx まわりの構造体   | 同時トランザクション数                                        | プールで再利用       |

このうち**上限が設定で決まらないもの** (AHI、lock_sys、dict_sys) が、OOM の原因になりやすい。

## なぜそうなっているか

### 確保経路が 2 系統ある

InnoDB は自前のアロケータを 2 つ持っている。

1. **`ut::` アロケータ** (`ut0new.h` / `ut0new.cc`) — C++ の `new` / STL コンテナ用。**確保のたびに PFS のメモリキーで計上する**
2. **`mem_heap`** (`mem0mem.h`) — 「この処理の間だけ使い、まとめて捨てる」領域。行の整形、レコードのオフセット配列、クエリグラフなど

`mem_heap` は arena 型で、**個別の free をしない**。`mem_heap_free` で丸ごと返す。行 1 件を処理するたびに何十回も小さな確保が起きる場所で、malloc を叩かないための設計だ。

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

## どう活かすか

### メモリ見積もりの順序

物理メモリからの引き算はこの順で組み立てる。

1. **バッファプール** — 切り上げ後の `@@innodb_buffer_pool_size`
2. **バッファプールの管理構造** — 経験的にプールの数 % 程度。ページ数に比例するので、ページサイズを小さくすると比率が上がる
3. **log buffer** — 8.4 既定で 64MB
4. **接続ごとのバッファ** — Server 層の `sort_buffer_size` / `join_buffer_size` / `read_rnd_buffer_size` などが接続数と掛け算になる (InnoDB の外側だが同じメモリを食う)
5. **DDL** — メンテナンス時にだけ乗る。同時 DDL 数 × `innodb_ddl_buffer_size` × `innodb_ddl_threads`
6. **辞書キャッシュと AHI** — 上限が設定で決まらない。実測する

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
