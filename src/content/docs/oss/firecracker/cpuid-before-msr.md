---
title: "CPUID を先に確定させないと、正しい MSR が取れない"
description: "KVM_GET_MSRS が返す値は、その vCPU に KVM_SET_CPUID2 で設定済みの CPUID に依存する。CPUID が未設定だと、本来サポートされているはずの MSR にゼロが返る。Firecracker はこの暗黙の依存を configure_vcpus_for_boot の doc コメントに 6 段階の順序として書き出している。"
group: "KVM をどう叩くか"
sidebar:
  order: 18
---

## 何を学んだか

### KVM の状態には「読む前に書かないといけない」ものがある

vCPU をブート可能な状態にするには、CPUID と MSR の両方を設定する必要がある。

- **CPUID** — ゲストから見える CPU の機能一覧。`cpuid` 命令の戻り値を KVM に教える（`KVM_SET_CPUID2`）
- **MSR（Model Specific Register）** — CPU の設定レジスタ群。`SYSCALL` の飛び先や MTRR の既定値などが入る（`KVM_GET_MSRS` / `KVM_SET_MSRS`）

この 2 つは独立に見える。だが KVM の側では**依存がある**。**`KVM_GET_MSRS` が返す値は、その vCPU に設定済みの CPUID に依存する。** CPUID 上でその機能が無効なら、対応する MSR の値としてゼロが返る。

したがって「MSR の現在値を読んで、テンプレートで加工して、書き戻す」という処理は、**CPUID を設定した後でなければ正しい結果にならない。** 順序を間違えても ioctl はエラーを返さない。ゼロが返るだけである。

### Firecracker の 6 段階

`configure_vcpus_for_boot` の doc コメントが、この依存関係と順序を明文化している。

```
1. CPUID にテンプレートの modifier を適用する
2. KVM_SET_CPUID2 で各 vCPU に正規化済み CPUID を設定する   <- ここが先
3. vCPU 0 から KVM_GET_MSRS で CPUID 依存の MSR を読む      <- ここが後
4. MSR にテンプレートの modifier を適用する
5. Linux ブート用 MSR を足し、スナップショット用の記録を更新する
6. KVM_SET_MSRS で各 vCPU に MSR を設定する
```

実装は 4 つのフェーズに分かれるが、**フェーズ 2 と 3 の間の壁が本質**である。2 が全 vCPU に対するループ、3 が vCPU 0 だけへの問い合わせになっているのは、**全 vCPU の CPUID を設定し終えてからでないと読めない**（正確には、読む対象の vCPU の CPUID が設定済みでなければならない）ためだ。

```
        [全 vCPU]                              [vCPU 0 のみ]
cpuid ──> normalize ──> KVM_SET_CPUID2  ═══>  KVM_GET_MSRS ──> template
                                                                   │
        [全 vCPU]                                                  │
KVM_SET_MSRS <── boot MSR 追加 <── 共有 msrs  <─────────────────────┘
```

MSR は vCPU 0 から 1 回だけ読み、その結果を全 vCPU に配る。CPU テンプレートはマシン全体の設定なので、vCPU ごとに違う値になる理由が無い。

## ソースコードのどこか

### 順序を宣言する doc コメント

[`src/vmm/src/arch/x86_64/mod.rs#L181-L196`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L181-L196)。関数の説明より先に、**なぜこの順序なのか**が書かれている。

```rust title="src/vmm/src/arch/x86_64/mod.rs"
/// Configures the vCPUs for booting Linux.
///
/// KVM determines support for CPUID-dependent MSRs from guest CPUID. Install
/// guest CPUID before retrieving MSRs for CPU templates; otherwise,
/// `KVM_GET_MSRS` returns zero for an MSR that guest CPUID does not support.
///
/// CPU configuration follows this order:
///
/// 1. Apply CPUID modifiers.
/// 2. Set each vCPU's normalized CPUID with `KVM_SET_CPUID2`.
/// 3. Retrieve CPUID-dependent MSRs from vCPU 0 with `KVM_GET_MSRS`.
/// 4. Apply MSR modifiers.
/// 5. Add Linux boot MSRs and update CPUID-derived MSR snapshot bookkeeping.
/// 6. Set each vCPU's MSRs with `KVM_SET_MSRS`.
///
/// The remaining Linux boot state is configured after CPU configuration.
```

