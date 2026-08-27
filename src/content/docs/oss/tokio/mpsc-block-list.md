---
title: "チャネルのキューを 32 個ずつのブロックに区切り、使い終わったブロックは末尾へ回す"
description: "送信のたびにノードを確保する連結リストは、確保と解放が交互に走る。Tokio の mpsc は 32 スロットのブロック単位でリストを作り、確保を 32 回に 1 回に減らす。空になったブロックは解放せずリストの末尾に付け直すので、定常状態では確保が起きない。どのスロットが埋まったかはブロックごとのビットマップ 1 個で表され、ブロックの解放条件もそこから読める。"
sidebar:
  order: 19
---

## 何を学んだか

### どんな状況の話か

`tokio::sync::mpsc` は multi-producer single-consumer のチャネルだ。送信側は何個でも、受信側は 1 個。

素朴なロックフリーキュー (Michael-Scott キュー) は、**要素 1 個につきノードを 1 個確保する**。送信のたびに `malloc`、受信のたびに `free`。

これは 2 重に痛い。

- **確保と解放そのもののコスト。** 毎メッセージ 2 回。
- **アロケータの競合。** 複数のスレッドが同時に送信すると、アロケータのロックを取り合う。

さらに、ロックフリーな連結リストには **いつノードを解放してよいか** という難問がある。ポインタを辿っている最中に解放されると、解放済みメモリを読む。一般解はハザードポインタやエポックベース GC だが、どちらも重い。

### Tokio の答え

**32 個ずつのブロックに区切る。**

```rust title="tokio/src/sync/mpsc/block.rs"
/// A block in a linked list.
///
/// Each block in the list can hold up to `BLOCK_CAP` messages.
pub(crate) struct Block<T> {
    /// The header fields.
    header: BlockHeader<T>,

    /// Array containing values pushed into the block. Values are stored in a
    /// continuous array in order to improve cache line behavior when reading.
    /// The values must be manually dropped.
    values: Values<T>,
}
```

これで 3 つが同時に解決する。

- **確保は 32 メッセージに 1 回。**
- **値が連続した配列に並ぶので、受信側の走査がキャッシュに乗る。**
- **解放の判断がブロック単位になる。** 32 個分まとめて「もう誰も触らない」と判定すればよい。

そして **空になったブロックは解放せず、リストの末尾に付け直す**。定常状態では、確保も解放も起きない。

## ソースコードのどこか

### ブロックの大きさは、ビットマップの幅で決まる

