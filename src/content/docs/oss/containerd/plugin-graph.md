---
title: "依存を型で宣言し、初期化順を DFS で決める"
description: "containerd のプラグインは、依存先を ID ではなく「型」で宣言する。registry は登録順のリストを深さ優先で辿って初期化順を作り、循環を見つけたら panic する。この 100 行に満たないアルゴリズムが、40 個以上のプラグインの起動順序を決めている。"
group: "containerd のかたち"
sidebar:
  order: 12
---

## 何を学んだか

### 依存は「型」で宣言する

プラグインが宣言する依存は、具体的な実装 ID ではなく **型** だ。

```go title="plugins/metadata/plugin.go"
		Requires: []plugin.Type{
			plugins.ContentPlugin,
			plugins.EventPlugin,
			plugins.SnapshotPlugin,
		},
```

metadata プラグインは「content プラグインが要る」と言うだけで、それが `local` なのか proxy なのかを指定しない。しかも `SnapshotPlugin` は複数登録されているのが普通で、この宣言は **「登録されている全 snapshotter の初期化を待つ」** を意味する。

だから metadata プラグインは、初期化時に `GetByType(SnapshotPlugin)` で全部を受け取り、名前をキーにしたマップとして保持できる。

### `*` は「全部の後」

依存として `"*"` を書くと、他のすべてのプラグインの後に初期化される。ただし `*` を書くときは他の依存を並べられない。

```go
	for _, requires := range r.Requires {
		if (requires == "*" && len(r.Requires) != 1) || requires == r.Type {
			panic(ErrInvalidRequires)
		}
	}
```

自分と同じ型への依存も禁止されている。同じ型のプラグイン同士は互いに独立であるべき、という制約だ。

### 順序は深さ優先で決まる

registry は登録された順のリストで、`Graph()` がそれを辿って初期化順のリストを作る。

- 登録リストを頭から見る
- そのプラグインの `Requires` に挙がった型のプラグインを **先に** 出力する (再帰)
- 再帰から戻ったら自分を出力する
- 既に出力済みのものは飛ばす

依存の解決は、実行時のグラフ探索ではなく **起動時に 1 回だけ** 行われる。以降は単なるリストのループになる。

### 循環は panic

依存が循環していたら `panic` する。エラーを返すのではなく落とす。

## ソースコードのどこか

### Graph の実装

