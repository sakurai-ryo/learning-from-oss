---
title: "「やらないこと」を表にして、スコープを凍結する"
description: "containerd には機能ごとの in/out を並べた表があり、networking・build・volumes・logging はすべて out と書かれている。しかも「一覧にないものは対象外」「変更には全メンテナの 100% の賛成が必要」と決められている。この宣言はドキュメントに留まらず、コードの依存関係にそのまま現れている。"
group: "containerd のかたち"
sidebar:
  order: 10
---

## 何を学んだか

### スコープが表になっている OSS

多くのプロジェクトは「何ができるか」を書くが、containerd は **「何をしないか」を表で持っている**。`SCOPE.md` の表には機能名・説明・in/out・理由の 4 列が並ぶ。

| 機能           | in/out  | 理由 (要約)                                                                 |
| -------------- | ------- | --------------------------------------------------------------------------- |
| execution      | **in**  | create/start/stop/pause/resume/exec/signal/delete                           |
| cow filesystem | **in**  | overlay などのコピーオンライトの組み込み対応                                |
| distribution   | **in**  | イメージの push/pull と操作を一級の API にする                              |
| metrics        | **in**  | コンテナ単位のメトリクス、cgroup 統計、OOM イベント                         |
| networking     | **out** | ネットワークは上位のシステムが用意して containerd に渡す                    |
| build          | **out** | ビルドは上位のツールの機能で、多様な実装がありうる                          |
| volumes        | **out** | mount と bind を API が支えるので、その上に作れる                           |
| logging        | **out** | コンテナの STDIO はクライアントに渡す。containerd 内に STDIO のコピーはない |

「out」の理由が「不要だから」ではなく **「上に作れるから」** であることに注目したい。スコープ外にする根拠が、下位の primitive で代替できるかどうかに置かれている。

### 4 つの原則

`SCOPE.md` の前半には原則が 4 つ書かれている。

1. **Components** — 部品同士が強く依存しないようにする。個別に使えること
2. **Primitives** — 高レベルの抽象ではなく、問題を解くための primitive を出す
3. **Extensibility and Defaults** — 差し替え点を定義し、既定の実装を 1 つだけ持つ
4. **代替実装は本体に入れない** — 代わりのものは別リポジトリで開発する

3 と 4 が組み合わさっているのが特徴的だ。「差し替え可能にする」が「あらゆる実装を取り込む」にならないよう、**受け入れないことを明示** している。

### スコープの変更コストを最大にする

```markdown title="SCOPE.md"
The scope of this project is an allowed list.
If it's not mentioned as being in scope, it is out of scope.
For the scope of this project to change it requires a 100% vote from all maintainers of the project.
```

allowed list (許可リスト) 方式にすると、「書いていない = 対象外」になる。禁止リストなら「書いていない = 議論の余地あり」になってしまう。さらに変更には全会一致が要る。**1 人でも反対すれば入らない**。

## ソースコードのどこか

### networking が本当に入っていない

`SCOPE.md` の宣言は、依存関係を見れば裏が取れる。CNI ライブラリ (`github.com/containerd/go-cni`) を import しているファイルを探すと、すべて `internal/cri/` の下にある。

```
internal/cri/config/config.go
internal/cri/server/sandbox_run.go
internal/cri/server/sandbox_stop.go
internal/cri/server/service.go
internal/cri/server/cni_conf_syncer.go
...
```

`core/` 配下には 1 件もない。ネットワークの設定は **CRI プラグインという「上位システムの一部」の中でだけ** 行われていて、containerd のコアは network namespace のパスを OCI spec の一部として受け取るだけだ。

`ctr run` でコンテナを起動するとネットワークが host のままになるのは、この分担の直接の帰結だ。`ctr` は CNI を呼ばない。

### logging も同じ形

コンテナの stdout/stderr は containerd プロセスを通らない。shim が fifo から読み、設定された宛先 (ファイル、fifo、外部バイナリ) に直接書く。

```markdown title="docs/runtime-v2.md"
Shims may support pluggable logging via STDIO URIs.
Current supported schemes for logging are:

- fifo - Linux
- binary - Linux & Windows
- binary-v2 (since containerd v2.2) - Linux & Windows
- file - Linux & Windows
```

`binary://` スキームを使うと、**shim が任意のバイナリを起動して stdio を渡す**。journald に流すドライバの例が `docs/runtime-v2.md` に載っている。ログの永続化という関心事が、containerd の外の実行ファイルに切り出されている。

### primitives の実例 — ビルドに必要なものだけを出す

```markdown title="SCOPE.md"
containerd should expose primitives to solve problems instead of building high level abstractions in the API.
A common example of this is how build would be implemented.
Instead of having a build API in containerd we should expose the lower level primitives that allow things required in build to work.
Breaking up the filesystem APIs to allow snapshots, copy functionality, and mounts allow people implementing build at the higher levels with more flexibility.
```

BuildKit が containerd の上に載るとき、使うのは次の primitive だけだ。

- **snapshotter** — `Prepare` で書き込み可能な層を作り、コマンドを実行し、`Commit` で固める
- **content store** — 生成した layer と manifest を置く
- **differ** — 2 つの snapshot の差分を tar として取り出す
- **lease** — ビルド中の中間成果物を GC から守る

