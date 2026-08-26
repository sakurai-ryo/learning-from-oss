---
title: "コンテナの監視を小さな別プロセスに委ね、CLI 自身はいつ終了してもよい設計にする"
description: "podman run はコンテナの親ではない。コンテナごとに conmon という小さなプロセスを起動し、conmon が OCI ランタイムを fork して親になる。Podman は conmon が double fork を終えるのを待つだけで終了できる。終了の通知はファイルシステム (exit file) と「後始末コマンドを新しい Podman プロセスとして起動する」ことで行い、状態の真実は exit file の有無と conmon の pid が生きているかだけ。"
sidebar:
  order: 1
---

## 何を学んだか

### どんな状況の話か

Docker には `dockerd` という常駐デーモンがいて、コンテナプロセスの親としてそれを監視し、終了コードを受け取り、ログを書き、後始末をする。Podman はこのデーモンを持たない。`podman run -d nginx` を実行したプロセスは、コンテナを起動したら終了する。では、コンテナが終わったことを誰が知り、誰が後始末をするのか。

### Podman の答え

1. **コンテナごとに conmon を 1 つ起動し、それをコンテナの親にする。** conmon は C 製の小さなプロセスで、OCI ランタイム (crun / runc) を fork/exec し、コンテナの stdio を持ち、ログを書き、終了を待つ。Podman は conmon が double fork して一段目の親が終了するのを `cmd.Wait()` で待つだけで、そのあとは自由に終了できる。
2. **起動時の同期は 2 本のソケットペアで最小限に。** start pipe に 1 バイト書くのが「cgroup の配置が済んだので進んでよい」の合図、sync pipe から 1 行の JSON を読むのが「コンテナの PID (または失敗)」の受信。
3. **終了の通知はファイルと新プロセスで。** conmon はコンテナが終わると `<tmpdir>/exits/<id>` に終了コードを書き、`--exit-command` で渡された `podman container cleanup --stopped-only <id>` を新しい Podman プロセスとして起動する。監視主体が短命な CLI ではなく別プロセスなので、`podman run -d` が終了していても後始末される。
4. **状態の真実は exit file と conmon の pid。** すべての API 操作は最初に `syncContainer()` を呼び、DB から状態を読み、exit file があれば Running → Stopped に遷移させて DB に書き戻す。conmon が生きているかは `kill(pid, 0)` で確かめる。
5. **conmon が exit file を書かずに死んだ場合の救済経路も持つ。** コンテナのプロセスがまだ生きていれば OCI ランタイムで殺し、終了コード -1 で Stopped にして、後始末を自分で呼ぶ。
6. **終了待ちは pidfd で。** Podman は conmon の親ではないので `waitpid` できない。Linux 5.3 以降の `pidfd_open` で親子関係なしに終了を待つ。

## ソースコードのどこか

### 設計の宣言: OCIRuntime は薄いラッパー

