---
title: "資源の関係グラフを、クライアントがラベルで書く"
description: "containerd は「この manifest がこの layer を参照している」を知らない。それは OCI の知識であって、デーモンの知識ではないからだ。代わりに、blob に containerd.io/gc.ref.content.l.0 のようなラベルを付けさせ、GC はラベルを辿る。デーモンが知らない関係を、ラベルという汎用の入れ物で表現している。"
group: "lease と GC"
sidebar:
  order: 21
---

## 何を学んだか

### デーモンはイメージの構造を知らない

content store から見れば、manifest も config も layer も **ただのバイト列** だ。「この JSON をパースすると layer の digest が並んでいる」というのは OCI Image Spec の知識で、content store の知識ではない。

だから GC がグラフを辿ろうとしても、blob から blob への辺が分からない。

containerd の解決は、**知っている者に書かせる** ことだ。pull を実行するクライアントは OCI の構造を知っているので、manifest blob にこういうラベルを付ける。

```
containerd.io/gc.ref.content.config = sha256:aaa...
containerd.io/gc.ref.content.l.0    = sha256:bbb...
containerd.io/gc.ref.content.l.1    = sha256:ccc...
```

GC はラベルのキーが `containerd.io/gc.ref.content` で始まっていれば、値を digest として辺を張る。**中身は一切見ない**。

### 型ごとの参照ラベル

| ラベルキー                                    | 意味                                             |
| --------------------------------------------- | ------------------------------------------------ |
| `containerd.io/gc.ref.content`                | この資源は指定の blob を参照する                 |
| `containerd.io/gc.ref.snapshot.<snapshotter>` | 指定の snapshot を参照する                       |
| `containerd.io/gc.root`                       | このオブジェクトと、それが参照するものを保持する |
| `containerd.io/gc.expire`                     | 指定時刻までは保持する (RFC 3339)                |
| `containerd.io/gc.flat`                       | リースの対象は押さえるが、その先は辿らない       |
| `containerd.io/gc.bref.*`                     | 逆向きの参照。子が親を指す                       |

キーの末尾には任意の文字列を足せるので、`gc.ref.content.l.0`、`gc.ref.content.l.1` のように複数の参照を並べられる。**キーの一意性のためだけの接尾辞** で、GC は解釈しない。

### 展開との連結

layer を展開して snapshot を作ったら、その関係も記録が要る。unpack はこう書く。

```
# layer blob に付ける
containerd.io/gc.ref.snapshot.overlayfs = <chainID>
```

「この blob は overlayfs のこの snapshot を参照している」。これによって、イメージが生きている限り、そこから展開された snapshot も守られる。

### 逆向きの参照もある

通常は親が子を指す。しかしそれだと、子を作るときに親を更新する必要がある。`gc.bref.*` (back reference) は逆で、子に「私はこの親のもの」と書かせる。親が存在しなくてもよいので、**作る順序の制約がなくなる**。

## ソースコードのどこか

### ラベルの一覧と説明

