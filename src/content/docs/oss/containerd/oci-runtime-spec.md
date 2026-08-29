---
title: "OCI Runtime Spec: runc への入力は bundle 1 つだけ"
description: "低レベルランタイムへの入力は API ではなくディレクトリだ。config.json と rootfs/ を置いた bundle と、コンテナ ID。それだけで runc は動く。create と start が分かれているのは、プロセスを作った直後・ユーザプログラムを exec する前に、外側が割り込む隙間を作るためで、その隙間を使うのが containerd と shim だ。"
group: "コンテナランタイムの前提"
sidebar:
  order: 2
---

## 何を学んだか

### bundle という受け渡し形式

OCI Runtime Spec が定めているのは、突き詰めると次の 2 つだけだ。

1. **filesystem bundle** — `config.json` と、コンテナの root filesystem になるディレクトリを含むディレクトリ
2. **ライフサイクルと操作** — `create` / `start` / `kill` / `delete` / `state` という状態遷移

API のスキーマではなく、**ディスク上のディレクトリ構造** が境界になっているのがこの仕様の特徴だ。

```
/run/containerd/io.containerd.runtime.v2.task/k8s.io/4f2c.../
├── config.json      ← OCI Runtime Spec そのもの (プロセス、mount、namespace、cgroup、seccomp...)
├── rootfs/          ← ここが「/」になる。containerd が snapshotter のマウントを当てる
├── work -> ...      ← containerd 固有 (bundle の作業ディレクトリへの symlink)
├── address          ← containerd 固有 (shim の ttrpc ソケットアドレス)
└── log              ← containerd 固有 (shim のログ fifo)
```

`config.json` と `rootfs/` が仕様の定めるもの、残りは containerd が同じディレクトリに置いている付帯物だ。ランタイムを差し替えても前者は共通で、後者は containerd と shim の間の私的な取り決めになる。

### created という「まだ動いていない」状態

OCI のライフサイクルで最も重要なのは、`create` と `start` が分かれていることだ。

- `runc create <id>` — namespace を作り、cgroup に入れ、rootfs を pivot_root し、**ユーザのプログラムを execve する直前で止める**。この状態が `created`
- `runc start <id>` — 止まっている init に「進んでよい」と伝える。ここで初めて `execve` が起きて `running` になる

この 2 段階のおかげで、外側 (shim と containerd) は「コンテナのプロセスは存在するが、まだユーザコードは 1 命令も動いていない」という瞬間に割り込める。この瞬間にできることが多い。

- init プロセスの PID を取得して記録する
- cgroup の設定を確定させる
- `TaskCreate` イベントを発行して、購読者に届いたことを確認してから start する
- NRI プラグインに `config.json` を見せ、書き換えさせる

「起動してから設定する」ではレースになる処理を、**確定してから走らせる** 順序にできる。

### 合図は fifo で送られる

`runc start` が created 状態の init に「進め」と伝える方法は、シグナルでも RPC でもなく **名前付きパイプ 1 本** だ。init 側は自分の state ディレクトリの `exec.fifo` を書き込みで開いて、読み手が現れるまでブロックする。`runc start` はそれを読みに行く。読めたら init は execve に進む。

プロセス間で「ちょうど 1 回」の合図を、余分な常駐なしに送る手段としてこれが使われている。

## ソースコードのどこか

### runc 側 — create は「状態を作って止める」

