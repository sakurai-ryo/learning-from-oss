---
title: "long poll でネットワークの変化を受け取り続ける"
description: "1 本の HTTP POST を開きっぱなしにして、長さ 4 バイト + zstd の JSON をフレームとして流し続ける。120 秒のウォッチドッグは「読みで待っているあいだ」だけ動き、メッセージを処理しているあいだは止まる。受け取ったフレームの処理は別 goroutine のキューに逃がして、読みループを詰まらせない。"
group: "制御プレーン"
sidebar:
  order: 6
---

## 何を学んだか

### 1 本の HTTP POST を開きっぱなしにする

クライアントは `POST /machine/map` を 1 本張り、**そのレスポンスボディを閉じずに読み続ける**。サーバはネットワークに変化があるたびに、そのボディへ [MapResponse](../netmap/) を書き足す。WebSocket も Server-Sent Events も使わない、素の HTTP レスポンスストリームだ。

その上のフレーミングは単純だ。

```text
[4 バイト: メッセージ長 (little endian)][その長さの zstd 圧縮 JSON]
[4 バイト: メッセージ長][zstd 圧縮 JSON]
...
```

`Content-Length` は使えないので、長さプレフィックスを自分で持つ。

### ウォッチドッグは「読み待ち」のあいだだけ動く

long poll の難しさは、**「静かなのは正常か、それとも死んでいるのか」** の区別だ。TCP は片方が黙っただけでは切れない。

Tailscale は 120 秒のウォッチドッグタイマーを置く。ただし単純な「120 秒何も来なければ切る」ではない。**メッセージを読み終えたら止め、次の読みに入る直前にリセットする。** サーバが「10 秒眠れ」というデバッグ指示を送ってきたときに、その処理中にタイマーが焼き切れないようにするためだ。

### 受信ループと処理を分ける

読み取ったメッセージの処理 (netmap の再構築、下流への通知) は、**チャネル経由で別 goroutine に渡す**。読みループは次のフレームを待つことに専念する。

### 3 つの goroutine と backoff

`Auto` クライアントは 3 本の goroutine を回す。

| goroutine       | 役割                                             |
| --------------- | ------------------------------------------------ |
| `authRoutine`   | ログイン状態を維持する                           |
| `mapRoutine`    | long poll を張り続ける                           |
| `updateRoutine` | 自分の状態 (エンドポイントなど) をサーバに伝える |

それぞれが独立した指数バックオフを持ち、**netmap を 1 個でも受け取れたらバックオフをリセットする**。

### ロードバランサのためにヘッダを重複させる

リクエストボディの JSON に入っている node key を、**HTTP ヘッダにもコピーして送る**。Noise で暗号化されたボディをロードバランサは読めないので、振り分けの材料としてヘッダに出しておく。コメントは「セキュリティのためではなく、単なる冗長化された最適化」と明記している。

## ソースコードのどこか

### long poll の入り口

```go title="control/controlclient/direct.go"
func (c *Direct) PollNetMap(ctx context.Context, nu NetmapUpdater) error {
	return c.sendMapRequest(ctx, true, nu)
}
```

[`direct.go#L966-L967`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L966-L967)。

`sendMapRequest` の第 2 引数が `isStreaming` で、**同じ関数がストリーミングと単発の両方を処理する**。単発のほうは「エンドポイントだけ更新したい」ときに使い、`OmitPeers: true` を立てて応答本体を捨てる。

```go title="control/controlclient/direct.go"
	request := &tailcfg.MapRequest{
		Version:                 tailcfg.CurrentCapabilityVersion,
		KeepAlive:               true,
		NodeKey:                 nodeKey,
		DiscoKey:                discoKey,
		Endpoints:               eps,
		EndpointTypes:           epTypes,
		Stream:                  isStreaming,
		Hostinfo:                hi,
		DebugFlags:              c.debugFlags,
		OmitPeers:               nu == nil,
		TKAHead:                 tkaHead,
		ConnectionHandleForTest: connectionHandleForTest,
	}
```

[`direct.go#L1128-L1140`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L1128)。

**リクエストに `Endpoints` が入っている。** [magicsock](../magicsock/) が見つけた自分の UDP 候補アドレスを、この long poll のリクエストで申告する。つまり **long poll は「受け取る」だけでなく「伝える」経路でもある**。

