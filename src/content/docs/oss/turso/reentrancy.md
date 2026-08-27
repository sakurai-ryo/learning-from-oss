---
title: "yield をまたぐ状態変更は再入で二重に走る"
description: "I/O 待ちで呼び出し元に帰るということは、同じ関数が最初からもう一度呼ばれるということだ。yield の前に カウンタを増やしたり Vec に push したりすると、再開のたびにそれが繰り返される。Turso のバグの主要な発生源はここで、対策として「状態に進捗を刻む」「完了ハンドルを状態に持たせる」「取り出した状態を yield 時に書き戻す」という 3 つの型が出てくる。そして再入の契約は、公開関数のドキュメントにまで漏れ出している。"
group: "実行モデル"
sidebar:
  order: 4
---

## 何を学んだか

### 何が起きるのか

`IOResult` を返す関数は、`Done` が返るまで **同じ関数がもう一度呼ばれる**。ここに罠がある。

```rust
fn bad_example(&mut self) -> Result<IOResult<()>> {
    self.counter += 1;
    return_if_io!(something_that_might_yield());
    Ok(IOResult::Done(()))
}
```

`something_that_might_yield()` が `IO` を返すと、この関数は途中で帰る。呼び出し元は I/O を完了させて、**この関数を頭から呼び直す**。`self.counter += 1` がもう一度走る。

```text title="docs/agent-guides/async-io-model.md"
| Pattern | Problem |
|---------|---------|
| `vec.push(x); return_if_io!(...)` | Vec grows on each re-entry |
| `idx += 1; return_if_io!(...)` | Index advances multiple times |
| `map.insert(k,v); return_if_io!(...)` | Duplicate inserts or overwrites |
| `flag = true; return_if_io!(...)` | Usually ok, but check logic |
```

