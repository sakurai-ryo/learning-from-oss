---
title: "決定論の境界を lint で強制し、テストには壊し方を植えておく"
description: "時計・乱数・スレッド起動・ファイル I/O を `asyncrt` という 1 モジュールに集め、clippy.toml で直接呼び出しを禁止する。シミュレータはこのモジュールを差し替えて動く。本番コードには「わざと壊す」フックを残し、テストが壊れたプロトコルを検出できることを確かめる。"
group: "テスト"
sidebar:
  order: 7
---

## 何を学んだか

### どんな状況の話か

[決定コア](../decision-core/) を純粋関数にしても、それを呼び出す側 (I/O を担当する層) がどこかで `Instant::now()` や `tokio::spawn` を直接呼んだら、その瞬間にテストの再現性は壊れる。「時計は必ずこの関数経由で」という規約は、誰かが便利さから直接呼んだ時点で破れる。

もう 1 つ。競合バグを検出するテストを書いても、そのテストが**本当に検出できるのか**は別問題だ。壊れたプロトコルに対して緑のままのテストは、無いのと同じかそれより悪い (安心させるぶん)。

### celld の答え

決定論 (同じ入力なら同じ結果) を守る仕組みが 3 つある。

1. **実行ファサード `asyncrt`**: スレッド起動、sleep、select、壁時計、単調時計、乱数、プロセス ID、ファイルシステムを全部この 1 モジュール経由にする。
2. **`clippy.toml` の禁止リスト**: `tokio::spawn`、`SystemTime::now`、`rand::random`、`std::fs::*` などの直接使用を lint で禁止し、CI を `-D warnings` で落とす。境界の外で動くモジュールだけが、理由を書いて `#[allow]` する。
3. **差し替え口**: テストビルドでは `asyncrt` を `include!(env!("CELLD_INTERNAL_ASYNCRT"))` で外部ファイルに置き換える。決定論的シミュレータ (celld は "the World" と呼ぶ) はこの経路で、全てのスケジュール点を握る。

そして**テスト自身をテストする**ために、本番のコードに `EngineSabotage` という「わざと壊す」フックを 25 箇所植えてある。フックを有効にしてテストを走らせ、テストが赤くなることを確認する。

なお、シミュレータ本体・TLA+ 仕様・workerd との差分テストは公開リポジトリに**含まれていない**。公開されているのは継ぎ目だけだが、それ自体が設計として読める。

## ソースコードのどこか

### 実行ファサード

