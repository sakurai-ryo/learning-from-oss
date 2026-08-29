---
title: "OCI spec に何が書かれるか — Podman が決めるデフォルト"
description: "コンテナがどれだけ危険かは、エンジンが config.json に書く既定値で決まる。Podman の既定 capability は 11 個で、Docker が付ける CAP_NET_RAW・CAP_MKNOD・CAP_AUDIT_WRITE が入っていない。seccomp は containers.conf・イメージのラベル・プロファイルファイルの 3 経路から決まり、privileged なら丸ごと外れる。/etc/hosts と /etc/resolv.conf は run ディレクトリに生成して bind mount する。"
group: "コンテナを作って動かす"
sidebar:
  order: 15
---

## 何を学んだか

### 既定値がセキュリティ姿勢そのもの

OCI Runtime Spec は「何を書けるか」を定めるだけで、「何を書くべきか」は決めない。だから **コンテナがどれだけ危険かは、エンジンが選ぶ既定値で決まる**。

Podman が既定で書き込む主なものはこれだ。

| 項目               | 既定                                               |
| ------------------ | -------------------------------------------------- |
| capabilities       | 11 個の許可リスト (下記)                           |
| seccomp            | containers/common の既定プロファイル               |
| SELinux / AppArmor | 有効なら適用                                       |
| masked paths       | `/proc/kcore` など。rootless では `/sys/kernel` も |
| readonly paths     | `/proc/bus`、`/proc/sys` など                      |
| `/etc/hosts`       | 生成して bind mount                                |
| `/etc/resolv.conf` | 生成して bind mount                                |
| `/dev/shm`         | 既定の 64MB の tmpfs を差し替え                    |
| no-new-privileges  | 明示された場合のみ                                 |

### 既定 capability は 11 個

`containers.conf` の `default_capabilities` の初期値がこれだ。

```
CAP_CHOWN            CAP_DAC_OVERRIDE     CAP_FOWNER
CAP_FSETID           CAP_KILL             CAP_NET_BIND_SERVICE
CAP_SETFCAP          CAP_SETGID           CAP_SETPCAP
CAP_SETUID           CAP_SYS_CHROOT
```

Docker の既定はこれに加えて **`CAP_NET_RAW`・`CAP_MKNOD`・`CAP_AUDIT_WRITE`** の 3 つが入る。Podman はこの 3 つを外している。

- **`CAP_NET_RAW`** — raw ソケットが作れる。`ping` が動く代わりに、ARP スプーフィングやパケット偽装ができる。Podman では `net.ipv4.ping_group_range` の sysctl で `ping` を代替する方針
- **`CAP_MKNOD`** — デバイスファイルが作れる。コンテナ内で `/dev/sda` を作られると困る
- **`CAP_AUDIT_WRITE`** — 監査ログに書ける。ホストの監査記録を汚せる

`podman run --cap-add=NET_RAW` で足せるが、**既定で外れていることが重要** だ。「Docker では動いたのに Podman で動かない」の代表的な原因でもある。

### seccomp の決まり方は 3 経路

1. **プロファイルファイルの明示** (`--security-opt seccomp=/path/to.json`)
2. **イメージのラベル** (`seccomp policy = image` のとき、イメージに埋め込まれた JSON)
3. **既定プロファイル** (containers/common に同梱の `seccomp.json`)

そして `--privileged` の場合は **seccomp が丸ごと外れる**。「privileged なのに seccomp で止められる」という中途半端な状態を作らない、という判断だ。

### /etc/hosts と /etc/resolv.conf は「作って bind mount」

コンテナの `/etc/hosts` はイメージの中のファイルではない。Podman が **runroot に実ファイルを作り、それを bind mount している**。

理由は 2 つある。ネットワークが決まるまで内容が確定しない (IP アドレス、DNS サーバ) こと、そして **コンテナの中から書き換えられても、次回の起動で作り直される** ことだ。イメージのレイヤに書き込む方式だと、内容がレイヤに焼き付いてしまう。

## ソースコードのどこか

### capability の既定はライブラリ側の定数

