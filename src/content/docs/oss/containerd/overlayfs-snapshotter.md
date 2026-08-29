---
title: "overlayfs snapshotter を読む"
description: "700 行ほどの実装で、ディレクトリを作り、rename で確定させ、マウント情報を組み立てる。起動時に d_type と userxattr をカーネルに問い合わせて挙動を決め、削除は「メタデータを消してから、トランザクションの外でディレクトリを消す」。この章で見てきた原則が実装レベルでどう現れるかを確認する。"
group: "ファイルシステムを積む"
sidebar:
  order: 36
---

## 何を学んだか

### やっていることは 4 つ

1. **起動時にカーネルの機能を検出する** — d_type、userxattr、index
2. **Prepare でディレクトリを作る** — 一時ディレクトリに作り、ID が確定したら rename
3. **Commit で使用量を測って storage に渡す**
4. **Mounts でマウント情報を組み立てる** — 親の数で bind と overlay を使い分ける

ファイルシステムの操作はこれだけで、キーの管理も状態の検査も storage パッケージが行う ([snapshotter 共通のメタデータを、1 つのパッケージに切り出す](../snapshot-storage/))。

### 起動時にカーネルを試す

`NewSnapshotter` は、root ディレクトリのファイルシステムに対して 3 つの検査を行う。

- **d_type のサポート** — なければ **起動を拒否する**。overlayfs が正しく動かない
- **userxattr が必要か** — user namespace 内で overlayfs を使う場合に必要
- **index の対応** — 対応していれば `index=off` を明示する

「動く環境かどうか」をプラグインの初期化時に判定し、駄目なら失敗する。プラグインの初期化失敗はデーモンを止めない ([中核が空のデーモン](../plugin-architecture/)) ので、この snapshotter だけが無効になる。

### 一時ディレクトリ + rename

新しい snapshot のディレクトリは `new-XXXXX` という一時名で作られ、ID が確定してから `snapshots/<ID>` に rename される。

**中途半端なディレクトリが `snapshots/` に見えない**。content store の ingest と同じパターンだ ([ingest: 中断しても続きから書ける書き込み](../content-ingest/))。

### 削除はトランザクションの外で

`Remove` はメタデータを消すだけで、ディレクトリの削除は **トランザクションが commit された後** に行う。しかも失敗しても無視する。

さらに `Cleanup` があり、これは「メタデータにないディレクトリを全部消す」。取りこぼしはここで回収される。

## ソースコードのどこか

### 起動時の環境検査

