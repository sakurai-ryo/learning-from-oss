---
title: "content store: digest がそのままファイル名になる"
description: "blob の置き場は blobs/sha256/<hex> という 1 段のディレクトリで、ファイル名が中身のハッシュそのものだ。メタデータ (サイズ、作成時刻、ラベル) は bbolt 側にあり、実体はファイルシステムにある。この分担のおかげで、読み出しは open(2) 一発、共有は自動、検証は書き込み時の 1 回で済む。"
group: "メタデータとストア"
sidebar:
  order: 16
---

## 何を学んだか

### 置き場の構造は素朴そのもの

```
/var/lib/containerd/io.containerd.content.v1.content/
├── blobs/
│   └── sha256/
│       ├── 0a1b2c...    ← blob の実体。ファイル名 = digest の hex
│       └── 3d4e5f...
└── ingest/
    └── <ref の digest>/   ← 書き込み途中のもの
        ├── data
        ├── ref
        ├── startedat
        ├── updatedat
        └── total
```

blob は **サブディレクトリで分割すらしない**。1 ディレクトリに数千のファイルが並ぶ。ハッシュの先頭 2 文字でディレクトリを切る (git のような) 構造を採っていない。

### インターフェースは 4 つに分かれている

`content.Store` は 4 つのインターフェースの合成で、ライフサイクルの段階ごとに分かれている。

| インターフェース | 役割                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `Ingester`       | 書き込みを開始する (`Writer`)                                    |
| `IngestManager`  | 書き込み中のものを管理する (`Status` / `ListStatuses` / `Abort`) |
| `Provider`       | 完了した blob を読む (`ReaderAt`)                                |
| `Manager`        | 完了した blob を管理する (`Info` / `Update` / `Walk` / `Delete`) |

重要なのは境界だ。**書き込み中の blob は `Provider` からも `Manager` からも見えない**。完了した blob は `IngestManager` から見えない。「途中のもの」と「確定したもの」が別世界になっている。

### 読み出しは ReaderAt

`Provider` が返すのは `io.Reader` ではなく `ReaderAt` — つまり **オフセット指定でランダムアクセスできる** ハンドルだ。`Size()` も持つ。

これが効くのは、tar の途中だけを読む、複数のゴルーチンから並列に読む、といった場面だ。ローカルの content store では単なる `*os.File` のラッパになる。

### digest を知っていても namespace になければ読めない

ファイル名が digest なので、ファイルシステム上は誰でも読める。しかし API 経由では、**自分の namespace にその blob の参照があるか** を先に確認する。

## ソースコードのどこか

### Store インターフェースのライフサイクル説明

