import type { PlaywrightTestConfig } from "@playwright/test";
import { fixtureOrigins } from "./harness/targets";

const hostDirectory = "tests/browser/host";
const hostOrigins = [
  [fixtureOrigins.main, 4173],
  [fixtureOrigins.child, 4174],
  [fixtureOrigins.negative, 4175],
] as const;

export const hostServers: NonNullable<PlaywrightTestConfig["webServer"]> =
  hostOrigins.map(([origin, port]) => ({
    command: `pnpm exec vite ${hostDirectory} --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/host.html`,
    reuseExistingServer: !process.env.CI,
  }));
