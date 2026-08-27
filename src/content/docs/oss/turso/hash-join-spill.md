---
title: "ハッシュ結合は予算を超えたらディスクへ溢れる。debug ビルドでは必ず溢れさせる"
description: "ハッシュ結合はビルド側をメモリに載せる。載り切らないときは grace hash join でパーティションに分けてディスクへ書く。パーティション数は平均エントリサイズから動的に決まり、パーティションの選択にはハッシュの上位ビット、バケットの選択には下位ビットを使う。そして debug ビルドではメモリ予算が 32KB に落ちる。溢れる経路が普段から必ず踏まれるようにするためだ。"
sidebar:
  order: 24
---

## 何を学んだか

`SELECT * FROM a JOIN b ON a.x = b.y` を実行するとき、[結合順序の最適化](../join-order-dp/) が済んだら、次は「どう結合するか」になる。

- **ネステッドループ** — 外側の行ごとに内側を引く。索引があれば速い
- **ハッシュ結合** — 片方を丸ごとハッシュ表に載せ、もう片方を流す

ハッシュ結合には明白な問題がある。**載せる側がメモリに収まるとは限らない。**

Turso の答えは、教科書どおりの grace hash join だ。だが、そこに 2 つの工夫がある。

1. **SQLite の動的型付けと照合順序に合わせたハッシュ関数**
2. **debug ビルドでメモリ予算を極端に小さくして、溢れる経路を必ず踏ませる**

## ソースコードのどこか

### 予算が 2 つある

```rust title="core/vdbe/hash_table.rs"
// set to a *very* small 32KB, intentionally to trigger frequent spilling during tests
#[cfg(debug_assertions)]
pub const DEFAULT_MEM_BUDGET: usize = 32 * 1024;

/// 64MB default memory budget for hash joins.
/// TODO: make configurable via PRAGMA
#[cfg(not(debug_assertions))]
pub const DEFAULT_MEM_BUDGET: usize = 64 * 1024 * 1024;
```

[`core/vdbe/hash_table.rs#L24-L32`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L24-L32)。

**2000 倍の差がある。**

理由は 1 行目にある。**「テスト中に頻繁に溢れさせるために、意図的に非常に小さくしてある」。**

これは [「必ず yield する I/O 実装」](../memory-yield-io/) と全く同じ考え方だ。**溢れる経路は、本番では稀にしか通らない。だからテストでも通らない。**

64MB を超えるハッシュ表を作るテストを書くのは現実的でない。ならば **予算の方を下げる**。32KB なら、数十行のテストデータでも溢れる。

**「稀にしか起きない状態を、常に起きる状態にする」** — このコードベースで繰り返し出てくる型になっている。

### ハッシュ関数が SQLite の型システムに従う

```rust title="core/vdbe/hash_table.rs"
            ValueRef::Numeric(Numeric::Integer(i)) => {
                // Hash integers in the same bucket as numerically equivalent REALs so e.g. 10 and 10.0 have the same hash.
                let f = *i as f64;
                if (f as i64) == *i && f.is_finite() {
                    hasher.write_u8(FLOAT_HASH);
                    let bits = normalized_f64_bits(f);
                    hasher.write(&bits.to_le_bytes());
                } else {
                    // Fallback to the integer domain when the float representation would lose precision.
                    hasher.write_u8(INT_HASH);
                    hasher.write_i64(*i);
                }
            }
```

[`core/vdbe/hash_table.rs#L68-L80`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L68-L80)。

**SQLite では `10 = 10.0` が真になる。** だからハッシュ結合でも同じバケットに入らなければならない。

**「等しいものは同じハッシュを持つ」というハッシュ表の基本要件が、SQL の等価性の定義に縛られている。**

`f64` に変換して往復して元に戻るなら float として扱い、精度が落ちるなら integer として扱う。`i64` の大きい値は `f64` で表せないので、そこは分ける必要がある。

符号付きゼロも揃えている。

```rust title="core/vdbe/hash_table.rs"
/// Normalize signed zero so 0.0 and -0.0 hash the same.
```

[`core/vdbe/hash_table.rs#L116-L117`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L116-L117)。

文字列はもっと厄介で、**照合順序ごとに違うハッシュが要る**。

```rust title="core/vdbe/hash_table.rs"
            ValueRef::Text(text) => {
                let collation = collations.get(idx).unwrap_or(&CollationSeq::Binary);
                hasher.write_u8(TEXT_HASH);
                match *collation {
                    CollationSeq::NoCase => {
                        hash_text_nocase(&mut hasher, text.as_str());
                    }
                    CollationSeq::Rtrim => {
                        let trimmed = text.as_str().trim_end_matches(' ');
                        hasher.write(trimmed.as_bytes());
                    }
                    CollationSeq::Binary | CollationSeq::Unset => {
                        hasher.write(text.as_bytes());
                    }
                    CollationSeq::Locale(_) => {
                        hasher.write(&collation.hash_key(text.as_str()));
                    }
                    CollationSeq::Custom(_) => {
                        unreachable!(
                            "custom collations are rejected before hash table construction"
                        )
                    }
                }
            }
```

