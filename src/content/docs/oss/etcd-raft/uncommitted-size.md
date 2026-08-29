---
title: "過半数を失ったリーダーのログが無限に伸びないよう、未コミット分をバイト数で止める"
description: "フォロワーが全滅してもリーダーは提案を受け付け続け、ログはメモリ上で伸び続ける。etcd-io/raft は未コミット部分のバイト数を数え、上限を超えたら提案を明示的なエラーで落とす。2 種類のサイズ型を別々に定義していること、空エントリだけは常に通すこと、減算を飽和させることなど、小さな判断が積み上がっている。"
group: "複製と流量制御"
sidebar:
  order: 24
---

## 何を学んだか

**リソースの上限は「増える経路」と「減る経路」の両方を押さえて初めて機能する。** リーダーが過半数を失うと、コミットが進まなくなる。しかし提案は受け付け続けるので、未コミットのログがメモリ上で伸び続ける。最終的に OOM で落ちる。

`etcd-io/raft` はこれを、未コミット部分のバイト数を数えて上限をかけることで防ぐ。実装は 2 つの短い関数だが、そこに含まれる判断が細かい。

- **サイズの数え方を 2 種類定義して型で区別する**。エンコード後のサイズと、ペイロードだけのサイズ。
- **空のエントリは上限に関わらず通す**。通さないと、Raft 自身の動作が止まる。
- **減算を飽和させる**。カウンタが実際より小さいことはあるが、大きいことはない、という不変条件を守る。

## 解いている問題

3 台のクラスタでフォロワー 2 台が落ちたとする。リーダーは残るが、過半数を満たせないのでコミットが進まない。

```
リーダーのログ:
  [1..100 コミット済み][101, 102, 103, ... 未コミット]
                        ↑ ここから先が伸び続ける
```

`Ready` にも載らない (コミットされていないので `CommittedEntries` に入らない) が、`Entries` としてディスクには書かれる。そしてリーダーの `raftLog` はコミット位置を進められないので、メモリ上の参照も残る。

利用側が提案を止めればいいが、利用側は Raft の内部状態を見ていないことが多い。**ライブラリ側で止める** 必要がある。

## ソースコードのどこか

設定は 1 つ ([`raft.go#L200-L204`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L200-L204))。

```go title="raft.go"
	// MaxUncommittedEntriesSize limits the aggregate byte size of the
	// uncommitted entries that may be appended to a leader's log. Once this
	// limit is exceeded, proposals will begin to return ErrProposalDropped
	// errors. Note: 0 for no limit.
	MaxUncommittedEntriesSize uint64
```

カウンタは `raft` 構造体にある ([`raft.go#L366-L370`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L366-L370))。

```go title="raft.go"
	// an estimate of the size of the uncommitted tail of the Raft log. Used to
	// prevent unbounded log growth. Only maintained by the leader. Reset on
	// term changes.
	uncommittedSize entryPayloadSize
```

「見積もり (estimate)」と書かれている。正確な値ではない。「リーダーだけが維持する」「任期変更でリセットされる」という 2 つの性質も明記されている。

### 増やす側

提案がログに追加される直前に検査する ([`raft.go#L2091-L2114`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L2091-L2114))。

```go title="raft.go"
// increaseUncommittedSize computes the size of the proposed entries and
// determines whether they would push leader over its maxUncommittedSize limit.
// If the new entries would exceed the limit, the method returns false. If not,
// the increase in uncommitted entry size is recorded and the method returns
// true.
//
// Empty payloads are never refused. This is used both for appending an empty
// entry at a new leader's term, as well as leaving a joint configuration.
func (r *raft) increaseUncommittedSize(ents []*pb.Entry) bool {
	s := payloadsSize(ents)
	if r.uncommittedSize > 0 && s > 0 && r.uncommittedSize+s > r.maxUncommittedSize {
		// If the uncommitted tail of the Raft log is empty, allow any size
		// proposal. Otherwise, limit the size of the uncommitted tail of the
		// log and drop any proposal that would push the size over the limit.
		// Note the added requirement s>0 which is used to make sure that
		// appending single empty entries to the log always succeeds, used both
		// for replicating a new leader's initial empty entry, and for
		// auto-leaving joint configurations.
		return false
	}
	r.uncommittedSize += s
	return true
}
```

