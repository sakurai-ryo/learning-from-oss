---
title: "Spectre 緩和は、トラップではなくアドレスの潰し込み"
description: "境界チェックの分岐は、投機実行によって「通った」ことにされうる。Wasmtime の答えはトラップを止めることではなく、範囲外だったときにアドレスを 0 に潰し、そのロードをフォルトさせることだ。select_spectre_guard という命令がなぜ必要で、なぜそれがシグナルハンドラなしでは使えないのか、そして既定構成では境界チェックが存在しないこと自体が緩和になっている理由を読む。"
group: "サンドボックスを守るコード生成"
sidebar:
  order: 33
---

境界チェックを `cmp` + `jae trap` で書くと、CPU は分岐予測を誤って「境界内だった」と仮定した投機パスを走らせうる。そのパスで範囲外のメモリを読むと、アーキテクチャ上の結果はロールバックされてもキャッシュの状態は残る。**Wasmtime はこの分岐そのものをやめる**。境界チェックの結果を条件付き移動でアドレスに畳み込み、範囲外なら 0 番地を指させて、そのロードがセグメンテーションフォルトすることでトラップにする。

## 脅威モデル

Spectre の一般論には深入りしないが、ここで防ぎたいものだけ確認しておく。

```asm
cmp  index, bound
jae  trap        ; 範囲外なら飛ぶ
mov  rax, [base + index]   ; 投機的に実行されうる
mov  rbx, [secret_table + rax * 64]  ; rax の値がキャッシュに痕跡を残す
```

`jae` の予測が外れると、`index` が範囲外でも 2 行目以降が投機的に走る。アーキテクチャ状態は巻き戻るが、L1 キャッシュに乗ったラインは残る。攻撃者はキャッシュのタイミングを測ることで、読めないはずの `rax` の値を復元できる。**分岐は投機される。トラップは投機パスでは起きない**。だから「範囲外なら分岐してトラップ」という構造は、投機パスを止める力を持たない。

止められるのは**データ依存**だ。アドレスの値そのものが境界チェックの結果に依存していれば、アウトオブオーダ実行はその依存が解決するまでロードを発行できない。

## OobBehavior の 3 択

