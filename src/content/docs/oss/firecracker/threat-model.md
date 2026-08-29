---
title: "vCPU スレッドは、起動した瞬間から悪意あるコードを実行している"
description: "Firecracker の脅威モデルを docs/design.md の Threat Containment 節と CHARTER.md から読み解く。顧客のワークロードを「神聖かつ悪意あり」と扱う前提、KVM / seccomp / cgroup / jailer という多層の障壁、そして明示的な非目標（ネットワークフィルタリングをしない、ホスト側の設定は運用者の責任）を整理する。"
group: "隔離とセキュリティ"
sidebar:
  order: 51
---

## 何を学んだか

### 前提は「すべての vCPU スレッドは悪意あるコードを実行中である」

Firecracker の設計文書は、脅威モデルの出発点を 1 文で言い切っている。

> From a security perspective, all vCPU threads are considered to be running malicious code as soon as they have been started; these malicious threads need to be contained.

「ゲストが侵害されたら」ではない。vCPU スレッドが `KVM_RUN` に入った瞬間から、そのスレッドは敵だとみなす。この前提を採ると、設計上の問いが「ゲストを守るには」ではなく「ゲストから VMM を守るには」「VMM が破られたときホストを守るには」に変わる。

さらに `CHARTER.md` は、この前提を逆説の形で書いている。

> Customer workloads are simultaneously considered sacred (shall not be touched) and malicious (shall be defended against).

顧客のワークロードは同時に 2 つの性質を持つ。**神聖**（VMM は中身を覗いてはならないし、勝手に変えてもならない）であり、かつ**悪意がある**（VMM は自分を守らなければならない）。この 2 つは緊張関係にある。ゲストの挙動を監視して不審なら止める、というアプローチは「神聖」に反するので採れない。だから Firecracker は「見て判断する」防御ではなく、「そもそも到達できない」防御だけを積み上げる。

### 信頼ゾーンは入れ子になっている

design.md は containment を「信頼度の異なるゾーンを入れ子にし、その境界に障壁を置くこと」と説明する。

