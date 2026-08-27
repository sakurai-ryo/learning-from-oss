---
title: "本番用の型と検査用の型を差し替えて、並行コードの全インターリーブを機械に試させる"
description: "Tokio のソースには std::sync がほぼ出てこない。すべて crate::loom::sync 経由で、cfg(loom) のときだけ検査ツールの実装に切り替わる。テストの本体は書き換えず、型だけを差し替えて全実行順序を試す。この差し替えを成立させるために、UnsafeCell へのアクセスまでクロージャ渡しの API に統一されていて、それが本番ビルドではゼロコストになる。"
sidebar:
  order: 20
---

## 何を学んだか

### どんな状況の話か

ここまでのページで見てきたコードは、ほぼ全部が **ロックフリーか、それに近い** ものだった。

- 1 語のアトミックに詰め込んだ [タスクの状態](../task-state/)
- 2 つのインデックスをパックした [実行キュー](../local-run-queue/)
- `SeqCst` に依存する [ワーカーの起床判断](../idle-searching/)
- 世代番号で古い操作を弾く [readiness キャッシュ](../scheduled-io/)

これらの正しさは、**「どの順序で実行されても壊れない」** ことに依存している。そして、この種のコードのテストは絶望的に難しい。

- **バグは特定のインターリーブでしか出ない。** 2 つのスレッドが「ちょうどこの命令の間」で切り替わったときだけ、といった条件になる。
- **1000 万回ループさせても踏まない。** OS のスケジューラは、そういう珍しい順序を選ばない。
- **踏んでも再現しない。** 「CI で 1 か月に 1 回落ちる」という形になる。
- **メモリ順序のバグは、x86 では出ない。** x86 は強い順序を持つので、`Relaxed` と書いても実質 `Acquire` 相当に動く。ARM で初めて壊れる。

### Tokio の答え

