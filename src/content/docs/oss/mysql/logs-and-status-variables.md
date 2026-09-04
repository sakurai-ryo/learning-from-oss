---
title: "ログとステータス変数 — slow log と SHOW STATUS"
description: "SHOW STATUS の値の大半は System_status_var という 1 個の構造体のフィールドで、status_vars[] はそこへのオフセットの表にすぎない。Handler_* を加算するのはサーバではなくストレージエンジンで、Created_tmp_disk_tables を上げる関数は同時に performance_schema の統計も上げる。slow log 側は log_slow_statement がどこから呼ばれるか、log_slow_extra が何の差分を書くかを読む。変数と仕組みの対応表を作る。"
group: "観測手段"
sidebar:
  order: 120
---

> **前提**: [performance_schema](./performance-schema-internals/)

## 何を学んだか

`SHOW STATUS` の値は 3 種類の出どころに分かれる。

1. **`System_status_var` のフィールド** — セッションごとに 1 個ずつ持つ構造体。`SHOW SESSION STATUS` はその値、`SHOW GLOBAL STATUS` は**全接続ぶんを足し合わせた値**
2. **グローバル変数を直接指すもの** — `Binlog_cache_use` など。プロセスに 1 個
3. **関数を呼ぶもの** — `SHOW_FUNC`。`Innodb_*` は全部これで、呼ばれるたびに InnoDB 側の値をスナップショットし直す

