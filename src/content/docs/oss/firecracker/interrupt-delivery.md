---
title: "割り込みをゲストに届ける"
description: "デバイス側の準備ができたことをゲストに伝える経路を追う。PIC / IOAPIC / LAPIC をカーネル内でエミュレートする irqchip、GSI という番号空間、eventfd に write するだけで割り込みが上がる irqfd、そして割り込みをメモリ書き込みとして表現する MSI-X を、Firecracker の register_irq と MsixVectorGroup で読む。"
group: "仮想化と KVM をゼロから"
sidebar:
  order: 6
---

前のページは「ゲスト → VMM」の向きだった。ゲストが MMIO やポート I/O を叩くと `KVM_RUN` が抜けてきて、VMM がデバイスを演じて戻る。この向きは、**ゲストが自分から聞きに来る**から素直に実装できる。

このページは逆向きだ。ホスト側でパケットが届いた、ディスクの読み出しが終わった。それをゲストに伝えたい。ゲストは今まさに `KVM_RUN` の中で自分のコードを走らせていて、こちらを見ていない。どうやって割り込むか。

## そもそも割り込みとは何だったか

実機の話から始める。CPU は 1 本の入力線 (INTR ピン) を持っていて、そこに信号が来ると、実行中の命令の切れ目で現在の状態を退避し、あらかじめ登録しておいたハンドラに飛ぶ。これが割り込みだ。

だがデバイスは何十個もある。線は 1 本しかない。そこで間に**割り込みコントローラ**を挟む。

- **PIC (8259A)**: 最初期の PC の割り込みコントローラ。8 本の入力を持ち、2 個をカスケードして 15 本まで扱う。優先度制御と、「処理が終わった」を伝える EOI (End Of Interrupt) の仕組みを持つ。1981 年の設計で、今も互換性のために残っている。
- **IOAPIC**: PIC の後継。24 本の入力ピン (redirection entry) を持ち、各ピンについて「どの割り込みベクタ番号として」「どの CPU に」届けるかをテーブルで設定できる。マルチプロセッサ対応の要。
- **LAPIC (Local APIC)**: CPU コアごとに 1 個ずつ付いている。IOAPIC や他コアから届いた割り込みを受け取って、実際に自分のコアに割り込みを入れる。タイマ、IPI (プロセッサ間割り込み)、EOI もここで扱う。

流れは `デバイス → (割り込み線) → IOAPIC → (バス) → 対象コアの LAPIC → CPU コア` になる。

## ゲストの割り込みコントローラを誰がエミュレートするか

素直に考えると、VMM が LAPIC も IOAPIC も PIC もソフトウェアで実装することになる。だがそれは非常に遅い。

ゲストのカーネルは割り込みを 1 回処理するごとに **LAPIC の EOI レジスタに書き込む**。割り込みが毎秒数万回来るなら、そのぶん MMIO exit が発生して `KVM_RUN` から抜けることになる。割り込みハンドラの入口と出口だけでユーザースペースへの往復が入るのは割に合わない。

そこで KVM は、これらを**カーネル内でエミュレートする**選択肢を用意している。vm fd に対する ioctl 1 本だ。

```c
ioctl(vm_fd, KVM_CREATE_IRQCHIP, 0);   /* PIC 2 個 + IOAPIC をカーネル内に作る */
ioctl(vm_fd, KVM_CREATE_PIT2, &cfg);   /* レガシータイマ (8254 PIT) も */
```

こうすると、以降に `KVM_CREATE_VCPU` で作る vCPU には自動的にカーネル内 LAPIC が付く。ゲストが EOI を書いても、割り込みマスクを操作しても、タイマを読んでも、**すべて KVM の中で完結してユーザースペースには上がってこない**。前のページで「`KVM_EXIT_HLT` は Firecracker には上がってこない」と書いたのもこれが理由で、`hlt` した vCPU を割り込みが来るまで寝かせるのもカーネル内 irqchip の仕事になる。

代わりに VMM は、「割り込みコントローラの入力ピンに信号を入れる」ことだけをやればよくなる。

## GSI — 割り込み線に付けた通し番号

VMM が KVM に「割り込みを上げてくれ」と言うには、どの線かを指定する必要がある。だが PIC のピン番号と IOAPIC のピン番号は別物だし、MSI には物理的な線すらない。

