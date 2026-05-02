import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3310,
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
      "@nexus-js/core/state": path.resolve(
        __dirname,
        "../../../core/dist/state/index.mjs",
      ),
      "@nexus-js/core/transport/virtual-port": path.resolve(
        __dirname,
        "../../../core/dist/transport/virtual-port/index.mjs",
      ),
      "@nexus-js/core": path.resolve(__dirname, "../../../core/dist/index.mjs"),
      "@nexus-js/iframe": path.resolve(
        __dirname,
        "../../../iframe/dist/index.mjs",
      ),
      "@nexus-js/react": path.resolve(__dirname, "../../dist/index.mjs"),
    },
  },
});
