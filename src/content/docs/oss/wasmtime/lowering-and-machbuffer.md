---
title: "逆順 1 スキャンの lowering と、MachBuffer の island"
description: "CLIF から機械語になる最後の 2 段。lowering はブロックを逆順に 1 回スキャンし、副作用命令が生きた純粋命令を引きずり出す。MachBuffer は前方分岐を楽観的に 0 オフセットで発行し、deadline を追跡して island に veneer を置く。同時に 4 つの分岐 peephole 規則をオンザフライで適用する。"
group: "Cranelift — Wasm を機械語にする"
sidebar:
  order: 30
---

CLIF が機械語になる最後の 2 段は、lowering と emission だ。lowering は **ブロックを逆順に 1 回スキャンするだけ**で命令選択と不要命令の除去を同時に済ませる。emission は `MachBuffer` が担い、**前方分岐のターゲットが分からないまま楽観的に発行して、後から island に veneer を置く**。どちらも「1 パスで終わらせる」という同じ方針の現れになっている。

## パイプライン全体

`machinst/mod.rs` の冒頭に、この先の全工程が ASCII 図で書かれている。

```text title="cranelift/codegen/src/machinst/mod.rs"
    ir::Function                (SSA IR, machine-independent opcodes)
        |
        |  [lower]
        |
    VCode<arch_backend::Inst>   (machine instructions:
        |                        - mostly virtual registers.
        |                        - cond branches in two-target form.
        |                        - branch targets are block indices.
        |                        - in-memory constants held by insns,
        |                          with unknown offsets.
        |                        - critical edges (actually all edges)
        |                          are split.)
        |
        | [regalloc --> `regalloc2::Output`; VCode is unchanged]
        |
        | [binary emission via MachBuffer]
        |
    Vec<u8>                     (machine code:
        |                        - two-dest branches resolved via
        |                          streaming branch resolution/simplification.
        |                        - prologue and epilogue(s) built and emitted
        |                          directly during emission.
        |                        - SP-relative offsets resolved by tracking
        |                          EmitState.)
```

