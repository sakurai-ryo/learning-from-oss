---
title: "handler を合成して、イメージのグラフを辿る"
description: "「descriptor を受け取り、子の descriptor を返す」関数を Handler と呼ぶ。fetch も、ラベル付けも、プラットフォームの絞り込みも、全部この形をしている。それらを Handlers() で並べ、Dispatch() で並列に辿れば、pull も export も GC も同じ道具で書ける。"
group: "イメージを取り込む"
sidebar:
  order: 29
---

## 何を学んだか

### Handler は 1 つの関数型

```go
type HandlerFunc func(ctx context.Context, desc ocispec.Descriptor) (subdescs []ocispec.Descriptor, err error)
```

descriptor を受け取り、**その子の descriptor を返す**。これだけだ。

この形に当てはまるものが驚くほど多い。

| 実装                   | やること                        | 返す子                 |
| ---------------------- | ------------------------------- | ---------------------- |
| `ChildrenHandler`      | blob を読んで manifest を parse | manifest の子          |
| `remotes.FetchHandler` | blob をレジストリから取得       | (取得だけ)             |
| `SetChildrenLabels`    | 子に対する GC ラベルを付ける    | 受け取った子をそのまま |
| `FilterPlatforms`      | プラットフォームで絞る          | 絞った後の子           |
| `LimitManifests`       | manifest の数を制限する         | 上位 n 個              |
| `SetReferrers`         | referrer (署名など) を子に追加  | 子 + referrer          |

### 合成と走査が分かれている

- `Handlers(h1, h2, h3)` — 順に実行し、**子を連結** して返す 1 つの Handler にする
- `Walk(handler, descs...)` — 逐次的に辿る
- `Dispatch(handler, limiter, descs...)` — **並列に** 辿る。同時実行数を semaphore で制限

pull は `Dispatch`、export は `Walk` を使う。**辿り方を変えても handler は共通** だ。

### 制御用のエラー 2 種

- `ErrSkipDesc` — この descriptor とその子孫を処理しない
- `ErrStopHandler` — この descriptor に対する **後続の handler** を呼ばない (子孫の処理は続く)

エラー型で制御フローを表現している。Go では `errors.Is` で判定するので、ラップしても効く。

## ソースコードのどこか

### 合成

