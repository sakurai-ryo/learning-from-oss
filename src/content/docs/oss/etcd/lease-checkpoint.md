---
title: "レプリカ間で共有できない「経過時間」を、合意ログに書けるチェックポイントに変換する"
description: "TTL は時計の話なので、リーダーが替わるたびにリセットされてしまう。etcd は「残り TTL」を定期的に合意ログへ書き込み、新しいリーダーはその値から再開する。書き込み回数を抑えるための「チェックポイント間隔より残りが長いときだけスケジュールする」判定と、リーダー交代時に失効が殺到しないよう期限をずらす処理が読みどころになる。"
sidebar:
  order: 13
---

## 何を学んだか

### どんな状況の話か

lease は TTL 付きのオブジェクトで、キーを複数くくり付けられる ([前提のページ](../architecture/))。TTL が切れると、くくり付けられたキーがまとめて消える。「このプロセスが生きている間だけ存在するキー」を表す道具だ。

問題は、**TTL が時間の概念だ** ということにある。

Raft が複製するのは「操作のログ」であって、時計ではない。`Grant(id, 60)` というエントリを全ノードが受け取るが、**「あと何秒残っているか」は各ノードのローカルな時計でしか分からない**。

そこで etcd は、**失効の判断をリーダー (primary lessor) だけが行う** ことにしている。フォロワーは lease を持っているが、期限を `forever` に設定して、失効させない。

ここで新しい問題が起きる。

**リーダーが替わったら、新しいリーダーは「残り時間」を知らない。**

素朴な実装だと、新リーダーは「TTL の全部が残っている」と仮定するしかない。60 秒の lease が、リーダー交代のたびに 60 秒に戻る。**リーダーが 30 秒ごとに交代すると、その lease は永遠に失効しない。**

### etcd の答え

1. **「残り TTL」を、定期的に Raft の合意ログへ書き込む。** これを **チェックポイント** と呼ぶ。
2. **新しいリーダーは、最後にチェックポイントされた残り TTL から数え直す。**
3. **書き込みを減らすため、「残り TTL がチェックポイント間隔より長い」ときだけスケジュールする。**
4. **KeepAlive で更新されたら、残り TTL を 0 に戻すエントリを 1 個だけ書く。** これで「1 チェックポイント間隔あたり最大 2 エントリ」に抑える。
5. **リーダー昇格時に、期限が集中していたらずらす。** 大量の lease が同時に失効して、削除で詰まるのを避ける。

**「共有できない状態 (経過時間) を、共有できる状態 (残り時間のスナップショット) に変換する」** のがこの設計の要点だ。

## ソースコードのどこか

### primary という概念

[`server/lease/lessor.go#L250-L265`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L250-L265)。

```go title="server/lease/lessor.go"
// isPrimary indicates if this lessor is the primary lessor. The primary
// lessor manages lease expiration and renew.
//
// in etcd, raft leader is the primary. Thus there might be two primary
// leaders at the same time (raft allows concurrent leader but with different term)
// for at most a leader election timeout.
// The old primary leader cannot affect the correctness since its proposal has a
// smaller term and will not be committed.
//
// TODO: raft follower do not forward lease management proposals. There might be a
// very small window (within second normally which depends on go scheduling) that
// a raft follow is the primary between the raft leader demotion and lessor demotion.
// Usually this should not be a problem. Lease should not be that sensitive to timing.
func (le *lessor) isPrimary() bool {
	return le.demotec != nil
}
```

**16 行のうち 13 行がコメントで、そのすべてが「2 人の primary が同時に存在しうる」ことの説明になっている。**

- Raft は「異なる任期の複数のリーダー」を一時的に許す。だから primary も 2 人になりうる。
- **それでも正しさは壊れない。** 古い primary の提案は任期が古いのでコミットされないからだ。
- ただし、raft のリーダー降格と lessor の降格の間にわずかな窓がある。**「通常は問題にならない。lease はそこまで時間に敏感ではない」** と判断されている。

**分散システムで「唯一のリーダー」を仮定しないこと**、そして **仮定が破れる窓の大きさと影響を評価して、許容するかどうかを判断すること**。この 2 つがコメントの形で残っている。

判定そのものは `le.demotec != nil` の 1 行だ。チャネルの有無で状態を表している。

昇格と降格 ([`#L480-L550`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L480-L550))。

