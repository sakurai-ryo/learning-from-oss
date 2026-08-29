---
title: "「作らない」を憲章に書く"
description: "CHARTER.md の Minimalist in Features は「ミッションに明確に必要でなければ作らない。1 機能につき実装は 1 つだけ持ち、古いものは廃止する」と書いている。i8042 がキーボードコントローラではなくリブート検出器としてしか実装されていないこと、DEPRECATED.md に並ぶ廃止済み機能、パケットフィルタを明示的な非目標にしていることから、その原則が実際に効いている様子を読む。"
group: "Firecracker のかたち"
sidebar:
  order: 10
---

## 何を学んだか

### 憲章に「作らない」が書いてある

リポジトリのルートに `CHARTER.md` がある。34 行しかない。ミッションが 1 文、tenet が 4 つ、貢献者と役割の説明が数行。その 4 つの tenet のうち 3 番目がこれである。

> **Minimalist in Features**: If it's not clearly required for our mission, we won't build it. We maintain a single implementation per capability, and deprecate obsolete implementations; resolving exceptions is a high priority issue.

この一文には 3 つの約束が入っている。

1. **ミッションに明確に必要でなければ作らない**
2. **1 つの capability につき実装は 1 つだけ維持する**
3. **古い実装は廃止する。例外の解消は高優先度の issue として扱う**

3 番目が効いている。「新旧の実装が並存している状態」自体をバグとして扱うと宣言している。一般的な OSS では「後方互換のために古い実装も残す」で終わりがちなところを、Firecracker は「それは解消すべき例外だ」と定義している。

ミッション自体も短い。

> Our mission is to enable secure, multi-tenant, minimal-overhead execution of container and function workloads.

「明確に必要か」の判定基準は、このミッション 1 行だけである。基準が短いほど、何かを削る判断が通しやすい。

### 「作らなかった」が形になった例：i8042

Firecracker がゲストに見せる legacy デバイスは、x86_64 でシリアルポートと i8042 の 2 つだけである。その i8042 は、キーボードコントローラとしては動かない。`docs/design.md` の Machine Model 節がこう書いている。

> It also exposes a serial console and partial keyboard controller, the latter being used by guests to reset the VM (either soft or hard reset). Within Firecracker, the purpose of the I8042 device is to signal the microVM that the guest has requested a reboot.

「partial keyboard controller」。ゲストが `reboot(2)` すると Linux は i8042 の port 0x64 に `0xFE`（CPU リセット）を書く。Firecracker が i8042 を実装しているのはこの 1 バイトを受け取るためだけで、キーボード入力は扱わない。実装の doc コメントもそう名乗っている。

デバイスを 1 つ作るかどうかの判断が、「reboot を検出する手段が他にないから最小限だけ作る」という形で残っている。

### 廃止された機能が列挙されている

ルートに `DEPRECATED.md` があり、廃止予定の機能が PR 番号付きで 9 個並んでいる。その中身を分類すると、tenet の 2 番目「1 capability につき 1 実装」がそのまま読める。

| 廃止されたもの                                                                         | 置き換え先                |
| -------------------------------------------------------------------------------------- | ------------------------- |
| MMDS v1                                                                                | MMDS v2                   |
| 静的 CPU テンプレート                                                                  | カスタム CPU テンプレート |
| `rebase-snap` ツール                                                                   | `snapshot-editor`         |
| MPTable ＋ カーネルコマンドラインによる virtio デバイス発見                            | ACPI                      |
| `seccompiler-bin` の `--basic`                                                         | （なし。単に廃止）        |
| `/vsock` の `vsock_id`、`/snapshot/load` の `mem_file_path` と `enable_diff_snapshots` | 不要になったフィールド    |
| `--start-time-cpu-us` / `--start-time-us`                                              | 不要になった CLI 引数     |

