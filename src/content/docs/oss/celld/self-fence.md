---
title: "リースの権限は「ストアに公開した期限」で判定し、失効したら自ら止まる"
description: "有効期限の起点は、書き込みが完了した時刻ではなく、レコードに書いた expires_ms を計算した時刻にする。期限が切れたノードはバケットに何も書かずに exit code 3 で止まり、supervisor に再起動させる。"
sidebar:
  order: 5
---

## 何を学んだか

### どんな状況の話か

[前提知識](../basics/) で見た通り、celld のノードは「わたしは生きている。有効期限は 10 秒後」というリースをバケットに書き、期限が来る前に書き直し続ける。他のノードは期限切れのリースを見たら、そのノードを死んだとみなしてセルを引き継ぐ。

ここで難しいのは、**自分のリースがいつ切れるかを、自分がどう知るか**だ。素朴には「書き込みが完了した時刻 + 10 秒」と考えたくなる。しかしバケットへの書き込みに 3 秒かかったら、他のノードが見る `expires_ms` は「書き始めた時刻 + 10 秒」なのに、自分は「書き終わった時刻 + 10 秒」だと思い込む。3 秒間、他のノードは自分を死んだ扱いできるのに、自分は担当を続けてしまう。

### celld の答え

1. **期限の起点は、`expires_ms` の値を決めた時刻。** 書き込み完了時刻ではない。他のノードはレコードの中の値しか見ないので、自分のタイマーもその値に合わせる。バケットが遅くても、その分だけ権限が延びることはない。
2. **タイマーは保険であって、安全性の根拠ではない。** リクエストが来るたびに「今の時刻 ≥ 期限」を評価して拒否する。VM が一時停止してタイマーが遅れて鳴っても、再開後のリクエストは正しく拒否される。
3. **「更新に失敗した」と「期限が切れた」は別。** 更新の通信が失敗しても、公開した期限がまだ来ていなければ再試行する。しかし更新の条件付き書き込みが拒否された (誰かがレコードを置き換えた) か、期限が過ぎたら、即座に止まる。
4. **止まるときはバケットに何も書かない。** 他のノードはリースの期限切れをすでに読めるので、「解放しました」と書く必要がない。ログに `SELF-FENCE:` を出して exit code 3 で終了し、systemd や Kubernetes のような supervisor に再起動させる。復帰は、他のノードが死んだときと同じコールドスタートの経路を通る。

## ソースコードのどこか

### 期限の起点

[`crates/logic/lib.rs#L311-L318`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L311-L318) の `PendingNodeLease::anchor_mono_ms` のコメント。

```rust title="crates/logic/lib.rs"
/// Authority is bounded by what the *bucket* says, and the bucket says
/// `expires_ms`, which is sampled here rather than when the write lands.
/// Anchoring the local fence deadline to the write's completion instead
/// would let this node serve for the whole duration of the round trip
/// after every peer is entitled to declare it dead -- the store is under
/// no obligation to answer quickly, so that window is unbounded.
anchor_mono_ms: u64,
```

「権限の範囲を決めるのはバケットが言うことで、バケットが言うのは `expires_ms` だ。だからその値をここでサンプルする。書き込み完了を起点にすると、往復時間のあいだ、他のノードが自分を死んだと宣言できるのに自分は処理を続けてしまう。ストレージが速く答える義務はないので、その窓は無限に広がりうる」。

`hold_node_lease` ([`lib.rs#L1541-L1581`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L1541-L1581)) では、更新タイマーを起点 + TTL/3、停止タイマーを起点 + TTL に置く。

```rust title="crates/logic/lib.rs"
let renew_after = if std::mem::take(&mut self.nudge_pending) {
    1
} else {
    (spec.ttl_ms / 3).max(1)
};
effects.push(Effect::ScheduleTimer {
    timer: Timer::NodeLeaseRenew { generation },
    at_mono_ms: anchor_mono_ms.saturating_add(renew_after),
});
// Exactly the published deadline. A peer treats the record as live
// while `expires_ms > now_ms`, so this node must have stopped serving
// by the time `now_ms` reaches `expires_ms` -- not one millisecond
// after it.
effects.push(Effect::ScheduleTimer {
    timer: Timer::NodeLeaseFence { generation },
    at_mono_ms: anchor_mono_ms.saturating_add(spec.ttl_ms),
});
```

