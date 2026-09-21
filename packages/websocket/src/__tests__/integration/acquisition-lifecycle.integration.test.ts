import { afterEach, describe, expect, it, vi } from "vitest";
import { Nexus, Token } from "@nexus-js/core";
import type { WebSocketAdapterModel } from "../../index.js";
import { WebSocketClientEndpoint } from "../../index.js";
import { WebSocketServerEndpoint } from "../../server.js";
import {
  createUpgradeGate,
  createRawWebSocketHost,
  createWebSocketHost,
  waitForSocketClose,
} from "./fixtures.js";

type Facts = { readonly subject: string; readonly tenant: string };
type EchoService = { echo(value: string): Promise<string> };

const EchoToken = new Token<EchoService, WebSocketAdapterModel<Facts>>(
  "websocket:integration:acquisition-echo",
);

describe("WebSocket acquisition and late-upgrade lifecycle", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "WebSocket fixture cleanup failed");
  });

  it("coalesces concurrent Core connects and keeps the non-cancelled caller on one socket", async () => {
    const gate = createUpgradeGate();
    const endpoint = new WebSocketServerEndpoint<Facts>();
    const server = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
      providers: [
        {
          token: EchoToken,
          service: { echo: async (value: string) => `echo:${value}` },
        },
      ],
    });
    await server.ready();
    const host = await createWebSocketHost(
      endpoint,
      { subject: "alice", tenant: "one" },
      { upgradeGate: gate },
    );
    cleanup.push(async () => {
      endpoint.close();
      await host.close();
    });

    const clientEndpoint = new WebSocketClientEndpoint({
      protocols: ["nexus-test.v1"],
    });
    cleanup.push(async () => clientEndpoint.close());
    const client = new Nexus<WebSocketAdapterModel>().configure({
      endpoint: {
        meta: { context: "websocket-client" },
        implementation: clientEndpoint,
      },
    });
    await client.ready();
    const target = { context: "websocket-server" as const, url: host.url };
    const clientDisconnected = Promise.withResolvers<void>();
    const cancelled = new globalThis.AbortController();
    const first = client.safeConnect({
      target,
      signal: cancelled.signal,
    });
    const second = client.safeConnect({ target });

    await gate.entered;
    cancelled.abort();
    await expect(first).resolves.toMatchObject({
      error: { code: "E_ABORTED" },
    });
    gate.release();

    const connected = await second;
    expect(connected.isOk()).toBe(true);
    if (connected.isErr()) throw connected.error;
    const connection = connected.value;
    connection.onDisconnected(() => clientDisconnected.resolve());
    expect(await connection.get(EchoToken).echo("usable")).toBe("echo:usable");
    expect(host.upgradeCount).toBe(1);
    expect(host.sockets.size).toBe(1);
    expect(connection.connectionMeta).toMatchObject({
      role: "client",
      selectedUrl: `${host.url}/`,
      protocol: "nexus-test.v1",
    });
    clientEndpoint.close();
    await clientDisconnected.promise;
    expect(connection.status).toBe("disconnected");
  });

  it("does not deliver a Port when endpoint close wins before a gated Upgrade is released", async () => {
    const gate = createUpgradeGate();
    const clientEndpoint = new WebSocketClientEndpoint({
      connectTimeoutMs: 5_000,
    });
    const host = await createRawWebSocketHost(() => {}, {
      upgradeGate: gate,
    });
    cleanup.push(async () => clientEndpoint.close());
    cleanup.push(host.close);
    const rawSocketPromise = gate.entered.then(() => [...host.rawSockets][0]!);
    const pending = clientEndpoint.connect({
      context: "websocket-server",
      url: `${host.url}/rpc?tenant=one`,
    });
    const result = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await gate.entered;
    const rawSocket = await rawSocketPromise;
    clientEndpoint.close();
    gate.release();
    expect(await result).toMatchObject({
      code: "E_WEBSOCKET_ENDPOINT_CLOSED",
    });
    await waitForSocketClose(rawSocket);
    expect(host.sockets.size).toBe(0);
    expect(host.rawSockets.size).toBe(0);
  });

  it("fails a native dial at its deadline and ignores the late gated Upgrade", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const gate = createUpgradeGate();
      const clientEndpoint = new WebSocketClientEndpoint({
        connectTimeoutMs: 1_000,
      });
      const host = await createRawWebSocketHost(() => {}, {
        upgradeGate: gate,
      });
      cleanup.push(async () => clientEndpoint.close());
      cleanup.push(host.close);
      const pending = clientEndpoint.connect({
        context: "websocket-server",
        url: host.url,
      });
      let settled = false;
      const result = pending.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await gate.entered;
      expect(host.rawSockets.size).toBe(1);
      const rawSocket = [...host.rawSockets][0];
      expect(rawSocket).toBeDefined();
      if (!rawSocket) throw new Error("Upgrade raw socket was not tracked");
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      expect(host.rawSockets.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({
        code: "E_WEBSOCKET_CONNECTION_FAILED",
      });
      gate.release();
      await waitForSocketClose(rawSocket);
      expect(host.sockets.size).toBe(0);
      expect(host.rawSockets.size).toBe(0);
      clientEndpoint.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
