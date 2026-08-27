import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { launchExtension } from "../harness/launch-extension";

test("launches the generated MV3 fixture with a fresh temporary profile", async () => {
  const launch = await launchExtension();
  let primaryError: unknown;
  try {
    expect(launch.extensionId).toMatch(/^[a-p]{32}$/);
    expect(launch.userDataDir.startsWith(tmpdir())).toBe(true);

    const worker = launch.context.serviceWorkers()[0];
    expect(worker).toBeDefined();
    const storage = await worker!.evaluate(async () => ({
      local: await chrome.storage.local.get(),
      session: await chrome.storage.session.get(),
    }));
    expect(Object.keys(storage.local).filter(isFixtureKey)).toEqual([]);
    expect(Object.keys(storage.session).filter(isFixtureKey)).toEqual([]);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await launch.context.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(launch.userDataDir, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== undefined) {
    if (cleanupErrors.length === 0) throw primaryError;
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Fixture assertion and cleanup failed",
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Fixture cleanup failed");
  }
});

function isFixtureKey(key: string): boolean {
  return key.startsWith("nexus-e2e:");
}
