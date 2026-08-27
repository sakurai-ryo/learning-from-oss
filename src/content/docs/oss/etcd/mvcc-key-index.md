---
title: "履歴を「世代の並び」として持つと、削除・復活・圧縮が同じ 1 つの構造で表せる"
description: "etcd の MVCC は、キーごとに「世代 (generation)」の並びを持つ。1 世代が「作られてから消されるまで」に対応し、削除は世代の終端を打って空の世代を足す操作になる。この形にしたことで、過去のリビジョンでの検索も、watch のための差分抽出も、圧縮も、同じ配列の走査に落ちる。"
sidebar:
  order: 6
---

## 何を学んだか

### どんな状況の話か

etcd のキーは「値」を持つのではなく、**リビジョン付きの版の列** を持つ ([前提のページ](../architecture/) を参照)。

```
put(foo, a) → rev 1
put(foo, b) → rev 2
delete(foo) → rev 3
put(foo, c) → rev 4
delete(foo) → rev 5
```

このあと `foo` に対して答えられなければいけない問いは、けっこう多い。

- **「rev 2 の時点で `foo` は何だったか」** → `b`
- **「rev 3 の時点で `foo` は何だったか」** → 存在しない
- **「rev 4 の時点の `foo` の `create_revision` は?」** → 4 (rev 1 ではない。一度消えているので作り直し)
- **「rev 4 の時点の `foo` の `version` は?」** → 1 (これも作り直しでリセット)
- **「rev 2 以降に `foo` に起きた変更を全部よこせ」** (watch の再開) → rev 2, 3, 4, 5
- **「rev 3 以前を圧縮しろ。ただし rev 3 時点で読める状態は保て」**

素朴に「リビジョンの配列」を持つと、`create_revision` と `version` の計算がやりにくい。削除の位置を毎回探して、そこからいくつ後ろか数えることになる。

### etcd の答え

**削除で区切る。** キーの履歴を、削除を境界とする「世代」の並びとして持つ。

[`server/storage/mvcc/key_index.go#L27-L77`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L27-L77) のコメントが、この構造をそのまま説明している。

```go title="server/storage/mvcc/key_index.go"
// keyIndex stores the revisions of a key in the backend.
// Each keyIndex has at least one key generation.
// Each generation might have several key versions.
// Tombstone on a key appends a tombstone version at the end
// of the current generation and creates a new empty generation.
//
// For example: put(1.0);put(2.0);tombstone(3.0);put(4.0);tombstone(5.0) on key "foo"
// generate a keyIndex:
// key:     "foo"
// modified: 5
// generations:
//
//	{empty}
//	{4.0, 5.0(t)}
//	{1.0, 2.0, 3.0(t)}
```

**このコメントが、この章で一番よく書けているコメントかもしれない。** 構造の定義と、具体例と、圧縮したときの変化が、全部この 1 つのコメントブロックに書いてある。

構造としてはこうなる。

1. **世代 = 「作られてから消されるまで」の 1 区間。** 世代の中には複数の版がある。
2. **削除は「今の世代の末尾にトンボストーンを足して、新しい空の世代を開く」。**
3. **末尾の世代が空なら、そのキーは今存在しない。**
4. **`create_revision` は世代の `created`、`version` は世代の中の通番。** どちらも「その世代の中で」数える。
5. **圧縮は、古い世代ごと落とす操作になる。** 世代の途中で切ることもある。
6. **すべての世代が消えたら、キーごと消す。**

そして、この `keyIndex` を **キーで引ける B-tree に載せたもの** が `treeIndex`。**bbolt の中身はリビジョンをキーにしているので、「キーから引く」経路はメモリ上のこの B-tree だけが担っている。**

## ソースコードのどこか

### 構造体は 3 フィールド

[`#L73-L77`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L73-L77) と [`#L346-L350`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L346-L350)。

```go title="server/storage/mvcc/key_index.go"
type keyIndex struct {
	key         []byte
	modified    Revision // the main rev of the last modification
	generations []generation
}

type generation struct {
	ver     int64
	created Revision // when the generation is created (put in first revision).
	revs    []Revision
}
```

**値がどこにも無い。** `keyIndex` はリビジョンしか持たない。実際の値は bbolt の中に、リビジョンをキーとして入っている。

