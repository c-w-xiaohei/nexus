import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  EchoToken,
  type TestHarness,
} from "./integration-test-utils";
import type { UnixSocketClientEndpoint } from "./endpoints/unix-socket-client";
import { Nexus, Token } from "@nexus-js/core";
import { usingNodeIpcClient } from "./factory";
import { UnixSocketServerEndpoint } from "./endpoints/unix-socket-server";
import type { NodeIpcAdapterModel } from "./types/meta";

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

  it.each([false, true])(
    "selects a later-started child after its startup dial (live provider=%s)",
    async (liveProvider) => {
      harness = await createHarness();
      const ownerEndpoint = new UnixSocketServerEndpoint(harness.address);
      const token = new Token<{ getId(): string }>("child-owned-service");
      const service = { getId: () => "child-B" };
      let releaseAuthorization!: (allowed: boolean) => void;
      let enteredAuthorization!: () => void;
      const authorizationEntered = new Promise<void>((resolve) => {
        enteredAuthorization = resolve;
      });
      const authorization = new Promise<boolean>((resolve) => {
        releaseAuthorization = resolve;
      });
      const owner = new Nexus<NodeIpcAdapterModel>().configure({
        endpoint: {
          implementation: ownerEndpoint,
          meta: {
            context: "node-ipc-daemon",
            appId: "owner-A",
            instance: "default",
            pid: process.pid,
          },
        },
        policy: {
          canConnect: () => {
            enteredAuthorization();
            return authorization;
          },
        },
      });
      try {
        await owner.ready();
        expect(await owner.safeSelect(token)).toMatchObject({
          error: { code: "E_SERVICE_NO_MATCH" },
        });
        let selected = false;
        const waiting = owner
          .select(token, {
            where: (meta: NodeIpcAdapterModel["contextMeta"]) =>
              meta.appId === "child-B",
            wait: { timeout: 2_000 },
          })
          .then((proxy) => {
            selected = true;
            return proxy;
          });

        // A owns creation; B starts later and dials A without acquiring any A service.
        const config = usingNodeIpcClient({
          configure: false,
          appId: "child-B",
          resolveAddress: () => harness!.address,
          connectTo: [{ context: "node-ipc-daemon", appId: "owner-A" }],
          providers: liveProvider ? [] : [{ token, service }],
        });
        const connect = vi.spyOn(config.endpoint!.implementation!, "connect");
        const child = new Nexus<NodeIpcAdapterModel>().configure(config);
        await authorizationEntered;
        await child.ready();
        expect(selected).toBe(false);
        releaseAuthorization(true);

        if (liveProvider) {
          // where observes published identity even before this Token is provided.
          let observed!: () => void;
          const seen = new Promise<void>((resolve) => {
            observed = resolve;
          });
          const controller = new AbortController();
          const observer = owner.safeSelect(token, {
            where: (meta: NodeIpcAdapterModel["contextMeta"]) => {
              if (meta.appId === "child-B") observed();
              return true;
            },
            wait: { signal: controller.signal, timeout: 2_000 },
          });
          await seen;
          expect(selected).toBe(false);
          controller.abort();
          expect(await observer).toMatchObject({
            error: { code: "E_ABORTED" },
          });
          child.provide(token, service);
        }
        const proxy = await waiting;
        expect(await proxy.getId()).toBe("child-B");
        expect(connect).toHaveBeenCalledOnce();
        expect(
          await child.safeCreate(new Token<object>("no-default")),
        ).toMatchObject({ error: { code: "E_TARGET_REQUIRED" } });
      } finally {
        releaseAuthorization(true);
        ownerEndpoint.close();
      }
    },
  );
});
