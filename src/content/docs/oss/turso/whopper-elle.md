---
title: "並行実行の異常判定を Elle に任せる"
description: "Whopper は並行版のシミュレータで、複数のファイバをラウンドロビンで 1 ステップずつ進める。スレッドを使わないので、インターリーブが seed から完全に決まる。そして「この実行は正しかったか」の判定を自分で書かず、Jepsen の Elle に EDN 形式の履歴を渡して外注する。トランザクションの異常検出は理論が確立している領域なので、自分で書くより既製品の方が強い。"
group: "品質保証"
sidebar:
  order: 35
---

## 何を学んだか

[前のページ](../deterministic-simulator/) のシミュレータは、単一の接続を対象にする。だが Turso には [MVCC](../mvcc/) も [BEGIN CONCURRENT](../mvcc/) も [マルチプロセス](../shared-wal-tshm/) もある。

**並行実行の正しさを検査するには、別の道具が要る。** それが Whopper (`testing/concurrent-simulator/`) になる。

```text title="testing/concurrent-simulator/README.md"
# Turso Whopper - Concurrent Simulator

Deterministic concurrent simulator for Turso.
```

[`testing/concurrent-simulator/README.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/README.md)。

そして **判定は自分でやらない。**

```rust title="testing/concurrent-simulator/elle.rs"
//! Elle integration for transactional consistency checking.
//!
//! Elle is a black-box transactional consistency checker from Jepsen that detects
//! anomalies (G0, G1, G2, G-Single from Adya's formalism) by analyzing transaction histories.
```

[`testing/concurrent-simulator/elle.rs#L1-L7`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/elle.rs#L1-L7)。

**Elle は Jepsen のトランザクション整合性チェッカ。** 実行履歴を渡すと、Adya の形式化に基づく異常 (G0, G1, G2, G-Single) を検出する。

## ソースコードのどこか

### 並行性を、スレッドではなくファイバで作る

```rust title="testing/concurrent-simulator/lib.rs"
        let fiber_idx = self.current_step % self.context.fibers.len();
        self.perform_work(fiber_idx)?;
        self.io.step()?;
        self.current_step += 1;
```

[`testing/concurrent-simulator/lib.rs#L874-L877`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/lib.rs#L874-L877)。

**ラウンドロビンで、1 ステップに 1 つのファイバを進める。**

これができるのは、[エンジンが協調的に yield する](../io-result/) からだ。`stmt.step()` を呼ぶと、I/O 待ちで帰ってくる。**そこで別のファイバに切り替えれば、並行実行を単一スレッドで模倣できる。**

**OS のスケジューラを使わないので、インターリーブが完全に決定的**になる。同じ seed なら、同じ順序で同じ切り替えが起きる。

そして [yield 注入](../memory-yield-io/) が、切り替え点を増やす。I/O が起きない場所でも、seed から決めた地点で中断する。

**「並行バグは再現できない」という常識を、実行モデルの選択で覆している。** `async`/`await` を使わず手書きの状態機械にした判断が、ここで最大の配当を出す。

### 履歴を Elle の形式で記録する

```rust title="testing/concurrent-simulator/elle.rs"
pub enum ElleOp {
    /// Append a value to a list identified by key (list-append model)
    Append { key: String, value: i64 },
    /// Read a list by key, result is None before execution and Some after (list-append model)
    Read {
        key: String,
        result: Option<Vec<i64>>,
    },
    /// Write a single value to a key (rw-register model)
    Write { key: String, value: i64 },
    /// Read a single value by key (rw-register model)
    RwRead { key: String, result: Option<i64> },
}
```

[`testing/concurrent-simulator/elle.rs#L17-L30`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/elle.rs#L17-L30)。

**Elle には 2 つのモデルがある。**

- **list-append** — 各キーがリスト。トランザクションは値を追加するか、リストを読む
- **rw-register** — 各キーが 1 つの値。読むか書くか

list-append が強力なのは、**追記が可換でないから**だ。リストの中身の順序が、書き込みの順序をそのまま記録する。**読み取った値そのものが、依存関係の証拠になる。**

単なる `x = 5` では、「誰が書いた 5 か」が分からない。`[1, 2, 5]` なら、**1 → 2 → 5 の順に追記されたことが確定する。**

イベントの種類は 4 つある。

```rust title="testing/concurrent-simulator/elle.rs"
pub enum ElleEventType {
    /// Operation invoked but not yet completed
    Invoke,
    /// Operation completed successfully
    Ok,
    /// Operation failed (e.g., transaction aborted)
    Fail,
    /// Informational event (crash, etc.)
    Info,
}
```

[`testing/concurrent-simulator/elle.rs#L70-L81`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/elle.rs#L70-L81)。

**`Invoke` と `Ok` が対になっている。** 「いつ始まったか」と「いつ終わったか」の両方を記録する。これがないと、**並行していた操作の集合が決まらない。**

`Info` が「結果が分からない」を表すのも重要で、クラッシュやタイムアウトでは **成功したか失敗したかが不明**になる。Elle はそれを「どちらでもありうる」として扱う。

**3 値 (成功/失敗/不明) を持つことが、分散システムの検証では必須**になる。

出力は EDN (Clojure のデータ形式) になる。

```rust title="testing/concurrent-simulator/elle.rs"
    /// Convert to EDN format.
    /// Example: {:type :ok, :f :txn, :value [[:append "x" 1] [:r "y" [1 2]]], :process 0, :index 5}
    pub fn to_edn(&self) -> String {
```

[`testing/concurrent-simulator/elle.rs#L106-L108`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/elle.rs#L106-L108)。

**Rust から Clojure のデータを文字列で吐く。** 相手が JVM のツールなので、共通の形式に落とす。

`process` にファイバ ID を入れているのが対応の要になる。**Elle にとっての「プロセス」は「順番に操作する主体」で、Turso にとってのファイバがそれに当たる。**

### 判定は外部のツールに投げる

```bash title="testing/concurrent-simulator/README.md"
cargo build -p turso_whopper
SEED=14201626211019268779 ./target/debug/turso_whopper \
    --elle list-append \
    --elle-output elle-history.edn \
    --max-steps 100000 \
    --enable-mvcc
```

```bash title="testing/concurrent-simulator/README.md"
java -jar /tmp/elle-cli/target/elle-cli-0.1.9-standalone.jar \
    --model list-append \
    --consistency-models snapshot-isolation \
    --verbose \
    --directory elle-results \
    elle-history.edn
```

[`testing/concurrent-simulator/README.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/README.md)。

**`--consistency-models snapshot-isolation` — 「スナップショット分離を満たしているか」を検査する。**

[MVCC のページ](../mvcc/) で見たとおり、Turso が提供するのはスナップショット分離であって直列化可能性ではない。**その主張を、外部のツールに検査させている。**

自分で異常検出器を書くと、**「自分が想定した異常しか検出しない」** という問題が避けられない。Elle は Adya の形式化に基づいて依存グラフを構築し、**理論的に定義された異常の全種類**を探す。

**判定の理論が確立している領域では、自作より既製品の方が強い。**

手順は README にコピペできる形で書いてある。

```bash title="testing/concurrent-simulator/README.md"
brew install leiningen openjdk graphviz
```

**JVM も Leiningen も Graphviz も要る。** 手軽ではない。それでも書いてあるのは、**CI で落ちた seed を手元で調べる**ためになる。

「CI のログから seed を取って走らせろ」という一文が、この道具の使われ方を表している。

### 依存関係を作るための、7 つの取引パターン

```rust title="testing/concurrent-simulator/chaotic_elle.rs"
//! Chaotic Elle workloads for the concurrent simulator.
//!
//! These workloads generate multi-operation transactions that create rich
//! read-write dependency structures for Elle to analyze. Unlike the coordinated
//! hermitage workloads, chaotic Elle workloads have no barriers or coordination —
//! each is a simple state machine that walks through a pre-planned sequence of
//! Elle operations (reads and appends on the `elle_lists` table).
//!
//! Seven transaction templates create diverse dependency patterns:
//!
//! | Template             | Pattern                        | Targets           |
//! |----------------------|--------------------------------|-------------------|
//! | ReadThenWriteElsewhere | Read X, Append Y             | G-single, G2      |
//! | MultiKeyReader       | Read 2-4 distinct keys         | snapshot inconsistency |
//! | ReadModifyWrite      | Read X, Append X               | G0, G2            |
//! | Aborter              | Append 1-3 keys, Rollback      | G1a               |
```

[`testing/concurrent-simulator/chaotic_elle.rs#L1-L20`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/chaotic_elle.rs)。

**ランダムな操作を投げるのではなく、「どの異常を狙うか」から取引の形を設計している。**

- `ReadThenWriteElsewhere` — X を読んで Y に書く → 読み書きの依存が交差する (G-single, G2)
- `ReadModifyWrite` — X を読んで X に書く → 書き込み同士の依存 (G0, G2)
- `Aborter` — 書いてからロールバック → 中断した書き込みが読まれる異常 (G1a)

**「異常の種類」と「それを起こしうる取引の形」の対応表**が、そのままモジュールのドキュメントになっている。

そして 2 種類のワークロードがあることも書かれている。

- **hermitage 系** — 協調して動く。バリアで同期を取り、既知の異常シナリオを狙い撃つ
- **chaotic 系** — 協調しない。各ファイバが独立に事前計画された列を歩く

**狙い撃ちと乱雑さの両方を持っている。** 前者は既知の異常を確実に踏み、後者は想定していない組み合わせを探す。

### 実行中の不変条件も、別に検査する

Elle は履歴を後から解析する。それとは別に、**実行中に検査するプロパティ**がある。

```rust title="testing/concurrent-simulator/properties.rs"
/// A property that can be validated during simulation.
/// Properties observe operations and can validate invariants.
pub trait Property: Send + Sync {
    /// Called when an operation starts execution.
    fn init_op(...)
    fn finish_op(...)
    fn abort_fiber(&mut self, _fiber_id: usize, _txn_id: Option<u64>) -> anyhow::Result<()> {
    fn on_restart(...)
    fn finalize(&mut self) -> anyhow::Result<()> {
```

[`testing/concurrent-simulator/properties.rs#L13-L34`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/properties.rs)。

**操作の開始、終了、ファイバの中断、再起動、そして全体の終了。** 5 つのフックがある。

`on_restart` があるのが特徴的で、**シミュレータはプロセスの再起動も模倣する**。再起動をまたいで成り立つべき不変条件 (コミットしたものは残っている) を検査できる。

`finalize` は最後に 1 回で、**「全部終わってから確かめる」種類の性質**に使う。「消えたキーがない」など。

`SimpleKeysDoNotDisappear` という名前の実装があるのが、この道具の性格を表している。**「キーが消えない」— 最も基本的な性質を、明示的に検査している。**

### 中断された文とチェックポイントの競合

```rust title="testing/concurrent-simulator/lib.rs"
    /// The fiber's statement is suspended mid-execution. Occasionally try to
    /// checkpoint the same connection and check the contract the engine
    /// promises: the checkpoint is refused (running it would invalidate the
    /// suspended statement's cursors and page cache), and refusal leaves no
    /// state behind — the suspended statement keeps running on later steps
    /// and the rest of the workload continues on this connection.
    ///
    /// Regression coverage for checkpoints racing suspended statements: on
    /// unguarded builds the checkpoint runs, and the suspended statement
    /// either panics on resume, silently loses a write, or silently returns
    /// wrong rows.
    fn maybe_probe_checkpoint_on_suspended_statement(
```

[`testing/concurrent-simulator/lib.rs#L886-L898`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/lib.rs#L886-L898)。

**「文が中断している最中に、同じ接続でチェックポイントを走らせようとする」を意図的にやる。**

期待する挙動は 2 段になっている。

1. **拒否される** — 走らせると、中断中の文のカーソルと [ページキャッシュ](../page-cache-pin/) が無効になる
2. **拒否が何も残さない** — 中断中の文は後のステップで再開でき、他の作業も続く

そして守られなかった場合の症状が 3 つ書いてある。**再開時に panic するか、書き込みが黙って消えるか、間違った行を返すか。**

**「拒否されること」だけでなく「拒否の後始末が正しいこと」まで検査している。** 拒否の実装で状態を半端に変えると、2 番目が壊れる。

[協調的な実行モデル](../io-result/) 特有の危険が、ここに集約されている。**文が「中断中」という状態を持つので、その間に何が起きるかを全部考える必要がある。**

### 実行の網羅度を測る

```bash title="testing/concurrent-simulator/README.md"
make whopper-coverage WHOPPER_RUNS=10 \
  WHOPPER_ARGS="--mode fast --max-steps 10000 --multiprocess --processes 2 --connections-per-process 2"
```

[`testing/concurrent-simulator/README.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/README.md)。

**シミュレータの実行から行カバレッジを取る。**

ランダムな生成器は、**「実際に何を試しているか」が分からない**。カバレッジを測れば、**生成器が届いていない領域**が見える。

`--multiprocess --processes 2` があるので、[`.tshm` を使ったマルチプロセス経路](../shared-wal-tshm/) もこの中で試される。

## なぜそうなっているか

- **スレッドではなくファイバにしたのは、インターリーブを決定的にするため。** OS のスケジューラを使うと、同じ seed でも順序が変わる。
- **それができるのは、エンジンが協調的に yield するから。** `async`/`await` を使わない判断が、テスト容易性という形で返ってきている。
- **判定を Elle に外注したのは、自作の検出器が自分の想定内しか見つけないから。** トランザクションの異常は理論として整備されている。実装を借りる方が確実になる。
- **list-append モデルを使うのは、追記が順序の証拠を残すから。** 単なる代入では、読んだ値がどの書き込みから来たか分からない。
- **`Invoke` と `Ok` を対で記録するのは、並行していた操作の集合を決めるため。** 完了だけでは、どれとどれが重なっていたか分からない。
- **「結果不明」を表す種別があるのは、クラッシュでは成否が決まらないから。** 2 値にすると、どちらかに嘘をつくことになる。
- **取引のパターンを異常の種類から設計したのは、乱数だけでは狙った依存構造が出にくいから。** G1a を起こすには、書いてから中断する取引が要る。
- **協調型と非協調型の両方を持つのは、狙い撃ちと探索の両方が要るから。** 既知の異常は確実に踏み、未知の組み合わせは乱雑さで探す。
- **実行中のプロパティを別に持つのは、Elle が見ないものがあるから。** 「キーが消えない」は、Elle のモデルの外にある。
- **再起動のフックがあるのは、耐久性の検査に要るから。** 「コミットしたものが再起動後も残っている」は、再起動を模倣しないと検査できない。
- **拒否の後始末まで検査するのは、そこが壊れやすいから。** 「拒否する」実装が状態を半端に変えると、次の操作が壊れる。
- **カバレッジを測るのは、生成器の届く範囲が見えないから。** ランダムな生成は「何を試していないか」が分からない。

## どう活かすか

- **並行実行を検査したいなら、まず「インターリーブを制御できるか」を考える。** OS のスレッドに任せた時点で、再現性は失われる。協調的な切り替え点があるなら、そこを使う。
- **判定の理論が確立している領域では、既製の検証器を探す。** 自作の検出器は、自分が想定した異常しか見つけない。理論に基づいた道具は、想定していない異常も見つける。
- **外部の検証器に渡すために、履歴を記録できる形にする。** 形式変換のコードは 200 行程度で書ける。それで数千行の検証ロジックが手に入る。
- **記録するモデルは、順序の証拠が残るものを選ぶ。** 上書きは情報を消す。追記なら、結果そのものが履歴になる。
- **操作の開始と終了を両方記録する。** どれとどれが並行していたかは、完了時刻だけでは決まらない。
- **「結果が分からない」を表現できる形にする。** 成功と失敗の 2 値にすると、クラッシュした操作でどちらかに嘘をつくことになる。
- **狙った異常を起こす入力の形を、設計して用意する。** 完全な乱数では、特定の依存構造がめったに出ない。「この異常にはこの形」の対応表を作る。
- **協調型と非協調型のワークロードを両方持つ。** 既知のシナリオを確実に踏むものと、想定外を探すもの。
- **「拒否されるべき操作」は、拒否されることと、拒否が何も壊さないことの両方を検査する。** 後者の方が壊れやすい。
- **ランダムな生成器には、カバレッジ計測を併せる。** 「何を試したか」ではなく「何を試していないか」が見える。
