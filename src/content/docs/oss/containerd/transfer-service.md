---
title: "転送 API を 1 本にして、source と destination の組で意味を決める"
description: "pull も push も import も export も、Transfer(source, destination) という 1 つの RPC で表される。組み合わせが何を意味するかは実装が決め、対応していなければ ErrNotImplemented を返す。新しい転送の種類を足しても、API のバージョンは上がらない。"
group: "イメージを取り込む"
sidebar:
  order: 25
---

## 何を学んだか

### RPC は 1 つだけ

transfer service の API はこれだけだ。

```proto
service Transfer {
	rpc Transfer(TransferRequest) returns (google.protobuf.Empty);
}

message TransferRequest {
	google.protobuf.Any source = 1;
	google.protobuf.Any destination = 2;
	TransferOptions options = 3;
}
```

source と destination はどちらも `Any` (型 URL 付きのバイト列)。組み合わせで操作が決まる。

| source                  | destination   | 意味       |
| ----------------------- | ------------- | ---------- |
| Registry                | Image Store   | **pull**   |
| Image Store             | Registry      | **push**   |
| Object stream (Archive) | Image Store   | **import** |
| Image Store             | Object stream | **export** |
| Image Store             | Image Store   | **tag**    |

Go のインターフェースで言えば、source が `ImageFetcher` で destination が `ImageStorer` なら pull、という判定になる。

### 対応していない組み合わせは実行時エラー

すべての組み合わせが有効なわけではない。Registry → Registry (ミラーリング) は未実装で、`ErrNotImplemented` が返る。**API はそれを表現できるが、実装がない** という状態を許している。

### なぜこの形なのか

