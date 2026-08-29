---
title: "image store が持つのは「名前 → descriptor」だけ"
description: "containerd の image レコードには、レイヤの一覧もサイズの合計も展開済みフラグも入っていない。名前と、ルート descriptor と、ラベルと時刻だけだ。イメージ削除はこのレコードを消すだけで、blob は GC に任される。「イメージ」という概念を極限まで薄くしたことの帰結を読む。"
group: "メタデータとストア"
sidebar:
  order: 18
---

## 何を学んだか

### レコードは 4 項目

image ストアのレコードに入るのは次のものだけだ。

```
images/<image name>/
├── createdat
├── updatedat
├── target/{digest, mediatype, size}
└── labels/*
```

レイヤの digest 一覧も、展開済みかどうかも、合計サイズも入っていない。**必要なら target から辿って content store を読めばよい** という立場だ。

`ctr images ls` がサイズを表示するとき、containerd は manifest を読んで layer のサイズを足している。キャッシュされた値を返しているのではない。

### 「イメージを削除する」は 1 バケットを消すこと

`ctr images rm` の実体は、bbolt から `images/<name>` バケットを消し、dirty フラグを立てるだけだ。blob も snapshot も、この時点では 1 バイトも消えない。

参照が消えたことで **GC の次回実行時に回収対象になる** だけで、削除処理そのものは即座に終わる。数 GB のイメージを消しても API はすぐ返る。

### 同期削除は「GC を待つ」で表現する

「消してからディスクの空きを確認したい」という要求のために、`Sync` オプションがある。これは削除処理を変えるのではなく、**削除後に GC を起動して完了を待つ** という実装になっている。

### 更新は fieldpath 指定

`Update` は fieldpath (`"labels"`, `"target"` など) を受け取り、指定されたフィールドだけを書き換える。指定がなければ全体を置き換える。楽観的ロックのバージョンフィールドは持たず、bbolt のトランザクションで直列化する。

## ソースコードのどこか

### Create はバケットを 1 つ作るだけ

