---
title: "virtio-mem は KVM スロットごとメモリを外す"
description: "balloon がメモリスロットを残したまま「ゲストに使わせない」のに対し、virtio-mem は KVM メモリスロットを実際に増減させ、未プラグ領域を mprotect(PROT_NONE) で塞ぐ。ブロックとスロットという 2 段の粒度、unplug 時の「KVM から外す → mprotect → 実メモリ解放」という順序、そして API とスナップショットの制約を読む。"
group: "メモリを伸縮させる"
sidebar:
  order: 39
---

## 何を学んだか

### balloon と virtio-mem は「何を外すか」が違う

[balloon のページ](../balloon-zeroing/) で見たとおり、virtio-balloon はゲストにページを確保させ、その PFN を受け取ってホスト側で `madvise(MADV_DONTNEED)` する。ここで動くのは **ホストの物理ページだけ** である。ゲスト物理アドレス空間の構成は一切変わらず、KVM メモリスロットは登録されたままだ。ゲストが balloon 中のページに触れば、KVM は普通にフォールトを処理して新しいゼロページを割り当ててしまう。ホストから見て「そのアドレスにアクセスさせない」という保護は掛かっていない。

virtio-mem はこれを一段深くやる。ゲスト物理アドレス空間の中にあらかじめ「ホットプラグ可能な領域」を確保しておき、そのうち実際にプラグされた部分だけを **KVM メモリスロットとして登録する**。未プラグの部分はスロットが存在しないので、ゲストがアクセスすると KVM は変換先を持たず、フォールトする。さらにホストプロセス側の VMA も `mprotect(PROT_NONE)` で塞いであるので、Firecracker 自身のデバイスエミュレーションがそこを読み書きしようとしても SIGSEGV になる。

```
                balloon                        virtio-mem
ゲスト物理    +----------------+            +----------------+
アドレス空間  | DRAM (固定)    |            | DRAM (固定)    |
              |  balloon 中の  |            +----------------+
              |  ページも      |            | hotplug 領域   |
              |  スロット内    |            |  slot0 plugged | ← KVM に登録
              +----------------+            |  slot1 unplug  | ← KVM から外れて
KVM スロット   常に全部登録                 |  slot2 unplug  |    PROT_NONE
mprotect       しない                       +----------------+
ゲストが触ると ゼロページが割当たる          フォールト（VM が死ぬ）
```

`docs/memory-hotplug.md` は保護の強さを 3 段階で書き分けている。一度もプラグされていないメモリは KVM スロットに無く `mprotect` 済み。unplug されたスロットは KVM から取り外して `mprotect` される。unplug されたブロックはバッキングページが解放される。**ブロック単位では解放しかできず、保護が掛かるのはスロット単位** という非対称がここに出ている。

### なぜ粒度が 2 段あるのか

- **ブロック**（小、既定 2 MiB、最小 2 MiB、2 の冪）= 仕様上の単位で、ゲストドライバがプラグ／アンプラグを要求する。unplug されると `discard_range` でホストメモリが解放される。
- **スロット**（大、既定 128 MiB、最小 128 MiB、ブロックサイズの倍数）= Firecracker が独自に足した KVM メモリスロットの単位。中の全ブロックが unplug されたときだけ KVM から外れて `PROT_NONE` になる。

分ける理由は KVM メモリスロット数の上限である。2 MiB ごとにスロットを切ると 1 GiB のホットプラグ領域で 512 スロット必要になり、`KVM_CAP_NR_MEMSLOTS` の枠を食い潰す。逆にスロットを大きくすると保護の粒度が粗くなる。ドキュメントは「厳格な保護が要るなら `block_size_mib` を `slot_size_mib` と等しくせよ、ただしゲストカーネルが連続した領域を見つけにくくなる」と書いていて、トレードオフを明示している。

### unplug の順序が決まっている

unplug 処理は、(1) 内部のブロックビットマップ `plugged_blocks` を更新、(2) 影響を受ける **スロット** を走査して、全ブロックが unplug になったスロットを KVM から外し `mprotect(PROT_NONE)`、(3) そのあとで `discard_range` を呼んで実メモリを解放、の順に進む。

