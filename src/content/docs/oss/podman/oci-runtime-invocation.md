---
title: "crun と runc — low-level runtime をどう呼ぶか"
description: "Podman は OCI ランタイムを「バイナリのパス + 3 つの機能フラグ」としてしか知らない。機能はプローブせず containers.conf のリストで宣言し、起動時のエラーはランタイムに JSON でログを吐かせて読み取り、正規表現で分類してから Go のエラー型に変換する。差し替え可能な外部プロセスから、意味のあるエラーをどう回収するかの実例になっている。"
group: "コンテナを作って動かす"
sidebar:
  order: 16
---

## 何を学んだか

### ランタイムは「パス + 3 つのフラグ」

Podman が OCI ランタイムについて持っている情報は驚くほど少ない。

- **名前** (`crun`、`runc`、`runsc`…)
- **実行ファイルのパス**
- **追加で渡すフラグ** (`containers.conf` の `runtime_supports_*` とは別の `[engine.runtimes]` 設定)
- **3 つの機能フラグ** — `supportsJSON`、`supportsNoCgroups`、`supportsKVM`

これだけだ。あとは OCI Runtime Spec が定めるサブコマンド (`create` / `start` / `kill` / `delete` / `state`) を叩く。

| フラグ              | 意味                                           | 効くところ                |
| ------------------- | ---------------------------------------------- | ------------------------- |
| `supportsJSON`      | `--log-format=json` でエラーを構造化して出せる | エラーメッセージの質      |
| `supportsNoCgroups` | `--cgroup-manager=disabled` 相当ができる       | `--cgroups=disabled`      |
| `supportsKVM`       | KVM ベースのランタイム (Kata)                  | `--runtime=kata` 時の扱い |

### 機能はプローブせず、設定で宣言する

前に見た `supportsOverlay` は「実際にマウントして試す」方式だった。OCI ランタイムの機能はそうしていない。**`containers.conf` に名前のリストとして書いてある**。

```toml
runtime_supports_json = ["crun", "runc", "kata", "runsc", "youki", "krun", "ocijail"]
```

ソースにも「TODO: ランタイムに機能をプローブして自動で有効にする」というコメントが残っている。つまり **暫定的にリストで済ませている**。

判断が分かれた理由は、コストと影響の差だ。overlayfs は「使えなければ何も動かない」ので確実さが要る。ランタイムの `--log-format=json` は「使えなければエラーメッセージが少し悪くなる」だけなので、リストで十分と割り切っている。

### ランタイムの起動失敗をどう回収するか

一番難しいのは **エラーの回収** だ。Podman は conmon を exec し、conmon が crun を exec する。crun が失敗したとき、そのエラーメッセージは 2 段離れた場所にある。

Podman の解決策は 2 経路の併用だ。

1. **conmon との同期パイプ** — conmon が JSON 1 行 (`{"data": pid}` または負の値とメッセージ) を書く
2. **ランタイムのログファイル** — `--runtime-arg --log-format=json --runtime-arg --log=<path>` を conmon 経由で crun に渡し、crun 自身に JSON を書かせる

パイプが失敗を伝えてきたら、ログファイルを読んで本当のメッセージを取り出す。そしてそのメッセージを **正規表現で分類し、Go の sentinel error に変換する**。

## ソースコードのどこか

### 機能フラグは設定リストへの所属で決まる

[`libpod/oci_conmon_common.go#L103-L108`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L103)。

```go title="libpod/oci_conmon_common.go"
	// TODO: probe OCI runtime for feature and enable automatically if
	// available.

	runtime.supportsJSON = slices.Contains(runtimeCfg.Engine.RuntimeSupportsJSON.Get(), configIndex)
	runtime.supportsNoCgroups = slices.Contains(runtimeCfg.Engine.RuntimeSupportsNoCgroups.Get(), configIndex)
	runtime.supportsKVM = slices.Contains(runtimeCfg.Engine.RuntimeSupportsKVM.Get(), configIndex)
```

TODO がそのまま残っている。**「本当はプローブすべきだが、今はリスト」** と正直に書いてある。新しいランタイムを使いたい人は `containers.conf` に名前を足せばよい、という逃げ道もある。

パスの探索は「設定の候補リスト → `$PATH`」の順。

```go title="libpod/oci_conmon_common.go"
	// Search the $PATH as last fallback
	if !foundPath {
		if foundRuntime, err := exec.LookPath(name); err == nil {
			foundPath = true
			runtime.path = foundRuntime
			logrus.Debugf("using runtime %q from $PATH: %q", name, foundRuntime)
		}
	}
```

