---
title: "ファイルのハッシュは「tar にしたときの姿」で取る"
description: "contenthash は os.FileInfo を直接ハッシュしない。いったん tar.Header に詰め、Docker 由来の tarsum v1 形式でフィールドを並べてからハッシュする。mtime とファイル名が意図的に落ちること、xattr が選別されること、そしてソース自身が「この形式を使い続ける技術的理由はない」と書いていることまで読む。"
group: "contenthash — COPY のキャッシュ"
sidebar:
  order: 49
---

## 何を学んだか

`COPY` のキャッシュキーに入るファイル 1 個ぶんのダイジェストは、こうやって作られる。

1. `os.FileInfo` (またはクライアントから届いた `fstypes.Stat`) を `tar.Header` に変換する。
2. ヘッダのフィールドを **tarsum v1 の順で `名前 + 値` の文字列として** ハッシュに流す。
3. 通常ファイルなら、その後にファイル本体のバイト列を流す。

ここで落ちるものが 2 つある。**mtime** と **ファイル名**だ。どちらも意図的で、片方は「触っただけでキャッシュが外れる」のを防ぐため、もう片方は名前を親ディレクトリ側のハッシュに移したためだ。

そして、この形式が tar なのは技術的な必然ではない。ソースにそう書いてある。

## 入口は 2 つ、出口は 1 つ

ディスクを走査するときは `NewFileHash`、転送されてきたファイルをその場でハッシュするときは `NewFromStat` が使われる ([増分更新](../contenthash-incremental/))。前者は後者を呼ぶだけなので、実質 1 本だ。

```go title="cache/contenthash/filehash.go"
// NewFileHash returns new hash that is used for the builder cache keys
func NewFileHash(path string, fi os.FileInfo) (hash.Hash, error) {
	var link string
	if fi.Mode()&os.ModeSymlink != 0 {
		var err error
		link, err = os.Readlink(path)
		if err != nil {
			return nil, err
		}
	}

	stat := &fstypes.Stat{
		Mode:     uint32(fi.Mode()),
		Size:     fi.Size(),
		ModTime:  fi.ModTime().UnixNano(),
		Linkname: link,
	}

	if fi.Mode()&os.ModeSymlink != 0 {
		stat.Mode = stat.Mode | 0777
	}

	if err := setUnixOpt(path, fi, stat); err != nil {
		return nil, err
	}
	return NewFromStat(stat)
}
```

