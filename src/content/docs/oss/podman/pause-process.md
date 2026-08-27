---
title: "namespace を生かし続けるために最小のプロセスを 1 つ置き、勝者の決定はファイルの原子的な rename に任せる"
description: "user+mount namespace は参照するプロセスが全部消えると破棄される。Podman は自分自身を _PODMAN_PAUSE=1 で exec した pause プロセスを 1 ユーザーに 1 つだけ置き、pid を renameat2(RENAME_NOREPLACE) で公開する。同時起動で負けた側は勝者に join する。Linux 6.18 以降は nsfs のファイルハンドルでプロセス自体を不要にする実験機能がある。"
group: "rootless"
sidebar:
  order: 7
---

## 何を学んだか

### どんな状況の話か

[前のページ](../userns-idmap/) までで、rootless の Podman は自分用の user+mount namespace を作り、そこで root として動くことを見た。問題は、その namespace の寿命だ。Linux の namespace は、それを参照するもの (所属するプロセス、`/proc/<pid>/ns/*` を開いた fd、bind mount) が全部無くなった瞬間に破棄される。`podman run -d` が終了してもコンテナと conmon は動き続けるので namespace は残るが、コンテナが 1 つも無い状態で `podman ps` を打てば、その Podman が終わった時点で namespace は消える。

消えて困る理由は 2 つある。1 つは、mount namespace の中で行った overlay のマウントが namespace とともに消えること。もう 1 つは、次に起動した Podman が namespace を作り直すことになり、稼働中の conmon と別の namespace に入ってしまう競合が起きること。Podman はデーモンを持たないので、「namespace を保持し続ける常駐プロセス」は本来存在しない。

### Podman の答え

1. **何もしないプロセスを 1 つ置く。** namespace を作った直後、Podman は自分自身のバイナリを `_PODMAN_PAUSE=1` 付きで exec する。C の constructor がこの環境変数を見て Go ランタイムを起動する前に `catatonit -P` に exec し、pid を `$XDG_RUNTIME_DIR/libpod/tmp/pause.pid` に書く。以降の Podman はこの pid の `/proc/<pid>/ns/user` と `ns/mnt` に `setns()` する。
2. **pause は二重 fork で孤児にし、setsid で端末から切り離す。** Podman の終了やシェルのジョブ制御に巻き込まれないようにする。
3. **同時起動の勝者はファイルの `renameat2(RENAME_NOREPLACE)` で決める。** 一時ファイルに pid を書いてから上書き禁止で rename し、失敗したら自分の pause を殺して、親に「負けた」を伝える。親は `pause.pid` を読んで勝者の namespace に join する。
4. **pause は 1 ユーザーに 1 つ。** `--root` や `--tmpdir` を変えても `pause.pid` の場所は変わらない。複数の namespace ができると、どの Podman がどの namespace にいるかで挙動が変わる "nasty bugs" が起きる。
5. **pid の再利用と stale ファイルに備える。** join に失敗したら `/proc/<pid>/environ` に `_PODMAN_PAUSE=1` があるかで本当に pause プロセスか確かめ、違えばファイルを消す。
6. **v6.1.0 の実験機能: プロセスの代わりに nsfs のファイルハンドルを保存する。** Linux 6.18 で `open_by_handle_at` が nsfs に対して非特権でも使えるようになったので、`name_to_handle_at` で得たハンドルを `ns_handles` ファイルに保存し、次回はそれで `setns()` する。namespace が消えていれば `ESTALE` で作り直す。`PODMAN_NO_PAUSE_PROCESS` で有効化する。

## ソースコードのどこか

### pause プロセスの生成

[`pkg/rootless/rootless_linux.c#L975-L1111`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L975-L1111) の `create_pause_process`。namespace 内の Podman (再 exec 前の子) → `clone` → 中間プロセス → `clone` → pause 本体、という構造で、中間プロセスが pid ファイルを置く。

```c title="pkg/rootless/rootless_linux.c"
      setsid ();
      pid = syscall_clone (SIGCHLD, NULL);
      if (pid < 0)
        _exit (EXIT_FAILURE);

      if (pid)
        {
          char pid_str[12];
          char *tmp_file_path = NULL;

          sprintf (pid_str, "%d", pid);

          if (asprintf (&tmp_file_path, "%s/pause.pid.XXXXXX", state_dir) < 0)
            {
              /* ... */
            }
          /* ... mkstemp して pid を書く ... */

          /* There can be another process at this point trying to configure the user namespace and the pause
           process, do not override the pid file if it already exists. */
          if (rename_noreplace (AT_FDCWD, tmp_file_path, AT_FDCWD, pause_pid_file_path) < 0)
            {
              unlink (tmp_file_path);
              kill (pid, SIGKILL);
              _exit (EXIT_FAILURE);
            }

          r = TEMP_FAILURE_RETRY (write (p[1], "0", 1));
```

