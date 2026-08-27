---
title: "毎回必ず yield する I/O バックエンドで、再開経路を全部踏ませる"
description: "再入バグは、I/O のタイミングが噛み合ったときにしか出ない。Turso はそのタイミングを運任せにせず、設計で消している。1 つは「すべての I/O を必ず 1 回 yield させる」メモリバックエンド。もう 1 つは状態機械の安全な境界に名前を付けて、そこに合成の yield や失敗を差し込む注入器。粗い網と細かい網の 2 段構えになっている。"
sidebar:
  order: 6
---

## 何を学んだか

[再入のページ](../reentrancy/) で見たバグには、共通の性質がある。**I/O が実際に待ちになったときしか出ない。**

ページがページキャッシュに載っていれば `pread` は呼ばれず、yield も起きず、状態機械は 1 回の呼び出しで最後まで走る。テストで書き込むデータが小さければ、ほぼ全部キャッシュに載る。**再開経路が 1 行も実行されないまま、テストが緑になる。**

Turso はこれを 2 つの方法で潰している。

|                     | 粒度             | 何を踏ませるか                      |
| ------------------- | ---------------- | ----------------------------------- |
| **`MemoryYieldIO`** | すべての I/O     | 「I/O のあとの再開」の経路全部      |
| **`YieldInjector`** | 名前を付けた境界 | 「特定の 2 行の間で中断」を狙い撃ち |

前者は網を粗く広く、後者は細かく狭く張る。**両方要る**のがポイントで、前者は I/O のない場所では yield できず、後者は境界に名前を付けた場所しか踏めない。

## ソースコードのどこか

### すべての I/O を、必ず 1 回 yield させる

```rust title="core/io/memory_yield.rs"
/// A memory-backed [`IO`] backend that defers every completion until the next
/// [`IO::step`] call, forcing the engine through its cooperative-yield path on
/// *every* `pread` / `pwrite` / `pwritev` / `sync` / `truncate`.
///
/// This backend performs the identical byte-level data movement as
/// `MemoryIO` (it shares [`MemStore`]) but enqueues the completion instead of
/// signalling it. The completion only becomes `finished()` when `step()` runs,
/// so the engine must return `StepResult::IO`, yield, and re-enter — exercising
/// the resume path behind each yield point.
pub struct MemoryYieldIO {
    files: Arc<Mutex<HashMap<String, Arc<MemoryYieldFile>>>>,
    /// Completions submitted but not yet signalled, drained FIFO by `step()`.
    pending: Arc<Mutex<VecDeque<Deferred>>>,
}
```

