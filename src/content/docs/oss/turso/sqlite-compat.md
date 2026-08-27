---
title: "「SQLite 互換」が固定するものと、しないもの"
description: "Turso の互換性は 4 つの文で定義されている。ファイル形式は完全互換、非互換機能は opt-in、いつでも SQLite に戻れる。そして互換の粒度が 3 層になっていて、一番下の「EXPLAIN の命令列まで合わせる」は互換性そのものが目的ではなく、バグを「コード生成側か実行側か」に二分するための道具になっている。制約を先に固定したことが、この後のすべての設計を決めている。"
group: "前提"
sidebar:
  order: 2
---

## 何を学んだか

書き直しプロジェクトで最初に決めるべきは、**「何を変えないと約束するか」** だ。ここが曖昧だと、機能を足すたびに「これは互換性を壊すのか」を毎回議論することになる。

Turso はそれを 4 行で書いている。

```text title="COMPAT.md"
1. You should always be able to go back to SQLite if you want to.
2. You should be able to access a database created with SQLite in Turso.
3. You need to opt in to any incompatible Turso feature, but even then we provide a migration path back to SQLite when possible.
4. We don't support mixed SQLite and Turso in multi-process scenarios.
```

[`COMPAT.md#L66-L71`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/COMPAT.md#L66-L71)。

この 4 行から、次のことが決まる。

- **ファイル形式は動かせない** (1, 2)。ページの構造も、レコードのエンコードも、B-tree の形も、SQLite と同じバイト列でなければならない
- **メモリの中は自由** (1〜4 のどれにも縛られない)。ページキャッシュの構造、I/O の方式、並行制御、実行時のデータ表現は好きにしていい
- **新機能は opt-in** (3)。MVCC もマテビューも暗号化も、明示的に有効化しない限り既定のファイルには何も足さない
- **同時に両方から開くのは、諦める** (4)

3 番目の「戻れる道を用意する」まで書いているのが特徴的だ。**非互換機能を足すことを禁じるのではなく、足したうえで出口を用意する**という立て付けになっている。

そして 4 番目。「対応しません」と書き切っている項目がある。**互換性の定義には、諦める項目が必要になる**。

## ソースコードのどこか

### 互換性の粒度は 3 層ある

Turso が「SQLite と同じ」と言うとき、実は 3 つの違う強さの主張が混ざっている。

| 層               | 何を合わせるか                     | 破ったらどうなるか              |
| ---------------- | ---------------------------------- | ------------------------------- |
| **ファイル形式** | `.db` のバイト列                   | SQLite で開けなくなる。約束違反 |
| **SQL の意味論** | クエリの結果、型の扱い、エラー条件 | 挙動が変わる。バグ扱い          |
| **バイトコード** | `EXPLAIN` が吐く命令列             | 何も起きない。**開発の道具**    |

一番上は約束だが、一番下は約束ではない。それでも実際には一番厳しく守られている。理由は互換性ではなく、**デバッグの効率**にある。

```text title="docs/agent-guides/debugging.md"
1. EXPLAIN query in sqlite3
2. EXPLAIN query in tursodb
3. Compare bytecode
   ├─ Different → bug in code generation
   └─ Same but results differ → bug in VM or storage layer
```

[`docs/agent-guides/debugging.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/agent-guides/debugging.md)。

**バイトコード列が一致していれば、バグは必ず VM かストレージにある。** 一致していなければ、必ずコード生成にある。

これは、デバッグの探索空間を毎回半分に割れることを意味する。SQL の結果が違うとき、普通なら「パーサか、プランナか、実行器か、ストレージか」の 4 択を順に潰していく。バイトコードという中間点で答え合わせができるので、それが 2 回の二分探索になる。

**この二分法を成立させるためだけに、命令列を一致させる価値がある。** 実際、コード生成側にはこういうコメントが残っている。

```rust title="core/translate/transaction.rs"
        TransactionType::Immediate | TransactionType::Exclusive => {
            // SQLite emits Transaction for every open database (main, temp, each attached)
            // on BEGIN IMMEDIATE / EXCLUSIVE. We match that exactly. For temp, this may
            // trigger lazy initialization via `ensure_temp_database` in op_transaction:
            // an acceptable one-time cost that keeps the opcode sequence identical to SQLite.
```

[`core/translate/transaction.rs#L30-L35`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/transaction.rs#L30-L35)。

**「命令列を SQLite と同じに保つために、一度きりの余計なコストを払う」** と明記されている。必要のない `TEMP` データベースの初期化まで走らせている。性能より、命令列の一致を取っている。

### 差分を取るのが 1 コマンドになっている

その二分法を毎日使えるように、スクリプトが 1 本置いてある。

```bash title="scripts/diff.sh"
S=$(sqlite3 :memory: <<< ".mode list
$SQL" 2>&1)
T=$(cargo run -q --bin tursodb -- :memory: "$SQL" --output-mode list 2>&1)

if [ "$S" = "$T" ]; then
    echo "PASS: $LABEL"
else
    echo "FAIL: $LABEL"
```

[`scripts/diff.sh`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/scripts/diff.sh)。

40 行のシェルスクリプトだ。中身は「両方に同じ SQL を流して `diff` する」以上のことをしていない。

注目したいのは、**使えない条件が先頭のコメントに全部書いてある**ことだ。

```bash title="scripts/diff.sh"
# Quirks:
#   - Always exits 0, even on FAIL. Check stdout for PASS/FAIL.
#   - Error messages differ in format between sqlite3 and tursodb, so error
#     cases will almost always show FAIL. Use this for comparing *results*, not errors.
```

**「エラーメッセージの比較には使うな」。** 比較器を作ると、必ず「比較してはいけないもの」が出てくる。それを書いておかないと、偽陽性を追いかけて時間を溶かす。

### テストの形式が「両方に流す」前提になっている

同じ考え方が、テストの記法そのものに埋まっている。

```text title="sqlite/conformance/sqlite-sqltests/affinity.sqltest"
@database :memory:

@cross-check-integrity
test affinity {
    CREATE TABLE t1 (c INTEGER);
    INSERT INTO t1 VALUES ('1');
    INSERT INTO t1 VALUES ('1a');
    SELECT c, typeof(c) FROM t1;
}
expect {
    1|integer
    1a|text
}
```

[`sqlite/conformance/sqlite-sqltests/affinity.sqltest`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sqlite/conformance/sqlite-sqltests/affinity.sqltest)。

この `.sqltest` は **Turso と SQLite の両方で実行される**。開発ガイドはこう指示している。

```text title="AGENTS.md"
- `sqlite/conformance/sqlite-sqltests/` - preferred for SQL conformance coverage. These tests run the same scenario against both Turso and SQLite, so use them first for parser, planner, executor, and SQL semantics work that fits the `.sqltest` DSL.
```

**期待値を人間が書いているが、その期待値自体が SQLite によって検証される。** 期待値を間違えて書いた瞬間に落ちる。

`.sqltest` は 387 ファイルあり、それとは別に SQLite 本家の TCL テストが 849 ファイル取り込まれている。後者については、こう釘が刺してある。

```text title="AGENTS.md"
- `sqlite/conformance/upstream/` - imported upstream SQLite golden tests. Do not modify these for Turso behavior changes; use them as fixed compatibility coverage, and only touch them for intentional upstream sync or harness maintenance.
```

**「Turso の挙動に合わせてこれを書き換えるな」。** 取り込んだ他所のテストは、動かした瞬間に基準としての意味を失う。

### 互換性の穴は、実装言語から生まれる

完全互換を目指していても、実装言語の選択そのものが穴を開けることがある。`COMPAT.md` の「Limitations」に挙がっているのは、たった 1 項目だけだ。

```text title="COMPAT.md"
**Text values must be valid UTF-8.** SQLite text is a plain byte string: it
never validates encoding, so a text value can hold any bytes. Turso represents
text as a Rust string, which must be valid UTF-8.
```

```sql
SELECT HEX(CAST(X'96' AS TEXT));
-- SQLite: 96
-- Turso:  EFBFBD
```

[`COMPAT.md#L83-L99`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/COMPAT.md#L83-L99)。

SQLite の TEXT はただのバイト列で、エンコーディングを検証しない。Rust の `String` は UTF-8 でなければならない。**`String` を使うと決めた時点で、この差は避けられなくなった。**

面白いのは、その影響範囲まで書き切っていることだ。

```text title="COMPAT.md"
This affects every operation that turns a blob into text: `CAST`, string
functions such as `UPPER` and `REPLACE`, and concatenation with `||`. Reading
an existing database that already contains invalid UTF-8 in a text column is
affected the same way. Storing and reading blobs is not affected; bytes only
change when they are converted to text.
```

**「BLOB のまま扱う限り影響しない。テキストに変換したときだけバイトが変わる」。** 直せない非互換を持ってしまったとき、必要なのは謝罪ではなく **境界の正確な記述**だ。これを読めば、自分のデータが影響を受けるかどうかを判定できる。

### 非互換な新機能は、全部フラグの裏にある

保証の 3 番目「opt in が必要」は、そのまま起動フラグとして実装されている。

```bash title="docs/sql-reference/experimental-features.mdx"
tursodb \
  --experimental-views \
  --experimental-custom-types \
  --experimental-encryption \
  --experimental-index-method \
  --experimental-vacuum \
  database.db
```

[`docs/sql-reference/experimental-features.mdx`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/sql-reference/experimental-features.mdx)。

マテリアライズドビュー、カスタム型、暗号化、索引方式、マルチプロセス WAL。**この章で扱う「Turso が SQLite に足したもの」の大半が、このリストに載っている。**

つまり、既定で起動した Turso が作るファイルには、SQLite が知らないものが 1 バイトも入らない。**足した機能は全部、明示的に有効化した人のファイルにだけ現れる。**

MVCC だけは少し違って、フラグではなく `PRAGMA journal_mode = 'mvcc'` で切り替わる。これも同じ考え方で、`journal_mode` は SQLite が元々持っている「ファイルの耐久性の方式を選ぶ」スイッチだ。**新しいスイッチを作るのではなく、既にある選択肢の枠に 1 つ足している。**

## なぜそうなっているか

- **保証を 4 行に圧縮したのは、判断を委譲するため。** 「これは互換性を壊すか」を毎回議論する代わりに、この 4 行に照らせば誰でも判定できる。しかも「戻れること」という利用者から見た言葉で書かれているので、実装の詳細が変わっても賞味期限が切れない。
- **ファイル形式だけを絶対に動かさないのは、そこが唯一「後から直せない」から。** 実行時の挙動のバグは、次のリリースで直せば直る。ファイルに書いてしまったバイト列は、既に利用者のディスクの上にある。
- **バイトコードまで合わせるのは、互換性のためではなくデバッグのため。** 中間表現が一致していれば、バグの所在を機械的に二分できる。「SQLite という参照実装が手元にある」という、書き直しプロジェクト特有の資産を最大限に使っている。
- **命令列の一致のために余計な初期化コストを払うのは、その資産の方が高いから。** 一度きりの `TEMP` DB 初期化と、デバッグ手段を失うことを天秤にかけている。
- **取り込んだ上流テストの改変を禁じたのは、基準が自分の都合で動くと基準でなくなるから。** 「テストが落ちたのでテストを直した」は、書き直しプロジェクトで最も起きやすい自壊の仕方だ。
- **UTF-8 の穴を隠さないのは、隠すと利用者が判定できなくなるから。** 「ほぼ互換です」ではなく「BLOB からテキストへの変換のときだけ変わります」と書けば、自分に関係あるかを読者が決められる。
- **新機能を全部フラグの裏に置いたのは、保証 1 (いつでも戻れる) を守る唯一の方法だから。** 既定で新しいものが混ざるなら、「戻れる」は嘘になる。

## どう活かすか

- **互換性は「完全互換」ではなく、いくつかの文で定義する。** 「全部同じ」は達成できないので、必ずどこかで崩れる。崩れたときに何が約束違反で何がそうでないかを、先に文にしておく。
- **その定義には、諦める項目を 1 つは入れる。** 「同時に両方から開くのは対応しない」のような明示的な非対応があると、残りの項目の信頼度が上がる。全部できると書いてある文書は読まれない。
- **参照実装があるなら、中間表現の一致まで持っていく。** 入力と出力だけを比べていると、差が出たときに全レイヤが容疑者になる。中間表現で答え合わせできると、探索空間が毎回半分になる。そのためなら多少の性能を捨てていい。
- **比較器には「比較してはいけないもの」を書き添える。** エラーメッセージ、タイムスタンプ、内部 ID。ここを書いておかないと、偽陽性を追いかける時間が比較器の価値を上回る。
- **取り込んだ他所のテストは、絶対に書き換えない。** 書き換えた瞬間に自分のテストになる。落ちたら実装を直すか、意図的な差分として別の場所に記録する。
- **直せない非互換は、影響範囲を正確に書く。** 「どの操作で、どの条件のときに、何がどう変わるか」まで書けば、利用者が自分で判定できる。曖昧に謝るより価値がある。
- **後方互換を壊す機能は、既定で無効にする。** そして「既定のまま使えば何も変わらない」を保証する。これがあると、新機能を足す速度を落とさずに互換性を守れる。
