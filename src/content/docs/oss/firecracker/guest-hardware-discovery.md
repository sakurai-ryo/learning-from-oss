---
title: "e820・MPTable・ACPI — ゲストにデバイスの在り処を教える"
description: "Firecracker には BIOS も UEFI もないので、ゲストカーネルが読む「ファームウェアが用意したはずのテーブル」を VMM が全部でっち上げる。e820 メモリマップ、Intel MP Spec の MPTable、自前クレートで組み立てて 0x9fc00 以降に書く ACPI テーブル群という 3 系統と、virtio-mmio がコマンドラインと ACPI に二重登録されている理由を読む。"
group: "起動を速くする"
sidebar:
  order: 25
---

## 何を学んだか

物理マシンでは、カーネルが起動した時点で「メモリがどこまであるか」「割り込みコントローラがどのアドレスにいるか」は、すでにファームウェア（BIOS / UEFI）が調べてテーブルに書いてくれている。カーネルは決められた場所を読むだけでいい。

Firecracker にはファームウェアがない。カーネルは VMM がロードした直後の状態からいきなり走り出す。それでもゲストカーネルは、生まれつき知っている場所を読みに行く。だから **Firecracker が、ファームウェアが書いたはずのテーブルを自分で捏造する**。x86_64 では 3 系統ある。

| 経路              | 何を伝えるか                                                                 | 置き場所                                                   | 状態               |
| ----------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------ |
| e820 / PVH memmap | 物理メモリのどこが RAM でどこが予約領域か                                    | zero page 内 (0x7000) または 0x7000 の配列                 | 必須               |
| MPTable           | vCPU 数、Local APIC / IO-APIC のアドレス、IRQ 配線                           | 0x9fc00 以降（アロケータが決める）                         | 非推奨だが常に書く |
| ACPI テーブル     | 上記すべて＋デバイス（COM1、i8042、virtio、VMGenID、GED）＋ PCIe ECAM の位置 | 0x9fc00 以降（アロケータが決める）、RSDP だけ 0xe0000 固定 | 推奨               |

さらに virtio-mmio デバイスに限っては **4 番目の経路**がある。カーネルコマンドラインだ。Firecracker はデバイスごとに `virtio_mmio.device=4K@0xc0001000:5` のような文字列を追加し、かつ同じデバイスを ACPI の DSDT にも AML として書く。**同じ情報を 2 箇所に書いている。**

### メモリの下 1MB がテーブル置き場になっている

x86 の「最初の 1MB」は、実機では BIOS とその作業領域が占めている歴史的な領域だ。Firecracker はここをまるごと自分の作業領域として使う。

```
0x00000000 ┌───────────────────────────────────────┐
           │ GDT(0x500) / IDT(0x520)               │
           │ hvm_start_info(0x6000) modlist(0x6040)│ PVH
           │ memmap 配列 / zero page (0x7000) 排他  │ ← E820_RAM
           │ boot stack(0x8ff0) PML4/PDPTE/PDE     │ LinuxBoot
0x00020000 │ kernel cmdline                        │
0x0009fc00 ├───────────────────────────────────────┤ SYSTEM_MEM_START
           │ MPTable / DSDT / FADT / MADT /        │ ← E820_RESERVED
           │ MCFG / XSDT（257KiB のアロケータ管理） │
0x000e0000 ├───────────────────────────────────────┤ RSDP_ADDR
           │ RSDP                                  │ ← e820 の穴
0x00100000 ├───────────────────────────────────────┤ HIMEM_START
           │ カーネル本体 + ゲスト DRAM            │ ← E820_RAM
           ⋮                                       ⋮
0xc0000000 ├───────────────────────────────────────┤ MMIO32_MEM_START
           │ virtio-mmio デバイス / PCI BAR        │
0xeec00000 ├───────────────────────────────────────┤ PCI_MMCONFIG_START
           │ PCIe ECAM 256MiB                      │ ← E820_RESERVED
0xfec00000 │ IO-APIC       0xfee00000 Local APIC   │
```

e820 に載るのは 3 つの固定エントリ（0〜0x9fc00 が RAM、0x9fc00〜0xe0000 が予約、PCIe ECAM が予約）と、DRAM 領域ごとの RAM エントリだけである。RSDP を置く 0xe0000 から 1MB までは **どのエントリにも現れない**。e820 に現れないアドレスを Linux は RAM として扱わないので、結果として保護される。

### ハードウェアがないのに自己申告テーブルがある

