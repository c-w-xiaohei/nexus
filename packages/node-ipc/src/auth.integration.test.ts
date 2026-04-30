import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("node-ipc auth integration", () => {
  it("authenticates a client with the daemon shared secret", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon({
      authToken: "secret",
      policy: {
        canConnect: ({ platform }) => platform.authenticated === true,
      },
    });
    const client = harness.createClient({ authToken: "secret" });

    const service = await client.create(EchoToken, { target: {} });
    await expect(service.echo("authorized")).resolves.toBe("authorized");

    daemon.close();
  });

  it("rejects clients with the wrong shared secret", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon({ authToken: "secret" });
    const client = harness.createClient({ authToken: "wrong" });

    await expect(
      client.create(EchoToken, { target: {} }),
    ).rejects.toMatchObject({
      cause: {
        context: {
          originalError: expect.objectContaining({ code: "E_IPC_AUTH_FAILED" }),
        },
      },
    });

    daemon.close();
  });

  it("allows core canConnect to admit authenticated clients", async () => {
    harness = await createHarness();
    const canConnect = vi.fn(({ platform }) => platform.authenticated === true);
    const daemon = await harness.startDaemon({
      authToken: "secret",
      policy: { canConnect },
    });
    const client = harness.createClient({ authToken: "secret" });

    const service = await client.create(EchoToken, { target: {} });
    await expect(service.echo("connect-ok")).resolves.toBe("connect-ok");
    expect(canConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "incoming",
        platform: expect.objectContaining({
          authenticated: true,
          authMethod: "shared-secret",
          socket: harness.address,
        }),
      }),
    );

    daemon.close();
  });

  it("allows core canConnect to deny unauthenticated clients", async () => {
    harness = await createHarness();
    const daemon = await harness.startDaemon({
      policy: { canConnect: ({ platform }) => platform.authenticated === true },
    });
    const client = harness.createClient();

    await expect(
      client.create(EchoToken, { target: {} }),
    ).rejects.toMatchObject({
      code: "E_AUTH_CONNECT_DENIED",
    });

    daemon.close();
  });

  it("allows core canCall to admit service calls", async () => {
    harness = await createHarness();
    const canCall = vi.fn(() => true);
    const daemon = await harness.startDaemon({ policy: { canCall } });
    const client = harness.createClient();

    const service = await client.create(EchoToken, { target: {} });
    await expect(service.echo("call-ok")).resolves.toBe("call-ok");
    expect(canCall).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: EchoToken.id,
        path: ["echo"],
        operation: "APPLY",
      }),
    );

    daemon.close();
  });

  it("allows core canCall to deny service calls before invocation", async () => {
    harness = await createHarness();
    const echo = vi.fn((input: string) => input);
    const daemon = await harness.startDaemon({
      policy: { canCall: () => false },
      service: { echo },
    });
    const client = harness.createClient();

    const service = await client.create(EchoToken, { target: {} });
    await expect(service.echo("blocked")).rejects.toMatchObject({
      context: {
        remoteError: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
      },
    });
    expect(echo).not.toHaveBeenCalled();

    daemon.close();
  });
});
