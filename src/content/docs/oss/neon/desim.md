---
title: "desim — 決定的シミュレーションでコンセンサスを殴る"
description: "仮想時間・仮想ネットワーク・仮想ディスクの上で、本番と同じ C のコードを走らせる。500 個のランダムなシードで、ネットワーク分断とクラッシュを混ぜた日程表を実行し、ログから不変条件を検証する。"
group: "検証と運用"
sidebar:
  order: 55
---

## 何を学んだか

```markdown title="libs/desim/README.md"
# Discrete Event SIMulator

This is a library for running simulations of distributed systems. The main idea is borrowed from [FoundationDB](https://www.youtube.com/watch?v=4fFDFbi3toc).

Each node runs as a separate thread. This library was not optimized for speed yet, but it's already much faster than running usual intergration tests in real time, because it uses virtual simulation time and can fast-forward time to skip intervals where all nodes are doing nothing but sleeping or waiting for something.

The original purpose for this library is to test walproposer and safekeeper implementation working together, in a scenarios close to the real world environment. This simulator is determenistic and can inject failures in networking without waiting minutes of wall-time to trigger timeout, which makes it easier to find bugs in our consensus implementation compared to using integration tests.
```

([libs/desim/README.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/desim/README.md))

**手本は FoundationDB。** 出典の動画リンク付きで書かれている。

動機が明快だ。**合意プロトコルのバグは、タイムアウトが絡む異常系にしか出ない。** 実時間の統合テストでそれを再現しようとすると、1 ケースに数分かかる。そして再現しない。

## 3 つを仮想化する

**1. 時間。**

```rust title="libs/desim/src/time.rs"
/// Holds current time and all pending wakeup events.
pub struct Timing {
    /// Current world's time.
    current_time: AtomicU64,
    /// Pending timers.
    queue: Mutex<BinaryHeap<Pending>>,
    /// Global nonce. Makes picking events from binary heap queue deterministic
    /// by appending a number to events with the same timestamp.
    nonce: AtomicU32,
    /// Used to schedule fake events.
    fake_context: Arc<ThreadContext>,
}
```