`$PATH` は **最後のフォールバック**。前提群で見たヘルパーバイナリの探索と同じ方針で、設定に書かれた絶対パスを優先する。

### JSON ログを吐かせる引数を conmon 経由で渡す

[`libpod/oci_conmon_common.go#L1011-L1013`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1011) と [`#L1369-L1371`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1369)。

```go title="libpod/oci_conmon_common.go"
	var ociLog string
	if r.supportsJSON {
		ociLog = filepath.Join(ctr.state.RunDir, "oci-log")
	}
```

```go title="libpod/oci_conmon_common.go"
	if ociLogPath != "" {
		args = append(args, "--runtime-arg", "--log-format=json", "--runtime-arg", "--log", fmt.Sprintf("--runtime-arg=%s", ociLogPath))
	}
```

`--runtime-arg` は **conmon に「これを OCI ランタイムに渡せ」と言う引数** だ。Podman → conmon → crun という 2 段の受け渡しが、この 1 行に現れている。

3 つ目だけ `--runtime-arg=<path>` と `=` 付きなのは、conmon の引数パーサの都合。こういう非対称は、外部バイナリを exec で呼ぶ設計では避けにくい。

### 同期パイプの読み取りと、タイムアウト

[`libpod/oci_conmon_common.go#L1422`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1422) の `readConmonPipeData`。

```go title="libpod/oci_conmon_common.go"
func readConmonPipeData(runtimeName string, pipe *os.File, ociLog string) (int, error) {
	// syncInfo is used to return data from monitor process to daemon
	type syncInfo struct {
		Data    int    `json:"data"`
		Message string `json:"message,omitempty"`
	}
```

conmon から返ってくるのは JSON 1 行だけ。`Data` が正なら **コンテナのプロセスの PID**、負ならエラーコードで `Message` に説明が入る。プロセス間の通信プロトコルとして、これ以上ないほど小さい。

読み取りは goroutine に投げ、`select` でタイムアウトと競わせる。

```go title="libpod/oci_conmon_common.go"
	case <-time.After(define.ContainerCreateTimeout):
		return -1, fmt.Errorf("container creation timeout: %w", define.ErrInternal)
```

conmon が固まった場合に永遠に待たないための保険だ。**外部プロセスとのパイプ通信には必ずタイムアウトを付ける**、という基本が守られている。

そしてエラー時には、2 経路のうち良い方を選ぶ。

```go title="libpod/oci_conmon_common.go"
		if ss.si.Data < 0 {
			if ociLog != "" {
				ociLogData, err := os.ReadFile(ociLog)
				if err == nil {
					var ociErr ociError
					if err := json.Unmarshal(ociLogData, &ociErr); err == nil {
						return ss.si.Data, getOCIRuntimeError(runtimeName, ociErr.Msg)
					}
				}
			}
			// If we failed to parse the JSON errors, then print the output as it is
			if ss.si.Message != "" {
				return ss.si.Data, getOCIRuntimeError(runtimeName, ss.si.Message)
			}
			return ss.si.Data, fmt.Errorf("container create failed: %w", define.ErrInternal)
		}
```

3 段の縮退になっている。**「ランタイムの JSON ログ」→「conmon のメッセージ」→「何も分からない」**。どの段でも `getOCIRuntimeError` を通すので、上位から見たエラーの型は揃う。

### エラーメッセージを正規表現で分類する

[`libpod/oci_util.go#L162`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_util.go#L162)。

```go title="libpod/oci_util.go"
func getOCIRuntimeError(name, runtimeMsg string) error {
	includeFullOutput := logrus.GetLevel() == logrus.DebugLevel

	if match := regexp.MustCompile("(?i).*permission denied.*|.*operation not permitted.*").FindString(runtimeMsg); match != "" {
		errStr := match
		if includeFullOutput {
			errStr = runtimeMsg
		}
		return fmt.Errorf("%s: %s: %w", name, strings.Trim(errStr, "\n"), define.ErrOCIRuntimePermissionDenied)
	}
	if match := regexp.MustCompile("(?i).*executable file not found in.*|.*no such file or directory.*|.*open executable.*").FindString(runtimeMsg); match != "" {
		...
		return fmt.Errorf("%s: %s: %w", name, strings.Trim(errStr, "\n"), define.ErrOCIRuntimeNotFound)
	}
```

**英語のエラーメッセージを正規表現で見て、意味のあるエラー型に変換している**。美しくはないが、これしか方法がない。OCI Runtime Spec はエラーコードを規定していないので、ランタイムが返すのは終了コードと自由形式のメッセージだけだからだ。

分類の結果は実用的な差になる。`ErrOCIRuntimeNotFound` は `podman run` の終了コード 127 (command not found) に対応し、`ErrOCIRuntimePermissionDenied` は 126 になる。**シェルの慣習に合わせた終了コードを返すために、この分類が要る**。

SELinux 関連の分岐も面白い。

```go title="libpod/oci_util.go"
	if match := regexp.MustCompile("`/proc/[a-z0-9-].+/attr.*`").FindString(runtimeMsg); match != "" {
		...
		if strings.HasSuffix(match, "/exec`") {
			return fmt.Errorf("%s: %s: %w", name, strings.Trim(errStr, "\n"), define.ErrSetSecurityAttribute)
		} else if strings.HasSuffix(match, "/current`") {
			return fmt.Errorf("%s: %s: %w", name, strings.Trim(errStr, "\n"), define.ErrGetSecurityAttribute)
		}
