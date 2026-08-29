---
title: "1 つのデーモンを namespace で分ける"
description: "containerd の namespace は Linux の namespace とは別物で、1 つのデーモンを複数の利用者が名前を衝突させずに使うための区画だ。context に載って gRPC ヘッダで運ばれ、bbolt のバケット階層の第 2 段になる。blob は digest で共有されるが名前とメタデータは分かれる。そして「セキュリティ境界ではない」と明記されている。"
group: "containerd のかたち"
sidebar:
  order: 14
---

## 何を学んだか

### Linux の namespace ではない

containerd の namespace は、コンテナの隔離とは無関係の **管理上の区画** だ。同じホストで Docker と Kubernetes が 1 つの containerd を共有しても、互いのコンテナ名やイメージ名が衝突しないようにする。

実際に使われている namespace は、

- `default` — `ctr` の既定
- `k8s.io` — CRI プラグイン (Kubernetes)
- `moby` — Docker
- `buildkit` — BuildKit

`ctr -n k8s.io containers ls` としないと Kubernetes のコンテナが見えないのは、これが理由だ。

### 分かれるもの、共有されるもの

[`docs/namespaces.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/namespaces.md) が線引きを示している。

```markdown title="docs/namespaces.md"
Underlying image content is still shared via content addresses but image names and metadata are separate per namespace.
```

- **分かれる** — イメージ名、コンテナ、snapshot、リース、ラベル
- **共有される** — content store の blob の実体 (digest でアドレスされるバイト列)

`k8s.io` と `moby` が同じ base image を使っていれば、blob はディスク上に 1 つしかない。名前空間ごとに「その blob への参照」があるだけだ。

### セキュリティ境界ではないと明言されている

```markdown title="docs/namespaces.md"
It is important to note that namespaces, as implemented, is an administrative construct that is not meant to be used as a security feature.
It is trivial for clients to switch namespaces.
```

クライアントは gRPC ヘッダを変えるだけで別の namespace に移れる。**認可の機構ではない**。containerd のソケットに繋げる時点で、すべての namespace にアクセスできる。マルチテナントの分離が必要なら、ソケットへのアクセス自体を分ける必要がある。

### 運び方は context とヘッダ

namespace は引数ではなく `context.Context` に載る。Go クライアントでは `namespaces.WithNamespace(ctx, "k8s.io")`、gRPC では `containerd-namespace` ヘッダとして送られる。

「全 API に共通で必要な情報を、引数ではなく context で運ぶ」という選択だ。同じ扱いをされているものがもう 1 つあり、それがリース (`containerd-lease` ヘッダ) になる。

## ソースコードのどこか

### context に入れると同時にヘッダにも入れる

[`pkg/namespaces/context.go#L36-L42`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/namespaces/context.go#L36-L42)。

```go title="pkg/namespaces/context.go"
// WithNamespace sets a given namespace on the context
func WithNamespace(ctx context.Context, namespace string) context.Context {
	ctx = context.WithValue(ctx, namespaceKey{}, namespace) // set our key for namespace
	// also store on the grpc and ttrpc headers so it gets picked up by any clients that
	// are using this.
	return withTTRPCNamespaceHeader(withGRPCNamespaceHeader(ctx, namespace), namespace)
}
```

context の値としてだけでなく、**gRPC と ttrpc の送信メタデータにも同時に書き込む**。これによって、あるレイヤで設定した namespace が、そのまま下流の RPC 呼び出しに伝播する。

取り出す側 ([`#L54-L64`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/namespaces/context.go#L54-L64)) は 3 段のフォールバックを持つ。

```go title="pkg/namespaces/context.go"
// Namespace returns the namespace from the context.
//
// The namespace is not guaranteed to be valid.
func Namespace(ctx context.Context) (string, bool) {
	namespace, ok := ctx.Value(namespaceKey{}).(string)
	if !ok {
		if namespace, ok = fromGRPCHeader(ctx); !ok {
```

context の値 → gRPC ヘッダ → ttrpc ヘッダ、の順に探す。サーバ側では受信メタデータから、クライアント側では自分で設定した値から取れる。**同じ関数が両側で使える**。

### インターセプタで受信を送信に繋ぐ

[`plugins/server/grpc/namespace.go#L25-L32`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/server/grpc/namespace.go#L25-L32)。

```go title="plugins/server/grpc/namespace.go"
func unaryNamespaceInterceptor(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	if ns, ok := namespaces.Namespace(ctx); ok {
		// The above call checks the *incoming* metadata, this makes sure the outgoing metadata is also set
		ctx = namespaces.WithNamespace(ctx, ns)
	}
	return handler(ctx, req)
}
```

受信ヘッダから読んだ namespace を、そのまま **送信ヘッダに設定し直す**。containerd がさらに別のサービス (proxy plugin や shim) を呼ぶとき、namespace が自動的に引き継がれる。

ストリーミング RPC では `ServerStream` の `Context()` を差し替えるラッパを噛ませる。gRPC のストリームは context を後から変えられないので、ラップするしかない。

### bbolt のバケット階層に埋め込まれる

[`core/metadata/buckets.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/buckets.go) のスキーマ。

```go title="core/metadata/buckets.go"
//	<version>/<namespace>/<object>/<key> -> <field>
```

namespace はキー階層の第 2 段だ。バケットを 1 つ下りるだけで対象の namespace に限定されるので、**namespace ごとのフィルタリングがコストゼロ** になる。一覧操作はそのバケットの中を走査するだけでよい。

namespace の削除も、対応するバケットを消せば終わる。

### content の共有ポリシーは設定できる

[`plugins/metadata/plugin.go#L47-L82`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/metadata/plugin.go#L47-L82)。

```go title="plugins/metadata/plugin.go"
type BoltConfig struct {
	// ContentSharingPolicy sets the sharing policy for content between
	// namespaces.
	//
	// The default mode "shared" will make blobs available in all
	// namespaces once it is pulled into any namespace. The blob will be pulled
	// into the namespace if a writer is opened with the "Expected" digest that
	// is already present in the backend.
	//
	// The alternative mode, "isolated" requires that clients prove they have
	// access to the content by providing all of the content to the ingest
	// before the blob is added to the namespace.
	//
	// Both modes share backing data, while "shared" will reduce total
	// bandwidth across namespaces, at the cost of allowing access to any blob
	// just by knowing its digest.
	ContentSharingPolicy string `toml:"content_sharing_policy"`
```

既定の `shared` では、**digest を知っているだけで他の namespace が pull した blob を参照できる**。プライベートレジストリのイメージでも、digest さえ分かれば別 namespace から読めてしまう。

`isolated` にすると、blob の中身を最後まで書き込んで初めて自分の namespace に登録される。ダウンロードの帯域は無駄になるが、「持っていることの証明」を要求する。

この設定の存在が、namespace が **セキュリティ境界ではない** ことの具体的な現れになっている。既定は性能側に倒してあり、必要なら締められる。

### namespace ラベルで既定値を変える

```markdown title="docs/namespaces.md"
> sudo ctr namespaces label k8s.io containerd.io/defaults/snapshotter=btrfs
> sudo ctr namespaces label k8s.io containerd.io/defaults/runtime=testRuntime
```

namespace 自体にラベルを付けられ、一部は containerd の既定値として解釈される ([`defaults/defaults.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/defaults/defaults.go))。

```go title="defaults/defaults.go"
	// DefaultRuntimeNSLabel defines the namespace label to check for the
	// default runtime
	DefaultRuntimeNSLabel = "containerd.io/defaults/runtime"
	// DefaultSnapshotterNSLabel defines the namespace label to check for the
	// default snapshotter
	DefaultSnapshotterNSLabel = "containerd.io/defaults/snapshotter"
```

「Kubernetes の namespace だけ別の snapshotter を使う」といった構成が、設定ファイルではなく **実行時のラベル** で切り替えられる。

## なぜそうなっているか

### 1 デーモンで複数の利用者を捌く必要があった

Docker、Kubernetes、BuildKit が同じホストで動くのは珍しくない。それぞれに containerd を立てると、イメージが重複してディスクを食い、リソース管理も分断される。

```markdown title="docs/namespaces.md"
Namespaces allow multi-tenancy within a single daemon. This removes the need for the common pattern of using nested containers to achieve this separation.
```

「分離のためにコンテナを入れ子にする (Docker in Docker) 必要をなくす」という動機が明記されている。

### 名前は分けるが実体は共有する、という中間解

完全に分離すると blob が重複する。完全に共有すると名前が衝突する。containerd は **content-addressable なもの (blob) は共有し、人間が付ける名前は分ける** という線を引いた。

digest でアドレスされるものは、そもそも中身が同じなら同じものだ。共有しても意味論的な問題は起きない。問題は「知られたくない blob を知られる」ことだけで、それは `isolated` ポリシーで対処する。

### セキュリティ境界にしない、と決めたこと

namespace をセキュリティ境界にするなら、認証・認可の機構が要る。誰がどの namespace にアクセスできるかを決める仕組みは、単一ホストのデーモンとしてはスコープが大きい。

代わりに containerd は「ソケットにアクセスできる = 全権限」という単純なモデルを採り、**分離が要るならソケットを分けろ** という立場を取る。ドキュメントで明言しているので、誤解による誤用を防げる。

## どう活かすか

### namespace を跨いだ調査

```sh
# 存在する namespace
$ ctr namespaces ls

# k8s.io のコンテナとイメージ
$ ctr -n k8s.io containers ls
$ ctr -n k8s.io images ls

# 環境変数で既定を変える
$ export CONTAINERD_NAMESPACE=k8s.io
```

「イメージが pull されているはずなのに見えない」の大半は namespace 違いだ。`ctr images ls` (default) と `crictl images` (k8s.io) は別のものを見ている。

### ディスク使用量を調べるとき

blob が共有されているため、namespace ごとのディスク使用量を単純に足すと実際より大きくなる。`ctr -n <ns> images ls` のサイズ合計は「参照しているイメージの合計」であって「占有しているディスク」ではない。

実際の使用量は content store のディレクトリを直接見るのが確実だ。

```sh
$ du -sh /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/
```

### 「共通の文脈を context で運ぶ」の是非

namespace とリースを引数ではなく context で運ぶ設計には、明確な利点と欠点がある。

- **利点** — 全 API のシグネチャが汚れない。中間層が意識せず伝播できる。gRPC ヘッダに自然にマップできる
- **欠点** — 型システムで強制できない。設定を忘れるとランタイムエラーになる

containerd は欠点への対処として、`NamespaceRequired(ctx)` という「なければエラーを返す」ヘルパを用意し、入口で確実に検査している。context で運ぶものを増やすなら、**入口での検査をセットにする** のが最低限の作法になる。
