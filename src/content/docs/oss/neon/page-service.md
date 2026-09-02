---
title: "page_service — getpage@lsn プロトコル"
description: "1 接続を複数のバックエンドが共有し、要求はパイプライン化され、束ねられ、束ねられなかった理由は全部メトリクスになる。単純に見えるリクエスト・レスポンスの裏に、バッチ化のための細かい判断が詰まっている。"
group: "pageserver — 実行時"
sidebar:
  order: 38
---

## 何を学んだか

`page_service.rs` は 177KB ある。pageserver で 2 番目に大きいファイルだ。やっていることは「ページを要求され、返す」だけに見えるのに、なぜこれだけの量になるのか。

答えは**バッチ化**にある。

素朴に実装すると、1 要求 = 1 回のレイヤ探索 = 1 回のディスク I/O になる。[ページ再構成のための vectored read](../vectored-read/) で見たとおり、キーをまとめれば探索も I/O も 1 回にまとめられる。

しかし要求は 1 つずつ届く。**まとめるには、待たなければならない。**

## パイプライン化

```rust title="libs/pageserver_api/src/config.rs"
pub enum PageServicePipeliningConfig {
    Serial,
    Pipelined(PageServicePipeliningConfigPipelined),
}

pub struct PageServicePipeliningConfigPipelined {
    /// Failed config parsing and validation if larger than `max_get_vectored_keys`.
    pub max_batch_size: NonZeroUsize,
    pub execution: PageServiceProtocolPipelinedExecutionStrategy,
    // The default below is such that new versions of the software can start
    // with the old configuration.
    #[serde(default)]
    pub batching: PageServiceProtocolPipelinedBatchingStrategy,
}
```

