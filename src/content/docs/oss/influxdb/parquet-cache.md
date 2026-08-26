---
title: "キャッシュを ObjectStore の実装として被せ、「何を載せるか」の判断だけを外に出す"
description: "InfluxDB 3 の Parquet キャッシュは ObjectStore trait の実装で、GET はキャッシュを見るが、ミスしても勝手には載せない。載せる判断は「オラクル」への登録という別の経路で行う。書いた直後のバイト列は即時に、クエリが要求したパスは背景で GET してから載せる。同じパスへの同時要求は Shared future を先に置くことで 1 回にまとめ、追い出しは BinaryHeap で「最も古いヒット時刻の N%」を選ぶ。"
sidebar:
  order: 12
---

## 何を学んだか

### どんな状況の話か

InfluxDB 3 のクエリは Parquet ファイルを読む。ファイルはオブジェクトストアにあり、S3 への GET は数十ミリ秒かかる。ダッシュボードが 5 秒ごとに直近 10 分を問い合わせるような使い方では、**同じファイルを何度も取りに行く** ことになる。

素朴なキャッシュ (read-through: GET してミスしたら取得して載せる) には問題がある。時系列データベースへのクエリは、直近のデータに集中する一方で、たまに「1 年前の 1 日分」のような一発ものが飛んでくる。read-through だと、その一発ものがキャッシュを丸ごと汚す。逆に「書いた直後のファイル」は、既にメモリにバイト列があるのに、キャッシュに載せるためだけに GET し直すことになる。

### InfluxDB 3 の答え

1. **キャッシュを `ObjectStore` trait の実装として作る。** `MemCachedObjectStore` は内側に本物のストアを持ち、ほとんどのメソッドは素通しする。GET 系だけがキャッシュを見る。
2. **read-through にしない。** GET がミスしても、内側のストアから取ってきた結果を **キャッシュに載せない**。
3. **載せる判断を「オラクル」に分離する。** `ParquetCacheOracle::register(CacheRequest)` を呼んだものだけが載る。呼ぶのは書き込みパスとクエリパス。
4. **登録の形は 3 種類。** `Immediate` (バイト列が手元にある)、`Eventual` (パスだけ分かる。背景で GET)、`Evict` (消す)。
5. **同じパスへの同時要求は 1 回の GET にまとめる。** 取得を始める前に「取得中」のエントリと `Shared` future を先にマップに入れる。後から来た読み手はその future を待つ。
6. **クエリ由来の登録には時間の条件を付ける。** ファイルの時刻範囲が「直近 N」に重ならなければ、載せない。古いデータの一発クエリでキャッシュを汚さないため。
7. **追い出しは定期実行で、ヒット時刻が古い順に全体の N% を落とす。** `BinaryHeap` で候補を選ぶ。

## ソースコードのどこか

### 素通しのデコレータ

[`influxdb3_cache/src/parquet_cache/mod.rs#L694-L700`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L694-L700)。この 7 行が設計の宣言になっている。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
/// [`MemCachedObjectStore`] implements most [`ObjectStore`] methods as a pass-through, since
/// caching is decided externally. The exception is `delete`, which will have the entry removed
/// from the cache if the delete to the object store was successful.
///
/// GET-style methods will first check the cache for the object at the given path, before forwarding
/// to the inner [`ObjectStore`]. They do not, however, populate the cache after data has been fetched
/// from the inner store.
```

**"caching is decided externally"** と **"They do not, however, populate the cache"**。この 2 つが read-through との違いで、以降の設計は全部ここから出てくる。

`get_opts` の実装 ([`#L739-L770`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L739-L770))。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
        if let Some(state) = self.cache.get(location) {
            let GetOptions { range, .. } = options;
            let v = state.value().await?;
            let bytes = range
                .map(/* ... 範囲指定を解決する ... */)
                .map_or_else(
                    || v.data.clone(),
                    |r| {
                        let r_usize = (r.start as usize)..(r.end as usize);
                        v.data.slice(r_usize)
                    },
                );
            /* ... */
        } else {
            self.inner.get_opts(location, options).await
        }
