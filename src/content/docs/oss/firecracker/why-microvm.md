---
title: "なぜ microVM が必要になったのか"
description: "コンテナの分離境界は namespace と cgroup と seccomp でできていて、カーネルはホストと共有されている。この共有カーネルがマルチテナントでは弱点になる。一方で従来の VM は起動が遅く重い。Firecracker は「VM の分離境界を持ったまま 125ms で起動し、VMM のメモリオーバーヘッドを 5MiB に収める」という要求から生まれた。"
group: "仮想化と KVM をゼロから"
sidebar:
  order: 1
---

## コンテナが持っている分離境界

Linux のコンテナは、新しい実行形態ではない。ふつうのプロセスに、カーネルが提供する 3 種類の制限をかけたものだ。

- **namespace**: プロセスから見える「名前空間」を切り替える。PID namespace なら他のプロセスが見えなくなり、mount namespace なら別のファイルシステムツリーが見える。
- **cgroup**: CPU 時間、メモリ、I/O 帯域といった資源の使用量に上限をかける。
- **seccomp**: そのプロセスが発行できるシステムコールを絞り込む。

重要なのは、これらが全部**同じカーネルの中の機能**だという点だ。コンテナの中で `open(2)` を呼べば、ホストと同じカーネルの同じ `sys_open` に飛び込む。

```
        コンテナ A          コンテナ B
       +-----------+      +-----------+
       | プロセス  |      | プロセス  |
       +-----------+      +-----------+
             |                  |
     syscall |          syscall |
             v                  v
    +-------------------------------------+
    |   ホストの Linux カーネル (1 つ)    |  <- 分離の境界はこの中の
    |   namespace / cgroup / seccomp      |     チェックコードでできている
    +-------------------------------------+
    +-------------------------------------+
    |            ハードウェア             |
    +-------------------------------------+
```

分離の実体は、カーネルコードの中に散らばった「このプロセスはこの namespace に属しているから、この資源は見せない」という判定の集合だ。判定の数だけ、判定を間違える可能性がある。

## マルチテナントで何が怖いのか

自社のサービスだけをコンテナで動かしているなら、この構造で困ることは少ない。困るのは、**互いに信頼していない第三者のコードを、同じホストの上で動かす**場合だ。AWS Lambda や Fargate はまさにこれをやっている。任意の顧客が書いた任意のコードを、ホストを共有しながら実行する。

このとき、カーネルの脆弱性 1 つが致命傷になる。攻撃者はコンテナの中から数百万行のカーネルコードのうち、seccomp で許されたシステムコールの範囲を突く。1 箇所で権限昇格が成立すれば、そのホストで動いている全テナントのデータに手が届く。分離境界が「カーネル内の判定コード」でできている以上、攻撃面はカーネルの攻撃面そのものになる。

Firecracker の CHARTER.md は、この状況を「顧客のワークロードは神聖（触ってはならない）であると同時に悪意あるもの（防御対象）とみなす」と表現している。

```markdown title="CHARTER.md"
1. **Built-In Security**: We provide compute security barriers that enable
   multi-tenant workloads, and cannot be mistakenly disabled by customers.
   Customer workloads are simultaneously considered sacred (shall not be
   touched) and malicious (shall be defended against).
```

