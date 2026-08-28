---
title: "不変ビューをコード生成で作る"
description: "netmap を共有しながら誰にも書き換えさせないために、読み取り専用のラッパー型を生成する。内部フィールドの名前はキリル文字の ж で、「タイプしにくい、ポインタのように尖って見える」ことが選定理由だ。深い比較には reflect ベースのハッシュを使い、再帰の検出はポインタのスタックで行う。"
group: "実装の作法"
sidebar:
  order: 43
---

## 何を学んだか

### 共有と不変性

[netmap](../netmap/) は「世界の現在の状態」で、多くの場所から読まれる。そして **差分更新のたびに全部をコピーするのは高くつく**。

だから **前の値と共有する**。だが共有すると、誰かが書き換えたときに他が壊れる。

Go には `const` 参照も readonly 修飾もない。**「読み取り専用の構造体」を型で表現する方法がない。**

そこで **読み取り専用のラッパー型を、コード生成で作る**。

```go
type NodeView struct {
	ж *Node  // キリル文字の ж
}

func (v NodeView) Valid() bool { return v.ж != nil }
func (v NodeView) ID() NodeID { return v.ж.ID }
func (v NodeView) Addresses() views.Slice[netip.Prefix] { ... }
```

**フィールドが非公開なので、パッケージの外からは書き換えられない。** アクセサはすべて値を返すか、さらにビューを返す。

### 内部フィールドの名前が ж

キリル文字の「ジェー」。理由がテンプレートのコメントに書かれている。

> **タイプしにくい文字で、ポインタのように尖って見える。呼び出し側に漏らすことがいかに危険かを意識させるために、目立つ名前にしてある。**

### 3 つの生成ツール

| ツール       | 生成するもの                     |
| ------------ | -------------------------------- |
| `cmd/viewer` | `View()` メソッドと `XxxView` 型 |
| `cmd/cloner` | `Clone()` メソッド (深いコピー)  |
| `cmd/vet`    | 独自の静的検査                   |

`//go:generate` の指示が **25 箇所** ある。

### 深い比較はハッシュで

「この設定は前回と同じか」を判定するのに、`reflect.DeepEqual` ではなく **`deephash` でハッシュを取って比較する**。

## ソースコードのどこか

### ビューの生成テンプレート

```go title="cmd/viewer/viewer.go"
// Viewer is a tool to automate the creation of "view" wrapper types that
// provide read-only accessor methods to underlying fields.
package main

const viewTemplateStr = `{{define "common"}}
// View returns a read-only view of {{.StructName}}.
func (p *{{.StructName}}{{.TypeParamNames}}) View() {{.ViewName}}{{.TypeParamNames}} {
	return {{.ViewName}}{{.TypeParamNames}}{ж: p}
}

// {{.ViewName}}{{.TypeParamNames}} provides a read-only view over {{.StructName}}{{.TypeParamNames}}.
//
// Its methods should only be called if ` + "`Valid()`" + ` returns true.
type {{.ViewName}}{{.TypeParams}} struct {
	// ж is the underlying mutable value, named with a hard-to-type
	// character that looks pointy like a pointer.
	// It is named distinctively to make you think of how dangerous it is to escape
	// to callers. You must not let callers be able to mutate it.
	ж *{{.StructName}}{{.TypeParamNames}}
}
```

[`viewer.go#L4-L41`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/cmd/viewer/viewer.go#L4-L41)。

**「タイプしにくく、ポインタのように尖って見える文字」。**

意図は明確だ。`v.ж` と書くには、キリル文字を入力する必要がある。**うっかり書けない。** そしてコードレビューで目立つ。

**危険な操作を「書きにくくする」** という発想は、[鍵の型で `==` をコンパイルエラーにする](../keys/) のと同じ方向だが、こちらは **コンパイラではなく人間の入力しにくさ** に頼っている。

生成されるメソッドの規約も定まっている。

```go title="cmd/viewer/viewer.go"
// AsStruct returns a clone of the underlying value which aliases no memory with
// the original.
func (v {{.ViewName}}{{.TypeParamNames}}) AsStruct() *{{.StructName}}{{.TypeParamNames}}{
	if v.ж == nil {
		return nil
	}
	return v.ж.Clone()
}
```

**`AsStruct()` は必ずクローンを返す。** 「元のメモリと一切エイリアスしない」。

ビューから可変の値を取り出す唯一の方法がこれで、**必ずコピーが発生する**。[netmap のパッチ適用](../netmap/) が `AsStruct()` → 変更 → `View()` という手順を踏むのは、この規約による。

