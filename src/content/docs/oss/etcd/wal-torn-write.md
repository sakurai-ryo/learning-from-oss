---
title: "「途中まで書けた」と「壊れた」を区別するために、レコードをセクタ境界に合わせる"
description: "電源が落ちた瞬間のディスク書き込みは、途中で切れる。etcd の WAL は、長さフィールドが 8 バイト境界をまたがないようパディングを入れ、CRC をレコード間で連鎖させ、復号に失敗したデータをセクタ単位で調べてゼロ埋めがあるかを見る。ゼロがあれば「書ききれなかった」、無ければ「壊れた」と判定する。"
group: "ストレージ"
sidebar:
  order: 9
---

## 何を学んだか

### どんな状況の話か

[Ready ループのページ](../raft-ready-loop/) で見たとおり、etcd は合意されたエントリを WAL に書いてから fsync する。Raft の安全性は「fsync したものは失われない」という前提の上に立っている。

問題は、**fsync の途中で電源が落ちたらどうなるか** だ。

ディスクの書き込みは、通常 512 バイト (あるいは 4096 バイト) の **セクタ** 単位で原子的に行われる。1 セクタは全部書けるか全部書けないかのどちらかだが、**複数セクタにまたがる書き込みは途中で切れる**。これを **torn write (引き裂かれた書き込み)** と呼ぶ。

再起動時に WAL を読むと、末尾でこういう状態に出会う。

- **正常に終わっている。** 何も問題ない。
- **途中で切れている。** そのレコードは fsync が完了していないので、**捨ててよい** (クライアントにも成功を返していない)。
- **データが化けている。** ディスクの故障やビットの反転。**捨ててはいけない。** 気づかず動き続けると、他のノードとデータがずれる。

**後ろの 2 つを区別しなければならない。** どちらも「読めないレコード」として現れるのに、対処は正反対だ。

### etcd の答え

1. **各レコードの前に、8 バイトの長さフィールドを置く。**
2. **レコードの本体を 8 バイト境界にパディングし、パディング量を長さフィールドの上位ビットに詰める。** 長さフィールド自体が引き裂かれることがなくなる。
3. **CRC をレコード間で連鎖させる。** ある 1 個のレコードだけを差し替えることができない。
4. **書き込みはページ (4 KB) 単位で揃えてフラッシュする。**
5. **復号に失敗したら、失敗したデータをセクタ境界で切り分けて、全部ゼロのセクタがあるかを見る。** あれば torn write。
6. **書き込みモードで開いた場合は、末尾の不完全な部分をゼロ埋めしてから使う。**

**「ゼロ埋めされたセクタがある = 書ききれなかった」** という判定が、この設計の核になっている。

## ソースコードのどこか

### フォーマットの定義

