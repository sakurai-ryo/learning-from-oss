# Learning from OSS

OSS のソースコードを読んで学んだことを、OSS ごとの章にまとめていくドキュメントサイト。
[Astro](https://astro.build) + [Starlight](https://starlight.astro.build) で構築している。

## セットアップ

```sh
vp install
vp run dev      # 開発サーバー (localhost:4321)
vp run build    # 本番ビルド (dist/)
vp run preview  # ビルド結果のプレビュー
vp check        # フォーマット・lint・型チェック
```

## ディレクトリ構成

```
src/
├── content/docs/
│   ├── index.mdx            # トップページ
│   └── oss/
│       ├── index.mdx        # OSS 一覧 (章の index ページを自動で列挙)
│       ├── sample/          # 章のサンプル (draft のため本番ビルドには含まれない)
│       └── <oss-name>/      # OSS ごとの章
│           ├── index.md     # 章の概要 (oss メタデータ付き)
│           └── <topic>.md   # 学び 1 つにつき 1 ページ
├── components/
│   ├── OssList.astro        # 章一覧カード
│   └── PageTitle.astro      # タイトル下に oss メタデータを表示
├── starlight-route-data.ts  # サイドバーのグループ名を章タイトルで置き換える
└── content.config.ts        # frontmatter スキーマ (oss フィールドの定義)
```

## 章の追加

1. `src/content/docs/oss/sample/` を `src/content/docs/oss/<oss-name>/` にコピーする
2. 各ページの `draft: true` を削除する
3. `index.md` の frontmatter を書き換える

```yaml
title: DataLoader # サイドバーのグループ名と一覧カードに使われる
description: 一覧カードの説明文
oss:
  repo: https://github.com/graphql/dataloader
  language: JavaScript # 任意
  ref: v2.2.2 # 任意。読んだ時点のタグやコミット
sidebar:
  label: 概要
  order: 0
```

4. 学びごとに `<topic>.md` を追加する。`sidebar.order` で並び順を指定できる (未指定はファイル名順)

サイドバーは `src/content/docs/oss/` 配下を自動生成しているため、`astro.config.mjs` の変更は不要。

## ページの構成

学び 1 つにつき 1 ページ。見出しは次の 4 つを基本にする。

1. 何を学んだか — 結論を先に
2. ソースコードのどこか — タグやコミットを含む URL とコード引用
3. なぜそうなっているか — Issue / PR / コメント / テストから読み取れる意図
4. どう活かすか — 取り込み方と、取り込むべきでない条件
