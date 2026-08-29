---
title: "標準入出力・attach・ログ"
description: "コンテナの stdout を読んでいるのは Podman ではなく conmon だ。conmon はログを k8s-file 形式で追記するか journald に送り、attach したいプロセスには unix socket (SOCK_SEQPACKET) で 1 バイトのストリーム識別子付きに多重化して流す。ソケットのパスが 108 バイト制限を超えるため、O_PATH で開いて /proc/self/fd 経由で接続するという回避まで入っている。"
group: "コンテナを作って動かす"
sidebar:
  order: 18
---

## 何を学んだか

### stdout を読んでいるのは conmon

コンテナのプロセスの stdout/stderr は、pty または pipe で **conmon** に繋がっている。Podman プロセスは繋がっていない。だから `podman run -d` で Podman が終了しても、出力は失われない。

conmon がやることは 2 つ。

1. **ログドライバに書く** — ファイルに追記するか、journald に送るか、捨てるか
2. **attach ソケットに流す** — 誰かが接続していれば、そこにも同じデータを送る

Docker では dockerd がこの役目を担う。全コンテナの stdout を 1 つのデーモンが読み続けるので、デーモンが詰まると全部が詰まる。conmon はコンテナごとに独立しているので、その相互干渉がない。

### ログドライバは 5 種類

| ドライバ      | 動作                                                               |
| ------------- | ------------------------------------------------------------------ |
| `k8s-file`    | ファイルに 1 行 1 レコードのテキストで追記 (既定)                  |
| `journald`    | systemd の journal に送る                                          |
| `json-file`   | Docker 互換の名前。実体は `k8s-file` にマップされる                |
| `none`        | 捨てる                                                             |
| `passthrough` | conmon が中継せず、コンテナの stdio を直接 conmon の親から継承する |

`passthrough` は systemd と組み合わせるためのものだ。コンテナの出力を conmon が受け取らず、systemd の unit の stdio にそのまま流れる。**ログの二重管理を避ける** ための仕組みで、Quadlet と相性がよい。

`json-file` という名前が受け付けられるのに実体が `k8s-file` なのは、Docker 互換のためだ。フォーマットは違うが、名前だけ受け入れて既定の形式にマップしている。

### k8s-file の形式

1 行がそのままレコードで、スペース区切りの 4 フィールド。

```
2026-08-29T12:34:56.123456789+09:00 stdout F hello world
```

| フィールド | 意味                                                         |
| ---------- | ------------------------------------------------------------ |
| 1          | タイムスタンプ (RFC3339Nano、末尾ゼロを保つ独自フォーマット) |
| 2          | `stdout` または `stderr`                                     |
| 3          | `F` (行が完結) または `P` (バッファを溢れた続きがある)       |
| 4 以降     | 本文                                                         |

Kubernetes の CRI が定めるログ形式と同じなので、`kube play` で動かしたコンテナのログを Kubernetes のツールで読める。**Docker の JSON 1 行方式より軽く、tail しやすい**。

### attach は SOCK_SEQPACKET の unix socket

`podman attach` や `podman run` のフォアグラウンド実行では、bundle ディレクトリの `attach` という unix socket に接続する。プロトコルは単純で、**各メッセージの先頭 1 バイトがストリーム番号** (stdin/stdout/stderr)、残りがデータ。

ソケットの型は `unixpacket` (`SOCK_SEQPACKET`) で、これがポイントになる。ストリーム型 (`SOCK_STREAM`) だとメッセージの境界が消えるので、先頭 1 バイトの識別子方式が壊れる。**メッセージ境界を保つ型を選ぶことで、長さヘッダが不要になっている**。

## ソースコードのどこか

### バッファサイズが conmon の定数と手動で揃えてある

[`libpod/oci_conmon_common.go#L44-L50`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L44)。

```go title="libpod/oci_conmon_common.go"
const (
	// This is Conmon's STDIO_BUF_SIZE. I don't believe we have access to it
	// directly from the Go code, so const it here
	// Important: The conmon attach socket uses an extra byte at the beginning of each
	// message to specify the STREAM so we have to increase the buffer size by one
	conmonAttachBufferSize = 8193
)
```

8192 + 1。「conmon の `STDIO_BUF_SIZE` だが Go から直接参照できないのでここに定数として置く」。**別リポジトリの C のマクロと、Go の定数が手で同期されている**。

