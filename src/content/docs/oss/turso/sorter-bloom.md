---
title: "ソートとブルームフィルタも、同じ「予算」の枠の中に置く"
description: "ソートは外部マージソートで、メモリ予算を超えたらソート済みチャンクをディスクへ書き、最後に k-way マージする。速度の鍵は 2 つ。レコード本体をアリーナに置いてポインタだけを並べ替えることと、ソートキーの先頭を順序を保つ 64 ビットに正規化して比較をほぼ 1 命令にすることだ。ブルームフィルタは逆に「間違えても安全な方向」だけを使う枝刈りで、判断が外れたときの被害が非対称であることを命令のドキュメントに書いている。"
group: "実行演算子"
sidebar:
  order: 46
---

## 何を学んだか

[前のページ](../hash-join-spill/) のハッシュ結合と同じく、`ORDER BY` と `GROUP BY` のソートも **メモリに載り切らない可能性**がある。

対処は教科書どおりの外部マージソートだが、2 つの最適化が入っている。

- **レコード本体は動かさず、ポインタだけを並べ替える**
- **キーの先頭を順序を保つ 64 ビットに正規化し、比較をほぼ 1 命令にする**

そして、ソートと並んで「結合の前に行を減らす」ためのブルームフィルタがある。こちらは **予算ではなく、間違え方の非対称性**が主題になる。

## ソースコードのどこか

### レコードはアリーナ、並べ替えるのはポインタ

```rust title="core/vdbe/sorter.rs"
pub struct Sorter {
    /// Arena allocator for records - provides fast bump allocation and bulk deallocation.
    /// All record data (payload bytes, key_values) is stored here for in-memory sorting.
    arena: Bump,
    /// Pointers to records allocated in the arena. Sorting moves only 8-byte pointers,
    /// which prevents high memmove costs during sorting.
    /// SAFETY: These pointers are valid as long as the arena hasn't been reset.
    records: Vec<NonNull<ArenaSortableRecord>>,
```