([libs/pageserver_api/src/config.rs L311](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/config.rs#L311))

**読み手と実行を分ける。** 1 つのタスクがソケットから要求を読み続け、別のタスクがバッチを実行する。読み手は実行を待たないので、次々に要求を積める。

`#[serde(default)]` のコメントが実務的だ。**「新しいバージョンが古い設定で起動できるように」**デフォルトを付けている。設定ファイルの互換性を、フィールド追加のたびに考えている。

2 つのタスクを繋ぐのが `spsc_fold` という専用のチャネルだ。

```rust title="libs/utils/src/sync/spsc_fold.rs"
enum State<T> {
    NoData,
    HasData(T),
    TryFoldFailed, // transient state
    SenderWaitsForReceiverToConsume(T),
    SenderGone(Option<T>),
    ReceiverGone,
    AllGone,
    SenderDropping,   // transient state
    ReceiverDropping, // transient state
}
```

([libs/utils/src/sync/spsc_fold.rs L21](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/utils/src/sync/spsc_fold.rs#L21))

**容量 1 の単一生産者・単一消費者チャネルで、送信時に「既にある値と畳み込む」ことができる。**

普通のチャネルなら、要求は 1 個ずつ並ぶ。`spsc_fold` は、受信側がまだ取っていない値に対して新しい要求を「足し込める」。**キューに並べてから束ねるのではなく、キューの中で束ねる。**

これで、受信側が忙しい間に届いた要求が自然にバッチになる。**待ち時間を作らずにバッチ化する**という、この種の最適化の理想形になっている。忙しくなければバッチサイズは 1 で、レイテンシは増えない。

状態が 9 つあるのは、両端の drop を正しく扱うためだ。`transient` と注記された状態が 3 つあり、これらはロックを持っている間だけ存在する。

## バッチが切れる理由が全部メトリクスになっている

```rust title="pageserver/src/metrics.rs"
pub enum GetPageBatchBreakReason {
    BatchFull,
    NonBatchableRequest,
    NonUniformLsn,
    SamePageAtDifferentLsn,
    NonUniformTimeline,
    ExecutorSteal,
    #[cfg(feature = "testing")]
    NonUniformKey,
}
```

([pageserver/src/metrics.rs L1842](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/metrics.rs#L1842))

**「なぜバッチが切れたか」に 7 種類の理由があり、それぞれカウンタになっている。**

- `BatchFull` — 上限に達した。**健全**
- `NonBatchableRequest` — getpage 以外の要求が挟まった
- `NonUniformLsn` — LSN が揃っていない
- `SamePageAtDifferentLsn` — 同じページを違う LSN で要求された
- `NonUniformTimeline` — 別の timeline への要求
- `ExecutorSteal` — 実行側が先に取っていった。**健全**

**バッチサイズが小さいという症状に対して、原因が特定できる。** `BatchFull` が多いなら上限を上げればいいし、`NonUniformLsn` が多いならクライアント側の LSN の付け方に問題がある。

観測性の作り方として、これは「メトリクスを足す」ではなく「分岐に名前を付けて数える」という形になっている。**コード上の `else` に全部名前が付いている**と言ってもいい。

## LSN が揃っていなくてもよくする

```rust title="libs/pageserver_api/src/config.rs"
pub enum PageServiceProtocolPipelinedBatchingStrategy {
    /// All get page requests in a batch will be at the same LSN
    #[default]
    UniformLsn,
    /// Get page requests in a batch may be at different LSN
    ///
    /// One key cannot be present more than once at different LSNs in
    /// the same batch.
    ScatteredLsn,
}
```

([libs/pageserver_api/src/config.rs L335](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/config.rs#L335))

**`UniformLsn` はバッチが切れやすい。** compute の要求 LSN は last-written LSN から来るので、ページごとに違う ([どの LSN のページを要求するか](../last-written-lsn/))。

`ScatteredLsn` はキーごとに違う LSN を許す。制約は 1 つだけ — 「同じキーが違う LSN で 2 回入ってはいけない」。それが `SamePageAtDifferentLsn` として数えられている理由だ。

これを可能にしているのが `VersionedKeySpaceQuery` で、キー範囲ごとに LSN を持てる。**下層 (vectored read) の表現力を上げることで、上層 (バッチ化) の制約が緩む。**

## I/O の並行化にも段階がある

```rust title="libs/pageserver_api/src/config.rs"
pub enum GetVectoredConcurrentIo {
    /// The read path is fully sequential: layers are visited
    /// one after the other and IOs are issued and waited upon
    /// from the same task that traverses the layers.
    Sequential,
    /// The read path still traverses layers sequentially, and
    /// index blocks will be read into the PS PageCache from
    /// that task, with waiting.
    /// But data IOs are dispatched and waited upon from a sidecar
    /// task so that the traversing task can continue to traverse
    /// layers while the IOs are in flight.
    /// If the PS PageCache miss rate is low, this improves
    /// throughput dramatically.
```

([libs/pageserver_api/src/config.rs L346](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/pageserver_api/src/config.rs#L346))

**レイヤの探索は逐次のまま、データの I/O だけを別タスクに逃がす。**

探索を並行化しないのは、順序に意味があるからだ。新しいレイヤから順に見て、`will_init` が出たら止まる。先に古いレイヤを読んでも無駄になる可能性がある。

一方、**「このレイヤから読む」と決まった I/O は、次のレイヤの探索と並行してよい。** 索引ブロックの読み取りだけは探索タスクに残す (page cache に当たれば速いので、切り離すコストのほうが高い)。

**「順序に意味がある部分」と「ない部分」を切り分けて、後者だけ並行化する。**

## 接続の共有

[読み取りパス](../read-path/) で見た gRPC の注記に戻る。

```protobuf title="pageserver/page_api/proto/page_service.proto"
  // NB: a gRPC status response (e.g. errors) will terminate the stream. The
  // stream may be shared by multiple Postgres backends, so we avoid this by
  // sending them as GetPageResponse.status_code instead.
```

**1 本の接続を複数のバックエンドが共有する。** compute のバックエンドは数百あるので、1 バックエンド 1 接続にすると pageserver 側のファイルディスクリプタが枯れる。

共有の代償が、上のエラー処理と、バッチが切れる理由の `NonUniformTimeline` になる。**多重化すると、多重化した単位で影響が波及する。**

## 誤ルーティングを数える

```rust
    MISROUTED_PAGESTREAM_REQUESTS,
```

**「別の shard に行くべき要求が来た」ことを数えるカウンタ。** shard 構成が変わった直後や、compute が古い shard map を持っているときに起きる ([読み取りパス](../read-path/))。

正常時はゼロで、増えたら「compute の設定が古い」という診断になる。**分散システムでルーティングを分散させると、必ず「間違った宛先に来た」を数える必要が出る。**

## この先に効いてくること

- **キューの中で束ねる。** `spsc_fold` は、待ち時間を作らずにバッチ化する。忙しいときだけバッチが大きくなる。
- **分岐に名前を付けて数える。** バッチが切れる 7 つの理由が、そのまま診断になる。
- **下層の表現力を上げると、上層の制約が緩む。** LSN 混在バッチ。
- **順序に意味がある部分だけ逐次にする。** 探索は逐次、データ I/O は並行。
- **多重化の単位で影響が波及する。** エラーもバッチ切れも。
