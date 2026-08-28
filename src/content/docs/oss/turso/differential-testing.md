---
title: "sqlite3 に同じ SQL を流して差分を取る"
description: "参照実装が手元にあるなら、テストの期待値を人間が書く必要はない。Turso は 5 つの層で差分テストをやっている。40 行のシェルスクリプト、両方で走る .sqltest、上流から取り込んだ 849 個の TCL テスト、SQL を自動生成して結果を比べるファジング、そして外部の SQLancer と SQLRight。判定器は「不一致」を失敗と警告に分け、ORDER BY のない LIMIT のような正当な差は警告で済ませる。"
group: "品質保証"
sidebar:
  order: 58
---

## 何を学んだか

書き直しプロジェクトには、他にはない資産がある。**正解を答えてくれる参照実装が手元にある。**

普通のプロジェクトでは、テストの期待値を人間が書く。書き間違えれば、間違った期待値が固定される。

**SQLite が隣にいれば、期待値を計算できる。** Turso はこの資産を、5 つの層で使い切っている。

| 層                  | 何をするか                 | 規模                   |
| ------------------- | -------------------------- | ---------------------- |
| `scripts/diff.sh`   | 手で 1 つのクエリを比べる  | 40 行のシェル          |
| `.sqltest`          | 同じシナリオを両方で実行   | 387 ファイル           |
| upstream TCL        | SQLite 本家のテストを流す  | 849 ファイル           |
| differential-oracle | SQL を自動生成して比べる   | 独立したクレート群     |
| SQLancer / SQLRight | 外部のファジング基盤を繋ぐ | パッチと実行スクリプト |

[互換性のページ](../sqlite-compat/) で最初の 3 つを見たので、ここでは残りの 2 つと、**判定器の設計**を見る。

## ソースコードのどこか

### SQL の生成器を、型で縛る

```rust title="testing/differential-oracle/sql_gen/src/lib.rs"
//! SQL generator with type-state capabilities, runtime policy, and invisible tracing.
//!
//! This crate provides a schema-constrained SQL generator with:
//! - **Type-state + trait bounds** for compile-time hard restrictions
//! - **Runtime policy** with weights for soft restrictions
//! - **Invisible tracing** that automatically records what was generated
//! - **Hierarchical coverage** with origin tracking
//! - **proptest integration** via `Strategy` trait
```

[`testing/differential-oracle/sql_gen/src/lib.rs#L1-L9`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/differential-oracle/sql_gen/src/lib.rs)。

**制約が 2 種類ある。**

- **型で表す硬い制約** — 「この生成器は `SELECT` しか作らない」
- **重みで表す柔らかい制約** — 「サブクエリは 10% の確率で」

```rust title="testing/differential-oracle/sql_gen/src/lib.rs"
pub use capabilities::{
    CanAggregate, CanCte, CanDelete, CanInsert, CanSelect, CanSubquery, CanUpdate, CanWindowFn,
    Capabilities, DmlOnly, Full, NoSubquery, SelectOnly,
};
```

[`testing/differential-oracle/sql_gen/src/lib.rs#L53-L56`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/differential-oracle/sql_gen/src/lib.rs)。

**`SqlGen<SelectOnly>` と書けば、`INSERT` を生成する経路がコンパイルできない。**

なぜ型で縛るのか。**「読み取り専用のはずの生成器が、たまに書き込みを作る」というバグを、実行時に見つけるのは難しいから**だ。1000 回に 1 回混ざっても、たいてい気付かない。

「スキーマに制約される (schema-constrained)」のも重要で、**存在しない列名を生成しない。** 構文エラーだけを量産するファジングにならない。

そして「見えないトレーシング」が付いている。**何を生成したかが自動的に記録される。** 階層的なカバレッジと合わせて、**「生成器が届いていない構文」が見える** ([シミュレータと同じ発想](../deterministic-simulator/))。

### 判定器は 4 つの結果を返す

```rust title="testing/differential-oracle/fuzzer/oracle.rs"
/// Result of an oracle check.
#[derive(Debug, Clone)]
pub enum OracleResult {
    /// The oracle check passed.
    Pass,
    /// EXPLAIN failed in at least one engine, so neither engine ran the statement.
    Skipped(String),
    /// The oracle check passed but with a warning (e.g., LIMIT without ORDER BY).
    Warning(String),
    /// The oracle check failed with a reason.
    Fail(String),
}
```

[`testing/differential-oracle/fuzzer/oracle.rs#L21-L32`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/differential-oracle/fuzzer/oracle.rs)。

**「合格」「不合格」の 2 値ではない。**

- **`Skipped`** — どちらかの `EXPLAIN` が失敗したので、そもそも実行していない
- **`Warning`** — 差はあるが、正当な差の可能性がある

`Skipped` の説明が具体的だ。**「少なくとも片方のエンジンで `EXPLAIN` が失敗したので、どちらも文を実行しなかった」。**

片方が構文を受け付けない SQL は、比較できない。**それを「不合格」にすると、対応範囲の差が全部バグとして報告される。**

[AGENTS.md の「平易な言葉を使え」](../sqlite-compat/) の節に、まさにこの名前の例が載っている。

