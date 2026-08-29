---
title: "shim manager と task manager の分業"
description: "shim を起動して接続を管理するのが ShimManager、bundle を作ってタスクを作るのが TaskManager。プラグインが 2 つに分かれているのは、sandbox が「タスクなしで shim だけ動かす」ことを必要としたからだ。Create の中では、起動順序と後始末の登録順序が慎重に組まれている。"
group: "コンテナを実行する"
sidebar:
  order: 42
---

## 何を学んだか

### プラグインが 2 段になっている

| プラグイン                      | 型                | 責務                                                      |
| ------------------------------- | ----------------- | --------------------------------------------------------- |
| `io.containerd.shim.v1.manager` | `ShimPlugin`      | shim バイナリの解決、起動、接続の保持、再接続             |
| `io.containerd.runtime.v2.task` | `RuntimePluginV2` | bundle の作成、マウントの活性化、`TaskService` の呼び出し |

TaskManager は ShimManager に依存する。「shim を起動する」ことと「その上でタスクを作る」ことが分離されている。

分離の理由は sandbox だ。[Sandbox API](../sandbox-api/) では、**タスクを持たない shim** が先に起動して、後からコンテナが入ってくる。「shim = タスク 1 個」という前提が崩れたので、層を分ける必要があった。

### Create の中の順序が細かく組まれている

`TaskManager.Create` の流れ。

1. bundle を作る (失敗したら削除する defer を登録)
2. **マウントの後始末の defer を、shim 起動より先に登録する**
3. shim を起動する (失敗したら shim を片付ける defer を登録)
4. shim の能力申告を受け取る
5. マウントを活性化する
6. ランタイムの機能を検証する
7. `TaskService.Create` を呼ぶ

2 の位置が重要で、コメントに理由が書かれている。

### shim が先、マウントが後

3 と 5 の順序も意図的だ。**shim を起動してからマウントを活性化する**。shim が「この型のマウントは自分でやる」と申告する機会を先に与えるためで、そうしないと containerd が余計なマウントをしてしまう ([mount manager](../mount-manager/))。

### API バージョンのダウングレード

`TaskService.Create` が `ErrNotImplemented` を返したら、**クライアント側の API バージョンを下げて再試行する**。新しい containerd と古い shim の組み合わせで動くようにするための経路だ。

## ソースコードのどこか

### プラグインの依存関係