```

ヒットしたら `Bytes::slice` で範囲を切り出す。`Bytes` は参照カウント付きの共有バッファなので、**切り出してもコピーが起きない**。ファイル全体をキャッシュしていれば、フッタだけを読む要求もメモリ上のスライスで返せる。

`get_ranges` のドキュメントが、なぜそれが重要かを書いている ([`#L781-L784`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L781-L784))。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
    /// This request is used by DataFusion when requesting metadata for Parquet files, so we need
    /// to use the cache to prevent excess network calls during query planning.
```

Parquet を読むには、まずフッタのメタデータを読む。DataFusion はプラン作成の段階でこれをやるので、**キャッシュが効かないとファイル数ぶんの往復がプランニングだけで発生する**。

例外は `delete` だけ ([`#L814-L818`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L814-L818))。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
    async fn delete(&self, location: &Path) -> object_store::Result<()> {
        let result = self.inner.delete(location).await?;
        self.cache.remove(location);
        Ok(result)
    }
```

**無効化だけは trait の側で自動的にやる。** 載せる判断は外に出せるが、消し忘れは正しさの問題になるので中に閉じ込める。

### 判断は外から

[`#L155-L172`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L155-L172)。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
/// An interface for interacting with a Parquet Cache by registering [`CacheRequest`]s to it.
pub trait ParquetCacheOracle: Send + Sync + Debug {
    /// Register a cache request with the oracle
    fn register(&self, cache_request: CacheRequest);

    // Get a receiver that is notified when a prune takes place and how much memory was freed
    fn prune_notifier(&self) -> watch::Receiver<usize>;

