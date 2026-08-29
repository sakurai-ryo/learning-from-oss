---
title: "netavark と aardvark-dns — ネットワークを外部バイナリに切り出す"
description: "Podman はネットワークを自分で作らない。netavark という Rust のバイナリに、JSON を stdin で渡して stdout で結果を受け取る。エラーも JSON で返り、DisallowUnknownFields で厳格にデコードされる。DNS が要る場合は netavark が aardvark-dns を起動する。Docker が libnetwork をデーモンに内蔵しているのと正反対の構造で、その代わりネットワーク定義そのものは JSON ファイルとして Podman が持つ。"
group: "ネットワーク"
sidebar:
  order: 31
---

## 何を学んだか

### ネットワークは 1 回の exec で終わる

コンテナのネットワークを用意する処理は、Podman の中には無い。あるのは **netavark を起動して JSON を渡す** コードだけだ。

```
podman ──(stdin に JSON)──> netavark setup /proc/<pid>/ns/net
       <──(stdout に JSON)──
```

netavark は Rust で書かれた別バイナリで、渡された netns のパスに対して veth を作り、ブリッジに繋ぎ、IP を振り、NAT のルールを入れる。終わったら結果 (割り当てた IP、MAC アドレス、インターフェース名) を JSON で返して終了する。**常駐しない**。

コンテナを消すときは `netavark teardown` を同じ形で呼ぶ。

DNS が必要な場合 (コンテナ名で相互に解決したい場合) だけ、netavark が **aardvark-dns** という別のバイナリを起動する。こちらは常駐して DNS クエリに答える。Podman は aardvark-dns を直接は起動せず、`--aardvark-binary=<path>` として netavark に場所を教えるだけだ。

### 役割分担

|                                                                | 誰が持つか                                                |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| ネットワークの **定義** (名前、サブネット、driver、DNS 有効か) | Podman (`containers/common` の libnetwork)。JSON ファイル |
| IP アドレスの **割り当て記録**                                 | Podman (IPAM の DB)                                       |
| 実際の **veth / bridge / iptables 操作**                       | netavark                                                  |
| コンテナ名の **DNS 解決**                                      | aardvark-dns                                              |

「何を作るか」は Podman が決め、「どう作るか」は netavark が知っている。境界は **JSON のスキーマ** だ。

`podman network create` は netavark を呼ばない。JSON ファイルを 1 つ書くだけで、実際のブリッジはコンテナが最初に接続されるときに作られる。

### Docker との対比

Docker の libnetwork は dockerd の中にある。Go のライブラリとして呼ばれ、デーモンのメモリ上にネットワークの状態を持つ。

|                | Docker (libnetwork)             | Podman (netavark)                 |
| -------------- | ------------------------------- | --------------------------------- |
| 実装の位置     | dockerd 内のライブラリ          | 別プロセス、別言語 (Rust)         |
| 実行タイミング | デーモンが常駐して管理          | 必要なときに exec、終わったら終了 |
| 状態           | デーモンのメモリ + ディスク     | JSON ファイルのみ                 |
| 差し替え       | 不可 (プラグインで拡張は可能)   | バイナリを差し替えれば可能        |
| DNS            | dockerd 内の埋め込み DNS サーバ | aardvark-dns という別デーモン     |

Podman は以前 **CNI** を使っていた。CNI も外部バイナリを呼ぶ規約だが、プラグインが細切れ (bridge、portmap、firewall、tuning…) で、Podman が必要とする機能 (コンテナ名の DNS、複数ネットワーク接続) と噛み合わなかった。netavark は **Podman の用途に合わせて設計し直した後継** で、1 バイナリで完結する。

## ソースコードのどこか

### 起動は「引数 + stdin の JSON」

