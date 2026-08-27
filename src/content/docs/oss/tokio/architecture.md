---
title: "スレッドプールの言葉で読む Tokio のアーキテクチャ"
description: "Tokio は「Future を実行する」ライブラリだが、中身は普通のスレッドプールに驚くほど似ている。タスク・実行キュー・ワーカー・park という語彙はほぼそのまま通じて、違うのは「タスクが自分から止まる」ことと「止まったタスクを起こす仕組みが要る」ことだけだ。この章の他のページが使う語彙 (task、waker、notified、core、driver、readiness、budget) を、スレッドプールとの対応で先に導入する。"
sidebar:
  order: 1
---

## 3 つの層

Tokio のランタイムは、大きく 3 層に分かれている。ディレクトリ構成もそのままだ。

| 層            | 何をするか                                                   | 場所                                                |
| ------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| **task**      | 1 個の future を「実行できるオブジェクト」に変える           | `runtime/task/`                                     |
| **scheduler** | そのオブジェクトをキューに入れ、ワーカースレッドで回す       | `runtime/scheduler/`                                |
| **driver**    | OS のイベント (I/O・時刻・シグナル) を待って、タスクを起こす | `runtime/io/`, `runtime/time/`, `runtime/driver.rs` |

普通のスレッドプールと比べると、**task と scheduler はほぼ同じ**で、**driver が増えている**。

スレッドプールに投げる仕事は、始まったら終わるまで走る。Tokio のタスクは **途中で「まだできません」と言って帰ってくる**。だから「いつ再開してよいか」を教える仕組みが要る。それが driver だ。

## 最小限の Future

Rust の非同期は、標準ライブラリのこの型を中心に回っている。

```rust
trait Future {
    type Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
}

enum Poll<T> {
    Ready(T),
    Pending,
}
```

`poll` を「**進めるだけ進めて、結果を返す**」関数だと思えばよい。

- 完了したら `Ready(値)`。
- まだなら `Pending`。**ただし、`Pending` を返す前に `cx` から取れる `Waker` をどこかに登録する義務がある。**

`Waker` は「このタスクをもう一度 poll してください」と伝えるハンドルだ。ソケットが読めるようになったら、I/O ドライバがこれを呼ぶ。

**この義務を果たさずに `Pending` を返すと、そのタスクは二度と動かない。** 誰も起こさないからだ。逆に言えば、Tokio の仕事のかなりの部分は「`Waker` を正しく預かって、正しいタイミングで呼ぶ」ことに費やされている。

`async fn` は、コンパイラがこの `Future` を実装した匿名の型に変換したものだ。`.await` は「内側の future を poll して、`Pending` なら自分も `Pending` を返す」に展開される。**`Pending` は呼び出し階層を一気に上まで駆け上がる。**

## タスク: スレッドプールの「ジョブ」に当たるもの

`tokio::spawn(fut)` は、future をヒープ上の 1 個のオブジェクトにする。これが **タスク** だ。

スレッドプールのジョブとの違いは 2 つある。

1. **何度も実行される。** `Pending` を返すたびに中断され、起こされるたびに再開する。
2. **参照が複数ある。** ジョブは「キューにいるか、実行中か」だけだが、タスクは **`JoinHandle`・実行キュー・登録簿・任意個数の `Waker`** から同時に参照される。

だから、タスクの中心は「今どういう状態で、参照が何個あるか」を表す 1 語のアトミック変数になっている ([状態のページ](../task-state/))。

この章で使う語彙。

- **`Notified`** — 「このタスクは実行キューに入るべきだ」という権利を表すハンドル。**同時に 1 個しか存在しない。** これがあるおかげで、同じタスクが 2 つのワーカーで同時に走ることがない。
- **`JoinHandle`** — 完了を待ち、出力を受け取るハンドル。`await` できる。
- **`Waker`** — 「このタスクを起こす」ハンドル。何個でも作れる。中身は [タスク本体へのポインタ 1 個](../task-waker/)。
- **`OwnedTasks`** — 生きているタスク全部の登録簿。シャットダウン時に使う ([登録簿のページ](../owned-tasks/))。

## スケジューラ: ワーカーと実行キュー

既定のマルチスレッドランタイムは、CPU コア数と同じ数のワーカースレッドを立てる。各ワーカーが持つのは以下だ。

- **ローカル実行キュー** — 固定長 256 のリングバッファ ([キューのページ](../local-run-queue/))
- **LIFO スロット** — 直前に起こされたタスクを 1 個だけ置く場所 ([LIFO のページ](../lifo-slot/))
- そのほか、統計・乱数の種・時計

