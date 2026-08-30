---
title: "スロットの状態機械と、madvise が元の CoW を復元すること"
description: "pooling allocator はスロットを使い回す。前のインスタンスが書き込んだ内容をどう消すのか。Linux の madvise(MADV_DONTNEED) は物理ページを解放しつつ元のマッピングを残すので、CoW イメージが初期状態のまま復活する。この Linux 固有の挙動に乗っているため、他の OS ではスロット再利用が実質成立しない。"
group: "線形メモリの実装"
sidebar:
  order: 46
---

pooling allocator は、線形メモリのスロットを使い回す ([インスタンスアロケータ — 毎回 mmap するか、スロットを貸すか](../instance-allocator/))。あるインスタンスが終了したら、次のインスタンスに同じスロットを渡す。

問題は、**前のインスタンスが書き込んだ内容をどう消すか**だ。素朴にやるなら memset すればよいが、それではスロットのサイズに比例したコストがかかり、pooling の意味が薄れる。しかも [copy-on-write でインスタンス化を速くする](../cow-instantiation/) で見た CoW マッピングは、消したあとで張り直さなければならない。

## 2 つの状態しかない

`MemoryImageSlot` は `dirty` という bool 1 つで状態を持つ。

```rust title="crates/wasmtime/src/runtime/vm/cow.rs"
    /// Whether this slot may have "dirty" pages (pages written by an
    /// instantiation). Set by `instantiate()` and cleared by
    /// `clear_and_remain_ready()`, and used in assertions to ensure
    /// those methods are called properly.
    ///
    /// Invariant: if !dirty, then this memory slot contains a clean
    /// CoW mapping of `image`, if `Some(..)`, and anonymous-zero
    /// memory beyond the image up to `static_size`. The addresses
    /// from offset 0 to `self.accessible` are R+W and set to zero or the
    /// initial image content, as appropriate. Everything between
    /// `self.accessible` and `self.static_size` is inaccessible.
    dirty: bool,
```

[crates/wasmtime/src/runtime/vm/cow.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/cow.rs)

**不変条件が散文で書かれている。** `dirty` でないスロットは、イメージのきれいな CoW マッピングと、その先の匿名ゼロメモリを含み、`accessible` から `static_size` までは触れない。この状態からしかインスタンス化できない。

そして `clear_and_remain_ready` がその状態へ戻す。

```rust title="crates/wasmtime/src/runtime/vm/cow.rs"
    pub(crate) fn clear_and_remain_ready(
        &mut self,
        pagemap: Option<&PageMap>,
        keep_resident: HostAlignedByteCount,
        decommit: impl FnMut(*mut u8, usize),
    ) -> Result<usize> {
        assert!(self.dirty);

        let bytes_resident =
            unsafe { self.reset_all_memory_contents(pagemap, keep_resident, decommit)? };

        self.dirty = false;
        Ok(bytes_resident)
    }
```

`assert!(self.dirty)` が入口にある。**呼び出し順序の誤りを実行時に検出する**ためのもので、`dirty` フラグは実質この検査のために存在している。

## Linux では madvise がマッピングを復元する

内容を消す方法は、プラットフォームによって 2 通りに分かれる。

```rust title="crates/wasmtime/src/runtime/vm/sys/mod.rs"
/// What happens to a mapping after it is decommitted?
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DecommitBehavior {
    /// The mapping is zeroed.
    Zero,
    /// The original mapping is restored. If it was zero, then it is zero again;
    /// if it was a CoW mapping, then the original CoW mapping is restored;
    /// etc...
    RestoreOriginalMapping,
}
```

[crates/wasmtime/src/runtime/vm/sys/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/sys/mod.rs)

**`RestoreOriginalMapping` が Linux の `madvise(MADV_DONTNEED)` の挙動そのものだ。** このシステムコールは物理ページを OS に返すが、**マッピングは残す**。次にそのアドレスを触ると、ページフォルトが起きて、元のマッピングの内容が改めて読み込まれる。

つまり CoW でファイルをマップしていたスロットに `MADV_DONTNEED` をかけると、**書き込んだ内容が消えて、ファイルの元の内容が復活する**。これはまさに「初期状態に戻す」ことに他ならない。CoW マッピングを張り直す必要も、memset する必要もない。システムコール 1 回で済む。

そうでないプラットフォームでは、こうなる。

