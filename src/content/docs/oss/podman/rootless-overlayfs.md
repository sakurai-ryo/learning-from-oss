---
title: "rootless で overlayfs をどう使うか"
description: "非特権ユーザは長らく overlayfs をマウントできず、rootless コンテナは fuse-overlayfs という FUSE 実装に頼っていた。Linux 5.11 で user namespace 内の overlay マウントが解禁されたが、SELinux との組み合わせや backing filesystem によっては依然として動かない。containers/storage は「機能を推測せず、起動時に実際にマウントしてみる」という方法でこれを判定し、失敗したら fuse-overlayfs に落ちる。"
group: "イメージとストレージ"
sidebar:
  order: 10
---

## 何を学んだか

### 非特権ユーザは overlayfs をマウントできなかった

`mount(2)` は特権操作だ。user namespace の中では、その namespace の中の root として一部のファイルシステムだけがマウントできる (tmpfs、proc、sysfs、bind mount など)。overlayfs は長らくこの許可リストに入っていなかった。

これは rootless コンテナにとって致命的だ。イメージのレイヤを重ねられなければ、コンテナの rootfs が作れない。取れる手は 3 つしかなかった。

1. **`vfs` ドライバを使う** — レイヤを重ねずに毎回コピーする。動くが、ディスクも時間も食う
2. **fuse-overlayfs を使う** — overlayfs 相当の動作を FUSE (ユーザ空間ファイルシステム) で実装する。FUSE のマウント自体は非特権で許されている
3. **カーネルが対応するのを待つ**

