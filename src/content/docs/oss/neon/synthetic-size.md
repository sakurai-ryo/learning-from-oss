---
title: "synthetic size — 課金のためにサイズを定義し直す"
description: "コピーオンライトのブランチがあると「このデータベースは何 GB か」に答えられない。実際の物理サイズを課金に使わず、理想的なストレージモデルを立てて、そのモデル上の最小コストを計算する。"
group: "検証と運用"
sidebar:
  order: 56
---

## 何を学んだか

```markdown title="docs/synthetic-size.md"
Neon storage has copy-on-write branching, which makes it difficult to
answer the question "how large is my database"? To give one reasonable
answer, we calculate _synthetic size_ for a project.
```

([docs/synthetic-size.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/docs/synthetic-size.md))

[ブランチがコピーオンライトで実質無料になる理由](../branching-cow/) の代償がここに出る。**共有しているデータのサイズを、誰にどう割り当てるのか。**

そして根本的な判断がある。

```markdown title="docs/synthetic-size.md"
The synthetic size does _not_ depend on the actual physical size
consumed in the storage, or implementation details of the Neon storage
like garbage collection, compaction and compression. (中略)
the synthetic size is designed to be independent of the
implementation details, so that any improvements we make in the
storage system simply reduce our COGS. And vice versa: any bugs or bad
implementation where we keep more data than we would need to, do not
change the synthetic size or incur any costs to the user.
```

**実際に使っているバイト数で課金しない。**

理由が両方向から書かれている。

- **ストレージを改善したら、その利益は事業者のもの** (COGS が下がる)。ユーザーの請求額は変わらない
- **バグで無駄にデータを持ってしまっても、ユーザーには請求しない**

**課金の基準を実装から切り離す。** これがなければ、compaction のアルゴリズムを変えるたびに全ユーザーの請求額が変わる。「今月なぜ高いのか」に誰も答えられなくなる。

## 理想化されたモデルを立てる

```markdown title="docs/synthetic-size.md"
The synthetic size is based on an idealistic model of the storage
system, where we pretend that the storage consists of two things:

- snapshots, containing a full snapshot of the database, at a given
  point in time, and
- WAL.
```

**「スナップショットと WAL だけからなるストレージ」という架空のシステムを考える。**

単一ブランチなら計算は単純だ。

```text
                             WAL
   -----------------------#########>
                          ^
                       snapshot
```

**PITR の地平線の始点でのスナップショット + そこから末尾までの WAL。**

そして正直な但し書きが付く。

```markdown title="docs/synthetic-size.md"
NOTE: This is not how the storage system actually works! The actual
implementation is also based on snapshots and WAL, but the snapshots
are taken for individual database pages and ranges of pages rather
than the whole database, and it is much more complicated. This model
is a reasonable approximation, however, to make the synthetic size a
useful proxy for the actual storage consumption.
```

**「これは実際の動作ではない。だが妥当な近似だ。」**

モデルが実装と「相関する」ことだけを要求している。一致は要求しない。

## モデルが説明できること

このモデルの良いところは、**ユーザーが直感的に納得できる説明が出せる**ことだ。

**INSERT の場合。** 10GB のデータベースに 5GB 追加すると、`10GB (snapshot) + 5GB (WAL) = 15GB`。PITR を 0 にすると `15GB (snapshot) + 0GB = 15GB`。**同じになる。**

**DELETE の場合。** 10GB から 5GB 消して VACUUM すると、論理サイズは 5GB になるが、synthetic size は `10GB + 100MB = 10.1GB`。

```markdown title="docs/synthetic-size.md"
This is much larger than the logical size of the database after the
deletions (5 GB). That's because the system still needs to retain the
deleted data, because it's still accessible to queries and branching
in the PITR window.
```

**「消したのにサイズが減らない」という、ユーザーが必ず驚く事象を、モデルが説明できる。** PITR の期間内は、消したデータも読めるのだから、保持している。

そして PITR を 0 にするか時間が経てば 5GB になる。**課金額の変化に因果的な説明が付く。**

## 2 つの方法から安いほうを選ぶ

ブランチが分岐すると、選択肢が生まれる。

```rust title="libs/tenant_size_model/src/calculation.rs"
//                 *-g--*---D--->
//                /
//               /
//              /                 *---b----*-B--->
//             /                 /
//            /                 /
//      -----*--e---*-----f----* C
//           E                  \
//                               \
//                                *--a---*---A-->
//
// If A and B need to be retained, is it cheaper to store
// snapshot at C+a+b, or snapshots at A and B ?
//
// If D also needs to be retained, which is cheaper:
//
// 1. E+g+e+f+a+b
// 2. D+C+a+b
// 3. D+A+B
```

