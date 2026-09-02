---
title: "決定性 marshal がキャッシュの前提になっている"
description: "頂点 ID がバイト列の digest である以上、同じ State から必ず同じバイト列が出ることがキャッシュ成立の前提になる。BuildKit は proto の Deterministic オプション・mount のソート・env の不変連結リスト・受信側での再 marshal という 4 段構えでこれを守っている。"
group: "LLB — ビルドの中間表現"
sidebar:
  order: 9
---

## 何を学んだか

[Definition](../llb-definition/) の頂点 ID は marshal 済みバイト列の digest だ。ということは、**同じビルド定義から違うバイト列が出た瞬間にキャッシュは全ミスする**。protobuf の marshal はデフォルトでは決定的ではない (Go の map の反復順がランダム化されているため) から、これは放っておくと確実に踏む。

BuildKit の対処は 4 段ある。marshal 時に `Deterministic: true` を指定する。順序に意味のあるスライス (mount) を marshal 前にソートする。順序が決まりにくいもの (環境変数) を不変連結リストで表して構築順を再現可能にする。そして最後に、**受け取った側で全部 marshal し直す**。

## 1. proto の Deterministic オプション

LLB の Op を marshal する経路は 1 つの関数に集約されている。

```go title="client/llb/marshal.go"
func deterministicMarshal[Message proto.Message](m Message) ([]byte, error) {
	return proto.MarshalOptions{Deterministic: true}.Marshal(m)
}
```