条件が 3 つの `&&` で構成されている。それぞれに意味がある。

**`r.uncommittedSize > 0`**: 未コミットが空なら、どんな大きさの提案でも通す。上限より大きい提案が来たときに、永久に受け付けられなくなるのを防ぐ。[Storage インターフェースのページ](../storage-interface/) で見た「最低 1 件は返す」と同じ判断だ。

**`s > 0`**: **中身が空のエントリは常に通す**。これが重要で、Raft 自身が空エントリを 2 か所で使う。

- 新しいリーダーが任期の先頭に書く空エントリ ([コミット規則のページ](../commit-rule/))。
- joint 構成から自動的に抜けるときの空の構成変更 ([joint consensus のページ](../joint-consensus/))。

どちらもコミットを進めるために必要な操作だ。上限で止めると、**上限に達した状態から抜け出せなくなる**。

`becomeLeader` にこの依存関係のコメントがある ([`raft.go#L965-L968`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L965-L968))。

```go title="raft.go"
	// The payloadSize of an empty entry is 0 (see TestPayloadSizeOfEmptyEntry),
	// so the preceding log append does not count against the uncommitted log
	// quota of the new leader. In other words, after the call to appendEntry,
	// r.uncommittedSize is still 0.
```

テスト名まで挙げて、この性質が保証されていることを示している。`TestPayloadSizeOfEmptyEntry` は「空エントリのペイロードサイズが 0 であること」だけを確認するテストだ。**別の場所の仮定を、テストで固定してから参照している**。

joint からの自動離脱でも同じ配慮がある ([`raft.go#L742-L747`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L742-L747))。

```go title="raft.go"
		// If the current (and most recent, at least for this leader's term)
		// configuration should be auto-left, initiate that now. We use a
		// nil Data which unmarshals into an empty ConfChangeV2 and has the
		// benefit that appendEntry can never refuse it based on its size
		// (which registers as zero).
```

`nil` を使う理由が「サイズが 0 になるので拒否されない」と明示されている。

### 減らす側

コミットされて適用されたときに減らす ([`raft.go#L2116-L2126`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L2116-L2126))。

```go title="raft.go"
// reduceUncommittedSize accounts for the newly committed entries by decreasing
// the uncommitted entry size limit.
func (r *raft) reduceUncommittedSize(s entryPayloadSize) {
	if s > r.uncommittedSize {
		// uncommittedSize may underestimate the size of the uncommitted Raft
		// log tail but will never overestimate it. Saturate at 0 instead of
		// allowing overflow.
		r.uncommittedSize = 0
	} else {
		r.uncommittedSize -= s
	}
}
```

**引きすぎたら 0 で止める**。`uint64` なので、単純に引くと桁溢れして巨大な値になり、以降すべての提案が拒否される。

コメントが不変条件を明示している。「過小評価することはあるが、過大評価することはない」。**どちら向きの誤差なら許容できるか** を決めて、それに合わせて飽和させる。過小評価なら上限を少し超えるだけだが、過大評価すると提案が通らなくなる。

呼び出し箇所は、適用の完了通知だ ([`raft.go#L1204-L1210`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1204-L1210))。

```go title="raft.go"
	case pb.MsgStorageApplyResp:
		if len(m.GetEntries()) > 0 {
			index := m.GetEntries()[len(m.GetEntries())-1].GetIndex()
			r.appliedTo(index, entsSize(m.GetEntries()))
			r.reduceUncommittedSize(payloadsSize(m.GetEntries()))
		}
```

