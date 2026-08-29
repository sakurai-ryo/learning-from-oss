---
title: "PCI を長年持たなかった VMM が、それを持つと決めるまで"
description: "Firecracker は virtio のトランスポートを MMIO 1 本に絞り、ゲストのカーネルコマンドラインに pci=off を入れて PCI バスそのものを消していた。v1.13.0 でその決定が覆り、pci_enabled フラグ 1 つで VirtioDevices::Mmio と VirtioDevices::Pci を切り替える形になる。捨てた複雑さ（約 980 行 対 約 4,360 行）と、それでも戻すことにした 3 つの理由を読む。"
group: "起動を速くする"
sidebar:
  order: 26
---

## 何を学んだか

Firecracker は初期から v1.12.0 まで、**PCI バスを持たない x86 マシン**をゲストに見せていた。virtio デバイスは全部 MMIO トランスポートで、固定アドレスの 4KiB レジスタ領域と GSI 1 本だけを使う。そのうえでカーネルコマンドラインに `pci=off` を入れ、ゲストカーネルに PCI の探索そのものをやめさせていた。

v1.13.0 で PCI トランスポートが入った。ただし置き換えではなく、**起動時のフラグ 1 つによる二者択一**である。

```
firecracker --enable-pci
   │
   └→ vm_resources.pci_enabled = true
         │
         └→ DeviceManager::create_virtio_devices(pci_enabled, vm)
               ├─ true  → VirtioDevices::Pci(PciDevices::new(vm)?)
               └─ false → VirtioDevices::Mmio(MMIOVirtioDevices::new())
                          + boot_cmdline.insert("pci", "off")
```

デバイスの種類（block / net / vsock / balloon / pmem / entropy / mem）ごとの設定は一切変わらない。変わるのは「どのトランスポートに包むか」だけで、`VirtioDevices` という enum の 2 バリアントに閉じ込められている。

### 何を捨てていたのか

MMIO トランスポートが単純なのは、**発見の仕組みを持たないから**だ。

|                  | MMIO トランスポート                                                | PCI トランスポート                                             |
| ---------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| デバイス発見     | しない。VMM がアドレスを教える（cmdline と ACPI DSDT）             | ゲストがバスを列挙する（ECAM または 0xcf8/0xcfc）              |
| レジスタの場所   | 固定オフセット。0x00 に magic、0x70 に status、0x100 以降が config | ケイパビリティチェーンを辿って BAR 内のオフセットを知る        |
| アドレスの決定者 | VMM。起動時に決めて動かない                                        | ゲスト。BAR に書き込んで再配置できる                           |
| 割り込み         | GSI 1 本、irqfd 1 個                                               | MSI-X。キュー数 + 1 本のベクタ、テーブルと PBA を BAR 内に持つ |
| 領域サイズ       | 4KiB (`MMIO_LEN`)                                                  | 512KiB (`CAPABILITY_BAR_SIZE`)                                 |
| デバイス数の上限 | legacy GSI 5〜23 の 19 本（VMGenID と VMClock が 2 本使う）        | 1 セグメントあたり 32 スロット、MSI 用 GSI は 24〜4095         |
| ホットプラグ     | 不可                                                               | 可（v1.16.0 で Developer Preview）                             |

コード量の差もはっきりしている（テストモジュールの手前までの行数）。

```
MMIO 側  transport/mmio.rs 470 + device_manager/mmio.rs 510
                                                   = 約 980 行

PCI 側   transport/pci/{device.rs 1224, common_config.rs 434}
         pci/{configuration.rs 527, msix.rs 586, bus.rs 446, mod.rs 448}
         devices/pci/pci_segment.rs 349
         device_manager/pci_mngr.rs 700
                                                   = 約 4,360 行
```

**4.5 倍**である。しかも増えた 3,400 行の大半は virtio と関係がない。PCI のコンフィグ空間、ケイパビリティチェーン、BAR、MSI-X テーブル、バスの列挙——「デバイスがゲストから見つけられる」ためだけの仕組みだ。

### なぜ戻したのか

3 つの制約が、MMIO では原理的に解けない。

1. **ホットプラグができない。** 起動後にデバイスを足すには、ゲストが新しいデバイスの存在を知る手段が要る。MMIO トランスポートの発見手段はカーネルコマンドラインと ACPI DSDT で、どちらも起動時に確定してしまう。
2. **割り込みがスケールしない。** MMIO は 1 デバイス 1 GSI で、しかも x86 の legacy GSI は 19 本しかない。PCI の MSI-X なら 1 デバイスがキューごとにベクタを持てる。
3. **デバイス数の上限が低い。** 上と同じ理由で、MMIO では 20 個も刺せない。

