---
title: "受付・読み書き・処理を 3 段に分け、詰まったらチャネルを黙らせる"
description: "Kafka のネットワーク層は 1:N:M の 3 段構成になっている。面白いのはバックプレッシャの掛け方で、リクエストを受け取った瞬間にそのコネクションを selector から外し、応答を送り終えるまで読まない。「1 コネクション 1 リクエスト」という単純な規則が、順序保証とメモリ上限とフェアネスを同時に実現している。"
sidebar:
  order: 22
---

## 何を学んだか

### どんな状況の話か

ブローカーは数万のコネクションを持ち、毎秒数十万のリクエストを処理する。ここで素朴な設計を採ると、それぞれに問題が出る。

| 設計                               | 問題                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| コネクションごとに 1 スレッド      | 数万スレッド。コンテキストスイッチで潰れる                    |
| 全部を 1 スレッドの epoll ループで | リクエストの処理 (ディスク I/O を含む) がループを止める       |
| 読み込みと処理を同じスレッドで     | 遅いリクエスト 1 つが、同じスレッドの他のコネクションを止める |

さらに、Kafka 固有の要求がある。

- **1 コネクション内のリクエストは、送った順に処理されなければならない。** [プロデューサの順序保証](../sender-inflight/) がこれに依存している。
- **メモリを無制限に使ってはいけない。** リクエストは最大 100 MB になりうる。読み込んだ分だけヒープを食う。

### Kafka の答え

**受付・読み書き・処理を 3 段のスレッドに分ける。**

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
 *      1 Acceptor thread per listener, that handles new connections.
 *      It is possible to configure multiple data-planes by specifying multiple "," separated endpoints for "listeners" in KafkaConfig.
 *      Acceptor has N Processor threads that each have their own selector and read requests from sockets
 *      M Handler threads that handle requests and produce responses back to the processor threads for writing.
```

[`SocketServer.scala#L60-L70`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L60-L70)。

```text
   TCP           ┌─────────┐  round robin  ┌────────────┐   queue   ┌─────────┐
  ────────────►  │ Acceptor│ ────────────► │ Processor  │ ────────► │ Handler │
                 │  (1本)  │               │  (N本)     │           │  (M本)  │
                 └─────────┘               │ nio Selector│ ◄──────── └─────────┘
                                           └────────────┘  response
```

そのうえで、次の 3 つが効いている。

1. **リクエストを受け取ったら、そのチャネルを selector から外す (mute)。** 応答を送り終えるまで、そのコネクションからは 1 バイトも読まない。
2. **リクエストキューは固定長のブロッキングキュー。** 詰まったら Processor が止まる。
3. **メモリプールで、読み込み中のバイト数に上限を掛ける。**

## ソースコードのどこか

### 1 コネクション 1 リクエスト

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
requestChannel.sendRequest(req)
selector.mute(connectionId)
handleChannelMuteEvent(connectionId, ChannelMuteEvent.REQUEST_RECEIVED)
```

[`SocketServer.scala#L1019-L1021`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L1019-L1021)。

**リクエストをキューに入れた直後に `mute` している。** mute されたチャネルは、nio の selector が読み取り可能として報告しなくなる。

つまり、**あるコネクションについて、ブローカーが同時に処理しているリクエストは常に 1 個以下**になる。

そして応答を送り終えたら解除する。

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
// Try unmuting the channel. If there was no quota violation and the channel has not been throttled,
// it will be unmuted immediately. If the channel has been throttled, it will unmuted only if the throttling
// delay has already passed by now.
handleChannelMuteEvent(send.destinationId, ChannelMuteEvent.RESPONSE_SENT)
tryUnmuteChannel(send.destinationId)
```

[`SocketServer.scala#L1047-L1053`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L1047-L1053)。

**`tryUnmute` であって `unmute` ではない。** [クォータで絞られている](../quota-throttle/) なら、遅延が明けるまで mute されたままになる。

**mute の状態が「なぜ mute されているか」を持っている**ので、複数の理由 (処理中、スロットリング中) が重なっても正しく解除できる。`ChannelMuteEvent` という enum で状態遷移を表している。

### リクエストキュー

```scala title="core/src/main/scala/kafka/network/RequestChannel.scala"
class RequestChannel(val queueSize: Int, ...
  private val requestQueue = new ArrayBlockingQueue[BaseRequest](queueSize)
```

```scala title="core/src/main/scala/kafka/network/RequestChannel.scala"
requestQueue.put(request)
```

