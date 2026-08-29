// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const repoUrl = "https://github.com/sakurai-ryo/learning-from-oss";

// https://astro.build/config
export default defineConfig({
  // GitHub Pages のプロジェクトサイト (https://sakurai-ryo.github.io/learning-from-oss/) に配信する
  site: "https://sakurai-ryo.github.io",
  base: "/learning-from-oss",
  integrations: [
    starlight({
      title: "Learning from OSS",
      description:
        "OSS のソースコードを読んで学んだことを、OSS ごとの章にまとめていくドキュメントサイト。",
      defaultLocale: "root",
      locales: {
        root: { label: "日本語", lang: "ja" },
      },
      // 検索エンジンのインデックス対象にしない。robots.txt で Disallow にすると
      // このタグ自体がクロールされず noindex が効かないため、クロールは許可する
      head: [
        {
          tag: "meta",
          attrs: { name: "robots", content: "noindex, nofollow" },
        },
      ],
      social: [{ icon: "github", label: "GitHub", href: repoUrl }],
      editLink: { baseUrl: `${repoUrl}/edit/main/` },
      lastUpdated: true,
      routeMiddleware: "./src/starlight-route-data.ts",
      components: {
        PageTitle: "./src/components/PageTitle.astro",
      },
      // src/content/docs/oss/ 配下のディレクトリが 1 つの OSS の章になる。
      // 章を追加するときにこの設定を変更する必要はない。
      sidebar: [{ autogenerate: { directory: "oss", collapsed: true } }],
    }),
  ],
});
