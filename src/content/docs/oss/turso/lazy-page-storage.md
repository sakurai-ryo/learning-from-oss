---
title: "ページ単位でオンデマンドに引く lazy storage とスパースファイル"
description: "データベース全体をダウンロードせずに使うために、DatabaseStorage を差し替えてページ単位で取りに行く実装を作った。鍵は「まだ持っていないページ」の表現で、Linux の SEEK_DATA と FALLOC_FL_PUNCH_HOLE を使ってスパースファイルの穴として表す。ファイルサイズは本物と同じで、実際に確保されているのは取得済みのページだけだ。同じページへの同時要求は 1 本にまとめられる。"
sidebar:
  order: 33
---

## 何を学んだか

10GB のデータベースがクラウドにある。手元のアプリは、そのうち数 MB しか触らない。

**全部ダウンロードするのは無駄だ。** かといって、クエリのたびにネットワークを往復するのも遅い。

Turso の部分同期は、**ページ単位のオンデマンド取得**でこれを解く。

- 必要になったページだけを取ってくる
- 一度取ったページは、ローカルのファイルに置く
- **ファイルは本物と同じサイズに見えるが、実際には穴だらけ**

3 つ目が実装の核心になる。**「まだ持っていないページ」を、どう表現するか。**

## ソースコードのどこか

### 「持っていない」をファイルシステムに表現させる

```rust title="sync/engine/src/sparse_io.rs"
    fn has_hole(&self, pos: usize, len: usize) -> turso_core::Result<bool> {
        let file = self.file.read().unwrap();
        // SEEK_DATA: Adjust the file offset to the next location in the file
        // greater than or equal to offset containing data.  If offset
        // points to data, then the file offset is set to offset
        // (see https://man7.org/linux/man-pages/man2/lseek.2.html#DESCRIPTION)
        let res = unsafe { libc::lseek(file.as_raw_fd(), pos as i64, libc::SEEK_DATA) };
```

