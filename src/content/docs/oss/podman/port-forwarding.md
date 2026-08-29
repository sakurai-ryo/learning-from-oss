---
title: "ポート公開はどう実現されるか"
description: "-p 8080:80 の実装は root と rootless で完全に別物になる。root では netavark が NAT ルールを入れ、Podman は起動前にポートを bind して予約しておく。rootless では NAT を書けないので、rootlessport というユーザ空間プロキシがホスト側で listen して中継する。プロキシ方式はクライアント IP が消えるため、pasta のカーネル転送に切り替える実験的オプションもある。"
group: "ネットワーク"
sidebar:
  order: 33
---

## 何を学んだか

### 3 つの方式が併存している

`-p 8080:80` を実現する方法は、環境と設定で 3 通りに分かれる。

| 方式               | 使われる場面                                                            | 仕組み                               | クライアント IP |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------ | --------------- |
| **NAT (netavark)** | root + bridge                                                           | iptables/nftables の DNAT            | 保たれる        |
| **rootlessport**   | rootless + bridge (既定)                                                | ユーザ空間プロキシが listen して中継 | **失われる**    |
| **pasta**          | rootless + pasta ネットワーク、または `rootless_port_forwarder="pasta"` | pasta 自身が転送                     | 保たれる        |

クライアント IP が保たれるかどうかが、実運用では効いてくる。rootlessport 経由だと、コンテナから見た接続元 IP が常にゲートウェイのアドレスになる。アクセスログも、IP ベースのアクセス制御も機能しなくなる。

### root では「先にポートを掴んでおく」

root + bridge の場合、実際の転送は netavark が入れる NAT ルールがやる。だが Podman には別の仕事がある。**コンテナを起動する前に、ホスト側のポートを bind して予約しておく** ことだ。

理由は 2 つ。

1. **早く失敗する** — ポートが既に使われていることを、コンテナを作る前に知りたい
2. **他のプロセスに取られない** — NAT ルールを入れても、そのポートで listen しているプロセスがいれば、そちらが優先されてしまう

予約は `socket()` + `bind()` までで、`listen()` はしない。ソケットを開いたまま持っておくだけで、他のプロセスは同じポートを bind できなくなる。この fd は conmon に引き渡され、**conmon が生きている間だけ予約が続く**。

### rootless では NAT が書けない

非特権ユーザは iptables/nftables のルールを触れない。だから NAT による転送は使えない。

代わりに **rootlessport** が動く。RootlessKit ベースのユーザ空間プロキシで、ホストの netns で `8080` を listen し、接続が来たらコンテナの netns 内の `80` に中継する。TCP の場合、2 つの接続の間でバイトをコピーし続ける。

コストは 3 つある。クライアント IP が消えること、コピーの分だけスループットが落ちること、そして **コンテナごとに常駐プロセスが増える** こと。

`rootless_port_forwarder="pasta"` に切り替えると、pasta の `pesto` バイナリによるカーネルレベルの転送になり、クライアント IP が保たれる。ただし `rootless.md` によればこれは実験的で、挙動が変わる可能性がある。

## ソースコードのどこか

### 予約は root かつ bridge かつ設定が有効なときだけ

