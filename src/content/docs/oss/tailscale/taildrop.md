---
title: "Taildrop がファイル転送プロトコルを持たない理由"
description: "PUT リクエスト 1 本と .partial のサフィックスだけでファイル転送が成り立つ。中断したら 64 KiB ブロックの SHA-256 を交換して続きから再開する。ファイル名の検証は 6 段階あり、NAS 製品では共有フォルダを 16 個のボリュームから探す。"
group: "その上に載るもの"
sidebar:
  order: 36
---

## 何を学んだか

### PUT 1 本で足りる

Taildrop は「別のデバイスにファイルを送る」機能だ。その実装は、**[peerAPI](../peerapi/) への `PUT /v0/put/<filename>`** だけになっている。

```go
func init() {
	ipnlocal.RegisterPeerAPIHandler("/v0/put/", handlePeerPut)
}
```

**独自のプロトコルも、制御チャネルも、ネゴシエーションもない。**

- 認証 → [peerAPI が済ませている](../peerapi/)
- 暗号化 → WireGuard
- 相手の発見 → [netmap](../netmap/)
- 転送 → HTTP の PUT

残るのは「受け取ったバイト列をどこに保存するか」だけだ。

### 中断と再開

大きなファイルの転送中に接続が切れることがある。Taildrop は **`.partial` のサフィックスを付けたファイル** に書き込み、完了したらリネームする。

再開のときは、

1. 受信側が **64 KiB のブロックごとに SHA-256** を計算して返す
2. 送信側が自分のファイルの同じブロックと比較する
3. **一致しなくなった位置から送り直す**

`Range` ヘッダによる単純なオフセット指定ではなく、**内容の検証を伴う再開**になっている。

### ファイル名の検証が 6 段階

受け取ったファイル名は、そのままファイルシステムに使われる。**攻撃者が `../../etc/passwd` を送れたら終わりだ。**

検証は 6 つある。

1. 妥当な UTF-8 か
2. 前後に空白がないか
3. 255 バイト以下か
4. `path.Clean` した結果が同じか (`.` や `..` を含まない)
5. `.partial` / `.deleted` で終わっていないか
6. 各文字が許可された文字か
7. `filepath.IsLocal` を満たすか

### NAS 製品では共有フォルダを探す

Synology、TrueNAS、QNAP、Unraid では、**「Taildrop」という名前の共有フォルダを探して、そこに保存する**。

Synology では `/volume1` から `/volume16` まで順に見る。

## ソースコードのどこか

### 責務の宣言

```go title="feature/taildrop/doc.go"
// Package taildrop contains the implementation of the Taildrop
// functionality including sending and retrieving files.
// This package does not validate permissions, the caller should
// be responsible for ensuring correct authorization.
package taildrop
```

[`doc.go`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/doc.go)。

**「このパッケージは権限を検証しない。呼び出し側が正しい認可を保証する責任を負う。」**

責務の境界を、パッケージのドキュメントの 2 行目に書いている。**ファイルの読み書きと、認可の判断を分離する。**

認可は peerAPI のハンドラ側で行われる。

```go title="feature/taildrop/peerapi.go"
// canPutFile reports whether h can put a file ("Taildrop") to this node.
func canPutFile(h ipnlocal.PeerAPIHandler) bool {
	if h.Peer().UnsignedPeerAPIOnly() {
		// Unsigned peers can't send files.
		return false
	}
	return h.IsSelfUntagged() || h.PeerCaps().HasCapability(peercap.FileSharingSend)
}
```

