---
title: "cgroup を誰が作るか — systemd マネージャと cgroupfs マネージャ"
description: "コンテナの cgroup を作る方法は 2 つある。ディレクトリを自分で掘る cgroupfs と、systemd に scope や slice を作らせる systemd マネージャだ。既定は systemd で、OCI ランタイムには slice:prefix:name という独自の書式で渡す。rootless では systemd の user session が無ければ黙って cgroupfs に落ち、そのとき資源制限は効かなくなる。--cgroups=split はさらに別の道で、systemd が作った scope を Podman が二分する。"
group: "systemd 統合"
sidebar:
  order: 38
---

## 何を学んだか

### cgroup を作る方法が 2 つある

コンテナに `--memory=1g` を掛けるには、cgroup を作ってそこにプロセスを入れ、制限値を書く必要がある。その cgroup を **誰が作るか** で 2 つの方式がある。

| マネージャ           | 作り方                                      | cgroup パスの例              |
| -------------------- | ------------------------------------------- | ---------------------------- |
| **`cgroupfs`**       | `/sys/fs/cgroup/` の下に自分で `mkdir` する | `/machine.slice/libpod-<id>` |
| **`systemd`** (既定) | D-Bus で systemd に scope の作成を依頼する  | `machine.slice:libpod:<id>`  |

Docker も同じ 2 択を持ち (`--exec-opt native.cgroupdriver=systemd`)、Kubernetes では systemd 側に揃えることが推奨される。理由は **cgroup の「所有者」を 1 つにするため** だ。

systemd は起動時に cgroup ツリー全体を自分の管理下に置く。その中で誰かが勝手にディレクトリを掘ると、systemd が定期的に走らせる整理で消される可能性がある。**cgroup ツリーの単一の管理者は systemd である** という前提に合わせるのが、systemd マネージャになる。

### OCI ランタイムへの渡し方が変わる

面白いのは、cgroup マネージャの違いが **OCI spec の `cgroupsPath` フィールドの書式** に現れることだ。

- cgroupfs → `/machine.slice/libpod-4f2c...` (ファイルシステム上のパス)
- systemd → `machine.slice:libpod:4f2c...` (コロン区切りの 3 要素)

後者は **runc が定めた慣習** で、`slice:prefix:name` を受け取ったランタイムが自分で D-Bus 呼び出しをする。OCI Runtime Spec は `cgroupsPath` を「実装依存の文字列」としか定めていないので、この書式は仕様外の取り決めになる。

つまり Podman は「systemd で作れ」と直接は言わない。**書式でそれを伝え、実際の D-Bus 呼び出しは crun / runc がやる**。

### rootless では黙って縮退する

rootless で systemd マネージャを使うには、そのユーザの **systemd user session** が必要だ。`DBUS_SESSION_BUS_ADDRESS` が指す D-Bus に繋がらなければ scope を作れない。

SSH でログインしただけの場合や、`sudo -u` で切り替えた場合、user session が無いことがある。このとき Podman は **警告を出して cgroupfs に落ちる**。

そして rootless の cgroupfs では、cgroup が作れないので **資源制限が効かない**。`--memory=1g` を指定してもエラーにならず、単に無視される。「制限したつもりで制限されていない」という、運用上いちばん怖い状態になりうる。

`loginctl enable-linger` で user session を常駐させるのが正しい対処で、警告メッセージにそう書いてある。

### `--cgroups=split` という第 3 の道

Quadlet が生成する unit は `--cgroups=split` を使う ([Quadlet](../quadlet-generator/))。これは 2 つのマネージャとは別の方式だ。

systemd が `.service` のために作った cgroup を、Podman が **自分で 2 つに割る**。

```
<systemd が作った service の cgroup>/
├── supervisor/    ← conmon が入る
└── container/     ← コンテナのプロセスが入る
```

利点は、**新しい cgroup を systemd に依頼しなくてよい** ことだ。unit の cgroup の中に閉じるので、`systemctl status` で見える資源使用量にコンテナが正しく含まれる。unit の `MemoryMax=` がそのままコンテナに効く。

## ソースコードのどこか

### cgroup パスの決定は 6 分岐

