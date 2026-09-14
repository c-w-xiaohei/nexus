import { describe, expect, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { Token } from "./token";
import { createMockPortPair } from "@/utils/test-utils";
import type { IPort } from "@/transport/types/port";
import { NexusEndpointConnectError } from "@/errors";

interface Model {
  contextMeta: { context: string; ready?: boolean };
  connectionMeta: object;
  connectionTarget: { context: string };
}

describe("Connection resources", () => {
  it("rejects a zero acquisition timeout", async () => {
    const nexus = new Nexus<Model>();

    await expect(nexus.connect({ timeout: 0 })).rejects.toMatchObject({
      code: "E_USAGE_INVALID",
    });
  });

  it("returns the first definite multicast failure without waiting for an earlier target", async () => {
    let rejectSlow!: (error: Error) => void;
    const slow = new Promise<never>((_, reject) => {
      rejectSlow = reject;
    });
    const nexus = new Nexus<Model>().configure({
      endpoint: {
        meta: { context: "client" },
        implementation: {
          listen: () => {},
          connect: (target) =>
            target.context === "slow"
              ? slow
              : Promise.reject(new NexusEndpointConnectError("fast failure")),
        },
      },
    });
    try {
      const result = await nexus.safeConnectMulticast({
        targets: [{ context: "slow" }, { context: "fast" }],
        timeout: 100,
      });
      expect(result).toMatchObject({
        error: {
          code: "E_ENDPOINT_CONNECT_FAILED",
          context: { target: { context: "fast" } },
        },
      });
    } finally {
      rejectSlow(new NexusEndpointConnectError("late failure"));
    }
  });
  it("does not dial for passive acquisition or an already aborted request", async () => {
    const connect = vi.fn();
    const nexus = new Nexus<Model>().configure({
      endpoint: {
        meta: { context: "client" },
        implementation: { listen: () => {}, connect },
      },
    });
    await nexus.ready();
    expect(await nexus.safeConnect({ timeout: 10 })).toMatchObject({
      error: { code: "E_SERVICE_ACQUISITION_TIMEOUT" },
    });
    expect((await nexus.connectMulticast()).connections).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    expect(
      await nexus.safeConnect({
        target: { context: "host" },
        signal: controller.signal,
      }),
    ).toMatchObject({ error: { code: "E_ABORTED" } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("shares session handles, preserves fixed members, and observes every identity commit", async () => {
    const token = new Token<{
      read(): string;
      fail(): never;
      readonly title: string;
    }>("read");
    const read = vi.fn(() => "client");
    const [clientPort, hostPort] = createMockPortPair();
    let accept!: (port: IPort, meta: object) => void;
    const host = new Nexus<Model>().configure({
      endpoint: {
        meta: { context: "host" },
        implementation: {
          listen: (handler) => {
            accept = handler;
          },
        },
      },
    });
    const connected = vi.fn();
    const firstReady = vi.fn();
    host.onConnect(connected);
    host.onConnect((meta) => meta.ready === true, firstReady);
    await host.ready();
    expect((await host.connectMulticast()).connections).toHaveLength(0);
    const waiting = host.connect({ timeout: 1000 });
    const client = new Nexus<Model>().configure({
      endpoint: {
        meta: { context: "client" },
        implementation: {
          listen: () => {},
          connect: async () => {
            accept(hostPort, {});
            return { port: clientPort, connectionMeta: {} };
          },
        },
        connectTo: [{ context: "host" }],
      },
      providers: [
        {
          token,
          service: {
            read,
            title: "client",
            fail() {
              throw Object.assign(new Error("business"), {
                code: "E_AUTH_CALL_DENIED",
                origin: "framework",
              });
            },
          },
        },
      ],
    });
    try {
      const connection = await waiting;
      for (const options of [new Date(), new Map(), new (class Options {})()]) {
        expect(connection.safeGet(token, options as never)).toMatchObject({
          error: { code: "E_USAGE_INVALID" },
        });
      }
      expect(connection.safeGet(token, { callTimeout: 0 })).toMatchObject({
        error: { code: "E_USAGE_INVALID" },
      });
      expect(connection.safeGet(token, Object.create(null)).isOk()).toBe(true);
      expect(connected).toHaveBeenCalledExactlyOnceWith(connection);
      expect(await host.connect()).toBe(connection);
      const collection = await host.connectMulticast();
      expect(collection.connections).toEqual([connection]);
      const service = collection.get(token)[0].result.unwrap();
      const task = service.read();
      expect(task.connection).toBe(connection);
      expect(read).not.toHaveBeenCalled();
      expect(await task).toBe("client");
      expect(await Nexus.safeCall(task)).toMatchObject({ value: "client" });
      expect(read).toHaveBeenCalledTimes(1);
      expect(await Nexus.safeCall(service.title)).toMatchObject({
        value: "client",
      });
      expect(await Nexus.safeCall(service.fail())).toMatchObject({
        error: { code: "E_REMOTE_EXCEPTION" },
      });
      expect(collection.get(new Token("missing"))[0].result).toMatchObject({
        error: { code: "E_SERVICE_UNAVAILABLE" },
      });
      const identities: unknown[] = [];
      connection.subscribeIdentity((meta) => identities.push(meta));
      let committed!: () => void;
      const next = () =>
        new Promise<void>((resolve) => {
          committed = resolve;
        });
      connection.subscribeIdentity(() => committed?.());
      for (let i = 0; i < 2; i++) {
        const update = next();
        await client.updateIdentity({ ready: true });
        await update;
      }
      expect(identities).toEqual([
        { context: "client" },
        { context: "client", ready: true },
        { context: "client", ready: true },
      ]);
      expect(identities.every(Object.isFrozen)).toBe(true);
      expect(connected).toHaveBeenCalledTimes(1);
      expect(firstReady).toHaveBeenCalledExactlyOnceWith(connection);
      const disconnected = vi.fn();
      const duplicate = vi.fn();
      const stopDuplicate = connection.onDisconnected(duplicate);
      connection.onDisconnected(duplicate);
      stopDuplicate();
      connection.onDisconnected(disconnected);
      connection.disconnect();
      connection.disconnect();
      expect(disconnected).toHaveBeenCalledExactlyOnceWith("local");
      expect(duplicate).toHaveBeenCalledExactlyOnceWith("local");
      expect(connection.status).toBe("disconnected");
      expect(await Nexus.safeCall(service.read())).toMatchObject({
        error: { code: "E_CONN_CLOSED" },
      });
      expect(collection.connections).toEqual([connection]);
      expect(collection.get(token)[0].result).toMatchObject({
        error: { code: "E_CONN_CLOSED" },
      });
      expect((await host.connectMulticast()).connections).toHaveLength(0);
      const late = vi.fn();
      connection.onDisconnected(late);
      expect(late).toHaveBeenCalledExactlyOnceWith("local");
    } finally {
      clientPort.close();
    }
  });
});
