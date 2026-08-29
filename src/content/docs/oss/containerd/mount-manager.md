---
title: "mount manager: マウント型を拡張し、漏れを追跡する"
description: "containerd 2.2 で入った mount manager は、カーネルが知らないマウント型 (loop、mkfs、format) を扱えるようにし、実行したマウントを名前付きで記録して GC の対象にする。しかも shim が「この型は自分でやれる」と申告すれば、containerd はその分を肩代わりしない。"
group: "ファイルシステムを積む"
sidebar:
  order: 38
---

## 何を学んだか

### 解こうとしている 2 つの問題

[Mount 型](../mount-as-value/) は「mount(2) の引数」なので、カーネルが知らない操作は表現できない。しかし実際には、マウントの前に

- ディスクイメージファイルを作って mkfs する
- loop デバイスを割り当てる
- upperdir と workdir を作る
- 前のマウントの結果 (実際のマウントポイント) を次のマウントの引数に埋める

といった前処理が必要になることがある。VM ベースのランタイムやブロックデバイス系の snapshotter で顕著だ。

もう 1 つの問題は **マウントの漏れ** だ。誰がどのマウントを持っているかを containerd が把握していないと、ホストの mount namespace にマウントが残り続ける。

mount manager はこの 2 つを同時に扱う。

### 型に修飾子を付けて拡張する

```go
mount.Mount{
	Type:   "format/mkdir/overlay",
	Source: "overlay",
	Options: []string{
		"X-containerd.mkdir.path={{ mount 0 }}/upper:0755",
		"lowerdir={{ mount 1 }}",
		"upperdir={{ mount 0 }}/upper",
	},
}
```

`Type` が `<変換>/<変換>/<マウント型>` の形になる。変換は **外から内へ** 適用され、最後に残った型 (`overlay`) でマウントする。

- `format/` — Go テンプレートで、前のマウントの結果を埋め込む
- `mkdir/` — マウント前にディレクトリを作る
- `mkfs/` — ファイルシステムイメージを作って mkfs する
- `loop` — ファイルを loop デバイスとしてマウントする (変換ではなくマウント型)

### 名前を付けて活性化する

```go
Activate(ctx, name, mounts, opts...) (ActivationInfo, error)
Deactivate(ctx, name) error
```

マウントの集合に名前を付けて活性化する。結果の `ActivationInfo` には、

- `Active` — mount manager が実際にマウントしたもの
- `System` — **呼び出し側がマウントすべき残り**

が入る。全部を manager がやるのではなく、途中まで解決して残りを返す形になっている。

### shim が「自分でやる」と言える

VM ベースのランタイムは、loop デバイスをホストに作るより **ディスクイメージのファイルをそのまま VM に渡す** ほうが効率がよい。

shim は起動時の bootstrap 応答に `MountCapabilities` を付けて、自分が扱える型と変換を申告できる。containerd はそれを `WithAllowMountType` / `WithAllowTransform` に変換し、その分の処理をスキップする。

## ソースコードのどこか

### 変換の連鎖と、申告の効き方

