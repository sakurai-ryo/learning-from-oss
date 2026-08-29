---
title: "Docker の image store・graphdriver と何が違うか"
description: "Docker も containerd も、圧縮された layer blob を content store に残したまま、展開後の rootfs を別に管理する。containers/storage は blob を残さず、展開済みレイヤと digest の記録だけを持つ。その結果 push のときに元の blob が手元にないので、圧縮とアップロードを避けるための blob info cache という別の仕組みが要る。3 者の設計の差を追うと「何を捨てて何を覚えるか」の選択が見えてくる。"
group: "イメージとストレージ"
sidebar:
  order: 12
---

## 何を学んだか

### 3 者はレイヤの持ち方が違う

同じ OCI イメージを扱うのに、3 つの実装でディスク上の形が違う。

|                          | Docker                                   | containerd                                    | containers/storage                 |
| ------------------------ | ---------------------------------------- | --------------------------------------------- | ---------------------------------- |
| 圧縮 blob の保持         | `/var/lib/docker/image/<driver>/` に保持 | **content store に digest 名で保持**          | **保持しない**                     |
| 展開後のレイヤ           | graphdriver (overlay2)                   | snapshotter                                   | graph driver (overlay)             |
| blob と展開後の対応      | 内部 DB                                  | metadata (bbolt) のラベル                     | `layers.json` の digest フィールド |
| メタデータの持ち主       | dockerd                                  | containerd                                    | ファイル (複数プロセスが読む)      |
| 圧縮 blob と展開後の分離 | 分離                                     | **明確に分離** (content store と snapshotter) | **統合** (レイヤ 1 種類のみ)       |

containerd はこの分離が最も徹底していて、content store (blob を digest で持つ) と snapshotter (展開してマウント可能にする) が独立したプラグインになっている ([containerd 章の content store](../../containerd/content-store/) と [snapshotter インターフェース](../../containerd/snapshotter-interface/))。

containers/storage は逆に、**「レイヤ」という 1 つの概念に統合した**。pull したレイヤは展開されて `diff/` に置かれ、圧縮された tar.gz は捨てられる。残るのは digest の記録だけだ。

### 捨てた結果、push で困る

blob を持っていないと、`podman push` のときに元の tar.gz が作れない。展開済みのディレクトリから tar を作り直しても、**圧縮の非決定性のせいで digest が変わる** 可能性がある。digest が変われば、レジストリ側から見て「別のレイヤ」になり、既にあるはずのレイヤを再アップロードすることになる。

そこで containers/image には **blob info cache** という別の仕組みがある。「この非圧縮 digest は、あの圧縮 digest に対応する」「このレジストリのこのリポジトリには、この digest の blob が既にある」を記録しておくデータベースだ。push のときはまずこのキャッシュを引き、レジストリに「この digest 持ってる?」と聞いて、あればアップロードを丸ごと省く。

**捨てたものを、メタデータで補っている**。

### ディスク使用量の差

- **Docker / containerd** — 圧縮 blob + 展開後のレイヤの両方を持つ。同じ内容を 2 回持つことになる (ただし blob は prune できる)
- **containers/storage** — 展開後だけ。ディスクは節約できるが、push のたびに再圧縮が要る (キャッシュが効かなければ)

pull が中心で push をあまりしない使い方 (本番ノード) では containers/storage が有利、ビルドして push を繰り返す使い方では blob を持っている方が有利、というトレードオフになる。

## ソースコードのどこか

### Layer は blob を持たず、digest だけを覚える

