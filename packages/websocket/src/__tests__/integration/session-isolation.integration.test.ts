import { afterEach, describe, expect, it } from "vitest";
import { Nexus, Token, type Connection } from "@nexus-js/core";
import {
  connectNexusStore,
  createNexusStore,
  createStoreToken,
} from "@nexus-js/core/state";
import { WebSocketClientEndpoint } from "../../index.js";
import { WebSocketServerEndpoint } from "../../server.js";
import type { WebSocketAdapterModel } from "../../index.js";
import { createRawWebSocketHost } from "./fixtures.js";

type Facts = { readonly client: string };
type WorkService = {
  echo(value: string): Promise<string>;
  hold(value: string): Promise<string>;
};
type CounterRef = { increment(): number; current(): number };
type RefService = { counter(): Promise<CounterRef> };
type CounterState = { count: number; increment(by: number): number };

const WorkToken = new Token<WorkService, WebSocketAdapterModel<Facts>>(
  "websocket:reliability:work",
);
const RefToken = new Token<RefService, WebSocketAdapterModel<Facts>>(
  "websocket:reliability:ref",
);
const StateToken = createStoreToken<CounterState, WebSocketAdapterModel<Facts>>(
  "websocket:reliability:state",
);

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
    throw new AggregateError(errors, "WebSocket reliability cleanup failed");
});

