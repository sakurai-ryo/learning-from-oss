---
title: "content-addressable な config の決定性"
description: "キャッシュ config は blob として push されるので、同じ内容なら同じダイジェストになってほしい。ところが組み立ての過程は map の反復順に完全に依存している。sortConfig は「順不同で作って、最後に全部並べ替えてインデックスを張り直す」という力技でそれを打ち消す。"
group: "リモートキャッシュ"
sidebar:
  order: 77
---

## 何を学んだか

リモートキャッシュの本体は `CacheConfig` という 1 個の JSON である。これはレジストリに **content-addressable な blob として push される**ので、同じ内容から常に同じバイト列が出てほしい。ところが `CacheChains` からの組み立ては、Go の map の反復順にべったり依存している。

BuildKit の答えは「途中は諦める」だ。組み立ては順不同のまま行い、最後に `sortConfig` が配列を全部ソートして、配列添字で表現されていた参照をすべて張り直す。`Marshal` の doc コメントがその意図を書いている。

```go title="cache/remotecache/v1/chains.go"
// Marshal converts the cache chains structure into a cache config and a
// collection of providers for reading the results from.
//
// Marshal aims to validate, normalize and sort the output to ensure a
// consistent digest (since cache configs are typically uploaded and stored in
// content-addressable OCI registries).
```

