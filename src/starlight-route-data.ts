import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import type { StarlightRouteData } from "@astrojs/starlight/route-data";
import { getCollection } from "astro:content";

type SidebarEntry = StarlightRouteData["sidebar"][number];

const OSS_DIR = "oss";

// Starlight の自動生成サイドバーはグループ名にディレクトリ名をそのまま使う。
// 章ごとに設定を書かなくて済むよう、章の index ページのタイトルでグループ名を上書きする。
const chapterTitles = getCollection("docs").then(
  (entries) => new Map(entries.map((entry) => [entry.id, entry.data.title])),
);

function hrefToId(href: string): string {
  return href.replace(import.meta.env.BASE_URL, "").replace(/^\/|\/$/g, "");
}

function relabelChapters(entries: SidebarEntry[], titles: Map<string, string>): void {
  for (const entry of entries) {
    if (entry.type !== "group") continue;
    if ("autogenerate" in entry && entry.autogenerate.directory === OSS_DIR) {
      const indexLink = entry.entries.find(
        (child) => child.type === "link" && hrefToId(child.href) === `${OSS_DIR}/${entry.label}`,
      );
      if (indexLink?.type === "link") {
        entry.label = titles.get(hrefToId(indexLink.href)) ?? entry.label;
      }
    }
    relabelChapters(entry.entries, titles);
  }
}

export const onRequest = defineRouteMiddleware(async (context) => {
  relabelChapters(context.locals.starlightRoute.sidebar, await chapterTitles);
});
