---
title: "OS の DNS 設定を、6 通りの方法で書き換える"
description: "Linux だけで systemd-resolved・NetworkManager・resolvconf 2 種・resolv.conf 直接書き換えの 5 通りがある。どれを使うかは /etc/resolv.conf のコメント行から推測する。NetworkManager 1.26.0〜1.26.5 だけを特別扱いする理由が、40 行のコメントで説明されている。"
group: "DNS"
sidebar:
  order: 32
---

## 何を学んだか

### 「DNS サーバを設定する」に標準的な方法がない

[MagicDNS のリゾルバ](../magicdns-resolver/)を `100.100.100.100` で動かしても、**OS がそこに問い合わせなければ意味がない**。

だが「システムの DNS サーバを設定する」方法は、OS ごとに、さらに Linux ではディストリビューションと構成ごとに違う。

| OS / 構成                      | 方法                          |
| ------------------------------ | ----------------------------- |
| Linux + systemd-resolved       | D-Bus API                     |
| Linux + NetworkManager         | D-Bus API                     |
| Linux + resolvconf (Debian 系) | `resolvconf` コマンド         |
| Linux + openresolv             | 同上、ただし引数が違う        |
| Linux (その他)                 | `/etc/resolv.conf` を直接書く |
| Windows                        | NRPT (レジストリ)             |
| macOS                          | `scutil` / システム設定       |
| その他                         | それぞれ独自                  |

`net/dns/` には `manager_linux.go`、`manager_windows.go`、`manager_darwin.go`、`manager_freebsd.go`、`manager_openbsd.go`、`manager_solaris.go`、`manager_plan9.go` が並ぶ。

### /etc/resolv.conf のコメントから所有者を当てる

Linux では **`/etc/resolv.conf` の先頭のコメント行を読んで、誰がこのファイルを管理しているかを推測する**。

```text
# This file is managed by man:systemd-resolved(8). Do not edit.
```

このような行があれば systemd-resolved。`NetworkManager` や `resolvconf` の文字列があれば、それぞれ。

**規約でも API でもなく、コメントの文字列を見ている。**

### 判定の全過程をログに残す

`dnsMode` 関数は、判定の各ステップを `kv` のリストに積み、**最後にまとめて 1 行で出力する**。

```text
dns: [rc resolved nm yes nm-resolved yes nm-safe no ret systemd-resolved]
```

「resolv.conf は resolved のもの、NetworkManager もいる、NM は resolved を使っている、だが NM のバージョンは安全でない、結論は systemd-resolved」。

### NetworkManager の特定バージョンだけを特別扱いする

**NetworkManager 1.26.0 から 1.26.5 のときだけ、NetworkManager 経由で設定する**。それ以外は systemd-resolved を直接叩く。

理由は 40 行のコメントで説明されている。

## ソースコードのどこか

### 実装の選択

```go title="net/dns/manager_linux.go"
	mode, err := dnsMode(logf, health, env)
	if err != nil {
		return nil, err
	}
	publishOnce.Do(func() {
		sanitizedMode := strings.ReplaceAll(mode, "-", "_")
		m := clientmetric.NewGauge(fmt.Sprintf("dns_manager_linux_mode_%s", sanitizedMode))
		m.Set(1)
	})
	logf("dns: using %q mode", mode)
	switch mode {
	case "direct":
		return newDirectManagerOnFS(logf, health, bus, env.fs), nil
	case "systemd-resolved":
		...
	case "network-manager":
		...
	case "debian-resolvconf":
		return newDebianResolvconfManager(logf)
	case "openresolv":
		return newOpenresolvManager(logf)
	default:
		logf("[unexpected] detected unknown DNS mode %q, using direct manager as last resort")
	}
```

