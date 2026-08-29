---
title: "トークンバケットで「1 発の巨大リクエスト」をどう罰するか"
description: "Firecracker の RateLimiter は、バケット容量を超える一括消費を拒否せず、超過比率に応じた時間だけ以降の消費を止める。BucketReduction::OverConsumption という事後ペナルティ方式と、GCD 簡約・端数キャリーによる補充計算、TimerFd を epoll に載せる作りを読む。"
group: "virtio を実装する"
sidebar:
  order: 33
---

## 何を学んだか

### 3 パラメータのトークンバケット

`TokenBucket` は size / one_time_burst / refill_time の 3 つで定義される。

| パラメータ       | 意味                                                   |
| ---------------- | ------------------------------------------------------ |
| `size`           | バケット容量。トークンの上限                           |
| `one_time_burst` | 初回だけ使える追加クレジット。使い切ったら補充されない |
| `refill_time`    | 空のバケットが満杯になるまでのミリ秒数                 |

補充レートは `size / refill_time` で決まる。API では帯域(bytes)と操作回数(ops)の 2 系統を独立に設定でき、`RateLimiter` はその 2 つのバケットと 1 本の `TimerFd` を持つ。

### 「容量を超える 1 発」をどう扱うか

トークンバケットの実装で必ずぶつかるのが、**バケットの容量そのものより大きい要求**である。size = 1MB のバケットに 4MB の書き込み要求が来たらどうするか。素直に「トークンが足りないので拒否」すると、この要求は永遠に通らない。バケットは満杯でも 1MB までしか貯まらないからだ。ゲストから見れば無限に待たされ、デッドロックと区別がつかない。

Firecracker の答えは、**通してから罰する**である。`reduce()` の返り値が 3 値になっているのはこのためだ。

```rust title="src/vmm/src/rate_limiter/mod.rs"
pub enum BucketReduction {
    /// There are not enough tokens to complete the operation.
    Failure,
    /// A part of the available tokens have been consumed.
    Success,
    /// A number of tokens `inner` times larger than the bucket size have been consumed.
    OverConsumption(f64),
}
```

[`src/vmm/src/rate_limiter/mod.rs#L42-L51`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L42-L51)

```
要求トークン数 tokens に対して:

  tokens <= budget             → Success        そのまま消費
  budget < tokens <= size      → Failure        拒否。100ms 後に再試行タイマ
  size < tokens                → OverConsumption(ratio)
                                 バケットを空にして操作は通す
                                 ratio = (tokens - budget) / size
                                 以降 ratio * refill_time ミリ秒、全消費を停止
```

`OverConsumption` は「借金」である。バケットに入りきらない分を先に使わせてしまい、その返済に必要な時間だけ次以降の消費をブロックする。4MB / 1MB のバケットなら、おおよそ 3〜4 倍の `refill_time` だけ静止する。長期的な平均レートは守られ、しかも巨大な 1 発が詰まることもない。

## ソースコードのどこか

### reduce の 3 分岐

```rust title="src/vmm/src/rate_limiter/mod.rs"
        if tokens > self.budget {
            // Hit the bucket bottom, let's auto-replenish and try again.
            self.auto_replenish();

            // This operation requests a bandwidth higher than the bucket size
            if tokens > self.size {
                crate::logger::error!(
                    "Consumed {} tokens from bucket of size {}",
                    tokens,
                    self.size
                );
                // Empty the bucket and report an overconsumption of
                // (remaining tokens / size) times larger than the bucket size
                tokens -= self.budget;
                self.budget = 0;
                return BucketReduction::OverConsumption(tokens as f64 / self.size as f64);
            }

            if tokens > self.budget {
                // Still not enough tokens, consume() fails, return false.
                return BucketReduction::Failure;
            }
        }

        self.budget -= tokens;
        BucketReduction::Success
```

[`src/vmm/src/rate_limiter/mod.rs#L174-L219`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L174-L219)

補充は「消費しようとして足りなかったとき」にだけ行われる。定期的に補充スレッドを回すのではなく、必要になった瞬間に経過時間から逆算する。`one_time_burst` はその手前で先に消費される。

### ペナルティを時間に変換する

`RateLimiter::consume()` が `BucketReduction` をタイマ操作に翻訳する層である。

