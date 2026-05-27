import { defineConfig } from "vitest/config";
import dts from "vite-plugin-dts";
import reactSwc from "@vitejs/plugin-react-swc";
import path from "path";

const externalPackages = ["react", "react-dom", "@nexus-js/core"];

const isExternalDependency = (id: string) => {
  return externalPackages.some(
    (packageName) => id === packageName || id.startsWith(`${packageName}/`),
  );
};

export default defineConfig({
  plugins: [
    reactSwc(),
    dts({
      insertTypesEntry: true,
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
    }),
  ],
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "NexusReact",
      formats: ["es", "cjs"],
      fileName: (format) => `index.${format === "es" ? "mjs" : "js"}`,
    },
    rollupOptions: {
      external: isExternalDependency,
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          "@nexus-js/core": "NexusCore",
          "@nexus-js/core/state": "NexusCoreState",
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "integration/**/*.test.ts",
      "integration/**/*.test.tsx",
    ],
  },
});
