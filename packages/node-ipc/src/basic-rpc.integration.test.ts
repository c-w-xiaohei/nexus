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

describe("node-ipc basic RPC integration", () => {
  it("calls a daemon service over a real Unix socket", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon();
    const client = harness.createClient();

    const service = await client.create(EchoToken, { target: {} });
    await expect(service.echo("hello")).resolves.toBe("hello");

    daemon.close();
  });
});
