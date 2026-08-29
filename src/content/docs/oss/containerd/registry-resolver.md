---
title: "レジストリの解決を hosts.toml で差し替える"
description: "「docker.io のイメージを社内ミラーから取り、タグの解決だけ本家に聞く」を、設定ファイルのディレクトリ構造で表現する。ホスト名のディレクトリに hosts.toml を置き、host ごとに capabilities を書く。デーモンの再起動は不要で、ファイルは pull のたびに読み直される。"
group: "イメージを取り込む"
sidebar:
  order: 27
---

## 何を学んだか

### ディレクトリ構造が設定

レジストリの設定は、`config.toml` の中ではなく **別のディレクトリツリー** に置く。

```
/etc/containerd/certs.d/
├── docker.io/
│   └── hosts.toml
├── myregistry.io_5000_/
│   ├── hosts.toml
│   └── ca.crt
└── _default/
    └── hosts.toml
```

ディレクトリ名がレジストリのホスト名 (**registry host namespace**)、`_default` がフォールバックだ。CRI 側では `config_path` でこのディレクトリを指定する。

```markdown title="docs/hosts.md"
> **Note**: Updates under this directory do not require restarting the containerd daemon.
```

**デーモンの再起動が要らない**。pull のたびにファイルが読まれる。

### hosts.toml の中身

```toml
server = "https://registry-1.docker.io"    # 最後に使う上流

[host."https://public-mirror.example.com"]
  capabilities = ["pull"]                  # 信頼度が低い。タグ解決はさせない
[host."https://docker-mirror.internal"]
  capabilities = ["pull", "resolve"]
  ca = "docker-mirror.crt"
```

`[host.*]` に書いた順に試され、全部失敗したら `server` が使われる。`server` を書かなければ上流には行かない。

`capabilities` が肝で、`pull` (digest 指定の取得) と `resolve` (タグからの解決) を分けられる ([レジストリからイメージを取る手順を分解する](../registry-protocol/))。ミラーには `pull` だけ許し、「このタグが指す digest は何か」は本家に聞く、という構成が書ける。

コメントにある通り、これは **信頼の分割** だ。digest 指定の取得は内容を検証できるのでミラーを信じなくてよいが、タグ解決は「その名前が何を指すか」を信じることになる。

### ミラーには元のレジストリ名が渡る

ミラーへのリクエストには `ns` クエリパラメータが付く。

```
https://mymirror.io/v2/image_name/manifests/tag_name?ns=myregistry.io:5000
```

ミラー側は「どのレジストリの代理として呼ばれたか」を知れる。1 つのミラーが複数の上流をプロキシできる。

## ソースコードのどこか

### 設定がなければ既定を組み立てる