[`docs/agent-guides/async-io-model.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/agent-guides/async-io-model.md)。

**開発者向けガイドの中で、この 1 点に一番多くの行数が割かれている。** 「Re-Entrancy: The Critical Pitfall」という見出しが立っている。

`async fn` なら、コンパイラが `.await` の位置で状態を切って、ローカル変数を状態の中に持ち越してくれる。**手で書くと、その持ち越しも手でやることになる。**

### 何が難しいのか

このバグには、悪い性質が 3 つ揃っている。

1. **正常系では絶対に出ない。** ページがキャッシュに載っていれば I/O は起きず、yield もしないので、二重実行もない
2. **タイミングでしか再現しない。** キャッシュミス、ディスクの遅さ、他スレッドの競合
3. **壊れ方が静かだ。** カウンタが 1 多い、freelist に同じページが 2 回入る。落ちるのは何万回か後になる

Turso が投資している対策は、コード側とテスト側の両方にある。このページではコード側の 3 つの型を見て、テスト側は [I/O バックエンドのページ](../memory-yield-io/) で扱う。

## ソースコードのどこか

### 型 1: 進捗を状態の名前にする

一番素直な対策は、「ここまで終わった」を状態として持つことだ。オーバーフローページの解放にその例がある。

```rust title="core/storage/btree.rs"
enum OverflowState {
    Start,
    ProcessPage {
        next_page: PageRef,
    },
    /// Transitional state used to make `OverflowState::ProcessPage`
    /// re-entry-safe across yields. Once `free_page` has returned `Done` for
    /// the current page, we move to this state before validating or reading
    /// the next page so `free_page` cannot be invoked a second time on a page
    /// that is already in the freelist.
    ReadNext {
        next: u32,
    },
    Done,
}
```

[`core/storage/btree.rs#L535-L550`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L535-L550)。

`ReadNext` は **何もしない中間状態**だ。「解放は終わった。次のページを読むところから」を表すためだけに存在する。

これがないと、次のページを読む I/O で yield した瞬間に `ProcessPage` から再開して、**既に freelist に入っているページをもう一度解放する**。フリーリストが循環する。B-tree が壊れる。

同じ形が、B-tree の破棄にもある。

```rust title="core/storage/btree.rs"
    /// Transitional state used after a spill yield from one of the descent
    /// reads inside `ProcessPage` or after `ClearOverflowPages` returned
    /// `Done`. We've committed to descending into `target` (its parent's
    /// cell_idx has already been advanced or `clear_overflow_pages` has
    /// already cleared the overflow chain for the divider cell), so on
    /// re-entry we just retry the read + push + transition to `LoadPage`
    /// without re-running those prior steps.
    PendingDescent {
        target: i64,
    },
```

[`core/storage/btree.rs#L172-L181`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L172-L181)。

**「もう `cell_idx` を進めてしまった」「もうオーバーフローチェーンを消してしまった」を記録するためだけの状態。** 名前が `PendingDescent` (降りることは決まっている) になっているのが的確だ。

こういう「何もしない状態」が、Turso の状態機械には大量にある。**状態の個数は、処理の段階の数ではなく、yield しうる地点の数で決まる。**

### 型 2: 完了ハンドルを状態に持たせる

I/O を投げた `Completion` をローカル変数に置くと、yield で帰った瞬間に消える。B-tree の分割は、複数の兄弟ページを並行に読むので、この問題に正面からぶつかる。

```rust title="core/storage/btree.rs"
    /// Disk-read completions accumulated during the sibling-load loop in
    /// `NonRootPickSiblings`. We persist them in `BalanceState` (rather than
    /// in a local `CompletionGroup`) so that when the loop yields for spill
    /// IO and is re-entered, completions from earlier iterations are not
    /// lost — they would otherwise leak: the IO is still in flight, but we
    /// would no longer have a handle to wait on them before reading page
    /// contents in `NonRootDoBalancing`. Cleared when the loop completes
    /// and transitions to `NonRootDoBalancing`.
    pending_sibling_load_completions: crate::alloc::Vec<Completion>,
```

[`core/storage/btree.rs#L318-L327`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/btree.rs#L318-L327)。

**「ハンドルを失っても I/O は飛んでいる」** という一文が重要だ。読み込みはカーネルの中で進行している。だが待つ手段がなくなるので、**まだ読めていないページの中身を読む**。

`async fn` ならローカル変数が自動で状態に持ち越されるので、この問題は存在しない。手で書いた瞬間に、「yield をまたいで生き残らせるもの」を全部自分で選ぶことになる。

### 型 3: 取り出した状態を、yield 時に書き戻す

借用検査との兼ね合いで、状態を一度フィールドから抜き出さないといけない場面がある。

```rust title="core/incremental/compiler.rs"
        loop {
            // Take ownership of the state for processing, to avoid borrow checker issues (we have
            // to call run_circuit, which takes &mut self. Because of that, cannot use
            // return_if_io. We have to use the version that restores the state before returning.
            let mut state = std::mem::replace(&mut self.commit_state, CommitState::Init);
            match &mut state {
```

[`core/incremental/compiler.rs#L552-L557`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/compiler.rs#L552-L557)。

`self.commit_state` を抜き出して `CommitState::Init` を置いていく。この状態で普通に `return_if_io!` すると、**状態機械が `Init` に戻ったまま帰る**。再入したら最初からやり直しになる。

そのための専用マクロがある。

```rust title="core/types.rs"
macro_rules! return_and_restore_if_io {
    ($field:expr, $saved_state:expr, $e:expr) => {
        match $e {
            Ok(IOResult::Done(v)) => v,
            Ok(IOResult::IO(io)) => {
                let _ = std::mem::replace($field, $saved_state);
                return Ok(IOResult::IO(io));
            }
            Err(e) => {
                let _ = std::mem::replace($field, $saved_state);
                return Err(e);
            }
        }
    };
}
```

[`core/types.rs#L3507-L3522`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/types.rs#L3507-L3522)。

使う側はこうなる。

```rust title="core/incremental/compiler.rs"
                    let delta = return_and_restore_if_io!(
                        &mut self.commit_state,
                        state,
                        self.run_circuit(execute_state, &pager, state_cursors, true,)
                    );
```

[`core/incremental/compiler.rs#L589-L593`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/compiler.rs#L589-L593)。

**エラー経路でも書き戻している**のがポイントだ。エラーで抜けた後に呼び出し元がロールバックを走らせるとき、状態機械が `Init` に戻っていると後始末の対象が消えている。

### 契約は、公開関数のドキュメントにまで漏れる

再入は内部の実装詳細で終わらない。行ごとのコールバックを受け取る関数の説明を見てほしい。

```rust title="core/statement.rs"
    /// Re-entrancy: on an IO yield the program is paused mid-opcode (never
    /// between emitting a row and this loop observing it), so on re-invocation
    /// stepping resumes without replaying the last row — every row's `func`
    /// runs exactly once. Because the runner restarts from the top on each
    /// re-entry, `func` must append to caller-owned state that persists across
    /// yields (e.g. a field in the driving state machine), not to a local.
    pub fn run_with_row_callback_nonblock(
        &mut self,
        mut func: impl FnMut(&Row) -> Result<()>,
    ) -> Result<crate::IOResult<()>> {
```

[`core/statement.rs#L831-L841`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/statement.rs#L831-L841)。

2 つのことを言っている。

1. **保証: 同じ行に対して `func` が 2 回呼ばれることはない。** VDBE は行を出した直後ではなく命令の途中で止まるので、再開しても行が重複しない
2. **要求: `func` はローカルではなく、yield をまたいで生き残る場所に書け**

**保証と要求が対になっている。** これがないと、呼ぶ側はコールバックの中で何をしていいのか分からない。

同じことがトランザクションの入れ子カウンタにも出ている。

```rust title="core/incremental/view.rs"
        // Mark as nested for the duration of this call to prevent inner queries from
        // committing the outer transaction's dirty pages. We increment on every entry
        // and decrement on every exit (including IO yields and errors) so re-entrant
        // calls keep the counter balanced.
        conn.start_nested();
        let result = self.populate_from_table_inner(conn, pager, _btree_cursor);
        conn.end_nested();
        result
```

[`core/incremental/view.rs#L1158-L1165`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/incremental/view.rs#L1158-L1165)。

**「入るたびに増やして、出るたびに減らす」を徹底することで、再入回数に依存しなくなる。** yield で帰るのも「出る」に数える。`?` を使わず `result` を受け取ってから `end_nested()` を呼んでいるのは、エラーも「出る」だからだ。

再入対策には、大きく 2 つのやり方がある。

- **一度しか実行しない** (型 1〜3。状態に進捗を刻む)
- **何度実行しても同じ** (このカウンタ。入退場を対にする)

後者が使えるなら、その方が安い。**状態を増やさずに済む。**

## なぜそうなっているか

- **再入がバグの主要因なのは、「関数の途中で帰る」を手で書いているから。** `async fn` ならローカル変数の持ち越しはコンパイラの仕事だ。それを手でやると決めた以上、持ち越しの漏れは必ず出る。
- **「何もしない中間状態」が大量にあるのは、状態の粒度が yield 地点で決まるから。** 処理の段階としては 1 つでも、その途中で待ちが発生しうるなら、そこで状態を切らなければならない。
- **完了ハンドルを状態に置くのは、I/O がハンドルより長生きするから。** ハンドルを落としても I/O は止まらない。「待てなくなる」だけで、しかもそれは「待たずに読む」として現れる。
- **書き戻しマクロがあるのは、借用検査を通すために状態を抜く必要があるから。** Rust 特有の事情だが、「一時的に不正な状態にして、抜ける前に戻す」というパターン自体は言語を選ばない。
- **エラー経路でも書き戻すのは、後始末が状態を必要とするから。** エラーは終わりではなく、ロールバックの始まりだ。
- **契約を公開ドキュメントに書いているのは、呼び出し側にも影響するから。** 「この関数は何度も呼ばれる」は実装詳細ではなく、インタフェースの一部になっている。
- **カウンタ方式を使えるところでは使っているのは、状態を増やさずに済むから。** 「一度しか実行しない」を保証するより、「何度実行しても同じ」に持ち込む方が、状態機械が小さくなる。

## どう活かすか

- **「途中で帰って、また呼ばれる」形の関数では、副作用の位置を待ち境界の後ろに寄せる。** 待つ前に何もしなければ、二重実行は起きない。これで済むなら状態を増やさなくていい。
- **寄せられない副作用は、状態の名前にする。** 「もう X をした」を表す状態を作る。何もしない中間状態が増えるのは正しい。処理の段階と状態の数が一致しないことを、設計の失敗と思わない。
- **その状態が何のためにあるかを、必ずコメントに書く。** 「何もしないなら消せる」と後の人が思う。Turso の中間状態には例外なく「これがないと 2 回実行される」と書いてある。**消したら壊れる理由が、コードからは読み取れない。**
- **非同期処理のハンドルを、待ち境界をまたいで捨てない。** ハンドルを捨てても処理は止まらない。「完了を確かめずに結果を使う」という形で表面化する。
- **「一度だけ」より「何度でも同じ」に寄せられないか先に考える。** 入退場を対にする、集合に入れる (べき等)、上書きにする。これで済めば、進捗を持つ必要がなくなる。
- **再入する関数がコールバックを受け取るなら、保証と要求を対にして書く。** 「同じ要素に対して 2 回呼ばない」(保証) と「呼び出しをまたいで生き残る場所に書け」(要求) の両方がないと、呼ぶ側が判断できない。
- **後始末の経路でも状態を戻す。** エラーは処理の終わりではない。その後にロールバックが走るなら、そこでも状態が要る。
