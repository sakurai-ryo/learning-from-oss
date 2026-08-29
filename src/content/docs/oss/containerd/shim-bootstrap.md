---
title: "起動パラメータを stdin の protobuf 1 通に集約する"
description: "containerd 2.3 以前、shim にはコマンドライン引数と環境変数と stdin のバイト列で情報が散らばって渡っていた。bootstrap protocol はそれを 1 つの protobuf メッセージにまとめ、拡張フィールドを持たせた。古い shim との互換は「まず新しい形式で解釈し、失敗したら旧形式」で維持される。"
group: "コンテナを実行する"
sidebar:
  order: 41
---

## 何を学んだか

### 散らばっていた起動パラメータ

containerd 2.2 までの `start` サブコマンドは、次の 3 経路で情報を受け取っていた。

- **CLI フラグ** — `-namespace`, `-address`, `-publish-binary`, `-id`
- **環境変数** — `TTRPC_ADDRESS`, `GRPC_ADDRESS`, `MAX_SHIM_VERSION`, `SCHED_CORE`, `NAMESPACE`
- **stdin** — ランタイム固有オプションの protobuf

新しい設定を足すたびに、どの経路に載せるかを決める必要があった。しかも shim 実装ごとに解釈が微妙に違う余地があった。

### 1 通の protobuf に集約する

containerd 2.3 の bootstrap protocol では、`BootstrapParams` という protobuf メッセージ 1 つを stdin に流す。

```proto
message BootstrapParams {
  string instance_id = 1;
  string namespace = 2;
  LogLevel log_level = 3;
  string containerd_version = 4;
  string containerd_ttrpc_address = 5;
  string containerd_grpc_address = 6;
  string containerd_binary = 7;
  repeated Extension extensions = 8;
  optional string socket_dir = 9;
}
```

応答も `BootstrapResult` という protobuf になる。

### 拡張は Any のリストで

`extensions` フィールドが `google.protobuf.Any` のリストになっていて、**新しい設定を proto の変更なしに足せる**。

```proto
message Extension {
  // Examples of type URLs:
  //   - "containerd.io/cri.v1.PodSandboxConfig"
  //   - "containerd.io/nri.v1.PluginConfig"
  //   - "containerd.io/sandbox.v1.SandboxConfig"
  google.protobuf.Any value = 1;
}
```

型 URL で識別され、知らない型は無視される。ランタイム固有のオプションも、この拡張の 1 つとして渡る。

### 応答側も拡張を持つ

`BootstrapResult` にも `extensions` があり、shim が **自分にできることを申告する** 場所になっている。

```proto
  // containerd MUST ignore an extension whose type it does not recognize,
  // so a shim may advertise unconditionally and an older daemon will
  // simply keep its previous behavior.
```

「知らない拡張は無視しなければならない」と MUST で書かれているので、shim は無条件に申告してよい。古い containerd では単に効かないだけ。

現状の唯一の利用者が `MountCapabilities` で、mount manager の肩代わり範囲を決める ([mount manager: マウント型を拡張し、漏れを追跡する](../mount-manager/))。

## ソースコードのどこか

### パラメータの組み立て