そして 4 つ目に、性能がある。`docs/kernel-policy.md` は「PCI トランスポートのほうが一般にスループットが高くレイテンシが低い」と書いている。

## ソースコードのどこか

### 分岐は 1 箇所に閉じている

[`src/vmm/src/device_manager/mod.rs#L260-L269`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/mod.rs#L260-L269)。

```rust title="src/vmm/src/device_manager/mod.rs"
    fn create_virtio_devices(
        pci_enabled: bool,
        vm: &Arc<KvmVm>,
    ) -> Result<VirtioDevices, PciManagerError> {
        if pci_enabled {
            Ok(VirtioDevices::Pci(PciDevices::new(vm)?))
        } else {
            Ok(VirtioDevices::Mmio(MMIOVirtioDevices::new()))
        }
    }
```

`bool` を受け取るのはここだけで、以降は enum の `match` になる（[同ファイル#L571-L581](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/mod.rs#L571-L581)）。

```rust title="src/vmm/src/device_manager/mod.rs"
#[derive(Debug)]
pub enum VirtioDevices {
    Mmio(MMIOVirtioDevices),
    Pci(PciDevices),
}
```

デバイスを attach する側は、トランスポートの違いを引数の差としてしか見ない（[同ファイル#L282-L292](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/mod.rs#L282-L292)）。

```rust title="src/vmm/src/device_manager/mod.rs"
        match &mut self.virtio_devices {
            VirtioDevices::Mmio(mmio_devices) => mmio_devices
                .attach_mmio_virtio_device(vm, id, device, cmdline, event_manager, is_vhost_user)
                .map_err(AttachDeviceError::from),
            VirtioDevices::Pci(pci_devices) => pci_devices
                .attach_pci_virtio_device(vm, id, device, event_manager)
                .map_err(AttachDeviceError::from),
        }
    }
```

PCI 側は `cmdline` も `is_vhost_user` も取らない。**PCI ならカーネルコマンドラインにデバイスを書く必要がない**からだ。この引数の非対称が、そのまま両者の思想の差になっている。

### pci=off はビルダーが足す

[`src/vmm/src/builder.rs#L217-L219`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L217-L219)。

```rust title="src/vmm/src/builder.rs"
    if !vm_resources.pci_enabled {
        boot_cmdline.insert("pci", "off")?;
    }
```

これは元々デフォルトのコマンドライン文字列に直書きされていた。0.15.x の CHANGELOG に当時の既定値が残っている。

> New default command line for guest kernel: `reboot=k panic=1 pci=off nomodules 8250.nr_uarts=0 i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd`.

現在の [`DEFAULT_KERNEL_CMDLINE`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vmm_config/boot_source.rs#L19-L20) から `pci=off` は消え、条件付きの挿入に移された。**定数から条件分岐への移動が、この機能追加の入口になっている。** `docs/kernel-policy.md` は逆側の注意も書いている。利用者が `boot_args` で独自のコマンドラインを渡すときは、`pci=off` を **含めてはならない**（PCI 無効時は Firecracker が自分で足す）。

### MMIO トランスポート — 固定オフセットの表

[`src/vmm/src/devices/virtio/transport/mmio.rs#L38-L51`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/transport/mmio.rs#L38-L51) の doc コメントが、この設計の全体像を言い切っている。

```rust title="src/vmm/src/devices/virtio/transport/mmio.rs"
/// This requires 3 points of installation to work with a VM:
///
/// 1. Mmio reads and writes must be sent to this device at what is referred to here as MMIO base.
/// 1. `Mmio::queue_evts` must be installed at `virtio::NOTIFY_REG_OFFSET` offset from the MMIO
///    base. Each event in the array must be signaled if the index is written at that offset.
/// 1. `Mmio::interrupt_evt` must signal an interrupt that the guest driver is listening to when it
///    is written to.
///
/// Typically one page (4096 bytes) of MMIO address space is sufficient to handle this transport
/// and inner virtio device.
```

`BusDevice::read` の実装は、オフセットの `match` がそのままレジスタ表になっている（[同ファイル#L226-L280](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/transport/mmio.rs#L226-L280)）。0x00 が magic、0x04 が version、0x08 がデバイス型、0x70 が status、0x100 以降がデバイス固有の設定空間。ゲストは何も探索せず、この表を知っているだけでいい。リソース確保も 10 行で済む（[`src/vmm/src/device_manager/mmio.rs#L163-L186`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/mmio.rs#L163-L186)）。GSI を 1 本、32 ビット MMIO 空間から 4KiB を 1 枚。

### PCI トランスポート — BAR の中に全部詰める

[`src/vmm/src/devices/virtio/transport/pci/device.rs#L204-L225`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/transport/pci/device.rs#L204-L225)。1 本の BAR（512KiB）を 6 つの領域に切って使う。

```rust title="src/vmm/src/devices/virtio/transport/pci/device.rs"
// Allocate one bar for the structs pointed to by the capability structures.
// As per the PCI specification, because the same BAR shares MSI-X and non
// MSI-X structures, it is recommended to use 8KiB alignment for all those
// structures.
const COMMON_CONFIG_BAR_OFFSET: u32 = 0x0000;
const COMMON_CONFIG_SIZE: u32 = 56;
const ISR_CONFIG_BAR_OFFSET: u32 = 0x2000;
const ISR_CONFIG_SIZE: u32 = 1;
// ...DEVICE_CONFIG (0x4000) / NOTIFICATION (0x6000) が続く...
const MSIX_TABLE_BAR_OFFSET: u32 = 0x8000;
// The size is 256KiB because the table can hold up to 2048 entries, with each
// entry being 128 bits (4 DWORDS).
const MSIX_TABLE_SIZE: u32 = 0x40000;
```

実際に使うのは 56 バイトの共通設定と 1 バイトの ISR と 4KiB の設定空間だが、MSI-X の要求（8KiB アライン、最大 2048 ベクタぶんのテーブル）に合わせると 512KiB になる。MMIO の 4KiB と比べて 128 倍だ。**PCI の複雑さは、実装量だけでなくアドレス空間の消費にも出る。**

BAR がゲストによって移動しうることの厄介さは、フィールドのコメントに書かれている（[同ファイル#L291-L299](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/transport/pci/device.rs#L291-L299)）。

```rust title="src/vmm/src/devices/virtio/transport/pci/device.rs"
    // GPA base at which the capability BAR is currently mapped on the
    // mmio bus, and where the notification ioeventfds are registered.
    // 0 means unmapped
    //
    // It is not necessarily equal to `config_bar_addr()`: the latter reflects
    // whatever the guest has last written into the BAR registers, which may be
    // transient (a 64-bit BAR is programmed with two separate writes) or not
    // yet in effect.
    bar_address: u64,
```

64 ビット BAR はゲストが 2 回に分けて書くので、**書き込みの途中の値が一時的に無効なアドレスになる**。MMIO トランスポートには存在しない問題だ。アドレスを VMM が決めて動かさない設計では、そもそも「今どこにマップされているか」という状態変数が要らない。

attach の手順も MMIO より一段多い（[`src/vmm/src/device_manager/pci_mngr.rs#L122-L152`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/pci_mngr.rs#L122-L152)）。

```rust title="src/vmm/src/device_manager/pci_mngr.rs"
        let sbdf = self.pci_segment.next_device_sbdf()?;
        // Allocate one MSI vector per queue, plus one for configuration
        let msix_num =
            u16::try_from(device.lock().expect("Poisoned lock").queues().len() + 1).unwrap();
        let msix_vectors = KvmVm::create_msix_group(vm.clone(), msix_num)?;
```

Segment / Bus / Device / Function の組（SBDF）を採番し、キュー数 + 1 本の MSI-X ベクタを KVM に登録し、64 ビット MMIO 空間から BAR を確保する。GSI 1 本を取るだけだった MMIO とは、割り込みの規模がまるで違う。

## なぜそうなっているか

PCI を持たなかった理由は、CHANGELOG では説明されていない。ただし追加したときの書き方が、Firecracker の判断基準をよく表している（1.13.0）。

> [#5364](https://github.com/firecracker-microvm/firecracker/pull/5364): Added PCI support in Firecracker. PCI support is **optional**. Users can enable it passing the `--enable-pci` flag when launching the Firecracker process. When Firecracker process is launched with PCI support, it will create all VirtIO devices using a PCI VirtIO transport. **If not enabled, Firecracker will use the MMIO transport instead.**

デフォルトは変えていない。`--enable-pci` の help は「Enables PCIe support.」の 1 行だけで、既定値は無効のままだ。**複雑さを戻すが、既定では戻さない。**

ホットプラグの動機は `docs/device-hotplug.md` にはっきり書かれている。

> **PCI transport enabled**: Firecracker must be started with the `--enable-pci` flag. Device hotplugging is not supported with MMIO transport.

これは実装の都合ではなく、トランスポートの性質から来る制約だ。同じドキュメントは、PCI にしても自動通知はまだ無く、ゲストが `echo 1 > /sys/bus/pci/rescan` で自分から探しに行く必要があることも認めている。つまり現時点で PCI が提供しているのは発見可能性だけだが、MMIO では原理的に不可能なので前進ではある。

性能面は `docs/kernel-policy.md` に一文だけある。

> The PCI transport typically achieves higher throughput and lower latency for VirtIO devices.

数値の裏付けはドキュメントにない。推測だが、MSI-X によって割り込みがキュー単位に分かれ、vCPU ごとに配送先を分けられることが主因だろう。MMIO では 1 デバイス 1 割り込み線なので、マルチキューの virtio-net でも割り込み処理が 1 vCPU に集中する。

もう 1 つ、PCI が入る素地は ACPI 対応（1.8.0）の時点でできていた。PCI デバイスが 1 つも無かった当時から、Firecracker はゲストに `CONFIG_PCI=y` を要求し（ACPI 初期化に必要なため）、MCFG テーブルで PCIe の ECAM 領域の位置を申告し、e820 でその 256MiB を予約していた。**「PCI バスは無いが、PCI バスがあるべき場所は空けてある」という状態が 5 リリース続いた**あとで、そこに実物が入った。

## どう活かすか

**一度捨てた複雑さを戻すときは、「戻す/戻さない」を実行時に選べる形にする。** Firecracker は PCI 対応で既存の MMIO コードを 1 行も削っていない。`VirtioDevices` という enum を作り、両方を保持できるようにした。この形が取れたのは、デバイス本体（`dyn VirtioDevice`）とトランスポートが最初から分離していたからだ。逆に言えば、**将来複雑さを戻す可能性があるなら、捨てるときに境界だけは残しておく**必要がある。Firecracker が捨てたのは PCI の実装であって、「トランスポートという層」ではなかった。

**フラグを bool で受け取るのは 1 箇所だけにする。** `pci_enabled: bool` が現れるのは `main.rs` の引数解析、`VmResources`、`DeviceManager::new`、`create_virtio_devices`、そして `builder.rs` の `pci=off` 挿入だけだ。そこから先は `match &self.virtio_devices` になる。bool を持ち回すと、分岐が増えたときに「この bool の意味」が場所ごとにずれる。早い段階で型に変換しておけば、コンパイラが分岐の網羅を保証してくれる。実際 `device_manager/mod.rs` には `VirtioDevices::Mmio(_) => Err(VmmActionError::PciNotEnabled)` という腕が複数あり、PCI 専用機能の呼び出しがコンパイル時に列挙されている。

**「まだ無い機能のために場所だけ空けておく」のは、固定レイアウトを持つシステムでは有効。** ACPI の MCFG と e820 の ECAM 予約は、PCI デバイスが存在しない 5 リリースのあいだ「使われない予約」だった。ゲストに見せるメモリレイアウトはスナップショット互換性にも縛られるので、後から穴を空けるのは高い。予約のコストが十分低いなら、先に置いておく判断はありうる。

一方、**取り込むべきでない条件**もはっきりしている。

- **複雑さの見積もりを「自分の書く行数」で終わらせない。** PCI 対応で増えた約 3,400 行のうち virtio に固有なのは `transport/pci/` の 1,658 行だけで、残りは PCI という規格そのものの実装だ。「デバイスをホットプラグしたい」という 1 行の要求が、コンフィグ空間・ケイパビリティ・BAR 再配置・MSI-X テーブルという 4 つの独立した仕様を連れてくる。
- **攻撃面が増える。** PCI はゲストが書き込めるレジスタを大量に増やし、しかも BAR のようにアドレスマッピングを動かせるものを含む。上で引用した「64 ビット BAR は 2 回に分けて書かれるので途中の値は無効」という注意は、そのままバグと脆弱性の温床である。既定を無効にしたまま Developer Preview を続けている判断は、この点と整合する。**複雑さを戻す判断と、それを既定にする判断は別**にできる。
- **上限に余裕があるなら単純なほうを選ぶ。** MMIO で刺せるのは 17 個程度だが、Firecracker の想定するワークロードでは block 1〜2 個と net 1 個で足りる。PCI が要るのは、デバイス数が二桁になるか、マルチキューで割り込みを分散したいか、起動後にデバイス構成を変えたい場合に限られる。
