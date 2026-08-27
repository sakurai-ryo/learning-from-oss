---
title: "未コミットの書き込みを巻き戻せるハッシュマップ"
description: "コントローラはレコードをコミット前にメモリへ適用する。リーダーを降ろされたら、その分を全部なかったことにしなければならない。Kafka は「過去のある時点の状態を保持したまま更新できるハッシュマップ」を自作した。上書き・削除されたエントリだけを直近のスナップショット層に退避する、という 1 つのアイデアでできている。"
group: "コントロールプレーン"
sidebar:
  order: 19
---

## 何を学んだか

### どんな状況の話か

[コントローラのページ](../quorum-controller/) で見たとおり、`QuorumController` はレコードを **Raft にコミットされる前に**メモリ上の状態に適用する。パイプライン化のためだ。

問題は、**コミットされないことがある**点だ。

- リーダーを降ろされた (より新しいエポックのコントローラが現れた)。
- ネットワークが分断され、過半数に複製できなかった。

このとき、**メモリ上に適用してしまった変更を全部取り消す**必要がある。取り消さないと、standby に戻ったのに「アクティブだったときに勝手に決めたこと」を持ち続けることになる。

素朴な解決策は 3 つあって、どれも高くつく。

| 案                       | 問題                                            |
| ------------------------ | ----------------------------------------------- |
| プロセスを再起動する     | メタデータを全部読み直す。数十秒〜数分          |
| 状態全体をコピーしておく | メタデータが数百 MB。変更のたびにコピーは不可能 |
| 逆操作 (undo log) を積む | 全ての操作に逆操作を実装する。バグの温床        |

### Kafka の答え

**「ある時点の状態」を保持したまま更新できるデータ構造を自作する。**

1. **`SnapshotRegistry` に epoch を指定してスナップショットを作る。** epoch はメタデータログの offset。
2. **その後の更新は、上書き・削除されたエントリだけを直近のスナップショット層に退避する。** コピーは変更された分だけ。
3. **巻き戻しは、スナップショット層のエントリを現在の層に書き戻すだけ。**
4. **コミットが進んだら、古いスナップショットを捨てる。** 捨てるのも O(変更されたエントリ数)。
5. **`TimelineHashMap` / `TimelineHashSet` / `TimelineLong` などが、この上に載る。**

## ソースコードのどこか

### 登録所

```java title="server-common/src/main/java/org/apache/kafka/timeline/SnapshotRegistry.java"
/**
 * A registry containing snapshots of timeline data structures. All timeline data structures must
 * be registered here, so that they can be reverted to the expected state when desired.
 * Because the registry only keeps a weak reference to each timeline data structure, it does not
 * prevent them from being garbage collected.
 */
public class SnapshotRegistry {
```

