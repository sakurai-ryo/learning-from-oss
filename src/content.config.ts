import { defineCollection, z } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

/** OSS の章の index ページに付けるメタデータ。 */
const ossSchema = z.object({
  /** リポジトリ URL */
  repo: z.string().url(),
  /** 主な実装言語 */
  language: z.string().optional(),
  /** 読んだ時点のバージョン・タグ・コミット */
  ref: z.string().optional(),
});

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        oss: ossSchema.optional(),
      }),
    }),
  }),
};