[`libpod/container_internal_linux.go#L348`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal_linux.go#L348) の `getOCICgroupPath`。

```go title="libpod/container_internal_linux.go"
// Get cgroup path in a format suitable for the OCI spec
func (c *Container) getOCICgroupPath() (string, error) {
	cgroupManager := c.CgroupManager()
	switch {
	case c.config.NoCgroups:
		return "", nil
	case c.config.CgroupsMode == cgroupSplit:
		selfCgroup, err := cgroups.GetOwnCgroupDisallowRoot()
		if err != nil {
			return "", err
		}
		return filepath.Join(selfCgroup, fmt.Sprintf("libpod-payload-%s", c.ID())), nil
	case cgroupManager == config.SystemdCgroupsManager:
		// When the OCI runtime is set to use Systemd as a cgroup manager, it
		// expects cgroups to be passed as follows:
		// slice:prefix:name
		systemdCgroups := fmt.Sprintf("%s:libpod:%s", path.Base(c.config.CgroupParent), c.ID())
		logrus.Debugf("Setting Cgroups for container %s to %s", c.ID(), systemdCgroups)
		return systemdCgroups, nil
	case (rootless.IsRootless() && cgroupManager == config.CgroupfsCgroupsManager):
		if c.config.CgroupParent == "" || !isRootlessCgroupSet(c.config.CgroupParent) {
			return "", nil
		}
		fallthrough
	case cgroupManager == config.CgroupfsCgroupsManager:
		cgroupPath := filepath.Join(c.config.CgroupParent, fmt.Sprintf("libpod-%s", c.ID()))
		logrus.Debugf("Setting Cgroup path for container %s to %s", c.ID(), cgroupPath)
		return cgroupPath, nil
	default:
		return "", fmt.Errorf("invalid cgroup manager %s requested: %w", cgroupManager, define.ErrInvalidArg)
	}
}
```

この 1 関数に、cgroup 周りの複雑さが全部集まっている。

**systemd マネージャの書式にコメントが付いている**のが親切だ。「OCI ランタイムが systemd を cgroup マネージャとして使うよう設定されている場合、cgroup は `slice:prefix:name` の形で渡されることを期待する」。仕様に書かれていない取り決めなので、コメントが唯一の説明になる。

`path.Base(c.config.CgroupParent)` としているのは、`CgroupParent` が `/machine.slice` のようなパス形式で入ってくるからだ。systemd 形式では slice 名だけが要るので、ベース名を取る。

**rootless + cgroupfs の分岐が特殊**で、

```go title="libpod/container_internal_linux.go"
	case (rootless.IsRootless() && cgroupManager == config.CgroupfsCgroupsManager):
		if c.config.CgroupParent == "" || !isRootlessCgroupSet(c.config.CgroupParent) {
			return "", nil
		}
		fallthrough
```

**空文字列を返す = cgroup を作らない**。rootless で cgroupfs の場合、そもそも cgroup を掘る権限がないことが多い。明示的に親が指定されていなければ、諦めて何もしない。

`fallthrough` を使って、指定がある場合だけ次の case (通常の cgroupfs 処理) に流している。Go で `fallthrough` を見る機会は少ないが、「条件を満たしたら下の処理を共有する」という意図がよく出ている。

`cgroupSplit` の場合は `libpod-payload-<id>` という別の名前になる。**`libpod-` と `libpod-payload-` で名前が違う**ので、cgroup を見れば split モードかどうかが分かる。

### user session が無ければ落とす

[`vendor/go.podman.io/common/pkg/config/config.go#L772`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/config/config.go#L772) の `CheckCgroupsAndAdjustConfig`。

```go title="go.podman.io/common/pkg/config/config.go"
// CheckCgroupsAndAdjustConfig checks if we're running rootless with the systemd
// cgroup manager. In case the user session isn't available, we're switching the
// cgroup manager to cgroupfs.  Note, this only applies to rootless.
func (c *Config) CheckCgroupsAndAdjustConfig() {
	if !unshare.IsRootless() || c.Engine.CgroupManager != SystemdCgroupsManager {
		return
	}

	hasSession := false

	session, found := os.LookupEnv("DBUS_SESSION_BUS_ADDRESS")
	if !found {
		xdgRuntimeDir := os.Getenv("XDG_RUNTIME_DIR")
		...
		sessionAddr := filepath.Join(xdgRuntimeDir, "bus")
		if err := fileutils.Exists(sessionAddr); err == nil {
			sessionAddr, err = filepath.EvalSymlinks(sessionAddr)
			if err == nil {
				os.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path="+sessionAddr)
				hasSession = true
			}
		}
	}
```

環境変数が無ければ、**`$XDG_RUNTIME_DIR/bus` の存在を確かめて、自分で環境変数を設定する**。`DBUS_SESSION_BUS_ADDRESS` は対話ログインなら設定されるが、cron や systemd の user unit から起動された場合に無いことがある。パスの規約が決まっているので、推測できる。

見つからなかった場合の警告が丁寧だ。

```go title="go.podman.io/common/pkg/config/config.go"
	if !hasSession && unshare.GetRootlessUID() != 0 {
		logrus.Warningf("The cgroupv2 manager is set to systemd but there is no systemd user session available")
		logrus.Warningf("For using systemd, you may need to log in using a user session")
		logrus.Warningf("Alternatively, you can enable lingering with: `loginctl enable-linger %d` (possibly as root)", unshare.GetRootlessUID())
		logrus.Warningf("Falling back to --cgroup-manager=cgroupfs")
		c.Engine.CgroupManager = CgroupfsCgroupsManager
	}
```

4 行の警告が、**状況・原因・対処 2 通り・結果** を順に伝える。

1. 「systemd に設定されているが user session が無い」(状況)
2. 「systemd を使うには user session でログインする必要がある」(対処 1)
3. 「あるいは `loginctl enable-linger <uid>` で lingering を有効にできる (おそらく root で)」(対処 2、コマンド付き)
4. 「cgroupfs にフォールバックする」(結果)

`(possibly as root)` まで書いてあるのが実務的だ。**このメッセージを読んだ人が次に何をすればよいかが完全に分かる**。エラーメッセージの書き方の手本として引用する価値がある。

`unshare.GetRootlessUID() != 0` の条件は、uid 0 (root) で rootless モードに見える場合 (nested podman など) を除外している。[非特権でコンテナを作るのに何が要るか](../rootless-basics/) で見た `IsRootless()` の 2 条件目と同じ配慮だ。

### Pod の cgroup を作るかどうか

同じファイルの少し上に、Pod 用の判定がある。

```go title="libpod/container_internal_linux.go"
	case cgroupManager == config.CgroupfsCgroupsManager:
		return !rootless.IsRootless(), nil
	default:
		return false, fmt.Errorf("invalid cgroup mode %s requested for pods: %w", cgroupManager, define.ErrInvalidArg)
	}
```

cgroupfs マネージャなら「rootless でないときだけ Pod の cgroup を作る」。**rootless + cgroupfs では Pod 単位の資源制限が成立しない** ことが、この 1 行に現れている。

### 委譲の D-Bus 呼び出しは共通ライブラリに

rootless で Podman 自身を scope に移す処理は [cgroup を systemd から委譲してもらう](../rootless-cgroup-scope/) で扱った。同じ D-Bus 呼び出しが pause プロセス、conmon、rootless-netns の pasta にも使われる。

コンテナの cgroup 作成は OCI ランタイムがやり、Podman 自身とヘルパープロセスの scope 作成は Podman がやる。**「誰が systemd に依頼するか」が対象ごとに違う** のが、この領域の分かりにくさの原因になっている。

| 対象                                     | D-Bus を呼ぶのは                           |
| ---------------------------------------- | ------------------------------------------ |
| コンテナのプロセス                       | crun / runc (`slice:prefix:name` を受けて) |
| conmon                                   | Podman                                     |
| rootless の Podman 自身 (pause プロセス) | Podman                                     |
| rootless-netns の pasta                  | Podman                                     |

## なぜそうなっているか

### cgroup ツリーの管理者は 1 人であるべき

cgroup v2 には「**no internal process constraint**」という規則がある。プロセスを持つ cgroup は子 cgroup を持てない、というものだ。加えて、cgroup の階層を複数の主体が勝手に触ると、資源制限の合計が想定と合わなくなる。

systemd は起動時に cgroup ツリーを掌握し、`.slice` / `.scope` / `.service` という単位で階層を組む。この管理下で誰かが `mkdir` すると、systemd が把握していない cgroup ができる。**systemd から見えない資源消費が生まれる**。

だから既定を systemd マネージャにして、cgroup の作成を必ず systemd 経由にする。`systemctl status` や `systemd-cgls` にコンテナが正しく現れるのは、この選択の結果だ。

### 書式でマネージャを伝えたのは、仕様に無いから

OCI Runtime Spec には「cgroup マネージャ」という概念がない。`cgroupsPath` という文字列フィールドがあるだけだ。

runc が「コロンが 2 つ含まれていたら systemd 形式とみなす」という慣習を作り、crun もそれに従った。**仕様の穴を、値の書式で埋めている**。

これは [crun と runc をどう呼ぶか](../oci-runtime-invocation/) で見たエラーメッセージの正規表現分類と同じ構図だ。仕様が足りない部分を、実装同士の暗黙の取り決めで補っている。書式が曖昧なので、コンテナ名にコロンが使えないといった制約が副次的に生まれる。

### 黙って縮退することの是非

user session が無いときに cgroupfs へ落ちる挙動は、**エラーで止まるべきだ** という考え方もありうる。「制限したつもりで制限されていない」の方が、起動しないより危険だからだ。

Podman が縮退を選んだのは、**資源制限を使わないユーザの方が多い** という判断だろう。`podman run alpine echo hi` が user session の有無で失敗するのは体験として悪い。

その代わり警告は 4 行出す。エラーにしない代わりに、対処法を含めた警告を必ず出す、という妥協になっている。とはいえ CI のログでは警告が流れがちなので、**資源制限を本気で使うなら `podman info` の `cgroupManager` を確認する** のが確実だ。

## どう活かすか

- **共有された階層構造は、管理者を 1 人に決める。** cgroup に限らず、複数の主体が同じツリーを触る構造は破綻する。「誰が作るか」を明示的に決め、他は依頼する形にする。
- **警告は「状況・原因・対処・結果」の順で書く。** `CheckCgroupsAndAdjustConfig` の 4 行はこの構造になっていて、しかも対処にコマンドが入っている。1 行の警告より圧倒的に有用になる。
- **黙って機能を落とすなら、落としたことを検出できる手段を用意する。** `podman info` に `cgroupManager` が出るので、後から確認できる。警告だけだと流れて消える。
- **仕様に無い取り決めは、コメントで明示する。** `slice:prefix:name` の書式は仕様のどこにも書かれていない。コード中のコメントが唯一の一次情報になっているので、書いておく価値がある。
- **`fallthrough` は「条件付きで下の処理を共有する」意図に使える。** Go では珍しいが、`getOCICgroupPath` の使い方は読みやすい例になっている。
