---
title: "SIGCHLD を 1 か所で受ける reaper"
description: "shim は subreaper なので、あらゆる子孫の終了が SIGCHLD として届く。誰の子が死んだかは分からないので、wait4(-1) で全部回収し、PID をキーに購読者へ配る。1 ミリ秒のタイムアウト付きで全員に届くまで再試行するという、少し変わった配信ループになっている。"
group: "shim の中身"
sidebar:
  order: 49
---

## 何を学んだか

### wait は 1 か所でしかできない

`wait4(-1, ...)` は「どれか 1 つの子が終了するのを待つ」システムコールだ。複数の goroutine から呼ぶと、**どれが受け取るかを制御できない**。runc の終了を待っている goroutine が、コンテナプロセスの終了を回収してしまうかもしれない。

だから shim は、

1. SIGCHLD を 1 か所で受ける
2. `wait4(-1, WNOHANG)` で **回収できるだけ回収する**
3. 結果 (PID と終了ステータス) を購読者に配る
4. 各購読者は自分の PID かどうかを見て判断する

という構造をとる。プロセスの終了を「イベントの配信」に変換している。

### 全部回収してから配る

SIGCHLD は複数の子が同時に終了しても 1 回しか届かないことがある (シグナルは合流する)。だから 1 回のシグナルで **`ECHILD` になるまでループする**。

### 購読者への配信は「全員に届くまで再試行」

配信ループが独特だ。

- 各購読者のチャネルに 1 ミリ秒のタイムアウトで送る
- 送れなかった購読者がいたら、**全体をもう一周する**
- 一度成功した購読者には二度送らない
- 全員に届いたら終わる

購読者のチャネルが詰まっていても、諦めずに配り続ける。**終了イベントを取りこぼすと、待っている側が永久にブロックする** からだ。

### subreaper なので孫も来る

shim は `PR_SET_CHILD_SUBREAPER` を設定している ([なぜ shim という余分なプロセスが挟まっているのか](../why-shim/))。だから `runc create` が去った後のコンテナ init プロセスも、shim の子として扱われる。

## ソースコードのどこか

### シグナルを受けたら全部回収する