[`vendor/go.podman.io/common/libnetwork/netavark/exec.go#L79`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/netavark/exec.go#L79)。

```go title="go.podman.io/common/libnetwork/netavark/exec.go"
func (n *netavarkNetwork) execNetavark(args []string, needPlugin bool, stdin, result any) error {
	// set the netavark log level to the same as the podman
	env := append(os.Environ(), getRustLogEnv())
	// Netavark need access to iptables in $PATH. As it turns out debian doesn't put
	// /usr/sbin in $PATH for rootless users. This will break rootless networking completely.
	// We might break existing users and we cannot expect everyone to change their $PATH so
	// let's add /usr/sbin to $PATH ourselves.
	path := os.Getenv("PATH")
	if !strings.Contains(path, "/usr/sbin") {
		path += ":/usr/sbin"
		env = append(env, "PATH="+path)
	}
```

Podman のログレベルを `RUST_LOG` に変換して渡す。**別言語のバイナリに、自分のログ設定を引き継がせる**。デバッグ時は `RUST_BACKTRACE=1` も足す。

`/usr/sbin` を `$PATH` に足す処理のコメントが率直だ。「netavark は `$PATH` から iptables にアクセスする必要がある。ところが Debian は rootless ユーザの `$PATH` に `/usr/sbin` を入れない。これは rootless ネットワークを完全に壊す。既存ユーザを壊すわけにいかないし、全員に `$PATH` を変えろとも言えないので、自分で足す」。

**ディストリビューション固有の事情への対処が、コメント付きで残っている**。外部バイナリに依存する設計では、この種の環境差が必ず出てくる。

### JSON を書いてから stdin を閉じる

[`vendor/go.podman.io/common/libnetwork/netavark/exec.go#L136-L152`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/netavark/exec.go#L136)。

```go title="go.podman.io/common/libnetwork/netavark/exec.go"
	cmd := exec.Command(path, args...)
	// connect the pipes to stdin and stdout
	cmd.Stdin = stdinR
	cmd.Stdout = stdoutW
	cmd.Stderr = logWriter
	cmd.Env = env

	err = cmd.Start()
	if err != nil {
		return newNetavarkError("failed to start process", err)
	}
	err = json.NewEncoder(stdinW).Encode(stdin)
	// we have to close stdinW so netavark gets the EOF and does not hang forever
	stdinW.Close()
	stdinWClosed = true
```

**「stdinW を閉じないと netavark が EOF を受け取れず永遠にハングする」**。パイプで JSON を渡すときの定番の落とし穴で、コメントで明示されている。

stdout 側も同じ扱いだ。

```go title="go.podman.io/common/libnetwork/netavark/exec.go"
	dec := json.NewDecoder(stdoutR)

	err = cmd.Wait()
	// we have to close stdoutW so we can decode the json without hanging forever
	stdoutW.Close()
	stdoutWClosed = true
```

`cmd.Wait()` の後に親側の書き込み端を閉じてからデコードする。**プロセスを待ってから読む** という順序なので、netavark が大量に出力するとパイプバッファが埋まってデッドロックする可能性がある。ネットワークの結果 JSON は小さいので成立している設計だ。

### エラーも JSON で受け取る

```go title="go.podman.io/common/libnetwork/netavark/exec.go"
	if err != nil {
		exitError := &exec.ExitError{}
		if errors.As(err, &exitError) {
			ne := &netavarkError{}
			// lets disallow unknown fields to make sure we do not get some unexpected stuff
			dec.DisallowUnknownFields()
			// this will unmarshal the error message into the error struct
			ne.err = dec.Decode(ne)
			ne.exitCode = exitError.ExitCode()
			return ne
		}
```

netavark が非ゼロで終了したら、**stdout に書かれた JSON をエラー構造体としてデコードする**。前に見た OCI ランタイムのエラー処理 (正規表現でメッセージを分類する) と比べると、はるかに素直だ。

違いは **プロトコルを自分で決められたかどうか** にある。OCI Runtime Spec はエラー形式を定めていないので正規表現に頼るしかなかった。netavark は Podman プロジェクトが後から作ったので、最初から構造化エラーを返す規約にできた。

`DisallowUnknownFields()` を付けているのも意図的で、「想定外のものが来ていないことを確かめる」ためだ。エラーのデコードは失敗しても致命的でないので、厳格にして異常を早く見つける方を選んでいる。

### ドライバの一覧と、プラグインへの縮退

[`vendor/go.podman.io/common/libnetwork/netavark/network.go#L179`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libnetwork/netavark/network.go#L179)。

```go title="go.podman.io/common/libnetwork/netavark/network.go"
var builtinDrivers = []string{types.BridgeNetworkDriver, types.MacVLANNetworkDriver, types.IPVLANNetworkDriver}
```

netavark が自前で持つドライバは 3 つ。`bridge`、`macvlan`、`ipvlan`。それ以外のドライバが指定されると **プラグイン経由** になる。

```go title="go.podman.io/common/libnetwork/netavark/run.go"
		if !slices.Contains(builtinDrivers, net.Driver) {
			needsPlugin = true
		}
```

```go title="go.podman.io/common/libnetwork/netavark/run.go"
func (n *netavarkNetwork) getCommonNetavarkOptions(needPlugin bool) []string {
	opts := []string{"--config", n.networkRunDir, "--rootless=" + strconv.FormatBool(n.networkRootless), "--aardvark-binary=" + n.aardvarkBinary}
	// to allow better backwards compat we only add the new netavark option when really needed
	if needPlugin {
		// Note this will require a netavark with https://github.com/containers/netavark/pull/509
		for _, dir := range n.pluginDirs {
			opts = append(opts, "--plugin-directory", dir)
		}
	}
	return opts
}
```

**「後方互換のため、本当に必要なときだけ新しいオプションを足す」**。`--plugin-directory` を知らない古い netavark に渡すとエラーになるので、プラグインが要る場合だけ渡す。

外部バイナリのバージョン差を、**「新しい引数を必要なときだけ使う」** という形で吸収している。バージョン検出をせずに済ませる実用的な手だ。

共通オプションを見ると、この 1 行に構造が凝縮されているのが分かる。`--config` (状態を置くディレクトリ)、`--rootless` (動作モード)、`--aardvark-binary` (DNS サーバの場所)。**Podman が netavark に伝える情報は、この 3 つと stdin の JSON だけ**。

### teardown は IP の解放とセットで

```go title="go.podman.io/common/libnetwork/netavark/run.go"
	// when netavark returned an error we still free the used ips
	// otherwise we could end up in a state where block the ips forever
	err = n.deallocIPs(&netavarkOpts.NetworkOptions)
```

**netavark が失敗しても IP は解放する**。IPAM の記録は Podman 側にあるので、netavark の成否とは独立に管理できる。「解放し損ねると IP が永久に埋まる」という被害の方が大きい、という判断だ。

役割を分けたことの副作用でもある。実体 (veth) と記録 (IPAM) の持ち主が違うので、どちらかが失敗したときの整合性を明示的に考える必要がある。

## なぜそうなっているか

### CNI では足りなかった

Podman は 4.0 まで CNI を使っていた。CNI は Kubernetes 由来の規約で、「netns にインターフェースを 1 つ追加する」ことに焦点がある。Podman が欲しかったのはもう少し広い。

- **コンテナ名での DNS 解決** — CNI の範囲外。dnsname という CNI プラグインを自作していた
- **複数ネットワークへの同時接続と、その間の一貫した設定**
- **`podman network connect` による動的な接続変更**
- **rootless での動作**

CNI プラグインは 1 つずつが独立したバイナリなので、複数を跨る状態 (どの IP を誰に振ったか) の管理が難しい。netavark は **1 バイナリで全部やる** ことでこれを解いた。

「標準に乗る」ことのメリットと、「用途に合う」ことのメリットを天秤にかけて、後者を取った判断といえる。Kubernetes 連携は `kube play` という別の道があるので、CNI 互換を捨てるコストが小さかった。

### プロセスを分けたのは、言語とライフサイクルの都合

netavark が Rust なのは、iptables/nftables の操作やネットワーク設定に **メモリ安全性と起動の速さ** が欲しかったからだ。Go でも書けるが、Podman プロセスに載せると起動のたびにその分のコードがロードされる。

そして aardvark-dns は常駐する必要がある。DNS クエリにいつでも答えなければならない。**寿命が違うものはプロセスを分ける** という、前提群で見た基準がここにも適用されている。

Podman → netavark → aardvark-dns という 2 段の起動になっているのは、「DNS を立てるかどうか」の判断が netavark 側の知識 (ネットワークの構成) に依存するからだ。Podman は場所を教えるだけで、起動の判断は委ねている。

## どう活かすか

- **自分で決められるプロトコルなら、エラーを構造化する。** netavark のエラー処理が OCI ランタイムより素直なのは、後から規約を作れたから。プロセス間の契約を設計する立場なら、エラー形式を最初に決める。
- **stdin にデータを流したら必ず閉じる。** 相手が EOF を待っているとハングする。`defer` で閉じるだけでなく、「書き終わったらすぐ閉じる」を明示的に書く。
- **外部バイナリのバージョン差は「必要なときだけ新しい引数」で吸収する。** バージョン検出は当てにならない。機能が必要な場合にだけ新オプションを渡せば、古いバイナリでも既存機能は動く。
- **実体と記録の持ち主が違うなら、片方が失敗したときの方針を決める。** netavark が失敗しても IP は解放する、というのは「漏れの被害が大きい方を優先する」判断だ。
- **標準に乗るかは、用途との適合で決める。** CNI を捨てて netavark を作ったのは、標準の恩恵より用途の適合を取った例。ただし互換を捨てるコストが小さいことが前提になっている。