```go title="server/lease/lessor.go"
func (le *lessor) Demote() {
	le.mu.Lock()
	defer le.mu.Unlock()

	// set the expiries of all leases to forever
	for _, l := range le.leaseMap {
		l.forever()
	}

	le.clearScheduledLeasesCheckpoints()
	le.clearLeaseExpiredNotifier()

	if le.demotec != nil {
		close(le.demotec)
		le.demotec = nil
	}
}
```

**降格したら、すべての lease の期限を `forever` にする。** これで失効の判定が起きなくなる。

`demotec` を閉じることで、**待っている処理に「もう primary ではない」を一斉に通知** している。[線形化可能読み取りのページ](../linearizable-read-batching/) の `notifier` と同じ、チャネルの close によるブロードキャストだ。

### チェックポイントの書き込み

[`#L367-L383`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L367-L383)。

```go title="server/lease/lessor.go"
func (le *lessor) Checkpoint(id LeaseID, remainingTTL int64) error {
	le.mu.Lock()
	defer le.mu.Unlock()

	if l, ok := le.leaseMap[id]; ok {
		// when checkpointing, we only update the remainingTTL, Promote is responsible for applying this to lease expiry
		l.remainingTTL = remainingTTL
		if le.shouldPersistCheckpoints() {
			l.persistTo(le.b)
		}
		if le.isPrimary() {
			// schedule the next checkpoint as needed
			le.scheduleCheckpointIfNeeded(l)
		}
	}
	return nil
}
```

**`Checkpoint` は「合意ログを適用した結果」として全ノードで呼ばれる。** だから、フォロワーも `remainingTTL` を更新する。

コメントが役割分担を明示している。「チェックポイント時は `remainingTTL` だけを更新する。それを実際の期限に反映するのは `Promote` の責任」。

**フォロワーは値を持つだけで、時計としては使わない。** primary に昇格したときに初めて、その値が期限の計算に入る。

`shouldPersistCheckpoints` の判定 ([`#L385-L392`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L385-L392))。

```go title="server/lease/lessor.go"
func (le *lessor) shouldPersistCheckpoints() bool {
	cv := le.cluster.Version()
	return le.checkpointPersist || (cv != nil && greaterOrEqual(*cv, version.V3_6))
}
```

**クラスタ全体のバージョンが 3.6 以上のときだけ、db に永続化する。**

理由は互換性だ。古いバージョンのノードが混ざっていると、db に書いた `remainingTTL` を読めない (あるいは書式が違う)。**「クラスタの最小バージョン」を見て振る舞いを変える** のは、etcd 全体で使われている手になっている ([スキーマ移行のページ](../schema-migration/) も参照)。

### 書き込みを 2 エントリに抑える

チェックポイントは Raft のログに載る。**lease が 1 万個あって 5 分ごとにチェックポイントすると、それだけでログが膨らむ。**

抑制が 2 箇所に入っている。まずスケジュールする側 ([`#L753-L770`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L753-L770))。

```go title="server/lease/lessor.go"
func (le *lessor) scheduleCheckpointIfNeeded(lease *Lease) {
	if le.cp == nil {
		return
	}

	if lease.getRemainingTTL() > int64(le.checkpointInterval.Seconds()) {
		// ...
		heap.Push(&le.leaseCheckpointHeap, &LeaseWithTime{
			id:   lease.ID,
			time: time.Now().Add(le.checkpointInterval),
		})
	}
}
```

**「残り TTL がチェックポイント間隔 (5 分) より長い」ときだけスケジュールする。**

TTL が 60 秒の lease は、チェックポイントされない。**5 分以内に失効するなら、リーダー交代で TTL がリセットされても大した害はない** という判断だ。逆に、TTL が 1 時間の lease は、リセットされると 1 時間延びるので、チェックポイントの価値がある。

**コストを払う価値があるものだけを対象にする。** 短命な lease は etcd の使い方として圧倒的に多いので、この判定でほとんどのチェックポイントが消える。

もう 1 箇所は `Renew` の中 ([`#L431-L440`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L431-L440))。

```go title="server/lease/lessor.go"
	// Clear remaining TTL when we renew if it is set
	// By applying a RAFT entry only when the remainingTTL is already set, we limit the number
	// of RAFT entries written per lease to a max of 2 per checkpoint interval.
	if clearRemainingTTL {
		if err := le.cp(context.Background(), &pb.LeaseCheckpointRequest{Checkpoints: []*pb.LeaseCheckpoint{{ID: int64(l.ID), Remaining_TTL: 0}}}); err != nil {
			return -1, err
		}
	}
```

