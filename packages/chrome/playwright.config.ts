import { defineConfig } from "@playwright/test";
import { hostServers } from "./tests/browser/host-server.config";

export default defineConfig({
  fullyParallel: false,
  workers: 1,
  retries: 0,
  testDir: "tests/browser",
  use: {
    channel: "chromium",
    video: "off",
  },
  webServer: hostServers,
  projects: [
    {
      name: "foundation-normal",
      testMatch: /contract\/.*\.spec\.ts/,
    },
    {
      name: "worker-gate",
      testMatch: /worker\/termination\.spec\.ts/,
      grep: /@worker-gate/,
    },
    {
      name: "normal",
      testMatch: /normal\/.*\.spec\.ts/,
    },
    {
      name: "worker",
      testMatch: /worker\/.*\.spec\.ts/,
      grepInvert: /@worker-gate/,
    },
    {
      name: "worker-p0",
      testMatch: /worker\/.*\.spec\.ts/,
      grep: /@worker-p0/,
      grepInvert: /@worker-gate/,
    },
  ],
});
