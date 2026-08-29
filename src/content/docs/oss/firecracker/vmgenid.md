---
title: "同じスナップショットから何台も起動すると、乱数が揃う"
description: "1 つのスナップショットから複数のクローンを起動すると、ゲストの CSPRNG が同じ状態から再開する。Firecracker の対策である VM Generation ID デバイスの実装（復元のたびに 128bit を再生成し、ACPI で見せ、vCPU 再開前に割り込む）と、カーネル版・ユーザ空間・レース窓という 3 つの限界、そして virtio-rng との役割の違いを読む。"
group: "スナップショット"
sidebar:
  order: 49
---

## 何を学んだか

### スナップショットを複製した瞬間、「一意なはずのもの」が一意でなくなる

スナップショットの魅力は、起動済みの VM を何台でも即座に複製できることだ。だがゲストから見れば、1 つのスナップショット S から起動した clone A / B / C は **完全に同じ状態から** 実行を再開する。ゲスト OS のエントロピープール、CSPRNG の内部状態、キャッシュ済みの乱数、生成済みのトークン、`boot_id` のような識別子は全て同一になる。

何が危険かは具体的に言える。

- **TLS の鍵と nonce の再利用。** クローン A とクローン B が同じ乱数列から鍵を生成すれば、両者の TLS セッション鍵は一致する。ECDSA の署名 nonce が一致すれば、2 つの署名から秘密鍵が復元できる。
- **他テナントの乱数の予測。** 攻撃者が同じスナップショットからクローンを起動できるなら、他のクローンが引く乱数列をローカルで再現できる。
- **識別子の衝突。** セッション ID、UUID、`/proc/sys/kernel/random/boot_id` が全クローンで同じになる。

Firecracker のドキュメントはこれを、「強い仕組みなしに同じ状態から 2 回以上実行を再開することは insecure とみなす」と書いている。緩和策ではなく前提の問題として扱っている。

### VM Generation ID は「あなたは複製された」という 1 ビットの通知

対策として実装されているのが VMGenID デバイスだ。仕組みは単純である。

1. ゲスト物理メモリに 16 バイト（128bit）の領域を確保する。
2. そこに暗号論的に安全な乱数を書き、ACPI テーブルでその物理アドレスをゲストに教える。
3. **復元のたびに新しい値を書き直し、割り込みを注入する。**

```
  保存時のゲストメモリ           復元後のゲストメモリ
  ┌──────────────────┐         ┌──────────────────┐
  │ gen_id = 0x1a2b… │   ───▶  │ gen_id = 0x9f04… │  ← 新しい 128bit
  └──────────────────┘         └──────────────────┘
                                        │
                                    IRQ 注入（vCPU 再開より前）
                                        ▼
                          Linux 5.18+ : CSPRNG を強制再シード
```

値そのものは秘密ではない。ゲストのカーネルは「変わったかどうか」だけを見る。Linux 5.18 以降（ACPI システム）は VMGenID の変化を検出すると、その値をエントロピーとして混ぜたうえで **即座に再シードを強制する**。カーネルのコメントを random-for-clones.md が引用している。

```
/*
 * Handle a new unique VM ID, which is unique, not secret, so we
 * don't credit it, but we do immediately force a reseed after so
 * that it's used by the crng posthaste.
 */
```

エントロピーの量としてはカウントしない（`don't credit`）が、再シードのトリガーとしては使う、という扱いだ。これで `getrandom()` と `/dev/(u)random` が返す値はクローンごとに分岐する。

### 限界は 3 つあり、いずれもドキュメントに書かれている

**(1) カーネルが古いと何も起きない。** Firecracker は VMGenID を常に有効にするが、ドライバのないカーネルでは単なる未使用のメモリ領域になる。aarch64 は DeviceTree バインディングが必要で Linux 6.10 以降。Firecracker がサポートする最新カーネルは 6.1 なので、ARM で使うにはバックポートが要る。

**(2) ユーザ空間の独自エントロピープールは救われない。** 多くの暗号ライブラリはプロセス内に自前の DRBG を持ち、起動時に一度だけカーネルからシードを取る。カーネルが再シードしても、既にシード済みのプロセス内 DRBG は同じ状態のままだ。ドキュメントは「pre-snapshot のロジックでそれらを使わないことを推奨する以外に、現在のプログラミングモデルでは一般解がない」と書いている。同様に、カーネルのエントロピープール以外の状態（一意な識別子、キャッシュ済み乱数、暗号トークン）は**依然として複製される**。

**(3) vCPU 再開から再シード完了までにレース窓がある。** 割り込みは vCPU 再開の前に注入されるが、ゲストカーネルがそれを処理して再シードを終えるのは vCPU が動き出した後だ。その間に走るコードが乱数を引けば、古い状態の値を得る。ドキュメントは `This leaves a race window between resuming vCPUs and Linux CSPRNG getting successfully re-seeded.` と明記し、レースを完全に避けたいなら 5.18 以降でも旧来の手動再シード手順を踏むよう勧めている。

