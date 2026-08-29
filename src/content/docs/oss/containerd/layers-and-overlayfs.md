---
title: "レイヤと overlayfs: 差分を重ねて 1 つの rootfs にする"
description: "イメージのレイヤは差分の tar で、削除は「.wh.<名前>」という実在しないファイルで表現される。それを overlayfs に載せるとき、containerd は tar を素直に展開しつつ whiteout をファイル削除に読み替える。overlay snapshotter が返すマウントは、親の数によって bind と overlay を使い分ける。"
group: "コンテナランタイムの前提"
sidebar:
  order: 5
---

## 何を学んだか

### レイヤは「差分の tar」であって「スナップショット」ではない

イメージの layer blob は、前の層からの **変更点だけ** を含む tar だ。追加も変更も普通のファイルエントリだが、問題は削除で、tar には「このファイルを消せ」というエントリがない。

OCI Image Spec は、AUFS の慣習を借りてこれを表現する。

| tar 内のエントリ   | 意味                                                             |
| ------------------ | ---------------------------------------------------------------- |
| `dir/.wh.foo`      | 下位層の `dir/foo` を削除する (whiteout)                         |
| `dir/.wh..wh..opq` | `dir` を不透明にする。下位層の `dir` の中身をすべて隠す (opaque) |

つまり **レイヤの tar は、そのまま展開しても正しい rootfs にならない**。`.wh.` で始まるエントリを見たら、ファイルを作るのではなく削除する、という読み替えが要る。

### overlayfs は「積む」ことを mount option で表す

overlayfs のマウントは、ディレクトリの列を指定するだけだ。

```
mount -t overlay overlay \
  -o lowerdir=/snap/3/fs:/snap/2/fs:/snap/1/fs,upperdir=/snap/4/fs,workdir=/snap/4/work \
  /target
```

- `lowerdir` — 読み取り専用の層。**左が上位** (先に見つかったものが勝つ)
- `upperdir` — 書き込み先。コンテナ内での変更はここに溜まる
- `workdir` — カーネルが原子的な操作のために使う作業領域。upperdir と同じファイルシステムでなければならない

コンテナを起動するとき、イメージのレイヤ群が `lowerdir` に、コンテナの書き込み層が `upperdir` になる。コンテナを消せば upperdir を消すだけで、イメージ側は無傷だ。

### overlayfs の whiteout は tar の whiteout と別物

紛らわしいが、この 2 つは表現が違う。

- **tar (イメージ配布形式)** — `.wh.foo` という名前のファイル
- **overlayfs (カーネル)** — `foo` という名前の **キャラクタデバイス (major 0, minor 0)**

containerd の既定の展開処理は、tar の whiteout を **実際のファイル削除** に読み替える。上位層をまっさらなディレクトリに展開していくので、下位層に対する削除は「上位層に overlayfs の whiteout デバイスを作る」形にする必要がある — が、レイヤを 1 枚ずつ独立したディレクトリに展開する overlay snapshotter では、そのままでは表現できない。ここが実装の分かれ目になる。

## ソースコードのどこか

### whiteout の定義

