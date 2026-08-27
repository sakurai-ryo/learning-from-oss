---
title: "「壊れないこと」をテストするために、壊し方をカタログ化し、履歴をモデルと突き合わせる"
description: "etcd の robustness テストは、ランダムな障害を注入しながら負荷をかけ、全クライアントの操作履歴を記録して、線形化可能性を機械的に検証する。過去に見つかった不具合とそれを見つけた能力が表として維持され、「昔のバグを今も再現できるか」がテスト基盤の変更の合格条件になっている。"
sidebar:
  order: 17
---

## 何を学んだか

### どんな状況の話か

分散システムの正しさは、普通のテストでは検証できない。

- **「Put して Get したら同じ値が返る」は、正常時にしか確かめていない。** 障害は、ネットワーク分断・プロセスのクラッシュ・ディスクの遅延の組み合わせで起きる。
- **バグは、特定のタイミングでしか現れない。** 「WAL を書いた直後、fsync の前にクラッシュしたら」のような条件は、狙って作らないと再現しない。
- **異常が起きても、その場では分からない。** リビジョンが 1 ずれても、そのリクエストは成功する。壊れていることは、数日後に別の形で現れる。

etcd の [`tests/robustness/README.md`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/README.md) には、実際に見つかった不具合の表が載っている。

