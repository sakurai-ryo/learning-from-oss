---
title: "削除はメタデータだけ先に済ませ、実体は後で消す"
description: "GC の sweep は bbolt のレコードを消すだけで、ディスク上の blob や snapshot は残る。実体の削除は GC のトランザクションが commit された後、非同期に始まる。バックエンドを全走査して「メタデータにないもの」を消す方式で、そのおかげで削除中にクラッシュしても不整合が残らない。"
group: "lease と GC"
sidebar:
  order: 24
---

## 何を学んだか

### 2 段階の削除

GC の流れを追うと、削除が 2 段階に分かれている。

1. **メタデータの削除** — bbolt の書き込みトランザクション内で、到達不能なレコードのバケットを消す
2. **実体の削除** — commit 後に非同期で、content store と snapshotter を掃除する

1 は速い (バケットの削除は B+tree の操作)。2 は遅い (数 GB のファイル削除、overlayfs のディレクトリ再帰削除)。**遅い方を DB のロックの外に出す** のが目的だ。

### 実体の掃除は「全走査して差分を消す」

バックエンドの掃除は、削除対象のリストを渡す方式ではない。

1. bbolt を読んで、生きているキーの集合 (`seen`) を作る
2. バックエンドを `Walk` して全エントリを列挙する
3. `seen` にないものを消す

**メタデータを正、バックエンドを従** とする片方向の同期だ。この方式には強い性質がある。

- 前回の掃除が途中で死んでも、次回に続きが行われる
- 削除リストを永続化する必要がない
- どんな理由で孤児になったものも回収される

### snapshot は木を辿って葉から消す

snapshot には親子関係があり、子がいる snapshot は消せない。掃除は木を構築して、**葉から順に** 消す。しかも「親が削除対象でも、子が生きていれば親は消せない」。

### バックエンドがさらに遅延削除する場合

snapshotter の中には、削除をさらに遅延させたいものがある (devmapper のように、デバイスの解放が重い場合など)。そのために `snapshots.Cleaner` という任意のインターフェースがあり、実装していれば掃除の最後に `Cleanup()` が呼ばれる。

## ソースコードのどこか

### GC の後半 — 非同期の掃除を起動する

