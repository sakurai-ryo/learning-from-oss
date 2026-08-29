---
title: "exit と OOM を拾う監視経路"
description: "コンテナの終了は shim の reaper が拾い、OOM は cgroup v2 の memory.events を inotify で監視して検出する。どちらも shim の中で起き、イベントとして containerd に流れる。監視の主体がデーモンではないので、containerd が落ちている間の OOM も記録される。"
group: "コンテナを実行する"
sidebar:
  order: 46
---

## 何を学んだか

### 監視は shim の中にある

コンテナの状態変化を検出するのは、containerd ではなく shim だ。

| 事象           | 検出方法                   | 検出する場所                                                    |
| -------------- | -------------------------- | --------------------------------------------------------------- |
| プロセスの終了 | `SIGCHLD` → `wait4`        | shim の reaper ([SIGCHLD を 1 か所で受ける reaper](../reaper/)) |
| OOM kill       | `memory.events` の inotify | shim の OOM watcher                                             |
| リソース使用量 | cgroup のファイルを読む    | containerd (メトリクス収集時)                                   |

最初の 2 つが shim にあるので、**containerd が落ちている間に起きた終了や OOM も検出される**。イベントの送信は失敗するが、shim は状態を保持しているので、containerd が戻ってきたら状態として取得できる。

### cgroup v2 の OOM 検出は inotify

cgroup v1 には `cgroup.event_control` という eventfd ベースの通知機構があった。cgroup v2 ではこれが廃止され、代わりに `memory.events` というファイルを監視する。

```
$ cat /sys/fs/cgroup/.../memory.events
low 0
high 0
max 3
oom 1
oom_kill 1
```

**このファイルは内容が変わると inotify の変更イベントが飛ぶ**。ファイルを read しなおして `oom_kill` の値が増えていれば、OOM が起きたと判定する。

### カウンタの増加で判定する

`oom_kill` は累積カウンタなので、前回の値と比較する。値が増えていれば新しい OOM。

「イベントが飛んだ = OOM が起きた」ではない。`memory.events` は他の値 (`high`、`max`) の変化でも更新されるので、**どの値が変わったかを自分で調べる**。

### TaskMonitor は複数を束ねられる

containerd 側には `TaskMonitor` というインターフェースがあり、cgroup メトリクスの収集などが実装する。複数の monitor を束ねる `multiTaskMonitor` と、何もしない `noopTaskMonitor` が用意されている。

## ソースコードのどこか

### 監視インターフェース

