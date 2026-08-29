---
title: "/dev/kvm の ioctl は 3 階層になっている"
description: "KVM のユーザースペース API は system fd / vm fd / vcpu fd という 3 つのファイルディスクリプタの階層でできていて、階層ごとに使える ioctl が違う。KVM は CPU とメモリの仮想化だけを担当し、デバイスはユーザースペースが演じる。kvm-ioctls クレートがこの階層をそのまま Kvm / VmFd / VcpuFd という型にしていることを、Firecracker のコードで確認する。"
group: "仮想化と KVM をゼロから"
sidebar:
  order: 3
---

## KVM は何を提供して、何を提供しないのか

[前のページ](../hardware-virtualization/)で、VT-x の VMCS や EPT の操作はすべて KVM の中にあると書いた。では KVM は、ユーザースペースに何を見せているのか。

KVM (Kernel-based Virtual Machine) の役割は、実はかなり狭い。

**やること**: VT-x / AMD-V の初期化と VMCS の管理、EPT の構築、VM entry / VM exit のハンドリング（ホストで完結できる exit はカーネル内で処理する）、性能クリティカルな割り込みコントローラ（LAPIC、IOAPIC、PIC、PIT）のエミュレーション、CPUID や MSR のフィルタリング。

**やらないこと**: デバイスのエミュレーション（ディスク、ネットワーク、シリアルポート）、ゲストメモリの確保、カーネルイメージのロード、マシン構成の決定。

つまり **「KVM は CPU とメモリの仮想化だけを担当し、デバイスはユーザースペースが演じる」**。この線引きが KVM の設計の核心だ。Firecracker も QEMU も crosvm も、この線の上に立っている。だから同じ KVM の上で、まったく性格の違う VMM が共存できる。

割り込みコントローラだけが例外的にカーネル側にあるのは性能上の理由だ。割り込みの受け付けや EOI (End Of Interrupt) はゲストが極めて高頻度に叩くので、ユーザースペースでやると VM exit が跳ね上がる。この「in-kernel irqchip」の扱いは [irqchip-ordering](../irqchip-ordering/) で見る。

## 3 階層のファイルディスクリプタ

KVM の API は `/dev/kvm` という 1 つのキャラクタデバイスに対する `ioctl(2)` として提供される。特徴的なのは、**ioctl が 3 階層のファイルディスクリプタに分かれている**ことだ。

```
    open("/dev/kvm", O_RDWR)
              |
              v
    +---------------------+
    |   system fd         |   KVM 全体に関わる操作
    |   (kvm fd)          |   - KVM_GET_API_VERSION
    +---------------------+   - KVM_CHECK_EXTENSION
              |               - KVM_GET_SUPPORTED_CPUID
              | KVM_CREATE_VM  - KVM_CREATE_VM
              v
    +---------------------+
    |   vm fd             |   1 つの VM に関わる操作
    |                     |   - KVM_SET_USER_MEMORY_REGION
    +---------------------+   - KVM_CREATE_IRQCHIP / KVM_SET_TSS_ADDR
              |               - KVM_IRQFD / KVM_IOEVENTFD
              | KVM_CREATE_VCPU  - KVM_GET_DIRTY_LOG
              v               - KVM_CREATE_VCPU
    +---------------------+
    |   vcpu fd           |   1 つの vCPU に関わる操作
    |   (vCPU 数だけ)     |   - KVM_RUN
    +---------------------+   - KVM_GET_REGS / KVM_SET_REGS
                              - KVM_SET_CPUID2
                              - KVM_GET_MSRS / KVM_SET_MSRS
```

なぜこう分かれているのか。

1. **操作の対象が違う。** 「この CPU で KVM が使えるか」はホスト全体の話、「ゲスト物理メモリのここにこのホストメモリを割り当てろ」は VM 単位、「このレジスタに値を入れろ」は vCPU 単位だ。fd を分けることで、対象を引数で指定する必要がなくなる。
2. **ライフサイクルが fd の寿命と一致する。** vcpu fd を閉じれば vCPU が消え、vm fd を閉じれば VM ごと消える。VMM がクラッシュしても、プロセス終了に伴って fd が閉じられ KVM 側の資源が回収される。「掃除し忘れた VM が残る」ことが原理的に起きない。

もう 1 つ、**vcpu fd はスレッドと結びつく**。`KVM_RUN` は、その vcpu fd を作ったスレッドから呼ばなければならない。1 vCPU = 1 ホストスレッドという構造は、この制約から自然に導かれる。

## 1 階層目：Kvm::new

Firecracker で `/dev/kvm` を開いているのはここだ。

