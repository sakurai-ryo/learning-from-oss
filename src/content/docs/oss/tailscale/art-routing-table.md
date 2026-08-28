---
title: "ルーティングテーブルのデータ構造を自作する"
description: "Knuth の Allotment Routing Table を Go で実装した 3,000 行のパッケージが残っている。8 ビットごとに区切った完全二分木を配列に平坦化し、経路の挿入時に部分木へ値を撒く。だが今のコードはこれを使っていない — 同じ系譜の外部ライブラリに置き換わっている。"
group: "OS 統合とルーティング"
sidebar:
  order: 29
---

## 何を学んだか

### 「宛先 IP から経路を引く」は頻度が高い

Tailscale の中で「この IP はどのピアのものか」を引く処理は、**パケットごとに走る**。

- [route manager](../netmap-apply/) が「宛先 IP → 送信先ピア」を引く
- [パケットフィルタ](../packet-filter/) が「この IP は許可された範囲か」を判定する
- [netlog](../netlog/) が「この IP は subnet route の中か」を分類する

これは **最長一致検索 (longest prefix match)** で、ルータが専用ハードウェアでやっている処理と同じものだ。

### ART = Allotment Routing Table

`net/art` は、Donald Knuth が考案し Yoichi Hariguchi が論文にした **ART アルゴリズム** の Go 実装だ。

> **ART は、経路の検索・挿入・削除において、伝統的な基数木 (radix tree) の実装を上回る。**

考え方はこうだ。

1. IP アドレスを **8 ビット (1 バイト) ごとの「ストライド」に分割** する
2. 各ストライドを **256 個の葉を持つ完全二分木** として表す
3. その二分木を **配列に平坦化** する。ノード `i` の親は `i>>1`、子は `i<<1` と `i<<1+1`
4. 経路を挿入するとき、**その経路がカバーする部分木のすべてに値を撒く** (allotment)

**検索は「配列を 1 回引く」だけになる。** 木を辿る必要がない。

### 使われていない

`net/art` を import しているコードは **1 つもない**。

現在使われているのは `github.com/gaissmai/bart` という外部ライブラリで、[route manager](../netmap-apply/)、[ipset](../packet-filter/)、[tstun](../tstun/)、`wgengine` などで広く使われている。

そして `net/art` のテストは **CI でスキップされる** ようになっている。

## ソースコードのどこか

### アルゴリズムの出典

```go title="net/art/table.go"
// Package art provides a routing table that implements the Allotment Routing
// Table (ART) algorithm by Donald Knuth, as described in the paper by Yoichi
// Hariguchi.
//
// ART outperforms the traditional radix tree implementations for route lookups,
// insertions, and deletions.
//
// For more information, see Yoichi Hariguchi's paper:
// https://cseweb.ucsd.edu//~varghese/TEACH/cs228/artlookup.pdf
package art
```

