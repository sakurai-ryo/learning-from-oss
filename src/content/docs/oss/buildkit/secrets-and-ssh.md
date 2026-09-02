---
title: "secret が snapshot に残らない理由と SSH agent 転送"
description: "--mount=type=secret のファイルはホスト側の tmpfs 上に作られ、コンテナには bind mount で見えるだけ。レイヤの元になる snapshot ディレクトリには最初から書かれていない。SSH は鍵ではなく agent ソケットを転送し、署名要求だけをクライアントに往復させる。"
group: "セッション — 逆向きの gRPC"
sidebar:
  order: 68
---

## 何を学んだか

`RUN --mount=type=secret,id=token cat /run/secrets/token` で読めた値は、そのステップの結果レイヤに一切残らない。これは「コミット前に消している」のではなく、**secret のファイルが snapshot のディレクトリツリーの外に作られている**からだ。ホスト上の別ディレクトリに tmpfs を張り、そこに書いたファイルを read-only bind mount で見せる。diff を取るときに見る場所と、secret を置く場所が最初から違う。

SSH も同じ発想で、鍵そのものはデーモンに渡らない。コンテナ内に生えるのは Unix ソケットで、その向こう側はセッションを逆走してクライアントの ssh-agent に繋がっている。署名要求と署名結果だけが線を通る。

## ソースコードのどこか

### secret の取得口は 1 メソッドだけ

```proto title="session/secrets/secrets.proto"
service Secrets{
	rpc GetSecret(GetSecretRequest) returns (GetSecretResponse);
}

message GetSecretRequest {
	string ID = 1;
	map<string, string> annotations = 2;
}

message GetSecretResponse {
	bytes data = 1;
}
```

