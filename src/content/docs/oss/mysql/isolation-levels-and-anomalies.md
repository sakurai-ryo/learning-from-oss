---
title: "分離レベルとアノマリ — SQL 標準と InnoDB の RR"
description: "SQL 標準は分離レベルを「どのアノマリが起きてよいか」で定義していて、実装のことは何も言っていない。だから同じ REPEATABLE READ でも中身は製品ごとに違う。InnoDB の RR は標準より強く、スナップショットと next-key lock という別々の 2 つの機構でファントムを塞いでいる。それでも SERIALIZABLE ではないこと、そして MySQL だけが既定を RR にしていることを、この章の残りを読む枠組みとして先に置く。"
group: "前提 — 用語と DB の基礎"
sidebar:
  order: 5
---

> **前提**: [MVCC](./mvcc-basics/)

## 何を学んだか

SQL 標準の分離レベルは、**「何が起きるか」ではなく「何が起きてよいか」**で定義されている。禁止しているアノマリは 3 つだけだ。

| アノマリ            | 何が起きるか                                                |
| ------------------- | ----------------------------------------------------------- |
| dirty read          | 他人の**未コミット**の変更が見える                          |
| non-repeatable read | 同じ行を 2 回読むと、間に他人がコミットした更新で値が変わる |
| phantom read        | 同じ**範囲**を 2 回読むと、間に他人が挿入した行が増えている |

4 つのレベルは、この 3 つを許すか禁じるかの組み合わせでしかない。

| レベル           | dirty read | non-repeatable read | phantom      |
| ---------------- | ---------- | ------------------- | ------------ |
| READ UNCOMMITTED | 起きうる   | 起きうる            | 起きうる     |
| READ COMMITTED   | 起きない   | 起きうる            | 起きうる     |
| REPEATABLE READ  | 起きない   | 起きない            | **起きうる** |
| SERIALIZABLE     | 起きない   | 起きない            | 起きない     |

**標準の REPEATABLE READ はファントムを許している。** これが重要で、この定義だけを読んで「RR なら範囲も安定する」と考えると実装との食い違いに落ちる。

### InnoDB の RR は標準より強い

InnoDB の REPEATABLE READ は、**2 つの独立した機構でファントムを塞いでいる**。

1. **ロックなしの `SELECT`** — トランザクション中の最初の読みでスナップショットが固定され、以降は同じスナップショットで読む。他人が何を挿入しようとその版は自分の read view に見えないので、**そもそもファントムが起きようがない** ([read view と可視性](./read-view-and-visibility/))
2. **ロック読み (`SELECT ... FOR UPDATE` / `FOR SHARE`) と `UPDATE` / `DELETE`** — スナップショットではなく最新版を読む。ここは next-key lock、つまり「レコード + その手前のギャップ」を押さえることで、**範囲への挿入自体を止める** ([ロックの種類](./lock-kinds/))

**両者はまったく別の仕掛けで、しかも見ているデータが違う。** 1 は過去のスナップショット、2 は現在の最新版だ。同じトランザクションの中でこの 2 つが混ざると、こういうことが起きる。

```sql
-- トランザクション A (RR)
BEGIN;
SELECT COUNT(*) FROM t WHERE x = 1;   -- 0 件。ここでスナップショットが固定される

--                          トランザクション B: INSERT INTO t (x) VALUES (1); COMMIT;

SELECT COUNT(*) FROM t WHERE x = 1;   -- まだ 0 件 (スナップショットは動かない)
UPDATE t SET y = 9 WHERE x = 1;       -- 1 行が更新される (最新版を見るので B の行が見える)
SELECT COUNT(*) FROM t WHERE x = 1;   -- 1 件になる (自分が更新した行は見える)
```

書き込み系は常に最新版を見る (current read)。**「RR ならトランザクション中ずっと同じものが見える」は、ロックなしの `SELECT` に限った話**だ。

### それでも SERIALIZABLE ではない

スナップショットで読んで、条件を確かめて、書く。この形は **write skew** を防げない。

```sql
-- 「その席の予約が 0 件なら予約を入れる」を 2 セッションが同時に実行
BEGIN;
SELECT COUNT(*) FROM booking WHERE seat = 'A1';  -- どちらも 0
INSERT INTO booking (seat) VALUES ('A1');         -- どちらも成功
COMMIT;
```

2 つのトランザクションが**互いに相手が読んだ範囲に書いている**。どちらもスナップショット上は矛盾していないので通ってしまう。直列に実行したらこの結果にはならないので、直列化可能ではない。

これは InnoDB の不足ではなく、**スナップショット分離という方式そのものの限界**だ。防ぎたければ、読む時点でロックを取る (`SELECT ... FOR UPDATE` にする) か、UNIQUE 制約でデータベースに強制させるか、`SERIALIZABLE` にする (InnoDB では素の `SELECT` が `LOCK_S` に化ける) しかない。