([client/llb/marshal.go L167-169](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/marshal.go#L167-L169))

`ExecOp` / `FileOp` / `SourceOp` / `MergeOp` / `DiffOp` / `PassthroughOp` の `Marshal` はすべてこれを呼ぶ。solver 側にも同じものがある。

```go title="solver/pb/ops.go"
func (m *Op) Marshal() ([]byte, error) {
	return proto.MarshalOptions{Deterministic: true}.Marshal(m)
}
```

([solver/pb/ops.go L17-19](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/pb/ops.go#L17-L19))

このオプションが実際に効くのは map フィールドだ。LLB には map が複数ある — `SourceOp.attrs`、`BuildOp.attrs`、`OpMetadata.description`、`OpMetadata.caps`。`SourceOp` は特に効く。`docker-image://alpine` のような識別子に付随する解決済みダイジェストやプラットフォーム、`local://` のセッション ID などがすべて `attrs` に入るからだ。

```go title="client/llb/source.go"
	proto.Op = &pb.Op_Source{
		Source: &pb.SourceOp{Identifier: s.id, Attrs: s.attrs},
	}
	// ...
	dt, err := deterministicMarshal(proto)
```

([client/llb/source.go L76-84](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/source.go#L76-L84))

`Deterministic: true` を付けないと、`attrs` に 3 つエントリがあるだけで最大 6 通りのバイト列が出て、同じビルドが毎回違う digest になる。

ただし protobuf-go 自身がこのオプションの保証範囲を狭く定義していることに注意が要る。

```go title="vendor/google.golang.org/protobuf/proto/encode.go"
	// Note that the deterministic serialization is NOT canonical across
	// languages. It is not guaranteed to remain stable over time. It is
	// unstable across different builds with schema changes due to unknown
	// fields. Users who need canonical serialization (e.g., persistent
	// storage in a canonical form, fingerprinting, etc.) must define
	// their own canonicalization specification and implement their own
	// serializer rather than relying on this API.
```

保証されるのは「同じバイナリの中で」「同じメッセージを繰り返し marshal したとき」だけだ。まさに BuildKit がやっている fingerprinting は「使うな」と書かれている用途にあたる。この矛盾をどう埋めているかが 4 段目の話になる。

## 2. mount のソート — 3 か所で同じ順序を作る

`ExecOp` の入力と出力の番号は mount の並び順から決まる ([ExecOp](../exec-op/))。だから並び順が揺れると digest だけでなく辺の意味まで変わる。`Marshal` は先頭で mount をソートする。

```go title="client/llb/exec.go"
	// make sure mounts are sorted
	slices.SortFunc(e.mounts, func(a, b *mount) int {
		return strings.Compare(a.target, b.target)
	})
```

([client/llb/exec.go L145-148](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/exec.go#L145-L148))

同じソートが `Inputs()` にもある。そしてそこには、なぜ重複しているかを説明するコメントが付いている。

```go title="client/llb/exec.go"
func (e *ExecOp) Inputs() (inputs []Output) {
	// make sure mounts are sorted
	// the same sort occurs in (*ExecOp).Marshal, and this
	// sort must be the same
	slices.SortFunc(e.mounts, func(a, b *mount) int {
		return strings.Compare(a.target, b.target)
	})
```

([client/llb/exec.go L487-493](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/exec.go#L487-L493))

3 か所目は `getMountIndexFn` で、ある mount が何番目の出力になるかを数える関数だ。ここでも同じソートを先に走らせている ([client/llb/exec.go L507-526](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/exec.go#L507-L526))。「並び順」という不変条件が 3 か所に散っていて、ソートの重複がそれを守るための手段になっている。

`Definition` を作るときは `Inputs()` で辿ってから `Marshal()` を呼ぶ ([client/llb/state.go L200-208](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/state.go#L200-L208))。両者が別々にソートを掛けても同じ結果になることが、入力の並びと `Op.Inputs` の並びが一致する根拠になっている。

## 3. 環境変数はソートしない — 不変連結リストで順序を固定する

`Meta.env` は `repeated string` で、`FOO=bar` の配列だ。ここは**ソートされていない**。代わりに `EnvList` という不変連結リストが構築順を保持する。

```go title="client/llb/meta.go"
type EnvList struct {
	parent *EnvList
	key    string
	value  string
	del    bool
	once   sync.Once
	l      int
	values map[string]string
	keys   []string
}

func (e *EnvList) AddOrReplace(k, v string) *EnvList {
	return &EnvList{
		parent: e,
		key:    k,
		value:  v,
		l:      e.l + 1,
	}
}
```

([client/llb/meta.go L384-402](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/meta.go#L384-L402))

`ToArray` は鎖を末尾から遡って「同じキーは最初に見つかったもの (=最も新しい代入) を採用」し、最後に反転して古い順に戻す。

```go title="client/llb/meta.go"
func (e *EnvList) makeValues() {
	m := make(map[string]string, e.l)
	seen := make(map[string]struct{}, e.l)
	keys := make([]string, 0, e.l)
	e.keys = e.addValue(keys, m, seen)
	e.values = m
	slices.Reverse(e.keys)
}
```

([client/llb/meta.go L420-427](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/meta.go#L420-L427))

ソートしないのは、環境変数の順序に意味があるから — というより、意味があると仮定せざるを得ないからだ。`ENV PATH=/opt/bin:$PATH` のような定義は前の値に依存するし、イメージの config に書き戻す `Env` の順序も観測可能だ。ソートで正規化してしまうと、既存イメージと出力が変わる。代わりに「同じ Dockerfile からは同じ順で積まれる」ことを、map ではなく連結リストという構造で保証している。この形は [State API](../state-api/) と同じで、`State` 自身も同じ不変連結リストだ。

`Marshal` の中で `SSH_AUTH_SOCK` や `PATH` を補うときも、この `EnvList` の上に積む ([client/llb/exec.go L155-180](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/exec.go#L155-L180))。ただし `PATH` の追加は `CapExecMetaSetsDefaultPath` を daemon がサポートするかで分岐する。サポートされていれば daemon 側が補うのでクライアントは足さない。同じ LLB でも接続先の daemon の世代によって env が変わりうる、ということでもある。

## 4. 受信側で marshal し直す

以上はすべてクライアント側の話だ。しかし BuildKit のクライアントは 1 種類ではない。Go の `client/llb` を使うもの、Rust や Node の実装、そして**古いバージョンの BuildKit でビルドされたフロントエンドコンテナ**がいる。gogo/protobuf 時代のフロントエンドが吐くバイト列は、google.golang.org/protobuf が吐くものと異なりうる。

そこで daemon 側は、受け取った Definition の digest を信用せず、全部計算し直す。

```go title="solver/llbsolver/vertex.go"
func recomputeDigests(ctx context.Context, all map[digest.Digest]*op, visited map[digest.Digest]digest.Digest, dgst digest.Digest) (digest.Digest, error) {
	if dgst, ok := visited[dgst]; ok {
		return dgst, nil
	}
	op, ok := all[dgst]
	// ...
	for _, input := range op.Inputs {
		// ...
		iDgst, err := recomputeDigests(ctx, all, visited, digest.Digest(input.Digest))
		if err != nil {
			return "", err
		}
		input.Digest = string(iDgst)
	}

	dt, err := op.Marshal()
	// ...
	newDgst := digest.FromBytes(dt)
	if newDgst != dgst {
		all[newDgst] = op
		delete(all, dgst)
	}
	visited[dgst] = newDgst
	return newDgst, nil
}
```

([solver/llbsolver/vertex.go L306-344](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/vertex.go#L306-L344))

葉から根に向かって digest を計算し直し、更新された digest を `Input.digest` に書き戻していく。1 つの頂点のバイト表現が変われば、それを参照する全頂点の digest も連鎖的に変わるので、この再帰が必要になる。

この経路を入れた変更のコミットメッセージが、意図をそのまま説明している。

> This ensures different valid protobuf serializations that are sent by frontends will be rewritten into digests that are normalized for the buildkit solver.
>
> The most recent example of this is that older frontends would generate protobuf with gogo and the newer buildkit is using the google protobuf library. These produce different serializations and cause the solver to think that identical operations are actually different.
>
> — `9f65f8c1f` gateway: ensure llb digests are deterministic when sent by frontends

テストには実際に gogo が吐いたバイト列が `solver/llbsolver/testdata/gogoproto.data` として埋め込まれていて、それを読んでも現行の marshal と同じ digest になることを確認している ([solver/llbsolver/vertex_test.go L58-60](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/vertex_test.go#L58-L60))。

つまり BuildKit は「protobuf の決定性を信じる」のではなく、**「daemon 側の 1 つのバイナリが計算した digest だけを正とする」**という設計にしている。`Deterministic: true` の保証範囲 (同じバイナリの中) と、この正規化のスコープ (1 つの daemon プロセス) が、ちょうど一致している。

## marshal のキャッシュと Constraints

`Marshal` は同じ頂点に対して何度も呼ばれる — `Inputs()` を辿るたびに `ToInput` が `Marshal` を呼ぶからだ。そこで各 Op は結果をキャッシュする。

```go title="client/llb/marshal.go"
type MarshalCache struct {
	mu    sync.Mutex
	cache map[*Constraints]*marshalCacheResult
}

func (mc *MarshalCache) Acquire() *MarshalCacheInstance {
	mc.mu.Lock()
	return &MarshalCacheInstance{mc}
}
```

([client/llb/marshal.go L118-129](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/marshal.go#L118-L129))

キーが `*Constraints` になっているのが要点だ。同じ `ExecOp` でも、プラットフォームや `Caps` の異なる `Constraints` で marshal すれば別のバイト列になる。1 つのフロントエンドがマルチプラットフォームビルドを組むと、同じ State を 2 つの `Constraints` で marshal することになるので、キャッシュを 1 スロットにしていると壊れる。

この形になった経緯もコミットに残っている。

> In addition, the marshal cache has also been fixed to work in multi-threaded frontends with multiple different constraints. Previously, if an LLB vertex was used in multiple goroutines and marshaled concurrently, the cache would be broken.
>
> — `d59218e6e` llb: deterministic marshaling for protobuf and store results from multiple constraints

`Acquire` が mutex を取り `Release` で返す形にしてあるので、`Load` してミスしたら `Store` するまでロックが握られる。`ExecOp.Marshal` は先頭で `Acquire` して `defer Release` している ([client/llb/exec.go L134-140](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/llb/exec.go#L134-L140))。marshal の途中で `e.mounts` をソートしたり `e.constraints` に cap を足したりと Op 自身を書き換えるので、そもそも並行実行できない。

## なぜそうなっているか

キャッシュヒットの判定は「同じ digest のキャッシュキーがあるか」に還元される ([fast cache と slow cache](../fast-slow-cache/))。fast cache 側のキーは頂点の定義だけから決まるので、定義のバイト表現が揺れれば、実質同じビルドが毎回ミスする。しかも**壊れ方が静かだ** — ビルドは正しく通り、ただ遅くなるだけなので、テストでは検出されない。

だから決定性は「あると嬉しい性質」ではなく、機能の前提条件として扱われている。protobuf の Deterministic オプションだけでは足りない (言語間・バージョン間では保証されない) ことを認めたうえで、daemon 側での再 marshal という「最後の砦」を置いているのがこの設計の要だ。クライアントの決定性は最適化 (再 marshal しても digest が変わらないので、ローカルキャッシュや進捗表示が安定する) であり、正しさを担保しているのは受信側の正規化のほうだ。

## どう活かすか

**内容ハッシュを ID に使うなら、シリアライザの決定性保証の範囲を必ず読む。** protobuf も JSON も MessagePack も、「同じ値なら同じバイト列」は普通は保証していない。map、浮動小数点、省略可能フィールド、unknown field のどこかで揺れる。ライブラリのドキュメントが「fingerprinting には使うな」と書いていることは珍しくない。

**それでも使うなら、正規化を受信側に置く。** 送信者を全部コントロールできるならクライアント側の決定性だけで足りるが、プラグインや外部実装が送ってくるなら無理だ。受け取った時点で自分のシリアライザで書き直せば、正規形の定義がプロセス内の 1 か所に集まる。BuildKit の `recomputeDigests` は 40 行しかない。

**「複数箇所で同じ不変条件を守る」なら、守るコードをコピーしてでもコメントで結ぶ。** `ExecOp` の 3 つのソートは、DRY からすれば 1 つの関数に括りたくなる。実際に括ってもよいが、重要なのは「この 3 か所は同じ順序でなければならない」が読み手に見えることだ。BuildKit は `the same sort occurs in (*ExecOp).Marshal, and this sort must be the same` という 1 行でそれを表明している。

**順序が観測される値は、map ではなく積み上げ構造で持つ。** 環境変数のように「後勝ち」かつ「順序が出力に現れる」ものを `map[string]string` で持つと、書き出すたびにソートするか順序を捨てるかの二択になる。`EnvList` のような不変連結リストなら、構築順がそのまま保存され、後勝ちの解決も遡り方向の走査だけで書ける。
