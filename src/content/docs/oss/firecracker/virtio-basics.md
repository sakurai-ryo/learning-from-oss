---
title: "virtio: ゲストとホストが共有リングで会話する"
description: "実機をエミュレートすると MMIO exit が出すぎるという問題から virtio を導き、virtqueue の 3 領域 (descriptor table / available ring / used ring) と 1 リクエストの往復、descriptor chain、feature negotiation と device status のステートマシンを、Firecracker の Queue / DescriptorChain / MmioTransport のコードで固定する。"
group: "仮想化と KVM をゼロから"
sidebar:
  order: 7
---

このページで導入する語彙は、以降の virtio 関連のページ全部で使い回す。丁寧にいく。

## 実在のハードウェアを演じるのは、割に合わない

前々ページで見たとおり、デバイスのエミュレーションとは「MMIO exit を受けて、レジスタの読み書きを演じる」ことだった。原理的には、これで Intel の e1000 ネットワークカードでも何でも作れる。ゲストは既存のドライバをそのまま使える。

問題は回数だ。実機のネットワークカードのドライバは、パケットを 1 つ送るのに次のようなことをする。

- 送信ディスクリプタリングにエントリを書く (これはメモリなので exit しない)
- **テールポインタレジスタを更新する** ← MMIO exit
- 割り込みが来る
- **割り込みステータスレジスタを読む** ← MMIO exit
- **割り込みをクリアするために書く** ← MMIO exit
- **完了したディスクリプタの数を知るためにレジスタを読む** ← MMIO exit

1 パケットにつき数回の `KVM_RUN` からの往復が発生する。そのたびに vCPU は止まり、ホスト側でスケジューラを経由し、また VMX non-root に戻る。数百ナノ秒から数マイクロ秒の話だが、毎秒 100 万パケット捌きたいなら破綻する。

**そもそもゲストが「自分は仮想化されている」ことを認めれば、こんな回りくどい会話は要らない。** ハードウェアのレジスタ幅もリングの形式も、実在のチップに合わせる理由がない。ホストとゲストの両方に都合のいいプロトコルを新しく決めればいい。これが**準仮想化 (paravirtualization)** で、その標準が **virtio** だ。

virtio では登場人物を次のように呼ぶ。この呼び分けは仕様の用語で、コードでもそのまま使われる。

- **デバイス (device)**: VMM 側。バックエンド。
- **ドライバ (driver)**: ゲストのカーネル側。フロントエンド。

## virtqueue — 会話の場所は共有メモリ

virtio の中心は **virtqueue** だ。ゲスト物理メモリ上に置かれた 3 つの領域からなる。ゲスト物理メモリはホストの `mmap` した領域なので、**デバイス側は普通のポインタ操作でここを読み書きできる**。exit は要らない。

3 つの領域は次のとおり。

**descriptor table (ディスクリプタテーブル)**: バッファの一覧。1 エントリ 16 バイトの固定長配列で、エントリ数がキューサイズ (2 の冪、Firecracker では最大 256)。

```
struct Descriptor {
    addr:  u64,   // バッファのゲスト物理アドレス
    len:   u32,   // バッファ長
    flags: u16,   // NEXT (0x1) / WRITE (0x2) / INDIRECT (0x4)
    next:  u16,   // NEXT が立っているとき、次のディスクリプタの添字
}
```

**available ring (available リング)**: ドライバがデバイスに「これを処理してくれ」と渡した descriptor の**添字**を積むリング。ドライバだけが書き、デバイスは読むだけ。

```
struct AvailRing {
    flags:      u16,
    idx:        u16,             // ドライバが次に書き込む位置 (単調増加、u16 で wrap)
    ring:       [u16; queue_size],
    used_event: u16,             // 通知抑制用
}
```

**used ring (used リング)**: デバイスがドライバに「処理が終わった」と返す完了通知を積むリング。デバイスだけが書き、ドライバは読むだけ。

```
struct UsedElement { id: u32, len: u32 }   // id = 先頭 descriptor の添字, len = 書き込んだバイト数
struct UsedRing {
    flags:       u16,
    idx:         u16,            // デバイスが次に書き込む位置
    ring:        [UsedElement; queue_size],
    avail_event: u16,            // 通知抑制用
}
```

