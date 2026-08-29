---
title: "GC が DB を止める時間を、目標値から逆算する"
description: "containerd の GC スケジューラは「実時間の 2% 以上は止めない」という目標から次回の実行時刻を決める。過去の GC の平均所要時間を pause_threshold で割れば間隔が出る。速く終わるなら頻繁に、遅いなら控えめに。閾値による即時起動も併用する。"
group: "lease と GC"
sidebar:
  order: 23
---

## 何を学んだか

### 「どれくらい止めてよいか」を設定項目にする

GC の頻度を決める設定として素直なのは「N 分ごと」だ。containerd はそうしていない。設定するのは **止めてよい時間の割合** で、既定は 0.02 (2%)。

```
interval = 平均GC時間 / pause_threshold - 平均GC時間
```

平均 GC 時間が 20 ms なら、間隔は `20/0.02 - 20 = 980 ms`。つまり約 1 秒ごとに 20 ms 止まり、実時間の 2% が GC に使われる。

GC が 500 ms かかる環境なら、間隔は約 24.5 秒に伸びる。**環境の重さに応じて自動的に頻度が下がる**。

### 4 つの起動条件

| 設定                 | 既定  | 役割                                              |
| -------------------- | ----- | ------------------------------------------------- |
| `pause_threshold`    | 0.02  | 定期実行の間隔を決める。最大 0.5                  |
| `deletion_threshold` | 0     | 削除が N 件たまったら即座に起動する。0 = 無効     |
| `mutation_threshold` | 100   | 変更が N 件たまったら、次の定期実行で必ず GC する |
| `schedule_delay`     | 0ms   | トリガから実行までの遅延。バーストをまとめる      |
| `startup_delay`      | 100ms | 起動直後の初回 GC まで待つ時間                    |

`deletion_threshold` と `mutation_threshold` の違いが微妙だ。前者は **スケジュールを前倒しする**、後者は **次回のスケジュールで実行を確定させる** (前倒しはしない)。

### 削除が起きていなければスキップする

定期実行のタイミングが来ても、前回から削除も変更もなければ GC は走らない。何も消すものがないのに DB を止めても無駄だからだ。

### 初回の GC でベースラインを取る

起動 100 ms 後に 1 回 GC を走らせる。ここで得られた所要時間が、以降の間隔計算の初期値になる。

## ソースコードのどこか

### 設定のコメントが計算式を説明する

