---
title: "イメージを「どこから取るか」を transport で抽象化する"
description: "containers/image は「イメージの置き場所」を 9 種類の transport に抽象化し、あらゆる操作を「ある transport から別の transport へのコピー」1 つに畳んだ。podman pull は docker:// から containers-storage: へのコピー、podman save は逆向き、skopeo copy は同じ関数の直接呼び出しでしかない。Docker では pull と load と save が別々の実装になっているところが、ここでは 1 本になっている。"
group: "イメージとストレージ"
sidebar:
  order: 8
---

## 何を学んだか

### イメージの置き場所は 9 種類ある

`containers/image` は「イメージがどこにあるか」を **transport** という概念で抽象化する。名前を見れば分かるとおり、コマンドラインにそのまま現れる語彙だ。

| transport            | 指すもの                                       | 例                                      |
| -------------------- | ---------------------------------------------- | --------------------------------------- |
| `docker`             | レジストリ (OCI Distribution)                  | `docker://quay.io/podman/stable:latest` |
| `containers-storage` | ローカルの containers/storage ストア           | `containers-storage:nginx:latest`       |
| `docker-daemon`      | 動いている Docker デーモンのイメージストア     | `docker-daemon:nginx:latest`            |
| `docker-archive`     | `docker save` 形式の tar                       | `docker-archive:/tmp/img.tar`           |
| `oci`                | OCI Image Layout のディレクトリ                | `oci:/tmp/layout:latest`                |
| `oci-archive`        | OCI Image Layout を固めた tar                  | `oci-archive:/tmp/img.tar`              |
| `dir`                | blob をそのまま並べたディレクトリ (デバッグ用) | `dir:/tmp/blobs`                        |
| `tarball`            | 単一の tar を 1 レイヤのイメージとして読む     | `tarball:/tmp/rootfs.tar`               |
| `sif`                | Singularity のイメージ                         | `sif:/tmp/img.sif`                      |

そして **すべての操作が「ある transport から別の transport へのコピー」に還元される**。

| コマンド                      | 実体                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| `podman pull nginx`           | `docker://docker.io/library/nginx` → `containers-storage:`      |
| `podman push nginx quay.io/x` | `containers-storage:nginx` → `docker://quay.io/x`               |
| `podman save`                 | `containers-storage:` → `docker-archive:` または `oci-archive:` |
| `podman load`                 | `docker-archive:` → `containers-storage:`                       |
| `skopeo copy A B`             | A → B (任意の組み合わせ)                                        |

Docker では、`pull` はレジストリ専用のコードパス、`load` は tar 専用のコードパス、`save` はまた別、というふうに実装が分かれている。containers/image では **1 つの `copy.Image()` 関数** がすべてを担う。だから `podman pull docker-daemon:nginx:latest` (Docker デーモンから直接引っ張る) のような組み合わせが、追加実装なしで成立する。

### 抽象は 4 つのインターフェースでできている

- **`ImageTransport`** — 名前と、文字列を参照に変換する `ParseReference`
- **`ImageReference`** — 「どこの何」を指す不変な値。transport を跨いで比較できる
- **`ImageSource`** — manifest と blob を読み出せるもの
- **`ImageDestination`** — manifest と blob を書き込めるもの

コピーは「`ImageSource` から読んで `ImageDestination` に書く」だけになる。レジストリ固有の認証もリトライも、`docker` transport の `ImageSource` 実装の中に閉じる。

### 名前の解決は「短縮名」の問題に集約される

`podman pull nginx` の `nginx` はどこのレジストリの何か。Docker はこれを **`docker.io` にハードコード** している。containers/image は `registries.conf` の `unqualified-search-registries` で決める。

```toml
unqualified-search-registries = ["registry.fedoraproject.org", "quay.io", "docker.io"]
```

複数書けるので、社内レジストリを先に引かせることもできる。曖昧さの扱いには 3 つのモードがある。

- `disabled` — 短縮名を一切許さない
- `permissive` — 候補を順に試す
- `enforcing` — 対話的に選ばせ、選択を alias として記録する

「イメージ名を書いたら意図しないレジストリから引かれていた」という事故を、**設定と対話で潰す**設計になっている。Docker Hub 前提を外したかった、という動機がはっきり出ている部分だ。

