---
title: "中核が空のデーモン — すべてがプラグイン"
description: "containerd の main はプラグインを順に初期化して、サーバプラグインを start するだけだ。content store も snapshotter も gRPC サービスも、同じ Registration 構造体で登録され、同じ InitContext を受け取る。プラグインの初期化失敗はデーモンを止めず、失敗したという事実が API から見えるところに残る。"
group: "containerd のかたち"
sidebar:
  order: 11
---

## 何を学んだか

### デーモンがやることは 3 つだけ

`containerd` プロセスの起動処理を削ぎ落とすと、次の 3 つしか残らない。

1. 設定を読み、プラグインの一覧を依存順に並べる
2. 順に初期化し、結果 (インスタンスまたはエラー) を集合に入れる
3. `ServerPlugin` 型のものを `Start()` する

content store も、bbolt のメタデータも、gRPC サービスも、CRI も、すべて 2 番目のループの中で作られる。**containerd 固有の初期化コードはほとんど存在しない**。

### 登録は構造体 1 つ

プラグインを書く側が用意するのは `plugin.Registration` だけだ。

```go
registry.Register(&plugin.Registration{
	Type:     plugins.SnapshotPlugin,      // 何の役割か
	ID:       "overlayfs",                 // 同じ型の中での識別子
	Config:   &config{},                   // TOML にマップされる設定
	Requires: []plugin.Type{...},          // 依存する「型」
	InitFn:   func(ic *plugin.InitContext) (any, error) { ... },
	ConfigMigration: ...,                  // 古い設定からの移行
})
```

`init()` の中でこれを呼ぶだけで、パッケージを import した瞬間にプラグインが登録される。有効なプラグインの一覧が `cmd/containerd/builtins/builtins.go` の **import 文の並び** になっているのはこのためだ。

### プラグイン同士は型と ID で見つけ合う

初期化関数には `InitContext` が渡され、そこから他のプラグインを引ける。

- `GetByID(type, id)` — 特定の実装が要るとき (「metadata プラグインの bolt」)
- `GetSingle(type)` — その型のインスタンスが 1 つしかない前提のとき
- `GetByType(type)` — 全部欲しいとき (「登録されている全 snapshotter」)

コンパイル時の依存ではなく **実行時の名前解決** なので、プラグインのパッケージ同士が import し合う必要がない。

### 失敗しても止まらない、が「必須」も指定できる

プラグインの初期化が失敗しても、containerd は起動を続ける。zfs snapshotter が使えない環境なら、そのプラグインだけがエラー状態になって、他は動く。

ただし 3 つの例外がある。

- 設定で `required_plugins` に挙げられたもの
- 初期化中に **readiness を登録した** もの (途中まで進んでしまったので、失敗は許されない)
- `ErrSkipPlugin` を返したもの (これは失敗ではなく「今回は不要」の意思表示)

## ソースコードのどこか

### 初期化ループ

