---
title: "コンテナの stdio を fifo で受け渡す"
description: "コンテナの標準入出力は、containerd の中を通らない。shim が fifo・ファイル・外部バイナリのいずれかへ直接コピーする。fifo を読み書き両方で開く、stdout と stderr が同じファイルなら Close を数える、といった細かい配慮が積み重なっている。"
group: "shim の中身"
sidebar:
  order: 52
---

## 何を学んだか

### 宛先は URI で指定される

`CreateTaskRequest` の `stdout` / `stderr` フィールドは、単なるパスではなく URI として解釈される。

| スキーム                     | 宛先                                             |
| ---------------------------- | ------------------------------------------------ |
| `fifo://` (既定)             | 名前付きパイプ。クライアント (`ctr`、CRI) が読む |
| `file://`                    | ファイルに追記する                               |
| `binary://` / `binary-v2://` | **外部バイナリを起動して stdio を渡す**          |
| (空)                         | `/dev/null`                                      |

スキームがなければ `fifo` とみなされる。containerd 本体は [ログの永続化をスコープ外にしている](../scope-and-principles/) ので、この選択が唯一の出口になる。

### fifo は読み書き両方で開く

fifo の書き込み側だけを開くと、読み手がいない間 `open` がブロックする。逆に読み手が去ると書き込みが `EPIPE` になる。

shim は **同じ fifo を w/o と r/o の両方で開く**。自分が読み手も兼ねることで、

- クライアントがまだ繋いでいなくても `open` が返る
- クライアントが切断しても `SIGPIPE` でコンテナが死なない

### stdout と stderr が同じファイルのとき

`file://` で stdout と stderr に同じパスを指定すると、同じ `*os.File` を 2 つの goroutine が共有する。片方が終わって `Close` すると、もう片方が書けなくなる。

そこで `countingWriteCloser` という、**Close を数える** ラッパを噛ませる。2 回閉じられて初めて実際に閉じる。

### バッファは 4096 バイト固定

コピー用のバッファが `sync.Pool` で管理され、サイズは 4096。コメントに「`PIPE_BUF` に合わせるため」と書かれている。

## ソースコードのどこか

### URI によるディスパッチ

