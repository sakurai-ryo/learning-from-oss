---
title: "ヒントと optimizer_switch"
description: "オプティマイザの挙動を外から変える口は 3 系統ある。23 種のオプティマイザヒント、27 個の optimizer_switch フラグ、そして USE/FORCE/IGNORE INDEX という古い構文。3 つは互いに優先順位を持ち、hint_table_state という 1 本の関数がヒントとスイッチの合流点になっている。/*+ INDEX() */ と FORCE INDEX が同居できないこと、SET_VAR が効く範囲、help 文に載っていないフラグを確かめる。"
group: "オプティマイザ"
sidebar:
  order: 33
---

> **前提**: [アクセスパスの選択](./access-path-selection/) / [join 順序](./join-order-search/)

## 何を学んだか

オプティマイザに口出しする手段は 3 系統あり、**別々のコード経路を通る**。

| 系統                   | 構文                         | 粒度                                          | 実装                   |
| ---------------------- | ---------------------------- | --------------------------------------------- | ---------------------- |
| オプティマイザヒント   | `/*+ BKA(t) */`              | 文 / クエリブロック / テーブル / インデックス | `sql/opt_hints.{h,cc}` |
| `optimizer_switch`     | `SET optimizer_switch='...'` | セッション / グローバル                       | `sql/sys_vars.cc`      |
| 古いインデックスヒント | `USE INDEX (i)`              | テーブル                                      | `sql/table.cc`         |

