---
title: "bzImage をやめて、ELF と PVH で直接起動する"
description: "Firecracker の load_kernel は ELF (vmlinux) を第一候補として読み、マジックナンバーが違うときだけ bzImage ローダーにフォールバックする。ELF に Xen 由来の PVH ELF Note があれば、ページテーブルもロングモードも用意せず、32 ビット保護モードのまま rbx に構造体アドレスを入れてカーネルへ飛ぶ。Xen のために作られた ABI を KVM の VMM が転用している構図を読む。"
group: "起動を速くする"
sidebar:
  order: 24
---

## 何を学んだか

Firecracker がゲストカーネルを読み込むとき、選択肢は 2 軸ある。

- **イメージ形式**: ELF (`vmlinux`) か bzImage か
- **ブートプロトコル**: Linux 64-bit boot protocol か PVH boot protocol か

そして Firecracker の優先順位は、一般的なブートローダーの常識とは逆になっている。**ELF が第一候補で、bzImage はフォールバック**である。長らく Firecracker は `vmlinux` しか受け付けず、bzImage 対応は最近足されたもので、CHANGELOG の Unreleased セクションに「既存の非圧縮 ELF (`vmlinux`) イメージに加えて bzImage をサポートした」と書かれている（[#6037](https://github.com/firecracker-microvm/firecracker/pull/6037)）。

### ELF なら PVH エントリを探す

ELF としてロードできたら、次に「PVH で入れるか」を見る。linux-loader クレートの ELF ローダーは ELF Note セクションに `XEN_ELFNOTE_PHYS32_ENTRY` があるかを調べ、あれば `PvhBootCapability::PvhEntryPresent(addr)` を返す。

```
kernel_file
   │
   ├─ ElfLoader::load 成功
   │     ├─ PvhEntryPresent(addr) → BootProtocol::PvhBoot,   entry = addr
   │     └─ なし                   → BootProtocol::LinuxBoot, entry = kernel_load
   │
   └─ InvalidElfMagicNumber
         └─ BzImageLoader::load → BootProtocol::LinuxBoot, entry = kernel_load + 0x200
                                  （setup_header を持ち帰って zero page の種にする）
```

bzImage の場合だけ `setup_header` が `Some` になり、後段の `configure_64bit_boot` がそれを zero page の種として使う。ELF の場合は `None` なので、ゼロ埋めのヘッダから組み立てる。

### PVH が省いているもの

PVH（Xen の "PVH direct boot" ABI）は、「ハイパーバイザがカーネルを直接メモリに置いて実行を始める」状況のために設計されている。従来の x86 起動シーケンス——リアルモードで始まり、BIOS 相当の初期化を経て、setup コード（bzImage の実モードコード）を走らせ、保護モード・ロングモードへ上がっていく——を丸ごと前提から外している。

ただし Firecracker は Linux boot protocol でも 64 ビットエントリに直接飛ぶので、リアルモードと setup コードの実行はすでに省かれている。PVH で変わるのは **VMM がゲストに用意してやる初期状態の量**のほうだ。

| VMM がやること | LinuxBoot                                                  | PvhBoot                                                   |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| CPU モード     | ロングモード（`EFER.LME\|LMA`、`CR0.PE`）                  | 32 ビット保護モード（`CR0 = PE\|ET`、`CR4 = 0`）          |
| ページテーブル | PML4 / PDPTE / PDE を書く（2MB ページ 512 エントリ）       | **書かない**（ページング無効のまま入る）                  |
| GDT            | 64 ビットコードセグメント（`0xa09b`）                      | 4GB フラットな 32 ビットセグメント（`0xc09b` / `0xc093`） |
| 情報の渡し方   | zero page (`boot_params`) を 0x7000 に置き、`rsi` に入れる | `hvm_start_info` を 0x6000 に置き、`rbx` に入れる         |
| メモリマップ   | `boot_params.e820_table`                                   | `hvm_memmap_table_entry` の配列を 0x7000 に置く           |
| initrd         | `hdr.ramdisk_image` / `ramdisk_size`                       | `hvm_modlist_entry` の配列を 0x6040 に置く                |

`MEMMAP_START` と `ZERO_PAGE_START` はどちらも 0x7000 である。どちらか一方しか使われないことが、レイアウト定数のレベルで前提になっている。

起動時間に効くのは主に 2 点。

1. **非圧縮 ELF を直接ロードする**ので、ゲスト内でカーネルの自己展開が走らない（PVH かどうかとは独立で、ELF を選ぶこと自体の効果）。
2. **VMM がページテーブルを組まない**。`setup_page_tables` はゲストメモリへ 512 回書き込む。PVH ではこれが丸ごとスキップされ、ページングはカーネルが自分で有効化する。

## ソースコードのどこか

### load_kernel — ELF を先に試す

[`src/vmm/src/arch/x86_64/mod.rs#L496-L566`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L496-L566)。まず ELF を試し、失敗のうち `InvalidElfMagicNumber` だけを bzImage へのフォールバックとして扱う。それ以外のエラー（ELF ではあるが壊れている等）はそのまま失敗させる。

```rust title="src/vmm/src/arch/x86_64/mod.rs"
    // Try to load the image as an ELF (vmlinux); if it has no ELF magic,
    // we try to load it as a bzImage.
    match ElfLoader::load(guest_memory, None, &mut kernel_file, highmem_start) {
        Ok(elf_result) => {
            let mut entry_point_addr: GuestAddress = elf_result.kernel_load;
            let mut boot_prot: BootProtocol = BootProtocol::LinuxBoot;
            if let PvhBootCapability::PvhEntryPresent(pvh_entry_addr) = elf_result.pvh_boot_cap {
                // Use the PVH kernel entry point to boot the guest
                entry_point_addr = pvh_entry_addr;
                boot_prot = BootProtocol::PvhBoot;
            }
```

bzImage 側は、64 ビットエントリを持っていることを明示的に要求する。

```rust title="src/vmm/src/arch/x86_64/mod.rs"
            // We jump to the 64-bit entry point, which only exists when the
            // image advertises it via XLF_KERNEL_64 (boot protocol >= 2.12).
            if hdr.version < 0x020c || hdr.xloadflags & XLF_KERNEL_64 == 0 {
                return Err(ConfigurationError::BzImageMissing64BitEntry);
            }
```

エントリは `kernel_load + BZIMAGE_64BIT_ENTRY_OFFSET`（0x200）になる。**bzImage を受け入れても、実モードの setup コードは実行しない。**

選ばれたプロトコルは [`src/vmm/src/arch/mod.rs#L84-L117`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/mod.rs#L84-L117) の `EntryPoint` に載って、レジスタ設定とシステム設定の両方に伝わる。

### configure_pvh — hvm_start_info を組み立てる

[`src/vmm/src/arch/x86_64/mod.rs#L305-L395`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L305-L395)。

組み立てるのは 3 つ。`hvm_modlist_entry`（initrd を「モジュール」として記述）、`hvm_memmap_table_entry`（メモリマップ）、`hvm_start_info`（前 2 者を指す親構造体）。

```rust title="src/vmm/src/arch/x86_64/mod.rs"
    // Construct the hvm_start_info structure and serialize it into
    // boot_params.  This will be stored at PVH_INFO_START address, and %rbx
    // will be initialized to contain PVH_INFO_START prior to starting the
    // guest, as required by the PVH ABI.
    #[allow(clippy::cast_possible_truncation)] // the vec lengths are single digit integers
    let mut start_info = hvm_start_info {
        magic: XEN_HVM_START_MAGIC_VALUE,
        version: 1,
        cmdline_paddr: cmdline_addr.raw_value(),
        memmap_paddr: layout::MEMMAP_START,
        memmap_entries: memmap.len() as u32,
        nr_modules: modules.len() as u32,
        ..Default::default()
    };
```

マジック値の名前が `XEN_HVM_START_MAGIC_VALUE` であることに注意したい。KVM のゲストに渡す構造体の識別子が Xen のものそのままである。

埋めているのはこの 6 フィールド（＋モジュールがあれば `modlist_paddr`）だけで、残りは `Default::default()` のゼロ埋めになる。カーネルコマンドラインの置き場所 `CMDLINE_START = 0x20000` は Linux boot protocol と共通で、`load_cmdline` は [`configure_system_for_boot`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L257-L292) の中でプロトコル分岐より前に呼ばれる。違うのは「そのアドレスをどの構造体のどのフィールドで教えるか」だけだ。

アドレスは [`src/vmm/src/arch/x86_64/layout.rs#L43-L55`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/layout.rs#L43-L55) に固定値で並んでおり、排他性がコメントで明示されている。

```rust title="src/vmm/src/arch/x86_64/layout.rs"
pub const PVH_INFO_START: u64 = 0x6000;
pub const MODLIST_START: u64 = 0x6040;

/// Address of memory map table used in PVH boot. Can overlap
/// with the zero page address since they are mutually exclusive.
pub const MEMMAP_START: u64 = 0x7000;

/// The 'zero page', a.k.a linux kernel bootparams.
pub const ZERO_PAGE_START: u64 = 0x7000;
```

### レジスタ — rbx にアドレスを入れる

[`src/vmm/src/arch/x86_64/regs.rs#L86-L113`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/regs.rs#L86-L113)。プロトコルごとに丸ごと違う `kvm_regs` を作る。

```rust title="src/vmm/src/arch/x86_64/regs.rs"
    let regs: kvm_regs = match entry_point.protocol {
        BootProtocol::PvhBoot => kvm_regs {
            // Configure regs as required by PVH boot protocol.
            rflags: 0x0000_0000_0000_0002u64,
            rbx: super::layout::PVH_INFO_START,
            rip: entry_point.entry_addr.raw_value(),
            ..Default::default()
        },
```

PVH ではスタックポインタすら設定していない（`rsp` / `rbp` は `Default` の 0）。LinuxBoot 側は `BOOT_STACK_POINTER = 0x8ff0` と、`rsi` に zero page のアドレスを入れる。

制御レジスタの違いは [`regs.rs#L196-L256`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/regs.rs#L196-L256) にある。

```rust title="src/vmm/src/arch/x86_64/regs.rs"
    match boot_prot {
        BootProtocol::PvhBoot => {
            sregs.cr0 = X86_CR0_PE | X86_CR0_ET;
            sregs.cr4 = 0;
        }
        BootProtocol::LinuxBoot => {
            // 64-bit protected mode
            sregs.cr0 |= X86_CR0_PE;
            sregs.efer |= EFER_LME | EFER_LMA;
        }
    }
```

そして [`setup_sregs`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/regs.rs#L143-L161) が、ページテーブルの構築を LinuxBoot のときだけに限定している。

```rust title="src/vmm/src/arch/x86_64/regs.rs"
    configure_segments_and_sregs(mem, &mut sregs, boot_prot)
        .map_err(SetupSpecialRegistersError::ConfigureSegmentsAndSpecialRegisters)?;
    if let BootProtocol::LinuxBoot = boot_prot {
        setup_page_tables(mem, &mut sregs).map_err(SetupSpecialRegistersError::SetupPageTables)?;
        // TODO(dgreid) - Can this be done once per system instead?
    }
```

`TODO(dgreid)` は crosvm 由来のコメントで、「ページテーブルの構築は vCPU ごとではなくシステムに 1 回でいいのでは」と言っている。PVH ではこの疑問自体が発生しない。

## なぜそうなっているか

`docs/pvh.md` にこの機能の位置づけが書かれている。

> Firecracker supports booting x86 kernels in "PVH direct boot" mode as specified by the Xen project. If a kernel is provided which contains the XEN_ELFNOTE_PHYS32_ENTRY ELF Note then this boot mode will be used. This boot mode was designed for virtualized environments which load the kernel directly, and is simpler than the "Linux boot" mode which is designed to be launched from a legacy boot loader.

Firecracker 自身の説明は「レガシーなブートローダーから起動されることを前提にした Linux boot mode より単純だから」であって、「速いから」ではない。ドキュメントにもコードコメントにも、PVH で何ミリ秒縮んだという記述はない。

同じドキュメントに、有効化条件と副次的な動機が書かれている。

> PVH boot mode can be enabled for Linux by setting `CONFIG_PVH=y` in the kernel configuration. (This is not the default setting.)
>
> PVH boot mode is enabled by default in FreeBSD, which has support for Firecracker starting with FreeBSD 14.0.

Linux では PVH はデフォルト無効なので、多くの利用者にとって Firecracker は今も Linux boot protocol で起動している。一方 **FreeBSD は PVH がデフォルト**で、Firecracker が FreeBSD ゲストを起動できるのは PVH 対応があるからだ。CHANGELOG 1.12.0 も「Linux kernels newer than 5.0 compiled with `CONFIG_PVH=y` set this ELF Note, as do FreeBSD kernels」と書いている（[#5048](https://github.com/firecracker-microvm/firecracker/pull/5048)）。

つまり PVH 採用の主要な動機は、起動時間の短縮というより **「Linux 以外のゲストも同じコードパスで起動できる」ポータビリティ**だと読める。Linux boot protocol は名前のとおり Linux 固有の ABI で、FreeBSD カーネルがそれに合わせる理由はない。PVH は「準仮想化されたゲストを直接ロードする」ための中立な ABI として先に存在していたので、両者がそこで会える。

Xen 由来の仕様を KVM の VMM が転用できているのは、持ち込むものが **構造体の形とレジスタの約束事だけ**だからだ。Firecracker は Xen のコードを 1 行も取り込んでいない。`hvm_start_info` などの定義は linux-loader クレート（rust-vmm）のものを使い、Firecracker 側は 90 行ほどの `configure_pvh` と `match` の片側を書くだけで済んでいる。

ELF を第一候補にしている理由はコードから直接は読めないが、歴史的順序ははっきりしている。`vmlinux` 専用として出発し、bzImage は後から足された。`load_kernel` の `match` の形は、その順序をそのまま写している。推測だが、非圧縮 ELF ならゲスト内の自己展開が不要になるという起動時間上の理由が、当初 `vmlinux` に絞った動機だろう。

## どう活かすか

**複数の入力形式を受け付けるなら、検出順序をコストの安い順にする。** ELF と bzImage はどちらもカーネル画像だが、前者は VMM がロードを完結でき、後者はゲスト内に展開処理を持ち込む。Firecracker は速いほうを第一候補にし、遅いほうをフォールバックに置いた。`match` の第一分岐が何かは、そのまま実装者の意図の表明になる。

**自前のプロトコルを定義する前に、中立な既存 ABI を探す。** Firecracker は VMM もゲストカーネルも自分で選べる立場にあり、独自のブートプロトコルを定義できた。それでも Xen の PVH を採ったのは、他人（FreeBSD）がすでにその ABI を実装していたからだ。ABI を自分で定義すると、それを喋る相手を自分で説得しなければならなくなる。

一方、**取り込むべきでない条件**もある。

- **既定で有効でない機能に賭けない。** Linux の `CONFIG_PVH` はデフォルト無効だ。Firecracker は PVH を「あれば使う」検出ベースの分岐にとどめ、Linux boot protocol のコードを一切削っていない。既存経路を残せないなら、この種の最適化は運用上の負債になる。
- **2 つの初期状態を維持するコストを見積もる。** `setup_regs` / `configure_segments_and_sregs` / `setup_sregs` / `configure_system_for_boot` の 4 箇所すべてに `match` が入る。片方だけ直すと「そのカーネルだけ起動しない」という再現性の低い障害になるので、Firecracker は両プロトコルの GDT と制御レジスタをテストで個別に検証している（[`regs.rs#L299-L320`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/regs.rs#L299-L320)）。分岐を増やすなら、分岐の数だけアサーションを増やすところまでがセットになる。
- **省略できるのは「相手が自分でやり直す」ものだけ。** PVH でページテーブルを組まないのは、カーネルが自分で組むからだ。準備を削る最適化では「削った仕事を誰がやるか」に答えられるかが判断基準になる。答えが「誰もやらない」なら、それは最適化ではなく壊れている。
