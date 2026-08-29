---
title: "sandbox と task が 1 つの shim に同居する"
description: "sandbox として起動された shim に、後からコンテナのタスクが追加される。containerd は shim バイナリを起動せず、sandbox のエンドポイントに繋いで TaskService.Create を送るだけだ。ただし古い shim はこの方式に対応していないので、バージョンを見て経路を切り替える。"
group: "サンドボックスと CRI"
sidebar:
  order: 56
---

## 何を学んだか

### shim は 2 つのサービスを提供する

sandbox 対応の shim は、1 つの ttrpc 接続の上で 2 つのサービスを提供する。

- **`SandboxService`** — `CreateSandbox` / `StartSandbox` / `StopSandbox` / `SandboxStatus` / `Platform`
- **`TaskService`** — `Create` / `Start` / `Kill` / `Delete` / `Exec` / ...

sandbox controller が前者を、task manager が後者を使う。**同じ接続を共有する**。

### タスク追加時は shim を起動しない

コンテナを sandbox に追加するとき、`ShimManager.Start` は次のように振る舞う。

1. `opts.SandboxID` があれば、sandbox ストアからその sandbox を引く
2. sandbox のエンドポイント (アドレス) を取得する
3. **shim バイナリを起動せず**、そのアドレスに接続する
4. bundle に `sandbox` ファイルと `bootstrap.json` を書く
5. 接続を shim インスタンスとして登録する

`start` サブコマンドの実行が丸ごと省略される。

### 古い shim には別経路

containerd 1.6 / 1.7 で作られた sandbox や、sandbox API に対応していない shim では、この経路が使えない。判定は **shim のバージョン番号** で行う。

バージョン 3 未満なら、従来通り `shim` バイナリを起動する。

### アドレスの形式

sandbox controller が返すアドレスは `<protocol>+<transport>://...` という形式になっている。

```
ttrpc+unix:///run/containerd/s/abc...
grpc+vsock://3:1024
```

VM ベースのランタイムでは **vsock** が使われる。ホストとゲストの間の通信で、Unix ソケットが使えないからだ。

## ソースコードのどこか

### sandbox のエンドポイントを解決する

