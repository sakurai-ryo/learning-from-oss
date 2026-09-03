---
title: "クラッシュセーフとフィルタ — relay_log_info をテーブルに持つ理由"
description: "レプリカの位置情報を mysql.slave_relay_log_info という InnoDB テーブルに置くと、位置の更新が適用データと同じトランザクションに入る。これがクラッシュセーフの正体で、pre_commit / post_commit という 2 段のフックで実装されている。フィルタが適用のどの段で効くか、START REPLICA UNTIL の 4 種類がどこで判定されるか、そして SLAVE / MASTER というトークンが 8.4 のどこに残っているかを確かめる。"
group: "binlog とレプリケーション"
sidebar:
  order: 92
---

## 何を学んだか

レプリカが「どこまで適用したか」を覚えるとき、素朴にはファイルに書けばよさそうに見える。実際 MySQL は長らく `relay-log.info` というファイルを使っていた。**その方式には「データを適用した」と「位置を記録した」が別の操作になるという原理的な欠陥がある。** 間でクラッシュすれば、同じトランザクションが二度適用されるか、飛ばされる。

8.4 の答えは単純だ。**位置情報を InnoDB テーブル (`mysql.slave_relay_log_info`) に置き、位置の更新を、適用したデータと同じトランザクションに入れる。** コミットは 1 回なので、「適用したが位置を記録していない」状態が存在しなくなる。