「同じことをする 2 通りのやり方」が現れるたびに、片方が DEPRECATED.md に載って消える予定が立つ。しかも `docs/RELEASE_POLICY.md` が「deprecated な要素は次のメジャーバージョンで**必ず削除される**」と書いているので、このリストは棚上げの置き場ではなく削除予定表として機能する。

### 明示的な非目標

「作らない」は、デバイスの取捨選択だけでなく、機能領域そのものにも及ぶ。`docs/design.md` の Threat Containment 節に、こう書かれている。

> Firecracker does not perform any network traffic filtering. All egress traffic from a guest is therefore considered untrusted, and should be filtered at the host-level.

Firecracker はパケットフィルタを持たない。持たないことを設計文書に書き、フィルタリングはホスト側の責務だと宣言している。virtio-net の実装があってレートリミッタまで入っているのだから、パケットの中身を見て落とす機能を足すのは技術的には難しくない。それでもやらない。VMM の中に L3/L4 のポリシーエンジンを抱えると、攻撃面が増え、実装が 1 つでは済まなくなる（誰かが必ず別のフィルタ機構を欲しがる）からだと読める。

同じ節の少し前には、Firecracker が持つ隔離の層が列挙されている。KVM の仮想化境界、seccomp、cgroup と namespace、jailer による権限剥奪。**自前で作るのは他に代えがきかないものだけで、既存のカーネル機構で足りるものはそれに任せる**という切り分けになっている。

## ソースコードのどこか

### 憲章

