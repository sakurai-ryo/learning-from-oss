---
title: "CRI プラグインの輪郭"
description: "CRI は 3 つのプラグイン (runtime・images・grpc) に分かれ、containerd のクライアント API を in-process で使う。名前の予約、CNI の呼び出し、状態のキャッシュ、イベントの購読といった CRI 固有の関心事だけを持ち、コンテナの実体は containerd コアに置く。"
group: "サンドボックスと CRI"
sidebar:
  order: 57
---

## 何を学んだか

### CRI は 3 つのプラグインに分かれている

| プラグイン          | 型と ID                        | 責務                                                |
| ------------------- | ------------------------------ | --------------------------------------------------- |
| CRI runtime service | `io.containerd.cri.v1.runtime` | Pod とコンテナのライフサイクル、CNI、ストリーミング |
| CRI image service   | `io.containerd.cri.v1.images`  | イメージの pull / list / remove、イメージ FS の情報 |
| CRI gRPC service    | `io.containerd.grpc.v1.cri`    | 上記 2 つを束ねて CRI の gRPC サービスとして公開    |

分離の理由は、**イメージ管理だけを別に使いたい** 場合があるからだ (Kubernetes の image service と runtime service は本来別のエンドポイントにできる)。

3 つ目の gRPC プラグインは依存が 11 個あり、containerd の中で最も依存が多いプラグインになっている。

### containerd の全機能を「クライアントとして」使う

CRI プラグインは、`containerd.New("", WithInMemoryServices(ic))` で **アドレスなしのクライアント** を作る ([CRI: kubelet がランタイムに要求する輪郭](../cri-interface/))。

つまり CRI プラグインは、外部のクライアント (nerdctl など) と同じ API を使って containerd を操作する。特権的な近道を持たない。

### CRI 固有の関心事

CRI 層が自分で持つのは次のものだ。

- **名前の一意性** — Pod 名とコンテナ名の予約 (`registrar.Registrar`)
- **ネットワーク** — CNI の呼び出しと設定ファイルの監視
- **状態のキャッシュ** — kubelet の頻繁な問い合わせに答えるため
- **イベントの購読** — containerd のイベントを受けてキャッシュを更新する
- **ストリーミングサーバ** — exec / attach / port-forward の HTTP エンドポイント

いずれも「Kubernetes の語彙で必要だが、containerd のコアには要らない」ものになっている。

### 失敗しても状態を残す

`RunPodSandbox` の途中で失敗した場合、CRI プラグインは **sandbox を not-ready 状態で残す** ことがある。kubelet が次の同期で `StopPodSandbox` / `RemovePodSandbox` を呼ぶので、そこで掃除される。

## ソースコードのどこか

### gRPC プラグインの依存

