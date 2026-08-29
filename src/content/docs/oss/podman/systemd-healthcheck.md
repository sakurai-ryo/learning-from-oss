---
title: "常駐タイマーを持たず、systemd の transient timer に「自分自身を呼び戻させる」"
description: "デーモンレスなので定期実行の主体がいない。Podman はコンテナ起動時に systemd-run で transient な timer + service を作り、interval ごとに podman healthcheck run を起動させる。各実行は 1 回きりで、状態はコンテナごとの JSON ファイルが状態機械として持つ。systemd が無い環境では build tag と実行時検出で黙って無効になり、フォールバック実装は無い。"
group: "systemd 統合"
sidebar:
  order: 40
---

## 何を学んだか

### どんな状況の話か

Docker の `HEALTHCHECK` は、デーモンが interval ごとにコンテナ内でコマンドを実行し、結果を覚えている。Podman には[デーモンがない](../conmon-supervision/)ので、「interval ごとに何かを実行する主体」が存在しない。`podman run` はコンテナを起動したら終了するし、conmon は監視役であってスケジューラではない。ヘルスチェックの実行そのものが exec セッションとしてどう走るかは [exec とヘルスチェックのプロセスはどこにぶら下がるか](../exec-and-healthcheck-processes/) を参照。

### Podman の答え

1. **OS のスケジューラに、自分自身を呼び戻すよう登録する。** コンテナの init 時に `systemd-run --unit <cid>-<乱数> --on-unit-inactive=<interval> ... podman healthcheck run --ignore-result <cid>` を実行し、transient な timer と service を作る。systemd が interval ごとに `podman healthcheck run` という別プロセスを起動する。
2. **各実行は冪等に状態ファイルを更新する。** `podman healthcheck run` はコマンドを 1 回 exec し、コンテナごとの `healthcheck.log` (JSON) を読んで FailingStreak を更新し、閾値を越えたら unhealthy にして書き戻す。ファイルが状態機械で、プロセスは毎回使い捨てだ。
3. **transient unit の扱いには 4 つの規律がある。** 名前は毎回乱数にする、timer → service の順で止める、failed 状態を reset する、start rate limit を切る。どれも運用で踏んだ問題への対処として入った。
4. **startup healthcheck は「後継を作ってから自分を殺す」。** 起動時の緩いチェックが閾値回成功したら、通常の timer を作って起動し、それから自分の unit を止める。自分を止めると SIGTERM で死ぬので、終了コードを 0 に書き換えておく。
5. **systemd が無ければ黙って無効。** `systemd` build tag が無いビルド、`/run/systemd/system` が無い環境、`DISABLE_HC_SYSTEMD=true` では timer 系の関数が no-op になる。フォールバックの自前ループは無く、手動の `podman healthcheck run` か外部スケジューラに委ねる。

## ソースコードのどこか

### transient timer を作る

