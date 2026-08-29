---
title: "errdefs: エラーの意味を境界で保つ"
description: "ErrNotFound や ErrAlreadyExists といった 16 個のエラー種別を定義し、gRPC のステータスコードと相互変換する。プロセス境界を越えてもエラーの意味が保たれるので、呼び出し側は「既にあるからスキップ」といった判断ができる。判定はインターフェースの実装でも行われ、Moby のエラー型とも互換になっている。"
group: "運用と拡張"
sidebar:
  order: 61
---

## 何を学んだか

### 16 個のエラー種別

```go
var (
	ErrUnknown            = errUnknown{}
	ErrInvalidArgument    = errInvalidArgument{}
	ErrNotFound           = errNotFound{}
	ErrAlreadyExists      = errAlreadyExists{}
	ErrPermissionDenied   = errPermissionDenied{}
	ErrResourceExhausted  = errResourceExhausted{}
	ErrFailedPrecondition = errFailedPrecondition{}
	ErrConflict           = errConflict{}
	ErrNotModified        = errNotModified{}
	ErrAborted            = errAborted{}
	ErrOutOfRange         = errOutOfRange{}
	ErrNotImplemented     = errNotImplemented{}
	ErrInternal           = errInternal{}
	ErrUnavailable        = errUnavailable{}
	ErrDataLoss           = errDataLoss{}
	ErrUnauthenticated    = errUnauthorized{}
)
```

doc コメントが方針を述べている。

```go
// Definitions of common error types used throughout containerd. All containerd
// errors returned by most packages will map into one of these errors classes.
// Packages should return errors of these types when they want to instruct a
// client to take a particular action.
//
// These errors map closely to grpc errors.
```

「**クライアントに特定の行動を取らせたいとき** に、これらの型を返す」。エラーの分類は、受け取った側が何をするかで決まる。

### gRPC コードとの相互変換

- `ToGRPC(err)` — containerd のエラー → gRPC の `Status`
- `ToNative(err)` — gRPC の `Status` → containerd のエラー

**プロセス境界を往復してもエラーの意味が保たれる**。だから `ErrAlreadyExists` を「取得不要」の合図として使える ([remote snapshotter](../remote-snapshotter/)、[ingest](../content-ingest/))。

### 判定は 2 通り

```go
func IsNotFound(err error) bool {
	return errors.Is(err, errNotFound{}) || isInterface[notFound](err)
}
```

- **`errors.Is`** — containerd のエラー値と一致するか
- **インターフェースの実装** — `NotFound()` メソッドを持つか

2 番目があるので、**別のライブラリのエラー型でも判定できる**。Moby (Docker) のエラー型は同じインターフェースを実装しているので、そのまま通る。

### 独自メッセージを付けられる

```go
func (e errNotFound) WithMessage(msg string) error {
	return customMessage{e, msg}
}
```

`ErrNotFound.WithMessage("image not found")` で、種別を保ったままメッセージを差し替えられる。`fmt.Errorf("%w", ...)` でラップする方法もあるが、こちらは **メッセージを完全に置き換える**。

## ソースコードのどこか

### エラー型の作り方

