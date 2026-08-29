---
title: "pull を外部バイナリで止める — image verifier"
description: "ディレクトリに実行ファイルを置くだけで、pull の前に検査を挟める。containerd はイメージ名と digest を引数で、descriptor を stdin で渡し、終了コード 0 以外なら pull を拒否する。プラグイン機構ではなく「バイナリを exec する」ことで、署名検証の実装を本体から完全に切り離している。"
group: "イメージを取り込む"
sidebar:
  order: 32
---

## 何を学んだか

### 契約は「引数と終了コード」だけ

image verifier の API は驚くほど単純だ。

```
verifier -name <image ref> -digest <sha256:...> -stdin-media-type application/vnd.oci.descriptor.v1+json
```

- **stdin** — OCI descriptor の JSON
- **stdout** — 判定の理由 (人間向けの文字列)
- **終了コード** — 0 なら許可、それ以外は拒否

これだけ。gRPC も protobuf も要らない。シェルスクリプトでも書ける。

### 置く場所はディレクトリ

```toml
[plugins."io.containerd.image-verifier.v1.bindir"]
  bin_dir = "/opt/containerd/image-verifier/bin"
  max_verifiers = 10
  per_verifier_timeout = "10s"
```

`bin_dir` に置かれたファイルが全部 verifier として扱われる。全員が 0 を返したときだけ pull が通る (AND 結合)。

### 検査は「解決の直後、取得の前」

pull の流れの中で、verifier が呼ばれる位置が重要だ。

```
Resolve (タグ → digest) → 【verifier】 → Fetch (blob の取得) → unpack
```

digest が確定した後、**1 バイトもダウンロードする前** に検査する。拒否されればネットワーク帯域もディスクも消費しない。

### 落ちたら止める

ディレクトリがない、ファイルが 0 個 → 全部許可 (fail-open)。
verifier の実行に失敗、タイムアウト → **pull を拒否** (fail-close)。

「設定されていない」と「設定されているが動かない」で挙動が逆になる。

## ソースコードのどこか

### インターフェースは 1 メソッド