[`core/runtime/v2/shim_manager.go#L205-L260`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/shim_manager.go#L205-L260)。

```go title="core/runtime/v2/shim_manager.go"
	if opts.SandboxID != "" {
		_, sbErr := m.sandboxStore.Get(ctx, opts.SandboxID)
		if sbErr != nil {
			if !errors.Is(sbErr, errdefs.ErrNotFound) {
				return nil, sbErr
			}

			log.G(ctx).WithField("id", id).Warningf("sandbox (id=%s) not found, maybe created from v1.x", opts.SandboxID)
			// NOTE: If sandbox container, like pause, is created by
			// v1.6.x or v1.7.x, the shim may be not able to group
			// multiple containers. We should invoke shim binary and
			// establish new connection based on returned address.
			shouldInvokeShimBinary = true
		}
```

sandbox ストアに記録がない = **1.x 時代に作られた sandbox**。containerd をアップグレードした直後、既存の Pod がこの状態になる。

その場合は従来の経路 (shim バイナリを起動する) に落ちる。実際には [grouping](../shim-grouping/) が効いて既存の shim に合流するので、動作は変わらない。

**アップグレードの途中で作られたコンテナも動く** ようにするための配慮だ。

### アドレスのパース

```go title="core/runtime/v2/shim_manager.go"
			if opts.Address != "" {
				// The address returned from sandbox controller should
				// be in the form like ttrpc+unix://<uds-path> or grpc+vsock://<cid>:<port>,
				// we should get the protocol from the url first.
				protocol, address, ok := strings.Cut(opts.Address, "+")
				if !ok {
					return nil, fmt.Errorf("the scheme of sandbox address should be in " +
						" the form of <protocol>+<unix|vsock|tcp>, i.e. ttrpc+unix or grpc+vsock")
				}
				params = &bootapi.BootstrapResult{
					Version:  int32(opts.Version),
					Protocol: protocol,
					Address:  address,
				}
```

RPC のプロトコル (`ttrpc` / `grpc`) とトランスポート (`unix` / `vsock` / `tcp`) が `+` で連結される。**2 つの直交する選択肢を 1 つの文字列で表す** 形式になっている。

エラーメッセージに期待する形式が書かれているので、外部の sandbox controller を書く人が形式を間違えても分かる。

### 能力の申告を引き継ぐ

```go title="core/runtime/v2/shim_manager.go"
				// The sandbox controller only returns connection details, not
				// what its shim advertised at startup. Recover that from the
				// shim instance containerd already has in memory for this
				// sandbox, so a container joining it is not treated as if the
				// shim advertised nothing.
				if process, err := m.Get(ctx, opts.SandboxID); err == nil {
					params.Extensions = sandboxShimExtensions(process)
				}
```

sandbox controller が返すのは接続情報だけで、**shim が起動時に申告した能力 (`MountCapabilities` など) は含まれない**。

そのままだと「何も申告していない shim」として扱われ、mount manager が余計なマウントをしてしまう ([mount manager: マウント型を拡張し、漏れを追跡する](../mount-manager/))。

だからメモリ上の shim インスタンスから申告を取り出して補う。**情報の経路が 2 つあるときの、抜け落ちへの対処** が書かれている。

### バージョンによる分岐

```go title="core/runtime/v2/shim_manager.go"
	// Even though one shim can be able to group multiple containers,
	// it doesn't mean it supports sandbox API. The old shim implementation
	// still requires containerd to invoke `shim delete` to cleanup
	// container's resource when each container exits. So, if the
	// shim version is not higher than 3, we should fallback to invoke
	// shim binary.
	//
	// NOTE: The shim version indicates that the shim supports streaming I/O.
	// It's rolled out together with the sandbox API and can be used
	// to determine whether we should invoke the shim binary.
	const supportSandboxAPIVersion = 3
	if params.Version < supportSandboxAPIVersion {
		shouldInvokeShimBinary = true
	}
```

コメントが 2 つの区別を説明している。

- **グルーピングできる** ≠ **sandbox API に対応している**
- 古い shim は、コンテナごとに `shim delete` を呼んでもらう必要がある

そして「バージョン 3 は本来ストリーミング I/O 対応を示すが、sandbox API と同時にロールアウトされたので判定に使える」。

**本来の意味と違う用途にバージョン番号を使っている** ことを、正直に書いている。厳密には別の capability として持つべきだが、実際上これで判定できる。

### 起動を省略する経路

```go title="core/runtime/v2/shim_manager.go"
	if !shouldInvokeShimBinary {
		// Write sandbox ID this task belongs to.
		if err := os.WriteFile(filepath.Join(bundle.Path, "sandbox"), []byte(opts.SandboxID), 0600); err != nil {
			return nil, err
		}

		if err := writeBootstrapParams(filepath.Join(bundle.Path, "bootstrap.json"), params); err != nil {
			return nil, fmt.Errorf("failed to write bootstrap.json for bundle %s: %w", bundle.Path, err)
		}

		shim, err := loadShim(ctx, bundle, func() {})
		if err != nil {
			return nil, fmt.Errorf("failed to load sandbox task %q: %w", opts.SandboxID, err)
		}

		if err := m.shims.Add(ctx, shim); err != nil {
			return nil, err
		}

		return shim, nil
	}
```

`loadShim` — つまり **[再起動時の復元と同じ関数](../shim-reconnect/)** を使う。「既に動いている shim に繋ぐ」という点で状況が同じだからだ。

bundle に `sandbox` ファイルを書くのが重要で、**このタスクがどの sandbox に属するか** の記録になる。containerd が再起動したとき、この情報から関係を復元する。

`bootstrap.json` も書く。次回の起動時には、sandbox ストアを引かずにこのファイルから接続先が分かる。

`onClose` コールバックが空関数 (`func() {}`) なのに注目したい。この shim 接続が切れても、**sandbox の shim なので勝手に片付けてはいけない**。sandbox のライフサイクルは sandbox controller が管理する。

## なぜそうなっているか

### shim の起動コストを 1 Pod 1 回にする

shim の起動は、プロセスの fork/exec、ソケットの作成、ttrpc の接続確立を伴う。Pod あたり 3 コンテナなら、素朴には 3 回。

sandbox の shim を再利用すれば **1 回で済む**。Pod の起動時間に直接効く。

しかも [grouping](../shim-grouping/) と違って、`start` サブコマンドの実行すら発生しない。grouping では「起動してみて、既存があればアドレスを返す」だが、sandbox 経由なら「最初からアドレスを知っている」。

### 情報源が 2 つあることの難しさ

sandbox のエンドポイントは 2 か所にある。

- **sandbox ストア** (bbolt) — controller が保存したアドレス
- **メモリ上の shim インスタンス** — 起動時に得た完全な情報

前者には能力の申告が含まれない。だから両方を見て補完する必要がある。

これは「同じ情報を複数の場所に持つと、どこかが欠ける」という典型的な問題だ。containerd はコメントで理由を明示し、補完のコードを入れることで対処している。理想的には sandbox ストアに全部保存すべきだが、既存のスキーマを変える必要がある。

### 互換性のための分岐が積み上がる

このコードには 3 つの互換性分岐がある。

1. sandbox ストアに記録がない (1.x 時代の sandbox)
2. アドレスが渡されない (古い controller)
3. バージョンが 3 未満 (sandbox API 非対応の shim)

いずれも「アップグレード後に既存の Pod が動き続ける」ために必要だ。Kubernetes ノードでは containerd の更新中も Pod が動いているので、**新旧が混在する期間が必ずある**。

分岐が増えるのはコストだが、ノードのドレインなしでアップグレードできる価値のほうが大きい。

## どう活かすか

### タスクと sandbox の関係を見る

```sh
# タスクの bundle に sandbox ファイルがあるか
$ cat /run/containerd/io.containerd.runtime.v2.task/k8s.io/<container-id>/sandbox

# その sandbox の bundle
$ ls /run/containerd/io.containerd.sandbox.controller.v1.shim/k8s.io/<sandbox-id>/
```

`sandbox` ファイルの中身が sandbox ID。この対応関係で、コンテナがどの Pod に属するかが分かる。

### shim の数を確認する

```sh
$ ps -C containerd-shim-runc-v2 --no-headers | wc -l
$ crictl pods -q | wc -l
```

sandbox 経由で共有されていれば、shim 数 ≈ Pod 数になる。大きくずれている場合、互換経路に落ちている可能性がある。

```sh
$ journalctl -u containerd | grep "maybe created from v1.x"
```

このログが出ていれば、1.x 時代の sandbox が残っている。

### 「接続を共有する」設計

複数の論理的なサービスを 1 つの接続に載せるとき、containerd の例から学べる点。

- **サービスを分けても、接続は共有できる** — ttrpc も gRPC も多重化に対応している
- **接続情報の保存先を 1 か所にする** — 分かれると情報が欠ける
- **接続の所有者を明確にする** — 誰が閉じるのか、誰が再接続するのか
- **バージョンで能力を判定するなら、その意味を文書化する** — 別の意味を持つ番号を流用しない

3 番目が特に効く。containerd は「sandbox の shim 接続は sandbox controller が所有し、タスクは借りるだけ」という関係を、`onClose` を空にすることで表現している。借り手が接続を片付けてしまうと、他のタスクが巻き添えになる。
