---
title: "metadata が実装を包んで、namespace とトランザクションを足す"
description: "overlayfs snapshotter は namespace を知らないし、ローカルの content store もリースを知らない。それらを包んで、キーに namespace を混ぜ、bbolt のトランザクションと同じ境界で更新し、GC の記録を残すのが metadata パッケージだ。バックエンドは単純なまま、上位の要件を満たす。"
group: "メタデータとストア"
sidebar:
  order: 19
---

## 何を学んだか

### バックエンドは何も知らなくてよい

overlayfs snapshotter の実装 (`plugins/snapshots/overlay/`) には、namespace もリースも GC も出てこない。`Prepare(key, parent)` を受け取り、ディレクトリを作り、マウント情報を返すだけだ。

その周りを包んでいるのが `core/metadata/` の `snapshotter` と `contentStore` で、次の 4 つを足している。

1. **namespace** — 上位のキーを `<namespace>/<連番>/<キー>` に変換してバックエンドに渡す
2. **トランザクション** — メタデータの更新とバックエンドの操作を、bbolt のトランザクションと組み合わせる
3. **リースと GC の記録** — 作った資源を現在のリースに追加し、dirty フラグを立てる
4. **イベント発行** — `/snapshot/prepare` などのイベントを流す

### キーは書き換えられてバックエンドに渡る

クライアントが `Prepare("mycontainer", parent)` と呼ぶと、バックエンドが受け取るのは `k8s.io/42/mycontainer` のような文字列になる。

```go
func createKey(id uint64, namespace, key string) string {
	return fmt.Sprintf("%s/%d/%s", namespace, id, key)
}
```

namespace とバケットの連番が前置される。これにより、

- 別 namespace の同名 snapshot が衝突しない
- 同じ名前を削除して再作成しても、**連番が変わるのでバックエンド側では別物** になる

2 つ目が効いてくる。バックエンドが削除を遅延している間に同名で作り直しても、名前が重ならない ([削除はメタデータだけ先に済ませ、実体は後で消す](../deferred-cleanup/))。

### 「既にある」も参照として扱う

`Prepare` が `ErrAlreadyExists` を返す場合でも、その snapshot を **現在のリースに追加してから** エラーを返す。エラーだからといって何もせずに戻ると、直後の GC で消されうるからだ。

同じ考え方が content store の `Writer` にもある ([ingest: 中断しても続きから書ける書き込み](../content-ingest/))。

### イベントはトランザクションの外でだけ発行する

`Publisher(ctx)` は、コンテキストがトランザクションの中なら **nil を返す**。トランザクション内でのイベント発行を、仕組みとして禁止している。

## ソースコードのどこか

### キー変換