**KeepAlive で更新されたら、`remainingTTL` を 0 (= 未設定) に戻す。** これをしないと、古いチェックポイント値が残り続けて、リーダー交代時に「更新されたはずなのに残り時間が短い」ことになる。

そして **「すでに設定されているときだけ」書く**。KeepAlive は 1 秒ごとに来ることもあるが、`remainingTTL` が 0 のままなら Raft エントリは書かれない。

コメントが結論を書いている。「チェックポイント間隔あたり、lease ごとに最大 2 エントリに制限する」。**チェックポイントを 1 個書き、次の更新でクリアを 1 個書く。それ以上は増えない。**

### 期日到来の管理はヒープ

[`#L772-L790`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L772-L790)。

```go title="server/lease/lessor.go"
func (le *lessor) findDueScheduledCheckpoints(checkpointLimit int) []*pb.LeaseCheckpoint {
	if le.cp == nil {
		return nil
	}

	now := time.Now()
	var cps []*pb.LeaseCheckpoint
	for le.leaseCheckpointHeap.Len() > 0 && len(cps) < checkpointLimit {
		lt := le.leaseCheckpointHeap[0]
		if lt.time.After(now) /* lt.time: next checkpoint time */ {
			return cps
		}
		heap.Pop(&le.leaseCheckpointHeap)
```

**最小ヒープの先頭を見て、期日が来ていなければ即座に返る。** 1 万個の lease があっても、期日が来ていないなら比較は 1 回で済む。

失効の管理も同じ形 (`leaseExpiredNotifier`) で、こちらもヒープになっている。**「次に起きるイベントの時刻」だけを見ればよい仕事は、ヒープが最適な形になる。**

そして、チェックポイントはバッチにまとめられる ([`#L665-L687`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L665-L687))。

```go title="server/lease/lessor.go"
// checkpointScheduledLeases finds all scheduled lease checkpoints that are due and
// submits them to the checkpointer to persist them to the consensus log.
func (le *lessor) checkpointScheduledLeases() {
	// rate limit
	for i := 0; i < leaseCheckpointRate/2; i++ {
		var cps []*pb.LeaseCheckpoint

		le.mu.Lock()
		if le.isPrimary() {
			cps = le.findDueScheduledCheckpoints(maxLeaseCheckpointBatchSize)
		}
		le.mu.Unlock()

		if len(cps) != 0 {
			if err := le.cp(context.Background(), &pb.LeaseCheckpointRequest{Checkpoints: cps}); err != nil {
				return
			}
		}
		if len(cps) < maxLeaseCheckpointBatchSize {
			return
		}
	}
}
```

**1000 個までを 1 つの Raft エントリにまとめ、それを 1 回のループで最大 500 回。** つまり 1 周で最大 50 万個。

`LeaseCheckpointRequest` が `Checkpoints` の配列を持つ形になっているので、**バッチが protobuf のレベルで表現されている**。1 個ずつ提案すると、Raft のログエントリ数がそのまま lease 数になる。

「バッチが埋まらなかったら終わり」で抜けるのも、[圧縮のページ](../compaction-batching/) と同じ判定だ。

### 昇格時に、失効の集中をほぐす

[`#L480-L532`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L480-L532)。ここが `Promote` の後半で、この章で最も込み入った計算になっている。

```go title="server/lease/lessor.go"
func (le *lessor) Promote(extend time.Duration) {
	le.mu.Lock()
	defer le.mu.Unlock()

	le.demotec = make(chan struct{})

	// refresh the expiries of all leases.
	for _, l := range le.leaseMap {
		l.refresh(extend)
		item := &LeaseWithTime{id: l.ID, time: l.expiry}
		le.leaseExpiredNotifier.RegisterOrUpdate(item)
		le.scheduleCheckpointIfNeeded(l)
	}

	if len(le.leaseMap) < le.leaseRevokeRate {
		// no possibility of lease pile-up
		return
	}
```

**`extend` は「選挙にかかった時間」ぶんの猶予。** リーダーがいない間は KeepAlive を受け取れないので、その間の経過時間を lease のせいにしないための補正になる。

