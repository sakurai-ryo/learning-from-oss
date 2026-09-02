---
title: "compatibility-version と cachedigest — 出力の互換とキャッシュミスの追跡"
description: "同じ Dockerfile から同じ digest のイメージを何年も出し続けるための compatibility-version と、キャッシュキーの計算過程を bbolt に残して「なぜミスしたか」を後から追える cachedigest。運用で困る 2 つのこと — 出力が勝手に変わる、キャッシュが理由不明で外れる — に対する BuildKit の答えを並べて読む。"
group: "運用・互換・観測"
sidebar:
  order: 82
---

## 何を学んだか

BuildKit を運用していて刺さる問題が 2 つある。

1. **バージョンを上げたら出力イメージの digest が変わった。** 中身は同じはずなのに、レジストリ上は別のイメージになる。
2. **キャッシュが外れたが理由が分からない。** キーはハッシュなので、比較しても「違う」以上のことが言えない。

BuildKit の答えは対照的だ。1 つ目は `compatibility-version` — ビルド全体に「どの世代の出力挙動で動くか」を宣言させ、古い挙動を意図的に保存する。2 つ目は `util/cachedigest` — **ハッシュに何を食わせたかを全部記録する**専用のデータベースを持ち、digest から平文を逆引きできるようにする。

どちらも「ハッシュは中身を隠すが、運用は中身を知りたがる」という同じ緊張への対処になっている。

## compatibility-version — 出力挙動を世代で固定する

宣言は整数 1 個だ。

```go title="solver/llbsolver/compat/compat.go"
const (
	CompatibilityVersion013     = 10
	CompatibilityVersion015     = 20
	CompatibilityVersion031     = 30
	CompatibilityVersionCurrent = CompatibilityVersion031
)

// JobValueKey is the key used to store the compatibility version on a solver
// job via Job.SetValue/EachValue.
const JobValueKey = "llb.compatibilityversion"

var supportedCompatibilityVersions = []int{
	CompatibilityVersion013,
	CompatibilityVersion015,
	CompatibilityVersion031,
}
```