([cache/remotecache/v1/chains.go L207-L212](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/chains.go#L207-L212))

ただし「常に同じ config」が成立するのは、同じキャッシュグラフを同じ実行の中で 2 回 marshal した場合までだ。レコードには `CreatedAt` が入るので、別のビルドから同じバイト列が出ることは期待できない。

## CacheConfig の形 — ポインタではなく添字

型定義は 50 行に満たない。

```go title="cache/remotecache/v1/types/spec.go"
const CacheConfigMediaTypeV0 = "application/vnd.buildkit.cacheconfig.v0"

type CacheConfig struct {
	Layers  []CacheLayer  `json:"layers,omitempty"`
	Records []CacheRecord `json:"records,omitempty"`
}

type CacheLayer struct {
	Blob        digest.Digest     `json:"blob,omitempty"`
	ParentIndex int               `json:"parent,omitempty"`
	Annotations *LayerAnnotations `json:"annotations,omitempty"`
}

type CacheRecord struct {
	Results        []CacheResult   `json:"layers,omitempty"`
	ChainedResults []ChainedResult `json:"chains,omitempty"`
	Digest         digest.Digest   `json:"digest,omitempty"`
	Inputs         [][]CacheInput  `json:"inputs,omitempty"`
}

type CacheInput struct {
	Selector  string `json:"selector,omitempty"`
	LinkIndex int    `json:"link"`
}
```

([cache/remotecache/v1/types/spec.go L9-L49](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/types/spec.go#L9-L49))

グラフの辺はすべて**配列の添字**で表される。`CacheInput.LinkIndex` は `Records` への添字、`CacheResult.LayerIndex` と `CacheLayer.ParentIndex` は `Layers` への添字だ。同じパッケージの `doc.go` に、JSON のレイアウトを注釈付きで書いたコメントがある ([cache/remotecache/v1/types/doc.go L13-L55](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/types/doc.go#L13-L55))。`"parent": -1` が「親なし」を表すこと、`"layers"` の 1 件は「そのレイヤと全祖先を読み込む」という意味であることなど、型からは読めない約束が書かれている。

添字表現は、決定性の観点では最悪の選択肢である。**配列の順序が 1 つ変わると、それを指す添字が全部ずれる。** つまり順序を安定させないと、内容が同じでもバイト列が変わる。

## どこで順序が壊れるか

`Marshal` の走査は 3 か所で map を反復する。

```go title="cache/remotecache/v1/chains.go"
	for it := range c.leaves() {
		if err := marshalItem(ctx, it, st); err != nil {
```

([cache/remotecache/v1/chains.go L220-L224](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/chains.go#L220-L224))

`leaves()` は `map[*item]struct{}` を返すので、どの葉から降りるかが毎回変わる。`marshalItem` の中も `for l := range m` で `map[link]struct{}` を反復する。`marshalRemote` が `state.layers` に追記する順もそれに引きずられる。結果として、`sortConfig` に入る直前の `Layers` と `Records` の並びは実行ごとに違う。

これは事故ではなく、[CacheChains](../cache-chains/) が map ベースの隣接構造を選んだことの必然的な帰結だ。順序付きのスライスで持てば走査順は安定するが、`Add` のたびに行う集合演算 (依存集合の積) が高くつく。BuildKit は**構築の効率を取り、順序の回復を後段に押し付けた**。

## sortConfig — 並べ替えてから添字を張り直す

`sortConfig` は 90 行ほどの、地味だが読み応えのある関数だ。やっていることは「旧添字→新添字」の対応表を作って全参照を書き換える、それだけである。

```go title="cache/remotecache/v1/utils.go"
// sortConfig sorts the config structure to make sure it is deterministic
func sortConfig(cc *cacheimporttypes.CacheConfig) {
	type indexedLayer struct {
		oldIndex int
		newIndex int
		l        cacheimporttypes.CacheLayer
	}

	unsortedLayers := make([]*indexedLayer, len(cc.Layers))
	sortedLayers := make([]*indexedLayer, len(cc.Layers))

	for i, l := range cc.Layers {
		il := &indexedLayer{oldIndex: i, l: l}
		unsortedLayers[i] = il
		sortedLayers[i] = il
	}
	slices.SortFunc(sortedLayers, func(a, b *indexedLayer) int {
		return cmp.Or(cmp.Compare(a.l.Blob, b.l.Blob), cmp.Compare(a.l.ParentIndex, b.l.ParentIndex))
	})
	for i, l := range sortedLayers {
		l.newIndex = i
	}
```

([cache/remotecache/v1/utils.go L18-L39](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/utils.go#L18-L39))

2 本のスライスが**同じ `*indexedLayer` を共有している**のが肝だ。`unsortedLayers` は旧添字で引ける表、`sortedLayers` は並べ替えた結果。`sortedLayers` を回して `newIndex` を書き込むと、共有しているのでその値は `unsortedLayers[old].newIndex` からも読める。旧添字を新添字に変換する関数がこれで手に入る。

レイヤの並べ替えキーは `(Blob, ParentIndex)`。blob ダイジェストが第一キーなので、内容が同じレイヤ集合なら並びも同じになる。

レコードのほうは比較器が長い。

```go title="cache/remotecache/v1/utils.go"
	sort.Slice(sortedRecords, func(i, j int) bool {
		ri := sortedRecords[i].r
		rj := sortedRecords[j].r
		if ri.Digest != rj.Digest {
			return ri.Digest < rj.Digest
		}
		if len(ri.Inputs) != len(rj.Inputs) {
			return len(ri.Inputs) < len(rj.Inputs)
		}
		for i, inputs := range ri.Inputs {
			if len(ri.Inputs[i]) != len(rj.Inputs[i]) {
				return len(ri.Inputs[i]) < len(rj.Inputs[i])
			}
			for j := range inputs {
				if ri.Inputs[i][j].Selector != rj.Inputs[i][j].Selector {
					return ri.Inputs[i][j].Selector < rj.Inputs[i][j].Selector
				}
				inputDigesti := cc.Records[ri.Inputs[i][j].LinkIndex].Digest
				inputDigestj := cc.Records[rj.Inputs[i][j].LinkIndex].Digest
				if inputDigesti != inputDigestj {
					return inputDigesti < inputDigestj
				}
			}
		}
		return false
	})
```

([cache/remotecache/v1/utils.go L63-L88](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/utils.go#L63-L88))

順に、ダイジェスト → 入力の本数 → 各入力のリンク数 → セレクタ → **リンク先レコードのダイジェスト**で比較する。最後のがポイントで、`LinkIndex` (不安定な添字) ではなく、それが指すレコードの digest (安定した内容) で比べている。添字で比べたら、比べる対象が並べ替えの結果に依存してしまう。

並べ替えたあとに、3 種類の添字を一括で書き換える。

```go title="cache/remotecache/v1/utils.go"
	records := make([]cacheimporttypes.CacheRecord, len(sortedRecords))
	for i, r := range sortedRecords {
		for j := range r.r.Results {
			r.r.Results[j].LayerIndex = unsortedLayers[r.r.Results[j].LayerIndex].newIndex
		}
		for j, inputs := range r.r.Inputs {
			for k := range inputs {
				r.r.Inputs[j][k].LinkIndex = unsortedRecords[r.r.Inputs[j][k].LinkIndex].newIndex
			}
			slices.SortFunc(inputs, func(a, b cacheimporttypes.CacheInput) int {
				return cmp.Compare(a.LinkIndex, b.LinkIndex)
			})
		}
		records[i] = r.r
	}
```

([cache/remotecache/v1/utils.go L93-L107](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/utils.go#L93-L107))

最後の `slices.SortFunc` は、1 つの入力番号に複数のリンクがぶら下がるケースの後始末だ。`marshalItem` は map 反復順で append しているので、この並びも不定になる。新しい `LinkIndex` に直したあとで昇順に整えることで、そこも潰す。`ParentIndex` の書き換えは、レイヤ配列を組み直すループのほうにある ([cache/remotecache/v1/utils.go L41-L47](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/utils.go#L41-L47))。

## レイヤ鎖の同一視とメディアタイプの正規化

`Layers` に重複が出ないようにしているのは `marshalRemote` だ。

```go title="cache/remotecache/v1/utils.go"
	desc := r.Descriptors[len(r.Descriptors)-1]
	if desc.MediaType != "" {
		desc = compression.ConvertAllLayerMediaTypes(ctx, true, desc)[0]
	}

	state.descriptors[desc.Digest] = DescriptorProviderPair{ /* ... */ }

	id := desc.Digest.String() + parentID

	if _, ok := state.chainsByID[id]; ok {
		return id
	}

	state.chainsByID[id] = len(state.layers)
```

([cache/remotecache/v1/utils.go L155-L171](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/utils.go#L155-L171))

`Remote` (= descriptor の積み重ね) を末尾から再帰的に分解し、「自分の digest + 親の id」を鎖の識別子にする。同じ鎖が二度現れたら既存の添字を返すだけで、`layers` には追加しない。レイヤ集合は「blob そのもの」ではなく「blob の並び」で同一視されている点に注意がいる。同じ blob でも親が違えば別の `CacheLayer` になる。

`ConvertAllLayerMediaTypes(ctx, true, desc)` の第 2 引数 `true` は OCI 側への変換を意味する ([util/compression/compression.go L208-L229](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/compression/compression.go#L208-L229))。Docker 由来の `application/vnd.docker.image.rootfs.diff.tar.gzip` などが OCI の `application/vnd.oci.image.layer.v1.tar+gzip` に寄せられる。これも決定性の一部だ — 同じレイヤが、経路によって別のメディアタイプで記録されると、descriptor が変わってしまう。テストがこの変換を docker/oci 両方の入力で確認している ([cache/remotecache/v1/chains_test.go L108-L160](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/chains_test.go#L108-L160))。

結果の選択にも決めごとがある。1 つの `item` に複数の結果がぶら下がっているとき、config に載るのは 1 つだけだ。

```go title="cache/remotecache/v1/chains.go"
func (c *item) bestResult() *solver.CacheExportResult {
	if len(c.results) == 0 {
		return nil
	}
	slices.SortFunc(c.results, func(a, b solver.CacheExportResult) int {
		return b.CreatedAt.Compare(a.CreatedAt)
	})
	return &c.results[0]
}
```

([cache/remotecache/v1/chains.go L398-L406](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/chains.go#L398-L406))

`b.CreatedAt.Compare(a.CreatedAt)` なので新しい順、先頭が採用される。

## config 自身が blob になる

`Marshal` の出力を JSON にして、そのダイジェストを取り、descriptor を組んで書き込む。

```go title="cache/remotecache/export.go"
	dt, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	dgst := digest.FromBytes(dt)
	desc := ocispecs.Descriptor{
		Digest:    dgst,
		Size:      int64(len(dt)),
		MediaType: cacheimporttypes.CacheConfigMediaTypeV0,
	}
	configDone := progress.OneOff(ctx, fmt.Sprintf("writing config %s", dgst))
	if err := content.WriteBlob(ctx, ce.ingester, dgst.String(), bytes.NewReader(dt), desc); err != nil {
		// ...
	}
	configDone(nil)

	cache.SetConfig(desc)
```

([cache/remotecache/export.go L236-L253](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/export.go#L236-L253))

`application/vnd.buildkit.cacheconfig.v0` というメディアタイプの blob が 1 個できて、それが OCI index の manifests 配列の 1 要素 (あるいは image manifest の `config`) として置かれる。レジストリから見れば、キャッシュ config はただのイメージの構成要素だ。だから決定性が効く場面は具体的で、**config の内容が前回と同じなら、レジストリへの push が層ごと丸ごと省ける**。配置の詳細は [manifest がある世界とない世界](../remotecache-backends/) を参照。

## 決定性が届いていないところ

読むときに気をつけたい点が 3 つある。

**1. `CreatedAt` は config に入る。** `CacheResult.CreatedAt` は `json:"createdAt"` で `omitempty` が付いていない。同じ内容のキャッシュでも、ビルドした時刻が違えば config のバイト列は変わる。ここでいう決定性は「同じ `CacheChains` から常に同じ config」であって、「同じ Dockerfile から常に同じ config」ではない。ビルド全体の再現性については [再現ビルド](../reproducible-build/) を参照。

**2. レコードの比較器は全順序ではない。** 上に引いた比較器は、ダイジェスト・入力の形・セレクタ・リンク先ダイジェストがすべて一致したとき `false` を返す。`sort.Slice` は安定ソートではないので、この条件で並ぶ複数のレコードの相対順は規定されない。結果 (`Results`) や `ChainedResults` は比較に使われていない。

**3. `item.id` の生成は map 反復順に依存する。** `computeID` は「決定的な ID」とコメントされているが、入力番号ごとの `map[link]struct{}` を順に反復してハッシュに書き込んでいる。

```go title="cache/remotecache/v1/chains.go"
	// deterministic ID
	h := xxhash.New()
	h.Write([]byte(c.dgst.String()))
	h.Write([]byte{0})

	for idx, m := range c.parents {
		binary.Write(h, binary.LittleEndian, uint32(idx))
		h.Write([]byte{0})
		for l := range m {
			if l.src.id == "" {
				l.src.computeID()
			}
			h.Write([]byte(l.src.id))
			// ...
		}
	}
	c.id = string(h.Sum(nil))
```

([cache/remotecache/v1/chains.go L377-L395](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/chains.go#L377-L395))

1 つの入力番号に複数のリンクがあると、書き込み順が実行ごとに変わりうる。ただしこの `id` は config には出てこない。使われるのは import 側の `cacheKeyStorage.byID` のキーとしてだけで ([cache/remotecache/v1/cachestorage.go L16-L39](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/remotecache/v1/cachestorage.go#L16-L39))、1 つのプロセスの中で衝突しなければよい。config の決定性とは独立した話だ。ID が 2 系統ある — 外に出る `CacheRecord.Digest` と、中だけの `item.id` — ことを掴んでおくと読みやすくなる。

## どう活かすか

**「決定的に作る」より「作ってから正規化する」ほうが安いことがある。** 構築中ずっと順序を維持しようとすると、データ構造の選択肢が狭まる (map が使えない、挿入位置を探す必要がある)。BuildKit は構築を map で速く回し、出力の直前に 1 回だけ全体をソートする。正規化が 1 か所に閉じていれば、決定性の議論もそこだけを読めば済む。

**添字で参照するデータ構造を並べ替えるときは、「旧→新の対応表」を先に作る。** `oldIndex` / `newIndex` を持つラッパを 2 本のスライスで共有する `sortConfig` のやり方は、ソート後も旧添字で引ける表が残るという点で素直だ。並べ替えとインデックス書き換えを 1 パスでやろうとすると、途中で新旧が混ざって壊れる。

**比較キーは「不安定な参照」ではなく「安定した内容」で取る。** レコードの比較器が `LinkIndex` ではなくリンク先の digest を見るのは、まさにこれを避けるためだ。ソートの結果に依存する値をソートのキーにしてはいけない。
