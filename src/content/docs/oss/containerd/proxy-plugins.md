---
title: "proxy plugin: 別プロセスを containerd の一部として扱う"
description: "設定ファイルに address と type を書くだけで、外部プロセスの gRPC サービスが containerd のプラグインとして登録される。内部実装と同じインターフェースの向こうにいるので、呼び出す側は違いを知らない。stargz snapshotter のような外部実装は、この仕組みで containerd に載る。"
group: "運用と拡張"
sidebar:
  order: 62
---

## 何を学んだか

### 設定 4 行で外部プロセスを繋ぐ

```toml
version = 3

[proxy_plugins]
  [proxy_plugins.customsnapshot]
    type = "snapshot"
    address = "/var/run/mysnapshotter.sock"
```

これだけで、`io.containerd.snapshotter.v1.customsnapshot` というプラグインが登録される。**containerd の再ビルドは不要**。

対応する型は 4 つ。

| `type`     | インターフェース                 |
| ---------- | -------------------------------- |
| `snapshot` | `snapshots.Snapshotter`          |
| `content`  | `content.Store`                  |
| `diff`     | `diff.Applier` / `diff.Comparer` |
| `sandbox`  | `sandbox.Controller`             |

### proxy はインターフェースの実装

各型に `proxy` パッケージがあり、gRPC クライアントをインターフェースの実装でラップする。

```go
func NewSnapshotter(client snapshotsapi.SnapshotsClient, snapshotterName string) snapshots.Snapshotter
```

呼び出す側 (metadata 層、unpacker、CRI) は、それがローカルの overlayfs か、リモートの stargz かを **区別しない** ([metadata が実装を包んで、namespace とトランザクションを足す](../metadata-wrapping/))。

### 実装する側も簡単

外部プラグインを書く側は、gRPC サービスを実装するだけだ。しかも containerd が変換ヘルパを提供している。

```go
sn, _ := native.NewSnapshotter(root)
service := snapshotservice.FromSnapshotter(sn)
snapshotsapi.RegisterSnapshotsServer(rpc, service)
```

**Go の `Snapshotter` インターフェースを実装すれば、それを gRPC サービスに変換できる**。

### エラーの意味も渡る

proxy の各メソッドは `errgrpc.ToNative(err)` でエラーを変換する。だから `ErrAlreadyExists` を使った [remote snapshotter のプロトコル](../remote-snapshotter/) が、プロセス境界を越えて成立する。

## ソースコードのどこか

### 設定の構造

