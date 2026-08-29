---
title: "tri-color の mark & sweep を、bolt のトランザクションの中で回す"
description: "containerd の GC は教科書通りの三色マーキングだ。リースとコンテナとイメージをルートにして到達可能な集合を作り、それ以外を消す。読み取りトランザクションでマークし、書き込みトランザクションでスイープする。ノードの型は 5 ビットに収め、上位 3 ビットを「flat かどうか」などのフラグに使う。"
group: "lease と GC"
sidebar:
  order: 22
---

## 何を学んだか

### プログラミング言語の GC と同じ形

containerd の GC は、ランタイムの GC と同じ用語で書かれている。

- **ルート** — リース、コンテナ、イメージ、`gc.root` ラベルの付いたもの
- **マーク** — ルートから参照を辿り、到達可能なノードを集める
- **スイープ** — 到達できなかったものを消す

三色マーキングの実装は [`pkg/gc/gc.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/gc/gc.go) にあり、汎用のアルゴリズムとして containerd のデータモデルから独立している。

### ノードは 3 つ組

```go
type Node struct {
	Type      ResourceType
	Namespace string
	Key       string
}
```

「どの namespace の、どの種類の、どのキー」。content の blob も snapshot もコンテナも、この 1 つの型で表される。グラフのアルゴリズムは資源の種類を知らずに動く。

### 型は 5 ビット、上位 3 ビットはフラグ

`ResourceType` は `uint8` だが、実際に使えるのは下位 5 ビットだけと決められている。

```go
// ResourceMax represents the max resource.
// Upper bits are stripped out during the mark phase, allowing the upper 3 bits
// to be used by the caller reference function.
const ResourceMax = ResourceType(0x1F)
```

上位 3 ビットは呼び出し側が自由に使える。containerd は「flat なリースから参照されている」を表すのに使う。

```go
const (
	resourceContentFlat  = ResourceContent | 0x20
	resourceSnapshotFlat = ResourceSnapshot | 0x20
	resourceImageFlat    = ResourceImage | 0x20
)
```

マークの最後に上位ビットを削るので、**「flat 経由で到達した content」と「普通に到達した content」は同じノードとして記録される**。フラグは辿り方を変えるためだけに使われる。

### GC 中は書き込みだけ止める

マークとスイープの間にデータが変わると、到達可能なものを消してしまう。containerd は `wlock` (RWMutex) の **書き側** を GC が取ることで、書き込みトランザクションだけを止める。読み取りは動き続ける。

## ソースコードのどこか

### 三色マーキングの本体

[`pkg/gc/gc.go#L52-L100`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/gc/gc.go#L52-L100)。

```go title="pkg/gc/gc.go"
// Tricolor implements basic, single-thread tri-color GC. Given the roots, the
// complete set and a refs function, this function returns a map of all
// reachable objects.
//
// Correct usage requires that the caller not allow the arguments to change
// until the result is used to delete objects in the system.
//
// It will allocate memory proportional to the size of the reachable set.
//
// We can probably use this to inform a design for incremental GC by injecting
// callbacks to the set modification algorithms.
//
// https://en.wikipedia.org/wiki/Tracing_garbage_collection#Tri-color_marking
func Tricolor(roots []Node, refs func(ref Node) ([]Node, error)) (map[Node]struct{}, error) {
	var (
		grays     []Node                // maintain a gray "stack"
		seen      = map[Node]struct{}{} // or not "white", basically "seen"
		reachable = map[Node]struct{}{} // or "black", in tri-color parlance
	)
```

コメントに Wikipedia のリンクまで貼ってある。**アルゴリズムを発明せず、名前の付いたものをそのまま使う** 姿勢が出ている。

「引数が結果を使うまで変わらないこと」が正しい使用の条件として明記されていて、これが `wlock` の必要性の根拠になる。

灰色スタックの処理は素朴だ。

```go title="pkg/gc/gc.go"
	for len(grays) > 0 {
		// Pick any gray object
		id := grays[len(grays)-1] // effectively "depth first" because first element
		grays = grays[:len(grays)-1]
		rs, err := refs(id)
		...
		// mark all the referenced objects as gray
		for _, target := range rs {
			if _, ok := seen[target]; !ok {
				grays = append(grays, target)
				seen[target] = struct{}{}
			}
		}

		// strip bits above max resource type
		id.Type = id.Type & ResourceMax
		// mark as black when done
		reachable[id] = struct{}{}
	}
```

スタックの末尾から取るので実質的に深さ優先。`refs` 関数はコールバックで、**グラフの構造を知っているのは呼び出し側** だ。

並行版の `ConcurrentMark` もあり、ルートをチャネルで受け取って goroutine で辿る。

### ルートの走査

[`core/metadata/gc.go#L495-L610`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/gc.go#L495-L610) の `scanRoots` が、bbolt を舐めてルートを列挙する。

```go title="core/metadata/gc.go"
				if lblbkt := libkt.Bucket(bucketKeyObjectLabels); lblbkt != nil {
					if expV := lblbkt.Get(labelGCExpire); expV != nil {
						exp, err := time.Parse(time.RFC3339, string(expV))
						if err != nil {
							// label not used, log and continue to use lease
							log.G(ctx).WithError(err).WithField("lease", string(k)).Infof("ignoring invalid expiration value %q", string(expV))
						} else if expThreshold.After(exp) {
							// lease has expired, skip
							log.G(ctx).WithField("lease", string(k)).Debug("expired lease")
							return nil
						}
					}
```

期限切れのリースは **ルートとして列挙されない**。それだけで、そのリースが押さえていた資源が到達不能になり、次のスイープで消える。「期限切れリースを削除する処理」は別に存在しない。

不正な期限の値はエラーにせず、ログを出してリースを有効として扱う。**GC が壊れたデータで止まらない** ようにしている。GC が止まるとディスクが溢れるので、寛容な方向に倒すのは妥当だ。

リースが押さえる資源は、参照を辿らずに直接ルートとして出す。

```go title="core/metadata/gc.go"
				// Emit content and snapshots as roots instead of implementing
				// in references. Since leases cannot be referenced there is
				// no need to allow the lookup to be recursive, handling here
				// therefore reduces the number of database seeks.
```

リースは誰からも参照されないので、リース → 資源の辺を `references` で実装する必要がない。ルート列挙のついでに出せば **DB のシーク回数が減る**。

flat リースの扱いがここで型のビットに載る。

```go title="core/metadata/gc.go"
				ctype := ResourceContent
				if flat {
					ctype = resourceContentFlat
				}
```

`resourceContentFlat` として出されたノードは、参照を辿るときに「その先を見ない」と判定される。ノードの型にフラグを載せることで、**別のデータ構造を持たずに辿り方を変えている**。

### マークとスイープのトランザクション分離

[`core/metadata/db.go#L383-L435`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/db.go#L383-L435)。

```go title="core/metadata/db.go"
func (m *DB) GarbageCollect(ctx context.Context) (gc.Stats, error) {
	m.wlock.Lock()
	t1 := time.Now()
	c := startGCContext(ctx, m.collectors)

	marked, err := m.getMarked(ctx, c) // Pass in gc context
	...
	events := []namespacedEvent{}
	if err := m.db.Update(func(tx *bolt.Tx) error {
		...
		rm := func(ctx context.Context, n gc.Node) error {
			if _, ok := marked[n]; ok {
				return nil
			}

			switch n.Type {
			case ResourceSnapshot:
				if idx := strings.IndexRune(n.Key, '/'); idx > 0 {
					m.dirtySS[n.Key[:idx]] = struct{}{}
				}
				// queue event to publish after successful commit
			case ResourceContent, ResourceIngest:
				m.dirtyCS = true
			}

			event, err := c.remove(ctx, tx, n)
```

マークは `m.db.View` (読み取りトランザクション)、スイープは `m.db.Update` (書き込み) と分かれている。マークの間は他の読み取りも動ける。

スイープで消したものの種類を記録して、`dirtySS` / `dirtyCS` に印を付ける。この印が、後段の **バックエンドの掃除** を起動する ([削除はメタデータだけ先に済ませ、実体は後で消す](../deferred-cleanup/))。

イベントはトランザクションの中で貯めておき、commit 後にまとめて発行する。

### マークの入口

[`core/metadata/db.go#L492-L536`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/db.go#L492-L536)。

```go title="core/metadata/db.go"
		refs := func(n gc.Node) ([]gc.Node, error) {
			var sn []gc.Node
			if err := c.references(ctx, tx, n, func(nn gc.Node) {
				sn = append(sn, nn)
			}); err != nil {
				return nil, err
			}
			return sn, nil
		}

		reachable, err := gc.Tricolor(nodes, refs)
```

`Tricolor` に渡すのは、ルートのリストと `refs` 関数だけ。**アルゴリズムとデータモデルの接点がこの 1 関数** に絞られている。テストもこの形で書きやすい。

## なぜそうなっているか

### 到達可能性は「クライアントが宣言した関係」の上で計算される

GC が辿るグラフは、[GC ラベル](../gc-labels/) と、資源型ごとの自然な関係 (snapshot の parent、container の snapshotKey) の合成だ。containerd 自身は「なぜこの参照があるか」を知らない。

このため GC は極めて汎用で、OCI Artifacts でも独自のデータでも同じように動く。

### 単一ホストだから stop-the-world でよい

マーク中に変更を許す incremental GC も考えられるが、実装が格段に複雑になる。containerd は単一ホストで、GC の所要時間は通常ミリ秒〜数百ミリ秒なので、**書き込みを止めて一気に処理する** ほうが合理的だ。

コメントには「incremental GC の設計に使えるかもしれない」と将来の含みが書かれているが、現状は単純な方が選ばれている。止める時間をどう抑えるかは [GC スケジューラ](../gc-scheduler/) 側の問題として切り出されている。

### 型にフラグを載せる工夫

`flat` を表現するのに、別のマップや構造体のフィールドを増やすこともできた。型の上位ビットを使うことで、

- `Node` が比較可能な値型のまま保てる (map のキーにできる)
- グラフのアルゴリズムに手を入れなくてよい
- マークの最後にビットを落とせば、結果は 1 種類のノードに正規化される

という利点がある。ビット演算による技巧だが、`ResourceMax` の定義とコメントで意図が明示されている。

## どう活かすか

### GC を手で走らせる

```sh
# 明示的に GC を起動する (ctr にコマンドはないので、削除の同期オプションを使う)
$ ctr -n k8s.io images rm --sync <image>

# GC のメトリクス (Prometheus)
$ curl -s localhost:1338/v1/metrics | grep containerd_gc
```

`containerd_gc_pause_seconds` と `containerd_gc_collections_total` で、GC の頻度と所要時間が分かる。GC が数秒かかっている場合、イメージや snapshot が非常に多いか、バックエンドの掃除が遅い。

### 「参照を辿る GC」を自作するときの構造

containerd の分け方は、そのまま再利用できる形になっている。

- **グラフのアルゴリズムをデータモデルから切り離す** — `Node` と `refs` 関数だけに依存させる
- **ルート列挙と参照解決を別の関数にする** — ルートは「消してはいけない起点」、参照は「辺」
- **マークは読み取り、スイープは書き込み** — ロックの粒度を変えられる
- **期限切れは「ルートに出さない」で表現する** — 削除処理を別に書かない

4 番目は特に効く。期限切れオブジェクトを消す処理を書くと、その処理自体の失敗やタイミングを考える必要が出る。「ルートから外す」だけなら、既存の GC がそのまま回収してくれる。
