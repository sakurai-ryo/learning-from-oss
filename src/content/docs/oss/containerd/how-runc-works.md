---
title: "runc が実際にやること — namespace・cgroup・pivot_root"
description: "containerd の下で最終的にプロセスを作るのは runc だ。runc は自分自身を再実行し、Go ランタイムが起動する前に C のコンストラクタで clone(2) と setns(2) を済ませ、子プロセスで rootfs を組み立て、seccomp を execve の直前に掛けてからユーザプログラムに置き換わる。containerd を読む前に、この最下層で何が起きるかを押さえておく。"
group: "コンテナランタイムの前提"
sidebar:
  order: 3
---

## 何を学んだか

### 「コンテナを作る」の実体

Linux に「コンテナを作るシステムコール」はない。あるのは次の部品だけだ。

- `clone(2)` / `unshare(2)` — namespace を新しく作る (mount, pid, net, ipc, uts, user, cgroup, time)
- `setns(2)` — 既存の namespace に参加する
- cgroup — `/sys/fs/cgroup` 以下のファイルに PID を書く
- `pivot_root(2)` / `mount(2)` — root filesystem を差し替える
- `seccomp` / capabilities / LSM — 権限を削る

runc がやっているのは、`config.json` の指定に従ってこれらを **正しい順序で** 呼ぶことだ。順序が本質で、たとえば seccomp を早く掛けすぎると自分自身の残りのセットアップが弾かれるし、遅すぎるとフィルタなしで動く隙間ができる。

### runc は自分自身を再実行する

`runc create` を実行したプロセスは、コンテナの中に入らない。代わりに **自分自身を `runc init` として再実行する**。この再実行された側が、namespace の中に入ってセットアップを行い、最後に `execve` でユーザのプログラムに変身する。

なぜ再実行が要るのか。**Go ランタイムがマルチスレッドだから** だ。`setns(2)` と `unshare(2)` はスレッド単位で効くものがあり、Go のスケジューラが goroutine を別スレッドに動かすと、どのスレッドがどの namespace にいるのか制御できなくなる。

runc の解決は徹底している。namespace 関係の処理を **C で書き、cgo のコンストラクタとして Go ランタイムの起動前に実行する**。

### 3 段階のプロセス生成

`nsexec.c` は 3 つの stage に分かれて動く。

1. **stage 0 (親)** — bootstrap データ (namespace のパス、clone flags、uid/gid マッピング) を pipe で子に送る。user namespace のマッピングは特権が要るので、**親が代わりに書く**
2. **stage 1 (子)** — `setns` で既存 namespace に入り、`unshare`/`clone` で新しい namespace を作る。user namespace を作った場合は親にマッピングを依頼して待つ
3. **stage 2 (孫)** — 新しい namespace の中で生まれ、自分の PID を親に報告し、そこで Go ランタイムに制御を渡す

親子の同期は、`SYNC_USERMAP_PLS` / `SYNC_USERMAP_ACK` のような 1 バイトのメッセージでソケット越しに行われる。

### cgroup に入れるのは親、rootfs を作るのは子

役割分担がはっきりしている。

- **親** — 子の PID が判明した直後に cgroup へ配置する。「子が cgroup から逃げ出せないように、同期の前にやる」とコメントされている
- **子** — mount の設定、`pivot_root`、`/proc` `/sys` `/dev` の用意、capability の削除、seccomp の適用

そして子は最後に `exec.fifo` に 1 バイト書いて、`runc start` が読みに来るまでブロックする ([OCI Runtime Spec](../oci-runtime-spec/) で見た合図)。

## ソースコードのどこか

### Go ランタイムより先に走る C コード

[`libcontainer/nsenter/README.md`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/libcontainer/nsenter/README.md) (runc `89f46d64`) に、この設計の説明がある。

```markdown title="libcontainer/nsenter/README.md"
The `nsenter` package registers a special init constructor that is called before
the Go runtime has a chance to boot. This provides us the ability to `setns` on
existing namespaces and avoid the issues that the Go runtime has with multiple
threads.
...
`nsexec()` will first get the file descriptor number for the init pipe
from the environment variable `_LIBCONTAINER_INITPIPE` (which was opened
by the parent and kept open across the fork-exec of the `nsexec()` init
process). The init pipe is used to read bootstrap data (namespace paths,
clone flags, uid and gid mappings, and the console path) from the parent
process.
```

さらに末尾にはこうある。

```markdown title="libcontainer/nsenter/README.md"
NOTE: We do both `setns(2)` and `clone(2)` even if we don't have any
`CLONE_NEW*` clone flags because we must fork a new process in order to
```

clone flag が空でも必ず fork する。「namespace を作らない場合」を特別扱いすると分岐が増えるので、常に同じ経路にしている。