```

`/proc/<pid>/attr/exec` への書き込み失敗と `/proc/<pid>/attr/current` の読み取り失敗を区別している。SELinux ラベルの設定に失敗したときのエラーを具体的にするためだ。

デバッグレベルなら全文、そうでなければマッチした部分だけを出す (`includeFullOutput`) のも実用的な配慮になっている。

### 起動以外はランタイムを直接叩く

conmon を経由するのは `create` のときだけだ。それ以外は Podman が直接叩く。

```go title="libpod/oci_conmon_common.go"
	if err := utils.ExecCmdWithStdStreams(os.Stdin, os.Stdout, os.Stderr, env, r.path, append(r.runtimeFlags, "start", ctr.ID())...); err != nil {
```

`kill` も `delete` も同じ形。**ランタイムは状態をディスク (`/run/crun/<id>`) に持っている** ので、どのプロセスから叩いても同じコンテナを操作できる。これも「デーモンレスでも動く」ことの前提になっている。

## なぜそうなっているか

### プローブしないのは、コストに見合わないから

すべてのランタイムに対して `--help` を実行して機能を調べる、という方法はある。だが `podman` は 1 回のコマンドごとに `Runtime` を初期化するので、**毎回外部プロセスを起動することになる**。起動コストがそのまま体感速度に効く。

一方で、間違ったときの被害は小さい。`supportsJSON` が誤って true なら、余計な引数が渡って crun がエラーを出すが、そのエラーはパイプ経由で伝わる。**間違いのコストが小さい判断は、雑でよい**。overlayfs の判定を実測にしたのと対照的だ。

### エラー分類を正規表現でやるしかない

これは OCI Runtime Spec の弱点だ。仕様は「失敗したら非ゼロで終了する」としか定めていない。エラーの種類を機械可読に返す手段がない。

結果として、エンジン側が **ランタイムのエラーメッセージの文字列に依存する** ことになる。crun と runc でメッセージが違えば、片方だけ分類が効かない。ランタイムがメッセージを変えれば壊れる。それでもやるのは、「command not found なら 127」というユーザ体験を諦められないからだ。

**仕様の穴を、下流が正規表現で埋めている**。仕様を作る側から見ると、エラーの機械可読性を最初から入れておくことの価値がよく分かる例といえる。

### 2 経路にしたのは、片方が使えない場合があるから

`supportsJSON` が false なランタイムでは、JSON ログの経路が使えない。conmon 経由のメッセージだけが頼りになる。逆に conmon が異常終了した場合、パイプからは何も読めないがログファイルは残っているかもしれない。

**冗長な情報源を持ち、良い方から順に試す**。エラー処理のコードが長くなるのはこのためだが、「なぜ動かないか分からない」が一番コストの高い状態なので、割に合っている。

## どう活かすか

- **判断の確実さは、間違えたときのコストで決める。** 実測が要る判定 (overlayfs) と、設定リストで足りる判定 (ランタイムの機能) を使い分ける。全部を厳密にやるとコストが合わない。
- **外部プロセスとのパイプ読み取りには必ずタイムアウトを付ける。** goroutine + `select` の形は定型として覚えておく価値がある。
- **エラーの情報源は冗長に持ち、良い方から縮退させる。** 「構造化ログ → プロセスのメッセージ → 何も分からない」の 3 段は、どの外部プロセス連携でも使える形だ。
- **文字列を分類するなら、その脆さを認識して 1 か所に閉じる。** `getOCIRuntimeError` は 30 行の関数 1 つに正規表現を集めている。散らばっていたら、ランタイムのメッセージが変わったときに追えない。
- **プロトコルを設計するなら、エラーを機械可読にする。** OCI Runtime Spec がそうしなかった結果が、この正規表現だ。自分でプロセス間のプロトコルを決めるときは、エラーコードの体系を最初に入れる。