「ビルド API」を作らずにこの 4 つを出す、という判断が、BuildKit / nerdctl build / Kaniko といった複数の実装を可能にしている。

### 差し替え点と既定の実装

```markdown title="SCOPE.md"
For the various components in containerd there should be defined extension points where implementations can be swapped for alternatives.
The best example of this is that containerd will use `runc` from OCI as the default runtime in the execution layer but other runtimes conforming to the OCI Runtime specification can be easily added to containerd.

containerd will come with a default implementation for the various components.
These defaults will be chosen by the maintainers of the project and should not change unless better tech for that component comes out.
Additional implementations will not be accepted into the core repository and should be developed in a separate repository not maintained by the containerd maintainers.
```

この方針は [`plugins/types.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/types.go) の型一覧と、`containerd/` GitHub organization のリポジトリ構成に現れている。stargz snapshotter、nydus snapshotter、runwasi といった代替実装は本体ではなく別リポジトリにある。

一方でリポジトリ内に複数の snapshotter (`overlay`, `native`, `blockfile`, `devmapper`, `btrfs`, `zfs`, `erofs`) が同居しているのは、この原則との緊張関係でもある。歴史的経緯で入ったものと、カーネル機能の違いを吸収するために必要なものが混在している。

### 単一ホストであることの表明

```markdown title="SCOPE.md"
containerd is scoped to a single host and makes assumptions based on that fact.
It can be used to build things like a node agent that launches containers but does not have any concepts of a distributed system.
```

これがあるので、containerd のコードには分散合意もリーダー選出もクラスタメンバシップも出てこない。状態はローカルの bbolt 1 ファイルに閉じ、トランザクションはそのファイルの中で完結する ([bbolt 1 ファイルに、すべてのメタデータを入れる](../bolt-schema/))。

「単一ホスト」という前提が、メタデータ層をシンプルに保つ最大の要因になっている。

### ctr は道具であって製品ではない

```markdown title="SCOPE.md"
containerd is designed to be embedded into a larger system, hence it only includes a barebone CLI (`ctr`) specifically for development and debugging purpose, with no mandate to be human-friendly, and no guarantee of interface stability over time.
```

`ctr` の使い勝手が独特で、リリース間で変わることがあるのは仕様だ。人間向けの CLI が欲しければ nerdctl を使う、という分担が明示されている。

## なぜそうなっているか

### 「上に作れるか」を判断基準にする

スコープの判断基準が「必要かどうか」ではなく「上に作れるかどうか」であることが、この文書の核心だ。

- 必要性で判断すると、ユーザが増えるほど「これも必要」が積み上がる
- 「上に作れるか」で判断すると、**下位に何を用意すればよいか** に議論が移る

volumes が out である理由が「mount と bind を API が支えるので、その上に作れる」であるのはその典型で、volume 機能を断るのではなく「volume を実装できる mount を出す」という応答になっている。

### 機能を足さないことが、互換性の予算を守る

containerd は Kubernetes の下で数年単位で動き続ける。API を増やせば、それを維持する義務が生まれる。`RELEASES.md` は 44 KB あり、API の安定性保証、非推奨化の手順、サポート期間が細かく決められている。

**足した機能は簡単には消せない**。スコープの表と全会一致ルールは、この維持コストを事前に抑える仕組みだと読める。

### 代替実装を受け入れないことで、既定の質を保つ

「代替実装は別リポジトリで」という方針には、メンテナンス負荷の分散という現実的な理由がある。本体に 10 個の snapshotter が入れば、リファクタリングのたびに 10 個を壊さないよう気を遣うことになる。

代わりに proxy plugin という仕組みを用意し、**本体をビルドし直さずに外部実装を差し込める** ようにしている ([proxy plugin: 別プロセスを containerd の一部として扱う](../proxy-plugins/))。方針とメカニズムがセットになっている。

## どう活かすか

### 「この機能は containerd の仕事か」を判断する

運用や設計で containerd に何かをさせたくなったとき、`SCOPE.md` の判断基準がそのまま使える。

| やりたいこと                       | どこでやるか                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| コンテナのログを収集する           | shim のログドライバか、上位のログ基盤                                |
| ネットワークポリシーを適用する     | CNI プラグイン、または NRI                                           |
| イメージの脆弱性スキャン           | pull の前後で外部ツール。image verifier で pull を止めることはできる |
| コンテナの起動時に設定を書き換える | NRI プラグイン ([NRI](../nri/))                                      |

「containerd に機能を足す」ではなく「containerd の拡張点のどれに載るか」を先に考える、という順序になる。

### スコープ文書を書くときの型

`SCOPE.md` は、自分のプロジェクトでスコープを定義するときの雛形として使える。要素は 4 つだ。

- **表にする** — 機能ごとに in/out と **理由** を書く。理由が最も重要で、後から来た人が判断を再現できる
- **allowed list にする** — 「書いていないものは out」と明示する
- **変更手続きを書く** — 誰がどう決めれば変わるのかを決めておく
- **代替手段を示す** — out にするなら、その機能をどう実現できるかを併記する

4 番目があると、スコープ外の要求を断るときに「代わりにこうできる」と返せる。断る文書ではなく、設計を導く文書になる。
