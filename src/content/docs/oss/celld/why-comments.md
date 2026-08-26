---
title: "コメントには却下した案・測った数字・失敗した経験を書く"
description: "コードを読めば分かることは書かず、「なぜこの形か」「試して駄目だった形は何か」「どの数字で決めたか」を書く。依存ライブラリのバージョン固定にも同じ規律を適用する。"
sidebar:
  order: 9
---

## 何を学んだか

### どんな状況の話か

コードは「今どうなっているか」しか示さない。「なぜ他の形ではないのか」は、書いた人の頭の中にしかない。数か月後に別の人 (あるいは本人) が「もっと単純にできるのでは」と思ってリファクタしたとき、却下済みの形に戻ってしまうことがある。分散システムでは、その「単純な形」がちょうど競合バグの原因だったりする。

### celld の答え

celld のコメントはほぼ全てが「なぜ」で、しかも具体的だ。特徴的なのは次の 3 種類。

1. **却下した代替案と、それが駄目だった理由。** 「最初は X にしたが、デフォルト設定で Y になってしまい機能しなかった」という形。
2. **測定した数字と条件。** 「jemalloc は glibc より 20% 多いスループット (16 コア、hello-world)」のように、判断の根拠を数値で残す。
3. **間違った形にしたときに何が起きるか。** 「これを Z にすると、次の読み取りが自分の返事と矛盾する」のように、失敗の様子を書く。

`Cargo.toml` の依存にも同じ規律が適用され、バージョンを完全固定する `=0.8.1` には「なぜ通常の範囲指定ではないか」が必ず付く。

## ソースコードのどこか

### 却下した案

