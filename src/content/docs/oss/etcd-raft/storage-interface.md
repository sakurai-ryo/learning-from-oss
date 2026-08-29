---
title: "ログの読み出しをインターフェース 1 枚に切り出し、圧縮の判断は呼び出し側に残す"
description: "Storage は読み出し 6 メソッドだけのインターフェースで、書き込みメソッドが 1 つもない。書くのは Ready 経由、読むのは Storage 経由という非対称な境界。返すエラーの種類が「一時的か恒久的か」の区別として使われていること、そして参照実装の MemoryStorage が Compact をインターフェースの外に置いている理由を読む。"
group: "ライブラリとしての骨格"
sidebar:
  order: 14
---

## 何を学んだか

**書き込みと読み出しで、境界の形を変えている。** `etcd-io/raft` の `Storage` インターフェースには **読み出しメソッドしかない**。書き込みは `Ready` に載せて利用側に渡し、実行してもらう。読み出しはインターフェース経由でライブラリが能動的に呼ぶ。

そして、そのインターフェースが返すエラーは、単なる失敗ではなく **プロトコルの一部** になっている。「圧縮済み」「まだ無い」「一時的に用意できない」がそれぞれ別のエラー値で、ライブラリはそれぞれに別の振る舞いをする。

## ソースコードのどこか

インターフェースは 6 メソッドだけだ ([`storage.go#L42-L96`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L42-L96))。

```go title="storage.go"
// Storage is an interface that may be implemented by the application
// to retrieve log entries from storage.
//
// If any Storage method returns an error, the raft instance will
// become inoperable and refuse to participate in elections; the
// application is responsible for cleanup and recovery in this case.
type Storage interface {
	// TODO(tbg): split this into two interfaces, LogStorage and StateStorage.

	InitialState() (*pb.HardState, *pb.ConfState, error)
	Entries(lo, hi, maxSize uint64) ([]*pb.Entry, error)
	Term(i uint64) (uint64, error)
	LastIndex() (uint64, error)
	FirstIndex() (uint64, error)
	Snapshot() (*pb.Snapshot, error)
}
```

冒頭の説明が「ログエントリを **取得する** ために実装される」となっていて、書き込みには触れていない。実際、`Append` も `SetHardState` も、このインターフェースには無い。

書き込みは [Ready ループ](../ready-loop/) 経由だ。ライブラリは「これを書け」と言うだけで、どう書かれたかを知らない。読み出しだけがインターフェース越しの呼び出しになる。

この非対称は理にかなっている。書き込みは **順序と耐久性の制約** が本質なので、利用側の裁量に任せたい (並列化、バッチ化、`fsync` の粒度)。読み出しは **必要になった瞬間に必要なものだけ** 欲しいので、能動的に呼びたい。要求の性質が違うから、境界の形も違う。

## エラーがプロトコルになっている

`Storage` が返しうるエラーは 4 種類ある ([`storage.go#L28-L41`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L28-L41))。

```go title="storage.go"
// ErrCompacted is returned by Storage.Entries/Compact when a requested
// index is unavailable because it predates the last snapshot.
var ErrCompacted = errors.New("requested index is unavailable due to compaction")

// ErrSnapOutOfDate is returned by Storage.CreateSnapshot when a requested
// index is older than the existing snapshot.
var ErrSnapOutOfDate = errors.New("requested index is older than the existing snapshot")

// ErrUnavailable is returned by Storage interface when the requested log entries
// are unavailable.
var ErrUnavailable = errors.New("requested entry at index is unavailable")

// ErrSnapshotTemporarilyUnavailable is returned by the Storage interface when the required
// snapshot is temporarily unavailable.
var ErrSnapshotTemporarilyUnavailable = errors.New("snapshot is temporarily unavailable")
```

それぞれに対するライブラリの反応が違う。

