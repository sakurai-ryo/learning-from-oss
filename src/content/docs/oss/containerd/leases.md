---
title: "参照カウントをやめて、「これから使う」を宣言させる"
description: "pull 中の layer は、まだ誰からも参照されていない。参照カウントでは「これから使う」を表現できないので、containerd はリースという仕組みを持つ。クライアントは作業前にリースを取り、その中で作った資源は GC から守られる。既定の期限は 24 時間で、クライアントが死んでも自動的に解放される。"
group: "lease と GC"
sidebar:
  order: 20
---

## 何を学んだか

### 参照カウントでは足りない場面

イメージを pull する処理を考える。

1. manifest の blob を content store に書く
2. config の blob を書く
3. layer の blob を n 個書く
4. すべて揃ったら image レコードを作る

1 の直後、manifest の blob は **誰からも参照されていない**。参照カウントなら 0 なので、この瞬間に GC が走れば消えてしまう。4 に到達するまで、すべての中間成果物が同じ状態にある。

「これから参照する予定がある」を表現する手段が要る。それがリースだ。

### リースは「資源の集合を押さえる期限付きの札」

```go
ctx, done, err := client.WithLease(ctx)
if err != nil {
	return err
}
defer done(ctx)

// この ctx で作られた content / snapshot / ingest は
// すべてこのリースに紐付き、GC の対象外になる
```

リースの実体は bbolt の `leases/<lease id>/` バケットで、`content` / `snapshots` / `ingests` のサブバケットに押さえている資源のキーが並ぶ ([bbolt 1 ファイルに、すべてのメタデータを入れる](../bolt-schema/))。

GC はリースを **ルート** の 1 つとして扱う。リースが指すものは到達可能なので消えない。

### 既定で 24 時間の期限が付く

`client.WithLease` はオプションなしなら、ランダム ID と 24 時間の期限を持つリースを作る。`defer done(ctx)` で明示的に消すが、**プロセスが強制終了しても 24 時間後には消える**。

これが [smart client model](../smart-client/) の安全弁になっている。クライアントに後始末を任せる設計は、クライアントが死んだときの経路を用意しないと資源が永久に残る。

### コンテキストで運ぶ

リース ID は namespace と同様、`context.Context` と gRPC ヘッダ (`containerd-lease`) で運ばれる。API のどのメソッドにもリースの引数はない。

```markdown title="docs/garbage-collection.md"
The lease is not an explicit field in the API (except of course the leases
service), but rather an optional field any API service can use. Leases can
be set on any gRPC service endpoint using a gRPC header.
```

## ソースコードのどこか

### インターフェースは 6 メソッド

