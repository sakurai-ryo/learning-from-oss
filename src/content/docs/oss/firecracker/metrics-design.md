---
title: "メトリクスを、2 値保持と差分計算でロックフリーにする"
description: "Firecracker のカウンタ SharedIncMetric は AtomicU64 を 2 つ持ち、シリアライズ時に差分を取ってから片方を更新する。これで「flush したらリセット」をライタ側の追加書き込みなしに実現している。ロックを避ける理由、SharedStoreMetric との使い分け、そしてシグナルハンドラから呼ばれるときに残るレースの扱い。"
group: "API と可観測性"
sidebar:
  order: 58
---

## 何を学んだか

### 「flush したらリセット」を、書き込みなしで実現する

Firecracker のメトリクスは 60 秒ごとに JSON の 1 行として吐かれる。カウンタ系のメトリクス（ブロックデバイスの read 回数、API 失敗回数など）は **その 60 秒間の増分** として出る。累積値ではない。

素朴に実装するなら、flush するスレッドが各カウンタに 0 を書き戻す。だがこれは「ホットパスで加算するスレッド」と「60 秒に 1 回リセットするスレッド」の間に同期が要る。`fetch_add` と `store(0)` が競合すれば、加算がまるごと消える。

Firecracker の `SharedIncMetric` は **値を 2 つ持つ。**

```rust
pub struct SharedIncMetric(AtomicU64, AtomicU64);
//                          ^^^^^^^^^ 現在値 (常に fetch_add で増える)
//                                     ^^^^^^^^^ 直前の flush 時点の値
```

シリアライズのときにこうする。

```
snapshot = current.load()
出力     = snapshot - previous.load()
previous.store(snapshot)      ← 成功したときだけ
```

`current` は **誰もリセットしない。** 単調増加しつづける。リセットしたい側が触るのは `previous` だけで、`previous` を触るのは flush スレッド 1 つだけ。**加算側と flush 側が同じワードを奪い合わない。**

この配置には副次的な性質がある。書き込みに失敗（パイプが詰まったなど）したら `previous` を更新しない。次の flush で「前回失敗した分を含む差分」が出る。**flush が数回スキップされてもカウントは失われない。** モジュール冒頭のコメントがこの 2 点をそのまま利点として挙げている。

### 2 種類しかない

| 型                  | 保持            | シリアライズ                     | 使うもの                                                                            |
| ------------------- | --------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `SharedIncMetric`   | `AtomicU64` × 2 | 差分を出して `previous` を進める | 回数（read_count, activate_fails, sigpipe …）                                       |
| `SharedStoreMetric` | `AtomicU64` × 1 | 現在値をそのまま出す             | 時刻・所要時間・0/1 フラグ（process_startup_time_us, latencies_us.*, 致命シグナル） |

`SharedStoreMetric` は `store()` で上書きするだけで、flush してもリセットされない。「今の状態」を表すもの、たとえば「直近の pause 操作に何マイクロ秒かかったか」「SIGSEGV を受けたか（0 か 1）」に使う。

### なぜロックを避けるのか

これらのカウンタは **デバイスエミュレーションのホットパスから叩かれる。** ブロックデバイスがディスクリプタを 1 本処理するたび、ネットデバイスがフレームを 1 つ処理するたびに `inc()` が走る。`Ordering::Relaxed` の `fetch_add` 1 命令であれば、x86 では `lock xadd` 1 つで済む。ここに `Mutex` を置いたら、1 秒に数十万回のロック取得が発生する。

さらに大きい理由がある。**メトリクスは全部グローバルな `static` から触られる。**

```rust
pub static METRICS: Metrics<FirecrackerMetrics, FcLineWriter> = ...;
```

`static mut` ではなく普通の `static` だ。内部可変性（`AtomicU64`）を使っているので `&METRICS` から `inc()` が呼べる。これは「どのスレッドからでも、ロックも参照の受け渡しもなしにカウンタを叩ける」ことを意味する。vCPU スレッドも VMM スレッドも API スレッドも、シグナルハンドラでさえ、同じ `METRICS` を触る。

### flush の経路は 3 つ

