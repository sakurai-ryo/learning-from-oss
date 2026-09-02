---
title: "SourceMap — エラーを Dockerfile の行に戻す"
description: "LLB になった時点で Dockerfile の行番号は失われる。BuildKit は Definition に「ファイルの中身そのもの」と「頂点 digest → バイト範囲」の対応表を同梱し、エラーが起きたら digest から逆引きして該当行を切り出す。ソースを持っていない daemon が行を指せる理由がここにある。"
group: "LLB — ビルドの中間表現"
sidebar:
  order: 14
---

## 何を学んだか

`RUN exit 1` で失敗したとき、BuildKit は Dockerfile の該当行を `>>>` 付きで表示する。しかし daemon は Dockerfile を持っていない — 受け取ったのは [Definition](../llb-definition/) だけだ。

からくりは単純で、**Definition の中に Dockerfile の中身そのものが入っている**。`Definition.Source` に、ファイルのバイト列と「どの頂点 digest がファイルのどの範囲から生まれたか」の対応表が同梱される。エラーが起きたら digest で引いて、バイト列を行に切って、範囲に入る行に印を付けるだけだ。

コンパイラのソースマップと発想は同じだが、ソースファイルを別に配布するのではなく成果物に埋め込んでいる点が違う。フロントエンドがコンテナの中で動き、daemon がその言語を知らない、というアーキテクチャがこの選択を要求している。

## SourceMap と Location

```go title="client/llb/sourcemap.go"
// SourceMap maps a source file/location to an LLB state/definition.
// SourceMaps are used to provide information for debugging and helpful error messages to the user.
// As an example, lets say you have a Dockerfile with the following content:
//
//	FROM alpine
//	RUN exit 1
//
// When the "RUN" statement exits with a non-zero exit code buildkit will treat
// it as an error and is able to provide the user with a helpful error message
// pointing to exactly the line in the Dockerfile that caused the error.
type SourceMap struct {
	State      *State
	Definition *Definition
	Filename   string
	// Language should use names defined in https://github.com/github/linguist/blob/v7.24.1/lib/linguist/languages.yml
	Language string
	Data     []byte
}
```

