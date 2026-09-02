---
title: "named context がステージ名を乗っ取る"
description: "--build-context foo=... は追加のビルドコンテキストを渡すだけの機能ではない。Dockerfile 中のステージ名やイメージ名と同じ名前を与えると、その解決先が丸ごと差し替わる。乗っ取りが起きる 2 つの地点と優先順位を convert.go と dockerui から読む。"
group: "Dockerfile を LLB にする"
sidebar:
  order: 26
---

## 何を学んだか

`--build-context <name>=<spec>` は、名前付きのビルドコンテキストをビルドに追加する。だがこの機能の本質は「コンテキストを増やす」ことではなく、**Dockerfile 中の名前の解決先を外から差し替える**ことだ。

- `--build-context alpine=docker-image://alpine:3.20` は、Dockerfile の `FROM alpine` の解決先を差し替える。
- `--build-context build=local:./prebuilt` は、`FROM golang AS build` というステージを**丸ごと置き換える**。ステージの中に書かれた `RUN` も `COPY` も一切実行されない。

差し替えの判定は 2 箇所で、順序が決まっている。ステージ名の判定が先、ベースイメージ名の判定が後で、その間に「同じ Dockerfile 内の前のステージ」の解決が挟まる。この順序が優先順位そのものになっている。

## ソースコードのどこか

### 名前の正規化とキーの引き方

named context はゲートウェイのオプション `context:<name>` として届く。`dockerui.Client` がその引き方を持っている。

```go title="frontend/dockerui/config.go"
func (bc *Client) NamedContext(name string, opt ContextOpt) (*NamedContext, error) {
	named, err := reference.ParseNormalizedNamed(name)
	if err != nil {
		return nil, errors.Wrapf(err, "invalid context name %s", name)
	}
	name = strings.TrimSuffix(reference.FamiliarString(named), ":latest")

	var pp ocispecs.Platform
	if opt.Platform != nil {
		pp = *opt.Platform
	} else {
		pp = platforms.DefaultSpec()
	}
	pname := name + "::" + platforms.FormatAll(platforms.Normalize(pp))
	nc, err := bc.namedContext(name, pname, opt)
	if err != nil || nc != nil {
		return nc, err
	}
	return bc.namedContext(name, name, opt)
}
```

