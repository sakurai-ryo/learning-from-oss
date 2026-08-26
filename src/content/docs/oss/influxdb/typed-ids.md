---
title: "名前ではなく ID で参照し、その ID をマクロで型ごとに作り、マップは「タプルの列」として直列化する"
description: "InfluxDB 3 は WAL にもカタログにもテーブル名や列名を書かない。すべて数値 ID で、その ID は宣言的マクロで 14 種類の別々の型として生成される。ID をキーにしたマップは IndexMap で順序を保ち、直列化では「キーと値のタプルの列」になる。JSON がマップのキーに整数を許さない問題と、順序が変わると差分が読めなくなる問題を、1 つの newtype で同時に解いている。"
sidebar:
  order: 10
---

## 何を学んだか

### どんな状況の話か

[カタログ](../catalog-log-checkpoint/) は「データベース → テーブル → 列」の階層を持つ。[WAL](../wal-object-store/) の各書き込みは、どのテーブルのどの列に何を書いたかを記録する。素直に書けば、どちらも名前 (`"cpu"`、`"host"`) を持つことになる。

しかしそれをやると 3 つの問題が出る。

- **リネームができない。** テーブル名を変えたら、過去の WAL ファイルの中の名前も意味が変わってしまう。
- **サイズが膨らむ。** 1 秒ごとの WAL ファイルに、毎回すべての列名の文字列が入る。
- **取り違えが起きる。** 関数が `u32` を 3 つ受け取るとき、データベース ID とテーブル ID を入れ替えて渡してもコンパイルは通る。

### InfluxDB 3 の答え

1. **永続化する参照はすべて数値 ID にする。** WAL の `WriteBatch` には、テーブル名も列名も入らない。
2. **ID は宣言的マクロで型ごとに生成する。** `DbId`、`TableId`、`ColumnId`、`TokenId` など 14 種類。すべて別の型なので、取り違えはコンパイルエラーになる。
3. **共通の振る舞いは trait `CatalogId` に括る。** `next()`、`checked_next()`、`MAX`。マクロが生成する各型がこれを実装する。
4. **ID をキーにするマップは `SerdeVecMap` を使う。** 中身は `IndexMap` (挿入順を保つハッシュマップ) で、直列化すると **キーと値のタプルの列** になる。
5. **重複キーは deserialize でエラーにする。** 列に落とした以上、重複が入りうるので、戻すときに検査する。
6. **ID の構造そのものも進化している。** 平坦な `ColumnId` から、`ColumnIdentifier::{Timestamp, Tag(TagId), Field(FieldFamilyId, FieldId)}` という構造化された識別子へ。旧 ID は「legacy」として残る。

## ソースコードのどこか

### マクロで型を作る

