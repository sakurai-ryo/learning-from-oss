---
title: "remote snapshotter: レイヤを落とさずに rootfs を作る"
description: "Prepare に ErrAlreadyExists を返せば、containerd はそのレイヤの取得と展開をやめる。この 1 行のプロトコルだけで、レジストリから遅延読み込みする snapshotter (stargz、nydus、SOCI) が成立する。containerd 側にはリモートの概念が一切ない。"
group: "ファイルシステムを積む"
sidebar:
  order: 39
---

## 何を学んだか

### プロトコルは「もう持っている」と言うだけ

pull のとき、containerd は各レイヤについて `Prepare` を呼ぶ。このとき `containerd.io/snapshot.ref` ラベルに **これから作りたい committed snapshot の chainID** を載せる。

snapshotter が「その chainID の snapshot は用意できる」と判断したら、

1. その chainID で committed snapshot を作る
2. `Prepare` からは `ErrAlreadyExists` を返す

containerd はこれを見て、**そのレイヤの blob を取得せず、展開もしない**。次のレイヤに進む。

たったこれだけで、「レジストリからレイヤ全体を落とさずにコンテナを起動する」が成立する。

### containerd 側に「リモート」の概念はない

この仕組みで containerd が持っているのは、

- `Prepare` にラベルを載せる
- `ErrAlreadyExists` が返ったら `Stat` で確認し、スキップする

の 2 つだけ。**リモートストア、遅延読み込み、FUSE といった概念は一切知らない**。

だから stargz (Google の crfs 由来)、nydus (Alibaba)、SOCI (AWS)、OverlayBD と、実装が独立に育っている。

### 情報はラベルとアノテーションで渡す

remote snapshotter は「どのイメージの、どのレイヤか」を知る必要がある。chainID だけでは、レジストリのどこを見ればよいか分からない。

そこで pull の handler にラッパを挟み、**layer の descriptor にアノテーションを追加する**。アノテーションは `containerd.io/snapshot/` プレフィックスを持ち、`Prepare` のラベルとして snapshotter に届く。

| アノテーション                               | 内容                        |
| -------------------------------------------- | --------------------------- |
| `containerd.io/snapshot/cri.image-ref`       | イメージの参照名            |
| `containerd.io/snapshot/cri.layer-digest`    | この layer の digest        |
| `containerd.io/snapshot/cri.image-layers`    | 残りの layer の digest 一覧 |
| `containerd.io/snapshot/cri.manifest-digest` | manifest の digest          |

### 展開せずに済む別解 — erofs

remote snapshotter とは別に、**展開のコストを下げる** アプローチもある。erofs snapshotter は、レイヤを EROFS 形式の blob に変換して保持し、マウント時に overlayfs で重ねる。

こちらはローカルに持つ点で従来と同じだが、「tar を数万ファイルに展開する」コストを避けられる。

## ソースコードのどこか

### プロトコルの定義

