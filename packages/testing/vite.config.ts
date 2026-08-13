import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(dirname, "src/index.ts"),
      name: "NexusTesting",
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    rollupOptions: {
      external: ["@nexus-js/core", "better-result"],
      output: {
        entryFileNames: "index.mjs",
        chunkFileNames: "[name]-[hash].mjs",
      },
    },
  },
});