[`cmd/containerd/server/config/config.go#L401-L407`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd/server/config/config.go#L401-L407)。

```go title="cmd/containerd/server/config/config.go"
type ProxyPlugin struct {
	Type         string            `toml:"type"`
	Address      string            `toml:"address"`
	Platform     string            `toml:"platform"`
	Exports      map[string]string `toml:"exports"`
	Capabilities []string          `toml:"capabilities"`
}
```

`Exports` と `Capabilities` があるのが目を引く。**外部プラグインも、内部プラグインと同じメタデータを申告できる** ([中核が空のデーモン](../plugin-architecture/))。

`Platform` で対応プラットフォームを指定する。マルチアーキのノードで、特定のアーキ向けの snapshotter を登録する場合に使う。

### 登録の実装

[`cmd/containerd/server/server.go#L310-L381`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd/server/server.go#L310-L381)。

```go title="cmd/containerd/server/server.go"
		switch pp.Type {
		case string(plugins.SnapshotPlugin), "snapshot":
			t = plugins.SnapshotPlugin
			ssname := name
			f = func(conn *grpc.ClientConn) any {
				return ssproxy.NewSnapshotter(ssapi.NewSnapshotsClient(conn), ssname)
			}

		case string(plugins.ContentPlugin), "content":
			t = plugins.ContentPlugin
			f = func(conn *grpc.ClientConn) any {
				return csproxy.NewContentStore(conn)
			}
		case string(plugins.SandboxControllerPlugin), "sandbox":
			...
		case string(plugins.DiffPlugin), "diff":
			...
		default:
			log.G(ctx).WithField("type", pp.Type).Warn("unknown proxy plugin type")
		}
```

`type` には短縮形 (`snapshot`) と完全な型名 (`io.containerd.snapshotter.v1`) の両方が書ける。**設定の書きやすさと厳密さの両方を許す**。

未知の型は **警告のみで続行する**。設定ミスでデーモンが起動しないより、そのプラグインだけが登録されないほうがよい、という判断だ。

```go title="cmd/containerd/server/server.go"
		exports := pp.Exports
		if exports == nil {
			exports = map[string]string{}
		}
		exports["address"] = address

		registry.Register(&plugin.Registration{
			Type: t,
			ID:   name,
			InitFn: func(ic *plugin.InitContext) (any, error) {
				ic.Meta.Exports = exports
				ic.Meta.Platforms = append(ic.Meta.Platforms, p)
				ic.Meta.Capabilities = pp.Capabilities
				conn, err := clients.getClient(address)
				if err != nil {
					return nil, err
				}
				return f(conn), nil
			},
		})
```

**`address` が自動的に Exports に追加される**。`ctr plugins ls -d` で、そのプラグインがどこに繋いでいるかが見える。

登録は通常の `plugin.Registration` として行われるので、[依存解決も初期化順も同じ仕組み](../plugin-graph/) に乗る。

### 接続の共有

```go title="cmd/containerd/server/server.go"
func (pc *proxyClients) getClient(address string) (*grpc.ClientConn, error) {
	pc.m.Lock()
	defer pc.m.Unlock()
	if pc.clients == nil {
		pc.clients = map[string]*grpc.ClientConn{}
	} else if c, ok := pc.clients[address]; ok {
		return c, nil
	}

	backoffConfig := backoff.DefaultConfig
	backoffConfig.MaxDelay = 3 * time.Second
	connParams := grpc.ConnectParams{
		Backoff: backoffConfig,
	}
```

**アドレスごとに接続を共有する**。同じプロセスが snapshotter と content store の両方を提供している場合、接続は 1 本になる。

再接続のバックオフは最大 3 秒。外部プラグインが再起動しても、3 秒以内に繋ぎ直す。

```go title="cmd/containerd/server/server.go"
	gopts := []grpc.DialOption{
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithConnectParams(connParams),
		grpc.WithContextDialer(dialer.ContextDialer),

		// TODO(stevvooe): We may need to allow configuration of this on the client.
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(defaults.DefaultMaxRecvMsgSize)),
		grpc.WithDefaultCallOptions(grpc.MaxCallSendMsgSize(defaults.DefaultMaxSendMsgSize)),
	}

	conn, err := grpc.NewClient(dialer.DialAddress(address), gopts...)
```

`otelgrpc` のハンドラが入るので、**トレースが外部プラグインまで伸びる**。分散トレーシングで「どこが遅いか」を追える。

`insecure.NewCredentials()` — TLS を使わない。Unix ソケット越しの通信なので、ファイルパーミッションで守る前提だ。

`grpc.NewClient` は遅延接続なので、**外部プラグインが起動していなくても containerd は起動する**。最初の呼び出しで繋ぐ。

### proxy の実装

[`core/snapshots/proxy/proxy.go#L22-L45`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/snapshots/proxy/proxy.go#L22-L45)。

```go title="core/snapshots/proxy/proxy.go"
// NewSnapshotter returns a new Snapshotter which communicates over a GRPC
// connection using the containerd snapshot GRPC API.
func NewSnapshotter(client snapshotsapi.SnapshotsClient, snapshotterName string) snapshots.Snapshotter {
	return &proxySnapshotter{
		client:          client,
		snapshotterName: snapshotterName,
	}
}

func (p *proxySnapshotter) Stat(ctx context.Context, key string) (snapshots.Info, error) {
	resp, err := p.client.Stat(ctx,
		&snapshotsapi.StatSnapshotRequest{
			Snapshotter: p.snapshotterName,
			Key:         key,
		})
	if err != nil {
		return snapshots.Info{}, errgrpc.ToNative(err)
	}
	return InfoFromProto(resp.Info), nil
}
```

各メソッドが「リクエストを組み立て、呼んで、エラーを変換し、レスポンスを変換する」だけ。**機械的な変換層** になっている。

`errgrpc.ToNative(err)` が入っているのが重要で、これがないと `errdefs.IsNotFound(err)` が効かない ([errdefs: エラーの意味を境界で保つ](../errdefs/))。

`snapshotterName` をリクエストに含めるのは、**1 つのサービスが複数の snapshotter を提供できる** ためだ。containerd の内部 API と同じ形になっている。

### 実装する側のヘルパ

[`docs/PLUGINS.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/PLUGINS.md) の例。

```go title="docs/PLUGINS.md"
	// Configure your custom snapshotter, this example uses the native
	// snapshotter and a root directory. Your custom snapshotter will be
	// much more useful than using a snapshotter which is already included.
	sn, err := native.NewSnapshotter(os.Args[2])
	...
	// Convert the snapshotter to a gRPC service,
	// example in github.com/containerd/containerd/contrib/snapshotservice
	service := snapshotservice.FromSnapshotter(sn)

	// Register the service with the gRPC server
	snapshotsapi.RegisterSnapshotsServer(rpc, service)
```

`contrib/snapshotservice` が **Go インターフェース → gRPC サービス** の変換を提供する。proxy パッケージの逆方向だ。

つまり、

```
containerd → proxy パッケージ → gRPC → snapshotservice → Snapshotter 実装
```

両端で同じ Go インターフェースが使われ、間の gRPC が透過的になる。Go で書くなら、**gRPC を意識せずに snapshotter を実装できる**。

## なぜそうなっているか

### 代替実装を本体に入れない方針の受け皿

[SCOPE.md](../scope-and-principles/) は「代替実装は本体に入れず、別リポジトリで開発せよ」と述べている。それを実現するには、**本体をビルドし直さずに実装を差し込める** 必要がある。

Go のプラグイン機構 (`plugin` パッケージ) は、Go のバージョンとビルドフラグの完全一致を要求するので実用にならない。gRPC で別プロセスにすれば、

- 言語も自由 (Rust で書かれた snapshotter もある)
- ビルドが独立
- クラッシュが containerd に波及しない
- 独立して更新できる

代償は RPC のオーバーヘッドだが、snapshotter の呼び出しはコンテナ起動時に数回程度なので許容できる。

### 内部と外部を同じ土俵に乗せる

[`docs/PLUGINS.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/PLUGINS.md) の宣言。

```markdown title="docs/PLUGINS.md"
containerd uses plugins internally to ensure that internal implementations are
decoupled, stable, and treated equally with external plugins.
```

内部実装が特別扱いされないので、**外部プラグインに必要な API が足りなければ、内部実装も困る**。拡張点の不足がすぐに自分たちの問題になる。

proxy plugin が `Registration` として登録されるのも同じ発想で、依存解決も introspection も内部プラグインと同じ扱いになる。

### 対応する型が 4 つだけの理由

すべてのプラグイン型を proxy にできるわけではない。対応しているのは snapshot / content / diff / sandbox の 4 つ。

これらに共通するのは、

- **インターフェースが安定している** — 頻繁に変わらない
- **呼び出し頻度が低い** — RPC のコストが問題にならない
- **代替実装の需要がある** — stargz、nydus、SOCI、Kata

逆に、metadata や gc は containerd の内部構造と密結合していて、外に出す意味がない。**需要と実現可能性がある場所だけを開いている**。

## どう活かすか

### stargz snapshotter を繋ぐ

```toml
version = 3

[proxy_plugins]
  [proxy_plugins.stargz]
    type = "snapshot"
    address = "/run/containerd-stargz-grpc/containerd-stargz-grpc.sock"

[plugins.'io.containerd.cri.v1.images']
  snapshotter = "stargz"
```

外部プロセス (`containerd-stargz-grpc`) を systemd などで起動しておく。containerd は起動時に接続を作るが、遅延接続なので順序は問わない。

```sh
# 登録されているか確認
$ ctr plugins ls | grep stargz
```

### 外部プラグインが落ちたとき

```sh
# プラグインの状態
$ ctr plugins ls -d id==stargz

# ソケットの存在
$ ls -l /run/containerd-stargz-grpc/containerd-stargz-grpc.sock
```

遅延接続なので、プラグインが落ちていても `ctr plugins ls` では `ok` に見えることがある。実際に使おうとしたときにエラーになる。

再接続のバックオフが最大 3 秒なので、外部プラグインを再起動すれば数秒で復帰する。

### 自作の snapshotter を試す

`docs/PLUGINS.md` の例をそのまま動かすと、native snapshotter を外部プロセスとして動かせる。

```sh
# 別ターミナルで
$ go run ./main.go /var/run/mysnapshotter.sock /tmp/snapshots

# containerd 側から使う
$ CONTAINERD_SNAPSHOTTER=customsnapshot ctr images pull docker.io/library/alpine:latest
$ tree -L 3 /tmp/snapshots
```

**実装を書く前に、仕組みだけを試せる**。ドキュメントに動く例があるのは、この種の拡張点では特に価値がある。

### 「外部プロセスをプラグインにする」設計

- **同じインターフェースの両側に変換層を用意する** — proxy (呼ぶ側) と service (実装側)
- **エラーの意味を変換する** — 種別が失われると、プロトコルが壊れる
- **接続はアドレス単位で共有する** — 1 プロセスが複数のサービスを提供できる
- **遅延接続にする** — 起動順序の制約を作らない
- **内部実装と同じ登録経路に乗せる** — 特別扱いを作らない

2 番目が最も見落とされやすい。RPC の向こうから返るエラーを文字列としてしか扱えないと、`ErrAlreadyExists` を合図に使うような設計が成立しなくなる。