**コミットではなく適用のタイミングで減らしている**。コミットされてもまだ利用側に渡っていないエントリは、メモリ上に残っている。実際にメモリが解放されるのは適用が終わってからなので、そちらに合わせている。

### リセット

任期が変わると 0 に戻る ([`raft.go#L807`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L807))。

```go title="raft.go"
	r.pendingConfIndex = 0
	r.uncommittedSize = 0
	r.readOnly = newReadOnly(r.readOnly.option)
```

リーダーでなくなればこのカウンタは意味を持たない。次にリーダーになったときは、ログの未コミット部分を数え直すのではなく、0 から始める。

これが「見積もり」である理由の 1 つになる。新リーダーのログには前任者の未コミットエントリが残っているかもしれないが、それは数えられていない。正確さより単純さを取っている。

## 2 種類のサイズ

サイズの型が 2 つある ([`util.go#L270-L318`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/util.go#L270-L318))。

```go title="util.go"
// entryEncodingSize represents the protocol buffer encoding size of one or more
// entries.
type entryEncodingSize uint64
```

```go title="util.go"
// entryPayloadSize represents the size of one or more entries' payloads.
// Notably, it does not depend on its Index or Term. Entries with empty
// payloads, like those proposed after a leadership change, are considered
// to be zero size.
type entryPayloadSize uint64

// payloadSize is the size of the payload of the provided entry.
func payloadSize(e *pb.Entry) entryPayloadSize {
	return entryPayloadSize(len(e.GetData()))
}
```

どちらも `uint64` だが、別の型として定義されている。Go の型システムでは、この 2 つを混ぜて計算するとコンパイルエラーになる。

用途が違う。

| 型                  | 何を測るか                        | 何に使うか                                   |
| ------------------- | --------------------------------- | -------------------------------------------- |
| `entryEncodingSize` | protobuf エンコード後の全体サイズ | メッセージのサイズ制限、適用待ちのサイズ制限 |
| `entryPayloadSize`  | `Data` の長さだけ                 | 未コミットサイズの制限                       |

`entryPayloadSize` が `Index` と `Term` を含まない理由は、**空エントリを 0 として扱うため** だ。エンコード後のサイズだと、空エントリでも数バイトになる。それが上限に効いてしまうと、上で見た「空エントリは常に通す」が成立しない。

**測りたいものが違うなら、型を分ける**。同じ `uint64` を混ぜて使うと、どちらの意味の値かが分からなくなる。この 2 つは実際に隣り合うコードで使われている。

```go title="raft.go"
			r.appliedTo(index, entsSize(m.GetEntries()))              // entryEncodingSize
			r.reduceUncommittedSize(payloadsSize(m.GetEntries()))     // entryPayloadSize
```

同じエントリ列から 2 種類のサイズを計算して、それぞれ別のカウンタに渡している。型が違うので取り違えられない。

## 提案の落とし方

上限を超えた提案は、明示的なエラーになる ([`raft.go#L823-L831`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L823-L831))。

```go title="raft.go"
	if !r.increaseUncommittedSize(cloned) {
		r.logger.Warningf(
			"%x appending new entries to log would exceed uncommitted entry size limit; dropping proposal",
			r.id,
		)
		// Drop the proposal.
		return false
	}
```

呼び出し元で `ErrProposalDropped` に変換される ([`raft.go#L1348-L1350`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1348-L1350))。

```go title="raft.go"
		if !r.appendEntry(m.GetEntries()...) {
			return ErrProposalDropped
		}
```

このエラーの定義にコメントがある ([`raft.go#L86-L88`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L86-L88))。

```go title="raft.go"
// ErrProposalDropped is returned when the proposal is ignored by some cases,
// so that the proposer can be notified and fail fast.
var ErrProposalDropped = errors.New("raft proposal dropped")
```

**「速く失敗できるように」**。Raft の提案は元々「失われることがあり、再試行は利用側の責任」という契約になっている ([`node.go#L136-L138`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/node.go#L136-L138))。

```go title="node.go"
	// Propose proposes that data be appended to the log. Note that proposals can be lost without
	// notice, therefore it is user's job to ensure proposal retries.
	Propose(ctx context.Context, data []byte) error
```

黙って捨ててタイムアウトを待たせるより、その場でエラーを返す方が利用側は速く対処できる。背圧 (back pressure) を呼び出し側に伝える経路になっている。

同じエラーが他の場面でも返る — リーダーでないとき、リーダーが不明なとき、リーダー移譲中のとき。**「今は受け付けられない」を 1 つのエラーで表す** ことで、利用側の処理が 1 か所で済む。

## 似た仕組み: 適用待ちのサイズ制限

未コミットサイズとは別に、**適用待ちのサイズ制限** もある ([`raft.go#L194-L199`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L194-L199))。

```go title="raft.go"
	// MaxCommittedSizePerReady limits the size of the committed entries which
	// can be applying at the same time.
	//
	// Despite its name (preserved for compatibility), this quota applies across
	// Ready structs to encompass all outstanding entries in unacknowledged
	// MsgStorageApply messages when AsyncStorageWrites is enabled.
	MaxCommittedSizePerReady uint64
```

名前が実態と合っていないことを認めたうえで、互換性のために変えていない。

こちらは `raftLog` 側で管理される ([`log.go#L332-L365`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L332-L365))。

```go title="log.go"
	// Determine whether to pause entry application until some progress is
	// acknowledged. We pause in two cases:
	// 1. the outstanding entry size equals or exceeds the maximum size.
	// 2. the outstanding entry size does not equal or exceed the maximum size,
	//    but we determine that the next entry in the log will push us over the
	//    limit. We determine this by comparing the last entry returned from
	//    raftLog.nextCommittedEnts to the maximum entry that the method was
	//    allowed to return had there been no size limit. If these indexes are
	//    not equal, then the returned entries slice must have been truncated to
	//    adhere to the memory limit.
	l.applyingEntsPaused = l.applyingEntsSize >= l.maxApplyingEntsSize ||
		i < l.maxAppliableIndex(allowUnstable)
```

2 つ目の条件が面白い。「返したエントリの末尾が、返せたはずの最大位置より手前なら、サイズ制限で切られたということだ」という **間接的な判定** をしている。切られたかどうかを別途フラグで持たず、返り値から導いている。

`appliedTo` 側でも飽和減算が使われている ([`log.go#L340-L346`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L340-L346))。

```go title="log.go"
	if l.applyingEntsSize > size {
		l.applyingEntsSize -= size
	} else {
		// Defense against underflow.
		l.applyingEntsSize = 0
	}
```

同じパターンが 2 か所にある。**符号なし整数のカウンタを持つなら、減算は必ず飽和させる**、という規律になっている。

## どう活かすか

- **無制限に増えうるバッファには上限をかける**。「正常時は増えない」は、異常時に増えないことを意味しない。過半数の喪失、下流の停止、消費側の遅延で、いくらでも溜まる。
- **上限に達した状態から抜け出す経路を確保する**。システム自身が使う制御用のデータは、上限の対象外にする。そうしないと、上限に達したことで回復操作まで止まる。
- **符号なし整数の減算は飽和させる。そして誤差の向きを決める**。「過小評価はするが過大評価はしない」のように、どちら向きの誤差なら安全かをコメントに書く。
- **測る対象が違うならサイズの型を分ける**。`entryEncodingSize` と `entryPayloadSize` のように名前付きの型にすると、混同がコンパイルエラーになる。同じ `uint64` のまま扱うと、隣り合う行で取り違える。
- **「今は受け付けられない」を専用のエラーで返す**。黙って捨ててタイムアウトさせるより、呼び出し側が速く判断できる。背圧を伝える経路として使う。
- **他の場所が依存している性質は、テストで固定して参照する**。「空エントリのサイズは 0」という仮定にテスト名を添えておくと、その仮定が壊れたときに気づける。
