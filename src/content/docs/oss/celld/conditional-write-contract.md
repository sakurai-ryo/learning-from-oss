---
title: "オブジェクトストレージの条件付き書き込みを信頼せず検証する"
description: "条件付き書き込みの失敗を「明確な拒否」と「書けたか分からない」に分け、後者はやみくもに再送せず読み直して確かめる。さらに、ストレージが本当に条件を守るかを、起動時に 4 回の実書き込みで検証する。"
sidebar:
  order: 3
---

## 何を学んだか

### どんな状況の話か

[前提知識](../basics/) で見たように、celld は「どのノードがどのセルを担当するか」を、S3 の条件付き書き込み (「無いときだけ作る」「読んだときの版から変わっていなければ上書きする」) だけで決めている。つまり、**ストレージが条件を正しく守ること**に安全性の全部を預けている。

ここには 2 つの落とし穴がある。

1. **返事が来ないとき、書けたかどうか分からない。** ネットワークが途中で切れると、書き込みは届いていないかもしれないし、届いて返事だけ失われたかもしれない。
2. **条件を受け付けるふりをして無視するストレージがある。** `If-Match` ヘッダを付けても、エラーにせずに黙って上書きする実装が存在する。その上で celld を動かすと、2 台が同じセルを担当する事故が、しかも静かに起きる。

### celld の答え

1 つ目に対して、celld は条件付き書き込みのエラーを二分する。**明確な拒否** (ストレージが「条件不成立」と答えた) と、**曖昧** (それ以外のエラー全部) だ。曖昧なときは「失敗した」と決めつけて再送しない。代わりにレコードを読み直して、自分の書き込みが届いていたかを確かめる。そして読み直しの回数に上限を置く。

2 つ目に対して、celld は起動時に自分のバケットへ 4 回の条件付き書き込みを送る。「作る → もう一度作る (拒否されるべき) → 更新する → 古い版で更新する (拒否されるべき)」の順で、**2 回が拒否されること**を確認する。拒否されなければ、そのストレージでは安全に動けないので起動しない。

## ソースコードのどこか

### 明確な拒否と曖昧なエラーの二分

