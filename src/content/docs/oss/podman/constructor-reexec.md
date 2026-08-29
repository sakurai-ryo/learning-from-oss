---
title: "Go ランタイムが動く前に、C の constructor で user namespace に入る"
description: "user namespace への setns はシングルスレッドのプロセスでしか許されない。Go の main に着く頃にはもう複数スレッドがあるので、Podman は cgo の __attribute__((constructor)) で Go より先に namespace に入る。入れなければ自分自身を clone して再 exec し、外側のプロセスはシグナルと終了コードを中継するだけの殻になる。"
group: "rootless"
sidebar:
  order: 25
---

## 何を学んだか

### どんな状況の話か

rootless の Podman は、一般ユーザーとして起動されたあと、**user namespace の中で「root」として動く**。イメージのレイヤーを展開するときに複数の uid のファイルを作る必要があるし、mount namespace を持たなければ overlay をマウントできない。だから `podman ps` のような読み取り専用のコマンドでも、最初にやることは「自分のユーザーの namespace に入ること」だ。なぜ user namespace が必要になるのかは [非特権でコンテナを作るのに何が要るか](../rootless-basics/) を先に読むと分かりやすい。

ここに Go 固有の壁がある。`setns(fd, CLONE_NEWUSER)` と `unshare(CLONE_NEWUSER)` は、**呼び出したプロセスがマルチスレッドだと `EINVAL` で失敗する** (man `user_namespaces(7)`, `setns(2)`)。mount namespace の `setns` も、他スレッドとファイルシステム属性を共有していると同じく失敗する。Go のランタイムは `main()` に到達する前に sysmon などのスレッドを起動するので、Go のコードから namespace に入ることは原理的にできない。

### Podman の答え

1. **Go より先に動く C で入る。** cgo で `__attribute__((constructor))` を付けた `init()` を用意し、ELF のロード直後、Go ランタイムがスレッドを作る前に既存の namespace へ `setns()` する。成功すれば再 exec なしの 1 プロセスで済む (shortcut)。
2. **namespace がまだ無ければ、自分自身を clone して再 exec する。** Go 側から C の `reexec_in_user_namespace` を呼び、`clone(CLONE_NEWUSER|CLONE_NEWNS)` で生まれたシングルスレッドの子が、親が uid_map を書き終えるのを待ってから `/proc/self/exe` を exec する。外側の Podman は、子にシグナルを転送して終了コードを返すだけの殻になる。
3. **既存の namespace に後から join するときも fork してから。** `fork()` 直後の子はシングルスレッドなので、そこで `setns()` してから exec する。
4. **世代間の状態は環境変数と 1 バイトの同期ソケットで渡す。** `_CONTAINERS_USERNS_CONFIGURED` (`init` / `done`)、`_CONTAINERS_ROOTLESS_UID` などの環境変数で「もう namespace に入ったか」「外の世界での uid は何か」を伝え、親子の同期は `'0'` / `'1'` / `'2'` の 1 バイトで行う。
5. **shortcut を使ってよいコマンドは C 側にハードコードする。** `podman version` や `podman compose` のように親 namespace で動く必要があるコマンドは、C の `can_use_shortcut()` と Go の cobra annotation の両方に列挙し、コメントで二重管理を明示する。

## ソースコードのどこか

### constructor の入口

[`pkg/rootless/rootless_linux.c#L720-L737`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L720-L737)。`_PODMAN_PAUSE` が設定されていれば、このプロセスは [pause プロセス](../pause-process/) として起動されたものなので、Go ランタイムを初期化する前に `do_pause()` に入って戻らない。

```c title="pkg/rootless/rootless_linux.c"
static void __attribute__((constructor)) init()
{
  const char *xdg_runtime_dir;
  const char *pause;
  /* ... */

  pause = getenv ("_PODMAN_PAUSE");
  if (pause && pause[0])
    {
      do_pause ();
      _exit (EXIT_FAILURE);
    }
```

続く [`#L739-L777`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L739-L777) では `/proc/self/fd` を読んで「Go ランタイムが動く前に開いていた fd」を記録する。コメントは "Store how many FDs were open before the Go runtime kicked in." で、あとで再 exec するときに、外から継承した fd (systemd の socket activation など) だけを親側で閉じるために使う。

### shortcut: 既存の namespace に setns する

[`#L812-L851`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L812-L851)。euid が 0 でなく、`XDG_RUNTIME_DIR` があり、コマンドが shortcut を許すものなら、まず nsfs のファイルハンドル (`ns_handles`)、次に `pause.pid` の順で既存 namespace を探す。

