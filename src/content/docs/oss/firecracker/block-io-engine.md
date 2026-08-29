---
title: "block の I/O エンジンを、同期と io_uring で差し替える"
description: "Firecracker の virtio-block は read/write/flush が「即実行した」か「投入した」かを返す共通 API で Sync エンジンと io_uring ベースの Async エンジンを抽象化している。SQ/CQ 枯渇時のスロットリング機構と、Async が今も Developer Preview に留め置かれている隔離上の理由を読む。"
group: "ストレージとネットワーク"
sidebar:
  order: 35
---

## 何を学んだか

### 2 つのエンジンを 1 つの enum で切り替える

Firecracker の virtio-block は、バッキングファイルへの I/O を `FileEngine` という enum で抽象化している。中身は 2 つだけだ。

|                    | `FileEngine::Sync`                                                          | `FileEngine::Async`                                            |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 実装               | `seek` + `read_exact_volatile` / `write_all_volatile`、`flush` + `sync_all` | Firecracker 自前の io_uring ラッパー (`src/vmm/src/io_uring/`) |
| ブロックするか     | する（呼び出しの中で完了する）                                              | しない（SQ に積むだけ）                                        |
| 完了の通知         | 戻り値そのもの                                                              | eventfd → epoll → `process_async_completion_event`             |
| ホストカーネル要求 | なし                                                                        | 5.10.51 以上                                                   |
| API の既定値       | これ（`io_engine: "Sync"`）                                                 | 明示指定が必要。かつ Developer Preview                         |

この 2 つを 1 本の API で扱うために、Firecracker は戻り値の型に「実行したのか、投入したのか」という区別を持ち込んだ。

```
FileEngineOk::Executed(RequestOk { req, count })  // もう終わった。すぐ used リングに入れてよい
FileEngineOk::Submitted                           // 投入しただけ。完了は後で CQ から拾う
```

`read` / `write` / `flush` の 3 つとも、この同じ enum を返す。呼び出し側の `Request::process` はこの enum を `ProcessingResult` に写し替えるだけで、どちらのエンジンが動いているかを一切知らない。

### キューが埋まったら「詰まった」と宣言して止まる

Async エンジンには Sync にない失敗モードがある。submission queue か completion queue が満杯で、これ以上リクエストを受け付けられない状態だ。これはエラーではなく単なる背圧なので、リクエストをエラー完了させてはいけない。

Firecracker はこれを `is_throttling_err()` という述語で他のエラーから分離し、専用の経路に流す。

```
process_queue()
  ├ descriptor chain を pop
  ├ Request::process(...)
  │    └ push → Err(FullCQueue | SQueue(FullQueue))
  │         → ProcessingResult::Throttled
  ├ queue.undo_pop()            ← avail リングに descriptor を戻す
  ├ is_io_engine_throttled = true
  └ break                       ← キューの処理をここで打ち切る

（以後 PROCESS_QUEUE イベントが来ても process_virtio_queues を呼ばず、
  io_engine_throttled_events メトリクスを増やすだけ）

process_async_completion_event()   ← io_uring の completion eventfd が発火
  ├ CQ を全部 pop して used リングに積む
  └ is_io_engine_throttled なら false に戻して process_queue(0) を再開
```

`undo_pop()` で descriptor chain を avail リングに戻しているのがポイントで、ゲストから見ると単に「まだ処理されていない」状態に留まる。エラーステータスは書かれない。これは [rate limiter](../rate-limiter/) が発火したときの扱いとまったく同じ形をしている。違うのは、再開のトリガーが rate limiter の timerfd ではなく io_uring の completion eventfd だという点だけだ。

### そして Async は既定にならない

ここが本題である。ドキュメントの計測値によれば、Async エンジンは NVMe 上の read ワークロードで総 IOPS が最大 30 倍、効率（IOPS / CPU 負荷）で 1.5〜3 倍改善する。それでも Firecracker は Async を既定にしていないし、production ready とも宣言していない。理由は性能ではなく、隔離のモデルに穴が開くからだ。

## ソースコードのどこか

