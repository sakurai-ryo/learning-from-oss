---
title: "VMContext — JIT コードが固定オフセットで触る構造体"
description: "コンパイル済みの機械語がインスタンスの状態に触る唯一の入口が VMContext。ただし Rust 側の `struct VMContext` は `_magic: u32` 1 フィールドだけの空殻で、実体はマクロが定義するレイアウトに従って実行時に確保される。フィールドの並び順にロード命令のオフセット即値を縮めるという理由があること、先頭 4 バイトの magic が誤キャスト検出に使われること、そして Instance が末尾に可変長の VMContext を抱えるために `Pin` でしか変更できないことを読む。"
group: "実行時の表現"
sidebar:
  order: 37
---

Cranelift が吐いた wasm 関数は、必ず第 1 引数に `vmctx` を取る。線形メモリの先頭アドレスも、テーブルの base も、グローバルの値も、import された関数のポインタも、fuel の残量も、全部この 1 本のポインタからの固定オフセットで読む。**wasm のコードがホストの状態に触る経路は、これしかない。**

そして、その構造体は Rust の型として存在しない。

```rust title="crates/wasmtime/src/runtime/vm/vmcontext.rs"
/// The VM "context", which is pointed to by the `vmctx` arg in Cranelift.
/// This has information about globals, memories, tables, and other runtime
/// state associated with the current instance.
///
/// The struct here is empty, as the sizes of these fields are dynamic, and
/// we can't describe them in Rust's type system. Sufficient memory is
/// allocated at runtime.
#[derive(Debug)]
#[repr(C, align(16))] // align 16 since globals are aligned to that and contained inside
pub struct VMContext {
    _magic: u32,
}
```