[`core/runtime/monitor.go#L20-L36`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/monitor.go#L20-L36)。

```go title="core/runtime/monitor.go"
// TaskMonitor provides an interface for monitoring of containers within containerd
type TaskMonitor interface {
	// Monitor adds the provided container to the monitor.
	// Labels are optional (can be nil) key value pairs to be added to the metrics namespace.
	Monitor(task Task, labels map[string]string) error
	// Stop stops and removes the provided container from the monitor
	Stop(task Task) error
}

// NewMultiTaskMonitor returns a new TaskMonitor broadcasting to the provided monitors
func NewMultiTaskMonitor(monitors ...TaskMonitor) TaskMonitor {
	return &multiTaskMonitor{
		monitors: monitors,
	}
}

// NewNoopMonitor is a task monitor that does nothing
func NewNoopMonitor() TaskMonitor {
	return &noopTaskMonitor{}
}
```

2 メソッドだけのインターフェースに、**合成 (multi) と無効化 (noop) の実装が標準で付いてくる**。監視プラグインが 0 個でも 3 個でも、使う側のコードは変わらない。

Linux 以外のプラットフォームや、メトリクスを無効化した構成では noop が使われる。

### OOM 監視のインターフェース

[`internal/oom/oom.go#L20-L34`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/internal/oom/oom.go#L20-L34)。

```go title="internal/oom/oom.go"
type EventFunc func(containerID string)

type Interface interface {
	// Add is to start to monitor container cgroupv2 OOM event.
	//
	// TODO:
	//
	// Currently, cgroupsv2 package doesn't support to export cgroupv2 path.
	// Ideally, the function interface should be like
	//
	// Add(string, *cgroupsv2.Manager, EventFunc) error
	Add(containerID string, pid int, fn EventFunc) error
	//
	// Stop is to stop monitor OOM event for a given container ID
	Stop(containerID string) error
}
```

TODO に「本来は cgroup manager を渡したいが、ライブラリがパスを公開していないので PID を渡している」と書かれている。**現状の妥協と、あるべき形が併記されている**。

PID から cgroup のパスを逆引きする (`/proc/<pid>/cgroup` を読む) ことになるので、プロセスが死んでいると失敗する。

### 監視の登録

[`internal/oom/watcher.go#L44-L79`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/internal/oom/watcher.go#L44-L79)。

```go title="internal/oom/watcher.go"
func (ows *oomWatchers) Add(cid string, pid int, fn EventFunc) (retErr error) {
	cgroupPath, err := getCgroup2Path(pid)
	if err != nil {
		return fmt.Errorf("failed to get cgroupv2 path: %w", err)
	}

	eventFD, err := memoryEventNonBlockFD(cgroupPath)
	if err != nil {
		return fmt.Errorf("failed to get memory.events watch FD: %w", err)
	}
	defer func() {
		if retErr != nil {
			eventFD.Close()
		}
	}()
```

fd を確保してからロックを取り、失敗したら fd を閉じる。**ロックの中で失敗しうる操作 (inotify の設定) をしない** ようにしている。

コンテナ ID の重複は `ErrAlreadyExists` で弾く。

### 監視ループ

[`internal/oom/watcher.go#L102-L142`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/internal/oom/watcher.go#L102-L142)。

```go title="internal/oom/watcher.go"
func (w *watcher) start() {
	go func() {
		defer close(w.errCh)
		defer w.eventFD.Close()

		var (
			oomKills   uint64
			shouldExit bool
		)
		for !shouldExit {
			buffer := make([]byte, unix.SizeofInotifyEvent*10)
			bytesRead, err := w.eventFD.Read(buffer)
			if err != nil {
				if !errors.Is(err, os.ErrClosed) {
					w.errCh <- err
					return
				}
				shouldExit = true
			} else {
				if bytesRead < unix.SizeofInotifyEvent {
					continue
				}
			}
```

inotify の fd を読んでブロックする。**エラーが `os.ErrClosed` なら「停止された」と解釈** して、ループを 1 周してから抜ける。

抜ける前にもう 1 周するのがポイントで、閉じられる直前に起きた OOM を取りこぼさない。

```go title="internal/oom/watcher.go"
			// TODO: We should export MemoryEventsStat function
			out := make(map[string]uint64)
			if err := readKVStatsFile(w.cgroupPath, "memory.events", out); err != nil {
				// When cgroup is deleted read may return -ENODEV instead of -ENOENT from open.
				if _, statErr := os.Lstat(filepath.Join(w.cgroupPath, "memory.events")); !os.IsNotExist(statErr) {
					w.errCh <- err
				}
				return
			}

			if v := out["oom_kill"]; v > oomKills {
				oomKills = v
				w.eventFn(w.cid)
			}
```

エラー処理が細かい。「**cgroup が削除されると、open の ENOENT ではなく read の ENODEV が返ることがある**」。だからエラーを受けたら `Lstat` でファイルの存在を確認し、なければ正常な終了として扱う。

カーネルの挙動の癖に対する具体的な手当てで、これを知らないと「コンテナ終了のたびにエラーログが出る」ことになる。

判定は `oom_kill` の増加のみ。`oom` (メモリ上限に達した回数) ではなく `oom_kill` (実際に kill された回数) を見る。

### shim 側の配線

[`cmd/containerd-shim-runc-v2/task/service.go#L274`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/task/service.go#L274)。

```go title="cmd/containerd-shim-runc-v2/task/service.go"
		if err := s.cg2oom.Add(container.ID, container.Pid(), s.oomEvent); err != nil {
```

コンテナの作成時に、その PID で OOM 監視を登録する。コールバックは `s.oomEvent`。

```go title="cmd/containerd-shim-runc-v2/task/service.go"
func (s *service) oomEvent(id string) {
	err := s.publisher.Publish(s.context, runtime.TaskOOMEventTopic, &eventstypes.TaskOOM{
		ContainerID: id,
	})
	if err != nil {
		log.G(s.context).WithError(err).Error("post event")
	}
}
```

イベントを発行するだけ。送信に失敗してもログを出して続ける ([イベントは shim から publish バイナリで戻ってくる](../event-publisher/))。

**OOM の事実は cgroup に残っている** ので、イベントが届かなくても後から `memory.events` を読めば分かる。だから送信失敗を致命的に扱わない。

### 終了イベントとの関係

[`cmd/containerd-shim-runc-v2/task/service.go#L670-L695`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/task/service.go#L670-L695)。

```go title="cmd/containerd-shim-runc-v2/task/service.go"
		delete(s.running, e.Pid)
		s.lifecycleMu.Unlock()

		for _, cp := range cps {
			if ip, ok := cp.Process.(*process.Init); ok {
				s.handleInitExit(e, cp.Container, ip)
			} else {
				s.handleProcessExit(e, cp.Container, cp.Process)
			}
		}
```

reaper から届いた終了イベントを、**init プロセスか exec プロセスかで分けて処理する**。init の終了はコンテナ全体の終了を意味し、exec の終了は 1 プロセスの終了にすぎない ([init と exec の状態を、型で表す](../process-state-machine/))。

ロックを解放してから処理を呼ぶ。ハンドラの中で RPC やイベント発行が起きるので、ロックを保持したままにしない。

## なぜそうなっているか

### 監視を shim に置く

containerd が監視すると、

- containerd が落ちている間の終了と OOM を取りこぼす
- コンテナ数に比例して監視の goroutine が増える
- cgroup のパスを containerd が知る必要がある

shim なら、自分の子プロセスの終了は `SIGCHLD` で確実に受け取れるし、cgroup も自分が作ったものだ。**監視の主体を、監視対象に最も近いプロセスに置く** のが自然になる。

### cgroup v1 と v2 で仕組みが違う

v1 は `cgroup.event_control` に eventfd を登録する方式で、OOM 専用の通知だった。v2 では汎用の `memory.events` ファイルと inotify に置き換わった。

v2 のほうが仕組みとしては素直だが、**「どの値が変わったか」をアプリ側で判定する必要がある**。カウンタを覚えて差分を見る、という実装が要るのはそのためだ。

containerd は両方を実装している (`core/metrics/cgroups/v1` と `internal/oom`)。カーネルの世代交代に合わせて、両方をしばらく維持する必要がある。

### 「失われてもよい通知」と「残る事実」

OOM の通知は失われうるが、`memory.events` の `oom_kill` カウンタは cgroup が生きている限り残る。コンテナの終了コードも shim が保持している。

**通知は速報、事実は状態として問い合わせられる** という二重化が、containerd 全体の作法になっている。イベントを取りこぼしても、状態を問い合わせれば正しい答えが得られる。

## どう活かすか

### OOM を確認する

```sh
# イベントとして
$ ctr -n k8s.io events | grep -i oom

# cgroup の事実として
$ cat /sys/fs/cgroup/kubepods.slice/.../memory.events
```

Kubernetes では `kubectl describe pod` の `Last State: Terminated, Reason: OOMKilled` がこの経路から来る。CRI プラグインが `TaskOOM` イベントを受け取り、コンテナのステータスに反映する。

イベントが届いていないのに OOM されている場合、`memory.events` の値と突き合わせる。

### 監視対象の近くに監視を置く

分散したプロセスを監視する設計で、containerd の判断は参考になる。

- **監視は監視対象の親プロセスに置く** — シグナルとファイル記述子が使える
- **通知は best-effort、事実は問い合わせ可能に** — 二重化する
- **カーネルの通知は「何かが変わった」しか言わない** — 差分の判定を自分で持つ
- **停止時に 1 周多く回す** — 閉じる直前のイベントを拾う

3 番目は inotify、epoll、fanotify のいずれでも共通する。「通知が来た = 目的の事象が起きた」と決めつけると、他の要因での通知で誤動作する。
