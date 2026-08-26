---
title: "cgroup を自分で作らず、systemd に D-Bus で「委譲済みの scope」をもらう"
description: "cgroup v2 では、自分が所有する cgroup の下でしか子 cgroup を作れない。ログインシェルの cgroup は root 所有なので、rootless の Podman は自分自身を Delegate=true の transient scope に移してから動く。同じ D-Bus 呼び出しを pause プロセス、conmon、rootless-netns の pasta にも使い回し、systemd が無ければ警告して cgroupfs (制限なし) に倒れる。"
sidebar:
  order: 10
---

## 何を学んだか

### どんな状況の話か

rootless に必要な委譲は user namespace だけではない。コンテナに `--memory` や `--pids-limit` をかけるには cgroup が要り、cgroup v2 の規則では **自分が所有する cgroup ディレクトリの下でしか子 cgroup を作れない**。ログインシェルが属する cgroup は通常 `session-N.scope` で、これは root 所有だ。[user namespace に入って](../constructor-reexec/) uid 0 になっても、cgroup ディレクトリの所有者は変わらない。

systemd はこの問題への標準的な出口を持っている。`user@<uid>.service` に `Delegate=` された範囲の中なら、非特権ユーザーも cgroup を作れる。問題は、Podman を起動したプロセスがその範囲の中にいるとは限らないこと (`su -l` や `sudo -u` で作ったセッションが典型) だ。

### Podman の答え

1. **自分の cgroup を所有していなければ、systemd に頼んで transient scope を作ってもらい、そこに移る。** `/proc/self/cgroup` のパスを `stat` して所有者を euid と比べ、違えば D-Bus の `StartTransientUnit` で `podman-<pid>.scope` を `user.slice` の下に `Delegate=true` で作る。systemd が cgroup ディレクトリを作ってユーザーに chown するので、Podman は cgroupfs を直接触らない。
2. **同じ関数を 4 種のプロセスに使い回す。** Podman 自身、[pause プロセス](../pause-process/) (`podman-pause-<乱数>.scope`)、conmon (`libpod-conmon-<id>.scope`)、[rootless-netns の pasta](../rootless-network-bridge/)。呼び出し元の cgroup から切り離したい長生きプロセスは、すべてこの経路で `user.slice` 直下に移す。
3. **移動は best effort。** 失敗しても Debug ログで続行する。ただし conmon は「cgroup に入れてから」起動を許可する順序を、start fd で保証する。
4. **systemd のユーザーセッションが無ければ cgroupfs に格下げする。** 警告を 4 行出して `--cgroup-manager=cgroupfs` に倒し、rootless + cgroupfs では cgroup を作らない (= 制限をかけない) 方向に静かに倒れる。
5. **cgroup v1 は v6 で切った。** 起動直後に v1 なら Fatal で止まるので、分岐は「v2 + systemd あり / なし」の 2 系統だけになった。

## ソースコードのどこか

### 自分を scope に移す