[`plugins/cri/cri.go#L46-L67`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/cri/cri.go#L46-L67)。

```go title="plugins/cri/cri.go"
	registry.Register(&plugin.Registration{
		Type: plugins.GRPCPlugin,
		ID:   "cri",
		Requires: []plugin.Type{
			plugins.CRIServicePlugin,
			plugins.PodSandboxPlugin,
			plugins.SandboxControllerPlugin,
			plugins.NRIApiPlugin,
			plugins.EventPlugin,
			plugins.ServicePlugin,
			plugins.LeasePlugin,
			plugins.SandboxStorePlugin,
			plugins.TransferPlugin,
			plugins.WarningPlugin,
			plugins.ShimPlugin,
		},
```

11 個の依存。**containerd のほぼ全部の機能を使う** ことが宣言から読み取れる。

このプラグインが最後の方に初期化されるのは、[依存の DFS](../plugin-graph/) の帰結だ。

### 設定の伝播

```go title="plugins/cri/cri.go"
	// Propagate runtime-specific snapshotters from runtime config to image service.
	// This is needed because users may configure snapshotters in the runtime config
	// (containerd.runtimes.<name>.snapshotter) which the image service needs for pulling.
	runtimeSvc := criRuntimePlugin.(server.RuntimeService)
	imageSvc := criImagePlugin.(server.ImageService)
	runtimeConfig := runtimeSvc.Config()
	for runtimeName, rt := range runtimeConfig.Runtimes {
		if rt.Snapshotter != "" {
			imagePlatform := images.ImagePlatform{
				Snapshotter: rt.Snapshotter,
				Platform:    platforms.DefaultSpec(),
			}
			imageSvc.UpdateRuntimeSnapshotter(runtimeName, imagePlatform)
		}
```

**runtime の設定から image service へ、snapshotter の情報を渡している**。「ランタイムごとに snapshotter を変える」設定が、pull の時点で効く必要があるためだ。

プラグインを分けたことで、設定が分断される。それを束ねる側 (gRPC プラグイン) が繋ぎ直している。分割のコストが見える箇所だ。

### 名前の予約

[`internal/cri/server/sandbox_run.go#L83-L94`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/internal/cri/server/sandbox_run.go#L83-L94)。

```go title="internal/cri/server/sandbox_run.go"
	// Reserve the sandbox name to avoid concurrent `RunPodSandbox` request starting the
	// same sandbox.
	if err := c.sandboxNameIndex.Reserve(name, id); err != nil {
		return nil, fmt.Errorf("failed to reserve sandbox name %q: %w", name, err)
	}
	defer func() {
		// Release the name if the function returns with an error.
		// When cleanupErr != nil, the name will be cleaned in sandbox_remove.
		if retErr != nil && cleanupErr == nil {
			c.sandboxNameIndex.ReleaseByName(name)
		}
	}()
```

kubelet が同じ Pod に対して `RunPodSandbox` を 2 回呼ぶことがある (タイムアウトして再送するなど)。**名前を予約することで重複起動を防ぐ**。

解放の条件が興味深い。`retErr != nil && cleanupErr == nil` — つまり **掃除まで成功した場合だけ名前を解放する**。掃除に失敗していたら、名前を握ったまま残す。

### 掃除の失敗を状態として残す

```go title="internal/cri/server/sandbox_run.go"
	// cleanupErr records the last error returned by the critical cleanup operations in deferred functions,
	// like CNI teardown and stopping the running sandbox task.
	// If cleanup is not completed for some reason, the CRI-plugin will leave the sandbox
	// in a not-ready state, which can later be cleaned up by the next execution of the kubelet's syncPod workflow.
	var cleanupErr error
```

**「掃除しきれなかったら、not-ready な sandbox として残す」** という方針が明記されている。

kubelet は定期的に Pod の状態を同期する (`syncPod`)。not-ready な sandbox を見つけたら、停止と削除を試みる。**上位の調整ループに掃除を委ねる** 設計だ ([CRI: kubelet がランタイムに要求する輪郭](../cri-interface/))。

無理に掃除を完遂しようとして無限にリトライするより、状態を正直に残して上位に任せるほうが安全になる。

### RunPodSandbox の流れ

`RunPodSandbox` は 500 行以上あるが、大きくはこう進む。

1. **ID を採番し、名前を予約する**
2. sandbox のメタデータを作り、ストアに保存する
3. **network namespace を作り、CNI でネットワークを設定する** (host network でなければ)
4. `SandboxController.Create` → `Start`
5. sandbox のエンドポイントをメタデータに保存する
6. 状態を ready にする

各段階に defer で後始末が登録され、失敗すると逆順に実行される ([shim manager と task manager の分業](../shim-task-manager/) と同じ形)。

### 状態のキャッシュ

[`internal/cri/server/service.go#L122-L162`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/internal/cri/server/service.go#L122-L162)。

```go title="internal/cri/server/service.go"
	// sandboxStore stores all resources associated with sandboxes.
	sandboxStore *sandboxstore.Store
	// sandboxNameIndex stores all sandbox names and make sure each name
	// is unique.
	sandboxNameIndex *registrar.Registrar
	// containerStore stores all resources associated with containers.
	containerStore *containerstore.Store
	...
	// eventMonitor is the monitor monitors containerd events.
	eventMonitor *events.EventMonitor
```

**メモリ上のストアを持つ**。kubelet は数秒ごとに全 Pod の状態を問い合わせるので、毎回 containerd の API を叩いていては重い。

`eventMonitor` が containerd のイベントを購読し、キャッシュを更新する。イベントが失われた場合に備えて、定期的な再同期もある ([イベントは shim から publish バイナリで戻ってくる](../event-publisher/))。

### CNI はここにしかない

```go title="internal/cri/server/service.go"
	// netPlugin is used to setup and teardown network when run/stop pod sandbox.
	netPlugin map[string]cni.CNI
	...
	// cniNetConfMonitor is used to reload cni network conf if there is
	// any valid fs change events from cni network conf dir.
	cniNetConfMonitor map[string]*cniNetConfSyncer
```

[SCOPE.md で out と宣言されたネットワーク](../scope-and-principles/) が、CRI プラグインの中には存在する。CRI プラグインは「containerd を使う上位システムの一部」という位置付けなので、矛盾しない。

`cniNetConfSyncer` は CNI の設定ディレクトリを監視して、変更があれば読み直す。CNI プラグインのインストール後に containerd を再起動しなくてよいようにするためだ。

map になっているのは、ランタイムごとに別の CNI 設定を持てるからだ。

## なぜそうなっているか

### CRI をプラグインとして同居させる

CRI を別プロセス (CRI-O のような独立したデーモン) にする選択肢もあった。同じプロセスに入れた理由は、

- **containerd の全機能に低コストでアクセスできる** — gRPC の往復がない
- **デプロイが 1 バイナリで済む** — Kubernetes ノードの構成が単純
- **プロセス間の状態同期が不要**

代償は、CRI プラグインのバグが containerd 全体に影響しうることだ。実際、`disabled_plugins` で CRI を無効化する構成 (Docker 専用ノードなど) が用意されている。

### 名前の予約を CRI 層が持つ

containerd のコンテナ ID は一意だが、**Kubernetes の Pod 名 + namespace の組** の一意性は containerd の関心事ではない。

「同じ Pod 名で 2 回起動しない」は CRI の要求なので、CRI 層に `registrar` を置く。containerd コアに Kubernetes の概念を持ち込まない、という線引きになっている。

### キャッシュを持つことの是非

キャッシュは常に「いつ無効化するか」の問題を生む。CRI プラグインはイベント購読で更新するが、イベントは失われうる。

それでもキャッシュを持つのは、kubelet の問い合わせ頻度が高いからだ。100 Pod × 3 コンテナのノードで、数秒ごとに全部の状態を問い合わせると、containerd の API 呼び出しが毎秒数百回になる。

**正確さと負荷のトレードオフ** で、負荷側に倒している。ずれた場合は、kubelet の次の同期で修正される。

## どう活かすか

### CRI 層と containerd 層を切り分ける

```sh
# CRI から見た状態
$ crictl pods
$ crictl ps -a

# containerd から見た状態
$ ctr -n k8s.io containers ls
$ ctr -n k8s.io tasks ls
```

**両者がずれていたら、CRI 層のキャッシュか、イベントの取りこぼしを疑う**。containerd を再起動すると CRI のキャッシュも再構築されるので、ずれが直ることがある。

### CRI を無効化する

Kubernetes を使わないノードでは、CRI プラグインを止められる。

```toml
version = 3
disabled_plugins = ["io.containerd.grpc.v1.cri"]
```

CNI の監視や状態のキャッシュが動かなくなる分、メモリと起動時間が減る。

### 「上位の調整ループに掃除を任せる」

CRI プラグインの `cleanupErr` の扱いは、宣言的なシステムの下で働くコンポーネントの作法として参考になる。

- **掃除に失敗したら、その事実を状態として残す** — 成功したふりをしない
- **無理にリトライしない** — 上位が次の同期で気づく
- **not-ready のような中間状態を持つ** — 「使えないが、まだ存在する」を表現する

これができるのは、上位 (kubelet) が **繰り返し同期を行う** ことを前提にできるからだ。一度きりの命令しか来ないシステムでは、この方針は取れない。
