---
title: "sdnotify と MAINPID — コンテナを systemd の管理下に置く"
description: "systemd の Type=notify なサービスは、準備完了を NOTIFY_SOCKET に書いて知らせる。コンテナの中のプロセスにそれをさせるには、ソケットをコンテナに渡し、届いたメッセージをホスト側に中継する proxy が要る。Podman は 4 つのモードを持ち、conmon の PID を MAINPID として systemd に教えることで「コンテナ = サービス」の対応を成立させている。"
group: "systemd 統合"
sidebar:
  order: 41
---

## 何を学んだか

### systemd がサービスの状態を知る仕組み

systemd の `Type=notify` なサービスは、起動が完了したら `$NOTIFY_SOCKET` に `READY=1` を書く。systemd はそれを受け取るまで「起動中」とみなし、依存する他のサービスを待たせる。

`MAINPID=<pid>` を送れば「このサービスの主プロセスはこれだ」と教えられる。systemd はその PID を監視し、死んだらサービスが停止したと判断する。

コンテナでこれを成立させるには 2 つの問題がある。

1. **どの PID を MAINPID にするか** — `podman` は終了する。コンテナのプロセスは PID namespace の中にいる
2. **コンテナの中のプロセスが `READY=1` を送るには** — `$NOTIFY_SOCKET` はホスト側のパスで、コンテナからは見えない

### 4 つのモード

`--sdnotify` の値は 4 つある。

| モード          | 何を READY の合図にするか                  | 何を MAINPID にするか |
| --------------- | ------------------------------------------ | --------------------- |
| `conmon` (既定) | **Podman がコンテナを起動した時点**        | conmon の PID         |
| `container`     | **コンテナの中のプロセスが送る `READY=1`** | conmon の PID         |
| `healthy`       | **ヘルスチェックが最初に成功した時点**     | conmon の PID         |
| `ignore`        | 何もしない (systemd に通知しない)          | —                     |

`conmon` は「起動したら準備完了」とみなす最も単純なモード。`container` はアプリケーション自身が準備完了を判断する。`healthy` はヘルスチェックの成功を待つ。

**MAINPID はどのモードでも conmon の PID** になる。conmon はコンテナのプロセスと寿命を共にするので、systemd から見れば「conmon が生きている = コンテナが動いている」で正しい。

### NOTIFY_SOCKET の中継

`container` モードでは、コンテナの中のプロセスが `READY=1` を送る必要がある。だが `$NOTIFY_SOCKET` はホストの `/run/systemd/notify` のようなパスで、コンテナの mount namespace からは見えない。

そこで Podman は **自分でソケットを 1 つ作る**。

1. Podman が一時ディレクトリに unix datagram socket を作る (NotifyProxy)
2. そのソケットをコンテナに bind mount し、`$NOTIFY_SOCKET` をそのパスに設定する
3. コンテナの中のプロセスがそこに `READY=1` を書く
4. Podman がそれを受け取り、**本物の systemd のソケットに中継する**

「通信路をファイルシステムに置く」という Podman 全体の方針が、ここでも使われている。

## ソースコードのどこか

### 起動直後に MAINPID を送る

[`libpod/container_internal.go#L1300-L1315`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L1300)。

```go title="libpod/container_internal.go"
	// Unless being ignored, set the MAINPID to conmon.
	if c.config.SdNotifyMode != define.SdNotifyModeIgnore {
		payload := fmt.Sprintf("MAINPID=%d", c.state.ConmonPID)
		if c.config.SdNotifyMode == define.SdNotifyModeConmon {
			// Also send the READY message for the "conmon" policy.
			payload += "\n"
			payload += daemon.SdNotifyReady
		}
		if err := notifyproxy.SendMessage(c.config.SdNotifySocket, payload); err != nil {
			logrus.Errorf("Notifying systemd of Conmon PID: %s", err.Error())
		} else {
			logrus.Debugf("Notify sent successfully")
		}
	}
```

`conmon` モードなら、`MAINPID=<pid>` と `READY=1` を **改行で連結して 1 通で送る**。sd_notify のプロトコルは「1 メッセージに複数の行」を許すので、2 回送る必要がない。

送信に失敗しても `logrus.Errorf` でログを出すだけで、**起動は続行する**。systemd の下で動いていない場合 (通常の `podman run`) は `SdNotifySocket` が空なので、そもそも何もしない。

