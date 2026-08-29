---
title: "異機種のホストフリートを、1 つの CPU に見せる"
description: "世代の違う CPU が混ざったフリートでは、ゲストから見える機能セットがホストごとに変わり、スナップショットの移行先で機能が消える。Firecracker の CPU テンプレートはこれを CPUID と MSR への修飾子の集合として解く。T2S の実装から何を書き換えているかを具体的に読み、静的テンプレートが v1.5.0 で非推奨になり custom へ寄せられた理由まで追う。"
group: "CPU をゲストにどう見せるか"
sidebar:
  order: 20
---

## 何を学んだか

### 何が困るのか

vCPU の CPUID は、放っておけばホスト CPU に引きずられる。Firecracker は `KVM_GET_SUPPORTED_CPUID` が返した値を出発点にするので、ホストが Skylake なら Skylake の機能セットが、Ice Lake なら Ice Lake の機能セットがゲストに見える。

単一のマシンで開発している限りこれは問題にならない。困るのはフリートを組んだときだ。

1. **同じイメージが、ホストによって動いたり動かなかったりする。** 起動時に CPUID を見て AVX-512 パスを選ぶランタイムは珍しくない。特定のホストでだけ有効になる最適化は、そのホストでだけ出るバグを連れてくる。
2. **スナップショットを別ホストで復元すると落ちる。** ゲストは起動時に CPUID を読んで機能テーブルを作り、以後それを信じて動く。Ice Lake で取ったスナップショットを Skylake で復元すると、ゲストは「あるはず」の命令を発行して `#UD` (無効オペコード例外) を食らう。しかも復元直後ではなく、その命令に到達したときに落ちる。

