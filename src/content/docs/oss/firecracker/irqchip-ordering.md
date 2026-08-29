---
title: "IRQCHIP と vCPU の作成順序に、逆らえない制約がある"
description: "x86_64 では KVM_CREATE_IRQCHIP と KVM_CREATE_PIT2 を vCPU 作成の前に呼ばねばならず、aarch64 では GIC を vCPU 作成の後に作らねばならない。真逆の制約を同じ create_vcpus() で扱うため、Firecracker は arch_pre_create_vcpus / arch_post_create_vcpus という 2 つの空フックを用意している。カーネル API の制約がそのままコードの構造になった例。"
group: "KVM をどう叩くか"
sidebar:
  order: 15
---

## 何を学んだか

### 「アーキ依存」は分岐ではなくフックとして現れる

microVM を組み立てるとき、[割り込みコントローラ](../interrupt-delivery/)を作る操作と vCPU を作る操作は、どちらも「VM fd に対する ioctl」である。だがこの 2 つには **アーキテクチャごとに逆向きの順序制約** がある。

```
x86_64:  KVM_CREATE_IRQCHIP ─> KVM_CREATE_PIT2 ─> KVM_CREATE_VCPU x N
aarch64: KVM_CREATE_VCPU x N ─> KVM_CREATE_DEVICE(GIC)
```

x86_64 では割り込みコントローラが先。aarch64 では vCPU が先。**どちらかに寄せることはできない。** カーネルがそう決めているからだ。

素朴に書けば `create_vcpus()` の中を `#[cfg(target_arch = ...)]` で分岐させることになる。Firecracker はそうせず、**アーキ非依存の `create_vcpus()` に 2 つのフック点を開けて、各アーキがどちらか片方だけを埋める**構造にした。

```
KvmVm::create_vcpus(vcpu_count)          <- アーキ非依存 (vstate/vm.rs)
  ├─ self.arch_pre_create_vcpus(n)       <- x86_64: setup_irqchip() / aarch64: Ok(())
  ├─ for i in 0..n { Vcpu::new(i, ...) }
  └─ self.arch_post_create_vcpus(n)      <- x86_64: Ok(())        / aarch64: setup_irqchip(n)
```

結果として、**「順序制約がある」という事実そのものが型（トレイトではなく、アーキごとに定義される同名メソッド）として残る。** アーキを追加する人は、2 つのフックのどちらに置くかを必ず選ばされる。順序を間違えたコードを書くことは可能だが、順序という論点が存在することは見落としようがない。

### 何を作っているのか

x86_64 の `setup_irqchip()` は 2 つの ioctl を呼ぶ。

- **`KVM_CREATE_IRQCHIP`** — PIC マスタ・PIC スレーブ・IOAPIC の 3 つをカーネル内に作る。これがあると、デバイスの割り込みは `irqfd` に write するだけでゲストに届き、ユーザ空間への VM exit が起きない。
- **`KVM_CREATE_PIT2`** — 8254 PIT（レガシータイマー）をカーネル内に作る。フラグに `KVM_PIT_SPEAKER_DUMMY` を渡す。

`KVM_PIT_SPEAKER_DUMMY` の理由がコメントに書いてある。**ポート 0x61（PC スピーカー）への write で VM exit させないため**である。実際に音を鳴らす気は無いが、ゲストの Linux が触るので、触られたときに毎回ユーザ空間に戻ってくると無駄なコストになる。「エミュレートしない」と「exit させない」は別の話で、後者のためにダミーを置いている。

## ソースコードのどこか

アーキ非依存側は [`src/vmm/src/vstate/vm.rs#L197-L216`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L197-L216)。vCPU の生成ループを 2 つのフックで挟んでいるだけで、どのアーキで何が起きるかはここには書かれていない。

