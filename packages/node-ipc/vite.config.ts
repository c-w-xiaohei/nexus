import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "NexusNodeIpcAdapter",
      fileName: (format) => `index.${format === "es" ? "mjs" : "js"}`,
    },
    rollupOptions: {
      external: [
        "@nexus-js/core",
        "node:fs",
        "node:fs/promises",
        "node:net",
        "node:os",
        "node:path",
        "better-result",
      ],
      output: {
        globals: {
          "@nexus-js/core": "NexusCore",
        },
      },
    },
  },
});
