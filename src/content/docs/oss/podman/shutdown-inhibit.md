---
title: "シグナルは無視せず「配送を遅らせる」。RWMutex の読み手を危険区間、書き手をハンドラにする"
description: "SIGINT / SIGTERM を 1 パッケージで受け、名前付きハンドラを登録の逆順に実行して終了する。DB の更新と外部リソース (conmon、mount、netns、ロック) の作成が対になっている区間は Inhibit で守り、シグナルは区間が終わってから処理する。実装は RWMutex の RLock と Lock の割り当てだけで、10 行で済む。"
group: "状態をプロセスの外に置く"
sidebar:
  order: 22
---

## 何を学んだか

### どんな状況の話か

Podman の 1 回の操作は、[SQLite への書き込み](../sqlite-state/)と外部リソースの操作が対になっている。コンテナ作成なら「[ロックを割り当て](../shm-lock-manager/)て、DB に行を足す」。起動なら「[conmon を起動](../conmon-supervision/)して、その pid を DB に書く」。DB は ACID だが、conmon のプロセスや mount や netns はトランザクションに入らない。この危険区間が `podman run` のどこにあるかは [`podman run` の全経路](../podman-run-walkthrough/) で見た 2 か所にあたる。その途中で SIGTERM を受けて死ぬと、DB とプロセスの実体が食い違う。

一方で、`podman run` で Ctrl-C したときはコンテナにシグナルを転送したいし、`podman system service` を `systemctl stop` したときは graceful に止めて終了コード 0 を返したい。シグナルの扱いはコマンドごとに違う。

### Podman の答え

1. **シグナル処理を 1 パッケージに集約し、ハンドラは名前付きで LIFO に登録する。** `libpod/shutdown` は 166 行。`Register("libpod", ...)` がストレージを閉じ、`Register("service", ...)` が API サーバを止める。後から登録した方が先に走るので、上位レイヤから閉じる順序が自然に得られる。
2. **危険区間は `Inhibit()` で守る。実装は `sync.RWMutex` の逆用。** 危険区間が `RLock`、シグナルハンドラが `Lock`。複数の危険区間が同時に走れて、シグナルは全部の区間が終わるまで待たされる。シグナルは捨てられず、区間が終われば必ず処理される。
3. **Inhibit する区間は 4 つ。** コンテナ作成 (ロック割り当て〜DB 追加)、`init()` (conmon 起動〜pid 保存)、`prepare()` (mount と netns の作成)、`cleanup()`。いずれも途中で死ぬと DB と実体が食い違う区間だ。
4. **長い処理は Inhibit ではなく「中断時に元に戻すハンドラ」を一時登録する。** `podman commit` はコンテナを pause してから撮るので、中断時に unpause するハンドラを登録し、終わったら外す。
5. **終了コードは「誰が止めたか」ではなく「正常に止まれたか」で決める。** 既定は 1。`system service` が graceful に止められたときだけ 0 にする。
6. **シグナルを自分で扱う経路では共通ハンドラを外す。** `--sig-proxy` (既定) はコンテナに転送するので `shutdown.Stop()` してから自前で捕まえる。

## ソースコードのどこか

### 状態とロック