[`vendor/github.com/containerd/plugin/plugin.go#L112-L136`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/vendor/github.com/containerd/plugin/plugin.go#L112-L136)。

```go title="vendor/github.com/containerd/plugin/plugin.go"
// Graph computes the ordered list of registrations based on their dependencies,
// filtering out any plugins which match the provided filter.
func (registry Registry) Graph(filter DisableFilter) []Registration {
	handled := make(map[*Registration]struct{}, len(registry))
	if filter != nil {
		for _, r := range registry {
			if filter(r) {
				handled[r] = struct{}{}
			}
		}
	}

	ordered := make([]Registration, 0, len(registry)-len(handled))
	stack := make([]*Registration, 0, cap(ordered))
	for _, r := range registry {
		if _, ok := handled[r]; ok {
			continue
		}
		children(append(stack, r), registry, handled, &ordered)
		handled[r] = struct{}{}
		ordered = append(ordered, *r)
	}
	return ordered
}
```

無効化されたプラグインを **最初から `handled` に入れておく** のが巧い。「処理済み」として扱えば、依存の解決でも出力でも自動的に飛ばされる。除外のための分岐を各所に書かなくて済む。

再帰部分 ([`#L138-L156`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/vendor/github.com/containerd/plugin/plugin.go#L138-L156))。

```go title="vendor/github.com/containerd/plugin/plugin.go"
func children(stack []*Registration, registry []*Registration, handled map[*Registration]struct{}, ordered *[]Registration) {
	reg := stack[len(stack)-1]
	for _, t := range reg.Requires {
		for _, r := range registry {
			if (t == "*" || r.Type == t) && r != reg {
				if _, ok := handled[r]; !ok {
					// Ensure not in current stack
					for _, p := range stack[:len(stack)-1] {
						if p == r {
							panic(fmt.Errorf("circular plugin dependency at %s: %w", r.URI(), ErrPluginCircularDependency))
						}
					}
					children(append(stack, r), registry, handled, ordered)
					handled[r] = struct{}{}
					*ordered = append(*ordered, *r)
				}
			}
		}
	}
}
```

内側の二重ループが「型 t にマッチする登録を全部探す」で、`t == "*"` なら全部にマッチする。循環検出は **現在の再帰スタックを線形に走査する** だけ。プラグイン数がせいぜい数十なので、これで十分速い。

### 無効化フィルタ

[`cmd/containerd/server/config/config.go#L660-L670`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd/server/config/config.go#L660-L670)。

```go title="cmd/containerd/server/config/config.go"
// V2DisabledFilter matches based on URI
func V2DisabledFilter(list []string) plugin.DisableFilter {
	set := make(map[string]struct{}, len(list))
	for _, l := range list {
		set[l] = struct{}{}
	}
	return func(r *plugin.Registration) bool {
		_, ok := set[r.URI()]
		return ok
	}
}
```

`config.toml` の `disabled_plugins = ["io.containerd.grpc.v1.cri"]` がそのまま URI の集合になる。CRI を止めたい (Docker 専用ノードなど) というよくある要求が、この 1 行で満たされる。

### 登録の検証

[`vendor/github.com/containerd/plugin/plugin.go#L158-L180`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/vendor/github.com/containerd/plugin/plugin.go#L158-L180)。

```go title="vendor/github.com/containerd/plugin/plugin.go"
func (registry Registry) Register(r *Registration) Registry {
	if r.Type == "" {
		panic(ErrNoType)
	}
	if r.ID == "" {
		panic(ErrNoPluginID)
	}
	if err := checkUnique(registry, r); err != nil {
		panic(err)
	}

	for _, requires := range r.Requires {
		if (requires == "*" && len(r.Requires) != 1) || requires == r.Type {
			panic(ErrInvalidRequires)
		}
	}

	return append(registry, r)
}
```

すべて `panic` だ。`Register` は `init()` から呼ばれるので、**間違いはプロセス起動前に必ず露見する**。実行時の設定ミスではなく、プログラムの誤りだからエラーを返す意味がない。

コメントに「Registry 自体は不変で、登録のたびにコピーして追加する」とある。グローバルなレジストリへの追加を、値のコピーで表現している。

### proxy plugin も同じ土俵に乗せる

[`cmd/containerd/server/server.go#L365-L381`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/cmd/containerd/server/server.go#L365-L381)。

```go title="cmd/containerd/server/server.go"
		registry.Register(&plugin.Registration{
			Type: t,
			ID:   name,
			InitFn: func(ic *plugin.InitContext) (any, error) {
				ic.Meta.Exports = exports
				ic.Meta.Platforms = append(ic.Meta.Platforms, p)
				ic.Meta.Capabilities = pp.Capabilities
				conn, err := clients.getClient(address)
				if err != nil {
					return nil, err
				}
				return f(conn), nil
			},
		})
```

設定ファイルに書かれた proxy plugin が、**組み込みプラグインとまったく同じ `Registration` として登録される**。グラフを作る前に登録しておくので、依存解決も初期化順も同じ仕組みに乗る。

外部プロセスの snapshotter が、内部の overlayfs と区別なく `SnapshotPlugin` 型のインスタンスとして現れる。これが [proxy plugin](../proxy-plugins/) の基盤だ。

### 設定の移行もプラグインが持つ

`Registration.ConfigMigration` は、古いバージョンの設定を新しい形に変換する関数だ。

```go title="vendor/github.com/containerd/plugin/plugin.go"
	// ConfigMigration allows a plugin to migrate configurations from an older
	// version to handle plugin renames or moving of features from one plugin
	// to another in a later version.
```

containerd 2.0 で多くのプラグイン ID が変わったが (`io.containerd.grpc.v1.cri` → `io.containerd.cri.v1.*` など)、古い設定ファイルはそのまま動く。移行のロジックが **移行先のプラグイン自身** にあるので、コアに変換表を持つ必要がない。

## なぜそうなっているか

### 型で依存を宣言すると、実装の入れ替えが自由になる

ID で依存を書くと「overlayfs snapshotter に依存する」になってしまい、別の snapshotter に切り替えたときに壊れる。型で書けば「何らかの snapshotter に依存する」になり、実装は設定で決まる。

複数インスタンスを許す型 (snapshotter、runtime、sandbox controller) では、この緩さが必須だ。逆に 1 つしかない型 (metadata、gc) は `GetSingle` で厳格に取る。**依存の宣言は緩く、取得は用途に応じて** という 2 段構えになっている。

### 起動時に順序を確定させる利点

依存解決を実行時に遅延させる (lazy init) 設計もありうるが、containerd は起動時に順序を確定させる方式を採っている。

- **初期化の失敗が起動時にまとまって出る** — 動かしてから初めて分かる、が減る
- **依存の可視性が単純** — 「自分より前に初期化されたものしか見えない」という不変条件が保てる
- **循環依存が起動時に落ちる** — 実行時にデッドロックするより早く分かる

代償として、起動時間が全プラグインの初期化に引きずられる。containerd の起動が「速いとは言えない」のはこの構造の帰結でもある。

### panic を使い分ける

登録時と循環検出は `panic`、初期化の失敗は `error`。この使い分けの基準は明確だ。

- **プログラマの誤り** (ID が空、重複登録、循環依存) → panic。修正されるまで動くべきではない
- **環境の問題** (カーネルが対応していない、ディレクトリが作れない) → error。他のプラグインは動かす

ライブラリで panic を使うのは一般に避けられるが、「起動前に必ず露見し、修正以外の対応がない」誤りに限れば妥当な選択になる。

## どう活かすか

### 初期化順を実際に見る

containerd をデバッグログで起動すると、`loading plugin` のログが初期化順に並ぶ。

```sh
$ containerd --log-level debug 2>&1 | grep "loading plugin"
```

この順序が `Graph()` の出力そのものだ。「なぜ CRI プラグインがこんなに後ろなのか」といった疑問は、依存の型を追えば説明がつく (CRI は service プラグイン群に依存し、それらは metadata に依存し、metadata は content と snapshotter に依存する)。

### 使わないプラグインを止める

```toml
version = 3
disabled_plugins = [
  "io.containerd.grpc.v1.cri",        # Kubernetes を使わないノード
  "io.containerd.snapshotter.v1.zfs",
]
```

無効化すると、そのプラグインに依存していたものも道連れで失敗する場合がある。`required_plugins` と組み合わせて、想定通りの構成で起動しているかを検証するとよい。

### この依存解決を自分で書くなら

containerd の実装は 100 行に満たない。同じ性質を再現するときに押さえる点は 4 つある。

- **依存は型 (インターフェース) で宣言させ、実装 ID を書かせない**
- **無効化は「処理済み集合に先に入れる」で表現する** — 分岐を増やさない
- **順序は起動時に 1 回計算し、以降はリストとして扱う**
- **プログラマの誤りは即座に落とす** — 設定ミスと区別する

依存グラフを持つ仕組みは、実行時に解決を頑張るほど壊れたときの説明が難しくなる。**起動時に確定させて、あとは平坦なリスト** という形は、規模がプラグイン数十個くらいまでなら最も扱いやすい。