| エラー                              | 意味                         | ライブラリの反応                         |
| ----------------------------------- | ---------------------------- | ---------------------------------------- |
| `ErrCompacted`                      | 圧縮済みで永久に無い         | スナップショット送信に切り替える         |
| `ErrUnavailable`                    | まだ無い (末尾より先)        | 送るものがないとして扱う                 |
| `ErrSnapshotTemporarilyUnavailable` | 今は用意できないが後でできる | 何もせず、次の機会に再試行               |
| `ErrSnapOutOfDate`                  | 要求が古すぎる               | (利用側が受け取る。ライブラリは呼ばない) |

`ErrCompacted` の扱いが分かりやすい ([`raft.go#L622-L630`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L622-L630))。

```go title="raft.go"
	prevTerm, err := r.raftLog.term(prevIndex)
	if err != nil {
		// The log probably got truncated at >= pr.Next, so we can't catch up the
		// follower log anymore. Send a snapshot instead.
		return r.maybeSendSnapshot(to, pr)
	}
```

「読めなかった」が「スナップショットを送るべきだ」という判断に直結する。エラーが制御フローの分岐条件になっている。

`ErrSnapshotTemporarilyUnavailable` は「今は無理」を表す ([`raft.go#L672-L680`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L672-L680))。

```go title="raft.go"
	snapshot, err := r.raftLog.snapshot()
	if err != nil {
		if err == ErrSnapshotTemporarilyUnavailable {
			r.logger.Debugf("%x failed to send snapshot to %x because snapshot is temporarily unavailable", r.id, to)
			return false
		}
		panic(err) // TODO(bdarnell)
	}
```

**このエラーだけを許し、他は panic する**。スナップショットの生成には時間がかかるので、非同期に作れるようにしたい。そのための「後で聞いてくれ」という語彙が用意されている。

一方、想定外のエラーは panic だ。これが冒頭のコメント「エラーを返すと raft インスタンスは動作不能になる」の意味になる。**「エラーを返せば適当に対処してくれる」ではなく、「想定内のエラー以外は致命的」** という契約になっている。

`log.go` にも同じ切り分けがある ([`log.go#L394-L412`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L394-L412))。

```go title="log.go"
	t, err := l.storage.Term(i)
	if err == nil {
		return t, nil
	}
	if err == ErrCompacted || err == ErrUnavailable {
		return 0, err
	}
	panic(err) // TODO(bdarnell)
```

想定内の 2 つは呼び出し元に返し、それ以外は落とす。この形が `log.go` 内に何度も出てくる。