([libs/tenant_size_model/src/calculation.rs L3](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/tenant_size_model/src/calculation.rs#L3))

**分岐点でスナップショットを 1 つ取って両方の WAL を保持するか、それぞれのブランチでスナップショットを取るか。**

ブランチがあまり分岐していなければ前者が安い。大きく分岐すれば後者が安い。

```markdown title="docs/synthetic-size.md"
On each branch point, the system performs the calculation with
both methods, and uses the method that is cheaper, i.e. the one that
results in a smaller synthetic size.
```

**両方計算して安いほうを取る。** ユーザーに不利な選択をしない。

木の各節点で 2 つの選択肢があるので、素朴には指数的だ。実装は動的計画法になっていて、部分木ごとに最適な方法を決めて上に持ち上げる。

```rust title="libs/tenant_size_model/src/lib.rs"
/// Different methods to retain history from a particular state
pub enum SegmentMethod {
    SnapshotHere, // A logical snapshot is needed after this segment
    Wal,          // Keep WAL leading up to this node
    Skipped,
}
```

([libs/tenant_size_model/src/lib.rs L67](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/tenant_size_model/src/lib.rs#L67))

そして結果は、**どの節点でどちらを選んだかも返す。**

```rust title="libs/tenant_size_model/src/lib.rs"
pub struct SizeResult {
    pub total_size: u64,

    // This has same length as the StorageModel::segments vector in the input.
    pub segments: Vec<SegmentSizeResult>,
}
```

**総額だけでなく内訳を返す。** 「なぜこの金額なのか」を説明できるようにするため。`svg.rs` があり、この木を図として描画できるようになっている。**課金の根拠を可視化する。**

## モデルの入力を最小にする

```rust title="libs/tenant_size_model/src/lib.rs"
/// StorageModel is the input to the synthetic size calculation.
///
/// It represents a tree of timelines, with just the information that's needed
/// for the calculation. This doesn't track timeline names or where each timeline
/// begins and ends, for example. Instead, it consists of "points of interest"
/// on the timelines.
pub struct StorageModel {
    pub segments: Vec<Segment>,
}
```

([libs/tenant_size_model/src/lib.rs L7](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/tenant_size_model/src/lib.rs#L7))

**timeline の名前も、開始と終了も持たない。** 必要なのは「関心のある点」の木だけ。

```rust title="libs/tenant_size_model/src/lib.rs"
pub struct Segment {
    /// Previous segment index into ['Storage::segments`], if any.
    pub parent: Option<usize>,

    /// LSN at this point
    pub lsn: u64,

    /// Logical size at this node, if known.
    pub size: Option<u64>,

    /// If true, the segment from parent to this node is needed by `retention_period`
    pub needed: bool,
}
```

**crate 全体が pageserver に依存していない。** 入力は数値の木、出力は数値。だから単体でテストでき、モデルの妥当性を独立に検証できる。

`#![deny(unsafe_code)]` が付いているのも、この crate の性質を表している。**課金の計算をするコードに unsafe は要らない。**

点と辺を別々の型にしない設計も明示されている。

```rust title="libs/tenant_size_model/src/lib.rs"
/// Segment represents one point in the tree of branches, *and* the edge that leads
/// to it (if any). We don't need separate structs for points and edges, because each
/// point can have only one parent.
```

**木では、点と親への辺が 1 対 1 に対応する。** だから 1 つの型で足りる。

## ブランチ単位のサイズは定義できない

ドキュメントの最後の節が、この問題で最も価値のある部分になっている。

```markdown title="docs/synthetic-size.md"
There is no such thing as the size of a branch, because it
is not straightforward to attribute the parts of size to individual
branches.
```

そして 3 つの方法を検討し、**全部に問題があることを示す。**

main から 2 つのブランチ A と B を切り、それぞれ 1MB だけ更新した状況を考える。共有スナップショットは 10GB。

| 方法                                              | A と B のサイズ | 問題                                                                  |
| ------------------------------------------------- | --------------- | --------------------------------------------------------------------- |
| **引き算法** — このブランチを消したらいくら減るか | 各 1MB          | 合計が総額に一致しない。A を消すと B が 1MB から 10001MB に跳ね上がる |
| **割り算法** — 共有部分を等分する                 | 各 5001MB       | A を消せば 5001MB 減ると思うが、実際は 1MB しか減らない               |
| **足し算法** — 依存する全部を含める               | 各 10001MB      | 合計が総額を超える                                                    |

**どれも「正しい」が、どれもユーザーを驚かせる。**

そして結論が誠実だ。

```markdown title="docs/synthetic-size.md"
The bottom line is that it's not straightforward to attribute the
synthetic size to individual branches. There are things we can do, and
all of those methods are pretty straightforward to implement, but they
all have their own problems. What makes sense depends a lot on what
you want to do with the number, what question you are trying to
answer.
```

**「実装は簡単だが、どれが意味を持つかは、その数字で何をしたいかによる」。**

代替案として「木を図で見せて、各部分のサイズを表示する」が挙がっている。

```markdown title="docs/synthetic-size.md"
A sort of cop-out method would be to show the whole tree of branches
graphically, and for each section of WAL or logical snapshot, display
the size of that section.
```

**1 つの数字に潰せないものを、無理に潰さない。** 「cop-out (逃げ)」と自嘲しているが、共有されたリソースのコスト配分としては、これが最も正直な答えになる。

## この先に効いてくること

- **課金の基準を実装から切り離す。** 改善は事業者の利益、バグはユーザーに請求しない。
- **理想化されたモデルは、一致ではなく相関だけを要求する。** 説明できることが価値。
- **複数の保持方法から安いほうを選ぶ。** ユーザーに不利な選択をしない。
- **総額だけでなく内訳を返す。** 課金の根拠を説明可能にする。
- **共有リソースのコスト配分に正解はない。** 無理に 1 つの数字に潰さない選択肢もある。