[`CHARTER.md#L20-L23`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/CHARTER.md#L20-L23) が Minimalist in Features の全文である。

```markdown title="CHARTER.md"
1. **Minimalist in Features**: If it's not clearly required for our mission, we
   won't build it. We maintain a single implementation per capability, and
   deprecate obsolete implementations; resolving exceptions is a high priority
   issue.
```

憲章の末尾（[`CHARTER.md#L27-L30`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/CHARTER.md#L27-L30)）で、この文書が飾りではないことが担保されている。

> All contributions must align with this charter and follow Firecracker's [contribution process](CONTRIBUTING.md).

`CONTRIBUTING.md` 側も冒頭でミッションを参照している（[`CONTRIBUTING.md#L1-L5`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/CONTRIBUTING.md#L1-L5)）。ただし `CONTRIBUTING.md` に書かれているのは、機能追加の可否そのものではなく**追加を通すためのコスト**である（[`CONTRIBUTING.md#L60-L110`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/CONTRIBUTING.md#L60-L110)）。

- maintainer 2 人以上の approve が必要
- 「Unit test coverage must _increase_ the overall project code coverage.」
- 「Include integration tests for any new functionality in your pull request.」
- 「**Usage of `unsafe` is heavily discouraged**」。使う場合は正当化とベンチマーク、および `clippy::undocumented_unsafe_blocks` に準拠した安全性の証明コメントが要る

「作らない」を憲章で宣言したうえで、作る場合のハードルを CONTRIBUTING で上げている。この 2 段構えになっている。

### i8042：リブート検出器としての実装

[`src/vmm/src/devices/legacy/i8042.rs#L93-L118`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/legacy/i8042.rs#L93-L118) の doc コメントが、この実装が何であるかを名乗っている。

```rust title="src/vmm/src/devices/legacy/i8042.rs"
/// A i8042 PS/2 controller that emulates just enough to shutdown the machine.
#[derive(Debug)]
pub struct I8042Device {
    /// CPU reset eventfd. We will set this event when the guest issues CMD_RESET_CPU.
    reset_evt: EventFd,
```

「マシンを落とすのにちょうど足りるだけをエミュレートする i8042 PS/2 コントローラ」。この構造体が持っているのは、リセット用の eventfd、キーボード割り込み用の eventfd、ステータス／コントロール／出力ポートの 3 レジスタ、そして 16 バイトの内部バッファだけである。

肝心の処理は `write` の 1 分岐に収まっている（[`src/vmm/src/devices/legacy/i8042.rs#L257-L267`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/legacy/i8042.rs#L257-L267)）。

```rust title="src/vmm/src/devices/legacy/i8042.rs"
match offset {
    OFS_STATUS if data[0] == CMD_RESET_CPU => {
        // The guest wants to assert the CPU reset line. We handle that by triggering
        // our exit event fd. Meaning Firecracker will be exiting as soon as the VMM
        // thread wakes up to handle this event.
        if let Err(err) = self.reset_evt.write(1) {
            error!("Failed to trigger i8042 reset event: {:?}", err);
            METRICS.error_count.inc();
        }
        METRICS.reset_count.inc();
    }
```

ゲストが port 0x64 に `0xFE` を書いたら eventfd を叩き、VMM スレッドがそれで起きて終了する。それだけである。

残りのコマンド（`CMD_READ_CTR` / `CMD_WRITE_CTR` / `CMD_READ_OUTP` / `CMD_WRITE_OUTP`）と、Ctrl+Alt+Del のスキャンコード注入（[`src/vmm/src/devices/legacy/i8042.rs#L136-L140`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/legacy/i8042.rs#L136-L140)）は実装されているが、これも「Linux のドライバがプローブ時に叩く分」と「ソフトリブート要求を送り込む分」に限られる。任意のキー入力を扱う経路はない。ソフトリブートは API の `SendCtrlAltDel` アクションから `Vmm::send_ctrl_alt_del()` を経由して注入される（[`src/vmm/src/lib.rs#L485-L497`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/lib.rs#L485-L497)）。

### rebase-snap：廃止が実行に至るまで

`DEPRECATED.md` に載っている `rebase-snap` は、まだバイナリとしてビルドされている（ワークスペースの `default-members` にも入っている）。ただし起動すると必ず警告を出す（[`src/rebase-snap/src/main.rs#L15-L16`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/rebase-snap/src/main.rs#L15-L16)）。

```rust title="src/rebase-snap/src/main.rs"
const DEPRECATION_MSG: &str = "This tool is deprecated and will be removed in the future. Please \
                               use 'snapshot-editor' instead.\n";
```

差分スナップショットのマージという 1 つの capability に対して、`rebase-snap` と `snapshot-editor` という 2 つの実装が並んでいる状態は、憲章の言う「exception」である。だから片方に廃止マークが付き、DEPRECATED.md に載り、次のメジャーリリースで消えることが決まっている。この状態遷移が仕組み化されているのが要点で、「そのうち消したいね」で放置されない。

### デバイス一覧が短いこと

`src/vmm/src/devices/` の下は `legacy/`（serial、i8042、aarch64 用の RTC）、`virtio/`、`pseudo/`（boot timer）、`acpi/`、`pci/` しかない。virtio 側も balloon、block、mem、net、pmem、rng、vsock の 7 種類である。汎用 VMM が持つ VGA、USB、SCSI、IDE、フロッピー、PCI パススルーの類は 1 つもない。

## なぜそうなっているか

### 攻撃面がそのままデバイス数に比例する

`docs/design.md` の Threat Containment 節が前提を置いている。

> From a security perspective, all vCPU threads are considered to be running malicious code as soon as they have been started

ゲストは悪意あるコードとして扱う。とすると、ゲストが触れる**デバイスエミュレーションのコードは全部が攻撃面**である。歴史的に VM の脱獄はデバイスエミュレーションのバグ経由が多い。デバイスを 1 つ足すたびに、パースすべきゲスト由来の入力が増える。

i8042 を「フルのキーボードコントローラ」として実装すれば、スキャンコードの変換テーブル、マルチプレクサ、AUX ポート、コマンドの状態機械が要る。それは全部ゲストが叩ける入力である。リブート検出しか要らないなら、`0xFE` を見る 1 分岐で済む。tenet 1（Built-In Security）と tenet 3（Minimalist in Features）が同じ方向を向いている。

### 起動時間とメモリオーバーヘッドにも効く

tenet 2 は「Light-Weight Virtualization」で、オーバーヘッドを測って無視できる水準に保つと書いている。これは[SPECIFICATION.md の数値](../specification-as-contract/)として具体化されている（VMM スレッドのメモリオーバーヘッド 5 MiB 以下、InstanceStart から `/sbin/init` まで 125 ms 以下）。

デバイスを 1 つ足すと、その構造体のメモリ、eventfd と epoll エントリ、ACPI テーブルへの記述、ゲストカーネルのドライバプローブ時間が全部乗る。5 MiB という予算があると、「あると便利」程度の機能を足す判断が自動的に難しくなる。数値目標が feature の門番として働いている。

### 1 実装しか持たないと、テストとスナップショットが破綻しない

実装が 2 つあると、テストマトリクスが 2 倍になる。Firecracker の場合はさらに悪くて、**スナップショットの互換性**が絡む。ある機能に実装が 2 つあれば、スナップショットの状態表現も 2 種類になり、復元時に両方を扱わなければならない。[スナップショットのバージョニング](../snapshot-versioning/)は Firecracker が最も慎重に扱っている領域で、ここに分岐を増やさないことに実利がある。

MMDS v1 と v2、静的テンプレートとカスタムテンプレートが片方ずつ廃止されているのは、この観点でも説明がつく。

### 「やらない」と書くことの効用

パケットフィルタの件は、単に「まだ実装していない」ではなく「やらない」と書いてある点が違う。設計文書に非目標として明記されていると、

- 利用者は「いつか入るかも」と待たずに、ホスト側で対策する
- 貢献者は提案する前に方針を知れる
- レビュワーは個別の是非を議論せずに済む

「機能要望を断る」というコミュニケーションコストを、文書を書いた 1 回分に圧縮している。これは技術的な設計ではなくプロジェクト運営の設計だが、コードベースの形を確実に規定している。

## どう活かすか

**「作らないもの」を書いた文書を、コードと同じリポジトリに置く**のが一番真似しやすい。README に機能一覧を書くプロジェクトは多いが、非目標を書くプロジェクトは少ない。Firecracker は `CHARTER.md`（34 行）と `docs/design.md` の非目標記述で、「これは我々の仕事ではない」を明示している。長い必要はない。判断基準が 1 行のミッションと 4 つの tenet に収まっているからこそ、個別の判断で参照される。

**「1 capability につき 1 実装」を、例外を許さないルールではなく解消期限付きの例外として運用する**という形も持ち帰れる。実装の置き換えは瞬間的にはできないので、新旧が並ぶ期間は必ず生じる。Firecracker はその期間を「高優先度の issue」と定義し、DEPRECATED.md というリストと「次のメジャーで削除」というリリースポリシーで期限を付けている。deprecation の宣言だけして削除しないと、リストは負債の目録になる。削除の期限が仕組みで決まっていることが肝心である。

**必要最小限だけをエミュレートする**という発想は、外部プロトコルやフォーマットを扱うコードに広く効く。「i8042 を実装する」ではなく「reboot 要求を検出する」と要求を定義し直すと、書くコードが 1/10 になる。ただし、これは**利用者側の実装が既知で固定されている**ときにだけ成立する。Firecracker は「Linux ゲストが `reboot(2)` でどう振る舞うか」を知っているから最小実装で済んでいる。任意のゲスト OS を動かす汎用 VMM ではこの近道は取れない。実際、Firecracker は[サポートするゲストカーネルのバージョンを明示](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/kernel-policy.md)することで、この前提を保っている。

逆に、**取り込むべきでない場面**もはっきりしている。利用者の使い方が読めないライブラリや、汎用性そのものが価値になるプロダクトでは、「明確に必要でなければ作らない」は機能不足として跳ね返る。この原則が効くのは、Firecracker のように利用者と用途が絞れていて、かつ攻撃面や性能予算のような「機能を足すと確実に悪化する指標」が定義されている場合である。指標がないと、「作らない」は単なる怠慢と区別がつかない。