つまり読み取りは 2 段になる。

1. **メモリの B-tree で、キー → 「読むべきリビジョン」を引く。**
2. **bbolt で、リビジョン → 値を引く。**

この分離のおかげで、**メモリに乗るのはキーとリビジョンだけ** で済む。値が 1 MB あってもインデックスは太らない。逆に、**キーの数だけはメモリを食う** ので、etcd では「キーが多い」ことが「データが大きい」ことより効いてくる。

### 書き込み

[`#L80-L103`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L80-L103)。

```go title="server/storage/mvcc/key_index.go"
func (ki *keyIndex) put(lg *zap.Logger, main int64, sub int64) {
	rev := Revision{Main: main, Sub: sub}

	if !rev.GreaterThan(ki.modified) {
		lg.Panic(
			"'put' with an unexpected smaller revision",
			// ...
		)
	}
	if len(ki.generations) == 0 {
		ki.generations = append(ki.generations, generation{})
	}
	g := &ki.generations[len(ki.generations)-1]
	if len(g.revs) == 0 { // create a new key
		keysGauge.Inc()
		g.created = rev
	}
	g.revs = append(g.revs, rev)
	g.ver++
	ki.modified = rev
}
```

**「リビジョンが後退したら panic」が最初に来ている。** 単調増加は etcd 全体の前提なので、破れたら続行しても意味がない。

`if len(g.revs) == 0` の分岐で `created` を記録するところが、世代モデルの効きどころだ。**空の世代に最初の書き込みが来たら、それが「作成」** になる。削除の後に足された空の世代でも、新規のキーでも、同じコードが通る。特別扱いがない。

削除 ([`#L131-L145`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L131-L145))。

```go title="server/storage/mvcc/key_index.go"
func (ki *keyIndex) tombstone(lg *zap.Logger, main int64, sub int64) error {
	if ki.isEmpty() {
		lg.Panic(/* ... */)
	}
	if ki.generations[len(ki.generations)-1].isEmpty() {
		return ErrRevisionNotFound
	}
	ki.put(lg, main, sub)
	ki.generations = append(ki.generations, generation{})
	keysGauge.Dec()
	return nil
}
```

**`put` を呼んでから、空の世代を足すだけ。** トンボストーンも普通の版として `revs` に入る。だから「消された」という事実も、リビジョン付きの履歴として残り、[watch](../watch-sync-victim/) から削除イベントとして見える。

すでに末尾の世代が空 (= もう存在しない) なら `ErrRevisionNotFound` を返す。**「存在しないキーの削除」の判定が、`isEmpty()` 1 回で済む。**

### 過去のリビジョンでの検索

[`#L147-L167`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L147-L167)。

```go title="server/storage/mvcc/key_index.go"
func (ki *keyIndex) get(lg *zap.Logger, atRev int64) (modified, created Revision, ver int64, err error) {
	// ...
	g := ki.findGeneration(atRev)
	if g.isEmpty() {
		return Revision{}, Revision{}, 0, ErrRevisionNotFound
	}

	n := g.walk(func(rev Revision) bool { return rev.Main > atRev })
	if n != -1 {
		return g.revs[n], g.created, g.ver - int64(len(g.revs)-n-1), nil
	}

	return Revision{}, Revision{}, 0, ErrRevisionNotFound
}
```

**2 段階。世代を選んで、その中で位置を探す。**

`findGeneration` は「そのリビジョンの時点でキーが属していた世代」を返す。**世代と世代の隙間 (削除されていた期間) に当たったら nil** を返すので、「その時点では存在しなかった」がそのまま表現される。

`version` の計算がこの構造の見返りだ。

```
g.ver - int64(len(g.revs)-n-1)
```

**世代の現在のバージョン数から、見つけた位置より後ろにある版の数を引く。** 削除の位置を探す必要も、先頭から数える必要もない。世代が「バージョン番号のリセット単位」と一致しているから成立する。

`walk` は後ろから走査する ([`#L354-L368`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L354-L368))。

```go title="server/storage/mvcc/key_index.go"
// walk walks through the revisions in the generation in descending order.
// It passes the revision to the given function.
// walk returns until: 1. it finishes walking all pairs 2. the function returns false.
// walk returns the position at where it stopped. If it stopped after
// finishing walking, -1 will be returned.
func (g *generation) walk(f func(rev Revision) bool) int {
```

