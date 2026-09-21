import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "@nexus-js/core/state": path.resolve(
        import.meta.dirname,
        "../../../core/dist/state/index.mjs",
      ),
      "@nexus-js/core": path.resolve(
        import.meta.dirname,
        "../../../core/dist/index.mjs",
      ),
      "@nexus-js/websocket": path.resolve(
        import.meta.dirname,
        "../../dist/index.mjs",
      ),
    },
  },
});
