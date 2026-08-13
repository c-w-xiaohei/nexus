import { defineConfig } from "vite";
import path from "path";
import reactSwc from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [reactSwc()],
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "NexusChromeAdapter",
      formats: ["es", "cjs"],
      fileName: (format) => `index.${format === "es" ? "mjs" : "cjs"}`,
    },
    rollupOptions: {
      external: ["@nexus-js/core"],
      output: {
        globals: {
          "@nexus-js/core": "NexusCore",
        },
      },
    },
  },
});
