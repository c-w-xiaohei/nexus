import { expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import { launchExtension } from "../harness/launch-extension";
import { fixtureOrigins } from "../harness/targets";
import { test as fixture } from "../harness/playwright-fixtures";

fixture(
  "loads the generated MV3 fixture into an isolated profile",
  async ({ extensionId, hostPage, waitForBarrier }) => {
    const runId = "foundation-a";
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
    await waitForBarrier(runId, "background-ready");
    await waitForBarrier(runId, "content-listener-ready without route");
    await expect(hostPage.locator("html")).toHaveAttribute(
      "data-nexus-e2e-ready",
      /^main:/,
    );
    await expect(
      hostPage.frameLocator("#alpha").locator("html"),
    ).toHaveAttribute("data-nexus-e2e-ready", /^alpha:/);
    await expect(
      hostPage.frameLocator("#beta").locator("html"),
    ).toHaveAttribute("data-nexus-e2e-ready", /^beta:/);
  },
);

fixture("uses distinct clean profiles for consecutive launches", async () => {
  const launches: Awaited<ReturnType<typeof launchExtension>>[] = [];
  let bodyFailed = false;
  try {
    launches.push(await launchExtension());
    launches.push(await launchExtension());
    expect(launches[0].userDataDir).not.toBe(launches[1].userDataDir);
    for (const launch of launches) {
      const stored = await launch.context
        .serviceWorkers()[0]
        .evaluate(() => chrome.storage.session.get());
      expect(
        Object.keys(stored).filter((key) => key.startsWith("nexus-e2e:")),
      ).toEqual([]);
    }
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    const closeResults = await Promise.allSettled(
      launches.map((launch) => launch.context.close()),
    );
    const removeResults = await Promise.allSettled(
      launches.map((launch) =>
        rm(launch.userDataDir, { recursive: true, force: true }),
      ),
    );
    const failures = [...closeResults, ...removeResults]
      .filter((result) => result.status === "rejected")
      .map((result) => (result as PromiseRejectedResult).reason);
    if (!bodyFailed && failures.length > 0) {
      throw new AggregateError(failures, "Dual-profile cleanup failed");
    }
  }
});
