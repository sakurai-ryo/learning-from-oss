---
title: "bbolt 1 ファイルに、すべてのメタデータを入れる"
description: "イメージもコンテナも snapshot もリースも、containerd のメタデータは meta.db という 1 つの bbolt ファイルに入る。スキーマはソースのコメントに ASCII のツリーで書かれていて、バージョン・namespace・オブジェクト種別・キーという 4 段のバケット階層になっている。単一ホスト前提だから、これで足りる。"
group: "メタデータとストア"
sidebar:
  order: 15
---

## 何を学んだか

### DB は 1 ファイル、スキーマはコメント

containerd のメタデータは `/var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db` に全部入る。bbolt は etcd でも使われている Go 製の組み込み KVS で、B+tree を 1 ファイルの mmap 上に持ち、単一プロセスからの読み書きだけを許す。

スキーマ定義は Go の型でも SQL でもなく、**`buckets.go` の冒頭コメントに書かれた ASCII のツリー** だ。

```
<version>/<namespace>/<object>/<key> -> <field>
```

4 段の階層で、

- **version** — 今は `v1`。互換性を壊す変更のときだけ増える
- **namespace** — `default`、`k8s.io` など ([1 つのデーモンを namespace で分ける](../namespaces/))
- **object** — `images`、`containers`、`snapshots`、`content`、`leases`、`sandboxes`
- **key** — イメージ名、コンテナ ID、snapshot キー、blob digest

### 「値」は基本的にバイト列のフィールド

bbolt には型がない。すべてのフィールドは `[]byte` で、containerd 側で符号化を決めている。

| 種類                   | 符号化                            |
| ---------------------- | --------------------------------- |
| 時刻                   | `time.Time` のバイナリ形式        |
| サイズ                 | varint                            |
| spec / runtime options | protobuf でマーシャルしたバイト列 |
| ラベル                 | サブバケットの key → value        |
| 参照 (子、リース対象)  | キーだけ置いて値は nil            |

最後の「キーだけで値は nil」が独特で、**集合を表現するのにバケットのキー空間を使う** イディオムになっている。

### 参照関係もこの木の中にある

snapshot は `parent` フィールドで親を指し、`children` バケットに子のキーを持つ。リースは `snapshots` / `content` / `ingests` バケットに、押さえている資源のキーを並べる。

GC が辿るグラフは、**このバケット構造そのもの** だ。別途インデックスを持たず、木を降りながら参照を集める ([tri-color の mark & sweep](../tricolor-gc/))。

## ソースコードのどこか

### スキーマのコメント