[`core/runtime/v2/task_manager.go#L56-L70`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/task_manager.go#L56-L70)。

```go title="core/runtime/v2/task_manager.go"
	registry.Register(&plugin.Registration{
		Type: plugins.RuntimePluginV2,
		ID:   "task",
		Requires: []plugin.Type{
			plugins.ShimPlugin,
			plugins.MountManagerPlugin,
			plugins.WarningPlugin,
		},
```

mount manager への依存は **任意** になっている。

```go title="core/runtime/v2/task_manager.go"
			var mounts mount.Manager
			if mountsI, err := ic.GetSingle(plugins.MountManagerPlugin); err == nil {
				mounts = mountsI.(mount.Manager)
			} else if !errors.Is(err, plugin.ErrPluginNotFound) {
				return nil, err
			}
```

見つからなければ nil のまま進む。`ErrPluginNotFound` だけを許容し、他のエラーは失敗させる。**「無効化されている」と「壊れている」を区別する** 書き方だ。

初期化時に既存の shim を読み込む。

```go title="core/runtime/v2/task_manager.go"
			if err := shimManager.LoadExistingShims(ic.Context, state, root); err != nil {
				return nil, fmt.Errorf("failed to load existing shims for task manager")
			}
```

デーモン起動時に、ディスク上の bundle から shim を復元する ([containerd が死んでもコンテナは死なない](../shim-reconnect/))。

`log-uri-schemes` を Exports に載せているのも見どころで、対応するログ URI スキームを introspection API から問い合わせられる。

```go title="core/runtime/v2/task_manager.go"
			ic.Meta.Exports["log-uri-schemes"] = strings.Join(supportedLogURISchemes(), ",")
```

### ディレクトリのパーミッション

```go title="core/runtime/v2/task_manager.go"
			for _, d := range []string{root, state} {
				// root:  the parent of this directory is created as 0o700, not 0o711.
				// state: the parent of this directory is created as 0o711 too, so as to support userns-remapped containers.
				if err := os.MkdirAll(d, 0711); err != nil {
					return nil, err
				}
			}
```

`0711` (実行のみ許可) にする理由がコメントにある。user namespace で remap されたコンテナは、ホスト側では別の UID で動く。そのプロセスが自分の bundle に到達するには、途中のディレクトリに **通り抜け権限** が要る。読み取りは許さず、通り抜けだけを許す。

### 後始末の登録順序

[`core/runtime/v2/task_manager.go#L159-L200`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/task_manager.go#L159-L200)。

```go title="core/runtime/v2/task_manager.go"
	// Registered before the shim is started so that it runs after the shim
	// cleanup below: the shim may still be using these mounts.
	var activation mountActivation
	defer func() {
		if retErr != nil && activation.owned {
			dctx, cancel := timeout.WithContext(context.WithoutCancel(ctx), cleanupTimeout)
			defer cancel()
			if err := m.taskMounts.Deactivate(dctx, taskID); err != nil {
```

Go の `defer` は **後入れ先出し** なので、先に登録したものが後に実行される。マウントの解除を shim の片付けより後に走らせたいので、先に登録する。

理由はコメント通り「shim がまだそのマウントを使っているかもしれない」。マウント中のディレクトリを使っているプロセスがいると、アンマウントが失敗する。

`context.WithoutCancel` + タイムアウトで、**キャンセル済みのコンテキストでも後始末を実行する**。

### shim を先に起動する理由

```go title="core/runtime/v2/task_manager.go"
	// The shim is started before its mounts are activated so that it can report
	// which mount types and transforms it performs itself, which decides what
	// the mount manager must do on its behalf. Starting the shim does not
	// require the rootfs; only the task.Create call below consumes opts.Rootfs.
	shim, err := m.manager.Start(ctx, taskID, bundle, opts)
```

「shim の起動に rootfs は不要で、rootfs を消費するのは下の `task.Create` だけ」。だから順序を入れ替えられる。

**依存関係を精査して順序を決めている** ことが分かる。何となく並んでいるのではない。

```go title="core/runtime/v2/task_manager.go"
	var bootstrap *bootapi.BootstrapResult
	if sc, ok := shim.(shimCapabilities); ok {
		bootstrap = sc.BootstrapResult()
	}
	activation, err = m.taskMounts.Activate(ctx, taskID, opts.Runtime, bootstrap, opts.Rootfs)
	if err != nil {
		return nil, err
	}
	opts.Rootfs = activation.rootfs
```

インターフェースアサーションで能力を取り出し、それを見てマウントを活性化する。結果の `rootfs` が `opts` に差し戻され、`task.Create` に渡る。

### バージョンのダウングレード

```go title="core/runtime/v2/task_manager.go"
	t, err := func() (runtime.Task, error) {
		t, err := shimTask.Create(ctx, opts)
		if err == nil || !errdefs.IsNotImplemented(err) {
			return t, err
		}

		downgrader, ok := shim.(clientVersionDowngrader)
		if ok {
			if derr := downgrader.Downgrade(); derr == nil {
				log.G(ctx).WithError(err).WithField("id", taskID).
					Warning("failed to call task.Create, downgrading client API version to try again")

				shimTask, err = newShimTask(shim)
				...
				return shimTask.Create(ctx, opts)
			}
		}
		return t, err
	}()
```

`ErrNotImplemented` を「相手が古い」の合図として使い、**API バージョンを 1 つ落として再試行する**。1 回だけの試行で、それでも駄目なら諦める。

無名関数で囲っているのは、`err` の扱いを局所化するため。ダウングレードの試行が外側のエラーハンドリングを汚さない。

### 失敗経路の集約

```go title="core/runtime/v2/task_manager.go"
// cleanupStartedShim tears down a shim that was started for a task which then
// failed to be created. It may be called before a *shimTask exists for shim,
// since it also covers the window between a successful shim start and
// taskMounts.Activate/newShimTask succeeding.
func (m *TaskManager) cleanupStartedShim(ctx context.Context, taskID string, shim ShimInstance) {
	// NOTE: ctx contains required namespace information.
	m.manager.shims.Delete(ctx, taskID)

	shimTask, err := newShimTask(shim)
	if err != nil {
		log.G(ctx).WithError(err).WithField("id", taskID).
			Error("failed to create shim task to clean up shim")
		shim.Close()
		return
	}
```

コメントが対象範囲を明示している。「shim の起動成功から `Activate` / `newShimTask` の成功までの窓も対象」。

`newShimTask` が失敗する (shim と通信できない) 場合でも `shim.Close()` で接続を閉じる。**後始末自体が失敗しうる前提** で書かれている。

## なぜそうなっているか

### 層を分けたのは sandbox のため

runtime v2 が導入された当初は「1 shim = 1 タスク」だった。TaskManager が shim の起動も担当していて問題なかった。

sandbox が入って「タスクなしで shim を起動する」「1 shim に複数タスク」が必要になり、shim のライフサイクルとタスクのライフサイクルが分離した。プラグインを分けたのはその帰結だ。

結果として、sandbox controller も ShimManager を直接使える ([sandbox controller の 2 つの実装](../sandbox-controllers/))。

### defer の順序で後始末の順序を表す

Go の `defer` は LIFO なので、**登録順を逆にすれば実行順が制御できる**。containerd はこの性質を積極的に使い、コメントで意図を明示している。

```go
defer マウント解除の登録   // 3 番目に実行される
defer shim 片付けの登録    // 2 番目に実行される
defer bundle 削除の登録    // ... 実際は bundle が最初に登録されている
```

エラーハンドリングを `if err != nil { 全部片付ける }` と書くと、途中で失敗した場合の分岐が爆発する。defer を積み上げる形なら、**成功した分だけが後始末される** ことが自動的に保証される。

### 「知らないふり」ができるインターフェースアサーション

`shimCapabilities`、`clientVersionDowngrader` はいずれも任意のインターフェースで、実装していれば追加の機能が使われる。

```go
if sc, ok := shim.(shimCapabilities); ok {
```

新しい能力を足すときに、既存の実装を壊さない。Go のインターフェースアサーションは、**後方互換な機能追加の手段** として containerd の随所で使われている ([削除はメタデータだけ先に済ませ、実体は後で消す](../deferred-cleanup/) の `snapshots.Cleaner` も同じ形)。

## どう活かすか

### タスクと shim を別々に見る

```sh
# タスク (containerd が知っている実行中のもの)
$ ctr -n k8s.io tasks ls

# shim プロセス
$ ps -ef | grep containerd-shim
```

数が一致しないことがある。Pod のグルーピングで 1 shim 複数タスクになっている場合と、タスクは死んだが shim が残っている場合がある。後者は異常なので、bundle の状態を確認する。

### 「後始末を defer で積む」パターン

複数段階の初期化を伴う処理で、この書き方は有効だ。

- **各段階の成功直後に、その段階の後始末を defer で登録する**
- **`retErr != nil` を条件にする** — 成功時は後始末しない
- **登録順序で実行順序を制御する** — 依存の逆順に解放する
- **後始末には `context.WithoutCancel` とタイムアウトを使う** — キャンセル済みでも実行する
- **順序に理由があるなら、コメントで書く** — 後から並べ替えられないように

4 番目を忘れると、「エラーでコンテキストがキャンセルされ、後始末の API 呼び出しも失敗する」という嫌な失敗をする。containerd はこれを全体で徹底している。