[bounds_checks.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/cranelift/src/bounds_checks.rs#L179-L215) で境界チェックが必要と判断されたとき、そのチェックを「どう表現するか」は 3 通りある。

```rust title="crates/cranelift/src/bounds_checks.rs"
let oob_behavior = if spectre_mitigations_enabled {
    OobBehavior::ConditionallyLoadFromZero {
        select_spectre_guard: true,
    }
} else if env.load_from_zero_allowed() {
    OobBehavior::ConditionallyLoadFromZero {
        select_spectre_guard: false,
    }
} else {
    OobBehavior::ExplicitTrap
};
```

`OobBehavior` の定義にコメントが付いていて、意図がそのまま書かれている。

```rust title="crates/cranelift/src/bounds_checks.rs"
/// What to do on out-of-bounds for the
/// `explicit_check_oob_condition_and_compute_addr` function below.
enum OobBehavior {
    /// An explicit `trapnz` instruction should be used.
    ExplicitTrap,
    /// A load from NULL should be issued if the address is out-of-bounds.
    ConditionallyLoadFromZero {
        /// Whether or not to use `select_spectre_guard` to choose the address
        /// to load from. If `false` then a normal `select` is used.
        select_spectre_guard: bool,
    },
}
```

そして実際にコードを出す側では、`ExplicitTrap` のときだけ `trapnz` を出し、それ以外では**トラップを出さずに `select` でアドレスを選ぶ**。

```rust title="crates/cranelift/src/bounds_checks.rs"
if let OobBehavior::ExplicitTrap = oob_behavior {
    env.trapnz(builder, oob_condition, trap);
}
let addr_ty = env.pointer_type();
let mut addr = compute_addr(&mut builder.cursor(), heap, addr_ty, index, offset);

if let OobBehavior::ConditionallyLoadFromZero { select_spectre_guard } = oob_behavior {
    // These mitigations rely on trapping when loading from NULL so
    // CLIF memory instruction traps must be allowed for this to be
    // generated.
    assert!(env.load_from_zero_allowed());
    let null = builder.ins().iconst(addr_ty, 0);
    addr = if select_spectre_guard {
        builder.ins().select_spectre_guard(oob_condition, null, addr)
    } else {
        builder.ins().select(oob_condition, null, addr)
    };
}
```

**この関数はトラップを発行していない**。範囲外だったときに `null` を返し、その先のロード命令が 0 番地に触ってフォルトすることを期待する。トラップは [シグナルハンドラ](../traps-via-signals/) 経由で発生し、`MemFlags` に埋め込まれたトラップコードから「これは境界外アクセスだ」と復元される。

## select_spectre_guard が普通の select と違う点

CLIF の命令定義に、この命令が何を約束するかが書かれている。

```text title="cranelift/codegen/meta/src/shared/instructions.rs"
This operation is semantically equivalent to a select instruction.
However, this instruction prohibits all speculation on the
controlling value when determining which input to use as the result.
...
For example, on a target which may speculatively execute branches,
the lowering of this instruction is guaranteed to not conditionally
branch. Instead it will typically lower to a conditional move
instruction. (No Spectre-vulnerable processors are known to perform
value speculation on conditional move instructions.)

Ensure that the instruction you're trying to protect from Spectre
attacks has a data dependency on the result of this instruction.
That prevents an out-of-order CPU from evaluating that instruction
until the result of this one is known, which in turn will be blocked
until the controlling value is known.
```

[cranelift/codegen/meta/src/shared/instructions.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/meta/src/shared/instructions.rs#L1484-L1521)

意味論は `select` と同じだが、**条件付き分岐に lowering してはならない**という追加の契約が付く。x64 なら `cmov`。そして最適化に対しても制約が付いていて、「機能的に等価な値への置き換えは許されるが、制御値に投機する新たな機会を作ってはならない」と書かれている。[ægraph](../egraph/) の書き換え規則がこの命令を `select` と同一視して畳んでしまうと緩和が壊れるので、命令を分けること自体に意味がある。

もう 1 箇所、加算の順序にも注意書きが付いている。

```rust title="crates/cranelift/src/bounds_checks.rs"
// NB: The addition of the offset immediate must happen *before* the
// `select_spectre_guard`, if any. If it happens after, then we
// potentially are letting speculative execution read the whole first
// 4GiB of memory.
```

静的オフセットを `select` の後に足すと、潰したはずの 0 に `offset` が足されて、投機パスが 0 から 4GiB の範囲を読めてしまう。**潰し込みは、最終的なアドレスに対して行わなければ意味がない**。

## なぜシグナルを切ると緩和も切れるのか

`Config::signals_based_traps(false)` にすると、Wasmtime は Spectre 緩和の設定も同時に無効化されていることを要求し、そうでなければエラーで落ちる。

```rust title="crates/wasmtime/src/config.rs"
// Right now spectre-mitigated bounds checks will load from zero so
// if host-based signal handlers are disabled then that's a mismatch
// and doesn't work right now. Fixing this will require more thought
// of how to implement the bounds check in spectre-only mode.
if !ok {
    bail!(
        "when signals-based traps are disabled then spectre \
         mitigations must also be disabled"
    );
}
```

[crates/wasmtime/src/config.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/config.rs#L3024-L3044)

理屈は一本道だ。緩和の実体は「0 番地からロードさせる」ことであり、0 番地からのロードがトラップになるのはシグナルハンドラがあるからだ。シグナルを使わない構成では、範囲外を検出する手段が `trapnz` すなわち条件分岐しかない。すると Spectre 緩和は原理的に成立しない。**「まだ考え切れていない」と書かれている**とおり、これは設計上の妥協ではなく未解決の課題として明示されている。

同じことが `Config::signals_based_traps` の doc にも書かれている。「spectre 緩和は null アドレスからのロードのフォルトに依存して境界チェックを実装しているため」だ、と。

## 緩和が入っている場所は 3 つ

`docs/security.md` が、緩和の適用範囲をはっきり列挙している。

```text title="docs/security.md"
* Bounds checks when accessing entries in a function table (e.g. the
  `call_indirect` instruction) are mitigated.

* The `br_table` instruction is mitigated to ensure that speculation goes to a
  deterministic location.

* Wasmtime's default configuration for linear memory means that bounds checks
  will not be present for memory accesses due to the reliance on page faults to
  instead detect out-of-bounds accesses. When Wasmtime is configured with
  "dynamic" memories, however, Cranelift will insert spectre mitigation for the
  bounds checks performed for all memory accesses.
```

[docs/security.md](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/docs/security.md#L118-L140)

3 つ目が示唆的だ。**既定構成では線形メモリの境界チェックが存在しないので、緩和すべき分岐もない**。[境界チェックを「消す」ための条件](../bounds-check-elision/) で見たとおり、4GiB 予約 + 32MiB ガードの構成ではチェックが 1 命令も出ない。投機的に迂回される分岐がなければ、そもそも迂回されない。ガードページ方式は性能のための選択だが、**副産物として Spectre の攻撃面を消している**。逆に言うと、`memory_reservation` を小さくして explicit bounds check を出す構成に切り替えた瞬間に、Spectre 緩和のコストが表に出てくる。

テーブル側の緩和も同じ形をしている。

```rust title="crates/cranelift/src/translate/table.rs"
if spectre_mitigations_enabled {
    // Short-circuit the computed table element address to a null pointer
    // when out-of-bounds. The consumer of this address will trap when
    // trying to access it.
    let zero = pos.ins().iconst(addr_ty, 0);
    (
        pos.ins().select_spectre_guard(oob, zero, element_addr),
        base_flags.with_trap_code(Some(crate::TRAP_TABLE_OUT_OF_BOUNDS)),
    )
}
```

`enable_table_access_spectre_mitigation` の設定説明が、狙いを一行でまとめている。「境界チェックされたテーブルアクセスのインデックスに対して、その条件分岐が誤って in-bounds と予測されたときに、投機パスでは in-bounds なインデックスがロードされるようにする」。この緩和は [call_indirect の型チェック](../call-indirect-typecheck/) の手前、テーブル要素のアドレス計算の段階に入っている。

両方の設定とも既定は `true` で、説明にはこう書かれている。「このオプションは安全なサンドボックス化に強く推奨されるので既定で有効になっている。埋め込み側は無効化する前にセキュリティ上の影響を慎重に検討すべきである」。

## aarch64 の csdb は既定で無効

`cmov` への lowering だけでは足りない場合に備えて、aarch64 には `csdb` (Consumption of Speculative Data Barrier) という命令がある。Wasmtime はこれを既定で使わない。

```text title="docs/security.md"
Note that on aarch64 the `csdb` instruction is disabled by default due to its
significant performance penalty, but this can be additionally enabled through
the `use_csdb` Cranelift setting.
```

Cranelift 側の設定定義も `use_csdb` の既定値を `false` にしている。実際に `csdb` が挿入されるのは `br_table` の lowering で、`enable_table_access_spectre_mitigation` と `use_csdb` の**両方**が立っているときだけだ。

**性能上のペナルティが大きいという理由で、より強い緩和を既定から外している**。これは Spectre 対策全般につきまとうトレードオフで、Wasmtime はその判断を隠さずドキュメントに書き、設定で覆せるようにしている。同じ節の末尾には「Spectre の緩和は研究が進行中の主題であり、Wasmtime も将来さらに緩和を増やすだろう」と、現状が完全ではないことも明記されている。

## どう活かすか

持ち帰れるのは、**投機実行に対しては「止める」のではなく「無害にする」というアプローチを取る**、という発想の転換だ。分岐で止めようとしても投機パスは止まらない。データ依存を作って、投機パスが走ってもマイクロアーキテクチャ的な痕跡が残らない値を読ませる。

もう 1 つは、**セマンティクスが同じでも lowering の制約が違う命令を、IR のレベルで別物として持つ**という設計だ。`select` と `select_spectre_guard` は値の意味では同じだが、最適化器とバックエンドに対する契約が違う。「意味論が同じなら同じ命令にまとめる」という素直な判断が、セキュリティ機構では成立しない。