**リングは「書き手が 1 人」になるように 2 本に分けられている**。available はドライバ専用、used はデバイス専用。だからロックが要らない。並行するのは `idx` の更新と `ring` への書き込みの順序だけで、そこはメモリバリアで守る。

## 1 リクエストが流れる様子

ブロックデバイスへの読み出しを例にする。ドライバは「このリクエストヘッダを読んで、このバッファにデータを書いて、このステータスバイトに結果を書け」と言いたい。

```
                       ゲスト物理メモリ (ホストからは mmap で見える)
  ┌──────────────────────────────────────────────────────────────────┐
  │  descriptor table                                                │
  │   [0] addr=0x1000 len=16   flags=NEXT      next=1   ← リクエストヘッダ (読み) │
  │   [1] addr=0x2000 len=4096 flags=NEXT|WRITE next=2  ← データ用    (書き) │
  │   [2] addr=0x3000 len=1    flags=WRITE     next=-   ← ステータス  (書き) │
  │   [3] ...                                                        │
  │                                                                  │
  │  available ring          idx=1                                   │
  │   ring[0] = 0   ← 「添字 0 から始まる鎖を処理せよ」                │
  │                                                                  │
  │  used ring               idx=0                                   │
  │   (まだ空)                                                        │
  └──────────────────────────────────────────────────────────────────┘
```

手順はこうなる。

1. **ドライバがバッファを descriptor に並べる。** 上の [0][1][2] のように書く。`flags` の `WRITE` は「**デバイスが書く**バッファ」という意味で、ドライバから見た向きではないことに注意する (仕様上 write-only とは「デバイスが書き、ドライバが読む」)。
2. **ドライバが available ring に鎖の先頭の添字を積む。** `ring[avail.idx % size] = 0` を書いてから `avail.idx` を 1 増やす。この順序が重要で、間にメモリバリアが入る。
3. **ドライバが kick する。** デバイスに「available ring を見ろ」と伝える。これがトランスポート依存の唯一の操作で、MMIO なら QueueNotify レジスタへの書き込み、PCI でも同様のレジスタ書き込みになる。**ここだけがゲスト → ホストの明示的な通知**だ。
4. **デバイスが available ring から取り出す。** 自分が最後に処理した位置 (`next_avail`) と `avail.idx` を比べ、差があれば `ring[next_avail % size]` を読んで descriptor の鎖をたどる。
5. **デバイスが処理する。** ここでは [0] からリクエストの内容 (セクタ番号など) を読み、ホストのファイルから読み出して [1] のバッファに `memcpy` し、[2] に成功コードを書く。バッファはゲスト物理メモリなので、ホストのポインタ経由でそのまま書ける。
6. **デバイスが used ring に積む。** `used.ring[used.idx % size] = { id: 0, len: 4097 }` を書いてから `used.idx` を進める。`id` は**鎖の先頭の添字**、`len` はデバイスが書いたバイト数の合計。
7. **デバイスが割り込みを上げる。** 前のページの irqfd だ。ドライバは割り込みハンドラで used ring を読み、`id` から自分のリクエストを特定して完了処理をする。

exit が発生するのは 3 の kick 1 回だけ、割り込みも 1 回だけになる。しかも **kick は ioeventfd に登録できる**ので、`KVM_RUN` から抜けずカーネル内で eventfd の signal に化ける。実機エミュレーションの数回の往復が、原理的にゼロ回まで落ちる。

## descriptor chain — 1 リクエスト = 複数バッファ

上の例で [0][1][2] を `NEXT` フラグと `next` フィールドで繋いだものを **descriptor chain (ディスクリプタチェーン)** と呼ぶ。available ring に積むのは常に鎖の先頭だけで、デバイスは `NEXT` が立っている間 `next` をたどる。

鎖が必要な理由は 2 つある。1 つは、1 つの論理的なリクエストが**性質の違う複数のバッファ**からなるから。ヘッダは読み専用、データ本体は書き込み用、ステータスは書き込み用、というように向きが混ざる。もう 1 つは、ゲスト側のバッファが**物理的に連続しているとは限らない**から。ゲストの仮想アドレス空間で連続していても、物理ページはばらばらでよい。

鎖には自然な危険がある。`next` は任意の添字を指せるので、**ドライバが循環を作れる**。ゲストは信用できない (これは Firecracker の脅威モデルの根幹だ)。だから鎖をたどる側は必ず長さに上限を設ける。

