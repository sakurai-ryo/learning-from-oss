---
title: "ゲストが書いたディスクリプタを、信用せずに辿る"
description: "descriptor table はゲストが自由に書き換えられる共有メモリなので、そこに並ぶ値はすべて敵性入力になる。checked_new の index 検査、ttl による循環チェーンの打ち切り、avail.idx の申告値に対する InvalidAvailIdx と「panic する場所」「ログで済ませる場所」の区別、read_volatile が必要な理由、そして Queue が生ポインタを持ったまま Send になっている根拠を読む。"
group: "virtio を実装する"
sidebar:
  order: 28
---

## 何を学んだか

[virtio の基礎](../virtio-basics/) で見たとおり、descriptor table・available ring・used ring はゲスト物理メモリ上にある。**ゲストは vCPU からいつでもこれらを書き換えられる**。VMM 側から見れば、そこに並んでいる `addr` / `len` / `flags` / `next` は、ネットワーク越しに届いたパケットと同じ扱いをしなければならない値だ。

Firecracker の脅威モデルはこれを明文化している (`docs/formal-verification.md` 冒頭)。

> all vCPUs are considered to be running potentially malicious code from the moment they are started. This means Firecracker can make no assumptions about well-formedness of data passed to it by the guest, and have to operate _safely_ no matter what input it is faced with.

「敵性入力を読むループ」の作りが、`queue.rs` の `DescriptorChain` に凝縮されている。防御は 5 段に分かれている。

| #   | 何を守るか                    | 手段                                                | 破られたときに起きること               |
| --- | ----------------------------- | --------------------------------------------------- | -------------------------------------- |
| 1   | descriptor table の範囲外読み | `checked_new` の `queue_size <= index` 検査         | ゲストメモリ外へのポインタ演算         |
| 2   | `next` が範囲外を指す         | `is_valid()` = `!has_next() \|\| next < queue_size` | 同上                                   |
| 3   | 鎖の循環による無限ループ      | `ttl` フィールドを 1 ずつ減らす                     | イベントスレッドがハングして DoS       |
| 4   | `avail.idx` の過大申告        | `pop` の `self.size < len` 検査 → `InvalidAvailIdx` | 同じ descriptor を何度も処理させられる |
| 5   | 読み出し値のすり替え (TOCTOU) | 生ポインタからの `read_volatile` で 1 回だけ読む    | 検証した値と使う値が食い違う           |

**検証はすべて「ゲストメモリから 1 回読んでローカルにコピーし、コピーを検証し、以降はコピーだけを使う」形**に揃えられている。

```
   avail ring                    descriptor table (ゲストが書く)
   idx / ring[..] ──index──▶     [0] [1] [2] ...
       │                          │
   [4] size < (idx - next_avail)  [1] index < queue_size か
       │   なら InvalidAvailIdx   [5] read_volatile で 1 回だけ読む
       ▼                          │
   pop_unchecked ──▶ DescriptorChain ◀──┘  addr/len/flags/next のコピー + ttl
                          │
                     [2] next < queue_size か  [3] ttl > 1 か
                          ▼ next_descriptor()
                     DescriptorChain (ttl - 1)
```

一方で、**`addr` と `len` は `DescriptorChain` の段階では一切検証されない**。これは意図的な分業で、実際にそのバッファへアクセスする側 (block の `Request::parse`、net の `IoVecBufferMut`) が `mem.get_slice(addr, len)` などでゲストメモリの範囲に収まるかを確認する。

## ソースコードのどこか

### 1 回読んで、コピーを検証する

`checked_new` が入口だ ([`src/vmm/src/devices/virtio/queue.rs#L115-L143`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L115-L143))。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    fn checked_new(desc_table_ptr: *const Descriptor, queue_size: u16, index: u16) -> Option<Self> {
        if queue_size <= index {
            return None;
        }

        // SAFETY:
        // index is in 0..queue_size bounds
        let desc = unsafe { desc_table_ptr.add(usize::from(index)).read_volatile() };
        let chain = DescriptorChain {
            desc_table_ptr,
            queue_size,
            ttl: queue_size,
            index,
            addr: GuestAddress(desc.addr),
            len: desc.len,
            flags: desc.flags,
            next: desc.next,
        };

        if chain.is_valid() { Some(chain) } else { None }
    }

    fn is_valid(&self) -> bool {
        !self.has_next() || self.next < self.queue_size
    }
