---
title: "bundle: ディスク上に置かれた実行単位"
description: "/run/containerd/io.containerd.runtime.v2.task/<ns>/<id>/ に config.json と rootfs と付帯ファイルが並ぶ。containerd と shim の待ち合わせ場所であり、containerd が死んでも残る唯一の実行状態でもある。削除は「隠しディレクトリに rename してから消す」ことで原子性を確保する。"
group: "コンテナを実行する"
sidebar:
  order: 43
---

## 何を学んだか

### bundle の中身

```
/run/containerd/io.containerd.runtime.v2.task/k8s.io/<container-id>/
├── config.json        ← OCI Runtime Spec (containerd が書く、解釈しない)
├── rootfs/            ← shim がここに snapshotter のマウントを当てる
├── work -> /var/lib/containerd/io.containerd.runtime.v2.task/k8s.io/<id>  ← symlink
├── address            ← shim の ttrpc ソケットアドレス
├── bootstrap.json     ← 再接続に必要な情報
├── shim-binary-path   ← 使った shim バイナリのパス
├── log                ← shim のログ fifo
└── init.pid           ← runc が書くコンテナ init の PID
```

`config.json` と `rootfs/` が [OCI Runtime Spec](../oci-runtime-spec/) の定めるもの、残りは containerd と shim の私的な取り決めだ。

### state と root、2 つのディレクトリ

bundle には 2 つの場所が対応する。

- **state** (`/run/containerd/...`) — bundle 本体。tmpfs 上で、ホスト再起動で消える
- **root** (`/var/lib/containerd/...`) — 作業ディレクトリ。再起動をまたいで残る

state 側から root 側へ `work` という symlink が張られる。「再起動で消えてよいもの」と「残すもの」を物理的に分けている。

### 削除は rename してから

`Bundle.Delete()` は、ディレクトリを直接消さずに **`.<id>` という隠し名に rename してから** `RemoveAll` する。

rename は原子的なので、「消している途中のディレクトリ」が元の名前で見えることがない。起動時の走査が中途半端な bundle を拾わずに済む。

### 空の bundle は復元しない

containerd の起動時、bundle ディレクトリの中身が空なら、その bundle は削除される。作りかけで死んだものを引きずらない。

## ソースコードのどこか

### 作成