最初の段落が **WHY**（KVM がゲスト CPUID から CPUID 依存 MSR のサポートを判定する）と、**破ったときに何が起きるか**（`KVM_GET_MSRS` がゼロを返す）を言っている。後半の 6 項目が **WHAT** で、実装と 1 対 1 に対応する。

`KVM_GET_MSRS` が**エラーではなくゼロを返す**点が重要である。順序を間違えても失敗しない。テストも通ってしまう可能性がある。**症状はゲストの中でしか観測できない**（ある機能が動かない、スナップショット復元後に挙動が変わる）。だからコメントに書くしかない。

### 実装

[`src/vmm/src/arch/x86_64/mod.rs#L197-L233`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L197-L233)。フェーズごとにコメントが振られている。

```rust title="src/vmm/src/arch/x86_64/mod.rs"
    // Phase 1: construct the shared, templated guest CPUID.
    let cpuid = Cpuid::try_from(kvm.supported_cpuid.clone()).map_err(GuestConfigError::from)?;
    let cpuid = apply_template_to_cpuid(cpuid, cpu_template)?;

    // Phase 2: set each normalized CPUID before reading CPUID-dependent MSRs.
    let configured_cpuids = vcpus
        .iter()
        .map(|vcpu| {
            vcpu.kvm_vcpu
                .configure_cpuid(&cpuid, machine_config.vcpu_count, machine_config.smt)
        })
        .collect::<Result<Vec<_>, _>>()?;

    // Phase 3: construct the shared, templated MSRs from vCPU 0's post-CPUID state.
    let msrs = vcpus[0]
        .kvm_vcpu
        .get_msrs(cpu_template.msr_index_iter())
        .map_err(GuestConfigError::from)?;
    let msrs = apply_template_to_msrs(msrs, cpu_template)?;

    // Phase 4: set MSRs and the remaining Linux boot state on each vCPU.
    for (vcpu, configured_cpuid) in vcpus.iter_mut().zip(&configured_cpuids) {
        vcpu.kvm_vcpu
            .configure_msrs_for_boot(&msrs, configured_cpuid)?;
        vcpu.kvm_vcpu.configure_boot_state(guest_mem, entry_point)?;
    }
```

`configured_cpuids` という中間変数が置かれていることに意味がある。フェーズ 2 で `KVM_SET_CPUID2` に渡した**実物の `CpuId`** を保持し、フェーズ 4 に `zip` で渡している。「この vCPU に何を設定したか」を推測せず持ち回るので、**後段が CPUID を再構成する必要が無い。**