[`core/vdbe/hash_table.rs#L86-L109`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L86-L109)。

`NOCASE` なら大文字小文字を無視し、`RTRIM` なら末尾の空白を落としてからハッシュする。**照合順序が「等しい」と言う 2 つの文字列は、同じハッシュにならなければならない。**

最後の `Custom` が判断として面白い。**利用者定義の照合順序は、ハッシュ表を作る前に弾かれる。** ハッシュ関数を利用者に書かせるわけにいかないからだ。

**「対応できないものは、ここに到達する前に排除する」。** ここで `unreachable!` になるのは、上流の判定が壊れているときだけになる。

`hash_text_nocase` には細かい制約が書いてある。

```rust title="core/vdbe/hash_table.rs"
/// Hash text case-insensitively without allocation (ASCII-only for SQLite NOCASE).
/// SQLite's NOCASE collation only considers ASCII case, so to_ascii_lowercase() is correct.
```

**「SQLite の NOCASE は ASCII しか見ないので、`to_ascii_lowercase()` で正しい」。** Unicode の大文字小文字変換を使うと、SQLite と違う結果になる。[互換性](../sqlite-compat/) が、こんなところにも効いている。

しかも「確保なしで」と書かれている。小文字化した文字列を作らず、バイトを 1 つずつハッシュに流す。

### 溢れたら、パーティションに分ける

```rust title="core/vdbe/hash_table.rs"
/// Minimum number of partitions for grace hash join.
pub const MIN_PARTITIONS: usize = 16;
/// Maximum number of partitions for adaptive partitioning.
pub const MAX_PARTITIONS: usize = 128;
```

```rust title="core/vdbe/hash_table.rs"
    /// Based on average entry size and number of entries,
    /// determine the number of partitions to use for spilling.
    fn choose_partition_count(&self, entry_size: usize) -> usize {
        ...
        let avg_entry_size = if self.num_entries > 0 {
            (self.mem_used / self.num_entries).max(entry_size)
        } else {
            entry_size.max(1)
        };
        let target_partition_bytes = (self.mem_budget / 2).max(avg_entry_size);
        let target_entries_per_partition = (target_partition_bytes / avg_entry_size).max(1);
        let estimated_total_entries = self.num_entries.saturating_add(1);
        let mut partitions = estimated_total_entries.div_ceil(target_entries_per_partition);
        partitions = partitions.clamp(MIN_PARTITIONS, MAX_PARTITIONS);
        partitions.next_power_of_two()
    }
```

[`core/vdbe/hash_table.rs#L1103-L1125`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L1103-L1125)。

**パーティション数を、実測した平均エントリサイズから決める。**

狙いは「1 パーティションが予算の半分に収まること」。半分にしているのは、**プローブ側の作業領域も要るから**だ。

見積もりの材料が **実際にメモリに載せた分の平均**であることに注目したい。行の大きさは事前に分からない。**溢れた時点では、既にサンプルが手元にある。**

`clamp` と `next_power_of_two()` で、16〜128 の 2 の冪に落とす。2 の冪にするのは、剰余をビット演算にするためだ。

### パーティションは上位ビット、バケットは下位ビット

```rust title="core/vdbe/hash_table.rs"
impl Partitioning {
    fn new(count: usize) -> Self {
        turso_assert!(
            count.is_power_of_two(),
            "partition count must be a power of two"
        );
        let bits = count.trailing_zeros();
        Self {
            count,
            mask: count - 1,
            shift: 64 - bits,
        }
    }

    #[inline(always)]
    fn index(&self, hash: u64) -> usize {
        ((hash >> self.shift) as usize) & self.mask
    }
}
```

[`core/vdbe/hash_table.rs#L567-L586`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L567-L586)。

**パーティション番号は、ハッシュ値の上位ビットから取る。**

一方、バケット番号は下位ビットから取る。

```rust title="core/vdbe/hash_table.rs"
            let bucket_idx = (hash as usize) % self.buckets.len();
```

[`core/vdbe/hash_table.rs#L1242`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L1242)。

**なぜ分けるのか。同じビットを使うと、パーティションの中でバケットが偏るからだ。**

パーティション 0 に入るのは「上位ビットが 0 のもの」だ。これを下位ビットでバケットに割ると、下位ビットは自由なので満遍なく散る。

もし両方が下位ビットだと、パーティション 0 の全要素が「下位 4 ビットが 0」を共有する。**1024 個のバケットのうち、64 個にしか入らない。**

**1 つのハッシュ値を 2 段階で使うときは、違うビットを使う。** 教科書的だが、間違えると性能が 16 分の 1 になる。

### 1 パーティションは複数回に分けて書かれる

```rust title="core/vdbe/hash_table.rs"
/// A chunk of partition data spilled to disk.
/// A partition may be spilled multiple times, creating multiple chunks.
```

```rust title="core/vdbe/hash_table.rs"
/// Tracks a partition that has been spilled to disk during grace hash join.
pub struct SpilledPartition {
    /// Partition index (0 to partition_count - 1)
    pub partition_idx: usize,
    /// Chunks of data belonging to this partition (may have multiple spills)
    ...
    /// Current state of the partition
    ...
    /// Read buffer for loading partition back
    ...
    /// Hash buckets for this partition (populated after loading)
    ...
    /// Approximate memory used by the resident buckets for this partition
```