[`libpod/networking_common.go#L27`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/networking_common.go#L27)。

```go title="libpod/networking_common.go"
func (c *Container) bindPorts() ([]*os.File, error) {
	if !c.runtime.config.Engine.EnablePortReservation || rootless.IsRootless() || !c.config.NetMode.IsBridge() {
		return nil, nil
	}
	return bindPorts(c.convertPortMappings(), c.runtime.config.Engine.ForcePortListen)
}
```

3 つの条件の否定を `||` で並べて早期 return する。rootless では **そもそも予約しない**。rootlessport が自分で listen するので、Podman が先に掴んでいると邪魔になる。

### 予約の実装は socket + bind だけ

[`libpod/oci_util.go#L33`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_util.go#L33)。

```go title="libpod/oci_util.go"
// Bind ports to keep them closed on the host
func bindPorts(ports []types.PortMapping, forceListen bool) ([]*os.File, error) {
	var files []*os.File
	sctpWarning := true
	for _, port := range ports {
		...
			for i := uint16(0); i < port.Range; i++ {
				f, err := bindPort(protocol, port.HostIP, port.HostPort+i, isV6, &sctpWarning, forceListen)
				if err != nil {
					// close all open ports in case of early error so we do not
					// rely on the garbage collector to close them
					for _, f := range files {
						f.Close()
					}
					return nil, err
				}
```

コメントの「**GC に頼らないよう、途中で失敗したら開いたポートを全部閉じる**」が実務的だ。Go の `os.File` はファイナライザで close されるが、いつ走るか分からない。ポートは希少資源なので、明示的に閉じる。

そして `bindPort` 本体。

```go title="libpod/oci_util.go"
// bindPort reserves a port on the host using socket+bind, listen() only when listen is set to true
// Dual-stack bind by default unless hostIP is specified.
func bindPort(protocol, hostIP string, port uint16, isV6 bool, sctpWarning *bool, forceListen bool) (*os.File, error) {
	switch protocol {
	case "tcp", "udp":
		sockType := unix.SOCK_STREAM
		if protocol == "udp" {
			sockType = unix.SOCK_DGRAM
		}
		...
		if err := unix.Bind(fd, sa); err != nil {
			unix.Close(fd)
			return nil, fmt.Errorf("cannot bind %s port %s: %w", protocol, net.JoinHostPort(hostIP, strconv.FormatUint(uint64(port), 10)), err)
		}

		if forceListen && sockType == unix.SOCK_STREAM {
			if err := unix.Listen(fd, 0); err != nil {
```

**`listen()` は既定ではしない**。`bind` だけでポートは占有されるので、それで足りる。`listen` すると接続を受け付けてしまい、accept しないので接続がハングする。

`force_port_listen` という設定でだけ `listen` する。バックログ 0 で。これはロードバランサのヘルスチェックのように「ポートが開いているか」を TCP 接続で確かめる相手がいる場合の逃げ道になっている。

IPv6 のフォールバックも入っている。

```go title="libpod/oci_util.go"
		fd, err := unix.Socket(domain, sockType|unix.SOCK_CLOEXEC, 0)
		if err != nil {
			// If hostIP == "" and IPv6 is not supported, fall back to IPv4
			if hostIP == "" && errors.Is(err, unix.EAFNOSUPPORT) {
				return bindPortV4Fallback(protocol, sockType, port)
			}
```

ホスト IP の指定がなければ dual-stack で bind しようとし、IPv6 が無効な環境なら IPv4 に落ちる。**環境差をエラーではなく縮退で吸収する**。

SCTP は予約できないので、警告を 1 回だけ出す。

```go title="libpod/oci_util.go"
	case "sctp":
		if *sctpWarning {
			logrus.Info("Port reservation for SCTP is not supported")
			*sctpWarning = false
		}
```

`sctpWarning` がポインタで渡されているのは、**ポートの数だけ警告が出るのを防ぐため**。ループの外で 1 回だけ出す、を実現する素朴な方法だ。

### rootless の転送方式は 3 分岐

[`libpod/networking_linux.go#L62-L77`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/networking_linux.go#L62)。

```go title="libpod/networking_linux.go"
	// Set up port forwarding for rootless bridge networks.
	// Note: pasta/pesto port forwarding is handled inside container-libs
	// netavark Setup(), so only rootlessport needs explicit setup here.
	if rootless.IsRootless() && len(ctr.config.PortMappings) > 0 {
		switch r.config.Network.RootlessPortForwarder {
		case config.RootlessPortForwarderPasta:
			// Handled by container-libs netavark Setup()
		case config.RootlessPortForwarderRootlessport, "":
			if !reload {
				err = r.setupRootlessPortMappingViaRLK(ctr, ctrNS, netStatus)
			}
		default:
			err = fmt.Errorf("invalid rootless_port_forwarder value %q, must be %q or %q",
				r.config.Network.RootlessPortForwarder, config.RootlessPortForwarderRootlessport, config.RootlessPortForwarderPasta)
		}
	}
```

`pasta` の case が **空** で、コメントだけがある。「container-libs の netavark Setup() の中で処理される」。何もしないことが正しい、という分岐を空の case + コメントで表現している。`default` に落ちないようにするためにも必要だ。

### rootlessport には終了通知用のパイプを渡す

[`libpod/networking_rootlessport.go#L17`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/networking_rootlessport.go#L17)。

```go title="libpod/networking_rootlessport.go"
func (r *Runtime) setupRootlessPortMappingViaRLK(ctr *Container, netnsPath string, netStatus map[string]types.StatusBlock) error {
	// Only create pipes if they don't exist yet
	if ctr.rootlessPortSyncR == nil {
		var err error
		ctr.rootlessPortSyncR, ctr.rootlessPortSyncW, err = os.Pipe()
		...
	}
	// Only defer close if not in PostConfigureNetNS mode to avoid double-close
	if !ctr.config.PostConfigureNetNS {
		defer errorhandling.CloseQuiet(ctr.rootlessPortSyncR)
	}
	return slirp4netns.SetupRootlessPortMappingViaRLK(&slirp4netns.SetupOptions{
		Config:                r.config,
		ContainerID:           ctr.ID(),
		Netns:                 netnsPath,
		Ports:                 ctr.convertPortMappings(),
		RootlessPortExitPipeR: ctr.rootlessPortSyncR,
	}, nil, netStatus)
}
```

`RootlessPortExitPipeR` が要点だ。**パイプの読み側を rootlessport に渡し、書き側は conmon が持つ**。conmon が死ねば書き側が閉じ、rootlessport はパイプの EOF を検出して自分も終了する。

デーモンレスでは「誰が rootlessport を止めるか」が問題になる。Podman は既に終了しているし、監視するプロセスもいない。**パイプの EOF を寿命の通知に使う** ことで、監視なしの後始末を実現している。前提群の言葉でいえば、これも「通信路をファイルシステム (fd) に移す」設計の一部だ。

パッケージのインポートに残る注記も面白い。

```go title="libpod/networking_rootlessport.go"
	"go.podman.io/common/libnetwork/slirp4netns" // RootlessKit port mapping only, not the removed slirp4netns backend
```

`slirp4netns` パッケージ自体は残っている。**ネットワークバックエンドとしての slirp4netns は削除されたが、RootlessKit のポート転送コードは同じパッケージに同居していた**ので、そこだけ生き残った。import 行のコメントで誤解を防いでいる。

### ポートマッピングの動的な再読み込み

`podman network connect` でネットワーク構成が変わると、コンテナの IP が変わる。rootlessport は転送先を知り直す必要がある。

```go title="libpod/networking_rootlessport.go"
	conn, err := openUnixSocket(filepath.Join(c.runtime.config.Engine.TmpDir, "rp", c.config.ID))
	if err != nil {
		return fmt.Errorf("could not reload rootless port mappings, port forwarding may no longer work correctly: %w", err)
	}
	defer conn.Close()
	enc := json.NewEncoder(conn)
	err = enc.Encode(childIP)
	...
	data := string(b)
	if data != "OK" {
		return fmt.Errorf("port reloading failed: %s", data)
	}
```

`$TMPDIR/rp/<container-id>` という unix socket に新しい IP を JSON で送り、`"OK"` が返るのを待つ。ここでも前に見た `openUnixSocket` (O_PATH 経由でパス長制限を回避する関数) が使われている。

**プロトコルは「JSON 1 つ送って OK を待つ」だけ**。常駐プロセスへの制御チャネルとして、これ以上単純にはできない形になっている。

### machine では HostIP を捨てる

```go title="libpod/networking_common.go"
// convertPortMappings will remove the HostIP part from the ports when running inside podman machine.
// This is needed because a HostIP of 127.0.0.1 would now allow the gvproxy forwarder to reach to open ports.
// For machine the HostIP must only be used by gvproxy and never in the VM.
func (c *Container) convertPortMappings() []types.PortMapping {
	if !machine.IsGvProxyBased() || len(c.config.PortMappings) == 0 {
		return c.config.PortMappings
	}
	// if we run in a machine VM we have to ignore the host IP part
	newPorts := make([]types.PortMapping, 0, len(c.config.PortMappings))
	for _, port := range c.config.PortMappings {
		port.HostIP = ""
		newPorts = append(newPorts, port)
	}
	return newPorts
}
```

`podman machine` (macOS / Windows の VM) では、ポート転送が **2 段** になる。ホスト → gvproxy → VM → コンテナ。`-p 127.0.0.1:8080:80` の `127.0.0.1` は「ホストのループバック」を意味するが、VM の中でそのまま使うと VM のループバックに bind してしまい、gvproxy から届かなくなる。

だから **VM の中では HostIP を捨てる**。「HostIP は gvproxy だけが使い、VM の中では絶対に使わない」とコメントにある。層が増えると、同じ値の意味が層ごとに変わる、という典型例だ ([podman machine](../podman-machine/))。

## なぜそうなっているか

### 予約が必要なのは、NAT が listen に負けるから

iptables の DNAT ルールがあっても、そのポートでホストのプロセスが listen していれば、パケットはそちらに届く。「コンテナを起動したのにポートが別のプロセスに使われていた」という状態を防ぐには、**Podman 側でポートを掴んでおく** しかない。

`listen()` せずに `bind()` だけで済むのは、bind の時点でポートが排他的に確保されるからだ。**必要最小限のシステムコールで目的を達している**。

### rootlessport がクライアント IP を失うのは、構造上の帰結

ユーザ空間プロキシは、クライアントからの接続を自分で `accept` し、コンテナへは自分で `connect` する。2 本の別々の TCP 接続なので、コンテナ側から見た接続元はプロキシになる。

これを避けるには、カーネルレベルで転送する (NAT か、pasta のような方式) しかない。**プロキシ方式である限り避けられない** ので、pasta への切り替えオプションが用意された。

「動くが情報が落ちる方式」を既定にして、「情報が保たれるが実験的な方式」をオプトインにする、という段階の踏み方をしている。

### パイプで寿命を伝えるのは、デーモンレスの定石

rootlessport を止めるのに、監視プロセスも、シグナルも、タイマーも使っていない。**パイプの読み側を渡し、書き側を持っている conmon が死ねば EOF が来る**。

この形は「親が死んだら子も死ぬ」を最小のコストで実現する。`PR_SET_PDEATHSIG` (親が死んだらシグナル) という手もあるが、パイプなら間接的な親子関係でも使える。conmon と rootlessport は直接の親子ではないので、こちらが適している。

## どう活かすか

- **ポートの予約は `bind` だけでよい。** `listen` すると接続を受け付けてしまう。「占有したいが受けたくない」場合の定石として覚えておく。
- **子プロセスの寿命はパイプの EOF で伝える。** 監視ループもシグナルも要らない。読み側を子に渡し、書き側を親が持つだけ。親子関係が直接でなくても使える。
- **警告の重複はフラグをポインタで渡して抑える。** ループの中で 1 回だけ出したい警告は、状態をポインタで持ち回るのが最も単純。
- **何もしないことが正しい分岐は、空の case とコメントで書く。** 条件から漏らすと `default` に落ちる。「ここでは何もしない、なぜなら別の場所でやるから」を明示する。
- **層が増えると同じ値の意味が変わる。** `HostIP` が VM の中では別の意味になる、というような罠は、層をまたぐ設計で必ず出る。値を渡す前に「この層での意味は何か」を確認する。