```
┌─ ホストカーネル / ホストの他のプロセス（最も信頼される）───────────┐
│  ┌─ jailer が作った箱 ─────────────────────────────────────┐   │
│  │   pivot_root / mount ns / netns / PID ns / cgroup         │   │
│  │   非特権 uid:gid / setrlimit                               │   │
│  │  ┌─ Firecracker プロセス（1 プロセス = 1 microVM）─────┐  │   │
│  │  │   seccomp フィルタ（api / vmm / vcpu で別々）        │  │   │
│  │  │  ┌─ KVM の VM 境界 ───────────────────────────┐  │  │   │
│  │  │  │   ゲスト（最も信頼されない）                  │  │  │   │
│  │  │  │   ゲスト Linux カーネル + 顧客のワークロード    │  │  │   │
│  │  │  └──────────────────────────────────────────┘  │  │   │
│  │  └─────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

各境界が何を止めるかは役割がはっきり分かれている。

| 境界                           | 実装                                                                                                                          | 破られたときに次に効くもの         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| ゲスト → VMM                   | KVM（EPT / VMCS）。ゲストのメモリアクセスと特権命令はハードウェアで捕まえられ、MMIO / PIO は VMEXIT として Firecracker に届く | seccomp                            |
| VMM → ホストカーネル           | スレッドカテゴリごとの seccomp-BPF allowlist                                                                                  | jailer の chroot / namespace / uid |
| VMM → ホストのファイルシステム | jailer の `pivot_root` + 非特権 uid:gid。jail の外のファイルはパス名で辿れない                                                | cgroup / rlimit                    |
| VMM → ホストの資源             | cgroup（cpuset / cpu / memory / blkio）と `setrlimit`（`fsize` / `no-file`）                                                  | ホスト側の監視                     |
| ゲスト → ネットワーク          | **何もしない**（後述）                                                                                                        | ホスト側の nft / iptables          |

「1 プロセス = 1 microVM」という[アーキテクチャ](../architecture/)の決定は、この表の 2 行目以降を成立させるための前提でもある。プロセス境界がテナント境界と一致しているから、プロセス単位の隔離手段（seccomp、cgroup、uid）がそのままテナント隔離として機能する。prod-host-setup.md はこれを明示的に要求していて、「Firecracker が提供するのは異なる Firecracker プロセスで動く microVM 間の隔離境界であり、1 プロセスが 1 テナントのワークロードに対応することを強く推奨する」と書いている。

### 明示的な非目標が 2 つある

脅威モデルの価値は、守る範囲より守らない範囲をはっきりさせることにある。Firecracker が「やらない」と明言しているものが 2 つある。

**1. ネットワークトラフィックのフィルタリングをしない。**

> Firecracker does not perform any network traffic filtering. All egress traffic from a guest is therefore considered untrusted, and should be filtered at the host-level.

VMM がやるのはエミュレートした NIC からホストの TAP デバイスへのコピーと、そこに適用するレートリミットだけである。パケットの中身は見ない。したがってゲストが `169.254.169.254`（ホストの IMDS）宛にパケットを投げるのを止めるのは、Firecracker ではなくホスト側のファイアウォールの仕事になる。prod-host-setup.md はそのルールを直接載せている。

**2. 本番ビルドではシリアルコンソール出力を出さない。**

> In production builds, Firecracker does not expose the serial console port, since it may contain guest data that the host should not see.

これは「神聖」の側の要請である。シリアルコンソールにはゲストの出力がそのまま流れるので、ホスト側のログに顧客のデータが混ざる。加えて、ゲストが無制限に書き込めばホストのストレージやメモリを食い潰せるという可用性の問題もある（prod-host-setup.md の 8250 Serial Device 節は、ゲストの起動引数に `8250.nr_uarts=0` を付けることを推奨している）。

### 「ホスト側でやってくれ」のリスト

prod-host-setup.md は、Firecracker 自身では担保できず運用者に委ねている項目を列挙している。要点だけ抜き出すと次のとおり。

- **Firecracker の設定**: `--no-seccomp` と `--seccomp-filter` を本番で使わない。ログの出力先は上限のある保存先（`logrotate`、リングバッファ、名前付きパイプ）にする。
- **シグナルハンドラのデッドロック対策**: Firecracker のシグナルハンドラは非同期シグナルセーフではない（ログとメトリクスがロックを取る）。デッドロックしたプロセスを見つけて `SIGKILL` する監視プロセスをホスト側に置け、と書かれている。
- **jailer の設定**: `--exec-file` / `--chroot-base-dir` / `--netns` とその親ディレクトリを非特権ユーザから書けないようにする。microVM ごとに専用の非特権 uid:gid を作る。cgroup と `--resource-limit` で資源を縛る。
- **egress フィルタ**: `nft` か `iptables-nft` でゲストからの発信を絞る。
- **サイドチャネル対策**: SMT を無効にする。KSM（Kernel Samepage Merging）を無効にする。Rowhammer 対策（TRR + ECC）付きのメモリを使う。マイクロコードを最新に保つ。swap を無効にするか安全な swap を使う（ゲストメモリがディスクに残る問題）。
- **kvm-pit の CPU オーバーヘッド**: ゲスト起動後にカーネルが作る `kvm-pit/<pid>` スレッドは root cgroup に属する。Firecracker はその時点ですでに権限を落としているので自分では移動できない。外部エージェントで microVM の cgroup に移せ、と書かれている。

最後の項目は権限降格の帰結として示唆的である。権限を落としたあとにカーネルが作ったスレッドは、権限を落とした本人には触れない。必然的に外部の特権プロセスの仕事になる。

## ソースコードのどこか

脅威モデルそのものは 2 つのドキュメントに書かれている。

[`docs/design.md#L81-L97`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/design.md#L81-L97) の Threat Containment 節が中核である。

```md title="docs/design.md"
Containment is achieved by nesting several trust zones which
increment from least trusted or least safe (guest vCPU threads) to most trusted
or safest (host). These trusted zones are separated by barriers that enforce
aspects of Firecracker security.
```

「入れ子の信頼ゾーン」「境界に置かれた障壁」という語彙はここが出典である。同じ節の末尾でネットワークフィルタリングの非目標が宣言される。

