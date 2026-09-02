---
title: "basebackup — 空の PGDATA から起動する"
description: "compute はディレクトリが空の状態から起動する。pageserver が送るのは、リレーションファイルを含まない tar だ。何が入っていて何が入っていないか、そして prev_record_lsn だけが履歴を要求することの意味。"
group: "compute 側の改造"
sidebar:
  order: 17
---

## 何を学んだか

compute の起動シーケンスはこうなる。

1. pageserver に basebackup を要求する
2. 返ってきた tar を空のディレクトリに展開する
3. `postgres` を起動する

その tar の中身を作るのが `pageserver/src/basebackup.rs` だ。冒頭に断り書きがある。

```rust title="pageserver/src/basebackup.rs"
//! Generate a tarball with files needed to bootstrap ComputeNode.
//!
//! TODO: this module has nothing to do with PostgreSQL pg_basebackup.
//! It could use a better name.
//!
//! Stateless Postgres compute node is launched by sending a tarball
//! which contains non-relational data (multixacts, clog, filenodemaps, twophase files),
//! generated pg_control and dummy segment of WAL.
```

([pageserver/src/basebackup.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/basebackup.rs#L1))

**リレーションのデータは入っていない。** それが `pg_basebackup` と決定的に違うところだ。テーブルの中身は、必要になったときに `getpage@lsn` で取る。

だから basebackup のサイズは、データベースの大きさとほとんど無関係になる。1TB のデータベースでも数 MB で起動できる。**コールドスタートの速さは、ここで決まっている。**

## 入っているもの

| 中身                            | なぜ必要か                                      |
| ------------------------------- | ----------------------------------------------- |
| `global/pg_control`             | 起動状態。合成する                              |
| `pg_filenode.map` (relmap)      | 一部のシステムカタログの OID → relfilenode 対応 |
| SLRU (clog, multixact)          | 可視性判定に要る。遅延取得も可                  |
| twophase ファイル               | 準備済みトランザクション                        |
| `pg_wal/` の空セグメント 1 本   | WAL の書き始めの器                              |
| `neon.signal` / `zenith.signal` | 起動の指示                                      |
| `PG_VERSION`、`pg_hba.conf` 等  | 定型ファイル                                    |
| 各 DB のディレクトリ            | 空でも存在させる必要がある                      |

**「Postgres がファイルシステム上に存在すると信じているもの」を全部作る**というのが、この tar の仕事になる。

面白いのは `relmap` だ。`pg_class` 自身のような、システムカタログのブートストラップに使われるリレーションは、カタログを引かずに relfilenode を知る必要がある。だから `pg_filenode.map` という別ファイルに持つ。**カタログを読むためにカタログを読む、という循環を切るための仕組み**で、Neon もそのまま持ち越している。

WAL セグメントは中身のない 16MB のファイルを生成して入れる。

```rust title="pageserver/src/basebackup.rs"
        let wal_seg = postgres_ffi::generate_wal_segment(
            segno,
            system_identifier,
            self.timeline.pg_version,
            self.lsn,
        )
```

([pageserver/src/basebackup.rs L810](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/basebackup.rs#L810))

ページヘッダだけが正しく埋まった空セグメント。ここから WAL を書き始める。

## prev_record_lsn だけが履歴を要求する

`neon.signal` に書き込む値の決定が、この tar でいちばん微妙な部分になる。

```rust title="pageserver/src/basebackup.rs"
        let mut neon_signal = String::new();
        if self.prev_record_lsn == Lsn(0) {
            if self.timeline.is_ancestor_lsn(self.lsn) {
                write!(neon_signal, "PREV LSN: none")
            } else {
                write!(neon_signal, "PREV LSN: invalid")
            }
        } else {
            write!(neon_signal, "PREV LSN: {}", self.prev_record_lsn)
        }
```

([pageserver/src/basebackup.rs L771](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/basebackup.rs#L771))

なぜこの値が要るかは [起動シーケンス](../startup-and-control-file/) で見た。`XLogRecord.xl_prev` に入れる値がないと、WAL を書き始められない。

問題は、**pageserver がその値を持っていないことがある**という点だ。

```rust title="pageserver/src/basebackup.rs"
    // We don't keep full history of record boundaries in the page server,
    // however, only the predecessor of the latest record on each
    // timeline. So we can only provide prev_record_lsn when you take a
    // base backup at the end of the timeline, i.e. at last_record_lsn.
```

([pageserver/src/basebackup.rs L105](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/basebackup.rs#L105))

**pageserver はレコードの境界を保存していない。** WAL を消化してキー値にしてしまうので、「LSN X の直前のレコードはどこから始まったか」は分からない。保持しているのは「timeline の末尾の 1 つ前」だけだ。

つまり:

- **timeline の末尾で basebackup を取る** → `prev_record_lsn` がある → 読み書きできる
- **過去の LSN で取る (PITR)** → ない → `invalid` → **読み取り専用**
- **ブランチの分岐点ちょうどで取る** → 親の WAL は続いているのでそもそも書けない → `none` (新しい timeline の先頭として扱う)

**PITR で開いたブランチが読み取り専用になるのは、機能の制約ではなく、この情報が保存されていないことの帰結だ。** WAL レコードのバイト列を全部保存しておけば解決するが、それは pageserver の設計 (WAL を消化してキー値にする) と正面から衝突する。

「何を保存しないか」の判断が、ユーザーから見える機能の形を決めている例になる。

## 2 つの signal ファイル

```rust title="pageserver/src/basebackup.rs"
        // TODO: Remove zenith.signal once all historical computes have been replaced
        // ... and thus support the neon.signal file.
        for signalfilename in ["neon.signal", "zenith.signal"] {
```

Neon の旧名は Zenith だった。**同じ内容のファイルを 2 つ書いている。** 古い compute イメージが `zenith.signal` しか読まないからだ。

サーバー側が新旧両方のクライアントに対応し続ける、という運用の重さがここに出ている。しかも「全部置き換わったら消す」という TODO が、いつ消せるか誰も分からない状態で残っている。

## basebackup はキャッシュされる

`basebackup_cache.rs` (25KB) があり、生成済みの basebackup を保持している。gRPC 版の proto にも記述がある。

```protobuf title="pageserver/page_api/proto/page_service.proto"
  // Compression algorithm to use. Base backups send a compressed payload instead of using gRPC
  // compression, so that we can cache compressed backups on the server.
  BaseBackupCompression compression = 4;
```

([pageserver/page_api/proto/page_service.proto L108](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/page_api/proto/page_service.proto#L108))

**gRPC の圧縮機能を使わず、ペイロードを自分で圧縮している。** 理由は「圧縮済みのものをキャッシュしたいから」。トランスポート層の機能を使うと、リクエストごとに圧縮し直すことになる。

コールドスタートのたびに tar を組み立て直すのは無駄で、しかも遅い。**起動が速いことが商品なので、起動の準備をあらかじめ済ませておく。**

## 起動後、最初のクエリまで

tar を展開して `postgres` が起動しても、そこからが本番だ。共有バッファは空で、LFC も空なので、最初のクエリはほぼ全ページを pageserver から取る。

`docs/core_changes.md` に、まだ実装されていない改善案が載っている。

> ## Prewarming
>
> Short downtime (or, in other words, fast compute node restart time) is one of the key feature of Neon. But overhead of request-response round-trip for loading pages on demand can make started node warm-up quite slow. We can capture state of compute node buffer cache and send bulk request for this pages at startup.

**「起動が速い」と「起動直後から速い」は別の問題だ。** 前者は basebackup を小さくすることで解いた。後者はまだ解けていない。

## この先に効いてくること

- **basebackup にリレーションは入らない。** サイズがデータ量に依存しないので、コールドスタートが速い。
- **pageserver は WAL レコードの境界を保存していない。** それが PITR ブランチの読み取り専用制約になっている。
- **保存しないものの選択が、ユーザーから見える機能の形を決める。**
- **起動が速いことと、起動直後から速いことは別。** 後者は prewarming という未解決の課題。
