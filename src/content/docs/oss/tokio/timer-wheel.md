---
title: "階層化したタイミングホイールで、登録も取り消しも定数時間にする"
description: "何万個の sleep があっても、登録は「配列のインデックスを計算して連結リストに繋ぐ」だけで終わる。64 スロットのホイールを 6 段重ねると、1 ミリ秒精度で 2 年先まで表せる。上の階層のタイマーは、時間が進むにつれて下の階層に落ちてくる。最上段だけはリングバッファとして扱い、それより先のタイマーを丸め込む例外がある。"
sidebar:
  order: 16
---

## 何を学んだか

### どんな状況の話か

サーバは大量のタイマーを持つ。接続 1 本ごとにアイドルタイムアウト、リクエスト 1 個ごとに処理時間の上限、再送のバックオフ。**同時に生きているタイマーが数万個** というのは普通だ。

そして、その大半は **発火しない**。タイムアウトは「起きなかったこと」を確認するためのもので、正常系ではリクエストが先に終わり、タイマーは取り消される。

つまり要求はこうなる。

- **登録が速いこと** (毎リクエスト起きる)
- **取り消しが速いこと** (毎リクエスト起きる)
- **「次に発火するのはいつか」がすぐ分かること** (`epoll_wait` のタイムアウト値に要る)
- 発火は、多少遅くてもよい (めったに起きない)

素朴な実装は優先度付きキュー (二分ヒープ) だ。だが挿入も削除も O(log n) で、しかも **任意の要素の削除** には要素の位置を追跡する必要がある。

### Tokio の答え

**階層化タイミングホイール** (hashed timing wheel)。Varghese と Lauck の論文が出典として貼ってある。

```rust title="tokio/src/runtime/time/mod.rs"
/// The time driver is based on the [paper by Varghese and Lauck][paper].
///
/// A hashed timing wheel is a vector of slots, where each slot handles a time
/// slice. As time progresses, the timer walks over the slot for the current
/// instant, and processes each entry for that slot. When the timer reaches the
/// end of the wheel, it starts again at the beginning.
///
/// The wheels are:
///
/// * Level 0: 64 x 1 millisecond slots.
/// * Level 1: 64 x 64 millisecond slots.
/// * Level 2: 64 x ~4 second slots.
/// * Level 3: 64 x ~4 minute slots.
/// * Level 4: 64 x ~4 hour slots.
/// * Level 5: 64 x ~12 day slots.
```

**64 スロットのホイールを 6 段。** 各段のスロットは、1 つ下の段のホイール全体と同じ時間幅を持つ。6 段で `64^6` ミリ秒 ≒ 2 年。

登録は「期限からレベルとスロットを計算して、そのスロットの連結リストに繋ぐ」だけ。**定数時間。** 取り消しは侵入型リストからの削除なので、これも定数時間。

代償は **精度** だ。上の階層に入ったタイマーは、その階層のスロット幅 (最大 12 日) の粒度でしか位置が分からない。だが時間が進むにつれて下の階層に落ちてくるので、**発火する頃には 1 ミリ秒精度になっている**。

## ソースコードのどこか

### 構造