Podman は長く 2 を既定にしてきた。そして Linux 5.11 で 3 が実現する。**user namespace 内での overlayfs マウントが解禁された** (ソース中のコメントは 5.11、[`rootless.md`](https://github.com/podman-container-tools/podman/blob/v6.1.0/rootless.md) は「Podman 3.1 以降 + カーネル 5.12 以降」と書いている。実用上の対応バージョンとして後者を見ておくのが安全だ)。

### 解禁されたが、条件付きだった

5.11 以降のネイティブ overlay には注意点がある。

- **`userxattr` オプションが要る。** 通常の overlayfs は `trusted.overlay.*` という拡張属性を使うが、これは `CAP_SYS_ADMIN` が要る。非特権では `user.overlay.*` を使う必要があり、それを指示するのが `userxattr` だ。
- **SELinux との組み合わせに問題があった。** ラベル付きマウントと非特権 overlay の相性が悪い時期があった。
- **backing filesystem を選ぶ。** overlayfs の上に overlayfs は重ねられない (ネストしたコンテナでよく踏む)。ネットワークファイルシステム (NFS など) の上でも動かない。
- **whiteout の作り方が違う。** 削除されたファイルを表す whiteout はキャラクタデバイス (`mknod`) だが、非特権では `mknod` できない場合がある。

つまり「カーネルバージョンを見れば分かる」という単純な判定ができない。**環境の組み合わせで動いたり動かなかったりする**。

### だから「実際にやってみる」

containers/storage の答えは、機能フラグの推測をやめて **起動時に本物のテストマウントを実行する** ことだった。

一時ディレクトリを作り、下位レイヤ 2 つと上位レイヤと workdir を用意し、whiteout を `mknod` で作り、実際に `mount("overlay", ...)` を呼ぶ。成功したらネイティブ overlay を使い、失敗したら `fuse-overlayfs` を探して使い、それも無ければエラー。判定結果はフラグファイルにキャッシュする。

判定コードが「機能の名前」ではなく **「やりたいことそのもの」** を試している点が重要だ。

## ソースコードのどこか

### テストマウントの全体

[`vendor/go.podman.io/storage/drivers/overlay/overlay.go#L721`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/storage/drivers/overlay/overlay.go#L721) の `supportsOverlay`。

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
		// Try a test mount in the specific location we're looking at using.
		mergedDir := filepath.Join(layerDir, "merged")
		mergedSubdir := filepath.Join(mergedDir, "subdir")
		lower1Dir := filepath.Join(layerDir, "lower1")
		lower2Dir := filepath.Join(layerDir, "lower2")
		lower2Subdir := filepath.Join(lower2Dir, "subdir")
		lower2SubdirFile := filepath.Join(lower2Subdir, "file")
		upperDir := filepath.Join(layerDir, "upper")
		workDir := filepath.Join(layerDir, "work")
```

**「まさに使おうとしている場所で」** テストマウントする、とコメントにある。`$GRAPHROOT` の中に一時ディレクトリを掘るので、backing filesystem も SELinux のコンテキストも本番と同じになる。`/tmp` でテストして本番で失敗する、という事故を避けている。

下位レイヤを 2 つ作るのも意図的だ。overlayfs の「複数の lowerdir」は カーネル 4.0 以降の機能で、1 つだけの overlay とは別に確認が要る。

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
		flags := fmt.Sprintf("lowerdir=%s:%s,upperdir=%s,workdir=%s", lower1Dir, lower2Dir, upperDir, workDir)
		if selinux.GetEnabled() &&
			selinux.SecurityCheckContext(selinuxLabelTest) == nil {
			// Linux 5.11 introduced unprivileged overlay mounts but it has an issue
			// when used together with selinux labels.
			// Check that overlay supports selinux labels as well.
			flags = label.FormatMountLabel(flags, selinuxLabelTest)
		}
		if unshare.IsRootless() {
			flags = fmt.Sprintf("%s,userxattr", flags)
		}
		if err := syscall.Mknod(filepath.Join(upperDir, "whiteout"), syscall.S_IFCHR|0o600, int(unix.Mkdev(0, 0))); err != nil {
			logrus.Debugf("Unable to create kernel-style whiteout: %v", err)
			return supportsDType, fmt.Errorf("unable to create kernel-style whiteout: %w", err)
		}
```

3 つの条件を全部テストに織り込んでいる。

1. **SELinux が有効なら、ラベル付きでマウントしてみる。** コメントに「5.11 で非特権 overlay が入ったが、SELinux ラベルと併用すると問題がある。ラベルもサポートしているか確認する」と理由が書いてある
2. **rootless なら `userxattr` を付ける**
3. **whiteout を実際に `mknod` してみる。** これが通らない環境ならネイティブ overlay は使えない

そしてマウント後、`merged` の中のサブディレクトリを削除してみる。

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
			err := unix.Mount("overlay", mergedDir, "overlay", 0, flags)
			if err == nil {
				if err = os.RemoveAll(mergedSubdir); err != nil {
					logrus.StandardLogger().Logf(logLevel, "overlay: removing an item from the merged directory failed: %v", err)
					return supportsDType, fmt.Errorf("kernel returned %v when we tried to delete an item in the merged directory: %w", err, graphdriver.ErrNotSupported)
				}
```

**マウントできただけでは足りない**。下位レイヤにあるファイルを上書き削除する (= whiteout を作る) 操作が通るかまで確認する。ここまでやって初めて「使える」と判断している。

マウント引数の長さチェックも入っている。

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
		if len(flags) < unix.Getpagesize() {
```

前ページで見たページサイズ制限が、テストの段階から効いている。テストマウントの引数が長すぎるなら、そもそも試さずに次の手 (lowerdir 1 つ) に進む。

### 失敗したら fuse-overlayfs を探す

[`vendor/go.podman.io/storage/drivers/overlay/overlay.go#L367-L375`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/storage/drivers/overlay/overlay.go#L367)。

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
	if opts.mountProgram == "" {
		if supported, err := SupportsNativeOverlay(home, runhome); err != nil {
			return nil, err
		} else if !supported {
			if path, err := exec.LookPath("fuse-overlayfs"); err == nil {
				opts.mountProgram = path
			}
		}
	}
```

「明示的な `mount_program` の設定がない」→「ネイティブ overlay が使えるか試す」→「駄目なら `fuse-overlayfs` を PATH から探す」。3 段の縮退が 9 行で書かれている。

`mount_program` が使われた場合、その事実を **ディスク上のフラグファイルに残す**。

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
		if err := os.WriteFile(getMountProgramFlagFile(home), []byte("true"), 0o600); err != nil {
```

ファイル名は `.has-mount-program`。次回の起動で「前回は mount program を使った」ことが分かる。ネイティブ overlay と fuse-overlayfs では **レイヤの中身の互換性がない場合がある** ので、途中で切り替わったことを検出する必要がある。

### 使えない組み合わせは、はっきり断る

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
	} else {
		// check if they are running over btrfs, aufs, overlay, or ecryptfs
		switch fsMagic {
		case graphdriver.FsMagicAufs, graphdriver.FsMagicOverlay, graphdriver.FsMagicEcryptfs:
			return nil, fmt.Errorf("'overlay' is not supported over %s, a mount_program is required: %w", backingFs, graphdriver.ErrIncompatibleFS)
		}
		if unshare.IsRootless() && isNetworkFileSystem(fsMagic) {
			return nil, fmt.Errorf("a network file system with user namespaces is not supported.  Please use a mount_program: %w", graphdriver.ErrIncompatibleFS)
		}
	}
```

overlayfs の上、aufs の上、ecryptfs の上ではネイティブ overlay を使わない。**「overlay の上に overlay」はネストしたコンテナで頻発する** ので、エラーメッセージも「mount_program が必要です」と対処法込みになっている。

ネットワークファイルシステム上で mount_program を使う場合は、さらに `force_mask` を強制する。

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
		if unshare.IsRootless() && isNetworkFileSystem(fsMagic) && opts.forceMask == nil {
			m := os.FileMode(0o700)
			opts.forceMask = &m
			logrus.Warnf("Network file system detected as backing store.  Enforcing overlay option `force_mask=\"%o\"`.  Add it to storage.conf to silence this warning", m)
		}
```

NFS 上では拡張属性やパーミッションの扱いが特殊なので、パーミッションを強制的に `0700` に倒す。**勝手に設定を変えるが、警告を出し、恒久的な直し方 (storage.conf に書け) も示す**。

### 実際のマウント時にも userxattr が付く

[`vendor/go.podman.io/storage/drivers/overlay/overlay.go#L1712`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/storage/drivers/overlay/overlay.go#L1712)。

```go title="go.podman.io/storage/drivers/overlay/overlay.go"
	if d.options.mountProgram == "" && unshare.IsRootless() {
		optsList = append(optsList, "userxattr")
	}
```

fuse-overlayfs を使う場合は不要 (FUSE が自分で処理する)、ネイティブかつ rootless のときだけ付ける。テスト時と本番で同じ条件を使う、という一貫性が保たれている。

## なぜそうなっているか

### 機能検出は、機能の名前ではなく機能そのものを試す

カーネルバージョンで分岐するコードは、必ず破綻する。ディストリビューションはパッチをバックポートするし、コンテナの中ではホストとゲストのカーネルが同じでも制約が違うし、セキュリティモジュールが挙動を変える。

「5.11 以降ならネイティブ overlay」という判定は **どれも正しくない**。だから実際にマウントし、実際に whiteout を作り、実際にファイルを消してみる。起動時に数十ミリ秒のコストを払って、確実な答えを得ている。

これは自分のコードでも使える判断だ。**「この環境でこれができるか」を知る一番確実な方法は、やってみること**。ただし副作用のない場所で、後始末できる形で。`supportsOverlay` が `defer` で必ずアンマウントと削除をしているのは、その条件を満たすためだ。

### fuse-overlayfs を捨てられない

ネイティブ overlay が使えるようになっても、fuse-overlayfs は残り続ける。overlayfs の上、NFS の上、古いカーネル — いずれも現実に存在する環境だからだ。

前提群で「フォールバックを書かない勇気」に触れたが、ここは逆で **フォールバックが必須の領域** になっている。違いは「その機能がなくても本質的な仕事ができるか」だ。ヘルスチェックは無くても コンテナは動くが、rootfs が作れなければ何も動かない。**落としてよい機能と、落とせない機能を見分ける** ことが判断の分かれ目になる。

### rootless の制約が、そのまま実装の複雑さになる

このページのコードのほとんどは、rootless でなければ書かなくてよかったものだ。root で動くなら overlayfs は普通にマウントできる。Docker が rootless mode をオプション扱いにしているのに対し、Podman は rootless を既定にしたので、**この複雑さを常に抱える**という選択をした。

## どう活かすか

- **機能検出は実際に実行する。** バージョン番号や `uname` での分岐ではなく、やりたい操作そのものを安全な場所で試す。副作用の後始末を `defer` で必ずやることとセットで設計する。
- **テストは本番と同じ場所でやる。** `supportsOverlay` が `$GRAPHROOT` の中に一時ディレクトリを掘るのは、backing filesystem と SELinux コンテキストを本番と揃えるため。`/tmp` でのテストは嘘をつく。
- **検出結果はディスクに残す。** `.has-mount-program` のようなフラグファイルは、次回起動時の高速化だけでなく「前回と今回で構成が変わった」ことの検出にも効く。
- **設定を勝手に変えるなら、警告と恒久的な直し方をセットで出す。** `force_mask` の強制は動作を変える判断だが、なぜそうしたかと、どう設定すれば警告が消えるかを同時に伝えている。
