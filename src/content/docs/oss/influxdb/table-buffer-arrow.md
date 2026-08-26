---
title: "スキーマが後から生えてくる入力を列指向のバッファに詰める。列が現れた時点で過去の行ぶんの null を埋め、行の終わりで来なかった列に null を足す"
description: "line protocol は行ごとにフィールドの集合が違う。InfluxDB 3 のメモリバッファは列ごとの Arrow builder を持ち、新しい列が現れたらその場で builder を作って過去の行数ぶんの null を先に append する。行の処理の最後に、値が来なかった列へ null を足す。この 2 つで「全 builder の長さが常に等しい」が保たれる。Arrow の 32 ビットオフセット制限 (2 GiB) はチャンク分割で回避し、builder の容量は既定値ではなく実際の行数から決める。"
sidebar:
  order: 4
---

## 何を学んだか

### どんな状況の話か

InfluxDB の書き込み形式 (line protocol) は、1 行ごとに違うフィールドを持てる。

```
cpu,host=a usage=0.5 1700000000
cpu,host=b usage=0.7,temp=42 1700000001
cpu,host=c temp=41 1700000002
```

3 行目まで読んで初めて「この表には `usage` と `temp` がある」と分かる。しかもクエリは Apache Arrow / DataFusion で走るので、バッファは最終的に **列指向の `RecordBatch`** にならなければならない。行が来るたびに列が増える入力を、列指向の構造にオンラインで詰め込む必要がある。

さらに、この構造は「クエリできる状態のまま」保たれる。書き込みの 1 秒後にはクエリ結果に現れるのが InfluxDB 3 の売りなので、Parquet になるまでの数分間、このメモリバッファがクエリ対象そのものになる。

### InfluxDB 3 の答え

1. **列ごとに Arrow の builder を持ち、`BTreeMap<ColumnId, Builder>` で管理する。** 列が現れるのは初めてその列の値が来た瞬間。
2. **新しい列の builder を作ったら、まず「それまでの行数」ぶんの null を append する。** `append_nulls(row_index + self.row_count)`。これで過去に遡って列が揃う。
3. **1 行を処理し終えたら、値が来なかった列に null を 1 個足す。** この 2 つの規則だけで、**全 builder の長さが常に等しい** という不変条件が保たれる。長さがずれた瞬間に `RecordBatch::try_new` は失敗するので、この不変条件が実質的な型検査になっている。
4. **builder の容量は既定に任せず、実際の行数から計算して渡す。** Arrow の既定は 1 列あたり 1024 要素ぶんの確保で、「10 分チャンクが数千個、各チャンクは数行」というスパースなデータでは、これがメモリを食い潰す。
5. **Arrow の 32 ビットオフセット制限 (2 GiB) はチャンク分割で回避する。** 文字列列のバイト数を列ごとに数え、次の書き込みで超えそうなら同じ時間帯に **もう 1 つチャンクを作る**。
6. **永続化中のチャンクは別のフィールドに退避して、クエリからは見え続ける。** `snapshotting_chunks` に移し、Parquet 書き出しが完了してから消す。

## ソースコードのどこか

### 構造

