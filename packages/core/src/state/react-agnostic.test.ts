import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Token } from "../api/token";
import { createL3Endpoints, createStarNetwork } from "../utils/test-utils";
import { defineNexusStore } from "./define-store";
import {
  NexusStoreConnectError,
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "./errors";
import { provideNexusStore } from "./provide-store";
import { createStoreHost } from "./host/store-host";
import {
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
} from "../service/service-invocation-hooks";
import type { NexusStoreServiceContract } from "./types";
import {
  connectNexusStore,
  safeConnectNexusStore,
  safeInvokeStoreAction,
} from "./connect-store";
import { NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL } from "@/types/symbols";

const createCounterDefinition = () =>
  defineNexusStore({
    token: new Token("state:counter:host-runtime"),
    state: () => ({ count: 0 }),
    actions: ({ getState, setState }) => ({
      increment(by: number) {
        setState({ count: getState().count + by });
        return getState().count;
      },
      explode() {
        throw new Error("boom");
      },
      mutateThenExplode() {
        setState({ count: 999 });
        throw new Error("boom-after-mutate");
      },
    }),
  });

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

describe("state host runtime baseline handshake", () => {
  it("creates initial versioned snapshot via subscribe baseline", async () => {
    const host = createStoreHost(createCounterDefinition());

    const baseline = await host.subscribe(() => {});

    expect(baseline.storeInstanceId).toMatch(/^store-instance:/);
    expect(baseline.subscriptionId).toMatch(/^store-subscription:/);
    expect(baseline.version).toBe(0);
    expect(baseline.state).toEqual({ count: 0 });
  });

  it("multiple subscribers observe same monotonic version stream", async () => {
    const host = createStoreHost(createCounterDefinition());
    const leftEvents: Array<{ version: number; count: number }> = [];
    const rightEvents: Array<{ version: number; count: number }> = [];

    await host.subscribe((event) => {
      leftEvents.push({ version: event.version, count: event.state.count });
    });
    await host.subscribe((event) => {
      rightEvents.push({ version: event.version, count: event.state.count });
    });

    await host.dispatch("increment", [1]);
    await host.dispatch("increment", [2]);

    expect(leftEvents).toEqual([
      { version: 1, count: 1 },
      { version: 2, count: 3 },
    ]);
    expect(rightEvents).toEqual([
      { version: 1, count: 1 },
      { version: 2, count: 3 },
    ]);
  });

  it("unsubscribe and destroy of one subscriber does not affect others", async () => {
    const host = createStoreHost(createCounterDefinition());
    const left = vi.fn();
    const right = vi.fn();

    const leftBaseline = await host.subscribe(left);
    await host.subscribe(right);

    await host.unsubscribe(leftBaseline.subscriptionId);
    await host.dispatch("increment", [1]);

    expect(left).not.toHaveBeenCalled();
    expect(right).toHaveBeenCalledTimes(1);

    host.destroy();
    await expect(host.dispatch("increment", [1])).rejects.toThrow();
  });

  it("isolates and drops a subscriber that throws", async () => {
    const host = createStoreHost(createCounterDefinition());
    const unstable = vi.fn(() => {
      throw new Error("listener-failed");
    });
    const stable = vi.fn();

    await host.subscribe(unstable);
    await host.subscribe(stable);

    await host.dispatch("increment", [1]);
    await host.dispatch("increment", [1]);

    expect(unstable).toHaveBeenCalledTimes(1);
    expect(stable).toHaveBeenCalledTimes(2);
  });
});

describe("state host runtime dispatch semantics", () => {
  it("dispatch advances version monotonically", async () => {
    const host = createStoreHost(createCounterDefinition());
    const baseline = await host.subscribe(() => {});

    expect(baseline.version).toBe(0);
    await host.dispatch("increment", [1]);
    await host.dispatch("increment", [1]);

    const after = await host.subscribe(() => {});
    expect(after.version).toBe(2);
    expect(after.state.count).toBe(2);
  });

  it("host business error path does not corrupt versioned state", async () => {
    const host = createStoreHost(createCounterDefinition());
    const baseline = await host.subscribe(() => {});

    expect(baseline.version).toBe(0);
    await expect(host.dispatch("explode", [])).rejects.toMatchObject({
      name: "NexusStoreActionError",
      cause: expect.objectContaining({ message: "boom" }),
    } satisfies Partial<NexusStoreActionError>);
    await expect(host.dispatch("mutateThenExplode", [])).rejects.toMatchObject({
      name: "NexusStoreActionError",
      cause: expect.objectContaining({ message: "boom-after-mutate" }),
    } satisfies Partial<NexusStoreActionError>);

    const after = await host.subscribe(() => {});
    expect(after.version).toBe(0);
    expect(after.state).toEqual({ count: 0 });
  });

  it("serializes overlapping async dispatches without losing updates", async () => {
    const firstGate = deferred<void>();

    const definition = defineNexusStore({
      token: new Token("state:counter:host-dispatch-serialization"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        async addAfter(by: number, gate: Promise<void>) {
          const base = getState().count;
          await gate;
          setState({ count: base + by });
          return getState().count;
        },
      }),
    });

    const host = createStoreHost(definition);

    const first = host.dispatch("addAfter", [1, firstGate.promise]);
    const second = host.dispatch("addAfter", [2, Promise.resolve()]);

    firstGate.resolve();

    await expect(first).resolves.toMatchObject({
      type: "dispatch-result",
      committedVersion: 1,
      result: 1,
    });
    await expect(second).resolves.toMatchObject({
      type: "dispatch-result",
      committedVersion: 2,
      result: 3,
    });

    const after = await host.subscribe(() => {});
    expect(after.version).toBe(2);
    expect(after.state).toEqual({ count: 3 });
  });

  it("rejects invalid dispatch request envelope at runtime boundary", async () => {
    const host = createStoreHost(createCounterDefinition());

    await expect(
      host.dispatch("increment", "not-array" as unknown as [number]),
    ).rejects.toBeInstanceOf(NexusStoreProtocolError);
  });
});