[`docs/transfer.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/transfer.md) が理由を述べている。

```markdown title="docs/transfer.md"
The flexible API allows each implementation of the transfer interface to determines whether the transfer between the source and destination is possible. This allows new functionality to be added directly by implementations without versioning the API or requiring other implementations to handle an interface change.
```

新しい転送の形を足すのに **API のバージョンを上げなくてよい**。これが最大の狙いだ。

### 型は typeurl で解決される

`Any` から実際のオブジェクトへの変換は、型 URL をキーにしたレジストリで行う。`containerd.io/transfer/registry` という型 URL が来たら、レジストリ source のオブジェクトを組み立てる。

## ソースコードのどこか

### 組み合わせの判定

[`core/transfer/local/transfer.go#L68-L100`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/transfer/local/transfer.go#L68-L100)。

```go title="core/transfer/local/transfer.go"
func (ts *localTransferService) Transfer(ctx context.Context, src any, dest any, opts ...transfer.Opt) error {
	topts := &transfer.Config{}
	for _, opt := range opts {
		opt(topts)
	}

	// Figure out matrix of whether source destination combination is supported
	switch s := src.(type) {
	case transfer.ImageFetcher:
		switch d := dest.(type) {
		case transfer.ImageStorer:
			return ts.pull(ctx, s, d, topts)
		}
	case transfer.ImageGetter:
		switch d := dest.(type) {
		case transfer.ImagePusher:
			return ts.push(ctx, s, d, topts)
		case transfer.ImageExporter:
			return ts.exportStream(ctx, s, d, topts)
		case transfer.ImageStorer:
			return ts.tag(ctx, s, d, topts)
		}
	case transfer.ImageImporter:
		switch d := dest.(type) {
		case transfer.ImageExportStreamer:
			return ts.echo(ctx, s, d, topts)
		case transfer.ImageStorer:
			// TODO: verify imports with ImageVerifiers?
			return ts.importStream(ctx, s, d, topts)
		}
	}
	return fmt.Errorf("unable to transfer from %s to %s: %w", name(src), name(dest), errdefs.ErrNotImplemented)
}
```

二重の型スイッチが、そのまま `docs/transfer.md` の表になっている。コメントの "matrix" という言葉が的確だ。

`ImageGetter` (ローカルのイメージを取得できる) の分岐で 3 通りに分かれているのが分かりやすい。同じ source でも destination が違えば push / export / tag になる。

エラーメッセージ用の `name` 関数も気が利いている。

```go title="core/transfer/local/transfer.go"
func name(t any) string {
	switch s := t.(type) {
	case fmt.Stringer:
		return s.String()
	case typeurl.Any:
		return s.GetTypeUrl()
	default:
		return fmt.Sprintf("%T", t)
	}
}
```

`String()` があればそれを、なければ型 URL を、それもなければ Go の型名を出す。「何から何への転送ができないのか」が必ず読めるようにしてある。

### 能力はインターフェースで表現される

[`core/transfer/transfer.go#L30-L90`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/transfer/transfer.go#L30-L90)。

```go title="core/transfer/transfer.go"
type Transferrer interface {
	Transfer(ctx context.Context, source any, destination any, opts ...Opt) error
}

type ImageResolver interface {
	Resolve(ctx context.Context) (name string, desc ocispec.Descriptor, err error)
}
...
type ImageFetcher interface {
	ImageResolver

	Fetcher(ctx context.Context, ref string) (Fetcher, error)
}
```

「レジストリである」ではなく「**参照を解決でき、fetcher を作れる**」という能力でモデル化されている。だからローカルの OCI レイアウトディレクトリも、条件を満たせば source になれる。

性能設定も source 側のオプションとして渡る。

```go title="core/transfer/transfer.go"
type ImageResolverPerformanceSettings struct {
	MaxConcurrentDownloads     int
	ConcurrentLayerFetchBuffer int
}
```

同時ダウンロード数とチャンクサイズが、`Transfer` の引数ではなく **source オブジェクトの設定** になっている。「registry から取るときの並列度」は registry source の関心事だからだ。

### 型 URL のレジストリ

[`core/transfer/plugins/plugins.go#L27-L50`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/transfer/plugins/plugins.go#L27-L50)。

```go title="core/transfer/plugins/plugins.go"
func Register(apiObject, transferObject any) {
	url, err := typeurl.TypeURL(apiObject)
	if err != nil {
		panic(err)
	}
	// Lock
	register.Lock()
	defer register.Unlock()
	if register.r == nil {
		register.r = map[string]reflect.Type{}
	}
	if _, ok := register.r[url]; ok {
		panic(fmt.Sprintf("url already registered: %v", url))
	}
	t := reflect.TypeOf(transferObject)
```

protobuf のメッセージ型と Go の実装型を対応付ける。`Any` を受け取ったら型 URL を見て、対応する Go の型を `reflect` で作り、Unmarshal する。

**新しい source / destination の種類を足すのは、このレジストリに 1 行足すこと** になる。プラグイン機構の中にもう一段の登録機構がある形だ。

### リースは転送サービスが取る

[`core/transfer/local/transfer.go#L138-L168`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/transfer/local/transfer.go#L138-L168)。

```go title="core/transfer/local/transfer.go"
	if len(opts) == 0 {
		// Use default lease configuration if no options provided
		opts = []leases.Opt{
			leases.WithRandomID(),
			leases.WithExpiration(24 * time.Hour),
		}
	}
```

pull の途中で作られる blob を守るリースを、**デーモン側の transfer service が取る**。クライアントがリースを扱わなくてよくなる。

これは [smart client model](../smart-client/) からの部分的な揺り戻しでもある。「pull」という頻出の操作については、クライアントの正しい振る舞いに依存せず、デーモン側で完結させる方向に寄せている。

## なぜそうなっているか

### API のバージョンを上げずに機能を足す

[`docs/transfer.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/transfer.md) は libchan の影響を明記している。

```markdown title="docs/transfer.md"
The transfer service is built upon the core ideas put forth by the libchan project, that an API with binary streams and data channels as first class objects is more flexible and opens a wider variety of use cases without requiring constant protocol and API updates.
```

従来の containerd では、pull はクライアント側のライブラリが content store と snapshotter を個別に叩いて実装していた。つまり **pull のロジックがクライアントのバージョンに固定されていた**。

transfer service に寄せると、pull の改善 (並列度、再試行、新形式への対応) がデーモンの更新だけで効く。Go 以外の言語のクライアントも恩恵を受ける。

### 「何ができるか」を実装に判断させる

API に `PullRequest` / `PushRequest` を並べると、containerd が対応する操作の一覧が API に焼き付く。新しい操作を足すたびに proto を変更し、全実装が追随する必要がある。

`Transfer(any, any)` にしておけば、**判断は実装のものになる**。対応していない組み合わせは実行時に `ErrNotImplemented` を返せばよい。

代償は、静的に検証できないこと。IDE の補完も効かず、何が呼べるかはドキュメントを読むしかない。containerd は「表を docs に書く」ことでこれを補っている。

### Go のインターフェースを型スイッチで使う

判定に `switch s := src.(type)` を使えるのは、Go のインターフェースが構造的だからだ。「registry source」という具体型を知らなくても、`ImageFetcher` を満たしていれば pull の source になれる。

外部プラグインが新しい source 実装を提供する余地が、この構造から生まれる。

## どう活かすか

### ctr から transfer service を使う

containerd 2.x では `ctr` の pull / push が既定で transfer service を通る。

```sh
# transfer service 経由 (既定)
$ ctr -n k8s.io images pull docker.io/library/alpine:latest

# 旧来のクライアント側実装を使う
$ ctr -n k8s.io images pull --local docker.io/library/alpine:latest
```

挙動の違いを疑ったときは `--local` と比較すると切り分けられる。CRI 経由の pull も transfer service を使う。

### 「操作の直積」を 1 つの API にまとめる判断

source × destination のような直積構造を持つ機能では、この設計が効く。判断の目安は次の 3 点だ。

- **要素が今後増える見込みがあるか** — 増えないなら個別 API のほうが分かりやすい
- **組み合わせの多くが意味を持つか** — 疎ならメソッドを並べたほうがよい
- **API の安定性が実装の柔軟性より重要か** — containerd はこれが強く当てはまる

逆に、組み合わせが 2×2 で固定なら、素直に 4 つのメソッドを並べるほうが読みやすい。この形は「後から要素が増える」ことに賭けた設計で、賭けが外れると分かりにくいだけの API になる。

### 未対応を実行時エラーにするなら、一覧を文書で持つ

`ErrNotImplemented` を返す設計にするなら、**何が対応済みかの表を必ず用意する**。containerd は `docs/transfer.md` に対応状況の表 (実装されたバージョンつき) を置いている。

これがないと、利用者は総当たりで試すしかなくなる。
