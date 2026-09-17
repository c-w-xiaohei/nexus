import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";
import tailwindcss from "@tailwindcss/vite";
import { rehypeCode, remarkHeading } from "fumadocs-core/mdx-plugins";

// Localize links at compilation for both Markdown and MDX. A React Link
// override cannot reach Astro's separately rendered content islands.
function localizeMarkdownLinks() {
  return (tree, file) => {
    if (!file.path?.replaceAll("\\", "/").includes("/zh-CN/")) return;
    function walk(node) {
      const href = node.properties?.href;
      if (node.tagName === "a" && typeof href === "string") {
        node.properties.href = href.replace(
          /^\/nexus\/docs(?=\/|[?#]|$)(?!\/zh-CN(?:\/|[?#]|$))/,
          "/nexus/docs/zh-CN",
        );
      }
      node.children?.forEach(walk);
    }
    walk(tree);
  };
}

// Local bookmarks often omit the GitHub Pages base. Redirect before Astro's
// base-path guard so /docs and nested links do not fall through to its 404 page.
function redirectLocalDocs(server) {
  return () =>
    server.middlewares.stack.unshift({
      route: "",
      handle(request, response, next) {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) {
          response.writeHead(302, {
            Location: `/nexus${url.pathname.replace(/\/$/, "")}/${url.search}`,
          });
          response.end();
          return;
        }
        next();
      },
    });
}

export default defineConfig({
  site: "https://c-w-xiaohei.github.io",
  base: "/nexus",
  trailingSlash: "always",
  output: "static",
  markdown: {
    // Astro 7's unified() does not forward syntaxHighlight: keep it here,
    // unlike the Fumadocs Astro guide. A second pass loses the fence language.
    syntaxHighlight: false,
    processor: unified({
      remarkPlugins: [remarkHeading],
      rehypePlugins: [
        localizeMarkdownLinks,
        [
          rehypeCode,
          { themes: { light: "github-light", dark: "github-dark" } },
        ],
      ],
    }),
  },
  integrations: [
    react(),
    mdx({ extendMarkdownConfig: true, syntaxHighlight: false }),
  ],
  vite: {
    plugins: [
      tailwindcss(),
      {
        name: "nexus-local-docs-redirect",
        enforce: "post",
        configureServer: redirectLocalDocs,
        configurePreviewServer: redirectLocalDocs,
      },
    ],
  },
});