[`SnapshotRegistry.java#L31-L37`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/timeline/SnapshotRegistry.java#L31-L37)。

**「全ての timeline データ構造をここに登録する」。** スナップショットを作るとき、レジストリが登録された全構造に「今の状態を覚えておけ」と伝える。巻き戻すときも同様に全部に伝える。

**弱参照を使っている**のがポイントで、レジストリに登録したまま構造が不要になっても GC される。マネージャが破棄されたら一緒に消える。

### 核心のアイデア

```java title="server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java"
/**
 * SnapshottableHashTable implements a hash table that supports creating point-in-time
 * snapshots.  Each snapshot is immutable once it is created; the past cannot be changed.
 * We handle divergences between the current state and historical state by copying a
 * reference to elements that have been deleted or overwritten into the most recent
 * snapshot tier.
```

[`SnapshottableHashTable.java#L28-L34`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java#L28-L34)。

**「削除または上書きされた要素への参照を、直近のスナップショット層にコピーする」** — この 1 文が全てだ。

```text
スナップショットを作る (epoch = 100)
  current: {A: 1, B: 2, C: 3}
  tier(100): (空)

B を 5 に上書きする
  current: {A: 1, B: 5, C: 3}
  tier(100): {B: 2}          ← 上書き前の B だけを退避

C を削除する
  current: {A: 1, B: 5}
  tier(100): {B: 2, C: 3}    ← 削除された C も退避

D を追加する
  current: {A: 1, B: 5, D: 4}
  tier(100): {B: 2, C: 3}    ← 追加は退避不要 (epoch 100 には無かった)
```

**epoch 100 の状態を読むには、`tier(100)` を見て、無ければ `current` を見る。** 変更されなかった A は `current` に 1 つあるだけで、コピーされていない。

**コストが「変更された分だけ」になる。** 永続データ構造 (persistent data structure) の考え方だが、こちらは「過去のほうを差分で持つ」形になっている。

追加された要素を過去から除外する仕掛けも書かれている。

```java title="server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java"
 * Note that each element in the hash table contains a start epoch, and a value.  The
 * start epoch is there to identify when the object was first inserted.  This in turn
 * determines which snapshots it is a member of.
 * <p>
 * In order to retrieve an object from snapshot E, we start by checking to see if the
 * object exists in the "current" hash tier.  If it does, and its startEpoch extends back
 * to E, we return that object.  Otherwise, we check all the snapshot tiers, starting
 * with E, and ending with the most recent snapshot, to see if the object is there.
 * As an optimization, if we encounter the object in a snapshot tier but its epoch is too
 * new, we know that its value at epoch E must be null, so we can return that immediately.
```

[`SnapshottableHashTable.java#L49-L58`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java#L49-L58)。

**各要素が「いつ挿入されたか」(start epoch) を持つ。** epoch 100 の状態を読むときに、start epoch が 150 の要素は「まだ存在しなかった」と判定できる。

**参照するのは「その epoch 以降の層」だけ**なので、古いスナップショットを読むほど層を多く辿る。逆に言えば、**最新の状態を読むときは `current` を 1 回見るだけ**で、これが圧倒的多数のアクセスパターンになる。

### 階層構造

```java title="server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java"
 * The class hierarchy looks like this:
 * <pre>
 *        Revertable       BaseHashTable
 *              ↑              ↑
 *           SnapshottableHashTable → SnapshotRegistry → Snapshot
 *               ↑             ↑
 *   TimelineHashSet       TimelineHashMap
 * </pre>
```

[`SnapshottableHashTable.java#L60-L68`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java#L60-L68)。

**`BaseHashTable` を継承している理由まで書いてある。**

```java title="server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java"
 * The current tier's data is stored in the fields inherited from BaseHashTable.  It
 * would be conceptually simpler to have a separate BaseHashTable object, but since Java
 * doesn't have value types, subclassing is the only way to avoid another pointer
 * indirection and the associated extra memory cost.
```

[`SnapshottableHashTable.java#L44-L48`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java#L44-L48)。

**「委譲のほうが概念的には単純だが、Java に値型がないので継承を選んだ」。** メタデータのエントリは数十万個になるので、参照 1 つ分のオーバーヘッドが積もる。**設計の美しさより、ポインタ 1 個を選んだ理由が書き残されている。**

### API の分け方

```java title="server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java"
 * The accessor APIs have two versions -- one that looks at the current state, and one
 * that looks at a historical snapshotted state.  Mutation APIs only ever mutate the
 * current state.
```

[`SnapshottableHashTable.java#L78-L80`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/timeline/SnapshottableHashTable.java#L78-L80)。

`TimelineHashMap` は `Map` インタフェースを実装しつつ、**`get(key, epoch)` のような epoch 付きのメソッドを追加で持つ**。

これがコントローラで効いている。**「今の状態」を見るコードと「コミット済みの状態」を見るコードが、同じデータ構造に対して書ける。** たとえば `DescribeTopics` のような読み取りリクエストは、コミット済みの状態を読むことで一貫性を保てる。

**更新は常に現在の状態にしか効かない。** 過去は変えられない。

### 巻き戻し

```java title="server-common/src/main/java/org/apache/kafka/timeline/SnapshotRegistry.java"
/**
 * Reverts the state of all data structures to the state at the given epoch.
 */
public void revertToSnapshot(long targetEpoch) {
    log.debug("Reverting to in-memory snapshot {}", targetEpoch);
    Snapshot target = getSnapshot(targetEpoch);
    Iterator<Snapshot> iterator = iterator(target);
    iterator.next();
    while (iterator.hasNext()) {
        Snapshot snapshot = iterator.next();
        log.debug("Deleting in-memory snapshot {} because we are reverting to {}",
            snapshot.epoch(), targetEpoch);
        iterator.remove();
    }
    target.handleRevert();
}
```

[`SnapshotRegistry.java#L248-L265`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/timeline/SnapshotRegistry.java#L248-L265)。

**対象より新しいスナップショットを全部捨ててから、対象の層を現在に書き戻す。** 17 行しかない。

### 前に進むほうも安い

```java title="server-common/src/main/java/org/apache/kafka/timeline/SnapshotRegistry.java"
void deleteSnapshot(Snapshot snapshot) {
    Snapshot prev = snapshot.prev();
    if (prev != head) {
        prev.mergeFrom(snapshot);
    } else {
        snapshot.erase();
    }
    log.debug("Deleting in-memory snapshot {}", snapshot.epoch());
    snapshots.remove(snapshot.epoch(), snapshot);
}
```

[`SnapshotRegistry.java#L279-L289`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/server-common/src/main/java/org/apache/kafka/timeline/SnapshotRegistry.java#L279-L289)。

**スナップショットを消すとき、1 つ前があればそこにマージする。** 前が無い (一番古い) なら、そのまま捨てる。

コミットが進むと古いスナップショットは不要になるので、`deleteSnapshotsUpTo` で捨てられる。**捨てると、退避していたエントリのメモリが解放される。**

### コントローラでの使われ方

```java title="metadata/src/main/java/org/apache/kafka/controller/OffsetControlManager.java"
void activate(long newNextWriteOffset) {
    ...
    // Before switching to active, create an in-memory snapshot at the last committed
    // offset. This is required because the active controller assumes that there is always
    // an in-memory snapshot at the last committed offset.
    snapshotRegistry.idempotentCreateSnapshot(lastStableOffset);
    this.nextWriteOffset = newNextWriteOffset;
    metrics.setActive(true);
}
```

```java title="metadata/src/main/java/org/apache/kafka/controller/OffsetControlManager.java"
void deactivate() {
    ...
    if (!snapshotRegistry.hasSnapshot(lastStableOffset)) {
        throw new RuntimeException("Unable to reset to last stable offset " + lastStableOffset +
                ". No in-memory snapshot found for this offset.");
    }
    snapshotRegistry.revertToSnapshot(lastStableOffset);
}
```

[`OffsetControlManager.java#L241-L271`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/OffsetControlManager.java#L241-L271)。

**アクティブになるときにスナップショットを作り、アクティブでなくなるときにそこへ巻き戻す。** これだけだ。

**「アクティブなコントローラは、常に最終コミット offset のスナップショットを持っている」という不変条件**がコメントに書かれ、`deactivate` でそれを検査している。

## なぜそうなっているか

### なぜ既製の永続データ構造ではないのか

Java には不変コレクションのライブラリ (Guava、Vavr、Clojure の PersistentHashMap) がある。使わなかった理由は、**アクセスパターンが逆**だからだ。

一般的な永続データ構造は **「過去も未来も同じコストで読める」** ように作られている。木構造で、更新するとルートまでのパスをコピーする。読み取りは常に O(log n)。

コントローラのアクセスパターンは違う。

|                      | 頻度                                            |
| -------------------- | ----------------------------------------------- |
| **現在の状態を読む** | 圧倒的多数                                      |
| 現在の状態を更新する | 多い                                            |
| 過去の状態を読む     | 稀 (未コミットを避けたい読み取りリクエストのみ) |
| 過去へ巻き戻す       | 極めて稀 (リーダー交代時のみ)                   |

**`SnapshottableHashTable` は、現在の読み取りを普通のハッシュテーブルと同じコストにしている。** `current` 層を 1 回引くだけだ。過去を読むときだけ層を辿る。

**「稀なケースにコストを寄せる」** という最適化で、既製品では実現できない。

### なぜ「過去を差分で持つ」のか

永続データ構造の多くは「新しいバージョンを差分で作る」。Kafka は逆に「古いバージョンを差分で残す」。

理由は **現在の状態がプレーンなハッシュテーブルのままでいられる**ことにある。新しいバージョンを差分で作る方式だと、現在の状態も木構造になり、読み取りが O(log n) になる。

**書き込みのときに「上書きされる値を退避する」というひと手間を払うだけで、読み取りが O(1) のままになる。** 退避先は直近のスナップショット層 1 つだけなので、書き込みのコストもほぼ変わらない。

### なぜスナップショットの単位が offset なのか

`SnapshotRegistry` の epoch は、**メタデータログの offset そのもの**だ。

これで 3 つのことが同時に表現できる。

- **「コミット済みの状態」= 最終コミット offset のスナップショット。**
- **「巻き戻す先」= 最終コミット offset。**
- **「もう不要なスナップショット」= コミット offset より古いもの。**

**ログの offset という 1 つの座標系に、メモリ上の状態のバージョンも合わせている。** 別の座標系 (トランザクション ID など) を導入していない。

### なぜ全てのマネージャがこれを使うのか

`ReplicationControlManager`、`ClusterControlManager`、`ConfigurationControlManager`、`AclControlManager` — コントローラの全てのマネージャが、状態を `TimelineHashMap` などで持っている。

**一部だけ普通の `HashMap` を使うと、巻き戻しがそこだけ効かない。** そして、そのバグは「リーダー交代が起きたときだけ、その部分の状態が古いまま残る」という形で現れる。**極めて稀にしか起きず、再現も難しい。**

だから **`SnapshotRegistry` に登録しなければならない、というルールが javadoc の 1 行目に書かれている。** `All timeline data structures must be registered here`。

**「一部が守らないと全体が壊れる」規約は、明示して、できれば型で強制する。** ここでは `Revertable` インタフェースがその役割を担っている。

### 同じ仕組みがコーディネータでも使われる

`SnapshotRegistry` は `server-common` にあり、コントローラ専用ではない。**[グループコーディネータ](../coordinator-runtime/) も同じものを使っている。**

コーディネータも「レコードを `__consumer_offsets` に書く前にメモリへ適用し、コミットされたら応答する」という同じ構造を持つ。**問題が同じなら、道具も同じでいい。**

## どう活かすか

**「未コミットの変更を楽観的に適用し、失敗したら巻き戻す」を実装するなら、undo log より「過去を差分で残すデータ構造」のほうが安全だ。** undo log は操作ごとに逆操作を書く必要があり、**新しい操作を足すたびに逆操作を書き忘れるリスクがある**。データ構造のレベルで巻き戻せるなら、操作の実装者は何も意識しなくていい。**「規約を守らせる」より「守らなくても壊れない」ほうが強い。**

**「アクセス頻度の分布を見てから、どちらを差分にするか決める」という視点は持ち帰りたい。** 永続データ構造は「新しいほうを差分で作る」のが定番だが、それは過去と現在が同じ頻度で読まれる前提の設計だ。**現在が圧倒的に多く読まれるなら、過去を差分にしたほうが速い。** 既製のライブラリを使う前に、自分のアクセスパターンがそのライブラリの前提と合っているかを確認する価値がある。

**「バージョン番号を、既存の座標系から借りる」のも効いている。** Kafka はログの offset をそのままスナップショットの epoch にした。**新しい ID 体系を作ると、それとログ offset の対応を管理する必要が出る。** 借りられるなら借りる。

**「全員が守らないと壊れる規約は、javadoc の 1 行目に書き、インタフェースで表す」** — `All timeline data structures must be registered here` は、この仕組みの唯一の落とし穴を先に潰している。**規約の存在自体を発見できないのが一番まずい**ので、置き場所は目立つところにする。

**一方で、この構造には代償もある。** 過去の状態を読むほど層を辿るので、**スナップショットを溜めすぎると読み取りが遅くなる**。コミットが止まると (Raft の過半数が失われると) スナップショットが溜まり続け、メモリも増える。**「巻き戻せる」を維持するコストは、コミットが進んでいることに依存している。**
