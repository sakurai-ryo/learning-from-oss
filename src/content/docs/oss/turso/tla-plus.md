---
title: "トランザクションの規約を TLA+ で書いて、モデル検査にかける"
description: "Turso には 200 行ほどの TLA+ 仕様が入っている。対象は WAL モードの並行制御だけで、接続の状態・mxFrame・スナップショット・書き込みロックの 4 変数しかない。実装との自動的な対応は取っていない。それでも価値があるのは、この仕様が「実装より先に読める規約」として機能し、書かれた 5 つの不変条件がそのままコード中の assert の元になっているからだ。"
group: "トランザクションと並行性"
sidebar:
  order: 37
---

## 何を学んだか

`tlaplus/sqlite-tx/` には、SQLite の WAL モードの並行制御を記述した TLA+ 仕様が 1 本入っている。

```text title="tlaplus/sqlite-tx/README.md"
# SQLite WAL Mode Transaction Specification

TLA+ specification for SQLite WAL mode transaction concurrency control.
The specification itself (`SqliteTx.tla`) is the primary documentation —
generate the PDF for a typeset version.
```

[`tlaplus/sqlite-tx/README.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/tlaplus/sqlite-tx/README.md)。

**「仕様そのものが第一のドキュメント」** と書いてある。実際、`.tla` ファイルの半分は散文のコメントで、TLA+ を知らなくても読める。

規模は控えめだ。**変数は 4 つ、アクションは 7 つ、不変条件は 5 つ。** 実装とのコードレベルの対応も取っていない。

それでも入れる価値がどこにあるのかが、このページの主題になる。

## ソースコードのどこか

### 状態は 4 つの変数だけ

```tla title="tlaplus/sqlite-tx/SqliteTx.tla"
VARIABLES
    txState,        \* `txState'[c] \in {"Idle", "Reading", "Writing"}
    mxFrame,        \* Maximum valid WAL frame number (the committed version)
    txSnapshot,     \* `txSnapshot'[c] -- the `mxFrame' visible to connection c
    writeLock       \* `NoWriter' or the connection holding the exclusive write lock
```

[`tlaplus/sqlite-tx/SqliteTx.tla`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/tlaplus/sqlite-tx/SqliteTx.tla)。

[WAL のページ](../wal/) で見た実装には、5 つの読み取りロックスロット、累積チェックサム、フレーム索引、4 つのチェックポイントモードがあった。**この仕様には、そのどれも出てこない。**

残したのは「接続がどの状態か」「コミット済みのバージョンはいくつか」「各接続が見ているバージョンはいくつか」「誰が書いているか」だけだ。

**読み取りロックのスロットが 5 つであることは、並行制御の正しさに関係ない。** スロットの共有は「4 種類までのスナップショットしか同時に存在できない」という制限を課すが、それは性能の話であって、一貫性の話ではない。

**モデル検査は、抽象化の質でほぼ決まる。** 実装をそのまま写すと状態爆発するし、削りすぎると検査したい性質が消える。ここでは「スナップショットの一貫性」と「書き手は 1 人」だけを残している。

### 不変条件が 5 つ

```tla title="tlaplus/sqlite-tx/SqliteTx.tla"
(* `^\textbf{Single Writer Invariant.}^' At most one connection can be in Writing
   state at any time. This is the fundamental concurrency constraint of
   WAL mode, enforced by the exclusive write lock. *)
SingleWriter ==
    Cardinality({c \in Connections : txState[c] = "Writing"}) <= 1
```

```tla title="tlaplus/sqlite-tx/SqliteTx.tla"
(* `^\textbf{Write Lock Consistency Invariant.}^' A connection is in Writing state
   if and only if it holds the write lock. This ensures the write lock
   accurately reflects the system state---no "phantom" writers and no
   writers without the lock. *)
WriteLockConsistency ==
    \A c \in Connections : txState[c] = "Writing" <=> writeLock = c
```

```tla title="tlaplus/sqlite-tx/SqliteTx.tla"
(* `^\textbf{No Future Reads Invariant.}^' No connection---whether in a transaction
   or idle---has a snapshot that points beyond the current committed
   `mxFrame'. This is a stronger form of `SnapshotValidity' that also
   constrains idle connections. *)
NoFutureReads ==
    \A c \in Connections : txSnapshot[c] <= mxFrame