## 通知を減らす — 最後に残ったコストを削る

exit を 1 回、割り込みを 1 回まで減らしたが、それでもまだ多い。毎秒 100 万リクエストなら、毎秒 100 万回の kick と割り込みが要ることになる。

そこで virtio は **通知抑制**を用意している。available ring の末尾の `used_event` と、used ring の末尾の `avail_event` がそれだ。

- `used_event`: **ドライバが**書く。「`used.idx` がこの値に達するまでは割り込みを上げなくていい」。
- `avail_event`: **デバイスが**書く。「`avail.idx` がこの値に達するまでは kick しなくていい」。

つまり、忙しいときは互いに「まだ通知しなくていい、こっちはポーリングで見ているから」と言い合える。この機構は `VIRTIO_F_EVENT_IDX` という feature bit でネゴシエートされる。詳しくは [used ring のバッチング](../used-ring-batching/) と [通知の抑制](../notification-suppression/) で扱う。

## feature negotiation — 何ができるかを起動時に握手する

`VIRTIO_F_EVENT_IDX` のような機能は、デバイスとドライバの両方が対応していないと使えない。virtio はこれを **64 ビットのフラグの論理積**で決める。

- デバイスが「自分ができること」のビット列を提示する (`avail_features`)。
- ドライバがそのうち「自分も使いたいもの」を選んで書き返す (`acked_features`)。
- 以降、両者は `acked_features` で立っているビットの機能だけを使う。

ビットの下位はデバイス種別ごとの機能 (block なら `VIRTIO_BLK_F_FLUSH`、net なら `VIRTIO_NET_F_CSUM` など)、上位 (24 以上) は共通機能だ。

## device status — 初期化の順序を固定するステートマシン

feature の握手には順序がある。「ドライバが features を書く前にキューのアドレスを設定してはいけない」といった制約を、virtio は **device status レジスタ**という 1 バイトのビットフィールドで表現する。ドライバはビットを立てていくだけで、決して下ろさない。

```
   0 (INIT)
     │  ドライバがデバイスを認識した
     ▼
   ACKNOWLEDGE (1)
     │  ドライバがこのデバイスを扱えると判断した
     ▼
   ACKNOWLEDGE | DRIVER (1|2)
     │  feature をネゴシエートし終えた
     ▼
   ACKNOWLEDGE | DRIVER | FEATURES_OK (1|2|8)
     │  virtqueue のアドレスを設定し終えた
     ▼
   ACKNOWLEDGE | DRIVER | FEATURES_OK | DRIVER_OK (1|2|8|4)
     = デバイスが「稼働中」になる

   FAILED (128)          : ドライバが諦めた。リセットするまで復帰しない
   DEVICE_NEEDS_RESET(64): デバイス側が壊れた。ドライバに知らせる
   0 を書く              : リセット
```

**デバイス側がバッファの処理を始めてよいのは `DRIVER_OK` が立った瞬間から**だ。それ以前は virtqueue のアドレスすら確定していないので、available ring を読むこと自体が未定義になる。この 1 点が、VMM の実装で最も間違えやすい。

## トランスポート — レジスタをどこに置くかの違いでしかない

ここまで「レジスタ」と言ってきたものが実際にどこにあるかは、**トランスポート**が決める。virtio が定めるのは 2 つだ。

- **virtio-MMIO**: ゲスト物理アドレス空間に 4 KiB の窓を 1 つ取り、決まったオフセットにレジスタを並べる。オフセット `0x00` にマジックナンバー `"virt"`、`0x08` にデバイス種別、`0x50` に QueueNotify、`0x70` に device status、`0x100` 以降がデバイス固有の設定空間。デバイスの発見は「この物理アドレスに virtio デバイスがある」とカーネルコマンドラインや Device Tree で教える。
- **virtio-PCI**: PCI デバイスとして見せる。PCI の設定空間 (capability list) に「BAR の何番のどのオフセットに、どの virtio レジスタ群があるか」を書いておく。デバイスの発見は PCI バスの列挙に乗る。MSI-X が使えるので、キューごとに別の割り込みベクタを割り当てられる。

**virtqueue の構造も、descriptor の形式も、device status のステートマシンも、両者でまったく同じ**だ。違うのはレジスタの置き場所と、割り込みの届け方だけ。だから VMM のデバイス実装は、トランスポートに依存しない形で書ける。

