---
title: "テストを「コマンドと出力のテキスト」にすると、差分がそのまま仕様の変更になる"
description: "etcd-io/raft のテストの中心は、コマンドと期待出力を並べた 28 本のテキストファイルだ。ノードを立て、メッセージを手で配送し、収束させ、その過程で流れたメッセージを 1 通残らず記録する。期待値は -rewrite で自動生成し、人間は差分だけを見る。この形式が成立している前提と、それが可能にしたことを読む。"
group: "正しさの担保"
sidebar:
  order: 30
---

## 何を学んだか

**期待値を手で書かず、生成して差分を読む。** `etcd-io/raft` のテストの中心は `testdata/` にある 28 本のテキストファイルで、それぞれが「コマンド」と「そのときの出力」を交互に並べたものになっている。

期待値は `-rewrite` フラグで自動生成される。テストを書く人が書くのは **コマンドの並びだけ** で、出力は実行結果がそのまま入る。コードを変えたら、再生成して差分を読む。差分が意図どおりならコミットする。

この形式が成立しているのは、ライブラリが [I/O を持たず](../ready-loop/)、[時計を読まず](../randomized-timeout/)、[すべての入力がメッセージ](../everything-is-a-message/) だからだ。**決定性への投資が、テストの形を変えている**。

## ソースコードのどこか

テストの本体は 12 行しかない ([`interaction_test.go`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/interaction_test.go))。

```go title="interaction_test.go"
func TestInteraction(t *testing.T) {
	// NB: if this test fails, run `go test ./raft -rewrite` and inspect the
	// diff. Only commit the changes if you understand what caused them and if
	// they are desired.
	datadriven.Walk(t, "testdata", func(t *testing.T, path string) {
		env := rafttest.NewInteractionEnv(&rafttest.InteractionOpts{
			SetRandomizedElectionTimeout: raft.SetRandomizedElectionTimeout,
		})
		datadriven.RunTest(t, path, func(t *testing.T, d *datadriven.TestData) string {
			return env.Handle(t, *d)
		})
	})
}
```

冒頭のコメントが運用方法そのものになっている。**「失敗したら `-rewrite` して差分を見ろ。何が原因か理解していて、それが望ましい変更である場合だけコミットしろ」**。

テストの失敗が「バグ」ではなく「仕様の変更」として扱われる。差分のレビューが、変更の影響範囲のレビューになる。

## ファイルの形

いちばん短いファイルを見る ([`testdata/single_node.txt`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/testdata/single_node.txt))。

```text title="testdata/single_node.txt"
log-level info
----
ok

add-nodes 1 voters=(1) index=3
----
INFO 1 switched to configuration voters=(1)
INFO 1 became follower at term 0
INFO newRaft 1 [peers: [1], term: 0, commit: 3, applied: 3, lastindex: 3, lastterm: 1]

campaign 1
----
INFO 1 is starting a new election at term 0
INFO 1 became candidate at term 1

stabilize
----
> 1 handling Ready
  Ready MustSync=true:
  Lead:0 State:StateCandidate
  HardState Term:1 Vote:1 Commit:3
  INFO 1 received MsgVoteResp from 1 at term 1
  INFO 1 has received 1 MsgVoteResp votes and 0 vote rejections
  INFO 1 became leader at term 1
> 1 handling Ready
  Ready MustSync=true:
  Lead:1 State:StateLeader
  Entries:
  1/4 EntryNormal ""
> 1 handling Ready
  Ready MustSync=false:
  Lead:1 State:StateLeader
  HardState Term:1 Vote:1 Commit:4
  CommittedEntries:
  1/4 EntryNormal ""
```

`----` の上がコマンド、下が期待出力。**内部のログ出力まで期待値に含まれている**。

このファイルを読むだけで、1 台構成の選挙で何が起きるかが分かる。任期と投票が先に永続化され (`HardState Term:1 Vote:1`)、その後で自分への投票が処理され、リーダーになり、空エントリが書かれ、それがコミットされる。[永続化のページ](../persistent-state/) で説明した順序が、そのまま観察できる。

`MustSync=true` が 2 回、`false` が 1 回出ている。[MustSync](../persistent-state/) の判定 — エントリが増えたか、任期か投票が変わったとき `true` — が、この 3 行で確認できる。

## コマンドの語彙

`Handle` の `switch` が、使えるコマンドの一覧になっている ([`rafttest/interaction_env_handler.go`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rafttest/interaction_env_handler.go))。