```rust title="src/vmm/src/rate_limiter/mod.rs"
                BucketReduction::OverConsumption(ratio) => {
                    // The operation "borrowed" a number of tokens `ratio` times
                    // greater than the size of the bucket, and since it takes
                    // `refill_time` milliseconds to fill an empty bucket, in
                    // order to enforce the bandwidth limit we need to prevent
                    // further calls to the rate limiter for
                    // `ratio * refill_time` milliseconds.
                    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
                    self.activate_timer(Duration::from_millis((ratio * refill_time as f64) as u64));
                    true
                }
```

[`src/vmm/src/rate_limiter/mod.rs#L384-L430`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L384-L430)

`OverConsumption` は `true`(= 通す)を返しつつ、タイマを張る。`Failure` のほうは `false` を返し、固定の 100ms(`REFILL_TIMER_DURATION`)で再試行タイマを張る。そして `consume()` の先頭には `if self.timer_active { return false; }` があり、タイマが動いている間は帯域バケットも ops バケットも一切消費できない。ペナルティは片方のバケットではなく `RateLimiter` 全体にかかる。

### GCD 簡約と端数キャリー

補充量の計算式は `refill_amount = (time_delta * size) / (refill_time_ms * 1_000_000)` である。素直に u64 で計算すると `time_delta * size` が容易にオーバーフローする。そこでコンストラクタで分数を約分しておく。

```rust title="src/vmm/src/rate_limiter/mod.rs"
        let common_factor = gcd(size, complete_refill_time_ns);
        // The division will be exact since `common_factor` is a factor of `size`.
        let processed_capacity: u64 = size / common_factor;
        // The division will be exact since `common_factor` is a factor of
        // `complete_refill_time_ns`.
        let processed_refill_time: u64 = complete_refill_time_ns / common_factor;
```

[`src/vmm/src/rate_limiter/mod.rs#L87-L118`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L87-L118)

これを使って `auto_replenish` は u128 で計算する。面白いのはその後だ。

```rust title="src/vmm/src/rate_limiter/mod.rs"
            // We increment `self.last_update` by the minimum time required to generate `tokens`, in
            // the case where we have the time to generate `1.8` tokens but only
            // generate `x` tokens due to integer arithmetic this will carry the time
            // required to generate 0.8th of a token over to the next call, such that if
            // the next call where to generate `2.3` tokens it would instead
            // generate `3.1` tokens. This minimizes dropping tokens at high frequencies.
```

[`src/vmm/src/rate_limiter/mod.rs#L120-L172`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L120-L172)

`last_update = now` としてしまうと、整数除算で切り捨てられた端数(0.8 トークン分の時間)がそのまま失われる。高頻度に `reduce()` が呼ばれるほど切り捨てが積み上がり、実効レートが設定値より下振れする。そこで `last_update` を「実際に生成できたトークン数を作るのに必要な最小時間」だけ進め、余りを次回に持ち越す。さらに、その時間は切り上げる。切り下げるとナノ秒の端数が 2 回使われ、極端な条件下でトークンが 1 つ余分に生まれてしまうためである。この非対称な丸め(トークンは切り捨て、消費時間は切り上げ)は、常に設定値を超えない側に倒すという方針の表れだ。

### AsRawFd で epoll に直接載る

```rust title="src/vmm/src/rate_limiter/mod.rs"
impl AsRawFd for RateLimiter {
    /// Provides a FD which needs to be monitored for POLLIN events.
    ///
    /// This object's `event_handler()` method must be called on such events.
    fn as_raw_fd(&self) -> RawFd {
        self.timer_fd.as_raw_fd()
    }
}
```

[`src/vmm/src/rate_limiter/mod.rs#L499-L509`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L499-L509)

`AsRawFd` を実装しているだけで、`RateLimiter` は他の fd と同じように epoll に登録できる。デバイス側は `ops.add(Events::with_data(&self.rx_rate_limiter, PROCESS_RX_RATE_LIMITER, EventSet::IN))` と書くだけでよく、レートリミッタが内部で timerfd を使っていることを知る必要がない([イベント処理の仕組み](../spurious-events/)を参照)。発火したら `event_handler()` を呼んで `timer_active` を落とし、止まっていたキュー処理を再開する。

`TimerFd` は使う予定がなくてもコンストラクタで必ず作る。

