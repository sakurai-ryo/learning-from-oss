---
title: "MySQL の語彙で読む Turso のアーキテクチャ"
description: "Turso には接続を待ち受けるサーバプロセスがない。接続はただの構造体で、クエリを進めるのは呼び出し元のスレッドだ。それでも「接続」「トランザクション」「カーソル」「バッファプール」「redo ログ」という語彙はほぼそのまま通じる。この章の他のページが使う語彙 (Database、Connection、Pager、WAL、VDBE、IOResult、StepResult) を、MySQL との対応で先に導入する。"
group: "前提"
sidebar:
  order: 1
---

## サーバがないとは、どういうことか

MySQL に接続するとき、実際に起きているのはこうだ。

1. クライアントが TCP で `mysqld` につなぐ
2. `mysqld` が接続を受け、スレッド (またはスレッドプールのタスク) を割り当てる
3. クエリ文字列を送ると、**そのスレッドが** パースし、最適化し、ストレージエンジンを呼び、結果を返す
4. バッファプールも redo ログも `mysqld` のプロセスの中にあり、すべての接続が共有する

Turso ではこうなる。

1. アプリケーションが `turso_core` をリンクする
2. `Database::open` でファイルを開き、`db.connect()` で `Connection` を作る
3. クエリ文字列を渡すと、**アプリケーション自身のスレッドが** パースし、最適化し、B-tree を歩き、結果を返す
4. バッファプールも WAL も **アプリケーションのプロセスの中にある**

**2〜4 の中身はほとんど同じで、消えたのは 1 だけ**だと言ってもいい。接続の受け付け、認証、スレッドの割り当て、プロトコルのエンコード。サーバ型の RDB のコードのかなりの部分を占めるこれらが、丸ごと存在しない。

その代わり、サーバがあったからこそ暗黙に成立していた前提が、全部なくなる。

| サーバがあれば無料だったもの                   | Turso ではどうなるか                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 同時実行の調停は `mysqld` 内のロックで済む     | **別プロセス** が同じファイルを開いてくる。OS のファイルロックで調停するしかない ([該当ページ](../shared-wal-tshm/)) |
| I/O で止まってもいいスレッドが自分のものである | **止まっていいスレッドがない。** アプリのスレッドを勝手にブロックできない ([該当ページ](../io-result/))              |
| バックグラウンドスレッドを好きなだけ作れる     | 勝手にスレッドを作るとアプリのスレッドモデルを壊す。チェックポイントもクエリを叩いた誰かがやる                       |
| プロセスが落ちるのはサーバだけ                 | **アプリごと落ちる。** panic の重みが違う                                                                            |

最後の 1 つが、このコードベースの雰囲気を決めている。開発者向けガイドの冒頭に、こう書いてある。

```text title="AGENTS.md"
1. **Correctness paramount.** Production DB, not a toy. Crash > corrupt
```