[`libpod/oci.go#L12-L20`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci.go#L12-L20)。

```go title="libpod/oci.go"
// OCIRuntime is an implementation of an OCI runtime.
// The OCI runtime implementation is expected to be a fairly thin wrapper around
// the actual runtime, and is not expected to include things like state
// management logic - e.g., we do not expect it to determine on its own that
// calling 'UnpauseContainer()' on a container that is not paused is an error.
// The code calling the OCIRuntime will manage this.
// TODO: May want to move the conmon cleanup code here - it depends on
// Conmon being in use.
type OCIRuntime interface { //nolint:interfacebloat
```

インターフェースの契約 ([`#L114-L162`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci.go#L114-L162)) には exit file が明記されている。

```go title="libpod/oci.go"
	// ExitFilePath is the path to a container's exit file.
	// All runtime implementations must create an exit file when containers
	// exit, containing the exit code of the container (as a string).
	// This is the path to that file for a given container.
	ExitFilePath(ctr *Container) (string, error)

	// OOMFilePath is the path to a container's oom file if it was oom killed.
	// An oom file is only created when the container is oom killed. The existence
	// of this file means that the container was oom killed.
	// This is the path to that file for a given container.
	OOMFilePath(ctr *Container) (string, error)
```

「終了コードを文字列で書いたファイル」「存在すれば OOM」という、ファイルシステムを通信路にした契約だ。

### conmon の起動

[`libpod/oci_conmon_common.go#L995-L1009`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L995-L1009) で 2 本のソケットペアを作る。

```go title="libpod/oci_conmon_common.go"
func (r *ConmonOCIRuntime) createOCIContainer(ctr *Container, restoreOptions *ContainerCheckpointOptions) (int64, error) {
	var stderrBuf bytes.Buffer

	parentSyncPipe, childSyncPipe, err := newPipe()
	if err != nil {
		return 0, fmt.Errorf("creating socket pair: %w", err)
	}
	defer errorhandling.CloseQuiet(parentSyncPipe)

	childStartPipe, parentStartPipe, err := newPipe()
	if err != nil {
		return 0, fmt.Errorf("creating socket pair for start pipe: %w", err)
	}

	defer errorhandling.CloseQuiet(parentStartPipe)
```

`newPipe` ([`#L1395-L1402`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1395-L1402)) は `SOCK_SEQPACKET` の socketpair で、メッセージ境界を保つ。

conmon に渡す引数は [`#L1300-L1321`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1300-L1321) の `sharedConmonArgs`。

```go title="libpod/oci_conmon_common.go"
	// set the conmon API version to be able to use the correct sync struct keys
	args := []string{
		"--api-version", "1",
		"-c", ctr.ID(),
		"-u", cuuid,
		"-r", r.path,
		"-b", bundlePath,
		"-p", pidPath,
		"-n", ctr.Name(),
		"--exit-dir", exitDir,
		"--persist-dir", persistDir,
		"--full-attach",
	}
```

`-r` が OCI ランタイムのパス、`-p` がコンテナの pid ファイル、`--exit-dir` が exit file の置き場。ログドライバも conmon の引数で決まる。Podman がいなくなっても stdout/stderr が k8s-file や journald に流れ続けるのは、コンテナの stdio を持っているのが conmon だからだ。

後始末コマンドは [`#L1063-L1072`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1063-L1072)。

```go title="libpod/oci_conmon_common.go"
	exitCommand, err := specgenutil.CreateExitCommandArgs(ctr.runtime.storageConfig, ctr.runtime.config, ctr.runtime.syslog || logrus.IsLevelEnabled(logrus.DebugLevel), ctr.AutoRemove(), ctr.AutoRemoveImage(), false)
	if err != nil {
		return 0, err
	}
	exitCommand = append(exitCommand, ctr.config.ID)

	args = append(args, "--exit-command", exitCommand[0])
	for _, arg := range exitCommand[1:] {
		args = append(args, []string{"--exit-command-arg", arg}...)
	}
```

組み立てる側 [`pkg/specgenutil/util.go#L303-L336`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgenutil/util.go#L303-L336)。

```go title="pkg/specgenutil/util.go"
func CreateExitCommandArgs(storageConfig storageTypes.StoreOptions, config *config.Config, syslog, rm, rmi, exec bool) ([]string, error) {
	// We need a cleanup process for containers in the current model.
	// But we can't assume that the caller is Podman - it could be another
	// user of the API.
	// As such, provide a way to specify a path to Podman, so we can
	// still invoke a cleanup process.

	podmanPath, err := os.Executable()
	if err != nil {
		return nil, err
	}

	command := append([]string{podmanPath}, GlobalPodmanArgs(storageConfig, config, syslog)...)

	// --stopped-only is used to ensure we only cleanup stopped containers and do not race
	// against other processes that did a cleanup() + init() again before we had the chance to run
	command = append(command, "container", "cleanup", "--stopped-only")
```

「現在のモデルでは後始末プロセスが要る」と正直に書いてある。`--stopped-only` は、cleanup が非同期に走るあいだに別の Podman が cleanup と再起動を済ませてしまった場合に、古い cleanup が新しいコンテナを壊さないためのガードだ (コミット a89fef6e2a, issue #23754)。

起動と fd の継承は [`#L1138-L1148`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1138-L1148) と [`#L1159-L1164`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1159-L1164)。

```go title="libpod/oci_conmon_common.go"
	cmd.Env = r.conmonEnv
	// we don't want to step on users fds they asked to preserve
	// Since 0-2 are used for stdio, start the fds we pass in at preserveFDs+3
	cmd.Env = append(cmd.Env, fmt.Sprintf("_OCI_SYNCPIPE=%d", preserveFDs+3), fmt.Sprintf("_OCI_STARTPIPE=%d", preserveFDs+4))
	cmd.Env = append(cmd.Env, conmonEnv...)
	cmd.ExtraFiles = append(cmd.ExtraFiles, childSyncPipe, childStartPipe)
```

### 合図 → 待機 → PID 受信

[`#L1208-L1249`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1208-L1249)。

```go title="libpod/oci_conmon_common.go"
	err = cmd.Start()

	// regardless of whether we errored or not, we no longer need the children pipes
	childSyncPipe.Close()
	childStartPipe.Close()
	if err != nil {
		return 0, err
	}
	if err := r.moveConmonToCgroupAndSignal(ctr, cmd, parentStartPipe); err != nil {
		/* ... */
	}

	/* Wait for initial setup and fork, and reap child */
	err = cmd.Wait()
	if err != nil {
		return 0, fmt.Errorf("conmon failed: %w", err)
	}

	pid, err := readConmonPipeData(r.name, parentSyncPipe, ociLog)
	if err != nil {
		if err2 := r.DeleteContainer(ctr); err2 != nil {
			logrus.Errorf("Removing container %s from runtime after creation failed", ctr.ID())
		}
		return 0, err
	}
	ctr.state.PID = pid

	conmonPID, err := readConmonPidFile(ctr.config.ConmonPidFile)
	if err != nil {
		logrus.Warnf("Error reading conmon pid file for container %s: %v", ctr.ID(), err)
	} else if conmonPID > 0 {
		// conmon not having a pid file is a valid state, so don't set it if we don't have it
		logrus.Infof("Got Conmon PID as %d", conmonPID)
		ctr.state.ConmonPID = conmonPID
	}
```

`cmd.Wait()` が返るのは、conmon が double fork して一段目の親が終了したとき。conmon の実体は孫プロセスとして生き残り、Podman の子ではなくなる。だから Podman はこの時点で終了してよい。conmon 自身の pid は `waitpid` では取れないので、`--conmon-pidfile` に書かせたものを読む。

`moveConmonToCgroupAndSignal` ([`libpod/oci_conmon_linux.go#L172-L231`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_linux.go#L172-L231)) は conmon を専用の cgroup に入れてから start pipe に 1 バイト書く。conmon はそれまで OCI ランタイムを fork しないので、コンテナのプロセスが Podman CLI の cgroup に紛れ込まない。

sync pipe の受信 ([`#L1422-L1489`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1422-L1489)) は `{"data": <pid>}` の JSON 1 行で、負の値なら失敗。OCI ランタイムのエラーは `--runtime-arg --log` に書かせたファイルから拾い直す。タイムアウトは `ContainerCreateTimeout` = 240 秒 ([`libpod/define/runtime.go#L27`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/define/runtime.go#L27))。

### 状態の真実: exit file

[`libpod/container_internal.go#L359-L399`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L359-L399) の `syncContainer` がすべての API 操作の入口で走る。

```go title="libpod/container_internal.go"
// Sync this container with on-disk state and runtime status
// Should only be called with container lock held
// This function should suffice to ensure a container's state is accurate and
// it is valid for use.
func (c *Container) syncContainer() error {
	if err := c.runtime.state.UpdateContainer(c); err != nil {
		return err
	}
	// If runtime knows about the container, update its status in runtime
	// And then save back to disk
	if c.ensureState(define.ContainerStateCreated, define.ContainerStateRunning, define.ContainerStateStopped, define.ContainerStateStopping, define.ContainerStatePaused) {
		oldState := c.state.State

		if err := c.checkExitFile(); err != nil {
			return err
		}

		// Only save back to DB if state changed
		if c.state.State != oldState {
			/* ... */
			if err := c.save(); err != nil {
				return err
			}
		}
	}
```

「DB から読む → exit file を見る → 変わっていたら DB に書く」。`checkExitFile` ([`#L2708-L2737`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L2708-L2737)) は `os.Stat` するだけだ。

```go title="libpod/container_internal.go"
	// Check for the exit file
	info, err := os.Stat(exitFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// Container is still running, no error
			return nil
		}

		return fmt.Errorf("running stat on container %s exit file: %w", c.ID(), err)
	}

	// Alright, it exists. Transition to Stopped state.
	c.state.State = define.ContainerStateStopped
	c.state.PID = 0
	c.state.ConmonPID = 0

	// Read the exit file to get our stopped time and exit code.
	return c.handleExitFile(exitFile, info)
```

`handleExitFile` ([`#L196-L227`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L196-L227)) は、終了時刻をファイルの ctime、終了コードをファイルの内容、OOM を `persist/<id>/oom` の存在から取る。最後に終了コードを DB の独立したテーブルに書くが、その理由は [SQLite のページ](../sqlite-state/) で扱う。

### conmon が exit file を書かずに死んだら

[`#L1480-L1545`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L1480-L1545) の `waitForConmonToExitAndSave`。

```go title="libpod/container_internal.go"
		// If we are still ContainerStateStopping, conmon exited without
		// creating an exit file. Let's try and handle that here.
		if c.state.State == define.ContainerStateStopping {
			// Is container PID1 still alive?
			if err := unix.Kill(c.state.PID, 0); err == nil {
				// We have a runaway container, unmanaged by
				// Conmon. Invoke OCI runtime stop.
				// Use 0 timeout for immediate SIGKILL as things
				// have gone seriously wrong.
				/* ... */
			}

			// Conmon is dead. Handle it.
			c.state.State = define.ContainerStateStopped
			c.state.PID = 0
			c.state.ConmonPID = 0
			c.state.FinishedTime = time.Now()
			c.state.ExitCode = -1
			c.state.Exited = true

			c.state.Error = "conmon died without writing exit file, container exit code could not be retrieved"
```

conmon が `kill -9` されると exit file は書かれず、exit command も起動されない。「監視役が死んだ」状態を Podman 側で検出し、コンテナのプロセスが残っていれば殺して、終了コード -1 で閉じる。この経路は 2024 年の修正 (コミット 3fa8e98a31 "Ensure that containers do not get stuck in stopping", issue #19629) で入ったもので、[`test/system/030-run.bats#L1795-L1835`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/system/030-run.bats#L1795-L1835) が「stop 中に podman と conmon を `kill -9` する」手順で検証している。

### 親でなくても終了を待つ

[`libpod/container_internal_linux.go#L614-L625`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal_linux.go#L614-L625)。

```go title="libpod/container_internal_linux.go"
func (c *Container) getConmonPidFd() int {
	// Track lifetime of conmon precisely using pidfd_open + poll.
	// There are many cases for this to fail, for instance conmon is dead
	// or pidfd_open is not supported (pre linux 5.3), so fall back to the
	// traditional loop with poll + sleep
	if fd, err := unix.PidfdOpen(c.state.ConmonPID, 0); err == nil {
		return fd
	} else if err != unix.ENOSYS && err != unix.ESRCH {
		logrus.Debugf("PidfdOpen(%d) failed: %v", c.state.ConmonPID, err)
	}
	return -1
}
```

`WaitForExit` ([`libpod/container_api.go#L639-L687`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_api.go#L639-L687)) はロックを外してからこの fd を poll し、戻ったらロックを取り直して `syncContainer` する。導入コミット c34b5be990 (2022-10-07) は "This makes `time podman run fedora true` about 200msec faster" と書いている。それまでは 250ms のポーリングだった。

### systemd への MAINPID は conmon

[`libpod/container_internal.go#L1302-L1315`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L1302-L1315)。

```go title="libpod/container_internal.go"
	// Unless being ignored, set the MAINPID to conmon.
	if c.config.SdNotifyMode != define.SdNotifyModeIgnore {
		payload := fmt.Sprintf("MAINPID=%d", c.state.ConmonPID)
		if c.config.SdNotifyMode == define.SdNotifyModeConmon {
			// Also send the READY message for the "conmon" policy.
			payload += "\n"
			payload += daemon.SdNotifyReady
		}
		if err := notifyproxy.SendMessage(c.config.SdNotifySocket, payload); err != nil {
			logrus.Errorf("Notifying systemd of Conmon PID: %s", err.Error())
		}
```

systemd unit の中で `podman run` すると、unit の主プロセスは Podman ではなく conmon になる。Podman が終了しても unit は生き続け、conmon が死んだら unit が止まる。[Quadlet](../quadlet-generator/) が `Type=notify` と `--sdnotify=conmon` を組み合わせるのはこのためだ。対になる `configureConmonEnv` ([`libpod/oci_conmon_common.go#L1268-L1275`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1268-L1275)) は `NOTIFY_SOCKET` を conmon の環境から除き、コンテナに漏れないようにしている。

## なぜそうなっているか

- **後始末はデーモン無しでは「新しいプロセス」しかない。** [`docs/source/markdown/podman-container-cleanup.1.md#L11`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-container-cleanup.1.md#L11): "Sometimes container mount points and network stacks can remain if the podman command was killed or the _container_ ran in daemon mode. This command is automatically executed when _containers_ are run in daemon mode by the `conmon process` when the _container_ exits." conmon の `--exit-command` は、監視役が「次に何をすべきか」を知らなくても後始末を起動できる、最小の契約だ。
- **socket activation も fork/exec モデルに乗る。** [`docs/tutorials/socket_activation.md#L63-L76`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/tutorials/socket_activation.md#L63-L76): "Thanks to the fork/exec model of Podman, the socket will be first inherited by conmon and then by the OCI runtime and finally by the container". systemd から受け取った fd が Podman → conmon → ランタイム → コンテナと継承される。
- **sd-notify を conmon に代理させたのはデッドロック回避。** コミット c22f3e8b4e (2021-03-24) "Implement SD-NOTIFY proxy in conmon": "This prevents locking caused by OCI runtime blocking, waiting for SD-NOTIFY messages, and instead passes the messages directly up to the host." ランタイムに socket を渡すと、ランタイムが READY を待って止まり、Podman がランタイムを待って止まる。
- **conmon の死は想定内になった。** RELEASE_NOTES の 2.0.0 "Podman is now better able to deal with cases where `conmon` is killed before the container it is monitoring" 以来、「監視役がいない」状態からの回復を段階的に足している。exit file 方式は、通信相手が死んでいてもファイルが残る、という性質に依存している。
- **設計の負債も認めている。** `oci.go` の TODO "May want to move the conmon cleanup code here - it depends on Conmon being in use" の通り、conmon 依存のロジックが `container_internal.go` に散っている。

## どう活かすか

- 短命なプロセス (CLI、リクエストごとのハンドラ) が長生きするプロセスを起動するなら、監視の責務を「終了コードをファイルに書く」「後始末コマンドを起動する」だけの小さな専用プロセスに切り出す。監視役は自分が何を監視しているかを知らなくてよい。
- プロセスが死んでも残る媒体 (ファイル、pid ファイル、DB) を状態の真実にすると、どのプロセスからでも状態を再構築できる。「メモリ上の状態」を持つ常駐プロセスが無いなら、これ以外に手段が無い。
- 同期は最小のプリミティブで。「進んでよい」は 1 バイト、「結果」は 1 行の JSON。`SOCK_SEQPACKET` でメッセージ境界を保証すれば、フレーミングを自前で書かなくて済む。
- 親子関係に頼らず終了を待つなら `pidfd_open`。非対応環境のフォールバック (`kill(pid, 0)` のポーリング) を必ず用意する。
- 非同期の後始末には「この状態のときだけ実行する」ガード (`--stopped-only`) を引数に埋め込む。後始末が走る頃には、対象がもう別の状態になっているかもしれない。
- 後始末を別コマンドの起動に頼るなら、そのコマンドが失敗したときの可観測性を用意する。[`cmd/podman/containers/cleanup.go#L76-L85`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/containers/cleanup.go#L76-L85) は "Our only way of relaying information to the user is via syslog" と書き、`--syslog` を exit command に渡している。
- 取り込むべきでない条件: 呼び出し元が常駐サービスで、子プロセスを `waitpid` できるなら、監視プロセスの分離は過剰だ。exit file 方式はローカルのファイルシステム前提で、共有ファイルシステムや複数ホストでは ctime や存在判定を信用できない。
