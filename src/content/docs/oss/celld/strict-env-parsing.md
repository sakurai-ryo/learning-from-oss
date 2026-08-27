---
title: "環境変数は起動時に一括検証し、不正値は既定値に落とさず停止する"
description: "未設定なら既定値、設定されていれば厳密に妥当な値だけを受け付ける。Boolean は `0`/`1` のみ。値を使う場所でエラーを返せないケースがあるので、起動時に全変数を検証し、以後の読み取りは失敗しない前提で書く。"
group: "日常のエンジニアリング"
sidebar:
  order: 10
---

## 何を学んだか

### どんな状況の話か

設定の読み取りでよく見る書き方がある。

```rust
let ttl = env::var("CELLD_TTL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(10_000);
```

`CELLD_TTL_MS=10s` と書き間違えると、パースに失敗して黙って 10000 になる。運用者は 10 秒のつもりで、実際も 10 秒なので気づかない。しかし `CELLD_TTL_MS=3000O` (末尾がゼロでなくオー) なら、3 秒のつもりが 10 秒で動く。分散システムのリースの長さがこっそり変わるのは、かなり嫌な事故だ。

### celld の答え

1. **未設定と不正値を区別する。** 未設定は既定値、不正値はエラーで起動しない。
2. **Boolean は `0` と `1` だけ。** `true`/`yes`/`on` のような寛容な解釈をしない。
3. **起動時に全変数を検証する。** 値を使う場所によっては (V8 のコールバックの中など) エラーを返せない。だから `main` の最初に一括で検証し、以後の読み取りは「検証済み」を前提に `expect` で書く。

## ソースコードのどこか

### モジュールの方針

[`crates/celld/env_vars.rs#L3-L7`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/env_vars.rs#L3-L7)。

```rust title="crates/celld/env_vars.rs"
//! Strict runtime environment parsing.
//!
//! An unset variable selects its caller's documented default. A supplied
//! variable must contain a valid value, so a typo cannot silently change the
//! configuration of a running node.
```

### Boolean

[`env_vars.rs#L95-L102`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/env_vars.rs#L95-L102)。

```rust title="crates/celld/env_vars.rs"
pub fn parse_flag(name: &str, value: Option<&str>, default: bool) -> anyhow::Result<bool> {
    match value {
        None => Ok(default),
        Some("0") => Ok(false),
        Some("1") => Ok(true),
        Some(other) => bail!("{name} must be 0 or 1, not {other:?}"),
    }
}
```

[`env_vars.rs#L82-L88`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/env_vars.rs#L82-L88) の `value()` は、「変数が存在しない」だけを `None` にし、UTF-8 でない値などはエラーにする。[`env_vars.rs#L142-L154`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/env_vars.rs#L142-L154) の `parse_positive` は 0 を `"{name} must be greater than zero, not {value}"` で拒否する。

### 起動時の一括検証

[`env_vars.rs#L11-L16`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/env_vars.rs#L11-L16)。

```rust title="crates/celld/env_vars.rs"
/// Validate every typed production variable before the runtime starts.
///
/// Some consumers cache a value or read it from a synchronous callback, so
/// they cannot return a configuration error at the point of use. This pass
/// makes those reads infallible without giving malformed values a default.
pub fn validate() -> anyhow::Result<()> {
```

中身は Boolean の一覧、正の整数の一覧、省略可能な整数の一覧、範囲チェック (`CELLD_PRESENCE_HEARTBEAT_MS` は 50 以上 30000 以下)、選択肢チェック (`CELLD_PRESSURE_OWNERSHIP must be release or sticky`) を順に回す。[`crates/celld/main.rs#L1972-L1976`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L1972-L1976) で `main` の最初の行として呼ばれる。

利用側は検証済みを前提にできる ([`crates/celld/control_plane.rs#L42-L45`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/control_plane.rs#L42-L45))。

```rust title="crates/celld/control_plane.rs"
flag("CELLD_CLOUD_RESTART_ON_DEPLOY", true).expect("validated CELLD_CLOUD_RESTART_ON_DEPLOY")
```

`expect` は失敗したら panic するが、起動時に検証済みなのでここで失敗することはない。メッセージに "validated" と書くことで、その前提を読み手に伝えている。

### CLI と環境変数の対応

[`crates/celld/main/cli.rs#L3-L8`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main/cli.rs#L3-L8): "Parsing answers one question — which `Action` to take — and refuses anything ambiguous rather than guessing. The help text is the public description of the configuration surface, so a test asserts on it." clap のようなライブラリを使わず手書きで、環境変数を先に読んでからコマンドライン引数で上書きする。相互に依存する設定のエラーは両方の綴りを出す ([`cli.rs#L199-L210`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main/cli.rs#L199-L210))。

```rust title="crates/celld/main/cli.rs"
"a non-loopback --listen or CELLD_ADDR requires an explicit --internal-listen or \
 CELLD_INTERNAL_ADDR; celld does not reuse the public Worker listener for peers"
```

## なぜそうなっているか

- **設定ミスは静かに広がる。** 上の `3000O` の例のように、既定値に落ちる方向によっては誰も気づかない。どちらに落ちるかを運用者が覚えるより、全部止める方が単純。
- **値を使う場所ではエラーを返せないことがある。** 使う場所で検証すると、`Result` を返せない経路 (V8 のコールバック、キャッシュの初期化) では `unwrap` か既定値のどちらかを選ばされる。起動時に一括検証すれば、その場所での `expect` が正当化される。
- **ヘルプは契約。** 設定項目の公式な一覧をヘルプに置き、テストでその内容を検証することで、環境変数の追加がヘルプの更新を伴うよう強制する。

## どう活かすか

- 設定のパースで `unwrap_or(default)` を書く前に、「未設定」と「不正」を分ける。不正は起動を止める。
- Boolean の受け付け形式を 1 つに絞る。寛容にすると `"False"` が真扱いされる類の事故が起きる。
- `main` の先頭で全設定を検証する関数を置き、以後の読み取りは検証済み前提で書く。検証関数の中身が「設定の一覧」になるので、ドキュメントとの照合もしやすい。
- CLI フラグと環境変数の両方を受けるなら、エラーメッセージに両方の名前を出す。
- 取り込むべきでない条件: 開発者向けツールなど「とりあえず動く」ことが優先される場面では、不正値で止まることが摩擦になる。その場合も警告は出す。
