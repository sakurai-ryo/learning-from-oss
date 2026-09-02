---
title: "フロントエンドは LABEL で自己申告する — ネットワーク遮断はオプトイン"
description: "任意のイメージをビルドの一部として実行してしまう gateway フロントエンドが、どこまで自分を縛っているかを読む。ネットワークの遮断はイメージの LABEL による自己申告で、対応機能の宣言も LABEL の文字列 1 本。宣言を破っても罰は無いが、宣言しない機能は使わせてもらえない。"
group: "フロントエンドという拡張点"
sidebar:
  order: 29
---

## 何を学んだか

gateway フロントエンドは「ユーザが指定した任意のイメージを、ビルドの一部として実行する」機構だ。当然ながら、そのイメージが何をするかはデーモンには分からない。BuildKit がここに置いた仕組みは 2 つある。

- **`LABEL moby.buildkit.frontend.network.none="true"` を書いたイメージは、ネットワーク名前空間なしで起動される。** 公式の Dockerfile フロントエンドはこれを宣言している。裏を返すと、**宣言しないイメージは通常のサンドボックスネットワークを持つ** — これはオプトインであって、デフォルト遮断ではない。
- **`LABEL moby.buildkit.frontend.caps="..."` に書かれた機能名の集合が、クライアントの要求と突き合わされる。** 足りなければコンテナを起動する前に `Unimplemented` で落ちる。

どちらも「イメージが自分について申告する」形をとっており、デーモンは申告を検証しない。信頼モデルは [スコープと信頼境界](../scope-and-trust/) と同じ線の上にある — **フロントエンドはユーザが明示的に選んだコードであり、ビルド中に走る他の `RUN` と同じ扱い**にする、という割り切りだ。

## ラベルを読むのは 12 行だけ

`gatewayFrontend.Solve` の中で、イメージ config のラベルを見ているのはここだけだ。

```go title="frontend/gateway/gateway.go"
	if v, ok := img.Config.Labels["moby.buildkit.frontend.network.none"]; ok {
		if ok, _ := strconv.ParseBool(v); ok {
			meta.NetMode = opspb.NetMode_NONE
		}
	}

	curCaps := getCaps(img.Config.Labels["moby.buildkit.frontend.caps"])
	addCapsForKnownFrontends(curCaps, mfstDigest)
	reqCaps := getCaps(opts["frontend.caps"])
	if len(inputs) > 0 {
		reqCaps["moby.buildkit.frontend.inputs"] = struct{}{}
	}

	for c := range reqCaps {
		if _, ok := curCaps[c]; !ok {
			return nil, stack.Enable(grpcerrors.WrapCode(errdefs.NewUnsupportedFrontendCapError(c), codes.Unimplemented))
		}
	}
```

