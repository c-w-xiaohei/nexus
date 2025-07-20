module.exports = {
    extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
    plugins: ["@typescript-eslint"],
    parser: "@typescript-eslint/parser",
    env: {
        node: true,
        browser: true
    },
    ignorePatterns: ["dist", "node_modules"],
    root: true
}; 