import { defineConfig } from "vite";
import path from "path";
import dts from "vite-plugin-dts";
import reactSwc from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [
    reactSwc(), // 使用 SWC 进行编译
    dts({
      insertTypesEntry: true, // 为类型入口生成单独的 .d.ts 文件
      exclude: ["**/*.test.ts"],
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"), // 配置 @ 符号指向 src 目录
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "NexusCore",
      formats: ["es", "cjs"], // Explicitly output ES Module and CommonJS
      fileName: (format) => `index.${format === "es" ? "mjs" : "js"}`,
    },
  },
});