```c title="pkg/rootless/rootless_linux.c"
  /* Shortcut.  If we are able to join the existing namespace, do it now so we
     don't need to re-exec.  First try using namespace file handles, then fall back
     to the pause.pid approach for older kernels.  */
  xdg_runtime_dir = getenv ("XDG_RUNTIME_DIR");
  if (geteuid () != 0 && xdg_runtime_dir && xdg_runtime_dir[0] && can_use_shortcut (argv))
    {
      /* ... */
      cwd = getcwd (NULL, 0);
      /* ... */
      len = snprintf (path, PATH_MAX, "%s/libpod/tmp/ns_handles", xdg_runtime_dir);
      /* ... */
      if (set_ns_handles (path) == 0)
        goto joined;
```

`cwd` を先に取っておくのは、mount namespace を切り替えると cwd の解決結果が変わりうるので、join 後に `chdir(cwd)` で戻すためだ。

失敗したときの扱いは errno で 3 通りに分かれる ([`#L853-L869`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L853-L869))。

```c title="pkg/rootless/rootless_linux.c"
      /* If the handle is stale, give up with the shortcut.  */
      if (errno == ESTALE)
        return;

      /* Fall back to pause.pid if:
         - ENOENT ns_handles file doesn't exist
         - EOPNOTSUPP kernel doesn't support open_by_handle_at
         - ENOSYS syscall not available
         - EPERM (could be seccomp when running in a container)
       */
      if (errno != ENOENT && errno != EOPNOTSUPP && errno != ENOSYS && errno != EPERM)
        {
          /* Anything else is fatal.  */
          fprintf (stderr, "error opening namespace handles: %m\n");
          _exit (EXIT_FAILURE);
        }
```

`ESTALE` (ハンドルは読めたが namespace はもう無い) なら shortcut を諦めて Go 側に任せる。`ENOENT` などの「その機構が使えない」系なら `pause.pid` に落ちる。それ以外は致命的。

`pause.pid` 経由の join ([`#L885-L913`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L885-L913)) は、user namespace → mount namespace の順に入る。

```c title="pkg/rootless/rootless_linux.c"
      if (setns (userns_fd, 0) < 0)
        {
          check_stale_pause_pid (pid, path);
          return;
        }

      /* This is a fatal error we can't recover from since we have already joined the userns.  */
      join_namespace_or_die ("mnt", mntns_fd);
```

順序に意味がある。mount namespace への `setns` には `CAP_SYS_ADMIN` が要り、それは **先に user namespace に入ることで初めて得られる**。逆に、user namespace に入ったあとで mount namespace の join に失敗すると、もう uid が変わっているので元に戻れず、`_exit` するしかない。

join に成功したら環境変数を設定し、namespace 内の uid 0 になる ([`#L915-L945`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L915-L945))。

```c title="pkg/rootless/rootless_linux.c"
joined:
      sprintf (uid_fmt, "%d", uid);
      sprintf (gid_fmt, "%d", gid);

      setenv ("_CONTAINERS_USERNS_CONFIGURED", "init", 1);
      setenv ("_CONTAINERS_ROOTLESS_UID", uid_fmt, 1);
      setenv ("_CONTAINERS_ROOTLESS_GID", gid_fmt, 1);

      /* We are in the user+mount namespace, these errors are not recoverable.  */

      if (syscall_setresgid (0, 0, 0) < 0)
        {
          fprintf (stderr, "cannot setresgid: %m\n");
          _exit (EXIT_FAILURE);
        }

      if (syscall_setresuid (0, 0, 0) < 0)
        {
          fprintf (stderr, "cannot setresuid: %m\n");
          _exit (EXIT_FAILURE);
        }
```

namespace に入った直後のプロセスは、その namespace の中では「マッピングされていない uid」(overflowuid の 65534) として見える。`setresuid(0,0,0)` で namespace 内の root になると、ホストから見た uid は元のユーザーのままで、namespace の中でだけ全 capability を持つ。glibc の `setresuid()` ではなく raw syscall (`syscall_setresuid`, [`#L123-L133`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L123-L133)) を使っているのは、glibc 版が全スレッドに uid を反映させるために内部でシグナルを使うのを避けるためだと思われる (推測)。

### environ は C と Go で別物

C の constructor が `setenv()` した値は libc の `environ` に入るが、Go ランタイムは起動時に受け取った envp のスナップショットを持つので、`os.Getenv` からは見えない。そのため Go 側の `init()` ([`pkg/rootless/rootless_linux.go#L45-L60`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L45-L60)) が C から uid を聞き直して設定し直す。

