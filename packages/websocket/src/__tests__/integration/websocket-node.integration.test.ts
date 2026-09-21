import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Nexus, Token } from "@nexus-js/core";
import {
  connectNexusStore,
  createNexusStore,
  createStoreToken,
} from "@nexus-js/core/state";
import { WebSocketClientEndpoint, usingWebSocketClient } from "../../index.js";
import { WebSocketServerEndpoint } from "../../server.js";
import type { WebSocketAdapterModel } from "../../index.js";
import {
  createRawWebSocketHost,
  createWebSocketHost,
  openWs,
  waitForClose,
} from "./fixtures.js";

type Facts = { readonly subject: string; readonly tenant: string };
type EchoService = {
  echo(value: string): Promise<string>;
  callback(value: string, listener: (value: string) => void): Promise<void>;
};
type GuardedService = { submit(value: string): Promise<string> };
type CommitService = {
  commit(id: string): Promise<number>;
  current(): Promise<number>;
};
type CounterRef = { increment(): number; current(): number };
type RefService = { counter(): Promise<CounterRef> };
type CounterState = { count: number; increment(by: number): number };

const EchoToken = new Token<EchoService, WebSocketAdapterModel<Facts>>(
  "websocket:integration:echo",
);
const GuardedToken = new Token<GuardedService, WebSocketAdapterModel<Facts>>(
  "websocket:integration:guarded",
);
const CommitToken = new Token<CommitService, WebSocketAdapterModel<Facts>>(
  "websocket:integration:commit",
);
const RefToken = new Token<RefService, WebSocketAdapterModel<Facts>>(
  "websocket:integration:ref",
);
const StateToken = createStoreToken<CounterState, WebSocketAdapterModel<Facts>>(
  "websocket:integration:state",
);

const clientOptions = { protocols: ["nexus-test.v1"] };