[`pkg/sys/reaper/reaper_unix.go#L51-L68`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/sys/reaper/reaper_unix.go#L51-L68)。

```go title="pkg/sys/reaper/reaper_unix.go"
// Reap should be called when the process receives an SIGCHLD.  Reap will reap
// all exited processes and close their wait channels
func Reap() error {
	now := time.Now()
	exits, err := reap(false)
	for _, e := range exits {
		done := Default.notify(runc.Exit{
			Timestamp: now,
			Pid:       e.Pid,
			Status:    e.Status,
		})

		select {
		case <-done:
		case <-time.After(1 * time.Second):
		}
	}
	return err
}
```

配信の完了を待つが、**1 秒でタイムアウトする**。全員に届かなくても次の終了イベントの処理に進む。無限に待つと、1 つの詰まった購読者が全体を止める。

タイムスタンプは **回収時に 1 回だけ取る**。同じシグナルで回収した複数のプロセスに同じ時刻が付く。実際の終了時刻は分からないので、精度を求めていない。

### 回収ループ

[`pkg/sys/reaper/reaper_unix.go#L253-L278`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/sys/reaper/reaper_unix.go#L253-L278)。

```go title="pkg/sys/reaper/reaper_unix.go"
func reap(wait bool) (exits []exit, err error) {
	var (
		ws  unix.WaitStatus
		rus unix.Rusage
	)
	flag := unix.WNOHANG
	if wait {
		flag = 0
	}
	for {
		pid, err := unix.Wait4(-1, &ws, flag, &rus)
		if err != nil {
			if err == unix.ECHILD {
				return exits, nil
			}
			return exits, err
		}
		if pid <= 0 {
			return exits, nil
		}
		exits = append(exits, exit{
			Pid:    pid,
			Status: exitStatus(ws),
		})
	}
}
```

`WNOHANG` で非ブロッキングに回収し、`ECHILD` (子がいない) か `pid <= 0` (回収できる子がもういない) で抜ける。

**`ECHILD` をエラーとして扱わない** のが要点だ。シグナルが届いたときには既に別経路で回収済み、ということがありうる。

### 購読と待ち合わせ

[`pkg/sys/reaper/reaper_unix.go#L82-L128`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/sys/reaper/reaper_unix.go#L82-L128)。

```go title="pkg/sys/reaper/reaper_unix.go"
// Start starts the command and registers the process with the reaper
func (m *Monitor) Start(c *exec.Cmd) (chan runc.Exit, error) {
	ec := m.Subscribe()
	if err := c.Start(); err != nil {
		m.Unsubscribe(ec)
		return nil, err
	}
	return ec, nil
}
```

**購読してから起動する**。順序が逆だと、起動直後に終了したプロセスのイベントを取りこぼす。

```go title="pkg/sys/reaper/reaper_unix.go"
func (m *Monitor) Wait(c *exec.Cmd, ec chan runc.Exit) (int, error) {
	for e := range ec {
		if e.Pid == c.Process.Pid {
			// make sure we flush all IO
			c.Wait()
			m.Unsubscribe(ec)
			return e.Status, nil
		}
	}
	// return no such process if the ec channel is closed and no more exit
	// events will be sent
	return -1, ErrNoSuchProcess
}
```

自分の PID のイベントが来るまで、他のプロセスの終了通知を読み飛ばす。

`c.Wait()` を呼ぶのは **IO をフラッシュするため**。既にプロセスは回収済みなので `Wait` は失敗するが、`exec.Cmd` が持つパイプのコピーを完了させる副作用がある。コメントがそう説明している。

### タイムアウト付きの待ち

```go title="pkg/sys/reaper/reaper_unix.go"
// WaitTimeout is used to skip the blocked command and kill the left process.
func (m *Monitor) WaitTimeout(c *exec.Cmd, ec chan runc.Exit, timeout time.Duration) (int, error) {
	...
	// capacity can make sure that the following goroutine will not be
	// blocked if there is no receiver when timeout.
	waitCh := make(chan *exitStatusWrapper, 1)
	go func() {
		defer close(waitCh)
		status, err := m.Wait(c, ec)
		waitCh <- &exitStatusWrapper{...}
	}()
	...
	select {
	case <-timer.C:
		syscall.Kill(c.Process.Pid, syscall.SIGKILL)
		return 0, fmt.Errorf("timeout %v for cmd(pid=%d): %s, %s", timeout, c.Process.Pid, c.Path, c.Args)
```

チャネルにバッファ 1 を持たせる理由がコメントにある。「タイムアウトで受信者がいなくなっても、goroutine がブロックしないように」。**goroutine のリークを防ぐための容量 1** だ。

タイムアウトしたら SIGKILL を送る。エラーメッセージにコマンドと引数が入るので、何が固まったかが分かる。

### 配信ループ

[`pkg/sys/reaper/reaper_unix.go#L193-L235`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/sys/reaper/reaper_unix.go#L193-L235)。

```go title="pkg/sys/reaper/reaper_unix.go"
func (m *Monitor) notify(e runc.Exit) chan struct{} {
	const timeout = 1 * time.Millisecond
	var (
		done    = make(chan struct{}, 1)
		timer   = time.NewTimer(timeout)
		success = make(map[chan runc.Exit]struct{})
	)
	stop(timer, true)

	go func() {
		defer close(done)

		for {
			var (
				failed      int
				subscribers = m.getSubscribers()
			)
			for _, s := range subscribers {
				s.do(func() {
					if s.closed {
						return
					}
					if _, ok := success[s.c]; ok {
						return
					}
					timer.Reset(timeout)
					recv := true
					select {
					case s.c <- e:
						success[s.c] = struct{}{}
					case <-timer.C:
						recv = false
						failed++
					}
					stop(timer, recv)
				})
			}
			// all subscribers received the message
			if failed == 0 {
				return
			}
		}
	}()
	return done
}
```

要素が多い。

- **`success` マップ** — 既に届いた購読者を記録し、二重送信を避ける
- **1 ミリ秒のタイムアウト** — 詰まっている購読者を待たない
- **失敗が 0 になるまでループ** — 諦めない
- **毎回 `getSubscribers()` を呼び直す** — ループ中に購読者が増減してもよい
- **`timer` を使い回す** — `time.After` を毎回呼ぶとタイマーが溜まる

`stop` ヘルパは、Go の `time.Timer` を安全に再利用するための定番の処理だ。

```go title="pkg/sys/reaper/reaper_unix.go"
func stop(timer *time.Timer, recv bool) {
	if !timer.Stop() && recv {
		<-timer.C
	}
}
```

`Stop()` が false を返した (既に発火した) 場合、チャネルに値が残っているので読み捨てる。ただし既に受信済みなら読んではいけない。**`recv` フラグでその区別を持ち回っている**。

チャネルのバッファは 32。

```go title="pkg/sys/reaper/reaper_unix.go"
const bufferSize = 32
```

購読者が一時的に処理を止めても、32 件までは溜められる。

## なぜそうなっているか

### wait の一意性がすべての出発点

`wait4` は「呼んだ者勝ち」なので、複数箇所から呼べない。この制約から、

- SIGCHLD を受ける場所を 1 つにする
- 回収結果を配信する仕組みが要る
- 購読者は PID で自分宛てを判別する

という構造が導かれる。**OS の API の制約が、アプリケーションの構造を決めている** 例だ。

同じ問題は、子プロセスを扱うあらゆるプログラム (シェル、init、スーパーバイザ) で発生する。

### 配信を諦めない

終了イベントを取りこぼすと、`Wait` している goroutine が永久にブロックする。それはコンテナの削除が完了しないことを意味し、Pod が Terminating のまま残る、といった症状になる。

だから配信ループは「全員に届くまで」回る。ただし 1 ミリ秒のタイムアウトで **詰まっている購読者を後回し** にして、他の購読者への配信を先に進める。

上位の `Reap` に 1 秒のタイムアウトがあるので、最終的には諦める。二段構えになっている。

### バッファ 32 という値

小さすぎると、購読者が少し遅れただけで配信ループが再試行に入る。大きすぎるとメモリを食う。

shim が同時に扱うプロセスは、コンテナ数 + exec 数で数十程度。32 は「短時間に発生しうる終了の数」として妥当な見積もりだ。

## どう活かすか

### 終了が検出されないとき

コンテナが終了しているのに `ctr tasks ls` で Running のまま、という場合。

```sh
# shim のプロセスとその子
$ pstree -p <shim-pid>

# ゾンビプロセスの有無
$ ps -eo stat,pid,cmd | grep '^Z'
```

ゾンビが溜まっていたら、reaper が動いていない (シグナルハンドラが登録されていない、または詰まっている)。shim が SIGCHLD を受け取れない状態になっている可能性がある。

### 子プロセスを扱うプログラムを書くとき

containerd の reaper が示す要点。

- **SIGCHLD の処理は 1 か所に集約する** — `wait` を複数箇所から呼ばない
- **1 回のシグナルで、回収できるだけ回収する** — シグナルは合流する
- **`ECHILD` はエラーではない** — 既に回収済みの場合がある
- **購読は起動より前に行う** — 起動直後の終了を取りこぼさない
- **配信にタイムアウトを入れ、かつ諦めない** — 二段構えにする

4 番目が最も間違えやすい。「プロセスを起動してから終了を待つ」と書くと、その間に終了したイベントを失う。`Monitor.Start` が購読と起動をまとめて提供しているのは、この順序を間違えさせないためだ。
