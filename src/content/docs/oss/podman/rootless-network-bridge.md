---
title: "既存ツールを無改造で動かすために「自分が所有する偽のホスト」を 1 層足す"
description: "rootless でブリッジネットワークが要るとき、Podman は netavark を書き換えない。代わりに自分の user namespace が所有する netns (rootless-netns) を 1 つ作り、書き込める /run を mount namespace で差し替えて、その中で netavark をそのまま実行する。netns の寿命は参照カウントで、外部接続はユーザー単位の pasta で、ポート公開は netns を跨いで fd を渡す rootlessport で賄う。"
group: "rootless"
sidebar:
  order: 9
---

## 何を学んだか

### どんな状況の話か

[前のページ](../rootless-network-pasta/) の pasta はコンテナ 1 つを外に出すには十分だが、コンテナ同士を同じサブネットに置きたい、DNS で名前解決したい、といった要求には応えられない。root の Podman はこれを netavark (Rust 製のネットワーク設定ツール) でブリッジと veth を作って実現する。netavark はホストの netns に対して動く前提で書かれていて、`/run` に状態を書き、nftables を操作し、`CAP_NET_ADMIN` を要求する。

rootless でこれを動かすには 2 つの選択肢がある。netavark に rootless 用の経路を追加するか、netavark の前提を満たす環境を用意するか。

### Podman の答え

1. **自分の user namespace が所有する netns を 1 つ作る。** 「rootless-netns」と呼ばれるこの netns は、ホストの netns の代わりを務める「偽のホスト」だ。自分が所有する netns の中なら、rootless でも `CAP_NET_ADMIN` が効くので、ブリッジも veth も作れる。
2. **netavark はその中でそのまま実行する。** netavark を呼ぶスレッドだけ mount namespace をさらに分け、`/run` を書き込めるディレクトリに差し替える。netavark は自分が rootless-netns の中にいることを知らなくてよい。
3. **rootless-netns の寿命は参照カウントで管理する。** ネットワークに参加するコンテナの数を `ref-count` ファイルで数え、0 になったら netns を削除する。netns 自体は bind mount で保持し、外部接続を担う pasta の pid を記録して、死んでいれば作り直す。
4. **偽のホストから本当の外へは、ユーザー単位の pasta が出す。** コンテナごとの pasta ではなく、rootless-netns に対して 1 つの pasta を置く。それは `podman run` を起動した systemd unit の cgroup から `user.slice` へ移して、unit の停止に巻き込まれないようにする。
5. **ポート公開はホスト netns とコンテナ netns の 2 プロセスで行う。** rootlessport バイナリはホスト側で listen する親と、コンテナ netns に入って接続する子に分かれ、子が dial したソケットの fd を `SCM_RIGHTS` で親に渡す。親は 2 本のソケットの間でバイトをコピーする。寿命は conmon に握らせたパイプの EOF で決まる。
6. **ユーザー空間プロキシの限界 (ソース IP が消える) には、pasta の制御ソケット (pesto) で答える。** 6.0 で実験的に入った `rootless_port_forwarder="pasta"` は、稼働中の pasta に転送ルールを動的に追加させ、カーネルの splice で元のクライアント IP を保つ。

## ソースコードのどこか

### rootless-netns を使うかの判定