`rename_noreplace` ([`#L84-L108`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L84-L108)) は `renameat2(RENAME_NOREPLACE)` を試し、カーネルが対応していなければ `link` + `unlink` に落ちる。すでに `pause.pid` があれば失敗するので、そのときは自分が作った pause を殺して `_exit(EXIT_FAILURE)` する。これが上位に伝わって [`constructor-reexec`](../constructor-reexec/) で見た `'2'` になり、Go 側が勝者の pid を読んで join する。中間プロセスは `_exit` するので pause 本体は孤児になり、init (または subreaper) に引き取られる。

pause 本体 ([`#L1082-L1109`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L1082-L1109)) は fd を全部閉じて自分自身を exec する。

```c title="pkg/rootless/rootless_linux.c"
          for (fd = 3; fd < open_files_max_fd + 16; fd++)
            close (fd);

          setenv ("_PODMAN_PAUSE", "1", 1);
          execlp (argv[0], argv[0], NULL);

          /* If the execve fails, then do the pause here.  */
          do_pause ();
          _exit (EXIT_FAILURE);
```

exec された Podman は constructor の冒頭で `_PODMAN_PAUSE` を見て `do_pause()` ([`#L512-L536`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L512-L536)) に入る。

```c title="pkg/rootless/rootless_linux.c"
  /* Attempt to execv catatonit to keep the pause process alive.  */
  execl (LIBEXECPODMAN "/catatonit", "catatonit", "-P", NULL);
  execl ("/usr/bin/catatonit", "catatonit", "-P", NULL);
  /* and if the catatonit executable could not be found, fallback here... */

  prctl (PR_SET_NAME, "podman pause", NULL, NULL, NULL);
  while (1)
    pause ();
```

Podman のバイナリを一度経由するのは、C の constructor が動く「Podman バイナリ」であれば Go ランタイムを初期化せずに済み、かつ `argv[0]` から確実に見つかるからだ。最終的には数十 KB の `catatonit` に置き換わる。`ps` では `catatonit -P` か `podman pause` として見える。

### 1 ユーザーに 1 つ