```rust title="src/vmm/src/vstate/vm.rs"
    pub fn create_vcpus(&mut self, vcpu_count: u8) -> Result<Vec<Vcpu>, VmError> {
        self.arch_pre_create_vcpus(vcpu_count)?;

        let mut vcpus = Vec::with_capacity(vcpu_count as usize);
        for cpu_idx in 0..vcpu_count {
            let exit_evt = self
                .vcpus_exit_evt()
                .try_clone()
                .map_err(VmError::EventFd)?;
            let vcpu = Vcpu::new(cpu_idx, self, exit_evt).map_err(VmError::CreateVcpu)?;
            vcpus.push(vcpu);
        }

        self.arch_post_create_vcpus(vcpu_count)?;

        Ok(vcpus)
    }
```

x86_64 側の実装が [`src/vmm/src/arch/x86_64/vm.rs#L116-L125`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vm.rs#L116-L125)。片方に処理を置き、もう片方は `Ok(())` を返すだけである。制約の理由はコメント 1 行に凝縮されている。

```rust title="src/vmm/src/arch/x86_64/vm.rs"
    /// Pre-vCPU creation setup.
    pub fn arch_pre_create_vcpus(&mut self, _: u8) -> Result<(), KvmVmError> {
        // For x86_64 we need to create the interrupt controller before calling `KVM_CREATE_VCPUS`
        self.setup_irqchip()
    }

    /// Post-vCPU creation setup.
    pub fn arch_post_create_vcpus(&mut self, _: u8) -> Result<(), KvmVmError> {
        Ok(())
    }
```

`setup_irqchip()` 自体は [`src/vmm/src/arch/x86_64/vm.rs#L170-L184`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vm.rs#L170-L184) にある。20 行にも満たない。

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

対比として aarch64 側 [`src/vmm/src/arch/aarch64/vm.rs#L101-L107`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/aarch64/vm.rs#L101-L107)。埋まっているのは `post` のほうで、しかも**カーネル側の該当関数名まで書いてある**。

```rust title="src/vmm/src/arch/aarch64/vm.rs"
    pub fn arch_post_create_vcpus(&mut self, nr_vcpus: u8) -> Result<(), KvmVmError> {
        // On aarch64, the vCPUs need to be created (i.e call KVM_CREATE_VCPU) before setting up the
        // IRQ chip because the `KVM_CREATE_VCPU` ioctl will return error if the IRQCHIP
        // was already initialized.
        // Search for `kvm_arch_vcpu_create` in arch/arm/kvm/arm.c.
        self.setup_irqchip(nr_vcpus)
    }
```

aarch64 の側は「IRQCHIP を先に作ってあると `KVM_CREATE_VCPU` がエラーを返す」と、**観測できる失敗の形**で書かれている。x86_64 の側にはそこまでの記述がない（本記事では aarch64 の詳細には立ち入らない）。

なお、`KVM_CREATE_IRQCHIP` より前に済ませてある ioctl もある。`KvmVm::new()` の中で `KVM_SET_TSS_ADDRESS` を呼んでいる（[`src/vmm/src/arch/x86_64/vm.rs#L101-L104`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vm.rs#L101-L104)）。VM fd を作った直後に、vCPU も irqchip もまだ無い段階でやっている。**VM のライフサイクルは「fd を作る → VM 全体の設定 → irqchip → vCPU」という段階を持っている**ことが、コードの配置に出ている。

## なぜそうなっているか

### カーネル内割り込みコントローラは「vCPU の一部」でもある

x86_64 で `KVM_CREATE_IRQCHIP` が作るのは IOAPIC と 2 個の PIC だが、これを有効にすると各 vCPU に **LAPIC（Local APIC）** も付く。LAPIC は CPU ごとに 1 個ある割り込み受け口なので、vCPU を作る時点で「この VM は in-kernel irqchip モードか」が決まっていないと、vCPU の中身が決められない。x86_64 の順序制約はこの関係から来ている、というのが素直な読みである（**Firecracker のコメントはそこまで書いていないので、この因果関係は推測を含む**）。

順序制約の存在自体は、別の場所からも裏が取れる。`save_state()` は [`src/vmm/src/arch/x86_64/vm.rs#L186-L225`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vm.rs#L186-L225) で PIT・PIC マスタ・PIC スレーブ・IOAPIC の状態を吸い上げ、`VmState` に詰めている。テストは、**`setup_irqchip()` を呼んでいない VM で `save_state()` を呼ぶと失敗する** ことを最初に確認している（[`src/vmm/src/arch/x86_64/vm.rs#L281-L284`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vm.rs#L281-L284)）。

```rust title="src/vmm/src/arch/x86_64/vm.rs"
    fn test_vm_save_restore_state() {
        let vm = setup_vm();
        // Irqchips, clock and pitstate are not configured so trying to save state should fail.
        vm.save_state().unwrap_err();
```

つまり in-kernel irqchip は「作れば動くもの」ではなく、**存在するかどうかが VM の状態の一部**である。[スナップショット](../snapshot-format/)にも入る。作成順序が固定されるのは、この種の状態を持つ相手なら不思議ではない。

### なぜ `#[cfg]` 分岐ではなくフックなのか

`create_vcpus()` の中に `#[cfg(target_arch = "x86_64")] self.setup_irqchip()?;` と書いても動く。実際そう書いている VMM もある。フックにした利点は 2 つある。

- **アーキ非依存ファイルにアーキ固有の知識が漏れない。** `vstate/vm.rs` は `setup_irqchip` も `GIC` も知らない。知っているのは「vCPU 生成の前後にアーキ固有の処理点がある」ことだけである。
- **フックが空であることが明示される。** x86_64 の `arch_post_create_vcpus` は `Ok(())` を返すだけだが、**そこに何も無いことが 1 箇所に書かれている。** `#[cfg]` 分岐だと「aarch64 側に何かあるらしい」がコードから読めない。

トレイトを切っていない点も特徴的である。`KvmVm` はアーキごとに別の構造体で、同名のメソッドを持つ。x86_64 のフックは `_: u8` と引数を捨て、aarch64 は `nr_vcpus` を使う。共通のトレイトにすると全アーキが同じシグネチャに縛られるが、この方式なら**必要なアーキだけが必要な引数を使える**。

## どう活かすか

### 「順序制約がある」ことを型か構造に落とす

外部 API に順序制約があるとき、取りうる手は 3 つある。

1. **コメントで書く。** 最も安いが、リファクタで消える。
2. **フック（テンプレートメソッド）にする。** 手続きの骨格を 1 箇所に固定し、可変部分だけを外に出す。骨格を読めば順序が分かる。
3. **型で強制する。** `VmWithoutIrqchip -> VmWithIrqchip -> VmWithVcpus` のように、状態ごとに別の型を作って遷移させる。

Firecracker が 2 を選んだのは、**制約がアーキごとに違う（真逆になる）から**である。3 でやろうとすると型の連鎖がアーキごとに 2 種類でき、そちらのほうが複雑になる。制約が 1 種類しかないなら 3 のほうが強い。

### 効く前提条件

このやり方が割に合うのは次のときである。

- **順序を間違えたときの失敗が実行時にしか出ない。** `KVM_CREATE_VCPU` が `EINVAL` を返すだけなら、原因究明に時間を溶かす。コンパイル時か、せめてコードの構造で防ぎたくなる。
- **その順序を守るべき箇所が複数ある。** Firecracker では通常起動と[スナップショットからの復元](../restore-from-file/)の両方が `create_vcpus()` を通る。骨格が 1 箇所なら、両方で自動的に守られる。
- **プラットフォームが 2 つ以上ある。** 1 つしかないなら、素直に順番に書けばよい。フックは「差異があるから」意味を持つ。

### 逆に、やりすぎになるケース

呼ばれる場所が 1 箇所しかない初期化シーケンスにフックを導入するのは、たいてい割に合わない。**間接参照が 1 段増える分、初見で「x86_64 では何が起きるのか」を追うのに 2 ファイル読む必要が出る。** Firecracker でもこのコストは実際に払っていて、`create_vcpus()` だけを読んでも irqchip の話は出てこない。差異が 2 つ以上のアーキ／プラットフォームにまたがって初めて元が取れる。
