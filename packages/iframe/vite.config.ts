import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dts from "vite-plugin-dts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [dts({ exclude: ["**/*.test.ts"], insertTypesEntry: true })],
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "NexusIframeAdapter",
      fileName: (format) => `index.${format === "es" ? "mjs" : "js"}`,
    },
    rollupOptions: {
      external: [
        "@nexus-js/core",
        "@nexus-js/core/transport/virtual-port",
        "neverthrow",
      ],
      output: {
        globals: {
          "@nexus-js/core": "NexusCore",
          "@nexus-js/core/transport/virtual-port": "NexusVirtualPort",
        },
      },
    },
  },
});
