---
title: "celld"
description: "Deno が開発する、セルフホストの分散 Durable Objects ランタイム。専用の調停サービスを持たず、S3 のようなオブジェクトストレージだけで「どのサーバーがどのデータを担当するか」を決める。"
oss:
  repo: https://github.com/denoland/celld
  language: Rust
  ref: v0.3.0
sidebar:
  label: 概要
  order: 0
---

celld は、Cloudflare Workers / Durable Objects 向けに書いた JavaScript を自分のサーバーで動かすためのデーモンだ。状態を持つ単位 (セル) ごとに独立した SQLite データベースがあり、S3 / GCS / Azure Blob に複製される。複数サーバーの調整は、そのストレージの「条件付き書き込み」だけで行う。ZooKeeper や etcd のような専用の調停サービスも、Raft のような合意アルゴリズムも使わない。

## この OSS について

- Deno Land が開発。V8 を埋め込み、Wrangler でビルドしたバンドルを実行する。
- 約 4.5 万行の Rust。`crates/logic` (判断だけをする純粋なコア、依存ゼロ) と `crates/celld` (実際の I/O を行う実行層) に分かれ、`crates/ltx` が Litestream 互換の SQLite 複製を担う。
- 読みどころは、分散システムの難所 (二重所有の防止、生死判定、「保存しました」と言って良いタイミング) を、オブジェクトストレージの 3 つの性質だけに還元しているところ。そしてその前提を信じず、起動時に実地で検証するところ。
- コメントが充実していて、却下した設計案・測定値・過去に出荷して失敗した形がそのまま残っている。テスト戦略を説明した [`docs/testing.md`](https://github.com/denoland/celld/blob/v0.3.0/docs/testing.md) は単体で読み物として価値がある。

## 読む順番

分散システムに慣れていなければ、まず [前提知識](./basics/) を読んでほしい。以降のページで使う言葉を 1 つの物語で導入している。そのあとは「分散協調の設計」を上から順に読むと、前のページの仕組みが次のページの前提になっている。「テスト」と「日常のエンジニアリング」は独立しているので、興味のあるものから読める。

分散協調の設計:

- [決定コアを純粋関数にし、I/O は Effect として外に出す](./decision-core/)
- [オブジェクトストレージの条件付き書き込みを信頼せず検証する](./conditional-write-contract/)
- [エポックをキーに埋め込み、データパスから条件付き書き込みを追い出す](./epoch-fence/)
- [リースの権限は「ストアに公開した期限」で判定し、失効したら自ら止まる](./self-fence/)
- [書き込みの応答を耐久性の証明まで保留し、証明の種類で確認手順を変える](./output-gate/)

テスト:

- [決定論の境界を lint で強制し、テストには壊し方を植えておく](./deterministic-boundary/)
- [正解は本物の上流バイナリから取り、スキップを CI で禁止する](./differential-oracle/)

日常のエンジニアリング:

- [コメントには却下した案・測った数字・失敗した経験を書く](./why-comments/)
- [環境変数は起動時に一括検証し、不正値は既定値に落とさず停止する](./strict-env-parsing/)
- [測定と判断を分け、判断に使う数字は同じ瞬間から取る](./memory-pressure/)
- [古いノードが新しいマニフェストを「部分的に」読まないよう、必要機能を明示させる](./manifest-feature-gate/)
