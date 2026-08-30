---
title: "型を静的に固定して、呼び出しを速くする"
description: "`TypedFunc` が速い理由は「呼び出し規約が違うから」ではない。`Func::call` も `TypedFunc::call` も同じ array-call ABI を通る。差は型検査を `typed()` の 1 回に前倒ししたこと、引数領域がスタック上の固定長配列になること、戻り値の動的検査が要らないことの 3 つだけである。"
group: "wasmtime のかたち"
sidebar:
  order: 15
---

`Func::call` と `Func::typed().call()` の差は何か。答えを先に言うと、**呼び出し規約は同じ**だ。どちらも `VMFuncRef::array_call` を通り、`[ValRaw]` のスライスで引数と戻り値をやりとりする。速さの正体は別のところにある。

## API は 2×2 に整理されている

`Func` の doc が、呼び出し方の選択肢を明示的に 2 軸で並べている。

```rust title="crates/wasmtime/src/runtime/func.rs"
/// There's a 2x2 matrix of methods to call [`Func`]. Invocations can either be
/// asynchronous or synchronous. They can also be statically typed or not.
///
/// * Dynamically typed - ... These functions take a variable-length slice of
///   "boxed" arguments in their [`Val`] representation. Additionally the
///   results are returned as an owned slice of [`Val`]. These methods are not
///   optimized due to the dynamic type checks that must occur, in addition to
///   some dynamic allocations for where to put all the arguments.
///
/// * Statically typed - ... This structure is static proof
///   that the underlying wasm function has the ascripted type, and type
///   validation is only done once up-front. ...
///   This eschews runtime checks as much as possible to get into wasm as fast
///   as possible.
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L130-L156)

キーワードは "type validation is only done once up-front" と "eschews runtime checks"。**やらなくなるのは検査であって、呼び出しそのものではない。**

## `Func::typed` が前倒しにするもの

```rust title="crates/wasmtime/src/runtime/func.rs"
    pub fn typed<Params, Results>(&self, store: impl AsContext)
        -> Result<TypedFunc<Params, Results>>
    where
        Params: WasmParams,
        Results: WasmResults,
    {
        // Type-check that the params/results are all valid
        let store = store.as_context().0;
        let ty = self.load_ty(store);
        Params::typecheck(store.engine(), ty.params(), TypeCheckPosition::Param)
            .context("type mismatch with parameters")?;
        Results::typecheck(store.engine(), ty.results(), TypeCheckPosition::Result)
            .context("type mismatch with results")?;

        // and then we can construct the typed version of this function
        // (unsafely), which should be safe since we just did the type check above.
        unsafe { Ok(TypedFunc::_new_unchecked(store, *self)) }
    }
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L1414-L1433)

`load_ty` は Engine の型レジストリからロックを取って `FuncType` をクローンする「やや高価な」操作だ ([Func は 2 ワードしかない](../func-two-words/))。`Func::call` はこれを毎回やる。`Func::typed` は 1 回だけやって、結果を `TypedFunc` に持っておく。

```rust title="crates/wasmtime/src/runtime/func/typed.rs"
pub struct TypedFunc<Params, Results> {
    _a: marker::PhantomData<fn(Params) -> Results>,
    ty: FuncType,
    func: Func,
}
```

`ty: FuncType` を持ち続ける理由は、静的検査だけでは足りないケースがあるからだ。これは後述する。

## `call_raw` — スタック上の共用体 1 個で全部済ませる

`TypedFunc::call` の中身はこうなっている。

```rust title="crates/wasmtime/src/runtime/func/typed.rs"
    pub(crate) unsafe fn call_raw<T>(
        store: &mut StoreContextMut<'_, T>,
        ty: &FuncType,
        func: ptr::NonNull<VMFuncRef>,
        params: Params,
    ) -> Result<Results> {
        union Storage<T: Copy, U: Copy> {
            params: MaybeUninit<T>,
            results: U,
        }

        let mut storage = Storage::<Params::ValRawStorage, Results::ValRawStorage> {
            params: MaybeUninit::uninit(),
        };

        {
            let mut store = AutoAssertNoGc::new(store.0);
            let dst: &mut MaybeUninit<_> = unsafe { &mut storage.params };
            params.store(&mut store, ty, dst)?;
        }

        let mut captures = (func, storage);

        let result = invoke_wasm_and_catch_traps(store, |caller, vm| {
            let (func_ref, storage) = &mut captures;
            let storage_len = mem::size_of_val::<Storage<_, _>>(storage) / mem::size_of::<ValRaw>();
            let storage: *mut Storage<_, _> = storage;
            let storage = storage.cast::<ValRaw>();
            let storage = core::ptr::slice_from_raw_parts_mut(storage, storage_len);
            let storage = NonNull::new(storage).unwrap();

            unsafe { VMFuncRef::array_call(*func_ref, vm, caller, storage) }
        });

        let (_, storage) = captures;
        result?;

        let mut store = AutoAssertNoGc::new(store.0);
        unsafe { Ok(Results::load(&mut store, &storage.results)) }
    }
```

