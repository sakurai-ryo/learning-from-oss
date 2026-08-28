---
title: "Tailscale ノードを Go のライブラリとして埋め込む"
description: "デーモンも root 権限も要らず、1 つのバイナリに複数のノードを入れられる。返るのは標準の net.Listener と net.Conn なので、既存の HTTP サーバがそのまま動く。599 行の依存関係ファイルがリポジトリにコミットされ、依存の増加が差分として見える。"
group: "その上に載るもの"
sidebar:
  order: 41
---

## 何を学んだか

### プロセスの中にノードを埋め込む

```go
s := &tsnet.Server{
	Hostname: "my-service",
	AuthKey:  os.Getenv("TS_AUTHKEY"),
}
defer s.Close()

ln, err := s.Listen("tcp", ":80")
log.Fatal(http.Serve(ln, myHandler))
```

**これだけで、Go のプログラムが tailnet のノードになる。**

- `tailscaled` のインストールが不要
- root 権限が不要
- **1 つのバイナリに複数の独立したノードを入れられる**
- 状態は指定したディレクトリに保存される

### 標準インターフェースを返す

`Listen` が返すのは `net.Listener`、`Dial` が返すのは `net.Conn`。

> **標準ライブラリの [net.Listener] と [net.Conn] インターフェースが返るので、既存の Go の HTTP サーバ、gRPC サーバ、その他 net ベースのコードが修正なしで動く。**

`http.Serve(ln, handler)` がそのまま書ける。**新しい API を覚える必要がない。**

### 仕組みは netstack

TUN デバイスを作れないので、**[gVisor の netstack](../netstack/) をユーザー空間の TCP/IP スタックとして使う**。`Listen` は netstack のリスナで、`Dial` は netstack の接続だ。

### 認証方法が 6 通り

`AuthKey`、環境変数 2 種、OAuth のクライアントシークレット、ワークロード ID フェデレーション、対話的なログイン URL。**優先順位つきでドキュメントに列挙されている。**

### 依存関係をファイルにコミットする

`tsnet/depaware.txt` は **599 行の依存パッケージ一覧** で、リポジトリにコミットされている。依存が増減すれば、**プルリクエストの差分に現れる**。

## ソースコードのどこか

### パッケージのドキュメントが導入資料

```go title="tsnet/tsnet.go"
// Package tsnet embeds a Tailscale node directly into a Go program,
// allowing it to join a tailnet and accept or dial connections without
// running a separate tailscaled daemon or requiring any system-level
// configuration.
//
// # Overview
//
// Normally, Tailscale runs as a background system service (tailscaled)
// that manages a virtual network interface for the whole machine. tsnet
// takes a different approach: it runs a fully self-contained Tailscale
// node inside your process using a userspace TCP/IP stack (gVisor).
// This means:
//
//   - No root privileges required.
//   - No system daemons to install or manage.
//   - Multiple independent Tailscale nodes can run within a single binary.
//   - The node's [Tailscale identity] and state are stored in a directory you control.
```

