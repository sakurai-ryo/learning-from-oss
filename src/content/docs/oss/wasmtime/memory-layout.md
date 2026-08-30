---
title: "4GiB 予約と 32MiB ガードの配置"
description: "64bit ホストで wasm の線形メモリを 1 ページ作ると、8GiB の仮想アドレス空間が予約される。前後に置かれるガード領域は役割が違い、後ろのものは境界チェックを消すため、前のものは Cranelift のバグへの保険として置かれている。32MiB という数字の根拠は SpiderMonkey の実測にある。"
group: "線形メモリの実装"
sidebar:
  order: 43
---

`(memory 1)` と書かれた wasm モジュールをインスタンス化すると、線形メモリのサイズは 64KiB になる。ところが 64bit ホストでは、そのために **8GiB の仮想アドレス空間が予約される**。

```text
                pre_guard        accessible        reserve            post_guard
              (2GiB, PROT_NONE)  (64KiB, RW)     (残り, PROT_NONE)   (32MiB〜, PROT_NONE)
             ┌─────────────────┬──────────┬────────────────────────┬─────────────────┐
             │                 │##########│                        │                 │
             └─────────────────┴──────────┴────────────────────────┴─────────────────┘
                               ▲          ▲
                               │          └─ wasm から見えるメモリの終わり
                               └─ wasm のアドレス 0
```

物理メモリを 8GiB 使うわけではない。`PROT_NONE` で予約されているだけで、触らなければページは割り当てられない。だが、この予約が[境界チェックを「消す」ための条件](../bounds-check-elision/)を成立させている。

## 数字の根拠

既定値は `Tunables` にある。64bit ホスト向けの定義に、選んだ理由がそのまま書かれている。

```rust title="crates/environ/src/tunables.rs"
    /// Returns the default set of tunables for running under a 64-bit host.
    pub fn default_u64() -> Tunables {
        Tunables {
            // 64-bit has tons of address space to static memories can have 4gb
            // address space reservations liberally by default, allowing us to
            // help eliminate bounds checks.
            //
            // A 32MiB default guard size is then allocated so we can remove
            // explicit bounds checks if any static offset is less than this
            // value. SpiderMonkey found, for example, that in a large corpus of
            // wasm modules 20MiB was the maximum offset so this is the
            // power-of-two-rounded up from that and matches SpiderMonkey.
            memory_reservation: 1 << 32,
            memory_guard_size: 32 << 20,
            // ...
```

[crates/environ/src/tunables.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/environ/src/tunables.rs)

**4GiB** は wasm の 32bit アドレス空間そのものだ。`i32` で表せるアドレスは 4GiB を超えないので、この範囲を予約しておけば「アドレスが線形メモリの外を指す」ことはあっても「予約領域の外を指す」ことはない。

**32MiB** のほうは経験則だ。wasm のロード命令は「動的なアドレス + 静的なオフセット」の形を取るので、実効アドレスは 33bit まで届きうる。静的オフセットがガード領域より小さければ、そのアクセスは必ず予約領域の中に収まる。ではオフセットは実際どこまで大きくなるのか。**「SpiderMonkey が大量の wasm モジュールを調べたところ最大 20MiB だった。それを 2 の冪に切り上げた値で、SpiderMonkey と一致させてある」。**

数字の出どころが「他の実装の実測に合わせた」であることが明記されているのは珍しい。理論的な上限ではなく、現実の分布から選んでいる。オフセットが 32MiB を超えるアクセスがあっても正しく動く（境界チェックが入るだけ）ので、外れても壊れないという性質が、この選び方を許している。

## 32bit ホストでは全部変わる

同じファイルに 32bit 向けの既定値がある。

```rust title="crates/environ/src/tunables.rs"
    /// Returns the default set of tunables for running under a 32-bit host.
    pub fn default_u32() -> Tunables {
        Tunables {
            // For 32-bit we scale way down to 10MB of reserved memory. This
            // impacts performance severely but allows us to have more than a
            // few instances running around.
            memory_reservation: 10 * (1 << 20),
            memory_guard_size: 0x1_0000,
            memory_reservation_for_growth: 1 << 20, // 1MB
            signals_based_traps: true,
            // ...
```

32bit ホストのアドレス空間は 4GiB しかないので、1 インスタンスに 4GiB を予約したら 1 個も作れない。**10MB に落とす。** そしてコメントが認めているとおり「性能は著しく落ちるが、数個以上のインスタンスを同時に持てるようになる」。

この時点で境界チェックの除去は成立しなくなる。予約が 4GiB に届かないので、wasm のアドレスが予約領域の外を指しうる。だから明示的な境界チェックが常に入る。ガードページは残っているが、役割が「チェックを消す」から「チェックを重複排除する」に変わる。

