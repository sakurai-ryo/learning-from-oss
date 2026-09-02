---
title: "なぜ Raft をそのまま使わなかったのか"
description: "safekeeper のプロトコルは Raft によく似ているが、同じではない。違いは 3 点あって、そのうち 2 点は「Postgres の WAL をそのまま保存する」という制約から来ている。TLA+ の仕様書の冒頭に、その差分がそのまま書いてある。"
group: "safekeeper — WAL の合意"
sidebar:
  order: 21
---

## 何を学んだか

Neon の TLA+ 仕様書の冒頭に、Raft との差分が箇条書きで書いてある。

```tla title="safekeeper/spec/ProposerAcceptorStatic.tla"
(*
  The protocol is very similar to Raft. The key differences are:
  - Leaders (proposers) are separated from storage nodes (acceptors), which has
    been already an established way to think about Paxos.
  - We don't want to stamp each log record with term, so instead carry around
    term histories which are sequences of <term, LSN where term begins> pairs.
    As a bonus (and subtlety) this allows the proposer to commit entries from
    previous terms without writing new records -- if acceptor's log is caught
    up, update of term history on it updates last_log_term as well.
*)
```

([safekeeper/spec/ProposerAcceptorStatic.tla L3](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/spec/ProposerAcceptorStatic.tla#L3))

差分は 2 つ、実装上さらに 1 つある。順に見ていく。

## 差分 1 — リーダーとストレージが分離している

Raft では、リーダーもフォロワーも同じ種類のノードだ。リーダーは自分のログにも書き、フォロワーにも複製する。障害時には、フォロワーの誰かがリーダーになる。

Neon では役割が固定されている。

- **プロポーザ = compute** — WAL を作る側。1 台だけ。ログは持たない (作った端から送る)
- **アクセプタ = safekeeper** — WAL を持つ側。3 台。自分から提案はしない

**プロポーザは safekeeper の中から選ばれない。** 誰が compute になるかは、合意プロトコルの外側 (制御プレーン) が決める。

これは Paxos では普通の見方で、TLA+ のコメントも "has been already an established way to think about Paxos" と言っている。しかし Raft から見ると大きな違いになる。

なぜこうなるか。**そもそも compute は 1 台しか動かせない。** Postgres のプライマリは 1 台で、xid の払い出しもロック管理もそこに集中している。safekeeper が「自分がプライマリになる」ことはあり得ない。Postgres ではないからだ。

つまり **選挙で決めるべきことがない**。合意プロトコルに残った仕事は、「新しいプロポーザが来たら、古いプロポーザを排除する」ことと「ログの整合を取る」ことだけになる。

`docs/rfcs/004-durability.md` はこの前提を、身も蓋もない言い方で置いている。

> First, assume that only one primary node can be running at a time. This can be achieved by Kubernetes or etcd or some cloud-provider specific facility, or we can implement it ourselves. (中略) For now, assume that there is a Magic STONITH Fairy that ensures that.

**「Magic STONITH Fairy がいると仮定する」。** プライマリの一意性は別レイヤの責任だと宣言している。そして重要なのは、**その妖精がサボっても壊れない**ことだ。2 台の compute が同時に走っても、term によって片方は WAL を書けなくなる。妖精は可用性のためにいるのであって、安全性のためではない。

## 差分 2 — ログレコードに term を打たない

Raft のログエントリは `(term, index, command)` の 3 つ組だ。term がエントリごとに付いている。

safekeeper が持っているのは **Postgres の WAL セグメントファイルそのもの**で、`pg_waldump` で読めるバイト列だ。ここに term を書き込む場所はない。書き込めば Postgres が読めなくなる。

代わりに、term の切り替え点だけを別に持つ ([term と epoch](../safekeeper-consensus/))。

**この選択は「WAL を素のまま保存する」という制約から来ている。** そしてその制約自体は、pageserver が普通の replication プロトコルで WAL を読めること、S3 に上げた WAL がそのまま災害復旧に使えること、`pg_waldump` でデバッグできることの対価になっている。

コメントが "As a bonus (and subtlety)" と呼ぶ性質もある。**過去の term のエントリを、新しいレコードを書かずにコミットできる。** Raft では、リーダーは自分の term のエントリを 1 つコミットするまで、過去の term のエントリをコミット済みと宣言できない (Raft 論文の Figure 8 問題)。term history 方式では、アクセプタの term history を更新するだけで `last_log_term` が上がるので、追加のレコードなしにこれが成立する。

TLA+ のコメントは、この規則を壊すとどうなるかまで書いている。

```tla title="safekeeper/spec/ProposerAcceptorStatic.tla"
\* Some ideas how to break it to play around to get a feeling:
\* - replace Quorum with BadQuorum.
\* - remove 'don't commit entries from previous terms separately' rule in
\*   CommitEntries and observe figure 8 from the raft paper.
\*   With p2a3t4l4 32 steps error was found in 1h on 80 cores.
```

**「規則を消せば Raft 論文の Figure 8 が再現する。80 コアで 1 時間、32 ステップで反例が出る」。** 仕様書に「壊し方」が書いてあるのは珍しく、そして実用的だ。仕様を触る人が、自分の変更が安全性を壊したかどうかを試せる。

## term history はあとから足された

term history は最初からあったわけではない。`docs/rfcs/013-term-history.md` が、その前の設計 (`epoch` だけを持つ) の欠陥を説明している。

> This makes our biggest our difference from Raft. In Raft, every log record is stamped with term in which it was generated; while we essentially store in `epoch` only the term of the highest record on this safekeeper (中略) It is not immediately obvious that this simplification is safe. I thought and I still think it is; model checking confirmed that. However, some details now make me believe it is better to keep full term switching history.

**「安全だと思っているし、モデル検査もそう言った。でも別の理由で完全な履歴を持つほうがいい」。**

その別の理由が、**分岐点が特定できないこと**だった。RFC は 5 台の safekeeper で具体的な履歴を作って示している。

```
A(t=1, e=1) 1.1 1.2 1.3 1.4
B(t=1, e=1) 1.1
C(t=3, e=2) 1.1 2.2 2.3
D(t=3, e=3) 1.1 2.2 2.3 3.4
E(t=3, e=1) 1.1
```

A は term 1 で 4 レコード書いたが、そのうちコミットされたのは `1.1` だけ。その後 C と D が term 2 で `2.2` `2.3` を書き、D が term 3 で `3.4` を書いた。

ここで A が復帰する。分岐点が分からないので、保守的に先頭から送り直し、最後にまとめて切り詰める、という案があった。その途中で何が起きるか。

```
A(t=1, e=1) 1.1 2.2 1.3 1.4
```

**A のログが、term 2 のレコードと term 1 のレコードが混ざった、存在しなかった履歴になる。** そして RFC はここから最悪のケースを導く。

> Now log of A is basically corrupted. Moreover, since ABE are all in epoch 1 and A's log is the longest one, they can elect P4 who will commit such log.

**A・B・E で過半数を取れてしまい、しかも A のログがいちばん長いので、この壊れたログがコミットされる。**

RFC の著者は、追加の制約を入れれば安全にできることも認めている。しかし、それを選ばなかった理由を 3 つ挙げる。

> - I don't like this kind of artificial barrier;
> - I also feel somewhat discomfortable about even temporary having intentionally corrupted WAL;
> - I'd still model check the idea.

**「一時的にであっても意図的に壊れた WAL を持つのは気持ち悪い」。** 形式的には安全にできるが、不変条件が弱くなる。「ディスク上の WAL は常に、ある 1 つの実行履歴と一致している」という強い性質を保ちたい、という判断だ。

そしてもう 1 つ、この RFC が挙げる代替案が面白い。

> Without term switching history we have to resort to sending again since the horizon and memcmp'ing records, which is inefficient and ugly. Or we can maintain full history and determine truncation point by comparing 'wrong' and 'right' histories -- much like pg_rewind does

**`pg_rewind` と同じことをやっている**という自覚がある。Postgres には、フェイルオーバー後に古いプライマリを新しいプライマリに追随させる `pg_rewind` があり、それはまさに「2 つの履歴を比べて分岐点を見つける」ツールだ。既存の道具に引き寄せて考えている。

## 差分 3 — 実装上の非対称

仕様に書かれていない実装上の差分もある。**safekeeper は互いに直接通信しない。**

Raft ではリーダーがフォロワーに AppendEntries を送るが、Neon ではプロポーザ (compute) が全 safekeeper に送る。safekeeper 同士の情報交換は、storage_broker という別の pub-sub を経由する ([5 つのコンポーネント](../architecture/))。

例外が `recovery.rs` で、これは safekeeper が他の safekeeper から WAL を引く経路だ ([取り残された safekeeper が追いつく](../safekeeper-recovery/))。compute が動いていないときにも追いつけるようにするために、後から足された。

## モデル検査は 2 本ある

`safekeeper/spec/` には 2 つの仕様がある。

- `ProposerAcceptorStatic.tla` (24KB) — メンバーが固定の場合
- `ProposerAcceptorReconfig.tla` (16KB) — メンバー変更を含む場合

そして仕様には、モデルの単純化が明記されている。

```tla title="safekeeper/spec/ProposerAcceptorStatic.tla"
\* Model simplifications:
\* - Instant message delivery. Notably, ProposerElected message (TruncateWal action) is not
\*   delayed, so we don't attempt to truncate WAL when the same wp already appended something
\*   on the acceptor since common point had been calculated (this should be rejected).
```

**「メッセージは即時配送されるものとした」。** つまり、遅延した `ProposerElected` が来たときの挙動はモデル検査されていない。実装側にはその検査があり ([term と epoch](../safekeeper-consensus/) の `bail!`)、コメントで「稀な競合で起きうる、再接続で直る」と説明されている。

**モデルが扱わない範囲を明記し、その範囲は実装のコメントで補う。** 形式手法を使うときの現実的な運用がここにある。

## 結論として何を得たか

| 判断                         | 得たもの                              | 失ったもの                                            |
| ---------------------------- | ------------------------------------- | ----------------------------------------------------- |
| リーダーとストレージを分ける | Postgres が 1 台という前提と整合      | safekeeper が自律的にフェイルオーバーできない         |
| term をレコードに打たない    | WAL が素のまま。`pg_waldump` が使える | term history という追加の状態と、その整合性           |
| safekeeper 同士を繋がない    | O(n²) 接続の回避                      | compute なしでは追いつけない (後から recovery を追加) |

**「Raft を使わなかった」というより、「Raft の前提が成り立たない場所で、Raft と同じ安全性を別の道具立てで作った」**という言い方が近い。そして実際、その安全性を TLA+ で確かめている。

## この先に効いてくること

- **プライマリの一意性は合意プロトコルの外にある。** 妖精がサボっても安全性は壊れない、という設計。
- **保存フォーマットの制約が、プロトコルの設計を規定する。** WAL を素のまま持つという要求が term history を生んだ。
- **一時的に不整合な状態を作らない、という不変条件を優先した。** 形式的に安全でも、弱い不変条件は選ばない。
- **仕様書に壊し方を書く。** 規則を消したら何が起きるか、何ステップで反例が出るかまで。
