import { describe, expect, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { Token } from "./token";
import { createMockPortPair } from "@/utils/test-utils";
import type { IPort } from "@/transport/types/port";
import { NexusEndpointConnectError } from "@/errors";
import { configureNexusLogger, resetNexusLoggerForTest } from "@/logger";

interface Model {
  contextMeta: { context: string; ready?: boolean };
  connectionMeta: object;
  connectionTarget: { context: string };
}

describe("Connection resources", () => {
  it("hands pre-bootstrap observers to live availability without duplicate or cancelled delivery", async () => {
    const host = new Nexus<Model>();
    const [clientPort, hostPort] = createMockPortPair();
    let finishListen!: () => void;
    let accept!: (port: IPort, meta: object) => void;
    let listening!: () => void;
    const started = new Promise<void>((resolve) => {
      listening = resolve;
    });
    const cancelled = vi.fn();
    const stopCancelled = host.onConnect(cancelled);
    stopCancelled();
    const sibling = vi.fn();
    let stopSibling = () => {};
    const nested = vi.fn();
    const first = vi.fn(() => {
      stopSibling();
      host.onConnect(nested);
    });
    const stopFirst = host.onConnect(first);
    stopSibling = host.onConnect(sibling);
    const matched = vi.fn();
    let stopMatched = () => {};
    stopMatched = host.onConnect((meta) => {
      if (meta.ready) stopMatched();
      return meta.ready === true;
    }, matched);
    host.configure({
      endpoint: {
        meta: { context: "host" },
        implementation: {
          listen(handler) {
            accept = handler;
            listening();
            return new Promise<void>((resolve) => {
              finishListen = resolve;
            });
          },
        },
      },
    });
    const hostReady = host.ready();
    await started;
    const client = new Nexus<Model>().configure({
      endpoint: {
        meta: { context: "client" },
        implementation: {
          listen() {},
          connect() {
            accept(hostPort, {});
            return { port: clientPort, connectionMeta: {} };
          },
        },
      },
    });
    try {
      // Handshake finishes while host listener startup is still pending.
      await client.connect({ target: { context: "host" } });
      expect(first).not.toHaveBeenCalled();
      finishListen();
      await hostReady;
      const connection = await host.connect();
      expect(first).toHaveBeenCalledExactlyOnceWith(connection);
      expect(nested).toHaveBeenCalledExactlyOnceWith(connection);
      expect(sibling).not.toHaveBeenCalled();
      expect(cancelled).not.toHaveBeenCalled();
      const updated = new Promise<void>((resolve) => {
        connection.subscribeIdentity((meta) => {
          if (meta.ready) resolve();
        });
      });
      await client.updateIdentity({ ready: true });
      await updated;
      expect(matched).not.toHaveBeenCalled();
      expect(first).toHaveBeenCalledOnce();
      expect(nested).toHaveBeenCalledOnce();
      stopFirst();
      stopFirst();
      const later = new Promise<void>((resolve) => {
        connection.subscribeIdentity((meta) => {
          if (meta.ready === false) resolve();
        });
      });
      await client.updateIdentity({ ready: false });
      await later;
      expect(first).toHaveBeenCalledOnce();
      expect(sibling).not.toHaveBeenCalled();
      expect(cancelled).not.toHaveBeenCalled();
      expect(matched).not.toHaveBeenCalled();
    } finally {
      finishListen();
      clientPort.close();
      await hostReady;
    }
  });

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
      const unmatched = vi.fn(() => false);
      const stopUnmatched = host.onConnect(unmatched, () => {});
      expect(unmatched).toHaveBeenCalledTimes(1);
      const observerFailure = new Error("observer failed");
      const diagnostics: unknown[][] = [];
      configureNexusLogger({
        enabled: true,
        handler: (_level, _scope, _message, ...args) => {
          diagnostics.push(args);
        },
      });
      const stopFailing = connection.subscribeIdentity(() => {
        throw observerFailure;
      });
      stopFailing();
      expect(diagnostics.some((args) => args.includes(observerFailure))).toBe(
        true,
      );
      connection.onDisconnected(() => {
        throw observerFailure;
      });
      const disconnected = vi.fn();
      const duplicate = vi.fn();
      const stopDuplicate = connection.onDisconnected(duplicate);
      connection.onDisconnected(duplicate);
      stopDuplicate();
      connection.onDisconnected(disconnected);
      const cancelledDuringClose = vi.fn();
      let stopDuringClose = () => {};
      connection.onDisconnected(() => stopDuringClose());
      stopDuringClose = connection.onDisconnected(cancelledDuringClose);
      connection.disconnect();
      connection.disconnect();
      expect(unmatched).toHaveBeenCalledTimes(1);
      stopUnmatched();
      expect(disconnected).toHaveBeenCalledExactlyOnceWith("local");
      expect(duplicate).toHaveBeenCalledExactlyOnceWith("local");
      expect(cancelledDuringClose).not.toHaveBeenCalled();
      expect(
        diagnostics.some(
          (args) => Array.isArray(args[0]) && args[0].includes(observerFailure),
        ),
      ).toBe(true);
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
      resetNexusLoggerForTest();
      clientPort.close();
    }
  });
});
