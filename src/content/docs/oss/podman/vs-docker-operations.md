---
title: "運用から見た Docker との違い"
description: "章の締めくくりとして、これまで見てきた設計判断が運用でどう現れるかを整理する。アップグレード時の挙動、マルチユーザ環境、systemd との統合、ログの経路、ディスクの使われ方、そして「Docker では動くのに Podman では動かない」の典型的な原因。設計の違いが、日々の操作のどこに顔を出すかを対応付ける。"
group: "リモートとマルチプラットフォーム"
sidebar:
  order: 47
---

## 何を学んだか

### 設計判断と運用の対応表

この章で見てきた判断が、運用のどこに現れるかをまとめる。

| 設計                   | 運用での現れ方                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| デーモンレス           | エンジンをアップグレードしても動いているコンテナは無事。`podman` の更新に再起動が要らない                    |
| デーモンレス           | `podman ps` が `docker ps` より遅い。毎回ストアと DB を開くため                                              |
| ユーザごとのストア     | 同じイメージを N 人が使えばディスクを N 倍使う。[additional image store](../additional-image-stores/) で緩和 |
| ユーザごとの socket    | ユーザ A のコンテナをユーザ B が操作できない。`docker` グループ相当の問題が無い                              |
| rootless 既定          | 1024 未満のポートに bind できない。`mknod` できない。uid は 65536 個まで                                     |
| capability を 3 つ削減 | `ping` が動かない (`CAP_NET_RAW` なし)、`mknod` が失敗する                                                   |
| systemd への委譲       | ヘルスチェックも再起動も systemd 側。`systemctl` で状態が見える                                              |
| conmon が親            | コンテナのログは conmon が書く。`podman` が落ちても影響しない                                                |
| journald が既定のログ  | `journalctl` でコンテナのログが読める。ローテーションも journald 任せ                                        |
| pasta が既定           | ホストのメイン IP へのコンテナからの接続が動かない                                                           |
| content-addressable    | イメージのロールバックがタグの付け替えで済む                                                                 |

### 「Docker では動くのに」の典型

移行時に踏みやすい順に。

1. **`ping` が動かない** — `CAP_NET_RAW` が既定に無い ([OCI spec の既定値](../oci-spec-defaults/))
2. **1024 未満のポートを公開できない** — rootless の制限。`net.ipv4.ip_unprivileged_port_start` で緩和
3. **コンテナ内の uid が大きいイメージが動かない** — subuid の範囲が 65536 個
4. **ホストの IP に対するコンテナからの接続が失敗** — pasta がホストの IP をコピーするため
5. **`--restart=always` がブート時に効かない** — `podman-restart.service` の有効化が要る
6. **BuildKit 固有の Dockerfile 構文が使えない** — `podman build` は buildah であり BuildKit ではない
7. **Swarm 関連のコマンドが 503 を返す** — 実装しない領域 ([Docker のアーキテクチャ](../docker-architecture/))
8. **ボリュームプラグイン / ネットワークプラグインが動かない** — Docker のプラグイン機構は非対応

いずれも「バグ」ではなく **設計判断の帰結** で、多くは回避策がある。`rootless.md` に一覧があることは、rootless の項で見たとおり。

### アップグレードの挙動が根本的に違う

Docker では `dockerd` を再起動すると、原則としてコンテナも止まる (live-restore を有効にすれば実行中のものは残るが、機能に制限がつく)。

Podman では **エンジンのアップグレードとコンテナの生存が完全に独立している**。動いているコンテナの親は conmon で、`podman` バイナリではない。`dnf update podman` を実行しても、走っているコンテナには何も起きない。

代わりに、**ストアや DB のフォーマットが変わる更新** には注意が要る。v6 で BoltDB が削除されたときは、`podman system migrate --migrate-db` か再起動が必要になった。エンジンが常駐していないので、「全プロセスが新しいバージョンになった」保証が無い。移行は明示的な操作になる。

### マルチユーザ環境の考え方が逆

Docker は「1 台に 1 つのエンジン、全ユーザで共有」。Podman は「ユーザごとに独立したエンジン」。

これは共有サーバでの意味が大きく違う。Docker では `docker` グループへの追加が実質 root 権限の付与になるため、開発者にコンテナを触らせるのが難しい。Podman なら、ユーザは自分のコンテナしか触れない。

代償はディスクとイメージの重複で、それを緩和するのが additional image store になる。

## ソースコードのどこか

### `podman info` が設計の違いを列挙している

[`libpod/define/info.go`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/define/info.go) のフィールドを見ると、Docker には無い概念が並ぶ。

```go title="libpod/define/info.go"
	Rootless            bool   `json:"rootless"`
```

```go title="libpod/define/info.go"
	CgroupManager      string            `json:"cgroupManager"`
	CgroupsVersion     string            `json:"cgroupVersion"`
```

```go title="libpod/define/info.go"
	// RootlessNetworkCmd returns the default rootless network command (pasta)
	RootlessNetworkCmd string `json:"rootlessNetworkCmd"`
```

`rootless` が bool として最上位にあること、`cgroupManager` (systemd か cgroupfs か) が出ること、`rootlessNetworkCmd` があること。**トラブルシュートで最初に見るべき値が、これらの設計判断に対応している**。