その `configured_cpuid` が何に使われるかは [`src/vmm/src/arch/x86_64/vcpu.rs#L240-L281`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vcpu.rs#L240-L281) の `configure_msrs_for_boot` を見ると分かる。

```rust title="src/vmm/src/arch/x86_64/vcpu.rs"
        // By this point we know that at snapshot, the list of MSRs we need to
        // save is `architectural MSRs` + `MSRs inferred through CPUID` + `other
        // MSRs defined by the template`

        let extra_msrs = cpuid::common::msrs_to_save_by_cpuid(configured_cpuid);
        self.msrs_to_save.extend(extra_msrs);
```

**CPUID への依存は、ブート時の値だけではなく[スナップショット](../snapshot-format/)にも及ぶ。** ゲスト CPUID である機能を有効にしたなら、その機能が使う MSR はゲストが書き換えうるので、スナップショット時に保存し復元時に書き戻さなければならない。保存すべき MSR の一覧が CPUID から導出されている。

同じ関数の少し上に、その理屈が書かれている。

```rust title="src/vmm/src/arch/x86_64/vcpu.rs"
        // By this point the Guest CPUID is established. Some CPU features require MSRs
        // to configure and interact with those features. If a MSR is writable from
        // inside the Guest, or is changed by KVM or Firecracker on behalf of the Guest,
        // then we will need to save it every time we take a snapshot, and restore its
        // value when we restore the microVM since the Guest may need that value.
        // Since CPUID tells us what features are enabled for the Guest, we can infer
        // the extra MSRs that we need to save based on a dependency map.
        // NOTE: Some MSRs depend on values of other MSRs. This dependency will need to
        // be implemented.
```

最後の `NOTE:` が**未解決の問題を残している**点も見どころである。MSR 間にも依存があるが、まだ実装されていない。「無い」ことが書かれているので、この関数を触る人は「MSR 間依存は考慮済みだろう」と誤解しない。

### ブート用 MSR に何が入るか

[`src/vmm/src/arch/x86_64/msr.rs#L392-L427`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/msr.rs#L392-L427) の `create_boot_msr_entries`。テンプレート由来の MSR に、これを上書きで足す。

```rust title="src/vmm/src/arch/x86_64/msr.rs"
    vec![
        msr_entry_default(MSR_IA32_SYSENTER_CS),
        msr_entry_default(MSR_IA32_SYSENTER_ESP),
        msr_entry_default(MSR_IA32_SYSENTER_EIP),
        // x86_64 specific msrs, we only run on x86_64 not x86.
        msr_entry_default(MSR_STAR),
        msr_entry_default(MSR_CSTAR),
        msr_entry_default(MSR_KERNEL_GS_BASE),
        msr_entry_default(MSR_SYSCALL_MASK),
        msr_entry_default(MSR_LSTAR),
        // end of x86_64 specific code
        msr_entry_default(MSR_IA32_TSC),
        kvm_msr_entry {
            index: MSR_IA32_MISC_ENABLE,
            data: u64::from(MSR_IA32_MISC_ENABLE_FAST_STRING),
            ..Default::default()
        },
        // set default memory type for physical memory outside configured
        // memory ranges to write-back by setting MTRR enable bit (11) and
        // setting memory type to write-back (value 6).
        // https://wiki.osdev.org/MTRR
        kvm_msr_entry {
            index: MSR_MTRRdefType,
            data: (1 << 11) | 0x6,
            ..Default::default()
        },
    ]
```

3 種類に分けられる。

- **ゼロで初期化するだけのもの** — `MSR_IA32_SYSENTER_CS/ESP/EIP`（32bit の `sysenter` 命令の飛び先）、`MSR_STAR` / `MSR_LSTAR` / `MSR_CSTAR` / `MSR_SYSCALL_MASK`（64bit の `syscall` 命令の飛び先とフラグマスク）、`MSR_KERNEL_GS_BASE`、`MSR_IA32_TSC`。**ゲストのカーネルが自分で設定するので、値そのものより「電源投入直後の既知の状態にする」ことが目的**である。実機のリセット後の状態を再現している。
- **`MSR_IA32_MISC_ENABLE`** — `FAST_STRING` ビットを立てる。文字列コピー命令の高速化を有効にする。
- **`MSR_MTRRdefType`** — ここだけコメントに理由が書いてある。MTRR で明示的に指定されていない物理メモリ範囲の既定のキャッシュ属性を **write-back** にする。ビット 11 が MTRR 有効、下位 8 ビットのメモリタイプ 6 が write-back。これを設定しないと既定が uncacheable になり、ゲストのメモリアクセスが致命的に遅くなる。

`msr_entry_default` というクロージャを定義して `data: 0x0` を省略していることで、**「値に意味があるのはどれか」がひと目で分かる**書き方になっている。

`set_msrs` は書けた本数を検証する（[`src/vmm/src/arch/x86_64/msr.rs#L441-L452`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/msr.rs#L441-L452)）。`KVM_SET_MSRS` は「書けた本数」を返す ioctl で、**一部だけ書けても成功として返る**。ここで本数を突き合わせないと、設定漏れが黙って通る。

```rust title="src/vmm/src/arch/x86_64/msr.rs"
    vcpu.set_msrs(&msrs)
        .map_err(MsrError::SetMsrs)
        .and_then(|msrs_written| {
            if msrs_written == msrs.as_fam_struct_ref().nmsrs as usize {
                Ok(())
            } else {
                Err(MsrError::SetMsrsIncomplete)
            }
        })
```

テストにも、サポート外の MSR を渡すと `SetMsrsIncomplete` になることが書かれている（[`src/vmm/src/arch/x86_64/msr.rs#L526-L540`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/msr.rs#L526-L540)）。

## なぜそうなっているか

### 順序制約の出どころ

KVM は vCPU ごとに「ゲストがどの機能を持つか」を CPUID で保持している。MSR のうち一部は特定の CPU 機能に紐づくもので、その機能が CPUID 上で無効なら、KVM はその MSR を「この vCPU には存在しない」ものとして扱う。だから読んでもゼロになる。

Firecracker は[CPU テンプレート](../cpu-templates/)で、MSR の値をビット単位で加工する（[RegisterValueFilter](../register-value-filter/)）。加工は **read-modify-write** なので、read の結果がゼロだと modify の意味が変わる。「あるビットだけ落とす」つもりの変更が、「全ビットをゼロにしたうえで一部を立てる」になってしまう。**エラーにならずに、意図と違う CPU がゲストに見える。**

同種の順序制約は Firecracker のあちこちにある。[irqchip と vCPU の作成順序](../irqchip-ordering/)、`save_state()` の ioctl 順序（[`src/vmm/src/arch/x86_64/vcpu.rs#L590-L608`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vcpu.rs#L590-L608)、[スナップショットの保存順序](../save-ordering/)）。KVM は状態機械であって、ioctl は可換ではない。

### なぜ doc コメントなのか

この依存を型で表現することもできたはずである。`CpuidConfigured` のような型を作り、それを持っていないと `get_msrs()` を呼べないようにする、など。Firecracker はそうしていない。

理由は推測になるが、この順序が**関数 1 つの中に閉じている**ことが大きいと思われる。`configure_vcpus_for_boot` は 37 行で、フェーズ 1〜4 が上から順に並んでいる。型で守るコストに対して、得られる安全性が見合わない。

代わりに、コードの側で**間違えにくくする工夫**は入っている。

- `configure_cpuid()` が **`KVM_SET_CPUID2` に渡した `CpuId` を戻り値として返す**（[`src/vmm/src/arch/x86_64/vcpu.rs#L203-L226`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vcpu.rs#L203-L226)）。
- `configure_msrs_for_boot()` の doc に **「`configured_cpuid` must be the CPUID installed on this vCPU.」** と前提が書いてある。

戻り値を引数として渡す形にすることで、**呼び出しの依存グラフがデータの流れとして現れる。** フェーズ 2 を消せばフェーズ 4 がコンパイルエラーになる。順序そのものは守られないが、「無関係な 2 つの処理」に見えることは無くなる。

## どう活かすか

### 「読む前に書く」依存を見つけたら書き出す

外部システム（カーネル API、DB、クラウドサービス）を相手にするコードで、次の条件が揃ったら doc コメントに順序を書き出す価値がある。

1. **操作の順序に制約がある**
2. **順序を破ってもエラーにならない**（黙って違う結果になる）
3. **症状が呼び出し箇所から離れたところに出る**

Firecracker の例は 3 条件すべてを満たしている。`KVM_GET_MSRS` はゼロを返し、症状はゲストの中に出る。**エラーが返るなら書かなくてよい。** 実行して落ちれば分かるからだ。書くべきなのは、落ちないケースである。

### 書き方

Firecracker の doc コメントの構造は真似しやすい。

```
1. 制約の根拠を 1 文で。「X は Y に依存する」
2. 破った場合に何が起きるかを 1 文で。「さもないと Z がゼロを返す」
3. 正しい順序を番号付きリストで
```

3 だけを書くと、リファクタで並べ替えられる。1 と 2 があると止められる。逆に 1 と 2 だけだと、実装との対応が取れず腐る。

**番号付きリストの各項目が、実装の各行と対応していること**も効いている。`// Phase 3: ...` が実装側にあるので、片方を変えたらもう片方も直すことが目に入る。

### 効く前提条件と、効かないケース

- **効く**: 制約が数個で、1 つの関数に収まる。読む人がその関数を必ず通る。
- **効かない**: 制約が呼び出し階層をまたぐ。この場合コメントは読まれない。型（ビルダーパターン、typestate）か、実行時の assert に落とすほうがよい。
- **効かない**: 制約が頻繁に変わる。コメントの保守が追いつかず、古い順序が残る。

もう 1 点、Firecracker は「**まだ解決していない依存**」も `NOTE:` として残している（MSR 間の依存）。**書かれていない制約と、書かれているが未対応の制約は、読み手にとって全く違う。** 後者は探索の起点になる。これは真似する価値がある。
