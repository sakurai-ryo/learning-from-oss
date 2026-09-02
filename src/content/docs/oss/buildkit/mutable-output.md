---
title: "mutableOutput — ビルドコンテキストを後から埋める"
description: "LLB の State はイミュータブルだが、ビルドコンテキストだけは DAG を全部組み立てた後でないと確定しない。3 行の mutableOutput 型がその穴を埋める仕組みと、なぜ穴が必要なのかを読む。"
group: "Dockerfile を LLB にする"
sidebar:
  order: 24
---

## 何を学んだか

`llb.State` はイミュータブルで、操作するたびに新しい `State` が返る。ところが Dockerfile の変換には、**DAG を全部組み立て終わるまで内容が決まらない葉**が 1 つある。ビルドコンテキストだ。どのパスを転送すべきかは、全ステージの `COPY` を見終わるまで分からない。

BuildKit はこれを、3 行の型で解いている。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
type mutableOutput struct {
	llb.Output
}
```

([convert.go L1910](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L1910))

インターフェースを埋め込んだだけの構造体だ。`*mutableOutput` は `llb.Output` を満たすので `llb.NewState` に渡せるが、埋め込みフィールドは `nil` のまま置ける。参照を先に配り、実体は後で代入する。ポインタなので、その代入は既に配った全ての `State` に一斉に効く。

## ソースコードのどこか

### llb.Output は 2 メソッドしかない

このトリックが成立するのは、`Output` が極端に小さいインターフェースだからだ。

```go title="client/llb/state.go"
type Output interface {
	ToInput(context.Context, *Constraints) (*pb.Input, error)
	Vertex(context.Context, *Constraints) Vertex
}
```

([client/llb/state.go L22](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/state.go#L22))

どちらも marshal のときにしか呼ばれない。`State` を構築・変形している間、`Output` のメソッドは 1 度も呼ばれない。だから `nil` を包んだままグラフを組み立てられる。

### 生成 — dispatchStages の 1 行目

`mutableOutput` はフェーズ 8 の先頭で作られる。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
func (dctx *dispatchContext) dispatchStages(ctx context.Context, allReachable map[*dispatchState]struct{}, target *dispatchState) (map[string]struct{}, *mutableOutput, error) {
	buildContext := &mutableOutput{}
	ctxPaths := map[string]struct{}{}
```

([convert.go L760-L762](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L760-L762))

そして各ステージの `dispatchOpt` に、`State` に包んで載る。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
		dopt := dispatchOpt{
			// ...
			buildContext:        llb.NewState(buildContext),
			// ...
		}
```

([convert.go L825-L846](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L825-L846))

`llb.NewState` は `.Dir("/")` と `ensurePlatform()` を呼ぶが、どちらも `Output` のメソッドは触らない。`ensurePlatform` は `s.out` が `Platform() *ocispecs.Platform` を持つかを型アサーションで確かめるだけで、`*mutableOutput` は持たないので何も起きない ([client/llb/state.go L69](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/state.go#L69))。

`dopt.buildContext` は 3 箇所で使われる。

- `ADD` のソース (`source: opt.buildContext`)
- `--from` のない `COPY` のソース (`l := opt.buildContext`)
- `--mount` で `from` が指定されていない場合のマウント元 ([convert_runmount.go L72](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert_runmount.go#L72))

つまり `COPY . /app` は、この時点では**「まだ中身の決まっていない何か」から `/app` へコピーする FileOp** として組み立てられる。

### 収集 — ctxPaths

dispatch の途中で、コンテキストから読まれたパスが記録されていく。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
			if len(cmd.sources) == 0 {
				for _, src := range c.SourcePaths {
					d.ctxPaths[path.Join("/", filepath.ToSlash(src))] = struct{}{}
				}
			}
```

([convert.go L1146-L1150](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L1146-L1150))

記録されるのは `dispatchCopy` が成功した後だ。ここで `c.SourcePaths` は**変数展開済み**の値になっている。`COPY ${DIR}/main.go /` の `${DIR}` を展開する前にパスを集めてしまうと、転送対象を絞りすぎてビルドが壊れる。

`ADD` については、HTTP の URL がコンテキストのパスとして記録されないよう除外されている ([convert.go L1092-L1096](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L1092-L1096))。

ステージごとの `d.ctxPaths` は、ループの中で全体の `ctxPaths` に合流する。

### 代入 — finalizeResultImage

全ステージの dispatch が終わってから、実体が作られて代入される。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
	opts := filterPaths(ctxPaths)
	bctx := dctx.opt.MainContext
	if dctx.opt.Client != nil {
		var err error
		bctx, err = dctx.opt.Client.MainContext(ctx, opts...)
		if err != nil {
			return err
		}
	} else if bctx == nil {
		bctx = dockerui.DefaultMainContext(opts...)
	}

	buildContext.Output = bctx.Output()
```

([convert.go L901-L913](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L901-L913))

`filterPaths` は `normalizeContextPaths` を通して `ctxPaths` を `llb.FollowPaths` に変換する。ただしパスに `/` が含まれていたら絞り込みを諦めて `nil` を返す。`COPY . /app` は `path.Join("/", ".")` で `/` になるので、これが 1 つでもあればコンテキスト全体が転送される。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
	pathSlice := make([]string, 0, len(paths))
	for p := range paths {
		if p == "/" {
			return nil
		}
		pathSlice = append(pathSlice, path.Join(".", p))
	}

	slices.Sort(pathSlice)
	return pathSlice
```

