---
title: "古いノードが新しいマニフェストを「部分的に」読まないよう、必要機能を明示させる"
description: "JSON の未知フィールドを無視する前方互換に頼ると、古いノードが新機能を含む deployment を読み込んで、リクエスト時に壊れる。`required_features` を manifest に持たせ、対応しないノードはロード時に拒否する。"
sidebar:
  order: 12
---

## 何を学んだか

### どんな状況の話か

celld のフリートに新しいバージョンのノードと古いバージョンのノードが混在している。新しい `celld deploy` が、新機能 (たとえば D1 データベースのバインディング) を使うアプリをデプロイした。古いノードはその deployment のマニフェスト (JSON) を読む。

JSON のパースは、知らないフィールドを無視するのが普通だ (serde の既定動作)。古いノードは D1 の設定を無視してマニフェストを読み込み、正常に起動したように見える。そして本番のリクエストが来て `env.DB` を呼んだ瞬間に失敗する。開発者はデプロイが成功したと思っているので、原因に気づきにくい。

### celld の答え

マニフェストに `required_features` (このアプリが必要とする機能の一覧) を持たせる。ノードは自分がサポートしない機能を要求するマニフェストを、**ロードの時点で**拒否する。失敗を「開発者が見ていない本番のリクエスト時」から「デプロイ時」に移す。

## ソースコードのどこか

[`crates/celld/protocol.rs#L44-L54`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/protocol.rs#L44-L54)。

```rust title="crates/celld/protocol.rs"
/// Manifest `required_features` values this build can load. A manifest
/// requiring anything else must be rejected up front: `ModuleRef` tolerates
/// unknown fields, so an older node would otherwise deserialize the manifest
/// partially and fail (or misbehave) at worker load instead.
pub const SUPPORTED_DEPLOYMENT_FEATURES: &[&str] = &[
    FEATURE_ASSETS_V1,
    FEATURE_CRON_V1,
    FEATURE_D1_V1,
    FEATURE_SQLITE_VEC_V1,
    FEATURE_WASM_V1,
];
```

[`protocol.rs#L57-L65`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/protocol.rs#L57-L65) は機能ごとに「このゲートが無いと何が起きるか」を書く。D1 なら「マニフェストはロードできるが、開発者が見ていないノードでリクエスト時に `env.DB` の呼び出しが全部失敗する」、cron なら「黙って一度も発火しない — このゲートが防ぐべき静かな失敗」。

検証関数 [`protocol.rs#L69-L81`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/protocol.rs#L69-L81) は「両方のロード経路が同じゲートを通らなければならないので、機能一覧の隣に置く」。

関連して、マニフェストの `schema_version` は `#[serde(default)]` で 1 になるよう定義され ([`protocol.rs#L10-L16`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/protocol.rs#L10-L16), [`#L40-L42`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/protocol.rs#L40-L42))、フィールドが追加される前のマニフェストも読める。deployment のバージョンは内容のハッシュで決まり、「アップロード時の生のバイト列は決定論的でないので使わない。全ての送信者が同じ定義に合意しないと、同じコードが経路によって 2 つのバージョンになる」 ([`protocol.rs#L196-L228`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/protocol.rs#L196-L228))。

ノード間の通信プロトコルは [`crates/celld/peer_auth.rs#L17-L19`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/peer_auth.rs#L17-L19) で `PROTOCOL_VERSION: u16 = 2` を持ち、署名する文字列にバージョンを含め、応答ヘッダの不一致を拒否する。`celld diagnose` はバージョンが一致しないノードを報告する。

混在フリートでの互換性は環境変数で運用者に委ねる ([`crates/celld/ltx_repl.rs#L1457-L1460`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/ltx_repl.rs#L1457-L1460)): 「混在フリートでは全ノードが v0.5.2 のブロックオブジェクトを読めるまで `0` にすること。古い読み手は最初の L1 発行後にセルを引き継げない」。

## なぜそうなっているか

- **未知フィールドの無視は、追加された機能が「無視して良いもの」であることを前提にしている。** D1 バインディングや cron は無視して良い機能ではなく、無視すると挙動が変わる。この区別をマニフェストの書き手に宣言させる。
- **失敗はデプロイ時に起こしたい。** リクエスト時の失敗は本番トラフィックに当たり、運用者が原因を追いにくい。ロード時に拒否すればデプロイのフィードバックとして返せる。
- **バージョン番号だけでは足りない。** `schema_version` は構造の互換性を表すが、「この機能が必要」は独立した次元。機能を列挙する方が、古いノードが自分の対応範囲を正確に判定できる。

## どう活かすか

- 設定・マニフェスト・メッセージに新しい機能を追加するとき、「古い読み手がこのフィールドを無視したら何が起きるか」を考える。挙動が変わるなら、`required_features` のような明示的な要求リストに載せる。
- 読み手は自分のサポート一覧と突き合わせ、未対応があればロードを拒否する。読めた後で失敗させない。
- 内容のハッシュで identity を決めるとき、何を入力にし何を入力にしないかを書き、全ての書き手が同じ定義を使うことを強制する。
- 混在バージョンで動かす期間があるなら、新フォーマットの書き出しを運用者が止められるスイッチを用意し、いつ外して良いかの条件をドキュメントに書く。
- 取り込むべきでない条件: 読み手が 1 種類しか存在しない (常に同じバイナリが読む) 場合は不要。複数バージョンのノードが同じデータを読む状況で初めて意味を持つ。
