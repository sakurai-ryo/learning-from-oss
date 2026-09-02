---
title: "ディスクが足りなくなったとき — eviction と secondary location"
description: "pageserver のローカルディスクは S3 のキャッシュでしかない。溢れたら捨てる。しかし捨てすぎるとコールドスタートが遅くなる。そして「まだ何もしていないが、いつでも引き継げるノード」を暖めておく仕組みがある。"
group: "pageserver — 実行時"
sidebar:
  order: 43
---

## 何を学んだか

pageserver のローカルディスクにあるレイヤファイルは、S3 にも同じものがある ([remote_timeline_client](../remote-timeline-client/))。だから消してよい。必要になったら取り直す。

問題は**いつ、何を消すか**だ。

```rust title="pageserver/src/disk_usage_eviction_task.rs"
//! Each loop iteration uses `statvfs` to determine filesystem-level space usage.
//! It compares the returned usage data against two different types of thresholds.
//! The iteration tries to evict layers until app-internal accounting says we should be below the thresholds.
//! We cross-check this internal accounting with the real world by making another `statvfs` at the end of the iteration.
//! We're good if that second statvfs shows that we're _actually_ below the configured thresholds.
//! If we're still above one or more thresholds, we emit a warning log message, leaving it to the operator to investigate further.
```

