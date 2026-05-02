/**
 * These tests cover the bridge from a store definition to the ordinary Nexus
 * service layer via `provideNexusStore`.
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
import { provideNexusStore } from "./provide-store";
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

  it("passes invocation context through wrapped store service methods", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);
    const implementation = registration.implementation;
    const originalSubscribe = implementation.subscribe.bind(implementation);
    const wrappedImplementation = Object.create(
      Object.getPrototypeOf(implementation),
    ) as NexusStoreServiceContract<{ count: number }, any> &
      typeof implementation;
    Object.defineProperties(
      wrappedImplementation,
      Object.getOwnPropertyDescriptors(implementation),
    );
    const observedInvocations: unknown[] = [];

    wrappedImplementation.subscribe = (onSync: any, invocation: unknown) => {
      observedInvocations.push(invocation);
      return originalSubscribe(onSync, invocation as any);
    };

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        services: {
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
      { sourceConnectionId: clientConnectionId },
    ]);

    (
      wrappedImplementation as {
        [SERVICE_ON_DISCONNECT](connectionId: string): void;
      }
    )[SERVICE_ON_DISCONNECT](clientConnectionId);

    await implementation.dispatch("increment", [1]);
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
    registration.implementation.subscribe = async (onSync: any) => {
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
    registration.implementation.subscribe = async (onSync: any) => {
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

  it("rejects late subscribe completion when connection already disconnected", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);
    const subscribeGate = deferred<void>();
    const localListener = vi.fn();

    await registration.implementation.subscribe(localListener);

    const originalSubscribe = registration.implementation.subscribe.bind(
      registration.implementation,
    );
    registration.implementation.subscribe = async (
      onSync: any,
      invocation: any,
    ) => {
      await subscribeGate.promise;
      return originalSubscribe(onSync, invocation);
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

    await registration.implementation.dispatch("increment", [1]);
    await vi.waitFor(() => {
      expect(localListener).toHaveBeenCalledTimes(1);
      expect(remoteListener).toHaveBeenCalledTimes(0);
    });
  });
});
