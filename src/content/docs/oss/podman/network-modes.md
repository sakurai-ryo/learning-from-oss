---
title: "ネットワークモードと namespace の共有"
description: "--network が取る値は bridge・pasta・host・none・container:・pod:・ns:path・ネットワーク名の 8 通りで、すべて 1 つの Namespace フィールドに収まる。既定の private は root なら bridge、rootless なら pasta に解決される。v6 で slirp4netns は削除され、エラーメッセージが移行先を案内する。rootless で他コンテナの host ネットワークを共有しようとしたときの読み替えなど、制約由来の補正が随所に入る。"
group: "ネットワーク"
sidebar:
  order: 32
---

## 何を学んだか

### `--network` の値は 8 通り

| 値               | 意味                                                 |
| ---------------- | ---------------------------------------------------- |
| `bridge`         | netavark でブリッジを作って接続 (root の既定)        |
| `pasta`          | ユーザ空間のネットワークスタック (rootless の既定)   |
| `host`           | ホストの netns をそのまま使う。namespace を作らない  |
| `none`           | netns は作るが、lo 以外のインターフェースを持たない  |
| `container:<id>` | 別のコンテナの netns に参加                          |
| `pod`            | 同じ Pod の infra コンテナの netns に参加            |
| `ns:<path>`      | 任意の netns のパスに参加                            |
| `<name>`         | `podman network create` で作った名前付きネットワーク |

前提群で見たとおり、これらはすべて `Namespace{NSMode, Value}` という 1 つの構造体に入る。`container:web` なら `{NSMode: "container", Value: "web"}`。

### 既定は「private」で、それが後から解決される

`containers.conf` の既定値は `netns = "private"` だ。だが `private` という netns は存在しない。**実際に何になるかは、root か rootless かで後から決まる**。

- **root** → `bridge` (既定のネットワーク `podman` に接続)
- **rootless** → `default_rootless_network_cmd` の値。既定は `pasta`

この解決が `MakeContainer` の中、つまり **libpod を持つ側** で行われる。CLI の段階では `private` のまま運ばれる。リモート実行のとき、解決はサーバ側で起きるべきだからだ ([2 段構成の specgen](../specgen-two-stage/))。

### v6 で slirp4netns が消えた

Podman 4 まで rootless の既定だった `slirp4netns` は、v6 で **削除された**。指定するとエラーになり、移行先が案内される。

pasta への移行には非互換がある。`rootless.md` に書かれているとおり、pasta は **ホストのメインインターフェースの IP をコピーする** ので、その IP に対するコンテナからの接続が動かない。インターフェースが 1 つしかない環境では、コンテナ間の接続に明示的な pasta の設定が要る。

大きな非互換を伴う既定変更を、2 メジャーバージョンかけて (5.0 で既定変更、6.0 で削除) 進めた形になる。

### namespace の共有には制約がある

`--network=container:web` は、web コンテナの netns に参加する。実装は「web の `/proc/<pid>/ns/net` を OCI spec に書く」だけだ。

だが rootless では、参加できない場合がある。web が `--network=host` で動いていたら、その netns は **ホストの netns** だ。非特権プロセスはホストの netns に `setns` できない。

Podman はこれを **エラーにせず、`host` として読み替える**。結果は同じ (ホストのネットワークが見える) で、`setns` が失敗するのを避けられる。

## ソースコードのどこか

### 8 通りの解析が 1 つの switch に

