---
title: "全タスクの登録簿をタスク ID でシャーディングし、シャットダウンはワーカーごとに別の場所から始める"
description: "ランタイムは生きているタスクを 1 個の連結リストに繋いで持っている。spawn のたびにそのロックを取るとスケールしないので、タスク ID 下位ビットでシャードに分ける。シャード数はコア数の 4 倍だが上限があり、その根拠がコメントに書かれている。シャットダウンでは全ワーカーが同じリストを畳みにくるので、開始位置をずらして衝突を減らす。"
sidebar:
  order: 6
---

## 何を学んだか

### どんな状況の話か

ランタイムを落とすとき、走っているタスクを全部止めなければならない。`Runtime` が drop された時点で、まだ完了していないタスクは全部キャンセルされる。

これをやるには **「生きているタスクの一覧」** が要る。実行キューに入っているタスクだけでは足りない。ほとんどのタスクは I/O 待ちで、どのキューにもいない。誰かが `Waker` を握っているだけだ。

そこで、spawn したタスクを全部登録簿に入れておく。

- **spawn のたびに追加** される。
- **完了のたびに削除** される。
- シャットダウン時に **全部取り出してキャンセル** する。

素朴には `Mutex<LinkedList<Task>>` だ。だが spawn と完了はランタイムで最も頻度の高い操作で、全ワーカーがこの 1 個のロックを取り合うことになる。**コアを増やしてもここで詰まる。**

### Tokio の答え

**ロックを分ける。** リストを N 個に分割し、タスクごとにどのリストに入るかを決める。

```rust title="tokio/src/util/sharded_list.rs"
pub(crate) struct ShardedList<L: ShardedListItem> {
    lists: Box<[Mutex<LinkedList<L>>]>,
    added: MetricAtomicU64,
    count: MetricAtomicUsize,
    shard_mask: usize,
}
```

割り当ての鍵は **タスク ID** だ。連番で振られるので、下位ビットを取れば自然にばらける。

そして、この設計の面白いところは **シャード数の決め方にトレードオフが明記されている** ことと、**シャットダウン時に「全員が別のシャードから始める」という一行の工夫** がある点だ。

## ソースコードのどこか

### 登録簿の構造