[`libpod/healthcheck_linux.go#L22-L72`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck_linux.go#L22-L72) の `createTimer`。ファイル冒頭は `//go:build !remote && systemd`。

```go title="libpod/healthcheck_linux.go"
// createTimer systemd timers for healthchecks of a container
func (c *Container) createTimer(interval string, isStartup bool) error {
	if c.disableHealthCheckSystemd(isStartup) {
		return nil
	}

	hcUnitName := c.hcUnitName(isStartup, false)

	podman, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get path for podman for a health check timer: %w", err)
	}

	cmd := []string{"--property", "LogLevelMax=notice"}
	if rootless.IsRootless() {
		cmd = append(cmd, "--user")
	}
	path := os.Getenv("PATH")
	if path != "" {
		cmd = append(cmd, "--setenv=PATH="+path)
	}

	// StartLimitIntervalSec=0 so we don't hit the restart limit
	cmd = append(cmd, "--unit", hcUnitName, fmt.Sprintf("--on-unit-inactive=%s", interval), "--timer-property=AccuracySec=1s", "--property=StartLimitIntervalSec=0", podman)

	cmd = append(cmd, specgenutil.GlobalPodmanArgs(c.runtime.storageConfig, c.runtime.config, logrus.IsLevelEnabled(logrus.DebugLevel))...)

	cmd = append(cmd, "healthcheck", "run", "--ignore-result", c.ID())

	conn, err := systemd.ConnectToDBUS()
	if err != nil {
		return fmt.Errorf("unable to get systemd connection to add healthchecks: %w", err)
	}
	conn.Close()
	logrus.Debugf("creating systemd-transient files: %s %s", "systemd-run", cmd)
	systemdRun := exec.Command("systemd-run", cmd...)
	if output, err := systemdRun.CombinedOutput(); err != nil {
		/* ... */
	}

	c.state.HCUnitName = hcUnitName
	if err := c.save(); err != nil {
		return fmt.Errorf("saving container %s healthcheck unit name: %w", c.ID(), err)
	}
```

読みどころが 4 つある。`--on-unit-inactive` は「service が inactive になってから interval 後」に発火するので、周期は固定間隔ではなく「interval + 実行時間」になる。`StartLimitIntervalSec=0` は、短い interval で systemd の start rate limit に当たり "Start request repeated too quickly" で止まる問題 (コミット ed6f63af10, 2025-10-20) への対処。`GlobalPodmanArgs` で `--root` や `--runroot` を timer 側の Podman にも渡し、同じストレージを見せる。そして D-Bus 接続は「繋がるか」の確認だけに使ってすぐ閉じる。

unit 名の乱数 ([`#L179-L194`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck_linux.go#L179-L194))。

```go title="libpod/healthcheck_linux.go"
// Systemd unit name for the healthcheck systemd unit.
// Bare indicates that a random suffix should not be applied to the name. This
// was default behavior previously, and is used for backwards compatibility.
func (c *Container) hcUnitName(isStartup, bare bool) string {
	unitName := c.ID()
	if isStartup {
		unitName += "-startup"
	}
	if !bare {
		// Ensure that unit names are unique from run to run by appending
		// a random suffix.
		// Ref: RH Jira RHEL-26105
		unitName += fmt.Sprintf("-%x", rand.Int())
	}
	return unitName
}
```

コミット 4fd84190b8 (2024-05-03): "Systemd dislikes it when we rapidly create and remove a transient unit. Solution: If we change the name every time, it's different enough that systemd is satisfied". 名前を DB に保存するようになったので、空なら古い Podman が作った unit として乱数なしの名前に戻す後方互換がある。

### 止めるときの順序と reset

[`#L114-L162`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck_linux.go#L114-L162) の `removeTransientFiles`。

```go title="libpod/healthcheck_linux.go"
	// Stop the timer before the service to make sure the timer does not
	// fire after the service is stopped.
	timerChan := make(chan string)
	timerFile := fmt.Sprintf("%s.timer", unitName)
	if _, err := conn.StopUnitContext(ctx, timerFile, "ignore-dependencies", timerChan); err != nil {
		/* ... */
	}

	serviceChan := make(chan string)
	serviceFile := fmt.Sprintf("%s.service", unitName)
	if _, err := conn.StopUnitContext(ctx, serviceFile, "ignore-dependencies", serviceChan); err != nil {
		/* ... */
	}
	// Reset the service after stopping it to make sure it's being removed, systemd keep failed transient services
	// around in its state. We do not care about the error and we need to ensure to reset the state so we do not
	// leak resources forever.
	if err := conn.ResetFailedUnitContext(ctx, serviceFile); err != nil {
		logrus.Debugf("Failed to reset unit file: %q", err)
	}
```

failed 状態の transient unit は systemd の中に残り続ける。[`test/system/220-healthcheck.bats#L131-L138`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/system/220-healthcheck.bats#L131-L138) が `systemctl list-units "*$cid*"` で unit がリークしていないことを検査している (issue #22884)。

`startTimer` ([`#L85-L112`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck_linux.go#L85-L112)) は `.timer` ではなく `.service` を `RestartUnit` する。起動直後に 1 回目のチェックを即実行し、その service が inactive になった時点から周期が始まる。

### 無効化の 3 段

[`#L164-L177`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck_linux.go#L164-L177)。

```go title="libpod/healthcheck_linux.go"
func (c *Container) disableHealthCheckSystemd(isStartup bool) bool {
	if !systemdCommon.RunsOnSystemd() || os.Getenv("DISABLE_HC_SYSTEMD") == "true" {
		return true
	}
	if isStartup {
		if c.config.StartupHealthCheckConfig.Interval == 0 {
			return true
		}
	}
	if c.config.HealthCheckConfig.Interval == 0 {
		return true
	}
	return false
}
```

`RunsOnSystemd` は `/run/systemd/system` がディレクトリとして存在するか (`sd_booted(3)` と同じ判定)。`Interval == 0` は `--health-interval=disable`。`DISABLE_HC_SYSTEMD` はテストが手動実行と timer の競合を避けるためのスイッチだ ([`220-healthcheck.bats#L435-L436`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/system/220-healthcheck.bats#L435-L436))。

build tag 側は [`libpod/healthcheck_nosystemd_linux.go#L1-L23`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck_nosystemd_linux.go#L1-L23)。

```go title="libpod/healthcheck_nosystemd_linux.go"
//go:build !remote && !systemd

package libpod
/* ... */
// createTimer systemd timers for healthchecks of a container
func (c *Container) createTimer(_ string, _ bool) error {
	return nil
}

// startTimer starts a systemd timer for the healthchecks
func (c *Container) startTimer(_ bool) error {
	return nil
}
```

タグは [`Makefile#L66`](https://github.com/podman-container-tools/podman/blob/v6.1.0/Makefile#L66) の `hack/systemd_tag.sh` が `sd-daemon.h` の有無で決め、無ければビルド時に警告する ([`#L394-L398`](https://github.com/podman-container-tools/podman/blob/v6.1.0/Makefile#L394-L398))。

### 状態機械はファイル

[`libpod/healthcheck.go#L374-L409`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck.go#L374-L409) の `updateHealthCheckLog`。

```go title="libpod/healthcheck.go"
// UpdateHealthCheckLog parses the health check results and writes the log
// NOTE: The caller must lock the container.
func (c *Container) updateHealthCheckLog(hcl define.HealthCheckLog, hcResult define.HealthCheckStatus, inStartPeriod bool) (define.HealthCheckResults, error) {
	healthCheck, err := c.readHealthCheckLog()
	/* ... */
	if hcl.ExitCode == 0 {
		//	set status to healthy, reset failing state to 0
		healthCheck.Status = define.HealthCheckHealthy
		healthCheck.FailingStreak = 0
	} else {
		if len(healthCheck.Status) < 1 {
			healthCheck.Status = define.HealthCheckHealthy
		}
		if hcResult == define.HealthCheckContainerStopped {
			healthCheck.Status = define.HealthCheckStopped
		} else if !inStartPeriod {
			// increment failing streak
			healthCheck.FailingStreak++
			// if failing streak > retries, then status to unhealthy
			if healthCheck.FailingStreak >= c.HealthCheckConfig().Retries {
				healthCheck.Status = define.HealthCheckUnhealthy
			}
		}
	}
	healthCheck.Log = append(healthCheck.Log, hcl)
	if c.HealthCheckMaxLogCount() != 0 && len(healthCheck.Log) > int(c.HealthCheckMaxLogCount()) {
		healthCheck.Log = healthCheck.Log[1:]
	}
	return healthCheck, c.writeHealthCheckLog(healthCheck)
}
```

毎回別プロセスなので、前回までの状態はファイルから読むしかない。[コンテナロック](../shm-lock-manager/)を取ってから読み書きする。

### 後継を作ってから自分を殺す

[`#L233-L282`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck.go#L233-L282) の `incrementStartupHCSuccessCounter`。

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
	return c.recreateHealthCheckTimer(ctx, false, true)
```

`recreateHealthCheckTimer` ([`#L284-L305`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck.go#L284-L305)) は「新しい timer を create → start → 古い unit (= 自分) を remove」の順で、自分を殺す前に後継を立てる。終了コードの細工は [shutdown のページ](../shutdown-inhibit/)で見た `SetExitCode` の 2 つ目の使い手だ。

### on-failure=restart は Stop だけする

[`#L199-L231`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/healthcheck.go#L199-L231)。

```go title="libpod/healthcheck.go"
	case define.HealthCheckOnFailureActionRestart:
		// We let the cleanup process handle the restart.  Otherwise
		// the container would be restarted in the context of a
		// transient systemd unit which may cause undesired side
		// effects.
		if err := c.Stop(); err != nil {
			return fmt.Errorf("restarting/stopping container after health-check turned unhealthy: %w", err)
		}
```

transient unit の中でコンテナを再起動すると、新しい conmon が healthcheck 用 service の cgroup 配下に生まれてしまう。Stop だけして restart policy に任せる。

### rootless では private socket に直接繋ぐ

[`pkg/systemd/dbus.go#L129-L148`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/dbus.go#L129-L148)。

```go title="pkg/systemd/dbus.go"
func newRootlessConnection() (*dbus.Conn, error) {
	return dbus.NewConnection(func() (*godbus.Conn, error) {
		return dbusAuthRootlessConnection(func(_ ...godbus.ConnOption) (*godbus.Conn, error) {
			path := filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "systemd", "private")
			path, err := filepath.EvalSymlinks(path)
			if err != nil {
				return nil, err
			}
			return godbus.Dial(fmt.Sprintf("unix:path=%s", path))
		})
	})
}
```

session bus を経由せず、ユーザーの systemd の private socket に直接繋ぐ。`dbus-daemon` が要らない。

## なぜそうなっているか

- **systemd 依存は明言されている。** コミット 28774f18c5 (2022-12-05, Paul Holzinger) "disable healthchecks automatically on non systemd systems": "The podman healthchecks are implemented using systemd timers, this works great but it will never work on non systemd distros. Currently the logic always assumes systemd is available and will fail with an error, so users are forced to always run with `--no-healthcheck` ... we should just default to no healthcheck on these systems. First, use the systemd build tag to disable it at build time if this tag is not used. Second, use make sure systemd is used as init before trying to use healthchecks." 自前のタイマーを持たない理由を直接述べたコミットは無いが、常駐せずに定期実行を実現するには OS のスケジューラに委ねるしかない、という帰結と読める (推測)。
- **timer 作成の失敗はコンテナ起動の失敗にした。** コミット 47a743bba2 (2025-03-04): "When starting a container consider healthcheck errors fatal. That way user know when systemd-run failed to setup the timer to run the healthcheck and we don't get into a state where the container is running but not the healthcheck." [`220-healthcheck.bats#L519-L538`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/system/220-healthcheck.bats#L519-L538) は偽の `systemd-run` を `PATH` に置いてこれを検証している。
- **transient service の状態はチェック結果に依存させない。** コミット 2828965a75 (2026-02-06) "healthcheck_linux: avoid failing transient units": "The main purpose of the transient services/timers is to trigger the healthcheck execution in regular intervals, their own state should not depend on the result of the healthchecks." これが `--ignore-result` の由来で、unhealthy でも service は成功終了する。
- **`--sdnotify=healthy` で healthcheck を systemd の READY に変換できる。** `waitForHealthy` ([`libpod/container_internal.go#L1331-L1360`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L1331-L1360)) は healthy になるまで待って READY を送る。[Quadlet](../quadlet-generator/) の `Notify=healthy` がこれを使う。

## どう活かすか

- 常駐プロセスを持たないツールが定期処理を必要とするなら、OS のスケジューラ (systemd timer、cron、launchd) に「自分自身を呼び戻す」よう登録し、各実行は冪等に状態ファイルを更新する。プロセスは使い捨て、状態はファイル。
- transient unit を使うなら 4 点セット。名前をユニークにする、timer → service の順で止める、failed 状態を reset する、start rate limit を切る。どれも省くと、動作はするが運用でリークや停止に遭う。
- 「後継を作ってから自分を殺す」順序と、終了コードを意図的に変える理由は、コードのコメントに残す。読み手が驚く挙動だから。
- 環境依存の機能は build tag + 実行時検出 + 環境変数の 3 段で無効化できるようにし、テストからも切れるようにする。
- 取り込むべきでない条件: `--on-unit-inactive` 相当の「前回の終了から N 秒」は、固定間隔が厳密に要る監視 (SLA の計測など) には向かない。systemd が無い環境ではこの機能は黙って無効になるので、明示的な警告や自前ループの代替が要る製品もある。そして別プロセスからの状態更新はロックが前提で、Podman はコンテナ単位の [共有メモリロック](../shm-lock-manager/)を持っているから成立している。