[`core/metadata/gc.go#L67-L110`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/gc.go#L67-L110)。

```go title="core/metadata/gc.go"
	// Reference labels are used to directly establish a connection
	// from a parent object to a child object. The child object will
	// remain referred to for the lifecycle of the parent object.

	labelGCRef        = []byte("containerd.io/gc.ref.")
	labelGCSnapRef    = []byte("containerd.io/gc.ref.snapshot.")
	labelGCContentRef = []byte("containerd.io/gc.ref.content")
	labelGCImageRef   = []byte("containerd.io/gc.ref.image")
```

プレフィックスのマッチだけで参照を認識する。ラベルの値が実在するかどうかも、GC は問わない (存在しないノードへの辺は無視される)。

### ラベルを付けるのはハンドラ

[`core/images/handlers.go#L239-L285`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/images/handlers.go#L239-L285)。

```go title="core/images/handlers.go"
// SetChildrenMappedLabels is a handler wrapper which sets labels for the content on
// the children returned by the handler and passes through the children.
// Must follow a handler that returns the children to be labeled.
func SetChildrenMappedLabels(manager content.Manager, f HandlerFunc, labelMap func(ocispec.Descriptor) []string) HandlerFunc {
	if labelMap == nil {
		labelMap = ChildGCLabels
	}
	return func(ctx context.Context, desc ocispec.Descriptor) ([]ocispec.Descriptor, error) {
		children, err := f(ctx, desc)
		...
			for _, ch := range children {
				labelKeys := labelMap(ch)
				for _, key := range labelKeys {
					idx := keys[key]
					keys[key] = idx + 1
					if strings.HasSuffix(key, ".sha256.") {
						key = fmt.Sprintf("%s%s", key, ch.Digest.Hex()[:12])
					} else if idx > 0 || key[len(key)-1] == '.' {
						key = fmt.Sprintf("%s%d", key, idx)
					}

					info.Labels[key] = ch.Digest.String()
					fields = append(fields, "labels."+key)
				}
			}
```

**子を返すハンドラをラップして、その結果からラベルを作る**。pull のハンドラチェーンに 1 つ挟むだけで、辿ったグラフがそのままラベルとして記録される ([handler を合成して、イメージのグラフを辿る](../image-handlers/))。

キー生成の分岐が細かい。`.sha256.` で終わるキーには digest の先頭 12 文字を、そうでなければ連番を足す。前者は referrer (署名や SBOM の関連付け) 用で、**順序が変わっても同じキーになる** 必要があるためだ。

### 子の種類でラベルのキーを変える

[`core/images/mediatypes.go#L214-L235`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/images/mediatypes.go#L214-L235)。

```go title="core/images/mediatypes.go"
// ChildGCLabels returns the label for a given descriptor to reference it
func ChildGCLabels(desc ocispec.Descriptor) []string {
	if _, ok := desc.Annotations[AnnotationManifestSubject]; ok {
		return []string{"containerd.io/gc.ref.content.referrer.sha256."}
	}
	mt := desc.MediaType
	if IsKnownConfig(mt) {
		return []string{"containerd.io/gc.ref.content.config"}
	}

	switch mt {
	case MediaTypeDockerSchema2Manifest, ocispec.MediaTypeImageManifest:
		return []string{"containerd.io/gc.ref.content.m."}
	}

	if IsLayerType(mt) {
		return []string{"containerd.io/gc.ref.content.l."}
	}

	return []string{"containerd.io/gc.ref.content."}
}
```

GC にとっては全部同じ「content への参照」だが、キーを分けることで **人間とツールが読める** ようになっている。`ctr content ls` でラベルを見れば、どれが config でどれが layer かが分かる。

`ChildGCLabelsFilterLayers` という変種もあり、これは layer にラベルを付けない。「manifest だけ持っていて layer は消えてよい」という保持の仕方を表現する。イメージのメタデータだけ残してディスクを空けたい場合に使う。

### 展開結果を blob に紐付ける

[`core/unpack/unpacker.go#L676-L684`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/unpack/unpacker.go#L676-L684)。

```go title="core/unpack/unpacker.go"
			fmt.Sprintf("containerd.io/gc.ref.snapshot.%s", unpack.SnapshotterKey): chainID,
	...
	_, err = cs.Update(ctx, cinfo, fmt.Sprintf("labels.containerd.io/gc.ref.snapshot.%s", unpack.SnapshotterKey))
```

snapshotter の名前がラベルのキーに入る。同じ layer を overlayfs と erofs の両方で展開していれば、ラベルが 2 つ付き、両方の snapshot が守られる。

### イメージ変換でも同じラベルを張り直す

[`core/images/converter/default.go#L186-L220`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/images/converter/default.go#L186-L220)。

```go title="core/images/converter/default.go"
				labelKey := fmt.Sprintf("containerd.io/gc.ref.content.l.%d", i)
	...
		labels["containerd.io/gc.ref.content.config"] = newConfig.Digest.String()
```

イメージを変換して新しい manifest を作るときも、同じ規約でラベルを付ける。**ラベルの規約が、クライアント側ライブラリ全体で共有されている** ことが分かる。

裏を返せば、この規約を知らないクライアントが blob を書くと、GC に消される。containerd を直接叩くツールを書くときの落とし穴になる。

## なぜそうなっているか

### デーモンにフォーマットの知識を入れない

もし GC が manifest を parse して layer を見つけていたら、次のことが起きる。

- 新しい mediaType が出るたびに containerd の更新が必要
- 独自形式の artifact (Helm chart、WASM モジュール、SBOM) を content store に置けない
- parse の失敗が GC の失敗になる

ラベルにしておけば、**containerd は「参照がある」ことだけを知り、なぜ参照があるかは知らない**。OCI Artifacts のような後発の仕組みが、containerd の変更なしに載る。

### ラベルという汎用の入れ物を再利用する

参照関係のために新しい API やテーブルを作ることもできた。ラベルを使ったことで、

- 既存の `Update(info, "labels.xxx")` がそのまま使える
- `ctr content ls` などで人間が見られる
- 新しい種類の関係 (条件付き参照、後方参照) をラベルの規約追加だけで足せる

実際、`gc.bref.*` や `gc.cond.*` は後から追加されたもので、**API もスキーマも変えずに** 導入されている。

### 規約の代償

ラベルは文字列なので、型で守られない。ラベルを付け忘れれば資源は消え、綴りを間違えても気付かない。containerd はこれを、

- **クライアントライブラリの側にヘルパを用意する** (`SetChildrenLabels`)
- **ハンドラの合成に組み込む** — pull の経路を通れば自動で付く

ことで緩和している。「規約を守る」のではなく「規約を守るコードを通る」形にしている。

## どう活かすか

### ラベルを見て参照関係を確認する

```sh
# blob のラベル
$ ctr -n k8s.io content ls | head

# 特定 blob の詳細 (ラベルが見える)
$ ctr -n k8s.io content ls "digest==sha256:<manifest-digest>"
```

「イメージがあるのに layer が消えている」場合、manifest に `gc.ref.content.l.N` ラベルが付いていない可能性がある。手動で blob を書いたツールや、古いバージョンの containerd で作られたものが原因になる。

### 手で参照を張る

一時的に資源を守りたいときは、ラベルを付ければよい。

```sh
# この blob をルートにする (誰からも参照されなくても消えない)
$ ctr -n k8s.io content label sha256:<digest> containerd.io/gc.root=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 期限付きで守る
$ ctr -n k8s.io content label sha256:<digest> containerd.io/gc.expire=2026-12-31T00:00:00Z
```

デバッグ中に「GC に消されずに blob を残しておきたい」場面で使える。

### 「関係の宣言を利用者に委ねる」設計

自分のシステムで同じ形を採るときの要点は 3 つ。

- **参照を汎用の属性 (ラベル、タグ、メタデータ) として表現する** — 専用テーブルを作らない
- **キーの接頭辞で意味を持たせ、接尾辞は自由にする** — 複数の参照を並べられるようにする
- **宣言を書くコードをライブラリ側に用意する** — 利用者に規約を手書きさせない

3 番目がないと、規約を守らない実装が必ず現れる。containerd でも、ライブラリを通さずに content store を叩くツールが GC に悩まされてきた。