[`CHARTER.md#L12-L16`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/CHARTER.md#L12-L16) は、なぜそこまでするのかを示す。

```md title="CHARTER.md"
1. **Built-In Security**: We provide compute security barriers that enable
   multi-tenant workloads, and cannot be mistakenly disabled by customers.
   Customer workloads are simultaneously considered sacred (shall not be
   touched) and malicious (shall be defended against).
```

`cannot be mistakenly disabled by customers`（顧客が誤って無効化できない）という条件が、あとで見る「seccomp フィルタをバイナリに埋め込む」「各スレッドが自分で適用する」といった実装上の選択に効いてくる。

障壁の一覧は [`docs/design.md#L152-L175`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/design.md#L152-L175) の Sandboxing 節にある。

```md title="docs/design.md"
This is achieved by the following: seccomp
filters for disallowing unwanted system calls, cgroups and namespaces for
resource isolation, and dropping privileges by jailing the process. Seccomp
filters are automatically installed by Firecracker, while for the latter, we
recommend starting Firecracker with the `jailer` binary that's part of each
Firecracker release.
```

`automatically installed` と `we recommend` の対比に注意したい。seccomp は Firecracker が自分で必ず入れる。jailer は「推奨」であって強制ではない。この違いは、それぞれの障壁の実装可能性から来ている。seccomp は自分自身に課すものなので Firecracker 単独で完結するが、chroot や cgroup の構築には root 権限が要るので Firecracker 本体には持たせられない。

シリアルコンソールの扱いは [`docs/design.md#L196-L203`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/design.md#L196-L203) にある。

ホスト側への要求は [`docs/prod-host-setup.md`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/prod-host-setup.md) が全編にわたって列挙している。冒頭 [`#L1-L9`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/prod-host-setup.md#L1-L9) の宣言が調子を決めている。

```md title="docs/prod-host-setup.md"
Security guarantees and defense in depth can only be upheld, if the following
list of recommendations are implemented in production.
```

「以下を実施しない限り、セキュリティ保証と多層防御は成立しない」。ハードウェア脆弱性の節 [`#L288-L307`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/prod-host-setup.md#L288-L307) はさらに直截で、`Firecracker is not able to mitigate host's hardware vulnerabilities.` と CAUTION ブロックで宣言している。

## なぜそうなっているか

**「悪意がある」と決め打つと、設計が単純になる。** ゲストの信頼度を条件付きで扱うと、「この操作は信頼できるゲストなら許す」といった分岐が VMM に入り込む。分岐が増えれば、それを誤らせる攻撃が生まれる。最初から全部敵だとみなせば、境界の実装は一律の allowlist になり、レビューできる大きさに収まる。x86_64 の seccomp ポリシーで vcpu スレッドに許されているルールは 50 個しかない。

**「神聖」と決め打つと、防御の手段が絞られる。** ゲストのメモリを走査する、実行内容を検査する、といった手段は最初から選択肢に入らない。残るのは構造的な隔離だけになる。CHARTER の 2 つの形容詞は、片方が防御の必要性を、もう片方が防御の手段を規定している。

**多層にする理由は、各層の破られ方が違うからである。** KVM の境界はハードウェアとカーネルの仮想化コードに、seccomp は syscall エントリに、chroot はパス解決に、cgroup はスケジューラとメモリ管理に依存する。ひとつの層に脆弱性が出ても、残りの層は独立に効く。design.md が「defense in depth」と呼んでいるのはこの独立性のことである。

**非目標を明示するのは、責任境界を確定させるためである。** 「ネットワークをフィルタしない」と書いていなければ、運用者は「VMM が何かやってくれているはずだ」と誤解しうる。誤解された防御は、存在しない防御より悪い。prod-host-setup.md がホスト側の設定を延々と列挙しているのも同じ理由で、Firecracker が担保する範囲と担保しない範囲を分けている。

**ホスト側の要求が多いのは、VMM の権限が小さいからである。** SMT の無効化、KSM の無効化、マイクロコードの更新、swap の無効化はどれもシステム全体の設定で、非特権プロセスには変更できない。自分でやろうとすれば特権が必要になり、その特権自体が攻撃面になる。「できることだけやり、できないことは要求として書く」という分担である。

## どう活かすか

**脅威モデルを 1 文で書けるか試す。** Firecracker のそれは「vCPU スレッドは起動した瞬間から悪意あるコードを実行している」である。この 1 文があるから、実装の是非を「これは前提と整合するか」で判定できる。自分のシステムでも、信頼できない入力が具体的にどのスレッド・どの関数から入ってくるかを 1 文で書けるなら、防御の置き場所は自然に決まる。書けないなら、防御の置き場所も決められていない。

**「触ってはならない」と「守らなければならない」を分けて書く。** 多くのシステムで、この 2 つは同じデータに対して同時に成り立つ。ユーザがアップロードしたファイル、テナントのデータベース、外部からの JSON。中身を見て判断する防御（バリデーション、サニタイズ）と、中身を見ずに隔離する防御（サンドボックス、権限分離）は別物で、前者しかないシステムは「神聖」の要請が入った瞬間に破綻する。

**層ごとに「破られたときに次に効くもの」を書き出す。** 本ページの表の右列がそれである。右列が空の層があれば、そこは単層防御になっている。

**非目標をドキュメントに書く。** 「やらないこと」を書いていないシステムは、暗黙に「たぶんやってくれる」と期待される。Firecracker の `does not perform any network traffic filtering` は 1 文だが、この 1 文があるから運用者は自分で `nft` のルールを書く。

**適用条件を見誤らない。** この規模の多層防御が正当化されるのは、(1) 相互に信頼しないテナントのコードを同じホストで動かす、(2) ゲストは任意コードを実行できる、(3) 1 プロセス = 1 テナントに揃えられる、という 3 条件がそろうときである。信頼できるコードしか動かさない社内サービスに seccomp allowlist と chroot を積むと、運用コストだけが増えて防御の利得がほとんどない。一方、条件 (3) が崩れる設計——1 プロセスで複数テナントを処理する——を採ると、プロセス単位の隔離手段が全部使えなくなる。

この群の残りのページでは、表に挙げた障壁の実装を順に見ていく。[jailer が chroot に至るまでの手順](../jailer/)、[実行ファイルをコピーする理由](../jailer-binary-copy/)、[seccomp フィルタの生成と埋め込み](../seccompiler/)、[スレッドごとの適用タイミング](../per-thread-seccomp/)、[違反が起きたときの通知](../sigsys-handler/)。
