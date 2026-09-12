import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

const root = path.resolve("dist");
const origin = "https://c-w-xiaohei.github.io";
const base = "/nexus/";
const pages = new Map();
const failures = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (file.endsWith(".html"))
      pages.set(file, load(await readFile(file, "utf8")));
  }
}

await scan(root);
if (pages.size === 0)
  throw new Error("No built pages found; run astro build first");

for (const [file, $] of pages) {
  const pageUrl = new URL(
    base + path.relative(root, file).replace(/index\.html$/, ""),
    origin,
  );
  for (const block of $(".prose pre").toArray()) {
    if (!$(block).closest("figure.shiki").find("button[aria-label]").length)
      failures.push(
        `${pageUrl.pathname}: code block is missing its copy component`,
      );
  }
  for (const element of $(
    "a[href], img[src], script[src], link[href]",
  ).toArray()) {
    const href = $(element).attr("href") ?? $(element).attr("src");
    const url = new URL(href, pageUrl);
    if (url.origin !== origin) continue;
    if (!url.pathname.startsWith(base)) {
      failures.push(`${pageUrl.pathname}: URL escapes Pages base: ${href}`);
      continue;
    }
    let target = path.join(
      root,
      decodeURIComponent(url.pathname.slice(base.length)),
    );
    try {
      if ((await stat(target)).isDirectory()) {
        if (!url.pathname.endsWith("/"))
          failures.push(
            `${pageUrl.pathname}: directory link requires trailing slash: ${href}`,
          );
        target = path.join(target, "index.html");
      }
      await stat(target);
      if (url.hash && pages.has(target)) {
        const id = decodeURIComponent(url.hash.slice(1));
        const targetPage = pages.get(target);
        if (
          !targetPage("[id]")
            .toArray()
            .some((node) => targetPage(node).attr("id") === id)
        ) {
          failures.push(`${pageUrl.pathname}: missing anchor ${href}`);
        }
      }
    } catch {
      failures.push(`${pageUrl.pathname}: missing file ${href}`);
    }
  }
}

if (failures.length) throw new Error(failures.join("\n"));
console.log(
  `Checked ${pages.size} pages: all local links, assets and anchors resolve under ${base}`,
);
