---
title: "レプリカ同士でハッシュを突き合わせ、多数派から外れたノードを名指しして書き込みを止める"
description: "複製したはずのデータがノード間でずれても、通常は誰も気づかない。etcd は同じリビジョン時点のハッシュをピアと突き合わせ、食い違いを検出したらアラームを合意ログに書き込んで、そのノードの書き込みを拒否する。多数派が特定できない場合は「クラスタ全体」を対象にする、という判断まで含めて設計されている。"
sidebar:
  order: 14
---

## 何を学んだか

### どんな状況の話か

Raft は「全ノードが同じログを同じ順序で適用する」ことを保証する。だから理論上、全ノードのデータは一致する。

**しかし現実には、ずれる。**

- ディスクのビット反転や、ファイルシステムのバグ。
- etcd 自身のバグ。実際、[robustness テストの記録](../robustness-testing/) には「クラッシュでリビジョンが不整合になる」種類のバグが何件も並んでいる。
- 適用の非決定性。同じログから違う状態が生まれる実装ミス。

厄介なのは、**ずれても誰も気づかない** ことだ。

- 読み取りは、どのノードに当たったかで違う値を返す。しかしクライアントには区別がつかない。
- 書き込みは通り続ける。ずれたまま新しいデータが積まれる。
- 発覚するのは、たいてい数日後に「なぜかデータが消えている」という形になる。

**気づいたときには、どのノードが正しいかも分からなくなっている。**

### etcd の答え

1. **KV データのハッシュを計算できるようにする。** 「リビジョン N 時点までのデータ」のハッシュ。
2. **起動時に、ピアとハッシュを突き合わせる。** 食い違ったら、トラフィックを受ける前に起動を止める。
3. **定期的に、リーダーがピアのハッシュを集めて突き合わせる。**
4. **圧縮のたびに計算されたハッシュを保存しておき、それも突き合わせる。** 圧縮は全ノードが同じリビジョンで行うので、比較しやすい。
5. **食い違いを検出したら、アラームを Raft の合意ログに書く。** 全ノードが「あのノードは壊れている」を知る。
6. **アラームが立ったノードでは、適用層を差し替えてすべてのリクエストを拒否する。**
7. **多数派が特定できたら、外れたノードを名指しする。できなければ、クラスタ全体を対象にする。**

## ソースコードのどこか

### ハッシュの計算

