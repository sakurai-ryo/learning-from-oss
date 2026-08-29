---
title: "ingest: 中断しても続きから書ける書き込み"
description: "content store への書き込みは ref という名前を持ち、ディスク上のディレクトリとして残る。途中で切れたら同じ ref で開き直せば、書いたところから続けられる。完了は「ハッシュを検証して rename する」だけ。放置された ingest は 24 時間で期限切れになる。"
group: "メタデータとストア"
sidebar:
  order: 17
---

## 何を学んだか

### 書き込みには名前が要る

`content.Store` に blob を書くとき、必ず **ref** という文字列を指定する。

```go
w, err := cs.Writer(ctx, content.WithRef("default/2/layer-sha256:abc..."),
                         content.WithDescriptor(desc))
```

なぜ digest ではなく ref なのか。書き始める時点では **digest が確定していない場合がある** からだ (レジストリから取るときは分かるが、ローカルで生成する layer は書き終わるまで分からない)。ref は「この書き込み操作」の識別子で、中身とは独立している。

### ref が同じなら、続きから書ける

同じ ref で `Writer` を呼び直すと、containerd は既存の ingest ディレクトリを見つけ、**書き込み済みのオフセットから再開** する。

```
ingest/<ref のハッシュ>/
├── data       ← 書き込み済みのバイト列
├── ref        ← 元の ref 文字列
├── startedat
├── updatedat
└── total      ← 期待サイズ (分かっていれば)
```

100 MB の layer を 60 MB まで落として containerd が再起動しても、pull を再開すれば残り 40 MB だけ取ればよい。

### 完了は「検証して rename」

`Commit` がやることは 4 つだけだ。

1. `fsync` してファイルを閉じる
2. サイズが期待通りか確認する
3. **書きながら計算していたハッシュ** が期待値と一致するか確認する
4. `ingest/<x>/data` を `blobs/sha256/<digest>` に `rename` する

rename は同一ファイルシステム内なら原子的なので、**「不完全な blob が blobs/ に見える瞬間」が存在しない**。

### 放置された ingest は期限切れになる

ingest はリースに紐付く。リースがなければ 24 時間の期限が設定され、それを過ぎたものは GC の対象になる。クライアントが pull の途中で死んでも、ディスクが永久に埋まることはない。

## ソースコードのどこか

### 再開の判定

