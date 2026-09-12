import { getCollection, type CollectionEntry } from "astro:content";
import { loader, type StaticSource } from "fumadocs-core/source";
import path from "node:path";

const files: StaticSource<{
  pageData: CollectionEntry<"docs">["data"] & {
    entry: CollectionEntry<"docs">;
  };
  metaData: CollectionEntry<"meta">["data"];
}>["files"] = [];

for (const entry of await getCollection("docs")) {
  if (!entry.filePath) throw new Error(`Missing source path for ${entry.id}`);
  files.push({
    type: "page",
    path: path.relative("content/docs", entry.filePath),
    data: { ...entry.data, entry },
  });
}
for (const entry of await getCollection("meta")) {
  if (!entry.filePath) throw new Error(`Missing source path for ${entry.id}`);
  files.push({
    type: "meta",
    path: path.relative("content/docs", entry.filePath),
    data: entry.data,
  });
}

export const source = loader({
  baseUrl: "/nexus/docs",
  source: { files },
  plugins: [
    {
      name: "astro-trailing-slash",
      config(config) {
        // The loader normalizes `url` options before plugins, removing trailing slashes.
        const getUrl = config.url;
        return {
          ...config,
          url: (...args) => `${getUrl(...args).replace(/\/$/, "")}/`,
        };
      },
    },
  ],
});