([convert.go L1855-L1864](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L1855-L1864))

`slices.Sort` があるのは、map の反復順が Go では非決定的だからだ。ソートしなければ、同じ Dockerfile から実行のたびに違う LLB ダイジェストが出て、キャッシュが当たらなくなる ([決定的な marshal](../deterministic-marshal/))。

代入の後、`Dockerfile2LLB` は `dispatchState.state` を返し、呼び出し側が `Marshal` する。marshal の中で `ToInput` / `Vertex` が呼ばれて初めて、埋め込みフィールドが読まれる。**`nil` である期間は `toDispatchState` の内側に完全に閉じている。**

### 兄弟 — asyncLocalOutput

同じ埋め込みトリックが `frontend/dockerui` にもある。ただしこちらは代入ではなく `sync.Once` で構築を遅らせる。

```go title="frontend/dockerui/namedcontext.go"
// asyncLocalOutput is an llb.Output that computes an llb.Local
// on-demand instead of at the time of initialization.
type asyncLocalOutput struct {
	llb.Output
	name             string
	// ...
	extraOpts        func() []llb.LocalOption
	once             sync.Once
}

func (a *asyncLocalOutput) ToInput(ctx context.Context, constraints *llb.Constraints) (*pb.Input, error) {
	a.once.Do(a.do)
	return a.Output.ToInput(ctx, constraints)
}

func (a *asyncLocalOutput) Vertex(ctx context.Context, constraints *llb.Constraints) llb.Vertex {
	a.once.Do(a.do)
	return a.Output.Vertex(ctx, constraints)
}
```

([frontend/dockerui/namedcontext.go L310-L331](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerui/namedcontext.go#L310-L331))

`do()` の中で `extraOpts()` を呼び、`llb.Local` を作って `a.Output` に入れる。`extraOpts` は `dispatchState.asyncLocalOpts` — すなわち `filterPaths(ds.paths)` だ ([convert.go L1205](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L1205))。

2 つの型の違いは、**誰が「もう決まった」と知っているか**にある。メインのビルドコンテキストは `finalizeResultImage` という決まった時点があるので、外から代入する。`--build-context foo=<ローカルディレクトリ>` の方は、そのコンテキストがどのステージにどう使われるか変換中は分からないので、「最初に読まれたとき」まで待つ。どちらも埋め込みを使うが、確定のトリガが違う。

## なぜそうなっているか

なぜ後埋めが必要なのか。素直に考えれば、dispatch を 2 回走らせればいい。1 回目でパスを集め、2 回目で本物のコンテキストを使って組み立て直す。しかし `dispatchRun` や `dispatchCopy` はレジストリ解決やチェックサム検証を含むので、2 回走らせるのは高くつくうえ、副作用の冪等性を保証しなければならなくなる。

もう 1 つの案は、ビルドコンテキストを常に丸ごと転送することだ。これは実装としては最も単純だが、実用にならない。`node_modules` を含むリポジトリで `COPY package.json .` をするだけのステージが、数百 MB を転送することになる。`llb.FollowPaths` による絞り込みは BuildKit の転送量を決める中心的な最適化で、`.dockerignore` と並んで効く ([local source](../local-source/))。

だから「DAG を作りながらパスを集め、最後に葉を差し替える」という形になる。イミュータブルなグラフに 1 箇所だけ可変の穴を開けたわけだが、その穴は次の 3 つで塞がれている。

1. **型が 1 つで、名前が意図を言っている。** `mutableOutput` を grep すれば、可変な箇所は全部出てくる (定義 1 + 生成 1 + シグネチャ 1 + 代入 1)。
2. **可変である期間が関数スコープに閉じている。** `toDispatchState` から出た時点で代入は終わっている。呼び出し側は普通の `llb.State` を受け取る。
3. **`Output` のメソッドが marshal でしか呼ばれない。** 構築フェーズと marshal フェーズが分かれている `llb` の設計に、この穴が乗っている。

裏返せば、`Output` にメソッドを 1 つ足して構築中に呼ぶようにした瞬間、この型は nil panic を起こす。`llb` の 2 メソッド・インターフェースは、こういう遅延実装を成立させるための余白でもある。

## どう活かすか

- **「後から決まる」を型で 1 箇所に閉じ込める。** 全体を遅延評価にしたり、ビルダに `SetContext` を生やしたりするのではなく、遅延したい 1 つのノードだけを専用の型にする。可変性の範囲が `grep` 1 回で分かる。
- **インターフェースを小さく保つと、遅延実装が書ける。** `llb.Output` が 2 メソッドだから、埋め込み 1 行で「後で埋める」型が書ける。10 メソッドあったら、`asyncLocalOutput` は全部を `once.Do` 付きで書き直す羽目になる。
- **構築フェーズと直列化フェーズを分けると、構築中は不完全でよくなる。** 「使われるまでに揃っていればよい」を成立させるのは、この 2 フェーズ構造だ。構築と同時に検証・直列化する設計では、この手は使えない。
- **map から出す順序は必ずソートする。** `filterPaths` の `slices.Sort` は 1 行だが、これがないとキャッシュが確率的に外れる。決定性を要求する出力に map を経由させたら、必ず順序を固定する。