containers/common (v0.69.1) の [`vendor/go.podman.io/common/libnetwork/netavark/network.go#L107-L120`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/netavark/network.go#L107-L120)。

```go title="vendor/go.podman.io/common/libnetwork/netavark/network.go"
func NewNetworkInterface(conf *InitConfig) (types.ContainerNetwork, error) {
	var netns *rootlessnetns.Netns
	var err error
	// Do not use unshare.IsRootless() here. We only care if we are running re-exec in the userns,
	// IsRootless() also returns true if we are root in a userns which is not what we care about and
	// causes issues as this slower more complicated rootless-netns logic should not be used as root.
	val, ok := os.LookupEnv(unshare.UsernsEnvName)
	useRootlessNetns := ok && val == "done"
	if useRootlessNetns {
		netns, err = rootlessnetns.New(conf.NetworkRunDir, conf.Config)
		if err != nil {
			return nil, err
		}
	}
```

判定に使うのは [`constructor-reexec`](../constructor-reexec/) で見た環境変数 `_CONTAINERS_USERNS_CONFIGURED` が `done` かどうかだけ。コメントは「root なら遅くて複雑な rootless-netns の経路を使うべきでない」と、この層が代償を伴うものだと明言している。

### netns の取得と再作成

[`vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go#L106-L175`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go#L106-L175) の `getOrCreateNetns`。

```go title="vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go"
	nsPath := n.getPath(rootlessNetnsDir)
	nsRef, err := netns.GetNS(nsPath)
	if err == nil {
		pidPath := n.getPath(rootlessNetNsConnPidFile)
		pid, err := readPidFile(pidPath)
		if err == nil {
			// quick check if pasta/slirp4netns are still running
			err := unix.Kill(pid, 0)
			if err == nil {
				if err := n.deserializeInfo(); err != nil {
					return nil, false, wrapError("deserialize info", err)
				}
				// All good, return the netns.
				return nsRef, false, nil
			}
			// Print warnings in case things went wrong, we might be able to recover
			// but maybe not so make sure to leave some hints so we can figure out what went wrong.
			if errors.Is(err, unix.ESRCH) {
				logrus.Warn("rootless netns program no longer running, trying to start it again")
			} else {
				logrus.Warnf("failed to check if rootless netns program is running: %v, trying to start it again", err)
			}
		} else {
			logrus.Warnf("failed to read rootless netns program pid: %v", err)
		}
		// In case of errors continue and setup the network cmd again.
	} else {
		// Special case, the file might exist already but is not a valid netns.
		// One reason could be that a previous setup was killed between creating
		// the file and mounting it. Or if the file is not on tmpfs (deleted on boot)
		// you might run into it as well: https://github.com/containers/podman/issues/25144
		// We have to do this because NewNSAtPath fails with EEXIST otherwise
		if errors.As(err, &netns.NSPathNotNSErr{}) {
			// We don't care if this fails, NewNSAtPath() should return the real error.
			_ = os.Remove(nsPath)
		}
		/* ... */
		nsRef, err = netns.NewNSAtPath(nsPath)
```

netns は bind mount されたファイルとして存在し続けるが、それだけでは「使える状態」とは限らない。外部接続を担う pasta が死んでいれば起動し直し、パスはあるが netns でない (作成途中で殺された、tmpfs でなく再起動をまたいだ) なら消して作り直す。失敗したら unmount して「次のコマンドが成功済みと誤認しない」ようにする。回復経路をコードに埋めているのは、rootless-netns が [pause プロセス](../pause-process/) の user namespace に紐づいていて、pause が死ぬと netns も別の namespace 所有になって使えなくなる、という経験 (コミット 2051e54e01 "rootless netns: recover from invalid netns") があるからだ。

### 外部接続の pasta と user.slice への移動

[`netns_linux.go#L203-L246`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go#L203-L246) の `setupPasta`。コンテナ用と同じ `pasta.Setup` を、`--pid` と (pesto 有効時は) `-c pasta.sock` を足して呼ぶ。

```go title="vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go"
	if systemd.RunsOnSystemd() {
		// Treat these as fatal - if pasta failed to write a PID file something is probably wrong.
		pid, err := readPidFile(pidPath)
		if err != nil {
			return fmt.Errorf("unable to decode pasta PID: %w", err)
		}

		if err := systemd.MoveRootlessNetnsSlirpProcessToUserSlice(pid); err != nil {
			// only log this, it is not fatal but can lead to issues when running podman inside systemd units
			logrus.Errorf("failed to move the rootless netns pasta process to the systemd user.slice: %v", err)
		}
	}
```

この pasta はユーザーに 1 つで、すべてのブリッジコンテナが共有する。最初の `podman run` が systemd unit の中だった場合、pasta はその unit の cgroup で生まれ、unit の停止時に systemd に殺される (4.0.0 の RELEASE_NOTES "systemd could kill the `slirp4netns` process, which is shared between all containers for a given user")。そこで `user.slice` 直下の scope に移す。[`rootless-cgroup-scope`](../rootless-cgroup-scope/) で見る pause プロセスの移動と同じ動機だ。

### /run を差し替える mount namespace

[`netns_linux.go#L364-L396`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go#L364-L396) の `setupMounts`。

```go title="vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go"
	// The order of the mounts is IMPORTANT.
	// The idea of the extra mount ns is to make /run writeable
	// for the network plugins but not affecting the podman user namespace.
	// Because the plugins also need access to XDG_RUNTIME_DIR/netns some special setup is needed.

	// The following bind mounts are needed
	// 1. XDG_RUNTIME_DIR -> XDG_RUNTIME_DIR/rootless-netns/XDG_RUNTIME_DIR
	// 2. /run/systemd -> XDG_RUNTIME_DIR/rootless-netns/run/systemd (only if it exists)
	// 3. XDG_RUNTIME_DIR/rootless-netns/resolv.conf -> /etc/resolv.conf or XDG_RUNTIME_DIR/rootless-netns/run/symlink/target
	// 4. XDG_RUNTIME_DIR/rootless-netns/run -> /run

	// Create a new mount namespace,
	// this must happen inside the netns thread.
	err := unix.Unshare(unix.CLONE_NEWNS)
	if err != nil {
		return wrapError("create new mount namespace", err)
	}

	// Ensure we mount private in our mountns to prevent accidentally
	// overwriting the host mounts in case the default propagation is shared.
	// However using private propagation is not what we want. New mounts/umounts
	// would not be propagated into our namespace. This is a problem because we
	// may hold mount points open that were unmounted on the host confusing users
	// why the underlying device is still busy as they no longer see the mount:
	// https://github.com/containers/podman/issues/25994
	err = unix.Mount("", "/", "", unix.MS_SLAVE|unix.MS_REC, "")
```

netavark も aardvark-dns も `/run` に状態を書く。rootless の Podman は `/run` に書けないので、netavark を実行するスレッドだけ mount namespace を分け、`/run` を `$XDG_RUNTIME_DIR` 配下のディレクトリで覆う。「Podman 自身の mount namespace には影響させない」ためにスレッド単位で行う。`MS_SLAVE` を選ぶ理由のコメントは、`MS_PRIVATE` にしたら「ホストで umount したのに device busy」という問い合わせが来た、という実運用の知見だ。

netavark の実行は [`vendor/go.podman.io/common/libnetwork/netavark/run.go#L127-L139`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/netavark/run.go#L127-L139) で、rootless なら `n.rootlessNetns.Setup(len(options.Networks), setup)` に包むだけ。root と同じ `execNetavark` を呼ぶ。

### 参照カウント

[`netns_linux.go#L570-L596`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go#L570-L596)。

```go title="vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go"
func (n *Netns) Setup(nets int, toRun func() error) error {
	err := n.runInner(toRun, true)
	if err != nil {
		return err
	}
	_, err = refCount(n.dir, nets)
	return err
}

func (n *Netns) Teardown(nets int, toRun func() error) error {
	err := n.runInner(toRun, true)
	if err != nil {
		return err
	}
	// decrement only if teardown didn't fail, podman will call us again on errors so we should not double decrement
	count, err := refCount(n.dir, -nets)
	if err != nil {
		return err
	}

	// cleanup when ref count is 0
	if count == 0 {
		return n.cleanup()
	}

	return nil
}
```

カウントの単位はコンテナではなくネットワーク接続数 (`nets`) で、`network connect` / `disconnect` でも増減する。`Teardown` が失敗したときに減らさないのは、Podman が再試行するので二重に減ってしまうから。0 になったら `cleanup` が pasta に SIGTERM を送り ([`#L335-L351`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/internal/rootlessnetns/netns_linux.go#L335-L351))、netns を unmount する。

### rootlessport: netns を跨いで fd を渡す

Podman はブリッジコンテナに `-p` があると、`rootlessport` という別バイナリを起動する ([`vendor/go.podman.io/common/libnetwork/slirp4netns/slirp4netns.go#L552-L605`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/slirp4netns/slirp4netns.go#L552-L605))。設定は stdin の JSON、fd 3 が ExitFD、fd 4 が ReadyFD という契約だ。

```go title="vendor/go.podman.io/common/libnetwork/slirp4netns/slirp4netns.go"
	cfg := rootlessport.Config{
		Mappings:    opts.Ports,
		NetNSPath:   opts.Netns,
		ExitFD:      3,
		ReadyFD:     4,
		TmpDir:      opts.Config.Engine.TmpDir,
		ChildIP:     childIP,
		ContainerID: opts.ContainerID,
		RootlessCNI: netStatus != nil,
	}
	/* ... */
	// Leak one end of the pipe in rootlessport process, the other will be sent to conmon
	cmd.ExtraFiles = append(cmd.ExtraFiles, opts.RootlessPortExitPipeR, syncW)
```

ExitFD の書き端は conmon に渡す ([`libpod/oci_conmon_common.go#L1178-L1190`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1178-L1190))。

```go title="libpod/oci_conmon_common.go"
		// For rootless port forwarding via rootlessport, create sync pipe and
		// leak write end to conmon. Pasta forwarding mode does not use
		// rootlessport, so no pipe is needed.
		if rootless.IsRootless() && len(ctr.config.PortMappings) > 0 &&
			ctr.runtime.config.Network.RootlessPortForwarder == config.RootlessPortForwarderRootlessport {
			ctr.rootlessPortSyncR, ctr.rootlessPortSyncW, err = os.Pipe()
			/* ... */
			// Leak one end in conmon, the other one will be used by rootlessport
			cmd.ExtraFiles = append(cmd.ExtraFiles, ctr.rootlessPortSyncW)
		}
```

conmon が死ぬ (= コンテナが終わる) と書き端が閉じ、rootlessport の `io.ReadAll(exitR)` が EOF で戻って終了する ([`cmd/rootlessport/main.go#L191-L246`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/rootlessport/main.go#L191-L246))。Podman が rootlessport を kill する経路は無く、寿命は fd で結びつけている。

rootlessport は自分自身を `argv[0] = "rootlessport-child"` で、コンテナの netns の中から再実行する ([`#L133-L162`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/rootlessport/main.go#L133-L162))。

```go title="cmd/rootlessport/main.go"
	// reexec the child process in the child netns
	cmd := exec.Command("/proc/self/exe")
	cmd.Args = []string{ReexecChildKey}
	cmd.Stdin = childQuitR
	/* ... */
	childNS, err := netns.GetNS(cfg.NetNSPath)
	if err != nil {
		return err
	}
	if err := childNS.Do(func(_ netns.NetNS) error {
		logrus.Infof("Starting child driver in child netns (%q %v)", cmd.Path, cmd.Args)
		return cmd.Start()
	}); err != nil {
		return err
	}
```

親はホスト側 (Podman の user namespace、ホストの netns) で listen する。接続が来ると、子に頼んでコンテナ netns の中から `childIP:port` に dial してもらい、そのソケットの fd を受け取る。rootlesskit (v2.3.6) の子側 [`vendor/github.com/rootless-containers/rootlesskit/v2/pkg/port/builtin/child/child.go#L138-L164`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/github.com/rootless-containers/rootlesskit/v2/pkg/port/builtin/child/child.go#L138-L164)。

```go title="vendor/github.com/rootless-containers/rootlesskit/v2/pkg/port/builtin/child/child.go"
	targetConn, err := dialer.Dial(dialProto, net.JoinHostPort(ip, strconv.Itoa(req.Port)))
	if err != nil {
		return err
	}
	defer targetConn.Close() // no effect on duplicated FD
	/* ... */
	oob := unix.UnixRights(int(targetConnFile.Fd()))
	f, err := c.File()
	if err != nil {
		return err
	}
	defer f.Close()
	for {
		err = unix.Sendmsg(int(f.Fd()), []byte("dummy"), oob, nil, 0)
		if err != unix.EINTR {
			break
		}
	}
```

親側 [`parent/tcp/tcp.go#L59-L75`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/github.com/rootless-containers/rootlesskit/v2/pkg/port/builtin/parent/tcp/tcp.go#L59-L75) は受け取った fd を `net.FileConn` に戻し、accept したコネクションとの間で `bicopy` する。ソケットはそれを作った netns に属するが、fd は netns を跨いで渡せる。この性質を使って、「開ける側」と「使う側」を別の netns に置いている。代償として、コンテナから見たソース IP は親のもの (127.0.0.1 など) になる。

`network connect` で veth の IP が変わると、Podman は `$TmpDir/rp/<ctrID>` の unix socket に新しい childIP を送り、rootlessport は全ポートを付け直す ([`#L266-L293`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/rootlessport/main.go#L266-L293))。

### pesto: ソース IP を保つ

[`vendor/go.podman.io/common/libnetwork/pasta/pesto_linux.go#L1-L15`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/pasta/pesto_linux.go#L1-L15)。

```go title="vendor/go.podman.io/common/libnetwork/pasta/pesto_linux.go"
// Pesto client for dynamic port forwarding on a running pasta instance.
//
// Pesto updates pasta's forwarding table via a UNIX domain socket (-c).
// Used by rootless bridge networking: pesto incrementally adds or deletes
// port forwarding rules for individual containers.
//
// Each mapping specifies both the host binding and container target
// address, so pasta forwards traffic directly to the correct
// container IP:ContainerPort.
```

rootless-netns 用の pasta に `-c pasta.sock` を付けて制御ソケットを開けておき、コンテナの起動・停止ごとに転送ルールを足し引きする。rootlessport のユーザー空間コピーではなくカーネルの splice なので、クライアントのソース IP がコンテナまで届く。切り替えは containers.conf の `rootless_port_forwarder` ([`vendor/go.podman.io/common/pkg/config/containers.conf#L408-L424`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/config/containers.conf#L408-L424)) で、コメントは「コンテナが動いている間に変えると、netns が前の設定で作られているのでルールがリークする」と警告している。

## なぜそうなっているか

- **netavark を無改造で使うための層。** rootless-netns は、netavark の前提 (自分が所有する netns、書ける `/run`、`/usr/sbin` にある iptables) を満たすサンドボックスだ。[`vendor/go.podman.io/common/libnetwork/netavark/exec.go#L79-L90`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/netavark/exec.go#L79-L90) が Debian の rootless ユーザーのために `$PATH` に `/usr/sbin` を足しているのも同じ発想で、ツールを直すのではなく環境を整える。
- **rootlessport が別バイナリなのはメモリのため。** 4.0.0 の RELEASE_NOTES: "Rootless port forwarding using the `rootlessport` port forwarder is now handled by a separate binary, not Podman itself, which results in significantly reduced memory usage". Podman のバイナリを再実行すると Go ランタイムと全依存を抱えた常駐プロセスがコンテナごとに残る。
- **寿命をそれぞれ明示する。** コンテナ用 pasta は netns の削除で、rootlessport は conmon に握らせたパイプの EOF で、rootless-netns の pasta は pid ファイルと参照カウントで終わる。「誰が殺すか」を暗黙にしていない。
- **ソース IP の問題は長年の issue。** pesto を追加したコミット e598657244 (2026-04-09) は "preserving source IPs that rootlessport's userspace proxy masks" と書き、issue #8193 を閉じている。6.0 で実験的に追加し、6.1 で IPv6 対応、既定は据え置き ("we will investigate switching at a later date when stability is more certain")、という段階的な導入だ。
- **回復可能性を先に作る。** `getOrCreateNetns` の分岐と、[`test/system/500-networking.bats`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/system/500-networking.bats) の「わざと壊してから回復する」テストは、rootless-netns が pause プロセスやシステム再起動と絡んで壊れる経験から来ている。

## どう活かすか

- 権限の無い環境で既存コンポーネントを動かしたいなら、コンポーネントを直す前に「そのコンポーネントの前提を満たす層」を 1 つ足せないか考える。前提は所有権 (netns)、書き込み先 (`/run`)、パス (`/usr/sbin`) のように列挙できる。
- 補助プロセスの寿命は、pid を覚えて kill するより、fd や namespace のようなカーネルオブジェクトに結びつける。conmon にパイプの片端を握らせる手法は、「監視役が死んだら自動で終わる」を最小コストで実現する。
- namespace や権限の境界を跨ぐ必要があるとき、`SCM_RIGHTS` での fd 受け渡しは汎用的な手段になる。「開ける側」と「使う側」を分けて、それぞれ最小の権限で動かせる。
- 共有リソースの参照カウントは、減らす条件を「後始末が成功したとき」に限定する。失敗時に再試行される設計なら、失敗時に減らすと二重に減る。
- ユーザーに見えない層を足したなら、その層が壊れたときの回復経路 (検出、警告、作り直し) をテストで固定する。
- 取り込むべきでない条件: 権限があるなら直接やる。コメントの通り、root で rootless-netns 相当を使うのは遅くて複雑なだけだ。ユーザー空間プロキシ (rootlessport 方式) は監査ログや IP ベースのアクセス制御が要る用途には向かないので、その場合は pesto 方式か rootful を選ぶ。
