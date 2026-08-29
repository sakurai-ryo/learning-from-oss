---
title: "Snapshotter インターフェースの 4 つの動詞"
description: "Prepare でアクティブなスナップショットを作り、マウントして書き換え、Commit で固める。View は読み取り専用、Mounts は再取得。この 4 つだけで、レイヤの展開もコンテナの rootfs もイメージのビルドも表現できる。インターフェースの doc コメントが実質的な仕様書になっている。"
group: "ファイルシステムを積む"
sidebar:
  order: 33
---

## 何を学んだか

### 動詞は少ない

```go
Prepare(ctx, key, parent, opts...) ([]mount.Mount, error)   // 書き込み可能な作業領域を作る
View(ctx, key, parent, opts...)    ([]mount.Mount, error)   // 読み取り専用で見る
Commit(ctx, name, key, opts...)    error                    // 作業結果を固める
Mounts(ctx, key)                   ([]mount.Mount, error)   // マウント情報を再取得する
```

これに `Stat` / `Update` / `Usage` / `Remove` / `Walk` / `Close` を足した 10 メソッドが `Snapshotter` インターフェースの全部だ。

重要なのは、**どのメソッドもファイルシステムを操作しない** こと。`Prepare` が返すのは「こうマウントすれば使える」という情報 (`[]mount.Mount`) であって、マウント済みのパスではない ([Mount 型: マウントを実行せず、値として運ぶ](../mount-as-value/))。

### 用語が定義されている

doc コメントに用語集がある。

```
`key`    - refers to an active snapshot
`name`   - refers to a committed snapshot
`parent` - refers to the parent in relation
```

`Commit(ctx, name, key)` は「key で識別される active を、name という committed にする」と読める。引数名がそのまま状態を表している。

そして「active と committed は同じキー空間を共有する」ので、同じ名前は同時に存在できない。

### 3 つの使い方が doc に書かれている

インターフェースのコメントに、具体的な使用例が 3 つ並んでいる。

1. **レイヤの展開** — 空の親から `Prepare` し、tar を撒き、diffID で `Commit`
2. **次のレイヤ** — 前の layer を親にして同じことを繰り返す
3. **コンテナの実行** — イメージの最上位 chainID を親に `Prepare` し、返ってきたマウントをランタイムに渡す。終わったら `Remove`

**同じ 4 つの動詞で、展開も実行もビルドも表現できる** ことが例で示されている。

### ラベルで下位に情報を渡す

`containerd.io/snapshot/` で始まるラベルは、metadata 層から snapshotter の実装まで **継承される**。remote snapshotter はここに載ったイメージ参照や diffID を見て、レイヤをダウンロードせずに rootfs を用意する。

## ソースコードのどこか

### インターフェースの doc が仕様書になっている