[`create.go#L63-L73`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/create.go#L63-L73) (runc `89f46d64`)。

```go title="create.go"
	Action: func(_ context.Context, cmd *cli.Command) error {
		if err := checkArgs(cmd, 1, exactArgs); err != nil {
			return err
		}
		status, err := startContainer(cmd, CT_ACT_CREATE, nil)
		if err == nil {
			// exit with the container's exit status so any external supervisor
			// is notified of the exit with the correct exit status.
			os.Exit(status)
		}
		return fmt.Errorf("runc create failed: %w", err)
	},
```

コメントの "any external supervisor" が、まさに shim のことだ。runc は自分が誰かに監視されている前提で終了コードを設計している。

`start` 側は [`start.go#L24-L52`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/start.go#L24-L52)。

```go title="start.go"
		switch status {
		case libcontainer.Created:
			notifySocket, err := notifySocketStart(cmd, os.Getenv("NOTIFY_SOCKET"), container.ID())
			if err != nil {
				return err
			}
			if err := container.Exec(); err != nil {
				return err
			}
```

`created` 以外の状態では明示的に弾く。状態機械として書かれている。

### 合図の実装

[`libcontainer/container_linux.go#L225-L256`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/libcontainer/container_linux.go#L225-L256)。

```go title="libcontainer/container_linux.go"
// Exec signals the container to exec the users process at the end of the init.
func (c *Container) Exec() error {
	c.m.Lock()
	defer c.m.Unlock()
	return c.exec()
}

func (c *Container) exec() error {
	path := filepath.Join(c.stateDir, execFifoFilename)
	if err := handleFifo(path, c.initProcess.pid()); err != nil {
		return err
	}

	return c.postStart()
}

// handleFifo listens for either a byte written to the FIFO file or
// the init process exiting. On kernels supporting pidfd_open(2)
// (>= 5.3), it uses a single poll(2) for efficiency. On older kernels,
// it falls back to a polling loop that periodically checks the init
// process's liveness. This function is blocking.
```

fifo を読むだけでなく、**init が死んだ場合も検出する** ようになっている。fifo の読み手として待ち続けると、init が起動に失敗したときに永久にブロックしてしまうからだ。pidfd が使えるカーネルでは poll 1 回で両方を待つ。

読み取り側のエラーメッセージも具体的だ ([`#L329-L338`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/libcontainer/container_linux.go#L329-L338))。

```go title="libcontainer/container_linux.go"
	if n == 0 {
		return errors.New("exec fifo is empty: container init did not signal execve readiness (process died before writing, or fifo already consumed)")
	}
```

コンテナの状態そのものは `state.json` に置かれる ([`libcontainer/factory_linux.go#L21-L22`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/libcontainer/factory_linux.go#L21-L22))。runc はデーモンを持たないので、**状態はすべてファイル** だ。

### containerd 側 — bundle を作り、spec のバイト列をそのまま書く

[`core/runtime/v2/bundle.go#L46-L118`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/bundle.go#L46-L118) の `NewBundle`。

```go title="core/runtime/v2/bundle.go"
	rootfs := filepath.Join(b.Path, "rootfs")
	if err := os.MkdirAll(rootfs, 0711); err != nil {
		return nil, err
	}
	...
	// Spec may be nil for some sandboxers that do not initialize the spec, for
	// example the shim sandboxer with a hostNetwork container.
	if spec != nil {
		if spec := spec.GetValue(); spec != nil {
			// write the spec to the bundle
			specPath := filepath.Join(b.Path, oci.ConfigFilename)
			err = os.WriteFile(specPath, spec, 0666)
```

注目すべきは `spec.GetValue()` だ。spec は `typeurl.Any` — つまり **中身を解釈していないバイト列** として API から流れてきて、そのままファイルに書かれる。containerd は `config.json` の内容を知らないし、検証もしない。

これは意図的で、`GenerateSpec` はデーモンではなくクライアント側のパッケージにある ([`pkg/oci/spec.go#L66-L80`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/oci/spec.go#L66-L80))。

```go title="pkg/oci/spec.go"
// GenerateSpec will generate a default spec from the provided image
// for use as a containerd container
func GenerateSpec(ctx context.Context, client Client, c *containers.Container, opts ...SpecOpts) (*Spec, error) {
	return GenerateSpecWithPlatform(ctx, client, platforms.DefaultString(), c, opts...)
}
```

`pkg/oci/spec_opts.go` は 5 万行を超える `SpecOpts` の集合体だが、これらは全部 **クライアントのプロセスで実行される**。`WithImageConfig`、`WithHostNamespace`、`WithMounts` … これらが組み立てた結果の JSON バイト列だけがデーモンに渡る。この分担が [smart client model](../smart-client/) の中核だ。

### bundle が置かれる場所

`config.json` を実際に見たいときのパスは、プラグインごとのディレクトリ規約から決まる ([`cmd/containerd/server/server.go#L165-L174`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd/server/server.go#L165-L174))。

```go title="cmd/containerd/server/server.go"
		initContext := plugin.NewContext(
			ctx,
			initialized,
			map[string]string{
				plugins.PropertyRootDir:      filepath.Join(config.Root, id),
				plugins.PropertyStateDir:     filepath.Join(config.State, id),
```

`id` はプラグインの URI なので、runtime v2 の state ディレクトリは `/run/containerd/io.containerd.runtime.v2.task/` になる。そこに `<namespace>/<container-id>/` が並ぶ。

- **root** (`/var/lib/containerd/...`) = 再起動をまたいで残る永続データ
- **state** (`/run/containerd/...`) = tmpfs 上、再起動で消えてよいデータ

bundle が state 側にあるのは、ホストが再起動すればコンテナも消えるからだ。逆に content store と snapshotter は root 側にある。

## なぜそうなっているか

### ディレクトリを境界にすると、プロセスが死んでも壊れない

API を境界にすると、呼び出し側が死んだ瞬間に文脈が消える。ディレクトリを境界にすると、**誰も生きていなくても状態が残る**。

これが効くのは異常系だ。shim が SIGKILL された後でも、bundle が残っていれば containerd は `containerd-shim-runc-v2 delete` を実行して掃除できる。containerd 自身が落ちても、再起動後に bundle を走査すれば「動いているはずのコンテナ」の一覧が作れる。

### create/start 分離は、監視を差し込むためにある

分離がなければ、「プロセスが起動した」という通知が届く前にプロセスが終了している、という順序の逆転が起きうる。runtime v2 のイベント仕様は、この順序を **MUST** として明示している。

| Topic                  | Compliance                           |
| ---------------------- | ------------------------------------ |
| `TaskCreateEventTopic` | MUST                                 |
| `TaskStartEventTopic`  | MUST (follow `TaskCreateEventTopic`) |
| `TaskExitEventTopic`   | MUST (follow `TaskStartEventTopic`)  |

([`docs/runtime-v2.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/runtime-v2.md) の Events 節)。「Start の結果を返す前に TaskExit が飛ぶ」ようなレースを防ぐために、created という中間状態が要る。

### containerd が spec を解釈しないのは、拡張を止めないため

もし containerd が `config.json` を構造体としてパースし、検証していたら、OCI Runtime Spec に新しいフィールドが入るたびに containerd の更新が必要になる。バイト列として素通しにしておけば、runc と クライアントが新機能を使い始めても containerd は無変更でよい。

代償は、不正な spec のエラーが shim/runc の層まで行かないと分からないこと。ただしその代わり、エラーメッセージは runc のものがそのまま返ってくる。

## どう活かすか

### 動いているコンテナの config.json を読む

トラブルシュートで最も情報量が多いのがこのファイルだ。

```sh
# 動いている shim から bundle を特定する
$ ps -ef | grep containerd-shim-runc-v2
# -id <container-id> と -namespace <ns> が引数に出る

$ jq '.process.args, .linux.namespaces, .mounts[].destination' \
    /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>/config.json
```

「Pod のマニフェストではこう書いたのに実際は違う」という食い違いは、CRI プラグインや NRI プラグインが spec を書き換えた結果であることが多い。最終的に runc に渡ったものはこのファイルにしかない。

### 「作る」と「動かす」を分ける API 設計

外部から観測・介入させたいリソースでは、生成と開始を分けて中間状態を作ると扱いやすくなる。

- 生成直後に ID を採番して呼び出し元に返せる
- 開始前に検証・書き換えのフックを差し込める
- 「作ったが動いていない」状態が観測できるので、失敗の切り分けが「生成の失敗」と「実行の失敗」に分かれる

containerd 自身も `Container` (メタデータ) と `Task` (実行) を別リソースにしていて、これは OCI の create/start 分離と同じ発想の一段上の適用になっている。