[`vendor/go.podman.io/storage/layers.go#L126-L156`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/storage/layers.go#L126)。

```go title="go.podman.io/storage/layers.go"
	// CompressedDigest is the digest of the blob that was last passed to
	// ApplyDiff() or create(), as it was presented to us.
	CompressedDigest digest.Digest `json:"compressed-diff-digest,omitempty"`

	// CompressedSize is the length of the blob that was last passed to
	// ApplyDiff() or create(), as it was presented to us.
	CompressedSize int64 `json:"compressed-size,omitempty"`

	// UncompressedDigest is the digest of the blob that was last passed to
	// ApplyDiff() or create(), after we decompressed it.  Often referred to
	// as a DiffID.
	UncompressedDigest digest.Digest `json:"diff-digest,omitempty"`
```

コメントの言い回しが正確だ。「**最後に `ApplyDiff()` に渡された blob の digest**、我々に提示されたときのもの」。blob そのものは保持していないので、「渡されたときの digest を覚えている」としか言えない。

`UncompressedDigest` が OCI Image Spec でいう `diff_id` にあたる。イメージの config に並んでいる `diff_ids` と突き合わせて、「このレイヤは既に持っている」と判定するための鍵になる。

`TOCDigest` という 3 つ目の digest もある。

```go title="go.podman.io/storage/layers.go"
	// TOCDigest represents the digest of the Table of Contents (TOC) of the blob.
	// This digest is utilized when the UncompressedDigest is not
	// validated during the partial image pull process, but the
	// TOC itself is validated.
	// It serves as an alternative reference under these specific conditions.
	TOCDigest digest.Digest `json:"toc-digest,omitempty"`
```

`zstd:chunked` による **部分 pull** のためのものだ。レイヤ全体を落とさず、必要なファイルだけを Range リクエストで取る場合、レイヤ全体の digest は検証できない。代わりに目次 (TOC) の digest を検証する。containerd の remote snapshotter (stargz) と目的は同じだが、実装の位置が違う。

### blob info cache が「捨てたもの」を補う

[`vendor/go.podman.io/image/v5/types/types.go#L215-L232`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/image/v5/types/types.go#L215)。

```go title="go.podman.io/image/v5/types/types.go"
type BlobInfoCache interface {
	// UncompressedDigest returns an uncompressed digest corresponding to anyDigest.
	// May return anyDigest if it is known to be uncompressed.
	// Returns "" if nothing is known about the digest (it may be compressed or uncompressed).
	UncompressedDigest(anyDigest digest.Digest) digest.Digest
	// RecordDigestUncompressedPair records that the uncompressed version of anyDigest is uncompressed.
	// It’s allowed for anyDigest == uncompressed.
	// WARNING: Only call this for LOCALLY VERIFIED data; don’t record a digest pair just because some remote author claims so (e.g.
	// because a manifest/config pair exists); otherwise the cache could be poisoned and allow substituting unexpected blobs.
	// (Eventually, the DiffIDs in image config could detect the substitution, but that may be too late, and not all image formats contain that data.)
	RecordDigestUncompressedPair(anyDigest digest.Digest, uncompressed digest.Digest)
```

警告が重い。「**ローカルで検証したデータに対してのみ呼べ**。リモートの作者がそう主張しているからといって記録するな。キャッシュが汚染され、意図しない blob が置き換えられる」。

このキャッシュは「digest A の中身は digest B と同じである」と主張するものなので、嘘を入れられると **別の blob をすり替えられる**。だから記録は「自分で展開して digest を計算した」場合に限る。キャッシュがセキュリティ境界になっている例だ。

もう 1 つの用途、「どこに blob があるか」の記録も同じインターフェースにある。

```go title="go.podman.io/image/v5/types/types.go"
	// RecordKnownLocation records that a blob with the specified digest exists within the specified (transport, scope) scope,
	// and can be reused given the opaque location data.
	RecordKnownLocation(transport ImageTransport, scope BICTransportScope, digest digest.Digest, location BICLocationReference)
```

コメントで scope の意味も説明されている。

```go title="go.podman.io/image/v5/types/types.go"
//     Each transport defines its own “scopes” within which blob reuse is possible (e.g. in, the docker/distribution case, blobs
//     can be directly reused within a registry, or mounted across registries within a registry server.)
```

レジストリの `mount` API (別リポジトリの blob を参照だけで持ってくる) が使えるかどうかは transport ごとに違うので、**再利用可能な範囲の定義を transport に委ねている**。

そしてキャッシュの失敗に対する態度が明快だ。

```go title="go.podman.io/image/v5/types/types.go"
// None of the methods return an error indication: errors when neither reading from, nor writing to, the cache, should be fatal;
// users of the cache should just fall back to copying the blobs the usual way.
```

**メソッドがエラーを返さない**。キャッシュが壊れていても「普通にコピーする」に戻るだけだからだ。実装は SQLite だが、それが開けなくても pull と push は成功する。

### イメージのメタデータは big data として持つ

manifest と config は展開できないので、そのまま保存する必要がある。[`vendor/go.podman.io/storage/images.go#L74-L85`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/storage/images.go#L74)。

```go title="go.podman.io/storage/images.go"
	// BigDataNames is a list of names of data items that we keep for the
	// convenience of the caller.  They can be large, and are only in
	// memory when being read from or written to disk.
	BigDataNames []string `json:"big-data-names,omitempty"`

	// BigDataSizes maps the names in BigDataNames to the sizes of the data
	BigDataSizes map[string]int64 `json:"big-data-sizes,omitempty"`

	// BigDataDigests maps the names in BigDataNames to the digests of the
	BigDataDigests map[string]digest.Digest `json:"big-data-digests,omitempty"`
```

`images.json` にはメタデータの索引だけを置き、実体は別ファイルにする。「大きいので、読み書きするときだけメモリに載せる」。**JSON ファイル方式の弱点 (全部読む) を、大きいものを外に出すことで緩和している**。

containerd の content store が blob を digest 名のファイルに置くのと、発想としては近い。ただし containerd はすべての blob をそこに置き、containers/storage は「レイヤ以外」だけを置く。

## なぜそうなっているか

### 「使うために展開する」が主で、「配るために保持する」が従

containers/storage の設計は、**「イメージはコンテナを動かすために展開されるもの」** という前提に立っている。展開後があれば動く。圧縮 blob は動かすのに要らない。だから捨てる。

containerd が blob を保持するのは、containerd が **配布のインフラでもある** からだ。CRI 経由で pull されたイメージを別のノードに配る、レジストリのミラーとして振る舞う、といった用途がある。用途が違えば「何を保持するか」も変わる。

Podman は「開発者のマシンと単一ホストのサーバ」を主戦場に置いたので、ディスク節約の方を取った。その代償として blob info cache が必要になったが、これは push のときだけ効けばよいものなので、失敗しても致命的でない。**捨てる判断とその補償が、コストの非対称性に合っている**。

### 統合したことで、レイヤの ID が 1 つになった

containerd では、同じレイヤに対して複数の識別子がある。blob の digest、diff_id、snapshot のキー、chainID。それぞれ別の名前空間にあり、変換のためのラベルが要る。

containers/storage では、レイヤの ID は 1 つ (ランダムに生成される内部 ID) で、そこに digest がフィールドとしてぶら下がる。**識別子の変換が構造体のフィールドアクセスで済む**。これは実装を単純にするが、逆に「digest からレイヤを引く」ためにインデックスを自前で持つ必要が出る (`LayersByCompressedDigest` のような関数がある)。

### キャッシュにエラーを返させない設計

blob info cache の「メソッドがエラーを返さない」という判断は、キャッシュの正しい扱い方の教科書的な例だ。キャッシュは **無くても正しく動く** ものであり、あれば速い。エラーを返せば呼び出し側が扱いを迷うが、返さなければ「キャッシュミス」と同じ扱いになる。

ただしこれは「キャッシュが嘘をつかない」ことが前提なので、書き込み側に厳しい制約 (ローカルで検証したデータのみ) を課している。**読み取りを緩くする代わりに書き込みを厳しくする**、というバランスの取り方になっている。

## どう活かすか

- **何を保持するかは、主たる用途で決める。** 「動かすため」なら展開後だけでよく、「配るため」なら原本が要る。両方保持するのが常に正しいわけではない。
- **捨てるなら、捨てたことの補償を別の層に置く。** blob を捨てて blob info cache を足したのは、コストを「頻度の低い操作 (push)」に寄せる判断だった。捨てる判断は、補償のコストと合わせて評価する。
- **キャッシュのインターフェースはエラーを返さない。** 「無くても正しく動く」ことを型で表現できる。代わりに、キャッシュに嘘を入れないための制約をコメントではなく設計で担保する。
- **「大きいもの」を索引から外に出す。** メタデータを 1 つの JSON にまとめる方式は、サイズが増えると破綻する。big data として別ファイルに逃がす形は、単純な構造を保ったままスケールさせる常套手段だ。