TTL/3 で更新するのは、1 回の更新が失敗しても期限までに 2 回のやり直しの機会が残るようにするため。

更新の書き込みが、前のリースの期限を過ぎてから届いた場合も、延長にならず、停止する ([`lib.rs#L1484-L1493`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L1484-L1493))。

```rust title="crates/logic/lib.rs"
/// A renewal that lands at or after the PRIOR lease's expiry has not
/// extended anything: every peer was already entitled to read that record,
/// find it dead, and seize this node's cells, and one of them may have
/// begun doing exactly that. Rewriting `nodes/<node>.json` does not
/// retract a takeover already in flight -- the ownership compare-and-swap
/// a peer is about to issue is guarded on the ownership record's ETag,
/// which a resident owner never touches -- so resurrecting the lease here
/// is precisely how two nodes end up serving one cell. The gap is a fence,
/// not a hiccup.
```

「期限を過ぎてから届いた更新は何も延長していない。他のノードはもう自分のセルを奪い始めているかもしれず、リースを書き直してもそれは止まらない。ここでリースを生き返らせることが、まさに 2 台が 1 セルを担当する原因になる。この隙間は一時的な不調ではなくフェンスだ」。

### リクエストごとの判定

[`lib.rs#L577-L599`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L577-L599) の `node_authoritative`。全てのリクエストがここを通る ([`lib.rs#L2362-L2389`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L2362-L2389))。

```rust title="crates/logic/lib.rs"
/// Authority is the lease's published validity evaluated at ask time on
/// the monotonic clock — not the `Held` variant. A peer treats the record
/// as dead the instant `now_ms` reaches `expires_ms`, so a holder whose
/// lease lapsed must answer `false` here even if `Timer::NodeLeaseFence`
/// has not fired yet: the timer is the liveness backstop that halts the
/// process, never the safety mechanism. A suspended VM's timer fires
/// late, but a request evaluated after resume still refuses. The `<` /
/// `>=` polarity matches the fence timer at `handle_timer`, so the
/// predicate and the timer cannot disagree.
pub fn node_authoritative(&self) -> bool {
    // ...
    let fresh = |held: &HeldNodeLease| {
        self.now_mono_ms.saturating_sub(held.last_ok_mono_ms) < held.spec.ttl_ms
    };
    match &self.node_authority {
        NodeAuthority::Held(held) => fresh(held),
        NodeAuthority::Reading { pending, .. } | NodeAuthority::Writing { pending, .. } => {
            pending.prior.as_ref().is_some_and(fresh)
        }
        _ => false,
    }
}
```

「リースを持っている」という状態 (`Held`) ではなく、「今この瞬間、公開した期限の内側か」で判定する。タイマーが鳴る前でも、期限が過ぎていれば `false` を返す。

### 更新失敗と期限切れの分岐

[`lib.rs#L1716-L1775`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L1716-L1775) の `node_lease_cas_completed`。条件付き書き込みが `Rejected` (誰かがレコードを置き換えた) なら即座に停止、`Ambiguous` (書けたか分からない) なら読み直し、`Definite` な通信失敗なら前のリースに戻して TTL/3 後に再試行する。

タイマー側 ([`lib.rs#L1976-L1997`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L1976-L1997)) では、期限を過ぎてから届いた更新タイマーを更新の機会と見なさず、停止の合図として扱う。

```rust title="crates/logic/lib.rs"
// A renew timer that arrives after the lease it belongs to has
// already expired is not a renewal opportunity; authority is
// already gone. Fence rather than issue a write that could
// resurrect it behind a peer's in-flight takeover.
Timer::NodeLeaseRenew { generation }
    if generation == held.timer_generation
        && now_mono_ms.saturating_sub(held.last_ok_mono_ms) >= held.spec.ttl_ms =>
{
    self.fence_node(effects);
}
```

### 停止の実体