### そして MySQL だけが既定を RR にしている

| 製品            | 既定の分離レベル    |
| --------------- | ------------------- |
| MySQL / InnoDB  | **REPEATABLE READ** |
| PostgreSQL      | READ COMMITTED      |
| Oracle Database | READ COMMITTED      |
| SQL Server      | READ COMMITTED      |

**他の製品から移ってくると、何も設定していないのにレベルが 1 段上がっている。** ロックの範囲が広くなり、デッドロックの形が変わり、スナップショットの寿命が変わる。この章の InnoDB の説明はすべて RR を基準に書いてあり、RC で何が変わるかは該当ページごとに注記してある。

## なぜそうなっているか

### なぜ標準はアノマリで定義したのか

標準が書かれた当時、想定されていた実装は 2 相ロック (2PL) だった。4 つのレベルは、実は**「ロックをどこまで緩めるか」の 4 段階**にきれいに対応する。

| レベル           | 2PL でいうと                                  |
| ---------------- | --------------------------------------------- |
| READ UNCOMMITTED | 読みロックを取らない                          |
| READ COMMITTED   | 読みロックを取るが、読み終わったら即外す      |
| REPEATABLE READ  | 読みロックもコミットまで持つ                  |
| SERIALIZABLE     | 加えて「範囲」にもロックを掛ける (述語ロック) |

この対応を見ると、**RR でファントムだけが残る理由**が分かる。既に存在する行にはロックを掛けられるが、まだ存在しない行には掛けられない。範囲そのものをロックする仕組み (述語ロック) を足して初めてファントムが消える。

そして MVCC はこの枠に収まらない。**読み手がロックを取らないので、「読みロックをいつ外すか」という軸が存在しない。** 標準の定義は MVCC の実装を記述する言葉を持っていないので、各製品が自分の解釈でレベル名を割り当てることになった。同じ `REPEATABLE READ` でも中身が違うのはそのためだ。

### なぜ InnoDB はギャップという近似を選んだのか

述語ロック (「`x = 1` を満たす行すべて」をロックする) を厳密に実装すると、任意の述語同士の重なり判定が要る。InnoDB は代わりに、**インデックスの順序上の「隙間」をロックする**という近似を採った。B+tree のレコードとレコードの間に対して、挿入だけを禁じるロックを置く。

これなら判定は「そのキーがこの区間に入るか」の比較で済む。代わりに「インデックスがない条件では範囲を表現できない」という制限が付く。**インデックスのない列で `UPDATE` すると全行がロックされる**のはこの制限の帰結だ。

### なぜ MySQL の既定が RR なのか

歴史的には binlog の都合が大きい。STATEMENT ベースのバイナリログは「同じ SQL 文をレプリカで実行しても同じ結果になる」ことを前提にしていて、それを成立させるには範囲への割り込みを止める必要がある。RC ではギャップロックを取らないので保証できない。

実際 InnoDB は、RC 以下では**エンジンの能力フラグから `HA_BINLOG_STMT_CAPABLE` を落とす**。`binlog_format=STATEMENT` で書き込もうとすると `ER_BINLOG_STMT_MODE_AND_ROW_ENGINE` で拒否される ([RR と RC の違い](./locking-in-rr-vs-rc/))。ROW ベースが既定になった今では制約は緩んでいるが、既定値は動いていない。

## ソースコードのどこか

### enum のコメントに「標準より強い」と書いてある

```cpp title="storage/innobase/include/trx0trx.h"
struct trx_t {
  enum isolation_level_t {

    /** dirty read: non-locking SELECTs are performed so that we
    do not look at a possible earlier version of a record; thus
    they are not 'consistent' reads under this isolation level;
    otherwise like level 2 */
    READ_UNCOMMITTED,

    /** somewhat Oracle-like isolation, except that in range UPDATE
    and DELETE we must block phantom rows with next-key locks;
    SELECT ... FOR UPDATE and ...  LOCK IN SHARE MODE only lock
    the index records, NOT the gaps before them, and thus allow
    free inserting; each consistent read reads its own snapshot */
    READ_COMMITTED,

    /** this is the default; all consistent reads in the same trx
    read the same snapshot; full next-key locking used in locking
    reads to block insertions into gaps */
    REPEATABLE_READ,

    /** all plain SELECTs are converted to LOCK IN SHARE MODE
    reads */
    SERIALIZABLE
  };
```