[`runtime/task/list.rs#L58-L83`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/list.rs#L58-L83)。

```rust title="tokio/src/runtime/task/list.rs"
pub(crate) struct OwnedTasks<S: 'static> {
    list: ShardedList<Task<S>>,
    pub(crate) id: NonZeroU64,
    closed: AtomicBool,
}
```

フィールドは 3 つだけ。シャードされたリスト、**この登録簿自身の ID**、そして閉じているかのフラグ。

リストは侵入型 (intrusive) だ。連結ポインタはタスク本体の `Trailer` の中にある (前々ページの cold 区画)。**ノードのために別のメモリを確保しない。** タスクは既にヒープにあるので、そこにポインタ 2 個を足すだけで済む。

### シャード数を決める式と、その根拠

[`#L218-L232`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/list.rs#L218-L232)。

```rust title="tokio/src/runtime/task/list.rs"
    /// Generates the size of the sharded list based on the number of worker threads.
    ///
    /// The sharded lock design can effectively alleviate
    /// lock contention performance problems caused by high concurrency.
    ///
    /// However, as the number of shards increases, the memory continuity between
    /// nodes in the intrusive linked list will diminish. Furthermore,
    /// the construction time of the sharded list will also increase with a higher number of shards.
    ///
    /// Due to the above reasons, we set a maximum value for the sharded list size,
    /// denoted as `MAX_SHARDED_LIST_SIZE`.
    fn gen_sharded_list_size(num_cores: usize) -> usize {
        const MAX_SHARDED_LIST_SIZE: usize = 1 << 16;
        usize::min(MAX_SHARDED_LIST_SIZE, num_cores.next_power_of_two() * 4)
    }
```

**「シャードを増やすと何が悪くなるか」が 2 つ書いてある。**

1. **侵入型リストのノード間のメモリ連続性が落ちる。** シャードが多いほど、1 本のリストに繋がるタスクが減り、隣接するタスクがメモリ上で遠くなる。走査時のキャッシュ効率が落ちる。
2. **リスト自体の構築時間が増える。** `Mutex<LinkedList>` を 65536 個作るのはタダではない。ランタイムの起動時間に乗る。

だから上限を設ける。コア数の 4 倍という係数も、2 の冪に切り上げてから掛けている (マスク演算で割り当てるため)。

**「この定数はいくつが良いか」ではなく「増やすと何が悪くなるか」を書いている** ので、後から調整する人が判断できる。

### 割り当ては ID の下位ビット

[`runtime/task/mod.rs#L630-L642`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/mod.rs#L630-L642)。

```rust title="tokio/src/runtime/task/mod.rs"
unsafe impl<S> sharded_list::ShardedListItem for Task<S> {
    unsafe fn get_shard_id(target: NonNull<Self::Target>) -> usize {
        // SAFETY: The caller guarantees that `target` points at a valid task.
        let task_id = unsafe { Header::get_id(target) };
        task_id.0.get() as usize
    }
}
```

タスク ID をそのまま返し、`ShardedList` 側でマスクを掛ける。

```rust title="tokio/src/util/sharded_list.rs"
    fn shard_inner(&self, id: usize) -> MutexGuard<'_, LinkedList<L>> {
        // Safety: This modulo operation ensures that the index is not out of bounds.
        unsafe { self.lists.get_unchecked(id & self.shard_mask).lock() }
    }
```

タスク ID は連番なので、下位ビットは完全に均等にばらける。ハッシュ関数が要らない。

トレイトの安全性要件が **「ID が呼び出しごとに変わらないこと」** だけなのも綺麗だ。

```rust title="tokio/src/util/sharded_list.rs"
/// Determines which linked list an item should be stored in.
///
/// # Safety
///
/// Implementations must guarantee that the id of an item does not change from
/// call to call.
pub(crate) unsafe trait ShardedListItem: Link {
```

**これが破れると、「入れたシャードと違うシャードのロックを取って削除する」ことになり、リストが壊れる。** 削除側のコメントもその点を明示している。

```rust title="tokio/src/util/sharded_list.rs"
        // SAFETY: Since the shard id cannot change, it's not possible for this node
        // to be in any other list of the same sharded list.
```

64 ビット ID を `usize` にキャストして上位が落ちうる点も、`mod.rs` 側で「落ちてもシャード ID は変わらないから問題ない」と書かれている。

### 「閉じたか」の判定はロックの中でやる

[`runtime/task/list.rs#L126-L147`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/list.rs#L126-L147)。

```rust title="tokio/src/runtime/task/list.rs"
    /// The part of `bind` that's the same for every type of future.
    unsafe fn bind_inner(&self, task: Task<S>, notified: Notified<S>) -> Option<Notified<S>>
    where
        S: Schedule,
    {
        unsafe {
            // safety: We just created the task, so we have exclusive access
            // to the field.
            task.header().set_owner_id(self.id);
        }

        let shard = self.list.lock_shard(&task);
        // Check the closed flag in the lock for ensuring all that tasks
        // will shut down after the OwnedTasks has been closed.
        if self.closed.load(Ordering::Acquire) {
            drop(shard);
            task.shutdown();
            return None;
        }
        shard.push(task);
        Some(notified)
    }
```

`closed` は `AtomicBool` なので、ロックの外でも読める。**それでもロックの中で読んでいる。**

理由がコメントに書いてある。外で読むと、こういう順序があり得る。

1. spawn 側: `closed` を読む → false
2. シャットダウン側: `closed` を true にする
3. シャットダウン側: 全シャードを走査して空にする
4. spawn 側: シャードにタスクを push

**結果、シャットダウンが終わった後の登録簿にタスクが 1 個残る。** そのタスクは誰にもキャンセルされず、ランタイムが落ちても生き残る (= リーク)。

シャードのロックを取ってから読めば、3 と 4 の順序が確定する。**「フラグを見てから行動する」形は、フラグの読みと行動が同じロックの中にないと壊れる。** 定番の罠だが、対策とその理由が 2 行で書かれている。

先に `set_owner_id` しているのも注目に値する。**リストに入る前に「どの登録簿のものか」を刻む。** 拒否された場合でも ID は残るが、`Header` のコメントによれば、それは意図的だ。

```rust title="tokio/src/runtime/task/core.rs"
    /// Once a task has been bound to a list, it can never be bound to another
    /// list, even if removed from the first list.
    ///
    /// The id is not unset when removed from a list because we want to be able
    /// to read the id without synchronization, even if it is concurrently being
    /// removed from the list.
```

**「一度書いたら変えない」ことにすると、同期なしで読めるようになる。** 削除中の相手の ID を安全に読めるのは、この不変条件のおかげだ。

そして読んだ ID は検査に使われる ([`list.rs#L202-L212`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/list.rs#L202-L212))。

```rust title="tokio/src/runtime/task/list.rs"
    pub(crate) fn remove(&self, task: &Task<S>) -> Option<Task<S>> {
        // If the task's owner ID is `None` then it is not part of any list and
        // doesn't need removing.
        let task_id = task.header().get_owner_id()?;

        assert_eq!(task_id, self.id);
```

**別のランタイムの登録簿から削除しようとしたら、`assert_eq!` で落ちる。** 複数のランタイムが 1 プロセスに同居するのは普通のことなので、これは実際に起こりうる取り違えだ。

### シャットダウンは、全員が別の場所から始める

[`#L162-L183`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/list.rs#L162-L183)。

```rust title="tokio/src/runtime/task/list.rs"
    /// Shuts down all tasks in the collection. This call also closes the
    /// collection, preventing new items from being added.
    ///
    /// The parameter start determines which shard this method will start at.
    /// Using different values for each worker thread reduces contention.
    pub(crate) fn close_and_shutdown_all(&self, start: usize)
    where
        S: Schedule,
    {
        self.closed.store(true, Ordering::Release);
        for i in start..self.get_shard_size() + start {
            loop {
                let task = self.list.pop_back(i);
                match task {
                    Some(task) => {
                        task.shutdown();
                    }
                    None => break,
                }
            }
        }
    }
```

**`start` 引数が、この関数のすべてだ。**

シャットダウン時、全ワーカースレッドがこの関数を呼ぶ。全員が 0 番から始めると、全員が 0 番のロックを取り合い、勝った 1 人以外は待って、空になったら次に進む。**シャード分けした意味が消える。**

`start` をワーカーごとに変えれば、4 番のワーカーは 4 番のシャードから始める。ロックの奪い合いが起きにくい。ループ範囲が `start..shard_size + start` になっていて、`pop_back` 側のマスク演算で折り返す。

呼び出し側を見ると、実際にワーカーのインデックスが渡っている。

```rust title="tokio/src/runtime/scheduler/multi_thread/worker.rs"
        self.shared.owned.close_and_shutdown_all(start);
```

**1 個の引数と 1 行のコメントで、シャットダウンの並列度が回復している。** シャーディングは「入れるとき」だけでなく「畳むとき」も分散させないと効果が出ない、という話だ。

### Send でないタスクのための、もう 1 つの実装

[`#L247-L302`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/list.rs#L247-L302) には `LocalOwnedTasks` がある。

```rust title="tokio/src/runtime/task/list.rs"
pub(crate) struct LocalOwnedTasks<S: 'static> {
    inner: UnsafeCell<OwnedTasksInner<S>>,
    pub(crate) id: NonZeroU64,
    _not_send_or_sync: PhantomData<*const ()>,
}
```

`Mutex` も `AtomicBool` もない。`UnsafeCell` と、`PhantomData<*const ()>` による `!Send + !Sync` の指定だけ。

**「単一スレッドからしか触られない」を型で保証したので、同期プリミティブが 1 個も要らなくなっている。** `LocalSet` や `LocalRuntime` はこちらを使う。

同じ役割のコンテナが 2 つあるのは重複に見えるが、**片方は同期のコストを完全に 0 にできる**。API の形 (`bind` / `remove` / `close_and_shutdown_all` / `assert_owner`) は揃っているので、使う側の差は小さい。

`assert_owner` の安全性コメントが、その差を端的に示している。

```rust title="tokio/src/runtime/task/list.rs"
        // safety: The task was bound to this LocalOwnedTasks, and the
        // LocalOwnedTasks is not Send or Sync, so we are on the right thread
        // for polling this task.
```

**「この構造体が `!Send` である」ことが、そのまま「今このスレッドで poll してよい」の証明になっている。**

## なぜそうなっているか

- **登録簿が必要なのは、実行キューが「生きているタスクの一覧」ではないから。** 待機中のタスクはどのキューにもいない。シャットダウンで確実に全部を畳むには、別に一覧を持つしかない。
- **シャーディングしたのは、spawn と完了が最頻の操作だから。** 1 個のロックだと、コア数を増やすほどここが直列点になる。ID の下位ビットで分ければ、追加のハッシュ計算なしで均等に散る。
- **シャード数に上限を設けたのは、増やすと別のコストが出るから。** 侵入型リストの局所性と、起動時の構築時間。無限に増やせば良いものではない、という判断とその根拠がコメントに残っている。
- **`closed` をロックの中で読むのは、「見てから行動する」の隙間を消すため。** アトミック変数だからロック外で読めるが、読んだ後に push するまでの間に閉じられると、タスクが 1 個取り残される。判定と行動を同じロックに入れることでしか防げない。
- **`owner_id` を一度書いたら消さないのは、同期なしで読みたいから。** 削除中のタスクの ID を読む場面があり、そこで排他を要求すると設計が破綻する。「不変にする」ことで、読み取りの同期そのものを不要にしている。
- **シャットダウンの開始位置をワーカーごとにずらすのは、畳むときも分散させるため。** 分割したのに全員が同じ順で走査したら、結局同じシャードを奪い合う。
- **`!Send` 版を別に用意したのは、単一スレッドなら同期が 1 個も要らないから。** 型で「他のスレッドから触られない」を保証すれば、`Mutex` も `Atomic` も消せる。共通化して `Mutex` を残すより、2 実装に分けるほうが速い。

## どう活かすか

- **競合するロックは、対象を分割してロックも分割する。** 分割の鍵は、既にオブジェクトが持っている連番 ID で足りることが多い。ハッシュを計算するより安く、分布も均等になる。
- **分割数を決める式には、「増やしたときに悪くなること」を書く。** 最適値は環境で変わるので、値そのものより判断材料を残すほうが役に立つ。上限を設けるなら、その上限が何を守っているかを書く。
- **「フラグを見てから行動する」は、フラグの読みと行動を同じロックに入れる。** アトミック変数はロックなしで読めるが、読めることと、読んだ後の行動が安全であることは別だ。この隙間から漏れるのは、たいてい「最後の 1 個」で、テストでは再現しにくい。
- **一度書いたら変えないフィールドは、同期なしで読めるようにできる。** 「削除しても消さない」を明示的な仕様にすると、読み取り側の制約が一段緩む。ただし「なぜ消さないか」を書かないと、掃除のつもりで消される。
- **所有者を ID で刻んで、境界で `assert` する。** 同種のコンテナが複数存在しうる設計では、取り違えが必ず起きる。侵入型データ構造では、それが即座にメモリ破壊になる。
- **一括処理の走査順に、呼び出し側ごとの開始位置を持たせる。** 分割したデータを全員が同じ順に舐めると、分割の効果が消える。引数 1 個で解決することが多い。
- **単一スレッド版を分けて書く価値があるか検討する。** `!Send` を型で保証できるなら、同期プリミティブが全部消せる。API の形を揃えておけば、利用側の差は小さく保てる。
