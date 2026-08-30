---
title: "Tunables を全フィールド分割代入して、互換性の判断漏れを防ぐ"
description: "事前コンパイルした .cwasm を別の Engine で読み込んでよいかは、コンパイル設定が一致するかで決まる。Wasmtime はその判定を「構造体を分割代入して全フィールドを列挙する」という書き方で実装している。設定を 1 つ足すとコンパイルが通らなくなるので、判断漏れが構造的に起きない。照合しないフィールドには 1 つずつ理由が書いてある。"
group: "AOT とキャッシュ"
sidebar:
  order: 64
---

事前コンパイル済みの `.cwasm` を読み込むとき、Wasmtime は「このバイナリは今の `Engine` の設定と互換か」を検査する。検査項目は 5 つある。

```rust title="crates/wasmtime/src/engine/serialization.rs"
    fn check_compatible(mut self, engine: &Engine) -> Result<()> {
        self.check_triple(engine)?;
        self.check_shared_flags(engine)?;
        self.check_isa_flags(engine)?;
        self.check_tunables(&engine.tunables())?;
        self.check_features(&engine.features())?;
        Ok(())
    }
```

[crates/wasmtime/src/engine/serialization.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/engine/serialization.rs)

ターゲットのトリプル、コンパイラの共通フラグ、ISA 固有フラグ、`Tunables`、そして有効な Wasm proposal の集合。このうち `Tunables` の検査だけが、書き方として特異な形をしている。

## 分割代入で全フィールドを列挙する

`check_tunables` の冒頭は、`let ... = self.tunables;` という 1 つの巨大な分割代入から始まる。

```rust title="crates/wasmtime/src/engine/serialization.rs"
    fn check_tunables(&mut self, other: &Tunables) -> Result<()> {
        let Tunables {
            collector,
            memory_reservation,
            memory_guard_size,
            debug_native,
            debug_guest,
            debug_symbols,
            parse_wasm_debuginfo,
            consume_fuel,
            ref operator_cost,
            epoch_interruption,
            memory_may_move,
            guard_before_linear_memory,
            table_lazy_init,
            relaxed_simd_deterministic,
            winch_callable,
            signals_based_traps,
            memory_init_cow,
            inlining,
            // ...

            // This doesn't affect compilation, it's just a runtime setting.
            memory_reservation_for_growth: _,

            // This does technically affect compilation but modules with/without
            // trap information can be loaded into engines with the opposite
            // setting just fine (it's just a section in the compiled file and
            // whether it's present or not)
            generate_address_map: _,

            // Just a debugging aid, doesn't affect functionality at all.
            debug_adapter_modules: _,

            // This is a runtime GC debugging setting, doesn't affect compilation.
            gc_zeal_alloc_counter: _,
            // ...
        } = self.tunables;
```

Rust の構造体パターンは、`..` を書かない限り**全フィールドを列挙しなければコンパイルが通らない**。つまりこの書き方をしておくと、`Tunables` に新しい設定を 1 つ足した瞬間、ここがコンパイルエラーになる。

これが狙いだ。**「新しい設定を足したが、AOT の互換性判定に入れ忘れた」という事故が原理的に起きない。** 実装者は必ず、その設定を照合するのか、それとも `_` で明示的に無視するのかを決めなければならない。

## 「照合しない」にも理由を書く

そして `_` で無視するフィールドには、1 つずつ理由がコメントされている。これがこの実装のもう半分の価値だ。

- `memory_reservation_for_growth` — 「コンパイルには影響しない、ただのランタイム設定」
- `generate_address_map` — 「技術的にはコンパイルに影響するが、トラップ情報のある／ないモジュールは逆の設定のエンジンにも問題なくロードできる（コンパイル済みファイルのセクションが有るか無いかというだけ）」
- `debug_adapter_modules` — 「単なるデバッグの補助で、機能には一切影響しない」
- `branch_hinting` — 「cold ブロックのレイアウトにしか影響しない。コンパイル済み成果物はどちらの設定のエンジンにもロードできる」

「照合しない」という判断は、放っておくと**何も書かれないまま消える**種類の情報だ。あるフィールドがリストから漏れているとき、それが意図的なのか見落としなのかは、コードを見ただけでは区別できない。分割代入で全列挙を強制すると、この 2 つが必ず区別される。無視するには `_` を書かなければならず、`_` を書くときには「なぜ」を書く場所ができる。

**型システムを使って「判断したこと」を証明させ、コメントで「なぜそう判断したか」を残す。** この 2 つが組み合わさっている。

## 照合する側の粒度

実際に照合されるものを見ると、ほとんどが「コード生成の結果が変わるかどうか」で選ばれている。

`memory_reservation` と `memory_guard_size` は、[境界チェックを「消す」ための条件](../bounds-check-elision/) を決めるパラメータだ。4GiB 予約でコンパイルしたコードには境界チェックが入っていないので、予約の小さいエンジンで動かせば線形メモリの外を読めてしまう。`guard_before_linear_memory` や `memory_may_move`、`signals_based_traps` も同じ理由で照合される。

`consume_fuel` と `epoch_interruption` は、コンパイル時に計装を挿入するかどうかを決める ([fuel](../fuel/)、[epoch](../epoch/))。fuel を数えないバイナリをいくら fuel 付きのエンジンで動かしても、カウンタは減らない。

`collector` は GC のバリアの形を変える ([DRC](../drc/))。`memory_init_cow` は初期化の方式を、`table_lazy_init` はテーブルの初期化コードを変える。

`operator_cost` の照合には条件が付いている。

```rust title="crates/wasmtime/src/engine/serialization.rs"
    fn check_cost(
        consume_fuel: bool,
        found: &OperatorCostStrategy,
        expected: &OperatorCostStrategy,
    ) -> Result<()> {
        if !consume_fuel {
            return Ok(());
        }

        if found != expected {
            bail!("Module costs are incompatible");
        }

        Ok(())
    }
```

fuel を消費しないなら、命令ごとのコスト表が違っても結果は変わらない。**照合するかどうか自体が、別の設定に依存している**ケースだ。

## 同じ構造をもう 1 か所で使う

この「全フィールドを列挙させる」パターンは、`Config` の `Debug` 実装にも現れる。

```rust title="crates/wasmtime/src/config.rs"
        // Not every flag can be enabled through `Config`, but this impl
        // enumerates all features to avoid requiring manual maintenance (which
        // has gone stale in the past).
```

**「手作業のメンテナンスは過去に古くなった」**という経験がそのままコメントに書かれている。デバッグ出力が実態から乖離するのは、それ自体は害の小さいバグだが、放置されやすく、そして気づきにくい。だから列挙を機械化する。

同じ発想は Wasmtime の他の場所にもある。JIT コードが触る構造体のレイアウトを 1 つのマクロから生成する仕組み ([レイアウトの単一定義源をマクロで作る](../layout-macro/)) も、「2 か所に書いた定義がずれる」という失敗モードを構造的に消すためのものだ。

## どう活かすか

「設定の集合」と「その設定に対する判断の集合」がずれるのは、設定が増える限りいつか必ず起きる。よくある対処は、レビューで気をつける、テストを書く、ドキュメントに手順を書く、といったものだが、どれも人間の注意力に依存する。

Rust の分割代入のように**言語機能で全列挙を強制できる場所があるなら、そこに寄せるのが安い**。他の言語でも、網羅性検査のある `match`/`switch`、必須フィールドを持つ型、列挙型のマッピングテーブルなどで同じ効果を作れることがある。

重要なのは、強制するのが「判断すること」であって「判断の中身」ではない点だ。無視するという判断も許す。ただし黙って無視することは許さない。
