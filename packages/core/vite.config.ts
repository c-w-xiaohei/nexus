import { defineConfig } from "vite";
import path from "path";
import reactSwc from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [
    reactSwc(), // 使用 SWC 进行编译
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"), // 配置 @ 符号指向 src 目录
    },
  },
  build: {
    rollupOptions: {
      // better-result is ESM-only; bundle it so the CJS entry remains require-able.
      external: [],
    },
    lib: {
      entry: {
        index: path.resolve(__dirname, "src/index.ts"),
        "internal/serializer-benchmark": path.resolve(
          __dirname,
          "src/transport/serializers/serializer-benchmark.ts",
        ),
        "state/index": path.resolve(__dirname, "src/state/index.ts"),
        "relay/index": path.resolve(__dirname, "src/relay/index.ts"),
        "transport/index": path.resolve(__dirname, "src/transport/index.ts"),
        "transport/virtual-port/index": path.resolve(
          __dirname,
          "src/transport/virtual-port/index.ts",
        ),
      },
      name: "NexusCore",
      formats: ["es", "cjs"], // Explicitly output ES Module and CommonJS
      fileName: (format, entryName) =>
        `${entryName}.${format === "es" ? "mjs" : "cjs"}`,
    },
  },
});