KVM はこれを **GSI (Global System Interrupt) 番号**という 1 つの整数空間に統一している。VMM は「GSI 7 を上げてくれ」と言うだけでよく、その GSI が実際に何にマップされるかは別途 **GSI ルーティングテーブル**で設定する。

```c
struct kvm_irq_routing_entry {
    __u32 gsi;
    __u32 type;   /* KVM_IRQ_ROUTING_IRQCHIP か KVM_IRQ_ROUTING_MSI か */
    ...
    union {
        struct { __u32 irqchip; __u32 pin; } irqchip;  /* どのチップの何番ピンか */
        struct { __u32 address_lo, address_hi, data; } msi;  /* MSI メッセージ */
    } u;
};
```

このエントリの配列を `KVM_SET_GSI_ROUTING` で丸ごと設定する。差分更新ではなく毎回全置換なので、VMM 側でテーブルの現在値を持っておく必要がある。

x86 では GSI 0〜23 が IOAPIC の 24 本のピンに対応する慣習で、それより上を MSI 用に使う。上限は `KVM_MAX_IRQ_ROUTES` で 4096 だ。

## irqfd — ioctl を経由せずに割り込みを上げる

GSI が決まっても、「今それを上げる」操作が要る。素直には `KVM_IRQ_LINE` ioctl だが、これだと割り込みのたびにシステムコールが要る。しかも割り込みを上げたいのは、多くの場合デバイスを処理しているワーカースレッドの中だ。

KVM の答えが **irqfd** だ。

```c
struct kvm_irqfd { __u32 fd; __u32 gsi; ... };
ioctl(vm_fd, KVM_IRQFD, &irqfd);   /* この eventfd と この GSI を結びつける */
```

一度登録すれば、あとは **その eventfd に `write(2)` するだけで、対応する GSI の割り込みがゲストに上がる**。

なぜこれが速いのか。eventfd はカーネル内のオブジェクトで、KVM は登録時にその eventfd に自分のコールバックを仕掛けている。`write` した瞬間、カーネル内で KVM の割り込み注入経路が呼ばれ、カーネル内 irqchip が対象 vCPU の LAPIC に割り込みを積む。**ユーザースペースに戻ることも、KVM の ioctl を経由することもない**。

さらに、eventfd はただのファイルディスクリプタなので、割り込みを上げる権限を他のプロセスに渡せる。vhost-user のように、デバイスのデータ処理を別プロセスに任せておいて、そのプロセスが直接ゲストに割り込みを上げる、という構成が成り立つのはこの性質のおかげだ。

逆向きの **ioeventfd** (`KVM_IOEVENTFD`) もある。こちらは「ゲストがこの物理アドレスに書いたら、この eventfd を signal する」という登録で、`KVM_EXIT_MMIO` でユーザースペースに戻る代わりにカーネル内で eventfd を叩いて `KVM_RUN` を続行させる。virtio の「kick」で使われる。

```
  [ホスト → ゲスト]  デバイスのワーカー ── write() ──▶ eventfd ──▶ KVM ──▶ LAPIC ──▶ vCPU
                                                        (irqfd)

  [ゲスト → ホスト]  vCPU ── MMIO write ──▶ KVM ──▶ eventfd ──▶ epoll で待つ VMM スレッド
                                          (ioeventfd)  KVM_RUN は抜けない
```

どちらも「exit を発生させずに、カーネル内で fd の通知に変換する」という同じ発想だ。

## MSI / MSI-X — 割り込みをメモリ書き込みとして表現する

割り込み線には限界がある。IOAPIC のピンは 24 本しかないので、デバイスが増えれば共有せざるをえない。共有された割り込みが上がるとカーネルはぶら下がっている全ドライバに問い合わせる必要があり、遅い。そして「線を共有する」構造上、デバイスごとに違う CPU に割り込むこともできない。

PCI が導入した **MSI (Message Signaled Interrupt)** は、この物理的な線をやめてしまう。デバイスは割り込みを上げたいとき、**あらかじめ設定された物理アドレスに、あらかじめ設定されたデータを書き込む**。x86 ではそのアドレスが `0xfee00000` 台 (LAPIC のアドレス範囲) で、アドレスの下位ビットが宛先 CPU を、データがベクタ番号を表す。