[`plugins/gc/scheduler.go#L24-L38`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/gc/scheduler.go#L24-L38)。

```go title="plugins/gc/scheduler.go"
// config configures the garbage collection policies.
type config struct {
	// PauseThreshold represents the maximum amount of time garbage
	// collection should be scheduled based on the average pause time.
	// For example, a value of 0.02 means that scheduled garbage collection
	// pauses should present at most 2% of real time,
	// or 20ms of every second.
	//
	// A maximum value of .5 is enforced to prevent over scheduling of the
	// garbage collector, trigger options are available to run in a more
	// predictable time frame after mutation.
	//
	// Default is 0.02
	PauseThreshold float64 `toml:"pause_threshold"`
```

「2% とは、1 秒あたり 20 ms」と具体例が書かれている。設定値の意味が、単位のない浮動小数点数からは読み取れないので、コメントで補っている。

上限 0.5 が強制される理由も書かれている。「GC を過剰にスケジュールしないため」。0.9 などにすると、GC が終わった直後に次の GC が始まる状態になりかねない。

`mutation_threshold` の説明が特に注意深い。

```go title="plugins/gc/scheduler.go"
	// MutationThreshold is used to guarantee that a garbage collection is
	// run after a configured number of database mutations have occurred
	// since the previous garbage collection. A value of 0 indicates that
	// garbage collection will only be run after a manual trigger or
	// deletion. Unlike the deletion threshold, the mutation threshold does
	// not cause scheduling of a garbage collection, but ensures GC is run
	// at the next scheduled GC.
	MutationThreshold int `toml:"mutation_threshold"`
```

「deletion threshold と違い、GC のスケジュールを引き起こさない。次のスケジュール時に GC が走ることを保証するだけ」。2 つの閾値の違いが 1 文で説明されている。

### 間隔の計算

[`plugins/gc/scheduler.go#L334-L347`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/gc/scheduler.go#L334-L347)。

```go title="plugins/gc/scheduler.go"
		// Calculate new interval with updated times
		if s.pauseThreshold > 0.0 {
			// Set interval to average gc time divided by the pause threshold
			// This algorithm ensures that a gc is scheduled to allow enough
			// runtime in between gc to reach the pause threshold.
			// Pause threshold is always 0.0 < threshold <= 0.5
			avg := float64(gcTimeSum) / float64(collections)
			// Enforce that avg is no less than minimumGCTime
			// to prevent immediate rescheduling
			if avg < minimumGCTime {
				avg = minimumGCTime
			}
			interval = time.Duration(avg/s.pauseThreshold - avg)
		}
```

平均は **全期間の累積平均** (`gcTimeSum / collections`) で、移動平均ではない。長時間動いているデーモンでは、直近の変化に鈍くなる。単純さを優先した選択だ。

下限が置かれている。

```go title="plugins/gc/scheduler.go"
	const minimumGCTime = float64(5 * time.Millisecond)
```

GC が 0.1 ms で終わる (何もない) 環境では、間隔が 5 ms 未満になってしまう。最低 5 ms とみなすことで、間隔が最短でも 245 ms になる。**「速すぎる」ことによる暴走を防ぐ下限** だ。

### スキップの判定

[`plugins/gc/scheduler.go#L255-L265`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/gc/scheduler.go#L255-L265)。

```go title="plugins/gc/scheduler.go"
	for {
		select {
		case <-schedC:
			// Check if garbage collection can be skipped because
			// it is not needed or was not requested and reschedule
			// it to attempt again after another time interval.
			if !triggered && lastCollection != nil && deletions == 0 &&
				(s.mutationThreshold == 0 || mutations < s.mutationThreshold) {
				schedC, nextCollection = schedule(interval)
				continue
			}
```

「手動トリガもなく、削除もなく、変更が閾値未満なら」スキップして再スケジュール。アイドルなノードでは GC がほとんど走らない。

### イベントによる前倒し

```go title="plugins/gc/scheduler.go"
		case e := <-s.eventC:
			if lastCollection != nil && lastCollection.After(e.ts) {
				continue
			}
			if e.dirty {
				deletions++
			}
			if e.mutation {
				mutations++
			} else {
				triggered = true
			}

			// Check if condition should cause immediate collection.
			if triggered ||
				(s.deletionThreshold > 0 && deletions >= s.deletionThreshold) ||
				(nextCollection == nil && ((s.deletionThreshold == 0 && deletions > 0) ||
					(s.mutationThreshold > 0 && mutations >= s.mutationThreshold))) {
				// Check if not already scheduled before delay threshold
				if nextCollection == nil || nextCollection.After(time.Now().Add(s.scheduleDelay)) {
					// TODO(dmcg): track re-schedules for tuning schedule config
					schedC, nextCollection = schedule(s.scheduleDelay)
				}
			}
```

冒頭の 3 行が地味に重要だ。**GC の開始時刻より前に発生したイベントは無視する**。既に処理済みの変更で余計な GC を起こさない。

最後の条件も同じ発想で、既にもっと早い時刻にスケジュールされていれば、上書きしない。

このイベントは `DB.Update` の mutation コールバックから来る ([metadata が実装を包んで、namespace とトランザクションを足す](../metadata-wrapping/))。

### 失敗時の再スケジュール

```go title="plugins/gc/scheduler.go"
		if err != nil {
			log.G(ctx).WithError(err).Error("garbage collection failed")
			collectionCounter.WithValues("fail").Inc()
			var retryDelay time.Duration
			if lastCollection != nil {
				// If we have a previous collection time, reschedule based on that interval.
				retryDelay = nextCollection.Sub(*lastCollection) + time.Second
			} else {
				// If this is the first collection and it failed, use the default schedule delay.
				retryDelay = s.scheduleDelay
			}
			schedC, nextCollection = schedule(retryDelay)

			// Update last collection time even though failure occurred
			lastCollection = &last
```

失敗しても止まらず、前回の間隔 + 1 秒で再試行する。失敗が続いても指数的に伸びはしないが、少しずつ間隔が空く。

失敗時も `lastCollection` を更新する点に注意が要る。これがないと、失敗のたびに「前回から時間が経った」と判定されて連続実行になる。

### 待ち合わせ

同期削除 ([image store が持つのは「名前 → descriptor」だけ](../image-store/)) のために、GC の完了を待つ仕組みがある。

```go title="plugins/gc/scheduler.go"
		for _, w := range s.waiters {
			w <- stats
		}
		s.waiters = nil
```

`ScheduleAndWait` を呼んだ側は、チャネルで結果を受け取る。複数の待ち手がいれば全員に配られ、**1 回の GC が複数の同期削除要求を満たす**。

### 設定値を introspection に出す

```go title="plugins/gc/scheduler.go"
			ic.Meta.Exports = map[string]string{
				"PauseThreshold":    fmt.Sprint(m.pauseThreshold),
				"DeletionThreshold": fmt.Sprint(m.deletionThreshold),
				"MutationThreshold": fmt.Sprint(m.mutationThreshold),
				"ScheduleDelay":     fmt.Sprint(m.scheduleDelay),
			}
```

実効設定が `ctr plugins ls -d` で見える。設定ファイルを読まなくても、動いているデーモンに聞ける ([introspection: プラグインの生死を API で見せる](../introspection/))。

## なぜそうなっているか

### 頻度ではなく「影響」を設定させる

「5 分ごとに GC」という設定は、環境によって意味が変わる。イメージが 10 個のノードと 1000 個のノードでは、GC の重さが桁違いだ。同じ間隔にすると、前者では無駄に頻繁、後者では影響が大きすぎる。

**「実時間の何割を GC に使ってよいか」は環境によらない指標** で、これを設定させれば頻度は自動的に決まる。運用者が調整すべきパラメータが 1 つ減る。

似た発想は Go ランタイムの `GOGC` (ヒープの増加率で GC を起動する) にもある。絶対値ではなく比率で制御する。

### 即時起動の経路も残す

比率制御だけだと、「大量に削除したのにディスクが空かない」という状況が起きうる。`deletion_threshold` と手動トリガがその逃げ道になる。

しかも手動トリガ (`triggered`) は他のどの条件より優先される。同期削除を要求した利用者を待たせないための扱いだ。

### 過去の平均を使うことの限界

累積平均なので、デーモンの稼働が長くなるほど直近の変化に鈍くなる。イメージが急増して GC が重くなっても、平均が上がるまでに時間がかかる。

コードには `// TODO(dmcg): track re-schedules for tuning schedule config` というコメントが残っていて、この辺りの改善余地は認識されている。単純な実装で十分に機能しているので、複雑にしていない、という状態だ。

## どう活かすか

### GC の負荷を調整する

イメージ数が多いノードで GC の影響が気になる場合。

```toml
version = 3
[plugins.'io.containerd.gc.v1.scheduler']
  pause_threshold = 0.005   # 0.5% まで下げる = 間隔が 4 倍に伸びる
  deletion_threshold = 50   # ただし削除が 50 件たまったら即実行
  schedule_delay = "1s"     # バーストをまとめる
```

逆に、ディスクの逼迫が問題ならば `deletion_threshold` を小さくして回収を早める。

### メトリクスで実態を見る

```sh
$ curl -s localhost:1338/v1/metrics | grep -E "containerd_gc_(pause|collections)"
```

`containerd_gc_pause_seconds` のヒストグラムを見れば、GC が実際にどれだけ止めているかが分かる。設定した pause_threshold が守られているかの検証になる。

### 「目標から逆算する」スケジューリング

定期実行の間隔を決める場面で、この設計はそのまま応用できる。

- **絶対的な間隔ではなく、許容する影響を設定させる** — 環境差を吸収する
- **実測値から間隔を計算する** — 平均所要時間を測り続ける
- **下限と上限を置く** — 実測が極端な値になったときの暴走を防ぐ
- **やることがなければスキップする** — 空振りにコストをかけない
- **即時実行の経路を別に用意する** — 比率制御では応答性が足りない場面がある

最後の 2 つが特に実用的だ。定期処理は「暇なときは何もせず、急ぐときは割り込める」形にしておくと、運用で調整する必要がほとんどなくなる。