[`pkg/specgen/namespaces.go#L317`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/namespaces.go#L317) の `ParseNetworkFlag`。

```go title="pkg/specgen/namespaces.go"
func ParseNetworkFlag(networks []string) (Namespace, map[string]types.PerNetworkOptions, []string, map[string][]string, error) {
	var networkOptions map[string][]string
	toReturn := Namespace{}
	// by default we try to use the containers.conf setting
	// if we get at least one value use this instead
	cfg, err := config.Default()
	...
	ns := cfg.Containers.NetNS
	if len(networks) > 0 {
		ns = networks[0]
	}
```

**指定がなければ `containers.conf` の値を使う**。フラグと設定ファイルの優先順位が、変数への代入 2 行で表現されている。

そして switch。

```go title="pkg/specgen/namespaces.go"
	switch {
	case ns == "slirp4netns", strings.HasPrefix(ns, "slirp4netns:"):
		return toReturn, nil, nil, nil, fmt.Errorf("slirp4netns support has been removed, use --network=pasta instead; for existing containers, run `podman system migrate`")
	case ns == string(FromPod):
		toReturn.NSMode = FromPod
	case ns == "" || ns == string(Default) || ns == string(Private):
		toReturn.NSMode = Private
	case ns == string(Bridge), strings.HasPrefix(ns, string(Bridge)+":"):
		toReturn.NSMode = Bridge
		...
		// we have to set the special default network name here
		podmanNetworks["default"] = netOpts
		networkOrder = append(networkOrder, "default")
	case ns == string(NoNetwork):
		toReturn.NSMode = NoNetwork
	case ns == string(Host):
		toReturn.NSMode = Host
	case strings.HasPrefix(ns, "ns:"):
		_, value, _ := strings.Cut(ns, ":")
		toReturn.NSMode = Path
		toReturn.Value = value
	case strings.HasPrefix(ns, string(FromContainer)+":"):
		_, value, _ := strings.Cut(ns, ":")
		toReturn.NSMode = FromContainer
		toReturn.Value = value
	case ns == string(Pasta), strings.HasPrefix(ns, string(Pasta)+":"):
		...
		toReturn.NSMode = Pasta
	default:
		// we should have a normal network
		name, options, hasOptions := strings.Cut(ns, ":")
```

削除された機能の扱いが目を引く。**最初の case が `slirp4netns` で、エラーメッセージが移行先と移行コマンドを示す**。

```
slirp4netns support has been removed, use --network=pasta instead;
for existing containers, run `podman system migrate`
```

「削除しました」だけでなく「代わりに何を使うか」「既存コンテナはどうするか」まで書いてある。削除する機能に対して、こういうエラーを 1 つ残すだけで移行の問い合わせが激減する。

`default:` が「名前付きネットワーク」なのも設計判断だ。予約語に当てはまらないものはネットワーク名として扱う。新しいモードを足すと既存のネットワーク名と衝突しうるので、**モード名は慎重に選ぶ必要がある**という制約が生まれている。

### private の解決は libpod 側で

[`pkg/specgen/generate/container_create.go#L199-L217`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container_create.go#L199)。

```go title="pkg/specgen/generate/container_create.go"
	// Set defaults if network info is not provided
	if s.NetNS.IsPrivate() || s.NetNS.IsDefault() {
		if rootless.IsRootless() {
			// when we are rootless we default to default_rootless_network_cmd from containers.conf
			conf, err := rt.GetConfigNoCopy()
			...
			switch conf.Network.DefaultRootlessNetworkCmd {
			case pasta.BinaryName, "":
				s.NetNS.NSMode = specgen.Pasta
			default:
				return nil, nil, nil, fmt.Errorf("invalid default_rootless_network_cmd option %q",
					conf.Network.DefaultRootlessNetworkCmd)
			}
		} else {
			// as root default to bridge
			s.NetNS.NSMode = specgen.Bridge
		}
	}

	if err := s.Validate(); err != nil {
```

`switch` の case が `pasta.BinaryName` と `""` の 2 つしかない。**選択肢が実質 1 つしかないのに switch にしてある**。slirp4netns があった頃の名残でもあり、将来の追加への備えでもある。

そして解決の直後に `s.Validate()` が来る。前提群で触れた「検証はデフォルト決定の後」という順序がここに現れている。`private` のまま検証すると、「private というネットワークモードは無い」で落ちてしまう。

### bridge の解決では「default」という名前を実名に置き換える

```go title="pkg/specgen/generate/namespaces.go"
	case specgen.Bridge, specgen.Private, specgen.Default:
		rtConfig, err := rt.GetConfigNoCopy()
		...
		// if no network was specified use add the default
		if len(s.Networks) == 0 {
			// no networks given but bridge is set so use default network
			s.Networks = map[string]types.PerNetworkOptions{
				rtConfig.Network.DefaultNetwork: {},
			}
		}
		// rename the "default" network to the correct default name
		if opts, ok := s.Networks["default"]; ok {
			s.Networks[rtConfig.Network.DefaultNetwork] = opts
			delete(s.Networks, "default")
```

`ParseNetworkFlag` は `--network=bridge:mac=...` のようなオプション付きの指定を、いったん `"default"` という仮の名前で持つ。実際のネットワーク名 (`podman` など、設定次第) はここで初めて分かるので、**libpod を持つ側で置き換える**。

`NetworkOrder` (複数ネットワークの接続順) も同じ置換をする必要があるので、同じループが 2 回書かれている。仮名を使う設計のコストが出ている箇所だ。

### rootless で他コンテナの host netns を共有するときの読み替え

[`pkg/specgen/generate/namespaces.go#L342-L348`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/namespaces.go#L342)。

```go title="pkg/specgen/generate/namespaces.go"
		if rootless.IsRootless() && netCtr.NamespaceMode(spec.NetworkNamespace, netCtr.ConfigNoCopy().Spec) == host {
			// Treat this the same as host, the problem is the runtime tries to do a
			// setns call and this will fail when it is the host ns as rootless user.
			s.NetNS.NSMode = specgen.Host
		} else {
			toReturn = append(toReturn, libpod.WithNetNSFrom(netCtr))
		}
```

「これは host と同じ扱いにする。問題は、ランタイムが `setns` を呼ぼうとして、rootless ユーザではホストの netns に対して失敗すること」。

**意味的には同じで、実行可能な方に読み替える**。ユーザから見れば結果は変わらないので、エラーにする理由がない。rootless の制約が、こういう小さな補正としてコードのあちこちに現れる。

### Pod の共有設定が既定値を上書きする

[`pkg/specgen/generate/namespaces.go#L43`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/namespaces.go#L43) の `GetDefaultNamespaceMode`。

```go title="pkg/specgen/generate/namespaces.go"
// Get the default namespace mode for any given namespace type.
func GetDefaultNamespaceMode(nsType string, cfg *config.Config, pod *libpod.Pod) (specgen.Namespace, error) {
	// The default for most is private
	toReturn := specgen.Namespace{}
	toReturn.NSMode = specgen.Private

	// Ensure case insensitivity
	nsType = strings.ToLower(nsType)

	// If the pod is not nil - check shared namespaces
	if pod != nil && pod.HasInfraContainer() {
		podMode := false
		switch {
		case nsType == "pid" && pod.SharesPID():
			if pod.NamespaceMode(spec.PIDNamespace) == host {
				toReturn.NSMode = specgen.Host
				return toReturn, nil
			}
			podMode = true
```

`nsType` を文字列で受け取り、`switch` で分岐する。**namespace の種類が「型」ではなく「文字列」** になっているので、8 種類の namespace に対して同じ関数を使い回せる。

Pod に入るコンテナは、Pod が共有している namespace については `FromPod` が既定になる。ただし **Pod 自身が host モードなら host** にする。2 段の上書きがここで解決される。

user namespace には別の制約がある。

```go title="pkg/specgen/generate/namespaces.go"
// userNSConflictsWithPod returns an error if the user namespace mode
// conflicts with pod namespace sharing requirements.
// Containers in a pod must use the same user namespace to avoid ownership and
// capability issues with shared resources.
func userNSConflictsWithPod(pod *libpod.Pod, mode specgen.NamespaceMode) error {
```

**Pod 内のコンテナは同じ user namespace を使わなければならない**。所有権と capability の問題が起きるからだ。他の namespace は個別に選べるが、user namespace だけは Pod 全体で揃える必要がある。

## なぜそうなっているか

### 「private」という抽象的な既定が要る理由

`containers.conf` に `netns = "bridge"` と書いてしまうと、rootless ユーザがその設定を読んだときに壊れる。rootless ではブリッジをそのままは作れないからだ。

かといって設定ファイルを root 用と rootless 用で分けると、管理が増える。そこで **「private = ネットワーク名前空間を分離する」という意図だけを書き、手段は実行時に決める** 形にした。

これは「設定に書くのは what であって how ではない」という一般則の実例といえる。設定に手段を書くと、環境ごとに設定を分ける必要が出てくる。

### 削除にエラーメッセージを 1 つ残す

`slirp4netns` の case は、実質 1 行のエラーを返すだけだ。だがこの 1 行があるかないかで、移行の体験が大きく変わる。

無ければ「不明なネットワークモード `slirp4netns`」あるいは「そういう名前のネットワークは無い」というエラーになる (`default:` に落ちるため)。**削除した機能の名前を残して、専用のメッセージを返す** ことにはコストがほとんどない。

### 読み替えとエラーの使い分け

`container:<id>` で host netns を共有しようとしたときは読み替え、`default_rootless_network_cmd` が不正な値のときはエラー。この差は **「ユーザの意図を満たせるかどうか」** で分かれている。

前者は意図 (そのコンテナと同じネットワークを見たい) が読み替えで満たせる。後者は意図が不明なので、エラーにするしかない。**黙って読み替えてよいのは、結果が意図と一致する場合だけ**という線引きになっている。

## どう活かすか

- **設定には意図を書き、手段は実行時に解決する。** `private` のような抽象的な値を許すと、1 つの設定ファイルが複数の環境で使える。「設定に環境名が出てきたら設計を疑う」の目安になる。
- **削除した機能名は case に残して、移行先を案内する。** 削除のコストのうち大きいのは、ユーザの混乱だ。専用のエラーメッセージ 1 行で大半が解消する。
- **`default:` が「名前」になる設計では、予約語の追加が破壊的になる。** モード名とユーザ定義名が同じ名前空間にあると、後から足す名前が既存と衝突しうる。プレフィックス (`ns:`、`container:`) を使う設計と混在していることに注意する。
- **読み替えてよいのは、結果が意図と一致するときだけ。** 「エラーを避けるために勝手に別の動作をする」のは危険だが、意味的に同じなら親切になる。この線引きを意識して分岐を書く。
