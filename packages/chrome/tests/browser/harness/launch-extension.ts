import { chromium, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputDirectory } from "../build-extension";

export interface ExtensionLaunch {
  readonly context: BrowserContext;
  readonly userDataDir: string;
  readonly extensionId: string;
}

export async function launchExtension(): Promise<ExtensionLaunch> {
  const userDataDir = await mkdtemp(join(tmpdir(), "nexus-chrome-e2e-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${outputDirectory}`,
        `--load-extension=${outputDirectory}`,
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 5_000 }));
    const extensionId = new URL(worker.url()).host;
    return {
      context,
      userDataDir,
      extensionId,
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}
