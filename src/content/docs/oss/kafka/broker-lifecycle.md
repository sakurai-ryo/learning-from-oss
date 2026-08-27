---
title: "ハートビートと fencing で、ZooKeeper のセッションを置き換える"
description: "ZooKeeper のエフェメラルノードは「接続が切れたら消える」を無料で提供していた。KRaft はそれを自前のハートビートで作り直している。面白いのは、ブローカーが起動してすぐには書き込みを受け付けないこと、そしてハートビートの受付だけが単一スレッド設計の例外になっていることだ。"
sidebar:
  order: 21
---

## 何を学んだか

### どんな状況の話か

ZooKeeper 時代、ブローカーの生死は **エフェメラル znode** で表現されていた。ブローカーが `/brokers/ids/1` を作り、セッションが切れると ZooKeeper が自動的に消す。コントローラは watch でそれを知る。

**「接続が切れたら登録が消える」を、ZooKeeper が無料で提供していた。**

KRaft にはそれがない。コントローラとブローカーの間にあるのは、メタデータログと RPC だけだ。生死の判定を自分で作る必要がある。

さらに、ZooKeeper 時代には無かった要求もある。

- **起動直後のブローカーは、まだメタデータに追いついていない。** その状態でリーダーにされると、古い情報で動くことになる。
- **[ローカルログの復旧](../log-recovery/)に時間がかかることがある。** 復旧中に書き込みを受け付けてはいけない。

### Kafka の答え

**ブローカー自身が状態機械を持ち、コントローラに定期的にハートビートを送る。**

1. **`BrokerRegistration` で登録し、broker epoch をもらう。** 世代番号。
2. **ブローカーは 5 つの状態を持つ。** `STARTING` → `RECOVERY` → `RUNNING` → `PENDING_CONTROLLED_SHUTDOWN` → `SHUTTING_DOWN`。
3. **fenced (隔離) という状態がある。** 登録はされているが、リーダーにはならない。
4. **メタデータに追いつき、復旧が終わってから unfence される。**
5. **ハートビートが途絶えたら fence する。** ZooKeeper のセッション切れに相当。
6. **ハートビートの受付だけは、単一スレッドのコントローラの外で処理する。**

## ソースコードのどこか

### ブローカー側の状態機械

```java title="server/src/main/java/org/apache/kafka/server/BrokerLifecycleManager.java"
/**
 * The broker lifecycle manager owns the broker state.
 *
 * <p>Its inputs are messages passed in from other parts of the broker and from the
 * controller: requests to start up, or shut down, for example. Its output are the broker
 * state and various futures that can be used to wait for broker state transitions to
 * occur.
 *
 * <p>The lifecycle manager handles registering the broker with the controller, as described
 * in KIP-631. After registration is complete, it handles sending periodic broker
 * heartbeats and processing the responses.
 *
 * <p>This code uses an event queue paradigm. Modifications get translated into events, which
 * are placed on the queue to be processed sequentially. As described in the JavaDoc for
 * each variable, most mutable state can be accessed only from that event queue thread.
 * In some cases we expose a volatile variable which can be read from any thread, but only
 * written from the event queue thread.
 */
public class BrokerLifecycleManager {
```

