---
title: "永続フォーマットの進化を「版ごとのモジュール」「凍結された ID」「機能水準の半順序」で扱う"
description: "InfluxDB 3 のカタログは v1 から v3 まで形式が変わっている。古い版のコードは消さずに読み込み専用として残し、移行は旧系列に終端マーカーを書いてから新系列を作る。v3 のレコード ID は inventory でコンパイル時に集められ、一度出荷したら凍結される。未知のレコードは UPGRADE_SAFE フラグが立っていれば読み飛ばせる。クラスタ全体の機能水準は、あえて半順序にして「比較できない組み合わせ」を握り潰さない。"
sidebar:
  order: 9
---

## 何を学んだか

### どんな状況の話か

カタログはオブジェクトストアに残り続ける。一方でソフトウェアは更新される。この 2 つが交差するところに、永続フォーマットの互換性という問題がある。

InfluxDB 3 のカタログは、GA から現在までに 3 つの形式を経ている。v1 と v2 は「カタログ全体のスナップショット + 差分ログ」を serde でシリアライズしたもの、v3 は自前のバイナリ形式でレコードを並べたもの。ソースツリーにはその全部が残っている。

```
influxdb3_catalog/src/
  catalog/versions/{v1,v2,v3}.rs      カタログの構造体
  catalog/migrations/{v2,v3}.rs        版から版への変換
  log/versions/{v1,v2,v3,v4}.rs        ログエントリの型
  snapshot/versions/{v1,v2,v3,v4}.rs   スナップショットの型
  format/                              v3 のバイナリ形式
```

しかも運用中のクラスタでは、**新旧のバイナリが同時に同じカタログを触る瞬間** がある。ローリングアップデートの最中がそれだ。新しいノードが書いたものを、古いノードが読もうとする。

### InfluxDB 3 の答え

1. **版ごとにモジュールを分け、古い版は消さずに残す。** 新しい版のコードは古い版に依存せず、変換だけが両方を知っている。
2. **移行は「旧系列を封鎖してから、新系列を作る」順で行う。** 旧カタログのログの末尾に `UpgradedLog` という終端マーカーを create-only で書き、その後で新カタログのスナップショットを書く。マーカーが書かれた後は、旧バージョンのノードは連番が進められず、書き込みが必ず失敗する。
3. **移行は冪等で、並行実行に耐える。** 途中で落ちても次回で完了し、複数ノードが同時に始めても create-only の勝敗で 1 つに収束する。
4. **v3 のレコード ID は「一度出荷したら凍結」。** 削除も並べ替えもしない。使わなくなったら非推奨にして、書き込みだけをやめる。
5. **レコード型はコンパイル時に登録する。** `inventory` クレートで各型が自分を登録し、起動時に `BTreeMap` の索引になる。ID の重複はプロセス起動時に panic で分かる。
6. **未知のレコードの扱いをフラグで表す。** `UPGRADE_SAFE` が立っていれば、知らない ID のレコードは読み飛ばせる。立っていなければ、読めないことをエラーにする。
7. **クラスタの機能水準 (`FeatureLevel`) をバイナリから自動導出し、半順序で比較する。** `Ord` はあえて実装しない。「Core は新しいが Enterprise は古い」ような組み合わせを、比較不能として表に出すため。

## ソースコードのどこか

### ID のルール

