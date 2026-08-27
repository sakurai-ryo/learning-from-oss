---
title: "巨大な一括削除を、意図と完了を別々に記録しながら小分けに進める"
description: "MVCC の圧縮は、数百万件のキーを消す操作になりうる。etcd はこれを 1000 件ずつのバッチに切り、各バッチの後に 10 ms 眠って他の処理に譲る。さらに「圧縮する予定のリビジョン」と「圧縮が終わったリビジョン」を別々に永続化することで、途中でクラッシュしても再起動後に続きから再開できる。"
sidebar:
  order: 8
---

## 何を学んだか

### どんな状況の話か

[keyIndex のページ](../mvcc-key-index/) で見たとおり、etcd は上書きをしない。古いバージョンは全部残る。それを刈り取るのが **MVCC の圧縮 (compaction)** で、`etcdctl compact 12345` のように「このリビジョンより前を捨てろ」と指示する。

問題は規模だ。1 週間ぶんの履歴を溜めた etcd で圧縮を走らせると、**数百万件のキーを bbolt から削除する** ことになる。

素直に書くとこうなる。

```go
tx.Lock()
for _, rev := range 消すべきリビジョン {
    tx.UnsafeDelete(bucket, rev)
}
tx.Unlock()
```

これは 3 つの意味で駄目だ。

- **その間、書き込みが全部止まる。** [backend のページ](../backend-batch-tx/) のとおり、bbolt の書き込みトランザクションは 1 本しかない。圧縮が握っている間、apply が進まない。
- **1 個のトランザクションが巨大になる。** bbolt はコピーオンライトなので、削除もページの書き換えを生む。数百万件ぶんが 1 トランザクションに入ると、メモリもディスクも跳ねる。
- **途中で落ちたら、全部やり直し。** しかも「どこまで消したか」の記録がない。

### etcd の答え

1. **圧縮を非同期のジョブとしてスケジュールする。** リクエストはジョブを積んで即座に返る。
2. **削除を 1000 件ずつのバッチに切る。**
3. **各バッチの後にトランザクションを手放し、強制コミットして、10 ms 眠る。**
4. **「圧縮する予定のリビジョン」を、圧縮を始める前に永続化する。**
5. **「圧縮が終わったリビジョン」を、最後のバッチと同じトランザクションで永続化する。**
6. **起動時に 2 つを比べ、食い違っていたら続きから再開する。**
7. **ついでに、圧縮しながら整合性検査用のハッシュを計算する。**

**「意図」と「完了」を別々の永続的な値として持つ** ことが、中断・再開を可能にしている。

## ソースコードのどこか

### まず意図を書く

