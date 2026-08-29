---
title: "論文の主張 1 つにテスト 1 つを対応させ、コメントに参照節を書く"
description: "raft_paper_test.go は、Raft 論文に書かれた文をテストに翻訳したファイルだ。各テストのコメントが対象の主張を英文で引用し、参照節番号を添える。init / test / check の 3 部構成という様式も宣言されている。仕様書とコードの間に追跡可能性を持たせる、地味だが強い手法を読む。"
group: "正しさの担保"
sidebar:
  order: 32
---

## 何を学んだか

**仕様書の文とテストを 1 対 1 に対応させ、対応をコメントに書く。** `raft_paper_test.go` は、Raft 論文の記述をそのままテストに翻訳した 900 行のファイルだ。テストが 26 本あり、そのすべてに「論文のどの主張を検証しているか」の英文と、参照節の番号が書かれている。

派手な仕組みではない。しかし、**仕様と実装の間に追跡可能性が生まれる**。論文のある節を変えたいとき、どのテストが影響を受けるかが分かる。逆に、テストが落ちたとき、それがどの主張の違反かが分かる。

## ソースコードのどこか

ファイル冒頭に、このファイルの目的と様式が宣言されている ([`raft_paper_test.go#L15-L26`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft_paper_test.go#L15-L26))。

```go title="raft_paper_test.go"
/*
This file contains tests which verify that the scenarios described
in the raft paper (https://raft.github.io/raft.pdf) are
handled by the raft implementation correctly. Each test focuses on
several sentences written in the paper. This could help us to prevent
most implementation bugs.

Each test is composed of three parts: init, test and check.
Init part uses simple and understandable way to simulate the init state.
Test part uses Step function to generate the scenario. Check part checks
outgoing messages and state.
*/
```

2 つのことが書かれている。

**対象**: 「各テストは論文に書かれた数個の文に焦点を当てる」。テストの単位が関数でも機能でもなく、**論文の文** になっている。

**様式**: 「init / test / check の 3 部構成」。初期状態を単純で分かりやすい方法で作り、`Step` でシナリオを起こし、出ていくメッセージと状態を検査する。**すべてのテストが同じ形をしている** ことが宣言されている。

## テストの形

いちばん短いテスト ([`raft_paper_test.go#L91-L96`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft_paper_test.go#L91-L96))。

```go title="raft_paper_test.go"
// TestStartAsFollower tests that when servers start up, they begin as followers.
// Reference: section 5.2
func TestStartAsFollower(t *testing.T) {
	r := newTestRaft(1, 10, 1, newTestMemoryStorage(withPeers(1, 2, 3)))
	assert.Equal(t, StateFollower, r.state)
}
```

論文の「サーバは起動時にフォロワーとして始まる」という 1 文に対して、2 行のテスト。`Reference: section 5.2` が付く。

もう少し長いもの ([`raft_paper_test.go#L46-L70`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft_paper_test.go#L46-L70))。

```go title="raft_paper_test.go"
// testUpdateTermFromMessage tests that if one server’s current term is
// smaller than the other’s, then it updates its current term to the larger
// value. If a candidate or leader discovers that its term is out of date,
// it immediately reverts to follower state.
// Reference: section 5.1
func testUpdateTermFromMessage(t *testing.T, state StateType) {
	r := newTestRaft(1, 10, 1, newTestMemoryStorage(withPeers(1, 2, 3)))
	switch state {
	case StateFollower:
		r.becomeFollower(1, 2)
	case StateCandidate:
		r.becomeCandidate()
	case StateLeader:
		r.becomeCandidate()
		r.becomeLeader()
	}

	r.Step(&pb.Message{Type: pb.MsgApp.Enum(), Term: new(uint64(2))})

	assert.Equal(t, uint64(2), r.Term)
	assert.Equal(t, StateFollower, r.state)
}
```

コメントが **論文の文をほぼそのまま引用している**。引用符の `’` がタイポグラフィのアポストロフィになっているのは、PDF からコピーした痕跡だろう。

3 部構成が空行で区切られている。`switch` までが init、`r.Step(...)` が test、`assert` 2 つが check。

そしてこの関数は、3 つのテストから呼ばれる ([`raft_paper_test.go#L39-L45`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft_paper_test.go#L39-L45))。

```go title="raft_paper_test.go"
func TestFollowerUpdateTermFromMessage(t *testing.T) {
	testUpdateTermFromMessage(t, StateFollower)
}
func TestCandidateUpdateTermFromMessage(t *testing.T) {
	testUpdateTermFromMessage(t, StateCandidate)
}
func TestLeaderUpdateTermFromMessage(t *testing.T) {
	testUpdateTermFromMessage(t, StateLeader)
}
```

**役割ごとに独立したテスト名を持たせている**。テーブル駆動で 1 本にまとめれば済むところを、あえて 3 本に分けている。

利点は、`go test -run TestLeaderUpdateTermFromMessage` で狙い撃ちできることと、**失敗したときにどの役割で壊れたかがテスト名で分かる** ことだ。テーブル駆動だと `#2` のようなインデックスで報告されるので、名前を引き直す必要がある。

同じパターンが `TestFollowerElectionTimeoutRandomized` / `TestCandidateElectionTimeoutRandomized` にもある。

## 実装が論文と違うときも書く

論文どおりでない箇所は、そのことを書く ([`raft_paper_test.go#L73-L77`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft_paper_test.go#L73-L77))。

```go title="raft_paper_test.go"
// TestRejectStaleTermMessage tests that if a server receives a request with
// a stale term number, it rejects the request.
// Our implementation ignores the request instead.
// Reference: section 5.1
func TestRejectStaleTermMessage(t *testing.T) {
```

**「論文は拒否すると書いているが、この実装は無視する」**。1 行で差分が記録されている。

論文と実装の乖離は、[メンバー変更](../membership-basics/) のように README に書かれている大きなものもあれば、こういう細かいものもある。**乖離をテストのコメントに残しておく** と、後から「論文と違うのはバグか意図か」を判断できる。

## 検査の書き方

`TestRejectStaleTermMessage` の検査方法が独特だ。

```go title="raft_paper_test.go"
func TestRejectStaleTermMessage(t *testing.T) {
	called := false
	fakeStep := func(_ *raft, _ *pb.Message) error {
		called = true
		return nil
	}
	r := newTestRaft(1, 10, 1, newTestMemoryStorage(withPeers(1, 2, 3)))
	r.step = fakeStep
	r.loadState(&pb.HardState{Term: new(uint64(2))})

	r.Step(&pb.Message{Type: pb.MsgApp.Enum(), Term: new(r.Term - 1)})

	assert.False(t, called)
}
```

`r.step` を差し替えて、**役割ごとの処理関数が呼ばれないこと** を確認している。[複製状態機械のページ](../replicated-state-machine/) で見た「役割ごとに `step` を差し替える」設計が、テストからの差し替えを容易にしている。

古い任期のメッセージが弾かれるのは `Step` の冒頭なので、`r.step` に到達しない。「到達しないこと」を、フラグ 1 つで検査する。

ランダム化のテストは統計的だ ([`raft_paper_test.go#L278-L305`](https://github.com/etcd-io/raft/blob/af7bf26c25cacf88c26db8751e78af2badbda5d8/raft_paper_test.go#L278-L305))。

```go title="raft_paper_test.go"
func testNonleaderElectionTimeoutRandomized(t *testing.T, state StateType) {
	et := 10
	r := newTestRaft(1, et, 1, newTestMemoryStorage(withPeers(1, 2, 3)))
	timeouts := make(map[int]bool)
	for round := 0; round < 50*et; round++ {
		// ...
		time := 0
		for len(r.readMessages()) == 0 {
			r.tick()
			time++
		}
		timeouts[time] = true
	}

	for d := et; d < 2*et; d++ {
		// [et, 2*et) のすべての値が現れたことを確認
	}
```

500 回まわして、`[et, 2*et)` の **すべての値が少なくとも 1 回は出る** ことを確認する。「ランダムである」を「取りうる値が全部出る」に翻訳している。[ランダム化タイムアウトのページ](../randomized-timeout/) で見た仕様が、こう検査されている。

回数が `50*et` = 500 回なので、10 通りの値が全部出ない確率は無視できるほど小さい。**確率的なテストだが、失敗確率が実質ゼロになる回数を選んでいる**。

## テストの総量

このリポジトリのテストコードは 11900 行あり、テストを除いた本体が 11626 行なので、**ほぼ 1 対 1** になる。内訳はこうなる。

| ファイル                 | 行数   | 性格                                                 |
| ------------------------ | ------ | ---------------------------------------------------- |
| `raft_test.go`           | 141 KB | 単体テスト全般                                       |
| `rawnode_test.go`        | 33 KB  | `RawNode` の API                                     |
| `log_test.go`            | 34 KB  | ログ操作                                             |
| `raft_paper_test.go`     | 28 KB  | 論文の主張                                           |
| `testdata/*.txt` (28 本) | —      | [datadriven テスト](../datadriven-tests/)            |
| `tla/`                   | —      | [モデル検査とトレース検証](../tla-trace-validation/) |

`raft_paper_test.go` は全体の一部でしかない。しかし、**「論文どおりか」を確認する層** が独立して存在することに意味がある。他のテストは実装の詳細を見るが、このファイルだけは仕様を見る。

リファクタリングで実装が変わっても、このファイルのテストは通り続けるはずだ。通らなくなったら、仕様に関わる変更をしたということになる。

## なぜそうなっているか

「テストが仕様書を参照する」形式の利点は、**双方向に辿れる** ことにある。

- **仕様 → テスト**: 論文の 5.4.2 節を実装したか確認したい → `grep "section 5.4.2"` で該当テストが見つかる。
- **テスト → 仕様**: テストが落ちた → コメントを読めば、どの主張の違反かが分かる。

これがないと、テスト名から仕様を推測することになる。`TestLeaderOnlyCommitsLogFromCurrentTerm` という名前は説明的だが、なぜそれが必要かまでは分からない。コメントに `Reference: section 5.4.2` があれば、論文を開いて [図 8 の議論](../commit-rule/) に辿り着ける。

そして、この対応関係は **仕様が文書として存在する** 場合にしか作れない。Raft には論文があり、節番号があり、主張が文として書かれている。だから 1 対 1 の対応が付けられる。

仕様書のないプロジェクトでも、同じことは部分的にできる。要件、issue、設計文書の見出し。**「なぜこのテストがあるか」を外部の何かに紐付ける** という形は、対象が何であれ機能する。

[datadriven テスト](../datadriven-tests/) のファイル冒頭コメントに issue の URL が貼ってあるのも、同じ発想の別の形になる。

## どう活かすか

- **仕様の文とテストを 1 対 1 に対応させる**。仕様書、要件、RFC、論文。参照可能な文書があるなら、テストのコメントに節番号や見出しを書く。双方向に辿れるようになる。
- **テストの様式をファイル冒頭で宣言する**。「init / test / check の 3 部構成」のような様式があると、書く人も読む人も迷わない。テストのレビューで「なぜこの形か」を議論しなくて済む。
- **仕様との差分をテストのコメントに残す**。「論文は X と書いているが、この実装は Y する」。差分が意図的であることの記録になる。
- **バリエーションはテーブルではなく別テスト名にすることも検討する**。失敗時にどのケースかが名前で分かる、狙い撃ちで実行できる、という利点がある。ケースが少なく、名前を付ける価値があるなら分ける。
- **確率的な性質は「取りうる値が全部出る」に翻訳する**。「ランダムである」を直接検査するのは難しいが、十分な回数まわして値域が埋まることは検査できる。失敗確率が無視できる回数を選ぶ。
- **仕様を見る層を、実装の詳細を見る層と分ける**。リファクタリングで壊れないテスト群があると、「これが落ちたら仕様に関わる変更だ」という信号になる。