**[loom](https://github.com/tokio-rs/loom) を使う。** これは Tokio と同じ組織が作っている並行性のモデル検査ツールで、C11 のメモリモデルに基づいて **可能な実行順序を全部試す**。

使い方の要は、**本番用の型と検査用の型を差し替えること** だ。

```rust title="tokio/src/loom/mod.rs"
//! This module abstracts over `loom` and `std::sync` depending on whether we
//! are running tests or not.

#![allow(unused)]

#[cfg(not(all(test, loom)))]
mod std;
#[cfg(not(all(test, loom)))]
pub(crate) use self::std::*;

#[cfg(all(test, loom))]
mod mocked;
#[cfg(all(test, loom))]
pub(crate) use self::mocked::*;
```

**14 行。** これが Tokio 全体の並行性検査の入口になっている。

`--cfg loom` を付けてビルドすると、`AtomicUsize` も `Mutex` も `UnsafeCell` も `thread::spawn` も、全部 loom の実装に置き換わる。**テストのコードも、テスト対象のコードも、1 行も変えない。**

## ソースコードのどこか

### 差し替えられる側

`crate::loom::std` は、標準ライブラリの薄いラッパになっている ([`loom/std/unsafe_cell.rs`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/loom/std/unsafe_cell.rs))。

```rust title="tokio/src/loom/std/unsafe_cell.rs"
#[derive(Debug)]
pub(crate) struct UnsafeCell<T>(std::cell::UnsafeCell<T>);

impl<T> UnsafeCell<T> {
    pub(crate) const fn new(data: T) -> UnsafeCell<T> {
        UnsafeCell(std::cell::UnsafeCell::new(data))
    }

    #[inline(always)]
    pub(crate) fn with<R>(&self, f: impl FnOnce(*const T) -> R) -> R {
        f(self.0.get())
    }

    #[inline(always)]
    pub(crate) fn with_mut<R>(&self, f: impl FnOnce(*mut T) -> R) -> R {
        f(self.0.get())
    }
}
```

**18 行のうち、実質的な処理は `f(self.0.get())` の 2 行だけ。** `#[inline(always)]` なので、本番ビルドでは完全に消える。

注目すべきは **API の形** だ。標準の `UnsafeCell::get()` は生ポインタを返すが、こちらは **クロージャを受け取る**。

なぜかというと、**loom 側の実装が「アクセスの範囲」を知る必要がある** からだ。loom は「このスレッドが今このセルを可変で触っている」を追跡して、他のスレッドが同時に触ったらデータ競合として報告する。ポインタを返してしまうと、いつアクセスが終わったのか分からない。

**検査ツールの都合が、本番のコードの書き方を決めている。** これは制約だが、代償は `#[inline(always)]` のクロージャ 1 個で、実行時コストはゼロだ。

そしてこの API の形が、ここまでのページで何度も出てきた。

```rust title="tokio/src/runtime/task/core.rs"
        self.stage.stage.with_mut(|ptr| {
            match mem::replace(unsafe { &mut *ptr }, Stage::Consumed) {
```

```rust title="tokio/src/sync/mpsc/block.rs"
        self.values[slot_offset].with_mut(|ptr| {
            unsafe {
                ptr::write(ptr, MaybeUninit::new(value));
            }
        });
```

**`with_mut(|ptr| ...)` という見慣れない形は、全部これが理由だった。**

### 「触るつもりだ」とだけ宣言する

いちばん面白い使い方がこれだ ([`runtime/task/harness.rs#L253-L258`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/runtime/task/harness.rs#L253-L258))。

```rust title="tokio/src/runtime/task/harness.rs"
    pub(super) fn dealloc(self) {
        // Observe that we expect to have mutable access to these objects
        // because we are going to drop them. This only matters when running
        // under loom.
        self.trailer().waker.with_mut(|_| ());
        self.core().stage.with_mut(|_| ());
```

**クロージャの中身が空。** ポインタを受け取って、何もせずに捨てる。

意味は「**これから解放するので、今この瞬間に排他アクセスがあるはずだ**」という宣言だ。実際に触るのはこの後の `Box::from_raw` で、そこは loom には見えない。

**loom に検査してほしい事実を、コードとして書いている。** もし他のスレッドがまだこのセルを触っていたら、この行で検査が失敗する。本番ビルドでは `f(ptr)` が空クロージャなので、跡形もなく消える。

「解放の直前に、誰も触っていないことを確かめる」を、実行時コスト 0 で表現している。

### 検査用の実装は、ほとんど型の付け替え

[`loom/mocked.rs`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/tokio/src/loom/mocked.rs)。

```rust title="tokio/src/loom/mocked.rs"
pub(crate) use loom::*;

pub(crate) mod sync {

    pub(crate) use loom::sync::{MutexGuard, RwLockReadGuard, RwLockWriteGuard};

    #[derive(Debug)]
    pub(crate) struct Mutex<T>(loom::sync::Mutex<T>);

    #[allow(dead_code)]
    impl<T> Mutex<T> {
        #[inline]
        #[track_caller]
        pub(crate) fn lock(&self) -> MutexGuard<'_, T> {
            self.0.lock().unwrap()
        }
```

**`Mutex::lock()` が `Result` を返さない形に揃えられている。** Tokio 内部では毒 (poisoning) を使わないので、`unwrap()` して型を合わせる。

環境の値も差し替わる。

```rust title="tokio/src/loom/mocked.rs"
pub(crate) mod rand {
    pub(crate) fn seed() -> u64 {
        1
    }
}

pub(crate) mod sys {
    pub(crate) fn num_cpus() -> usize {
        2
    }
}
```

**乱数の種を固定し、CPU 数を 2 にする。** 検査は決定的でなければならないので、乱数は潰す。CPU 数を 2 にするのは、**スレッドが増えるほど組み合わせが爆発する** からだ。

### 検査可能な規模まで定数を落とす

これが繰り返し出てきたパターンだ。

```rust title="tokio/src/runtime/scheduler/multi_thread/queue.rs"
// Shrink the size of the local queue when using loom. This shouldn't impact
// logic, but allows loom to test more edge cases in a reasonable a mount of
// time.
#[cfg(loom)]
const LOCAL_QUEUE_CAPACITY: usize = 4;
```

```rust title="tokio/src/sync/mpsc/mod.rs"
pub(crate) const BLOCK_CAP: usize = 2;
```

```rust title="tokio/src/sync/rwlock.rs"
const MAX_READS: u32 = 10;
```

[実行キュー](../local-run-queue/) は 256 → 4、[mpsc のブロック](../mpsc-block-list/) は 32 → 2、[RwLock](../batch-semaphore/) の読み手上限は 20 億 → 10。

**「ロジックは変えず、境界に当たりやすくする」。** 容量 256 のキューを満杯にする全順序を試すのは不可能だが、容量 4 なら「満杯になる」「溢れる」「一周する」が数手で起きる。

境界のバグは、たいてい容量に依存しない。**小さくして踏ませたバグは、大きいときも同じバグだ。**

### 全部を一度には検査できない

`loom` は組み合わせ爆発と隣り合わせなので、実行の設定と分割が要る ([`.github/workflows/loom.yml`](https://github.com/tokio-rs/tokio/blob/ea91b33ca57ff0581b38e735cc108f831bccbdaa/.github/workflows/loom.yml))。

```yaml title=".github/workflows/loom.yml"
env:
  RUSTFLAGS: -Dwarnings --cfg loom --cfg tokio_unstable -C debug_assertions
  LOOM_MAX_PREEMPTIONS: 2
  LOOM_MAX_BRANCHES: 10000
```

**`LOOM_MAX_PREEMPTIONS: 2`。** 「プリエンプション (スレッドの切り替え) を最大 2 回まで」に制限して探索する。

これは完全性を諦める設定だが、根拠がある。**並行性のバグの大半は、2 回以下の切り替えで再現する。** 3 回以上の切り替えが必要なバグは、そもそも実機でもまず踏まない。実用的な打ち切りだ。

`LOOM_MAX_BRANCHES: 10000` も同じで、探索木の分岐数に上限を置いている。

そして **テストがグループに分割されている**。

```yaml title=".github/workflows/loom.yml"
include:
  - scope: loom_multi_thread::group_a
  - scope: loom_multi_thread::group_b
  - scope: loom_multi_thread::group_c
  - scope: loom_multi_thread::group_d
```

```rust title="tokio/src/runtime/tests/loom_multi_thread.rs"
/// Tests are divided into groups to make the runs faster on CI.
mod group_a {
```

**CI のジョブを並列化するためだけに、テストがモジュールで分けられている。** 検査の実行時間が、コードの構造に影響している。

### 実行の条件も制御されている

```yaml title=".github/workflows/loom.yml"
loom-blocking:
  name: loom tokio::runtime::spawn_blocking
  # base_ref is null when it's not a pull request
  if: github.repository_owner == 'tokio-rs' && (contains(github.event.pull_request.labels.*.name, 'R-loom-blocking') || (github.base_ref == null))
```

**PR ではラベルが付いたときだけ走り、master へのプッシュでは必ず走る。** loom の検査は数十分かかるので、全 PR で回すと現実的でない。

「並行性に触る変更だ」と判断した人が `R-loom-blocking` ラベルを付ける。**人間の判断を、CI の起動条件として組み込んでいる。**

[ブロッキングプール](../blocking-pool/) の 2 実装 (単一ロック版とシャード版) を、環境変数で切り替えて両方検査しているのも徹底している。

```yaml title=".github/workflows/loom.yml"
# Run the blocking pool loom tests against both `spawn_blocking`
# queue implementations.
include:
  - sharded_blocking_queue: "0"
  - sharded_blocking_queue: "1"
```

### 検査対象のテストは、普通のテストに見える

`loom::model` で囲むだけだ。

```rust title="tokio/src/runtime/tests/loom_multi_thread.rs"
    #[test]
    fn racy_shutdown() {
        loom::model(|| {
            let pool = mk_pool(1);

            // here's the case we want to exercise:
            //
            // a worker that still has tasks in its local queue gets sent to the blocking pool (due to
```

**`loom::model(|| { ... })` の中身は、普通の Rust コードで書いた「起きてほしくない状況」の再現。** loom がそのクロージャを何千回も、違う実行順序で走らせる。

テスト名とコメントが「どういう競合を狙っているか」を説明していて、**テストが並行性の仕様書にもなっている**。

なお `--cfg loom` でのコンパイル自体は、通常の CI でも毎回検査されている。

```yaml title=".github/workflows/ci.yml"
- name: build --cfg loom
```

**「loom ビルドが壊れていないこと」は全 PR で確認する。** 検査そのものは重くても、ビルドは軽い。壊れたまま放置されると、いざ検査したいときに動かない。

## なぜそうなっているか

- **ロックフリーなコードの正しさは、テストでは示せないから。** バグが特定のインターリーブでしか出ず、実機ではその順序が選ばれない。「1 億回動かした」は証拠にならない。
- **型を差し替える方式にしたのは、テストとコードを書き換えたくないから。** 検査用に別実装を書くと、検査したものと本番で動くものが違うことになる。`cfg` で型だけ入れ替えれば、検査対象は本番のコードそのものだ。
- **`UnsafeCell` をクロージャ渡しの API にしたのは、loom がアクセスの範囲を知る必要があるから。** ポインタを返すと、どこまでがアクセス中か追跡できない。本番では `#[inline(always)]` で消えるので、コストは 0。
- **空のクロージャで `with_mut` を呼ぶのは、「この時点で排他が取れているはず」を検査させるため。** 実際のアクセスが loom の見えないところ (生ポインタ経由の解放) で起きるとき、その直前に宣言を置く。
- **loom の下で定数を小さくするのは、境界を数手で踏ませるため。** 容量 256 のキューが一周する全順序は試せない。4 にすれば試せて、しかもバグの性質は変わらない。
- **プリエンプション回数に上限を置くのは、探索が爆発するから。** 完全性は諦めているが、実際のバグの大半は 2 回以下の切り替えで再現する。無限に正しい検査より、有限時間で終わる検査のほうが役に立つ。
- **PR ではラベル付きのときだけ走らせるのは、時間がかかるから。** 全 PR で数十分の検査を回すのは非現実的だ。代わりに master へのマージ時には必ず走る。
- **loom ビルドのコンパイルだけは全 PR で検査するのは、腐るのを防ぐため。** 検査を回さない期間が続くと、`cfg(loom)` 側のコードが壊れたまま放置される。

## どう活かすか

- **並行性の正しさを、テストの実行回数で示そうとしない。** ロックフリーなコードのバグは、実機のスケジューラが選ばない順序で出る。回数を増やしても、探索している空間はほとんど広がらない。
- **同期プリミティブを直接使わず、1 段のラッパを通す。** ラッパがあれば、検査ツール用の実装に丸ごと差し替えられる。ラッパの中身が `#[inline(always)]` なら、本番のコストは 0 だ。この 1 段があるかどうかが、後から検査を導入できるかを決める。
- **検査ツールの都合で API を選ぶ価値はある。** クロージャ渡しは生ポインタを返すより書きにくいが、「アクセスの範囲」が構文に現れる。実行時コストがないなら、書きにくさは払う価値がある。
- **「この時点で排他が取れているはず」を、コードとして書く。** 検査ツールに見えない操作 (生ポインタ経由、FFI 越し) の直前に、空のアクセス宣言を置く。コメントに書くだけでは検査されない。
- **検査モードでは、境界に当たりやすい定数に落とす。** バッファサイズ、上限値、スレッド数。ロジックを変えずに定数だけ小さくすれば、同じコードで境界条件を踏める。
- **完全な検査を諦めて、有限時間で終わる設定を選ぶ。** 探索の深さに上限を置き、根拠 (「実際のバグは 2 回以下の切り替えで出る」) を明示する。終わらない検査は誰も回さない。
- **重い検査は、起動条件を明示的に制御する。** ラベル、マージ時のみ、夜間。そして「ビルドが通ること」だけは毎回検査して、腐らせない。