**降順なのは、新しいリビジョンほど問い合わせが多いから。** 「最新を読む」が最頻のアクセスパターンで、それが最初の 1 回で当たる。

### watch のための差分抽出

[`#L169-L210`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L169-L210)。

```go title="server/storage/mvcc/key_index.go"
// since returns revisions since the given rev. Only the revision with the
// largest sub revision will be returned if multiple revisions have the same
// main revision.
func (ki *keyIndex) since(lg *zap.Logger, rev int64) []Revision {
```

**「同じ main リビジョンの中で複数回変更されたキーは、最後の 1 つだけ返す」** という仕様がコメントに書いてある。

`Txn` の中で同じキーを 2 回書くと、`Sub` だけ違う 2 つの版ができる。しかし **1 つの `Txn` は 1 つの原子的な変化** なので、外から見えるべきは最終状態だけだ。

実装がそれを直接表している。

```go title="server/storage/mvcc/key_index.go"
			if r.Main == last {
				// replace the revision with a new one that has higher sub value,
				// because the original one should not be seen by external
				revs[len(revs)-1] = r
				continue
			}
			revs = append(revs, r)
			last = r.Main
```

**追加ではなく置き換え。** 「外から見えてはいけない」という理由がコメントに書いてある。トランザクションの原子性が、この 4 行で watch に伝わっている。

### 圧縮は「切る位置を決める」だけ

[`#L212-L235`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L212-L235)。

```go title="server/storage/mvcc/key_index.go"
func (ki *keyIndex) compact(lg *zap.Logger, atRev int64, available map[Revision]struct{}) {
	// ...
	genIdx, revIndex := ki.doCompact(atRev, available)

	g := &ki.generations[genIdx]
	if !g.isEmpty() {
		// remove the previous contents.
		if revIndex != -1 {
			g.revs = g.revs[revIndex:]
		}
	}

	// remove the previous generations.
	ki.generations = ki.generations[genIdx:]
}
```

**スライスの再スライスが 2 回。** 世代の配列を途中から切り、その先頭の世代の中も途中から切る。世代という区切りがあるおかげで、圧縮が「2 次元の切り落とし」として書ける。

`available` という引数が重要で、これは **「圧縮後も残すべきリビジョンの集合」** を集めるための出力パラメータになっている。`doCompact` の中で埋められる ([`#L258-L282`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L258-L282))。

```go title="server/storage/mvcc/key_index.go"
	// walk until reaching the first revision smaller or equal to "atRev",
	// and add the revision to the available map
	f := func(rev Revision) bool {
		if rev.Main <= atRev {
			available[rev] = struct{}{}
			return false
		}
		return true
	}
```

**インデックス側の圧縮と、bbolt 側の削除が、この集合で繋がっている。** インデックスを先に圧縮して「残すリビジョンの集合」を作り、その後で bbolt を走査して集合に無いものを消す ([圧縮のページ](../compaction-batching/))。

「圧縮境界のリビジョンそのものは残す」ところが、`rev.Main <= atRev` で `false` を返して走査を止める形に表れている。**`compact(5)` した後も、rev 5 の時点の読み取りは成功しなければならない。**

### `compact` と `keep` の非対称