```
  ① タイマー (60 秒周期)      PeriodicMetrics (VMM スレッドの epoll)
  ② PUT /actions FlushMetrics API 経由で明示的に
  ③ 異常終了                  シグナルハンドラ / パニックフック
       │
       └──> METRICS.write()
              ├─ metrics_buf (OnceLock<Mutex<LineWriter<File>>>) をロック
              ├─ serde_json::to_writer(&FirecrackerMetrics)
              │    └─ このシリアライズの副作用として SharedIncMetric がリセットされる
              └─ 改行 1 つ
```

**シリアライズ自体が破壊的操作である**ことに注意が要る。`Serialize for SharedIncMetric` のドキュメントコメントは `!!! Any print of the metrics will also reset them. Use with caution !!!` と書いている。デバッグのつもりで `serde_json::to_string(&METRICS)` を呼ぶと、そこでカウンタがリセットされる。

`PeriodicMetrics::start()` はタイマーを仕掛けたあと、**その場で 1 回 flush する。** 目的はコメントに書かれていて、プロセス起動時間 (`process_startup_time_us`) をすぐ観測できるようにするためだ。起動が速いことを売りにする VMM で、最初のメトリクス行が 60 秒後にしか出ないのでは意味がない。

### シグナルハンドラから呼ばれるとレースが残る

`METRICS.write()` は「単一スレッドから呼ばれる前提」で書かれている。だが[致命シグナルのハンドラ](../signal-handling/)は **どのスレッドで走るか分からない。** VMM スレッドが 60 秒タイマーで `write()` している最中に、vCPU スレッドで SIGSEGV が上がってハンドラが `write()` を呼ぶ、ということが起きうる。

`SharedIncMetric` のシリアライズは `load` → `store` の 2 段階で、アトミックではない。2 スレッドが同時にシリアライズすると差分が二重に出たり消えたりする。

Firecracker はこれを **直さずに、範囲を限定した。**

- 致命シグナルのメトリクスは `SharedStoreMetric`（`store(1)` するだけ。シリアライズは単なる `load` でアトミック）にする
- それ以外のメトリクスがシグナル経由の flush で壊れるのは許容する

`SignalMetrics` の doc コメントがこの判断を明記している。そして例外が 1 つある。**`sigpipe` だけが `SharedIncMetric`** だ。SIGPIPE はプロセスを殺さないので、複数回起きうる。0/1 では表せない。

## ソースコードのどこか

### 設計コメント

[`src/vmm/src/logger/metrics.rs#L42-L67`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L42-L67) がこのページの主題をそのまま書いている。

```rust title="src/vmm/src/logger/metrics.rs"
//! # Design
//! The main design goals of this system are:
//! * Use lockless operations, preferably ones that don't require anything other than simple
//!   reads/writes being atomic.
//! * Exploit interior mutability and atomics being Sync to allow all methods (including the ones
//!   which are effectively mutable) to be callable on a global non-mut static.
...
//! The current approach for the `SharedIncMetrics` type is to store two values (current and
//! previous) and compute the delta between them each time we do a flush (i.e by serialization).
//! There are a number of advantages to this approach, including:
//! * We don't have to introduce an additional write (to reset the value) from the thread which does
//!   to actual writing, so less synchronization effort is required.
//! * We don't have to worry at all that much about losing some data if writing fails for a while
//!   (this could be a concern, I guess).
```

最後の一文（`If if turns out this approach is not really what we want, it's pretty easy to resort to something else, while working behind the same interface.`）も残っている。`IncMetric` / `StoreMetric` というトレイトを挟んでいるので実装は差し替え可能だ、という主張だ。

### 2 値の宣言

[`src/vmm/src/logger/metrics.rs#L213-L241`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L213-L241)。タプル構造体の 0 番と 1 番が何かは、コメントでしか示されていない。

```rust title="src/vmm/src/logger/metrics.rs"
// We will be keeping two values for each metric for being able to reset
// counters on each metric.
// 1st member - current value being updated
// 2nd member - old value that gets the current value whenever metrics is flushed to disk
#[derive(Debug, Default)]
pub struct SharedIncMetric(AtomicU64, AtomicU64);
```

