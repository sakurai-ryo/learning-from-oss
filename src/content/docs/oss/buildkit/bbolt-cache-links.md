---
title: "bbolt にリンクとバックリンクを永続化する"
description: "キャッシュメタデータは 4 つの bbolt バケットに入る。リンクは「JSON でシリアライズしたラベル + @ + 遷移先 ID」というキーに畳み込まれ、プレフィックス検索で辿られる。バックリンクは結果側からキーを引くためと、空になった枝を根に向かって刈るために必要になる。"
group: "キャッシュキーの設計"
sidebar:
  order: 44
---

## 何を学んだか

BuildKit のキャッシュメタデータは bbolt に載っている。設計上のポイントは 3 つ。

1. **バケットは 4 つだけ**。`_result` / `_links` / `_byresult` / `_backlinks`。値はほとんど空で、**情報はキーの名前に入っている**。
2. **リンクはキー名に畳み込まれる**。`json(CacheInfoLink) + "@" + 遷移先 ID` というバイト列がバケットのキーになり、検索は B+tree のプレフィックスシークで済む。
3. **バックリンクは 2 つの用途を兼ねる**。結果側からキーを引く経路と、空になった枝を根に向かって刈っていく GC の経路だ。

## バケット構成

```go title="solver/bboltcachestorage/storage.go"
const (
	resultBucket    = "_result"
	linksBucket     = "_links"
	byResultBucket  = "_byresult"
	backlinksBucket = "_backlinks"
)
```

([solver/bboltcachestorage/storage.go L16-L21](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L16-L21))

4 つとも「トップレベルバケットの下に、キー ID や結果 ID ごとのサブバケットがぶら下がる」2 段構成になっている。

```
db
├── _links                         キー ID → 出ていく辺
│   ├── <keyID-A>/
│   │   ├── {"Input":1,"Digest":"sha256:dd","Selector":"sha256:ss"}@<keyID-R>  → ""
│   │   └── {"Digest":"sha256:dd"}@<keyID-R2>                                  → ""
│   └── <keyID-R>/                 (辺がなくてもサブバケットは作られる)
│
├── _backlinks                     キー ID → 入ってくる辺の「元」の集合
│   └── <keyID-R>/
│       ├── <keyID-A>  → ""
│       └── <keyID-B>  → ""
│
├── _result                        キー ID → そのキーで得られる結果
│   └── <keyID-R>/
│       └── <resultID>  → {"CreatedAt":"...","ID":"<resultID>"}
│
└── _byresult                      結果 ID → その結果を指すキーの集合
    └── <resultID>/
        ├── <keyID-R>   → ""
        └── <keyID-R'>  → ""
```

`_links` のキー名だけが構造を持ち、他の 3 つは単なる集合になっている。値はすべて空バイト列 (`_result` を除く)。**bbolt のキー空間を index として使い切っている**設計だ。

## リンクのエンコードとプレフィックス検索

`AddLink` はラベルを JSON にして、`@` で遷移先 ID と連結する。

```go title="solver/bboltcachestorage/storage.go"
func (s *Store) AddLink(id string, link solver.CacheInfoLink, target string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b, err := tx.Bucket([]byte(linksBucket)).CreateBucketIfNotExists([]byte(id))
		// ...
		dt, err := json.Marshal(link)
		// ...
		if err := b.Put(bytes.Join([][]byte{dt, []byte(target)}, []byte("@")), []byte{}); err != nil {
			return err
		}

		b, err = tx.Bucket([]byte(backlinksBucket)).CreateBucketIfNotExists([]byte(target))
		// ...
		if err := b.Put([]byte(id), []byte{}); err != nil {
			return err
		}
		return nil
	})
}
```

([solver/bboltcachestorage/storage.go L314-L341](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L314-L341))

**1 つの `Update` トランザクションで、順方向のリンクと逆方向のバックリンクを同時に書く。** 片方だけ書かれた状態にはならない。

読む側はシークになる。