[`CHARTER.md#L12-L16`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/CHARTER.md#L12-L16)

「同時に」という言い方がこの文書の主張の核で、顧客コードを守りながら、顧客コードから守る、という二重の立場を明示している。

## VM が持っている分離境界

仮想マシン（VM）の分離境界は、まったく別の場所にある。

```
        VM A                    VM B
   +-------------+        +-------------+
   | ゲスト      |        | ゲスト      |
   | プロセス    |        | プロセス    |
   +-------------+        +-------------+
   | ゲスト      |        | ゲスト      |
   | カーネル A  |        | カーネル B  |  <- カーネルが VM ごとに別物
   +-------------+        +-------------+
         |                      |
         |  VM exit             |  VM exit
         v                      v
   +---------------------------------------+
   |  ハードウェア (VT-x / EPT)            |  <- 分離の境界はここ
   +---------------------------------------+
   |  ホストカーネル (KVM) + VMM プロセス  |
   +---------------------------------------+
```

ゲストの中で `open(2)` を呼んでも、ホストカーネルには届かない。ゲストカーネルの中で完結する。ゲストが特権命令を実行しようとした瞬間、CPU がそれを止めてホスト側に制御を返す（これを VM exit と呼ぶ。詳しくは[次のページ](../hardware-virtualization/)）。

つまり、**分離の一次的な担い手がソフトウェアからハードウェアに移る**。ゲストカーネルに脆弱性があっても、破れるのはそのゲスト 1 つだけで、ホストには届かない。ホストに届かせるには、CPU の仮想化機構そのものか、VMM が公開している狭い口（デバイスエミュレーションと KVM の ioctl）を突破する必要がある。

このモデルには副次的な利点もある。ゲストがカーネルを丸ごと持つので、ホストカーネルとバージョンが違ってよい。ゲスト側で好きなカーネルモジュールをロードしてもホストには影響しない。

## 従来の VM の何が高いのか

では最初から全部 VM にすればいい、とはならなかった。理由は 2 つある。

**起動が遅い。** 一般的な VM は、実機を忠実に模倣する。BIOS/UEFI ファームウェアが動き、PCI バスを列挙し、ブートローダを読み、そこから OS が起動する。この一連の流れは秒単位かかる。関数が呼ばれてから 100ms で応答したいサービスにとって、これは使えない。

**メモリオーバーヘッドが大きい。** VMM プロセス自体が、エミュレートするデバイスの数だけ状態を持つ。ゲストに割り当てたメモリとは別に、VMM が数十〜数百 MiB を消費する。1 ホストに数千の VM を詰め込みたい場合、この定数コストが密度の天井を決めてしまう。

コンテナはこの 2 つがほぼゼロだ。`fork` + `exec` に namespace の設定が乗るだけで、起動は数ミリ秒、追加のメモリは実質ない。

```
              分離の強さ          起動時間        オーバーヘッド
コンテナ      弱い(共有カーネル)   数 ms          ほぼ 0
従来の VM     強い(HW)             数 秒          数十〜数百 MiB
              ------------------------------------------------
microVM       強い(HW)             ~125 ms        <= 5 MiB
```

**「VM の分離とコンテナの速度を両方取る」** という要求が microVM を生んだ。

## 何を削ったのか

microVM が速く軽い理由は、新しい仮想化技術を発明したからではない。**やることを減らした**からだ。

Firecracker の FAQ は、QEMU との違いをこう説明している。

```markdown title="FAQ.md"
Firecracker is an
[alternative to QEMU](...)
that is purpose-built for running serverless functions and containers safely and
efficiently, and nothing more. Firecracker is written in Rust, provides a
minimal required device model to the guest operating system while excluding
non-essential functionality (only 6 emulated devices are available: virtio-net,
virtio-balloon, virtio-block, virtio-vsock, serial console, and a minimal
keyboard controller used only to stop the microVM). This, along with a
streamlined kernel loading process enables a < 125 ms startup time and a < 5 MiB
memory footprint.
```

[`FAQ.md#L53-L66`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/FAQ.md#L53-L66)

QEMU は、実機に近い環境を提供するための汎用エミュレータだ。IDE コントローラ、各種 NIC、サウンドカード、USB、VGA、フロッピー、複数の CPU アーキテクチャのエミュレーション、それに BIOS/UEFI 対応がある。それは QEMU が「あらゆるゲスト OS を動かす」ことを目指しているからで、その汎用性のために巨大なコードベースを抱える。

Firecracker は逆を行く。動かす対象を「Linux ゲストの、サーバレス／コンテナワークロード」に絞り込み、そこに要らないものを一切作らない。Firecracker のソースツリーは Rust で約 12 万行（テストコード込み、`find src -name '*.rs' | xargs wc -l` で確認）で、これは VMM としてはかなり小さい部類に入る。行数が小さいこと自体が目的ではなく、**攻撃面が小さいことと、起動時にやるべき仕事が少ないこと**が目的だ。

FAQ の言う「6 デバイス」は執筆時点の記述で、現在のツリーには virtio デバイスとして balloon / block / mem / net / pmem / rng / vsock が入っている。それでも、レガシーデバイス（PIO 経由でゲストから見えるデバイス）が 2 つしかない点は変わっていない。

```rust title="src/vmm/src/device_manager/legacy.rs"
/// The `PortIODeviceManager` is a wrapper that is used for registering legacy devices
/// on an I/O Bus. It currently manages the uart and i8042 devices.
#[derive(Debug)]
pub struct PortIODeviceManager {
    // BusDevice::Serial
    pub stdio_serial: Arc<Mutex<SerialDevice>>,
    // BusDevice::I8042Device
    pub i8042: Arc<Mutex<I8042Device>>,
}
```

[`src/vmm/src/device_manager/legacy.rs#L27-L35`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/legacy.rs#L27-L35)

シリアルポート（コンソール出力用）と i8042（キーボードコントローラ）だけだ。しかも i8042 は、キーボード入力を扱うためではない。ゲストが `reboot` したときにリセットラインを叩くのを検知して、Firecracker プロセスを終了させるためだけに存在する。docs/design.md にそう書いてある。

> Within Firecracker, the purpose of the I8042 device is to signal the microVM that the guest has requested a reboot.

## 数値目標が契約になっている

「速い」「軽い」は主観になりがちだが、Firecracker はこれを数値で固定し、CI で継続的に検証している。SPECIFICATION.md がその文書だ。

```markdown title="SPECIFICATION.md"
1. **Overhead:** For a Firecracker virtual machine manager running a microVM
   with `1 CPUs and 128 MiB of RAM`, and a guest OS with the Firecracker-tuned
   kernel:
   - Firecracker's virtual machine manager threads have a memory overhead
     `<= 5 MiB`.
     ...
   - It takes `<= 125 ms` to go from receiving the Firecracker InstanceStart API
     call to the start of the Linux guest user-space `/sbin/init` process.
```

[`SPECIFICATION.md#L24-L42`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/SPECIFICATION.md#L24-L42)

この 2 つの数字が、この章で読むコードのほぼすべての設計判断の背景にある。

- **VMM オーバーヘッド <= 5MiB** だから、デバイスを増やせない。バッファを大きく取れない。起動時に確保するデータ構造を最小にしたい。
- **InstanceStart から /sbin/init まで 125ms** だから、BIOS を通せない。PCI バスの列挙をやりたくない（後で見る [MMIO vs PCI](../mmio-vs-pci/) の話につながる）。カーネルをそのままメモリに置いて直接エントリポイントに飛ぶ（[direct-kernel-boot](../direct-kernel-boot/)）。

しかも、これらはドキュメント上の努力目標ではない。SPECIFICATION.md は冒頭で「これらの仕様は結合テストによって強制される（PR ごと、および main へのマージごとに実行される）」と宣言している。数値がリグレッションすれば CI が落ちる。仕様が契約になっている、という話は [specification-as-contract](../specification-as-contract/) で改めて扱う。

## プロセス構造

もう 1 つ、コンテナとの対比で押さえておきたい構造がある。docs/design.md の Internal Architecture 節だ。

> Each Firecracker process encapsulates one and only one microVM. The process runs the following threads: API, VMM and vCPU(s).

[`docs/design.md#L71-L79`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/design.md#L71-L79)

1 プロセス = 1 microVM。プロセスの中には API スレッド、VMM スレッド、そして vCPU 数だけの vCPU スレッドがある。vCPU スレッドは KVM が作り、`KVM_RUN` のループを回す。この「KVM_RUN のループ」がこの章の中心で、[kvm-run-loop](../kvm-run-loop/) で詳しく見る。

そして同じ docs/design.md は、脅威モデルをこう置いている。

> From a security perspective, all vCPU threads are considered to be running malicious code as soon as they have been started

[`docs/design.md#L83-L85`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/design.md#L83-L85)

vCPU スレッドは、起動した瞬間から悪意あるコードを実行しているとみなす。だから vCPU スレッドと VMM スレッドには別々の seccomp フィルタがかかる（[per-thread-seccomp](../per-thread-seccomp/)）。「1 プロセスに 1 VM」という単純な構造は、この脅威モデルを扱いやすくするための選択でもある。プロセスが VM の生存期間そのものなので、プロセスを殺せば VM は消える。ホスト側から見た資源管理の単位が、cgroup とも namespace とも綺麗に一致する。

## この先で扱うこと

ここまでで押さえた語彙を並べておく。以降のページはこれを前提に進む。

| 語彙    | 意味                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------- |
| ゲスト  | VM の中で動く OS とアプリケーション                                                             |
| ホスト  | VM を動かしている側の Linux                                                                     |
| VMM     | Virtual Machine Monitor。ゲストの面倒を見るホスト側のユーザースペースプロセス。Firecracker 本体 |
| microVM | デバイスを最小限に絞り、起動を速くした VM                                                       |
| VM exit | ゲストの実行が中断され、制御がホスト側に戻ること                                                |
| vCPU    | ゲストから見た CPU。ホストでは 1 スレッド                                                       |

次のページ（[ハードウェアがやるのは「特権命令を止める」ことだけ](../hardware-virtualization/)）では、そもそも CPU がどうやってゲストを閉じ込めているのかを見る。ここが分かると、KVM が何を担当し、Firecracker が何を担当するのかの線引きが自然に見えるようになる。