[`core/runtime/v2/bundle.go#L46-L118`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/bundle.go#L46-L118)。

```go title="core/runtime/v2/bundle.go"
func NewBundle(ctx context.Context, root, state, id string, spec typeurl.Any) (b *Bundle, err error) {
	if err := identifiers.Validate(id); err != nil {
		return nil, fmt.Errorf("invalid task id %s: %w", id, err)
	}
	...
	work := filepath.Join(root, ns, id)
	b = &Bundle{
		ID:        id,
		Path:      filepath.Join(state, ns, id),
		Namespace: ns,
	}
	var paths []string
	defer func() {
		if err != nil {
			for _, d := range paths {
				os.RemoveAll(d)
			}
		}
	}()
```

**ID の検証が最初** にある。ID はディレクトリ名になるので、`../` を含む値を弾く必要がある。`identifiers.Validate` は英数字とごく一部の記号だけを許す。

作ったディレクトリを `paths` に記録し、失敗したら全部消す。ここでも「作った分だけ後始末する」形になっている。

```go title="core/runtime/v2/bundle.go"
	// create state directory for the bundle
	if err := os.MkdirAll(filepath.Dir(b.Path), 0711); err != nil {
		return nil, err
	}
	if err := os.Mkdir(b.Path, 0700); err != nil {
		return nil, err
	}
	if typeurl.Is(spec, &specs.Spec{}) {
		if err := prepareBundleDirectoryPermissions(b.Path, spec.GetValue()); err != nil {
			return nil, err
		}
	}
```

親は `0711` (通り抜けのみ)、bundle 自身は `0700`。ただし spec が OCI spec なら、`prepareBundleDirectoryPermissions` が user namespace の設定を見てパーミッションを緩める。**remap されたコンテナのプロセスが自分の bundle に到達できる必要がある** ためだ。

```go title="core/runtime/v2/bundle.go"
	if err := os.Mkdir(work, 0711); err != nil {
		if !os.IsExist(err) {
			return nil, err
		}
		os.RemoveAll(work)
		if err := os.Mkdir(work, 0711); err != nil {
			return nil, err
		}
	}
	paths = append(paths, work)
	// symlink workdir
	if err := os.Symlink(work, filepath.Join(b.Path, "work")); err != nil {
```

work ディレクトリが既にあれば、**消して作り直す**。state 側は tmpfs で消えているのに root 側が残っている、というのはホスト再起動後に必ず起こる状況で、古い作業ディレクトリを引き継ぐと壊れる。

spec の書き込みは [OCI Runtime Spec](../oci-runtime-spec/) で見た通り、バイト列をそのまま書く。

```go title="core/runtime/v2/bundle.go"
	// Spec may be nil for some sandboxers that do not initialize the spec, for
	// example the shim sandboxer with a hostNetwork container.
	if spec != nil {
		if spec := spec.GetValue(); spec != nil {
			specPath := filepath.Join(b.Path, oci.ConfigFilename)
			err = os.WriteFile(specPath, spec, 0666)
```

spec が nil のこともある。VM ベースの sandbox では OCI spec を持たないことがあるので、**必須にしていない**。

### 削除の原子性

[`core/runtime/v2/bundle.go#L128-L170`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/bundle.go#L128-L170)。

```go title="core/runtime/v2/bundle.go"
// Delete a bundle atomically
func (b *Bundle) Delete() error {
	work, werr := os.Readlink(filepath.Join(b.Path, "work"))
	rootfs := filepath.Join(b.Path, "rootfs")
	if err := mount.UnmountRecursive(rootfs, 0); err != nil {
		return fmt.Errorf("unmount rootfs %s: %w", rootfs, err)
	}
	if err := os.Remove(rootfs); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove bundle rootfs: %w", err)
	}
	err := atomicDelete(b.Path)
```

順序が重要だ。

1. **work の symlink を先に読む** — ディレクトリを消したら読めなくなる
2. **rootfs を再帰的にアンマウント** — マウントが残っていると削除できない
3. **rootfs を `Remove`** — `RemoveAll` ではない。アンマウント漏れがあった場合にイメージのデータを消さないため ([Mount 型: マウントを実行せず、値として運ぶ](../mount-as-value/) の一時マウントと同じ配慮)
4. bundle 全体を atomicDelete

```go title="core/runtime/v2/bundle.go"
// atomicDelete renames the path to a hidden file before removal
func atomicDelete(path string) error {
	// create a hidden dir for an atomic removal
	atomicPath := filepath.Join(filepath.Dir(path), fmt.Sprintf(".%s", filepath.Base(path)))
	if err := os.Rename(path, atomicPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.RemoveAll(atomicPath)
}
```

`.` を前置した名前に rename する。走査側は `.` で始まるディレクトリを飛ばすので、**削除中のものが見えない**。

```go title="core/runtime/v2/shim_load.go"
		// skip hidden directories
		if len(ns) > 0 && ns[0] == '.' {
			continue
		}
```

削除側と走査側の規約が対になっている。

### 両方消そうとする

```go title="core/runtime/v2/bundle.go"
	err := atomicDelete(b.Path)
	if err == nil {
		if werr == nil {
			return atomicDelete(work)
		}
		return nil
	}
	// error removing the bundle path; still attempt removing work dir
	var err2 error
	if werr == nil {
		err2 = atomicDelete(work)
		if err2 == nil {
			return err
		}
	}
	return fmt.Errorf("failed to remove both bundle and workdir locations: %v: %w", err2, err)
```

bundle の削除に失敗しても、**work ディレクトリの削除は試みる**。片方の失敗でもう片方を諦めない。

エラーメッセージも「両方の削除に失敗した」と正確に述べる。片方だけ失敗した場合は、そちらのエラーだけを返す。

### 起動時の復元での扱い

[`core/runtime/v2/shim_load.go#L84-L110`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/shim_load.go#L84-L110)。

```go title="core/runtime/v2/shim_load.go"
		eg.Go(func() error {
			// fast path
			f, err := os.Open(bundle.Path)
			if err != nil {
				bundle.Delete()
				log.G(ctx2).WithError(err).Errorf("fast path read bundle path for %s", bundle.Path)
				return nil
			}

			bf, err := f.Readdirnames(-1)
			f.Close()
			...
			if len(bf) == 0 {
				bundle.Delete()
				return nil
			}
```

「fast path」と名付けられた検査で、**中身が空の bundle を即座に削除する**。ttrpc の接続を試みる前に、明らかに死んでいるものを弾く。

起動時間に効く最適化で、大量の残骸がある環境では差が出る。

## なぜそうなっているか

### bundle は待ち合わせ場所

containerd は `config.json` を書き、shim はそれを読む。shim はソケットアドレスを `address` に書き、containerd はそれを読む。**両者は直接データを渡さず、ディレクトリを介してやり取りする**。

この間接化の利点は、片方が死んでも情報が残ることだ。containerd が再起動しても、bundle を読めば「どの shim にどう繋げばよいか」が分かる。

### tmpfs に置くことの意味

state ディレクトリ (`/run`) は tmpfs なので、ホストが再起動すれば全部消える。これは正しい振る舞いで、**ホスト再起動後にコンテナは生きていない** からだ。

もし永続ディスクに置いていたら、起動時に「動いているはずだが実際は死んでいる」bundle を大量に処理することになる。tmpfs が自動的に掃除してくれる。

一方 work ディレクトリは root 側 (`/var/lib`) にある。こちらは snapshotter などが使う作業領域で、再起動をまたいで残る可能性がある。だから `NewBundle` で明示的に作り直している。

### rename してから消す

`RemoveAll` は再帰的に消していくので、途中で失敗すると **中途半端なディレクトリが元の名前で残る**。起動時の走査がそれを拾うと、壊れた状態を復元しようとする。

rename を挟めば、

- 名前が変わった時点で「もうない」と扱える
- 実際の削除が失敗しても、隠し名なので走査に拾われない
- rename 自体は原子的なので、中間状態がない

**「見えなくすること」と「消すこと」を分ける** のは、削除処理の定石として応用が利く。

## どう活かすか

### bundle から状態を読む

```sh
# 動いているコンテナの bundle
$ ls -la /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>/

# 実際に runc に渡された設定
$ jq . /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>/config.json

# shim の接続先
$ cat /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>/bootstrap.json
```

「Pod のマニフェストと実際の設定が違う」を確認できる唯一の場所が `config.json` だ。CRI プラグインや NRI プラグインの変換結果がここに現れる。

### 残骸を見つける

```sh
# 隠しディレクトリ (削除に失敗した残骸)
$ ls -a /run/containerd/io.containerd.runtime.v2.task/k8s.io/ | grep '^\.'

# 対応する shim がいない bundle
$ ls /run/containerd/io.containerd.runtime.v2.task/k8s.io/
$ ps -ef | grep containerd-shim
```

`.` で始まるディレクトリが残っていたら、削除処理が中断している。手で消しても containerd は困らない (走査対象外なので)。

### 「ディレクトリを介したプロセス間の待ち合わせ」

2 つのプロセスが協調する設計で、この形は有効だ。

- **やり取りする情報をファイルにする** — 片方が死んでも残る
- **ディレクトリを 1 つの単位にする** — 関連するファイルをまとめる
- **削除は rename してから** — 中途半端な状態を見せない
- **隠し名の規約を、走査側と削除側で共有する**
- **揮発してよいものは tmpfs に置く** — 掃除を OS に任せる

最後の点は見落とされがちだ。「再起動したら無効になる状態」を永続ディスクに置くと、その無効化を自分で実装することになる。置き場所を選ぶだけで消せる仕事がある。