[`core/snapshots/snapshotter.go#L37-L44`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/snapshots/snapshotter.go#L37-L44)。

```go title="core/snapshots/snapshotter.go"
	// LabelSnapshotRef is set by the unpacker on the extraction Prepare to
	// the target chainID. A snapshotter that already has the layer commits a
	// snapshot named after this value and returns ErrAlreadyExists, which
	// makes the unpacker skip fetching and applying the layer (the remote
	// snapshot protocol). It is inherited by FilterInheritedLabels.
	LabelSnapshotRef = "containerd.io/snapshot.ref"
```

「the remote snapshot protocol」と名前が付いている。**プロトコルの全体がこのコメント 5 行に収まっている**。

### 使う側のロジック

[`docs/snapshotters/remote-snapshotter.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/snapshotters/remote-snapshotter.md) に擬似コードがある。

```go title="docs/snapshotters/remote-snapshotter.md"
// Gets annotations appended to the targeting layer which would contain
// snapshotter-specific information passed by the user.
labels := snapshots.FilterInheritedLabels(desc.Annotations)
if labels == nil {
	labels = make(map[string]string)
}

// Specifies ChainID of the targeting committed snapshot.
labels["containerd.io/snapshot.ref"] = chainID
...
mounts, err = sn.Prepare(ctx, key, parent.String(), opts...)
```

**descriptor のアノテーションが、そのまま snapshot のラベルになる**。`FilterInheritedLabels` が `containerd.io/snapshot/` プレフィックスのものだけを通す ([Snapshotter インターフェースの 4 つの動詞](../snapshotter-interface/))。

受け取り側の処理。

```go title="docs/snapshotters/remote-snapshotter.md"
mounts, err = sn.Prepare(ctx, key, parent.String(), opts...)
if err != nil {
	if errdefs.IsAlreadyExists(err) {
		// Ensures the layer existence
		if _, err := sn.Stat(ctx, chainID); err != nil {
			// Handling error
		} else {
			// snapshot found with ChainID
			// pulling/unpacking will be skipped
			continue
		}
	} else {
		return err
	}
}
```

`ErrAlreadyExists` を受けたら **`Stat` で本当に存在するかを確認する**。snapshotter の申告を鵜呑みにせず、確認してからスキップする。

この 2 段階があるので、snapshotter がバグで `ErrAlreadyExists` を返しても、存在しなければ通常の経路に落ちる。

### 判断は snapshotter の責任

```markdown title="docs/snapshotters/remote-snapshotter.md"
Remote snapshotter must define and enforce policies about whether it will use an existing snapshot.
When remote snapshotter allows the user to use that snapshot, it must return `ErrAlreadyExists`.
```

「既存の snapshot を使ってよいかのポリシーは、remote snapshotter が定義し、強制しなければならない」。

これは重要な線引きだ。remote snapshot は「レジストリのイメージを直接見る」ので、**認可の判断が snapshotter に移る**。containerd は「使ってよい」と言われたら使う。stargz snapshotter が独自に認証情報を扱っているのはこのためだ。

### アノテーションを追加するハンドラ

[`pkg/snapshotters/annotations.go#L51-L75`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/snapshotters/annotations.go#L51-L75)。

```go title="pkg/snapshotters/annotations.go"
func AppendInfoHandlerWrapper(ref string) func(f images.Handler) images.Handler {
	return func(f images.Handler) images.Handler {
		return images.HandlerFunc(func(ctx context.Context, desc ocispec.Descriptor) ([]ocispec.Descriptor, error) {
			children, err := f.Handle(ctx, desc)
			...
			if images.IsManifestType(desc.MediaType) {
				for i := range children {
					c := &children[i]
					if images.IsLayerType(c.MediaType) {
						if c.Annotations == nil {
							c.Annotations = make(map[string]string)
						}
						c.Annotations[TargetRefLabel] = ref
						c.Annotations[TargetLayerDigestLabel] = c.Digest.String()
						c.Annotations[TargetImageLayersLabel] = getLayers(ctx, TargetImageLayersLabel, children[i:], labels.Validate)
						c.Annotations[TargetManifestDigestLabel] = desc.Digest.String()
					}
				}
			}
			return children, nil
		})
	}
}
```

[handler の合成](../image-handlers/) がここでも使われている。pull の handler チェーンに 1 つ挟むだけで、全 layer にアノテーションが付く。

`children[i:]` を渡しているのは、**その layer 以降の一覧** を載せるため。remote snapshotter は「この先に何層あるか」を知って先読みを最適化できる。

ラベルには長さ制限があるので、`getLayers` は `labels.Validate` を見ながら **入るだけ入れる**。

```go title="pkg/snapshotters/annotations.go"
// getLayers returns comma-separated digests based on the passed list of
// descriptors. The returned list contains as many digests as possible as well
// as meets the label validation.
```

「できるだけ多く、ただし検証を満たす範囲で」。切り詰められても動作は正しく、最適化の効きが下がるだけ、という設計になっている。

### erofs という別のアプローチ

[`docs/snapshotters/erofs.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/snapshotters/erofs.md)。

```markdown title="docs/snapshotters/erofs.md"
The EROFS snapshotter is a native containerd
snapshotter to enable the EROFS filesystem, specifically to keep EROFS‑formatted
blobs for each committed snapshot and to prepare an OverlayFS mount for each
active snapshot.
...
Although the EROFS snapshotter sounds somewhat similar to an enhanced OverlayFS
snapshotter, several kernel features are highly tied to the EROFS internals, so
it would be better to leave it as an independent snapshotter. This way, existing
OverlayFS users will not be impacted by the new EROFS‑specific behaviors
```

「overlayfs snapshotter を拡張するのではなく、独立した snapshotter にする」という判断が説明されている。理由は **既存の利用者に影響を与えないため**。

差し替え可能な拡張点があると、「既存を改造する」より「新しい実装を足す」ほうが安全になる。プラグイン機構の効用がここに現れている。

erofs は differ とセットで使う。

```markdown title="docs/snapshotters/erofs.md"
In order to convert OCI container images directly into EROFS-formatted blobs,
the EROFS differ must be specified with the EROFS snapshotter. Otherwise,
if the walking differ is used, the EROFS snapshotter will behave much like the
existing OverlayFS snapshotter
```

differ も snapshotter もプラグインなので、**組み合わせで挙動が変わる** ([differ: レイヤ tar を snapshot に適用する](../apply-and-diff/))。片方だけ設定すると性能が出ない、という運用上の注意点でもある。

## なぜそうなっているか

### 「もう持っている」を最適化の合図として使う

`ErrAlreadyExists` は本来「重複作成の失敗」を表すエラーだ。それを「取得不要」の合図に転用したのが、このプロトコルの発明にあたる。

新しい API を足さずに済んだ利点は大きい。

- containerd 側の変更が最小 (エラーを見て分岐するだけ)
- 対応しない snapshotter は普通に動く (この経路を通らない)
- proxy plugin 経由でも同じ (エラーは gRPC を越えられる)

同じパターンは content store にもある。既存 blob への `Writer` が `ErrAlreadyExists` を返し、pull がその layer を飛ばす ([ingest: 中断しても続きから書ける書き込み](../content-ingest/))。**「既にある」を積極的な意味に使う** のが containerd 全体の作法になっている。

### ラベルを情報の運搬路にする

snapshotter に渡したい情報は実装ごとに違う。stargz はイメージ参照が要り、nydus は別の情報が要る。API に引数を足すと、対応しない実装にも見えてしまう。

ラベル (文字列の map) なら、**containerd が意味を知らないまま素通しできる**。プレフィックスで名前空間を分けておけば衝突もしない。

### 認可の境界が動くことの帰結

remote snapshotter は containerd を通さずレジストリにアクセスする。これは「containerd が pull の可否を制御する」という前提を崩す。

[image verifier](../image-verifier/) で pull を止めても、remote snapshotter が独自に取ってきてしまえば意味がない。だからドキュメントは「ポリシーの定義と強制は snapshotter の責任」と明記している。

**性能のために境界を動かすと、責任も一緒に動く**。この種のトレードオフを文書化しているのは誠実な設計だ。

## どう活かすか

### remote snapshotter を試す

stargz snapshotter を入れて CRI から使う場合。

```toml
version = 3
[plugins.'io.containerd.cri.v1.images']
  snapshotter = "stargz"

[proxy_plugins]
  [proxy_plugins.stargz]
    type = "snapshot"
    address = "/run/containerd-stargz-grpc/containerd-stargz-grpc.sock"
```

proxy plugin として外部プロセスを繋ぐ ([proxy plugin](../proxy-plugins/))。イメージ側も stargz 形式に変換しておく必要がある。

効果が出るのは「巨大なイメージの一部しか使わない」ケースで、逆に全ファイルを読むワークロードでは遅くなることがある。

### 「既存のエラーを合図に転用する」判断

このパターンが成立する条件は限られる。

- **エラーの意味と、合図の意味が矛盾しない** — 「既にある」は事実として正しい
- **対応しない実装が壊れない** — 普通にエラーとして扱えば従来の動作になる
- **確認手段がある** — containerd は `Stat` で裏を取る

3 番目が特に重要で、確認なしに信じる設計だと、実装のバグが静かなデータ破損になる。転用するなら、**合図を受けた側が事実を確認できる経路** を必ず用意する。
