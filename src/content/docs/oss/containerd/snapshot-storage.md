---
title: "snapshotter 共通のメタデータを、1 つのパッケージに切り出す"
description: "overlayfs も native も devmapper も、それぞれの root に metadata.db という bbolt ファイルを持ち、同じ storage パッケージを使う。キーから整数 ID への対応、親の連鎖、状態の検査がここにまとまっているので、snapshotter の実装はファイルシステム操作だけを書けばよくなる。"
group: "ファイルシステムを積む"
sidebar:
  order: 35
---

## 何を学んだか

### 各 snapshotter が自分の DB を持つ

```
/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/
├── metadata.db          ← storage パッケージが管理する bbolt
└── snapshots/
    ├── 1/
    │   ├── fs/          ← 実体 (upperdir)
    │   └── work/
    ├── 2/
    └── ...
```

containerd 本体の `meta.db` とは **別のファイル** だ。snapshotter は自分のメタデータを自分で持つ。

このおかげで、snapshotter を proxy plugin として別プロセスで動かしても、同じコードが使える。

### キーは整数 ID に変換される

storage パッケージは、`k8s.io/42/mycontainer` のようなキーに **連番の整数 ID** を割り当てる。ディスク上のディレクトリ名はこの ID になる。

なぜか。キーは任意の文字列で、長さもファイル名に使えない文字も制御できない。整数なら安全で短い。

### ParentIDs は「上から下」の順

`GetSnapshot` が返す `Snapshot.ParentIDs` は、親の連鎖を辿った ID の列だ。順序が明確に定義されている。

```go
// The ParentIDs are ordered from the highest to the
// lowest base, meaning they should be applied in order from the last index to
// the first index. The first index should always be considered the active
// snapshot's immediate parent.
```

先頭が直接の親、末尾が最下層。overlayfs の `lowerdir=` は「左が上位」なので、**この順序でそのまま連結できる** ([overlayfs snapshotter を読む](../overlayfs-snapshotter/))。

### トランザクションは context で運ぶ

```go
ctx, trans, err := ms.TransactionContext(ctx, writable)
```

bolt のトランザクションを `context.Context` に載せる。storage パッケージの各関数 (`GetSnapshot`、`CreateSnapshot`) は引数に `tx` を取らず、context から取り出す。

## ソースコードのどこか

### パッケージの位置付け

