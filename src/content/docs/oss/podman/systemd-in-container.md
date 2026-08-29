---
title: "コンテナの中で systemd を動かす"
description: "エントリポイントが /sbin/init か systemd なら、Podman は自動で systemd モードに入る。/run と /tmp と /var/log/journal に tmpfs を敷き、/sys/fs/cgroup を書き込み可能にし、停止シグナルを SIGRTMIN+3 に変える。Docker では手作業だったものを、コマンドの中身を見て自動で判断する。systemd を「特別扱いしてよいもの」として設計に組み込んだ結果といえる。"
group: "systemd 統合"
sidebar:
  order: 42
---

## 何を学んだか

### systemd が動くために必要な条件

コンテナの中で systemd を PID 1 として動かしたい場面がある。複数のサービスを 1 コンテナにまとめたい、既存の VM イメージをそのままコンテナ化したい、systemd 前提のソフトウェアをテストしたい、といった用途だ。

だが素の OCI コンテナでは systemd は起動しない。systemd が期待するものが揃っていないからだ。

| systemd が期待するもの          | 素のコンテナでは                    |
| ------------------------------- | ----------------------------------- |
| `/run` が書き込み可能な tmpfs   | イメージのレイヤ (書けるが永続する) |
| `/run/lock` が tmpfs            | 同上                                |
| `/tmp` が tmpfs                 | 同上                                |
| `/var/log/journal` が書ける     | 同上                                |
| `/sys/fs/cgroup` が書き込み可能 | 読み取り専用でマウントされる        |
| `container_uuid` 環境変数       | 無い                                |
| 停止シグナルが `SIGRTMIN+3`     | `SIGTERM`                           |

Docker でこれをやるには、`--tmpfs /run --tmpfs /tmp -v /sys/fs/cgroup:/sys/fs/cgroup:ro --stop-signal=SIGRTMIN+3` のようなオプションを自分で並べる必要がある。

**Podman はこれを自動でやる**。しかも「systemd を動かそうとしているか」を、実行されるコマンドから判定する。

### 判定は 3 つの値

`--systemd` の値は 3 つ。

| 値            | 挙動                                                               |
| ------------- | ------------------------------------------------------------------ |
| `true` (既定) | **コマンドが `/sbin/init` か `systemd` なら** systemd モードに入る |
| `always`      | 無条件で systemd モードに入る                                      |
| `false`       | 無条件で入らない                                                   |

既定が `true` なので、`podman run -d fedora /sbin/init` と打つだけで systemd が動く。ユーザは systemd モードの存在を知らなくてもよい。

判定に使うコマンドは、CLI で指定されたものが無ければ **イメージの `CMD`** を見る。`FROM fedora` + `CMD ["/sbin/init"]` のイメージを引数なしで実行しても、正しく systemd モードになる。

### 停止シグナルが変わる

systemd は `SIGTERM` を受けると **再実行 (reexec)** する。停止ではない。停止させたいなら `SIGRTMIN+3` を送る必要がある。

Podman は systemd モードのとき、停止シグナルの既定を `SIGRTMIN+3` に変える。これを知らないと `podman stop` が 10 秒待って `SIGKILL` することになり、systemd の正常なシャットダウン (サービスの停止、ファイルシステムの同期) が走らない。

**「そのプログラム固有の作法」をエンジンが知っている**という点で、systemd はかなり特別扱いされている。

## ソースコードのどこか

### コマンドを見て systemd かを判定する

