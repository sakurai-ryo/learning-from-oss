---
title: "gRPC の上に、自前のストリームとコールバックを作る"
description: "transfer service は 1 回の RPC で完結するが、その裏で進捗の通知、認証情報の問い合わせ、tar のアップロードが双方向に流れる。containerd はそれを、別サービスで管理される名前付きストリームに載せた。フロー制御は自前のウィンドウ更新で行い、ストリームの寿命はリースが管理する。"
group: "イメージを取り込む"
sidebar:
  order: 26
---

## 何を学んだか

### 1 回の RPC では足りないもの

`Transfer(source, destination)` は 1 回呼んで終わりだが、pull の実行中には双方向のやり取りが要る。

- **進捗** — サーバ → クライアント。「layer 3 を 40% 取得した」
- **認証情報** — サーバ → クライアント → サーバ。「このレジストリの資格情報をくれ」
- **バイナリストリーム** — import なら クライアント → サーバ (tar を流す)、export なら逆

これらを `Transfer` の gRPC ストリームに混ぜることもできたが、containerd は **別サービスの名前付きストリーム** に切り出した。

### 名前で参照するストリーム

やり方はこうだ。

1. クライアントが streaming service でストリームを作り、**ID を得る**
2. `TransferRequest` に「進捗はこの ID のストリームへ」と ID だけを載せる
3. サーバは ID からストリームを引いて、そこにメッセージを流す

`TransferOptions.progress_stream` が文字列 1 個なのは、これが ID だからだ。

この間接化によって、**転送 API 自体はストリームの詳細を知らない** で済む。新しい種類のコールバック (認証、検証) を足すときも、`TransferRequest` に ID フィールドを 1 つ増やすだけになる。

### Go のインターフェースからは見えない

クライアント側の Go API では、進捗はただのコールバック関数だ。

```go
type ProgressFunc func(Progress)
```

ストリームの生成も ID の受け渡しも、proto へのマーシャル処理の中に隠れている。

```markdown title="docs/transfer.md"
Streaming is used by the transfer service to send or receive data streams as part of an operation as well as to handle callbacks (synchronous or asynchronous). The streaming protocol should be invisible to the client Go interface.
```

### フロー制御は自前

gRPC にもフロー制御はあるが、この層では **アプリケーションレベルのウィンドウ更新** を実装している。受け手が「あと N バイト受け取れる」と送り、送り手はその範囲でだけデータを流す。

```proto
message Data {
	bytes data = 1;
}

message WindowUpdate {
	int32 update = 1;
}
```

## ソースコードのどこか

### ストリームの抽象は 3 メソッド