[`peerapi.go#L30-L37`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/peerapi.go#L30-L37)。

**認可の条件が 3 行で書かれている。**

- **[tailnet lock](../tailnet-lock/) で署名されていないピアは送れない**
- **同じユーザーのタグなしノード** ([peerAPI の `IsSelfUntagged`](../peerapi/))、または
- **ACL で `FileSharingSend` の capability を持つ**

「自分の他のデバイス」か「ACL で明示的に許可されたピア」だけが送れる。

### 部分ファイルのサフィックス

```go title="feature/taildrop/taildrop.go"
const (
	// partialSuffix is the suffix appended to files while they're
	// still in the process of being transferred.
	partialSuffix = ".partial"

	// deletedSuffix is the suffix for a deleted marker file
	// that's placed next to a file (without the suffix) that we
	// tried to delete, but Windows wouldn't let us. These are
	// only written on Windows (and in tests), but they're not
	// permitted to be uploaded directly on any platform, like
	// partial files.
	deletedSuffix = ".deleted"
)
```

[`taildrop.go#L17-L29`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/taildrop.go#L17-L29)。

**`.deleted` は Windows のための仕組みだ。** 開いているファイルを削除できないので、**「消したいが消せなかった」という印を隣に置く**。後で再試行する。

そして **「Windows でしか書かれないが、どのプラットフォームでもアップロードは許可しない」**。Windows で作られたマーカーを、他のプラットフォームから送り込めてはいけない。

**プラットフォーム固有の回避策が、全プラットフォームの検証ルールに影響している。**

### クライアントごとの部分ファイル

```go title="feature/taildrop/taildrop.go"
// clientID is an opaque identifier for file resumption.
// A client can only list and resume partial files for its own ID.
// It must contain any filesystem specific characters (e.g., slashes).
type clientID string // e.g., "n12345CNTRL"

func (id clientID) partialSuffix() string {
	if id == "" {
		return partialSuffix
	}
	...
}
```

[`taildrop.go#L31-L40`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/taildrop.go#L31-L40)。

**部分ファイルの名前に、送信元ノードの ID が入る。** `report.pdf.n12345CNTRL.partial` のような形になる。

これで **「クライアントは自分の部分ファイルしか列挙・再開できない」** ことが保証される。同じ名前のファイルを 2 つのノードが同時に送っても、混ざらない。

**識別子をファイル名に埋め込むだけで、アクセス制御が成立している。** 別途テーブルを持つ必要がない。

### ファイル名の検証

```go title="feature/taildrop/taildrop.go"
func validateBaseName(name string) error {
	if !utf8.ValidString(name) ||
		strings.TrimSpace(name) != name ||
		len(name) > 255 {
		return ErrInvalidFileName
	}
	// TODO: validate unicode normalization form too? Varies by platform.
	clean := path.Clean(name)
	if clean != name || clean == "." || clean == ".." {
		return ErrInvalidFileName
	}
	if isPartialOrDeleted(name) {
		return ErrInvalidFileName
	}
	for _, r := range name {
		if !validFilenameRune(r) {
			return ErrInvalidFileName
		}
	}
	if !filepath.IsLocal(name) {
		return ErrInvalidFileName
	}
	return nil
}
```

[`taildrop.go#L154-L177`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/taildrop.go#L154-L177)。

**`path.Clean(name) != name` が、パストラバーサルの防御の中心だ。**

- `../etc/passwd` → `Clean` すると `../etc/passwd` のままだが、`IsLocal` が false
- `foo/../bar` → `Clean` すると `bar` になるので、元と違う → 拒否
- `./foo` → `Clean` すると `foo` → 拒否

**「正規化した結果が元と同じ」を要求すると、あらゆる迂回表現が弾かれる。** 個別のパターンを列挙するより確実だ。

`filepath.IsLocal` は Go 1.20 で追加された関数で、**「このパスは現在のディレクトリの外に出ないか」** を OS ごとの規則で判定する。Windows では `C:foo`、`\\server\share`、`CON`、`NUL` などの特殊な形も弾く。

**TODO も正直だ。** 「Unicode の正規化形も検証すべきか? プラットフォームによって異なる」。macOS は NFD、Linux はそのまま、Windows は NFC 寄り。**同じ名前が違うバイト列になる問題を認識しつつ、まだ解いていない。**

### 中断への備え

```go title="feature/taildrop/send.go"
	// Create (if not already) the partial file with read-write permissions.
	partialName := baseName + id.partialSuffix()
	wc, partialPath, err := m.opts.fileOps.OpenWriter(partialName, offset, 0o666)
	if err != nil {
		return 0, m.redactAndLogError("Create", err)
	}
	defer func() {
		wc.Close()
		if err != nil {
			m.deleter.Insert(partialName) // mark partial file for eventual deletion
		}
	}()
```

[`send.go#L91-L102`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/send.go#L91-L102)。

**失敗したら「削除予定」に登録する。** その場で削除しない。

理由は、**送信側が再開してくるかもしれない** からだ。すぐ消すと、再開のときに最初から送り直しになる。一定時間 (`delete.go` が管理) 経ってから消す。

**「失敗 = 即座に片付ける」ではなく、「失敗 = 再試行の余地を残しつつ、いずれ片付ける」。**

### ブロック単位のチェックサム

```go title="feature/taildrop/resume.go"
var (
	blockSize     = int64(64 << 10)
	hashAlgorithm = "sha256"
)

// blockChecksum represents the checksum for a single block.
type blockChecksum struct {
	Checksum  checksum `json:"checksum"`
	Algorithm string   `json:"algo"` // always "sha256" for now
	Size      int64    `json:"size"` // always (64<<10) for now
}
```

[`resume.go#L9-L20`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/resume.go#L9-L20)。

**`Algorithm` と `Size` が JSON に含まれる。** 現時点では常に `"sha256"` と `65536` だが、**将来変えられるようにフィールドとして持つ**。

コメントが `always "sha256" for now` と書いているので、**受信側が値を確認すべき** であることも分かる。

```go title="feature/taildrop/resume.go"
// HashPartialFile returns a function that hashes the next block in the file,
// starting from the beginning of the file.
// It returns (BlockChecksum{}, io.EOF) when the stream is complete.
// It is the caller's responsibility to call close.
func (m *manager) HashPartialFile(id clientID, baseName string) (next func() (blockChecksum, error), close func() error, err error) {
```

[`resume.go#L64-L69`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/resume.go#L64-L69)。

**イテレータを関数のペアとして返す。** `next` を呼ぶたびに次のブロックのハッシュが返り、終わったら `io.EOF`。

ファイル全体のハッシュを一度に計算せず、**必要な分だけ計算する**。送信側は「先頭から順に照合して、最初に一致しなくなった位置」を知りたいので、全部を計算する必要がない。

### NAS のフォルダを探す

```go title="feature/taildrop/paths.go"
func (e *Extension) setPlatformDefaultDirectFileRoot() {
	dg := distro.Get()

	switch dg {
	case distro.Synology, distro.TrueNAS, distro.QNAP, distro.Unraid:
		// See if they have a "Taildrop" share.
		// See https://github.com/tailscale/tailscale/issues/2179#issuecomment-982821319
		path, err := findTaildropDir(dg)
```

```go title="feature/taildrop/paths.go"
// findSynologyTaildropDir looks for the first volume containing a
// "Taildrop" directory.  We'd run "synoshare --get Taildrop" command
// but on DSM7 at least, we lack permissions to run that.
func findSynologyTaildropDir(name string) (dir string, err error) {
	for i := 1; i <= 16; i++ {
		dir = fmt.Sprintf("/volume%v/%s", i, name)
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			return dir, nil
		}
	}
	return "", fmt.Errorf("shared folder %q not found", name)
}
```

[`paths.go#L23-L66`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/paths.go#L23-L66)。

**「本来は `synoshare --get Taildrop` を実行したいが、少なくとも DSM7 ではそれを実行する権限がない」。**

だから **`/volume1` から `/volume16` まで総当たりする**。上限 16 に根拠はないが、実用上十分だろうという判断だ。

**「正しい API があるが使えないので、総当たりする」** という妥協が、理由とともに書かれている。書かないと、後から「API を使うべきでは」と直されて壊れる。

そして **ユーザーが「Taildrop」という名前の共有フォルダを作るだけで設定が完了する** という UX になっている。設定ファイルもコマンドも要らない。

### プラットフォーム抽象

```go title="feature/taildrop/paths.go"
// SetFileOps sets the platform specific file operations. This is used
// to call Android's Storage Access Framework APIs.
func (e *Extension) SetFileOps(fileOps FileOps) {
	e.fileOps = fileOps
}
```

[`paths.go#L19-L22`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/taildrop/paths.go#L19-L22)。

**Android では、通常のファイル API が使えない。** Storage Access Framework という独自の仕組みを通す必要がある。

そこで **ファイル操作をインターフェース (`FileOps`) にして、プラットフォーム側から注入する**。Go のコードは `OpenWriter`、`ListFiles`、`Rename` を呼ぶだけで、その先が POSIX か SAF かを知らない。

## なぜそうなっているか

### なぜ独自プロトコルを作らないのか

ファイル転送プロトコルを設計するなら、

- 転送の開始・進捗・完了の通知
- 中断と再開
- チェックサムの検証
- 同名ファイルの扱い

を決める必要がある。だが **HTTP の PUT が、その大半をすでに持っている**。

- **メソッドとパス** — `PUT /v0/put/<name>`
- **本体** — ファイルの中身
- **`Content-Length`** — サイズ
- **`Range`** — 部分的な転送
- **ステータスコード** — 結果

そして **[peerAPI](../peerapi/) が既に認証・暗号化・ルーティングを提供している**。

**残るのは「保存先」と「再開のためのハッシュ交換」だけ。** これが `feature/taildrop` の 8 KB のコードだ。

### なぜオフセットではなくハッシュで再開するのか

単純な再開は「N バイト目から送って」だ。だがこれには前提がある — **受信側の N バイトが、送信側の N バイトと同じ内容であること**。

これが崩れる場合がある。

- **転送中にファイルが変更された** (送信側でファイルを編集した)
- **別のノードが同名のファイルを送っていた**
- **前回の転送が別のファイルだった** (同名だが違う内容)

オフセットだけで再開すると、**前半と後半が違うファイルの、壊れたファイルができる**。

ブロックごとのハッシュを照合すれば、**一致する範囲だけを再利用し、そこから送り直す**。rsync と同じ考え方だ。

### なぜ検証を 6 段階も行うのか

ファイル名は **完全に攻撃者の制御下にある入力** で、しかも **ファイルシステムに直接渡される**。

そして「安全なファイル名」の定義がプラットフォームごとに違う。

- **Linux**: `/` と NUL 以外は何でも使える
- **Windows**: `\ / : * ? " < > |` が禁止、`CON`/`PRN`/`AUX`/`NUL` などの予約名、末尾のドットとスペースが問題
- **macOS**: `:` が問題 (Finder の表示で `/` に変換される)

**1 つの検証で全部をカバーできない。** だから、

- **形式の検証** (UTF-8、長さ、空白)
- **正規化の検証** (`path.Clean` との一致)
- **文字の検証** (許可された文字か)
- **プラットフォーム固有の検証** (`filepath.IsLocal`)

を重ねる。**どれか 1 つが破られても、他が止める。**

### なぜ「削除予定」にするのか

失敗した部分ファイルをすぐ消すと、**再開のたびに最初から送り直し** になる。ネットワークが不安定な環境では、永久に完了しない。

一方、残し続けるとディスクを食う。**放置された部分ファイルが溜まる。**

だから **「削除予定」に登録して、一定時間後に消す**。その間に再開されれば、削除は取り消される (`m.deleter.Remove(baseName)`)。

**「即座に片付ける」と「永久に残す」の中間として、遅延削除を置く。** キャッシュの eviction、一時ファイルの掃除、[DERP のセグメント削除](../derp/) と同じ形だ。

### なぜアルゴリズム名を JSON に含めるのか

現時点で SHA-256 以外を使う予定はない。フィールドは常に `"sha256"` だ。

だが **後から変えるとき、フィールドがないと変えられない**。「バージョン 2 からは BLAKE3」とすると、バージョンの管理が必要になる。

フィールドがあれば、**送信側が `"blake3"` を送り、受信側が知らなければエラーにする** だけで済む。古いクライアントは「知らないアルゴリズム」として拒否し、再開せずに最初から送る。

**拡張の余地を 1 フィールドで確保しておくコストは小さい。** そして「now は常にこの値」とコメントに書けば、実装の単純さも保てる。

### なぜファイル操作をインターフェースにするのか

Android の Storage Access Framework は、**ファイルパスという概念がない**。ユーザーが選んだディレクトリへの「URI」と、それを通じた読み書きの API がある。

`os.Open(path)` を呼ぶコードは、Android では動かない。

**インターフェースにすれば、Go のコードは「書き込み先を開く」「一覧する」「リネームする」という抽象操作だけを行う。** その実体が POSIX のファイルか、SAF の URI かを知らなくてよい。

**「ファイルパス」という一見普遍的な概念が、実は普遍的でない** — モバイルプラットフォームを扱うときの典型的な発見だ。

## どう活かすか

**既存のプロトコルで足りるなら、独自プロトコルを作らない。** ファイル転送、RPC、通知。HTTP のメソッド・ヘッダ・ステータスコードは、たいていの要求を満たす。**残るのはドメイン固有の部分だけ** になり、実装が桁で小さくなる。

**責務の境界をパッケージのドキュメントに書く。** 「このパッケージは権限を検証しない」— この 1 行があれば、認可の実装漏れが「誰の責任か」で迷わない。

**外部から来る名前をファイルシステムに渡す前に、複数の観点で検証する。** 形式、正規化 (`Clean` した結果が同じか)、文字種、プラットフォーム固有の規則。**個別の攻撃パターンを列挙するのではなく、「正規形と一致するか」を要求する**ほうが確実だ。

**再開可能な転送では、オフセットだけでなく内容を検証する。** 「N バイト目から」は、受信側の N バイトが正しい前提に立つ。ブロックごとのハッシュを照合すれば、その前提が要らなくなる。

**失敗したリソースは「削除予定」にして、遅延して消す。** 即座に消すと再試行のコストが上がり、残し続けると溜まる。取り消し可能な削除予約が中間解になる。

**識別子をファイル名やキーに埋め込むと、アクセス制御が構造から出る。** 「自分の ID のサフィックスを持つファイルだけ列挙できる」なら、別途テーブルを持たなくてよい。

**将来変わりうる定数は、値としてプロトコルに載せる。** アルゴリズム名、ブロックサイズ、バージョン。「今は常にこの値」とコメントしつつフィールドを用意しておけば、変更時に交渉の仕組みを作らずに済む。

**「ファイルパス」が使えないプラットフォームがある。** モバイル、サンドボックス、権限の制限。ファイル操作をインターフェースにしておくと、そういう環境への移植が注入で済む。
