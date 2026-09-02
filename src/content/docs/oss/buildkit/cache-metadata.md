---
title: "cache/metadata — bbolt と自前の二次索引"
description: "ref のメタデータは metadata_v2.db という bbolt に入る。レコードごとに 1 バケット、属性ごとに 1 キーの JSON。bbolt に索引機能は無いので、`index::itemID` という平坦なキーを持つ _index バケットを別に立て、カーソルの前方一致で引く。索引名は値そのものに埋め込まれ、値を消せば索引も消える。"
group: "キャッシュの実体 — ref とレイヤ"
sidebar:
  order: 56
---

## 何を学んだか

`cache/metadata` は bbolt の薄いラッパで、キャッシュレコード 1 件を「1 バケット、キーごとに JSON 値」として保存する。bbolt には副次索引の機能が無いので、`_index` という別バケットに `<索引名>::<レコード ID>` という平坦なキーを並べ、カーソルの前方一致走査で「この索引を持つレコード一覧」を引く。索引名は値の JSON の中に一緒に書かれていて、値を消せば索引エントリも同じトランザクションで消える。

BuildKit にはもう 1 つ bbolt の DB がある。solver のキャッシュキーとリンクを保存する `cache.db` だ ([bbolt のキャッシュリンク](../bbolt-cache-links/))。こちらは `metadata_v2.db` で、扱うものが違う。

```go title="cmd/buildkitd/main.go"
	cacheStorage, err := bboltcachestorage.NewStore(filepath.Join(cfg.Root, "cache.db"))
```

```go title="worker/runc/runc.go"
	md, err := metadata.NewStore(filepath.Join(root, "metadata_v2.db"))
```

