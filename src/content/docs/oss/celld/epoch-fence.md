---
title: "エポックをキーに埋め込み、データパスから条件付き書き込みを追い出す"
description: "所有権レコードだけを条件付き書き込みで守り、データの複製は `cells/<セル>/ltx/e<エポック>/` という、担当を外れたノードが触れないパスへ普通の PUT で書く。古いノードの書き込みは、誰も読まない場所に落ちる。"
sidebar:
  order: 4
---

## 何を学んだか

### どんな状況の話か

ノード A がセル X を担当していて、ネットワークが一瞬切れた。他のノードは A のリースが切れたのを見て「A は死んだ」と判断し、B が X を引き継いだ。ところが A は死んでおらず、ネットワークが戻ると何事もなかったように X への書き込みを続ける。この A を**古い所有者** (stale owner) と呼ぶ。

A の書き込みが B のデータを上書きしたら、B のデータは壊れる。これを防ぐ仕掛けを**フェンシング**と呼ぶ。素朴な方法は「全部の書き込みを条件付きにする」ことだが、[条件付き書き込みの検証](../conditional-write-contract/) で見た通り、条件付き書き込みはストレージ依存で扱いも重い。データの複製は高頻度に起きるので、毎回そのコストを払いたくない。

### celld の答え

**書き込み先のパスに、担当の世代番号 (エポック) を含める。**

- 所有権レコード `cells/X/own.json` は条件付き書き込みで守る。担当が決まるたびにエポックを +1 する。A が担当なら epoch 1、B が引き継げば epoch 2。
- データの複製は `cells/X/ltx/e<エポック>/` に、条件なしの普通の PUT で書く。A は `e1/` に、B は `e2/` に書く。
- 復元 (リストア) するときは、いちばん番号の大きいプレフィックスを読む。

A がいくら `e1/` に書き続けても、誰も `e1/` を読まない。A の書き込みは「拒否される」のではなく「届いても無害」になる。条件付き書き込みが必要なのは、セルごとに低頻度で起きる「担当の獲得」だけになった。

## ソースコードのどこか

### 所有権レコードとエポック