| コマンド                                         | 意味                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `add-nodes`                                      | ノードを作る (`voters=` `learners=` `index=` `async-storage-writes=`) |
| `campaign`                                       | 指定ノードを立候補させる                                              |
| `propose` / `propose-conf-change`                | 提案する                                                              |
| `deliver-msgs`                                   | 指定の宛先へのメッセージを配送する                                    |
| `process-ready`                                  | `Ready` を 1 回処理する                                               |
| `process-append-thread` / `process-apply-thread` | 非同期ストレージのスレッドを 1 歩進める                               |
| `stabilize`                                      | 何も起きなくなるまで回す                                              |
| `tick-election` / `tick-heartbeat`               | tick を刻む                                                           |
| `set-randomized-election-timeout`                | 乱数を固定する                                                        |
| `compact`                                        | ログを圧縮する                                                        |
| `send-snapshot`                                  | スナップショットを送る                                                |
| `report-unreachable`                             | 到達不能を報告する                                                    |
| `transfer-leadership` / `forget-leader`          | リーダー移譲・リーダーを忘れる                                        |
| `raft-log` / `raft-state` / `status`             | 状態を出力する                                                        |
| `log-level`                                      | 出力の詳細度を変える                                                  |

**Raft の全機能に対応するコマンドが揃っている**。しかも `deliver-msgs` が宛先を指定できるので、「このノードにだけ届ける」「このメッセージだけ落とす」という分断のシミュレーションができる。

デバッグ用のコマンドまである。

```go title="rafttest/interaction_env_handler.go"
	case "_breakpoint":
		// This is a helper case to attach a debugger to when a problem needs
		// to be investigated in a longer test file. In such a case, add the
		// following stanza immediately before the interesting behavior starts:
		//
		// _breakpoint:
		// ----
		// ok
		//
		// and set a breakpoint on the `case` above.
```

**テストファイルの中にブレークポイントを置ける**。740 行のテストの途中で何が起きているかを調べたいとき、`_breakpoint` を挿入して、`case` の行にデバッガを仕掛ける。テキストのテストにデバッガを繋ぐ手段が用意されている。

## stabilize という抽象

