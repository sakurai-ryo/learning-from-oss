---
title: "Podman"
description: "デーモンを持たない OCI コンテナエンジン。root なしで動き、Docker 互換の CLI と REST API を持ち、systemd と深く統合する。「常駐プロセスが無い」「特権が無い」という 2 つの制約を、OS の仕組み (conmon、SQLite、共有メモリ、user namespace、systemd) にどう分解して解いているかが読みどころ。"
oss:
  repo: https://github.com/podman-container-tools/podman
  language: Go
  ref: v6.1.0
sidebar:
  label: 概要
  order: 0
---

Podman は、コンテナ・イメージ・Pod を管理する CLI だ。Docker と違ってデーモンを持たず、`podman run` のプロセスはコンテナを起動したら終了する。一般ユーザーとして起動すれば user namespace の中で動き、setuid バイナリも要らない。Linux では libpod を同一プロセスで呼び、macOS や Windows では VM の中の Podman に REST API で話しかけるクライアントになる。

## この OSS について

- Red Hat が主導し、containers organization で開発。Apache 2.0。
- 約 19 万行の Go (`libpod` 4.8 万、`pkg` 11 万、`cmd` 3.3 万) と、rootless の namespace 操作と共有メモリロックのための約 2,300 行の C。依存先の containers/storage、containers/image、containers/common (現 container-libs) も `vendor/` に入っている。
- 読みどころは、「常駐プロセスが無い」「特権が無い」という 2 つの制約を OS の仕組みに分解して解いているところ。監視は conmon という小さな別プロセスに、状態は SQLite に、排他は `/dev/shm` の pthread mutex に、定期実行は systemd の transient timer に、cgroup の作成は systemd への D-Bus 呼び出しに、それぞれ委ねている。
- もう 1 つは、同じ CLI をローカルとリモートで動かすための層の切り方。`ContainerEngine` インターフェースと、JSON 化可能な「コンテナを作る意図」の型 (`SpecGenerator`) が、CLI・REST・Docker 互換 API・Kubernetes YAML を 1 本の実行段に合流させている。
- コミットメッセージが設計の理由をよく語っている。「停止を無順序で並列化したら infra が先に死んだので順序付き並列に戻した」「pause プロセスの罠を nsfs のファイルハンドルで置き換える」のような、方針を変えた経緯がそのまま残っている。

## 読む順番

「デーモンレス」の 4 ページが土台で、前のページの仕組みが次のページの前提になっている。最初に読むならここから。

「rootless」は最も深く書いた。user namespace の具体 (uid_map の書き方、newuidmap、pause プロセス、nsfs ハンドル) から、ネットワークと cgroup の委譲まで、非特権で動くための仕組みを順に追う。namespace と cgroup の基礎は知っている前提で書いている。

「ローカルとリモート」と「ライフサイクルと systemd 連携」は独立しているので、興味のあるものから読める。

デーモンレス:

- [コンテナの監視を小さな別プロセスに委ね、CLI 自身はいつ終了してもよい設計にする](./conmon-supervision/)
- [デーモンの代わりに、複数プロセスが同時に触る状態を SQLite に「インデックス列 + JSON」で置く](./sqlite-state/)
- [プロセス間ロックは共有メモリに固定数確保し、番号を DB に保存して再起動後も同じロックを引き当てる](./shm-lock-manager/)
- [シグナルは無視せず「配送を遅らせる」。RWMutex の読み手を危険区間、書き手をハンドラにする](./shutdown-inhibit/)

rootless:

- [Go ランタイムが動く前に、C の constructor で user namespace に入る](./constructor-reexec/)
- [uid のマッピングは setuid ヘルパーに書かせ、コンテナ側は「中間 ID」に対する二段目として作る](./userns-idmap/)
- [namespace を生かし続けるために最小のプロセスを 1 つ置き、勝者の決定はファイルの原子的な rename に任せる](./pause-process/)
- [root がなければ、ネットワークスタックそのものをユーザー空間の別プロセスに置く](./rootless-network-pasta/)
- [既存ツールを無改造で動かすために「自分が所有する偽のホスト」を 1 層足す](./rootless-network-bridge/)
- [cgroup を自分で作らず、systemd に D-Bus で「委譲済みの scope」をもらう](./rootless-cgroup-scope/)

ローカルとリモート:

- [CLI はインターフェースだけに依存させ、in-process 実装と REST 越し実装をビルドタグで物理的に切り替える](./abi-tunnel-engine/)
- [「入力の解析」「意図の表現」「実行」を分け、意図の表現をシリアライズ可能にして CLI・REST・互換 API・YAML を 1 本の実行段に合流させる](./specgen-two-stage/)

ライフサイクルと systemd 連携:

- [依存を 1 箇所に集約して DAG を組み、起動は外向き、停止は内向きの鏡像走査にする](./container-graph/)
- [常駐タイマーを持たず、systemd の transient timer に「自分自身を呼び戻させる」](./systemd-healthcheck/)
- [unit ファイルを生成して配るのではなく、systemd generator として daemon-reload のたびに変換する](./quadlet-generator/)
