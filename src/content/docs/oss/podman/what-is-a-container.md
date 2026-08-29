---
title: "コンテナは仮想マシンではない — namespace・cgroup・rootfs の合成"
description: "Linux に「コンテナ」という機能はない。あるのは namespace・cgroup・rootfs の差し替え・権限の削減という独立した部品だけで、コンテナはそれらを特定の組み合わせで設定したただのプロセスだ。Podman はその組み合わせを NamespaceMode という文字列 enum で表し、namespace ごとに host / private / 他コンテナと共有 を選ばせる。この「分解して選べる」性質が、Pod も --net=host も同じ仕組みの上に載る理由になっている。"
group: "コンテナランタイムの前提"
sidebar:
  order: 1
---

## 何を学んだか

### 「コンテナを作る」システムコールは存在しない

`podman run` や `docker run` の結果として動いているものは、**ホストのカーネルの上で動く、ただの Linux プロセス**だ。仮想マシンのようにゲストカーネルがいるわけではない。`ps aux` をホストで叩けば、コンテナの中の nginx はそのまま見える。

カーネルが提供しているのは、コンテナという単位ではなく次の部品だけだ。

| 部品                         | 何ができるか                                   | コンテナで何に使うか                           |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| namespace                    | あるリソースの「見え方」をプロセスごとに分ける | 別の PID 空間・別のネットワーク・別の hostname |
| cgroup                       | プロセス群の資源使用量を制限・計測する         | `--memory` `--cpus`                            |
| `pivot_root(2)` / `mount(2)` | root filesystem を差し替える                   | イメージから作った rootfs を `/` にする        |
| capabilities / seccomp / LSM | 権限を削る                                     | root ユーザーだがホストは壊せない状態を作る    |

コンテナとは、**これらを特定の組み合わせで設定した状態で `execve(2)` されたプロセス**にすぎない。「コンテナを起動する」という操作の実体は、この設定を全部済ませてからユーザのプログラムに置き換わることだ。

仮想マシンとの違いはここにある。VM はゲストカーネルを持ち、ハイパーバイザが仮想 CPU と仮想デバイスを提供する ([Firecracker 章の「なぜ microVM か」](../../firecracker/why-microvm/) がその側の話)。コンテナはカーネルを共有するので、起動は速く、メモリのオーバーヘッドも小さいが、**カーネルの脆弱性はそのままホストへの脅威になる**。この非対称性が、あとで見る rootless の動機になる。

### namespace は 8 種類あり、それぞれ独立して選べる

Linux の namespace は現在 8 種類ある。

| namespace | 分離するもの                            | よくある指定                               |
| --------- | --------------------------------------- | ------------------------------------------ |
| mount     | マウントテーブル                        | 常に private (rootfs を差し替えるため)     |
| pid       | プロセス ID 空間                        | private / `--pid=host` / Pod 内で共有      |
| net       | NIC・ルーティング・iptables             | bridge / pasta / `--net=host` / 共有       |
| ipc       | System V IPC と POSIX メッセージキュー  | private / `--ipc=host` / 共有              |
| uts       | hostname と domainname                  | private (`--hostname`) / host              |
| user      | uid/gid のマッピング                    | rootless では必須。root では既定で使わない |
| cgroup    | cgroup 階層のルートの見え方             | 既定は private                             |
| time      | boottime / monotonic clock のオフセット | Podman では扱わない                        |

重要なのは **8 つが独立して選べる** ことだ。「net だけホストと共有し、pid は分ける」も「pid と ipc と net を別のコンテナと共有し、mount だけ自分専用にする」も、同じ枠組みで表せる。後者がまさに **Pod** の正体で、Kubernetes の Pod も Podman の Pod も、追加の仕組みではなく「namespace の共有先を他コンテナに向けただけ」だ。

Docker で `--net=host` や `--pid=container:xxx` を使ったことがあるなら、あれは特別なオプションではなく、この 8 つの軸それぞれに「誰の namespace を使うか」を指定しているだけだと分かる。

### エンジンにとってコンテナは「設定の集合」

ここから、コンテナエンジンの仕事の輪郭が決まる。エンジン自身が `clone(2)` を呼ぶ必要はない。エンジンがやるのは、

1. イメージを取ってきて rootfs を組む
2. 「どの namespace をどうするか」「どの cgroup に入れるか」「どの capability を落とすか」を決める
3. それを **OCI Runtime Spec の `config.json` という 1 つの JSON に書く**
4. その JSON を読んで実際に `clone` する低レベルランタイム (crun / runc) を起動する

Podman もこの通りに動く。Podman のコードを読むと、`clone` や `setns` の呼び出しはほとんど出てこない (rootless の自分自身の namespace 操作を除く)。代わりに大量に出てくるのは、**JSON のフィールドを埋めるコード**だ。

## ソースコードのどこか

### namespace の扱いを 1 つの文字列 enum で表す

