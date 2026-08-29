---
title: "Versionize をやめて、バージョンを丸ごと上げる方式にした"
description: "Firecracker はかつて versionize という自前のフィールド単位バージョニング機構でスナップショットの後方互換を保っていたが、2023 年にそれを捨てて serde + bincode（現在は bitcode）に移行した。状態構造体に変更が入るたびに SNAPSHOT_VERSION の MAJOR を上げる運用になり、実際 2 年半で 1.0.0 から 11.0.0 まで上がっている。"
group: "スナップショット"
sidebar:
  order: 43
---

## 何を学んだか

### 現在のバージョン管理は「MAJOR を上げるだけ」

Firecracker のスナップショットフォーマットには、Firecracker のバイナリバージョンとは独立した `MAJOR.MINOR.PATCH` のバージョンがある。現在の値は **11.0.0** で、`src/vmm/src/persist.rs` の定数 1 個で決まっている。

このバージョンの運用は極端に単純である。**`MicrovmState` に到達する構造体のどれか 1 つでもフィールドが増減したら、MAJOR を 1 上げる。** MINOR と PATCH は使われていない。git の履歴を見ると、serde に移行した 2023 年 11 月に 1.0.0 として出発してから、この定数は 10 回書き換えられ、毎回 MAJOR だけが上がっている。

```
2023-11   1.0.0  serde に移行（versionize を廃止）
2024-02   2.0.0  VMGenID を追加
2024-08   3.0.0
2024-11   4.0.0
2024-11   5.0.0  vsock の max_connections / max_pending_resets を削除
2025-04   6.0.0
2025-04   7.0.0  aarch64 の PVTime 対応
2025-07   8.0.0  MMDS の状態構造体を一般化
2026-01   9.0.0  bincode -> bitcode に移行
2026-03  10.0.0  シリアル (UART) の状態を保存対象に追加
2026-06  11.0.0
```

つまり **Firecracker は「古いスナップショットを新しいバイナリで読む」ことを構造的に諦めている。** バージョン番号は互換性を維持するための道具ではなく、非互換を検出して早く失敗するための道具である。

### ロード時の判定は semver 的だが、実質は完全一致

```
major が違う              -> InvalidFormatVersion で拒否
minor が自分より大きい     -> InvalidFormatVersion で拒否
minor が自分以下          -> 受け入れる
patch                    -> 一切見ない
```

形としては「同じ MAJOR の範囲内で、自分が知っている MINOR まで読める」という普通の semver 互換ルールになっている。ただし MINOR が使われていない以上、実際に通るのは「MAJOR が一致し、MINOR が 0」つまり完全一致だけである。**枠組みだけ将来のために用意してあり、今は使っていない。**

### 昔は versionize という別の機構があった

2023 年 11 月より前、Firecracker は `versionize` / `versionize_derive` という自前のクレートを使っていた。これは serde と違い、**フィールド単位で「このフィールドは v3 から追加された」といったメタデータを持てる**仕組みで、古いバージョン向けのスナップショットを書き出すこともできた。実際、当時の Firecracker は `--version` に「サポートするスナップショットバージョンの一覧」を表示し、CPU テンプレートの機能によっては「最低でも target snapshot version 1.5 が必要」といった制約が生まれていた。

現在のリポジトリを `versionize` で grep すると **ヒット数は 0** である。依存もコードも痕跡が残っていない。

### 互換性の保証範囲はもともと狭い

バージョン番号が一致しても、復元できるとは限らない。ドキュメントが明示している制約は次のとおりである。

- **CPU モデル**: 同一アーキであっても CPU モデルをまたぐ復元は保証されない。Intel と AMD をまたぐ復元はサポート外。ゲストに見せる CPU 機能が保存時と復元時で不変であることが条件になる。
- **ホストカーネル**: 同一バージョンなら問題ないが、バージョンが違うと保存された KVM 状態の意味が変わりうるため「不安定」と位置づけられている。例外的に、同一の `.metal` インスタンス種別で 5.10 → 6.1 という一方向だけは動作実績があると表に載っているが、本番非推奨と書かれている。
- **外部リソース**: tap デバイス名、ブロックデバイスのファイルパス、vsock の Unix ドメインソケット名は状態ファイルの中に文字列として入っている。復元先に同じ名前で存在しなければならない。

**スナップショットフォーマットのバージョンが守っているのは「バイト列を構造体に戻せるか」だけで、「戻した構造体で VM が動くか」は別の話である。**

## ソースコードのどこか

バージョン定数は [`src/vmm/src/persist.rs#L165-L166`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L165-L166) の 2 行だけである。

```rust title="src/vmm/src/persist.rs"
/// Snapshot version
pub const SNAPSHOT_VERSION: Version = Version::new(11, 0, 0);
```