[`trx0trx.h#L676`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/include/trx0trx.h#L676)。上の説明はほぼこのコメントの言い換えだ。読み取れることが 3 つある。

- **RR の説明が 2 文に分かれている。** 「同じトランザクション内の一貫読み取りは同じスナップショットを読む」と「ロック読みでは full next-key locking を使ってギャップへの挿入を止める」。**別々の機構だと明言している**
- **RC の説明にも next-key lock が出てくる。** 「範囲 `UPDATE` / `DELETE` ではファントム行を next-key lock で止めなければならない」。RC でギャップロックが完全に消えるわけではない ([RR と RC の違い](./locking-in-rr-vs-rc/))
- **SERIALIZABLE の実装は「素の `SELECT` を `LOCK IN SHARE MODE` にする」だけ**。専用の直列化検証は入っていない

サーバ側の enum は別にある。

```cpp title="sql/handler.h"
enum enum_tx_isolation : int {
  ISO_READ_UNCOMMITTED,
  ISO_READ_COMMITTED,
  ISO_REPEATABLE_READ,
  ISO_SERIALIZABLE
};
```

[`sql/handler.h#L3186`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/handler.h#L3186)。SQL 層と InnoDB で別の enum を持ち、`ha_innobase::store_lock` が文の頭で変換する。値の並びが同じなので `<=` の比較がそのまま使えるようになっている。

### 既定値はここで決まっている

```cpp title="sql/sys_vars.cc"
static Sys_var_transaction_isolation Sys_transaction_isolation(
    "transaction_isolation", "Default transaction isolation level",
    UNTRACKED_DEFAULT SESSION_VAR(transaction_isolation), NO_CMD_LINE,
    tx_isolation_names, DEFAULT(ISO_REPEATABLE_READ), NO_MUTEX_GUARD,
    NOT_IN_BINLOG, ON_CHECK(check_transaction_isolation));
```

[`sql/sys_vars.cc#L5001`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L5001)。`DEFAULT(ISO_REPEATABLE_READ)` の 1 行だ。**変数名は 8.4 では `transaction_isolation`** で、古い `tx_isolation` は削除されている。8.0 以前の手順書がそのまま動かない点の 1 つになる。

`SESSION_VAR` なのでセッション単位で変えられる。問題のあるバッチ処理だけ RC で回す、という運用が取れるのはこのためだ。

## どう活かすか

### 他 DB から移ってきたら、まず既定レベルの差を確認する

PostgreSQL や Oracle で書かれたアプリケーションをそのまま MySQL に載せると、**設定を何も変えていないのに分離レベルが上がっている**。起きやすい変化は 2 つ。

- **ロックの範囲が広がる。** RC ではレコードだけだったところに next-key lock が付く。デッドロックの出方が変わる
- **スナップショットが長生きする。** RC では文ごとに取り直していたものが、トランザクション全体で固定される。長い処理では purge が止まる ([purge](./purge/))

逆に「移行したらデッドロックが増えた」の一次仮説はここに置ける。

### RR のまま「一意ヒットならギャップは付かない」を使う

`WHERE pk = ?` のように PK / UNIQUE で 1 行を確実に指す `FOR UPDATE` は、RR でもレコードだけをロックする。**範囲条件やインデックスのない条件で `FOR UPDATE` を打つ**とギャップが広範に付く。分離レベルを下げる前に、条件をユニークキーに絞れないかを見るほうが影響が小さい ([RR と RC の違い](./locking-in-rr-vs-rc/))。

### 「見た結果に基づいて書く」処理は分離レベルでは守れない

在庫チェックしてから引く、重複チェックしてから挿す、といった read-modify-write は、RR でも write skew で壊れる。守り方は 3 つしかない。

- 読む時点で `SELECT ... FOR UPDATE` にして、読んだ範囲をロックする
- UNIQUE 制約を張って、データベースに重複を弾かせる (制約検査は分離レベルより強い保証なので、RC でも next-key lock を取る)
- `UPDATE ... SET stock = stock - 1 WHERE stock >= 1` のように、判定と更新を 1 文にする

**分離レベルを上げれば安全になる、という発想では届かない**のがこの種のバグだ。

### この続き

- スナップショットの実体と、RR / RC でいつ作り直されるかは[read view と可視性](./read-view-and-visibility/)
- ギャップロックがどう表現されているかは[ロックの種類 — 共有・排他・意図・範囲、そしてメタデータ](./lock-kinds/)、実装は[ロックの種類 — record / gap / next-key / insert intention、暗黙ロック](./lock-modes-and-types/)
- RC で具体的に何が変わるか (7 点) は[RR と RC の違い — ギャップロックが消える場所](./locking-in-rr-vs-rc/)
- UNIQUE 制約が分離レベルより強い理由は[INSERT のロック — insert intention、重複検査、AUTO_INCREMENT](./insert-and-duplicate-check/)