[`core/metadata/snapshot.go#L76-L94`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/snapshot.go#L76-L94)。

```go title="core/metadata/snapshot.go"
func createKey(id uint64, namespace, key string) string {
	return fmt.Sprintf("%s/%d/%s", namespace, id, key)
}

func getKey(tx *bolt.Tx, ns, name, key string) string {
	bkt := getSnapshotterBucket(tx, ns, name)
	if bkt == nil {
		return ""
	}
	bkt = bkt.Bucket([]byte(key))
	if bkt == nil {
		return ""
	}
	v := bkt.Get(bucketKeyName)
	if len(v) == 0 {
		return ""
	}
	return string(v)
}
```

対応表は bbolt の `name` フィールドに持つ。上位のキーからバックエンドのキーを引くのは、バケットを 2 つ降りて 1 つ読むだけだ。

### createSnapshot の流れ

[`core/metadata/snapshot.go#L312-L400`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/snapshot.go#L312-L400)。

```go title="core/metadata/snapshot.go"
	if err := update(ctx, s.db, func(tx *bolt.Tx) error {
		bkt, err := createSnapshotterBucket(tx, ns, s.name)
		...
		// Check if target exists, if so, return already exists
		if target != "" {
			if tbkt := bkt.Bucket([]byte(target)); tbkt != nil {
				rerr = fmt.Errorf("target snapshot %q: %w", target, errdefs.ErrAlreadyExists)
				if err := addSnapshotLease(ctx, tx, s.name, target); err != nil {
					return err
				}
				return nil
			}
		}
		...
		sid, err := bkt.NextSequence()
		if err != nil {
			return err
		}
		bkey = createKey(sid, ns, key)

		return err
	}); err != nil {
		return nil, err
	}
	// Already exists and lease successfully added in transaction
	if rerr != nil {
		return nil, rerr
	}
```

`rerr` という変数でエラーをトランザクションの外に持ち出しているのが要点だ。トランザクション関数から直接エラーを返すとロールバックされ、**せっかく足したリースが消える**。だから「成功として commit し、外でエラーを返す」形にしている。

コメント `// Already exists and lease successfully added in transaction` がその意図を説明している。

トランザクションを抜けてからバックエンドを呼ぶ。

```go title="core/metadata/snapshot.go"
	if readonly {
		m, err = s.Snapshotter.View(ctx, bkey, bparent, bopts...)
	} else {
		m, err = s.Snapshotter.Prepare(ctx, bkey, bparent, bopts...)
	}
```

**ディスク操作を伴う処理は、トランザクションの中で行わない**。bbolt の書き込みトランザクションは 1 つしか走れないので、その中で数百 ms かかる操作をすると全体が詰まる。

### 例外的にトランザクション内で呼ぶ場合

`Update` (ラベルの更新) だけは中で呼ぶ ([`core/metadata/snapshot.go#L235-L245`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/snapshot.go#L235-L245))。

```go title="core/metadata/snapshot.go"
		// NOTE: Perform this inside the transaction to reduce the
		// chances of out of sync data. The backend snapshotters
		// should perform the Update as fast as possible.
		if info, err = s.Snapshotter.Update(ctx, inner, fieldpaths...); err != nil {
			return err
		}
```

「メタデータとバックエンドがずれる可能性を減らすため中で行う。snapshotter 側は速く終わらせること」。原則を破る場所に、破る理由と前提条件が書いてある。

### ラベルの継承

```go title="core/metadata/snapshot.go"
		bopts  = []snapshots.Opt{
			snapshots.WithLabels(snapshots.FilterInheritedLabels(base.Labels)),
		}
```

上位で付けられたラベルのうち、**バックエンドに渡してよいものだけ** を選別する。`containerd.io/snapshot/` で始まるラベルは snapshotter 向け、`containerd.io/gc.` で始まるラベルは GC 向けで metadata 層に留まる。

これによって、remote snapshotter に必要な情報 (イメージ参照、layer digest) は下まで届き、GC の内部事情は漏れない ([remote snapshotter](../remote-snapshotter/))。

### 書き込みトランザクションのラッパ

[`core/metadata/db.go#L267-L284`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/db.go#L267-L284)。

```go title="core/metadata/db.go"
// Update runs a writable transaction on the metadata store.
func (m *DB) Update(fn func(*bolt.Tx) error) error {
	m.wlock.RLock()
	defer m.wlock.RUnlock()
	err := m.db.Update(fn)
	if err == nil {
		dirty := m.dirty.Load() > 0
		for _, fn := range m.mutationCallbacks {
			fn(dirty)
		}
	}

	return err
}
```

3 つのことをしている。

1. `wlock` の **読み側** を取る。GC が走るときは書き側を取るので、GC 中は書き込みが待たされる
2. bbolt のトランザクションを実行する
3. 成功したら mutation コールバックを呼ぶ。GC スケジューラがこれを購読していて、変更の回数と dirty の有無から次回の GC を決める

「更新のたびに GC スケジューラへ通知する」という配線が、この 4 行に収まっている。

### イベント発行の禁止をコードで表す

[`core/metadata/db.go#L286-L296`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/db.go#L286-L296)。

```go title="core/metadata/db.go"
// Publisher returns an event publisher if one is configured
// and the current context is not inside a transaction.
func (m *DB) Publisher(ctx context.Context) events.Publisher {
	_, ok := boltutil.Transaction(ctx)
	if ok {
		// Do no publish events within a transaction
		return nil
	}
```

呼び出し側は `if publisher := s.db.Publisher(ctx); publisher != nil` と書くので、トランザクション内では自然に発行がスキップされる。**規約をコードで表現する** ことで、レビューでの見落としを防いでいる。

### スキーマのマイグレーション

[`core/metadata/db.go#L156-L200`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/db.go#L156-L200)。

```go title="core/metadata/db.go"
func (m *DB) Init(ctx context.Context) error {
	// errSkip is used when no migration or version needs to be written
	// to the database and the transaction can be immediately rolled
	// back rather than performing a much slower and unnecessary commit.
	var errSkip = errors.New("skip update")
	...
		// i represents the index of the first migration
		// which must be run to get the database up to date.
		// The migration's version will be checked in reverse
		// order, decrementing i for each migration which
		// represents a version newer than the current
		// database version
		i := len(migrations)
```

マイグレーションのリストを **後ろから** 見て、実行すべき最初のものを見つける。既に最新なら `errSkip` を返してトランザクションをロールバックする。commit よりロールバックのほうが速いから、という理由が書かれている。

起動のたびに走る処理なので、「何もしなくてよい場合」を最速にしている。

## なぜそうなっているか

### バックエンドを単純に保つと、実装を書きやすくなる

snapshotter を新しく書く人が、namespace、リース、GC、イベントまで実装しなければならないとしたら、参入障壁が高すぎる。`Prepare` / `View` / `Commit` / `Mounts` / `Remove` / `Stat` / `Update` / `Walk` の 8 つだけを実装すればよい形にしておけば、stargz や nydus のような外部実装が現実的になる。

proxy plugin 経由の外部 snapshotter でも同じインターフェースなので、metadata 層は「ローカルかリモートか」を区別しない ([proxy plugin](../proxy-plugins/))。

### デコレータで横断的関心事を差し込む

namespace の付与、リースの記録、イベント発行は、すべての資源型に共通する **横断的関心事** だ。各バックエンドに実装させると重複するし、実装ごとに差が出る。

包む側 1 か所に集めることで、

- 挙動が資源型をまたいで一貫する
- 新しい横断的関心事 (トレーシング、メトリクス) を足すのが 1 か所で済む
- バックエンドの実装差が上位に漏れない

という利点が得られる。

### トランザクション境界を明示的に扱う

「トランザクションの中で外部 I/O をしない」「トランザクションの中でイベントを出さない」は、DB を使うシステムで繰り返し問題になる論点だ。containerd はこれを 3 つの方法で扱っている。

- **原則をコメントで書く** — 破る場所には理由も書く
- **仕組みで防ぐ** — `Publisher(ctx)` が nil を返す
- **エラーの持ち出し** — `rerr` パターンで「commit させたいがエラーを返す」を表現する

3 番目は一般には読みにくい書き方だが、副作用 (リースの追加) を確定させる必要があるときには必要になる。

## どう活かすか

### バックエンドのキーを直接見る

snapshot のトラブルを調べるとき、上位のキーとバックエンドのキーの対応が要る。

```sh
# 上位から見た snapshot
$ ctr -n k8s.io snapshots ls

# バックエンド側のディレクトリ (名前は連番)
$ ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/
```

バックエンドのディレクトリ名は数値の ID で、metadata の `name` フィールド (`k8s.io/42/...`) からさらに変換されている。対応を追うには bbolt を読むか、`ctr snapshots info <key>` を使う。

### 「包んで足す」を設計に使う

ストレージ抽象を作るとき、次の 2 層に分けると綺麗に収まる。

- **バックエンド層** — 単一の関心事だけを実装する。マルチテナンシも寿命管理も知らない
- **管理層** — キーの名前空間化、寿命管理、イベント、トランザクション

この分け方の判断基準は「**バックエンドを他人が実装するとしたら、何を知らずに済ませたいか**」だ。知らなくてよいことが多いほど、実装が増える。

containerd の場合、その答えは「namespace と GC」だった。結果として、snapshotter の実装が 10 種類以上生まれている。