[`core/vdbe/hash_table.rs#L637-L668`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L637-L668)。

**1 つのパーティションが、ディスク上で連続しているとは限らない。**

ビルド側を読みながら、メモリが予算に達するたびに書き出す。そのたびに各パーティションの断片が 1 個ずつ増える。**連続配置しようとすると、書き出しの前に全体のサイズを知る必要がある。**

断片のリストを持てば、書き出しは常に追記でよい。読み戻すときに断片を順に辿る。

### 溢れる先も切り替えられる

```rust title="core/vdbe/hash_table.rs"
    /// Only spill to a file when != TempStore::Memory
    ...
    /// Optional override for the number of partitions (must be power of two).
    pub partition_count: Option<usize>,
```

[`core/vdbe/hash_table.rs#L780-L788`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L780-L788)。

`PRAGMA temp_store = MEMORY` なら、ファイルに書かない。SQLite が持っている設定に従っている。

`partition_count` の上書きがあるのはテストのためで、**「パーティション数がこの値のときにだけ起きるバグ」を再現できる。** 自動で決まる値には、必ず手で固定する手段が要る。

### そして I/O は当然 yield する

```rust title="core/vdbe/hash_table.rs"
/// I/O state for spilled partition operations
pub enum SpillIOState {
    None,
    WaitingForWrite,
    WriteComplete,
    WaitingForRead,
    ReadComplete,
```

[`core/vdbe/hash_table.rs#L612-L620`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/hash_table.rs#L612-L620)。

**ディスクに書く以上、[状態機械](../reentrancy/) が要る。** そして [VDBE 側にも `HashBuild` / `HashProbe` の中断状態がある](../vdbe/)。

「メモリに収まらないので溢れさせる」という 1 つの機能が、実行モデル全体に波及している。

## なぜそうなっているか

- **debug ビルドで予算を 32KB にしたのは、溢れる経路がテストで踏まれないから。** 64MB を超えるデータを用意するテストは、遅すぎて書けない。予算を下げれば、既存のテスト全部が溢れる経路を通る。
- **整数と浮動小数点を同じハッシュにしたのは、SQL の等価性がそう定義されているから。** ハッシュ表の「等しいものは同じバケット」という要件が、SQL の型システムに従属する。
- **精度が落ちる場合に整数側へ倒すのは、`f64` が全ての `i64` を表せないから。** 一律に変換すると、大きい整数どうしが誤って同じバケットに入る。
- **照合順序ごとにハッシュを変えるのは、等価性の定義がそれで変わるから。** `NOCASE` で `'A'` と `'a'` が等しいなら、同じハッシュでなければならない。
- **ASCII だけを見るのは、SQLite の `NOCASE` がそうだから。** Unicode 対応の方が「正しい」が、互換ではなくなる。
- **利用者定義の照合順序を事前に弾くのは、ハッシュを定義できないから。** 「等しいか」しか聞けない関数からは、一貫したハッシュを作れない。
- **パーティション数を実測から決めるのは、行の大きさが事前に分からないから。** 溢れた時点では、既に大量のサンプルが手元にある。
- **予算の半分を目標にしたのは、プローブ側にも領域が要るから。** 全部をビルド側に使うと、読み戻したパーティションを処理する余地がない。
- **上位ビットと下位ビットを使い分けたのは、同じビットだとパーティション内で偏るから。** ハッシュ値を 2 段階で使うときの定石になる。
- **パーティションを断片のリストにしたのは、書き出しを追記にするため。** 連続配置には、事前に全体サイズを知る必要がある。
- **パーティション数を手で固定できるのは、テストのため。** 自動で決まる値は、再現に必要なときに固定できないと困る。

## どう活かすか

- **「メモリに収まらないときの経路」は、収まらない状況を作りにくい。** 本番の閾値と開発の閾値を分けて、開発中は必ずその経路を通す。閾値を極端に下げるのが一番簡単な方法になる。
- **ハッシュを使う場所では、「等しい」の定義を先に確認する。** アプリケーション層の等価性 (大文字小文字無視、空白無視、型をまたぐ数値比較) と、ハッシュ関数が一致していなければならない。ここがずれると、結合結果が静かに欠ける。
- **その定義に対応できない場合は、その機能に入る前に弾く。** 「等しいか」しか答えられない比較器からは、ハッシュを作れない。到達させないのが正しい。
- **サイズの見積もりは、事前ではなく実測でやる。** 溢れる判断をする時点では、既にサンプルが手元にある。事前の推測より正確になる。
- **1 つのハッシュ値を 2 段階で使うときは、違うビットを使う。** 上位でパーティション、下位でバケット。同じビットを使うと片方が偏る。
- **段階的に書き出すデータは、断片のリストとして持つ。** 連続配置を目指すと、書き出す前に全体サイズを知る必要が出てくる。
- **自動で決まる値には、手で固定する手段を用意する。** 「パーティション数が 32 のときだけ落ちる」を再現できないと、直せない。
