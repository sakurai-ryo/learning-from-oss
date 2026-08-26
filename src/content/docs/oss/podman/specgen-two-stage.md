---
title: "「入力の解析」「意図の表現」「実行」を分け、意図の表現をシリアライズ可能にして CLI・REST・互換 API・YAML を 1 本の実行段に合流させる"
description: "pkg/specgen.SpecGenerator は JSON 化可能で libpod に依存しない「コンテナを作る意図」の型で、そのまま REST API のリクエストスキーマになる。CLI 引数を写す FillOutSpecGen が第 1 段、libpod を持つ側でイメージ設定とデフォルトをマージし、検証して OCI spec と libpod オプションに変換する generate パッケージが第 2 段。ローカル CLI、REST ハンドラ、kube play の 3 箇所が同じ 3 関数を呼ぶ。検証はデフォルト決定の後、実行側でだけ走る。"
sidebar:
  order: 12
---

## 何を学んだか

### どんな状況の話か

[前のページ](../abi-tunnel-engine/)で、`ContainerEngine.ContainerCreate` の引数が JSON 化可能だから tunnel 実装が 10 行で済む、と書いた。その型 `specgen.SpecGenerator` がこのページの主題だ。

コンテナを作る入口は多い。`podman run` の 200 個近いフラグ、Docker 互換 API の JSON、Podman ネイティブ API の JSON、`podman kube play` の Kubernetes YAML、`podman container clone` の既存コンテナ、`podman pod create` の infra コンテナ。これらをそれぞれ libpod の `NewContainer` に繋ぐと、デフォルト値の決定やイメージ設定のマージが入口ごとに散らばる。実際、Podman v1 の `pkg/spec` はそうなっていた。

### Podman の答え

1. **「意図」を表す型を 1 つ置き、シリアライズ可能にする。** `SpecGenerator` は 7 つの設定グループ (基本、ストレージ、セキュリティ、cgroup、ネットワーク、リソース、ヘルスチェック) を埋め込んだ構造体で、`swagger:model` によりそのまま REST API のリクエストスキーマになる。libpod にも libimage にも依存しない。
2. **第 1 段はクライアント側で「解析済み CLI → 意図」の写像だけをする。** `specgenutil.FillOutSpecGen` は `entities.ContainerCreateOptions` (フラグの解析結果) を `SpecGenerator` に写す。build tag が無いので remote クライアントでも動く。
3. **第 2 段は libpod のある側で、補完 → 検証 → 変換 → 実行をする。** `generate.CompleteSpec` がイメージの設定と containers.conf をマージし、`generate.MakeContainer` が namespace などのデフォルトを決めてから `Validate()` を呼び、OCI spec と `libpod.CtrCreateOption` を作り、`generate.ExecuteCreate` が libpod を呼ぶ。`pkg/specgen/generate` は `//go:build !remote` で、remote ビルドには含まれない。
4. **段の境界 = プロセスの境界。** ローカルでは 2 段が同じプロセス、リモートでは第 1 段がクライアント、`SpecGenerator` を JSON で `POST /libpod/containers/create` に送り、サーバのハンドラが abi と同じ 3 関数を呼ぶ。Docker 互換 API は Docker の JSON を「解析済み CLI」に翻訳して第 1 段から入り、kube play は YAML を直接 `SpecGenerator` に変換して第 2 段から入る。
5. **検証はデフォルト決定の後、実行側で。** `Validate()` を呼ぶのは `MakeContainer` と `MakePod` の 2 箇所だけ。クライアントは環境 (rootless か、cgroup の状態、サーバの containers.conf) を知らないので、そこで検証しても正しくならない。
6. **未指定と false を区別するフィールドはポインタ。送れないものは `json:"-"`。** `*bool` で「JSON に無かった」を表し、ファイルディスクリプタや pid ファイルのようにプロセス境界を越えられないものは、型定義に `json:"-"` を刻んで「remote では効かない」を構造体自身に書く。

## ソースコードのどこか

### 意図の型

