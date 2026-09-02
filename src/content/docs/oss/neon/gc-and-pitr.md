---
title: "GC と PITR — 消していいレイヤの決め方"
description: "レイヤを消す条件は 4 つの制約の最小値で決まる。保持バイト数、保持期間、子ブランチの分岐点、そしてクライアントが明示的に取ったリース。この 4 つが 1 つの LSN に畳み込まれる。"
group: "pageserver — ストレージ"
sidebar:
  order: 34
---

## 何を学んだか

レイヤファイルは不変なので、古くなったら消すしかない。しかし「古い」の定義が 1 つではない。

```rust title="pageserver/src/tenant/timeline.rs"
pub(crate) struct GcInfo {
    /// Specific LSNs that are needed.
    ///
    /// Currently, this includes all points where child branches have
    /// been forked off from. In the future, could also include
    /// explicit user-defined snapshot points.
    pub(crate) retain_lsns: Vec<(Lsn, TimelineId, MaybeOffloaded)>,

    /// The cutoff coordinates, which are combined by selecting the minimum.
    pub(crate) cutoffs: GcCutoffs,

    /// Leases granted to particular LSNs.
    pub(crate) leases: BTreeMap<Lsn, LsnLease>,

    /// Whether our branch point is within our ancestor's PITR interval (for cost estimation)
    pub(crate) within_ancestor_pitr: bool,
}
```