[`influxdb3_write/src/write_buffer/table_buffer.rs#L35-L38`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/table_buffer.rs#L35-L38)。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
pub struct TableBuffer {
    chunk_time_to_chunks: BTreeMap<i64, Vec<MutableTableChunk>>,
    snapshotting_chunks: Vec<SnapshotChunk>,
}
```

キーは gen1 チャンクの開始時刻 (既定 10 分単位)。値が `Vec` なのは、同じ時間帯に複数のチャンクを持てるようにするため。これが 2 GiB 制限の回避に効いてくる。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
struct MutableTableChunk {
    timestamp_min: i64,
    timestamp_max: i64,
    data: BTreeMap<ColumnId, Builder>,
    row_count: usize,
    string_bytes_per_column: HashMap<ColumnId, usize>,
}
```

列のキーが名前ではなく `ColumnId` なのは、カタログ側でリネームや再作成があっても同一性が保てるようにするため ([型付き ID のページ](../typed-ids/) を参照)。`string_bytes_per_column` は 2 GiB 制限のための積算値。

### 遅れて現れる列に、過去ぶんの null を埋める

[`#L314-L455`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/table_buffer.rs#L314-L451) の `add_rows` が、この章の中心。整数列の場合を抜き出す。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
                    FieldData::Integer(v) => {
                        let b = self.data.entry(f.id).or_insert_with(|| {
                            let mut int_builder = Int64Builder::with_capacity(builder_capacity);
                            // append nulls for all previous rows
                            int_builder.append_nulls(row_index + self.row_count);
                            Builder::I64(int_builder)
                        });
                        if let Builder::I64(b) = b {
                            b.append_value(*v);
                        } else {
                            panic!("unexpected field type");
                        }
                    }
```

`or_insert_with` の中で `append_nulls(row_index + self.row_count)` を呼んでいるのがポイント。`self.row_count` はこの `add_rows` 呼び出しより前に積まれた行数、`row_index` は今回のバッチ内での位置。合わせて「この列が初めて現れるまでに存在した行数」になる。

そして 1 行の終わりで、来なかった列を埋める ([`#L442-L447`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/table_buffer.rs#L442-L447))。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
            // add nulls for any columns not present
            for (column_id, builder) in &mut self.data {
                if !value_added.contains(column_id) {
                    builder.append_null();
                }
            }
```

前向きの穴埋め (この行に無い列) と後ろ向きの穴埋め (この列が生まれる前の行) の 2 方向が揃って、初めて長さが揃う。列の型が食い違ったときは `panic!("unexpected field type")` で落ちる。ここに到達する前に [書き込みバリデータ](../write-validator-typestate/) がカタログと型を突き合わせているので、到達したらそれは不変条件の破れであってユーザー入力の問題ではない、という立て付けになっている。

### 容量を既定に任せない

[`#L314-L321`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/table_buffer.rs#L314-L321)。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
    fn add_rows(&mut self, rows: &[Row]) {
        let new_row_count = rows.len();
        // Capacity needed for builders created in this call.
        // After this batch of rows, each builder will have exactly (self.row_count + new_row_count)
        // entries for values and nulls.
        // Using exact capacity avoids the default 1024-element allocation which may cause excessive
        // memory usage when there are many chunks with few rows each in sparse time-series data.
        let builder_capacity = self.row_count + new_row_count;
```

タグ列だけは 3 つの容量を渡す。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
                            let mut tag_builder = StringDictionaryBuilder::with_capacity(
                                builder_capacity,
                                builder_capacity.min(1024),
                                (builder_capacity * 64).min(1024),
                            );
```

順に「キー配列の長さ」「辞書に入る値の数」「辞書の文字列バイト数」。タグは低カーディナリティが前提なので辞書エンコードし、辞書側の見積もりには `min(1024)` で上限を掛けている。行数が多くても異なる値の数はそこまで増えないだろう、という賭けだが、外れても Arrow 側が伸長するだけで壊れはしない。

### 2 GiB の壁とチャンク分割

Arrow の `StringBuilder` はオフセットが 32 ビットなので、可変長データの合計が `i32::MAX` バイトを超えると **build 時に panic する** ([`influxdb3_types/src/arrow_limits/mod.rs`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_types/src/arrow_limits/mod.rs))。

```rust title="influxdb3_types/src/arrow_limits/mod.rs"
//! Arrow's `StringBuilder` uses 32-bit offsets, which limits the total variable-length payload to
//! `i32::MAX` bytes.
/// Arrays with total variable-length payload above this limit would panic during build.
pub const ARROW_VAR_COL_MAX_BYTES: usize = i32::MAX as usize;
```

バッファ側は書き込みのたびに、入ってくる文字列の合計バイト数を列ごとに数え、超えそうなら新しいチャンクを開く ([`#L45-L71`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/table_buffer.rs#L45-L71))。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
        let needs_new_chunk = chunks.is_empty()
            || chunks
                .last()
                .is_some_and(|c| c.would_exceed_limit_with(&incoming_per_column));

        if needs_new_chunk {
            chunks.push(MutableTableChunk::new());
        }
```

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
    fn would_exceed_limit_with(&self, incoming_per_column: &HashMap<ColumnId, usize>) -> bool {
        let limit = var_col_max_bytes();
        incoming_per_column.iter().any(|(col_id, additional)| {
            let existing = self
                .string_bytes_per_column
                .get(col_id)
                .copied()
                .unwrap_or(0);
            existing.saturating_add(*additional) > limit
        })
    }
```

「1 回の書き込みが単体で 2 GiB を超える」場合は救えないが、それは line protocol のリクエストサイズ制限で先に弾かれる。

この制限のテストは工夫されている ([`#L246-L285`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/table_buffer.rs#L246-L285))。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
// Test infrastructure for configurable string size limit - thread-local for test isolation.
#[cfg(test)]
thread_local! {
    static TEST_VAR_COL_MAX_BYTES: std::cell::Cell<usize> = const {
        std::cell::Cell::new(influxdb3_types::arrow_limits::ARROW_VAR_COL_MAX_BYTES)
    };
}

/// Returns the variable-column byte capacity limit.
fn var_col_max_bytes() -> usize {
    #[cfg(test)]
    {
        TEST_VAR_COL_MAX_BYTES.with(|c| c.get())
    }
    #[cfg(not(test))]
    {
        influxdb3_types::arrow_limits::ARROW_VAR_COL_MAX_BYTES
    }
}
```

2 GiB の文字列を実際に書き込むテストは現実的でない。そこで **テストビルドでだけ定数を thread local の変数に差し替え**、`VarColMaxGuard` (Drop で元に戻す) で数十バイトに縮めて分割ロジックを検証する。thread local なのは、テストが並列に走っても互いの設定を壊さないため。

### 永続化中もクエリできる

[`#L163-L190`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/write_buffer/table_buffer.rs#L163-L193) の `snapshot` は、対象チャンクを `chunk_time_to_chunks` から取り除いて `RecordBatch` に固め、`snapshotting_chunks` に移す。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
        self.snapshotting_chunks = snapshot_chunks;

        self.snapshotting_chunks.clone()
    }

    pub fn clear_snapshots(&mut self) {
        self.snapshotting_chunks.clear();
    }
```

クエリ側の `partitioned_record_batches` は `snapshotting_chunks` と `chunk_time_to_chunks` の **両方** を走査する。Parquet の書き出しが終わって [永続化ファイル一覧](../queryable-buffer/) に載ったあとで `clear_snapshots` が呼ばれるので、「バッファからは消えたが Parquet にはまだ載っていない」空白の瞬間ができない。可変な builder のまま持ち続けるのではなく、不変の `RecordBatch` に変換してから退避するので、退避後は書き込み側と読み取り側が同じデータを別々に触れる。

### スキーマの穴は読み出し時にも埋める

バッファに 1 度も現れなかった列は builder すら存在しないが、`RecordBatch` はテーブル定義のスキーマに従わなければならない。

```rust title="influxdb3_write/src/write_buffer/table_buffer.rs"
            let b = match self.data.get(&column_def.id) {
                Some(b) => b.as_arrow(),
                None => array_ref_nulls_for_type(column_def.data_type, self.row_count),
            };
```

`array_ref_nulls_for_type` が、型に応じた「全部 null の配列」を行数ぶん作る。書き込み時の穴埋めと読み出し時の穴埋めは別々に必要で、前者は「バッファ内で列が揃う」ため、後者は「バッファとカタログのスキーマが揃う」ためにある。

## なぜそうなっているか

- **容量指定は「zipbomb」に喩えられる実障害から入った。** コミット 2f9ca27b36 (2026) "fix(write-buffer): use explicit capacity instead of defaults (#27099)" のメッセージが詳しい。"this is sparse data that has only a few rows per 10 minutes. The TableBuffer creates a MutableTableChunk for each 10 min chunk in the months range. With arrow's default 1024 element allocations for our tag and field information, this can be a substantial in-memory use for wal files that serialize to a few megs or less. **It is akin to a zipbomb.** If the wal files were larger, snapshots would have been triggered. Instead, the TableBuffer grows to many GBs." 数 MB の WAL がメモリ上で数 GB に膨らむ。スナップショットの判断は WAL ファイル数で行われるので、**小さいファイルが大量にあるとメモリ側の安全弁が働かない** という組み合わせの問題でもある。同じメッセージが代償も認めている。"Some workloads that were coincidentally tuned to the 1024 element default will see more allocations"。
- **null 埋めは「空文字で埋める」バグの修正として固まった。** コミット d1c10f4b29 (2025-05) "fix: backfill new tags with NULL instead of empty string (#26446)" と、その 2 日後の 6e9446a8bb "test: reproduce problem with NULL backfill of omitted tag cols (#26448)"。後者は "fix: do not fill tag columns with empty string on persist" を含む。タグ列を空文字で埋めると、`WHERE host = ''` で意図しない行がヒットし、Parquet に落ちたあとも残る。**「値が無い」と「空の値」を混同しない** のはスキーマオンライトの基本だが、列指向の穴埋めでは間違えやすい箇所になっている。
- **チャンク分割は panic を避けるためだけでなく、パス衝突の修正も伴った。** 分割で生まれた複数チャンクは同じ `(table, chunk_time)` を持つので、素朴に永続化するとオブジェクトパスが衝突する。[`influxdb3_write/src/paths.rs#L64-L77`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L64-L77) のコメントがその顛末を書いている。"with a shared path, the persist jobs race, the last PUT silently overwrites the others, and the snapshot records every job's size for one object — leaving stale size records that fail reads with \"Invalid Parquet file. Corrupt footer\"." 制限を回避する変更が、別の層の一意性の前提を壊した例。詳しくは [パス設計のページ](../persist-paths/) で扱う。
- **`Vec<MutableTableChunk>` という形は、あとから分割を導入できるように選ばれている。** 1 つの `chunk_time` に 1 チャンクしか持てない設計だったら、2 GiB 制限の回避には「時間の粒度を変える」しかなく、それは Parquet の時間範囲やクエリのプルーニングにまで波及する。データ構造側に「同じキーで複数」を許す余地があったから、上限だけを別の軸で扱えた。

## どう活かすか

- スキーマが動的な入力を列指向に詰めるなら、**「列が生まれた時点で過去ぶんの null を埋める」「行の終わりに欠けた列を埋める」の 2 規則** を最初に決める。どちらか片方だけだと必ず長さがずれる。
- 「全列の長さが等しい」のような不変条件は、**それが破れたら構築が失敗する API** (Arrow の `RecordBatch::try_new` など) の直前に置く。自前で assert を書くより、既存のライブラリの検査に乗せたほうが漏れにくい。
- 「値が無い」を空文字やゼロで代用しない。列指向の穴埋めは目に見えないところで大量に走るので、間違えると **クエリ結果に静かに混ざる**。
- ライブラリ既定の初期容量は、**要素数が少なく個数が多い** ワークロードで牙をむく。1 つあたりの既定確保 × 個数を一度見積もる。「入力は数 MB なのにメモリは数 GB」という比率のズレは、この形をしていることが多い。
- 基盤ライブラリのハードリミット (Arrow の 32 ビットオフセット、protobuf のメッセージサイズ、SQLite の変数個数) は、**超えないように分割する層** を自分で持つ。ぶつかってから対処すると panic やデータ破損として現れる。
- そのリミットのテストには、**テストビルドだけ定数を差し替える仕掛け** を用意する。thread local + Drop ガードなら、並列テストでも汚染しない。定数を差し替え可能にするコストは小さく、代わりに「本番でしか起きない分岐」を無くせる。
- 「処理中のデータ」を可変構造から取り出して不変の形に変換し、別のフィールドに退避してから処理する。読み取り側は両方を見る。これだけで、**処理中に読めなくなる空白の瞬間** が消える。
