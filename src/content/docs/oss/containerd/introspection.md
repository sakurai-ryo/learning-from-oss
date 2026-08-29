---
title: "introspection: プラグインの生死を API で見せる"
description: "起動時に失敗したプラグインは、エラーを保持したままプラグイン集合に残る。introspection サービスはそれを gRPC で公開し、初期化エラーまで含めて返す。さらにランタイムに問い合わせて OCI の対応バージョンを取得したり、非推奨機能の使用状況を報告したりもする。"
group: "運用と拡張"
sidebar:
  order: 60
---

## 何を学んだか

### 何が見えるか

`ctr plugins ls` が返す情報は、プラグインごとに、

- 型と ID (`io.containerd.snapshotter.v1.overlayfs`)
- 依存する型 (`Requires`)
- 対応プラットフォーム (`Platforms`)
- 公開する値 (`Exports`) — root ディレクトリ、設定値など
- 能力 (`Capabilities`)
- **初期化エラー** (`InitErr`)

最後の 1 つが要点だ。**失敗したプラグインも一覧に出て、失敗の理由が構造化されたエラーとして返る** ([中核が空のデーモン — すべてがプラグイン](../plugin-architecture/))。

### サーバ自身の情報も返す

`Server()` は containerd プロセス自体の情報を返す。

- **UUID** — インストールごとに一意。ファイルに保存され、再起動しても変わらない
- **PID** と **PID namespace の inode**
- **非推奨警告の一覧**

PID namespace を返すのは、containerd がコンテナの中で動いているか (Docker in Docker など) を判別するためだ。

### プラグインに追加情報を問い合わせられる

`PluginInfo(type, id, options)` は、プラグインのインスタンス自体に問い合わせる。ランタイムプラグインなら、`shim -info` を実行して **OCI のバージョン対応範囲や機能一覧** を取得する。

```sh
$ ctr plugins inspect-runtime --runtime=io.containerd.runc.v2 --runc-binary=runc
```

### 非推奨警告を溜める

`WarningPlugin` が非推奨機能の使用を記録し、introspection API から取り出せる。設定ファイルの古い書き方や、廃止予定の機能を使っていると、ここに溜まる。

## ソースコードのどこか

### プラグイン集合をそのまま持つ

