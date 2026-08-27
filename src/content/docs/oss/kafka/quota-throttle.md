---
title: "レートを測り、レスポンスを遅らせて絞る"
description: "Kafka のクォータは、超過したクライアントにエラーを返さない。応答を計算した後、それを送るのを待たせる。しかも「どれだけ待たせるか」は、超過分を割り戻して平均レートが上限に戻る時間として計算される。エラーではなく遅延で伝えると、行儀の悪いクライアントも自動的に減速する。"
sidebar:
  order: 24
---

## 何を学んだか

### どんな状況の話か

Kafka のクラスタは、多くの場合マルチテナントで使われる。1 つのクラスタを複数のチームやアプリが共有する。

そこで、1 つのクライアントが暴走すると何が起きるか。

- 毎秒 1 GB を書き込むプロデューサが 1 台いると、**ディスク帯域とネットワーク帯域を占有する。**
- 大量のメタデータリクエストを投げるクライアントが、**[コントローラ](../quorum-controller/)のイベントキューを埋める。**
- 結果として、**無関係な他のクライアントが遅くなる。**

上限を設けるのは自然だが、**超えたときにどう伝えるか**が問題になる。

### Kafka の答え

**エラーを返さず、応答を送るのを遅らせる。**

1. **レートを測る。** 「ユーザー + クライアント ID」ごとに、バイト数やリクエスト時間の移動平均を取る。
2. **超過していたら、平均が上限に戻るまでの時間を計算する。**
3. **応答は作る。作ったうえで、その時間だけ送らない。**
4. **その間、そのコネクションは [mute](../socket-server/) されたままになる。** 次のリクエストも読まれない。
5. **応答に `throttleTimeMs` を入れて返す。** クライアントは自分が絞られていることを知れる。

## ソースコードのどこか

### 記録と判定

```java title="server/src/main/java/org/apache/kafka/server/quota/ClientQuotaManager.java"
/**
 * Records that a user/clientId accumulated or would like to accumulate the provided amount at the
 * specified time, returns throttle time in milliseconds.
 *
 * @return The throttle time in milliseconds defines as the time to wait until the average
 *         rate gets back to the defined quota
 */
public int recordAndGetThrottleTimeMs(Session session, String clientId, double value, long timeMs) {
    var clientSensors = getOrCreateQuotaSensors(session, clientId);
    try {
        clientSensors.quotaSensor().record(value, timeMs, true);
        return 0;
    } catch (QuotaViolationException e) {
        var throttleTimeMs = (int) throttleTime(e, timeMs);
        ...
        return throttleTimeMs;
    }
}
```

