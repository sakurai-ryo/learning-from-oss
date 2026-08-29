---
title: "Mount 型: マウントを実行せず、値として運ぶ"
description: "snapshotter が返すのは「マウント済みのパス」ではなく、mount(2) の引数をそのまま構造体にしたものだ。type・source・target・options の 4 つ。これが「containerd の共通語」で、誰がいつどこでマウントするかを受け取り側が決められる。VM の中でマウントする、そもそもマウントしない、という選択肢が残る。"
group: "ファイルシステムを積む"
sidebar:
  order: 37
---

## 何を学んだか

### Mount は mount(2) のシリアライズ

```go
// Mount is the lingua franca of containerd. A mount represents a
// serialized mount syscall. Components either emit or consume mounts.
type Mount struct {
	Type    string   // "overlay", "bind", "erofs", ...
	Source  string   // マウント元。パスまたはデバイス
	Target  string   // 親マウント内のサブディレクトリ (省略可)
	Options []string // fstab 形式のオプション
}
```

「containerd の共通語 (lingua franca)」と自称している。**部品はこれを出すか、これを消費するか** のどちらかだ。

- snapshotter が **出す**
- diff の applier が **消費する** (展開先として)
- shim が **消費する** (コンテナの rootfs として)
- CRI プラグインが **消費する** (イメージのマウントとして)

### 値だから、運べる

マウント済みのパスは、そのプロセスの mount namespace に紐付く。値なら protobuf に載せて別プロセスへ渡せる。

これが効く場面が 3 つある。

- **shim に渡す** — マウントを実行するのは shim で、containerd ではない
- **VM の中でマウントする** — Kata では、ゲスト内でマウントすることがある
- **マウントしない** — overlayfs への展開は upperdir に直接書けばよい ([differ: レイヤ tar を snapshot に適用する](../apply-and-diff/))

### 遅延できることが本質

`docs/mounts.md` の説明が的確だ。

```markdown title="docs/mounts.md"
`Mount` is an important struct in containerd used to represent a filesystem
without needing any active state. This allows deferring the mounting of
filesystems to when they are needed.
```

**「アクティブな状態を持たずにファイルシステムを表現する」**。マウントは資源の確保なので、確保のタイミングを遅らせられることに価値がある。

### snapshotter とランタイムが状態を共有しなくてよい

```markdown title="docs/mounts.md"
This is part of containerd's decoupled architecture where
snapshotters and runtimes don't need to share state, only the set of mounts
needs to be communicated.
```

snapshotter は「ストレージのライフサイクル」だけを見ればよく、「そのマウントが今使われているか」を知らなくてよい。両者の接点が値 1 つに絞られている。

## ソースコードのどこか

### 型の定義とオプションの注意書き

