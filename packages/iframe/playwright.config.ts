import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3210",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm exec vite --host 127.0.0.1 --config tests/browser/vite.config.ts",
    url: "http://127.0.0.1:3210/parent.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
