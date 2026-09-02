---
title: "再現ビルド — SOURCE_DATE_EPOCH とタイムスタンプの書き換え"
description: "SOURCE_DATE_EPOCH はビルド引数として入り、フロントエンドが解決して source.date.epoch というメタデータで結果に載せ、エクスポータが受け取る。config の created と history だけは常に丸められ、レイヤ tar の中の mtime は rewrite-timestamp=true のときだけ、既存 blob を読み直して別 blob に書き換える形で処理される。"
group: "結果を出す"
sidebar:
  order: 72
---

## 何を学んだか

`SOURCE_DATE_EPOCH` は BuildKit の中を 3 段で流れる。**ビルド引数**としてフロントエンドに入り、フロントエンドが数値に解決して **`source.date.epoch` というメタデータ**として結果に載せ、**エクスポータ**がそれを読んで出力を丸める。エクスポータオプションとして直接 `source-date-epoch=` を渡すこともでき、その場合はメタデータより優先される。

そしてエポックが効く範囲は、**既定では config の `created` と `history` のタイムスタンプだけ**だ。レイヤ tar の中の各エントリの mtime は既定では触られない。それを触るには `rewrite-timestamp=true` を明示する必要があり、その処理は「blob を作り直す」のではなく **「既にある blob を読み、tar ヘッダを書き換えながら別の blob に書き出す」** という後段の変換になっている。

## 経路 1 — build arg として入る

`buildctl` はクライアントホストの環境変数を自動でビルド引数に写す。

```go title="cmd/buildctl/build/util.go"
propagatableEnvs := []string{"SOURCE_DATE_EPOCH"}
for _, env := range propagatableEnvs {
	if v, ok := os.LookupEnv(env); ok {
		bklog.L.Debugf("Propagating %s from the client env to the build arg", env)
		m["build-arg:"+env] = v
	}
}
```