[`core/snapshots/snapshotter.go#L165-L280`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/snapshots/snapshotter.go#L165-L280)。

```go title="core/snapshots/snapshotter.go"
// Snapshotter defines the methods required to implement a snapshot snapshotter for
// allocating, snapshotting and mounting filesystem changesets. The model works
// by building up sets of changes with parent-child relationships.
//
// A snapshot represents a filesystem state. Every snapshot has a parent, where
// the empty parent is represented by the empty string. A diff can be taken
// between a parent and its snapshot to generate a classic layer.
//
// An active snapshot is created by calling `Prepare`. After mounting, changes
// can be made to the snapshot. The act of committing creates a committed
// snapshot. The committed snapshot will get the parent of active snapshot. The
// committed snapshot can then be used as a parent. Active snapshots can never
// act as a parent.
```

「active は決して親になれない」が明記されている。書き込み中のものを土台にはできない、という不変条件だ。

用語の定義も続く。

```go title="core/snapshots/snapshotter.go"
//	`ctx` - refers to a context.Context
//	`key` - refers to an active snapshot
//	`name` - refers to a committed snapshot
//	`parent` - refers to the parent in relation
//
// Most methods take various combinations of these identifiers. Typically,
// `name` and `parent` will be used in cases where a method *only* takes
// committed snapshots. `key` will be used to refer to active snapshots in most
// cases, except where noted. All variables used to access snapshots use the
// same key space. For example, an active snapshot may not share the same key
// with a committed snapshot.
```

**引数名の意味を規約として決めておく** のは、10 種類以上の実装が並存するインターフェースでは効果が大きい。実装者が読むべきものが 1 か所にまとまる。

使用例も同じコメントの中にある。

```go title="core/snapshots/snapshotter.go"
// # Running a Container
//
// To run a container, we simply provide snapshotter.Prepare() the committed image
// snapshot as the parent. After mounting, the prepared path can
// be used directly as the container's filesystem:
//
//	mounts, err := snapshotter.Prepare(ctx, containerKey, imageRootFSChainID)
//
// The returned mounts can then be passed directly to the container runtime.
```

「返ってきたマウントをそのままランタイムに渡せる」。containerd 自身はマウントしない、という設計がここで宣言されている。

### 各メソッドの契約

```go title="core/snapshots/snapshotter.go"
	// Usage returns the resource usage of an active or committed snapshot
	// excluding the usage of parent snapshots.
	//
	// The running time of this call for active snapshots is dependent on
	// implementation, but may be proportional to the size of the resource.
	// Callers should take this into consideration. Implementations should
	// attempt to honor context cancellation and avoid taking locks when making
	// the calculation.
	Usage(ctx context.Context, key string) (Usage, error)
```

「実装によってはサイズに比例して遅い。呼ぶ側は考慮せよ。実装側はキャンセルを尊重し、計算中にロックを取るな」。**性能特性が契約の一部** として書かれている。

`ctr snapshots usage` が遅いことがあるのはこのためだ。

```go title="core/snapshots/snapshotter.go"
	// Mounts returns the mounts for the active snapshot transaction identified
	// by key. Can be called on a read-write or readonly transaction. This is
	// available only for active snapshots.
	//
	// This can be used to recover mounts after calling View or Prepare.
	Mounts(ctx context.Context, key string) ([]mount.Mount, error)
```

`Mounts` の存在理由は「復旧」だ。`Prepare` の戻り値を失っても、key さえあれば取り直せる。containerd が再起動した後にコンテナの rootfs を再マウントできるのはこれによる。

### ラベルの継承

[`core/snapshots/snapshotter.go#L30-L66`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/snapshots/snapshotter.go#L30-L66)。

```go title="core/snapshots/snapshotter.go"
	inheritedLabelsPrefix = "containerd.io/snapshot/"

	// LabelSnapshotRef is set by the unpacker on the extraction Prepare to
	// the target chainID. A snapshotter that already has the layer commits a
	// snapshot named after this value and returns ErrAlreadyExists, which
	// makes the unpacker skip fetching and applying the layer (the remote
	// snapshot protocol). It is inherited by FilterInheritedLabels.
	LabelSnapshotRef = "containerd.io/snapshot.ref"
```

`LabelSnapshotRef` の説明が、remote snapshotter の仕組みそのものだ。**snapshotter が「もう持っている」と言えば、containerd はダウンロードをやめる** ([remote snapshotter](../remote-snapshotter/))。

`ErrAlreadyExists` を「失敗」ではなく「最適化の合図」として使う、独特のプロトコルになっている。

サイズ制限のラベルの説明も明快だ。

```go title="core/snapshots/snapshotter.go"
	// LabelSnapshotMaxSize is a hint to the snapshotter that the active
	// snapshot's filesystem should be limited to the given size, in bytes
	// (decimal int64 as a string). Snapshotters that back an active
	// snapshot with a block image or support filesystem quotas should
	// honor this value; those that cannot enforce a size may ignore it.
	// Ignoring is not a failure — callers that require enforcement must
	// pick a snapshotter that supports it.
	LabelSnapshotMaxSize = "containerd.io/snapshot/max-size"
```

「守れない実装は無視してよい。無視は失敗ではない。強制が必要なら対応する snapshotter を選べ」。**ヒントであって命令ではない** ことが明記されている。これがないと、対応しない snapshotter がエラーを返すべきか黙って無視すべきかで実装が割れる。

### 能力の申告

```go title="core/snapshots/snapshotter.go"
	// RebaseCap is a snapshotter capability (advertised via the plugin's metadata)
	// indicating that an active snapshot may be committed with a parent supplied at
	// Commit time (via WithParent). It lets the unpacker prepare and apply layers in
	// parallel and rebase the chain into place at commit.
	RebaseCap = "rebase"
```

snapshotter は [プラグインの Meta.Capabilities](../plugin-architecture/) で能力を申告する。`rebase` に対応していれば、unpacker は並列展開の経路を選ぶ ([ダウンロードと展開を、パイプラインでつなぐ](../unpack-pipeline/))。

**インターフェースを増やさずに、実装ごとの差を扱う** ための仕組みだ。

## なぜそうなっているか

### 「変更セットの親子関係」だけをモデルにする

snapshotter が扱う概念は、突き詰めると「親を持つ変更セット」だけだ。overlayfs も btrfs も devmapper も、この抽象に収まる。

もし「レイヤ」「イメージ」「コンテナ」という語彙をインターフェースに持ち込んでいたら、

- ビルドツールが使いにくくなる (中間結果はレイヤでもイメージでもない)
- OCI 以外の用途に転用できない
- イメージ形式の変更が snapshotter に波及する

**下位ほど語彙を減らす** という設計になっている。

### マウントを返す設計

`Prepare` がマウント済みのパスを返す設計なら、呼び出し側は楽だ。しかし、

- containerd がマウントを持つと、その解放責任が生まれる
- 別の mount namespace で使いたい場合 (VM ベースのランタイム) に困る
- マウントせずに済むケース (overlayfs の upperdir に直接展開) で無駄になる

マウント情報を値として返せば、**誰がいつどこでマウントするかを呼び出し側が決められる**。

### doc コメントを仕様書にする

このインターフェースは 10 種類以上の実装を持ち、その多くが containerd の外にある (stargz、nydus、SOCI、OverlayBD)。実装者が参照する規範がインターフェースの doc しかない、という状況になる。

だから containerd は doc コメントに、

- モデルの説明 (親子関係、active/committed)
- 用語の定義 (key / name / parent)
- 使用例 3 つ
- 各メソッドの性能特性と契約

を全部書いている。100 行を超える doc コメントは冗長に見えるが、**外部実装の質を保つ最も安価な手段** になっている。

## どう活かすか

### snapshot の状態を見る

```sh
# snapshot の一覧 (Kind, Parent が出る)
$ ctr -n k8s.io snapshots ls

# 特定 snapshot の情報とラベル
$ ctr -n k8s.io snapshots info <key>

# マウント情報を得る (実際にはマウントしない)
$ ctr -n k8s.io snapshots mounts /tmp/target <key>
```

3 つ目が特に有用で、**マウントコマンドの内容を確認できる**。lowerdir の並びが期待通りかを見るときに使う。

### インターフェースを外部実装に開くときの作法

containerd の Snapshotter から学べる点。

- **語彙を最小にする** — 上位の概念 (イメージ、レイヤ) を持ち込まない
- **副作用を返り値にする** — 「やる」ではなく「やり方」を返せる場面を探す
- **性能特性を契約に書く** — 「これは遅いかもしれない」を明示する
- **ヒントと命令を区別する** — 無視してよいものは「無視は失敗ではない」と書く
- **能力申告の仕組みを別に用意する** — インターフェースを増やさずに実装差を扱う

4 番目と 5 番目は、実装が増えてから効いてくる。最初の実装しかないうちは「全部必須」で書けてしまうが、2 つ目の実装が来たときに破綻する。
