---
title: "キャッシュキーの合成 — 入力ごとの「許容キー集合」"
description: "CacheKey.deps は [][]CacheKeyWithSelector という二重スライスで、外側は入力番号、内側は「その入力について現在許容できるキーの一覧」を表す。そして合成キーの ID はハッシュではなく、リンクグラフから引くか、見つからなければ乱数で作られる。"
group: "キャッシュキーの設計"
sidebar:
  order: 41
---

## 何を学んだか

BuildKit のキャッシュキーは「ハッシュを連結してハッシュを取る」ものではない。

1. `CacheKey` は入力ごとに**キーの集合**を持つ。`deps [][]CacheKeyWithSelector` の内側スライスが、その入力について「一致してよいキーの一覧」になる。
2. 合成キーの ID は入力キーから**計算されない**。リンクグラフを引いて既存の ID を見つけるか、見つからなければ `identity.NewID()` で新しく作る。
3. 同じ `CacheKey` オブジェクトが、キャッシュマネージャごとに**別の ID を持つ**。`ids map[*cacheManager]string` がそれを保持する。

「キーは内容から一意に決まる値である」という素朴な前提が、ここでは成り立っていない。

## CacheKey の形

```go title="solver/cachekey.go"
type CacheKey struct {
	mu sync.RWMutex

	ID   string
	deps [][]CacheKeyWithSelector
	// digest is the digest returned by the CacheMap implementation of this op
	digest digest.Digest
	// vtx is the LLB digest that this op was created for
	vtx    digest.Digest
	output Index
	ids    map[*cacheManager]string

	indexIDs []string
}
```

