---
title: "UDP を束ねて送り、システムコールを減らす"
description: "sendmmsg で複数のパケットを 1 回のシステムコールで送り、UDP GSO でカーネルに分割させる。だが Linux の GSO には「全フラグメントが同じ長さだと踏むバグ」があり、その回避策は 1 バイトのダミーを末尾に足すこと。しかもその回避策は control server から切り替えられる。"
group: "データパス"
sidebar:
  order: 24
---

## 何を学んだか

### 1 パケット 1 システムコールでは足りない

VPN のデータパスは、パケットごとに `sendto`/`recvfrom` を呼ぶのが素朴な実装だ。だが 1 Gbps を 1400 バイトのパケットで流すと、**毎秒 9 万回のシステムコール** になる。

Linux には 3 段階の緩和策がある。

| 手法                    | 効果                                                     |
| ----------------------- | -------------------------------------------------------- |
| `sendmmsg` / `recvmmsg` | 複数のパケットを 1 回のシステムコールで処理              |
| UDP GSO (送信)          | 大きなバッファを渡し、**カーネルに分割させる**           |
| UDP GRO (受信)          | 連続する同サイズのパケットを、カーネルが**まとめて渡す** |

`net/batching` はこの 3 つを使う `nettype.PacketConn` の実装だ。

### バッチ化すると単発の読み取りができなくなる

GRO で受け取ったバッファは、**複数のデータグラムが連結されたもの** かもしれない。「1 回の読み取り = 1 個のデータグラム」という前提が崩れる。

だから `ReadFromUDPAddrPort` は **常にエラーを返す**。

### カーネルのバグを 1 バイトで回避する

Linux の UDP GSO には、**「バッチ内の全フラグメントが同じ長さだと踏むバグ」** がある。

回避策は、**末尾に 1 バイトのダミーパケットを足して、最後のフラグメントだけ短くする** こと。そのダミーは `0x07` の 1 バイトで、受信側では WireGuard のパケットとして扱われ、短すぎるので黙って捨てられる。

そして **この回避策の有効・無効は control server から切り替えられる**。

## ソースコードのどこか

### バッチの上限

```go title="net/batching/conn_linux.go"
	// This was initially established for Linux, but may split out to
	// GOOS-specific values later. It originates as UDP_MAX_SEGMENTS in the
	// kernel's TX path, and UDP_GRO_CNT_MAX for RX.
	//
	// As long as we use one fragment per datagram, this also serves as a
	// limit for the number of fragments we can coalesce during scatter-gather writes.
	//
	// 64 is below the 1024 of IOV_MAX (Linux) or UIO_MAXIOV (BSD),
	// and the 256 of WSABUF_MAX_COUNT (Windows).
	//
	// (2026-04) If we begin shipping datagrams in more than one fragment,
	// an independent fragment count limit needs to be implemented.
	udpSegmentMaxDatagrams = 64
```