[`crates/logic/types.rs#L134-L140`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/types.rs#L134-L140)。`node: None` は「誰も担当していない」と明示的に解放されたレコードで、その場合もエポックは残す。

```rust title="crates/logic/types.rs"
pub struct OwnerRecord {
    /// `None` is a deliberately released, fenced record. Epochs never reset.
    pub node: Option<NodeId>,
    pub epoch: Epoch,
    pub etag: String,
}
```

担当を取るときのエポック加算は、所有権レコードを読んだあとの全ての分岐で `record.epoch.saturating_add(1)` になっている。自分が担当だったセルをメモリから落として再度立ち上げるときも加算する ([`crates/logic/lib.rs#L2695-L2709`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L2695-L2709))。レコードが無ければ「無いときだけ作る」条件で `epoch: 1` を書く ([`lib.rs#L2760-L2772`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/lib.rs#L2760-L2772))。

```rust title="crates/logic/lib.rs"
Ok(Some(record)) if record.node.as_deref() == Some(self.node.as_str()) => {
    let epoch = record.epoch.saturating_add(1);
    let prior = record.node.clone();
    self.activate_or_wait(
        &id,
        &mut cell,
        Activation::Claim(Claim {
            guard: CasGuard::Match(record.etag),
            epoch,
            takeover: false,
            prior,
            reconciles,
        }),
        effects,
    );
}
```

`CasGuard::Match(record.etag)` は「読んだときの版から変わっていなければ」の条件で、実際の書き込みは [`crates/celld/ownership_store.rs#L343-L361`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/ownership_store.rs#L343-L361) が `If-Match` ヘッダに変換する。

### データの保存先パス

[`crates/celld/replication.rs#L3-L7`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/replication.rs#L3-L7) のモジュールコメントが設計を一文で言い切っている。

```rust title="crates/celld/replication.rs"
//! Each cell db lives at
//! `<watch>/<cell>/ltx/e<epoch>/db.sqlite` and replicates to
//! `cells/<cell>/ltx/e<epoch>/` in the bucket — epoch-in-prefix is the
//! data-path fence: a stale owner writes a dead prefix.
```

「パスの中のエポックがデータ経路のフェンスだ。古い所有者は死んだプレフィックスに書く」。ローカルの DB パスとバケットのパスは同じ座標 (セル名、エポック) で組み立てる ([`crates/celld/ltx_repl.rs#L589-L602`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/ltx_repl.rs#L589-L602))。

```rust title="crates/celld/ltx_repl.rs"
/// A per-cell client over the shared store, keyed to the cell's epoch
/// prefix. `cells/<cell>/ltx/e<epoch>` matches [`Self::db_path`]'s remote
/// twin so the same coordinates address local and replica state.
fn client_for(&self, cell: &str, epoch: u64) -> ObjectStoreClient {
    // ...
    config.path = format!("{}cells/{cell}/ltx/e{epoch}", self.prefix);
```

セル名がそのままパスの一部になるので、[`crates/logic/cell.rs#L3-L10`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/cell.rs#L3-L10) では使える文字を厳しく制限し、それを "SECURITY fence" と呼んでいる。`../` のような文字列がセル名に入れば、フェンスは破れる。

### 復元は最新のプレフィックスを全部読む

[`docs/fencing.md`](https://github.com/denoland/celld/blob/v0.3.0/docs/fencing.md) の "Full-prefix restore" 節。以前の celld は、エポックごとに「ここまでが有効」という印 (seal オブジェクト) を書いて、復元の終端を固定していた。TLA+ (分散プロトコルを数学的に検査する道具) でモデル検査したところ、この印が防いでいたのは「ack していない書き込みが復活する」ことだけで、それは celld が防ぐと約束していない性質だった。逆に終端を固定すると、あとから正しく届いた ack 済みデータを読めなくなり、回復できたはずの状況を恒久的なデータ損失に変えていた。だから印は削除された。現在は LTX データを含む最新のエポックのプレフィックスを選び、最初から最後まで全部読む。

## なぜそうなっているか

- **条件付き書き込みは高価で、ストレージに依存する。** [条件付き書き込みの検証](../conditional-write-contract/) の通り、CAS 用クライアントは自動リトライを切る必要があり、曖昧なエラーの扱いも要る。毎回のデータ複製にこれを課すのは重い。担当の獲得だけに限定すれば、データ複製は普通のクライアントでリトライ付きの単純な PUT にできる。
- **古い所有者を止められない前提に立つ。** ネットワークの分断や VM の一時停止で、担当を外れたノードがそれに気づかず書き続ける時間は必ずある。「書かせない」のではなく「書いても届かない場所に書かせる」方が、タイミングに依存しない。
- **復元側が「どの系譜を読むか」を選べば十分。** 新しい担当は自分より古いエポックのプレフィックスを読み取り元にするだけで、古い担当の遅延書き込みは見えない。ただし [`docs/fencing.md`](https://github.com/denoland/celld/blob/v0.3.0/docs/fencing.md) は、古いプレフィックスに ack されなかった尾が残ることと、あとの復元がそれを読んでしまいうることも正直に書いている。「ack しなかった書き込みは必ず消える」とは約束していないので、契約違反ではない。

## どう活かすか

- リーダー選出やロックを持つシステムで、データ書き込みに毎回条件をつける代わりに、**リースの世代番号 (epoch / term / fencing token) をキー・パス・テーブル名に含める**ことを検討する。読む側が「今の世代のものだけ読む」ルールを持てば、古い書き手は自動的に無害になる。
- キーに埋め込む番号は単調に増やし、決してリセットしない。解放されたレコードにも番号を残す (`node: None`) ことで、次に担当する者が必ず大きい番号を取れる。
- ユーザー入力がパスの一部になるなら、その文字集合の制限はセキュリティの一部として扱う。
- 取り込むべきでない条件: 世代ごとにデータをフルコピーする方式なので、古い世代のデータ削除 (GC) の設計が別途要る。担当の交代が極端に頻繁なシステムでは、プレフィックスの増加そのものが問題になる。