describe("WebSocket adapter real Node integration", () => {
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

  it("connectTo starts a real session with configured protocols, policy, and providers", async () => {
    const endpoint = new WebSocketServerEndpoint<Facts>();
    const server = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
    });
    await server.ready();
    const host = await createWebSocketHost(endpoint, {
      subject: "alice",
      tenant: "one",
    });
    cleanup.push(async () => {
      endpoint.close();
      await host.close();
    });
    let policyCalls = 0;
    const config = usingWebSocketClient({
      configure: false,
      connectTo: [{ context: "websocket-server", url: host.url }],
      protocols: ["startup-v1"],
      providers: [
        {
          token: GuardedToken,
          service: { submit: async (value: string) => `client:${value}` },
        },
      ],
      policy: {
        canConnect: ({ connection }) => {
          policyCalls += 1;
          return (
            connection.role === "client" && connection.protocol === "startup-v1"
          );
        },
      },
    });
    const client = new Nexus<WebSocketAdapterModel>().configure(config);
    cleanup.push(async () => {
      await config.endpoint?.implementation?.close?.();
    });
    await client.ready();
    // No explicit client.connect(target): this can only succeed if connectTo dialed.
    const incoming = await server.connect({ timeout: 1_000 });
    expect(await incoming.get(GuardedToken).submit("bootstrapped")).toBe(
      "client:bootstrapped",
    );
    expect(policyCalls).toBe(1);
    expect([...host.sockets].map((socket) => socket.protocol)).toEqual([
      "startup-v1",
    ]);
    const disconnected = new Promise<void>((resolve) =>
      incoming.onDisconnected(() => resolve()),
    );
    config.endpoint?.implementation?.close?.();
    await disconnected;
    expect(incoming.status).toBe("disconnected");
  });

  it("delivers an ordered binary burst once after a late listener and exact target selection", async () => {
    const packets = [1, 2, 3, 255];
    const barrier = Promise.withResolvers<void>();
    let accepted!: WebSocket;
    const host = await createRawWebSocketHost((socket) => {
      accepted = socket;
      expect(socket.protocol).toBe("nexus-test.v1");
      for (const value of packets) socket.send(Buffer.from([value]));
      socket.on("message", (message) => {
        if (Buffer.from(message as Buffer).equals(Buffer.from([99]))) {
          barrier.resolve();
          socket.close();
        }
      });
    });
    cleanup.push(host.close);
    const endpoint = new WebSocketClientEndpoint(clientOptions);
    cleanup.push(async () => endpoint.close());
    const connection = await endpoint.connect({
      context: "websocket-server",
      url: `${host.url}/rpc?tenant=one`,
    });

    expect(connection.connectionMeta).toEqual({
      role: "client",
      selectedUrl: `${host.url}/rpc?tenant=one`,
      protocol: "nexus-test.v1",
    });
    const disconnected = Promise.withResolvers<void>();
    connection.port.onDisconnect(() => disconnected.resolve());
    const received: number[] = [];
    const receivedAll = new Promise<void>((resolve) => {
      connection.port.onMessage((message: unknown) => {
        received.push(new Uint8Array(message as ArrayBuffer)[0]!);
        if (received.length === packets.length) {
          connection.port.postMessage(new Uint8Array([99]).buffer);
          resolve();
        }
      });
    });
    await receivedAll;
    await barrier.promise;
    await disconnected.promise;
    await waitForClose(accepted);
    expect(received).toEqual(packets);
    expect(host.sockets.size).toBe(0);
    endpoint.close();
  });

  it("reports an early host close to a listener registered after connect returns", async () => {
    const host = await createRawWebSocketHost((socket) => socket.close());
    cleanup.push(host.close);
    const endpoint = new WebSocketClientEndpoint({ connectTimeoutMs: 100 });
    const connection = await endpoint.connect({
      context: "websocket-server",
      url: host.url,
    });
    const disconnected = new Promise<void>((resolve) =>
      connection.port.onDisconnect(resolve),
    );
    await disconnected;
    await Promise.all([...host.sockets].map(waitForClose));
    expect(host.sockets.size).toBe(0);
    endpoint.close();
  });

  it("reports native client unavailability without falling back to ws", async () => {
    const native = globalThis.WebSocket;
    try {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: undefined,
      });
      await expect(
        new WebSocketClientEndpoint().connect({
          context: "websocket-server",
          url: "ws://127.0.0.1:1",
        }),
      ).rejects.toMatchObject({ code: "E_WEBSOCKET_CLIENT_UNAVAILABLE" });
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: native,
      });
    }
  });

  it("passes binary packets and rejects text, payload overflow, and early FIFO overflow", async () => {
    const endpoint = new WebSocketServerEndpoint({
      maxPayloadBytes: 4,
      maxEarlyPackets: 2,
      maxEarlyBytes: 4,
    });
    const received: number[] = [];
    const receivedPacket = new Promise<void>((resolve) => {
      endpoint.listen((port) => {
        port.onMessage((message: unknown) => {
          received.push((message as ArrayBuffer).byteLength);
          resolve();
        });
      });
    });
    const host = await createWebSocketHost(endpoint, {
      subject: "alice",
      tenant: "one",
    });
    cleanup.push(async () => {
      endpoint.close();
      await host.close();
    });
    const socket = await openWs(host.url);
    socket.send(Buffer.alloc(4));
    await receivedPacket;
    expect(received).toEqual([4]);
    socket.send("text");
    await waitForClose(socket);

    const overflow = await openWs(host.url);
    overflow.send(Buffer.alloc(5));
    await waitForClose(overflow);

    // Keep subsequent Ports unsubscribed so packets actually occupy the early FIFO.
    endpoint.listen(() => {});
    const earlyOverflow = await openWs(host.url);
    earlyOverflow.send(Buffer.alloc(3));
    earlyOverflow.send(Buffer.alloc(2));
    await waitForClose(earlyOverflow);
    expect(received).toEqual([4]);
  });

  it("lets async canConnect validate host facts while canCall remains independent", async () => {
    let allow = false;
    let allowCall = false;
    let invocations = 0;
    const seen: unknown[] = [];
    const checking = Promise.withResolvers<void>();
    const authorization = Promise.withResolvers<void>();
    const endpoint = new WebSocketServerEndpoint<Facts>();
    const server = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
      policy: {
        async canConnect(context) {
          seen.push(context.connection);
          checking.resolve();
          await authorization.promise;
          return allow;
        },
        canCall({ connection, serviceName }) {
          return (
            allowCall &&
            connection.role === "server" &&
            connection.subject === "alice" &&
            serviceName === GuardedToken.id
          );
        },
      },
      providers: [
        {
          token: GuardedToken,
          service: {
            async submit(value: string) {
              invocations += 1;
              return value;
            },
          },
        },
      ],
    });
    await server.ready();
    const host = await createWebSocketHost(endpoint, {
      subject: "alice",
      tenant: "one",
    });
    cleanup.push(async () => {
      endpoint.close();
      await host.close();
    });
    const client = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-client" },
        implementation: new WebSocketClientEndpoint(),
      },
    });
    await client.ready();
    const rejected = client
      .connect({
        target: { context: "websocket-server", url: host.url },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await checking.promise;
    expect(invocations).toBe(0);
    expect(seen).toEqual([{ subject: "alice", tenant: "one", role: "server" }]);
    authorization.resolve();
    expect(await rejected).toMatchObject({ code: "E_HANDSHAKE_REJECTED" });
    allow = true;
    const connection = await client.connect({
      target: { context: "websocket-server", url: host.url },
    });
    expect(connection.connectionMeta.role).toBe("client");
    const service = connection.get(GuardedToken);
    await expect(service.submit("denied")).rejects.toMatchObject({
      code: "E_AUTH_CALL_DENIED",
    });
    expect(invocations).toBe(0);
    allowCall = true;
    expect(await service.submit("allowed")).toBe("allowed");
    expect(invocations).toBe(1);
  });

  it("runs real Nexus RPC and callback over host-owned attachment", async () => {
    const endpoint = new WebSocketServerEndpoint<Facts>();
    const server = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
      providers: [
        {
          token: EchoToken,
          service: {
            async echo(value: string) {
              return value;
            },
            async callback(
              value: string,
              listener: (value: string) => Promise<void>,
            ) {
              await listener(value);
            },
          },
        },
      ],
    });
    await server.ready();
    const host = await createWebSocketHost(endpoint, {
      subject: "alice",
      tenant: "one",
    });
    cleanup.push(async () => {
      endpoint.close();
      await host.close();
    });
    const client = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-client" },
        implementation: new WebSocketClientEndpoint(),
      },
    });
    await client.ready();
    const connection = await client.connect({
      target: { context: "websocket-server", url: host.url },
    });
    const api = connection.get(EchoToken);
    expect(await api.echo("round-trip")).toBe("round-trip");
    const callback: string[] = [];
    await api.callback("callback", async (value) => callback.push(value));
    expect(callback).toEqual(["callback"]);
    const disconnected = new Promise<void>((resolve) =>
      connection.onDisconnected(() => resolve()),
    );
    endpoint.close();
    await disconnected;
    expect(connection.status).toBe("disconnected");
  });

  it("synchronizes State and rejects disconnected actions without mutating the owner", async () => {
    const state = createNexusStore(
      StateToken,
      (set, get) => ({
        count: 0,
        increment(by: number) {
          set({ count: get().count + by });
          return get().count;
        },
      }),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );
    const endpoint = new WebSocketServerEndpoint<Facts>();
    const server = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
      providers: [{ token: StateToken, service: state.provider.service }],
    });
    await server.ready();
    const host = await createWebSocketHost(endpoint, {
      subject: "alice",
      tenant: "one",
    });
    cleanup.push(async () => {
      state.destroy();
      endpoint.close();
      await host.close();
    });
    const client = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-client" },
        implementation: new WebSocketClientEndpoint(),
      },
    });
    await client.ready();
    const remote = await connectNexusStore(client, StateToken, {
      target: { context: "websocket-server", url: host.url },
    });
    expect(await remote.actions.increment(2)).toBe(2);
    expect(remote.getState()).toEqual({ count: 2 });

    const connection = await client.connect({
      target: { context: "websocket-server", url: host.url },
    });
    const disconnected = new Promise<void>((resolve) =>
      connection.onDisconnected(() => resolve()),
    );
    endpoint.close();
    await disconnected;
    // Once the connection has notified subscribers, State releases its action resource.
    await expect(remote.actions.increment(1)).rejects.toMatchObject({
      code: "E_RESOURCE_ACCESS_DENIED",
    });
    expect(state.store.getState().count).toBe(2);
  });

  it("keeps remote Ref state session-bound", async () => {
    const endpoint = new WebSocketServerEndpoint<Facts>();
    const server = new Nexus<WebSocketAdapterModel<Facts>>();
    server.configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
      providers: [
        {
          token: RefToken,
          service: {
            async counter() {
              let count = 0;
              return server.ref({
                increment: () => ++count,
                current: () => count,
              });
            },
          },
        },
      ],
    });
    await server.ready();
    const host = await createWebSocketHost(endpoint, {
      subject: "alice",
      tenant: "one",
    });
    cleanup.push(async () => {
      endpoint.close();
      await host.close();
    });
    const client = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-client" },
        implementation: new WebSocketClientEndpoint(),
      },
    });
    await client.ready();
    const connection = await client.connect({
      target: { context: "websocket-server", url: host.url },
    });
    const ref = await connection.get(RefToken).counter();
    expect(await ref.increment()).toBe(1);
    const disconnected = new Promise<void>((resolve) =>
      connection.onDisconnected(() => resolve()),
    );
    endpoint.close();
    await disconnected;
    await expect(ref.current()).rejects.toMatchObject({
      code: "E_CONN_CLOSED",
    });
  });

  it("does not replay an executed operation after explicit reconnection", async () => {
    let count = 0;
    const endpoint = new WebSocketServerEndpoint<Facts>();
    let currentEndpoint = endpoint;
    let dropResponse = true;
    const service: CommitService = {
      async commit(id) {
        if (id === "one") count += 1;
        if (dropResponse) endpoint.close();
        return count;
      },
      async current() {
        return count;
      },
    };
    const server = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
      providers: [
        {
          token: CommitToken,
          service,
        },
      ],
    });
    await server.ready();
    const host = await createWebSocketHost(() => currentEndpoint, {
      subject: "alice",
      tenant: "one",
    });
    cleanup.push(host.close);
    const client = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-client" },
        implementation: new WebSocketClientEndpoint(),
      },
    });
    await client.ready();
    const target = { context: "websocket-server" as const, url: host.url };
    const firstConnection = await client.connect({ target });
    const firstDisconnected = new Promise<void>((resolve) =>
      firstConnection.onDisconnected(() => resolve()),
    );
    const old = firstConnection.get(CommitToken);
    await expect(old.commit("one")).rejects.toMatchObject({
      code: "E_CONN_CLOSED",
    });
    expect(count).toBe(1);
    await firstDisconnected;
    expect(firstConnection.status).toBe("disconnected");
    await expect(old.current()).rejects.toMatchObject({
      code: "E_CONN_CLOSED",
    });

    // The host keeps listening at the same URL; replace the closed Nexus endpoint.
    const replacement = new WebSocketServerEndpoint<Facts>();
    const restarted = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        implementation: replacement,
        meta: { context: "websocket-server" },
      },
      providers: [{ token: CommitToken, service }],
    });
    await restarted.ready();
    currentEndpoint = replacement;
    cleanup.push(async () => {
      replacement.close();
    });
    dropResponse = false;
    const secondConnection = await client.connect({ target });
    expect(secondConnection.id).not.toBe(firstConnection.id);
    const fresh = secondConnection.get(CommitToken);
    // The query runs behind any replay on the ordered stream and observes one commit.
    expect(await fresh.current()).toBe(1);
    await expect(old.current()).rejects.toMatchObject({
      code: "E_CONN_CLOSED",
    });
    expect(await fresh.commit("one")).toBe(2);
  });
});