この設計を支えているのが `Relay_log_info::pre_commit()` / `post_commit()` という 2 段のフックだ ([`sql/rpl_rli.h#L2132`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_rli.h#L2132))。

```cpp title="sql/rpl_rli.h"
  bool pre_commit() {
    bool rc = false;

    if (is_transactional()) {
      static_cast<Query_log_event *>(current_event)->has_ddl_committed = true;
      rc = commit_positions();
    }
    return rc;
  }
```

**`is_transactional()` は「リポジトリのテーブルがトランザクショナルなエンジンか」を実際に問い合わせた結果だ** ([`rpl_info_table.cc#L828`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_info_table.cc#L828))。

```cpp title="sql/rpl_info_table.cc"
  is_transactional = table->file->has_transactions();
```

もう 1 つ、この群を通して見えてくるのが**用語変更の不徹底**だ。SQL の語彙は `SOURCE` / `REPLICA` に変わったが、テーブル名は `mysql.slave_master_info` のまま、関数名は `handle_slave_io` のまま、権限は `REPLICATION SLAVE` のままだ。

## ソースコードのどこか

### 3 つのテーブルと、その登録場所

テーブル名は [`sql/table.cc#L154`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/table.cc#L154) に定数として置かれている。

```cpp title="sql/table.cc"
/* RLI_INFO name */
LEX_CSTRING RLI_INFO_NAME = {STRING_WITH_LEN("slave_relay_log_info")};

/* MI_INFO name */
LEX_CSTRING MI_INFO_NAME = {STRING_WITH_LEN("slave_master_info")};

/* WORKER_INFO name */
LEX_CSTRING WORKER_INFO_NAME = {STRING_WITH_LEN("slave_worker_info")};
```

| テーブル                     | 誰が書くか               | 何を持つか                               |
| ---------------------------- | ------------------------ | ---------------------------------------- |
| `mysql.slave_master_info`    | receiver                 | source の接続情報と、どこまで受信したか  |
| `mysql.slave_relay_log_info` | applier (コーディネータ) | どこまで適用したか                       |
| `mysql.slave_worker_info`    | 各 worker                | worker ごとの適用位置 (MTA のリカバリ用) |

データディクショナリへの登録は [`sql/dd/impl/system_registry.cc#L237`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/dd/impl/system_registry.cc#L237)。

```cpp title="sql/dd/impl/system_registry.cc"
  register_table("slave_master_info", system);
  register_table("slave_master_info_backup", system);
  register_table("slave_worker_info", system);
  register_table("slave_relay_log_info", system);
```

`system` として登録されているので、ユーザからの直接更新には警告か拒否が出る。

### 位置更新をトランザクションに入れる 2 段のフック

[`Relay_log_info::commit_positions` (`rpl_rli.cc#L2815`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_rli.cc#L2815) は、**「これから確定する位置」をテーブルへ書いてから、メモリ上の値を元に戻す**という一見奇妙なことをする。

```cpp title="sql/rpl_rli.cc"
  /* Update to new values just for the sake of flush_info */
  inc_event_relay_log_pos();
  set_group_relay_log_pos(get_event_relay_log_pos());
  set_group_relay_log_name(get_event_relay_log_name());
  set_group_master_log_pos(current_event->common_header->log_pos);
  /* save them too, but now for post_commit() time */
  ...
  error = flush_info(RLI_FLUSH_IGNORE_SYNC_OPT);

  /*
    Restore the saved ones so they remain actual until the replicated
    statement commits.
  */
  set_group_master_log_name(saved_group_master_log_name);
```

**テーブルへの `UPDATE` は「コミット後の位置」で行い、メモリ上の値は「コミット前の位置」に戻す。** この `UPDATE` は適用中のトランザクションの一部なので、トランザクションがロールバックすれば位置の更新も消える。コミットが成功したら [`post_commit` (L2866)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_rli.cc#L2866) がメモリ上の値を新しい位置に進める。

```cpp title="sql/rpl_rli.cc"
    /*
      New executed coordinates prepared in pre_commit() are
      finally installed.
    */
    mysql_mutex_lock(&data_lock);
    set_group_master_log_name(new_group_master_log_name);
```

**メモリ (`SHOW REPLICA STATUS` が読む値) とテーブル (クラッシュ後に読む値) を、コミットの前後で正しくずらす**のがこの 2 段の役割だ。

### `Rpl_info_table` — 876 行の汎用アクセッサ

[`sql/rpl_info_table.cc`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_info_table.cc) は 876 行で、3 つのテーブルすべてを 1 つの実装で扱う。`do_set_info` / `do_get_info` が型ごとにオーバーロードされていて、フィールドは位置 (`pos`) で指定する。

書き込みは常に `option_bits &= ~OPTION_BIN_LOG` で binlog を無効にしてから行う ([L818](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_info_table.cc#L818) など)。**レプリカの位置情報がレプリカ自身の binlog に流れると、その先のレプリカ (チェーンレプリケーション) が壊れる。**

テーブルが壊れていないかの検査もある ([`verify_table_primary_key_fields` (L839)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_info_table.cc#L839))。主キーの列数と位置が期待どおりでなければ `ER_RPL_CORRUPTED_KEYS_IN_INFO_TABLE` を吐く。**手で `ALTER TABLE mysql.slave_master_info` すると、レプリケーションが起動しなくなる。**

### `relay_log_recovery` — relay log を捨てて取り直す

[`sys_vars.cc#L5971`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L5971)、既定 `false`、READ_ONLY。

```cpp title="sql/sys_vars.cc"
static Sys_var_bool Sys_relay_log_recovery(
    "relay_log_recovery",
    "If enabled, existing relay logs will be skipped by the "
    "replication threads. The receiver will start a new relay "
    "log and the applier will start reading from the beginning of that file. "
    "The receiver's position relative to the source will be reset to the "
    "applier's "
    "position relative to the source; the receiver uses this in case "
    "SOURCE_AUTO_POSITION=0.",
    READ_ONLY GLOBAL_VAR(relay_log_recovery), CMD_LINE(OPT_ARG),
    DEFAULT(false));
```

**やっていることは「既存の relay log を全部捨てて、applier の位置から受信し直す」だ。** relay log 自体はクラッシュセーフではない (受信中に落ちれば半端なイベントが残る) ので、捨てて取り直すのが確実になる。applier の位置はテーブルにあって正確なので、そこから再取得すれば整合する。

`relay_log_info_repository` / `master_info_repository` というシステム変数は 8.4 には存在しない。**リポジトリはテーブル固定になった。**

同じ理由で `sync_relay_log_info` は非推奨だ ([`sys_vars.cc#L6117`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L6117) の `DEPRECATED_VAR("")`)。テーブル方式では位置の永続化が InnoDB のコミットに乗るので、この変数が制御していた `fsync` 周期に意味がない。

### レプリケーションフィルタ

[`sql/rpl_filter.h#L214`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_filter.h#L214) の `Rpl_filter`。判定の入口は 3 つしかない。

```cpp title="sql/rpl_filter.h"
  bool tables_ok(const char *db, Table_ref *tables);
  bool db_ok(const char *db, bool need_increase_counter = true);
  bool db_ok_with_wild_table(const char *db);
```

ルールは `do_db` / `ignore_db` / `do_table` / `ignore_table` / `wild_do_table` / `wild_ignore_table` / `rewrite_db` の 7 種類。**グローバルとチャネルごとの 2 階層**があり、チャネル側が空ならグローバルがコピーされる (`copy_global_replication_filters`)。

観測は `Rpl_pfs_filter` ([`rpl_filter.h#L167`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_filter.h#L167)) 経由で `performance_schema.replication_applier_filters` と `replication_applier_global_filters` に出る。

**フィルタが参照されるのは applier 側だ。** `rli->rpl_filter` を引いているのは [`Query_log_event::do_apply_event` (`log_event.cc#L5038`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log_event.cc#L5038) と [`Table_map_log_event::do_apply_event` (L10980)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/log_event.cc#L10980)、それに `sql_parse.cc` の `all_tables_not_ok` ([L298](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_parse.cc#L298)) で、いずれもイベントを適用する段だ。

**receiver は素通しなので、フィルタで捨てられるトランザクションも relay log には書かれる。** ネットワーク帯域とレプリカのディスクは節約できない。source 側で減らしたいなら `binlog_do_db` / `binlog_ignore_db` (`binlog_filter`、[`binlog.cc#L7230`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/binlog.cc#L7230)) という別のフィルタになるが、こちらは binlog そのものが不完全になるのでバックアップとしての価値を失う。

### `START REPLICA UNTIL` の 4 種類

[`sql/rpl_replica_until_options.h`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_replica_until_options.h)。`Until_option` を基底に、クラス階層がそのまま構文に対応する。

```
Until_option (L56)
├── Until_position (L145)
│   ├── Until_master_position (L215)  SOURCE_LOG_FILE / SOURCE_LOG_POS
│   └── Until_relay_position (L243)   RELAY_LOG_FILE / RELAY_LOG_POS
└── Until_gtids (L260)
    ├── Until_before_gtids (L293)     SQL_BEFORE_GTIDS
    └── Until_after_gtids (L305)      SQL_AFTER_GTIDS
```

判定フックは 4 つある。

```cpp title="sql/rpl_replica_until_options.h"
  virtual bool check_at_start_slave() = 0;
  virtual bool check_before_dispatching_event(const Log_event *ev) = 0;
  virtual bool check_after_dispatching_event() = 0;
  virtual bool check_all_transactions_read_from_relay_log() = 0;
```

4 つ目があるのは MTA のためだ。**`SQL_AFTER_GTIDS` では「指定した GTID を含むトランザクションが全 worker で完了した」ことを確認しないと止められない。** 単に relay log を読み終えただけでは足りない (`Until_after_gtids::check_all_transactions_executed`)。

`check_before_dispatching_event` が true を返すと、コーディネータが `SLAVE_APPLY_EVENT_UNTIL_REACHED` を返して applier を止める ([`rpl_replica.cc#L4965`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_replica.cc#L4965))。

### `SLAVE` / `MASTER` が残っている場所

8.4 の用語変更は SQL の表層だけで、内部には旧語彙が残っている。

| 場所           | 8.4 での姿                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 権限           | `GRANT REPLICATION SLAVE` ([`sql_yacc.yy#L16606`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_yacc.yy#L16606))                         |
| イベント定義   | `CREATE EVENT ... DISABLE ON SLAVE` (非推奨警告つき、[`sql_yacc.yy#L3587`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_yacc.yy#L3587)) |
| テーブル       | `mysql.slave_master_info` / `slave_relay_log_info` / `slave_worker_info`                                                                                   |
| 関数           | `handle_slave_io` / `handle_slave_sql` / `handle_slave_worker`                                                                                             |
| ステータス変数 | `Slave_open_temp_tables` など                                                                                                                              |
| プラグイン     | `rpl_semi_sync_master` (旧名版が別プラグインとして併存、[半同期のページ](./semi-sync/))                                                                    |

**`REPLICATION SLAVE` は権限名なので、変えると既存の `GRANT` 文が動かなくなる。** テーブル名も同じ理由で固定されている。**「非推奨エイリアス」で済むもの (システム変数) だけが改名され、識別子として使われるものは残った**、と読める。システム変数の旧名は `Sys_var_deprecated_alias` で 1 行ずつ張られている ([`sys_vars.cc#L4063`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L4063) など)。

## なぜそうなっているか

**位置情報をテーブルに移したのは、「2 つの書き込みを 1 つのコミットにまとめる」以外にクラッシュセーフを実現する方法がないからだ。** ファイル方式では「データをコミット → 位置をファイルに書く」の間にクラッシュ窓が必ず残る。窓を小さくすることはできても消せない。**同じトランザクションに入れれば窓は原理的に存在しない。**

**`pre_commit` / `post_commit` の 2 段構成が必要なのは、「テーブルに書く値」と「メモリに見せる値」がコミットの前後で違うからだ。** テーブルには「コミット後の位置」を書かねばならない (コミットしたら本当にそこまで進んだので)。一方 `SHOW REPLICA STATUS` は「今コミット中のもの」を完了扱いにしてはいけない。**この 2 つを両立させるために、書いてから戻す、という書き方になっている。**

**relay log をクラッシュセーフにしなかったのは、そこまでする必要がないからだ。** relay log は source から取り直せる。壊れていたら捨てて再取得すれば整合する (`relay_log_recovery`)。**取り直せないもの (適用済み位置) だけをトランザクショナルにすれば十分**という割り切りだ。

**フィルタを applier 側に置いたのは、receiver を単純に保つためだ。** receiver がフィルタを適用するには、イベントをデコードして DB 名とテーブル名を取り出す必要がある。`Rows_log_event` からそれを取るには `Table_map` を追跡しなければならず、receiver が状態を持つことになる ([dump thread と receiver](./dump-thread-and-receiver/))。**受信を素通しにして、解釈が必要なことは全部 applier に寄せた**という分業が一貫している。

**`START REPLICA UNTIL` に判定フックが 4 つあるのは、MTA が「読んだ順 = 完了した順」ではないからだ。** シングルスレッドなら「このイベントの前で止める」の 1 つで済む。並列適用では、指定した GTID が完了しても、その前の GTID がまだ動いている worker があるかもしれない。**`check_all_transactions_read_from_relay_log` と `check_all_transactions_executed` は、並列化が持ち込んだ複雑さへの対応だ。**

**用語変更が中途半端に見えるのは、後方互換の優先順位が明快だからだ。** 「SQL 文を書き直せば済むもの」は変え、「変えると既存の権限やスクリプトが壊れるもの」は残した。`SHOW REPLICA STATUS` は新しい名前で、その中身の `mysql.slave_master_info` は古い名前、という混在はここから来ている。

## どう活かすか

**`mysql.slave_*` テーブルを直接 `UPDATE` しない。** `verify_table_primary_key_fields` が主キーの列数と位置を検査していて、構造が違えば `ER_RPL_CORRUPTED_KEYS_IN_INFO_TABLE` でレプリケーションが起動しない。位置を変えたいなら `CHANGE REPLICATION SOURCE TO` を使う。バックアップから戻すときも、これらのテーブルを含めるか除くかを意識する。

**物理バックアップからレプリカを作るとき、`mysql.slave_*` テーブルはバックアップ元の位置を持っている。** `RESET REPLICA ALL` でクリアしてから `CHANGE REPLICATION SOURCE TO` で張り直す。**`RESET REPLICA` (ALL なし) はテーブルの中身を消さない**ので、意図した状態にならないことがある。

**`relay_log_recovery=ON` は READ_ONLY なので、起動時に設定する必要がある。** クラッシュ後の起動で確実に整合させたいなら、設定ファイルに書いておく。ON にすると起動のたびに relay log を捨てて取り直すので、source からの再取得ぶんだけ追いつきが遅れる。**`SOURCE_AUTO_POSITION=1` (GTID) を使っているなら、位置の再計算は GTID が担うので相性がよい。**

**`sync_relay_log_info` を調整する記事は 8.4 では意味がない。** 非推奨で、テーブル方式では位置の永続化が InnoDB のコミットに乗っている。触るべきは `innodb_flush_log_at_trx_commit` のほうだ。

**レプリカ側のフィルタはネットワークもディスクも節約しない。** 判定は適用の段でしか行われないので、捨てるデータも一度は relay log に書かれる。「レプリカを軽くする」目的でフィルタを入れても、減るのは適用のコストだけだ。**転送量を減らしたいなら、source 側を分けるか別チャネルにする。**

**`START REPLICA UNTIL SQL_AFTER_GTIDS` はポイントインタイムリカバリの主力だ。** 「この GTID まで適用したら止まる」が MTA でも正確に効く。ファイル+ポジション指定 (`UNTIL SOURCE_LOG_POS`) は、フェイルオーバー後に意味を失う位置指定なので、GTID を使えるなら使う。

**`SHOW PROCESSLIST` や監視スクリプトで `Slave` を grep しているなら 8.4 でも動く。** 内部名が残っているので、`handle_slave_sql` 由来のスレッド名やステータス変数 `Slave_open_temp_tables` はそのままだ。逆に `SHOW SLAVE STATUS` を打っているスクリプトは、いずれ動かなくなる可能性があるので `SHOW REPLICA STATUS` に寄せる。