([session/secrets/secrets.proto L7](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/secrets/secrets.proto#L7))

デーモン側の呼び出しヘルパも短い。

```go title="session/secrets/secrets.go"
func GetSecret(ctx context.Context, c session.Caller, id string) ([]byte, error) {
	ctx = c.Context(ctx)
	client := NewSecretsClient(c.Conn())
	resp, err := client.GetSecret(ctx, &GetSecretRequest{
		ID: id,
	})
	if err != nil {
		if code := grpcerrors.Code(err); code == codes.Unimplemented || code == codes.NotFound {
			return nil, errors.Wrapf(ErrNotFound, "secret %s", id)
		}
		return nil, err
	}
	return resp.Data, nil
}
```

([session/secrets/secrets.go L18](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/secrets/secrets.go#L18))

`Unimplemented` (secret provider を登録していないクライアント) と `NotFound` (登録しているが該当 ID がない) を同じ `ErrNotFound` に潰しているのがポイントで、これによって `--mount=type=secret,required=false` の判定が呼び出し側で 1 箇所に書ける。

クライアント側の `SecretStore` インターフェースも `GetSecret(context.Context, string) ([]byte, error)` の 1 メソッドだけだ。標準実装の `fileStore` は、ID をファイルパスとしても環境変数名としても解釈する。

```go title="session/secrets/secretsprovider/store.go"
		if f.Env == "" && f.FilePath == "" {
			if _, ok := os.LookupEnv(f.ID); ok {
				f.Env = f.ID
			} else {
				f.FilePath = f.ID
			}
		}
```

([session/secrets/secretsprovider/store.go L24](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/secrets/secretsprovider/store.go#L24))

`buildctl --secret id=FOO` と書いたとき、`FOO` という環境変数があればそれ、なければ `FOO` というファイル、という順で解決される。大きさには上限があり、`MaxSecretSize = 500 * 1024` を超えるとサーバ側で `invalid secret size` になる ([secretsprovider.go L14](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/secrets/secretsprovider/secretsprovider.go#L14))。ファイル指定の場合は `NewStore` の時点で `os.Stat` して弾く。

### snapshot の外に置く

デーモン側で secret を取ってくるのはここだ。

```go title="solver/llbsolver/mounts/mount.go"
	err = mm.sm.Any(ctx, g, func(ctx context.Context, _ string, caller session.Caller) error {
		dt, err = secrets.GetSecret(ctx, caller, id)
		// ...
	})
	if err != nil {
		if errors.Is(err, secrets.ErrNotFound) && m.SecretOpt.Optional {
			return nil, nil
		}
		return nil, err
	}
	return &secretMount{mount: m, data: dt, idmap: mm.cm.IdentityMapping()}, nil
```

([solver/llbsolver/mounts/mount.go L252](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/mounts/mount.go#L252))

値はデーモンのメモリ上の `[]byte` に載る。実際にマウントを作るのは Linux 側の実装だ。

```go title="solver/llbsolver/mounts/secretmount_unix.go"
func (sm *secretMountInstance) Mount() ([]mount.Mount, func() error, error) {
	dir, err := os.MkdirTemp("", "buildkit-secrets")
	// ...
	var mountOpts []string
	if sm.sm.mount.SecretOpt.Mode&0o111 == 0 {
		mountOpts = append(mountOpts, "noexec")
	}

	tmpMount := mount.Mount{
		Type:    "tmpfs",
		Source:  "tmpfs",
		Options: append([]string{"nodev", "nosuid", fmt.Sprintf("uid=%d,gid=%d", os.Geteuid(), os.Getegid())}, mountOpts...),
	}
	// ...
	if err := mount.All([]mount.Mount{tmpMount}, dir); err != nil {
	// ...
	randID := identity.NewID()
	fp := filepath.Join(dir, randID)
	if err := os.WriteFile(fp, sm.sm.data, 0600); err != nil {
```

([solver/llbsolver/mounts/secretmount_unix.go L16](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/mounts/secretmount_unix.go#L16))

段取りを追うと、なぜレイヤに残らないかがはっきりする。

```
os.MkdirTemp("", "buildkit-secrets")   → /tmp/buildkit-secretsNNNN   (snapshot とは無関係のホスト上のディレクトリ)
mount tmpfs on /tmp/buildkit-secretsNNNN                             (ディスクに触れない)
write /tmp/buildkit-secretsNNNN/<randID>  ← secret の中身
                                                     ↓ bind, ro
コンテナ内 /run/secrets/token
```

コンテナから見えるのは最後の bind mount の結果だ。一方、実行後に差分を取ってレイヤにするのは snapshotter が管理する upper ディレクトリで、そこには secret ファイルは一度も書かれていない ([overlayfs の diff](../overlayfs-diff/))。コンテナ内の `/run/secrets/token` というパスは bind mount によって上書きされたマウントポイントなので、その下にあった (空の) ディレクトリエントリしか upper には残らない。

返されるマウントもハードニングされている。

```go title="solver/llbsolver/mounts/secretmount_unix.go"
	return []mount.Mount{{
		Type:    "bind",
		Source:  fp,
		Options: append([]string{"ro", "rbind", "nodev", "nosuid"}, mountOpts...),
	}}, cleanup, nil
```

`Source` がディレクトリではなくファイルパス (`fp`) である点に注目したい。ディレクトリごと見せると、同じ tmpfs に置いた他の secret も見えてしまう。ファイル名が `identity.NewID()` のランダム値なのも同じ理由で、コンテナ内から tmpfs のパスを推測して直接開くことができない。

`cleanup` は `mount.Unmount` してから `os.RemoveAll` する。tmpfs なのでアンマウントした時点で内容はカーネルのメモリから解放される。

`mode` に実行ビットが 1 つも立っていなければ `noexec` を足すのも、そう明示的に書いてあるだけの小さな守りだ。

### secret はキャッシュキーに「ID だけ」入る

ExecOp のキャッシュキーは、`pb.ExecOp` を JSON にしてダイジェストを取る形で作られる。

```go title="solver/llbsolver/ops/exec.go"
	dt, err := json.Marshal(struct {
		Type string
		Exec *pb.ExecOp
		// OS / Arch / Variant / OSVersion / OSFeatures
	}{
		Type: execCacheType,
		Exec: op,
		// ...
	})
	// ...
	dgst, err := cachedigest.FromBytes(dt, cachedigest.TypeJSON)
```

([solver/llbsolver/ops/exec.go L163](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L163))

`op.Mounts` にはマウントの `SecretOpt` (ID・マウント先・mode・uid/gid) が入っているので、これらはキーに効く。だが **secret の値は `pb.ExecOp` のどこにも存在しない**。値は実行直前に `getSecretMountable` がセッションから取ってくるものであって、LLB には載っていないからだ。

結果として:

- secret の値を変えても、キャッシュヒットは変わらない
- `id` を変えれば別のキーになる
- マウント先や mode を変えても別のキーになる

さらに、secret / SSH / tmpfs のマウントは入力の依存関係からも外されている。

```go title="solver/llbsolver/ops/exec.go"
	for _, m := range e.op.Mounts {
		switch m.MountType {
		case pb.MountType_SECRET, pb.MountType_SSH, pb.MountType_TMPFS:
			continue
		}
```

([solver/llbsolver/ops/exec.go L298](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L298))

これらは LLB の入力 vertex を持たないので、当然 content-based なキャッシュ計算の対象にもならない ([ExecOp のキャッシュマップ](../execop-cachemap/))。

「値を変えてもキャッシュが効いてしまう」のは一見バグに見えるが、[セッション共有](../session-manager/) の帰結として必然でもある。同じ vertex を 2 つのクライアントが共有していれば、どちらの secret が使われるかは非決定的だ。値をキーに入れたら、候補の選択順という観測不能な要素でキャッシュヒットが変わることになる。「secret はビルド結果に影響しない前提のもの (認証トークンやレジストリ資格情報) に使え」というのが、この設計が言外に要求している使い方だ。

### 環境変数経由の secret

マウントではなく環境変数として渡す口もある。

```proto title="solver/pb/ops.proto"
// SecretEnv is an environment variable that is backed by a secret.
message SecretEnv {
	string ID = 1;
	string name = 2;
	bool optional = 3;
}
```

([solver/pb/ops.proto L93](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/pb/ops.proto#L93))

ここでも LLB に載るのは `ID` と変数名だけで、値は実行直前に解決される。

```go title="solver/llbsolver/ops/exec.go"
	for _, sopt := range secretenv {
		id := sopt.ID
		// ...
		err = e.sm.Any(ctx, g, func(ctx context.Context, _ string, caller session.Caller) error {
			dt, err = secrets.GetSecret(ctx, caller, id)
			// ...
		})
		if err != nil && (!errors.Is(err, secrets.ErrNotFound) || !sopt.Optional) {
			return nil, err
		}
		out = append(out, fmt.Sprintf("%s=%s", sopt.Name, string(dt)))
	}
```

([solver/llbsolver/ops/exec.go L606](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L606))

結果は `meta.Env` に追加されてプロセスに渡る ([exec.go L498](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/ops/exec.go#L498))。マウント版と違ってファイルシステムに一切現れない代わりに、コンテナ内から `/proc/self/environ` で読めるし、子プロセスにも継承される。マウント版は読む場所を限定できるが、環境変数版は限定できない。この差は API の形にそのまま出ている。

なお `optional` が真で secret が見つからない場合も `out` への追加は行われるので、変数は空文字列で定義される。

Dockerfile フロントエンド側には、進捗表示に secret の値が漏れないようマスクする層が別にある (`withSecretEnvMask`, [frontend/dockerfile/dockerfile2llb/convert_secrets.go L92](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert_secrets.go#L92))。

### SSH — 鍵ではなくソケットを渡す

SSH の proto は 2 メソッド。

```proto title="session/sshforward/ssh.proto"
service SSH {
	rpc CheckAgent(CheckAgentRequest) returns (CheckAgentResponse);
	rpc ForwardAgent(stream BytesMessage) returns (stream BytesMessage);
}
```

([session/sshforward/ssh.proto L7](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/sshforward/ssh.proto#L7))

`CheckAgent` は「この ID の agent を持っているか」を先に確かめるためだけの RPC で、マウントを作る前に呼ばれる。

```go title="solver/llbsolver/mounts/mount.go"
	err := mm.sm.Any(ctx, g, func(ctx context.Context, _ string, c session.Caller) error {
		if err := sshforward.CheckSSHID(ctx, c, m.SSHOpt.ID); err != nil {
			// ... Optional なら nil、Unimplemented なら分かりやすいエラーに包む
			return err
		}
		caller = c
		return nil
	})
```

([solver/llbsolver/mounts/mount.go L156](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/mounts/mount.go#L156))

`Any` の候補のうち、実際に該当 ID を持っているクライアントが `caller` に固定される。ソケットは exec の間ずっと生きている必要があるので、ここだけは「毎回試す」ではなく「1 つに決めて掴む」形になる。

マウントの実体は Unix ソケットを 1 つ作ることだ。

```go title="session/sshforward/ssh.go"
	dir, err := os.MkdirTemp("", ".buildkit-ssh-sock")
	// ...
	sockPath = filepath.Join(dir, "ssh_auth_sock")

	listener := net.ListenConfig{}
	l, err := listener.Listen(context.TODO(), "unix", sockPath)
	// ...
	if err := os.Chown(sockPath, opt.UID, opt.GID); err != nil {
	// ...
	s := &server{caller: c}
	// ...
	go s.run(ctx, l, id) // erroring per connection allowed
```

([session/sshforward/ssh.go L66](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/sshforward/ssh.go#L66))

`sshMountInstance.Mount` はこれを bind mount としてコンテナに渡す ([mount.go L233](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/mounts/mount.go#L233))。secret と同じく、snapshot ツリーの外にあるパスを bind するだけだ。ソケットファイルはそもそもレイヤに保存できる種類のものではない。

接続が来るたびに `ForwardAgent` ストリームを 1 本開き、双方向にコピーする。

```go title="session/sshforward/ssh.go"
		for {
			conn, err := l.Accept()
			// ...
			client := NewSSHClient(s.caller.Conn())
			rpcCtx := s.caller.Context(ctx)

			opts := make(map[string][]string)
			opts[KeySSHID] = []string{id}
			rpcCtx = metadata.NewOutgoingContext(rpcCtx, opts)

			stream, err := client.ForwardAgent(rpcCtx)
			// ...
			go Copy(rpcCtx, conn, stream, stream.CloseSend)
		}
```

([session/sshforward/ssh.go L32](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/sshforward/ssh.go#L32))

クライアント側の受け口は、ID からダイアラを引いて同じ `Copy` を呼ぶだけ。

```go title="session/sshforward/sshprovider/raw_provider.go"
func (p *socketProvider) ForwardAgent(stream sshforward.SSH_ForwardAgentServer) error {
	id := sshforward.DefaultID
	ctx := stream.Context()
	opts, _ := metadata.FromIncomingContext(ctx)

	if v, ok := opts[sshforward.KeySSHID]; ok && len(v) > 0 && v[0] != "" {
		id = v[0]
	}

	dialer, ok := p.m[id]
	// ...
	conn, err := dialer(ctx)
	// ...
	return sshforward.Copy(ctx, conn, stream, nil)
}
```

([session/sshforward/sshprovider/raw_provider.go L32](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/sshforward/sshprovider/raw_provider.go#L32))

繋がるチェーン全体はこうなる。

```
コンテナ内 $SSH_AUTH_SOCK
  → bind mount
    → デーモン上の unix socket (/tmp/.buildkit-ssh-sockNNNN/ssh_auth_sock)
      → sshforward.Copy
        → SSH.ForwardAgent ストリーム (セッションを逆走)
          → クライアントの socketProvider
            → agent.ServeAgent または ホストの $SSH_AUTH_SOCK
```

秘密鍵はこのチェーンの一番右端から動かない。コンテナ内の `ssh` が投げるのは ssh-agent プロトコルの「この blob に署名しろ」で、返るのは署名だけだ。

### 鍵ファイルを指定した場合も、渡るのは agent

`--ssh default=/path/to/id_ed25519` のようにファイルを指定できるが、その場合もファイルの中身は転送されない。クライアントのプロセス内にメモリ上の keyring を立て、それを agent として提供する。

```go title="session/sshforward/sshprovider/agentprovider.go"
	a := agent.NewKeyring()
	for _, p := range paths {
		// ...
		k, err := ssh.ParseRawPrivateKey(dt)
		// ...
		if err := a.Add(agent.AddedKey{PrivateKey: k}); err != nil {
			return nil, errors.Wrapf(err, "failed to add %s to agent", p)
		}
		keys = true
	}
	// ...
	return source{agent: a}.agentDialer, nil
```

([session/sshforward/sshprovider/agentprovider.go L119](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/sshforward/sshprovider/agentprovider.go#L119))

ホストの agent ソケットを転送する場合には、さらに書き込み系の操作を全部塞いだラッパが挟まる。

```go title="session/sshforward/sshprovider/agentprovider.go"
type readOnlyAgent struct {
	agent.ExtendedAgent
}

func (a *readOnlyAgent) Add(_ agent.AddedKey) error {
	return errors.New("adding new keys not allowed by buildkit")
}

// Remove / RemoveAll / Lock / Extension も同様にエラーを返す
```

([session/sshforward/sshprovider/agentprovider.go L201](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/sshforward/sshprovider/agentprovider.go#L201))

`ssh-agent` プロトコルには「鍵を追加」「全部消す」「ロックする」がある。コンテナ内で走る `RUN` は任意のコマンドなので、そのままホストの agent に繋ぐと開発者の agent から鍵を消せてしまう。ここで塞いでいるのは、agent 転送の露出面を「署名と鍵一覧の取得」だけに絞るためだ。

さらにクライアント側は転送のたびに `net.Pipe()` を挟んで、その上で `agent.ServeAgent` を動かす。

```go title="session/sshforward/sshprovider/agentprovider.go"
	c1, c2 := net.Pipe()
	go func() {
		agent.ServeAgent(a, c1)
		c1.Close()
		if agentConn != nil {
			agentConn.Close()
		}
	}()

	return c2, nil
```

([session/sshforward/sshprovider/agentprovider.go L99](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/sshforward/sshprovider/agentprovider.go#L99))

デーモンから届いたバイト列がホストの agent ソケットに素通しされるのではなく、一度 Go の agent 実装でパースされて `readOnlyAgent` を通ってから、改めてホストの agent に投げ直される。プロトコルレベルの検閲点がここにある。

例外は `Raw: true` の場合で、こちらは `socket.Dial` の結果を素通しする ([agentprovider.go L181](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/session/sshforward/sshprovider/agentprovider.go#L181))。ssh-agent 以外の任意の Unix ソケットを転送したいケース向けで、その代わり `readOnlyAgent` の保護は効かない。

## なぜそうなっているか

secret を「レイヤに残さない」を実現する方法は 2 つある。書いてから消すか、最初から別の場所に書くか。前者は「消し忘れ」「途中で失敗した場合」「overlayfs の whiteout が残る」という穴が全部残る。後者は、diff を取る場所と secret を置く場所が別のマウント名前空間上のオブジェクトになるので、穴の作りようがない。BuildKit は後者を選んだ。

同じ構造が SSH にも効いている。「鍵ファイルをコンテナに置いて、後で消す」ではなく「鍵は最初からコンテナ側に存在しない」。ソケット経由の間接参照にしたことで、レイヤ汚染とホスト側 agent の保護の両方が同時に片付いた。しかも `readOnlyAgent` という薄いラッパで、露出する操作を絞る場所が 1 箇所にまとまっている。ここで引かれている境界は、[スコープと信頼境界](../scope-and-trust/) で見た「デーモンは複数の利用者に共有される」という前提の延長線上にある。

キャッシュキーに ID だけを入れるのは、意図というより制約の帰結だ。値をキーに入れるには値が LLB に載っていなければならないが、載せた時点で `buildctl --debug` で見えるし、リモートキャッシュにも書き出されてしまう。値をセッション越しの遅延解決にすると決めた時点で、キーに入るのは ID までになる。

## どう活かすか

- **「後で消す」より「最初から別の場所に置く」。** 削除に依存する設計は、異常終了・タイムアウト・部分書き込みのすべてでリークする。ライフサイクルが違うデータは、そもそも別のストレージ・別の名前空間に置く方が、証明が楽で穴が少ない。
- **単一ファイルの bind mount と、ランダムなファイル名。** ディレクトリごと見せると同居する他の秘密も見える。BuildKit は `Source` にファイルパスを指定し、そのファイル名を `identity.NewID()` にした。2 行で 2 種類の漏洩を潰している。
- **信頼できない側にプロトコルを素通ししない。** ホストの ssh-agent に生のバイト列を流すのではなく、一度パースして許可した操作だけを通す。`readOnlyAgent` は 20 行程度だが、「コンテナ内の任意コードが開発者の agent から鍵を消せる」を構造的に不可能にしている。
- **秘密を渡す口を「ファイル」と「環境変数」で使い分ける。** ファイル (マウント) は読める場所を限定できるが、環境変数は `/proc/self/environ` と子プロセス継承で広がる。API の形が露出範囲を決める。
- **キャッシュキーに含めるものと含めないものを、明示的に決めて書き残す。** BuildKit の場合「ID とマウント先は入る、値は入らない」であり、これは「secret の値がビルド結果を変えてはいけない」という利用者向けの制約と表裏一体になっている。
