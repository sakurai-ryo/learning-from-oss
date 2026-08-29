---
title: "seccomp フィルタを JSON から作り、バイナリに埋め込む"
description: "resources/seccomp/*.json を build.rs が libseccomp でコンパイルし、スレッド名 → BPF 命令列の map を bitcode で直列化して include_bytes! で実行ファイルに埋め込むまでの流れを追う。デバッグビルドでは unimplemented.json が使われて seccomp が事実上無効になる、というビルド構成の落とし穴も扱う。"
group: "隔離とセキュリティ"
sidebar:
  order: 54
---

## 何を学んだか

Firecracker の seccomp ポリシーは、コードではなく JSON で書かれている。そして実行時に JSON を読むのではなく、**ビルド時に BPF へコンパイルして実行ファイルに埋め込む**。

```
resources/seccomp/x86_64-unknown-linux-musl.json     宣言（人が読み書きする）
        │
        │  src/firecracker/build.rs (cargo build script)
        │    └ seccompiler::compile_bpf()
        │        ├ serde_json で BpfJson へ
        │        ├ libseccomp (seccomp_init / seccomp_rule_add_array)
        │        ├ seccomp_export_bpf → memfd → Vec<u64> として読み戻し
        │        └ bitcode::serialize(BTreeMap<String, Vec<u64>>)
        ▼
$OUT_DIR/seccomp_filter.bpf                          直列化された BPF
        │
        │  src/firecracker/src/seccomp.rs
        │    include_bytes!(concat!(env!("OUT_DIR"), "/seccomp_filter.bpf"))
        ▼
firecracker 実行ファイルの中の &'static [u8]
        │
        │  vmm::seccomp::deserialize_binary()  （サイズ上限 100 KB）
        ▼
BpfThreadMap = HashMap<String, Arc<Vec<u64>>>        "vmm" / "api" / "vcpu"
        │
        ▼
各スレッドが自分で apply_filter()   →  ../per-thread-seccomp/
```

### JSON で書く

トップレベルはスレッドカテゴリ名から filter へのマップである。x86_64 musl の場合、ルール数はこうなっている。

| カテゴリ | `default_action` | `filter_action` | ルール数 |
| -------- | ---------------- | --------------- | -------- |
| `vmm`    | `trap`           | `allow`         | 80       |
| `api`    | `trap`           | `allow`         | 37       |
| `vcpu`   | `trap`           | `allow`         | 50       |

`default_action` が `trap`、`filter_action` が `allow` なので、明示的に許可したものだけが通る allowlist である。`trap` は `SECCOMP_RET_TRAP`、つまり `SIGSYS` をプロセスに投げる。何が起きるかは[このページ](../sigsys-handler/)で扱う。

各ルールはシステムコール名と、任意で引数の条件を持つ。

```json title="resources/seccomp/x86_64-unknown-linux-musl.json"
            {
                "syscall": "ioctl",
                "comment": "Used to make vsock UDS nonblocking",
                "args": [
                    {
                        "index": 1,
                        "type": "dword",
                        "op": "eq",
                        "val": 21537,
                        "comment": "FIONBIO"
                    }
                ]
            },
```

`ioctl` を丸ごと許すのではなく、第 2 引数（`index: 1`）が `FIONBIO`（21537）のときだけ許す。同じ `ioctl` に対して異なる `request` を許したいときは、ルールオブジェクトを複数書く（配列の要素どうしは OR、`args` の中は AND）。`comment` は処理には使われないが、`21537` が何なのかを人が読むために置かれている。名前付き定数を JSON に持ち込まない代わりに、コメントで意味を書くという割り切りである。

### libseccomp でコンパイルする

`seccompiler` は BPF を自前で組み立てない。C の libseccomp を FFI で呼ぶ。バインディングは `bindgen` ではなく手書きで、`#[link(name = "seccomp")]` の `extern` ブロックに 6 関数だけが宣言されている。

宣言されているのは `seccomp_init` / `seccomp_arch_add` / `seccomp_syscall_resolve_name` / `seccomp_rule_add` / `seccomp_rule_add_array` / `seccomp_export_bpf` の 6 つ。`seccomp_export_bpf` の出力先には `memfd_create` で作った匿名ファイルを渡す。一時ファイルを作らずに済み、書き終わったら `rewind` して `read_exact` で `Vec<u64>` に読み戻せる。BPF 命令（`struct sock_filter`）は 8 バイトなので、`u64` の Vec として扱えば長さもアラインメントも自動的に合う。