| 不具合                                                    | 報告    | 混入したバージョン | 発見者                                   |
| --------------------------------------------------------- | ------- | ------------------ | ---------------------------------------- |
| 高負荷時のクラッシュでリビジョンが不整合 (#13766)         | 2022-03 | v3.5               | ユーザー                                 |
| 単一ノードのクラスタがクラッシュで書き込みを失う (#14370) | 2022-08 | v3.4 以前          | ユーザー                                 |
| defrag 中のクラッシュでリビジョンが不整合 (#14685)        | 2022-11 | v3.5               | **robustness (defrag を対象に含めた後)** |
| ネットワーク分断後に watch が時間を遡る (#15271)          | 2023-02 | v3.4 以前          | **robustness (分断を対象に含めた後)**    |
| ストリームの飢餓で watch イベントが失われる (#17529)      | 2024-03 | v3.4 以前          | ユーザー                                 |
| 圧縮中のクラッシュでリビジョンが減少 (#17780)             | 2024-04 | v3.4 以前          | **robustness (圧縮を対象に含めた後)**    |

**「v3.4 以前」が多い。** つまり、**何年も気づかれずに存在していたバグ** が、テスト基盤の対象範囲を広げるたびに次々と見つかっている。

そして発見者の列に **「defrag を対象に含めた後」「分断を対象に含めた後」「圧縮を対象に含めた後」** と書かれているのが、この表の主題になる。

### etcd の答え

1. **クラスタを立て、複数のクライアントから負荷をかけながら、ランダムな障害を注入する。**
2. **全クライアントの操作 (リクエスト、レスポンス、開始時刻、終了時刻) を記録する。**
3. **記録した履歴を、etcd の簡略モデルと突き合わせて線形化可能性を検証する。** [porcupine](https://github.com/anishathalye/porcupine) という検査器を使う。
4. **watch と serializable な読み取りは、別の検証器で検査する。**
5. **障害注入点を、ソースコードのコメントとして本体に埋め込む。** `// gofail: var raftBeforeSave struct{}`。
6. **失敗したら、履歴とデータディレクトリを丸ごと保存する。** 後から再検証できる。
7. **過去のバグを再現するコマンドを維持する。** テスト基盤を変えたら、それが今も再現できることを確認する。

## ソースコードのどこか

### 手順は 5 段階

README が全体像を書いている。

```markdown title="tests/robustness/README.md"
**Test Procedure:**

1. **Cluster Creation:** A new etcd cluster is created with the specified configuration.
2. **Traffic and Failures:** Client traffic is generated and sent to the cluster while failures are injected.
3. **History Collection:** All client operations and their results are recorded.
4. **Validation:** The collected history is validated against the etcd model and a set of validators to ensure consistency and correctness.
5. **Report Generation:** If a failure is detected then a detailed report is generated to help diagnose the issue.
   This report includes information about the client operations and etcd data directories.
```

**「実行」と「検証」が完全に分離されている。** 実行中は何も判定せず、履歴を集めるだけ。検証は後からまとめて行う。

これによって、

- **検証ロジックを後から改善できる。** 保存済みの履歴を再検証すればよい。
- **実行時のオーバーヘッドが小さい。** 検証は重い計算なので、実行と混ぜると時間の測定が歪む。

README にその方針が明記されている。

```markdown title="tests/robustness/README.md"
Robustness test validation is constantly changing and improving.
Errors in the etcd model could be causing false positives, which makes the ability to re-evaluate the reports after we fix the issue important.
```

**「モデル側のバグで偽陽性が出る」ことを前提にしている。** だから、報告を `testdata/` に置いて再検証できる仕組み (`make test-robustness-reports`) がある。

### 期待される振る舞いの定義

README が、etcd が何を保証するかを明示している。

```markdown title="tests/robustness/README.md"
Etcd provides strict serializability for KV operations and eventual consistency for Watch.
```

そして、一貫性モデルの用語集がそのまま README に書いてある。逐次一貫性、線形化可能性、直列化可能性、厳密直列化可能性。

**テストが何を検証しているかを理解するには、この語彙が要る。** ドキュメントの中で定義しておくことで、「このテストは何を保証しているのか」の議論が噛み合う。

### モデルは「決定的な etcd」

[`tests/robustness/model/deterministic.go#L30-L70`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/model/deterministic.go#L30-L70)。

```go title="tests/robustness/model/deterministic.go"
// DeterministicModel assumes a deterministic execution of etcd requests. All
// requests that the client called were executed and persisted by etcd. This
// assumption is good for simulating etcd behavior (aka writing a fake), but not
// for validating correctness as requests might be lost or interrupted. It
// requires perfect knowledge of what happened to a request, which is not possible
// in real systems.
//
// Model can still respond with an error or partial response.
//   - Error for etcd known errors, like future revision or compacted revision.
//   - Incomplete response when the request is correct, but the model doesn't have all
//     the data to provide a full response. For example, stale reads as the model doesn't store
//     the whole change history as real etcd does.
var DeterministicModel = func(keys []string) porcupine.Model {
	return porcupine.Model{
		Init: func() any {
			return freshEtcdState(keys)
		},
		Step: func(st any, in any, out any) (bool, any) {
			return st.(EtcdState).apply(in.(EtcdRequest), out.(EtcdResponse))
		},
```

**モデルは「状態」と「1 ステップの適用」だけで定義される。**

`Step` が返す `bool` が「この操作結果はこの状態から起こりえたか」で、porcupine はこれを使って **「観測された履歴を説明できる操作の順序が存在するか」** を探索する。存在すれば線形化可能。

モデルの状態は驚くほど小さい ([`#L72-L82`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/model/deterministic.go#L72-L82))。

```go title="tests/robustness/model/deterministic.go"
type EtcdState struct {
	Revision        int64 `json:",omitempty"`
	CompactRevision int64 `json:",omitempty"`
	// Slices below are positionally aligned. If KeyValue is nil on index i,
	// it means the key `Keys[i]` doesn't exist.
	Keys      []string         `json:",omitempty"`
	KeyValues []*ValueRevision `json:",omitempty"`
	KeyLeases []*int64         `json:",omitempty"`
	// All leases sorted by LeaseID.
	Leases []int64 `json:",omitempty"`
}
```

**リビジョン、圧縮リビジョン、キーと値、lease。これだけ。** WAL も raft も B+tree も無い。

**モデルの価値は「本物より単純であること」にある。** 本物と同じ複雑さのモデルを書いても、同じバグが両方に入るだけだ。

「モデル自身のバグで偽陽性が出る」というコメントも、この単純さの代償として認識されている。

### 「失敗した書き込み」の扱い

[`tests/robustness/validate/validate.go#L66-L100`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/validate/validate.go#L66-L100)。ここが線形化可能性検査で最も難しい部分だ。

```go title="tests/robustness/validate/validate.go"
			// For linearization, we set the return time of failed requests to MaxInt64.
			// Failed requests can still be persisted, however we don't know when the request has taken effect.
			if response.Error != "" {
				op.Return = math.MaxInt64
			}
			linearizable = append(linearizable, op)
```

**タイムアウトした書き込みは、成功したかもしれないし、していないかもしれない。**

これは分散システムの根本的な性質だ。クライアントが「タイムアウトしました」を受け取っても、サーバ側では書かれているかもしれない。**「いつ効いたか」が分からない。**

**そこで、終了時刻を無限大にする。** porcupine は「この操作は開始時刻以降のどこかで起きた (あるいは起きなかった)」として扱えるようになる。

**不確実性を、時間の区間として表現している。** 「不明」というフラグを追加するのではなく、既存の時間モデルの中で表す。

そして、対象から外すものもある。

```go title="tests/robustness/validate/validate.go"
func isLinearizable(request model.EtcdRequest, response model.MaybeEtcdResponse) bool {
	// Cannot test response for request without side effect.
	if request.IsRead() && response.Error != "" {
		return false
	}
	// Defragment is not linearizable
	if request.Type == model.Defragment {
		return false
	}
	return true
}
```

**「失敗した読み取り」は検証できない。** 副作用がないので、起きたかどうかを他の操作から推測できない。

**「検証できないものを明示的に除外し、その理由を書く」** ことで、検証の範囲が明確になる。

### 実際に何が永続化されたかを使う

[`#L32-L59`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/validate/validate.go#L32-L59)。

```go title="tests/robustness/validate/validate.go"
	if len(persistedRequests) != 0 {
		linearizableOperations = patchLinearizableOperations(linearizableOperations, reports, persistedRequests)
	}
	keys := model.ModelKeys(linearizableOperations)
	result.Linearization = validateLinearizableOperationsAndVisualize(lg, keys, linearizableOperations, timeout)
```

`persistedRequests` は、**テスト終了後に etcd のデータディレクトリ (WAL) から読み出した「実際に永続化された操作の列」** だ。

これがあると、「タイムアウトした書き込みが実際には成功していた」が確定できる。**不確実性が減ると、porcupine の探索空間が劇的に小さくなる。**

線形化可能性の検査は組み合わせ爆発を起こしやすい。**「実は答えを知っている」情報を外から与えることで、現実的な時間で終わるようにしている。**

検査の順序にも工夫がある。

```go title="tests/robustness/validate/validate.go"
	// Skip other validations if model is not linearizable, as they are expected to fail too and obfuscate the logs.
	if result.Linearization.Error() != nil {
		lg.Info("Skipping other validations as linearization failed")
		return result
	}
	if len(persistedRequests) == 0 {
		lg.Info("Skipping other validations as persisted requests were empty")
		return result
	}
	replay := model.NewReplay(persistedRequests)
	result.Watch = validateWatch(lg, cfg, reports, replay)
	result.Serializable = validateSerializableOperations(lg, serializableOperations, replay)
```

**線形化可能性が破れていたら、他の検証はやらない。** 「後続の検証も失敗して、ログを分かりにくくするから」。

**最も根本的な性質から検証して、そこが壊れていたら止める。** 派生的な検証の失敗は、根本の問題の症状にすぎない。

### 障害の注入は、ソースのコメントから

障害注入点は、etcd 本体のソースにコメントとして書かれている。

```go title="server/etcdserver/raft.go"
				// gofail: var raftBeforeSave struct{}
				if err := r.storage.Save(rd.HardState, rd.Entries); err != nil {
```

[gofail](https://github.com/etcd-io/gofail) が、ビルド時にこのコメントを実行可能なコードへ展開する。テストは HTTP 経由で「`raftBeforeSave` に到達したら panic せよ」と指示できる。

**通常のビルドではただのコメントなので、本番のコードには一切影響しない。**

注入点のカタログは 30 個以上ある ([`tests/robustness/failpoint/failpoint.go#L38-L59`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/failpoint/failpoint.go#L38-L59))。

```go title="tests/robustness/failpoint/failpoint.go"
var allFailpoints = []Failpoint{
	KillFailpoint, BeforeCommitPanic, AfterCommitPanic, RaftBeforeSavePanic, RaftAfterSavePanic,
	DefragBeforeCopyPanic, DefragBeforeRenamePanic, BackendBeforePreCommitHookPanic, BackendAfterPreCommitHookPanic,
	BackendBeforeStartDBTxnPanic, BackendAfterStartDBTxnPanic, BackendBeforeWritebackBufPanic,
	BackendAfterWritebackBufPanic, CompactBeforeCommitScheduledCompactPanic, CompactAfterCommitScheduledCompactPanic,
	CompactBeforeSetFinishedCompactPanic, CompactAfterSetFinishedCompactPanic, CompactBeforeCommitBatchPanic,
	CompactAfterCommitBatchPanic, RaftBeforeLeaderSendPanic, BlackholePeerNetwork, DelayPeerNetwork,
	RaftBeforeFollowerSendPanic, RaftBeforeApplySnapPanic, RaftAfterApplySnapPanic, RaftAfterWALReleasePanic,
	RaftBeforeSaveSnapPanic, RaftAfterSaveSnapPanic, BlackholeUntilSnapshot,
	BeforeApplyOneConfChangeSleep,
	MemberReplace,
	MemberDowngrade,
	MemberDowngradeUpgrade,
	DropPeerNetwork,
	RaftBeforeSaveSleep,
	RaftAfterSaveSleep,
	ApplyBeforeOpenSnapshot,
	SleepBeforeSendWatchResponse,
	SleepBeforeSyncWatchers,
	SleepBeforeMoveVictims,
	SleepBeforeProgressIfSync,
}
```

**この一覧が、そのまま「etcd の壊れうる場所のカタログ」になっている。**

- **`Before` / `After` が対になっている。** クリティカルな操作の前後、両方で落とす。
- **panic だけでなく `Sleep` もある。** クラッシュではなく「遅い」ことで起きるバグがある。[watcher の 3 群](../watch-sync-victim/) に関する `SleepBeforeMoveVictims` などがそれだ。
- **ネットワークの障害も同じ枠組み。** `BlackholePeerNetwork` (無応答)、`DelayPeerNetwork` (遅延)、`DropPeerNetwork` (パケットロス)。**「相手が落ちた」と「相手が遅い」は違う障害** なので、両方ある。
- **メンバーの入れ替えとダウングレードも障害として扱われている。** 運用操作が正しさを壊さないことの検証になる。

このカタログと、[圧縮のページ](../compaction-batching/) や [Ready ループのページ](../raft-ready-loop/) で見た `// gofail:` コメントが、1 対 1 で対応している。**「順序が重要な箇所」がそのまま「注入点」になっている。**

注入点の選択もランダムだ ([`#L61-L83`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/failpoint/failpoint.go#L61-L83))。

```go title="tests/robustness/failpoint/failpoint.go"
func PickRandom(clus *e2e.EtcdProcessCluster, profile traffic.Profile) (Failpoint, error) {
	availableFailpoints := make([]Failpoint, 0, len(allFailpoints))
	for _, failpoint := range allFailpoints {
		err := Validate(clus, failpoint, profile)
		if err != nil {
			continue
		}
		availableFailpoints = append(availableFailpoints, failpoint)
	}
```

**「この構成で使える注入点」を絞ってから選ぶ。** 単一ノードのクラスタでネットワーク分断はできない。**適用可能性の判定を注入点自身が持っている** ので、組み合わせの表を別に管理しなくてよい。

そして、注入の前に必ずクラスタの健全性を確認する。

```go title="tests/robustness/failpoint/failpoint.go"
	if err = verifyClusterHealth(ctx, t, clus); err != nil {
		return nil, fmt.Errorf("failed to verify cluster health before failpoint injection, err: %w", err)
	}
```

**壊す前に「壊れていないこと」を確かめる。** これがないと、前の障害から回復していない状態に次の障害を重ねて、原因の切り分けができなくなる。

### 過去のバグの再現性を維持する

README に、この章で最も特徴的な節がある。

```markdown title="tests/robustness/README.md"
## Maintaining Bug Reproducibility During Non-Trivial Changes

When performing large non-trivial changes to the robustness testing framework, it is critical to ensure that we do not lose the ability to reproduce previously discovered bugs.

**Best Practices:**

- **Establish Baseline:** Before starting a large non-trivial change, run all reproducible test cases listed in the track record table.
- **Verify Reproducibility:** After completing the change, verify that all previously reproducible bugs can still be detected.
- **Update Tracking:** Refresh the "Last reproduction commit" column with commit hash and it's creation date to confirm the new framework version works.
- **Update Commands:** If the change affects test execution, update the reproduction commands accordingly.
- **Gate Completion:** Consider the change incomplete until all regression tests continue to catch their target bugs.
```

**「テストの検出能力そのものを、回帰テストしている。**

普通のテストは「コードが正しいこと」を検証する。この節が言っているのは **「テストが、バグを見つける能力を失っていないこと」** の検証だ。

テスト基盤をリファクタリングすると、テストは全部通る。しかし **「通る」のは、正しくなったからかもしれないし、検出できなくなったからかもしれない。** 区別する方法は、**既知のバグを持つバージョンに対して走らせて、ちゃんと失敗すること** を確かめるしかない。

実装がこうなっている ([`tests/robustness/Makefile`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/Makefile))。

```makefile title="tests/robustness/Makefile"
.PHONY: test-robustness-issue14370
test-robustness-issue14370: /tmp/etcd-v3.5.4-failpoints/bin
	GO_TEST_FLAGS='-v --run=TestRobustnessRegression/Issue14370 --count 100 --failfast --bin-dir=/tmp/etcd-v3.5.4-failpoints/bin' $(TOPLEVEL_MAKE) test-robustness && \
	 echo "Failed to reproduce" || echo "Successful reproduction"
```

**成功と失敗の意味が逆転している。** テストが通ったら `Failed to reproduce`、テストが落ちたら `Successful reproduction`。

そして、**バグのあった当時のバージョン (v3.5.4) をビルドして使う。** バグ入りのバイナリを保持しているのではなく、タグからビルドし直す。

さらに手が込んでいて、**当時は存在しなかった障害注入点を、パッチで追加する** ([`tests/robustness/patches/beforeSendWatchResponse/watch.patch`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/tests/robustness/patches/beforeSendWatchResponse/watch.patch))。

```diff title="tests/robustness/patches/beforeSendWatchResponse/watch.patch"
@@ -460,6 +460,7 @@ func (sws *serverWatchStream) sendLoop() {
                        sws.mu.RUnlock()

                        var serr error
+                       // gofail: var beforeSendWatchResponse struct{}
                        if !fragmented && !ok {
                                serr = sws.gRPCStream.Send(wr)
                        } else {
```

**バグを再現するために、古いバージョンに 1 行のコメントを足す。**

`#17529` (ストリームの飢餓で watch イベントが失われる) を再現するには、`sendLoop` の中で遅延を起こす必要がある。当時のコードにはその注入点がなかったので、パッチとして持っている。

**「再現手順」がコードとして版管理されている。** 手順書ではなく、`make` 1 回で実行できる形で。

### 失敗したら、丸ごと保存する

```
/tmp/TestRobustnessRegression_Issue14370/1715157774429416550/
  ├─ server-<member>/          ← データディレクトリ丸ごと
  ├─ client-1/operations.json  ← クライアントごとの操作履歴
  ├─ client-2/watch.json       ← watch の受信履歴
  └─ history.html              ← 可視化
```

**etcd のデータディレクトリまで保存している。** WAL と db が残っていれば、「実際に何が永続化されたか」を後から確認できる。

`history.html` は porcupine が生成する可視化で、**線形化に失敗した操作の系列が図として見られる**。「どの操作とどの操作が矛盾しているか」を人間が読める形にする。

モデルが可視化のためのメソッドを持っているのは、そのためだ。

```go title="tests/robustness/model/deterministic.go"
		DescribeOperation: func(in, out any) string {
			return fmt.Sprintf("%s -> %s", describeEtcdRequest(in.(EtcdRequest)), describeEtcdResponse(...))
		},
		DescribeState: func(st any) string {
			data, err := json.MarshalIndent(st, "", "  ")
			// ...
			return "<pre>" + html.EscapeString(string(data)) + "</pre>"
		},
```

**モデルの定義に「人間向けの説明」が組み込まれている。** 検査器が「矛盾を見つけた」と言うだけでは、原因に辿り着けない。

### CI での回し方

```markdown title="tests/robustness/README.md"
    * `GO_TEST_FLAGS` - to pass additional arguments to `go test`.
      It is recommended to run tests multiple times with failfast enabled. this can be done by setting `GO_TEST_FLAGS='--count=100 --failfast'`.
```

**100 回繰り返して、1 回でも落ちたら止める。**

ランダムな障害注入は、1 回では何も見つからない。**「何回走らせるか」が、そのまま検出能力になる。** そして、落ちた瞬間に止めることで、そのときの状態が保存される。

etcd は [Antithesis](https://antithesis.com/) という決定的シミュレーション環境でも同じテストを走らせている。表の後半には「Antithesis が発見」という行が並んでいて、**同じテストをより厳しい環境で回すことで、さらに深いバグが出ている。**

## なぜそうなっているか

- **実行と検証を分けたのは、検証を後から改善したいから。** 検証ロジックにはモデルのバグが含まれる。履歴を保存しておけば、モデルを直してから再検証できる。**実行中に判定すると、その場の判定結果しか残らない。**
- **モデルを単純にしたのは、本物と同じ複雑さでは意味がないから。** モデルの目的は「あるべき振る舞い」の定義であって、実装の再現ではない。**単純だからこそ、モデルと実装の食い違いが実装のバグを示す。**
- **不確実性を「終了時刻 = 無限大」で表したのは、既存のモデルの中に収まるから。** 「不明」という第 3 の状態を追加すると、検査器のアルゴリズムを変えることになる。**時間の区間として表せば、既存の線形化可能性検査がそのまま使える。**
- **実際に永続化された操作を検証に使うのは、探索空間を減らすため。** 線形化可能性の検査は組み合わせ爆発する。**「実は答えを知っている」情報を与えられるなら、与えたほうがよい。**
- **根本的な検証が失敗したら他をやめるのは、派生的な失敗がノイズだから。** 線形化可能性が破れていれば、watch も serializable な読み取りも当然おかしい。**「本当の問題は 1 つ」を伝えるほうが、デバッグが速い。**
- **障害注入点をソースのコメントにしたのは、本番に影響を与えないため。** 条件分岐やフラグとして入れると、本番のコードパスに残る。**コメントなら、通常のビルドでは完全に消える。**
- **`Before` / `After` を対にするのは、順序に意味があるから。** 「保存する前」と「保存した後」で落ちたときの状態は違う。**片方だけでは、順序の正しさを検証したことにならない。**
- **panic だけでなく sleep も注入するのは、「遅い」ことで起きるバグがあるから。** クラッシュで壊れないコードでも、遅延で競合が顕在化することがある。**障害の種類が増えるほど、検出できるバグの種類が増える。**
- **注入点自身に「使えるか」の判定を持たせたのは、組み合わせの表を管理したくないから。** 「単一ノードでは分断できない」を中央の表に書くと、注入点を追加するたびに 2 箇所を直すことになる。
- **壊す前に健全性を確認するのは、障害を重ねないため。** 前の障害から回復していない状態に次を重ねると、どちらが原因か分からなくなる。
- **テストの検出能力を回帰テストするのは、テストが静かに壊れるから。** リファクタリングでテストが「通る」ようになっても、それが正しさの証明とは限らない。**既知のバグに対して失敗することを確かめて、初めて能力が保たれたと言える。**

## どう活かすか

- **「実行して記録する」と「記録を検証する」を分ける。** 検証ロジックは必ず後から改善したくなる。履歴が残っていれば再検証できる。実行時に判定してしまうと、判定基準を変えたときに全部走らせ直すしかない。
- **期待される振る舞いを、実装とは独立したモデルとして書く。** そのモデルは実装より圧倒的に単純でよい。**単純さがモデルの価値で、複雑にすると同じバグが両方に入る。**
- **不確実性は、既存のモデルの中で表現する方法を探す。** 「不明」というフラグを追加するより、「取りうる範囲を広げる」ほうが、既存のアルゴリズムがそのまま使えることが多い。
- **検証を、根本的なものから順に走らせて、失敗したら止める。** 派生的な検証の失敗は症状にすぎない。全部の失敗を並べると、本当の問題が埋もれる。
- **障害注入点を、本番コードにコメントとして埋め込む。** 通常のビルドでは消えるので、コストがゼロになる。**そして、「順序が重要な箇所」と「注入点」は一致する。** 片方を書くときにもう片方も考えることになる。
- **障害の種類をカタログとして持ち、対になる注入点を用意する。** クラッシュ、遅延、無応答、パケットロス、部分的な障害。**「落ちる」だけを試すテストは、「遅い」ことで起きるバグを見逃す。**
- **障害を注入する前に、正常であることを確認する。** 前の障害の影響が残っていると、結果の解釈ができない。テストが不安定になる原因の多くがここにある。
- **ランダムなテストは、繰り返し回数が検出能力になる。** 1 回で見つからないのは当たり前で、100 回・1000 回と回すことに意味がある。CI では回数を指定できるようにして、失敗したら即座に止めて状態を保存する。
- **失敗したときは、再現に必要なものを全部保存する。** 入力の履歴、出力の履歴、対象のデータディレクトリ。**「再現できない失敗」は、無かったことにされる。**
- **検査器の出力を、人間が読める形にする。** 「矛盾があります」だけでは原因に辿り着けない。モデルの定義に「この操作は何か」「この状態は何か」を人間向けに説明するメソッドを持たせる。
- **過去のバグを再現するコマンドを、コードとして維持する。** 手順書ではなく `make` 1 回で走る形にする。当時のバージョンをビルドし直し、必要なら注入点をパッチで足す。**そして、テスト基盤を変えたら、それがまだ再現できることを確認する。** これをやらないと、テストは静かに検出能力を失う。