```diff title="AGENTS.md"
-    /// Number of generated statements outside the engines' shared executable domain.
+    /// Number of statements skipped because EXPLAIN failed in at least one engine.
```

**「エンジン共通の実行可能領域の外にある文の数」を「少なくとも片方で `EXPLAIN` が失敗したのでスキップした文の数」に直した。**

前者は正確だが、読んで何のことか分からない。後者は長いが、**次に何をすればいいかが分かる。**

### 正当な差を、警告として扱う

```rust title="testing/differential-oracle/fuzzer/oracle.rs"
                let diff = diff_results(turso_rows, sqlite_rows);
                if !diff.is_empty() {
                    // For non-deterministic LIMIT queries, the result set may legitimately differ
                    // since the chosen rows are not stable across engines. Return a warning instead
                    // of failure.
                    if has_unordered_limit {
                        return OracleResult::Warning(format_nondet_limit_warning(
```

[`testing/differential-oracle/fuzzer/oracle.rs#L104-L110`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/differential-oracle/fuzzer/oracle.rs)。

**`SELECT * FROM t LIMIT 3` に `ORDER BY` がなければ、どの 3 行が返るかは SQL の仕様上決まっていない。**

Turso と SQLite で違う 3 行が返っても、**どちらも正しい。** [実行計画が違えば](../join-order-dp/)、走査順も違う。

だから **警告にする。** 完全に無視すると、そこに紛れた本物のバグを見逃す。失敗にすると、偽陽性で埋まる。

**判定できないものを「判定できない」として記録する**のが、この設計になる。

そして `has_unordered_limit` という **生成時の情報を、判定時に持ち回っている。** 生成した SQL の文字列から後で判定するのではなく、生成器が知っていることを渡す。**情報が失われる前に運ぶ。**

同じ扱いが 3 箇所に出てくる (行の集合が違う、片方だけ行を返す、その逆) のも徹底している。

### 差の種類を、それぞれ別の文言で報告する

```rust title="testing/differential-oracle/fuzzer/oracle.rs"
            (QueryResult::Error(turso_err), _) => OracleResult::Fail(format!(
                "Turso errored but SQLite succeeded:\n  SQL: {stmt}\n  Error: {turso_err}"
            )),
            (_, QueryResult::Error(sqlite_err)) => OracleResult::Fail(format!(
                "SQLite errored but Turso succeeded:\n  SQL: {stmt}\n  Error: {sqlite_err}"
            )),
```

[`testing/differential-oracle/fuzzer/oracle.rs#L133-L138`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/differential-oracle/fuzzer/oracle.rs)。

**「Turso が失敗して SQLite が成功した」と「SQLite が失敗して Turso が成功した」を分けている。**

前者は「未実装か、バグ」。後者は **「SQLite が拒否する SQL を Turso が受け入れている」** で、意味がまったく違う。

「不一致」の一言にまとめると、この区別が失われる。**差分テストの価値は、差の種類を細かく分けることで決まる。**

### 失敗した後の道具を、別に用意する

```rust title="testing/differential-oracle/fuzzer/probe.rs"
//! Run a SQL script on Turso and SQLite side by side and show where they
//! disagree.
//!
//! This is the follow-up tool to a fuzzer failure: `minimized.sql` (or any
//! statement-per-line script) goes in, and every statement's outcome on both
//! engines comes out, with divergences marked. Unlike the tursodb shell, the
//! Turso connection here has ATTACH enabled and an `aux` in-memory database
//! attached when the script asks for one, so fuzzer reproductions run
//! unmodified.
```

[`testing/differential-oracle/fuzzer/probe.rs#L1-L9`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/differential-oracle/fuzzer/probe.rs)。

**「ファジングが落ちた後の後続ツール」と自己定義している。**

縮小された SQL を渡すと、**1 文ずつ両方のエンジンで実行して、食い違った場所に印を付ける。**

細部が実務的だ。**「`tursodb` のシェルと違って、この接続では `ATTACH` が有効で、スクリプトが要求すれば `aux` というメモリ上のデータベースが繋がる。だから再現用の SQL を無変更で流せる。」**

再現のたびに `ATTACH` の行を手で消す作業が発生する、というのは些細に見えて **調査の速度を確実に落とす。** 専用の道具を作る価値がそこにある。

出力の整形も気が利いている。

```rust title="testing/differential-oracle/fuzzer/probe.rs"
            for (i, row) in rows.iter().take(4).enumerate() {
```

```rust title="testing/differential-oracle/fuzzer/probe.rs"
            if out.len() > 300 {
                out.truncate(300);
                out.push_str("...");
            }
```

[`testing/differential-oracle/fuzzer/probe.rs#L30-L45`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/differential-oracle/fuzzer/probe.rs)。

**最初の 4 行だけ、300 文字で切る。** 1000 行返るクエリの全行を出されても読めない。

そして終了コードの規約が明示されている。

```rust title="testing/differential-oracle/fuzzer/probe.rs"
//! With no argument the script is read from stdin. Statements are one per
//! line; lines starting with `--` are skipped. The exit code is 1 when any
//! statement diverged or the final table contents differ, 0 otherwise.
```