([pageserver/src/disk_usage_eviction_task.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/disk_usage_eviction_task.rs#L1))

**アプリ内部の集計で「これだけ消せば足りるはず」と計算し、実際に `statvfs` で確かめる。** そして合わなければ警告を出して人間に渡す。

内部の集計が現実とずれる理由は色々ある。一時ファイル、他のプロセス、ファイルシステムのオーバーヘッド、削除されたが FD が開いたままのファイル。**「自分の帳簿だけを信じない」**という姿勢が、ループの構造として組み込まれている。

## 2 つの閾値

```rust title="pageserver/src/disk_usage_eviction_task.rs"
//! There are two thresholds:
//! `max_usage_pct` is the relative available space, expressed in percent of the total filesystem space.
//! If the actual usage is higher, the threshold is exceeded.
//! `min_avail_bytes` is the absolute available space in bytes.
//! If the actual usage is lower, the threshold is exceeded.
```

**相対値と絶対値の両方。** どちらか一方が破られたら圧力ありとする。

大きいディスクでは「90% 使用」でも残り 100GB あるので、絶対値のほうが緩い。小さいディスクでは逆になる。**片方だけだと、ディスクサイズが変わったときに意図しない挙動になる。**

## テナントごとの弱い予約

```rust title="pageserver/src/disk_usage_eviction_task.rs"
//! The iteration evicts layers in LRU fashion, but, with a weak reservation per tenant.
//! The reservation is to keep the most recently accessed X bytes per tenant resident.
//! If we cannot relieve pressure by evicting layers outside of the reservation, we
//! start evicting layers that are part of the reservation, LRU first.
```

**「弱い」予約。守れるなら守るが、足りなければ破る。**

そして既定値の決め方が面白い。

```rust title="pageserver/src/disk_usage_eviction_task.rs"
//! The per-tenant default value is the `max(tenant's layer file sizes, regardless of local or remote)`.
//! The idea is to allow at least one layer to be resident per tenant, to ensure it can make forward progress
//! during page reconstruction.
```

**「そのテナントの最大のレイヤファイル 1 つ分」。**

理由は前進保証だ。ページ再構成には複数のレイヤを読む必要がある。1 つ読んで、次を読もうとしたときに、最初のが追い出されていたら — そして再構成が最初に戻ったら — 永遠に終わらない。

**少なくとも 1 つは残せることを保証すれば、ライブロックは起きない。** キャッシュのサイズ下限が、アルゴリズムの停止性から決まっている。

命名についての注記も正直だ。

```rust
//! The value for the per-tenant reservation is referred to as `tenant_min_resident_size`
//! throughout the code, but, no actual variable carries that name.
```

**「コード中でそう呼ばれているが、その名前の変数は存在しない」。** 概念名と実装の対応が付かないことを、先に断っている。

## secondary location — 使わないが暖めておく

pageserver は shard ごとに 1 台しかいない。落ちたら別の台に付け替えるが、その台にはレイヤが 1 つもない。**全部を S3 から取り直すと、数分から数十分かかる。**

そのための仕組みが secondary location だ。

```rust title="pageserver/src/tenant/secondary.rs"
// Whereas [`Tenant`] represents an attached tenant, this type represents the work
// we do for secondary tenant locations: where we are not serving clients or
// ingesting WAL, but we are maintaining a warm cache of layer files.
```

([pageserver/src/tenant/secondary.rs L78](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/secondary.rs#L78))

**クライアントにも応答しないし、WAL も取り込まない。レイヤファイルを持っているだけ。**

レプリカではないことに注意したい。secondary は WAL を処理しないので、状態を持たない。持っているのはファイルのコピーだけだ。**「計算の冗長化」ではなく「キャッシュの事前配置」**になっている。

これで済むのは、[generation 番号](../generations-and-deletion/) が split brain を防いでいるからだ。secondary は書き込まないので、attach するまで何の危険もない。**書かない複製は、調整が要らない。**

## heatmap — 何を暖めるかを primary が教える

secondary が何をダウンロードすべきかは、primary が S3 に置くファイルで伝える。

```rust title="pageserver/src/tenant/secondary/heatmap.rs"
pub(crate) struct HeatMapLayer {
    pub(crate) name: LayerName,
    pub(crate) metadata: LayerFileMetadata,

    #[serde_as(as = "TimestampSeconds<i64>")]
    pub(crate) access_time: SystemTime,

    #[serde(default)]
    pub(crate) cold: bool, // TODO: an actual 'heat' score that would let secondary locations prioritize downloading
                           // the hottest layers, rather than trying to simply mirror whatever layers are on-disk on the primary.
}
```

([pageserver/src/tenant/secondary/heatmap.rs L48](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/secondary/heatmap.rs#L48))

**現状は「primary のディスクにあるものをそのまま真似る」**だけで、TODO が「本当の熱スコアがあれば、熱い順にダウンロードできるのに」と書いている。

`cold` という bool だけがあり、連続値のスコアはない。**二値の近似から始めて、必要になったら精緻化する**という順序になっている。

通信の設計にも工夫がある。

```rust title="pageserver/src/tenant/secondary/heatmap.rs"
    /// Uploaders provide their own upload period in the heatmap, as a hint to downloaders
    /// of how frequently it is worthwhile to check for updates.
    ///
    /// This is optional for backward compat, and because we sometimes might upload
    /// a heatmap explicitly via API for a tenant that has no periodic upload configured.
    #[serde(default)]
    pub(super) upload_period_ms: Option<u128>,
```

**「自分はこの周期で更新している」をデータの中に入れる。** 受け取る側は、それより頻繁にポーリングしても意味がないと分かる。

これは設定の配布問題を回避する巧い手だ。primary と secondary の両方に同じポーリング間隔を設定するのではなく、**データ自身が更新頻度を名乗る。** 設定が 1 か所で済み、ずれない。

generation も入っている。

```rust title="pageserver/src/tenant/secondary/heatmap.rs"
    /// Generation of the attached location that uploaded the heatmap: this is not required
    /// for correctness, but acts as a hint to secondary locations in order to detect thrashing
    /// in the unlikely event that two attached locations are both uploading conflicting heatmaps.
    pub(super) generation: Generation,
```

**「正しさには不要。2 つの attached location が矛盾する heatmap を上げている場合に、スラッシングを検出するためのヒント」。**

split brain の間、2 つの primary が別々の heatmap を上げる。secondary が交互に追いかけると、無駄なダウンロードを繰り返す。**正しさは generation で守られているが、無駄は守られていない。** その無駄を検出するために、同じ generation を別の目的で使っている。

## secondary も eviction の対象

```rust title="pageserver/src/tenant/secondary.rs"
use crate::disk_usage_eviction_task::DiskUsageEvictionInfo;
```

**secondary が持っているレイヤも、ディスクが足りなくなれば捨てられる。** 当然だが、優先度としては attached より低くていい。

secondary は 2 つのメトリクスを持っている。

```rust title="pageserver/src/tenant/secondary.rs"
    // Sum of layer sizes on local disk
    pub(super) resident_size_metric: UIntGauge,

    // Sum of layer sizes in the most recently downloaded heatmap
    pub(super) heatmap_total_size_metric: UIntGauge,
```

**「今持っている量」と「持つべき量」。** この 2 つの比が、そのまま「どれだけ暖まっているか」になる。フェイルオーバーの所要時間を予測する材料でもある。

## この先に効いてくること

- **自分の帳簿を信じず、現実 (`statvfs`) と突き合わせる。** 合わなければ人間に渡す。
- **相対値と絶対値の両方で閾値を持つ。** 規模が変わっても意図が保たれる。
- **キャッシュのサイズ下限は、アルゴリズムの停止性から決まる。**
- **書かない複製は調整が要らない。** secondary は generation の保護下で無害。
- **データ自身が更新頻度を名乗る。** 設定の配布問題を回避する。
