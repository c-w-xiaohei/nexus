import { afterEach, describe, expect, it } from "vitest";
import {
  createHarness,
  EchoToken,
  type TestHarness,
} from "./integration-test-utils";

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("node-ipc disconnect integration", () => {
  it("keeps proxies session-bound across daemon close and recreate", async () => {
    harness = await createHarness();
    const firstDaemon = await harness.startDaemon();
    const firstClient = harness.createClient();
    const oldService = await firstClient.create(EchoToken, { target: {} });
    await expect(oldService.echo("before-close")).resolves.toBe("before-close");

    firstDaemon.close();
    await expect(oldService.echo("after-close")).rejects.toBeTruthy();

    const secondDaemon = await harness.startDaemon();
    const secondClient = harness.createClient();
    const newService = await secondClient.create(EchoToken, { target: {} });
    await expect(newService.echo("after-restart")).resolves.toBe(
      "after-restart",
    );

    secondDaemon.close();
  });
});