ドキュメントはスナップショットの互換条件を "They are only compatible if the CPU features exposed to the guest are an invariant when saving and restoring the snapshot." と書いている ([docs/snapshotting/versioning.md#L126-L129](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/snapshotting/versioning.md#L126-L129))。「ゲストに見せる機能セットが save と restore で不変であること」が条件だ。裏を返せば、**不変にできるなら異機種間でも移せる**。

### 答え: 見せるものをデータで宣言する

CPU テンプレートは、ゲストに見せる CPU の姿を宣言的に記述したものだ。x86_64 では CPUID と MSR、aarch64 では ARM レジスタと vCPU features、両方で KVM capabilities を対象にする ([docs/cpu_templates/cpu-templates.md#L3-L12](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L3-L12))。

```
ホスト A (Skylake)   ホスト B (Cascade Lake)   ホスト C (Ice Lake)
      │                     │                       │
  KVM_GET_SUPPORTED_CPUID は 3 台とも違う値を返す
      ▼                     ▼                       ▼
 ┌──────────────────────────────────────────────────────┐
 │  同一の CPU テンプレート (CPUID / MSR modifier の列)  │
 └──────────────────────────────────────────────────────┘
      ▼                     ▼                       ▼
  ゲストから見える CPUID・MSR がホストによらず同じになる
      → スナップショットを 3 台のあいだで往復させられる
```

ドキュメントはこの用途をそのまま挙げている。"A real world use case for this is representing a heterogeneous fleet (a fleet consisting of multiple CPU models) as a homogeneous fleet, so the guests will experience a consistent feature set supported by the host." ([同 #L14-L17](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L14-L17))

### 静的テンプレートと custom テンプレート

|      | 静的 (static)                                         | custom              |
| ---- | ----------------------------------------------------- | ------------------- |
| 実体 | バイナリに埋め込まれた Rust コード                    | ユーザーが書く JSON |
| 設定 | `PUT /machine-config` の `cpu_template`               | `PUT /cpu-config`   |
| 種類 | x86_64 は C3 / T2 / T2S / T2CL / T2A、aarch64 は V1N1 | 任意                |
| 状態 | **v1.5.0 で非推奨**                                   | 推奨                |

どのテンプレートがどの CPU モデルで使えるかは表になっている ([docs/cpu_templates/cpu-templates.md#L63-L70](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L63-L70))。同じ対応関係はコードにも入っていて、次節で引用する。

T2 と C3 は AWS の T2 / C3 インスタンスの機能セットに寄せたもの、V1N1 は Neoverse V1 を Neoverse N1 に見せるためのものだ。T2CL (Intel) と T2A (AMD) は組で設計されていて、混在フリートでも命令セットの見え方が揃うことを狙っている。ただしベンダーをまたいで別ベンダーに見せることはできない ("Representing one CPU vendor as another CPU vendor is not supported."、[同 #L19-L22](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L19-L22))。

そして非推奨の告知。"Static CPU templates are deprecated starting from v1.5.0 and will be removed in accordance with our deprecation policy. Even after the removal, custom CPU templates are available as an improved iteration of static CPU templates." ([同 #L39-L46](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L39-L46))

## ソースコードのどこか

### 静的テンプレートは custom テンプレートを返す関数でしかない

`StaticCpuTemplate` は x86_64 では 5 種類 + `None` の enum で、対応ベンダーと対応 CPU モデルを自分で持っている。

```rust title="src/vmm/src/cpu_config/x86_64/static_cpu_templates/mod.rs"
    pub fn get_supported_cpu_models(&self) -> &'static [CpuModel] {
        match self {
            StaticCpuTemplate::C3 => &[SKYLAKE_FMS, CASCADE_LAKE_FMS, ICE_LAKE_FMS],
            StaticCpuTemplate::T2 => &[SKYLAKE_FMS, CASCADE_LAKE_FMS, ICE_LAKE_FMS],
            StaticCpuTemplate::T2S => &[SKYLAKE_FMS, CASCADE_LAKE_FMS],
            StaticCpuTemplate::T2CL => &[CASCADE_LAKE_FMS, ICE_LAKE_FMS],
            StaticCpuTemplate::T2A => &[MILAN_FMS],
            StaticCpuTemplate::None => unreachable!(), // Should be handled in advance
        }
    }
```

([src/vmm/src/cpu_config/x86_64/static_cpu_templates/mod.rs#L66-L77](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/static_cpu_templates/mod.rs#L66-L77))

この表はテンプレートの取り出し口で使われる。静的テンプレートが指定されたら、ホストのベンダー ID と Family/Model/Stepping を実際に読み、対応表にないなら `CpuVendorMismatched` / `InvalidCpuModel` で起動前に弾く。チェックを抜けた先で返るのは `Cow::Owned(t2s::t2s())` のような値、つまり **`CustomCpuTemplate` そのもの**だ ([src/vmm/src/cpu_config/x86_64/custom_cpu_template.rs#L28-L62](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/custom_cpu_template.rs#L28-L62))。テンプレート未指定のときも空の `CustomCpuTemplate::default()` が返る。つまり内部に「静的テンプレートを適用する経路」は存在しない。**静的テンプレートは、あらかじめ用意された custom テンプレートを返すだけの関数**になっている。

### テンプレートが実際に書いていること

`CustomCpuTemplate` は 3 つのリストを持つだけの型だ ([同 #L118-L132](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/custom_cpu_template.rs#L118-L132))。

```rust title="src/vmm/src/cpu_config/x86_64/custom_cpu_template.rs"
pub struct CustomCpuTemplate {
    pub kvm_capabilities: Vec<KvmCapability>,
    pub cpuid_modifiers: Vec<CpuidLeafModifier>,
    pub msr_modifiers: Vec<RegisterModifier>,
}
```

T2S の中身を見ると、何を書いているかがはっきりする。まず CPUID leaf 0x1 の EAX、つまり Family/Model/Stepping。

```rust title="src/vmm/src/cpu_config/x86_64/static_cpu_templates/t2s.rs"
                    // EAX: Version Information
                    // - Bits 03-00: Stepping ID.   - Bits 13-12: Processor Type.
                    // - Bits 07-04: Model.         - Bits 19-16: Extended Model ID.
                    // - Bits 11-08: Family.        - Bits 27-20: Extended Family ID.
                    CpuidRegisterModifier {
                        register: CpuidRegister::Eax,
                        bitmap: RegisterValueFilter {
                            filter: 0b0000_11111111_1111_00_11_1111_1111_1111,
                            value: 0b0000_00000000_0011_00_00_0110_1111_0010,
                        },
                    },
```

([src/vmm/src/cpu_config/x86_64/static_cpu_templates/t2s.rs#L27-L41](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/static_cpu_templates/t2s.rs#L27-L41))

`filter` が立っているビットを `value` で差し替える (演算の詳細は [3 値ビットマップのページ](../register-value-filter/)) ので、Family = 6、Extended Model = 3、Model = 0xF、Stepping = 2 に**固定される**。ホストが何であれ、ゲストの `/proc/cpuinfo` には同じ型番が並ぶ。

次に leaf 0x7 subleaf 0x0 の EBX は、`filter: 0b1111_1111_1110_1111_1101_1010_0001_0100` に対して `value` でビット 9 だけが立っている ([同 #L85-L114](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/static_cpu_templates/t2s.rs#L85-L114))。ビットごとの意味はコメントに全部書かれていて、ビット 9 は Enhanced REP MOVSB/STOSB、ビット 16 以降は AVX512F / AVX512DQ などだ。つまり AVX-512 系・SGX・RTM・SHA は落ち、ERMS は**ホストによらず立てられる**。テンプレートは「消す」だけでなく「立てる」こともできる。

そして T2S を T2S たらしめている MSR modifier。対象は `addr: 0x10a` = `IA32_ARCH_CAPABILITIES` ただ 1 つで、`filter` が 64 ビット全部、`value` が `0b..._1100_0000_1010_0000_1100_0100_1100` になっている ([同 #L230-L266](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/static_cpu_templates/t2s.rs#L230-L266))。

`filter` が全ビットなので、この MSR はホストの値を一切参照せず `value` にまるごと置き換わる。ビットの意味はやはりコメントに全部書かれている。立っているのはビット 2 (RSBA)、3、6、10、11、17 (FB_CLEAR)、19 (RRSBA)、26、27。逆に **ビット 0 (RDCL_NO)、1 (IBRS_ALL)、5 (MDS_NO)、8 (TAA_NO) はすべて 0 に落ちている**。

この MSR は「この CPU はこの脆弱性の影響を受けない」をゲストに伝えるためのものだ。`MDS_NO = 0` は「MDS の影響を受ける」という申告であり、ゲストカーネルはこれを見てソフトウェア緩和策を有効にする。これが T2S の性能ペナルティの正体になる。

### 静的テンプレートと JSON は同じものだと保証されている

ハードコードされた Rust のテンプレートと `tests/data/custom_cpu_templates/*.json` は、`assert_eq!(hardcoded_template, json_template)` で同一性が確認される ([同 #L84-L98](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/cpu_config/x86_64/static_cpu_templates/mod.rs#L84-L98))。T2S.json では上の leaf 0x1 EAX modifier が `"bitmap": "0bxxxx000000000011xx00011011110010"` という 1 行になっている。**静的テンプレートをそのまま custom テンプレートとしてコピーできる**ことが、テストとして存在している。

## なぜそうなっているか

### なぜ静的テンプレートをやめるのか

CHANGELOG は非推奨の事実と代替手段しか書いていない ([CHANGELOG.md#L983-L988](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/CHANGELOG.md#L983-L988))。理由は明示されていないが、コードの構造からは読み取れる。

静的テンプレートは **Firecracker のリリースサイクルに縛られている**。新しい CPU 世代がフリートに入るたびに、`get_supported_cpu_models()` に FMS を足し、テンプレート定義を調整し、リリースし、フリート全体を入れ替える必要がある。`T2S => &[SKYLAKE_FMS, CASCADE_LAKE_FMS]` という定数の列が、そのコストをそのまま表している。custom テンプレートなら JSON ファイルの差し替えで済む。

もうひとつは責務の所在だ。「どの機能をどのビットで消すか」は本来ワークロードの持ち主が決めることで、VMM の作者が決めることではない。ドキュメントも custom テンプレートについて「専門知識が要る」「本番投入前に十分にテストせよ」「緩和策が実際にはハードウェアにないのに在ると申告すると、ゲストが緩和を切って脆弱になる」と繰り返し警告している ([docs/cpu_templates/cpu-templates.md#L123-L143](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L123-L143))。危険な機能であることを認めたうえで、判断を利用者に渡している。

### なぜ T2S は性能を犠牲にするのか

> The T2S template is designed to allow migrating snapshots between hosts with Intel Skylake and Intel Cascade Lake securely by further restricting CPU features for the guest, however this comes with a performance penalty.
> ([同 #L78-L82](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L78-L82))

推測を含むが、上で読んだ MSR の値と突き合わせると筋は通る。Skylake と Cascade Lake ではハードウェア緩和の有無が違い、`IA32_ARCH_CAPABILITIES` の申告内容が違う。スナップショットを両方向に移すにはこの MSR も不変でなければならず、不変にできる唯一の安全な値は**どちらでも成り立つ側、つまり緩和を持っていない側**だ。結果としてゲストは Cascade Lake 上でも「自分は MDS に脆弱だ」と信じ、不要なソフトウェア緩和を実行し続ける。

逆に、緩和を「ある」と偽ることは絶対にできない。ないものを在ると申告すればゲストは緩和を切り、本当に脆弱になる。**安全側は常に「機能が少ないほう」**であり、T2S はそれを選んでいる。

ただし FB_CLEAR (ビット 17) だけは例外的に立てられていて、その理由も書かれている。「Firecracker はホストが常に最新マイクロコードで動いていることを前提とする。それが満たされていれば VERW は Skylake でも Cascade Lake でも fill buffer をクリアするので、ホストカーネルのバージョンによらずゲストがその挙動を知れるように FB_CLEAR を立てる」。そして前提が満たされない場合に何が起きるかまで書いている ("guests may observe FB_CLEAR even though VERW does not clear fill buffers"、[同 #L82-L88](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L82-L88))。テンプレートのビット 1 個に、前提と失敗モードがセットで記録されている。

なお静的と custom を両方指定した場合は、**後から設定したほうだけ**が適用され、マージはされない ([同 #L267-L274](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/cpu_templates/cpu-templates.md#L267-L274))。`CpuTemplateType` が `Custom` / `Static` の enum で、`Option<CpuTemplateType>` として 1 個だけ保持されるからだ。重ねる意味論を定義しないことで、「どっちのビットが勝つのか」という問いを消している。

## どう活かすか

### 持ち帰れる設計

**「互換性の最小公倍数」をコードではなくデータにする。** 複数の環境で同じ成果物を動かすシステムには「この環境では使えるがあの環境では使えない機能」がある。それを `if env == "old"` で書き散らすのではなく、環境に依存しない 1 枚の能力記述に落として全環境でそれを強制する。

**組み込みプリセットには、外部形式へのシリアライズ経路を必ず持たせる。** プリセットがバイナリの中にしかないと、利用者は「あと 1 ビットだけ違うもの」を作れない。Firecracker は静的テンプレートと JSON の同一性をテストで保証することで、プリセットを出発点に書き換える移行パスを担保している。

**危険な機能には、前提条件と失敗モードをその場に書く。** FB_CLEAR の説明が典型で、「なぜ立てるか」だけでなく「前提が崩れたら何が起きるか」まで書いてある。「有効にすると X が有効になります」で終わるドキュメントでは、利用者は前提を検証しようがない。

### 効く前提条件

- **異機種のフリートがあり、状態を機械間で移す。** 単一世代しかない、あるいは移さないなら、素通しのほうが速い。
- **見せる側と見られる側の契約が明文化されている。** CPUID のように「何ビット目が何を意味するか」が仕様で固定されているからこそ、ビットマップという表現が成立する。契約が曖昧な層で同じことをやると、修飾子の意味が誰にも分からなくなる。

### 取り込むべきでないとき

**セキュリティ境界としては使えない。** 機能ビットを消してもゲストはその命令を実行できる ([機能を隠すことは守ることではない](../template-not-a-boundary/))。

**「機能が見えない」ことを前提にした最適化を上位層で行わない。** テンプレートはゲストの自己申告を変えるだけなので、ホスト側のリソース割り当てをテンプレートの内容から推論すると、テンプレートを外した瞬間に前提が崩れる。

**テンプレートで書いた値が最終形だと思わない。** 適用後には CPUID 正規化とブートプロトコルのレジスタ設定が走り、重なった部分は上書きされる ([CPUID 正規化のページ](../cpuid-normalization/))。適用順序は [CPUID を MSR より先に入れる理由](../cpuid-before-msr/) で扱う。
