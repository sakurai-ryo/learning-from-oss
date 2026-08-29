---
title: "Compose 互換をどう提供しているか"
description: "podman compose は Compose を実装していない。docker-compose か podman-compose という外部バイナリを探して、DOCKER_HOST を Podman の socket に向けて exec するだけの薄いラッパーだ。フラグ解析を完全に無効化して引数をそのまま渡し、終了コードもそのまま返す。「実装しない」ことを機能として提供する設計の実例になっている。"
group: "Pod と Kubernetes 互換"
sidebar:
  order: 36
---

## 何を学んだか

### Podman は Compose を実装していない

`podman compose up` は Podman の中で Compose ファイルを解釈しない。やっているのはこれだけだ。

1. `docker-compose` または `podman-compose` を探す
2. `DOCKER_HOST` を Podman の socket に向ける
3. 引数をそのまま渡して exec する
4. 終了コードをそのまま返す

Compose の仕様は大きく、しかも動き続けている。**追随するより、既存の実装をそのまま使わせる方が確実** という判断だ。

これが成立するのは、Podman が Docker 互換の REST API を持っているからだ ([Docker のアーキテクチャ](../docker-architecture/))。`docker-compose` はデーモンの実装を仮定していないので、socket の向き先を変えれば Podman に対して動く。

### 既定のプロバイダは docker-compose が先

`containers.conf` の `compose_providers` の既定値はプラットフォームごとに違い、いずれも **`docker-compose` を先に探す**。

コマンドのヘルプに理由が書いてある。「docker-compose は Compose 仕様の元の実装であり、サポート対象のプラットフォーム (Linux、macOS、Windows) で広く使われているため優先する」。

`podman-compose` は Python 実装で、Podman プロジェクトの一部でもある。それでも既定で 2 番目に置いている。**自分のプロジェクトの実装より、広く使われている方を優先する**という判断は珍しい。

### 外部プロバイダを使っていることを毎回知らせる

`podman compose` を実行すると、既定で警告が出る。

```
>>>> Executing external compose provider "docker-compose". Please see podman-compose(1) for how to disable this message. <<<<
```

「これは Podman の機能ではなく外部ツールです」と明示する。うまく動かないときに、Podman に報告すべきか docker-compose に報告すべきかが分かるようにするためだ。

## ソースコードのどこか

### フラグ解析を完全に無効化する