ヒントとスイッチは [`hint_table_state` / `hint_key_state` (`sql/opt_hints.cc#L891`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/opt_hints.cc#L891) という 2 本の関数で合流する。オプティマイザ側のコードは、この関数を呼ぶだけでヒントとスイッチの両方を考慮したことになる。

```cpp title="sql/opt_hints.cc (L908)"
bool hint_table_state(const THD *thd, const Table_ref *table_list,
                      opt_hints_enum type_arg, uint optimizer_switch) {
  if (table_list->opt_hints_qb) {
    bool ret_val = false;
    if (get_hint_state(table_list->opt_hints_table, table_list->opt_hints_qb,
                       type_arg, &ret_val))
      return ret_val;
  }

  return thd->optimizer_switch_flag(optimizer_switch);
}
```

**ヒントが指定されていればヒントの値、無ければスイッチの値。** 優先関係はこの 4 行に集約されている。第 2 引数に `0` を渡す呼び出しもあり、その場合は「スイッチを見ずヒントだけを見る」という意味になる (`optimizer_switch_flag(0)` は常に false)。

一方、古いインデックスヒントだけは合流しない。新旧が同居すると**新しいほうが古いほうを丸ごと無効にする**。

## なぜそうなっているか

**ヒントとスイッチを 1 本の関数で合流させたのは、優先順位を分散させないためだ。** 「ヒントがあればヒント、無ければスイッチ」というルールを 20 箇所以上のオプティマイザのコードそれぞれに書くと、必ずどこかで食い違う。`hint_table_state(thd, tl, XXX_HINT_ENUM, OPTIMIZER_SWITCH_XXX)` という 1 行に押し込めば、呼ぶ側は優先順位を知らなくてよくなる。第 2 引数に `0` を渡す抜け道があるのは、「スイッチが存在しないヒント」(`INDEX_MERGE`、`SKIP_SCAN` の強制など) のためだ。

**新旧のインデックスヒントを混在させないのは、意味を合成できないからだ。** `USE INDEX (a) /*+ NO_INDEX(t a) */` のような組み合わせに一意な解釈を与えるのは難しい。「新しいほうがあれば古いほうを完全に無視する」という乱暴な規則は、少なくとも予測可能である。同じ理由で `USE INDEX` と `FORCE INDEX` の混在は `ER_WRONG_USAGE` で弾かれる。

**新構文に `USE INDEX` 相当がないのは、`USE INDEX` の意味が弱すぎたからだろう。** 「候補を絞るがフルスキャンは残す」は、指定した意図 (このインデックスを使ってほしい) を満たさないことが多い。新構文は `INDEX` = force に倒し、代わりに用途別 (`JOIN_INDEX` / `GROUP_INDEX` / `ORDER_INDEX`) の粒度を足した。

**`batched_key_access` が既定 off なのは、DS-MRR に依存していて条件が厳しいからだ。** BKA は「キーをまとめてバッファに溜め、MRR でソートしてから読む」join なので、MRR が選ばれない状況では意味がない。そして `mrr_cost_based=on` の既定では MRR がほとんど選ばれない ([アクセスパスの選択](./access-path-selection/))。両方を同時に切り替えないと効かないものを既定 on にはできない。

## ソースコードのどこか

### 23 種のヒント

[`sql/opt_hints.h#L65`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/opt_hints.h#L65) の enum と、[`sql/opt_hints.cc#L65`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/opt_hints.cc#L65) のテーブルが 1 対 1 に対応する。

```cpp title="sql/opt_hints.cc"
struct st_opt_hint_info opt_hint_info[] = {
    {"BKA", true, true, false},
    {"BNL", true, true, false},
    {"ICP", true, true, false},
    {"MRR", true, true, false},
    {"NO_RANGE_OPTIMIZATION", true, true, false},
    {"MAX_EXECUTION_TIME", false, false, false},
    {"QB_NAME", false, false, false},
    {"SEMIJOIN", false, false, false},
    {"SUBQUERY", false, false, false},
    {"MERGE", true, true, false},
    {"JOIN_PREFIX", false, false, true},
    {"JOIN_SUFFIX", false, false, true},
    {"JOIN_ORDER", false, false, true},
    {"JOIN_FIXED_ORDER", false, true, false},
    {"INDEX_MERGE", false, false, false},
    {"RESOURCE_GROUP", false, false, false},
    {"SKIP_SCAN", false, false, false},
    {"HASH_JOIN", true, true, false},
    {"INDEX", false, false, false},
    {"JOIN_INDEX", false, false, false},
    {"GROUP_INDEX", false, false, false},
    {"ORDER_INDEX", false, false, false},
    {"DERIVED_CONDITION_PUSHDOWN", true, true, false},
    {nullptr, false, false, false}};
```

各行の 3 つの bool が性質を表す。

- **`check_upper_lvl`** — 上位レベルのヒントを継承するか。`BKA` をクエリブロックに書けば、そのブロックの全テーブルに効く
- **`switch_hint`** — 単純な on/off か (引数を取らないか)
- **`irregular_hint`** — 特別な印字が要るか。join 順序ヒント 3 つだけが true

`NO_` を前置した形は同じ enum の off 側として扱われる。印字は 1 箇所にまとまっている。

```cpp title="sql/opt_hints.cc (L160)"
void Opt_hints::append_hint_type(String *str, opt_hints_enum type) {
  const char *hint_name = opt_hint_info[type].hint_name;
  if (!hints_map.switch_on(type)) str->append(STRING_WITH_LEN("NO_"));
  str->append(hint_name);
}
```

**`SET_VAR` はこの表に入っていない。** 別扱いの「不規則ヒント」で、`Opt_hints_global::sys_var_hint` にぶら下がる。

### 27 個の `optimizer_switch` フラグ

定数は [`sql/sql_const.h#L191`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_const.h#L191) からの `1ULL << 0` 〜 `1ULL << 26` で、`OPTIMIZER_SWITCH_LAST` が `1ULL << 27`。名前の配列は [`sql/sys_vars.cc#L3267`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L3267) にある。

```cpp title="sql/sys_vars.cc"
/**
  @note
  @b BEWARE! These must have the same order as the \#defines in sql_const.h!
*/
static const char *optimizer_switch_names[] = {
    "index_merge",
    ...
    "use_invisible_indexes",
    "skip_scan",
    "hash_join",
    "subquery_to_derived",
    "prefer_ordering_index",
    "hypergraph_optimizer",  // Deliberately not documented below.
    "derived_condition_pushdown",
    "hash_set_operations",
    "default",
    NullS};
```

配列の要素は 27 個 + `"default"` + `NullS`。**`default` はフラグではなく、`Sys_var_flagset` が「既定値に戻す」ために持つ疑似項目**だ。

`hypergraph_optimizer` には `Deliberately not documented below` というコメントが付いている。実際、直後の help 文字列と突き合わせると 2 つ足りない。

| フラグ                  | help 文に載るか       | 既定    |
| ----------------------- | --------------------- | ------- |
| `use_invisible_indexes` | **載らない**          | off     |
| `hypergraph_optimizer`  | **載らない** (意図的) | off     |
| `subquery_to_derived`   | 載る                  | off     |
| `batched_key_access`    | 載る                  | **off** |
| 上記以外の 23 個        | 載る                  | on      |

既定値は [`sql/sys_vars.cc#L201`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L201) の `OPTIMIZER_SWITCH_DEFAULT` を数えれば分かる。

```cpp title="sql/sys_vars.cc"
// Including the switch in this set, makes its default 'on'
static constexpr const unsigned long long OPTIMIZER_SWITCH_DEFAULT{
    OPTIMIZER_SWITCH_INDEX_MERGE | OPTIMIZER_SWITCH_INDEX_MERGE_UNION |
    OPTIMIZER_SWITCH_INDEX_MERGE_SORT_UNION |
    OPTIMIZER_SWITCH_INDEX_MERGE_INTERSECT |
    OPTIMIZER_SWITCH_ENGINE_CONDITION_PUSHDOWN |
    OPTIMIZER_SWITCH_INDEX_CONDITION_PUSHDOWN | OPTIMIZER_SWITCH_MRR |
    OPTIMIZER_SWITCH_MRR_COST_BASED | OPTIMIZER_SWITCH_BNL |
    OPTIMIZER_SWITCH_MATERIALIZATION | OPTIMIZER_SWITCH_SEMIJOIN |
    OPTIMIZER_SWITCH_LOOSE_SCAN | OPTIMIZER_SWITCH_FIRSTMATCH |
    OPTIMIZER_SWITCH_DUPSWEEDOUT | OPTIMIZER_SWITCH_SUBQ_MAT_COST_BASED |
    OPTIMIZER_SWITCH_USE_INDEX_EXTENSIONS |
    OPTIMIZER_SWITCH_COND_FANOUT_FILTER | OPTIMIZER_SWITCH_DERIVED_MERGE |
    OPTIMIZER_SKIP_SCAN | OPTIMIZER_SWITCH_HASH_JOIN |
    OPTIMIZER_SWITCH_PREFER_ORDERING_INDEX |
    OPTIMIZER_SWITCH_DERIVED_CONDITION_PUSHDOWN |
    OPTIMIZER_SWITCH_HASH_SET_OPERATIONS};
```

23 個。**`OPTIMIZER_SWITCH_BKA` (= `batched_key_access`) はここに入っていない。** BKA join を使いたければ明示的に on にする必要があり、しかも BKA は MRR に依存するので `mrr_cost_based` も切る必要が出る ([アクセスパスの選択](./access-path-selection/))。ドキュメントでは `batched_key_access=on,mrr_cost_based=off` をセットで指定する、と案内される理由がこれだ。

`OPTIMIZER_SKIP_SCAN` だけ命名が `OPTIMIZER_SWITCH_` 接頭辞になっていないのも、この定数群の細かい傷である。

### `hypergraph_optimizer` の特別扱い

[`check_optimizer_switch` (`sql/sys_vars.cc#L3233`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L3233) が、このフラグだけ検証を挟む。

```cpp title="sql/sys_vars.cc"
  if (current_hypergraph_optimizer && !want_hypergraph_optimizer) {
    // Don't turn off the hypergraph optimizer on set optimizer_switch=DEFAULT.
    // This is so that mtr --hypergraph should not be easily cancelled in the
    // middle of a test, unless the test explicitly meant it.
    if (var->value == nullptr) {
      var->save_result.ulonglong_value |= OPTIMIZER_SWITCH_HYPERGRAPH_OPTIMIZER;
    }
  } else if (!current_hypergraph_optimizer && want_hypergraph_optimizer) {
#ifdef WITH_HYPERGRAPH_OPTIMIZER
    // Allow, with a warning.
    push_warning(thd, Sql_condition::SL_WARNING, ER_WARN_DEPRECATED_SYNTAX,
                 ER_THD(thd, ER_WARN_HYPERGRAPH_EXPERIMENTAL));
    return false;
#else
    // Disallow; the hypergraph optimizer is not ready for production yet.
    my_error(ER_HYPERGRAPH_NOT_SUPPORTED_YET, MYF(0),
             "use in non-debug builds");
    return true;
#endif
  }
```

面白いのは前半で、**`SET optimizer_switch = DEFAULT` では hypergraph を off にしない**。テストの途中でうっかりキャンセルされないようにするための配慮だ。詳細は [hypergraph のページ](./hypergraph-optimizer/)。

### `/*+ INDEX() */` と `FORCE INDEX` の関係

この 2 つは**同居しない**。分岐は [`sql/sql_resolver.cc#L1299`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_resolver.cc#L1299) の 1 箇所にある。

```cpp title="sql/sql_resolver.cc"
    if (!tr->opt_hints_table ||
        // Ignore old index hint processing if new style hints are specified.
        !tr->opt_hints_table->update_index_hint_maps(thd, tr->table)) {
      if (tr->process_index_hints(thd, table)) return true;
    }
```

[`update_index_hint_maps` (`sql/opt_hints.cc#L641`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/opt_hints.cc#L641) は、`INDEX` / `JOIN_INDEX` / `GROUP_INDEX` / `ORDER_INDEX` のいずれかが指定されていれば true を返す。**true が返ると `process_index_hints` は呼ばれず、`USE INDEX` / `FORCE INDEX` / `IGNORE INDEX` は完全に無視される。**

両者は同じ 4 つのフィールドを設定するが、意味の作り方が違う。

```cpp title="sql/opt_hints.cc (L641-665)"
bool Opt_hints_table::update_index_hint_maps(THD *thd, TABLE *tbl) {
  if (!is_resolved(INDEX_HINT_ENUM) && !is_resolved(JOIN_INDEX_HINT_ENUM) &&
      !is_resolved(GROUP_INDEX_HINT_ENUM) &&
      !is_resolved(ORDER_INDEX_HINT_ENUM))
    return false;  // No index hint is specified

  Key_map usable_index_map(tbl->s->usable_indexes(thd));
  tbl->keys_in_use_for_query = tbl->keys_in_use_for_group_by =
      tbl->keys_in_use_for_order_by = usable_index_map;

  const bool force_index = is_force_index_hint(INDEX_HINT_ENUM);
  tbl->force_index = (force_index || is_force_index_hint(JOIN_INDEX_HINT_ENUM));
  tbl->force_index_group =
      (force_index || is_force_index_hint(GROUP_INDEX_HINT_ENUM));
  tbl->force_index_order =
      (force_index || is_force_index_hint(ORDER_INDEX_HINT_ENUM));

  if (tbl->force_index || tbl->force_index_group || tbl->force_index_order) {
    tbl->keys_in_use_for_query.clear_all();
```

**新しい `INDEX(t idx)` ヒントは、それだけで `force_index = true` になる。** `is_force_index_hint` は「解決済みで、かつ on 側 (`NO_` が付いていない)」を意味する。

```cpp title="sql/opt_hints.h (L630)"
  bool is_force_index_hint(opt_hints_enum type_arg) {
    return (get_compound_key_hint(type_arg)->is_resolved() &&
            get_switch(type_arg));
  }
```

対して古い構文は [`Table_ref::process_index_hints` (`sql/table.cc#L6432`)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/table.cc#L6432) で、`USE` と `FORCE` を区別する。

```cpp title="sql/table.cc (L6517-6526)"
    /*
      TODO: get rid of tbl->force_index (on if any FORCE INDEX is specified) and
      create tbl->force_index_join instead.
      Then use the correct force_index_XX instead of the global one.
    */
    if (!index_join[INDEX_HINT_FORCE].is_clear_all() ||
        tbl->force_index_group || tbl->force_index_order) {
      tbl->force_index = true;
      index_join[INDEX_HINT_USE].merge(index_join[INDEX_HINT_FORCE]);
    }
```

まとめるとこうなる。

| 書き方                    | `keys_in_use_for_query` | `force_index`              |
| ------------------------- | ----------------------- | -------------------------- |
| `USE INDEX (i)`           | `{i}` に絞る            | false                      |
| `FORCE INDEX (i)`         | `{i}` に絞る            | **true**                   |
| `IGNORE INDEX (i)`        | `i` を除く              | false                      |
| `/*+ INDEX(t i) */`       | `{i}` に絞る            | **true**                   |
| `/*+ NO_INDEX(t i) */`    | `i` を除く              | false                      |
| `/*+ JOIN_INDEX(t i) */`  | join 用だけ `{i}`       | `force_index` = true       |
| `/*+ ORDER_INDEX(t i) */` | ORDER BY 用だけ `{i}`   | `force_index_order` = true |

**`/*+ INDEX(t i) */` は `USE INDEX (i)` ではなく `FORCE INDEX (i)` に相当する。** 新旧の対応を「`INDEX` = `USE INDEX`」と覚えていると挙動が合わない。`USE INDEX` に相当する新構文は無い。

`force_index` の効き目は 3 箇所ある。

- `best_access_path` — フルテーブルスキャンを候補から外す ([アクセスパスの選択](./access-path-selection/))
- `calculate_scan_cost` — `table->force_index && !best_ref` ならインデックススキャンのコストを使う
- `test_if_cheaper_ordering` — `is_force_index` なら `prefer_ordering_index` が off でも呼ばれ、LIMIT の閾値判定も緩む ([ORDER BY のページ](./sort-avoidance-and-ordering/))

**`force_index` は「必ずそのインデックスを使う」ではない。** 「使えるインデックスの集合を絞り、フルスキャンを不利にする」だけだ。絞った結果どのインデックスも使えなければ、フルスキャンに戻る。

### `SET_VAR`

`SET_VAR` は `Sys_var_hint` ([`sql/opt_hints.h#L687`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/opt_hints.h#L687)) が持つ、システム変数の一時上書きだ。適用と復元は 1 対になっている。

```cpp title="sql/sql_parse.cc (L3332 / L4896)"
    lex->opt_hints_global->sys_var_hint->update_vars(thd);
    ...
    lex->opt_hints_global->sys_var_hint->restore_vars(thd);
```

どちらも `mysql_execute_command` の中で、`update_vars` が実行前、`restore_vars` が実行後 (エラー経路も含む) に呼ばれる。prepared statement 用に `sql/sql_prepare.cc` にも同じ対があり、**`SET_VAR` はその 1 文の実行中しか効かない**。

```cpp title="sql/opt_hints.cc (L789)"
void Sys_var_hint::update_vars(THD *thd) {
  // Skip SET_VAR hint applying on the slave.
  if (thd->slave_thread) return;
```

**レプリカの applier スレッドでは `SET_VAR` を適用しない。** binlog 経由で流れてきた文に含まれる `SET_VAR` は無視される。

同じ変数を 2 回指定すると、2 つ目は `ER_WARN_CONFLICTING_HINT` の警告を出して捨てられる ([`add_var` L756](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/opt_hints.cc#L756))。

`SET_VAR` で指定できるのは、`sys_vars.cc` で `HINT_UPDATEABLE` が付いたセッション変数だけだ。`optimizer_switch`、`optimizer_search_depth`、`optimizer_prune_level`、`join_buffer_size`、`eq_range_index_dive_limit`、`range_optimizer_max_mem_size` などが該当する。

## どう活かすか

### ヒントを書く順に選ぶ

1. **`/*+ SET_VAR(...) */`** — 「このクエリだけ設定を変えたい」。`SET SESSION` を前後に挟むより安全 (エラー時も復元される) で、アプリケーションから 1 文で送れる
2. **`/*+ NO_INDEX_MERGE(t) */` などの否定形** — 「この最適化だけ止めたい」。肯定形より副作用が小さい
3. **`/*+ INDEX(t idx) */`** — 「このインデックスを使わせたい」。`FORCE INDEX` 相当
4. **`/*+ JOIN_ORDER(t1, t2) */` / `STRAIGHT_JOIN`** — 「join 順序を固定したい」。最後の手段

`QB_NAME` でクエリブロックに名前を付けると、外側から内側のブロックにヒントを書ける。サブクエリや派生表の中に手を入れられないとき (ビュー越しなど) に効く。

### `FORCE INDEX` が効かないとき

`force_index` は候補を絞るだけなので、次の場合は効かない。

- **指定したインデックスで range も ref も作れない。** 区間が作れなければ候補にならず、フルスキャンに戻る ([range 分析](./range-optimizer/))
- **`FORCE INDEX FOR ORDER BY` を指定したが、`test_if_order_by_key` が失敗する。** 並びが一致しなければ順序は得られない
- **`FORCE INDEX` を指定したテーブルが const table になった。** 最適化中に読まれて消える

`FORCE INDEX` を書いたのに `type: ALL` のままなら、それは「絞った結果、使えるものが無かった」ということだ。EXPLAIN の `possible_keys` が空になっているはずである。

### `optimizer_switch` を触る前に

セッション単位・文単位で試して、本当に効くか確認してから恒久化する。

```sql
SELECT /*+ SET_VAR(optimizer_switch='prefer_ordering_index=off') */ ...
```

グローバルに変えると影響範囲が読めない。特に次の 3 つは副作用が大きい。

- **`index_merge=off`** — index merge の 4 つのサブ戦略が全部止まる ([range 分析](./range-optimizer/))
- **`derived_merge=off`** — すべての派生表とビューが materialize される。条件プッシュダウンは残るが、merge で消えていた一時表が全部復活する
- **`condition_fanout_filter=off`** — `filtered` の推定が変わり、join 順序が全面的に変わる。加えて `calculate_scan_cost` の「25% ハードコード」経路に落ちる

### help 文に出ないフラグを知っておく

`SHOW VARIABLES LIKE 'optimizer_switch'` の出力には 27 個全部が並ぶが、`--help` やマニュアルの列挙には `use_invisible_indexes` と `hypergraph_optimizer` が出てこない。

- **`use_invisible_indexes=on`** — `ALTER TABLE ... ALTER INDEX i INVISIBLE` で隠したインデックスを、そのセッションだけ見えるようにする。インデックス削除前の影響確認に使う正規の手順だが、`optimizer_switch` の一覧を眺めているだけでは見つからない
- **`hypergraph_optimizer=on`** — release ビルドではエラーになる ([hypergraph のページ](./hypergraph-optimizer/))

### ヒントが効いているかの確認

`EXPLAIN` の後に `SHOW WARNINGS` を打つと、**解決済みのヒントが付いた形にクエリが再構成されて表示される**。`Opt_hints::print` がヒントを印字するので、書いたヒントがそこに出ていれば認識されている。

出ていない場合は解決に失敗している。テーブル名の綴り違いやクエリブロックの取り違えで、`ER_UNRESOLVED_HINT_NAME` の警告が出る。**ヒントの構文エラーはエラーにならず警告で済む**ので、黙って無視されることがある。