`stabilize` が、このテスト形式を実用にしている ([`rafttest/interaction_env_handler_stabilize.go#L47-L80`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/rafttest/interaction_env_handler_stabilize.go#L47-L80))。

```go title="rafttest/interaction_env_handler_stabilize.go"
// Stabilize repeatedly runs Ready handling on and message delivery to the set
// of nodes specified via the idxs slice until reaching a fixed point.
func (env *InteractionEnv) Stabilize(idxs ...int) error {
	// ...
	for {
		done := true
		for _, rn := range nodes {
			if rn.HasReady() {
				idx := int(rn.Status().ID - 1)
				fmt.Fprintf(env.Output, "> %d handling Ready\n", idx+1)
				var err error
				env.withIndent(func() { err = env.ProcessReady(idx) })
				if err != nil {
					return err
				}
				done = false
			}
		}
```

**不動点に達するまで回す**。`Ready` があるノードを処理し、メッセージがあれば配送し、何も起きなくなったら止まる。

これがあるので、「選挙が終わるまで」「複製が完了するまで」を 1 コマンドで書ける。ステップ数を数えて `process-ready` を並べる必要がない。実装が変わってステップ数が増減しても、コマンド側は変わらない。

そして引数でノードを絞れる。`stabilize 1 2` と書けば、ノード 1 と 2 の間だけを収束させる。**ノード 3 を分断した状態でクラスタを進める** ことが、これで表現できる。

## 分断とシナリオの記述

`testdata/probe_and_replicate.txt` は、この形式で書ける複雑さの上限に近い。

```text title="testdata/probe_and_replicate.txt"
# This test creates a complete Raft log configuration and demonstrates how a
# leader probes and replicates to each of its followers. The log configuration
# constructed is almost[*] identical to the one present in Figure 7 of the raft
# paper (https://raft.github.io/raft.pdf), which looks like:
#
#      1  2  3  4  5  6  7  8  9  10 11 12
# n1: [1][1][1][4][4][5][5][6][6][6]
# n2: [1][1][1][4][4][5][5][6][6]
# n3: [1][1][1][4]
# n4: [1][1][1][4][4][5][5][6][6][6][6]
# n5: [1][1][1][4][4][5][5][6][7][7][7][7]
# n6: [1][1][1][4][4][4][4]
# n7: [1][1][1][2][2][2][3][3][3][3][3]
#
# Once in this state, we then elect node 1 as the leader and stabilize the
# entire raft group. This demonstrates how a newly elected leader probes for
# matching indexes, overwrites conflicting entries, and catches up all
# followers.
```

7 ノードそれぞれに異なるログを持たせる。そのために、リーダー交代とメッセージの配送先を細かく制御している。コメントがそれを認めている。

```text
# Set up the log configuration. This is mostly unintersting, but the order of
# each leadership change and the nodes that are allowed to hear about them is
# very important. Most readers of this test can skip this section.
```

**「ここは読み飛ばしていい」と書いてある**。テストファイルが読み物として設計されている。前半がセットアップ、後半が観察対象、という構成が明示されている。

出力は 740 行あり、リーダーが 6 台のフォロワーそれぞれをどう探り、どう追いつかせたかが全部記録されている。[探索の最適化](../probe-optimization/) が実際に何往復で収束するかが、このファイルを読めば分かる。

## テストが説明文書になっている

いくつかのファイルは、冒頭のコメントが実装のコメントより詳しい。

```text title="testdata/campaign_learner_must_vote.txt"
# Regression test that verifies that learners can vote. This holds only in the
# sense that if a learner is asked to vote, a candidate believes that they are a
# voter based on its current config, which may be more recent than that of the
# learner. If learners which are actually voters but don't know it yet don't
# vote in that situation, the raft group may end up unavailable despite a quorum
# of voters (as of the latest config) being available.
#
# See:
# https://github.com/etcd-io/etcd/pull/10998
```

```text title="testdata/lagging_commit.txt"
# This test demonstrates the effect of delayed commit on a follower node after a
# network hiccup between the leader and this follower.
```

**「回帰テスト」「〜を実演する」といった動機が書かれ、関連する PR へのリンクがある**。テストファイルが、その挙動がなぜ必要かの記録になっている。

ファイル名も語っている。`heartbeat_resp_recovers_from_probing.txt`、`snapshot_succeed_via_app_resp_behind.txt`、`async_storage_writes_append_aba_race.txt`。**何を守っているかがファイル名で分かる**。

## この形式が成立する条件

datadriven テストは強力だが、成立する前提がある。

**出力が決定的であること**。同じコマンド列に同じ出力が返らなければ、期待値を固定できない。`etcd-io/raft` は I/O も時計も持たず、乱数は 1 か所でテストから固定できるので、これを満たす。

**マップの反復順序も問題になる**。Go のマップは反復順序が不定なので、そのまま出力すると毎回変わる。`ProgressTracker.Visit` は明示的にソートしている ([`tracker/tracker.go#L184-L206`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/tracker/tracker.go#L184-L206))。

```go title="tracker/tracker.go"
	slices.Sort(ids)
	for _, id := range ids {
		f(id, p.Progress[id])
	}
```

`campaign` の宛先の並びも同様にソートされている ([`raft.go#L1041-L1049`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft.go#L1041-L1049))。**決定性のために、本番コードの側にソートが入っている**。

**状態を読みやすく出力できること**。`util.go` の `DescribeMessage` / `DescribeEntry` / `DescribeReady` がこれを担う ([`util.go#L109-L265`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/util.go#L109-L265))。`1/4 EntryNormal ""` のような簡潔な表記が、740 行の出力を読めるものにしている。

`quorum` パッケージの `Describe` (進捗のバー表示) も、この目的で作られている。

## なぜそうなっているか

Go の通常のテーブル駆動テストで同じことを書くとどうなるか。

```go
// こう書くことになる
tests := []struct{
	name string
	setup func(*raft)
	msgs []pb.Message
	wantMsgs []pb.Message
	wantState StateType
	// ...
}{ /* ... */ }
```

期待値を構造体リテラルで手書きすることになる。メッセージ 1 通に 8 フィールドあるので、20 通のやり取りを記述するだけで数百行になる。しかも **読んでも何が起きているか分からない**。

実際、`raft_test.go` は 141 KB あり、この形式のテストも多数含まれている。単体の関数を狙うテストにはそちらが適している。datadriven テストは、**複数ノードにまたがる時系列の振る舞い** を対象にしている。

そして、この形式の本当の利点は **期待値を書かなくていい** ことだ。テストを書く人はシナリオ (コマンドの並び) だけを考える。出力は実装が生成する。実装を変えたら再生成する。

その代わり、**差分を読む責任** が生じる。`-rewrite` は正しさを検証しない。だから `interaction_test.go` のコメントが「何が原因か理解していて、望ましい変更である場合だけコミットしろ」と念を押している。

## どう活かすか

- **期待値を書かず、生成して差分を読む**。シナリオだけを人が書き、出力は実行結果を採る。仕様変更が差分として見える形になる。
- **決定性のために本番コードを調整する**。マップの反復をソートする、乱数を 1 か所に集める、時計を読まない。テスト容易性のための設計変更として正当化できる。
- **不動点まで進める操作を用意する**。`stabilize` のような「落ち着くまで回す」コマンドがあると、実装のステップ数に依存しないテストが書ける。
- **状態を読みやすく出力する関数を作る**。テスト出力が読めなければ、差分をレビューできない。`Describe*` に相当する関数への投資が要る。
- **テストファイルに動機と参照を書く**。「なぜこの挙動が必要か」「どの issue で見つかったか」を残すと、テストが仕様の記録になる。
- **テストファイル内にデバッガの足場を用意する**。長いシナリオでは、途中で止める手段がないと調査ができない。
- **差分レビューの責任を明記する**。自動生成された期待値をそのままコミットする運用は、レビューが機能しないと形骸化する。