[`tsnet.go#L4-L21`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tsnet/tsnet.go#L4-L21)。

**パッケージのドキュメントが 155 行あり、見出しつきで構成されている。**

- Overview — 通常の Tailscale との違い
- Usage — 最小のコード例
- Authentication — 6 通りの認証方法と優先順位
- Identifying callers — 接続元の身元を知る方法
- Tailscale Funnel — インターネット公開
- Tailscale Services — 名前付きサービス
- Using an exit node — exit node の指定
- Running multiple nodes in one process — 複数ノード

**`go doc` や pkg.go.dev で読める形が、そのまま入門記事になっている。**

そして **各節にコード例がある**。「exit node を使うには」の説明が、`LocalClient` から `EditPrefs` を呼ぶ 5 行のコードで示される。

### 機能を明示的にリンクさせる

```go title="tsnet/tsnet.go"
//  5. Workload identity federation ([Server.ClientID] plus
//     [Server.IDToken] or [Server.Audience]). Available only if the
//     program imports the feature:
//
//     import _ "tailscale.com/feature/identityfederation"
//
//     The feature is not linked by default to keep the AWS SDK and
//     other cloud-provider dependencies out of programs that don't
//     use workload identity federation.
```

[`tsnet.go#L58-L69`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tsnet/tsnet.go#L58-L69)。

**「AWS SDK やその他のクラウドプロバイダの依存を、使わないプログラムから排除するため」** に、機能を既定でリンクしない。

利用者は `import _ "tailscale.com/feature/identityfederation"` を書くことで有効にする。**Go の blank import が、機能のオプトインとして使われている。**

同じ形が SSH にもある。

```go title="tsnet/tsnet.go"
// SSH support must be linked into the binary by importing
// _ "tailscale.com/feature/ssh". Without that import, ListenSSH returns an
// error.
```

[`tsnet.go#L1313-L1315`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tsnet/tsnet.go#L1313-L1315)。

**ライブラリの利用者にとって、依存の大きさは重要だ。** 「Tailscale を使ったら、AWS SDK と gVisor と OpenSSH の実装が全部入った」では困る。

**[ビルドタグ](../build-tags/) が tailscaled のバイナリサイズを削る仕組みなら、blank import は ライブラリ利用者向けの同じ仕組み** になっている。

### 複数ノードの明示

```go title="tsnet/tsnet.go"
// # Running multiple nodes in one process
//
// Each [Server] instance is an independent node. Give each a unique
// [Server.Dir] and [Server.Hostname]:
//
//	for _, name := range []string{"frontend", "backend"} {
//		srv := &tsnet.Server{
//			Hostname:  name,
//			Dir:       filepath.Join(baseDir, name),
//			AuthKey:   os.Getenv("TS_AUTHKEY"),
//			Ephemeral: true,
//		}
//		srv.Start()
//	}
```

[`tsnet.go#L133-L147`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tsnet/tsnet.go#L133-L147)。

**1 プロセスに複数のノードを入れられる** のは、`tailscaled` にはできないことだ。OS のネットワークスタックを使わないので、**インターフェースやルーティングテーブルの衝突がない**。

用途としては、

- **テスト** — 複数ノードの相互作用を 1 プロセスで検証する
- **マルチテナント** — テナントごとに別の tailnet に参加する
- **ゲートウェイ** — 複数の tailnet を橋渡しする

`Dir` の説明も丁寧だ。

```go title="tsnet/tsnet.go"
	// If you want to use multiple tsnet services in the same
	// binary, you will need to make sure that Dir is set uniquely
	// for each service. A good pattern for this is to have a
	// "base" directory (such as your mutable storage folder) and
	// then append the hostname on the end of it.
	Dir string
```

[`tsnet.go#L224-L234`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tsnet/tsnet.go#L224-L234)。

**「良いパターン」まで示している。** 制約 (一意でなければならない) を書くだけでなく、**満たし方の推奨** を添えている。

### ログの分離

```go title="tsnet/tsnet.go"
	// UserLogf, if non-nil, specifies the logger to use for logs generated by
	// the Server itself intended to be seen by the user such as the AuthURL for
	// login and status updates. If unset, log.Printf is used.
	UserLogf logger.Logf

	// Logf, if set is used for logs generated by the backend such as the
	// LocalBackend and MagicSock. It is verbose and intended for debugging.
	// If unset, logs are discarded.
	Logf logger.Logf
```

[`tsnet.go#L250-L258`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tsnet/tsnet.go#L250-L258)。

**ログが 2 系統に分かれ、既定値が逆になっている。**

- **`UserLogf`** — ユーザーに見せるべきログ (認証 URL、状態の変化)。既定は `log.Printf` で **出る**
- **`Logf`** — デバッグ用の詳細ログ。既定は **捨てられる**

ライブラリが勝手に大量のログを出すのは迷惑だ。だが **認証 URL は出さないと、ユーザーがノードを登録できない**。

**「出さないと困るログ」と「出すと迷惑なログ」を型で分けている。** ライブラリを設計するときの実用的な形だ。

### 型アサーションによる拡張

```go title="tsnet/tsnet.go"
// ListenSSH listens on the Tailscale network for SSH connections at the given
// addr (e.g. ":2222"). The returned listener's Accept method yields net.Conn
// values that are actually *tailssh.Session, providing access to the
// connecting peer's Tailscale identity, PTY information, signals, and more.
//
// Basic applications can use the returned connections as plain net.Conn
// (Read/Write/Close). Applications that need richer SSH semantics should
// type-assert to *tailssh.Session.
func (s *Server) ListenSSH(addr string) (net.Listener, error) {
```

[`tsnet.go#L1304-L1318`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tsnet/tsnet.go#L1304-L1318)。

**`net.Listener` を返しつつ、中身は `*tailssh.Session`。**

- **単純な用途** — `net.Conn` として読み書きするだけ。既存のコードが動く
- **高度な用途** — 型アサーションで `*tailssh.Session` を取り出し、PTY やシグナルを扱う

**「標準インターフェースを返しつつ、拡張機能は型アサーションで」** は Go の標準ライブラリでもよく使われる (`net.Conn` を `*net.TCPConn` にアサートする、`http.ResponseWriter` を `http.Flusher` にアサートする)。

[FunnelConn](../serve-funnel/) も同じ形だった。

### 依存関係をコミットする

`tsnet/depaware.txt` は 599 行あり、**tsnet が依存するすべてのパッケージが列挙されている**。

```text
tailscale.com/tsnet dependencies: (generated by github.com/tailscale/depaware)

     💣 crypto/internal/entropy/v1.0.0                               from crypto/internal/fips140/drbg
        filippo.io/edwards25519                                      from github.com/hdevalence/ed25519consensus
   W 💣 github.com/alexbrainman/sspi                                 from github.com/alexbrainman/sspi/internal/common+
 LDW    github.com/coder/websocket                                   from tailscale.com/util/eventbus
```

**記号に意味がある。**

- **💣** — `unsafe` を使っている、または cgo を含むパッケージ
- **L / D / W** — Linux / Darwin / Windows のどれで使われるか

そして **`from` の後に「なぜ依存しているか」** が書かれる。`github.com/coder/websocket` は `tailscale.com/util/eventbus` から来ている。

**このファイルがコミットされているので、依存が増えるとプルリクエストの差分に現れる。** 「この変更で AWS SDK が入った」がレビューで見える。

**依存の管理を、ツールと CI ではなく「差分が見えること」で行っている。**

## なぜそうなっているか

### なぜライブラリ形態が必要なのか

`tailscaled` を動かす前提には、いくつもの障壁がある。

- **権限**: TUN デバイスの作成に root か `CAP_NET_ADMIN` が要る
- **インストール**: パッケージを入れ、サービスとして起動する
- **システム全体への影響**: ルーティングテーブルと DNS を書き換える
- **1 台 1 ノード**: 複数の tailnet に同時参加できない

これらが問題になる場面は多い。

- **コンテナ**: 特権を落として動かしたい
- **CI**: 一時的なノードが欲しい
- **SaaS**: 顧客ごとに別の tailnet に参加したい
- **組み込み**: システムを汚したくない

**ライブラリなら、これら全部が消える。** 代償は「そのプロセスの通信だけが tailnet に乗る」ことだが、**多くの用途ではそれで十分**だ。

### なぜ標準インターフェースを返すのか

独自の `TSListener` や `TSConn` を返すこともできた。だがそうすると、

- **既存のライブラリが使えない**。`http.Serve` も `grpc.Serve` も `net.Listener` を要求する
- **利用者が新しい API を覚える必要がある**
- **テストでモックを作りにくい**

`net.Listener` を返せば、**Go のネットワークエコシステム全体がそのまま使える**。

これは「インターフェースに準拠する」ことの価値の、明快な例だ。**tsnet が実質的にやっているのは「netstack のリスナを `net.Listener` として見せる」ことで、その 1 点が製品としての価値を作っている。**

### なぜ認証方法が 6 つもあるのか

tsnet の利用場面が多様だからだ。

- **開発中** — 対話的なログイン URL
- **CI** — 環境変数の auth key
- **Kubernetes** — Secret から渡す auth key
- **クラウドのワークロード** — ワークロード ID フェデレーション (鍵を配らずに、クラウドの ID で認証する)

**「どれか 1 つに統一する」ができない。** 環境ごとに使える手段が違う。

だから **優先順位を決めて、全部サポートする**。そして **優先順位をドキュメントの箇条書きで明示する** — 「AuthKey が設定されていて、環境変数もある場合はどちらが勝つか」が分かる。

### なぜ機能を blank import でオプトインさせるのか

ライブラリの依存は、利用者のバイナリサイズとビルド時間に直結する。

- **AWS SDK** は数十 MB のソースコード
- **gVisor** も大きい
- **SSH の実装** も

「Tailscale を使いたいだけなのに、AWS SDK が入る」のは受け入れがたい。

**Go には条件付きの依存という概念がない。** import したパッケージは必ずリンクされる。

だから **フックによる登録 + blank import** という形になる。使う人だけが import し、使わない人のバイナリには入らない。

**[tailscaled のビルドタグ](../build-tags/) と目的は同じだが、手段が違う。** バイナリの提供者が削るのがビルドタグ、ライブラリの利用者が足すのが blank import。

### なぜ依存一覧をコミットするのか

Go の依存は推移的に増える。`go.mod` に 1 行足しただけで、**数十のパッケージが入る**ことがある。

`go mod graph` で確認できるが、**変更のたびに実行して比較する人はいない**。

**ファイルとしてコミットしておけば、`go generate` で更新したときに差分が出る。** プルリクエストのレビューで「この変更で新しい依存が 12 個増えている」が見える。

そして **`unsafe` や cgo を使うパッケージに 💣 が付く** ので、「セキュリティ的に注意すべき依存が増えた」も分かる。

**「気づける仕組み」を、ツールではなくバージョン管理の差分で作っている。** CI で失敗させる方法もあるが、**差分として見せるほうが、判断の余地を残せる**。

### なぜログを 2 系統に分けるのか

ライブラリが `log.Printf` を呼ぶのは、一般には悪い設計だ。利用者のログ出力を汚す。

だが tsnet には **どうしても出さなければならないログ** がある。初回起動時の認証 URL だ。これを出さないと、**ユーザーはノードを登録できず、プログラムが永久にブロックする**。

「エラーとして返す」こともできるが、**認証は非同期に完了する** (ブラウザで承認した後)。戻り値では表現しにくい。

**「出さないと機能しないログ」だけを既定で出し、それ以外は捨てる。** そして両方とも差し替え可能にする。

## どう活かすか

**ライブラリとして使える形を用意すると、適用範囲が大きく広がる。** デーモン、CLI、ライブラリ。同じコアを 3 つの形で提供できるなら、それぞれ別の障壁を持つ利用者に届く。**特に「権限が要らない」形があると、コンテナや CI での利用が開ける。**

**標準ライブラリのインターフェースを返す。** 独自の型を返すと、エコシステム全体から切り離される。**`net.Listener` を返すだけで、既存の HTTP/gRPC サーバがそのまま動く。**

**拡張機能は、標準インターフェースを返しつつ型アサーションで提供する。** 単純な用途は標準として使え、高度な用途はアサートする。Go の標準ライブラリ自身がこの形を多用している。

**パッケージのドキュメントを、そのまま入門記事にする。** 見出しで構成し、各節にコード例を置く。`go doc` で読める形が最良のドキュメントになる。**別の場所に書いたドキュメントは、コードと乖離する。**

**制約を書くだけでなく、満たし方の推奨を添える。** 「Dir は一意でなければならない」だけでなく「ベースディレクトリにホスト名を足すのが良いパターン」まで書く。

**ライブラリのログは「出さないと機能しないもの」と「デバッグ用」に分け、既定値を変える。** 前者は出す、後者は捨てる。両方とも差し替え可能にする。

**大きな依存を持つ機能は、blank import でオプトインさせる。** Go では import が即リンクなので、条件付きの依存は「フック + 利用者の import」でしか作れない。**ライブラリの利用者にとって、依存の大きさは採用の判断材料になる。**

**依存関係の一覧をファイルとしてコミットする。** 依存の増減がプルリクエストの差分に現れる。CI で失敗させるより柔軟で、**「なぜこの依存が入ったか」をレビューで議論できる**。
