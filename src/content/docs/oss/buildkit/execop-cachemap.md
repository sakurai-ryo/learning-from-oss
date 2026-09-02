---
title: "ExecOp の CacheMap — 何をキーから外し、どのバグを再現し続けるか"
description: "RUN のキャッシュキーは ExecOp の proto を JSON にしてハッシュしたものだが、その前にいくつかのフィールドが意図的に落とされる。さらに「かつてのバグをそのまま再現する」ためだけの分岐が 1 つ残っていて、コメントがその理由を説明している。"
group: "キャッシュキーの設計"
sidebar:
  order: 46
---

## 何を学んだか

`RUN` のキャッシュキーは、`ExecOp` の protobuf メッセージを JSON にしてハッシュしただけの値だ。ただしハッシュを取る前に、**op のコピーからいくつかのフィールドが消される**。何を消すかが「どのビルドを同じとみなすか」の定義になる。

消されるものは 4 種類ある。

- `ExtraHosts` の IP アドレス (ホスト名は残す)
- `Meta.ProxyEnv` 全部
- マウントの `Selector`
- Dockerfile 由来のデフォルトキャッシュマウントの `CacheOpt.ID` と `Sharing`

そして 5 つ目に、**過去のバグを再現するための分岐**がある。「ルートマウント 1 個だけ」という典型形のとき、マウントをまるごとキーから外す。バグを直すとキャッシュが全世界的に無効になるので、直せなくなった。

## キーになる範囲

```go title="solver/llbsolver/ops/exec.go"
	dt, err := json.Marshal(struct {
		Type       string
		Exec       *pb.ExecOp
		OS         string
		Arch       string
		Variant    string   `json:",omitempty"`
		OSVersion  string   `json:",omitempty"`
		OSFeatures []string `json:",omitempty"`
	}{
		Type:       execCacheType,
		Exec:       op,
		OS:         p.OS,
		Arch:       p.Architecture,
		Variant:    p.Variant,
		OSVersion:  p.OSVersion,
		OSFeatures: p.OSFeatures,
	})
	if err != nil {
		return nil, false, err
	}

	dgst, err := cachedigest.FromBytes(dt, cachedigest.TypeJSON)
```

([solver/llbsolver/ops/exec.go L163-L187](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L163-L187))

`Type` は `"buildkit.exec.v0"` という定数で ([solver/llbsolver/ops/exec.go L39](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L39))、名前空間として働く。`v0` が末尾にあるのは、キーの計算方法を変えたいときにここを上げれば全 `RUN` のキーが変わる、という余地だ。実際には上げられていない。

`Exec` に入るのは `pb.ExecOp` そのものなので、**`args`、`env`、`user`、`cwd`、`hostname`、`network`、`security`、マウント構成、CDI デバイス**などが丸ごとキーに入る。「明示的に列挙して足す」ではなく「丸ごと入れてから引く」という向きになっているのが特徴で、新しいフィールドが proto に足されたら自動的にキーに入る。**キーから漏れる (誤ヒットする) より、余計に入る (無駄にミスする) 方を安全側としている。**

プラットフォームは proto の外なので明示的に足される。同じ `RUN` でも amd64 と arm64 で別のキーになる。