[`lib.rs#L2353-L2361`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L2353-L2361)。バケットへの effect は出さず、ローカルの後始末と `Halt` (プロセス終了) だけを出す。`NodeAuthority::Fenced` は `start_node_lease` が受け付けない状態なので、いったんここに入ると新しいリースは取れない。

```rust title="crates/logic/lib.rs"
fn fence_node(&mut self, effects: &mut Vec<Effect>) {
    self.node_authority = NodeAuthority::Fenced;
    self.fence(effects);
    effects.push(Effect::Halt {
        code: 3,
        reason: HaltReason::NodeLeaseExpired,
    });
}
```

実行側 [`crates/celld/actor.rs#L2494-L2508`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L2494-L2508) は、止まる前に理由を必ずログに出す。

```rust title="crates/celld/actor.rs"
Effect::Halt { code, reason } => {
    // Say why before going. Self-fencing is the most drastic thing
    // this process does, and an exit code on its own leaves an
    // operator to guess between a lease it could not renew, a
    // replicator that died, and a crash.
    match reason {
        celld_logic::HaltReason::NodeLeaseExpired => tracing::warn!(
            event = "node_lease_watchdog_fence",
            code,
            "SELF-FENCE: node lease not renewed within TTL — halting"
        ),
    }
    let _ = self.fence.send(code);
}
```

[`crates/celld/main.rs#L3007-L3034`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L3007-L3034) では、コアのアクターが異常終了した場合や複製プロセスが死んだ場合も同じ `SELF-FENCE:` の接頭辞と exit code 3 で扱い、`exit_flushed` でログを書き切ってから終了する。

## なぜそうなっているか

- **時計ではなくレコードが権限の源。** 他のノードが見るのは `expires_ms` だけ。自分の判断もそれに揃えないと、ストレージの遅延がそのまま「両方が担当だと信じる時間」になる。[`docs/fencing.md`](https://github.com/denoland/celld/blob/v0.3.0/docs/fencing.md) の "Self-fencing" 節は、更新失敗だけでは止まらない理由 (公開した期限までは再試行して良い) と、期限が過ぎたら止まる理由 (バケットに届かないノードは複製もできないので担当してはいけない) を対にして説明している。
- **「解放を書く」ことに引き継ぎを頼ると、いちばん必要なときに動かない。** 止まる必要があるのは典型的にはバケットに届かない状況だ。そこで「解放レコードを書く」ことを引き継ぎの条件にすると、まさにその状況で書けない。リースの期限切れそのものを引き継ぎの合図にすれば、止まる側は何もしなくてよい。
- **復帰経路を 1 本にする。** 止まった状態を終端にしてプロセスごと終了すれば、復帰は他ノードの障害時と同じコールドスタートになる。「停止からの復旧」という 2 本目の手順を作らずに済む。そのために `docs/fencing.md` は「試行回数に制限を付けず、リースの寿命以上の間隔で再起動する supervisor」を運用要件として明記している。

## どう活かすか

- リースや分散ロックを実装するときは、期限の起点を「レコードに書く値を決めた時刻」にする。書き込み完了時刻を起点にすると、ストレージの遅延分だけ安全でない時間が延びる。
- 期限切れの判定はタイマーに頼らず、権限を使う操作の入口 (リクエスト処理、書き込みの ack) で毎回評価する。タイマーは「止め忘れ」を防ぐ保険に留める。
- 「更新できない」と「期限が過ぎた」を分ける。前者は公開した期限まで再試行、後者は即座に停止。
- 自ら止まるプロセスは、exit code だけでなく理由をログに出す。同じ exit code を複数の原因で使うなら、なおさらメッセージで区別する。
- 「壊れたら止まって再起動される」設計にするなら、supervisor に求める条件 (回数制限なし、再起動間隔) をドキュメントに書く。
- 取り込むべきでない条件: プロセスの再起動が高価 (起動に分単位かかる、ウォームアップが要る) なサービスでは、「止まる = プロセス終了」という割り切りは可用性を大きく損なう。その場合は停止状態からリースを取り直す経路が要るが、その経路自体が新たな検証対象になる。