[`pkg/archive/tar.go#L119-L133`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/archive/tar.go#L119-L133)。

```go title="pkg/archive/tar.go"
	// whiteoutPrefix prefix means file is a whiteout. If this is followed by a
	// filename this means that file has been removed from the base layer.
	// See https://github.com/opencontainers/image-spec/blob/main/layer.md#whiteouts
	whiteoutPrefix = ".wh."

	// whiteoutMetaPrefix prefix means whiteout has a special meaning and is not
	// for removing an actual file. Normally these files are excluded from exported
	// archives.
	whiteoutMetaPrefix = whiteoutPrefix + whiteoutPrefix

	// whiteoutOpaqueDir file means directory has been made opaque - meaning
	// readdir calls to this directory do not follow to lower layers.
	whiteoutOpaqueDir = whiteoutMetaPrefix + ".opq"
```

### 既定の変換はファイル削除

[`pkg/archive/tar.go#L163-L215`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/archive/tar.go#L163-L215) の `applyNaive`。

```go title="pkg/archive/tar.go"
	if convertWhiteout == nil {
		// handle whiteouts by removing the target files
		convertWhiteout = func(hdr *tar.Header, path string) (bool, error) {
			base := filepath.Base(path)
			dir := filepath.Dir(path)
			if base == whiteoutOpaqueDir {
				_, err := os.Lstat(dir)
				...
				err = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
					...
					if _, exists := unpackedPaths[path]; !exists {
						err := os.RemoveAll(path)
						return err
					}
					return nil
				})
				return false, err
			}

			if strings.HasPrefix(base, whiteoutPrefix) {
				originalBase := base[len(whiteoutPrefix):]
				originalPath := filepath.Join(dir, originalBase)

				return false, os.RemoveAll(originalPath)
			}

			return true, nil
		}
	}
```

opaque の処理に注目したい。`unpackedPaths` に **今回の tar で作られたパス** を記録しておき、opaque マーカーを見たら「今回作ったもの以外」を消す。

```go title="pkg/archive/tar.go"
		// Used for handling opaque directory markers which
		// may occur out of order
		unpackedPaths = make(map[string]struct{})
```

コメント通り、opaque マーカーが同じディレクトリの新規ファイルより **後に** 現れることがある。tar のエントリ順は保証されないので、「消す」と「作る」の順序に依存しない実装が要る。

`convertWhiteout` が差し替え可能なフックになっているのがポイントで、overlayfs 向けにキャラクタデバイスを作る実装を差し込むこともできる ([differ: レイヤ tar を snapshot に適用する](../apply-and-diff/))。

### 逆方向 — 差分から tar を作る

[`pkg/archive/tar.go#L100-L117`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/archive/tar.go#L100-L117) の `writeDiffNaive`。

```go title="pkg/archive/tar.go"
// Produces a tar using OCI style file markers for deletions. Deleted
// files will be prepended with the prefix ".wh.". This style is
// based off AUFS whiteouts.
func writeDiffNaive(ctx context.Context, w io.Writer, a, b string, o WriteDiffOptions) error {
	var opts []ChangeWriterOpt
	if o.SourceDateEpoch != nil {
		opts = append(opts, WithModTimeUpperBound(*o.SourceDateEpoch))
		// Since containerd v2.0, the whiteout timestamps are set to zero (1970-01-01),
		// not to the source date epoch
	}
```

whiteout エントリのタイムスタンプを **0 (1970-01-01) 固定** にしている。再現可能ビルドのためで、削除マーカーの mtime に意味はないのに、そこが変わるだけで layer の digest が変わってしまうからだ。

### overlay snapshotter は親の数で分岐する

[`plugins/snapshots/overlay/overlay.go#L555-L616`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/snapshots/overlay/overlay.go#L555-L616)。

```go title="plugins/snapshots/overlay/overlay.go"
	if len(s.ParentIDs) == 0 {
		// if we only have one layer/no parents then just return a bind mount as overlay
		// will not work
		roFlag := "rw"
		if s.Kind == snapshots.KindView {
			roFlag = "ro"
		}
		return []mount.Mount{
			{
				Source: o.upperPath(s.ID),
				Type:   "bind",
				...
```

親がなければ overlay ではなく **bind マウント**。overlayfs は lowerdir が最低 1 つ必要なので、1 層しかないときは使えない。

```go title="plugins/snapshots/overlay/overlay.go"
	if s.Kind == snapshots.KindActive {
		options = append(options,
			fmt.Sprintf("workdir=%s", o.workPath(s.ID)),
			fmt.Sprintf("upperdir=%s", o.upperPath(s.ID)),
		)
	} else if len(s.ParentIDs) == 1 {
		return []mount.Mount{
			{
				Source: o.upperPath(s.ParentIDs[0]),
				Type:   "bind",
				Options: append(options,
					"ro",
					"rbind",
				),
			},
		}
	}

	parentPaths := make([]string, len(s.ParentIDs))
	for i := range s.ParentIDs {
		parentPaths[i] = o.upperPath(s.ParentIDs[i])
	}
	options = append(options, fmt.Sprintf("lowerdir=%s", strings.Join(parentPaths, ":")))
```

3 通りに分かれる。

1. **active (書き込み可能)** — `upperdir` と `workdir` を付ける。親は全部 `lowerdir`
2. **committed で親が 1 つ** — 読むだけなら overlay を張る必要がない。read-only の bind で済ませる
3. **それ以外** — `lowerdir` を `:` で連結した overlay

`ParentIDs` は「近い親が先」の順で並んでいて、これが overlayfs の `lowerdir` の順序 (左が上位) とそのまま一致する。

### upperdir の場所をラベルで公開できる

[`plugins/snapshots/overlay/overlay.go#L38-L41`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/snapshots/overlay/overlay.go#L38-L41)。

```go title="plugins/snapshots/overlay/overlay.go"
// upperdirKey is a key of an optional label to each snapshot.
// This optional label of a snapshot contains the location of "upperdir" where
// the change set between this snapshot and its parent is stored.
const upperdirKey = "containerd.io/snapshot/overlay.upperdir"
```

オプトインの設定を有効にすると、snapshot のラベルに upperdir のパスが載る。「コンテナが書き込んだ内容だけを取り出したい」という用途 (`docker diff` に相当) のために、内部のディレクトリ構造を **ラベルという既存の仕組みで** 外に出している。API を増やしていない。

## なぜそうなっているか

### 削除を「実在しないファイル」で表す理由

tar は追記可能なストリーム形式で、メタ操作を表す語彙を持たない。仕様を拡張して新しいヘッダタイプを足すこともできたが、それだと既存の tar 実装が扱えなくなる。**普通のファイルとして表現しておけば、どの tar ツールでも運べる**。

代償は、`.wh.` で始まる実ファイルを作れないこと。実質的に問題にならない予約として受け入れられている。

### レイヤを 1 枚ずつ別ディレクトリに展開する

overlay snapshotter は、layer n を展開するときに「layer 0..n-1 を lowerdir にした overlay を張り、その upper に展開する」という方式を採る。こうすると各ディレクトリには **その層の差分だけ** が残り、下位層と物理的に共有される。

もし全層を 1 つのディレクトリに順に展開したら、共有ができない。100 個のイメージが同じ base を使っていたら base の内容が 100 回コピーされる。差分を差分のまま保持することが、ディスク使用量とページキャッシュの共有に直結する。

### mount option の長さ制限という現実的な制約

`lowerdir=` はパスを `:` で連結するので、層が深いイメージでは option 文字列が長くなる。カーネルの mount data はページサイズ (通常 4096 バイト) に制限されるため、**層が多すぎるとマウントできない**。

これが「イメージの層は少ないほうがよい」と言われる技術的な理由の 1 つで、containerd 側にも相対パスを使うなどの緩和策が入っている。overlayfs 以外の snapshotter (erofs、devmapper、blockfile) が存在する理由の一部でもある。

## どう活かすか

### 「消したはずのファイルがイメージに残っている」の説明

Dockerfile で

```dockerfile
COPY secret.key /app/
RUN rm /app/secret.key
```

と書いても、secret.key は layer に残る。`rm` が作るのは次の層の `.wh.secret.key` だけで、**前の層の blob には元のファイルがそのまま入っている** からだ。レジストリから layer を 1 枚ずつ取れば読める。

overlayfs の見え方 (ファイルは消えている) と、配布形式の中身 (ファイルは存在する) が別物であることを理解しているかどうかで、この種の事故を防げるかが決まる。

### 差分表現を設計するときの教訓

「削除」をどう表すかは、差分形式を設計するときに必ず出てくる問題だ。containerd (というより OCI) の答えは次の 3 点にまとめられる。

- **既存フォーマットの語彙の中で表現する** — 独自拡張より互換性を優先する
- **適用時に読み替えるフックを開けておく** — `convertWhiteout` のように、宛先の実体 (overlayfs、単純なディレクトリ、リモート FS) ごとに解釈を変えられる
- **順序に依存しない適用にする** — opaque マーカーが前後しても結果が同じになるよう、「今回作ったもの」を覚えておく

3 番目は特に見落としやすい。適用処理を書くときは、入力の順序保証がどこまであるかを最初に確認したほうがよい。
