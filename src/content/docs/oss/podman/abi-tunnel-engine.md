---
title: "CLI はインターフェースだけに依存させ、in-process 実装と REST 越し実装をビルドタグで物理的に切り替える"
description: "cmd/podman は ContainerEngine / ImageEngine という 2 つの巨大なインターフェースと、その Options / Report 型にしか依存しない。実装は libpod を同一プロセスで呼ぶ abi と、HTTP クライアント経由の tunnel の 2 つ。同じ main パッケージから -tags remote の有無だけで podman と podman-remote を作り、remote ビルドからは libpod も API サーバも import 依存の時点で消える。サーバ側のハンドラは abi と同じ関数を呼ぶので、ローカルとリモートの意味論は「同じコードが別プロセスで走る」形で揃う。"
sidebar:
  order: 11
---

## 何を学んだか

### どんな状況の話か

Podman は Linux では libpod を直接呼んで動くが、macOS や Windows では VM の中の Podman に REST API で話しかけるクライアントとして動く。Linux でも `podman --remote` で同じことができる。ユーザーから見た CLI は同じでなければならず、しかも remote 用のバイナリには libpod (cgo、Linux 専用の依存が多い) を含めたくない。

素朴にやると `if remote { ... } else { ... }` が CLI のあちこちに散る。あるいは remote 版だけ別のコードベースになる。

### Podman の答え

1. **CLI は `entities.ContainerEngine` と `entities.ImageEngine` にだけ依存する。** メソッドはほぼ CLI のサブコマンドと 1 対 1 (`ContainerCreate`, `PodCreate`, `VolumeRm`...) で、引数は `XxxOptions`、戻り値は `*XxxReport`。`cmd/podman/README.md` は "Do not pull from libpod directly use the domain objects and types" と規約を明文化している。
2. **実装は `infra/abi` (in-process) と `infra/tunnel` (REST) の 2 つ。** abi は `*libpod.Runtime` を持ち、tunnel は接続を埋め込んだ `context.Context` だけを持つ。
3. **切り替えはビルド時と実行時の 2 段。** `//go:build remote` で abi・libpod・API サーバ・OCI 変換がリンクから消える。実行時は GOOS、`--remote` / `CONTAINER_HOST`、containers.conf の `remote` から `EngineMode` を決める。非 remote ビルドでも tunnel は使えるが、remote ビルドで abi は使えない。
4. **モード判定は cobra の解析より前に、使い捨ての FlagSet で先読みする。** `init()` でコマンドがフラグを定義する時点でモードが要るからだ。
5. **サーバは「もう 1 つのクライアント」ではなく abi そのものを呼ぶ。** `podman system service` のハンドラは abi と同じ `generate.CompleteSpec` → `MakeContainer` → `ExecuteCreate` を呼ぶ。Docker 互換 API は Docker の JSON を CLI の解析結果と同じ型に翻訳して、同じ経路に合流する。
6. **非対応機能は 4 つの粒度で、できるだけ外側で落とす。** コマンド単位 (annotation で Hidden にしてエラーを返す `RunE` に差し替え)、フラグ単位 (`IsRemote()` で `MarkHidden`)、メソッド単位 (tunnel 実装が "not supported on remote clients" を返す)、フィールド単位 (`json:"-"` とコメント契約)。

## ソースコードのどこか

### 2 つの実装