([libs/desim/src/time.rs L12](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/desim/src/time.rs#L12))

**時刻は数値で、全員が同じものを見る。** 全スレッドがスリープに入ったら、次のタイマーの時刻まで一気に飛ばす。**「30 秒のタイムアウトを待つ」が一瞬で終わる。**

`nonce` が要点だ。**同じ時刻のイベントが複数あると、ヒープからの取り出し順が非決定的になる。** 通し番号を付けて全順序にする。

**決定性は、この手の細部の積み重ねで壊れる。** ハッシュマップの反復順、スレッドのスケジューリング、同時刻のイベント。1 か所でも漏れると再現しなくなる。

**2. ネットワーク。**

```rust title="libs/desim/src/options.rs"
/// Describes random delays and failures. Delay will be uniformly distributed in [min, max].
/// Connection failure will occur with the probablity fail_prob.
pub struct Delay {
    pub min: u64,
    pub max: u64,
    pub fail_prob: f64, // [0; 1]
}
```

```rust title="libs/desim/src/options.rs"
pub struct NetworkOptions {
    pub keepalive_timeout: Option<u64>,
    pub connect_delay: Delay,
    pub send_delay: Delay,
}
```

([libs/desim/src/options.rs L5](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/desim/src/options.rs#L5))

**接続の遅延と送信の遅延を別々に設定できる。** そして各パラメータに失敗確率がある。

`NetworkTask` はメッセージを最小ヒープで管理し、仮想時刻に応じて配送する。

```rust title="libs/desim/src/network.rs"
pub struct NetworkTask {
    options: Arc<NetworkOptions>,
    connections: Mutex<Vec<VirtualConnection>>,
    /// min-heap of connections having something to deliver.
    events: Mutex<BinaryHeap<Event>>,
    task_context: Arc<ThreadContext>,
}
```

([libs/desim/src/network.rs L18](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/desim/src/network.rs#L18))

**メッセージの再順序化も、遅延の分布から自然に出てくる。** 明示的に「並べ替える」コードは要らない。

**3. ディスクとプロセス。**

```rust title="libs/desim/src/executor.rs"
    pub fn crash_all_threads(&mut self) {
```

([libs/desim/src/executor.rs L46](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/desim/src/executor.rs#L46))

**全スレッドを「クラッシュ」させられる。** `safekeeper_disk.rs` と `walproposer_disk.rs` が仮想ディスクを提供し、クラッシュ後に「fsync していないものは消える」を再現する。

## 本番と同じコードを走らせる

これが最大の要点になる。シミュレータが動かすのは、**本番と同じ `safekeeper.rs` と、本番と同じ `walproposer.c`** だ。

safekeeper 側は Rust なので、`wal_storage::Storage` と `control_file::Storage` のトレイトを仮想実装に差し替えるだけでいい。

walproposer 側は C だが、[walproposer](../walproposer-in-compute/) で見た `walproposer_api` の vtable がある。Rust 側の実装 (`walproposer_api.rs`) がそれを埋める。

**「テストのために書き直す」のではなく「外界との境界を差し替える」。** 検証しているのが本番のコードそのものであることが保証される。

## 500 個のシードを回す

```rust title="safekeeper/tests/random_test.rs"
// Generates 500 random seeds and runs a schedule for each of them.
// If you see this test fail, please report the last seed to the
// @safekeeper team.
#[test]
fn test_random_schedules() -> anyhow::Result<()> {
    let clock = init_logger();
    let mut config = TestConfig::new(Some(clock));

    for _ in 0..500 {
        let seed: u64 = rand::rng().random();
        config.network = generate_network_opts(seed);

        let test = config.start(seed);
        warn!("Running test with seed {}", seed);

        let schedule = generate_schedule(seed);
        test.run_schedule(&schedule).unwrap();
        validate_events(test.world.take_events());
        test.world.deallocate();
    }

    Ok(())
}
```

([safekeeper/tests/random_test.rs L10](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/tests/random_test.rs#L10))

**シード 1 つから、ネットワークの設定も実行の日程表も全部生成する。** シードさえあれば完全に再現できる。

そして再現用のテストが隣にある。

```rust title="safekeeper/tests/random_test.rs"
// After you found a seed that fails, you can insert this seed here
// and run the test to see the full debug output.
#[test]
fn test_one_schedule() -> anyhow::Result<()> {
    let clock = init_tracing_logger(true);
    let mut config = TestConfig::new(Some(clock));

    let seed = 11047466935058776390;
```

([safekeeper/tests/random_test.rs L34](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/tests/random_test.rs#L34))

**「失敗したシードをここに入れて、詳細ログ付きで再実行しろ」。** そして例のシードがハードコードされたまま残っている。過去に見つかったバグの記録になっている。

**ワークフローがコードとして残っている**のが要点だ。ランダムテストで見つけたバグを調べる手順が、コメント 2 行と関数 1 つになっている。

## 検証は「ログの妥当性」でやる

シミュレーションの結果をどう検証するか。**内部状態を覗くのではなく、ログを解析する。**

```rust title="safekeeper/tests/walproposer_sim/simulation_logs.rs"
/// Simulation state of walproposer/safekeeper, derived from the simulation logs.
struct NodeInfo {
    kind: NodeKind,

    // walproposer
    is_sync: bool,
    term: u64,
    epoch_lsn: u64,

    // safekeeper
    commit_lsn: u64,
    flush_lsn: u64,
}
```

([safekeeper/tests/walproposer_sim/simulation_logs.rs L18](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/tests/walproposer_sim/simulation_logs.rs#L18))

**ログから状態を再構築し、そこに不変条件を課す。**

```rust title="safekeeper/tests/walproposer_sim/simulation_logs.rs"
                    "prop_elected" => {
                        /* ... */
                        assert!(prop_lsn >= prev_lsn);
                        assert!(prop_term >= prev_term);

                        assert!(prop_lsn >= state.commit_lsn);
```

```rust title="safekeeper/tests/walproposer_sim/simulation_logs.rs"
                    "commit_lsn" => {
                        let lsn: u64 = parts.next().unwrap().parse().unwrap();
                        assert!(lsn >= state.commit_lsn);
                        state.commit_lsn = lsn;
                    }
```

([safekeeper/tests/walproposer_sim/simulation_logs.rs L121](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/tests/walproposer_sim/simulation_logs.rs#L121))

**検証している不変条件はこれだけだ。**

- **選出される LSN は、コミット済みの LSN 以上** ← コミット済みデータを切り詰めない
- **commit_lsn は単調増加** ← コミットが取り消されない
- **term は単調増加**

**合意プロトコルの安全性が、この 3 つに凝縮されている。** 500 回のランダムな障害シナリオで、この 3 つが破れないことを確かめている。

ログ形式が `;` 区切りのテキストなのも意図的で、**シミュレーション中に構造化データを持ち回らずに済む。** イベントは文字列として記録され、あとでパースされる。

TODO も残っている。

```rust
                        // TODO: If we allow writing WAL before winning the election
                        assert!(start_lsn >= state.commit_lsn);
                        // assert!(start_lsn == state.write_lsn);
```

**コメントアウトされた assert がある。** 現在の実装では成立しないが、成立すべきかもしれない条件。**「まだ検証していないこと」が可視化されている。**

## パニックフックの入れ替え

```rust title="safekeeper/tests/walproposer_sim/simulation_logs.rs"
    let hook = std::panic::take_hook();
    scopeguard::defer_on_success! {
        std::panic::set_hook(hook);
    };
```

**検証中はパニックフックを外し、成功したら戻す。** シミュレータはスレッドのパニックを制御された形で扱う (クラッシュの再現に使う) ので、検証時の assert 失敗と混ざらないようにしている。

`defer_on_success!` なので、**パニックしたときは戻さない。** そうすることで、失敗時のバックトレースが元のフック (通常の表示) で出る。

## 速度についての正直さ

```markdown title="libs/desim/README.md"
This library was not optimized for speed yet, but it's already much faster than running usual intergration tests in real time
```

**「まだ最適化していないが、それでも実時間の統合テストより十分速い」。**

スレッドを本物の OS スレッドとして作り、ロックで同期を取る実装になっている。FoundationDB のような単一スレッドの決定的実行ではない。それでも、**時間を飛ばせることの効果が大きすぎて、他の非効率が問題にならない。**

「どこを最適化すべきか」の判断として、正しい優先順位付けになっている。

## この先に効いてくること

- **異常系のテストには、時間とネットワークの仮想化が要る。** タイムアウトを待たない。
- **決定性は細部の積み重ね。** 同時刻イベントの通し番号まで。
- **テストのために書き直さず、外界との境界を差し替える。**
- **不変条件は少数に絞れる。** 合意の安全性は 3 つの assert で表せた。
- **失敗したシードを再現する手順を、コードとして残す。**