```

**「書き手は高々 1 人」「Writing 状態とロック保持は同値」「スナップショットは未来を指さない」。**

3 つ目が特に効いている。`SnapshotValidity` (アクティブなトランザクションについて成り立つ) と `NoFutureReads` (アイドルの接続についても成り立つ) を **両方書いている**。

なぜ 2 つ要るのか。**コミット直後の接続は `Reading` 状態に戻り、スナップショットが更新されている。** 一方、`CommitRead` でアイドルに戻った接続は古いスナップショットを持ったままだ。「アイドルの接続のスナップショットも `mxFrame` を超えない」は、自明ではない。

**強い条件と弱い条件を両方書くと、どちらが破れたかで原因が絞れる。**

### コミット後にアイドルに戻らない、という細部

```tla title="tlaplus/sqlite-tx/SqliteTx.tla"
   On commit or rollback, a write transaction returns to Reading state, not
   Idle, because SQLite keeps the read lock held until explicitly released
   (`^{\tt pager\_end\_transaction}^' sets the pager state to
   `^{\tt PAGER\_READER}^'). The connection must then commit or rollback the
   read transaction to return to Idle.
```

**モデルの中の遷移が、SQLite の実装の具体的な関数名と対応づけられている。**

これは抽象化ではなく、実装の癖の記録だ。「書き込みが終わったらアイドル」と書いた方がモデルは単純になるが、**実装がそうなっていない**。ここで単純化すると、モデルと実装がずれる。

**どこを抽象化してよくて、どこを抽象化してはいけないか** の判断が、この 1 箇所に表れている。読み取りロックが解放されないことは、他の接続から見た挙動を変える。だから残す。

### 失敗を「遷移が起きない」で表す

```tla title="tlaplus/sqlite-tx/SqliteTx.tla"
(* `^\textbf{UpgradeToWrite}^' --- promote a read transaction to a write
   transaction. ... Critically, the snapshot must still match the current
   `mxFrame'---if another writer has committed since this reader's snapshot
   was taken, the upgrade fails with `^{\tt SQLITE\_BUSY\_SNAPSHOT}^'
   (modeled by the precondition not being satisfied, so TLC simply does not
   explore that transition). See `^{\tt sqlite3WalBeginWriteTransaction}^'
   in `^{\tt wal.c}^'. *)
UpgradeToWrite(c) ==
    /\ txState[c] = "Reading"
    /\ writeLock = NoWriter
    /\ txSnapshot[c] = mxFrame
    /\ txState' = [txState EXCEPT ![c] = "Writing"]
```

**`SQLITE_BUSY_SNAPSHOT` というエラーを、モデルでは「前提条件が満たされないので、その遷移が探索されない」として表している。**

TLA+ では、エラーを返す遷移をわざわざ書く必要がない。**「起きない」と「エラーになる」を区別しないのが、この道具の設計上の得だ。**

読み取りトランザクションから書き込みへ昇格するとき、スナップショットが古ければ失敗する。これは実際の SQLite/Turso で `SQLITE_BUSY_SNAPSHOT` になる条件で、**アプリケーションから見えるエラーの根拠がモデルの 1 行に対応している**。

`RollbackRead` が `CommitRead` と同一なのも、正直に書いてある。

```tla title="tlaplus/sqlite-tx/SqliteTx.tla"
(* `^\textbf{RollbackRead}^' --- abort a read transaction. Identical to
   `CommitRead' in terms of state change---the connection returns to
   Idle. *)
```

**読み取りトランザクションのコミットとロールバックは、状態遷移としては区別できない。** 実装では別の関数だが、この抽象度では同じものになる。それを隠さずに書いている。

### 検査の規模

```text title="tlaplus/sqlite-tx/SqliteTx.cfg"
CONSTANTS
    Connections = {c1, c2, c3, c4, c5}
    MaxVersion = 7
    NoWriter = NOWRITER

INVARIANT TypeOK
INVARIANT SingleWriter
INVARIANT WriteLockConsistency
INVARIANT SnapshotValidity
INVARIANT NoFutureReads
```

[`tlaplus/sqlite-tx/SqliteTx.cfg`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/tlaplus/sqlite-tx/SqliteTx.cfg)。

**接続 5 個、バージョン番号は 7 まで。**

有限にしないと検査が終わらないので、上限を置く。並行制御のバグは **少数の参加者で必ず再現する** という経験則があり、5 と 7 はその想定に基づく。

実行はこれだけになる。

```makefile title="tlaplus/sqlite-tx/Makefile"
check: $(TLA2TOOLS)
	java $(JAVA_OPTS) -cp $(TLA2TOOLS) tlc2.TLC $(TLC_OPTS) -config $(CFG) $(SPEC)

$(TLA2TOOLS):
	curl -LO https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
```

[`tlaplus/sqlite-tx/Makefile`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/tlaplus/sqlite-tx/Makefile)。

**`make check` で、ツールのダウンロードから検査まで走る。** 事前準備の手順書がない。

`make SqliteTx.pdf` で組版された PDF も出る。**仕様を「読ませる」ことを本気で狙っている。**

## この仕様が実装を守っていないこと

正直に書いておくと、この仕様と実装の間には自動的な結びつきがない。

- モデル検査の結果が CI を落とすようになっていない (`Makefile` を手で叩く)
- 実装から仕様への refinement mapping もない
- 検査しているのは WAL モードだけで、[MVCC](../mvcc/) も [マルチプロセス](../shared-wal-tshm/) も対象外

つまり **「仕様が通っているから実装が正しい」とは一切言えない。**

それでも 3 つの効用がある。

1. **規約が読める形で 1 箇所にある。** WAL モードの並行制御は `wal.rs` の 10,793 行に散らばっている。200 行で全体像が読めるものが別にあるのは、それ自体が価値になる
2. **不変条件が言語化されている。** `SingleWriter` や `NoFutureReads` は、そのままコード中の `turso_assert!` の元になる。実装の assert が「何を守っているのか」を、仕様の側の名前で説明できる
3. **抽象度が固定される。** 「何が並行制御の本質で、何が実装の都合か」の線引きが、この 4 変数として残っている

3 つ目が地味に効く。**「読み取りロックのスロットが 5 つ」は本質ではないと、この仕様が言っている。** だから将来スロット数を変えても、並行制御の議論をやり直す必要がない。

## なぜそうなっているか

- **変数を 4 つに絞ったのは、モデル検査が抽象化の質で決まるから。** 実装を写すと状態爆発する。検査したい性質 (スナップショットの一貫性、単一書き手) に必要な変数だけを残す。
- **読み取りロックのスロットを省いたのは、それが性能の仕組みだから。** スロットの共有は「同時に存在できるスナップショットの種類」を制限するが、一貫性には影響しない。
- **コミット後に `Reading` に戻る細部を残したのは、他の接続から見た挙動が変わるから。** 読み取りロックが保持され続けることは、チェックポイントが待つ相手を変える。抽象化してはいけない側だ。
- **強弱 2 つの不変条件を書いたのは、破れたときに原因を絞るため。** 弱い方だけが通るなら、問題はアイドル接続にある。
- **エラーを遷移の不在で表したのは、TLA+ がそう書けるから。** 「起きない」と「エラーになる」を区別しないので、エラー経路のモデル化が要らない。
- **接続 5 個・バージョン 7 までにしたのは、有限にしないと終わらないから。** 並行制御のバグは少数の参加者で再現するという経験則がある。
- **`make check` でツールの取得までやるのは、手順書が読まれないから。** 「まず tla2tools.jar をダウンロードして」と書いた README は、実行されない。
- **PDF を出せるようにしたのは、仕様を読ませたいから。** 「第一のドキュメント」と宣言している以上、読める形で出せる必要がある。
- **MVCC を対象にしていないのは、まだ動いているから。** 仕様は実装が固まった部分に対して書く方が、書き直しのコストが小さい。

## どう活かすか

- **並行制御を実装する前に、状態変数を数え上げる。** 「何が並行性の本質か」を 4〜5 個の変数に絞れないなら、まだ設計が固まっていない。形式手法を使わなくても、この作業だけで価値がある。
- **抽象化の線引きを、残す形で記録する。** 「スロット数は本質ではない」は、この仕様に書かれていなければ誰も知らない。後から仕組みを変えるときの許可証になる。
- **ただし、他者から見える挙動が変わる細部は抽象化しない。** 「コミット後もロックを持ち続ける」は、単純化した瞬間にモデルが嘘になる。
- **不変条件には名前を付ける。** `SingleWriter`、`NoFutureReads`。名前があると、コード中の assert が「何を守っているか」を説明できる。
- **強い条件と弱い条件を両方持つ。** どちらが破れたかで、原因の範囲が絞れる。
- **エラーになる条件を、遷移の前提条件として書く。** 「この条件が満たされないと進めない」と書けば、エラー経路を別に書かなくてよい。
- **検証ツールは、`make check` 一発で走る形にする。** ツールの取得も含める。手順書は読まれない。
- **仕様が実装を保証していないことを、はっきりさせる。** 対応づけがないなら「これは規約の記述であって、実装の証明ではない」と理解して使う。それでも「読める規約が 1 箇所にある」だけで元は取れる。
- **仕様を書く対象は、動きが止まった部分から選ぶ。** 設計が流動的な部分に書くと、書き直しの方が高くつく。
