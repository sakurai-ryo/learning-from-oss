---
title: "sandbox controller の 2 つの実装"
description: "shim controller は shim バイナリを起動して SandboxService を喋らせる。podsandbox controller は containerd のクライアント API で pause コンテナを作る。前者が目指す形、後者が移行前の現実で、片方は containerd コアに、もう片方は CRI プラグインの中にいる。"
group: "サンドボックスと CRI"
sidebar:
  order: 55
---

## 何を学んだか

### 2 つの実装の位置が違う

| Controller   | プラグイン                                          | 場所                              | 実装方法                                                |
| ------------ | --------------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| `shim`       | `io.containerd.sandbox.controller.v1.shim`          | `plugins/sandbox/`                | shim バイナリを起動し、`SandboxService` を ttrpc で呼ぶ |
| `podsandbox` | `io.containerd.podsandbox.controller.v1.podsandbox` | `internal/cri/server/podsandbox/` | containerd クライアントで pause コンテナを作る          |

**プラグインの型からして違う**。`podsandbox` は専用の型 (`PodSandboxPlugin`) を持ち、CRI の内部にいる。

[`docs/sandbox-api.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/sandbox-api.md) が正直に説明している。

```markdown title="docs/sandbox-api.md"
The `podsandbox` controller technically satisfies the `Controller` interface, but in practice it acts as an
in-memory implementation tightly coupled to the CRI layer.
```

### shim controller は薄い

`shim` controller の実装は、ほぼ全部が「ShimManager に投げて、ttrpc を呼ぶ」だけだ。

```
Create  → NewBundle → ShimManager.Start → SandboxService.CreateSandbox
Start   → ShimManager.Get → SandboxService.StartSandbox
Stop    → SandboxService.StopSandbox
Status  → SandboxService.SandboxStatus
```

**判断は shim 側にある**。containerd は仲介するだけ。

### podsandbox controller は厚い

一方 `podsandbox` は、pause コンテナのイメージを引き、OCI spec を組み立て、コンテナを作り、タスクを起動する。つまり **containerd のクライアントとして振る舞う**。

だから `WithInMemoryServices` で containerd クライアントを作っている ([CRI: kubelet がランタイムに要求する輪郭](../cri-interface/))。

### 選択は sandboxer 名で

`Sandbox.Sandboxer` フィールドにどの Controller を使うかが記録される。既定は `shim`。

```go
// DefaultSandboxer defines the default sandboxer to use for creating sandboxes.
DefaultSandboxer = "shim"
```

CRI の設定でランタイムごとに切り替えられる。

## ソースコードのどこか

### shim controller の登録

[`plugins/sandbox/controller.go#L35-L82`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/sandbox/controller.go#L35-L82)。

```go title="plugins/sandbox/controller.go"
	registry.Register(&plugin.Registration{
		Type: plugins.SandboxControllerPlugin,
		ID:   "shim",
		Requires: []plugin.Type{
			plugins.ShimPlugin,
			plugins.EventPlugin,
		},
		InitFn: func(ic *plugin.InitContext) (any, error) {
			shimPlugin, err := ic.GetSingle(plugins.ShimPlugin)
			...
			if err := shims.LoadExistingShims(ic.Context, state, root); err != nil {
				return nil, fmt.Errorf("failed to load existing shim sandboxes, %v", err)
			}
```

**ShimManager を直接使う**。TaskManager を経由しない ([shim manager と task manager の分業](../shim-task-manager/))。

`LoadExistingShims` を自分でも呼ぶ。sandbox 用の state ディレクトリは task 用とは別なので、それぞれが自分の分を復元する。

依存が 2 つだけなのが、この Controller の薄さを表している。

### Create の流れ

[`plugins/sandbox/controller.go#L123-L172`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/sandbox/controller.go#L123-L172)。

```go title="plugins/sandbox/controller.go"
	if _, err := c.shims.Get(ctx, sandboxID); err == nil {
		return fmt.Errorf("sandbox %s already running: %w", sandboxID, errdefs.ErrAlreadyExists)
	}

	bundle, err := v2.NewBundle(ctx, c.root, c.state, sandboxID, info.Spec)
	...
	shim, err := c.shims.Start(ctx, sandboxID, bundle, runtime.CreateOpts{
		Spec:           info.Spec,
		RuntimeOptions: info.Runtime.Options,
		Runtime:        info.Runtime.Name,
		TaskOptions:    nil,
	})
```

**タスクと同じ bundle の仕組みを使う** ([bundle: ディスク上に置かれた実行単位](../bundle/))。sandbox にも `config.json` があり、`rootfs/` がある。

`TaskOptions: nil` に注目したい。タスクではないので、タスク固有のオプションを渡さない。

```go title="plugins/sandbox/controller.go"
	svc, err := sandbox.NewClient(shim.Client())
	...
	if _, err := svc.CreateSandbox(ctx, &runtimeAPI.CreateSandboxRequest{
		SandboxID:   sandboxID,
		BundlePath:  shim.Bundle(),
		Rootfs:      mount.ToProto(coptions.Rootfs),
		Options:     typeurl.MarshalProto(coptions.Options),
		NetnsPath:   coptions.NetNSPath,
		Annotations: coptions.Annotations,
	}); err != nil {
		c.cleanupShim(ctx, sandboxID, svc)
		return fmt.Errorf("failed to create sandbox %s: %w", sandboxID, errgrpc.ToNative(err))
	}
```

同じ shim 接続に `SandboxService` のクライアントを載せる。**shim は `TaskService` と `SandboxService` の両方を提供する** ([sandbox と task が 1 つの shim に同居する](../sandbox-shim-sharing/))。

失敗したら `cleanupShim` で shim を片付ける。ここでも「作った分を片付ける」が徹底されている。

`errgrpc.ToNative(err)` でエラーを変換しているのは、ttrpc/gRPC のステータスコードを containerd のエラー型に戻すためだ ([errdefs: エラーの意味を境界で保つ](../errdefs/))。

### Start は接続を引くだけ

```go title="plugins/sandbox/controller.go"
func (c *controllerLocal) Start(ctx context.Context, sandboxID string) (sandbox.ControllerInstance, error) {
	shim, err := c.shims.Get(ctx, sandboxID)
	if err != nil {
		return sandbox.ControllerInstance{}, fmt.Errorf("unable to find sandbox %q", sandboxID)
	}
	...
	resp, err := svc.StartSandbox(ctx, &runtimeAPI.StartSandboxRequest{SandboxID: sandboxID})
	...
	address, version := shim.Endpoint()
	return sandbox.ControllerInstance{
		SandboxID: sandboxID,
		Pid:       resp.GetPid(),
		Address:   address,
		Version:   uint32(version),
		CreatedAt: resp.GetCreatedAt().AsTime(),
		Spec:      resp.GetSpec(),
	}, nil
}
```

戻り値の `Address` が **shim のエンドポイント** だ。これが sandbox のメタデータに保存され、後でコンテナを作るときに再利用される。

`Spec` を shim が返しているのが興味深い。shim が sandbox の spec を書き換えることがあり、その結果が containerd に戻る。

### podsandbox controller の依存

[`internal/cri/server/podsandbox/controller.go#L45-L105`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/internal/cri/server/podsandbox/controller.go#L45-L105)。

```go title="internal/cri/server/podsandbox/controller.go"
	registry.Register(&plugin.Registration{
		Type: plugins.PodSandboxPlugin,
		ID:   "podsandbox",
		Requires: []plugin.Type{
			plugins.EventPlugin,
			plugins.LeasePlugin,
			plugins.SandboxStorePlugin,
			plugins.TransferPlugin,
			plugins.CRIServicePlugin,
			plugins.ServicePlugin,
			plugins.WarningPlugin,
		},
```

依存が 7 つ。`TransferPlugin` (イメージの取得) まで必要としている — **pause イメージを pull する** からだ。

`shim` controller の依存が 2 つだったのと対照的で、この Controller が「containerd のクライアント」として振る舞っていることが依存関係に現れている。

```go title="internal/cri/server/podsandbox/controller.go"
			// There is no need to subscribe to the exit event for the pause container,
			// as a dedicated goroutine already monitors the sandbox exit event.
			// The eventMonitor handles the backoff mechanism in case the pause container cleanup fails.
			c.eventMonitor = events.NewEventMonitor(
				&podSandboxEventHandler{
					controller: &c,
				},
			)
			c.eventMonitor.Start()
```

pause コンテナの終了を監視する仕組みを自前で持つ。**「sandbox の終了」を「pause コンテナの終了」として実装している** ことが分かる。

コメントが「exit イベントの購読は不要、専用の goroutine が監視している」と説明していて、二重監視を避ける意図が読める。

### 既定値

[`defaults/defaults.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/defaults/defaults.go)。

```go title="defaults/defaults.go"
	// DefaultSandboxer defines the default sandboxer to use for creating sandboxes.
	DefaultSandboxer = "shim"
```

既定が `shim` になっている。ただし CRI プラグインの設定で、ランタイムごとに `podsandbox` を選べる。

`runc` を使う通常の Pod は、実際には `podsandbox` (pause コンテナ) を使うことが多い。`shim` sandboxer は、shim が `SandboxService` を実装している場合に選ばれる。

## なぜそうなっているか

### 2 つの実装が並存する理由

理想は「すべてが `shim` controller」だ。しかし pause コンテナ方式は、

- 既に広く動いている
- CRI プラグインの多くのコードがこの前提で書かれている
- 移行にはコンテナのライフサイクル管理の書き換えが要る

一度に切り替えるのはリスクが高い。だから **インターフェースだけ先に整え、実装の移行を段階的に進めている**。

`podsandbox` が `Controller` を満たしているので、CRI 層は「どちらの Controller か」を意識せずに書ける。移行が完了すれば、CRI 層のコードを変えずに実装を消せる。

### 薄い実装と厚い実装

`shim` controller が薄いのは、判断を shim に委ねているからだ。VM を起動するか、プロセスを起動するか、何もしないかは shim が決める。

`podsandbox` が厚いのは、pause コンテナという **具体的な実装を持っている** からだ。イメージを引き、spec を作り、コンテナを起動する。

**抽象の向こう側に具体を置くと、抽象を実装する側が薄くなる**。逆に、抽象の中に具体を書くと厚くなる。containerd はこの 2 つを同居させ、前者への移行を進めている。

### 依存関係が実装の性質を語る

プラグインの `Requires` を見るだけで、その実装が何をするかが分かる。

- `shim` controller: ShimPlugin, EventPlugin → **shim を起動してイベントを出す**
- `podsandbox`: Transfer, Lease, CRIService, ... → **イメージを引いてコンテナを作る**

[プラグインの依存を型で宣言する](../plugin-graph/) 設計が、コードを読む前の見取り図としても機能している。

## どう活かすか

### どの controller が使われているか

```sh
# sandbox の詳細 (sandboxer フィールド)
$ ctr -n k8s.io sandboxes ls

# CRI の設定
$ containerd config dump | grep -A5 sandboxer
```

`podsandbox` なら pause コンテナが存在する。`crictl ps -a` には出ないが、`ctr -n k8s.io containers ls` には出る。

```sh
$ ctr -n k8s.io containers ls | grep pause
```

### VM ランタイムを使うとき

Kata Containers のようなランタイムでは `shim` sandboxer を使う。

```toml
version = 3
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.kata]
  runtime_type = "io.containerd.kata.v2"
  sandboxer = "shim"
```

この場合 pause コンテナは作られず、VM が sandbox になる。`ctr containers ls` に pause が現れない。

### 「移行のために抽象を先に入れる」

大きな設計変更を段階的に進めるときの型として、containerd の sandbox API は参考になる。

- **先にインターフェースを定義し、既存実装をそれに合わせる** — 動作は変えない
- **利用側をインターフェース経由に書き換える** — ここまでで実装の差し替えが可能になる
- **新しい実装を追加する** — 既存と並存させる
- **段階的に移行し、最後に古い実装を消す**

containerd は 1.7 で 1〜2 を、2.0 で 3 をやり、まだ 4 の途中にいる。**数年かかる移行**でも、各段階で動くものが保たれている。

「技術的負債として残っている」ことをドキュメントに明記しているのも重要で、読む人が「これが理想形だ」と誤解しない。