[`crates/celld/asyncrt.rs#L8-L12`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/asyncrt.rs#L8-L12)。

```rust title="crates/celld/asyncrt.rs"
//! The production execution facade for celld.
//!
//! This module delegates tasks and timers to Tokio and obtains nondeterministic
//! process values from the host. The private conformance build replaces this
//! module with its deterministic execution backend.
```

乱数の関数はラベルを受け取る ([`asyncrt.rs#L160-L163`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/asyncrt.rs#L160-L163))。本番は無視するが、シミュレータはラベルごとにシード済みの乱数列を渡せる。

```rust title="crates/celld/asyncrt.rs"
pub fn rng(consumer: &'static str) -> rng::Stream {
    let _ = consumer;
    rng::Stream::production()
}
```

### 差し替え口

[`crates/celld/lib.rs#L43-L50`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/lib.rs#L43-L50)。

```rust title="crates/celld/lib.rs"
#[cfg(not(all(test, celld_internal_tests)))]
pub mod asyncrt;
#[cfg(all(test, celld_internal_tests))]
#[allow(clippy::disallowed_methods, clippy::disallowed_types)]
#[warn(clippy::disallowed_macros)]
pub mod asyncrt {
    include!(env!("CELLD_INTERNAL_ASYNCRT"));
}
```

普通のビルドでは `asyncrt.rs` を使い、内部テストビルドでは環境変数が指すファイルの中身をそのまま埋め込む。同じ形で SQLite の障害注入 ([`lib.rs#L62-L67`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/lib.rs#L62-L67))、テスト群 ([`lib.rs#L89-L156`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/lib.rs#L89-L156))、Web Platform Tests ([`crates/celld/js.rs#L6245-L6262`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/js.rs#L6245-L6262)) が注入される。

### 境界 lint

[`clippy.toml#L1-L85`](https://github.com/denoland/celld/blob/v0.3.0/clippy.toml#L1-L85)。全エントリに「代わりに何を使うか」が書いてある。

```toml title="clippy.toml"
# The execution boundary must use celld::asyncrt. Modules which never execute
# in the World carry an explicit lint allow and are listed in the S0 audit.
disallowed-methods = [
  { path = "tokio::spawn", reason = "use celld::asyncrt::spawn inside the World boundary" },
  { path = "tokio::time::sleep", reason = "use celld::asyncrt::sleep inside the World boundary" },
  { path = "std::time::SystemTime::now", reason = "use the execution-domain wall clock inside the World boundary" },
  { path = "std::time::Instant::now", reason = "use the execution-domain monotonic clock inside the World boundary" },
  { path = "rand::random", reason = "use a labeled execution-domain RNG inside the World boundary" },
  { path = "std::process::id", reason = "use the execution-domain process tag inside the World boundary" },
  { path = "std::fs::read", reason = "use the injected whole-node filesystem for celld node storage" },
  # ...
]
disallowed-macros = [
  { path = "tokio::select", reason = "use celld::asyncrt::select with a declared priority inside the World boundary" },
]
disallowed-types = [
  { path = "rand::rngs::OsRng", reason = "use a labeled execution-domain RNG inside the World boundary" },
]
```

境界の外のモジュールは、先頭で理由を書いて allow する。例: [`crates/celld/main.rs#L3-L5`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L3-L5) "The binary is now connection, startup, shutdown, and V8 shell code. The World boundary lives in the library Actor and its domain-routed adapters."、[`crates/celld/memory.rs#L30`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/memory.rs#L30) `#[allow(clippy::disallowed_methods)] // /proc is host telemetry, not node storage.`。[`Dockerfile#L34`](https://github.com/denoland/celld/blob/v0.3.0/Dockerfile#L34) の `cargo clippy --all-targets --locked -- -D warnings` が強制する。

`tokio::select!` (複数の非同期処理のうち先に終わったものを処理するマクロ) すら禁止で、[`crates/celld/lib.rs#L12-L39`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/lib.rs#L12-L39) の優先順位が固定された 2-way select に置き換えている。`tokio::select!` は複数が同時に準備完了のときどれを選ぶかがランダムなので、それだけで決定論が壊れるからだ。

### 壊し方を植える: `EngineSabotage`

[`crates/celld/host_services.rs#L15-L47`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/host_services.rs#L15-L47)。

```rust title="crates/celld/host_services.rs"
/// Test-only faults planted in production adapter transitions. Each value is
/// scoped to one simulation domain, so parallel corpus tests cannot arm one
/// another's teeth.
#[cfg(all(test, celld_internal_tests))]
pub enum EngineSabotage {
    SuppressResetStop,
    CoverTicketEarly,
    MisreportGatePosition,
    RestoreSupersededEpoch,
    FreshCreateOverwrites,
    DropCompactionInput,
    HideDirtyCell,
    DropTimerArm,
    IgnoreTookOver,
    // ...
    SkipActivationFenceCas,
    SkipAlarmWriteGate,
}
```

植え込み点の例。条件付き作成を無条件の上書きに変える ([`crates/celld/bucket.rs#L529-L537`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/bucket.rs#L529-L537))、複製済みの位置を 1 だけ少なく報告する ([`crates/celld/actor.rs#L2248-L2255`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L2248-L2255))、アラームの出力ゲートを飛ばす ([`actor.rs#L2398-L2413`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L2398-L2413))。最後のコメントが、celld がこれを「歯 (tooth)」と呼ぶ理由を説明している。

```rust title="crates/celld/actor.rs"
// The tooth for the gate the core opens below. It
// restores the shape this change replaced: prove the
// commit here, privately, and tell the core nothing —
// so the proof still runs, and every reader of the
// cell is still released against it.
#[cfg(all(test, celld_internal_tests))]
let result = if crate::asyncrt::sabotage_active(
    crate::host_services::EngineSabotage::SkipAlarmWriteGate,
) {
```

「この変更が置き換えた、以前の (間違っていた) 形を復元する」フックだ。つまり過去に実際にあったバグを、スイッチ 1 つで再現できる形で残し、テストがそれを噛める (検出できる) ことを確かめている。[`crates/celld/node_log.rs#L1948-L1972`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/node_log.rs#L1948-L1972) の `FilterRecoveryBundlesByRecordEpoch` も同様。`#[cfg(not(...))]` 側は常に `false` を返すので、本番バイナリには壊す経路が残らない。

TLA+ のモデル検査にも同じ発想がある。[`crates/logic/lib.rs#L2015-L2019`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L2015-L2019) の `BrokenLeaseRenewalDropsLog is the spec tooth`。[`docs/testing.md`](https://github.com/denoland/celld/blob/v0.3.0/docs/testing.md) によれば、モデル検査の設定の大半は「失敗が期待される」設定で、失敗しなくなった設定は "lost its tooth" (歯が抜けた) とみなす。

### 静かに成功するテストを拒否する

[`crates/celld/js/node_test.js#L6-L8`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/js/node_test.js#L6-L8) は `node:test` の `test`/`describe`/`it` をわざと throw させる。"a silently-skipped test reports success while asserting nothing, which is the failure mode this module exists to avoid" — 何も検証せずに成功と報告するテストこそ、このモジュールが防ぎたい失敗だ、と。

## なぜそうなっているか

- **境界は規約では守れない。** lint に `reason` を持たせて CI で落とせば、破るには明示的な `#[allow]` と理由が必要になる。allow したモジュールの一覧が "S0 audit" として管理される。
- **シミュレータは非公開でも継ぎ目は公開できる。** `include!(env!(...))` は、テスト群をリポジトリの外に置きながら、本番コードの構造をそれに合わせられる。公開コードだけを読んでも「どこが差し替え可能か」が分かる。
- **検出器は失敗できなければ意味がない。** [`docs/testing.md`](https://github.com/denoland/celld/blob/v0.3.0/docs/testing.md) "Simulation has a known failure mode: the checker that cannot fail. ... A suite that stays green against a broken protocol is a broken suite." 壊し方を本番コードのすぐ隣に植えておけば、リファクタで経路が変わっても歯が一緒に動く。
- **TLA+ は CI に入れない。** "a silently stale gate is worse than none" — 手動で同期するスナップショットにして、モデルとコードの差分は台帳に記録する。CI に入れて古くなったまま緑を出すより、入れない方が誠実だという判断。

## どう活かすか

- テストで差し替えたい副作用 (時計、乱数、スレッド起動、ファイル、ネットワーク) は 1 モジュールに集め、直接呼び出しを lint で禁止する。Rust なら `clippy.toml` の `disallowed-methods`、他の言語でも ESLint の `no-restricted-imports` や ArchUnit で同じことができる。各禁止に「代わりに何を使うか」を書く。
- 境界の外にいるモジュールは、先頭で「なぜ外か」を書いて opt-out する。opt-out の一覧を監査対象にする。
- 「テストのテスト」を持つ。過去に見つけたバグをフラグで再現できる形で本番コードに残し、テストがそれを検出することを別のテストで確かめる。バグ修正の PR に「壊した状態でテストが赤くなる」証拠を含める習慣と相性が良い。
- テストフレームワークの「スキップ」「未実装」が静かに緑にならないようにする。スキップはログに出し、必須の環境では失敗させる ([差分オラクル](../differential-oracle/) の `CELLD_LTX_LITESTREAM_REQUIRED` も同じ)。
- 取り込むべきでない条件: 副作用を 1 箇所に集める価値は、決定論的テストを実際に書くときに生まれる。そのテストを持つ予定がなければ、ファサードは単なる間接層になる。
