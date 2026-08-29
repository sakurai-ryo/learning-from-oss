---
title: "root がなければ、ネットワークスタックそのものをユーザー空間の別プロセスに置く"
description: "rootless ではホストの netns に veth もブリッジも作れない。Podman の既定は、コンテナの netns に tap を作り、ホスト側は普通のソケット API で中継する pasta をコンテナごとに 1 つ起動すること。pasta は準備が済むと fork して親が終了し、netns が消えると自動で終わるので、Podman 側に同期も後始末も要らない。"
group: "rootless"
sidebar:
  order: 28
---

## 何を学んだか

### どんな状況の話か

root の Podman は、ホストの network namespace にブリッジを作り、veth の片側をコンテナの netns に差し込み、nftables で NAT を書く。これには `CAP_NET_ADMIN` が要る。rootless の Podman は [user namespace の中で root](../constructor-reexec/) だが、その capability は自分の namespace が所有するオブジェクトにしか効かない。ホストの netns は初期 user namespace の所有なので、そこに veth を作ることはできない。ネットワークモードの全体像は [ネットワークモードと namespace の共有](../network-modes/)、ポート公開の扱いは [ポート公開はどう実現されるか](../port-forwarding/) を参照。

つまり rootless では、コンテナの netns の「外側」をカーネルに作らせることができない。外側を誰かがユーザー空間で肩代わりする必要がある。

### Podman の答え

1. **pasta をコンテナごとに 1 つ起動する。** pasta は `--netns` で指定された netns に入って tap デバイスを作り、その netns 内のパケットを読んで、ホスト側では通常のソケット (TCP/UDP) で相手に接続する。ソケット API は非特権で使えるので、これだけで外に出られる。
2. **同期は「pasta の親が終了する」ことで取る。** pasta は準備が済むと fork して親が exit する。Podman は `exec.Command(...).CombinedOutput()` が返ってくるのを待つだけで、パイプもシグナルも要らない。
3. **後始末は netns の削除で済ませる。** pasta の子は netns が消えると自動で終了する。Podman 側に kill の経路は無い。
4. **NAT しない。ホストの IP をそのままコンテナにコピーする。** 5.0 で slirp4netns から pasta に既定が変わり、6.0 で slirp4netns は削除された。代償として「コンテナからホストの主 IP に接続できない」「同一ホストの別コンテナと直接通信できない」という制約が生じ、docs はそれを明示している。
5. **ポート公開も pasta 自身が行う。** `-t` / `-u` 引数で pasta がホスト側で listen する。コンテナ間通信やブリッジが要る場合は [別の経路](../rootless-network-bridge/) に切り替える。

## ソースコードのどこか

### 入口: pasta か bridge か

