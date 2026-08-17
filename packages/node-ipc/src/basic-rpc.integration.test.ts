import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  EchoToken,
  type TestHarness,
} from "./integration-test-utils";
import type { UnixSocketClientEndpoint } from "./endpoints/unix-socket-client";

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("node-ipc basic RPC integration", () => {
  it("does not connect while the client becomes ready", async () => {
    harness = await createHarness();
    let connect: ReturnType<typeof vi.spyOn> | undefined;
    const client = harness.createClient({
      onEndpointCreated(endpoint) {
        connect = vi.spyOn(endpoint as UnixSocketClientEndpoint, "connect");
      },
    });

    await client.ready();

    expect(connect).not.toHaveBeenCalled();
  });

  it("acquires the default-target daemon socket on first create", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon();
    let connect: ReturnType<typeof vi.spyOn> | undefined;
    const client = harness.createClient({
      onEndpointCreated(endpoint) {
        connect = vi.spyOn(endpoint as UnixSocketClientEndpoint, "connect");
      },
    });

    await client.ready();
    expect(connect).not.toHaveBeenCalled();

    const service = await client.create(EchoToken);

    expect(connect).toHaveBeenCalledTimes(1);
    await expect(service.echo("demand")).resolves.toBe("demand");
    daemon.close();
  });

  it("calls a daemon service over a real Unix socket", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon();
    const client = harness.createClient();

    const service = await client.create(EchoToken, {
      target: {
        context: "node-ipc-daemon",
        appId: "test-daemon",
        instance: "default",
      },
    });
    await expect(service.echo("hello")).resolves.toBe("hello");

    daemon.close();
  });
});