[`conn_linux.go#L93-L108`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn_linux.go#L93-L108)。

**1 つの定数に、4 つの由来が書かれている。** Linux の `UDP_MAX_SEGMENTS` (送信側)、`UDP_GRO_CNT_MAX` (受信側)、そして `IOV_MAX` (1024)、`WSABUF_MAX_COUNT` (256) より小さいこと。

**「なぜ 64 か」に対して「4 つの上限すべてを下回るから」と答えられる。** さらに「1 データグラムを複数フラグメントで送るようになったら、別の上限が要る」という将来の注意まで書いてある。

### 単発読み取りを禁止する

```go title="net/batching/conn.go"
// Conn is a [nettype.PacketConn] that provides batched i/o using
// platform-specific optimizations, e.g. {recv,send}mmsg & UDP GSO/GRO.
//
// Conn does not support single packet reads (see ReadFromUDPAddrPort docs). It
// is the caller's responsibility to use the appropriate read API where a
// [nettype.PacketConn] has been upgraded to support batched i/o.
type Conn interface {
	nettype.PacketConn
	// ReadFromUDPAddrPort always returns an error, as UDP GRO is incompatible
	// with single packet reads. A single datagram may be multiple, coalesced
	// datagrams, and this API lacks the ability to pass that context.
	//
	// TODO: consider detaching Conn from [nettype.PacketConn]
	ReadFromUDPAddrPort([]byte) (int, netip.AddrPort, error)
```

```go title="net/batching/conn_linux.go"
func (c *linuxBatchingConn) ReadFromUDPAddrPort(p []byte) (n int, addr netip.AddrPort, err error) {
	return 0, netip.AddrPort{}, errors.New("single packet reads are unsupported")
}
```

[`conn.go#L34-L52`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn.go#L34-L52) と [`conn_linux.go#L79-L81`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn_linux.go#L79-L81)。

**インターフェースを満たすために実装するが、常に失敗する。** そして TODO には「`nettype.PacketConn` から切り離すことを検討」とある。

これは **Liskov の置換原則を破っている** — `nettype.PacketConn` として渡された `Conn` は、`ReadFromUDPAddrPort` が動くと思われるが動かない。

だが実際問題として、[magicsock](../magicsock/) は `TryUpgradeToConn` でアップグレードした場合にだけバッチ API を使う。**呼び出し側が型を知っている前提** で、契約違反を許容している。TODO に「切り離すべき」と書かれているので、意図的な妥協だと分かる。

### バッチサイズはメモリと引き換え

```go title="net/batching/conn.go"
// BatchSizeFromEnv returns ideal, unless the TS_DEBUG_WG_BATCH_SIZE
// environment variable is set to a positive integer, in which case it returns
// that value clamped to [1, ideal].
//
// Batch size determines how much packet memory wireguard-go pins per reader
// goroutine (batch size × 64 KiB message buffers per reader, ~32 MiB total at
// the Linux default of 128), so memory-budget tests set the env var to 1 to
// approximate the configuration used on memory-constrained (mobile)
// platforms, where batch size is always 1.
func BatchSizeFromEnv(ideal int) int {
```

[`conn.go#L12-L21`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn.go#L12-L21)。

**バッチサイズ 128 で 32 MiB のメモリが固定される。** バッチサイズ × 64 KiB × リーダー goroutine 数。

だからモバイルではバッチサイズが常に 1 だ。**スループットとメモリのトレードオフが、1 つの数値に集約されている。** そして環境変数で 1 に落とせるのは、**メモリ予算のテストのため** と明記されている。

### カーネルバグの回避

```go title="net/batching/conn_linux.go"
// neverGSOEqualTailSentinelPayload is appended to UDP GSO packet batches under
// certain conditions in order to workaround Linux kernel UDP GSO bugs. In the
// case of magicsock, 0x07 is handled as WireGuard, and wireguard-go silently
// drops the packet as it's less than [device.MinMessageSize].
var neverGSOEqualTailSentinelPayload = []byte{0x07}
```

[`conn_linux.go#L116-L120`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn_linux.go#L116-L120)。

**回避策の設計が緻密だ。**

- 足すのは **1 バイト**。帯域のコストは無視できる
- 値は `0x07` で、**受信側で WireGuard のパケットとして解釈される**
- WireGuard の最小メッセージサイズ (32 バイト) より短いので、**wireguard-go が黙って捨てる**

つまり **「受信側に何の変更も要らない」**。既存の実装が、たまたま正しく無視してくれる値を選んでいる。

```go title="net/batching/conn_linux.go"
	maybeAppendSentinelTail := func() {
		if !neverGSOEqualTail || endBatchDueToSmallerTail {
			// If neverGSOEqualTail is unset we should never append a sentinel
			// payload as we are running on an unaffected kernel. Or, if we
			// already have a smaller-than-GSO sized tail, there is no need, since
			// the kernel bug we are avoiding only triggers when all fragments
			// are equal in length.
			return
		}
		msgs[base].Buffers = append(msgs[base].Buffers, neverGSOEqualTailSentinelPayload)
	}
```

[`conn_linux.go#L160-L170`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn_linux.go#L160)。

**バグの発火条件が「全フラグメントが同じ長さ」なので、既に末尾が短ければ何もしない。** 回避策を打つのは本当に必要なときだけだ。

### 回避策を遠隔で切り替える

```go title="net/batching/conn_linux.go"
	// neverGSOEqualTail, when non-nil and true, enables a sentinel-tail
	// workaround in the UDP GSO TX path. It points at a
	// [controlknobs.Knobs.NeverGSOEqualTail] field so the value can be
	// toggled live via the control plane without requiring a socket rebind.
	// It is read once per write at the top of [linuxBatchingConn.WriteBatchTo].
	neverGSOEqualTail *atomic.Bool
```

[`conn_linux.go#L63-L68`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn_linux.go#L63-L68)。

**カーネルのバグ回避を、control server から有効・無効にできる。** ソケットを張り直さずに切り替わる。

「どのカーネルバージョンが影響を受けるか」をクライアントに焼き込むと、**新しいカーネルでバグが再発したときに対応できない**。逆に、修正済みのカーネルで無駄な 1 バイトを足し続けることにもなる。

**[遠隔ノブ](../netmap-apply/)の使いどころとして、これは分かりやすい例だ。** 判断材料 (カーネルのバージョンごとの挙動) がサーバ側に集まり、クライアントは指示に従うだけでよい。

そして「書き込みごとに 1 回だけ読む」と明記されている。

```go title="net/batching/conn_linux.go"
// neverGSOEqualTail, when true, enables the sentinel-tail workaround. It is
// loaded by the caller and passed in so a single coalesceMessages call sees a
// consistent value even if the underlying control knob flips concurrently.
```

[`conn_linux.go#L135-L138`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn_linux.go#L135-L138)。

**atomic な値を関数の途中で複数回読むと、途中で値が変わりうる。** バッチの前半は回避策あり、後半はなし、という状態になると、サイズの計算が狂う。

だから **呼び出し側が 1 回読んで、引数として渡す**。関数の中で一貫した値が見える。

### 1 バイトのペイロードという境界条件

```go title="net/batching/conn_linux.go"
			// okToCoalesceWithSentinel ensures we never coalesce if a sentinel
			// 1-byte payload might be required, but gsoSize (or more specifically
			// UDP payload length) is also 1. The whole point of appending a sentinel
			// 1-byte payload is to append a smaller-than-GSO tail.
			//
			// This is defensive as a 1-byte payload, at the time of writing
			// (2026-05-28), is unlikely to occur. The smallest WireGuard
			// message size is 32 bytes ([device.MinMessageSize]), and the
			// [disco.Message] header is 62 bytes.
```

[`conn_linux.go#L182-L191`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn_linux.go#L182)。

**「GSO のセグメントサイズが 1 バイトだったら、1 バイトのダミーを足しても末尾が短くならない」** という境界条件。

そして **「防御的なコードだ。1 バイトのペイロードは現状ありえない — WireGuard の最小は 32 バイト、disco のヘッダは 62 バイト」** と、なぜ起きないかまで書いてある。日付つきで。

**起きないと分かっている条件に対処し、なぜ起きないかも書く。** 前提が変わったとき (新しいプロトコルが 1 バイトのメッセージを送るようになったら) に、このコードが効く。

### 受信キュー溢れを数える

```go title="net/batching/conn_linux.go"
	// readOpMu guards read operations that must perform accounting against
	// rxqOverflows in single-threaded fashion. There are no concurrent usages
	// of read operations at the time of writing (2026-03-09), but it would be
	// unidiomatic to push this responsibility onto callers.
	readOpMu     sync.Mutex
	rxqOverflows uint32 // kernel pumps a cumulative counter, which we track to push a clientmetric delta value
```

[`conn_linux.go#L70-L76`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/batching/conn_linux.go#L70-L76)。

**カーネルが「受信キューが溢れた回数」を累積値で教えてくれる** (`SO_RXQ_OVFL`)。それを差分にして [メトリクス](../reachability-observability/) に流す。

「パケットが落ちた」という事実は、アプリケーションからは見えない。**カーネルに聞かないと分からない情報を、明示的に取りに行っている。**

ミューテックスのコメントも実直だ。**「現時点では並行に呼ばれることはないが、その責任を呼び出し側に押し付けるのは Go らしくない」。**

## なぜそうなっているか

### なぜ GSO/GRO が効くのか

`sendmmsg` は「システムコールの回数」を減らすが、**カーネル内のパケット処理は 1 パケットずつ行われる**。ルーティングの検索、ネットフィルタの評価、NIC への転送。

UDP GSO は、**1 個の大きなバッファと「これを N バイトごとに分割せよ」という指示** をカーネルに渡す。カーネルは分割を、可能なら **NIC のハードウェアにやらせる**。つまりカーネル内の処理も 1 回で済む。

効果は大きい。GSO なしの `sendmmsg` に対して、さらに数倍のスループットが出る。

GRO は逆方向で、**NIC またはカーネルが連続する同サイズのパケットをまとめる**。受信側の処理回数が減る。

### なぜバッチ化すると単発読み取りが壊れるのか

GRO でまとめられたバッファは「1400 バイトのデータグラムが 8 個連結されたもの」だ。**どこで区切るかは、別途「セグメントサイズ」として伝えられる** (制御メッセージ経由)。

`ReadFromUDPAddrPort(p []byte) (int, netip.AddrPort, error)` という API には、セグメントサイズを返す場所がない。**戻り値の形が情報を運べない。**

だから「動くふりをする」のではなく、明示的にエラーにする。**間違って使われるくらいなら、必ず失敗するほうがよい。**

### なぜダミーの値が `0x07` なのか

受信側で、この 1 バイトは WireGuard のパケットとして [magicsock の振り分け](../magicsock/) を通る。disco でも STUN でもないので、WireGuard に渡される。

そして wireguard-go は、`device.MinMessageSize` (32 バイト) 未満のパケットを **黙って捨てる**。ログも出ない。

**「既存の実装が、たまたま正しく無視してくれる値」を選ぶ** ことで、受信側の変更が一切要らなくなった。プロトコルのバージョン交渉も、互換性の考慮も不要になる。

もし受信側にエラーログが出る値を選んでいたら、**全ユーザーのログが 1 バイトパケットの警告で埋まる** ことになった。

### なぜカーネルバグの回避を遠隔で切り替えるのか

カーネルのバグは、バージョンとディストリビューションの組み合わせで発現する。クライアントに「この範囲のバージョンなら回避する」と書き込むと、

- **新しいバージョンで再発したときに対応できない** (クライアントの更新が要る)
- **バックポートされた修正を検知できない** (ディストリビューションごとに違う)
- 判定を間違えると、**必要な環境で回避策が効かない**

サーバ側のノブなら、**観測結果に応じて即座に切り替えられる**。「この環境で問題が出た」という報告を受けて、その日のうちに全クライアントの挙動を変えられる。

代償は [前に述べたとおり](../netmap-apply/)、挙動がコードから読めなくなることだ。

### なぜ atomic を 1 回だけ読んで引数で渡すのか

`atomic.Bool` は「読むたびに最新の値が見える」。これは通常は利点だが、**1 つの処理の中で複数回読むと、途中で変わりうる**。

`coalesceMessages` は、最初に「回避策のぶんの余裕を確保する」計算をし、後で「実際に足すか」を判断する。この 2 箇所で値が違うと、**確保した余裕と実際の使用量がずれる**。バッファオーバーランかパケットの破損になる。

**「不変条件が必要な範囲」を関数の境界と一致させ、その入り口で 1 回だけ読む。** 引数として渡せば、関数内では値が変わりようがない。

### なぜ「起きないこと」に対処するのか

1 バイトのペイロードは現状ありえない。だがコードは対処している。

理由は 2 つ考えられる。

**1. 前提が変わりうる。** 新しいプロトコルが magicsock の上に載るかもしれない ([peer relay](../peer-relay/) がそうだったように)。そのとき、この境界条件を思い出せる人はいない。

**2. 失敗したときの症状が悪い。** サイズの計算が狂うと、パケットの破損や panic になる。**「ありえない」の判断が間違っていたときのコストが高い。**

コメントに **「なぜ現状ありえないか」を具体的な数値 (32 バイト、62 バイト) と日付で書いている** のが要点だ。前提が変わったかどうかを、後から検証できる。

## どう活かすか

**高頻度の I/O では、システムコールの回数とカーネル内の処理回数を別々に考える。** バッチ API (`sendmmsg`) は前者を、オフロード (GSO/GRO) は後者を減らす。両方使えるなら両方使う。効果の桁が違う。

**バッチ化で壊れる API は、動くふりをせずに必ず失敗させる。** 「1 回の読み取り = 1 個のメッセージ」という前提が崩れるなら、その前提の API はエラーを返す。インターフェースを満たすためだけに実装し、TODO に「本来は分離すべき」と書く。

**バッチサイズは、スループットとメモリの直接のトレードオフになる。** 「バッチサイズ × バッファサイズ × goroutine 数」を計算して、その値をコメントに書く。メモリ制約のある環境向けに、1 に落とせる経路を用意する。

**外部のバグへの回避策は、「相手を変更しなくて済む形」を探す。** 1 バイトのダミーが「既存の受信実装がたまたま無視する値」であることで、片側の変更だけで完結した。プロトコルの変更や、両端の同時更新が要らない。

**環境依存の回避策は、遠隔で切り替えられるようにする。** カーネル、ドライバ、ミドルボックスのバグは、バージョンとベンダの組み合わせで発現する。クライアント側の判定は必ず外れる。サーバ側のノブなら、観測に応じて即座に変えられる。

**atomic な値を関数内で複数回参照しない。入り口で 1 回読んで引数で渡す。** 「一貫した値が見える範囲」を関数の境界と一致させる。これは lock-free なコードでの基本形で、忘れると再現困難なバグになる。

**「ありえない」条件に対処するときは、なぜありえないかを数値と日付つきで書く。** 前提が変わったかを後から検証できる。そして防御的なコードだと明記しておけば、読む人が「これは何のため」と悩まずに済む。