```rust title="src/vmm/src/vstate/kvm.rs"
    pub fn new(kvm_cap_modifiers: Vec<KvmCapability>) -> Result<Self, KvmError> {
        let kvm_fd = KvmFd::new().map_err(KvmError::Kvm)?;

        // Check that KVM has the correct version.
        // Safe to cast because this is a constant.
        #[allow(clippy::cast_possible_wrap)]
        if kvm_fd.get_api_version() != KVM_API_VERSION as i32 {
            return Err(KvmError::ApiVersion(kvm_fd.get_api_version()));
        }

        let total_caps = Self::combine_capabilities(&kvm_cap_modifiers);
        // Check that all desired capabilities are supported.
        Self::check_capabilities(&kvm_fd, &total_caps).map_err(KvmError::Capabilities)?;

        Ok(Kvm::init_arch(kvm_fd, kvm_cap_modifiers)?)
    }
```

[`src/vmm/src/vstate/kvm.rs#L28-L44`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/kvm.rs#L28-L44)

`KvmFd::new()` が `open("/dev/kvm")` に相当する。あとの 3 つは、すべて system fd 階層の ioctl だ。

### KVM_GET_API_VERSION

`get_api_version()` は API の互換性チェックのためにある。返り値は歴史的に **12 で固定**されていて、以後変わっていない。KVM は API を壊す変更をしない方針なので、バージョンを上げる必要がなかった。実質的には「この `/dev/kvm` は本当に KVM か」の確認になっている。

エラー定義（[`kvm.rs#L15-L25`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/kvm.rs#L15-L25)）を見ると、`open` 自体の失敗には「Make sure the user launching the firecracker process is configured on the /dev/kvm file's ACL」という文が付いている。実運用で最も多い失敗（権限不足）を先回りしたメッセージだ。

### KVM_CHECK_EXTENSION

API バージョンが固定なら、機能の有無はどう調べるのか。それが **capability** だ。`KVM_CHECK_EXTENSION` に capability 番号を渡すと、サポートしていなければ 0 が返る。Firecracker の `check_capabilities` はリストを順に舐めて、0 が返った時点でその番号を返して失敗する（[`kvm.rs#L65-L73`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/kvm.rs#L65-L73)）。

capability には 2 種類の使い方がある。真偽だけを見るもの（0 か非 0 か）と、返り値そのものが意味を持つもの（`KVM_CAP_NR_MEMSLOTS` ならスロット数の上限、`KVM_CAP_XSAVE2` なら必要なバッファサイズ）だ。Firecracker は両方を使う。

Firecracker が要求する capability は定数として列挙されている。

```rust title="src/vmm/src/arch/x86_64/kvm.rs"
    pub(crate) const DEFAULT_CAPABILITIES: [u32; 14] = [
        kvm_bindings::KVM_CAP_IRQCHIP,
        kvm_bindings::KVM_CAP_IOEVENTFD,
        kvm_bindings::KVM_CAP_IRQFD,
        kvm_bindings::KVM_CAP_USER_MEMORY,
        kvm_bindings::KVM_CAP_SET_TSS_ADDR,
        kvm_bindings::KVM_CAP_PIT2,
        kvm_bindings::KVM_CAP_PIT_STATE2,
        kvm_bindings::KVM_CAP_ADJUST_CLOCK,
        kvm_bindings::KVM_CAP_DEBUGREGS,
        kvm_bindings::KVM_CAP_MP_STATE,
        kvm_bindings::KVM_CAP_VCPU_EVENTS,
        kvm_bindings::KVM_CAP_XCRS,
        kvm_bindings::KVM_CAP_XSAVE,
        kvm_bindings::KVM_CAP_EXT_CPUID,
    ];
```

[`src/vmm/src/arch/x86_64/kvm.rs#L31-L46`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/kvm.rs#L31-L46)

この 14 個は、Firecracker が KVM に何を要求しているかの一覧そのものだ。

| capability                                                  | 何のため                                            |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `KVM_CAP_USER_MEMORY`                                       | `KVM_SET_USER_MEMORY_REGION` を使う。次ページの主題 |
| `KVM_CAP_IRQCHIP`                                           | カーネル内の割り込みコントローラを使う              |
| `KVM_CAP_IRQFD` / `KVM_CAP_IOEVENTFD`                       | eventfd 経由で割り込み注入・デバイス通知を行う      |
| `KVM_CAP_SET_TSS_ADDR`                                      | Intel VMX が要求する TSS 領域を確保する             |
| `KVM_CAP_PIT2` / `PIT_STATE2` / `ADJUST_CLOCK`              | タイマーとクロックの構成・保存復元                  |
| `DEBUGREGS` / `MP_STATE` / `VCPU_EVENTS` / `XCRS` / `XSAVE` | vCPU 状態の保存と復元。スナップショットに必要       |
| `KVM_CAP_EXT_CPUID`                                         | `KVM_GET_SUPPORTED_CPUID` で CPUID を取得する       |

後半のかたまりが全部「vCPU 状態の取得と設定」であることに注目したい。ゲストを走らせるだけなら不要で、[スナップショット](../snapshot-format/)を取るために必要になるものだ。起動時に一括確認することで、「スナップショットを取ろうとしたら実は取れなかった」という失敗を VM 作成前に前倒ししている。

このリストは CPU テンプレートから増減できる（`combine_capabilities`、[`kvm.rs#L46-L63`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/kvm.rs#L46-L63)）。増減の内容はスナップショットの `KvmState` にも保存され、復元先のホストで同じ capability を要求できるようになっている。

### KVM_GET_SUPPORTED_CPUID

`init_arch` は x86_64 でもう 1 つ system fd の ioctl を叩く。`fd.get_supported_cpuid(KVM_MAX_CPUID_ENTRIES)`（[`arch/x86_64/kvm.rs#L48-L64`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/kvm.rs#L48-L64)）だ。

`KVM_GET_SUPPORTED_CPUID` は「このホストの CPU が持つ機能のうち、KVM がゲストに見せられるもの」を返す。ホストの `cpuid` そのままではなく、KVM が仮想化できない機能は落とされている。system fd 階層にあるのは、VM に依存しないホストの能力だからだ。この値をベースに vCPU ごとの見せ方を加工するのが [CPU テンプレート](../cpu-templates/)の仕事になる。

## 2 階層目：KVM_CREATE_VM

system fd に `KVM_CREATE_VM` を投げると vm fd が返る。

```rust title="src/vmm/src/vstate/vm.rs"
        const MAX_ATTEMPTS: u32 = 5;
        let mut attempt = 1;
        let fd = loop {
            match kvm.fd.create_vm() {
                Ok(fd) => break fd,
                Err(e) if e.errno() == libc::EINTR && attempt < MAX_ATTEMPTS => {
                    info!("Attempt #{attempt} of KVM_CREATE_VM returned EINTR");
                    // Exponential backoff (1us, 2us, 4us, and 8us => 15us in total)
                    std::thread::sleep(std::time::Duration::from_micros(2u64.pow(attempt - 1)));
                }
                Err(e) => return Err(VmError::CreateVm(e)),
            }
            attempt += 1;
        };
```

[`src/vmm/src/vstate/vm.rs#L164-L178`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L164-L178)

`kvm.fd.create_vm()` の返り値が `VmFd` になっている。system fd に対する操作から vm fd が生まれる、という階層関係が型に出ている。`EINTR` でリトライしている理由は[専用のページ](../create-vm-eintr/)で扱う。

生成された vm fd は `VmCommon` に格納され、VM 単位のリソースがその周りに集まる。

```rust title="src/vmm/src/vstate/vm.rs"
pub struct VmCommon {
    /// The KVM file descriptor used to access this KvmVm.
    pub fd: VmFd,
    max_memslots: u32,
    /// The guest memory of this KvmVm.
    pub guest_memory: GuestMemoryMmap,
    next_kvm_slot: AtomicU32,
    /// Interrupts used by KvmVm's devices
    pub interrupts: Mutex<HashMap<u32, RoutingEntry>>,
    /// MMIO bus
    pub mmio_bus: Arc<Bus>,
    /// The global KVM state (fd + capabilities).
    pub kvm: Kvm,
```

[`src/vmm/src/vstate/vm.rs#L65-L86`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L65-L86)（一部省略）

`VmCommon` が `Kvm`（system fd を持つ構造体）を丸ごと所有している点に注意したい。VM は自分を作った KVM ハンドルを保持し続ける。`max_memslots` と `next_kvm_slot` は次ページの主題になり、`mmio_bus` は前ページで見た `VcpuExit::MmioRead` の行き先だ。VM 単位の fd と VM 単位のデバイスバスが同じ構造体に同居している。

x86_64 では、vm fd を作った直後にもう 1 つ vm fd 階層の ioctl を叩く。

```rust title="src/vmm/src/arch/x86_64/vm.rs"
            .set_tss_address(u64_to_usize(crate::arch::x86_64::layout::KVM_TSS_ADDRESS))
            .map_err(KvmVmError::SetTssAddress)?;
```

[`src/vmm/src/arch/x86_64/vm.rs#L103-L104`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vm.rs#L103-L104)

`KVM_SET_TSS_ADDR` は、Intel VMX がリアルモードのゲストを扱うために 3 ページ分の物理アドレスを必要とする、という x86 固有の要求に応えるものだ。`DEFAULT_CAPABILITIES` に `KVM_CAP_SET_TSS_ADDR` があった理由がここにある。アドレスは `layout.rs` の定数（`KVM_TSS_ADDRESS = 0xfffb_d000`）で、ゲスト物理アドレス空間のどこに何を置くかを一箇所に集める方針が現れている。この定数群は次ページで詳しく見る。

## 3 階層目：KVM_CREATE_VCPU

vm fd に `KVM_CREATE_VCPU` を投げると vcpu fd が返る。

```rust title="src/vmm/src/arch/x86_64/vcpu.rs"
    pub fn new(index: u8, vm: &KvmVm) -> Result<Self, KvmVcpuError> {
        let kvm_vcpu = vm
            .fd()
            .create_vcpu(index.into())
            .map_err(KvmVcpuError::VcpuFd)?;

        Ok(KvmVcpu {
            index,
            fd: kvm_vcpu,
            peripherals: Default::default(),
            msrs_to_save: vm.msrs_to_save().to_vec(),
            xsave2_size: vm.xsave2_size(),
        })
    }
```

[`src/vmm/src/arch/x86_64/vcpu.rs#L175-L188`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vcpu.rs#L175-L188)

`vm.fd().create_vcpu(index)` で、vm fd から vcpu fd が生まれる。3 階層目に到達した。`index` は 0 始まりの vCPU 番号で、KVM 側ではこれが APIC ID の初期値になる。

`KvmVcpu` は fd に加えて、この vCPU が担当するバス（`peripherals`）と、スナップショット時に保存する MSR のリストを持つ（[`vcpu.rs#L141-L157`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vcpu.rs#L141-L157)）。`msrs_to_save` と `xsave2_size` を vm 側から複製しているのは、元になる ioctl の結果が VM 全体で共通だからだ。vCPU ごとに引き直すのは無駄なので、VM 側で 1 回引いた結果を配る（`xsave2_size` の側には「vCPU 作成のたびに呼ばないようにキャッシュする」というコメントがある）。

## kvm-ioctls：3 階層が型になっている

ここまで見て気づくのは、Firecracker のコードに `ioctl()` の生呼び出しが 1 つも出てこないことだ。すべて `kvm-ioctls` クレート（rust-vmm プロジェクトの一部）のメソッドになっている。

このクレートの設計は単純で、**KVM の 3 階層の fd を、そのまま 3 つの型にしている**。

```
KVM の階層              kvm-ioctls の型      生成方法
-----------------------------------------------------------------
system fd          ->   Kvm                  Kvm::new()
vm fd              ->   VmFd                 kvm.create_vm()
vcpu fd            ->   VcpuFd               vm_fd.create_vcpu(id)
```

そして、**各 fd で使える ioctl が、その型のメソッドとしてしか生えていない**。`Kvm` には `get_api_version` / `check_extension_raw` / `get_supported_cpuid` / `create_vm`、`VmFd` には `set_user_memory_region` / `set_tss_address` / `get_dirty_log` / `create_vcpu`、`VcpuFd` には `run` / `set_cpuid2` / `get_regs` / `set_msrs` がある。だから「vm fd に `KVM_RUN` を投げる」という間違いはコンパイル時に落ちる。KVM の ioctl は数百個あり、どれがどの fd で有効かはカーネルのドキュメント（`Documentation/virt/kvm/api.rst`）を読まないと分からないが、その知識を型システムに写し取ってコンパイラに肩代わりさせている。

Firecracker 側の型もこの階層に対応している。

| Firecracker                           | 中身                                                | KVM の階層 |
| ------------------------------------- | --------------------------------------------------- | ---------- |
| `Kvm` (`arch/x86_64/kvm.rs`)          | `KvmFd` + capability 修飾 + `supported_cpuid`       | system fd  |
| `KvmVm` / `VmCommon` (`vstate/vm.rs`) | `VmFd` + ゲストメモリ + バス + 割り込みルーティング | vm fd      |
| `KvmVcpu` (`arch/x86_64/vcpu.rs`)     | `VcpuFd` + バスへの参照 + MSR リスト                | vcpu fd    |

KVM の階層に、その階層で必要になる Firecracker 側の状態を足したもの、という素直な対応だ。これを頭に入れておくと、以降のコードで「この操作はどの fd に対するものか」が自然に分かる。

なお `kvm-ioctls` のうち `set_user_memory_region` だけは `unsafe` になっている。ホストの仮想アドレスを KVM に渡すので、そのアドレスが有効なマッピングを指していることをコンパイラが保証できないからだ。この扱いは次ページで見る。

次のページ（[ゲスト物理メモリは、ホストプロセスの mmap にすぎない](../guest-memory/)）では、vm fd 階層の中心的な ioctl である `KVM_SET_USER_MEMORY_REGION` を見る。
