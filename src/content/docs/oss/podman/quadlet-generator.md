---
title: "unit ファイルを生成して配るのではなく、systemd generator として daemon-reload のたびに変換する"
description: "Quadlet は .container や .pod のような短い宣言ファイルを、boot 時と daemon-reload 時に systemd から呼ばれて .service に変換する。元ファイルを複製して [Container] を [X-Container] にリネームし、残りの [Unit] / [Service] / [Install] は素通しにするので systemd の全機能が使える。生成される podman run は --replace --rm -d --cgroups=split --sdnotify=conmon で、conmon が MAINPID になる。テストデータはアサーションをコメントとして自身に埋め込む。"
sidebar:
  order: 15
---

## 何を学んだか

### どんな状況の話か

コンテナを systemd のサービスとして動かしたい。`podman generate systemd` は、その時点の Podman が知っている最善の unit ファイルを出力するコマンドだった。だが出力された unit は静的なスナップショットで、Podman を更新しても古いままだ (`KillMode=none` が非推奨になった時のように、unit の中身の「正解」は変わる)。`ExecStart` の長いコマンド行をユーザーが保守するのも辛い。

### Podman の答え

1. **生成コマンドではなく systemd generator にする。** `/usr/lib/systemd/system-generators/podman-system-generator` として systemd から boot 時と `daemon-reload` 時に呼ばれ、`.container` などの元ファイルを毎回 `.service` に変換して出力ディレクトリに書く。ユーザーは短い宣言ファイルだけを置く。
2. **自分のセクションだけを解釈し、残りは素通しにする。** 元ファイルを複製し、`[Container]` を `[X-Container]` にリネームして systemd に無視させ、`[Service]` に `ExecStart` などを書き足す。`[Unit]` や `[Install]` の任意のキーはそのまま通るので、依存関係も cgroup 制限も systemd の機能がそのまま使える。
3. **生成される `podman run` は、systemd に生死を正しく追跡させる形にする。** `--replace --rm -d --cgroups=split --sdnotify=conmon` と `Type=notify NotifyAccess=all KillMode=mixed Delegate=yes`。Podman は detach して終了し、[conmon](../conmon-supervision/) が MAINPID になって READY を送る。
4. **`[Install]` は generator が自分で symlink に展開する。** 生成された unit は transient 扱いで `systemctl enable` できないからだ。
5. **未知のキーはエラー、`[Service]` の危険なキーは警告。** typo を黙って無視しないが、既存ユーザーは壊さない。
6. **テストデータ自身がアサーションを持つ。** `test/e2e/quadlet/*.container` の `## assert-podman-args ...` というコメント行を解析して検証する。`#` は unit ファイルのコメントなので、テストデータはそのまま有効な Quadlet ファイルでもある。

## ソースコードのどこか

### generator としての制約

