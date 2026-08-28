---
title: "SSH サーバを自分で実装し、ACL で認可する"
description: "公開鍵も authorized_keys も使わない。接続元の IP から WireGuard のピアを引き、ACL のポリシーで認可する。ローカルユーザーへの切り替えは「incubator」という別プロセスに委譲し、可能なら OS の login コマンドに丸投げして PAM を通す。"
group: "その上に載るもの"
sidebar:
  order: 37
---

## 何を学んだか

### 鍵の管理をなくす

普通の SSH では、サーバの `~/.ssh/authorized_keys` に公開鍵を登録する。**この管理が運用の負担になる** — 誰の鍵がどのサーバにあるかを追えなくなり、退職した人の鍵が残る。

Tailscale SSH は **鍵を使わない**。接続元の IP アドレスから、

1. **WireGuard の復号で確定している** ピアのノードを引く
2. そのノードのユーザーと、ACL の SSH ポリシーを照合する
3. 許可されていれば、指定されたローカルユーザーとして起動する

**認証は既に済んでいるので、SSH がやるのは認可だけ** になる。

### 判定結果は 4 種類の SSHAction

ポリシーの評価結果は `tailcfg.SSHAction` という構造体で表される。

- `Accept` — 即座に許可
- `Reject` — 拒否
- `HoldAndDelegate` — **URL を long poll して、後から判定を受け取る**
- `SessionDuration`、`Recorders`、各種の forwarding 許可

`HoldAndDelegate` が「check mode」を実現している。**接続を保留したまま、ユーザーにブラウザでの再認証を求められる。**

### 権限の降格は別プロセスに任せる

`tailscaled` は root で動く。SSH で `alice` としてログインしたら、**`alice` の権限でシェルを起動する**必要がある。

Go では `setuid` を安全に呼べない (goroutine ごとに UID が変わる)。そこで **「incubator」という子プロセスを起動し、そこで UID/GID を設定してから目的のコマンドを exec する**。

### 可能なら OS の login コマンドに委譲する

incubator は、条件が揃えば **OS の `login` コマンドを exec する**。

これにより、

- リモート IP がログイン記録に残る (`utmp`、`lastlog`)
- **PAM の認証が走り、"remote" プロファイルが適用される**
- 環境変数やセッションの設定が OS の流儀どおりになる

## ソースコードのどこか

### 接続元の身元を確定する

```go title="ssh/tailssh/tailssh.go"
// connInfo populates the sshConnInfo from the provided arguments,
// validating only that they represent a known Tailscale identity.
func (c *conn) setInfo(cm ssh.ConnMetadata) error {
	if c.info != nil {
		return nil
	}
	ci := &sshConnInfo{
		sshUser: strings.TrimSuffix(cm.User(), forcePasswordSuffix),
		src:     toIPPort(cm.RemoteAddr()),
		dst:     toIPPort(cm.LocalAddr()),
	}
	if !tsaddr.IsTailscaleIP(ci.dst.Addr()) {
		return fmt.Errorf("tailssh: rejecting non-Tailscale local address %v", ci.dst)
	}
	if !tsaddr.IsTailscaleIP(ci.src.Addr()) {
		return fmt.Errorf("tailssh: rejecting non-Tailscale remote address %v", ci.src)
	}
	node, uprof, ok := c.srv.lb.WhoIs("tcp", ci.src)
	if !ok {
		return fmt.Errorf("unknown Tailscale identity from src %v", ci.src)
	}
	ci.node = node
	ci.uprof = uprof
```