([frontend/dockerui/config.go L476](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerui/config.go#L476))

2 段構えになっている。

**正規化。** `ParseNormalizedNamed` → `FamiliarString` → `:latest` の除去、という往復で、`docker.io/library/alpine:latest` も `alpine` も同じキー `alpine` になる。これが必要なのは、呼び出し側が渡してくる名前がすでに正規化済みだからだ。`resolveBaseImage` は `d.stage.BaseName = reference.TagNameOnly(ref).String()` で `FROM alpine` を `docker.io/library/alpine:latest` に膨らませてから named context を引きにいく。ユーザーが `--build-context alpine=...` と短く書けるのは、ここで元に戻しているおかげだ。

**platform 修飾を先に試す。** `alpine::linux/arm64` というキーを先に引き、なければ `alpine` を引く。マルチプラットフォームビルドで、アーキテクチャごとに別のコンテキストを与えられる。

実際のルックアップはマップ 1 回だ。

```go title="frontend/dockerui/namedcontext.go"
func (bc *Client) namedContext(name string, nameWithPlatform string, opt ContextOpt) (*NamedContext, error) {
	opts := bc.bopts.Opts
	contextKey := contextPrefix + nameWithPlatform
	v, ok := opts[contextKey]
	if !ok {
		return nil, nil
	}
	sharedKey := opts["sharedkey:localdir:"+nameWithPlatform]
	// ...
}
```

([frontend/dockerui/namedcontext.go L38](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerui/namedcontext.go#L38))

見つからなければ `(nil, nil)` を返す。呼び出し側は `nc == nil` を「差し替えなし」として扱う。

### スキーム

`NamedContext.load` は、値を最初の `:` で 2 分割してスキームで分岐する。

```go title="frontend/dockerui/namedcontext.go"
	vv := strings.SplitN(nc.input, ":", 2)
	if len(vv) != 2 {
		return nil, nil, errors.Errorf("invalid context specifier %s for %s", nc.input, nc.nameWithPlatform)
	}

	// allow git@ without protocol for SSH URLs for backwards compatibility
	if strings.HasPrefix(vv[0], "git@") {
		vv[0] = "git"
	}

	switch vv[0] {
	case "docker-image": // ...
	case "git": // ...
	case "http", "https": // ...
	case "oci-layout": // ...
	case "local": // ...
	case "input": // ...
	default:
		return nil, nil, errors.Errorf("unsupported context source %s for %s", vv[0], nc.nameWithPlatform)
	}
```

([frontend/dockerui/namedcontext.go L61-L307](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerui/namedcontext.go#L61-L307))

BuildKit 側が理解するスキームはこの 7 つだけだ。`docker-image` と `oci-layout` と `input` はイメージ config を返せるので、差し替え先が `FROM` のベースになったときに `ENV` や `WORKDIR` を引き継げる。`git` / `http` / `local` は config を持たないので、ファイルシステムだけが渡る。

3 つのスキームに、それぞれ固有の仕掛けがある。

**`docker-image` の scratch 特例と、非イメージへの再解決。**

```go title="frontend/dockerui/namedcontext.go"
		ref := strings.TrimPrefix(vv[1], "//")
		if ref == EmptyImageName {
			st := llb.Scratch()
			return &st, nil, nil
		}
```

`--build-context base=docker-image://scratch` で、あるステージのベースを空にできる。

解決の途中で `ResolveToNonImageError` が返ると、**オプションを書き換えて自分を再帰的に呼び直す**。

```go title="frontend/dockerui/namedcontext.go"
			e := &imageutil.ResolveToNonImageError{}
			if errors.As(err, &e) {
				before, after, ok := strings.Cut(e.Updated, "://")
				// ...
				nc.bc.bopts.Opts[contextPrefix+nc.nameWithPlatform] = before + ":" + after

				ncnew, err := nc.bc.namedContext(nc.name, nc.nameWithPlatform, nc.opt)
				// ...
				return ncnew.load(ctx, count+1)
			}
```

([frontend/dockerui/namedcontext.go L106-L124](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerui/namedcontext.go#L106-L124))

これはソースポリシー ([source policy](../sourcepolicy/)) が `docker-image://foo` を `git://...` に書き換えたときに起きる。書き換え後のスキームで解決し直す必要があるので、オプションマップ自体を更新して `load` をやり直す。だから再帰上限がある。

```go title="frontend/dockerui/namedcontext.go"
	maxContextRecursion = 10
	// ...
	if count > maxContextRecursion {
		return nil, nil, errors.New("context recursion limit exceeded; this may indicate a cycle in the provided source policies: " + nc.input)
	}
```

エラーメッセージが原因の見当 (ソースポリシーの循環) まで書いている。

**`local` は解決中に 1 回 solve する。** `.dockerignore` を読むためだ。

```go title="frontend/dockerui/namedcontext.go"
		st := llb.Local(vv[1],
			llb.SessionID(sessionID),
			llb.FollowPaths([]string{DefaultDockerignoreName}),
			// ...
		)
		def, err := st.Marshal(ctx)
		// ...
		res, err := nc.bc.client.Solve(ctx, client.SolveRequest{
			Evaluate:   true,
			Definition: def.ToPB(),
		})
```

`.dockerignore` 1 ファイルだけを `FollowPaths` で取ってきて中身を読み、除外パターンを確定させてから本命の `llb.Local` を作る。ただしその本命は `asyncLocalOutput` に包まれ、marshal されるまで作られない ([mutableOutput](../mutable-output/))。転送するパスの集合が、そのコンテキストを使うステージの dispatch が終わるまで決まらないからだ。

**`input` はゲートウェイの入力を引く。** `bc.client.Inputs(ctx)` が返す `map[string]llb.State` から取り出し、`input-metadata:<name>` オプションに JSON で入っているイメージ config を `WithImageConfig` で被せる。フロントエンドを呼び出す側が、既に解決済みの `llb.State` をそのまま渡す経路だ ([gateway の ref](../gateway-ref/))。

### 乗っ取りが起きる 2 地点

`dockerfile2llb` 側は、`namedContextFunc` で包んだ関数を通して `dockerui` を呼ぶ。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
func namedContextFunc(opt ConvertOpt) func(string, dockerui.ContextOpt) (*dockerui.NamedContext, error) {
	return func(name string, copt dockerui.ContextOpt) (*dockerui.NamedContext, error) {
		if opt.Client == nil {
			return nil, nil
		}
		if !strings.EqualFold(name, "scratch") && !strings.EqualFold(name, "context") {
			if copt.Platform == nil {
				copt.Platform = opt.TargetPlatform
			}
			return opt.Client.NamedContext(name, copt)
		}
		return nil, nil
	}
}
```

([convert.go L221](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L221))

`scratch` と `context` の 2 つは予約語として除外される。大文字小文字を無視するので `SCRATCH` も守られる。`FROM scratch` の意味を外から変えられたら、Dockerfile が何を意味するか誰にも分からなくなる。

**地点 1: ステージ名 (フェーズ 4)。**

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
		if st.Name != "" {
			nc, err := dctx.namedContext(st.Name, dockerui.ContextOpt{
				Platform:       ds.platform,
				ResolveMode:    dctx.opt.ImageResolveMode.String(),
				AsyncLocalOpts: ds.asyncLocalOpts,
			})
			if err != nil {
				return err
			}
			if nc != nil {
				ds.namedContext = nc
				dctx.allDispatchStates.addState(ds)
				ds.base = nil // reset base set by addState
				continue
			}
		}
```

([convert.go L460-L475](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L460-L475))

引数は `st.Name` — `FROM golang AS build` の `build` の方だ。マッチしたら `ds.base = nil` でベースへの辺を切り、`continue` でループの残り (`cmdTotal` の集計など) を飛ばす。

そして `resolveBaseImage` は `namedContext` が入っているステージを見つけると、そこで打ち切る。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
		if d.namedContext != nil {
			st, img, err := d.namedContext.Load(ctx)
			if err != nil {
				return err
			}
			d.dispatched = true
			d.state = *st
			if img != nil {
				img.Created = nil
				d.image = *img
				// ...
			}
			return nil
		}
```

([convert.go L641-L664](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L641-L664))

`d.dispatched = true` が肝で、フェーズ 8 の `dispatchStages` はこのフラグが立っているステージをスキップする。**ステージの中身は 1 命令も dispatch されない。**ステージ名を named context で上書きするというのは、そういう意味だ。

**地点 2: ベースイメージ名 (フェーズ 7)。**

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
		nc, err := dctx.namedContext(d.stage.BaseName, dockerui.ContextOpt{
			ResolveMode:    dctx.opt.ImageResolveMode.String(),
			Platform:       platform,
			AsyncLocalOpts: d.asyncLocalOpts,
		})
		if err != nil {
			return err
		}
		if nc != nil {
			st, img, err := nc.Load(ctx)
			// ...
			d.baseImg = cloneX(img) // immutable
			img.Created = nil
			d.image = *img
			d.state = st.Platform(*platform)
			d.platform = platform
			return nil
		}
```

([convert.go L666-L689](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L666-L689))

こちらは `d.stage.BaseName` — `FROM golang AS build` の `golang` の方だ。ここでマッチした場合は `dispatched` を立てないので、ステージの命令は**普通に dispatch される**。ベースだけが差し替わる。

イメージ config が返らなかったときは空の config が使われる。`llb.Local` を `FROM` のベースにするような使い方でも壊れないようにするためだ。

### 優先順位

`FROM <base> AS <name>` という 1 行について、解決の優先順位は次のようになる。

1. **`<name>` が named context にマッチ** → ステージ全体が差し替わる (命令は実行されない)
2. **`<base>` が同じ Dockerfile の前のステージ名にマッチ** → そのステージが base になる。named context は**参照されない**
3. **`<base>` が named context にマッチ** → ベースイメージが差し替わる (命令は実行される)
4. どれでもない → `metaResolver.ResolveImageConfig` で普通のイメージとして解決

2 が 3 より強いのは、フェーズ 4 の `addState` が `ds.base` を設定してしまい、フェーズ 7 の `resolveReachableStages` が `d.base == nil` のステージしか `resolveBaseImage` に流さないからだ。地点 2 のコードには到達しない。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
		if d.base == nil && !d.dispatched && !d.resolved {
```

([convert.go L596](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L596))

つまり、`FROM build` と書いてある行に `--build-context build=...` を効かせたければ、`build` というステージが Dockerfile 内に存在してはいけない。存在する場合、named context は**そのステージ自身** (1 番) を乗っ取ることになる。結果としては似た挙動になるが、意味は違う — 1 番はステージの中身を捨て、3 番はステージの中身を新しいベースの上で実行する。

## なぜそうなっているか

named context を「追加のコンテキスト」ではなく「名前の差し替え」として設計したことで、Dockerfile を書き換えずに次のことができるようになる。

- **ベースイメージの固定。** `--build-context golang=docker-image://golang@sha256:...` で、`FROM golang` を監査済みのダイジェストに固定する。Dockerfile はタグのまま置いておける。
- **ステージのキャッシュ的なスキップ。** `--build-context build=local:./dist` で、時間のかかるビルドステージを事前成果物に置き換える。CI で「ビルド済みのアーティファクトがあればそれを使う」を Dockerfile の分岐なしで実現できる。
- **オフライン / エアギャップビルド。** `--build-context alpine=oci-layout://...` で、ローカルの OCI レイアウトから引く。

差し替え先の型が `docker-image` に限られていないのが重要で、`FROM` のベースにディレクトリ (`local:`) やゲートウェイの入力 (`input:`) を置ける。BuildKit 内部ではベースイメージもファイルシステムのスナップショットでしかないので、この一般化に無理がない。

一方で、この力は Dockerfile の可読性を確実に損なう。`FROM alpine` と書いてあるのに実際は別のものを使っている、という状態が外から作れる。予約語を `scratch` と `context` の 2 つに絞ったのは最低限の防御線で、それ以外の名前はすべて差し替え可能だ。

## どう活かすか

- **名前空間を 1 つ用意して、外から解決先を差し込めるようにする。** 「参照を名前で書く」設計なら、その名前解決に外部からのオーバーライド層を 1 枚挟むだけで、依存の差し替え・固定・モック化が全部手に入る。BuildKit がやったのはそれだけで、Dockerfile の文法は 1 文字も変わっていない。
- **オーバーライドの適用地点を数え、優先順位を明文化する。** ここでは 2 地点 (ステージ名とベース名) で、間に「同一ファイル内の定義が勝つ」というルールが挟まっている。適用地点が増えるほど、この順序はドキュメントではなくコードの構造 (`d.base == nil` のガード) として現れる。
- **予約語を最初に決めておく。** `scratch` を差し替え可能にしていたら、後から禁止するのは互換性の破壊になる。オーバーライド機構を作るときは、絶対に触らせない名前を最初のバージョンで固定する。
- **フォールバックのキーを階層にする。** `name::platform` → `name` の 2 段引きは 3 行で書けて、プラットフォーム別の上書きという機能を後付けできる形になっている。キーに次元を足すときは、より specific なものから順に引く。