[`sync/mpsc/mod.rs#L140-L146`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/mpsc/mod.rs#L140-L146) の周辺。

```rust title="tokio/src/sync/mpsc/mod.rs"
pub(crate) const BLOCK_CAP: usize = 32;
```

64 ビット環境で 32、32 ビット環境で 16、loom の下では 2。

この数字の根拠は、ブロックヘッダのこのフィールドにある。

```rust title="tokio/src/sync/mpsc/block.rs"
    /// Bitfield tracking slots that are ready to have their values consumed.
    ready_slots: AtomicUsize,
```

```rust title="tokio/src/sync/mpsc/block.rs"
/// Flag tracking that a block has gone through the sender's release routine.
///
/// When this is set, the receiver may consider freeing the block.
const RELEASED: usize = 1 << BLOCK_CAP;

/// Flag tracking all senders dropped.
///
/// When this flag is set, the send half of the channel has closed.
const TX_CLOSED: usize = RELEASED << 1;

/// Mask covering all bits used to track slot readiness.
const READY_MASK: usize = RELEASED - 1;
```

**「32 スロット + 2 個のフラグ」がちょうど `usize` に収まる。** 64 ビットなら余裕があるが、32 ビットでは 16 + 2 が上限に近い。だから `BLOCK_CAP` が環境で変わる。

**データ構造の粒度が、アトミック変数の幅から逆算されている。** 「1 個のアトミック変数で 1 ブロックの全状態を表す」という制約を先に決めて、そこから容量が決まっている。

loom の下で 2 になるのは、[ローカルキュー](../local-run-queue/) や [RwLock](../batch-semaphore/) と同じ手だ。**ブロックをまたぐ境界を、検査可能な時間で踏ませる。**

### 送信は「番号を取る」ことから始まる

[`sync/mpsc/list.rs#L72-L86`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/mpsc/list.rs#L72-L86)。

```rust title="tokio/src/sync/mpsc/list.rs"
    /// Pushes a value into the list.
    pub(crate) fn push(&self, value: T) {
        // First, claim a slot for the value. `Acquire` is used here to
        // synchronize with the `fetch_add` in `reclaim_blocks`.
        let slot_index = self.tail_position.fetch_add(1, Acquire);

        // Load the current block and write the value
        let block = self.find_block(slot_index);

        unsafe {
            // Write the value to the block
            block.as_ref().write(slot_index, value);
        }
    }
```

**`fetch_add(1)` で通し番号を取り、その番号から入る場所を決める。**

番号さえ取れれば、他の送信者と場所が衝突しない。CAS のリトライループがなく、**送信者が何人いても `fetch_add` は必ず 1 回で成功する**。

番号からブロックとオフセットへの変換は、ビット演算だ。

```rust title="tokio/src/sync/mpsc/block.rs"
/// Masks an index to get the block identifier.
const BLOCK_MASK: usize = !(BLOCK_CAP - 1);

/// Masks an index to get the value offset in a block.
const SLOT_MASK: usize = BLOCK_CAP - 1;
```

書き込みは「値を書く → ビットを立てる」の 2 段になっている。

```rust title="tokio/src/sync/mpsc/block.rs"
    pub(crate) unsafe fn write(&self, slot_index: usize, value: T) {
        let slot_offset = offset(slot_index);

        self.values[slot_offset].with_mut(|ptr| {
            unsafe {
                ptr::write(ptr, MaybeUninit::new(value));
            }
        });

        // Release the value. After this point, the slot ref may no longer
        // be used. It is possible for the receiver to free the memory at
        // any point.
        self.set_ready(slot_offset);
    }
```

**「ここから先はスロットへの参照を使ってはいけない。受信側がいつメモリを解放してもおかしくない」。**

`set_ready` の `fetch_or(mask, Release)` が公開の操作で、その 1 命令の前後で所有権が移る。**書き込み側から見ると、ビットを立てた瞬間にそのメモリは他人のものになる。**

### 番号は連続、完了は非連続

ここが面白いところで、**番号を取る順序と、書き終わる順序は一致しない**。

スレッド A が番号 5 を取り、スレッド B が番号 6 を取る。B のほうが先に書き終わることは普通に起きる。すると、ビットマップは「5 は空、6 は埋まり」になる。

受信側は番号順に読むので、**5 が埋まるまで待つ**。

```rust title="tokio/src/sync/mpsc/list.rs"
    /// The channel is not empty, but the first value is being written.
    Busy,
```

`try_pop` の返り値に `Busy` があるのはこのためだ。**「空」でも「閉じている」でもなく、「今まさに書かれている最中」。** 送信者が番号を取ってから書き終わるまでの一瞬にだけ現れる。

この状態を独立した返り値として持つことで、呼び出し側が「空になった」と誤認しない。

### ブロックが「確定」したかもビットマップで分かる

```rust title="tokio/src/sync/mpsc/block.rs"
    /// Returns `true` when all slots have their `ready` bits set.
    ///
    /// This indicates that the block is in its final state and will no longer
    /// be mutated.
    pub(crate) fn is_final(&self) -> bool {
        self.header.ready_slots.load(Acquire) & READY_MASK == READY_MASK
    }
```

**全ビットが立っている = そのブロックへの書き込みは全部終わった。** ロード 1 回と比較 1 回で判定できる。

これが末尾ポインタの前進に使われる ([`list.rs#L142-L178`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/mpsc/list.rs#L142-L178))。

```rust title="tokio/src/sync/mpsc/list.rs"
            // If the block is **not** final, then the tail pointer cannot be
            // advanced any more.
            try_updating_tail &= block.is_final();

            if try_updating_tail {
                // Advancing `block_tail` must happen when walking the linked
                // list. `block_tail` may not advance passed any blocks that are
                // not "final". At the point a block is finalized, it is unknown
                // if there are any prior blocks that are unfinalized, which
                // makes it impossible to advance `block_tail`.
```

**確定していないブロックを飛び越えて末尾を進めてはいけない。** 飛び越すと、そのブロックにこれから書き込む送信者を、受信側が「もう誰も触らない」と誤認する。

そして重要なのは **末尾ポインタの更新が「ついで」であること**。

```rust title="tokio/src/sync/mpsc/list.rs"
        // Decide if this call to `find_block` should attempt to update the
        // `block_tail` pointer.
        //
        // Updating `block_tail` is not always performed in order to reduce
        // contention.
        //
        // When set, as the routine walks the linked list, it attempts to update
        // `block_tail`. If the update cannot be performed, `try_updating_tail`
        // is unset.
        let mut try_updating_tail = distance > offset;
```

**リストを歩くことになった送信者だけが、ついでに末尾を進める。** しかも「距離がオフセットより大きい」という条件付きで、全員がやろうとすると `block_tail` への CAS が競合する。

CAS に負けたら諦める。**「他の誰かがやってくれている」と判断して降りる。** [idle のページ](../idle-searching/) と同じ構図だ。

### 解放してよい条件

送信側がブロックを手放すとき、「いつまでの番号の送信者ならもう来ないか」を記録する ([`block.rs#L238-L263`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/mpsc/block.rs#L238-L263))。

```rust title="tokio/src/sync/mpsc/block.rs"
    /// Releases the block to the rx half for freeing.
    ///
    /// This function is called by the tx half once it can be guaranteed that no
    /// more senders will attempt to access the block.
    pub(crate) unsafe fn tx_release(&self, tail_position: usize) {
        // Track the observed tail_position. Any sender targeting a greater
        // tail_position is guaranteed to not access this block.
        self.header
            .observed_tail_position
            .with_mut(|ptr| unsafe { *ptr = tail_position });

        // Set the released bit, signalling to the receiver that it is safe to
        // free the block's memory as soon as all slots **prior** to
        // `observed_tail_position` have been filled.
        self.header.ready_slots.fetch_or(RELEASED, Release);
    }
```

**「この時点での末尾番号」を記録して、`RELEASED` ビットを立てる。**

受信側の解放条件は「`RELEASED` が立っていて、かつ `observed_tail_position` より前の番号がすべて埋まっている」。この 2 つが揃えば、**このブロックを触りうる送信者はもう存在しない**。

ハザードポインタもエポックも使わずに、**「番号の大小」で安全性を判断している**。番号は単調増加なので、「この番号より大きい番号を取った者は、このブロックを触らない」が構造的に成り立つ。

`tail_position` の読み出しがまた `fetch_add(0, Release)` になっているのも見どころだ。

```rust title="tokio/src/sync/mpsc/list.rs"
                    // Synchronize with any senders
                    let tail_position = self.tail_position.fetch_add(0, Release);
```

[idle のページ](../idle-searching/) と同じ「読むだけの RMW」で、こちらは `Release` を伴わせるためだ。ロードには `Release` を付けられないので、値を変えない RMW にする。

### 使い終わったブロックは末尾へ回す

[`list.rs#L194-L241`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/sync/mpsc/list.rs#L194-L241)。

```rust title="tokio/src/sync/mpsc/list.rs"
    pub(crate) unsafe fn reclaim_block(&self, mut block: NonNull<Block<T>>) {
        // The block has been removed from the linked list and ownership
        // is reclaimed.
        //
        // Before dropping the block, see if it can be reused by
        // inserting it back at the end of the linked list.
        //
        // First, reset the data
        unsafe {
            block.as_mut().reclaim();
        }

        let mut reused = false;

        // Attempt to insert the block at the end
        //
        // Walk at most three times
        let curr_ptr = self.block_tail.load(Acquire);
        ...
        for _ in 0..3 {
            match unsafe { curr.as_ref().try_push(&mut block, AcqRel, Acquire) } {
                Ok(()) => {
                    reused = true;
                    break;
                }
                Err(next) => {
                    curr = next;
                }
            }
        }

        if !reused {
            let _ = unsafe { Box::from_raw(block.as_ptr()) };
        }
    }
```

**空になったブロックを、リストの末尾に付け直す。** チャネルが定常的に使われている限り、確保は最初の数回だけで済む。

「最大 3 回歩く」という上限が付いているのが実用的だ。末尾を探して延々と歩くと、その間に他の送信者が伸ばしていく。**追いつけないなら諦めて解放する。**

3 回という数字の根拠はコード上にないが、**上限があること自体が重要**で、[LIFO スロット](../lifo-slot/) の 3 回制限と同じ形をしている。最適化に必ず打ち切りが付く。

`reclaim()` でヘッダを初期化してから付け直すので、**ブロックは実質的にプールされている**。アロケータを介さない使い回しだ。

## なぜそうなっているか

- **ブロック単位にしたのは、要素ごとの確保をなくすため。** メッセージ 1 個ごとに `malloc`/`free` すると、それだけでチャネルのコストの大半になる。32 個ずつなら、償却で 1/32 になる。
- **値を連続配列に置いたのは、受信側の走査がキャッシュに乗るから。** ポインタで繋いだノードは、メモリ上でばらける。受信は 1 個ずつ順に読むので、配列なら次の要素が既にキャッシュにある。
- **ブロック容量が `usize` の幅から決まるのは、状態を 1 語で持ちたいから。** 「どのスロットが埋まったか」「解放してよいか」「送信側が閉じたか」を 1 個のアトミック変数に入れると、判定がロード 1 回で済む。32 ビット環境で 16 になるのはその帰結だ。
- **送信が `fetch_add` から始まるのは、競合しても必ず 1 回で成功するから。** CAS のリトライループだと、送信者が多いほど遅くなる。番号さえ配ってしまえば、あとは各自が自分の場所に書くだけになる。
- **`Busy` という状態があるのは、番号の取得と書き込みの完了が非同期だから。** 後の番号が先に埋まることがある。「空」と混同すると、受信側が「チャネルが空になった」と誤って判断する。
- **解放の判断を番号の大小でやるのは、汎用の回収機構が重いから。** ハザードポインタもエポック GC も、この用途には過剰だ。「単調増加する番号を配っている」という構造そのものが、安全な解放時点を教えてくれる。
- **末尾の前進を「ついで」にしたのは、全員でやると競合するから。** リストを歩く必要があった者だけがやり、CAS に負けたら降りる。誰かが進めれば全体が進む。
- **空きブロックを末尾に回すのは、解放してすぐ確保し直すのが無駄だから。** チャネルは使われ続けるので、同じブロックが何度も要る。アロケータを往復させる理由がない。

## どう活かすか

- **キューの要素を、固定数ずつのブロックにまとめる。** 確保の回数が 1/N になり、値が連続に並ぶので走査も速くなる。要素ごとにノードを確保する構造は、ほとんどの場合これに置き換えられる。
- **ブロックのサイズを、状態を表すビットマップの幅から決める。** 「1 ブロックの全状態を 1 語のアトミックで表せる」という制約を先に置くと、判定がロード 1 回になる。容量はその結果として決まる。
- **多対 1 のキューでは、まず番号を配る。** `fetch_add` は競合しても必ず成功する。番号から場所を計算できるなら、書き込みの競合はそもそも起きない。
- **「番号は取ったがまだ書いていない」状態を、独立した返り値にする。** 「空」と一緒くたにすると、呼び出し側が終了と誤認する。中間状態を型で表せば、その誤りが起きない。
- **解放の安全性を、単調増加する番号の大小で示せないか考える。** 「この番号より後の参加者は、この領域を触らない」が成り立つなら、ハザードポインタもエポックも要らない。
- **共有ポインタの前進は、既に歩いている者に「ついで」でやらせる。** 全員がやろうとすると CAS が競合する。負けたら降りる規則にすれば、リトライも要らない。
- **使い終わった領域は、解放せず自前で回す。** ただし、回す先を探す歩数には上限を付ける。追いつけない場合は素直に解放すれば、最悪ケースが有界になる。