digest は `cachedigest.FromBytes(dt, cachedigest.TypeJSON)` で取る。これは `digest.FromBytes` と同じ値を返しつつ、入力バイト列を型タグ付きでデバッグ用 DB に記録する ([util/cachedigest/db.go L59-L66](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/cachedigest/db.go#L59-L66))。「なぜキャッシュが外れたのか」を後から digest から逆引きするための仕組みで、別ページで扱う ([互換性と cachedigest](../compat-and-cachedigest/))。

## 何を外すか

```go title="solver/llbsolver/ops/exec.go"
func (e *ExecOp) CacheMap(ctx context.Context, jobCtx solver.JobContext, index int) (*solver.CacheMap, bool, error) {
	op := cloneExecOp(e.op)

	for i := range op.Meta.ExtraHosts {
		h := op.Meta.ExtraHosts[i]
		h.IP = ""
		op.Meta.ExtraHosts[i] = h
	}

	for i := range op.Mounts {
		m := op.Mounts[i]
		m.Selector = ""

		if checkShouldClearCacheOpts(m) {
			m.CacheOpt.ID = ""
			m.CacheOpt.Sharing = 0
		}
	}
	op.Meta.ProxyEnv = nil
```

([solver/llbsolver/ops/exec.go L114-L132](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L114-L132))

`cloneExecOp` が最初にあるのが重要だ。`old.CloneVT()` で protobuf のディープコピーを作ってから壊すので、実行に使う `e.op` は無傷のままになる ([solver/llbsolver/ops/exec.go L89-L91](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L89-L91))。**「キー用に加工した op」と「実行用の op」は別物である。**

**`ExtraHosts` の IP** — `--add-host=db:10.0.0.5` の `10.0.0.5` は消え、`db` だけが残る。「同じホスト名を解決するなら、その IP が何であれ同じビルドだ」という判断になる。開発機と CI で IP が違ってもキャッシュが繋がる。

**`ProxyEnv`** — `HTTP_PROXY` などがまるごと消える。プロキシは経路の設定であって、取得される内容には影響しないはずだという前提だ。

**マウントの `Selector`** — セレクタは「入力のどの部分を使うか」なので、この op 自身の同一性ではなく**入力の同一性**の側に属する。実際に `Selector` は `CacheMap.Deps[i].Selector` として入力側のキーに合流する ([solver/llbsolver/ops/exec.go L203-L209](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L203-L209))。**同じ情報を 2 箇所に入れないための削除**であって、無視しているわけではない。

**キャッシュマウントの ID** — こちらは条件付きで、判定関数が分かれている。

```go title="solver/llbsolver/ops/exec.go"
func checkShouldClearCacheOpts(m *pb.Mount) bool {
	if m.CacheOpt == nil {
		return false
	}

	// This is a dockerfile default cache mount.
	// We are treating this as a special case so we don't cause a cache miss unintentionally.
	if m.CacheOpt.ID == m.Dest && m.CacheOpt.Sharing == 0 {
		return false
	}

	// Check the case where a dockerfile cache-namespace may be used.
	// This would be `<namespace>/<dest>`
	_, trimmed, ok := strings.Cut(m.CacheOpt.ID, "/")
	if ok && trimmed == m.Dest && m.CacheOpt.Sharing == 0 {
		return false
	}

	return true
}
```

([solver/llbsolver/ops/exec.go L93-L112](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L93-L112))

返り値が真なら消す。`RUN --mount=type=cache,target=/root/.cache` のようにマウント先だけを書いた場合、Dockerfile フロントエンドは `ID` にマウント先と同じ文字列を入れる。この形と、キャッシュ名前空間を前置した `<namespace>/<dest>` の形は**消さない**。それ以外、つまりユーザが明示的に `id=` を指定した場合は消す。

`CacheOpt.ID` をキーから外す考え方自体は、コミットメッセージが説明している。

> A cache ID should not have any impact on whether or not a step should be re-run any more than the content of that cache does (or rather, doesn't).
>
> — [584ec4008 "Do not include a cache mount's ID in the ExecOp's cachemap"](https://github.com/moby/buildkit/commit/584ec4008581f99053a3dd37fadd962fd5a62a2e)

キャッシュマウントの**中身**はキーに入らない (毎回違ってよい) のだから、その**名前**も入るべきでない、という論理だ。一方で、デフォルト ID を消さない条件が後から足されているのは、既存のキャッシュを壊さないためだとコメントが言っている (`so we don't cause a cache miss unintentionally`)。**理屈としては全部消すのが正しいが、消すとキャッシュが無効になる範囲があるので、そこだけ残した**という構造になっている。

## 再現し続けるバグ

そして、こういう分岐が入っている。

```go title="solver/llbsolver/ops/exec.go"
	// Special case for cache compatibility with buggy versions that wrongly
	// excluded Exec.Mounts: for the default case of one root mount (i.e. RUN
	// inside a Dockerfile), do not include the mount when generating the cache
	// map.
	if len(op.Mounts) == 1 &&
		op.Mounts[0].Dest == "/" &&
		op.Mounts[0].Selector == "" &&
		!op.Mounts[0].Readonly &&
		op.Mounts[0].MountType == pb.MountType_BIND &&
		op.Mounts[0].CacheOpt == nil &&
		op.Mounts[0].SSHOpt == nil &&
		op.Mounts[0].SecretOpt == nil &&
		op.Mounts[0].ResultID == "" {
		op.Mounts = nil
	}
```

([solver/llbsolver/ops/exec.go L147-L161](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L147-L161))

コメントが状況を説明している。**「`Exec.Mounts` を誤って除外していたバグ入りバージョンとのキャッシュ互換のため」。** 過去のある時期の BuildKit は、キーを計算するときにマウント情報を落としていた。それはバグだったが、修正すると**世に存在するすべての `RUN` のキャッシュキーが変わる**。

そこで折衷案が取られた。「Dockerfile の素の `RUN`」に相当する形 — ルート `/` に読み書き可能な bind マウントが 1 つだけあり、セレクタもキャッシュオプションも secret も SSH もない — のときだけ、バグと同じ挙動を再現する。それ以外 (`--mount` を使った `RUN` など) はマウントをキーに含める。

コミットのタイトルがそのまま設計判断になっている。

> Add hack to preserve Dockerfile RUN cache compatibility after mount cache bugfix
>
> — [61bb15a47](https://github.com/moby/buildkit/commit/61bb15a47f42eb1fa9e73dc4e592292db29f7287) (2021-04-14)

`hack` と自己申告した上で残されている。9 つの条件を `&&` で並べた長い if は、**「バグの適用範囲を、後から精密に限定し直したもの」**として読むと意味が分かる。条件が 1 つでも外れたら正しい方 (マウントを含める) に倒れる。

キャッシュキーを持つシステムでは、**キーの計算式そのものが後方互換性の対象になる**。式を直すのは仕様変更であって、バグ修正ではない。この 15 行はそのことを一番はっきり示している。

## Deps 側 — 入力ごとの設定

自分の digest を作り終えたら、入力ごとの設定を埋める。

```go title="solver/llbsolver/ops/exec.go"
	cm := &solver.CacheMap{
		Digest: dgst,
		Deps: make([]struct {
			Selector          digest.Digest
			ComputeDigestFunc solver.ResultBasedCacheFunc
			PreprocessFunc    solver.PreprocessFunc
		}, e.numInputs),
	}

	deps, err := e.getMountDeps()
	if err != nil {
		return nil, false, err
	}

	for i, dep := range deps {
		if len(dep.Selectors) != 0 {
			dgsts := make([][]byte, 0, len(dep.Selectors))
			for _, p := range dep.Selectors {
				dgsts = append(dgsts, []byte(p))
			}
			cm.Deps[i].Selector = digest.FromBytes(bytes.Join(dgsts, []byte{0}))
		}
		if dep.ContentBasedHash {
			cm.Deps[i].ComputeDigestFunc = opsutils.NewContentHashFunc(toSelectors(dedupePaths(dep.Selectors)))
		}
		cm.Deps[i].PreprocessFunc = unlazyResultFunc
	}
```

([solver/llbsolver/ops/exec.go L188-L214](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L188-L214))

`Deps` の長さは `e.numInputs` で、**マウントの数ではなく入力の数**になる。1 つの入力を複数のパスにマウントすることがあるので、セレクタは入力ごとに束ねられる。区切りにヌルバイトを使うのは、パスに現れない文字だからだ。

`ComputeDigestFunc` に渡す前に `dedupePaths` が入る。

```go title="solver/llbsolver/ops/exec.go"
			// Check if p2 is a prefix of p1. Ensure that p2 ends in a slash
			// so that we know p2 is a parent directory of p1. We don't want
			// /foo to be a parent of /foobar.
			if p1 != p2 && strings.HasPrefix(p1, forceTrailingSlash(p2)) {
```

([solver/llbsolver/ops/exec.go L250-L253](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L250-L253))

`/a` と `/a/b` の両方が選択されているとき、`/a/b` は `/a` に含まれるので落とす。**内容ハッシュを 2 度計算しないための削減**であって、キーの意味は変わらない。`/foo` が `/foobar` の親と誤判定されないよう、末尾スラッシュを強制してから比較している。

一方 `cm.Deps[i].Selector` の方は `dep.Selectors` を重複除去せずそのまま連結する。fast key 側は「定義がこう書かれている」ことを表すので、書かれ方が違えば別のキーになってよい。**同じセレクタ集合が、fast 側では定義の写しとして、slow 側では計算範囲の指定として、違う扱いを受けている** ([fast cache と slow cache](../fast-slow-cache/))。

`PreprocessFunc` にはすべての入力で `unlazyResultFunc` が入る。遅延取得されている ref を実体化する処理で ([solver/llbsolver/ops/file.go L699](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/file.go#L699)、[lazy ref](../lazy-ref/))、キーの計算には関わらないが、キー計算の前に走る必要がある。

## 返り値の 2 つ目

```go title="solver/llbsolver/ops/exec.go"
	return cm, true, nil
```

2 つ目の `bool` は「この op の `CacheMap` はこれで打ち止めか」を表す。`edge` 側では `e.cacheMapDone` になり、偽なら `cacheMapIndex` を進めてもう一度 `CacheMap` を呼ぶ ([solver/edge.go L579-L618](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/edge.go#L579-L618))。

`ExecOp` は常に `true` を返す。偽を返しうるのは `SourceOp` で、ソース実装の `CacheKey` が返す `done` をそのまま流している ([solver/llbsolver/ops/source.go L83-L104](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/source.go#L83-L104))。`types.go` のコメントが理由を書いている。

```go title="solver/types.go"
	// CacheMap returns structure describing how the operation is cached.
	// Currently only roots are allowed to return multiple cache maps per op.
	CacheMap(context.Context, JobContext, int) (*CacheMap, bool, error)
```

([solver/types.go L174-L176](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/types.go#L174-L176))

「複数のキャッシュマップを返せるのは root だけ」。git ソースのように「まずブランチ名でキーを作り、後から解決した commit SHA でもキーを作る」という段階的な絞り込みをするためで ([git source](../git-source/))、入力を持つ op には許されていない。入力を持つ op で複数のキーが出ると、合成の組み合わせが跨いで増えてしまう。

## どう活かすか

**キーは「全部入れてから引く」向きで作る。** 明示的に列挙して足す方式は、新しいフィールドが増えたときに足し忘れて誤ヒットを生む。BuildKit は proto を丸ごと JSON にしてから、外してよいものだけを削る。削除は目に見えるので、レビューで議論の対象になる。追加漏れは目に見えない。

**「キーに入れない」判断には理由を書く。** IP、プロキシ、セレクタ、キャッシュ ID — どれも「なぜ入れないか」の説明が要る種類の判断で、実際にコメントかコミットメッセージのどちらかで説明されている。理由なしの `= nil` は、後から誰も触れなくなる。

**キーの計算式は互換性の対象になる。** 式を変えると全ユーザのキャッシュが無効になるので、バグ修正であっても自由には直せない。BuildKit は「バグの適用範囲を後から限定する」という形で折り合いをつけた。同じ問題は、バージョン番号を式に含めて明示的に世代を切る方法でも解ける (`buildkit.exec.v0` の `v0` はその余地だ)。どちらを取るにせよ、**「この式は一度公開したら変えられない」と最初に認識しているかどうか**が分かれ目になる。
