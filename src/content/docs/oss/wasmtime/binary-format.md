---
title: "Wasm バイナリは 12 のセクションでできている"
description: "Wasm バイナリは 8 バイトのヘッダの後ろに、番号の付いたセクションが決まった順で並ぶだけの形式である。type から datacount までの 12 セクションと custom セクションが何を含み、Wasmtime がそれを `wasmtime_environ::Module` のどのフィールドに落とすかを、`translate_payload` の巨大な match から読む。index space が「import が先、defined が後ろ」になっている理由と、その帰結も追う。"
group: "WebAssembly をゼロから"
sidebar:
  order: 2
---

Wasm バイナリの物理構造は驚くほど単純だ。`\0asm` の 4 バイトとバージョンの 4 バイトが来て、その後は「1 バイトのセクション ID、LEB128 のサイズ、そのサイズ分のペイロード」という組が並ぶだけである。ID が 1 から 12 までの 12 種類が仕様のコアで、ID 0 は custom セクション、13 は例外の proposal が足した tag セクションだ。

このページで見るのは、**その 12 のセクションがそれぞれ何を宣言していて、Wasmtime がそれを何に変換するか**、そして **index space が「import が先」になっている理由**の 2 つだ。

## セクションを一列に処理する巨大な match

Wasmtime のフロントエンドは `wasmparser` の `Parser` にバイト列を食わせ、返ってくる `Payload` を 1 つずつ処理する。それだけである。

```rust title="crates/environ/src/compile/module_environ.rs"
pub fn translate(
    mut self,
    parser: Parser,
    data: &'data [u8],
) -> Result<ModuleTranslation<'data>> {
    self.result.wasm = data;

    for payload in parser.parse_all(data) {
        self.translate_payload(payload?)?;
    }

    Ok(self.result)
}
```