```go title="solver/bboltcachestorage/storage.go"
		dt, err := json.Marshal(link)
		if err != nil {
			return err
		}
		index := bytes.Join([][]byte{dt, {}}, []byte("@"))
		c := b.Cursor()
		k, _ := c.Seek(index)
		for {
			if k != nil && bytes.HasPrefix(k, index) {
				target := bytes.TrimPrefix(k, index)
				links = append(links, string(target))
				k, _ = c.Next()
			} else {
				break
			}
		}
```

([solver/bboltcachestorage/storage.go L398-L413](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L398-L413))

`bytes.Join([][]byte{dt, {}}, []byte("@"))` は `dt + "@"` を作っている。これをプレフィックスにして `Seek` し、プレフィックスが外れるまで `Next` する。**あるラベルから出ている辺の一覧が、B+tree 上の連続した範囲になる。**

この方式が成り立つ条件が 2 つある。

**JSON のバイト列が決定的であること。** Go の `encoding/json` は構造体のフィールドを宣言順に出力するので、同じ値からは必ず同じバイト列になる。`CacheInfoLink` は全フィールドに `omitempty` が付いているので ([solver/cachestorage.go L38-L44](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachestorage.go#L38-L44))、ゼロ値のフィールドは消える。`Input=0, Output=0, Digest=X, Selector=""` なら `{"Digest":"X"}` になる。

**JSON にもキー ID にも `@` が現れないこと。** 分解側は `bytes.Split(k, []byte("@"))` して `len(parts) != 2` ならエラーにする ([solver/bboltcachestorage/storage.go L359-L362](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L359-L362))。実際に入る値は digest 文字列 (`sha256:` + 16 進) と `identity.NewID()` の base36 25 文字なので `@` は出ない。ただし**型で保証されているわけではない**、という意味では脆い部分になる。

`HasLink` は同じエンコードで直接 `Get` する ([solver/bboltcachestorage/storage.go L427-L449](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L427-L449))。プレフィックス検索と完全一致検索が同じキー空間の上に同居している。

## バックリンクは何のために要るか

`_backlinks` は「target → source の集合」だけで、ラベルを持たない。ラベルは順方向にしかない。それでも 2 つの用途で不可欠になる。

### 用途 1 — エクスポートのために親を辿る

キャッシュをエクスポートするとき、「この結果キーに至る経路」を上流に向かって集める必要がある。`exporter` はここでバックリンクを使う。

```go title="solver/exporter.go"
	if err := cm.backend.WalkBacklinks(id, func(id string, link CacheInfoLink) error {
		isRoot = false
		recs, err := addBacklinks(t, cm, id, bkm)
		// ...
```

([solver/exporter.go L33-L35](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/exporter.go#L33-L35))

このとき**ラベルも要る**ので、bbolt 実装は 2 段構えで復元する。

```go title="solver/bboltcachestorage/storage.go"
		if err := b.ForEach(func(bid, v []byte) error {
			b = links.Bucket(bid)
			if b == nil {
				return nil
			}
			if err := b.ForEach(func(k, v []byte) error {
				parts := bytes.Split(k, []byte("@"))
				if len(parts) == 2 {
					if string(parts[1]) != id {
						return nil
					}
					var l solver.CacheInfoLink
					if err := json.Unmarshal(parts[0], &l); err != nil {
						return err
					}
					l.Digest = digest.FromBytes(fmt.Appendf(nil, "%s@%d", l.Digest, l.Output))
					l.Output = 0
					outIDs = append(outIDs, string(bid))
					outLinks = append(outLinks, l)
				}
				return nil
			}); err != nil {
```

([solver/bboltcachestorage/storage.go L469-L490](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L469-L490))

**バックリンクで「元」の ID を得て、その元の `_links` サブバケットを全走査して、自分を指す辺を探す。** ラベルを逆方向に持っていないので、この線形走査が要る。`_backlinks` が無ければ全キーを走査することになるので、これでも十分に効く。

`l.Digest` の書き換えには理由がコメントで書いてある。

```go title="solver/bboltcachestorage/storage.go"
			// make digest relative to output as not all backends store output separately
			link.Digest = digest.FromBytes(fmt.Appendf(nil, "%s@%d", link.Digest, link.Output))
```

([solver/bboltcachestorage/storage.go L367-L368](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L367-L368))

リモートキャッシュのフォーマットは `Output` を別フィールドとして持たない。だから外向きのインターフェースでは `Digest` に `Output` を畳み込んだ値を返し、`Output` を 0 にする。同じ畳み込みは `rootKey` がやっているもの ([solver/cachemanager.go L451-L457](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/cachemanager.go#L451-L457)) と同じ計算で、メモリ実装は素直に `rootKey(l.Digest, l.Output)` を呼んでいる ([solver/memorycachestorage.go L265-L269](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/memorycachestorage.go#L265-L269))。**保存形式は内部表現のままで、境界で共通形式に変換する。**

### 用途 2 — 空になった枝を根に向かって刈る

結果が消えたとき、それを指していたキーは意味を失う。さらにそのキーだけを指していた上流のキーも意味を失う。この連鎖を上に辿るのがバックリンクの 2 つ目の用途になる。

```go title="solver/bboltcachestorage/storage.go"
func (s *Store) emptyBranchWithParents(tx *bolt.Tx, id []byte) error {
	results := tx.Bucket([]byte(resultBucket)).Bucket(id)
	if results == nil {
		return nil
	}

	isEmptyLinks := true
	links := tx.Bucket([]byte(linksBucket)).Bucket(id)
	if links != nil {
		isEmptyLinks = isEmptyBucket(links)
	}

	if !isEmptyBucket(results) || !isEmptyLinks {
		return nil
	}

	if backlinks := tx.Bucket([]byte(backlinksBucket)).Bucket(id); backlinks != nil {
		if err := backlinks.ForEach(func(k, v []byte) error {
			if subLinks := tx.Bucket([]byte(linksBucket)).Bucket(k); subLinks != nil {
				// Perform deletion outside of the iteration.
				// https://github.com/etcd-io/bbolt/pull/611
				var toDelete []string
				// ... subLinks のうち自分を指すものを集めて削除 ...
			}
			return s.emptyBranchWithParents(tx, k)
		}); err != nil {
			return err
		}
		if err := tx.Bucket([]byte(backlinksBucket)).DeleteBucket(id); err != nil {
			return err
		}
	}

	// intentionally ignoring errors
	tx.Bucket([]byte(linksBucket)).DeleteBucket(id)
	tx.Bucket([]byte(resultBucket)).DeleteBucket(id)

	return nil
}
```

([solver/bboltcachestorage/storage.go L249-L312](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L249-L312))

削除の条件は「結果も無く、出ていく辺も無い」。両方空なら、バックリンクを辿って親から自分への辺を消し、親に対して再帰する。**参照カウントではなく、到達不能性を上向きに伝播させる形の GC** になっている。

`// Perform deletion outside of the iteration.` の一行に bbolt の PR がリンクされているのが目を引く。**カーソル反復中に削除するとイテレータが壊れる**という bbolt 側の制約で、いったん `toDelete` に集めてから消している。ストレージエンジンの制約がそのままコードの形に出ている例だ。

`Release` からの呼び出し順はこうなっている。

```go title="solver/bboltcachestorage/storage.go"
func (s *Store) releaseHelper(tx *bolt.Tx, id, resultID string) error {
	results := tx.Bucket([]byte(resultBucket)).Bucket([]byte(id))
	// ... _result から resultID を消す ...
	// ... _byresult から id を消し、空なら _byresult のサブバケットごと消す ...
	return s.emptyBranchWithParents(tx, []byte(id))
}
```

([solver/bboltcachestorage/storage.go L219-L247](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L219-L247))

`Release(resultID)` は `_byresult` からその結果を指すキーをすべて引き、各キーについて `releaseHelper` を呼ぶ ([solver/bboltcachestorage/storage.go L200-L217](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L200-L217))。**`_byresult` が無ければ「この結果を指しているキーは誰か」を知るために全走査が要る**ので、このバケットも索引として働いている。

## Walk と Exists — キー存在の定義

キーが「存在する」の定義が面白い。

```go title="solver/bboltcachestorage/storage.go"
func (s *Store) Exists(id string) bool {
	exists := false
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(linksBucket)).Bucket([]byte(id))
		exists = b != nil
		return nil
	})
	// ...
}
```

([solver/bboltcachestorage/storage.go L50-L61](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L50-L61))

**`_links` にサブバケットがあるかどうか**が存在の定義になる。辺が 0 本でもサブバケットがあれば存在する。だから `AddResult` は、結果を書く前にまず `_links` のサブバケットを作る。

```go title="solver/bboltcachestorage/storage.go"
func (s *Store) AddResult(id string, res solver.CacheResult) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		_, err := tx.Bucket([]byte(linksBucket)).CreateBucketIfNotExists([]byte(id))
		if err != nil {
			return err
		}
		// ... _result と _byresult に書く ...
```

([solver/bboltcachestorage/storage.go L144-L154](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L144-L154))

`Walk` も `_links` を基準にする。

```go title="solver/bboltcachestorage/storage.go"
		b := tx.Bucket([]byte(linksBucket))
		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			if v == nil {
				ids = append(ids, string(k))
			}
		}
```

([solver/bboltcachestorage/storage.go L70-L76](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L70-L76))

bbolt では、カーソルが返す値が `nil` ならそのキーはサブバケットを表す。`v == nil` の判定は「サブバケットだけを列挙する」というイディオムになる。

なお、すべての Walk 系メソッドが**まずトランザクション内でスライスに集め、トランザクションを抜けてからコールバックを呼ぶ**構造になっている。コールバックが再びストレージを触っても (`cacheManager.Records` は中で `Release` を呼ぶ) デッドロックしないための形だ。

## 耐久性の選択

```go title="solver/bboltcachestorage/storage.go"
	db, err := boltutil.SafeOpen(dbPath, 0600, &bolt.Options{
		NoSync:       true,
		FreelistType: bolt.FreelistMapType,
	})
```

([solver/bboltcachestorage/storage.go L28-L31](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/solver/bboltcachestorage/storage.go#L28-L31))

`NoSync: true` はコミットごとの fsync を行わない設定だ。キャッシュのメタデータは**失っても再計算できる**ので、耐久性より書き込み速度を取っている。`Query` が探索のたびにリンクを書く設計 ([Query が副作用でリンクを張る](../query-side-effects/)) では、書き込み回数が多くなるのでこの選択が効く。整合性が崩れた場合の受け皿は `NewCacheManager` 起動時の `ReleaseUnreferenced` と、`Records` 読み出し時の実体確認になる。

## なぜそうなっているか

キー ID そのものを保存する専用のバケットが無いのが特徴的だ。保存されているのは「X から Y へ、このラベルで行ける」という関係と、「Y にはこの結果がある」という対応だけで、**「このキーの値は何か」という表は存在しない**。

これはキーが合成的に決まり、しかも合成 ID が探索時に確定するという設計からの帰結になる ([キャッシュキーの合成](../cachekey-composition/))。ID 単体には意味がなく、意味があるのは辺の集合だけなので、辺を主データにするのが素直になる。

バケットを 4 つに割ったのも、必要な索引がちょうど 4 方向あるからだ。順方向のリンク (探索)、逆方向のリンク (エクスポートと GC)、キー → 結果 (ロード)、結果 → キー (`Release`)。どれか 1 つを落とすと、その方向の問い合わせが全走査になる。

## どう活かすか

**キー名に構造を持たせて、B+tree のプレフィックス検索を索引として使う。** `ラベル + 区切り + 遷移先` というキーは、「このラベルの辺を全部列挙する」を範囲スキャンに落とす。値を空にして、情報を全部キー名に入れる設計は、bbolt や RocksDB のような順序付き KV では定番の手になる。区切り文字が値に現れない保証だけは別途必要になる。

**グラフを永続化するなら、逆辺を最初から持つ。** BuildKit のバックリンクはラベルを持たない最小限の形だが、それでも「親を辿る」と「上向きに刈る」の 2 つが可能になっている。ラベルまで二重に持つと更新コストが倍になるので、「ID だけ持って、ラベルは順方向を再走査して復元する」という中間解が取られている。

**捨てても再生成できるデータは、耐久性を落として速度を取る。** `NoSync: true` の判断は「キャッシュメタデータはキャッシュである」という 1 行の割り切りから来ている。ただし壊れたときの受け皿 (起動時の掃除、読み出し時の検証) を先に用意してから落とす、という順序は守られている。
