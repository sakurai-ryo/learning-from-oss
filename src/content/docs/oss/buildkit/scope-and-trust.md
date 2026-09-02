---
title: "スコープと信頼境界 — 何を守り、何を守らないか"
description: "PROJECT.md には「何をセキュリティ問題とみなすか」が Host / Client / Untrusted sources / Stored data の 4 面で明文化され、さらに「セキュリティ問題とみなさない例」まで列挙されている。この線引きが、セッション・フロントエンド・キャッシュの実装を規定している。"
group: "ビルドを解く前に"
sidebar:
  order: 5
---

## 何を学んだか

BuildKit は `PROJECT.md` に **"Project scope"** と **"Security boundary"** という 2 つの節を持ち、そこで「何をやるか」と「何を守るか」を明文化している。この 2 節は README よりもソースの構造をよく説明する。セッションが逆向きの gRPC になっている理由、フロントエンドがコンテナに閉じ込められている理由、secret がキャッシュキーに入らない理由は、すべてここに書かれた要求から出ている。

特に重要なのは、**「セキュリティ問題とみなさない例」が明示的に列挙されている**ことだ。何を守らないかを書いておくのは、何を守るかを書くのと同じくらい設計に効く。

## Project scope — 何をやるか、何をやらないか

```
- BuildKit provides the best solution for defining a build graph, executing and caching it as efficiently as possible, and exporting the result to a place where it can be used by other tools.
- BuildKit uses containers as an execution sandbox and distribution platform.
- BuildKit provides an API that is flexible enough to be used in many tools and use cases.
- BuildKit is secure by default and can be used with untrusted sources.
- The purpose of BuildKit's command line tool `buildctl` is to expose API features as directly as possible.
```

([PROJECT.md L113-L118](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L113-L118))