[crates/wasmtime/src/runtime/func/typed.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func/typed.rs#L148-L223)

`Params::ValRawStorage` と `Results::ValRawStorage` は、それぞれ `[ValRaw; N]` という**コンパイル時に長さの決まった配列**だ。引数と戻り値は同じ領域を使い回すので `union` になっている。**ヒープ確保は一切ない。**

そして `VMFuncRef::array_call` を呼ぶ。これは Wasmtime のすべての wasm 関数が持つ、統一されたホスト向けエントリポイントだ ([array-call ABI — 全関数が同じ Rust シグネチャになる](../array-call-abi/))。

`captures` を `(func, storage)` というタプル 1 個にまとめているのにも理由が書かれている ——「クロージャがキャプチャする変数を 1 個 (タプル) だけにする。こうするとクロージャのサイズがポインタ 1 個ぶんになり、メモリ上を動かすのが効率的になる。このクロージャは C++ のシムの向こう側で呼ばれるので、インライン化でメモリごと消すことは決してできない。だからここではサイズが性能に効く」。

## 同じ ABI を通る証拠

対する `Func::call` の実装を見ると、最終的に呼ぶものが同じであることが分かる。

```rust title="crates/wasmtime/src/runtime/func.rs"
    unsafe fn call_impl_do_call<T>(&self, store: &mut StoreContextMut<'_, T>,
                                   params: &[Val], results: &mut [Val]) -> Result<()> {
        let ty = self.load_ty(store.0);
        let values_vec_size = params.len().max(ty.results().len());
        let mut values_vec = store.0.take_wasm_val_raw_storage();
        values_vec.resize_with(values_vec_size, || ValRaw::v128(0))?;
        for (arg, slot) in params.iter().cloned().zip(&mut values_vec) {
            *slot = arg.to_raw(&mut *store)?;
        }
        unsafe { self.call_unchecked(&mut *store, /* values_vec のスライス */)?; }
        // ... 結果を Val に戻す ...
        values_vec.truncate(0);
        store.0.save_wasm_val_raw_storage(values_vec);
        Ok(())
    }

    pub(crate) unsafe fn call_unchecked_raw<T>(
        store: &mut StoreContextMut<'_, T>,
        func_ref: NonNull<VMFuncRef>,
        params_and_returns: NonNull<[ValRaw]>,
    ) -> Result<()> {
        invoke_wasm_and_catch_traps(store, |caller, vm| unsafe {
            VMFuncRef::array_call(func_ref, vm, caller, params_and_returns)
        })
    }
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L1024-L1034)

**行き着く先は同じ `VMFuncRef::array_call` だ。** 差は 3 つに絞られる。

1. **型検査のタイミング。** `Func::call` は毎回 `call_impl_check_args` で引数の個数・型・Store の一致を確認する。`TypedFunc` は `typed()` の 1 回で済ませ、`debug_assertions` のときだけ `debug_typecheck` を回す。
2. **引数領域。** `TypedFunc` はスタック上の固定長 `union`。`Func::call` は `Vec<ValRaw>` で、しかもそれを毎回確保しないよう Store から借りて返す (`take_wasm_val_raw_storage` / `save_wasm_val_raw_storage`)。返すときも `if storage.capacity() > self.wasm_val_raw_storage.capacity()` と、容量が増えたときだけ差し替える。
3. **戻り値の検査。** ここが 3 つ目で、しかも省略できない理由がある。

## 戻り値だけは動的に検査せざるを得ない

ホスト関数の側、つまり wasm がホスト関数を呼んで戻る局面のコードにこう書かれている。

```rust title="crates/wasmtime/src/runtime/func.rs"
        // Unlike our arguments we need to dynamically check that the return
        // values produced are correct. There could be a bug in `func` that
        // produces the wrong number, wrong types, or wrong stores of
        // values, and we need to catch that here.
        let results = &args_then_results[ty.params().len()..];
        for (i, (ret, ty)) in results.iter().zip(ty.results()).enumerate() {
            ret.ensure_matches_ty(store.0, &ty)
                .context("function attempted to return an incompatible value")?;
            storage[i].write(ret.to_raw(store.as_context_mut())?);
        }
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L2554-L2576)