[`core/images/handlers.go#L63-L83`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/images/handlers.go#L63-L83)。

```go title="core/images/handlers.go"
// Handlers returns a handler that will run the handlers in sequence.
//
// A handler may return `ErrStopHandler` to stop calling additional handlers
func Handlers(handlers ...Handler) HandlerFunc {
	return func(ctx context.Context, desc ocispec.Descriptor) (subdescs []ocispec.Descriptor, err error) {
		var children []ocispec.Descriptor
		for _, handler := range handlers {
			ch, err := handler.Handle(ctx, desc)
			if err != nil {
				if errors.Is(err, ErrStopHandler) {
					break
				}
				return nil, err
			}

			children = append(children, ch...)
		}

		return children, nil
	}
}
```

各 handler が返した子を **連結** する。だから「fetch する handler」と「children を返す handler」を並べれば、取得しながら辿れる。

### 並列走査

[`core/images/handlers.go#L156-L188`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/images/handlers.go#L156-L188)。

```go title="core/images/handlers.go"
func Dispatch(ctx context.Context, handler Handler, limiter *semaphore.Weighted, descs ...ocispec.Descriptor) error {
	eg, ctx2 := errgroup.WithContext(ctx)
	for _, desc := range descs {
		if limiter != nil {
			if err := limiter.Acquire(ctx, 1); err != nil {
				return err
			}
		}

		eg.Go(func() error {
			desc := desc

			children, err := handler.Handle(ctx2, desc)
			if limiter != nil {
				limiter.Release(1)
			}
			if err != nil {
				if errors.Is(err, ErrSkipDesc) {
					return nil // don't traverse the children.
				}
				return err
			}

			if len(children) > 0 {
				return Dispatch(ctx2, handler, limiter, children...)
			}

			return nil
		})
	}

	return eg.Wait()
}
```

再帰的に並列化される。manifest を取得したら、その config と layer を並列に取得し、さらにその子を…という展開になる。

`limiter` の解放位置が重要だ。**子を辿る前に解放している**。もし子の処理まで保持していたら、深いグラフで枠が枯渇してデッドロックする (親が子を待ち、子は枠を待つ)。

`errgroup.WithContext` なので、どれか 1 つが失敗すれば `ctx2` がキャンセルされ、他の取得も止まる。

### 逐次走査と「空だった」の検出

[`core/images/handlers.go#L88-L140`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/images/handlers.go#L88-L140)。

```go title="core/images/handlers.go"
// WalkNotEmpty works the same way Walk does, with the exception that it ensures that
// some children are still found by Walking the descriptors (for example, not all of
// them have been filtered out by one of the handlers). If there are no children,
// then an ErrEmptyWalk error is returned.
func WalkNotEmpty(ctx context.Context, handler Handler, descs ...ocispec.Descriptor) error {
```

プラットフォームで絞った結果、**1 つも残らなかった** ことを検出する。`linux/arm64` のノードで amd64 専用イメージを pull すると、成功したように見えて中身が空、という事態を防ぐ。

エラーメッセージが `image might be filtered out` (フィルタで落ちたかもしれない) と、断定を避けた表現になっている。

### プラットフォームの絞り込み

[`core/images/handlers.go#L292-L313`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/images/handlers.go#L292-L313)。

```go title="core/images/handlers.go"
func FilterPlatforms(f HandlerFunc, m platforms.Matcher) HandlerFunc {
	return func(ctx context.Context, desc ocispec.Descriptor) ([]ocispec.Descriptor, error) {
		children, err := f(ctx, desc)
		...
			for _, d := range children {
				if d.Platform == nil || m.Match(*d.Platform) {
					descs = append(descs, d)
				}
			}
```

`d.Platform == nil` なら通す。**プラットフォームが指定されていない descriptor は、どのプラットフォームでも必要かもしれない** ものとして扱う。config や layer には Platform が付かないので、この条件がないと全部落ちる。

`LimitManifests` は絞り込んだうえで上位 n 個に制限する。「マルチアーキイメージから 1 つだけ取る」がこれで表現される。

### referrer の合流

[`core/images/handlers.go#L203-L232`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/images/handlers.go#L203-L232)。

```go title="core/images/handlers.go"
func SetReferrers(refProvider content.ReferrersProvider, f HandlerFunc) HandlerFunc {
	return func(ctx context.Context, desc ocispec.Descriptor) ([]ocispec.Descriptor, error) {
		children, err := f(ctx, desc)
		...
		if !IsManifestType(desc.MediaType) && !IsIndexType(desc.MediaType) {
			return children, nil
		}
		refs, err := refProvider.Referrers(ctx, desc)
		...
		children = slices.Grow(children, len(refs))
```

署名や SBOM といった「このイメージを参照している別の artifact」を、**子として合流させる**。グラフの外側にあるものを、辿りの対象に組み込む形だ。

handler を 1 つラップするだけで、pull の対象が広がる。

## なぜそうなっているか

### 1 つの走査アルゴリズムを使い回す

イメージのグラフを辿る処理は、pull、push、export、GC のラベル付け、イメージ変換、と何度も必要になる。それぞれが独自に辿ると、

- 新しい mediaType への対応が場所ごとに漏れる
- 並列化やエラー処理の質がばらつく
- プラットフォームの絞り込みルールが微妙に違う

`Handler` という 1 つの形に統一すれば、辿りの実装は `Walk` と `Dispatch` の 2 つだけになる。

### 関数合成にすると、機能の足し引きが宣言的になる

pull の handler チェーンはこう組み立てられる (概念的には)。

```go
handler := images.Handlers(
	remotes.FetchHandler(store, fetcher),        // 取得する
	images.ChildrenHandler(store),               // 子を返す
	images.SetChildrenLabels(store, childrenH),  // GC ラベルを付ける
	images.FilterPlatforms(childrenH, platform), // 絞る
)
```

「署名も取る」なら `SetReferrers` を足す。「layer は取らない」なら `ChildGCLabelsFilterLayers` に差し替える。**機能の有無が、リストへの要素の足し引き** になる。

### エラーで制御フローを表す是非

`ErrSkipDesc` / `ErrStopHandler` は、戻り値ではなくエラーで制御を表現している。Go では議論のある書き方だが、この場合は妥当に働いている。

- handler のシグネチャを変えずに、後から制御を足せた
- `errors.Is` で判定するので、途中でラップされても効く
- 「異常」ではなく「早期終了」を表すことがコメントで明示されている

一方で、ドキュメントを読まないと `ErrStopHandler` と `ErrSkipDesc` の違いが分からない。コメントで「これは 1 つの descriptor に対してのみ効き、子孫には影響しない」と補っている。

## どう活かすか

### 独自の pull 処理を書く

containerd のクライアントライブラリを使えば、handler を差し込んで pull の挙動を変えられる。

```go
// 特定のラベルを持つ layer だけ取得する、といった加工ができる
myHandler := images.HandlerFunc(func(ctx context.Context, desc ocispec.Descriptor) ([]ocispec.Descriptor, error) {
	if shouldSkip(desc) {
		return nil, images.ErrSkipDesc
	}
	return nil, nil
})
```

イメージの一部だけを取得する、取得前に検証する、といった処理が handler として書ける。

### 「ノードを受け取り子を返す」インターフェース

グラフ構造を扱うコードを書くとき、この形は再利用性が高い。

- **ノードを受け取り、子のリストを返す 1 つの関数型に統一する**
- **合成 (順に実行して結果を連結) を用意する**
- **走査は逐次版と並列版の 2 つだけ用意する** — 制限つき並列は semaphore で
- **早期終了を表す番兵エラーを定義する** — 「このノードだけ」と「この枝ごと」を区別する

並列版を書くときは、**枠の解放位置** に注意する。子を辿る前に解放しないと、深いグラフで自己デッドロックする。containerd の `Dispatch` はこの点が明確に書かれていて、そのまま参考にできる。