[crates/environ/src/compile/module_environ.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/compile/module_environ.rs#L438-L451)

`translate_payload` は 500 行近い巨大な match で、アームがそのままセクションの一覧になっている。**Wasm のバイナリ形式を知りたいなら、この関数を上から下まで読むのが一番速い。** 各アームは必ず `self.validator.<section>_section(...)` を最初に呼んで検証を通し、その後で自前のデータ構造 `Module` に記録する。

各セクションが何を宣言し、どこに落ちるかは次のとおりだ。

| ID  | セクション | 宣言するもの                                           | `Module` の落とし先                                        |
| --- | ---------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| 1   | type       | 関数シグネチャ・構造体・配列の型                       | `types: TryPrimaryMap<TypeIndex, EngineOrModuleTypeIndex>` |
| 2   | import     | 外から受け取る関数・テーブル・メモリ・グローバル・タグ | `initializers` と `num_imported_*`                         |
| 3   | function   | 定義する関数の型インデックスだけ (本体は含まない)      | `functions`                                                |
| 4   | table      | テーブルの要素型と上下限                               | `tables` + `table_initialization`                          |
| 5   | memory     | 線形メモリの上下限・共有か否か・ページサイズ           | `memories`                                                 |
| 6   | global     | グローバル変数の型と初期化式                           | `globals` + `global_initializers`                          |
| 7   | export     | 外に出す名前と、それが指す index                       | `exports: TryIndexMap<Atom, EntityIndex>`                  |
| 8   | start      | インスタンス化直後に呼ぶ関数                           | `startup`                                                  |
| 9   | element    | テーブルの初期化データ (active / passive / declared)   | `table_initialization` / `passive_elements`                |
| 10  | code       | 関数本体のバイト列                                     | `function_body_inputs` (`Module` には入らない)             |
| 11  | data       | 線形メモリの初期化データ (active / passive)            | `memory_initialization`                                    |
| 12  | datacount  | data セグメントの総数                                  | **何にも落ちない**                                         |
| 0   | custom     | 名前・DWARF・分岐ヒントなど任意のもの                  | `debuginfo` / `branch_hints`                               |

## type セクションは rec group 単位で処理される

型セクションの処理は、型を 1 つずつ読むのではなく **rec group (再帰グループ) 単位**で回る。GC proposal が入って型が相互再帰できるようになった結果、正規化の単位が個々の型ではなく rec group になったためだ。

```rust title="crates/environ/src/compile/module_environ.rs"
// Iterate over each *rec group* -- not type -- defined in the
// types section. Rec groups are the unit of canonicalization
// and therefore the unit at which we need to process at a
// time. `wasmparser` has already done the hard work of
// de-duplicating and canonicalizing the rec groups within the
// module for us, we just need to translate them into our data
// structures. Note that, if the Wasm defines duplicate rec
// groups, we need copy the duplicates over (shallowly) as well,
// so that our types index space doesn't have holes.
let mut type_index = 0;
while type_index < count {
    let validator_types = self.validator.types(0).unwrap();
    let core_type_id = validator_types.core_type_at_in_module(type_index);
    let rec_group_id = validator_types.rec_group_id_of(core_type_id);

    // Intern the rec group and then fill in this module's types
    // index space.
    let interned = self.types.intern_rec_group(validator_types, rec_group_id)?;
    let elems = self.types.rec_group_elements(interned);
    let len = elems.len();
    self.result.module.types.reserve(len)?;
    for ty in elems {
        self.result.module.types.push(ty.into())?;
    }

    type_index += u32::try_from(len).unwrap();
}
```

重要なのは最後のコメントだ。同じ rec group が 2 回書かれていたら、intern した結果は同じ 1 つを指すが、**モジュールの型 index space には両方分のエントリを積まなければならない**。index space は「バイナリに書かれた順の連番」であって、内容の一意性とは無関係だからである。ここで穴を空けると、後続のセクションが `TypeIndex` で参照したときに全部ずれる。

rec group が Engine 全体で共有される仕組みは [型のライフタイムを、再帰グループ単位の参照カウントで管理する](../type-registry/) で扱う。

## index space は「import が先、defined が後ろ」

Wasm の各エンティティ (関数、テーブル、メモリ、グローバル、タグ) には、種類ごとに独立した index space がある。そしてこの index space は、**import セクションで宣言されたものが必ず 0 番から詰まり、モジュール自身が定義するものはその後ろに続く**。

```text
FuncIndex の index space (import が 2 つ、定義が 3 つの場合)

    0        1        2        3        4
  +--------+--------+--------+--------+--------+
  | import | import | defined| defined| defined|
  +--------+--------+--------+--------+--------+
  \-----------------/\--------------------------/
    num_imported_funcs = 2      DefinedFuncIndex
                                  0    1    2
```

これは規約ではなく、パーサの動作から自動的にそうなる。import セクションはセクション ID が 2 で、function セクション (3) や table セクション (4) より必ず先に来る。そして `declare_import` は `push_function` などを呼んで同じ配列に積む。順序が決まっているから、境界は単なるカウンタで表せる。

```rust title="crates/environ/src/module.rs"
/// Convert a `FuncIndex` into a `DefinedFuncIndex`. Returns None if the
/// index is an imported function.
#[inline]
pub fn defined_func_index(&self, func: FuncIndex) -> Option<DefinedFuncIndex> {
    if func.index() < self.num_imported_funcs {
        None
    } else {
        Some(DefinedFuncIndex::new(
            func.index() - self.num_imported_funcs,
        ))
    }
}
```

[crates/environ/src/module.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/module.rs#L329-L490)

`FuncIndex` と `DefinedFuncIndex` が別の型になっているのがポイントだ。前者は wasm のバイナリに書かれた番号、後者は「このモジュールが自分で定義した何番目か」で、後者だけがコンパイル対象になり、VMContext の中に実体を持つ。同じ変換が table / memory / global / tag にもある。この 2 つを取り違えるのは Wasm ランタイムを書くときの定番のバグで、**型で分けてしまえば `num_imported_*` の加減算を書き忘れることがなくなる**。

### ただし import の宣言順は復元できない

一方で、`num_imported_*` からは分からないことがある。import セクションの中では関数・メモリ・グローバルが**混在した順**で並んでいるので、「この関数は import リストの何番目か」は種類別のカウンタでは求まらない。

```rust title="crates/environ/src/module.rs"
/// Note that this has to scan the initializers: imports of different kinds
/// are interleaved in declaration order, so an import's position is not
/// recoverable from the `num_imported_*` counts alone.
pub fn import_position(&self, entity: EntityIndex) -> Option<usize> {
    if !self.is_imported(entity) {
        return None;
    }
    self.initializers.iter().position(|i| match i {
        Initializer::Import { index, .. } => *index == entity,
    })
}
```

だから `Module` は `num_imported_*` とは別に `initializers: TryVec<Initializer>` を「宣言された順そのまま」で持っている。インスタンス化のときに埋め込み側が渡す import の配列は、この順序に従う ([Linker と、インスタンス化の「後戻りできない点」](../linker-and-instantiation/))。

## function と code が別セクションである理由

Wasm の関数は、**型の宣言 (function セクション) と本体 (code セクション) が離れた場所に置かれる**。一見冗長だが、これが並列コンパイルの前提になっている。

function セクションはただの型インデックスの列で、すごく小さい。これを先に全部読めば、code セクションに到達した時点で **全関数のシグネチャがすべて確定している**。だから code セクションのエントリは、他のどの関数の本体も見ずに単独で検証・コンパイルできる。

```rust title="crates/environ/src/compile/module_environ.rs"
Payload::CodeSectionEntry(body) => {
    let validator = self.validator.code_section_entry(&body)?;
    let func_index =
        self.result.code_index + self.result.module.num_imported_funcs as u32;
    let func_index = FuncIndex::from_u32(func_index);
    // ...
    self.result
        .function_body_inputs
        .push(FunctionBodyData { validator, body });
    self.result.code_index += 1;
}
```

ここで `num_imported_funcs` を足しているのが、さっきの index space の話そのものだ。code セクションの n 番目のエントリは `DefinedFuncIndex(n)` であり、`FuncIndex` にするには import 分をずらす必要がある。

そして `function_body_inputs` には**バイト列と検証器だけ**が積まれ、この場では何もパースされない。実際の翻訳は関数ごとに別スレッドへ渡される ([パースと検証をインターリーブし、関数本体だけ遅延する](../interleaved-validation/))。

## datacount セクションは何も記録しない

12 番の datacount セクションは data セグメントの総数を持つ。名前からすると領域の事前確保に使えそうだが、Wasmtime はこれを検証器に渡すだけで、自分では何も記録しない。

```rust title="crates/environ/src/compile/module_environ.rs"
Payload::DataCountSection { count, range } => {
    self.validator.data_count_section(count, &range)?;

    // Note: the count passed in here is the *total* segment count
    // There is no way to reserve for just the passive segments as
    // they are discovered when iterating the data section entries
    // Given that the total segment count might be much larger than
    // the passive count, do not reserve anything here.
}
```

理由がそのままコメントに書いてある。**Wasmtime が別枠で保持したいのは passive セグメントだけ**で、datacount が持っているのは active と passive を合わせた総数だ。active が大量にある巨大なモジュールでこの総数分を `reserve` すると、実際には使われないメモリを大きく確保することになる。

では datacount は何のためにあるのか。これは `memory.init` / `data.drop` 命令の検証のためだ。これらの命令は data セグメントを番号で参照するが、code セクション (10) は data セクション (11) より前に来る。datacount がなければ、code を検証している時点でセグメントが何個あるか分からず、番号の妥当性を判定できない。**datacount はランタイムのためではなく、1 パス検証を成立させるために存在するセクション**である。

## start / element / data は「起動関数」に畳まれる

start セクションと、passive な element セグメント、そして複雑なグローバル初期化式は、いずれも `require_startup_func()` を呼ぶ。

```rust title="crates/environ/src/compile/module_environ.rs"
Payload::StartSection { func, range } => {
    self.validator.start_section(func, &range)?;

    let func_index = FuncIndex::from_u32(func);
    debug_assert!(self.result.start_func.is_none());
    self.result.start_func = Some(func_index);

    // To make startup a bit easier, invoking the `start` function
    // is a responsibility deferred to the startup function.
    self.require_startup_func();
}
```

Wasmtime は「インスタンス化のときにホスト側の Rust コードでやること」をできるだけ減らし、代わりに**合成した wasm 関数 1 つ**にまとめてしまう。`ModuleStartup` という enum がその状態を持っていて、`None` (何も要らない) / `Always` (必ず呼ぶ) / `IfMemoriesNeedInit` (線形メモリが実際に初期化を要求したときだけ呼ぶ) の 3 値を取る。3 番目は copy-on-write でメモリイメージをそのまま貼れた場合に起動関数を丸ごと飛ばすための最適化で、[copy-on-write でインスタンス化を速くする](../cow-instantiation/) につながる。

## custom セクションは検証されない

ID 0 の custom セクションは名前と任意のバイト列だけを持ち、**仕様上どんな内容でもよく、検証もされない**。Wasmtime が中身を見るのは 3 種類だけだ。

```rust title="crates/environ/src/compile/module_environ.rs"
fn register_custom_section(&mut self, section: &CustomSectionReader<'data>) {
    match section.as_known() {
        KnownCustom::Name(name) => {
            let result = self.name_section(name);
            if let Err(e) = result {
                log::warn!("failed to parse name section {e:?}");
            }
        }
        KnownCustom::BranchHints(reader) if self.tunables.branch_hinting => {
            // Branch hints are advisory and this section is never validated;
            // it is decoded lazily during compilation, so record only the
            // per-function sub-readers here. Discard the whole section if any
            // entry is malformed rather than applying it partially.
            // ...
        }
        _ => {
            let name = section.name().trim_end_matches(".dwo");
            if name.starts_with(".debug_") {
                self.dwarf_section(name, section);
            }
        }
    }
}
```

`name` セクションのパースに失敗しても `log::warn!` を出して**そのまま先へ進む**。分岐ヒントも、1 エントリでも壊れていたらセクション全体を捨てる。custom セクションは意味論に影響しないと仕様が保証しているので、壊れていても実行を止める理由がない。逆に言えば **custom セクションの内容を信用して最適化の正しさを賭けてはならない**、ということでもある。分岐ヒントが「advisory」と書かれているのはそういう意味だ。

なお、Wasmtime が自分で作る `.cwasm` ファイルも、この「custom セクションは何でもよい」性質を利用している ([.cwasm は ELF そのものである](../cwasm/))。

## どう活かすか

このセクション構成が教えてくれるのは、**フォーマットの並び順そのものを、処理系の制約に合わせて設計できる**ということだ。function と code を分けたのは並列コンパイルのため、datacount を足したのは 1 パス検証のため、import を先頭に固定したのは index space の境界をカウンタ 1 個で表せるようにするため。どれも「読み手が 1 回のパスで済むように」という一貫した動機から来ている。

自分でバイナリ形式やスキーマを設計するとき、「後ろで必要になる情報を、必要になる前に置く」という原則は素直に持ち帰れる。

次は、type セクションが宣言している「型」そのものを見る ([型システム — 4 つの独立した型階層](../type-system/))。
