---
title: "レジストリからイメージを取る手順を分解する"
description: "OCI Distribution は HTTP の GET が数種類あるだけの素朴なプロトコルだ。タグから manifest を引き、digest で blob を取る。認証はチャレンジに応じてトークンを取り直す 2 往復。containerd 側では、この手順が resolver・fetcher・pusher という 3 つのインターフェースに分解され、ホストごとの能力をビットで持つ。"
group: "コンテナランタイムの前提"
sidebar:
  order: 6
---

## 何を学んだか

### プロトコルは 5 種類のエンドポイントしかない

OCI Distribution Spec (旧 Docker Registry HTTP API v2) が定めるのは、実質次のものだけだ。

| メソッドとパス                                     | 用途                                   |
| -------------------------------------------------- | -------------------------------------- |
| `GET /v2/`                                         | 疎通確認と認証チャレンジの取得         |
| `HEAD` / `GET /v2/<name>/manifests/<reference>`    | タグまたは digest から manifest を取る |
| `GET /v2/<name>/blobs/<digest>`                    | blob (config や layer) を取る          |
| `POST` / `PATCH` / `PUT /v2/<name>/blobs/uploads/` | blob をアップロードする                |
| `GET /v2/<name>/tags/list`, `/referrers/<digest>`  | 一覧と参照元の取得                     |

pull の流れはこうなる。

1. `HEAD /v2/library/nginx/manifests/latest` — タグを解決し、`Docker-Content-Digest` と `Content-Type` を得る
2. `GET .../manifests/sha256:...` — index を取る。プラットフォームを選んでもう 1 段辿る
3. `GET .../blobs/sha256:...` — config と layer を並列に取る

**タグの解決だけが可変で、それ以降はすべて digest 指定** になる。だからキャッシュも並列化も安全にできる。

### 認証は「断られてから取りに行く」

レジストリは最初のリクエストに `401` と `WWW-Authenticate` ヘッダを返す。

```
WWW-Authenticate: Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"
```

クライアントはこの `realm` にアクセスしてトークンを取り、`Authorization: Bearer <token>` を付けて再送する。scope は **リポジトリ単位** なので、pull するリポジトリが変わるたびにトークンを取り直すことになる。

この「失敗してから認証情報を取りに行く」形は、containerd の設計に影響している。デーモンは認証情報を持たず、必要になった時点で **クライアントに問い合わせる** ([認証をコールバックにする](../auth-callback/))。

### レジストリごとに「できること」が違う

ミラーレジストリは pull しかできない。タグ解決を許さないミラーもある。プライベートレジストリは push もできる。containerd はこれを **ホストごとの capability ビット** として持ち、操作に応じて使えるホストだけを選ぶ。

## ソースコードのどこか

### capability の定義

