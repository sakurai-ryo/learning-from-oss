---
title: "Bump アリーナと Box / Vec"
description: "AST は「1 ファイル分をまとめて作り、まとめて捨てる」データだ。ノードごとに malloc/free を呼ぶ理由がない。oxc はポインタを 1 本進めるだけの bump アリーナに AST を載せ、個別の Drop を静的に禁止し、Vec の len/cap を u32 に削り、さらに Arena 構造体のフィールド順まで aarch64 のストア転送ハザードに合わせて並べている。2.92MB の checker.ts のパースでシステムアロケータが呼ばれるのは 19 回しかない。"
group: "木の設計 — Allocator・AST・コード生成"
sidebar:
  order: 30
---

## 何を学んだか

AST には特殊な性質がある。**1 ファイルをパースする間に何十万個もノードを作り、そのファイルの処理が終わったら全部まとめて捨てる。** 途中で個別に解放したいノードは 1 つもない。

この性質にちょうど合う道具が bump アリーナだ。大きなメモリの塊を確保しておき、割り当てのたびにポインタを 1 本進めるだけ。解放はしない。塊ごと捨てるときに全部消える。

oxc はこれを徹底していて、次のようになっている。

- **アリーナに入る型は `Drop` を実装していてはならない。** これはコンパイル時に静的に弾かれる
- **`Vec<'a, T>` の `len` / `cap` は `usize` ではなく `u32`。** ソースファイルは 4GB 未満という前提を、コレクションの表現にまで持ち込んでいる
- **`Arena` 構造体のフィールド順が aarch64 のマイクロアーキテクチャに合わせて決められている。** ホットな 2 本のポインタを隣接させないために、間に別のフィールドを挟んでいる

結果として、**2.92MB の `checker.ts` をパースする間にシステムアロケータが呼ばれるのは 19 回**になる。アリーナ側の割り当ては 262,590 回だが、そちらはポインタの加算でしかない。

## なぜそうなっているか

### なぜ bumpalo を依存せずフォークしたのか

`crates/oxc_allocator/src/arena/mod.rs` の冒頭にこう書いてある。

```rust title="crates/oxc_allocator/src/arena/mod.rs"
//! Arena allocator.
//!
//! The files in this directory were originally derived from `bumpalo` at commit
//! a47f6d6b7b5fee9c99a285f0de80257a0a982ef3 (2 commits after 3.20.2 release).
//! Changes have been made since.
```

派生元のコミットハッシュまで明記したうえでベンダリングしている。理由は、この後に出てくる改造の性質を見ると分かる。**`MIN_ALIGN` を const ジェネリクスにする、固定サイズ・高アライメントのアリーナを作れるようにする、`Vec` の `len`/`cap` を `u32` に変える** — どれも上流の bumpalo に入れてもらう類の変更ではない。oxc の AST という 1 つのユースケースに合わせた特殊化だからだ。

依存として使うと、こういう変更はできない。フォークしてベンダリングすれば、その代わりに上流の改善を自分で取り込む責任を負う。派生元コミットを書き残しているのは、その責任を果たすための最低限の仕掛けになっている。

### なぜ `Drop` 型を禁じられるのか

アリーナは個別の解放をしない。ということは、**`Drop` を持つ型をアリーナに置くと、その `Drop` は永久に呼ばれない。** `Vec<T>` (std の) をアリーナに置けば、そのヒープ確保は漏れる。`File` を置けば fd が漏れる。

普通のアリーナライブラリはこれを「ドキュメントで注意する」で済ませる。oxc は型で禁じた。

```rust title="crates/oxc_allocator/src/boxed.rs"
/// A `Box` without [`Drop`], which stores its data in the arena allocator.
///
/// # No `Drop`s
///
/// Objects allocated into Oxc memory arenas are never [`Dropped`](Drop). Memory is released in bulk
/// when the allocator is dropped, without dropping the individual objects in the arena.
///
/// Therefore, it would produce a memory leak if you allocated [`Drop`] types into the arena
/// which own memory allocations outside the arena.
///
/// Static checks make this impossible to do. [`Box::new_in`] will refuse to compile if called
/// with a [`Drop`] type.
#[repr(transparent)]
pub struct Box<'alloc, T: ?Sized>(NonNull<T>, PhantomData<(&'alloc (), T)>);
```

`Box::new_in` は `Drop` 型に対してコンパイルを通さない。これで「アリーナに置いたら漏れる型」というカテゴリ全体が消える。AST のノード定義に `String` ではなく `&'a str` が、`Vec<T>` ではなく `oxc_allocator::Vec<'a, T>` が現れるのは、この制約の帰結だ。

### `Box` は `Send` で `Vec` は `Send` でない

同じアリーナ上のスマートポインタなのに、`Box` と `Vec` で auto trait の扱いが違う。理由がコメントに書かれている。

