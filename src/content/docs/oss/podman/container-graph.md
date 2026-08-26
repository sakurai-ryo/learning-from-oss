---
title: "依存を 1 箇所に集約して DAG を組み、起動は外向き、停止は内向きの鏡像走査にする"
description: "Pod 内のコンテナ依存 (--requires、namespace 共有、infra) を Dependencies() で一本化し、循環があれば操作を拒否する。起動は「依存される側 → 依存する側」の逐次走査、停止と削除は「依存する側 → 依存される側」の並列走査で、訪問済みマークは処理完了後に付けてレースを防ぐ。グラフが組めないときは無順序ループに縮退し、破壊的な縮退は --force でだけ許す。"
sidebar:
  order: 13
---

## 何を学んだか

### どんな状況の話か

Pod の中のコンテナには順序がある。`--pod` で参加したコンテナは infra コンテナの network namespace を借りているので、infra が先に止まるとネットワークが消える。`--network=container:foo` や `--pid=container:foo` も同じで、`--requires` は明示的な依存だ。`podman pod start` は依存される側を先に、`podman pod stop` は依存する側を先に処理しなければならない。

そして Podman は 2018 年に起動順序のためにグラフを入れ、2020 年に「停止が遅すぎる」ので停止を無順序で並列化し、2025 年に「無順序だと infra が先に死ぬ」問題で停止も順序付き並列に戻した。このジグザグが、設計の「なぜ」の中核になっている。

### Podman の答え

1. **依存の発生源を 1 つの関数に集約する。** `Container.Dependencies()` が namespace 共有 (`IPCNsCtr`, `NetNsCtr`, `PIDNsCtr`...) と `--requires` の両方を集めて返す。infra コンテナへの依存は「namespace を infra から借りている」ことの帰結で、特別扱いではない。
2. **グラフを組む時点で循環を検出し、組めなければ操作を拒否する。** `BuildContainerGraph` は Tarjan の強連結成分で循環を見つけ、依存先が入力に無ければ `ErrNoSuchCtr` を返す。
3. **起動は外向き走査で逐次。** `startNode` は依存 (`dependsOn`) が全部訪問済みになるまで自分を処理せず、処理したら自分に依存する側 (`dependedOn`) へ再帰する。複数の親を持つノードは最後の親の再帰で処理され、トポロジカル順序が再帰で実現される。
4. **停止と削除は内向き走査で並列。** `traverseNodeInwards` は起動の鏡像 (`dependedOn` ↔ `dependsOn`) で、ノード単位のロックと同期 map で並列に走る。訪問済みマークは **操作が完了してから** 付ける。
5. **エラーは下流に伝播する。** あるノードの操作が失敗したら、それに依存する側 (起動時) / それが依存する側 (停止時) はすべて `ErrCtrStateInvalid` で失敗扱いにし、操作を試みない。部分失敗は `map[id]error` + `ErrPodPartialFail` で返す。
6. **グラフが組めないときの縮退経路を持つ。** `pod stop` は無順序ループに落ち、`pod rm` は `--force` のときだけ `IgnoreDeps: true` の削除に落ちる。

## ソースコードのどこか

### 依存の集約