[`core/metadata/buckets.go#L17-L60`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/buckets.go#L17-L60)。

```go title="core/metadata/buckets.go"
// Below is the current database schema. This should be updated each time
// the structure is changed in addition to adding a migration and incrementing
// the database version.
//
//	Notes
//	   • `╘══*...*` refers to maps with arbitrary keys
//	   • `version` is a key to a numeric value identifying the minor revisions
//	     of schema version
//	   • a namespace in a schema bucket cannot be named "version"
```

「構造を変えたらこのコメントも更新し、マイグレーションを足し、バージョンを上げること」という指示付きだ。スキーマの記述をコードのそばに置き、レビューで一緒に見えるようにしている。

実際のツリーはこう続く ([`#L61-L96`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/buckets.go#L61-L96))。

```go title="core/metadata/buckets.go"
//	Schema
//	└──v1                                             - Schema version bucket
//	   ├──version : <varint>                          - Latest version, see migrations
//	   ╘══*namespace*
//	      ├──labels
//	      │  ╘══*key* : <string>                      - Label value
//	      ├──image
//	      │  ╘══*image name*
//	      │     ├──createdat : <binary time>          - Created at
//	      │     ├──updatedat : <binary time>          - Updated at
//	      │     ├──target
//	      │     │  ├──digest : <digest>               - Descriptor digest
//	      │     │  ├──mediatype : <string>            - Descriptor media type
//	      │     │  └──size : <varint>                 - Descriptor size
```

image のエントリが持つのは createdat / updatedat / target / labels だけ。レイヤ一覧もサイズ合計もない ([image store が持つのは「名前 → descriptor」だけ](../image-store/))。

コンテナはもう少し持つ。

```go title="core/metadata/buckets.go"
//	      ├──containers
//	      │  ╘══*container id*
//	      │     ├──createdat : <binary time>
//	      │     ├──updatedat : <binary time>
//	      │     ├──spec : <binary>                    - Proto marshaled spec
//	      │     ├──image : <string>                   - Image name
//	      │     ├──snapshotter : <string>             - Snapshotter name
//	      │     ├──snapshotKey : <string>             - Snapshot key
//	      │     ├──runtime
//	      │     │  ├──name : <string>                 - Runtime name
//	      │     │  └──options : <binary>              - Proto marshaled options
//	      │     ├──extensions
//	      │     │     ╘══*name* : <binary>            - Proto marshaled extension
```

`spec` と `extensions` が「proto marshaled」= **中身を解釈しないバイト列** であることが、ここでも確認できる。`extensions` はクライアントが任意のデータをコンテナに紐付けられる場所で、CRI プラグインは Pod の情報をここに入れている。

リースの構造も明快だ。

```go title="core/metadata/buckets.go"
//	      └──leases
//	         ╘══*lease id*
//	             ├──createdat : <binary time>
//	             ├──labels
//	             │  ╘══*key* : <string>
//	             ├──snapshots
//	             │  ╘══*snapshotter*
//	             │     ╘══*snapshot key* : <nil>      - Snapshot reference
//	             ├──content
//	             │  ╘══*blob digest* : <nil>          - Content blob reference
//	             └─────ingests
//	                   ╘══*ingest reference* : <nil> - Content ingest reference
```

値が `<nil>` の 3 つのバケットが、そのリースが押さえている資源の集合になる。

### バケットへのアクセスはヘルパ関数に集約

[`core/metadata/buckets.go#L242-L298`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/buckets.go#L242-L298)。

```go title="core/metadata/buckets.go"
func getContainerBucket(tx *bolt.Tx, namespace, id string) *bolt.Bucket {
	return getBucket(tx, bucketKeyVersion, []byte(namespace), bucketKeyObjectContainers, []byte(id))
}

func getBlobBucket(tx *bolt.Tx, namespace string, dgst digest.Digest) *bolt.Bucket {
	return getBucket(tx, bucketKeyVersion, []byte(namespace), bucketKeyObjectContent, bucketKeyObjectBlob, []byte(dgst.String()))
}
```

パスの組み立てが 1 か所にまとまっているので、バケット名の変更が波及しない。キー名も定数化されている ([`#L147-L178`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/buckets.go#L147-L178))。

```go title="core/metadata/buckets.go"
	bucketKeyObjectImages     = []byte("images")     // stores image objects
	bucketKeyObjectContainers = []byte("containers") // stores container objects
	bucketKeyObjectSnapshots  = []byte("snapshots")  // stores snapshot references
	bucketKeyObjectContent    = []byte("content")    // stores content references
	bucketKeyObjectBlob       = []byte("blob")       // stores content links
	bucketKeyObjectIngests    = []byte("ingests")    // stores ingest objects
	bucketKeyObjectLeases     = []byte("leases")     // stores leases
```

コメントの言葉遣いが正確で、content は「content references」、blob は「content links」。**実体ではなく参照を持っている** ことが名前で示されている。実際の blob はファイルシステム上にある。

### DB 構造体が持つもの

[`core/metadata/db.go#L84-L116`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/db.go#L84-L116)。

```go title="core/metadata/db.go"
type DB struct {
	db Transactor
	ss map[string]*snapshotter
	cs *contentStore

	// wlock is used to protect access to the data structures during garbage
	// collection. While the wlock is held no writable transactions can be
	// opened, preventing changes from occurring between the mark and
	// sweep phases without preventing read transactions.
	wlock sync.RWMutex

	// dirty flag indicates that references have been removed which require
	// a garbage collection to ensure the database is clean. This tracks
	// the number of dirty operations. This should be updated and read
	// atomically if outside of wlock.Lock.
	dirty atomic.Uint32
```

`DB` は bbolt のハンドルに加えて、**snapshotter と content store のインスタンスを保持している**。メタデータ層がバックエンドを内包する構造で、「メタデータと実体を一緒に更新する」ためにこうなっている ([metadata が実装を包んで、namespace とトランザクションを足す](../metadata-wrapping/))。

`wlock` のコメントが GC との関係を説明している。mark と sweep の間に変更が入らないよう **書き込みトランザクションだけを止め、読み取りは通す**。

### 性能と安全性のつまみ

[`plugins/metadata/plugin.go#L67-L75`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/metadata/plugin.go#L67-L75)。

```go title="plugins/metadata/plugin.go"
	// NoSync enables optimizations that improve database write performance by:
	// 1. Disabling fsync calls after every write, which prevents ensuring that data is immediately flushed
	//    to disk but significantly improves write throughput (NoSync).
	// 2. Preventing automatic growth of the memory-mapped file during writes, further improving performance
	//    in environments where the database size is stable (NoGrowSync).
	//
	// These settings can improve performance, but introduce a risk of data loss during crashes. Use with care!
	NoSync bool `toml:"no_sync"`
```

既定は false (毎回 fsync)。トレードオフとリスクを明示したうえで、選択肢として置いてある。

## なぜそうなっているか

### 単一ホストだから、埋め込み KVS で足りる

[`SCOPE.md`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/SCOPE.md) の「containerd is scoped to a single host」がここに効いている。分散する必要がないので、

- レプリケーションもコンセンサスも要らない
- トランザクションはプロセス内で完結する
- 別プロセスの DB サーバを立てる必要がない (依存が増えない)

bbolt は 1 プロセスからの排他アクセスしか許さないが、containerd が唯一の書き手なので問題にならない。

### バケット階層をそのままアクセス制御に使う

namespace が階層の第 2 段にあるので、「namespace 内だけを見る」がバケットを 1 つ降りる操作になる。フィルタリングのコードが要らず、**間違って他 namespace のデータを見てしまう経路が構造的に作りにくい**。

同様に、リースが押さえる資源も専用バケットに入るので、「このリースは何を押さえているか」はバケットの列挙で答えられる。

### スキーマをコメントで持つことの是非

ORM もスキーマ定義言語も使わず、コメントとヘルパ関数で管理する方式は、一見すると危うい。実際、コメントの更新漏れは起こりうる。

それでも成立しているのは、

- **書き込み経路がすべて `core/metadata/` に閉じている** — 外部からバケットを直接触れない
- **キー名が定数化されている** — 文字列リテラルが散らばらない
- **マイグレーションの仕組みがある** — 変更時に手順が決まっている

の 3 つがあるからだ。「スキーマの記述」ではなく「スキーマへのアクセス」を 1 か所に集めることで、実質的な一貫性を保っている。

## どう活かすか

### meta.db を直接覗く

bbolt の CLI を使えば中身を読める (containerd を止めてから行う。bbolt は排他ロックを取る)。

```sh
$ go install go.etcd.io/bbolt/cmd/bbolt@latest

# トップレベルのバケット
$ bbolt buckets /var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db

# namespace の下のオブジェクト種別
$ bbolt buckets /var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db v1 k8s.io
```

「API では見えないが DB には残っている」種類の問題 (削除しきれていないリース、孤立した ingest) を調べるときに有効だ。

### KVS の上にスキーマを作るときの型

containerd のやり方は、KVS でリレーショナルに近いものを表現するときの実例として参考になる。

- **階層をキーの構造で表す** — `<version>/<namespace>/<object>/<key>` のように、上位の区分から順に降りる
- **バージョンを最上位に置く** — スキーマ変更のときに新旧を共存させられる
- **集合はキーだけのバケットで表す** — 値を持たせず、存在するかどうかだけを見る
- **アクセスをヘルパ関数に閉じる** — キーの組み立てをコードに散らさない
- **スキーマ図をソースに置く** — 別ファイルの設計書は必ず腐る

特に「バージョンを最上位のバケットにする」は、後からマイグレーションが必要になったときに効いてくる。
