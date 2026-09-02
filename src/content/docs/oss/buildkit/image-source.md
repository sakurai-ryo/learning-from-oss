---
title: "image source の lazy pull"
description: "image source は blob を 1 バイトも落とさずに ref を作る。マニフェストと config だけを取り、レイヤ blob は images.ErrSkipDesc で明示的にスキップし、代わりに DescHandler をキャッシュオプションに載せて「後で取れる手段」だけを渡す。CacheKey が index によって 2 種類のキーを返し分けるのもこのためだ。"
group: "ソースと実行"
sidebar:
  order: 62
---

## 何を学んだか

`FROM ubuntu:24.04` を解くとき、BuildKit はレイヤ blob をダウンロードしない。やることは 3 つだけだ。

1. タグをダイジェストに解決する (`Resolve`)
2. マニフェストと config だけを content store に取る (`PullManifests`)
3. blob を落とす**手段** (`DescHandler`) を作り、`CacheOpts` に載せて上に渡す

その結果できる `ImmutableRef` は中身が空の lazy ref だ。実際に blob が降ってくるのは、誰かがその ref を `Extract` したときになる。lazy ref そのものの仕組みは [lazy ref](../lazy-ref/) にあるので、ここでは **ソース側が何を渡して lazy にしているか**に絞る。

## blob は「明示的にスキップ」される

`PullManifests` はハンドラチェーンを組んで `images.Dispatch` を回す。先頭に置かれるのが `filterLayerBlobs` だ。

```go title="util/pull/pull.go"
	handlers = append(handlers,
		filterLayerBlobs(metadata, &mu),
		retryhandler.New(limited.FetchHandler(p.ContentStore, fetcher, p.ref), logs.LoggerFromContext(ctx)),
		childrenHandler,
		dslHandler,
	)

	if err := images.Dispatch(ctx, images.Handlers(handlers...), nil, p.desc); err != nil {
```

