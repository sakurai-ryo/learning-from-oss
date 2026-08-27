---
title: "インデックスを持てないストレージでは、パスの命名規則そのものをインデックスにする"
description: "オブジェクトストアには list しかない。InfluxDB 3 はファイル名の付け方だけで「最新 N 件を取る」「特定の月だけ読む」「テーブル単位で絞る」を実現する。連番はゼロ埋めして辞書順を数値順に合わせ、降順で欲しいものは u64::MAX - n で反転させる。パスは newtype にしてコンストラクタと正規表現をセットで持ち、文字列として組み立てさせない。"
group: "ストレージ"
sidebar:
  order: 5
---

## 何を学んだか

### どんな状況の話か

InfluxDB 3 の永続データはすべてオブジェクトストアにある。Parquet ファイル、スナップショット情報の JSON、カタログのログとスナップショット、テーブルインデックス。これらを探す手段は 3 つしかない。

- **プレフィックス指定の list** (`ListObjectsV2`)
- **オフセット付き list** (「このキーより後」から)
- **キー指定の get**

セカンダリインデックスも、`WHERE` も、「更新日時の降順で 10 件」も無い。しかも list の結果は **キーの辞書順** で返る (S3 は UTF-8 バイナリ順を保証する)。起動時に「最新のスナップショットを 1 件」取りたいとき、全ファイルを list して中身を読んで比較する、では数万ファイルで破綻する。

### InfluxDB 3 の答え

1. **連番はゼロ埋めして、辞書順と数値順を一致させる。** WAL は 11 桁、スナップショットとカタログログは 20 桁 (`u64::MAX` の桁数)。
2. **降順で読みたいものは、値を反転させて名前にする。** `u64::MAX - n` を 20 桁ゼロ埋めで書く。辞書順の先頭が最新になり、**list の最初の 1 件を取るだけで最新が得られる**。
3. **パスに検索キーを埋め込む。** Parquet のパスは `{node}/dbs/{db_id}/{table_id}/{YYYY-MM-DD}/{HH-MM}/{wal_seq}.parquet`。データベース・テーブル・時間帯でプレフィックス絞り込みができる。
4. **量が増える系列はディレクトリで分割する。** スナップショットのチェックポイントは `snapshot-checkpoints/{YYYY-MM}/` の下に置き、「月ごとに最新 1 件」を安く取れるようにする。
5. **パスは newtype にする。** `ParquetFilePath`、`SnapshotInfoFilePath`、`CatalogFilePath` などが、コンストラクタと `TryFrom<ObjPath>` (正規表現による検証) をセットで持つ。呼び出し側でパス文字列を組み立てる場所は無い。
6. **「ファイルが存在すること」自体をフラグとして使う。** 大きな移行処理が 1 度でも完了したかどうかを、1 個のマーカーオブジェクトの有無で表す。
7. **一意性の保証をパスに担わせる。** 同じ `(テーブル, 時間帯)` から複数の Parquet が出るケースのために連番を足す。ただし 0 番は従来と同じ名前にして、既存ファイルと互換を保つ。

## ソースコードのどこか

### 反転させて降順にする

[`influxdb3_write/src/paths.rs#L37-L39`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L37-L39)。この章で一番小さくて一番効いている関数。

```rust title="influxdb3_write/src/paths.rs"
fn object_store_file_stem(n: u64) -> u64 {
    u64::MAX - n
}
```

使う側 ([`#L374-L400`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L374-L400))。

```rust title="influxdb3_write/src/paths.rs"
impl SnapshotInfoFilePath {
    pub fn new(host_prefix: &str, snapshot_sequence_number: SnapshotSequenceNumber) -> Self {
        let path = ObjPath::from(format!(
            "{host_prefix}/snapshots/{:020}.{}",
            object_store_file_stem(snapshot_sequence_number.as_u64()),
            SNAPSHOT_INFO_FILE_EXTENSION
        ));
        Self(path)
    }
```

