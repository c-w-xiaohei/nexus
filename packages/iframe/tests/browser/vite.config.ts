import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  server: {
    host: "127.0.0.1",
    port: 3210,
    strictPort: true,
    fs: {
      allow: [
        path.resolve(__dirname, "../../.."),
        path.resolve(__dirname, "../../../.."),
      ],
    },
  },
  resolve: {
    alias: {
      "@nexus-js/iframe": path.resolve(__dirname, "../../dist/index.mjs"),
      "@nexus-js/core/transport/virtual-port": path.resolve(
        __dirname,
        "../../../core/dist/transport/virtual-port/index.mjs",
      ),
      "@nexus-js/core": path.resolve(__dirname, "../../../core/dist/index.mjs"),
    },
  },
});