[`core/streaming/streaming.go#L21-L45`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/streaming/streaming.go#L21-L45)。

```go title="core/streaming/streaming.go"
type StreamManager interface {
	StreamGetter
	Register(context.Context, string, Stream) error
}

type Stream interface {
	// Send sends the object on the stream
	Send(typeurl.Any) error

	// Recv receives an object on the stream
	Recv() (typeurl.Any, error)

	// Close closes the stream
	Close() error
}
```

運ぶのは `typeurl.Any`。つまり **型付きの任意のメッセージ** で、進捗も window update も認証応答も同じストリームの語彙で流せる。

### 管理はメモリ上のマップ、寿命はリース

[`plugins/streaming/manager.go#L44-L92`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/streaming/manager.go#L44-L92)。

```go title="plugins/streaming/manager.go"
type streamManager struct {
	// streams maps namespace -> name -> stream
	streams map[string]map[string]*managedStream

	byLease map[string]map[string]map[string]struct{}

	rwlock sync.RWMutex
}

func (sm *streamManager) Register(ctx context.Context, name string, stream streaming.Stream) error {
	ns, _ := namespaces.Namespace(ctx)
	ls, _ := leases.FromContext(ctx)
```

ストリームは namespace ごとに名前で管理される。そして **リース ID でも索引される**。

```go title="plugins/streaming/manager.go"
			md.(*metadata.DB).RegisterCollectibleResource(metadata.ResourceStream, sm)
```

streaming manager は自分を **GC の対象資源** として登録する。リースが消えたら、そのリースに属するストリームも回収される。

メモリ上のオブジェクトを、ディスク上の資源と同じ GC の仕組みで管理しているのが面白い。「参照されなくなったら消す」というモデルが、揮発的な資源にも適用されている ([tri-color の mark & sweep](../tricolor-gc/))。

### ウィンドウ制御の実装

[`core/transfer/streaming/stream.go#L36-L110`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/transfer/streaming/stream.go#L36-L110)。

```go title="core/transfer/streaming/stream.go"
const maxRead = 32 * 1024
const windowSize = 2 * maxRead

var bufPool = &sync.Pool{
	New: func() any {
		buffer := make([]byte, maxRead)
		return &buffer
	},
}
```

1 回に読むのは 32 KB、ウィンドウは 64 KB。バッファは `sync.Pool` で使い回す。

送信側は 2 つの goroutine で動く。1 つはウィンドウ更新を受け取り続ける。

```go title="core/transfer/streaming/stream.go"
			switch v := i.(type) {
			case *transferapi.WindowUpdate:
				select {
				case <-ctx.Done():
					return
				case window <- v.Update:
				}
			default:
				log.G(ctx).Errorf("unexpected stream object of type %T", i)
			}
```

もう 1 つが実際に送る。

```go title="core/transfer/streaming/stream.go"
		for {
			if remaining > 0 {
				// Don't wait for window update since there are remaining
				select {
				case <-ctx.Done():
					return
				case update := <-window:
					remaining += update
				default:
				}
			} else {
				// Block until window updated
				select {
				case <-ctx.Done():
					return
				case update := <-window:
					remaining = update
				}
			}
```

**残量があれば非ブロッキングで更新を吸い、なければブロックして待つ**。`select` の `default` 節の有無だけで、2 つの振る舞いを切り替えている。Go のチャネルらしい書き方だ。

`// TODO: Send error message on stream before close to allow remote side to return error` というコメントが 2 か所にある。現状はコンテキストのキャンセル時に黙って閉じるので、受信側は「なぜ切れたか」が分からない。既知の課題として残されている。

## なぜそうなっているか

### RPC とデータの経路を分ける

`Transfer` を双方向ストリーミング RPC にすると、リクエストの意味 (source/destination) とデータの流れが 1 つのストリームに混在する。プロトコルが複雑になり、進捗だけ購読する、といった分離ができなくなる。

ストリームを外に出すと、

- `Transfer` は単純な unary RPC のまま
- 進捗だけ欲しい、認証だけ必要、という組み合わせが自由になる
- ストリームの管理 (寿命、名前空間、GC) を 1 か所にまとめられる

### ttrpc でも動くようにするため

[`docs/transfer.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/transfer.md) にこうある。

```markdown title="docs/transfer.md"
To accomplish this, the transfer service makes use of the streaming service to allow binary and object streams to be accessible by transfer objects even when using grpc and ttrpc.
```

ttrpc は shim との通信に使われる軽量な RPC で、gRPC のフル機能 (双方向ストリーミング、フロー制御) を持たない。**共通の下地として自前のストリームを作れば、両方で同じコードが動く**。

自前のフロー制御が必要な理由もここにある。gRPC の HTTP/2 フロー制御に頼ると、ttrpc では効かない。

### 32 KB / 64 KB という値

`maxRead = 32KB` はパイプやソケットの典型的なバッファサイズに近く、ウィンドウをその 2 倍にすることで「送信中に次の許可が届く」パイプライン化が成立する。

小さすぎると往復が増え、大きすぎるとメモリを食う。ローカルの Unix ソケット越しの通信なので、レイテンシは小さく、この程度で十分という判断だ。

## どう活かすか

### 進捗が出ないときに見るところ

`ctr images pull` の進捗が止まって見える場合、実際にダウンロードが止まっているのか、進捗ストリームが切れているのかを区別したい。

```sh
# content の ingest が進んでいるか (offset が増えるか)
$ watch -n1 'ctr -n k8s.io content active'
```

`offset` が増えていれば転送は生きている。進捗表示だけの問題なら、ストリームの切断が疑わしい。

### RPC の上にストリームを載せる設計

自前のプロトコルで同じことをするときの要点は 4 つ。

- **ストリームを ID で参照する** — メッセージにストリームそのものを埋め込まない
- **運ぶものは型付きの任意メッセージにする** — 用途ごとに別の仕組みを作らない
- **フロー制御を自分で持つ** — 下位のトランスポートに依存しないなら必須
- **寿命を既存の資源管理に乗せる** — containerd はリースと GC を再利用した

4 番目を怠ると、「クライアントが死んだのにサーバ側のストリームが残る」というリークが起きる。containerd がストリームを GC の対象資源として登録しているのは、この問題への直接の答えになっている。