[`vendor/go.podman.io/common/pkg/config/default.go#L104-L117`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/config/default.go#L104)。

```go title="go.podman.io/common/pkg/config/default.go"
	// DefaultCapabilities is the default for the default_capabilities option in the containers.conf file.
	DefaultCapabilities = []string{
		"CAP_CHOWN",
		"CAP_DAC_OVERRIDE",
		"CAP_FOWNER",
		"CAP_FSETID",
		"CAP_KILL",
		"CAP_NET_BIND_SERVICE",
		"CAP_SETFCAP",
		"CAP_SETGID",
		"CAP_SETPCAP",
		"CAP_SETUID",
		"CAP_SYS_CHROOT",
	}
```

Podman ではなく `containers/common` にあるので、**Buildah も CRI-O も同じ既定を使う**。セキュリティ姿勢がツール間で揃うのは、共有ライブラリにした恩恵の 1 つだ。

そして `containers.conf` で上書きできる。管理者が組織のポリシーとして `default_capabilities` を絞ることも、`CAP_NET_RAW` を足すこともできる。**既定値が設定ファイルの初期値として表現されている** ので、「なぜこの値なのか」を追うのが容易になっている。

### seccomp は 3 経路を 1 つの関数で

[`pkg/specgen/generate/config_linux_seccomp.go#L19`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/config_linux_seccomp.go#L19)。

```go title="pkg/specgen/generate/config_linux_seccomp.go"
func getSeccompConfig(s *specgen.SpecGenerator, configSpec *spec.Spec, img *libimage.Image) (*spec.LinuxSeccomp, error) {
	var seccompConfig *spec.LinuxSeccomp
	var err error
	scp, err := seccomp.LookupPolicy(s.SeccompPolicy)
	...
	if scp == seccomp.PolicyImage {
		if img == nil {
			return nil, errors.New("cannot read seccomp profile without a valid image")
		}
		labels, err := img.Labels(context.Background())
		...
		imagePolicy := labels[seccomp.ContainerImageLabel]
		if len(imagePolicy) < 1 {
			return nil, errors.New("no seccomp policy defined by image")
		}
		logrus.Debug("Loading seccomp profile from the security config")
		seccompConfig, err = goSeccomp.LoadProfile(imagePolicy, configSpec)
```

「イメージに seccomp プロファイルを埋め込む」経路があるのが Podman 固有だ。イメージのラベルに JSON を入れておくと、そのイメージを動かすときに自動で適用される。**アプリケーションの作者が、自分に必要なシステムコールを宣言できる**。

ただし既定では無効で、`seccomp policy = image` を明示的に設定する必要がある。イメージ側に権限を決めさせるのは、信頼できるイメージに限られるからだ。

明示がなければ既定プロファイル。

```go title="pkg/specgen/generate/config_linux_seccomp.go"
	} else {
		logrus.Debug("Loading default seccomp profile")
		seccompConfig, err = goSeccomp.GetDefaultProfile(configSpec)
```

### privileged では seccomp を明示的に外す

[`pkg/specgen/generate/security_linux.go#L203-L215`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/security_linux.go#L203)。

```go title="pkg/specgen/generate/security_linux.go"
	// HANDLE SECCOMP
	if s.SeccompProfilePath != "unconfined" {
		seccompConfig, err := getSeccompConfig(s, configSpec, newImage)
		if err != nil {
			return err
		}
		configSpec.Linux.Seccomp = seccompConfig
	}

	// Clear default Seccomp profile from Generator for unconfined containers
	// and privileged containers which do not specify a seccomp profile.
	if s.SeccompProfilePath == "unconfined" || (s.IsPrivileged() && (s.SeccompProfilePath == "" || s.SeccompProfilePath == config.SeccompOverridePath || s.SeccompProfilePath == config.SeccompDefaultPath)) {
		configSpec.Linux.Seccomp = nil
	}
```

一度セットしてから条件次第で `nil` に戻す、という書き方をしている。`generate.New("linux")` が既定のプロファイルを入れてくるので、**「入っているものを消す」処理が必要になる** ためだ。

条件が長いのは、「privileged だが、プロファイルを明示的に指定した場合は尊重する」を表現しているから。`SeccompOverridePath` と `SeccompDefaultPath` は「明示ではなく既定として入った値」なので、明示扱いしない。

### sysctl は namespace の設定次第で捨てる

```go title="pkg/specgen/generate/security_linux.go"
	noUseIPC := s.IpcNS.NSMode == specgen.FromContainer || s.IpcNS.NSMode == specgen.FromPod || s.IpcNS.NSMode == specgen.Host
	noUseNet := s.NetNS.NSMode == specgen.FromContainer || s.NetNS.NSMode == specgen.FromPod || s.NetNS.NSMode == specgen.Host
	noUseUTS := s.UtsNS.NSMode == specgen.FromContainer || s.UtsNS.NSMode == specgen.FromPod || s.UtsNS.NSMode == specgen.Host

	// Add default sysctls
	defaultSysctls, err := util.ValidateSysctls(rtc.Sysctls())
	...
	for sysctlKey, sysctlVal := range defaultSysctls {
		// Ignore mqueue sysctls if --ipc=host
		if noUseIPC && strings.HasPrefix(sysctlKey, "fs.mqueue.") {
			logrus.Infof("Sysctl %s=%s ignored in containers.conf, since IPC Namespace set to %q", sysctlKey, sysctlVal, s.IpcNS.NSMode)

			continue
		}

		// Ignore net sysctls if --net=host
		if noUseNet && strings.HasPrefix(sysctlKey, "net.") {
```

namespace を共有しているなら、そこに属する sysctl は書けない (書けばホストや相手のコンテナに影響する)。だから **黙って捨てる。ただし理由をログに残す**。

`--net=host` にしたら `net.*` の sysctl が効かなくなるのは、エラーにすべきか無視すべきか微妙なところだ。Podman は「設定ファイルに書いてある既定値」なので無視、ただし `--sysctl` で明示された場合は別途エラーになる、という切り分けをしている。

### hosts と resolv.conf は空ファイルを作ってから埋める

[`libpod/container_internal_common.go#L2221`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal_common.go#L2221)。

```go title="libpod/container_internal_common.go"
// createResolvConf create the resolv.conf file and bind mount it
func (c *Container) createResolvConf() error {
	destPath := filepath.Join(c.state.RunDir, "resolv.conf")
	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	f.Close()
	return c.bindMountRootFile(destPath, resolvconf.DefaultResolvConf)
}
```

**まず空ファイルを作って bind mount を登録し、中身は後で書く**。分けている理由が別の箇所のコメントに書いてある。

```go title="libpod/container_internal_common.go"
	// setup hosts/resolv.conf files
	// Note this should normally be called after the container is created in the runtime but before it is started.
	// However restore starts the container right away. This means that if we do the call afterwards there is a
	// short interval where the file is still empty. Thus I decided to call it before which makes it not working
	// with PostConfigureNetNS (userns) but as this does not work anyway today so I don't see it as problem.
	if err := c.completeNetworkSetup(); err != nil {
```

「本来は create のあと start の前に呼ぶべきだが、restore は即座に start するので、後から呼ぶとファイルが空の期間ができてしまう。だから前に呼ぶことにした。その結果 `PostConfigureNetNS` (userns) では動かなくなるが、そちらは今でもどのみち動かないので問題ないと判断した」。

**制約が衝突したときの判断が、そのままコメントとして残っている**。どちらを取ってどちらを諦めたかが明記されているので、後から直すときに前提を復元できる。

## なぜそうなっているか

### 既定を絞ったのは、追加が明示的だから

`CAP_NET_RAW` を落とすと `ping` が動かなくなる。ユーザ体験としては明らかにマイナスだ。それでも落としているのは、**「必要なら足せる」が「不要なのに付いている」より安全** だからだ。

同時に、代替手段も用意している。`ping` については `net.ipv4.ping_group_range` という sysctl で、`CAP_NET_RAW` なしに ICMP を送れるようにする道がある。**機能を落とすときに代替を示す**、という姿勢が既定値の選択にも現れている。

Docker が 3 つ多いのは、後方互換の重さによる。既に動いているコンテナが動かなくなる変更は入れにくい。Podman は後発なので、最初から絞った既定を選べた。

### spec の生成が「差分」なので、消す処理が要る

`generate.New("linux")` が仕様の推奨値を入れてくれるので、大半のフィールドは自分で書かなくてよい。その代わり **「入っているものを消す」という操作が頻出する**。`RemoveMount("/dev/shm")`、`configSpec.Linux.Seccomp = nil`。

差分で組み立てる方式のコストがここに出ている。全フィールドを自分で埋める方式なら「消す」は要らないが、仕様の更新に追随する手間が増える。**どちらもコストがあり、Podman は追随の手間を減らす方を選んだ**。

### 生成ファイルを bind mount するのは、レイヤを汚さないため

`/etc/hosts` をコンテナのレイヤに書くと、`podman commit` したときにその内容がイメージに焼き付く。IP アドレスが埋まったイメージができてしまう。

bind mount なら、レイヤの中身は変わらない。コンテナを消せばファイルも消える。**「実行時にだけ必要なもの」を永続レイヤの外に置く**、というのは volume と同じ発想だ。

## どう活かすか

- **既定値は設定ファイルの初期値として書く。** `DefaultCapabilities` が定数かつ `containers.conf` の初期値になっているので、「なぜこの値か」も「どう変えるか」も同じ場所で分かる。ハードコードされた既定は追いにくい。
- **機能を絞るなら代替を示す。** `CAP_NET_RAW` を外して `ping_group_range` を案内する、のように。単に落とすだけだと「動かない」という報告が来続ける。
- **判断が割れたときの理由をコメントに残す。** hosts/resolv.conf のタイミングのコメントは、「A を取って B を諦めた、B は元々動いていないので許容した」まで書いてある。この情報は git log からは出てこない。
- **実行時にだけ必要なファイルは、永続層の外に置く。** bind mount で差し込めば、レイヤも汚れず、後始末も自動になる。