[`core/mount/mount.go#L26-L48`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/mount/mount.go#L26-L48)。

```go title="core/mount/mount.go"
// Mount is the lingua franca of containerd. A mount represents a
// serialized mount syscall. Components either emit or consume mounts.
type Mount struct {
	// Type specifies the host-specific of the mount.
	Type string
	// Source specifies where to mount from. Depending on the host system, this
	// can be a source path or device.
	Source string
	// Target specifies an optional subdirectory as a mountpoint. It assumes that
	// the subdirectory exists in a parent mount.
	Target string
	// Options contains zero or more fstab-style mount options. Typically,
	// these are platform specific.
	//
	// These options are formatted as required for passing to mount(8) or
	// the legacy mount(2) API after joining with ",", so some values may
	// have option-specific quoting or escaping applied. For example,
	// SELinux contexts (which can contain commas) are quoted, and
	// overlayfs uses backslash escaping on paths.
	Options []string
}
```

`Options` のコメントが実務的だ。**カンマで連結して渡す形式なので、値の中のカンマはクォートされる**。SELinux コンテキストや、`:` を含むパスの扱いで実際に問題になる部分で、値をパースする側はこれを知っている必要がある。

### 複数のマウントは順序を持つ

```go title="core/mount/mount.go"
// All mounts all the provided mounts to the provided target. If submounts are
// present, it assumes that parent mounts come before child mounts.
func All(mounts []Mount, target string) error {
	for _, m := range mounts {
		if err := m.Mount(target); err != nil {
			return err
		}
	}
	return nil
}

// UnmountMounts unmounts all the mounts under a target in the reverse order of
// the mounts array provided.
func UnmountMounts(mounts []Mount, target string, flags int) error {
	for i := len(mounts) - 1; i >= 0; i-- {
```

`[]Mount` は集合ではなく **順序付きの列** で、親マウントが先に来る。アンマウントは逆順。当たり前のようだが、この規約が doc に書かれていないと実装ごとにずれる。

### 型に修飾子が付くことがある

```go title="core/mount/mount.go"
// ReadOnly reports whether this mount is read-only, deriving it from the mount
// type where the options alone don't say so.
func (m *Mount) ReadOnly() bool {
	typ := m.Type
	// The mount type may carry "/"-separated modifiers meaningful only to the
	// mount manager (e.g. "format/mkdir/overlay"), so only its last segment is
	// considered.
	if i := strings.LastIndex(typ, "/"); i >= 0 {
		typ = typ[i+1:]
	}
	switch typ {
	case "erofs":
		// Read-only by construction, whatever the options say.
		return true
```

`Type` が `format/mkdir/overlay` のように **スラッシュ区切りの修飾子を持つ** ことがある。mount manager がこれを解釈して、前処理を行ってから最後の型でマウントする ([mount manager: マウント型を拡張し、漏れを追跡する](../mount-manager/))。

erofs は「構造上必ず read-only」なので、オプションに関係なく true を返す。**型そのものが持つ性質** を、オプションの解析より優先している。

### 一時マウントの後始末

[`core/mount/temp.go#L37-L70`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/mount/temp.go#L37-L70)。

```go title="core/mount/temp.go"
	// We use Remove here instead of RemoveAll.
	// The RemoveAll will delete the temp dir and all children it contains.
	// When the Unmount fails, RemoveAll will incorrectly delete data from
	// the mounted dir. However, if we use Remove, even though we won't
	// successfully delete the temp dir and it may leak, we won't loss data
	// from the mounted dir.
	// For details, please refer to #1868 #1785.
	defer func() {
		if uerr = os.Remove(root); uerr != nil {
```

**`RemoveAll` を使ってはいけない理由** が書かれている。アンマウントに失敗した状態で `RemoveAll` すると、マウント先の中身 (= イメージのレイヤ本体) を消してしまう。

`Remove` (空でないと失敗する) なら、最悪でも空ディレクトリが漏れるだけで済む。**データ損失とリソースリークなら、リークを選ぶ**。issue 番号が 2 つ添えてあるので、実際に事故があったと分かる。

```go title="core/mount/temp.go"
	// We should do defer first, if not we will not do Unmount when only a part of Mounts are failed.
	defer func() {
		if uerr = UnmountMounts(mounts, root, 0); uerr != nil {
```

アンマウントの defer を **マウントする前に** 登録する。複数マウントの途中で失敗したとき、成功した分をアンマウントするためだ。

これも順序を間違えると漏れる典型で、コメントで理由を書いている。

### Volatile オプションの除去

```go title="core/mount/temp.go"
	if uerr = All(RemoveVolatileOption(mounts), root); uerr != nil {
```

overlayfs の `volatile` オプション (fsync を省略して速くする) は、一時マウントでは除去される。一時マウントは短命で、`volatile` を付けたまま同じ upperdir を再マウントすると **カーネルがエラーを返す** ことがあるためだ。

## なぜそうなっているか

### マウントは「資源」なので、確保を遅らせたい

マウントは mount namespace のエントリを消費し、解放し忘れると残る。しかも解放は「使っている者がいなくなってから」でないとできない。

値として持ち回れば、

- **必要になるまで確保しない**
- **確保する主体を選べる** — shim、VM のゲスト、あるいは誰も確保しない
- **同じ情報を複数回使える** — 検査用に一時マウントし、後で本番のマウントを別の場所で行う

### プロセス境界を越えられる

`Mount` は protobuf のメッセージとしても定義されていて、shim API の `CreateTaskRequest` に含まれる ([runtime v2: シムをバイナリ呼び出し規約で起動する](../runtime-v2-binary/))。

```proto
message CreateTaskRequest {
	string id = 1;
	string bundle = 2;
	repeated containerd.types.Mount rootfs = 3;
	...
}
```

containerd は「こうマウントすればコンテナの rootfs になる」という情報を送るだけで、実際にマウントするのは shim だ。マウントは shim の mount namespace で行われ、shim が死ねば (delete バイナリコールで) 解除される。

責任の所在が明確になる。**マウントを作った者が解除する**。

### 「状態を持たない表現」の利点

`Mount` は不変の値なので、

- 保存できる (bundle に書ける)
- 比較できる (同じマウントかどうかが分かる)
- 送れる (protobuf)
- 加工できる (`RemoveVolatileOption`、`readonlyMounts`、`bindToOverlay`)

最後の加工が特に効いている。read-only 版を作る、bind を overlay に組み替える、といった変換が **純粋な関数** として書ける。マウント済みのパスを持っていたら、こうはいかない。

## どう活かすか

### マウント情報を見る

```sh
# snapshot のマウント情報を取得 (実際にマウントもする)
$ ctr -n k8s.io snapshots mounts /tmp/target <key>
mount -t overlay overlay -o index=off,userxattr,lowerdir=/var/lib/containerd/...:...
```

出力はそのまま実行できるコマンドの形になる。lowerdir の並びや、付いているオプションを確認できる。

コンテナの rootfs が期待通りに構成されているかを調べるとき、この出力が起点になる。

### 「実行せずに値で返す」設計

副作用を伴う操作を設計するとき、「実行する」代わりに「実行方法を返す」選択肢がある。

向いているのは次の条件のときだ。

- **実行主体が呼び出し側と異なりうる** — 別プロセス、別 namespace、別ホスト
- **実行のタイミングを遅らせたい** — 資源の確保を最後まで引き延ばす
- **実行しない選択肢がある** — 検査だけ、変換だけ
- **加工したい** — read-only にする、一部を差し替える

代償は、実行方法を表現する語彙を設計する必要があること。containerd の場合は `mount(2)` の引数という既存の語彙をそのまま使ったので、設計コストがほぼゼロだった。**既存のシステムコールやコマンドの引数をそのまま構造体にする** のは、この種の設計で最も安全な出発点になる。