[`libpod/shutdown/handler.go#L14-L36`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/shutdown/handler.go#L14-L36)。

```go title="libpod/shutdown/handler.go"
var (
	stopped    bool
	sigChan    chan os.Signal
	cancelChan chan bool
	// Synchronize accesses to the map
	handlerLock sync.Mutex
	// Definitions of all on-shutdown handlers
	handlers map[string]func(os.Signal) error
	// Ordering that on-shutdown handlers will be invoked.
	handlerOrder    []string
	shutdownInhibit sync.RWMutex
	logrus          = logrusImport.WithField("PID", os.Getpid())
	ErrNotStarted   = errors.New("shutdown signal handler has not yet been started")
	// exitCode used to exit once we are done with all signal handlers, by default 1
	exitCode = 1
)
```

### Start: シグナルを受けたら Lock して順に実行

[`#L38-L90`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/shutdown/handler.go#L38-L90)。

```go title="libpod/shutdown/handler.go"
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		select {
		case <-cancelChan:
			logrus.Infof("Received shutdown.Stop(), terminating!")
			signal.Stop(sigChan)
			close(sigChan)
			close(cancelChan)
			stopped = true
			return
		case sig := <-sigChan:
			logrus.Infof("Received shutdown signal %q, terminating!", sig.String())
			shutdownInhibit.Lock()
			handlerLock.Lock()

			for _, name := range handlerOrder {
				handler, ok := handlers[name]
				if !ok {
					logrus.Errorf("Shutdown handler %q definition not found!", name)
					continue
				}

				logrus.Infof("Invoking shutdown handler %q", name)
				start := time.Now()
				if err := handler(sig); err != nil {
					logrus.Errorf("Running shutdown handler %q: %v", name, err)
				}
				logrus.Debugf("Completed shutdown handler %q, duration %v", name,
					time.Since(start).Round(time.Second))
			}
			handlerLock.Unlock()
			shutdownInhibit.Unlock()
			os.Exit(exitCode)
			return
		}
	}()
```

`shutdownInhibit.Lock()` が、Inhibit 中の `RLock` がすべて解放されるまでブロックする。これが「遅延配送」の実体だ。`select` は 1 回しか回らないので、2 発目のシグナルはバッファに入るだけで無視される。Ctrl-C の連打で強制終了はできない。

### Inhibit と Uninhibit

[`#L111-L119`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/shutdown/handler.go#L111-L119)。

```go title="libpod/shutdown/handler.go"
// Inhibit temporarily inhibit signals from shutting down Libpod.
func Inhibit() {
	shutdownInhibit.RLock()
}

// Uninhibit stop inhibiting signals from shutting down Libpod.
func Uninhibit() {
	shutdownInhibit.RUnlock()
}
```

Go の `sync.RWMutex` は、書き手が待っていると新しい `RLock` をブロックする。だからシグナルが来たあとに新しく Inhibit を始めようとする goroutine は止まり、進行中の区間だけが完了する。ハンドラが飢えることはない。

### Register は LIFO

[`#L121-L140`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/shutdown/handler.go#L121-L140)。

```go title="libpod/shutdown/handler.go"
// Register registers a function that will be executed when Podman is terminated
// by a signal. Handlers are invoked LIFO - the last handler registered is the
// first run.
func Register(name string, handler func(os.Signal) error) error {
	handlerLock.Lock()
	defer handlerLock.Unlock()

	if handlers == nil {
		handlers = make(map[string]func(os.Signal) error)
	}

	if _, ok := handlers[name]; ok {
		return ErrHandlerExists
	}

	handlers[name] = handler
	handlerOrder = append([]string{name}, handlerOrder...)

	return nil
}
```

起動は `NewRuntime` ([`libpod/runtime.go#L212-L223`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L212-L223))。"libpod" ハンドラを登録してから `Start()` する。

```go title="libpod/runtime.go"
	if err := shutdown.Register("libpod", func(_ os.Signal) error {
		if runtime.store != nil {
			_, _ = runtime.store.Shutdown(false)
		}
		return nil
	}); err != nil && !errors.Is(err, shutdown.ErrHandlerExists) {
		logrus.Errorf("Registering shutdown handler for libpod: %v", err)
	}

	if err := shutdown.Start(); err != nil {
		return nil, fmt.Errorf("starting shutdown signal handler: %w", err)
	}
```

Register → Start の順には理由がある。コミット 5350254f05 (2021-01-25): "there was a small gap between Start and Register where SIGTERM/SIGINT would be completely ignored, instead of stopping Podman."

### Inhibit されている 4 箇所

コンテナ作成 ([`libpod/runtime_ctr.go#L340-L350`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_ctr.go#L340-L350))。

```go title="libpod/runtime_ctr.go"
	// Inhibit shutdown until creation succeeds
	shutdown.Inhibit()
	defer shutdown.Uninhibit()

	// Allocate a lock for the container
	lock, err := r.lockManager.AllocateLock()
	if err != nil {
		return nil, fmt.Errorf("allocating lock for new container: %w", err)
	}
	ctr.lock = lock
	ctr.config.LockID = ctr.lock.ID()
```

`init()` ([`libpod/container_internal.go#L1055-L1060`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L1055-L1060))。

```go title="libpod/container_internal.go"
	// To ensure that we don't lose track of Conmon if hit by a SIGTERM
	// in the middle of setting up the container, inhibit shutdown signals
	// until after we save Conmon's PID to the state.
	// TODO: This can likely be removed once conmon-rs support merges.
	shutdown.Inhibit()
	defer shutdown.Uninhibit()
```

`prepare()` ([`libpod/container_internal_linux.go#L58-L71`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal_linux.go#L58-L71)) と `cleanup()` ([`libpod/container_internal.go#L2176-L2179`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L2176-L2179)) も同じ形で、後者のコメントは "Ensure we are not killed half way through cleanup which can leave us in a bad state" だ。

### 長い処理は「元に戻すハンドラ」で

[`libpod/container_commit.go#L53-L71`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_commit.go#L53-L71)。

```go title="libpod/container_commit.go"
	if (c.state.State == define.ContainerStateRunning || c.state.State == define.ContainerStateStopping) && options.Pause {
		// The container lock is held, so no concurrent Commit can
		// register a handler with the same name.
		handlerName := fmt.Sprintf("commit-unpause-%s", c.ID())
		if err := shutdown.Register(handlerName, func(sig os.Signal) error {
			logrus.Debugf("Received %v, unpausing container %q", sig, c.ID())
			return c.unpause()
		}); err != nil && !errors.Is(err, shutdown.ErrHandlerExists) {
			logrus.Errorf("Registering shutdown handler for container %q: %v", c.ID(), err)
		}
		if err := c.pause(); err != nil {
			_ = shutdown.Unregister(handlerName)
			return nil, fmt.Errorf("pausing container %q to commit: %w", c.ID(), err)
		}
		defer func() {
			_ = shutdown.Unregister(handlerName)
			if err := c.unpause(); err != nil {
				logrus.Errorf("Unpausing container %q: %v", c.ID(), err)
			}
		}()
	}
```

commit はイメージのサイズ次第で長い。Inhibit で遅らせると Ctrl-C が効かなくなるので、中断を許し、中断時に pause を解く。`Unregister` は一度「使われていない」と削除され (コミット 5de7b7c3f3)、`podman cp` で mount した volume を中断時に unmount する用途で復活した (コミット 44b0c24ca5)。

### 終了コードの決め方

[`pkg/api/server/server.go#L229-L244`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/server/server.go#L229-L244)。

```go title="pkg/api/server/server.go"
	if err := shutdown.Register("service", func(_ os.Signal) error {
		s.grpc.GracefulStop()
		err := s.Shutdown(true)
		if err == nil {
			// For `systemctl stop podman.service` support, exit code should be 0
			// but only if we did indeed gracefully shutdown
			shutdown.SetExitCode(0)
		}
		return err
	}); err != nil {
		return err
	}
```

もう 1 箇所、`podman healthcheck run` ([`libpod/healthcheck.go#L270-L280`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck.go#L270-L280)) も 0 にする。[systemd の transient timer](../systemd-healthcheck/) から起動され、タイマーを作り直すと自分が SIGTERM で殺される、という特殊な事情による。

```go title="libpod/healthcheck.go"
	// This kills the process the healthcheck is running.
	// Which happens to be us.
	// So this has to be last - after this, systemd serves us a
	// SIGTERM and we exit.
	// Special case, via SIGTERM we exit(1) which means systemd logs a failure in the unit.
	// We do not want this as the unit will be leaked on failure states unless "reset-failed"
	// is called. Fundamentally this is expected so switch it to exit 0.
	// NOTE: This is only safe while being called from "podman healthcheck run" which we know
	// is the case here as we should not alter the exit code of another process that just
	// happened to call this.
	shutdown.SetExitCode(0)
```

### 自分でシグナルを扱う場面

`--sig-proxy` ([`pkg/domain/infra/abi/terminal/sigproxy_commn.go#L17-L24`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/terminal/sigproxy_commn.go#L17-L24))。

```go title="pkg/domain/infra/abi/terminal/sigproxy_commn.go"
func ProxySignals(ctr *libpod.Container) {
	// Stop catching the shutdown signals (SIGINT, SIGTERM) - they're going
	// to the container now.
	shutdown.Stop() //nolint: errcheck

	sigBuffer := make(chan os.Signal, signal.SignalBufferSize)
	signal.CatchAll(sigBuffer)
```

`podman kube play --wait` ([`cmd/podman/kube/play.go#L307-L312`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/kube/play.go#L307-L312)) も同じで、`shutdown.Stop()` してから自前で SIGTERM を捕まえ、Pod を止めて消す。通常の終了経路 ([`cmd/podman/root.go#L138-L168`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/root.go#L138-L168)) では、cobra の実行が終わったら `shutdown.Stop()` を呼んでからエンジンを閉じる。閉じている最中に SIGTERM が来てもハンドラは二重に走らない。

## なぜそうなっているか

- **導入時の動機が 2 つ書かれている。** コミット 8381f3feee (2020-10-12, Matthew Heon) "Add a shutdown handler package": "We need to be able to do different things on receiving such a signal (`system service` wants to shut down the service gracefully, while most other commands just want to exit) and we need to be able to inhibit this shutdown signal while we are waiting for some critical operations (e.g. creating a container) to finish." 続くコミット 83e6e4ccdd はコンテナ作成に Inhibit を入れ、同時に `--sig-proxy` では共通ハンドラを外している (issue #7941)。
- **LIFO は 2 つのハンドラを共存させるため。** コミット f58d2f5e75 "Enforce LIFO ordering for shutdown handlers": "This allows us to run both the Libpod and Server handlers at the same time without unregistering one."
- **終了コードの規則は一度間違えて直した。** コミット ca7376bb11 (2022-03-10) は `systemctl stop podman.service` を成功させるために SIGTERM で 0 を返すようにしたが、コミット 0bbef4b830 (2024-09-26, Paul Holzinger) がそれを戻した: "Currently podman run -d can exit 0 if we send SIGTERM during startup even though the contianer was never started. That just doesn't make any sense is horribly confusing for a external job manager like systemd ... we default to exit code 1 like we did before and allow the service exit handler to overwrite the exit code 0 in case of a graceful shutdown." 「誰が止めたか」ではなく「正常に止まれたか」で決める形に落ち着いた。
- **Inhibit は SIGKILL には効かない。** [conmon のページ](../conmon-supervision/)の `waitForConmonToExitAndSave` や `--stopped-only`、[ロックのページ](../shm-lock-manager/)の robust mutex は、Inhibit で守れない死に方への備えだ。遅延 → 事後回復 → ロック回復の 3 層になっている。

## どう活かすか

- シグナル処理を 1 パッケージに集約し、ハンドラは名前付き・LIFO で登録する。上位レイヤ (サーバ) が下位レイヤ (ストレージ) より先に閉じる順序が、登録順から自然に得られる。
- 「シグナルを無視する」のではなく「配送を遅らせる」。RWMutex の `RLock` を危険区間、`Lock` をハンドラに割り当てるだけで、複数区間の同時進行と飢餓の回避が手に入る。
- 危険区間を「永続ストアの更新と、外部リソースの作成・破棄が対になっている区間」と定義する。ロックの割り当て、子プロセスの起動、mount、netns、後始末。
- 長い処理は Inhibit ではなく「中断時に元に戻すハンドラ」の一時登録にする。Ctrl-C が数秒効かないのは許容できても、数十秒は許容できない。
- 終了コードは「正常に止まれたか」で決める。既定を失敗 (1) にし、graceful に止まれた経路だけが 0 を上書きする。
- シグナルを自分で扱う経路 (転送、独自の後始末) では、共通ハンドラを明示的に外す。
- 取り込むべきでない条件: ライブラリ側で `os.Exit` を呼ぶ設計は、他のプログラムに組み込まれる場合に問題になる。Podman は「libpod は Podman 専用」と割り切っている。パッケージ変数ベースの単一インスタンスなので、1 プロセスに複数の独立したシャットダウン文脈が要る場合には向かない。そして Inhibit を入れても、SIGKILL や OOM からの事後回復のコードは省略できない。