[`table.go#L4-L13`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/art/table.go#L4-L13)。

**論文の URL がパッケージのドキュメントに書かれている。** 自明でないアルゴリズムを実装するとき、出典を書かないと後から検証も改良もできない。

### 木を配列に平坦化する

```go title="net/art/stride_table.go"
// strideTable is a binary tree that implements an 8-bit routing table.
//
// The leaves of the binary tree are host routes (/8s). Each parent is a
// successively larger prefix that encompasses its children (/7 through /0).
type strideTable[T any] struct {
	prefix netip.Prefix
	// entries is the nodes of the binary tree, laid out in a flattened array.
	//
	// The array indices are arranged by the prefixIndex function, such that the
	// parent of the node at index i is located at index i>>1, and its children
	// at indices i<<1 and (i<<1)+1.
	//
	// A few consequences of this arrangement: host routes (/8) occupy
	// the last numChildren entries in the table; the single default
	// route /0 is at index 1, and index 0 is unused (in the original
	// paper, it's hijacked through sneaky C memory trickery to store
	// the refcount, but this is Go, where we don't store random bits
	// in pointers lest we confuse the GC)
	//
	// A nil value means no route matches the queried route.
	entries [lastHostIndex + 1]*T
```

[`stride_table.go#L21-L45`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/art/stride_table.go#L21-L45)。

**「元の論文では、C のメモリトリックで参照カウントをそこに押し込んでいるが、これは Go なので、GC を混乱させかねないランダムなビットをポインタに入れたりはしない」。**

論文の実装と自分の実装がどこで違うか、そして **なぜ違うのか** が書かれている。C の実装をそのまま移植すると Go では動かない (GC がポインタを検査する) ことを説明している。

インデックスの計算はこうなる。

```go title="net/art/stride_table.go"
// prefixIndex returns the array index of the tree node for addr/prefixLen.
func prefixIndex(addr uint8, prefixLen int) int {
	// the prefixIndex of addr/prefixLen is the prefixLen most significant bits
	// of addr, with a 1 tacked onto the left-hand side. For example:
	//
	//   - 0/0 is 1: 0 bits of the addr, with a 1 tacked on
	//   - 42/8 is 1_00101010 (298): all bits of 42, with a 1 tacked on
	//   - 48/4 is 1_0011 (19): 4 most-significant bits of 48, with a 1 tacked on
	return (int(addr) >> (8 - prefixLen)) + (1 << prefixLen)
}
```

[`stride_table.go#L258-L267`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/art/stride_table.go#L258-L267)。

**1 行の式に、3 つの具体例が添えられている。** 「プレフィックス長ぶんの上位ビットの左に 1 を立てる」というルールが、実例で確認できる。

これで **プレフィックスの長さと値の組が、1 個の整数に一意に対応する**。`0/0` は 1、`42/8` は 298。

### allotment がアルゴリズムの核

```go title="net/art/stride_table.go"
// allot updates entries whose stored prefixIndex matches oldPrefixIndex, in the
// subtree rooted at idx. Matching entries have their stored prefixIndex set to
// newPrefixIndex, and their value set to val.
//
// allot is the core of the ART algorithm, enabling efficient insertion/deletion
// while preserving very fast lookups.
func (t *strideTable[T]) allot(idx int, old, new *T) {
	if t.entries[idx] != old {
		// current idx isn't what we expect. This is a recursive call
		// that found a child subtree that already has a more specific
		// route installed. Don't touch it.
		return
	}
	t.entries[idx] = new
	if idx >= firstHostIndex {
		// The entry we just updated was a host route, we're at the bottom of
		// the binary tree.
		return
	}
	// Propagate the allotment to this node's children.
	left := idx << 1
	t.allot(left, old, new)
	right := left + 1
	t.allot(right, old, new)
}
```

[`stride_table.go#L136-L160`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/art/stride_table.go#L136-L160)。

**20 行がアルゴリズムの中心だ。**

`10.0.0.0/8` を挿入するとき、その経路がカバーするすべての「より長いプレフィックス」の位置に、同じ値を書き込む。すでにより具体的な経路 (`10.1.0.0/16` など) が入っている場所は **上書きしない** — それが `t.entries[idx] != old` の判定だ。

**「検索を速くするために、挿入で仕事をする」** という古典的なトレードオフになっている。検索は配列の 1 回参照で終わる。

### パス圧縮の代償

```go title="net/art/table.go"
	// With path compression, we might skip over some address bits while walking
	// to a strideTable leaf. This means the leaf answer we find might not be
	// correct, because path compression took us down the wrong subtree. When
	// that happens, we have to backtrack and figure out which most specific
	// route further up the tree is relevant to addr, and return that.
	//
	// So, as we walk down the stride tables, each time we find a non-nil route
	// result, we have to remember it and the associated strideTable prefix.
	//
	// We could also deal with this edge case of path compression by checking
	// the strideTable prefix on each table as we descend, but that means we
	// have to pay N prefix.Contains checks on every route lookup (where N is
	// the number of strideTables in the path), rather than only paying M prefix
	// comparisons in the edge case (where M is the number of strideTables in
	// the path with a non-nil route of their own).
	const maxDepth = 16
```

[`table.go#L69-L84`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/art/table.go#L69-L84)。

**2 つの実装の選択肢を比較して、選んだ理由が書かれている。**

- **案 A**: 降りるたびにプレフィックスを検査する → 毎回 N 回の検査
- **案 B (採用)**: 候補を覚えておき、必要なときだけ遡る → 普通は 0 回、稀に M 回

「N ≥ M であり、しかも M > 0 になるのは稀」なので B が速い。**平均ケースを最適化し、稀なケースにコストを寄せている。**

### アロケーションを避ける

```go title="net/art/table.go"
	// Ideally we would use addr.AsSlice here, but AsSlice is just
	// barely complex enough that it can't be inlined, and that in
	// turn causes the slice to escape to the heap. Using As16 and
	// manual slicing here helps the compiler keep Get alloc-free.
	st := t.tableForAddr(addr)
	rawAddr := addr.As16()
	bs := rawAddr[:]
	if addr.Is4() {
		bs = bs[12:]
	}
```

[`table.go#L57-L66`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/art/table.go#L57-L66)。

**「`AsSlice` はインライン化できるギリギリのところで複雑すぎるので、スライスがヒープに逃げる」。**

Go のエスケープ解析は、関数がインライン化されればローカルなスライスをスタックに置ける。**インライン化の閾値を超えると、ヒープ確保になる。**

`As16()` は固定長配列を返すので、スライス化してもスタックに残る。**パケットごとに呼ばれる関数なので、1 回のアロケーションも許容できない。**

`addr.Is4()` のとき `bs[12:]` を取っているのは、**IPv4 が IPv6 にマップされた形式** (`::ffff:10.0.0.1`) で格納されるためだ。後ろ 4 バイトが IPv4 のアドレスになる。

### そして使われていない

```go title="net/art/art_test.go"
func TestMain(m *testing.M) {
	if cibuild.On() {
		// Skip CI on GitHub for now
		// TODO: https://github.com/tailscale/tailscale/issues/7866
		os.Exit(0)
	}
	os.Exit(m.Run())
}
```

[`art_test.go`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/net/art/art_test.go)。

**テストが CI でスキップされている。** そして `tailscale.com/net/art` を import しているコードは、リポジトリ内に 1 つもない。

代わりに使われているのは `github.com/gaissmai/bart` (v0.26.1) だ。

```text
cmd/natc/ippool/ippool.go
net/ipset/ipset.go
net/routemanager/routemanager.go
net/tstun/wrap.go
ipn/ipnlocal/local.go
wgengine/wgengine.go
wgengine/userspace.go
wgengine/pendopen.go
...
```

**bart は ART の発展形** (Balanced ART) で、ストライドごとにビットマップを使うことで、ART のメモリ使用量を大幅に減らしている。

## なぜそうなっているか

### なぜ最初に自作したのか

2023 年当時、**Go で使える高速な最長一致検索のライブラリが乏しかった**。標準ライブラリにはなく、既存のものは基数木ベースで、Tailscale の要求 (パケットごとの検索) には遅かった。

そして Tailscale の用途は特殊だ。

- **検索が支配的**。挿入・削除は netmap 更新時だけ
- **エントリ数は数十〜数千**。インターネットの全経路 (100 万) ではない
- **アロケーションが許されない**。パケット処理のホットパス

**汎用ライブラリの性能特性と、自分の要求が合うかを判断できる程度に、問題を理解していた** から自作した。

### なぜ外部ライブラリに移行したのか

`bart` は ART と同じ系譜のアルゴリズムを、**より少ないメモリで実装している**。

ART の弱点はメモリだ。8 ビットのストライドごとに 512 エントリの配列を確保する。エントリが `*T` なら 1 ストライドあたり 4 KB。IPv6 で 16 ストライドあれば、疎な経路表でも大きくなる。

bart はここをビットマップ + 圧縮された配列に置き換える。**アルゴリズムの性質 (検索の速さ) を保ったまま、メモリを桁で減らす。**

**自作の実装を維持し続けるより、同じ問題をより良く解いた外部実装に乗るほうが合理的だ。** 自作の 3,000 行は、その判断ができるだけの理解を得るための投資でもあった。

### なぜコードを消さないのか

使われていないコードは、普通は消す。だが残っている理由は推測できる。

- **参照実装として価値がある。** bart の挙動を検証するときの比較対象になる
- **削除の優先度が低い。** ビルドには含まれない (import されていないので)
- **[ビルドタグ](../build-tags/)の仕組みで、バイナリサイズに影響しない**

ただし **テストが CI でスキップされているのは、健全な状態ではない**。issue 番号が付いているので、認識はされている。

**「使わなくなったコードをどう扱うか」に唯一の正解はない。** 消せば履歴からしか辿れなくなり、残せば「これは使われているのか」という疑問を生む。Tailscale の選択は「残すが、import されていないことを明示的にする」だった。

### なぜ「検索を速くするために挿入で仕事をする」のか

ルーティングテーブルの操作頻度は、極端に偏っている。

- **検索**: パケットごと。1 秒に数十万回
- **挿入・削除**: [netmap](../netmap/) の更新時。数分に 1 回

**5 桁の差がある。** 挿入が 100 倍遅くなっても、検索が 2 倍速くなるなら得だ。

ART の allotment は、まさにこのトレードオフを取っている。挿入時に部分木全体へ値を撒く (最悪 256 エントリの書き込み) 代わりに、検索が配列の 1 回参照になる。

**アクセス頻度の比を測ってから、データ構造を選ぶ。** これは [ipset の実装選択](../packet-filter/) や [netmap の View](../netmap/) と同じ考え方だ。

### なぜアロケーションをそこまで気にするのか

Go の GC は世代別ではないので、**アロケーションが増えると GC のスキャン対象が増える**。

パケットごとに 1 回アロケーションすると、1 Gbps で毎秒 9 万回。それが GC のヒープに載る。**GC の停止時間が延び、レイテンシのばらつきが増える。**

だから「エスケープ解析がどう働くか」を意識してコードを書く。`AsSlice` を避けて `As16` を使う、`sync.Pool` を使う ([tstun](../tstun/))、固定長配列を使う。

**「インライン化されるかどうか」がアロケーションの有無を決める** という Go 特有の事情が、コメントに書かれている。

## どう活かすか

**アルゴリズムを実装するときは、出典 (論文、URL) をパッケージのドキュメントに書く。** 実装だけでは、正しさの検証も、改良の判断もできない。そして **元の実装と自分の実装が違う点** があれば、その理由も書く。「C ではポインタにビットを詰めるが、Go では GC が混乱する」は、移植時の典型的な差だ。

**ビット演算やインデックス計算には、必ず具体例を添える。** `(int(addr) >> (8 - prefixLen)) + (1 << prefixLen)` は、3 つの例があれば検証できる。なければ、読む人が毎回紙に書くことになる。

**操作の頻度比を測ってから、データ構造を選ぶ。** 検索が挿入の 10 万倍なら、挿入を犠牲にする構造が正しい。逆なら別の構造になる。「一般的に速い」構造ではなく、「自分の頻度比で速い」構造を選ぶ。

**2 つの実装案を比較したら、選ばなかった案と理由をコメントに残す。** 「毎回 N 回検査する案もあるが、稀なケースで M 回払うほうが速い」。この記述があると、後から「なぜこんな複雑なことを」と思った人が納得できる。

**Go でホットパスを書くなら、エスケープ解析とインライン化を意識する。** 「この関数呼び出しはインライン化されないのでヒープに逃げる」といった事情は、ベンチマークと `-gcflags=-m` でしか分からない。分かったらコメントに書く。

**自作した実装を、より良い外部実装に置き換える判断を躊躇わない。** 自作したことで問題を深く理解でき、その理解が「どの外部実装が要求に合うか」を判断する力になる。**投資が無駄になったのではなく、判断力に変わっている。**

**使わなくなったコードを残すなら、使われていないことを明示する。** テストがスキップされているだけでは、次に読む人が混乱する。せめて「現在は bart に置き換えられている」とパッケージのドキュメントに書くべきだろう。