([util/pull/pull.go L151-L160](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/pull/pull.go#L151-L160))

`filterLayerBlobs` は media type を見て、レイヤなら `ErrSkipDesc` を返す。

```go title="util/pull/pull.go"
// filterLayerBlobs causes layer blobs to be skipped for fetch, which is required to support lazy blobs.
// It also stores the non-layer blobs (metadata) it encounters in the provided map.
func filterLayerBlobs(metadata map[digest.Digest]ocispecs.Descriptor, mu sync.Locker) images.HandlerFunc {
	return func(ctx context.Context, desc ocispecs.Descriptor) ([]ocispecs.Descriptor, error) {
		switch desc.MediaType {
		case
			ocispecs.MediaTypeImageLayer,
			// ...
			ocispecs.MediaTypeImageLayerZstd,
			ocispecs.MediaTypeImageLayerNonDistributableZstd:
			return nil, images.ErrSkipDesc
		default:
			if metadata != nil {
				mu.Lock()
				metadata[desc.Digest] = desc
				mu.Unlock()
			}
		}
		return nil, nil
	}
}
```

([util/pull/pull.go L207-L233](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/pull/pull.go#L207-L233))

チェーンの 2 番目が `FetchHandler` — 実際にダウンロードするハンドラだ。`ErrSkipDesc` を返せばそこに到達しない。レイヤ以外 (index / manifest / config) は `metadata` map に溜められ、`Nonlayers` として返る。

戻り値の `PulledManifests` には、レイヤの descriptor 一覧と、**後から blob を取るための Provider** が入る。

```go title="util/pull/pull.go"
	return &PulledManifests{
		Ref:              p.ref,
		MainManifestDesc: p.desc,
		ConfigDesc:       p.configDesc,
		Nonlayers:        p.nonlayers,
		Descriptors:      p.layers,
		Provider: func(g session.Group) content.Provider {
			return &provider{puller: p, resolver: getResolver(g)}
		},
	}, nil
```

([util/pull/pull.go L176-L186](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/pull/pull.go#L176-L186))

`Provider` が `session.Group` を受け取る関数になっているのが重要だ。blob を取るのは将来の話で、そのときに有効なセッション (レジストリの認証情報が流れる経路) はまだ決まっていない。[認証の委譲](../auth-delegation/) の都合を、関数として遅延させている。

## CacheOpts に DescHandler を載せて上に渡す

`puller.CacheKey` は、レイヤごとに `DescHandler` を組み立てる。

```go title="source/containerimage/pull.go"
			p.descHandlers = cache.DescHandlers(make(map[digest.Digest]*cache.DescHandler))
			for i, desc := range p.manifest.Descriptors {
				labels := snapshots.FilterInheritedLabels(desc.Annotations)
				// ...
				p.descHandlers[desc.Digest] = &cache.DescHandler{
					Provider:       p.manifest.Provider,
					Progress:       progressController,
					SnapshotLabels: labels,
					Annotations:    desc.Annotations,
					Ref:            p.manifest.Ref,
				}
			}
```

([source/containerimage/pull.go L159-L175](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/pull.go#L159-L175))

そしてこれを `CacheOpts` に詰めて返す。

```go title="source/containerimage/pull.go"
	cacheOpts = solver.CacheOpts(make(map[any]any))
	for dgst, descHandler := range p.descHandlers {
		cacheOpts[cache.DescHandlerKey(dgst)] = descHandler
	}
```

([source/containerimage/pull.go L201-L204](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/pull.go#L201-L204))

`CacheOpts` は `SourceOp.CacheMap` を経由して `CacheMap.Opts` に載り ([solver/llbsolver/ops/source.go L100-L103](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/source.go#L100-L103))、solver のキャッシュ検索の過程で下流に配られる。**キャッシュキーの一部ではなく、キャッシュキーと一緒に流れる副次情報**という位置づけになる。

なぜキーと一緒に流す必要があるかというと、`FROM ubuntu` の結果がキャッシュにヒットしても、その ref が lazy のままかもしれないからだ。誰かがそれを展開したくなったとき、blob をどこから取ればいいかの情報が必要になる。ヒットしたキャッシュレコードにその情報は入っていないので、今回の resolve が持ってきた `DescHandler` を渡してやる。詳細は [DescHandler と lazy ref](../lazy-ref/) にある。

`Snapshot` は blob を落とさず ref のチェーンを作るだけだ。

```go title="source/containerimage/pull.go"
	var parent cache.ImmutableRef
	setWindowsLayerType := p.Platform.OS == "windows" && runtime.GOOS != "windows"
	for _, layerDesc := range p.manifest.Descriptors {
		parent = current
		current, err = p.CacheAccessor.GetByBlob(ctx, layerDesc, parent,
			p.descHandlers, cache.WithImageRef(p.manifest.Ref))
		if parent != nil {
			parent.Release(context.TODO())
		}
```

([source/containerimage/pull.go L248-L259](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/pull.go#L248-L259))

`GetByBlob` は descriptor から ref を作る。blob が content store に無くても成功する — それが [blob からの ref 生成](../get-by-blob/) の役割だ。ここでも `descHandlers` を渡していて、作られた ref がその後 unlazy されるときに使われる。

## unlazy されるのは Extract を呼ぶ側の都合

`ExecOp.CacheMap` は依存ごとに `PreprocessFunc` を必ず設定する。

```go title="solver/llbsolver/ops/exec.go"
		cm.Deps[i].PreprocessFunc = unlazyResultFunc
```

([solver/llbsolver/ops/exec.go L213](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L213))

中身は `Extract` を呼ぶだけだ。

```go title="solver/llbsolver/ops/file.go"
func unlazyResultFunc(ctx context.Context, res solver.Result, g session.Group) error {
	ref, ok := res.Sys().(*worker.WorkerRef)
	if !ok {
		return errors.Errorf("invalid reference: %T", res)
	}
	if ref.ImmutableRef == nil {
		return nil
	}
	return ref.ImmutableRef.Extract(ctx, g)
}
```

([solver/llbsolver/ops/file.go L699-L708](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/file.go#L699-L708))

つまり **「RUN のためにファイルシステムをマウントする必要が出た」タイミングで初めて blob が降る**。`FROM ubuntu` してその上に `COPY` も `RUN` もせず、そのまま別のレジストリに push するだけなら、blob は BuildKit を一切通らずにレジストリ間で完結できる。ソース側は「取れるようにしておく」だけで、「取るかどうか」を決めない。

## CacheKey が index で 2 種類のキーを返す

`puller.CacheKey` の返り値の分岐がやや込み入っている。

```go title="source/containerimage/pull.go"
	cacheDone = index > 0
	if index == 0 || p.configKey == "" {
		return p.manifestKey, p.manifest.MainManifestDesc.Digest.String(), cacheOpts, cacheDone, nil
	}
	return p.configKey, p.manifest.MainManifestDesc.Digest.String(), cacheOpts, cacheDone, nil
```

([source/containerimage/pull.go L206-L210](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/pull.go#L206-L210))

`index == 0` のときは **manifest key**、それ以降は **config key** を返す。第 4 返り値の `done` が「これ以上キーは増えない」の合図なので、index 0 では `false`、index 1 以降で `true` になる。つまり image source は必ず 2 段階のキーを持つ。

manifest key はマニフェストのダイジェストとプラットフォームから作る。

```go title="source/containerimage/pull.go"
func mainManifestKey(desc ocispecs.Descriptor, platform ocispecs.Platform, layerLimit *int) (digest.Digest, error) {
	dt, err := json.Marshal(struct {
		Digest     digest.Digest
		OS         string
		Arch       string
		// ...
```

([source/containerimage/pull.go L65-L87](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/pull.go#L65-L87))

config key はレイヤの diffID から作った **chain ID** だ。

```go title="source/containerimage/pull.go"
// cacheKeyFromConfig returns a stable digest from image config. If image config
// is a known oci image we will use chainID of layers.
func cacheKeyFromConfig(dt []byte, layerLimit *int) (digest.Digest, error) {
	var img ocispecs.Image
	err := json.Unmarshal(dt, &img)
	// ...
	if img.RootFS.Type != "layers" || len(img.RootFS.DiffIDs) == 0 {
		return "", nil
	}

	return identity.ChainID(img.RootFS.DiffIDs), nil
}
```

([source/containerimage/pull.go L300-L323](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/pull.go#L300-L323))

2 段にする意味は、**マニフェストが違ってもファイルシステムが同じイメージを同一視できる**ことだ。annotation やビルド日時が違うだけの 2 つのイメージは、manifest key では別物だが chain ID は一致する。より緩い後段のキーでヒットさせられる。[キャッシュキーの合成](../cachekey-composition/) で言う、同じ頂点が複数のキーを持てる仕組みがそのまま効いている。

## ResolveMode はレジストリとローカル store の優先順

タグからダイジェストへの解決は `util/resolver` の `Resolver.Resolve` が担い、ここで 3 つのモードが分岐する。

```go title="util/resolver/pool.go"
func (r *Resolver) Resolve(ctx context.Context, ref string) (string, ocispecs.Descriptor, error) {
	if r.mode == ResolveModePreferLocal && r.is != nil {
		if ref, desc, err := r.ResolveLocal(ctx, ref); err == nil {
			return ref, desc, nil
		}
	}

	n, desc, err := r.Resolver.Resolve(ctx, ref)
	if err == nil {
		r.handler.counter.Add(1)
		return n, desc, nil
	}

	if r.mode == ResolveModeDefault && r.is != nil {
		if ref, desc, err := r.ResolveLocal(ctx, ref); err == nil {
			return ref, desc, nil
		}
	}

	return "", ocispecs.Descriptor{}, err
}
```

([util/resolver/pool.go L253-L274](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/resolver/pool.go#L253-L274))

- `ResolveModePreferLocal` — ローカル image store を先に見て、無ければレジストリ
- `ResolveModeDefault` — レジストリを先に見て、**失敗したら**ローカルにフォールバック
- `ResolveModeForcePull` — ローカルを一切見ない (どちらの分岐にも入らない)

`ResolveModeDefault` の「レジストリが失敗したときだけローカル」というのが微妙な選択で、ネットワークが生きている限りは常にレジストリの最新を見る。オフラインや認証エラーのときにだけ手元の image store が救う。

LLB 属性の値と定数名がずれているので注意が要る。

```go title="solver/pb/attr.go"
const AttrImageResolveMode = "image.resolvemode"
const AttrImageResolveModeDefault = "default"
const AttrImageResolveModeForcePull = "pull"
const AttrImageResolveModePreferLocal = "local"
```

([solver/pb/attr.go L43-L46](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/pb/attr.go#L43-L46))

Go の定数は `ForcePull` / `PreferLocal` だが、ワイヤ上の文字列は `pull` / `local` だ。`--build-arg BUILDKIT_INLINE_CACHE` 系のドキュメントや Dockerfile フロントエンドが渡すのは後者になる。

なお、`ResolverTypeOCILayout` (`oci-layout://` ソース) は問答無用で `ResolveModeForcePull` に固定される。

```go title="source/containerimage/source.go"
		mode = resolver.ResolveModeForcePull // with OCI layout, we always just "pull"
```

([source/containerimage/source.go L127](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/source.go#L127))

## config だけ欲しいときの経路は別にある

Dockerfile フロントエンドが `FROM` の base image の env や cmd を知りたいとき、`Snapshot` は要らない。この用途にはソースの `Resolve` を通らない別のメソッドが用意されている。

```go title="source/containerimage/source.go"
func (is *Source) ResolveImageMetadata(ctx context.Context, id *ImageIdentifier, opt *sourceresolver.ResolveImageOpt, sm *session.Manager, g session.Group) (_ *sourceresolver.ResolveImageResponse, retErr error) {
```

([source/containerimage/source.go L161](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/source.go#L161))

フロントエンドから見た名前は `ResolveImageConfig` で、gateway の gRPC メソッドとして露出している ([frontend/gateway/pb/gateway_grpc.pb.go L22](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/gateway/pb/gateway_grpc.pb.go#L22))。worker → source の内側に降りるときに `ResolveSourceMetadata` → `ResolveImageMetadata` と名前が変わる ([worker/base/worker.go L513](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/worker/base/worker.go#L513))。

このパスでは `flightcontrol.Group` によるキーごとの重複排除が効いていて、同じ ref + プラットフォーム + resolve mode の問い合わせは 1 回にまとめられる ([L189-L206](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/source.go#L189-L206))。マルチステージの Dockerfile で同じ base image が何度も出てくるとき、レジストリへの問い合わせは 1 回で済む。

`ResolveModeDefault` のフォールバックがここにも別に書かれているのが目を引く。

```go title="source/containerimage/source.go"
			dgst, dt, err := imageutil.Config(ctx, ref, rslvr, is.ContentStore, is.LeaseManager, opt.Platform)
			if err != nil {
				if rm != resolver.ResolveModeDefault || is.ImageStore == nil {
					return nil, err
				}
				localRslvr := rslvr.WithImageStore(is.ImageStore, resolver.ResolveModePreferLocal)
```

([source/containerimage/source.go L190-L199](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/source.go#L190-L199))

`Resolver.Resolve` のフォールバックはダイジェスト解決までしかカバーしない。config blob の取得が失敗する場合 (解決はできたが blob が引けない) には効かないので、`imageutil.Config` 全体をもう一度ローカル寄りの resolver でやり直している。

## なぜそうなっているか

lazy pull がなければ、`FROM ubuntu` と書いた瞬間に数百 MB が降ってくる。しかしそのイメージのファイルシステムが本当に必要になるのは `RUN` するときだけで、`FROM ... AS base` して結局使われないステージや、レイヤをそのまま別のレジストリに転送するだけのケースでは 1 バイトも要らない。

「必要になるまで取らない」を実現するには、**取れることを示す証拠**を先に持っておく必要がある。それが descriptor (ダイジェスト・サイズ・media type) と `DescHandler` (取ってくる関数) の組だ。マニフェストと config は数 KB なので、これだけは先に取ってしまう。ダイジェストが分かればキャッシュキーが作れるし、config が分かればフロントエンドが必要とするメタデータも揃う。

`Snapshot` の後半で `Nonlayers` を lease に紐づけているのは、この「小さいけど必須のデータ」を守るためだ。

```go title="source/containerimage/pull.go"
	for _, desc := range p.manifest.Nonlayers {
		if _, err := p.ContentStore.Info(ctx, desc.Digest); cerrdefs.IsNotFound(err) {
			// manifest or config must have gotten gc'd after CacheKey, re-pull them
```

([source/containerimage/pull.go L267-L269](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/containerimage/pull.go#L267-L269))

`CacheKey` で取ったマニフェストは一時 lease (5 分) の下にあるので、`Snapshot` までの間に GC される可能性がある。無くなっていたら取り直し、レイヤ ref の lease に付け替えて寿命を揃える。**lazy にした結果として増えた寿命管理の複雑さ**が、ここに素直に出ている。

## どう活かすか

- **「取ってくる」と「取ってこられることを保証する」を分ける。** descriptor + fetcher の組を先に確定させておけば、実際の転送はいつでも遅らせられる。分けるだけで、使われないデータの転送がまるごと消える。
- **遅延した処理に必要な認証情報は、値ではなく関数で持つ。** `Provider func(session.Group) content.Provider` のように、実行時に有効なコンテキストを受け取る形にしておかないと、遅延させた瞬間に認証が切れている。
- **同じ対象に厳しいキーと緩いキーを両方持たせる。** manifest digest と chain ID は「同じイメージ」の定義が違う。緩いほうが多くヒットし、厳しいほうが速く判定できる。両方返せる API 形状 (index でキーを返し分ける) にしておくと使い分けられる。
- **遅延評価を入れたら、遅延している間の寿命管理を必ず設計する。** lazy にしたぶん「まだ使っていないが必要なデータ」が長く生き残る必要があり、GC との調停が新しい仕事として増える。
