---
title: "1 つの shim が Pod のコンテナをまとめる"
description: "shim をコンテナごとに立てるか、まとめるかは shim 自身が決める。containerd は知らない。runc.v2 の shim は config.json のアノテーションから grouping key を取り出し、それをソケットアドレスの計算に使う。同じ Pod のコンテナは同じアドレスになり、2 つ目以降は既存の shim に接続する。"
group: "shim の中身"
sidebar:
  order: 48
---

## 何を学んだか

### containerd は 1 対 1 か 1 対多かを知らない

[`docs/runtime-v2.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/runtime-v2.md) の宣言。

```markdown title="docs/runtime-v2.md"
containerd does not know or care about whether the shim to container relationship is one-to-one,
or one-to-many. It is entirely up to the shim to decide.
```

containerd がするのは「`start` を実行してアドレスを受け取り、そこに繋ぐ」だけ。返ってきたアドレスが新しい shim のものか、既存のものかを区別しない。

### grouping key はアノテーションから来る

`runc.v2` の shim は、bundle の `config.json` のアノテーションを見る。

```go
var groupLabels = []string{
	"io.containerd.runc.v2.group",
	"io.kubernetes.cri.sandbox-id",
}
```

**順序に意味がある**。先に見つかった方を使う。1 つ目は shim 固有の明示的な指定、2 つ目は CRI プラグインが Pod のコンテナに自動的に付けるラベルだ。

どちらもなければ、コンテナ ID 自体が grouping key になる (= 1 コンテナ 1 shim)。

### アドレスの衝突が「合流」になる

grouping key はソケットアドレスの SHA256 の入力に入る ([shim プロセスはどう生まれるか](../shim-process-start/))。だから同じ Pod のコンテナは **同じアドレス** を計算する。

2 つ目のコンテナの `start` は、そのアドレスで listen しようとして `EADDRINUSE` を受ける。そこで接続を試み、成功すれば「既存の shim がいる」と判断して、そのアドレスをそのまま返す。

**排他制御をカーネルの bind に委ねている**。ロックファイルも、レジストリも要らない。

### shim は最後のコンテナが消えるまで終了しない

containerd はタスクを削除するたびに `TaskService.Shutdown` を送る。しかし shim は、**まだコンテナを持っていれば終了しない**。

## ソースコードのどこか

### grouping key の決定

[`cmd/containerd-shim-runc-v2/manager/manager_linux.go#L54-L60`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/manager/manager_linux.go#L54-L60)。

```go title="cmd/containerd-shim-runc-v2/manager/manager_linux.go"
// group labels specifies how the shim groups services.
// currently supports a runc.v2 specific .group label and the
// standard k8s pod label.  Order matters in this list
var groupLabels = []string{
	"io.containerd.runc.v2.group",
	"io.kubernetes.cri.sandbox-id",
}
```

「Order matters in this list」と明記されている。明示的な指定が CRI の自動ラベルより優先される。

```go title="cmd/containerd-shim-runc-v2/manager/manager_linux.go"
	grouping := id
	spec, err := readSpec()
	if err != nil {
		return nil, err
	}

	for _, group := range groupLabels {
		if groupID, ok := spec.Annotations[group]; ok {
			grouping = groupID
			break
		}
	}
```

既定値がコンテナ ID なので、**アノテーションがなければグルーピングされない**。CRI 以外のクライアント (`ctr` など) は 1 コンテナ 1 shim になる。

`readSpec` は cwd の `config.json` を読む。shim は bundle ディレクトリで起動されているので、パスを組み立てる必要がない ([bundle: ディスク上に置かれた実行単位](../bundle/))。

### CRI 側でラベルを付ける

[`internal/cri/annotations/annotations.go#L39`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/internal/cri/annotations/annotations.go#L39)。

```go title="internal/cri/annotations/annotations.go"
	SandboxID = "io.kubernetes.cri.sandbox-id"
```

CRI プラグインは、Pod のコンテナを作るときにこのアノテーションを OCI spec に入れる。**shim 側はこの文字列を知っているだけで、CRI の存在は知らない**。

CRI プラグインと shim が、アノテーションのキー名という文字列 1 つで協調している。containerd コアはこの取り決めに関与しない。

### 合流の実装

[`cmd/containerd-shim-runc-v2/manager/manager_linux.go#L150-L175`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/manager/manager_linux.go#L150-L175)。

```go title="cmd/containerd-shim-runc-v2/manager/manager_linux.go"
	socket, err := shim.NewSocket(address)
	if err != nil {
		// the only time where this would happen is if there is a bug and the socket
		// was not cleaned up in the cleanup method of the shim or we are using the
		// grouping functionality where the new process should be run with the same
		// shim as an existing container
		if !shim.SocketEaddrinuse(err) {
			return nil, fmt.Errorf("create new shim socket: %w", err)
		}
		if !debug && shim.CanConnect(address) {
			return &shimSocket{addr: address}, errdefs.ErrAlreadyExists
		}
```

`EADDRINUSE` かつ **実際に接続できる** なら `ErrAlreadyExists`。ファイルが残っているだけで誰も listen していない場合は、削除して作り直す。

`CanConnect` の確認が要るのは、Unix ソケットのファイルはプロセスが死んでも残るからだ。ファイルの存在だけでは判断できない。

呼び出し側。

```go title="cmd/containerd-shim-runc-v2/manager/manager_linux.go"
	s, err := newShimSocket(ctx, socketDir, opts.GetContainerdGrpcAddress(), grouping, false)
	if err != nil {
		if errdefs.IsAlreadyExists(err) {
			params.Address = s.addr
			return &params, nil
		}
		return nil, err
	}
```

`ErrAlreadyExists` なら **新しいプロセスを起動せずに、既存のアドレスを返す**。containerd はそのアドレスに接続し、`TaskService.Create` を送る。既存の shim が新しいコンテナを受け持つ。

`start` プロセスは何も起動せずに終了する。

### 終了の条件

[`cmd/containerd-shim-runc-v2/task/service.go#L608-L622`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd-shim-runc-v2/task/service.go#L608-L622)。

```go title="cmd/containerd-shim-runc-v2/task/service.go"
func (s *service) Shutdown(ctx context.Context, r *taskAPI.ShutdownRequest) (*ptypes.Empty, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// return out if the shim is still servicing containers
	if len(s.containers) > 0 {
		return empty, nil
	}

	// please make sure that temporary resource has been cleanup or registered
	// for cleanup before calling shutdown
	s.shutdown.Shutdown()

	return empty, nil
}
```

コンテナが残っていれば **成功を返して何もしない**。エラーではない。

この振る舞いは [`docs/sandbox-api.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/docs/sandbox-api.md) で仕様として明記されている。

```markdown title="docs/sandbox-api.md"
containerd invokes `TaskService.Shutdown` after deleting every task. It may be
invoked multiple times for a grouped shim. It does not mean that the shim must
terminate immediately. The shim should return without terminating while it still
has active tasks. It should terminate only after receiving `TaskService.Shutdown`
when no active tasks remain.
```

**「Shutdown は複数回呼ばれうる」「即座に終了せよという意味ではない」** と契約が書かれている。グルーピングを実装する shim は、これを守らないと最初のコンテナ削除で全部道連れにする。

## なぜそうなっているか

### Pod あたり 1 shim にすると、常駐コストが Pod 数に比例する

shim 1 つあたり数 MB〜十数 MB。Kubernetes の Pod は平均して 2〜3 コンテナ (pause + アプリ) を持つので、**コンテナごとに立てると 2〜3 倍のメモリ** を使う。

100 Pod のノードなら、200〜300 個の shim が 100 個に減る。プロセス数も同様に減り、`ps` の出力も見やすくなる。

さらに、同じ Pod のコンテナは同じ namespace を共有するので、shim がまとめて管理する方が自然でもある。

### 判断を shim に委ねる

containerd がグルーピングを決めると、

- 「何をグループとするか」の定義を containerd が持つことになる
- Pod という Kubernetes 固有の概念がコアに漏れる
- 別のグルーピング基準を持つランタイムに対応できない

shim が決めるなら、VM ベースのランタイムは「1 VM = 1 shim」を、通常のコンテナは「1 Pod = 1 shim」を、それぞれ自分の都合で選べる。

**containerd の API は「アドレスを返す」だけなので、どちらでも変わらない**。

### bind の排他性を利用する

同じアドレスで複数のプロセスが listen できないのは、カーネルが保証する。これを「最初に来た者が shim を起動し、後続は接続する」という排他制御に使っている。

自前でロックを実装すると、

- ロックファイルの後始末が要る
- プロセスが死んだときのロック解放が要る
- 競合状態のテストが難しい

**既にある排他機構を借りる** ほうが確実だ。しかも「接続できるか」で生死の判定までできる。

### アノテーションで協調する

CRI プラグインと shim は、`io.kubernetes.cri.sandbox-id` という文字列でのみ繋がっている。型の共有もインターフェースもない。

疎結合の代償として、**片方が名前を変えると静かに壊れる**。containerd はこれを、両者を同じリポジトリに置くことで管理している。外部の shim (Kata など) も同じラベルを見ることで、CRI と協調できる。

## どう活かすか

### グルーピングを確認する

```sh
# shim プロセスの数と Pod 数を比べる
$ ps -C containerd-shim-runc-v2 --no-headers | wc -l
$ crictl pods -q | wc -l

# shim の -id 引数は grouping key (= sandbox ID)
$ ps -o args -C containerd-shim-runc-v2 | head
```

shim の数が Pod 数とほぼ一致していれば、グルーピングが効いている。コンテナ数と一致しているなら効いていない。

`ctr` で作ったコンテナは常に 1 対 1 なので、手動でグルーピングを試すなら明示的なアノテーションを付ける。

```sh
$ ctr run --annotation io.containerd.runc.v2.group=mygroup ...
```

### shim が終了しないとき

Pod を削除したのに shim が残っている場合、

1. まだコンテナが残っている (`crictl ps -a` で確認)
2. `Shutdown` が届いていない
3. shim 側で終了処理が詰まっている

1 が最も多い。exec で作ったプロセスが残っていることもある。

### 「アドレスの衝突で合流する」パターン

複数の呼び出しから 1 つのサービスインスタンスを共有したいとき、この手法が使える。

- **共有の単位からアドレスを決定的に計算する** — ハッシュなど
- **bind の排他性で最初の 1 つを決める**
- **`EADDRINUSE` を受けたら接続を試みる** — 成功すれば合流、失敗すれば残骸として掃除
- **終了条件を「利用者が 0 になったとき」にする**

4 番目を忘れると、最初の利用者が去った時点でサービスが落ちる。参照カウントに相当するものが要る、という点は普通のリソース共有と同じだ。