共通 API の定義は [`src/vmm/src/devices/virtio/block/virtio/io/mod.rs#L22-L26`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/io/mod.rs#L22-L26) にある。

```rust title="src/vmm/src/devices/virtio/block/virtio/io/mod.rs"
#[derive(Debug)]
pub enum FileEngineOk {
    Submitted,
    Executed(RequestOk),
}
```

`FileEngine::read` は、この enum に 2 つのエンジンの戻り値を畳み込む
（[`io/mod.rs#L85-L109`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/io/mod.rs#L85-L109)）。
Async は `push_read` が成功したら常に `Submitted`、Sync は `read` の戻り値を `Executed` に包む。

```rust title="src/vmm/src/devices/virtio/block/virtio/io/mod.rs"
match self {
    FileEngine::Async(engine) => match engine.push_read(offset, mem, addr, count, req) {
        Ok(_) => Ok(FileEngineOk::Submitted),
        Err(err) => Err(RequestError {
            req: err.req,
            error: BlockIoError::Async(err.error),
        }),
    },
    FileEngine::Sync(engine) => match engine.read(offset, mem, addr, count) {
        Ok(count) => Ok(FileEngineOk::Executed(RequestOk { req, count })),
        ...
```

Sync 側の実体は本当にこれだけだ（[`io/sync_io.rs#L45-L59`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/io/sync_io.rs#L45-L59)）。`seek` でオフセットを合わせ、ゲストメモリのスライスへ直接読み込む。`flush()` は `File::flush` の後に `sync_all()` を呼ぶ（[`sync_io.rs#L77-L82`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/io/sync_io.rs#L77-L82)）。

Async 側は自前の io_uring ラッパーを、かなり絞った設定で構築する（[`io/async_io.rs#L71-L88`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/io/async_io.rs#L71-L88)）。

```rust title="src/vmm/src/devices/virtio/block/virtio/io/async_io.rs"
IoUring::new(
    u32::from(IO_URING_NUM_ENTRIES),
    vec![file],
    vec![
        // Make sure we only allow operations on pre-registered fds.
        Restriction::RequireFixedFds,
        // Allowlist of opcodes.
        Restriction::AllowOpCode(OpCode::Read),
        Restriction::AllowOpCode(OpCode::Write),
        Restriction::AllowOpCode(OpCode::Fsync),
    ],
    Some(completion_fd),
)
```

`IO_URING_NUM_ENTRIES` は 128 固定（[`block/virtio/mod.rs#L31`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/mod.rs#L31)）。リングは `IORING_SETUP_R_DISABLED` で作ってから制限を登録し、最後に `enable()` する（[`io_uring/mod.rs#L106-L164`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/io_uring/mod.rs#L106-L164)）。制限は一度登録すると解除できない、と `restriction.rs` のモジュールコメントが明記している。

スロットリング判定は [`io_uring/mod.rs#L68-L76`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/io_uring/mod.rs#L68-L76) の 1 メソッド、`is_throttling_err()` に集約されている。中身は `FullCQueue | SQueue(SQueueError::FullQueue)` の `matches!` だけだ。これを受けて `Request::process` が `Throttled` を返し（[`request.rs#L396-L403`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/request.rs#L396-L403)）、`process_queue` が descriptor を戻してフラグを立てる（[`device.rs#L566-L572`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/device.rs#L566-L572)）。

```rust title="src/vmm/src/devices/virtio/block/virtio/device.rs"
ProcessingResult::Throttled => {
    queue.undo_pop();
    self.is_io_engine_throttled = true;
    break;
}
```

解除は completion イベント側で行う（[`device.rs#L661-L674`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/device.rs#L661-L674)）。`completion_evt` は Async エンジンのときだけ epoll に登録される（[`event_handler.rs#L32-L40`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/event_handler.rs#L32-L40)）。イベント種別は `PROCESS_ASYNC_COMPLETION` という定数 1 つ分だけの追加で済んでいる。

なお `process_queue` の末尾には、Async のときだけ `kick_submission_queue()`（= `io_uring_enter` による submit）を呼ぶ分岐がある（[`device.rs#L597-L601`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/device.rs#L597-L601)）。avail リングを 1 周分まとめて SQ に積んでから 1 回だけ submit する形で、[used リングのバッチ更新](../used-ring-batching/)と同じ「1 回の epoll イベントで発生した仕事をまとめて 1 回のシステムコールに落とす」という発想が submission 側にも適用されている。

## なぜそうなっているか

### Developer Preview のまま置かれている理由

`docs/api_requests/block-io-engine.md` は、Async を production ready にしない理由を 2 つの未緩和の脅威として明示している。どちらも性能の話ではない。

**脅威 1: PID 枯渇。** 1 つの block デバイスに割り当てられる io_uring カーネルワーカー数の上限は、ドキュメントの式で `(1 + NUMA_COUNT * min(size_of_ring, 4 * NUMBER_OF_CPUS)` になる（5.10 のカーネルコードから導出したもので、`size_of_ring` は Firecracker 側で 128 にハードコードされている）。ホストに同居する microVM 数と 1 VM あたりの block デバイス数を掛け合わせると、カーネルの PID 上限に到達して新規プロセスが作れなくなりうる。5.15 以降はこの上限を設定できるオプションが露出しているので、可能になり次第 drive の設定インターフェースに出す計画だと書かれている。

**脅威 2: ワーカースレッドのリソース消費。** io_uring のカーネルワーカーはシステムの root cgroup に生成される。Firecracker の cgroup を継承せず、root cgroup から動かすこともできず、名前に microVM の PID の情報も含まれない。つまりワーカーを特定の Firecracker VM に帰属させることも、cgroup で CPU / メモリを制限することもできない。カーネル 5.12 以降なら Firecracker の cgroup が継承されるが、その 5.12 は Firecracker のサポート対象外である。

この 2 つは、[jailer](../jailer/) が cgroup と namespace で作った隔離の箱に、カーネル側から穴を開けることを意味する。Firecracker のマルチテナント前提（[脅威モデル](../threat-model/)）では、リソースの帰属が壊れることは性能改善で相殺できない。GA の条件は「上記の緩和策を含む LTS カーネルがリリースされ、Firecracker がそれをサポートすること」と明記されている。

### 実行時にも警告する

`AsyncFileEngine::from_file` は、エンジンを作るたびに `log_dev_preview_warning("Async file IO", None)` を呼ぶ（[`async_io.rs#L90-L102`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/io/async_io.rs#L90-L102)）。この関数はログに `[DevPreview]` プレフィックス付きの警告を出す（[`logger/mod.rs#L41-L52`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/mod.rs#L41-L52)）。ドキュメントに書くだけでなく、運用中のログにも「これは preview だ」と残す設計になっている。`docs/RELEASE_POLICY.md` によれば、developer preview の機能は互換性保証の外にあり、いつでも変更されうるし、マイナーバージョンで変更が入っても major は上がらない。

### カーネル機能は「あることを確認して」から使う

`IoUring::new` は `io_uring_setup` の直後に `check_features` を呼び、`IORING_FEAT_NODROP` がなければエラーにする（[`io_uring/mod.rs#L334-L346`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/io_uring/mod.rs#L334-L346)）。

```rust title="src/vmm/src/io_uring/mod.rs"
// We require that the host kernel will never drop completed entries due to an (unlikely)
// overflow in the completion queue.
// This feature is supported for kernels greater than 5.7.
// An alternative fix would be to keep an internal counter that tracks the number of
// submitted entries that haven't been completed and makes sure it doesn't exceed
// (2 * num_entries).
```

続く `check_operations` は `IORING_REGISTER_PROBE` で Read / Write が実際にサポートされているかを問い合わせる（[`io_uring/mod.rs#L348-L378`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/io_uring/mod.rs#L348-L378)）。要求カーネルが 5.10.51 以上なのは、io_uring そのものの可用性に加えて、こうした機能とバグ修正が揃うバージョンだからだとドキュメントに書かれている。バージョン文字列を見るのではなく、実際に probe して落ちる。これは[仕様を契約として扱う](../specification-as-contract/)姿勢とも整合している。

### キャッシュポリシーは別の軸で公開されている

I/O エンジンとは独立に、`cache_type` で `Unsafe`（既定）と `Writeback` を選べる（`docs/api_requests/block-caching.md`）。違いは 1 点だけで、virtio の `flush` 機能をゲストにアドバタイズするかどうかである。`Unsafe` は flush を出さないぶんシステムコールが減って速いが、ホストのページキャッシュが失われる状況（電源断など）でデータ整合性を犠牲にする。エンジン（どう I/O するか）と耐久性（いつディスクに落とすか）を混ぜず、別々のフィールドとして API に出している点が読みどころだ。

## どう活かすか

**バックエンドの差は、型ではなく戻り値で吸収できる。** 同期実装と非同期実装を差し替えたいとき、trait とジェネリクスで抽象化したくなる。Firecracker は enum 1 つと `Executed | Submitted` の 2 値だけで済ませた。呼び出し側は「完了したなら used リングへ、投入しただけなら何もしない」という 2 分岐を書けばよく、非同期に固有のライフサイクル（`PendingRequest` をどこに保持するか）はエンジン内部に閉じている。バックエンドが 2 つしかなく、増える予定もないなら、この規模の抽象化で十分だ。

**背圧をエラーにしない。** キューが満杯であることは、リクエストの失敗ではない。Firecracker は「未処理のまま戻す + フラグを立てる + 完了イベントで再開する」の 3 点セットで表現した。リクエストキューを持つ自作のコンポーネントでも、`Full` を `Err` に混ぜず述語で分離し、リトライ経路を用意する形はそのまま使える。逆に、再開のトリガー（ここでは completion eventfd）が存在しない設計では、このパターンはデッドロックになる。フラグを立てる前に、解除側のイベント源を必ず確認すること。

**性能の改善が隔離のモデルに穴を開けるなら、既定にしない。** これが本ページの中心である。Firecracker は Async の性能上の利点を数字付きで認めたうえで、「ワーカーが PID を消費する」「cgroup をすり抜ける」の 2 点だけを理由に既定から外し続けている。

この判断が効く前提条件ははっきりしている。ホスト上に多数のテナントが同居し、cgroup や PID 上限でリソースを区画している場合だ。逆に 1 ホスト 1 テナントで、PID も cgroup も自分のものしかないなら、この 2 つの脅威は成立しない。その環境で Async を選ぶのは合理的で、実際 API から選べるようにはしてある。学ぶべきは「io_uring を避けろ」ではなく、**自分の脅威モデルに照らして既定値を決め、既定から外した機能には preview であることをドキュメントと実行時ログの両方で残す**という運用の形のほうだ。