[`core/io/memory_yield.rs#L13-L26`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/memory_yield.rs#L13-L26)。

**データの移動は普通のメモリバックエンドと 1 バイトも変わらない。** 違うのは、完了を即座に通知せずキューに積むことだけだ。

```rust title="core/io/memory_yield.rs"
/// A completion awaiting `step()`, together with the byte count it should
/// report. All completion kinds (read/write/sync/truncate) report a single
/// `i32`, so this is all the state we need to defer.
struct Deferred {
    completion: Completion,
    result: i32,
}
```

[`core/io/memory_yield.rs#L28-L34`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/memory_yield.rs#L28-L34)。

**遅延に必要な状態は、たったこれだけ。** 読み書き同期切り詰めのすべてが `i32` を 1 個報告するだけなので、完了の種類ごとに分ける必要がない。[前のページ](../io-backends/) で見た「完了の形を 1 通りに揃えた」設計が、ここで配当を出している。

`step()` の実装も短い。

```rust title="core/io/memory_yield.rs"
    /// Signal every completion that was deferred since the last `step()`.
    ///
    /// We snapshot the queue and release the lock before signalling so that a
    /// completion callback is free to submit follow-up I/O (which lands in the
    /// queue for the *next* step) without deadlocking or being drained within
    /// this same call. Each deferred completion required at least one `step()`
    /// to finish, which means at least one yield occurred per submitted op.
    fn step(&self) -> Result<()> {
        let drained: VecDeque<Deferred> = {
            let mut pending = self.pending.lock();
            std::mem::take(&mut *pending)
        };
        for Deferred { completion, result } in drained {
            completion.complete(result);
        }
        Ok(())
```

[`core/io/memory_yield.rs#L104-L120`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/memory_yield.rs#L104-L120)。

**ロックを外してから通知する**理由がコメントに書いてある。完了コールバックの中から次の I/O が投げられることがあり、それは **次の** `step()` で処理されるべきだ。ロックを持ったまま通知すると、そこでデッドロックするか、同じ `step()` の中で吸い込んでしまう。

「同じ `step()` の中で吸い込む」は正しく動いてしまうので気付きにくい。だが吸い込んだ分だけ **yield が 1 回減る**。この I/O 実装の目的そのものが薄れる。

### 「本当に yield したか」をテストで確かめる

I/O 実装があるだけでは足りない。**それが実際に yield を起こしていることを、テスト自身が主張している。**

```rust title="core/io/memory_yield.rs"
    /// Driving real SQL through the engine on this backend must force at least
    /// one `StepResult::IO` (i.e. a genuine yield + re-entry), which the
    /// synchronous `MemoryIO` fast-paths away, while still producing correct
    /// results.
    #[test]
    fn engine_yields_and_round_trips() {
```

```rust title="core/io/memory_yield.rs"
        // A write transaction must flush pages, so it is guaranteed to defer at
        // least one completion and surface a StepResult::IO. The synchronous
        // MemoryIO would fast-path right past this.
        let (_, create_yields) = run("CREATE TABLE t(x)");
        assert!(
            create_yields > 0,
            "memory_yield backend must force at least one StepResult::IO on a write"
        );
```

[`core/io/memory_yield.rs#L353-L420`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/memory_yield.rs#L353-L420)。

**「結果が正しい」だけでなく「yield が 1 回以上起きた」を assert している。**

これがないと、いつか誰かが最適化を入れて「同期的に完了できるならその場で完了する」を足したときに、このバックエンドが静かに無効化される。テストは全部緑のままだ。**仕掛けが仕掛けとして機能していることを、仕掛け自身に見張らせる必要がある。**

もう 1 つのテストは、契約を直接主張している。

```rust title="core/io/memory_yield.rs"
        assert!(
            !rc.finished(),
            "pread completion must not finish before step()"
        );
```

[`core/io/memory_yield.rs#L340-L344`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/memory_yield.rs#L340-L344)。

### 細かい網: 安全な境界に名前を付ける

I/O バックエンドで踏めるのは「I/O のある場所」だけだ。だが状態機械の中には、**I/O を伴わずに状態が進む境界** がある。そこで中断されたときの挙動は、この方法ではテストできない。

そのために、境界そのものを列挙する仕組みがある。

```rust title="core/mvcc/yield_points.rs"
/// YieldPoint is a descriptor for one safe yield boundary in a state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct YieldPoint {
    pub ordinal: u8,
    pub point_count: u8,
}

/// External hook consulted at safe state machine boundaries to decide whether to synthesize a yield.
pub trait YieldInjector: Debug + Send + Sync {
    /// Returns whether to synthetically yield at the current `YieldPoint`.
    /// `selection_key` picks the deterministic yield plan for this logical operation.
    /// `instance_id` distinguishes one live state machine/cursor from another so
    /// they do not share yield bookkeeping.
    fn should_yield(&self, instance_id: u64, selection_key: u64, point: YieldPoint) -> bool;
}
```

[`core/mvcc/yield_points.rs#L5-L19`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/yield_points.rs#L5-L19)。

「安全な境界 (safe yield boundary)」という言い方が正確だ。**どこでも中断していいわけではない。** 状態機械が一貫した状態にある地点だけが対象になる。

引数が 3 つあるのも意味がある。

- `point` — どの境界か
- `selection_key` — 論理的な操作の識別。**同じ操作は同じ yield 計画を得る** (決定性)
- `instance_id` — 同時に動いている別のカーソルと帳簿を混ぜないため

呼び出し側はマクロ 1 行になる。

```rust title="core/mvcc/yield_points.rs"
macro_rules! inject_io_yield {
    ($state_machine:expr, $point:expr) => {{
        #[cfg(any(test, injected_yields))]
        {
            ...
            if let Some(result) = crate::mvcc::yield_hooks::maybe_inject_io_yield(
                yield_context.injector.as_ref(),
                yield_context.instance_id,
                yield_context.selection_key,
                $point,
            ) {
                return Ok(result);
            }
        }
    }};
}
```

[`core/mvcc/yield_points.rs#L60-L78`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/yield_points.rs#L60-L78)。

**`#[cfg(any(test, injected_yields))]` でブロック全体が消える。** 本番ビルドでは、この行はコンパイル後に何も残らない。

差し込まれる yield は、[前のページ](../io-backends/) で見たアロケーションなしの完了だ。

```rust title="core/mvcc/yield_hooks.rs"
    if should_yield {
        tracing::debug!(?point, "injecting MVCC yield");
        return Some(IOResult::IO(IOCompletions(Completion::new_yield())));
    }
```

[`core/mvcc/yield_hooks.rs#L72-L85`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/yield_hooks.rs#L72-L85)。

**「I/O はしていないが中断はする」を表現できる。** 実際の I/O を偽装する必要がない。

### 同じ仕掛けで、失敗も注入する

境界に名前を付けたら、そこで yield させる以外の使い道が出てくる。

```rust title="core/mvcc/yield_points.rs"
/// External hook consulted at safe state machine boundaries to decide whether to synthesize
/// an error return. Mirrors `YieldInjector` but produces an `Err` instead of a yield, so tests
/// can reproduce mid-state-machine failures (e.g. an I/O error after `remove_tx` ran but before
/// the connection cache was cleared) without requiring a real fault in the I/O layer.
pub trait FailureInjector: Debug + Send + Sync {
```

[`core/mvcc/yield_points.rs#L21-L34`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/mvcc/yield_points.rs#L21-L34)。

例が具体的なのがいい。**「`remove_tx` は走ったが、接続キャッシュはまだクリアされていない」という瞬間に失敗させる。** I/O 層で本物の障害を起こそうとすると、この瞬間を狙うのはほぼ不可能だ。

**「中断できる場所」の列挙は、そのまま「失敗しうる場所」の列挙になる。** 1 つの仕掛けから 2 つの障害モードが出てくる。

### 計画は seed から決まる

並行シミュレータ側の注入器は、yield 計画を乱数ではなく seed から決めている。

```rust title="testing/concurrent-simulator/yield_injection.rs"
/// Following specifies the max number of yields per instance. 20 here is arbitrary, smaller means
/// less interleaving but having large number can slow down the execution.
const MAX_YIELDS: usize = 20;
```

```rust title="testing/concurrent-simulator/yield_injection.rs"
// Selected ordinals for one in-flight instance; slots are cleared as yields are consumed.
// Ordinals may repeat so the same yield point can fire multiple times in one statement.
type InstanceYieldPlan = [Option<u8>; MAX_YIELDS];
```

[`testing/concurrent-simulator/yield_injection.rs#L6-L17`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/concurrent-simulator/yield_injection.rs)。

**同じ seed なら、同じ場所で同じ回数だけ中断する。** これがないと、見つけたバグを再現できない ([該当ページ](../deterministic-simulator/))。

「同じ yield 点が 1 つの文の中で複数回発火しうる」ようにしているのも意図的で、ループの中の境界は 1 回とは限らない。上限 20 の根拠は「任意 (arbitrary)」と正直に書いてある。

## なぜそうなっているか

- **「必ず yield する」I/O 実装を用意したのは、再開経路がテストで踏まれないから。** メモリ上のテストでは I/O がほぼ起きない。起きない以上、再入バグは検出できない。**タイミングに頼るのをやめて、常に最悪ケースにする。**
- **データの移動を通常のメモリ実装と同一にしたのは、比較可能にするため。** 挙動が変わるのが「yield するかどうか」だけなら、差が出たとき原因が 1 つに絞れる。
- **`step()` でロックを外してから通知するのは、yield を減らさないため。** 完了コールバックが次の I/O を投げたとき、それを同じ `step()` で処理してしまうと yield が 1 回消える。正しく動いてしまうぶん見つけにくい。
- **「yield が起きたこと」自体を assert するのは、仕掛けが無効化されうるから。** 「同期的に完了できるならその場で完了する」という最適化が入った瞬間に、このバックエンドは何もしなくなる。結果は正しいままなので、他のテストは全部通る。
- **境界に名前を付けたのは、I/O のない中断をテストするため。** I/O バックエンドで踏めるのは I/O のある場所だけだ。状態機械の中には、I/O なしで状態が進む地点がある。
- **本番ビルドで消えるようにしたのは、境界の数が多いから。** 状態機械の全境界に実行時チェックを置くと、そのぶん常時コストがかかる。`cfg` で消せば、開発中だけ払えばいい。
- **同じ境界で失敗も注入できるのは、「中断できる場所」と「失敗しうる場所」が同じだから。** 列挙の労力を 2 回払う必要がない。
- **計画を seed から決めるのは、再現できないバグに意味がないから。** ランダムに中断すると、落ちたときに何が起きたか分からない。

## どう活かすか

- **「たまにしか通らない経路」は、常に通る環境を用意して潰す。** キャッシュミス、リトライ、タイムアウト、部分書き込み。テストで自然に起きるのを待つと、永久に起きない。
- **その環境は、通常の実装と 1 点だけ違うようにする。** データの中身まで変えると、差が出たときに原因が絞れない。
- **仕掛けが機能していること自体を assert する。** 「常に yield する実装」を用意しても、それが本当に yield させているかは別問題だ。無効化されたとき、他のテストは全部緑のままになる。
- **中断できる地点を列挙して、名前を付ける。** 「状態機械の安全な境界」を明示的に持つと、そこに yield も失敗も注入できる。列挙のコストを 1 回払えば、複数の障害モードが試せる。
- **注入の判断は、乱数ではなく seed から導く。** 再現できない失敗は、報告にも修正にも使えない。
- **注入コードは、本番ビルドから消えるようにする。** 消せる形にしておけば、境界の数を気にせず増やせる。
- **上限やしきい値の根拠がないなら、「任意」と書く。** もっともらしい説明を作ると、後から変えづらくなる。