([frontend/gateway/gateway.go L261-L278](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/gateway/gateway.go#L261-L278))

ラベル名を grep すると、リポジトリ全体でこの 2 つと、公式イメージの Dockerfile 側の宣言しか出てこない。`needs-*` のような追加のラベルは存在しない。

```dockerfile title="frontend/dockerfile/cmd/dockerfile-frontend/Dockerfile"
FROM scratch AS release
LABEL moby.buildkit.frontend.network.none="true"
LABEL moby.buildkit.frontend.caps="moby.buildkit.frontend.inputs,moby.buildkit.frontend.subrequests,moby.buildkit.frontend.contexts,moby.buildkit.frontend.gitquerystring,moby.buildkit.frontend.contexts.zstd"
COPY --from=build /dockerfile-frontend /bin/dockerfile-frontend
ENTRYPOINT ["/bin/dockerfile-frontend"]
```

([frontend/dockerfile/cmd/dockerfile-frontend/Dockerfile L73-L77](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/cmd/dockerfile-frontend/Dockerfile#L73-L77))

`FROM scratch` で、中身は静的リンクされたバイナリ 1 個。ネットワーク不要を宣言し、対応 caps を 5 つ並べる。この 5 つは、プロセス内で動くビルトイン版がハードコードで持っているリスト ([frontend/dockerfile/builder/caps.go L12-L18](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/builder/caps.go#L12-L18)) と完全に一致する。**同じコードの 2 つの配置形態が、それぞれ違う場所に同じ宣言を持っている**わけで、ここは手で同期させる前提になっている。

## ネットワークの既定値は「無し」ではない

`meta.NetMode` にセットされる `opspb.NetMode` の定義を見ると、ゼロ値は `NONE` ではない。

```proto title="solver/pb/ops.proto"
enum NetMode {
	UNSET = 0; // sandbox
	HOST = 1;
	NONE = 2;
}
```

([solver/pb/ops.proto L82-L86](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/pb/ops.proto#L82-L86))

`executor.Meta` は `meta.NetMode` を明示的に立てない限り `UNSET` = サンドボックスネットワークになる。つまり **ラベルを書かないフロントエンドイメージは、`RUN` と同じネットワークを持って動く**。パッケージを取りに行く必要のあるフロントエンドや、外部の設定サーバを引きたいフロントエンドはそれで動く。逆に、`docker/dockerfile` のように「Dockerfile をパースして LLB を返すだけ」のフロントエンドは、外に出る必要がないので自分で塞ぐ。

rootfs も同様に、書き込み可能なまま渡される。

```go title="frontend/gateway/gateway.go"
	var readonly bool // TODO: try to switch to read-only by default.
```

([frontend/gateway/gateway.go L122](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/gateway/gateway.go#L122))

`readonly` はどこからも代入されず、`executor.Meta.ReadonlyRootFS` に `false` として渡るだけ。TODO コメントが「読み取り専用をデフォルトにしたい」と言っているので、これは意図された緩さというより、既存フロントエンドを壊さないための現状維持だと読める。

## caps ラベルは `+` の前だけを見る

`getCaps` はカンマ区切りを分解するだけの関数だが、`+` の扱いに意味がある。

```go title="frontend/gateway/gateway.go"
func getCaps(label string) map[string]struct{} {
	if label == "" {
		return make(map[string]struct{})
	}
	caps := strings.Split(label, ",")
	out := make(map[string]struct{}, len(caps))
	for _, c := range caps {
		name := strings.SplitN(c, "+", 2)
		if name[0] != "" {
			out[name[0]] = struct{}{}
		}
	}
	return out
}
```

([frontend/gateway/gateway.go L1747-L1760](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/gateway/gateway.go#L1747-L1760))

クライアントは `frontend.caps` に `moby.buildkit.frontend.contexts+forward` のように書ける。`+forward` は「この機能を持たないフロントエンドに当たったら、即エラーにせず `#syntax=` の転送先に賭けてほしい」という修飾で、ビルトインの Dockerfile フロントエンドがそれを解釈する ([#syntax= はフロントエンドの再帰呼び出しである](../syntax-directive/))。gateway 側は修飾を落として名前だけで突き合わせる。

`inputs` だけは特別扱いされていて、`inputs` が実際に渡されているなら、クライアントが要求していなくても要求に加算される。フロントエンドが `Inputs` RPC を知らなければ入力が黙って捨てられてしまうので、それを事前に検出するためだ。

そして、caps 検出が実装される前にリリースされた 4 つのイメージのために、ダイジェスト直書きの救済がある。

```go title="frontend/gateway/gateway.go"
func addCapsForKnownFrontends(caps map[string]struct{}, dgst digest.Digest) {
	// these frontends were built without caps detection but do support inputs
	defaults := map[digest.Digest]struct{}{
		"sha256:9ac1c43a60e31dca741a6fe8314130a9cd4c4db0311fbbc636ff992ef60ae76d": {}, // docker/dockerfile:1.1.6
		"sha256:080bd74d8778f83e7b670de193362d8c593c8b14f5c8fb919d28ee8feda0d069": {}, // docker/dockerfile:1.1.7
		"sha256:60543a9d92b92af5088fb2938fb09b2072684af8384399e153e137fe081f8ab4": {}, // docker/dockerfile:1.1.6-experimental
		"sha256:de85b2f3a3e8a2f7fe48e8e84a65f6fdd5cd5183afa6412fff9caa6871649c44": {}, // docker/dockerfile:1.1.7-experimental
	}
	if _, ok := defaults[dgst]; ok {
		caps["moby.buildkit.frontend.inputs"] = struct{}{}
	}
}
```

([frontend/gateway/gateway.go L1847-L1858](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/gateway/gateway.go#L1847-L1858))

**フロントエンドがイメージとして不変に配布されている**ことの直接の帰結だ。一度レジストリに出たイメージのラベルは後から直せない。だから、既に世に出てしまったバージョンについては、デーモン側にダイジェストのテーブルを持って「このイメージは宣言していないが実は対応している」と読み替える。ダイジェストは `NamedContext` かイメージ解決の過程で捕まえてある (`CaptureDigest: &mfstDigest`)。

## ソースの許可リスト

ネットワークとは別に、デーモン運用者が「どのリポジトリのフロントエンドなら起動してよいか」を絞れる。

```go title="frontend/gateway/gateway.go"
func (gf *gatewayFrontend) checkSourceIsAllowed(source string) error {
	// Returns nil if the source is allowed.
	// Returns an error if the source is not allowed.
	if len(gf.allowedRepositories) == 0 {
		// No source restrictions in place
		return nil
	}
	// ...
	taglessSource := reference.TrimNamed(sourceRef).Name()

	if slices.Contains(gf.allowedRepositories, taglessSource) {
		// Allowed
		return nil
	}
	return errors.Errorf("'%s' is not an allowed gateway source", source)
}
```

([frontend/gateway/gateway.go L87-L107](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/gateway/gateway.go#L87-L107))

比較はタグとダイジェストを落としたリポジトリ名で行われる。設定は buildkitd の toml の `frontend."gateway.v0".allowedRepositories`。**既定は空で、つまり無制限**。共有 CI のように「誰でもジョブを投げられるが、任意のイメージをフロントエンドとして走らせたくはない」環境向けの、後付けのノブだ。

## なぜそうなっているか

ラベルによる自己申告は、**強制ではなく調整のための仕組み**として設計されている。`network.none` を宣言しなかったフロントエンドが罰せられることはないし、`caps` に嘘を書いたフロントエンドは実行時に壊れるだけだ。それでも意味があるのは、この 2 つが解いている問題が「悪意」ではなく「バージョンのずれ」だからだ。

- `caps` ラベルは、**新しいクライアントが古いフロントエンドイメージに当たったときのエラーを、まともなメッセージに変える**ためにある。宣言がなければ、フロントエンドは知らないオプションを黙って無視し、ユーザは「`--build-context` を指定したのに効かない」という理解不能な結果を得る。ラベルの突き合わせは、コンテナを起動する前に「そのフロントエンドは `contexts` を知らない」と言い切れるようにする。
- `network.none` ラベルは、**フロントエンドの作者が「自分はネットワーク不要だ」と表明できる**ようにする。表明したフロントエンドはネットワークを取り上げられ、ビルドの再現性が上がり、キャッシュの信頼性も上がる。強制すると、レジストリからテンプレートを取ってくるようなフロントエンドが書けなくなる。

セキュリティ境界をここに置いていないのは、置く必要がないからだ。フロントエンドイメージは Dockerfile の 1 行目にユーザ自身が書いたものであり、その Dockerfile の `RUN` は同じデーモン上で同じ権限で走る。フロントエンドだけを厳しくしても、隣の `RUN` が何でもできるなら意味がない。境界を引くべき場所についての議論は [スコープと信頼境界](../scope-and-trust/) にある。

## どう活かすか

- **プラグインの能力宣言は、実行前に読める場所に置く。** BuildKit はイメージの LABEL、つまり config blob に置いた。ダウンロードもコンテナ起動も要らず、マニフェスト解決の副産物として読める。「起動してから ping で聞く」より 1 往復速く、失敗メッセージも具体的になる。
- **不変な成果物として配布するものには、後から訂正するための逃げ道を用意しておく。** `addCapsForKnownFrontends` のダイジェスト直書きは美しくないが、レジストリに出た 4 つのイメージを直す方法は他にない。宣言メタデータを外部の成果物に埋める設計をするなら、消費側にオーバーライドテーブルを置く余地を最初から見込んでおく。
- **「デフォルトで安全」と「デフォルトで動く」のどちらを取ったかを、コードで確認する癖をつける。** `NetMode` のゼロ値が `UNSET`(サンドボックス) であることは列挙型の定義を見ないと分からず、ラベルの名前 (`network.none`) からは「デフォルト none」と読み違えやすい。列挙型のゼロ値がどちらの意味かは、その API の思想がいちばん出る場所だ。