```

順序が重要だ。**添字を検査してからポインタ演算し、`read_volatile` で 16 バイトを構造体へコピーし、コピーに対して `is_valid()` をかける。** 以後 `DescriptorChain` を使う側はゲストメモリを再度読まない。ゲストが別の vCPU で descriptor を書き換えても、取り出した `DescriptorChain` の中身は変わらない。

`read_volatile` である理由はここにある。通常の読み出しなら、コンパイラは同じアドレスからの読みをレジスタにキャッシュすることも、逆に 1 つの読みを複数回に分割・複製することも許される。**検証したときの値と、あとで使う値が別の読み出し結果になりうる** (double-fetch) のが最悪の形だ。`read_volatile` は「このアクセスは 1 回だけ、この順序で」をコンパイラに強制する。加えて、他スレッド (ゲストの vCPU) が並行に書き換えるメモリを通常の参照で読むこと自体が Rust の規則ではデータ競合なので、生ポインタ + volatile はその回避策でもある。

### ttl で循環を打ち切る

`ttl` の宣言にコメントが付いている ([`src/vmm/src/devices/virtio/queue.rs#L90-L113`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L90-L113))。

```rust title="src/vmm/src/devices/virtio/queue.rs"
pub struct DescriptorChain {
    desc_table_ptr: *const Descriptor,

    queue_size: u16,
    ttl: u16, // used to prevent infinite chain cycles
```

`next` は同じ table 内の任意の添字を指せるので、`0 → 1 → 0` のような循環をゲストが作れる。範囲検査だけでは無限ループを止められない。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    pub fn has_next(&self) -> bool {
        self.flags & VIRTQ_DESC_F_NEXT != 0 && self.ttl > 1
    }

    pub fn next_descriptor(&self) -> Option<Self> {
        if self.has_next() {
            DescriptorChain::checked_new(self.desc_table_ptr, self.queue_size, self.next).map(
                |mut c| {
                    c.ttl = self.ttl - 1;
                    c
                },
            )
        } else {
            None
        }
    }
```

([`src/vmm/src/devices/virtio/queue.rs#L145-L173`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L145-L173))

`checked_new` は常に `ttl = queue_size` で作るので、`next_descriptor` が `self.ttl - 1` で上書きする。上限は「キューの要素数」だ。同じ descriptor を 2 回通ることは許すが、キューサイズを超える長さは辿らない。

配置が効いている。`ttl > 1` の判定は `has_next()` の中に埋め込まれていて、`DescriptorIterator` も `next_descriptor()` 経由で回る。だから `for desc in head` と書いても打ち切りは自動的に効く。**安全側の判定を、使う側が呼ばざるを得ない関数に置く。**

### avail.idx の過大申告 — panic とログを分ける