```go title="pkg/rootless/rootless_linux.go"
func init() {
	rootlessUIDInit := int(C.rootless_uid())
	rootlessGIDInit := int(C.rootless_gid())
	if rootlessUIDInit != 0 {
		// we need this if we joined the user+mount namespace from the C code.
		if err := os.Setenv("_CONTAINERS_USERNS_CONFIGURED", "done"); err != nil {
			logrus.Errorf("Failed to set environment variable %s as %s", "_CONTAINERS_USERNS_CONFIGURED", "done")
		}
		if err := os.Setenv("_CONTAINERS_ROOTLESS_UID", strconv.Itoa(rootlessUIDInit)); err != nil {
			logrus.Errorf("Failed to set environment variable %s as %d", "_CONTAINERS_ROOTLESS_UID", rootlessUIDInit)
		}
		/* ... */
	}
}
```

同じ問題を、依存先の containers/storage は `C.getenv` を呼ぶ専用ラッパー ([`vendor/go.podman.io/storage/pkg/unshare/getenv_linux_cgo.go#L15-L22`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/storage/pkg/unshare/getenv_linux_cgo.go#L15-L22)) で解決している。

### shortcut を許すコマンドの列挙

[`#L605-L644`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L605-L644) の `can_use_shortcut`。

```c title="pkg/rootless/rootless_linux.c"
static bool
can_use_shortcut (char **argv)
{
  bool ret = true;
  int argc;

#ifdef DISABLE_JOIN_SHORTCUT
  return false;
#endif

  if (strstr (argv[0], "podman") == NULL)
    return false;

  for (argc = 0; argv[argc]; argc++)
    {
      if (argc == 0 || argv[argc][0] == '-')
        continue;

      if (strcmp (argv[argc], "mount") == 0
          || strcmp (argv[argc], "machine") == 0
          || strcmp (argv[argc], "version") == 0
          || strcmp (argv[argc], "context") == 0
          || strcmp (argv[argc], "search") == 0
          || strcmp (argv[argc], "compose") == 0)
        {
          ret = false;
          break;
        }
      /* ... */
```

Go 側には対応する cobra annotation があり、コメントが C 側との同期を要求している ([`cmd/podman/registry/config.go#L23-L24`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/registry/config.go#L23-L24))。

```go title="cmd/podman/registry/config.go"
	// ParentNSRequired used as cobra.Annotation when a command should not be run in the podman rootless user namespace, also requires updates in `pkg/rootless/rootless_linux.c` in function `can_use_shortcut()` to exclude the command name there.
	ParentNSRequired = "ParentNSRequired"
```

`podman compose` が除外されている理由は [`cmd/podman/compose.go#L35`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/compose.go#L35) のコメント "don't join user NS for SSH to work correctly" にある。`podman-remote` ビルドでは `#cgo remote CFLAGS: ... -DDISABLE_JOIN_SHORTCUT` ([`rootless_linux.go#L29`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L29)) で shortcut 自体を無効化する。

### 再 exec: clone した子が uid_map を待ってから exec する

shortcut が使えなかった場合、Go の `PersistentPreRunE` ([`cmd/podman/root.go#L423-L438`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/root.go#L423-L438)) から `SetupRootless` ([`pkg/domain/infra/abi/system_linux.go#L69-L114`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/system_linux.go#L69-L114)) に入り、`pause.pid` → 稼働中コンテナの conmon の namespace → 新規作成、の順で試す。

```go title="pkg/domain/infra/abi/system_linux.go"
	if len(paths) > 0 {
		became, ret, err = rootless.TryJoinFromFilePaths(stateDir, paths)
		// TryJoinFromFilePaths fails with ESRCH when the PID are all not valid anymore
		// In this case create a new userns.
		if errors.Is(err, unix.ESRCH) {
			logrus.Warnf("Failed to join existing conmon namespace, creating a new rootless podman user namespace. If there are existing container running please stop them with %q to reset the namespace", os.Args[0]+" system migrate")
			became, ret, err = rootless.BecomeRootInUserNS(stateDir)
		}
	} else {
		logrus.Info("Creating a new rootless user namespace")
		became, ret, err = rootless.BecomeRootInUserNS(stateDir)
	}
	/* ... */
	if became {
		os.Exit(ret)
	}
```

新規作成は C の `reexec_in_user_namespace` ([`rootless_linux.c#L1286-L1335`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L1286-L1335))。

```c title="pkg/rootless/rootless_linux.c"
  pid = syscall_clone (CLONE_NEWUSER|CLONE_NEWNS|SIGCHLD, NULL);
  if (pid < 0)
    {
      fprintf (stderr, "cannot clone: %m\n");
      check_proc_sys_userns_file (_max_user_namespaces);
      check_proc_sys_userns_file (_unprivileged_user_namespaces);
    }
  if (pid)
    {
      if (do_socket_activation)
        {
          /* ... 継承した LISTEN_FDS を親側で閉じ、LISTEN_* を unset ... */
        }
      return pid;
    }
```

マルチスレッドの親からでも `clone(CLONE_NEWUSER)` は許される。生まれる子がシングルスレッドだからだ。Go 側は `runtime.LockOSThread()` で呼び出しスレッドを固定してから呼ぶ ([`rootless_linux.go#L251-L252`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L251-L252))。`clone` に失敗したら `/proc/sys/user/max_user_namespaces` などを読んで「user namespace が無効化されていないか」を診断する。

子側 ([`#L1360-L1405`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L1360-L1405)) は、環境変数を `done` に設定したあと、親から `'0'` が届くまで **待ってから** `setresuid(0,0,0)` する。

```c title="pkg/rootless/rootless_linux.c"
  setenv ("_CONTAINERS_USERNS_CONFIGURED", "done", 1);
  setenv ("_CONTAINERS_ROOTLESS_UID", uid, 1);
  setenv ("_CONTAINERS_ROOTLESS_GID", gid, 1);

  ret = TEMP_FAILURE_RETRY (read (ready, &b, 1));
  /* ... */
  if (ret != 1 || b != '0')
    _exit (EXIT_FAILURE);

  if (syscall_setresgid (0, 0, 0) < 0)
    {
      fprintf (stderr, "cannot setresgid: %m\n");
      TEMP_FAILURE_RETRY (write (ready, "1", 1));
      _exit (EXIT_FAILURE);
    }
```

待つ理由は、uid_map が書かれる前の namespace には uid 0 が存在しないからだ。`/proc/<pid>/uid_map` を書けるのは namespace の外にいる親だけで、その手順は [次のページ](../userns-idmap/) で扱う。

最後に [`#L1413-L1455`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L1413-L1455) で namespace を生かし続けるための仕掛け (nsfs ハンドルの保存、または pause プロセスの生成) を済ませ、親に `'0'` を送って `/proc/self/exe` を exec する。

```c title="pkg/rootless/rootless_linux.c"
  ret = TEMP_FAILURE_RETRY (write (ready, "0", 1));
  /* ... */
  close (ready);

  if (sigprocmask (SIG_SETMASK, &oldsigset, NULL) < 0)
    {
      fprintf (stderr, "cannot block signals: %m\n");
      _exit (EXIT_FAILURE);
    }

  execvp ("/proc/self/exe", argv);
  fprintf (stderr, "failed to reexec: %m\n");

  _exit (EXIT_FAILURE);
```

`argv` は Go の `os.Args` ではなく `/proc/self/cmdline` から C 側で復元する ([`#L538-L603`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L538-L603))。`/proc/self/exe` を exec するので、バイナリが差し替えられていても同じ実体を再実行できる。

### 同期プロトコルの Go 側

[`rootless_linux.go#L345-L376`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L345-L376)。親→子は `'0'` (マッピング完了) か `'1'` (失敗)。子→親は `'0'` (exec 直前)、`'1'` (setresuid 失敗)、`'2'` (`pause.pid` の作成競合に負けた)。

```go title="pkg/rootless/rootless_linux.go"
	if b[0] == '2' {
		// We have lost the race for writing the PID file, as probably another
		// process created a namespace and wrote the PID.
		// Try to join it.
		pausePidPath := stateDir + "/pause.pid"
		data, err := os.ReadFile(pausePidPath)
		if err == nil {
			var pid uint64
			pid, err = strconv.ParseUint(string(data), 10, 0)
			if err == nil {
				return joinUserAndMountNS(uint(pid), "")
			}
		}
		return false, -1, fmt.Errorf("setting up the process: %w", err)
	}
```

`'2'` は「同時に起動した別の Podman が先に namespace を作った」という意味で、親は自分の子を捨てて勝者の namespace に join する。同時起動の競合を、C 側は `renameat2(RENAME_NOREPLACE)` で検出し、Go 側はこの 1 バイトで受け取って回復する。

exec が成功したら、外側の Podman は殻になる ([`#L379-L415`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L379-L415))。

```go title="pkg/rootless/rootless_linux.go"
	// Disable all existing signal handlers, from now forward everything to the child and let
	// it deal with it. All we do is to wait and propagate the exit code from the child to our parent.
	gosignal.Reset()
	c := make(chan os.Signal, len(signals))
	gosignal.Notify(c, signals...)
	go func() {
		for s := range c {
			if s == unix.SIGCHLD || s == unix.SIGPIPE {
				continue
			}

			if err := unix.Kill(int(pid), s.(unix.Signal)); err != nil {
				/* ... */
			}
		}
	}()

	ret := C.reexec_in_user_namespace_wait(pid, 0)
```

`podman run` 中に Ctrl-C したとき、外側のプロセスが SIGINT を内側に流すのはこの仕組みで、[`test/system/550-pause-process.bats#L95-L113`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/system/550-pause-process.bats#L95-L113) がそれを検証している。

### 後から join するときも fork する

稼働中コンテナの conmon の namespace に入る `reexec_userns_join` ([`#L1113-L1265`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L1113-L1265)) は、`/proc/<pid>/ns/user` と `ns/mnt` を開いてから `fork()` し、シングルスレッドになった子で `setns()` する。

```c title="pkg/rootless/rootless_linux.c"
  if (prctl (PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0) < 0)
    {
      fprintf (stderr, "cannot prctl(PR_SET_PDEATHSIG): %m\n");
      _exit (EXIT_FAILURE);
    }

  join_namespace_or_die ("user", userns_fd);
  join_namespace_or_die ("mnt", mntns_fd);
```

3 つの経路 (constructor、`fork` 直後、`clone(CLONE_NEWUSER)` で生まれた子) はどれも「namespace の操作はシングルスレッドの文脈で行う」という同じ制約に従っている。

## なぜそうなっているか

- **Go から namespace を触れないのは言語ランタイムの構造上の制約。** Podman のコメントに直接は書かれていないが、shortcut を導入したコミット 562357ebb2 (2019-05-08) のメッセージが "we can now attempt to join the namespaces as soon as Podman starts (and before the Go runtime kicks in), so that we don't need to re-exec and use just one process" と述べている。再 exec は制約を満たす最初の解で、constructor はその高速化だ。
- **単一の user namespace を全コンテナで共有するから、join が「普通の経路」になる。** コミット 72382a12a7 (2019-03-19) "rootless: use a single user namespace" は、以前のコンテナごとの namespace をやめた理由を列挙している: 実装が単純になる、別コンテナの namespace に入れる、`ps` がすべてのコンテナを見られる、そして "there are only two ways to enter in a namespace, either by creating a new one if no containers are running or joining the existing one from any container"。入口が 2 つしかないから、C の constructor でその片方を先取りできる。
- **フォールバックの段階は、失敗の意味で分ける。** `ESTALE` は「機構は使えるが対象が消えた」、`ENOENT` / `EOPNOTSUPP` / `ENOSYS` / `EPERM` は「この機構が使えない環境」、それ以外は「壊れている」。前 2 つは次の手段に進み、最後だけ止まる。新しい機構 (nsfs ハンドル) を古いカーネルや seccomp 下でも安全に導入できるのはこの分類のおかげだ。
- **コマンド名のハードコードは、C 側が cobra のコマンドツリーを知らないための妥協。** `podman version` が namespace に入らないよう変更された際 (RELEASE_NOTES の "The `podman version` command no longer joins the rootless user namespace") も、C と Go の両方を直している。二重管理を消す代わりに、コメントで同期を要求する形に留めている。

## どう活かすか

- ランタイム (Go、JVM、Python の C 拡張) が初期化されたあとではできない OS 操作があるなら、ELF の constructor か「自分自身を再 exec する」パターンでプロセスの最初に押し込む。どちらも、環境変数で「もう済んだ」を子孫に伝える設計が要る。
- 高速経路と低速経路の両方を持つなら、高速経路の失敗を errno の意味で分類し、「次の手段へ」「その機構は諦める」「止まる」を明示的に分ける。すべてを致命的にすると新しい機構を段階導入できず、すべてを黙って飲むと壊れた環境に気づけない。
- 親子プロセスの同期は、1 バイトのメッセージで足りる。`'0'` / `'1'` / `'2'` のように値の意味を列挙し、両側で対称に扱う。`'2'` のような「競合に負けた」を独立した値にしておくと、回復 (勝者に join する) を親側で実装できる。
- cgo の constructor を使うなら、`environ` が C と Go で分離することを前提に設計する。C で `setenv` した値は Go の `os.Getenv` から見えない。
- 取り込むべきでない条件: cgo を必須にするとクロスコンパイルと静的リンクが難しくなり、`rootless_unsupported.go` のようなスタブも要る。namespace 操作が不要なプログラムに持ち込む価値はない。また、`can_use_shortcut` のようなコマンド名の二重管理は、C 側に選択肢がないからの妥協であって、真似すべき形ではない。