**同じコードが、ホストのアドレス空間の広さによって別の戦略で動く。** そしてどちらの戦略でコンパイルされたかは `.cwasm` の互換性判定で照合される ([Tunables を全フィールド分割代入して、互換性の判断漏れを防ぐ](../tunables-compat/))。4GiB 予約でコンパイルしたコードを 10MB 予約のエンジンに読み込ませたら、境界チェックのないコードが小さな予約領域の上で動くことになるからだ。

## 前と後ろのガードは役割が違う

`MmapMemory` は前後にガード領域を置く。

```rust title="crates/wasmtime/src/runtime/vm/memory/mmap.rs"
    // Size in bytes of extra guard pages before the start and after the end to
    // optimize loads and stores with constant offsets.
    pre_guard_size: HostAlignedByteCount,
    offset_guard_size: HostAlignedByteCount,
```

[crates/wasmtime/src/runtime/vm/memory/mmap.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasmtime/src/runtime/vm/memory/mmap.rs)

後ろのガードは、これまで見てきたとおり境界チェックを消すためのものだ。wasm が線形メモリの終端を少し超えたアドレスを触ったとき、そこは `PROT_NONE` なので SIGSEGV が飛び、シグナルハンドラがトラップに変換する ([wasm のトラップはシグナルで実現される](../traps-via-signals/))。

前のガードは違う。**アドレスが負の方向にずれたときの保険**だ。正しくコンパイルされたコードなら、wasm のアドレスは符号なしとして扱われるので、線形メモリの手前を指すことはない。指すとしたら、それは符号拡張のバグだ。

`docs/security.md` が、この位置づけをはっきり書いている。前方ガードは defense-in-depth であって、正常な動作では決して到達しない。つまり**これは wasm の悪意ではなく、Cranelift のバグに対する保険**である。実際に過去、境界チェックまわりの符号の扱いは繰り返し問題になっている箇所で、[境界チェックを「消す」ための条件を数式で追う](../bounds-check-elision/) で見る「実質的な変更にはレビュー 2 人」という警告と同じ懸念から来ている。

`guard_before_linear_memory` は `Config` で切れるが、切ると 1 つ防御が減る。

## pooling allocator ではガードが重なる

[インスタンスアロケータ — 毎回 mmap するか、スロットを貸すか](../instance-allocator/) で見る pooling allocator を使うと、レイアウトが変わる。スロットが連続して並ぶので、**あるスロットの後方ガードが、次のスロットの前方ガードを兼ねられる**。

そのぶん 1 メモリあたりの仮想アドレス消費が、既定の 8GiB から 6GiB に減る。仮想アドレス空間は 64bit ホストでも無限ではないので、同時に持てるインスタンス数に直結する。

そのかわり pooling allocator ではメモリをリサイズできない。`memory_reservation` が 4GiB より小さければ、それがそのまま線形メモリの上限になる。伸長時に別の場所へコピーする、という逃げ道がない。

## ページサイズ 1 の線形メモリ

custom-page-sizes proposal を使うと、ページサイズを 2^0 = 1 バイトにできる。この場合、仮想メモリでトラップを捕捉する方式は使えない。

`Memory::can_use_virtual_memory` の条件が `page_size_log2 >= host_page_size_log2` を含んでいるからだ。wasm のページがホストのページより小さいと、「wasm のメモリの終わり」がホストのページの途中に来る。ページ単位でしか保護属性を設定できない以上、そこに境界は引けない。

結果として、ページサイズ 1 のメモリには**常に明示的な境界チェックが入る**。仮想メモリ自体は使えるので mmap はするが、保護属性による検出には頼らない。

## 設定の組み合わせ

`Config` には線形メモリに関わるつまみが 7 つある。`memory_reservation`、`memory_may_move`、`memory_guard_size`、`memory_reservation_for_growth`、`memory_init_cow`、`guard_before_linear_memory`、`signals_based_traps`。

これらは互いに独立するよう設計されている。`docs/contributing-architecture.md` にこう書かれている。

```text title="docs/contributing-architecture.md"
The high-level design goal of Wasmtime is such that each option
is independent from all the others and is a knob for just its behavior. In this
way it should be possible to customize the needs of embedders.
```

そして「フル機能のプラットフォーム（64bit）の上で、他のプラットフォームの既定設定を再現できること」も目標に挙げられている。テストと fuzzing とデバッグのためだ。**32bit ホストや `no_std` 環境でしか起きない挙動を、開発機の上で再現できるようにしておく。** 組み合わせが増えるほどテストは難しくなるので、まず再現できることを設計目標に置いている。