[`pkg/specgen/generate/container_create.go#L396-L426`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container_create.go#L396)。

```go title="pkg/specgen/generate/container_create.go"
	useSystemd := false
	switch s.Systemd {
	case "always":
		useSystemd = true
	case "false":
		break
	case "", "true":
		if len(command) == 0 && imageData != nil {
			command = imageData.Config.Cmd
		}

		if len(command) > 0 {
			useSystemdCommands := map[string]bool{
				"/sbin/init":           true,
				"/usr/sbin/init":       true,
				"/usr/local/sbin/init": true,
			}
			// Grab last command in case this is launched from a shell
			cmd := command
			if len(command) > 2 {
				// Podman build will add "/bin/sh" "-c" to
				// Entrypoint. Remove and search for systemd
				if command[0] == "/bin/sh" && command[1] == "-c" {
					cmd = command[2:]
				}
			}
			if useSystemdCommands[cmd[0]] || (filepath.Base(cmd[0]) == "systemd") {
				useSystemd = true
			}
		}
```

判定の実体は **パスの完全一致 3 つと、ベース名が `systemd` かどうか** だけだ。`/usr/lib/systemd/systemd` も `/lib/systemd/systemd` も、ベース名が `systemd` なので拾える。

`/bin/sh -c` を剥がす処理が実務的だ。コメントに理由が書いてある。「**podman build は Entrypoint に `/bin/sh` `-c` を追加する**。それを取り除いてから systemd を探す」。

Dockerfile の `CMD /sbin/init` (シェル形式) は `["/bin/sh", "-c", "/sbin/init"]` に展開される。この 2 段を剥がさないと判定が効かない。**ビルド側の挙動を知った上での前処理**になっている。

判定が当たったら、停止シグナルを変える。

```go title="pkg/specgen/generate/container_create.go"
	logrus.Debugf("using systemd mode: %t", useSystemd)
	if useSystemd {
		// is StopSignal was not set by the user then set it to systemd
		// expected StopSigal
		if s.StopSignal == nil {
			stopSignal, err := util.ParseSignal("RTMIN+3")
			if err != nil {
				return nil, fmt.Errorf("parsing systemd signal: %w", err)
			}
			s.StopSignal = &stopSignal
		}

		options = append(options, libpod.WithSystemd())
	}
```

**ユーザが明示的に `--stop-signal` を指定していた場合は尊重する** (`s.StopSignal == nil` のときだけ設定)。自動判定が明示指定を上書きしない、という原則が守られている。

判定結果を `logrus.Debugf` で出しているのも重要で、「systemd モードになったか」はトラブルシュートで最初に知りたい情報になる。

### マウントの設定は 60 行

[`libpod/container_internal_linux.go#L222`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal_linux.go#L222)。関数の直前のコメントが要件をそのまま述べている。

```go title="libpod/container_internal_linux.go"
// systemd expects to have /run, /run/lock and /tmp on tmpfs
// It also expects to be able to write to /sys/fs/cgroup/systemd and /var/log/journal
func (c *Container) setupSystemd(mounts []spec.Mount, g generate.Generator) {
	var containerUUIDSet bool
	for _, s := range c.config.Spec.Process.Env {
		if strings.HasPrefix(s, "container_uuid=") {
			containerUUIDSet = true
			break
		}
	}
	if !containerUUIDSet {
		g.AddProcessEnv("container_uuid", c.ID()[:32])
	}
```

まず `container_uuid` を設定する。**32 文字に切り詰めている**のは、systemd が UUID として扱える長さに合わせるためだ。コンテナ ID は 64 文字の hex なので、前半だけを使う。

systemd はこの環境変数を見て「コンテナの中で動いている」と判断し、ハードウェア関連のユニット (`systemd-udevd` など) を起動しないようにする。

tmpfs のマウントはループで組み立てる。

```go title="libpod/container_internal_linux.go"
	options := []string{"rw", "rprivate", "nosuid", "nodev"}
	for _, dest := range []string{"/run", "/run/lock"} {
		if MountExists(mounts, dest) {
			continue
		}
		tmpfsMnt := spec.Mount{
			Destination: dest,
			Type:        define.TypeTmpfs,
			Source:      define.TypeTmpfs,
			Options:     append(options, "tmpcopyup", shmSizeSystemdMntOpt),
		}
		g.AddMount(tmpfsMnt)
	}
	for _, dest := range []string{"/tmp", "/var/log/journal"} {
		if MountExists(mounts, dest) {
			continue
		}
		...
	}
```

**`MountExists` で既存のマウントを確認してから追加する**。ユーザが `-v` や `--tmpfs` で同じパスを指定していたら、そちらを優先する。自動設定が明示指定を壊さない、という原則がここでも守られている。

`tmpcopyup` オプションが効いている。これは「tmpfs をマウントするとき、元のディレクトリの中身をコピーしてくる」という指示だ。イメージの `/run` に何かファイルが置かれていた場合、tmpfs で覆っても中身が残る。**イメージが用意したファイルを消さない**ための配慮になっている。

ループが 2 つに分かれているのは、`shmSizeSystemdMntOpt` (サイズ制限) の扱いを将来変えられるようにした名残と読める。現状は同じ処理をしている。

### `/sys/fs/cgroup` の扱いが cgroup namespace 次第

```go title="libpod/container_internal_linux.go"
	hasCgroupNs := false
	for _, ns := range c.config.Spec.Linux.Namespaces {
		if ns.Type == spec.CgroupNamespace {
			hasCgroupNs = true
			break
		}
	}

	g.RemoveMount("/sys/fs/cgroup")

	var systemdMnt spec.Mount
	if hasCgroupNs {
		systemdMnt = spec.Mount{
			Destination: "/sys/fs/cgroup",
			Type:        "cgroup",
			Source:      "cgroup",
			Options:     []string{"private", "rw"},
		}
	} else {
		systemdMnt = spec.Mount{
			Destination: "/sys/fs/cgroup",
			Type:        define.TypeBind,
			Source:      "/sys/fs/cgroup",
			Options:     []string{define.TypeBind, "private", "rw"},
		}
	}
	g.AddMount(systemdMnt)
```

**cgroup namespace があれば新規マウント、無ければホストの bind mount**。前者ならコンテナから見える cgroup ツリーのルートが自分の cgroup になるので安全だが、後者では **ホストの cgroup ツリー全体が書き込み可能で見える**。

これは明確にセキュリティ上のトレードオフだ。cgroup namespace が使えない環境 (古いカーネル、`--cgroupns=host` の指定) では、systemd を動かすために危険な mount を許すことになる。

いずれの場合も `RemoveMount("/sys/fs/cgroup")` で既存の設定を消してから追加する。[OCI spec に何が書かれるか](../oci-spec-defaults/) で見た「差分で組み立てる方式のコスト」がここにも出ている。既定では read-only で入っているものを、消して入れ直す。

### 呼び出しは 5 行

[`libpod/container_internal_linux.go#L398`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal_linux.go#L398)。

```go title="libpod/container_internal_linux.go"
func (c *Container) addSystemdMounts(g *generate.Generator) error {
	if c.Systemd() {
		c.setupSystemd(g.Mounts(), *g)
	}
	return nil
}
```

`generateSpec` から呼ばれる小さな関数の 1 つになっている。**spec 生成が「小さな関数を順に呼ぶ」形に整理されている** ので、systemd 固有の処理がこの 1 か所に閉じる。

`c.Systemd()` は保存された設定を読むだけだ ([`libpod/container.go#L492`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container.go#L492))。

```go title="libpod/container.go"
func (c *Container) Systemd() bool {
	if c.config.Systemd != nil {
		return *c.config.Systemd
	}
	return false
}
```

**判定は作成時に 1 回だけ行われ、結果が `*bool` として保存される**。コンテナを再起動しても判定はやり直されない。イメージが更新されて `CMD` が変わっても、既存コンテナの systemd モードは変わらない。

`*bool` (ポインタ) なのは、「未設定」と「false」を区別するためだ。古いバージョンで作られたコンテナには値が無いので、`nil` なら false 扱いにする。

## なぜそうなっているか

### systemd を特別扱いする判断

「コンテナは 1 プロセス」という原則からすると、中で systemd を動かすのは邪道に見える。実際 Docker はこれを積極的にはサポートしてこなかった。

Podman が対応したのは、**現実に需要がある** からだ。既存のアプリケーションが systemd unit として書かれている、複数のプロセスを協調させる必要がある、RHEL のような systemd 前提の環境をそのままコンテナにしたい。

そして Red Hat にとっては、**OS のイメージをコンテナとして配る** ことが戦略的に重要だった。`podman run -d --name rhel registry.access.redhat.com/ubi9/ubi-init` のようなことが動く必要がある。

「1 プロセス原則」を守るのは設計として綺麗だが、**移行のコストを負担するのはユーザ**になる。既存資産をそのまま動かせることに価値を置いた判断といえる。

### 自動判定にした理由

`--systemd=always` を毎回書かせることもできた。そうしなかったのは、**動かない理由が分かりにくい** からだ。

systemd モードでないコンテナで `/sbin/init` を起動すると、systemd は起動の途中で謎のエラーを出して止まる。原因が「`/run` が tmpfs でない」ことだと気づくのは難しい。オプションを知らないユーザは「Podman では systemd が動かない」と結論する。

コマンドを見て自動判定すれば、**知らなくても動く**。判定を間違えた場合 (systemd という名前の別のプログラム) は `--systemd=false` で無効にできる。

「既定で動く、必要なら明示的に無効化できる」という形は、自動判定を入れるときの妥当な線引きになっている。

### 自動設定が明示指定を上書きしない

`MountExists` のチェックと `s.StopSignal == nil` のチェックは、どちらも同じ原則を実装している。**自動で決めた値より、ユーザが明示した値が強い**。

自動判定を入れると必ず「判定が間違ったとき」の逃げ道が要る。逃げ道が `--systemd=false` (全部無効) しかないと使いにくいので、**個別の設定を上書きできる**ようにしてある。`--systemd=true` のまま `--stop-signal=SIGTERM` を指定する、といった組み合わせが成立する。

## どう活かすか

- **自動判定は「既定で動く、明示で無効化できる」形にする。** 判定が間違ったときの逃げ道と、部分的に上書きする手段の両方を用意する。全か無かの切り替えしか無いと、実用で困る。
- **自動設定は既存の指定を確認してから足す。** `MountExists` のようなチェックを挟むだけで、「便利機能がユーザの設定を壊す」事故が防げる。
- **判定結果はログに出す。** `logrus.Debugf("using systemd mode: %t", useSystemd)` の 1 行が、「なぜこうなったか」を調べる唯一の手がかりになる。自動判定を入れたら結果を必ず記録する。
- **判定は作成時に 1 回、結果を保存する。** 毎回判定し直すと、外部要因 (イメージの更新) で挙動が変わる。決定を固定して保存する方が、再現性が高い。
- **`*bool` は「未設定」を表現できる。** 古いデータとの互換を考えるとき、bool のゼロ値 (false) と「設定されていない」を区別できると助かる場面がある。