[`pkg/domain/infra/abi/system_linux.go#L24-L67`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/system_linux.go#L24-L67) の `SetupRootless` 前半。この分岐に入るのは、user namespace への再 exec 後の子 (euid が 0 に見える) か本物の root だ。

```go title="pkg/domain/infra/abi/system_linux.go"
	// check for both euid == 0 and CAP_SYS_ADMIN because we may be running in a container with CAP_SYS_ADMIN set.
	if os.Geteuid() == 0 && hasCapSysAdmin {
		// do it only after podman has already re-execed and running with uid==0.
		configureCgroup := cgroupMode != "disabled"
		if configureCgroup {
			ownsCgroup, err := cgroups.UserOwnsCurrentSystemdCgroup()
			if err != nil {
				logrus.Infof("Failed to detect the owner for the current cgroup: %v", err)
			}
			if !ownsCgroup {
				conf, err := ic.Config(context.Background())
				if err != nil {
					return err
				}
				unitName := fmt.Sprintf("podman-%d.scope", os.Getpid())
				if runsUnderSystemd || conf.Engine.CgroupManager == config.SystemdCgroupsManager {
					if err := systemd.RunUnderSystemdScope(os.Getpid(), "user.slice", unitName); err != nil {
						logrus.Debugf("Failed to add podman to systemd sandbox cgroup: %v", err)
					}
				}
			}
		}

		// return early as we are already re-exec or root here so no need to join the rootless userns.
		return nil
	}
```

所有判定は containers/common (v0.69.1) の [`vendor/go.podman.io/common/pkg/cgroups/cgroups_linux.go#L494-L549`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/cgroups/cgroups_linux.go#L494-L549)。

```go title="vendor/go.podman.io/common/pkg/cgroups/cgroups_linux.go"
// UserOwnsCurrentSystemdCgroup checks whether the current EUID owns the
// current cgroup.
func UserOwnsCurrentSystemdCgroup() (bool, error) {
	uid := os.Geteuid()
	/* ... */
	f, err := os.Open("/proc/self/cgroup")
	/* ... */
		cgroupPath := filepath.Join(cgroupRoot, parts[2])

		st, err := os.Stat(cgroupPath)
		if err != nil {
			return false, err
		}
		/* ... */
		if int(s.(*syscall.Stat_t).Uid) != uid {
			return false, nil
		}
```

この比較は user namespace の中で行われる。ホストの uid 1000 が所有するディレクトリは、namespace の中では uid 0 に見えるので、`geteuid() == 0` と一致して「所有している」になる。root 所有 (`session-N.scope`) はマッピングの外なので 65534 に見え、不一致になる。[uid マッピング](../userns-idmap/) が `stat` の結果にどう効くかの実例だ。

### D-Bus で transient scope を作る

[`vendor/go.podman.io/common/pkg/systemd/systemd_linux.go#L101-L143`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/systemd/systemd_linux.go#L101-L143) の `RunUnderSystemdScope`。

```go title="vendor/go.podman.io/common/pkg/systemd/systemd_linux.go"
// RunUnderSystemdScope adds the specified pid to a systemd scope.
func RunUnderSystemdScope(pid int, slice string, unitName string) error {
	var conn *systemdDbus.Conn
	var err error

	if unshare.GetRootlessUID() != 0 {
		conn, err = cgroups.UserConnection(unshare.GetRootlessUID())
		if err != nil {
			return err
		}
	} else {
		conn, err = systemdDbus.NewWithContext(context.Background())
		if err != nil {
			return err
		}
	}
	defer conn.Close()
	properties := []systemdDbus.Property{
		systemdDbus.PropSlice(slice),
		newProp("PIDs", []uint32{uint32(pid)}),
		newProp("Delegate", true),
		newProp("DefaultDependencies", false),
	}
	ch := make(chan string)
	_, err = conn.StartTransientUnitContext(context.Background(), unitName, "replace", properties, ch)
	if err != nil {
		// On errors check if the cgroup already exists, if it does move the process there
		if props, err := conn.GetUnitTypePropertiesContext(context.Background(), unitName, "Scope"); err == nil {
			if cgroup, ok := props["ControlGroup"].(string); ok && cgroup != "" {
				if err := cgroups.MoveUnderCgroup(cgroup, "", []uint32{uint32(pid)}); err == nil {
					return nil
				}
				// On errors return the original error message we got from StartTransientUnit.
			}
		}
		return err
	}

	// Block until job is started
	<-ch

	return nil
}
```

接続先は、rootless なら「namespace の外での uid」(`GetRootlessUID`) のセッションバス。自分は namespace の中で uid 0 に見えているので、環境変数で受け取った本来の uid が要る。`Delegate=true` が肝で、systemd はこの scope の cgroup サブツリーを「呼び出し側が管理する」ものとして扱い、以降 Podman や crun が子 cgroup を作っても干渉しない。`StartTransientUnit` が失敗したときは、同名の scope がすでにあればその `ControlGroup` に `cgroup.procs` を直接書いて入る。

### pause プロセスは乱数の scope 名で

[`systemd_linux.go#L72-L99`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/systemd/systemd_linux.go#L72-L99)。

```go title="vendor/go.podman.io/common/pkg/systemd/systemd_linux.go"
// MovePauseProcessToScope moves the pause process used for rootless mode to keep the namespaces alive to
// a separate scope.
func MovePauseProcessToScope(pausePidPath string) {
	var err error

	for range 10 {
		randBytes := make([]byte, 4)
		_, err = rand.Read(randBytes)
		if err != nil {
			logrus.Errorf("failed to read random bytes: %v", err)
			continue
		}
		err = moveProcessPIDFileToScope(pausePidPath, "user.slice", fmt.Sprintf("podman-pause-%x.scope", randBytes))
		if err == nil {
			return
		}
	}
```

呼び出しは [`system_linux.go#L106-L111`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/system_linux.go#L106-L111) で、こちらは namespace の外の親側で走る。`podman system migrate` は `NoMoveProcess` annotation でこれを飛ばす。これから殺す pause を scope に移しても意味がないからだ。名前を乱数にした理由はコミット ee62711136 (2021-11-17): "we try hard to re-use the existing podman-pause.scope name when it already exists, causing any sort of race errors when the already existing scope is terminating. There is no such a requirement though, so just try with a random name."

pause を別 scope に置く理由はコミット a2c8b5d9d6 には書かれていない。同ファイルの pasta 版のコメント ([`#L61-L62`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/systemd/systemd_linux.go#L61-L62)) "into a different scope so that systemd does not kill it with a container" が最も近く、呼び出し元のセッションや unit の停止に巻き込まれないため、と読める (推測を含む)。

### conmon は cgroup に入れてから起動を許可する

[`libpod/oci_conmon_linux.go#L172-L231`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_linux.go#L172-L231) の `moveConmonToCgroupAndSignal`。

```go title="libpod/oci_conmon_linux.go"
	if mustCreateCgroup {
		// Usually rootless users are not allowed to configure cgroupfs.
		// There are cases though, where it is allowed, e.g. if the cgroup
		// is manually configured and chowned).  Avoid detecting all
		// such cases and simply use a lower log level.
		logLevel := logrus.WarnLevel
		if rootless.IsRootless() {
			logLevel = logrus.InfoLevel
		}
		/* ... */
		if ctr.CgroupManager() == config.SystemdCgroupsManager {
			unitName := createUnitName("libpod-conmon", ctr.ID())
			/* ... */
			if err := systemd.RunUnderSystemdScope(cmd.Process.Pid, realCgroupParent, unitName); err != nil {
				logrus.StandardLogger().Logf(logLevel, "Failed to add conmon to systemd sandbox cgroup: %v", err)
			}
		} else {
			control, err := cgroups.New(cgroupPath, &cgroupResources)
			/* ... */
		}
	}

	/* We set the cgroup, now the child can start creating children */
	return writeConmonPipeData(startFd)
```

conmon は start fd に書き込まれるまで OCI ランタイムを起動しない。だから「scope に入れる → 合図する」の順序が守られ、コンテナのプロセスは最初から正しい cgroup の下に生まれる。

### systemd が無ければ cgroupfs に倒す

[`vendor/go.podman.io/common/pkg/config/config.go#L775-L815`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/config/config.go#L775-L815) の `CheckCgroupsAndAdjustConfig`。`NewRuntime` の最後 ([`libpod/runtime.go#L225`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L225)) で呼ばれる。

```go title="vendor/go.podman.io/common/pkg/config/config.go"
	if !hasSession && unshare.GetRootlessUID() != 0 {
		logrus.Warningf("The cgroupv2 manager is set to systemd but there is no systemd user session available")
		logrus.Warningf("For using systemd, you may need to log in using a user session")
		logrus.Warningf("Alternatively, you can enable lingering with: `loginctl enable-linger %d` (possibly as root)", unshare.GetRootlessUID())
		logrus.Warningf("Falling back to --cgroup-manager=cgroupfs")
		c.Engine.CgroupManager = CgroupfsCgroupsManager
	}
```

セッションの有無は `$XDG_RUNTIME_DIR/bus` の存在で判定し、見つかれば `DBUS_SESSION_BUS_ADDRESS` を Podman 自身が setenv する。倒れた先の rootless + cgroupfs では、[`libpod/container_internal_linux.go#L366-L370`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal_linux.go#L366-L370) が OCI spec の cgroup パスを空にして、ランタイムに cgroup を作らせない。

```go title="libpod/container_internal_linux.go"
	case (rootless.IsRootless() && cgroupManager == config.CgroupfsCgroupsManager):
		if c.config.CgroupParent == "" || !isRootlessCgroupSet(c.config.CgroupParent) {
			return "", nil
		}
		fallthrough
```

「エラー」ではなく「制限をかけない」に倒れる。ユーザーに見えるのは `Falling back to --cgroup-manager=cgroupfs` の警告だけだ。

### systemd が無い環境での最低限の退避

[`vendor/go.podman.io/common/pkg/cgroups/utils_linux.go#L284-L303`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/cgroups/utils_linux.go#L284-L303) の `MaybeMoveToSubCgroup`。`SetupRootless` の冒頭で、systemd が無く、かつ pid 1 かコンテナの中 (`$container` がある) なら呼ばれる。

```go title="vendor/go.podman.io/common/pkg/cgroups/utils_linux.go"
// MaybeMoveToSubCgroup moves the current process in a sub cgroup when
// it is running in the root cgroup on a system that uses cgroupv2.
func MaybeMoveToSubCgroup() error {
	maybeMoveToSubCgroupSync.Do(func() {
		/* ... */
		if cgroup == "/" {
			maybeMoveToSubCgroupSyncErr = MoveUnderCgroupSubtree("init")
		}
	})
	return maybeMoveToSubCgroupSyncErr
}
```

cgroup v2 の「内部プロセスなし」の規則で、root cgroup にプロセスがいると子 cgroup にコントローラを有効化できない。コンテナの中で Podman を動かすときに踏む問題 (issue #14884) で、まず `init` サブ cgroup に自分を退避する。

### cgroup v1 は起動時に切る

[`cmd/podman/root_cgroups_linux.go#L11-L23`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/root_cgroups_linux.go#L11-L23)。

```go title="cmd/podman/root_cgroups_linux.go"
func checkSupportedCgroups() {
	if registry.IsRemote() {
		// In remote mode we should not error for missing cgroups as just the server needs it.
		return
	}
	unified, err := cgroups.IsCgroup2UnifiedMode()
	if err != nil {
		logrus.Fatalf("Error determining cgroups mode")
	}
	if !unified {
		logrus.Fatalf("Cgroups v1 not supported")
	}
}
```

## なぜそうなっているか

- **所有していない cgroup からは移動できない。** 自己 scope 移動を入れたコミット afd0818326 (2019-09-06, Giuseppe Scrivano) "rootless: automatically create a systemd scope": "on cgroup v2 it is necessary that a process before it can moved to a different cgroup tree must be in a directory owned by the unprivileged user. This is not always true, e.g. when creating a session with su -l." そして "for running systemd in a container it was before necessary to specify `systemd-run --scope --user podman ...`, now this is done automatically". ユーザーが手で打っていた `systemd-run --scope` を、Podman が D-Bus で自動化した。
- **conmon にも常に cgroup を作る。** コミット 78e2a31943 (2019-10-30): "always create a new cgroup for conmon also when running as rootless. We were previously creating one only when necessary, but that behaves differently than root containers." root と rootless で挙動を揃える方向。
- **委譲の範囲は systemd の設定次第。** [`troubleshooting.md#L694-L734`](https://github.com/podman-container-tools/podman/blob/v6.1.0/troubleshooting.md#L694-L734) は、既定で委譲されるコントローラが `memory pids` だけで、`cpu` や `cpuset` の制限をかけるには `/etc/systemd/system/user@.service.d/delegate.conf` に `Delegate=memory pids cpu cpuset` が要る、と説明している。scope を作れても、その中で使えるコントローラは systemd が決める。
- **セッションが無い状況は想定内。** [`troubleshooting.md#L940`](https://github.com/podman-container-tools/podman/blob/v6.1.0/troubleshooting.md#L940): "Podman expects a valid login session for the `rootless+cgroupv2` use-case ... Typical scenarios of such cases are seen when users are trying to use Podman with `su - <user> -c '<podman-command>'`, or `sudo -l` and badly configured systemd session." 壊れるのではなく制限なしで動く、を選んでいる。

## どう活かすか

- 特権が要る操作を、それを持つデーモン (systemd) に D-Bus で頼む。自分で cgroupfs を `mkdir` / `chown` せず、`Delegate=true` の scope をもらえば、以降のサブツリーは自分のものになる。1024 未満のポートを socket activation でもらうのも同じ発想だ。
- 長生きさせたい補助プロセスは、呼び出し元の cgroup から切り離す。セッションや unit の停止時に systemd が cgroup ごと kill する、という挙動は、それを前提に設計しないと「なぜか消えた」になる。
- 再試行で同名のリソースを作り直すとき、終了中の古い同名リソースと競合するなら、名前に乱数を足す。「同じ名前にする必要が本当にあるか」を疑う。
- 環境が要件を満たさないときに、機能を落として続行し警告で知らせる (cgroupfs フォールバック) のは CLI ツールとして妥当な判断だが、その結果「制限が黙って消える」ことは docs に書く。
- 順序が要る初期化 (cgroup に入れてから子を作る) は、子に「合図が来るまで待つ」プロトコルを持たせて保証する。親が「たぶん間に合う」に頼らない。
- 取り込むべきでない条件: 単発の CLI がすべて自分を transient scope に移す必要はない。D-Bus の往復 (`<-ch` でジョブ完了待ち) はコストで、Podman も所有していれば移動しない。systemd 非採用環境ではこの経路は丸ごと通らないので、`MaybeMoveToSubCgroup` のような最低限の退避だけが残る。
