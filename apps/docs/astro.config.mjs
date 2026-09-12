import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";
import tailwindcss from "@tailwindcss/vite";
import { rehypeCode, remarkHeading } from "fumadocs-core/mdx-plugins";

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
  vite: { plugins: [tailwindcss()] },
});
