---
title: "自分のトンネルに、自分のパケットを吸い込ませない"
description: "Tailscale は 100.64.0.0/10 への経路を OS に入れる。すると tailscaled 自身の通信までトンネルに吸い込まれ、無限ループになる。Linux は SO_MARK でパケットに印を付けて迂回させ、それが効かない環境では SO_BINDTODEVICE に落ちる。OS ごとに 6 種類の実装がある。"
group: "OS 統合とルーティング"
sidebar:
  order: 27
---

## 何を学んだか

### 自分で作った経路に、自分が捕まる

Tailscale は OS のルーティングテーブルに経路を入れる。`100.64.0.0/10`、そして [exit node](../subnet-router-exit-node/) を使うなら `0.0.0.0/0` も。

すると問題が起きる。**`tailscaled` 自身が外部と通信しようとすると、その経路に従って自分の TUN デバイスに送られる。**

```text
tailscaled が DERP サーバへ UDP を送る
  → OS のルーティングが「0.0.0.0/0 は Tailscale へ」と判断
    → TUN デバイスへ
      → tailscaled が読む
        → DERP サーバへ送ろうとする
          → (無限ループ)
```

**トンネルを作るプログラムが、自分のトンネルに入ってしまう。** VPN の実装が必ず直面する問題だ。

### 解決策は OS ごとに違う

パッケージのドキュメントが状況を要約している。

> netns という名前だが、**実際に使う機構は OS ごとに、場合によっては OS のバージョンごとに異なる**。

| OS               | 手法                                                       |
| ---------------- | ---------------------------------------------------------- |
| Linux            | `SO_MARK` でパケットに印を付け、ポリシールーティングで迂回 |
| Linux (fallback) | `SO_BINDTODEVICE` で物理インターフェースに固定             |
| macOS / iOS      | インターフェースにバインド (`IP_BOUND_IF`)                 |
| Windows          | インターフェースのインデックスを指定                       |
| Android          | アクティブなネットワークにバインド                         |
| OpenBSD          | 独自の実装                                                 |

### Linux の SO_MARK が使えるかを、実際に試して確かめる

`SO_MARK` には `CAP_NET_ADMIN` が要る。使えるかどうかは環境による。

Tailscale は **起動時に、ダミーの UDP ソケットを作って `SO_MARK` を設定してみる**。成功すれば使い、失敗すれば `SO_BINDTODEVICE` に落ちる。

### マークの値は 3 種類

```go
LinuxFwmarkMask      = 0xff0000  // Tailscale が使うビット範囲
LinuxSubnetRouteMark = 0x40000   // subnet route 宛として許可されたパケット
LinuxBypassMark      = 0x80000   // tailscaled 自身が作ったパケット
```

**32 ビットのマークのうち、上位 8 ビットのマスク範囲だけを使う。** 他のソフトウェア (Docker、Kubernetes、systemd-networkd) もマークを使うので、衝突しないように範囲を宣言している。

## ソースコードのどこか

### 問題と機構

```go title="net/netns/netns.go"
// Package netns contains the common code for using the Go net package
// in a logical "network namespace" to avoid routing loops where
// Tailscale-created packets would otherwise loop back through
// Tailscale routes.
//
// Despite the name netns, the exact mechanism used differs by
// operating system, and perhaps even by version of the OS.
//
// The netns package also handles connecting via SOCKS proxies when
// configured by the environment.
package netns
```