[`crates/celld/bucket.rs#L149-L158`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/bucket.rs#L149-L158) が判定の全て。`object_store` クレートの `Error` のうち 2 種類だけを「きれいに負けた」とみなす。

```rust title="crates/celld/bucket.rs"
/// Whether a conditional write reached a provider-enforced conflict.
/// Azure reports a failed `If-None-Match` as `Precondition`, while some
/// stores report the same create conflict as `AlreadyExists`. Both are a
/// clean lost race. Every other error remains ambiguous.
fn is_clean_cas_rejection(error: &Error) -> bool {
    matches!(
        error,
        Error::Precondition { .. } | Error::AlreadyExists { .. }
    )
}
```

`put_cas` は戻り値の型でこの三分法を表す。`Ok(Some(token))` なら書けた、`Ok(None)` なら明確に拒否された、`Err` なら分からない ([`bucket.rs#L512-L570`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/bucket.rs#L512-L570))。

```rust title="crates/celld/bucket.rs"
/// `Ok(Some(new_token))` applied, `Ok(None)` cleanly rejected; any
/// other failure is ambiguous and stays an error.
pub async fn put_cas(&self, key: &str, body: impl Into<PutPayload>, token: Option<&str>)
    -> anyhow::Result<Option<String>> {
    // ...
    match self.cas_store.put_opts(...).await {
        Ok(result) => {
            // The write applied; a result without a usable token still
            // surfaces as `Err`, which callers already treat as "may
            // have committed" and reconcile.
            let token = self.backend.token(result.e_tag, result.version)
                .with_context(|| format!("conditional write ... applied without a CAS token"))?;
            Ok(Some(token))
        }
        Err(error) if is_clean_cas_rejection(&error) => Ok(None),
        Err(error) => Err(anyhow!(error).context(format!(
            "conditional write {}://{}/{key} may have committed", self.scheme(), self.name))),
    }
}
```

呼び出し側は `Result<Option<T>>` を受け取るので、「拒否」と「不明」を区別せずには扱えない。型が区別を強制している。

### CAS 用のクライアントは自動リトライを切る

`Bucket` は普通の読み書き用と条件付き書き込み用の 2 つのクライアントを持ち、後者はリトライ回数 0 で作る ([`bucket.rs#L132-L147`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/bucket.rs#L132-L147))。

```rust title="crates/celld/bucket.rs"
pub struct Bucket {
    store: Arc<dyn ObjectStore>,
    /// Conditional writes only, built with retries OFF: a retried CAS put
    /// can land on the first attempt's own token change and report a clean
    /// 412 — converting "may have committed" into a false rejection. The
    /// ambiguity must surface as `Err` so the caller reconciles.
    cas_store: Arc<dyn ObjectStore>,
    backend: StorageBackend,
    // ...
}
```

コメントの言っていることを噛み砕くとこうだ。1 回目の書き込みが実は成功していたとする。クライアントライブラリが自動で 2 回目を送ると、2 回目は「自分の 1 回目が変えた版」とぶつかって条件不成立 (412) になる。ライブラリはこれを「きれいに拒否された」として返すので、呼び出し側は「他のノードに負けた」と誤解する。本当は自分が勝っているのに。だからリトライは切って、「分からない」を「分からない」のまま呼び出し側に渡す。

### 曖昧なら読み直す。ただし回数に上限を置く

I/O 層は `Err` を `Failure::Ambiguous` にして決定コアへ渡す ([`crates/celld/actor.rs#L232-L238`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L232-L238))。コアは所有権レコードを読み直し、自分の名前が書かれていれば「実は成功していた」として進む。読み直してもまだ曖昧なら、もう一度。ただし最大 3 回 ([`crates/logic/lib.rs#L75-L90`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L75-L90), [`lib.rs#L3129-L3151`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L3129-L3151))。

```rust title="crates/logic/lib.rs"
/// An ambiguous compare-and-swap is re-read rather than retried blindly,
/// which is correct — it may have applied. But the re-read leads to
/// another acquire, and if that is ambiguous too the cycle repeats. With
/// no bound a persistently unanswered store turns a request that used to
/// hang into one that spins, which is worse: it burns a slot and an
/// object-store budget forever instead of merely waiting.
pub reconciles: u32,

/// How many times one claim may reconcile an ambiguous acquire before the
/// request is failed and the caller left to decide. Small: each pass is a full
/// read plus a write, and a store answering ambiguously three times running is
/// not about to start answering.
pub const MAX_ACQUIRE_RECONCILES: u32 = 3;
```

上限がないと、返事をしないストレージに対して「読む→書く→読む→書く」を永遠に繰り返し、ただ待つよりも悪い状態 (処理枠とストレージの利用枠を食い続ける) になる。3 回連続で答えないストレージが急に答え始めることはない、というのが 3 という数字の根拠だ。

タイムアウトも同じ原則で分類する ([`lib.rs#L1841-L1846`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L1841-L1846))。読み取りのタイムアウトは何も変えていないので「確定」、書き込みのタイムアウトは変えたかもしれないので「曖昧」。

### 起動時の 4 ステップ検証

[`bucket.rs#L723-L791`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/bucket.rs#L723-L791) の `cas_contract`。1 つのキーに対して 4 回書く。

```rust title="crates/celld/bucket.rs"
/// The four steps, against one key. Steps 2 and 4 must be rejected;
/// a store that applies either one cannot fence.
async fn cas_contract(&self, key: &str) -> anyhow::Result<CasVerdict> {
    // 1. A create on an absent key applies, and answers the token that
    //    steps 3 and 4 need.
    let Some(token) = self.put_cas(key, b"probe-create".to_vec(), None).await?
    else { return Ok(CasVerdict::Violation(...)); };
    // 2. A create over the object step 1 wrote must be rejected.
    if self.put_cas(key, b"probe-recreate".to_vec(), None).await?.is_some() {
        return Ok(CasVerdict::Violation(format!(
            "the store overwrote an object although the write was conditional on that object \
             being absent; the store accepts {precondition} and does not enforce it, so two \
             nodes can own one cell")));
    }
    // 3. An update that carries the current token applies, and that
    //    retires the token step 4 reuses.
    // 4. The token is stale now, so the update must be rejected. This
    //    step is the fencing contract itself.
    // ...
}
```

ステップ 2 は「もうあるのに作れてしまった」、ステップ 4 は「古い版なのに上書きできてしまった」を検出する。エラーメッセージが「2 台が 1 セルを担当できてしまう」と、何が起きるかまで書いているのに注目してほしい。

結果の扱いは [`crates/celld/fleet.rs#L166-L206`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/fleet.rs#L166-L206)。検証に失敗 (`Violation`) したら起動を拒否する。一方、曖昧な `Err` (通信エラー) は一時的なものかもしれないので、警告だけ出して起動する。

```rust title="crates/celld/fleet.rs"
/// The two probe outcomes get different answers on purpose. A violation
/// is a property of the store: it never clears, and a node that serves
/// anyway can share a cell with a second owner. Refusing to start turns
/// the restart loop such a store otherwise produces into one message.
///
/// An ambiguous error is not that. `put_cas` runs with retries off, so a
/// single slow or dropped connection at boot answers `Err`. The lease
/// machinery already handles a transient fault, and a node must not
/// refuse to start over one.
pub async fn probe_storage_before_serving(bucket: &Bucket, managed: bool) -> anyhow::Result<()> {
    match bucket.probe_cas_steps().await {
        Ok(CasVerdict::Conformant) => Ok(()),
        Ok(CasVerdict::Violation(reason)) => bail!("the bucket does not keep the conditional-write contract ..."),
        Err(error) => {
            tracing::warn!(error = format!("{error:#}"),
                "could not verify the bucket conditional write; starting anyway");
            Ok(())
        }
    }
}
```

呼び出し元 [`crates/celld/main.rs#L2233-L2239`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/main.rs#L2233-L2239) のコメントは「バケットの一覧取得が成功しても、条件付き書き込みが効く証明にはならない」と明言している。

### ストレージごとの方言は 1 つの enum に閉じ込める

S3 と Azure は etag、GCS は generation (世代番号) を版として使う。この違いは `StorageBackend` enum と 2 つのメソッドに閉じ込め、呼び出し側は版を不透明な `String` としてしか扱わない ([`bucket.rs#L63-L75`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/bucket.rs#L63-L75))。GCS に S3 の方言を使わない理由は、GCS が同じホストで S3 風のリクエストを受け付けつつ、`If-Match` を PUT には適用しないため ([`bucket.rs#L318-L345`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/bucket.rs#L318-L345))。エンドポイントの違いではなく方言の違いだ、とモジュールコメントが述べている。

## なぜそうなっているか

- **条件付き書き込みに対応しているかは、問い合わせても分からない。** [`bucket.rs#L676-L689`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/bucket.rs#L676-L689) のコメントと [`docs/fencing.md`](https://github.com/denoland/celld/blob/v0.3.0/docs/fencing.md) にある通り、ヘッダを受け取って無視するストレージが実在する (MinIO コミュニティ版、Backblaze B2、Hetzner、DigitalOcean Spaces は非対応と明記)。そういうストレージでは「2 台が 1 セルを担当する」という静かで遅い故障になるので、起動前に実際に書いて確かめるしかない。
- **リトライは「分からない」を「偽の拒否」に変える。** 上で見た通り。自動リトライは読み取りには便利だが、条件付き書き込みでは判断を狂わせる。
- **待つより空回りの方が悪い。** 曖昧→読み直し→また曖昧、を無限に繰り返すと、リクエストが「止まっている」のではなく「資源を食い続ける」状態になる。
- **「ストレージの性質」と「一時的な通信障害」は別の応答が要る。** 前者はいくら再起動しても直らないので、1 つのメッセージで止める。後者で起動を拒否すると、ネットワークが一瞬不安定なだけでノードが立ち上がらなくなる。

## どう活かすか

- 外部サービスへの書き込みで、エラーを「失敗」の一語で扱わない。**確定した失敗**と**結果不明**を型で区別する。`Result<Option<T>>` のように 3 状態を戻り値に載せると、呼び出し側が区別を忘れられない。
- 再実行すると結果が変わる書き込み (条件付き書き込み、決済、メール送信) では、クライアントライブラリの自動リトライを切る。リトライして良いのは、読み取りと、何度やっても同じ結果になる操作だけ。
- 結果不明のときは再送ではなく「読み直して現状を確かめる」を基本にし、その回数に上限を置く。
- 安全性が外部サービスの契約 (一意制約、条件付き書き込み、トランザクション分離) に依存するなら、ドキュメントを信じず起動時に実地で確かめる。「互換実装が複数ある」プロトコルではとくに効く。
- 検証の結果は「契約違反 (何度やっても直らない)」と「通信失敗 (一時的)」で応答を変える。前者は即座に止め、後者は起動を許す。
- 取り込むべきでない条件: 起動時に書き込み権限がない環境 (読み取り専用の認証情報) では、celld の `--read-only` のように検証を飛ばす経路が必要になる。