Firecracker の場合、この選択は「デバイス発見のために ACPI や PCI 列挙をやるか」という起動時間の問題に直結する。[MMIO と PCI](../mmio-vs-pci/) と [ゲストのハードウェア探索](../guest-hardware-discovery/) で扱う。

## Firecracker ではどこに出てくるか

### descriptor と鎖

仕様の構造体がそのまま Rust の `#[repr(C)]` 構造体になっている ([`src/vmm/src/devices/virtio/queue.rs#L60-L88`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L60-L88))。

```rust title="src/vmm/src/devices/virtio/queue.rs"
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct Descriptor {
    pub addr: u64,
    pub len: u32,
    pub flags: u16,
    pub next: u16,
}
...
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct UsedElement {
    pub id: u32,
    pub len: u32,
}
```

鎖をたどるのが `DescriptorChain` だ ([`src/vmm/src/devices/virtio/queue.rs#L90-L143`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L90-L143))。

```rust title="src/vmm/src/devices/virtio/queue.rs"
pub struct DescriptorChain {
    desc_table_ptr: *const Descriptor,

    queue_size: u16,
    ttl: u16, // used to prevent infinite chain cycles
    ...
}

impl DescriptorChain {
    fn checked_new(desc_table_ptr: *const Descriptor, queue_size: u16, index: u16) -> Option<Self> {
        if queue_size <= index {
            return None;
        }
        ...
    }

    fn is_valid(&self) -> bool {
        !self.has_next() || self.next < self.queue_size
    }

    pub fn has_next(&self) -> bool {
        self.flags & VIRTQ_DESC_F_NEXT != 0 && self.ttl > 1
    }
```

上で書いた 2 つの危険がそのまま潰されている。添字がキューサイズ内かを `checked_new` と `is_valid` が見て、循環は `ttl` (初期値 = キューサイズ) が防ぐ。鎖はキューサイズより長くなりえないので、この上限で十分だ。この検証の設計は [ディスクリプタチェーンの検証](../descriptor-chain-validation/) で掘る。

