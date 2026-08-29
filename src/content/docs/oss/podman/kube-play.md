---
title: "kube play — Kubernetes YAML を直接動かす"
description: "podman kube play は Kubernetes の YAML を読んで Pod・コンテナ・ボリューム・シークレットを作る。Kubernetes API サーバも kubelet も無しに、YAML を SpecGenerator に変換して、いつもの 3 段の生成経路に流し込むだけだ。対応する kind は Pod・Deployment・DaemonSet・Job・PVC・ConfigMap・Secret の 7 つで、知らない kind は情報ログを出して読み飛ばす。"
group: "Pod と Kubernetes 互換"
sidebar:
  order: 35
---

## 何を学んだか

### YAML を SpecGenerator に変換するだけ

`podman kube play deployment.yaml` は、Kubernetes を動かすわけではない。やっているのは、

1. YAML をマルチドキュメントとして分割する
2. 各ドキュメントの `kind` を見る
3. `kind` ごとに Kubernetes の型 (`v1.Pod` など) にアンマーシャルする
4. **それを `PodSpecGenerator` と `SpecGenerator` に変換する**
5. 通常の Pod / コンテナ生成経路に流す

4 が肝で、`pkg/specgen/generate/kube` パッケージの `ToPodOpt` と `ToSpecGen` がその変換を担う。**入口が 1 つ増えただけ** で、その先は `podman run` と同じ経路になる ([podman run の全経路](../podman-run-walkthrough/))。

### 対応する kind は 7 つ

| kind                    | 扱い                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `Pod`                   | そのまま Pod として作る                                    |
| `Deployment`            | `spec.template` を取り出し、`replicas` の数だけ Pod を作る |
| `DaemonSet`             | 単一ホストなので Pod 1 つとして作る                        |
| `Job`                   | Pod として作る                                             |
| `PersistentVolumeClaim` | Podman のボリュームを作る                                  |
| `ConfigMap`             | 単体では作らず、コンテナから参照されたときに使う           |
| `Secret`                | Podman のシークレットを作る                                |
| `List`                  | 中身を展開して再帰的に処理                                 |
| それ以外                | **情報ログを出して読み飛ばす**                             |

`Service`、`Ingress`、`StatefulSet`、`NetworkPolicy` などは扱わない。単一ホストに意味のない概念だからだ。

### service container という仕掛け

`--service-container` を付けると、Pod とは別に「サービスコンテナ」が 1 つ作られる。これは **systemd から Pod 全体を 1 つの unit として扱うための仕掛け** だ。

Pod は複数のコンテナからなるので、systemd の `MAINPID` に何を指定すればよいか決まらない。そこで「何もしないコンテナを 1 つ立て、それを Pod 全体の代表とする」。サービスコンテナが止まれば Pod も止まる、という関係を作る。

Quadlet の `.kube` ファイルはこれを使う ([Quadlet](../quadlet-generator/))。

## ソースコードのどこか

### kind によるディスパッチ