[`influxdb3_catalog/src/format/record_ids.rs#L1-L15`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/record_ids.rs#L1-L15)。ファイル冒頭にルールが 4 つ書いてある。

```rust title="influxdb3_catalog/src/format/record_ids.rs"
//! # Rules
//!
//! 1. Never delete a record ID — once assigned, it persists forever.
//! 2. Never reorder — the raw value is persisted in catalog files.
//! 3. Assign sequentially within each partition (core / enterprise).
//! 4. Deprecate, don't remove — keep the record in the registry but stop
//!    producing it on the write path.
```

```rust title="influxdb3_catalog/src/format/record_ids.rs"
// Database operations
pub(crate) const CREATE_DATABASE: RecordId = RecordId::core(4);
pub(crate) const SOFT_DELETE_DATABASE: RecordId = RecordId::core(5);
```

Protocol Buffers のフィールド番号と同じ規律だが、それをスキーマ言語ではなく **Rust の定数とコメントで運用している**。3 番目のルール (連番で振る) は、後述の機能水準の計算に効いてくる。

ID の空間は 1 ビットで分割されている ([`influxdb3_catalog/src/format/record_id.rs#L1-L6`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/record_id.rs#L1-L6))。

```rust title="influxdb3_catalog/src/format/record_id.rs"
//! Bit 15 of the raw `u16` value partitions the ID space:
//! - Core records: bit 15 = 0 (raw values 0x0001–0x7FFF)
//! - Enterprise records: bit 15 = 1 (raw values 0x8001–0xFFFF)
```

OSS 版 (Core) と商用版 (Enterprise) が **別々に ID を採番できる**。同じリポジトリで両方をビルドしていて、Enterprise が独自のレコードを足しても Core の採番と衝突しない。

```rust title="influxdb3_catalog/src/format/record_id.rs"
    /// Create a core record ID. Raw value = seq (bit 15 = 0).
    ///
    /// # Panics
    /// Panics at compile time if seq is 0 or >= 0x8000.
    pub const fn core(seq: u16) -> Self {
        assert!(
            seq > 0 && seq < ENTERPRISE_BIT,
            "core seq must be in 1..32767"
        );
```

`const fn` の中の `assert!` なので、定数として使えば **コンパイル時に検査される**。

### コンパイル時のレジストリ

各レコード型は自分を登録する ([`influxdb3_catalog/src/format/records/database.rs#L69-L90`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/records/database.rs#L69-L90))。

```rust title="influxdb3_catalog/src/format/records/database.rs"
impl CatalogRecord for CreateDatabase {
    const ID: RecordId = record_ids::CREATE_DATABASE;
    const FLAGS: RecordFlags = RecordFlags::none();
    const NAME: &'static str = "CreateDatabase";

    fn apply(&self, catalog: &mut InnerCatalog) -> Result<(), ApplyError> { /* ... */ }

    fn event(&self) -> CatalogEvent { /* ... */ }
}

inventory::submit! {
    RegisteredRecord::new::<CreateDatabase>()
}
```

**1 つの型が、ID・フラグ・名前・適用ロジック・イベントを全部持つ。** 新しいレコードを足すときに触るのは 1 ファイルで、`match` 文の分岐を足し忘れる場所が無い。

集める側 ([`influxdb3_catalog/src/format/registry.rs#L151-L200`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/registry.rs#L151-L200))。

```rust title="influxdb3_catalog/src/format/registry.rs"
inventory::collect!(RegisteredRecord);

impl RecordRegistry {
    fn new() -> Self {
        let mut ops = BTreeMap::new();
        for op in inventory::iter::<RegisteredRecord> {
            let raw = op.id;
            if ops.insert(raw, op).is_some() {
                panic!("duplicate record id: {} ({})", raw, op.name);
            }
        }
        Self { ops }
    }
```

ID の重複は **プロセス起動時に panic** する。コンパイル時には検出できない (別々のファイルの定数が同じ値でも型は合う) が、テストを 1 つ走らせれば必ず踏む。

trait の doc コメントが、この層の性格を宣言している。

```rust title="influxdb3_catalog/src/format/registry.rs"
/// Records are the persistence layer — frozen once shipped. Each record type
/// has a unique ID, flags, and name, and produces a domain event describing
/// the state change.
```

**「出荷したら凍結」** がコードの中に書いてある。だからカタログの内部表現 (`InnerCatalog`、`DatabaseSchema`) は自由に変えられる。変えられないのはレコードの形だけ、という線引きがはっきりしている。

### 未知のレコードをどう扱うか

[`influxdb3_catalog/src/format/registry.rs#L202-L217`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/registry.rs#L202-L217)。

```rust title="influxdb3_catalog/src/format/registry.rs"
/// Validate that a record's flags are appropriate for the given record ID.
///
/// Returns an error if the record ID is unknown and the UPGRADE_SAFE flag is not set.
///
/// Returns `Ok(true)` if the record should be processed (known record).
/// Returns `Ok(false)` if the record should be skipped (unknown but upgrade-safe).
pub fn validate_record_flags(record_id: RecordId, flags: RecordFlags) -> Result<bool, FormatError> {
    if REGISTRY.contains(record_id) {
        Ok(true)
    } else if flags.is_upgrade_safe() {
        Ok(false)
    } else {
        Err(FormatError::UnknownNonUpgradeSafeRecord {
            record_id: record_id.raw(),
        })
    }
}
```

前方互換の扱いを **書き手が 1 ビットで宣言する** 形になっている ([`influxdb3_catalog/src/format/mod.rs#L127-L160`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/mod.rs#L127-L160))。

```rust title="influxdb3_catalog/src/format/mod.rs"
    /// No flags set. Record is feature-gated (default).
    pub const NONE: u16 = 0;
    /// Record can be written before the committed feature level includes it;
    /// readers skip if ID is unknown.
    pub const UPGRADE_SAFE: u16 = 0x0001;
```

既定が `NONE` (=読み飛ばし禁止) なのが安全側の設計だ。「知らないレコードは無視してよい」は、種類によっては危険な仮定になる。たとえば「テーブルを削除した」を無視して読み進めれば、消したはずのテーブルが見えるカタログができあがる。だから **読み飛ばしてよいかどうかは、レコードごとに書き手が判断する**。

### 機能水準は半順序

[`influxdb3_catalog/src/format/feature_level.rs#L11-L45`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/feature_level.rs#L11-L45)。

```rust title="influxdb3_catalog/src/format/feature_level.rs"
/// A cluster feature level: the highest sequential record ID a node
/// understands for Core and Enterprise catalog features, respectively.
pub struct FeatureLevel {
    pub core: u16,
    pub enterprise: u16,
}
```

```rust title="influxdb3_catalog/src/format/feature_level.rs"
/// Derive the local feature level from the compiled record registry.
///
/// Walks every `RegisteredRecord` in `inventory` and tracks the
/// maximum sequence for each of `core` and `enterprise`.
pub fn derive_feature_level() -> FeatureLevel {
    let mut level = FeatureLevel::ZERO;
    for entry in REGISTRY.all() {
        match entry.id.kind() {
            RecordIdKind::Core(core) => {
                level.core = level.core.max(core);
            }
```

**バイナリのバージョン番号を人間が管理しない。** レジストリに登録されたレコード ID の最大値がそのまま「このバイナリが理解できる水準」になる。新しいレコード型を足せば、水準は自動的に上がる。ID を連番で振るルール (ルール 3) が、ここで意味を持つ。

比較の実装が、このページで最も示唆的だ ([`#L48-L82`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/feature_level.rs#L48-L82))。

```rust title="influxdb3_catalog/src/format/feature_level.rs"
/// Component-wise partial order on feature levels.
///
/// Returns `Some(Less)` / `Some(Greater)` only when *both* `core` and
/// `enterprise` components agree on the direction (or are equal). Two
/// levels with crossed components, i.e., one higher and the other lower,
/// are genuinely incomparable (returns `None`), since neither binary can
/// apply the other's full record set.
///
/// This is intentionally not the lexicographic order;
/// `#[derive(PartialOrd)]` would produce: lex order would imply
/// `(3, 5) < (5, 3)`, masking the incomparability that the
/// forward-compatibility checks need to surface.
///
/// `Ord` is deliberately not implemented — the order is partial, and a
/// total-order extension would silently flatten the incomparable cases
/// into one direction or the other.
impl PartialOrd for FeatureLevel {
```

`#[derive(PartialOrd)]` と書けば辞書順の比較が手に入る。しかしそれは **嘘をつく**。Core が新しく Enterprise が古いノードと、その逆のノードは、どちらも相手のレコードを完全には適用できない。辞書順は片方を「新しい」と判定してしまい、その事実が消える。だから `partial_cmp` を手で書いて `None` を返し、`Ord` は実装しない。

`derive` を使わない理由を doc コメントに書いてあるので、後から「なぜ derive しないのか」と思った人が同じ結論に到達できる。

### 移行は封鎖してから作る

[`influxdb3_catalog/src/catalog/migrations/mod.rs#L79-L105`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/migrations/mod.rs#L79-L105)。

```rust title="influxdb3_catalog/src/catalog/migrations/mod.rs"
    // Write the UpgradedLog to the prior catalog log, as once this is committed,
    // nodes running a prior version will no longer be able to load and / or mutate the v1 catalog.
    //
    // Further, the InnerCatalog is loaded, but the sequence number matches
    // the log entry of the one prior to the UpgradedLog, which prevents the catalog
    // from being mutated again. An attempt to persist a log entry will always return
    // PersistCatalogResult::AlreadyExists
```

仕掛けが巧妙だ。旧カタログのログの **次の連番** に `UpgradedLog` を書く。旧バージョンのノードはこのレコードを解釈できないので、自分のカタログの連番はその 1 つ前で止まる。すると次に何かを書こうとしたとき、[楽観的並行制御](../catalog-cas/) の CAS が必ず `AlreadyExists` で失敗する。**新しい仕組みを一切知らない古いバイナリを、既存の仕組みだけで無力化している。**

競合したときの扱いも正直だ。

```rust title="influxdb3_catalog/src/catalog/migrations/mod.rs"
        ) {
            // Another node must have raced and won, writing a log entry with the same sequence number.
            // We don't know if this is an upgrade log or the catalog was mutated, so we must fail
            // and the caller should retry the migration.
            return Err(MigrationError::UpgradeLogAlreadyExists);
        }
```

「相手が何を書いたか分からない」ので、判断せずに失敗して再試行に回す。このエラーだけが `is_retryable()` で true を返す。

v2 → v3 の移行も同じ形で、doc コメントに性質が列挙されている ([`influxdb3_catalog/src/catalog/migrations/v3.rs#L65-L77`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/migrations/v3.rs#L65-L77))。

```rust title="influxdb3_catalog/src/catalog/migrations/v3.rs"
/// Idempotent: re-running after success returns
/// [`MigrationResult::AlreadyMigrated`]; re-running after a partial
/// failure (UpgradedLog written but v3 snapshot missing) completes the
/// write the next time around. Concurrent migration attempts converge
/// via the create-only semantics of the v3 snapshot write — the loser
/// observes its peer's snapshot already on object store and treats
/// `AlreadyExists` as success.
```

冪等性、部分失敗からの回復、並行実行時の収束。移行処理に必要な性質が 3 つとも明記されていて、しかもすべて **create-only の PUT 1 つ** から導かれている。

### v3 の自己記述的なバイナリ

[`influxdb3_catalog/src/format/header.rs#L1-L23`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/header.rs#L1-L23)。

```rust title="influxdb3_catalog/src/format/header.rs"
//! | Offset | Size | Type       | Field           | Description                                     |
//! |--------|------|------------|-----------------|-------------------------------------------------|
//! | 0x00   | 4    | `[u8; 4]`  | magic           | `"IDB3"`                                        |
//! | 0x04   | 4    | `u32`      | format_version  | Currently `1`                                   |
//! | 0x08   | 4    | `u32`      | header_crc      | CRC32 of header bytes 0x0C–0x3F                 |
```

64 バイト固定、4 バイト境界に揃えたヘッダ。マジック、形式バージョン、ヘッダ自身の CRC、カタログ UUID、連番、レコード数、ペイロード長、ペイロードの CRC。**ヘッダとペイロードで CRC が別々** なので、ヘッダだけを読んで健全性を確認できる。

レコード側も 16 バイトの固定ヘッダ (ID・フラグ・連番・長さ) を持つ。長さが入っているので、**知らない ID のレコードでも読み飛ばせる** ([`influxdb3_catalog/src/format/record.rs#L1-L17`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/format/record.rs#L1-L17))。`UPGRADE_SAFE` フラグが機能するのは、この形式のおかげだ。

## なぜそうなっているか

- **版ごとにモジュールを分けたのは、変換を局所化するため。** 「1 つの構造体に `Option` を足して両方の版を表す」形にすると、どのフィールドがどの版で有効かがコード中に散らばる。版ごとに別の型を持てば、変換関数だけが両方を知り、それ以外は自分の版だけを見ればよくなる。代償はコード量で、`catalog/versions/` は 7 万行を超える (半分以上はテスト)。
- **`Ord` を実装しないのは、間違った比較を書けなくするため。** 半順序を全順序に拡張すると、`sort()` も `max()` も使えるようになって便利だが、**比較不能という情報が消える**。ここでは「比較不能なら、そのノードは参加させない」という判断が必要なので、消えては困る。「便利さを捨てて、正しさを型で守る」の実例。
- **機能水準をバイナリから導出するのは、人間が更新を忘れるから。** 「新しいレコードを足したら定数を +1 する」を手でやると、必ずどこかで忘れる。レジストリの最大値を取れば、レコードを足した瞬間に自動で上がる。ID を連番で振るという規律が、この自動化の前提になっている。
- **`UpgradedLog` は、古いバイナリを変更せずに止める唯一の方法。** ローリングアップデート中の古いノードは、こちらから書き換えられない。だから **古いノードが必ず従う既存の規則 (連番の CAS)** を使って詰ませる。新しい仕組み (フラグ、バージョンチェック) を足しても、それを見ないバイナリには効かない。
- **移行の性質が doc コメントに列挙されているのは、テストしにくいから。** 「部分失敗から回復する」「並行実行で収束する」は、実際に落としたり同時に走らせたりしないと確認できない。せめて **どういう性質を意図しているか** を書いておけば、レビューでも障害調査でも参照できる。

## どう活かすか

- 永続フォーマットは **版ごとにモジュールを分け、古い版は消さずに読み込み専用として残す**。新しい版から古い版へ依存させず、変換関数だけが両方を知る形にする。
- 永続化される識別子 (レコード ID、フィールド番号、enum のタグ) には **「消さない・並べ替えない・非推奨にするだけ」というルールを、定数の隣にコメントで書く**。スキーマ言語が守ってくれないなら、人間の規律で守るしかない。
- **識別子の空間をビットで分割** すれば、別々のチームやエディションが衝突せずに採番できる。`const fn` の中の `assert!` で境界を守れば、コンパイル時に弾ける。
- 型ごとの登録 (`inventory` のようなクレート) を使うと、**「新しい型を足したときに触る場所」が 1 ファイルに閉じる**。中央の `match` 文は、足し忘れが起きる場所として最も典型的なもの。
- 「知らないデータをどう扱うか」を **データ自身にフラグで持たせる**。読み手のバージョンで一律に決めると、「無視してよいもの」と「無視したら壊れるもの」を区別できない。既定は安全側 (無視禁止) に倒す。
- 比較が本質的に半順序なら、**`Ord` を実装しない**。`#[derive(PartialOrd)]` の辞書順が意味を持つか、必ず確認する。持たないなら手で書き、なぜ derive しないかをコメントに残す。
- バージョン番号を人間に管理させず、**コードから導出する**。手で上げるものは必ず忘れられる。
- 古いバイナリを止めたいときは、**古いバイナリが既に従っている規則を使って詰ませる**。新しいフラグやチェックは、それを見ない相手には効かない。
- 移行処理には「冪等」「部分失敗から回復」「並行実行で収束」の 3 つが要る。**この 3 つを doc コメントに明記し、どの仕組みがそれを保証しているか** まで書く。