[`core/runtime/v2/command.go#L128-L156`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/command.go#L128-L156)。

```go title="core/runtime/v2/command.go"
	} else if config.Action == "start" {
		// Use the new Bootstrap protocol for all newer shims.
		params := bootapi.BootstrapParams{
			InstanceID:             config.ID,
			Namespace:              ns,
			LogLevel:               bootapi.LogLevelFromString(config.LogLevel.String()),
			ContainerdVersion:      version.Version,
			ContainerdGrpcAddress:  config.GRPCAddress,
			ContainerdTtrpcAddress: config.TTRPCAddress,
			ContainerdBinary:       self,
		}
		...
		if config.Opts != nil {
			if err := params.AddExtension(config.Opts); err != nil {
				return nil, fmt.Errorf("unable to add runtime options extensions: %w", err)
			}
		}
```

ランタイムオプションが **拡張として** 追加される。以前は stdin の中身そのものだったものが、拡張の 1 要素になった。

`ContainerdBinary` に自分自身のパスを載せているのが目を引く。shim はこれを使って `containerd publish` を実行し、イベントを送り返す ([イベントは shim から publish バイナリで戻ってくる](../event-publisher/))。

### 古い shim への配慮

```go title="core/runtime/v2/command.go"
	// Special path when upgrading from 1.7 shims to 2.x containerd.
	// v1 shims would fail if passed wrong stdin data.
	// TODO: Remove in a future release in favor of Bootstrap protocol.
	execName := filepath.Base(config.RuntimePath)
	if strings.Contains(execName, "shim-runc-v1") || strings.Contains(execName, "shim-runhcs-v1") {
		if config.Opts != nil {
			d, err := proto.Marshal(config.Opts)
			...
			cmd.Stdin = bytes.NewReader(d)
		}
	}
```

**バイナリ名で古い shim を判定する**。`shim-runc-v1` や `shim-runhcs-v1` には旧形式で渡す。

美しくはないが、containerd をアップグレードしても既存の shim が動き続ける必要がある以上、こうするしかない。TODO で削除予定と明記してある。

### 応答のパース — 3 形式のフォールバック

[`core/runtime/v2/shim.go#L293-L321`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/shim.go#L293-L321)。

```go title="core/runtime/v2/shim.go"
func parseStartResponse(response []byte) (*bootapi.BootstrapResult, error) {
	var result bootapi.BootstrapResult

	if err := proto.Unmarshal(response, &result); err == nil {
		return &result, nil
	}

	// Fallback to legacy parsing for backward compatibility with legacy shims that return the address as a plain string or JSON.
	response = bytes.TrimSpace(response)

	// Decode into the whole message rather than a subset of its fields. A
	// bundle's bootstrap.json is written with encoding/json and read back
	// through here, so a field that is not decoded is silently lost on reload.
	params := &bootapi.BootstrapResult{}
	if err := json.Unmarshal(response, params); err != nil || params.Version < 2 {
		// Use TTRPC for legacy shims
		params = &bootapi.BootstrapResult{
			Address:  string(response),
			Protocol: "ttrpc",
			Version:  2,
		}
	}
```

3 形式を順に試す。

1. **protobuf** (2.3 以降)
2. **JSON** (1.7 以降。`{"version":2,"address":"...","protocol":"grpc"}`)
3. **アドレスの文字列そのまま** (最初期)

コメントが重要な指摘をしている。「**部分的なフィールドではなくメッセージ全体にデコードすること**。bundle の `bootstrap.json` はこの経路で読み戻されるので、デコードしないフィールドは reload 時に静かに失われる」。

同じ関数が「shim の応答のパース」と「ディスクからの復元」の両方に使われるため、片方の都合で手を抜くともう片方が壊れる。

### shim 側の互換判定

[`pkg/shim/compat.go#L32-L49`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/pkg/shim/compat.go#L32-L49)。

```go title="pkg/shim/compat.go"
var errDeprecatedBootstrapAPI = errors.New("shim was started through the deprecated API but was built against the new API; if you upgraded containerd, you may need to restart the daemon")

// parseBootstrapParams parses input from a caller using the bootstrap API.
// Legacy runtime options can unmarshal as BootstrapParams, so verify the
// identity against the command-line values.
func parseBootstrapParams(input []byte, cliID, cliNamespace string) (*bootapi.BootstrapParams, error) {
	params := &bootapi.BootstrapParams{}
	if len(input) == 0 {
		return nil, errDeprecatedBootstrapAPI
	}
	if err := proto.Unmarshal(input, params); err != nil {
		return nil, fmt.Errorf("%w: failed to unmarshal bootstrap parameters: %w", errDeprecatedBootstrapAPI, err)
	}
	if params.InstanceID != cliID || params.Namespace != cliNamespace {
		return nil, fmt.Errorf("bootstrap parameters do not match command-line arguments: %w", errDeprecatedBootstrapAPI)
	}
	return params, nil
}
```

**protobuf の緩さへの対処** が入っている。protobuf は未知のフィールドを無視するので、旧形式のランタイムオプションが `BootstrapParams` として "成功裏に" パースできてしまう。

そこで、パース結果の `InstanceID` と `Namespace` を **CLI 引数と突き合わせる**。一致しなければ旧形式だと判定する。

エラーメッセージも実務的だ。「新 API でビルドされた shim が旧 API で起動された。containerd をアップグレードしたなら、デーモンの再起動が必要かもしれない」。**利用者が次に取るべき行動** が書かれている。

### ソケットパスの長さ制約

```proto title="api/runtime/bootstrap/v1/bootstrap.proto"
  // Optional directory for the shim to place its unix socket.
  // If empty, the shim defaults to a short, well-known path
  // (e.g., /run/containerd/s). The path must be kept short because
  // the socket filename is a 64-character SHA256 hash and unix
  // socket paths are limited to 104-108 bytes depending on platform.
  optional string socket_dir = 9;
```

Unix ソケットのパス長は 104〜108 バイト。ファイル名が SHA256 の 64 文字なので、ディレクトリに使える長さは 40 バイト程度しかない。だから `/run/containerd/s` という極端に短いパスが既定になっている。

**プラットフォームの制約が、設定項目の説明として書かれている**。この制約を知らないと「なぜこんな短いパスなのか」が分からない。

## なぜそうなっているか

### 経路が分かれていると、拡張のたびに判断が要る

CLI フラグ、環境変数、stdin。3 経路あると、新しいパラメータをどれに載せるかを毎回決めることになる。そして実装ごとに「この環境変数は読む/読まない」の差が出る。

1 つの protobuf にまとめれば、

- **追加は proto のフィールド追加だけ** — 経路の選択が不要
- **型がある** — 文字列のパースミスがない
- **バージョン管理ができる** — protobuf の互換性ルールが使える
- **拡張フィールドで、proto すら変えずに足せる**

### 互換性の維持は「新しい形式を先に試す」

古い形式のサポートを残すとき、判定の順序が問題になる。containerd は **新しい形式を先に試し、失敗したら古い形式** という順序を採っている。

逆順 (古い形式を先に試す) だと、新しい形式のデータが古い形式として誤って解釈される可能性がある。実際 `parseBootstrapParams` では、protobuf の緩さのために誤解釈が起こりうるので、追加の検証を入れている。

**「パースできた」を成功と見なさず、内容の妥当性まで確認する** のが要点だ。

### 拡張を MUST 無視にする

`BootstrapResult.extensions` について「containerd は知らない拡張を無視しなければならない」と MUST で規定したことで、shim 側は **相手のバージョンを気にせず申告できる**。

もし「知らない拡張はエラー」だったら、shim は containerd のバージョンを見て申告を変える必要があり、組み合わせのテストが爆発する。

## どう活かすか

### shim の起動に失敗するとき

```
shim was started through the deprecated API but was built against the new API; if you upgraded containerd, you may need to restart the daemon
```

このエラーは、containerd と shim のバージョンがずれているときに出る。containerd をアップグレードしたのに古いプロセスが残っている、あるいは shim だけ更新した、といった状況だ。

```sh
$ containerd --version
$ containerd-shim-runc-v2 -v
```

両方のバージョンを確認する。既存のコンテナが動いている場合、古い shim は動き続けるので、新しく起動するコンテナだけが失敗する。

### プロセス間の起動パラメータを設計する

外部プロセスを起動して情報を渡す設計をするときの型。

- **経路を 1 つに絞る** — stdin の構造化データが最も扱いやすい
- **型付きのメッセージにする** — 環境変数と CLI フラグは文字列しか運べない
- **拡張フィールドを最初から入れる** — 後から足せる余地を作る
- **知らない拡張の扱いを規定する** — 無視するのか、エラーにするのか
- **互換のための判定は、内容の妥当性まで確認する** — パース成功を信じない

3 番目を最初から入れておくと、後の変更が劇的に楽になる。containerd の bootstrap protocol は「散らばった経路を統合する」ための後発の仕組みなので、その痛みを知ったうえで設計されている。
