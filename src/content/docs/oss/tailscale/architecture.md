---
title: "Tailscale のアーキテクチャを一枚で読む"
description: "control server は鍵と経路情報だけを配り、パケットには一切触らない。ノードの中では tailscaled という 1 プロセスが、制御プレーンのクライアント・WireGuard エンジン・OS のネットワーク設定を束ねる。通信は control / disco / WireGuard の 3 層に分かれ、3 つとも別の鍵で暗号化される。"
group: "前提"
sidebar:
  order: 1
---

## 何を学んだか

### Tailscale が解いている問題

「A というマシンから B というマシンへ、途中の NAT やファイアウォールを気にせず直接パケットを送りたい」。VPN 製品はこれを **中央のコンセントレータ** で解く。全員が VPN ゲートウェイに接続し、そこを経由して互いに通信する。設定は単純だが、全トラフィックが 1 箇所を通るのでそこが帯域と障害の集中点になる。

Tailscale は **メッシュ** で解く。ノードどうしが直接 UDP で繋がる。ただし「直接繋がる」は簡単ではない。両者が NAT の内側にいれば、互いの外から見えるアドレスすら分からない。

そこで Tailscale は問題を 2 つに割る。

- **誰と繋いでよいか、相手の公開鍵と候補アドレスは何か** — これは中央のサーバ (coordination server、コードでは control) が答える。
- **その候補のどれが実際に通るか、通らないときどうするか** — これはノードどうしが自分で決める。

### 制御プレーンとデータプレーンが完全に分かれている

重要なのは、**control server はパケットの中身を一切見ない** ことだ。control が配るのは「この tailnet には誰がいて、公開鍵はこれで、UDP の候補アドレスはこれ」というメタデータだけである。実際の通信は WireGuard で暗号化され、ノードどうしのあいだで直接やりとりされる。control は WireGuard の秘密鍵を持たないので、経路上にいても復号できない。

直接繋がらない場合の中継 (DERP) も、control server とは別のサーバ群だ。そして DERP サーバも中身は読めない。中継しているのは WireGuard で暗号化済みのパケットだからだ。

### ノードの中は 1 プロセス + 3 つの部品

`tailscaled` という 1 つのデーモンが動く。その中は大きく 3 つに分かれる。

| 部品                       | パッケージ                   | 役割                                                         |
| -------------------------- | ---------------------------- | ------------------------------------------------------------ |
| 制御プレーンのクライアント | `control/controlclient`      | control server と喋り、netmap を受け取る                     |
| データプレーン             | `wgengine`                   | WireGuard と、その下の `magicsock`                           |
| OS 統合                    | `wgengine/router`, `net/dns` | ルーティングテーブル、ファイアウォール、DNS 設定を書き換える |

この 3 つを束ねて状態機械を回すのが `ipn/ipnlocal` の `LocalBackend` だ。ユーザーから見える `tailscale up` や `tailscale status` は、この `LocalBackend` に対する **LocalAPI** (UNIX ソケット上の HTTP) の呼び出しになる。

### 通信は 3 層あり、それぞれ別の鍵を使う

Tailscale のノードが喋るプロトコルは 3 つある。

1. **control プロトコル** — Noise で暗号化した HTTP。`machine key` で認証する。
2. **disco プロトコル** — 経路探索用。NaCl box で暗号化した UDP。`disco key` で暗号化する。
3. **WireGuard** — 実データ。`node key` で暗号化する。

同じ 2 台のあいだで disco と WireGuard が同じ UDP ソケット・同じポートを流れる。受信側は先頭バイトを見て「これは disco か、WireGuard か」を振り分ける。鍵が 3 つに分かれている理由は [鍵のページ](../keys/) で扱う。

### 全体の流れ

```text
                  ┌──────────────────────────┐
                  │  control server          │  ← 鍵と経路のメタデータだけ
                  │ (controlplane.tailscale) │
                  └────────────┬─────────────┘
                       Noise over HTTP (long poll)
                               │  netmap
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼─────┐          ┌─────▼────┐           ┌─────▼────┐
   │ tailscaled│          │tailscaled│           │tailscaled│
   │  ノード A │          │ ノード B │           │ ノード C │
   └────┬─────┘          └─────┬────┘           └──────────┘
        │                      │
        │  ① disco で経路を探す (UDP)
        │  ② 通ったら WireGuard で直接 (UDP)
        └──────────────────────┘
        │                      │
        │  ③ 通らなければ DERP 経由
        └────► ┌──────────┐ ◄──┘
               │   DERP   │  ← 暗号化済みパケットを中継するだけ
               └──────────┘
```

## ソースコードのどこか

### 状態機械の中心

