---
title: "runc をどう呼び、終了コードをどう受け取るか"
description: "shim は runc を CLI として exec する。PID は --pid-file 経由のファイルで、pty は console socket 経由の fd で、エラーは JSON のログファイルから受け取る。runc の終了コードだけでは理由が分からないので、ログの最後の error 行を読んでエラーメッセージに混ぜる。"
group: "shim の中身"
sidebar:
  order: 51
---

## 何を学んだか

### runc は CLI として呼ばれる

shim は `go-runc` ライブラリ経由で runc を実行する。ライブラリといっても、やっているのは **コマンドラインの組み立てと exec** だ。

```go
func NewRunc(root, path, namespace, runtime string, systemd bool) *runc.Runc {
	if root == "" {
		root = RuncRoot
	}
	return &runc.Runc{
		Command:       runtime,
		Log:           filepath.Join(path, "log.json"),
		LogFormat:     runc.JSON,
		PdeathSignal:  unix.SIGKILL,
		Root:          filepath.Join(root, namespace),
		SystemdCgroup: systemd,
	}
}
```

設定される 5 項目が、そのまま runc の CLI フラグになる。

| フィールド          | runc のフラグ                | 意味                                            |
| ------------------- | ---------------------------- | ----------------------------------------------- |
| `Command`           | (実行ファイル)               | runc / crun / 別の OCI ランタイム               |
| `Log` / `LogFormat` | `--log`, `--log-format json` | エラーを JSON で書き出す先                      |
| `Root`              | `--root`                     | runc の状態ディレクトリ。**namespace で分ける** |
| `SystemdCgroup`     | `--systemd-cgroup`           | cgroup を systemd 経由で作る                    |
| `PdeathSignal`      | (Go 側で設定)                | shim が死んだら runc も殺す                     |

### 3 つの経路で情報を受け取る

runc の実行結果は、標準出力ではなく別経路で返ってくる。

- **PID** → `--pid-file` で指定したファイルに書かれる
- **pty のマスタ fd** → console socket 経由で SCM_RIGHTS として送られる
- **エラーの詳細** → `--log` で指定した JSON ファイルの最後の error 行

終了コードは「失敗した」しか言わないので、詳細はログから拾う。

### PdeathSignal は「取り残さない」ための保険

`PdeathSignal: SIGKILL` は、`prctl(PR_SET_PDEATHSIG)` で設定される。**shim が死んだら runc も殺される**。

runc は短命なので普段は関係ないが、コンテナ作成の途中で shim が死んだ場合に runc が孤児として残らない。

### runc の root を namespace で分ける

`--root` が `/run/containerd/runc/<namespace>` になる。containerd の namespace が違えば runc の状態も分かれるので、**同じコンテナ ID が別 namespace に存在できる** ([1 つのデーモンを namespace で分ける](../namespaces/))。

## ソースコードのどこか

### Create の全体

