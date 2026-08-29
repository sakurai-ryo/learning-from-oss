---
title: "まだディスクにないログを、メモリ側が「書き込み中」まで含めて 3 状態で持つ"
description: "unstable はメモリ上のログ末尾を持つ型だが、単なるバッファではない。「まだ渡していない」「渡したが完了していない」「完了した」の 3 状態を offset と offsetInProgress の 2 つの境界で表し、書き込み中に上書きが起きた場合の境界の巻き戻しまで面倒を見る。Go のスライス式で呼び出し側の破壊を防ぐ小技も含めて読む。"
group: "ライブラリとしての骨格"
sidebar:
  order: 13
---

## 何を学んだか

**非同期な処理に渡したデータは、「渡す前」「渡した後・完了前」「完了後」の 3 状態を持つ。** `etcd-io/raft` の `unstable` 型は、この 3 状態を 1 本のスライスと 2 つの整数境界で表している。境界が 2 つあることで、「同じデータを 2 回渡さない」と「完了するまでメモリから消さない」を同時に満たせる。

さらに、書き込み中に上書きが起きたら **境界を巻き戻す**。この 1 行があるおかげで、[非同期ストレージ書き込み](../async-storage-writes/) の複雑さがこの型の中に閉じている。

## ソースコードのどこか