```rust title="crates/oxc_allocator/src/boxed.rs"
/// SAFETY: A [`Box`] has exclusive access to the `T` it points to, and grants access to nothing else,
/// so it gets the same auto traits as the `&'alloc mut T` it stands in for.
///
/// Unlike [`Vec`], a `Box` holds no `&Arena`. There is no way from a `Box` to the [`Allocator`]
/// it points into, so 2 `Box`es on different threads cannot both allocate from the same arena -
/// which is the reason `Vec` cannot be `Send`.
unsafe impl<T: Send + ?Sized> Send for Box<'_, T> {}
```

**`Vec` はアリーナへの参照を自分の中に持っている** (`push` で伸ばすときに割り当てる必要があるため)。だから 2 つのスレッドが同じアリーナに同時に割り当てにいける形になってしまう。`Box` はポインタしか持たないのでその危険がない。

境界の引き方が細かい。「アリーナ上のものは全部 `!Send`」で丸めていない。

### `u32` の len と cap

`Vec` の裏にある `RawVec` はこうなっている。

```rust title="crates/oxc_allocator/src/vec2/raw_vec.rs"
#[repr(C)]
pub struct RawVec<'a, T, A: Alloc> {
    ptr: NonNull<T>,
    len: u32,
    cap: u32,
    alloc: &'a A,
}
```

`len` と `cap` が `u32` なので、この 2 つで 8 バイト。`usize` なら 16 バイトになるところだ。`ptr` 8 + `len`/`cap` 8 + `alloc` 8 = 24 バイトで収まる。

これが効くのは、**AST のノードが `Vec` をフィールドとして大量に持つから**だ。`Program` は `comments` / `directives` / `body` の 3 本、`CallExpression` は `arguments`、`ObjectExpression` は `properties`。1 本あたり 8 バイト削れると、木全体では相当な量になる。

前提は「ソースファイルは 4GB 未満」で、これは `Span` が `u32` である前提と同じものだ ([AST のメモリレイアウト](./ast-memory-layout/))。同じ 1 つの割り切りが、`Span` にもコレクションにも効いている。

### フィールド順がマイクロアーキテクチャで決まっている

`Arena` の定義の上にある長いコメントが、この crate でいちばん面白い箇所かもしれない。

```rust title="crates/oxc_allocator/src/arena/mod.rs"
// `#[repr(C)]` plus deliberate field ordering to defeat a store-to-load forwarding hazard on aarch64.
// The fast path reads `cursor_ptr` and `start_ptr`, and writes `cursor_ptr` on every allocation.
// If `cursor_ptr` and `start_ptr` were adjacent (offsets 0 and 8), LLVM's aarch64 backend fuses them
// into a single 16-byte `ldp` instruction. That `ldp` then partial-overlaps the 8-byte `cursor_ptr` store
// from the previous iteration, which breaks store-to-load forwarding and causes a ~3x slowdown in tight
// allocation loops.
// `current_chunk_footer_ptr` is placed between the two hot pointers so they sit at offsets 0 and 16,
// forcing LLVM to emit two independent 8-byte `ldr`s, each of which forwards cleanly.
#[repr(C)]
#[derive(Debug)]
pub struct Arena<const MIN_ALIGN: usize = 1> {
    /// Bump allocation cursor.
    ...
}
```

割り当ての速い経路は「`cursor_ptr` を読む → `start_ptr` と比べる → `cursor_ptr` を書く」の 3 手しかない。この 2 本のポインタが隣り合っていると、aarch64 の LLVM バックエンドが 16 バイトの `ldp` 1 命令に融合する。ところがその `ldp` は、前の反復で書いた 8 バイトの `cursor_ptr` ストアと**部分的にしか重ならない**。CPU のストア転送はこの部分重複を処理できず、ストアがキャッシュに書き戻るまで待つ。3 倍遅くなる。

対策は「間に別のフィールドを挟んでオフセットを 0 と 16 にする」。`#[repr(C)]` はそのためにある。

**ここまで来ると、フィールド順はもう実装詳細ではなく仕様だ。** だからコメントが 10 行あり、理由と数字が書いてある。この種のコメントが消えると、次に誰かが「フィールドを論理的な順に並べ直す」リファクタをした瞬間に 3 倍遅くなる。

### アリーナは下向きに伸びる

もう 1 つ細かいが効く判断がある。

```rust title="crates/oxc_allocator/src/arena/mod.rs"
    /// Bump allocation cursor.
    ///
    /// `Arena` bumps downwards, so this is pointer to the start of the last allocated object
    /// in the current chunk, or to the current chunk's `ChunkFooter` if nothing has been
    /// allocated in the current chunk yet.
```