`len()` は `avail.idx - next_avail` を `Wrapping<u16>` で計算した値、つまり「まだ処理していない鎖の本数」の申告値だ。正常なドライバならキューサイズを超えない。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    pub fn pop(&mut self) -> Result<Option<DescriptorChain>, InvalidAvailIdx> {
        let len = self.len();
        // The number of descriptor chain heads to process should always
        // be smaller or equal to the queue size, as the driver should
        // never ask the VMM to process a available ring entry more than
        // once. ...
        if self.size < len {
            return Err(InvalidAvailIdx { queue_size: self.size, reported_len: len });
        }
```

([`src/vmm/src/devices/virtio/queue.rs#L469-L499`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L469-L499))

面白いのは、**この関数自身は panic しない**ことだ。理由が `pop` のドキュメントコメントに書いてある。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    /// If this function returns an error at runtime, then the guest has requested Firecracker
    /// to process more virtio descriptors than there can possibly be given the queue's size.
    /// This can be a malicious guest driver scenario, and hence a DoS attempt. If encountered
    /// and runtime, correct handling is to panic!
    ///
    /// This function however is also called on paths that can (and should) just report
    /// the error to the user (e.g. loading a corrupt snapshot file), and hence cannot panic on its
    /// own.
```

同じ検査が 2 つの文脈で走る。

- **実行中のゲストが原因**なら、悪意あるドライバによる DoS 試行とみなして Firecracker を落とす。
- **壊れたスナップショットの読み込みが原因**なら、API の呼び出し元にエラーを返す。ここで落ちたらユーザは何が悪いのか分からない。

判断はエラーを受け取る側が行う。イベントループ側は panic する ([`src/vmm/src/devices/mod.rs#L28-L33`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/mod.rs#L28-L33))。

```rust title="src/vmm/src/devices/mod.rs"
pub(crate) fn report_net_event_fail(net_iface_metrics: &NetDeviceMetrics, err: DeviceError) {
    if let DeviceError::InvalidAvailIdx(err) = err {
        panic!("{}", err);
    }
    error!("{:?}", err);
    net_iface_metrics.event_fails.inc();
}
```

balloon にも同型の `report_balloon_event_fail` がある。一方スナップショット復元側は `PersistError::InvalidAvailIdx` として素直にエラーへ変換する ([`src/vmm/src/devices/virtio/persist.rs#L21-L30`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/persist.rs#L21-L30))。

なぜログではなく panic なのかは、`InvalidAvailIdx` の型定義のコメントが答えている ([`src/vmm/src/devices/virtio/queue.rs#L44-L58`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L44-L58))。

> Should this error bubble up to the event loop, we exit Firecracker, since this could be a potential malicious driver scenario. This way we also eliminate the risk of repeatedly logging and potentially clogging the microVM through the log system.

**「エラーをログに出して処理を続ける」こと自体が攻撃面になる**。ゲストが不正な `avail.idx` を毎マイクロ秒書けば、ログが溢れてディスクとホストの I/O を食い尽くせる。落とす方が安い。

### 生ポインタを持つ Queue が Send である根拠

`Queue` は `*const Descriptor` と `*mut u16` / `*mut u8` を保持する。生ポインタが入ると自動導出の `Send` が付かないので、手で書いている ([`src/vmm/src/devices/virtio/queue.rs#L272-L276`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L272-L276))。

```rust title="src/vmm/src/devices/virtio/queue.rs"
/// SAFETY: Queue is Send, because we use volatile memory accesses when
/// working with pointers. These pointers are not copied or store anywhere
/// else. We assume guest will not give different queues  same guest memory
/// addresses.
unsafe impl Send for Queue {}
```

根拠が 3 つ並んでいる。(1) ポインタ経由のアクセスはすべて volatile である。(2) ポインタはどこにも複製・保存されない。(3) **ゲストが複数のキューに同じアドレスを与えない、と仮定する。**

3 つ目が仮定であることは押さえておきたい。ゲストは実際には同じアドレスを 2 本のキューに設定できる。そうすると 2 つの `Queue` が同じメモリを指し、別スレッドで動く可能性がある。ただしそこで起きるのは**ゲスト自身のリング構造の破壊**であって、ホスト側のメモリ安全性は損なわれない。書き込み先は常にゲストメモリの mmap 範囲内で、範囲は `initialize` の `get_slice` で確認済みだからだ。**「安全性」と「ゲストにとっての正しさ」を分け、後者はゲストの自己責任にしている**、と読むのが妥当だろう。

ポインタを持つに至った経緯はコミット `26d160bc9` にある。「`GuestMemoryMmap` 全体へのアクセスと追加のチェックなしに」リングへ到達するため、というのがその趣旨で、アクセスのたびに走るゲスト物理 → ホスト仮想アドレスの解決 (リージョンの二分探索を含む) をやめる最適化だ。代償として、範囲検査は `initialize` の 1 回に前倒しされ、以降は生ポインタと添字検査だけで回る。

### アライメントは「壊れたスナップショット」対策でもある

`initialize` はアドレスのアライメントを検査する ([`src/vmm/src/devices/virtio/queue.rs#L341-L373`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L341-L373))。理由がコメントにある。

```rust title="src/vmm/src/devices/virtio/queue.rs"
        // All the below pointers are verified to be aligned properly; otherwise some methods (e.g.
        // `read_volatile()`) will panic. Such an unalignment is possible when restored from a
        // broken/fuzzed snapshot.
```

**入口はゲストだけではなく、スナップショットファイルもある**。同じ `initialize` で `size` がゼロでない・`max_size` 以下・2 のべき乗であることも確認している。

### 消費する側の検証 — block の Request::parse

`DescriptorChain` が保証するのは添字の妥当性までで、**「その鎖が block のリクエストとして意味をなすか」は別問題**だ。block はこれを `Request::parse` でやっている ([`src/vmm/src/devices/virtio/block/virtio/request.rs#L244-L329`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/virtio/request.rs#L244-L329))。

```rust title="src/vmm/src/devices/virtio/block/virtio/request.rs"
        // The head contains the request type which MUST be readable.
        if avail_desc.is_write_only() {
            return Err(VirtioBlockError::UnexpectedWriteOnlyDescriptor);
        }
        // ... 中略: data 用 descriptor の向きが要求種別と一致するか ...
                let top_sector = req
                    .sector
                    .checked_add(u64::from(req.data_len) >> SECTOR_SHIFT)
                    .ok_or(VirtioBlockError::InvalidOffset)?;
                if top_sector > num_disk_sectors {
                    return Err(VirtioBlockError::InvalidOffset);
                }
```

読み専用であるべき descriptor が書き込み可になっていないか、鎖の長さは足りているか、セクタ番号の加算は溢れないか、ディスクの末尾を超えないか。**「デバイス非依存の検証」と「デバイス固有の検証」が層として分かれている**。net 側では `IoVecBufferMut::append_descriptor_chain` が同じ位置を占め、`mem.get_slice(desc.addr, desc.len)` で `[addr, addr + len)` 全体がゲストメモリ内かを確認する ([`src/vmm/src/devices/virtio/iovec.rs#L270-L277`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/iovec.rs#L270-L277))。詳しくは [IovDeque](../iov-deque/) で扱う。

## なぜそうなっているか

### 検証をどこで済ませたかを、証明で固定している

`checked_new` には Kani のハーネスが付いている ([`src/vmm/src/devices/virtio/queue.rs#L1179-L1210`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L1179-L1210))。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    fn verify_checked_new() {
        let ProofContext(queue, mem) = kani::any();

        let index = kani::any();
        let maybe_chain = DescriptorChain::checked_new(queue.desc_table_ptr, queue.size, index);

        if index >= queue.size {
            assert!(maybe_chain.is_none())
        } else {
            // If the index was in-bounds for the descriptor table, we at least should be
            // able to compute the address of the descriptor table entry without going out
            // of bounds anywhere, and also read from that address.
```

キューのアドレスもサイズも `index` も非決定的な値で、そのすべての組み合わせについて「範囲外の `index` なら `None`」「範囲内なら descriptor table の該当エントリがゲストメモリ内に収まる」が成り立つことを検査している。`unsafe { ptr.add(index).read_volatile() }` が安全である根拠を、コメントではなく検証器に持たせた形だ。Kani 全般の位置づけは [形式検証](../kani-verification/) で扱う。

### 「敵性入力を読むループ」の型

このコードから取り出せる型は、4 つの原則に整理できる。

1. **境界検査 → 読み出し → 検証 → 使用、の順序を崩さない。** 検査に使った値と使用する値が同一であることを、コピーによって保証する。
2. **辿る操作には必ず上限を持たせる。** 入力が構造 (グラフ、木、リンクリスト) を指定できるなら、それは循環しうる。
3. **上限判定を、辿る側が呼ばざるを得ない関数に埋め込む。** `has_next()` に `ttl` を入れたのがこれ。呼び忘れが起きない。
4. **エラーの重大度は、受け取る側の文脈で決める。** 同じ「不正な値」でも、ゲスト起因なら停止、ファイル起因なら報告。

4 の背景に「とりあえずログに出して続行」が抱える穴がある。それを選ぶと**ログの発生頻度を攻撃者が制御できる**。Firecracker が「1 microVM = 1 プロセス、落ちても他に影響しない」構造を持っているからこそ、panic を選べている。

## どう活かすか

### この設計が効く前提

- **入力の発生源が明確に敵性である。** 外部からの入力を構造ごと受け取り、その構造をコード側が辿る形。パーサ、デシリアライザ、バイトコードの読み込み、共有メモリ IPC が該当する。
- **辿るループがホットパスにある。** そうでなければ範囲検査付き API (`GuestMemory::read_obj` のような) を毎回通せばよく、生ポインタと `unsafe` を持ち出す理由がない。
- **落ちてよい単位が小さい。** panic を選べるのは、プロセスが 1 つの microVM にしか責任を持たないから。マルチテナントのサーバで同じことをやると、1 人の攻撃者が全員のセッションを落とせる。

### 取り込むときの最小形

言語や `unsafe` の有無に関係なく移植できるのは、次の 2 点だ。

**共有メモリや mmap されたファイルを読むなら、フィールドを個別に参照せず、まず構造体ごとローカルにコピーする。** C なら `volatile` 修飾、Java なら `ByteBuffer` から一度読んで不変オブジェクトを作る、Go なら値のコピーを取る。ここを外すと、境界検査を書いていても TOCTOU で抜けられる。

**参照を辿る入力には無条件に深さ上限を付ける。** JSON のネスト、protobuf の再帰メッセージ、XML の実体参照、シンボリックリンクの解決。どれも同じ形の脆弱性を持つ。「循環を検出する」より「上限で打ち切る」方が実装が単純で状態も持たない。Firecracker の `ttl` がキューサイズという**ドメインに自然な上限**を使っている点は真似しやすい。魔法の定数より説明しやすい。

### 取り込むべきでない条件

**ホットパスでないなら、生ポインタと `unsafe impl Send` は割に合わない。** `Queue` の安全性主張は 3 行のコメントに乗っていて、それが正しいかはレビュアが毎回読み直すコストになる。しかも 3 つ目の根拠は「ゲストがこうしないと仮定する」という破られうる仮定だ。Firecracker は破られてもホストは安全になるよう設計を組んでいるが、これは**「破られたときに何が起きるか」を先に詰めてから `unsafe` を書いている**という順序であって、逆ではない。同じ手順を踏めないなら安全な API を使うべきだ。

**エラーで即座にプロセスを落とす判断も、単独では持ち込めない。** 落とす前提には「影響範囲が閉じている」「上位のオーケストレータが再起動を担当する」の 2 つが要る。単一プロセスに複数テナントが同居する構成なら、同じ状況では「そのセッションだけを切る」が正解だ。**panic か continue かの二択にせず、「隔離単位を落とす」という第三の選択肢を先に用意する**のが、この設計から学べる順序になる。