### 健全性の警告をデバッグフラグとして送る

```go title="control/controlclient/direct.go"
	var extraDebugFlags []string
	if c.health.RouterHealth() != nil {
		extraDebugFlags = append(extraDebugFlags, "warn-router-unhealthy")
	}
	extraDebugFlags = c.health.AppendWarnableDebugFlags(extraDebugFlags)
	if hostinfo.DisabledEtcAptSource() {
		extraDebugFlags = append(extraDebugFlags, "warn-etc-apt-source-disabled")
	}
```

[`direct.go#L1163-L1172`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L1163)。

**クライアントの不調が、文字列のリストとしてサーバに伝わる。** 「ルータの設定に失敗している」「apt のリポジトリ設定を無効にされた」。サーバ側はこれを見て admin console に警告を出したり、集計して不具合の広がりを把握したりできる。[health tracker のページ](../health/) で扱う仕組みの出口の 1 つだ。

### ウォッチドッグ

```go title="control/controlclient/direct.go"
const watchdogTimeout = 120 * time.Second
```

```go title="control/controlclient/direct.go"
	// Create a watchdog timer that breaks the connection if we don't receive a
	// MapResponse from the network at least once every two minutes. The
	// watchdog timer is stopped every time we receive a MapResponse (so it
	// doesn't run when we're processing a MapResponse message, including any
	// long-running requested operations like Debug.Sleep) and is reset whenever
	// we go back to blocking on network reads.
	// The watchdog timer also covers the initial request (effectively the
	// pre-body and initial-body read timeouts) as we do not have any other
	// keep-alive mechanism for the initial request.
	watchdogTimer, watchdogTimedOut := c.clock.NewTimer(watchdogTimeout)
```

[`direct.go#L1055`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L1055) と [`direct.go#L1195-L1205`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L1195)。

コメントが 2 つのことを説明している。

**1. 処理中は止める。** `Debug.Sleep` のような、サーバから指示された長時間の処理をしているあいだにタイマーが動いていると、正常なのに接続を切ってしまう。

**2. 最初のリクエストもカバーする。** 接続確立からレスポンス開始までは keepalive が来ないので、他にタイムアウト機構がない。1 個のタイマーで両方を見る。

### 読みループ

```go title="control/controlclient/direct.go"
	for mapResIdx := 0; mapResIdx == 0 || isStreaming; mapResIdx++ {
		watchdogTimer.Reset(watchdogTimeout)
		var siz [4]byte
		if _, err := io.ReadFull(res.Body, siz[:]); err != nil {
			...
		}
		size := binary.LittleEndian.Uint32(siz[:])
		msg = append(msg[:0], make([]byte, size)...)
		if _, err := io.ReadFull(res.Body, msg); err != nil {
			...
		}
		var resp tailcfg.MapResponse
		if err := sess.decodeMsg(msg, &resp); err != nil {
			...
		}
		watchdogTimer.Stop()
```

[`direct.go#L1237-L1270`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L1237)。

**ループ条件 `mapResIdx == 0 || isStreaming` が、ストリーミングと単発を 1 つのループで扱う仕掛けだ。** 単発なら 1 回で抜ける。コメントも「同じ読みループをどちらにも使える」と書いている。

`msg = append(msg[:0], make([]byte, size)...)` という書き方で、バッファを毎回作り直さずに使い回している。netmap は数 MB になりうるので、long poll のたびに確保し直すとゴミが増える。

### コンテキストキャンセルのエラーを正規化する

```go title="control/controlclient/direct.go"
			// If the read failed because the poll's context was
			// canceled, report that instead of the underlying
			// transport error. Which error the transport returns for
			// a read interrupted by cancellation varies by transport
			// and Go version (Go 1.27's http2 returns the underlying
			// "use of closed network connection" where earlier
			// versions returned the context error).
			if ctx.Err() != nil {
				err = ctx.Err()
			}
```