2 と 3 が逆だと何が起きるかはコメントが直接答えている。「Update kvm slots before doing any discards to prevent guest from re-faulting just discarded memory」。ゲストの vCPU は別スレッドで走り続けているので、`discard_range` でページを捨てた直後にゲストがその領域に触ると、KVM はまだスロットを持っているためフォールトを処理して新しいページを割り当ててしまう。せっかく解放したメモリが即座に戻ってくる。先にスロットを外しておけば、その競合は起きない。

plug のときは逆順になる。`update_slot` は plug なら「アクセス可能にしてから KVM に追加」、unplug なら「KVM から外してから保護」で、どちらも **「ゲストから見えている期間は、必ずホスト側でアクセス可能」** という不変条件を保つための順序である。

## ソースコードのどこか

### スロットの状態は BitVec で持つ

ゲストメモリ領域を表す `GuestRegionMmapExt` が、KVM スロット番号とスロットサイズ、そしてスロットごとの plug 状態のビットベクタを持つ。

```rust title="src/vmm/src/vstate/memory.rs"
pub struct GuestRegionMmapExt {
    pub inner: GuestRegionMmap,
    /// the type of region
    pub region_type: GuestRegionType,
    /// the starting KVM slot number assigned to this region
    pub slot_from: u32,
    /// the size of the slots of this region
    pub slot_size: usize,
    /// a bitvec indicating whether slot `i` is plugged into KVM (1) or not (0)
    pub plugged: Mutex<BitVec>,
}
```

[`src/vmm/src/vstate/memory.rs#L396-L410`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L396-L410)

通常の DRAM 領域は `dram_from_mmap_region` で作られ、`BitVec::repeat(true, 1)` すなわち「スロット 1 個、常に plugged」になる。ホットプラグ領域は `hotpluggable_from_mmap_region` で `BitVec::repeat(false, slot_cnt)` すなわち「全スロット unplugged」で始まる（[`#L543-L571`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L543-L571)）。DRAM とホットプラグ領域が同じ型で表現され、違いはビットベクタの初期値だけ、という設計になっている。

領域を VM に登録するときも同じ抽象が効く。

```rust title="src/vmm/src/vstate/vm.rs"
        region
            .slots()
            .try_for_each(|(ref slot, plugged)| match plugged {
                // if the slot is plugged, add it to kvm user memory regions
                true => self.set_user_memory_region(slot.into()),
                // if the slot is not plugged, protect accesses to it
                false => slot.protect(true).map_err(VmError::MemoryError),
            })?;
```

[`src/vmm/src/vstate/vm.rs#L432-L450`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L432-L450)

起動時もスナップショット復元時もこの 1 本を通る。復元時は `GuestRegionMmapExt::from_state` がスナップショットに入っていた `plugged: Vec<bool>` からビットベクタを復元するので、復元直後のスロット構成は保存時と一致する。

### KVM への出し入れと mprotect

`update_slot` が KVM 登録と保護をまとめて扱う。

```rust title="src/vmm/src/vstate/memory.rs"
        let mut kvm_region = kvm_userspace_memory_region::from(mem_slot);
        if plug {
            // make it accessible _before_ adding it to KVM
            mem_slot.protect(false)?;
            vm.set_user_memory_region(kvm_region)?;
        } else {
            // to remove it we need to pass a size of zero
            kvm_region.memory_size = 0;
            vm.set_user_memory_region(kvm_region)?;
            // make it protected _after_ removing it from KVM
            mem_slot.protect(true)?;
        }
```

[`src/vmm/src/vstate/memory.rs#L687-L717`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L687-L717)

スロットの削除は `KVM_SET_USER_MEMORY_REGION` に **同じスロット番号で `memory_size = 0`** を渡すことで行う。KVM の API にスロット削除専用の呼び出しは無く、サイズ 0 が削除を意味する。関数の冒頭では現在の状態と比較して、変化が無ければ何もせずに返る（`if prev == plug { return Ok(()) }`）。

