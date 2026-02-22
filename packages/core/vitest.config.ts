import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    dangerouslyIgnoreUnhandledErrors: true,
    environment: "node", // 或 'jsdom' 如果需要
    coverage: {
      provider: "v8", // 或 'istanbul'
      reporter: ["text", "json", "html"],
      exclude: [
        "src/errors/**",
        "src/logger.ts",
        "src/utils/test-utils.ts",
        "src/transport/index.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