読む側は逆変換する ([`#L402-L411`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L402-L411))。

```rust title="influxdb3_write/src/paths.rs"
    pub fn parse_sequence_number(filename: &str) -> Option<SnapshotSequenceNumber> {
        // Extract the filename from the path if it's a full path
        let filename = filename.split('/').next_back().unwrap_or(filename);

        filename
            .strip_suffix(".info.json")
            .and_then(|seq_str| seq_str.parse::<u64>().ok())
            .map(|inverted| u64::MAX - inverted) // Undo the object_store_file_stem inversion
            .map(SnapshotSequenceNumber::new)
    }
```

スナップショット番号 1 のファイル名は `18446744073709551614.info.json`、番号 2 は `18446744073709551613.info.json`。人間には読めないが、**list の先頭が常に最新** になる。

効果が出るのは起動時 ([`influxdb3_write/src/persister.rs#L194-L290`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/persister.rs#L194-L290))。

```rust title="influxdb3_write/src/persister.rs"
            // Why not collect into a Result<Vec<ObjectMeta>, object_store::Error>>
            // like we could with Iterators? Well because it's a stream it ends up
            // using different traits and can't really do that. So we need to loop
            // through to return any errors that might have occurred, then do an
            // unstable sort (which is faster and we know won't have any
            // duplicates) since these can arrive out of order, and then issue gets
            // on the n most recent snapshots that we want and is returned in order
            // of the moste recent to least.
```

`list` の結果を昇順にソートして先頭 N 件を取れば、それが「最新 N 件」になる。1000 件ずつオフセット付きで list を繰り返し、`FuturesOrdered` で並行に GET しつつ順序は保つ。**「最新を取る」が「先頭を取る」に化けている** のがこの命名規則の効果で、これが無ければ全件 list + 全件ソートか、中身を読んでの比較が要る。

なお、カタログのログファイルは反転させない ([`influxdb3_catalog/src/object_store/versions/v3.rs#L571-L576`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/object_store/versions/v3.rs#L571-L576))。

```rust title="influxdb3_catalog/src/object_store/versions/v3.rs"
    pub fn log(catalog_prefix: &str, sequence_number: CatalogSequenceNumber) -> Self {
        let num = sequence_number.get();
        Self(ObjPath::from(format!(
            "{catalog_prefix}/{CATALOG_VERSION_PATH}/logs/{num:020}.{CATALOG_LOG_FILE_EXTENSION}",
        )))
    }
```

カタログのログは **古いものから順に再生する** ので、昇順のほうが都合がよい ([カタログのページ](../catalog-log-checkpoint/))。同じリポジトリの中で、読み方に応じて昇順と降順を使い分けている。

### パスに検索キーを埋める

Parquet のパス ([`#L42-L98`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L42-L98))。

```rust title="influxdb3_write/src/paths.rs"
        let path = ObjPath::from(format!(
            "{host_prefix}/dbs/{db_id}/{table_id}/{date_string}/{wal_seq:010}{ordinal_suffix}.{ext}",
            date_string = date_time.format("%Y-%m-%d/%H-%M"),
            wal_seq = wal_file_sequence_number.as_u64(),
            ext = PARQUET_FILE_EXTENSION
        ));
```

`{db_id}/{table_id}/{YYYY-MM-DD}/{HH-MM}/` の階層は、そのままプレフィックス絞り込みの軸になる。あるテーブルのある日のファイルだけを list できる。ファイル名の本体が WAL のシーケンス番号なのは、**どの WAL 由来かを名前だけで追える** ようにするため。

チェックポイントは月で切る ([`#L458-L490`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L458-L490))。

```rust title="influxdb3_write/src/paths.rs"
/// Path for snapshot checkpoints, organized by year-month.
/// Pattern: `{node_id}/snapshot-checkpoints/{year-month}/{inverted_seq:020}.checkpoint.json`
///
/// Checkpoints are organized by month to enable efficient loading of only the latest
/// checkpoint per month during server startup.
```

月ディレクトリ + 反転連番の組み合わせで、「各月の最新チェックポイント」が **月の数だけの list** で取れる。ディレクトリで分割する軸 (月) と、その中で順序を作る軸 (反転連番) を重ねている。

### パスを型にする

すべてのパスが newtype で、`ObjPath` を直接触らせない。読み取り側には正規表現による `TryFrom` がある ([`#L376-L379`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L376-L379) と [`#L428-L455`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L428-L455))。

```rust title="influxdb3_write/src/paths.rs"
static SNAPSHOT_INFO_FILE_PATH_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^.*/snapshots/(\d{20})\.info\.json$").expect("regex must be valid")
});
```

```rust title="influxdb3_write/src/paths.rs"
        if !re.is_match(path_str) {
            return Err(PathError::InvalidFormat {
                expected: "*/snapshots/<20-digits>.info.json".to_string(),
                actual: path_str.to_string(),
            });
        }

        // Additional validation: ensure we can parse the sequence number
```

`\d{20}` が桁数まで縛っているので、ゼロ埋めを忘れた過去のファイルや、別の用途のファイルが紛れ込んでも弾かれる。エラーには「期待した形」と「実際の値」の両方が入る。

書き手側の一貫性を前提にできるところでは、`expect` で割り切っている ([`#L184-L211`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L184-L211))。

```rust title="influxdb3_write/src/paths.rs"
    /// Extract the full table ID (node_id, db_id, table_id) from the path.
    ///
    /// This method will panic if called on a path not created by `TableIndexPath::new`,
    /// but this should never happen in practice since we control path construction.
    pub fn full_table_id(&self) -> TableIndexId {
```

「自分で作ったパスからしか呼ばれない」ことを型 (`TableIndexSnapshotPath`) で担保しているから panic してよい、という論理。newtype にしていなければ、この判断はできない。

### 存在をフラグにする

[`#L114-L129`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L114-L129)。

```rust title="influxdb3_write/src/paths.rs"
/// This path, when it exists in the object store, signifies that a full conversion from
/// PersistedSnapshots to TableIndices has been completed at least once, allowing us to skip the
/// memory-intensive operation on subsequent startups.
///
/// The contents of the path should be a simple JSON data structure containing the last snapshot
/// sequence number at the time of conversion.
pub struct TableIndexConversionCompletedPath(ObjPath);

impl TableIndexConversionCompletedPath {
    pub fn new(host_prefix: &str) -> Self {
        let path = ObjPath::from(format!("{host_prefix}/table-index-conversion-completed",))
        /* ... */
```

移行が済んだかどうかを保存する場所は、専用のメタデータストアでも、カタログのフィールドでもなく、**固定パスのオブジェクト 1 個**。存在すれば済んでいる。中身には「いつ時点まで済んだか」が入っているので、部分的な再開もできる。オブジェクトストアしか依存先が無い設計では、これが最も安いブール値になる。

### 一意性をパスで守る

[`#L64-L98`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_write/src/paths.rs#L64-L98) の `new_with_chunk_ordinal`。[メモリバッファのページ](../table-buffer-arrow/) で見た「2 GiB 制限でチャンクが割れる」ケースへの対応。

```rust title="influxdb3_write/src/paths.rs"
    /// A gen1 chunk splits into multiple buffer chunks when a string/tag column would exceed
    /// the Arrow varchar limit (~2 GiB, see `table_buffer::var_col_max_bytes`). Each split
    /// chunk must persist to a distinct object path: with a shared path, the persist jobs
    /// race, the last PUT silently overwrites the others, and the snapshot records every
    /// job's size for one object — leaving stale size records that fail reads with
    /// "Invalid Parquet file. Corrupt footer".
    ///
    /// Ordinal 0 produces the historical filename exactly, so single-chunk persists (the
    /// overwhelmingly common case) and all files written before this change are unaffected.
    /// Ordinal n >= 1 appends `-{n}` before the extension.
```

障害の連鎖が具体的に書かれている。パスが衝突する → 並行 PUT が競合する → 最後の 1 個が他を上書きする → **エラーにならない** → スナップショットには全ジョブぶんのサイズが記録される → 読み出しで "Corrupt footer" になる。オブジェクトストアの PUT は成功を返すので、**衝突は書き込み時には見えず、読み出し時に別の症状として現れる**。

修正のしかたも参考になる。連番 0 は接尾辞を付けず、従来と 1 バイトも変わらないファイル名にする。これで既存のオブジェクトは無変換で読め、新しい形式は稀なケースにだけ現れる。

## なぜそうなっているか

- **反転による降順は、オブジェクトストアの API 制約への回答。** S3 の `ListObjectsV2` はキーの昇順しか返さない。降順のオプションも、更新日時での並べ替えも無い。「最新から N 件」が要るなら、キーの側を最新が先に来るように作るしかない。同じ技法は HBase の行キー設計や、DynamoDB のソートキー設計でも定番になっている。
- **ゼロ埋めの桁数は型から来ている。** `u64` の 10 進最大は 20 桁なので `{:020}`。WAL だけ 11 桁なのは、1 秒に 1 ファイルなら 11 桁 (約 1000 億) で十分に余裕がある、という判断だろう (推測)。桁が溢れると辞書順が壊れるので、余裕を持たせる側に倒している。
- **月ディレクトリはコミット 26d26f56dd (#27153) "feat: introduce snapshot checkpoints" で入った。** スナップショット情報ファイルが増えるほど起動時の list が重くなる。チェックポイントは「ここまでのスナップショットを 1 個にまとめたもの」で、月で切ることで「必要なぶんだけ list する」を可能にしている。**パスの階層構造が、そのまま読み込み量の上限になる。**
- **パスを型にするのは、書き手と読み手を 1 箇所に閉じ込めるため。** 生成 (`new`) と解析 (`TryFrom`、`parse_sequence_number`) が同じ `impl` に並んでいるので、片方だけ変えると隣のテストが落ちる。反転のような「読みにくいが必要な変換」を安全に持てるのは、この対称性のおかげ。
- **チャンク連番の後方互換は、オブジェクトストアには「リネーム」が無いことの裏返し。** 既存ファイルの名前を変える移行は、全件のコピーと削除を意味する。だから新しい形式は **既存の名前を変えない形** で設計する必要があった。

## どう活かすか

- インデックスを持てないストア (オブジェクトストア、ファイルシステム、フラットな KVS) では、**キーの命名規則が唯一のインデックス**。何をクエリしたいかを先に決めてから、キーの構造を設計する。
- 数値をキーに入れるときは **必ずゼロ埋めする**。桁数は型の最大値から決める。辞書順と数値順の不一致は、後から直すとファイル全部の移行になる。
- 「最新から N 件」が要るなら `MAX - n` の反転を検討する。人間には読めなくなるので、**生成と解析を同じ型に閉じ込め、逆変換にコメントを付ける**。
- パスやキーは文字列ではなく newtype にする。コンストラクタと検証付きの `TryFrom` をセットで持たせると、「自分が作ったキーからしか呼ばれない」と言い切れる場所が生まれ、そこでは `expect` が正当化できる。
- ブール値 1 個の永続化に新しいストアを持ち込まない。**オブジェクトの存在そのものがフラグになる**。中身に「どこまで進んだか」を入れておけば、再開もできる。
- 命名規則を変えるときは、**既存のキーと 1 バイトも変わらない既定ケース** を残す。リネームできないストアでは、これが唯一の無停止移行の道になる。
- パスの一意性は、書き込みの並行性と直結している。同じキーに複数の書き手が来る可能性が生まれたら、**キー側に区別する軸を足す**。オブジェクトストアの PUT は衝突をエラーにしないので、気づくのは遠く離れた読み出しの失敗になる。
