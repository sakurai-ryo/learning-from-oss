---
title: "provenance — solver が DAG を歩いて出所を集める"
description: "provenance は 2 つの経路で集まる。ジョブが DAG を辿って各頂点の SourceOp から pin (解決済みダイジェスト) を回収する Capture と、フロントエンドの呼び出しに割り込む provenanceBridge が記録するリクエスト。両者を NewPredicate が SLSA v1 の述語に組み、mode=max なら LLB Definition そのものを buildConfig として埋める。"
group: "結果を出す"
sidebar:
  order: 74
---

## 何を学んだか

BuildKit の provenance は「ビルド中にログを取る」のではなく、**ビルドが終わったあとに DAG を歩いて再構成する**。集める場所が 2 つある。

1. **ジョブが解決済みの DAG を辿る** — 各頂点を訪ね、`SourceOp` なら「どのソースをどのダイジェストに解決したか」、`ExecOp` なら「どの secret / SSH を要求し、ネットワークに出たか」を `Capture` に足す。
2. **`provenanceBridge` がフロントエンドの呼び出しに割り込む** — フロントエンドは gRPC 越しに「このイメージを解決して」「この Definition を解いて」と頼んでくる。その橋に細工をして、リクエストと解決結果を記録する。

そして `Capture` から SLSA 述語を組むのが `NewPredicate`。`mode=max` のときは、さらに **LLB Definition そのものを `buildConfig` として述語に埋める**。これができるのは `ResultProxy` が `Definition()` を持っていて結果から元の DAG に戻れるからだ（[gateway の Reference](../gateway-ref/)）。

## Capture — 集まる先の器

```go title="solver/llbsolver/provenance/capture.go"
type Capture struct {
	Request             provenancetypes.Parameters
	Sources             provenancetypes.Sources
	NetworkAccess       bool
	ProxyNetwork        bool
	IncompleteMaterials bool
	ProxyIncomplete     []provenancetypes.ProxyCaptureIncomplete
	Samples             map[digest.Digest]*resourcestypes.Samples
}
```