### Valid の必要性

```go
// Its methods should only be called if `Valid()` returns true.
```

`ж` が nil のビューがありうる。**ゼロ値のビューは「値がない」を表す。**

Go の `*T` と違い、**ビューは値型なので `nil` と比較できない**。だから `Valid()` メソッドが要る。

これは「ポインタの代わりに Optional 型を使う」パターンで、**ゼロ値が有効な状態 (無効を表す状態) になっている**。

### クローンの生成

```go title="cmd/cloner/cloner.go"
// Cloner is a tool to automate the creation of a Clone method.
//
// The result of the Clone method aliases no memory that can be edited
// with the original.
//
// This tool makes lots of implicit assumptions about the types you feed it.
// In particular, it can only write relatively "shallow" Clone methods.
// That is, if a type contains another named struct type, cloner assumes that
// named type will also have a Clone method.
package main
```

[`cloner.go#L4-L13`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/cmd/cloner/cloner.go#L4-L13)。

**「このツールは、与えられた型について多くの暗黙の仮定を置く」** と正直に書かれている。

- **比較的「浅い」Clone しか書けない**
- **名前付き構造体を含む場合、その型も `Clone` を持つと仮定する**

つまり **`Clone` の連鎖が成立していることが前提** だ。1 つでも `Clone` を持たない型が混ざれば、浅いコピーになって共有が残る。

**ツールの限界を明示することで、使う側が「なぜ動かないか」を理解できる。** そして限界を守るために、[netmap のフィールド追加時に panic する仕組み](../netmap/) のような検査が別に要る。

### 深いハッシュ

```go title="util/deephash/deephash.go"
// Package deephash hashes a Go value recursively, in a predictable order,
// without looping. The hash is only valid within the lifetime of a program.
// Users should not store the hash on disk or send it over the network.
// The hash is sufficiently strong and unique such that
// Hash(&x) == Hash(&y) is an appropriate replacement for x == y.
//
// The definition of equality is identical to reflect.DeepEqual except:
//   - Floating-point values are compared based on the raw bits,
//     which means that NaNs (with the same bit pattern) are treated as equal.
//   - time.Time are compared based on whether they are the same instant in time
//     and also in the same zone offset. Monotonic measurements and zone names
//     are ignored as part of the hash.
//   - netip.Addr are compared based on a shallow comparison of the struct.
```

[`deephash.go#L4-L17`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/deephash/deephash.go#L4-L17)。

**`reflect.DeepEqual` との違いが 3 点、明示されている。**

- **NaN が等しいとみなされる**。`reflect.DeepEqual` では NaN != NaN
- **`time.Time` は「同じ瞬間、同じゾーンオフセット」で比較**。単調時計とゾーン名は無視する
- **`netip.Addr` は浅い比較**

`time.Time` の扱いが実用的だ。`reflect.DeepEqual` は内部の単調時計を比較するので、**同じ時刻を表す 2 つの `time.Time` が「違う」と判定される**。設定の比較では、これは誤検知になる。

**「ディスクに保存するな、ネットワークで送るな」** という警告も重要だ。ハッシュの計算方法は Go のバージョンや実装の変更で変わりうる。**プロセスの寿命の中でのみ有効。**

### 循環の検出

```go title="util/deephash/deephash.go"
// # Cycle detection
//
// This package correctly handles cycles in the value graph,
// but in a way that is potentially pathological in some situations.
//
// The algorithm for cycle detection operates by
// pushing a pointer onto a stack whenever deephash is visiting a pointer and
// popping the pointer from the stack after deephash is leaving the pointer.
// Before visiting a new pointer, deephash checks whether it has already been
// visited on the pointer stack. If so, it hashes the index of the pointer
// on the stack and avoids visiting the pointer.
//
// This algorithm is guaranteed to detect cycles, but may expand pointers
// more often than a potential alternate algorithm that remembers all pointers
// ever visited in a map. The current algorithm uses O(D) memory, where D
// is the maximum depth of the recursion, while the alternate algorithm
// would use O(P) memory where P is all pointers ever seen, which can be a lot,
// and most of which may have nothing to do with cycles.
// Also, the alternate algorithm has to deal with challenges of producing
// deterministic results when pointers are visited in non-deterministic ways
// such as when iterating through a Go map. The stack-based algorithm avoids
// this challenge since the stack is always deterministic regardless of
// non-deterministic iteration order of Go maps.
```

[`deephash.go#L20-L43`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/deephash/deephash.go#L20-L43)。

**2 つのアルゴリズムを比較し、選んだ理由を書いている。**

| 方式                | メモリ          | 決定性                        |
| ------------------- | --------------- | ----------------------------- |
| **スタック (採用)** | O(深さ)         | **常に決定的**                |
| 訪問済みマップ      | O(全ポインタ数) | Go のマップの反復順に依存する |

**決定性が決め手だ。** 訪問済みマップ方式だと、Go のマップを反復する順序が実行ごとに違うので、**「同じ値なのに違うハッシュ」が出うる**。ハッシュを等価判定に使っているので、これは致命的になる。

スタック方式は「今たどっている経路」だけを持つので、**マップの反復順に関係なく決定的**だ。

そして **病的なケースも自ら示している**。

```go title="util/deephash/deephash.go"
// To concretely see how this algorithm can be pathological,
// consider the following data structure:
//
//	var big *Item = ... // some large data structure that is slow to hash
//	var manyBig []*Item
//	for i := range 1000 {
//		manyBig = append(manyBig, &big)
//	}
//	deephash.Hash(manyBig)
//
// Here, the manyBig data structure is not even cyclic.
```

**同じポインタが 1,000 回出てくるが、循環ではない。** スタック方式では、**1,000 回とも展開して ハッシュする**。訪問済みマップなら 1 回で済む。

**「選ばなかった選択肢の利点」と「選んだ選択肢の欠点」を両方書いている。** トレードオフの記録として、これ以上ない形だ。

### ビューのスライス

```go title="types/views/views.go"
// Package views provides read-only accessors for commonly used
// value types.
package views

// ByteSlice is a read-only accessor for types that are backed by a []byte.
type ByteSlice[T ~[]byte] struct {
	// ж is the underlying mutable value, named with a hard-to-type
	// character that looks pointy like a pointer.
	ж T
}

// MapKey returns a unique key for a slice, based on its address and length.
func (v ByteSlice[T]) MapKey() SliceMapKey[byte] { return mapKey(v.ж) }
```

[`views.go#L4-L29`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/types/views/views.go#L4-L29)。

**スライスやマップにもビューがある。** 構造体だけでなく、`[]T`、`map[K]V`、`[]byte` それぞれに読み取り専用のラッパーがある。

Go のスライスは **参照を渡すと中身を書き換えられる**。`views.Slice[T]` にすれば、`At(i)` で読むことしかできない。

`MapKey()` は面白い。**スライス自体はマップのキーにできない** (比較不可能な型) が、**アドレスと長さの組ならキーにできる**。同一のスライスを指しているかを判定する用途だ。

### 生成の規模

`//go:generate` で `cmd/viewer` または `cmd/cloner` を呼ぶ箇所は **25 個**。生成されるファイルは、

- `tailcfg/tailcfg_view.go` — Node、Hostinfo、DNSConfig などのビュー
- `ipn/ipn_view.go` — Prefs、ServeConfig などのビュー
- `ipn/ipn_clone.go` — 同じ型の Clone
- `types/netmap/nodemut.go` に関連する型
- `wgengine/filter/filtertype/filtertype_clone.go`

**ビューとクローンで、生成コードは数千行になる。** 手で書くと、フィールドを足すたびに更新漏れが起きる。

## なぜそうなっているか

### なぜ不変ビューが必要なのか

Go には所有権も readonly 修飾もない。**構造体へのポインタを渡すと、受け取った側は何でもできる。**

[netmap](../netmap/) のように「多くの場所から読まれ、更新のたびに一部を共有する」データでは、これが危険だ。

- ある場所が `nm.Peers[0].Addresses` を書き換える
- **その配列は前の netmap とも共有されている**
- 別の場所が読んでいる値が、突然変わる

**「コピーを渡す」なら安全だが、netmap は数 MB になりうる。** 更新のたびに全コピーは高すぎる。

**「共有するが書き換えさせない」を実現する唯一の方法が、非公開フィールドを持つラッパー型** になる。

### なぜコード生成なのか

`NodeView` を手で書くと、`Node` のフィールド数だけアクセサが要る。`tailcfg.Node` には 30 以上のフィールドがある。

そして **フィールドを足すたびに、ビューにもアクセサを足す必要がある**。忘れると「ビュー経由では読めないフィールド」ができる。

**生成すれば、`go generate` で常に同期する。** そして [CI で生成結果が最新か検査すれば](../natlab-testing/)、更新漏れが検出できる。

**「同じ情報から複数の表現を作る」場面では、生成が最も確実だ。** [ビルドタグの定数](../build-tags/)、[Kafka のプロトコル定義](/oss/kafka/protocol-codegen/) と同じ判断になっている。

### なぜ ж という名前なのか

普通なら `p`、`v`、`inner` あたりを使う。だが、

- **短い名前は、うっかり使ってしまう**。`v.p.Field = x` と書けてしまう
- **英字の名前は、補完で出てくる**

キリル文字なら、

- **US キーボードから直接入力できない**。コピペするか、IME を切り替える必要がある
- **視覚的に目立つ**。コードレビューで気づく

**「間違えにくくする」ではなく「間違えるのに手間をかけさせる」** という発想だ。

コンパイラで防げるならそちらがよい ([鍵の `Incomparable`](../keys/))。だが **同じパッケージ内からはフィールドにアクセスできてしまう** ので、コンパイラでは防げない。**残る防御が「書きにくさ」になる。**

### なぜ DeepEqual ではなくハッシュなのか

`reflect.DeepEqual(a, b)` は、**2 つの値を同時に持っている必要がある**。

設定の比較では「前回の値」を保持することになる。netmap のような大きな値では、**メモリが 2 倍要る**。

ハッシュなら **前回のハッシュ (数十バイト) だけを保持すればよい**。

```go
if hasKubeStateStore(cfg) && deephash.Update(&currentDeviceID, &deviceID) {
	// deviceID が変わった
}
```

`deephash.Update` は「保存されたハッシュと比べ、違えば更新して true を返す」。**「前回と違うか」の判定が 1 行になる。**

そして **`DeepEqual` の意味論の問題も回避できる**。`time.Time` の単調時計、NaN の扱い。ハッシュ関数を自分で書けば、**比較の意味を自分で定義できる**。

### なぜ「プロセスの寿命内でのみ有効」なのか

`deephash` は **Go の内部表現に依存する**。構造体のフィールド順、`reflect` の挙動、ハッシュ関数の実装。

これらは **Go のバージョンや、Tailscale 自身の変更で変わりうる**。

- ディスクに保存すると、**アップグレード後に全部の比較が「変更あり」になる**
- ネットワークで送ると、**バージョンの違うノード間で一致しない**

**「使ってよい範囲」を明示することで、誤用を防いでいる。** 同じ注意が [tailnet lock の CBOR](../tailnet-lock/) では逆向きに効いていた — あちらは永続化するので、シリアライズを固定する必要があった。

### なぜトレードオフの記録を残すのか

`deephash` の循環検出について、**選ばなかった方式の利点と、選んだ方式の欠点が両方書かれている**。

これがないと、

- 「マップで訪問済みを覚えたほうが速いのでは」と誰かが変更する
- **決定性が壊れ、稀にハッシュが一致しなくなる**
- 症状は「設定が変わっていないのに再適用される」で、原因の特定が困難

**トレードオフの記録は、将来の「改善」から実装を守る。** そして「病的なケース」を自ら示すことで、**本当に問題になったときに、どう変えるべきかの出発点にもなる**。

## どう活かすか

**共有と不変性を両立させるには、非公開フィールドを持つラッパー型を作る。** Go に readonly がなくても、パッケージ境界とアクセサで実現できる。**大きなデータを頻繁に更新・共有する場面では、コピーより安い。**

**ラッパー型のアクセサはコード生成する。** 手で書くとフィールド追加時の漏れが必ず起きる。生成すれば、CI で「生成結果が最新か」を検査できる。

**危険な操作は「書きにくく」する。** コンパイラで防げないなら、入力しにくい名前、目立つ名前を使う。`ж` は極端だが、**発想としては `_unsafeInternal` のような命名と同じ**だ。

**「変更されたか」の判定には、値の保持ではなくハッシュの保持を検討する。** メモリが定数になり、比較の意味論を自分で定義できる。**ただし「プロセスの寿命内でのみ有効」を明記する。**

**`reflect.DeepEqual` の意味論が要求と合わないことは多い。** `time.Time` の単調時計、NaN、ポインタの同一性。**独自の比較を作るなら、標準との違いを列挙する。**

**アルゴリズムの選択には、選ばなかった案とその理由を書く。** 「マップ方式のほうがメモリ効率が良いが、決定性がない」。この記録がないと、**将来の「最適化」が正しさを壊す**。

**選んだ実装の病的なケースを、自分で示す。** 「循環でないのに 1,000 回展開される」。隠すのではなく書いておけば、**本当に問題になったときの出発点になる**。

**ツールの限界を明示する。** 「浅い Clone しか書けない」「含まれる型も Clone を持つと仮定する」。**限界を知らずに使うと、静かに壊れる。**