さらに、スナップショットをブートのごく初期（割り込み処理が整う前）に取ると、注入した割り込みをカーネルが処理できずクラッシュする可能性があるという注意もある。

### 追加の対策は利用者側にある

random-for-clones.md の Recommendations は、VMGenID だけに頼らない手順を並べている。

- `/var/lib/systemd/random-seed`（および同等のファイル）をスナップショット前に削除する。init システムがブート時に保存したシードがクローン全員で共有されるのを防ぐため。
- `/proc/sys/kernel/random/boot_id` は読み取り専用で全クローン同一になる。値を変えたいなら別ファイルを bind mount する。
- RDRAND / RDSEED を持つ CPU 上で動かす。`virtio-rng` も付ける。
- 顧客コードが動き出す前に、`RNDADDENTROPY` と `RNDRESEEDCRNG` の ioctl でプールを明示的に入れ替える（レース窓を潰す唯一の確実な方法）。この手順を起動するトリガーとして [VMClock の通知](../clock-restore/) が使える。

### virtio-rng と VMGenID は役割が違う

|              | VMGenID                      | virtio-rng（entropy デバイス） |
| ------------ | ---------------------------- | ------------------------------ |
| 何を届けるか | 「複製された」というイベント | ランダムバイトそのもの         |
| 起動側       | ホスト（復元時に 1 回）      | ゲスト（キューに要求を積む）   |
| 頻度         | 復元のたびに 1 回            | ゲストが要求する限り継続的     |
| ゲストの動作 | CSPRNG を強制再シード        | エントロピープールへ追加       |
| 制御可能性   | ホストが完全に制御           | ゲストがいつ要求するか不明     |

random-for-clones.md はこの差を端的に書いている。virtio-rng を付けても `we cannot control when the guest kernel will request for random bytes from the device` なので、復元直後に確実に再シードさせる手段にはならない。両者は代替ではなく、VMGenID が「イベント通知」、virtio-rng が「エントロピー供給」を担う補完関係にある。

## ソースコードのどこか

デバイスの定義。doc コメントが「新しい microVM が作られるたび、スクラッチからでもスナップショットからでも、値が変わる」と役割を述べている。

```rust title="src/vmm/src/devices/acpi/vmgenid.rs"
/// VMGenID is an emulated device which exposes to the guest a 128-bit cryptographically random
/// integer value which will be different every time the virtual machine executes from a different
/// configuration file. In Firecracker terms this translates to a different value every time a new
/// microVM is created, either from scratch or restored from a snapshot.
pub struct VmGenId {
    /// Current generation ID of guest VM
    pub gen_id: u128,
```