そして全ワーカーが共有するのが **グローバルキュー (inject queue)** で、ランタイムの外から `spawn` されたタスクや、ローカルキューから溢れたタスクが入る ([溢れのページ](../overflow-inject/))。

ワーカーの本体は、この形をしている ([`multi_thread/worker.rs#L584-L621`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/scheduler/multi_thread/worker.rs#L584-L621))。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
        while !core.is_shutdown {
            // Increment the tick
            core.tick();

            // Run maintenance, if needed
            core = self.maintenance(core);

            // First, check work available to the current worker.
            if let Some(task) = core.next_task(&self.worker) {
                core = self.run_task(task, core)?;
                continue;
            }

            // We consumed all work in the queues and will start searching for work.
            core.stats.end_processing_scheduled_tasks();

            // There is no more **local** work to process, try to steal work
            // from other workers.
            if let Some(task) = core.steal_work(&self.worker) {
                // Found work, switch back to processing
                core.stats.start_processing_scheduled_tasks();
                core = self.run_task(task, core)?;
            } else {
                // Wait for work
                core = if !self.defer.is_empty() {
                    self.park_yield(core)
                } else {
                    self.park(core)
                };
```

**自分のキューを見る → 他人から盗む → 寝る。** この 3 段が work-stealing スケジューラの全体像で、以降のページはこの各行を掘り下げていく。

語彙。

- **ワーカー (`Worker`)** — 「何番目のワーカーか」という identity。
- **コア (`Core`)** — キューや統計を含む状態一式。**ワーカーとは別の型で、別のスレッドに渡せる** ([`block_in_place` のページ](../block-in-place/))。
- **盗む (steal)** — 他のワーカーのキューから半分持ってくる。
- **park / unpark** — スレッドを寝かせる / 起こす。**Tokio の park は、ただ寝るのではなく driver を回す** (後述)。
- **tick** — ループを何周したかのカウンタ。「N 回に 1 回だけやる処理」の基準になる。

## ドライバ: park の中で OS を待つ

ここがスレッドプールと決定的に違うところだ。

普通のスレッドプールなら、仕事がないワーカーは条件変数で寝る。Tokio のワーカーは **`epoll_wait` (相当) を呼んで寝る**。

つまり `park()` の中身は「条件変数で待つ」ではなく、

1. 次のタイマーの期限を計算する ([タイマーのページ](../timer-wheel/))
2. その時間を上限に `epoll_wait` する
3. 返ってきた I/O イベントで、対応するタスクを起こす ([readiness のページ](../scheduled-io/))
4. 期限が来たタイマーで、対応するタスクを起こす

**「仕事を待つ」と「OS のイベントを待つ」が同じ 1 個の待機になっている。** これがないと、I/O 専用のスレッドを別に立てて、そこからワーカーを起こすことになり、1 往復ぶん遅くなる。

ドライバは入れ子の層になっている ([`runtime/driver.rs`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/driver.rs))。

```text
TimeDriver          ... タイマーの期限を park の待ち時間に変換する
  └ IoStack
      └ ProcessDriver   ... 子プロセスの終了 (SIGCHLD) を扱う
          └ SignalDriver ... シグナルを自己パイプで I/O に変換する
              └ IoDriver ... mio (epoll/kqueue/IOCP) を呼ぶ
```

**各層が `park` / `park_timeout` を持ち、下の層に委譲する。** そして機能を無効にすると、型エイリアスが畳まれる。

```rust title="tokio/src/runtime/driver.rs"
    cfg_io_driver! {
        type ProcessDriver = SignalDriver;

        fn create_process_driver(signal_driver: SignalDriver) -> ProcessDriver {
            signal_driver
        }
    }
```

`process` フィーチャがなければ `ProcessDriver` は `SignalDriver` そのものになる。**層が消えるのではなく、型として同一になる** ので、実行時の分岐も間接呼び出しも残らない。

語彙。

- **readiness** — 「今このソケットで何ができるか」のキャッシュ。`epoll` の通知をドライバ側で保持したもの。
- **`ScheduledIo`** — ソケット 1 個ぶんの状態 (readiness + 待っているタスクの一覧)。
- **`Registration`** — ソケットとドライバの結び付き。`TcpStream` などが内部に持つ。
- **tick** — readiness の世代番号。ワーカーの tick とは別物なので注意。

## 全体の一周

`TcpStream` から 1 バイト読む、という最小の流れで通してみる。

1. **`tokio::spawn(fut)`** — future がタスクになり、参照が 3 個 (`JoinHandle`・登録簿・`Notified`) 作られる。`Notified` がローカルキューか [グローバルキュー](../overflow-inject/) に入る。
2. **ワーカーが取り出して `poll` する。** タスクの状態語で `RUNNING` を立て、`Waker` を作って `Context` に入れ、future の `poll` を呼ぶ。
3. **future が `read()` を試みる。** `EWOULDBLOCK` なので、`Waker` を `ScheduledIo` の待ち行列に登録して `Pending` を返す。
4. **ワーカーは次のタスクへ。** キューが空になったら他人から盗み、それでもなければ `park` する。
5. **`epoll_wait` が「fd 7 が読める」を返す。** ドライバが `ScheduledIo` の readiness を更新し、待ち行列の `Waker` を呼ぶ。
6. **`Waker` がタスクの状態語を書き換え、`Notified` を作ってキューに積む。**
7. **ワーカーが再び `poll` する。** 今度は `read()` が成功する。
8. **future が `Ready` を返したら**、出力がタスクの中に書き戻され、`JoinHandle` が起こされる ([出力のページ](../task-stage/))。

**2 と 7 の間で、タスクは 1 バイトも CPU を使っていない。** これが非同期ランタイムの提供する価値で、逆に言えばここまでの手数がその代金だ。

## 公平性のための道具

以上が骨格だが、そのままだと 1 個のタスクがワーカーを占有できてしまう。常に準備完了なチャネルを回し続けるループは、`Pending` を返さない。

Rust には強制的な中断がないので、Tokio は **協調予算 (coop budget)** という仕組みを持つ ([予算のページ](../coop-budget/))。

- 1 回の poll に「128 回分の操作」という予算を与える。
- チャネルの受信、ソケットの読み書き、`Mutex` の取得などが 1 回ごとに 1 消費する。
- 0 になったら、それらの操作が **データがあっても `Pending` を返す**。

**「譲る場所」がユーザーのコードではなくライブラリの中にある** ので、普通に書いたコードが自動的に協調する。

同じ思想が、局所性の最適化にも現れる。[LIFO スロット](../lifo-slot/) は 3 回で打ち切られ、[グローバルキュー](../overflow-inject/) は N 回に 1 回必ず覗かれる。**この章を通して繰り返し出てくるのは、「速くする仕掛けには必ず打ち切り条件が付いている」という形だ。**

## ブロッキングとの境界

ランタイムにはもう 1 個のスレッドプールがある。`spawn_blocking` 用のプールだ ([プールのページ](../blocking-pool/))。

- **ワーカープール** — CPU コア数。ブロックしてはいけない。
- **ブロッキングプール** — 既定で最大 512 本。需要に応じて増減する。

そして面白いことに、**ワーカースレッド自身もブロッキングプールから供給されている**。ワーカーの正体は「コアを拾って `run` するスレッド」でしかないので、専用のスレッド生成を持つ必要がない。

## スレッドプールとの語彙対応

| Tokio           | 普通のスレッドプール     | 違い                                 |
| --------------- | ------------------------ | ------------------------------------ |
| タスク (`Task`) | ジョブ                   | 何度も中断・再開する                 |
| `Notified`      | キューに入っているジョブ | 同時に 1 個しか存在しない            |
| `JoinHandle`    | `Future`/`Promise`       | `await` できる。`abort` もできる     |
| `Waker`         | (対応なし)               | 中断したジョブを再開させるハンドル   |
| ローカルキュー  | ワーカーごとのキュー     | ほぼ同じ (256 固定長、盗める)        |
| inject queue    | グローバルキュー         | ほぼ同じ                             |
| `Core`          | ワーカーの状態           | 別スレッドに移せる                   |
| `park`          | 条件変数で待つ           | epoll を呼ぶ                         |
| driver          | (対応なし)               | OS のイベントを待って `Waker` を呼ぶ |
| coop budget     | (対応なし)               | 中断できない代わりの協調機構         |

## 読む順番

タスクの表現 (2〜6) は、この章のどのページからも参照される。特に [状態のページ](../task-state/) は先に読んでおくと後が楽になる。

スケジューラ (7〜10) は前から順に読むのがよい。キューの構造 → 溢れたときの扱い → 局所性の最適化 → 起床の判断、という 1 本の流れになっている。

公平性とブロッキング (11〜13)、ドライバ (14〜17)、同期プリミティブ (18〜19) は、どこからでも読める。ただし [readiness のページ](../scheduled-io/) は [キャンセル安全性のページ](../io-cancel-safety/) の前提になっている。

[loom のページ](../loom-model-checking/) は Tokio 固有の知識をほとんど要求しないので、そこから読み始めてもいい。ここまでのページに繰り返し出てくる `with_mut(|ptr| ...)` や「loom の下では定数を小さくする」が、何のためにあるかが分かる。