([solver/llbsolver/compat/compat.go L9-L24](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/compat/compat.go#L9-L24))

値は BuildKit のリリースバージョンではなく 10 刻みの独立した番号で、`013` / `015` / `031` という名前が「その挙動が使われていた最初のリリース」を示す。間に番号を差し込む余地が残されている。

未知の値は素通ししない。上限より大きければ「BuildKit を上げろ」、それ以外は「サポートされている値の一覧」を返す。

```go title="solver/llbsolver/compat/compat.go"
func ValidateCompatibilityVersion(version int) error {
	if slices.Contains(supportedCompatibilityVersions, version) {
		return nil
	}
	if version > CompatibilityVersionCurrent {
		return errors.Errorf("unsupported compatibility-version %d: upgrade buildkit (max supported: %d)", version, CompatibilityVersionCurrent)
	}
	return errors.Errorf("unsupported compatibility-version %d (supported: %v)", version, supportedCompatibilityVersions)
}
```

([solver/llbsolver/compat/compat.go L30-L38](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/compat/compat.go#L30-L38))

検証は `Control.Solve` の入口で、`0` (未指定) を現行値に読み替えてから行う。

```go title="control/control.go"
	compatibilityVersion := int(req.CompatibilityVersion)
	if compatibilityVersion == 0 {
		compatibilityVersion = compat.CompatibilityVersionCurrent
	}
	if err := compat.ValidateCompatibilityVersion(compatibilityVersion); err != nil {
		return nil, err
	}
```

([control/control.go L420-L426](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/control/control.go#L420-L426))

そのあとジョブの値として置かれる。引数として持ち回るのではなく、[ジョブの値](../job-state-edge/)にしているのが要点だ。

```go title="solver/llbsolver/solver.go"
	if compatibilityVersion == 0 {
		compatibilityVersion = compat.CompatibilityVersionCurrent
	}
	j.SetValue(compat.JobValueKey, compatibilityVersion)
```

([solver/llbsolver/solver.go L261-L264](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/solver.go#L261-L264))

ジョブの値にしたことで、[ジョブが共有された](../job-sharing/)ときの扱いを明示的に書く必要が出てくる。`state.CompatibilityVersion` は、その頂点を要求している全ジョブを見て、食い違いがあればエラーにする。

```go title="solver/jobs.go"
		if version != v {
			return 0, errors.Errorf("conflicting compatibility versions in shared solve state: %d != %d", version, v)
		}
```

([solver/jobs.go L113-L115](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/jobs.go#L113-L115))

同じ頂点を共有する 2 つのビルドが別々の出力世代を要求したら、どちらかが間違った出力を得る。だから黙って片方に寄せるのではなく失敗させる。

### 何が固定されるか

`compatibility-version` が影響するのは**出力の組み立てとソースの取り込み**であって、実行そのものではない。実装は 3 か所しかない。

**1. イメージのメディアタイプの既定値** ([exporter/containerimage/export.go L586-L597](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/export.go#L586-L597))。

```go title="exporter/containerimage/export.go"
// DefaultOCITypes returns the default media type behavior for image exports.
func DefaultOCITypes(compatibilityVersion int, src *exporter.Source) bool {
	if compatibilityVersion >= compat.CompatibilityVersion031 {
		return true
	}
	return len(src.Attestations) > 0
}
```

`30` 以降は OCI メディアタイプが既定。`20` では attestation がある場合のみ OCI で、なければ Docker のメディアタイプになる。manifest のメディアタイプは manifest 自体の digest に含まれるので、これが変わればイメージの digest が変わる。

**2. git チェックアウトのファイルモード** ([source/git/source.go L1339-L1343](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/git/source.go#L1339-L1343))。`10` を指定すると、チェックアウト後に非実行ファイルのモードを昔の形に戻す関数が走る。コメントが「なぜ実行ファイルは触らないか」まで書いている。

```go title="source/git/source.go"
// resetCompatibility014FileModes restores the pre-v0.15 git checkout file
// mode for non-executable regular files, which were stored with group/other
// write bits set before the exec-option propagation fix. Executable files are
// left untouched: their pre-v0.15 behavior is not covered by the current
// compatibility matrix, and blindly adding write bits to 0o755 would be a
// guess.
func resetCompatibility014FileModes(root *os.Root) error {
```

([source/git/source.go L1435-L1441](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/source/git/source.go#L1435-L1441))

ファイルモードは tar のヘッダに入り、レイヤの digest を変える。git ソースの取り込み方が変われば下流のレイヤが全部変わる。

**3. 再現できない組み合わせは拒否する。** `10` と zstd 圧縮の組み合わせは、正しく再現できないので通さない。

```go title="exporter/containerimage/writer.go"
	if compatibilityVersion == compat.CompatibilityVersion013 && opts.RefCfg.Compression.Type == compression.Zstd {
		feature := fmt.Sprintf("%s exporter compression=%s", exporterType, opts.RefCfg.Compression.Type.String())
		return nil, solvererrdefs.NewUnsupportedCompatibilityFeatureError(compatibilityVersion, feature)
	}
```

([exporter/containerimage/writer.go L75-L79](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/exporter/containerimage/writer.go#L75-L79))

理由はドキュメントに書かれている。当時の zstd バイト列は vendor した圧縮ライブラリのバージョンにも依存していて、そこまでは再現の対象に含めていない。

> Because the currently supported historical backfill for `10` only covers the git-backed artifact difference, BuildKit currently rejects `compression=zstd` with `compatibility-version=10` instead of claiming full reproduction of the old zstd output.

([docs/build-repro.md](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/docs/build-repro.md))

「できないことをできると言わない」を、実行時エラーとして表明している。しかもそのエラーは専用の typed error になっていて、バージョンと機能名を構造化して運ぶ ([エラーを gRPC 越しに運ぶ](../grpc-errors/))。

```go title="solver/errdefs/compatibility.go"
func (e *UnsupportedCompatibilityFeatureError) Error() string {
	msg := fmt.Sprintf("unsupported compatibility-version %d feature %s", e.Version, e.Feature)
	if e.error != nil {
		msg += ": " + e.error.Error()
	}
	return msg
}
```

([solver/errdefs/compatibility.go L19-L25](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/errdefs/compatibility.go#L19-L25))

最後に、使った値は provenance に記録される ([provenance](../provenance/))。あとから「このイメージはどの世代の挙動で作られたか」を追える。

```go title="solver/llbsolver/provenance.go"
	pr.BuildDefinition.ExternalParameters.Request.CompatibilityVersion = compatibilityVersion
```

([solver/llbsolver/provenance.go L671](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/llbsolver/provenance.go#L671))

指定は `client.SolveOpt.CompatibilityVersion` から行う ([client/solve.go L42](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/client/solve.go#L42))。`buildctl build` にはこれに対応するフラグがなく、Go の API か制御 API を直接使う経路だけが用意されている。

## cachedigest — ハッシュに食わせたものを全部残す

もう 1 つの問題に移る。キャッシュキーは digest なので、`sha256:abc...` と `sha256:def...` を見比べても何も分からない。`util/cachedigest` はここを開く。

普通の `hash.Hash` の薄いラッパで、書き込みのたびに**書き込んだバイト列そのもの**をフレームとして保持する。

```go title="util/cachedigest/digest.go"
type Hash struct {
	h      hash.Hash
	typ    Type
	db     *DB
	frames []Frame
}

// ...

func (h *Hash) Write(p []byte) (n int, err error) {
	n, err = h.h.Write(p)
	if n > 0 && h.db != nil {
		h.frames = append(h.frames, Frame{ID: FrameIDData, Data: bytes.Clone(p[:n])})
	}
	return n, err
}
```

([util/cachedigest/digest.go L37-L63](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/cachedigest/digest.go#L37-L63))

`Sum` を呼んだ時点で、先頭に型フレームを足して bbolt に `digest → フレーム列` として保存する。

```go title="util/cachedigest/digest.go"
func (h *Hash) Sum() digest.Digest {
	sum := digest.NewDigest(digest.SHA256, h.h)
	if h.db != nil && len(h.frames) > 0 {
		frames := []Frame{
			{ID: FrameIDType, Data: []byte(string(h.typ))},
		}
		frames = append(frames, h.frames...)
		h.db.saveFrames(sum.String(), frames)
	}
	return sum
}
```

([util/cachedigest/digest.go L81-L91](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/cachedigest/digest.go#L81-L91))

型は 6 つあり、あとで平文をどう解釈するかを決める。

```go title="util/cachedigest/digest.go"
const (
	TypeJSON       Type = "json"
	TypeString     Type = "string"
	TypeStringList Type = "string-list"
	TypeDigestList Type = "digest-list"
	TypeFileList   Type = "file-list"
	TypeFile       Type = "file"
)
```

([util/cachedigest/digest.go L16-L23](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/cachedigest/digest.go#L16-L23))

利用側は既存のハッシュ計算を置き換えるだけでよい。[contenthash](../contenthash-radix-tree/) のファイルリストは `TypeFileList`、[イメージ config](../image-source/) や [ローカルソース](../local-source/) のキーは `TypeJSON`、[キャッシュキーの root](../cachekey-composition/) は `TypeString` になる。

```go title="solver/cachemanager.go"
func rootKey(dgst digest.Digest, output Index) digest.Digest {
	out, _ := cachedigest.FromBytes(fmt.Appendf(nil, "%s@%d", dgst, output), cachedigest.TypeString)
```

([solver/cachemanager.go L451-L452](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachemanager.go#L451-L452))

### 記録してはいけないものがある

ファイルのハッシュは中身を全部食わせる。それをそのまま記録したらデバッグ DB がビルドコンテキストのコピーになるし、secret がディスクに落ちる。そこで**サイズだけ記録して中身は捨てる**書き込みが用意されている。

```go title="util/cachedigest/digest.go"
func (h *Hash) WriteNoDebug(p []byte) (n int, err error) {
	n, err = h.h.Write(p)
	if n > 0 && h.db != nil {
		if len(h.frames) > 0 && h.frames[len(h.frames)-1].ID == FrameIDSkip {
			last := &h.frames[len(h.frames)-1]
			prevLen := binary.LittleEndian.Uint32(last.Data)
			binary.LittleEndian.PutUint32(last.Data, prevLen+uint32(n))
		} else {
			lenBytes := make([]byte, 4)
			binary.LittleEndian.PutUint32(lenBytes, uint32(n))
			h.frames = append(h.frames, Frame{ID: FrameIDSkip, Data: lenBytes})
		}
	}
	return n, err
}
```

([util/cachedigest/digest.go L65-L79](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/cachedigest/digest.go#L65-L79))

連続する skip は 1 個のフレームに畳まれるので、100MB のファイルでもフレームは 4 バイトで済む。

使い分けは [contenthash のファイルハッシュ](../contenthash-tar-digest/)にある。tar ヘッダ側は `Write` (記録する)、ファイル本体は `WriteNoDebug` (記録しない)。

```go title="cache/contenthash/filehash.go"
func (tsh *tarsumHash) Write(p []byte) (n int, err error) {
	n, err = tsh.WriteNoDebug(p)
	if n > 0 {
		tsh.hdr.Size += int64(n)
	}
	return n, err
}
```

([cache/contenthash/filehash.go L84-L90](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/contenthash/filehash.go#L84-L90))

キャッシュミスの原因の大半は「パーミッションが変わった」「サイズが変わった」であって、中身のどのバイトが変わったかではない。ヘッダだけ残せば実用上は足りる、という割り切りになっている。

### digest から digest へ辿る

記録された平文には、また別の digest が入っていることが多い。ファイルリストのエントリは各ファイルの digest だし、`TypeString` の平文にも digest が埋まっている。`LoadSubRecords` はそれを型ごとの規則で拾い出し、再帰的にレコードを解決する。

```go title="util/cachedigest/digest.go"
	switch r.Type {
	case TypeString:
		// find regex matches in the data
		matches := shaRegexpOnce().FindAllSubmatch(dt, -1)
		// ...
	case TypeDigestList:
		for dgst := range bytes.SplitSeq(dt, []byte{0}) {
			checksums = append(checksums, string(dgst))
		}
	// TypeFileList は "名前\0sha256:..." の並びから digest を拾う
	}
```

([util/cachedigest/digest.go L114-L136](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/cachedigest/digest.go#L114-L136))

`TypeString` を正規表現で走査しているのが乱暴に見えるが、目的がデバッグ表示である以上、誤検出しても「解決できないレコード」として警告が出るだけで済む。これで、キャッシュキー 1 個から下へ展開していくと「どのファイルのどのハッシュが違ったか」まで降りられる。

### 既定では何も記録しない

`defaultDB` は中身が空の `DB` で、`db.db == nil` なら `saveFrames` は即 return する。記録は明示的に有効化したときだけ動く。

([util/cachedigest/db.go L68-L87](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/cachedigest/db.go#L68-L87))

有効化は buildkitd の `--save-cache-debug` フラグで、`<root>/cache-debug.db` が作られる。

```go title="cmd/buildkitd/main.go"
		if c.Bool("save-cache-debug") {
			db, err := cachedigest.NewDB(filepath.Join(cfg.Root, "cache-debug.db"))
			if err != nil {
				return errors.Wrap(err, "failed to create cache debug db")
			}
			cachedigest.SetDefaultDB(db)
			defer db.Close()
		}
```

([cmd/buildkitd/main.go L406-L413](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cmd/buildkitd/main.go#L406-L413))

書き込みは `WaitGroup.Go` で非同期に投げられ、`Close` が待つ。ハッシュ計算のホットパスに bbolt のトランザクションを挟まないための形だ。

### 読み出しは buildctl ではなく debug HTTP から

参照は `buildctl debug` ではなく、`buildkitd --debugaddr` で開く HTTP エンドポイントにある。

```go title="cmd/buildkitd/debug.go"
	m.Handle("/debug/cache/all", http.HandlerFunc(handleCacheAll))
	m.Handle("/debug/cache/lookup", http.HandlerFunc(handleCacheLookup))
	m.Handle("/debug/cache/store", http.HandlerFunc(handleDebugCacheStore))
	m.Handle("POST /debug/cache/load", http.HandlerFunc(handleCacheLoad))
```

([cmd/buildkitd/debug.go L43-L46](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cmd/buildkitd/debug.go#L43-L46))

`/debug/cache/lookup?digest=sha256:...` が 1 個の digest を平文に開き、サブレコードを字下げして印字する。skip フレームは中身がないので `skipping N bytes` とだけ出る ([cmd/buildkitd/debug.go L141-L148](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cmd/buildkitd/debug.go#L141-L148))。

より実用的なのが `/debug/cache/store` で、[bbolt のキャッシュリンクグラフ](../bbolt-cache-links/)を全部列挙したうえで、各レコードの digest・親リンクの digest・selector を **cachedigest DB で平文に開いて**添える ([cmd/buildkitd/debug.go L354-L392](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cmd/buildkitd/debug.go#L354-L392))。出力はキャッシュレコードの ID・digest・親と子のリンク、そして `Plaintexts:` として展開された平文になる。キャッシュ探索がグラフ探索である以上 ([キャッシュ検索はハッシュ計算ではなくグラフ探索である](../cache-query-graph/))、「どこでリンクが切れたか」を見るにはグラフと平文を並べて見る必要がある。

さらに `POST /debug/cache/load` は、[リモートキャッシュ](../cache-chains/)のマニフェスト JSON を投げると、それをその場でキャッシュキーストレージに展開して同じ形式で表示する。手元のデーモンにインポートすることなく、CI が吐いたキャッシュの中身を検分できる。

## なぜそうなっているか

`compatibility-version` は、[再現ビルド](../reproducible-build/)の要求から出てきている。`SOURCE_DATE_EPOCH` でタイムスタンプを固定しても、BuildKit 自身の出力組み立てが変われば digest は変わる。「入力を固定すれば出力が固定される」を成り立たせるには、BuildKit のバージョンも入力に含めるか、出力挙動を明示的に選べるようにするしかない。後者を選んだ結果がこれだ。

そのうえで、対象を出力の組み立てとソースの取り込みに限っているのが賢い。実行そのもの (runc の呼び方、mount の張り方) まで世代管理しようとすれば、コードが分岐で埋まって保守できなくなる。digest に効く境界だけを列挙し、それ以外は「新しい挙動のみ」と割り切っている。実装が 3 か所で済んでいるのはその結果だ。

`cachedigest` の方は、「ハッシュを取る」という操作に**デバッグのための出力**を足した形になっている。既存の呼び出しは `hash.Hash` のインターフェースをそのまま満たすので、置き換えは import の変更で済む。記録を既定で無効にし、`db == nil` の分岐 1 個だけをホットパスに残しているのは、この置き換えを全面的にやるための条件だった。

`WriteNoDebug` が別メソッドとして切られているのも同じ設計判断の一部だ。「記録するかどうか」をグローバル設定ではなく呼び出し側に持たせたので、secret とファイル本体だけを外し、それ以外は全部記録するという細かい線引きができる。

## どう活かすか

- **出力の互換は、バージョン番号ではなく「世代」という独立した軸で表現する。** ソフトウェアのバージョンと出力挙動のバージョンを分けると、機能追加とバグ修正を出力を変えずに配れる。番号を 10 刻みにして間を空けておくのも、あとから世代を差し込むための素直な工夫だ。
- **再現できないものは再現できると言わない。** 古い挙動を全部は戻せないなら、その組み合わせを実行時に拒否する。「たぶん同じ」で通すと、digest が違う理由を延々調べることになる。
- **共有されるリソースに世代を持たせたら、食い違いをエラーにする。** BuildKit は同じ頂点を複数ジョブで共有するので、世代が食い違えば片方が誤った出力を得る。黙って片方に寄せる実装は再現性を静かに壊す。
- **ハッシュ計算にデバッグ用の記録経路を作る。** ハッシュは意図的に情報を捨てる操作なので、捨てる前の情報をどこかに残さないと「なぜ違うのか」に永久に答えられない。既定でオフ、有効化はデーモンのフラグ 1 個、書き込みは非同期 — この 3 つが揃えば本番でも有効にできる。
- **記録から外すものを呼び出し側が選べるようにする。** ファイル本体や secret を記録すればデバッグ DB 自体が事故になる。「サイズだけ記録する」という中間の選択肢を用意しておくと、フレーム列の構造を壊さずに中身だけ落とせる。
