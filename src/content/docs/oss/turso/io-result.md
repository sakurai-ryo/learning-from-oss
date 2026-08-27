---
title: "クエリ実行を `IOResult` で刻み、I/O 待ちのたびに呼び出し元へ帰る"
description: "Turso は Rust の async/await を使わない。I/O 待ちが起きうる関数は `IOResult<T>` を返し、待ちが必要なら `IO` を返して帰る。呼び出し元は完了させてから同じ関数を呼び直す。これは関数の色分け (function coloring) を、コンパイラではなくアプリケーション側で手作業でやるということだ。ライブラリとして配られる DB が、呼び出し元の実行モデルに縛られないための選択になっている。"
sidebar:
  order: 3
---

## 何を学んだか

### なぜ普通のブロッキングではだめなのか

SQLite はブロッキングで書かれている。ページを読む必要があれば `pread(2)` を呼んで、返ってくるまでそのスレッドは止まる。

**これはサーバ型 RDB なら何も問題ない。** 止まっているのは `mysqld` のスレッドで、他の接続は別のスレッドが処理する。

in-process DB では、止まるのは **アプリケーションのスレッド** だ。しかもそのスレッドは、非同期ランタイムのワーカーかもしれない。1 つのクエリが 10ms ブロックすると、そのワーカーに載っている全部のタスクが 10ms 止まる。

**かといって、Turso が勝手にスレッドを作って I/O を追い出すこともできない。** ライブラリがスレッドを増やせば、アプリケーションのスレッドモデルを壊す。

### Turso の答え

**「I/O 待ちが起きうる」を戻り値の型にする。**

```rust title="core/types.rs"
#[derive(Debug)]
#[must_use]
pub enum IOResult<T> {
    Done(T),
    IO(IOCompletions),
}
```

