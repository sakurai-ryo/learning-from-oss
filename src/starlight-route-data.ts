import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import type { StarlightRouteData } from "@astrojs/starlight/route-data";
import { getCollection } from "astro:content";

type SidebarEntry = StarlightRouteData["sidebar"][number];
type SidebarGroup = Extract<SidebarEntry, { type: "group" }>;

const OSS_DIR = "oss";

type PageMeta = { title: string; group?: string };

// Starlight の自動生成サイドバーはグループ名にディレクトリ名をそのまま使い、
// 章の中は 1 段のフラットな並びになる。章ごとに設定を書かなくて済むよう、
// 章の index ページのタイトルでグループ名を上書きし、
// 各ページの group フロントマターで章の中を入れ子にする。
const pageMeta = getCollection("docs").then(
  (entries) =>
    new Map<string, PageMeta>(
      entries.map((entry) => [entry.id, { title: entry.data.title, group: entry.data.group }]),
    ),
);

function hrefToId(href: string): string {
  return href.replace(import.meta.env.BASE_URL, "").replace(/^\/|\/$/g, "");
}

// group を持つページを中間グループにまとめる。ページの並び順は変えず、
// 各群はその最初のページがあった位置に置く。group のないページはそのまま残す。
function nestByGroup(entries: SidebarEntry[], meta: Map<string, PageMeta>): SidebarEntry[] {
  const nested: SidebarEntry[] = [];
  const groups = new Map<string, SidebarGroup>();
  for (const entry of entries) {
    const group = entry.type === "link" ? meta.get(hrefToId(entry.href))?.group : undefined;
    if (!group) {
      nested.push(entry);
      continue;
    }
    let target = groups.get(group);
    if (!target) {
      target = { type: "group", label: group, entries: [], collapsed: true, badge: undefined };
      groups.set(group, target);
      nested.push(target);
    }
    target.entries.push(entry);
  }
  return nested;
}

function restructureChapters(entries: SidebarEntry[], meta: Map<string, PageMeta>): void {
  for (const entry of entries) {
    if (entry.type !== "group") continue;
    if ("autogenerate" in entry && entry.autogenerate.directory === OSS_DIR) {
      const indexLink = entry.entries.find(
        (child) => child.type === "link" && hrefToId(child.href) === `${OSS_DIR}/${entry.label}`,
      );
      if (indexLink?.type === "link") {
        entry.label = meta.get(hrefToId(indexLink.href))?.title ?? entry.label;
      }
      entry.entries = nestByGroup(entry.entries, meta) as SidebarGroup["entries"];
    }
    restructureChapters(entry.entries, meta);
  }
}

export const onRequest = defineRouteMiddleware(async (context) => {
  restructureChapters(context.locals.starlightRoute.sidebar, await pageMeta);
});
