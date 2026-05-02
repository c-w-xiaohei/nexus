import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 45_000,
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3310",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        "pnpm exec vite --host 127.0.0.1 --config tests/browser/vite.config.ts --port 3310",
      url: "http://127.0.0.1:3310/host.html",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command:
        "pnpm exec vite --host 127.0.0.1 --config tests/browser/vite.config.ts --port 3311",
      url: "http://127.0.0.1:3311/child.html?frameId=health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