[`influxdb3_id/src/lib.rs#L34-L92`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_id/src/lib.rs#L34-L92)。

```rust title="influxdb3_id/src/lib.rs"
macro_rules! catalog_identifier_type {
    ($name:ident, $ty:ty) => {
        #[derive(
            Debug, Copy, Clone, Eq, PartialOrd, Ord, PartialEq, Serialize, Deserialize, Hash,
        )]
        pub struct $name($ty);

        impl CatalogId for $name {
            type Integer = $ty;

            const MAX: Self = Self(<$ty>::MAX);

            fn next(&self) -> Self {
                Self::new(self.0.checked_add(1).expect("incrementing id overflow"))
            }

            fn checked_next(&self) -> Option<Self> {
                self.0.checked_add(1).map(Self::new)
            }
        }
```

生成される型のリスト ([`#L94-L107`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_id/src/lib.rs#L94-L107))。

```rust title="influxdb3_id/src/lib.rs"
catalog_identifier_type!(NodeId, u32);
catalog_identifier_type!(QueryGroupId, u32);
catalog_identifier_type!(DbId, u32);
catalog_identifier_type!(TableId, u32);
catalog_identifier_type!(TriggerId, u32);
catalog_identifier_type!(ColumnId, u16);
catalog_identifier_type!(TagId, u16);
catalog_identifier_type!(FieldFamilyId, u16);
catalog_identifier_type!(FieldId, u16);
catalog_identifier_type!(LastCacheId, u16);
catalog_identifier_type!(DistinctCacheId, u16);
catalog_identifier_type!(TokenId, u64);
catalog_identifier_type!(UserId, u64);
catalog_identifier_type!(RoleId, u64);
```

**基底の整数型が用途で違う。** データベースやテーブルは `u32`、列や小さいキャッシュは `u16`、トークンやユーザーは `u64`。1 テーブルの列数は 6 万を超えないが、トークンは長期的に増え続ける、という見積もりがそのまま型に出ている。

`next()` は溢れたら panic、`checked_next()` は `Option` を返す。**「溢れたら困る場所」と「溢れを扱える場所」で呼び分けられる** ようになっている。[カタログのエラー型](../catalog-format-versions/) には `LegacyColumnIdsExhausted` があり、`u16` を使い切る事態が実際に想定されている。

### 増やし方が 2 種類ある

ほとんどの ID はカタログの中で採番される (「次の ID」をカタログが持つ) が、Parquet ファイル ID だけはグローバルなアトミック変数を使う ([`#L109-L136`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_id/src/lib.rs#L109-L136))。

```rust title="influxdb3_id/src/lib.rs"
/// The next file id to be used when persisting `ParquetFile`s
pub static NEXT_FILE_ID: AtomicU64 = AtomicU64::new(0);

impl ParquetFileId {
    pub fn new() -> Self {
        Self(
            NEXT_FILE_ID
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
                .expect("Overflowed with Parquet File IDs"),
        )
    }
```

`set_next_id` があるのは、起動時にスナップショットから復元した最大値でカウンタを進めるため。**プロセスローカルなカウンタを、永続化された状態から初期化する** 形になっている。カタログを通さないぶん安いが、ノードをまたいだ一意性は無い (パスに node id が入るので衝突しない)。

### ID の構造も変わる

現在の列の識別子は、平坦な数値ではない ([`#L226-L250`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_id/src/lib.rs#L226-L250))。

```rust title="influxdb3_id/src/lib.rs"
pub struct FieldIdentifier(pub FieldFamilyId, pub FieldId);

pub enum ColumnIdentifier {
    Timestamp,
    Tag(TagId),
    Field(FieldIdentifier),
}
```

タイムスタンプ列は 1 つしかないので ID を持たない。タグとフィールドは別の名前空間で、フィールドは「フィールドファミリ」で更にグループ化される。**型が、その領域の構造をそのまま表している。**

古い平坦な `ColumnId` も残っていて、`ord_id()` で取れる ([`influxdb3_catalog/src/catalog/versions/v3/schema/column.rs#L66-L77`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_catalog/src/catalog/versions/v3/schema/column.rs#L66-L77))。

```rust title="influxdb3_catalog/src/catalog/versions/v3/schema/column.rs"
    /// Return the legacy column ID, when one is assigned.
    ///
    /// Columns added to a PachaTree-mode table after `u16::MAX` ids have been assigned will
    /// return `None`.
    pub fn ord_id(&self) -> Option<ColumnId> {
```

**`Option` になっているのが移行の跡。** 新しいストレージモードでは legacy ID を振り切ることがあり、そのときは `None` になる。古い経路は `Option` を扱えないところで `LegacyColumnIdsExhausted` エラーを出す。

過去の互換が名前に残っている例もある ([`influxdb3_id/src/lib.rs#L287-L296`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_id/src/lib.rs#L287-L296))。

```rust title="influxdb3_id/src/lib.rs"
impl fmt::Display for ShardId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Keep the legacy `p` prefix because object-store paths still encode
        // shard IDs as `p{shard_id}` for compatibility.
        write!(f, "p{}", self.0)
    }
}
```

`Display` の実装が [オブジェクトストアのパス](../persist-paths/) の互換性に縛られている。名前を変えれば済む話ではなく、**過去に書かれたオブジェクトが残っている限り、この `p` は消せない**。

### ID をキーにしたマップ

[`influxdb3_id/src/serialize.rs#L21-L37`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_id/src/serialize.rs#L21-L37)。doc コメントが理由を 3 つ挙げている。

```rust title="influxdb3_id/src/serialize.rs"
/// A new-type around a [`IndexMap`] that provides special serialization and deserialization behaviour.
///
/// Specifically, it will be serialized as a vector of tuples, each tuple containing a key-value
/// pair from the map. Deserialization assumes said serialization, and deserializes from the vector
/// of tuples back into the map. /* ... */
///
/// During deserialization, there are no duplicate keys allowed. If duplicates are found, an error
/// will be thrown.
///
/// The `IndexMap` type is used to preserve insertion, and thereby iteration order. This ensures
/// consistent ordering of entities when this map is iterated over, for e.g., column ordering in
/// queries, or entity ordering during serialization. Since `IndexMap` stores key/value pairs in a
/// contiguous vector, iterating over its members is faster than a `HashMap`. This is beneficial for
/// WAL serialization.
```

直列化の実装は素朴だ ([`#L143-L157`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_id/src/serialize.rs#L143-L157))。

```rust title="influxdb3_id/src/serialize.rs"
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut seq = serializer.serialize_seq(Some(self.len()))?;
        for ele in self.iter() {
            seq.serialize_element(&ele)?;
        }
        seq.end()
    }
```

戻すときに重複を弾く ([`#L160-L177`](https://github.com/influxdata/influxdb/blob/693b1fd1b96cdcb980cf76a1004c0b3f1b46db48/influxdb3_id/src/serialize.rs#L160-L177))。

```rust title="influxdb3_id/src/serialize.rs"
        let v = deserializer.deserialize_seq(VecVisitor::new())?;
        let mut map = IndexMap::with_capacity_and_hasher(v.len(), FxBuildHasher::default());
        for (k, v) in v.into_iter() {
            if map.insert(k, v).is_some() {
                return Err(de::Error::custom("duplicate key found"));
            }
        }
```

マップを列に落とすと、**「キーが一意」という不変条件が形式から失われる**。だから戻すときに検査する。この 5 行を書かなければ、壊れたファイルが黙って「最後の勝ち」で読み込まれる。

`Deref` / `DerefMut` を `IndexMap` に実装してあるので、使う側は普通のマップとして扱える。**直列化の都合だけを差し替えて、API はそのまま** という形になっている。

## なぜそうなっているか

- **タプルの列にする直接の動機は JSON。** コミット 0e814f5d52 (2024-10) "feat: SerdeVecMap type for serializing ID maps (#25492)" の説明が具体的だ。"If we have a `HashMap<u32, String>`, `serde_json` will serialize it in the following way: `{\"0\": \"foo\", \"1\": \"bar\"}` i.e., the integer keys are serialized as strings, since JSON doesn't support any other type of key in maps." 整数キーが文字列になると、往復で型が変わり、キーの順序も辞書順になる。列にすればどちらも起きない。
- **順序を保つのは、テストと差分のため。** 同じコミット群の d26a73802a (#25495) が説明している。"This has important implications, namely, that when iterating over an ID map, the elements therein will always be produced in the same order which allows us to make assertions on column order in a lot of our tests, and allows for the re-introduction of `insta` snapshots for serialization tests." **スナップショットテストを使うには、直列化結果が決定的でなければならない。** `HashMap` のイテレーション順はハッシュのシードに依存するので、それだけでスナップショットテストが使えなくなる。
- **`IndexMap` は速度の理由でもある。** 「キーと値が連続したベクタに入っているので、イテレーションが `HashMap` より速い。WAL の直列化で有利」。1 秒ごとに全マップを直列化する経路では、ランダムアクセスよりイテレーションの速さが効く。
- **名前から ID への移行は 1 つの大きな PR で行われた。** d26a73802a "refactor: move to `ColumnId` and `Arc<str>` as much as possible" は "the result is a fairly sizeable change set" と自認している。"`WriteBatch` now contains no names for tables or columns and purely uses IDs" が到達点。この種の変更は段階的にやると「名前と ID の両方を持つ」中途半端な期間が長引くので、一気にやる判断も理解できる。
- **`ColumnId` の幅は 2 回変わっている。** 当初はテーブル内で一意な `u16`、上記の PR でグローバルに一意な `u32` に ("This makes it easier to follow the patterns used for creating the other identifier types")、現在は再び `u16` でタグ・フィールドが別の名前空間に分かれている。**識別子の設計は 1 回で決まらない** ことの実例で、だからこそ「legacy」と `Option` を許容する余地が残されている。
- **`Display` に互換の縛りがあるのは、ID が外に漏れているから。** `ShardId` の `p` 接頭辞は、オブジェクトストアのパスに書かれてしまっている。**内部 ID を外部の識別子 (パス、URL、API のレスポンス) に露出させると、そこが凍結される。**

## どう活かすか

- 永続化する参照は **名前ではなく ID** にする。リネームが可能になり、サイズが減り、参照の安定性が上がる。名前は表示のためだけに使い、`Arc<str>` のような共有可能な型で持つ。
- ID の newtype は **マクロで一括生成する**。手で 14 個書くと、`Display` や `FromStr` の実装が型ごとに微妙にずれる。共通の振る舞いは trait に括り、マクロがそれを実装する。
- 基底の整数型は **用途ごとの見積もりから決める**。すべて `u64` にすると WAL やキャッシュのメモリに効いてくる。ただし `u16` を選ぶなら、**使い切ったときの経路** (エラー型、`Option`、`checked_next`) を最初から用意する。
- 溢れの扱いは **`next()` (panic) と `checked_next()` (`Option`) の 2 本** を用意して、呼び出し側に選ばせる。どちらか片方しか無いと、必ず不便な場所が出る。
- 整数キーのマップを JSON など「キーが文字列に限られる形式」で直列化するなら、**タプルの列にする newtype** を 1 つ作る。`Deref` を実装しておけば使う側の変更はほぼ要らない。
- 列に落としたことで失われる不変条件 (キーの一意性) は、**戻すときに検査する**。形式が守ってくれなくなった制約は、コードが守る。
- 直列化結果を **決定的にする** と、スナップショットテストが使える。順序を保つマップを選ぶだけで、テストの書き方が変わる。
- 内部 ID を外部に露出させるときは、**そこで形式が凍結される** と覚悟する。パスや API に出す表現は、内部表現とは別の変換を通す。