[`core/remotes/docker/config/hosts.go#L78-L137`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/config/hosts.go#L78-L137)。

```go title="core/remotes/docker/config/hosts.go"
		// If hosts was not set, add a default host
		// NOTE: Check nil here and not empty, the host may be
		// intentionally configured to not have any endpoints
		if hosts == nil {
			hosts = make([]hostConfig, 1)
		}
```

`nil` と空スライスを区別している。**「設定ファイルがない」と「設定ファイルでホストを 0 個にした」は別** だという判断で、後者では既定のホストを足さない。

Docker Hub の特別扱いもここにある。

```go title="core/remotes/docker/config/hosts.go"
			if host == "docker.io" {
				hosts[len(hosts)-1].scheme = "https"
				hosts[len(hosts)-1].host = "registry-1.docker.io"
			} else if docker.IsLocalhost(host) {
```

`docker.io` という名前と `registry-1.docker.io` という実際のエンドポイントの対応が、コードにハードコードされている。歴史的経緯によるもので、仕様には根拠がない。

localhost の扱いも細かい。

```go title="core/remotes/docker/config/hosts.go"
				if options.DefaultScheme == "" {
					_, port, _ := net.SplitHostPort(host)
					if port == "" || port == "443" {
						// If port is default or 443, only use https
						hosts[len(hosts)-1].scheme = "https"
					} else {
						// HTTP fallback logic will be used when protocol is ambiguous
						hosts[len(hosts)-1].scheme = "http"
					}

					// When port is 80, protocol is not ambiguous
					if port != "80" {
						// Skipping TLS verification for localhost
						var skipVerify = true
						hosts[len(hosts)-1].skipVerify = &skipVerify
					}
```

ポート番号から意図を推測する。443 なら HTTPS 確定、80 なら HTTP 確定、それ以外は曖昧なので HTTP を試しつつ TLS 検証を緩める。**ローカルの開発用レジストリを動かすときの摩擦を減らす** ための特例で、localhost に限定されている。

### capabilities のパース

[`core/remotes/docker/config/hosts.go#L450-L470`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/config/hosts.go#L450-L470)。

```go title="core/remotes/docker/config/hosts.go"
				result.capabilities |= docker.HostCapabilityPull
			...
				result.capabilities |= docker.HostCapabilityResolve
			...
				result.capabilities |= docker.HostCapabilityPush
			...
				result.capabilities |= docker.HostCapabilityReferrers
	...
		result.capabilities = docker.HostCapabilityPull | docker.HostCapabilityResolve | docker.HostCapabilityPush | docker.HostCapabilityReferrers
```

`capabilities` を書かなければ全部有効。**明示的に制限したときだけ絞られる** という既定値の取り方になっている。

### ミラーへの ns パラメータ

[`core/remotes/docker/resolver.go#L647-L652`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/resolver.go#L647-L652)。

```go title="core/remotes/docker/resolver.go"
func (r *request) addNamespace(ns string) error {
	if !r.host.isProxy(ns) {
		return nil
	}
	return r.addQuery(namespaceQueryArg, ns)
}
```

「そのホストが ns のプロキシである」= ホスト名が元のレジストリと違う場合にだけ、クエリを足す。上流に直接繋ぐときには余計なパラメータを付けない。

### Docker の証明書配置にもフォールバックする

```markdown title="docs/hosts.md"
If no hosts.toml configuration exists in the host directory, it will fallback to check
certificate files based on Docker's certificate file pattern
(".crt" files for CA certificates and ".cert"/".key" files for client certificates).
```

`hosts.toml` がなくても、Docker と同じ命名規則で置かれた証明書があれば拾う。Docker からの移行時に、証明書の配置をやり直さなくてよい。

### ポートを含むホスト名の探索順

```markdown title="docs/hosts.md"
- on Unix:

myregistry.io_5000_
myregistry.io:5000
_default
```

`:` を含むディレクトリ名は Windows で作れないので、`_5000_` 形式を先に探す。**プラットフォーム差を、探索順の追加で吸収している**。既存の設定 (`:` 付き) も動き続ける。

## なぜそうなっているか

### 設定を別ファイルに出す理由

レジストリの設定を `config.toml` に書くと、変更のたびに containerd の再起動が要る。ノード上で動いている全 Pod に影響する再起動を、ミラーの追加のために行うのは割に合わない。

別ディレクトリにして pull のたびに読むことで、

- **無停止で設定を変えられる**
- 設定管理ツール (Ansible、DaemonSet) がファイルを置くだけでよい
- レジストリごとにファイルが分かれるので、差分管理しやすい

### capability の分離が信頼の分離になる

ミラーを使うときに最も危険なのは、タグの解決を任せることだ。`nginx:latest` が指す digest を差し替えられれば、任意のイメージを実行させられる。

digest 指定の取得なら、返ってきたバイト列のハッシュを検証するので、ミラーが嘘をついても検出できる。だから **「pull は許すが resolve は許さない」** という設定に意味がある。

この分離は、capability をビットで持つ設計 ([レジストリからイメージを取る手順を分解する](../registry-protocol/)) があって初めて表現できる。

### CRI の旧設定を非推奨にした

```markdown title="docs/hosts.md"
_The old CRI config pattern for specifying registry.mirrors and registry.configs has
been **DEPRECATED**._
```

以前は CRI プラグインの設定にミラーを書いていた。それを `hosts.toml` に統一したことで、`ctr` と CRI で同じ設定が効くようになった。**クライアントごとに設定方法が違う** 状態を解消している。

## どう活かすか

### 社内ミラーを安全に設定する

```toml
# /etc/containerd/certs.d/docker.io/hosts.toml
server = "https://registry-1.docker.io"

[host."https://mirror.corp.internal"]
  capabilities = ["pull"]     # resolve は付けない
  ca = "corp-ca.crt"
```

これで、layer の取得はミラーから、タグの解決は Docker Hub から行われる。ミラーが落ちても、上流にフォールバックして pull は成功する。

すべてをミラー経由にしたい (外部に一切出ない) 場合は、`server` を書かずにミラーだけを列挙する。

### 設定が効いているか確かめる

```sh
# hosts-dir を明示して pull し、デバッグログを見る
$ ctr images pull --hosts-dir /etc/containerd/certs.d \
    --http-trace docker.io/library/alpine:latest
```

`--http-trace` で実際に叩いた URL が見える。ミラーに `?ns=` が付いているか、フォールバックが起きているかを確認できる。

CRI 経由の場合は `config_path` の設定を確認する。

```sh
$ containerd config dump | grep -A3 "registry"
```

### 「設定をディレクトリツリーにする」判断

設定をディレクトリで表現する方式が向くのは、次の条件が揃うときだ。

- **項目数が動的に増える** — レジストリ、ホスト、テナントなど
- **更新頻度が本体の設定と違う** — 頻繁に変わるものを分離する
- **無停止で反映したい** — 起動時に読み込む設定とは寿命が違う
- **項目ごとに付随ファイルがある** — 証明書、鍵など

逆に、項目が固定でファイル数が少ないなら、単一の設定ファイルのほうが見通しがよい。containerd も、プラグインの設定は `config.toml` に集約したままにしている。