[`server/storage/mvcc/hash.go#L33-L58`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/hash.go#L33-L58)。

```go title="server/storage/mvcc/hash.go"
func unsafeHashByRev(tx backend.UnsafeReader, compactRevision, revision int64, keep map[Revision]struct{}) (KeyValueHash, error) {
	h := newKVHasher(compactRevision, revision, keep)
	err := tx.UnsafeForEach(schema.Key, func(k, v []byte) error {
		h.WriteKeyValue(k, v)
		return nil
	})
	return h.Hash(), err
}

func newKVHasher(compactRev, rev int64, keep map[Revision]struct{}) kvHasher {
	h := crc32.New(crc32.MakeTable(crc32.Castagnoli))
	h.Write(schema.Key.Name())
	// ...
}
```

**KV バケットを全走査して、キーと値をそのまま CRC32 に流し込む。** キーはリビジョンをエンコードしたものなので、走査順序はリビジョン順になり、全ノードで一致する。

`KeyValueHash` は 3 つの値の組になっている ([`#L96-L100`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/hash.go#L96-L100))。

```go title="server/storage/mvcc/hash.go"
type KeyValueHash struct {
	Hash            uint32
	CompactRevision int64
	Revision        int64
}
```

**ハッシュ単体では比較できない。** 「どのリビジョンまでを含み、どこまで圧縮済みか」が同じでなければ、値が違って当然だからだ。**比較の前提条件を、値と一緒に運んでいる。**

### 互換性のための「わざと正しくない」処理

`WriteKeyValue` の中に、目を引くコメントがある ([`#L78-L86`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/hash.go#L78-L86))。

```go title="server/storage/mvcc/hash.go"
	// When performing compaction, if the compacted revision is a
	// tombstone, older versions (<= 3.5.15 or <= 3.4.33) will delete
	// the tombstone. But newer versions (> 3.5.15 or > 3.4.33) won't
	// delete it. So we should skip the tombstone in such cases when
	// computing the hash to ensure that both older and newer versions
	// can always generate the same hash values.
	if kr.Main == h.compactRevision && isTombstone {
		return
	}
```

**バージョンによって残るものが違うキーを、ハッシュの計算から除外している。**

etcd 3.5.15 以前と以後で、圧縮時のトンボストーンの扱いが変わった。片方には残り、片方には残らない。**両方をハッシュに入れると、正常なクラスタで不整合と判定される。**

だから「どちらにも入っている可能性のあるものだけ」を対象にする。[keyIndex のページ](../mvcc-key-index/) で見た `compact` と `keep` の非対称も、同じ理由から来ている。

**整合性検査のハッシュは、正確さより「バージョンをまたいで一致すること」が優先される。** 一致しない検査は、検査として機能しない。

### 計算済みハッシュの保管

[`#L121-L171`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/hash.go#L121-L171)。

```go title="server/storage/mvcc/hash.go"
const (
	hashStorageMaxSize = 10
)

func (s *hashStorage) HashByRev(rev int64) (KeyValueHash, int64, error) {
	s.hashMu.RLock()
	for _, h := range s.hashes {
		if rev == h.Revision {
			// ...
			return h, currentRev, nil
		}
	}
	s.hashMu.RUnlock()

	return s.store.hashByRev(rev)
}

func (s *hashStorage) Store(hash KeyValueHash) {
	// ...
	s.hashes = append(s.hashes, hash)
	sort.Slice(s.hashes, func(i, j int) bool {
		return s.hashes[i].Revision < s.hashes[j].Revision
	})
	if len(s.hashes) > hashStorageMaxSize {
		s.hashes = s.hashes[len(s.hashes)-hashStorageMaxSize:]
	}
}
```

**直近 10 個のハッシュだけを保持する。** 保存されるのは [圧縮のとき](../compaction-batching/) に計算された値で、圧縮はどのノードでも同じリビジョンで起きる。

`HashByRev` は、まずキャッシュを線形探索して、無ければ全走査する。**要素が最大 10 個なので、線形探索で十分。** マップにする必要がない規模だ。

保管しておく意味は大きい。**全走査は数百万件のキーを読むので、頻繁にはできない。** 圧縮のついでに計算した値を取っておけば、突き合わせが安価になる。

### 起動時のチェック

[`server/etcdserver/corrupt.go#L87-L177`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/corrupt.go#L87-L177)。

```go title="server/etcdserver/corrupt.go"
// InitialCheck compares initial hash values with its peers
// before serving any peer/client traffic. Only mismatch when hashes
// are different at requested revision, with same compact revision.
func (cm *corruptionChecker) InitialCheck() error {
```

**「ピアやクライアントのトラフィックを受ける前に」というのが要点。** 壊れたノードがクラスタに参加すると、そのノードから読んだクライアントが誤ったデータを見る。**参加する前に止めるのが、最も被害の小さい対処になる。**

判定条件も明示的だ。「圧縮リビジョンが同じで、ハッシュが違うときだけ不整合とみなす」。圧縮リビジョンが違うなら、比較の前提が崩れているので判定できない。

エラーの場合分けが手厚い。

```go title="server/etcdserver/corrupt.go"
			switch {
			case errors.Is(p.err, rpctypes.ErrFutureRev):
				cm.lg.Warn(
					"cannot fetch hash from slow remote peer",
					// ...
			case errors.Is(p.err, rpctypes.ErrCompacted):
				cm.lg.Warn(
					"cannot fetch hash from remote peer; local member is behind",
					// ...
			case errors.Is(p.err, rpctypes.ErrClusterIDMismatch):
				cm.lg.Warn(
					"cluster ID mismatch",
```

**3 つのエラーに、それぞれ違うメッセージが付いている。**

- `ErrFutureRev`: **相手が遅れている。** 相手がまだそのリビジョンに達していない。
- `ErrCompacted`: **自分が遅れている。** 相手はもうそのリビジョンを捨てている。
- `ErrClusterIDMismatch`: **別のクラスタに繋いでいる。** 設定ミス。

**同じ「ハッシュが取れなかった」でも、運用者がやるべきことは全部違う。** メッセージがそれを区別している。そしてどれも `Warn` で、起動は止めない。**「比較できなかった」は「壊れている」ではない。**

### 定期チェックの二段構え

[`#L179-L264`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/corrupt.go#L179-L264)。

```go title="server/etcdserver/corrupt.go"
func (cm *corruptionChecker) PeriodicCheck() error {
	h, _, err := cm.hasher.HashByRev(0)
	if err != nil {
		return err
	}
	peers := cm.hasher.PeerHashByRev(h.Revision)

	ctx, cancel := context.WithTimeout(context.Background(), cm.hasher.ReqTimeout())
	err = cm.hasher.LinearizableReadNotify(ctx)
	cancel()
	if err != nil {
		return err
	}

	h2, rev2, err := cm.hasher.HashByRev(0)
```

**自分のハッシュを 2 回計算している。** ピアに問い合わせる前と後で。

```go title="server/etcdserver/corrupt.go"
	if h2.Hash != h.Hash && h2.Revision == h.Revision && h.CompactRevision == h2.CompactRevision {
		cm.lg.Warn("found hash mismatch", /* ... */)
		mismatch(cm.hasher.MemberID())
	}
```

**「リビジョンも圧縮リビジョンも同じなのに、ハッシュが変わった」** なら、自分自身のデータが計算の途中で壊れたことになる。ピアと比べるまでもない。

**自己検査を、他者との比較のついでに行っている。** 2 回目の計算はどのみち必要 (ピアからの応答を待つ間に状態が進む可能性があるため) なので、比較はほぼタダになる。

ピアとの比較では、3 種類の不整合を見る。

```go title="server/etcdserver/corrupt.go"
		// leader expects follower's latest revision less than or equal to leader's
		if p.resp.Header.Revision > rev2 {
			// ...
		// leader expects follower's latest compact revision less than or equal to leader's
		if p.resp.CompactRevision > h2.CompactRevision {
			// ...
		// follower's compact revision is leader's old one, then hashes must match
		if p.resp.CompactRevision == h.CompactRevision && p.resp.Hash != h.Hash {
```

**最初の 2 つは「フォロワーがリーダーより進んでいる」という、あってはならない状態の検出。** ハッシュを比べる以前の、順序の異常を見ている。

3 つ目が本来の比較で、「圧縮リビジョンが同じなら、ハッシュも同じはず」。

`mismatch` は `alarmed` フラグで **1 回しか発火しない** ようになっている。複数のピアで食い違っても、アラームは 1 回。

### 多数派を探す

[`#L302-L390`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/corrupt.go#L302-L390)。ここが一番読みごたえがある。

```go title="server/etcdserver/corrupt.go"
func (cm *corruptionChecker) checkPeerHashes(leaderHash mvcc.KeyValueHash, peers []*peerHashKVResp) bool {
	leaderID := cm.hasher.MemberID()
	hash2members := map[uint32]types.IDSlice{leaderHash.Hash: {leaderID}}
	// ...
	// All members have the same CompactRevision and Hash.
	if len(hash2members) == 1 {
		return cm.handleConsistentHash(leaderHash, peersChecked, len(peers))
	}

	// Detected hashes mismatch
	// The first step is to figure out the majority with the same hash.
	memberCnt := len(peers) + 1
	quorum := memberCnt/2 + 1
	quorumExist := false
	for k, v := range hash2members {
		if len(v) >= quorum {
			quorumExist = true
			// remove the majority, and we might raise alarms for the left members.
			delete(hash2members, k)
			break
		}
	}
```

**ハッシュ値でノードをグループ分けして、過半数を持つグループを探す。**

- グループが 1 つ → 全員一致。正常。
- 過半数のグループがある → **そのグループが正しい。** それ以外のノードを名指しでアラームする。
- 過半数のグループがない → **誰が正しいか分からない。**

最後のケースの扱いが良い。

```go title="server/etcdserver/corrupt.go"
	if !quorumExist {
		// If quorum doesn't exist, we don't know which members data are
		// corrupted. In such situation, we intentionally set the memberID
		// as 0, it means it affects the whole cluster.
		cm.lg.Error("Detected compaction hash mismatch but cannot identify the corrupted members, so intentionally set the memberID as 0",
			// ...
		)
		cm.hasher.TriggerCorruptAlarm(0)
	}
```

**「誰が壊れているか分からない」を、メンバー ID 0 (= クラスタ全体) として表す。**

3 台のクラスタで 3 つとも違うハッシュなら、どれを信じるべきか決められない。**分からないなら、全体を止める。** 「たぶんリーダーが正しいだろう」で進めると、正しいノードのデータを壊す方向に働く可能性がある。

そして、**過半数が存在する場合もしない場合も、エラーログは必ず出す。**

```go title="server/etcdserver/corrupt.go"
	// Raise alarm for the left members if the quorum is present.
	// But we should always generate error log for debugging.
	for k, v := range hash2members {
		if quorumExist {
			for _, pid := range v {
				cm.hasher.TriggerCorruptAlarm(pid)
			}
		}

		cm.lg.Error("Detected compaction hash mismatch", /* ... */)
	}
```

コメントが方針を明示している。「デバッグのために、常にエラーログを生成すべきだ」。**アラームを上げるかどうかと、記録を残すかどうかは別の判断。**

`quorumExist` をログのフィールドにも入れているので、後から「なぜアラームが上がらなかったか」も追える。

### 圧縮ハッシュの比較は、共通のリビジョンを探す

[`#L266-L295`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/corrupt.go#L266-L295)。

```go title="server/etcdserver/corrupt.go"
// CompactHashCheck is based on the fact that 'compactions' are coordinated
// between raft members and performed at the same revision. For each compacted
// revision there is KV store hash computed and saved for some time.
//
// This method communicates with peers to find a recent common revision across
// members, and raises alarm if 2 or more members at the same compact revision
// have different hashes.
//
// We might miss opportunity to perform the check if the compaction is still
// ongoing on one of the members, or it was unresponsive. In such situation the
// method still passes without raising alarm.
func (cm *corruptionChecker) CompactHashCheck() {
	// ...
	hashes := cm.uncheckedRevisions()
	// Assume that revisions are ordered from largest to smallest
	for i, hash := range hashes {
		peers := cm.hasher.PeerHashByRev(hash.Revision)
		if len(peers) == 0 {
			continue
		}
		if cm.checkPeerHashes(hash, peers) {
			cm.lg.Info("finished compaction hash check", zap.Int("number-of-hashes-checked", i+1))
			return
		}
	}
```

**新しいリビジョンから順に試して、比較できるものが見つかったら終わる。**

「圧縮は全ノードが同じリビジョンで行う」という性質を利用している。だから、保管してある 10 個のハッシュのどれかは、他のノードにもあるはずだ。

**そして、コメントが「見逃す可能性」を明示している。** 圧縮がまだ進行中のノードがあったり、応答がなかったりすると、この検査は何もせずに通る。

**「検査が通った = 正常」ではなく「検査が通った = 不整合を見つけられなかった」** であることが、ドキュメントとして残っている。検査を設計するときに一番書き落とされやすいのがここだ。

### アラームは合意ログを通る

[`#L434-L442`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/corrupt.go#L434-L442)。

```go title="server/etcdserver/corrupt.go"
func (s *EtcdServer) triggerCorruptAlarm(id types.ID) {
	a := &pb.AlarmRequest{
		MemberID: uint64(id),
		Action:   pb.AlarmRequest_ACTIVATE,
		Alarm:    pb.AlarmType_CORRUPT,
	}
	s.GoAttach(func() {
		s.raftRequest(s.ctx, &pb.InternalRaftRequest{Alarm: a})
```

**アラームは、ローカルのフラグではなく Raft の提案になる。**

これによって、

- **全ノードがアラームを知る。** 壊れたノードに繋いでいないクライアントも、状況を把握できる。
- **アラームが永続化される。** 再起動しても消えない。人間が明示的に解除するまで残る。
- **壊れたノード自身も、自分が壊れていることを知る。** 自己申告ではなくクラスタからの通知として。

そして、アラームが立つと **適用層が丸ごと差し替わる** ([`server/etcdserver/apply/corrupt.go#L23-L47`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/apply/corrupt.go#L23-L47))。

```go title="server/etcdserver/apply/corrupt.go"
type applierV3Corrupt struct {
	applierV3
}

func newApplierV3Corrupt(a applierV3) *applierV3Corrupt { return &applierV3Corrupt{a} }

func (a *applierV3Corrupt) Put(_ *pb.PutRequest) (*pb.PutResponse, *traceutil.Trace, error) {
	return nil, nil, errors.ErrCorrupt
}

func (a *applierV3Corrupt) Range(_ *pb.RangeRequest) (*pb.RangeResponse, *traceutil.Trace, error) {
	return nil, nil, errors.ErrCorrupt
}
```

**読み取りも含めて、全部エラーになる。** 壊れたデータを返すくらいなら、エラーを返すほうがよい。

この差し替えの仕組みは [applier の連鎖のページ](../applier-chain/) で扱う。**「壊れている状態」を、if 文ではなく実装の差し替えで表している** ところが読みどころになる。

## なぜそうなっているか

- **ハッシュで突き合わせるのは、全データを送って比べるのが非現実的だから。** 数 GB のデータを比較のたびに転送はできない。**CRC32 なら 4 バイトで済み、ビット反転のような現実的な破損はほぼ確実に検出できる。** 暗号学的強度は要らない (悪意ある改竄を想定していない)。
- **ハッシュに前提条件 (リビジョン、圧縮リビジョン) を添えるのは、比較可能性がそれで決まるから。** 同じ値を比べているつもりで、違う時点を比べていたら意味がない。**ハッシュ単体を渡す API にすると、この間違いが起きる。**
- **バージョン差のあるデータをハッシュから除外するのは、検査が偽陽性を出すと使われなくなるから。** 正常なクラスタでアラームが上がる検査は、運用者に無効化される。**正確さより一致性を優先する。**
- **圧縮のついでにハッシュを計算して保管するのは、全走査が高いから。** 圧縮は定期的に起きて、全キーを走査する。**そこに相乗りすれば、検査のための追加の走査が要らない。**
- **起動時のチェックを、トラフィックを受ける前に置くのは、被害を最小にするため。** 壊れたノードが読み取りに答えると、その時点で誤ったデータがクライアントに渡る。**参加させないのが最も安い。**
- **「比較できなかった」と「不整合」を区別するのは、対処が違うから。** ピアが遅れている、自分が遅れている、別のクラスタに繋いでいる。どれもハッシュは取れないが、運用者がやるべきことは全部違う。**エラーの分類が、そのままログメッセージの分類になっている。**
- **多数派を探すのは、「どれが正しいか」を決める必要があるから。** 不整合の検出だけなら「食い違っている」で終わるが、対処するには誰を隔離するかを決めなければならない。**過半数を正とするのは、Raft と同じ前提に立っている。**
- **多数派が無いときにクラスタ全体を止めるのは、誤った隔離が事態を悪化させるから。** 3 台とも違うハッシュなら、どれが正しいか分からない。**分からないまま 2 台を隔離すると、正しいデータを持つノードを失う可能性がある。** 全体を止めて人間に委ねるほうが安全だ。
- **アラームを合意ログに書くのは、それがクラスタ全体の状態だから。** ローカルのフラグだと、壊れたノードに繋いでいないクライアントは何も知らない。**永続化され、全員が知り、人間が明示的に解除するまで残る。**
- **アラーム時に全リクエストを拒否するのは、壊れたデータを返さないため。** 「読み取りだけ許す」という選択肢もありうるが、読み取りの結果が壊れているなら意味がない。**動き続けることより、間違った答えを返さないことが優先される。**

## どう活かすか

- **複製したデータは、定期的に突き合わせる。** 「複製の仕組みが正しいから一致するはず」は、ハードウェアの故障や自分のバグの前では成り立たない。**検証しない不変条件は、いつか静かに破れている。**
- **比較にはハッシュを使い、比較の前提条件を値に添える。** 「どの時点のデータか」「どこまで削除済みか」が違えば、ハッシュが違って当然だ。前提を添えない API は、誤った比較を招く。
- **重い検証は、既に走っている処理に相乗りさせる。** 全走査が必要な検証は、単独では頻繁に走らせられない。圧縮・バックアップ・再構築のような既存の全走査に混ぜると、追加コストがほぼゼロになる。
- **検証結果が偽陽性を出すくらいなら、対象を狭める。** バージョン差、実装差、タイミング差で値が変わりうる部分は、検証から外す。**誤検知の多い検査は無効化されて、結局何も守らなくなる。**
- **「検証できなかった」と「異常だった」を区別する。** 前者はリトライや設定の見直し、後者は隔離。同じ「失敗」として扱うと、運用者が正しい対処を選べない。ログメッセージのレベルで分ける。
- **異常を検出したら、「誰が異常か」まで決める。** 検出だけでは対処できない。多数決、基準ノード、外部の真実など、正を決める方法を先に用意しておく。
- **正を決められない場合の振る舞いを、明示的に設計する。** 「たぶんこれが正しい」で進むと、正しいものを壊す可能性がある。**判断できないなら止めて人間に渡す**、という選択肢を最初から持っておく。
- **異常状態は、ローカルのフラグではなくクラスタの状態として共有する。** 全メンバーが知り、永続化され、明示的に解除するまで残る形にする。自動で消える異常フラグは、根本原因の調査を妨げる。
- **異常時の振る舞いは、条件分岐ではなく実装の差し替えで表す。** 各メソッドに `if corrupted` を足すと、追加のときに漏れる。**インターフェース全体を「常にエラーを返す実装」に置き換える** ほうが確実で、読みやすい。
- **検査の限界をコメントに書く。** 「この条件では検査をスキップして、アラームを上げずに通る」を書いておかないと、「検査が通った = 正常」と誤解される。検査の設計で最も書き落とされやすい部分になる。
