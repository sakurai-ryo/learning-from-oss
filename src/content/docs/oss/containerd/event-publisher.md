---
title: "イベントは shim から publish バイナリで戻ってくる"
description: "shim はコンテナの生成・開始・終了を containerd に伝える必要がある。常駐する shim は ttrpc で直接送るが、後始末のためだけに起動された短命なプロセスは containerd publish というコマンドを exec して送る。送信は失敗したら遅延を伸ばしながら再キューされ、5 回で捨てられる。"
group: "コンテナを実行する"
sidebar:
  order: 45
---

## 何を学んだか

### 2 つの送信経路

shim から containerd へイベントを送る方法が 2 つある。

- **ttrpc で直接** — 常駐している shim。`/run/containerd/containerd.sock.ttrpc` に接続し続ける
- **`containerd publish` を exec** — `delete` バイナリコールなど、短命なプロセスから

後者は「containerd 本体のバイナリを、publish サブコマンドで起動する」という形をとる。だから bootstrap パラメータに `containerd_binary` (containerd 自身のパス) が含まれている ([起動パラメータを stdin の protobuf 1 通に集約する](../shim-bootstrap/))。

```sh
containerd publish --namespace k8s.io --topic /tasks/exit < <protobuf のイベント>
```

イベントの中身は **stdin から protobuf で** 渡す。

### 送信は失敗を前提にする

containerd が再起動中だったり、負荷で応答しなかったりする。shim 側の publisher は、

- 失敗したら再キューする
- 再送のたびに待ち時間を 1 秒ずつ伸ばす
- **5 回失敗したら捨てる**
- キューは 2048 件

「必ず届く」ことを保証しない。**イベントは失われうる** という前提が設計に組み込まれている。

### 接続が切れたら 1 回だけ繋ぎ直す

`ttrpc.ErrClosed` (接続が閉じている) を受けたら、再接続してもう 1 度だけ送る。それ以外のエラーはそのまま返す。

再接続後は **新しいコンテキスト** でタイムアウトを取り直す。元のコンテキストの残り時間が尽きていることがあるからだ。

## ソースコードのどこか

### publish サブコマンド

