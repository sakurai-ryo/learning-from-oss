---
title: "書き込みを 1 本のトランザクションに溜め込み、未コミットの差分をメモリのバッファで読ませる"
description: "etcd の backend は、bbolt の書き込みトランザクションを開きっぱなしにして複数の書き込みを溜め、100 ms か 10000 件でコミットする。その間、まだディスクに無い変更は書き込みバッファから読める。さらに読み取り専用のトランザクションは、そのバッファのコピーを持って完全にロックフリーで走る。"
group: "ストレージ"
sidebar:
  order: 7
---

## 何を学んだか

### どんな状況の話か

etcd の下には bbolt という B+tree の組み込み KV がある。bbolt のトランザクションモデルは単純で、

- **書き込みトランザクションは同時に 1 本だけ。**
- **コミットのたびに fsync が入る。**
- **読み取りトランザクションは複数同時に開けるが、書き込みのコミットは、開いている読み取りが終わるまで待つ** (正確には、コミット時にメタページを差し替えるためのロックが要る)。

素直に「1 リクエスト = 1 トランザクション」にすると、**書き込み 1 回ごとに fsync が 1 回** 入る。回転ディスクなら 10 ms、SSD でも 0.1 ms 単位のコストで、これが直列に並ぶ。

一方で、遅らせすぎると別の問題が出る。

- **書いたばかりのデータが読めない。** まだコミットしていない変更は、bbolt の読み取りトランザクションからは見えない。
- **クラッシュ時に失われる範囲が広がる。**

後者については etcd には答えがある。**永続性は WAL が担っていて、bbolt は「適用結果のキャッシュ」に近い位置づけ** だ ([前提のページ](../architecture/))。落ちても WAL から再適用できるので、bbolt のコミットは遅れてよい。

残るのは前者、「未コミットの変更をどう読ませるか」になる。

### etcd の答え

1. **書き込みトランザクションを開きっぱなしにして、複数の書き込みを溜める。** コミットは 100 ms ごと、または 10000 件たまったとき。
2. **書き込みは同時に「書き込みバッファ」にも入れる。** メモリ上のソート済み配列。
3. **コミットの瞬間に、書き込みバッファを「読み取りバッファ」へ移す。**
4. **読み取りは、読み取りバッファと bbolt の両方を見て、結果をマージする。**
5. **並行読み取り用のトランザクションは、読み取りバッファのコピーを持つ。** 持ってしまえば、以後ロックを一切取らずに読める。
6. **そのコピーをキャッシュする。** バッファが変わっていなければ、コピーすらしない。

**「未コミットの差分を、読み取り経路にマージする」** というのがこの設計の核で、それを支えるのがバッファのコピーとバージョン番号になる。

## ソースコードのどこか

### コミットの契機は 2 つ