pid ファイルの場所は [`pkg/util/utils_supported.go#L28-L39`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/util/utils_supported.go#L28-L39)。

```go title="pkg/util/utils_supported.go"
// GetRootlessStateDir returns the directory that holds the rootless state
// (pause.pid and ns_handles files).
func GetRootlessStateDir() (string, error) {
	runtimeDir, err := homedir.GetRuntimeDir()
	if err != nil {
		return "", err
	}
	// Note this path must be kept in sync with pkg/rootless/rootless_linux.c
	// We only want a single pause process per user, so we do not want to use
	// the tmpdir which can be changed via --tmpdir.
	return filepath.Join(runtimeDir, "libpod", "tmp"), nil
}
```

`--tmpdir` の下に置くと、`--tmpdir` ごとに pause ができてしまう。system test [`test/system/550-pause-process.bats#L43-L49`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/system/550-pause-process.bats#L43-L49) がその理由を書いている。

```bash title="test/system/550-pause-process.bats"
    # There are nasty bugs when we are not in the correct userns,
    # we have some settings that only work in the first ever created userns.
    # As root this happens when we join the systemd user session (i.e. is the case for
    # login shells).
    # To prevent any issues we should only ever have a single pause process running,
    # regardless of any --root/-runroot/--tmpdir values.
```

### 古い pid ファイルへの備え

Go 側の `TryJoinPauseProcess` ([`pkg/rootless/rootless.go#L29-L74`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless.go#L29-L74)) は、join に失敗しても即座にファイルを消さない。

```go title="pkg/rootless/rootless.go"
	became, ret, err := TryJoinFromFilePaths("", []string{pausePidPath})
	if err == nil {
		return became, ret, nil
	}

	// It could not join the pause process, let's lock the file before trying to delete it.
	pidFileLock, err := lockfile.GetLockFile(pausePidPath)
	/* ... */
	pidFileLock.Lock()
	defer func() {
		pidFileLock.Unlock()
	}()

	// Now the pause PID file is locked.  Try to join once again in case it changed while it was not locked.
	became, ret, err = TryJoinFromFilePaths("", []string{pausePidPath})
	if err != nil {
		// It is still failing.  We can safely remove it.
		os.Remove(pausePidPath)
		return false, -1, nil
	}
```

ロックを取ってからもう一度 join を試し、それでも駄目なら消す。ロック無しで消すと、別の Podman が今まさに書き直した新しい `pause.pid` を消してしまう。

pid が再利用された場合は、`TryJoinFromFilePaths` ([`rootless_linux.go#L440-L478`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L440-L478)) が `/proc/<pid>/environ` を見る。

```go title="pkg/rootless/rootless_linux.go"
			if !isPauseProcess(pid) {
				logrus.Warningf("pause.pid file refers to PID %d which is not a pause process, the process may have exited and the PID been recycled. Removing %s", pid, path)
				os.Remove(path)
				lastErr = err
				continue
			}
```

`pause` が死んで同じ pid を無関係なプロセスが取ると、`kill(pid, 0)` は成功するが `setns` は失敗する。`_PODMAN_PAUSE=1` が environ に残っていることを、そのプロセスが本当に pause かどうかの証拠として使う。C 側にも同じ判定 `is_pause_process` ([`rootless_linux.c#L646-L694`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L646-L694)) がある。これは 2026 年 3 月のコミット a2db18f35c "rootless: detect and remove stale pause.pid with recycled PIDs" (issue #28157) で入った。

### pause を殺す: podman system migrate

`/etc/subuid` を変えても、namespace はもうできているので反映されない。[`libpod/runtime_migrate_linux.go#L17-L49`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_migrate_linux.go#L17-L49) の `stopPauseProcess`。

```go title="libpod/runtime_migrate_linux.go"
		nsHandlesPath := rootless.GetNamespaceHandlesPath(stateDir)
		if err := os.Remove(nsHandlesPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			logrus.Warnf("Failed to remove namespace handles file %s: %v", nsHandlesPath, err)
		}

		pausePidPath := rootless.GetPausePidPath(stateDir)
		data, err := os.ReadFile(pausePidPath)
		/* ... */
		if err := os.Remove(pausePidPath); err != nil {
			return fmt.Errorf("cannot delete pause pid file %s: %w", pausePidPath, err)
		}
		if err := syscall.Kill(pausePid, syscall.SIGKILL); err != nil {
			return err
		}
```

`Migrate` ([`libpod/runtime_migrate.go#L21-L52`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_migrate.go#L21-L52)) はこの前に全コンテナを止める。コンテナが動いたままだと conmon が古い namespace を保持し続け、次の Podman は `TryJoinFromFilePaths` で conmon の namespace に join してしまう。docs ([`podman-system-migrate.1.md#L13-L24`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-system-migrate.1.md#L13-L24)) がこの手順の理由を説明している。

### プロセスを置かない: nsfs のファイルハンドル

v6.1.0 で入った実験機能。namespace を作った直後、[`rootless_linux.c#L147-L172`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L147-L172) の `get_ns_handles` が `/proc/self/ns/mnt` と `ns/user` のファイルハンドルを取る。

```c title="pkg/rootless/rootless_linux.c"
  mnt_fd = open ("/proc/self/ns/mnt", O_RDONLY | O_CLOEXEC);
  if (mnt_fd < 0)
    return -1;

  if (name_to_handle_at (mnt_fd, "", (struct file_handle *) &handles->mntns, &mount_id, AT_EMPTY_PATH) < 0)
    return -1;
```

次回の起動では `set_ns_handles` ([`#L184-L227`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L184-L227)) が `ns_handles` ファイルを読み、`open_by_handle_at` で fd を得て `setns()` する。

```c title="pkg/rootless/rootless_linux.c"
  mntns_fd = open_by_handle_at (FD_NSFS_ROOT, (struct file_handle *) &handles.mntns, O_RDONLY);
  if (mntns_fd < 0)
    return -1;

  userns_fd = open_by_handle_at (FD_NSFS_ROOT, (struct file_handle *) &handles.userns, O_RDONLY);
  if (userns_fd < 0)
    return -1;

  if (setns (userns_fd, 0) != 0)
    return -1;

  /* This is a fatal error we can't recover from since we have already joined the userns.  */
  join_namespace_or_die ("mnt", mntns_fd);
```

`FD_NSFS_ROOT` (-10003) は Linux 6.18 で追加された特殊な dirfd で、これを渡すと nsfs のハンドルを **非特権で** 開ける (通常の `open_by_handle_at` は `CAP_DAC_READ_SEARCH` が要る)。ヘッダはまだ広く配布されていないので、`/usr/include/linux/fcntl.h` からコピーした定義を [`#L26-L31`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L26-L31) に置いている。

有効化は [`#L302-L363`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.c#L302-L363) の `get_and_save_ns_handles_with_lock` で判定する。

```c title="pkg/rootless/rootless_linux.c"
  char *env = getenv ("PODMAN_NO_PAUSE_PROCESS");
  /* ... */
  if (env == NULL || strcmp(env, "0") == 0)
      {
        if (unlink(ns_handles_path) < 0 && errno != ENOENT)
          return -1;

        /* Pretend the kernel does not support it and move on.  */
        errno = EOPNOTSUPP;
        return -1;
      }

  lock_fd = acquire_ns_handles_lock (state_dir);
  if (lock_fd < 0)
    return -1;

  /* Now that we hold the lock, revalidate the file.  */
  if (set_ns_handles (ns_handles_path) == 0)
    return 0;
```

既定では「カーネルが対応していないふり」(`EOPNOTSUPP`) をして pause の経路に落ちる。有効なら `flock` を取り、ロックの中で「すでに別の Podman が保存したハンドルがあれば、自分の namespace を捨ててそちらに join する」。pause の `rename_noreplace` と同じ「勝者は 1 人」の規則を、ロック + 再検証で実現している。

pause との違いは、**ハンドルは namespace を生かさない** ことだ。コミット f172ff789b (2026-01-15) は "The namespace file handles are stored in a file and can be used to rejoin the namespaces, as long as the namespaces still exist" と書いている。コンテナが 1 つも動いていなければ namespace は消え、次の Podman は `ESTALE` で新しく作る。マッピングは `/etc/subuid` から決定的に導かれるので、作り直しても同じ ID 配置になり、ストレージ上のファイルの所有者と矛盾しない。この解釈はソースに明示されていないので推測を含む。

なお、6.1.0 の RELEASE_NOTES はこの機能の環境変数を `drop-pause-process` と書いているが、実装と man ページ ([`docs/source/markdown/podman.1.md#L318-L321`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman.1.md#L318-L321)) は `PODMAN_NO_PAUSE_PROCESS` だ。

## なぜそうなっているか

- **pause は競合を消すために導入された。** コミット 791d53a214 (2019-05-08) "rootless: use a pause process": "This solves all the race conditions we had on joining the correct namespaces using the conmon processes." それ以前は稼働中コンテナの conmon の namespace に join していたが、コンテナが止まるタイミングで join 先が消える競合があった。conmon への join は今もフォールバックとして残っている ("As a fallback if the join fails for any reason (e.g. the pause process was killed), then we try to join the running containers as we were doing before")。
- **1 ユーザー 1 つは、複数の namespace を許すと壊れる設定があるから。** test の "we have some settings that only work in the first ever created userns" がそれで、`--tmpdir` ごとに pause ができていた頃の issue #17903 を受けて、pid ファイルを `--tmpdir` の外に固定した。
- **ファイルシステムの原子性で勝者を決めるのは、ロックファイルより単純で、クラッシュしてもロックが残らないから。** `renameat2(RENAME_NOREPLACE)` は「無ければ置く」を 1 回のシステムコールで行う。負けた側は自分の成果 (pause) を殺して勝者の成果に乗り換える。
- **プロセスからハンドルへの移行は、常駐プロセスを減らす設計変更。** pause 方式には「ログアウト時に systemd が cgroup ごと kill する」「pid の再利用」「別 tmpdir で複数できる」といった運用上の罠が積み重なっていて、その多くはプロセスを置くこと自体に由来する。カーネル側に非特権で使える nsfs ハンドルが入ったのを機に、**機能検出 + 既定オフ + 環境変数ゲート** で段階導入している。

## どう活かすか

- カーネルオブジェクト (namespace、マウント) の寿命を延ばしたいなら、まず「参照を持つ最小のプロセス」で済ませ、そのプロセスは自前で書かず `catatonit` のような既存の最小バイナリに exec する。自前のバイナリを経由するのは、起動経路を 1 つに保つためだけにする。
- 「共有リソースを最初に作った 1 人だけが勝つ」は、`mkstemp` + `RENAME_NOREPLACE` で実装できる。負けた側の回復手順 (勝者の成果を読んで乗り換える) を、勝敗の判定と同じくらい丁寧に書く。
- pid ファイルを信じない。pid の再利用に備えて、そのプロセスが本当に自分の置いたものかを示す証拠 (environ、コマンドライン、起動時刻) を確認してから消す。消すときはロックを取って再検証する。
- 状態ファイルの場所を、ユーザーが変えられるディレクトリの下に置かない。「1 ユーザーに 1 つ」という不変条件は、置き場所の設計で守る。
- 常駐プロセスを新しいカーネル機能で置き換えるときは、既定オフの環境変数ゲートと、「対応していない」系の errno でのフォールバックを最初から用意する。
- 取り込むべきでない条件: pause 方式そのものは Podman 自身が置き換えを進めている設計で、これから同種の仕組みを作るなら、bind mount した `/proc/<pid>/ns/*` や (6.18 以降なら) nsfs ハンドルを先に検討する。