([solver/cachekey.go L35-L48](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachekey.go#L35-L48))

フィールドが 3 系統に分かれている。

- **自分の同一性**: `digest` (`CacheMap` が返したもの)、`vtx` (この LLB 頂点の digest)、`output` (何番目の出力か)
- **入力の同一性**: `deps`
- **保存先での識別子**: `ID`、`ids`、`indexIDs`

3 つ目が独立しているのが特徴的だ。`ID` は「このキーがストレージ上でどう呼ばれているか」で、`digest` とは別物になる。

`deps` の要素の型はこうなっている。

```go title="solver/cachekey.go"
// CacheKeyWithSelector combines a cache key with an optional selector digest.
// Used to limit the matches for dependency cache key.
type CacheKeyWithSelector struct {
	Selector digest.Digest
	CacheKey ExportableCacheKey
}
```

([solver/cachekey.go L22-L27](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachekey.go#L22-L27))

`ExportableCacheKey` は `CacheKey` にエクスポータを付けただけの埋め込み型で、キーが**そのキーに至る経路を書き出す能力を持ち歩く**ようになっている ([キャッシュのエクスポート](../cache-export/))。

```go title="solver/types.go"
// ExportableCacheKey is a cache key connected with an exporter that can export
// a chain of cacherecords pointing to that key
type ExportableCacheKey struct {
	*CacheKey
	Exporter CacheExporter
}
```

([solver/types.go L249-L254](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/types.go#L249-L254))

## 二重スライスが何を表すか

`deps [][]CacheKeyWithSelector` の外側と内側は、意味がまったく違う。

```
CacheKey (RUN go build, output 0)
  digest = sha256:aaa...   ← CacheMap.Digest。この Op の定義から決まる
  vtx    = sha256:vvv...   ← この LLB 頂点の digest
  output = 0

  deps = [
    /* 入力 0 (rootfs) について許容できるキー */
    [ {Selector: "",        CacheKey: K_rootfs_fast} ],

    /* 入力 1 (--mount=from=deps,src=/go/pkg) について許容できるキー */
    [ {Selector: sha256:sss, CacheKey: K_deps_fast},   ← 定義ベース
      {Selector: "",         CacheKey: K_deps_slow} ]  ← 内容ベース
  ]
```

**外側スライスの添字 = 入力番号**。これは固定で、`len(deps)` は `len(e.deps)` に一致する。

**内側スライスは「その入力について現時点で許容できるキーの一覧」**。ここが複数になる理由は 3 つある。

1. **fast key と slow key が両方立つ** — `ComputeDigestFunc` を持つ入力では、定義ベースのキーと内容ベースのキーが同時に候補になる。
2. **入力の edge が複数のキーを持つ** — 上流がキャッシュから読まれた場合、その `Result.CacheKeys()` は複数要素になりうる。同じ ref に至る経路が複数あるからだ。
3. **edge がマージされた** — 別の edge が同じ結果に統合されると、統合元のキーも許容キーとして持ち込まれる ([edge のマージ](../edge-merge/))。

内側が複数あるとき、意味は **OR** になる。「入力 1 については、fast key でも slow key でも、どちらか一致すればよい」。一方、外側は **AND** で、「すべての入力について一致していること」が要る。この AND/OR の構造がそのまま探索アルゴリズムの形を決める ([キャッシュ検索はグラフ探索である](../cache-query-graph/))。

実際に内側が複数要素になるところを見ると分かりやすい。

```go title="solver/edge.go"
		for i, dep := range e.deps {
			if dep.result != nil {
				for _, dk := range dep.result.CacheKeys() {
					mergedKey.deps[i] = append(mergedKey.deps[i], CacheKeyWithSelector{Selector: e.cacheMap.Deps[i].Selector, CacheKey: dk})
				}
				if dep.slowCacheKey != nil {
					mergedKey.deps[i] = append(mergedKey.deps[i], CacheKeyWithSelector{CacheKey: *dep.slowCacheKey})
				}
			} else {
				for _, k := range dep.keys {
					mergedKey.deps[i] = append(mergedKey.deps[i], CacheKeyWithSelector{Selector: e.cacheMap.Deps[i].Selector, CacheKey: k})
				}
			}
		}
```

([solver/edge.go L456-L469](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/edge.go#L456-L469))

`slowCacheKey` を append するときだけ `Selector` を付けていない。`CacheMap` のコメントにあった「Selector は `ComputeDigestFunc` の結果とは合成されない」がそのままコードに現れている。

## 合成キーの ID はハッシュではない

ここが一番意外なところだ。`getID` を読む。

```go title="solver/cachemanager.go"
func (c *cacheManager) getID(k *CacheKey) string {
	k.mu.Lock()
	id, ok := k.ids[c]
	if ok {
		k.mu.Unlock()
		return id
	}
	if len(k.deps) == 0 {
		k.ids[c] = k.ID
		k.mu.Unlock()
		return k.ID
	}
	id = c.getIDFromDeps(k)
	k.ids[c] = id
	k.mu.Unlock()
	return id
}
```

([solver/cachemanager.go L368-L384](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachemanager.go#L368-L384))

入力がない (root) キーは `k.ID` をそのまま使う。この `k.ID` は `rootKey()` で digest から計算されるので、ここだけは普通のハッシュだ。

```go title="solver/cachemanager.go"
func rootKey(dgst digest.Digest, output Index) digest.Digest {
	out, _ := cachedigest.FromBytes(fmt.Appendf(nil, "%s@%d", dgst, output), cachedigest.TypeString)
	if strings.HasPrefix(dgst.String(), "random:") {
		return digest.Digest("random:" + dgst.Encoded())
	}
	return out
}
```

([solver/cachemanager.go L451-L457](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachemanager.go#L451-L457))

入力がある場合は `getIDFromDeps` に行く。

```go title="solver/cachemanager.go"
func (c *cacheManager) getIDFromDeps(k *CacheKey) string {
	matches := map[string]struct{}{}

	for i, deps := range k.deps {
		if i == 0 || len(matches) > 0 {
			for _, ck := range deps {
				m2 := make(map[string]struct{})
				if err := c.backend.WalkLinks(c.getID(ck.CacheKey.CacheKey), CacheInfoLink{
					Input:    Index(i),
					Output:   k.Output(),
					Digest:   k.Digest(),
					Selector: ck.Selector,
				}, func(id string) error {
					if i == 0 {
						matches[id] = struct{}{}
					} else {
						m2[id] = struct{}{}
					}
					return nil
				}); err != nil {
					matches = map[string]struct{}{}
					break
				}
				if i != 0 {
					for id := range matches {
						if _, ok := m2[id]; !ok {
							delete(matches, id)
						}
					}
				}
			}
		}
	}

	for k := range matches {
		return k
	}

	return identity.NewID()
}
```

([solver/cachemanager.go L410-L449](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachemanager.go#L410-L449))

やっていることは 2 つ。

**前半** — 入力 0 の許容キーすべてからリンクを辿って候補集合を作り、入力 1 以降で AND を取って絞る。これは `deps` の AND/OR 構造そのものだ。

**最後の 2 行** — 候補が 1 つでもあればそれを返す。1 つもなければ `identity.NewID()`、つまり**完全な乱数を返す**。

つまり合成キーの ID は、「既にストレージ上に同じ入力の組み合わせを持つキーがあるなら、その ID を再利用する。なければ新しい ID を割り当てる」という規則で決まる。**ID は内容の関数ではなく、ストレージの状態の関数になっている。**

`for k := range matches { return k }` が map の反復から任意の 1 つを取っているのも目を引く。候補が 2 つ以上あったときにどれを選ぶかは決まっていない。これで問題にならないのは、後段の `Records` がキー ID から結果を引き、`ensurePersistentKey` が残りのリンクを埋めるからだ。

## ids と indexIDs — ID が 1 つでない理由

同じ `CacheKey` オブジェクトが複数の ID を持つ。

```go title="solver/cachekey.go"
	ids    map[*cacheManager]string

	indexIDs []string
```

`ids` はキャッシュマネージャごとの ID だ。BuildKit はローカルのキャッシュとインポートされたリモートキャッシュを並べて引くので ([solver/combinedcache.go L48-L80](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/combinedcache.go#L48-L80))、同じ論理的なキーがローカル DB では `abc`、リモート由来の DB では `xyz` という別の ID を持つ。`getIDFromDeps` がそのマネージャの `backend` を引いている以上、これは避けられない。

`indexIDs` の方は、実行中の solver が持つメモリ上のインデックス (`edgeIndex`) 用の ID だ。こちらは複数形になっている。

```go title="solver/index.go"
func (ei *edgeIndex) enforceIndexID(k *CacheKey) {
	if len(k.indexIDs) > 0 {
		return
	}

	matches := ei.getAllMatches(k)

	if len(matches) > 0 {
		k.indexIDs = matches
	} else {
		k.indexIDs = []string{identity.NewID()}
	}
	// ...
}
```

([solver/index.go L156-L172](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/index.go#L156-L172))

永続ストレージ側は「1 つ選んで返す」だったのに対し、メモリ側は**マッチしたものを全部持つ**。`edgeIndex` の目的は「同じキーを持つ 2 つの edge を見つけてマージする」ことなので、取りこぼすと edge が重複して走ってしまう。同じアルゴリズムでも、目的に応じて「1 つでよい」「全部欲しい」が分かれている。

`clone()` にはこの `ids` の扱いについてのヒントがある。

```go title="solver/cachekey.go"
func (ck *CacheKey) clone() *CacheKey {
	ck.mu.RLock()
	nk := &CacheKey{
		ID:     ck.ID,
		digest: ck.digest,
		vtx:    ck.vtx,
		output: ck.output,
		ids:    make(map[*cacheManager]string, len(ck.ids)),
	}
	maps.Copy(nk.ids, ck.ids)
	ck.mu.RUnlock()
	return nk
}
```

([solver/cachekey.go L96-L108](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachekey.go#L96-L108))

`deps` はコピーされない。呼び出し側 (`recalcCurrentState`、`exporter.ExportTo`) が自分で `deps` を組み直すためで、`ExportTo` のコメントは「他のエクスポートによる内部 ID の変更から守るため」と言っている ([solver/exporter.go L125](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/exporter.go#L125))。`getID` は `ids` に書き込む副作用を持つので、共有されたキーを複数の経路から触ると干渉する。

## 保存時にリンクを埋める

`getIDFromDeps` は「リンクがあれば ID を再利用する」だけで、リンク自体は作らない。作るのは `Save` から呼ばれる `ensurePersistentKey` だ。

```go title="solver/cachemanager.go"
func (c *cacheManager) ensurePersistentKey(k *CacheKey) error {
	id := c.getID(k)
	for i, deps := range k.Deps() {
		for _, ck := range deps {
			l := CacheInfoLink{
				Input:    Index(i),
				Output:   k.Output(),
				Digest:   k.Digest(),
				Selector: ck.Selector,
			}
			ckID := c.getID(ck.CacheKey.CacheKey)
			if !c.backend.HasLink(ckID, l, id) {
				if err := c.ensurePersistentKey(ck.CacheKey.CacheKey); err != nil {
					return err
				}
				if err := c.backend.AddLink(ckID, l, id); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
```

([solver/cachemanager.go L386-L408](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachemanager.go#L386-L408))

**入力ごとの許容キー「すべて」からリンクを張る。** fast key からも slow key からも、同じ結果キー `id` に向かう辺ができる。だから次回のビルドでは、fast key だけで一致することもあれば slow key だけで一致することもある。`HasLink` で既存を確認してから再帰しているので、深い DAG でも既に埋まった枝を掘り直さない。

## なぜそうなっているか

ID をハッシュにしなかった理由は、**キーの集合が時間とともに増えるから**だと読める。ある結果に到達する入力キーの組み合わせは 1 通りではない。fast key で到達した回と slow key で到達した回、別のビルドが別の経路で同じ ref を作った回。これらは同じ結果を指すべきだが、ハッシュで ID を決めると全部別の ID になり、結果が重複して保存される。

「既存のリンクから ID を引く」方式にすると、後から見つかった経路を**既存の ID に合流させられる**。`ensurePersistentKey` が許容キー全部からリンクを張っているのはそのためで、1 回の `Save` で「この結果に至る既知の経路」をまとめてグラフに書き込んでいる。

代償として、ID は決定的でなくなる。同じビルドを 2 台のマシンで走らせると別の ID になる。リモートキャッシュのフォーマットが ID をそのまま運ばず、`digest` とリンク構造を運んで受け側で組み直すのは、この非決定性を跨がないためだ ([キャッシュチェーンの構築](../cache-chains/)、[キャッシュ設定の決定性](../cache-config-determinism/))。

## どう活かすか

**「1 つの入力に許容値が複数ある」を型で表す。** `[][]T` の内側が OR、外側が AND という構造は、探索アルゴリズムを書く前に型で決まっている。キャッシュに限らず、「条件の集合を満たすものを探す」処理では、条件を `[]T` ではなく `[][]T` にできないかを先に考えると、後から候補を足す余地が残る。

**同一性の判定と識別子の割り当てを分ける。** BuildKit は「これは同じものか」を `digest` と `deps` で判定し、「保存上どう呼ぶか」を別に持った。前者は決定的で、後者は保存先ごとに違ってよい。両者を混ぜて「ハッシュ = ID」にすると、保存先が複数あるときや、同一性の定義が後から広がったときに詰む。

**乱数 ID へのフォールバックは「合流点を作る」ための道具になる。** `identity.NewID()` を返すのは一見雑に見えるが、これは「新しい合流点を 1 つ作る」という意味だ。以後この ID にリンクを張っていけば、別経路から来た探索も同じ点に集まる。内容から ID を導出できない場面では、「ID を作ってからリンクを張る」方が素直になることがある。
