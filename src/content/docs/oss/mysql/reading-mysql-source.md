---
title: "ソースの読み方 — 1 つのツリーに 2 つの方言がある"
description: "MySQL のソースが読みにくいのは概念が難しいからではなく、sql/ と storage/innobase/ で書式が違うからだ。assert の書き方も、エラーの返し方も、ログの出し方も、メモリの解放の仕方も別。btr0cur.cc の 0 が何か、ut_ad がリリースビルドで消えること、SQL 層は true がエラーで InnoDB の DB_SUCCESS は 10 であること。この 4 つを先に知っているだけで、以降のページのコード片が「読むもの」から「確認するもの」に変わる。"
group: "前提 — 用語と DB の基礎"
sidebar:
  order: 0.7
---

> **前提**: [用語集](./glossary/)

## 何を学んだか

このページはコードの中身ではなく、**コードの書式**の話だ。以降のページはどれも C++ の断片を引用するが、その断片が読みにくい原因の大半は InnoDB や オプティマイザの難しさではなく、**1 つのツリーに 2 つの方言が同居していること**にある。

- `sql/` — 2000 年代以降に書かれた C++。`THD *thd` を第 1 引数に取り、`bool` を返し、メモリは `MEM_ROOT` から取る
- `storage/innobase/` — 1996 年に Heikki Tuuri が C で書き始めたコードを、C++ の文法で保存したもの。独自の assert マクロ、独自のエラー型、独自の型エイリアス、独自のファイル命名

同じツリーの隣のディレクトリなのに、assert の書き方もエラーの返し方もログの出し方も違う。この差を知らずに読むと、**書式のノイズを毎回パースし直すことになって、肝心のロジックに集中できない**。

先に押さえておくと効くのは次の 4 つだ。

1. **ファイル名の `0` はモジュール区切り。** `btr0cur.cc` は「btr モジュールの cur サブモジュール」
2. **`ut_ad` はリリースビルドで消える。** だから `ut_ad` の列は実行される検査ではなく、**著者が書いた事前条件のドキュメント**として読む
3. **SQL 層は `bool` を返し、`true` がエラー。** `if (mysql_execute_command(thd)) { ... }` は「成功したら」ではない
4. **InnoDB の `DB_SUCCESS` は 0 ではなく 10。** `0` は `DB_ERROR_UNSET`。`if (err)` で成否を判定してはいけない

## なぜそうなっているか

**InnoDB の方言は、C で書かれたものを捨てずに C++ に持ち込んだ結果だ。** `ut_ad` は `assert` があれば要らないし、`ulint` は `size_t` があれば要らない。それでも残っているのは、1996 年から積み上がった数十万行を機械的に書き換えるコストが、方言を維持するコストを上回らなかったからだ。

ただし全部が惰性というわけではなく、**残ったものには残った理由があるものも混じっている**。

- `ut_ad` と `assert` を分けたことで、「InnoDB の debug ビルドだけで有効にする」という粒度が取れている。`NDEBUG` に相乗りしていたらこの制御はできない
- `dberr_t` の `DB_SUCCESS` を 0 にしなかったのは、**ゼロ初期化された構造体が「成功」に見えてしまう事故を防ぐ**ため。`DB_ERROR_UNSET = 0` という名前がその意図を明示している
- `page_no_t` と `space_id_t` を別の型にしたことで、引数の順序を取り違えるバグをコンパイラが弾ける

一方 SQL 層の `true` = エラーは、C の `int` 返り値 (0 が成功) を `bool` に置き換えたときの名残で、こちらは擁護しにくい。`Sql_cmd::execute` の doxygen が `@returns false if success, true if error` と**わざわざ書いている**のは、書かないと間違われるからだ。

## ソースコードのどこか

### ファイル名の `0` は「モジュール `0` サブモジュール」

InnoDB のファイルはすべて `<module>0<submodule>` という名前になっていて、`<module>` はそのままディレクトリ名でもある。だから実体は `storage/innobase/btr/btr0cur.cc` のように **`btr` が 2 回出る**。

