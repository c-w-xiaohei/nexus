import { defineConfig } from "vite";
import path from "path";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
    }),
  ],
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
        "neverthrow",
      ],
      output: {
        globals: {
          "@nexus-js/core": "NexusCore",
        },
      },
    },
  },
});
