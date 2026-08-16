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

describe("node-ipc disconnect integration", () => {
  it("keeps proxies session-bound across daemon close and recreate", async () => {
    harness = await createHarness();
    const firstDaemon = await harness.startDaemon();
    const firstClient = harness.createClient();
    const oldService = await firstClient.create(EchoToken, {
      target: {
        context: "node-ipc-daemon",
        appId: "test-daemon",
        instance: "default",
      },
    });
    await expect(oldService.echo("before-close")).resolves.toBe("before-close");

    firstDaemon.close();
    await expect(oldService.echo("after-close")).rejects.toBeTruthy();

    const secondDaemon = await harness.startDaemon();
    const secondClient = harness.createClient();
    const newService = await secondClient.create(EchoToken, {
      target: {
        context: "node-ipc-daemon",
        appId: "test-daemon",
        instance: "default",
      },
    });
    await expect(newService.echo("after-restart")).resolves.toBe(
      "after-restart",
    );

    secondDaemon.close();
  });

  it("reuses one connection for concurrent requests with the same target", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon();
    const client = harness.createClient();
    const target = {
      context: "node-ipc-daemon" as const,
      appId: "test-daemon",
      instance: "default",
    };

    const [first, second] = await Promise.all([
      client.create(EchoToken, { target }),
      client.create(EchoToken, { target }),
    ]);

    await expect(first.echo("first")).resolves.toBe("first");
    await expect(second.echo("second")).resolves.toBe("second");
    daemon.close();
  });

  it("connects once when concurrent requests mix omitted and explicit default instances", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon();
    let connect: ReturnType<typeof vi.spyOn> | undefined;
    const client = harness.createClient({
      onEndpointCreated(endpoint) {
        connect = vi.spyOn(endpoint as UnixSocketClientEndpoint, "connect");
      },
    });

    await Promise.all([
      client.create(EchoToken),
      client.create(EchoToken, {
        target: {
          context: "node-ipc-daemon",
          appId: "test-daemon",
          instance: "default",
        },
      }),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
    daemon.close();
  });

  it("does not reuse a ready connection after its resolver stops resolving the target", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon();
    let resolveTarget = true;
    const client = harness.createClient({
      resolveAddress: () => (resolveTarget ? harness!.address : null),
    });
    const target = {
      context: "node-ipc-daemon" as const,
      appId: "test-daemon",
      instance: "default",
    };

    const service = await client.create(EchoToken, { target });
    await expect(service.echo("before-failure")).resolves.toBe(
      "before-failure",
    );

    resolveTarget = false;
    await expect(client.create(EchoToken, { target })).rejects.toMatchObject({
      cause: {
        context: {
          originalError: expect.objectContaining({
            code: "E_IPC_ADDRESS_INVALID",
          }),
        },
      },
    });
    daemon.close();
  });
});
