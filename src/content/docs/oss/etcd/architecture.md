---
title: "KV ストアの言葉で読む etcd のデータモデルとアーキテクチャ"
description: "etcd は「キーに値を入れる」だけの見た目をしているが、中身はリビジョンで版管理される MVCC ストアで、その上に Raft が乗り、さらにその上に watch と lease が乗っている。この章の他のページが使う語彙 (リビジョン、apply、backend、WAL、スナップショット、compaction) を、普通の KV ストアや RDB の言葉との対応で先に導入する。"
sidebar:
  order: 1
---

このページは、他のページを読むための語彙を用意するためのものだ。etcd を使ったことがなくても読める。

## etcd とは何か

**etcd は、クラスタ全体で 1 つの一貫した状態を持つための、小さくて壊れにくいキーバリューストアだ。**

「小さくて」は誇張ではない。デフォルトのデータ量上限は 2 GB、推奨される最大値でも 8 GB しかない ([`server/storage/quota.go#L28-L33`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/quota.go#L28-L33))。

```go title="server/storage/quota.go"
	// DefaultQuotaBytes is the number of bytes the backend Size may
	// consume before exceeding the space quota.
	DefaultQuotaBytes = int64(2 * 1024 * 1024 * 1024) // 2GB
	// MaxQuotaBytes is the maximum number of bytes suggested for a backend
	// quota. A larger quota may lead to degraded performance.
	MaxQuotaBytes = int64(8 * 1024 * 1024 * 1024) // 8GB
```

汎用データベースとしては話にならない容量だ。それでも成立するのは、etcd が保存するものが **「アプリケーションのデータ」ではなく「クラスタの構成と状態」** だからだ。Kubernetes がすべての Pod・Service・Secret を置いている先が etcd で、Kubernetes にとっては唯一の永続ストアでもある。

用途を一言でいえば、こうなる。

- **設定と状態の置き場**: 全ノードが同じ値を見る必要があるもの。
- **サービスディスカバリ**: 「今生きているのは誰か」を lease と watch で表す。
- **分散ロック・リーダー選出**: `Txn` の compare-and-swap を土台にした調整。

逆に、etcd が向かないものもはっきりしている。大量のデータ、高スループットの書き込み、大きな値。**書き込みはすべて Raft の合意を通る** ので、1 回の書き込みに過半数のノードへのネットワーク往復とディスク同期が入る。

## データモデル

### キー空間はフラットなバイト列

キーもバイト列、値もバイト列で、階層構造はない。`/registry/pods/default/nginx` のようなキーが使われるが、`/` に意味があるのは慣習としてだけだ。

範囲操作は **半開区間 `[key, range_end)`** で表す。プレフィックス検索は「プレフィックスの最後のバイトを 1 増やしたもの」を `range_end` に渡すことで表現する。`range_end` に `\x00` を渡すとキー空間の末尾までを意味する。この 2 つの規約だけで、単一キー・範囲・プレフィックス・全件がすべて同じ API に収まる。

### リビジョン: クラスタ全体で 1 本の時計

etcd を理解するうえで一番重要な概念が **リビジョン (revision)** だ。

**リビジョンは、キー空間全体に対して 1 本だけ存在する、単調増加のカウンタである。** キーごとではない。書き込みトランザクションが 1 回成功するたびに 1 増える。

`foo` に 1 回、`bar` に 1 回書けば、`foo` は revision 2、`bar` は revision 3 になる。この 2 つの操作の間に順序があることが、リビジョンの値そのものによって表現されている。

リビジョンは 2 段構造になっている ([`server/storage/mvcc/revision.go#L35-L42`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/mvcc/revision.go#L35-L42))。

```go title="server/storage/mvcc/revision.go"
type Revision struct {
	// Main is the main revision of a set of changes that happen atomically.
	Main int64
	// Sub is the sub revision of a change in a set of changes that happen
	// atomically. Each change has different increasing sub revision in that
	// set.
	Sub int64
}
```

`Main` が「何回目のトランザクションか」、`Sub` が「そのトランザクションの中の何番目の変更か」。1 つの `Txn` で 3 つのキーを書けば、3 つの変更は同じ `Main` と、0・1・2 の `Sub` を持つ。**原子性が「同じ Main を共有すること」で表現されている。**

キーごとには 3 つの数字が付く。

| 名前              | 意味                                         |
| ----------------- | -------------------------------------------- |
| `create_revision` | このキーが (最後に) 作られたときのリビジョン |
| `mod_revision`    | このキーが最後に変更されたときのリビジョン   |
| `version`         | 作られてから何回変更されたか (作成時が 1)    |

キーを削除して作り直すと `create_revision` と `version` はリセットされるが、グローバルなリビジョンは戻らない。

### MVCC: 上書きしない

etcd は **キーの値を上書きしない**。書き込みは常に「新しいリビジョンでの新しいバージョン」として追記される。だから、

- 過去のリビジョンを指定して読める (`Get(key, WithRev(100))`)。
- 過去のリビジョンから watch を再開できる。
- 削除も「トンボストーン (墓標) を追記する」ことで表す。

追記しかしないので、放っておくとデータは増え続ける。それを刈り取るのが **compaction (圧縮)** で、「revision N より前の履歴を捨てる」という操作になる。捨てられた後にそのリビジョンを読もうとすると `mvcc: required revision has been compacted` が返る。

このモデルの詳細は [keyIndex のページ](../mvcc-key-index/) で扱う。

### Watch: リビジョンを起点に再開できる購読

`Watch(key, WithRev(N))` は、「リビジョン N 以降にこのキーに起きた変更を全部よこせ」という意味になる。**過去に遡れる購読** であることが、普通の pub/sub との決定的な違いだ。

クライアントは接続が切れても、最後に受け取ったリビジョンの次から再開できる。イベントを取りこぼす可能性があるのは、必要なリビジョンがすでに compaction で消えている場合だけで、そのときは明示的に `ErrCompacted` が返る。**「取りこぼしたかどうか分からない」という状態が存在しない。**

### Lease: TTL を持つ束

`Lease` は TTL 付きのオブジェクトで、キーを複数個「くくり付ける」ことができる。TTL が切れると、くくり付けられたキーがまとめて消える。クライアントは `KeepAlive` を送り続けることで TTL を延長する。

「このプロセスが生きている間だけ存在するキー」を表すための道具で、サービスディスカバリやリーダー選出の土台になっている。詳細は [lease チェックポイントのページ](../lease-checkpoint/) で扱う。

### Txn: compare-and-swap の一般形

etcd の書き込み API は `Put` / `DeleteRange` / `Txn` の 3 つしかない。このうち `Txn` が最も強力で、

```
If(条件の並び) Then(操作の並び) Else(操作の並び)
```

という形をしている。条件には各キーの `create_revision` / `mod_revision` / `version` / `value` を使える。よく使うのが `If(CreateRevision(key) == 0)` で、これは「キーが存在しないなら」を意味する。分散ロックもリーダー選出も、この形の上に作られている。

**etcd には RDB のような複数ステートメントのトランザクションは無い。** `Txn` は 1 回の原子的な操作であり、開いたまま複数のラウンドトリップを挟むことはできない。

## アーキテクチャ

### 層

1 つの etcd プロセスは、おおよそ次の層でできている。

```
クライアント (gRPC)
  ↓
v3rpc          … gRPC のハンドラ。認証・リクエストの検証
  ↓
EtcdServer     … 書き込みは Raft に提案し、読み取りは ReadIndex を挟む
  ↓
raft           … 合意アルゴリズム。純粋な状態機械で、I/O はしない (別リポジトリ)
  ↓
WAL            … 合意されるべきログエントリをディスクに書く
  ↓
apply          … 合意済みエントリを 1 つずつ状態に反映する
  ↓
mvcc           … リビジョン付きの KV。treeIndex (メモリ) と backend
  ↓
backend        … bbolt (B+tree の組み込み KV) へのバッチ書き込み
```

上から下に一直線に見えるが、実際には **raft 層と apply 層が非同期に動く** ところが読みどころになる ([Ready ループのページ](../raft-ready-loop/))。

### 書き込みの一生

`Put(foo, bar)` が何を通るかを追うと、全体像が掴める。

1. **gRPC ハンドラが受ける。** 認証情報を context から取り出す。
2. **リクエストに ID を振り、待ちチャネルを登録する** ([`server/etcdserver/v3_server.go#L1066-L1106`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/v3_server.go#L1066-L1106))。この ID が後で結果を受け取る鍵になる ([提案 ID のページ](../proposal-wait/))。
3. **Raft に提案する。** `Propose` は非同期で、返ってきても何も保証しない。
4. **リーダーが過半数に複製し、コミットされる。** その過程で各ノードは WAL にエントリを書き、fsync する。
5. **コミット済みエントリが apply される。** ここで初めて mvcc ストアに書かれ、リビジョンが 1 増える。
6. **apply の結果が、手順 2 で登録した ID のチャネルに流し込まれる。** 待っていた gRPC ハンドラが起きて、クライアントに応答を返す。

**「提案した goroutine」と「apply する goroutine」は別物** で、その間を ID とチャネルだけで繋いでいる。これが etcd のサーバ側の骨格になっている。

### 読み取りの 2 種類

読み取りには 2 つのモードがある。

- **serializable read**: ローカルのストアをそのまま読む。速いが、そのノードが少し遅れていれば古い値が返る。
- **linearizable read (既定)**: 「読む前に、今のリーダーのコミット位置に自分が追いついていること」を確認してから読む。

後者は Raft の `ReadIndex` という仕組みを使う ([`server/etcdserver/v3_server.go#L138-L144`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/etcdserver/v3_server.go#L138-L144))。

```go title="server/etcdserver/v3_server.go"
	if !r.Serializable {
		err = s.read.LinearizableReadNotify(ctx)
		trace.Step("agreement among raft nodes before linearized reading")
		if err != nil {
			return nil, err
		}
	}
```

**読み取りなのに、他のノードとの通信が入る。** リーダーは「自分がまだリーダーか」を過半数に確認する必要があるからだ。これを 1 リクエストごとにやると重すぎるので、etcd は多数の読み取りを 1 回の確認に相乗りさせている ([線形化可能読み取りのページ](../linearizable-read-batching/))。

### ディスク上にある 3 種類のもの

データディレクトリの中身は 3 つに分かれる ([`server/storage/datadir/datadir.go`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/datadir/datadir.go))。

| パス                 | 中身                                 | 役割                                                     |
| -------------------- | ------------------------------------ | -------------------------------------------------------- |
| `member/wal/*.wal`   | Raft のログエントリと HardState      | **合意された操作の履歴**。まだ適用されていないものも含む |
| `member/snap/*.snap` | Raft のスナップショット (メタデータ) | 古い WAL を捨てるための基準点                            |
| `member/snap/db`     | bbolt のデータベースファイル         | **適用された結果**。KV の実体はここ                      |

**WAL と db は「同じデータの別の形」ではない。** WAL は「これから起きること (あるいは起きたこと) の記録」で、db は「その結果」だ。プロセスが落ちると、db に反映済みの位置 (consistent index) と WAL の末尾との差分を、起動時に再適用することで追いつく ([consistent index のページ](../consistent-index/))。

### 2 つの「compaction」は別物

この章を読むときに一番混乱しやすいのがここなので、先に切り分けておく。

- **Raft ログの compaction (スナップショット)**: WAL が無限に伸びないよう、「ここまでの状態はスナップショットにしたので、それ以前のログは捨てる」とする操作。**Raft 層の話** で、KV の履歴とは関係ない。
- **MVCC の compaction**: 「リビジョン N より前の古いバージョンを捨てる」操作。**mvcc 層の話** で、`etcdctl compact` が起こすのはこちら。

前者を怠ると WAL とメモリが膨らみ、後者を怠ると db が膨らむ。原因も対処も別物になる。

### さらに、削除しても db は縮まない

MVCC compaction で古いバージョンを消しても、bbolt のファイルサイズは減らない。空いたページが「フリーリスト」に載って再利用可能になるだけだ。ファイルとして縮めるには **defrag** という別の操作が必要になる。「compaction したのにディスク使用量が減らない」は etcd の運用でよく出る話で、層の分かれ方がそのまま現れている。

## クラスタの構成

etcd は通常 3 台か 5 台で動かす。**過半数が生きていれば書き込みができ、過半数を失うと書き込みができなくなる** (読み取りも、線形化可能読み取りは失敗する)。

台数と耐障害性の関係は Raft のそのままで、3 台なら 1 台、5 台なら 2 台まで落ちても動く。**偶数台にする意味はない** (4 台の耐障害性は 3 台と同じ 1 台で、遅くなるだけ)。

ポートは 2 つ使う。

- **2379**: クライアント向け。gRPC (と gRPC-gateway 経由の HTTP)。
- **2380**: ピア間通信。Raft のメッセージが流れる。**gRPC ではなく HTTP** で実装されている ([ピア通信のページ](../rafthttp-stream-pipeline/))。

## コードの地図

読むときに知っておくと迷わない対応。

| ディレクトリ               | 中身                                                   |
| -------------------------- | ------------------------------------------------------ |
| `api/`                     | protobuf 定義と、クライアント・サーバ共通の型          |
| `client/v3/`               | Go クライアント                                        |
| `server/etcdserver/`       | サーバの本体。Raft の駆動、提案、apply                 |
| `server/etcdserver/apply/` | 合意済みリクエストを状態に反映する層                   |
| `server/storage/mvcc/`     | リビジョン付き KV と watch                             |
| `server/storage/backend/`  | bbolt のラッパ。バッチトランザクション                 |
| `server/storage/wal/`      | WAL                                                    |
| `server/storage/schema/`   | db 上のバケット定義とスキーマ移行                      |
| `server/lease/`            | lease                                                  |
| `pkg/`                     | 汎用ユーティリティ (wait、idutil、traceutil、adt など) |
| `cache/`                   | クライアント側の watch キャッシュ (実験的)             |
| `tests/robustness/`        | 障害注入 + 線形化可能性検査のテスト基盤                |

**Raft そのものは `go.etcd.io/raft` という別リポジトリにある。** この章では、etcd がその raft をどう「使っているか」だけを扱う。同様に、backend が使う B+tree は `go.etcd.io/bbolt` という別リポジトリで、この章では扱わない。

## 用語の対応表

| この章での言い方        | 近いもの                                   |
| ----------------------- | ------------------------------------------ |
| リビジョン              | グローバルな LSN / トランザクション ID     |
| main / sub リビジョン   | トランザクション ID と、その中の変更の連番 |
| compaction (mvcc)       | 古いバージョンの GC / VACUUM               |
| defrag                  | ファイルの再構築 (VACUUM FULL)             |
| backend                 | ストレージエンジン                         |
| batch tx                | ストレージエンジンへのグループコミット     |
| apply                   | ログの再生 / リカバリ適用                  |
| consistent index        | 適用済み LSN のチェックポイント            |
| スナップショット (Raft) | ログの切り詰め基準点                       |
| lease                   | TTL 付きのセッション                       |
| watcher                 | 変更データキャプチャ (CDC) の購読者        |
| ReadIndex               | 読み取り時のリーダー確認                   |