[`pkg/domain/infra/abi/play.go#L352-L482`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/play.go#L352)。

```go title="pkg/domain/infra/abi/play.go"
		switch kind {
		case "Pod":
			var podYAML v1.Pod
			var podTemplateSpec v1.PodTemplateSpec

			if err := yaml.Unmarshal(document, &podYAML); err != nil {
				return nil, fmt.Errorf("unable to read YAML as Kube Pod: %w", err)
			}
```

`v1.Pod` は Kubernetes の公式の型定義そのものだ。Podman は `k8s.io/api` を依存に持ち、**Kubernetes と同じ構造体で YAML を読む**。自前でスキーマを書くと必ずずれるので、正しい判断といえる。

知らない kind の扱いが穏当だ。

```go title="pkg/domain/infra/abi/play.go"
		default:
			logrus.Infof("Kube kind %s not supported", kind)
			continue
		}
	}

	if validKinds == 0 {
		if len(configMaps) > 0 {
			return nil, fmt.Errorf("ConfigMaps in podman are not a standalone object and must be used in a container")
		}
		return nil, fmt.Errorf("YAML document does not contain any supported kube kind")
```

**エラーではなく `Infof` で読み飛ばす**。Kubernetes の YAML には Service や Ingress が一緒に書かれていることが多く、それでエラーにすると実用にならない。

ただし「1 つも処理できるものが無かった」場合はエラーにする。そして **ConfigMap しか無かった場合には専用のメッセージ** を返す。「ConfigMap は単体のオブジェクトではなく、コンテナから使われる必要がある」。

これは実際に踏みやすい間違いだ。`kubectl apply -f configmap.yaml` の感覚で `kube play` すると何も起きない。専用のメッセージがあることで、「読み飛ばされた」ではなく「使い方が違う」と分かる。

### service container は「何もしないコンテナ」

[`pkg/domain/infra/abi/play.go#L63`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/play.go#L63)。

```go title="pkg/domain/infra/abi/play.go"
	ctrOpts := entities.ContainerCreateOptions{
		// Inherited from infra containers
		IsInfra:          false,
		MemorySwappiness: -1,
		ReadOnly:         true,
		ReadWriteTmpFS:   false,
		// No need to set up networking.
		Net:                  &entities.NetOptions{Network: specgen.Namespace{NSMode: specgen.NoNetwork}},
		StopTimeout:          rtc.Engine.StopTimeout,
		...
	}

	// Create and fill out the runtime spec.
	s := specgen.NewSpecGenerator("", true)
	if err := specgenutil.FillOutSpecGen(s, &ctrOpts, []string{}); err != nil {
		return nil, fmt.Errorf("completing spec for service container: %w", err)
```

`ReadOnly: true`、ネットワーク無し、`NewSpecGenerator("", true)` (イメージ名が空で rootfs ベース)。**infra コンテナと同じ「空の rootfs + catatonit」の形** を使っている。

`IsInfra: false` としつつコメントに「infra コンテナから継承」と書いてあるのが正直で、infra ではないが同じ設定を使い回している、という意図が読める。

Pod の作成に失敗したときの片付けもある。

```go title="pkg/domain/infra/abi/play.go"
			defer func() {
				if finalErr == nil {
					return
				}
				if err := ic.Libpod.RemoveContainer(ctx, ctr, true, true, nil); err != nil {
					// Log this in debug mode so that we don't print out an error and confuse the user
					// when the service container can't be removed because the pod still exists
					// This can happen when an error happens during kube play and we are trying to
					// clean up after the error. The service container will be removed as part of the
					// teardown function.
					logrus.Debugf("Error cleaning up service container after failure: %v", err)
				}
			}()
```

削除に失敗しても **debug レベルでしかログを出さない**。理由がコメントに書いてある。「Pod がまだ存在するせいでサービスコンテナが消せない場合に、エラーを出してユーザを混乱させないため。この場合サービスコンテナは teardown 関数の側で消される」。

**後始末の失敗が「実は失敗ではない」ケースを見分けて、ログレベルを下げている**。エラー処理を雑にしているのではなく、二重の後始末経路があることを踏まえた判断になっている。

### 変換の入口は 2 つの関数

[`pkg/specgen/generate/kube/kube.go#L53`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/kube/kube.go#L53) と [`#L202`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/specgen/generate/kube/kube.go#L202)。

```go title="pkg/specgen/generate/kube/kube.go"
func ToPodOpt(_ context.Context, podName string, p entities.PodCreateOptions, publishAllPorts bool, podYAML *v1.PodTemplateSpec) (entities.PodCreateOptions, error) {
```

```go title="pkg/specgen/generate/kube/kube.go"
func ToSpecGen(ctx context.Context, opts *CtrSpecGenOptions) (*specgen.SpecGenerator, error) {
```

`kube.go` は 40KB ある。Kubernetes の Pod spec のフィールドを 1 つずつ Podman の概念に対応付ける作業で、**変換表がコードとして書かれている** に等しい。

対応が取れないものは無視するか、警告を出すか、エラーにするかの 3 択になる。この判断がフィールドごとに埋まっているのが、このファイルの中身だ。

## なぜそうなっているか

### 「入口を増やす」形にできたのは、SpecGenerator があったから

`kube play` の実装が変換処理に集中できているのは、**「コンテナを作る意図」を表す型が既にあった** からだ ([2 段構成の specgen](../specgen-two-stage/))。

もし Podman が CLI 引数から直接コンテナを作る構造だったら、`kube play` は「YAML を CLI 引数の文字列に変換する」というひどい実装になっていた。中間の型があることで、変換先が明確な構造体になる。

**新しい入口を足すコストが、中間表現の有無で決まる**。これは 4 つ目の入口 (CLI、REST、Docker 互換 API、kube) を足すときに効いてくる。

### Kubernetes の型をそのまま使う

`k8s.io/api` への依存は重い。それでも自前でスキーマを書かないのは、**Kubernetes の YAML は Kubernetes の定義が正** だからだ。フィールドが追加されたり、デフォルト値の扱いが変わったりしたときに、自前の定義は必ず遅れる。

依存の重さと正確さのトレードオフで、正確さを取っている。`pkg/k8s.io/` というディレクトリがあり、必要な部分だけをベンダリングする工夫もされている。

### 知らないものは読み飛ばす

`kube play` は「Kubernetes の完全な代替」ではない。**同じ YAML を、機能が限られた環境でも動かせるようにする** のが目的だ。だから知らない kind はエラーにせず読み飛ばす。

これは互換レイヤの設計として一般的な判断で、「全部できないなら何もしない」より「できることをやる」方が実用的になる。ただし何を読み飛ばしたかは記録する (`Infof`) ので、期待と違う結果になったときに追える。

## どう活かすか

- **入口を増やす予定があるなら、中間表現を先に作る。** CLI 引数から直接処理する構造は、2 つ目の入口が来た瞬間に破綻する。`SpecGenerator` のような「意図」の型があると、変換を書くだけで済む。
- **外部フォーマットの型定義は、その外部から取る。** 自前で書き直すと必ずずれる。依存が重くても、必要な部分だけベンダリングする方法がある。
- **互換レイヤでは、知らないものを読み飛ばす。** ただし読み飛ばしたことをログに残し、「1 つも処理できなかった」場合は明確なエラーにする。よくある誤解 (ConfigMap 単体) には専用のメッセージを用意する。
- **後始末の失敗が「実は失敗でない」ケースは、ログレベルを下げる。** 二重の後始末経路があるなら、片方の失敗はエラーではない。その判断をコメントで残しておくと、後から「なぜ debug なのか」で迷わない。