[`manager_linux.go#L92-L124`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager_linux.go#L92-L124)。

**選ばれたモードが、モードごとのゲージメトリクスとして記録される。** `dns_manager_linux_mode_systemd_resolved` に 1 を立てる。

これを集計すれば **「全ユーザーのうち、どのモードが何 % か」が分かる**。[ファイアウォールの判定結果](../router-firewall/) と同じパターンで、**判定ロジックの妥当性を実データで検証できる。**

そして未知のモードでも `direct` にフォールバックする。**`[unexpected]` のログを出しつつ、動作は継続する。**

### 判定を関数から切り離す

```go title="net/dns/manager_linux.go"
// newOSConfigEnv are the funcs newOSConfigurator needs, pulled out for testing.
type newOSConfigEnv struct {
	fs                wholeFileFS
	dbusPing          func(string, string) error
	dbusReadString    func(string, string, string, string) (string, error)
	nmIsUsingResolved func() error
	nmVersionBetween  func(v1, v2 string) (safe bool, err error)
	resolvconfStyle   func() string
}
```

[`manager_linux.go#L126-L134`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager_linux.go#L126-L134)。

**判定に必要な外部依存が、6 つの関数として構造体にまとめられている。**

ファイルシステム、D-Bus の疎通確認、D-Bus のプロパティ読み取り、NetworkManager の状態確認、バージョン比較、resolvconf の種類判定。

これで **`dnsMode` は純粋な関数に近くなる**。テストでは 6 つを差し替えて、「resolv.conf にこう書いてあり、D-Bus に resolved がいて、NM が 1.26.3 のとき、何を選ぶか」を検証できる。

`manager_linux_test.go` は 16 KB あり、この組み合わせを網羅している。

### 判定の過程を記録する

```go title="net/dns/manager_linux.go"
func dnsMode(logf logger.Logf, health *health.Tracker, env newOSConfigEnv) (ret string, err error) {
	var debug []kv
	dbg := func(k, v string) {
		debug = append(debug, kv{k, v})
	}
	defer func() {
		if ret != "" {
			dbg("ret", ret)
		}
		logf("dns: %v", debug)
	}()
```

[`manager_linux.go#L136-L146`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager_linux.go#L136-L146)。

**判定の各分岐で `dbg("key", "value")` を呼び、最後に `defer` でまとめて出力する。**

分岐ごとにログを出すと行が散らばり、順序が読みにくくなる。**1 行にまとめると、判定の経路が一目で追える。**

そして `defer` なので、**どの return path を通っても必ず出力される**。早期リターンが多い関数で、ログの漏れを防げる。

### D-Bus を先に叩く理由

```go title="net/dns/manager_linux.go"
	// Before we read /etc/resolv.conf (which might be in a broken
	// or symlink-dangling state), try to ping the D-Bus service
	// for systemd-resolved. If it's active on the machine, this
	// will make it start up and write the /etc/resolv.conf file
	// before it replies to the ping. (see how systemd's
	// src/resolve/resolved.c calls manager_write_resolv_conf
	// before the sd_event_loop starts)
	resolvedUp := env.dbusPing("org.freedesktop.resolve1", "/org/freedesktop/resolve1") == nil
```

[`manager_linux.go#L167-L175`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager_linux.go#L167)。

**systemd の socket activation を利用している。**

systemd-resolved がまだ起動していない状態では、`/etc/resolv.conf` が壊れたシンボリックリンクのままかもしれない。そこを読んでも判断できない。

D-Bus に ping を打つと **systemd が resolved を起動し、resolved は起動処理の中で `/etc/resolv.conf` を書く**。ping の応答が返る頃には、ファイルが正しい状態になっている。

**systemd のソースコードの該当箇所 (`manager_write_resolv_conf` が `sd_event_loop` の前に呼ばれる) を参照している。** この順序が保証される根拠を、他プロジェクトのコードに求めている。

### コメントから所有者を推測する

```go title="net/dns/direct.go"
func resolvOwner(bs []byte) string {
	likely := ""
	b := bytes.NewBuffer(bs)
	for {
		line, err := b.ReadString('\n')
		if err != nil {
			return likely
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if line[0] != '#' {
			// First non-empty, non-comment line. Assume the owner
			// isn't hiding further down.
			return likely
		}

		if strings.Contains(line, "systemd-resolved") {
			likely = "systemd-resolved"
		} else if strings.Contains(line, "NetworkManager") {
			likely = "NetworkManager"
		} else if strings.Contains(line, "resolvconf") {
			likely = "resolvconf"
		}
	}
}
```

[`direct.go#L64-L90`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/direct.go#L64-L90)。

**ヘッダのコメント行だけを見て、最初の実質的な行が来たら止める。**

「所有者がさらに下に隠れているとは仮定しない」。ファイル全体を走査すると、`nameserver` の行に偶然文字列が含まれるかもしれない。**ヘッダに限定することで誤検出を減らしている。**

`likely` という変数名が正直だ。**これは推測であって、確証ではない。**

### 誤ったヘッダへの対処

```go title="net/dns/manager_linux.go"
	switch resolvOwner(bs) {
	case "systemd-resolved":
		dbg("rc", "resolved")

		// Some systems, for reasons known only to them, have a
		// resolv.conf that has the word "systemd-resolved" in its
		// header, but doesn't actually point to resolved. We mustn't
		// try to program resolved in that case.
		// https://github.com/tailscale/tailscale/issues/2136
		if err := resolvedIsActuallyResolver(logf, env, dbg, bs); err != nil {
			logf("dns: resolvedIsActuallyResolver error: %v", err)
			dbg("resolved", "not-in-use")
			return "direct", nil
		}
```

[`manager_linux.go#L187-L200`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager_linux.go#L187)。

**「彼らにしか分からない理由で、ヘッダに systemd-resolved と書いてあるのに、実際は resolved を指していないシステムがある」。**

推測が外れるケースが実在するので、**推測の後に検証を入れる**。`nameserver` の行が resolved のアドレス (`127.0.0.53`) を指しているかを確認する。

**「推測 → 検証 → フォールバック」の 3 段構え。** 推測だけで動かすと、issue #2136 のような環境で壊れる。

### 40 行の判断

```go title="net/dns/manager_linux.go"
		// Version of NetworkManager before 1.26.6 programmed resolved
		// incorrectly, such that NM's settings would always take
		// precedence over other settings set by other resolved
		// clients.
		//
		// If we're dealing with such a version, we have to set our
		// DNS settings through NM to have them take.
		//
		// However, versions 1.26.6 later both fixed the resolved
		// programming issue _and_ started ignoring DNS settings for
		// "unmanaged" interfaces - meaning NM 1.26.6 and later
		// actively ignore DNS configuration we give it. So, for those
		// NM versions, we can and must use resolved directly.
		//
		// Even more fun, even-older versions of NM won't let us set
		// DNS settings if the interface isn't managed by NM, with a
		// hard failure on DBus requests. Empirically, NM 1.22 does
		// this. Based on the versions popular distros shipped, we
		// conservatively decree that only 1.26.0 through 1.26.5 are
		// "safe" to use for our purposes.
		//
		// In a perfect world, we'd avoid this by replacing
		// configuration out from under NM entirely (e.g. using
		// directManager to overwrite resolv.conf), but in a world
		// where resolved runs, we need to get correct configuration
		// into resolved regardless of what's in resolv.conf (because
		// resolved can also be queried over dbus, or via an NSS
		// module that bypasses /etc/resolv.conf).
		safe, err := env.nmVersionBetween("1.26.0", "1.26.5")
```

[`manager_linux.go#L212-L246`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/manager_linux.go#L212)。

**このコメントは、3 つのバージョン帯の挙動を記述している。**

| NM のバージョン | 挙動                                                             | 対処                  |
| --------------- | ---------------------------------------------------------------- | --------------------- |
| 〜1.25          | 管理外インターフェースの DNS 設定を D-Bus で拒否する             | resolved を直接使う   |
| 1.26.0〜1.26.5  | resolved の設定を誤って行い、NM の設定が常に優先される           | **NM 経由で設定する** |
| 1.26.6〜        | 修正されたが、管理外インターフェースの設定を無視するようになった | resolved を直接使う   |

**「バグのある狭いバージョン帯だけを特別扱いする」** という判断で、しかもその帯は「人気のディストリビューションが出荷したバージョンから保守的に決めた」とある。

そして最後の段落が、なぜ「resolv.conf を上書きする」という単純な解決策を取れないかを説明している。**resolved は D-Bus 経由や NSS モジュール経由でも問い合わせられるので、`/etc/resolv.conf` を書き換えても効かない経路が残る。**

**この 40 行がなければ、`nmVersionBetween("1.26.0", "1.26.5")` という条件は完全に意味不明だ。**

### Windows の NRPT

```go title="net/dns/nrpt_windows.go"
const (
	nrptBaseLocal = `SYSTEM\CurrentControlSet\Services\Dnscache\Parameters\DnsPolicyConfig`
	nrptBaseGP    = `SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig`

	nrptOverrideDNS = 0x8 // bitmask value for "use the provided override DNS resolvers"

	// Apparently NRPT rules cannot handle > 50 domains.
	nrptMaxDomainsPerRule = 50

	// This is the legacy rule ID that previous versions used when we supported
	// only a single rule. Now that we support multiple rules are required, we
	// generate their GUIDs and store them under the Tailscale registry key.
	nrptSingleRuleID = `{5abe529b-675b-4486-8459-25a634dacc23}`
```

[`nrpt_windows.go#L10-L23`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/dns/nrpt_windows.go#L10-L23)。

**Windows では、レジストリに NRPT (Name Resolution Policy Table) のルールを書く。**

- **1 ルールあたり 50 ドメインまで**。「どうやらそうらしい」(`Apparently`) という書き方で、**ドキュメントに書かれていない制限を実験で見つけた** ことが分かる
- **レジストリのキーが 2 つある**。ローカルポリシー用とグループポリシー用
- **古い GUID がハードコードされている**。以前のバージョンが作ったルールを掃除するため

**「以前のバージョンが残したもの」を掃除するコードは、書き換え系の機能では必ず要る。** アンインストールや更新の途中で失敗すると、古い設定が残る。

## なぜそうなっているか

### なぜコメントから推測するのか

`/etc/resolv.conf` を誰が管理しているかを **正しく知る API はない**。

- **プロセスを見る**: systemd-resolved が動いていても、resolv.conf を管理しているとは限らない
- **シンボリックリンクを見る**: `/run/systemd/resolve/stub-resolv.conf` へのリンクなら resolved だが、リンクでない構成もある
- **ファイルの所有者を見る**: 全部 root

**各ツールが自分のヘッダコメントを書く** という慣習だけが、事実上の識別子になっている。

Tailscale はこれを使い、**外れる場合に備えて検証を足している**。「規約がないなら、慣習を使って、慣習が破られた場合に備える」という現実的な対応だ。

### なぜ判定を 1 行のログにまとめるのか

DNS の設定が効かないという報告を受けたとき、開発者が最初に知りたいのは **「どのモードが選ばれ、なぜそうなったか」** だ。

分岐ごとにログを出すと、

- 他のログに埋もれる
- 順序が入れ替わる (並行処理があれば)
- どこで判定が終わったかが見えにくい

**`[rc resolved nm yes nm-resolved yes nm-safe no ret systemd-resolved]` の 1 行があれば、判定木のどの葉に落ちたかが完全に分かる。**

そして `defer` で出力するので、**どの return path でも必ず記録される**。判定が 10 箇所から return する関数で、ログの漏れをなくす方法として有効だ。

### なぜバージョンの範囲を「保守的に」決めるのか

NetworkManager のどのバージョンが問題を持つかは、**変更のコミットを追えば正確に分かる**。だが、

- ディストリビューションが **修正をバックポートする** ことがある
- ベンダが独自のパッチを当てていることがある
- バージョン文字列が正確でないことがある

「1.26.0 から 1.26.5」という範囲は、**人気のディストリビューションが実際に出荷したバージョンから決めた** とある。理論上の範囲ではなく、**実際に存在するバージョンの範囲** だ。

そして「安全」と判定する範囲を狭く取る。**外した場合、狭すぎれば「resolved 直接」に落ちるだけで、多くの場合それでも動く。** 広すぎると、NM 経由で設定して効かない環境が出る。

**「間違えたときにどちらがマシか」で範囲を決めている。**

### なぜ resolv.conf を上書きしないのか

最も単純な解決策は、**`/etc/resolv.conf` を Tailscale が書き換えて `nameserver 100.100.100.100` にする** ことだ。実際 `direct` モードはそうする。

だが systemd-resolved が動いている環境では効かない。理由がコメントに書かれている。

> **resolved は D-Bus 経由でも、`/etc/resolv.conf` を迂回する NSS モジュール経由でも問い合わせられる。**

`/etc/resolv.conf` は、**libc の resolver が読むファイル** にすぎない。systemd 環境では `nss-resolve` モジュールが使われ、ファイルを読まずに直接 resolved に D-Bus で問い合わせる。

**「設定ファイルを書き換える」が効くのは、そのファイルを読む経路だけ。** 経路が複数ある環境では、設定の source of truth に直接書き込むしかない。

## どう活かすか

**環境の判定は「推測 → 検証 → フォールバック」の 3 段にする。** 慣習 (ヘッダのコメント) で当たりを付け、実際の状態 (nameserver の値) で確かめ、外れたら安全な既定に落ちる。推測だけだと、慣習が守られていない環境で壊れる。

**判定の過程をキーと値のリストに積み、最後に 1 行で出す。** 分岐ごとのログは埋もれる。`defer` でまとめて出せば、どの経路を通っても必ず記録され、判定木のどこに落ちたかが 1 行で分かる。

**判定に使う外部依存を、関数のフィールドとして切り出す。** ファイル読み取り、D-Bus、バージョン取得。テストで差し替えられれば、「この環境ならこう判定する」を組み合わせで検証できる。**判定ロジックが複雑なほど、この分離の価値が高い。**

**判定の結果をメトリクスとして記録する。** どのモードが何 % かが分かれば、判定ロジックの妥当性を実データで確認でき、「古いモードのサポートをいつ落とせるか」も判断できる。

**バグのあるバージョン範囲は、理論値ではなく「実際に出荷された範囲」で決める。** そして間違えたときにどちらがマシかを考えて、範囲を広く取るか狭く取るかを選ぶ。

**設定ファイルを書き換えて効くかは、「誰がそのファイルを読むか」で決まる。** 読む経路が複数あるなら (libc の resolver、NSS モジュール、D-Bus)、ファイルを書き換えても一部にしか効かない。**設定の真の source of truth を特定する。**

**「以前のバージョンが残した設定」を掃除するコードを書く。** 更新やアンインストールの途中で失敗すると、古い設定が残る。固定 ID をハードコードしてでも、掃除できるようにしておく。

**ドキュメントにない制限は、見つけたら定数にしてコメントを添える。** 「どうやら NRPT のルールは 50 ドメインを超えられないらしい」— 出典が実験でも、書いておけば次の人が同じことを調べずに済む。
