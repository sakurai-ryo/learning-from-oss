---
title: "NAT をシミュレートしてテストする"
description: "「easy NAT の内側と hard NAT の内側で直結できるか」を、VM も root 権限もなしに検証する。NAT の種類は 4 つ実装され、ポートの探索は素朴なループ — 「テストでしか使わないので性能は気にしない、これで十分」とコメントされている。control server の最小実装も 57 KB ある。"
group: "実装の作法"
sidebar:
  order: 46
---

## 何を学んだか

### NAT 越えのテストは難しい

[NAT 越え](../netcheck/)の正しさを確かめるには、**実際に違う種類の NAT の内側にノードを置く** 必要がある。

- easy NAT (Endpoint-Independent Mapping) の内側 2 台
- easy NAT と hard NAT (Address-Dependent Mapping)
- 両方が hard NAT
- CGNAT の多段
- IPv6 だけ、IPv4 だけ

**実機で組むには、ルータとマシンが何台も要る。** CI で回すのは非現実的だ。

### メモリ上に仮想インターネットを作る

`tstest/natlab` のドキュメント。

> **natlab は、VM を動かすことも root 権限も必要とせず、すべてメモリ上で異なる種類のネットワークをシミュレートできるようにする。名前に反して NAT 以外のこともするが、NAT が最も興味深い。**

そして発展版の `vnet`。

> **vnet は、さまざまな NAT の挙動を持つネットワークの集合を含む仮想インターネットをシミュレートする。異なる地点に VM を差し込んで、さまざまなネットワーク条件下で Tailscale がエンドツーエンドで動くことをテストできる。**

### NAT の種類が 4 つ

```go
const (
	One2OneNAT NAT = "one2one"
	EasyNAT    NAT = "easy"   // address+port filtering
	EasyAFNAT  NAT = "easyaf" // address filtering (not port)
	HardNAT    NAT = "hard"
)
```

**現実の NAT の分類が、そのまま実装として存在する。** 「easy は Linux 風、hard は FreeBSD 風」とコメントされている。

### control server の最小実装

`tstest/integration/testcontrol/testcontrol.go` は **57 KB**。「テスト目的の最小の control plane サーバ」だ。

**本物の control server なしで、ノードの登録・netmap の配布・ping の指示までを検証できる。**

## ソースコードのどこか

### 目的の宣言

```go title="tstest/natlab/natlab.go"
// Package natlab lets us simulate different types of networks all
// in-memory without running VMs or requiring root, etc. Despite the
// name, it does more than just NATs. But NATs are the most
// interesting.
package natlab
```

```go title="tstest/natlab/vnet/vnet.go"
// Package vnet simulates a virtual Internet containing a set of networks with various
// NAT behaviors. You can then plug VMs into the virtual internet at different points
// to test Tailscale working end-to-end in various network conditions.
//
// See https://github.com/tailscale/tailscale/issues/13038
package vnet
```

