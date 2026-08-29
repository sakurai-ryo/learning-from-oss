---
title: "differ: レイヤ tar を snapshot に適用する"
description: "layer の展開は「マウントして tar を撒く」だけに見えるが、overlayfs 相手のときだけは upperdir に直接展開し、whiteout をキャラクタデバイスとして書く。逆方向 (2 つの snapshot から layer tar を作る) も同じパッケージにあり、stream processor を挟めば暗号化レイヤも扱える。"
group: "イメージを取り込む"
sidebar:
  order: 31
---

## 何を学んだか

### diff プラグインは 2 方向を持つ

```go
Apply(ctx, desc, mounts, opts...)      // layer tar → マウント先に展開
Compare(ctx, lower, upper, opts...)    // 2 つのマウントの差分 → layer tar
```

`Apply` が pull の展開、`Compare` がビルドやコミットで使われる。両方が `mount.Mount` の列を受け取るところが要で、**snapshotter の実装を知らずに動く** ([Mount 型: マウントを実行せず、値として運ぶ](../mount-as-value/))。

### 展開は「マウントして撒く」が基本、ただし overlayfs は特別扱い

一般的な経路は素朴だ。

```go
return mount.WithTempMount(ctx, mounts, func(root string) error {
	_, err := archive.Apply(ctx, root, r)
	return err
})
```

一時的にマウントして、tar を展開して、アンマウントする。

しかし overlayfs のときは、**マウントせずに upperdir へ直接展開する**。しかも whiteout の変換方法を変える。理由は、overlayfs の whiteout は「キャラクタデバイス (0,0)」であって、tar の `.wh.` ファイルでも実際のファイル削除でもないからだ ([レイヤと overlayfs](../layers-and-overlayfs/))。

### 圧縮の解除は処理チェーンで

layer は gzip や zstd で圧縮されていて、暗号化されていることもある。containerd は `StreamProcessor` の連鎖でこれを剥がす。

「mediaType が `application/vnd.oci.image.layer.v1.tar` になるまで processor を重ねる」というループになっていて、**未知の mediaType には外部バイナリを差し込める**。

### 展開しながら diffID を計算する

`io.TeeReader` で展開ストリームを分岐させ、片方をハッシュに流す。展開が終わった時点で diffID が確定し、期待値と比較できる。読み直しは発生しない。

## ソースコードのどこか

### 処理チェーンで mediaType を剥がす