```text
storage/innobase/btr/btr0cur.cc
                 ---  --- ---
                  |    |   +-- サブモジュール: cursor
                  |    +------ モジュール: btr
                  +----------- ディレクトリもモジュール名
```

主要なモジュールの対応はこうなる。ヘッダ (`storage/innobase/include/`) だけは 1 つのディレクトリに全部入っているので、`include/trx0trx.h` の実装は `trx/trx0trx.cc` にある、と読み替える。

| モジュール     | 中身                                      | この章のページ                                                                            |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `btr`          | B+tree とカーソル                         | [B+tree の操作](./btree-operations/)                                                      |
| `buf`          | バッファプール                            | [バッファプール](./buffer-pool-walkthrough/)                                              |
| `dict`         | InnoDB 内部のデータディクショナリ         | [データディクショナリ](./data-dictionary/)                                                |
| `fil` / `fsp`  | テーブルスペースのファイル層 / 空間管理   | [物理構造](./innodb-physical-walkthrough/)                                                |
| `lock`         | 行ロックとテーブルロック                  | [ロックの種類](./lock-modes-and-types/)                                                   |
| `log`          | redo ログ                                 | [redo ログ](./redo-log-walkthrough/)                                                      |
| `mtr`          | mini-transaction                          | [mini-transaction](./mini-transaction/)                                                   |
| `page` / `rem` | ページの構造 / レコード (record manager)  | [ページの構造](./page-layout/) / [レコードの構造](./record-format/)                       |
| `row`          | 行単位の操作 (`row_search_mvcc` など)     | [handler](./handler-walkthrough/)                                                         |
| `trx` / `read` | トランザクション / read view              | [トランザクション](./transaction-walkthrough/) / [read view](./read-view-and-visibility/) |
| `srv`          | 起動と背景スレッド                        | [InnoDB のスレッド一覧](./innodb-threads-walkthrough/)                                    |
| `ibuf`         | change buffer (insert buffer の名残)      | [change buffer](./change-buffer/)                                                         |
| `lob`          | TEXT / BLOB / JSON の外部格納             | [LOB](./lob-storage/)                                                                     |
| `ut`           | ユーティリティ (assert、ログ、アロケータ) | このページ                                                                                |

`ibuf` が change buffer を指すように、**モジュール名は機能が改名される前の名前で凍結されている**。`ha` はハッシュテーブル (adaptive hash index) であって `handler` ではない。`handler` は `storage/innobase/handler/ha_innodb.cc` のほうだ。

### `.cc` の先頭に `@file` のコメントがある

grep で関数に着地したら、まずファイルの先頭に戻る。InnoDB のファイルはライセンスヘッダの直後に、そのモジュールが何であるかと、**守るべき約束**が書いてある。

```cpp title="storage/innobase/btr/btr0cur.cc"
/** @file btr/btr0cur.cc
 The index tree cursor

 All changes that row operations make to a B-tree or the records
 there must go through this module! Undo log records are written here
 of every modify or insert of a clustered index record.

                         NOTE!!!
 To make sure we do not run out of disk space during a pessimistic
 insert or update, we have to reserve 2 x the height of the index tree
```