[`core/types.rs#L3462-L3467`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/types.rs#L3462-L3467)。

呼び出し規約はこうだ。

> **`IOResult` を返す関数は、`Done` が返るまで同じ関数を呼び直さなければならない。**

Rust の `Future::poll` とほぼ同じ形をしている。実際、内部ドキュメントもそう説明している。

```text title="docs/manual.md"
This implies that when a function returns an `IOResult`, it must be called again until it
returns an `IOResult::Done` variant. This works similarly to how `Future`s are polled in rust.
... This is essentially function coloring, but done at the application level instead of the
compiler level.
```

[`docs/manual.md#L1470`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/manual.md#L1470)。

**「関数の色分けを、コンパイラではなくアプリケーション側でやっている」** と自分で書いている。`async fn` を使えばコンパイラが状態機械を生成してくれるところを、全部手で書いている。

その代償は大きい。B-tree の分割も、チェックポイントも、スキーマの読み込みも、全部が明示的な `enum` の状態機械になる ([次のページ](../reentrancy/))。

得られるものは 1 つだけだ。**呼び出し元の実行モデルに、何も要求しなくて済む。**

## ソースコードのどこか

### 関数の色は、シグネチャに出る

```text title="docs/manual.md"
To know if a function does any sort of I/O we just have to look at the function signature.
If it returns `Completion`, `Vec<Completion>` or `IOResult`, then it does I/O.
```

[`docs/manual.md#L1447`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/manual.md#L1447)。

`async fn` と同じ性質だ。**I/O をする関数を呼ぶ関数は、自分も I/O をする関数になる。** 一度この型が入ると、呼び出し経路を遡って全部に伝播する。

`#[must_use]` が効いているのはここだ。伝播を忘れると、**I/O が完了していないのに完了したものとして先に進む**。読めていないページの中身を読んでしまう。コンパイラに見張らせている。

### 伝播はマクロ 1 個で書く

```rust title="core/types.rs"
/// Evaluate a Result<IOResult<T>>, if IO return IO.
#[macro_export]
macro_rules! return_if_io {
    ($expr:expr) => {
        match $expr {
            Ok(IOResult::Done(v)) => v,
            Ok(IOResult::IO(io)) => return Ok(IOResult::IO(io)),
            Err(err) => {
                branches::mark_unlikely();
                return Err(err);
            }
        }
    };
}
```

[`core/types.rs#L3492-L3506`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/types.rs#L3492-L3506)。

`?` 演算子の `IOResult` 版だ。`Done` なら中身を取り出し、`IO` ならそのまま上に投げる。

**`.await` に見た目まで似せている** のがポイントで、`let x = return_if_io!(f());` は `let x = f().await;` とほぼ同じ意味になる。

エラー経路に `branches::mark_unlikely()` を挟んでいるのが細かい。エラーは滅多に起きないので、分岐予測のヒントを出している。

もう 1 つ、状態を巻き戻す版がある。

```rust title="core/types.rs"
macro_rules! return_and_restore_if_io {
    ($field:expr, $saved_state:expr, $e:expr) => {
        match $e {
            Ok(IOResult::Done(v)) => v,
            Ok(IOResult::IO(io)) => {
                let _ = std::mem::replace($field, $saved_state);
                return Ok(IOResult::IO(io));
            }
```

[`core/types.rs#L3507-L3522`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/types.rs#L3507-L3522)。

**`IO` で帰るときに、フィールドを保存しておいた値に戻す。** なぜこれが必要なのかが、この実行モデルの本質を突いている。詳しくは [次のページ](../reentrancy/) で扱う。

そして、自分から I/O を投げるときのマクロ。

```rust title="core/util.rs"
macro_rules! io_yield_one {
    ($c:expr) => {
        return Ok(IOResult::IO(IOCompletions($c)));
    };
}
```

[`core/util.rs#L24-L28`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/util.rs#L24-L28)。

`IOCompletions` は `Completion` 1 個のニュータイプだ。

```rust title="core/types.rs"
#[derive(Debug)]
#[must_use]
pub struct IOCompletions(pub Completion);
```

[`core/types.rs#L3393-L3395`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/types.rs#L3393-L3395)。

**複数の I/O を待ちたいときも、返せるのは 1 個だけ。** 複数ある場合は、束ねて 1 個にする。

### 複数の I/O は 1 個に束ねる

```rust title="core/io/completions.rs"
pub struct CompletionGroup {
    completions: Vec<Completion>,
    callback: Box<dyn Fn(Result<i32, CompletionError>) + Send + Sync>,
}
```

```rust title="core/io/completions.rs"
    pub fn build(self) -> Completion {
        let total = self.completions.len();
        if total == 0 {
            (self.callback)(Ok(0));
            return Completion::new_yield();
        }
        let group_completion = GroupCompletion::new(self.callback, total);
        let group = Completion::new(CompletionType::Group(group_completion));
```

[`core/io/completions.rs#L126-L200`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/completions.rs#L126-L200)。

`add()` で溜めて、`build()` で 1 個の `Completion` にする。グループは入れ子にできる (グループの `Completion` を別のグループに `add` できる)。

**戻り値の型を「1 個」に固定して、「複数」は合成で表す。** こうすると `IOResult` の形が単純なままで済み、呼び出し元は常に「1 個の完了を待つ」だけを考えればよくなる。

`build()` の先頭も注意深い。**中身が空なら、コールバックを即座に呼んで「もう終わっている完了」を返す。** ここで `None` を返す設計にすると、呼び出し側全部に「待つものがない場合」の分岐が生えてしまう。

### 状態機械の共通の器

同じ形を何十回も書くので、汎用のラッパがある。

```rust title="core/state_machine.rs"
pub enum TransitionResult<Result> {
    Io(IOCompletions),
    Continue,
    Done(Result),
}

/// A generic trait for state machines.
pub trait StateTransition {
    type Context;
    type SMResult;

    fn step(&mut self, context: &Self::Context) -> Result<TransitionResult<Self::SMResult>>;
```

```rust title="core/state_machine.rs"
    pub fn step(&mut self, context: &State::Context) -> Result<IOResult<State::SMResult>> {
        loop {
            if self.is_finalized {
                unreachable!("StateMachine::transition: state machine is finalized");
            }
            match self.state.step(context)? {
                TransitionResult::Io(io) => {
                    return Ok(IOResult::IO(io));
                }
                TransitionResult::Continue => {
                    continue;
                }
                TransitionResult::Done(result) => {
                    assert!(self.state.is_finalized());
                    self.is_finalized = true;
                    return Ok(IOResult::Done(result));
                }
            }
        }
    }
```

[`core/state_machine.rs#L6-L84`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/state_machine.rs)。

`TransitionResult` に `Continue` があるのが要点だ。**「状態は進んだが、I/O は要らない」を表す。** これがないと、状態を 1 つ進めるたびに呼び出し元に帰ることになる。

`Continue` は `loop` の中で吸収されるので、**I/O が要るところまで一気に進んで、そこで初めて帰る**。

`Done` のときの `assert!(self.state.is_finalized())` も見ておきたい。「終わった」と言った状態機械が本当に後始末を済ませたかを、毎回確かめている。

### 段階的に導入するための逃げ道

全部を状態機械にするのは大工事だ。内部ドキュメントは、逃げ道を明示的に認めている。

```text title="docs/manual.md"
This allows us to be flexible in places where we do not have the state machines in place to
correctly return the Completion. Thus, we can block in certain places to avoid bigger
refactorings, which opens up the opportunity for such refactorings in separate PRs.
```

[`docs/manual.md#L1444`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/manual.md#L1444)。

**「状態機械が用意できていない場所では、ブロックしてよい」。** その手段が `io.wait_for_completion()` で、完了するまで `io.step()` を回し続ける。

```rust title="core/io/mod.rs"
    fn wait_for_completion(&self, c: Completion) -> Result<()> {
        while !c.finished() {
            self.step()?
        }
```

[`core/io/mod.rs#L466-L470`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/mod.rs#L466-L470)。

理想は「全部が状態機械」だが、そこに至る途中では「ここはまだブロックする」が混ざる。**それを暗黙の借金にせず、公式の抜け道として名前を付けている。**

## なぜそうなっているか

- **`async`/`await` を使わなかったのは、呼び出し元にランタイムを要求したくないから。** `async fn` を公開 API にすると、実行するには何らかのランタイムが要る。Turso は Python からも Java からも C からも使われる。「Tokio を動かしてください」とは言えない。
- **戻り値の型で色分けしたのは、伝播をコンパイラに検査させるため。** `#[must_use]` の付いた `IOResult` は、無視すると警告が出る。手書きの状態機械で最も怖いのは「待つのを忘れて進む」で、それが型で止まる。
- **`IOCompletions` を 1 個に固定したのは、呼び出し元の分岐を増やさないため。** 「0 個か 1 個か複数か」を呼び出し元が判定するようにすると、その判定が何百箇所にコピーされる。合成側に押し込めば、呼び出し元は常に 1 通りで済む。
- **`build()` が空グループでも完了済みの `Completion` を返すのは、同じ理由。** `Option` を返すと、全呼び出し元に `None` の分岐が生える。
- **`TransitionResult::Continue` があるのは、状態遷移と I/O 境界が一致しないから。** 1 回の I/O で 3 つの状態を通ることもあれば、同じ状態で 2 回 I/O することもある。この 2 つを分けておかないと、状態の切り方が I/O の都合に引きずられる。
- **ブロッキングの抜け道を公式に残したのは、移行を止めないため。** 「全関数を状態機械にするまでリリースしない」は現実的でない。抜け道に名前が付いていれば、後から grep して潰せる。
- **`.await` に似せたマクロ名にしたのは、読む側の負荷を下げるため。** `return_if_io!(f())` を見て `f().await` を思い浮かべられれば、既に知っている読み方が使える。

## どう活かすか

- **ライブラリで I/O を扱うなら、実行モデルを選ばない形を検討する。** 「進めるだけ進めて、まだなら帰る」という形にしておけば、ブロッキングでも `Future` でも、後から両方に載せられる。逆に `async fn` を公開した時点で、呼び出し元の選択肢を狭めている。
- **「待ちが起きうる」を型で表し、無視できないようにする。** `#[must_use]` を付けた列挙型 1 個で、「待たずに進む」バグが全部コンパイル時に落ちる。
- **複数を待つ場合は、合成して 1 個にする。** 戻り値の型に「0 個/1 個/複数」を持ち込むと、その分岐が呼び出し側に何百個も複製される。合成器を 1 個作る方が安い。
- **「空でも成功した結果を返す」を守る。** 合成器が空入力で `None` や `Option` を返すと、呼び出し側に不要な分岐が生える。
- **状態遷移と待ち境界を、別の概念として扱う。** 「次の状態へ」と「呼び出し元に帰る」を同じ戻り値で表すと、状態の切り方が I/O の都合に支配される。
- **移行の途中で残す妥協には、名前を付けて 1 箇所に集める。** 「ここはまだブロックする」を暗黙にすると、後で見つけられない。関数 1 個に集約しておけば、参照箇所を数えるだけで残作業が分かる。
- **既存の言語機能に似せた名前を選ぶ。** 自前の仕組みを作るとき、既にある概念 (`?`、`.await`) に見た目を寄せると、読む側は既知の読み方を再利用できる。