```rust title="src/vmm/src/rate_limiter/mod.rs"
        // We'll need a timer_fd, even if our current config effectively disables rate limiting,
        // because `Self::update_buckets()` might re-enable it later, and we might be
        // seccomp-blocked from creating the timer_fd at that time.
        let timer_fd = TimerFd::new();
```

[`src/vmm/src/rate_limiter/mod.rs#L361-L364`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L361-L364)

Firecracker は起動途中で seccomp フィルタを適用するので、`timerfd_create` は起動後には呼べない。API 経由で後からレートリミッタを有効化(`PATCH /drives` など)できるようにするには、fd を先に確保しておくしかない。[seccomp を掛けるタイミング](../per-thread-seccomp/)が、無関係に見えるコンストラクタの形を決めている例である。

### どこに適用されているか

| 適用先                 | 消費するもの                                              | 場所                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| virtio-block           | 1 op + データ長 bytes(In/Out のときだけ bytes)            | [`block/virtio/request.rs#L331-L349`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/request.rs#L331-L349) |
| virtio-net RX          | 1 op + フレーム長 bytes                                   | [`net/device.rs#L442-L468`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/net/device.rs#L442-L468)                     |
| virtio-net TX          | 同上(RX とは別インスタンス)                               | [`net/device.rs#L773-L786`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/net/device.rs#L773-L786)                     |
| virtio-pmem            | 1 op + ファイル全長 bytes(coalesce した msync 1 回につき) | [`pmem/device.rs#L363-L380`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/pmem/device.rs#L363-L380)                   |
| virtio-rng             | 1 op + 要求バイト数                                       | [`rng/device.rs#L101-L116`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/rng/device.rs#L101-L116)                     |
| シリアルコンソール出力 | バイト数のみ                                              | [`legacy/serial.rs#L154-L171`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/legacy/serial.rs#L154-L171)                      |

net は RX と TX で別インスタンスを持つ。方向ごとに独立して制限したいからで、片方が枯渇してももう片方は動く。ops バケットと bytes バケットの両方を使うデバイスは、bytes の消費に失敗したら先に消費した 1 op を `manual_replenish` で戻す。2 つのバケットに対する消費を擬似的にアトミックにしている。

**balloon、vsock、virtio-mem にはレートリミッタが付いていない。** balloon と virtio-mem はデータ転送ではなくメモリ量の制御であり、vsock は帯域制限の API が用意されていない。

シリアルだけが `RateLimiter` ではなく生の `TokenBucket` を使う。

```rust title="src/vmm/src/devices/legacy/serial.rs"
        if let Some(ref mut rl) = self.rate_limiter {
            match rl.reduce(usize_to_u64(buf.len())) {
                BucketReduction::Failure | BucketReduction::OverConsumption(_) => {
                    METRICS
                        .rate_limiter_dropped_bytes
                        .add(usize_to_u64(buf.len()));
                    return Ok(buf.len());
                }
                BucketReduction::Success => {}
            }
        }
```

[`src/vmm/src/devices/legacy/serial.rs#L154-L171`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/legacy/serial.rs#L154-L171)

ここでは `Failure` と `OverConsumption` を同じに扱い、**出力を捨てて成功を返している**。`Ok(buf.len())` は「書けたことにする」という意味だ。virtio デバイスなら「後で再開する」ができるが、シリアル出力は UART レジスタへの書き込みという同期的な操作なので、待たせるとゲストの vCPU が止まる。ログが暴走したときに microVM 全体を止めるより、ログを落とすほうがましだという判断である。捨てたバイト数は `rate_limiter_dropped_bytes` メトリクスに計上される。だから `TimerFd` も epoll 登録も不要で、`TokenBucket` を直接使えば足りる。

### Kani による検証

`rate_limiter/mod.rs` には `#[cfg(kani)]` の検証モジュールがあり、5 つのハーネスが置かれている([`#L518-L757`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L518-L757))。

- `gcd_contract_harness` — `gcd` に `#[kani::requires]` / `#[kani::ensures]` の契約を付け、結果が公約数でありかつ最大であることを検証
- `verify_token_bucket_new` — `None` が返るのは size か refill_time が 0、または refill_time がナノ秒換算でオーバーフローする場合に限ることを検証
- `verify_token_bucket_auto_replenish` — 任意の時間経過後も `is_valid()` が保たれること
- `verify_token_bucket_reduce` — one_time_burst が budget より先に減ること、`Failure` のときは状態が悪化しないこと、そして `kani::cover!()` で `Failure` に到達する経路が実在すること
- `verify_token_bucket_force_replenish` — 補充で budget も burst も減らないこと

`Instant::now()` は非決定的だが単調非減少なスタブに差し替えられている([`#L525-L615`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/rate_limiter/mod.rs#L525-L615))。`docs/formal-verification.md` は検証対象の選定基準を「ゲストのデータを直接扱うもの、あるいは伝統的な手法でテストしにくいもの」とし、レートリミッタを後者の例として名指ししている([`docs/formal-verification.md#L24-L29`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/formal-verification.md#L24-L29))。時間に依存するコードは、時刻を動かせないユニットテストでは境界条件を網羅できない。

## なぜそうなっているか

`docs/design.md` はレートリミッタの目的を「host hardware resources are used fairly by multiple microVMs」と書いている([`#L131-L144`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/design.md#L131-L144))。1 台のホストに数百〜数千の microVM を詰め込む前提なので、隣の microVM が I/O を占有しないことが要件になる。個々の microVM に対する厳密な遅延保証ではなく、集合としての公平性が目的だ。

この目的なら `OverConsumption` の設計は筋が通る。単発の巨大リクエストを一時的に通しても、その後の停止時間で帳尻が合えば、長期平均としてのホスト資源の分配は守られる。逆に、瞬間的なバーストを絶対に許さない要件(たとえばネットワーク機器のシェーピング)なら、この方式は使えない。

`docs/design.md` の同じ節は、「For vhost-user devices, customers should implement rate limiting on the side of the vhost-user backend that they provide」とも書いている。[データパスを外部プロセスに出す](../vhost-user/)と、Firecracker はリクエストを見ないのでレートリミッタも効かない。制限は「データが自分のプロセスを通ること」に依存している。

## どう活かすか

**`BucketReduction` の 3 値化は、そのまま持ち帰る価値がある。** 「通った / 通らなかった」の bool では、容量超えの要求を表現できない。API のレートリミットでも、単一リクエストが 1 分あたりの上限を超えるケース(巨大なバッチ、長大なプロンプト)は必ず出てくる。そこで拒否一択にするとクライアントは詰まり、無条件に通すと制限が意味を失う。「通すが、その分の時間だけ以降を止める」という第 3 の選択肢を最初から型に入れておく。

適用条件は、**その操作が分割不可能で、かつ拒否しても状況が改善しない**ことだ。4MB の書き込みを 1MB ずつに割れるなら割ったほうがよく、その場合は 2 値で足りる。割れないから事後ペナルティにする。

**シリアルの例は「待たせられない経路では捨てる」という別解を示している。** 同期的な経路にレートリミットを掛けると、待つ = 呼び出し元をブロックする、になってしまう。そこでは (a) 落とす、(b) 制限を掛けない、の 2 択になる。Firecracker は落とす側を選び、落とした量をメトリクスに出した。制限を掛ける前に「枯渇したとき何をするか」を先に決め、それが「待つ」なら非同期の再開機構(タイマ + イベントループ)が必要になる、という順序で設計する。

**整数演算の端数キャリーは、レート制限に限らず効く。** 「経過時間からトークン数を計算する」形の実装は、高頻度に呼ばれると切り捨てで実効レートが下振れする。`last_update` を現在時刻ではなく「実際に消費した分だけ」進める、という 1 行の違いが精度を決める。逆に、呼び出し頻度が低い(秒に数回)なら気にする必要はない。この工夫が要るのは、補充間隔がトークン 1 個の生成時間を下回るような高頻度呼び出しがある場合だけである。

**取り込むべきでない場面**もはっきりしている。分散システムで複数プロセスに跨る制限を掛けたいなら、この設計は使えない。`TokenBucket` の状態はプロセス内のメモリにあり、`Instant` は単調時計で他ノードと共有できない。Firecracker のレートリミッタが単純でいられるのは、1 プロセス = 1 microVM = 1 制限単位という対応が成り立っているからだ。共有ストレージや調整プロトコルが要る時点で、別の設計を考えたほうがよい。