[`plugins/snapshots/overlay/overlay.go#L121-L170`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/snapshots/overlay/overlay.go#L121-L170)。

```go title="plugins/snapshots/overlay/overlay.go"
	supportsDType, err := fs.SupportsDType(root)
	if err != nil {
		return nil, err
	}
	if !supportsDType {
		return nil, fmt.Errorf("%s does not support d_type. If the backing filesystem is xfs, please reformat with ftype=1 to enable d_type support", root)
	}
```

エラーメッセージに **対処法が書いてある**。「xfs なら ftype=1 で再フォーマットせよ」。この問題は実際に踏むと原因が分かりにくいので、メッセージで直接誘導している。

```go title="plugins/snapshots/overlay/overlay.go"
	if !hasOption(config.mountOptions, "userxattr") {
		// figure out whether "userxattr" option is recognized by the kernel && needed
		userxattr, err := overlayutils.NeedsUserXAttr(root)
		if err != nil {
			log.L.WithError(err).Warnf("cannot detect whether \"userxattr\" option needs to be used, assuming to be %v", userxattr)
		}
		if userxattr {
			config.mountOptions = append(config.mountOptions, "userxattr")
		}
	}

	// Mount options are last-wins in the kernel, so appending "index=off"
	// after a configured "index=on" would silently override it.
	if !hasOption(config.mountOptions, "index") && supportsIndex() {
		config.mountOptions = append(config.mountOptions, "index=off")
	}
```

コメントが 2 つとも重要だ。

- 検出に失敗しても **警告を出して続ける**。「検出できなかったので false と仮定する」
- **カーネルの mount option は後勝ち** なので、利用者が `index=on` を設定していたら追加しない

後者は静かに壊れる種類のバグで、`hasOption` という 10 行の関数を用意してまで防いでいる。

```go title="plugins/snapshots/overlay/overlay.go"
// as a bare flag ("userxattr") or in "key=value" form ("index=on").
func hasOption(options []string, key string) bool {
	for _, option := range options {
		if option == key {
			return true
		}
		if optionKey, _, ok := strings.Cut(option, "="); ok && optionKey == key {
			return true
		}
	}
	return false
}
```

フラグ形式 (`userxattr`) と key=value 形式 (`index=on`) の両方を扱う。

### Prepare の本体

[`plugins/snapshots/overlay/overlay.go#L431-L535`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/snapshots/overlay/overlay.go#L431-L535)。

```go title="plugins/snapshots/overlay/overlay.go"
	defer func() {
		if err != nil {
			if td != "" {
				if err1 := os.RemoveAll(td); err1 != nil {
					log.G(ctx).WithError(err1).Warn("failed to cleanup temp snapshot directory")
				}
			}
			if path != "" {
				if err1 := os.RemoveAll(path); err1 != nil {
					log.G(ctx).WithError(err1).WithField("path", path).Error("failed to reclaim snapshot directory, directory may need removal")
					err = fmt.Errorf("failed to remove path: %v: %w", err1, err)
				}
			}
		}
	}()
```

失敗時の後始末が 2 段階になっている。一時ディレクトリの削除失敗は **Warn** (次の Cleanup で回収される)、rename 後のディレクトリの削除失敗は **Error でエラーに追加** (メタデータのない孤児が残るため、より深刻)。

ログレベルが深刻度に対応している。

トランザクションの中身。

```go title="plugins/snapshots/overlay/overlay.go"
	if err := o.ms.WithTransaction(ctx, true, func(ctx context.Context) (err error) {
		snapshotDir := filepath.Join(o.root, "snapshots")
		td, err = o.prepareDirectory(ctx, snapshotDir, kind)
		...
		s, err = storage.CreateSnapshot(ctx, kind, key, parent, opts...)
		...
		path = filepath.Join(snapshotDir, s.ID)
		if err = os.Rename(td, path); err != nil {
			return fmt.Errorf("failed to rename: %w", err)
		}
		td = ""

		return nil
	}); err != nil {
		return nil, err
	}
	return o.mounts(s, info), nil
```

ディレクトリを作ってから ID を採番し、rename する。`td = ""` で「一時ディレクトリはもうない」と記録するので、defer の後始末が二重に走らない。

**トランザクションの中でファイルシステム操作をしている** 点は、[metadata が実装を包む](../metadata-wrapping/) で見た原則と逆に見える。ただしここは snapshotter 自身の小さな DB で、`mkdir` と `rename` は速い。トランザクションの粒度が違う。

### idmapped mounts への対応

```go title="plugins/snapshots/overlay/overlay.go"
		// NOTE: if idmapped mounts' supported by hosted kernel there may be
		// no parents at all, so overlayfs will not work and snapshotter
		// will use bind mount. To be able to create file objects inside the
		// rootfs -- just chown this only bound directory according to provided
		// {uid,gid}map. In case of one/multiple parents -- chown upperdir.
```

user namespace 対応のために、UID/GID マッピングのラベルが付いていたら upperdir を chown する。親がない場合は bind マウントになるので、その 1 つのディレクトリを chown する。

**マウントの形が違えば、chown する対象も違う** という条件分岐が、コメント込みで説明されている。

### Commit で使用量を測る

[`plugins/snapshots/overlay/overlay.go#L300-L318`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/snapshots/overlay/overlay.go#L300-L318)。

```go title="plugins/snapshots/overlay/overlay.go"
		usage, err := fs.DiskUsage(ctx, o.upperPath(id))
		if err != nil {
			return err
		}

		if _, err = storage.CommitActive(ctx, key, name, snapshots.Usage(usage), opts...); err != nil {
```

commit の時点でディスク使用量を測り、メタデータに保存する。committed は不変なので、**一度測れば以降は再計算不要** になる。

`Usage()` が active に対しては遅い ([Snapshotter インターフェースの 4 つの動詞](../snapshotter-interface/)) のに committed には速いのは、この差だ。

### Remove と Cleanup の二段構え

```go title="plugins/snapshots/overlay/overlay.go"
// Remove abandons the snapshot identified by key. The snapshot will
// immediately become unavailable and unrecoverable. Disk space will
// be freed up on the next call to `Cleanup`.
func (o *snapshotter) Remove(ctx context.Context, key string) (err error) {
	var removals []string
	// Remove directories after the transaction is closed, failures must not
	// return error since the transaction is committed with the removal
	// key no longer available.
	defer func() {
		if err == nil {
			for _, dir := range removals {
				if err := os.RemoveAll(dir); err != nil {
					log.G(ctx).WithError(err).WithField("path", dir).Warn("failed to remove directory")
				}
			}
		}
	}()
```

コメントが理由を述べている。「トランザクションはキーの削除で commit されているので、ディレクトリ削除の失敗をエラーとして返してはならない」。

**メタデータ上は消えているのにエラーを返すと、呼び出し側が再試行して混乱する**。だから警告に留め、実体の回収は `Cleanup` に任せる。

```go title="plugins/snapshots/overlay/overlay.go"
func (o *snapshotter) cleanupDirectories(ctx context.Context) (_ []string, err error) {
	var cleanupDirs []string
	// Get a write transaction to ensure no other write transaction can be entered
	// while the cleanup is scanning.
	if err := o.ms.WithTransaction(ctx, true, func(ctx context.Context) error {
		cleanupDirs, err = o.getCleanupDirectories(ctx)
		return err
	}); err != nil {
```

走査中に他の書き込みが入らないよう、**読み取りだけなのに書き込みトランザクション** を取る。新しい snapshot が作られている最中にディレクトリを列挙すると、まだメタデータに入っていないものを孤児と誤認しかねない。

```go title="plugins/snapshots/overlay/overlay.go"
func (o *snapshotter) getCleanupDirectories(ctx context.Context) ([]string, error) {
	ids, err := storage.IDMap(ctx)
	...
	dirs, err := fd.Readdirnames(0)
	...
	for _, d := range dirs {
		if _, ok := ids[d]; ok {
			continue
		}
```

メタデータの ID 一覧を作り、ディレクトリを列挙して、**一覧にないものを掃除対象にする**。containerd 本体の GC と同じ「差分同期」の形が、snapshotter の中にもある。

## なぜそうなっているか

### 環境依存を起動時に潰す

overlayfs は環境によって挙動が変わる。d_type がない xfs、user namespace 内、古いカーネル。これらを実行時に毎回判定すると遅く、判定漏れも起きる。

起動時に 1 回検査してマウントオプションを確定させれば、以降は同じオプションを使い回せる。**環境差を初期化の一点に閉じ込める**。

d_type がない場合に「動くが壊れる」ではなく「起動を拒否する」を選んでいるのも、後から原因を追うのが難しい種類の問題だからだ。

### 削除を 2 段階にする理由

`Remove` でディレクトリを消し切らないのは、

- トランザクションの中で `RemoveAll` を呼ぶと、数万ファイルの削除でトランザクションが長引く
- 削除に失敗したときの扱いが難しい (メタデータは消えているのでロールバックできない)
- マウントされたままのディレクトリは消せないことがある

「メタデータを正、実体を従」として、**取りこぼしを後から回収する** 設計にすれば、これらが全部解決する。containerd 本体の GC と同じ考え方が、階層の違う場所で同じように使われている。

### 700 行で収まる理由

overlayfs snapshotter の実装が小さいのは、責務が削られているからだ。

- キー管理と状態遷移 → storage パッケージ
- namespace とリース → metadata 層
- マウントの実行 → 呼び出し側
- 削除の判断 → GC

**残ったのは「ディレクトリを作る/消す」と「オプション文字列を組み立てる」だけ**。この分業が、10 種類以上の snapshotter 実装を成立させている。

## どう活かすか

### overlayfs が使えない環境

```
/var/lib/containerd/... does not support d_type. If the backing filesystem is xfs, please reformat with ftype=1 to enable d_type support
```

このエラーが出たら、`xfs_info` で `ftype` を確認する。

```sh
$ xfs_info /var/lib/containerd | grep ftype
```

`ftype=0` なら再フォーマットが必要になる。RHEL 7 時代の xfs で既定値だったため、古い環境で踏むことがある。

### マウントオプションを確認する

```sh
# 実際のマウント
$ mount | grep overlay

# snapshotter が返すマウント情報
$ ctr -n k8s.io snapshots mounts /tmp/x <key>
```

`userxattr` や `index=off` が付いているかを確認できる。rootless 環境で `userxattr` がないと、whiteout が正しく機能しない。

### 実装の分業を設計するときの目安

containerd の snapshotter が示す分け方は、プラグイン境界を設計するときの参考になる。

- **環境依存の検出は初期化時に 1 回** — 実行時に毎回判定しない
- **失敗する環境では起動を拒否する** — 半端に動かさない
- **削除は「速い部分」と「遅い部分」に分ける** — 遅い方は後から回収
- **後始末の失敗のログレベルを、回収可能性で変える** — 自動回収されるなら Warn、されないなら Error

最後の点は小さいが、運用でログを見るときの負担に直結する。「放っておいてよい警告」と「調べるべきエラー」が区別できると、ログの価値が上がる。