同期メッセージの定義は [`libcontainer/nsenter/nsexec.c#L35-L44`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/libcontainer/nsenter/nsexec.c#L35-L44)。

```c title="libcontainer/nsenter/nsexec.c"
enum sync_t {
	SYNC_USERMAP_PLS = 0x40,	/* Request parent to map our users. */
	SYNC_USERMAP_ACK = 0x41,	/* Mapping finished by the parent. */
	SYNC_RECVPID_PLS = 0x42,	/* Tell parent we're sending the PID. */
	SYNC_RECVPID_ACK = 0x43,	/* PID was correctly received by parent. */
	SYNC_GRANDCHILD = 0x44,	/* The grandchild is ready to run. */
	SYNC_CHILD_FINISH = 0x45,	/* The child or grandchild has finished. */
	SYNC_TIMEOFFSETS_PLS = 0x46,	/* Request parent to write timens offsets. */
	SYNC_TIMEOFFSETS_ACK = 0x47,	/* Timens offsets were written. */
};
```

C で書かれた 36 KB のこのファイルが、コンテナという概念の実装の中心にある。

### cgroup への配置は「同期の前」に

[`libcontainer/process_linux.go#L821-L828`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/libcontainer/process_linux.go#L821-L828)。

```go title="libcontainer/process_linux.go"
	// Do this before syncing with child so that no children can escape the
	// cgroup. We don't need to worry about not doing this and not being root
	// because we'd be using the rootless cgroup manager in that case.
	if err := p.manager.Apply(p.pid()); err != nil {
```

「子と同期する前にやる。そうしないと子の子が cgroup から逃げられる」。cgroup に入る前に子が fork してしまうと、その孫は cgroup 外に生まれる。だから **cgroup の適用は、子に「進んでよい」と伝えるより前** でなければならない。

### pivot_root(".", ".") というトリック

[`libcontainer/rootfs_linux.go#L1144-L1195`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/libcontainer/rootfs_linux.go#L1144-L1195)。

```go title="libcontainer/rootfs_linux.go"
func pivotRoot(root *os.File) error {
	// While the documentation may claim otherwise, pivot_root(".", ".") is
	// actually valid. What this results in is / being the new root but
	// /proc/self/cwd being the old root. Since we can play around with the cwd
	// with pivot_root this allows us to pivot without creating directories in
	// the rootfs. Shout-outs to the LXC developers for giving us this idea.
```

`pivot_root` は本来「新しい root と、古い root を置くディレクトリ」の 2 つを要求する。素直に実装するとコンテナの rootfs の中に `/.pivot_root` のようなディレクトリを作る必要があり、それがイメージに残ってしまう。`pivot_root(".", ".")` にすると、古い root は cwd としてだけ残り、`MNT_DETACH` で外せる。

```go title="libcontainer/rootfs_linux.go"
	// Make oldroot rslave to make sure our unmounts don't propagate to the
	// host (and thus bork the machine). We don't use rprivate because this is
	// known to cause issues due to races where we still have a reference to a
	// mount while a process in the host namespace are trying to operate on
	// something they think has no mounts (devicemapper in particular).
	if err := mount("", ".", "", unix.MS_SLAVE|unix.MS_REC, ""); err != nil {
```

「rprivate ではなく rslave を使う」の理由まで書かれている。mount propagation の扱いを間違えると **ホストを壊す** ので、この種のコメントが随所にある。

### execve 直前の順序

[`libcontainer/standard_init_linux.go`](https://github.com/opencontainers/runc/blob/89f46d647095d5d596fb5aa573a6d6588630a135/libcontainer/standard_init_linux.go) の `Init()` 末尾。

```go title="libcontainer/standard_init_linux.go"
	// Set seccomp as close to execve as possible, so as few syscalls take
	// place afterward (reducing the amount of syscalls that users need to
	// enable in their seccomp profiles). However, this needs to be done
	// before closing the pipe since we need it to pass the seccompFd to
```

seccomp は「execve にできるだけ近づけて」掛ける。セットアップに必要な syscall をユーザのプロファイルに書かせないためだ。

そして最後の 2 ステップ。

```go title="libcontainer/standard_init_linux.go"
	// Wait for the FIFO to be opened on the other side before exec-ing the
	// user process. We open it through /proc/self/fd/$fd, because the fd that
	// was given to us was an O_PATH fd to the fifo itself. Linux allows us to
	// re-open an O_PATH fd through /proc.
	fifoFile, err := pathrs.Reopen(l.fifoFile, unix.O_WRONLY|unix.O_CLOEXEC)
	...
	if _, err := fifoFile.Write([]byte("0")); err != nil {
```

```go title="libcontainer/standard_init_linux.go"
	// Close all file descriptors we are not passing to the container. This is
	// necessary because the execve target could use internal runc fds as the
	// execve path, potentially giving access to binary files from the host
	// (which can then be opened by container processes, leading to container
	// escapes). Note that because this operation will close any open file
	// descriptors that are referenced by (*os.File) handles from underneath
	// the Go runtime, we must not do any file operations after this point
	// (otherwise the (*os.File) finaliser could close the wrong file). See
	// CVE-2024-21626 for more information as to why this protection is
	// necessary.
	if err := utils.UnsafeCloseFrom(l.config.PassedFilesCount + 3); err != nil {
		return err
	}
	return linux.Exec(name, l.config.Args, l.config.Env)
```

CVE-2024-21626 — runc の内部 fd がコンテナに漏れると、そこからホストのファイルシステムに到達できてしまう脱獄経路だった。**残った fd を全部閉じてから execve する** のが対策で、しかも「この後は Go のファイル操作を一切してはいけない」という制約付きになっている。

### containerd から見えるのは結果だけ

containerd (正確には shim) は、これらの内部を一切知らない。呼ぶのは次の形のコマンドだけだ。

```
runc --root /run/containerd/runc/<ns> create \
     --bundle <bundle> --pid-file <bundle>/init.pid \
     --console-socket <socket> <container-id>
```

`--pid-file` で init プロセスの PID を受け取り、`--console-socket` で pty のマスタ側 fd を受け取る。shim が runc をどう呼ぶかは [runc をどう呼び、終了コードをどう受け取るか](../runc-invocation/) で扱う。

## なぜそうなっているか

### 言語の制約が設計を決めている

「namespace 処理を C で書く」は、Linux の制約と Go の制約の交差点で選ばれた設計だ。Go でコンテナランタイムを書くと必ずこの問題に当たる。runc は「C のコンストラクタ」という抜け道でこれを回避した。

同じ問題への別解として、`crun` は最初から C で書かれている。containerd から見れば両者は同じ `config.json` を受け取る交換可能な部品で、この内部事情はまったく見えない。**言語固有の困難を、仕様の境界の内側に閉じ込められている** ということでもある。

### コンテナの脆弱性は「順序と fd」に集中する

runc の CVE を並べると傾向が見える。

- CVE-2016-9962 — コンテナ内から親の fd に到達
- CVE-2019-5736 — `/proc/self/exe` 経由で runc 本体を上書き
- CVE-2024-21626 — 内部 fd の漏洩による作業ディレクトリ脱出

いずれも「namespace で隔離した後に、隔離を跨ぐ参照 (fd やパス) が残っていた」という形をしている。だから runc のコードは、fd を閉じる位置、seccomp を掛ける位置、pivot_root の直後に何をするか、といった **順序** に関するコメントで埋まっている。

### containerd がこの層を持たない理由

containerd がこの処理を自分で書くこともできた (実際、初期の Docker はそうだった)。持たない選択の利点は 2 つある。

- **セキュリティ更新の粒度** — runc の CVE 対応は runc バイナリの差し替えで済む。containerd を再起動しなくてよい
- **代替実装の受け入れ** — gVisor (`runsc`) は同じ `config.json` を受け取ってユーザ空間カーネルで実行する。Kata は VM を起動する。containerd 側の変更なしに、隔離の強度を選べる

## どう活かすか

### 「コンテナが起動しない」を読むとき

runc の失敗は shim のログに、runc のエラーメッセージがそのまま出る。よくある形と原因の対応を知っておくと速い。

| メッセージ                                        | 起きていること                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `exec: "xxx": executable file not found in $PATH` | rootfs の中にバイナリがない。イメージかコマンドの指定ミス                  |
| `unable to apply cgroup configuration`            | cgroup の設定失敗。cgroup v1/v2 の混在や、systemd との競合                 |
| `pivot_root invalid argument`                     | rootfs が mount point になっていない。snapshotter のマウント失敗が先にある |
| `container init did not signal execve readiness`  | init がセットアップ中に死んだ。上に本当のエラーが出ている                  |

最後のものが特に重要で、これは **症状であって原因ではない**。ログを遡って init 側の失敗を探す必要がある。

### 「特権処理は親に、隔離後の処理は子に」

親子でプロセスを分けて特権を渡さない、という分担は他所でも使える。user namespace のマッピングを親に書かせるのは、子が特権を持たないまま自分の身分を切り替えるための唯一の方法だ。同じ発想は Podman の pause プロセスや、Firecracker の jailer にも現れる。

大事なのは、**同期点を明示的な 1 バイトのメッセージにしている** ことだ。「ここまで終わった」「ここから先は進んでよい」を暗黙のタイミングに任せず、プロトコルとして書き下すことで、片方が死んだ場合の検出もできるようになっている。