([pageserver/src/tenant/timeline.rs L484](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/timeline.rs#L484))

**「まだ必要な LSN」が 3 種類ある。** そして全部の最小値より前だけが消せる。

## 2 つの cutoff

```rust title="pageserver/src/tenant/timeline.rs"
pub(crate) struct GcCutoffs {
    /// Calculated from the [`pageserver_api::models::TenantConfig::gc_horizon`], this LSN indicates how much
    /// history we must keep to retain a specified number of bytes of WAL.
    pub(crate) space: Lsn,

    /// Calculated from [`pageserver_api::models::TenantConfig::pitr_interval`], this LSN indicates
    /// how much history we must keep to enable reading back at least the PITR interval duration.
    ///
    /// None indicates that the PITR cutoff has not been computed. A PITR interval of 0 will yield
    /// Some(last_record_lsn).
    pub(crate) time: Option<Lsn>,
}
```

([pageserver/src/tenant/timeline.rs L552](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/timeline.rs#L552))

**`space` はバイト数、`time` は時間。** 前者は「末尾から N バイト分の WAL は残す」、後者は「N 日前まで遡れるようにする」。

単位が違うものを同じ LSN 空間に写している。[LSN がシステム全体の論理時計になる](../lsn-as-clock/) で見たとおり、LSN はバイト位置でもあり順序でもあるので、両方の制約を同じ型で表せる。

`time` が `Option` なのが効いている。

```rust title="pageserver/src/tenant/timeline.rs"
impl GcCutoffs {
    fn select_min(&self) -> Lsn {
        // NB: if we haven't computed the PITR cutoff yet, we can't GC anything.
        self.space.min(self.time.unwrap_or_default())
    }
}
```

**PITR の cutoff を計算していなければ `Lsn(0)` になり、何も消せない。** 起動直後や、時刻 → LSN の変換に失敗したときに、うっかり全部消してしまうことを防いでいる。

`unwrap_or_default()` の `default` が `Lsn(0)` で、それが「最も保守的な値」になるように型が設計されている。**安全側の値がゼロ値と一致するようにしておくと、こういう省略記法が安全になる。**

## 子ブランチの分岐点

```rust title="pageserver/src/tenant/timeline.rs"
    pub(super) fn insert_child(
        &mut self,
        child_id: TimelineId,
        child_lsn: Lsn,
        is_offloaded: MaybeOffloaded,
    ) {
        self.retain_lsns.push((child_lsn, child_id, is_offloaded));
        self.retain_lsns.sort_by_key(|i| i.0);
    }
```

([pageserver/src/tenant/timeline.rs L507](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/timeline.rs#L507))

**子ブランチが分岐した LSN より前は消せない。** 子はそこまでの履歴を親と共有しているからだ ([ブランチがコピーオンライトで実質無料になる理由](../branching-cow/))。

削除にも注意書きがある。

```rust title="pageserver/src/tenant/timeline.rs"
        // Remove at most one element. Needed for correctness if there is two live `Timeline` objects referencing
        // the same timeline. Shouldn't but maybe can occur when Arc's live longer than intended.
```

**「同じ timeline を指す `Timeline` オブジェクトが 2 つ生きている可能性がある。起きないはずだが `Arc` が想定より長生きすると起きうる」。**

対処は「最大 1 個だけ削除する」。多重に登録されていても、1 回の削除で全部消さない。**保持理由を消しすぎるとデータを失うので、消し漏らす側に倒している。** 参照カウントの取り扱いとしては保守的だが、非対称なコストに対しては正しい。

## LSN リース — クライアントが保持を要求する

3 つ目が `leases` だ。static compute (過去の LSN に固定した読み取り専用 compute) が使う。

```rust title="pageserver/src/tenant/timeline.rs"
                    let latest_gc_cutoff_lsn = self.get_applied_gc_cutoff_lsn();
                    if lsn < *latest_gc_cutoff_lsn {
                        bail!(
                            "tried to request an lsn lease for an lsn below the latest gc cutoff. requested at {} gc cutoff {}",
                            lsn,
                            *latest_gc_cutoff_lsn
                        );
                    }
```

([pageserver/src/tenant/timeline.rs L1996](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/timeline.rs#L1996))

**既に GC された LSN のリースは取れない。** 当然だが、この検査があることで「リースを持っているのにデータがない」という状態が原理的に起きなくなる。

gRPC の API にも出てくる。

```protobuf title="pageserver/page_api/proto/page_service.proto"
  // Acquires or extends a lease on the given LSN. This guarantees that the Pageserver won't garbage
  // collect the LSN until the lease expires. Must be acquired on all relevant shards.
  rpc LeaseLsn (LeaseLsnRequest) returns (LeaseLsnResponse);
```

([pageserver/page_api/proto/page_service.proto L69](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/page_api/proto/page_service.proto#L69))

**「全 shard で取らなければならない」。** リースは shard ごとに独立しているので、1 つでも取り忘れるとそこだけ GC される。クライアント側の責任として明記されている。

リースには有効期限がある (`valid_until`)。**クライアントが死んでも、いずれ回収される。** 期限のない保持要求は、必ず漏れる。

## 2 つの cutoff LSN

紛らわしいが、cutoff を表す値が 2 つある。

```rust title="pageserver/src/tenant/timeline.rs"
    pub applied_gc_cutoff_lsn: Rcu<Lsn>,
```

```rust title="pageserver/src/tenant/timeline.rs"
    /// Read timeline's planned GC cutoff: this is the logical end of history that users are allowed
    /// to read (based on configured PITR), even if physically we have more history. Returns None
    /// if the PITR cutoff has not yet been initialized.
    pub(crate) fn get_gc_cutoff_lsn(&self) -> Option<Lsn> {
        self.gc_info.read().unwrap().cutoffs.time
    }
```

([pageserver/src/tenant/timeline.rs L1202](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/timeline.rs#L1202))

- **applied** — 実際に GC が走って、もう物理的にデータがない位置
- **planned** — ユーザーに約束している保持範囲

**「物理的にはまだあるが、論理的にはもうない」区間がある。** GC は非同期に走るので、設定を変えた直後などに乖離する。

ユーザーからの読み取り要求は planned で弾き、内部の整合性検査は applied を使う。**「まだ読めるかもしれない」を仕様にしないための分離**になっている。

`applied_gc_cutoff_lsn` の型が `Rcu<Lsn>` なのも意図がある。RCU (read-copy-update) は「読み手を待たせずに値を差し替え、古い値を参照している読み手が全員いなくなるまで待つ」構造だ。GC が cutoff を進めるとき、**その値を読んで動いている読み取り要求が終わるまで待ってから実際に消す。**

## GC と compaction の関係

[compaction](../compaction/) で見たとおり、image layer を作っても古いレイヤはすぐには消えない。GC が消す。

逆に、**image layer がないと GC は消せない。** 消してしまったら、そのキーの再構成の起点がなくなる。だから image compaction が先に走って床を作り、そのあと GC がその下を消す、という順序になる。

`gc_block.rs` (7KB) は、この順序を守るために GC を一時的に止める仕組みだ。shard split や timeline のインポート中など、レイヤ構成が動いている間は GC を走らせない。

## PITR の意味が Postgres と違う

Postgres の PITR は「ベースバックアップ + WAL アーカイブから、指定時刻まで redo する」ものだ。復元には時間がかかる。

Neon の PITR は「その LSN でブランチを作る」だけになる ([ブランチがコピーオンライトで実質無料になる理由](../branching-cow/))。データはもう全部あるので、コピーも redo も要らない。

**同じ機能名で、実装も所要時間もまったく違う。** そしてその代償が、この GC の複雑さになっている。「過去のどの時点でも読める」ことを維持するには、過去のデータを保持し続けなければならない。**PITR の保持期間を長くすると、そのまま S3 の容量になる。**

課金の話に直結するので、この量を測る仕組みが別にある ([synthetic size — 課金のためにサイズを定義し直す](../synthetic-size/))。

## この先に効いてくること

- **保持理由が複数あり、最小値を取る。** バイト数・時間・子ブランチ・リース。
- **安全側の値をゼロ値にしておく。** `unwrap_or_default()` が保守的な動作になる。
- **保持理由は消しすぎるより残しすぎるほうがマシ。** 非対称なコストに対する非対称な扱い。
- **保持要求には期限を付ける。** クライアントが死んでも回収される。
- **「約束した保持範囲」と「実際に残っている範囲」を分ける。** 偶然読めるものを仕様にしない。