保護そのものは `GuestMemorySlot::protect`（[`memory.rs#L520-L540`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L520-L540)）で、スロットに対応するホスト仮想アドレス範囲に `mprotect(PROT_NONE)` または `mprotect(PROT_READ|PROT_WRITE)` を打つだけである。

### ブロックからスロットへの繰り上げ

デバイス側の `update_kvm_slots` が、要求されたブロック範囲から「その範囲に交差するスロット」を求め、スロットごとに中のブロック状態を再評価する。

```rust title="src/vmm/src/devices/virtio/mem/device.rs"
        hp_region
            .slots_intersecting_range(
                updated_range.addr,
                self.nb_blocks_to_len(updated_range.nb_blocks),
            )
            .try_for_each(|(slot, _)| {
                let slot_range = RequestedRange {
                    addr: slot.guest_addr,
                    nb_blocks: slot.slice.len() / u64_to_usize(self.config.block_size),
                };
                match self.range_state(&slot_range) {
                    BlockRangeState::Mixed | BlockRangeState::Plugged => {
                        hp_region.update_slot(&self.vm, &slot, true)
                    }
                    BlockRangeState::Unplugged => hp_region.update_slot(&self.vm, &slot, false),
                }
                .map_err(VirtioMemError::UpdateKvmSlot)
            })
```