引数はこちらが用意したので信用できる。だが `Func::new` で登録された動的なホスト関数が返す `Vec<Val>` は、**埋め込み側が書いたコードの出力**だ。個数が違うかもしれないし、型が違うかもしれないし、別の Store の値が混ざっているかもしれない。それを wasm 側に渡す前に捕まえないと、サンドボックスの内側の型安全性が崩れる。`Func::wrap` の静的版ならこの検査は不要で、そのぶん速い。

ここでも同じ `Vec<Val>` の使い回しが効いている。`Func::new` の動的ホスト関数は `StoreOpaque::hostcall_val_storage` から `Vec<Val>` を借り、使い終わったら返す。**ホスト関数呼び出しのたびにアロケータを叩かないための、単純なプール**だ。

## `Func::wrap` — 0 引数から 17 引数まで

`Func::wrap` は `IntoFunc` トレイトに委譲され、その実装はマクロで量産される。

```rust title="crates/wasmtime/src/runtime/func.rs"
macro_rules! for_each_function_signature {
    ($mac:ident) => {
        $mac!(0);
        $mac!(1 A1);
        $mac!(2 A1 A2);
        // ...
        $mac!(17 A1 A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A12 A13 A14 A15 A16 A17);
    };
}
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L294-L315)

`impl_into_func!` はこれを受けて、引数個数ごとに 2 つの impl を出す。1 つは `Fn(A1, A2, ...) -> R`、もう 1 つは `Fn(Caller<'_, T>, A1, A2, ...) -> R`。前者は後者にクロージャで包み直して委譲するだけなので、実質のコードは 1 系統しかない。**Rust に可変長ジェネリクスがないので、上限 17 で打ち止めにして手で並べる**という素朴な解決になっている。

`Func::wrap` に渡すクロージャが `Fn + Send + Sync + 'static` を要求される理由も doc に書かれている。

```text title="crates/wasmtime/src/runtime/func.rs"
The reason for this, though, is to ensure that `Store<T>` can implement both
the `Send` and `Sync` traits.

Fear not, however, because this isn't as restrictive as it seems! Host
functions are provided a `Caller<'_, T>` argument which allows access to the
host-defined data within the `Store`. The `T` type is not required to be any of
`Send`, `Sync`, or `'static`!
```

[crates/wasmtime/src/runtime/func.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func.rs#L627-L649)

**可変状態はクロージャに閉じ込めるのではなく `Store<T>` の `T` に置け**、というのが Wasmtime の推奨する形だ。そうすればクロージャは実質ゼロサイズになり、`Store` の `Send`/`Sync` も守れる。API 上の制約が、そのまま使い方の誘導になっている。

## concrete 参照型だけ、静的検査を緩めてある

`WasmTy::typecheck` は引数位置と戻り値位置で向きが逆になる。戻り値は「呼び出し側が `T` を期待し、実際は `U` が返る」ので `U <: T`、引数は「呼び出し側が `T` を渡し、受け側が `U` を期待する」ので `T <: U`。ここまでは素直だが、引数側に例外がある。

```rust title="crates/wasmtime/src/runtime/func/typed.rs"
            TypeCheckPosition::Param => match (expected.as_ref(), actual.as_ref()) {
                // ... except that this technically-correct check would overly
                // restrict the usefulness of our typed function APIs for the
                // specific case of concrete reference types. ...
                //
                // * We cannot have a static `wasmtime::SomeFuncTypeRef` type
                //   that implements `WasmTy` specifically for `(ref null
                //   $some_func_type)` because Wasm modules, and their types,
                //   are loaded dynamically at runtime.
                //
                // * Therefore the embedder's only option for `T <: (ref null
                //   $some_func_type)` is `T = (ref null nofunc)` aka
                //   `Option<wasmtime::NoFunc>`.
                //
                // * But that static type means they can *only* pass in the null
                //   function reference as an argument to the typed function.
                //   This is way too restrictive! ...
                //
                // To lift this constraint ... we allow `top(T) <: top(U)` --
                // i.e. they are part of the same type hierarchy and a dynamic
                // cast could possibly succeed -- for the specific case of
                // concrete heap type parameters, and fall back to dynamic type
                // checks on the arguments passed to each invocation.
                (Some(expected_ref), Some(actual_ref)) if actual_ref.heap_type().is_concrete() => {
                    let expected_top = HeapType::from(expected_ref.heap_type().top());
                    let actual_top = HeapType::from(actual_ref.heap_type().top());
                    expected_top.ensure_matches(engine, &actual_top)
                }
                _ => expected.ensure_matches(engine, &actual),
            },
```

[crates/wasmtime/src/runtime/func/typed.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func/typed.rs#L256-L304)

問題の構造はこうだ。wasm の型は**実行時に読み込まれる**ので、Rust 側に `(ref $some_func_type)` に対応する静的な型を用意できない。厳密な部分型検査を適用すると、`ref $t` を取る関数に渡せる Rust の型は「null funcref だけ」という無意味な結論になる。

そこで Wasmtime は、concrete な heap type が引数に来たときだけ検査を **「同じ型階層に属しているか」(`top(T) <: top(U)`)** まで緩め、実際の部分型判定は呼び出しごとの動的検査 (`dynamic_concrete_type_check`) に落とした。`TypedFunc` が `ty: FuncType` を持ち続けているのは、この動的検査に実際の型が要るからだ。

**「静的に検査したいが、静的な型が原理的に書けない」という状況で、緩めた静的検査と動的検査の組み合わせを選んだ**ことになる。コメントに "technically-correct check would overly restrict the usefulness" とあるとおり、正しさではなく実用性を根拠にした判断だ。

## ABI 変換の途中で GC してはいけない

`call_raw` の中で 2 回登場する `AutoAssertNoGc` にも、明示された理由がある。`WasmTy::store` に付いた 26 行のコメントが、GC が走った場合に何が起きるかを具体的に列挙している。

```rust title="crates/wasmtime/src/runtime/func/typed.rs"
    // NB: We _must not_ trigger a GC when passing refs from host code into Wasm
    // (e.g. returned from a host function or passed as arguments to a Wasm
    // function). After insertion into the activations table, the reference is
    // no longer rooted. If multiple references are being sent from the host
    // into Wasm and we allowed GCs during insertion, then the following events
    // could happen:
    //
    // * Reference A is inserted into the activations table. This does not
    //   trigger a GC, but does fill the table to capacity.
    //
    // * The caller's reference to A is removed. Now the only reference to A is
    //   from the activations table.
    //
    // * Reference B is inserted into the activations table. Because the table
    //   is at capacity, a GC is triggered.
    //
    // * A is reclaimed because the only reference keeping it alive was the
    //   activation table's reference (it isn't inside any Wasm frames on the
    //   stack yet, so stack scanning and stack maps don't increment its
    //   reference count).
    //
    // * We transfer control to Wasm, giving it A and B. Wasm uses A. That's a
    //   use-after-free bug.
    //
    // In conclusion, to prevent uses-after-free bugs, we cannot GC while
    // converting types into their raw ABI forms.
    fn store(self, store: &mut AutoAssertNoGc<'_>, ptr: &mut MaybeUninit<ValRaw>) -> Result<()>;
```

[crates/wasmtime/src/runtime/func/typed.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/func/typed.rs#L352-L377)

穴は「ホストから wasm へ複数の参照を渡す途中」という一瞬に開く。**その瞬間、参照 A はホスト側からもう手放されていて、wasm のスタックフレームにはまだ乗っていない。** 保守的な GC のルートスキャンから見て、どこからも見えない状態が存在する。

対策はシンプルで、その区間を型で囲う。

```rust title="crates/wasmtime/src/runtime/store.rs"
/// An RAII type to automatically mark a region of code as unsafe for GC.
pub struct AutoAssertNoGc<'a> {
    store: &'a mut StoreOpaque,
    entered: bool,
}
```

[crates/wasmtime/src/runtime/store.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/store.rs#L601-L673)

`new` で `enter_no_gc_scope()`、`Drop` で `exit_no_gc_scope()` を呼ぶ。そして `WasmTy::store` / `WasmTy::load` のシグネチャが `&mut StoreOpaque` ではなく `&mut AutoAssertNoGc<'_>` を要求することで、**「no-GC スコープの外からこの関数を呼ぶ」ことがコンパイルエラーになる**。守るべき区間を RAII 型で表し、それを引数の型に要求する。守り忘れを型で潰す典型的な形だ ([DRC — 「遅延」参照カウントとは何か](../drc/))。

## どう活かすか

「速い API」を設計するとき、何を前倒しにしたのかを自分で説明できるかが重要だ。`TypedFunc` の場合、前倒しにしたのは検査であって呼び出し規約ではない。もし「typed だから直接ネイティブ ABI で呼んでいるのだろう」と誤解したまま最適化しようとすると、見当違いの場所を探すことになる。

そして `AutoAssertNoGc` のような **「危険な区間」を型として実体化する**手法は応用が広い。ロックを取っている間、割り込みを禁止している間、トランザクションの途中 —— 「この間はこれをしてはいけない」という制約は、コメントに書くよりも、その区間でしか作れない型を引数に要求するほうが確実に守れる。