[`btr0cur.cc#L36`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/btr/btr0cur.cc#L36)。「B+tree への変更は全部このモジュールを通らなければならない」は grep の指針そのものだ。**このファイルの外に B+tree を書き換えるコードはない**と宣言されている。

### `.h` / `.ic` / `.cc` の 3 点セット

ヘッダで関数宣言を見つけたのに中身がない、という状況が InnoDB では頻繁に起きる。インライン関数の定義が `.ic` (inline code) という第 3 のファイルに追い出されているからだ。8.4.11 の `storage/innobase/` に 70 個ある。

```text
include/btr0cur.h   宣言 + doxygen コメント
include/btr0cur.ic  インライン関数の定義   <- .h の末尾から #include されている
btr/btr0cur.cc      通常の関数の定義
```

`btr_cur_get_page_cur` のような 1 行のアクセサを探して見つからないときは、`.h` ではなく `.ic` を見る。

### `ut_ad` はリリースビルドで消える

InnoDB の assert は 2 種類ある。

```cpp title="storage/innobase/include/ut0dbg.h"
#define ut_a(EXPR)                                        \
  do {                                                    \
    if (unlikely(false == (bool)(EXPR))) {                \
      ut_dbg_assertion_failed(#EXPR, __FILE__, __LINE__); \
    }                                                     \
  } while (0)

#define ut_error ut_dbg_assertion_failed(nullptr, __FILE__, __LINE__)

#ifdef UNIV_DEBUG
/** Debug assertion. Does nothing unless UNIV_DEBUG is defined. */
#define ut_ad(EXPR) ut_a(EXPR)
```

[`ut0dbg.h#L93`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/ut0dbg.h#L93)。`UNIV_DEBUG` が定義されていないビルドでは [L120](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/ut0dbg.h#L120) で `#define ut_ad(EXPR)` — **空になる**。

| マクロ       | リリースビルドで | 意味                                                               |
| ------------ | ---------------- | ------------------------------------------------------------------ |
| `ut_a(x)`    | **残る**         | 破ったらプロセスを落とす。データを壊すより落としたほうがましな条件 |
| `ut_ad(x)`   | **消える**       | 著者が「ここでは成り立っているはず」と宣言した事前条件             |
| `ut_d(stmt)` | **消える**       | デバッグ時だけ実行する文 (カウンタの更新、検証関数の呼び出し)      |
| `ut_error`   | 残る             | 到達しないはずの場所                                               |

**読むときに効くのはここだ。** 関数の先頭に `ut_ad` が 5 行並んでいたら、それは実行時の防御ではなく **API のドキュメント**だと思っていい。「この関数を呼ぶ前に latch を持っていること」「このページは葉であること」といった、コメントに書かれていない契約がそこに書かれている。逆に `ut_a` が使われている箇所は、著者が「本番でも検査する価値がある」と判断した場所なので、そこだけ注意して読む。

### エラーの返し方が層で違う

SQL 層は `bool` を返し、**`true` がエラー**だ。

```cpp title="sql/sql_cmd.h"
  /**
    Execute this SQL statement.
    @param thd the current thread.
    @returns false if success, true if error
  */
  virtual bool execute(THD *thd) = 0;
```

[`sql_cmd.h#L129`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_cmd.h#L129)。だから `sql/` の中の `if (foo(thd)) return true;` は「foo が成功したら」ではなく **「foo が失敗したので伝播する」**という意味になる。慣れるまでは毎回逆に読んでしまう。

InnoDB は `dberr_t` を返す。こちらは `0` が成功ではない。

```cpp title="storage/innobase/include/db0err.h"
enum dberr_t {
  DB_ERROR_UNSET = 0,
  /** like DB_SUCCESS, but a new explicit record lock was created */
  DB_SUCCESS_LOCKED_REC = 9,
  DB_SUCCESS = 10,

  /* The following are error codes */

  DB_ERROR,
  ...
  DB_LOCK_WAIT,
  DB_DEADLOCK,
```

[`db0err.h#L39`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/db0err.h#L39)。`DB_SUCCESS` が 10 で `0` が `DB_ERROR_UNSET` なので、`if (err)` は成否の判定にならない。必ず `err != DB_SUCCESS` と書かれている。

`DB_SUCCESS_LOCKED_REC` が別値なのも覚えておく価値がある。**「成功したが、ついでに明示ロックを作った」という成功の亜種**で、[ロックの種類](./lock-modes-and-types/)で出てくる暗黙ロックの昇格がここに現れる。

### 型エイリアスは意味を持つ

InnoDB は `int` や `uint64_t` を生で使わない。数字の正体が型名に出ている。

| 型           | 実体                                                                | 定義                                                                                                                    |
| ------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `byte`       | `unsigned char`                                                     | [`univ.i#L382`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/univ.i#L382)           |
| `ulint`      | `unsigned long int` (64bit 環境で 8 バイト)                         | [`univ.i#L406`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/univ.i#L406)           |
| `page_no_t`  | `uint32_t` — テーブルスペース内のページ番号                         | [`univ.i#L447`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/univ.i#L447)           |
| `space_id_t` | `uint32_t` — テーブルスペース ID                                    | [`univ.i#L449`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/univ.i#L449)           |
| `lsn_t`      | `uint64_t` — [redo ログ](./redo-log-walkthrough/)のバイトオフセット | [`log0types.h#L63`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/log0types.h#L63)   |
| `trx_id_t`   | `uint64_t` (`ib_id_t`) — トランザクション ID                        | [`trx0types.h#L138`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/trx0types.h#L138) |

`ulint` はポインタと同じ幅であることが [`univ.i#L412`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/univ.i#L412) で `#error` 付きで強制されている。**InnoDB のコードで `ulint` が出てきたら「サイズかオフセットか個数」だと思ってよく、値の意味を持つ ID には専用の型が付いている。**

### ログは `ib::info() << ...`

InnoDB のログはストリームで書く。オブジェクトのデストラクタが走ったときに 1 行が出るという作りなので、**名前を付けずに一時オブジェクトとして使う**のが正しい使い方だ。

```cpp title="storage/innobase/include/ut0log.h"
/** The class info is used to emit informational log messages.  It is to be
used similar to std::cout.  But the log messages will be emitted only when
the dtor is called.  The preferred usage of this class is to make use of
unnamed temporaries as follows:

info() << "The server started successfully.";
*/
class info : public logger {
```

[`ut0log.h#L189`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/ut0log.h#L189)。`namespace ib` ([L40](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/ut0log.h#L40)) の中にあるので、呼び出し側は `ib::info()` / `ib::warn()` / `ib::error()` / `ib::fatal()` になる。エラーログで見た文言から実装を探すときは、この形で grep する。

### SQL 層に `free` が見当たらない理由

`sql/` を読んでいると、`new` はあるのに対応する `delete` がない箇所が大量にある。

```cpp
new (thd->mem_root) Item_int(...)
```

これは **placement new で `THD` の `MEM_ROOT` からメモリを取る**形で、個別に解放しない。クエリが終わったときにアリーナごと一括で捨てる。`sql/sql_resolver.cc` だけで 53 箇所ある。

だから、パーサやオプティマイザが作る `Item` や `AccessPath` の寿命は「そのクエリの間」で固定されていて、**所有権を追いかける必要がない**。逆に、クエリをまたいで持ち回るものは (prepared statement のように) 別の `MEM_ROOT` に置かれる。[prepared statement のページ](./binary-protocol-prepared-statements/)で再準備の話が出てくるのは、この寿命の違いが理由だ。

## どう活かすか

- **grep して着地したら、まずファイル先頭の `@file` に戻る。** そのモジュールの担当範囲と「ここを通らなければならない」宣言が書いてある。これを読むだけで、そのファイルを読むべきかの判断がつく
- **`ut_ad` の列は飛ばさずに読む。** コメントに書かれていない呼び出し契約 (latch を持っているか、どのページか、どの状態か) がそこにしかないことが多い。この章の各ページで「守られている不変条件」として挙げているものの出典は、たいていこの `ut_ad` だ
- **`if (foo(thd))` を見たら「失敗したら」と読む。** `sql/` の中では例外なくこの規約
- **`err` の判定は必ず `!= DB_SUCCESS` を確認する。** `DB_SUCCESS_LOCKED_REC` を成功扱いし忘れている自分のパッチを書かないため
- **ヘッダで中身が見つからなければ `.ic` を見る。** `storage/innobase/include/<module>0<sub>.ic`
- **本番ビルドでは `ut_ad` が効いていないことを忘れない。** 「assert があるから壊れない」は debug ビルドの話で、`ut_ad` で守られている前提が破れた場合の本番の挙動は未定義だ。[ビルドとデバッガで追う](./build-and-debug/)で `WITH_DEBUG` を有効にする手順を扱う