### 送信は 20 行

[`pkg/systemd/notifyproxy/notifyproxy.go#L34`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/notifyproxy/notifyproxy.go#L34)。

```go title="pkg/systemd/notifyproxy/notifyproxy.go"
// SendMessage sends the specified message to the specified socket.
// No message is sent if no socketPath is provided and the NOTIFY_SOCKET
// variable is not set either.
func SendMessage(socketPath string, message string) error {
	if socketPath == "" {
		socketPath, _ = os.LookupEnv("NOTIFY_SOCKET")
		if socketPath == "" {
			return nil
		}
	}
	socketAddr := &net.UnixAddr{
		Name: socketPath,
		Net:  "unixgram",
	}
	conn, err := net.DialUnix(socketAddr.Net, nil, socketAddr)
	...
	_, err = conn.Write([]byte(message))
	return err
}
```

`unixgram` (SOCK_DGRAM) の unix socket に文字列を 1 発書くだけ。**sd_notify プロトコルの実体はこれだけ** で、systemd のライブラリをリンクする必要すらない。

引数のパスが空なら環境変数を見て、それも無ければ **何もせず nil を返す**。「systemd の下にいなければ何もしない」が、呼び出し側の条件分岐なしで実現される。

### 受信側は barrier を扱う必要がある

[`pkg/systemd/notifyproxy/notifyproxy.go#L116`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/notifyproxy/notifyproxy.go#L116)。

```go title="pkg/systemd/notifyproxy/notifyproxy.go"
func (p *NotifyProxy) listen() {
	go func() {
		// See https://github.com/containers/podman/issues/16515 for a description of the protocol.
		fdSize := unix.CmsgSpace(4)
		buffer := make([]byte, _notifyBufferMax)
		oob := make([]byte, _notifyFdMax*fdSize)
		sBuilder := strings.Builder{}
		for {
			n, oobn, flags, _, err := p.connection.ReadMsgUnix(buffer, oob)
```

`ReadMsgUnix` を使うのは、**メッセージに fd が添付されてくる** ことがあるからだ。sd_notify には `BARRIER=1` というメッセージがあり、これは fd を 1 つ添えて送られる。

```go title="pkg/systemd/notifyproxy/notifyproxy.go"
			if isBarrier {
				scms, err := unix.ParseSocketControlMessage(oob)
				...
				for _, scm := range scms {
					fds, err := unix.ParseUnixRights(&scm)
					...
					for _, fd := range fds {
						if err := unix.Close(fd); err != nil {
							logrus.Errorf("closing fd passed on socket %q: %v", fd, err)
							continue
						}
					}
				}
				continue
			}
```

**barrier の意味は「この fd を閉じたら、それが応答になる」** だ。送り手は fd の片側を持っていて、閉じられるのを待つ。「これまでに送ったメッセージを全部処理したか」を同期するための仕組みで、systemd の `sd_notify_barrier()` に対応する。

Podman は受け取った fd を **すぐ閉じる**。バッファリングしていないので、メッセージは常に処理済みだからだ。

fd を閉じ忘れると、送り手が永遠に待ってハングする。しかも `_notifyFdMax = 768` 個まで来る可能性があるので、**fd リークにもなる**。ここが正しく実装されていないと、コンテナの中の systemd 統合アプリが固まる。

境界チェックも丁寧だ。

```go title="pkg/systemd/notifyproxy/notifyproxy.go"
			if n > _notifyBufferMax || oobn > _notifyFdMax*fdSize {
				logrus.Errorf("Ignoring unix message on socket %q: incorrect number of bytes read (n=%d, oobn=%d)", p.socketPath, n, oobn)
				continue
			}

			if flags&unix.MSG_CTRUNC != 0 {
				logrus.Errorf("Ignoring unix message on socket %q: message truncated", p.socketPath)
				continue
			}
```

`MSG_CTRUNC` は「制御メッセージ (fd) が切り捨てられた」ことを示す。これを見逃すと **fd を受け取ったつもりで受け取っていない** 状態になる。ソケットで fd を受け渡すコードでは必ず確認すべきフラグで、忘れられがちな箇所だ。

### READY を待つ間、コンテナの生存も監視する

[`pkg/systemd/notifyproxy/notifyproxy.go#L216`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/notifyproxy/notifyproxy.go#L216)。

```go title="pkg/systemd/notifyproxy/notifyproxy.go"
func (p *NotifyProxy) Wait() error {
	// If the proxy has a container we need to watch it as it may exit
	// without sending a READY message. The goroutine below returns when
	// the container exits OR when the function returns (see deferred the
	// cancel()) in which case we either we've either received the READY
	// message or encountered an error reading from the socket.
	if p.container != nil {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Second):
					state, err := p.container.State()
					...
					if state != define.ContainerStateRunning {
						p.errorChan <- fmt.Errorf("%w: %s", ErrNoReadyMessage, p.container.ID())
						return
					}
				}
			}
		}()
	}

	// Wait for the ready/error channel.
	select {
	case <-p.readyChan:
		return nil
	case err := <-p.errorChan:
		return err
	}
}
```

**「READY を送らずに死ぬコンテナ」への備え** だ。コメントに理由が書いてある。アプリケーションが起動に失敗して終了した場合、`READY=1` は永遠に来ない。タイムアウトを待つより、コンテナの状態を 1 秒ごとに見て、running でなくなったらエラーにする。

`context.WithCancel` + `defer cancel()` で、`Wait()` が返るときに監視 goroutine も確実に終わる。**待ち合わせを 2 つの条件 (メッセージ or プロセスの死) にする** という形は、外部プロセスからの通知を待つ場面で汎用的に使える。

ポーリング間隔が 1 秒なのは、起動待ちの粒度としては十分だからだ。イベント駆動にするには conmon からの通知経路が要るが、そこまでのコストは払っていない。

## なぜそうなっているか

### MAINPID を conmon にしたのは、寿命が一致するから

候補は 3 つあった。`podman` プロセス (すぐ死ぬので不可)、コンテナの中のプロセス (ホストから見た PID は取れるが、PID namespace の関係で扱いにくい)、conmon。

conmon は **コンテナのプロセスが死ぬまで生き、死んだら終了する**。systemd から見て「サービスの主プロセス」の意味論に一致する。しかも conmon はホストの PID namespace にいるので、systemd が直接監視できる。

これは conmon の設計が systemd 統合を意識していた、というより、**「コンテナの寿命を代表するプロセス」が要るという要求が両方で同じだった** ということだ。

### 4 つのモードは、準備完了の定義が用途で違うから

「サービスが使える状態になった」の定義は、アプリケーションによる。

- プロセスが起動すれば十分なもの → `conmon`
- 初期化 (DB マイグレーション、キャッシュの温め) が終わるまで待たせたいもの → `container`
- systemd を意識していないアプリだが、ヘルスチェックはあるもの → `healthy`

**`healthy` モードの存在が実用的**で、アプリケーションを改修せずに正しい起動順序を作れる。既存のイメージをそのまま使えるので、移行のコストが下がる。

### プロキシにしたのは、パスを見せられないから

`$NOTIFY_SOCKET` をそのままコンテナに bind mount する手もある。だがそうすると、**コンテナが systemd に任意のメッセージを送れる** ことになる。`MAINPID` を書き換えたり、他のサービスに影響を与えたりできてしまう。

プロキシを挟めば、Podman が中身を検査してから中継できる。実際、`READY=1` と `BARRIER=1` 以外は解釈せずに捨てている。**信頼境界を越えるメッセージは、そのまま通さず解釈する** という原則が働いている。

## どう活かすか

- **プロセスの寿命を代表する存在を 1 つ決める。** systemd の `MAINPID` に限らず、監視・再起動・依存関係のすべてが「何が死んだらサービスが死んだのか」の定義に依存する。
- **fd を受け取るソケットでは `MSG_CTRUNC` を必ず見る。** 切り捨てを見逃すと、受け取ったつもりで受け取っていない状態になる。fd の受け渡しは失敗が静かなので、チェックを省略しない。
- **待ち合わせは 2 つの条件で。** 「メッセージを待つ」だけだと、相手が死んだときに永遠に待つ。相手の生存も同時に監視して、どちらかで抜ける形にする。
- **信頼境界を越えるメッセージは解釈してから中継する。** ソケットをそのまま渡すと、渡した先の権限がそのまま相手のものになる。プロキシを挟むコストは、フィルタリングの機会を得るコストでもある。
- **準備完了の定義を選ばせる。** アプリケーションによって「使える状態」の定義は違う。既存のアプリを改修せずに済む選択肢 (ヘルスチェック連動) を用意すると、移行が進む。
