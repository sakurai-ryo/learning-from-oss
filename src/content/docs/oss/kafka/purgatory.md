---
title: "待たされているリクエストを、階層タイムホイールで管理する"
description: "acks=all の書き込みも fetch.min.bytes 待ちの読み取りも、ハンドラスレッドを塞がずに「待ち」に入る。Kafka はそれを purgatory と呼ぶ。タイムアウトの管理には優先度キューではなく階層タイムホイールを使い、挿入と削除を O(1) にしている。そして完了済みの操作は即座には消さず、溜まってからまとめて掃除する。"
group: "ネットワークとリクエスト処理"
sidebar:
  order: 23
---

## 何を学んだか

### どんな状況の話か

Kafka のリクエストには、**すぐには答えられないもの**がある。

- **`acks=all` の Produce**: 全 ISR がコピーするまで応答できない ([ISR のページ](../isr-highwatermark/))。
- **`fetch.min.bytes` を指定した Fetch**: 十分なデータが溜まるまで待つ。溜まらなければ `fetch.max.wait.ms` でタイムアウト。
- **トランザクションの操作**、[共有グループの取得](../share-groups/)、[コントローラへの転送](../quorum-controller/)。

[SocketServer のページ](../socket-server/) で見たとおり、リクエストを処理するのは M 本のハンドラスレッドだ。**ここで待つと、そのスレッドが塞がる。**

コンシューマが 1 万台いて、全員が `fetch.max.wait.ms=500` で待っていたら、1 万本のスレッドが要る。**不可能だ。**

### Kafka の答え

**待つべきリクエストを「purgatory (煉獄)」に預けて、ハンドラスレッドは次のリクエストへ行く。**

1. **操作は 2 つの索引に載る。** 「何が起きたら完了できるか」を表すキーごとの watcher リストと、タイムアウト用のタイマー。
2. **タイマーは階層タイムホイール。** 挿入 O(m)、削除 O(1)。優先度キューの O(log n) より速い。
3. **完了の契機は 2 つ。** 外部イベント (HW が進んだ、データが届いた) か、タイムアウト。
4. **完了した操作は watcher リストからすぐ消さない。** 溜まってからまとめて掃除する。
5. **ロック順序の問題が丁寧にコメントされている。**

## ソースコードのどこか

### 階層タイムホイール

```java title="server-common/src/main/java/org/apache/kafka/server/util/timer/TimingWheel.java"
/**
 * Hierarchical Timing Wheels
 * <br>
 * A simple timing wheel is a circular list of buckets of timer tasks. Let u be the time unit.
 * A timing wheel with size n has n buckets and can hold timer tasks in n * u time interval.
 * ...
 * A timing wheel has O(1) cost for insert/delete (start-timer/stop-timer) whereas priority queue
 * based timers, such as java.util.concurrent.DelayQueue and java.util.Timer, have O(log n)
 * insert/delete cost.
```