対応は [`status_vars[]` (`sql/mysqld.cc#L11351`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/mysqld.cc#L11351) という 1 個の配列に書いてある。名前・値へのポインタ (またはオフセット)・型・スコープの 4 つ組が並ぶだけの表だ。

そして重要なのは、**カウンタを加算する場所がそのまま「その変数の意味」になっている**ことだ。`Handler_read_key` を加算するのはサーバではなく `ha_innobase::index_read` の 1 行で、`Created_tmp_disk_tables` を加算する `THD::inc_status_created_tmp_disk_tables()` は同時に performance_schema の文統計も上げる。この加算点をたどれば、どの変数がどの層の仕組みを映しているかが決まる。

slow log 側も同じ構造で、`log_slow_extra=ON` のときにログへ書かれるのは**文の開始時と終了時の `System_status_var` の差分**だ。

## なぜそうなっているか

### なぜ `Handler_*` をエンジンに任せたか

サーバの `handler` ラッパで数えれば 1 か所で済むように見えるが、それだと「エンジンが実際に何回内部で読んだか」とずれる。たとえば [ICP](./access-path-selection/) が効いていると、エンジンは 1 回の `index_read` のなかで複数行を評価して条件に合うものだけ返す。MRR も同様だ。

エンジンに数えさせておけば、エンジンごとに「1 回とは何か」を定義できる。代償として、`Handler_read_key` の意味はエンジンによって微妙に違う。InnoDB の `index_read` は 11 か所しか加算点がないので比較的素直だが、この数字を絶対視するのではなく**同じワークロードの前後比較**に使うのが正しい。

### なぜ `Slow_queries` はログが無効でも増えるのか

コメントに `The docs say slow queries must be counted even when the log is off.` とある。ドキュメントが先で実装が後、という珍しい形の理由付けだ。

実用上は理にかなっている。`Slow_queries` は「`long_query_time` を超えた文が何本あったか」の指標で、ログを書くかどうかとは独立した情報だ。ログを止めていてもこの数字だけは監視できる。

### なぜ slow log の判定が文の**あと**にあるのか

当然に見えるが、副作用がある。`log_slow_statement` は `dispatch_command` の末尾で呼ばれるので、**接続が切れた文や、実行中にサーバが落ちた文は記録されない**。「タイムアウトしたクエリが slow log にない」のはこのためだ。

また `SERVER_QUERY_WAS_SLOW` の判定に使う `start_utime` は文の開始時刻なので、`Query_time` にはネットワーク待ちも[行の送信時間](./sending-rows-and-limit/)も含まれる。遅いクライアントが結果を受け取らないと、サーバ側の処理が終わっていても `Query_time` は伸び続ける。

### なぜ `SHOW GLOBAL STATUS` が全 `THD` を走査するのか

`System_status_var` はセッションごとに持たれるので、グローバル値を作るには足し合わせるしかない。加算のたびにグローバルなカウンタを触ると[キャッシュラインの奪い合い](./thread-model/)になるので、読むときにコストを払う設計にしてある。

8.4 の `aggregated_stats` (64 シャード) は、この読み取りコストを避けるために導入された別経路だ。ただし現時点では `SHOW STATUS` ではなく OpenTelemetry メトリックの実装だけが使う。

## ソースコードのどこか

### `status_vars[]` の 4 つ組

[`sql/mysqld.cc#L11351`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/mysqld.cc#L11351) の先頭付近から。

```cpp title="sql/mysqld.cc"
SHOW_VAR status_vars[] = {
    {"Aborted_clients", (char *)&aborted_threads, SHOW_LONG, SHOW_SCOPE_GLOBAL},
    ...
    {"Bytes_received", (char *)offsetof(System_status_var, bytes_received),
     SHOW_LONGLONG_STATUS, SHOW_SCOPE_ALL},
    ...
    {"Created_tmp_disk_tables",
     (char *)offsetof(System_status_var, created_tmp_disk_tables),
     SHOW_LONGLONG_STATUS, SHOW_SCOPE_ALL},
```

`SHOW_*_STATUS` で終わる型は、値の欄が**ポインタではなく `System_status_var` 内のオフセット**だ。読み出す側 ([`sql/sql_show.cc#L3611`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_show.cc#L3611)) がベースアドレスを足す。

```cpp title="sql/sql_show.cc"
    case SHOW_LONG_STATUS:
      value = (char *)status_var + reinterpret_cast<size_t>(value);
```

`SHOW_SCOPE_ALL` の変数はセッションとグローバルの両方で引ける。`SHOW GLOBAL STATUS` のときのベースを作るのが [`calc_sum_of_all_status` (`sql/sql_show.cc#L3754`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_show.cc#L3754) だ。

```cpp title="sql/sql_show.cc"
void calc_sum_of_all_status(System_status_var *to) {
  DBUG_TRACE;
  mysql_mutex_assert_owner(&LOCK_status);
  /* Get global values as base. */
  *to = global_status_var;
  Add_status add_status(to);
  Global_THD_manager::get_instance()->do_for_all_thd_copy(&add_status);
}
```

`global_status_var` は**切断済みのセッションが残していったぶん**で、そこに生きている全 `THD` の `status_var` を足す。つまり `SHOW GLOBAL STATUS` は接続数に比例したコストを持つ。8.4 には別途 64 シャードの [`aggregated_stats` (`sql/aggregated_stats.h`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/aggregated_stats.h) があり、`thread_id % 64` でシャードを選んで加算する仕組みが入っているが、これを読むのは OpenTelemetry メトリック側 ([`sql/mysqld.cc#L4827`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/mysqld.cc#L4827)) だ。

### `Handler_*` はエンジンが上げる

サーバの `handler` ラッパではなく、**ストレージエンジンの実装が自分で呼ぶ**。InnoDB の場合は [`ha_innodb.cc`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10445) の 11 か所だけだ。

```cpp title="storage/innobase/handler/ha_innodb.cc"
int ha_innobase::index_read(
    uchar *buf, const uchar *key_ptr, uint key_len,
    enum ha_rkey_function find_flag)
{
  ...
  ha_statistic_increment(&System_status_var::ha_read_key_count);
```

`ha_statistic_increment` の実体 ([`sql/handler.cc`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/handler.cc)) は 1 行だ。

```cpp title="sql/handler.cc"
void handler::ha_statistic_increment(
    ulonglong System_status_var::*offset) const {
  if (table && table->in_use) (table->in_use->status_var.*offset)++;
}
```

`table->in_use` が現在の `THD` なので、**呼んだセッションのカウンタが上がる**。だから `SHOW SESSION STATUS LIKE 'Handler%'` を文の前後で差分にとれば、その 1 文が何回インデックスを引いたかがそのまま分かる。

### `THD::inc_status_*` は P_S も同時に上げる

`Created_tmp_disk_tables` や `Sort_merge_passes` はサーバ層のカウンタで、[`sql/sql_class.cc#L2428`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_class.cc#L2428) 以降に同じ形の関数が並ぶ。

```cpp title="sql/sql_class.cc"
void THD::inc_status_created_tmp_disk_tables() {
  assert(!status_var_aggregated);
  status_var.created_tmp_disk_tables++;
#ifdef HAVE_PSI_STATEMENT_INTERFACE
  PSI_STATEMENT_CALL(inc_statement_created_tmp_disk_tables)(m_statement_psi, 1);
#endif
}
```

ステータス変数と performance_schema の `events_statements_*.SUM_CREATED_TMP_DISK_TABLES` は**同じ 1 行から生まれる**。値がずれることはない。逆に言えば、片方に出ない現象はもう片方にも出ない。

### 主要ステータス変数の対応表

| ステータス変数                                                     | 加算する場所                                                                                                                                                                                                                                                                                                                                   | 映している仕組み                                                                                 | ページ                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `Handler_read_key`                                                 | [`ha_innobase::index_read` (L10445)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10445)                                                                                                                                                                                                     | インデックスの点検索が何回起きたか                                                               | [handler](./handler-walkthrough/) / [アクセスパスの選択](./access-path-selection/)  |
| `Handler_read_next` / `_prev`                                      | `general_fetch` 系 ([L10861](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10861) / [L10885](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10885))                                                                                           | インデックスを何行なぞったか = range スキャンの実測長                                            | [range 分析](./range-optimizer/)                                                    |
| `Handler_read_first` / `_last`                                     | [L10898](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10898) / [L10919](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10919)                                                                                                                | フルインデックススキャンの開始。`MIN()` / `MAX()` の shortcut                                    | [ORDER BY / GROUP BY](./sort-avoidance-and-ordering/)                               |
| `Handler_read_rnd_next`                                            | [`ha_innobase::rnd_next` (L11086)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L11086)                                                                                                                                                                                                       | フルテーブルスキャンで読んだ行数                                                                 | [クラスタードインデックス](./clustered-index/)                                      |
| `Handler_read_rnd`                                                 | [L11116](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L11116)                                                                                                                                                                                                                                 | rowid で位置指定して読んだ回数 = filesort の rowid ソート後の再読み                              | [filesort](./filesort/)                                                             |
| `Handler_write` / `_update` / `_delete`                            | [L9259](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L9259) / [L10042](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10042) / [L10186](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L10186) | エンジンへの書き込み要求。内部一時表への書き込みも数える                                         | [handler](./handler-walkthrough/)                                                   |
| `Created_tmp_tables` / `Created_tmp_disk_tables`                   | [`THD::inc_status_created_tmp_*` (L2428/L2436)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_class.cc#L2428)                                                                                                                                                                                                                | 内部一時表の作成と、それがディスクに落ちた回数                                                   | [内部一時表](./materialization-and-temptable/)                                      |
| `Created_tmp_files`                                                | `my_tmp_file_created` (mysys)                                                                                                                                                                                                                                                                                                                  | `create_ondisk_from_heap` や filesort のマージ用ファイル                                         | [内部一時表](./materialization-and-temptable/) / [filesort](./filesort/)            |
| `Sort_merge_passes`                                                | [`THD::inc_status_sort_merge_passes` (L2484)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_class.cc#L2484)                                                                                                                                                                                                                  | ソートバッファに収まらず、マージを何巡したか                                                     | [filesort](./filesort/)                                                             |
| `Sort_rows` / `Sort_range` / `Sort_scan`                           | `THD::inc_status_sort_*` (L2492 前後)                                                                                                                                                                                                                                                                                                          | ソートした行数と、ソート対象を range で取ったかスキャンで取ったか                                | [filesort](./filesort/)                                                             |
| `Select_scan`                                                      | [`THD::inc_status_select_scan` (L2476)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_class.cc#L2476)                                                                                                                                                                                                                        | 先頭テーブルをフルスキャンした文の数                                                             | [アクセスパスの選択](./access-path-selection/)                                      |
| `Select_full_join`                                                 | [`THD::inc_status_select_full_join` (L2444)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_class.cc#L2444)                                                                                                                                                                                                                   | インデックスなしで join した文の数                                                               | [join の実行](./join-iterators/)                                                    |
| `Select_range` / `Select_range_check` / `Select_full_range_join`   | `THD::inc_status_select_*`                                                                                                                                                                                                                                                                                                                     | range を使った / `Range checked for each record` になった                                        | [range 分析](./range-optimizer/)                                                    |
| `Slow_queries`                                                     | [`log_slow_applicable` (`sql/log.cc#L1806`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log.cc#L1806) の `long_query_count++`                                                                                                                                                                                                 | **slow log が無効でも数える** (下記)                                                             | このページの後半                                                                    |
| `Com_stmt_reprepare`                                               | [`sql/sql_prepare.cc#L3102`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_prepare.cc#L3102)                                                                                                                                                                                                                                 | prepared statement の再準備。DDL やメタデータ変更で起きる                                        | [prepared statement](./binary-protocol-prepared-statements/)                        |
| `Table_open_cache_hits` / `_misses` / `_overflows`                 | [`sql/table_cache.h#L329`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/table_cache.h#L329)                                                                                                                                                                                                                                     | `table_open_cache` の当たり外れと、上限超過で `TABLE` を捨てた回数                               | [データディクショナリ](./data-dictionary/)                                          |
| `Opened_tables` / `Opened_table_definitions`                       | `System_status_var::opened_tables` ほか                                                                                                                                                                                                                                                                                                        | キャッシュミス後に実際に開いた回数                                                               | [データディクショナリ](./data-dictionary/)                                          |
| `Prepared_stmt_count`                                              | `SHOW_FUNC` (`show_prepared_stmt_count`)                                                                                                                                                                                                                                                                                                       | 生きている PS の数。`max_prepared_stmt_count` と比べる                                           | [prepared statement](./binary-protocol-prepared-statements/)                        |
| `Binlog_cache_use` / `_disk_use`                                   | `binlog.cc` のグローバル変数                                                                                                                                                                                                                                                                                                                   | binlog キャッシュが `binlog_cache_size` を超えて一時ファイルに落ちた回数                         | [binlog](./binlog-walkthrough/)                                                     |
| `Innodb_buffer_pool_read_requests` / `_reads`                      | `export_vars` (下記)                                                                                                                                                                                                                                                                                                                           | 論理読み / 物理読み。差がヒット率                                                                | [バッファプール](./buffer-pool-walkthrough/)                                        |
| `Innodb_buffer_pool_wait_free`                                     | `export_vars`                                                                                                                                                                                                                                                                                                                                  | フリーページ待ち。0 でなければ [page cleaner](./flush-list-and-page-cleaner/) が追いついていない | [flush list と page cleaner](./flush-list-and-page-cleaner/)                        |
| `Innodb_row_lock_waits` / `_time` / `_time_avg` / `_current_waits` | `export_vars`                                                                                                                                                                                                                                                                                                                                  | 行ロック待ちの回数と時間                                                                         | [ロックの種類](./lock-modes-and-types/) / [デッドロック検出](./deadlock-detection/) |
| `Innodb_log_waits`                                                 | `export_vars`                                                                                                                                                                                                                                                                                                                                  | ログバッファが満杯で待った回数。`innodb_log_buffer_size` を疑う                                  | [log writer / flusher](./log-writer-threads/)                                       |
| `Innodb_os_log_fsyncs` / `Innodb_data_fsyncs`                      | `export_vars`                                                                                                                                                                                                                                                                                                                                  | redo の fsync と全体の fsync。`innodb_flush_log_at_trx_commit` の効果が出る                      | [log writer / flusher](./log-writer-threads/)                                       |
| `Innodb_dblwr_writes` / `_pages_written`                           | `export_vars`                                                                                                                                                                                                                                                                                                                                  | doublewrite バッチの回数とページ数                                                               | [doublewrite](./doublewrite/)                                                       |
| `Innodb_truncated_status_writes`                                   | [`ha_innodb.cc#L19217`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L19217)                                                                                                                                                                                                                  | `SHOW ENGINE INNODB STATUS` が 1MiB を超えて削られた回数                                         | [SHOW ENGINE INNODB STATUS](./innodb-status-sections/)                              |
| `Performance_schema_*_lost`                                        | [`storage/perfschema/ha_perfschema.cc#L1524`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/perfschema/ha_perfschema.cc#L1524) 付近                                                                                                                                                                                          | P_S のバッファが足りずデータを捨てた数                                                           | [performance_schema](./performance-schema-internals/)                               |

### `Innodb_*` は読むたびにスナップショットし直す

`Innodb_` で始まる変数は 1 個ずつ登録されているのではなく、[`innodb_status_variables_export[]` (`ha_innodb.cc#L22187`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/handler/ha_innodb.cc#L22187) に `SHOW_FUNC` として 1 個だけ登録され、そこから配列全体が返る。

```cpp title="storage/innobase/handler/ha_innodb.cc"
static int show_innodb_vars(THD *, SHOW_VAR *var, char *) {
  innodb_export_status();
  var->type = SHOW_ARRAY;
  var->value = (char *)&innodb_status_variables;
  var->scope = SHOW_SCOPE_GLOBAL;

  return (0);
}
```

`innodb_export_status()` は [`srv_export_innodb_status` (`srv/srv0srv.cc#L1569`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/srv/srv0srv.cc#L1569) を呼び、全バッファプールインスタンスの統計を集めて `srv_innodb_monitor_mutex` の下で `export_vars` に書き写す。

```cpp title="storage/innobase/srv/srv0srv.cc"
void srv_export_innodb_status(void) {
  buf_pool_stat_t stat;
  buf_pools_list_size_t buf_pools_list_size;
  ...
  buf_get_total_stat(&stat);
  buf_get_total_list_len(&LRU_len, &free_len, &flush_list_len);
  buf_get_total_list_size_in_bytes(&buf_pools_list_size);

  mutex_enter(&srv_innodb_monitor_mutex);
```

`SHOW GLOBAL STATUS LIKE 'Innodb%'` を打つたびにこれが走る。`SHOW ENGINE INNODB STATUS` と同じ mutex を取るので、両方を同時に連打すると待ち合う。

### slow log — 判定は 1 か所、呼び出しは 2 か所

判定は [`log_slow_applicable` (`sql/log.cc#L1780`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log.cc#L1780)、書き込みは `log_slow_do`、その 2 つを繋ぐのが [`log_slow_statement` (L1851)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log.cc#L1851) だ。

```cpp title="sql/log.cc"
void log_slow_statement(THD *thd) {
  if (log_slow_applicable(thd)) log_slow_do(thd);
}
```

呼び出し元は [`sql/sql_parse.cc`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_parse.cc#L2170) の 2 か所しかない。1 つはマルチステートメントのループの中 (`;` で区切られた文ごと)、もう 1 つは [`dispatch_command` の末尾 (L2478)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_parse.cc#L2478) だ。どちらも `thd->update_slow_query_status()` の後に来る。

```cpp title="sql/sql_class.cc"
void THD::update_slow_query_status() {
  if (my_micro_time() > start_utime + variables.long_query_time)
    server_status |= SERVER_QUERY_WAS_SLOW;
}
```

`long_query_time` の比較はここ 1 か所だけで、結果は `SERVER_QUERY_WAS_SLOW` というフラグになる。判定側はこれを読む ([`log.cc#L1796`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log.cc#L1796))。

```cpp title="sql/log.cc"
  const bool warn_no_index =
      ((thd->server_status &
        (SERVER_QUERY_NO_INDEX_USED | SERVER_QUERY_NO_GOOD_INDEX_USED)) &&
       opt_log_queries_not_using_indexes &&
       !(sql_command_flags[thd->lex->sql_command] & CF_STATUS_COMMAND));
  const bool log_this_query =
      ((thd->server_status & SERVER_QUERY_WAS_SLOW) || warn_no_index) &&
      (thd->get_examined_row_count() >= thd->variables.min_examined_row_limit);

  // The docs say slow queries must be counted even when the log is off.
  if (log_this_query) thd->status_var.long_query_count++;
```

読み取れる点が 4 つある。

- `Slow_queries` は**ログが無効でも増える**。コメントがそう明言している
- `min_examined_row_limit` を下回る文は、遅くても記録されない
- `log_queries_not_using_indexes` は `SERVER_QUERY_NO_INDEX_USED` を見る。このフラグは `SHOW` 系の文では立てない
- パースエラーの文 (`ER_PARSE_ERROR`) と `KILL_CONNECTION` されたセッションは対象外

その直後に `log_throttle_qni.log()` を通す。`log_throttle_queries_not_using_indexes` ([`sql/sys_vars.cc#L2622`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L2622)) が 0 でなければ、1 分の窓のなかでその件数までしか書かず、残りはまとめて 1 行に要約する。インデックスなしのクエリでログを溢れさせないための弁だ。

### `log_slow_extra` はステータス変数の差分

`opt_log_slow_extra` が真だと、[`dispatch_command`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_parse.cc#L1380) の入口で `System_status_var` のスナップショットを取る。

```cpp title="sql/sql_parse.cc"
  /* For per-query performance counters with log_slow_statement */
  struct System_status_var query_start_status;
  thd->clear_copy_status_var();
  if (opt_log_slow_extra) {
    thd->copy_status_var(&query_start_status);
  }
```

書くときは現在値との差を出す ([`sql/log.cc#L758`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log.cc#L758) 以降)。

```cpp title="sql/log.cc"
            " Read_first: %lu Read_last: %lu Read_key: %lu"
            " Read_next: %lu Read_prev: %lu"
            " Read_rnd: %lu Read_rnd_next: %lu"
            " Sort_merge_passes: %lu Sort_range_count: %lu"
            " Sort_rows: %lu Sort_scan_count: %lu"
            " Created_tmp_disk_tables: %lu"
            " Created_tmp_tables: %lu"
            " Start: %s End: %s\n",
            ...
            (ulong)(thd->status_var.ha_read_key_count -
                    thd->copy_status_var_ptr->ha_read_key_count),
```

`Read_key` は `Handler_read_key`、`Sort_merge_passes` は同名のステータス変数、という具合に**上の対応表がそのまま slow log の行になる**。`Thread_id` / `Errno` / `Killed` / `Bytes_received` / `Bytes_sent` / `Start` / `End` も同時に付く。

`log_slow_extra` を切ると、書かれるのは `Query_time` / `Lock_time` / `Rows_sent` / `Rows_examined` の 4 つだけになる。

### 出力先は FILE と TABLE の両方

[`Query_logger::slow_log_write` (`sql/log.cc#L1448`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log.cc#L1448) は `slow_log_handler_list` に登録されたハンドラを順に呼ぶ。`log_output` に `FILE` があれば `Log_to_file_event_handler`、`TABLE` があれば `mysql.slow_log` テーブルへの `INSERT` になる。8.4 ではさらに OpenTelemetry のログクライアント (`PSI_LogRecord`) が第 3 の出力先として並ぶ。

`TABLE` を選ぶと `mysql.slow_log` は CSV エンジンのテーブルなので、`log_slow_extra` の追加フィールドは列がなく落ちる。

## どう活かすか

**1 本のクエリが何をしたかを差分で測る。** セッションを 1 本使い、`FLUSH STATUS;` (セッション値をリセット) → 対象のクエリ → `SHOW SESSION STATUS LIKE 'Handler%'` の順に打つ。`Handler_read_rnd_next` が行数ぶん出ていればフルスキャン、`Handler_read_next` が大きければ range スキャンの実測長、`Handler_read_key` が 1 なら点検索だ。`EXPLAIN` の `rows` が見積りなのに対し、これは実測になる ([EXPLAIN の列](./explain-columns/))。

**`Created_tmp_disk_tables` が増える。** 内部一時表がメモリに収まらずディスクに落ちている。`tmp_table_size` はテーブル 1 枚あたり、`temptable_max_ram` はサーバ全体の上限で、意味が違う ([内部一時表](./materialization-and-temptable/))。`SELECT` の `GROUP BY` や `DISTINCT`、`UNION` を疑う。

**`Sort_merge_passes` が 0 でない。** ソート対象が `sort_buffer_size` に収まらず、マージソートの巡回が起きている ([filesort](./filesort/))。`ORDER BY ... LIMIT` のページネーションで深いオフセットを使っていないか、ソートのためにインデックスが使えないかを見る ([ORDER BY / GROUP BY](./sort-avoidance-and-ordering/))。

**`Com_stmt_reprepare` が増える。** prepared statement がメタデータ変更で作り直されている ([prepared statement](./binary-protocol-prepared-statements/))。`MAX_REPREPARE_ATTEMPTS = 3` を超えるとエラーになるので、DDL と PS が競合する時間帯があるということだ。

**`Table_open_cache_overflows` が増える。** `table_open_cache` が足りず、開いた `TABLE` を捨てている ([データディクショナリ](./data-dictionary/))。パーティション表は 1 パーティションが 1 テーブル扱いなので、パーティション数が多いと一気に食う ([パーティショニング](./partitioning/))。

**`Innodb_buffer_pool_wait_free` が 0 でない。** フリーページがなくてスレッドが待っている。[page cleaner](./flush-list-and-page-cleaner/) が追いついていないか、バッファプールが小さすぎる。`innodb_io_capacity` は 8.4 で既定 10000 (8.0 は 200) なので、8.0 時代のチューニング記事をそのまま持ち込まない。

**`Innodb_log_waits` が 0 でない。** ログバッファが満杯でトランザクションが待った ([log writer / flusher](./log-writer-threads/))。`innodb_log_buffer_size` を上げる。

**slow log にタイムアウトしたクエリが出ない。** `log_slow_statement` は `dispatch_command` の末尾で呼ばれる。切断されたセッションの文は書かれない。実行中のものを見たいなら `performance_schema.events_statements_current` か `SHOW PROCESSLIST` を使う ([performance_schema](./performance-schema-internals/))。

**slow log が溢れる。** `log_queries_not_using_indexes=ON` は小さなテーブルへの数千 QPS のクエリまで拾う。`log_throttle_queries_not_using_indexes` を 10 程度にすると 1 分あたりの件数が制限され、残りは要約 1 行になる。`min_examined_row_limit` を設定して、読んだ行が少ない文を除くのも効く。

**slow log から掘り下げる。** `log_slow_extra=ON` にすると 1 行に `Read_key` / `Read_rnd_next` / `Sort_merge_passes` / `Created_tmp_disk_tables` が並ぶ。これらは上の対応表の変数と同じものなので、どの層が原因かの当たりが直接つく。継続的に集計したいなら [`sys.statement_analysis`](./data-locks-and-sys-schema/) を使うほうが、ダイジェスト単位にまとまっていて扱いやすい。