[`core/content/content.go#L28-L47`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/content/content.go#L28-L47)。

```go title="core/content/content.go"
// Store combines the methods of content-oriented interfaces into a set that
// are commonly provided by complete implementations.
//
// Overall content lifecycle:
//   - Ingester is used to initiate a write operation (aka ingestion)
//   - IngestManager is used to manage (e.g. list, abort) active ingestions
//   - Once an ingestion is complete (see Writer.Commit), Provider is used to
//     query a single piece of content by its digest
//   - Manager is used to manage (e.g. list, delete) previously committed content
//
// Note that until ingestion is complete, its content is not visible through
// Provider or Manager. Once ingestion is complete, it is no longer exposed
// through IngestManager.
type Store interface {
	Manager
	Provider
	IngestManager
	Ingester
}
```

インターフェースのドキュメントに **状態遷移が書かれている**。「完了するまで Provider からは見えない」「完了したら IngestManager からは見えない」という排他性が、型ではなく契約として明記されている。

`Provider` の doc も具体的だ。

```go title="core/content/content.go"
// Provider provides a reader interface for specific content
type Provider interface {
	// ReaderAt only requires desc.Digest to be set.
	// Other fields in the descriptor may be used internally for resolving
	// the location of the actual data.
	ReaderAt(ctx context.Context, desc ocispec.Descriptor) (ReaderAt, error)
}
```

「digest だけ設定されていればよい。他のフィールドは実装が内部で使ってよい」。ローカルストアは digest しか見ないが、リモートやプロキシの実装は mediaType や annotations を使って場所を解決できる、という含みがある。

### パスの計算

[`plugins/content/local/store.go#L646-L660`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/content/local/store.go#L646-L660)。

```go title="plugins/content/local/store.go"
func (s *store) blobPath(dgst digest.Digest) (string, error) {
	if err := dgst.Validate(); err != nil {
		return "", fmt.Errorf("cannot calculate blob path from invalid digest: %v: %w", err, errdefs.ErrInvalidArgument)
	}

	return filepath.Join(s.root, "blobs", dgst.Algorithm().String(), dgst.Encoded()), nil
}
```

`digest.Validate()` を先に呼ぶのが要点だ。digest は外から来た文字列なので、**検証せずにパスに使うとディレクトリトラバーサルになる**。`sha256:../../etc/passwd` のような値を弾く。

アルゴリズム名がディレクトリになっているので、sha256 から sha512 への移行があっても共存できる。

ingest 側は一工夫ある。

```go title="plugins/content/local/store.go"
func (s *store) ingestRoot(ref string) string {
	// we take a digest of the ref to keep the ingest paths constant length.
	// Note that this is not the current or potential digest of incoming content.
	dgst := digest.FromString(ref)
	return filepath.Join(s.root, "ingest", dgst.Encoded())
}
```

ref (`"default/2/layer-sha256:abc..."` のような文字列) をそのままディレクトリ名にすると、長さも文字種も制御できない。**ref のハッシュを取って固定長にする**。コメントで「これは中身の digest ではない」とわざわざ断っている。

### 名前空間の検査は metadata 層が行う

ローカルの store 実装には namespace の概念がない。検査は [`core/metadata/content.go#L736-L756`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/content.go#L736-L756) にある。

```go title="core/metadata/content.go"
func (cs *contentStore) ReaderAt(ctx context.Context, desc ocispec.Descriptor) (content.ReaderAt, error) {
	if err := cs.checkAccess(ctx, desc.Digest); err != nil {
		return nil, err
	}
	return cs.Store.ReaderAt(ctx, desc)
}

func (cs *contentStore) checkAccess(ctx context.Context, dgst digest.Digest) error {
	ns, err := namespaces.NamespaceRequired(ctx)
	if err != nil {
		return err
	}

	return view(ctx, cs.db, func(tx *bolt.Tx) error {
		bkt := getBlobBucket(tx, ns, dgst)
		if bkt == nil {
			return fmt.Errorf("content digest %v: %w", dgst, errdefs.ErrNotFound)
		}
		return nil
	})
}
```

bbolt に「この namespace にこの digest がある」というレコードがあるかを見て、なければ `ErrNotFound` を返す。**存在しないのか、権限がないのかを区別しない** — namespace が違うだけの blob も「ない」と答える。

### 共有ポリシーの実装

namespace を越えた共有は書き込み時に効く ([`core/metadata/content.go#L398-L425`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/content.go#L398-L425))。

```go title="core/metadata/content.go"
			if cs.shared || isSharedContent(tx, wOpts.Desc.Digest) {
				if st, err := cs.Store.Info(ctx, wOpts.Desc.Digest); err == nil {
					// Ensure the expected size is the same, it is likely
					// an error if the size is mismatched but the caller
					// must resolve this on commit
					if wOpts.Desc.Size == 0 || wOpts.Desc.Size == st.Size {
						shared = true
						wOpts.Desc.Size = st.Size
					}
				}
			}
```

`shared` モードでは、他の namespace が既に持っている blob を「ダウンロード済み」として扱える。pull のときに実際の転送が起きない。

`isSharedContent` ([`#L758-L776`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/content.go#L758-L776)) は、namespace のラベルで個別に共有を許す仕組みだ。

```go title="core/metadata/content.go"
	// iterate through each namespace
	v1c := v1bkt.Cursor()
	for nk, _ := v1c.First(); nk != nil; nk, _ = v1c.Next() {
		ns := string(nk)
		lbkt := getNamespaceLabelsBucket(tx, ns)
		if lbkt == nil {
			continue
		}
		if sharedNS := lbkt.Get([]byte(labels.LabelSharedNamespace)); sharedNS != nil && string(sharedNS) == "true" && getBlobBucket(tx, ns, dgst) != nil {
			return true
		}
	}
```

全体を `isolated` にしつつ、特定の namespace だけ「共有元として使ってよい」と印を付けられる。ベースイメージ専用の namespace を作る、といった運用ができる。

### ロックは ref 単位

[`plugins/content/local/store.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/content/local/store.go) の `Writer`。

```go title="plugins/content/local/store.go"
	if err := s.tryLock(wOpts.Ref); err != nil {
		return nil, err
	}

	w, err := s.writer(ctx, wOpts.Ref, wOpts.Desc.Size, wOpts.Desc.Digest)
	if err != nil {
		s.unlock(wOpts.Ref)
		return nil, err
	}

	return w, nil // lock is now held by w.
}
```

プロセス内のロックを ref 単位で取り、**その所有権を Writer に移す**。`// lock is now held by w.` というコメントで所有権の移動を明示している。Go には所有権の概念がないので、コメントで補っている。

## なぜそうなっているか

### メタデータと実体を分ける

blob の実体をファイルシステムに、メタデータ (サイズ、時刻、ラベル) を bbolt に置く分担には理由がある。

- **読み出しが速い** — 数百 MB の layer を DB から読む必要がない。`open` + `mmap` / `read` で済む
- **DB が小さく保てる** — bbolt のファイルサイズがコンテンツ量に比例しない
- **ページキャッシュが効く** — OS のファイルキャッシュがそのまま使える

代わりに「メタデータと実体の整合性」を自分で守る必要がある。containerd はこれを、**メタデータを正とし、実体の孤児は GC で掃除する** 方向で解いている。

### サブディレクトリで分割しない理由

git は `.git/objects/ab/cdef...` のように先頭 2 文字でディレクトリを切る。これは ext2 の時代に「1 ディレクトリのエントリ数が増えると線形探索で遅くなる」問題があったからだ。

現代のファイルシステム (ext4 の htree、XFS、btrfs) はディレクトリ内のハッシュインデックスを持つので、数万エントリでも問題にならない。containerd は分割しないことを選び、パス計算を単純に保っている。

### digest をパスに使う前に必ず検証する

`blobPath` の `dgst.Validate()` は、セキュリティ上の要になる。digest は API 経由で外から来る文字列で、`sha256:` に続く部分がそのままパスの一部になる。

同種の脆弱性はコンテナ関連のツールで繰り返し見つかっている。**外部入力をパスに連結する箇所は必ず検証する**、という原則の実例として読める。

## どう活かすか

### content store を直接見る

```sh
# blob の一覧 (サイズとラベル)
$ ctr -n k8s.io content ls

# 中身を読む
$ ctr -n k8s.io content get sha256:<digest> | head -c 200

# ディスク上の実体
$ ls -l /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/ | head

# 書き込み途中のもの (中断した pull の残骸)
$ ctr -n k8s.io content active
```

`content active` に古いエントリが残っている場合、pull が中断してリースも切れている可能性がある。放置してもリース期限か GC で消えるが、ディスクを圧迫しているときは `ctr content prune` や Abort で掃除できる。

### content-addressable なストアを作るときの要点

- **ファイル名 = ハッシュ、それ以外の情報はメタデータ側に置く**
- **書き込み中と確定を、別の名前空間 (ディレクトリ) に分ける** — 中途半端なファイルが読まれない
- **確定は rename で行う** — 原子的に「見える」状態にする
- **ハッシュをパスに使う前に検証する**
- **読み出しは ReaderAt で返す** — 部分読み出しと並列読み出しの余地を残す

4 つ目と 5 つ目は見落としやすい。特に `ReaderAt` を返すか `Reader` を返すかは、後から変えると影響範囲が広い。