describe("WebSocket session reliability", () => {
  it("isolates A disconnect, rejects its old handles, and reuses capacity for C", async () => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const holdExited = Promise.withResolvers<void>();
    cleanup.push(async () => released.resolve());
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
    cleanup.push(async () => state.destroy());
    const serverEndpoint = new WebSocketServerEndpoint<Facts>({
      maxConnections: 2,
    });
    cleanup.push(async () => serverEndpoint.close());
    const holdService: WorkService = {
      async echo(value) {
        return value;
      },
      async hold(value) {
        if (value === "A") {
          entered.resolve();
          await released.promise;
          holdExited.resolve();
        }
        return `done:${value}`;
      },
    };
    const server = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: serverEndpoint,
      },
      providers: [
        { token: WorkToken, service: holdService },
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
        state.provider,
      ],
    });
    await server.ready();

    const closedByClient = new Map<string, Promise<void>>();
    const host = await createRawWebSocketHost((socket, request) => {
      const client = new globalThis.URL(
        `http://localhost${request.url ?? ""}`,
      ).searchParams.get("client");
      if (!client) throw new Error("missing client query");
      const closed = new Promise<void>((resolve) =>
        socket.once("close", () => resolve()),
      );
      closedByClient.set(client, closed);
      serverEndpoint.attach(socket, { client });
    });
    cleanup.push(host.close);

    const createClient = () => {
      const endpoint = new WebSocketClientEndpoint();
      cleanup.push(async () => endpoint.close());
      const nexus = new Nexus<WebSocketAdapterModel>().configure({
        endpoint: {
          meta: { context: "websocket-client" },
          implementation: endpoint,
        },
      });
      return { endpoint, nexus };
    };
    const target = (client: string) => ({
      context: "websocket-server" as const,
      url: `${host.url}/rpc?client=${client}`,
    });
    const a = createClient();
    const b = createClient();
    const c = createClient();
    await Promise.all([a.nexus.ready(), b.nexus.ready(), c.nexus.ready()]);

    const aConnection = await a.nexus.connect({ target: target("A") });
    cleanup.push(async () => aConnection.disconnect());
    const aStore = await connectNexusStore(a.nexus, StateToken, {
      target: target("A"),
    });
    cleanup.push(async () => aStore.destroy());
    const aRef = await aConnection.get(RefToken).counter();
    const pendingA = Nexus.safeCall(aConnection.get(WorkToken).hold("A"));
    await entered.promise;

    const bConnection = await b.nexus.connect({ target: target("B") });
    cleanup.push(async () => bConnection.disconnect());
    const bStore = await connectNexusStore(b.nexus, StateToken, {
      target: target("B"),
    });
    cleanup.push(async () => bStore.destroy());
    const bRef = await bConnection.get(RefToken).counter();
    expect(await bConnection.get(WorkToken).echo("B-before")).toBe("B-before");
    expect(await bRef.increment()).toBe(1);

    const aDisconnected = Promise.withResolvers<void>();
    aConnection.onDisconnected(() => aDisconnected.resolve());
    const aStoreDisconnected = Promise.withResolvers<void>();
    const stopAStatus = aStore.subscribeStatus(() => {
      if (aStore.getStatus().type === "disconnected")
        aStoreDisconnected.resolve();
    });
    a.endpoint.close();
    await expect(pendingA).resolves.toMatchObject({
      error: { code: "E_CONN_CLOSED" },
    });
    await Promise.all([
      aDisconnected.promise,
      aStoreDisconnected.promise,
      (() => {
        const closed = closedByClient.get("A");
        expect(closed).toBeDefined();
        return closed!;
      })(),
    ]);
    stopAStatus();
    expect(aConnection.status).toBe("disconnected");
    const oldResource = aConnection.safeGet(WorkToken);
    expect(oldResource.isErr()).toBe(true);
    if (oldResource.isErr())
      expect(oldResource.error.code).toBe("E_CONN_CLOSED");
    await expect(aRef.current()).rejects.toMatchObject({
      code: "E_CONN_CLOSED",
    });
    await expect(aStore.actions.increment(1)).rejects.toMatchObject({
      code: "E_CONN_CLOSED",
    });
    expect(host.sockets.size).toBe(1);
    released.resolve();
    await holdExited.promise;

    const bUpdated = Promise.withResolvers<void>();
    const stopB = bStore.subscribe((next) => {
      if (next.count === 1) bUpdated.resolve();
    });
    expect(await bConnection.get(WorkToken).echo("B-after")).toBe("B-after");
    expect(await bStore.actions.increment(1)).toBe(1);
    await bUpdated.promise;
    stopB();
    expect(bStore.getState()).toEqual({ count: 1 });
    expect(await bRef.current()).toBe(1);

    const cStore = await connectNexusStore(c.nexus, StateToken, {
      target: target("C"),
    });
    cleanup.push(async () => cStore.destroy());
    const cConnection = await c.nexus.connect({ target: target("C") });
    cleanup.push(async () => cConnection.disconnect());
    expect(host.sockets.size).toBe(2);
    expect(await cConnection.get(WorkToken).echo("C")).toBe("C");
    expect(cStore.getState()).toEqual({ count: 1 });
  });

  it("reuses one-slot capacity across subscribed cycles and removes adapter listeners", async () => {
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
    cleanup.push(async () => state.destroy());
    const endpoint = new WebSocketServerEndpoint<Facts>({ maxConnections: 1 });
    cleanup.push(async () => endpoint.close());
    const server = new Nexus<WebSocketAdapterModel<Facts>>().configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
      providers: [state.provider],
    });
    await server.ready();

    type SocketLifecycle = {
      readonly messageListeners: number;
      readonly errorListeners: number;
      readonly closeListeners: number;
      readonly closed: Promise<void>;
      readonly socket: { listenerCount(event: string): number };
    };
    let nextAccepted = Promise.withResolvers<SocketLifecycle>();
    const host = await createRawWebSocketHost((socket) => {
      // Include this test-owned once listener in the pre-adapter baseline.
      const closed = new Promise<void>((resolve) =>
        socket.once("close", () => resolve()),
      );
      const lifecycle: SocketLifecycle = {
        messageListeners: socket.listenerCount("message"),
        errorListeners: socket.listenerCount("error"),
        closeListeners: socket.listenerCount("close"),
        closed,
        socket,
      };
      endpoint.attach(socket, { client: "cycle" });
      nextAccepted.resolve(lifecycle);
    });
    cleanup.push(host.close);

    const clientEndpoint = new WebSocketClientEndpoint({ maxConnections: 1 });
    cleanup.push(async () => clientEndpoint.close());
    const client = new Nexus<WebSocketAdapterModel>().configure({
      endpoint: {
        meta: { context: "websocket-client" },
        implementation: clientEndpoint,
      },
    });
    await client.ready();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const accepted = nextAccepted.promise;
      const connected = Promise.withResolvers<Connection>();
      const stopConnect = client.onConnect((connection) =>
        connected.resolve(connection),
      );
      const remote = await connectNexusStore(client, StateToken, {
        target: {
          context: "websocket-server",
          url: host.url,
        },
      });
      const connection = await connected.promise;
      stopConnect();
      cleanup.push(async () => connection.disconnect());
      const disconnected = Promise.withResolvers<void>();
      connection.onDisconnected(() => disconnected.resolve());
      cleanup.push(async () => remote.destroy());
      const lifecycle = await accepted;
      nextAccepted = Promise.withResolvers<SocketLifecycle>();
      const expectedCount = cycle + 1;
      const updated = Promise.withResolvers<void>();
      const stop = remote.subscribe((next) => {
        if (next.count === expectedCount) updated.resolve();
      });
      expect(await remote.actions.increment(1)).toBe(expectedCount);
      await updated.promise;
      stop();

      connection.disconnect();
      await Promise.all([disconnected.promise, lifecycle.closed]);
      expect(host.sockets.size).toBe(0);
      expect(host.rawSockets.size).toBe(0);
      expect(lifecycle.socket.listenerCount("message")).toBe(
        lifecycle.messageListeners,
      );
      expect(lifecycle.socket.listenerCount("error")).toBe(
        lifecycle.errorListeners,
      );
      // The fixture and test once listeners are both consumed by close.
      expect(lifecycle.socket.listenerCount("close")).toBe(
        lifecycle.closeListeners - 2,
      );
      remote.destroy();
    }

    const response = await globalThis.fetch(
      host.url.replace("ws://", "http://"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("host-alive");
  });
});
