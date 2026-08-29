---
title: "NRI: コンテナ生成に外部プラグインが介入する"
description: "コンテナを作る直前に外部プロセスへ問い合わせ、OCI spec の書き換えを受け取る仕組み。containerd 側は Domain インターフェースで「自分の namespace のコンテナ表現」を提供し、NRI 本体はランタイム非依存に保たれる。書き換えられる範囲は validator で絞れる。"
group: "サンドボックスと CRI"
sidebar:
  order: 58
---

## 何を学んだか

### 何のための仕組みか

CPU の割り当て、NUMA の配置、デバイスの注入、追加の mount。こうした「ノード固有のリソース調整」は、Kubernetes の API では表現しきれないことがある。

NRI (Node Resource Interface) は、**コンテナの生成・更新・削除のタイミングで外部プラグインに通知し、設定の書き換えを受け取る** 仕組みだ。containerd 2.0 から既定で有効になっている。

```markdown title="docs/NRI.md"
NRI, the Node Resource Interface, is a common framework for plugging
extensions into OCI-compatible container runtimes. It provides basic
mechanisms for plugins to track the state of containers and to make
limited changes to their configuration.
```

「**限定的な** 変更」と書かれているのが重要で、何でもできるわけではない。

### 2 層に分かれている

```markdown title="docs/NRI.md"
NRI support in containerd is split into two parts both logically and
physically. These parts are a common plugin (`/internal/nri/*`) to integrate to
NRI and CRI-specific bits (`/internal/cri/nri`) which convert
data between the runtime-agnostic NRI representation and the internal
representation of the CRI plugin.
```

- **共通部分** (`internal/nri`) — NRI プロトコルの処理。containerd の内部表現を知らない
- **CRI 固有部分** (`internal/cri/nri`) — CRI の Pod / コンテナ表現と、NRI の表現を相互変換する

境界にあるのが `Domain` インターフェースだ。

### Domain は namespace 単位

```go
type Domain interface {
	GetName() string
	ListPodSandboxes() []PodSandbox
	ListContainers() []Container
	GetPodSandbox(string) (PodSandbox, bool)
	GetContainer(string) (Container, bool)
	UpdateContainer(context.Context, *nri.ContainerUpdate) error
	EvictContainer(context.Context, *nri.ContainerEviction) error
}
```

`GetName()` が返すのは **containerd の namespace** (`k8s.io` など)。CRI 以外のクライアントも、自分の Domain を登録すれば NRI を使える設計になっている。

### プラグインの起動方法は 2 つ

- **事前登録** — `/opt/nri/plugins` にシンボリックリンクを置く。containerd 起動時に一緒に起動され、ソケットが接続済みで渡される
- **外部起動** — systemd などで起動し、`/var/run/nri/nri.sock` に接続して自己登録する

接続が確立した後は **どちらも同じ**。起動方法だけが違う。

### 書き換えられる範囲を絞れる

NRI プラグインは強力で、seccomp プロファイルや namespace の設定まで書き換えられる。それが危険な環境のために、**default validator** で個別に禁止できる。

## ソースコードのどこか

### Domain インターフェース

[`internal/nri/domain.go#L32-L57`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/internal/nri/domain.go#L32-L57)。

```go title="internal/nri/domain.go"
type Domain interface {
	// GetName returns the containerd namespace for this domain.
	GetName() string

	// ListPodSandboxes lists all pods in this namespace.
	ListPodSandboxes() []PodSandbox

	// ListContainers lists all containers in this namespace.
	ListContainers() []Container

	// GetPodSandbox returns the pod for the given ID.
	GetPodSandbox(string) (PodSandbox, bool)

	// GetContainer returns the container for the given ID.
	GetContainer(string) (Container, bool)

	// UpdateContainer applies an NRI container update request in the namespace.
	UpdateContainer(context.Context, *nri.ContainerUpdate) error

	// EvictContainer evicts the requested container in the namespace.
	EvictContainer(context.Context, *nri.ContainerEviction) error
}
```

**読み取り 4 つと書き込み 2 つ**。プラグインが状態を知るための問い合わせと、プラグインの要求を適用するための操作に分かれている。

`EvictContainer` があるのが目を引く。NRI プラグインは「このコンテナを追い出せ」と要求できる。リソースが枯渇したときに、優先度の低いコンテナを止めるといった用途だ。

登録は初期化時に行う。

```go title="internal/nri/domain.go"
// RegisterDomain registers an NRI domain for a containerd namespace.
func RegisterDomain(d Domain) {
	err := domains.add(d)
```

### 設計意図

[`docs/NRI.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/NRI.md)。

```markdown title="docs/NRI.md"
The containerd common NRI plugin implements the core logic of integrating
to and interacting with NRI. However, it does this without any knowledge
about the internal representation of containers or pods within containerd.
It defines an additional interface, Domain, which is used whenever the
internal representation of a container or pod needs to be translated to
the runtime agnostic NRI one
```

「containerd の内部表現を **一切知らずに**」NRI の中核ロジックを実装する。翻訳はすべて Domain 経由。

```markdown title="docs/NRI.md"
The main reason for this split of functionality is to allow
NRI plugins for other types of sandboxes and for other container clients other than just for CRI containers in the "k8s.io" namespace.
```

分割の理由が「CRI 以外のクライアントでも NRI を使えるようにするため」と明記されている。現状の実装は CRI しかないが、**拡張の余地を構造として残している**。

### 設定と既定値

```toml title="docs/NRI.md"
  [plugins."io.containerd.nri.v1.nri"]
    # Disable NRI support in containerd.
    disable = true
    # Allow connections from externally launched NRI plugins.
    disable_connections = false
    # plugin_config_path is the directory to search for plugin-specific configuration.
    plugin_config_path = "/etc/nri/conf.d"
    # plugin_path is the directory to search for plugins to launch on startup.
    plugin_path = "/opt/nri/plugins"
    # plugin_registration_timeout is the timeout for a plugin to register after connection.
    plugin_registration_timeout = "5s"
    # plugin_request_timeout is the timeout for a plugin to handle an event/request.
    plugin_request_timeout = "2s"
    # socket_path is the path of the NRI socket to create for plugins to connect to.
    socket_path = "/var/run/nri/nri.sock"
```

2 つのタイムアウトが分かれている。

- **登録のタイムアウト 5 秒** — 接続してきたプラグインが自己登録するまで
- **リクエストのタイムアウト 2 秒** — イベントの処理

**コンテナ生成のたびに 2 秒の予算がある**。プラグインが遅いとコンテナの起動が遅くなる。逆に言えば、遅いプラグインでも 2 秒で打ち切られる。

`disable_connections` で外部接続を禁止できる。事前登録したプラグインだけを許す構成になり、**任意のプロセスが NRI に接続できる状態を避けられる**。

ドキュメントに注意書きもある。

```markdown title="docs/NRI.md"
Note that you can't run two NRI-enabled runtimes on a single node with the
same default socket configuration.
```

ソケットパスが固定なので、containerd と CRI-O を同居させると衝突する。

### validator による制限

```toml title="docs/NRI.md"
  [plugins.'io.containerd.nri.v1.nri'.default_validator]
      enable = <true|false>
      reject_oci_hook_adjustment = <true|false>
      reject_runtime_default_seccomp_adjustment = <true|false>
      reject_unconfined_seccomp_adjustment = <true|false>
      reject_custom_seccomp_adjustment = <true|false>
      reject_namespace_adjustment = <true|false>
      required_plugins = [ <list of required NRI plugins> ]
      tolerate_missing_plugins_annotation = <annotation key name for toleration>
```

禁止できる項目が具体的に列挙されている。

- **OCI hook の注入** — 任意のコマンドをコンテナ起動時に実行させられる
- **seccomp の書き換え** — システムコールの制限を緩められる
- **namespace の書き換え** — 隔離を弱められる

いずれも **セキュリティ境界を動かす操作** だ。NRI プラグインが信頼できない環境では、これらを個別に禁止する。

`required_plugins` は逆方向で、「指定した NRI プラグインが動いていなければコンテナを作らせない」。セキュリティポリシーを NRI で実装している場合、プラグインが落ちた状態でコンテナが起動するのを防ぐ。

`tolerate_missing_plugins_annotation` で、特定のアノテーションを持つコンテナだけ例外にできる。**ポリシーを強制しつつ、緊急時の抜け道を用意する** という運用上の配慮になっている。

### 事前登録の仕組み

```markdown title="docs/NRI.md"
Pre-registering a plugin happens by placing a symbolic link to the plugin
executable into a well-known NRI-specific directory, `/opt/nri/plugins`
by default. A pre-registered plugin is started with a socket pre-connected
to NRI.
```

**ソケットを接続済みで渡す**。[shim の起動](../shim-process-start/) で見た「listen 済みの fd を継承させる」と同じ手法だ。

プラグイン側は接続処理を書かなくてよく、起動と同時に通信できる。

## なぜそうなっているか

### spec の書き換えを外部に開く

コンテナの設定を調整したい要求は多様だ。CPU ピニング、NUMA アフィニティ、GPU の割り当て、デバイスの注入、追加の環境変数。

これらを全部 CRI や containerd の設定に入れると、

- 設定項目が際限なく増える
- ノードごと・ワークロードごとの差に対応できない
- ベンダー固有の要求が本体に入る

**書き換えのタイミングだけを提供し、内容は外部に委ねる** のが NRI の立場になる。[SCOPE.md](../scope-and-principles/) の「primitive を出す」方針と一貫している。

### ランタイム非依存に保つ

NRI 本体 (`containerd/nri` リポジトリ) は containerd と CRI-O の両方で使われる。だから containerd の内部表現を知ってはいけない。

`Domain` インターフェースがその境界になる。**「翻訳の責任を、翻訳が必要な側に置く」** ことで、共通部分を汚さない。

この構造のおかげで、NRI プラグインは「containerd で動くか CRI-O で動くか」を意識しなくてよい。

### 危険な機能を既定で有効にすることの是非

NRI は containerd 2.0 から **既定で有効** だ。しかも seccomp や namespace を書き換えられる。

これが安全なのは、

- NRI ソケットへのアクセスが制限される (ファイルパーミッション)
- プラグインの起動には root 相当の権限が要る
- validator で個別に禁止できる

「**NRI プラグインはコンテナランタイムの一部とみなす**」という立場が [`docs/containerd-2.0.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/containerd-2.0.md) に書かれている。ランタイムの一部なので、ランタイムと同じ信頼レベルで扱う。

一方で validator が用意されているのは、その前提が成り立たない環境 (マルチテナントで、ノードの管理者を完全には信頼できない) への配慮だ。

## どう活かすか

### NRI が有効か確認する

```sh
# プラグインの状態
$ ctr plugins ls | grep nri

# ソケットの存在
$ ls -l /var/run/nri/nri.sock

# 登録されているプラグイン
$ ls -l /opt/nri/plugins/
```

`logger` プラグイン (NRI リポジトリにある) を動かすと、コンテナ生成のイベントが全部見える。NRI の動作確認に使える。

### コンテナの設定が想定と違うとき

Pod のマニフェストと、実際の `config.json` が違う場合、NRI プラグインの書き換えを疑う。

```sh
# 実際に runc に渡された設定
$ jq . /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>/config.json
```

NRI プラグインのログと突き合わせれば、どの調整が入ったか分かる。

### 「生成前のフックを外部に開く」設計

リソースの生成に外部の介入を許す仕組みを作るときの要点。

- **通知と書き換えを同じ経路で行う** — 状態を知らせ、変更を受け取る
- **タイムアウトを必ず設ける** — 遅いプラグインが本体を止めない
- **内部表現を外に出さない** — 翻訳層 (Domain) を挟む
- **書き換えられる範囲を制限できるようにする** — 既定は緩く、絞れるようにする
- **必須プラグインを指定できるようにする** — ポリシーを強制する用途

4 番目と 5 番目はセットで意味を持つ。「何でも書き換えられる」だけだと、セキュリティ用途に使えない。「絞れる」「必須にできる」の両方があって初めて、ポリシー強制の基盤になる。