[`docs/mounts.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/mounts.md) の "Relationship with runtimes"。

```markdown title="docs/mounts.md"
A claimed mount or transform is still performed by the mount manager if a
subsequent mount depends on it, since the runtime cannot supply a mount point
that does not exist yet. Similarly, a claimed transform is only honored as a
suffix of the transform chain it appears in: transforms apply outside-in, so
an inner one's input is an outer one's output, and the manager still applies
an outer, unclaimed transform even when an inner one is claimed. Claiming
`format` alone in `format/mkdir/overlay` does nothing, since `mkdir` cannot
run without `format` having already run; claiming `mkdir` gets the manager to
apply `format` and hand back `mkdir/overlay`.
```

申告が効く条件が厳密に書かれている。

- **後続のマウントが依存していれば、申告があっても manager が実行する** — まだ存在しないマウントポイントをランタイムは提供できない
- **変換の連鎖では、内側だけを申告しても効かない** — 外側が先に走る必要がある

`format/mkdir/overlay` で `format` だけ申告しても無意味、`mkdir` を申告すれば manager が `format` を適用して `mkdir/overlay` を返す。**変換の適用順序と、責任分界点の関係** が言語化されている。

### テンプレートで前の結果を参照する

```markdown title="docs/mounts.md"
| Value     | Args          | Example             | Description                                                                           |
| --------- | ------------- | ------------------- | ------------------------------------------------------------------------------------- |
| `source`  | <index>       | `{{ source 0 }}`    | Source from active mount at <index>                                                   |
| `target`  | <index>       | `{{ target 0 }}`    | Target from the active mount at <index>                                               |
| `mount`   | <index>       | `{{ mount 0 }}`     | Mount point from the active mount at <index>                                          |
| `overlay` | <start> <end> | `{{ overlay 0 2 }}` | Fill in overlayfs lowerdir arguments for active mount points at <start> through <end> |
```

loop デバイスの名前も、一時マウントポイントのパスも、**マウントするまで分からない**。静的な `Mount` の値では表現できないので、テンプレートにして活性化時に埋める。

`{{ overlay 0 2 }}` のように、overlayfs の lowerdir を範囲指定で組み立てるヘルパもある。

### ActiveMount は結果を持ち回る

[`core/mount/manager.go#L133-L158`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/mount/manager.go#L133-L158)。

```go title="core/mount/manager.go"
type ActiveMount struct {
	Mount
	MountedAt *time.Time

	// MountPoint is the filesystem mount location
	MountPoint string

	// MountData is metadata used by the mount type which can also be used by
	// subsequent mounts.
	MountData map[string]string
}
```

`MountData` が「次のマウントが使えるメタデータ」で、loop デバイス名などが入る。テンプレートはここを参照する。

```go title="core/mount/manager.go"
// ActivationInfo represents the state of an active set of mounts being managed by a
// mount manager. The Name is unique and can be used to reference the activation
// from other resources.
type ActivationInfo struct {
	Name string

	// Active are the mounts which was successfully mounted on activate
	Active []ActiveMount

	// System is the list of system mounts to access the filesystem root
	// This will always be non-empty and a bind mount will be created
	// and filled in here when all mounts are performed
	System []Mount
	Labels map[string]string
}
```

`System` は「必ず非空」で、全部マウント済みなら **bind マウントが 1 つ入る**。呼び出し側は常に「`System` をマウントすれば rootfs が得られる」と扱えて、場合分けが要らない。

### ハンドラとトランスフォーマのインターフェース

```markdown title="docs/mounts.md"
type Handler interface {
Mount(context.Context, Mount, string, []ActiveMount) (ActiveMount, error)
Unmount(context.Context, string) error
}

type Transformer interface {
Transform(context.Context, Mount, []ActiveMount) (Mount, error)
}
```

どちらも **これまでの ActiveMount の列を受け取る**。前の結果を見て、自分の動作を決められる。

`Transformer` は `Mount` を返すだけで、副作用としてディレクトリを作ったりイメージを mkfs したりする。「マウントを書き換える」という形で前処理を表現している。

### GC との統合

```markdown title="docs/mounts.md"
| Label                                                                         | Description                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------- |
| `containerd.io/gc.bref.container.*`                                           | Back reference to a container                  |
| `containerd.io/gc.bref.content.*`                                             | Back reference to content in the content store |
| ...                                                                           |
| These labels ensure that the mount won't be garbage collected while the       |
| referenced resources still exist, and the mount will be automatically cleaned |
| up when the references are removed.                                           |
```

活性化したマウントに **後方参照ラベル** を付けられる ([資源の関係グラフを、クライアントがラベルで書く](../gc-labels/))。

「このマウントはコンテナ X のためのもの」と宣言しておけば、コンテナが消えたときにマウントも自動的に解除される。**マウントを GC の対象資源にする** ことで、漏れを構造的に防いでいる。

streaming service が自分を GC 対象として登録していたのと同じ形だ ([gRPC の上に、自前のストリームとコールバックを作る](../streaming-service/))。

### shim が先に起動する理由

```markdown title="docs/mounts.md"
The shim is started before its mounts are activated, so that what it advertises can
be taken into account.
```

shim の起動 → 能力の申告 → マウントの活性化、という順序になる。申告を待たずにマウントすると、shim が「自分でやれる」と言っても手遅れだからだ。

[起動パラメータを stdin の protobuf 1 通に集約する](../shim-bootstrap/) で見た `BootstrapResult.extensions` が、この申告の運び手になる。

## なぜそうなっているか

### 型の語彙を増やさずに拡張する

新しい前処理が必要になるたびに `Mount` 構造体にフィールドを足すと、

- protobuf のメッセージが肥大化する
- 対応しない実装が無視すべきフィールドを持つ
- 組み合わせが表現できない (mkfs してから mkdir する、など)

**型名に修飾子を重ねる** 方式なら、構造体は変わらない。`format/mkdir/overlay` は 1 つの文字列で「3 段の処理」を表す。

パス名のような構文を使うのは読みやすさの工夫で、`ReadOnly()` が最後のセグメントだけを見ていた ([Mount 型](../mount-as-value/)) のもこの規約に沿っている。

### マウントを追跡可能にする

mount manager 以前は、マウントを実行するのは各所のコードで、containerd は全体像を知らなかった。一時マウントの漏れ、shim が死んだ後の残骸、といった問題が個別に対処されていた。

名前を付けて登録し、GC の対象にすることで、

- `List` で現在のマウントを列挙できる
- 参照元が消えれば自動的に解除される
- 漏れたマウントを検出できる

**資源として一級に扱う** と、既存の資源管理の仕組み (リース、GC、ラベル) がそのまま使える。

### 能力の申告で最適化を許す

VM ベースのランタイムにとって、ホスト側で loop デバイスを作られるのは無駄どころか有害だ (VM に渡すのはファイルでよい)。かといって containerd が「VM のときは loop を作らない」と知っているべきでもない。

**shim が自分でできることを申告し、containerd がその分を譲る** という形にすれば、containerd はランタイムの事情を知らずに済む。プラグインの capability 申告 ([中核が空のデーモン](../plugin-architecture/)) と同じ発想が、shim との境界にも適用されている。

## どう活かすか

### マウントの漏れを確認する

mount manager が管理しているマウントは一覧できる。

```sh
# ホストのマウントを見て、containerd 由来のものを探す
$ mount | grep containerd

# snapshotter のディレクトリがマウントされたままかを確認
$ findmnt -T /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs
```

コンテナを消したのにマウントが残っている場合、mount manager 導入前の経路 (一時マウント) か、shim の異常終了が疑わしい。

### 「型に修飾子を重ねる」拡張

既存の型システムを壊さずに機能を足したいとき、この方式が使える。

- **識別子の文字列に構造を持たせる** — `<前処理>/<前処理>/<本体>`
- **適用順序を明確に決める** — containerd は「外から内へ」
- **最後のセグメントが本来の型** — 既存の判定コードは末尾だけ見れば動く
- **前処理は「値を書き換える」形にする** — 副作用を持つが、返すのは変換後の値

代償は、文字列のパースが増えることと、型の妥当性を静的に検査できないこと。containerd は前者を `ReadOnly()` のような小さなヘルパに閉じ込め、後者はドキュメントの表で補っている。