[`core/snapshots/storage/metastore.go#L17-L26`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/snapshots/storage/metastore.go#L17-L26)。

```go title="core/snapshots/storage/metastore.go"
// Package storage provides a metadata storage implementation for snapshot
// drivers. Drive implementations are responsible for starting and managing
// transactions using the defined context creator. This storage package uses
// BoltDB for storing metadata. Access to the raw boltdb transaction is not
// provided, but the stored object is provided by the proto subpackage.
package storage
```

「生の boltdb トランザクションは公開しない」。**実装者が DB を直接触れないようにして、スキーマの一貫性を守っている**。

`MetaStore` の doc も方針を述べる。

```go title="core/snapshots/storage/metastore.go"
// MetaStore is used to store metadata related to a snapshot driver. The
// MetaStore is intended to store metadata related to name, state and
// parentage. Using the MetaStore is not required to implement a snapshot
// driver but can be used to handle the persistence and transactional
// complexities of a driver implementation.
```

**必須ではない**。使わずに実装してもよいが、使えば永続化とトランザクションの複雑さを引き受けてくれる。強制ではなく提供、という姿勢だ。

### トランザクションのラッパ

[`core/snapshots/storage/metastore.go#L128-L165`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/snapshots/storage/metastore.go#L128-L165)。

```go title="core/snapshots/storage/metastore.go"
// WithTransaction is a convenience method to run a function `fn` while holding a meta store transaction.
// If the callback `fn` returns an error or the transaction is not writable, the database transaction will be discarded.
func (ms *MetaStore) WithTransaction(ctx context.Context, writable bool, fn TransactionCallback) error {
	ctx, trans, err := ms.TransactionContext(ctx, writable)
	...
	// Always rollback if transaction is not writable
	if err != nil || !writable {
		if terr := trans.Rollback(); terr != nil {
			log.G(ctx).WithError(terr).Error("failed to rollback transaction")

			result = append(result, fmt.Errorf("rollback failed: %w", terr))
		}
	} else {
		if terr := trans.Commit(); terr != nil {
```

読み取りトランザクションは **常に Rollback**。bolt の読み取りトランザクションは Commit できないので、これが正しい終わり方になる。

エラーは `errors.Join` で束ねる。「本体のエラー」と「ロールバックのエラー」の両方を失わない。

### DB の遅延オープン

```go title="core/snapshots/storage/metastore.go"
func (ms *MetaStore) TransactionContext(ctx context.Context, writable bool) (context.Context, Transactor, error) {
	ms.dbL.Lock()
	if ms.db == nil {
		db, err := bolt.Open(ms.dbfile, 0600, &ms.opts)
		if err != nil {
			ms.dbL.Unlock()
			return ctx, nil, fmt.Errorf("failed to open database file: %w", err)
		}
		ms.db = db
	}
	ms.dbL.Unlock()
```

最初のトランザクションまで DB ファイルを開かない。**使われない snapshotter がファイルを作らない**。zfs や devmapper のプラグインが登録だけされて使われない環境で、無駄なファイルが増えない。

`Close` で DB を閉じ、`ms.db = nil` に戻すので、閉じた後にまた使える。

### 親の連鎖

[`core/snapshots/storage/metastore.go#L53-L64`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/snapshots/storage/metastore.go#L53-L64)。

```go title="core/snapshots/storage/metastore.go"
// Snapshot hold the metadata for an active or view snapshot transaction. The
// ParentIDs hold the snapshot identifiers for the committed snapshots this
// active or view is based on. The ParentIDs are ordered from the highest to the
// lowest base, meaning they should be applied in order from the last index to
// the first index. The first index should always be considered the active
// snapshot's immediate parent.
type Snapshot struct {
	Kind      snapshots.Kind
	ID        string
	ParentIDs []string
}
```

**順序の定義が doc に明記されている**。この順序を間違えると、レイヤの重なりが逆になってファイルの内容が変わる。実装者が最も間違えやすい部分なので、型のコメントで固定している。

`Snapshot` 構造体が持つのは 3 つだけ。名前もラベルも入っていない。マウントを組み立てるのに必要な最小限だ。

### 親子関係の格納方法

[`core/snapshots/storage/bolt.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/snapshots/storage/bolt.go) の削除処理で見た通り、親子関係は専用バケットに「親 ID を先頭に持つキー」として入る。

```go title="core/snapshots/storage/bolt.go"
		if pbkt != nil {
			k, _ := pbkt.Cursor().Seek(parentPrefixKey(id))
			if getParentPrefix(k) == id {
				return fmt.Errorf("cannot remove snapshot with child: %w", errdefs.ErrFailedPrecondition)
			}
```

子のリストを配列として持つと、追加・削除のたびに読み書きが必要になる。**キーのプレフィックスで表現すれば、B+tree の順序がそのままインデックスになる**。

## なぜそうなっているか

### 実装者に書かせる量を減らす

snapshotter を実装するときに書くべきコードは、storage パッケージを使えば次だけになる。

```go
func (o *snapshotter) Prepare(ctx, key, parent string, opts ...) ([]mount.Mount, error) {
	// 1. トランザクションを開く
	// 2. storage.CreateSnapshot で ID を得る
	// 3. その ID でディレクトリを作る
	// 4. マウント情報を組み立てて返す
}
```

キーの一意性、状態の検査、親の連鎖、ID の採番はすべて storage が担当する。**ファイルシステム固有の処理だけを書けばよい**。

overlayfs の実装が 700 行程度で収まっているのは、この分業のおかげだ。

### メタデータを snapshotter ごとに分ける

containerd 本体の `meta.db` にまとめることもできた。分けた理由は 2 つある。

- **proxy plugin として外部プロセスで動かせる** — stargz snapshotter は別プロセスで動き、自分の DB を持つ
- **障害の分離** — ある snapshotter の DB が壊れても、他の snapshotter と containerd 本体は動く

代償として、containerd 本体のメタデータと snapshotter のメタデータで **二重管理** になる。この不整合を掃除するのが GC の後段の処理だ ([削除はメタデータだけ先に済ませ、実体は後で消す](../deferred-cleanup/))。

### 整数 ID に変換する

キーをそのままディレクトリ名にすると、

- ファイルシステムの命名規則 (長さ、使えない文字) に引っかかる
- パス長の上限に当たる
- ディレクトリトラバーサルの危険がある

整数 ID なら全部回避できる。しかも短いので、`lowerdir=` の option 文字列が短くなり、mount data のページサイズ制限に余裕ができる ([レイヤと overlayfs](../layers-and-overlayfs/))。

### トランザクションを context で運ぶ

引数に `tx` を並べる代わりに context に載せることで、storage パッケージの関数シグネチャが揃う。呼び出し側は `WithTransaction` の中で複数の操作を書ける。

一方で、**トランザクションの外で呼ぶとパニックまたはエラーになる** という暗黙の前提が生まれる。containerd はこれを、公開関数を storage パッケージの中に限定することで管理している ([1 つのデーモンを namespace で分ける](../namespaces/) の namespace と同じ、context 運搬の是非がここにもある)。

## どう活かすか

### snapshotter の DB を覗く

```sh
# containerd を止めてから
$ bbolt buckets /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/metadata.db

# ディスク上の実体との対応
$ ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/
```

`snapshots/` 配下のディレクトリ名が整数 ID。どのキーに対応するかは `ctr snapshots info <key>` の出力か、DB を読むと分かる。

孤児 (メタデータにないディレクトリ) がある場合、GC の掃除が失敗している可能性がある。

### 「共通部分をライブラリとして提供する」

複数の実装を持つインターフェースを設計するときの型として、containerd の storage パッケージは参考になる。

- **使うかどうかは実装者に任せる** — 必須にしない
- **共通の不変条件をライブラリ側で検査する** — 実装ごとにばらつかせない
- **生の下位リソース (DB トランザクション) は公開しない** — スキーマを守る
- **間違えやすい部分は型のコメントで固定する** — ParentIDs の順序のような
- **最小限のデータだけ返す** — 実装が必要としないものを渡さない

2 番目と 3 番目はセットになる。検査を提供しても、抜け道 (生の DB アクセス) があれば意味がない。