`slice` ではさらに細かい ([`log.go#L512-L519`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/log.go#L512-L519))。

```go title="log.go"
	ents, err := l.storage.Entries(lo, cut, uint64(maxSize))
	if err == ErrCompacted {
		return nil, err
	} else if err == ErrUnavailable {
		l.logger.Panicf("entries[%d:%d) is unavailable from storage", lo, cut)
	} else if err != nil {
		panic(err)
	}
```

**同じ `ErrUnavailable` が、文脈によって「許容」にも「panic」にもなる**。`term()` では許すが、`slice()` では落とす。範囲検査を通った後に「無い」と言われるのは矛盾だからだ。エラーの許容範囲が、呼び出し地点ごとに絞られている。

## maxSize の「最低 1 件」規則

`Entries` の契約に、細かいが重要な条件がある。

```go title="storage.go"
	// Entries returns a slice of consecutive log entries in the range [lo, hi),
	// starting from lo. The maxSize limits the total size of the log entries
	// returned, but Entries returns at least one entry if any.
```

サイズ上限を超えていても、**1 件はかならず返す**。これがないと、1 件のエントリが上限より大きいときに永久に 0 件が返り、複製が進まなくなる。

同じ規則がライブラリ内の `limitSize` にもある ([`util.go#L286-L302`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/util.go#L286-L302))。

```go title="util.go"
func limitSize(ents []*pb.Entry, maxSize entryEncodingSize) []*pb.Entry {
	if len(ents) == 0 {
		return ents
	}
	size := ents[0].Size()
	for limit := 1; limit < len(ents); limit++ {
		size += ents[limit].Size()
		if entryEncodingSize(size) > maxSize {
			return ents[:limit]
		}
	}
	return ents
}
```

ループが `limit := 1` から始まっている。1 件目のサイズは検査せずに必ず含める。**上限は「進めなくなる」ことより優先しない** という判断が、ループの初期値 1 つで表現されている。

`MaxInflightBytes` の設定にも同じ性質のコメントがある ([`tracker/inflights.go#L43-L46`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/inflights.go#L43-L46))。

```go title="tracker/inflights.go"
// NewInflights sets up an Inflights that allows up to size inflight messages,
// with the total byte size up to maxBytes. If maxBytes is 0 then there is no
// byte size limit. The maxBytes limit is soft, i.e. we accept a single message
// that brings it from size < maxBytes to size >= maxBytes.
```

「ソフトな上限」— 超えることを許す。流量制御の上限を厳格にすると、デッドロックが生まれやすい。

## 返したスライスを守る責任

`Entries` の契約でもう 1 つ長いのが、所有権の話だ。

```go title="storage.go"
	// The caller of Entries owns the returned slice, and may append to it. The
	// individual entries in the slice must not be mutated, neither by the Storage
	// implementation nor the caller. Note that raft may forward these entries
	// back to the application via Ready struct, so the corresponding handler must
	// not mutate entries either (see comments in Ready struct).
	//
	// Since the caller may append to the returned slice, Storage implementation
	// must protect its state from corruption that such appends may cause. For
	// example, common ways to do so are:
	//  - allocate the slice before returning it (safest option),
	//  - return a slice protected by Go full slice expression, which causes
	//  copying on appends (see MemoryStorage).
```

スライス **は** 呼び出し側のもので `append` してよいが、**中のエントリ** は共有物なので書き換えてはいけない。そして「`append` されても壊れないようにするのは実装側の責任だ」と明記し、その方法を 2 つ挙げている。

参照実装がその 2 つ目を採っている ([`storage.go#L162-L167`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L162-L167))。

```go title="storage.go"
	ents := limitSize(ms.ents[lo-offset:hi-offset], entryEncodingSize(maxSize))
	// NB: use the full slice expression to limit what the caller can do with the
	// returned slice. For example, an append will reallocate and copy this slice
	// instead of corrupting the neighbouring ms.ents.
	return ents[:len(ents):len(ents)], nil
```

[unstable のページ](../unstable-log/) で見たのと同じ 3 引数スライス式だ。**同じ問題に同じ手が繰り返し適用されている**。

## 圧縮はインターフェースの外にある

`MemoryStorage` には `Append` / `SetHardState` / `ApplySnapshot` / `CreateSnapshot` / `Compact` があるが、**どれも `Storage` インターフェースには含まれない** ([`storage.go#L218-L320`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L218-L320))。

利用側が呼ぶものだからだ。ライブラリは呼ばない。

```
利用側 ──── Append / Compact / CreateSnapshot ────► Storage 実装
   │                                                    ▲
   │                                                    │
   └── Ready を受けて書く                    Entries / Term / Snapshot
                                                        │
                                              etcd-io/raft (読むだけ)
```

**いつ圧縮するかはライブラリの関心事ではない**。ログを何件残すか、スナップショットをいつ作るか、ディスク容量とのトレードオフをどう取るかは、アプリケーションの事情で決まる。ライブラリが圧縮を握ると、その事情を設定項目として吸い上げることになり、境界が太る。

代わりに、圧縮された結果への対処だけを持っている。それが `ErrCompacted` とスナップショット送信への切り替えだった。

## 圧縮の 1 手前を残す

[スナップショットのページ](../snapshot/) でも触れたが、`Term` の契約に例外が 1 つある。

```go title="storage.go"
	// Term returns the term of entry i, which must be in the range
	// [FirstIndex()-1, LastIndex()]. The term of the entry before
	// FirstIndex is retained for matching purposes even though the
	// rest of that entry may not be available.
	Term(i uint64) (uint64, error)
```

`FirstIndex()-1` の任期だけは、エントリ本体が消えていても引ける。[ログマッチング](../log-replication/) の一致検査に使うためだ。

`MemoryStorage` はこれをダミーエントリで実現している ([`storage.go#L119-L127`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L119-L127))。

```go title="storage.go"
func NewMemoryStorage() *MemoryStorage {
	ms := &MemoryStorage{
		// When starting from scratch populate the list with a dummy entry at term zero.
		ents: []*pb.Entry{{}},
	}
```

`ents[0]` は常にダミーで、圧縮後は「圧縮された最後のエントリ」のインデックスと任期を持つ。だから `FirstIndex()` は `ents[0].Index + 1` になる。

```go title="storage.go"
func (ms *MemoryStorage) firstIndex() uint64 {
	return ms.ents[0].GetIndex() + 1
}
```

番兵を 1 つ置くことで、境界の特別扱いが消えている。`Term(i)` の実装も、`i < offset` かどうかを見るだけで済む。

## 呼び出し回数を数えている

参照実装には、テスト用の仕掛けもある ([`storage.go#L98-L102`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/storage.go#L98-L102))。

```go title="storage.go"
type inMemStorageCallStats struct {
	initialState, firstIndex, lastIndex, entries, term, snapshot int
}
```

各メソッドの呼び出し回数を数えている。テストで「この操作で `Storage` を何回叩いたか」を検証できる。[Ready ループのページ](../ready-loop/) で見た「何もないループを安く回す」という要求が、テストで守られる形になっている。

`releasePendingReadIndexMessages` の早期リターンにも同じ動機が見える ([`raft.go#L2127-L2133`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L2127-L2133))。

```go title="raft.go"
	if len(r.pendingReadIndexMessages) == 0 {
		// Fast path for the common case to avoid a call to storage.LastIndex()
		// via committedEntryInCurrentTerm.
		return
	}
```

`Storage` の呼び出しを 1 回減らすために早期リターンを置き、その理由をコメントに書いている。ディスクを叩きうる呼び出しであることが意識されている。

## なぜそうなっているか

インターフェースを読み出しだけに絞ったことで、実装側の自由度が大きい。

- ログを 1 本のファイルに追記するか、複数に分けるか。
- キャッシュを持つか、毎回読むか。
- `Entries` を呼ばれてから読むか、先読みしておくか。

etcd 本体は WAL とスナップショットファイルの上に、メモリキャッシュ (`MemoryStorage`) を重ねた構成を採っている。ライブラリから見れば `Storage` 1 枚だが、その裏の構成は完全に利用側の裁量になる。

`TODO(tbg): split this into two interfaces, LogStorage and StateStorage.` というコメントも残っている。`InitialState` (状態) と `Entries` / `Term` (ログ) は性質が違うので分けたい、という認識だ。まだ分かれていないが、境界をさらに細かくしたいという方向性は示されている。

## どう活かすか

- **読み出しと書き込みで境界の形を変える**。書き込みは「やることのリスト」として渡し、読み出しはインターフェース越しに能動的に呼ぶ。要求の性質が違うなら、対称にする必要はない。
- **エラー値をプロトコルとして設計する**。「一時的に不可」「恒久的に不可」「範囲外」を別の値にすると、呼び出し側が別の振る舞いを選べる。単一の `error` で返して文字列を見る設計より、はるかに扱いやすい。
- **想定外のエラーは落とす**。想定内のエラーだけを列挙して返し、それ以外は panic する。「なんとなく続行」は、どこで壊れたか分からない状態を作る。
- **上限は進捗より優先しない**。サイズ上限を実装するときは「最低 1 件は返す」を必ず入れる。厳格な上限は、単体で上限を超える要素があったときにデッドロックする。
- **番兵で境界の特別扱いを消す**。圧縮済みログの先頭にダミーを 1 つ置くだけで、「圧縮された 1 つ手前」への参照が普通のアクセスになる。
