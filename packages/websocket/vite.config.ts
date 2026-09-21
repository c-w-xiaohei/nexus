import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: path.resolve(import.meta.dirname, "src/index.ts"),
        server: path.resolve(import.meta.dirname, "src/server.ts"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      external: ["@nexus-js/core", "better-result", "ws", "node:http"],
    },
  },
});