型の定義とコメントに、役割が 2 つあることが書かれている ([`log_unstable.go#L23-L54`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log_unstable.go#L23-L54))。

```go title="log_unstable.go"
// unstable contains "unstable" log entries and snapshot state that has
// not yet been written to Storage. The type serves two roles. First, it
// holds on to new log entries and an optional snapshot until they are
// handed to a Ready struct for persistence. Second, it continues to
// hold on to this state after it has been handed off to provide raftLog
// with a view of the in-progress log entries and snapshot until their
// writes have been stabilized and are guaranteed to be reflected in
// queries of Storage. After this point, the corresponding log entries
// and/or snapshot can be cleared from unstable.
type unstable struct {
	// the incoming unstable snapshot, if any.
	snapshot *pb.Snapshot
	// all entries that have not yet been written to storage.
	entries []*pb.Entry
	// entries[i] has raft log position i+offset.
	offset uint64

	// if true, snapshot is being written to storage.
	snapshotInProgress bool
	// entries[:offsetInProgress-offset] are being written to storage.
	// Like offset, offsetInProgress is exclusive, meaning that it
	// contains the index following the largest in-progress entry.
	// Invariant: offset <= offsetInProgress
	offsetInProgress uint64

	logger Logger
}
```

2 つの役割 — 「渡すまで持つ」と「完了するまで持ち続ける」— が、`offset` と `offsetInProgress` の 2 境界に対応する。

```
raft ログ全体

  Storage (永続済み)          unstable (メモリ)
├───────────────────────┤├──────────────────────────────┤
                        offset          offsetInProgress
                          │                   │
                          ├───────────────────┤───────────┤
                          │  書き込み中       │ まだ渡して │
                          │  (in progress)    │ いない     │
                          └───────────────────┴───────────┘
```

`offset` より手前は `Storage` にある。`offset` から `offsetInProgress` までは、利用側に渡したが完了通知が来ていない。`offsetInProgress` から先は、まだ `Ready` に載せていない。

## 3 状態の遷移

**渡していない → 渡した**。`Ready` を組み立てるとき、`nextEntries` が「まだ渡していない」分だけを返す ([`log_unstable.go#L98-L108`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log_unstable.go#L98-L108))。

```go title="log_unstable.go"
// nextEntries returns the unstable entries that are not already in the process
// of being written to storage.
func (u *unstable) nextEntries() []*pb.Entry {
	inProgress := int(u.offsetInProgress - u.offset)
	if len(u.entries) == inProgress {
		return nil
	}
	return u.entries[inProgress:]
}
```

そして `acceptReady` の中で境界が進む ([`log_unstable.go#L118-L132`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log_unstable.go#L118-L132))。

```go title="log_unstable.go"
// acceptInProgress marks all entries and the snapshot, if any, in the unstable
// as having begun the process of being written to storage. The entries/snapshot
// will no longer be returned from nextEntries/nextSnapshot. However, new
// entries/snapshots added after a call to acceptInProgress will be returned
// from those methods, until the next call to acceptInProgress.
func (u *unstable) acceptInProgress() {
	if len(u.entries) > 0 {
		// NOTE: +1 because offsetInProgress is exclusive, like offset.
		u.offsetInProgress = u.entries[len(u.entries)-1].GetIndex() + 1
	}
	if u.snapshot != nil {
		u.snapshotInProgress = true
	}
}
```

これがあるので、**同じエントリが 2 つの `Ready` に載ることがない**。同期モードでは `Advance()` まで次の `Ready` が出ないので必要ないが、非同期モードでは書き込み中に次の `Ready` が出るため必須になる。

**渡した → 完了**。完了通知を受けて `stableTo` が呼ばれる ([`log_unstable.go#L134-L168`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log_unstable.go#L134-L168))。

```go title="log_unstable.go"
func (u *unstable) stableTo(id entryID) {
	gt, ok := u.maybeTerm(id.index)
	if !ok {
		// Unstable entry missing. Ignore.
		u.logger.Infof("entry at index %d missing from unstable log; ignoring", id.index)
		return
	}
	if id.index < u.offset {
		// Index matched unstable snapshot, not unstable entry. Ignore.
		u.logger.Infof("entry at index %d matched unstable snapshot; ignoring", id.index)
		return
	}
	if gt != id.term {
		// Term mismatch between unstable entry and specified entry. Ignore.
		// This is possible if part or all of the unstable log was replaced
		// between that time that a set of entries started to be written to
		// stable storage and when they finished.
		u.logger.Infof("entry at (index,term)=(%d,%d) mismatched with "+
			"entry at (%d,%d) in unstable log; ignoring", id.index, id.term, id.index, gt)
		return
	}
	num := int(id.index + 1 - u.offset)
	u.entries = u.entries[num:]
	u.offset = id.index + 1
	u.offsetInProgress = max(u.offsetInProgress, u.offset)
	u.shrinkEntriesArray()
}
```

**3 つの早期リターンが全部「無視する」** になっている。完了通知が届いた時点で状況が変わっていることがありうるので、そのすべてを「何もしない」で扱う。書き込みは既に終わっているのだから、メモリを解放し損ねる以外の害はない。

3 つ目の「任期が違う」が、非同期化で現れるケースだ。書き込み中に別の任期のエントリで上書きされると、同じインデックスの任期が変わっている。詳しくは [非同期ストレージ書き込みのページ](../async-storage-writes/) で扱う。

## 上書きが起きたときの境界の巻き戻し

いちばん効いているのが `truncateAndAppend` だ ([`log_unstable.go#L191-L211`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log_unstable.go#L191-L211))。

```go title="log_unstable.go"
func (u *unstable) truncateAndAppend(ents []*pb.Entry) {
	fromIndex := ents[0].GetIndex()
	switch {
	case fromIndex == u.offset+uint64(len(u.entries)):
		// fromIndex is the next index in the u.entries, so append directly.
		u.entries = append(u.entries, ents...)
	case fromIndex <= u.offset:
		u.logger.Infof("replace the unstable entries from index %d", fromIndex)
		// The log is being truncated to before our current offset
		// portion, so set the offset and replace the entries.
		u.entries = ents
		u.offset = fromIndex
		u.offsetInProgress = u.offset
	default:
		// Truncate to fromIndex (exclusive), and append the new entries.
		u.logger.Infof("truncate the unstable entries before index %d", fromIndex)
		keep := u.slice(u.offset, fromIndex) // NB: appending to this slice is safe,
		u.entries = append(keep, ents...)    // and will reallocate/copy it
		// Only in-progress entries before fromIndex are still considered to be
		// in-progress.
		u.offsetInProgress = min(u.offsetInProgress, fromIndex)
	}
}
```

3 分岐のうち、後ろ 2 つが `offsetInProgress` を **戻している**。

- 全部置き換わる場合: `offsetInProgress = offset` に戻す。書き込み中だった分は全部無効になったので、新しい内容を最初から渡し直す。
- 途中から置き換わる場合: `min(offsetInProgress, fromIndex)`。`fromIndex` より手前の書き込み中はそのまま、それ以降は渡し直す。

**「渡した」という記録が取り消される** ことになる。これがないと、上書きされた新しいエントリが `nextEntries` から返らず、ディスクに古い内容が残る。

1 行の `min` で済んでいるが、非同期化の難しさの中心がここに集約されている。境界を 2 つ持ったことの見返りが、この 1 行で払える形になっていることだ。

## メモリを持ち続けない工夫

`stableTo` の最後に呼ばれる `shrinkEntriesArray` ([`log_unstable.go#L170-L175`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log_unstable.go#L170-L175))。

```go title="log_unstable.go"
// shrinkEntriesArray discards the underlying array used by the entries slice
// if it isn't being used. This avoids holding references to a bunch of
// potentially large entries that aren't needed anymore. Simply clearing the
// entries wouldn't be safe because clients might still be using them.
func (u *unstable) shrinkEntriesArray() {
	if len(u.entries) == 0 {
		u.entries = nil
	}
}
```

`u.entries = u.entries[num:]` でスライスを縮めても、**元の配列は解放されない**。Go のスライスは基底配列への参照を保つので、先頭を切り落としても後ろから参照が残る限りメモリは残る。長さが 0 になったら `nil` を代入して基底配列への参照を切る。

コメントの後半が重要で、「単に中身をゼロクリアするのは安全でない、利用側がまだ使っているかもしれないから」と書いてある。`Ready` で渡したエントリのスライスは利用側が保持している可能性がある。だからゼロ埋めはせず、参照を手放すだけにとどめる。

## 呼び出し側にスライスを壊させない

もう 1 つ、Go 固有の小技がある ([`log_unstable.go#L213-L230`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log_unstable.go#L213-L230))。

```go title="log_unstable.go"
// slice returns the entries from the unstable log with indexes in the range
// [lo, hi). The entire range must be stored in the unstable log or the method
// will panic. The returned slice can be appended to, but the entries in it must
// not be changed because they are still shared with unstable.
func (u *unstable) slice(lo uint64, hi uint64) []*pb.Entry {
	u.mustCheckOutOfBounds(lo, hi)
	// NB: use the full slice expression to limit what the caller can do with the
	// returned slice. For example, an append will reallocate and copy this slice
	// instead of corrupting the neighbouring u.entries.
	return u.entries[lo-u.offset : hi-u.offset : hi-u.offset]
}
```

`a[lo:hi:hi]` という 3 引数のスライス式で、容量を長さと同じにしている。こうすると、返されたスライスへの `append` は必ず新しい配列を割り当てる。容量を絞らないと、`append` が `u.entries` の隣接領域を書き潰す。

同じ手が `raftLog.slice` にもある ([`log.go#L503-L509`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L503-L509))。

```go title="log.go"
	if lo >= l.unstable.offset {
		ents := limitSize(l.unstable.slice(lo, hi), maxSize)
		// NB: use the full slice expression to protect the unstable slice from
		// appends to the returned ents slice.
		return ents[:len(ents):len(ents)], nil
	}
```

**内部状態を外に渡すとき、書き換えられない形で渡す**。Go には不変スライスがないので、容量を絞ることで擬似的にそれを作っている。

## Storage と unstable をまたぐ読み出し

`raftLog` から見ると、ログは `Storage` と `unstable` の 2 層になっている。読み出しは両方をまたぐことがある ([`log.go#L497-L544`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L497-L544))。

```go title="log.go"
	cut := min(hi, l.unstable.offset)
	ents, err := l.storage.Entries(lo, cut, uint64(maxSize))
	// ...
	if hi <= l.unstable.offset {
		return ents, nil
	}

	// Fast path to check if ents has reached the size limitation. Either the
	// returned slice is shorter than requested (which means the next entry would
	// bring it over the limit), or a single entry reaches the limit.
	if uint64(len(ents)) < cut-lo {
		return ents, nil
	}
	// Slow path computes the actual total size, so that unstable entries are cut
	// optimally before being copied to ents slice.
	size := entsSize(ents)
	if size >= maxSize {
		return ents, nil
	}
```

サイズ上限がある中で 2 層から集めるので、「`Storage` 側でどれだけ食ったか」を数えてから `unstable` 側を切る必要がある。ただしその計算 (`entsSize`) は全エントリを走査するので、避けられるなら避ける。「返ってきた件数が要求より少なければ、上限に達している」という速い判定を先に置いている。

任期の取得にも同じ配慮がある ([`log.go#L379-L385`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L379-L385))。

```go title="log.go"
func (l *raftLog) term(i uint64) (uint64, error) {
	// Check the unstable log first, even before computing the valid term range,
	// which may need to access stable Storage. If we find the entry's term in
	// the unstable log, we know it was in the valid range.
	if t, ok := l.unstable.maybeTerm(i); ok {
		return t, nil
	}
```

メモリ側を先に見る。範囲検査すら後回しにしている — 範囲検査自体が `Storage` を叩きうるからだ。[msgsAfterAppend のページ](../msgs-after-append/) で見た「`MsgStorageAppendResp` を自分宛 `MsgAppResp` より後に処理する」という並び順の注意は、この速い経路を使えるようにするためのものだった。

## なぜそうなっているか

境界を 1 つにすると、次のどちらかになる。

- 渡した時点で `offset` を進める: 完了前にメモリから消えるので、`Storage` にも `unstable` にもない期間ができる。その間に読み出しが来ると破綻する。
- 完了まで `offset` を進めない: 同じエントリが何度も `Ready` に載る。同期モードなら `Advance()` があるので問題ないが、非同期では二重書き込みになる。

2 つ持つと、両方が同時に満たされる。**「所有権の移転」と「参照の保持」を別々に追跡する** ことになっていて、これは非同期 I/O 一般で繰り返し現れる形だ。

そのうえで、上書きという第 3 の事象が入ると、境界の巻き戻しが要る。3 状態のうち「渡した」を取り消せるようにしたのが `truncateAndAppend` の 2 行で、ここが Raft 固有の事情 (ログは上書きされうる) と非同期 I/O の交差点になっている。

## どう活かすか

- **非同期に渡したデータは 3 状態で持つ**。「未送」「送信中」「完了」を境界 2 つで表す。完了通知が来るまで元データを保持し、通知が来たら解放する。
- **キャンセルや上書きがあるなら、「送信中」を取り消せるようにする**。取り消しは境界を戻すだけで表現できる場合が多い。取り消しのたびにデータ構造を作り直す設計は、そこがバグの温床になる。
- **完了通知は冪等かつ寛容に扱う**。`stableTo` の 3 つの早期リターンのように、「状況が変わっていたら何もしない」で済ませられるなら、そうする。エラーにすると、呼び出し側に競合の処理を押し付けることになる。
- **Go でスライスを外に渡すときは容量を絞る**。`a[lo:hi:hi]` は、不変性を型で表せない言語での次善策として使える。
- **切り落としただけではメモリは解放されない**。長さ 0 になったら `nil` を代入する。逆に、利用側が参照している可能性があるならゼロ埋めはしない。