**壊れたデータを返すくらいなら落ちろ。** [`AGENTS.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/AGENTS.md) のこの一行は、この後のページで何度も具体的な形で出てくる。

## 3 つの層

`core/` の中は、大きく 3 層に分かれている。

| 層            | 何をするか                           | 場所              | MySQL でいうと                                |
| ------------- | ------------------------------------ | ----------------- | --------------------------------------------- |
| **translate** | SQL テキストをバイトコードに落とす   | `core/translate/` | パーサ + オプティマイザ                       |
| **vdbe**      | バイトコードを 1 命令ずつ実行する    | `core/vdbe/`      | executor (イテレータツリー)                   |
| **storage**   | ページを読み書きし、耐久性を保証する | `core/storage/`   | InnoDB (バッファプール、B+ ツリー、redo ログ) |

MySQL との一番大きな構造上の違いは、**「ストレージエンジン」という差し替え可能な層が存在しない**ことだ。`handler` インタフェースに相当するものはなく、`core/storage/` の B-tree が唯一の実装として直に呼ばれる。

代わりに、Turso が差し替え可能にした場所は別のところにある。

- **SQL 方言** — `Dialect` trait。SQLite と Postgres で SQL テキストの解釈だけを切り替える ([該当ページ](../dialect-trait/))
- **索引方式** — `IndexMethod` trait。全文検索やベクトル索引を後から差す ([該当ページ](../index-method/))
- **I/O** — `IO` trait。io_uring、epoll、IOCP、メモリ、そしてテスト用の細工つき実装 ([該当ページ](../io-backends/))
- **並行制御** — `journal_mode` で WAL と MVCC を切り替える ([該当ページ](../mvcc/))

**「エンジンを差し替える」のではなく「エンジンの一部を差し替える」形になっている。**

## `Database` と `Connection`

`Database` は 1 つのデータベースファイルに対して 1 個あり、複数の `Connection` から共有される。

```rust title="core/database.rs"
pub struct Database<A: alloc::ConcurrentAllocator = alloc::DynAllocator> {
    pub(crate) mv_store: ArcSwapOption<mvcc::MvStore<mvcc::MvccClock, A>>,
    pub(crate) mv_store_allocator: A,
    pub(crate) schema: Arc<Mutex<Arc<Schema>>>,
    pub db_file: Arc<dyn DatabaseStorage>,
    pub path: String,
    wal_path: String,
    pub io: Arc<dyn IO>,
    pub(crate) buffer_pool: Arc<BufferPool>,
    // Shared structures of a Database are the parts that are common to multiple threads that might
    // create DB connections.
    _shared_page_cache: Arc<RwLock<PageCache>>,
```

[`core/database.rs#L515-L532`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/database.rs#L515-L532)。

`mysqld` のグローバル構造体に相当するものが、そのままここに並んでいる。バッファプール、共有ページキャッシュ、WAL の共有状態、スキーマ、そして I/O バックエンド。**違うのは、これがプロセスに 1 個ではなく、開いたファイルごとに 1 個であることだ。**

`Connection` の方は、MySQL の `THD` (スレッドごとの状態) に対応する。

```rust title="core/connection.rs"
/// Database connection handle.
///
/// If you add a setting that affects SQL compilation or execution, call
/// `bump_prepare_context_generation()` in its setter so cached prepared
/// statements know they need to be reprepared.
pub struct Connection {
    pub(crate) db: Arc<Database>,
    pub(crate) pager: ArcSwap<Pager>,
    pub(crate) schema: RwLock<Arc<Schema>>,
    ...
    /// Whether to automatically commit transaction
    pub(crate) auto_commit: AtomicBool,
    pub(super) transaction_state: AtomicTransactionState,
```

[`core/connection.rs#L369-L400`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/connection.rs#L369-L400)。

`auto_commit`、`last_insert_rowid`、`changes`、`total_changes` — MySQL のセッション変数とほぼ同じ顔ぶれが並ぶ。

注目したいのは **`pager: ArcSwap<Pager>`** だ。ページキャッシュとダーティページの管理は、**接続ごとに持つ**。MySQL のバッファプールがインスタンスに 1 個なのとは逆で、Turso は「接続ごとのページキャッシュ」を基本にしている (共有キャッシュもあるが、既定ではない)。

これは SQLite からの継承だ。SQLite の `sqlite3` ハンドルは自分の pager を持つ。その形をそのまま引き継いでいる。

## クエリが走る道筋

MySQL でいう「クエリを投げる」は、Turso ではこの 3 段になる。

```text
prepare  →  Statement (バイトコード + レジスタ)
step     →  1 行進める、または「まだです」を返す
step     →  ...
step     →  Done
```

`step()` の戻り値がこれだ。

```rust title="core/vdbe/mod.rs"
pub enum StepResult {
    Done,
    IO,
    Row,
    Interrupt,
    Busy,
    /// The statement explicitly yielded control back to the caller without any pending I/O.
    /// Stepping again immediately (even in a tight loop) is fine; blocking callers should
    /// still drive the event loop (`io.step()`) between steps so progress that depends on
    /// other threads' I/O is not starved.
    Yield,
    /// The statement asks the caller to wait for `duration` before stepping again,
    /// e.g. because a busy handler decided to retry after a delay. Callers that don't
    /// track time may treat this exactly like `IO`: drive the event loop and step again.
    Sleep {
        duration: std::time::Duration,
    },
}
```

[`core/vdbe/mod.rs#L174-L191`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/vdbe/mod.rs#L174-L191)。

`Row` と `Done` は SQLite の `SQLITE_ROW` / `SQLITE_DONE` そのままだ。**この章にとって重要なのは残りの 4 つ**で、どれも「まだ結果は出せないが、スレッドをブロックもしない」を意味する。

- `IO` — ディスク I/O を投げた。完了させてからもう一度呼べ
- `Yield` — 自発的に譲った。すぐ呼び直していい
- `Busy` — 他の書き手とぶつかった
- `Sleep` — ぶつかったので、この時間だけ待ってから呼び直せ

**MySQL なら、この 4 つは全部「スレッドが中で寝る」で済む。** Turso には寝ていいスレッドがない。だから呼び出し元に返すしかない。

## 誰が I/O を進めるのか

`StepResult::IO` を受け取った呼び出し元は、I/O を完了させる責任を負う。その入口が `IO` trait だ。

```rust title="core/io/mod.rs"
pub trait IO: Clock + Send + Sync {
    fn open_file(&self, path: &str, flags: OpenFlags, direct: bool) -> Result<Arc<dyn File>>;
    ...
    fn step(&self) -> Result<()> {
        Ok(())
    }
```

```rust title="core/io/mod.rs"
    fn wait_for_completion(&self, c: Completion) -> Result<()> {
        while !c.finished() {
            self.step()?
        }
```

[`core/io/mod.rs#L424-L470`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/io/mod.rs#L424-L470)。

**`io.step()` が「イベントループを 1 周回す」**。io_uring なら完了キューを取り込み、epoll なら `epoll_wait` を呼ぶ。

つまり Turso の実行は、こういう二重ループになる。

```text
loop {
    match stmt.step()? {
        Row  => 行を返す
        Done => 終わり
        IO   => io.step()   // ← I/O を 1 周進めて、また stmt.step()
        ...
    }
}
```

**このループを回すのはアプリケーションのスレッドだ。** Turso 自身は、このためのスレッドを作らない。

同期的に使いたい呼び出し元のために、`wait_for_completion` のような「完了するまで `step` を回し続ける」ヘルパが用意されている。これを使えば普通のブロッキング API になる。

逆に、Rust の `async` から使いたい場合はこうなる。

```rust title="bindings/rust/src/rows.rs"
    /// Fetch the next row of this result set.
    pub async fn next(&mut self) -> Result<Option<Row>> {
        struct Next {
            columns: usize,
            stmt: Statement,
        }

        impl Future for Next {
            type Output = Result<Option<Row>>;

            fn poll(
                self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Self::Output> {
                self.stmt.step(Some(self.columns), cx)
            }
        }
```

[`bindings/rust/src/rows.rs#L41-L66`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/bindings/rust/src/rows.rs#L41-L66)。

**エンジンの内部には `async`/`await` が 1 つもないが、境界で `Future` に変換できる。** `step` が「進めるだけ進めて、まだなら帰る」形をしているので、`poll` の形にそのまま嵌まる。逆に、ブロッキングで使いたい呼び出し元も同じ `step` を使える。

**どちらの実行モデルにも寄せていないから、どちらにも載せられる。** ライブラリとして配られる DB にとって、これは要件に近い。

## `IOResult` — 内部の共通語

`step` が呼び出し元に返す `StepResult::IO` は、エンジン内部では `IOResult<T>` として現れる。

```rust title="core/types.rs"
#[derive(Debug)]
#[must_use]
pub enum IOResult<T> {
    Done(T),
    IO(IOCompletions),
}
```

[`core/types.rs#L3462-L3467`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/types.rs#L3462-L3467)。

**「途中で I/O 待ちになりうる関数」はすべてこの型を返す。** B-tree のシーク、ページの読み込み、チェックポイント、スキーマの読み直し。エンジンの中を縦に貫いて、この型が通っている。

`#[must_use]` が付いているのが効いている。`IO` を返されたのに無視すると、**I/O が完了していないのに完了したことにして先に進む**。そのままデータ破壊になる。コンパイラに見張らせている。

この型が実際にどう使われ、どんなバグを生むかは [次のページ](../io-result/) と [その次](../reentrancy/) で扱う。

## この章で使う語彙の対応表

| Turso                   | MySQL / InnoDB でいうと                      | 補足                                  |
| ----------------------- | -------------------------------------------- | ------------------------------------- |
| `Database`              | インスタンス全体の共有構造                   | ただしファイルごとに 1 個             |
| `Connection`            | `THD` (セッション)                           | ただの構造体。スレッドとの対応は自由  |
| `Pager`                 | バッファプール + トランザクション管理        | **接続ごとに持つ**                    |
| `PageCache`             | バッファプールの LRU                         | 既定は接続ごと 2000 ページ            |
| `BufferPool`            | ページのメモリ確保                           | アリーナ。名前に反して LRU ではない   |
| WAL (`.db-wal`)         | redo ログ                                    | ただし **ページ全体** を書く          |
| logical log (`.db-log`) | undo ログに近い                              | MVCC 有効時のみ                       |
| checkpoint              | ダーティページのフラッシュ + redo の切り詰め | WAL の内容を `.db` に書き戻す         |
| VDBE                    | executor                                     | イテレータツリーではなくバイトコード  |
| `Program` / `Insn`      | 実行計画                                     | `EXPLAIN` でそのまま見える            |
| `Cursor`                | ハンドラのカーソル                           | B-tree の位置を持つ                   |
| `sqlite_schema`         | `mysql.*` のデータディクショナリ             | 普通のテーブルとして `.db` の中にある |
| `IOResult`              | (対応物なし)                                 | I/O 待ちを呼び出し元に返すための型    |

`BufferPool` の名前だけ注意がいる。InnoDB の buffer pool は「ページのキャッシュ」だが、Turso の `BufferPool` は **「整列済みメモリを配るアリーナ」** で、キャッシュの役目は `PageCache` が持つ。この分離の理由は [該当ページ](../buffer-pool-arena/) で扱う。

## この先の読み方

この章のページは、ほぼすべてが次のどれかの形をしている。

1. **サーバがないせいで成り立たなくなった前提を、どう埋めたか** (実行モデル、マルチプロセス、同期)
2. **SQLite 互換という制約の下で、どこまで変えられたか** (ストレージ、MVCC)
3. **サーバ型 RDB が持っていた機能を、どう後から積んだか** (MVCC、マテビュー、Postgres フロントエンド、レプリケーション)
4. **上の全部が本当に壊れていないことを、どう確かめているか** (品質保証の 4 ページ)

2 の「制約」が具体的に何なのかを、[次のページ](../sqlite-compat/) で先に固定しておく。