[`cmd/containerd-shim-runc-v2/process/io.go#L73-L131`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/process/io.go#L73-L131)。

```go title="cmd/containerd-shim-runc-v2/process/io.go"
	if stdio.IsNull() {
		i, err := runc.NewNullIO()
		if err != nil {
			return nil, err
		}
		pio.io = i
		return pio, nil
	}
	u, err := url.Parse(stdio.Stdout)
	if err != nil {
		return nil, fmt.Errorf("unable to parse stdout uri: %w", err)
	}
	if u.Scheme == "" {
		u.Scheme = "fifo"
	}
	pio.uri = u
	switch u.Scheme {
	case "fifo":
		pio.copy = true
		pio.io, err = runc.NewPipeIO(ioUID, ioGID, withConditionalIO(stdio))
	case "binary", "binary-v2":
		pio.io, err = NewBinaryIO(ctx, id, u)
	case "file":
```

**スキームが空ならデフォルトを補う**。既存のクライアントは生のパスを渡してくるので、それを fifo として扱う後方互換になっている。

`copy = true` は fifo と file のときだけ。binary の場合、runc が直接そのバイナリのパイプに書くので shim はコピーしない。

`binary-v2` は準備完了の通知方法が違う版だ ([`docs/runtime-v2.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/runtime-v2.md))。

```markdown title="docs/runtime-v2.md"
The legacy `binary://` scheme treats EOF on `CONTAINER_WAIT` as ready for backward compatibility.
The `binary-v2://` scheme requires the logging binary to write a byte to `CONTAINER_WAIT` and then close it.
```

古い方は「EOF を準備完了とみなす」ので、**バイナリが異常終了しても準備完了と誤認する**。新しい方は明示的に 1 バイト書かせる。互換のためにスキーム名を分けている。

### fifo を両方向で開く

[`cmd/containerd-shim-runc-v2/process/io.go#L180-L209`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/process/io.go#L180-L209)。

```go title="cmd/containerd-shim-runc-v2/process/io.go"
		ok, err := fifo.IsFifo(i.name)
		...
		if ok {
			if fw, err = fifo.OpenFifo(ctx, i.name, syscall.O_WRONLY, 0); err != nil {
				return fmt.Errorf("containerd-shim: opening w/o fifo %q failed: %w", i.name, err)
			}
			if fr, err = fifo.OpenFifo(ctx, i.name, syscall.O_RDONLY, 0); err != nil {
				return fmt.Errorf("containerd-shim: opening r/o fifo %q failed: %w", i.name, err)
			}
		}
```

書き込み用と読み取り用の 2 つの fd を開く。読み取り側 (`fr`) は **一切読まない**。開いておくだけだ。

これは fifo の性質を利用したイディオムで、「読み手が 1 つ以上いる」状態を維持することで、書き込みが `EPIPE` にならないようにしている。クライアントが `ctr attach` を抜けても、コンテナは書き続けられる。

コピーの goroutine が終わるときに、両方を閉じる。

```go title="cmd/containerd-shim-runc-v2/process/io.go"
					wg.Done()
					wc.Close()
					if rc != nil {
						rc.Close()
					}
```

### 2 つの WaitGroup

```go title="cmd/containerd-shim-runc-v2/process/io.go"
			dest: func(wc io.WriteCloser, rc io.Closer) {
				wg.Add(1)
				cwg.Add(1)
				go func() {
					cwg.Done()
					p := bufPool.Get().(*[]byte)
					defer bufPool.Put(p)
					if _, err := io.CopyBuffer(wc, rio.Stdout(), *p); err != nil {
						log.G(ctx).Warn("error copying stdout")
					}
					wg.Done()
```

`cwg` は **goroutine が起動したこと** を待つためのもので、goroutine の先頭で `Done` する。`Copy` の呼び出し元は `cwg.Wait()` で「コピーが始まった」ことを確認してから戻る。

`wg` は **コピーが完了すること** を待つためのもので、プロセス終了時に stdio を出し切るために使われる。

2 つの WaitGroup で、起動の同期と完了の同期を分けている。これがないと、「コンテナが即座に終了して、まだコピーが始まっていない」というレースが起きる。

### 同じファイルへの二重書き

[`cmd/containerd-shim-runc-v2/process/io.go#L195-L207`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/process/io.go#L195-L207)。

```go title="cmd/containerd-shim-runc-v2/process/io.go"
		} else {
			if sameFile != nil {
				sameFile.bumpCount(1)
				i.dest(sameFile, nil)
				continue
			}
			if fw, err = os.OpenFile(i.name, syscall.O_WRONLY|syscall.O_APPEND, 0); err != nil {
				return fmt.Errorf("containerd-shim: opening file %q failed: %w", i.name, err)
			}
			if stdout == stderr {
				sameFile = newCountingWriteCloser(fw, 1)
			}
		}
```

stdout と stderr が同じパスなら、**1 つの fd を共有して参照カウントを増やす**。`O_APPEND` で開いているので、2 つの goroutine が同時に書いても行が混ざらない (書き込みがアトミックな範囲では)。

```go title="cmd/containerd-shim-runc-v2/process/io.go"
// countingWriteCloser masks io.Closer() until close has been invoked a certain number of times.
type countingWriteCloser struct {
	io.WriteCloser
	count atomic.Int64
}

func (c *countingWriteCloser) Close() error {
	if c.bumpCount(-1) > 0 {
		return nil
	}
	return c.WriteCloser.Close()
}
```

**参照カウント付きの Closer**。20 行に満たない実装で、「複数の利用者が同じリソースを閉じる」問題を解いている。

### stdin は片方向

```go title="cmd/containerd-shim-runc-v2/process/io.go"
	if stdin == "" {
		return nil
	}
	f, err := fifo.OpenFifo(context.Background(), stdin, syscall.O_RDONLY|syscall.O_NONBLOCK, 0)
	...
	go func() {
		cwg.Done()
		p := bufPool.Get().(*[]byte)
		defer bufPool.Put(p)

		io.CopyBuffer(rio.Stdin(), f, *p)
		rio.Stdin().Close()
		f.Close()
	}()
```

stdin は `O_RDONLY | O_NONBLOCK` で開く。**書き手がいなくてもブロックしない**。

`context.Background()` を使っているのが目を引く。stdin の fifo を開く操作は、呼び出し元のコンテキストがキャンセルされても続けたい、ということだろう。

エラーを無視しているのも意図的で、stdin のコピーが失敗してもコンテナは動き続けるべきだ。

`wg` に登録していない (`cwg` のみ) のも重要で、**stdin のコピー完了は待たない**。コンテナが終了しても、stdin を読み続けている goroutine が残る可能性がある。

### バッファのサイズ

```go title="cmd/containerd-shim-runc-v2/process/io.go"
var bufPool = sync.Pool{
	New: func() any {
		// setting to 4096 to align with PIPE_BUF
		// http://man7.org/linux/man-pages/man7/pipe.7.html
		buffer := make([]byte, 4096)
		return &buffer
	},
}
```

`PIPE_BUF` (Linux では 4096) は「このサイズ以下の write はアトミック」という保証の境界だ。それに合わせることで、**複数の書き手がいても行が混ざりにくくなる**。

`sync.Pool` で使い回すので、コンテナが多くてもアロケーションが増えない。

### ログドライバのタイムアウト

```go title="cmd/containerd-shim-runc-v2/process/io.go"
const binaryIOProcTermTimeout = 12 * time.Second // Give logger process solid 10 seconds for cleanup
```

`binary://` のログバイナリを終了させるときの猶予。コメントが「10 秒の掃除時間を確実に与えるため」と説明していて、**12 秒という値の内訳** (10 秒 + 余裕 2 秒) が分かる。

## なぜそうなっているか

### containerd を通さないことがスコープの帰結

[`SCOPE.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/SCOPE.md) の logging = out の理由に、「containerd の中に STDIO のコピーは存在しない」と明記されている。

コンテナの出力が containerd を経由すると、

- containerd の再起動でログが途切れる
- containerd の負荷がコンテナの出力量に比例する
- ログの宛先を containerd が知る必要がある

shim が直接コピーすれば、これらが全部なくなる。**containerd はパスと URI を渡すだけ**。

### fifo を読み手として開いておく

コンテナのログを誰も読んでいない状態は普通にある (`ctr run -d` の後、`ctr attach` していない)。そのとき fifo に書けなくなると、コンテナが `SIGPIPE` で死ぬ。

shim が読み手を兼ねることで、この問題が消える。**読まないが開いておく** という、一見無駄に見える fd がその役割を果たしている。

`ctr attach` は別途 fifo を開いて読むので、shim と競合しそうに見えるが、shim 側は読んでいないので実際には全部クライアントが受け取る。

### 起動の同期と完了の同期を分ける

コピーの goroutine は 2 つのタイミングで待たれる。

- **起動時** — `Create` が返る前に、コピーが始まっていることを保証する
- **終了時** — プロセスが終了した後、出力を出し切ってから片付ける

1 つの WaitGroup では両方を表現できない。2 つに分けるのは素直な解だが、`cwg.Done()` を goroutine の先頭に置く書き方は慣れないと読みにくい。

## どう活かすか

### ログの宛先を変える

```sh
# ファイルに直接書く
$ ctr run --log-uri file:///var/log/mycontainer.log ...

# 外部バイナリに渡す
$ ctr run --log-uri binary:///usr/local/bin/my-logger ...
```

CRI 経由では、CRI プラグインが `file://` を指定してログファイルに書かせる。kubelet が読むのはそのファイルだ。

### fifo が詰まっているとき

コンテナが出力で止まっているように見える場合、

```sh
# fifo の場所
$ ls -l /run/containerd/io.containerd.runtime.v2.task/<ns>/<id>/

# shim がその fifo を開いているか
$ ls -l /proc/<shim-pid>/fd/ | grep fifo
```

shim が読み手として開いていれば、詰まりは shim より下流 (コピー先のファイル、ログバイナリ) にある。

### stdio を中継するコードを書くとき

- **fifo は読み書き両方で開く** — 相手の不在でブロックや EPIPE を起こさない
- **複数の書き手が同じ宛先を持つなら、Close を数える** — 早すぎる Close を防ぐ
- **バッファは PIPE_BUF に合わせる** — 行の混ざりを減らす
- **起動の同期と完了の同期を分ける** — 別の WaitGroup を使う
- **stdin のコピー完了は待たない** — 書き手が来ないまま残ることがある

最後の点は特に重要で、stdin を `wg` に含めると「クライアントが繋いでこないので終了できない」という固まり方をする。**方向によって扱いを変える** 必要がある。
