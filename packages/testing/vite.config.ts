import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dts from "vite-plugin-dts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      exclude: ["**/*.test.ts"],
    }),
  ],
  build: {
    lib: {
      entry: path.resolve(dirname, "src/index.ts"),
      name: "NexusTesting",
      formats: ["es", "cjs"],
      fileName: (format) => `index.${format === "es" ? "mjs" : "js"}`,
    },
    rollupOptions: {
      external: ["@nexus-js/core", "neverthrow"],
      output: {
        globals: {
          "@nexus-js/core": "NexusCore",
          neverthrow: "neverthrow",
        },
      },
    },
  },
});