[`pkg/imageverifier/image_verifier.go#L23-L32`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/imageverifier/image_verifier.go#L23-L32)。

```go title="pkg/imageverifier/image_verifier.go"
type ImageVerifier interface {
	VerifyImage(ctx context.Context, name string, desc ocispec.Descriptor) (*Judgement, error)
}

type Judgement struct {
	OK     bool
	Reason string
}
```

`Judgement` に `Reason` があるのが効いている。拒否したときに **なぜ拒否したかが利用者に返る**。

### pull 経路での呼び出し

[`core/transfer/local/pull.go#L60-L93`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/transfer/local/pull.go#L60-L93)。

```go title="core/transfer/local/pull.go"
	name, desc, err := ir.Resolve(ctx)
	...
	// Verify image before pulling.
	for vfName, vf := range ts.config.Verifiers {
		...
		jdg, err := vf.VerifyImage(ctx, name, desc)
		if err != nil {
			logger.WithError(err).Error("No judgement received from verifier")
			return fmt.Errorf("blocking pull of %v with digest %v: image verifier %v returned error: %w", name, desc.Digest.String(), vfName, err)
		}
		...
		if !jdg.OK {
			logger.Warn("Image verifier blocked pull")
			return fmt.Errorf("image verifier %s blocked pull of %v with digest %v for reason: %v", vfName, name, desc.Digest.String(), jdg.Reason)
		}
```

`Resolve` の直後、`Fetcher` を作る前。エラーメッセージに **イメージ名・digest・verifier 名・理由** が全部入る。運用で「なぜ pull が失敗したか」を追えるようにするための情報量だ。

verifier がエラーを返した (判定できなかった) 場合も pull を止める。「検査できないものは通さない」。

### ディレクトリの走査と判定の結合

[`pkg/imageverifier/bindir/bindir.go#L58-L111`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/imageverifier/bindir/bindir.go#L58-L111)。

```go title="pkg/imageverifier/bindir/bindir.go"
func (v *ImageVerifier) VerifyImage(ctx context.Context, name string, desc ocispec.Descriptor) (*imageverifier.Judgement, error) {
	// os.ReadDir sorts entries by name.
	entries, err := os.ReadDir(v.config.BinDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &imageverifier.Judgement{
				OK:     true,
				Reason: fmt.Sprintf("image verifier directory %v does not exist", v.config.BinDir),
			}, nil
		}
```

ディレクトリがなければ「理由付きで許可」を返す。**判定を返さない (nil) のではなく、明示的に OK を返す** ので、ログに理由が残る。

```go title="pkg/imageverifier/bindir/bindir.go"
	for i, entry := range entries {
		if (i+1) > v.config.MaxVerifiers && v.config.MaxVerifiers >= 0 {
			log.G(ctx).Warnf("image verifiers are being skipped since directory %v has %v entries, more than configured max of %v verifiers", v.config.BinDir, len(entries), v.config.MaxVerifiers)
			break
		}
```

上限を超えた分は **スキップして警告**。エラーにしないのは、ディレクトリに想定外のファイルが混入したときに pull が全部止まるのを避けるためだろう。ただしスキップされた verifier の検査は行われないので、警告が出ていたら設定を見直す必要がある。

拒否は即座に返る。

```go title="pkg/imageverifier/bindir/bindir.go"
		if exitCode != 0 {
			return &imageverifier.Judgement{
				OK:     false,
				Reason: fmt.Sprintf("verifier %v rejected image (exit code %v): %v", bin, exitCode, vr),
			}, nil
		}
```

1 つでも拒否したら残りは実行しない。

### 外部プロセスの扱いが丁寧

[`pkg/imageverifier/bindir/bindir.go#L113-L200`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/imageverifier/bindir/bindir.go#L113-L200) の `runVerifier` が、この機能で最も注意深く書かれている部分だ。

```go title="pkg/imageverifier/bindir/bindir.go"
	// We construct our own pipes instead of using the default StdinPipe,
	// StoutPipe, and StderrPipe in order to set timeouts on reads and writes.
	stdinRead, stdinWrite, err := os.Pipe()
```

`exec.Cmd` の標準のパイプではなく、自分で `os.Pipe` を作る。**読み書きにデッドラインを設定するため** だ。

```go title="pkg/imageverifier/bindir/bindir.go"
	// Close parent ends of pipes on timeout. Without this, I/O may hang in the
	// parent process.
	if d, ok := ctx.Deadline(); ok {
		stdinWrite.SetDeadline(d)
		stdoutRead.SetDeadline(d)
		stderrRead.SetDeadline(d)
	}
```

タイムアウトでプロセスを殺しても、**パイプの読み書きが親側でハングする** ことがある。デッドラインを設定してこれを防ぐ。

stdin への書き込みも非同期にしている。

```go title="pkg/imageverifier/bindir/bindir.go"
	// Write the descriptor to stdin.
	go func() {
		// Descriptors are usually small enough to fit in a pipe buffer (which is
		// often 64 KiB on Linux) so this write usually won't block on the child
		// process reading stdin. However, synchronously writing to stdin may cause
		// the parent to block if the descriptor is larger than the pipe buffer and
		// the child process doesn't read stdin. Therefore, we write to stdin
		// asynchronously, limited by the stdinWrite deadline set above.
		err := json.NewEncoder(stdinWrite).Encode(desc)
```

descriptor は通常小さくパイプバッファに収まるが、**大きい場合に子が stdin を読まないと親がブロックする**。goroutine に逃がしてデッドラインで守る。

「普通は問題ないが、稀に詰まる」ケースへの対処がコメント付きで書かれている。外部プロセスを起動するコードで最も間違えやすい部分に、正しく手当てがされている。

stderr は行単位で debug ログに流され、`io.LimitedReader` で切り詰められる。**verifier が大量に出力しても containerd のログを埋め尽くさない**。

### 契約が文書化されている

[`docs/image-verification.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/image-verification.md) の "Image Verifier Caller Contract" が、境界の約束を列挙している。

```markdown title="docs/image-verification.md"
- If `bin_dir` does not exist or contains no files, the image verifier does not block image pulls.
- An image is pulled only if all verifiers that are called return an "ok" judgement (exit with status code 0). In other words, image pull judgements are combined with an `AND` operator.
- If any verifiers exceeds the `per_verifier_timeout` or fails to exec, the verification fails with an error and a `nil` judgement is returned.
  ...
- There is no guarantee for the order of execution of verifier binaries.
- Standard error output of verifier binaries is logged at debug level by containerd, subject to truncation.
- System resources used by verifier binaries are currently accounted for in and constrained by containerd's own cgroup, but this is subject to change.
```

最後の 2 行が誠実だ。「stdout/stderr は切り詰められる」「verifier のリソースは containerd の cgroup に計上される (将来変わるかもしれない)」。**実装の現状と、当てにしてはいけない部分** が書かれている。

## なぜそうなっているか

### 署名検証を本体に入れない

イメージ署名の方式は複数ある (Notary v2、cosign、独自の PKI)。どれかを containerd に入れると、

- 暗号ライブラリと鍵管理の責務が containerd に来る
- 方式が変わるたびに containerd の更新が要る
- 方式を選べない

外部バイナリにすれば、containerd は「実行して終了コードを見る」だけになる。これは [SCOPE.md](../scope-and-principles/) の「代替実装は本体に入れない」方針の適用でもある。

### プラグイン機構ではなくバイナリ実行

containerd には proxy plugin (gRPC 越しの外部プロセス) もあるのに、なぜ verifier は素朴な exec なのか。

- **書くのが簡単** — gRPC サーバを実装する必要がない。シェルスクリプトでも動く
- **常駐しなくてよい** — pull は頻繁ではないので、常駐プロセスのコストが割に合わない
- **障害の影響が小さい** — 落ちたプロセスは次回の exec で作り直される

呼び出し頻度が低く、状態を持たない拡張点では、**プロセス起動のコストより実装の容易さが勝つ**。

### 検査を Resolve の直後に置く

digest が確定していないと検査できない (タグは可変なので、`nginx:latest` に対する判定は意味がない)。かつ、blob を取得する前でないと帯域が無駄になる。

この 2 つの制約から、位置は「Resolve の後、Fetch の前」に一意に決まる。

## どう活かすか

### 最小の verifier を書く

```sh
#!/bin/sh
# /opt/containerd/image-verifier/bin/allow-internal-registry
while [ $# -gt 0 ]; do
  case "$1" in
    -name) NAME="$2"; shift 2 ;;
    -digest) DIGEST="$2"; shift 2 ;;
    *) shift ;;
  esac
done

case "$NAME" in
  registry.corp.internal/*)
    echo "internal registry"; exit 0 ;;
  *)
    echo "only internal registry is allowed"; exit 1 ;;
esac
```

これを `bin_dir` に置いて実行権限を付ければ、社内レジストリ以外からの pull が止まる。cosign の検証を呼ぶラッパも同じ形で書ける。

**設定を変えた後に containerd の再起動は不要** (ディレクトリは pull のたびに読まれる) だが、`bin_dir` の設定自体を変える場合は再起動が要る。

### 検査の効果を確認する

```sh
$ ctr images pull docker.io/library/nginx:latest
ctr: image verifier allow-internal-registry blocked pull of docker.io/library/nginx:latest with digest sha256:... for reason: only internal registry is allowed
```

拒否の理由がそのままエラーに出る。verifier の stderr は containerd の debug ログに出るので、デバッグ時はログレベルを上げる。

### 「外部バイナリを拡張点にする」設計

この形が向くのは次の条件のときだ。

- **呼び出し頻度が低い** — 起動コストが問題にならない
- **状態を持たない** — 毎回新しいプロセスでよい
- **実装の多様性がある** — 誰がどう実装するか分からない
- **失敗時の扱いを決められる** — fail-open か fail-close かが明確

実装するときは、containerd の `runVerifier` が対処している 3 点を必ず押さえる。

- **タイムアウトを設定し、パイプにもデッドラインを設定する** — プロセスを殺しても I/O が残る
- **stdin への書き込みを非同期にする** — 子が読まないとブロックする
- **子の出力を切り詰める** — ログを埋め尽くされない

どれも「普段は起きないが、悪意ある/壊れた実装で起きる」問題への対処になっている。
