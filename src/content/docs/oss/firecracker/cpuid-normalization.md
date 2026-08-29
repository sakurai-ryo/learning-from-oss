---
title: "Turbo Boost とパフォーマンスカウンタを、常時オフにする"
description: "Firecracker はテンプレートの有無にかかわらず、ゲストに見せる CPUID を毎回書き換える。ベンダー ID はホストから強制パススルー、APIC ID とトポロジは vCPU 数から再計算、HYPERVISOR ビットは常時 ON、Turbo Boost とパフォーマンスモニタリングは常時 OFF。何が上書きされ、なぜ性能機能をわざわざ切るのかを、コードコメントで裏が取れる範囲と推測に分けて読む。"
group: "CPU をゲストにどう見せるか"
sidebar:
  order: 22
---

## 何を学んだか

### テンプレートは最終決定権を持たない

[CPU テンプレート](../cpu-templates/) を書けばゲストに見せる CPUID を自由に決められる、と考えるとつまずく。テンプレートの適用後に **CPUID 正規化 (normalization)** が必ず走り、一部のビットを問答無用で書き直すからだ。

> If a CPU template is used the normalization is performed _after_ the CPU template is applied. That means that if the CPU template configures CPUID bits used in the normalization process, they will be overwritten.
> ([docs/cpu_templates/cpuid-normalization.md#L1-L8](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpuid-normalization.md#L1-L8))

同じことがブートプロトコル用の MSR 設定についても書かれている ([docs/cpu_templates/boot-protocol.md#L1-L9](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/boot-protocol.md#L1-L9))。

```
KVM_GET_SUPPORTED_CPUID     ← ホストと KVM が「出せる」もの
        ▼
  テンプレート適用          ← 利用者が「見せたい」もの (全 vCPU 共通)
        ▼
  CPUID 正規化              ← Firecracker が「そうでなければ困る」もの (vCPU ごと)
        ▼
  KVM_SET_CPUID2
        ▼
  ブートプロトコルの MSR 設定
```

正規化の内容は 3 種類に分けると整理しやすい。

### 1. 正しくないと壊れるもの — トポロジと APIC ID

vCPU 番号や論理プロセッサ数に依存する値は、ホストの CPUID をそのまま渡しても意味がない。vCPU 数と SMT 設定から計算し直す。

- leaf 0x1 EBX[31:24] の初期 APIC ID を、その vCPU のインデックスにする
- leaf 0x1 EBX[23:16] のパッケージあたり論理プロセッサ数を、vCPU 数から求めた 2 のべき乗にする
- leaf 0x1 EDX[28] の HTT を、vCPU 数が 2 以上のときだけ立てる
- leaf 0xb (拡張トポロジ列挙) の全サブリーフを組み直し、EDX に x2APIC ID を入れる。KVM が返さないサブリーフ 0x1 は自分で挿入する
- Intel では leaf 0x1f (v2 拡張トポロジ) と leaf 0x4 (決定的キャッシュパラメータ) も同様に埋める

これは「隠す」処理ではなく「辻褄を合わせる」処理だ。**そしてこれが、正規化を vCPU ごとに走らせなければならない理由**でもある。テンプレートは全 vCPU で共通の 1 個だが、APIC ID は vCPU ごとに違う。

### 2. 嘘をつかせないもの — ベンダー ID とハイパーバイザビット

leaf 0x0 の EBX / ECX / EDX (ベンダー ID 文字列) は**ホストから無条件でコピー**され、leaf 0x1 ECX[31] の HYPERVISOR ビットは**常に立つ**。前者は「Intel を AMD に見せることはできない」という制約を実装として強制している箇所だ。後者は「あなたは仮想化されている」という申告で、ゲストの paravirt 検出がこれを見る。

### 3. わざわざ落とすもの — 性能機能

ホストがサポートしていて KVM も出せて、テンプレートが何も言わなくても、Firecracker が能動的に無効化する機能がある。

| 機能                                 | 場所             | 処理                         |
| ------------------------------------ | ---------------- | ---------------------------- |
| PDCM (Perfmon and Debug Capability)  | leaf 0x1 ECX[15] | 常に 0                       |
| Intel Turbo Boost                    | leaf 0x6 EAX[1]  | 常に 0                       |
| 周波数選択 (EPB)                     | leaf 0x6 ECX[3]  | 常に 0                       |
| WAITPKG (UMONITOR / UMWAIT / TPAUSE) | leaf 0x7 ECX[5]  | 常に 0                       |
| パフォーマンスモニタリング           | leaf 0xa         | EAX/EBX/ECX/EDX を**全部 0** |

さらにブランド文字列 (leaf 0x80000002〜0x80000004) も汎用のものに置き換わる。Intel では `Intel(R) Xeon(R) Processor @ <実周波数>`、AMD では `AMD EPYC`。

全リストは [docs/cpu_templates/cpuid-normalization.md](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpuid-normalization.md) に共通・Intel 固有・AMD 固有の 3 表として載っていて、leaf / subleaf / レジスタ / ビットまで書かれている。

## ソースコードのどこか

### 呼ばれる場所

正規化は vCPU ごとの CPUID 設定関数の中で、`KVM_SET_CPUID2` の直前に走る。

```rust title="src/vmm/src/arch/x86_64/vcpu.rs"
        let mut cpuid = cpuid.clone();

        cpuid.normalize(
            // The index of the current logical CPU in the range [0..cpu_count].
            self.index,
            // The total number of logical CPUs.
            vcpu_count,
            // The number of bits needed to enumerate logical CPUs per core.
            u8::from(vcpu_count > 1 && smt),
        )?;

        let kvm_cpuid = CpuId::try_from(cpuid)?;
        self.fd.set_cpuid2(&kvm_cpuid)
```

([src/vmm/src/arch/x86_64/vcpu.rs#L203-L226](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/vcpu.rs#L203-L226))

`cpuid.clone()` で vCPU ごとにコピーを取っているのが要点だ。呼び出し元では `// Phase 1: construct the shared, templated guest CPUID.` でテンプレートを 1 回だけ適用し、`// Phase 2: set each normalized CPUID before reading CPUID-dependent MSRs.` で全 vCPU に対して `configure_cpuid()` を回す ([src/vmm/src/arch/x86_64/mod.rs#L205-L216](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/arch/x86_64/mod.rs#L205-L216))。「テンプレートは 1 回・共有、正規化は vCPU ごと」という分担がフェーズのコメントにそのまま書かれている。MSR の取得がこのあとに来る理由は [CPUID を MSR より先に入れる理由](../cpuid-before-msr/) で扱う。

### 正規化の骨格

エントリポイントは共通処理を 4 つ呼んでからベンダーごとに分岐する。

```rust title="src/vmm/src/cpu_config/x86_64/cpuid/normalize.rs"
        self.update_vendor_id()?;
        self.update_feature_info_entry(cpu_index, cpu_count)?;
        self.update_extended_topology_entry(cpu_index, cpu_count, cpu_bits, cpus_per_core)?;
        self.update_extended_cache_features()?;

        // Apply manufacturer specific modifications.
        match self {
            Self::Intel(intel_cpuid) => {
                intel_cpuid.normalize(cpu_index, cpu_count, cpus_per_core)?;
            }
            Self::Amd(amd_cpuid) => amd_cpuid.normalize(cpu_index, cpu_count, cpus_per_core)?,
        }
```

([src/vmm/src/cpu_config/x86_64/cpuid/normalize.rs#L172-L185](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/normalize.rs#L172-L185))

Intel 側は 6 段 (`update_deterministic_cache_entry` / `update_power_management_entry` / `update_extended_feature_flags_entry` / `update_performance_monitoring_entry` / `update_extended_topology_v2_entry` / `update_brand_string_entry`、[intel/normalize.rs#L72-L77](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/intel/normalize.rs#L72-L77))。関数名が処理の目次になっていて、ドキュメントの表と 1 対 1 で対応する。

### ベンダー ID のパススルー

```rust title="src/vmm/src/cpu_config/x86_64/cpuid/normalize.rs"
    /// Pass-through the vendor ID from the host. This is used to prevent modification of the vendor
    /// ID via custom CPU templates.
    fn update_vendor_id(&mut self) -> Result<(), VendorIdError> {
        let leaf_0 = self.get_mut(&CpuidKey::leaf(0x0)).ok_or(VendorIdError::MissingLeaf0)?;
        let host_leaf_0 = cpuid(0x0);

        leaf_0.result.ebx = host_leaf_0.ebx;
        leaf_0.result.ecx = host_leaf_0.ecx;
        leaf_0.result.edx = host_leaf_0.edx;
```

([同 #L190-L204](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/normalize.rs#L190-L204))

"to prevent modification of the vendor ID via custom CPU templates" — テンプレートで書けてしまうことを承知のうえで後段で消している。ホストの `cpuid` 命令を直接実行しているので、KVM が返す値ですらなく本物のホスト CPU の値だ。

### leaf 0x1 の一括処理

`update_feature_info_entry()` は APIC ID の再計算に続けて、`set_bit(&mut leaf_1.result.ecx, 15, false)` (PDCM)、`set_bit(..., 24, true)` (TSC-Deadline)、`set_bit(..., 31, true)` (Hypervisor) を並べる ([同 #L241-L252](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/normalize.rs#L241-L252))。1 つが「常に 0」、2 つが「常に 1」。ホストの値は参照されない。

### Turbo Boost と周波数選択

```rust title="src/vmm/src/cpu_config/x86_64/cpuid/intel/normalize.rs"
        // CPUID.06H:EAX[1]
        // Intel Turbo Boost Technology available (see description of IA32_MISC_ENABLE[38]).
        set_bit(&mut leaf_6.result.eax, 1, false);

        // ...
        // Clear X86 EPB feature. No frequency selection in the hypervisor.
        set_bit(&mut leaf_6.result.ecx, 3, false);
```

([intel/normalize.rs#L163-L180](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/intel/normalize.rs#L163-L180))

EPB には "No frequency selection in the hypervisor." という理由が付いている。**Turbo Boost のほうにはビットの意味しか書かれていない。**

### パフォーマンスモニタリングの全消し

leaf 0xa は部分的に削るのではなく、`leaf_a.result = CpuidRegisters { eax: 0, ebx: 0, ecx: 0, edx: 0 }` で 4 レジスタとも潰す ([同 #L242-L254](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/intel/normalize.rs#L242-L254))。leaf 0xa の EAX にはアーキテクチャ性能監視のバージョン ID とカウンタ本数が入るので、全部 0 は「バージョン 0 = 性能監視機能なし」を意味する。

### WAITPKG — 唯一、理由が長文で書かれている箇所

```rust title="src/vmm/src/cpu_config/x86_64/cpuid/intel/normalize.rs"
        // Similar to MONITOR/MWAIT, we disable the guest's WAITPKG in order to prevent a guest from
        // executing those instructions and putting a physical processor to an idle state which may
        // lead to an overhead of waking it up when scheduling another guest on it. By clearing the
        // WAITPKG bit in KVM_SET_CPUID2 API, KVM does not set the "enable user wait and pause" bit
        // (bit 26) of the secondary processor-based VM-execution control, which makes guests get
        // #UD when attempting to executing those instructions.
        set_bit(&mut leaf_7_0.result.ecx, 5, false);
```

([同 #L211-L237](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/intel/normalize.rs#L211-L237))

理由は「ゲストが物理コアをアイドル状態に落とすと、そのコアに別のゲストをスケジュールするときの起床コストになる」。つまり**ホスト側の都合**だ。1 台に多数の microVM を詰めるという運用が、そのまま CPUID の 1 ビットに現れている。

補足も重要だ。CPUID のビットを落とすと KVM は VMX の副次プロセッサベース実行制御のビット 26 を立てず、ゲストは実際に `#UD` を受ける。**CPUID を消したことが本当に命令の実行を止める、数少ない例**である ([機能を隠すことは守ることではない](../template-not-a-boundary/))。

### AMD 側にも同種の判断がある

AMD の `update_structured_extended_entry()` は leaf 0x7 EDX のビット 29 を落とす。コメントの理由は "The availability of IA32_ARCH_CAPABILITIES MSR is controlled via CPUID.07H(ECX=0):EDX[bit 29]. KVM sets this bit no matter what but this feature is not supported by hardware." ([amd/normalize.rs#L198-L208](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/amd/normalize.rs#L198-L208))。

「KVM が無条件に立てるが、ハードウェアは実装していない」ので消す。正規化には **KVM のバグや癖を打ち消す**役割もある。leaf 0xb subleaf 0x1 を自分で挿入している箇所も同じ性質で、「`KVM_GET_SUPPORTED_CPUID` がこれを返さなくなったカーネルコミット」の URL がコメントに貼られている ([normalize.rs#L273-L286](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/cpuid/normalize.rs#L273-L286))。

## なぜそうなっているか

### 根拠が明示されているもの

1. **ホストのスケジューリングを守る (WAITPKG)。** ゲストが物理コアをアイドルにできると、他ゲストの起動レイテンシに響く。
2. **ハイパーバイザに実体のない機能を消す (EPB、AMD の bit 29)。** 「No frequency selection in the hypervisor」「this feature is not supported by hardware」。実装していない、あるいは物理的に存在しないものを申告しない。
3. **テンプレートで壊せない不変条件を守る (ベンダー ID、トポロジ)。** 「テンプレートによる書き換えを防ぐため」と明記されている。

### 根拠が書かれていないもの — 推測

Turbo Boost (leaf 0x6 EAX[1])、PDCM (leaf 0x1 ECX[15])、パフォーマンスモニタリング (leaf 0xa) には、コードにもドキュメントにも理由が書かれていない。ドキュメントの表は「Disable Intel Turbo Boost technology」と処理内容を書くだけだ。以下は推測になる。

**ホスト間で挙動が変わる要素を消している、という説明が最も素直だ。** Turbo Boost が効くかどうかはホストの熱状態と他テナントの負荷で決まり、ゲストからは制御も予測もできない。「使える」と申告して実際の周波数が上がらないなら、申告しないほうが一貫する。パフォーマンスカウンタも本数と種類が世代ごとに違うので、[異機種フリートを 1 つに見せる](../cpu-templates/) 目的からすると世代差がそのまま漏れる leaf 0xa は消すのが辻褄に合う。PDCM も `IA32_PERF_CAPABILITIES` という世代依存の MSR の存在を示すビットなので、同じ動機だと見るのが自然だ。

**情報漏洩ベクタを減らす、という説明も成り立つ。** 精密なサイクルカウンタはサイドチャネル攻撃の基本的な道具だ。ただしこれは Firecracker のドキュメントが主張していることではなく、一般論からの推論にすぎない。加えて、[この機能はセキュリティ境界ではない](../template-not-a-boundary/) という Firecracker 自身の立場からすると、正規化による無効化を「セキュリティ対策」と呼ぶのは危うい。leaf 0xa を 0 にしてもカウンタ MSR に触る命令が消えるわけではなく、実際にゲストがカウンタを読めるかを決めるのは KVM の MSR ハンドリングであってこの CPUID ビットではない。

確実に言えるのは **「性能機能を残すことより、ゲストから見える姿が環境によらず一定であることを優先している」** という選択そのものだ ([最小主義の憲章](../minimalism-charter/))。

### なぜ「テンプレートの後」なのか

順序が逆なら、テンプレートは APIC ID や HTT ビットを壊せてしまう。テンプレートは全 vCPU 共通の 1 個なので、そこに APIC ID を書けば全 vCPU が同じ APIC ID を名乗り、ゲストのブートが失敗する。

正規化を最後に置くことで、**「Firecracker が正しく動くために必要な値」がテンプレートより強い**関係が保たれる。テンプレートの表現力を制限する代わりに、書き間違えても microVM が起動しなくなる範囲を狭めている。ブートプロトコル用の MSR 設定が最後に来るのも同じ理由だ。

## どう活かすか

### 持ち帰れる設計

**ユーザー設定の後ろに「必ず走る整形」を置き、その内容をドキュメント化する。** 設定を受け付ける層と、システムが成立するために必要な値を確定する層を分け、「あなたの設定はここで上書きされます」を表にして公開する。Firecracker は leaf / subleaf / レジスタ / ビットの粒度で表を出している。この粒度がなければ、利用者は自分のテンプレートが効いているかを実測でしか確認できない。

**環境依存の値を、外に出す前に潰す。** ブランド文字列を `Intel(R) Xeon(R) Processor @ <実周波数>` に置き換える処理は象徴的で、モデル名という「気にしなくていいはずなのに気にされてしまう」情報を消しつつ、周波数という「消すと計算が狂う」情報は残している。何を消して何を残すかは、上位のコードがその値をどう使うかで決まる。

**上流のバグや癖を打ち消す層に名前を付けて 1 箇所にまとめる。** leaf 0xb subleaf 0x1 の挿入や AMD の bit 29 クリアは KVM 側の挙動への対処で、放っておくと呼び出し側に散る。`normalize()` に集めておけば、KVM 側が直ったときに何を消せるかがすぐ分かる。

**理由が書けないものは、せめて処理内容を機械的に列挙する。** Turbo Boost の無効化に理由は書かれていないが、ドキュメントの表には載っている。「なぜ」が書けなくても「何を」が書いてあれば、利用者は挙動の差分を説明できる。

### 効く前提条件

- **同じ成果物を多数の環境で走らせる。** 1 台で最高性能を出すことが目的なら、正規化は性能を捨てるだけになる。
- **環境の差が観測可能で、上位層がその観測結果に応じて分岐する。** CPUID のようにゲスト OS が起動時に読んで挙動を変える仕組みがあるからこそ、揃える価値がある。
- **消したい情報の一覧を仕様として書ける。** ビット単位で列挙できないなら、表も書けないしテストも書けない。

### 取り込むべきでないとき

**正規化を隔離の手段だと考えてはいけない。** 見せる情報を減らすことと、能力を奪うことは別だ。WAITPKG のように KVM 側の実装と結びついて実際に効く例もあるが、それは例外であって規則ではない。Firecracker が実際に守っているのは KVM の境界と seccomp と jailer で、CPUID ではない ([脅威モデル](../threat-model/)、[スレッド単位の seccomp](../per-thread-seccomp/))。

**「常に上書きする」層は、上書きの範囲が小さいうちだけ有効だ。** 正規化が肥大化してテンプレートで書ける領域を圧迫すれば、テンプレート機能そのものが意味を失う。正規化が扱うのは十数個の leaf に限られ、それが表 1 枚に収まっているという事実自体が、この設計の成立条件になっている。