[`ClientQuotaManager.java#L322-L345`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/quota/ClientQuotaManager.java#L322-L345)。

**記録と判定が同じ呼び出しになっている。** `record(value, timeMs, true)` の第 3 引数が「上限を超えたら例外を投げるか」で、超えたら `QuotaViolationException` が飛ぶ。

**例外を制御フローに使っている**のは珍しいが、`Sensor.record` が Kafka の汎用メトリクス基盤 (`clients` モジュール) のもので、そちらのインタフェースに合わせた形になっている。

**注意したいのは、記録が先で判定が後**であること。**上限を超えるリクエストも、いったんは通る。** 超えた分は次のリクエストの遅延として跳ね返る。

### 待たせる時間の計算

```java title="server-common/src/main/java/org/apache/kafka/server/quota/QuotaUtils.java"
public static long throttleTime(QuotaViolationException e, long timeMs) {
    double difference = e.value() - e.bound();
    // Use the precise window used by the rate calculation
    double throttleTimeMs = difference / e.bound() * windowSize(e.metric(), timeMs);
    return Math.round(throttleTimeMs);
}
```

[`QuotaUtils.java#L25-L30`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/server/quota/QuotaUtils.java#L25-L30)。

**5 行しかない。** 意味はこうだ。

```text
超過分 = 観測レート - 上限
待ち時間 = (超過分 / 上限) × 計測ウィンドウ幅
```

観測ウィンドウが 30 秒 (既定は 1 秒 × 11 サンプル = 11 秒だが、ここでは説明のため)、上限が 100 MB/s、観測が 150 MB/s だったとする。

```text
待ち時間 = (150 - 100) / 100 × 30 秒 = 15 秒
```

**「今の超過分を、この時間かけて薄めれば平均が上限に戻る」** という計算だ。javadoc の `assuming that no new metrics are recorded` が前提を明示している。

**上限を大きく超えるほど、待ち時間が線形に伸びる。** 2 倍超過なら 1 ウィンドウ分、3 倍なら 2 ウィンドウ分。**超過の度合いに比例した罰**になっている。

### 遅らせる仕組み

```java title="server/src/main/java/org/apache/kafka/server/quota/ClientQuotaManager.java"
/**
 * Throttle a client by muting the associated channel for the given throttle time.
 */
public void throttle(
        String clientId,
        Session session,
        ThrottleCallback throttleCallback,
        int throttleTimeMs
) {
    if (throttleTimeMs > 0) {
        var clientSensors = getOrCreateQuotaSensors(session, clientId);
        clientSensors.throttleTimeSensor().record(throttleTimeMs);
        var throttledChannel = new ThrottledChannel(time, throttleTimeMs, throttleCallback);
        delayQueue.add(throttledChannel);
```

[`ClientQuotaManager.java#L385-L402`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/quota/ClientQuotaManager.java#L385-L402)。

`ThrottledChannel` を作って `DelayQueue` に入れるだけ。専用のスレッド (`ThrottledChannelReaper`) が期限の来たものを取り出す。

```java title="server/src/main/java/org/apache/kafka/server/quota/ThrottledChannel.java"
public class ThrottledChannel implements Delayed {
    ...
    public ThrottledChannel(Time time, int throttleTimeMs, ThrottleCallback callback) {
        this.time = time;
        this.throttleTimeMs = throttleTimeMs;
        this.callback = callback;
        this.endTimeNanos = time.nanoseconds() + TimeUnit.MILLISECONDS.toNanos(throttleTimeMs);

        // Notify the socket server that throttling has started for this channel.
        callback.startThrottling();
    }

    /**
     * Notify the socket server that throttling has been done for this channel.
     */
    public void notifyThrottlingDone() {
        LOGGER.trace("Channel throttled for: {} ms", throttleTimeMs);
        callback.endThrottling();
    }
```

[`ThrottledChannel.java#L27-L56`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/quota/ThrottledChannel.java#L27-L56)。

**コンストラクタの中で `startThrottling()` を呼んでいる。** オブジェクトを作った瞬間にスロットリングが始まる。

`startThrottling` / `endThrottling` が [SocketServer の mute イベント](../socket-server/) に対応する。`THROTTLE_STARTED` / `THROTTLE_ENDED` だ。

**チャネルの mute 状態を「処理中だから」と「スロットリング中だから」の 2 つの理由で管理していた**のは、この仕組みのためだった。処理が終わって応答を送っても、スロットリングが明けるまで unmute されない。

**ここでは `DelayQueue` を使っている。** [purgatory](../purgatory/) が階層タイムホイールを自作したのと対照的だ。**スロットリングされるチャネルの数は、待機中のリクエストより桁違いに少ない**ので、`O(log n)` で足りる。

### クォータの種類

| 種類                                 | 単位                         | 何を守るか                                            |
| ------------------------------------ | ---------------------------- | ----------------------------------------------------- |
| `ClientQuotaManager` (Produce/Fetch) | バイト/秒                    | ディスクとネットワークの帯域                          |
| `ClientRequestQuotaManager`          | **リクエスト処理時間の割合** | CPU                                                   |
| `ControllerMutationQuotaManager`     | 作成/削除の件数/秒           | [コントローラ](../quorum-controller/)のイベントキュー |
| `ReplicationQuotaManager`            | バイト/秒                    | 再配置時のレプリケーション帯域                        |

**2 番目が面白い。** バイト数ではなく **「ネットワークスレッドと I/O スレッドの時間をどれだけ使ったか」** の割合で測る。小さいリクエストを大量に投げる攻撃は、バイト数では捕まらない。

4 番目は、[パーティションの再配置](../elr/)でレプリケーションのトラフィックが通常の読み書きを圧迫しないようにするためのものだ。

### 差し替え可能

```java title="server/src/main/java/org/apache/kafka/server/quota/ClientQuotaManager.java"
private double quotaLimit(Map<String, String> metricTags) {
    var limit = quotaCallback.quotaLimit(clientQuotaType, metricTags);
    return limit != null ? limit : Long.MAX_VALUE;
}
```

[`ClientQuotaManager.java#L429-L432`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server/src/main/java/org/apache/kafka/server/quota/ClientQuotaManager.java#L429-L432)。

`ClientQuotaCallback` はプラグインインタフェースで、**「このユーザーの上限はいくつか」を自前のロジックで決められる。** マルチテナントのサービス事業者が、テナントのプランに応じて上限を変える、といった使い方ができる。

既定の実装は、[メタデータログに書かれた `ClientQuotaRecord`](../kraft-overview/) を読む。**クォータの設定も、他の設定と同じくログに載っている。**

## なぜそうなっているか

### なぜエラーではなく遅延なのか

上限を超えたときの選択肢は 3 つある。

| 方式             | 起きること                                                       |
| ---------------- | ---------------------------------------------------------------- |
| **エラーを返す** | クライアントが即座にリトライする。**負荷が減らない**             |
| **接続を切る**   | クライアントが再接続する。ハンドシェイクの分だけ**負荷が増える** |
| **遅らせる**     | クライアントが待つ。**自動的に減速する**                         |

**エラーを返すと、行儀の悪いクライアントほど速くリトライする。** 絞りたい相手が一番負荷をかける、という逆の結果になる。

遅延なら、**クライアントが何もしなくても減速する。** `max.in.flight.requests.per.connection` の上限に達すれば、それ以上送れない。**クライアント側の実装に依存せず、プロトコルの構造だけで流量が絞られる。**

しかも [チャネルが mute される](../socket-server/) ので、**次のリクエストの読み込みすら始まらない。** クライアントが別スレッドから送ろうとしても、TCP バッファが埋まって止まる。

### なぜ応答に `throttleTimeMs` を入れるのか

遅延だけでも流量は絞れる。それでも応答に「あなたは N ミリ秒絞られました」を入れているのは、**クライアントが観測できるようにするため**だ。

- クライアントは `produce-throttle-time-avg` のようなメトリクスを出せる。
- **アプリの開発者が「遅いのはクォータのせいだ」と分かる。**

これがないと、「たまに応答が遅い」としか見えない。**原因不明の遅延ほど厄介なものはない。**

**絞る側と絞られる側の両方に、絞られている事実を見せる**という設計になっている。

### なぜ「記録してから判定」なのか

上限を超えるリクエストも、いったんは処理される。厳密に「超えるなら拒否」にしないのは、

- **リクエストのサイズは処理前に正確には分からない。** 圧縮されていれば伸長するまで実バイト数が確定しない。
- **拒否するとエラーを返すことになり、上で述べた問題に戻る。**

**「後払い」にすると、超過分は次のリクエストの遅延で回収される。** 平均レートで見れば上限が守られる。

代償は、**瞬間的には上限を超えうる**ことだ。バーストを許容する設計になっている。ウィンドウの幅 (`quota.window.num` × `quota.window.size.seconds`) がバーストの許容量を決める。

### なぜ purgatory ではなく DelayQueue なのか

[purgatory](../purgatory/) は階層タイムホイールを自作したのに、こちらは JDK の `DelayQueue` を使っている。

違いは **規模**だ。

|                  | purgatory                                   | スロットリング       |
| ---------------- | ------------------------------------------- | -------------------- |
| 同時待機数       | 数十万                                      | 数百〜数千           |
| キャンセルの頻度 | **極めて高い** (大半がタイムアウト前に完了) | ほぼない             |
| 完了の契機       | 外部イベント or タイムアウト                | **タイムアウトのみ** |

**キャンセルされないなら、優先度キューの弱点 (削除が O(log n)) が出ない。** そして数千件なら `O(log n)` は無視できる。

**同じ「待たせる」でも、規模とアクセスパターンが違えば違う道具を選ぶ。** 一方を他方に統一しようとすると、どちらかで無理が出る。

### CPU をリクエスト処理時間で測る理由

バイト数のクォータだけでは、**「小さいリクエストを大量に投げる」パターンを捕まえられない。**

- 1 バイトの Fetch を毎秒 10 万回 → バイト数のクォータには引っかからない。
- しかし **リクエストのパースと応答の組み立てで CPU を食う。**

`ClientRequestQuotaManager` は「そのクライアントのリクエストが、ネットワークスレッドと I/O スレッドの時間をどれだけ使ったか」を割合で測る。上限は「1 スレッド分の何%」という単位になる。

**守りたいリソースを直接測る**という発想で、代理指標 (バイト数、リクエスト数) では漏れが出る。

## どう活かすか

**「レート制限は、エラーではなく遅延で伝える」は、クライアントがリトライする環境では明確に優れている。** エラーはリトライを誘発して負荷を増やすが、遅延はクライアントの実装に依存せず流量を絞る。**成立条件は、クライアントが同時リクエスト数に上限を持っていること。** 上限がなければ、遅延させても新しいリクエストが無限に来る。**プロトコル側で in-flight 数を制限しておくと、遅延がそのままバックプレッシャになる。**

**待ち時間を「超過分 ÷ 上限 × ウィンドウ幅」で計算する式は、そのまま使える。** トークンバケツより単純で、移動平均を測っていれば自然に導ける。**超過の度合いに線形で罰が増えるので、大きく超えたクライアントほど強く絞られる。**

**「絞られていることをクライアントに伝える」のは、運用の透明性のために必ずやりたい。** レスポンスヘッダなり応答フィールドなりに「N ミリ秒絞りました」を入れておくと、**利用側が自分で気づける。** サーバ側のメトリクスだけだと、問い合わせが来るまで誰も気づかない。

**「守りたいリソースを直接測る」も重要な視点だ。** バイト数やリクエスト数は代理指標にすぎず、必ず抜け道がある。**CPU を守りたいなら処理時間を、キューを守りたいならキューへの投入数を測る。** Kafka がクォータを 4 種類持っているのは、守るべきリソースが 4 種類あるからで、1 つに統一しようとしていない。

**そして、同じ「待たせる」でも規模とパターンで道具を変えてよい。** 数十万件でキャンセルが多いなら自作のタイムホイール、数千件でキャンセルがないなら `DelayQueue`。**「統一したほうが美しい」に引きずられて、片方に無理をさせない。**