describe("provideNexusStore", () => {
  it("translates store definition to ordinary ServiceRegistration", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);

    expect(registration.token).toBe(definition.token);
    expect(typeof registration.implementation.subscribe).toBe("function");
    expect(typeof registration.implementation.unsubscribe).toBe("function");
    expect(typeof registration.implementation.dispatch).toBe("function");

    const baseline = await registration.implementation.subscribe(() => {});
    expect(baseline.version).toBe(0);

    await registration.implementation.dispatch("increment", [3]);
    const after = await registration.implementation.subscribe(() => {});
    expect(after.version).toBe(1);
    expect(after.state.count).toBe(3);
  });

  it("cleans orphan subscriptions on disconnect through layer3 runtime", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);

    expect(
      (registration.implementation as { [SERVICE_ON_DISCONNECT]?: unknown })[
        SERVICE_ON_DISCONNECT
      ],
    ).toBeTypeOf("function");

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        services: {
          [definition.token.id]:
            registration.implementation as NexusStoreServiceContract<
              object,
              any
            >,
        },
      },
      {
        meta: { id: "client" },
      },
    );

    const storeProxy = (
      setup.clientEngine as any
    ).proxyFactory.createServiceProxy(definition.token.id, {
      target: {
        connectionId: (setup.clientConnection as { connectionId: string })
          .connectionId,
      },
    }) as NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    >;

    const disconnectedListener = vi.fn();
    const localListener = vi.fn();

    await registration.implementation.subscribe(localListener);
    await storeProxy.subscribe(disconnectedListener);

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(disconnectedListener).toHaveBeenCalledTimes(1);
      expect(localListener).toHaveBeenCalledTimes(1);
    });

    (setup.clientConnection as { close(): void }).close();

    await vi.waitFor(() => {
      expect(
        Array.from((setup.hostCm as any).connections.values()),
      ).toHaveLength(0);
    });

    await expect(
      registration.implementation.dispatch("increment", [1]),
    ).resolves.toMatchObject({ result: 2, committedVersion: 2 });

    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(2);
      expect(disconnectedListener).toHaveBeenCalledTimes(1);
    });
  });

  it("exposes explicit invocation context shape for subscribe binding", () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);

    const hooks = registration.implementation as {
      [SERVICE_INVOKE_START]?: (sourceConnectionId: string) => unknown;
    };

    const context = hooks[SERVICE_INVOKE_START]?.("conn-ctx-shape");
    expect(context).toEqual({ sourceConnectionId: "conn-ctx-shape" });
  });

  it("binds async subscribe ownership through hook path and cleans via disconnect hook", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        services: {
          [definition.token.id]:
            registration.implementation as NexusStoreServiceContract<
              object,
              any
            >,
        },
      },
      {
        meta: { id: "client" },
      },
    );

    const clientConnectionId = (
      setup.clientConnection as { connectionId: string }
    ).connectionId;
    const storeProxy = (
      setup.clientEngine as any
    ).proxyFactory.createServiceProxy(definition.token.id, {
      target: {
        connectionId: clientConnectionId,
      },
    }) as NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    >;

    const remoteListener = vi.fn();
    const localListener = vi.fn();

    await registration.implementation.subscribe(localListener);
    await storeProxy.subscribe(remoteListener);

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(1);
      expect(remoteListener).toHaveBeenCalledTimes(1);
    });

    (
      registration.implementation as {
        [SERVICE_ON_DISCONNECT](connectionId: string): void;
      }
    )[SERVICE_ON_DISCONNECT](clientConnectionId);

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(2);
      expect(remoteListener).toHaveBeenCalledTimes(1);
    });
  });

  it("binds ownership correctly for overlapping async subscribes from different connections", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);
    const subscribeBarrier = deferred<void>();
    const localListener = vi.fn();

    await registration.implementation.subscribe(localListener);

    const originalSubscribe = registration.implementation.subscribe.bind(
      registration.implementation,
    );
    registration.implementation.subscribe = async (onSync) => {
      await subscribeBarrier.promise;
      return originalSubscribe(onSync);
    };

    const network = await createStarNetwork<
      { context: string },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [definition.token.id]: registration.implementation,
        },
      },
      leaves: [
        {
          meta: { context: "popup-a" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: { context: "popup-b" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const popupA = network.get("popup-a")!.nexus;
    const popupB = network.get("popup-b")!.nexus;

    const connectA = connectNexusStore(popupA, definition, {
      target: { descriptor: { context: "background" } },
    });
    const connectB = connectNexusStore(popupB, definition, {
      target: { descriptor: { context: "background" } },
    });

    subscribeBarrier.resolve();

    const [remoteA, remoteB] = await Promise.all([connectA, connectB]);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const unsubscribeA = remoteA.subscribe(listenerA);
    const unsubscribeB = remoteB.subscribe(listenerB);

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(1);
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);
    });

    const popupACm = (popupA as any).connectionManager;
    const popupAConnection = Array.from(
      (popupACm as any).connections.values(),
    )[0] as {
      close(): void;
    };
    popupAConnection.close();

    await vi.waitFor(() => {
      expect((popupACm as any).connections.size).toBe(0);
    });

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(2);
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(2);
    });

    const popupBCm = (popupB as any).connectionManager;
    const popupBConnection = Array.from(
      (popupBCm as any).connections.values(),
    )[0] as {
      close(): void;
    };
    popupBConnection.close();

    await vi.waitFor(() => {
      expect((popupBCm as any).connections.size).toBe(0);
    });

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(3);
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(2);
    });

    unsubscribeA();
    unsubscribeB();
    remoteA.destroy();
    remoteB.destroy();
  });

  it("cleans remote subscription on real disconnect after async subscribe path", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);
    const subscribeGate = deferred<void>();
    const localListener = vi.fn();

    await registration.implementation.subscribe(localListener);

    const originalSubscribe = registration.implementation.subscribe.bind(
      registration.implementation,
    );
    registration.implementation.subscribe = async (onSync) => {
      await subscribeGate.promise;
      return originalSubscribe(onSync);
    };

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        services: {
          [definition.token.id]:
            registration.implementation as NexusStoreServiceContract<
              object,
              any
            >,
        },
      },
      {
        meta: { id: "client" },
      },
    );

    const storeProxy = (
      setup.clientEngine as any
    ).proxyFactory.createServiceProxy(definition.token.id, {
      target: {
        connectionId: (setup.clientConnection as { connectionId: string })
          .connectionId,
      },
    }) as NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    >;

    const remoteListener = vi.fn();

    const subscribePromise = storeProxy.subscribe(remoteListener);
    subscribeGate.resolve();
    await subscribePromise;

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(1);
      expect(remoteListener).toHaveBeenCalledTimes(1);
    });

    (setup.clientConnection as { close(): void }).close();

    await vi.waitFor(() => {
      expect(
        Array.from((setup.hostCm as any).connections.values()),
      ).toHaveLength(0);
    });

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(2);
      expect(remoteListener).toHaveBeenCalledTimes(1);
    });
  });
});