```go title="ipn/ipnlocal/local.go"
// LocalBackend is the glue between the major pieces of the Tailscale
// network software: the cloud control plane (via controlclient), the
// network data plane (via wgengine), and the user-facing UIs and CLIs
// (collectively called "frontends", via LocalBackend's implementation
// of the Backend interface).
//
// LocalBackend implements the overall state machine for the Tailscale
// application. Frontends, controlclient and wgengine can feed events
// into LocalBackend to advance the state machine, and advancing the
// state machine generates events back out to zero or more components.
type LocalBackend struct {
```

[`local.go#L220-L230`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/local.go#L220-L230)。

**「glue (糊)」と自称している。** イベントを入れると状態が進み、状態が進むと 0 個以上のコンポーネントにイベントが出ていく。制御プレーンからの netmap 更新も、ユーザーの `tailscale up` も、Wi-Fi が切れたという通知も、すべてここに集まる。

このパッケージ (`ipn/ipnlocal`) は 2 万行あり、Tailscale で最も大きい単一パッケージだ。**中心に大きな状態機械を置き、周りの部品は状態を持たない** という構造になっている。

### データプレーンの組み立て

```go title="wgengine/userspace.go"
func NewUserspaceEngine(logf logger.Logf, conf Config) (_ Engine, reterr error) {
	...
	if conf.Tun == nil {
		logf("[v1] using fake (no-op) tun device")
		conf.Tun = tstun.NewFake()
	}
	if conf.Router == nil {
		logf("[v1] using fake (no-op) OS network configurator")
		conf.Router = router.NewFake(logf)
	}
	if conf.DNS == nil {
		logf("[v1] using fake (no-op) DNS configurator")
		d, err := dns.NewNoopManager()
		...
	}
```

[`userspace.go#L303-L330`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/userspace.go#L303)。

**TUN デバイスも、ルーティング設定も、DNS 設定も、no-op 実装に差し替えられる。** これはテストのためだけではない。`tsnet` (ライブラリとして Tailscale を埋め込むモード) や、コンテナ内で権限がない場合には、実際に no-op が使われる。**OS を触る部分がすべてインターフェース越しになっている**のは、Tailscale が Linux・macOS・Windows・iOS・Android・Plan 9 で動くための前提だ。

エンジンが抱えるものは次のとおり。

```go title="wgengine/userspace.go"
type userspaceEngine struct {
	...
	tundev         *tstun.Wrapper
	wgdev          *device.Device
	router         router.Router
	dialer         *tsdial.Dialer
	dns            *dns.Manager
	magicConn      *magicsock.Conn
	netMon         *netmon.Monitor
	health         *health.Tracker
```

`wgdev` が wireguard-go の `device.Device` で、`magicConn` がその下に差し込まれる自前の UDP 実装だ。この 2 つの関係が Tailscale の中核で、[magicsock のページ](../magicsock/) で扱う。

### 世界の状態は 1 つの構造体

```go title="types/netmap/netmap.go"
// NetworkMap is the current state of the world.
//
// The fields should all be considered read-only. They might
// alias parts of previous NetworkMap values.
type NetworkMap struct {
	Cached bool

	SelfNode tailcfg.NodeView
	AllCaps  set.Set[nodecap.Cap]
	NodeKey  key.NodePublic
	MachineKey key.MachinePublic

	Peers []tailcfg.NodeView // sorted by Node.ID
	DNS   tailcfg.DNSConfig

	PacketFilter      []filtertype.Match
	PacketFilterRules views.Slice[tailcfg.FilterRule]
	SSHPolicy         *tailcfg.SSHPolicy
	...
	DERPMap *tailcfg.DERPMap
```

[`netmap.go#L26-L60`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/types/netmap/netmap.go#L26)。

**"the current state of the world" (世界の現在の状態)。** ピア一覧・DNS 設定・パケットフィルタ・SSH ポリシー・DERP サーバの一覧が、1 つの構造体に入っている。control から来るものは基本的に全部これで、ノードの挙動はこれを見て決まる。詳しくは [netmap のページ](../netmap/) で扱う。

### WireGuard とは別のプロトコル

```go title="disco/disco.go"
// Package disco contains the discovery message types.
//
// A discovery message is:
//
// Header:
//
//	magic          [6]byte  // “TS💬” (0x54 53 f0 9f 92 ac)
//	senderDiscoPub [32]byte // nacl public key
//	nonce          [24]byte
//
// The recipient then decrypts the bytes following (the nacl box)
// and then the inner payload structure is:
//
//	messageType     byte  (the MessageType constants below)
//	messageVersion  byte  (0 for now; but always ignore bytes at the end)
//	message-payload [...]byte
package disco
```

[`disco.go#L1-L20`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/disco/disco.go#L1-L20)。

WireGuard が流れるのと同じ UDP ソケットに、**マジックナンバー `TS💬` で始まる別のプロトコル** が混ざって流れる。これが経路探索の本体だ。[disco のページ](../disco-protocol/) で扱う。

## なぜそうなっているか

### なぜ control にパケットを通さないのか

理由は 3 つある。

**1. 帯域のコストが線形に増えない。** 全トラフィックが中央を通る設計だと、ユーザー数に比例して帯域が要る。Tailscale の control server が扱うのはメタデータだけなので、ノードが何 GB 転送しようと control の負荷は変わらない。

**2. 障害の影響範囲が小さい。** control server が落ちても、**すでに確立している接続は切れない**。netmap の更新が止まるだけで、既知のピアへのパケットは流れ続ける。これは「制御プレーンとデータプレーンを分ける」設計から自動的に出てくる性質だ。

**3. サービス提供者がトラフィックを見られない。** WireGuard の秘密鍵はノードにしかない。control server を運営する Tailscale 社自身が、ユーザーのパケットを復号できない。

代償もある。**control server は「誰と誰が繋がってよいか」を決める絶対的な権限を持つ。** 悪意ある control server は、偽のノードを netmap に混ぜ込むことで自分を tailnet の一員にできてしまう。この穴を塞ぐのが [tailnet lock](../tailnet-lock/) で、control が配る netmap に別の署名チェーンを重ねる。

### なぜ状態機械を 1 箇所に集めるのか

Tailscale のノードには、独立に変化するイベント源が多い。

- control からの netmap 更新 (long poll でいつでも来る)
- ユーザーの操作 (`tailscale up/down`、設定変更)
- ネットワークの変化 (Wi-Fi から LTE、スリープからの復帰)
- ピアの状態変化 (直結できた、切れた、DERP に落ちた)
- OS の状態変化 (ログイン/ログアウト、DNS 設定の外部からの変更)

これらが独立にコンポーネントを叩くと、「netmap 更新の途中でユーザーが down した」「ルート設定中にリンクが変わった」といった組み合わせが指数的に増える。`LocalBackend` に全部集めて 1 つのミューテックスで直列化すると、**組み合わせの爆発が「状態機械の状態数」に閉じ込められる**。

その代償として `LocalBackend` は 2 万行に膨れ、ロック順序の規約がコメントで大量に書かれている。これは意図的な集中であって、事故ではない。

### なぜ 3 つのプロトコルが必要か

WireGuard 1 つで済ませられないのは、WireGuard が **「相手の UDP エンドポイントを知っている」ことを前提にしたプロトコル** だからだ。WireGuard の設定ファイルには `Endpoint = 1.2.3.4:51820` と書く。これが分からない状況を WireGuard 自身は解けない。

そこで Tailscale は、WireGuard の下に「エンドポイントを決める層」を挟む。その層が独自のメッセージを交換する必要があり、それが disco になった。**disco を WireGuard の中 (トンネルの内側) に入れなかったのは、トンネルが張れていない状態でも喋る必要があるから** だ。

control プロトコルが別なのも同じ理屈で、**まだ誰のことも知らない状態で喋れる必要がある**。

## どう活かすか

**「メタデータの配布」と「データの転送」を別のシステムに分ける設計は、P2P 的なものを作るときの基本形として持っておける。** 中央サーバは前者だけを担い、後者には関与しない。こうすると中央サーバのコストがトラフィック量から独立し、障害時にも既存の接続が生き残る。分散ストレージ、ビデオ会議、ゲームのマッチメイキングなど、適用先は広い。

**逆に、この分離が向かないのは「中央でトラフィックを検査・記録する必要がある」場合だ。** データプレーンを通らない設計は、そもそも中央で監査ログを取れない。Tailscale もデータプレーンの監査ログは各ノードに記録させる ([netlog](../netlog/)) 形にしており、中央集約と引き換えに得た性質をそのまま引きずっている。

**「OS を触る部分をすべてインターフェースにし、no-op 実装を用意する」のは、移植性を保つための実務的な型として使える。** テスト用のモックとしてだけでなく、権限が足りない環境で機能を落として動かす経路にもなる。Tailscale ではこれが `tsnet` という別の製品形態を生んでいる。

**状態機械を 1 箇所に集める判断は、コンポーネント数ではなくイベント源の数で考えるとよい。** 独立なイベント源が 5 個あって互いに順序の制約があるなら、それぞれのコンポーネントにロックを配るより、1 つの直列化点を作るほうが結果的に読みやすい。ただしその 1 箇所は必ず大きくなる。それを許容できるかが分かれ目になる。