[`core/metadata/db.go#L437-L490`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/db.go#L437-L490)。

```go title="core/metadata/db.go"
	if len(m.dirtySS) > 0 {
		var sl sync.Mutex
		stats.SnapshotD = map[string]time.Duration{}
		wg.Add(len(m.dirtySS))
		for snapshotterName := range m.dirtySS {
			log.G(ctx).WithField("snapshotter", snapshotterName).Debug("schedule snapshotter cleanup")
			go func(snapshotterName string) {
				st1 := time.Now()
				m.cleanupSnapshotter(ctx, snapshotterName)
				...
			}(snapshotterName)
		}
		m.dirtySS = map[string]struct{}{}
	}

	if m.dirtyCS {
		wg.Add(1)
		log.G(ctx).Debug("schedule content cleanup")
		go func() {
			ct1 := time.Now()
			m.cleanupContent(ctx)
			...
		}()
		m.dirtyCS = false
	}
```

sweep 中に記録された `dirtySS` (どの snapshotter で削除があったか) と `dirtyCS` を見て、**必要なバックエンドだけ** を掃除する。overlayfs で削除があったなら overlayfs だけを走査する。

goroutine で並列に起動し、最後に

```go title="core/metadata/db.go"
	stats.MetaD = time.Since(t1)
	m.wlock.Unlock()

	wg.Wait()
```

**`wlock` を解放してから待つ**。掃除の間、書き込みトランザクションは通る。GC の「停止時間」としてスケジューラに報告されるのは `MetaD` (メタデータ部分だけ) で、掃除の時間は別に計測される。

掃除の失敗は握り潰される ([`#L538-L553`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/db.go#L538-L553))。

```go title="core/metadata/db.go"
func (m *DB) cleanupSnapshotter(ctx context.Context, name string) (time.Duration, error) {
	ctx = context.WithoutCancel(ctx)
	sn, ok := m.ss[name]
	if !ok {
		return 0, nil
	}

	d, err := sn.garbageCollect(ctx)
	logger := log.G(ctx).WithField("snapshotter", name)
	if err != nil {
		logger.WithError(err).Warn("snapshot garbage collection failed")
```

`context.WithoutCancel` に注目したい。呼び出し元のコンテキストがキャンセルされても、**掃除は最後まで走る**。中途半端に止めるより、やり切ったほうが安全だという判断だ。

失敗は Warn ログのみ。メタデータの削除は既に確定しているので、実体が残っていても次回の掃除で回収される。

### snapshotter の掃除 — 生きているキーを集める

[`core/metadata/snapshot.go#L877-L935`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/snapshot.go#L877-L935)。

```go title="core/metadata/snapshot.go"
	seen := map[string]struct{}{}
	if err := s.db.View(func(tx *bolt.Tx) error {
		...
			if err := ssbkt.ForEach(func(sk, sv []byte) error {
				if sv == nil {
					bkey := ssbkt.Bucket(sk).Get(bucketKeyName)
					if len(bkey) > 0 {
						seen[string(bkey)] = struct{}{}
					}
				}
				return nil
			}); err != nil {
```

全 namespace を走査して、**バックエンドのキー** (`name` フィールド) を集める。メタデータ側のキーではなく、バックエンドが知っている名前で集合を作るのがポイントだ。

その後、バックエンドを走査して木を作る ([`#L963-L1000`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/snapshot.go#L963-L1000))。

```go title="core/metadata/snapshot.go"
func (s *snapshotter) walkTree(ctx context.Context, seen map[string]struct{}) ([]*treeNode, error) {
	roots := []*treeNode{}
	nodes := map[string]*treeNode{}

	if err := s.Snapshotter.Walk(ctx, func(ctx context.Context, info snapshots.Info) error {
		_, isSeen := seen[info.Name]
		node, ok := nodes[info.Name]
		if !ok {
			node = &treeNode{}
			nodes[info.Name] = node
		}

		node.remove = !isSeen
		node.info = info

		if info.Parent == "" {
			roots = append(roots, node)
		} else {
			parent, ok := nodes[info.Parent]
			if !ok {
				parent = &treeNode{}
				nodes[info.Parent] = parent
			}
			parent.children = append(parent.children, node)
		}
```

親が先に現れるとは限らないので、**未出現の親も仮ノードとして作っておく**。`Walk` の順序に依存しない構築になっている。

そして `pruneBranch` が葉から削除していく。

ロックの範囲についてコメントが残っている。

```go title="core/metadata/snapshot.go"
	// TODO: Unlock before removal (once nodes are fully unavailable).
	// This could be achieved through doing prune inside the lock
	// and having a cleanup method which actually performs the
	// deletions on the snapshotters which support it.
```

現状は削除の間も snapshotter のロックを保持している。改善案 (削除対象の確定だけロック内で行い、実際の削除は外) まで書かれているが未実装。**将来の設計方針をコードに残しておく** のは、この規模のプロジェクトでは有効な引き継ぎ方だ。

### さらに遅らせたいバックエンドのための Cleaner

```go title="core/metadata/snapshot.go"
	defer func() {
		s.l.Unlock()
		if err == nil {
			if c, ok := s.Snapshotter.(snapshots.Cleaner); ok {
				err = c.Cleanup(ctx)
				if errdefs.IsNotImplemented(err) {
					err = nil
				}
			}
		}
```

`snapshots.Cleaner` を実装している snapshotter だけ、掃除の最後に `Cleanup()` が呼ばれる。**インターフェースの有無で任意の拡張を表現する** Go のイディオムで、実装していない snapshotter は影響を受けない。

`ErrNotImplemented` を nil に潰しているのは、proxy plugin 経由の snapshotter がインターフェースは満たすが実装は持たない、という状況に対応するためだ。

### content の掃除も同じ形

[`core/metadata/content.go#L845-L900`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/content.go#L845-L900)。

```go title="core/metadata/content.go"
	contentSeen := map[string]struct{}{}
	ingestSeen := map[string]struct{}{}
	if err := cs.db.View(func(tx *bolt.Tx) error {
		...
			bbkt := cbkt.Bucket(bucketKeyObjectBlob)
			if bbkt != nil {
				if err := bbkt.ForEach(func(ck, cv []byte) error {
					if cv == nil {
						contentSeen[string(ck)] = struct{}{}
					}
					return nil
				}); err != nil {
```

blob と ingest の両方について、生きている集合を作り、バックエンドを走査して差分を消す。**同じパターンが 2 つの資源型で使われている**。

blob の場合、複数の namespace が同じ digest を持ちうるので、集合はキーの重複を吸収する。ある namespace から消えても、他が持っていればファイルは残る。

## なぜそうなっているか

### 遅い操作を DB のロックから追い出す

bbolt の書き込みトランザクションは 1 度に 1 つしか走らない。その中で `os.RemoveAll` を数百回呼べば、その間すべての書き込みが止まる。コンテナの起動も pull も待たされる。

メタデータの削除だけをトランザクションに入れ、実体の削除を外に出すことで、**停止時間がデータ量に依存しなくなる**。GC スケジューラが「2% しか止めない」を守れるのは、この分離があるからだ。

### 差分同期にするとクラッシュに強くなる

「削除対象のリストを作って順に消す」方式だと、途中でクラッシュしたときにリストが失われ、消し残しが永久に残る。リストを永続化すれば解決するが、今度はそのリスト自体の管理が必要になる。

全走査して差分を消す方式なら、**状態を持たない**。いつ死んでも、次回に同じ計算をやり直すだけだ。代償は走査コストで、snapshot が数千あればその分の `Walk` が必要になる。

この判断は「削除は稀で、走査は許容できる」という前提に立っている。GC が起動する条件を絞っている ([GC が DB を止める時間を、目標値から逆算する](../gc-scheduler/)) のは、この前提を維持するためでもある。

### メタデータを正とする

メタデータとバックエンドに食い違いがあれば、常に **バックエンド側を合わせる**。逆方向 (バックエンドにあるものをメタデータに復元する) は行わない。

一貫した向きを決めておくと、異常時の振る舞いが予測可能になる。

- メタデータにあってバックエンドにない → その資源を使おうとしたときにエラー (孤立したレコード)
- バックエンドにあってメタデータにない → 次の掃除で消える (孤立したファイル)

前者は起きにくい (メタデータの削除が先) ので、実質的には後者だけを考えればよくなる。

### キーに連番を含める理由がここで効く

[metadata が実装を包む](../metadata-wrapping/) で見たように、バックエンドのキーは `<namespace>/<連番>/<キー>` になっている。

削除の遅延と組み合わせると、この設計の意味が分かる。メタデータからキー `foo` を消した直後に、同じ名前 `foo` で新しい snapshot を作れる。バックエンドではまだ古い `k8s.io/41/foo` が残っているが、新しいものは `k8s.io/57/foo` になるので **衝突しない**。掃除が来れば古い方だけが消える。

連番がなければ、「削除中の名前を再利用できない」という制約が API に漏れていた。

## どう活かすか

### 掃除の遅れを観測する

メタデータ上は消えているのにディスクが空かない場合、掃除が失敗している可能性がある。

```sh
# 掃除失敗のログ
$ journalctl -u containerd | grep -E "garbage collection failed"

# メタデータ上の snapshot 数
$ ctr -n k8s.io snapshots ls | wc -l

# バックエンドのディレクトリ数
$ ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/ | wc -l
```

後者が前者より大幅に多ければ、孤児が溜まっている。GC を起こす (イメージを 1 つ `--sync` で消すなど) と掃除が走る。

### 「メタデータ先行 + 差分同期」を使う場面

外部のストレージ (S3、ファイルシステム、別サービス) と自前のメタデータを持つシステムでは、この形が扱いやすい。

- **削除は必ずメタデータから** — 実体が残ってもデータは見えなくなる
- **実体の削除は非同期に、全走査の差分で** — リストを永続化しない
- **同期の向きを 1 方向に固定する** — メタデータが正、実体は従
- **失敗はログに留めて次回に任せる** — 掃除の失敗で本流を止めない

避けるべきは「実体を先に消してメタデータを後で消す」順序だ。その間にクラッシュすると、メタデータ上は存在するのに実体がないという、利用者から見て最も分かりにくい状態が残る。