[crates/wasmtime/src/runtime/vm/vmcontext.rs#L953-L964](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/vmcontext.rs#L953-L964)

理由はコメントのとおりで、**フィールドのサイズが動的だから Rust の型システムでは書けない**。グローバルが 3 個のモジュールと 300 個のモジュールでは `VMContext` のサイズが違う。定義済みメモリが 0 個ならメモリの配列は 0 バイトで、そもそも確保されない。`VMContext` の「形」はモジュールごとに違う。

## レイアウトは 1 つのマクロが持っている

では実際のレイアウトはどこにあるのか。`crates/environ/src/vmctxtypes.rs` の `for_each_vmctx_type!` マクロだ。これが `VMContext` と `VMComponentContext` の両方について、`static` セクション (ポインタ幅だけで決まる固定長の前置き) と `dynamic` セクション (モジュールの形に依存する残り) を列挙する。

```rust title="crates/environ/src/vmctxtypes.rs"
VMContext vmctx

// Fixed-width data comes first so that the calculation of these
// fields' offsets is a compile-time constant when using
// `HostPtr`.
static {
    field { #[readonly] #[can_move] magic: u32 }

    // NB: this is where the four bytes of padding after `magic`
    // live on targets with eight-byte pointers.
    align { ptr }

    field { #[readonly] #[can_move] store_context: VmPtr<VMStoreContext> }

    field { #[readonly] #[can_move] builtin_functions: VmPtr<VMBuiltinFunctionsArray> }

    field { epoch_ptr: VmPtr<AtomicU64> }

    // A pointer that different collectors use however they see
    // fit.
    field { #[readonly] #[can_move] gc_heap_data: VmPtr<u8> }

    field { #[readonly] #[can_move] type_ids: VmPtr<VMSharedTypeIndex> }
}
```

[crates/environ/src/vmctxtypes.rs#L110-L133](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/vmctxtypes.rs#L110-L133)

固定長のものを先に置くのは、`HostPtr` を使う場合にこれらのオフセットがコンパイル時定数になるからだ。ホスト上で走るランタイム側のコードは、`store_context` を読むのに実行時計算を一切しない。

続く `dynamic` セクションは import と defined を種類ごとに並べた配列群になる。

```text
                     オフセット 0
                          │
  static ┌────────────────┴──────────────────────────────────────────┐
  (固定) │ magic: u32                      │ 0                       │
         │ (padding, 64bit ホストのみ)      │ 4                      │
         │ store_context: VmPtr            │ 8                       │
         │ builtin_functions: VmPtr        │ 16                      │
         │ epoch_ptr: VmPtr                │ 24                      │
         │ gc_heap_data: VmPtr             │ 32                      │
         │ type_ids: VmPtr                 │ 40                      │
  dynamic├─────────────────────────────────┴─────────────────────────┤
  (可変) │ imported_memories[num_imported_memories]                  │  ← メモリ関連が
         │ memories[num_defined_memories]        (VmPtr の配列)       │     先頭に来る
         │ owned_memories[num_owned_memories]    (実体の配列)         │
         ├───────────────────────────────────────────────────────────┤
         │ imported_functions[num_imported_functions]                │
         │ imported_tables[num_imported_tables]                      │
         │ imported_globals[num_imported_globals]                    │
         │ imported_tags[num_imported_tags]                          │
         │ tables[num_defined_tables]                                │
         │ ------------------------------- align 16 ---------------- │
         │ globals[num_defined_globals]                              │
         │ tags[num_defined_tags]                                    │
         │ func_refs[num_escaped_funcs]                              │
         │ startup_func_ref (has_startup_func のときだけ)             │
         │ runtime_data_bases[num_runtime_data]                      │
         │ runtime_data_lengths[num_runtime_data]                    │
         └───────────────────────────────────────────────────────────┘
```

`num_*` はすべて `VMOffsets` が `wasmtime_environ::Module` から拾ってくる値なので、モジュールごとにこの図の各ブロックの幅が変わる。

## 並び順に理由がある

`dynamic` セクションの冒頭にコメントがあり、**なぜメモリ関連を先頭に置くのか**が書かれている。

```text title="crates/environ/src/vmctxtypes.rs"
// Variable-width fields come after the fixed-width fields
// above. Memory-related items are placed first as they are some
// of the most frequently accessed items, and minimizing their
// offset can shrink the size of load/store instruction offset
// immediates on platforms like x64 and Pulley (e.g. fit in an
// 8-bit offset instead of needing a 32-bit offset).
```

[crates/environ/src/vmctxtypes.rs#L135-L141](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/vmctxtypes.rs#L135-L141)

x64 の `mov` は、ベースレジスタからの変位を 8bit で書ける場合と 32bit 必要な場合で命令長が 3 バイト違う。線形メモリの base を読むロードは wasm のメモリアクセスごとに (境界チェックが消えていなければ current_length も) 出てくるので、ここが 3 バイト縮むかどうかは `.text` のサイズに直接効く。Pulley のバイトコードでも同じ話で、オペランドのエンコード長が変わる ([Pulley は「インタプリタ」ではなくターゲット ISA である](../pulley-as-isa/))。

つまり **この構造体のフィールド順は、生成される機械語のサイズを見て決められている**。Rust の `struct` なら `#[repr(C)]` を付けて書き順どおりに並べるだけの話が、ここでは「どのフィールドが何回アクセスされるか」の設計判断になっている。

## 先頭 4 バイトの magic

`magic` がオフセット 0 に固定されているのは、型の取り違えを検出するためだ。`VMFuncRef` が持つ vmctx ポインタは `VMOpaqueContext` 型で、その実体は呼ばれる関数によって `VMContext` だったり `VMArrayCallHostFuncContext` だったり `VMComponentContext` だったりする ([VMFuncRef と、wasm_call が Option である理由](../vmfuncref/))。ポインタの型だけでは区別が付かない。

```rust title="crates/wasmtime/src/runtime/vm/vmcontext.rs"
pub unsafe fn from_opaque(opaque: NonNull<VMOpaqueContext>) -> NonNull<VMContext> {
    // Note that in general the offset of the "magic" field is stored in
    // `VMContext::magic`. Given though that this is a sanity check
    // about converting this pointer to another type we ideally don't want
    // to read the offset from potentially corrupt memory. Instead it would
    // be better to catch errors here as soon as possible.
    //
    // To accomplish this the `VMContext` structure is laid out with the
    // magic field at a statically known offset (here it's 0 for now). This
    // static offset is asserted in `VMOffsets::from` and needs to be kept
    // in sync with this line for this debug assertion to work.
    //
    // Also note that this magic is only ever invalid in the presence of
    // bugs, meaning we don't actually read the magic and act differently
    // at runtime depending what it is, so this is a debug assertion as
    // opposed to a regular assertion.
    unsafe {
        debug_assert_eq!(opaque.as_ref().magic, VMCONTEXT_MAGIC);
    }
    opaque.cast()
}
```

[crates/wasmtime/src/runtime/vm/vmcontext.rs#L966-L991](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/vmcontext.rs#L966-L991)

magic の値は ASCII 文字列のリトルエンディアン表現で、`VMCONTEXT_MAGIC` が `"core"`、`VM_ARRAY_CALL_HOST_FUNC_MAGIC` が `"ACHF"`、`VMCOMPONENT_MAGIC` が `"comp"` になっている ([crates/environ/src/vmoffsets.rs#L1097-L1106](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/vmoffsets.rs#L1097-L1106))。コアダンプを 16 進で眺めたときに人間が読めるようにしてある。

重要なのは、これが `assert!` ではなく `debug_assert!` であること、そして値を読んで振る舞いを変えるのではなく**「バグがあれば落ちる」ためだけに置かれている**ことだ。正常系ではこの読み込み自体がリリースビルドから消える。

## VMStoreContext は Store と 1 対 1

`static` セクションの `store_context` が指す先は、`VMContext` とは別の構造体だ。こちらは可変長ではないので、`for_each_vm_type!` 側で普通の `#[repr(C)]` 構造体として定義されている。

```rust title="crates/environ/src/vmtypes.rs"
/// Structure that holds all mutable context that is shared across all instances
/// in a store, for example data related to fuel or epochs.
///
/// `VMStoreContext`s are one-to-one with `wasmtime::Store`s, the same way that
/// `VMContext`s are one-to-one with `wasmtime::Instance`s. And the same way
/// that multiple `wasmtime::Instance`s may be associated with the same
/// `wasmtime::Store`, multiple `VMContext`s hold a pointer to the same
/// `VMStoreContext` when they are associated with the same `wasmtime::Store`.
#[derive(Debug)]
// NB: `align(8)` is forced rather than inferred because the i386
// System V ABI aligns 64-bit integers to 4 bytes, and `VMOffsets`
// can't tell that target apart from the ones that align them to 8,
// since it only knows the target's pointer width.
#[repr(C, align(8))]
#[snake_name = vm_store_context]
pub struct VMStoreContext {
    // NB: 64-bit integer fields are located first with pointer-sized fields
    // trailing afterwards. That makes the offsets in this structure easier to
    // calculate on 32-bit platforms as we don't have to worry about the
    // alignment of 64-bit integers.
    pub fuel_consumed: UnsafeCell<i64>,
    pub epoch_deadline: UnsafeCell<u64>,
    pub execution_version: u64,
    pub stack_limit: UnsafeCell<usize>,
    // ... gc_heap, last_wasm_exit_trampoline_fp, last_wasm_exit_pc,
    //     last_wasm_entry_sp, last_wasm_entry_fp, stack_chain, async_guard_range, ...
}
```

[crates/environ/src/vmtypes.rs#L287-L448](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/vmtypes.rs#L287-L448)

ここに入っているのは、**インスタンスではなく Store 単位で 1 つであるべき可変状態**だ。fuel の残量 ([fuel — 決定的だが高価な割り込み](../fuel/))、epoch の期限 ([epoch — なぜ関数の入口にもチェックが要るのか](../epoch/))、スタック上限 ([スタックオーバーフローは、ガードページではなく明示チェック](../stack-limit/))、GC ヒープ、そして wasm とホストの境界を記録する `last_wasm_exit_pc` / `last_wasm_exit_trampoline_fp` / `last_wasm_entry_sp` / `last_wasm_entry_fp` ([CallThreadState — スタック上に置くアクティベーションの連結リスト](../call-thread-state/))。同じ Store の中の 10 個のインスタンスは、10 個の `VMContext` から同じ 1 個の `VMStoreContext` を指す。

`#[repr(C, align(8))]` の `align(8)` が**推論ではなく強制**なのは、i386 System V ABI が 64bit 整数を 4 バイト境界に置くからだ。`VMOffsets` はターゲットのポインタ幅しか知らないので、i386 とそれ以外を区別できない。だから「64bit 整数は 8 バイト境界」と決め打ちしたうえで、Rust 側の実体にも同じ規則を強制している。同じ理由で、64bit 整数フィールドを構造体の先頭に固めてある。

## Instance の末尾に生えている

`VMContext` の実体はどこに確保されるのか。`Instance` の直後だ。

```rust title="crates/wasmtime/src/runtime/vm/instance.rs"
#[repr(C)] // ensure that the vmctx field is last.
pub struct Instance {
    id: InstanceId,
    runtime_info: ModuleRuntimeInfo,
    memories: TryPrimaryMap<DefinedMemoryIndex, (MemoryAllocationIndex, Memory)>,
    tables: TryPrimaryMap<DefinedTableIndex, (TableAllocationIndex, Table)>,
    passive_elements: TryVec<PassiveElementSegment>,
    store: Option<VMStoreRawPtr>,

    /// Additional context used by compiled wasm code. This field is last, and
    /// represents a dynamically-sized array that extends beyond the nominal
    /// end of the struct (similar to a flexible array member).
    vmctx: OwnedVMContext<VMContext>,
}
```

[crates/wasmtime/src/runtime/vm/instance.rs#L90-L151](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/instance.rs#L90-L151)

C の flexible array member と同じ形だ。`Instance` のサイズは Rust の `size_of` で分かるが、実際の確保サイズは `size_of::<Instance>()` にモジュール由来の `VMOffsets::size` を足したものになる。

この形が、`Instance` の API 全体を規定している。

```text title="crates/wasmtime/src/runtime/vm/instance.rs"
/// Thus it is not sound to mutate `runtime_info` after an instance is created.
/// More generally it's also not safe to "swap" instances, for example given two
/// `&mut Instance` values it's not sound to swap them as then the `VMContext`
/// values are inaccurately described.
///
/// To encapsulate this guarantee this type is only ever mutated through Rust's
/// `Pin` type. All mutable methods here take `self: Pin<&mut Self>` which
/// statically disallows safe access to `&mut Instance`.
```

`&mut Instance` を 2 つ手に入れて `mem::swap` すると、`runtime_info` が指す `VMOffsets` と末尾の `VMContext` の実体がずれる。オフセット 40 に「グローバル 3 個」と書いてあるのに実際には 300 個ある、という状態が安全な Rust のコードから作れてしまう。だから **`&mut Instance` を一切作らせず、すべての可変メソッドが `Pin<&mut Self>` を取る**。個々のフィールドへの可変アクセスは `memories_mut` のような射影メソッドで出す。`runtime_info` に対する射影メソッドは存在しない。

## 自分自身を指すポインタ

`OwnedVMContext` の唯一の実フィールドは、自分の直後を指すポインタだ。

```rust title="crates/wasmtime/src/runtime/vm/instance.rs"
#[repr(align(16))] // match the alignment of VMContext
pub struct OwnedVMContext<T> {
    /// If you're looking at this a reasonable question would be "why do we need
    /// a pointer to ourselves?" because after all the pointer's value is
    /// trivially derivable from any `&Instance` pointer. The rationale for this
    /// field's existence is subtle, but it's required for correctness. The
    /// short version is "this makes miri happy".
    // ...
    /// It's important to note, though, that this is not here purely for MIRI.
    /// The careful construction of the `fn vmctx` method has ramifications on
    /// the LLVM IR generated, for example. A historical CVE on Wasmtime,
    /// GHSA-ch89-5g45-qwc7, was caused due to relying on undefined behavior. By
    /// deriving VMContext pointers from this pointer it specifically hints to
    /// LLVM that trickery is afoot and it properly informs `noalias` and such
    /// annotations and analysis.
    vmctx_self_reference: SendSyncPtr<T>,

    /// This field ensures that going from `Pin<&mut T>` to `&mut T` is not a
    /// safe operation.
    _marker: core::marker::PhantomPinned,
}
```

[crates/wasmtime/src/runtime/vm/instance.rs#L1590-L1643](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/instance.rs#L1590-L1643)

値としては `self` の次のアドレスでしかなく、`&self` から自明に計算できる。それでも実フィールドとして持っている理由が 2 つ書かれている。

1 つ目は provenance だ。`*mut VMContext` を `&mut Instance` から派生させると、それ以前に派生した `*mut VMContext` がすべて無効化される (Stacked Borrows の規則)。ランタイムの至るところで `vmctx` ポインタを取り直すので、これでは成り立たない。そこで確保時の元のポインタを 1 つ保存しておき、`fn vmctx()` は必ずそのポインタを `with_addr` でアドレスだけ差し替えて返す。**provenance の出所を 1 か所に固定する。**

2 つ目が、実在した脆弱性への対処だ。GHSA-ch89-5g45-qwc7 は未定義動作に頼っていたことが原因だった。このフィールドを経由してポインタを派生させることで、LLVM に「ここで妙なことをしている」と伝わり、`noalias` の付与とエイリアス解析が正しく行われる。**LLVM の最適化を意図的に妨げるためのフィールド**というわけだ。JIT コードが書き込んだ `VMContext` の内容を、Rust 側の読み出しが「書き込まれていないはず」と判断して消すようなことがあってはならない。

そして「実行時のコストはない」ことも明記されている。LLVM IR にはロードが現れるが、バックエンドが通り抜けたあとの機械語は `&mut self.vmctx` と同じになる。コメントの表現を借りると "(that's magic to me, the backend removing loads...)"。

## どう活かすか

ここから持ち帰れるのは、**「型システムで表現できないもの」を型システムの外に出すときの作法**だ。Wasmtime は `VMContext` を Rust の型として書くことを諦めた代わりに、(1) レイアウトの定義をマクロ 1 か所に集め ([レイアウトの単一定義源をマクロで作る](../layout-macro/))、(2) 先頭に magic を置いて誤キャストを debug ビルドで検出し、(3) 誤って swap できないよう `Pin` で `&mut` そのものを封じ、(4) provenance の出所を 1 フィールドに固定した。「unsafe にする」ことと「無防備にする」ことを分けている。

構造体のフィールド順を「アクセス頻度が高いものを前に」で決めるという判断も、キャッシュラインの話としてはよく聞くが、**命令エンコード長の話として明文化されている例は珍しい**。ホットループが触るフィールドがベースポインタから何バイト目にあるかは、測る価値がある。