([cmd/buildkitd/main.go L897](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cmd/buildkitd/main.go#L897), [worker/runc/runc.go L136](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/worker/runc/runc.go#L136))

`cache.db` は「このキャッシュキーからどの結果に辿れるか」というグラフを持つ。`metadata_v2.db` は「このキャッシュレコードは chainID が何で、blob が何で、最後に使われたのがいつか」という属性を持つ。前者は solver の探索が使い、後者は `cache` パッケージが使う。

## 3 つのバケット

```go title="cache/metadata/metadata.go"
const (
	mainBucket     = "_main"
	indexBucket    = "_index"
	externalBucket = "_external"
)
```

([cache/metadata/metadata.go L19-L23](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L19-L23))

構造はこうなっている。

```
metadata_v2.db
├── _main/                             ネストしたバケット
│   ├── <record id>/
│   │   ├── "cache.chainID"    → {"value":"\"sha256:...\"","index":"chainid:sha256:..."}
│   │   ├── "cache.blobChainID"→ {"value":"\"sha256:...\"","index":"blobchainid:sha256:..."}
│   │   ├── "cache.blob"       → {"value":"\"sha256:...\""}
│   │   ├── "snapshot.size"    → {"value":"123456"}
│   │   ├── "cache.lastUsedAt" → {"value":"1756800000000000000"}
│   │   └── ...
│   └── <record id>/ ...
├── _index/                            平坦なバケット (値は空)
│   ├── "chainid:sha256:aaa::<record id>"      → ""
│   ├── "blobchainid:sha256:bbb::<record id>"  → ""
│   └── ...
└── _external/                         ネストしたバケット
    └── <record id>/
        └── "filelist" → 生バイト列 (JSON 配列)
```

`_main` の値はすべて `Value` の JSON になる。

```go title="cache/metadata/metadata.go"
type Value struct {
	Value json.RawMessage `json:"value,omitempty"`
	Index string          `json:"index,omitempty"`
}
```

([cache/metadata/metadata.go L446-L449](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L446-L449))

**索引名が値の中に入っている**のが要点になる。`chainID` を書くとき、その値に `index: "chainid:sha256:..."` を添える。

```go title="cache/metadata.go"
func (md *cacheMetadata) queueChainID(str digest.Digest) error {
	return md.queueValue(keyChainID, str, chainIndex+str.String())
}
```

([cache/metadata.go L272-L274](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata.go#L272-L274))

こうしておくと、値を消すとき「この値が張っていた索引」がその場で分かる。

```go title="cache/metadata/metadata.go"
func (s *StorageItem) setValue(b *bolt.Bucket, key string, v *Value) error {
	if v == nil {
		if old, ok := s.values[key]; ok {
			if old.Index != "" {
				s.clearIndex(b.Tx(), old.Index) // ignore error
			}
		}
		if err := b.Put([]byte(key), nil); err != nil {
			return err
		}
		delete(s.values, key)
		return nil
	}
	dt, err := json.Marshal(v)
	// ...
	if err := b.Put([]byte(key), dt); err != nil {
		return errors.WithStack(err)
	}
	if v.Index != "" {
		b, err := b.Tx().CreateBucketIfNotExists([]byte(indexBucket))
		if err != nil {
			return errors.WithStack(err)
		}
		if err := b.Put([]byte(indexKey(v.Index, s.ID())), []byte{}); err != nil {
			return errors.WithStack(err)
		}
	}
	s.values[key] = v
	return nil
}
```

([cache/metadata/metadata.go L397-L428](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L397-L428))

`b.Tx()` で同じトランザクションを取り出し、そこから `_index` バケットを掘っているので、値の書き込みと索引の書き込みが原子的になる。索引だけが残ったり、索引だけが消えたりしない。

レコードごと消す `Clear` も同じ考え方で、`si.Indexes()` が返す索引名をすべて `_index` から削ってから `_main` のバケットを消す ([cache/metadata/metadata.go L159-L189](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L159-L189))。

## Search — カーソルの前方一致

索引が平坦なキー空間なので、探索は「プレフィックスで Seek して、外れるまで Next」になる。

```go title="cache/metadata/metadata.go"
func (s *Store) Search(ctx context.Context, index string, prefix bool) ([]*StorageItem, error) {
	var out []*StorageItem
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(indexBucket))
		// ...
		if !prefix {
			index = indexKey(index, "")
		}
		c := b.Cursor()
		k, _ := c.Seek([]byte(index))
		for {
			if k != nil && strings.HasPrefix(string(k), index) {
				idx := strings.LastIndex(string(k), "::")
				if idx == -1 {
					continue
				}
				itemID := string(k[idx+2:])
				k, _ = c.Next()
				b := main.Bucket([]byte(itemID))
				if b == nil {
					bklog.G(ctx).Errorf("index pointing to missing record %s", itemID)
					continue
				}
				si, err := newStorageItem(itemID, b, s)
				// ...
			} else {
				break
			}
		}
		return nil
	})
	return out, errors.WithStack(err)
}
```

([cache/metadata/metadata.go L102-L143](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L102-L143))

`prefix` フラグの意味に注意がいる。false なら `index + "::"` を検索キーにするので、索引の値が完全に一致するものだけが取れる。true なら `index` をそのまま使うので、`"chainid:sha256:aa"` のような途中までの一致でも拾える。`searchBlobchain` / `searchChain` は false で呼ぶ ([cache/metadata.go L122-L129](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata.go#L122-L129))。区切りが `::` なので、レコード ID に `::` が含まれていても `LastIndex` で正しく切れる。

`b == nil` (索引はあるがレコードが無い) をエラーログにして続行しているのは、索引と本体が食い違いうることを認めているからだ。原子的に書いているので通常は起きないが、起きたときに全体を止めない。

`Probe` は同じ Seek を存在確認だけに使う ([cache/metadata/metadata.go L80-L100](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L80-L100))。

## メモリ上にあるのは索引ではなく値のキャッシュ

`StorageItem` は、バケットの中身をまるごとメモリに読み込んで持つ。

```go title="cache/metadata/metadata.go"
type StorageItem struct {
	id      string
	vmu     sync.RWMutex
	values  map[string]*Value
	qmu     sync.Mutex
	queue   []func(*bolt.Bucket) error
	storage *Store
}

func newStorageItem(id string, b *bolt.Bucket, s *Store) (*StorageItem, error) {
	si := &StorageItem{
		id:      id,
		storage: s,
		values:  make(map[string]*Value),
	}
	if b != nil {
		if err := b.ForEach(func(k, v []byte) error {
			var sv Value
			if len(v) > 0 {
				if err := json.Unmarshal(v, &sv); err != nil {
					return errors.WithStack(err)
				}
				si.values[string(k)] = &sv
			}
			return nil
		}); err != nil {
			return si, errors.WithStack(err)
		}
	}
	return si, nil
}
```

([cache/metadata/metadata.go L238-L268](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L238-L268))

つまり `Get` は DB を触らない。`sr.getChainID()` や `sr.getBlobOnly()` のような呼び出しが `cacheRecord` の各所に散らばっていて、`isLazy` の判定や `pruneOnce` のループでも呼ばれるので、毎回 bbolt のトランザクションを開くわけにいかない。書き込みは DB とメモリの両方を更新する。

このキャッシュがあるので、**同じレコードに対して StorageItem が 2 個できると危ない**。`cacheManager` はそれを避けるため、検索結果を必ず自分が持っている `records` マップ経由で引き直す。

```go title="cache/metadata.go"
	for _, si := range sis {
		// calling getMetadata ensures we return the same storage item object that's cached in memory
		md, ok := cm.getMetadata(si.ID())
		if !ok {
			bklog.G(ctx).Warnf("missing metadata for storage item %q during search for %q", si.ID(), idx)
			continue
		}
		if md.getDeleted() {
			continue
		}
		mds = append(mds, md)
	}
```

([cache/metadata.go L95-L107](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata.go#L95-L107))

`Store.Search` が返した `StorageItem` は ID を取るためだけに使われ、実際に返るのはメモリ上のレコードが持つ `cacheMetadata` だ。ついでにここで、削除マーク付きのレコードを検索結果から落としている。

## queue と Commit — 書き込みをまとめる

`GetByBlob` はレコードを作るとき 10 個近くの属性を書く。1 つずつ `Update` を呼ぶと bbolt の書き込みトランザクションが 10 回開く。そこで、変更を関数のリストに溜めて 1 トランザクションで流す仕組みがある。

```go title="cache/metadata/metadata.go"
func (s *StorageItem) Queue(fn func(b *bolt.Bucket) error) {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	s.queue = append(s.queue, fn)
}

func (s *StorageItem) Commit() error {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	if len(s.queue) == 0 {
		return nil
	}
	return errors.WithStack(s.Update(func(b *bolt.Bucket) error {
		for _, fn := range s.queue {
			if err := fn(b); err != nil {
				return errors.WithStack(err)
			}
		}
		s.queue = s.queue[:0]
		return nil
	}))
}
```

([cache/metadata/metadata.go L343-L364](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L343-L364))

これが `cache/metadata.go` の命名規約に直結している。`queueXxx` は溜めるだけ、`SetXxx` はその場で書く。

```go title="cache/metadata.go"
func (md *cacheMetadata) queueValue(key string, value any, index string) error {
	v, err := metadata.NewValue(value)
	if err != nil {
		return errors.Wrap(err, "failed to create value")
	}
	v.Index = index
	md.si.Queue(func(b *bolt.Bucket) error {
		return md.si.SetValue(b, key, v)
	})
	return nil
}

func (md *cacheMetadata) setValue(key string, value any, index string) error {
	// ...
	return md.si.Update(func(b *bolt.Bucket) error {
		return md.si.SetValue(b, key, v)
	})
}
```

([cache/metadata.go L437-L462](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata.go#L437-L462))

`queueXxx` を並べたあと `commitMetadata()` を呼ぶ、というのが `GetByBlob` や `commit()` のパターンになる。`queue` に積まれた時点ではメモリ上の `values` も更新されていないので、commit を呼び忘れると値が消える。裏返せば、途中で失敗したときに何も書かれない。

読み取り・変更・書き込みを 1 トランザクションで行いたい場合は `GetAndSetValue` がある。

```go title="cache/metadata/metadata.go"
var ErrSkipSetValue = errors.New("skip setting metadata value")

func (s *StorageItem) GetAndSetValue(key string, fn func(*Value) (*Value, error)) error {
	return s.Update(func(b *bolt.Bucket) error {
		s.vmu.Lock()
		defer s.vmu.Unlock()
		v, err := fn(s.values[key])
		if errors.Is(err, ErrSkipSetValue) {
			return nil
		} else if err != nil {
			return err
		}
		return s.setValue(b, key, v)
	})
}
```

([cache/metadata/metadata.go L430-L444](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L430-L444))

`ErrSkipSetValue` は「読んだ結果、書く必要がなかった」を表す番兵エラーだ。`appendStringSlice` が使っていて、追加しようとした要素が全部すでに入っていれば書き込みを丸ごと省く ([cache/metadata.go L550-L579](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata.go#L550-L579))。イメージ参照の追記のように「同じ値が何度も来る」場面で、無駄な書き込みトランザクションが消える。

## external — メモリに載せたくない大きな値

`_external` バケットは、`values` のメモリキャッシュを通らない生バイト列の置き場だ。

```go title="cache/metadata/metadata.go"
func (s *StorageItem) GetExternal(k string) ([]byte, error) {
	var dt []byte
	err := s.storage.db.View(func(tx *bolt.Tx) error {
		// ...
		dt2 := b.Get([]byte(k))
		if dt2 == nil {
			return errors.WithStack(errNotFound)
		}
		// data needs to be copied as boltdb can reuse the buffer after View returns
		dt = make([]byte, len(dt2))
		copy(dt, dt2)
		return nil
	})
	// ...
}
```

([cache/metadata/metadata.go L303-L327](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L303-L327))

コメントのとおり、bbolt が `View` の外でバッファを再利用するので明示的にコピーが要る。使い道は `FileList` の結果で、レイヤに含まれるファイル名を全部並べた JSON 配列になる ([cache/filelist.go L16-L22](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/filelist.go#L16-L22))。レイヤ 1 枚に数万ファイル入りうるので、全レコードぶんをメモリに常駐させるわけにいかない。「小さくて頻繁に読む属性は `_main` + メモリキャッシュ、大きくてたまにしか読まないものは `_external`」という分け方になっている。

## なぜそうなっているか

bbolt を選んだ理由は、単一ファイル・依存なし・トランザクションあり・埋め込み可能という条件に合うからだ。ただし bbolt が提供するのは「バケットとソート済みのキー空間」だけで、副次索引もクエリも無い。BuildKit が必要としたのは `chainID` と `blobChainID` の 2 本の索引だけだったので、汎用の索引機構を作らずに「索引名を値に埋める + 平坦なキーで別バケット」という最小の形に留めている。

このやり方の利点は、索引の整合性が値の書き込みに乗ることだ。索引テーブルを独立に管理すると、値と索引の更新順序を間違えたときに孤児が出る。値の中に索引名を持たせておけば、`setValue` の 1 箇所で「古い索引を消す・新しい索引を張る」が完結する。索引の一覧を得る `Indexes()` も、`values` を走査するだけで済む。

欠点は、索引の種類を増やすと `_index` バケットの中で名前空間がプレフィックスだけで分かれることと、1 つの値に索引を 1 つしか付けられないこと。用途が 2 つしかない現状では問題にならない。

なお v1 のメタデータからの自動移行は削除されており、古い `metadata.db` を見つけると起動を止めてエラーを返す ([cache/metadata/metadata.go L31-L48](https://github.com/moby/buildkit/blob/ca4838f8ddbd3612bca94bcb8a938d8a326110a3/cache/metadata/metadata.go#L31-L48))。移行コードを永久に運ぶより、「古いバージョンで移行するか、キャッシュを捨てるか」を明示させる判断になっている。

## どう活かすか

**KV ストアに副次索引が要るなら、索引名を値そのものに埋める。** 別テーブルで管理すると更新順序の間違いで孤児が出る。値に持たせておけば、書き込み・削除の 1 箇所で索引の追随が完結し、しかも同じトランザクションに乗る。

**平坦なキー空間で `<索引>::<ID>` を並べ、カーソルの前方一致で引く。** ソート済みのキー空間しか持たないストアでも、これだけで「この属性値を持つレコード一覧」が取れる。区切り文字は ID 側に現れうるので、`LastIndex` で切るか、そもそも現れない文字を選ぶ。

**読み込みが頻繁な属性はメモリに、大きい値は別バケットに。** `StorageItem` はバケットの中身を丸ごとメモリに持つので `Get` が無料になるが、その代わり大きい値は `_external` に逃がしている。「全部キャッシュする」と「全部読みに行く」の 2 択にせず、サイズとアクセス頻度で分ける。

**溜める API と即書く API を、名前で区別する。** `queueXxx` / `SetXxx` の対で、呼び出し側は「まとめてコミットする」経路と「その場で確定させる」経路を選べる。1 つの API に `flush bool` を足すより、呼び出し箇所を読んだだけでどちらか分かる。

**「読んだ結果、書く必要がなかった」を表す番兵エラーを用意する。** `ErrSkipSetValue` があるおかげで、read-modify-write のコールバックが「変更なし」を返せる。返り値を `(*Value, bool, error)` にするより、既存のシグネチャのまま済む。