([cmd/buildctl/build/util.go L58-L70](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cmd/buildctl/build/util.go#L58-L70))

Dockerfile フロントエンド側は、他のビルド引数と同じように読んだうえで**特別扱い**する。

```go title="frontend/dockerfile/dockerfile2llb/convert.go"
var resolvedEpoch *time.Time
if sourceDateEpoch, ok := getBuildArgValue(opt.BuildArgs, globalArgs, "SOURCE_DATE_EPOCH"); ok {
	resolvedEpoch, err = resolveSourceDateEpochValue(ctx, sourceDateEpoch, opt, stages, globalArgs, shlex)
	if err != nil {
		return nil, err
	}
	globalArgs = setBuildArgValue(opt.BuildArgs, globalArgs, "SOURCE_DATE_EPOCH", formatSourceDateEpochValue(resolvedEpoch))
}
```

([frontend/dockerfile/dockerfile2llb/convert.go L304-L311](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/convert.go#L304-L311))

`getBuildArgValue` を通しているので、`ARG SOURCE_DATE_EPOCH=1704067200` と Dockerfile 側に既定値を書くこともできる。呼び出し側が渡さなければそちらが使われる。

値は数値とは限らない。`SOURCE_DATE_EPOCH=context` という特別な値があり、これはビルドコンテキストを解決して時刻を取ってくる。

```go title="frontend/dockerfile/dockerfile2llb/epoch.go"
func resolveSourceDateEpochState(ctx context.Context, value string, opt ConvertOpt, stages []instructions.Stage, globalArgs *llb.EnvList, shlex *shell.Lex) (*llb.State, sourceDateEpochStateOpt, error) {
```

([frontend/dockerfile/dockerfile2llb/epoch.go L60](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/epoch.go#L60))

`docs/build-repro.md` が挙動をまとめている。git コンテキストならコミット時刻、HTTP コンテキストなら `Last-Modified`（無ければアーカイブ内の最新エントリの mtime）、ローカルコンテキストなら無視して未設定のまま。ステージ名を指定して「`FROM scratch` + 単一のリモート `ADD` だけのステージ」から取ることもでき、ここは検証が厳しい。

```go title="frontend/dockerfile/dockerfile2llb/epoch.go"
return nil, errors.Errorf("SOURCE_DATE_EPOCH stage does not meet source-only requirements: unsupported %s instruction", cmd.Name())
```

([frontend/dockerfile/dockerfile2llb/epoch.go L141](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerfile/dockerfile2llb/epoch.go#L141))

**エポックが設定されると、git コンテキストの取り込み方まで変わる。**

```go title="frontend/dockerui/context.go"
var extraGitOpts []llb.GitOption
if opts[buildArgPrefix+"SOURCE_DATE_EPOCH"] != "" {
	extraGitOpts = append(extraGitOpts, llb.GitMTimeCommit())
}
```

([frontend/dockerui/context.go L90-L93](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerui/context.go#L90-L93))

`GitMTimeCommit` は「チェックアウトしたファイルの mtime をコミット時刻にする」オプション。git は mtime を保存しないので、そのままだとチェックアウトした瞬間の時刻が入り、レイヤ内容が毎回変わってしまう。エポック指定は「再現性を要求している」という意思表示なので、ここが自動で有効になる。

## 経路 2 — メタデータとして結果に載る

解決した値は、結果メタデータ `source.date.epoch` としてエクスポータに渡される。

```go title="exporter/exptypes/keys.go"
const (
	ExporterEpochKey = "source.date.epoch"
)
```

([exporter/exptypes/keys.go L3-L5](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/exptypes/keys.go#L3-L5))

```go title="frontend/dockerui/build.go"
if buildRes.Epoch != nil {
	res.AddMeta(fmt.Sprintf("%s/%s", commonexptypes.ExporterEpochKey, expPlat.ID), []byte(strconv.FormatInt(buildRes.Epoch.Unix(), 10)))
}
```

([frontend/dockerui/build.go L80-L82](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/frontend/dockerui/build.go#L80-L82))

プラットフォーム別のキー（`source.date.epoch/<platform ID>`）とプラットフォーム無しのキーの両方がありうる。エクスポータ側の `ParseSource` はプラットフォーム付きを先に見る（[exporter/util/epoch/parse.go L55-L74](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/util/epoch/parse.go#L55-L74)）。

エクスポータオプションとして直接指定された値は `ParseExporterAttrs` が拾い、こちらが優先される。`Commit` の中で「`opts.Epoch` が nil のときだけメタデータを見る」という順になっているためだ。

```go title="exporter/containerimage/writer.go"
if opts.Epoch == nil {
	if tm, err := epoch.ParseSource(inp, nil); err != nil {
		return nil, err
	} else if tm != nil {
		opts.Epoch = &epoch.Epoch{Value: tm}
	}
}
```

([exporter/containerimage/writer.go L105-L111](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/writer.go#L105-L111))

パースは `time.Unix(sde, 0).UTC()`。空文字は「値なし」として扱われ、エラーにならない。これは「エクスポータオプションで上書きして無効化する」ための逃げ道になっている（[exporter/util/epoch/parse_test.go L16-L18](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/util/epoch/parse_test.go#L16-L18)）。

## エポックが決まると何が書き換わるか

### config の `history` — 「丸める」であって「上書き」ではない

```go title="exporter/containerimage/writer.go"
if epoch != nil {
	var divergedFromBase bool
	for i, h := range history {
		if !divergedFromBase && baseImg != nil && i < len(baseImg.History) && reflect.DeepEqual(h, baseImg.History[i]) {
			// Retain the timestamp for the base image layers
			// https://github.com/moby/buildkit/issues/4614
			continue
		}
		divergedFromBase = true
		if h.Created == nil || h.Created.After(*epoch) {
			history[i].Created = epoch
		}
	}
}
```

([exporter/containerimage/writer.go L781-L794](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/writer.go#L781-L794))

2 つの安全装置がある。1 つは **clamp**（`h.Created.After(*epoch)` のときだけ書き換える）。エポックより古い時刻はそのまま残す。もう 1 つは **ベースイメージの history をそのまま残す**こと。ベースイメージの `FROM alpine` の行までエポックに丸めると、ベースイメージの config と食い違ってしまう。`baseImg.History[i]` と完全一致する間は素通しし、1 つでも違ったらそこから先は全部書き換える。

### config の `created`

```go title="exporter/containerimage/writer.go"
// if epoch is set then clamp creation time
if v, ok := m["created"]; ok && epoch != nil {
	var tm time.Time
	// ...
	if tm.After(*epoch) {
		// ...
		m["created"] = dt
	}
}
```

([exporter/containerimage/writer.go L802-L815](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/writer.go#L802-L815))

同じく clamp。history を先に丸めてから `created` を決めるので、`created` が明示されていない場合は「丸められた history の最後の時刻」が入る。

### index のアノテーション — image エクスポータでは付かない

`docs/build-repro.md` は「OCI Image Index の `org.opencontainers.image.created` アノテーション」をエポックの適用先に挙げているが、コードでこれを設定しているのは **`oci` / `docker` エクスポータだけ**だ。

```go title="exporter/oci/export.go"
if _, ok := desc.Annotations[ocispecs.AnnotationCreated]; !ok {
	tm := time.Now()
	if opts.Epoch != nil && opts.Epoch.Value != nil {
		tm = *opts.Epoch.Value
	}
	desc.Annotations[ocispecs.AnnotationCreated] = tm.UTC().Format(time.RFC3339)
}
```

([exporter/oci/export.go L179-L185](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/oci/export.go#L179-L185))

`exporter/containerimage/export.go` の `Export` に同じ処理は無い。tar / OCI レイアウトとして落とすときだけ「アーカイブの作成時刻」を descriptor に載せる形になっている。

### local / tar エクスポータのファイル mtime

こちらはレイヤではなくファイルツリーを直接送るので、fsutil のフィルタで mtime を差し替える。

```go title="exporter/local/fs.go"
filterOpt.Map = func(p string, st *fstypes.Stat) fsutil.MapResult {
	// ...
	if opt.Epoch != nil && opt.Epoch.Value != nil {
		// apply used-specified epoch time
		st.ModTime = opt.Epoch.Value.UnixNano()
	}
	return res
}
```

([exporter/local/fs.go L132-L143](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/local/fs.go#L132-L143))

こちらは clamp ではなく**無条件の上書き**。プラットフォーム分割で作るディレクトリや、書き足す attestation ファイルにも同じ時刻が入る。

### レイヤ tar の中身 — rewrite-timestamp のときだけ

image / oci エクスポータでレイヤの中の mtime を触るのは、`rewrite-timestamp=true` を指定したときだけだ。

```go title="exporter/containerimage/opts.go"
ForceInlineAttestations bool // force inline attestations to be attached
RewriteTimestamp        bool // rewrite timestamps in layers to match the epoch
```

([exporter/containerimage/opts.go L22-L23](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/opts.go#L22-L23))

## 書き換えはどこで起きるか — blob を作り直さない

処理は `exportLayers` の**あと**、`commitDistributionManifest` の**まえ**に挟まる。つまり blob は一度普通に作られ、そのうえで別の blob に変換される。

```go title="exporter/containerimage/writer.go"
remotes, err := ic.exportLayers(ctx, opts.RefCfg, session.NewGroup(sessionID), ref)
if err != nil {
	return nil, err
}
remote := &remotes[0]
if opts.RewriteTimestamp {
	remote, err = ic.rewriteRemoteWithEpoch(ctx, opts, remote, baseImg, expEpoch)
	if err != nil {
		return nil, err
	}
}
```

([exporter/containerimage/writer.go L160-L170](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/writer.go#L160-L170))

`rewriteRemoteWithEpoch` は各レイヤについて `rewriteImageLayerWithEpoch` を並列に呼び、返ってきた新しい descriptor で差し替える。ここにもベースイメージの保護が入っている。

```go title="exporter/containerimage/writer.go"
var immDiffID digest.Digest
if !divergedFromBase && baseImg != nil && i < len(baseImg.RootFS.DiffIDs) {
	immDiffID = baseImg.RootFS.DiffIDs[i]
	if immDiffID == diffID {
		bklog.G(ctx).WithField("blob", desc).Debugf("Not rewriting to apply epoch (immutable diffID %q)", diffID)
		continue
	}
	divergedFromBase = true
}
```

([exporter/containerimage/writer.go L461-L469](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/writer.go#L461-L469))

ベースイメージと diffID が一致するレイヤは書き換えない。書き換えるとベースイメージのレイヤを共有できなくなり、`docker pull` 時にレイヤの再ダウンロードが要る。

実際の変換は `util/converter` に入る。圧縮タイプの変換と同じ経路を使いまわしている。

```go title="exporter/containerimage/writer.go"
// rewriteImageLayerWithEpoch rewrites the file timestamps in the layer blob to match the epoch, and returns a new descriptor that points to
// the new blob.
//
// If no conversion is needed, this returns nil without error.
func rewriteImageLayerWithEpoch(...) (*ocispecs.Descriptor, error) {
	// ...
	converterFn, err := converter.NewWithRewriteTimestamp(ctx, cs, desc, comp, epoch, immDiffIDs)
```

([exporter/containerimage/writer.go L418-L437](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/writer.go#L418-L437))

converter は「展開 → tar ヘッダを書き換え → 再圧縮」を 1 パスのストリームでやる。

```go title="util/converter/converter.go"
func rewriteTimestampInTarHeader(epoch time.Time) tarconverter.HeaderConverter {
	return func(hdr *tar.Header) {
		if hdr.ModTime.After(epoch) {
			hdr.ModTime = epoch
		}
		if hdr.AccessTime.After(epoch) {
			hdr.AccessTime = epoch
		}
		if hdr.ChangeTime.After(epoch) {
			hdr.ChangeTime = epoch
		}
	}
}
```

([util/converter/converter.go L76-L88](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/converter/converter.go#L76-L88))

ここでも clamp。`mtime` だけでなく `atime` / `ctime` も丸める。

もう 1 つ、ここには digest の二重計算がある。書き換え**前**の diffID (`origDiffID`) と書き換え**後**の diffID の両方を、同じストリームから取る。

```go title="util/converter/converter.go"
rdr := decR
if c.rewriteTimestamp != nil {
	tcR := tarconverter.NewReader(io.TeeReader(decR, origDiffID.Hash()), rewriteTimestampInTarHeader(*c.rewriteTimestamp))
	defer tcR.Close()
	rdr = tcR
}
if _, err := io.Copy(zw, io.TeeReader(rdr, diffID.Hash())); err != nil {
	return nil, err
}
// ...
origDiffIDVal := origDiffID.Digest()
if _, ok := c.immDiffIDs[origDiffIDVal]; ok {
	bklog.G(ctx).WithField("blob", desc).Debugf("Not rewriting to apply epoch (immutable diffID %q, computed during conversion)", origDiffIDVal)
	return &desc, nil
}
```

([util/converter/converter.go L127-L146](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/converter/converter.go#L127-L146))

`origDiffID` は「descriptor の annotation に diffID が入っていなかった場合のベースイメージ判定」に使われる。annotation があれば呼び出し側で判定できるが、サードパーティの containerd クライアントが投入した blob には annotation が無いことがあるので、変換中に計算して事後判定する。

## エポックとキャッシュ — 何が再利用されるか

エポックを変えたときにレイヤが再利用されるかは、書き換えの有無で変わる。

**`rewrite-timestamp` 無し**: レイヤの内容にエポックはまったく影響しない。config の `created` と `history` だけが変わるので、レイヤ blob はすべて再利用される。ソルバのキャッシュも効く。エポックはエクスポータオプションであってビルドグラフの一部ではないからだ。

**`rewrite-timestamp` あり**: 書き換え後の blob に「どのエポックで書き換えたか」のラベルが刻まれ、これが再変換の要否判定になる。

```go title="util/converter/converter.go"
needs, err := comp.Type.NeedsConversion(ctx, cs, desc)
// ...
if !needs && rewriteTimestamp != nil {
	needs = desc.Annotations[labelRewrittenTimestamp] != fmt.Sprintf("%d", rewriteTimestamp.UTC().Unix())
}
if !needs {
	// No conversion. No need to return an error here.
	return nil, nil
}
```

([util/converter/converter.go L37-L47](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/converter/converter.go#L37-L47))。`labelRewrittenTimestamp` の値は `"buildkit/rewritten-timestamp"`（[util/converter/converter.go L192](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/converter/converter.go#L192)）。

つまり同じエポックで再ビルドすれば変換はスキップされ、エポックを変えると全レイヤが再変換される。ただし**再変換されるのは「圧縮 blob」だけ**で、ビルドそのもの（スナップショットの生成）はキャッシュヒットしたままだ。書き換えは blob レベルの後処理なので、上流の DAG には触れない。

## 制約 — unpack との衝突

```go title="exporter/containerimage/export.go"
if e.unpack {
	if opts.RewriteTimestamp {
		// e.unpackImage cannot be used because src ref does not point to the rewritten image
		// /
		// TODO: change e.unpackImage so that it takes Result[Remote] as parameter.
		// https://github.com/moby/buildkit/pull/4057#discussion_r1324106088
		return nil, nil, nil, errors.New("exporter option \"rewrite-timestamp\" conflicts with \"unpack\"")
	}
```

([exporter/containerimage/export.go L325-L332](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/export.go#L325-L332))

これが「blob を作り直すのではなく後段で変換する」設計の代償だ。書き換え後の blob は manifest からは参照されているが、元の `cache.ImmutableRef` はそれを知らない。`unpackImage` は ref 側から remote を取り直すので、書き換え前のレイヤを展開してしまう。整合しないので禁止にしてある。

## なぜそうなっているか

**なぜ clamp（上限で丸める）なのか。** 単純な代入だと、ベースイメージに含まれる「エポックより古い」ファイルの時刻まで未来に飛ばしてしまう。再現ビルドで欲しいのは「ビルドのたびに変わる時刻を消す」ことで、「すべての時刻を同一にする」ことではない。エポックより古い時刻はビルドの実行時刻に依存しないので、そのままで再現性がある。

**なぜベースイメージのレイヤと history を保護するのか。** レイヤ側は共有性のため。書き換えると digest が変わり、ベースイメージと同じレイヤなのに別物として扱われて pull が増える。history 側は [issue #4614](https://github.com/moby/buildkit/issues/4614) が理由としてコード内に書かれている。`docker history` で見たときにベースイメージの行だけ時刻が食い違うと、そのイメージがどのベースから来たのか追えなくなる。

**なぜ既定で `rewrite-timestamp` が有効でないのか。** ドキュメントには書かれていないが、コードから読める理由が 2 つある。1 つはコスト——全レイヤを展開・再圧縮するので、大きなイメージでは無視できない時間がかかる。もう 1 つは上の `unpack` との衝突のように、書き換え後の blob が ref から辿れないことによる制約が残っていること。既定を off にしておけば、必要な人だけがこの代償を払う。

**なぜ「blob を作り直す」ではなく「既存 blob を変換する」なのか。** レイヤの生成は [ExecOp](../exec-op/) の実行結果からスナップショット差分として作られるもので、ここに「ファイルの mtime をエポックにする」を差し込むと、キャッシュキーがエポックに依存することになる。エポックが変わるだけでビルド全体が再実行される。後段の変換なら、ビルドキャッシュはそのままで出力だけが変わる。

## どう活かすか

- **「再現性のためのパラメータ」は、計算のキャッシュキーに混ぜず出力の後処理に置く。** そうしないと、パラメータを変えるたびに全部が再計算になる。BuildKit はレイヤ tar の書き換えを blob 変換として後ろに置いたので、`SOURCE_DATE_EPOCH` を変えてもビルド自体はキャッシュヒットする。
- **正規化は「上書き」ではなく「上限で丸める」を検討する。** 上書きは情報を捨てるが、clamp は「ビルド時刻に依存する部分」だけを消して、もともと決定的だった値を残す。
- **後処理の結果には「何で処理したか」のラベルを刻む。** `buildkit/rewritten-timestamp` があるから、同じエポックでの再実行を丸ごとスキップできる。ラベルが無ければ「変換したかどうか」を判定できず、毎回やり直すか、状態を別の場所に持つ羽目になる。
- **「上流から引き継いだ部分」と「自分が作った部分」の境目を検出して、前者には触らない。** BuildKit はベースイメージの `RootFS.DiffIDs` / `History` と突き合わせ、一致する間は素通しし、1 つ違ったらそこから先は全部自分のものと見なす（`divergedFromBase`）。この「一度分岐したら戻らない」判定はレイヤの積み上げ構造にそのまま合っている。
- **設計上の代償は禁止として明示する。** `rewrite-timestamp` と `unpack` の衝突は、暗黙に壊れた出力を出すのではなくエラーにしてある。TODO と PR コメントへのリンクも残っているので、なぜ塞いだかが後から辿れる。
