---
title: "すでにログを持っているシステムに、Raft をどう実装するか"
description: "Kafka の Raft はリーダー選出こそ教科書どおりだが、複製はフォロワーが取りに行く pull 型になっている。この 1 点を変えたために「新リーダーの存在を知らせる RPC」が必要になり、代わりにログの切り詰め検出はフェッチに相乗りできるようになった。既存の資産に合わせてプロトコルを曲げた記録として読める。"
sidebar:
  order: 16
---

## 何を学んだか

### どんな状況の話か

[前のページ](../kraft-overview/) で見たとおり、`__cluster_metadata` の複製には Raft を使う。だが Kafka には、すでに次のものがあった。

- **追記専用のログ** ([セグメント](../log-segment/)、[インデックス](../sparse-index/)、[復旧](../log-recovery/))
- **pull 型の複製** ([フォロワーが Fetch する](../pull-replication/))
- **世代番号による切り詰め検出** ([leader epoch](../leader-epoch/))

一方、Raft の論文は **push 型**を前提にしている。リーダーが `AppendEntries` をフォロワーに送りつけ、それがハートビートも兼ねる。フォロワーは受け身だ。

**教科書どおりに実装すると、既存の資産をほとんど使えない。**

### Kafka の答え

**リーダー選出は Raft のまま、複製は pull 型にする。**

```java title="raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java"
/**
 * This class implements a Kafkaesque version of the Raft protocol. Leader election
 * is more or less pure Raft, but replication is driven by replica fetching and we use Kafka's
 * log reconciliation protocol to truncate the log to a common point following each leader
 * election.
 */
```