[`RequestChannel.scala#L40-L78`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/RequestChannel.scala#L40-L78)。

**固定長 (`queued.max.requests`、既定 500) のブロッキングキューに `put` する。** 満杯なら Processor スレッドがそこで止まる。

止まると、その Processor が担当している全コネクションの読み取りも止まる。**TCP の受信バッファが埋まり、最終的にクライアント側の送信がブロックされる。**

**バックプレッシャが、OS の TCP フロー制御まで自然に伝播する。** リクエストを捨てたり、エラーを返したりしない。**「受け取れないなら読まない」だけ。**

### メモリの上限

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
private[network] val memoryPool = if (config.queuedMaxBytes > 0) new SimpleMemoryPool(config.queuedMaxBytes, config.socketRequestMaxBytes, false, memoryPoolSensor) else MemoryPool.NONE
```

[`SocketServer.scala#L97`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L97)。

キューの長さ (500 件) だけでは、メモリの上限にならない。**1 件が 100 MB なら 50 GB になる。**

`queued.max.request.bytes` を設定すると、**読み込み中のリクエストのバイト数に上限が掛かる。** プールが枯渇したら、Processor は新しいリクエストの読み込みを始めない。

**「件数の上限」と「バイト数の上限」を両方持つ**のは、リクエストサイズの分散が大きいシステムでは必要になる。

そして、枯渇した時間をメトリクスとして出している。

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
private val memoryPoolDepletedPercentMetricName = metrics.metricName("MemoryPoolAvgDepletedPercent", JSocketServer.METRICS_GROUP)
private val memoryPoolDepletedTimeMetricName = metrics.metricName("MemoryPoolDepletedTimeTotal", JSocketServer.METRICS_GROUP)
```

[`SocketServer.scala#L93-L96`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L93-L96)。

**「プールが空だった時間の割合」が観測できる。** バックプレッシャが効いているかどうかを、運用者が数字で見られる。

### プロトコル層への例外的な割り込み

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
// KIP-511: ApiVersionsRequest is intercepted here to catch the client software name
// and version. It is done here to avoid wiring things up to the api layer.
if (header.apiKey == ApiKeys.API_VERSIONS) {
  val apiVersionsRequest = req.body(classOf[ApiVersionsRequest])
  if (apiVersionsRequest.isValid) {
    channel.channelMetadataRegistry.registerClientInformation(new ClientInformation(
      apiVersionsRequest.data.clientSoftwareName,
      apiVersionsRequest.data.clientSoftwareVersion))
  }
}
```

[`SocketServer.scala#L1009-L1018`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L1009-L1018)。

**ネットワーク層が、特定の RPC の中身を覗いている。** 層の分離を破っている箇所で、コメントに理由 (`to avoid wiring things up to the api layer`) が書かれている。

クライアントのソフトウェア名とバージョンは **コネクションに紐づく属性**であって、リクエストごとの情報ではない。API 層に渡してからネットワーク層に戻すより、ここで取ったほうが素直だ、という判断になっている。

**層を破るなら、破る理由を書く。**

### コネクション数の制限

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
val connectionQuotas = new ConnectionQuotas(config, time, metrics)
```

[`SocketServer.scala#L103`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L103)。

`max.connections.per.ip`、`max.connections`、`max.connections.creation.rate` — **数だけでなく作成レートにも上限がある。**

大量のクライアントが同時に再接続してくる (ブローカーの再起動直後など) と、TLS ハンドシェイクだけで CPU が飽和する。**レート制限がないと、再起動から回復できなくなる。**

### 新しいコネクションの割り当て

```scala title="core/src/main/scala/kafka/network/SocketServer.scala"
private def assignNewConnection(socketChannel: SocketChannel, processor: Processor, mayBlock: Boolean): Boolean = {
  if (processor.accept(socketChannel, mayBlock, blockedPercentMeter)) {
```

[`SocketServer.scala#L709-L718`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/network/SocketServer.scala#L709-L718)。

Acceptor は Processor をラウンドロビンで回す。**まず全 Processor に `mayBlock = false` で試し、全部埋まっていたら `mayBlock = true` で待つ**という 2 周構成になっている。

`blockedPercentMeter` で「Acceptor がブロックされた時間の割合」を計測している。**ここでもバックプレッシャが観測可能になっている。**

## なぜそうなっているか

### 「1 コネクション 1 リクエスト」が 3 つの問題を同時に解く

mute の仕組みは単純だが、効果が広い。

**1. 順序保証。** ブローカーが同時に 1 リクエストしか処理しないので、**応答の順序が必ずリクエストの順序と一致する。** 並行処理して順序を戻す仕組みが要らない。

[プロデューサの `max.in.flight.requests.per.connection`](../sender-inflight/) が順序を保証できるのは、この性質があるからだ。クライアントは 5 個まで送れるが、**サーバは 1 個ずつ処理して順に返す。**

**2. コネクションごとのフェアネス。** 1 つのクライアントが 1000 個のリクエストを一気に送っても、キューに入るのは 1 個だけ。**残りは TCP バッファに溜まる。** キューが 1 クライアントに占領されない。

**3. メモリの上限。** コネクションごとに読み込み中のリクエストが 1 個以下なので、`コネクション数 × 最大リクエストサイズ` が上限になる。

**1 つのメカニズムで 3 つの性質が出るのは、性質が同じ原因から来ているからだ。** どれも「1 コネクションが同時に占有できるリソース」の話になっている。

### なぜリクエストを捨てないのか

多くのサーバは、キューが満杯になったら 503 を返すか、コネクションを切る。Kafka は **読むのをやめるだけ**だ。

理由は、**クライアントがリトライしてくるから**だ。捨てても、クライアントは同じリクエストを送り直す。**負荷は減らず、無駄なラウンドトリップが増える。**

読まなければ、TCP の受信ウィンドウが埋まり、クライアントの `send` がブロックされる。**クライアント側で自然に流量が絞られる。**

これが成立するのは、**Kafka のクライアントが「待てる」から**だ。プロデューサはバッファに溜め、コンシューマは次のポーリングまで待つ。**エンドユーザーのリクエストが直接ぶら下がっている HTTP サーバとは要求が違う。**

### なぜスレッドを 3 段に分けるのか

分ける境界は、**「そこで待つ可能性があるか」**で決まっている。

| 段        | 待つもの                                         | だから                               |
| --------- | ------------------------------------------------ | ------------------------------------ |
| Acceptor  | accept のみ                                      | 1 本で足りる                         |
| Processor | ネットワーク I/O (ノンブロッキング)              | **待たない。** N 本で CPU を使い切る |
| Handler   | ディスク I/O、ロック、[purgatory](../purgatory/) | **待つ。** M 本必要                  |

**Processor は待たない設計になっている**ので、コア数程度 (`num.network.threads`、既定 3) で足りる。Handler は待つので多め (`num.io.threads`、既定 8) にする。

**もし Processor が待つと、その selector が担当する全コネクションが止まる。** だから Processor の中で待つ処理を書いてはいけない — という制約が、この構成から導かれる。

### mute の状態が enum なのはなぜか

`ChannelMuteEvent` は `REQUEST_RECEIVED`、`RESPONSE_SENT`、`THROTTLE_STARTED`、`THROTTLE_ENDED` の 4 つを持つ。

単純な boolean にすると、**「処理中だから mute」と「スロットリング中だから mute」が区別できない。** 応答を送り終えたときに unmute すると、スロットリングが効かなくなる。

**理由が複数ある状態は、boolean ではなく状態機械にする。** 参照カウントでもよいが、状態機械のほうが「今どういう理由で止まっているか」がデバッグ時に分かる。

## どう活かすか

**「リクエストを受け付けたら、そのコネクションを読み取り対象から外す」は、順序保証・フェアネス・メモリ上限を 1 つの仕掛けで得る強い手だ。** HTTP/1.1 のパイプラインや、独自のバイナリプロトコルを実装するときに使える。**代償は、1 コネクションのスループットが RTT に律速されること。** Kafka はクライアント側で複数リクエストをバッファし、サーバ側で 1 つずつ処理するので、パイプライン化の恩恵は受けつつ順序も守れている。

**「過負荷時にエラーを返さず、読むのをやめる」という選択は、クライアントが待てる場合には最善だ。** TCP のフロー制御がそのままバックプレッシャになり、追加の仕組みが要らない。**判断基準は「クライアントがリトライするか」で、リトライするなら捨てるのは無意味な仕事を増やすだけになる。** 逆に、人間が待っている HTTP リクエストなら、早く失敗させたほうがよい。

**「件数の上限とバイト数の上限を両方持つ」は、リクエストサイズの分散が大きいときに必須になる。** 片方だけだと、必ずもう一方で溢れる。**そして、上限に当たっている時間を必ずメトリクスにする。** Kafka は `MemoryPoolAvgDepletedPercent` と Acceptor の `blockedPercent` の両方を出している。**バックプレッシャは「効いているのに気づかれない」のが一番まずい。**

**スレッドプールを分ける境界は、「待つか待たないか」で引く。** 待たない層は少数のスレッドで CPU を使い切れ、待つ層は待ちの数だけスレッドが要る。**両者を混ぜると、待たないはずの処理が待ちに巻き込まれる。** そして、待たない層のコードには「ここで待つ処理を書いてはいけない」という制約が生まれるので、それを書き残す。

**「複数の理由で止まりうる状態は、boolean ではなく状態機械にする」も覚えておきたい。** 理由が 2 つになった瞬間に boolean は破綻し、たいてい「片方の理由が消えたら全部解除される」というバグになる。
