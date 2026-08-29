---
title: "REST API と Docker 互換 API を 1 つのサーバから出す"
description: "podman system service は、Docker 互換の compat API と Podman 固有の libpod API を同じ mux に登録し、同じ socket で出す。パスは /v{version}/... と /v4.0.0/libpod/... で分かれ、バージョン無しのパスも Docker クライアントのために併記される。socket activation と idle tracker により、接続が来たら起動し、無通信が続けば終了する「常駐しないデーモン」になっている。"
group: "リモートとマルチプラットフォーム"
sidebar:
  order: 45
---

## 何を学んだか

### 1 つの socket に 2 つの API

`podman system service` が出す API は 2 系統ある。

| 系統       | パス                             | 用途                                                                          |
| ---------- | -------------------------------- | ----------------------------------------------------------------------------- |
| **compat** | `/v1.44/containers/json`         | Docker Engine API 互換。Docker CLI、docker-compose、Testcontainers などが使う |
| **libpod** | `/v4.0.0/libpod/containers/json` | Podman 固有。Pod、Quadlet、`kube play` などを含む                             |

同じ `mux.Router` に両方が登録され、同じ socket で待ち受ける。ハンドラも、多くの場合は同じ `ContainerEngine` のメソッドを呼ぶ。**違いはリクエスト/レスポンスの形だけ** で、compat 側は Docker の JSON スキーマに合わせて詰め替える。

これが `podman-remote` の通信路でもある。`podman --remote ps` は libpod 側のエンドポイントを叩く。**同じサーバが、Docker クライアントにも Podman クライアントにも応える**。

### バージョン無しのパスも登録する

Docker Engine API はパスにバージョンを含む (`/v1.44/containers/json`) が、**バージョン無しでも受け付ける**。古いクライアントや、手で叩く場合のためだ。

Podman はこれに合わせて、すべての compat ルートを 2 回登録している。1 回はバージョン付き、1 回はバージョン無し。

### 常駐しないデーモン

`podman system service` の既定タイムアウトは 5 秒だ。**5 秒間なにも来なければ終了する**。

これで困らないのは、systemd の **socket activation** があるからだ。`podman.socket` が socket を保持していて、接続が来たら `podman.service` を起動し、その socket を fd として渡す。サービスは仕事を終えたら終了し、次の接続でまた起動する。

「デーモンが要らない」という Podman の主張と、「Docker 互換 API を出す」という要求を両立させる仕掛けになっている。**サービスが動いていなくてもコンテナは動き続ける** ので、これは本当に API のためだけのプロセスだ。

## ソースコードのどこか

### ルートを 2 回登録する