[`pkg/domain/infra/abi/runtime.go#L11-L25`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/runtime.go#L11-L25) と [`pkg/domain/infra/tunnel/runtime.go#L14-L28`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/tunnel/runtime.go#L14-L28)。

```go title="pkg/domain/infra/abi/runtime.go"
// Container-related runtime linked against libpod library
type ContainerEngine struct {
	Libpod *libpod.Runtime
}
```

```go title="pkg/domain/infra/tunnel/runtime.go"
// Container-related runtime using an ssh-tunnel to utilize Podman service
type ContainerEngine struct {
	ClientCtx context.Context
}
```

tunnel 側の状態は `ClientCtx` だけだ。`pkg/bindings` は `context.Context` の value に接続を埋め、各エンドポイント関数に渡す設計になっている。

同じメソッドの 2 実装を並べる。abi の `ContainerCreate` ([`pkg/domain/infra/abi/containers.go#L840-L858`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/containers.go#L840-L858))。

```go title="pkg/domain/infra/abi/containers.go"
func (ic *ContainerEngine) ContainerCreate(ctx context.Context, s *specgen.SpecGenerator) (*entities.ContainerCreateReport, error) {
	warn, err := generate.CompleteSpec(ctx, ic.Libpod, s)
	if err != nil {
		return nil, err
	}
	// Print warnings
	for _, w := range warn {
		fmt.Fprintf(os.Stderr, "%s\n", w)
	}
	rtSpec, spec, opts, err := generate.MakeContainer(context.Background(), ic.Libpod, s, false, nil)
	if err != nil {
		return nil, err
	}
	ctr, err := generate.ExecuteCreate(ctx, ic.Libpod, rtSpec, spec, false, opts...)
	if err != nil {
		return nil, err
	}
	return &entities.ContainerCreateReport{Id: ctr.ID()}, nil
}
```

tunnel の同名メソッド ([`pkg/domain/infra/tunnel/containers.go#L539-L548`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/tunnel/containers.go#L539-L548))。

```go title="pkg/domain/infra/tunnel/containers.go"
func (ic *ContainerEngine) ContainerCreate(_ context.Context, s *specgen.SpecGenerator) (*entities.ContainerCreateReport, error) {
	response, err := containers.CreateWithSpec(ic.ClientCtx, s, nil)
	if err != nil {
		return nil, err
	}
	for _, w := range response.Warnings {
		fmt.Fprintf(os.Stderr, "%s\n", w)
	}
	return &entities.ContainerCreateReport{Id: response.ID}, nil
}
```

引数の `*specgen.SpecGenerator` が JSON 化可能なので、tunnel 側は 10 行で済む。この型の設計は[次のページ](../specgen-two-stage/)で扱う。

### ファクトリはビルドタグで 2 つ

[`pkg/domain/infra/runtime_abi.go#L1-L24`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/runtime_abi.go#L1-L24)。

```go title="pkg/domain/infra/runtime_abi.go"
//go:build !remote && (linux || freebsd)

package infra
/* ... */
// NewContainerEngine factory provides a libpod runtime for container-related operations
func NewContainerEngine(facts *entities.PodmanConfig) (entities.ContainerEngine, error) {
	switch facts.EngineMode {
	case entities.ABIMode:
		r, err := NewLibpodRuntime(facts.FlagSet, facts)
		return r, err
	case entities.TunnelMode:
		ctx, err := newConnectionWithoutLock(context.Background(), facts)
		return &tunnel.ContainerEngine{ClientCtx: ctx}, err
	}
	return nil, fmt.Errorf("runtime mode '%v' is not supported", facts.EngineMode)
}
```

[`runtime_tunnel.go#L1-L45`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/runtime_tunnel.go#L1-L45) は `//go:build remote || !(linux || freebsd)` で、`ABIMode` は "direct runtime not supported" を返すだけ。darwin / windows では `remote` タグが無くてもこちらが選ばれる。libpod 自体が `//go:build !remote && (linux || freebsd)` だからだ。

### 実行時のモード決定

[`cmd/podman/registry/config.go#L102-L125`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/registry/config.go#L102-L125)。

```go title="cmd/podman/registry/config.go"
	var mode entities.EngineMode
	switch runtime.GOOS {
	case "darwin", "windows":
		mode = entities.TunnelMode
	case "linux", "freebsd":
		// Some linux clients might only be compiled without ABI
		// support (e.g., podman-remote).
		if abiSupport && !IsRemote() {
			mode = entities.ABIMode
		} else {
			mode = entities.TunnelMode
		}
	/* ... */
	}

	// If EngineMode==Tunnel has not been set on the command line or environment
	// but has been set in containers.conf...
	if mode == entities.ABIMode && defaultConfig.Engine.Remote {
		mode = entities.TunnelMode
	}
```

`abiSupport` はビルドタグで決まる ([`config_abi.go`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/registry/config_abi.go#L1-L7) が `true`、[`config_tunnel.go`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/registry/config_tunnel.go#L1-L7) が `false`)。

`IsRemote()` ([`cmd/podman/registry/remote.go#L21-L57`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/registry/remote.go#L21-L57)) は cobra より前に走る。

```go title="cmd/podman/registry/remote.go"
// IsRemote returns true if podman was built to run remote or --remote flag given on CLI
// Use in init() functions as an initialization check
func IsRemote() bool {
	/* ... */
	remoteFromCLI.sync.Do(func() {
		remote := false
		if _, ok := os.LookupEnv("CONTAINER_HOST"); ok {
			remote = true
		} else if _, ok := os.LookupEnv("CONTAINER_CONNECTION"); ok {
			remote = true
		}
		fs := pflag.NewFlagSet("remote", pflag.ContinueOnError)
		fs.ParseErrorsAllowlist.UnknownFlags = true
		fs.Usage = func() {}
		fs.SetInterspersed(false)
		fs.BoolVarP(&remoteFromCLI.Value, "remote", "r", remote, "")
		/* ... --connection, --context, --host, --url ... */
		_ = fs.Parse(os.Args[parseIndex():])
		// --connection or --url implies --remote
		remoteFromCLI.Value = remoteFromCLI.Value || fs.Changed(connectionFlagName) || fs.Changed(urlFlagName) || fs.Changed(hostFlagName) || fs.Changed(contextFlagName)
	})
	return podmanOptions.EngineMode == entities.TunnelMode || remoteFromCLI.Value
}
```

使い捨ての `FlagSet` で `os.Args` を先読みする。`UnknownFlags = true` で他のフラグを無視し、`SetInterspersed(false)` でサブコマンド以降を見ない。各コマンドの `init()` で "remote ならこのフラグを隠す" ([`cmd/podman/common/create.go#L876-L879`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/common/create.go#L876-L879) のように説明文を変えることもある) をやるには、cobra が解析を始める前にモードが要る。

### 非対応の 4 段階

コマンド単位 ([`cmd/podman/main.go#L79-L108`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/main.go#L79-L108))。

```go title="cmd/podman/main.go"
	for _, c := range registry.Commands {
		if supported, found := c.Command.Annotations[registry.EngineMode]; found {
			if cfg.EngineMode.String() != supported {
				/* ... */
				// add error message to the command so the user knows that this command is not supported with local/remote
				c.Command.RunE = func(cmd *cobra.Command, _ []string) error {
					return fmt.Errorf("cannot use command %q with the %s podman client", cmd.CommandPath(), client)
				}
				// turn off flag parsing to make we do not get flag errors
				c.Command.DisableFlagParsing = true

				// mark command as hidden so it is not shown in --help
				c.Command.Hidden = true

				// overwrite persistent pre/post function to skip setup
				c.Command.PersistentPostRunE = validate.NoOp
				c.Command.PersistentPreRunE = validate.NoOp
				addCommand(c)
				continue
			}
		}
```

`registry.EngineMode: registry.ABIMode` を付けているのは `system service` / `unshare` / `reset` / `migrate` / `renumber`、`container mount` / `unmount` / `cleanup`、`volume mount` など 19 箇所。コマンドは残すがヘルプから隠し、実行すると理由付きのエラーになる。

メソッド単位 ([`pkg/domain/infra/tunnel/system.go#L35-L53`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/tunnel/system.go#L35-L53))。

```go title="pkg/domain/infra/tunnel/system.go"
func (ic *ContainerEngine) Migrate(_ context.Context, _ entities.SystemMigrateOptions) error {
	return errors.New("runtime migration is not supported on remote clients")
}

func (ic *ContainerEngine) Renumber(_ context.Context) error {
	return errors.New("lock renumbering is not supported on remote clients")
}
```

`SetupRootless` ([`#L16-L18`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/tunnel/system.go#L16-L18)) だけは panic する。`persistentPreRunE` の `!registry.IsRemote()` ガードが唯一の防波堤で、呼ばれたらバグという設計だ。

フィールド単位は Options 型のコメントに "Ignored for remote calls." / "Rejected for remote calls." と書く形で、コンパイル時には守られない。代わりに `test/e2e` が `podman-remote` でも走る (`make remoteintegration`) ことで担保している。

### サーバは abi を呼ぶ

`podman system service` ([`cmd/podman/system/service_abi.go#L23-L32`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/system/service_abi.go#L23-L32)) は CLI と同じ `infra.GetRuntime` で `*libpod.Runtime` を作り、[`pkg/api/server/server.go#L107-L113`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/server/server.go#L107-L113) で各リクエストの context に注入する。

```go title="pkg/api/server/server.go"
	server.BaseContext = func(_ net.Listener) context.Context {
		ctx := context.WithValue(context.Background(), types.DecoderKey, handlers.NewAPIDecoder())
		ctx = context.WithValue(ctx, types.CompatDecoderKey, handlers.NewCompatAPIDecoder())
		ctx = context.WithValue(ctx, types.RuntimeKey, runtime)
		ctx = context.WithValue(ctx, types.IdleTrackerKey, tracker)
		return ctx
	}
```

Docker 互換ハンドラ ([`pkg/api/handlers/compat/containers_create.go#L96-L128`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/handlers/compat/containers_create.go#L96-L128)) は翻訳層だ。

```go title="pkg/api/handlers/compat/containers_create.go"
	// Take body structure and convert to cliopts
	cliOpts, args, err := cliOpts(body, rtc)
	/* ... */
	sg := specgen.NewSpecGenerator(imgNameOrID, cliOpts.RootFS)
	if err := specgenutil.FillOutSpecGen(sg, cliOpts, args); err != nil {
		utils.Error(w, http.StatusInternalServerError, fmt.Errorf("fill out specgen: %w", err))
		return
	}
	// moby always create the working directory
	localTrue := true
	sg.CreateWorkingDir = &localTrue
	// moby doesn't inherit /etc/hosts from host, but only overwrite if not set in containers.conf
	if rtc.Containers.BaseHostsFile == "" {
		sg.BaseHostsFile = "none"
	}

	ic := abi.ContainerEngine{Libpod: runtime}
	report, err := ic.ContainerCreate(r.Context(), sg)
```

Docker の JSON を `entities.ContainerCreateOptions` (= Podman CLI の解析結果と同じ型) に変換し、CLI と同じ `FillOutSpecGen` を通し、`abi.ContainerEngine` を呼ぶ。Docker との差分 (作業ディレクトリを作る、`/etc/hosts` を継承しない) は合流後に上書きする。同じルータに `/containers/create` (compat) と `/libpod/containers/create` (Podman ネイティブ) の 2 系統がある ([`pkg/api/server/register_containers.go#L43-L45`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/server/register_containers.go#L43-L45), [`#L768`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/server/register_containers.go#L768))。

### 同じ main から 2 バイナリ

[`Makefile#L60-L70`](https://github.com/podman-container-tools/podman/blob/v6.1.0/Makefile#L60-L70) と [`#L413-L421`](https://github.com/podman-container-tools/podman/blob/v6.1.0/Makefile#L413-L421)。

```make title="Makefile"
REMOTETAGS ?= remote exclude_graphdriver_btrfs containers_image_openpgp
BUILDTAGS ?= \
	grpcnotrace \
	$(shell hack/apparmor_tag.sh) \
	$(shell hack/btrfs_installed_tag.sh) \
	$(shell hack/sqlite_tag.sh) \
	$(shell hack/systemd_tag.sh) \
	$(shell hack/libsubid_tag.sh) \
	$(if $(filter linux,$(GOOS)), seccomp,)
```

```make title="Makefile"
$(SRCBINDIR)/podman$(BINSFX): $(SOURCES) go.mod go.sum | $(SRCBINDIR)
	/* ... */
	$(GOCMD) build \
		$(BUILDFLAGS) \
		$(GO_LDFLAGS) '$(LDFLAGS_PODMAN)' \
		-tags "${REMOTETAGS}" \
		-o $@ ./cmd/podman
```

`bin/podman` も `bin/podman-remote` も `./cmd/podman` から作る。`remote` タグで何が落ちるかを `go list -deps` で確かめると、remote ビルドの依存には `libpod/define`, `libpod/events`, `libpod/shutdown`, `pkg/bindings/*`, `pkg/domain/infra/tunnel`, `pkg/specgen` だけが残り、`libpod` 本体、`pkg/domain/infra/abi`、`pkg/api/server`、`pkg/api/handlers/{compat,libpod}`、`pkg/specgen/generate` は消える。lint も両タグで回す ([`hack/golangci-lint.sh#L17-L32`](https://github.com/podman-container-tools/podman/blob/v6.1.0/hack/golangci-lint.sh#L17-L32))。

## なぜそうなっているか

- **v2 の CLI 書き直しで最初から用意された構造。** コミット fbe74350 (2020-03-12, Jhon Honce) "V2 podman command" は `pkg/domain/entities`、`infra/abi`、`infra/tunnel`、`runtime_abi.go`、`runtime_tunnel.go` を一括で入れている。当時のディレクトリ名は `cmd/podmanV2` で、v1 の CLI と並行開発していた。後付けの抽象ではない。
- **[`docs/CODE_STRUCTURE.md#L51-L66`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/CODE_STRUCTURE.md#L51-L66) が役割を短く言い切っている。** "pkg/domain: 'glue' code between cli and the actual operations performed" "entities: defines two interfaces (ContainerEngine, ImageEngine) that more or less have a function for each cli command defined" "tunnel: Implements the two interfaces for the remote mode (podman-remote) which just maps each operations to the bindings code" "abi: Implements the two interfaces for the local mode (podman) that calls then directly into the core parts of libpod/".
- **第 3 のインターフェースは消された。** かつて `SystemEngine` があったが、コミット b94be90a (2024-01-11, Matt Heon) "Remove Libpod special-init conditions" が "every command in SystemEngine is actually a ContainerEngine command. Reset, Renumber, Migrate - they all need a full Libpod and access to all containers. There's no point to a separate engine if it just wraps Libpod in the exact same way as ContainerEngine" と消している。`abi/runtime.go` に `SystemEngine` の構造体だけが残骸として残っている。
- **バイナリサイズは継続的な動機。** コミット 12740088 (2021-03-29) "Shrink the size of podman-remote" は bindings が `entities` 全体を引かないよう `entities/types` を切り出した。コミット 3acee29c (2023-09-12) は `pkg/specgen` から libimage を外して "the podman-remote binary size decreases from 44788 KB to 39424 KB" と書いている。
- **tunnel 側の乖離リスクは自覚されている。** [`pkg/domain/infra/tunnel/helpers.go#L51-L57`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/tunnel/helpers.go#L51-L57): "it would be nicer if the lists endpoint would support batch name/ID lookups as we could use the libpod backend for looking up containers rather than risking diverging the local and remote lookups." ローカルは libpod の名前解決をそのまま使えるが、tunnel は List + Inspect で自前解決している。

## どう活かすか

- 「ユーザー操作 1 つ = インターフェースのメソッド 1 つ」の粒度で境界を切り、入力を Options、出力を Report にして、どちらも transport 非依存 (JSON 化可能) に保つ。in-process 実装と RPC 実装を同じシグネチャで書けるかどうかが、境界設計のテストになる。
- ビルドタグ (またはそれに相当する仕組み) でコードパスを物理的に外す。「remote では使わないはずのコード」を import 依存の時点で不可能にすれば、`go list -deps` で検証できる。lint とテストは両方の構成で回す。
- モード決定は「早く、一度だけ」。フレームワークのライフサイクルより前に必要なら、使い捨てのパーサで先読みして `sync.Once` で固定する。
- 非対応機能は、最も外側で早期に落とす。コマンド単位 > フラグ単位 > メソッド単位 > フィールド単位の順で、外側で落とせるものを内側に持ち込まない。
- サーバは「もう 1 つのクライアント」ではなく、ローカル実装そのものを呼ぶ。互換 API は既存の入力型に翻訳して合流させ、分岐を増やさない。
- 取り込むべきでない条件: リモート実行の要件が本当に無いなら、100 メソッド超のインターフェース (`//nolint:interfacebloat` が要るサイズ) は純粋なコストになる。Podman はこれを「CLI コマンドと 1 対 1」と割り切っているが、テストダブルには向かず、実際 abi と tunnel 以外の実装は存在しない。非対応フラグが「コメント契約」なので型では守られない点も、小さなプロジェクトでは Options 型をモードごとに分けた方が安全なことがある。
