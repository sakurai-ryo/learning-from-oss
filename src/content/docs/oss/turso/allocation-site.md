---
title: "メモリ確保の場所に名前を付けて回り、そこに OOM を注入する"
description: "in-process DB では、メモリ確保の失敗がアプリごとプロセスを落とす。Turso は std のコレクションを直接使わず、確保が失敗を返せる自前の名前空間を通す。そのうえで確保箇所に enum で名前を付け、シミュレータが (seed, ステップ, ファイバ, 場所, 何回目, サイズ) のハッシュから決定的に失敗させる。「どこで失敗させるか」を指定できるようにするための名前付けが、そのまま確保箇所の一覧にもなっている。"
group: "ストレージ層"
sidebar:
  order: 10
---

## 何を学んだか

MySQL でメモリ確保が失敗したら、`mysqld` が落ちる。アプリケーションは接続エラーを受け取り、リトライできる。

Turso でメモリ確保が失敗したら、**アプリケーションが落ちる**。しかも Rust の標準コレクションは、確保に失敗すると `Result` を返さず **abort する**。

だから 2 つのことをしている。

1. **確保が失敗を返せるようにする** — `std` を直接使わず、自前の名前空間を通す
2. **失敗を意図的に起こしてテストする** — 確保箇所に名前を付け、そこを狙って失敗させる

2 番目のために 1 番目が要り、1 番目だけでは 2 番目は確かめられない。

## ソースコードのどこか

### 自前の確保用名前空間

```rust title="core/alloc/mod.rs"
//! Turso-owned allocation namespace.
//!
//! Stable builds use `std` collections where allocator parameters are not
//! available. Builds compiled with `--cfg nightly` use Rust's unstable
//! `allocator_api` collection parameters.
```

```rust title="core/alloc/mod.rs"
pub const ALLOC_ERR_MSG: &str = "fallible allocations";
```