([client/llb/sourcemap.go L11-28](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/sourcemap.go#L11-L28))

`Data` がファイルの中身だ。そして `State` / `Definition` は「**そのファイルがどこから来たか**」を LLB で表す。Dockerfile 自体もビルドコンテキストから読まれたファイルなので、それを取ってくる LLB がある。

位置情報を頂点に付けるのは `ConstraintsOpt` として渡す。

```go title="client/llb/sourcemap.go"
func (s *SourceMap) Location(r []*pb.Range) ConstraintsOpt {
	return constraintsOptFunc(func(c *Constraints) {
		if s == nil {
			return
		}
		c.SourceLocations = append(c.SourceLocations, &SourceLocation{
			SourceMap: s,
			Ranges:    r,
		})
	})
}
```

([client/llb/sourcemap.go L39-49](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/sourcemap.go#L39-L49))

`s == nil` で黙って何もしないので、SourceMap を持たない呼び出し元 (テストや、ソースの概念がない LLB 生成器) は何も気にしなくてよい。

proto 側の型は 4 段になっている。

```proto title="solver/pb/ops.proto"
// Source is a source mapping description for a file
message Source {
	map<string, Locations> locations = 1;
	repeated SourceInfo infos = 2;
}

// Source info contains the shared metadata of a source mapping
message SourceInfo {
	string filename = 1;
	bytes data = 2;
	Definition definition = 3;
	string language = 4;
}

// Location defines list of areas in to source file
message Location {
	int32 sourceIndex = 1;
	repeated Range ranges = 2;
}

// Range is an area in the source file (Position は line と character を持つ)
message Range {
	Position start = 1;
	Position end = 2;
}
```

([solver/pb/ops.proto L236-271](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/pb/ops.proto#L236-L271))

`Source.locations` のキーは頂点の digest 文字列だ。値は `Location` のリストで、それぞれが `sourceIndex` (どのファイルか) と範囲を持つ。ファイル本体は `infos` に 1 回だけ入り、位置情報は添字で参照する。同じ Dockerfile から 50 個の頂点が生まれても、ファイルの中身が 50 回入ることはない。

## 収集 — marshal と同じ再帰に相乗りする

`Marshal` は頂点ごとに `[]*SourceLocation` を返す。集めるのは `sourceMapCollector` だ。

```go title="client/llb/state.go"
	dgst, dt, opMeta, sls, err := v.Marshal(ctx, c)
	if err != nil {
		return def, err
	}
	vertexCache[v] = struct{}{}
	// ...
	s.Add(dgst, sls)
```

([client/llb/state.go L208-216](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/state.go#L208-L216))

`s.Add` は `cache[dgst]` の重複チェックより**前**にある。同じ digest の頂点が 2 回現れたら `Def` には 1 回しか入らないが、位置情報は両方積まれる。同じ操作が Dockerfile の 2 か所から生成されたなら、どちらの行も候補として保持したい、ということだ。

```go title="client/llb/sourcemap.go"
func (smc *sourceMapCollector) Add(dgst digest.Digest, ls []*SourceLocation) {
	for _, l := range ls {
		idx, ok := smc.index[l.SourceMap]
		if !ok {
			idx = -1
			// slow equality check
			for i, m := range smc.maps {
				if equalSourceMap(m, l.SourceMap) {
					idx = i
					break
				}
			}
			if idx == -1 {
				idx = len(smc.maps)
				smc.maps = append(smc.maps, l.SourceMap)
			}
		}
		smc.index[l.SourceMap] = idx
	}
	smc.locations[dgst] = append(smc.locations[dgst], ls...)
}
```

([client/llb/sourcemap.go L96-116](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/sourcemap.go#L96-L116))

まずポインタ同一性で引き、外れたら `slow equality check` に落ちる。同じ内容の `SourceMap` が別のポインタとして複数存在しうるからだ — たとえば [`# syntax=` で別のフロントエンドを再帰的に呼ぶ](../syntax-directive/)と、内側と外側で同じ Dockerfile を指す `SourceMap` が別々に作られる。ここで畳まないと、同じファイルの中身が 2 回 Definition に入る。

比較は内容の全一致ではない。

```go title="client/llb/sourcemap.go"
	if sm1.Definition != nil && sm2.Definition != nil {
		if len(sm1.Definition.Def) != len(sm2.Definition.Def) && len(sm1.Definition.Def) != 0 {
			return false
		}
		if !bytes.Equal(sm1.Definition.Def[len(sm1.Definition.Def)-1], sm2.Definition.Def[len(sm2.Definition.Def)-1]) {
			return false
		}
	}
```

([client/llb/sourcemap.go L67-74](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/sourcemap.go#L67-L74))

`Definition` の比較は末尾の 1 要素だけを見る。[末尾はルートを指す番兵](../llb-definition/)で、その中身はルート頂点の digest だ。digest が同じならグラフ全体が同じなので、末尾 1 要素の比較で十分になる。内容アドレスの副産物がここで効いている。

書き出しは `Marshal` で行われ、`SourceMap.State` からその場で Definition を marshal する。

```go title="client/llb/sourcemap.go"
	for _, m := range smc.maps {
		def := m.Definition
		if def == nil && m.State != nil {
			// ...
			def, err = m.State.Marshal(ctx, co...)
			m.Definition = def
		}

		info := &pb.SourceInfo{
			Data:     m.Data,
			Filename: m.Filename,
			Language: m.Language,
		}
		if def != nil {
			info.Definition = def.ToPB()
		}
		s.Infos = append(s.Infos, info)
	}
```

([client/llb/sourcemap.go L122-144](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/sourcemap.go#L122-L144))

**Definition の中に別の Definition が入る。** メインのビルドグラフの `Source.Infos[i].Definition` は「Dockerfile を読み出す LLB」だ。ソースファイルの出所を LLB で表現しておくと、後から同じファイルを再取得できる。

## 誰が SourceMap を作るか

Dockerfile フロントエンドは、ビルドコンテキストから Dockerfile を読んだところで作る。

```go title="frontend/dockerui/config.go"
	smap := llb.NewSourceMap(src, bctx.filename, lang, dt)
	smap.Definition = def
```

([frontend/dockerui/config.go L414-415](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerui/config.go#L414-L415))

`dt` が読んだバイト列、`src` がそれを読み出した State、`def` がその Definition だ。

LLB を組み立てる側は、パーサが返した範囲を `pb.Range` に詰め替えて `ConstraintsOpt` にする。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
func location(sm *llb.SourceMap, locations []parser.Range) llb.ConstraintsOpt {
	loc := make([]*pb.Range, 0, len(locations))
	for _, l := range locations {
		loc = append(loc, &pb.Range{
			Start: &pb.Position{Line: int32(l.Start.Line), Character: int32(l.Start.Character)},
			End:   &pb.Position{Line: int32(l.End.Line), Character: int32(l.End.Character)},
		})
	}
	return sm.Location(loc)
}
```

([frontend/dockerfile/dockerfile2llb/convert.go L2027-2042](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L2027-L2042))

呼ぶ側は `llb.Args(args), dfCmd(c), location(dopt.sourceMap, c.Location())` のように、他の Op オプションと同列に並べるだけになる ([frontend/dockerfile/dockerfile2llb/convert.go L1413](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L1413))。位置情報の伝播が、他の設定と同じ `ConstraintsOpt` の形に揃えられている。

## 逆引き — エラーに Source を貼る

solver がジョブの中で失敗すると、まず頂点の digest でエラーが包まれる。

```go title="solver/errdefs/vertex.go"
func WrapVertex(err error, dgst digest.Digest) error {
	if err == nil {
		return nil
	}
	return &VertexError{Vertex: &Vertex{Digest: dgst.String()}, error: err}
}
```

([solver/errdefs/vertex.go L27-32](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/errdefs/vertex.go#L27-L32))

呼び出し側が渡すのは `s.st.origDigest` だ。

```go title="solver/jobs.go"
	origDigest   digest.Digest // original LLB digest. TODO: probably better to use string ID so this isn't needed
```

([solver/jobs.go L66](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/jobs.go#L66))

solver は内部で頂点を `vertexWithCacheOptions` で包み、`--no-cache` 指定の頂点には `-ignorecache` を混ぜた別の digest を割り当てる ([solver/jobs.go L545-573](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/jobs.go#L545-L573))。この加工後の digest は `Source.locations` のキーと一致しない。だから「もとの LLB digest」を別に持って、エラーにはそちらを載せる。**内部の同一性と、外部に見せる同一性が別物**になっている。

貼り付けは `resultProxy` の側だ。

```go title="solver/llbsolver/result.go"
func (rp *resultProxy) wrapError(err error) error {
	if err == nil {
		return nil
	}
	var ve *errdefs.VertexError
	if errors.As(err, &ve) {
		if rp.req.Definition.Source != nil {
			locs, ok := rp.req.Definition.Source.Locations[ve.Digest]
			if ok {
				for _, loc := range locs.Locations {
					err = errdefs.WithSource(err, &errdefs.Source{
						Info:   rp.req.Definition.Source.Infos[loc.SourceIndex],
						Ranges: loc.Ranges,
					})
				}
			}
		}
	}
	return err
}
```

([solver/llbsolver/result.go L94-113](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/result.go#L94-L113))

`Definition` を持っているのはリクエストを受けた側なので、digest → 位置の逆引きはここでしかできない。solver コアは Dockerfile も SourceMap も知らないまま、digest だけ載せて投げる。

`errdefs.Source` は `typeurl` に登録されているので、gRPC のエラー詳細としてそのままクライアントまで運ばれる ([solver/errdefs/vertex.go L9-12](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/errdefs/vertex.go#L9-L12)、[エラーを gRPC 越しに運ぶ](../grpc-errors/))。ファイルのバイト列ごと転送されるので、クライアント側が Dockerfile を読み直す必要がない。

フロントエンド自身のエラー (パースエラーなど) は、LLB になる前なので `wrapError` を通らない。こちらは自前で `Source` を組む。

```go title="frontend/dockerfile/builder/build.go"
func wrapSource(err error, sm *llb.SourceMap, ranges []parser.Range) error {
	if sm == nil {
		return err
	}
	s := &errdefs.Source{
		Info: &pb.SourceInfo{
			Data:       sm.Data,
			Filename:   sm.Filename,
			Language:   sm.Language,
			Definition: sm.Definition.ToPB(),
		},
		// ...
	}
	// ...
	return errdefs.WithSource(err, s)
}
```

([frontend/dockerfile/builder/build.go L281-307](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/builder/build.go#L281-L307))

エラーの型が同じなので、表示側は「ビルド中の失敗」と「パースエラー」を区別せずに扱える。

## 表示 — 行に切って印を付ける

```go title="solver/errdefs/source.go"
func (s *Source) Print(w io.Writer) error {
	si := s.Info
	if si == nil {
		return nil
	}
	lines := strings.Split(string(si.Data), "\n")

	start, end, ok := getStartEndLine(s.Ranges)
	// ...
	pad := 2
	if end == start {
		pad = 4
	}
	// ...
	fmt.Fprintf(w, "%s:%d\n--------------------\n", si.Filename, prepadStart)
	for i := start; i <= end; i++ {
		pfx := "   "
		if containsLine(s.Ranges, i) {
			pfx = ">>>"
		}
		fmt.Fprintf(w, " %3d | %s %s\n", i, pfx, lines[i-1])
	}
	fmt.Fprint(w, "--------------------\n")
	return nil
}
```

([solver/errdefs/source.go L47-94](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/errdefs/source.go#L47-L94))

出力はこうなる。

```
Dockerfile:3
--------------------
   1 |     FROM alpine
   2 |
   3 | >>> RUN exit 1
   4 |
   5 |     COPY . /src
--------------------
```

`pad` が 2 と 4 で切り替わるのは、1 行だけを指しているときに前後をより多く見せるためだ。複数行にまたがる命令 (行継続でつながった `RUN`) なら、命令自体が文脈になるので前後は 2 行でよい。

呼び出しは `errors.As` で `SourceError` を全部集めるところから始まる。

```go title="solver/errdefs/source.go"
func Sources(err error) []*Source {
	var out []*Source
	var es *SourceError
	if errors.As(err, &es) {
		out = Sources(es.Unwrap())
		out = append(out, es.CloneVT())
	}
	return out
}
```

([solver/errdefs/source.go L33-41](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/errdefs/source.go#L33-L41))

再帰で内側を先に集めるので、**外側に近いほど後ろ**に並ぶ。`buildctl` はこれを順に出力する ([cmd/buildctl/main.go L150-152](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cmd/buildctl/main.go#L150-L152))。エラーが複数の層で包まれていれば、`# syntax=` の内側の Dockerfile と外側の Dockerfile が両方表示される。

## 読み戻し — DefinitionOp が SourceMap を復元する

`Definition` から `llb.State` に戻す `NewDefinitionOp` は、`Source` も一緒に復元する。

```go title="client/llb/definition.go"
		sourceMaps := make([]*SourceMap, len(def.Source.Infos))
		for i, info := range def.Source.Infos {
			var st *State
			sdef := info.Definition
			if sdef != nil {
				op, err := NewDefinitionOp(sdef)
				// ...
				state := NewState(op)
				st = &state
			}
			sourceMaps[i] = NewSourceMap(st, info.Filename, info.Language, info.Data)
		}

		for dgst, locs := range def.Source.Locations {
			for _, loc := range locs.Locations {
				// ...
				srcs[digest.Digest(dgst)] = append(srcs[digest.Digest(dgst)], &SourceLocation{
					SourceMap: sourceMaps[int(loc.SourceIndex)],
					Ranges:    loc.Ranges,
				})
			}
		}
```

([client/llb/definition.go L61-89](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/definition.go#L61-L89))

`info.Definition` に対して `NewDefinitionOp` を再帰的に呼んでいる。入れ子の Definition が、そのまま入れ子の `State` に戻る。

そして `DefinitionOp.Marshal` は復元した位置情報を返すので ([client/llb/definition.go L171-172](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/definition.go#L171-L172))、受け取った Definition を自分の LLB に組み込んで再び marshal すれば、位置情報も一緒に運ばれる。gateway 越しにグラフを合成しても、行番号が失われない。

## なぜそうなっているか

ソース位置を「別途配布するソースマップ」ではなく「成果物に埋め込む」形にしたのは、BuildKit のアーキテクチャの帰結だ。

Dockerfile を LLB に変換するのは、daemon の中のコードではなく**コンテナとして動くフロントエンド**だ ([フロントエンドは LABEL で自己申告し、ネットワークを持たない](../frontend-labels/))。daemon は `dockerfile.v0` の文法を知らないし、そもそも受け取った LLB がどの言語から来たかも知らない。だから「エラーが起きたら Dockerfile の 3 行目」という対応を daemon 側で計算することはできない。フロントエンドが変換時に対応表を作り、Definition に添えて渡すしかない。

ファイルのバイト列まで入れているのは、**エラーを見せる場所が daemon でもクライアントでもありうる**からだ。`buildctl` はクライアント側で表示するが、`# syntax=` の内側のフロントエンドが投げたエラーは、そのフロントエンドのコンテナから gateway を通って出てくる。どの層でもソースを再取得せずに表示できるようにするには、エラーと一緒にバイト列が運ばれている必要がある。Dockerfile は数 KB なので、これで困ることはほとんどない。

`SourceInfo.Definition` に「ファイルを取ってくる LLB」を入れているのはさらに先を見ていて、IDE の統合や lint のサブリクエストが「このソースをもう一度取ってこい」と言えるようにするためだ。実際 `frontend/subrequests/lint` は `errdefs.Source` を組み立てて同じ `Print` で警告を出している ([frontend/subrequests/lint/lint.go L58-62](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/subrequests/lint/lint.go#L58-L62))。

## どう活かすか

**中間表現を挟んだら、ソース位置を運ぶ経路を最初に設計する。** コンパイラでもトランスパイラでもクエリプランナでも、変換した瞬間に「ユーザが書いたもの」との対応が切れる。後から足そうとすると、変換の全経路に位置情報を通す改修が要る。BuildKit は `ConstraintsOpt` という既存のオプション機構に相乗りさせることで、呼び出し側の変更を `location(sm, c.Location())` の 1 引数に抑えている。

**ソース本体を成果物に埋め込むのは、しばしば正しい。** ソースマップを別ファイルにすると「エラーを表示する側がソースにアクセスできるか」という問題が常について回る。BuildKit のように変換する側と表示する側が別プロセス・別マシンなら、埋め込んだほうが単純だ。サイズが問題になるまでは埋め込む、でよい。

**内部の同一性と外部に見せる同一性を分ける。** solver は `-ignorecache` を混ぜた digest でキャッシュを分けるが、それをユーザに見せる ID として使うと対応表が引けなくなる。`origDigest` という 1 フィールドが両者を橋渡ししている。ID を加工する最適化を入れるときは、「外向きの ID」を別に保つことを同時に考えたほうがよい。

**エラーの装飾はエラー型に持たせ、表示は 1 か所に集める。** `SourceError` はエラーをラップするだけで、表示は `Source.Print` の 50 行しかない。`Sources(err)` で内側から順に集められるので、多層のフロントエンドでも表示ロジックを増やさずに済む。エラーに文脈を「足す」ことと「見せる」ことを分けておくと、途中の層は文脈を足すだけでよくなる。
