import type { PlaywrightTestConfig } from "@playwright/test";
import { fixtureOrigins } from "./harness/targets";

const hostDirectory = "tests/browser/host";

export const hostServers: NonNullable<PlaywrightTestConfig["webServer"]> = [
  {
    command: `pnpm exec vite ${hostDirectory} --host 127.0.0.1 --port 4173 --strictPort`,
    url: `${fixtureOrigins.main}/host.html`,
    reuseExistingServer: !process.env.CI,
  },
  {
    command: `pnpm exec vite ${hostDirectory} --host 127.0.0.1 --port 4174 --strictPort`,
    url: `${fixtureOrigins.child}/host.html`,
    reuseExistingServer: !process.env.CI,
  },
  {
    command: `pnpm exec vite ${hostDirectory} --host 127.0.0.1 --port 4175 --strictPort`,
    url: `${fixtureOrigins.negative}/host.html`,
    reuseExistingServer: !process.env.CI,
  },
];
