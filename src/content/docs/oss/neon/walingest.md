---
title: "walingest — WAL をキー値の更新に翻訳する"
description: "safekeeper から届いた WAL のバイト列を、キーと値のバッチに変える。デコードとシャード振り分けを 1 回で済ませ、Postgres のクラスタ状態を追跡し、そして shard 0 だけが「見たけど保存しない」キーを記録する。"
group: "pageserver — 実行時"
sidebar:
  order: 39
---

## 何を学んだか

取り込みの経路は 3 段だ。

```rust title="pageserver/src/walingest.rs"
//! Parse PostgreSQL WAL records and store them in a neon Timeline.
//!
//! The pipeline for ingesting WAL looks like this:
//!
//! WAL receiver  -> [`wal_decoder`] ->  WalIngest  ->   Repository
//!
//! The WAL receiver receives a stream of WAL from the WAL safekeepers.
//! Records get decoded and interpreted in the [`wal_decoder`] module
//! and then stored to the Repository by WalIngest.
```

([pageserver/src/walingest.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/walingest.rs#L1))

**`wal_decoder` は独立した crate になっている。** pageserver だけでなく safekeeper も使う (`send_interpreted_wal.rs`)。**「WAL を解釈して shard ごとに振り分ける」処理を、safekeeper 側に前倒しできる**ようにするための分離だ。そうすれば、shard が 8 個ある tenant で同じ WAL を 8 回送らずに済む。

## デコードと振り分けを同時にやる

`serialized_batch.rs` の中心にあるループが、これを一気にやっている。

```rust title="libs/wal_decoder/src/serialized_batch.rs"
            for (shard, record) in shard_records.iter_mut() {
                let key_is_local = shard.is_key_local(&key);

                tracing::debug!(
                    lsn=%next_record_lsn,
                    key=%key,
                    "ingest: shard decision {}",
                    if !key_is_local { "drop" } else { "keep" },
                );

                if !key_is_local {
```

([libs/wal_decoder/src/serialized_batch.rs L171](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/wal_decoder/src/serialized_batch.rs#L171))

**1 つの WAL レコードを 1 回デコードして、全 shard 分のバッチを同時に作る。** レコードのパースは重いので、shard ごとに繰り返したくない。

そしてすぐに、shard 0 だけの例外が現れる。

```rust title="libs/wal_decoder/src/serialized_batch.rs"
                if !key_is_local {
                    if shard.is_shard_zero() {
                        // Shard 0 tracks relation sizes.  Although we will not store this block, we will observe
                        // its blkno in case it implicitly extends a relation.
                        record
                            .batch
                            .metadata
                            .push(ValueMeta::Observed(ObservedValueMeta {
                                key: key.to_compact(),
                                lsn: next_record_lsn,
                            }))
                    }

                    continue;
                }
```

([libs/wal_decoder/src/serialized_batch.rs L181](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/libs/wal_decoder/src/serialized_batch.rs#L181))

**shard 0 は、自分が持たないブロックについても「見た」という記録を残す。**

理由はリレーションのサイズだ。Postgres がリレーションを拡張するとき、専用の WAL レコードは出ない。**ブロック N への書き込みが暗黙にサイズを N+1 にする。** そしてサイズを管理しているのは shard 0 だけだ ([tenant・timeline・shard の階層](../tenant-timeline-shard/))。

だから shard 0 は、他の shard が担当するブロックの番号も見る必要がある。値は保存しないが、番号だけ記録する。

`ValueMeta` が `Serialized` と `Observed` の 2 バリアントを持っているのは、このためだ。**「値を持つエントリ」と「存在だけ記録するエントリ」を同じ列に混ぜている。**

シャーディングという後付けの機能が、「暗黙のサイズ拡張」という Postgres の性質と衝突した結果、こういう非対称な仕組みが要ることになった。

## クラスタ状態を追跡する

ページ以外にも、取り込みながら更新する状態がある。

```rust title="pageserver/src/walingest.rs"
        assert!(!self.checkpoint_modified);
        if interpreted.xid != pg_constants::INVALID_TRANSACTION_ID
            && self.checkpoint.update_next_xid(interpreted.xid)
        {
            self.checkpoint_modified = true;
        }
```

([pageserver/src/walingest.rs L251](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/walingest.rs#L251))

**すべてのレコードの xid を見て、`nextXid` を更新する。** [チェックポイントと full page image](../checkpoint-and-fpi/) で見た `CheckPoint` 構造体を、pageserver 側で維持し続けている。

これがないと basebackup が作れない。compute を起動するには `pg_control` が要り、そこには `nextXid` が入っている。

**Postgres の共有メモリ上にあった状態を、pageserver が WAL から再構築している。** チェックポイントレコードが来たときだけ更新すればよさそうに見えるが、それでは足りない。オンラインチェックポイントの間に払い出された xid を取りこぼす。

`checkpoint_modified` フラグと冒頭の `assert!` が、「このフラグは 1 レコードの処理の中で立って、そのレコードの処理の終わりに必ず落ちる」ことを守っている。

## バッチのサイズ制限

```rust title="pageserver/src/pgdatadir_mapping.rs"
    pub(crate) const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
```

([pageserver/src/pgdatadir_mapping.rs L1733](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/pgdatadir_mapping.rs#L1733))

`DatadirModification` は、複数レコード分の変更をメモリに溜めてから、まとめてインメモリレイヤに入れる。8MB で区切る。

溜める理由は、**キーごとにインメモリレイヤの索引を触るコストを償却する**ため。1 レコードずつ入れると、ロックの取得と索引の更新が細かく発生する。

そして途中で `commit()` を強制される場合がある。

```rust title="pageserver/src/walingest.rs"
        if matches!(interpreted.flush_uncommitted, FlushUncommittedRecords::Yes) {
            // Records of this type should always be preceded by a commit(), as they
            // rely on reading data pages back from the Timeline.
            assert!(!modification.has_dirty_data());
        }
```

([pageserver/src/walingest.rs L245](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/walingest.rs#L245))

**「このレコードの処理はページを読み戻す必要があるので、その前に溜まっているものを全部書き出せ」。**

読み戻しが必要になるのは、たとえば visibility map のビット操作だ。「このページのこのビットを立てる」を処理するには、現在のページが要る。溜まっているバッチの中にその更新があると、読み戻しでは見えない。

**書き込みバッファがあるシステムで「読み戻し」が発生すると、必ずフラッシュが要る。** 上流 (デコーダ) がそのフラグを立て、下流 (取り込み) が assert で確認する、という責務の分け方になっている。

## 壊れたデータへの対処

visibility map の処理に、この章で最も慎重な扱いがある。

```rust title="pageserver/src/walingest.rs"
        // VM bits can only be cleared on the shard(s) owning the VM relation, and must be within
        // its view of the VM relation size. Out of caution, error instead of failing WAL ingestion,
        // as there has historically been cases where PostgreSQL has cleared spurious VM pages. See:
        // https://github.com/neondatabase/neon/pull/10634.
        let Some(vm_size) = get_relsize(modification, vm_rel, ctx).await? else {
            critical_timeline!(
                modification.tline.tenant_shard_id,
                modification.tline.timeline_id,
                None::<&AtomicBool>,
                "clear_vm_bits for unknown VM relation {vm_rel}"
            );
            return Ok(());
        };
```

([pageserver/src/walingest.rs L418](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/walingest.rs#L418))

**「存在しない VM リレーションのビットをクリアしろ」という WAL レコードが来る。**

そして対処は「取り込みを止める」ではなく「記録して無視する」になっている。理由が明記されている — **「Postgres が実在しない VM ページをクリアしたことが、歴史的に何度かあったから」。**

`critical_timeline!` は「重大だが致命的ではない」ためのマクロで、アラートを上げつつ処理は続ける。範囲外のブロック番号についても同じ扱いをする。

**取り込みが止まると、その tenant は書き込みも読み取りも進まなくなる。** 一方、VM のビットは正しさに影響しない (性能のヒントでしかない)。**壊れたデータの影響範囲と、止めることの影響範囲を比べて、止めないほうを選んでいる。**

[共有バッファ](../buffer-manager/) で見たゼロ LSN の PANIC とは逆の判断だ。あちらは「静かにデータを失う」ので止める。こちらは「性能が少し落ちる」だけなので止めない。**同じシステムの中で、影響の大きさに応じて厳格さを変えている。**

## Postgres のバージョン差

```rust title="pageserver/src/walingest.rs"
enum_pgversion! {CheckPoint, pgv::CheckPoint}
```

Neon は Postgres 14〜17 を同時にサポートしている。WAL のフォーマットはバージョンごとに違う。

`enum_pgversion!` は、バージョンごとの型を包む enum を生成するマクロだ。`enum_pgversion_dispatch!` が、その enum に対する分岐を書く。

```rust title="pageserver/src/walingest.rs"
    fn encode(&self) -> Result<Bytes, SerializeError> {
        enum_pgversion_dispatch!(self, CheckPoint, cp, { cp.encode() })
```

**バージョン分岐を型とマクロに閉じ込めて、ロジックからは見えなくする。** `postgres_ffi` は各バージョンのモジュール (`v14`, `v15`, ...) を持ち、定数と構造体をそれぞれ定義している。

複数バージョンのサポートは、素直に書くと分岐だらけになる。**分岐の場所を型に押し込むことで、増えるのは型定義だけになる。**

## この先に効いてくること

- **デコーダを独立 crate にすると、処理を前段に移せる。** safekeeper で振り分けて、shard ごとに違うものを送る。
- **「見たが保存しない」という第 3 の状態が要ることがある。** 暗黙のサイズ拡張を追うため。
- **読み戻しが要る操作の前にはフラッシュが要る。** 上流がフラグを立て、下流が assert する。
- **止めることの影響と、壊れていることの影響を比べる。** 同じシステムでも厳格さは一様でない。
- **バージョン分岐は型とマクロに押し込む。**