[`vendor/github.com/containerd/errdefs/errors.go#L53-L90`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/vendor/github.com/containerd/errdefs/errors.go#L53-L90)。

```go title="vendor/github.com/containerd/errdefs/errors.go"
type errUnknown struct{}

func (errUnknown) Error() string { return "unknown" }

func (errUnknown) Unknown() {}

func (e errUnknown) WithMessage(msg string) error {
	return customMessage{e, msg}
}

// unknown maps to Moby's "ErrUnknown"
type unknown interface {
	Unknown()
}

// IsUnknown returns true if the error is due to an unknown error,
// unhandled condition or unexpected response.
func IsUnknown(err error) bool {
	return errors.Is(err, errUnknown{}) || isInterface[unknown](err)
}
```

1 つの種別につき 4 つの要素がある。

1. **空の構造体** — 値として比較可能
2. **マーカーメソッド** (`Unknown()`) — インターフェースを満たすため
3. **マーカーインターフェース** — 他のライブラリの型を受け入れるため
4. **判定関数** — 2 通りの方法で判定

コメントの `// unknown maps to Moby's "ErrUnknown"` が、**Docker のエラー型との対応** を示している。containerd と Moby は同じマーカーインターフェースの規約を共有していて、エラーが両者の間を通れる。

空の構造体を使うのは、`errors.Is` での比較が値の比較になるからだ。ポインタだと同一性の判定になってしまう。

### キャンセルの扱い

```go title="vendor/github.com/containerd/errdefs/errors.go"
// IsCanceled returns true if the error is due to `context.Canceled`.
func IsCanceled(err error) bool {
	return errors.Is(err, context.Canceled) || isInterface[cancelled](err)
}
```

キャンセルだけは **標準ライブラリの `context.Canceled`** も見る。独自の型を作らず、既存のものを取り込んでいる。

### 種別の解決

[`vendor/github.com/containerd/errdefs/resolve.go#L34-L62`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/vendor/github.com/containerd/errdefs/resolve.go#L34-L62)。

```go title="vendor/github.com/containerd/errdefs/resolve.go"
func Resolve(err error) error {
	if err == nil {
		return nil
	}
	err = firstError(err)
	if err == nil {
		err = ErrUnknown
	}
	return err
}

func firstError(err error) error {
	for {
		switch err {
		case ErrUnknown,
			ErrInvalidArgument,
			ErrNotFound,
			...
```

ラップされたエラーを順に剥がして、**最初に見つかった種別** を返す。見つからなければ `ErrUnknown`。

「最初に見つかった」= 最も外側の種別が優先される。`fmt.Errorf("%w: %w", ErrNotFound, someOtherErr)` のように 2 つの種別が混ざった場合、外側が勝つ。

### gRPC への変換

[`vendor/github.com/containerd/errdefs/pkg/errgrpc/grpc.go#L63-L110`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/vendor/github.com/containerd/errdefs/pkg/errgrpc/grpc.go#L63-L110)。

```go title="vendor/github.com/containerd/errdefs/pkg/errgrpc/grpc.go"
func ToGRPC(err error) error {
	if err == nil {
		return nil
	}

	if _, ok := status.FromError(err); ok {
		// error has already been mapped to grpc
		return err
	}
	st := statusFromError(err)
	if st != nil {
		if details := errorDetails(err, false); len(details) > 0 {
			if ds, _ := st.WithDetails(details...); ds != nil {
				st = ds
			}
		}
		err = st.Err()
	}
	return err
}
```

**既に gRPC のエラーなら二重変換しない**。層をまたいで複数回呼ばれても壊れない。

`errorDetails` で追加情報を `Status.Details` に載せる。エラーの原因となったリソース ID などが構造化されて運ばれる。

対応表。

```go title="vendor/github.com/containerd/errdefs/pkg/errgrpc/grpc.go"
	switch errdefs.Resolve(err) {
	case errdefs.ErrInvalidArgument:
		return status.New(codes.InvalidArgument, err.Error())
	case errdefs.ErrNotFound:
		return status.New(codes.NotFound, err.Error())
	case errdefs.ErrAlreadyExists:
		return status.New(codes.AlreadyExists, err.Error())
	...
	case errdefs.ErrFailedPrecondition, errdefs.ErrConflict, errdefs.ErrNotModified:
		return status.New(codes.FailedPrecondition, err.Error())
```

`ErrFailedPrecondition` / `ErrConflict` / `ErrNotModified` の **3 つが同じ gRPC コードに潰れる**。gRPC のコードは 16 種類しかないので、往復すると情報が失われる。

これが [shim の後始末](../shim-delete/) で「エラーではなくコンテキストの期限を見る」理由の一部になっている。往復で意味が変わるエラーに依存しない。

### gRPC からの復元

```go title="vendor/github.com/containerd/errdefs/pkg/errgrpc/grpc.go"
func ToNative(err error) error {
	...
	s, isGRPC := status.FromError(err)

	var (
		desc string
		code codes.Code
	)

	if isGRPC {
		desc = s.Message()
		code = s.Code()
	} else {
		desc = err.Error()
		code = codes.Unknown
	}

	var cls error // divide these into error classes, becomes the cause

	switch code {
	case codes.InvalidArgument:
		cls = errdefs.ErrInvalidArgument
```

gRPC のエラーでなければ `Unknown` として扱う。**変換が失敗しない** ように作られている。

`cls` が「原因」となり、元のメッセージと組み合わせて新しいエラーになる。だから `errors.Is(err, errdefs.ErrNotFound)` が、RPC を経由した後でも成立する。

## なぜそうなっているか

### エラーの分類は「呼び出し側の行動」で決まる

「クライアントに特定の行動を取らせたいときに使う」という doc の一文が、分類の基準を示している。

- `ErrNotFound` → 作成を試みる、あるいは諦める
- `ErrAlreadyExists` → **スキップする**
- `ErrFailedPrecondition` → 前提を整えてから再試行する
- `ErrUnavailable` → 時間をおいて再試行する

**実装の詳細ではなく、受け取った側の対応で分ける**。だから種別が 16 個に収まる。

### プロセス境界を越えても意味を保つ

containerd では、同じ処理が in-process でも gRPC 経由でも呼ばれる ([アーキテクチャを一枚で読む](../architecture/))。エラーの扱いが経路によって変わると、CRI プラグインと外部クライアントで挙動が違うことになる。

`ToGRPC` / `ToNative` で往復させることで、**どちらの経路でも `errdefs.IsNotFound(err)` が同じ結果を返す**。

これがないと、[remote snapshotter](../remote-snapshotter/) の `ErrAlreadyExists` プロトコルが proxy plugin 経由で動かない。

### インターフェースによる判定を併用する

`errors.Is` だけなら実装は単純だが、**別のライブラリのエラーを受け入れられない**。

Moby、containerd、その他のプロジェクトが同じマーカーインターフェース (`NotFound()`, `InvalidParameter()`) を実装することで、エラーがプロジェクトをまたいで意味を保つ。

Go の標準ライブラリには `errors.Is` / `errors.As` しかないので、この種の「意味の共有」は各プロジェクトが規約を作る必要がある。containerd と Moby は同じ規約を選んだ。

### 情報が失われることを受け入れる

gRPC のコードは 16 個で、errdefs も 16 個だが、**1 対 1 ではない**。3 つが `FailedPrecondition` に潰れる。

これは gRPC のコード体系に合わせた結果で、独自のコードを使えば避けられる。しかし標準のコードを使うことで、gRPC の標準的なツール (リトライポリシー、ロードバランサ、モニタリング) がそのまま効く。

**標準への準拠と情報量のトレードオフ** で、準拠を選んでいる。

## どう活かすか

### エラーの種別で分岐する

containerd のクライアントを書くとき。

```go
if _, err := client.GetImage(ctx, ref); err != nil {
	if errdefs.IsNotFound(err) {
		// pull する
	} else {
		return err
	}
}
```

文字列マッチではなく、種別で判定する。RPC を経由していても正しく判定される。

### 独自のエラーを定義するとき

containerd の拡張 (proxy plugin など) を書く場合、errdefs の型を返すようにすると containerd 側の判定が効く。

```go
return fmt.Errorf("snapshot %s: %w", key, errdefs.ErrNotFound)
```

`fmt.Errorf` の `%w` でラップすれば、メッセージを足しつつ種別が保たれる。

### 「エラー種別を型で持つ」パターン

自分のシステムで同じことをするときの要点。

- **分類の基準を「呼び出し側の行動」にする** — 実装の詳細で分けない
- **空の構造体 + マーカーインターフェースの 2 本立てにする** — 他のライブラリと相互運用できる
- **境界を越える変換を用意する** — 往復して意味が保たれること
- **変換は冪等にする** — 何度呼ばれても壊れない
- **標準のコード体系に寄せる** — 情報が減っても、ツールの恩恵が大きい

3 番目と 4 番目はセットだ。`ToGRPC` が「既に変換済みなら何もしない」を実装しているおかげで、層のどこで呼んでも安全になる。変換を挟む場所を厳密に管理する必要がなくなる。
