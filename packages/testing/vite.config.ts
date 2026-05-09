import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dts from "vite-plugin-dts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      exclude: ["**/*.test.ts", "vite.config.ts"],
      entryRoot: "src",
      rollupTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: path.resolve(dirname, "src/index.ts"),
      name: "NexusTesting",
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    rollupOptions: {
      external: ["@nexus-js/core", "neverthrow"],
      output: {
        entryFileNames: "index.mjs",
        chunkFileNames: "[name]-[hash].mjs",
      },
    },
  },
});