こういう「言語を跨いだ暗黙の契約」は、外部バイナリと組む設計では避けにくい。せめてコメントで由来と根拠 (+1 の理由) を残す、というのが現実的な妥協になっている。

### ソケットパスの 108 バイト制限を回避する

[`libpod/oci_conmon_attach_linux.go#L12`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_attach_linux.go#L12)。

```go title="libpod/oci_conmon_attach_linux.go"
func openUnixSocket(path string) (*net.UnixConn, error) {
	fd, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	return net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: fmt.Sprintf("/proc/self/fd/%d", fd), Net: "unixpacket"})
}
```

7 行だが、やっていることは巧妙だ。

unix socket のアドレス構造体 `sockaddr_un.sun_path` は **108 バイトしかない**。attach ソケットのパスは bundle ディレクトリの下 (`/var/lib/containers/storage/overlay-containers/<64 文字の ID>/userdata/attach`) なので、graphroot が深いと簡単に超える。

そこで、

1. `O_PATH` でパスを開く (ファイルを開くのではなく、パスへの参照だけを得る)
2. 得られた fd を `/proc/self/fd/<N>` という **短いパス** として使う
3. そのパスで `DialUnix` する

`/proc/self/fd/12` なら 16 バイト程度。**長いパスの問題を、fd という間接参照で解く**。前に見た overlayfs の `l/` シンボリックリンクと発想が同じで、「OS の長さ制限には短い別名で対抗する」というパターンになっている。

### attach は passthrough なら何もしない

[`libpod/oci_conmon_attach_common.go#L35`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_attach_common.go#L35)。

```go title="libpod/oci_conmon_attach_common.go"
func (r *ConmonOCIRuntime) Attach(c *Container, params *AttachOptions) error {
	passthrough := c.LogDriver() == define.PassthroughLogging || c.LogDriver() == define.PassthroughTTYLogging

	if params == nil || params.Streams == nil {
		return fmt.Errorf("must provide parameters to Attach: %w", define.ErrInternal)
	}

	if !params.Streams.AttachOutput && !params.Streams.AttachError && !params.Streams.AttachInput && !passthrough {
		return fmt.Errorf("must provide at least one stream to attach to: %w", define.ErrInvalidArg)
	}
	...
	var conn *net.UnixConn
	if !passthrough {
		logrus.Debugf("Attaching to container %s", c.ID())
		...
		attachSock, err := c.AttachSocketPath()
```

`passthrough` の場合は **ソケットに接続すらしない**。コンテナの stdio は既に呼び出し元のプロセスに繋がっているからだ。「ストリームが 1 つも指定されていない」というエラーチェックも passthrough では免除される。

デタッチキー (既定は `ctrl-p,ctrl-q`) の処理も同じ関数にある。

```go title="libpod/oci_conmon_attach_common.go"
	keys := config.DefaultDetachKeys
	if params.DetachKeys != nil {
		keys = *params.DetachKeys
	}

	detachKeys, err := processDetachKeys(keys)
```

**Podman プロセス側が stdin を監視して、デタッチキーが来たら接続を切る**。conmon 側にはデタッチという概念がなく、単に接続が切れるだけ。プロトコルを増やさずに機能を実現している。

### ソケットの場所は bundle の中

[`libpod/oci_conmon_common.go#L835`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L835)。

```go title="libpod/oci_conmon_common.go"
func (r *ConmonOCIRuntime) AttachSocketPath(ctr *Container) (string, error) {
	if ctr == nil {
		return "", fmt.Errorf("must provide a valid container to get attach socket path: %w", define.ErrInvalidArg)
	}

	return filepath.Join(ctr.bundlePath(), "attach"), nil
}
```

`bundlePath()/attach`。**パスの規約がそのまま API になっている**。どのプロセスからでもこのパスを計算できるので、`podman attach` を別のターミナルから実行できる。exit ファイル、pid ファイルも同じ形で、Podman の「通信路がファイルシステム」という方針が徹底されている。

### ログ行のパースは 15 行

[`libpod/logs/log.go#L226`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/logs/log.go#L226)。

```go title="libpod/logs/log.go"
func NewLogLine(line string) (*LogLine, error) {
	splitLine := strings.Split(line, " ")
	if len(splitLine) < 4 {
		return nil, fmt.Errorf("'%s' is not a valid container log line", line)
	}
	logTime, err := time.Parse(LogTimeFormat, splitLine[0])
	if err != nil {
		return nil, fmt.Errorf("unable to convert time %s from container log: %w", splitLine[0], err)
	}
	l := LogLine{
		Time:         logTime,
		Device:       splitLine[1],
		ParseLogType: splitLine[2],
		Msg:          strings.Join(splitLine[3:], " "),
	}
	return &l, nil
}
```

`strings.Split` して 4 番目以降を結合し直すだけ。JSON より速く、部分的に壊れた行があっても他の行は読める。**append-only なログに JSON を使わない** という判断は、tail する用途では合理的だ。

時刻フォーマットの定義にも一言ある。

```go title="libpod/logs/log.go"
	// LogTimeFormat is the time format used in the log.
	// It is a modified version of RFC3339Nano that guarantees trailing
	// zeroes are not trimmed, taken from
	// https://github.com/golang/go/issues/19635
	LogTimeFormat = "2006-01-02T15:04:05.000000000Z07:00"
```

Go の `time.RFC3339Nano` は末尾のゼロを削るので、タイムスタンプの **文字数が可変になる**。ログを文字列として比較・ソートする場面で困るため、固定長になるフォーマットを自前で定義している。issue 番号まで書いてあるので、なぜ標準の定数を使わないかが後から分かる。

`P` / `F` の区別も実用的だ。

```go title="libpod/logs/log.go"
	// PartialLogType signifies a log line that exceeded the buffer
	// length and needed to spill into a new line
	PartialLogType = "P"

	// FullLogType signifies a log line is full
	FullLogType = "F"
```

conmon のバッファ (8192 バイト) を超えた行は複数レコードに分割される。読む側は `P` を見て改行を入れずに繋げる。

```go title="libpod/logs/log.go"
	case "stdout":
		if stdout != nil {
			if l.Partial() {
				fmt.Fprint(stdout, l.String(logOpts))
			} else {
				fmt.Fprintln(stdout, l.String(logOpts))
			}
		}
```

`Fprint` と `Fprintln` の使い分けだけで、分割された行が正しく復元される。

## なぜそうなっているか

### コンテナごとに読み手を分けたのは、独立性のため

デーモンが全コンテナの stdout を読む構造だと、1 つのコンテナが大量に出力したときに他が影響を受ける。ディスクが詰まればデーモンがブロックし、全体が止まる。

conmon はコンテナ 1 つに 1 プロセスなので、**障害の影響がそのコンテナに閉じる**。メモリ使用量も 1 コンテナあたり数 MB で済む。「小さなプロセスをたくさん」という選択が、独立性を買っている。

### テキスト形式にしたのは、追記と tail のため

ログは「大量に追記され、末尾から読まれる」という偏った使われ方をする。JSON は構造化できるがパースが重く、部分的に壊れると復旧が難しい。

スペース区切りの固定フィールドなら、`tail -f` でも読めるし、`grep` も効く。**フォーマットの選択が、想定する読み方から逆算されている**。

### fd 経由の接続は、パス長制限への一般解

`sun_path` の 108 バイト制限は、コンテナのように「深いディレクトリに一意な ID でファイルを作る」設計と根本的に相性が悪い。ID を短くすれば衝突が増え、ディレクトリを浅くすれば整理がつかない。

`O_PATH` + `/proc/self/fd/N` は、この種の制限に対する **汎用の回避策** だ。同じ手は `execveat` や、長いパスへの `bind` でも使える。Linux で長いパスに悩んだら思い出す価値がある。

## どう活かすか

- **メッセージ境界が意味を持つなら、`SOCK_SEQPACKET` を使う。** 長さヘッダを自前で付ける前に、境界を保つソケット型があることを思い出す。プロトコルが 1 バイト分で済む。
- **追記されるログはテキストの固定フィールドにする。** 構造化したくなるが、tail・grep・部分的な破損への強さを失う。構造が必要なら別途インデックスを作る方が筋がよい。
- **標準ライブラリの定数を使わない理由は、issue 番号ごと書く。** `LogTimeFormat` のコメントは、次に読む人が「なぜ `time.RFC3339Nano` じゃないのか」で止まらないようにしている。
- **OS の長さ制限には fd による間接参照。** `O_PATH` して `/proc/self/fd/N` を使う手は、unix socket に限らず効く。
- **言語を跨いだ定数の同期は、コメントで由来と根拠を残す。** 消せない依存なら、せめて「どこの何と揃えているか」「なぜ +1 か」を書いておく。
