---
title: "参照カウントをカウンタではなく集合で持つ"
description: "cacheRecord は参照数を int ではなく map[ref]struct{} で持つ。個々のハンドルが自分自身をキーにして出入りするので、二重 release が生存中の他の保持者を巻き添えにできず、残っている保持者の属性を release 時に問い合わせられる。trace ログにハンドルのポインタとスタックを載せる仕組みも、この形だから成り立つ。"
group: "キャッシュの実体 — ref とレイヤ"
sidebar:
  order: 52
---

## 何を学んだか

`cacheRecord` は「いま何人が掴んでいるか」を整数カウンタで持っていない。持っているのは、掴んでいるハンドルそのものの集合だ。

```go title="cache/refs.go"
type ref interface {
	shouldUpdateLastUsed() bool
}

type cacheRecord struct {
	// ...
	refs    map[ref]struct{}
	// ...
}
```

([cache/refs.go L82-L91](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/refs.go#L82-L91))

`ref` インターフェースはメソッド 1 個しかない。集合の要素として `immutableRef` と `mutableRef` の両方を入れられさえすればよく、そのうえで「残っている保持者に何かを尋ねる」ためだけに `shouldUpdateLastUsed()` が生えている。カウンタなら尋ねようがない。

## 出入りの仕方

取得は `cr.ref()` / `cr.mref()`。どちらも新しいハンドル構造体を作り、それ自身をキーにして集合へ入れる。

```go title="cache/refs.go"
// hold ref lock before calling
func (cr *cacheRecord) ref(triggerLastUsed bool, descHandlers DescHandlers, pg progress.Controller) *immutableRef {
	ref := &immutableRef{
		cacheRecord:     cr,
		triggerLastUsed: triggerLastUsed,
		descHandlers:    descHandlers,
		progress:        pg,
	}
	cr.refs[ref] = struct{}{}
	bklog.G(context.TODO()).WithFields(ref.traceLogFields()).Trace("acquired cache ref")
	return ref
}
```

([cache/refs.go L109-L122](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/refs.go#L109-L122))

返り値のポインタが、そのまま集合のキーである。`Clone()` は `sr.ref(false, ...)` を呼ぶだけ ([cache/refs.go L663-L668](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/refs.go#L663-L668))。同じ `cacheRecord` を指す別のハンドルが 1 個増える。

解放は自分をキーにして消す。

```go title="cache/refs.go"
func (sr *immutableRef) release(ctx context.Context) (rerr error) {
	defer func() {
		l := bklog.G(ctx).WithFields(sr.traceLogFields())
		if rerr != nil {
			l = l.WithError(rerr)
		}
		l.Trace("released cache ref")
	}()

	delete(sr.refs, sr)
	if sr.updateLastUsedNow() {
		sr.updateLastUsed()
		if sr.equalMutable != nil {
			sr.equalMutable.triggerLastUsed = true
		}
	}

	if len(sr.refs) == 0 {
		// ...
	}

	return nil
}
```

([cache/refs.go L1460-L1490](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/refs.go#L1460-L1490))

`delete(sr.refs, sr)` はキーが無ければ何もしない。ここが整数カウンタとの決定的な差になる。

## カウンタとの差 1 — 二重 release が他人を巻き添えにしない

`n--` で管理していた場合、同じハンドルに対して `Release` が 2 回呼ばれると、他に 2 人が掴んでいても n が 0 に達しうる。そこで下位の資源 (リース、スナップショット) を解放してしまえば、生きている保持者の足元が崩れる。use-after-free と同じ形の壊れ方で、しかも壊れるのは release を二重に呼んだ側ではなく無関係な誰かなので、追跡が難しい。

集合なら、`delete` の 2 回目は no-op だ。集合の要素数は常に「実際に生きているハンドルの数」に一致し、誤った release で下回ることがない。開放が遅れる方向 (集合に残ったまま呼び忘れる) には壊れるが、これはリーク、つまりディスクが減らないだけで済み、`len(cr.refs)` を見れば検出できる。

BuildKit はこの `len` を「使用中か」の判定として広く使っている。

- `get()` は可変レコードに対して `len(rec.refs) != 0` なら `ErrLocked` を返す ([cache/manager.go L381](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/manager.go#L381))
- `commit()` は `len(sr.refs) == 0` を `errInvalid` で弾く。誰も掴んでいない可変 ref を commit しようとするのはバグ ([cache/refs.go L1551](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/refs.go#L1551))
- `pruneOnce` は `len(cr.refs) == 0` のレコードだけを削除候補にする ([cache/manager.go L1148](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/manager.go#L1148))
- `DiskUsage` は `InUse: len(cr.refs) > 0` として報告する ([cache/manager.go L1265](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/manager.go#L1265))

いずれも「0 になったら解放」ではなく「0 かどうか」を問い合わせている。この読み方をする限り、値がアンダーフローしないことは重要な性質になる。

## カウンタとの差 2 — 残っている保持者に問い合わせられる

最終使用時刻の更新は「最後の 1 人が抜けるとき」に一度だけ行いたい。しかも、`NoUpdateLastUsed` を指定して取得したハンドル (内部処理が一時的に掴んだだけのもの) は「使った」と数えたくない。カウンタでは表現できないこの条件が、集合だと素直に書ける。

```go title="cache/refs.go"
func (sr *immutableRef) updateLastUsedNow() bool {
	if !sr.triggerLastUsed {
		return false
	}
	for r := range sr.refs {
		if r.shouldUpdateLastUsed() {
			return false
		}
	}
	return true
}
```

([cache/refs.go L1448-L1458](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/refs.go#L1448-L1458))

自分が「使った」ハンドルであり、かつ集合に残っている他のハンドルに「使った」ものが 1 つも無いときだけ true を返す。`release` の中で `delete` の直後に呼ばれるので、このとき集合には自分を除いた残りが入っている。

`ref` インターフェースがメソッド 1 個なのは、集合の要素に対して問い合わせたいことがこれしか無いからだ。逆に言えば、「保持者の属性で振る舞いを変えたい」という要求が 1 つでもあるなら、カウンタでは足りない。

## カウンタとの差 3 — リークした保持者を特定できる

`traceLogFields` は、集合の要素であるハンドルのポインタを 16 進で記録する。

```go title="cache/refs.go"
// hold ref lock before calling
func (sr *immutableRef) traceLogFields() logrus.Fields {
	m := map[string]any{
		"id":          sr.ID(),
		"refID":       fmt.Sprintf("%p", sr),
		"newRefCount": len(sr.refs),
		"mutable":     false,
		"stack":       bklog.TraceLevelOnlyStack(),
	}
	if sr.equalMutable != nil {
		m["equalMutableID"] = sr.equalMutable.ID()
	}
	if sr.equalImmutable != nil {
		m["equalImmutableID"] = sr.equalImmutable.ID()
	}
	return m
}
```

([cache/refs.go L501-L518](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/refs.go#L501-L518))

`ref()` は "acquired cache ref"、`release()` は "released cache ref" を、いずれも同じ `refID` を付けて trace で出す。ハンドルの識別子が集合のキーそのものなので、ログの取得側と解放側を機械的に突き合わせられる。対応する release が無い `refID` が、そのまま漏れた保持者になる。カウンタでは `+1` と `-1` の羅列しか残らず、どの取得が漏れたのかを言えない。

さらに `stack` フィールドが取得地点のスタックトレースを持つ。生成のコストは trace レベルのときだけ払う。

```go title="util/bklog/log.go"
// TraceLevelOnlyStack returns a stack trace for the current goroutine only if
// trace level logs are enabled; otherwise it returns an empty string. This ensure
// we only pay the cost of generating a stack trace when the log entry will actually
// be emitted.
func TraceLevelOnlyStack() string {
	if logrus.GetLevel() == logrus.TraceLevel {
		return string(debug.Stack())
	}
	return ""
}
```

([util/bklog/log.go L56-L65](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/util/bklog/log.go#L56-L65))

`debug.Stack()` は安くない。ログエントリのフィールドとして無条件に呼ぶと、trace を出していないときも毎回払うことになる。この関数は「出力されないなら作らない」を 1 箇所に閉じ込めている。同じフィールドは `cacheRecord.remove` にも入っていて、レコード削除がどこから来たかも追える ([cache/refs.go L457-L466](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/refs.go#L457-L466))。

## なぜそうなっているか

参照カウントが守っている資源が、プロセスのメモリではなくディスク上のスナップショットとコンテントであることが効いている。GC が面倒を見てくれる範囲の外なので、カウントの整合性は完全に手動になる。そして誤りの影響が非対称だ。

- 数え過ぎ (release 漏れ) → ディスクが解放されない。運用で気づく。`buildctl du` に `InUse` として出る
- 数え足りない (二重 release) → 使用中のスナップショットが消える。ビルドが不可解に失敗する

集合はこの非対称性に合わせて、危険な方向へ倒れないようにしてある。加えて `refs` のキーがハンドルの同一性であることは、「同じレコードを指す 2 つのハンドルは別物として数える」という意味でもある。`Clone()` が新しいハンドルを返しつつ同じ `cacheRecord` を共有できるのは、そのおかげだ。

代償は、要素あたり map のエントリ 1 個ぶんのメモリと、`updateLastUsedNow` が O(n) になること。ただし n は「1 つのキャッシュレコードを同時に掴んでいるハンドル数」であり、実際には小さい。

## どう活かすか

**手動の参照カウントを書くときは、int ではなく保持者の集合にする。** 保持者側にハンドルオブジェクトを返す設計であれば、そのポインタをキーにするだけで済む。二重解放が生きている他の保持者を壊さなくなり、リークの検出も `len` を見るだけになる。

**残っている保持者に問い合わせられる形にしておくと、後から条件を足せる。** BuildKit の場合は「最終使用時刻を更新すべきか」だけだったが、これはカウンタでは絶対に書けなかった処理だ。集合にしておくと、要素にインターフェースを 1 つ足すだけで済む。

**取得と解放のログには、カウントではなく識別子を出す。** `+1 / -1` の羅列からリーク箇所は復元できない。ハンドルのポインタとスタックトレースを両方に載せておけば、突き合わせて未解放の取得地点を特定できる。

**スタックトレースの生成はログレベルで守る。** `TraceLevelOnlyStack()` のように「出力されないなら空文字を返す」小さな関数を 1 個用意して、呼び出し側からは常に呼ぶ。フィールド組み立ての中に `if` を散らすより読みやすく、外し忘れも起きない。