```rust title="crates/wasmtime/src/runtime/vm/cow.rs"
            DecommitBehavior::Zero => {
                // If we're not on Linux then there's no generic platform way to
                // reset memory back to its original state, so instead reset memory
                // back to entirely zeros with an anonymous backing.
                //
                // Additionally the previous image, if any, is dropped here
                // since it's no longer applicable to this mapping.
                self.reset_with_anon_memory()?;
                Ok(0)
            }
```

**匿名のゼロメモリで丸ごと mmap し直す。** イメージも捨てられる。すると次のインスタンス化では CoW マッピングを最初から張り直すことになるので、スロットを再利用する利点がほとんど消える。cow.rs のヘッダにも「非 Linux プラットフォームでは、再利用は事実上サポートされない」と書かれている。

## Linux 固有の挙動に乗るという選択

これは設計判断として見ると、かなり踏み込んでいる。**pooling allocator の性能特性が、特定の OS の特定のシステムコールの挙動に依存している。**

`MADV_DONTNEED` が「マッピングを残す」のは POSIX が要求していることではない。むしろ他の Unix では `MADV_DONTNEED` の意味が違い、「後で使わないというヒント」程度に扱われることもある。Wasmtime はその差を `DecommitBehavior` という 2 値の enum で抽象化し、**片方の分岐でだけ本気の最適化が効く**という形にしている。

抽象化はしているが、性能は揃わない。「移植可能に書く」ことと「移植先で同じ性能が出る」ことは別だという、当たり前だが見落としやすい区別がここにある。

## 部分的に memset する余地

`clear_and_remain_ready` は `keep_resident` という引数を取る。

これは「先頭のこのバイト数までは `madvise` せず memset で消す」という指定だ。`madvise` はシステムコールなので固定コストがあり、しかも次にそのページを触ったときにページフォルトが起きる。**小さい領域なら、memset したほうがトータルで速い。**

閾値の実装には `pagemap` も絡む。Linux の pagemap を読めば「どのページが実際に常駐しているか」が分かるので、常駐していないページには何もしなくてよい。テストにも `memset_instead_of_madvise` という名前のものがあり、この分岐が意図的に設けられていることが分かる。

「システムコール 1 回」と「バイト数に比例する memset」のどちらが速いかは、サイズによって逆転する。その交点をパラメータとして外に出している。

## madvise をまとめて出す

もう 1 つ、`decommit` がクロージャとして渡されていることに意味がある。スロットの解放処理は `madvise` を即座に呼ばず、`DecommitQueue` に積む。

キューに溜めておいて、まとめて実行する。Linux 6.13 以降なら `process_madvise` でベクタ化でき、複数の領域を 1 回のシステムコールで処理できる。

インスタンスの生成と破棄が高頻度で起きる状況では、この種の「まとめる」最適化が効く。1 回あたりのコストは小さくても、回数が多ければ支配的になる。

## MPK を塗り直す

スロットが匿名メモリで mmap し直された場合、**保護キーがリセットされる**。

```rust title="crates/wasmtime/src/runtime/vm/cow.rs"
    /// This must be re-applied after every `mmap` performed on this slot, since
    /// `mmap` resets the affected pages back to the default key 0 which is
    /// accessible from every stripe.
    pkey: Option<ProtectionKey>,
```

`mmap` は保護キーを既定値 0 に戻すが、`mprotect` は戻さない。既定のキー 0 はすべてのストライプからアクセスできてしまうので、塗り直しを忘れると [メモリ保護キーでガード領域を削る](../mpk/) の分離が崩れる。

`MemoryImageSlot` がキーを自分で保持しているのは、この塗り直しを自分で行えるようにするためだ。**「mmap のあとは塗り直す」という規約を、それを必要とする側の型に持たせている。**

## どう活かすか

このコードから取れるのは、**「元に戻す」を実装するときの選択肢の広さ**だ。

素朴には「上書きして消す」しかないように見える。だが仮想メモリの層まで降りると、「マッピングごと捨てて張り直す」「物理ページだけ返して論理的な内容は元のソースから読み直させる」という選択肢が出てくる。どれもコストの形が違い、サイズによって最適解が変わる。

そして Wasmtime は、そのすべてを 1 つの API（`clear_and_remain_ready`）の裏に隠しつつ、`keep_resident` というパラメータで境目を呼び出し側に開いている。**抽象で覆い、しかし性能に効くつまみは残す。** 性能が用途に依存する層では、この形が扱いやすい。