[`pkg/api/server/register_containers.go#L43-L45`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/server/register_containers.go#L43)。

```go title="pkg/api/server/register_containers.go"
	r.HandleFunc(VersionedPath("/containers/create"), s.APIHandler(compat.CreateContainer)).Methods(http.MethodPost)
	// Added non version path to URI to support docker non versioned paths
	r.HandleFunc("/containers/create", s.APIHandler(compat.CreateContainer)).Methods(http.MethodPost)
```

`VersionedPath` の中身は正規表現 1 本だ。[`pkg/api/server/handler_api.go#L71`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/server/handler_api.go#L71)。

```go title="pkg/api/server/handler_api.go"
func VersionedPath(p string) string {
	return "/v{version:[0-9][0-9A-Za-z.-]*}" + p
}
```

**バージョンを検証せず、パス変数として受け取るだけ**。`/v1.24/` も `/v1.44/` も `/v99.99/` も同じハンドラに来る。バージョンによる挙動の差は、ハンドラの中で必要に応じて見る。

ルーティングでバージョンを分けなかったのは、**大半のエンドポイントでバージョン差が無い** からだ。差がある少数のハンドラだけが自分でバージョンを見る。全ルートを世代分作る設計に比べて、圧倒的に少ないコードで済む。

ファイルの大半は swagger のコメントで占められている。

```go title="pkg/api/server/register_containers.go"
	// swagger:operation GET /containers/json compat ContainerList
	// ---
	// tags:
	//  - containers (compat)
	// summary: List containers
```

**API ドキュメントがルート定義のすぐ横にある**。go-swagger がこれを読んで OpenAPI 仕様を生成する。ルートを足すときにドキュメントも書くことが構造的に強制される。

### 共通処理はハンドラのラッパーに

[`pkg/api/server/handler_api.go#L23-L58`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/server/handler_api.go#L23)。

```go title="pkg/api/server/handler_api.go"
func (s *APIServer) APIHandler(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Wrapper to hide some boilerplate
		s.apiWrapper(h, w, r, false)
	}
}

// An API Handler to help historical clients with broken parsing that expect
// streaming JSON payloads to be reliably messaged framed (full JSON record
// always fits in each read())
func (s *APIServer) StreamBufferedAPIHandler(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Wrapper to hide some boilerplate
		s.apiWrapper(h, w, r, true)
	}
}
```

2 つ目のコメントが互換レイヤの現実を語っている。「**パースが壊れている歴史的なクライアントを助けるための** API ハンドラ。ストリーミングの JSON ペイロードが、常に 1 回の `read()` に収まる形でメッセージフレーミングされることを期待している」。

HTTP のストリーミングでは、JSON レコードが複数の read に分かれて届くのが正常だ。だが古い Docker クライアントは 1 回の read で 1 レコードが来ることを前提にしている。**互換のために、レスポンスをバッファして境界を揃えて送る**。

`/containers/{name}/stats` と `/containers/{name}/top` だけがこのラッパーを使っている。仕様に無い期待に応えるためのコードが、必要な場所だけに限定されている。

共通処理の中身も見ておきたい。

```go title="pkg/api/server/handler_api.go"
	cv := version.APIVersion[version.Compat][version.CurrentAPI]
	w.Header().Set("API-Version", fmt.Sprintf("%d.%d", cv.Major, cv.Minor))

	lv := version.APIVersion[version.Libpod][version.CurrentAPI].String()
	w.Header().Set("Libpod-API-Version", lv)
	w.Header().Set("Server", "Libpod/"+lv+" ("+runtime.GOOS+")")
```

`API-Version` (Docker 互換) と `Libpod-API-Version` (Podman 固有) の **両方を全レスポンスに付ける**。クライアントは自分が理解する方を見ればよい。互換ヘッダと固有ヘッダを併記するのは、互換レイヤの定石といえる。

### idle tracker が「無通信で終了」を実現する

[`pkg/api/server/idle/tracker.go#L15-L33`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/api/server/idle/tracker.go#L15)。

```go title="pkg/api/server/idle/tracker.go"
// Tracker holds the state for the server's idle tracking
type Tracker struct {
	// Duration is the API idle window
	Duration time.Duration
	hijacked int                   // count of active connections managed by handlers
	managed  map[net.Conn]struct{} // set of active connections managed by http package
	mux      sync.Mutex            // protect managed map
	timer    *time.Timer
	total    int // total number of connections made to this server instance
}

// NewTracker creates and initializes a new Tracker object
// For best behavior, duration should be 2x http idle connection timeout
func NewTracker(idle time.Duration) *Tracker {
```

接続を 2 種類に分けて数えているのが要点だ。

- **`managed`** — `net/http` パッケージが管理している通常の接続
- **`hijacked`** — ハンドラが hijack した接続 (attach、exec、logs -f)

`http.Server` の `ConnState` コールバックは、hijack された接続について `StateClose` を **呼んでくれない**。コメントに明記されている。

```go title="pkg/api/server/idle/tracker.go"
// ConnState is called on HTTP connection state changes.
//   - Once StateHijacked, StateClose is _NOT_ called on that connection
//   - There are two "idle" timeouts, the http idle connection (not to be confused with the TCP/IP idle socket timeout)
//     and the API idle window.  The caller should set the http idle timeout to 2x the time provided to NewTacker() which
//     is the API idle window.
```

```go title="pkg/api/server/idle/tracker.go"
	case http.StateHijacked:
		// hijacked connections should call Close() when finished.
		// Note: If a handler hijack's a connection and then doesn't Close() it,
		//       the API timer will not fire and the server will _NOT_ timeout.
		delete(t.managed, conn)
```

**hijack したハンドラが `Close()` を呼ばないと、サーバは永遠にタイムアウトしない**。この契約がコメントで明示されている。`podman attach` の最中にサーバが終了しては困るので、hijack 中はアイドルとみなさない。その代償として、閉じ忘れがリークになる。

2 つのタイムアウトの関係も重要だ。`IdleTimeout: opts.Timeout * 2` と設定されていて、**HTTP のアイドル接続タイムアウトを API のアイドル窓の 2 倍にする**。逆にすると、HTTP 層が接続を切る前に API 層がサーバを止めてしまう。

### socket activation の判定

[`pkg/systemd/activation.go#L9`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/activation.go#L9)。

```go title="pkg/systemd/activation.go"
// SocketActivated determine if podman is running under the socket activation protocol
// Criteria is based on the expectations of "github.com/coreos/go-systemd/v22/activation"
func SocketActivated() bool {
	pid, found := os.LookupEnv("LISTEN_PID")
	if !found {
		return false
	}
	p, err := strconv.Atoi(pid)
	if err != nil || p != os.Getpid() {
		return false
	}

	fds, found := os.LookupEnv("LISTEN_FDS")
	if !found {
		return false
	}
	nfds, err := strconv.Atoi(fds)
	if err != nil || nfds == 0 {
		return false
	}
	return true
}
```

**`LISTEN_PID` が自分の PID と一致するかを確認している**。この検査は重要で、環境変数は子プロセスに継承されるため、確認しないと「親が socket activation されただけで、自分は違う」場合に誤判定する。

systemd の仕様がこの検査を要求しているのだが、忘れられやすい。20 行の関数の半分がこの種の検証に使われている。

### gRPC も同じサーバに同居する

```go title="pkg/api/server/server.go"
	router.NewRoute().HeadersRegexp("Content-Type", "application/grpc(\\+.*)?").Handler(server.grpc)
	reflection.Register(server.grpc)
```

`Content-Type` が `application/grpc` なら gRPC サーバに回す。**HTTP/1.1 の REST と HTTP/2 の gRPC が、同じリスナで多重化されている**。

```go title="pkg/api/server/server.go"
	serverProtocols := &http.Protocols{}
	serverProtocols.SetHTTP1(true)
	serverProtocols.SetHTTP2(true)
```

両方のプロトコルを有効にすることで成立している。パス単位ではなくヘッダ単位でのルーティングなので、既存の REST ルートと衝突しない。

### 全ハンドラを panic から守る

```go title="pkg/api/server/server.go"
	// Capture panics and print stack traces for diagnostics,
	// additionally process X-Reference-Id Header to support event correlation
	router.Use(panicHandler(), referenceIDHandler())
```

**panic を握って 500 を返す** ミドルウェア。API サーバのハンドラが panic してプロセスごと落ちると、hijack 中の attach セッションも全部切れる。

`X-Reference-Id` は、リクエストとログを対応付けるための ID だ。前に見た idle tracker のログにも `X-Reference-Id` が入っていて、**接続のポインタ値を ID として使っている**。

```go title="pkg/api/server/idle/tracker.go"
	logrus.WithFields(logrus.Fields{
		"X-Reference-Id": fmt.Sprintf("%p", conn),
	}).Debugf("IdleTracker:%v %dm+%dh/%dt connection(s)", state, len(t.managed), t.hijacked, t.TotalConnections())
```

## なぜそうなっているか

### 2 つの API を分けたのは、互換に引きずられないため

Docker 互換 API だけを出す選択もあった。だが Pod も Quadlet も `kube play` も Docker には無いので、表現できない。

かといって Docker 互換 API を拡張すると、**Docker クライアントが理解できないフィールドが混ざる**。互換の意味がなくなる。

そこでパスで分けた。`/libpod/` 以下は Podman の世界で、自由に設計できる。compat 側は Docker のスキーマに厳密に従う。**同じ実装を、2 つの語彙で公開している**。

### 常駐しない API サーバという発想

socket activation + idle timeout の組み合わせは、systemd が提供する機能をそのまま使ったものだ。Podman 自身は「fd を受け取って listen する」「無通信を数えて終了する」だけを実装している。

これによって、「Docker 互換 API が要る場面 (Compose、Testcontainers) では動き、要らない場面では 1 プロセスも常駐しない」が実現する。**デーモンレスの原則を崩さずに、デーモンを必要とするツールに対応した**。

### バージョンを検証しないのは、検証しても仕方ないから

`/v99.99/containers/json` を受け付けてしまうのは緩いが、拒否したところでクライアントは動かない。**バージョン差が実際に問題になるハンドラだけが自分で見る** 方が、コードも少なく、対応範囲も広くなる。

`version/version.go` で `MinimalAPI: 1.24` と宣言しているのは、`/version` エンドポイントでクライアントにネゴシエートさせるためのもので、ルーティングの制約ではない。

## どう活かすか

- **互換 API と固有 API はパスで分ける。** 1 つの API に両方を詰めると、互換性が壊れるか、固有機能が入れられなくなる。名前空間を分ければ、それぞれの制約の中で設計できる。
- **レスポンスヘッダに互換版と固有版の両方を出す。** クライアントは自分が理解する方を見る。片方だけだと、どちらかのクライアントが困る。
- **`LISTEN_PID` は自分の PID と照合する。** socket activation の判定でこれを省くと、子プロセスで誤動作する。環境変数による機能検出は、継承されることを常に疑う。
- **hijack した接続はライフサイクルが別になる。** `net/http` の `ConnState` は hijack 後を追跡しない。数えるなら自分で数え、閉じる責務を明示的に決める。
- **2 つのタイムアウトがあるなら、大小関係を設計する。** HTTP のアイドルタイムアウトと API のアイドル窓のように、層ごとにタイムアウトがある場合、どちらが先に発火すべきかを決めて数値で担保する。