describe("state client runtime and connect APIs", () => {
  it("connectNexusStore connects through ordinary Nexus service proxy", async () => {
    const counterStore = defineNexusStore({
      token: new Token("state:counter:connect-api"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
    });

    const network = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [counterStore.token.id]:
            provideNexusStore(counterStore).implementation,
        },
      },
      leaves: [
        {
          meta: { context: "popup" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const popup = network.get("popup")!.nexus;
    const remote = await connectNexusStore(popup, counterStore, {
      target: { descriptor: { context: "background" } },
    });

    expect(remote.getStatus().type).toBe("ready");
    expect(remote.getState().count).toBe(0);

    await remote.actions.increment(2);
    expect(remote.getState().count).toBe(2);

    remote.destroy();
  });

  it("safeConnectNexusStore returns ResultAsync", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);
    const network = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [definition.token.id]: registration.implementation,
        },
      },
      leaves: [
        {
          meta: { context: "popup" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const popup = network.get("popup")!.nexus;
    const result = await safeConnectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      result.value.destroy();
    }
  });

  it("handles callback-before-subscribe-return ordering without rollback", async () => {
    const events: Array<(event: any) => void> = [];
    const service = {
      subscribe: vi.fn(async (onSync: (event: any) => void) => {
        events.push(onSync);
        onSync({
          type: "snapshot",
          storeInstanceId: "store-a",
          version: 1,
          state: { count: 1 },
        });

        return {
          storeInstanceId: "store-a",
          subscriptionId: "sub-1",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 1,
      })),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:ordering"),
        state: () => ({ count: 0 }),
        actions: () => ({
          increment(by: number) {
            return by;
          },
        }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(remote.getState()).toEqual({ count: 1 });
    expect((remote.getStatus() as { version?: number }).version).toBe(1);
  });

  it("ignores duplicate versions, errors on smaller version, and invalidates on instance mismatch", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-a",
          subscriptionId: "sub-2",
          version: 1,
          state: { count: 1 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 2,
        result: 0,
      })),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:version-guards"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    onSync({
      type: "snapshot",
      storeInstanceId: "store-a",
      version: 1,
      state: { count: 999 },
    });
    expect(remote.getState().count).toBe(1);

    onSync({
      type: "snapshot",
      storeInstanceId: "store-a",
      version: 0,
      state: { count: 0 },
    });
    expect(remote.getStatus().type).toBe("disconnected");
    expect((remote.getStatus() as { cause?: unknown }).cause).toBeInstanceOf(
      NexusStoreProtocolError,
    );
    const disconnectedSnapshot = remote.getState();
    onSync({
      type: "snapshot",
      storeInstanceId: "store-a",
      version: 5,
      state: { count: 5 },
    });
    expect(remote.getStatus().type).toBe("disconnected");
    expect(remote.getState()).toEqual(disconnectedSnapshot);
    await expect(remote.actions.noop()).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );

    const remote2 = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:instance-guard"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    onSync({
      type: "snapshot",
      storeInstanceId: "store-b",
      version: 2,
      state: { count: 2 },
    });
    expect(remote2.getStatus().type).toBe("stale");
    const staleSnapshot = remote2.getState();
    onSync({
      type: "snapshot",
      storeInstanceId: "store-a",
      version: 6,
      state: { count: 6 },
    });
    expect(remote2.getStatus().type).toBe("stale");
    expect(remote2.getState()).toEqual(staleSnapshot);
    await expect(remote2.actions.noop()).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
    expect(service.unsubscribe).toHaveBeenCalledWith("sub-2");
  });

  it("tracks lifecycle and supports idempotent unsubscribe/destroy with listener throw isolation", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-life",
          subscriptionId: "sub-life",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:lifecycle"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(remote.getStatus().type).toBe("ready");
    const throwing = vi.fn(() => {
      throw new Error("listener boom");
    });
    const stable = vi.fn();
    const unsubscribeThrowing = remote.subscribe(throwing);
    const unsubscribeStable = remote.subscribe(stable);

    onSync({
      type: "snapshot",
      storeInstanceId: "store-life",
      version: 1,
      state: { count: 1 },
    });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(stable).toHaveBeenCalledTimes(1);

    unsubscribeThrowing();
    unsubscribeThrowing();
    unsubscribeStable();
    unsubscribeStable();

    remote.destroy();
    remote.destroy();
    expect(remote.getStatus().type).toBe("destroyed");
  });

  it("await remote actions resolves only after mirror observes committed version", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;
    let version = 0;
    const callOrder: string[] = [];

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-action-order",
          subscriptionId: "sub-action-order",
          version,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        version += 1;
        setTimeout(() => {
          onSync({
            type: "snapshot",
            storeInstanceId: "store-action-order",
            version,
            state: { count: version },
          });
        }, 0);
        return {
          type: "dispatch-result",
          committedVersion: version,
          result: version,
        };
      }),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:action-order"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    remote.subscribe(() => {
      callOrder.push("listener");
    });

    const actionPromise = remote.actions.increment().then(() => {
      callOrder.push("action-resolved");
    });
    expect(remote.getState().count).toBe(0);

    await actionPromise;
    expect(remote.getState().count).toBe(1);
    expect(callOrder).toEqual(["listener", "action-resolved"]);
  });

  it("concurrent actions resolve only after their own committed versions", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;
    let dispatchCount = 0;
    const completionOrder: string[] = [];

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-concurrent",
          subscriptionId: "sub-concurrent",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          return {
            type: "dispatch-result",
            committedVersion: 2,
            result: "first",
          };
        }

        return {
          type: "dispatch-result",
          committedVersion: 1,
          result: "second",
        };
      }),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { first(): string; second(): string }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:concurrent-actions"),
        state: () => ({ count: 0 }),
        actions: () => ({
          first: () => "first",
          second: () => "second",
        }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    const first = remote.actions
      .first()
      .then(() => completionOrder.push("first"));
    const second = remote.actions
      .second()
      .then(() => completionOrder.push("second"));

    onSync({
      type: "snapshot",
      storeInstanceId: "store-concurrent",
      version: 1,
      state: { count: 1 },
    });

    await vi.waitFor(() => {
      expect(completionOrder).toEqual(["second"]);
    });

    onSync({
      type: "snapshot",
      storeInstanceId: "store-concurrent",
      version: 2,
      state: { count: 2 },
    });

    await vi.waitFor(() => {
      expect(completionOrder).toEqual(["second", "first"]);
    });

    await Promise.all([first, second]);
  });

  it("in-flight disconnect returns explicit unknown-commit disconnect error", async () => {
    const gate = deferred<void>();
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-disconnect-race",
          subscriptionId: "sub-disconnect-race",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        await gate.promise;
        throw new NexusStoreDisconnectedError("transport disconnected");
      }),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:disconnect-race"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    const pending = remote.actions.increment();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({
      name: "NexusStoreDisconnectedError",
      message: expect.stringMatching(/unknown commit/i),
    });
    expect(remote.getStatus().type).toBe("disconnected");
    await expect(remote.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });

  it("safeInvokeStoreAction preserves typed args/result and safe error union", async () => {
    type CounterState = { count: number };
    type CounterActions = {
      increment(by: number): Promise<{ count: number }>;
    };

    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: CounterState;
    }) => void;
    let version = 0;
    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-safe-action",
          subscriptionId: "sub-safe-action",
          version,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        version += 1;
        onSync({
          type: "snapshot",
          storeInstanceId: "store-safe-action",
          version,
          state: { count: version },
        });
        return {
          type: "dispatch-result",
          committedVersion: version,
          result: { count: version },
        };
      }),
    } satisfies NexusStoreServiceContract<CounterState, CounterActions>;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore<CounterState, CounterActions>({
        token: new Token("state:counter:safe-action"),
        state: () => ({ count: 0 }),
        actions: () => ({
          increment: async () => ({ count: 0 }),
        }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    const result = await safeInvokeStoreAction(remote, "increment", [1]);
    expect(result.isOk()).toBe(true);

    expectTypeOf(safeInvokeStoreAction(remote, "increment", [1])).toMatchTypeOf<
      PromiseLike<
        import("neverthrow").Result<
          { count: number },
          | NexusStoreActionError
          | NexusStoreDisconnectedError
          | NexusStoreProtocolError
        >
      >
    >();
  });

  it("safeConnectNexusStore preserves handshake failure classification and cause", async () => {
    const disconnectedCause = new NexusStoreDisconnectedError(
      "socket dropped during subscribe",
    );

    const brokenService = {
      subscribe: vi.fn(async () => {
        throw disconnectedCause;
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const disconnectedResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof brokenService) => any) =>
                next(brokenService),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:handshake-disconnected"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(disconnectedResult.isErr()).toBe(true);
    if (disconnectedResult.isErr()) {
      expect(disconnectedResult.error).toBeInstanceOf(
        NexusStoreDisconnectedError,
      );
      expect(disconnectedResult.error).toBe(disconnectedCause);
    }

    const malformedService = {
      subscribe: vi.fn(async () => ({
        storeInstanceId: "store-bad-baseline",
        subscriptionId: "sub-bad-baseline",
        version: "nope",
        state: { count: 0 },
      })),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const malformedResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof malformedService) => any) =>
                next(malformedService),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:handshake-malformed"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(malformedResult.isErr()).toBe(true);
    if (malformedResult.isErr()) {
      expect(malformedResult.error).toBeInstanceOf(NexusStoreProtocolError);
      expect(malformedResult.error.cause).toBeDefined();
    }
  });

  it("safeConnectNexusStore enforces handshake timeout", async () => {
    const neverService = {
      subscribe: vi.fn(async () => {
        await new Promise<never>(() => undefined);
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const timedOut = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof neverService) => any) =>
                next(neverService),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:handshake-timeout"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any }, timeout: 10 },
    );

    expect(timedOut.isErr()).toBe(true);
    if (timedOut.isErr()) {
      expect(timedOut.error).toBeInstanceOf(NexusStoreConnectError);
      expect(timedOut.error.message).toMatch(/timed out/i);
    }
  });

  it("disconnect behavior composes with host cleanup capability", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        services: {
          [definition.token.id]: registration.implementation,
        },
      },
      {
        meta: { id: "client" },
      },
    );

    const fakeNexus = {
      create: async () =>
        (setup.clientEngine as any).proxyFactory.createServiceProxy(
          definition.token.id,
          {
            target: {
              connectionId: (setup.clientConnection as { connectionId: string })
                .connectionId,
            },
          },
        ),
    };

    const remote = await connectNexusStore(fakeNexus as any, definition, {
      target: { descriptor: { id: "host" } as any },
    });
    await remote.actions.increment(1);
    expect(remote.getState().count).toBe(1);

    (setup.clientConnection as { close(): void }).close();
    await vi.waitFor(() => {
      expect(
        Array.from((setup.hostCm as any).connections.values()),
      ).toHaveLength(0);
    });

    await expect(remote.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );

    await expect(
      registration.implementation.dispatch("increment", [1]),
    ).resolves.toMatchObject({ result: 2, committedVersion: 2 });
  });

  it("marks remote store disconnected on idle connection-close notification", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;
    let emitDisconnect!: () => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-idle-disconnect",
          subscriptionId: "sub-idle-disconnect",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 1,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => {
        emitDisconnect = callback;
        return () => undefined;
      },
    } satisfies NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    > & {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => () => void;
    };

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:idle-disconnect-notification"),
        state: () => ({ count: 0 }),
        actions: () => ({
          increment: (by: number) => by,
        }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(remote.getStatus().type).toBe("ready");
    emitDisconnect();

    expect(remote.getStatus().type).toBe("disconnected");
    await expect(remote.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });
});
