import tseslint from "typescript-eslint";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";
import vitest from "eslint-plugin-vitest";

export default tseslint.config(
  // Global ignores
  { ignores: ["**/dist/", "node_modules"] },

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
    files: ["packages/core/**/*.ts"],
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

  // Vitest config
  {
    files: ["**/*.test.ts"],
    plugins: { vitest },
    rules: vitest.configs.recommended.rules,
  },

  // Prettier config must be last
  eslintConfigPrettier,
);