[`cmd/containerd/command/publish.go#L31-L62`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd/command/publish.go#L31-L62)。

```go title="cmd/containerd/command/publish.go"
var publishCommand = &cli.Command{
	Name:  "publish",
	Usage: "Binary to publish events to containerd",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "namespace",
			Usage: "Namespace to publish to",
		},
		&cli.StringFlag{
			Name:  "topic",
			Usage: "Topic of the event",
		},
	},
	Action: func(cliContext *cli.Context) error {
		ctx := namespaces.WithNamespace(cliContext.Context, cliContext.String("namespace"))
		topic := cliContext.String("topic")
		...
		payload, err := getEventPayload(os.Stdin)
```

Usage が "Binary to publish events to containerd" — **プログラムから使われることが前提** のサブコマンドだと明記されている。

containerd 本体のバイナリに、こういう「他のプロセスから呼ばれるための」サブコマンドが同居している。バイナリを増やさずに済み、バージョンの整合も自動的に取れる。

### 送信のキュー

[`pkg/shim/publisher.go#L26-L29`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/shim/publisher.go#L26-L29)。

```go title="pkg/shim/publisher.go"
const (
	queueSize  = 2048
	maxRequeue = 5
)
```

数値が 2 つだけ。設定可能にしていない。

```go title="pkg/shim/publisher.go"
func (l *RemoteEventsPublisher) processQueue() {
	for i := range l.requeue {
		if i.count > maxRequeue {
			log.L.Errorf("evicting %s from queue because of retry count", i.ev.Topic)
			// drop the event
			continue
		}

		if err := l.forwardRequest(i.ctx, &v1.ForwardRequest{Envelope: i.ev}); err != nil {
			log.L.WithError(err).Error("forward event")
			l.queue(i)
		}
	}
}
```

5 回を超えたら **明示的にログを出して捨てる**。`// drop the event` というコメント付き。黙って消えるより、ログに残る方がずっとよい。

再キューの実装。

```go title="pkg/shim/publisher.go"
func (l *RemoteEventsPublisher) queue(i *item) {
	go func() {
		i.count++
		// re-queue after a short delay
		time.Sleep(time.Duration(1*i.count) * time.Second)
		l.requeue <- i
	}()
}
```

goroutine を起こして sleep してからチャネルに戻す。待ち時間は 1 秒 × 回数なので、1, 2, 3, 4, 5 秒と線形に伸びる。指数バックオフではない。

**goroutine + sleep** という素朴な実装だが、キューの上限が 2048 なので goroutine も 2048 個までしか増えない。

### 直接送信も同じ経路に落ちる

```go title="pkg/shim/publisher.go"
func (l *RemoteEventsPublisher) Publish(ctx context.Context, topic string, event events.Event) error {
	...
	if err := l.forwardRequest(i.ctx, &v1.ForwardRequest{Envelope: i.ev}); err != nil {
		l.queue(i)
		return err
	}

	return nil
}
```

最初の送信が失敗したら **再キューしつつ、呼び出し元にもエラーを返す**。呼び出し元は失敗を知るが、送信自体は裏で継続する。

「エラーを返す = 諦めた」ではない設計で、呼び出し元がログを出しつつ処理を続けられる。

### 再接続の扱い

[`pkg/shim/publisher.go#L153-L185`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/shim/publisher.go#L153-L185)。

```go title="pkg/shim/publisher.go"
func (l *RemoteEventsPublisher) forwardRequest(ctx context.Context, req *v1.ForwardRequest) error {
	service, err := l.client.EventsService()
	if err == nil {
		fCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err = service.Forward(fCtx, req)
		cancel()
		if err == nil {
			return nil
		}
	}

	if err != ttrpc.ErrClosed {
		return err
	}

	// Reconnect and retry request
	if err = l.client.Reconnect(); err != nil {
		return err
	}
	...
	// try again with a fresh context, otherwise we may get a context timeout unexpectedly.
	fCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	_, err = service.Forward(fCtx, req)
```

再接続を試みるのは `ttrpc.ErrClosed` のときだけ。他のエラー (タイムアウト、サーバ側のエラー) では再接続しない。**接続の問題と、リクエストの問題を区別している**。

コメント「新しいコンテキストでもう一度試す。そうしないと予期せずコンテキストのタイムアウトを受け取る」。再接続に時間がかかると、元のコンテキストの 5 秒が尽きている。**リトライには新しい予算を与える** 必要がある。

### イベントの順序保証

[`docs/runtime-v2.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/runtime-v2.md) の Events 節。

```markdown title="docs/runtime-v2.md"
The Runtime v2 supports an async event model. In order for the an upstream caller (such as Docker) to get these events in the correct order a Runtime v2 shim MUST implement the following events where `Compliance=MUST`. This avoids race conditions between the shim and shim client where for example a call to `Start` can signal a `TaskExitEventTopic` before even returning the results from the `Start` call.
```

| Topic                  | Compliance                                                       |
| ---------------------- | ---------------------------------------------------------------- |
| `TaskCreateEventTopic` | MUST                                                             |
| `TaskStartEventTopic`  | MUST (follow `TaskCreateEventTopic`)                             |
| `TaskExitEventTopic`   | MUST (follow `TaskStartEventTopic`)                              |
| `TaskDeleteEventTopic` | MUST (follow `TaskExitEventTopic` または `TaskCreateEventTopic`) |
| `TaskOOMEventTopic`    | SHOULD                                                           |

**発行の順序が shim の義務として規定されている**。「Start の結果を返す前に Exit が飛ぶ」ようなレースを避けるためで、これが [OCI の create/start 分離](../oci-runtime-spec/) が必要な理由でもある。

MUST と SHOULD が使い分けられていて、OOM や pause/resume は SHOULD (実装しなくてもよい)。

## なぜそうなっているか

### 短命なプロセスから送るために exec を使う

`delete` バイナリコールは、containerd が「shim が死んでいる」と判断したときに実行される。その中でコンテナの終了イベントを送りたいが、

- ttrpc クライアントを作って接続するコードが必要
- 接続のライフサイクル管理が要る
- shim の実装ごとに書くことになる

`containerd publish` を exec する形にすれば、**shim 実装者は fork/exec を書くだけ** で済む。containerd 本体のバイナリなので、プロトコルのバージョン整合も気にしなくてよい。

Go 以外の言語で shim を書く場合、この差は大きい。

### イベントを「失われうる」ものとして扱う

5 回で捨てる設計は、一見乱暴に見える。しかし代替案はもっと悪い。

- **無限に再送する** — containerd が長時間落ちていると、キューがメモリを食い潰す
- **ディスクに永続化する** — shim が重くなり、ディスクの管理が必要になる
- **送信をブロックする** — shim の本来の仕事 (プロセスの監視) が止まる

イベントは「通知」であって「真実」ではない。containerd 側の真実は bundle と shim の状態から再構築できる ([containerd が死んでもコンテナは死なない](../shim-reconnect/))。だから **イベントの取りこぼしは致命傷にならない**。

CRI プラグインもこの前提で作られていて、イベントを受け取りつつ、定期的に状態を問い合わせる ([CRI: kubelet がランタイムに要求する輪郭](../cri-interface/))。

### 順序を仕様として決める

非同期のイベントで順序を保証するのは難しい。containerd は「shim が発行順序を守る」という契約にした。

- shim は 1 プロセスなので、自分の中で順序を守れる
- containerd 側で並べ替える必要がない
- 購読者は届いた順に処理すればよい

**順序保証の責任を、それが最も安く実現できる場所に置いている**。

## どう活かすか

### イベントを購読して観察する

```sh
# 全イベントを流す
$ ctr -n k8s.io events

# フィルタする
$ ctr -n k8s.io events 'topic~="/tasks/.*"'
```

コンテナの起動から終了までのイベント列が見える。順序が仕様通りか (create → start → exit → delete) を確認できる。

イベントが飛んでこない場合、shim の publisher でエラーが出ていないかを containerd のログで確認する。

```sh
$ journalctl -u containerd | grep -E "forward event|evicting"
```

`evicting ... because of retry count` が出ていたら、イベントが実際に捨てられている。

### 「バイナリ経由の通知」パターン

短命なプロセスから常駐サービスへ通知する経路を作るとき、この形が使える。

- **常駐サービス側のバイナリに、通知用サブコマンドを持たせる** — 別バイナリを増やさない
- **通知の中身は stdin から構造化データで渡す** — 引数の長さ制限を避ける
- **識別情報 (namespace、topic) はフラグで渡す** — ログや ps で見える

代償はプロセス起動のコスト (数 ms) だが、通知が頻繁でなければ問題にならない。

### 「失われてよい通知」と割り切る

再送を有限回にするなら、その前提を成立させる仕組みが要る。

- **真実は別の場所にある** — 通知は補助的な情報
- **購読者が定期的に状態を確認する** — 通知の取りこぼしを回復できる
- **捨てたことをログに残す** — 静かに消えない

3 つ揃って初めて「捨ててよい」と言える。1 つでも欠けると、稀に起きる取りこぼしが原因不明の不整合になる。