[`libpod/networking_linux.go#L20-L80`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/networking_linux.go#L20-L80) の `configureNetNS`。

```go title="libpod/networking_linux.go"
	if strings.HasPrefix(string(ctr.config.NetMode), "slirp4netns") {
		return nil, fmt.Errorf("slirp4netns support has been removed, run `podman system migrate` to update this container to use pasta")
	}
	if ctr.config.NetMode.IsPasta() {
		return nil, r.setupPasta(ctr, ctrNS)
	}
	networks, err := ctr.networks()
	/* ... */
	netStatus, err := r.setUpNetwork(ctrNS, netOpts)
```

`--net=pasta` (rootless の既定) は netavark を通らず、`setupPasta` で完結する。`setupPasta` 自体は薄い ([`libpod/networking_pasta_linux.go#L14-L26`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/networking_pasta_linux.go#L14-L26))。

```go title="libpod/networking_pasta_linux.go"
func (r *Runtime) setupPasta(ctr *Container, netns string) error {
	res, err := pasta.Setup(&pasta.SetupOptions{
		Config:       r.config,
		Netns:        netns,
		Ports:        ctr.convertPortMappings(),
		ExtraOptions: ctr.config.NetworkOptions[pasta.BinaryName],
	})
	if err != nil {
		return err
	}
	ctr.pastaResult = res
	return nil
}
```

### 起動と同期: 親の終了が準備完了の合図

本体は containers/common (v0.69.1) にある。[`vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go#L73-L99`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go#L73-L99)。

```go title="vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go"
// Setup start the pasta process for the given netns.
// The pasta binary is looked up in the HelperBinariesDir and $PATH.
// Note that there is no need for any special cleanup logic, the pasta
// process will automatically exit when the netns path is deleted.
func Setup(opts *SetupOptions) (*SetupResult, error) {
	path, err := opts.Config.FindHelperBinary(BinaryName, true)
	if err != nil {
		return nil, fmt.Errorf("could not find pasta, the network namespace can't be configured: %w", err)
	}

	cmdArgs, dnsForwardIPs, mapGuestAddrIPs, err := createPastaArgs(opts)
	if err != nil {
		return nil, err
	}

	logrus.Debugf("pasta arguments: %s", strings.Join(cmdArgs, " "))

	// pasta forks once ready, and quits once we delete the target namespace
	out, err := exec.Command(path, cmdArgs...).CombinedOutput()
	if err != nil {
		exitErr := &exec.ExitError{}
		if errors.As(err, &exitErr) {
			return nil, fmt.Errorf("pasta failed with exit code %d:\n%s",
				exitErr.ExitCode(), string(out))
		}
		return nil, fmt.Errorf("failed to start pasta: %w", err)
	}
```

コメントが設計を 2 行で言い切っている。"pasta forks once ready, and quits once we delete the target namespace"。`CombinedOutput()` が返る = 親が exit した = tap の設定が終わった、なので、Podman は同期の仕組みを一切持たない。終了時も [`libpod/networking_common.go#L129-L135`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/networking_common.go#L129-L135) で "per-container pasta cleans up when it exits, nothing to tear down" と書いて何もしない。

### 既定の引数: 何を足し、何を切るか

[`pasta_linux.go#L169-L191`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go#L169-L191) の `createPastaArgs`。

```go title="vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go"
	cmdArgs := []string{"--config-net"}
	// first append options set in the config
	cmdArgs = append(cmdArgs, opts.Config.Network.PastaOptions.Get()...)
	// then append the ones that were set on the cli
	cmdArgs = append(cmdArgs, opts.ExtraOptions...)

	cmdArgs = slices.DeleteFunc(cmdArgs, func(s string) bool {
		// --map-gw is not a real pasta(1) option so we must remove it
		// and not add --no-map-gw below
		if s == "--map-gw" {
			noMapGW = false
			return true
		}
		return false
	})
```

ポート公開とその後の既定値は [`#L219-L281`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go#L219-L281)。

```go title="vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go"
	for _, i := range opts.Ports {
		for protocol := range strings.SplitSeq(i.Protocol, ",") {
			/* ... */
			switch protocol {
			case "tcp":
				noTCPInitPorts = false
				cmdArgs = append(cmdArgs, "-t")
			case "udp":
				noUDPInitPorts = false
				cmdArgs = append(cmdArgs, "-u")
			/* ... */
			}

			arg := fmt.Sprintf("%s%d-%d:%d-%d", addr,
				i.HostPort,
				i.HostPort+i.Range-1,
				i.ContainerPort,
				i.ContainerPort+i.Range-1)
			cmdArgs = append(cmdArgs, arg)
		}
	}

	if len(dnsForwardIPs) == 0 {
		// the user did not request custom --dns-forward so add our own.
		cmdArgs = append(cmdArgs, dnsForwardOpt, dnsForwardIpv4)
		dnsForwardIPs = append(dnsForwardIPs, dnsForwardIpv4)
	}

	if noTCPInitPorts {
		cmdArgs = append(cmdArgs, "-t", "none")
	}
	if noUDPInitPorts {
		cmdArgs = append(cmdArgs, "-u", "none")
	}
	if noTCPNamespacePorts {
		cmdArgs = append(cmdArgs, "-T", "none")
	}
	if noUDPNamespacePorts {
		cmdArgs = append(cmdArgs, "-U", "none")
	}
	if noMapGW {
		cmdArgs = append(cmdArgs, "--no-map-gw")
	}
```

pasta は素の状態だと「ホストで bind 済みのポートを自動でコンテナに転送する」機能を持つ。Podman はそれを望まないので、`-p` が無ければ `-t none` / `-u none` を明示して切る。`--no-map-gw` はコンテナからゲートウェイアドレス経由でホストに直接届くのを禁じるためで、ユーザーが `--map-gw` (pasta には存在しない、Podman 独自の疑似オプション) を渡したときだけ外す。docs ([`docs/source/markdown/options/network.md#L62-L73`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/options/network.md#L62-L73)) がこの既定値の一覧を説明している。

固定 IP の定数 ([`#L28-L51`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go#L28-L51)) は、コメントに理由が書いてある。

```go title="vendor/go.podman.io/common/libnetwork/pasta/pasta_linux.go"
	// dnsForwardIpv4 static ip used as nameserver address inside the netns,
	// given this is a "link local" ip it should be very unlikely that it causes conflicts.
	dnsForwardIpv4 = "169.254.1.1"

	// mapGuestAddrIpv4 static ip used as forwarder address inside the netns to reach the host,
	// given this is a "link local" ip it should be very unlikely that it causes conflicts.
	mapGuestAddrIpv4 = "169.254.1.2"
```

pasta はホストの IP をそのままコピーするので、コンテナから「ホスト」を指す IP が無い。そこで link-local の `169.254.1.2` を `--map-guest-addr` で「この宛先はホスト」と決め、`host.containers.internal` の `/etc/hosts` エントリに使う。DNS も同じで、`169.254.1.1` を resolv.conf の先頭に置いて pasta の内蔵フォワーダに向ける。

### pasta が rootless 限定である理由

[`pkg/specgen/namespaces.go#L156-L166`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/namespaces.go#L156-L166)。

```go title="pkg/specgen/namespaces.go"
	case Pasta:
		// Check if we run rootless/in a userns. Do not use rootless.IsRootless() here.
		// Pasta switches to nobody when running as root which causes it to fail while
		// opening the netns owned by root. However when pasta is already in a userns
		// it doesn't switch to nobody so it works there.
		// https://github.com/containers/podman/issues/17840
		if unshare.IsRootless() {
			break
		}
		return fmt.Errorf("pasta networking is only supported for rootless mode or when inside a nested userns")
```

pasta は root で起動されると自分から `nobody` に降格する設計で、そのあと root 所有の netns を開けなくなる。判定に `rootless.IsRootless()` ではなく `unshare.IsRootless()` を使うのは、「user namespace の中の root」(ネストした Podman) も許すためだ。同じファイルの [`#L335-L336`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/namespaces.go#L335-L336) では `slirp4netns` の指定を明示的なエラーにしている。

### --userns と組み合わせるときは netns を「後から」設定する

[`pkg/specgen/generate/namespaces_linux.go#L163-L165`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/namespaces_linux.go#L163-L165)。

```go title="pkg/specgen/generate/namespaces_linux.go"
func needPostConfigureNetNS(s *specgen.SpecGenerator) bool {
	return !s.UserNS.IsHost()
}
```

コンテナが自前の user namespace を持つ (`--userns=keep-id` など) 場合、netns は Podman が先に作るのではなく、OCI ランタイムがコンテナプロセスとともに作り、Podman が `/proc/<pid>/ns/net` を開いて後から pasta を差し込む ([`libpod/networking_linux.go#L106-L120`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/networking_linux.go#L106-L120))。netns の所有者はそれを作ったプロセスの user namespace になるので、コンテナの user namespace が所有する netns でないと、コンテナの中で `CAP_NET_ADMIN` が効かない。この理由はコードには書かれていないので推測を含む。

## なぜそうなっているか

- **slirp4netns から pasta への移行は性能と設計の両方。** RELEASE_NOTES の 5.0.0 は "The default tool for rootless networking has been swapped from `slirp4netns` to `pasta` for improved performance" と書き、[`docs/tutorials/rootless_tutorial.md#L21`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/tutorials/rootless_tutorial.md#L21) は "Pasta fully supports IPv6 and is architecturally secure (runs in a separate process, uses modern Linux mechanisms for isolation etc)" と理由を挙げている。段階は 4.4 で `--net=pasta` 追加、5.0 で既定化、6.0 で slirp4netns 削除、と 3 メジャーバージョンかけている。
- **「NAT しない」の代償は docs が正面から認めている。** [`rootless.md#L9-L11`](https://github.com/podman-container-tools/podman/blob/v6.1.0/rootless.md#L9-L11): "Since pasta copies the IP address of the main interface, connections to that IP from containers do not work. This means that unless you have more than one interface, inter-container connections cannot be made without explicitly passing a pasta network configuration". [`docs/source/markdown/podman-network.1.md#L53-L56`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-network.1.md#L53-L56) も "Pasta by default performs no Network Address Translation (NAT) and copies the IPs from your main interface into the container namespace" と書く。単一コンテナが外に出るという最頻の用途に最適化し、コンテナ間通信は bridge 側に任せる、という割り切りだ。
- **同期と後始末を持たないのは pasta の設計に乗っているから。** 「準備できたら fork して親が exit」「netns が消えたら終了」という pasta 側の契約があるので、Podman は起動を待って終了を忘れるだけでよい。[次のページ](../rootless-network-bridge/) で見る rootlessport は同じことを ReadyFD と ExitFD で自前実装しており、対比すると pasta の契約の軽さが分かる。
- **1024 未満のポートは公開できない。** pasta はユーザー権限で listen するので、`net.ipv4.ip_unprivileged_port_start` の制限がそのまま効く ([`rootless.md#L5-L8`](https://github.com/podman-container-tools/podman/blob/v6.1.0/rootless.md#L5-L8))。ユーザー空間に置いたことで得た自由と、失った特権は同じものだ。

## どう活かすか

- 権限が無くてカーネルの機能を使えないなら、その機能をユーザー空間の別プロセスに置き換えられないか考える。置き換えたプロセスは非特権で動くので、権限の境界がそのまま監査の境界になる。
- 補助プロセスを起動するなら、「準備完了をどう知るか」「誰がいつ殺すか」を先に決める。「fork して親が exit」と「監視対象が消えたら自分で終わる」という契約にできれば、呼び出し側は何も持たなくて済む。
- 既定値を切り替えるときは、追加 → 既定化 → 旧実装の削除、を別々のメジャーバージョンに分け、削除後は明示的なエラーメッセージと移行コマンドを残す。
- 既定の挙動が制約を生むなら、docs に制約を制約として書く。「NAT しない」の帰結を rootless.md と troubleshooting に書いてあるので、ユーザーは「バグか仕様か」で迷わない。
- 取り込むべきでない条件: pasta の「IP をコピーする」モデルは、複数コンテナが相互に通信する構成には向かない。その場合は bridge を使うのが公式の使い分けで、pasta のオプションで無理に曲げるのは互換目的の回避策に留める。