[`libpod/container.go#L504-L542`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container.go#L504-L542)。

```go title="libpod/container.go"
// Dependencies gets the containers this container depends upon
func (c *Container) Dependencies() []string {
	// Collect in a map first to remove dupes
	dependsCtrs := map[string]bool{}

	// First add all namespace containers
	if c.config.IPCNsCtr != "" {
		dependsCtrs[c.config.IPCNsCtr] = true
	}
	if c.config.MountNsCtr != "" {
		dependsCtrs[c.config.MountNsCtr] = true
	}
	if c.config.NetNsCtr != "" {
		dependsCtrs[c.config.NetNsCtr] = true
	}
	if c.config.PIDNsCtr != "" {
		dependsCtrs[c.config.PIDNsCtr] = true
	}
	/* ... UserNsCtr, UTSNsCtr, CgroupNsCtr ... */

	// Add all generic dependencies
	for _, id := range c.config.Dependencies {
		dependsCtrs[id] = true
	}
```

`--pod` の PID / network 共有は [`pkg/specgen/generate/namespaces.go#L147-L153`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/namespaces.go#L147-L153) と [`#L331-L336`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/namespaces.go#L331-L336) で `WithPIDNSFrom(infraCtr)` / `WithNetNSFrom(infraCtr)` になり、`--requires` は [`container_create.go#L699-L709`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/container_create.go#L699-L709) で `WithDependencyCtrs` になる。どちらも最終的に `config` のフィールドに落ち、`Dependencies()` が読む。

### グラフの構築と循環検出

[`libpod/container_graph.go#L18-L31`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_graph.go#L18-L31)。

```go title="libpod/container_graph.go"
type containerNode struct {
	lock       sync.Mutex
	id         string
	container  *Container
	dependsOn  []*containerNode
	dependedOn []*containerNode
}

// ContainerGraph is a dependency graph based on a set of containers.
type ContainerGraph struct {
	nodes              map[string]*containerNode
	noDepNodes         []*containerNode
	notDependedOnNodes map[string]*containerNode
}
```

`noDepNodes` が起動の出発点、`notDependedOnNodes` が停止と削除の出発点。両方を持つのは、2 方向の走査があるからだ。

[`#L47-L99`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_graph.go#L47-L99) の `BuildContainerGraph`。

```go title="libpod/container_graph.go"
	// Now add edges based on dependencies
	for _, node := range graph.nodes {
		deps := node.container.Dependencies()
		for _, dep := range deps {
			// Get the dep's node
			depNode, ok := graph.nodes[dep]
			if !ok {
				return nil, fmt.Errorf("container %s depends on container %s not found in input list: %w", node.id, dep, define.ErrNoSuchCtr)
			}

			// Add the dependent node to the node's dependencies
			// And add the node to the dependent node's dependedOn
			node.dependsOn = append(node.dependsOn, depNode)
			depNode.dependedOn = append(depNode.dependedOn, node)

			// The dependency now has something depending on it
			delete(graph.notDependedOnNodes, dep)
		}
		/* ... */
	}

	// Need to do cycle detection
	// We cannot start or stop if there are cyclic dependencies
	cycle, err := detectCycles(graph)
	if err != nil {
		return nil, err
	} else if cycle {
		return nil, fmt.Errorf("cycle found in container dependency graph: %w", define.ErrInternal)
	}
```

`detectCycles` ([`#L101-L117`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_graph.go#L101-L117)) は Tarjan の強連結成分アルゴリズムだが、SCC を列挙する代わりに「サイズ 2 以上の SCC が見つかった瞬間」に `true` を返して打ち切る簡略版だ。テスト ([`libpod/container_graph_test.go#L179-L203`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_graph_test.go#L179-L203)) は `UserNsCtr` や `NetNsCtr` を直接書き換えて依存を作っていて、依存の実体が config のフィールドであることが分かる。

### 起動: 外向きの逐次走査

[`#L200-L290`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_graph.go#L200-L290) の `startNode`。

```go title="libpod/container_graph.go"
	// If setError is true, a dependency of us failed
	// Mark us as failed and recurse
	if setError {
		// Mark us as visited, and set an error
		ctrsVisited[node.id] = true
		ctrErrors[node.id] = fmt.Errorf("a dependency of container %s failed to start: %w", node.id, define.ErrCtrStateInvalid)

		// Hit anyone who depends on us, and set errors on them too
		for _, successor := range node.dependedOn {
			startNode(ctx, successor, true, ctrErrors, ctrsVisited, restart)
		}

		return
	}

	// Have all our dependencies started?
	// If not, don't visit the node yet
	depsVisited := true
	for _, dep := range node.dependsOn {
		depsVisited = depsVisited && ctrsVisited[dep.id]
	}
	if !depsVisited {
		// Don't visit us yet, all dependencies are not up
		// We'll hit the dependencies eventually, and when we do it will
		// recurse here
		return
	}

	// Going to try to start the container, mark us as visited
	ctrsVisited[node.id] = true
```

「依存が全部訪問済みでなければ自分はまだやらない」で、ダイヤモンド型の依存でも最後の親の再帰で 1 回だけ処理される。`ctrsVisited` は普通の map で、逐次前提だ。起動する瞬間だけコンテナのロックを取る (2018 年の "Do not lock all containers during pod start" 以来の設計)。

### 停止と削除: 内向きの並列走査

[`#L367-L442`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_graph.go#L367-L442) の `traverseNodeInwards`。

```go title="libpod/container_graph.go"
// Perform a traversal of the graph in an inwards direction - meaning from nodes
// with no dependencies, recursing inwards to the nodes they depend on.
// Safe to run in parallel on multiple nodes.
func traverseNodeInwards(node *containerNode, nodeDetails *nodeTraversal, setError bool) {
	node.lock.Lock()

	// If we already visited this node, we're done.
	visited := nodeDetails.ctrsVisited.Exists(node.id)
	if visited {
		node.lock.Unlock()
		return
	}
	/* ... setError の伝播 ... */

	// Does anyone still depend on us?
	// Cannot stop if true. Once all our dependencies have been stopped,
	// we will be stopped.
	for _, dep := range node.dependedOn {
		// The container that depends on us hasn't been removed yet.
		// OK to continue on
		ok := nodeDetails.ctrsVisited.Exists(dep.id)
		if !ok {
			node.lock.Unlock()
			return
		}
	}

	ctrErrored := false
	if err := nodeDetails.actionFunc(node.container, nodeDetails.pod); err != nil {
		ctrErrored = true
		nodeDetails.ctrErrors.Put(node.id, err)
	}

	// Mark as visited *only after* finished with operation.
	// This ensures that the operation has completed, one way or the other.
	// If an error was set, only do this after the viral ctrErrored
	// propagates in traverseNodeInwards below.
	// Same with the node lock - we don't want to release it until we are
	// marked as visited.
	if !ctrErrored {
		nodeDetails.ctrsVisited.Put(node.id, true)

		node.lock.Unlock()
	}

	// Recurse to anyone who we depend on and work on them
	for _, successor := range node.dependsOn {
		traverseNodeInwards(successor, nodeDetails, ctrErrored)
	}

	// If we propagated an error, finally mark us as visited here, after
	// all nodes we traverse to have already been marked failed.
	// If we don't do this, there is a race condition where a node could try
	// and perform its operation before it was marked failed by the
	// traverseNodeInwards triggered by this process.
	if ctrErrored {
		nodeDetails.ctrsVisited.Put(node.id, true)

		node.lock.Unlock()
	}
}
```

`startNode` と鏡像だが、並列で走る前提で 2 つの規律が加わっている。訪問済みマークは操作の完了後に付ける (先に付けると、まだ止まっていないコンテナに依存される側が止まり始める)。エラーを伝播する場合は、伝播が終わるまでマークもロックも保留する (先に付けると、失敗マークが届く前に下流が操作を始める)。

並列化は出発点の数だけ ([`#L483-L503`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_graph.go#L483-L503))。

```go title="libpod/container_graph.go"
	for _, node := range graph.notDependedOnNodes {
		doneChan := parallel.Enqueue(ctx, func() error {
			traverseNodeInwards(node, nodeDetails, false)
			return nil
		})
		doneChans = append(doneChans, doneChan)
	}

	// We don't care about the returns values, these functions always return nil
	// But we do need all of the parallel jobs to terminate.
	for _, doneChan := range doneChans {
		<-doneChan
	}
```

`parallel.Enqueue` ([`pkg/parallel/parallel.go#L13-L64`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/parallel/parallel.go#L13-L64)) は重み付きセマフォで、上限は hidden フラグ `--max-workers` (既定 `NumCPU*3+1`、[`cmd/podman/root.go#L638`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/root.go#L638))。再帰先は enqueue しないので、深い依存チェーンは 1 goroutine で逐次処理される。

### 呼び出し側と縮退

`Pod.Start` ([`libpod/pod_api.go#L61-L120`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/pod_api.go#L61-L120))。

```go title="libpod/pod_api.go"
	// Build a dependency graph of containers in the pod
	graph, err := BuildContainerGraph(allCtrs)
	if err != nil {
		return nil, fmt.Errorf("generating dependency graph for pod %s: %w", p.ID(), err)
	}
	// If there are no containers without dependencies, we can't start
	// Error out
	if len(graph.noDepNodes) == 0 {
		return nil, fmt.Errorf("no containers in pod %s have no dependencies, cannot start pod: %w", p.ID(), define.ErrNoSuchCtr)
	}

	ctrErrors := make(map[string]error)
	ctrsVisited := make(map[string]bool)

	// Traverse the graph beginning at nodes with no dependencies
	for _, node := range graph.noDepNodes {
		startNode(ctx, node, false, ctrErrors, ctrsVisited, false)
	}

	if len(ctrErrors) > 0 {
		return ctrErrors, fmt.Errorf("starting some containers: %w", define.ErrPodPartialFail)
	}
```

`stopWithTimeout` ([`#L164-L198`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/pod_api.go#L164-L198)) は縮退する。

```go title="libpod/pod_api.go"
	// Try and generate a graph of the pod for ordered stop.
	graph, err := BuildContainerGraph(allCtrs)
	if err != nil {
		// Can't do an ordered stop, do it the old fashioned way.
		logrus.Warnf("Unable to build graph for pod %s, switching to unordered stop: %v", p.ID(), err)

		ctrErrors = make(map[string]error)
		for _, ctr := range allCtrs {
			/* ... 全コンテナを順に Stop ... */
		}
	} else {
		/* ... */
		ctrErrors, err = stopContainerGraph(ctx, graph, p, realTimeout, cleanup)
```

削除 ([`libpod/runtime_pod_common.go#L219-L254`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_pod_common.go#L219-L254)) は `--force` のときだけ縮退する。

```go title="libpod/runtime_pod_common.go"
	// Build a graph of all containers in the pod.
	graph, err := BuildContainerGraph(ctrs)
	if err != nil {
		// We have to allow the pod to be removed.
		// But let's only do it if force is set.
		if !force {
			return nil, fmt.Errorf("cannot create container graph for pod %s: %w", p.ID(), err)
		}

		removalErr = fmt.Errorf("creating container graph for pod %s failed, fell back to loop removal: %w", p.ID(), err)

		removedCtrs, err = r.removeMalformedPod(ctx, p, ctrs, force, timeout, ctrNamedVolumes)
```

`removeMalformedPod` は `IgnoreDeps: true` で削除する。そのオプションのコメント ([`libpod/runtime_ctr.go#L668-L690`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_ctr.go#L668-L690)) は "This is _DANGEROUS_ and should not be used outside of non-graph traversal pod removal code" だ。

Pod の外で単体のコンテナを消すとき ([`#L894-L938`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_ctr.go#L894-L938)) はグラフを組まず、DB の逆引き `state.ContainerInUse(c)` で「自分に依存しているコンテナ」を取り、`--depend` なら再帰で先に消す。同じ「依存する側を先に」でも、Pod 内は DAG 走査、Pod 外は DB 逆引きと再帰、という 2 つの実装がある。

## なぜそうなっているか

- **2018 年: 起動順序のためにグラフを入れた。** コミット 120520af34 (2018-03-23, Matthew Heon) "Initial implementation of container graph generation" と 73e13cf688 "Change pod Start() to use container dependency graph"。Tarjan を循環検出だけに使っているのは、この最初の実装の名残と見るのが妥当だ (推測)。
- **2020 年: 停止が遅すぎたので無順序で並列化した。** コミット 2bb2425704 (2020-08-19) "Move pod jobs to parallel execution": "We were previously stopping containers in a pod serially, which could take up to the timeout (default 15 seconds) for each container - stopping 100 containers that do not respond to SIGTERM would take 25 minutes." 起動は "needs to be done in a specific order" として並列化の対象外にした。
- **2025 年: 無順序だと infra が先に死ぬので、停止も順序付き並列に戻した。** コミット 46d874aa52 (2025-01-30, Matt Heon) "Refactor graph traversal & use for pod stop": "rework the shared stop/removal inward-traversal code to add locking. This allows parallel execution of stop and removal ... use the new graph-based stop when possible to solve unordered stop problems with pods - specifically, the infra container stopping before application containers, leaving those containers without a working network." `containerNode.lock` と「訪問済みマークは完了後」の規律はこのとき入った。e2e テスト [`test/e2e/pod_stop_test.go#L233-L254`](https://github.com/podman-container-tools/podman/blob/v6.1.0/test/e2e/pod_stop_test.go#L233-L254) が `FinishedAt` を比べて infra が最後に止まることを固定している。
- **順序が要るのは start / restart / stop / remove だけ。** `Pod.Cleanup`、`Pause`、`Unpause`、`Kill` は今も `parallel.Enqueue` を直接呼ぶ無順序並列で、線引きが明確だ。
- **infra は running でなくても依存が満たされたとみなす。** `checkDependenciesRunning` ([`libpod/container_internal.go#L984`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L984)) の `!depCtr.config.IsInfra`。namespace は infra のプロセスが止まっていても残るからだ。

## どう活かすか

- リソースの依存を 1 箇所に集約し、グラフ構築時に循環を検出して「組めないなら操作を拒否」する。依存の発生源 (設定のフィールド) と依存の評価 (グラフ) を分ける。
- 逆方向の操作 (起動 / 停止) を鏡像の走査で実装し、どちらも「全ての前提が完了してから自分」を訪問済みチェックで表現する。
- 並列走査では「訪問済みマークは処理完了後」「エラー伝播が終わるまでロックを持つ」。先にマークを付けると、下流が前提を誤認して動き出す。
- エラーを下流に伝播させ、部分失敗を `map[id]error` と専用のエラー値で返す。「一部は成功した」を呼び出し側が区別できるようにする。
- 理想の経路が使えないときの縮退経路 (無順序ループ) を明示的に用意し、破壊的な縮退は `--force` でだけ許す。
- 取り込むべきでない条件: 依存が深く出発点が少ない構成では、出発点だけを enqueue するこの方式は並列化の恩恵がほぼ無い。各ノードを enqueue する汎用のワークキューの方がよい場面もある。「訪問済み = 処理済みまたは失敗」という二値は単純だが、リトライや部分的なロールバックが要るシステムには足りない。