[`natlab.go#L4-L8`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tstest/natlab/natlab.go#L4-L8) と [`vnet.go#L4-L9`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tstest/natlab/vnet/vnet.go#L4-L9)。

**「VM も root も要らない」が最初に書かれている。** これがテストの仕組みとして最も重要な性質だ。

- **CI で回せる**。特権コンテナが要らない
- **開発者のマシンで回せる**。セットアップが要らない
- **速い**。VM の起動を待たない

`vnet` は VM を差し込める発展版で、**実際の `tailscaled` バイナリを仮想ネットワークに接続できる**。2 段構えになっている。

### NAT の分類

```go title="tstest/natlab/vnet/nat.go"
const (
	One2OneNAT NAT = "one2one"
	EasyNAT    NAT = "easy"   // address+port filtering
	EasyAFNAT  NAT = "easyaf" // address filtering (not port)
	HardNAT    NAT = "hard"
)
```

```go title="tstest/natlab/vnet/nat.go"
// NAT is a type of NAT that's known to natlab.
//
// For example, "easy" for Linux-style NAT, "hard" for FreeBSD-style NAT, etc.
type NAT string
```

[`nat.go#L11-L44`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tstest/natlab/vnet/nat.go#L11-L44)。

**4 種類の違いは、「同じ内部アドレスからの通信に、同じ外部ポートを割り当てるか」と「戻りのパケットを誰から受け付けるか」だ。**

| 種類         | マッピング         | フィルタ          |
| ------------ | ------------------ | ----------------- |
| `One2OneNAT` | 1 対 1 の静的      | なし              |
| `EasyNAT`    | 宛先に依らず同じ   | アドレス + ポート |
| `EasyAFNAT`  | 宛先に依らず同じ   | アドレスのみ      |
| `HardNAT`    | **宛先ごとに違う** | アドレス + ポート |

**`HardNAT` が [netcheck の `MappingVariesByDestIP`](../netcheck/) に対応する。** STUN で得たアドレスが、別の相手には使えない。

**「Linux 風」「FreeBSD 風」という説明が実務的だ。** RFC の用語 (Endpoint-Independent Mapping など) より、**どの OS でどう振る舞うか** のほうが直感的に分かる。

### 拡張のための登録

```go title="tstest/natlab/vnet/nat.go"
// newTableFunc is a constructor for a NAT table.
// The provided IPPool is typically (outside of tests) a *network.
type newTableFunc func(IPPool) (NATTable, error)

// natTypes are the known NAT types.
var natTypes = map[NAT]newTableFunc{}

// registerNATType registers a NAT type.
func registerNATType(name NAT, f newTableFunc) {
	if _, ok := natTypes[name]; ok {
		panic("duplicate NAT type: " + name)
	}
```

[`nat.go#L38-L54`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tstest/natlab/vnet/nat.go#L38-L54)。

**NAT の種類が、[c2n](../c2n/) や [peerAPI](../peerapi/) と同じ「init での登録 + 重複時 panic」パターン** で追加できる。

新しい NAT の挙動 (特定メーカーのルータの癖) を見つけたら、**1 ファイル足すだけで再現できる**。

### テストコードでの割り切り

```go title="tstest/natlab/vnet/nat.go"
	// No existing mapping exists. Create one.

	// TODO: clean up old expired mappings

	// Instead of proper data structures that would be efficient, we instead
	// just loop a bunch and look for a free port. This project is only used
	// by tests and doesn't care about performance, this is good enough.
	for {
		port := rand.N(uint16(32<<10)) + 32<<10 // pick some "ephemeral" port
		if n.pool.IsPublicPortUsed(netip.AddrPortFrom(n.wanIP, port)) {
			continue
		}
```

[`nat.go#L184-L196`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tstest/natlab/vnet/nat.go#L184)。

**「効率的な適切なデータ構造の代わりに、空きポートを探して適当にループする。このプロジェクトはテストでしか使われず、性能を気にしないので、これで十分だ」。**

`IsPublicPortUsed` はマップの全走査なので、**ポートの割り当てが O(既存マッピング数)**。マッピングが数千あれば遅い。

**だがテストでは問題にならない。** そして **「なぜ雑でよいか」が書かれている** ので、後から誰かが「最適化すべきでは」と考えずに済む。

**テストコードの品質基準を、本番コードと分けて明示している。**

### NAT 実装のインターフェース

```go title="tstest/natlab/vnet/nat.go"
// IPPool is the interface that a NAT implementation uses to get information
// about a network.
//
// Outside of tests, this is typically a *network.
type IPPool interface {
	// WANIP returns the primary WAN IP address.
	WANIP() netip.Addr

	// SoleLanIP reports whether this network has a sole LAN client
	// and if so, its IP address.
	SoleLANIP() (_ netip.Addr, ok bool)

	// IsPublicPortUsed reports whether the provided WAN IP+port is in use by
	// anything. (In particular, the NAT-PMP/etc port mappers might have taken
	// a port.) Implementations should check this before allocating a port,
	// and then they should report IsPublicPortUsed themselves for that port.
	IsPublicPortUsed(netip.AddrPort) bool
}
```

[`nat.go#L17-L36`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tstest/natlab/vnet/nat.go#L17-L36)。

**`IsPublicPortUsed` のコメントが、[portmapper](../portmapper/) との相互作用を説明している。**

「特に NAT-PMP などのポートマッパーがポートを取っているかもしれない」。**仮想ネットワークの中で、Tailscale の portmapper がポートを予約することがある** ので、NAT の割り当てと衝突してはいけない。

**シミュレータが、シミュレート対象の機能と相互作用する** — 仮想 NAT の中で仮想の NAT-PMP が動く。この階層構造が、テストの現実味を作っている。

### control server の最小実装

```go title="tstest/integration/testcontrol/testcontrol.go"
// Package testcontrol contains a minimal control plane server for testing purposes.
package testcontrol
```

[`testcontrol.go#L4-L5`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tstest/integration/testcontrol/testcontrol.go#L4-L5)。

**「最小」と言いつつ 57 KB ある。**

実装しているもの。

- [Noise トランスポート](../noise-transport/)のサーバ側
- ノードの登録 (`/machine/register`)
- [long poll の MapResponse](../map-longpoll/) 配信
- DERP マップの配布
- [PingRequest / c2n](../c2n/) の送信

**本物の control server は Tailscale 社の非公開コードだ。** だがテストのために、**プロトコルを喋る最小の実装を OSS 側に持っている**。

これがあると、

- **ノードの登録からピア間通信までを、1 プロセスで検証できる**
- **サーバ側の異常な応答を再現できる**。壊れた netmap、遅い応答
- **外部ネットワークに依存しない**。CI がオフラインでも動く

### 統合テストの規模

```text
tstest/integration/integration.go       37 KB
tstest/integration/integration_test.go  70 KB
tstest/integration/testcontrol/         57 KB
tstest/integration/vms/                 (VM を使うテスト)
tstest/integration/nat/                 (NAT のテスト)
```

そして依存関係の検査。

```text
tailscaled_deps_test_linux.go
tailscaled_deps_test_darwin.go
tailscaled_deps_test_windows.go
...
```

**プラットフォームごとに、`tailscaled` が依存するパッケージを検査するテストがある。** [tsnet の depaware](../tsnet/) と同じ発想で、**依存の増加をテストで検出する**。

### 実バイナリを起動する

`integration.go` は **実際の `tailscaled` と `tailscale` のバイナリをビルドして起動する**。

```text
exec_notwindows.go
exec_windows.go
service_notwindows.go
service_windows.go
```

**プロセスの起動とサービスの管理が、プラットフォームごとに分かれている。** Windows ではサービスとして登録する必要がある。

**「ライブラリとして呼ぶ」ではなく「バイナリを起動する」** テストなので、`main` 関数、フラグの解析、シグナルの処理まで含めて検証できる。

## なぜそうなっているか

### なぜシミュレータを作るのか

NAT 越えの正しさは、**環境の組み合わせで決まる**。

- NAT の種類 (4 種類) × 2 台 = 16 通り
- IPv4 / IPv6 / 両方
- ポートマッピングの有無
- ファイアウォールの挙動

**実機でこれを組むと、数十の構成が必要になる。** CI で毎回回すのは不可能だ。

シミュレータなら、**構成をコードで書ける**。

```go
// 疑似コード
net1 := conf.AddNetwork(HardNAT)
net2 := conf.AddNetwork(EasyNAT)
node1 := net1.AddNode()
node2 := net2.AddNode()
// 直結できるか検証
```

そして **決定的に再現できる**。実機だと「たまに失敗する」が、シミュレータなら同じ結果になる。

### なぜ 2 段構え (natlab と vnet) なのか

`natlab` は **メモリ上のパケット交換** だ。`Packet` 構造体を関数呼び出しで渡す。速いが、**実際の `tailscaled` は動かせない**。

`vnet` は **仮想の Ethernet を提供する**。VM や実プロセスを接続できる。遅いが、**本物のバイナリをテストできる**。

**目的が違う。**

- **`natlab`** — NAT のロジック自体、magicsock の経路選択
- **`vnet`** — エンドツーエンドの動作、実際のパケット処理

**「速くて限定的」と「遅くて現実的」の両方を持つ** のは、テスト戦略として一般的だ。単体テストと統合テストの関係に近い。

### なぜテストコードで性能を無視してよいのか

テストコードにも品質は要る。だが **「品質」の内容が本番コードと違う**。

| 観点   | 本番コード | テストコード                    |
| ------ | ---------- | ------------------------------- |
| 性能   | 重要       | **どうでもよい** (十分速ければ) |
| 可読性 | 重要       | **重要**                        |
| 正しさ | 重要       | **重要**                        |
| 拡張性 | 重要       | 場合による                      |

**ポートの割り当てが O(n) でも、テストが 1 秒で終わるなら問題ない。** 効率的なデータ構造を書くと、**そのデータ構造自体にバグが入る余地が生まれる**。

**「単純だが遅い」を選ぶことで、テストのコードが正しいことを目視で確認できる。**

そして **「なぜ雑でよいか」をコメントに書く** ことで、後から最適化されるのを防ぐ。**テストコードの複雑化は、テストへの信頼を下げる。**

### なぜ control server の最小実装を持つのか

本物の control server がないと、テストできることが限られる。

- ノードの登録
- netmap の配布
- 複数ノードの相互作用

**モックで済ませることもできるが、モックは「プロトコルを喋らない」。** [Noise](../noise-transport/) のハンドシェイク、[long poll](../map-longpoll/) のフレーミング、[差分の配信](../netmap/) — これらが正しいかは、実際に喋ってみないと分からない。

**プロトコルの両端を持つと、「片方だけの実装ミス」が検出できる。**

そして **異常系を作れる**。「壊れた netmap を送る」「応答を遅らせる」「接続を切る」。本物のサーバでは再現できない状況をテストできる。

### なぜ実バイナリを起動するのか

パッケージのテストでは、**`main` 関数がテストされない**。

- フラグの解析
- 初期化の順序
- シグナルの処理
- サービスとしての起動 (Windows)

これらのバグは、**ユーザーには「起動しない」という最も目立つ形で現れる**。

実バイナリを起動するテストは遅い (ビルドが要る) が、**この層をカバーする唯一の方法** だ。

そして **プラットフォームごとの起動方法の違い** (exec、Windows サービス) も、そこで検証される。

## どう活かすか

**環境の組み合わせが多い機能は、環境そのものをシミュレートする。** NAT、ネットワークの遅延、ディスクの故障、時刻のずれ。**「コードで構成を書ける」ようになれば、組み合わせを網羅できる。**

**シミュレータは「VM も特権も不要」を目標にする。** CI で回せること、開発者のマシンで回せることが、実際に使われるかを決める。**セットアップが要るテストは書かれなくなる。**

**「速くて限定的」と「遅くて現実的」の 2 段のテスト基盤を持つ。** 前者を大量に、後者を要所で回す。単体テストと統合テストの関係と同じだが、**ネットワークのような領域では、その中間にシミュレータが入る**。

**テストコードでは、性能を捨てて単純さを取ってよい。** そして **「なぜ雑でよいか」をコメントに書く**。書かないと最適化され、テストコード自体にバグが入る。**テストの複雑さは、テストへの信頼を下げる。**

**プロトコルの相手側の最小実装を、テスト用に持つ。** モックはプロトコルを喋らないので、フレーミングやハンドシェイクの誤りを検出できない。**両端を持てば、異常系も作れる。**

**`main` 関数をテストするには、実バイナリを起動するしかない。** フラグ解析、初期化順序、シグナル処理。ここのバグは「起動しない」という最悪の形で現れる。**遅くても、この層を持つ価値がある。**

**現実の挙動の分類 (NAT の種類など) を、実装の型として持つ。** 「Linux 風」「FreeBSD 風」という説明を添えれば、RFC の用語より速く理解できる。**新しい挙動を見つけたら 1 ファイル足せる形にしておく。**