([solver/llbsolver/provenance/capture.go L18-L26](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/capture.go#L18-L26))

`Sources` が「材料」で、`Images` / `ImageBlobs` / `Git` / `HTTP` / `Local` の 5 種（[types.go L132-L138](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/types/types.go#L132-L138)）。`Request` が「呼び出しかた」で、`Frontend` / `Args` / `Secrets` / `SSH` / `Locals` / `Inputs` / `Root` を持つ（[types.go L223-L233](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/types/types.go#L223-L233)）。

`Capture` に VCS 情報のフィールドは無い。VCS は `vcs:source` / `vcs:revision` というビルド引数として `Args` に紛れ込んでくるもので、述語を組む段階で抜き出される（後述）。

## 経路 1 — WalkProvenance が DAG を辿る

```go title="solver/llbsolver/provenance.go"
err := res.WalkProvenance(ctx, func(pp solver.ProvenanceProvider) error {
	switch op := pp.(type) {
	case *ops.SourceOp:
		id, pin := op.Pin()
		err := id.Capture(c, pin)
		// ...
	case *ops.ExecOp:
		pr := op.Proto()
		for _, m := range pr.Mounts {
			if m.MountType == pb.MountType_SECRET {
				c.AddSecret(provenancetypes.Secret{ID: m.SecretOpt.GetID(), Optional: m.SecretOpt.GetOptional()})
			}
			// ... SSH も同様
		}
		if pr.Network != pb.NetMode_NONE {
			c.NetworkAccess = true
		}
		// ...
	case *ops.BuildOp:
		c.IncompleteMaterials = true // not supported yet
	}
	return nil
})
```

([solver/llbsolver/provenance.go L313-L379](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L313-L379))

`ProvenanceProvider` はマーカーインターフェース（`IsProvenanceProvider()` の 1 メソッドだけ、[solver/types.go L206-L208](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/types.go#L206-L208)）で、実装は `SourceOp` / `ExecOp` / `BuildOp` の 3 つしかない。

歩き方は `Job.walkProvenance`。**実際にスケジュールされた頂点を辿る**ところがポイントだ。

```go title="solver/jobs.go"
// Walk via the resolved state's inputs when available, so the recursion
// follows the chain that was actually scheduled rather than the caller's
// wrapper graph (which can reference orphan states via the
// dgstWithoutCache shift in loadUnlocked).
inputs := e.Vertex.Inputs()
if st, ok := j.list.actives[e.Vertex.Digest()]; ok {
	// ...
	if wp, ok := st.op.op.(ProvenanceProvider); ok {
		if err := f(wp); err != nil { /* ... */ }
	}
	inputs = st.vtx.Inputs()
```

([solver/jobs.go L828-L845](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/jobs.go#L828-L845))

呼び出し側が持っている頂点のラッパーではなく、solver の `actives` に登録された状態の入力を辿る。[エッジのマージ](../edge-merge/) や `dgstWithoutCache` によるダイジェストのずらしを経ると、呼び出し側のグラフと実際に解かれたグラフは一致しなくなるからだ。

### pin — キャッシュキーが provenance を兼ねる

`SourceOp.Pin()` が返す `pin` は、**キャッシュキーを計算するときに副産物として得られた解決済みの識別子**だ。

```go title="solver/llbsolver/ops/source.go"
k, pin, cacheOpts, done, err := src.CacheKey(ctx, jobCtx, index)
if err != nil {
	return nil, false, err
}

if s.pin == "" {
	s.pin = pin
}
```

([solver/llbsolver/ops/source.go L83-L90](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/source.go#L83-L90))

「`alpine:latest` は `sha256:...` に解決された」「このブランチは `abc123` というコミットだった」は、キャッシュキーを決めるために**どのみち必要な情報**だ。provenance のための追加の解決は 1 つも走らない。

pin をどう `Capture` に落とすかは、ソースの種類ごとに `Identifier.Capture(dest *provenance.Capture, pin string) error` が持つ（[source/identifier.go L22](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/identifier.go#L22)）。git の実装が一番賑やかで、認証に使った secret / SSH も**任意扱いで**足す。

```go title="source/git/identifier.go"
c.AddGit(gs)
if id.AuthTokenSecret != "" {
	c.AddSecret(provenancetypes.Secret{
		ID:       id.AuthTokenSecret,
		Optional: true,
	})
}
```

([source/git/identifier.go L110-L116](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/git/identifier.go#L110-L116))

local ソースだけは pin を捨てて名前しか記録しない（[source/local/identifier.go L37-L42](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/local/identifier.go#L37-L42)）。ローカルディレクトリの内容は再現できないからだ。これが後で「材料が不完全」の判定に効く。URL は `AddGit` / `AddHTTP` の中で必ず `urlutil.RedactCredentials` を通され、`https://user:pass@...` が provenance に漏れない。

## 経路 2 — provenanceBridge が呼び出しに割り込む

DAG を歩くだけでは「どのフロントエンドをどんな引数で呼んだか」は分からない。それを取るために、フロントエンドと solver の間の橋がラップされている。

```go title="solver/llbsolver/provenance.go"
// provenanceBridge provides scoped access to LLBBridge and captures the request it makes for provenance
type provenanceBridge struct {
	*llbBridge
	mu      sync.Mutex
	req     *frontend.SolveRequest
	rootReq *frontend.SolveRequest

	images                 []provenancetypes.ImageSource
	builds                 []resultWithBridge
	subBridges             []*provenanceBridge
	provenanceRefRecordIDs []string
}
```

([solver/llbsolver/provenance.go L40-L51](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L40-L51))

割り込む点は 2 か所。

**`ResolveSourceMetadata`** — フロントエンドがイメージ config を引くたびに解決されたダイジェストを `b.images` に記録する（[provenance.go L159-L176](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L159-L176)）。マルチステージの捨てられるステージの `FROM` も記録される。「ビルド中に参照した」事実は provenance の対象だという判断だ。

**`Solve`** — フロントエンドが別のフロントエンドを呼ぶと、子の `provenanceBridge` が作られてツリーになる。

```go title="solver/llbsolver/provenance.go"
rootReq := b.rootReq
if !hasRequestProvenance(rootReq) {
	rootReq = b.req
}
wb := &provenanceBridge{llbBridge: b.llbBridge, req: &req, rootReq: rootReq}
res, err = f.Solve(ctx, wb, b.llbBridge, req.FrontendOpt, req.FrontendInputs, sid, b.sm)
// ...
b.subBridges = append(b.subBridges, wb)
```

([solver/llbsolver/provenance.go L198-L216](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L198-L216))

`rootReq` を子に引き継いでいるのがポイントだ。`syntax=` ディレクティブで外部フロントエンドを呼ぶ場合（[syntax ディレクティブ](../syntax-directive/)）、ユーザが実際に打ったコマンドは「root のリクエスト」のほうであって、Dockerfile フロントエンドが自分自身を呼び直したときの引数ではない。

```mermaid
flowchart TD
    subgraph paths2["経路 2: provenanceBridge — ビルド中"]
        cli["buildctl のリクエスト<br/>rootReq"]
        cli --> pb0["provenanceBridge (root)"]
        pb0 -->|"Solve(frontend=dockerfile.v0)"| pb1["provenanceBridge (子)<br/>req = FrontendOpt / FrontendInputs"]
        pb1 -->|ResolveSourceMetadata| imgs["images[]<br/>解決済みイメージ digest"]
        pb1 -->|"Solve(Definition)"| builds["builds[]<br/>ResultProxy"]
    end

    subgraph paths1["経路 1: WalkProvenance — ビルド後"]
        job["Job.walkProvenance<br/>actives の頂点を辿る"]
        job -->|SourceOp| pin["id.Capture(c, pin)<br/>image / git / http / local"]
        job -->|ExecOp| exec["secrets / ssh / network<br/>resource samples"]
        job -->|BuildOp| inc["IncompleteMaterials = true"]
    end

    pin --> cap["provenance.Capture"]
    exec --> cap
    inc --> cap
    imgs --> merge["getProvenance<br/>Merge + AddImage + Optimize + Sort"]
    builds --> merge
    cap --> merge
    merge --> np["NewPredicate<br/>SLSA v1 述語"]
    np --> mode{"mode"}
    mode -->|min| scrub["scrubMinRequest<br/>build-arg / label / secrets / ssh を落とす"]
    mode -->|max| bc["AddBuildConfig<br/>LLB Definition を埋める"]
    bc --> layers["addLayers<br/>step ごとのレイヤ digest"]
    scrub --> att["in-toto attestation として結果に付く"]
    layers --> att
```

## 2 つの経路を合わせる

```go title="solver/llbsolver/provenance.go"
visited := reqs.allRes()
visited[ref.ID()] = struct{}{}
// provenance for all the refs not directly in the result needs to be captured as well
if err := br.eachRef(func(r solver.ResultProxy) error {
	if _, ok := visited[r.ID()]; ok {
		return nil
	}
	visited[r.ID()] = struct{}{}
	pr2, err := getRefProvenance(r, br)
	// ...
	return pr.Merge(pr2)
}); err != nil {
	return nil, err
}

imgs := br.allImages()
if id != "" {
	imgs = reqs.filterImagePlatforms(id, imgs)
}
for _, img := range imgs {
	pr.AddImage(img)
}
// ...
pr.Sort()
```

([solver/llbsolver/provenance.go L867-L895](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L867-L895))

「結果に直接含まれていない ref の provenance も集める」というコメントが本質だ。マルチステージビルドで捨てられた中間ステージも、ビルドの材料には違いない。

そのあとで 3 つの整形が入る。`filterImagePlatforms` は、全プラットフォーム分が揃っているイメージについて当該プラットフォームのものだけを残す。`OptimizeImageSources` は、同じ digest がタグ参照とダイジェスト参照の両方で記録されていたらダイジェスト参照を落とす（[capture.go L131-L132](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/capture.go#L131-L132)）。`Sort` はすべてのスライスを安定ソートする——provenance が in-toto blob として digest を持つので、並列に走るスキャンの完了順で出力が変わってはいけない。

## 述語に組む — NewPredicate

```go title="solver/llbsolver/provenance/predicate.go"
for k, v := range req.Args {
	if strings.HasPrefix(k, "vcs:") {
		if k == "vcs:source" {
			v = urlutil.RedactCredentials(v)
		}
		delete(req.Args, k)
		if v != "" {
			vcs[strings.TrimPrefix(k, "vcs:")] = v
		}
	}
}
```

([solver/llbsolver/provenance/predicate.go L240-L250](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/predicate.go#L240-L250))

VCS 情報はここで初めて登場する。ビルド引数の `vcs:` 接頭辞を持つものを `Args` から抜き、`BuildKitMetadata.VCS` に移す。CI が「このビルドはこのリポジトリのこのリビジョンから」という文脈を注入するための穴で、BuildKit 自身は値を検証しない。

材料の完全性は `IncompleteMaterials` と local ソースの有無で決まる。

```go title="solver/llbsolver/provenance/predicate.go"
incompleteMaterials := c.IncompleteMaterials
if !incompleteMaterials {
	if len(c.Sources.Local) > 0 {
		incompleteMaterials = true
	}
}
// ...
Completeness: provenancetypes.BuildKitComplete{
	Request:              c.Request.Frontend != "",
	ResolvedDependencies: !incompleteMaterials,
},
Hermetic: !incompleteMaterials && !c.NetworkAccess,
```

([solver/llbsolver/provenance/predicate.go L262-L285](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/predicate.go#L262-L285))

**local コンテキストを使っていれば hermetic ではない。** ローカルディレクトリの内容は provenance に digest として書けないので、「この provenance だけを見てビルドを再現する」ことはできない。BuildKit はこれを黙って通さず、`ResolvedDependencies: false` として明示する。`complete-materials=true` を指定していればエラーになる。

`configSource` は「コンテキストのどこから来たか」を材料と突き合わせて決める。git リポジトリをコンテキストにしていれば `Sources.Git` に同じ URL があるので、そこからコミットハッシュを引いて `configSource.digest` に入れる（[predicate.go L321-L330](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/predicate.go#L321-L330)）。さらに `FilterArgs` が `cgroup-parent` / `image-resolve-mode` / `platform` / `cache-imports` というホスト固有の引数と、`attest:` 接頭辞のものを落とす（[predicate.go L342-L368](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/predicate.go#L342-L368)）。

## mode — min と max

既定は `max`。`full` は `max` の別名として受け付けられる（[provenance.go L408-L418](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L408-L418)）。

`min` は情報を落とす。

```go title="solver/llbsolver/provenance.go"
for k, v := range req.Args {
	if strings.HasPrefix(k, "build-arg:") || strings.HasPrefix(k, "label:") {
		incomplete = true
		continue
	}
	args[k] = v
}
req.Args = args
// ...
req.Secrets = nil
// ...
req.SSH = nil
```

([solver/llbsolver/provenance.go L541-L557](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L541-L557))

落としたら呼び出し側が `Completeness.Request = false` を立てる。**「情報が無い」と「情報を出さないと決めた」を区別できるようにしている**のが要点だ。

`max` は逆に、LLB Definition そのものを埋める。

```go title="solver/llbsolver/provenance/buildconfig.go"
func AddBuildConfig(ctx context.Context, p *provenancetypes.ProvenancePredicateSLSA1, c *Capture, rp solver.ResultProxy, withUsage bool) (map[digest.Digest]int, error) {
	def := rp.Definition()
	steps, indexes, err := toBuildSteps(def, c, withUsage)
```

([solver/llbsolver/provenance/buildconfig.go L16-L18](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/buildconfig.go#L16-L18))

`rp.Definition()` が呼べることがこの機能の前提だ。フロントエンドが返した結果はいつでも元の [LLB Definition](../llb-definition/) に戻せる、という設計がここに効いている。`toBuildSteps` は Definition をトポロジカル順に並べ、各頂点に `step0`, `step1`, ... の ID を振る。入力参照も `step<N>:<index>` という人間に読める形になる。Dockerfile の中身も `def.Source.Infos` から `SourceInfo` として埋め込まれる（[SourceMap](../source-map/) が運んできた元テキストがそのまま入る）。

ここでセッション固有の属性が落とされる。実行のたびに変わるので、残すと provenance が非決定的になる。

```go title="solver/llbsolver/provenance/buildconfig.go"
if src := op.GetSource(); src != nil {
	for k := range src.Attrs {
		if k == "local.session" || k == "local.unique" {
			delete(src.Attrs, k)
		}
	}
}
```

([solver/llbsolver/provenance/buildconfig.go L92-L98](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance/buildconfig.go#L92-L98))

## addLayers — 遅延評価される部分

`max` ではもう 1 つ、「各ステップがどのレイヤを作ったか」も記録する。キャッシュエクスポータの仕組み（[キャッシュのエクスポート](../cache-export/)）を、レジストリに送らない偽のターゲットとして流用している。

```go title="solver/llbsolver/provenance.go"
addLayers = func(ctx context.Context) error {
	e := newCacheExporter()
	// ...
	if _, err := r.CacheKeys()[0].Exporter.ExportTo(ctx, e, solver.CacheExportOpt{
		ResolveRemotes:  resolveRemotes,
		Mode:            solver.CacheExportModeRemoteOnly,
		ExportRoots:     true,
		IgnoreBacklinks: true,
	}); err != nil {
		return err
	}
	// ...
	m[fmt.Sprintf("step%d:%d", idx, l.index)] = descs
```

([solver/llbsolver/provenance.go L476-L508](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L476-L508))

`cacheExporter` は `Add` で渡された結果から descriptor を拾うだけの空実装だ。

これが遅延されている理由は `Predicate()` の冒頭にある。`p.j.RegisterCompleteTime()` を呼んで `FinishedOn`（ビルド終了時刻）を埋めるので（[provenance.go L646-L651](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L646-L651)）、**provenance の内容が確定するのは、それをエクスポートする直前**でなければならない。だから `ProvenanceProcessor` が結果に足すのは中身ではなく `ContentFunc` だ。

```go title="solver/llbsolver/proc/provenance.go"
res.AddAttestation(p.ID, llbsolver.Attestation{
	Kind: gatewaypb.AttestationKind_InToto,
	// ...
	Path: filename,
	ContentFunc: func(ctx context.Context) ([]byte, error) {
		pr, err := pc.Predicate(ctx)
		if err != nil {
			return nil, err
		}
		return json.MarshalIndent(pr, "", "  ")
	},
})
```

([solver/llbsolver/proc/provenance.go L59-L76](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/proc/provenance.go#L59-L76))

そしてこの `ContentFunc` こそが、[attestation の格納](../attestation-storage/) で見た「フロントエンドは provenance を騙れない」という検査の対象そのものだ。

## ソースポリシーとの関係

[ソースポリシー](../sourcepolicy/) はソースの識別子を書き換える機構で、`docker.io/library/alpine:latest` を特定のダイジェストに固定できる。provenance はソースポリシー適用**後**の解決結果を記録するので、ポリシーで固定した内容がそのまま材料として出る。逆に言えば、provenance を見ればポリシーが実際に効いたかどうかが確認できる。`docs/build-repro.md` がソースポリシーを「ピン留めした依存の再現」の章として置いているのはこのためだ。

## なぜそうなっているか

**なぜ「実行中の記録」ではなく「事後の再構成」なのか。** BuildKit は同じ DAG を複数のジョブで共有する（[ジョブの共有](../job-sharing/)）。ある頂点は別のジョブがすでに実行したものかもしれないし、キャッシュヒットして実行されなかったかもしれない。「実行中に記録する」方式だと、キャッシュヒットしたビルドの provenance が空になる。DAG を歩く方式なら、**キャッシュヒットしたビルドも実行したビルドもまったく同じ provenance を出す**。再現ビルドの検証において、これは必須の性質だ。

**なぜ pin をキャッシュキーの副産物から取るのか。** provenance のために独自に解決すると、「キャッシュキーが見た値」と「provenance が書いた値」がずれる余地が生まれる。同じ値を使えば、この 2 つは定義上一致する。「キャッシュヒットとは何か」を内容ベースで定義し直したこと（[キャッシュヒットとは何か](../what-is-a-cache-hit/)）が、そのまま provenance の正確さになっている。

**なぜフロントエンドの呼び出しを橋でラップするのか。** フロントエンドは gRPC 越しの外部プロセスかもしれず、信用できない。フロントエンド自身に「私はこう呼ばれました」と申告させると、いくらでも嘘をつける。橋は BuildKit 側にあるので、記録される内容はフロントエンドの手が届かない。

**なぜ mode があるのか。** `max` の provenance には Dockerfile 全文と全ビルド引数が入る。ビルド引数に社内 URL やトークンの ID が混ざっていることは珍しくないし、公開レジストリに push するイメージにそれを載せたくはない。かといって単に消すと、消したことすら分からない。`min` は「落とした」という事実を `Completeness.Request = false` で残す。

## どう活かすか

- **「何をしたか」の記録を、実行時のフックではなく事後のグラフ走査で作る。** 実行時フックは「実行しなかった経路」を記録できない。キャッシュや共有がある系では、事後にグラフを歩くほうが結果が安定する。
- **監査ログの値は、業務処理が既に計算している値から取る。** BuildKit の pin はキャッシュキーの副産物だ。監査のために独立に計算すると両者がずれる可能性が生まれ、しかもそのずれは滅多に起きないので発見が遅れる。
- **信用できない側からの申告ではなく、自分が持っている境界で記録する。** `provenanceBridge` は「フロントエンドに自己申告させる」の代わりに「フロントエンドが必ず通る場所を計測する」を選んだ。API の境界そのものが計測点になる。
- **落とした情報は「落とした」と記録する。** `min` モードの `Completeness.Request = false` がその形。フィールドが空なのが「元から無い」のか「意図的に消した」のかを、消費者が区別できるようにする。
- **ハッシュされる成果物を作るなら、生成過程のすべての非決定性を潰す。** マップの反復順、並列処理の完了順、セッション ID のような実行ごとに変わる属性。BuildKit は `Sort`、`local.session` / `local.unique` の削除、`RedactCredentials` の 3 つで潰している。
- **確定時刻が最後になる値は、値ではなく関数を渡す。** `ContentFunc` にしておけば「いつ評価するか」を呼び出し側が決められる。BuildKit の場合はこれが偶然にも信頼境界（Go のクロージャは gRPC を越えない）にもなっている。