[`core/vdbe/sorter.rs#L154-L161`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/sorter.rs#L154-L161)。

**並べ替えるのは 8 バイトのポインタだけ。** 行のバイト列は最初に置いた場所から動かない。

ソートは `O(n log n)` 回の交換を行う。1 行が 200 バイトなら、可変長のレコードを直接並べ替えると毎回 200 バイトの `memmove` が走る。**ポインタなら 8 バイトで済む。**

アリーナを使う理由も 2 つ書いてある。**確保が速い (ポインタを進めるだけ) こと**と、**まとめて解放できること**。ソートが終われば全レコードが同時に不要になるので、個別に解放する意味がない。

[バッファプールのアリーナ](../buffer-pool-arena/) とは別物だが、**「寿命が揃っているものは、まとめて確保してまとめて捨てる」** という考え方は共通している。

### キーの先頭を 64 ビットに正規化する

```rust title="core/vdbe/sorter.rs"
/// Order-preserving 64-bit prefix of the first sort-key column.
///
/// Layout: 3-bit class rank | 61-bit payload. Class ranks follow the SQL type
/// ordering (NULL < numeric < text < blob), with NULL remapped above blob when
/// the effective NULLS placement requires it. The whole key is bit-inverted for
/// DESC so a plain `u64` comparison applies the sort direction.
///
/// Invariant: `norm < other_norm` implies the full key comparison orders this
/// record first, so the sort comparator only falls back to the full (collation
/// and comparator aware) comparison when two normalized keys are equal. The
/// returned `decisive` flag is true when equal normalized keys additionally
/// prove the full keys are equal, letting the comparator skip the fallback.
fn normalized_first_key(
```

[`core/vdbe/sorter.rs#L34-L46`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/sorter.rs#L34-L46)。

**上位 3 ビットに型の順位、残り 61 ビットに値。** SQL の型順序 (NULL < 数値 < テキスト < BLOB) をそのまま数値の大小に写している。

これで **比較のほとんどが `u64` の比較 1 回**になる。値の型を見て分岐し、照合順序を引き、文字列を比較する経路は、**正規化キーが同点のときだけ**通る。

3 つの細部が良い。

1. **`DESC` はキー全体をビット反転する。** 比較器に「降順なら結果を反転する」という分岐を入れる代わりに、**キーの側で吸収する**。比較器は常に昇順として書ける
2. **NULL の位置が `NULLS FIRST` / `NULLS LAST` と `ASC` / `DESC` の 4 通りで決まる。** 型の順位をずらすだけで表現できる
3. **`decisive` フラグ**

3 番目が効いている。正規化キーが同点でも、**「本当に等しい」のか「61 ビットに収まらなかったので同点に見える」のか**は違う。前者ならフォールバックが要らない。

```rust title="core/vdbe/sorter.rs"
    if comparators.first().is_some_and(|c| c.is_some()) {
        // Custom ordering: the normalized key cannot mirror it.
        return (0, false);
    }
```

[`core/vdbe/sorter.rs#L56-L59`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/sorter.rs#L56-L59)。

**利用者定義の比較関数がある列は、正規化を諦めて `(0, false)` を返す。** 全部が同点になるので、常にフォールバックの完全比較が走る。**最適化を切る形が、正しさを保ったまま表現できている。**

[ハッシュ結合](../hash-join-spill/) では利用者定義の照合順序を事前に弾いていた。こちらは弾かずに遅い経路へ落とす。**ハッシュは「等しいものが同じ値になる」保証がないと成立しないが、ソートは遅くなるだけで済む。**

### 溢れたら、ソート済みチャンクを書く

```rust title="core/vdbe/sorter.rs"
    /// Sorted chunks stored on disk.
    chunks: Vec<SortedChunk>,
    /// The heap of records consumed from the chunks and their corresponding chunk index.
    chunk_heap: BinaryHeap<(Reverse<Box<BoxedSortableRecord>>, usize)>,
    /// The maximum size of the in-memory buffer in bytes before the records are flushed to a chunk file.
    max_buffer_size: usize,
    /// The current size of the in-memory buffer in bytes.
    current_buffer_size: usize,
    /// The minimum size of a chunk read buffer in bytes. The actual buffer size can be larger if the largest
    /// record in the buffer is larger than this value.
    min_chunk_read_buffer_size: usize,
```

[`core/vdbe/sorter.rs#L171-L181`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/sorter.rs#L171-L181)。

流れはこうなる。

1. メモリに溜める
2. `max_buffer_size` を超えたら、**その場でソートしてチャンクとしてディスクに書く**
3. 全部読み終わったら、各チャンクの先頭を二分ヒープに入れて k-way マージ

`BinaryHeap<(Reverse<...>, usize)>` の `Reverse` は、Rust の `BinaryHeap` が最大ヒープだからだ。**最小値を取り出したいので反転する。** 添字を組にして持つのは、取り出した後に「どのチャンクから次を補充するか」を知るためになる。

読み戻し用のバッファサイズにも注意がある。

```rust title="core/vdbe/sorter.rs"
    /// The minimum size of a chunk read buffer in bytes. The actual buffer size can be larger if the largest
    /// record in the buffer is larger than this value.
```

**「最小」であって固定ではない。** 1 レコードがバッファより大きいと、そのレコードを読めない。だから **最大レコード長を追跡していて、必要なら広げる。**

```rust title="core/vdbe/sorter.rs"
    /// The maximum record payload size in the in-memory buffer.
    max_payload_size_in_buffer: usize,
```

**「サイズの上限を決めた」なら、上限に収まらない要素が来たときの経路が要る。** 可変長を扱う仕組みには必ずこの問題がある。

### ブルームフィルタは、間違え方が非対称

```rust title="core/vdbe/insn.rs"
    /// Compute a hash on num_keys registers starting with r[key_reg]. Check to see if that hash
    /// is found in the bloom filter associated with the cursor/hash_table. If it is not present
    /// then jump to target_pc. Otherwise fall through.
    /// False negatives are harmless. It is always safe to fall through, even if the value is
    /// in the bloom filter. A false negative causes more CPU cycles to be used, but it should
    /// still yield the correct answer. However, an incorrect answer may well arise from a
    /// false positive - if the jump is taken when it should fall through.
    Filter {
```

[`core/vdbe/insn.rs#L516-L531`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/insn.rs#L516-L531)。

**「素通しは常に安全。飛ぶ方が危険」** が命令のドキュメントに書いてある。

- **素通しする (行を捨てない)** — 無駄な処理が増えるだけ。答えは正しい
- **飛ぶ (行を捨てる)** — 本当は必要な行だったら、答えが変わる

ブルームフィルタは「入っていない」を確実に答え、「入っている」は間違えうる。だから **「入っていない」と言われたときだけ飛ぶ**。この向きなら安全になる。

**「間違えたときの被害が非対称なら、被害の小さい方へ倒す判断だけに使う」。** 確率的なデータ構造を使うときの一般的な鉄則が、命令の仕様として書かれている。

実装も同じ方向に倒している。

```rust title="core/vdbe/execute.rs"
    let Some(filter) = state.get_bloom_filter(*cursor_id) else {
        // always safe to fall though, no filter present
        state.pc += 1;
        return Ok(InsnFunctionStepResult::Step);
    };
```

[`core/vdbe/execute.rs#L18384-L18388`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/execute.rs#L18384-L18388)。

**フィルタがなければ素通しする。** エラーにしない。フィルタの構築が省かれた場合でも、正しく動く。

NULL の扱いも明示的だ。

```rust title="core/vdbe/execute.rs"
        if matches!(value, Value::Null) {
            // its always safe to fall through, so this *should* be `true` but
            // since it's always an equality predicate and we have a NULL value,
            // we can just short-circuit to false here.
            false
```

[`core/vdbe/execute.rs#L18390-L18396`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/execute.rs#L18390-L18396)。

**「安全側は `true` (素通し) だが、等値述語で NULL なら絶対に一致しないので `false` (飛ぶ) にできる」。**

安全側の既定値を先に述べてから、それを外す根拠を書いている。**最適化を入れるときに「安全側は何か」を明示してから外すと、後から読んで検証できる。**

### 複合キーは 1 個のハッシュに畳む

```rust title="core/vdbe/bloom_filter.rs"
    /// Inserts multiple owned Values as a composite key into the bloom filter.
    /// This is because bloom filters only support a single value insertion, so to handle multi
    /// join-key situations we hash the composite key into a single u64 and then insert that
    pub fn insert_values(&mut self, values: &[&Value]) {
        let mut hasher = rapidhash::fast::RapidHasher::default();
        for value in values {
            hash_value(&mut hasher, &value.as_ref());
        }
        let hash = hasher.finish();
        self.inner.insert(&hash);
```

[`core/vdbe/bloom_filter.rs#L99-L110`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/bloom_filter.rs#L99-L110)。

**複数列の結合キーを 1 個の `u64` に畳んでから入れる。** ブルームフィルタは 1 値しか扱えないので、その手前で解決する。

```rust title="core/vdbe/bloom_filter.rs"
    /// Inserts a Value into the bloom filter.
    /// Safety NOTE: does not accept NULL values.
    pub fn insert_value(&mut self, value: &Value) {
        if !matches!(value, Value::Null) {
```

[`core/vdbe/bloom_filter.rs#L74-L78`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/bloom_filter.rs#L74-L78)。

**NULL は入れない。** 等値述語で NULL は何にも一致しないので、入れても引かれることがない。入れるとフィルタが無駄に埋まって、偽陽性率が上がる。

既定値も控えめだ。

```rust title="core/vdbe/bloom_filter.rs"
/// Default number of expected items for bloom filter sizing.
/// This is used when the expected count is not known ahead of time.
const DEFAULT_EXPECTED_ITEMS: u32 = 1024;

/// Default false positive rate (1%).
const DEFAULT_FALSE_POSITIVE_RATE: f32 = 0.01;
```

[`core/vdbe/bloom_filter.rs#L6-L13`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/bloom_filter.rs#L6-L13)。

**偽陽性率 1% は、枝刈りとしては十分。** 99% の無駄な行を落とせれば、フィルタの目的は果たされる。0.01% にしてもフィルタが大きくなるだけで、得は小さい。

## なぜそうなっているか

- **ポインタだけを並べ替えるのは、交換回数が `O(n log n)` だから。** 1 回の交換のコストが行の大きさに比例すると、そのまま全体に効く。
- **アリーナを使うのは、寿命が揃っているから。** ソートが終われば全レコードが同時に不要になる。個別解放のコストを払う理由がない。
- **キーを正規化するのは、比較が最内側のループだから。** 型を見て分岐し、照合順序を引く経路を毎回通ると、比較そのものが支配的になる。
- **`DESC` をビット反転で表すのは、比較器から分岐を消すため。** 「昇順か降順か」をキーの側に押し込めば、比較器は 1 種類で済む。
- **`decisive` フラグがあるのは、同点の意味が 2 通りあるから。** 「本当に等しい」と「収まりきらなかった」を区別できれば、フォールバックの回数が減る。
- **利用者定義の比較器で正規化を諦めるのは、順序を再現できないから。** 正しさを保ったまま最適化だけを切るには、「全部同点」を返すのが一番単純になる。
- **読み戻しバッファが「最小」なのは、可変長のレコードがあるから。** 上限を決めた仕組みには、上限に収まらない入力の経路が必ず要る。
- **ブルームフィルタを「飛ぶ」判断にだけ使うのは、間違え方が非対称だから。** 素通しは遅くなるだけ、飛ぶのは答えが変わる。
- **フィルタがないときに素通しするのは、フィルタが省略可能な最適化だから。** 「あれば速い、なくても正しい」を保てば、構築を後から止められる。
- **NULL を入れないのは、引かれることがないから。** 入れるとフィルタが埋まって偽陽性率だけ上がる。
- **偽陽性率を 1% にしたのは、枝刈りに十分だから。** さらに下げてもフィルタが大きくなるだけで、落とせる行はほとんど増えない。

## どう活かすか

- **並べ替えの対象が大きいなら、ポインタを並べ替える。** 交換回数は要素数の対数倍で効いてくるので、1 回のコストを下げる価値が大きい。
- **寿命が揃った大量のオブジェクトは、アリーナで確保する。** まとめて捨てられるなら、個別解放のコストは丸ごと不要になる。
- **比較の最内側では、「ほとんどの場合これで決まる」高速な指標を先に置く。** 順序を保つ固定長のキーを作れれば、完全比較はごく稀にしか走らない。
- **順序の向きは、比較器ではなくキーの側に埋め込む。** 比較器に分岐を入れると、最内側のループで毎回払うことになる。
- **「同点」の意味が複数あるなら、区別して返す。** 「本当に等しい」と「判定できなかった」は、次にやるべきことが違う。
- **最適化が使えない入力は、「常に同点」のような無害な値を返して遅い経路に落とす。** 特別扱いの分岐を増やすより、既にある経路に合流させる方が安全になる。
- **上限を決めた仕組みには、上限を超える入力の経路を用意する。** 「最小サイズ」と呼んでおいて、必要なら広げる。
- **確率的なデータ構造は、間違えても安全な向きの判断にだけ使う。** そして「どちらが安全側か」を、使う場所のドキュメントに書く。
- **最適化を入れるときは、安全側の答えを先に書いてから外す。** 「本来はこちらだが、この条件なので外せる」と書けば、後から検証できる。
- **省略可能な最適化は、なくても正しく動くようにする。** 「構築されていなければ素通し」なら、構築の判断を自由に変えられる。
