import tseslint from "typescript-eslint";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";
import vitest from "eslint-plugin-vitest";

export default tseslint.config(
  // Global ignores
  { ignores: ["**/dist/", "**/test-results/", "node_modules"] },

  // Base config for all TS files
  ...tseslint.configs.recommended,

  // Custom rules for all TS files
  {
    rules: {
      "no-undef": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-namespace": "off",
      "prefer-const": "off",
    },
  },

  // Environment for 'core' package (hybrid node/browser/worker)
  {
    files: ["packages/core/**/*.{ts,mjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
        Transferable: "readonly",
      },
    },
  },

  // Environment for 'chrome-adapter' package
  {
    files: ["packages/chrome/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.webextensions,
      },
    },
  },

  // Environment for 'react' package (browser runtime, node build config)
  {
    files: ["packages/react/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  // Environment for 'iframe' package (browser runtime, node build config)
  {
    files: ["packages/iframe/**/*.ts", "packages/iframe/vite.config.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        EventListener: "readonly",
        Transferable: "readonly",
      },
    },
  },

  // Environment for 'node-ipc' package (Node runtime and tests)
  {
    files: ["packages/node-ipc/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
        NodeJS: "readonly",
      },
    },
  },

  // Vitest config
  {
    files: ["**/*.test.ts"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/expect-expect": [
        "error",
        {
          assertFunctionNames: ["expect", "expectTypeOf"],
        },
      ],
    },
  },

  // Prettier config must be last
  eslintConfigPrettier,
);