[`KafkaRaftClient.java#L129-L170`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java#L129-L170)。

**"Kafkaesque version of the Raft protocol"** — 自分でそう名乗っている。変更点は次のとおり。

1. **`AppendEntries` がない。** フォロワーが `Fetch` を送る。
2. **代わりに `BeginQuorumEpoch` が要る。** 「私が新しいリーダーです」を伝える手段がなくなったので。
3. **切り詰めの検出はフェッチに相乗りする。** Raft の `AppendEntries` の整合性チェックの代わり。
4. **状態が 6 つある。** 教科書の Follower/Candidate/Leader に、Unattached・Prospective・Resigned が加わる。
5. **voter と observer を分ける。** ブローカーは observer としてログを読むだけ。

## ソースコードのどこか

### RPC の一覧と、それぞれが要る理由

javadoc に 5 つの API が列挙されていて、**それぞれ「なぜ必要か」まで書いてある**。

```java title="raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java"
 * 2) {@link BeginQuorumEpochRequestData}: Sent by the leader of an epoch only to valid voters to
 *    assert its leadership of the new epoch. This request will be retried indefinitely for
 *    each voter until it acknowledges the request or a new election occurs.
 *
 *    This is not needed in usual Raft because the leader can use an empty data push
 *    to achieve the same purpose. The Kafka Raft implementation, however, is driven by
 *    fetch requests from followers, so there must be a way to find the new leader after
 *    an election has completed.
```

[`KafkaRaftClient.java#L145-L153`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java#L145-L153)。

**pull 型にした代償が、ここに 1 つの RPC として現れている。**

push 型なら、リーダーは空の `AppendEntries` を送るだけで「私がリーダーだ」を伝えられる。pull 型ではリーダーから何も送らないので、フォロワーは新リーダーが誰か分からない。だから `BeginQuorumEpoch` を足した。

**しかも「無限にリトライする」。** 1 人でも取りこぼすと、そのフォロワーは古いリーダーにフェッチし続けることになる。

代わりに得たものもある。

```java title="raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java"
 * 4) {@link FetchRequestData}: This is the same as the usual Fetch API in Kafka, but we add snapshot
 *    check before responding, and we also piggyback some additional metadata on responses (i.e. current
 *    leader and epoch). Unlike partition replication, we also piggyback truncation detection on this API
 *    rather than through a separate truncation state.
```

[`KafkaRaftClient.java#L155-L160`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java#L155-L160)。

**通常のパーティション複製では、フォロワーは `Truncating` と `Fetching` の 2 状態を持っていた** ([pull 型レプリケーションのページ](../pull-replication/))。KRaft では、フェッチの応答に切り詰め情報が乗るので、状態を分ける必要がない。

**同じ問題に対して、後から作ったほうがきれいになっている。** そして通常のパーティション側にも、後から `divergingEpoch` として同じ仕組みが逆輸入された。

5 つ目の API は、この章の[次のページ](../metadata-snapshot/) の話につながる。

```java title="raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java"
 * 5) {@link FetchSnapshotRequestData}: Sent by the follower to the epoch leader in order to fetch a snapshot.
 *    This happens when a FetchResponse includes a snapshot ID due to the follower's log end offset being less
 *    than the leader's log start offset.
```

[`KafkaRaftClient.java#L162-L166`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/KafkaRaftClient.java#L162-L166)。

### 6 つの状態

```java title="raft/src/main/java/org/apache/kafka/raft/QuorumState.java"
/**
 * This class is responsible for managing the current state of this node and ensuring
 * only valid state transitions. Below we define the possible state transitions and
 * how they are triggered:
 *
 * Resigned transitions to:
 *    Unattached:  After learning of a new election with a higher epoch, or expiration of the election timeout
 *    Follower:    After discovering a leader with a larger epoch
 *
 * Unattached transitions to:
 *    Unattached:  After learning of a new election with a higher epoch or after giving a binding vote
 *    Prospective: After expiration of the election timeout
 *    Follower:    After discovering a leader with an equal or larger epoch
 *
 * Prospective transitions to:
 *    Unattached:  After learning of an election with a higher epoch, or node did not have last
 *                 known leader and loses/times out election
 *    Candidate:   After receiving a majority of PreVotes granted
 *    Follower:    After discovering a leader with a larger epoch, or node had a last known leader
 *                 and loses/times out election
 *
 * Candidate transitions to:
 *    Unattached:  After learning of a new election with a higher epoch
 *    Prospective: After expiration of the election timeout or loss of election
 *    Leader:      After receiving a majority of votes
 *
 * Leader transitions to:
 *    Unattached:  After learning of a new election with a higher epoch
 *    Resigned:    When shutting down gracefully
 *    Follower:    After discovering a leader with a larger epoch
 *
 * Follower transitions to:
 *    Unattached:  After learning of a new election with a higher epoch
 *    Prospective: After expiration of the fetch timeout
 *    Follower:    After discovering a leader with a larger epoch
 *
 * Observers follow a simpler state machine. The Prospective/Candidate/Leader/Resigned
 * states are not possible for observers, so the only transitions that are possible
 * are between Unattached and Follower.
 */
public class QuorumState {
```

[`QuorumState.java#L36-L84`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/QuorumState.java#L36-L84)。

**この javadoc が状態機械の仕様そのものになっている。** 教科書の 3 状態に対して増えたのは 3 つ。

| 状態            | 意味                                             | なぜ要るか                                               |
| --------------- | ------------------------------------------------ | -------------------------------------------------------- |
| **Unattached**  | エポックは知っているが、リーダーが誰か分からない | 起動直後や、選挙が始まったがまだ決着していない状態を表す |
| **Prospective** | 立候補する前に「勝てそうか」を聞いて回っている   | **PreVote**。無駄な選挙でエポックを上げないため          |
| **Resigned**    | リーダーが自発的に降りている最中                 | 計画的なシャットダウンを速くするため                     |

**`Prospective` が PreVote の実装だ。** 素の Raft では、選挙タイムアウトが切れたノードは即座にエポックを上げて立候補する。すると次の問題が起きる。

- ネットワークから孤立したノードが、タイムアウトのたびにエポックを上げ続ける。
- 復帰したとき、そのノードのエポックが一番大きい。他の全員が「より新しいエポックを知った」として現在のリーダーを降ろす。
- **実際には正常に動いていたリーダーが、無関係なノードの復帰で降ろされる。**

PreVote は「エポックを上げずに、票をもらえるか聞く」段階を入れる。**過半数が『あなたに投票してもいい』と答えたときだけ、実際に立候補する。** 孤立していたノードは PreVote に失敗するので、エポックが上がらない。

`Resigned` も pull 型と関係している。リーダーが降りるとき、フォロワーは「フェッチのタイムアウト」でしかそれを検出できない。待つと数秒かかる。`EndQuorumEpoch` を送って即座に選挙を始めさせるための状態が `Resigned` だ。

**observer は 2 状態しかない。** ブローカーはログを読むだけなので、`Unattached` と `Follower` の間を行き来する。**同じクラスの中で、役割によって使う状態の部分集合が違う**という構造になっている。

### コミット位置の決め方

```java title="raft/src/main/java/org/apache/kafka/raft/LeaderState.java"
private boolean maybeUpdateHighWatermark() {
    // Find the largest offset which is replicated to a majority of replicas (the leader counts)
    ArrayList<ReplicaState> followersByDescendingFetchOffset = followersByDescendingFetchOffset()
        .collect(Collectors.toCollection(ArrayList::new));

    int indexOfHw = voterStates.size() / 2;
    Optional<LogOffsetMetadata> highWatermarkUpdateOpt = followersByDescendingFetchOffset.get(indexOfHw).endOffset;
```

[`LeaderState.java#L660-L666`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/LeaderState.java#L660-L666)。

**フェッチ offset の降順に並べて、真ん中を取る。** これが「過半数が持っている位置」になる。5 voter なら index 2 (0 始まり) で、上位 3 人が持っている位置だ。

[通常のパーティションが ISR 全員の最小値を取る](../isr-highwatermark/) のと対照的で、**同じ「high watermark」という語が、2 つの異なる計算をしている。**

そして Raft 特有の制約がある。

```java title="raft/src/main/java/org/apache/kafka/raft/LeaderState.java"
// The KRaft protocol requires an extra condition on commitment after a leader
// election. The leader must commit one record from its own epoch before it is
// allowed to expose records from any previous epoch. This guarantees that its
// log will contain the largest record (in terms of epoch/offset) in any log
// which ensures that any future leader will have replicated this record as well
// as all records from previous epochs that the current leader has committed.

LogOffsetMetadata highWatermarkUpdateMetadata = highWatermarkUpdateOpt.get();
long highWatermarkUpdateOffset = highWatermarkUpdateMetadata.offset();

if (highWatermarkUpdateOffset > epochStartOffset) {
```

[`LeaderState.java#L670-L680`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/LeaderState.java#L670-L680)。

**Raft 論文の Figure 8 の問題**への対処だ。新リーダーは「前のエポックのレコードが過半数に複製されている」だけではコミットしてはいけない。**自分のエポックのレコードを 1 件コミットするまで待つ。**

これがあるから、コントローラは選出されるとすぐ `NoOpRecord` のような自分のエポックのレコードを書く。**[前のページ](../kraft-overview/) で見た `NoOpRecord` の存在理由の 1 つがこれだ。**

### 投票の記録は必ずディスクへ

```java title="raft/src/main/java/org/apache/kafka/raft/FileQuorumStateStore.java"
public static final String DEFAULT_FILE_NAME = "quorum-state";
```

[`FileQuorumStateStore.java#L80`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/FileQuorumStateStore.java#L80)。

**「誰に投票したか」は、ログではなく専用のファイルに書かれる。** そして、投票を返す前に **必ずディスクに同期**される。

これは Raft の正しさに直結する。「1 エポックにつき 1 票」を守るには、投票した記録が再起動をまたいで残る必要がある。忘れて 2 回投票すると、2 人のリーダーが選ばれうる。

**[通常のログは既定で fsync しない](../log-segment/) のに、ここだけは fsync する。** 性能のために耐久性を弱める判断は、**弱めても壊れない場所にだけ適用されている。**

### voter を動的に変える

```java title="raft/src/main/java/org/apache/kafka/raft/VoterSet.java"
/**
 * A type for representing the set of voters for a topic partition.
 *
 * It encapsulates static information like a voter's endpoint and their supported kraft.version.
 *
 * It provides functionality for converting to and from {@code VotersRecord} and for converting
 * from the static configuration.
 */
public final class VoterSet {
```

[`VoterSet.java#L36-L45`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/raft/src/main/java/org/apache/kafka/raft/VoterSet.java#L36-L45)。

当初の KRaft は、voter の一覧を設定ファイル (`controller.quorum.voters`) に固定で書く方式だった。**コントローラを 3 台から 5 台に増やすには、全ノードの設定を書き換えて再起動する必要があった。**

KIP-853 で、**voter の集合もログに書かれるようになった** (`VotersRecord`)。`AddRaftVoter` / `RemoveRaftVoter` の RPC で動的に変えられる。

`raft/internals/` に `AddVoterHandler`、`RemoveVoterHandler`、`UpdateVoterHandler`、`VoterSetHistory` が並んでいるのは、この機能のためだ。**「メンバーシップの変更自体をログに書く」** のは Raft 論文の joint consensus と同じ発想で、変更の順序が全員で一致する。

## なぜそうなっているか

### 既存の資産に合わせてプロトコルを曲げた

pull 型にする判断は、次の 3 つを再利用するためだった。

| 再利用したもの         | 効果                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Fetch` API とその実装 | [ゼロコピー](../zero-copy/)、[フェッチセッション](../fetch-session/)、[purgatory](../purgatory/) がそのまま効く |
| ログのセグメント管理   | [復旧](../log-recovery/)、[インデックス](../sparse-index/)、保持期間の処理を書き直さない                        |
| observer の概念        | **ブローカーが「ただの遅れたフォロワー」になる**                                                                |

3 つ目が特に大きい。push 型の Raft では、状態機械の外にいるノードにログを配る仕組みを別に作ることになる。pull 型なら、**ブローカーは投票しないフォロワーとして、まったく同じ経路でログを読める。**

**「Raft を実装する」ではなく「Raft の合意部分だけを既存のログに載せる」**という切り分けが、この実装の設計判断だ。

### 曲げたことの代償

一方、代償もはっきりしている。

- **`BeginQuorumEpoch` という RPC が増えた。** しかも「無限にリトライする」という、素の Raft にはない挙動が要る。
- **リーダーがフォロワーの生存を能動的に確認できない。** フェッチが来ないことで検出する。
- **プロトコルが標準の Raft と違うので、既存の検証済み実装や形式手法の成果をそのまま使えない。**

`KafkaRaftClient` が 170 KB あり、クラスに `@SuppressWarnings({"ClassDataAbstractionCoupling", "ClassFanOutComplexity", "ParameterNumber", "NPathComplexity", "JavaNCSS"})` が付いているのは、この複雑さの表れでもある。**静的解析の警告を 5 種類抑制している。**

### なぜ PreVote を入れたのか

PreVote は Raft 論文の本文にはなく、著者の博士論文で議論されている拡張だ。実務では必須に近い。

問題は **「エポックを上げる」が破壊的な操作**だという点にある。エポックを上げたノードの主張を受け取ると、他の全員が現在のリーダーを見捨てる。**孤立したノード 1 台が、正常なクラスタを何度も選挙に巻き込める。**

`Prospective` 状態は「エポックを上げる前に、上げる価値があるか確認する」ための場所だ。**破壊的な操作の前に、可逆な問い合わせを 1 段挟む**という形になっている。

同じ発想は 2 相コミットの prepare フェーズや、ロックを取る前の `tryLock` にもある。

### なぜ「自分のエポックのレコードをコミットするまで待つ」のか

Raft 論文の Figure 8 が示すのは、**「過半数に複製されている」だけではコミットの安全性が保証されない**ということだ。

前のエポックのレコードが過半数にあっても、その後の選挙で別のノードがリーダーになり、そのレコードを上書きしうる。**自分のエポックのレコードを 1 件コミットすると、そのレコードを持っているノードしか次のリーダーになれなくなる**ので、以前のレコードも守られる。

コメントの説明が、この理屈をそのまま書いている。**理論的な制約が、コード中の `if (highWatermarkUpdateOffset > epochStartOffset)` という 1 行に落ちている。**

## どう活かすか

**「標準のプロトコルを、自分の資産に合わせて曲げる」判断は、慎重に、しかし恐れずにやる価値がある。** Kafka は Raft の複製方向を逆にした。得たのは既存実装の全面的な再利用で、失ったのは標準からの逸脱と 1 つの追加 RPC だ。**判断の分かれ目は「曲げる部分が、プロトコルの正しさに関わるか」にある。** リーダー選出と投票の永続化 (正しさに関わる部分) は素の Raft のままで、複製の駆動方向 (性能と実装の都合) だけを変えている。

**そのとき、「なぜ曲げたか」をコードに書き残すのが決定的に重要だ。** `BeginQuorumEpoch` の javadoc は「素の Raft では不要だが、我々は fetch 駆動なので必要」と明示している。**この 1 段落がないと、次の読み手は「なぜ Raft にない RPC があるのか」を理解できず、消してしまうかもしれない。** 標準からの逸脱には、必ず逸脱の理由を添える。

**「状態機械の仕様を javadoc に書き、コードでそれを守る」も真似できる。** `QuorumState` の 48 行のコメントは、そのまま状態遷移図になっている。**状態が 6 つ、遷移が 20 近くあると、コードを読んで遷移を復元するのは現実的でない。** 仕様を先に書いて、実装がそれに従う形にすると、レビューが「この遷移は仕様にあるか」で済む。

**「破壊的な操作の前に、可逆な問い合わせを 1 段挟む」は PreVote に限らず使える。** リソースの取得、スケールイン、キャッシュの無効化 — **やってしまうと戻せない操作の前に「やったら成功しそうか」を安く聞ける**なら、失敗のコストが下がる。

**「耐久性の保証を、必要な場所にだけ払う」という切り分けも持ち帰りたい。** Kafka はデータのログを fsync しないが、投票の記録は fsync する。**「全部速くする」でも「全部安全にする」でもなく、壊れたときに何が起きるかで場所ごとに決める。** その判断ができるのは、各データについて「失ったら何が壊れるか」を書き出したときだ。