[`netns.go#L4-L14`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netns/netns.go#L4-L14)。

**パッケージ名が実態と合っていないことを、冒頭で認めている。** Linux の network namespace とは別物で、「論理的な意味での名前空間」という比喩だ。

**名前が誤解を招くと分かっているなら、ドキュメントの最初にそう書く。** [machine key の prefix](../keys/) と同じ扱い方だ。

### Go の標準ライブラリへの差し込み

```go title="net/netns/netns_linux.go"
// controlC marks c as necessary to dial in a separate network namespace.
//
// It's intentionally the same signature as net.Dialer.Control
// and net.ListenConfig.Control.
func controlC(network, address string, c syscall.RawConn) error {
	if isLocalhost(address) {
		// Don't bind to an interface for localhost connections.
		return nil
	}

	var sockErr error
	err := c.Control(func(fd uintptr) {
		if UseSocketMark() {
			sockErr = setBypassMark(fd)
		} else {
			sockErr = bindToDevice(fd)
		}
	})
```

[`netns_linux.go#L85-L106`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netns/netns_linux.go#L85)。

**`net.Dialer.Control` と同じシグネチャなのは意図的。** Go の標準ライブラリは、ソケットを作った直後・接続する前にこの関数を呼ぶフックを持つ。**そこに setsockopt を差し込める。**

つまり `net.Dialer{Control: netns.Control(...)}` と書くだけで、標準の `Dial` がそのまま使える。**独自の Dial 実装を書かずに、標準ライブラリの全機能 (Happy Eyeballs、DNS 解決、タイムアウト) が使える。**

`localhost` を除外しているのも重要だ。**ループバックへの接続は、そもそもトンネルを通らない。** ここでインターフェースにバインドすると、逆に壊れる。

### SO_MARK が使えるかを実際に試す

```go title="net/netns/netns_linux.go"
// socketMarkWorks returns whether SO_MARK works.
func socketMarkWorks() bool {
	addr, err := net.ResolveUDPAddr("udp", "127.0.0.1:1")
	if err != nil {
		return true // unsure, returning true does the least harm.
	}

	sConn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return true // unsure, return true
	}
	defer sConn.Close()

	rConn, err := sConn.SyscallConn()
	if err != nil {
		return true // unsure, return true
	}

	var sockErr error
	err = rConn.Control(func(fd uintptr) {
		sockErr = setBypassMark(fd)
	})
	if err != nil || sockErr != nil {
		return false
	}

	return true
}
```

[`netns_linux.go#L19-L45`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netns/netns_linux.go#L19-L45)。

**能力の判定を、実際にやってみることで行う。** カーネルのバージョンや capability を調べるのではなく、**ダミーの UDP ソケットに `SO_MARK` を設定してみる**。

`127.0.0.1:1` への UDP は、**接続先に何もなくても成功する** (UDP なのでパケットは送らない)。ソケットを作ってオプションを設定するだけの、副作用のない試行になっている。

**エラー時に `true` を返すのが 3 箇所ある。** そのすべてに `// unsure, returning true does the least harm` というコメント。

判定できないときにどちらを選ぶか。`SO_MARK` を使えると思って使えなければ、setsockopt がエラーになるだけで [別のエラー処理](#権限がなければエラーを無視する)に落ちる。逆に「使えない」と判断して `SO_BINDTODEVICE` を使うと、**インターフェースが変わるたびにソケットを作り直す必要が出る**。だから `true` のほうが害が小さい。

判定は `sync.Once` で 1 回だけ実行され、キャッシュされる。

### マークの値を宣言する

```go title="tsconst/linuxfw.go"
	// bits, leaving the higher 4 bits for future use.
	LinuxFwmarkMask    = "0xff0000"
	LinuxFwmarkMaskNum = 0xff0000

	// Packet is from Tailscale and to a subnet route destination, so
	// is allowed to be routed through this machine.
	LinuxSubnetRouteMark    = "0x40000"
	LinuxSubnetRouteMarkNum = 0x40000

	// Packet was originated by tailscaled itself, and must not be
	// routed over the Tailscale network.
	LinuxBypassMark    = "0x80000"
	LinuxBypassMarkNum = 0x80000
```

[`linuxfw.go#L30-L43`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tsconst/linuxfw.go#L30-L43)。

**マスクを定義して、使う範囲を宣言している。** `0xff0000` は 32 ビットのうち 16〜23 ビット目。他のソフトウェアがマークの他のビットを使っていても衝突しない。

そして「上位 4 ビットは将来のために残す」とある。**8 ビット確保して、今は 2 ビットしか使っていない。**

**文字列版と数値版の両方が定義されている**のは、iptables/nftables のルールを組み立てるときに文字列が要り、`setsockopt` には数値が要るからだ。**同じ値を 2 か所で書かないための工夫。**

### fallback の実装

```go title="net/netns/netns_linux.go"
func bindToDevice(fd uintptr) error {
	ifc, err := netmon.DefaultRouteInterface()
	if err != nil {
		// Make sure we bind to *some* interface,
		// or we could get a routing loop.
		// "lo" is always wrong, but if we don't have
		// a default route anyway, it doesn't matter.
		ifc = "lo"
	}
	if err := unix.SetsockoptString(int(fd), unix.SOL_SOCKET, unix.SO_BINDTODEVICE, ifc); err != nil {
		return fmt.Errorf("setting SO_BINDTODEVICE: %w", err)
	}
	return nil
}
```

[`netns_linux.go#L120-L133`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netns/netns_linux.go#L120-L133)。

**「デフォルトルートのインターフェースが分からなければ `lo` にバインドする」。**

コメントが正直だ。**「`lo` は常に間違いだが、どのみちデフォルトルートがないなら、間違いでも構わない」。**

デフォルトルートがない = 外部に出られない。そのとき `lo` にバインドすれば、**少なくともルーティングループは起きない**。通信は失敗するが、それは元々失敗する。

**「正しくないが、より悪い失敗を防ぐ」選択** で、その判断の根拠がコメントに書かれている。

### 権限がなければエラーを無視する

```go title="net/netns/netns_linux.go"
// ignoreErrors returns true if we should ignore setsocketopt errors in
// this instance.
func ignoreErrors() bool {
	if os.Getuid() != 0 {
		// only root can manipulate these socket flags
		return true
	}
	return false
}
```

```go title="net/netns/netns_linux.go"
	if sockErr != nil && ignoreErrors() {
		// TODO(bradfitz): maybe log once? probably too spammy for e.g. CLI tools like tailscale netcheck.
		return nil
	}
```

[`netns_linux.go#L71-L79`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netns/netns_linux.go#L71-L79) と [`netns_linux.go#L107-L110`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/netns/netns_linux.go#L107-L110)。

**同じパッケージが `tailscaled` (root) と `tailscale` CLI (一般ユーザー) の両方で使われる。**

CLI が `tailscale netcheck` を実行するとき、`SO_MARK` は失敗する。だが **CLI は TUN を作らないので、そもそもルーティングループが起きない**。エラーを無視して構わない。

**「同じコードが特権あり・なしの両方で動く」場合の扱い方** で、判定を `os.Getuid()` という単純な条件にしている。

### 高レベルのダイヤラ

```go title="net/tsdial/tsdial.go"
// Dialer dials out of tailscaled, while taking care of details while
// handling the dozens of edge cases depending on the server mode
// (TUN, netstack), the OS network sandboxing style (macOS/iOS
// Extension, none), user-selected route acceptance prefs, etc.
type Dialer struct {
```

[`tsdial.go#L31-L36`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/tsdial/tsdial.go#L31-L36)。

**「サーバのモード、OS のサンドボックスの流儀、ユーザーが選んだ経路の受け入れ設定などに応じて、数十のエッジケースを扱う」。**

`netns` が「ソケットのオプション」という低いレベルを扱うのに対し、`tsdial` は「どの経路で dial するか」という高いレベルを扱う。

- **TUN モードなら OS のスタックで dial する** (netns でループを回避)
- **netstack モードなら netstack で dial する**
- **exit node の DNS を使うかどうか**
- **tailnet 内の宛先か、外部か**

同じ `Dial` の呼び出しが、設定によってまったく違う経路になる。

## なぜそうなっているか

### なぜルーティングループが起きるのか

VPN は「特定の宛先を仮想インターフェースへ送る」経路を OS に入れる。だが OS のルーティングは **「どのプロセスが送ったか」を区別しない**。

`tailscaled` が DERP サーバ (パブリックな IP) へ UDP を送るとき、exit node を使っていれば `0.0.0.0/0` の経路に当たる。**自分が入れた経路に、自分が捕まる。**

これは VPN 実装に固有の問題ではなく、**「ネットワークを操作するプログラムが、そのネットワークを使う」構造すべてに現れる**。プロキシ、コンテナランタイム、トラフィックシェーパー。

### なぜ OS ごとに機構が違うのか

「特定のソケットだけルーティングテーブルを迂回する」機能は、**POSIX に存在しない**。各 OS が独自に足した。

- **Linux の `SO_MARK`**: パケットに 32 ビットの印を付ける。ポリシールーティング (`ip rule`) がそれを見て別のテーブルを引く。**最も柔軟だが、特権が要る**
- **`SO_BINDTODEVICE`**: 送信インターフェースを固定する。ルーティングを完全に飛ばす。**インターフェースが変わったら張り直しが要る**
- **macOS の `IP_BOUND_IF`**: 同様だが、macOS 独自
- **Windows**: インターフェースのインデックスを指定する API

**同じ目的に対して 4 通りの機構があり、意味論も微妙に違う。** 抽象化できるのは「ソケットを作った直後に何かする」という形だけだ。

### なぜ能力を「試して」判定するのか

`SO_MARK` が使えるかは、次の全部に依存する。

- カーネルのバージョン
- プロセスの capability (`CAP_NET_ADMIN`)
- コンテナのセキュリティプロファイル (seccomp、AppArmor)
- ユーザー名前空間の設定

**これらを全部調べるコードを書くのは、間違いなく不完全になる。**

実際に `setsockopt` を呼んでみれば、**カーネルが答えを返す**。1 回のシステムコールで、上記すべてを考慮した結果が得られる。

副作用のない試行 (`127.0.0.1:1` への UDP ソケット) を作れることが、この手法の前提だ。**「能力の検査を、実際の使用と同じ経路で行う」** ことで、判定と実行の乖離もなくなる。

### なぜマークにマスクを定義するのか

`SO_MARK` は 32 ビットの値で、**システム全体で 1 つしかない**。Docker、Kubernetes の CNI、systemd-networkd、それぞれがマークを使う。

全部が「マーク = 1」を使ったら衝突する。だから **ビット範囲を分けて使うのが慣習** だ。

Tailscale は `0xff0000` (16〜23 ビット) を宣言し、その中で 2 つの値を使う。iptables のルールも `--mark 0x40000/0xff0000` のようにマスク付きで書くので、**他の範囲のビットが立っていても正しく判定される**。

**「共有リソースの一部を明示的に確保する」** という設計で、範囲をコメントで宣言することが実質的な取り決めになる。

### なぜ Control フックを使うのか

Go の `net.Dialer` は、DNS 解決、Happy Eyeballs (IPv4/IPv6 の並行試行)、タイムアウト、コンテキストのキャンセルを実装している。**これを自前で書くのは大仕事だ。**

`Control` フックは「ソケットを作った直後、`connect` を呼ぶ前」に呼ばれる。ここで setsockopt すれば、**残りは全部標準ライブラリに任せられる**。

`Control` の存在は Go 1.11 で追加されたが、まさにこういう用途のためにある。**ライブラリの拡張点が、必要な粒度で提供されている例** だ。

## どう活かすか

**ネットワークを操作するプログラムは、自分がそのネットワークを使うことを考慮する。** VPN、プロキシ、コンテナランタイム、トラフィック制御。「自分が入れた設定に自分が捕まる」構造は必ず現れる。設計の早い段階で、迂回の手段を決めておく。

**OS 固有の機構は「呼び出し規約」だけを共通化する。** `netns` は「ソケットを作った直後に何かする関数」という形だけを共通にし、中身は 6 通り。共通のインターフェースを大きくしようとすると、どの OS にも合わなくなる。

**能力の判定は、実際に試すのが最も確実。** バージョン、権限、サンドボックス、設定 — 全部を調べるコードは不完全になる。副作用なく試せる方法があるなら、1 回試して結果をキャッシュする。

**判定できないときにどちらへ倒すかを、「どちらの間違いが害が小さいか」で決める。** そしてその理由をコメントに書く。`// unsure, returning true does the least harm` は 6 語で判断を説明している。

**共有される数値空間 (マーク、ポート、ID 範囲) を使うなら、マスクを定義して範囲を宣言する。** そして使い切らずに余裕を残す。文字列版と数値版が要るなら、片方から導出するか、同じ場所に並べて書く。

**標準ライブラリの拡張点を探す。** 自前で `Dial` を実装する前に、`Control` フックのような差し込み口がないか確認する。標準ライブラリが持つ機能 (DNS、Happy Eyeballs、タイムアウト) を全部再実装するのは、ほぼ確実に間違いになる。

**「正しくないが、より悪い失敗を防ぐ」選択には、理由を書く。** `lo` にバインドするのは間違いだが、ルーティングループよりましだ。この判断はコードからは読めない。