[`plugins/services/introspection/local.go#L66-L83`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/services/introspection/local.go#L66-L83)。

```go title="plugins/services/introspection/local.go"
			// this service fetches all plugins through the plugin set of the plugin context
			return &Local{
				plugins:       ic.Plugins(),
				root:          ic.Properties[plugins.PropertyRootDir],
				warningClient: warningClient,
			}, nil
```

`ic.Plugins()` で **初期化コンテキストのプラグイン集合をそのまま保持する**。コピーではなく参照なので、後から初期化されたプラグインも見える。

introspection プラグイン自身が初期化される時点では、後続のプラグインはまだ入っていない。集合を参照で持つことで、実行時には全部見えるようになる。

### キャッシュの更新条件

```go title="plugins/services/introspection/local.go"
func (l *Local) getPlugins() []*api.Plugin {
	l.mu.Lock()
	defer l.mu.Unlock()
	plugins := l.plugins.GetAll()
	if l.pluginCache == nil || len(plugins) != len(l.pluginCache) {
		l.pluginCache = pluginsToPB(plugins)
	}
	return l.pluginCache
}
```

**個数が変わったときだけ** protobuf への変換をやり直す。プラグインの数は起動後に変わらないので、実質的に初回だけ変換される。

個数だけを見る簡易な判定だが、containerd ではプラグインの入れ替えが起きないので十分だ。

### エラーを構造化して返す

[`plugins/services/introspection/local.go#L218-L257`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/services/introspection/local.go#L218-L257)。

```go title="plugins/services/introspection/local.go"
	var initErr *rpc.Status
	if err := p.Err(); err != nil {
		st, ok := status.FromError(errgrpc.ToGRPC(err))
		if ok {
			var details []*ptypes.Any
			for _, d := range st.Proto().Details {
				details = append(details, &ptypes.Any{
```

初期化エラーを **gRPC の `Status` に変換して返す**。単なる文字列ではなく、コードと詳細を持つ構造化されたエラーだ ([errdefs: エラーの意味を境界で保つ](../errdefs/))。

だから `ctr plugins ls -d` が、エラーコードとメッセージを分けて表示できる。

```
Error:
       Code:        Unknown
       Message:     modprobe aufs failed: ...
```

```go title="plugins/services/introspection/local.go"
		Capabilities: p.Meta.Capabilities,
		Exports:      p.Meta.Exports,
		InitErr:      initErr,
	}
```

`Meta` の中身がそのまま公開される。プラグインが初期化時に書き込んだ情報 ([中核が空のデーモン](../plugin-architecture/)) が、そのまま外から見える。

### プラグインへの問い合わせ

[`plugins/services/introspection/local.go#L285-L323`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/services/introspection/local.go#L285-L323)。

```go title="plugins/services/introspection/local.go"
	// Request additional info from plugin instance
	if options != nil {
		if p.Err() != nil {
			return resp, fmt.Errorf("cannot get extra info, plugin not successfully loaded: %w", errdefs.ErrFailedPrecondition)
		}
		inst, err := p.Instance()
		if err != nil {
			return resp, fmt.Errorf("failed to get plugin instance: %w", errdefs.ErrFailedPrecondition)
		}
		pi, ok := inst.(pluginInfoProvider)
		if !ok {
			return resp, fmt.Errorf("plugin does not provided extra information: %w", errdefs.ErrNotImplemented)
		}

		info, err := pi.PluginInfo(ctx, options)
```

3 段階のチェックがあり、**それぞれ違うエラーを返す**。

- 初期化に失敗している → `ErrFailedPrecondition`
- インスタンスが取れない → `ErrFailedPrecondition`
- 追加情報を提供しない → `ErrNotImplemented`

エラーの種類を分けているので、呼び出し側が「そもそも対応していない」と「今は使えない」を区別できる。

いずれの場合も **基本情報 (`resp`) は返す**。エラーと一緒に部分的な結果を返すのは Go では珍しいが、「プラグインの基本情報は取れたが、追加情報は取れなかった」を正確に表現している。

`pluginInfoProvider` は任意のインターフェースで、実装しているプラグインだけが追加情報を返す。runtime v2 プラグインがこれを実装し、shim バイナリを `-info` フラグで実行する ([runtime v2: シムをバイナリ呼び出し規約で起動する](../runtime-v2-binary/))。

### UUID の永続化

```go title="plugins/services/introspection/local.go"
func (l *Local) getUUID() (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	data, err := os.ReadFile(l.uuidPath())
	if err != nil {
		if os.IsNotExist(err) {
			return l.generateUUID()
		}
		return "", err
	}
	if len(data) == 0 {
		return l.generateUUID()
	}
	u := string(data)
	if _, err := uuid.Parse(u); err != nil {
		return "", err
	}
	return u, nil
}
```

**ファイルがない、または空なら生成する**。空ファイルのケースを別扱いしているのは、書き込み途中でクラッシュした場合への対処だ。

パースに失敗した場合はエラーを返す (生成し直さない)。壊れた UUID を黙って上書きすると、何かがおかしいことに気づけない。

この UUID は、メトリクスやテレメトリで「同じノードか」を判別するのに使われる。

### 非推奨警告

[`plugins/services/warning/service.go#L32-L44`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/services/warning/service.go#L32-L44)。

```go title="plugins/services/warning/service.go"
type Service interface {
	Emit(context.Context, deprecation.Warning)
	Warnings() []Warning
}

func init() {
	registry.Register(&plugin.Registration{
		Type: plugins.WarningPlugin,
		ID:   plugins.DeprecationsPlugin,
		InitFn: func(ic *plugin.InitContext) (any, error) {
			return &service{warnings: make(map[deprecation.Warning]time.Time)}, nil
		},
	})
}
```

2 メソッドだけ。`map[Warning]time.Time` なので、**同じ警告は 1 回しか記録されず、最初に検出した時刻が残る**。

各プラグインが初期化時や実行時に `Emit` を呼ぶ。設定の移行 ([依存を型で宣言し、初期化順を DFS で決める](../plugin-graph/) の ConfigMigration) や、非推奨の API 呼び出しで発火する。

## なぜそうなっているか

### 起動時のエラーをログだけにしない

「起動時に何が失敗したか」は、ログを遡れば分かる。しかし、

- ログが循環して消えている
- ログ収集の設定が違う
- リモートから確認したい

といった状況では取れない。**API で問い合わせられる** ようにしておけば、`ctr plugins ls -d` 一発で分かる。

これが可能なのは、失敗したプラグインを集合から除外せず、エラーを持ったまま残しているからだ ([中核が空のデーモン](../plugin-architecture/))。

### 実効設定を公開する

`Exports` にプラグインの設定値が入るので、**設定ファイルを読まずに実際の値が分かる**。

```sh
$ ctr plugins ls -d id==scheduler
```

GC スケジューラなら `PauseThreshold` などが出る ([GC が DB を止める時間を、目標値から逆算する](../gc-scheduler/))。設定ファイルの解釈が想定通りかを、動いているデーモンに聞ける。

設定ファイルとの二重管理になるが、「書いた設定」と「効いている設定」は別物なので、両方見られる価値がある。

### 非推奨を機械可読にする

containerd 2.0 は多くの機能を廃止した。1.6 / 1.7 から移行するとき、「自分の環境が何を使っているか」を知る必要がある。

ログに警告を出すだけでは、大量のノードを調べるのが大変だ。API で取れれば、監視システムから収集できる。

```sh
$ ctr deprecations list --format json
```

この機能は **1.6 / 1.7 にバックポートされた** と `docs/containerd-2.0.md` に書かれている。移行を支援するために、古いバージョンにも入れた。

## どう活かすか

### 起動時の問題を調べる

```sh
# 全プラグインの状態
$ ctr plugins ls

# 失敗したものの詳細
$ ctr plugins ls -d

# 特定のプラグイン
$ ctr plugins ls -d id==devmapper
```

`STATUS` が `error` のものが、初期化に失敗したプラグイン。`-d` で理由が出る。

`skip` は設定による無効化なので、意図通りなら問題ない。

### アップグレード前の確認

```sh
# 非推奨機能の使用状況
$ ctr deprecations list

# サーバの情報
$ ctr version
```

containerd 2.x へ上げる前に、1.6 / 1.7 のノードでこれを実行すると、移行が必要な箇所が分かる。

### ランタイムの対応機能を調べる

```sh
$ ctr plugins inspect-runtime --runtime=io.containerd.runc.v2 --runc-binary=runc
```

runc がサポートする OCI のバージョン範囲、seccomp のアクション、cgroup のバージョンなどが JSON で返る。「この機能はこの環境で使えるか」を確認できる。

### 「状態を API で公開する」設計

デーモンを作るとき、内部状態の公開について containerd から学べる点。

- **失敗を状態として保持し、公開する** — ログに流して忘れない
- **エラーは構造化して返す** — コードと詳細を分ける
- **実効設定を公開する** — 設定ファイルの解釈結果を見せる
- **部分的な結果とエラーを両方返してよい** — 「基本情報は取れた」を伝える
- **非推奨の使用を記録して問い合わせ可能にする** — 移行を支援する

3 番目は特に効く。「設定が効いていない」の切り分けは運用で頻出する問題で、実効値が見られるだけで解決が速くなる。