[`core/leases/lease.go#L27-L45`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/leases/lease.go#L27-L45)。

```go title="core/leases/lease.go"
// Manager is used to create, list, and remove leases
type Manager interface {
	Create(context.Context, ...Opt) (Lease, error)
	Delete(context.Context, Lease, ...DeleteOpt) error
	List(context.Context, ...string) ([]Lease, error)
	AddResource(context.Context, Lease, Resource) error
	DeleteResource(context.Context, Lease, Resource) error
	ListResources(context.Context, Lease) ([]Resource, error)
}

// Lease retains resources to prevent cleanup before
// the resources can be fully referenced.
type Lease struct {
	ID        string
	CreatedAt time.Time
	Labels    map[string]string
}
```

コメントの "prevent cleanup **before the resources can be fully referenced**" が、この機構の存在理由をそのまま述べている。「参照されるようになる前」を守るためのものだ。

`Resource` は型と ID の組にすぎない。

```go title="core/leases/lease.go"
// Resource represents low level resource of image, like content, ingest and
// snapshotter.
type Resource struct {
	ID   string
	Type string
}
```

### クライアント側の既定値

[`client/lease.go#L27-L54`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/client/lease.go#L27-L54)。

```go title="client/lease.go"
func (c *Client) WithLease(ctx context.Context, opts ...leases.Opt) (context.Context, func(context.Context) error, error) {
	nop := func(context.Context) error { return nil }

	_, ok := leases.FromContext(ctx)
	if ok {
		return ctx, nop, nil
	}
	...
	if len(opts) == 0 {
		// Use default lease configuration if no options provided
		opts = []leases.Opt{
			leases.WithRandomID(),
			leases.WithExpiration(24 * time.Hour),
		}
	}
```

既にリースがあれば **何もしない** (`nop` を返す)。ネストした呼び出しで二重にリースを作らないための配慮で、`NewContainer` の中で `WithLease` を呼んでも、外側で既に取っていればそのまま使われる。

### 期限は GC のラベルとして表現される

[`core/metadata/gc.go#L79-L87`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/gc.go#L79-L87)。

```go title="core/metadata/gc.go"
	// labelGCExpire indicates that an object is collectible after the
	// provided time. For image objects, this makes them available to
	// garbage collect when expired, when not provided, image objects
	// are root objects that never expire. For non-root objects such
	// as content or snapshots, these objects will be treated like
	// root objects before their expiration.
	// Expected format is RFC 3339
	labelGCExpire = []byte("containerd.io/gc.expire")
```

リースの期限は特別なフィールドではなく、**`containerd.io/gc.expire` というラベル** だ。だから同じ仕組みが image にも content にも使える。

「期限前の非ルートオブジェクトは、ルートのように扱われる」という記述が効いている。期限付きのラベルを content blob に付ければ、その時刻まで消えない一時オブジェクトになる。

### flat リース

```go title="core/metadata/gc.go"
	// labelGCFlat indicates that a lease is flat and only intends to
	// lease the referenced objects, not their references. This can be
	// used to avoid leasing an entire tree of objects when only the root
	// object is needed.
	labelGCFlat = []byte("containerd.io/gc.flat")
```

通常のリースは、押さえた資源が **さらに参照しているもの** も守る。manifest を押さえれば layer も守られる。

`flat` を付けると、押さえたものだけを守る。「manifest の JSON だけ欲しくて、layer は要らない」という場合に、巨大な layer 群を巻き添えで保持しないための仕組みだ。

### 後方参照 (back reference)

```go title="core/metadata/gc.go"
	// Back reference labels are used to establish a reference relationship
	// directly from a child object to a parent object. It allows a child
	// object to attach itself to the lifecycle of a parent without updating
	// the parent object or requiring the parent already exists.

	labelGCContainerBackRef = []byte("containerd.io/gc.bref.container")
	labelGCContentBackRef   = []byte("containerd.io/gc.bref.content")
	labelGCImageBackRef     = []byte("containerd.io/gc.bref.image")
	labelGCSnapBackRef      = []byte("containerd.io/gc.bref.snapshot.")
```

通常の参照は親から子へ張る。後方参照は逆で、**子が「私はこの親に属する」と宣言する**。

利点が 2 つ書かれている。

- 親のオブジェクトを更新しなくてよい (親のラベルを書き換える競合が起きない)
- **親がまだ存在しなくてもよい** — 先に子を作り、後から親を作れる

pull の途中で「このレイヤはこのイメージのもの」と宣言しておき、イメージレコードは最後に作る、という順序が自然に書ける。

### 条件付き参照

比較的新しく入った仕組みもある。

```go title="core/metadata/gc.go"
	// Conditional labels allow links to be conditional based on a value of the object
	// If an object has that condition, it will add a back reference to the conditioned objects
	// Conditional value format is condition[=<>]value[,condition=value...]|key
	...
	labelGCSnapConditional = []byte("containerd.io/gc.cond.snapshot")

	// conditionNameUsedAt is the condition name for time-based "used at" conditions
	conditionNameUsedAt = []byte("usedat")
```

「最後に使われたのが指定時刻より後なら参照を張る」といった条件付きの保持ができる。イメージのキャッシュ保持ポリシー (最近使ったものは残す) を、GC のグラフの中で表現するための拡張だ。

## なぜそうなっているか

### 参照カウントの限界

参照カウントには「まだ参照されていないが、これから参照される」を表現する場所がない。よくある回避策は、

- **一時的に参照カウントを +1 しておく** — 誰が減らすかを管理する必要がある
- **作業中フラグを立てる** — フラグの寿命を誰が管理するのか
- **GC を止める** — 長時間の pull の間 GC が動かない

いずれも「誰かが解放し忘れたら永久に残る」という同じ問題に行き着く。リースはこれを **期限** で解いた。解放を忘れても、期限が来れば消える。

### 期限は「忘れることを前提にした設計」

分散システムのリース (Chubby、etcd の lease) と同じ発想だ。所有者が生きている限り更新でき、死んだら自動的に失効する。

containerd の場合は 1 ホスト内だが、「クライアントプロセスが死ぬ」は日常的に起こる。`ctr pull` を Ctrl-C で止める、kubelet が再起動する、といった状況で毎回残骸が積み上がるようでは運用できない。

### 関係の宣言をラベルに寄せる

リースが押さえるのは「この作業で作ったもの」だけで、資源同士の関係 (manifest → layer) はラベルで表現される。この分業により、

- リースは **作業のスコープ** だけを扱う
- ラベルは **恒久的な関係** を扱う

という役割分担ができる。pull が終わってリースが消えても、ラベルによる関係は残るので layer は image から到達可能なまま守られる ([資源の関係グラフを、クライアントがラベルで書く](../gc-labels/))。

## どう活かすか

### リースを見る

```sh
# リースの一覧 (ID, 作成時刻, ラベル)
$ ctr -n k8s.io leases ls

# 何を押さえているか
$ ctr -n k8s.io leases list-resources <lease-id>
```

`ctr leases ls` に大量のリースが残っている場合、クライアントが後始末をせずに死んでいる可能性がある。期限を持たないリース (ラベルに `containerd.io/gc.expire` がない) が積み上がっていたら要注意で、それは永久に資源を保持する。

### 自作クライアントでの必須事項

containerd を Go 以外から叩く、あるいは gRPC を直接使う場合、リースの管理は自分の責任になる。

```
# gRPC ヘッダにリース ID を載せる
containerd-lease: <lease-id>
```

守るべきことは 3 つ。

1. **複数の資源を作る操作は、必ずリースの中で行う**
2. **リースには期限を付ける** — 付けないリースは永久に残る
3. **完了したらリースを消す** — 消し忘れても期限で消えるが、その間資源は保持される

### 「期限付きの予約」というパターン

リースの考え方は、GC を持つあらゆるシステムに応用できる。

- 一時ファイルの掃除 — 「使用中」を期限付きの予約として表現する
- オブジェクトストレージのマルチパートアップロード — S3 の未完了アップロードも同じ問題を持ち、ライフサイクルルールで期限切れにする
- 分散ロック — 所有者の死を期限で検出する

共通する要点は、**「所有者が消える」を必ず起こることとして扱い、その場合の回収経路を設計に組み込む** ことだ。「正しく解放される前提」で作ると、必ず漏れる。