[`src/vmm/src/devices/acpi/vmgenid.rs#L34-L52`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/acpi/vmgenid.rs#L34-L52)

値の生成は `aws-lc-rs` の `rand::fill` で、失敗したら `expect` で落とす。ここで弱い乱数へフォールバックしない判断になっている。

```rust title="src/vmm/src/devices/acpi/vmgenid.rs"
    // Create a 16-bytes random number
    fn make_genid() -> u128 {
        let mut gen_id_bytes = [0u8; 16];
        rand::fill(&mut gen_id_bytes).expect("vmgenid: could not create new generation ID");
        u128::from_le_bytes(gen_id_bytes)
    }
```

[`src/vmm/src/devices/acpi/vmgenid.rs#L92-L97`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/acpi/vmgenid.rs#L92-L97)

**永続化される状態に `gen_id` が含まれていない** ことが、この設計の要点だ。保存されるのは GSI とゲスト物理アドレスだけで、`restore` は `from_parts` を呼ぶ。`from_parts` は内部で `make_genid()` を呼ぶので、復元すれば必ず新しい値になる。「復元のたびに変える」ことを、忘れうる手続きではなく型で保証している。

```rust title="src/vmm/src/devices/acpi/vmgenid.rs"
pub struct VMGenIDState {
    /// GSI used for VMGenID device
    pub gsi: u32,
    /// memory address of generation ID
    pub addr: u64,
}
...
    fn restore(_: Self::ConstructorArgs, state: &Self::State) -> Result<Self, Self::Error> {
        Self::from_parts(GuestAddress(state.addr), state.gsi)
    }
```

[`src/vmm/src/devices/acpi/vmgenid.rs#L127-L150`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/acpi/vmgenid.rs#L127-L150)

新しい値をゲストメモリへ書くのが `activate`、割り込みを上げるのが `do_post_restore`。復元パスではこの順に呼ばれる。

```rust title="src/vmm/src/device_manager/persist.rs"
        acpi_devices.replay_gsi_allocations(vm)?;

        acpi_devices.activate_vmgenid(vm)?;
        acpi_devices.do_post_restore_vmgenid()?;
```

[`src/vmm/src/device_manager/persist.rs#L200-L216`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/persist.rs#L200-L216)

ゲストへの見せ方は ACPI の AML デバイス `_SB_.VGEN` で、`_HID` は `VMGENCTR`、`ADDR` パッケージに物理アドレスを下位・上位 32bit に分けて入れる（[`src/vmm/src/devices/acpi/vmgenid.rs#L152-L171`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/acpi/vmgenid.rs#L152-L171)）。

復元パス全体での位置がコメントで説明されている。デバイスの復元は **KVM 状態の復元より後** でなければならない。

```rust title="src/vmm/src/builder.rs"
    // Restore devices states.
    // Restoring VMGenID injects an interrupt in the guest to notify it about the new generation
    // ID. As a result, we need to restore DeviceManager after restoring the KVM state, otherwise
    // the injected interrupt will be overwritten.
```

[`src/vmm/src/builder.rs#L497-L500`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L497-L500)

その後に `start_vcpus` が呼ばれ、vCPU は Paused 状態のスレッドとして起動する（[`src/vmm/src/builder.rs#L522-L529`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L522-L529)）。つまり割り込みの注入は確実に vCPU 再開より前になる。

比較のため virtio-rng 側。こちらはゲストがキューに空バッファを積んだときに初めて `handle_one` が走り、同じ `aws_lc_rs::rand::fill` でバイト列を作って書き戻す（[`src/vmm/src/devices/virtio/rng/device.rs#L118-L137`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/rng/device.rs#L118-L137)）。同じ乱数源を使っていても、駆動する側がホストかゲストかで役割が変わる。

## なぜそうなっているか

**「一意性が壊れる」ことを機能ではなく脅威として扱っている。** snapshot-support.md の "Snapshot security and uniqueness" は、同じ状態から 2 回以上再開する運用そのものを insecure と宣言し、そのうえで「secure な使い方」の例（スナップショットを取ったら元の VM は終了する）を示している。VMGenID は insecure な運用を secure にする道具ではなく、被害を減らす部分的な対策として位置づけられている。

**ドキュメントが VMGenID の効果を過大に書いていない。** snapshot-support.md はこう書く。

> State other than the guest kernel entropy pool, such as unique identifiers, cached random numbers, cryptographic tokens, etc **will** still be replicated across multiple microVMs resumed from the same snapshot. Users need to implement mechanisms for ensuring de-duplication of such state, where needed.
>
> — [docs/snapshotting/snapshot-support.md](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/snapshotting/snapshot-support.md#L615-L621)

「カーネルのエントロピープールだけは面倒を見る、それ以外は利用者の責任」という境界がはっきり引かれている。

**gen_id を保存しないのは、実装の性質から意図的だと読める。** 保存されるのはアドレスと GSI という「配置情報」だけで、値は毎回生成される。もし `gen_id` が状態に含まれていたら、`restore` のどこかで再生成を忘れる余地が生まれる。型に含めないことで、その分岐自体を消している。

**割り込みの注入順序は、KVM 状態の復元が pending interrupt を上書きするという事実から決まっている。** vCPU の LAPIC 状態や irqchip 状態を復元すると、その時点で保留されていた割り込みが保存時のものに置き換わる。だから VMGenID の割り込みは KVM 状態復元の後に注入しなければならない。ここは「デバイス復元とマシン状態復元の順序」が、単なるモジュール依存ではなく **割り込みの可視性** で決まっている例になっている。

## どう活かすか

**チェックポイント／リストアを持つシステムを設計するなら、「一意なはずの状態」の棚卸しを先にやる。** Firecracker の分類はそのまま流用できる。(a) カーネル／ランタイムのエントロピープール、(b) プロセス内 DRBG、(c) 生成済みの識別子とトークン、(d) 起動時に一度だけ決まる値（`boot_id`、インスタンス ID、ホスト名）。復元後に (a) だけを直しても、(b)(c)(d) は残る。

**「値ではなくイベントを届ける」設計は応用が利く。** VMGenID が届けるのはエントロピーではなく「あなたの状態は複製された」という事実だけで、実際の再シードはゲストが自分の信頼できる乱数源で行う。ホストがゲストに秘密を渡す必要がないので、ホストが乱数を握っていることによる新しい信頼関係が生まれない。ホストとゲストで信頼境界が分かれている構成では、この形は取りやすい。

**逆に、レース窓が許容できない場合はこの仕組みだけに頼れない。** 復元直後の数十マイクロ秒〜数ミリ秒に暗号処理が走る設計なら、VMGenID の非同期通知では間に合わない。Firecracker のドキュメントが 5.18 以降でも手動の `RNDRESEEDCRNG` を勧めているのはそのためだ。自分のシステムでも、「通知は届くが、届くまでに動くコードがある」ことを前提に、復元直後に何が実行されるかを制御できるか（＝顧客コードの再開を遅らせられるか）を確認する必要がある。

**前提条件は 3 つ。** (1) ゲストのカーネルが十分新しい、(2) スナップショットは起動完了後に取る、(3) クローンごとの一意性が必要なのはカーネル由来の乱数だけで、アプリケーション層の識別子は別途生成し直せる。マルチテナントで顧客がゲストイメージを持ち込む環境では (1) を保証できないので、ホスト側だけの対策では不十分になる。