[`server/storage/mvcc/kvstore.go#L197-L222`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/kvstore.go#L197-L222)。

```go title="server/storage/mvcc/kvstore.go"
func (s *store) updateCompactRev(rev int64) (<-chan struct{}, int64, error) {
	s.revMu.Lock()
	if rev <= s.compactMainRev {
		ch := make(chan struct{})
		f := schedule.NewJob("kvstore_updateCompactRev_compactBarrier", func(ctx context.Context) { s.compactBarrier(ctx, ch) })
		s.fifoSched.Schedule(f)
		s.revMu.Unlock()
		return ch, 0, ErrCompacted
	}
	if rev > s.currentRev {
		s.revMu.Unlock()
		return nil, 0, ErrFutureRev
	}
	compactMainRev := s.compactMainRev
	s.compactMainRev = rev

	SetScheduledCompact(s.b.BatchTx(), rev)
	// ensure that desired compaction is persisted
	// gofail: var compactBeforeCommitScheduledCompact struct{}
	s.b.ForceCommit()
	// gofail: var compactAfterCommitScheduledCompact struct{}

	s.revMu.Unlock()

	return nil, compactMainRev, nil
}
```

**`SetScheduledCompact` の直後に `ForceCommit` している。** 通常の書き込みはバッチにまとめてよいが、ここだけは即座にディスクへ落とす。

コメントが理由を書いている。「望まれた圧縮が永続化されることを保証する」。**この値が残っていないと、クラッシュ後に「圧縮する約束をした」ことが失われる。**

etcd が圧縮の完了をクライアントに返した後で落ちて、再起動したら圧縮されていなかった、という状態は避けなければならない。**圧縮済みリビジョンは、クラスタ全体で一致していなければならない値** だからだ。

### バッチに切って、譲る

[`server/storage/mvcc/kvstore_compaction.go#L28-L100`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/kvstore_compaction.go#L28-L100)。ループの骨格はこうなっている。

```go title="server/storage/mvcc/kvstore_compaction.go"
	batchNum := s.cfg.CompactionBatchLimit
	h := newKVHasher(prevCompactRev, compactMainRev, keep)
	last := make([]byte, 8+1+8)
	for {
		var rev Revision

		start := time.Now()

		tx := s.b.BatchTx()
		tx.LockOutsideApply()
		// gofail: var compactAfterAcquiredBatchTxLock struct{}
		keys, values := tx.UnsafeRange(schema.Key, last, end, int64(batchNum))
		for i := range keys {
			rev = BytesToRev(keys[i])
			if _, ok := keep[rev]; !ok {
				tx.UnsafeDelete(schema.Key, keys[i])
				keyCompactions++
			}
			h.WriteKeyValue(keys[i], values[i])
		}
```

**`last` から `end` までを 1000 件だけ取って処理する。** `keep` は [keyIndex の圧縮](../mvcc-key-index/) が作った「残すリビジョンの集合」で、それに含まれないものを消す。

バッチの終わり。

```go title="server/storage/mvcc/kvstore_compaction.go"
		tx.Unlock()
		// update last
		last = RevToBytes(Revision{Main: rev.Main, Sub: rev.Sub + 1}, last)
		// Immediately commit the compaction deletes instead of letting them accumulate in the write buffer
		// gofail: var compactBeforeCommitBatch struct{}
		s.b.ForceCommit()
		// gofail: var compactAfterCommitBatch struct{}
		dbCompactionPauseMs.Observe(float64(time.Since(start) / time.Millisecond))

		select {
		case <-time.After(s.cfg.CompactionSleepInterval):
		case <-s.stopc:
			return KeyValueHash{}, fmt.Errorf("interrupted due to stop signal")
		}
	}
```

**3 つのことをやっている。**

1. **`last` を「最後に見たリビジョンの次」に進める。** `Sub + 1` にすることで、同じリビジョンを二度見ない。次のバッチの開始位置になる。
2. **`ForceCommit` で即座にコミットする。** コメントが理由を明示している。「削除を書き込みバッファに溜めさせるのではなく、すぐコミットする」。溜めると、[書き込みバッファ](../backend-batch-tx/) が数百万件ぶんに膨らんでメモリを食う。
3. **10 ms 眠る。** これがこのループの主役だ。

**`time.After` で眠ることによって、bbolt の書き込みトランザクションが完全に解放される時間ができる。** 圧縮が 1 秒間ロックを握り続けるのではなく、「10 ms 動いて 10 ms 休む」を繰り返す。休んでいる間に apply が進める。

デフォルト値 ([`server/storage/mvcc/kvstore.go#L43-L47`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/kvstore.go#L43-L47))。

```go title="server/storage/mvcc/kvstore.go"
	restoreChunkKeys               = 10000 // non-const for testing
	defaultCompactionBatchLimit    = 1000
	defaultCompactionSleepInterval = 10 * time.Millisecond
```

**どちらも設定可能** (`--experimental-compaction-batch-limit` など) で、「圧縮を速く終わらせたい」か「圧縮中のレイテンシを抑えたい」かを運用者が選べる。

`// non-const for testing` というコメントが `restoreChunkKeys` に付いているのも小さな配慮で、**「定数にしたいが、テストが値を変えるので変数にしてある」** ことが明示されている。

### 完了は、最後のバッチと同じトランザクションで書く

```go title="server/storage/mvcc/kvstore_compaction.go"
		if len(keys) < batchNum {
			// gofail: var compactBeforeSetFinishedCompact struct{}
			UnsafeSetFinishedCompact(tx, compactMainRev)
			tx.Unlock()
			dbCompactionPauseMs.Observe(float64(time.Since(start) / time.Millisecond))
			// gofail: var compactAfterSetFinishedCompact struct{}
			hash := h.Hash()
```

**「取れた件数がバッチサイズ未満 = 最後のバッチ」** という判定で、そのときだけ `FinishedCompact` を書く。しかも **`tx.Unlock()` の前** なので、最後の削除と同じトランザクションに入る。

[consistent index のページ](../consistent-index/) と同じ形だ。**進捗の記録を、それが表す作業と同じ原子性の単位に入れる。** 「全部消した」と「消し終わったと記録した」の間でクラッシュできない。

### 起動時に再開する

[`server/storage/mvcc/kvstore.go#L224-L232`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/kvstore.go#L224-L232)。

```go title="server/storage/mvcc/kvstore.go"
// checkPrevCompactionCompleted checks whether the previous scheduled compaction is completed.
func (s *store) checkPrevCompactionCompleted() bool {
	tx := s.b.ReadTx()
	tx.RLock()
	defer tx.RUnlock()
	scheduledCompact, scheduledCompactFound := UnsafeReadScheduledCompact(tx)
	finishedCompact, finishedCompactFound := UnsafeReadFinishedCompact(tx)
	return scheduledCompact == finishedCompact && scheduledCompactFound == finishedCompactFound
}
```

**2 つの値が一致していれば完了、していなければ中断されている。**

そして復元時に再開する ([`#L411-L423`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/kvstore.go#L411-L423))。

```go title="server/storage/mvcc/kvstore.go"
	if scheduledCompact != 0 {
		if _, err := s.compactLockfree(scheduledCompact); err != nil {
			s.lg.Warn("compaction encountered error",
				zap.Int64("scheduled-compact-revision", scheduledCompact),
				zap.Error(err),
			)
		} else {
			s.lg.Info(
				"resume scheduled compaction",
				zap.Int64("scheduled-compact-revision", scheduledCompact),
			)
		}
	}
```

**同じリビジョンで圧縮をやり直す。** 途中まで消えているキーは `keep` に含まれないので、もう一度走査すれば残りが消える。**圧縮が冪等である** ことが、この単純な再開を可能にしている。

### 中断が引き起こしたバグ

再開の仕組みがあっても、中断の瞬間に起きうる状態は他にもある ([`#L375-L385`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/kvstore.go#L375-L385))。

```go title="server/storage/mvcc/kvstore.go"
		// If the latest revision was a tombstone revision and etcd just compacted
		// it, but crashed right before persisting the FinishedCompactRevision,
		// then it would lead to revision decreasing in bbolt db file. In such
		// a scenario, we should adjust the current revision using the scheduled
		// compact revision on bootstrap when etcd gets started again.
		//
		// See https://github.com/etcd-io/etcd/issues/17780#issuecomment-2061900231
		if s.currentRev < scheduledCompact {
			s.currentRev = scheduledCompact
		}
```

**「リビジョンが後退する」という、etcd で最も深刻な種類のバグ** の修正だ。

起動時の `currentRev` は、bbolt に入っている最大のリビジョンから決まる。ところが、最後の書き込みが削除 (トンボストーン) で、その削除が圧縮で消され、`FinishedCompact` を書く前に落ちると、**bbolt の中の最大リビジョンが、圧縮前より小さくなる**。

再起動すると `currentRev` が後退し、**すでに使ったリビジョンをもう一度発行する** ことになる。他のノードとデータがずれる。

修正は「`scheduledCompact` を下限として使う」の 2 行。**issue のコメントへのリンクが貼ってあるので、この 2 行が何を防いでいるかを追える。**

このバグは [robustness テスト](../robustness-testing/) が「圧縮をテスト対象に含めた後」に発見されている。

### 圧縮しながらハッシュを計算する

ループの中に、削除とは無関係に見える 1 行がある。

```go title="server/storage/mvcc/kvstore_compaction.go"
			h.WriteKeyValue(keys[i], values[i])
```

**残すキーだけでなく、全部のキーをハッシュに流し込んでいる** (正確には、`newKVHasher` が `keep` を持っていて、内部で残るものだけを選ぶ)。

これは [整合性検査](../corruption-check/) のためのハッシュで、**「圧縮リビジョン N の時点でのデータのハッシュ」** を計算している。ノード間でこれを比べれば、データがずれていないかが分かる。

圧縮はどのみち全キーを走査する。**そのついでにハッシュを取れば、別に走査する必要がない。** 数百万件の走査を 2 回やらずに済む。

ただし条件がある ([`server/storage/mvcc/kvstore.go#L247-L253`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/kvstore.go#L247-L253))。

```go title="server/storage/mvcc/kvstore.go"
		// Only store the hash value if the previous hash is completed, i.e. this compaction
		// hashes every revision from last compaction. For more details, see #15919.
		if prevCompactionCompleted {
			s.hashes.Store(hash)
		} else {
			s.lg.Info("previous compaction was interrupted, skip storing compaction hash value")
		}
```

**前回の圧縮が中断されていたら、今回のハッシュは保存しない。**

理由は走査範囲にある。中断された圧縮を再開すると、**すでに消えたキーは走査されない**。つまり、そのハッシュは「前回の圧縮リビジョンから今回まで」の全リビジョンを含んでいない。他のノードのハッシュと比べても一致しない。

**「計算はできるが、意味のある値ではない」場合を明示的に捨てている。** 保存してしまうと、正常なクラスタで整合性アラームが上がる。

### 圧縮を起動する側

自動圧縮には 2 つのモードがある。リビジョン数ベース ([`server/etcdserver/api/v3compactor/revision.go#L28-L45`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/v3compactor/revision.go#L28-L45))。

```go title="server/etcdserver/api/v3compactor/revision.go"
// Revision compacts the log by purging revisions older than
// the configured revision number. Compaction happens every 5 minutes.
type Revision struct {
	// ...
	retention int64
```

5 分ごとに「現在のリビジョン - 保持数」で圧縮する。単純だ。

時間ベースのほう ([`server/etcdserver/api/v3compactor/periodic.go#L62-L94`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/api/v3compactor/periodic.go#L62-L94)) は、「1 時間前のリビジョン」を知る必要があるので、少し工夫が要る。

```go title="server/etcdserver/api/v3compactor/periodic.go"
/*
Compaction period 1-hour:
  1. compute compaction period, which is 1-hour
  2. record revisions for every 1/10 of 1-hour (6-minute)
  3. keep recording revisions with no compaction for first 1-hour
  4. do compact with revs[0]
	- success? continue on for-loop and move sliding window; revs = revs[1:]
	- failure? update revs, and retry after 1/10 of 1-hour (6-minute)
*/
```

**保持期間を 10 分割した間隔でリビジョンを記録し、スライディングウィンドウとして持つ。** 配列の先頭が「保持期間ぶん前のリビジョン」になる。

このコメントが 4 つの期間 (1 時間、24 時間、59 分、5 秒) について同じ説明を繰り返しているのが面白い。**具体的な数値を当てはめた例を並べることで、「10 分の 1」が何を意味するかを誤解しようがなくしている。**

```go title="server/etcdserver/api/v3compactor/periodic.go"
		for {
			pc.revs = append(pc.revs, pc.rg.Rev())
			if len(pc.revs) > retentions {
				pc.revs = pc.revs[1:] // pc.revs[0] is always the rev at pc.period ago
			}
```

**コメント `pc.revs[0] is always the rev at pc.period ago` が、この配列の不変条件を 1 行で表している。** 配列の長さを `retentions` (= 10) に保つことで、先頭が常に保持期間ぶん前になる。

失敗したら `revs` を更新して再試行する、という設計も効いている。**圧縮に失敗している間もリビジョンの記録は続くので、次に成功したときには正しい「1 時間前」が使われる。**

## なぜそうなっているか

- **バッチに切って眠るのは、共有資源を長時間占有しないため。** bbolt の書き込みトランザクションは 1 本しかない。**圧縮は「急がない仕事」なので、急ぐ仕事 (apply) に譲るべきだ。** 総所要時間は伸びるが、その間のレイテンシは保たれる。
- **各バッチでコミットするのは、バッファの肥大を防ぐため。** [書き込みバッファ](../backend-batch-tx/) に数百万件の削除が溜まると、メモリを食い、コミット時のスパイクも大きくなる。**小分けにすると、ピークが平らになる。**
- **「予定」を先に永続化するのは、クライアントに約束したことを忘れないため。** 圧縮の成功を返した後にクラッシュしたら、再起動後も圧縮済みでなければならない。**約束と実行の間にクラッシュがありうるなら、約束のほうを先に記録する。**
- **「完了」を最後の削除と同じトランザクションに入れるのは、二重の中断点を作らないため。** 別トランザクションにすると、「全部消したが完了と記録していない」状態ができる。同じトランザクションなら、その状態は存在しない。
- **再開が単純なのは、圧縮が冪等だから。** 「リビジョン N より前を消す」は何度実行しても結果が同じ。**冪等な操作は、途中経過を記録しなくても最初からやり直せる。** 記録が要るのは「やるべきか」だけになる。
- **中断された圧縮のハッシュを捨てるのは、走査範囲が違うから。** 値としては計算できるが、他のノードと比べる意味がない。**「計算できる」と「意味がある」は別の話で、意味がない値を保存すると誤検知の原因になる。**
- **圧縮のついでにハッシュを取るのは、走査が既に起きているから。** 数百万件の走査は高い。同じ走査で 2 つの目的を達成できるなら、そうする。**ただし、そのぶん両者の正しさが結合する** ので、上のような条件分岐が要る。
- **時間ベースの保持をスライディングウィンドウで実装したのは、「N 時間前のリビジョン」を知る手段が他にないから。** リビジョンにタイムスタンプは付いていない。**「定期的に記録して、古いものを先頭に置く」のが、追加のデータを永続化せずに済む方法になる。**

## どう活かすか

- **長時間かかる一括処理は、小分けにして、間に明示的な譲りを入れる。** ロックを握りっぱなしにしないことが目的なので、単に分割するだけでは足りない。**バッチの間でロックを完全に手放し、短時間眠る。** 「速く終わること」より「他を止めないこと」が優先される仕事は多い。
- **バッチサイズと休止時間は、設定可能にする。** 「速く終わらせたい」と「影響を抑えたい」のどちらを取るかは、運用者の状況で変わる。デフォルトは保守的に、変えられるようにしておく。
- **「やる予定」と「やり終えた」を別々の永続的な値として持つ。** 一致していれば完了、していなければ中断。この 2 値だけで、中断・再開が扱えるようになる。カーソルや進捗率を細かく持つより単純で、壊れにくい。
- **「やる予定」は、外部に約束する前に永続化する。** クライアントに成功を返した後で忘れる、が最悪の形になる。逆に「完了」は、それが表す作業と同じトランザクションに入れる。
- **冪等な処理は、途中経過を記録しなくてよい。** 最初からやり直せばよいので、必要なのは「やるべきかどうか」だけ。**処理を冪等に設計できると、再開の仕組みが劇的に簡単になる。**
- **既に走っている走査に、別の計算を相乗りさせる。** ハッシュ、統計、検証。ただし相乗りさせると正しさが結合するので、**「相乗りが成立しない条件」を明示的に判定して、そのときは結果を捨てる。**
- **「計算できたが意味がない」値は、保存しない。** 中途半端な集計値やハッシュを保存すると、後でそれを信じた処理が誤動作する。捨てたことをログに残せば、追える。
- **時系列のウィンドウは、定期サンプリングした配列の先頭で表す。** 「N 時間前の値」を知る必要があるとき、全履歴にタイムスタンプを持たせるより、一定間隔で記録して長さを固定するほうが安い。配列の不変条件を 1 行のコメントで書いておく。
- **修正の根拠が issue にあるなら、リンクを貼る。** 「なぜこの 2 行があるか」が本文中では説明しきれない場合、コード上のリンクが唯一の手がかりになる。