同じコメントブロックに、vCPU メトリクス向けにスレッドごとのインスタンスを持って集約する案も書かれている（`this probably overkill unless we have a lot of vCPUs incrementing metrics very often`）。採用されていないが、選択肢として記録されている。

### 加算とシリアライズ

[`L243-L256`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L243-L256)。加算は `Relaxed` の `fetch_add` 1 発。

```rust title="src/vmm/src/logger/metrics.rs"
    // While the order specified for this operation is still Relaxed, the actual instruction will
    // be an asm "LOCK; something" and thus atomic across multiple threads, simply because of the
    // fetch_and_add (as opposed to "store(load() + 1)") implementation for atomics.
    // TODO: would a stronger ordering make a difference here?
    fn add(&self, value: u64) {
        self.0.fetch_add(value, Ordering::Relaxed);
    }
```

`Relaxed` で足りるのは、カウンタが他のデータとの順序関係を持たないからだ。「このカウンタが N なら、あのバッファは書き込み済み」といった依存が無い。コメントに `TODO: would a stronger ordering make a difference here?` が残っているとおり、詰め切ってはいない。

差分計算は [`L270-L283`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L270-L283)。

```rust title="src/vmm/src/logger/metrics.rs"
impl Serialize for SharedIncMetric {
    /// Reset counters of each metrics. Here we suppose that Serialize's goal is to help with the
    /// flushing of metrics.
    /// !!! Any print of the metrics will also reset them. Use with caution !!!
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let snapshot = self.0.load(Ordering::Relaxed);
        let res = serializer.serialize_u64(snapshot - self.1.load(Ordering::Relaxed));

        if res.is_ok() {
            self.1.store(snapshot, Ordering::Relaxed);
        }
        res
    }
}
```

`if res.is_ok()` が「書けなかった分は次に持ち越す」の実装だ。対する `SharedStoreMetric` は [`L285-L289`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L285-L289) で `load` 1 回だけ。副作用が無いのでスレッド安全になる。

### write() に書かれた妥協

[`L132-L163`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L132-L163)。実装より doc コメントのほうが長い。

```rust title="src/vmm/src/logger/metrics.rs"
    /// The only exception is for signal handlers that result in process exit, which may be run on
    /// any thread. To prevent the race condition present in the serialisation step of
    /// SharedIncMetrics, deadly signals use SharedStoreMetrics instead (which have a thread-safe
    /// serialise implementation).
    /// The only known caveat is that other metrics may not be properly written before exiting from
    /// a signal handler. We make this compromise since the process will be killed anyway and the
    /// important metric in this case is the signal one.
    /// The alternative is to hold a Mutex over the entire function call, but this increases the
    /// known deadlock potential.
```

「Mutex を関数全体にかければ直るが、デッドロックの可能性が増える」——シグナルハンドラの中でロックを取るのが危険だという判断が、そのまま型の選択（`SharedStoreMetric`）に降りている。

対応する `SignalMetrics` は [`L713-L733`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L713-L733)。

```rust title="src/vmm/src/logger/metrics.rs"
/// Metrics related to signals.
/// Deadly signals must be of `SharedStoreMetric` type, since they can ever be either 0 or 1.
/// This avoids a tricky race condition caused by the unatomic serialize method of
/// `SharedIncMetric`, between two threads calling `METRICS.write()`.
#[derive(Debug, Default, Serialize)]
pub struct SignalMetrics {
    pub sigbus: SharedStoreMetric,
    pub sigsegv: SharedStoreMetric,
    pub sigxfsz: SharedStoreMetric,
    pub sigxcpu: SharedStoreMetric,
    pub sigpipe: SharedIncMetric,
    pub sighup: SharedStoreMetric,
    pub sigill: SharedStoreMetric,
}
```

（doc コメントは元コードでは各フィールドにも付いている。ここでは型の並びを見せるために省いた。）

### 60 秒タイマー