1 行目の「グラフを定義し、実行し、キャッシュし、エクスポートする」がそのまま章の骨格になっている。2 行目の「コンテナを実行サンドボックスかつ配布プラットフォームとして使う」は二重の意味を持っていて、ビルドステップの実行環境がコンテナであるだけでなく、**フロントエンド自体もコンテナイメージとして配布される** ([#syntax= はフロントエンドの再帰呼び出しである](../syntax-directive/))。

`buildctl` の位置づけも明確だ。「API の機能をできるだけ直接露出する」ためのツールであり、使いやすさは目的ではない。だから `buildctl build` は `--frontend`、`--local`、`--opt`、`--output` という API のパラメータをほぼそのまま並べたインターフェースになっている ([buildctl build から結果が出るまでを追う](../buildctl-walkthrough/))。

やらないことのリストも短い。

```
Things that **do not** define BuildKit:

- Running processes on the host.
- Solving the following issues that should be left for external projects, such as:
  - Combining multiple build requests together
  - Managing and deploying BuildKit instances
  - Inventing new frontends
  - Running containers from mutable state
- Opinionated client-side UX features.
```

([PROJECT.md L121-L129](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L121-L129))

「ホスト上でプロセスを走らせない」は Host の信頼境界と対になる。「新しいフロントエンドを発明しない」は、フロントエンドを拡張点として外に出すという設計判断を、プロジェクトの範囲としても宣言している。

## Security boundary — 4 つの面

### Host — ホストのファイルシステムに触らせない

```
- The BuildKit API with default daemon configuration does not allow changes to the host filesystem or reading the host filesystem outside of the BuildKit state directory.
- Application and frontend containers are not allowed to read or write to the host system, run privileged system calls, or access external devices directly. Monitoring the load of the system is allowed.
```

([PROJECT.md L139-L140](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L139-L140))

「アプリケーションコンテナ**と** フロントエンドコンテナ」と並記されているのが要点だ。フロントエンドは BuildKit の一部ではなく、ビルド対象と同じ扱いの信頼できないコードとして扱われる。特権 syscall を許すには明示的な entitlement が要り、`SolveRequest.Entitlements` として API に露出している ([OCI spec の生成、entitlements、RUN --mount=type=cache](../oci-spec-and-mounts/))。

### Client — 列挙されたパスの外に出さない

```
- Buildctl does not allow access to any directories or file paths that are not explicitly set by the user with command line arguments. The untrusted BuildKit daemon does not have any way to access files that were not listed.
- When extracting build results to a directory specified with `--output` or `--cache-to`, no subfile can escape to the outside directory (e.g. via symlinks)
```

([PROJECT.md L144-L145](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L144-L145))

**「信頼できない BuildKit デーモン」**という言い方が効いている。クライアントはデーモンを信用していない。これが、ビルドコンテキストを先に丸ごと送らずセッション越しに要求させる設計の根拠になっている ([デーモン・クライアント・フロントエンドの三者関係](../daemon-client-frontend/)、[filesync](../filesync/))。

2 つ目はシンボリックリンクによる脱出の禁止で、これは exporter とキャッシュエクスポートの実装に対する要求になる。

### Untrusted sources — 信用できない入力を受け付ける前提で作る

```
- Although discouraged, you can use untrusted resources in your build, like images, frontend, URLs. These resources, or containers created from the files of these resources, should not have a way to read/write/execute in the host or crash the BuildKit daemon.

  Exceptions:

  - Containers can use system resources (CPU, memory, disk) without specific limits.
  - Untrusted remote cache imports may not be used.
```

([PROJECT.md L149-L154](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L149-L154))

例外の 2 つ目は重い。**信頼できないリモートキャッシュのインポートは保護対象外**であり、後述の「セキュリティ問題とみなさない例」でも繰り返される。キャッシュのインポートは「このキーの結果はこれです」という主張を外部から受け入れる操作なので、主張が嘘なら誤ったキャッシュヒットが起きる ([リモートキャッシュ](../remotecache-backends/))。

フロントエンドに対する要求は、この節でいちばん細かい。

```
- An untrusted frontend may not export build results to a location (client-side directory, registry) without user permission with a specific build request. If the frontend initializes a pull with credentials from the client, this needs to be logged on the client-side progress stream.
- Frontends can not access registry credentials or tokens that a build is using, the SSH private keys used in SSH forwarding, nor keys that may be used to sign build results or attestations. Frontends can provide SBOM attestation for the builds it has performed but it can not alter the contents of provenance attestations generated by BuildKit daemon.
- If a build was started with a policy file, the untrusted frontend has no way to use resources that are denied by that policy.
```

([PROJECT.md L156-L158](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L156-L158))

3 つの要求が、それぞれ実装の具体的な箇所に対応している。

- 認証情報・SSH 秘密鍵・署名鍵をフロントエンドに見せない → 認証はクライアント側でトークンに変換してから渡す ([認証情報はクライアントから出ない](../auth-delegation/))、secret はマウント経由でしか渡らない ([secret が snapshot に残らない理由と SSH agent 転送](../secrets-and-ssh/))
- provenance の中身をフロントエンドが書き換えられない → provenance は solver が DAG を歩いて生成する ([provenance](../provenance/))
- source policy で拒否されたリソースをフロントエンドが使えない → ポリシー評価は bridge の下、LLB のロード時に入る ([sourcepolicy](../sourcepolicy/))

「クライアントの認証情報で pull を始めたら、クライアント側の進捗ストリームに記録されなければならない」という一文は、**防げないものは可視化する**という方針の表れだ。

### Stored data — ディスクとキャッシュキーに残さない

```
- Credentials should not be logged or written to OpenTelemetry trace or progress stream. Note that this applies to registry credentials and URL sources, if user writes credentials into the arguments of their application containers, there is nothing BuildKit can do about it.
- Values of the build secrets should never be stored anywhere on the disk or included in the cache checksums.
```

([PROJECT.md L162-L163](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L162-L163))

後半が、キャッシュ設計への直接の制約になっている。**secret の値をキャッシュのチェックサムに含めてはいけない。** `RUN --mount=type=secret` の内容が変わってもキャッシュヒットするのはこのためで、正しさとのトレードオフを承知のうえでの決定だ。`ExecOp.CacheMap` が `SecretOpt` を持つマウントの扱いを分けているのは、この要求に対応している ([ExecOp の CacheMap](../execop-cachemap/))。

前半には「ユーザがアプリケーションコンテナの引数に認証情報を書いたら BuildKit には何もできない」と、守れない範囲が正直に書かれている。

## 守らないと決めたこと

この節が `PROJECT.md` でいちばん珍しい。

```
- Multiple concurrent builds from separate client share their build resources without namespacing. For example, if both builds require pulling the same image, the pull only happens once and is authenticated only once. ... If different behavior is needed, consider running multiple instances of buildkitd for each of the namespaces.
- Remote cache resources provided with `--cache-from` need to be trusted by the user. If they have been manipulated by an attacker, this can result in an incorrect cache match by BuildKit solver.
- Application containers may cause the system to run out of resources (e.g. memory). In that case BuildKit should be configured with a cgroup parent.
- By default, registry credentials are not shared with BuildKit daemon, and short-lived token is generated on client side instead. For backward compatibility this can be bypassed ...
- Untrusted frontends are free to run any builds, for example, they can run a container with a secret mounted and then read out the secret value. They are not allowed to see your registry credentials/tokens or signing keys.
```

([PROJECT.md L167-L171](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L167-L171))

4 つの「守らない」が挙がっている。

**1. ビルド間の名前空間分離をしない。** 別々のクライアントの 2 つのビルドが同じイメージを要求したら、pull は 1 回だけ、認証も 1 回だけ行われる。同じ secret を使うコンテナも、前回のビルドのローカルキャッシュや cache mount も共有される。これは solver がジョブをまたいで edge を共有する設計 ([ジョブの共有と破棄](../job-sharing/)) の直接の帰結で、性能のためにこの分離を捨てている。必要ならデーモンを分けろ、という回答になっている。

**2. リモートキャッシュの中身を検証しない。** `--cache-from` は信頼されたソースでなければならない。攻撃者が改竄すれば誤ったキャッシュヒットが起きる。

**3. リソース枯渇を防がない。** cgroup parent を設定するのは運用側の責任。

**4. フロントエンドが secret を読むこと自体は防がない。** フロントエンドは任意のビルドを走らせられるので、secret をマウントしたコンテナを作って中身を読み出せる。防いでいるのは「レジストリの認証情報・トークン・署名鍵を**フロントエンドに見せない**」ことだけだ。この区別は繊細で、**「secret は使われる先で読める」と「認証情報は仲介者に渡らない」は別の話**だという整理になっている。

## なぜそうなっているか

守らないと決めたものには共通点がある。**どれも「防ごうとすると根幹の設計を壊す」**ものだ。ビルド間の名前空間分離を入れると、edge の共有もキャッシュの共有も成立しなくなり、BuildKit の性能上の主張が崩れる。リモートキャッシュの検証は、そもそも「キャッシュの主張が正しいこと」を暗号学的に保証する手段が現実的でない。

だから境界を引き直す代わりに、**「これは守らない」と書いて、代替手段 (デーモンを分ける、cgroup を設定する、信頼できるキャッシュだけ使う) を添える**という形をとっている。これは曖昧に濁すよりも遥かに扱いやすい。利用者は自分のリスクを評価でき、報告者は「これは既知の範囲外」と即座に判断でき、開発者は新機能がどの境界に触れるかを既存の記述と照らせる。

節の冒頭にはこうも書かれている。

> This section is for some guidelines about what BuildKit considers a security issue and what kind of guarantees all future BuildKit features should provide.

([PROJECT.md L135](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/PROJECT.md#L135))

「**今後のすべての機能が提供すべき保証**」— 過去の脆弱性リストではなく、これから書くコードへの要求仕様として書かれている。

## どう活かすか

**守らないことを書く。** 脅威モデルの文書は「守るもの」だけを書きがちだが、範囲外を列挙しないと、報告のたびに議論が再燃し、機能追加のたびに境界が曖昧になる。BuildKit の "Examples of issues not (currently) considered security" は、`(currently)` という留保つきで範囲外を固定していて、将来の変更余地も残している。

**守れないものは可視化に切り替える。** 「フロントエンドがクライアントの認証情報で pull を始めたら、クライアント側の進捗ストリームに記録する」は、禁止できないことを検知可能にする典型だ。防御が不可能な操作を見つけたとき、可視化に落とせないかを次に検討する。

**信頼境界の記述を、実装の各所から参照できる粒度で書く。** BuildKit の 4 面 (Host / Client / Untrusted sources / Stored data) は、それぞれセッション、exporter、フロントエンド、キャッシュという別のサブシステムに対応している。「セキュリティに配慮する」という一般論ではなく、「secret の値はキャッシュのチェックサムに含めない」という粒度まで下ろすと、コードレビューで実際に使える基準になる。