[`crates/logic/pressure.rs#L36-L41`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/pressure.rs#L36-L41)。メモリの上限値の決め方について。

```rust title="crates/logic/pressure.rs"
/// It is a fixed share of the machine and is never derived from
/// `high_bytes`. A first attempt placed it "at least 125% of the ceiling",
/// which put it at exactly 100% of the machine for the default ceiling of
/// 80% -- above anything the kernel would let the process reach, so the
/// floor did not exist in the configuration that ships.
```

「最初は『天井の 125% 以上』にした。すると既定の天井 80% では機械の 100% になり、カーネルが到達させない値なので、出荷設定ではこの下限が存在しなかった」。

[`crates/celld/js/modules.rs#L39-L45`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/js/modules.rs#L39-L45)。thread-local にしたときに起きたバグまで書いてある。

```rust title="crates/celld/js/modules.rs"
/// **An isolate slot, not a thread-local.** These are `Global<Module>`
/// handles into *one* isolate's heap. Under D1 several isolates are built and
/// entered from the same tokio worker, so a thread-local made them share one
/// table: `register_stubs` clearing it for a new isolate wiped a live one's
/// stubs, and `dynamic_namespace` could localise a handle belonging to a
/// different isolate — not a wrong answer but an invalid one.
```

### 測った数字

[`crates/celld/main.rs#L41-L47`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L41-L47)。メモリアロケータの選択。

```rust title="crates/celld/main.rs"
// glibc's malloc serializes its arenas behind futexes, and under load the
// sixteen worker threads spent up to half a millisecond blocked per
// acquisition. On a 16-core host jemalloc measured 20% more hello-world
// throughput than glibc (mimalloc 11%), and returned the ~7% of the machine
// that arena-lock sleeps reported as idle.
#[global_allocator]
static ALLOC: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;
```

[`crates/celld/actor.rs#L1072-L1082`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L1072-L1082) の状態検査も「1 万セルで約 800µs/event」という測定値で、リリースビルドから外す判断を説明する。

### 間違った形にしたら何が起きるか

[`crates/celld/main.rs#L1993-L1998`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L1993-L1998)。ログを「あふれたら捨てる」設定にする理由。

```rust title="crates/celld/main.rs"
// Docker and journald can stop consuming the process pipe during a log
// burst. Logging must lose diagnostics under that backpressure rather
// than block the Tokio workers that route requests and renew authority.
let (log_writer, log_guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
    .buffered_lines_limit(8_192)
    .lossy(true)
```

ログの読み手が詰まったときにログ出力で待つと、リクエスト処理やリースの更新まで止まる。ログを失う方がましだ、と。

[`crates/logic/wake.rs#L55-L57`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/wake.rs#L55-L57): "An entry that fails the fence is ignored rather than repaired: it cannot name a cell this node can serve, and a bad entry left by an older node would otherwise replay on every tick." — 壊れたエントリを修復せず無視する理由。修復しようとすると、古いノードが残したエントリが毎回再生される。

### 不変条件をコンパイル時の assert にして理由を添える

[`crates/celld/peer_auth.rs#L26-L29`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/peer_auth.rs#L26-L29)。

```rust title="crates/celld/peer_auth.rs"
// A nonce must be retained at least as long as its signature stays acceptable,
// or the replay cache forgets it while a replay is still in-window.
const _: () = assert!(REPLAY_RETENTION_MS >= CLOCK_WINDOW_MS);
```

2 つの定数の大小関係が安全性の条件なので、コンパイル時に検査する。どちらかを変える人は、この assert とコメントに必ずぶつかる。

### 「入力にしないもの」を書く

[`crates/celld/protocol.rs#L203-L207`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/protocol.rs#L203-L207)。デプロイのバージョンを内容のハッシュで決めるとき、cron の式を含めない理由。

> Cron trigger expressions are deliberately NOT an input. A version names the code and its bindings; a schedule is configuration layered on top ... Hashing them would make the native and managed paths disagree about what a version is.

### 依存のバージョン固定

[`Cargo.toml#L46-L55`](https://github.com/denoland/celld/blob/v0.3.0/Cargo.toml#L46-L55)。

```toml title="Cargo.toml"
# unstable-split gives the read and write halves as separate objects. The
# tunnel needs them: a WebSocket read is not cancel-safe, so a live read
# future must survive while the same socket is written, and that is only
# possible when the halves are not one borrow.
#
# The feature is unstable by name, so a 0.8.x release can rename or drop it
# without upstream calling that a break, and a caret range would take it. Deno
# Land maintains fastwebsockets, so celld carries that risk knowingly; the
# version is exact to keep the upgrade a decision rather than a surprise.
fastwebsockets = { version = "=0.8.1", default-features = false, features = ["upgrade", "with_axum", "unstable-split"] }
```

Cargo の通常のバージョン指定 `"0.8.1"` は「0.8.x なら何でも良い」の意味で、`cargo update` で勝手に上がる。ここでは名前に "unstable" と付く feature に依存しているので、0.8.2 でその feature が消えても上流は互換性を壊したとみなさない。だから `=` で固定し、「アップグレードを驚きではなく判断にする」。

他にも [`Cargo.toml#L29-L31`](https://github.com/denoland/celld/blob/v0.3.0/Cargo.toml#L29-L31) 「全ての直接依存を workspace に置き、2 つのバージョンに分岐しないようにする」、[`#L69-L72`](https://github.com/denoland/celld/blob/v0.3.0/Cargo.toml#L69-L72) 「parquet は `arrow` feature なし。バイナリから arrow を外すため。ネストした列が必要になったら再検討」、[`#L105-L107`](https://github.com/denoland/celld/blob/v0.3.0/Cargo.toml#L105-L107) 「sqlite-vec は v1 前で Rust バインディングが互換ポリシー外なので、監査した C ソースを完全固定」、[`#L111-L116`](https://github.com/denoland/celld/blob/v0.3.0/Cargo.toml#L111-L116) jemalloc の `stats` feature が無いと何が起きるか、など。

リリースプロファイル ([`Cargo.toml#L7-L23`](https://github.com/denoland/celld/blob/v0.3.0/Cargo.toml#L7-L23)) も `opt-level = "s"` に「`"z"` ではない — さらに削る前に RPS を測れ」と書き、開発用の `lab` プロファイルは「fat LTO の再リンクがリビルド時間を支配するのでそれを外したもの。出荷物は `release`」と用途を限定する。

### 調整した定数に理由を付ける

[`crates/celld/main.rs#L1955-L1969`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L1955-L1969)。例: `DEFAULT_MAX_CONCURRENT_EVICTIONS = 4` — "because each one carries a durability proof, and a node that lets its whole working set prove durability at once turns a walk down into a thundering herd against the bucket" (追い出しは 1 件ごとに複製の証明を伴うので、一度に全部追い出すとバケットへのアクセスが殺到する)。

## なぜそうなっているか

- **分散システムの正しさは「なぜ他の形ではないか」に依存する。** コードは 1 つの形しか示さない。読み手が「もっと単純にできる」と思ってリファクタしたとき、却下済みの案に戻ることを防ぐには、その案と失敗理由を書いておくしかない。
- **数字は再測定の起点になる。** 「20%」「800µs」「16 コア」を残せば、環境が変わったときに同じ測定をやり直して判断を更新できる。「速いから」だけでは更新できない。
- **完全固定は「意図的な判断」の印。** 範囲指定が普通の Cargo では、`=` を見た読み手は理由を探す。理由が無ければ古い固定として外されかねない。

## どう活かすか

- コメントを書く前に「このコードを見た賢い同僚が最初に提案しそうな別案は何か」を考え、それを試していないなら書かず、試して駄目だったならその理由を書く。
- パフォーマンスや容量の判断には測定値と条件 (コア数、ワークロード、比較対象) を添える。
- 定数 (タイムアウト、並列数、閾値) には「この値でないと何が起きるか」を書く。
- 依存を完全固定するとき、feature の安定性や互換ポリシーの外にある理由を書く。
- 取り込むべきでない条件: 自明なコードにこの密度でコメントを付けると、本当に重要なコメントが埋もれる。celld でも `storage_ops.rs` のような「何も決めない」モジュールは冒頭に一言書くだけで、個々の関数にはほとんどコメントがない。