[`core/diff/apply/apply.go#L93-L106`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/diff/apply/apply.go#L93-L106)。

```go title="core/diff/apply/apply.go"
	var processors []diff.StreamProcessor
	processor := diff.NewProcessorChain(desc.MediaType, r)
	processors = append(processors, processor)
	for {
		if processor, err = diff.GetProcessor(ctx, processor, config.ProcessorPayloads); err != nil {
			return emptyDesc, fmt.Errorf("failed to get stream processor for %s: %w", desc.MediaType, err)
		}
		processors = append(processors, processor)
		if processor.MediaType() == ocispec.MediaTypeImageLayer {
			break
		}
	}
```

**終了条件が「素の tar になったら」** という形になっている。`.tar.gz+encrypted` なら復号 → 解凍の 2 段、`.tar.zstd` なら 1 段。段数を事前に決めていない。

外部バイナリを processor として登録できる仕組み ([`docs/stream_processors.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/stream_processors.md)) があり、暗号化レイヤ (imgcrypt) はこれで実装されている。**containerd 本体に暗号の知識を入れずに、暗号化イメージを扱える**。

### diffID の計算

```go title="core/diff/apply/apply.go"
	digester := digest.Canonical.Digester()
	rc := &readCounter{
		r: io.TeeReader(processor, digester.Hash()),
	}
	...
	if err := apply(ctx, mounts, rc, config.SyncFs); err != nil {
		return emptyDesc, err
	}

	// Read any trailing data
	if _, err := io.Copy(io.Discard, rc); err != nil {
		return emptyDesc, err
	}
```

展開後に「残りのデータを読み捨てる」処理が入っている。tar の末尾にはパディング (0 埋めのブロック) があり、展開処理はそこを読まずに終わることがある。**読み残しがあると diffID が変わる** ので、必ず最後まで読む。

戻り値は「展開後の tar」としての descriptor になる。

```go title="core/diff/apply/apply.go"
	return ocispec.Descriptor{
		MediaType: ocispec.MediaTypeImageLayer,
		Size:      rc.c,
		Digest:    digester.Digest(),
	}, nil
```

呼び出し側 (unpacker) はこれを config の `diff_ids` と突き合わせる。

### overlayfs への直接展開

[`core/diff/apply/apply_linux.go#L34-L73`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/diff/apply/apply_linux.go#L34-L73)。

```go title="core/diff/apply/apply_linux.go"
func apply(ctx context.Context, mounts []mount.Mount, r io.Reader, sync bool) (retErr error) {
	switch {
	case len(mounts) == 1 && mounts[0].Type == "overlay":
		// OverlayConvertWhiteout (mknod c 0 0) doesn't work in userns.
		// https://github.com/containerd/containerd/issues/3762
		if userns.RunningInUserNS() {
			break
		}
		path, parents, err := getOverlayPath(mounts[0].Options)
		if err != nil {
			if errdefs.IsInvalidArgument(err) {
				break
			}
			return err
		}
		opts := []archive.ApplyOpt{
			archive.WithConvertWhiteout(archive.OverlayConvertWhiteout),
		}
		if len(parents) > 0 {
			opts = append(opts, archive.WithParents(parents))
		}
		_, err = archive.Apply(ctx, path, r, opts...)
```

3 つのことをしている。

1. **overlay マウントの option 文字列から upperdir と lowerdir を取り出す** — マウントを実行せずにパスを得る
2. **whiteout の変換をキャラクタデバイス生成に差し替える** — `.wh.foo` を見たら `mknod c 0 0` する
3. **親のパスを渡す** — opaque ディレクトリの判定に下位層の情報が要る

`mount(2)` を呼ばないので速く、mount namespace も汚さない。

user namespace の中では `mknod` が使えないので、この最適化を諦めて通常経路に落ちる。issue 番号付きで理由が書かれている。

`sync` の扱いも興味深い。

```go title="core/diff/apply/apply_linux.go"
	case sync && len(mounts) == 1 && mounts[0].Type == "bind":
		defer func() {
			if retErr != nil {
				return
			}

			retErr = doSyncFs(mounts[0].Source)
		}()
	}
```

展開後に `syncfs(2)` を呼ぶかどうかを選べる。呼べば電源断でも layer が失われないが、遅くなる。既定は呼ばない。

### mount manager が必要な場合

```go title="core/diff/apply/apply.go"
	// The number of `mounts` that need to be parsed by the mount manager
	// will be more than 1 in reality; this is needed to work around some
	// overlayfs/bind shortcuts in core/diff/apply/apply_linux.go
	if s.mount != nil && len(mounts) > 1 {
		...
		info, err := s.mount.Activate(ctx, id, mounts)
		if err == nil {
			defer s.mount.Deactivate(ctx, id)
			mounts = info.System
		}
```

マウントが 1 つなら上の近道が使えるので、mount manager を経由しない。複数ある場合 (合成マウントや特殊な型) だけ mount manager に解決させる ([mount manager](../mount-manager/))。

### 逆方向 — Compare

[`plugins/diff/walking/differ.go#L62-L110`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/diff/walking/differ.go#L62-L110)。

```go title="plugins/diff/walking/differ.go"
	compressionType := compression.Uncompressed
	if config.Compressor != nil {
		if config.MediaType == "" {
			return emptyDesc, errors.New("media type must be explicitly specified when using custom compressor")
		}
		compressionType = compression.Unknown
	} else {
		if config.MediaType == "" {
			config.MediaType = ocispec.MediaTypeImageLayerGzip
		}

		switch config.MediaType {
		case ocispec.MediaTypeImageLayer:
		case ocispec.MediaTypeImageLayerGzip:
			compressionType = compression.Gzip
		case ocispec.MediaTypeImageLayerZstd:
			compressionType = compression.Zstd
```

差分を取るときは、両方をマウントして木を歩き比べる (walking differ の名前の由来)。

```go title="plugins/diff/walking/differ.go"
	if err := mount.WithTempMount(ctx, lower, func(lowerRoot string) error {
		return mount.WithReadonlyTempMount(ctx, upper, func(upperRoot string) error {
```

upper 側は **read-only でマウントする**。差分を取るだけなので書き込む理由がなく、事故を防ぐ。

再現可能ビルドのための `SourceDateEpoch` もここで効く。指定すると、ファイルの mtime が指定時刻以下に丸められる ([レイヤと overlayfs](../layers-and-overlayfs/) で見た whiteout のタイムスタンプ 0 固定と対になる)。

## なぜそうなっているか

### マウントを避けられるなら避ける

`mount(2)` は特権が要り、mount namespace に痕跡を残し、失敗すると後始末が必要になる。overlayfs の展開は「upperdir に書けばよい」だけなので、マウントせずに済ませられる。

数百のイメージを展開するノードでは、この差が積み上がる。一時マウントが残ったまま漏れる事故も防げる。

代償は、overlayfs の内部構造 (option 文字列の形式、whiteout の表現) に依存すること。汎用の経路と特殊経路の 2 本立てになり、条件分岐が増える。

### whiteout の変換を差し替え可能にする

`archive.Apply` が `ConvertWhiteout` フックを持っているおかげで、この 2 本立てが成立している ([レイヤと overlayfs](../layers-and-overlayfs/))。

- 既定 (通常のディレクトリ) — 対象ファイルを削除する
- overlayfs — キャラクタデバイスを作る

もし tar の展開処理が whiteout の扱いを固定していたら、overlayfs 向けの最適化は別の展開実装を書く羽目になっていた。

### stream processor を外部プロセスにできる

暗号化レイヤ、署名付きレイヤ、独自形式。これらを containerd 本体に取り込むと、暗号ライブラリへの依存や鍵管理の責務が増える。

外部バイナリに委ねる設計なら、**containerd は「素の tar になるまで剥がす」というルールだけを持つ**。imgcrypt のようなプロジェクトが独立して開発できる。

## どう活かすか

### 展開が遅いときの観点

```sh
# Apply のログ (デバッグレベルで所要時間が出る)
$ journalctl -u containerd | grep "diff applied"
```

`d=` の値が展開の所要時間。ここが大きい場合、

- **ディスク I/O が遅い** — 大量の小さいファイルを含む layer は特に遅い
- **user namespace の中で動いている** — overlayfs の近道が使えず、一時マウント経由になる
- **snapshotter が overlayfs でない** — native snapshotter はレイヤごとに全コピーするので極端に遅い

### 「変換を剥がすループ」というパターン

多段の変換 (圧縮、暗号化、エンコーディング) を扱うとき、この形が使える。

- **終了条件を「目的の型になったら」にする** — 段数を事前に決めない
- **各段を同じインターフェース (Reader を受けて Reader を返す) にする**
- **未知の型は外部に委譲できるようにする** — 本体の依存を増やさない

段数を固定した実装は、新しい形式が増えるたびに壊れる。「剥がし終わったか」だけを見るループにしておくと、拡張が設定の追加で済む。