[`src/vmm/src/devices/virtio/mem/device.rs#L497-L521`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/mem/device.rs#L497-L521)

判定は 3 値である。スロット内のブロックが全部 plugged か **一部でも plugged**（`Mixed`）ならスロットは KVM に登録したまま、全部 unplugged になって初めて外す。これが「保護が掛かるのはスロット単位」の実装そのもので、`block_size_mib` を小さくすると保護されにくくなる理由でもある。

### 順序を決めているコメント

```rust title="src/vmm/src/devices/virtio/mem/device.rs"
        // Update kvm slots before doing any discards to prevent guest from re-faulting just
        // discarded memory.
        self.update_kvm_slots(range)?;

        // If unplugging, discard the range
        if !plug
            && let Err(err) = self
                .guest_memory()
                .discard_range(range.addr, self.nb_blocks_to_len(range.nb_blocks))
        {
            // Failure to discard is not fatal and is not reported to the driver. It only
            // gets logged.
            METRICS.unplug_discard_fails.inc();
            error!("virtio-mem: Failed to discard memory range: {}", err);
        }
```

[`src/vmm/src/devices/virtio/mem/device.rs#L527-L553`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/mem/device.rs#L527-L553)

呼んでいる `discard_range` は balloon とまったく同じ関数である。「ゲストのメモリを捨てる」経路が 1 本に集約されているので、匿名 mmap／スナップショットファイル／memfd の場合分けも共通になる。

`discard_range` の失敗は致命的ではなくメトリクスとログだけで、ドライバには成功として応答する。これは妥当で、この時点ですでに KVM スロットの更新は終わっており、**ゲストから見た「そのブロックは unplug された」という事実は確定している**。ホストが物理メモリを返しそこねただけなので、プロトコル上の状態を巻き戻す必要はない。

### API とスナップショット

`/hotplug/memory` への `PUT` は **起動前にしか受け付けない**。`docs/memory-hotplug.md` は「This is only allowed before the `InstanceStart` action and not on snapshot-restored VMs (which will use the configuration saved in the snapshot)」と書いている。総サイズ・ブロックサイズ・スロットサイズは起動時にアドレス空間と KVM スロット番号を確定させるので、あとから変えられない。実行中に変えられるのは `PATCH` で送る `requested_size_mib` だけである。復元時に新規設定を受け付けないのは、スナップショットの `GuestMemoryRegionState` に `region_type` と `plugged: Vec<bool>` が入っていて、それが復元後のスロット構成を決めるからだ（[`memory.rs#L975-L988`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L975-L988)）。unplug 済みの領域はメモリスナップショットファイル上ではスパースな穴になる（[スナップショットのフォーマット](../snapshot-format/)）。

`requested_size_mib` を上げても、その場でメモリが増えるわけではない。デバイスは config space を書き換えて config 割り込みを上げるだけで、実際にプラグするのはゲストドライバである。だからドキュメントは `GET /hotplug/memory` で `plugged_size_mib` をポーリングして完了を確認せよと書いている。unplug も同じで、ゲストが連続したブロックを見つけて解放できなければ何も起きない。

## なぜそうなっているか

**balloon で足りない理由は保護にある。** balloon はゲストドライバの協力に完全に依存する best-effort な仕組みで、壊れたドライバは inflate したページをそのまま使い続けられる。ホスト側にそれを止める手段はない。対して virtio-mem は、unplug された領域を KVM スロットから外すことで **ゲストがアクセスできないことを EPT のレベルで担保する**。`docs/memory-hotplug.md` の Trust Model は、悪意あるドライバが unplug 済みメモリにアクセスした場合の結果を「will result in a fault and crash of Firecracker」と書いている。データを漏らすのではなくプロセスが死ぬ、という失敗モードを選んでいる。

**スロットという概念は KVM の制約から来た Firecracker 独自の追加である。** virtio-mem の仕様にスロットは無く、ドキュメントも「Firecracker further adds the concept of slots」と明記している。ゲストに見せるインターフェースは仕様どおりブロック単位のまま、ホスト側の実装都合を別の層として切り出したことで、ゲストドライバに手を入れずに保護を足せている。

**保護の粒度が既定で粗いのは、使えることを優先したから。** `block_size_mib = slot_size_mib` にすれば全 unplug が即座に保護に繋がるが、ゲストカーネルが 128 MiB 連続した領域を空けるのは難しい。ドキュメントは既定値のままを推奨し、厳格な保護が要る場合だけ揃えよ、としている。

**vhost-user だけは保護しきれない、ともドキュメントは書いている。** `mprotect` が効くのは Firecracker プロセスの VMA だけで、vhost-user バックエンドは別プロセスとして自分のマッピングを持つ。「Firecracker cannot guarantee protection of unplugged memory from a `vhost-user` backend」。保護機構の適用範囲を、できないところまで含めて書いてある。

## どう活かすか

**「使わせない」と「触れなくする」を区別する。** balloon と virtio-mem の差はここに尽きる。前者は相手の自己申告に基づく協調的な資源返却で、後者はマッピングを外すことによる強制である。マルチテナントでテナント側のエージェントを信用できないなら、協調的な仕組みだけでは境界にならない。逆に自社サービス内で単に RSS を下げたいだけなら、実装が軽い協調的な仕組みで足りる。**脅威モデルを決めてから機構を選ぶ** 順序が、この 2 デバイスの並存に現れている。

**資源の解放と可視性の剥奪には順序がある。** 「解放してから見えなくする」と、その隙間で相手が再取得してしまう。コネクションプールのエントリ破棄、キャッシュの退避、共有バッファの返却など、「参照経路を閉じる → 実体を解放する」の順を守るべき場面は多い。逆順は無害に見えて、負荷が高いときだけリークや二重確保として現れる。

**粒度を 2 段に分けるのは、外向きの仕様と内部制約が食い違うときの定石。** ゲストには 2 MiB ブロック、KVM には 128 MiB スロット、という分離は、外部プロトコルを変えずに実装側のスケーラビリティ制約を吸収している。このとき **どちらの粒度でどの保証が成立するか** を明示することが重要で、Firecracker は「解放はブロック単位、保護はスロット単位」と切り分けて文書に書いている。

**取り込むべきでない条件。** virtio-mem はゲストカーネル 5.16 以上と `CONFIG_VIRTIO_MEM`、さらに hot-remove を成功させるには `memhp_default_state=online_movable` が要る。ゲストイメージを自分で管理できない環境ではそもそも動かない。また hotplug されたメモリの `struct page` は既定でブートメモリから取られ、16 GiB のホットプラグに 262 MiB のブートメモリが要る、とドキュメントは書いている。「あとから増やせる」ことのコストが最初から掛かるので、ホットプラグ領域を無闇に大きく宣言すべきではない。
