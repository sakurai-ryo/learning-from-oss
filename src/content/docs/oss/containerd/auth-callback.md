---
title: "認証を「サーバからクライアントへのコールバック」にする"
description: "レジストリの資格情報を containerd に預ける代わりに、必要になった時点でクライアントに聞きに行く。pull の途中で 401 が返ってきたら、ストリーム越しに「このホストの認証情報をくれ」と送る。デーモンは資格情報を保持せず、有効期間もクライアントが決める。"
group: "イメージを取り込む"
sidebar:
  order: 28
---

## 何を学んだか

### デーモンが資格情報を持たない

プライベートレジストリから pull するには資格情報が要る。素直な設計は「デーモンの設定ファイルに書く」だが、それだと

- ノード上の全利用者が同じ資格情報を使うことになる
- Kubernetes の imagePullSecrets のように **Pod ごとに違う** 情報を扱えない
- デーモンのディスクに秘密が残る

transfer service は逆にした。**pull を依頼したクライアントに、必要になったら聞く**。

```go
type CredentialHelper interface {
	GetCredentials(ctx context.Context, ref, host string) (Credentials, error)
}
```

デーモンから見れば、これは同期的なコールバックだ。レジストリが 401 を返した瞬間に呼ばれ、返ってくるまでブロックする。

### コールバックはストリームの上を往復する

gRPC の unary RPC の途中で、サーバからクライアントを呼ぶ方法はない。だから [streaming service](../streaming-service/) の名前付きストリームを使う。

1. クライアントが `creds` 用のストリームを作り、ID を transfer request に載せる
2. サーバは 401 を受けると、そのストリームに `AuthRequest{host, reference}` を送る
3. クライアントは資格情報を調べ、`AuthResponse` を返す
4. サーバはそれでトークンを取り、リクエストを再送する

### 資格情報の形は 3 種類

`AuthType` で区別される。

| 種類          | 内容                                                   |
| ------------- | ------------------------------------------------------ |
| `CREDENTIALS` | username + password。トークンサーバで token に交換する |
| `REFRESH`     | refresh token。OAuth のフローで token を得る           |
| `HEADER`      | `Authorization` ヘッダの値そのもの                     |

`HEADER` があることで、**containerd が知らない認証方式** にも対応できる。クライアントが自分で計算したヘッダをそのまま渡せる (クラウドプロバイダの署名付き認証など)。

### トークンはスコープごとにキャッシュ

一度取得したトークンは、レジストリごと・スコープごとにキャッシュされる。リポジトリが変わればスコープが変わるので、その都度取り直す。

## ソースコードのどこか

### クライアント側 — 問い合わせを待つループ