[`pkg/specgen/specgen.go#L625-L639`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen.go#L625-L639)。

```go title="pkg/specgen/specgen.go"
// SpecGenerator creates an OCI spec and Libpod configuration options to create
// a container based on the given configuration.
// swagger:model SpecGenerator
type SpecGenerator struct {
	ContainerBasicConfig
	ContainerStorageConfig
	ContainerSecurityConfig
	ContainerCgroupConfig
	ContainerNetworkConfig
	ContainerResourceConfig
	ContainerHealthCheckConfig

	//nolint:nolintlint,unused // "unused" complains when remote build tag is used, "nolintlint" complains otherwise.
	cacheLibImage
}
```

埋め込みなので JSON はフラットになり、`"name"`, `"image"`, `"netns"` が同じ階層に並ぶ。フィールドのコメントには Optional / Mandatory / Conflicts が書かれている ([`#L142-L156`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen.go#L142-L156))。

```go title="pkg/specgen/specgen.go"
	// PidNS is the container's PID namespace.
	// It defaults to private.
	// Mandatory.
	PidNS Namespace `json:"pidns"`
	// UtsNS is the container's UTS namespace.
	// It defaults to private.
	// Must be set to Private to set Hostname.
	// Mandatory.
	UtsNS Namespace `json:"utsns"`
	// Hostname is the container's hostname. If not set, the hostname will
	// not be modified (if UtsNS is not private) or will be set to the
	// container ID (if UtsNS is private).
	// Conflicts with UtsNS if UtsNS is not set to private.
	// Optional.
	Hostname string `json:"hostname,omitempty"`
```

"Mandatory" と書かれていても、実際には `MakeContainer` がゼロ値を既定に埋めるので、`Image=` だけの POST でも 201 が返る ([`test/apiv2/20-containers.at#L199-L210`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/apiv2/20-containers.at#L199-L210))。

未指定の表現 ([`#L57-L73`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen.go#L57-L73))。

```go title="pkg/specgen/specgen.go"
	// EnvHost indicates that the host environment should be added to container
	// Optional.
	EnvHost *bool `json:"env_host,omitempty"`
	/* ... */
	// Terminal is whether the container will create a PTY.
	// Optional.
	Terminal *bool `json:"terminal,omitempty"`
	// Stdin is whether the container will keep its STDIN open.
	// Optional.
	Stdin *bool `json:"stdin,omitempty"`
```

送れないもの ([`#L172-L189`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen.go#L172-L189), [`#L199-L202`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen.go#L199-L202))。

```go title="pkg/specgen/specgen.go"
	// PreserveFDs is a number of additional file descriptors (in addition
	// to 0, 1, 2) that will be passed to the executed process. The total FDs
	// passed will be 3 + PreserveFDs.
	// set tags as `json:"-"` for not supported remote
	// Optional.
	PreserveFDs uint `json:"-"`
	/* ... */
	// PidFile is the file that saves container's PID.
	// Not supported for remote clients, so not serialized in specgen JSON.
	// Optional.
	PidFile string `json:"-"`
```

ポインタにしなかったフィールドの代償も残っている。ヘルスチェックのログ設定は非ポインタなので、コンストラクタ `NewSpecGenerator` ([`#L671-L700`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen.go#L671-L700)) とサーバのハンドラの両方で既定値を入れる必要があり、[`#L613`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen.go#L613) 以降に `TODO (6.0): In next major release convert it to pointer and use omitempty` が 3 つ並んでいる。

### 依存を軽く保つ

[`pkg/specgen/specgen_remote.go#L1-L9`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/specgen_remote.go#L1-L9)。

```go title="pkg/specgen/specgen_remote.go"
//go:build remote

package specgen

// Empty stub we do not use any libimage on the remote client,
// this drastically decreases binary size for the remote client.
//
//nolint:unused // this is needed for the local client
type cacheLibImage struct{}
```

`pkg/specgen` の中で build tag があるのはこれと `specgen_local.go` だけ。libpod と libimage への依存はすべて `pkg/specgen/generate` ([`container.go#L1`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container.go#L1) は `//go:build !remote && (linux || freebsd)`) に閉じ込めてある。

### 第 1 段: 解析済み CLI を意図に写す

[`cmd/podman/containers/create.go#L137-L165`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/containers/create.go#L137-L165)。

```go title="cmd/podman/containers/create.go"
	s := specgen.NewSpecGenerator(imageName, cliVals.RootFS)
	if err := specgenutil.FillOutSpecGen(s, &cliVals, args); err != nil {
		return err
	}
	s.RawImageName = rawImageName

	// Include the command used to create the container.
	s.ContainerCreateCommand = os.Args
```

`FillOutSpecGen` ([`pkg/specgenutil/specgen.go#L324-L343`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgenutil/specgen.go#L324-L343)) は 650 行の写像で、冒頭の TODO が設計上の自覚を示している。

```go title="pkg/specgenutil/specgen.go"
func FillOutSpecGen(s *specgen.SpecGenerator, c *entities.ContainerCreateOptions, args []string) error {
	rtc, err := config.Default()
	if err != nil {
		return err
	}

	// TODO: This needs to move into pkg/specgen/generate so we aren't using containers.conf on the client.
	if rtc.Containers.EnableLabeledUsers {
```

クライアント側の検証は [`pkg/specgenutil/createparse.go#L12-L23`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgenutil/createparse.go#L12-L23) のフラグ間の相互排他だけだ。

### 第 2 段: 補完、検証、変換、実行

`CompleteSpec` ([`pkg/specgen/generate/container.go#L138-L163`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container.go#L138-L163))。

```go title="pkg/specgen/generate/container.go"
// Fill any missing parts of the spec generator (e.g. from the image).
// Returns a set of warnings or any fatal error that occurred.
func CompleteSpec(ctx context.Context, r *libpod.Runtime, s *specgen.SpecGenerator) ([]string, error) {
	// Only add image configuration if we have an image
	newImage, _, inspectData, err := getImageFromSpec(ctx, r, s)
	if err != nil {
		return nil, err
	}
	if inspectData != nil {
		if s.HealthConfig == nil || len(s.HealthConfig.Test) == 0 {
			if err := applyHealthCheckOverrides(s, inspectData.HealthCheck); err != nil {
				return nil, err
			}
		}
```

ラベルは継承するがアノテーションは継承しない ([`#L243-L261`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container.go#L243-L261))。

```go title="pkg/specgen/generate/container.go"
		// labels from the image that don't already exist
		if len(labels) > 0 && s.Labels == nil {
			s.Labels = make(map[string]string)
		}
		for k, v := range labels {
			if _, exists := s.Labels[k]; !exists {
				s.Labels[k] = v
			}
		}

		// Do NOT include image annotations - these can have security
		// implications, we don't want untrusted images setting them.
```

リソース制限は「エラーにせず削って警告」 ([`pkg/specgen/generate/validate_linux.go#L48-L51`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/validate_linux.go#L48-L51))。

```go title="pkg/specgen/generate/validate_linux.go"
		if errMemoryMax == nil && errMemorySwapMax != nil {
			warnings = append(warnings, "Your kernel does not support swap limit capabilities or the cgroup is not mounted. Memory limited without swap.")
			s.ResourceLimits.Memory.Swap = nil
		}
```

警告は `[]string` で返り、abi は stderr に、REST ハンドラは `Warnings` として JSON に載せ、tunnel が stderr に出す。警告の「生成」はサーバ、「表示」はクライアントの責務、という分担だ。

`MakeContainer` ([`pkg/specgen/generate/container_create.go#L30-L33`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container_create.go#L30-L33)) は namespace のデフォルトを決めてから検証する ([`#L199-L222`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container_create.go#L199-L222))。

```go title="pkg/specgen/generate/container_create.go"
	// Set defaults if network info is not provided
	if s.NetNS.IsPrivate() || s.NetNS.IsDefault() {
		if rootless.IsRootless() {
			// when we are rootless we default to default_rootless_network_cmd from containers.conf
			conf, err := rt.GetConfigNoCopy()
			/* ... */
			switch conf.Network.DefaultRootlessNetworkCmd {
			case pasta.BinaryName, "":
				s.NetNS.NSMode = specgen.Pasta
			/* ... */
			}
		} else {
			// as root default to bridge
			s.NetNS.NSMode = specgen.Bridge
		}
	}

	if err := s.Validate(); err != nil {
		return nil, nil, nil, fmt.Errorf("invalid config provided: %w", err)
	}
```

`rootless.IsRootless()` も `rt.GetConfigNoCopy()` もサーバの環境だ。クライアントでは決められない。戻り値は `(*specs.Spec, *specgen.SpecGenerator, []libpod.CtrCreateOption, error)` ([`#L316`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container_create.go#L316)) で、OCI spec の生成は `SpecGenToOCI` ([`pkg/specgen/generate/oci_linux.go#L102-L118`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/oci_linux.go#L102-L118)) が OS ごとのファイルで行う。

`ExecuteCreate` ([`#L319-L326`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container_create.go#L319-L326)) は libpod を呼ぶだけ。

```go title="pkg/specgen/generate/container_create.go"
func ExecuteCreate(ctx context.Context, rt *libpod.Runtime, runtimeSpec *specs.Spec, s *specgen.SpecGenerator, infra bool, options ...libpod.CtrCreateOption) (*libpod.Container, error) {
	ctr, err := rt.NewContainer(ctx, runtimeSpec, s, infra, options...)
	if err != nil {
		return ctr, err
	}

	return ctr, rt.PrepareVolumeOnCreateContainer(ctx, ctr)
}
```

libpod の `NewContainer` ([`libpod/runtime_ctr.go#L47`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_ctr.go#L47)) は OCI spec と補完済みの `SpecGenerator` の両方を受ける。`podman generate spec` ([`pkg/domain/infra/abi/generate.go#L51-L73`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/generate.go#L51-L73)) が既存コンテナから `SpecGenerator` を復元できるのはこのためで、その出力を `POST /libpod/containers/create` に戻す往復テストが [`test/apiv2/20-containers.at#L795-L808`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/apiv2/20-containers.at#L795-L808) にある。

### 同じ 3 関数を呼ぶ 3 箇所

REST ハンドラ ([`pkg/api/handlers/libpod/containers_create.go#L32-L75`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/handlers/libpod/containers_create.go#L32-L75))。

```go title="pkg/api/handlers/libpod/containers_create.go"
	// copy vars here and not leak config pointers into specgen
	noHosts := conf.Containers.NoHosts
	privileged := conf.Containers.Privileged

	// we have to set the default before we decode to make sure the correct default is set when the field is unset
	wire := specGeneratorWire{
		SpecGenerator: specgen.SpecGenerator{
			ContainerNetworkConfig: specgen.ContainerNetworkConfig{
				UseImageHosts: &noHosts,
			},
			ContainerSecurityConfig: specgen.ContainerSecurityConfig{
				Umask:      conf.Containers.Umask,
				Privileged: &privileged,
			},
			/* ... */
		},
	}

	if err := utils.ReadJSONFromBody(r, &wire); err != nil {
```

デコードの **前** に既定値を入れておけば、リクエストに無いフィールドだけが既定値になる。そして [`#L95-L121`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/handlers/libpod/containers_create.go#L95-L121) で abi と同じ順に呼ぶ。

```go title="pkg/api/handlers/libpod/containers_create.go"
	warn, err := generate.CompleteSpec(r.Context(), runtime, &sg)
	/* ... */
	rtSpec, spec, opts, err := generate.MakeContainer(r.Context(), runtime, &sg, false, nil)
	/* ... */
	ctr, err := generate.ExecuteCreate(r.Context(), runtime, rtSpec, spec, false, opts...)
	/* ... */
	response := entities.ContainerCreateResponse{ID: ctr.ID(), Warnings: warn}
	utils.WriteJSON(w, http.StatusCreated, response)
```

`specGeneratorWire` ([`#L22-L30`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/handlers/libpod/containers_create.go#L22-L30)) は、`uint64` のフィールドに「無制限」を表す -1 が来るとデコードできない問題 (issue #24886) への回避策で、内部型をそのまま公開スキーマにした限界が現れている箇所だ。

kube play ([`pkg/domain/infra/abi/play.go#L1005-L1037`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/play.go#L1005-L1037)) は YAML を `kube.ToSpecGen` で `SpecGenerator` に変換し、同じ 3 関数を呼ぶ。`ToSpecGen` ([`pkg/specgen/generate/kube/kube.go#L202-L205`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/kube/kube.go#L202-L205)) も `//go:build !remote` なので、リモートでは YAML をサーバに送り、サーバ側で変換する。

3 関数の呼び出し元は `abi/containers.go`、`abi/play.go`、`handlers/libpod/containers_create.go` の 3 ファイルに閉じている。

### 境界を越える前のパス変換

[`pkg/specgen/winpath.go#L23-L59`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/winpath.go#L23-L59)。

```go title="pkg/specgen/winpath.go"
// Converts a Windows path to a WSL guest path if local env is a WSL linux guest or this is a Windows client.
func ConvertWinMountPath(path string) (string, error) {
	if !shouldResolveWinPaths() {
		return path, nil
	}
	/* ... */
	// Drive installed via wsl --mount
	switch {
	case strings.HasPrefix(path, `\\.\`):
		path = "/mnt/wsl/" + path[4:]
	case len(path) > 1 && path[1] == ':':
		path = "/mnt/" + strings.ToLower(path[0:1]) + path[2:]
	default:
		return path, errors.New("unsupported UNC path")
	}

	return strings.ReplaceAll(path, `\`, "/"), nil
}
```

呼び出し元は `pkg/specgenutil/volumes.go` ([`#L142-L153`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgenutil/volumes.go#L142-L153)) や `pkg/bindings` で、すべてクライアント側だ。Windows のパスは JSON に載せる前に、Windows を知っている側で変換しなければならない。`pkg/specgen` に置かれているのは、クライアント (`specgenutil`) とパース (`specgen/volumes.go`) の両方から使え、かつ remote ビルドに含まれるパッケージがここだからだ。

## なぜそうなっているか

- **v1 の `pkg/spec` が CLI に密結合していたから。** `pkg/specgen` の最初のコミット 4567f398 (2019-11-14, Matthew Heon) "Initial implementation of a spec generator package": "The current Libpod pkg/spec has become a victim of the better part of three years of development that tied it extremely closely to the current Podman CLI. Defaults are spread across multiple places, there is no easy way to produce a CreateConfig that will actually produce a valid container, and the logic for generating configs has sprawled across at least three packages." そして "The CreateConfig will still exist, but will effectively turn into a parsed CLI. This will be compiled down into the new SpecGenerator struct, which will generate the OCI spec and Libpod create options." — 「解析済み CLI → SpecGenerator → OCI spec + libpod オプション」の 3 層は最初から意図されていた。
- **先に REST API に繋ぎ、CLI は後から。** コミット c1a53467 (2020-02-04, Brent Baude): "the new approach would be to have a specification that is detached from the podman cli ... this theoretically is the beginning of a long-needed refactor involving how we get from the cli -> libpod | apiv2 -> libpod with code re-use and less duplication. the intent is to build the apiv2 container creation based on this approach only. wiring to the podman cli will happen after the fact." 2 経路の重複を無くすことが目的で、API 側を先に作った。
- **`podman generate spec` の用途は REST API への入力。** [`docs/source/markdown/podman-generate-spec.1.md#L9-L12`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-generate-spec.1.md#L9-L12): "This JSON can then be used as input for the Podman API, specifically for Podman container and pod creation. Specgen is Podman's internal structure for formulating new container-related entities." `podman create --from-spec` のような CLI 側の入口は存在しない。
- **依存を軽く保つ原則と、それを破った自覚。** コミット 3acee29c (2023-09-12, Paul Holzinger): "Of course it would be a bit cleaner to never leak libimage into pkg/specgen and only have it in pkg/specgen/generate. But this would be much more involved with big chnages so I went with the easy and quick way instead." `specgen_local.go` / `specgen_remote.go` はその妥協の形だ。

## どう活かすか

- 「入力の解析」「意図の表現」「実行」を別パッケージに分け、意図の表現をシリアライズ可能にする。意図の型が API スキーマと CLI の中間表現を兼ねると、CLI、REST、互換 API、YAML 変換、既存リソースからの復元がすべて同じ実行段に合流する。
- デフォルト決定と検証は実行側で、しかもデフォルト決定の後に行う。クライアントは環境を知らないので、そこで検証しても正しくならない。環境依存の制約 (cgroup のコントローラなど) は「削って警告」で返し、警告の表示はクライアントに任せる。
- 未指定と false を区別したいフィールドはポインタにする。非ポインタにすると、コンストラクタとサーバハンドラの両方で既定値を入れることになり、後から直すのはメジャーバージョンの変更になる。
- 送れないもの (fd、ローカルパス) は `json:"-"` で型定義に刻む。ドキュメントではなく型に契約を置く。
- 環境に依存する前処理 (パス変換) は「境界を越える前」に、越える側のパッケージで行う。そのパッケージは両方のビルドに含まれる必要がある。
- 重い依存は実行段のパッケージに閉じ込め、意図の型のパッケージは軽く保つ。守れない場合は build tag で切り、「本来はこうあるべき」をコミットメッセージに残す。
- 取り込むべきでない条件: 単一プロセスで RPC も互換 API も無いなら、中間表現の維持コスト (フィールド追加のたびに CLI 型、中間型、実行型の 3 箇所を触る) が上回る。Podman では `FillOutSpecGen` が 650 行、`SpecGenerator` が数百フィールドになっている。中間表現をそのまま公開 API スキーマにすると内部都合の型がワイヤに漏れる (`specGeneratorWire`) ので、公開するなら最初から wire 型を分けるか、後でラッパを入れる覚悟が要る。検証を実行側に寄せると、リモートではバリデーションエラーが HTTP 500 で返ることがあり、ハンドラ側でのエラー分類が要る。