[`core/alloc/mod.rs#L1-L36`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/alloc/mod.rs#L1-L36)。

`core/alloc/collections/` の下に、`vec`、`hash_map`、`hash_set`、`btree_map`、`vec_deque`、`binary_heap`、`boxed`、`rc`、`arc` が並んでいる。**標準ライブラリのコレクションを全部ラップしている。**

安定版ツールチェインではアロケータを差し替えられないので `std` に委譲し、`--cfg nightly` なら `allocator_api` を使う。**同じソースが両方のビルドで通る**ようになっている。

エンジン中の `try_reserve` / `try_with_capacity` / `try_push` の類は 270 箇所にのぼる。**「確保は失敗しうる」を、コードの書き方として全体に通している。**

### 確保箇所に名前を付ける

```rust title="core/alloc/allocation_site.rs"
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum AllocationSite {
    BTree(BTreeAllocationSite),
    MvStore(MvStoreAllocationSite),
    MvccCheckpoint(MvccCheckpointAllocationSite),
    Schema(SchemaAllocationSite),
    ValueBlob(ValueBlobAllocationSite),
    Vector(VectorAllocationSite),
    NoFaultInjection,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum BTreeAllocationSite {
    CellPayload,
    OverflowRead,
    Balance,
    BlobRecordHeader,
    IntegrityCheck,
    OverflowCell,
    RecordPayload,
    SavedCursorRecord,
}
```

[`core/alloc/allocation_site.rs#L3-L24`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/alloc/allocation_site.rs#L3-L24)。

サブシステムごとに列挙が分かれている。B-tree に 8 種、MVCC ストアに 9 種、チェックポイントに 4 種、ベクトルに 8 種。

**この列挙は、そのまま「メモリを確保する場所の一覧」になっている。** 「どこでメモリを使っているか」を知りたいとき、この 1 ファイルを読めばいい。

`NoFaultInjection` が同じ列挙にいるのが要点で、これは後で見る。

### 現在の確保箇所は、スレッドローカルの 1 個

```rust title="core/alloc/allocation_site.rs"
thread_local! {
    static CURRENT_ALLOCATION_SITE: Cell<Option<AllocationSite>> = const { Cell::new(None) };
}

pub struct AllocationSiteGuard {
    previous: Option<AllocationSite>,
}

impl Drop for AllocationSiteGuard {
    fn drop(&mut self) {
        CURRENT_ALLOCATION_SITE.with(|slot| slot.set(self.previous));
    }
}
```

[`core/alloc/allocation_site.rs#L114-L126`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/alloc/allocation_site.rs#L114-L126)。

**確保する関数に引数を足すのではなく、スレッドローカルに置く。** アロケータは呼び出しスタックの一番下にいるので、引数で渡そうとすると全部の関数のシグネチャが変わる。

RAII で前の値を復元する形なので、入れ子にできる。

入る側にひとひねりある。

```rust title="core/alloc/allocation_site.rs"
pub fn enter_allocation_site(site: impl Into<AllocationSite>) -> AllocationSiteGuard {
    let site = site.into();
    let previous = CURRENT_ALLOCATION_SITE.with(|slot| {
        let previous = slot.get();
        let site = if matches!(previous, Some(AllocationSite::NoFaultInjection)) {
            AllocationSite::NoFaultInjection
        } else {
            site
        };
        slot.set(Some(site));
        previous
    });
    AllocationSiteGuard { previous }
}
```

[`core/alloc/allocation_site.rs#L128-L141`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/alloc/allocation_site.rs#L128-L141)。

**`NoFaultInjection` は内側に伝播する。** 「ここから先は絶対に失敗させるな」と宣言した領域の中では、どんなに深く潜っても失敗が注入されない。

```rust title="core/alloc/allocation_site.rs"
macro_rules! without_allocation_faults {
    ($expr:expr) => {{
        #[cfg(feature = "allocation_metric")]
        let _turso_allocation_site_guard =
            $crate::alloc::enter_allocation_site($crate::alloc::AllocationSite::NoFaultInjection);
        $expr
    }};
}
```

[`core/alloc/allocation_site.rs#L147-L155`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/alloc/allocation_site.rs#L147-L155)。

**エラー処理そのものがメモリを確保することがある。** エラーメッセージの組み立て、ロールバック用のバッファ。そこで失敗させると、テストしたいものではなく後始末が壊れる。

そして全部のマクロが `#[cfg(feature = "allocation_metric")]` で囲まれている。**機能が無効なら、ガードの生成ごと消える。** 本番では 1 命令も残らない。

### 差し替えは 1 回だけ

```rust title="core/alloc/backend.rs"
/// # Safety
///
/// This function must be called before any database operation, or any other
/// operation that can allocate through [`TursoAllocator`]. The allocator is
/// process-wide and can only be set once. Allocating with one backend and
/// deallocating with another can violate allocator invariants. In practice,
/// some backend pairs may both delegate to the system allocator and happen to
/// work, but callers must not rely on that.
pub unsafe fn set_allocator(
    backend: &'static dyn TursoAllocBackend,
) -> Result<(), SetAllocatorError> {
    BACKEND
        .set(backend)
        .map_err(|_| SetAllocatorError::AlreadyInitialized)
}
```

[`core/alloc/backend.rs#L53-L69`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/alloc/backend.rs#L53-L69)。

**危険の中身が具体的に書かれている。** 「あるバックエンドで確保して別のバックエンドで解放すると不変条件が壊れる」。しかも **「実際には両方ともシステムアロケータに委譲していて偶然動くこともあるが、それに依存するな」** まで書いてある。

`unsafe fn` に付ける安全性の説明として、これは理想形に近い。禁止事項と、その禁止事項を破っても動いてしまう可能性の両方が書いてある。

### 失敗させる場所は、ハッシュで決まる

シミュレータ側の実装を見る。

```rust title="testing/concurrent-simulator/allocation_fault.rs"
    fn should_fail(&self, layout: Layout) -> bool {
        if !self.enabled.load(Ordering::Acquire) {
            return false;
        }

        let Some(site) = turso_core::alloc::current_allocation_site() else {
            return false;
        };
        if matches!(site, AllocationSite::NoFaultInjection) {
            return false;
        }
        let Some(context) = CURRENT_CONTEXT.with(Cell::get) else {
            return false;
        };

        let occurrence = ALLOCATION_OCCURRENCE.with(|slot| {
            let occurrence = slot.get();
            slot.set(occurrence.wrapping_add(1));
            occurrence
        });
        let hash = allocation_hash(
            self.seed.load(Ordering::Relaxed),
            context,
            site,
            occurrence,
            layout,
        );
        if hash <= self.threshold.load(Ordering::Relaxed) {
```

[`testing/concurrent-simulator/allocation_fault.rs#L122-L153`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/allocation_fault.rs)。

**「名前が付いていない確保は、失敗させない」。** `current_allocation_site()` が `None` なら素通しする。網を広げすぎず、名前を付けた場所だけを狙う。

判定に使う材料はこれだけある。

```rust title="testing/concurrent-simulator/allocation_fault.rs"
fn allocation_hash(
    seed: u64,
    context: AllocationFaultContext,
    site: AllocationSite,
    occurrence: u64,
    layout: Layout,
) -> u64 {
    splitmix64(
        seed ^ context.step.rotate_left(7)
            ^ context.fiber_idx.rotate_left(17)
            ^ context.execution_id.rotate_left(29)
            ^ allocation_site_id(site).rotate_left(41)
            ^ occurrence.rotate_left(53)
            ^ (layout.size() as u64)
            ^ (layout.align() as u64).rotate_left(11),
    )
}
```

[`testing/concurrent-simulator/allocation_fault.rs#L184-L199`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/allocation_fault.rs)。

**乱数を使っていない。** seed、シミュレーションのステップ番号、ファイバ番号、確保箇所、そのコンテキストで何回目か、確保サイズと整列。全部が入力で、出力は決定的だ。

だから **同じ seed で走らせれば、同じ確保が同じタイミングで失敗する** ([該当ページ](../deterministic-simulator/))。

`occurrence` が入っているのが効いている。同じ場所からの 1 回目と 2 回目を区別できるので、**「3 回目の確保だけ失敗させる」が表現できる**。ループの途中で失敗する経路は、これがないと踏めない。

`layout` まで混ぜているので、確保サイズが変わればハッシュも変わる。**コードを変更すると失敗する場所も変わる**が、これは決定的シミュレーションでは織り込み済みの性質だ。

失敗確率は閾値との比較だけで表す。

```rust title="testing/concurrent-simulator/allocation_fault.rs"
fn probability_threshold(probability: f64) -> u64 {
    if probability <= 0.0 {
        return 0;
    }
    if probability >= 1.0 {
        return u64::MAX;
    }
    (probability * u64::MAX as f64) as u64
}
```

[`testing/concurrent-simulator/allocation_fault.rs#L172-L182`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/allocation_fault.rs)。

**確率を「u64 の値域の何割か」に変換しておくと、判定が 1 回の比較で済む。** 浮動小数点の演算がホットパスから消える。

## なぜそうなっているか

- **確保の失敗を扱えるようにしたのは、落ちるのがアプリケーションだから。** サーバなら再起動すればいい。ライブラリが `abort()` すると、ホストアプリごと死ぬ。
- **`std` のコレクションを丸ごとラップしたのは、`Vec::push` が失敗を返さないから。** 一部だけ差し替えると、残りの経路から abort する。全部通す以外に方法がない。
- **確保箇所をスレッドローカルに置いたのは、引数で運べないから。** アロケータは呼び出しスタックの底にいる。そこまで情報を運ぶには、全関数のシグネチャを変えることになる。
- **`NoFaultInjection` を内側に伝播させたのは、後始末を壊さないため。** エラー処理の中でメモリを確保することは多い。そこで失敗すると、テストしたい対象ではなくエラー処理が壊れる。
- **注入コードを機能フラグで消せるようにしたのは、確保が最も頻度の高い操作だから。** ここに常時のコストを乗せると、名前を付けるのが割に合わなくなる。
- **名前のない確保を素通しにしたのは、網を絞るため。** 全確保を対象にすると、失敗の大半が「テストしたい経路ではない場所」で起きる。
- **判定を決定的なハッシュにしたのは、再現できないと直せないから。** 「1000 回に 1 回失敗する」で見つけたバグは、同じ条件を作れなければ修正を確認できない。
- **`occurrence` を混ぜたのは、同じ場所の N 回目を狙うため。** ループの途中で失敗する経路は、1 回目だけを失敗させても踏めない。
- **確率を u64 の閾値に変換したのは、判定を軽くするため。** 全確保で通る経路なので、比較 1 回に収める価値がある。

## どう活かすか

- **ライブラリでは、確保の失敗が abort にならない経路を用意する。** ホストアプリごと落とす権利は、ライブラリにはない。
- **障害を注入したい場所には、名前を付ける。** 「どこで失敗させるか」を指定できないと、テストは「どこかで失敗する」しか書けない。列挙型 1 個で、指定と一覧の両方が手に入る。
- **その文脈情報は、引数ではなくスレッドローカルの RAII で運ぶ。** 深い呼び出しスタックの底まで情報を運ぶのに、シグネチャを変えて回るのは割に合わない。
- **「ここでは絶対に失敗させない」領域を作り、内側に伝播させる。** 後始末やエラー処理の中の確保まで失敗させると、テストの対象がすり替わる。
- **注入のコードは、機能フラグで完全に消せるようにする。** 頻度の高い経路に常時コストを乗せると、注入点を増やせなくなる。
- **注入の判断は、乱数ではなく入力のハッシュにする。** seed、進行度、場所、何回目、サイズ。全部を混ぜれば決定的で、しかも十分に散らばる。
- **「同じ場所の何回目か」を判断材料に入れる。** ループの中の失敗は、これがないと表現できない。
- **確率は、判定しやすい表現に前もって変換しておく。** 浮動小数点の比較をホットパスから外せる。
- **`unsafe` な差し替え API には、破ったときに何が起きるかを書く。** 「偶然動くこともあるが依存するな」まで書いてあると、読む側が正しく怖がれる。