型は `semver::Version`。バイナリはこれを `--snapshot-version` で表示する（[`src/firecracker/src/main.rs#L297-L300`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/main.rs#L297-L300)）。既存のスナップショットファイルの側のバージョンは `--describe-snapshot <path>` で読める。

ロード時の判定は [`src/vmm/src/snapshot/mod.rs#L153-L178`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/snapshot/mod.rs#L153-L178) にある。magic の検査とバージョンの検査が並んでいる。

```rust title="src/vmm/src/snapshot/mod.rs"
        let snapshot: Self = bitcode::deserialize(buf)?;

        // Validate the header
        if snapshot.header.magic != SNAPSHOT_MAGIC_ID {
            return Err(SnapshotError::InvalidMagic(snapshot.header.magic));
        }

        if snapshot.header.version.major != SNAPSHOT_VERSION.major
            || snapshot.header.version.minor > SNAPSHOT_VERSION.minor
        {
            return Err(SnapshotError::InvalidFormatVersion(
                snapshot.header.version.clone(),
            ));
        }
```

`patch` は条件式に現れない。テストがその意図を明示している（[`src/vmm/src/snapshot/mod.rs#L348-L361`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/snapshot/mod.rs#L348-L361)）。`patch` を `0`、`SNAPSHOT_VERSION.patch + 1`、`1024` に書き換えてもロードが通ることを 3 回に分けて確かめている。

ここで気づくのは、**バージョンの検査がデシリアライズの後に来ている**ことだ。`bitcode::deserialize::<Snapshot<MicrovmState>>(buf)` が先に走り、その結果のヘッダを見てバージョンを判定する。構造体のレイアウトが変わっていればデシリアライズ自体が失敗するので、多くの場合は「バージョン不一致」ではなく「bitcode エラー」として現れる。`get_format_version()` のコメントがそのことを認めている（[`src/vmm/src/snapshot/mod.rs#L114-L121`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/snapshot/mod.rs#L114-L121)）。

```rust title="src/vmm/src/snapshot/mod.rs"
        Err(e) => {
            // If deserialization fails, it could be due to:
            // 1. The snapshot was created with bincode (older versions)
            // 2. The MicrovmState structure has changed and is incompatible
            // 3. The snapshot file is corrupted
            // Since supporting bincode is out of scope, we return a descriptive error.
            Err(SnapshotError::Bitcode(e))
        }
```

**「古いフォーマットのサポートは対象外」と明言している。** 3 つの原因を区別しない、という判断がそのままコメントになっている。

方針の根拠は `docs/snapshotting/versioning.md` にある。

> Currently, Firecracker uses the [Serde bitcode encoder](https://github.com/SoftbearStudios/bitcode) for serializing the microVM state. The encoding format that bitcode uses does not allow backwards compatible changes in the state, so essentially every change in the microVM state description will result in bump of the format's `MAJOR` version. If the needs arises, we will look into alternative formats that allow more flexibility with regards to backwards compatibility.

「エンコーディングが後方互換な変更を許さないので、状態記述への変更はすべて MAJOR を上げる」。MINOR が使われていない理由もここにある。**そもそも MINOR で表現できる変更（フィールドの追加）がフォーマット上あり得ない。**

## なぜそうなっているか

### versionize を捨てたときに何が失われたか

`versionize` の依存は 2023 年 11 月のコミット `b57472e07`（"snapshot: remove versionize dependencies"）で消えている。その少し前の `4c558fb27`（"snapshot: switch to using serde instead of Versionize"）が `SNAPSHOT_VERSION = 1.0.0` を導入している。

CHANGELOG は 2 つの変更を並べて記録している。片方は能力の削除である。

> [#4194](https://github.com/firecracker-microvm/firecracker/pull/4194): Removed support for creating Firecracker snapshots targeting older versions of Firecracker. With this change, running 'firecracker --version' will not print the supported snapshot versions.

もう片方は新しい方針の宣言である。

> [#4230](https://github.com/firecracker-microvm/firecracker/pull/4230): Changed microVM snapshot format version strategy. (...) This change renders all previous Firecracker snapshots (up to Firecracker version v1.6.0) incompatible with the current Firecracker version.

**過去のスナップショットを全部切り捨てる、と明記して切り替えている。** ここで失われたのは「新しい Firecracker で、古い Firecracker が読めるスナップショットを作る」機能である。これはブルーグリーンなデプロイでは価値がある機能だった。

### なぜ細粒度のバージョニングが割に合わなかったか

推測を含むが、コストの構造は読み取れる。versionize 方式では、**状態構造体のフィールドを 1 つ足すたびに「このフィールドは vN から」「旧バージョンへ書き出すときのデフォルト値は何か」を人間が書く**必要がある。そして正しさを保証するには、サポートする全バージョンの組み合わせで往復テストを回さなければならない。

`MicrovmState` から到達する型は、KVM の C 構造体（`kvm_regs`、`kvm_lapic_state`、`kvm_irqchip`、`kvm_pit_state2` など）を含めると相当な数になる。しかもこれらはホストカーネルが定義する型であり、Firecracker が制御できない。**フィールド単位のバージョニングを全部に行き渡らせるコストは、状態の広さに比例して膨らむ。**

一方、バージョンを丸ごと上げる方式のコストは「古いスナップショットを新しいバイナリで読めない」という運用上の制約だけである。Firecracker の想定ユースケース（同一ホスト、あるいは同一世代のホスト群で、短時間のうちに保存と復元をする）では、この制約が実際に痛む場面はそう多くない。すでに CPU モデルとホストカーネルという、はるかに厳しい制約が別途かかっている。

**そもそも「バージョン V-2 のバイナリが読める形式で書き出せる」ことに意味があるのは、CPU とカーネルの互換性が保証されている場合に限られる。** 下の層に強い制約がある以上、上の層だけ柔軟にしても効かない。

### bincode から bitcode への移行はメンテナンス上の理由

2026 年 1 月のコミット `37480d9ca` が bincode から bitcode に移行している。理由は互換性ではなくメンテナンス状況である。

> Reason: the bincode crate is no longer maintained [1].
> [1] https://rustsec.org/advisories/RUSTSEC-2025-0141

このとき CRC の書き方が変わっている。コミットメッセージが説明している。

> Since, unlike bincode, bitcode does not support with_fixed_int_encoding mode, the snapshot CRC field is now written as plain bytes to guarantee that its length is not going to change due to potential future changes in the serialisation logic.

bincode 時代は CRC もシリアライザ経由で書いていたが、bitcode は整数の固定長エンコーディングを持たないので、**シリアライザの都合で CRC のバイト長が変わりうる**。そこで CRC だけ生バイト列で書くようにした（[`src/vmm/src/snapshot/mod.rs#L220-L228`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/snapshot/mod.rs#L220-L228)）。

「末尾 8 バイトが CRC である」というのはフォーマットの規約であり、シリアライザの実装詳細に左右されてはいけない。**フォーマットの一部として固定したいものは、シリアライザに任せない。** シリアライザを乗り換えたときに初めて表面化した種類の設計上の問題である。

なお `docs/snapshotting/versioning.md` は「必要が生じたら、後方互換により柔軟な別のフォーマットを検討する」と書いている。今の方式が最終形だと宣言してはいない。

## どう活かすか

### 「移行を維持するコスト」と「切り捨てるコスト」を数える

永続化フォーマットのバージョニングでは、大きく 2 つの戦略がある。

1. **細粒度のマイグレーション。** フィールドごとに導入バージョンを持ち、読み込み時に埋める。古いデータを永久に読める。protobuf、Avro、versionize がこれ。
2. **丸ごとバージョンを上げる。** 互換性のない変更を検出して拒否するだけ。移行が必要ならデータを作り直す。

1 のコストは **変更のたびに発生し、サポート範囲に比例して増え続ける**。2 のコストは **互換性が切れたときに一度だけ、運用側で発生する**。

Firecracker が 2 を選べたのは、次の条件が揃っていたからだ。

- スナップショットの寿命が短い。長期アーカイブではなく、起動高速化のためのキャッシュに近い。
- 下の層（CPU モデル、ホストカーネル）にもっと厳しい制約があり、上の層だけ柔軟にしても効果が限られる。
- 状態の構造が広く、しかも一部は他所（Linux カーネル）が定義している。

逆に、**永続データが年単位で残る、あるいはフォーマットの制御権が自分たちにある**なら、1 を選ぶ価値がある。判断材料は「データの寿命 ÷ リリース間隔」である。この比が小さければ 2 でよい。

### 拒否は早く、理由は具体的に

2 の戦略を採るなら、非互換を「壊れた挙動」ではなく「明示的なエラー」として出すことが必須になる。Firecracker は 4 段構えにしている。

- **magic** — アーキが違えばバージョン以前に拒否する。
- **version** — 数値で拒否し、エラーに実際のバージョンを載せる（`InvalidFormatVersion(Version)`）。
- **CRC64** — 偶発的な破損を検出する。
- **`--snapshot-version` / `--describe-snapshot`** — 運用者が事前に突き合わせられる CLI。

最後の 1 つが地味に効く。**バイナリが何を読めるか、ファイルが何であるかを、VM を起動しないで確認できる。** 互換性を切り捨てる設計を採るなら、切れていることを安く確認できる手段を同時に用意する必要がある。

### フォーマットの規約とシリアライザの都合を混ぜない

CRC を生バイトで書くようにした変更は、小さいが一般性がある。**「このファイルの末尾 8 バイトは CRC」といった規約は、シリアライザのバージョンアップで壊れてはいけない。** ヘッダのマジック、長さフィールド、チェックサムのような「フォーマットの骨格」は、シリアライザの外側で直接バイト列として扱う。中身の構造体だけをシリアライザに任せる。

この分離をしていないと、シリアライザの乗り換えがフォーマットの非互換を引き起こす。Firecracker の場合はもともと MAJOR を上げる運用なので実害は小さかったが、そうでないシステムでは致命的になりうる。