[`core/transfer/registry/registry.go#L245-L300`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/transfer/registry/registry.go#L245-L300)。

```go title="core/transfer/registry/registry.go"
	if r.creds != nil {
		sid := tstreaming.GenerateID("creds")
		stream, err := sm.Create(ctx, sid)
		if err != nil {
			return nil, err
		}
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				default:
				}

				req, err := stream.Recv()
				...
				var s transfertypes.AuthRequest
				if err := typeurl.UnmarshalTo(req, &s); err != nil {
					log.G(ctx).WithError(err).Error("failed to unmarshal credential request")
					continue
				}
				creds, err := r.creds.GetCredentials(ctx, s.Reference, s.Host)
```

資格情報のヘルパが設定されている場合のみ、ストリームを作って goroutine を回す。設定されていなければストリーム自体が存在せず、**匿名でしか pull しない** ことが構造的に保証される。

応答の組み立てで種類が決まる。

```go title="core/transfer/registry/registry.go"
				var resp transfertypes.AuthResponse
				if creds.Header != "" {
					resp.AuthType = transfertypes.AuthType_HEADER
					resp.Secret = creds.Header
				} else if creds.Username != "" {
					resp.AuthType = transfertypes.AuthType_CREDENTIALS
					resp.Username = creds.Username
					resp.Secret = creds.Secret
				} else {
					resp.AuthType = transfertypes.AuthType_REFRESH
					resp.Secret = creds.Secret
				}
```

`Credentials` 構造体のどのフィールドが埋まっているかで型を判定する。フィールドと種類を別々に持たないので、矛盾した組み合わせを送れない。

### サーバ側 — ストリーム越しに聞く

[`core/transfer/registry/registry.go#L434-L470`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/transfer/registry/registry.go#L434-L470)。

```go title="core/transfer/registry/registry.go"
type credCallback struct {
	sync.Mutex
	stream streaming.Stream
}

func (cc *credCallback) GetCredentials(ctx context.Context, ref, host string) (Credentials, error) {
	cc.Lock()
	defer cc.Unlock()

	ar := &transfertypes.AuthRequest{
		Host:      host,
		Reference: ref,
	}
	anyType, err := typeurl.MarshalAny(ar)
	...
	if err := cc.stream.Send(anyType); err != nil {
		return Credentials{}, err
	}
	resp, err := cc.stream.Recv()
```

`Mutex` で送受信を直列化している。ストリームには順序しかなく、リクエスト ID による対応付けがないので、**同時に 2 つ聞くと応答が入れ替わる**。ロックで防ぐのが最も簡単な解になる。

複数の layer を並列にダウンロードしていても、資格情報の問い合わせだけは 1 つずつ。トークンがキャッシュされるので、実際に問い合わせが走るのは最初の 1 回だけだ。

### 認証チャレンジの処理

[`core/remotes/docker/authorizer.go#L153-L200`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/authorizer.go#L153-L200)。

```go title="core/remotes/docker/authorizer.go"
func (a *dockerAuthorizer) AddResponses(ctx context.Context, responses []*http.Response) error {
	last := responses[len(responses)-1]
	host := last.Request.URL.Host
	...
	for _, c := range auth.ParseAuthHeader(last.Header) {
		if c.Scheme == auth.BearerAuth {
			if retry, err := invalidAuthorization(ctx, c, responses); err != nil {
				delete(a.handlers, host)
				return err
			} else if retry {
				delete(a.handlers, host)
			}

			// reuse existing handler
			//
			// assume that one registry will return the common
			// challenge information, including realm and service.
			// and the resource scope is only different part
			// which can be provided by each request.
			if _, ok := a.handlers[host]; ok {
				return nil
			}
```

`AddResponses` は **これまでのレスポンスの履歴** を受け取る。同じ資格情報で 2 回失敗したら諦める、という判定 (`invalidAuthorization`) のために履歴が要る。

コメントの仮定が重要だ。「1 つのレジストリは共通のチャレンジ情報 (realm, service) を返し、違うのはスコープだけ」。この仮定のもとで、ホストごとに 1 つのハンドラを使い回している。

### スコープごとのトークンキャッシュ

[`core/remotes/docker/authorizer.go#L225-L250`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/remotes/docker/authorizer.go#L225-L250)。

```go title="core/remotes/docker/authorizer.go"
type authHandler struct {
	sync.Mutex

	header http.Header

	client *http.Client

	// only support basic and bearer schemes
	scheme auth.AuthenticationScheme

	// common contains common challenge answer
	common auth.TokenOptions

	// scopedTokens caches token indexed by scopes, which used in
	// bearer auth case
	scopedTokens map[string]*authResult
}
```

`scopedTokens` のキーはスコープ文字列 (`repository:library/nginx:pull`)。**同じリポジトリへの後続リクエストではトークンを取り直さない**。

「basic と bearer だけ対応」とコメントで明記されている。他の方式は `HEADER` 型の資格情報でクライアント側に任せる。

### リフレッシュトークンの通知

```go title="core/remotes/docker/authorizer.go"
	if refreshToken != "" {
		a.mu.RLock()
		onFetchRefreshToken := a.onFetchRefreshToken
		a.mu.RUnlock()
		if onFetchRefreshToken != nil {
			onFetchRefreshToken(ctx, refreshToken, req)
		}
	}
```

トークンサーバがリフレッシュトークンを返したら、コールバックで通知する。クライアント側で保存して次回に使える。**認証の状態をデーモンに残さない** という方針が、ここでも一貫している。

## なぜそうなっているか

### Kubernetes の imagePullSecrets に対応するため

kubelet は Pod ごとに違う資格情報を持ちうる。同じノードで、あるチームのイメージは A のクレデンシャル、別のチームは B、という状況が普通にある。

デーモンが資格情報を保持する設計では、これを表現できない。**呼び出しごとに資格情報が変わる** ことを前提にすると、コールバック型になる。

CRI プラグインは `PullImage` リクエストに載ってきた認証情報を、この経路でレジストリに渡している。

### 秘密をデーモンに置かない

資格情報がデーモンのメモリやディスクに残ると、

- デーモンのメモリダンプから漏れる
- 設定ファイルの権限管理が必要になる
- 失効させたい資格情報がいつまで使われるか分からない

コールバックなら、**必要な瞬間にだけメモリに載る**。呼び出しが終われば消える (トークンはキャッシュされるが、これは有効期限付きの派生物だ)。

### 失敗してから聞く

先に資格情報を要求せず、401 が返ってから聞く。これによって、

- **公開イメージなら一切問い合わせが発生しない** — クライアント側で認証情報を探すコスト (キーチェーンへのアクセスなど) がかからない
- レジストリが認証を要求するかどうかを事前に知らなくてよい

代償は往復が増えることだが、トークンのキャッシュで実質 1 回に収まる。

## どう活かすか

### 認証エラーの切り分け

```
pull access denied, repository does not exist or may require authorization
```

このメッセージは 401 でも 404 でも出る (レジストリが存在の有無を隠すため、認証なしのアクセスに 401 を返すことがある)。切り分けには、資格情報が渡っているかを確認する。

```sh
# ctr で明示的に指定して試す
$ ctr images pull -u user:password myregistry.io/private/image:tag

# CRI 経由なら kubelet のログで imagePullSecrets の解決を確認
$ kubectl describe pod <pod> | grep -A5 Events
```

`ctr` で通って CRI で通らないなら、Secret の設定か、Pod との紐付けの問題になる。

### 「必要になったら聞く」コールバック設計

秘密情報を扱うサービスで、この形は応用が利く。要点は 4 つ。

- **サーバは秘密を保持せず、要求時に呼び出し元へ問い合わせる**
- **問い合わせの単位を絞る** — 「この host のこの reference のための情報」と具体的に聞く
- **応答の形を複数用意する** — 生の資格情報、トークン、ヘッダ丸ごと。サーバが知らない方式を通せる余地を残す
- **問い合わせを直列化する** — 順序しかない経路で往復するなら、ロックか ID による対応付けが要る

3 番目が特に効く。`HEADER` 型のような「中身を解釈しない」逃げ道を用意しておくと、認証方式が増えてもサーバ側の変更が要らない。