([cache/contenthash/filehash.go L16-L42](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/filehash.go#L16-L42))

`os.FileInfo` から直接取れない情報は `setUnixOpt` が `syscall.Stat_t` から補う。uid/gid、キャラクタ・ブロックデバイスの major/minor、そして xattr の全列挙だ。

```go title="cache/contenthash/filehash_unix.go"
	attrs, err := sysx.LListxattr(path)
	if err != nil {
		return err
	}
	if len(attrs) > 0 {
		stat.Xattrs = map[string][]byte{}
		for _, attr := range attrs {
			v, err := sysx.LGetxattr(path, attr)
			if err == nil {
				stat.Xattrs[attr] = v
			}
		}
	}
```

([cache/contenthash/filehash_unix.go L29-L41](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/filehash_unix.go#L29-L41))

「入口が 2 つで出口が 1 つ」であることは、そのまま正しさの条件になっている。`local` ソースは転送中に `NewFromStat` でダイジェストを作り、後からディスクを走査し直すときは `NewFileHash` を使う。この 2 つが同じ値を出さなければ、同じファイルなのにキャッシュが外れる。

## tar.Header に詰め直す

`NewFromStat` が核だ。

```go title="cache/contenthash/filehash.go"
func NewFromStat(stat *fstypes.Stat) (hash.Hash, error) {
	// Clear the socket and irregular bits since archive/tar.FileInfoHeader does not handle them
	stat.Mode &^= uint32(os.ModeSocket | os.ModeIrregular)

	fi := &statInfo{stat}
	hdr, err := tar.FileInfoHeader(fi, stat.Linkname)
	if err != nil {
		return nil, errors.Wrapf(err, "failed to checksum file %s", stat.Path)
	}
	hdr.Name = "" // note: empty name is different from current has in docker build. Name is added on recursive directory scan instead
	hdr.Devmajor = stat.Devmajor
	hdr.Devminor = stat.Devminor
	hdr.Uid = int(stat.Uid)
	hdr.Gid = int(stat.Gid)

	if len(stat.Xattrs) > 0 {
		hdr.PAXRecords = make(map[string]string, len(stat.Xattrs))
		for k, v := range stat.Xattrs {
			hdr.PAXRecords["SCHILY.xattr."+k] = string(v)
		}
	}
	// fmt.Printf("hdr: %#v\n", hdr)
	h := cachedigest.NewHash(cachedigest.TypeFile)
	tsh := &tarsumHash{hdr: hdr, Hash: h}
	tsh.Reset() // initialize header
	return tsh, nil
}
```

([filehash.go L44-L70](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/filehash.go#L44-L70))

クリア・固定されているものを 1 つずつ。

- **socket / irregular ビットを落とす。** コメントどおり `archive/tar.FileInfoHeader` がこの 2 つを扱えず、エラーを返してしまうため。
- **`hdr.Name = ""`。** ファイル名はこのハッシュに入らない。コメントが「Docker のビルドとは違う、名前は再帰的なディレクトリ走査のほうで足される」と言っている。実際、ディレクトリのダイジェストを作る `checksum` の側でキーが先に書き込まれている ([checksum.go L910-L920](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/checksum.go#L910-L920))。名前と内容の責務が分かれているので、**中身の同じファイルは名前が違っても同じダイジェスト**になる。ハードリンクの通知でリンク元のレコードをそのまま複製できるのは、これが成り立っているからだ。
- **uid / gid / devmajor / devminor を上書きする。** `tar.FileInfoHeader` はこれらを `fi.Sys()` が `*syscall.Stat_t` を返す場合にしか埋めない。ここで渡している `statInfo` の `Sys()` は `*fstypes.Stat` を返すので、標準ライブラリ側の経路は働かない。だから手で入れ直す。
- **シンボリックリンクには 0777 を立てる。** 理由はコメントされていない。結果として、リンクのパーミッションビットは環境によらず同じ値になる。
- **xattr は `SCHILY.xattr.` 接頭辞つきの PAX レコードにする。** これは GNU tar / star が xattr を tar に載せるときの実際の表現だ。

`statInfo` は `fstypes.Stat` を `os.FileInfo` に見せるだけのアダプタで、`ModTime` はナノ秒を秒とナノ秒に割り戻す ([filehash.go L97-L123](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/filehash.go#L97-L123))。

## tarsum v1 — mtime を落とす

ヘッダをバイト列にするのは `tarsum.go` だ。

```go title="cache/contenthash/tarsum.go"
// WriteV1TarsumHeaders writes a tar header to a writer in V1 tarsum format.
func WriteV1TarsumHeaders(h *tar.Header, w io.Writer) {
	for _, elem := range v1TarHeaderSelect(h) {
		w.Write([]byte(elem[0] + elem[1]))
	}
}
```

([cache/contenthash/tarsum.go L11-L16](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/tarsum.go#L11-L16))

`名前 + 値` を区切りなしで連結していく。フィールドの一覧と順序は v0 が持っている。

```go title="cache/contenthash/tarsum.go"
func v0TarHeaderSelect(h *tar.Header) (orderedHeaders [][2]string) {
	return [][2]string{
		{"name", h.Name},
		{"mode", strconv.FormatInt(h.Mode, 10)},
		{"uid", strconv.Itoa(h.Uid)},
		{"gid", strconv.Itoa(h.Gid)},
		{"size", strconv.FormatInt(h.Size, 10)},
		{"mtime", strconv.FormatInt(h.ModTime.UTC().Unix(), 10)},
		{"typeflag", string([]byte{h.Typeflag})},
		{"linkname", h.Linkname},
		{"uname", h.Uname},
		{"gname", h.Gname},
		{"devmajor", strconv.FormatInt(h.Devmajor, 10)},
		{"devminor", strconv.FormatInt(h.Devminor, 10)},
	}
}
```

([tarsum.go L21-L36](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/tarsum.go#L21-L36))

v1 との差はここに凝縮している。

```go title="cache/contenthash/tarsum.go"
	// Copy all headers from v0 excluding the 'mtime' header (the 5th element).
	v0headers := v0TarHeaderSelect(h)
	orderedHeaders = append(orderedHeaders, v0headers[0:5]...)
	orderedHeaders = append(orderedHeaders, v0headers[6:]...)
```

([tarsum.go L64-L67](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/tarsum.go#L64-L67))

インデックス 5 が `mtime` で、それだけがスキップされる。**`touch file` してもキャッシュは外れない。** `git clone` や `tar -x` はファイルの mtime を展開時刻にするので、mtime を含めていたら CI で `COPY` のキャッシュが毎回外れることになる。落とすべき情報が 1 つあり、それを落とすためだけに v1 が定義されている、と読める。

なお `name` は残っているが、`NewFromStat` が `hdr.Name = ""` にしているので実際には空文字が流れるだけになる。

### xattr は選別される

xattr は v1 の追加分で、末尾にソートして付く。

```go title="cache/contenthash/tarsum.go"
	xAttrKeys := make([]string, 0, len(h.PAXRecords))
	for k := range pax {
		if k, ok := strings.CutPrefix(k, "SCHILY.xattr."); ok {
			if k == "security.capability" || !strings.HasPrefix(k, "security.") && !strings.HasPrefix(k, "system.") {
				xAttrKeys = append(xAttrKeys, k)
			}
		}
	}
	slices.Sort(xAttrKeys)
```

([tarsum.go L49-L58](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/tarsum.go#L49-L58))

- `system.*` は全部落ちる。POSIX ACL (`system.posix_acl_access`) や overlayfs の内部属性がここに入るので、ファイルシステムの都合がダイジェストに漏れない。
- `security.*` も落ちるが、`security.capability` だけは残る。file capability はコンテナの実行時挙動を変える (`setcap` された `ping` バイナリなど) ので、内容の一部として扱う必要がある。
- 残りのユーザ定義 xattr (`user.*` など) は全部入る。
- `slices.Sort` は必須だ。map の反復順は Go では非決定的なので、ソートしなければ同じファイルから実行ごとに違うダイジェストが出る ([決定的な marshal](../deterministic-marshal/))。

## ファイル本体が入る経路

`tarsumHash` はヘッダを書き込み済みのハッシュとして返る。ファイル本体はその後ろに追記される。

```go title="cache/contenthash/filehash.go"
// Reset resets the Hash to its initial state.
func (tsh *tarsumHash) Reset() {
	// comply with hash.Hash and reset to the state hash had before any writes
	tsh.Hash.Reset()
	WriteV1TarsumHeaders(tsh.hdr, tsh.Hash)
}

func (tsh *tarsumHash) Write(p []byte) (n int, err error) {
	n, err = tsh.WriteNoDebug(p)
	if n > 0 {
		tsh.hdr.Size += int64(n)
	}
	return n, err
}
```

([filehash.go L77-L90](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/filehash.go#L77-L90))

「初期状態」がヘッダ書き込み済みの状態として再定義されているので、`hash.Hash` として素直に使える。本体を流すのは 2 経路ある。

**ディスク走査の経路**は `prepareDigest` だ。

```go title="cache/contenthash/checksum.go"
func prepareDigest(fp, p string, fi os.FileInfo) (digest.Digest, error) {
	h, err := NewFileHash(fp, fi)
	if err != nil {
		return "", errors.Wrapf(err, "failed to create hash for %s", p)
	}
	if fi.Mode().IsRegular() && fi.Size() > 0 {
		// TODO: would be nice to put the contents to separate hash first
		// so it can be cached for hardlinks
		f, err := os.Open(fp)
		if err != nil {
			return "", errors.Wrapf(err, "failed to open %s", p)
		}
		defer f.Close()
		if _, err := poolsCopy(h, f); err != nil {
			return "", errors.Wrapf(err, "failed to copy file data for %s", p)
		}
	}
	return digest.NewDigest(digest.SHA256, h), nil
}
```

([checksum.go L1225-L1243](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/checksum.go#L1225-L1243))

本体を読むのは**通常ファイルでサイズが 0 より大きいときだけ**。ディレクトリ・シンボリックリンク・デバイスファイルはヘッダだけでダイジェストが決まる。シンボリックリンクの「中身」は `linkname` としてヘッダに入っているので、これで足りている。

**転送の経路**は fsutil の `hashedWriter` で、ディスクに書くのと同じバイト列が `io.MultiWriter` でハッシュにも流れる。どちらの経路でも「ヘッダ → 本体」の順序と内容は同じになる。

`Sum` は `hash.Hash` のインターフェースに合わせるための薄いラッパで、`cachedigest.Hash` が返す digest 文字列を生バイトに戻している ([filehash.go L92-L95](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/filehash.go#L92-L95))。引数の `b` は使っておらず、`hash.Hash` の「`b` に追記して返す」規約からは外れている。この型が `digest.NewDigest` 経由でしか使われないので成立している。

### デバッグ用のフレームは本体を記録しない

`cachedigest.NewHash(cachedigest.TypeFile)` は、ハッシュに流したバイト列をデバッグ用に別途保存できる型だ ([互換性と cachedigest](../compat-and-cachedigest/))。

```go title="util/cachedigest/digest.go"
func (h *Hash) Write(p []byte) (n int, err error) {
	n, err = h.h.Write(p)
	if n > 0 && h.db != nil {
		h.frames = append(h.frames, Frame{ID: FrameIDData, Data: bytes.Clone(p[:n])})
	}
	return n, err
}

func (h *Hash) WriteNoDebug(p []byte) (n int, err error) {
	n, err = h.h.Write(p)
	if n > 0 && h.db != nil {
		// ... 直前のフレームが Skip なら長さを足すだけ
```

([util/cachedigest/digest.go L57-L79](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/cachedigest/digest.go#L57-L79))

`tarsumHash.Reset` が呼ぶ `WriteV1TarsumHeaders` は `Write` を通るのでヘッダは丸ごと記録され、`tarsumHash.Write` は `WriteNoDebug` を呼ぶので**ファイル本体はバイト数だけ**が残る。「なぜこのキャッシュが外れたか」を後から追うのに必要なのはヘッダのほうで、本体をデバッグ DB に写すと容量が破綻する。この使い分けが 1 行の呼び分けで表現されている。

## なぜそうなっているか

「tar にしてからハッシュする」筋は通っている。`COPY` の結果は最終的にイメージレイヤ、つまり tar アーカイブになる。ハッシュ対象を tar のヘッダフィールドに揃えておけば、**「ダイジェストが同じ」と「同じレイヤになる」がずれない**。逆に `os.FileInfo` を素直にハッシュすると、tar に落とすときに捨てられる情報 (socket ビット、ナノ秒 mtime、プラットフォーム固有のフラグ) までキャッシュキーに混ざり、レイヤが同じなのにキャッシュが外れる。

ただし、この形式でなければならない理由はない。ソース自身がそう書いている。

```go title="cache/contenthash/tarsum.go"
// Functions below are from docker legacy tarsum implementation.
// There is no valid technical reason to continue using them.
```

([tarsum.go L18-L19](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/tarsum.go#L18-L19))

コメントが言うとおり tarsum は Docker の古い実装から持ち込んだもので、フィールド名と値を区切りなしで連結するだけの素朴な形式だ。それでも残っているのは、計算式を変えた瞬間に既存のキャッシュエントリが全部無効になるからだろう。**キャッシュキーの計算式は、一度出荷したら実質的に凍結される。** ソースがそれを認めたうえで、コメント 1 行で「これは負債であって設計ではない」と印を付けているのが正直なところだ。

テストがダイジェストの定数を直書きしているのも、この凍結を明示している。

```go title="cache/contenthash/checksum_test.go"
	// for the digest values, the actual values are not important in development
	// phase but consistency is
```

([cache/contenthash/checksum_test.go L1020-L1021](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/checksum_test.go#L1020-L1021))

## どう活かすか

- **キャッシュキーは「最終成果物の表現」に合わせる。** 中間の内部表現ではなく、出力の形 (ここでは tar) に正規化してからハッシュを取る。そうしないと「成果物は同じなのにキーが違う」が起き、キャッシュヒット率が静かに落ちる。
- **時刻はキーに入れない。** mtime はコピー・チェックアウト・展開で簡単に変わるうえ、成果物には影響しないことが多い。「内容が同じなら同じキー」を守りたいなら、時刻は明示的に除外する。除外したことをコード上で 1 箇所に見えるようにしておく (`v0headers[0:5]` + `v0headers[6:]` のように)。
- **名前と内容を別のハッシュに分ける。** ファイル自身のダイジェストに名前を入れず、親のリストハッシュ側で名前を書く。こうすると内容の同じファイルのダイジェストを共有でき、ハードリンクやリネームの扱いが単純になる。
- **環境依存の属性はホワイトリストで選ぶ。** xattr を全部入れると、ファイルシステムや ACL の都合でキーが揺れる。`system.*` を落とし `security.capability` だけ残す、のように「成果物の挙動を変えるものだけ」を明示的に選ぶ。
- **凍結された形式には、凍結されている旨をコメントで残す。** 「技術的な理由はない」と書いておけば、次に読む人が改良しようとして既存キャッシュを全部壊す事故を防げる。負債は隠すより、印を付けて置くほうが安い。