Podman は「この namespace をどうするか」を `NamespaceMode` という文字列型で表現する。[`pkg/specgen/namespaces.go#L23-L65`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/namespaces.go#L23-L65)。

```go title="pkg/specgen/namespaces.go"
type NamespaceMode string

const (
	// Default indicates the spec generator should determine
	// a sane default
	Default NamespaceMode = "default"
	// Host means the namespace is derived from the host
	Host NamespaceMode = "host"
	// Path is the path to a namespace
	Path NamespaceMode = "path"
	// FromContainer means namespace is derived from a
	// different container
	FromContainer NamespaceMode = "container"
	// FromPod indicates the namespace is derived from a pod
	FromPod NamespaceMode = "pod"
	// Private indicates the namespace is private
	Private NamespaceMode = "private"
	// Shareable indicates the namespace is shareable
	Shareable NamespaceMode = "shareable"
	// None indicates the IPC namespace is created without mounting /dev/shm
	None NamespaceMode = "none"
```

`Default` / `Host` / `Path` / `FromContainer` / `FromPod` / `Private` の 6 つが、8 種類の namespace すべてに共通する語彙だ。そこにネットワーク固有の `Bridge` `Pasta` `NoNetwork`、user namespace 固有の `KeepID` `NoMap` `Auto` が足される。

そして「コンテナを作る意図」を表す `SpecGenerator` は、namespace ごとにこの型のフィールドを 1 つずつ持つ。[`pkg/specgen/specgen.go#L145`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen.go#L145) 以降に、`PidNS` `UtsNS` `IpcNS` `UserNS` `CgroupNS` `NetNS` が散らばっている。

```go title="pkg/specgen/specgen.go"
	// PidNS is the container's PID namespace.
	PidNS Namespace `json:"pidns"`
	...
	// NetNS is the configuration to use for the container's network
	// namespace.
	NetNS Namespace `json:"netns"`
```

`--pid=host` も `--pid=container:web` も `--pid=pod` も、この 1 つのフィールドに `{NSMode: "host"}` / `{NSMode: "container", Value: "web"}` / `{NSMode: "pod"}` が入るだけの違いになる。

### 最終的な出力は OCI spec 1 つ

その `SpecGenerator` を OCI Runtime Spec に変換するのが [`pkg/specgen/generate/oci_linux.go#L103`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/oci_linux.go#L103) の `SpecGenToOCI` だ。

```go title="pkg/specgen/generate/oci_linux.go"
func SpecGenToOCI(_ context.Context, s *specgen.SpecGenerator, rt *libpod.Runtime, rtc *config.Config, newImage *libimage.Image, mounts []spec.Mount, pod *libpod.Pod, finalCmd []string, compatibleOptions *libpod.InfraInherit) (*spec.Spec, error) {
	cgroupPerm := getCgroupPermissions(s.Unmask)

	g, err := generate.New("linux")
	if err != nil {
		return nil, err
	}
	// Remove the default /dev/shm mount to ensure we overwrite it
	g.RemoveMount("/dev/shm")
	g.HostSpecific = true
```

`generate.New("linux")` は `opencontainers/runtime-tools` のヘルパーで、仕様が定める既定値の入った spec を作る。あとはこの `g` に対して「マウントを消す」「マウントを足す」「masked path を足す」を繰り返すだけだ。関数の中身の大半が、次のような条件分岐でできている。

```go title="pkg/specgen/generate/oci_linux.go"
	if !canMountSys {
		addCgroup = false
		g.RemoveMount("/sys")
		r := "ro"
		if s.IsPrivileged() {
			r = "rw"
		}
		sysMnt := spec.Mount{
			Destination: "/sys",
			Type:        define.TypeBind,
			Source:      "/sys",
			Options:     []string{"rprivate", "nosuid", "noexec", "nodev", r, "rbind"},
		}
		g.AddMount(sysMnt)
```

rootless で新しい user namespace を持たない場合、`/sys` を sysfs として新規マウントする権限がないので、**ホストの `/sys` を read-only で bind mount する** という妥協をしている。「コンテナの中身は設定次第でいくらでも変わる」ことがよく分かる箇所だ。

## なぜそうなっているか

### 部品が分かれているから、組み合わせを表す語彙が要る

もし Linux に「コンテナを作るシステムコール」があったなら、エンジンはそれを呼ぶだけでよかった。実際にはカーネルは直交する部品しか提供しないので、**「どの部品をどう設定するか」を表現する語彙**を誰かが定義しなければならない。それが OCI Runtime Spec の `config.json` であり、Podman の内部では `SpecGenerator` だ。

そして部品が直交しているおかげで、後から出てきた要求 — Pod、`--net=container:`、sidecar、rootless — が、**新しい機構ではなく既存の軸の新しい値**として表現できている。`NamespaceMode` に `FromPod` を足すことで Pod が表現できたのは、その典型だ。

### 「コンテナの外」に残るものが、そのまま制約になる

namespace で分離されないものは、コンテナからホストと共有される。カーネル本体、ロードされたモジュール、`/proc/sys` の多く (一部は namespace 化されている)、そしてカーネルのバグ。だから Podman の spec 生成には `AddLinuxMaskedPaths("/sys/kernel")` のような、**「見せない」ことで危険を減らす**処理が随所に入る。

これは VM との根本的な差だ。VM ならゲストカーネルが壊れてもホストは無事だが、コンテナではカーネルが 1 つしかない。「コンテナはセキュリティ境界か」という議論がいつまでも終わらないのはこのためで、Podman が rootless をここまで真剣にやる理由もここにある。root で動くコンテナが破られたときの影響を、user namespace で一段下げておく、という発想だ。

## どう活かすか

- **「コンテナ = プロセス + 設定」と捉えると、トラブルシュートの当たりが付く。** コンテナの中から見えるものがおかしいときは、8 つの namespace のどれがどう設定されているかを疑う。`podman inspect` や `/proc/<pid>/ns/` を見れば、共有先はすぐ分かる。
- **直交する軸として設計されているものは、値の追加で拡張できる。** 自分で「モード」を表す型を作るときも、`bool` を並べるより「軸 × 値」の形にしておくと、あとから `FromPod` のような値を足すだけで新機能が入る。Podman の `NamespaceMode` はその好例だ。
- **仕様の既定値から差分で組み立てる。** `generate.New("linux")` で仕様準拠の初期値を得てから `RemoveMount` / `AddMount` していく形は、「何をデフォルトから変えたか」がコードにそのまま残る。全フィールドを自前で埋める実装より、レビューでも差分が読みやすい。