[`cmd/quadlet/main.go#L21-L27`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/quadlet/main.go#L21-L27)。

```go title="cmd/quadlet/main.go"
// This commandline app is the systemd generator (system and user,
// decided by the name of the binary).

// Generators run at very early startup, so must work in a very
// limited environment (e.g. no /var, /home, or syslog).  See:
// https://www.freedesktop.org/software/systemd/man/systemd.generator.html#Notes%20about%20writing%20generators
// for more details.
```

ログは `/dev/kmsg` に直接書く ([`#L45-L68`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/quadlet/main.go#L45-L68))。"because that is the only way to get information out of the generator into the system logs". system か user かはバイナリ名で判別し、[`Makefile#L912-L916`](https://github.com/podman-container-tools/podman/blob/v6.1.0/Makefile#L912-L916) が同じバイナリを 2 つの名前で symlink する。

```make title="Makefile"
	ln -sfr $(DESTDIR)$(LIBEXECPODMAN)/quadlet $(DESTDIR)${SYSTEMDGENERATORSDIR}/podman-system-generator
	/* ... */
	ln -sfr $(DESTDIR)$(LIBEXECPODMAN)/quadlet $(DESTDIR)${USERSYSTEMDGENERATORSDIR}/podman-user-generator
```

systemd は generator に `normal-dir early-dir late-dir` の 3 引数を渡すが、Quadlet が使うのは第 1 引数だけだ ([`#L441-L478`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/quadlet/main.go#L441-L478))。

### 変換の骨格: 複製してリネーム

[`pkg/systemd/quadlet/quadlet.go#L2371-L2404`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L2371-L2404) の `initServiceUnitFile`。

```go title="pkg/systemd/quadlet/quadlet.go"
	if err := checkForUnknownKeys(quadletUnitFile, group, groupsInfo[group].SupportedKeys); err != nil {
		return nil, nil, err
	}

	service := quadletUnitFile.Dup()
	service.Filename = unitInfo.ServiceFileName()

	if err := translateUnitDependencies(service, unitsInfoMap); err != nil {
		return nil, nil, err
	}

	addDefaultDependencies(service, isUser)

	if quadletUnitFile.Path != "" {
		service.Add(UnitGroup, "SourcePath", quadletUnitFile.Path)
	}

	// Need the containers filesystem mounted to start podman
	service.Add(UnitGroup, "RequiresMountsFor", "%t/containers")

	// Rename old Container group to x-Container so that systemd ignores it
	service.RenameGroup(group, groupsInfo[group].XGroupName)
```

systemd は `X-` で始まるセクションを無視する。元の情報を生成物に残しつつ、`SourcePath=` で元ファイルへの逆引きも残す。これを成立させているのがパーサー ([`pkg/systemd/parser/unitfile.go#L18-L26`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/parser/unitfile.go#L18-L26)) で、"It can also regenerate the file essentially identically, including comments and group/key order" と、コメントと順序を保って再生成できることを設計方針にしている。

`translateUnitDependencies` ([`#L2328-L2359`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L2328-L2359)) は `[Unit]` の `After=basic.container` を `basic.service` に書き換える。`addDefaultDependencies` ([`#L2279-L2296`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L2279-L2296)) は `network-online.target` への依存を足す。

```go title="pkg/systemd/quadlet/quadlet.go"
		networkUnit := "network-online.target"
		// network-online.target only exists as root and user session cannot wait for it
		// https://github.com/systemd/systemd/issues/3312
		// Given this is a bad problem with pasta which can fail to start or use the
		// wrong interface if the network is not fully set up we need to work around
		// that: https://github.com/containers/podman/issues/22197.
		if isUser {
			networkUnit = "podman-user-wait-network-online.service"
		}
```

user セッションには `network-online.target` が無いので、[`contrib/systemd/user/podman-user-wait-network-online.service`](https://github.com/podman-container-tools/podman/blob/v6.1.0/contrib/systemd/user/podman-user-wait-network-online.service) (`until systemctl is-active network-online.target; do sleep 0.5; done` を回す oneshot) を代わりに置いている。[pasta](../rootless-network-pasta/) がホストの IP をコピーする設計なので、ネットワークが上がる前に起動すると間違ったインターフェースを掴む。

### 生成される podman run

[`#L626-L682`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L626-L682) の `ConvertContainer`。

```go title="pkg/systemd/quadlet/quadlet.go"
	// Only allow mixed or control-group, as nothing else works well
	killMode, ok := service.Lookup(ServiceGroup, "KillMode")
	if !ok || (killMode != "mixed" && killMode != "control-group") {
		if ok {
			return nil, warnings, fmt.Errorf("invalid KillMode '%s'", killMode)
		}

		// We default to mixed instead of control-group, because it lets conmon do its thing
		service.Set(ServiceGroup, "KillMode", "mixed")
	}

	// If conmon exited uncleanly it may not have removed the container, so
	// force it, -i makes it ignore non-existing files.
	serviceStopCmd := createBasePodmanCommand(container, ContainerGroup)
	serviceStopCmd.add("rm", "-v", "-f", "-i", containerName)
	service.AddCmdline(ServiceGroup, "ExecStop", serviceStopCmd.Args)
	// The ExecStopPost is needed when the main PID (i.e., conmon) gets killed.
	// In that case, ExecStop is not executed but *Post only.
	serviceStopCmd.Args[0] = fmt.Sprintf("-%s", serviceStopCmd.Args[0])
	service.AddCmdline(ServiceGroup, "ExecStopPost", serviceStopCmd.Args)
	/* ... */
	podman.add(
		// And replace any previous container with the same name, not fail
		"--replace",

		// On clean shutdown, remove container
		"--rm",
	)
	/* ... */
	// We delegate groups to the runtime
	service.Add(ServiceGroup, "Delegate", "yes")

	if cgroupsMode, ok := container.Lookup(ContainerGroup, KeyCgroupsMode); ok && len(cgroupsMode) > 0 {
		podman.add("--cgroups", cgroupsMode)
	} else {
		podman.add("--cgroups=split")
	}
```

`KillMode=mixed` は SIGTERM を MAINPID (conmon) だけに送り、残りは SIGKILL で cgroup ごと止める。conmon がコンテナに stop signal を伝えて終了コードを記録する余地を残す。`ExecStop` と `ExecStopPost` (先頭の `-` で失敗を無視) の二重化は、MAINPID が kill された場合に `ExecStop` が走らないため。`Delegate=yes` + `--cgroups=split` で unit の cgroup 配下をランタイムに委譲し、conmon とコンテナ本体で 2 つのサブ cgroup に分ける。

`Type` と sd-notify ([`#L733-L756`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L733-L756))。

```go title="pkg/systemd/quadlet/quadlet.go"
	if serviceType != "oneshot" {
		// If we're not in oneshot mode always use some form of sd-notify, normally via conmon,
		// but we also allow passing it to the container by setting Notify=yes
		notify, ok := container.Lookup(ContainerGroup, KeyNotify)
		switch {
		case ok && strings.EqualFold(notify, "healthy"):
			podman.add("--sdnotify=healthy")
		case container.LookupBooleanWithDefault(ContainerGroup, KeyNotify, false):
			podman.add("--sdnotify=container")
		default:
			podman.add("--sdnotify=conmon")
		}
		service.Setv(ServiceGroup,
			"Type", "notify",
			"NotifyAccess", "all")

		// Detach from container, we don't need the podman process to hang around
		podman.add("-d")
	}
```

`--sdnotify=conmon` と `-d` の組み合わせで、Podman プロセスは detach して終了し、conmon が MAINPID になって READY を送る。`NotifyAccess=all` は MAINPID 以外 (conmon やコンテナ内プロセス) からの通知を受けるため。`Notify=healthy` は[ヘルスチェック](../systemd-healthcheck/)が healthy になるまで READY を遅らせる。

期待値の一覧としては [`test/e2e/quadlet/basic.container`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/e2e/quadlet/basic.container) が端的だ。

```ini title="test/e2e/quadlet/basic.container"
## assert-podman-final-args localhost/imagename
## assert-podman-args "--name" "systemd-%N"
## assert-podman-args "--rm"
## assert-podman-args "--replace"
## assert-podman-args "-d"
## assert-podman-args "--cgroups=split"
## assert-podman-args "--sdnotify=conmon"
## assert-key-is "Unit" "RequiresMountsFor" "%t/containers"
## assert-key-is "Service" "KillMode" "mixed"
## assert-key-is "Service" "Delegate" "yes"
## assert-key-is "Service" "Type" "notify"
## assert-key-is "Service" "NotifyAccess" "all"
## assert-key-is "Service" "SyslogIdentifier" "%N"
## assert-key-is-regex "Service" "ExecStopPost" "-[/S].*/podman rm -v -f -i systemd-%N"
## assert-key-is-regex "Service" "ExecStop" ".*/podman rm -v -f -i systemd-%N"
## assert-key-is "Service" "Environment" "PODMAN_SYSTEMD_UNIT=%n"
## assert-key-is-regex "Unit" "After" "network-online.target|podman-user-wait-network-online.service"
## assert-key-is-regex "Unit" "Wants" "network-online.target|podman-user-wait-network-online.service"

[Container]
Image=localhost/imagename
```

### Pod は forking + PIDFile

[`#L1625-L1656`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L1625-L1656) と [`#L1704-L1714`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L1704-L1714)。

```go title="pkg/systemd/quadlet/quadlet.go"
	execStart := createBasePodmanCommand(podUnit, PodGroup)
	execStart.add("pod", "start", podName)
	service.AddCmdline(ServiceGroup, "ExecStart", execStart.Args)

	execStop := createBasePodmanCommand(podUnit, PodGroup)
	execStop.add("pod", "stop")
	/* ... */
	execStartPre := createBasePodmanCommand(podUnit, PodGroup)
	execStartPre.add("pod", "create")
	execStartPre.add(
		"--infra-conmon-pidfile=%t/%N.pid",
		"--replace",
	)
```

```go title="pkg/systemd/quadlet/quadlet.go"
	service.Setv(ServiceGroup,
		"Type", "forking",
		"PIDFile", "%t/%N.pid",
	)
```

Pod は infra コンテナの conmon の pid を `PIDFile` にする。`ExecStart=podman pod start` と `ExecStop=podman pod stop` は[依存グラフの走査](../container-graph/)を呼ぶ。`.container` 側の `Pod=` は `handlePod` ([`#L2214-L2240`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L2214-L2240)) で `--pod <name>` と `BindsTo=` / `After=<pod>.service` になり、Pod 側は `ConvertPod` ([`#L1616-L1619`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet.go#L1616-L1619)) で `Wants=` / `Before=` を各コンテナに張る。libpod 内の DAG と systemd の unit 依存の二層になる。`.pod` を最後に処理するのはこのためで、[`quadlet_common.go#L1-L14`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/quadlet/quadlet_common.go#L1-L14) に拡張子ごとの処理順が数字で書いてある。

### [Install] を自分で展開する

[`cmd/quadlet/main.go#L234-L264`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/quadlet/main.go#L234-L264)。

```go title="cmd/quadlet/main.go"
// This parses the `Install` group of the unit file and creates the required
// symlinks to get systemd to start the newly generated file as needed.
// In a traditional setup this is done by "systemctl enable", but that doesn't
// work for auto-generated files like these.
func enableServiceFile(outputPath string, service *parser.UnitFile) {
	symlinks := make([]string, 0)

	aliases := service.LookupAllStrv(quadlet.InstallGroup, "Alias")
	for _, alias := range aliases {
		symlinks = append(symlinks, filepath.Clean(alias))
	}
	/* ... */
	if serviceFilename != "" {
		symlinks = append(symlinks, gatherDependentSymlinks(service, "WantedBy", "wants", serviceFilename)...)
		symlinks = append(symlinks, gatherDependentSymlinks(service, "RequiredBy", "requires", serviceFilename)...)
		symlinks = append(symlinks, gatherDependentSymlinks(service, "UpheldBy", "upholds", serviceFilename)...)
	}
```

docs ([`podman-systemd.unit.5.md#L134-L141`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-systemd.unit.5.md#L134-L141)): "The services created by Podman are considered transient by systemd ... it is not possible to `systemctl enable` them ... To compensate for this, the generator manually applies the `[Install]` section of the container definition unit files during generation, in the same way `systemctl enable` does when run later."

### アノテーション方式のテスト

[`test/e2e/quadlet_test.go#L63-L94`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/e2e/quadlet_test.go#L63-L94)。

```go title="test/e2e/quadlet_test.go"
	for line := range strings.SplitSeq(string(data), "\n") {
		if strings.HasPrefix(line, "##") {
			words, err := shellwords.Parse(line[2:])
			Expect(err).ToNot(HaveOccurred())
			checks = append(checks, words)
		}
	}
```

`##` で始まる行を shellwords で解析してアサーションにする。`assert-podman-args` ([`#L266-L286`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/e2e/quadlet_test.go#L266-L286)) は生成された unit の `ExecStart` を引数配列に分解し、部分列一致で検証する。`doAssert` ([`#L549-L570`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/e2e/quadlet_test.go#L549-L570)) には約 50 種のアサーションがあり、`!` プレフィックスで否定、`assert-failed` で「生成物が存在しない」ことの検証もできる。テストデータは 315 ファイルあり、[`health.container`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/e2e/quadlet/health.container) のようにキーの直前にアサーションを置いて「1 行が直後の 1 キーを検証する」形になっている。

```ini title="test/e2e/quadlet/health.container"
[Container]
Image=localhost/imagename
## assert-podman-args "--health-cmd" "hello world"
HealthCmd="hello world"
## assert-podman-args "--health-interval" "1m"
HealthInterval=1m
```

## なぜそうなっているか

- **元は C で書かれた独立プロジェクト。** コミット 62bb59d3b0 (2022-10-03, Alexander Larsson) "Initial quadlet version integrated in golang": "Based on the initial port in https://github.com/containers/quadlet/pull/41. This contains the unit tests and the testcases from the C code". アノテーション方式のテストも C 時代からの継承だ。4.4.0 で "Introduce Quadlet, a new systemd-generator that easily writes and maintains systemd services using Podman" として入った。
- **`podman generate systemd` は 4.7.0 で非推奨になった。** コミット 44f159ed31 (2023-08-01, Daniel J Walsh): "Now that Quadlets are fully supported, it is time to Depracate podman generate systemd command." [`podman-generate-systemd.1.md#L10-L13`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-generate-systemd.1.md#L10-L13) は "There are no plans to remove the command. It will receive urgent bug fixes but no new features" と続ける。
- **なぜ generator なのかを直接述べたコミットは無いが、一次情報から組み立てられる (推測)。** 生成コマンドの出力は静的なスナップショットで Podman の更新に追随しない。generator なら `daemon-reload` のたびに最新の変換ロジックが走る。`[Install]` の展開、`network-online` 依存の追加、`Pod=` からの `BindsTo=`、drop-in での上書きといった systemd らしい合成は、生成コマンドでは扱いにくい。そしてユーザーが編集するのは短い宣言ファイルで、長い `ExecStart` を人間が保守しなくてよい。
- **docs が素通しの設計を説明している。** [`podman-systemd.unit.5.md#L67-L70`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-systemd.unit.5.md#L67-L70): "Each file type has a custom section (for example, `[Container]`) that is handled by Podman, and all other sections are passed on untouched, allowing the use of any normal systemd configuration options like dependencies or cgroup limits."
- **`--sdnotify=conmon` を既定にした理由は generate systemd の docs に残っている。** [`podman-generate-systemd.1.md#L17-L22`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-generate-systemd.1.md#L17-L22): "The reason for overriding the default value **container** is that almost no container workloads send notify messages. Systemd waits for a ready message that never comes, if the value **container** is used for a container that does not send notify messages."

## どう活かすか

- 「生成物を配布する」より「元データと変換器を配布し、実行時に毎回変換する」ほうが、変換器の改善が既存ユーザーに自動で届く。systemd generator はその OS レベルの受け皿で、cron や launchd にも同種の仕組みはある。
- 既存フォーマットを拡張するときは、自分のセクションだけを解釈し、それ以外は素通しにする。フォーマットの全機能が無料で使え、元情報を `X-` セクションと `SourcePath` で生成物に残せば逆引きもできる。
- テストデータ自身にアサーションをコメントとして埋め込むと、テストケースの追加がデータファイル 1 つで済み、期待値と入力が同じ場所にある。データがそのまま有効な入力ファイルでもあるので、ドキュメントの例にも使える。
- 未知のキーはエラーにし (typo を黙って無視しない)、既存ユーザーを壊しうるキーは警告に留める、という強弱を付ける。
- 「MAINPID を誰にするか」「READY を誰が送るか」「cgroup を誰が管理するか」を明示的に決める。`--sdnotify=conmon`、`Delegate=yes`、`KillMode=mixed` はその 3 つの答えだ。
- 取り込むべきでない条件: generator は非常に早期 (`/var` も `/home` も無い) に動くので、外部サービスや DB を参照する変換には向かない。生成物が transient になり `systemctl enable` が効かないので、`[Install]` の自前展開のような追加実装が要る。実行時変換は「何が生成されるか」がユーザーから見えにくいので、`--dryrun` のような観測手段をセットで用意する。