    // check in cache already
    fn in_cache(&self, path: &Path) -> bool;
}
```

要求の 3 種類 ([`#L91-L110`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L91-L110))。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
pub enum CacheRequest {
    // When creating parquet files, the serialized bytes are already
    // present so it can be directly loaded into the cache. This
    // Immediate mode request caters for that use case.
    Immediate(ImmediateCacheRequest),
    // When there is only a path to a parquet file in object store then a
    // GET request is needed to pull the actual data and store it in
    // the cache. This Eventual mode request caters for that use case.
    Eventual(EventualCacheRequest),
    /// These requests allow immediate eviction of a particular path
    /// from the cache
    Evict(EvictionCacheRequest),
}
```

`Immediate` は [永続化の直後](../queryable-buffer/) に使われる。Parquet を書いたバイト列はまだメモリにあるので、そのまま渡す。GET は発生しない。`Eventual` はクエリパスから使われ、`oneshot::Receiver` で「載った」ことを知らせる。

登録の入口で、既に入っているものは弾く ([`#L207-L216`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L207-L216))。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
    fn register(&self, request: CacheRequest) {
        let path = request.get_path();
        // We assume that objects on object store are immutable, so we can skip objects that
        // we have already fetched, in eventual mode we send the notification immediately, so
        // that it doesn't wait it's turn in the queue.
        let already_in_cache = self.mem_store.cache.path_already_fetched(path);
```

**「オブジェクトは不変」という前提が明記されている。** [パス設計](../persist-paths/) で「Parquet のパスは一意で上書きされない」を保証しているから、この前提が成り立つ。前提が崩れれば、このキャッシュは古いデータを返し続ける。

### 同時要求を 1 回にまとめる

[`#L869-L920`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L869-L920) の背景タスク。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
            let fut = async move {
                CacheValue::fetch(store_cloned, path_cloned)
                    .await
                    .map(Arc::new)
                    .map_err(|e| Arc::new(e) as _)
            }
            .boxed()
            .shared();
            // Put a `Fetching` state in the entry to prevent concurrent requests to the same path:
            mem_store.cache.set_fetching(&path, fut.clone());
```

**future を作るが、まだ待たない。** `Shared` にしてクローンをマップに入れてから、`tokio::spawn` で実際の駆動を始める。この順序で、取得中に来た読み手は `CacheEntryState::Fetching(fut)` を見つけ、同じ future を待つ。

エントリの状態は 2 つだけ ([`#L360-L370`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L360-L370))。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
/// The state of a cache entry
///
/// This implements `Clone` so that a reference to the entry in the `Cache` does not need to be
/// held for long.
enum CacheEntryState {
    /// The cache entry is being fetched from object store
    Fetching(SharedCacheValueFuture),
    /// The cache entry was successfully fetched and is stored in the cache as a [`CacheValue`]
    Success(Arc<CacheValue>),
}
```

`Clone` にした理由が書いてある。マップ (`DashMap`) の参照を持ったまま `await` すると、そのシャードのロックを await 中ずっと握ることになる。**クローンしてから参照を落とし、それから待つ。**

取得に失敗したらエントリごと消す。成功時に想定外の状態だったら警告して何もしない。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
                            // NOTE(trevor): this would be an error if A) it tried to insert on an already
                            // successful entry, or B) it tried to insert on an empty entry, in either case
                            // we do not need to remove the entry to clear a fetching state, as in the
                            // other failure modes below...
```

### 何を載せないか

[`#L924-L950`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L924-L950)。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
fn should_request_be_cached(
    file_timestamp_min_max: Option<TimestampMinMax>,
    cache: &Cache,
) -> bool {
    // If there's a timestamp range, check if there's capacity to add these
    // files. These are currently expected to come through from query path
    // which could be fetching older file. Check it's within allowed interval
    // before adding to cache
    file_timestamp_min_max
        .map(|file_timestamp_min_max| {
            if cache.used.load(Ordering::SeqCst) < cache.capacity {
                let end = cache.time_provider.now();
                let start = end - cache.query_cache_duration;
                let allowed_time_range =
                    TimestampRange::new(start.timestamp_nanos(), end.timestamp_nanos());
                /* ... */
                file_timestamp_min_max.overlaps(allowed_time_range)
            } else {
                false
            }
        })
        .unwrap_or(true)
}
```

**時系列データベースならではの追い出し方針** がここにある。汎用の LRU は「最近使われたか」しか見ないが、この判定は「そのファイルが持つデータの時刻」を見る。1 年前のデータを読む一発クエリは、たとえ今まさに使われていても載せない。

`unwrap_or(true)` なので、時刻範囲が渡されなかった要求 (書き込みパスからのもの) は無条件に載る。**判断材料を持っている呼び出し側だけが、判断される。**

### 追い出し

[`#L534-L584`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L534-L584)。

```rust title="influxdb3_cache/src/parquet_cache/mod.rs"
    fn prune(&self) -> Option<usize> {
        let used = self.used.load(Ordering::SeqCst);
        let n_to_prune = (self.map.len() as f64 * self.prune_percent).floor() as usize;
        if used < self.capacity || n_to_prune == 0 {
            return None;
        }
        // use a BinaryHeap to determine the cut-off time, at which, entries that were
        // last hit before that time will be pruned:
        let mut prune_heap = BinaryHeap::with_capacity(n_to_prune);
```

厳密な LRU (アクセスのたびに連結リストを繋ぎ変える) ではない。**エントリごとに `AtomicI64` のヒット時刻を持つだけ** で、読み取り時のコストは atomic store 1 回。追い出しのときに全体を走査して、最大ヒープで「最も古い N 個」を選ぶ。

この選択には理由がある。`DashMap` で並行アクセスを捌く設計では、厳密な LRU の連結リストが単一のボトルネックになる。**「読み取りは速く、追い出しは定期的にまとめて」** に倒すと、読み取り側でロックの競合が起きない。

ヒープの比較はヒット時刻だけを見る ([`#L587-L612`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L587-L612))。`PartialEq` も `Ord` も手で書いてあり、サイズやパスは比較に入らない。最大ヒープなので `peek()` は「候補の中で最も新しいもの」を返し、それより古いものが来たら入れ替える。**N 件だけを保持して全体を 1 回走査する** 定石だ。

追い出しは背景タスクから呼ばれる ([`#L954-L972`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_cache/src/parquet_cache/mod.rs#L954-L972))。ここでも `MissedTickBehavior::Skip` が使われている。

## なぜそうなっているか

- **read-through にしなかったのは、時系列のアクセスパターンが偏っているから。** 直近のデータへのクエリは繰り返し来るが、古いデータへのクエリは一度きりのことが多い。read-through は両者を区別できない。「載せる判断を外に出す」ことで、書き込みパスは「いま書いたものは載せる」、クエリパスは「直近のものだけ載せる」と、**文脈を持っている側が判断できる**。
- **`Immediate` モードがあるのは、書いた直後のバイト列が手元にあるから。** read-through 型のキャッシュでは、この最適化は表現できない (キャッシュに載せるには読み出しが要る)。API を「登録」にすると、データを直接渡す経路が自然に作れる。
- **取得前に `Fetching` を入れるのは、thundering herd を防ぐため。** 起動直後や、あるファイルが初めて読まれた瞬間には、複数のクエリが同じパスを同時に要求する。先にプレースホルダを置けば、GET は 1 回で済む。`Shared` future は「1 つの計算を複数が待つ」ための標準的な道具で、キャッシュのエントリ自体をその future にしている。
- **`ObjectStore` trait の実装にしたことで、DataFusion に手を入れずに済んでいる。** DataFusion は `Arc<dyn ObjectStore>` を受け取る。キャッシュをその形にすれば、クエリエンジン側は何も知らなくてよい。[専用エグゼキュータ](../dedicated-executor/) の `spawn_io` と同じで、**既存の trait の実装に化けることで、既存のコードを変えずに機能を足している**。
- **正直な TODO が 2 つ残っている。** `set_success` の中の "TODO(trevor): what if size is greater than cache capacity?" (1 ファイルが容量より大きい場合) と、要求キューのサイズ `CACHE_REQUEST_BUFFER_SIZE: usize = 1_000_000` の "TODO(trevor): make this configurable with reasonable default"。どちらも「まだ踏んでいないが、踏んだら困る」箇所として印が付いている。

## どう活かすか

- キャッシュを **既存の抽象 (trait / インターフェース) の実装として被せる** と、利用側のコードを変えずに導入できる。素通しが既定で、特定のメソッドだけ振る舞いを変える形にする。
- read-through が常に正解ではない。アクセスパターンに偏りがあるなら、**「何を載せるか」を、文脈を持っている呼び出し側に決めさせる**。キャッシュ本体は「載せろと言われたものを載せる」だけにする。
- ただし **無効化 (削除・更新時の除去) はキャッシュ側に閉じ込める**。載せ忘れは性能の問題だが、消し忘れは正しさの問題になる。
- 既にデータが手元にある経路には、**「取りに行かずに載せる」API** を用意する。書き込み直後のデータは、次に読まれる確率が最も高い。
- 同じキーへの同時要求は、**取得を始める前にプレースホルダ (共有 future) を置く** ことでまとめる。「取得してから入れる」順序だと、その間に来た要求が全部素通ししてしまう。
- 並行アクセスの多いキャッシュでは、**厳密な LRU をやめる** ことを検討する。エントリごとの atomic なタイムスタンプ + 定期的な一括追い出しなら、読み取り側にロックの競合が生まれない。
- 追い出しの候補選びは、**容量 N の最大ヒープで全体を 1 回走査** すればよい。全体をソートする必要はない。
- ドメイン固有の追い出し基準 (データの時刻、テナント、優先度) を持てるなら、汎用の LRU より効く。**「最近使われたか」以外の情報を、キャッシュの判断材料に渡せる設計** にしておく。
