---
title: "決定的シミュレーションで「同じ seed なら同じバグ」にする"
description: "乱数、時刻、I/O の遅延と失敗を全部 seed から導き、同じ seed なら同じ実行になるようにする。生成するのはランダムな SQL の列ではなく「プロパティ」で、insert したら select で必ず取れるといった不変条件と、それを壊さない範囲の雑音がセットになっている。落ちたら seed とプランを bug base に保存し、失敗するプランを自動で縮める。同じプランを 2 回走らせて結果が違えば、それ自体がバグになる。"
sidebar:
  order: 34
---

## 何を学んだか

データベースのバグには、性質の悪いものがある。**特定の順序で特定のタイミングで I/O が失敗したときだけ壊れる。**

普通のテストでは踏めない。ランダムテストなら踏めるが、**踏んでも再現できない。**

決定的シミュレーション (deterministic simulation testing) はこれを解く。**非決定性の源を全部 seed から導き、実行を完全に再現可能にする。**

```text title="testing/simulator/README.md"
Limbo simulator uses randomized deterministic simulations to test the Limbo database behaviors.
```

[`testing/simulator/README.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/simulator/README.md)。

参照文献が最後に並んでいる。

```text title="testing/simulator/README.md"
- [(reading) TigerBeetle Deterministic Simulation Testing](https://docs.tigerbeetle.com/about/vopr/)
- [(reading) sled simulation guide (jepsen-proof engineering)](https://sled.rs/simulation.html)
- [(video) "Testing Distributed Systems w/ Deterministic Simulation" by Will Wilson](https://www.youtube.com/watch?v=4fFDFbi3toc)
```

**TigerBeetle、sled、FoundationDB。** この手法の系譜が明示されている。

## ソースコードのどこか

### 非決定性を全部 seed に集める

```rust title="testing/simulator/runner/io.rs"
    pub(crate) fault: Cell<bool>,
    pub(crate) rng: RefCell<ChaCha8Rng>,
    latency_probability: u8,
```

```rust title="testing/simulator/runner/io.rs"
        let rng = RefCell::new(ChaCha8Rng::seed_from_u64(seed));
```

[`testing/simulator/runner/io.rs#L14-L57`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/simulator/runner/io.rs)。

**シミュレータ用の [`IO` バックエンド](../io-backends/) が、seed から導いた乱数生成器を持つ。** どの操作を失敗させるか、どこに遅延を挟むかを、そこから決める。

時刻も同じだ。

```rust title="testing/simulator/runner/clock.rs"
pub struct SimulatorClock {
    curr_time: RefCell<DateTime<Utc>>,
    rng: RefCell<ChaCha8Rng>,
    min_tick: u64,
    max_tick: u64,
}

impl SimulatorClock {
    pub fn now(&self) -> DateTime<Utc> {
        let mut time = self.curr_time.borrow_mut();
        let nanos = self
            .rng
            .borrow_mut()
            .random_range(self.min_tick..self.max_tick);
        let nanos = std::time::Duration::from_micros(nanos);
        *time += nanos;
        *time
    }
}
```

[`testing/simulator/runner/clock.rs`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/simulator/runner/clock.rs)。

**`now()` を呼ぶたびに、乱数で決めた分だけ時刻が進む。** 実際の時計は見ない。

この 30 行が、決定的シミュレーションの本質をよく表している。**時刻は「今何時か」ではなく「前回から何ナノ秒進んだか」で表せる。** 進む量が seed から決まれば、時刻も再現可能になる。

[`Clock` trait が `IO` trait の親になっている](../io-backends/) のは、このためだ。**I/O バックエンドを差し替えると、時計も一緒に差し替わる。**

[アロケータの失敗注入](../allocation-site/) も、[状態機械の yield 注入](../memory-yield-io/) も、同じ seed から導かれる。**非決定性の源を 1 つ残らず捕まえる**必要がある。

### 生成するのは、SQL ではなくプロパティ

ランダムな SQL を投げるだけでは、**「結果が正しいか」を判定できない。**

```text title="testing/simulator/README.md"
Based on these parameters, we randomly generate **interaction plans**. Interaction plans consist of statements/queries, and assertions that will be executed in order. The building blocks of interaction plans are:

- Randomly generated SQL queries satisfying the workload distribution,
- Properties, which contain multiple matching queries with assertions indicating the expected result.
```

**「プロパティ」= 複数のクエリと、期待される関係の主張。**

例が分かりやすい。

```sql title="testing/simulator/README.md"
-- begin testing 'Select-Select-Optimizer'
-- ASSUME table marvelous_ideal exists;
SELECT ((devoted_ahmed = -9142609771.541502 AND loving_wicker = -1246708244.164486)) FROM marvelous_ideal WHERE TRUE;
SELECT * FROM marvelous_ideal WHERE (devoted_ahmed = -9142609771.541502 AND loving_wicker = -1246708244.164486);
-- ASSERT select queries should return the same amount of results;
-- end testing 'Select-Select-Optimizer'
```

**同じ条件を「射影で評価する」場合と「`WHERE` で評価する」場合で、真になる行数が一致するはず。**

期待値を人間が書かなくていい。**2 つのクエリの関係が期待値になっている。** [オプティマイザ](../join-order-dp/) が `WHERE` の側だけを索引で処理しても、答えは変わってはいけない。

もう 1 つの例は、時間をまたぐ。

```rust title="testing/simulator/README.md"
/// Insert-Select is a property in which the inserted row
/// must be in the resulting rows of a select query that has a
/// where clause that matches the inserted row.
/// The execution of the property is as follows
///     INSERT INTO <t> VALUES (...)
///     I_0
///     I_1
///     ...
///     I_n
///     SELECT * FROM <t> WHERE <predicate>
/// The interactions in the middle has the following constraints;
/// - There will be no errors in the middle interactions.
/// - The inserted row will not be deleted.
/// - The inserted row will not be updated.
/// - The table `t` will not be renamed, dropped, or altered.
```

[`testing/simulator/README.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/simulator/README.md)。

**「挿入した行は、後で条件に合う select で必ず出てくる」。**

そして `I_0` から `I_n` の **中間に、無関係なクエリを好きなだけ挟む。** 制約は 4 つだけ (その行を消さない、更新しない、表を消さない、エラーにしない)。

**プロパティの前後に雑音を混ぜることで、状態空間を広げながら不変条件を保てる。** 「insert して select する」だけのテストでは、キャッシュが溢れることも [チェックポイント](../wal/) が走ることもない。

**「不変条件を壊さない操作」の範囲を明示することが、この手法の設計そのもの**になる。

### 落ちたら、seed とプランを保存する

```rust title="testing/simulator/runner/bugbase.rs"
const READABLE_PLAN_PATH: &str = "plan.sql";
const SHRUNK_READABLE_PLAN_PATH: &str = "shrunk.sql";
const SEED_PATH: &str = "seed.txt";
pub struct Bug {
    pub seed: u64,
    pub plan: Option<InteractionPlan>,
    pub shrunk_plan: Option<InteractionPlan>,
    pub runs: Vec<BugRun>,
}
```

[`testing/simulator/runner/bugbase.rs#L18-L26`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/simulator/runner/bugbase.rs)。

**「bug base」— 落ちた実行の保管庫。** seed、実行したプラン、縮めたプラン、そして過去の実行結果の履歴。

`plan.sql` として **人間が読める SQL でも保存する**。seed だけでも再現できるが、**seed を渡されても何が起きたかは分からない。**

再現はこれだけになる。

```text title="testing/simulator/README.md"
  -l, --load <LOAD>                  load plan from the bug base
```

`BugRun` に `cli_options` が入っているのも重要で、**再現にはシミュレータの設定も要る**。seed だけでは足りない。

### 失敗するプランを自動で縮める

```rust title="testing/simulator/shrink/plan.rs"
    /// Create a smaller interaction plan by deleting a property
    pub(crate) fn shrink_interaction_plan(&self, failing_execution: &Execution) -> InteractionPlan {
        // todo: this is a very naive implementation, next steps are;
        // - Shrink to multiple values by removing random interactions
        // - Shrink properties by removing their extensions, or shrinking their values
        let mut plan = self.clone();
```

[`testing/simulator/shrink/plan.rs#L23-L28`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/simulator/shrink/plan.rs)。

**5000 個の操作の途中で落ちたプランを、そのまま渡されても読めない。** 失敗に関係ない操作を削っていく。

```rust title="testing/simulator/shrink/plan.rs"
        // Interactions that are part of the failing overall property
        let mut failing_property = all_interactions
            [range.start..=failing_execution.interaction_index]
            .iter()
            .rev();
```

[`testing/simulator/shrink/plan.rs#L34-L39`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/simulator/shrink/plan.rs)。

**失敗した操作が属するプロパティを特定し、そこから遡る。** プロパティという単位があるので、「どこからどこまでが 1 つの意味のあるまとまりか」が分かる。

TODO が正直で、**「非常に素朴な実装」だと自分で書いている。** それでも縮めないよりは遥かにいい。

### 同じプランを 2 回走らせる

```text title="testing/simulator/README.md"
  -d, --doublecheck                  enable doublechecking, run the simulator with the plan twice and check output equality
```

**同じプランを 2 回実行して、出力が一致するか確かめる。**

一致しなければ、**それ自体がバグ**になる。決定性が壊れているか、シミュレータが捕まえていない非決定性の源がある。

**「シミュレータが本当に決定的か」を、シミュレータ自身に確かめさせる。** [「必ず yield する I/O 実装が、本当に yield しているかを assert する」](../memory-yield-io/) と同じ形になっている。

### SQLite と並べて走らせる

```text title="testing/simulator/README.md"
You can use the `--differential` flag to run the simulator in differential testing mode. This mode will run the same interaction plan on both Limbo and SQLite, and compare the results. It will also check for any panics or errors in either database.
```

**同じプランを SQLite にも流して、結果を比べる。**

プロパティで書ける不変条件は限られている。**「SQLite と同じ結果になる」は、ほぼ全部のクエリに適用できる最強の不変条件**になる ([該当ページ](../differential-testing/))。

### ワークロードの分布を設定で変える

```text title="testing/simulator/README.md"
A Simulator Profile allows you to influence query generation and I/O fault injection. You can run predefined profiles or you can create your own custom profile in a separate JSON file.
```

```text title="testing/simulator/README.md"
For development purposes, you can run `make sim-schema` to generate a JsonSchema of the `Profile` struct. Then you can create profiles to test locally in a `configs/custom` folder that is gitignored and have editor integration by adding `$schema` tag
```

**プロファイルの JSON スキーマを、Rust の構造体から生成できる。** そしてエディタ補完が効く。

[コストモデルのパラメータ](../cost-params/) と同じ形で、**「調整のためのつまみ」を JSON にまとめて外に出している。** さらにスキーマを生成することで、書き間違いがエディタで分かる。

`configs/custom` が gitignore されているのも実務的で、**手元の試行錯誤をコミットしなくていい。**

### Miri でも走らせる

```text title="testing/simulator/README.md"
Miri is a deterministic Rust interpreter designed to identify undefined behavior. To run the simulator under Miri, use
```

```bash
MIRIFLAGS="-Zmiri-disable-isolation -Zmiri-disable-stacked-borrows" RUST_LOG=limbo_sim=debug cargo +nightly miri run --bin limbo_sim -- --disable-integrity-check
```

**Miri は未定義動作を検出する Rust のインタプリタ。** `unsafe` が 600 箇所以上あるコードベースでは、これが効く。

シミュレータが生成する多様な操作列を Miri の下で走らせれば、**未定義動作の検出範囲が一気に広がる。**

必要なフラグの理由が 3 つとも書いてある。

```text title="testing/simulator/README.md"
- `-Zmiri-disable-isolation` is needed for host access (like opening a file)
- `-Zmiri-disable-stacked-borrows` this alias checking is experimental, so disabled for now
- `--disable-integrity-check` is needed since we can't run sqlite via the FFI in Miri
```

**「なぜこのフラグが要るか」がないと、後から外していいのか判断できない。** `stacked-borrows` は「実験的だから今は切っている」と書いてあるので、将来有効にできる。

そして [`io/mod.rs` の `cfg`](../io-backends/) に `not(miri)` が入っていたのは、これのためになる。**Miri では io_uring も同期 syscall も使えないので、メモリ実装に落ちる。**

## なぜそうなっているか

- **非決定性の源を全部 seed から導くのは、再現できないバグが直せないから。** 「1 万回に 1 回落ちる」を報告されても、修正を確認できない。
- **時刻を「前回からの差分」で表したのは、それなら乱数で決められるから。** 絶対時刻を再現するのは難しいが、進む量なら制御できる。
- **時計を `IO` trait の一部にしたのは、まとめて差し替えるため。** 別々に差し替えられると、片方だけ本物になる事故が起きる。
- **ランダムな SQL ではなくプロパティを生成するのは、期待値が要るから。** ランダムなクエリの正解は誰も知らない。「2 つのクエリの結果が一致する」なら、正解を知らずに判定できる。
- **プロパティの間に雑音を挟むのは、状態空間を広げるため。** 短い操作列では、キャッシュ溢れもチェックポイントも起きない。
- **雑音の制約を明示するのは、不変条件が壊れないようにするため。** 「その行を消さない」を守れば、いくら操作を挟んでも主張は成り立つ。
- **seed だけでなくプランも SQL で保存するのは、seed が読めないから。** 再現はできても、理解はできない。
- **設定も一緒に保存するのは、再現に要るから。** ワークロードの分布や障害の確率が違えば、同じ seed でも違う実行になる。
- **プランを自動で縮めるのは、5000 操作が読めないから。** 素朴な実装でも、縮めないよりずっといい。
- **同じプランを 2 回走らせるのは、決定性そのものを検査するため。** 捕まえ損ねた非決定性の源は、この方法でしか見つからない。
- **Miri で走らせるのは、`unsafe` が多いから。** シミュレータの多様な操作列と組み合わせると、検出範囲が広がる。
- **フラグの理由を書いたのは、後から外せるようにするため。** 「実験的だから今は切っている」なら、将来有効にできる。

## どう活かすか

- **再現性のないテストは、バグを見つけても直せない。** 乱数、時刻、スレッドの順序、I/O の結果。非決定性の源を数え上げて、全部を 1 つの seed から導く。
- **時刻は「絶対時刻」ではなく「前回からの経過」として抽象化する。** 進む量を制御できれば、時刻は再現可能になる。
- **同時に差し替えるべきものは、1 つのインタフェースにまとめる。** 時計と I/O が別々だと、片方だけ本物になる。
- **ランダム入力のテストでは、期待値を「入力から計算する」のではなく「複数の結果の関係」で表す。** 正解を知らなくても判定できる。
- **不変条件を保ったまま雑音を混ぜられる範囲を定義する。** 「何をしても壊れない」ではなく「これらをしなければ壊れない」を書く。
- **失敗した実行は、再現情報 (seed) と可読な形 (操作の列) の両方で保存する。** 前者だけでは理解できず、後者だけでは再現できない。
- **設定も一緒に保存する。** 同じ seed でも設定が違えば違う実行になる。
- **失敗する入力を自動で縮める。** 素朴な実装でも十分価値がある。「意味のあるまとまり」の単位があると、縮め方の指針になる。
- **仕掛けが本当に機能しているかを、仕掛け自身に検査させる。** 「2 回走らせて一致するか」は、決定性の検査そのものになる。
- **調整用の設定は外部ファイルにし、スキーマを生成する。** 手元の試行錯誤をコミットせずに済み、書き間違いがエディタで分かる。
- **`unsafe` の多いコードは、多様な入力を生成する仕組みと未定義動作の検出器を組み合わせる。** どちらか片方では届く範囲が狭い。
- **必要なフラグには、必要な理由を書く。** 「実験的だから今は切っている」と書いてあれば、将来外せる。
