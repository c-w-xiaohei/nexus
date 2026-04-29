/**
 * Simulates remote-store runtime lifecycle under normal operation and transport
 * churn, ensuring disconnect semantics propagate to clients and that host-side
 * subscriber resources are cleaned when one participant drops.
 */
import { describe, expect, it, vi } from "vitest";

import { Token } from "../../src/api/token";
import { createStarNetwork } from "../../src/utils/test-utils";
import {
  connectNexusStore,
  defineNexusStore,
  provideNexusStore,
  type NexusStoreServiceContract,
} from "../../src/state";

describe("Nexus State Integration: Lifecycle and Cleanup", () => {
  it("connects remote store over ordinary service path and handles disconnect", async () => {
    const counterStore = defineNexusStore({
      token: new Token<
        NexusStoreServiceContract<
          { count: number },
          { increment(by: number): number }
        >
      >("state:counter:integration"),
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

    expect(remote.getState().count).toBe(0);
    await remote.actions.increment(1);
    expect(remote.getState().count).toBe(1);

    const popupCm = (popup as any).connectionManager;
    const connection = Array.from((popupCm as any).connections.values())[0] as {
      close(): void;
    };
    connection.close();

    await vi.waitFor(() => {
      expect((popupCm as any).connections.size).toBe(0);
    });

    await expect(remote.actions.increment(1)).rejects.toMatchObject({
      name: "NexusStoreDisconnectedError",
    });
  });

  it("synchronizes state across isolated contexts, fans out updates, and cleans disconnected subscribers", async () => {
    const counterStore = defineNexusStore({
      token: new Token<
        NexusStoreServiceContract<
          { count: number },
          { increment(by: number): number }
        >
      >("state:counter:multi-context"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
    });

    const network = await createStarNetwork<
      { context: "background" | "popup-a" | "popup-b" | "popup-c" },
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
          meta: { context: "popup-a" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: { context: "popup-b" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: { context: "popup-c" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const background = network.get("background")!.nexus;
    const popupA = network.get("popup-a")!.nexus;
    const popupB = network.get("popup-b")!.nexus;
    const popupC = network.get("popup-c")!.nexus;
    const hostResourceManager = (background as any).engine.resourceManager;
    const backgroundCm = (background as any).connectionManager;

    const remoteA = await connectNexusStore(popupA, counterStore, {
      target: { descriptor: { context: "background" } },
    });
    const remoteB = await connectNexusStore(popupB, counterStore, {
      target: { descriptor: { context: "background" } },
    });
    const remoteC = await connectNexusStore(popupC, counterStore, {
      target: { descriptor: { context: "background" } },
    });

    const updatesA: number[] = [];
    const updatesB: number[] = [];
    const updatesC: number[] = [];

    const stopA = remoteA.subscribe((snapshot) =>
      updatesA.push(snapshot.count),
    );
    const stopB = remoteB.subscribe((snapshot) =>
      updatesB.push(snapshot.count),
    );
    const stopC = remoteC.subscribe((snapshot) =>
      updatesC.push(snapshot.count),
    );

    await remoteA.actions.increment(1);

    await vi.waitFor(() => {
      expect(remoteA.getState().count).toBe(1);
      expect(remoteB.getState().count).toBe(1);
      expect(remoteC.getState().count).toBe(1);
      expect(updatesA).toEqual([1]);
      expect(updatesB).toEqual([1]);
      expect(updatesC).toEqual([1]);
    });

    const hostConnections = Array.from(
      (backgroundCm as any).connections.values(),
    ) as Array<{
      connectionId: string;
      remoteIdentity?: { context?: string };
    }>;
    const hostConnectionByContext = new Map<string, string>();
    for (const connection of hostConnections) {
      const context = connection.remoteIdentity?.context;
      if (typeof context === "string") {
        hostConnectionByContext.set(context, connection.connectionId);
      }
    }

    const contexts = ["popup-a", "popup-b", "popup-c"] as const;
    let disconnectedContext: (typeof contexts)[number] = "popup-b";
    const preferredConnectionId =
      hostConnectionByContext.get(disconnectedContext);
    const preferredProxyIds = preferredConnectionId
      ? hostResourceManager.listRemoteProxyIdsBySource(preferredConnectionId)
      : [];

    if (preferredProxyIds.length === 0) {
      const fallback = contexts.find((context) => {
        const connectionId = hostConnectionByContext.get(context);
        if (!connectionId) {
          return false;
        }
        return (
          hostResourceManager.listRemoteProxyIdsBySource(connectionId).length >
          0
        );
      });

      if (fallback) {
        disconnectedContext = fallback;
      }
    }

    const disconnectedConnectionId =
      hostConnectionByContext.get(disconnectedContext);
    expect(disconnectedConnectionId).toBeDefined();
    if (!disconnectedConnectionId) {
      throw new Error("Expected host connection id for disconnected context");
    }

    const disconnectedProxyIdsBefore =
      hostResourceManager.listRemoteProxyIdsBySource(disconnectedConnectionId);
    expect(disconnectedProxyIdsBefore.length).toBeGreaterThan(0);

    const disconnectedNexusByContext = {
      "popup-a": popupA,
      "popup-b": popupB,
      "popup-c": popupC,
    } as const;
    const disconnectedRemoteByContext = {
      "popup-a": remoteA,
      "popup-b": remoteB,
      "popup-c": remoteC,
    } as const;
    const disconnectedUpdatesByContext = {
      "popup-a": updatesA,
      "popup-b": updatesB,
      "popup-c": updatesC,
    } as const;

    const disconnectedNexus = disconnectedNexusByContext[disconnectedContext];
    const disconnectedRemote = disconnectedRemoteByContext[disconnectedContext];
    const disconnectedUpdates =
      disconnectedUpdatesByContext[disconnectedContext];

    const disconnectedCm = (disconnectedNexus as any).connectionManager;
    const disconnectedConnection = Array.from(
      (disconnectedCm as any).connections.values(),
    )[0] as {
      close(): void;
    };
    disconnectedConnection.close();

    await vi.waitFor(() => {
      expect((disconnectedCm as any).connections.size).toBe(0);
      expect(disconnectedRemote.getStatus().type).toBe("disconnected");
    });

    await vi.waitFor(() => {
      expect(
        hostResourceManager.listRemoteProxyIdsBySource(
          disconnectedConnectionId,
        ),
      ).toEqual([]);
    });

    const activeRemotes = [remoteA, remoteB, remoteC].filter(
      (remote) => remote !== disconnectedRemote,
    );
    await activeRemotes[0].actions.increment(2);

    await vi.waitFor(() => {
      expect(remoteA.getState().count).toBe(3);
      expect(remoteB.getState().count).toBe(
        disconnectedContext === "popup-b" ? 1 : 3,
      );
      expect(remoteC.getState().count).toBe(
        disconnectedContext === "popup-c" ? 1 : 3,
      );
      expect(updatesA).toEqual(
        disconnectedContext === "popup-a" ? [1] : [1, 3],
      );
      expect(updatesB).toEqual(
        disconnectedContext === "popup-b" ? [1] : [1, 3],
      );
      expect(updatesC).toEqual(
        disconnectedContext === "popup-c" ? [1] : [1, 3],
      );
      expect(disconnectedUpdates).toEqual([1]);
    });

    await expect(disconnectedRemote.actions.increment(1)).rejects.toMatchObject(
      {
        name: "NexusStoreDisconnectedError",
      },
    );

    stopA();
    stopB();
    stopC();
    remoteA.destroy();
    remoteB.destroy();
    remoteC.destroy();
  });

  it("marks an existing remote store stale when host snapshots switch store instance identity", async () => {
    type CounterState = { count: number };
    type CounterActions = { increment(by: number): number };

    const definition = defineNexusStore<CounterState, CounterActions>({
      token: new Token("state:counter:stale-instance:integration"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
    });

    const createHostService = () =>
      provideNexusStore(definition)
        .implementation as CounterActions extends Record<
        string,
        (...args: any[]) => any
      >
        ? {
            subscribe(
              onSync: (event: {
                type: "snapshot";
                storeInstanceId: string;
                version: number;
                state: CounterState;
              }) => void,
              invocation?: unknown,
            ): Promise<{
              storeInstanceId: string;
              subscriptionId: string;
              version: number;
              state: CounterState;
            }>;
            unsubscribe(subscriptionId: string): Promise<void>;
            dispatch(
              action: "increment",
              args: [number],
            ): Promise<{
              type: "dispatch-result";
              committedVersion: number;
              result: number;
            }>;
          }
        : never;

    let activeHost = createHostService();
    const callbacksByClientSubscription = new Map<
      string,
      (event: {
        type: "snapshot";
        storeInstanceId: string;
        version: number;
        state: CounterState;
      }) => void
    >();
    const hostSubscriptionByClientSubscription = new Map<string, string>();
    let clientSubscriptionSeq = 0;

    const staleService = {
      async subscribe(
        onSync: (event: {
          type: "snapshot";
          storeInstanceId: string;
          version: number;
          state: CounterState;
        }) => void,
        invocation?: unknown,
      ) {
        const baseline = await activeHost.subscribe(onSync, invocation);
        const clientSubscriptionId = `client-sub:${++clientSubscriptionSeq}`;
        callbacksByClientSubscription.set(clientSubscriptionId, onSync);
        hostSubscriptionByClientSubscription.set(
          clientSubscriptionId,
          baseline.subscriptionId,
        );
        return {
          ...baseline,
          subscriptionId: clientSubscriptionId,
        };
      },
      async unsubscribe(subscriptionId: string) {
        const hostSubscriptionId =
          hostSubscriptionByClientSubscription.get(subscriptionId);
        callbacksByClientSubscription.delete(subscriptionId);
        hostSubscriptionByClientSubscription.delete(subscriptionId);
        if (hostSubscriptionId) {
          await activeHost.unsubscribe(hostSubscriptionId);
        }
      },
      async dispatch(action: "increment", args: [number]) {
        return activeHost.dispatch(action, args);
      },
      async replaceHostInstance() {
        const nextHost = createHostService();
        for (const [
          clientSubscriptionId,
          callback,
        ] of callbacksByClientSubscription) {
          const baseline = await nextHost.subscribe(callback);
          hostSubscriptionByClientSubscription.set(
            clientSubscriptionId,
            baseline.subscriptionId,
          );
        }
        activeHost = nextHost;
      },
    };

    const network = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [definition.token.id]: staleService,
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
    const remote = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });

    const seenCounts: number[] = [];
    const stop = remote.subscribe((snapshot) => {
      seenCounts.push(snapshot.count);
    });

    await remote.actions.increment(1);
    await vi.waitFor(() => {
      expect(seenCounts).toEqual([1]);
    });

    expect(remote.getStatus().type).toBe("ready");
    await staleService.replaceHostInstance();
    await staleService.dispatch("increment", [5]);

    await vi.waitFor(() => {
      expect(remote.getStatus().type).toBe("stale");
    });

    await staleService.dispatch("increment", [5]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(remote.getState().count).toBe(1);
    expect(seenCounts).toEqual([1]);

    await expect(remote.actions.increment(1)).rejects.toMatchObject({
      name: "NexusStoreDisconnectedError",
    });

    stop();
  });

  it("keeps one remote usable while sibling remote is stale after host replacement", async () => {
    type CounterState = { count: number };
    type CounterActions = { increment(by: number): number };

    const definition = defineNexusStore<CounterState, CounterActions>({
      token: new Token("state:counter:sibling-stale-isolation:integration"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
    });

    const createHostService = () =>
      provideNexusStore(definition)
        .implementation as CounterActions extends Record<
        string,
        (...args: any[]) => any
      >
        ? {
            subscribe(
              onSync: (event: {
                type: "snapshot";
                storeInstanceId: string;
                version: number;
                state: CounterState;
              }) => void,
              invocation?: unknown,
            ): Promise<{
              storeInstanceId: string;
              subscriptionId: string;
              version: number;
              state: CounterState;
            }>;
            unsubscribe(subscriptionId: string): Promise<void>;
            dispatch(
              action: "increment",
              args: [number],
            ): Promise<{
              type: "dispatch-result";
              committedVersion: number;
              result: number;
            }>;
          }
        : never;

    let activeHost = createHostService();
    const callbacksByClientSubscription = new Map<
      string,
      (event: {
        type: "snapshot";
        storeInstanceId: string;
        version: number;
        state: CounterState;
      }) => void
    >();
    const hostSubscriptionByClientSubscription = new Map<string, string>();
    let clientSubscriptionSeq = 0;

    const staleService = {
      async subscribe(
        onSync: (event: {
          type: "snapshot";
          storeInstanceId: string;
          version: number;
          state: CounterState;
        }) => void,
        invocation?: unknown,
      ) {
        const baseline = await activeHost.subscribe(onSync, invocation);
        const clientSubscriptionId = `client-sub:${++clientSubscriptionSeq}`;
        callbacksByClientSubscription.set(clientSubscriptionId, onSync);
        hostSubscriptionByClientSubscription.set(
          clientSubscriptionId,
          baseline.subscriptionId,
        );
        return {
          ...baseline,
          subscriptionId: clientSubscriptionId,
        };
      },
      async unsubscribe(subscriptionId: string) {
        const hostSubscriptionId =
          hostSubscriptionByClientSubscription.get(subscriptionId);
        callbacksByClientSubscription.delete(subscriptionId);
        hostSubscriptionByClientSubscription.delete(subscriptionId);
        if (hostSubscriptionId) {
          await activeHost.unsubscribe(hostSubscriptionId);
        }
      },
      async dispatch(action: "increment", args: [number]) {
        return activeHost.dispatch(action, args);
      },
      async replaceHostInstance() {
        const nextHost = createHostService();
        for (const [
          clientSubscriptionId,
          callback,
        ] of callbacksByClientSubscription) {
          const baseline = await nextHost.subscribe(callback);
          hostSubscriptionByClientSubscription.set(
            clientSubscriptionId,
            baseline.subscriptionId,
          );
        }
        activeHost = nextHost;
      },
    };

    const network = await createStarNetwork<
      { context: "background" | "popup-a" | "popup-b" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [definition.token.id]: staleService,
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

    const staleRemote = await connectNexusStore(popupA, definition, {
      target: { descriptor: { context: "background" } },
    });
    const freshRemote = await connectNexusStore(popupB, definition, {
      target: { descriptor: { context: "background" } },
    });

    await staleRemote.actions.increment(1);
    await vi.waitFor(() => {
      expect(staleRemote.getState().count).toBe(1);
      expect(freshRemote.getState().count).toBe(1);
    });

    await staleService.replaceHostInstance();
    await staleService.dispatch("increment", [5]);

    await vi.waitFor(() => {
      expect(staleRemote.getStatus().type).toBe("stale");
    });
    await vi.waitFor(() => {
      expect(freshRemote.getStatus().type).toBe("stale");
    });

    const replacementRemote = await connectNexusStore(popupB, definition, {
      target: { descriptor: { context: "background" } },
    });

    await expect(replacementRemote.actions.increment(2)).resolves.toBe(7);
    expect(replacementRemote.getState().count).toBe(7);

    await expect(staleRemote.actions.increment(1)).rejects.toMatchObject({
      name: "NexusStoreDisconnectedError",
    });

    await expect(freshRemote.actions.increment(1)).rejects.toMatchObject({
      name: "NexusStoreDisconnectedError",
    });
  });
});