[`core/metadata/images.go#L124-L178`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/images.go#L124-L178)。

```go title="core/metadata/images.go"
	if err := update(ctx, s.db, func(tx *bolt.Tx) error {
		if err := validateImage(&image); err != nil {
			return err
		}

		bkt, err := createImagesBucket(tx, namespace)
		if err != nil {
			return err
		}

		if err := addImageLease(ctx, tx, image.Name, image.Labels); err != nil {
			return err
		}

		ibkt, err := bkt.CreateBucket([]byte(image.Name))
		if err != nil {
			if err != errbolt.ErrBucketExists {
				return err
			}

			return fmt.Errorf("image %q: %w", image.Name, errdefs.ErrAlreadyExists)
		}
```

`CreateBucket` は既存なら失敗するので、**存在確認と作成が 1 操作** になる。bbolt のトランザクション内なので競合もない。

`addImageLease` に注目したい。現在のコンテキストにリースがあれば、この image をそのリースに追加する。pull の途中で作られた image レコードが、pull 完了前に GC されないようにするためだ。

### 検証は「保存するフィールドだけ」

[`core/metadata/images.go#L347-L377`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/images.go#L347-L377)。

```go title="core/metadata/images.go"
func validateTarget(target *ocispec.Descriptor) error {
	// NOTE(stevvooe): Only validate fields we actually store.

	if err := target.Digest.Validate(); err != nil {
		return fmt.Errorf("target.Digest %q invalid: %v: %w", target.Digest, err, errdefs.ErrInvalidArgument)
	}
```

「実際に保存するフィールドだけを検証する」と明記されている。descriptor には annotations や platform も入りうるが、image ストアは digest / mediaType / size しか保存しないので、それ以外は見ない。

**保存しないものを検証しない** のは、意外に守られない原則だ。検証を増やすと、将来フィールドが追加されたときに互換性を壊しやすくなる。

### Delete は「消して dirty を立てる」

[`core/metadata/images.go#L282-L345`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/metadata/images.go#L282-L345)。

```go title="core/metadata/images.go"
		if options.Target != nil && options.Target.Digest != "" {
			...
			if check.Target.Digest != options.Target.Digest {
				return fmt.Errorf("image %q has target %v, not %v: %w", name, check.Target.Digest, options.Target.Digest, errdefs.ErrNotFound)
			}
		}

		if err = bkt.DeleteBucket([]byte(name)); err != nil {
			if err == errbolt.ErrBucketNotFound {
				err = fmt.Errorf("image %q: %w", name, errdefs.ErrNotFound)
			}
			return err
		}

		s.db.dirty.Add(1)
```

`options.Target` を指定すると、**「target が期待の digest である場合のみ削除する」** という条件付き削除になる。`latest` タグが指すものが変わった後で古い方を消そうとする、といった競合を防げる。compare-and-delete の一種だ。

削除の本体は `DeleteBucket` 1 行で、その後 `dirty` カウンタを増やす。このカウンタが GC スケジューラの入力になる ([GC が DB を止める時間を、目標値から逆算する](../gc-scheduler/))。

イベントの発行はトランザクションの **外** で行われる。

```go title="core/metadata/images.go"
	if publisher := s.db.Publisher(ctx); publisher != nil {
		if err := publisher.Publish(ctx, "/images/delete", &eventstypes.ImageDelete{
			Name: name,
		}); err != nil {
			return err
		}
	}
```

トランザクションが成功してから通知する。逆にすると「イベントは飛んだが削除は失敗した」が起こる。

### 同期削除の実装

[`plugins/services/images/local.go#L166-L187`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/plugins/services/images/local.go#L166-L187)。

```go title="plugins/services/images/local.go"
	// Sync option handled here after event is published
	if err := l.store.Delete(ctx, req.Name, opts...); err != nil {
		return nil, errgrpc.ToGRPC(err)
	}

	if req.Sync {
		if _, err := l.gc.ScheduleAndWait(ctx); err != nil {
			return nil, err
		}
	}
```

同期削除は「削除 + GC を起動して待つ」でしかない。**削除処理自体に同期・非同期のバリエーションを作っていない**。GC という既存の機構に、待つかどうかの選択肢を足しただけだ。

コメントの "handled here after event is published" が順序を示している。イベントを先に出し、それから GC を待つ。購読者は GC の完了を待たずに削除を知る。

### イメージとレイヤを繋ぐのはラベル

image レコードは layer の digest を持たないのに、GC はなぜ layer を保持できるのか。答えは **content store 側のラベル** にある。

pull のとき、manifest blob には `containerd.io/gc.ref.content.<n>` というラベルが付けられ、config と layer の digest を指す。GC はこのラベルを辿る ([資源の関係グラフを、クライアントがラベルで書く](../gc-labels/))。

つまり「イメージ → manifest」は image レコードの target、「manifest → layer」は blob のラベル、という 2 段階でグラフが構成される。image ストアがレイヤ一覧を持たないのはこのためだ。

## なぜそうなっているか

### イメージの構造は content store 側に既にある

manifest を読めばレイヤ一覧が得られるのに、image レコードにも同じ情報を持つと **2 か所に同じ事実がある** ことになる。片方だけ更新される可能性が生まれ、どちらが正しいかを決める必要が出てくる。

containerd は「唯一の事実は content store の blob」と決め、image レコードはそこへの入口だけを持つ。派生情報はすべて計算で求める。

代償は計算コストだ。`ctr images ls` は全イメージの manifest を読む。イメージ数が多い環境では目に見えて遅くなるが、正しさとの引き換えとして受け入れられている。

### 削除を即時にしない

数 GB のレイヤをその場で消すと、API 呼び出しが数秒ブロックする。しかも複数のイメージが同じレイヤを共有しているので、**消してよいかの判定にグラフ全体の走査が必要** になる。

参照を切るだけにして、実際の回収を GC にまとめると、

- 削除 API は常に高速
- 判定が 1 回のグラフ走査にまとまる (イメージ 10 個消しても走査は 1 回)
- 共有されているレイヤを誤って消す心配がない

という利点が得られる。

### 「名前 → 内容の識別子」という最小の対応表

image ストアがやっているのは、可変の名前 (`nginx:latest`) から不変の識別子 (digest) への対応付けだけだ。この関係は DNS や git のブランチと同じ構造をしている。

- **内容は不変で、ハッシュで識別される**
- **名前は可変で、どの内容を指すかだけを持つ**
- **名前の付け替えは対応表の更新のみ** — 内容は動かない

この分離があるおかげで、タグの付け替えが一瞬で終わり、同じ内容に複数の名前を付けても実体は 1 つで済む。

## どう活かすか

### イメージが「ある」の意味を区別する

containerd では、次の 3 つが独立している。

| 状態                       | 確認方法                                     |
| -------------------------- | -------------------------------------------- |
| image レコードがある       | `ctr images ls`                              |
| blob が揃っている          | `ctr content ls` で各 layer の digest を確認 |
| 展開済み (snapshot がある) | `ctr snapshots ls` に chainID がある         |

「イメージはあるのにコンテナが起動しない」場合、レコードだけあって展開されていないことがある。`ctr images ls` に出ることと、すぐ起動できることは別だ。

### 条件付き削除を API に用意する

`DeleteTarget` オプションのような **「期待する現在値を指定して削除する」** 形は、名前が可変な資源を扱う API で有効だ。

```go
// 現在 target がこの digest である場合のみ削除
opts = append(opts, images.DeleteTarget(&desc))
```

タグの付け替えと削除が競合する状況で、「消したつもりが新しい方を消した」を防げる。同じ考え方は HTTP の `If-Match` にもある。可変の名前を持つ資源を設計するなら、削除と更新に条件を付けられるようにしておくと後で助かる。