[`core/remotes/docker/registry.go#L46-L65`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/registry.go#L46-L65)。

```go title="core/remotes/docker/registry.go"
	// HostCapabilityPull represents the capability to fetch manifests
	// and blobs by digest
	HostCapabilityPull HostCapabilities = 1 << iota

	// HostCapabilityResolve represents the capability to fetch manifests
	// by name
	HostCapabilityResolve

	// HostCapabilityPush represents the capability to push blobs and
	// manifests
	HostCapabilityPush

	// HostCapabilityReferrers represents the capability to generate a
	// list of referrers using the OCI Distribution referrers endpoint.
	HostCapabilityReferrers
```

`Pull` (digest 指定の取得) と `Resolve` (名前からの解決) が **別のビット** になっているのが肝だ。「blob は近くのミラーから取るが、タグの解決は本家に聞く」という構成が、この分離で表現できる。

`RegistryHost` は、その 1 台をどう叩くかを全部持つ ([`#L75-L96`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/registry.go#L75-L96))。

```go title="core/remotes/docker/registry.go"
type RegistryHost struct {
	Client       *http.Client
	Authorizer   Authorizer
	Host         string
	Scheme       string
	Path         string
	Capabilities HostCapabilities
	...
}

type RegistryHosts func(string) ([]RegistryHost, error)
```

HTTP クライアントも認証器もホストごとに違ってよい。「このミラーだけ TLS 検証を切る」「このレジストリだけ別の認証を使う」が自然に表現できる。

### 解決は「ホストを順に試す」ループ

[`core/remotes/docker/resolver.go#L245-L280`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/resolver.go#L245-L280)。

```go title="core/remotes/docker/resolver.go"
	if dgst != "" {
		...
		// turns out, we have a valid digest, make a url.
		paths = append(paths, []string{"manifests", dgst.String()})

		// fallback to blobs on not found.
		paths = append(paths, []string{"blobs", dgst.String()})
	} else {
		// Add
		paths = append(paths, []string{"manifests", refspec.Object})
		caps |= HostCapabilityResolve
	}

	hosts := base.filterHosts(caps)
```

digest 指定なら `Pull` 能力があるホストで足りる。タグ指定なら `Resolve` 能力も要求する。`filterHosts` がそれを絞る。

フォールバックの制御が細かい ([`#L305-L312`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/resolver.go#L305-L312))。

```go title="core/remotes/docker/resolver.go"
	for _, u := range paths {
		// falling back to /blobs endpoint should happen in extreme cases - those to
		// support legacy registries. we want to limit the fallback to when /manifests endpoint
		// returned 404. Falling back on transient errors could do more harm, like polluting
		// the local content store with incorrectly typed descriptors as /blobs endpoint tends
		// always return with application/octet-stream.
		if firstErrPriority > 2 {
			break
		}
```

`/manifests` が 404 のときだけ `/blobs` に落ちる。一時的なエラーで落ちてしまうと、**mediaType が `application/octet-stream` の descriptor が content store に混入する** — つまり後で「この blob は何なのか」が分からなくなる。異常系のフォールバックが、後段のデータ品質を壊しうるという指摘だ。

エラーの選び方にも優先度がある。

```go title="core/remotes/docker/resolver.go"
	var (
		// firstErr is the most relevant error encountered during resolution.
		// We use this to determine the error to return, making sure that the
		// error created furthest through the resolution process is returned.
		firstErr         error
		firstErrPriority int
	)
```

複数ホストを試して全部失敗したとき、**最も奥まで進んだエラー** を返す。「DNS が引けない」より「401 で認証が必要」のほうが利用者に有益だからだ。

### 3 つのインターフェースへの分解

[`core/remotes/resolver.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/resolver.go) で、レジストリとのやり取りは 3 つに分けられている。

- `Resolver` — 参照名 (`nginx:latest`) から descriptor を得る。`Fetcher` / `Pusher` を作る
- `Fetcher` — descriptor を渡すと `io.ReadCloser` を返す
- `Pusher` — descriptor を渡すと書き込み先を返す

この分解のおかげで、「レジストリから取る」以外の実装を同じ形で書ける。ローカルの OCI レイアウトから読む、別の containerd から取る、といった実装が Fetcher として差し替え可能になる。

## なぜそうなっているか

### digest 中心にすると、経路を自由にできる

タグ解決以外がすべて digest 指定であることの効用は大きい。

- **ミラーが安全** — 中身のハッシュが分かっているので、どこから取っても検証できる。信頼できないミラーでもよい
- **再開が容易** — Range リクエストで途中から取っても、最後にハッシュを検証すればよい
- **並列化が自明** — 各 blob は独立に取れる

コンテナイメージの配布が CDN と相性がよいのは、この性質のおかげだ。

### 認証を後追いにするのは、レジストリの構成が事前に分からないから

「どのレジストリがどんな認証を要求するか」を事前に知る方法がない。チャレンジ・レスポンス方式にしておけば、クライアントは何も知らずに始められる。トークンの有効期限やスコープの粒度もサーバ側の裁量で決められる。

代償は往復回数が増えることで、containerd はトークンをキャッシュして同じ scope の再取得を避けている。

### capability をビットで持つと構成の表現力が上がる

「pull 専用ミラー」「解決だけ本家」という構成は、ホストのリストと capability の組み合わせだけで表せる。もし `mirrors` と `registries` を別の設定項目にしていたら、組み合わせのたびに設定スキーマを増やす必要があった。

この設定を外に出したのが `hosts.toml` で、詳しくは [レジストリの解決を hosts.toml で差し替える](../registry-resolver/) で読む。

## どう活かすか

### pull できないときに見る順番

エラーメッセージからどの段階で失敗したかを切り分けられる。

| メッセージ                                         | 失敗した段階                                        |
| -------------------------------------------------- | --------------------------------------------------- |
| `failed to resolve reference`                      | タグ解決。DNS、疎通、タグの不存在                   |
| `pull access denied ... may require authorization` | 401。認証情報が届いていない、または scope 不足      |
| `unexpected status: 429`                           | レート制限。Docker Hub の匿名 pull 制限が典型       |
| `failed to copy: expected digest ... got ...`      | blob の内容が壊れている。ミラーや中間プロキシを疑う |

最後のパターンは、透過プロキシが gzip を再圧縮するなどして起きることがある。digest 検証があるおかげで **壊れたものが content store に入る前に止まる**。

### 手で叩いて確認する

プロトコルが単純なので、curl で再現できる。

```sh
# 認証チャレンジを見る
$ curl -sI https://registry-1.docker.io/v2/library/nginx/manifests/latest | grep -i www-authenticate

# トークンを取る
$ TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull" | jq -r .token)

# manifest を取る (Accept ヘッダで欲しい形式を指定する)
$ curl -s -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    https://registry-1.docker.io/v2/library/nginx/manifests/latest | jq
```

containerd 側の挙動を疑ったとき、同じリクエストを手で投げて切り分けられることの価値は大きい。プロトコルを単純に保つことは、そのまま運用性になる。