libseccomp に任せると、システムコール名から番号への解決、アーキ差の吸収、BPF プログラムの最適化を自分で書かなくて済む。ただし丸投げではなく、1 箇所だけ回避策が入っている。`op: "eq"` を素直に `SCMP_CMP_EQ` に落とさない。

```rust title="src/seccompiler/src/types.rs"
                // When using EQ libseccomp compares the whole 64 bits. In
                // general this is not a problem, but for example we have
                // observed musl `ioctl` to leave garbage in the upper bits of
                // the `request` argument. ... Until that is available, do a masked comparison
                // with the upper 32bits set to 0, so we will compare that `hi32
                // & 0x0 == 0`, which is always true.
```

musl の `ioctl` ラッパが `request` 引数の上位 32 ビットにゴミを残すことがある。libseccomp の `EQ` は 64 ビット全体を比較するので、そのゴミのせいでルールが一致しない。そこで `type: "dword"` の `eq` は `SCMP_CMP_MASKED_EQ` にマスク `0x00000000FFFFFFFF` を添えて発行し、下位 32 ビットだけを比べる。JSON 側の `"type": "dword"` / `"qword"` という指定は、この比較幅の指定に対応している。

### bitcode で直列化し、include_bytes! で埋め込む

`compile_bpf` が最終的に作るのは `BTreeMap<String, Vec<u64>>`、すなわち「スレッドカテゴリ名 → BPF 命令列」のマップである。これを `bitcode` でバイト列にして 1 ファイルに書く（`--split-output` を付けると、テスト用にスレッドごとの生 BPF を別ファイルに吐く）。`src/firecracker/build.rs` が cargo のビルドスクリプトとしてこれを呼び、出力先は `$OUT_DIR/seccomp_filter.bpf`。実行時にはそれを `include_bytes!` で読む。

```rust title="src/firecracker/src/seccomp.rs"
fn get_default_filters() -> Result<BpfThreadMap, FilterError> {
    // Retrieve, at compile-time, the serialized binary filter generated with seccompiler.
    let bytes: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/seccomp_filter.bpf"));
    let map = deserialize_binary(bytes).map_err(FilterError::Deserialization)?;
    filter_thread_categories(map)
}
```

埋め込みなので、実行時に外部ファイルを読まない。jail の中にポリシーファイルを持ち込む必要もないし、差し替えられる余地もない。CHARTER の `cannot be mistakenly disabled by customers` に沿っている。

`deserialize_binary` にはサイズ上限がある。

```rust title="src/vmm/src/seccomp.rs"
// This byte limit is passed to `bitcode` to guard against a potential memory
// allocation DOS caused by binary filters that are too large.
// This limit can be safely determined since the maximum length of a BPF
// filter is 4096 instructions and Firecracker has a finite number of threads.
const DESERIALIZATION_BYTES_LIMIT: usize = 100_000;
```

100 KB を超える入力は読み込む前に弾く。`reader.take(LIMIT + 1)` で読んでから長さを見る書き方なので、巨大なファイルを渡されてもメモリを食い潰さない。同じ上限は `seccompiler` 側の書き出しでもチェックされている。デフォルトフィルタは埋め込みなので上限が問題になることはないが、`--seccomp-filter` でユーザが渡すファイルには効く。

読み込んだあと `filter_thread_categories` が `["vmm", "api", "vcpu"]` の 3 つがすべて揃っていること、余計なキーがないことを確認する。カスタムフィルタで `vcpu` を書き忘れると起動時に落ちる。

### スタンドアロンの seccompiler-bin

同じ crate から `seccompiler-bin` という実行ファイルも作られる。JSON を渡すとコンパイル済みバイナリを出すだけの薄い CLI で、Firecracker の `--seccomp-filter <path>` で読ませられる。用途として挙げられているのは、公式のデフォルトフィルタが存在しないターゲット（GNU libc ビルドなど）、デバッグビルド、そして「本番で syscall がフィルタに引っかかったときに、新しいバイナリをビルド・デプロイせずに応急処置する」ケースである。ただし `docs/seccompiler.md` は「デフォルトフィルタを上書きする危険な機能であり、設定を誤ればプロセスが突然終了するか、seccomp の境界そのものが無効になる」と警告している。`prod-host-setup.md` も `--seccomp-filter` と `--no-seccomp` の本番利用は非推奨だと書いている。

### デバッグビルドでは seccomp が事実上無効になる

これがこのページで最も注意すべき事実である。`build.rs` は `DEBUG` 環境変数を見て、真ならターゲット別の JSON を無視して `unimplemented.json` を使う。

```rust title="src/firecracker/build.rs"
    let seccomp_json_path = if debug {
        println!(
            "cargo:warning=Using empty default seccomp policy for debug builds: \
             `resources/seccomp/unimplemented.json`."
        );
        format!("{}/unimplemented.json", JSON_DIR)
    } else if !Path::new(&seccomp_json_path).exists() {
```

その `unimplemented.json` の中身はこうである。

```json title="resources/seccomp/unimplemented.json"
    "vmm": { "default_action": "allow", "filter_action": "trap", "filter": [] },
    "api": { ... }, "vcpu": { ... }
```

`default_action` が `allow` で、`filter` が空。どのルールにも一致しないので常に `default_action` が適用され、すべてのシステムコールが通る。BPF プログラム自体はロードされるが、実質的に何も制限しない。`docs/seccomp.md` の警告がこれである。

> On debug binaries and experimental GNU targets, there are no default seccomp filters installed, since they are not intended for production use.

同じ分岐は「そのターゲット用の JSON が存在しない場合」にも走る。`resources/seccomp/` にあるのは `x86_64-unknown-linux-musl.json` と `aarch64-unknown-linux-musl.json` だけなので、GNU libc 向けにビルドすると自動的に `unimplemented.json` になる。どちらの場合も `cargo:warning=` でビルドログに警告は出るが、ビルド自体は成功する。

つまり「seccomp が効いているかどうか」は、実行時のフラグだけでなく**どうビルドされたか**に依存する。`--no-seccomp` を付けていなくても、デバッグビルドなら守られていない。

## ソースコードのどこか

コンパイラ本体は [`src/seccompiler/src/lib.rs#L60-L217`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/seccompiler/src/lib.rs#L60-L217) の `compile_bpf`。libseccomp のコンテキストをカテゴリごとに作ってルールを足し、`memfd` へエクスポートして `Vec<u64>` に読み戻す部分が [`#L161-L182`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/seccompiler/src/lib.rs#L161-L182)、直列化とサイズチェックが [`#L200-L214`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/seccompiler/src/lib.rs#L200-L214)、上限定数が [`#L19-L23`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/seccompiler/src/lib.rs#L19-L23)。

JSON のスキーマは [`src/seccompiler/src/types.rs#L144-L165`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/seccompiler/src/types.rs#L144-L165) の `SyscallRule` / `Filter` / `BpfJson` で定義され、serde の `Deserialize` derive で JSON に対応づいている。`dword` の `eq` を masked-eq に落とす回避策は [`#L46-L75`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/seccompiler/src/types.rs#L46-L75)、libseccomp のバインディングは [`bindings.rs#L83-L168`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/seccompiler/src/bindings.rs#L83-L168)。

ビルドスクリプトは [`src/firecracker/build.rs`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/build.rs) 全体で 56 行しかなく、冒頭のコメントが「JSON の seccomp ポリシーを直列化可能な BPF 形式にコンパイルし、生成されたバイナリコードをコンパイル時に Firecracker のコードへ含める」と役割を説明している。`cargo:rerun-if-changed` を JSON ファイルと seccompiler のソースディレクトリの両方に対して出しているので（[`#L47-L51`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/build.rs#L47-L51)）、どちらを変えても再コンパイルされる。`docs/seccomp.md` が言う「コンパイル済みフィルタはビルドフォルダにキャッシュされ、変更時のみ再コンパイルされる」はこの仕組みである。

埋め込みと読み出しは [`src/firecracker/src/seccomp.rs#L56-L106`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/seccomp.rs#L56-L106)。設定は `SeccompConfig::None` / `Advanced` / `Custom(File)` の 3 値の enum で表される（[`#L25-L53`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/seccomp.rs#L25-L53)）。

デシリアライズ側は [`src/vmm/src/seccomp.rs#L49-L70`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/seccomp.rs#L49-L70)。キーは読み込み時に小文字化される（`map(|(k, v)| (k.to_lowercase(), Arc::new(v)))`）ので、カスタムフィルタで `"VMM"` と書いても通る。

デバッグビルドの分岐は [`src/firecracker/build.rs#L26-L45`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/build.rs#L26-L45)、空フィルタの中身は [`resources/seccomp/unimplemented.json`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/resources/seccomp/unimplemented.json)。警告は [`docs/seccomp.md#L14-L17`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/seccomp.md#L14-L17)。

## なぜそうなっているか

**JSON にする理由は、ポリシーをレビュー可能にするためである。** BPF を直接書けば、「vcpu スレッドが何を呼べるか」を確認するのに逆アセンブルが要る。JSON なら 50 個のルールを目で追えるし、`comment` でその syscall が必要な理由を行ごとに書ける。差分レビューで「このコミットは何を新たに許可したのか」がそのまま読める。

**ビルド時にコンパイルする理由は 2 つある。** ひとつは起動速度。microVM の起動時間を数十 ms のオーダーで詰めているのに、起動のたびに JSON をパースして BPF を組み立てるのは無駄が大きい。もうひとつは jail との相性で、実行時にファイルを読むなら chroot の中にポリシーファイルを置く必要があり、置いた以上は差し替えられる余地も生まれる。

**libseccomp を使う理由は、BPF の生成が退屈で間違えやすいからである。** アーキテクチャチェック（`AUDIT_ARCH_X86_64` の確認を忘れると x32 ABI 経由でフィルタを回避されるという古典的な穴がある）、syscall 番号の解決、64 ビット引数を 2 回に分けて比較する処理。これらを自前で書くとバグが直接セキュリティホールになる。一方で `SCMP_CMP_EQ` の挙動が musl と噛み合わない箇所は自分で回避策を入れている。

**デバッグビルドで無効になるのは、開発体験とのトレードオフである。** 開発中は新しいシステムコールを試すたびにフィルタを更新することになり、忘れると `SIGSYS` でプロセスが死ぬ。デバッグビルドではデバッガやテストハーネスが余分な syscall を呼ぶこともある（`docs/seccomp.md` は `fcntl(F_GETFD)` の例を挙げている）。とはいえ「デバッグビルドを本番に持ち込んだら丸裸」という危険と引き換えで、`cargo:warning=` は出るがビルドは失敗しない。この選択の是非は、ビルド成果物の管理が正しくできている前提に依存する。

## どう活かすか

**セキュリティポリシーは宣言として書き、実行時の表現はそこから生成する。** 「どのシステムコールを許すか」をコード中の `match` 式で書くと、レビューのたびにコードを読む必要が出る。宣言（JSON、YAML、ポリシー DSL）に分離すると、差分がそのまま「許可範囲の変更」として読める。要点は「人が読むための表現」と「機械が評価するための表現」を分け、後者を前者から生成することにある。

**生成のタイミングをビルド時に寄せる。** 起動時に生成すると、起動が遅くなるだけでなく、生成の失敗が実行時エラーになる。ビルド時に生成すればビルドが落ちるので、壊れたポリシーが本番に届かない。Rust なら `build.rs` + `include_bytes!`、他の言語でも同等の仕組みは大抵ある。埋め込むことで「設定ファイルが差し替えられる」という攻撃面も消える。

**ビルド構成でセキュリティ機構が変わるなら、それを目立たせる。** Firecracker は `cargo:warning=` を出しているが、それだけである。自分のプロジェクトでこの構造を採るなら、実行時にも「どのポリシーでビルドされたか」を出す、リリースビルド以外を本番に持ち込めないようにする、といった追加の防壁を考えたい。「フラグを立てなければ有効」ではなく「ビルドの種類によって有効か無効かが決まる」機構は、運用の事故を招きやすい。

**適用条件。** この構成が効くのは、(1) ポリシーが静的（実行時のユーザ設定で変わらない）、(2) ポリシーの表現が最終形と大きく違う（JSON → BPF のように変換が必要）、(3) ビルドと配布を自分で管理している、という条件が揃うときである。ポリシーがテナントごとに違うなら埋め込みは使えないし、そのまま実行時表現になるなら変換段を挟む価値がない。

フィルタがいつ・どのスレッドに適用されるかは[次のページ](../per-thread-seccomp/)で、違反したときに何が起きるかは[その次のページ](../sigsys-handler/)で扱う。
