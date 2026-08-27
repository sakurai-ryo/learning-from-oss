---
title: "書き込みの応答を耐久性の証明まで保留し、証明の種類で確認手順を変える"
description: "書き込み自体はローカル SQLite に同期的に済ませ、クライアントへの返事だけを止める。複製先がバケットなら、返事の前に所有権レコードを読み直して自分がまだ担当か確かめる。複製先がフォロワー群 (全員 fsync 済み) なら、その確認は要らない。"
group: "分散協調の設計"
sidebar:
  order: 6
---

## 何を学んだか

### どんな状況の話か

クライアントがセルにデータを書き、サーバーが「保存しました」(ack) と返した直後に、そのサーバーのディスクが壊れたとする。データがローカルにしかなければ消える。celld は「ack したデータは 1 件も失わない」(RPO=0) を約束しているので、これは許されない。

素朴な解決は「バケットへの複製が終わるまで書き込み処理を止める」ことだが、Cloudflare の Durable Objects はストレージ書き込みを同期的に扱う API なので、そこで待つと互換性が壊れる。

もう 1 つ落とし穴がある。複製がバケットに届いたとしても、その間に自分が担当を外されていたら、[エポックフェンス](../epoch-fence/) の仕組みで自分の書き込みは誰も読まない古いプレフィックスに落ちている。「バケットに書けた」だけでは「保存された」とは言えない。

### celld の答え

**書き込みは止めず、クライアントへの返事だけを止める。** ハンドラは SQLite に同期的に書いて次に進む。返事は「出力ゲート」に預けられ、複製の証明が届くまで出ていかない。

証明には 2 種類あって、扱いが違う。

- **バケット証明**: 複製データ (LTX セグメント) をバケットに PUT できた。ただしバケットは古い書き手を拒否できないので、返事の前に所有権レコードを **1 回 GET** して、自分がまだその世代の担当であることを確かめる。時計を見るのではなくレコードを読むので、一時停止したプロセスや時計のズレでは通らない。
- **フリート証明**: 別の仕組み (ノードログ) で、他のノードのフォロワー全員が fsync した。引き継ぎのときにフォロワーを先に「封印」するので、古い担当の「全員 ack」は構造的に失敗する。よって再読は要らない。

同じセルへの同時の書き込みは 1 回のアップロードに相乗りする。「1 書き込み = 1 往復」ではない。

## ソースコードのどこか

### ゲートの実体はコアにある

`crates/logic/gate.rs` は名前に反して**入力ゲート** (`blockConcurrencyWhile`、セルへの同時アクセスを止める機能) で、出力ゲートは [`crates/logic/lib.rs#L205-L235`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L205-L235) の `GatedWrite` と、それを溜める `gated_writes` フィールドにある。

```rust title="crates/logic/lib.rs"
/// One local write held open by the output gate.
struct GatedWrite {
    owner: GateOwner,
    cell: CellId,
    epoch: Epoch,
    position: u64,
    /// Read-only responses that finished after this write committed but before
    /// its durability proof completed. They reveal the same state, so they
    /// share the write's verdict.
    followers: Vec<RequestId>,
}
```

`followers` は、この書き込みの後に完了した読み取り専用リクエストの一覧。読み取りは書き込み後の状態を見ているので、書き込みの証明が失敗したら読み取りの返事も出してはいけない。

書き込みの登録 [`lib.rs#L3983-L4023`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L3983-L4023)。セルがその世代で常駐していなければ、証明できないので ack せず失敗にする。

```rust title="crates/logic/lib.rs"
/// Open the output gate for a local write: hold its response until the
/// cell's committed `position` is proven replicated. The request must still
/// be a live local activity on its cell, resident at the epoch that
/// committed the write; otherwise durability cannot be proven for it and
/// the response fails rather than falsely acknowledging the write.
fn wrote(&mut self, request: RequestId, position: u64, effects: &mut Vec<Effect>) {
    // ...
    let Some((cell, epoch)) = held else {
        effects.push(Effect::ReleaseResponse {
            request,
            result: Err(RequestError::DurabilityUnproven),
        });
        return;
    };
    let op = self.op();
    self.gated_writes.insert(op, GatedWrite { owner: GateOwner::Request(request), cell: cell.clone(), epoch, position, followers: Vec::new() });
    effects.push(Effect::AwaitDurable { op, cell, epoch, position });
}
```

### 証明の種類で分岐する