[`TimingWheel.java#L21-L97`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/util/timer/TimingWheel.java#L21-L97)。

**バケツの配列に、時刻でタスクを振り分けるだけ。** どのバケツに入れるかは割り算で決まるので O(1)。削除は連結リストからの取り外しで O(1)。

単純なタイムホイールの弱点は、**表現できる時間の範囲が `n × u` に限られる**ことだ。1 ms 刻みで 20 バケツなら 20 ms しか扱えない。それを解くのが階層化になる。

```text title="server-common/src/main/java/org/apache/kafka/server/util/timer/TimingWheel.java"
 * level    buckets
 * 1        [c,c]   [c+1,c+1]  [c+2,c+2]
 * 2        [c,c+2] [c+3,c+5]  [c+6,c+8]
 * 3        [c,c+8] [c+9,c+17] [c+18,c+26]
```

[`TimingWheel.java#L50-L57`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/util/timer/TimingWheel.java#L50-L57)。

**上の階層ほど粗い。** 時計の秒針・分針・時針と同じで、上の階層のバケツが満了すると、中のタスクが下の階層に **再挿入**される。

javadoc には、時刻が c+1、c+2、c+3 と進むときの各階層の状態が **3 回分展開して書かれている**。抽象的な説明では追いにくいので、具体例を並べている。

無駄も正直に書いてある。

```text title="server-common/src/main/java/org/apache/kafka/server/util/timer/TimingWheel.java"
 * Note that bucket [c,c+2] in level 2 won't receive any task since that range is already covered in level 1.
 * The same is true for the bucket [c,c+8] in level 3 since its range is covered in level 2.
 * This is a bit wasteful, but simplifies the implementation.
```

[`TimingWheel.java#L64-L67`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/util/timer/TimingWheel.java#L64-L67)。

**「少し無駄だが、実装が単純になる」。** 各階層の最初のバケツは、下の階層でカバーされているので使われない。それを塞ぐ最適化はしない、と明示している。

そして、この構造が効く条件も書かれている。

```text title="server-common/src/main/java/org/apache/kafka/server/util/timer/TimingWheel.java"
 * The hierarchical timing wheels works especially well when operations are completed before they time out.
```

**「タイムアウトする前に完了する操作が多いとき」に特によく効く。** Kafka のリクエストはまさにそれで、大半は数ミリ秒で完了し、タイムアウトに到達しない。**タイマーに入れて、すぐ取り消す**というパターンになる。挿入と削除が O(1) なので、これがほぼタダになる。

### 2 つの索引

purgatory は、操作を 2 つの索引に登録する。

| 索引                                   | 何のため                 | 完了の契機                          |
| -------------------------------------- | ------------------------ | ----------------------------------- |
| **watcher リスト** (キー → 操作の集合) | 外部イベントで完了させる | 「パーティション X の HW が進んだ」 |
| **タイマー** (階層タイムホイール)      | タイムアウトで完了させる | 時間切れ                            |

```java title="server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java"
private static final int SHARDS = 512; // Shard the watcher list to reduce lock contention
```

[`DelayedOperationPurgatory.java#L41`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java#L41)。

**watcher リストは 512 個にシャーディングされている。** キーのハッシュでシャードを決め、シャードごとにロックを持つ。パーティション単位のキーが数万個あるので、1 つのロックだと競合する。

### 登録の手順

```java title="server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java"
// The cost of tryComplete() is typically proportional to the number of keys. Calling tryComplete() for each key is
// going to be expensive if there are many keys. Instead, we do the check in the following way through safeTryCompleteOrElse().
// If the operation is not completed, we just add the operation to all keys. Then we call tryComplete() again. At
// this time, if the operation is still not completed, we are guaranteed that it won't miss any future triggering
// event since the operation is already on the watcher list for all keys.
```

[`DelayedOperationPurgatory.java#L124-L129`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java#L124-L129)。

**登録前に 1 回、登録後にもう 1 回 `tryComplete()` を呼ぶ。**

これは **「登録の隙間にイベントが来たら取りこぼす」問題**への対処だ。

```text
[危険な順序]
1. tryComplete() → まだ完了できない
2. ── ここでイベントが起きる (誰も見ていない) ──
3. watcher リストに登録
   → イベントは過ぎ去った。タイムアウトまで待つことになる

[実際の順序]
1. watcher リストに登録
2. tryComplete() → ここで完了できるなら完了
   → 登録済みなので、この後のイベントは必ず拾える
```

**「登録してから確認する」** が正しい順序で、条件変数を使うときの `while (!condition) wait()` と同じ形になっている。

### ロック順序の話

同じメソッドに、**デッドロックのシナリオが 2 つ、番号付きで書かれている。**

```java title="server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java"
// ==============[story about lock]==============
// Through safeTryCompleteOrElse(), we hold the operation's lock while adding the operation to watch list and doing
// the tryComplete() check. This is to avoid a potential deadlock between the callers to tryCompleteElseWatch() and
// checkAndComplete(). For example, the following deadlock can happen if the lock is only held for the final tryComplete()
// 1) thread_a holds readlock of stateLock from TransactionStateManager
// 2) thread_a is executing tryCompleteElseWatch()
// 3) thread_a adds op to watch list
// 4) thread_b requires writelock of stateLock from TransactionStateManager (blocked by thread_a)
// 5) thread_c calls checkAndComplete() and holds lock of op
// 6) thread_c is waiting readlock of stateLock to complete op (blocked by thread_b)
// 7) thread_a is waiting lock of op to call the final tryComplete() (blocked by thread_c)
```

[`DelayedOperationPurgatory.java#L131-L142`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java#L131-L142)。

**`ReentrantReadWriteLock` は、書き込みロック待ちが読み取りロックをブロックする** (writer starvation を防ぐため)。3 スレッドと 2 種類のロックで、きれいに循環している。

そして、**現在の実装でもまだデッドロックが起こりうる**ことまで書いてある。

```java title="server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java"
// Note that even with the current approach, deadlocks could still be introduced. For example,
// 1) thread_a calls tryCompleteElseWatch() and gets lock of op
// ...
// To avoid the above scenario, we recommend DelayedOperationPurgatory.checkAndComplete() be called without holding
// any exclusive lock. Since DelayedOperationPurgatory.checkAndComplete() completes delayed operations asynchronously,
// holding an exclusive lock to make the call is often unnecessary.
```

[`DelayedOperationPurgatory.java#L144-L154`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java#L144-L154)。

**「完全には防げないので、呼び出し側への規約を置く」** — `checkAndComplete()` は排他ロックを持たずに呼ぶこと。

コードで強制できない制約を、**具体的なシナリオつきで書き残している。** 「デッドロックに注意」ではなく、「どの順序で何が起きると詰まるか」が番号付きで書いてある。

### 完了しても、すぐには消さない

```java title="server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java"
private void advanceClock(long timeoutMs) throws InterruptedException {
    timeoutTimer.advanceClock(timeoutMs);

    // Trigger a purge if the number of completed but still being watched operations is larger than
    // the purge threshold. That number is computed by the difference btw the estimated total number of
    // operations and the number of pending delayed operations.
    if (estimatedTotalOperations.get() - numDelayed() > purgeInterval) {
        // now set estimatedTotalOperations to delayed (the number of pending operations) since we are going to
        // clean up watchers. Note that, if more operations are completed during the cleanup, we may end up with
        // a little overestimated total number of operations.
        estimatedTotalOperations.getAndSet(numDelayed());
        LOG.debug("Begin purging watch lists");
        int purged = 0;
        for (WatcherList watcherList : watcherLists) {
            purged += watcherList.allWatchers().stream().mapToInt(Watchers::purgeCompleted).sum();
        }
```

[`DelayedOperationPurgatory.java#L386-L403`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java#L386-L403)。

**操作が完了しても、watcher リストからは外さない。** 完了フラグを立てるだけだ。

理由は、**1 つの操作が複数のキーの watcher リストに載っている**ことにある。`acks=all` の Produce が 10 パーティションに書くなら、10 個のリストに載る。完了時に全部から外すには、どのリストに載っているかを覚えておく必要がある。

**代わりに「完了済みが増えてきたら、全リストを舐めて掃除する」。** 掃除の契機は「推定総数 − 未完了数 > `purgeInterval`」という近似で、`estimatedTotalOperations` は正確でなくてよいと明記されている (`a little overestimated`)。

掃除するのは、タイムアウトを進めるバックグラウンドスレッドだ。

```java title="server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java"
/**
 * A background reaper to expire delayed operations that have timed out
 */
private class ExpiredOperationReaper extends ShutdownableThread {
    ...
    @Override
    public void doWork() {
        try {
            advanceClock(200L);
```

[`DelayedOperationPurgatory.java#L406-L418`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/purgatory/DelayedOperationPurgatory.java#L406-L418)。

**purgatory ごとに 1 本のスレッド**が、200 ms ごとに時計を進めて期限切れを処理し、ついでに掃除もする。

## なぜそうなっているか

### なぜ優先度キューではないのか

`DelayQueue` や `ScheduledThreadPoolExecutor` を使えば、タイマーは書かなくて済む。それでも自作した理由は、**操作の数と、キャンセルの頻度**にある。

- ブローカーは常時 **数十万の待機操作**を持ちうる。
- そのほとんどは **タイムアウト前に完了し、キャンセルされる。**

優先度キューでは、挿入も削除も O(log n)。n が 10 万なら 17 回の比較。**タイムホイールなら、挿入は階層数 (通常 3〜5) 回、削除は連結リストのノードを外すだけ。**

そして、**タイマーの精度は要らない。** 「500 ms 待つ」が 505 ms になっても問題ない。タイムホイールは精度を刻み幅 (既定 1 ms) に丸めるが、それで十分だ。

**「精度を捨てて O(1) を買う」** という取引になっている。

### なぜ完了時に即座に消さないのか

即座に消すには、操作が「自分がどのリストに載っているか」を持つ必要がある。10 パーティションなら 10 個の参照。

- **メモリが増える。** 操作 1 つあたり、載っているリストの数だけ参照が要る。
- **消すときに 10 個のロックを取る。** 順序を間違えるとデッドロックする。

**遅延して一括で掃除すると、この 2 つが消える。** 代わりに「完了済みだが載ったままの操作」がメモリに残る。

**トレードオフを制御するのが `purgeInterval`** (`*.purgatory.purge.interval.requests`、既定 1000) で、掃除の頻度とメモリのバランスを取る。

**「即座の解放」と「遅延した一括解放」の選択**は GC と同じ構図で、後者のほうが総コストが低いことが多い。

### なぜ「登録してから確認する」のか

これは並行処理の基本形だ。**「条件を確認してから待つ」の間に条件が成立すると、通知を取りこぼす。**

- 条件変数: `synchronized` の中で条件を確認し、`wait()` する。
- purgatory: watcher リストに登録してから `tryComplete()` する。

**登録が先なら、その後のイベントは必ず拾われる。** 登録前に条件が成立していた場合は、2 回目の `tryComplete()` が拾う。

コストは `tryComplete()` を 2 回呼ぶことだが、**1 回目で完了することが多い**ので、その場合は登録すらしない。コメントの `The cost of tryComplete() is typically proportional to the number of keys` は、この最適化の理由になっている。

### デッドロックのシナリオをコメントに書く価値

7 行のシナリオと、10 行の「それでも残る危険」。合わせて 30 行近いコメントがある。

**これは、コードを読んでも絶対に導けない情報だ。** 3 つのスレッドと 2 種類のロックが関わり、しかも `ReentrantReadWriteLock` の writer preference という JDK の実装詳細に依存している。

**実際に起きた障害の記録**でもあるだろう。この形のデッドロックは、テストではまず再現しない。本番で数ヶ月に 1 回起きて、スレッドダンプから解析するしかない。

**「なぜこのロックをここで取るのか」を消してしまうと、次の人が『無駄なロックだ』と外して、また同じ障害を起こす。**

### purgatory という名前

「煉獄」— 天国にも地獄にも行けず、待っている場所。**リクエストが完了もタイムアウトもせず、宙ぶらりんになっている状態**を的確に表している。

メトリクス名にもそのまま出てくる (`kafka.server:type=DelayedOperationPurgatory,delayedOperation=Produce`)。運用者が「Produce purgatory のサイズが増えている」と言えば、それは「`acks=all` の書き込みが応答できずに溜まっている」という意味になる。

**概念に名前が付いていると、運用の会話ができる。**

## どう活かすか

**「待つリクエストをスレッドから引き剥がす」のは、非同期サーバの基本形だが、実装には 2 つの索引が要る** — 「何が起きたら完了できるか」と「いつまでに諦めるか」。前者だけだと永遠に待つものが出るし、後者だけだとイベント駆動で早く返せない。**Kafka の purgatory は、この 2 つを 1 つの抽象にまとめて再利用可能にしている**ので、Produce・Fetch・トランザクション・共有グループが全部同じ仕組みに乗っている。

**「タイマーの精度が要らないなら、階層タイムホイールで O(1) にできる」は、大量のタイムアウトを扱うなら検討に値する。** 特に **「大半がタイムアウト前にキャンセルされる」** パターンで効く。優先度キューは削除が O(log n) なので、キャンセルの多さがそのままコストになる。**逆に、タイマーが少数で精度が要るなら、素直に既製品を使うほうがよい。**

**「即座に解放せず、溜まったら一括で掃除する」は、参照が多対多になっているときに強い。** 「誰がどこに登録されているか」の逆引きを持たずに済み、ロックの取得順序の問題も消える。**判断基準は「解放が遅れることで何が困るか」で、メモリだけなら閾値で制御できる。**

**「登録してから確認する」は、イベント駆動の完了通知で必ず踏む落とし穴だ。** 確認してから登録すると、その隙間のイベントを落とす。**この順序は例外なく守る。**

**そして、コードから導けない知識は必ずコメントに書く。** デッドロックのシナリオ、ロックを取る範囲の理由、呼び出し側への規約。**「なぜこう書いてあるか」が失われると、次のリファクタリングで消される。** 30 行のコメントは長く見えるが、それが守っているものの価値を考えれば安い。
