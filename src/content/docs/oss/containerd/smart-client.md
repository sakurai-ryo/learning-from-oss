---
title: "賢いのはクライアント側 (smart client model)"
description: "OCI spec を組み立てるのも、イメージのレイヤ関係を知っているのも、snapshot を用意するのも、containerd のデーモンではなくクライアントライブラリだ。デーモンは primitive を提供するだけで、それをどう組み合わせるかはクライアントが決める。この分担が拡張性の源になっている一方、クライアント実装ごとの差も生む。"
group: "containerd のかたち"
sidebar:
  order: 13
---

## 何を学んだか

### デーモンに要らない仕事はクライアントでやる

[`docs/PLUGINS.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/PLUGINS.md) の冒頭にこう書かれている。

```markdown title="docs/PLUGINS.md"
## Smart Client Model

containerd has a smart client architecture, meaning any functionality which is
not required by the daemon is done by the client. This includes most high
level interactions such as creating a container's specification, interacting
with an image registry, or loading an image from tar.
```

「デーモンに必要でない機能は全部クライアントがやる」。具体的には次のようなものが **クライアント側のコード** で動く。

- OCI spec (`config.json`) の生成 — `pkg/oci` の 5 万行を超える `SpecOpts` 群
- イメージのグラフを辿って、どの blob が必要かを決めること
- レイヤの chainID を計算して、どこまで展開済みかを判断すること
- snapshot を `Prepare` して、コンテナに渡すマウントを用意すること
- リースを取って、作業中の資源を GC から守ること

デーモンがやるのは「言われたものを保存する」「言われた通りに実行する」だけだ。

### `ctr run` の裏側はクライアント側の 5 ステップ

`client.NewContainer(ctx, id, opts...)` を呼ぶと、渡された opts が **クライアントのプロセスで順に実行される**。

```go
client.NewContainer(ctx, "test",
	oci.WithNewSpec(oci.WithImageConfig(image)),  // spec を組み立てる
	containerd.WithNewSnapshot("test", image),    // snapshot を Prepare する
)
```

`WithNewSnapshot` の中で、クライアントは

1. イメージの config を読んで diffID の列を得る
2. `identity.ChainID` で最上位の chainID を計算する
3. それを親として snapshotter の `Prepare` を呼ぶ
4. できた snapshot キーを Container レコードに書き込む

を行う。デーモンから見ると「Prepare が来た」「Container を作れと来た」という個別の要求が並ぶだけで、**この 4 つが一連の作業だとは知らない**。

### だから API が壊れにくい

「コンテナを作る」という高レベル API がデーモン側にないので、コンテナの作り方が変わってもデーモンの API は変わらない。BuildKit のように「コンテナは作らないが snapshot と content は使う」使い方も、同じ API で成立する。

### 代償: クライアント実装ごとに振る舞いが違う

Go クライアント、CRI プラグイン、nerdctl、BuildKit はそれぞれ独自に primitive を組み合わせる。結果として、

- `ctr run` で作ったコンテナと CRI で作った Pod は、ラベルもリースの張り方も違う
- クライアントがリースを正しく扱わなければ、資源が GC される
- 同じ「イメージを pull する」でも、実装によって作られるラベルが異なる

という差が生まれる。containerd を直接叩くツールを書くとき、この差が落とし穴になる。

## ソースコードのどこか

### NewContainer は opts を回すだけ

[`client/client.go#L340-L377`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/client/client.go#L340-L377)。

```go title="client/client.go"
func (c *Client) NewContainer(ctx context.Context, id string, opts ...NewContainerOpts) (Container, error) {
	ctx, span := tracing.StartSpan(ctx, "client.NewContainer")
	defer span.End()
	ctx, done, err := c.WithLease(ctx)
	if err != nil {
		return nil, err
	}
	defer done(ctx)
	...
	container := containers.Container{
		ID: id,
		Runtime: containers.RuntimeInfo{
			Name: runtime,
		},
	}
	for _, o := range opts {
		if err := o(ctx, c, &container); err != nil {
			return nil, err
		}
	}
	...
	r, err := c.ContainerService().Create(ctx, container)
```

最初にリースを取り、opts を順に適用し、最後に 1 回だけ `Create` を呼ぶ。**デーモンへの書き込みは最後の 1 回だけ** で、それまでの準備 (snapshot の作成など) は opts の中で個別に行われる。

リースの取得が最初にあるのが重要だ ([`client/lease.go#L27-L54`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/client/lease.go#L27-L54))。

```go title="client/lease.go"
	if len(opts) == 0 {
		// Use default lease configuration if no options provided
		opts = []leases.Opt{
			leases.WithRandomID(),
			leases.WithExpiration(24 * time.Hour),
		}
	}

	l, err := ls.Create(ctx, opts...)
	...
	ctx = leases.WithLease(ctx, l.ID)
	return ctx, func(ctx context.Context) error {
		return ls.Delete(ctx, l)
	}, nil
```

24 時間の期限付きリースを作り、`defer done(ctx)` で解放する。**クライアントが途中で死んでも、24 時間後には自動的に消える**。「クライアントが賢い」設計の弱点 (クライアントが後始末を忘れる) に対する保険がここにある ([参照カウントをやめて、「これから使う」を宣言させる](../leases/))。

### snapshot の準備もクライアント側

[`client/container_opts.go#L242-L280`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/client/container_opts.go#L242-L280)。

```go title="client/container_opts.go"
func withNewSnapshot(id string, i Image, readonly bool, opts ...snapshots.Opt) NewContainerOpts {
	return func(ctx context.Context, client *Client, c *containers.Container) error {
		diffIDs, err := i.RootFS(ctx)
		if err != nil {
			return err
		}

		parent := identity.ChainID(diffIDs).String()
		...
		if readonly {
			_, err = s.View(ctx, id, parent, opts...)
		} else {
			_, err = s.Prepare(ctx, id, parent, opts...)
		}
		if err != nil {
			return err
		}
		c.SnapshotKey = id
		c.Image = i.Name()
		return nil
	}
}
```

「イメージから rootfs を作る」という処理の全体が、この関数に収まっている。デーモンには `Prepare(id, parent)` という素朴な呼び出ししか見えない。**イメージと snapshot を結びつけているのはクライアントの知識** だ。

### spec の生成もクライアント側

[`client/container_opts.go#L316-L327`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/client/container_opts.go#L316-L327)。

```go title="client/container_opts.go"
func WithNewSpec(opts ...oci.SpecOpts) NewContainerOpts {
	return func(ctx context.Context, client *Client, c *containers.Container) error {
		if _, ok := namespaces.Namespace(ctx); !ok {
			ctx = namespaces.WithNamespace(ctx, client.DefaultNamespace())
		}
		s, err := oci.GenerateSpec(ctx, client, c, opts...)
		if err != nil {
			return err
		}
		c.Spec, err = typeurl.MarshalAny(s)
		return err
	}
}
```

生成した spec は `typeurl.MarshalAny` で **バイト列に固められて** Container レコードに入る。デーモンはこれを解釈しない ([OCI Runtime Spec: runc への入力は bundle 1 つだけ](../oci-runtime-spec/))。

`pkg/oci/spec_opts.go` には `WithImageConfig`、`WithPrivileged`、`WithMounts`、`WithUser`、`WithCapabilities` など数十の `SpecOpts` があり、これが「コンテナをどう設定するか」の語彙になっている。この語彙はクライアントライブラリの一部であって、API ではない。

### 拡張点としての opts

`NewContainerOpts` も `SpecOpts` も単なる関数型なので、利用者が自分で書ける。

```go
type NewContainerOpts func(ctx context.Context, client *Client, c *containers.Container) error
type SpecOpts func(context.Context, Client, *containers.Container, *Spec) error
```

[`docs/client-opts.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/client-opts.md) はこのパターンの設計意図を説明した文書で、containerd のクライアント API 全体がこの形で統一されている。

「オプションを関数にする」パターン自体は Go で一般的だが、containerd では **副作用を伴う準備処理まで opts に載せている** のが特徴だ。`WithNewSnapshot` は設定を変えるだけでなく、実際に snapshotter を呼んでディスク上に snapshot を作る。

## なぜそうなっているか

### デーモンの API を「組み合わせ可能な最小単位」に保つため

もしデーモンに「イメージからコンテナを作る」API があったら、その API は次のような判断を内蔵することになる。

- どの snapshotter を使うか
- どのプラットフォームの manifest を選ぶか
- spec のデフォルト値をどうするか
- ラベルをどう付けるか

判断を内蔵するほど、別の使い方をしたい利用者が困る。BuildKit は「コンテナは作らずに snapshot だけ欲しい」し、イメージ変換ツールは「content store だけ使いたい」。**判断をクライアントに委ねると、デーモンは判断しない分だけ汎用になる**。

これは [SCOPE.md の primitives 原則](../scope-and-principles/) の具体化でもある。

### API バージョンの安定性

高レベル API を持たなければ、高レベルな要求の変化で API を変えずに済む。containerd 1.x から 2.x への移行で gRPC API がほぼそのまま維持されたのは、API が低レベルだったからだ。変わったのは主に設定形式とプラグイン ID だった。

### 弱点は「クライアントが正しく振る舞う」前提

この設計は、クライアントが

- リースを取ってから作業する
- 作った資源に適切な GC ラベルを付ける
- 失敗時に後始末する

ことを前提にしている。守られなければ資源が漏れるか、逆に使用中のものが GC される。

containerd はこれを 2 つの方法で緩和している。1 つは Go クライアントライブラリに正しい振る舞いを埋め込むこと (`NewContainer` が自動でリースを取るなど)。もう 1 つは **リースに既定で 24 時間の期限を付ける** こと。それでも、Go 以外の言語でクライアントを書くなら、この規約を自分で守る必要がある。

## どう活かすか

### 自分で containerd を叩くときの作法

Go クライアントを使う場合の最低限の作法は 3 つだ。

```go
// 1. namespace を必ず設定する
ctx := namespaces.WithNamespace(context.Background(), "my-app")

// 2. 複数の資源を作る操作は、リースの中で行う
ctx, done, err := client.WithLease(ctx)
defer done(ctx)

// 3. 高レベル操作は opts の組み合わせで表現する
container, err := client.NewContainer(ctx, id,
    oci.WithNewSpec(oci.WithImageConfig(image), oci.WithProcessArgs("/bin/sh")),
    containerd.WithNewSnapshot(id, image),
)
```

2 番目を忘れると、pull の途中で GC が走って blob が消える、といった再現しにくい問題に当たる。

### 「賢いクライアント」を選ぶ判断基準

サーバ側を薄く、クライアント側を厚くする設計が向くのは、次の条件が揃うときだ。

- **クライアントの種類が複数あり、要求が異なる** — 1 つの高レベル API では満たせない
- **クライアントを更新しやすい** — ライブラリとして配れる。サーバの更新より頻繁でよい
- **サーバの API 安定性が重要** — 長期間、互換性を保つ必要がある

逆に、クライアントが多言語で書かれる、あるいは信頼できない場合には向かない。振る舞いの規約を守らせる手段がなくなるからだ。containerd がリースに期限を付けているのは、この弱点への現実的な対処として参考になる。