似た関数がもう 1 つある ([`#L237-L256`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/key_index.go#L237-L256))。

```go title="server/storage/mvcc/key_index.go"
// keep finds the revision to be kept if compact is called at given atRev.
func (ki *keyIndex) keep(atRev int64, available map[Revision]struct{}) {
	if ki.isEmpty() {
		return
	}

	genIdx, revIndex := ki.doCompact(atRev, available)
	g := &ki.generations[genIdx]
	if !g.isEmpty() {
		// If the given `atRev` is a tombstone, we need to skip it.
		//
		// Note that this s different from the `compact` function which
		// keeps tombstone in such case. We need to stay consistent with
		// existing versions, ensuring they always generate the same hash
		// values.
		if revIndex == len(g.revs)-1 && genIdx != len(ki.generations)-1 {
			delete(available, g.revs[revIndex])
		}
	}
}
```

`keep` は「実際に圧縮したら何が残るか」を計算するだけの関数で、[整合性チェック](../corruption-check/) のハッシュ計算に使われる。

そして、**`compact` と挙動がわざと違う**。境界がトンボストーンだった場合、`compact` はそれを残し、`keep` は残さないものとして数える。

コメントが理由を書いている。「既存のバージョンと一貫させ、常に同じハッシュ値を生成するため」。

つまり、**過去のバージョンの etcd が計算したハッシュと一致させるために、微妙に不正確な挙動をあえて維持している**。ハッシュはノード間の整合性検査に使われるので、**バージョンによって計算方法が変わると、正常なクラスタで不整合アラームが上がる**。「正しくすること」より「一致し続けること」が優先される場面だ。

### treeIndex は薄い

[`server/storage/mvcc/index.go#L39-L66`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/index.go#L39-L66)。

```go title="server/storage/mvcc/index.go"
type treeIndex struct {
	sync.RWMutex
	tree *btree.BTree[*keyIndex]
	lg   *zap.Logger
}

func newTreeIndex(lg *zap.Logger) index {
	return &treeIndex{
		tree: btree.New(32, func(aki *keyIndex, bki *keyIndex) bool {
			return aki.Less(bki)
		}),
		lg: lg,
	}
}

func (ti *treeIndex) Put(key []byte, rev Revision) {
	keyi := &keyIndex{key: key}

	ti.Lock()
	defer ti.Unlock()
	okeyi, ok := ti.tree.Get(keyi)
	if !ok {
		keyi.put(ti.lg, rev.Main, rev.Sub)
		ti.tree.ReplaceOrInsert(keyi)
		return
	}
	okeyi.put(ti.lg, rev.Main, rev.Sub)
}
```

**B-tree に入っているのは `*keyIndex` (ポインタ) なので、既存のキーへの追記は木の構造を変えない。** `okeyi.put(...)` はスライスへの append になるだけで、`ReplaceOrInsert` は呼ばれない。

木の再バランスが起きるのは「新しいキーの作成」と「キーの完全な消滅」のときだけ。**更新が多いワークロードでは、木はほとんど動かない。**

木の次数が 32 なのも、この使い方に合っている。ノードあたりの要素が多いと、キャッシュ効率がよく、深さが浅くなる。

### 書き込みパスから見た全体

`put` の実装が、2 段構造をそのまま表している ([`server/storage/mvcc/kvstore_txn.go#L223-L262`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/kvstore_txn.go#L223-L262))。

```go title="server/storage/mvcc/kvstore_txn.go"
	// if the key exists before, use its previous created and
	// get its previous leaseID
	_, created, ver, err := tw.s.kvindex.Get(key, rev)
	if err == nil {
		c = created.Main
		oldLease = tw.s.le.GetLease(lease.LeaseItem{Key: string(key)})
	}
	ibytes := NewRevBytes()
	idxRev := Revision{Main: rev, Sub: int64(len(tw.changes))}
	ibytes = RevToBytes(idxRev, ibytes)

	ver = ver + 1
	kv := &mvccpb.KeyValue{
		Key:            key,
		Value:          value,
		CreateRevision: c,
		ModRevision:    rev,
		Version:        ver,
		Lease:          int64(leaseID),
	}
	// ...
	tw.tx.UnsafeSeqPut(schema.Key, ibytes, d)
	tw.s.kvindex.Put(key, idxRev)
```

**`Sub` が `len(tw.changes)` で決まっている。** そのトランザクションの中で何番目の変更かが、そのまま `Sub` になる。カウンタを別に持つ必要がない。

`UnsafeSeqPut` の `Seq` は「順次書き込み」を意味する。リビジョンをビッグエンディアンでエンコードしているので、**bbolt から見ればキーは常に単調増加** になる。B+tree に単調増加のキーを入れると、常に右端のページに追記されることになり、ページ分割が最小限で済む ([backend のページ](../backend-batch-tx/) でこの前提が検証されているところを見る)。

そして、**bbolt に入るのは `KeyValue` を丸ごと protobuf にしたもの**。値だけでなく、キー・`create_revision`・`version`・lease まで入っている。リビジョンから引いただけで、クライアントに返す構造体が復元できる。

## なぜそうなっているか

- **世代で区切るのは、`create_revision` と `version` のリセット単位が「削除」だから。** 仕様として「削除したら作り直し扱い」と決まっている以上、その境界をデータ構造に持たせるのが素直だ。**仕様上の区切りと、データ構造上の区切りを一致させると、計算が引き算だけになる。**
- **末尾に空の世代を置くのは、「存在しない」を場合分けなしで表すため。** `nil` や別のフラグで表すと、すべての操作に分岐が増える。「空の世代がある = 今は存在しない」なら、`isEmpty()` の 1 回で判定できるし、次の `put` が自然に新世代の開始になる。
- **インデックスに値を持たないのは、メモリを値のサイズから切り離すため。** キー数がメモリを決め、値のサイズはディスクだけを決める。この分離があるから、「小さいキーが大量にある」と「大きい値が少しある」を別々に見積もれる。
- **`walk` が降順なのは、最新への問い合わせが最頻だから。** 履歴は追記されるので、新しいものほど配列の後ろにある。降順に走れば、最頻のケースが最短になる。
- **`since` が同一 main リビジョンを畳むのは、トランザクションの原子性を watch に伝えるため。** `Txn` の途中経過が外から見えると、「原子的」という保証が崩れる。**内部の表現には途中経過が必要だが、外に出すときに畳む** という切り分けになっている。
- **圧縮でインデックスと bbolt を「残すリビジョンの集合」で繋いだのは、2 つを別々に走査したいから。** インデックスの圧縮はメモリ上で速く終わるが、bbolt の削除は重い。集合を先に作っておけば、bbolt 側は自分のペースで小分けに進められる。
- **`keep` が `compact` とわざと違う挙動をするのは、ハッシュの後方互換のため。** 整合性検査のハッシュは、バージョンをまたいで一致しなければならない。**「正しい計算」に直すと、古いノードと新しいノードが混在するクラスタで偽のアラームが上がる。** 直すべきときは、バージョン交渉を伴う移行が要る。
- **B-tree にポインタを入れるのは、更新で木を触らないため。** 値そのものを入れると、更新のたびに `ReplaceOrInsert` が要る。ポインタなら、指す先を書き換えるだけで済む。
- **リビジョンをビッグエンディアンで bbolt のキーにするのは、単調増加を作るため。** B+tree は単調増加のキーに強い。**エンコード方法の選択が、そのままストレージエンジンの動作特性を決めている。**

## どう活かすか

- **履歴を持つデータ構造では、「何が値をリセットするか」を探して、その単位で区切る。** 削除・アーカイブ・世代交代など、通番がリセットされる境界があるなら、そこをデータ構造の区切りにする。位置の計算が走査から引き算になる。
- **「存在しない」を、専用のフラグではなく構造で表す。** 空の区間を置く、番兵を置く、といった形にできれば、判定と次の書き込みが同じコードで通る。分岐が減った分だけバグも減る。
- **インデックスと実体を分け、インデックスには位置だけを持たせる。** メモリの見積もりが「件数 × 固定サイズ」になり、データのサイズと独立する。容量計画が立てやすくなる。
- **走査の向きを、最頻のアクセスパターンに合わせる。** 追記される履歴を最新から見るなら降順。定数倍の話だが、最頻経路なら効く。
- **内部表現に必要な細かさと、外部に見せる粒度を分ける。** サブリビジョンのような内部の連番は、外に出すときに畳む。「内部では区別するが、外では 1 つ」という関係は、原子性やトランザクションを持つ設計で頻繁に出てくる。
- **重い削除は、「消すもの」ではなく「残すもの」の集合を先に作ってから始める。** 集合さえ確定していれば、実際の削除は分割して、中断・再開もできる。判断と実行を分けると、実行のスケジューリングが自由になる。
- **ハッシュや署名の計算方法は、正しさより互換性が優先されることがある。** バージョン混在のクラスタで値が一致しなくなると、正しい実装のほうが「壊れている」と判定される。変えるなら、バージョン交渉つきの移行が要る。そして **わざと直していない箇所には、その理由を書く。**
- **ツリーやマップには、更新頻度の高いオブジェクトのポインタを入れる。** 更新で構造を触らずに済み、再バランスやリハッシュが「作成と削除」のときだけになる。
- **永続化するキーのエンコードは、ストレージエンジンの得意な形に合わせる。** 単調増加のバイト列は B+tree の追記に最適化される。キーの設計は、インデックスの設計そのものになる。