`docker info` には対応するものがない。デーモンが 1 つで root で動くことが前提なので、これらは変数ではないからだ。

### バージョン情報が buildah や containers/image を含む

```go title="libpod/info.go"
	"go.podman.io/buildah"
	"go.podman.io/buildah/pkg/parse"
	"go.podman.io/buildah/pkg/util"
	"go.podman.io/common/pkg/version"
	"go.podman.io/image/v5/pkg/sysregistriesv2"
	...
	"go.podman.io/storage/pkg/system"
	"tags.cncf.io/container-device-interface/pkg/cdi"
```

`podman info` の実装が、これらのライブラリを直接 import している。**バージョンやレジストリ設定を、それぞれのライブラリから聞いて回る**。

`sysregistriesv2` から得るのはレジストリの設定で、`podman info` の出力に `registries` として出る。「どのレジストリを短縮名で探すか」がその場で確認できるようになっている。移行時によく問題になる箇所なので、`info` に出しているのは実用的な判断だ。

`containers/storage` からはストアの情報を得る。graphroot がどこか、graph driver が何か、fuse-overlayfs を使っているかどうか。これも rootless のトラブルシュートで最初に見る値になる。

### 「実装しない」ことが明示されているコード

Swarm の例は [Docker のアーキテクチャ](../docker-architecture/) で見た。503 を返して「クライアントが判断できるように」する。

Compose の例は [Compose 互換](../compose-compatibility/) で見た。外部プロバイダに委譲し、それを毎回警告として表示する。

BuildKit の例は `DOCKER_BUILDKIT=0` で、「追いつき続けるゲームなので無効にする」とコメントに書いてある。

**3 つとも「できない」ではなく「やらないと決めた」ことがコードに残っている**。運用者から見れば、issue を立てる前にコードを見れば方針が分かる、ということになる。

## なぜそうなっているか

### 制約から出発した設計は、運用の性質を決める

この章の出発点は「デーモンを持たない」「特権を持たない」という 2 つの制約だった。そこから導かれたものを並べると、

- 状態を SQLite とファイルに置く → **複数プロセスが同時に触れる** → `podman` を並列に叩ける
- 排他を共有メモリに置く → **プロセスをまたぐロック** → デッドロック時に `system renumber` が要る
- conmon が親 → **エンジンの更新がコンテナに影響しない**
- systemd に委譲 → **`systemctl` が第一の操作系になる**
- user namespace の中 → **subuid の設定が前提** → ID プロバイダとの統合が課題になる

運用上の長所も短所も、この 2 つの制約から機械的に出てくる。**「なぜこうなのか」を辿ると必ず同じ場所に着く** のが、この章を通して見えたことだ。

### Docker の設計も、当時の制約から出発している

公平に言えば、Docker のデーモン方式も「アプリを再現性のある形でパッケージして配る」という当時の目的に対する自然な答えだった。状態管理が単純になり、開発の速度が上がり、エコシステムが育った。

問題は用途が広がったことで、Kubernetes は dockerd を余分な層と判断し、CI は root デーモンを嫌い、マルチユーザ環境は分離を求めた。**設計が悪かったのではなく、要求が変わった**。

Podman はその変化した要求に対する答えとして作られている。逆に、単一ユーザの開発機で使うぶんには Docker の方が体感が速く、エコシステムも厚い。

### 互換性への投資が、選択肢を作った

Podman が Docker 互換 API に投資したことで、

- Docker CLI がそのまま使える (`podman-docker` パッケージ)
- docker-compose がそのまま使える ([Compose 互換](../compose-compatibility/))
- Testcontainers など `DOCKER_HOST` を見るツールが動く

という状態になった。**エンジンを入れ替えても、周辺ツールを入れ替えなくてよい**。移行のコストが「エンジンの差の学習」だけに収まる。

互換 API という 1 点への投資が、エコシステム全体を引き継ぐ形で回収されている。この章で見た `pkg/api/server/` のコードは、その投資の実体だった。

## どう活かすか

- **設計判断と運用の症状を対応付けておく。** 「`ping` が動かない」を「capability の既定を絞った」に還元できると、回避策を自分で導ける。表面的な症状の暗記より、制約からの導出を覚える方が応用が利く。
- **既存資産を引き継げるかで、置き換えの成否が決まる。** プロトコル互換に投資すれば、上位のツール群をそのまま使える。エンジンだけ入れ替えて周辺を維持する、という移行が可能になる。
- **「やらない」判断はコードに残す。** 503 を返すハンドラ、外部プロバイダへの委譲、無効化のコメント。運用者が方針を読み取れると、無駄な調査と issue が減る。
- **`info` 系のコマンドには、設計上の変数を出す。** rootless か、cgroup マネージャは何か、どのネットワークバックエンドか。「環境によって変わる部分」を 1 コマンドで出せると、問い合わせの往復が減る。
- **制約からの導出を辿れる設計は、学びやすい。** Podman の設計はほぼすべてが 2 つの制約から導かれる。自分の設計でも「なぜこうしたか」が少数の前提に還元できるなら、読む人が全体を早く理解できる。