## ソースコードのどこか

### transport はグローバルなレジストリに登録される

[`vendor/go.podman.io/image/v5/transports/alltransports/alltransports.go#L12-L21`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/image/v5/transports/alltransports/alltransports.go#L12)。

```go title="go.podman.io/image/v5/transports/alltransports/alltransports.go"
	// Register all known transports.
	// NOTE: Make sure docs/containers-transports.5.md and docs/containers-policy.json.5.md are updated when adding or updating
	// a transport.
	_ "go.podman.io/image/v5/directory"
	_ "go.podman.io/image/v5/docker"
	_ "go.podman.io/image/v5/docker/archive"
	_ "go.podman.io/image/v5/oci/archive"
	_ "go.podman.io/image/v5/oci/layout"
	_ "go.podman.io/image/v5/openshift"
	_ "go.podman.io/image/v5/sif"
	_ "go.podman.io/image/v5/tarball"
	// The docker-daemon transport is registeredy by docker_daemon*.go
	// The storage transport is registered by storage*.go
```

blank import による `init()` 登録。パースは単純な文字列分割だ。

```go title="go.podman.io/image/v5/transports/alltransports/alltransports.go"
func ParseImageName(imgName string) (types.ImageReference, error) {
	// Keep this in sync with TransportFromImageName!
	transportName, withinTransport, valid := strings.Cut(imgName, ":")
	if !valid {
		return nil, fmt.Errorf(`Invalid image name %q, expected colon-separated transport:reference`, imgName)
	}
	transport := transports.Get(transportName)
```

最初のコロンまでが transport 名、残りは transport 自身が解釈する。**transport ごとに参照の文法が違ってよい** ので、`docker://` のようなスラッシュ 2 本も、`oci:/path:tag` のようなパスとタグの組も、同じ枠に収まる。

### ImageTransport のコメントが抽象の意図を語る

[`vendor/go.podman.io/image/v5/types/types.go#L16-L38`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/image/v5/types/types.go#L16)。

```go title="go.podman.io/image/v5/types/types.go"
// ImageTransport is a top-level namespace for ways to store/load an image.
// It should generally correspond to ImageSource/ImageDestination implementations.
//
// Note that ImageTransport is based on "ways the users refer to image storage", not necessarily on the underlying physical transport.
// For example, all Docker References would be used within a single "docker" transport, regardless of whether the images are pulled over HTTP or HTTPS
// (or, even, IPv4 or IPv6).
//
// OTOH all images using the same transport should (apart from versions of the image format), be interoperable.
type ImageTransport interface {
```

「transport は **ユーザがイメージの置き場所をどう指すか** に基づいていて、物理的な転送方式には必ずしも対応しない」。HTTP か HTTPS か、IPv4 か IPv6 かは `docker` transport の内部の話にすぎない。

抽象の切り方を決めるとき、**実装の都合ではなくユーザの語彙で切る** という判断がここに明記されている。これは設計方針として真似する価値がある。

### pull が「コピー」であることが関数名に出ている

[`vendor/go.podman.io/common/libimage/pull.go#L225-L233`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libimage/pull.go#L225)。

```go title="go.podman.io/common/libimage/pull.go"
// copyFromDefault is the default copier for a number of transports.  Other
// transports require some specific dancing, sometimes Yoga.
func (r *Runtime) copyFromDefault(ctx context.Context, ref types.ImageReference, options *CopyOptions) ([]*Image, []string, error) {
	c, err := r.newCopier(options)
	if err != nil {
		return nil, nil, err
	}
	defer c.Close()

	// Figure out a name for the storage destination.
	var storageName, imageName string
	switch ref.Transport().Name() {
```

pull の実装が `copyFromDefault` という名前をしている。「他の transport には固有の踊りが要る、ときにはヨガが」というコメントが正直で、抽象が完全ではないことを認めている。実際、この `switch` は **「ストアに保存するときの名前をどう決めるか」** を transport ごとに分けている。

```go title="go.podman.io/common/libimage/pull.go"
	case ociTransport.Transport.Name():
		_, refName, ok := strings.Cut(ref.StringWithinTransport(), ":")
		if !ok || refName == "" {
			// Same trick as for the dir transport: we cannot use
			// the path to a directory as the name.
			storageName, err = getImageID(ctx, ref, &r.systemContext)
```

OCI レイアウトのディレクトリから引いた場合、そこには「イメージ名」がない。ディレクトリのパスを名前にするわけにはいかないので、**イメージ ID を名前にする**。抽象が漏れる箇所が、こういう形で具体的に現れる。

### pull の入口は「まず transport として解釈できるか」

[`vendor/go.podman.io/common/libimage/pull.go#L89-L100`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/libimage/pull.go#L89)。

```go title="go.podman.io/common/libimage/pull.go"
	var possiblyUnqualifiedName string // used for short-name resolution
	ref, err := alltransports.ParseImageName(name)
	if err != nil {
		// Check whether `name` points to a transport.  If so, we
		// return the error.  Otherwise we assume that `name` refers to
		// an image on a registry (e.g., "fedora").
		//
		// NOTE: the `docker` transport is an exception to support a
		// `pull docker:latest` which would otherwise return an error.
		if t := alltransports.TransportFromImageName(name); t != nil && t.Name() != registryTransport.Transport.Name() {
			return nil, err
		}
```

`podman pull fedora` の `fedora` は transport 名を含まないのでパースに失敗する。そこで「transport 名として解釈できないなら、レジストリ上のイメージ名だろう」と判断する。

例外の扱いが面白い。`docker:latest` という **イメージ名** は、`docker` transport の指定としても読めてしまう。だから「`docker` transport だけは例外扱いして、レジストリ上の `docker` イメージとして解釈する」という特別扱いを入れている。汎用の名前空間に具体的な名前が衝突した典型例だ。

## なぜそうなっているか

### コピー 1 本に畳めたのは、両側を同じインターフェースにしたから

「pull」「push」「save」「load」「import」「export」を別々に実装すると、組み合わせの数だけコードが要る。ソースと宛先を同じ形 (`ImageSource` / `ImageDestination`) に揃えると、**N × M の組み合わせが N + M の実装で済む**。

その恩恵は Skopeo という道具の存在そのものだ。Skopeo は「任意の transport 間でイメージをコピーする」ためだけのツールで、実装は `copy.Image()` を呼ぶだけに近い。エアギャップ環境への持ち込み (`docker://` → `oci-archive:`)、レジストリ間の移送 (`docker://` → `docker://`)、Docker からの移行 (`docker-daemon:` → `containers-storage:`) が全部同じコードで動く。

### 短縮名の解決を設定に出したのは、Docker Hub 依存を切るため

`docker.io` へのハードコードは、Docker が単一のエコシステムだった時代の前提だ。企業の内部レジストリ、Red Hat の `registry.access.redhat.com`、Quay — 複数のレジストリが並立する状況では、「短縮名がどこを指すか」は設定であるべきだという判断になる。

ただしこれは **移植性を犠牲にする**。`podman pull nginx` が環境によって違うイメージを引く可能性がある。だから `enforcing` モードでは対話的に確認させ、選んだ結果を alias として記録して以降は固定する、という妥協が用意されている。**設定可能にした結果として生まれる曖昧さを、対話と記録で潰す** という形だ。

## どう活かすか

- **N × M の変換を N + M にできないか考える。** 入力側と出力側を同じインターフェースに揃えられるなら、変換の組み合わせ爆発は消える。ETL でもフォーマット変換でも同じ構造が使える。
- **抽象はユーザの語彙で切る。** `ImageTransport` のコメントにある「物理的な転送方式ではなく、ユーザがどう指すか」という基準は、抽象の境界に迷ったときの判断材料になる。HTTP か HTTPS かで transport を分けていたら、この設計は破綻していた。
- **抽象が漏れる箇所を隠さない。** `copyFromDefault` の transport ごとの `switch` は、抽象の綻びをコードに正直に出している。無理に共通化するより、漏れる箇所を 1 か所に集めて `switch` にする方が読める。
- **デフォルトを設定に出すなら、曖昧さの解消手段も一緒に設計する。** 短縮名を設定可能にしたなら、「どれが選ばれたか分からない」問題が必ず出る。モードと alias の記録はその答えになっている。