`is_write_only` のドキュメントコメントが、上で注意した向きの話を明示している。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    /// If the driver designated this as a write only descriptor.
    ///
    /// If this is false, this descriptor is read only.
    /// Write only means the emulated device can write and the driver can read.
    pub fn is_write_only(&self) -> bool {
```

### Queue — 3 領域へのポインタと位置

`Queue` はキュー 1 本の状態を持つ ([`src/vmm/src/devices/virtio/queue.rs#L198-L270`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L198-L270))。ゲストが設定するゲスト物理アドレス (`desc_table_address` など 3 本) と、それを解決したホスト仮想アドレスのポインタ (`desc_table_ptr`, `avail_ring_ptr`, `used_ring_ptr`) の両方を持っているのが特徴だ。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    /// struct AvailRing {
    ///     flags: u16,
    ///     idx: u16,
    ///     ring: [u16; <queue size>],
    ///     used_event: u16,
    /// }
    ///
    /// Because all types in the AvailRing are u16,
    /// we store pointer as *mut u16 for simplicity.
    pub avail_ring_ptr: *mut u16,
```

リングのメモリレイアウトがコメントで書かれ、そこへの生ポインタが 1 本ずつ持たれている。アクセスのたびにゲスト物理アドレス → ホスト仮想アドレスの変換をやらずに済ませるためだ。この変換は `initialize` でキューが ready になったときに一度だけ行われる。

`next_avail` / `next_used` がデバイス側が覚えている位置で、`Wrapping<u16>` になっている。リングの `idx` は 16 ビットで単調増加して自然に折り返すので、比較も引き算も `Wrapping` の算術に乗る。

available ring から取り出すのが `pop` だ ([`src/vmm/src/devices/virtio/queue.rs#L469-L499`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L469-L499))。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    pub fn pop(&mut self) -> Result<Option<DescriptorChain>, InvalidAvailIdx> {
        let len = self.len();
        // The number of descriptor chain heads to process should always
        // be smaller or equal to the queue size, as the driver should
        // never ask the VMM to process a available ring entry more than
        // once. Checking and reporting such incorrect driver behavior
        // can prevent potential hanging and Denial-of-Service from
        // happening on the VMM side.
        if self.size < len {
            return Err(InvalidAvailIdx { ... });
        }
```

`len()` は `avail.idx - next_avail` だ。この差がキューサイズを超えることは正常なドライバではありえない。超えていたら悪意あるドライバとみなす、というコメントが付いている。**ゲストの書いた値を、すべて敵として検算する**という姿勢がここに出ている。

used ring への書き込みは、バリアの位置が明示的だ ([`src/vmm/src/devices/virtio/queue.rs#L594-L607`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/queue.rs#L594-L607))。

```rust title="src/vmm/src/devices/virtio/queue.rs"
    /// Set the used ring index to the current `next_used` value.
    /// Should be called once after number of `add_used` calls.
    pub fn advance_used_ring_idx(&mut self) {
        // This fence ensures all descriptor writes are visible before the index update is.
        fence(Ordering::Release);
        self.used_ring_idx_set(self.next_used.0);
    }
```

「`add_used` を何回か呼んだあとに 1 回だけ呼べ」というコメントが、上で説明した「まとめて処理して最後に `idx` を進める」形をそのまま示している。`pop_unchecked` 側には対になる `fence(Ordering::Acquire)` がある。ドライバとデバイスは別 CPU で並行に走るので、リングの整合性はこの 2 つのバリアだけで保たれている。

### デバイスのインタフェース

`VirtioDevice` トレイトが、デバイス種別によらない共通部分を切っている ([`src/vmm/src/devices/virtio/device.rs#L83-L128`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/device.rs#L83-L128))。

```rust title="src/vmm/src/devices/virtio/device.rs"
/// Trait for virtio devices to be driven by a virtio transport.
///
/// The lifecycle of a virtio device is to be moved to a virtio transport, which will then query the
/// device. The virtio devices needs to create queues, events and event fds for interrupts and
/// expose them to the transport via get_queues/get_queue_events/get_interrupt/get_interrupt_status
/// fns.
pub trait VirtioDevice: AsAny + MutEventSubscriber + Send {
    /// Get the available features offered by device.
    fn avail_features(&self) -> u64;

    /// Get acknowledged features of the driver.
    fn acked_features(&self) -> u64;
    ...
    /// Returns the device queues.
    fn queues(&self) -> &[Queue];
    ...
    /// Returns the device queues event fds.
    fn queue_events(&self) -> &[EventFd];
```

`avail_features` / `acked_features` が feature negotiation、`queues()` が virtqueue、`queue_events()` が kick 用の eventfd (前ページで ioeventfd に登録していたもの)。トレイトのドキュメントが「デバイスはトランスポートに move され、トランスポートがこれらを問い合わせる」と所有関係を書いている。

ドライバが提示していない feature を ack してきた場合の扱いは `ack_features_by_page` にあり、警告を出して該当ビットを落とす。`set_acked_features` のコメントは `avail_features() & acked_features() = acked_features()` を不変条件として要求している。ここでも**ゲストの入力を検算している**。

### device status のステートマシン

上の図の遷移が、そのまま定数の配列になっている ([`src/vmm/src/devices/virtio/transport/mmio.rs#L158-L196`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/transport/mmio.rs#L158-L196))。

```rust title="src/vmm/src/devices/virtio/transport/mmio.rs"
    /// Update device status according to the state machine defined by VirtIO Spec 1.0.
    /// Please refer to VirtIO Spec 1.0, section 2.1.1 and 3.1.1.
    ///
    /// The driver MUST update device status, setting bits to indicate the completed steps
    /// of the driver initialization sequence specified in 3.1. The driver MUST NOT clear
    /// a device status bit. ...
    fn set_device_status(&mut self, status: u32) {
        use device_status::*;

        const VALID_TRANSITIONS: &[(u32, u32)] = &[
            (INIT, ACKNOWLEDGE),
            (ACKNOWLEDGE, ACKNOWLEDGE | DRIVER),
            (ACKNOWLEDGE | DRIVER, ACKNOWLEDGE | DRIVER | FEATURES_OK),
            (
                ACKNOWLEDGE | DRIVER | FEATURES_OK,
                ACKNOWLEDGE | DRIVER | FEATURES_OK | DRIVER_OK,
            ),
        ];
```

**許可される遷移を (from, to) の組で列挙し、それ以外を拒否する**。ゲストが書いた値をそのまま `device_status` に入れることは一切ない。仕様の該当セクション番号が引用されているのもポイントで、「ドライバはビットをクリアしてはならない」という MUST が実装の根拠になっている。

そして `DRIVER_OK` に到達したところでデバイスが起動する。

```rust title="src/vmm/src/devices/virtio/transport/mmio.rs"
            // Activate the device when transitioning to DRIVER_OK.
            if status == (ACKNOWLEDGE | DRIVER | FEATURES_OK | DRIVER_OK) {
                let mut locked_device = self.device.lock().expect("Poisoned lock");
                if !locked_device.is_activated() {
                    let activate_result =
                        locked_device.activate(self.mem.clone(), self.interrupt.clone());
```

`activate` にゲストメモリと割り込みハンドルを渡すのがここだ。前々ページの「ゲスト物理メモリ = ホストの mmap」と前ページの「割り込み = eventfd」が、この 1 行で virtio デバイスに合流する。デバイスが `Inactive` / `Activated` のどちらかしか取れないよう型で表現されている話は [デバイス状態の型付け](../device-state-typing/) で扱う。

### トランスポートはレジスタの置き場所でしかない

MMIO トランスポートの読み出しが、仕様のレジスタマップそのままになっている ([`src/vmm/src/devices/virtio/transport/mmio.rs#L228-L248`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/transport/mmio.rs#L228-L248))。

```rust title="src/vmm/src/devices/virtio/transport/mmio.rs"
    fn read(&mut self, base: u64, offset: u64, data: &mut [u8]) {
        match offset {
            0x00..=0xff if data.len() == 4 => {
                let v = match offset {
                    0x0 => MMIO_MAGIC_VALUE,
                    0x04 => MMIO_VERSION,
                    0x08 => self.locked_device().device_type() as u32,
                    0x0c => VENDOR_ID, // vendor id
```

これが `BusDevice` の実装であること — つまり [前々ページ](../kvm-run-loop/) の `Bus` に登録されて、MMIO exit から `offset` 付きで呼ばれること — に注意したい。**virtio-MMIO デバイスは、Firecracker から見れば「4 KiB の窓を持つただのバスデバイス」**でしかない。

書き込み側にキューのアドレス設定がある。

```rust title="src/vmm/src/devices/virtio/transport/mmio.rs"
                    0x80 => self.update_queue_field(|q| lo(&mut q.desc_table_address, v)),
                    0x84 => self.update_queue_field(|q| hi(&mut q.desc_table_address, v)),
                    0x90 => self.update_queue_field(|q| lo(&mut q.avail_ring_address, v)),
                    0x94 => self.update_queue_field(|q| hi(&mut q.avail_ring_address, v)),
                    0xa0 => self.update_queue_field(|q| lo(&mut q.used_ring_address, v)),
                    0xa4 => self.update_queue_field(|q| hi(&mut q.used_ring_address, v)),
```

64 ビットのアドレスを 32 ビットレジスタ 2 本に分けて書く、というのが virtio-MMIO の形式だ。そして `update_queue_field` は device status を検査してから書き込む。

```rust title="src/vmm/src/devices/virtio/transport/mmio.rs"
    fn update_queue_field<F: FnOnce(&mut Queue)>(&mut self, f: F) {
        if self.check_device_status(
            device_status::FEATURES_OK,
            device_status::DRIVER_OK | device_status::FAILED,
        ) {
            self.with_queue_mut(f);
```

`FEATURES_OK` が立っていて、かつ `DRIVER_OK` がまだ立っていないときだけ受け付ける。稼働中のデバイスのキューアドレスをゲストが差し替えられたら、デバイス側が読んでいる最中のポインタが変わってしまう。ステートマシンが**メモリ安全性の前提条件**として機能している。

最後に、`0x50` (QueueNotify) の分岐が `write` に**存在しない**ことに気づいてほしい。存在しないので `warn!("unknown virtio mmio register write")` に落ちる。だがそれで問題ない — 前のページで見たとおり、このオフセットは ioeventfd としてカーネルに登録されており、**ゲストの kick は `KVM_RUN` から抜けずに eventfd の signal になる**からだ。ここに到達するのは、ioeventfd の登録より前か、登録に漏れた場合だけになる。