[`cmd/containerd/server/server.go#L161-L232`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd/server/server.go#L161-L232)。

```go title="cmd/containerd/server/server.go"
	for _, p := range loaded {
		id := p.URI()
		log.G(ctx).WithFields(log.Fields{"id": id, "type": p.Type}).Info("loading plugin")
		var mustSucceed atomic.Int32

		initContext := plugin.NewContext(
			ctx,
			initialized,
			map[string]string{
				plugins.PropertyRootDir:      filepath.Join(config.Root, id),
				plugins.PropertyStateDir:     filepath.Join(config.State, id),
				plugins.PropertyGRPCAddress:  grpcAddress,
				plugins.PropertyTTRPCAddress: ttrpcAddress,
			},
		)
		initContext.RegisterReadiness = func() func() {
			mustSucceed.Store(1)
			return s.RegisterReadiness()
		}

		// load the plugin specific configuration if it is provided
		if p.Config != nil {
			pc, err := config.Decode(ctx, id, p.Config)
			if err != nil {
				return nil, err
			}
			initContext.Config = pc
		}
		result := p.Init(initContext)
		if err := initialized.Add(result); err != nil {
			return nil, fmt.Errorf("could not add plugin result to plugin set: %w", err)
		}
```

`initialized` (これまでに初期化されたプラグインの集合) を毎回渡している。つまり **後から初期化されるプラグインだけが、先のものを見られる**。順序がそのまま可視性になる。

エラー処理はこうなっている。

```go title="cmd/containerd/server/server.go"
		instance, err := result.Instance()
		if err != nil {
			if plugin.IsSkipPlugin(err) {
				log.G(ctx).WithFields(log.Fields{"error": err, "id": id, "type": p.Type}).Info("skip loading plugin")
			} else {
				log.G(ctx).WithFields(log.Fields{"error": err, "id": id, "type": p.Type}).Warn("failed to load plugin")
			}
			if _, ok := required[id]; ok {
				return nil, fmt.Errorf("load required plugin %s: %w", id, err)
			}
			// If readiness was registered during initialization, the plugin cannot fail
			if mustSucceed.Load() != 0 {
				return nil, fmt.Errorf("plugin failed after registering readiness %s: %w", id, err)
			}
			continue
		}
```

`ErrSkipPlugin` は Info、それ以外は Warn。ログレベルで **「設定によりロードしない」と「壊れている」を区別している**。運用でログを見るときにこの差は大きい。

`mustSucceed` の扱いが面白い。readiness を登録したプラグインは「準備完了を待つ側」がいることを意味するので、それが失敗すると誰かが永遠に待つことになる。だから失敗を致命的として扱う。

### エラーは捨てずに保持する

[`vendor/github.com/containerd/plugin/context.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/vendor/github.com/containerd/plugin/context.go) の `Plugin` 型。

```go title="vendor/github.com/containerd/plugin/context.go"
// Plugin represents an initialized plugin, used with an init context.
type Plugin struct {
	Registration Registration // registration, as initialized
	Config       interface{}  // config, as initialized
	Meta         Meta

	instance interface{}
	err      error // will be set if there was an error initializing the plugin
}

// Instance returns the instance and any initialization error of the plugin
func (p *Plugin) Instance() (interface{}, error) {
	return p.instance, p.err
}
```

失敗したプラグインも **集合に入る**。インスタンスの代わりにエラーを持ったまま登録される。これによって `ctr plugins ls` が「失敗したプラグインとその理由」を出せる ([introspection: プラグインの生死を API で見せる](../introspection/))。

「起動時のエラーはログにしか残らない」を避け、**API から問い合わせられる状態にしている** のがこの設計の要点だ。

### 解決の 3 つの粒度

[`vendor/github.com/containerd/plugin/context.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/vendor/github.com/containerd/plugin/context.go) の `GetSingle`。

```go title="vendor/github.com/containerd/plugin/context.go"
// GetSingle returns a plugin instance of the given type when only a single instance
// of that type is expected. Throws an ErrPluginNotFound if no plugin is found and
// ErrPluginMultipleInstances when multiple instances are found.
// Since plugins are not ordered, if multiple instances is suported then
// GetByType should be used. If only one is expected, then to switch plugins,
// disable or remove the unused plugins of the same type.
func (i *InitContext) GetSingle(t Type) (interface{}, error) {
```

「複数あったらエラー」という強い態度を取っている。曖昧な状況で適当に 1 つ選ぶより、設定の誤りとして落とす。実装を切り替えたければ **使わないほうを無効化しろ**、と doc コメントで指示している。

`GetByType` と `GetSingle` はどちらも、`ErrSkipPlugin` で飛ばされたものを黙って除外する。

```go title="vendor/github.com/containerd/plugin/context.go"
		i, err := v.Instance()
		if err != nil {
			if IsSkipPlugin(err) {
				continue
			}
			return i, err
		}
```

### プラグインは自分について申告できる

```go title="vendor/github.com/containerd/plugin/context.go"
// Meta contains information gathered from the registration and initialization
// process.
type Meta struct {
	Platforms    []imagespec.Platform // platforms supported by plugin
	Exports      map[string]string    // values exported by plugin
	Capabilities []string             // feature switches for plugin
}
```

初期化の中で「自分が対応するプラットフォーム」「外に見せたい値」「持っている機能」を書き込める。`ctr plugins ls` に出る `PLATFORMS` の列や、snapshotter が root ディレクトリを公開しているのはこの `Exports` だ。

CRI プラグインは `CRIVersion` をここに載せている ([`plugins/cri/runtime/plugin.go#L59-L61`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/cri/runtime/plugin.go#L59-L61))。

```go title="plugins/cri/runtime/plugin.go"
	ic.Meta.Platforms = []imagespec.Platform{platforms.DefaultSpec()}
	ic.Meta.Exports = map[string]string{"CRIVersion": constants.CRIVersion}
```

### 設定はプラグイン ID をキーに配られる

```go title="cmd/containerd/server/server.go"
		// load the plugin specific configuration if it is provided
		if p.Config != nil {
			pc, err := config.Decode(ctx, id, p.Config)
```

`config.toml` の `[plugins."io.containerd.snapshotter.v1.overlayfs"]` セクションが、そのまま `Registration.Config` の型にデコードされる。設定のスキーマ定義が **プラグインの側にある** ので、コアは設定項目を知らない。

新しいプラグインを足しても、設定パーサに手を入れる必要がない。

## なぜそうなっているか

### 内部実装を外部プラグインと同じ扱いにする

[`docs/PLUGINS.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/PLUGINS.md) に理由が書かれている。

```markdown title="docs/PLUGINS.md"
containerd uses plugins internally to ensure that internal implementations are
decoupled, stable, and treated equally with external plugins.
```

「内部実装が外部プラグインと **同等に扱われる** ことを保証するため」。内部だけが使える近道を作らないという宣言だ。

近道があると、外部プラグインの API は徐々に足りなくなる。内部実装も同じ道を通ると決めておけば、拡張点の不足はすぐに自分たちの問題になる。

### 起動を止めない設計は、環境の多様性から来ている

containerd は多様なカーネル・ファイルシステム上で動く。btrfs がない、zfs がない、cgroup v1 しかない — 環境ごとに使えない機能がある。それらを致命的エラーにすると、ほとんどの環境で起動しないデーモンになる。

だから「失敗を状態として持ち、動く部分は動かす」設計になっている。代わりに **失敗が見えなくならないよう** に、introspection API とログの区別で可視性を確保している。

### 型と ID の 2 段構造

プラグインの識別が `Type` + `ID` の 2 段になっているのは、依存を「型」だけで宣言できるようにするためだ。

- 依存の宣言は型で行う (`Requires: []plugin.Type{plugins.MetadataPlugin}`)
- 実際の取得は ID まで指定するか、型で全部取るかを選べる

これによって「metadata プラグインが 1 つでもあれば、その後に初期化される」という緩い依存関係が書ける。詳しくは [依存を型で宣言し、初期化順を DFS で決める](../plugin-graph/) で読む。

## どう活かすか

### プラグインが動いていない原因を切り分ける

```sh
# 全プラグインの状態
$ ctr plugins ls

# 失敗の詳細 (Error のメッセージが出る)
$ ctr plugins ls -d id==devmapper
```

ログでは Info と Warn を区別して見る。`skip loading plugin` は設定による無効化なので放置してよい。`failed to load plugin` は本当の失敗で、依存する機能が動かなくなる。

`required_plugins` を設定ファイルに書いておけば、「CRI が動いていないのに containerd が起動している」といった半端な状態を、起動失敗に変えられる。

```toml
required_plugins = ["io.containerd.grpc.v1.cri"]
```

Kubernetes ノードではこの設定を入れておくと、異常を早期に検出できる。

### プラグイン機構を自作するときの要点

containerd の実装から取り出せる要点は 4 つある。

- **登録は宣言的な構造体 1 つにする** — 手続きを書かせない
- **依存はコンパイル時ではなく実行時に解決する** — プラグイン同士を import させない
- **失敗を値として保持し、問い合わせ可能にする** — ログに流して終わりにしない
- **設定のスキーマをプラグイン側に置く** — コアが設定項目を知らなくて済む

特に 3 番目は、運用に入ってから効いてくる。「起動時に何が失敗したか」を後から聞けるかどうかで、障害対応の速さが変わる。