[`BrokerLifecycleManager.java#L56-L75`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/BrokerLifecycleManager.java#L56-L75)。

**ブローカー側も[イベントキューのパラダイム](../quorum-controller/)を使っている。** `KafkaEventQueue` はコントローラ専用ではなく、こういう「状態を 1 スレッドで管理したい」場所で使い回されている。

`volatile` の使い方も明示されていて、**「読みはどのスレッドからでも、書きはイベントキューのスレッドからのみ」**。これは単一書き手の `volatile` として安全な使い方だ。

状態は 5 つある。

```java title="server/src/main/java/org/apache/kafka/server/BrokerState.java"
NOT_RUNNING((byte) 0),
STARTING((byte) 1),
RECOVERY((byte) 2),
RUNNING((byte) 3),
PENDING_CONTROLLED_SHUTDOWN((byte) 6),
SHUTTING_DOWN((byte) 7),
UNKNOWN((byte) 127);
```

[`BrokerState.java#L47-L80`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/BrokerState.java#L47-L80)。

**4 と 5 が欠番になっている。** ZooKeeper 時代にあった状態が消えた跡だ。[api key を欠番にする](../protocol-codegen/)のと同じで、番号を再利用していない。この値はメトリクスとして公開されるので、意味が変わると監視が壊れる。

### 状態遷移はハートビートの応答で起きる

```java title="server/src/main/java/org/apache/kafka/server/BrokerLifecycleManager.java"
switch (state) {
    case STARTING -> {
        if (responseData.isCaughtUp()) {
            logger.info("The broker has caught up. Transitioning from STARTING to RECOVERY.");
            state = BrokerState.RECOVERY;
            initialCatchUpFuture.complete(null);
            ...
        } else {
            logger.debug("The broker is STARTING. Still waiting to catch up with cluster metadata.");
        }
        // Schedule the heartbeat after only 10 ms so that in the case where
        // there is no recovery work to be done, we start up a bit quicker.
        scheduleNextCommunication(NANOSECONDS.convert(10, MILLISECONDS));
    }
    case RECOVERY -> {
        if (!responseData.isFenced()) {
            logger.info("The broker has been unfenced. Transitioning from RECOVERY to RUNNING.");
            initialUnfenceFuture.complete(null);
            state = BrokerState.RUNNING;
        } else {
            logger.info("The broker is in RECOVERY.");
        }
        scheduleNextCommunicationAfterSuccess();
    }
```

[`BrokerLifecycleManager.java#L645-L676`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/BrokerLifecycleManager.java#L645-L676)。

**遷移の判断材料は、全部ハートビートの応答に入っている。**

| 応答のフィールド | 意味                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `isCaughtUp`     | **コントローラから見て、このブローカーはメタデータに追いついたか** |
| `isFenced`       | まだ隔離されているか                                               |
| `shouldShutDown` | 計画的シャットダウンを進めてよいか                                 |

**「追いついたかどうか」をコントローラが判定する**のが重要だ。ブローカーは自分の読んだ offset をハートビートに載せ、コントローラが自分のコミット offset と比べる。**自己申告ではなく、権威が判定する。**

`STARTING` の間だけハートビート間隔が 10 ms になっているのも実務的で、**起動を速くするためだけの調整**だとコメントに書いてある。

### 起動時に書き込みを受け付けない期間がある

状態が `RECOVERY` の間、ブローカーは **fenced** のままだ。この間、

- コントローラはこのブローカーをリーダーにしない。
- クライアントには「このブローカーは使えない」というメタデータが配られる。
- **しかし、ブローカーはフォロワーとしてはデータを取りに行ける。**

`RECOVERY` から `RUNNING` への遷移は、**コントローラが unfence したとき**に起きる。コントローラは「メタデータに追いついた」「ログの復旧が終わった」を確認してから unfence する。

**「登録されている」と「使える」を分離した**のがこの設計で、ZooKeeper のエフェメラルノードにはなかった区別だ。エフェメラルノードは作った瞬間に「いる」ことになる。

### コントローラ側のセッション管理

```java title="metadata/src/main/java/org/apache/kafka/controller/BrokerHeartbeatManager.java"
/**
 * The BrokerHeartbeatManager manages some of the soft state associated with broker heartbeats.
 * For example, it stores the last metadata offset which each broker reported. It contains the
 * BrokerHeartbeatTracker, which stores the last time we received a heartbeat from each broker.
 * ...
 * Only the active controller has a BrokerHeartbeatManager, since only the active
 * controller handles broker heartbeats.  Standby controllers will create a heartbeat
 * manager as part of the process of activating.  This design minimizes the size of the
 * metadata partition by excluding heartbeats from it.  However, it does mean that after
 * a controller failover, we may take some extra time to fence brokers, since the new
 * active controller does not know when the last heartbeats were received from each.
 */
public class BrokerHeartbeatManager {
```

[`BrokerHeartbeatManager.java#L45-L58`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/BrokerHeartbeatManager.java#L45-L58)。

**「ソフトステート」— ハートビートの記録はメタデータログに書かない。**

理由と代償の両方が書いてある。

- **理由**: 書くと、ブローカー 100 台 × 1 秒に 1 回 = 毎秒 100 レコードがメタデータログに永久に積まれる。[スナップショット](../metadata-snapshot/)もその分太る。
- **代償**: コントローラがフェイルオーバーすると、**新しいコントローラは「誰から最後にハートビートが来たか」を知らない。** だから fence の判定が遅れる。

**トレードオフを認識したうえで選び、両方を javadoc に残している。** 「これは意図的な妥協である」と分かる形になっている。

### 単一スレッド設計の唯一の例外

```java title="metadata/src/main/java/org/apache/kafka/controller/BrokerHeartbeatTracker.java"
/**
 * The BrokerHeartbeatTracker stores the last time each broker sent a heartbeat to us.
 * This class will be present only on the active controller.
 *
 * UNLIKE MOST OF THE KAFKA CONTROLLER, THIS CLASS CAN BE ACCESSED FROM MULTIPLE THREADS.
 * Everything in here must be thread-safe. It is intended to be accessed directly from the
 * request handler thread pool. This ensures that the heartbeats always get through, even
 * if the main controller thread is busy.
 */
class BrokerHeartbeatTracker {
    ...
    private final ConcurrentHashMap<BrokerIdAndEpoch, Long> contactTimes;
```

[`BrokerHeartbeatTracker.java#L27-L60`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/BrokerHeartbeatTracker.java#L27-L60)。

**大文字で書かれている。** [コントローラは単一スレッド](../quorum-controller/)という原則の、明示的な例外だ。

理由が書いてある。`This ensures that the heartbeats always get through, even if the main controller thread is busy`。

**単一スレッド設計の弱点がここに出ている。** コントローラのイベントキューが詰まると、ハートビートの処理も遅れる。すると **「生きているブローカーが、コントローラが忙しいという理由だけで fence される」**。fence されるとリーダーが移り、さらにコントローラの仕事が増える。**負のフィードバックループになる。**

だから、**生存確認の受付だけをイベントキューの外に出した。** リクエストハンドラスレッドが直接 `ConcurrentHashMap` に時刻を書く。

**「単一スレッドは原則だが、可用性に関わる 1 点だけ例外にする」** という判断で、その 1 点が大文字のコメントで明示されている。

### 計画的なシャットダウン

`PENDING_CONTROLLED_SHUTDOWN` という状態がある。ブローカーは「落ちたい」とハートビートに書いて送る (`setWantShutDown`)。

コントローラはそれを見て、そのブローカーがリーダーになっているパーティションのリーダーを他に移す。全部移り終わったら、応答の `shouldShutDown` を true にする。ブローカーはそれを見て `SHUTTING_DOWN` に進む。

**リーダーを移してから落ちるので、クライアントから見た停止時間が短くなる。** いきなり落ちると、クライアントはタイムアウトを待ってからメタデータを引き直すことになる。

そして [ELR のページ](../elr/) で見たとおり、**計画的なシャットダウンでは、クリーンシャットダウンのマーカーに broker epoch が書かれる**ので、次の起動でデータが失われていないと判定される。

## なぜそうなっているか

### エフェメラルノードを自作すると、何が要るか

ZooKeeper のエフェメラルノードが提供していたものを分解すると、

| 要素         | KRaft での実装                                                        |
| ------------ | --------------------------------------------------------------------- |
| 登録         | `BrokerRegistration` RPC → `RegisterBrokerRecord`                     |
| 世代の区別   | **broker epoch** (登録のたびに増える)                                 |
| 生存の検出   | ハートビート + `sessionTimeoutNs`                                     |
| 消滅の通知   | `FenceBrokerRecord` をログに書く                                      |
| 全員への伝播 | **メタデータログの購読** ([イメージと差分](../metadata-image-delta/)) |

**broker epoch が特に重要だ。** ブローカーが再起動すると新しい epoch をもらう。古いプロセスがまだ生きていて (GC で止まっていただけだったなど)、古い epoch でリクエストを送ってきても、コントローラは拒否できる。

[ISR に入る条件](../isr-highwatermark/) にも broker epoch の検査があったのは、これを利用している。**世代番号がゾンビを弾く**という、[leader epoch](../leader-epoch/) と同じ構図だ。

### なぜ「登録済み」と「使える」を分けたのか

ZooKeeper 時代、ブローカーは起動してすぐエフェメラルノードを作った。**その瞬間から「使える」と見なされる。**

だが実際には、起動直後のブローカーは

- メタデータをまだ読み終えていない (どのパーティションを持つべきか知らない)。
- ログの復旧が終わっていないかもしれない (数分かかることがある)。

この状態でリーダーにされると、**クライアントからのリクエストに正しく答えられない。**

fenced という中間状態を作ることで、**「準備ができるまでリーダーにしない」を表現できるようになった。** そして準備完了の判定を、ブローカーの自己申告ではなくコントローラの判断にした。

**分散システムで「参加している」と「役割を担える」を分けるのは、ローリング再起動を安全にするための基本形になっている。**

### なぜハートビートをログに書かないのか

書けば、コントローラのフェイルオーバー後も「誰から最後にハートビートが来たか」が分かる。だが、

- **メタデータログは永続的**で、[スナップショット](../metadata-snapshot/)にも入る。
- ハートビートは **毎秒発生し、すぐ古くなる**。
- **ブローカー 100 台なら毎秒 100 レコード。** 1 日で 860 万レコード。

**寿命が短い情報を、永続的なログに書くのは割に合わない。** だから「ソフトステート」として、アクティブなコントローラのメモリにだけ持つ。

代償の「フェイルオーバー後に fence が遅れる」は、**そもそも fence は数十秒のタイムアウトを待つ処理**なので、多少遅れても致命的でない。**寿命と保存先を対応させる**という判断になっている。

### なぜハートビートだけスレッドモデルの例外なのか

これは **「詰まりが自己増幅するループ」** を切るためだ。

```text
コントローラが忙しい
  → ハートビートの処理が遅れる
    → 生きているブローカーが fence される
      → リーダー選出が大量発生
        → コントローラがさらに忙しくなる
```

このループは、負荷が高いときにだけ発動し、しかも発動すると悪化する一方になる。**最も壊れてほしくない条件で壊れる。**

ハートビートの記録だけを別スレッドに逃がすと、ループの最初の矢印が切れる。**「例外を作る価値がある場所」の判断基準は、そこが壊れたときに全体が悪化するかどうかだ。**

`ConcurrentHashMap` に時刻を書くだけなので、スレッド安全性の検証も容易い。**例外を最小限に切り出している**のがよいところで、判定ロジックまで外に出したら安全性の議論が難しくなる。

## どう活かすか

**「セッション」を自前で作るときの構成要素は決まっている** — 登録、世代番号、定期的な生存信号、タイムアウト、そして失効の伝播。ZooKeeper や etcd のリース機能を使わずに済ませるなら、この 5 つを自分で用意することになる。**特に世代番号は忘れやすい。** これがないと、復帰したゾンビプロセスと新しいプロセスが区別できない。

**「参加している」と「役割を担える」を別の状態にするのは、ローリング再起動を安全にする基本形だ。** 起動直後のプロセスが即座にトラフィックを受けると、ウォームアップ前・データ同期前の状態で失敗する。**そして、準備完了の判定は自己申告ではなく、権威側が持つほうがよい。** 自分では「準備できた」と思っていても、権威側から見て追いついていないことはある。

**「寿命が短い情報は、永続ストアに書かない」という切り分けも実務的だ。** ハートビート、ヘルスチェックの結果、一時的なメトリクス — これらを永続ログに書くと、ログの大部分がすぐ無価値になる情報で埋まる。**メモリに持ち、失われたら再取得する**ほうが安い。**そのとき「失われたら何が遅れるか」を書き残しておく**と、後から見て妥協だと分かる。

**「詰まりが自己増幅するループを見つけたら、そこだけ設計原則の例外にする」は覚えておきたい。** 単一スレッドやグローバルロックのような単純化は強力だが、**負荷が高いときに悪化するループを作ることがある。** 全体の設計を変えずに、ループを構成する 1 本の矢印だけを切る。**例外を作るなら、範囲を最小にして、理由を大文字で書く。**