[cranelift/codegen/src/machinst/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/mod.rs#L13-L45)

括弧の中の "VCode is unchanged" が重要だ。**レジスタ割り当ては VCode を書き換えない。**

```rust title="cranelift/codegen/src/machinst/vcode.rs"
/// Note that the VCode is immutable once produced, and is not
/// modified by register allocation in particular. Rather, register
/// allocation on the `VCode` produces a separate `regalloc2::Output`
/// struct, and this can be passed to `emit`. `emit` in turn does not
/// modify the vcode, but produces an `EmitResult`, ...
pub struct VCode<I: VCodeInst> {
```

[cranelift/codegen/src/machinst/vcode.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/vcode.rs#L83-L91)

VCode は仮想レジスタのまま残り、`regalloc2::Output` が「この命令のこのオペランドはこの物理レジスタ / スピルスロット」という対応表として別に返る。emission がその 2 つを重ねて読む。IR を破壊的に更新しないので、regalloc の出力だけを検証器に食わせられるし、regalloc のアルゴリズムを差し替えても VCode 側は何も変わらない。

その差し替えも実際に用意されている。

```rust title="cranelift/codegen/src/machinst/compile.rs"
if cfg!(debug_assertions) {
    options.validate_ssa = true;
}

options.algorithm = match b.flags().regalloc_algorithm() {
    RegallocAlgorithm::Backtracking => Algorithm::Ion,
    RegallocAlgorithm::SinglePass => Algorithm::Fastalloc,
};
```

[cranelift/codegen/src/machinst/compile.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/compile.rs#L56-L63)

`Backtracking` が品質重視の Ion、`SinglePass` が速度重視の Fastalloc。debug ビルドでは regalloc2 側の SSA 検証が有効になり、`regalloc_checker` フラグを立てれば `regalloc2::checker::Checker` が割り当て結果の妥当性を別途検査する。

VCode が regalloc2 と繋がるインターフェースは、`impl RegallocFunction for VCode<I>` というトレイト実装 1 個だけだ ([machinst/vcode.rs#L1528-L1616](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/vcode.rs#L1528-L1616))。中身は `block_succs` / `block_preds` / `block_params` などの CFG の形、`inst_operands` の命令ごとのオペランド、`inst_clobbers` のクロバーするレジスタ集合。それだけを教えれば regalloc2 は仕事ができる。これがこの章で regalloc2 の中身を扱わない理由でもある。

## lowering は逆順の 1 スキャン

lowering のアルゴリズムは、`lower_clif_block` の頭にあるコメントに全部書いてある。

```rust title="cranelift/codegen/src/machinst/lower.rs"
// Lowering loop:
// - For each non-branch instruction, in reverse order:
//   - If side-effecting (load, store, branch/call/return,
//     possible trap), or if used outside of this block, or if
//     demanded by another inst, then lower.
//
// That's it! Lowering of side-effecting ops will force all *needed*
// (live) non-side-effecting ops to be lowered at the right places, via
// the `use_input_reg()` callback on the `Lower` (that's us). That's
// because `use_input_reg()` sets the eager/demand bit for any insts
// whose result registers are used.
//
// We set the VCodeBuilder to "backward" mode, so we emit
// blocks in reverse order wrt the BlockIndex sequence, and
// emit instructions in reverse order within blocks.
for inst in self.f.layout.block_insts(block).rev() {
```

[cranelift/codegen/src/machinst/lower.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/lower.rs#L722-L741)

"That's it!" と書いてあるとおり、規則は 1 つしかない。**副作用があるか、このブロックの外で使われるか、他の命令から要求されているなら lowering する。それ以外は捨てる。**

逆順に走ることでこれが成り立つ。使う側の命令を先に見るので、その命令が引数を要求した時点で「引数を作る命令は生きている」というフラグが立つ。前向きに走ると、命令を見た時点ではその結果が後で使われるかどうか分からないので、生存解析を別パスとして先に回すことになる。**逆順にするだけで、デッドコード除去が命令選択に融合する。**

VCodeBuilder が "backward" モードになっているのはそのためだ。ブロックも命令も逆順に積み、最後に反転する。バックエンドは `ctx.emit()` を通常の順序で呼ぶので、1 つの IR 命令ぶんの出力を `ir_insts` に貯めてから反転して VCode に足す、という二重反転になっている。

## 命令の「色」

副作用のある命令どうしの順序をどこまで動かしてよいかは、`InstColor` が表現する。

```rust title="cranelift/codegen/src/machinst/lower.rs"
/// An "instruction color" partitions CLIF instructions by side-effecting ops.
/// All instructions with the same "color" are guaranteed not to be separated by
/// any side-effecting op (for this purpose, loads are also considered
/// side-effecting, to avoid subtle questions w.r.t. the memory model), and
/// furthermore, it is guaranteed that for any two instructions A and B such
/// that color(A) == color(B), either A dominates B and B postdominates A, or
/// vice-versa. ... Intuitively,
/// this means that the ops of the same color must always execute "together", as
/// part of one atomic contiguous section of the dynamic execution trace, and
/// they can be freely permuted (modulo true dataflow dependencies) without
/// affecting program behavior.
struct InstColor(u32);
```

[cranelift/codegen/src/machinst/lower.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/lower.rs#L37-L50)

同じ色の命令は「必ず一緒に実行される連続区間」に属し、データフロー依存を除けば自由に入れ替えられる。**ロードも副作用扱いにしている**のが要点で、理由は "to avoid subtle questions w.r.t. the memory model"。ロードを純粋にするとストアを跨いで動かせてしまい、メモリモデルの議論に踏み込まざるをえなくなる。色を分けることで「このロードはこのストアを跨げない」が構造的に保証される。ミッドエンドの ægraph が `readonly + notrap + can_move` なロードだけを純粋扱いにしていた ([ægraph — 非循環な e-graph という選択](../egraph/)) のに対し、lowering はもっと保守的だ。段によって「純粋」の定義が違うのは、段ごとに動かせる範囲が違うからである。

## 命令マージ (sinking)

x64 の `iadd` がロードをオペランドに畳み込めるのは、lowering が「この値を作った命令は何で、その唯一の使用者は自分か」を答えられるからだ。

```rust title="cranelift/codegen/src/machinst/lower.rs"
pub enum InputSourceInst {
    /// The input in question is the single, unique use of the given
    /// instruction and output index, and it can be sunk to the
    /// location of this input.
    UniqueUse(Inst, usize),
    /// The input in question is one of multiple uses of the given
    /// instruction. It can still be sunk to the location of this
    /// input.
    Use(Inst, usize),
    /// We cannot determine which instruction produced the input, or ...
    /// the source instruction cannot be
    /// allowed to sink to the current location due to side-effects.
    None,
}
```

[cranelift/codegen/src/machinst/lower.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/lower.rs#L88-L104)

`UniqueUse` と `Use` を区別しているのは、畳み込みが得か損かが変わるからだ。使用者が 1 つなら元の命令は消せるので純粋に得。複数なら計算が重複するので、安いオペランドの場合しか得にならない。この情報が `NonRegInput` として ISLE の抽出子に渡り、`sinkable_load` のような判定になる。畳み込みを実行したら `sink_inst()` が呼ばれ、逆順スキャンがその命令に到達したときに `is_inst_sunk` で読み飛ばされる。

## MachBuffer が解こうとしている 3 つの問題

`machinst/buffer.rs` の冒頭 130 行は、このリポジトリでも屈指の設計文書だ。まず解く問題を 3 つ挙げる。

```text title="cranelift/codegen/src/machinst/buffer.rs"
This code exists to solve three problems:

- Branch targets for forward branches are not known until later, when we
  emit code in a single pass through the instruction structs.

- On many architectures, address references or offsets have limited range.
  For example, on AArch64, conditional branches can only target code +/- 1MB
  from the branch itself.

- The lowering of control flow from the CFG-with-edges produced by
  [BlockLoweringOrder](super::BlockLoweringOrder), combined with many empty
  edge blocks when the register allocator does not need to insert any
  spills/reloads/moves in edge blocks, results in many suboptimal branch
  patterns.
```

[cranelift/codegen/src/machinst/buffer.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/buffer.rs#L1-L21)

3 つ目は自分たちが作った問題だ。CFG のエッジを全部分割し、regalloc がスピルを入れなかったエッジブロックが空のまま残る。さらに lowering はブロック順を気にしないので、条件分岐 + 無条件分岐の 2 ターゲット形が、片方が fallthrough になっているのに残る。**前段が正しさのために作った冗長さを、後段が畳んで回収する**という分業になっている。

## 楽観的に発行し、deadline を追い、island を置く

解法はこうだ。

```text title="cranelift/codegen/src/machinst/buffer.rs"
- Emit branches as they are, ... but with zero offsets and optimistically
  assuming the target will be in range. Record the "fixup" for later.

- As we do this, track the offset in the buffer at which the first label
  reference "goes out of range". We call this the "deadline". If we reach the
  deadline and we still have not bound the label to which an unresolved branch
  refers, we have a problem!

- To solve this problem, we emit "islands" full of "veneers". An island is
  simply a chunk of code inserted in the middle of the code actually produced
  by the emitter. Islands are emitted at "safe" points (no fall-through into
  the island contents): between basic blocks during emission, or via a jump
  around the island.

- A "veneer" is an instruction ... that implements a longer-range reference to
  a label. ... On AArch64, for example, conditionals have a +/- 1 MB range, but
  a conditional can branch to an unconditional branch which has a +/- 128 MB
  range.
```

バイト列の上での配置はこうなる。

```text
        offset
        ------
        0x0000   ...
        0x0010   b.eq  label_X        ; ±1MB しか届かない。fixup を記録
        0x0014   ...
                 ...   (コードが伸びる)
        0x0FF0   b     island_end     ; island を跨ぐジャンプ
        --------- island 開始 ---------
        0x0FF4   veneer_for_X:
        0x0FF4     b   label_X        ; ±128MB 届く無条件分岐
        0x0FF8   (pending constant)
        0x1000   (pending trap)
        --------- island 終了 ---------
        0x1004   island_end:
                 ...
                 ...
        0x9000   label_X:             ; ここまで来ると b.eq からは届かない
                                      ; → 0x0010 の fixup は veneer_for_X を指す
```

`b.eq` の届く範囲が尽きる前に island を置き、そこに「もっと遠くまで届く形」の分岐を 1 つ置いて、元の `b.eq` にはその veneer を指させる。island には veneer だけでなく、定数プールに置きたいデータやトラップ記録も一緒に流し込まれる。

いつ island を出すかは、`worst_case_end_of_island(0) <= soonest_deadline` という不変条件で決まる。ソースの言い換えでは "if we emitted an island right now, its end offset would land before the closest expiring deadline" で、これが保たれている限り island は常に実現可能だ。維持するために **命令 1 つの発行を原子的なコミット単位として扱う** ([machinst/buffer.rs#L142-L169](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/buffer.rs#L142-L169))。1 ステップで不変条件が壊れる幅が有界になるので、毎命令後に `island_needed` を確認するだけで済む。範囲や veneer の生成方法は ISA ごとの `LabelUse` トレイトが提供するので、この仕組み自体は ISA に依存しない。

## オンザフライの分岐 peephole

3 つ目の問題 (冗長な分岐) は、専用のパスを回さず、**バッファに書き込む途中で**畳む。規則は 4 つ。

1. **fallthrough 分岐の除去。** ラベルターゲットを持つ分岐で、そのラベルが分岐の終了オフセット (= fallthrough 先) に束縛されたなら、その分岐は何もしないので消せる。
2. **branch threading。** ラベルの位置から始まる無条件分岐は「ラベルの別名」を作る。その分岐に束縛されていたラベルへの参照は、すべて分岐先へ解決される。次のブロックへ無条件に飛ぶだけの空ブロックがこれで消える。
3. **条件分岐の反転。** 条件分岐の直後に無条件分岐があり、条件分岐が無条件分岐の fallthrough を指しているなら、無条件分岐を切り詰め、条件を反転し、ターゲットを無条件分岐のものに差し替える。
4. **到達不能な無条件分岐の除去。** 無条件分岐 P の直後の無条件分岐 B は、B のラベルがすべて張り替え済みなら到達不能なので消せる。

3 番目のために、emitter は条件分岐をバッファに渡すとき **反転形の機械語バイト列も一緒に渡す**。

```rust title="cranelift/codegen/src/machinst/buffer.rs"
pub fn add_cond_branch(
    &mut self,
    start: CodeOffset,
    end: CodeOffset,
    target: MachLabel,
    inverted: &[u8],
) {
    // ...
    debug_assert!(
        inverted.len() == (end - start) as usize,
        "branch length = {}, but inverted length = {}",
        end - start,
        inverted.len()
    );
```

[cranelift/codegen/src/machinst/buffer.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/buffer.rs#L856-L876)

長さが同じであることがアサートされているので、反転はバッファ中のバイト列をその場で差し替えるだけで済む。ドキュメントの言い方では "the emitter actually gives the buffer _both_ forms of every conditional branch."

畳めるのは「最新の分岐」だけだ。現在のオフセットまで連続している分岐の列を `latest_branches` として持ち、そこに何かコードが出力された時点でその列は畳めなくなる。**バッファを切り詰めて書き直せる範囲でしか peephole をしない**という制約が、1 パスであることと両立させている。

この最適化の正しさには 4 つのデータ構造の不変条件が要る (latest-branches リストが完全かつ厳密であること、labels-at-tail、`label_offsets`、`label_aliases`)。ソースにはそれらが列挙されたうえで、各メソッドに `Post-invariant` コメント、各最適化に `Preserves execution semantics` コメントが grep で引ける形で置かれている。

## 出力されるメタデータ

emission が終わると `MachBufferFinalized` になる。中身は機械語だけではない。

```rust title="cranelift/codegen/src/machinst/buffer.rs"
pub struct MachBufferFinalized<T: CompilePhase> {
    pub(crate) data: SmallVec<[u8; 1024]>,
    /// Any relocations referring to this code. Note that only *external*
    /// relocations are tracked here; references to labels within the buffer are
    /// resolved before emission.
    pub(crate) relocs: SmallVec<[FinalizedMachReloc; 16]>,
    pub(crate) traps: SmallVec<[MachTrap; 16]>,
    pub(crate) call_sites: SmallVec<[MachCallSite; 16]>,
    pub(crate) exception_handlers: SmallVec<[FinalizedMachExceptionHandler; 16]>,
    pub(crate) srclocs: SmallVec<[T::MachSrcLocType; 64]>,
    pub(crate) user_stack_maps: SmallVec<[(CodeOffset, u32, ir::UserStackMap); 8]>,
    pub(crate) frame_layout: Option<MachBufferFrameLayout>,
    pub unwind_info: SmallVec<[(CodeOffset, UnwindInst); 8]>,
    // ... alignment, patchable_call_sites, debug_tags, nop_units
}
```

[cranelift/codegen/src/machinst/buffer.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/cranelift/codegen/src/machinst/buffer.rs#L398-L441)

`relocs` の注釈が効いている。**外部参照だけがリロケーションとして残り、バッファ内のラベル参照は発行前に解決済み**だ。island と veneer の仕組みが存在するのは、まさにこれを成立させるためでもある。関数内のジャンプはリンカに渡す必要がない。

残りは Wasmtime 側が使う。`traps` はどのオフセットがトラップしうるかの表で、シグナルハンドラの判定に使われる ([「これは wasm 由来のフォルトか」を 3 段階で判定する](../is-this-wasm/))。`user_stack_maps` は GC が生きた参照を見つけるための表 ([VMGcRef はポインタではない](../vmgcref/))。`unwind_info` はバックトレース用、`srclocs` は wasm のバイト位置との対応表だ。**コンパイラが機械語と同時に、実行時に必要なすべての表を吐く**という構造がここで完成する。

## どう活かすか

lowering と MachBuffer には共通の設計がある。**まず楽観的に進み、辻褄が合わないと分かった時点で修正を挿し込む。** lowering は「使われるかどうか」を先に解析せず、逆順に走ることで必要な情報を自然に手に入れる。MachBuffer は分岐先を 0 で埋めて先に進み、期限が迫ったら island を挿す。どちらも「先に全体を調べてから作る」を「作りながら足りないものを補う」に置き換えていて、それが 1 パスという性質を保っている。

これができる条件も読み取れる。lowering は逆順に走れる (SSA なので定義が使用より前にあると分かっている)。MachBuffer は挿入位置を後から作れる (island を挟んでもコードの意味が変わらない)。**「後から差し込める場所」を設計に確保しておくと、先読みなしの 1 パスが選べるようになる。**