[`runtime/time/wheel/mod.rs#L21-L50`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/time/wheel/mod.rs#L21-L50)。

```rust title="tokio/src/runtime/time/wheel/mod.rs"
pub(crate) struct Wheel {
    /// The number of milliseconds elapsed since the wheel started.
    elapsed: u64,

    /// Timer wheel.
    ///
    /// Levels:
    ///
    /// * 1 ms slots / 64 ms range
    /// * 64 ms slots / ~ 4 sec range
    /// ...
    levels: Box<[Level; NUM_LEVELS]>,

    /// Entries queued for firing
    pending: LinkedList<TimerShared>,
}

const NUM_LEVELS: usize = 6;

const BITS_PER_LEVEL: usize = 6;

/// The maximum duration of a `Sleep`.
const MAX_DURATION: u64 = 1 << (BITS_PER_LEVEL * NUM_LEVELS);
```

**時刻はミリ秒単位の `u64`。** `Instant` ではない。

```rust title="tokio/src/runtime/time/source.rs"
    pub(crate) fn deadline_to_tick(&self, t: Instant) -> u64 {
        // Round up to the end of a ms
        self.instant_to_tick(t + Duration::from_nanos(999_999))
    }
```

**期限は必ず切り上げる。** `sleep(Duration::from_micros(500))` は 1 ミリ秒待つ。早く起きるより遅く起きるほうが安全だからで、ドライバの doc にも「1 ミリ秒の解像度を持ち、ミリ秒未満は切り上げられる」と明記されている。

### レベルの決定はビット演算 1 回

[`#L276-L289`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/time/wheel/mod.rs#L276-L289)。

```rust title="tokio/src/runtime/time/wheel/mod.rs"
fn level_for(elapsed: u64, when: u64) -> usize {
    const SLOT_MASK: u64 = (1 << BITS_PER_LEVEL) - 1;

    // Mask in the trailing bits ignored by the level calculation in order to cap
    // the possible leading zeros
    let masked = elapsed ^ when | SLOT_MASK;

    if masked >= MAX_DURATION {
        // Fudge the timer into the top level
        return NUM_LEVELS - 1;
    }

    masked.ilog2() as usize / BITS_PER_LEVEL
}
```

**「現在時刻と期限の XOR の最上位ビットの位置」でレベルが決まる。**

XOR は「上位何ビットが一致しているか」を測る操作だ。上位が長く一致していれば、その差は小さい = 下のレベルに入る。100 ミリ秒後なら 7 ビット目あたりが立つので、レベル 1 (6〜11 ビット目) になる。

`| SLOT_MASK` で下位 6 ビットを埋めているのは、**差が 0 のときに `ilog2` が定義されないのと、レベル 0 の範囲に丸めるため**。「先行ゼロの数に上限をかける」とコメントが説明している。

スロットの位置も同様にビット演算で出る。**割り算も探索もない。**

### 埋まっているスロットをビットマップで管理する

[`wheel/level.rs#L6-L21`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/time/wheel/level.rs#L6-L21)。

```rust title="tokio/src/runtime/time/wheel/level.rs"
/// Wheel for a single level in the timer. This wheel contains 64 slots.
pub(crate) struct Level {
    level: usize,

    /// Bit field tracking which slots currently contain entries.
    ///
    /// Using a bit field to track slots that contain entries allows avoiding a
    /// scan to find entries. This field is updated when entries are added or
    /// removed from a slot.
    ///
    /// The least-significant bit represents slot zero.
    occupied: u64,

    /// Slots. We access these via the EntryInner `current_list` as well, so this needs to be an `UnsafeCell`.
    slot: [LinkedList<TimerShared>; LEVEL_MULT],
}
```

**スロットが 64 個なので、`u64` 1 個で「どのスロットが埋まっているか」を表せる。** これが「1 レベル 64 スロット」を選んだ理由でもある。

次に処理すべきスロットの探索が、これで 3 命令になる ([`#L109-L120`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/time/wheel/level.rs#L109-L120))。

```rust title="tokio/src/runtime/time/wheel/level.rs"
    fn next_occupied_slot(&self, now: u64) -> Option<usize> {
        if self.occupied == 0 {
            return None;
        }

        // Get the slot for now using Maths
        let now_slot = (now / slot_range(self.level)) as usize;
        let occupied = self.occupied.rotate_right(now_slot as u32);
        let zeros = occupied.trailing_zeros() as usize;
        let slot = (zeros + now_slot) % LEVEL_MULT;

        Some(slot)
    }
```

**「今のスロットが最下位に来るように回転して、末尾のゼロを数える」。** これで「今から数えて最初に埋まっているスロット」が求まる。`rotate_right` と `trailing_zeros` はどちらも CPU の 1 命令だ。

64 個のスロットを順に見る代わりに、ビットマップの回転で済ませている。**「1 ワードに収まるサイズ」を選んだことが、走査の消滅に直結している。**

### 「次の発火時刻」は上から順に探す

[`wheel/mod.rs#L168-L191`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/time/wheel/mod.rs#L168-L191)。

```rust title="tokio/src/runtime/time/wheel/mod.rs"
    fn next_expiration(&self) -> Option<Expiration> {
        if !self.pending.is_empty() {
            // Expire immediately as we have things pending firing
            return Some(Expiration {
                level: 0,
                slot: 0,
                deadline: self.elapsed,
            });
        }

        // Check all levels
        for (level_num, level) in self.levels.iter().enumerate() {
            if let Some(expiration) = level.next_expiration(self.elapsed) {
                // There cannot be any expirations at a higher level that happen
                // before this one.
                debug_assert!(self.no_expirations_before(level_num + 1, expiration.deadline));

                return Some(expiration);
            }
        }

        None
    }
```

**下のレベルから見て、最初に見つかったものが答え。** 上のレベルにもっと早いものがあることはありえない。レベル N のスロット幅はレベル N-1 のホイール全体に等しいので、構造的にそうなる。

この不変条件が `debug_assert` で毎回検査される。`no_expirations_before` は「このレベルより上に、これより早い発火がないこと」を全部見て確かめる。**O(1) の判断を、debug ビルドでは O(レベル数) の検査で裏付けている。**

この値がそのまま `epoll_wait` のタイムアウトになる。**最大 6 回のループで「次に起きるべき時刻」が出る。**

### 時間が進むと、上から下へ落ちてくる

[`#L214-L251`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/time/wheel/mod.rs#L214-L251)。

```rust title="tokio/src/runtime/time/wheel/mod.rs"
    /// iteratively find entries that are between the wheel's current
    /// time and the expiration time.  for each in that population either
    /// queue it for notification (in the case of the last level) or tier
    /// it down to the next level (in all other cases).
    pub(crate) fn process_expiration(&mut self, expiration: &Expiration) {
        // Note that we need to take _all_ of the entries off the list before
        // processing any of them. This is important because it's possible that
        // those entries might need to be reinserted into the same slot.
        //
        // This happens only on the highest level, when an entry is inserted
        // more than MAX_DURATION into the future. When this happens, we wrap
        // around, and process some entries a multiple of MAX_DURATION before
        // they actually need to be dropped down a level. We then reinsert them
        // back into the same position; we must make sure we don't then process
        // those entries again or we'll end up in an infinite loop.
        let mut entries = self.take_entries(expiration);
```

**「スロットのリストを丸ごと外してから処理する」理由が書いてある。** 処理した結果、同じスロットに戻ることがあるからだ。外さずに走査すると、戻ってきたものをまた処理して、無限ループになる。

処理そのものはこうだ。

```rust title="tokio/src/runtime/time/wheel/mod.rs"
            // Try to expire the entry; this is cheap (doesn't synchronize) if
            // the timer is not expired, and updates registered_when.
            match unsafe { item.mark_pending(expiration.deadline) } {
                Ok(()) => {
                    // Item was expired
                    self.pending.push_front(item);
                }
                Err(expiration_tick) => {
                    let level = level_for(expiration.deadline, expiration_tick);
                    unsafe {
                        self.levels[level].add_entry(item);
                    }
                }
            }
```

**期限が来ていれば `pending` へ、まだなら再計算したレベルへ入れ直す。**

レベル 3 (4 分スロット) にいたタイマーは、そのスロットの時刻に到達したときにレベル 2 か 1 か 0 に落ちる。**落ちるたびに精度が上がる。** 最終的にレベル 0 に来たときには、1 ミリ秒の粒度で正しい位置にいる。

1 個のタイマーが落ちる回数は最大 6 回。n 個のタイマーの総移動回数は O(6n) で、**償却すると 1 個あたり定数**。

### 最上段だけは特別扱いする

`MAX_DURATION` (約 2 年) より先のタイマーはどこに入れるか。7 段目はない。

```rust title="tokio/src/runtime/time/wheel/mod.rs"
    if masked >= MAX_DURATION {
        // Fudge the timer into the top level
        return NUM_LEVELS - 1;
    }
```

**最上段に押し込む。** そして `Level::next_expiration` 側に、その辻褄合わせがある ([`level.rs#L68-L88`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/time/wheel/level.rs#L68-L88))。

```rust title="tokio/src/runtime/time/wheel/level.rs"
        if deadline <= now {
            // A timer is in a slot "prior" to the current time. This can occur
            // because we do not have an infinite hierarchy of timer levels, and
            // eventually a timer scheduled for a very distant time might end up
            // being placed in a slot that is beyond the end of all of the
            // arrays.
            //
            // To deal with this, we first limit timers to being scheduled no
            // more than MAX_DURATION ticks in the future; that is, they're at
            // most one rotation of the top level away. Then, we force timers
            // that logically would go into the top+1 level, to instead go into
            // the top level's slots.
            //
            // What this means is that the top level's slots act as a
            // pseudo-ring buffer, and we rotate around them indefinitely. If we
            // compute a deadline before now, and it's the top level, it
            // therefore means we're actually looking at a slot in the future.
            debug_assert_eq!(self.level, super::NUM_LEVELS - 1);

            deadline += level_range;
        }
```

**「最上段のスロットは擬似的なリングバッファとして、無限に回り続ける」。** 計算した期限が現在より前になったら、それは「1 周先」を意味するので、1 周分足す。

`debug_assert_eq!` で「これが起きるのは最上段だけ」を確かめている。他のレベルで起きたらバグだ。

エラー時のメッセージも徹底している。

```rust title="tokio/src/runtime/time/wheel/level.rs"
        debug_assert!(
            deadline >= now,
            "deadline={:016X}; now={:016X}; level={}; lr={:016X}, sr={:016X}, slot={}; occupied={:b}",
            deadline, now, self.level, level_range, slot_range, slot, self.occupied
        );
```

**16 進で 16 桁ゼロ埋め、`occupied` は 2 進。** ビット演算のバグを追うのに必要な形式が選ばれている。10 進で出しても、どのビットがずれているかは読めない。

### 時間が巻き戻ることがある

[`runtime/time/mod.rs#L296-L310`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/time/mod.rs#L296-L310)。

```rust title="tokio/src/runtime/time/mod.rs"
    pub(self) fn process_at_time(&self, mut now: u64) {
        let mut waker_list = WakeList::new();

        let mut lock = self.inner.lock();

        if now < lock.wheel.elapsed() {
            // Time went backwards! This normally shouldn't happen as the Rust language
            // guarantees that an Instant is monotonic, but can happen when running
            // Linux in a VM on a Windows host due to std incorrectly trusting the
            // hardware clock to be monotonic.
            //
            // See <https://github.com/tokio-rs/tokio/issues/3619> for more information.
            now = lock.wheel.elapsed();
        }
```

**`Instant` は単調だと言語が保証している。それでも巻き戻る。**

条件まで書いてある。Windows ホスト上の Linux VM で、std がハードウェアクロックの単調性を信用してしまう場合。issue 番号付き。

対処は「巻き戻ったら、現在時刻をホイールの経過時刻に切り上げる」。時計は進まないが、`set_elapsed` の `assert` で落ちることもない。**言語の保証が破れる環境が実在することを受け入れて、被害を最小化している。**

そして起こす部分は、[I/O ドライバ](../scheduled-io/) とまったく同じ形をしている。

```rust title="tokio/src/runtime/time/mod.rs"
            if let Some(waker) = unsafe { entry.fire(Ok(())) } {
                waker_list.push(waker);

                if !waker_list.can_push() {
                    // Wake a batch of wakers. To avoid deadlock, we must do this with the lock temporarily dropped.
                    drop(lock);

                    waker_list.wake_all();

                    lock = self.inner.lock();
                }
            }
```

**`WakeList` に 32 個溜めて、ロックを外して起こす。** 同じユーティリティ、同じ理由 (デッドロック回避)。

## なぜそうなっているか

- **タイミングホイールを選んだのは、登録と取り消しが発火より圧倒的に多いから。** タイムアウトの大半は取り消される。O(log n) のヒープより、O(1) の配列インデックス計算のほうがこの分布に合う。
- **階層にしたのは、1 段では範囲か精度のどちらかを捨てることになるから。** 1 ミリ秒スロットで 2 年をカバーするには 6 億スロットが要る。階層にすれば、遠い未来を粗い粒度で保持して、近づいたら細かくできる。
- **1 段 64 スロットなのは、`u64` のビットマップに収まるから。** 「どのスロットが埋まっているか」が 1 ワードで表せ、次のスロットの探索が `rotate_right` + `trailing_zeros` の 2 命令になる。
- **レベルの計算に XOR を使うのは、「上位何ビットが一致するか」がそのまま「差の大きさ」だから。** 引き算して大小比較を並べる代わりに、ビット演算 1 回で求まる。
- **期限を切り上げるのは、早く起きるほうが危険だから。** タイムアウトが規定より早く発火すると、正常な処理が中断される。1 ミリ秒遅れる分には実害が小さい。
- **最上段をリングバッファ扱いにするのは、階層を無限には作れないから。** 2 年より先のタイマーは実用上ほぼないが、書けてしまう以上は壊れない必要がある。「1 周先だと解釈する」という規則で辻褄を合わせている。
- **スロットを丸ごと外してから処理するのは、同じスロットに戻る要素があるから。** 外さずに走査すると、戻ってきた要素を再処理して無限ループになる。
- **時間の巻き戻りを吸収するのは、実環境で起きるから。** 言語の保証が破れるのは OS と仮想化の問題で、ライブラリ側からは直せない。落ちるより、進まないほうがましだ。

## どう活かすか

- **データ構造は、操作の頻度分布に合わせて選ぶ。** 「登録と取り消しが多く、発火はまれ」という分布では、汎用の優先度付きキューは最適ではない。どの操作が何回起きるかを数えてから選ぶ。
- **範囲と精度を両立させたいときは、階層化を考える。** 遠いものは粗く、近いものは細かく持つ。時間が経つにつれて粗い階層から細かい階層へ移す。総移動回数は階層数に比例するだけで、償却すると定数になる。
- **配列の要素数を 1 ワードのビット数に合わせる。** 「どこが埋まっているか」がビットマップ 1 個で表せ、走査がビット演算に化ける。64 という数字は、そこから逆算されている。
- **「上位ビットの一致長」を測りたいなら XOR。** 差の大きさによる分類は、引き算と比較の連鎖ではなく XOR + `ilog2` で書ける。
- **境界のための例外は、1 箇所に閉じ込めて `debug_assert` で守る。** 「最上段だけはリングバッファ」のような例外は、他の場所で起きたらバグだ。それを assert で明示すれば、例外の適用範囲がコードに残る。
- **ビット演算のデバッグ出力は、16 進とゼロ埋めと 2 進で出す。** 10 進では、どのビットがずれているか読めない。assert のメッセージにその形式を選んでおくと、失敗した瞬間に原因が見える。
- **言語や OS の保証が破れる環境があるなら、破れた場合の挙動を決めておく。** 「起きないはず」で `assert` すると、その環境ではプロセスが落ちる。飽和させる、丸める、といった無害な処理に倒すほうが実用的だ。