[`tailssh.go#L641-L664`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ssh/tailssh/tailssh.go#L641-L664)。

**検証は 3 段階。**

1. **宛先が Tailscale の IP か** — 通常の SSH ポート経由で来ていないことを確認
2. **送信元が Tailscale の IP か** — 同上
3. **`WhoIs` でノードとユーザープロファイルを引く** — 引けなければ拒否

`WhoIs` は [netmap](../netmap/) の情報から「この IP はどのノードか」を引く。**IP がノードに紐づくのは WireGuard が保証しているので、これが認証になる。**

送信元と宛先の両方を確認するのが重要だ。**Tailscale の IP 以外からの接続を、SSH サーバが受けてはいけない。**

### ポリシーの評価

```go title="ssh/tailssh/tailssh.go"
	action, localUser, acceptEnv, result := c.evaluatePolicy()
	switch result {
	case accepted:
		// do nothing
	case rejectedUser:
		return nil, c.errBanner(fmt.Sprintf("tailnet policy does not permit you to SSH as user %q", c.info.sshUser), nil)
	case rejected, noPolicy:
		return nil, c.errBanner("tailnet policy does not permit you to SSH to this node", fmt.Errorf("failed to evaluate policy, result: %s", result))
	default:
		return nil, c.errBanner("failed to evaluate tailnet policy", fmt.Errorf("failed to evaluate policy, result: %s", result))
	}
```

[`tailssh.go#L349-L359`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ssh/tailssh/tailssh.go#L349-L359)。

**拒否の理由をユーザーに区別して伝える。**

- **`rejectedUser`**: 「そのユーザーとして SSH する権限がない」 — ユーザー名を変えれば通るかもしれない
- **`rejected` / `noPolicy`**: 「このノードに SSH する権限がない」 — 諦めるしかない

`errBanner` は SSH のバナーとしてメッセージを表示する。**ログを見られない相手にも、失敗の理由が届く。**

一般には「認証失敗の理由を詳しく教えない」のが原則だ。だがここでは **接続してきた相手の身元が既に確定している** ので、その相手に理由を教えても情報漏洩にならない。

### SSHAction の構造

```go title="tailcfg/tailcfg.go"
type SSHAction struct {
	// Message, if non-empty, is shown to the user before the action occurs.
	Message string `json:"message,omitempty"`

	// Reject, if true, terminates the connection. This action
	// has higher priority that Accept, if given.
	Reject bool `json:"reject,omitempty"`

	// Accept, if true, accepts the connection immediately
	// without further prompts.
	Accept bool `json:"accept,omitempty"`

	// SessionDuration, if non-zero, is how long the session can stay open
	// before being forcefully terminated.
	// It is encoded as an int64 of nanoseconds (Go's time.Duration
	// wire format for encoding/json v1). It must not use a jsonv2
	// format tag; the mere presence of one makes Go 1.27's
	// encoding/json fail to decode the struct. See
	// https://github.com/tailscale/tailscale/issues/20528.
	SessionDuration time.Duration `json:"sessionDuration,omitempty"`
	...
	// HoldAndDelegate, if non-empty, is a URL that serves an
	// outcome verdict.  The connection will be accepted and will
	// block until the provided long-polling URL serves a new
	// SSHAction JSON value. The URL must be fetched using the
	// Noise transport (in package control/control{base,http}).
	//
	// The following variables in the URL are expanded by tailscaled:
	//
	//   * $SRC_NODE_IP (URL escaped)
	//   * $SRC_NODE_ID (Node.ID as int64 string)
	//   ...
	HoldAndDelegate string `json:"holdAndDelegate,omitempty"`
```

[`tailcfg.go#L2735-L2780`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/tailcfg/tailcfg.go#L2735-L2780)。

**`HoldAndDelegate` が「判定を後回しにする」仕組みだ。**

URL に接続の情報を埋め込んで long poll する。サーバは「ユーザーがブラウザで承認したら `{"accept": true}` を返す」といった処理ができる。**SSH のプロトコルを変えずに、多要素認証やジャストインタイムのアクセス承認が実現できる。**

そして **判定結果が同じ `SSHAction` 型** なので、再帰的に `HoldAndDelegate` を返すこともできる。

`SessionDuration` のコメントは Go の JSON 実装の落とし穴を記録している。**「jsonv2 のフォーマットタグを付けてはいけない。付けるだけで Go 1.27 の encoding/json がこの構造体をデコードできなくなる」** — issue 番号つき。

### incubator の役割

```go title="ssh/tailssh/incubator.go"
// This file contains the code for the incubator process.  Tailscaled
// launches the incubator as the same user as it was launched as.  The
// incubator then registers a new session with the OS, sets its UID
// and groups to the specified `--uid`, `--gid` and `--groups`, and
// then launches the requested `--cmd`.
```

```go title="ssh/tailssh/incubator.go"
func init() {
	childproc.Add("ssh", beIncubator)
	childproc.Add("sftp", beSFTP)
}
```

[`incubator.go#L4-L31`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ssh/tailssh/incubator.go#L4-L31)。

**`tailscaled` が自分自身を、違う引数で起動する。** `childproc` は「サブコマンドとして自分を再実行する」ための仕組みだ。

そして子プロセスの中で UID/GID を設定し、目的のコマンドを exec する。

**なぜ別プロセスが要るのか。** Go のランタイムは複数の OS スレッドで goroutine を動かす。Linux の `setuid` は **呼んだスレッドの UID しか変えない** (POSIX の意味論とは違う)。Go の `syscall.Setuid` は全スレッドに伝播させようとするが、**確実性と順序の問題がある**。

**新しいプロセスを作って、goroutine が 1 つしかない状態で UID を変える** のが確実だ。

### login コマンドへの委譲

```go title="ssh/tailssh/incubator.go"
// tryExecLogin attempts to handle the ssh session by creating a full login
// shell using the login command. If it never tried, it returns nil. If it
// failed to do so, it returns an error.
//
// Creating a login shell in this way allows us to register the remote IP of
// the login session, trigger PAM authentication, and get the "remote" PAM
// profile.
//
// However, login is subject to some limitations.
//
// 1. login cannot be used to execute commands except on macOS.
// 2. On Linux and BSD, login requires a TTY to keep running.
//
// In these cases, tryExecLogin returns (false, nil) to indicate that processing
// should fall through to other methods, such as using the su command.
//
// Note that this uses unix.Exec to replace the current process, so in cases
// where we actually do run login, no subsequent Go code will execute.
func tryExecLogin(dlogf logger.Logf, ia incubatorArgs) error {
```

[`incubator.go#L535-L553`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ssh/tailssh/incubator.go#L535-L553)。

**「できるだけ OS の仕組みに任せる」という方針が、コメントで説明されている。**

`login` を使う利点。

- **リモート IP がログイン記録に残る** (`last` コマンドで見える)
- **PAM が走る** — 組織のポリシー (アカウントのロック、時間帯制限、追加の認証) が適用される
- **"remote" プロファイル** — ローカルログインとリモートログインで PAM の設定を分けている環境で、正しいほうが選ばれる

制約も明記されている。

```go title="ssh/tailssh/incubator.go"
	switch runtime.GOOS {
	case linux, freebsd, openbsd:
		if !ia.hasTTY {
			dlogf("can't use login because of missing TTY")
			// We can only use the login command if a shell was requested with
			// a TTY. If there is no TTY, login exits immediately, which
			// breaks things like mosh and VSCode.
			return nil
		}
	}
```

[`incubator.go#L562-L571`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ssh/tailssh/incubator.go#L562-L571)。

**「TTY がないと login は即座に終了し、mosh や VSCode が壊れる」。** 具体的に壊れるものの名前が書かれている。

そして **`unix.Exec` でプロセスを置き換えるので、以降の Go のコードは実行されない**。この注意がないと、`tryExecLogin` の後にクリーンアップを書いてしまう。

### 後方互換のためのフラグ

```go title="ssh/tailssh/incubator.go"
	flags.BoolVar(&ia.forceV1Behavior, "force-v1-behavior", false, "allow falling back to the su command if login is unavailable")
	...
	// DEPRECATED: retained for version-skew compatibility only. DO NOT USE.
	flags.StringVar(&ia.encodedEnv, "encoded-env", "", "deprecated; do not use")
	flags.IntVar(&ia.envFD, "env-fd", -1, "file descriptor to read the forwarded environment from (JSON array of KEY=VALUE pairs)")
```

[`incubator.go#L323-L328`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ssh/tailssh/incubator.go#L323-L328)。

**親プロセスと子プロセスのバージョンが違うことがある。** `tailscaled` を更新した後、既存のプロセスが古いバイナリを exec するかもしれない。

だから **廃止したフラグも受け付け続ける**。「バージョンスキュー互換のためだけに残している。使うな」。

環境変数の渡し方が `--encoded-env` (コマンドライン) から `--env-fd` (ファイルディスクリプタ) に変わっているのも興味深い。**コマンドラインは `ps` で他のユーザーから見える** ので、環境変数を載せるべきではない。

```go title="ssh/tailssh/incubator.go"
	// envFD comes from an ExtraFiles entry, so it must never name stdin/out/err
	if ia.envFD >= 0 && ia.envFD < 3 {
		return ia, fmt.Errorf("invalid --env-fd %d: must be >= 3", ia.envFD)
	}
```

[`incubator.go#L339-L342`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ssh/tailssh/incubator.go#L339-L342)。

**ファイルディスクリプタ番号の検証。** 0/1/2 (stdin/stdout/stderr) を指定されたら、**標準入出力を環境変数として読んでしまう**。攻撃者がこれを操作できれば、任意の環境変数を注入できる。

### シャットダウン時の扱い

```go title="ssh/tailssh/tailssh.go"
// attachSessionToConnIfNotShutdown ensures that we only attach a session to a
// conn if the server hasn't been shut down...
// It reports whether ss was attached to the conn.
func (srv *server) attachSessionToConnIfNotShutdown(ss *sshSession) bool {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.shutdownCalled {
		// Do not start any new sessions.
		return false
	}
	ss.conn.attachSession(ss)
	return true
}
```

[`tailssh.go#L133-L145`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ssh/tailssh/tailssh.go#L133-L145)。

**「シャットダウン中か確認する」と「セッションを登録する」を、1 つのミューテックスの中で行う。**

分けると競合が起きる。「シャットダウンしていないと確認」→ (シャットダウンが走る) → 「セッションを登録」となると、**シャットダウン処理が見逃したセッションが残る**。

**チェックと登録を不可分にすることで、この競合がなくなる。** 関数名が長いのは、この不可分性を名前で表現しているからだ。

## なぜそうなっているか

### なぜ SSH サーバを自前で実装するのか

既存の `sshd` を使い、その認証を Tailscale と連携させることもできる。実際、`AuthorizedKeysCommand` などの仕組みはある。

だが自前で実装すると、

- **鍵の管理が完全に不要になる**。`authorized_keys` も、鍵の配布も、失効も
- **ACL と統合できる**。「誰がどのサーバに、どのユーザーとして SSH できるか」を admin console の 1 か所で書ける
- **セッションの録画、時間制限、承認フローを組み込める**
- **設定ファイルが要らない**。`sshd_config` を触らない

そして **Tailscale の IP からしか接続を受けない** ので、攻撃面が tailnet 内に限定される。

代償は、**SSH プロトコルの実装を自分で保守すること**だ (gliderlabs/ssh のフォークを使っている)。プロトコルの脆弱性に自分で対応する必要がある。

### なぜ認証ではなく認可だけなのか

普通の SSH では、**サーバは接続元が誰かを知らない**。だから公開鍵で証明させる。

Tailscale では、**パケットが届いた時点で送信元のノードが確定している**。WireGuard の復号を通ったということは、そのノードの秘密鍵を持っているということだ。

**認証をやり直す意味がない。** [peerAPI がトークンを持たない](../peerapi/) のと同じ理屈で、下の層が保証していることを上の層で繰り返さない。

残るのは「そのノードのユーザーは、このマシンに、このローカルユーザーとしてログインしてよいか」という認可だけになる。

### なぜ HoldAndDelegate があるのか

SSH のプロトコルには「認証を保留して、別の経路で承認を待つ」という仕組みがない。キーボードインタラクティブ認証で近いことはできるが、扱いにくい。

`HoldAndDelegate` は **接続を受け入れてから、判定を待つ**。ユーザーの端末では「接続待ち」に見え、ブラウザで承認すると進む。

これで実現できるもの。

- **多要素認証** — 本番サーバへの SSH には、追加の承認を要求する
- **ジャストインタイムのアクセス** — 普段は権限がなく、必要なときだけ承認を得る
- **監査** — 「誰がいつ承認したか」が記録される

**判定を返す URL が同じ `SSHAction` を返す** ので、プロトコルが再帰的になっている。承認の後に別の条件を課すこともできる。

### なぜ incubator が別プロセスなのか

Go で `setuid` を安全に使えない。理由は Go のランタイムの構造にある。

- **Go は複数の OS スレッドで goroutine を動かす**
- **Linux の `setuid(2)` は、呼んだスレッドの UID だけを変える** (POSIX は「プロセス全体」と定めているが、Linux の実装はスレッド単位)
- glibc は全スレッドにシグナルを送って同期するが、**Go はそれをしない** (Go 1.16 以降は `syscall.Setuid` が全スレッドに適用されるようになったが、それでも制約がある)

**新しいプロセスを起動すれば、goroutine が 1 つしかない状態で UID を変えられる。** そして exec すれば、Go のランタイムごと置き換わる。

**「言語のランタイムと OS の意味論が食い違う場面では、プロセスの境界を使う」** という解決策だ。

### なぜ login コマンドに委譲するのか

ローカルユーザーとしてシェルを起動するだけなら、`setuid` して `exec /bin/bash` で足りる。

だが **組織のシステムには、ログインに紐づく仕組みがたくさんある**。

- **PAM**: アカウントの有効期限、時間帯制限、追加の認証、セッションの制限
- **utmp/wtmp**: `who`、`last` で見えるログイン記録
- **SELinux のコンテキスト**: ユーザーごとのセキュリティラベル
- **cgroup/systemd のセッション**: リソース制限、ログアウト時のクリーンアップ

**これらを自前で実装するのは、量も多く、間違いやすい。** `login` に任せれば、その OS の流儀どおりになる。

そして **管理者が既に PAM を設定している場合、それが尊重される**。「Tailscale SSH だけ PAM を無視する」となると、セキュリティポリシーに穴が開く。

### なぜ廃止したフラグを残すのか

`tailscaled` は自分自身を exec して incubator にする。だが **exec するのは「現在ディスク上にあるバイナリ」** だ。

パッケージマネージャが `tailscaled` を更新した後、**動いているプロセスは古いバージョン、ディスク上のバイナリは新しいバージョン** という状態になる。

古いプロセスが新しいバイナリを exec すると、**古い引数が新しいバイナリに渡される**。新しいバイナリが古いフラグを知らなければ、SSH セッションが開始できない。

**「自分自身を exec する」設計では、引数の後方互換が必要になる。** そしていつ消せるかは「そのバージョンを使っているユーザーがいなくなったとき」で、判断が難しい。

## どう活かすか

**下の層が身元を保証しているなら、上の層は認可だけを行う。** mTLS、VPN、サービスメッシュ。「認証済み」の情報をどう受け取るかを決めれば、上の層から認証のコードが消える。**その代わり「下の層が保証していること」を明文化する。**

**認可の失敗理由は、相手が既に特定できているなら教えてよい。** 「このユーザーとしては許可されていない」と「このホストに許可されていない」を区別すると、ユーザーが自分で解決できる。**匿名の相手には教えない、という原則の境界を意識する。**

**判定を保留して外部に委譲する仕組みは、1 つのフィールドで足りる。** URL を返して long poll させ、同じ型の判定を受け取る。プロトコルを変えずに、多要素認証や承認フローが後から載る。**再帰的な型にしておくと、多段の承認もできる。**

**言語のランタイムと OS の意味論が食い違う操作は、プロセスの境界で解決する。** `setuid`、`chroot`、名前空間の変更。新しいプロセスを起動して、そこで実行する。Go に限らず、スレッドを持つランタイムでは共通の問題だ。

**OS が持つ仕組み (PAM、utmp、SELinux) は、自前で再実装せず既存のコマンドに委譲する。** `login`、`su`。委譲できない条件 (TTY がない、コマンド実行) を列挙し、そこだけ自前で処理する。**組織の既存のポリシーが尊重されることが、導入の条件になる。**

**自分自身を exec する設計では、引数の後方互換が必要になる。** バイナリの更新と実行中プロセスの寿命がずれる。廃止したフラグも受け付け、「互換のためだけ、使うな」と書いておく。

**子プロセスに秘密を渡すなら、コマンドライン引数ではなくファイルディスクリプタを使う。** `ps` は他のユーザーから見える。そして **FD 番号が 0/1/2 でないことを検証する** — 標準入出力を秘密として読むと、注入の経路になる。

**チェックと状態変更は、同じロックの中で行う。** 「シャットダウンしていないか確認」と「セッションを登録」を分けると、その隙間でシャットダウンが走る。**不可分性を関数名で表現する** と、呼び出し側が分割しようとしない。