[`sync/engine/src/sparse_io.rs#L122-L128`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/sparse_io.rs#L122-L128)。

**`lseek(fd, pos, SEEK_DATA)` は「`pos` 以降で最初にデータがある位置」を返す。** 返ってきた位置が `pos + len` 以上なら、その範囲は穴になる。

```rust title="sync/engine/src/sparse_io.rs"
        // lseek succeeded - the hole is here if next data is strictly before pos + len - 1 (the last byte of the checked region
        Ok(res as usize >= pos + len)
```

そして穴を開ける方。

```rust title="sync/engine/src/sparse_io.rs"
    fn punch_hole(&self, pos: usize, len: usize) -> turso_core::Result<()> {
        let file = self.file.write().unwrap();
        let res = unsafe {
            libc::fallocate(
                file.as_raw_fd(),
                libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE,
                pos as i64,
                len as i64,
            )
        };
```

[`sync/engine/src/sparse_io.rs#L150-L159`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/sparse_io.rs#L150-L159)。

**`FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE` — 範囲の実体を解放するが、ファイルサイズは変えない。**

この 2 つで、**「ページの保有状況」を別の索引に持たずに済む。**

普通なら、ビットマップやテーブルで「どのページを持っているか」を管理する。すると **その索引とファイルの中身を、常に一致させ続ける** 責任が生まれる。クラッシュで片方だけ更新されていたら、破綻する。

**ファイルシステムに聞けば、答えは常に正しい。** 索引がないので、ずれようがない。

エラーコードの扱いも丁寧だ。

```rust title="sync/engine/src/sparse_io.rs"
            if errno == libc::ENXIO {
                // ENXIO: whence is SEEK_DATA or SEEK_HOLE, and offset is beyond the
                // end of the file, or whence is SEEK_DATA and offset is
                // within a hole at the end of the file.
                // (see https://man7.org/linux/man-pages/man2/lseek.2.html#ERRORS)
                return Ok(true);
```

[`sync/engine/src/sparse_io.rs#L131-L136`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/sparse_io.rs#L131-L136)。

**`ENXIO` は「ファイル末尾の穴の中にいる」を意味するので、エラーではなく「穴がある」と答える。** man ページの該当箇所を引用している。

**システムコールのエラーコードのうち、1 つだけが正常系である**という状況は分かりにくい。引用があれば、後から検証できる。

この実装が Linux 限定であることも、モジュールの宣言に出ている。

```rust title="sync/engine/src/lib.rs"
#[cfg(target_os = "linux")]
pub mod sparse_io;
```

[`sync/engine/src/lib.rs#L15-L16`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/lib.rs#L15-L16)。

**スパースファイルの操作は移植性がない。** 使える環境でだけ有効にする。

### ストレージ自体を差し替える

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
    fn read_page(
        &self,
        page_idx: usize,
        io_ctx: &turso_core::IOContext,
        c: turso_core::Completion,
    ) -> turso_core::Result<turso_core::Completion> {
```

[`sync/engine/src/database_sync_lazy_storage.rs#L469-L475`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_lazy_storage.rs#L469-L475)。

`LazyDatabaseStorage` は `DatabaseStorage` trait を実装する。[`Database` がこれを `Arc<dyn DatabaseStorage>` で持っている](../architecture/) ので、**丸ごと差し替えられる。**

エンジンから見ると、**ただのデータベースファイル**にしか見えない。ページを要求すると、返ってくる。**その裏でネットワークが動いていることを、B-tree も pager も知らない。**

**「読めるページの集合」を変える拡張が、1 つの trait の実装で済む。**

### 同じページへの同時要求は、1 本にまとめる

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
/// [PageInfo] holds information about page state with some active operation
///
/// Page loading process implemented with deduplication logic,
/// so that if some request want to load page which is already Loading,
/// then it just "subscribe" to the result and wait for anothe operation to complete.
struct PageInfo {
    /// current active operation (operations are mutually exclusive)
    operation: PageOperation,
    /// result of the [PageOperation::Load] operation
    load_result: Option<Result<Vec<u8>, errors::Error>>,
    /// amount of "subscribers" who waits result of the [PageOperation::Load] operation
    load_waits: usize,
}
```

[`sync/engine/src/database_sync_lazy_storage.rs#L25-L37`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_lazy_storage.rs#L25-L37)。

**複数の接続が同じページを同時に要求したら、ネットワークの往復は 1 回で済ませたい。**

最初の 1 人が取りに行き、残りは購読者として待つ。

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
    /// try to start Load operation for the page
    /// returns Err(...) if Write operation is on-going
    /// returns Ok(PageLoadAction::Load) if this page wasn't active before and caller must start load process
    /// returns Ok(PageLoadAction::Wait) if this page already loading and caller just needs to wait for result
    pub fn load_start(&mut self, page_no: usize) -> Result<PageLoadAction, errors::Error> {
        match self.pages.get_mut(&page_no) {
            Some(PageInfo {
                operation: PageOperation::Write,
                ..
            }) => Err(...),
            Some(PageInfo {
                operation: PageOperation::Load,
                load_waits: ref mut subscribers,
                ..
            }) => {
                *subscribers += 1;
                Ok(PageLoadAction::Wait)
            }
            None => {
                ...
                Ok(PageLoadAction::Load)
            }
        }
    }
```

[`sync/engine/src/database_sync_lazy_storage.rs#L86-L114`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_lazy_storage.rs#L86-L114)。

**戻り値が「呼び出し側が次に何をすべきか」になっている。** `Load` なら取りに行け、`Wait` なら待て。

`Err` は「書き込み中なので今は読めない」を意味する。**3 つの状態が 1 つの `Result<PageLoadAction>` に収まっている。**

呼び出し側はこうなる。

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
    let data = if matches!(page_action, PageLoadAction::Wait) {
        tracing::debug!("read_page(page={page}): wait for the page to load");
        // another connection already loading this page - so we need to wait
        loop {
            let _ = ctx.coro.yield_(crate::types::SyncEngineIoResult::IO).await;
            let Some(result) = guard.load_result(page) else {
                continue;
            };
```

[`sync/engine/src/database_sync_lazy_storage.rs#L359-L366`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_lazy_storage.rs#L359-L366)。

**待つ側は、[コルーチンとして yield する](../cdc-tape/)。** スレッドをブロックしない。

購読者の数を数えているのは、**結果をいつ捨てていいかを知るため**になる。全員が受け取ったら、キャッシュから消せる。

### 読み込みと書き込みは排他

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
enum PageOperation {
    /// Load operation triggered during read from the db file
    Load,
    /// Write operation triggered during write (checkpoint) to the db file
    Write,
}
```

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
    /// try to start Write opreation for the page
    /// returns Err(...) if another operation already started (Load or Write)
    pub fn write_start(&mut self, page_no: usize) -> Result<(), errors::Error> {
        if self.pages.contains_key(&page_no) {
            return Err(...);
        }
```

[`sync/engine/src/database_sync_lazy_storage.rs#L39-L74`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_lazy_storage.rs#L39-L74)。

**同じページに対して、読み込みと書き込みは同時に走れない。**

書き込み ([チェックポイント](../wal/)) の途中でリモートから取得したページを書くと、**新しい内容が古い内容で上書きされる。**

読み込みは複数まとめられるが、書き込みは 1 つだけ。**読み書きロックと同じ構造を、ページ単位で持っている。**

`write_end` の後始末が厳しい。

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
    pub fn write_end(&mut self, page_no: usize) {
        let Some(info) = self.pages.remove(&page_no) else {
            panic!("page state must be set before write_end");
        };
        assert_eq!(info.operation, PageOperation::Write);
        assert_eq!(info.load_waits, 0);
        assert!(info.load_result.is_none());
    }
```

[`sync/engine/src/database_sync_lazy_storage.rs#L75-L83`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_lazy_storage.rs#L75-L83)。

**3 つの assert が、この状態機械の不変条件をそのまま書いている。** 書き込みだったはず、購読者はいなかったはず、読み込み結果は残っていないはず。

[「壊すより落ちる」](../architecture/) が、ここでも守られている。

### 取得したページは、ローカルのファイルへ

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
        if let Some(dirty_file) = &dirty_file {
            dirty_file.punch_hole(page_offset as usize, page.len())?;
        }
        page_states_guard.load_end(page_id as usize, Ok(page));
```

[`sync/engine/src/database_sync_lazy_storage.rs#L324-L327`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_lazy_storage.rs#L324-L327)。

**ファイルが 2 つある。** `clean_file` (リモートと同じ内容) と `dirty_file` (ローカルの変更)。

リモートからページを取得したら、**`dirty_file` の該当範囲に穴を開ける**。「このページについてはローカルの変更がない」を意味する。

**穴があるかどうかが、そのまま「どちらのファイルを読むべきか」を答える。** 2 つのファイルの重ね合わせを、フラグではなくファイルの構造で表現している。

### この経路は同期 I/O 前提

```rust title="sync/engine/src/database_sync_lazy_storage.rs"
        assert!(
            clean_c.finished(),
            "LazyDatabaseStorage works only with sync IO"
        );
```

[`sync/engine/src/database_sync_lazy_storage.rs#L319-L322`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/sync/engine/src/database_sync_lazy_storage.rs#L319-L322)。

**「この実装は同期 I/O でしか動かない」を assert で表明している。**

[完了が返った時点で終わっている I/O バックエンド](../io-backends/) を前提にしている。io_uring と組み合わせると、この assert で落ちる。

**制約を型で表せない場合は、実行時の assert で表明する。** 静かに壊れるより、開発中に落ちる方がよい。「対応していない組み合わせ」を暗黙にしない。

## なぜそうなっているか

- **ページの保有状況をスパースファイルで表したのは、別の索引を持ちたくないから。** 索引を持つと、ファイルの中身と索引を常に一致させる責任が生まれる。クラッシュで片方だけ更新されると破綻する。
- **ファイルシステムに聞けば、答えが常に正しい。** 穴が開いているかどうかは、ファイル自身が知っている。ずれようがない。
- **`FALLOC_FL_KEEP_SIZE` を付けたのは、ファイルサイズを本物と同じに保つため。** データベースのヘッダにはページ数が書いてあり、ファイルサイズと整合していなければならない。
- **`ENXIO` を正常として扱うのは、それが「末尾の穴」を意味するから。** エラーコードのうち 1 つだけが正常系である状況は、引用がなければ後から検証できない。
- **Linux 限定にしたのは、スパースファイルの操作に移植性がないから。** 使える環境でだけ有効にする。
- **ストレージを trait ごと差し替えたのは、エンジンに手を入れたくないから。** 「読めるページの集合」を変えるだけなら、その 1 層で完結する。
- **同時要求をまとめるのは、ネットワークの往復が高いから。** 同じページを 5 つの接続が要求したら、5 回取りに行くのは無駄になる。
- **戻り値を「次にすべき行動」にしたのは、状態を呼び出し側に解釈させないため。** 「読み込み中か」を返すと、呼び出し側で「では待つ」を毎回書くことになる。
- **読み込みと書き込みを排他にしたのは、上書きの順序が保証できないから。** リモートから取ったページで、ローカルの新しい書き込みを消してはいけない。
- **`write_end` に 3 つの assert を置いたのは、不変条件がそこで確かめられるから。** 状態機械の終端は、途中の全操作が正しかったことを確認できる唯一の場所になる。
- **同期 I/O 前提であることを assert で表明したのは、型で表せないから。** 暗黙の前提は、いつか誰かが破る。

## どう活かすか

- **「一部だけ持っている」状態を、別の索引で管理しない。** データ自身に持たせられるなら、そちらを選ぶ。索引はデータとずれる。
- **スパースファイルは、疎な保有状況の表現に使える。** `SEEK_DATA` で問い合わせ、`PUNCH_HOLE` で解放する。ファイルサイズを保ったまま実体だけを消せる。
- **システムコールのエラーコードで、1 つだけが正常系なら、man の該当箇所を引用する。** そうでなければ、後から「これは本当に無視していいのか」を判断できない。
- **移植性のない仕組みは、`cfg` で対象を絞る。** 「動くかどうか実行時に試す」より、コンパイル時に切り分ける。
- **データの供給元を変える拡張は、ストレージ層の 1 つの trait に閉じ込める。** 上の層 (索引、実行器) が何も知らずに済むなら、その拡張は安全になる。
- **高価な取得は、同じ対象への同時要求をまとめる。** 最初の 1 人が取りに行き、残りは購読する。
- **調停関数の戻り値は、状態ではなく「次にすべき行動」にする。** 呼び出し側での分岐が減り、状態の解釈が 1 箇所に集まる。
- **同じ対象への読み書きは、明示的に排他する。** 供給元が複数あると、書き込みの順序が保証されない。
- **状態機械の終端に、不変条件の assert を置く。** そこが、途中の全操作をまとめて検証できる唯一の場所になる。
- **型で表せない前提は、実行時に表明する。** 「この組み合わせでは動かない」を暗黙にすると、遠い場所で静かに壊れる。