`refresh` の中身 ([`server/lease/lease.go#L83-L89`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lease.go#L83-L89))。

```go title="server/lease/lease.go"
// refresh refreshes the expiry of the lease.
func (l *Lease) refresh(extend time.Duration) {
	newExpiry := time.Now().Add(extend + time.Duration(l.getRemainingTTL())*time.Second)
	l.expiryMu.Lock()
	defer l.expiryMu.Unlock()
	l.expiry = newExpiry
}
```

**`getRemainingTTL()` が、チェックポイントされた残り TTL (無ければ元の TTL) を返す。** チェックポイントの仕組み全体が、この 1 行に集約されている。

そして、lease の数が失効レート (毎秒 1000) を超えている場合だけ、追加の処理に入る。

```go title="server/lease/lessor.go"
	// adjust expiries in case of overlap
	leases := le.unsafeLeases()
	sort.Sort(leasesByExpiry(leases))

	baseWindow := leases[0].Remaining()
	nextWindow := baseWindow + time.Second
	expires := 0
	// have fewer expires than the total revoke rate so piled up leases
	// don't consume the entire revoke limit
	targetExpiresPerSecond := (3 * le.leaseRevokeRate) / 4
	for _, l := range leases {
		remaining := l.Remaining()
		if remaining > nextWindow {
			baseWindow = remaining
			nextWindow = baseWindow + time.Second
			expires = 1
			continue
		}
		expires++
		if expires <= targetExpiresPerSecond {
			continue
		}
		rateDelay := float64(time.Second) * (float64(expires) / float64(targetExpiresPerSecond))
		// If leases are extended by n seconds, leases n seconds ahead of the
		// base window should be extended by only one second.
		rateDelay -= float64(remaining - baseWindow)
		delay := time.Duration(rateDelay)
		nextWindow = baseWindow + delay
		l.refresh(delay + extend)
```

**やっていることは「1 秒あたりの失効数が 750 個を超えないよう、期限を後ろにずらす」。**

なぜ必要か。lease の失効は **キーの削除を伴う** ([前提のページ](../architecture/))。削除は Raft の提案になるので、1 万個の lease が同時に失効すると、1 万個の削除提案が一気に流れる。**クラスタが詰まり、通常のリクエストが処理できなくなる。**

しかも、リーダー交代の直後は最も不安定な時期で、そこに負荷の山を作りたくない。

目標値を失効レートの 3/4 にしているのもコメントが説明している。「積み上がった lease が、失効レートの全部を消費しないように」。**残りの 1/4 は、通常の失効のために空けておく。**

`rateDelay -= float64(remaining - baseWindow)` の 1 行にもコメントが付いている。「lease が n 秒延長されるなら、基準ウィンドウから n 秒先にある lease は 1 秒だけ延長すべき」。**すでに先にある lease を、必要以上にずらさない** ための補正だ。

**負荷の平準化を、キューやレート制限ではなく「期限そのものをずらす」ことで実現している。** 失効は「時刻で駆動される仕事」なので、時刻を変えるのが最も直接的な制御になる。

### 失効の通知も、詰まったら諦める

[`#L645-L663`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/lease/lessor.go#L645-L663)。

```go title="server/lease/lessor.go"
	if len(ls) != 0 {
		select {
		case <-le.stopC:
			return
		case le.expiredC <- ls:
		default:
			// the receiver of expiredC is probably busy handling
			// other stuff
			// let's try this next time after 500ms
		}
	}
```

**送れなければ捨てて、500 ms 後にまた試す。** [watcher の 3 群のページ](../watch-sync-victim/) と同じノンブロッキング送信だ。

捨てても問題ないのは、**失効すべき lease はヒープに残っている** から。次の周回でまた見つかる。**状態を保持している側から通知を投げるなら、通知の喪失は「遅れる」だけで済む。**

チャネルのバッファも 16 と小さく、コメントで「不要なブロッキングを避けるための小さなバッファ」と説明されている。

## なぜそうなっているか

- **TTL の管理を primary だけに任せるのは、時計が複製できないから。** Raft が複製するのは操作の列であって、時間の経過ではない。**「どのノードの時計を信じるか」を決めなければならず、リーダーを選ぶのが自然な答えになる。**
- **残り TTL をチェックポイントするのは、リーダー交代で時間が巻き戻るのを防ぐため。** 経過時間そのものは共有できないが、**「ある時点での残り時間」というスナップショットは値なので共有できる。** 共有できない状態を、共有できる形に変換している。
- **「残りが間隔より長いときだけ」チェックポイントするのは、コストと効果が釣り合わないケースがあるから。** 5 分以内に切れる lease をチェックポイントしても、守れる時間はわずかだ。**保護の価値が、書き込みのコストを上回るものだけを対象にする。**
- **更新時に「設定済みなら 0 に戻す」だけにするのは、書き込み回数の上限を作るため。** 無条件に書くと、KeepAlive の頻度がそのまま Raft のエントリ数になる。**「状態が変わるときだけ書く」形にすると、上限が構造的に決まる。**
- **期日管理をヒープにするのは、大半の周回で何もしないから。** 1 万個の lease があっても、この瞬間に期日が来ているのは数個だ。**先頭 1 個を見て抜けられる構造が、待機コストをほぼゼロにする。**
- **昇格時に期限をずらすのは、失効が重い操作だから。** lease の失効はキーの削除を伴い、Raft の提案になる。**同時に大量に起きると、クラスタ全体が詰まる。** しかも起きる時刻がリーダー交代直後という、最も余裕のないタイミングになる。
- **平準化を「期限をずらす」で実現したのは、失効が時刻駆動だから。** キューに積んでレート制限をかけることもできるが、**時刻で駆動される仕事は、時刻を変えるのが最も直接的な制御になる。** 追加のキューも状態も増えない。
- **目標を失効レートの 3/4 にしたのは、通常の失効ぶんを残すため。** 平準化した負荷が上限いっぱいを占めると、その後に来た通常の失効が遅れる。**バーストの平準化では、定常負荷のぶんを空けておく。**
- **primary が 2 人いる可能性を許容したのは、Raft の任期がそれを吸収するから。** 古い primary の提案はコミットされない。**「唯一性」を上位のプロトコルが保証しているなら、下位で二重に保証する必要はない。** その代わり、窓の大きさと影響を評価してコメントに残している。

## どう活かすか

- **「時間の経過」はレプリカ間で共有できない。共有したいなら値に変換する。** 「残り N 秒」は値なので複製できる。定期的にスナップショットを取って複製すれば、フェイルオーバー後も continuity が保てる。**セッション、レート制限のトークン、リトライの残り回数も同じ形になる。**
- **チェックポイントの頻度は、「守れる価値」と「書き込みコスト」で決める。** 短命なものはチェックポイントしなくてよい。判定は「残り時間 > チェックポイント間隔」のような 1 行の比較で書ける。
- **状態が変わるときだけ書く形にすると、書き込み回数に構造的な上限ができる。** 「値が設定されているときだけクリアする」のような条件を入れるだけで、更新頻度と書き込み頻度が切り離せる。
- **時刻で駆動される仕事は、最小ヒープで管理する。** 大半の周回で「先頭の期日がまだ来ていない」で抜けられる。全件走査やタイマーの大量生成に比べて、待機コストが桁違いに小さい。
- **一斉に起きるイベントは、時刻をずらして平準化する。** キューとレート制限を追加するより、**発火時刻そのものを分散させる** ほうが状態が増えない。TTL、リトライ、定期ジョブ、キャッシュの有効期限すべてに使える。
- **平準化の目標値は、処理能力の上限より低くする。** 上限いっぱいに詰めると、平準化していない通常の負荷がその後ろに並ぶ。**7〜8 割を目安に空けておく。**
- **フェイルオーバー直後は最も脆弱な時期なので、そこに負荷の山を作らない。** 状態の再構築、接続の再確立、キャッシュのミスが同時に起きている。そこに一斉失効を重ねると、復旧そのものが失敗する。
- **「唯一のリーダー」を仮定しない。仮定が破れる窓を評価する。** 上位のプロトコルが正しさを保証しているなら、下位は多少の重複を許容できる。**許容する場合は、窓の大きさと影響をコメントに書く。** 「たぶん大丈夫」と「1 秒以内で、lease は時間にそこまで敏感ではない」は、後から読む人にとってまったく違う情報になる。
- **状態を保持している側から通知を投げるなら、通知は捨ててよい。** 受け手が詰まっていたら諦めて、次の周回で再送する。通知の喪失が「遅れ」にしかならない構造にしておくと、送信側がブロックしなくて済む。