[`direct.go#L1243-L1252`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/direct.go#L1243)。

**Go のバージョンとトランスポートによって、キャンセル時に返るエラーが違う。** 上位が「意図的な停止」と「本当の障害」を区別できるように、ここで正規化している。long poll を切る操作 (ログアウト、設定変更、スリープ) は日常的に起きるので、これを障害としてログに出すと本物の障害が埋もれる。

### 処理はキューに逃がす

```go title="control/controlclient/map.go"
// mapSession holds the state over a long-polled "map" request to the
// control plane.
//
// It accepts incremental tailcfg.MapResponse values to
// netMapForResponse and returns fully inflated NetworkMaps, filling
// in the omitted data implicit from prior MapResponse values from
// within the same session (the same long-poll HTTP response to the
// one MapRequest).
type mapSession struct {
```

```go title="control/controlclient/map.go"
	cqmu                   sync.Mutex
	changeQueue            chan responseWithSource
	changeQueueClosed      bool
	processQueue           sync.WaitGroup
```

[`map.go#L46-L54`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/map.go#L46-L54) と [`map.go#L106-L109`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/map.go#L106-L109)。

**「セッション」という単位が明示されている。** 1 本の long poll = 1 つの `mapSession` で、差分の基準となる状態 (`lastNode`、`lastDNSConfig`、`lastDERPMap` …) はここに溜まる。接続が切れたらセッションごと捨てて、新しい long poll では最初から積み直す。

差分の状態を接続に紐づけることで、**「前回の接続で受け取った差分が、今回の接続に混ざる」という事故が構造的に起きない**。

### mapRoutine と backoff

```go title="control/controlclient/auto.go"
// mapRoutine is responsible for keeping a read-only streaming connection to the
// control server, and keeping the netmap up to date.
func (c *Auto) mapRoutine() {
	defer close(c.mapDone)
	mrs := mapRoutineState{
		c:  c,
		bo: backoff.NewBackoff("mapRoutine", c.logf, 30*time.Second),
	}

	for {
		if !c.waitUnpause("mapRoutine") {
			...
		}
		...
		err := c.direct.PollNetMap(ctx, mrs)
		...
		if paused {
			mrs.bo.Reset()
		} else {
			mrs.bo.BackOff(ctx, err)
		}
```

[`auto.go#L600-L655`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/auto.go#L600)。

```go title="control/controlclient/auto.go"
	// Reset the backoff timer if we got a netmap.
	mrs.bo.Reset()
```

[`auto.go#L477-L478`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/control/controlclient/auto.go#L477-L478)。

**バックオフのリセット条件が「接続に成功したら」ではなく「netmap を受け取れたら」になっている。** 接続だけできて何も返ってこないサーバに対して、バックオフが効かなくなるのを防ぐ。

`paused` (ユーザーがスリープした、ネットワークが落ちたなど、意図的に止めている状態) のときもリセットする。**意図的な停止をバックオフの根拠にしない**、という判断だ。

### ロードバランサ用のヘッダ

```go title="tailcfg/tailcfg.go"
// The possible values depend on the request path, but for /machine (Noise)
// requests, they'll usually be a node public key (in key.NodePublic.String
// format), matching the Request JSON body's NodeKey.
//
// Note that this is not a security or authentication header; it's strictly
// denormalized redundant data as an optimization.
//
// For some request types, the header may have multiple values. (e.g. OldNodeKey
// vs NodeKey)
const LBHeader = "Ts-Lb"
```

[`tailcfg.go#L3078-L3087`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tailcfg/tailcfg.go#L3078-L3087)。

**「セキュリティや認証のためのヘッダではない。純粋に非正規化された冗長データで、最適化のためだ」** という但し書きが重要だ。この手のヘッダは、後から誰かが「node key がヘッダに入っているから認証に使える」と勘違いしやすい。ヘッダはクライアントが自由に詰められる値なので、認証には使えない。**誤用を先回りして禁じるコメント** になっている。

## なぜそうなっているか

### なぜ WebSocket ではないのか

素の HTTP レスポンスストリームには、実務的な利点がある。

**1. プロキシとファイアウォールを通りやすい。** WebSocket の `Upgrade` を通さない企業プロキシは今もある。単なる長い POST レスポンスなら、HTTP を扱えるものは大抵通す。

**2. 実装が少ない。** WebSocket はフレーミング、マスキング、ping/pong、クローズハンドシェイクを持つ。Tailscale が必要なのは「サーバからクライアントへの一方向のメッセージ列」だけなので、4 バイトの長さプレフィックスで足りる。

**3. すでに Noise で暗号化されている。** WebSocket が提供する `wss://` の恩恵は要らない。

そして **一方向でよい** ことが決定的だ。クライアントからサーバへ送りたいときは、別の HTTP リクエストを投げればよい。双方向ストリームを 1 本で持つ必要がない。

### なぜ処理を別 goroutine に逃がすのか

netmap の処理は重い。1,000 ノードの netmap をパースし、WireGuard の設定を作り直し、パケットフィルタをコンパイルし、DNS を再設定する。これを読みループの中で同期的にやると、**処理しているあいだ次のフレームを読めない**。

TCP の受信バッファが埋まると、サーバ側の書き込みがブロックする。**1 台の遅いクライアントが、サーバのゴルーチンを 1 本占有する**。クライアント側の処理速度がサーバのリソース消費に直結してしまう。

キューに逃がせば、読みは常に速い。ただしキューが無限に伸びると今度はメモリを食うので、`changeQueue` はバッファなしのチャネルになっている。**遅れたら結局ブロックするが、少なくとも 1 メッセージ分は先読みできる。**

### なぜセッション単位で差分の状態を持つのか

差分エンコーディングは「受け手が前の状態を持っている」ことを前提にする。この前提が壊れる典型が **再接続** だ。

- 切断中にサーバ側で変更があった
- 再接続で別のサーバインスタンスに繋がった
- クライアントが処理の途中で落ちた

これらを個別に扱おうとすると複雑になる。**「接続が切れたら差分の基準も捨てる」と決めれば、この 3 つがまとめて消える。** 新しい接続では、サーバが必ず完全な状態から送り直す。

コストは再接続時の帯域だが、再接続は稀なイベントなので割に合う。

### なぜエンドポイントの申告を long poll に相乗りさせるのか

クライアントの UDP エンドポイントは頻繁に変わる。NAT のマッピングが切れる、Wi-Fi が変わる、ポートマッピングが更新される。そのたびに新しい HTTP リクエストを立てると、**接続確立のコスト (TCP + Noise) が毎回かかる**。

すでに張ってある long poll のリクエストに載せられれば、追加コストはゼロだ。ただし long poll は「1 回のリクエストで長時間のレスポンス」なので、後からリクエストに追記はできない。そこで **`OmitPeers: true` の軽量な MapRequest を別に投げる** 経路も用意してある。エンドポイントだけ更新して、応答本体は捨てる。

つまり **「long poll を張り直さずにエンドポイントだけ更新する」ための、専用の軽量リクエスト**がある。同じ関数がストリーミングと単発を兼ねているのは、この 2 つが同じ `MapRequest` 型を共有しているからだ。

## どう活かすか

**サーバからクライアントへの一方向プッシュだけが必要なら、長い HTTP レスポンス + 長さプレフィックスで足りる。** WebSocket や gRPC ストリームを持ち込む前に、この選択肢を検討する価値がある。プロキシ透過性が高く、実装が数十行で済む。

**ウォッチドッグは「待っているあいだ」だけ動かす。** 「N 秒何も来なければ切る」を素朴に実装すると、正常な長時間処理を巻き込んで切ってしまう。読み待ちに入る直前にリセットし、メッセージを受け取ったら止める、という 2 点をコードで明示すると意図が伝わる。

**受信ループと処理は分ける。** 受け手の処理速度が送り手のリソース消費に直結する構造は、遅いクライアントが 1 台いるだけでサーバを傷める。キューを挟むだけで、その結合が切れる。

**バックオフのリセット条件は「接続できたか」ではなく「有用な仕事ができたか」で決める。** TCP が繋がっただけでリセットすると、繋がるが何も返さないサーバに対して延々とリトライを繰り返す。同じ理屈で、**意図的な停止をバックオフの根拠にしない**。

**差分の基準を接続に紐づけると、再接続まわりのバグがまとめて消える。** 「どこまで送ったか」をサーバに覚えさせる設計は強力だが、状態を持つぶん壊れ方が増える。接続が切れたらリセットする、と決めるだけで多くの問題が定義上存在しなくなる。

**「これは認証には使えない」と明示するコメントを、誤用されうるフィールドに添える。** 冗長化した値をヘッダに出すのは実務でよくあるが、そこに識別子が入っていると必ず誰かが認証に使おうとする。防ぐ手段はコメントしかない。
