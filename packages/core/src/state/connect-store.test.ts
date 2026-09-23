import { describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import type { Connection } from "../api/connection";
import type { ResourceScope } from "../service/resource-scope";
import { createStarNetwork } from "../utils/test-utils";
import { createNexusStore } from "./bind-store";
import { connectNexusStore, safeConnectNexusStore } from "./connect-store";
import { NexusStoreConnectError } from "./errors";
import type { NexusStoreServiceContract } from "./contract";
import { createStoreToken } from "./contract";

type State = { count: number };
type Actions = { increment(by: number): number };
const token = createStoreToken<State & Actions>("state:client");

const createHost = () =>
  createNexusStore(
    token,
    (set, get) => ({
      count: 0,
      increment(by: number) {
        set({ count: get().count + by });
        return get().count;
      },
    }),
    { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
  );

describe("State connection acquisition and handshake", () => {
  it("connects a real remote store and completes actions after its snapshot", async () => {
    const { provider, destroy } = createHost();
    const network = await createStarNetwork<
      { context: string },
      { from: string }
    >({
      center: {
        meta: { context: "host" },
        providers: { [token.id]: provider.service },
      },
      leaves: [
        {
          meta: { context: "client" },
          cmConfig: { connectTo: [{ context: "host" }] },
        },
      ],
    });
    const remote = await connectNexusStore(
      network.get("client")!.nexus,
      token,
      { target: { context: "host" } },
    );
    const order: string[] = [];
    remote.subscribe(() => order.push("snapshot"));
    await remote.actions.increment(2).then(() => order.push("action"));
    expect(order).toEqual(["snapshot", "action"]);
    expect(remote.getState()).toEqual({ count: 2 });
    remote.destroy();
    destroy();
  });

  it("returns structured connect errors and cleans a timed-out late init", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const unsubscribe = vi.fn();
    const service = {
      async subscribe(onSync: (event: unknown) => unknown) {
        await pending;
        await onSync({
          type: "init",
          storeInstanceId: "late",
          version: 0,
          state: { count: 0 },
          actions: {},
          unsubscribe,
        });
      },
    } as unknown as NexusStoreServiceContract<State & Actions>;
    const result = await safeConnectNexusStore(
      { safeConnect: async () => Result.ok(connectionFor(service)) },
      token,
      { timeout: 10 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toBeInstanceOf(NexusStoreConnectError);
    resolve();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("keeps safe acquisition errors separate from protocol errors", async () => {
    const result = await safeConnectNexusStore(
      { safeConnect: async () => Result.err(new Error("no provider")) },
      token,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreConnectError);
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("closes a newly created scope when service acquisition fails", async () => {
    const scope = createScope("missing", token.id);
    const result = await safeConnectNexusStore(
      {
        safeConnect: async () =>
          Result.ok({
            ...connectionFor({}),
            createScope: () => scope,
            safeGet: () => Result.err(new Error("missing")),
          }),
      },
      token,
    );

    expect(result.isErr()).toBe(true);
    expect(scope.closed).toBe(true);
  });

  it("contains a scope allocation failure at the safe acquisition boundary", async () => {
    const result = await safeConnectNexusStore(
      {
        safeConnect: async () =>
          Result.ok({
            ...connectionFor({}),
            createScope: () => {
              throw new Error("scope capacity reached");
            },
          }),
      },
      token,
    );

    expect(result).toMatchObject({ error: { code: "E_STORE_CONNECT" } });
  });

  it.each(["throw", "reject", "result"] as const)(
    "preserves the cause of a %s acquisition failure",
    async (mode) => {
      const cause = new Error("acquisition failed");
      const result = await safeConnectNexusStore(
        {
          safeConnect: (): Promise<Result<never, Error>> => {
            if (mode === "throw") throw cause;
            if (mode === "reject") return Promise.reject(cause);
            return Promise.resolve(Result.err(cause));
          },
        },
        token,
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("E_STORE_CONNECT");
        expect(result.error.cause).toBe(cause);
      }
    },
  );

  it("reclaims init when disconnect follows its callback before the handshake returns", async () => {
    const unsubscribe = vi.fn();
    let disconnect!: () => void;
    const stopObserving = vi.fn();
    const service = {
      async subscribe(onSync: (event: unknown) => void) {
        onSync({
          type: "init",
          storeInstanceId: "closing",
          version: 0,
          state: { count: 0 },
          actions: {},
          unsubscribe,
        });
        queueMicrotask(disconnect);
      },
    } as NexusStoreServiceContract<State & Actions>;
    const result = await safeConnectNexusStore(
      {
        safeConnect: async () =>
          Result.ok(
            connectionFor(service, {
              onDisconnected: (notify) => {
                disconnect = notify;
                return stopObserving;
              },
            }),
          ),
      },
      token,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("E_STORE_DISCONNECTED");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stopObserving).toHaveBeenCalledOnce();
  });

  it("marks a State mirror stale when its where identity observation stops matching", async () => {
    let updateIdentity!: (meta: object) => void;
    const service = {
      async subscribe(onSync: (event: unknown) => void) {
        onSync({
          type: "init",
          storeInstanceId: "where",
          version: 0,
          state: { count: 0 },
          actions: {},
          unsubscribe: vi.fn(),
        });
      },
    } as NexusStoreServiceContract<State & Actions>;
    const result = await safeConnectNexusStore(
      {
        safeConnect: async () =>
          Result.ok(
            connectionFor(service, {
              subscribeIdentity: (listener) => {
                updateIdentity = listener;
                listener({ active: true });
                return () => undefined;
              },
            }),
          ),
      },
      token,
      {
        where: ((meta: object) =>
          (meta as { active?: boolean }).active === true) as never,
      },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      updateIdentity({ active: false });
      expect(result.value.getStatus().type).toBe("stale");
      result.value.destroy();
    }
  });

  it("does not subscribe after an immediate identity mismatch", async () => {
    const subscribe = vi.fn();
    const service = { subscribe } as unknown as NexusStoreServiceContract<
      State & Actions
    >;
    const result = await safeConnectNexusStore(
      {
        safeConnect: async () =>
          Result.ok(
            connectionFor(service, {
              subscribeIdentity: (listener) => {
                listener({ active: false });
                return () => undefined;
              },
            }),
          ),
      },
      token,
      {
        where: ((meta: object) =>
          (meta as { active?: boolean }).active === true) as never,
      },
    );

    expect(result).toMatchObject({ error: { code: "E_STORE_DISCONNECTED" } });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not subscribe after an immediate connection terminal event", async () => {
    const subscribe = vi.fn();
    const service = { subscribe } as unknown as NexusStoreServiceContract<
      State & Actions
    >;
    const result = await safeConnectNexusStore(
      {
        safeConnect: async () =>
          Result.ok(
            connectionFor(service, {
              onDisconnected: (listener) => {
                listener();
                return () => undefined;
              },
            }),
          ),
      },
      token,
    );

    expect(result).toMatchObject({ error: { code: "E_STORE_DISCONNECTED" } });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("terminates only its mirror when its subscription scope closes", async () => {
    const first = createScope("first", token.id);
    const second = createScope("second", token.id);
    const service = {
      async subscribe(onSync: (event: unknown) => void) {
        onSync({
          type: "init",
          storeInstanceId: "scoped",
          version: 0,
          state: { count: 0 },
          actions: {},
          unsubscribe: vi.fn(),
        });
      },
    } as NexusStoreServiceContract<State & Actions>;
    const createSubscriptionScope = vi
      .fn<Connection["createScope"]>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const connection = connectionFor(service, {
      createScope: createSubscriptionScope,
    });

    const one = await connectNexusStore(
      { safeConnect: async () => Result.ok(connection) },
      token,
    );
    const two = await connectNexusStore(
      { safeConnect: async () => Result.ok(connection) },
      token,
    );

    first.close();
    expect(one.getStatus().type).toBe("disconnected");
    expect(two.getStatus().type).toBe("ready");
  });

  it("unsubscribes before closing its subscription scope on destroy", async () => {
    const order: string[] = [];
    const scope = createScope("destroy", token.id, () => order.push("scope"));
    const unsubscribe = vi.fn(() => order.push("unsubscribe"));
    const service = {
      subscribe(onSync: (event: unknown) => void) {
        onSync({
          type: "init",
          storeInstanceId: "destroy",
          version: 0,
          state: { count: 0 },
          actions: {},
          unsubscribe,
        });
      },
    } as NexusStoreServiceContract<State & Actions>;
    const remote = await connectNexusStore(
      {
        safeConnect: async () =>
          Result.ok(connectionFor(service, { createScope: () => scope })),
      },
      token,
    );

    remote.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(order).toEqual(["unsubscribe", "scope"]));
  });

  it("keeps its scope live until an asynchronous unsubscribe settles", async () => {
    let resolve!: () => void;
    const stopped = new Promise<void>((done) => {
      resolve = done;
    });
    const scope = createScope("async-destroy", token.id);
    const service = {
      subscribe(onSync: (event: unknown) => void) {
        onSync({
          type: "init",
          storeInstanceId: "async-destroy",
          version: 0,
          state: { count: 0 },
          actions: {},
          unsubscribe: () => stopped,
        });
      },
    } as NexusStoreServiceContract<State & Actions>;
    const remote = await connectNexusStore(
      {
        safeConnect: async () =>
          Result.ok(connectionFor(service, { createScope: () => scope })),
      },
      token,
    );

    remote.destroy();
    expect(scope.closed).toBe(false);
    resolve();
    await vi.waitFor(() => expect(scope.closed).toBe(true));
  });
});

const connectionFor = (
  service: object,
  options: {
    onDisconnected?: (listener: () => void) => () => void;
    subscribeIdentity?: (listener: (meta: object) => void) => () => void;
    createScope?: (token: typeof token) => ResourceScope;
  } = {},
): Connection =>
  ({
    createScope:
      options.createScope ?? (() => createScope("default", token.id)),
    safeGet: () => Result.ok(service),
    onDisconnected: options.onDisconnected ?? (() => () => undefined),
    subscribeIdentity: options.subscribeIdentity ?? (() => () => undefined),
  }) as Connection;

const createScope = (
  id: string,
  serviceId: string,
  onClose?: () => void,
): ResourceScope => {
  let closed = false;
  const listeners = new Set<() => void>();
  return {
    id,
    serviceId,
    get closed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      onClose?.();
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
    onClosed(listener) {
      if (closed) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    [Symbol.dispose]() {
      this.close();
    },
  };
};