**「食い違うか、最終的なテーブルの中身が違えば終了コード 1」。** スクリプトから使える。

「最終的なテーブルの中身」も比べているのが重要で、**クエリの結果が全部一致しても、書き込みの結果が違うことがある。** 出力だけでなく、状態も比べる。

### 外部のファジング基盤も繋ぐ

```text title="testing/sqlancer/README.md"
# SQLancer Testing

Run [SQLancer](https://github.com/sqlancer/sqlancer) against Limbo to find bugs.
```

```bash title="testing/sqlancer/README.md"
./scripts/run-sqlancer.sh              # 60s default
./scripts/run-sqlancer.sh --timeout 300  # 5 minutes
```

[`testing/sqlancer/README.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/sqlancer/README.md)。

**SQLancer は DBMS のバグ発見で実績のある研究ツール。** PQS、NoREC、TLP といった「参照実装なしで論理バグを見つける」手法を実装している。

`patches/` があるのは、**Turso を対象にするための改変**が要るからだ。SQLancer は各 DBMS ごとの接続コードを持つので、そこに Turso を足す。

SQLRight も同様で、**カバレッジ誘導型の SQL ファジング**になる。

**自作の生成器と、外部のツールの両方を持っている。** 自作は自分たちの弱いところを狙えるが、外部のツールは **自分たちが思いつかなかった形**を試す。[Elle を使ったのと同じ判断](../whopper-elle/) になる。

## なぜそうなっているか

- **参照実装を全層で使うのは、期待値を書かずに済むから。** 人間が書いた期待値は、実装と同じ誤解を含みうる。
- **手軽な層から重い層まで揃えたのは、使う場面が違うから。** 1 つのクエリを確かめたいときにファジングは起動しない。40 行のシェルスクリプトが要る。
- **生成器を型で縛るのは、生成の範囲を実行時に検証できないから。** 「読み取り専用のはずが書き込みを生成した」は、1000 回に 1 回では気付かない。
- **スキーマに制約させるのは、構文エラーばかり生成しないため。** 存在しない列を参照する SQL は、エラーになるだけで何も検査しない。
- **生成したものを記録するのは、届いていない構文が見えないから。** ランダム生成は「何を試していないか」が分からない。
- **判定結果を 4 つに分けたのは、「比較できない」と「差がある」が違うから。** 片方が受け付けない構文を失敗にすると、対応範囲の差が全部バグになる。
- **正当に差が出うるクエリを警告にしたのは、無視も失敗も不適切だから。** 無視すると本物のバグが紛れ、失敗にすると偽陽性で埋まる。
- **生成時の情報を判定に渡すのは、後から復元できないから。** 「`ORDER BY` のない `LIMIT` があるか」は、生成器が既に知っている。
- **差の向きで文言を分けたのは、意味が違うから。** 「実装が足りない」と「余計に受け入れている」は、対応がまったく違う。
- **再現用の道具を別に作ったのは、調査の手間が積み重なるから。** 毎回スクリプトを手で直す作業は、時間を確実に食う。
- **出力を切り詰めるのは、読まれなければ意味がないから。** 1000 行の差分は誰も読まない。
- **外部のファジング基盤も繋ぐのは、自作の生成器が自分たちの想像の範囲を出ないから。**

## どう活かすか

- **参照実装があるなら、期待値を書かずに計算する。** 移植、書き直し、リファクタリング。旧実装が動くうちに、差分を取る仕組みを作る。
- **同じ比較を、手軽な層から重い層まで用意する。** 40 行のスクリプト、宣言的なテストファイル、自動生成のファジング。使う場面が違うので、どれも要る。
- **入力の生成器には、生成できる範囲を型で表す。** 「この設定では作らないはず」を実行時に検証するのは難しい。
- **生成器は、対象の構造 (スキーマ) に制約させる。** 構文エラーだけを量産する生成は、何も検査していない。
- **生成したものを記録して、カバレッジを取る。** ランダム生成の弱点は、届いていない範囲が見えないことにある。
- **判定結果に「比較できない」を用意する。** 合格/不合格の 2 値に押し込むと、対応範囲の差がノイズになる。
- **仕様上どちらも正しい差は、警告として記録する。** 無視も失敗も不適切な中間がある。
- **判定に必要な情報は、生成の時点で拾って持ち回る。** 後から入力を解析して復元するより確実になる。
- **差の種類ごとに、別の文言で報告する。** 「不一致」の一語にまとめると、対応の方針が読み取れない。
- **失敗を調べる専用の道具を作る。** 再現のたびに手作業が要るなら、その手作業を道具に入れる。
- **出力は切り詰める。** 読まれない詳細は、ないのと同じになる。
- **自作の生成器と、外部の生成器の両方を使う。** 自作は狙いを定められるが、想像の範囲を出ない。
- **技術的に正確な名前より、次の行動が分かる名前を選ぶ。** 「共通実行可能領域の外」より「`EXPLAIN` が失敗したのでスキップ」の方が長いが、読める。