[`plugins/content/local/store.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/content/local/store.go) の `writer`。

```go title="plugins/content/local/store.go"
	// ensure that the ingest path has been created.
	if err := os.Mkdir(path, 0755); err != nil {
		if !os.IsExist(err) {
			return nil, err
		}
		status, err := s.resumeStatus(ref, total, digester)
		if err == nil {
			foundValidIngest = true
			updatedAt = status.UpdatedAt
			startedAt = status.StartedAt
			total = status.Total
			offset = status.Offset
		} else {
			log.G(ctx).Infof("failed to resume the status from path %s: %s. will recreate them", path, err.Error())
		}
	}
```

`os.Mkdir` の結果で分岐しているのが巧い。**「作れたら新規、既にあれば再開」** を 1 回のシステムコールで判定している。存在確認と作成を別々に行うと、その隙間に他のプロセスが作る余地ができる。

再開に失敗した場合は Info ログを出して作り直す。壊れた ingest を引きずらない。

`resumeStatus` は書き込み済みのデータを読み直してハッシュを再計算する。オフセットだけ信じて digest を引き継ぐことはしない。

書き込み開始前にも一手ある。

```go title="plugins/content/local/store.go"
	if expected != "" {
		p, err := s.blobPath(expected)
		if err != nil {
			return nil, fmt.Errorf("calculating expected blob path for writer: %w", err)
		}
		if _, err := os.Stat(p); err == nil {
			return nil, fmt.Errorf("content %v: %w", expected, errdefs.ErrAlreadyExists)
		}
	}
```

期待する digest が分かっていて、既に blob が存在するなら `ErrAlreadyExists` を返す。**呼び出し側はこのエラーを「取得不要」と解釈する**。pull で既存レイヤをスキップする経路がこれだ。

### Commit の検証

[`plugins/content/local/writer.go`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/content/local/writer.go)。

```go title="plugins/content/local/writer.go"
	if err := fp.Sync(); err != nil {
		fp.Close()
		return fmt.Errorf("sync failed: %w", err)
	}

	fi, err := fp.Stat()
	closeErr := fp.Close()
	...
	if size > 0 && size != fi.Size() {
		return fmt.Errorf("unexpected commit size %d, expected %d: %w", fi.Size(), size, errdefs.ErrFailedPrecondition)
	}

	dgst := w.digester.Digest()
```

`fsync` を明示的に呼んでから rename する。「rename が原子的」なのはメタデータ操作としてであって、**中身がディスクに届いていることは別に保証しなければならない**。

digest はストリーミングで計算されている。書き込みの都度 `digester.Hash().Write()` されるので、Commit の時点では読み直し不要だ。

ただし例外がある。

```go title="plugins/content/local/writer.go"
	if expected != "" && expected.Algorithm() != dgst.Algorithm() && expected.Algorithm().Available() {
		// Writer was opened without a descriptor specifying the digest algorithm (but we got a non-canonical one here in commit), so we have to re-hash our now completed and closed content to compare
		start := time.Now()
		f, err := os.Open(filepath.Join(w.path, "data"))
		...
		if duration := time.Since(start); duration > 250*time.Millisecond {
			log.G(ctx).WithField("digest", dgst).WithField("duration", duration).Warnf("commit for blob required expensive re-hash")
		}
	}
```

書き始めに sha256 で計算していたのに、Commit で sha512 の digest を期待された場合、全体を読み直してハッシュし直す。250 ms を超えたら **警告ログを出す**。

「動くが遅い経路」に気付けるようにログを仕込んでおく、という手当てだ。単に動かすだけなら不要なコードで、運用で困った人がいた形跡が見える。

### 衝突は「既にある」として扱う

```go title="plugins/content/local/writer.go"
	if _, err := os.Stat(target); err == nil {
		// collision with the target file!
		if err := os.RemoveAll(w.path); err != nil {
			log.G(ctx).WithField("ref", w.ref).WithField("path", w.path).Error("failed to remove ingest directory")
		}
		return fmt.Errorf("content %v: %w", dgst, errdefs.ErrAlreadyExists)
	}

	if err := os.Rename(ingest, target); err != nil {
		return err
	}
```

書いている間に、別の経路で同じ digest の blob が確定していた場合。**自分が書いたものを捨てて `ErrAlreadyExists` を返す**。content-addressable なので中身は同じはずで、どちらを残しても等価だ。上書きしないのは、既存の blob を読んでいる者がいるかもしれないから。

### ingest もリースの対象

[`core/metadata/content.go#L426-L462`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/content.go#L426-L462)。

```go title="core/metadata/content.go"
		leased, err := addIngestLease(ctx, tx, wOpts.Ref)
		if err != nil {
			return err
		}
		...
		if !leased {
			// Add timestamp to allow aborting once stale
			// When lease is set the ingest should be aborted
			// after lease it belonged to is deleted.
			// Expiration can be configurable in the future to
			// give more control to the daemon, however leases
			// already give users more control of expiration.
			expireAt := time.Now().UTC().Add(24 * time.Hour)
			if err := writeExpireAt(expireAt, bkt); err != nil {
				return err
			}
		}
```

リースの中で開始された ingest はそのリースに属し、リースが消えれば ingest も消える。リースなしなら 24 時間の固定期限。**「誰も面倒を見ないものは必ず期限を持つ」** という規則が徹底されている。

コメントの「期限は将来設定可能にできるが、リースがあれば利用者は既にもっと細かく制御できる」という判断も読みどころだ。設定項目を増やす前に、既存の機構で足りるかを問うている。

### 既存 blob への Writer は「リースを足して ErrAlreadyExists」

```go title="core/metadata/content.go"
		if wOpts.Desc.Digest != "" {
			cbkt := getBlobBucket(tx, ns, wOpts.Desc.Digest)
			if cbkt != nil {
				// Add content to lease to prevent other reference removals
				// from effecting this object during a provided lease
				if err := addContentLease(ctx, tx, wOpts.Desc.Digest); err != nil {
					return fmt.Errorf("unable to lease content: %w", err)
				}
				// Return error outside of transaction to ensure
				// commit succeeds with the lease.
				exists = true
				return nil
			}
```

既に持っている blob に対して書き込みを試みると、**その blob を現在のリースに追加してから** `ErrAlreadyExists` を返す。

これがないと、「既にあるからスキップ」した blob が、直後の GC で消えてしまう。エラーを返す経路でも副作用として参照を張るのが要点で、`return nil` してトランザクションを成功させてから、外でエラーを返している。トランザクションをロールバックさせないための書き方だ。

## なぜそうなっているか

### 大きなデータの転送は必ず失敗すると想定する

コンテナイメージのレイヤは数百 MB になる。ネットワークは切れるし、デーモンは再起動する。**中断を異常ではなく通常の一部として扱う** 設計にしないと、毎回最初からやり直すことになる。

再開可能にするために必要だったのは 2 つ。

- 書き込み操作に **名前 (ref)** を付けて、後から同じものを指せるようにすること
- 書きかけのデータを **確定領域とは別の場所** に置いて、再開時に読めるようにすること

### 「途中のもの」を見せないための 2 領域

`ingest/` と `blobs/` を分けているので、`blobs/` にあるファイルは常に完全で digest 通りだと信じてよい。読み出し側は検証しなくてよい。

もし同じディレクトリで書いていたら、読み手は「このファイルは完成しているか」を毎回判定する必要がある。ロックか状態フラグが要り、クラッシュ時の判定も難しくなる。

### 期限を必ず付ける

containerd では、リースにも ingest にも期限がある。理由は [smart client model](../smart-client/) の弱点にある。クライアントが後始末をする設計なので、クライアントが死んだときの保険が要る。

期限は「誰も参照していないが、まだ消してはいけないもの」を安全に扱う唯一の手段だ。参照カウントでは「参照する予定」を表現できない ([参照カウントをやめて、「これから使う」を宣言させる](../leases/))。

## どう活かすか

### 中断した pull の状態を見る

```sh
# 進行中の ingest (ref, offset, total)
$ ctr -n k8s.io content active

# 中断したものを消す
$ ctr -n k8s.io content abort <ref>
```

`content active` に何時間も offset が動いていないエントリがあれば、pull が固まっているか、クライアントが死んでいる。ディスクが逼迫しているときの最初の確認先になる。

### 再開可能な書き込みを設計するときの型

containerd の ingest は、ファイルアップロードやバックアップ転送でそのまま応用できる形をしている。

- **操作に ID を振る** — 中身のハッシュではなく、操作そのものの名前
- **未完了と完了で場所を分ける** — 読み手が状態を判定しなくてよくなる
- **完了は rename 1 回** — 部分的に見える状態を作らない
- **ハッシュはストリーミングで計算** — 完了時に読み直さない
- **未完了には必ず期限を付ける** — 放置されたものが永久に残らない

特に「操作に ID を振る」を最初に決めておくと、後から再開機能を足すのが容易になる。逆に、ID なしで作ってしまうと再開は事実上あとから足せない。