時間による契機 ([`server/storage/backend/backend.go#L441-L457`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/backend.go#L441-L457))。

```go title="server/storage/backend/backend.go"
func (b *backend) run() {
	defer close(b.donec)
	t := time.NewTimer(b.batchInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
		case <-b.stopc:
			b.batchTx.CommitAndStop()
			return
		}
		if b.batchTx.safePending() != 0 {
			b.batchTx.Commit()
		}
		t.Reset(b.batchInterval)
	}
}
```

件数による契機 ([`server/storage/backend/batch_tx.go#L109-L114`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/batch_tx.go#L109-L114))。

```go title="server/storage/backend/batch_tx.go"
func (t *batchTx) Unlock() {
	if t.pending >= t.backend.batchLimit {
		t.commit(false)
	}
	t.Mutex.Unlock()
}
```

**コミットの判定がロックの解放に埋め込まれている。** 書き込みをした側が「そろそろコミットしよう」と判断する必要がない。`Unlock` を呼べば、必要ならコミットが起きる。

しきい値は 100 ms と 10000 件 ([`#L34-L37`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/backend.go#L34-L37))。

```go title="server/storage/backend/backend.go"
	defaultBatchLimit    = 10000
	defaultBatchInterval = 100 * time.Millisecond
```

**時間と量の両方でしきい値を持つのは、バッチ処理の定石だ。** 時間だけだと、大量書き込みでトランザクションが肥大化する。量だけだと、書き込みが少ないときにいつまでもコミットされない。

### 2 つのバッファと、その受け渡し

書き込みは bbolt と書き込みバッファの両方に入る。コミットの瞬間に、書き込みバッファの内容が読み取りバッファへ移される ([`server/storage/backend/tx_buffer.go#L96-L116`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/tx_buffer.go#L96-L116))。

```go title="server/storage/backend/tx_buffer.go"
func (txw *txWriteBuffer) writeback(txr *txReadBuffer) {
	for k, wb := range txw.buckets {
		rb, ok := txr.buckets[k]
		if !ok {
			delete(txw.buckets, k)
			if seq, ok := txw.bucket2seq[k]; ok && !seq {
				wb.dedupe()
			}
			txr.buckets[k] = wb
			continue
		}
		if seq, ok := txw.bucket2seq[k]; ok && !seq && wb.used > 1 {
			// assume no duplicate keys
			sort.Sort(wb)
		}
		rb.merge(wb)
	}
	txw.reset()
	// increase the buffer version
	txr.bufVersion++
}
```

**`bucket2seq` というマップが、バケットごとに「キーが単調増加で入ってきたか」を覚えている。**

[keyIndex のページ](../mvcc-key-index/) で見たとおり、KV の本体バケットにはリビジョンをビッグエンディアンにしたキーが入る。**必ず単調増加する** ので、ソートが要らない。一方、メタデータ用のバケットは任意の順で書かれるので、ソートしてからマージする必要がある。

「単調増加かどうか」は、書き込み時の呼び出し方で決まる ([`#L50-L73`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/tx_buffer.go#L50-L73))。

```go title="server/storage/backend/tx_buffer.go"
func (txw *txWriteBuffer) put(bucket Bucket, k, v []byte) {
	txw.bucket2seq[bucket.ID()] = false
	txw.putInternal(bucket, k, v)
}

func (txw *txWriteBuffer) putSeq(bucket Bucket, k, v []byte) {
	// putSeq is only be called for the data in the Key bucket. The keys
	// in the Key bucket should be monotonically increasing revisions.
	verify.Verify("Broke the rule of monotonically increasing", func() (bool, map[string]any) {
		b, ok := txw.buckets[bucket.ID()]
		if !ok || b.used == 0 {
			return true, nil
		}
		existingMaxKey := b.buf[b.used-1].key
		if bytes.Compare(k, existingMaxKey) <= 0 {
			return false, map[string]any{
				"existingMaxKey": hex.EncodeToString(existingMaxKey),
				"currentKey":     hex.EncodeToString(k),
			}
		}
		return true, nil
	})
	txw.putInternal(bucket, k, v)
}
```

**`putSeq` を呼ぶ側が「単調増加です」と宣言し、その宣言が正しいかを検証で確かめる。**

[consistent index のページ](../consistent-index/) で見た `LockInsideApply` と同じ形だ。**型では表現できない前提を、メソッド名で表明させ、開発ビルドで検証する。** 破れると、ソートしていない配列に二分探索をかけることになり、静かに間違った結果を返す。

### 読み取りは 2 つの源をマージする

[`server/storage/backend/read_tx.go#L78-L120`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/read_tx.go#L78-L120)。

```go title="server/storage/backend/read_tx.go"
func (baseReadTx *baseReadTx) UnsafeRange(bucketType Bucket, key, endKey []byte, limit int64) ([][]byte, [][]byte) {
	if endKey == nil {
		// forbid duplicates for single keys
		limit = 1
	}
	if limit <= 0 {
		limit = math.MaxInt64
	}
	if limit > 1 && !bucketType.IsSafeRangeBucket() {
		panic("do not use unsafeRange on non-keys bucket")
	}
	keys, vals := baseReadTx.buf.Range(bucketType, key, endKey, limit)
	if int64(len(keys)) == limit {
		return keys, vals
	}
```

**バッファを先に見て、上限に達したら bbolt を見ない。** 未コミットの新しいデータのほうが優先されるべきなので、この順序になる。

`IsSafeRangeBucket` の判定は、パッケージ冒頭のコメントが説明している ([`#L24-L26`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/read_tx.go#L24-L26))。

```go title="server/storage/backend/read_tx.go"
// IsSafeRangeBucket is a hack to avoid inadvertently reading duplicate keys;
// overwrites on a bucket should only fetch with limit=1, but IsSafeRangeBucket
// is known to never overwrite any key so range is safe.
```

**バッファと bbolt に同じキーが両方あると、単純に連結すると重複する。** KV の本体バケットは「同じリビジョンを 2 回書かない」ので重複しえないが、メタデータのバケットは上書きするので重複しうる。

そこで、上書きされうるバケットに対しては **`limit=1` の単一キー取得しか許さない**。単一キーなら、バッファで見つかった時点で返せるので重複しない。範囲取得をしようとすると `panic` する。

自称 `hack` だが、**「安全な使い方だけを許す」という形で不整合を構造的に排除している。**

`UnsafeForEach` のほうは、重複を実際に除去する ([`#L54-L76`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/read_tx.go#L54-L76))。

```go title="server/storage/backend/read_tx.go"
	dups := make(map[string]struct{})
	getDups := func(k, v []byte) error {
		dups[string(k)] = struct{}{}
		return nil
	}
	visitNoDup := func(k, v []byte) error {
		if _, ok := dups[string(k)]; ok {
			return nil
		}
		return visitor(k, v)
	}
	if err := baseReadTx.buf.ForEach(bucket, getDups); err != nil {
		return err
	}
	baseReadTx.txMu.Lock()
	err := unsafeForEach(baseReadTx.tx, bucket, visitNoDup)
	baseReadTx.txMu.Unlock()
	if err != nil {
		return err
	}
	return baseReadTx.buf.ForEach(bucket, visitor)
```

**バッファを 3 回走査している。** 1 回目でキーの集合を作り、2 回目 (bbolt) でその集合に無いものだけ訪問し、3 回目でバッファの内容を訪問する。

全走査は頻度が低い操作なので、この素朴さで問題にならない。**頻度の低い経路には、素直で読める実装を置く** という判断が見える。

### 並行読み取りはロックを取らない

読み取り専用のトランザクションは 2 種類ある ([`#L124-L151`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/read_tx.go#L124-L151))。

```go title="server/storage/backend/read_tx.go"
type readTx struct {
	baseReadTx
}

func (rt *readTx) Lock()    { rt.mu.Lock() }
// ...

type concurrentReadTx struct {
	baseReadTx
}

func (rt *concurrentReadTx) Lock()   {}
func (rt *concurrentReadTx) Unlock() {}

// RLock is no-op. concurrentReadTx does not need to be locked after it is created.
func (rt *concurrentReadTx) RLock() {}

// RUnlock signals the end of concurrentReadTx.
func (rt *concurrentReadTx) RUnlock() { rt.txWg.Done() }
```

**同じインターフェースを実装しつつ、ロックのメソッドが全部空になっている。**

`concurrentReadTx` は、**作られた時点でバッファのコピーを持っている** ので、以後どれだけ書き込みが起きても影響を受けない。ロックする対象がない。

唯一の例外が `RUnlock` で、これは `WaitGroup` の `Done` になっている。**「このトランザクションが使い終わった」を知らせるためだけにある。** 知らせないと、bbolt の読み取りトランザクションがロールバックされず、コミットがブロックされ続ける。

コミット側でその待ちが起きる ([`server/storage/backend/batch_tx.go#L361-L378`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/batch_tx.go#L361-L378))。

```go title="server/storage/backend/batch_tx.go"
	if t.backend.readTx.tx != nil {
		// wait all store read transactions using the current boltdb tx to finish,
		// then close the boltdb tx
		go func(tx *bolt.Tx, wg *sync.WaitGroup) {
			wg.Wait()
			if err := tx.Rollback(); err != nil {
				t.backend.lg.Fatal("failed to rollback tx", zap.Error(err))
			}
		}(t.backend.readTx.tx, t.backend.readTx.txWg)
		t.backend.readTx.reset()
	}
```

**待つのを別 goroutine に投げている。** コミット処理自体は、古い読み取りトランザクションの終了を待たずに進める。長い読み取りが走っていても、書き込みは止まらない。

### バッファのコピーをキャッシュする

`ConcurrentReadTx` の生成で、この設計で一番込み入った部分が出てくる ([`server/storage/backend/backend.go#L279-L352`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/backend.go#L279-L352))。

```go title="server/storage/backend/backend.go"
	curCache := b.txReadBufferCache.buf
	curCacheVer := b.txReadBufferCache.bufVersion
	curBufVer := b.readTx.buf.bufVersion

	isEmptyCache := curCache == nil
	isStaleCache := curCacheVer != curBufVer

	var buf *txReadBuffer
	switch {
	case isEmptyCache:
		// perform safe copy of buffer while holding "b.txReadBufferCache.mu.Lock"
		// this is only supposed to run once so there won't be much overhead
		curBuf := b.readTx.buf.unsafeCopy()
		buf = &curBuf
	case isStaleCache:
		// to maximize the concurrency, try unsafe copy of buffer
		// release the lock while copying buffer -- cache may become stale again and
		// get overwritten by someone else.
		// therefore, we need to check the readTx buffer version again
		b.txReadBufferCache.mu.Unlock()
		curBuf := b.readTx.buf.unsafeCopy()
		b.txReadBufferCache.mu.Lock()
		buf = &curBuf
	default:
		// neither empty nor stale cache, just use the current buffer
		buf = curCache
	}
```

**問題は、バッファのコピーがコストだということ。** 読み取りごとにコピーすると、読み取りの多いワークロードで無駄が大きい。

しかしバッファは、コミットが起きるまで変わらない。**コミットの間隔 (最大 100 ms) の中で発生した読み取りは、全部同じコピーを共有できる。**

そのために `bufVersion` がある。`writeback` のたびに 1 増える単調増加のカウンタで、**「キャッシュしたコピーが、今のバッファと同じ世代か」の判定に使う**。

さらに手が込んでいるのが `isStaleCache` の枝だ。**コピーしている間、キャッシュのロックを手放している。** コピーは重い操作なので、その間ロックを持ち続けると他の読み取りが待たされる。

手放した結果、コピー中に別の goroutine がキャッシュを更新するかもしれない。だからロックを取り直した後に、もう一度バージョンを確認する。

```go title="server/storage/backend/backend.go"
	if isEmptyCache || curCacheVer == b.txReadBufferCache.bufVersion {
		// continue if the cache is never set or no one has modified the cache
		b.txReadBufferCache.buf = buf
		b.txReadBufferCache.bufVersion = curBufVer
	}
```

**確認に失敗したら、キャッシュを更新しない。** 自分が作ったコピーはそのまま自分のトランザクションで使う。コメントが「次の `ConcurrentReadTx` がまたコピーを作るから安全だ」と説明している。

**楽観的並行制御を、キャッシュの更新に対して適用している** 形だ。ロックを持つ時間を最小にして、競合したら自分の作業を捨てる (ただし成果は自分で使う)。

コメントが 3 段落にわたって「なぜこれで安全か」を説明しているのも印象的で、**この程度の複雑さになると、説明を書かないと維持できない** ということでもある。

### コピーの実体

[`server/storage/backend/tx_buffer.go#L139-L167`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/tx_buffer.go#L139-L167)。

```go title="server/storage/backend/tx_buffer.go"
// unsafeCopy returns a copy of txReadBuffer, caller should acquire backend.readTx.RLock()
func (txr *txReadBuffer) unsafeCopy() txReadBuffer {
	txrCopy := txReadBuffer{
		txBuffer: txBuffer{
			buckets: make(map[BucketID]*bucketBuffer, len(txr.txBuffer.buckets)),
		},
		bufVersion: 0,
	}
	for bucketName, bucket := range txr.txBuffer.buckets {
		txrCopy.txBuffer.buckets[bucketName] = bucket.CopyUsed()
	}
	return txrCopy
}

// bucketBuffer buffers key-value pairs that are pending commit.
type bucketBuffer struct {
	buf []kv
	// used tracks number of elements in use so buf can be reused without reallocation.
	used int
}
```

**`used` で「使用中の要素数」を別に持ち、スライス自体は縮めない。** リセットは `used = 0` にするだけなので、次のバッチで同じ配列を再利用できる。

`CopyUsed` は `used` の分だけコピーする。バッファが一時的に大きくなっても、コピーのコストは実際の内容の量で決まる。

`bucketBuffer` の初期サイズは 512。バッファのリセットも、空のバケットを落とす形になっている ([`#L33-L40`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/tx_buffer.go#L32-L40))。

```go title="server/storage/backend/tx_buffer.go"
func (txb *txBuffer) reset() {
	for k, v := range txb.buckets {
		if v.used == 0 {
			// demote
			delete(txb.buckets, k)
		}
		v.used = 0
	}
}
```

**「2 回連続で使われなかったバケットは捨てる」** という緩やかな縮退になっている (1 回目のリセットで `used = 0` になり、次のリセットで削除される)。頻繁に使われるバケットの配列は保持され、たまにしか使われないバケットは解放される。

### バッファの探索は二分探索

[`#L169-L193`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/backend/tx_buffer.go#L169-L193)。

```go title="server/storage/backend/tx_buffer.go"
func (bb *bucketBuffer) Range(key, endKey []byte, limit int64) (keys [][]byte, vals [][]byte) {
	f := func(i int) bool { return bytes.Compare(bb.buf[i].key, key) >= 0 }
	idx := sort.Search(bb.used, f)
```

ソート済みのスライスなので二分探索が使える。**`putSeq` の検証が守っているのは、この前提だ。** 単調増加でないキーが `putSeq` で入ると、ソートされていない配列に二分探索をかけることになる。

マップではなくソート済みスライスを選んでいるのは、**範囲検索が要るから**。KV の読み取りは範囲取得が主なので、ハッシュマップでは足りない。

## なぜそうなっているか

- **書き込みをバッチにできるのは、永続性を WAL が担っているから。** bbolt のコミットが遅れても、クラッシュ後に WAL から再適用できる。**永続性の責務を 1 箇所に集約したことで、他の層が遅延を選べるようになっている。** 逆に、WAL が無ければこのバッチは成立しない。
- **時間と件数の両方でしきい値を持つのは、片方だけでは破綻するから。** 時間だけならトランザクションが肥大化し、件数だけなら低負荷時にコミットされない。バッチ処理の設計では、常にこの 2 つが要る。
- **コミット判定をロック解放に埋め込むのは、呼び出し側に判断させないため。** 書き込みをする全箇所に「そろそろコミットする?」を書かせると、1 箇所忘れただけで肥大化する。**`Unlock` は必ず呼ばれる** ので、そこに置くのが確実だ。
- **未コミットの差分をバッファで読ませるのは、「書いた直後に読む」が実際に起きるから。** `Txn` は同じトランザクション内で読み書きするし、apply の途中で自分の書き込みを読むこともある。「コミットまで見えない」では動かない。
- **並行読み取りにバッファのコピーを渡すのは、ロックを完全に無くすため。** 参照を共有すると、読んでいる間ずっと読み取りロックが要る。**コピーしてしまえば、その後は誰とも同期しなくてよい。** 読み取りの多いワークロードでは、コピー 1 回のコストのほうが安い。
- **コピーをバージョン番号でキャッシュするのは、コミット間隔の中でバッファが変わらないから。** 100 ms の間に来た読み取りは、全部同じコピーを共有できる。**「変わらない期間」があるものは、その期間で共有できる。**
- **キャッシュ更新に楽観的並行制御を使うのは、失敗のコストが小さいから。** 競合しても、自分のコピーは有効なまま使える。捨てるのはキャッシュへの登録だけ。**失敗が「少し無駄をした」で済むなら、ロックを持たずに試すほうが速い。**
- **重複を許すバケットには範囲取得を禁じたのは、正しさを構造で保証するため。** 「呼ぶときに気をつける」ではなく、**間違った使い方が panic する** ようにしてある。マージの重複除去を全経路に入れるより安く、確実だ。
- **`used` を別に持ってスライスを再利用するのは、バッチごとに割り当てが起きるのを避けるため。** 100 ms ごとに数千要素の配列を捨てて作り直すと、GC の負荷になる。**「論理的な長さ」と「確保済みの長さ」を分けるのは、再利用可能なバッファの基本形。**

## どう活かすか

- **永続性の責務を 1 箇所に集約すると、他の層が遅延やバッチを選べるようになる。** 「どの層が耐久性を保証しているか」を明確にすれば、それ以外の層は性能のために自由に振る舞える。逆に、全層が耐久性を気にしている設計は、どこも最適化できない。
- **バッチのしきい値は、必ず「時間」と「量」の両方で持つ。** 片方だけの実装は、低負荷時か高負荷時のどちらかで必ず破綻する。
- **バッチのフラッシュ判定は、必ず通る場所 (ロック解放、リソースの返却) に置く。** 呼び出し側の善意に依存すると、経路が増えたときに漏れる。
- **未コミットの変更を読ませたいなら、書き込み経路と読み取り経路の両方に同じデータを流す。** ストレージ層のトランザクション分離だけに頼ると、「書いた直後に読む」が成立しない。
- **読み取りにスナップショットを渡せるなら、コピーしてロックを消す。** 参照共有 + ロックより、コピー + ロックなしのほうが速い場面は多い。特に「読み取りが長く、書き込みが短い」場合に効く。
- **スナップショットのコピーは、バージョン番号でキャッシュする。** 「前回コピーしてから変更があったか」を単調増加のカウンタで判定できれば、変更のない期間のコピーが全部消える。
- **キャッシュの更新は、楽観的にやって競合したら諦める。** 諦めても自分の作業結果は使えるなら、ロックを持って待つ理由がない。ロックを手放してから重い処理をして、取り直して再確認する形にする。
- **「安全でない使い方」は、実行時に落とす。** 重複しうるデータ源をマージする経路で、除去のコストを払いたくないなら、除去が不要な使い方だけを許して残りを panic にする。制約はドキュメントより panic のほうが伝わる。
- **再利用するバッファは「論理長」と「確保長」を分ける。** リセットを `used = 0` にするだけにできれば、割り当てが定常状態でゼロになる。
- **型では表現できない前提は、メソッド名で表明させて開発ビルドで検証する。** 「このバケットのキーは単調増加」のような前提は、破れても静かに間違った結果になる。宣言と検証をセットにすると、破れた瞬間に分かる。