**MSI-X** はその拡張で、デバイスが最大 2048 個のベクタを持てる。デバイスの MMIO 空間の中に「MSI-X テーブル」があり、各エントリが `{address_lo, address_hi, data, vector_control}` を持つ。ゲストのドライバがそこに書き込むことで、「このキューの割り込みはこの CPU のこのベクタへ」という設定をベクタごとに独立して行える。

VMM から見ると、MSI は「GSI ルーティングのエントリタイプが `KVM_IRQ_ROUTING_MSI` になり、ピン番号の代わりにアドレスとデータを持つ」というだけだ。上げる手段は irqfd で同じ。ゲストのドライバが MSI-X テーブルに書いた内容を読み取って、それを GSI ルーティングに転記するのが VMM の仕事になる。

## Firecracker ではどこに出てくるか

### irqchip を作る

x86_64 では VM 作成直後に呼ばれる ([`src/vmm/src/arch/x86_64/vm.rs#L171-L184`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vm.rs#L171-L184))。

```rust title="src/vmm/src/arch/x86_64/vm.rs"
    pub fn setup_irqchip(&self) -> Result<(), KvmVmError> {
        self.fd()
            .create_irq_chip()
            .map_err(KvmVmError::VmSetIrqChip)?;
        // We need to enable the emulation of a dummy speaker port stub so that writing to port 0x61
        // (i.e. KVM_SPEAKER_BASE_ADDRESS) does not trigger an exit to user space.
        let pit_config = kvm_pit_config {
            flags: KVM_PIT_SPEAKER_DUMMY,
            ..Default::default()
        };
        self.fd()
            .create_pit2(pit_config)
            .map_err(KvmVmError::VmSetIrqChip)
    }
```

コメントが要点を言っている。PC スピーカーのポート `0x61` を KVM 側でダミー処理させるのは、**ユーザースペースへの exit を減らすため**だ。Firecracker はスピーカーをエミュレートしないが、ゲストのカーネルはキャリブレーションなどでこのポートを触りうる。何もしないスタブでもカーネル内にある方が速い。

この ioctl を **vCPU 作成より前に呼ばなければならない**という順序制約がある。これは [irqchip の作成順序](../irqchip-ordering/) で扱う。

vCPU 側では LAPIC の LVT (Local Vector Table) を PC の伝統的な配線に合わせる ([`src/vmm/src/arch/x86_64/interrupts.rs#L49-L66`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/interrupts.rs#L49-L66))。

```rust title="src/vmm/src/arch/x86_64/interrupts.rs"
    let lvt_lint0 = get_klapic_reg(&klapic, APIC_LVT0);
    set_klapic_reg(
        &mut klapic,
        APIC_LVT0,
        set_apic_delivery_mode(lvt_lint0, APIC_MODE_EXTINT),
    );
    let lvt_lint1 = get_klapic_reg(&klapic, APIC_LVT1);
    set_klapic_reg(
        &mut klapic,
        APIC_LVT1,
        set_apic_delivery_mode(lvt_lint1, APIC_MODE_NMI),
    );
```

LINT0 に PIC からの割り込み (ExtINT)、LINT1 に NMI。実機の配線をそのまま再現している。

### GSI を割り当てる

GSI は有限の資源なので、アロケータで管理されている ([`src/vmm/src/vstate/resources.rs#L64-L109`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/resources.rs#L64-L109))。

```rust title="src/vmm/src/vstate/resources.rs"
            gsi_legacy_allocator: IdAllocator::new(arch::GSI_LEGACY_START, arch::GSI_LEGACY_END)
                .unwrap(),
            gsi_msi_allocator: IdAllocator::new(arch::GSI_MSI_START, arch::GSI_MSI_END).unwrap(),
```

範囲の定義は x86_64 のレイアウトにある ([`src/vmm/src/arch/x86_64/layout.rs#L24-L38`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/layout.rs#L24-L38))。

```rust title="src/vmm/src/arch/x86_64/layout.rs"
// Typically, on x86 systems 24 IRQs are used for legacy devices (0-23).
// However, the first 5 are reserved.
// We allocate the remaining GSIs to MSIs.
/// First usable GSI for legacy interrupts (IRQ) on x86_64.
pub const GSI_LEGACY_START: u32 = 5;
/// Last usable GSI for legacy interrupts (IRQ) on x86_64.
pub const GSI_LEGACY_END: u32 = 23;
...
/// The highest available GSI in KVM (KVM_MAX_IRQ_ROUTES=4096).
pub const GSI_MSI_END: u32 = 4095;
```

GSI 0〜4 が予約なのは、PC の伝統でタイマ (0)、キーボード (1)、カスケード (2)、シリアル (3, 4) が固定的に割り当てられているからだ。5〜23 が MMIO デバイス用、24〜4095 が MSI 用になる。上限 4095 は KVM 側の `KVM_MAX_IRQ_ROUTES` に由来する — アロケータの範囲が KVM の実装定数から決まっている、という素直な依存関係が定数のドキュメントに書かれている。

### レガシー割り込みを登録する

GSI と eventfd を結びつけ、同時にルーティングエントリを覚える ([`src/vmm/src/vstate/vm.rs#L640-L671`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L640-L671))。

```rust title="src/vmm/src/vstate/vm.rs"
    pub fn register_irq(&self, fd: &EventFd, gsi: u32) -> Result<(), errno::Error> {
        self.common.fd.register_irqfd(fd, gsi)?;

        let mut entry = kvm_irq_routing_entry {
            gsi,
            type_: KVM_IRQ_ROUTING_IRQCHIP,
            ..Default::default()
        };
        #[cfg(target_arch = "x86_64")]
        {
            entry.u.irqchip.irqchip = KVM_IRQCHIP_IOAPIC;
        }
        ...
        entry.u.irqchip.pin = gsi;
```

`register_irqfd` が `KVM_IRQFD` に対応する。そして GSI 番号をそのまま IOAPIC のピン番号に使っている。`GSI_LEGACY_END = 23` が IOAPIC のピン数と一致しているのはこのためだ。

ルーティングエントリを `self.common.interrupts` (GSI をキーにした `HashMap`) に覚えておいて、`set_gsi_routes` で `KVM_SET_GSI_ROUTING` に全部まとめて渡す ([`src/vmm/src/vstate/vm.rs#L727-L738`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L727-L738))。ルーティングテーブルが全置換 API なので、VMM 側に現在値の写しが要る、という構造そのままだ。マスクされたベクタはテーブルから除かれる。

virtio デバイスを MMIO で繋ぐときは、ここまでのピースが 1 箇所に集まる ([`src/vmm/src/device_manager/mmio.rs#L200-L214`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/mmio.rs#L200-L214))。

```rust title="src/vmm/src/device_manager/mmio.rs"
            for (i, queue_evt) in locked_device.queue_events().iter().enumerate() {
                let io_addr = IoEventAddress::Mmio(
                    device.resources.addr + u64::from(crate::devices::virtio::NOTIFY_REG_OFFSET),
                );
                vm.fd()
                    .register_ioevent(queue_evt, &io_addr, u32::try_from(i).unwrap())
                    .map_err(MmioError::RegisterIoEvent)?;
            }
            vm.register_irq(&mmio_device.interrupt.irq_evt, gsi)
                .map_err(MmioError::RegisterIrqFd)?;
```

上が ioeventfd (ゲスト → ホスト、キュー番号 `i` を書いたら `queue_evt` を signal)、下が irqfd (ホスト → ゲスト)。**双方向とも eventfd で、どちらも `KVM_RUN` から抜けずに済む**。この 2 本の対称性が、次のページで読む virtio の土台になる。

### MSI-X を扱う

MSI 用のベクタは `MsixVector` で表される ([`src/vmm/src/vstate/interrupts.rs#L33-L75`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/interrupts.rs#L33-L75))。

```rust title="src/vmm/src/vstate/interrupts.rs"
/// Type that describes an allocated interrupt
#[derive(Debug)]
pub struct MsixVector {
    /// GSI used for this vector
    pub gsi: u32,
    /// EventFd used for this vector
    pub event_fd: EventFd,
    /// Flag determining whether the vector is enabled
    pub enabled: AtomicBool,
}
```

GSI と eventfd と有効フラグ。`enable` / `disable` がそれぞれ `register_irqfd` / `unregister_irqfd` を呼ぶ。ドライバが MSI-X テーブルエントリをマスクしたら irqfd 登録ごと外す、という素直な対応になっている。

デバイス 1 台分をまとめたのが `MsixVectorGroup` で、割り込みを上げる操作はこれだけだ ([`src/vmm/src/vstate/interrupts.rs#L104-L117`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/interrupts.rs#L104-L117))。

```rust title="src/vmm/src/vstate/interrupts.rs"
    /// Trigger an interrupt for a vector in the group
    pub fn trigger(&self, index: usize) -> Result<(), InterruptError> {
        self.notifier(index)
            .ok_or(InterruptError::InvalidVectorIndex(index))?
            .write(1)?;
        METRICS.interrupts.triggers.inc();
        Ok(())
    }
```

`write(1)` だけ。irqfd の効能がそのまま出ている。

`update_vectors` にはコメント付きの順序制約がある ([`src/vmm/src/vstate/interrupts.rs#L182-L192`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/interrupts.rs#L182-L192))。

```rust title="src/vmm/src/vstate/interrupts.rs"
        // Enables unmasked. Must be done after set_gsi_routes to avoid panic on kernel
        // which does not have commit a80ced6ea514 (KVM: SVM: fix panic on out-of-bounds guest IRQ).
```

ルーティングを設定してから irqfd を有効化しないと、古いホストカーネルではパニックしうる。ホストカーネルの特定コミットの有無に依存する回避策が、コメントとして残されている。

### デバイス側からは 1 つのトレイトに見える

virtio デバイスは、自分の割り込みが IOAPIC 経由のレガシー割り込みなのか MSI-X なのかを知らない。トレイト越しに触るだけだ ([`src/vmm/src/devices/virtio/transport/mod.rs#L16-L48`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/transport/mod.rs#L16-L48))。

```rust title="src/vmm/src/devices/virtio/transport/mod.rs"
/// Represents the types of interrupts used by VirtIO devices
#[derive(Debug, Clone)]
pub enum VirtioInterruptType {
    /// Interrupt for VirtIO configuration changes
    Config,
    /// Interrupts for new events in a queue.
    Queue(u16),
}

/// API of interrupt types used by VirtIO devices
pub trait VirtioInterrupt: std::fmt::Debug + Send + Sync {
    /// Trigger a VirtIO interrupt.
    fn trigger(&self, interrupt_type: VirtioInterruptType) -> Result<(), InterruptError>;
```

デバイスが言えるのは「設定が変わった」か「キュー N に新しいものがある」かの 2 つだけ。それをどう届けるかは実装が決める。

MMIO トランスポートの実装 `IrqTrigger` は、割り込み線が 1 本しかないので**キュー番号を捨てる** ([`src/vmm/src/devices/virtio/transport/mmio.rs#L445-L467`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/transport/mmio.rs#L445-L467))。

```rust title="src/vmm/src/devices/virtio/transport/mmio.rs"
    fn trigger_irq(&self, irq_type: IrqType) -> Result<(), InterruptError> {
        let irq = match irq_type {
            IrqType::Config => VIRTIO_MMIO_INT_CONFIG,
            IrqType::Vring => VIRTIO_MMIO_INT_VRING,
        };
        self.irq_status.fetch_or(irq, Ordering::SeqCst);

        self.irq_evt.write(1).map_err(|err| {
            error!("Failed to send irq to the guest: {:?}", err);
            err
        })?;
```

割り込み線が 1 本しかないということは、ゲスト側は割り込みを受けても**どのキューが動いたのか分からない**ということでもある。だから MMIO トランスポートでは「割り込みステータスレジスタ」(`irq_status`) をアトミックに立てておき、ゲストはそれを MMIO で読んで理由を知る。読むために MMIO exit が 1 回増える。

MSI-X ならベクタごとにキューを分けられるので、このレジスタ読み出しが要らない。トランスポートの差が性能差になるこの話は [MMIO と PCI](../mmio-vs-pci/) で扱う。

`trigger_queues` のデフォルト実装が「重複を含めるな」と呼び出し側に要求しつつ、`IrqTrigger` 側では 1 回にまとめている理由もここにある。複数キューを処理し終えたとき、線が 1 本なら割り込みも 1 回でよい。**割り込みを間引く**というこの発想を、virtio はもっと積極的に使う。次のページの主題だ。