[`crates/logic/types.rs#L292-L300`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/types.rs#L292-L300) の `ProofSource` と、[`lib.rs#L4047-L4076`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L4047-L4076) の `durable_reached`。

```rust title="crates/logic/types.rs"
/// Which mechanism proved a gated write durable. The fences differ: the
/// fleet's follower ensemble arbitrates (a takeover seals a member first),
/// the bucket only stores — so bucket proofs verify ownership before any
/// reveal and fleet proofs need not; a TLA+ spec checks the pair.
pub enum ProofSource { Fleet, Bucket }
```

「フォロワー群は仲裁する (引き継ぎは先にメンバーを封印する) が、バケットはただ保存するだけ。だからバケット証明は返事の前に所有権を確認し、フリート証明はしない」。

```rust title="crates/logic/lib.rs"
let proven = matches!(result, Ok(durable) if durable >= gate.position);
// A bucket proof reveals nothing until C1 confirms the record still
// names this node at this epoch: "durable in `e<epoch>/`" is not
// durable if the prefix was orphaned, and the bucket cannot refuse a
// stale writer. A fleet proof needs no read — the ensemble
// arbitrated it (a takeover seals a member before restoring, so a
// stale owner's ack-all fails closed; CelldAckFence.tla).
if proven && source == ProofSource::Bucket {
    let (cell, epoch) = (gate.cell.clone(), gate.epoch);
    effects.push(Effect::VerifyOwnership { op, cell, epoch });
    return;
}
self.settle_gate(op, proven, effects);
```

1 行目にも注目してほしい。証明された位置が書き込みの位置に**届いていない**なら失敗にする。遅れている、あるいは嘘をつく複製器が返した短い証明で ack しない。

### 所有権の再読は 1 回の GET で足りる

[`crates/celld/actor.rs#L2276-L2313`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L2276-L2313)。条件付き書き込みではなく読み取りで良い理由が書かれている。

```rust title="crates/celld/actor.rs"
Effect::VerifyOwnership { op, cell, epoch } => {
    // C1 for bucket-proof acks. Durable in `e<epoch>/` is not
    // the same as durable: if the cell has been taken over, that
    // prefix is orphaned — the next owner restores a higher
    // epoch and this write is gone. A read is enough, and is why
    // this is one GET rather than a compare-and-swap: if the
    // record still names us, no takeover linearised before this
    // read; the LTX went up before it; so any later takeover
    // restores from a lineage that already contains the write.
    // ...
    let result = match ownership.read_owner(&cell).await {
        Ok(Some(record))
            if record.node.as_deref() == Some(node.as_str())
                && record.epoch == epoch =>
        {
            Ok(())
        }
        Ok(record) => {
            eprintln!("celld output gate: {cell} epoch {epoch} is no longer ours ...");
            Err(Failure::Definite)
        }
        Err(failure) => Err(failure),
    };
```

理屈はこうだ。複製データは、この GET より**前**にバケットへ届いている。GET の結果、レコードがまだ自分を指していたなら、この GET より前に引き継ぎは起きていない。つまり、これから起きるどんな引き継ぎも、すでにこの書き込みを含んだデータから復元する。だから読むだけで十分。

### 証明できなかったらセルをリセットする

[`lib.rs#L4155-L4161`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L4155-L4161)。証明できなかった書き込みをメモリに残すと、次の読み取りがそれを返してしまい、「保存できませんでした」と言った直後に「保存されています」と答える矛盾が起きる。だから常駐のまま残さず、セルをメモリから落とす。

### 同時の書き込みは 1 回のアップロードに相乗りする

[`crates/celld/ltx_repl.rs#L848-L903`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/ltx_repl.rs#L848-L903) の `await_durable`。書き込みの位置ではなく、**整理券 (ticket) の番号**で待つ。

```rust title="crates/celld/ltx_repl.rs"
/// The output gate's primitive: take a durability ticket and return once a
/// background sync that captured this write has completed, coalescing
/// concurrent writes to one cell into a single upload. The write committed
/// before this call, so any sync starting after our ticket captures it —
/// we wait for `synced_seq >= my ticket`, not for a position, sidestepping
/// the total_changes↔LTX-txid mismatch that a position compare would hit.
pub async fn await_durable(&self, cell: &str, epoch: u64, position: u64)
    -> anyhow::Result<(u64, celld_logic::ProofSource)> {
    let ticket = handle.req_seq.fetch_add(1, Ordering::SeqCst) + 1;
    // ...
    loop {
        // Register the waiter before checking, so a sync that completes
        // between the check and the await is not missed. Either proof
        // releases the gate: the bucket upload, or every ensemble
        // member's fsync — whichever lands first.
        let ready = handle.ready.notified();
        // Prefer the fleet proof when both hold: it is the arbitrated
        // one, and it spares the caller C1's ownership read.
        let shipped = handle.shipped_seq.load(Ordering::SeqCst) >= ticket;
        if handle.synced_seq.load(Ordering::SeqCst) >= ticket || shipped {
```

整理券を取ってから、「自分の番号以上まで同期が終わった」と通知されるのを待つ。同期側 ([`ltx_repl.rs#L1206-L1213`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/ltx_repl.rs#L1206-L1213)) は、アップロードを始める**前**に発券済みの番号を読む。書き込みは整理券を取る前にコミット済みなので、「同期開始前に発券された番号は全部含まれる」と言える。同期中に発券された番号は次の同期で処理する。

### 「書いたかどうか」の検出

[`crates/celld/storage.rs#L776-L786`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/storage.rs#L776-L786)。ハンドラの前後で SQLite の `total_changes` (変更行数の累計) と schema cookie (スキーマの版) の和を比べ、増えていれば書き込みとみなす。`deleteAll()` や DDL は行変更を伴わないので、schema cookie を足して書き込みとして扱う ([`storage.rs#L762-L766`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/storage.rs#L762-L766))。

### 無効化できる

[`crates/celld/main.rs#L2581-L2584`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L2581-L2584)。`CELLD_OUTPUT_GATE=0` にすると、複製を待たずに返事を返す。「ack した書き込みを失いうる」ことを運用者が明示的に受け入れるスイッチで、コアとシミュレーションのゲートは無条件のまま残る。

## なぜそうなっているか

- **書き込みを止めると Durable Objects の互換性が壊れる。** Cloudflare の DO はストレージ書き込みを同期的に扱い、返事を耐久性確認まで保留する (出力ゲート)。celld は互換ランタイムなので同じ形にする必要があった。
- **バケットは古い書き手を拒否できない。** [エポックフェンス](../epoch-fence/) で古い担当の書き込みは無害化されるが、それは「新しい担当のデータを壊さない」だけで「古い担当が ack して良い」ことにはならない。`e<epoch>/` に書けたことと、その世代が現役であることは別。だから ack 前にレコードを読む。
- **フォロワーの封印は仲裁になる。** [`crates/celld/node_log.rs#L828-L849`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/node_log.rs#L828-L849) でフォロワーは封印マークを**応答前に**ディスクへ永続化し、以後その世代への追記を永久に拒否する。引き継ぎはこれを先に行うので、古い担当が「全員に届いた」を得ることは構造的にできない。仲裁する側がいるなら、バケット証明のような外部確認は不要になる。
- **整理券で待つ理由。** SQLite の `total_changes` と複製データ (LTX) の txid は 1 対 1 に対応しないので、位置の比較では「この同期に私の書き込みが含まれるか」を正確に判定できない。「私の整理券より前に始まらなかった同期が完了した」なら含まれると言える。

## どう活かすか

- 「保存したと言ったら失わない」という要件があるとき、書き込み経路を同期にするのではなく**返事の経路を止める**設計を検討する。ハンドラのロジックは変えず、返事を返す直前に 1 つの await を入れるだけで済む。
- 証明の出所によって確認手順を変える。「ストレージに書けた」と「その書き込みが現役の系譜にある」は別の事実で、外部ストレージが古い書き手を拒否できないなら後者を別途確かめる。
- 確認は条件付き書き込みより読み取りで済むことが多い。「レコードがまだ自分を指しているなら、この読み取りより前に引き継ぎは起きていない」という順序の議論を書き残しておくと、後から CAS に変えたくなる誘惑を防げる。
- 証明できなかった書き込みは「失敗させる」だけでなく、**キャッシュからも消す**。さもないと次の読み取りが未証明の状態を返し、システムが自分の返事と矛盾する。
- 同時の書き込みを 1 回のフラッシュに相乗りさせるときは、位置ではなく単調増加の整理券で待つ。「フラッシュ開始前に発券した番号は全部含まれる」という単純な規則で正しさが保てる。
- 取り込むべきでない条件: レイテンシ要件がストレージ往復より厳しく、ack の損失を許容できるワークロード。celld も `CELLD_OUTPUT_GATE=0` で明示的にその選択ができるようにしている。