ACPI の DSDT に書き込まれる AML には、実在しないハードウェアの記述が混ざる。i8042（PS/2 キーボードコントローラ）のエントリがそうだ（[`src/vmm/src/device_manager/legacy.rs#L134-L135`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/legacy.rs#L134-L135)）。

```rust title="src/vmm/src/device_manager/legacy.rs"
                        // Fake a command port so Linux stops complaining
                        &aml::Io::new(0x0064, 0x0064, 1u8, 1u8),
```

Firecracker の i8042 は `SendCtrlAltDel` でゲストを落とすための最小限のリセット機能しか持たない。コマンドポート 0x64 は「Linux が文句を言わなくなるように」テーブルに載せてあるだけだ。ACPI テーブルはハードウェアの自己申告ではなく、**VMM がゲストカーネルに向けて書く作文**である。

## ソースコードのどこか

### (1) e820 — Linux boot protocol の場合

[`src/vmm/src/arch/x86_64/mod.rs#L434-L463`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L434-L463)。3 つの固定エントリを置いてから、ゲストメモリの DRAM リージョンを走査する。

```rust title="src/vmm/src/arch/x86_64/mod.rs"
    // We mark first [0x0, SYSTEM_MEM_START) region as usable RAM and the subsequent
    // [SYSTEM_MEM_START, (SYSTEM_MEM_START + SYSTEM_MEM_SIZE)) as reserved (note
    // SYSTEM_MEM_SIZE + SYSTEM_MEM_SIZE == HIMEM_START).
    add_e820_entry(&mut params, 0, layout::SYSTEM_MEM_START, E820_RAM)?;
    // ...SYSTEM_MEM 領域と PCI_MMCONFIG 領域を E820_RESERVED で追加...

    for region in guest_mem
        .iter()
        .filter(|region| region.region_type == GuestRegionType::Dram)
    {
        // the first 1MB is reserved for the kernel
        let addr = max(himem_start, region.start_addr());
```

PCIe ECAM の 256MiB は、PCI を使っていなくても常に予約される。`region_type == Dram` のフィルタは、virtio-mem でホットプラグ用に確保した領域を RAM として申告しないためだ。`add_e820_entry`（[同ファイル#L472-L490](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L472-L490)）は `boot_params.e820_table` が固定長配列なので、要素数を超えたらエラーにする。

PVH の場合は同じ 3 エントリ＋ DRAM 走査を `hvm_memmap_table_entry` の `Vec` として作り、0x7000 に書く（[同ファイル#L325-L361](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L325-L361)）。RAM には別途定義した `MEMMAP_TYPE_RAM = 1` を使うが、予約領域には `E820_RESERVED` をそのまま渡している。PVH の型番号と e820 の型番号が一致していることに依存した書き方になっている。

### (2) MPTable — 常に書かれる

[`src/vmm/src/arch/x86_64/mod.rs#L271-L277`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L271-L277)。`setup_mptable` の呼び出しはブートプロトコルの分岐より **前**にあり、PVH でも Linux boot でも無条件に走る。直前のコメントは `// Note that this puts the mptable at the last 1k of Linux's 640k base RAM`。

中身は Intel MP Spec 1.4 のバイト列を素手で組み立てる作業だ（[`src/vmm/src/arch/x86_64/mptable.rs#L115-L280`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mptable.rs#L115-L280)）。フローティングポインタ（`_MP_` シグネチャ）、テーブルヘッダ（`PCMP`）、vCPU ごとの `mpc_cpu`、ISA バス 1 本、IO-APIC 1 個、GSI 0〜23 の割り込みソース、Local 割り込み 2 本。OEM 名は `"FC      "` で、チェックサムも自分で計算する。割り込みソースのループには `// Per kvm_setup_default_irq_routing() in kernel` というコメントがあり、KVM 側の既定の配線に合わせていることが明示されている。

### (3) ACPI — 自前のクレートで組み立てる

[`src/vmm/src/acpi/mod.rs#L187-L201`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/acpi/mod.rs#L187-L201)。依存の順にテーブルを作り、それぞれのアドレスを親テーブルに埋めていく。

```rust title="src/vmm/src/acpi/mod.rs"
    let mut writer = AcpiTableWriter { mem };
    let dsdt_addr = writer.build_dsdt(device_manager, resource_allocator)?;

    let fadt_addr = writer.build_fadt(resource_allocator, dsdt_addr)?;
    let madt_addr = writer.build_madt(resource_allocator, vcpus.len().try_into().unwrap())?;
    let mcfg_addr = writer.build_mcfg(resource_allocator, layout::PCI_MMCONFIG_START)?;
    let xsdt_addr = writer.build_xsdt(resource_allocator, fadt_addr, madt_addr, mcfg_addr)?;
    writer.build_rsdp(xsdt_addr)
```

DSDT → FADT（DSDT を指す）→ MADT → MCFG → XSDT（前 3 者を指す）→ RSDP（XSDT を指す）という一本道になる。RSDP だけはアロケータを通さず 0xe0000 固定に書く。ゲストカーネルが決め打ちで探しに来る場所だからだ。

テーブルの実体は `src/acpi-tables/` に自前で置いてある。`rsdp.rs` / `xsdt.rs` / `fadt.rs` / `madt.rs` / `mcfg.rs` / `dsdt.rs` と、AML バイトコードを生成する 58KB の `aml.rs`。RSDP は `#[repr(C, packed)]` の構造体をそのままバイト列にし、チェックサムを 2 つ計算して書くだけだ（[`src/acpi-tables/src/rsdp.rs#L38-L56`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/acpi-tables/src/rsdp.rs#L38-L56)）。

「自分がハードウェアのメーカーである」という申告も自前でやる。`OEM_ID = "FIRECK"` には「OEM は ACPI がハードウェアの製造者を名指す方法であり、全テーブルに渡して OS にテーブルの持ち主を知らせる」というコメントが付く。FADT には `HYPERVISOR_VENDOR_ID = "FIRECKVM"` を入れ、`FADT_F_HW_REDUCED_ACPI` と「VGA ハードウェアは無い」フラグを立てる（[`src/vmm/src/acpi/x86_64.rs#L27-L34`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/acpi/x86_64.rs#L27-L34)）。

**MCFG は PCI が無効でも常に書かれる。** `create_acpi_tables` に条件分岐はなく、`layout::PCI_MMCONFIG_START` を無条件に渡している。

### (4) virtio-mmio はコマンドラインにも書く

デバイスを 1 個登録するたびに、x86_64 では 2 つのことを両方やる（[`src/vmm/src/device_manager/mmio.rs#L254-L282`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/mmio.rs#L254-L282)）。

```rust title="src/vmm/src/device_manager/mmio.rs"
        #[cfg(target_arch = "x86_64")]
        {
            Self::add_virtio_device_to_cmdline(_cmdline, &device.resources)?;
            add_virtio_aml(
                &mut self.dsdt_data,
                device.resources.addr,
                device.resources.len,
                device.resources.gsi.unwrap(),
            )?;
        }
```

コマンドライン側は `virtio_mmio.device=<size>@<baseaddr>:<irq>` を並べる。ビルダーのテストに実際の文字列 `virtio_mmio.device=4K@0xc0001000:5 virtio_mmio.device=4K@0xc0002000:6 ...` が出てくる（[`src/vmm/src/builder.rs#L1236-L1242`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L1236-L1242)）。ACPI 側は `_HID` に `LNRO0005`（Linux の virtio-mmio 用 HID）を持つデバイスを DSDT に生やす（[同ファイル#L77-L109](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/mmio.rs#L77-L109)）。アドレス範囲は 4KiB 固定（`MMIO_LEN = 0x1000`）、割り込みは legacy GSI を 1 本。

`MMIOVirtioDevices::dsdt_data` には、AML をデバイス構築順に積む理由がコメントされている。「ルートブロックデバイスが DSDT の先頭に来るようにするため。そうしないとゲストでルートデバイスが `/dev/vda` にならない」。**DSDT に書く順序が、ゲストのデバイス名を決めている。** バスを走査して後から集めると順序が保証できないので、構築時に順番どおり `Vec<u8>` に積む設計になっている。

## なぜそうなっているか

ACPI が入ったのは 1.8.0 で、CHANGELOG に動機がそのまま書かれている。

> [#4428](https://github.com/firecracker-microvm/firecracker/pull/4428): Added ACPI support to Firecracker for x86_64 microVMs. Currently, we pass ACPI tables with information about the available vCPUs, interrupt controllers, VirtIO and legacy x86 devices to the guest. **This allows booting kernels without MPTable support.**

同じリリースの Deprecated セクションで、MPTable 経路の終わりが宣言されている。

> Booting with microVM kernels that rely on MPTable on x86_64 is deprecated and support will be removed in v2.0 or later. We suggest to users of Firecracker to use guest kernels with ACPI support. For x86_64 microVMs, ACPI will be the only way Firecracker passes hardware information to the guest once MPTable support is removed.

つまり **3 系統あるのは移行期だから**であって、設計の理想ではない。`docs/kernel-policy.md` はゲスト側で `CONFIG_X86_MPPARSE=n` と `CONFIG_VIRTIO_MMIO_CMDLINE_DEVICES=n` にすることを推奨したうえで、移行期間中の約束を明示している。

> During the deprecation period Firecracker will continue to support the legacy way of booting a microVM. Firecracker will be able to boot kernels with the following configurations:
>
> - Only ACPI
> - Only legacy mechanisms
> - Both ACPI and legacy mechanisms

3 つの組み合わせすべてを起動させると決めた以上、VMM 側は **常に両方書く** しかない。片方だけ書くには「ゲストカーネルが何を持っているか」を VMM が知る必要があるが、Firecracker はカーネル画像の Kconfig を読まない。MPTable のコストは vCPU 32 個で 1KB 程度なので、無条件に書くほうが安い。

ACPI が PCI と一緒に語られる理由も、同じドキュメントに書かれている。

> **NOTE**: Firecracker does not support PCI devices. The `CONFIG_PCI` option is needed for ACPI initialization inside the guest.

ACPI が入った 1.8.0 の時点で Firecracker に PCI デバイスは 1 つも無かった。にもかかわらずゲストに `CONFIG_PCI=y` を要求したのは、**Linux の ACPI 初期化コードが PCI サブシステムに依存しているから**である。MCFG を無条件に書き、e820 で ECAM 領域を予約しているのも、「ACPI を名乗る以上、PCIe の設定空間がどこにあるかは答えられなければならない」という筋によるものだと読める（PCI トランスポート自体が入ったのは 5 リリース後の 1.13.0 だ）。

テーブル置き場のサイズ見積もりは [`src/vmm/src/arch/x86_64/layout.rs#L66-L92`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/layout.rs#L66-L92) にバイト単位で残っている。FADT 276、XSDT 52、MADT 2104、DSDT 1907、MPTable 5304 バイト（いずれも 256 vCPU 想定）。合計 8KB ほどに対して 257KiB を確保し、「将来の ACPI 機能のために余裕を取る」と明記されている。固定アドレスのレイアウトは後から広げにくいので、最初に広く取る判断になっている。

## どう活かすか

**「相手が読みに来る場所に、相手が期待する形で置く」という統合方式**が徹底されている。ゲストカーネルは Firecracker のことを何も知らない。API もハンドシェイクも無く、あるのは「メモリのこの番地にこの形式のバイト列がある」という 40 年分の約束だけだ。書き換えられない既存ソフトと統合するなら、相手に新しいプロトコルを喋らせるより、相手がすでに読む場所に自分が書き込むほうが速い。

**複数の互換経路を並行して維持するなら、期限と条件を先に宣言する。** Firecracker は「MPTable 経路は v2.0 以降で削除する」「その間は 3 通りすべてで起動する」と CHANGELOG とドキュメントに書いた。この宣言があるから、`setup_mptable` が無条件で残っていても「消し忘れ」ではなく「約束の履行」として読める。期限を宣言せずに互換経路を足すと、恒久的な負債になる。

**冪等に書けるテーブルは、条件分岐せずに全部書く。** Firecracker は MCFG を PCI 無効時も書き、同じデバイス情報をコマンドラインと ACPI に二重に書く。判断材料を持っていないので分岐しようがない。コストが十分小さいなら、相手の状態を推測して出し分けるより、全部出して相手に選ばせるほうが壊れにくい。ただし前提は **余分に書いた情報が無害であること**だ。ACPI と MPTable が矛盾したらゲストは壊れるので、両方が同じ IO-APIC アドレス・同じ GSI を指すよう `layout.rs` の定数を共有している。二重帳簿を許すなら、帳簿の元データは 1 つにする。

取り込むべきでない条件もある。**レガシー経路の維持は「テストできる範囲」でしか約束できない。** 3 通りの起動をサポートすると宣言するなら、3 通りぶんのゲストカーネルを CI で回せる必要がある。Firecracker は公式サポートするゲストカーネルのバージョンを絞ったうえで（`docs/kernel-policy.md`）、その範囲でだけ約束している。また **固定アドレスのレイアウトは変更コストが極端に高い**。0x9fc00 も 0xe0000 もスナップショット互換性やゲストの期待と結びついていて「後で動かせばいい」が効かない。可変長のプロトコルを設計できるならそちらを選ぶべきで、固定レイアウトを真似する理由は「相手が固定を要求している」場合に限られる。