[`src/firecracker/src/metrics.rs#L13`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/metrics.rs#L13) に `WRITE_METRICS_PERIOD_MS: u64 = 60000`。`PeriodicMetrics` は `timerfd` を 1 本持つだけの `MutEventSubscriber` で、VMM スレッドの epoll に登録される。

```rust title="src/firecracker/src/metrics.rs"
    pub(crate) fn start(&mut self, interval_ms: u64) {
        // Arm the log write timer.
        let duration = Duration::from_millis(interval_ms);
        self.write_metrics_event_fd.arm(duration, Some(duration));

        // Write the metrics straight away to check the process startup time.
        self.write_metrics();
    }

    fn write_metrics(&mut self) {
        if let Err(err) = METRICS.write() {
            METRICS.logger.missed_metrics_count.inc();
            error_unrestricted!("Failed to write metrics: {}", err);
        }
        ...
    }
```

flush に失敗したら `missed_metrics_count` を増やす。**メトリクス機構の失敗そのものをメトリクスで数えている。** 次に成功したときに、何回落としたかが分かる。

`start()` が呼ばれるのは [`api_server_adapter.rs#L260-L263`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/api_server_adapter.rs#L260-L263) で、microVM のビルドが終わって seccomp フィルタを適用した直後だ。起動前にはタイマーが動かない。

### 出力の形

`FirecrackerMetrics`（[`L988-L1049`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L988-L1049)）が JSON のトップレベル構造そのものだ。先頭が必ず `utc_timestamp_ms` で、そのあとにコンポーネントごとのオブジェクトが並ぶ。

```json
{
  "utc_timestamp_ms": 1541591155180,
  "api_server": { "process_startup_time_us": 0, "process_startup_time_cpu_us": 0 },
  "block": { "activate_fails": 0, "read_count": 0, "write_count": 0, ... }
}
```

デバイスごとのメトリクスは `#[serde(flatten)]` された「シリアライズプロキシ」構造体を通る。これがあるおかげで、**デバイスインスタンスごとのキーを動的に生やせる。** `docs/metrics.md` の表によれば、

- `block` — 全 virtio-block デバイスの集約
- `block_rootfs` — `/drives/rootfs` に対応する個別のデバイス
- `net_eth0` — `/network-interfaces/eth0` に対応する個別のデバイス
- `vhost_user_block_rootfs` — vhost-user 版

という命名になる。デバイスが 1 つも付いていなくても、キーは 0 で出る。`docs/metrics.md` は `Firecracker emits all the above metrics regardless of the presense of that component` と明記している。**行のスキーマが実行時の構成に依存しない**ので、収集側がパースを固定できる。

単位は名前に埋め込む規約になっている（`_bytes` ならバイト、`_ms` ならミリ秒、`_us` ならマイクロ秒、それ以外は回数）。別途メタデータを持たない。

## なぜそうなっているか

### 設計ゴールが「ロックレス」から降りてきている

冒頭のコメントは目標を 4 つ挙げているが、実質は 2 つだ。**「単純な read/write のアトミック性だけに頼る」**と**「グローバルな非 mut static から呼べる」**。この 2 つを満たす型を作ろうとすると、`AtomicU64` の組み合わせしか残らない。2 値保持はその制約下で「リセット」を表現する方法として出てきている。

言い換えると、この設計は **メトリクスが「観測のために存在するので、観測のコストが観測対象を歪めてはいけない」**という要求から来ている。[Firecracker のミニマリズム憲章](../minimalism-charter/)が性能に厳しい以上、デバイスのホットパスにロックを入れる選択は取れない。

### 「壊れうる」ことを消さずに囲った

シグナルハンドラ経由の flush でレースが残ることを、Firecracker はコメントに書いて残している。直さない理由も書いてある。

1. どうせプロセスは死ぬ
2. そのとき重要なのは「どのシグナルで死んだか」だけ
3. 直す（全体を Mutex で囲む）とデッドロックのリスクが増える

シグナルハンドラの中でロックを取ることの危険は現実的で、たとえばメイン処理が `metrics_buf` の `Mutex` を保持した状態で SIGSEGV を受けたら、ハンドラが同じ Mutex を待って永久に止まる。プロセスは死ぬこともログを出すこともできなくなる。**`Mutex::lock()` は非同期シグナルセーフではない**（POSIX の async-signal-safe 関数リストに入っていない）。

現実には `METRICS.write()` はその Mutex を取るので、この危険は完全には消えていない。消えているのは「シリアライズ中の `load`/`store` レースによって、致命シグナルの記録そのものが失われる」ケースだけだ。**守りたいものを 1 つに絞って、それだけを型で保証している。**

### `#[serde(flatten)]` プロキシの理由

デバイスは実行時に増える（`PUT /drives/foo` で 1 つ増える）。コンパイル時に構造体のフィールドとして書けない。かといって `HashMap<String, DeviceMetrics>` をトップレベルの 1 フィールドにすると、JSON がネストして `{"devices": {"block_rootfs": ...}}` になってしまい、既存の出力形式と互換でなくなる。

プロキシ構造体（フィールドを持たないユニット構造体に `Serialize` を手で実装したもの）を `#[serde(flatten)]` することで、**静的なフィールドと動的なキーが同じ階層に並ぶ。** メトリクス収集側から見れば、フラットな 1 階層のマップに見える。

## どう活かすか

### 使いどころ

**「ホットパスから叩かれるカウンタを、別スレッドが定期的に吸い出す」**構造にそのまま効く。2 値保持のポイントは次の 2 つに集約される。

1. **加算側が触るワードと、リセット側が触るワードを分ける。** 加算側は `current` だけ、flush 側は `previous` だけ。両者が CAS で奪い合うことがない。
2. **リセットを「引き算」に置き換える。** 出力は差分、状態更新は `previous` の前進のみ。加算を 1 回も落とさない。

Prometheus のクライアントライブラリが「カウンタは単調増加、レートはサーバ側で計算」としているのと発想は同じで、Firecracker は差分計算をプロセス内でやっているだけだ。

もう 1 つ真似できるのは **「観測機構自身の失敗を観測する」**こと。`missed_metrics_count`、`missed_log_count`、`rate_limited_log_count` はいずれも「メトリクス／ログが出せなかった回数」を数えている。出力が届いていないことは、出力を見ているだけでは分からない。次に届いたときに分かる形にしておく。

### 取り込むべきでない条件

- **正確な累積値が要るとき。** この方式は「差分の列」を出すので、収集側が 1 行落とすとその分が永久に失われる。累積値なら 1 行落としても次の行で復旧できる。ログ配送が信頼できないなら、`SharedStoreMetric` 側（累積を出す）に寄せるべきだ。
- **flush が複数スレッドから走りうるとき。** Firecracker が許容しているレースは「どうせプロセスが死ぬ」という前提の上にある。定常状態で複数スレッドが flush する設計なら、`previous` の更新を CAS にするか、素直にロックを取る必要がある。
- **カウンタが数十個しかないとき。** `Mutex<HashMap<&str, u64>>` で足りる。2 値保持は「型を 2 つ作り、シリアライズを手書きし、リセットの副作用をコメントで警告する」というコストを払う。ホットパスでの `inc()` が毎秒数万回に達しないなら、割に合わない。
- **シリアライズが副作用を持つことを許せないとき。** `serde_json::to_string(&METRICS)` がカウンタをリセットするのは、率直に言って驚きのある挙動だ。Firecracker はコメントで `Use with caution` と警告するに留めている。テストコードやデバッグ出力で誤って呼びうるコードベースなら、`flush()` のような明示的なメソッドに分けたほうが安全だ。

### 実装時の細かい注意

- **`Relaxed` で足りるのは、カウンタが他のデータと順序関係を持たない場合だけ。** 「カウンタが N になったらバッファが有効」のような依存があるなら `Release`/`Acquire` が要る。Firecracker はそれが無いことを前提に `Relaxed` を選んでいる。
- **`static` を `const fn` で初期化できるようにしておく。** `SharedIncMetric::new()` も `FirecrackerMetrics::new()` も `const fn` で、遅延初期化（`lazy_static` / `OnceLock`）を通らない。初回アクセスの分岐が消えるうえ、シグナルハンドラから触っても「まだ初期化されていない」状態が存在しない。
- **出力先だけは遅延初期化する。** `metrics_buf` は `OnceLock<Mutex<M>>` で、[起動前の API](../api-state-machine/)（`PUT /metrics`）が呼ばれるまで空だ。未初期化のときは `write()` がエラーではなく `Ok(false)` を返す。「メトリクス出力が設定されていない」は異常ではない、という扱いになっている。