上向き (低位から高位へ) に伸ばすと、割り当てのたびに「アライメント調整 → サイズ加算 → 上限チェック」が要る。下向きだと「サイズ減算 → アライメント切り下げ → 下限チェック」になり、アライメント調整がビットマスク 1 回 (`ptr & !(align - 1)`) で済む。bumpalo 由来の設計だが、chunk の末尾に `ChunkFooter` を置くレイアウトもここから来ている。

## ソースコードのどこか

- [`crates/oxc_allocator/src/arena/mod.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/arena/mod.rs) — `Arena` 本体。派生元コミットとフィールド順のコメント
- [`crates/oxc_allocator/src/arena/alloc.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/arena/alloc.rs) — `alloc` / `try_alloc` / `alloc_with`
- [`crates/oxc_allocator/src/boxed.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/boxed.rs) — `Box<'a, T>` と Send/Sync の SAFETY コメント
- [`crates/oxc_allocator/src/vec2/raw_vec.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_allocator/src/vec2/raw_vec.rs) — `u32` の len/cap

`alloc` は最終的に `alloc_layout` に落ちるが、途中に `alloc_with` という層がある。

```rust title="crates/oxc_allocator/src/arena/alloc.rs"
    #[inline(always)]
    pub fn alloc<T>(&self, val: T) -> &mut T {
        self.alloc_with(|| val)
    }
```

`alloc(val)` は意味的には「`val` をスタックに作ってヒープに move」で、LLVM がこれを「最初からヒープに書く」に潰してくれるかどうかが速度を分ける。`alloc_with` にクロージャ経由で渡し、書き込み部分をさらに `inner_writer` という独立した関数に切り出しているのは、その潰しが安定して効くようにするためだと書かれている。

```rust title="crates/oxc_allocator/src/arena/alloc.rs"
        // This function is translated as:
        // - Allocate space for a T on the stack.
        // - Call `f()` with the return value being put onto this stack space.
        // - memcpy from the stack to the heap.
        //
        // Ideally we want LLVM to always realize that doing a stack allocation is unnecessary and
        // optimize the code so it writes directly into the heap instead. It seems we get it to
        // realize this most consistently if we put this critical line into it's own function
        // instead of inlining it into the surrounding code.
        slot.write(f())
```

### 実測値が CI に固定されている

これらの積み上げがどこまで効いているかは、[`tasks/track_memory_allocations/`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/tasks/track_memory_allocations/) の YAML スナップショットで見られる。

```yaml title="tasks/track_memory_allocations/allocs_parser.yaml"
checker.ts:
  file size: 2922154 # 2.92 MB
  sys allocs: 19
  sys reallocs: 10
  sys deallocs: 19
  sys alloc bytes: 4820 # 4.82 kB
  sys peak growth: 2432 # 2.43 kB
  arena allocs: 262590
  arena reallocs: 22858
  arena size: 12923744 # 12.92 MB
```

2.92MB のソースをパースして、AST は 12.92MB になる。その間のシステムアロケーションは 19 回・合計 4.82kB。アリーナ側の 262,590 回はポインタの加算でしかない。

アリーナの chunk 確保自体はこの `sys` 統計から意図的に除外されている。README にその理由がある — chunk のサイズは量子化されていてプラットフォーム依存なので、数えるとスナップショットがプラットフォーム依存になってしまう。

## どう活かすか

**「まとめて作ってまとめて捨てる」データがあるなら、アリーナは検討に値する。** パーサの AST、1 リクエスト分の中間データ、1 フレーム分の描画コマンド。逆に、寿命がばらばらなオブジェクトにアリーナを使うと、最も長生きするもの 1 つのために全体が解放できなくなる。

そのうえで、oxc から持ち帰れるのは次の 3 つになる。

**制約は型で表現する。** 「アリーナに `Drop` 型を置いてはいけない」をドキュメントに書くのと、`Box::new_in` がコンパイルエラーにするのとでは、寿命が違う。ドキュメントは読まれないが、コンパイラは必ず読まれる。

**ドメインの前提はデータ表現まで下ろす。** 「ソースは 4GB 未満」という 1 つの前提が、`Span` の `u32` にも `Vec` の `len: u32` にも効いている。前提を 1 か所で決めて全体に波及させると、個別最適の積み上げより効く。

**マイクロアーキテクチャ由来の判断には、必ず理由と数字を書く。** `Arena` のフィールド順のコメントは 10 行あって「aarch64 の `ldp` 融合」「ストア転送の破綻」「3 倍」まで書いてある。この情報がないコードは、次のリファクタで確実に壊される。逆に言えば、**理由を書けない最適化は入れないほうがいい**ということでもある。

ただし、こうした最適化はいずれもプロファイルの結果として入っている。同じことを最初からやろうとするのは順序が逆で、まず[アリーナの使い回し](./allocator-reuse/)のような構造的な削減が先に来る。