[`cmd/containerd-shim-runc-v2/process/init.go#L110-L180`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/process/init.go#L110-L180)。

```go title="cmd/containerd-shim-runc-v2/process/init.go"
	var (
		err     error
		socket  *runc.Socket
		pio     *processIO
		pidFile = newPidFile(p.Bundle)
	)

	if r.Terminal {
		if socket, err = runc.NewTempConsoleSocket(); err != nil {
			return fmt.Errorf("failed to create OCI runtime console socket: %w", err)
		}
		defer socket.Close()
	} else {
		if pio, err = createIO(ctx, p.id, p.IoUID, p.IoGID, p.stdio); err != nil {
			return fmt.Errorf("failed to create init process I/O: %w", err)
		}
		p.io = pio
```

**tty かどうかで経路が分かれる**。tty なら console socket を作り、そうでなければ fifo ベースの I/O を作る ([コンテナの stdio を fifo で受け渡す](../shim-io/))。

```go title="cmd/containerd-shim-runc-v2/process/init.go"
	opts := &runc.CreateOpts{
		PidFile:      pidFile.Path(),
		NoPivot:      p.NoPivotRoot,
		NoNewKeyring: p.NoNewKeyring,
	}
	if p.io != nil {
		opts.IO = p.io.IO()
	}
	if socket != nil {
		opts.ConsoleSocket = socket
	}

	if err := p.runtime.Create(ctx, r.ID, r.Bundle, opts); err != nil {
		return p.runtimeError(err, "OCI runtime create failed")
	}
```

`runc create --bundle <path> --pid-file <path> [--console-socket <path>] <id>` が実行される。**bundle のパスと ID を渡すだけ** で、コンテナの設定は `config.json` から読まれる ([OCI Runtime Spec: runc への入力は bundle 1 つだけ](../oci-runtime-spec/))。

### console の受け取り

```go title="cmd/containerd-shim-runc-v2/process/init.go"
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if socket != nil {
		console, err := socket.ReceiveMaster()
		if err != nil {
			return fmt.Errorf("failed to retrieve console master: %w", err)
		}
		console, err = p.Platform.CopyConsole(ctx, console, p.id, r.Stdin, r.Stdout, r.Stderr, &p.wg)
```

runc が pty を作り、**マスタ側の fd を Unix ソケット経由で送ってくる**。`ReceiveMaster` がそれを受け取る。

fd の受け渡しに `SCM_RIGHTS` を使うのは、pty のマスタがプロセスをまたげないからだ。ファイルパスでは渡せない。

30 秒のタイムアウトが掛かる。runc が console socket に fd を送らずに終了した場合、永久に待たないようにするため。

### PID の受け取り

```go title="cmd/containerd-shim-runc-v2/process/init.go"
	pid, err := pidFile.Read()
	if err != nil {
		return fmt.Errorf("failed to retrieve OCI runtime container pid: %w", err)
	}
	p.pid = pid
	return nil
```

`runc create` が終了した後、pid ファイルを読む。runc は init プロセスを作ってから終了するので、**このファイルだけが PID を知る手段** になる。

標準出力で返さないのは、runc の CLI がそのように設計されているからだ (標準出力はコンテナの stdout に使われる可能性がある)。

### エラーの補完

[`cmd/containerd-shim-runc-v2/process/init.go#L488-L502`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/process/init.go#L488-L502)。

```go title="cmd/containerd-shim-runc-v2/process/init.go"
func (p *Init) runtimeError(rErr error, msg string) error {
	if rErr == nil {
		return nil
	}

	rMsg, err := getLastRuntimeError(p.runtime)
	switch {
	case err != nil:
		return fmt.Errorf("%s: %s (%s): %w", msg, "unable to retrieve OCI runtime error", err.Error(), rErr)
	case rMsg == "":
		return fmt.Errorf("%s: %w", msg, rErr)
	default:
		return fmt.Errorf("%s: %s", msg, rMsg)
	}
}
```

3 分岐すべてに意味がある。

- **ログが読めない** → 元のエラーに加えて「ログが読めなかった」も伝える
- **ログにエラーがない** → 元のエラー (`exit status 1` など) をそのまま返す
- **ログにエラーがある** → **runc のメッセージを返す**。元のエラー (`exit status 1`) は捨てる

3 番目が肝で、`exit status 1` より `container_linux.go:349: starting container process caused "exec: \"foo\": executable file not found in $PATH"` のほうが遥かに有益だ。

ログの読み取り ([`cmd/containerd-shim-runc-v2/process/utils.go#L57-L90`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/process/utils.go#L57-L90))。

```go title="cmd/containerd-shim-runc-v2/process/utils.go"
	dec := json.NewDecoder(f)
	for err = nil; err == nil; {
		if err = dec.Decode(&log); err != nil && err != io.EOF {
			return "", err
		}
		if log.Level == "error" {
			errMsg = strings.TrimSpace(log.Msg)
		}
	}
```

JSON Lines を最後まで読み、**最後の error レベルの行** を採用する。runc は複数のエラーを出しうるので、最後のものが最も具体的だと仮定している。

### checkpoint からの復元

```go title="cmd/containerd-shim-runc-v2/process/init.go"
func (p *Init) createCheckpointedState(r *CreateConfig, pidFile *pidFile) error {
	opts := &runc.RestoreOpts{
		CheckpointOpts: runc.CheckpointOpts{
			ImagePath:  r.Checkpoint,
			WorkDir:    p.CriuWorkPath,
			ParentPath: r.ParentCheckpoint,
		},
		PidFile:     pidFile.Path(),
		NoPivot:     p.NoPivotRoot,
		Detach:      true,
		NoSubreaper: true,
	}
	...
	p.initState = &createdCheckpointState{
		p:    p,
		opts: opts,
	}
	return nil
}
```

CRIU による復元の場合、**Create の時点では runc を呼ばない**。`createdCheckpointState` という専用の状態を設定し、`Start` のときに `runc restore` を実行する。

`NoSubreaper: true` に注目したい。shim が既に subreaper なので、runc に設定させない ([SIGCHLD を 1 か所で受ける reaper](../reaper/))。

状態を型で持っているおかげで、**通常の作成と checkpoint からの復元を、同じ Start インターフェースで扱える** ([init と exec の状態を、型で表す](../process-state-machine/))。

### I/O の条件付き設定

```go title="cmd/containerd-shim-runc-v2/process/init.go"
func withConditionalIO(c stdio.Stdio) runc.IOOpt {
	return func(o *runc.IOOption) {
		o.OpenStdin = c.Stdin != ""
		o.OpenStdout = c.Stdout != ""
		o.OpenStderr = c.Stderr != ""
	}
}
```

fifo のパスが空文字なら、その stream を開かない。**stdout だけ要る、stdin は要らない** といった構成が自然に表現される。

`ctr run` の `-t` なしと `-d` (detach) で、必要な stream が変わる。

## なぜそうなっているか

### CLI 経由で呼ぶことの代償と利点

ライブラリとして runc をリンクすれば、PID もエラーも直接受け取れる。しかし、

- runc のバージョンを shim と揃える必要がある
- runc の CVE 対応で shim の再ビルドが要る
- crun (C 実装) や別のランタイムを使えない

CLI 経由なら、**バイナリを差し替えるだけ** で済む ([なぜコンテナランタイムは何層にも分かれているのか](../why-layered-runtime/))。

代償が「情報の受け渡しが不便」で、pid ファイル、console socket、ログファイルという 3 つの回り道が生まれている。

### エラーメッセージをログから拾う

CLI の終了コードは 0 か非 0 しかない。標準エラー出力を読む手もあるが、

- 標準エラーはコンテナの stderr と混ざりうる
- フォーマットが決まっていない

`--log-format json` を指定してファイルに書かせれば、**構造化された、混ざらないエラー** が得られる。runc 側にこの機能があるのは、まさにこの用途のためだ。

「終了コードだけでは足りないので、別経路で詳細を渡す」という設計は、CLI をプログラムから呼ぶときの一般的な解になる。

### pty を fd で渡す

pty のマスタは、プロセスをまたいでパス名では開けない。`SCM_RIGHTS` で fd そのものを送る必要がある。

だから runc は「console socket のパスを受け取り、そこに接続して fd を送る」という規約を持つ。OCI Runtime Spec には含まれない、runc の実装上の取り決めだが、他のランタイム (crun) も同じ規約に従っている。

## どう活かすか

### runc のログを読む

```sh
# bundle の隣に log.json がある
$ cat /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>/log.json | jq
```

コンテナの起動に失敗したとき、**containerd のエラーメッセージに現れるのは最後の error 行だけ** だ。それ以前の warning や debug を見たければ、このファイルを直接読む。

runc の内部で何段階目に失敗したかが分かる。

### runc を手で実行する

```sh
$ cd /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>
$ runc --root /run/containerd/runc/k8s.io list
$ runc --root /run/containerd/runc/k8s.io state <id>
```

`--root` を正しく指定すれば、shim が作ったコンテナを runc から直接操作できる。デバッグ時に、shim を介さずに状態を確認できる。

### 「CLI をプログラムから呼ぶ」ときの設計

containerd と runc の関係から学べる点。

- **終了コードは「失敗した」しか言わない** — 詳細を返す経路を別に用意する
- **構造化ログをファイルに書かせる** — 標準エラーは他の出力と混ざる
- **戻り値が要るならファイル経由にする** — pid ファイルのように
- **fd を渡す必要があるなら Unix ソケット** — パス名では渡せないものがある
- **親の死を子に伝える** — `PR_SET_PDEATHSIG` で取り残しを防ぐ

エラーメッセージの補完 (`runtimeError`) は、特に真似する価値がある。呼び出し元に返るエラーが `exit status 1` なのか、具体的な失敗理由なのかで、運用の負担が大きく変わる。
