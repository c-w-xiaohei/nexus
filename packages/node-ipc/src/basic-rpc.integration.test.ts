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

  it("acquires the explicitly configured daemon socket on first connect", async () => {
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

    const service = await client
      .connect({
        target: {
          context: "node-ipc-daemon",
          appId: "test-daemon",
          instance: "default",
        },
      })
      .then((connection) => connection.get(EchoToken));

    expect(connect).toHaveBeenCalledTimes(1);
    await expect(service.echo("demand")).resolves.toBe("demand");
    daemon.close();
  });

  it("calls a daemon service over a real Unix socket", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon();
    const client = harness.createClient();

    const service = await client
      .connect({
        target: {
          context: "node-ipc-daemon",
          appId: "test-daemon",
          instance: "default",
        },
      })
      .then((connection) => connection.get(EchoToken));
    await expect(service.echo("hello")).resolves.toBe("hello");

    daemon.close();
  });

  it("roundtrips a 96 KiB Uint8Array through Core over a real Unix socket", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon();
    const client = harness.createClient();
    const service = await client
      .connect({
        target: {
          context: "node-ipc-daemon",
          appId: "test-daemon",
          instance: "default",
        },
      })
      .then((connection) => connection.get(EchoToken));
    const input = Uint8Array.from(
      { length: 96 * 1024 },
      (_, index) => (index * 31 + 7) % 256,
    );
    const expected = input.slice();

    const result = await service.echo(input);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(expected);
    expect(input).toEqual(expected);
    daemon.close();
  });
});
