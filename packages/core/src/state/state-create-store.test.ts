/**
 * These tests cover the bridge from a store definition to the ordinary Nexus
 * service layer via `createNexusStore`.
 * They stay under `src/state` because they validate the internal layer-3 bridge
 * contract and ownership hooks, not the higher-level product scenarios in
 * `packages/core/integration`.
 */
import { describe, expect, it, vi } from "vitest";
import { Token } from "../api/token";
import { createL3Endpoints, createStarNetwork } from "../utils/test-utils";
import { defineNexusStore } from "./define-store";
import {
  NexusStoreDisconnectedError,
  normalizeNexusStoreError,
} from "./errors";
import { createNexusStore } from "./create-store";
import type { NexusStoreServiceContract } from "./types";
import { connectNexusStore } from "./connect-store";
import {
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
} from "../service/service-invocation-hooks";

const createCounterDefinition = () =>
  defineNexusStore({
    token: new Token("state:counter:host-runtime"),
    state: () => ({ count: 0 }),
    actions: ({ getState, setState }) => ({
      increment(by: number) {
        setState({ count: getState().count + by });
        return getState().count;
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

describe("createNexusStore", () => {
  it("translates store definition to ordinary ServiceProvider", async () => {
    const definition = createCounterDefinition();
    const { provider, store } = createNexusStore(definition);

    expect(provider.token).toBe(definition.token);
    expect(typeof provider.service.subscribe).toBe("function");
    expect(typeof provider.service.unsubscribe).toBe("function");
    expect(typeof provider.service.dispatch).toBe("function");
    expect(store.getState()).toEqual({ count: 0 });
    expect(store.getStatus()).toMatchObject({ type: "ready", version: 0 });

    const baseline = await provider.service.subscribe(() => {});
    expect(baseline.version).toBe(0);

    await expect(store.actions.increment(3)).resolves.toBe(3);
    const after = await provider.service.subscribe(() => {});
    expect(after.version).toBe(1);
    expect(after.state.count).toBe(3);
    expect(store.getState()).toEqual({ count: 3 });
  });

  it("keeps getState mutations from changing authoritative state or version", async () => {
    const definition = createCounterDefinition();
    const { store } = createNexusStore(definition);

    const state = store.getState();
    state.count = 99;

    expect(store.getState()).toEqual({ count: 0 });
    expect(store.getStatus()).toMatchObject({ type: "ready", version: 0 });
  });

  it("keeps service subscribe baseline mutations from changing authoritative state", async () => {
    const definition = createCounterDefinition();
    const { provider, store } = createNexusStore(definition);

    const baseline = await provider.service.subscribe(() => {});
    baseline.state.count = 99;

    expect(store.getState()).toEqual({ count: 0 });
    expect(store.getStatus()).toMatchObject({ type: "ready", version: 0 });
  });

  it("sends future plain state to local subscribers without leaking listener mutations", async () => {
    const definition = createCounterDefinition();
    const { store } = createNexusStore(definition);
    const seen: Array<{ count: number }> = [];

    store.subscribe((state) => {
      seen.push(state);
      state.count = 99;
    });
    await store.actions.increment(2);

    expect(seen).toEqual([{ count: 99 }]);
    expect(store.getState()).toEqual({ count: 2 });
  });

  it("stops local subscriber updates after unsubscribe", async () => {
    const definition = createCounterDefinition();
    const { store } = createNexusStore(definition);
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);
    await store.actions.increment(1);
    unsubscribe();
    await store.actions.increment(1);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps local subscribers active when one listener throws", async () => {
    const definition = createCounterDefinition();
    const { store } = createNexusStore(definition);
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    const stableListener = vi.fn();

    store.subscribe(throwingListener);
    store.subscribe(stableListener);

    await store.actions.increment(1);
    await store.actions.increment(1);

    expect(throwingListener).toHaveBeenCalledTimes(2);
    expect(stableListener).toHaveBeenCalledTimes(2);
  });

  it("destroys the local authoritative store idempotently and rejects later actions", async () => {
    const definition = createCounterDefinition();
    const { store } = createNexusStore(definition);

    store.destroy();
    store.destroy();

    expect(store.getStatus()).toEqual({ type: "destroyed" });
    expect(() => store.subscribe(() => {})).toThrow(
      "Nexus State host is destroyed",
    );
    await expect(store.actions.increment(1)).rejects.toThrow(
      "Nexus State host is destroyed",
    );
  });

  it("rejects an async local action that resolves after destroy without committing", async () => {
    const started = deferred<void>();
    const gate = deferred<void>();
    const definition = defineNexusStore({
      token: new Token("state:counter:destroy-during-action"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        async incrementAfterGate(by: number) {
          started.resolve();
          await gate.promise;
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
    });
    const { store } = createNexusStore(definition);

    const actionPromise = store.actions.incrementAfterGate(5);
    await started.promise;
    store.destroy();
    gate.resolve();

    await expect(actionPromise).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
    expect(store.getStatus()).toEqual({ type: "destroyed" });
    expect(store.getState()).toEqual({ count: 0 });
  });

  it("does not dispatch local action proxy meta keys", () => {
    const definition = createCounterDefinition();
    const { store } = createNexusStore(definition);

    expect((store.actions as any).then).toBeUndefined();
    expect((store.actions as any).catch).toBeUndefined();
    expect((store.actions as any).finally).toBeUndefined();
    expect((store.actions as any).toJSON).toBeUndefined();
    expect((store.actions as any).inspect).toBeUndefined();
    expect((store.actions as any).valueOf).toBeUndefined();
    expect((store.actions as any).toString).toBeUndefined();
  });

  it("cleans orphan subscriptions on disconnect through layer3 runtime", async () => {
    const definition = createCounterDefinition();
    const { provider: registration } = createNexusStore(definition);

    expect(
      (registration.service as { [SERVICE_ON_DISCONNECT]?: unknown })[
        SERVICE_ON_DISCONNECT
      ],
    ).toBeTypeOf("function");

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        providers: {
          [definition.token.id]:
            registration.service as NexusStoreServiceContract<object, any>,
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

    await registration.service.subscribe(localListener);
    await storeProxy.subscribe(disconnectedListener);

    await registration.service.dispatch("increment", [1]);
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
      registration.service.dispatch("increment", [1]),
    ).resolves.toMatchObject({ result: 2, committedVersion: 2 });

    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(2);
      expect(disconnectedListener).toHaveBeenCalledTimes(1);
    });
  });

  it("exposes explicit invocation context shape for subscribe binding", () => {
    const definition = createCounterDefinition();
    const { provider: registration } = createNexusStore(definition);

    const hooks = registration.service as {
      [SERVICE_INVOKE_START]?: (invocationContext: {
        sourceConnectionId: string;
        sourceIdentity?: unknown;
        localIdentity?: unknown;
        platform?: unknown;
      }) => unknown;
    };

    const context = hooks[SERVICE_INVOKE_START]?.({
      sourceConnectionId: "conn-ctx-shape",
      sourceIdentity: { id: "client" },
      localIdentity: { id: "host" },
      platform: { from: "popup" },
    });
    expect(context).toEqual({
      sourceConnectionId: "conn-ctx-shape",
      sourceIdentity: { id: "client" },
      localIdentity: { id: "host" },
      platform: { from: "popup" },
    });
  });

  it("forwards invocation context into wrapped dispatch path", async () => {
    const definition = createCounterDefinition();
    const { provider: registration } = createNexusStore(definition);
    const service = registration.service as NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    >;

    const invocation = (
      service as {
        [SERVICE_INVOKE_START]?: (invocationContext: {
          sourceConnectionId: string;
          sourceIdentity?: unknown;
          localIdentity?: unknown;
          platform?: unknown;
        }) => unknown;
      }
    )[SERVICE_INVOKE_START]?.({
      sourceConnectionId: "conn-dispatch-forward",
      sourceIdentity: { id: "client-forward" },
      localIdentity: { id: "host-forward" },
      platform: { from: "popup-forward" },
    });

    await service.dispatch("increment", [2], invocation as any);

    const baseline = await service.subscribe(() => {});
    expect(baseline.state.count).toBe(2);
  });

  it("passes full trusted invocation identity context through remote dispatch", async () => {
    const definition = createCounterDefinition();
    const { provider: registration } = createNexusStore(definition);
    const observedDispatchInvocations: unknown[] = [];
    const service = registration.service;
    const originalDispatch = service.dispatch.bind(service);
    const wrappedImplementation = Object.create(
      Object.getPrototypeOf(service),
    ) as NexusStoreServiceContract<{ count: number }, any> & typeof service;
    Object.defineProperties(
      wrappedImplementation,
      Object.getOwnPropertyDescriptors(service),
    );

    wrappedImplementation.dispatch = (
      action: any,
      args: any,
      invocation: any,
    ) => {
      observedDispatchInvocations.push(invocation);
      return originalDispatch(action, args, invocation);
    };

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        providers: {
          [definition.token.id]: wrappedImplementation,
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

    await storeProxy.dispatch("increment", [1]);

    expect(observedDispatchInvocations).toEqual([
      {
        sourceConnectionId: clientConnectionId,
        sourceIdentity: { id: "client" },
        localIdentity: { id: "host" },
        platform: { from: "client" },
      },
    ]);
  });

  it("binds async subscribe ownership through hook path and cleans via disconnect hook", async () => {
    const definition = createCounterDefinition();
    const { provider: registration } = createNexusStore(definition);

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        providers: {
          [definition.token.id]:
            registration.service as NexusStoreServiceContract<object, any>,
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

    await registration.service.subscribe(localListener);
    await storeProxy.subscribe(remoteListener);

    await registration.service.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(1);
      expect(remoteListener).toHaveBeenCalledTimes(1);
    });

    (
      registration.service as {
        [SERVICE_ON_DISCONNECT](connectionId: string): void;
      }
    )[SERVICE_ON_DISCONNECT](clientConnectionId);

    await registration.service.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(2);
      expect(remoteListener).toHaveBeenCalledTimes(1);
    });
  });

  it("passes invocation context through wrapped store service methods", async () => {
    const definition = createCounterDefinition();
    const { provider: registration } = createNexusStore(definition);
    const service = registration.service;
    const originalSubscribe = service.subscribe.bind(service);
    const wrappedImplementation = Object.create(
      Object.getPrototypeOf(service),
    ) as NexusStoreServiceContract<{ count: number }, any> & typeof service;
    Object.defineProperties(
      wrappedImplementation,
      Object.getOwnPropertyDescriptors(service),
    );
    const observedInvocations: unknown[] = [];

    wrappedImplementation.subscribe = (onSync: any, invocation: unknown) => {
      observedInvocations.push(invocation);
      return originalSubscribe(onSync, invocation as any);
    };

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        providers: {
          [definition.token.id]: wrappedImplementation,
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

    await storeProxy.subscribe(vi.fn());

    expect(observedInvocations).toEqual([
      {
        sourceConnectionId: clientConnectionId,
        sourceIdentity: { id: "client" },
        localIdentity: { id: "host" },
        platform: { from: "client" },
      },
    ]);

    (
      wrappedImplementation as {
        [SERVICE_ON_DISCONNECT](connectionId: string): void;
      }
    )[SERVICE_ON_DISCONNECT](clientConnectionId);

    await service.dispatch("increment", [1]);
  });

  it("binds ownership correctly for overlapping async subscribes from different connections", async () => {
    const definition = createCounterDefinition();
    const { provider: registration } = createNexusStore(definition);
    const subscribeBarrier = deferred<void>();
    const localListener = vi.fn();

    await registration.service.subscribe(localListener);

    const originalSubscribe = registration.service.subscribe.bind(
      registration.service,
    );
    registration.service.subscribe = async (onSync: any) => {
      await subscribeBarrier.promise;
      return originalSubscribe(onSync);
    };

    const network = await createStarNetwork<
      { context: string },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        providers: {
          [definition.token.id]: registration.service,
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

    await registration.service.dispatch("increment", [1]);
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

    await registration.service.dispatch("increment", [1]);
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

    await registration.service.dispatch("increment", [1]);
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
    const { provider: registration } = createNexusStore(definition);
    const subscribeGate = deferred<void>();
    const localListener = vi.fn();

    await registration.service.subscribe(localListener);

    const originalSubscribe = registration.service.subscribe.bind(
      registration.service,
    );
    registration.service.subscribe = async (onSync: any) => {
      await subscribeGate.promise;
      return originalSubscribe(onSync);
    };

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        providers: {
          [definition.token.id]:
            registration.service as NexusStoreServiceContract<object, any>,
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

    await registration.service.dispatch("increment", [1]);
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

    await registration.service.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(2);
      expect(remoteListener).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects late subscribe completion when connection already disconnected", async () => {
    const definition = createCounterDefinition();
    const { provider: registration } = createNexusStore(definition);
    const subscribeGate = deferred<void>();
    const localListener = vi.fn();

    await registration.service.subscribe(localListener);

    const originalSubscribe = registration.service.subscribe.bind(
      registration.service,
    );
    registration.service.subscribe = async (onSync: any, invocation: any) => {
      await subscribeGate.promise;
      return originalSubscribe(onSync, invocation);
    };

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        providers: {
          [definition.token.id]:
            registration.service as NexusStoreServiceContract<object, any>,
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
    const pendingSubscribe = storeProxy.subscribe(remoteListener);

    (setup.clientConnection as { close(): void }).close();
    await vi.waitFor(() => {
      expect(
        Array.from((setup.hostCm as any).connections.values()),
      ).toHaveLength(0);
    });

    subscribeGate.resolve();
    await expect(
      pendingSubscribe.catch((error) => {
        throw normalizeNexusStoreError(error);
      }),
    ).rejects.toBeInstanceOf(NexusStoreDisconnectedError);

    await registration.service.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(1);
      expect(remoteListener).toHaveBeenCalledTimes(0);
    });
  });
});