[`cmd/podman/compose.go#L22-L42`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/compose.go#L22)。

```go title="cmd/podman/compose.go"
var composeCommand = &cobra.Command{
	Use:   "compose [options]",
	Short: "Run compose workloads via an external provider such as docker-compose or podman-compose",
	...
	DisableFlagParsing: true,
	Annotations:        map[string]string{registry.ParentNSRequired: ""}, // don't join user NS for SSH to work correctly
}

func init() {
	// NOTE: we need to fully disable flag parsing and manually parse the
	// flags in composeMain. cobra's FParseErrWhitelist will strip off
	// unknown flags _before_ the first argument.  So `--unknown argument`
	// will show as `argument`.
```

`DisableFlagParsing: true` にして、**cobra に一切触らせない**。理由がコメントにある。cobra の `FParseErrWhitelist` (未知のフラグを許す設定) を使っても、未知のフラグは **引数リストから取り除かれてしまう**。`--unknown argument` が `argument` になる。

透過的なラッパーを作るとき、引数を「解析せずにそのまま渡す」ことが要件になる。CLI フレームワークの親切な機能が邪魔になる典型例だ。

`ParentNSRequired` というアノテーションも効いている。**このコマンドでは user namespace に入らない**。SSH 経由でリモートの Podman に繋ぐ場合に、namespace の中だと鍵や既知ホストの読み取りが壊れるためだ。

### プロバイダの探索は「最初に見つかった候補が勝つ」

[`cmd/podman/compose.go#L70`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/compose.go#L70)。

```go title="cmd/podman/compose.go"
func composeProvider() (string, error) {
	if value, ok := os.LookupEnv("PODMAN_COMPOSE_PROVIDER"); ok {
		return value, nil
	}

	candidates := registry.PodmanConfig().ContainersConfDefaultsRO.Engine.ComposeProviders.Get()
	if len(candidates) == 0 {
		return "", errors.New("no compose provider specified, please refer to `man podman-compose` for details")
	}

	lookupErrors := make([]error, 0, len(candidates))
	for _, candidate := range candidates {
		path, err := exec.LookPath(os.ExpandEnv(candidate))
		if err == nil {
			// First specified provider "candidate" wins.
			logrus.Debugf("Found compose provider %q", path)
			return path, nil
		}
		logrus.Debugf("Error looking up compose provider %q: %v", candidate, err)
		lookupErrors = append(lookupErrors, err)
	}

	return "", fmt.Errorf("looking up compose provider failed\n%v", errorhandling.JoinErrors(lookupErrors))
}
```

環境変数 → 設定ファイルの候補リスト、の順。**失敗したときは全候補のエラーをまとめて返す**。「docker-compose が見つからない」だけでなく、探したパス全部が出るので、どこに置けばよいかが分かる。

macOS の候補リストが具体的だ ([`vendor/go.podman.io/common/pkg/config/default_darwin.go#L24`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/config/default_darwin.go#L24))。

```go title="go.podman.io/common/pkg/config/default_darwin.go"
func getDefaultComposeProviders() []string {
	return []string{
		"docker-compose",
		"$HOME/.docker/cli-plugins/docker-compose",
		"/opt/homebrew/bin/docker-compose",
		"/usr/local/bin/docker-compose",
		"/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose",
		"podman-compose",
	}
}
```

Homebrew の Apple Silicon 版 (`/opt/homebrew`)、Intel 版 (`/usr/local`)、Docker Desktop の中の CLI プラグイン。**Docker Desktop がインストールされていれば、その中の docker-compose を使う**。

「Docker から乗り換える」ユーザが、追加インストールなしで `podman compose` を使えるようにするための候補リストだ。移行の摩擦を減らすことに、これだけの具体的なパスを費やしている。

### 渡す環境変数は 3 つ

[`cmd/podman/compose.go#L151`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/compose.go#L151)。

```go title="cmd/podman/compose.go"
func composeEnv() ([]string, error) {
	hostValue, err := composeDockerHost()
	if err != nil {
		return nil, err
	}

	return []string{
		"DOCKER_HOST=" + hostValue,
		// Podman doesn't support all buildkit features and since it's
		// a continuous catch-up game, disable buildkit on the client
		// side.
		//
		// See https://github.com/containers/podman/issues/18617#issuecomment-1600495841
		"DOCKER_BUILDKIT=0",
		// FIXME: DOCKER_CONFIG is limited by containers/podman/issues/18617
		//        and it remains unclear which default path should be set
		//        w.r.t. Docker compatibility and a smooth experience of podman-login
		//        working with podman-compose _by default_.
		"DOCKER_CONFIG=" + os.Getenv("DOCKER_CONFIG"),
	}, nil
}
```

`DOCKER_BUILDKIT=0` のコメントが率直だ。「Podman は BuildKit の全機能をサポートしていないし、**追いつき続けるゲームなので**、クライアント側で BuildKit を無効にする」。

追随を諦めて機能を切る、という判断を明示している。Compose 経由のビルドは buildah による従来の方式になり、BuildKit 固有の機能 (キャッシュマウント、シークレットマウントの一部、マルチステージの並列ビルド) は使えない。

`DOCKER_CONFIG` には `FIXME` が付いている。**認証情報の置き場所が Docker と Podman で違う** ため、`podman login` した資格情報を `docker-compose` が使えるようにする道筋がまだ決まっていない。未解決であることを隠さずコメントに残している。

`DOCKER_HOST` の決定は、ローカルかリモートかで分岐する。

```go title="cmd/podman/compose.go"
	// For local clients (Linux/FreeBSD), use the default API
	// address.
	if !registry.IsRemote() {
		return registry.DefaultAPIAddress(), nil
	}
```

リモート (macOS / Windows の `podman machine` 経由) の場合は、machine の接続情報から socket を組み立てる。**ユーザは `DOCKER_HOST` を意識しなくてよい**。

### 終了コードをそのまま返す

[`cmd/podman/compose.go#L220-L228`](https://github.com/podman-container-tools/podman/blob/v6.1.0/cmd/podman/compose.go#L220)。

```go title="cmd/podman/compose.go"
	if err := cmd.Run(); err != nil {
		// Make sure podman returns with the same exit code as the compose provider.
		if exitErr, isExit := err.(*exec.ExitError); isExit {
			registry.SetExitCode(exitErr.ExitCode())
		}
		// Format the error to make it explicit that error did not come
		// from podman but from the executed compose provider.
		return fmt.Errorf("executing %s %s: %w", provider, strings.Join(args, " "), err)
	}
```

2 つのコメントがどちらも「透過性」の話だ。**終了コードをそのまま返す** (CI のスクリプトが壊れない)、そして **エラーが Podman ではなくプロバイダから来たことを明示する**。

ラッパーが介在していることを、成功時は感じさせず、失敗時ははっきり示す。

### 補完も委譲する

```go title="cmd/podman/compose.go"
func composeCompletion(_ *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	var stdout strings.Builder

	args = append(args, toComplete)
	args = append([]string{"__complete"}, args...)
	if err := composeProviderExec(args, &stdout, io.Discard, false); err != nil {
		// Ignore errors since some providers may not expose a __complete command.
		return nil, cobra.ShellCompDirectiveError
	}
```

**シェル補完までプロバイダに委譲する**。`docker-compose` も cobra で書かれているので、`__complete` という隠しコマンドを持っている。それを呼んで結果をそのまま返す。

`podman-compose` (Python) は `__complete` を持たないので失敗するが、その場合は黙って補完なしになる。「一部のプロバイダは `__complete` を持たないのでエラーは無視する」。

## なぜそうなっているか

### 追随できない仕様は、実装しない

Compose 仕様は Docker が主導して進化を続けている。Podman が独自実装すると、常に遅れる。しかも Compose ファイルは実務で使われるので、微妙な非互換が致命的になる。

「実装しない」という選択は、**Docker 互換 API があって初めて可能**になる。API さえ互換なら、クライアントは本家をそのまま使える。互換レイヤの投資が、こういう形で回収されている。

同じ判断が `DOCKER_BUILDKIT=0` にも現れている。BuildKit は buildah とは別系統の実装で、追随のコストが高い。**機能を減らして正しく動く方を選ぶ**。

### 透過的なラッパーは、フレームワークと戦う

CLI フレームワークは「引数を解析して構造化する」ことを助けてくれる。だが透過的なラッパーが欲しいのは逆で、**解析せずにそのまま渡す** ことだ。

cobra の `DisableFlagParsing` を使い、コメントで「`FParseErrWhitelist` では駄目な理由」まで書いてあるのは、この戦いの記録といえる。同じ問題は `kubectl` のプラグインや `git` のサブコマンドでも起きる。

### 自分の実装を既定にしない

`podman-compose` は Podman プロジェクトの一部だが、既定では 2 番目だ。ユーザにとって良い方を選んだ結果で、**組織の都合より実用を取っている**。

こうした判断がドキュメント (コマンドの Long ヘルプ) に理由付きで書かれていることも、態度として一貫している。

## どう活かすか

- **互換 API があれば、上位ツールは実装しなくてよい。** プロトコル互換への投資は、エコシステム全体を引き継げるという形で返ってくる。何を自分で実装するかの判断が変わる。
- **透過的なラッパーはフラグ解析を無効化する。** CLI フレームワークの親切機能は、引数を書き換えてしまうことがある。`DisableFlagParsing` 相当の設定を探す。
- **終了コードは必ずそのまま返す。** ラッパーが独自の終了コードを返すと、CI スクリプトが壊れる。エラーメッセージには「どのプロセスから来たか」を含める。
- **候補パスは具体的に列挙する。** 「PATH から探す」だけでは、Homebrew や Docker Desktop の中にあるバイナリが見つからない。移行の摩擦を減らすなら、想定される場所を列挙する価値がある。
- **未解決の設計は FIXME で残す。** `DOCKER_CONFIG` のコメントは「何が問題で、なぜ決まっていないか」を書いている。空欄にするより、次に触る人が判断できる。