パッケージのドキュメントに全部書いてある ([`server/storage/wal/doc.go#L39-L52`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/doc.go#L39-L52))。

```go title="server/storage/wal/doc.go"
Each WAL file is a stream of WAL records. A WAL record is a length field and a wal record
protobuf. The record protobuf contains a CRC, a type, and a data payload. The length field is a
64-bit packed structure holding the length of the remaining logical record data in its lower
56 bits and its physical padding in the first three bits of the most significant byte. Each
record is 8-byte aligned so that the length field is never torn. The CRC contains the CRC32
value of all record protobufs preceding the current record.

WAL files are placed inside the directory in the following format:
$seq-$index.wal
```

**「長さフィールドが決して torn しないように、各レコードを 8 バイト境界に揃える」** が設計の宣言になっている。

なぜ長さフィールドが特別かというと、**それが読めないと次のレコードの位置が分からない** からだ。データ本体が壊れているなら「このレコードは駄目」で済むが、長さが壊れると **そこから先が全部読めなくなる**。ファイルの構造そのものを壊す。

「CRC は、それ以前のすべてのレコードの CRC32」も重要な一文で、これは後で見る。

### 長さフィールドの詰め方

[`server/storage/wal/encoder.go#L100-L108`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/encoder.go#L100-L108)。

```go title="server/storage/wal/encoder.go"
func encodeFrameSize(dataBytes int) (lenField uint64, padBytes int) {
	lenField = uint64(dataBytes)
	// force 8 byte alignment so length never gets a torn write
	padBytes = (8 - (dataBytes % 8)) % 8
	if padBytes != 0 {
		lenField |= uint64(0x80|padBytes) << 56
	}
	return lenField, padBytes
}
```

**64 ビットの中に、長さ (下位 56 ビット) とパディング量 (上位 3 ビット) と「パディングがあるか」のフラグ (最上位ビット) を詰めている。**

読み出し側 ([`server/storage/wal/decoder.go#L157-L166`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/decoder.go#L157-L166))。

```go title="server/storage/wal/decoder.go"
func decodeFrameSize(lenField int64) (recBytes int64, padBytes int64) {
	// the record size is stored in the lower 56 bits of the 64-bit length
	recBytes = int64(uint64(lenField) & ^(uint64(0xff) << 56))
	// non-zero padding is indicated by set MSb / a negative length
	if lenField < 0 {
		// padding is stored in lower 3 bits of length MSB
		padBytes = int64((uint64(lenField) >> 56) & 0x7)
	}
	return recBytes, padBytes
}
```

**`lenField < 0` で「パディングがあるか」を判定している。** 最上位ビットが立っていれば、`int64` として負になる。符号ビットをフラグとして使う古典的な手だ。

56 ビットあれば 64 PB まで表せるので、レコード長として不足はない。**余ったビットに情報を詰めることで、追加のフィールドを作らずに済んでいる。** レコードのヘッダが 8 バイト増えることは、レコード数が多いほど効いてくる。

### CRC の連鎖

[`server/storage/wal/encoder.go#L66-L76`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/encoder.go#L66-L76)。

```go title="server/storage/wal/encoder.go"
func (e *encoder) encode(rec *walpb.Record) error {
	// ...
	e.crc.Write(rec.Data)
	rec.Crc = new(e.crc.Sum32())
```

`e.crc` は **リセットされない**。前のレコードまでの CRC 状態に、今回のデータを追加で流し込む。だから各レコードの CRC は「ファイルの先頭からここまでの累積 CRC」になる。

**これがもたらす性質は、単なる破損検出より強い。**

- 1 個のレコードだけを書き換えると、それ以降すべての CRC が合わなくなる。
- レコードの順序を入れ替えられない。
- **レコードを削除しても、途中に挿入しても検出される。**

ファイルをまたぐときは、新しいファイルの先頭に前のファイルの CRC を書き込む ([`server/storage/wal/wal.go#L808-L822`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/wal.go#L808-L822))。

```go title="server/storage/wal/wal.go"
	// update writer and save the previous crc
	w.locks = append(w.locks, newTail)
	prevCrc := w.encoder.crc.Sum32()
	w.encoder, err = newFileEncoder(w.tail().File, prevCrc)
	if err != nil {
		return err
	}

	if err = w.saveCrc(prevCrc); err != nil {
		return err
	}
```

**連鎖がファイル境界で切れない。** WAL が 20 個のファイルに分かれていても、全体が 1 本の CRC チェーンになる。ファイルを 1 個だけ差し替えることができない。

### torn write の判定

ここがこのページの主題だ ([`server/storage/wal/decoder.go#L168-L203`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/decoder.go#L168-L203))。

```go title="server/storage/wal/decoder.go"
// isTornEntry determines whether the last entry of the WAL was partially written
// and corrupted because of a torn write.
func (d *decoder) isTornEntry(data []byte) bool {
	if len(d.brs) != 1 {
		return false
	}

	fileOff := d.lastValidOff + frameSizeBytes
	curOff := 0
	var chunks [][]byte
	// split data on sector boundaries
	for curOff < len(data) {
		chunkLen := int(minSectorSize - (fileOff % minSectorSize))
		if chunkLen > len(data)-curOff {
			chunkLen = len(data) - curOff
		}
		chunks = append(chunks, data[curOff:curOff+chunkLen])
		fileOff += int64(chunkLen)
		curOff += chunkLen
	}

	// if any data for a sector chunk is all 0, it's a torn write
	for _, sect := range chunks {
		isZero := true
		for _, v := range sect {
			if v != 0 {
				isZero = false
				break
			}
		}
		if isZero {
			return true
		}
	}
	return false
}
```

**判定の理屈はこうだ。**

1. WAL ファイルは事前に確保 (preallocate) されていて、**未使用領域はゼロで埋まっている**。
2. レコードを書くとき、複数のセクタにまたがる。
3. torn write が起きると、**書けたセクタと、書けずにゼロのままのセクタが混在する**。
4. だから、**読めなかったデータをセクタ境界で切って、全部ゼロのセクタが 1 つでもあれば torn write**。

一方、ディスクの故障やビット反転では、**セクタ丸ごとがゼロになることは考えにくい**。だから「ゼロのセクタがない破損」は本物の破損として扱う。

`if len(d.brs) != 1` の 1 行も効いている。**残りのファイルが 1 個でない (= 最後のファイルではない) なら、torn write ではありえない。** 途中のファイルが不完全ということは、その後のファイルが書けているはずがないからだ。

`fileOff % minSectorSize` でセクタ境界を計算しているところは、**ファイル内の絶対位置が要る** ことを示している。データの中の相対位置ではセクタ境界が分からない。だから `lastValidOff` を持ち回っている。

### 書き込みはページ単位で揃える

[`server/storage/wal/encoder.go#L33-L36`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/encoder.go#L33-L36)。

```go title="server/storage/wal/encoder.go"
// walPageBytes is the alignment for flushing records to the backing Writer.
// It should be a multiple of the minimum sector size so that WAL can safely
// distinguish between torn writes and ordinary data corruption.
const walPageBytes = 8 * minSectorSize
```

**「torn write と通常のデータ破損を安全に区別できるように」** と、目的が明記されている。4 KB (512 × 8) 単位でフラッシュする。

実装は `PageWriter` ([`pkg/ioutil/pagewriter.go#L56-L99`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/ioutil/pagewriter.go#L56-L99))。

```go title="pkg/ioutil/pagewriter.go"
func (pw *PageWriter) Write(p []byte) (n int, err error) {
	if len(p)+pw.bufferedBytes <= pw.bufWatermarkBytes {
		// no overflow
		copy(pw.buf[pw.bufferedBytes:], p)
		pw.bufferedBytes += len(p)
		return len(p), nil
	}
	// complete the slack page in the buffer if unaligned
	slack := pw.pageBytes - ((pw.pageOffset + pw.bufferedBytes) % pw.pageBytes)
	if slack != pw.pageBytes {
		partial := slack > len(p)
		if partial {
			// not enough data to complete the slack page
			slack = len(p)
		}
		// special case: writing to slack page in buffer
		copy(pw.buf[pw.bufferedBytes:], p[:slack])
		pw.bufferedBytes += slack
		n = slack
		p = p[slack:]
		if partial {
			// avoid forcing an unaligned flush
			return n, nil
		}
	}
	// buffer contents are now page-aligned; clear out
	if err = pw.Flush(); err != nil {
		return n, err
	}
	// directly write all complete pages without copying
	if len(p) > pw.pageBytes {
		pages := len(p) / pw.pageBytes
		c, werr := pw.w.Write(p[:pages*pw.pageBytes])
		// ...
```

**バッファはページサイズぶん余分に確保されている** ([`#L45-L54`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/pkg/ioutil/pagewriter.go#L45-L54))。

```go title="pkg/ioutil/pagewriter.go"
		buf:               make([]byte, defaultBufferBytes+pageBytes),
		bufWatermarkBytes: defaultBufferBytes,
```

**「水位」を実際のバッファ長より小さく設定して、差分をページ境界合わせの余白に使っている。** 水位を超えたとき、ページ境界まで足りない分 (`slack`) をバッファに書き足してからフラッシュする。だからフラッシュは常にページ境界で終わる。

そして、**大きい書き込みはバッファを経由しない**。完全なページの分は直接下位の `Writer` に渡す。コピーが 1 回減る。

`pageOffset` を持っているのも重要で、**ファイルの途中から書き始める場合でも、ファイル内の絶対位置でページ境界を計算できる**。既存の WAL に追記するときにこれが要る。

### 復旧のときの扱い

読み出しモードと書き込みモードで、末尾の扱いが変わる ([`server/storage/wal/wal.go#L542-L569`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/wal.go#L542-L569))。

```go title="server/storage/wal/wal.go"
	switch w.tail() {
	case nil:
		// We do not have to read out all entries in read mode.
		// The last record maybe a partial written one, so
		// `io.ErrUnexpectedEOF` might be returned.
		if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			state.Reset()
			return nil, state, nil, err
		}
	default:
		// We must read all the entries if WAL is opened in write mode.
		if !errors.Is(err, io.EOF) {
			state.Reset()
			return nil, state, nil, err
		}
		// decodeRecord() will return io.EOF if it detects a zero record,
		// but this zero record may be followed by non-zero records from
		// a torn write. Overwriting some of these non-zero records, but
		// not all, will cause CRC errors on WAL open. Since the records
		// were never fully synced to disk in the first place, it's safe
		// to zero them out to avoid any CRC errors from new writes.
		if _, err = w.tail().Seek(w.decoder.LastOffset(), io.SeekStart); err != nil {
			return nil, state, nil, err
		}
		if err = fileutil.ZeroToEnd(w.tail().File); err != nil {
			return nil, state, nil, err
		}
	}
```

**書き込みモードでは、`io.ErrUnexpectedEOF` すら許さない。** 読み出しモード (検査ツールなど) では末尾の不完全なレコードを黙って無視するが、これから書き足すなら話が違う。

問題を説明しているコメントが具体的だ。

- torn write の後には、**ゼロのセクタの後ろに、非ゼロのゴミが残っていることがある**。
- ゼロのところから書き足すと、後ろのゴミが残ったままになる。
- そのゴミが「壊れたレコード」として読まれて、次の起動で CRC エラーになる。

だから **`ZeroToEnd` で末尾まで全部ゼロにしてから書き始める**。「そもそも fsync されていないレコードなので、消してよい」という根拠も書いてある。

**「読むだけ」と「書き足す」で要求される厳密さが違う** ことが、`switch w.tail()` の 1 つの分岐として表現されている。

### ファイルの事前確保

torn write の判定は「未使用領域がゼロである」ことに依存している。それを作っているのが preallocate だ ([`server/storage/wal/wal.go#L51-L55`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/wal.go#L51-L55))。

```go title="server/storage/wal/wal.go"
	// SegmentSizeBytes is the preallocated size of each wal segment file.
	SegmentSizeBytes int64 = 64 * 1000 * 1000 // 64MB
```

事前確保には別の目的もある。**ファイルの伸長 (メタデータの更新) が書き込みパスから消える。** ファイルサイズが変わると、ファイルシステムのメタデータも fsync が要る。最初に 64 MB 確保しておけば、以後の書き込みはデータブロックの更新だけになる。

そして、その確保を書き込みパスから外に出しているのが `filePipeline` だ ([`server/storage/wal/file_pipeline.go#L75-L100`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/file_pipeline.go#L75-L100))。

```go title="server/storage/wal/file_pipeline.go"
func (fp *filePipeline) alloc() (f *fileutil.LockedFile, err error) {
	// count % 2 so this file isn't the same as the one last published
	fpath := filepath.Join(fp.dir, fmt.Sprintf("%d.tmp", fp.count%2))
	if f, err = createNewWALFile[*fileutil.LockedFile](fpath, false); err != nil {
		return nil, err
	}
	if err = fileutil.Preallocate(f.File, fp.size, true); err != nil {
		// ...
	}
	fp.count++
	return f, nil
}

func (fp *filePipeline) run() {
	defer close(fp.errc)
	for {
		f, err := fp.alloc()
		if err != nil {
			fp.errc <- err
			return
		}
		select {
		case fp.filec <- f:
		case <-fp.donec:
```

**バックグラウンドの goroutine が、次のファイルを 1 個だけ先に作って待機している。** バッファなしチャネルなので、1 個が取られるまで次は作らない。

64 MB の事前確保は、ファイルシステムによっては数十ミリ秒かかる。**それが書き込みパスに入ると、その瞬間だけレイテンシが跳ねる。** 先に作っておけば、ファイルの切り替えはチャネルからの受信だけになる。

`fp.count%2` で `0.tmp` と `1.tmp` を交互に使っているのは、**「今公開したファイル」と「次に作るファイル」の名前が衝突しないようにするため**。3 つ以上は要らない (1 個しか先行しないので) が、1 個だと衝突する。**必要十分な数が 2 だと分かっているので、2 にしている。**

### ファイルを切り替えるときの手順

[`server/storage/wal/wal.go#L785-L845`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/wal.go#L785-L845)。

```go title="server/storage/wal/wal.go"
func (w *WAL) cut() error {
	// close old wal file; truncate to avoid wasting space if an early cut
	off, serr := w.tail().Seek(0, io.SeekCurrent)
	if serr != nil {
		return serr
	}

	if err := w.tail().Truncate(off); err != nil {
		return err
	}

	if err := w.sync(); err != nil {
		return err
	}
```

**古いファイルを、実際に書いた位置まで切り詰める。** 事前確保で 64 MB あるが、スナップショットなどで早めに切り替えるときは、後ろがゼロのまま残る。切り詰めればディスクを無駄にしない。

新しいファイルは、**テンポラリ名で作って、内容を書いてから rename する**。

```go title="server/storage/wal/wal.go"
	// atomically move temp wal file to wal file
	if err = w.sync(); err != nil {
		return err
	}
	// ...
	if err = os.Rename(newTail.Name(), fpath); err != nil {
		return err
	}
	start := time.Now()
	if err = fileutil.Fsync(w.dirFile); err != nil {
		return err
	}
```

**`sync` → `rename` → **ディレクトリ**の fsync**、という順序になっている。

ディレクトリの fsync を忘れるのは、この種のコードで最もよくある間違いだ。**ファイルの中身を fsync しても、「そのファイルがこの名前で存在する」というディレクトリエントリは fsync されていない。** 電源が落ちると、中身は完璧なのに名前が存在しない、という状態になりうる。

rename の前に中身を書き終えているので、**「正式な名前で存在するファイルは、必ず完全な内容を持つ」** が保証される。中途半端なファイルは `0.tmp` という名前でしか存在しない。

## なぜそうなっているか

- **長さフィールドを 8 バイト境界に揃えるのは、それが壊れるとファイル全体が読めなくなるから。** データが壊れても「このレコードは駄目」で済むが、長さが壊れると次のレコードの位置が失われる。**構造を決めるメタデータと、中身のデータでは、必要な保護の強さが違う。**
- **パディング量を長さフィールドの空きビットに詰めるのは、ヘッダを増やしたくないから。** レコードが数億個あるなら、1 レコードあたり 8 バイトの差は GB 単位になる。**64 ビットのうち 56 ビットしか使わないなら、残りは使える。**
- **CRC を連鎖させるのは、単発の破損検出以上のものが要るから。** レコードごとに独立した CRC だと、「1 個のレコードを正しい CRC 付きで差し替える」ことができる。連鎖していれば、それ以降すべてが合わなくなる。**改竄や、部分的な巻き戻しが検出できる。**
- **「ゼロのセクタがあるか」で torn write を判定できるのは、ファイルを事前にゼロで確保しているから。** 事前確保はレイテンシのためにやっていることだが、**副産物として「未書き込み領域はゼロ」という不変条件を作っている**。それが破損の分類に使える。
- **ページ境界でフラッシュするのは、セクタ境界の判定を成り立たせるため。** 中途半端な位置でフラッシュすると、torn write の痕跡がセクタ境界に揃わない。**判定のロジックが、書き込みの規律に依存している。**
- **読み出しと書き込みで厳密さを変えるのは、要求が違うから。** 検査ツールは末尾が壊れていても中身を見たい。書き足すなら、後ろにゴミが残っていてはいけない。**同じデータでも、これから何をするかで許容範囲が変わる。**
- **ファイルの事前確保を別 goroutine に出すのは、それがレイテンシの外れ値を作るから。** 64 MB の確保は、平均すれば無視できるが、起きた瞬間だけ跳ねる。**平均ではなくテールレイテンシを見ると、事前確保のような「たまに起きる重い処理」が主犯になっていることが多い。**
- **rename の後にディレクトリを fsync するのは、ディレクトリエントリも永続化の対象だから。** POSIX の fsync はファイルの中身しか保証しない。**「作って、書いて、fsync して、rename して、ディレクトリを fsync」が原子的なファイル差し替えの完全形。**

## どう活かすか

- **ファイル形式を設計するときは、「構造を決めるフィールド」を特別に保護する。** 長さ・オフセット・カウントのように、それが壊れると後続が全部読めなくなるフィールドは、アラインメントを揃える、多重化する、別領域に置くなどの手当てをする。データ本体より強い保証が要る。
- **チェックサムは連鎖させると、検出できる異常の種類が増える。** レコード単位の独立したチェックサムは「壊れたか」しか分からない。連鎖させると、差し替え・並べ替え・部分的な巻き戻しが検出できる。ファイルをまたぐときも連鎖を切らない。
- **「まだ書いていない領域」の値を決めておくと、破損の分類に使える。** 事前にゼロで確保しておけば、「ゼロが混じっている = 書ききれなかった」と言える。**不変条件を 1 つ増やすだけで、区別できないはずのものが区別できるようになる。**
- **「途中で切れた」と「壊れた」を区別できる形式にする。** 前者は捨ててよく、後者は捨ててはいけない。区別できないと、どちらかに寄せた判断をすることになり、データ喪失か、汚染された状態での続行のどちらかが起きる。
- **フラッシュの粒度を、下位層の原子性の単位に合わせる。** セクタやページの境界で切ることで、部分書き込みの痕跡が予測可能な位置に出る。任意の位置でフラッシュすると、その予測が立たない。
- **同じデータでも、読むだけか書き足すかで検証の厳しさを変える。** 検査・復旧ツールは寛容に、書き込みパスは厳格に。厳格な側では、不完全な部分を明示的に消してから始める。
- **「たまに起きる重い準備処理」は、別スレッドで先回りさせる。** ファイルの確保、接続の確立、バッファの割り当て。平均のスループットには出ないが、テールレイテンシには直接出る。先行して 1 個だけ用意する形なら、メモリも無駄にならない。
- **ファイルの差し替えは「一時名で書く → fsync → rename → ディレクトリを fsync」。** 途中で落ちても、正式な名前のファイルは常に完全な内容を持つ。ディレクトリの fsync を忘れると、この保証が消える。
